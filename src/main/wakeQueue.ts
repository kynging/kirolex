/**
 * **后台唤醒的投递** —— 定时任务到点、后台命令退出、监视到新输出，都要「作为一条新消息发进那条会话」。
 *
 * 规则（任务原话）：**不打断正在跑的一轮**。会话正忙就等这一轮结束再发 —— 作为新的一条，
 * 不 steer、不进用户的排队卡片、不被「合并排队消息」合并。多个同时到期按时间顺序逐条发。
 *
 * 所以这里是一条**主进程自己的**、每会话一条的 FIFO（按 `at` 排序），和渲染端的排队卡片完全分开：
 *   · 只在 `isBusy` 为假时发队头那一条，发完（这一轮结束）再看下一条；
 *   · 发的那一刻撞上「还在跑」（和用户的排队消息抢同一个空档）→ 留在队头，下次空了再发，不丢；
 *   · 会话没连着（断网 / ssh 断开 / 挂执行器失败 / 凭证拿不到，错误码 `SESSION_NOT_CONNECTED`）→ 也留在队头，
 *     等连上（`kick`，连接 / 挂上的事件）或退避到点（15s → 30s → … 最多 5 分钟一次）再发；等满 24 小时才放弃（`gaveUp`）；
 *   · 别的错误 → 报给调用方（定时任务据此记 `lastError`），不卡住后面的。
 *
 * 纯逻辑，不 import electron：忙不忙、怎么发都由 index.ts 注入。
 */

export interface WakeItem {
  id: string;
  sessionId: string;
  /** 发给模型、也显示在会话里的那段文字。 */
  text: string;
  /** 什么时候该发（到点时间 / 事件发生时间，epoch ms）—— 同一会话里按它排序。 */
  at: number;
  /** `nudge`：「把工具调用写成了文字」的那一次纠正（index.ts `handleTextToolCall`，判据见 textToolCall.ts）。
   *  `session`：会话之间互相调用（sessionCalls.ts）—— 对方的回复 / 等回复超时唤醒发起方；界面没就绪时 session_send 也走这里。
   *  `loop`：主进程里的循环 driver 发的一轮（loopDriver.ts）—— `ref` 就是这一轮确定的消息 id（幂等账本靠它在 transcript 里认这一轮）。 */
  source: 'schedule' | 'bg' | 'watch' | 'nudge' | 'session' | 'loop';
  /** 定时任务的 id（`source = 'schedule'`）—— 发送时拿它当消息 id 的一部分；`source = 'loop'` 时就是消息 id 本身。 */
  ref?: string;
  /** 定时任务这是第几次（`source = 'schedule'`，记账后的 `runs`）—— 只进消息 id，界面的「⏰ 定时」卡片据此显示「第 N 次」（scheduleWakeView.ts）。 */
  run?: number;
  /** `nudge` 才有：发之前先换新的后端会话（「写成文字」反复发作，见 index.ts `handleTextToolCall` / textToolRecovery.ts）。 */
  swap?: boolean;
  /** 第一次因为「会话没连着」没发出去的时刻 —— 等连接的上限从这里算（落盘，重启后接着算）。 */
  waitingSince?: number;
  /** 「等连上再发」的提示已经在会话里说过了（只说一次）。 */
  waitNoted?: boolean;
}

/**
 * 已经开始发了（挂执行器、等换模型 / 重建历史……），**真正提交提示之前**发现这一条不该发了（任务刚被暂停 / 删除）：
 * `deliver` 抛这个，结果记成 `skipped` 而不是失败 —— 定时任务据此把记的那一次退回去。
 */
export class WakeSkipped extends Error {
  readonly wakeSkipped = true;
}

/** 「会话还在跑一轮」这类拒绝带的错误码 —— 判忙不能靠报错文字：文字是 tr() 出来的，跟着界面语言变。 */
export const SESSION_BUSY = 'SESSION_BUSY';

/**
 * 发唤醒时撞上的错误是不是「忙」（该留在队头、空了再发）：带 `SESSION_BUSY` 码，或者此刻会话确实正忙
 * （正好有人抢先开了一轮）。都不看错误文字。
 */
export function isWakeBusyError(err: unknown, sessionBusyNow: boolean): boolean {
  return (err as any)?.code === SESSION_BUSY || sessionBusyNow;
}

/**
 * 「会话没连着」这类拒绝带的错误码：挂执行器失败（ssh 断开、DNS、AWS 凭证……都在 attach 里吞掉了，结果就是没挂上）、
 * 提交之前发现执行器不在。只用在**还没提交**的地方 —— 提交之后断的那一轮不能当成没发过（不自动再发已开始执行的消息）。
 */
export const SESSION_NOT_CONNECTED = 'SESSION_NOT_CONNECTED';

/** 发唤醒时撞上的错误是不是「会话没连着」（该留在队头、等连上再发）。只看错误码，不看 tr() 出来的文字。 */
export function isWakeConnectionError(err: unknown): boolean {
  return (err as any)?.code === SESSION_NOT_CONNECTED;
}

/** 等连接的退避和上限（缺省）：15s → 30s → … 最多 5 分钟一次，等满 24 小时放弃。 */
export const CONN_RETRY = { firstMs: 15_000, maxMs: 5 * 60_000, giveUpMs: 24 * 3600_000 };

/** 第 `attempt` 次（从 0 起）没连上之后等多久再试。 */
export function connRetryDelay(attempt: number, firstMs = CONN_RETRY.firstMs, maxMs = CONN_RETRY.maxMs): number {
  return Math.min(maxMs, firstMs * 2 ** Math.min(30, Math.max(0, attempt)));
}

/** 往前多少毫秒也算（入队时刻和落盘时刻之间的时钟差） */
const DELIVERED_SLACK_MS = 5000;

/**
 * 重启后读回来的那一条是不是**已经**发进会话了（退出时它正在发：提示交出去了，这一轮还没跑完就退了）：
 * 会话记录里在它入队之后有一条正文一样的用户消息（不是 KiroLex 提示）。是的话不再发。
 */
export function wakeAlreadyDelivered(transcript: Array<{ role: string; content?: unknown; ts?: unknown; kirolex?: boolean }>, item: WakeItem): boolean {
  return transcript.some((m) => m.role === 'user' && !m.kirolex && String(m.content ?? '') === item.text && Number(m.ts) >= item.at - DELIVERED_SLACK_MS);
}

export interface WakeResult {
  ok: boolean;
  error?: string;
  /** 没发：排着的期间它已经不该发了（任务被删 / 暂停 / 过期，见 `dropRef` / `isStale`）。 */
  skipped?: boolean;
}

export interface WakeDeps {
  /** 这条会话此刻能不能发（正在跑一轮 / 换执行器 / 重建历史 / 等待退出 …… 都算忙）。 */
  isBusy(sessionId: string): boolean;
  /** 发出去并等这一轮跑完。失败就抛。 */
  deliver(item: WakeItem): Promise<void>;
  /** 这个错误是不是「还在跑一轮」—— 是的话留在队头重试，而不是当成失败。 */
  isBusyError?(err: unknown, item: WakeItem): boolean;
  /**
   * **真正发之前**再问一次：这一条还该不该发。返回原因 = 不发（`skipped`）。
   * 会话忙的那段时间里，用户可能已经暂停 / 删除了那个定时任务（或者它过期了）—— 盘上改了，排着的这条也得跟着作废。
   */
  isStale?(item: WakeItem): string | null;
  log?(message: string): void;
  /** 忙的时候多久再看一次。默认 1 秒。 */
  pollMs?: number;
  /** 这个错误是不是「会话没连着」。缺省看 `SESSION_NOT_CONNECTED` 错误码（`isWakeConnectionError`）。 */
  isConnectionError?(err: unknown, item: WakeItem): boolean;
  /** 这一条第一次因为没连着而没发出去（每条只调一次）—— 在会话里留一行「等连上再发」。 */
  waitingForConnection?(item: WakeItem): void;
  /** 等连接等满上限，放弃了 —— 在会话里留一行写明丢了什么。 */
  gaveUp?(item: WakeItem, error: string): void;
  /** 哪些要落盘（重启后接着等）。 */
  persist?(item: WakeItem): boolean;
  /** 要落盘的那几条变了（按会话、按将要发的顺序）。 */
  changed?(items: WakeItem[]): void;
  now?(): number;
  /** 等连接的退避和上限；缺省 `CONN_RETRY`。 */
  connRetry?: { firstMs: number; maxMs: number; giveUpMs: number };
}

type Pending = WakeItem & { seq: number; resolve: (r: WakeResult) => void; connAttempts?: number };

export class WakeDispatcher {
  private readonly queues = new Map<string, Pending[]>();
  private readonly pumping = new Set<string>();
  /** 正在发的那一条（`dropRef` 不碰它 —— 已经交给执行器了）。 */
  private readonly sending = new Set<Pending>();
  private seq = 0;
  private readonly deps: WakeDeps;
  /** 正在等连接的那几条会话：叫醒它（`kick`）就立刻再试。 */
  private readonly connWaits = new Map<string, () => void>();
  private lastSaved = '';

  constructor(deps: WakeDeps) {
    this.deps = deps;
  }

  /** 排进去；返回的 Promise 在**这一条**发完（或确定发不了）时兑现。 */
  enqueue(input: Omit<WakeItem, 'id'> & { id?: string }): Promise<WakeResult> {
    return new Promise<WakeResult>((resolve) => {
      const seq = (this.seq += 1);
      const it: Pending = { ...input, id: input.id || `wake_${Date.now()}_${seq}`, seq, resolve };
      const q = this.queues.get(it.sessionId) || [];
      q.push(it);
      /* 按到点时间排；同一时刻按入队先后 —— 「多个同时到期按时间顺序逐条发」 */
      q.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
      this.queues.set(it.sessionId, q);
      /* 下一拍再开始：同一拍里一起入队的几条先排好序，再发第一条 */
      setTimeout(() => { void this.pump(it.sessionId); }, 0);
      this.save();
    });
  }

  /** 重启后接着发（盘上读回来的）；`onResult` 拿每一条的结果（原来的调用方已经不在了）。 */
  restore(items: WakeItem[], onResult?: (item: WakeItem, r: WakeResult) => void): void {
    for (const it of items) {
      if (!it || !it.id || !it.sessionId || typeof it.text !== 'string') continue;
      void this.enqueue({ ...it }).then((r) => onResult?.(it, r));
    }
  }

  /** 这条会话连上了 / 挂上了：在等连接的那一条立刻再试（不用等退避到点）。 */
  kick(sessionId: string): void {
    this.connWaits.get(sessionId)?.();
  }

  /** 这条会话还排着的（按将要发的顺序）。 */
  pending(sessionId: string): WakeItem[] {
    return (this.queues.get(sessionId) || []).map(({ resolve: _r, seq: _s, connAttempts: _c, ...rest }) => rest);
  }

  /** 会话删了 / 归档了：排着的全部作废（已经在发的那一条不受影响）。 */
  drop(sessionId: string, why = 'session gone'): void {
    const q = this.queues.get(sessionId);
    if (!q) return;
    this.queues.delete(sessionId);
    for (const it of q) it.resolve({ ok: false, error: why });
    this.save();
  }

  /** 按 `ref`（定时任务 id / 后台任务 id）撤掉还没发的那几条。返回撤掉了几条（正在发的那一条不算）。 */
  dropRef(ref: string, why = 'cancelled'): number {
    let n = 0;
    for (const [sid, q] of this.queues) {
      const keep: Pending[] = [];
      for (const it of q) {
        if (it.ref === ref && !this.sending.has(it)) { n += 1; it.resolve({ ok: false, skipped: true, error: why }); } else keep.push(it);
      }
      if (keep.length) this.queues.set(sid, keep); else this.queues.delete(sid);
    }
    if (n) this.save();
    return n;
  }

  private async pump(sessionId: string): Promise<void> {
    if (this.pumping.has(sessionId)) return;
    this.pumping.add(sessionId);
    const pollMs = this.deps.pollMs ?? 1000;
    try {
      for (;;) {
        const q = this.queues.get(sessionId);
        if (!q || !q.length) { this.queues.delete(sessionId); return; }
        if (this.deps.isBusy(sessionId)) {
          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }
        const head = q[0];
        const stale = this.deps.isStale?.(head) ?? null;
        if (stale) {
          this.take(sessionId, head);
          this.deps.log?.(`wake ${head.id} session=${sessionId} 不发了：${stale}`);
          head.resolve({ ok: false, skipped: true, error: stale });
          continue;
        }
        this.sending.add(head);
        try {
          await this.deps.deliver(head);
        } catch (err) {
          this.sending.delete(head);
          if ((err as any)?.wakeSkipped) {
            this.take(sessionId, head);
            head.resolve({ ok: false, skipped: true, error: String((err as any)?.message || 'skipped') });
            continue;
          }
          if (this.deps.isBusyError?.(err, head)) {
            this.deps.log?.(`wake ${head.id} session=${sessionId} 撞上正在跑的一轮，空了再发`);
            await new Promise((r) => setTimeout(r, pollMs));
            continue;
          }
          if (this.deps.isConnectionError ? this.deps.isConnectionError(err, head) : isWakeConnectionError(err)) {
            const retry = this.deps.connRetry ?? CONN_RETRY;
            const now = this.deps.now?.() ?? Date.now();
            if (head.waitingSince === undefined) head.waitingSince = now;
            const error = String((err as any)?.message || err);
            if (now - head.waitingSince >= retry.giveUpMs) {
              this.take(sessionId, head);
              this.deps.log?.(`wake ${head.id} session=${sessionId} 等会话连上等了 ${Math.round((now - head.waitingSince) / 60_000)} 分钟，放弃：${error}`);
              try { this.deps.gaveUp?.(head, error); } catch { /* 留提示失败不挡后面的 */ }
              head.resolve({ ok: false, error });
              continue;
            }
            if (!head.waitNoted) {
              head.waitNoted = true;
              try { this.deps.waitingForConnection?.(head); } catch { /* 同上 */ }
            }
            this.save();
            const delay = connRetryDelay(head.connAttempts ?? 0, retry.firstMs, retry.maxMs);
            head.connAttempts = (head.connAttempts ?? 0) + 1;
            this.deps.log?.(`wake ${head.id} session=${sessionId} 会话没连着，${Math.round(delay / 1000)} 秒后（或连上时）再发：${error}`);
            await this.waitForConnection(sessionId, delay);
            continue;
          }
          this.take(sessionId, head);
          head.resolve({ ok: false, error: String((err as any)?.message || err) });
          continue;
        }
        this.sending.delete(head);
        this.take(sessionId, head);
        if (head.waitingSince !== undefined) this.deps.log?.(`wake ${head.id} session=${sessionId} 会话连上了，已发出`);
        head.resolve({ ok: true });
      }
    } finally {
      this.pumping.delete(sessionId);
    }
  }

  /** 把这一条从队里拿掉（期间被 `drop` 过的话队列已经不在了）。 */
  private take(sessionId: string, it: Pending): void {
    const q = this.queues.get(sessionId);
    if (!q) return;
    const i = q.indexOf(it);
    if (i >= 0) q.splice(i, 1);
    this.save();
  }

  /** 等 `ms`，或者等到 `kick`（连上了）。 */
  private waitForConnection(sessionId: string, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.connWaits.get(sessionId) === done) this.connWaits.delete(sessionId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.connWaits.set(sessionId, done);
    });
  }

  /** 要落盘的那几条交给 `changed`（没变就不写）。 */
  private save(): void {
    if (!this.deps.changed) return;
    const list: WakeItem[] = [];
    for (const q of this.queues.values()) {
      for (const it of q) {
        if (!(this.deps.persist?.(it) ?? false)) continue;
        const { resolve: _r, seq: _s, connAttempts: _c, ...rest } = it;
        list.push(rest);
      }
    }
    const key = JSON.stringify(list);
    if (key === this.lastSaved) return;
    this.lastSaved = key;
    try { this.deps.changed(list); } catch { /* 落盘失败不挡投递 */ }
  }
}
