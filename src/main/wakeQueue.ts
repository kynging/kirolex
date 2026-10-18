/**
 * **后台唤醒的投递** —— 定时任务到点、后台命令退出、监视到新输出，都要「作为一条新消息发进那条会话」。
 *
 * 规则（任务原话）：**不打断正在跑的一轮**。会话正忙就等这一轮结束再发 —— 作为新的一条，
 * 不 steer、不进用户的排队卡片、不被「合并排队消息」合并。多个同时到期按时间顺序逐条发。
 *
 * 所以这里是一条**主进程自己的**、每会话一条的 FIFO（按 `at` 排序），和渲染端的排队卡片完全分开：
 *   · 只在 `isBusy` 为假时发队头那一条，发完（这一轮结束）再看下一条；
 *   · 发的那一刻撞上「还在跑」（和用户的排队消息抢同一个空档）→ 留在队头，下次空了再发，不丢；
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
  source: 'schedule' | 'bg' | 'watch';
  /** 定时任务的 id（`source = 'schedule'`）—— 发送时拿它当消息 id 的一部分。 */
  ref?: string;
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
}

type Pending = WakeItem & { seq: number; resolve: (r: WakeResult) => void };

export class WakeDispatcher {
  private readonly queues = new Map<string, Pending[]>();
  private readonly pumping = new Set<string>();
  /** 正在发的那一条（`dropRef` 不碰它 —— 已经交给执行器了）。 */
  private readonly sending = new Set<Pending>();
  private seq = 0;
  private readonly deps: WakeDeps;

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
    });
  }

  /** 这条会话还排着的（按将要发的顺序）。 */
  pending(sessionId: string): WakeItem[] {
    return (this.queues.get(sessionId) || []).map(({ resolve: _r, seq: _s, ...rest }) => rest);
  }

  /** 会话删了 / 归档了：排着的全部作废（已经在发的那一条不受影响）。 */
  drop(sessionId: string, why = 'session gone'): void {
    const q = this.queues.get(sessionId);
    if (!q) return;
    this.queues.delete(sessionId);
    for (const it of q) it.resolve({ ok: false, error: why });
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
          this.take(sessionId, head);
          head.resolve({ ok: false, error: String((err as any)?.message || err) });
          continue;
        }
        this.sending.delete(head);
        this.take(sessionId, head);
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
  }
}
