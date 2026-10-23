/**
 * **会话忙时的切换：先记下来（pending），这一轮跑完再切** ——
 * 「会话正在跑一轮时切换 agent，KiroLex 直接报错拒绝」。
 *
 * 和换项目（`acp:move-session` 的 `pendingProjectReset`）同一个思路：一轮中间换执行器会把那一轮
 * 连根拔掉，拒绝又让人在最想改设置的时候动不了 —— 所以记下来，这一轮结束（正常 / 出错 / Stop）
 * 立刻应用。
 *
 * 纯逻辑（不 import electron），index.ts 只负责把"怎么真的切"作为钩子传进来。
 *   - `PendingSwitchBook`：每条会话、每一类切换只留**最后一次**；内存态。
 *   - `runPendingSwitches`：按依赖顺序一次性应用；需要重连执行器的几类**合并成一次重连**。
 *   - `PendingSwitchRunner`：轮次结束时 `kick`、发新消息前 `settle`（先切再发）。
 */

/** 要换执行器的几类，按"谁的重连能把别的一起带上"从强到弱排 —— 运行位置 / 引擎先于 agent / 模型 / 组合。 */
export const RECONNECT_ORDER = ['remote', 'engine', 'combo', 'agent', 'model'] as const;
/** 在活着的执行器上就能改的几类（不重连），排在重连之后。 */
export const INSTANT_ORDER = ['engineModel', 'engineEffort', 'engineMode', 'engineCollab', 'permission'] as const;

export type ReconnectKind = typeof RECONNECT_ORDER[number];
export type InstantKind = typeof INSTANT_ORDER[number];
export type PendingKind = ReconnectKind | InstantKind;

export interface PendingSwitch {
  kind: PendingKind;
  /** 切换的参数（各类自己的形状，由 index.ts 解释） */
  value: any;
  /** 给界面 / 提示看的那个新值（agent 名、模型 id、机器名……） */
  label: string;
}

const ORDER: readonly PendingKind[] = [...RECONNECT_ORDER, ...INSTANT_ORDER];

export function isReconnectKind(kind: PendingKind): kind is ReconnectKind {
  return (RECONNECT_ORDER as readonly string[]).includes(kind);
}

export class PendingSwitchBook {
  private readonly map = new Map<string, Map<PendingKind, PendingSwitch>>();
  /**
   * **已经取走、正在应用、还没落定的那一批**（`takeForApply` → `doneApplying` / `endApplying`）。
   * 重连要好几秒，这期间退出应用的话，它们既不在 `map` 里、也还没写进记录 —— 不留这份账就会静默丢掉。
   */
  private readonly applying = new Map<string, Map<PendingKind, PendingSwitch>>();
  /** 这一段等待从什么时候开始（第一次登记）——界面上「已等 N 秒」从这里算 */
  private readonly started = new Map<string, number>();

  /** 这条会话现在这段等待的开始时刻；没有待切换就是 undefined */
  sinceOf(sessionId: string): number | undefined {
    return this.has(sessionId) ? this.started.get(sessionId) : undefined;
  }

  /** 记一次；同类已有的被这一次顶掉（只保留最后一次）。 */
  set(sessionId: string, sw: PendingSwitch, now: number = Date.now()): void {
    let m = this.map.get(sessionId);
    /* 一段等待从第一次登记算起：同一段里再改选不重新计时（「已等 N 秒」） */
    if (!m) { m = new Map(); this.map.set(sessionId, m); this.started.set(sessionId, now); }
    m.delete(sw.kind);
    m.set(sw.kind, sw);
  }

  has(sessionId: string): boolean {
    return (this.map.get(sessionId)?.size || 0) > 0;
  }

  /** 按依赖顺序列出（不清空）。 */
  list(sessionId: string): PendingSwitch[] {
    const m = this.map.get(sessionId);
    if (!m) return [];
    return ORDER.filter((k) => m.has(k)).map((k) => m.get(k)!);
  }

  /** 取走全部（按依赖顺序），之后这条会话就没有 pending 了。 */
  take(sessionId: string): PendingSwitch[] {
    const out = this.list(sessionId);
    this.map.delete(sessionId);
    return out;
  }

  /** 取走去应用：和 `take` 一样清空 pending，但在 `applying` 里留账，直到每一类落定。 */
  takeForApply(sessionId: string): PendingSwitch[] {
    const out = this.take(sessionId);
    if (out.length) this.applying.set(sessionId, new Map(out.map((sw) => [sw.kind, sw])));
    return out;
  }

  /** 这几类已经落定（成功写进执行器 / 记录，或者失败并已告诉用户）：不再算"欠着"。 */
  doneApplying(sessionId: string, kinds: PendingKind[]): void {
    const m = this.applying.get(sessionId);
    if (!m) return;
    for (const k of kinds) m.delete(k);
    if (!m.size) this.applying.delete(sessionId);
  }

  /** 这一批应用结束（不管结果）：剩下的账也清掉。 */
  endApplying(sessionId: string): void {
    this.applying.delete(sessionId);
  }

  /** 退出时还欠着的会话：没应用的 + 正在应用、还没落定的。 */
  sessionsForQuit(): string[] {
    return [...new Set([...this.sessions(), ...this.applying.keys()])];
  }

  /**
   * 退出时取走这条会话欠着的全部（按依赖顺序）：正在应用、还没落定的那一批 + 之后又选的；
   * 同一类以**之后又选的**为准（最后一次）。
   */
  takeForQuit(sessionId: string): PendingSwitch[] {
    const merged = new Map<PendingKind, PendingSwitch>(this.applying.get(sessionId) || []);
    for (const sw of this.list(sessionId)) merged.set(sw.kind, sw);
    this.applying.delete(sessionId);
    this.map.delete(sessionId);
    return ORDER.filter((k) => merged.has(k)).map((k) => merged.get(k)!);
  }

  /** 取消某一类；不给 kind 就整条会话都取消。返回是否真的取消了东西。 */
  cancel(sessionId: string, kind?: PendingKind): boolean {
    const m = this.map.get(sessionId);
    if (!m) return false;
    if (!kind) { this.map.delete(sessionId); return m.size > 0; }
    const had = m.delete(kind);
    if (!m.size) this.map.delete(sessionId);
    return had;
  }

  /** `{ kind: label }` —— 推给界面显示「⏳ 这一轮跑完后切换」。 */
  view(sessionId: string): Partial<Record<PendingKind, string>> {
    const out: Partial<Record<PendingKind, string>> = {};
    for (const sw of this.list(sessionId)) out[sw.kind] = sw.label;
    return out;
  }

  sessions(): string[] {
    return [...this.map.keys()].filter((id) => this.has(id));
  }
}

export interface ApplyReport {
  applied: PendingKind[];
  unchanged: PendingKind[];
  failed: Array<{ kind: PendingKind; label: string; error: string }>;
  /** 实际重连了几次执行器 */
  reconnects: number;
}

export interface ApplyHooks {
  /**
   * 用 `head` 这一类重连一次执行器，并尽量把 `carry`（比它弱的几类）一起带进新执行器的配置。
   * 返回 `unchanged: true` = 这一类其实没变（什么都没做，carry 也没带）；
   * `carried: false` = 只应用了 head（例如会话没连着，只写了记录），carry 要逐个再来。
   */
  reconnect(head: PendingSwitch, carry: PendingSwitch[]): Promise<{ unchanged?: boolean; carried?: boolean } | void>;
  instant(sw: PendingSwitch): Promise<void>;
  /**
   * 重连之后、即时项之前调一次：等新执行器自己的配置恢复（按 profile 设回模型 / effort / 权限）落定。
   * 不等的话，先设上的新值会被那次恢复按旧值盖回去。
   */
  beforeInstants?(): Promise<void>;
  /** 这几类落定了（成功、失败或其实没变）—— 给 `PendingSwitchBook.doneApplying` 销账用。 */
  onDone?(kinds: PendingKind[]): void;
}

const errText = (err: unknown): string => String((err as any)?.message || err || 'failed');

/** 一次性应用一批 pending：重连类合并成一次，失败的记下来、剩下的照样试，**从不抛**。 */
export async function runPendingSwitches(entries: PendingSwitch[], hooks: ApplyHooks): Promise<ApplyReport> {
  const report: ApplyReport = { applied: [], unchanged: [], failed: [], reconnects: 0 };
  const strength = (k: PendingKind) => RECONNECT_ORDER.indexOf(k as ReconnectKind);
  let rec = entries.filter((e) => isReconnectKind(e.kind)).sort((a, b) => strength(a.kind) - strength(b.kind));
  while (rec.length) {
    const [head, ...rest] = rec;
    try {
      const r = (await hooks.reconnect(head, rest)) || {};
      if (r.unchanged) { report.unchanged.push(head.kind); hooks.onDone?.([head.kind]); rec = rest; continue; }
      report.reconnects++;
      report.applied.push(head.kind);
      if (r.carried === false) { hooks.onDone?.([head.kind]); rec = rest; continue; }
      report.applied.push(...rest.map((e) => e.kind));
      hooks.onDone?.([head.kind, ...rest.map((e) => e.kind)]);
      rec = [];
    } catch (err) {
      report.failed.push({ kind: head.kind, label: head.label, error: errText(err) });
      hooks.onDone?.([head.kind]);
      rec = rest;
    }
  }
  const instants = entries.filter((e) => !isReconnectKind(e.kind));
  if (instants.length && hooks.beforeInstants) {
    try { await hooks.beforeInstants(); } catch { /* 恢复出错也照样设即时项 */ }
  }
  for (const sw of instants) {
    try {
      await hooks.instant(sw);
      report.applied.push(sw.kind);
    } catch (err) {
      report.failed.push({ kind: sw.kind, label: sw.label, error: errText(err) });
    }
    hooks.onDone?.([sw.kind]);
  }
  return report;
}

export interface RunnerDeps {
  /** 这条会话现在是不是有一轮在跑（在跑就不应用，等它结束） */
  isBusy(sessionId: string): boolean;
  apply(sessionId: string, entries: PendingSwitch[]): Promise<unknown>;
}

export class PendingSwitchRunner {
  private readonly book: PendingSwitchBook;
  private readonly deps: RunnerDeps;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(book: PendingSwitchBook, deps: RunnerDeps) {
    this.book = book;
    this.deps = deps;
  }

  isApplying(sessionId: string): boolean {
    return this.inFlight.has(sessionId);
  }

  /**
   * 轮次结束时调：有 pending、而且不忙 → 开始应用（同步登记在飞，后来的 settle 一定等得到它）。
   * 正在应用就返回那一次；什么都不用做返回 undefined。
   */
  kick(sessionId: string): Promise<void> | undefined {
    const running = this.inFlight.get(sessionId);
    if (running) return running;
    if (!this.book.has(sessionId) || this.deps.isBusy(sessionId)) return undefined;
    const entries = this.book.takeForApply(sessionId);
    const p = Promise.resolve()
      .then(() => this.deps.apply(sessionId, entries))
      .then(() => undefined, () => undefined)
      .finally(() => {
        this.book.endApplying(sessionId);
        this.inFlight.delete(sessionId);
        /* 应用期间又选了一次（被记成新的 pending）：接着应用 */
        if (this.book.has(sessionId)) void this.kick(sessionId);
      });
    this.inFlight.set(sessionId, p);
    return p;
  }

  /** 发新消息前调：先把欠着的切换应用完（新消息用新的 agent / 模型），不能被新一轮抢先。 */
  async settle(sessionId: string): Promise<void> {
    for (let guard = 0; guard < 20; guard++) {
      const p = this.inFlight.get(sessionId) || this.kick(sessionId);
      if (!p) return;
      await p;
    }
  }
}

/** Claude Code / Codex 的选项在会话记录里的样子（`AgentProfile` 的那两个字段）。 */
export interface EngineOptionFields {
  engineModels?: Partial<Record<string, string>>;
  engineOptions?: Partial<Record<string, Partial<Record<string, string>>>>;
}

/**
 * 把一次 Claude Code / Codex 选项（model / thought_level / mode）写进 profile —— 和 `setEngineOption`
 * 在活着的执行器上写的是同一个形状。会话已经没有执行器（这一轮结束前断开 / 休眠）、或者退出应用时
 * 还欠着这一项，就写进记录：下次接上时 `applyEngineModel` 按记录设回去，不偷偷丢。
 */
export function withEngineOption<P extends EngineOptionFields>(profile: P, engine: string, category: string, value: string): P {
  return category === 'model'
    ? { ...profile, engineModels: { ...profile.engineModels, [engine]: value } }
    : { ...profile, engineOptions: { ...profile.engineOptions, [engine]: { ...profile.engineOptions?.[engine], [category]: value } } };
}

/**
 * **这次切换要不要先登记成 pending**（`queueSwitchWhileBusy` 用的就是它）。
 *
 * 必须排在各入口"没连着就只写记录"那条路**之前**：上一批 pending 正在应用时，那次重连会先把执行器拿掉
 * （换模型先放锁再加载）—— 这时再选一次，看起来像"没连着"，只写记录的话，正在进行的那次重连完成时
 * 会用它手里的旧 profile 把记录盖掉，最后一次选择就丢了。所以"有执行器吗"不参与这个判断。
 */
export function shouldQueueSwitch(s: { busy: boolean; applying: boolean; fromPending?: boolean }): boolean {
  if (s.fromPending) return false; // 正在应用 pending 的那一次调用自己，不能再记回去
  return s.busy || s.applying;
}

/* ─────────────── 等待时说清楚：会话里的提示卡 / 输入框下的徽标（负责人反馈 2026-10-23） ─────────────── */

/** 新值本身就说明了是什么（本机 / Claude Code / agent 名 / 模型 id / 组合）——单独一项时不用再加类别名。 */
const SELF_DESCRIBING: readonly PendingKind[] = ['remote', 'engine', 'combo', 'agent', 'model', 'engineModel'];

/**
 * 「跑完后切到 ___」里那几个字。一项：「本机」「Claude Code」「思考强度 high」；
 * 几项一起：「运行位置 本机、模型 opus」（按依赖顺序，和真正应用的顺序一致）。
 */
export function pendingTargetText(
  pending: Partial<Record<PendingKind, string>>,
  kindName: (kind: PendingKind) => string,
  sep: string,
): string {
  const kinds = ORDER.filter((k) => pending[k] !== undefined);
  if (kinds.length === 1 && SELF_DESCRIBING.includes(kinds[0])) return String(pending[kinds[0]]);
  return kinds.map((k) => `${kindName(k)} ${pending[k]}`).join(sep);
}

/** 「已等 N 秒」：从插那条提示（= 这一段等待第一次登记）算起，整秒、不为负。 */
export function waitedSeconds(since: number, now: number): number {
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** 会话里那条「⏳ 这一轮还在跑…」提示的分组键（主进程插、渲染端认）。 */
export const PENDING_SWITCH_NOTE_GROUP = 'pending-switch';

/**
 * 哪一条提示画成**活的**卡片（秒数在走、带「停止这一轮并立即切换」「取消切换」）：
 * 还有待切换（`since` = 这段等待的开始时刻）时，属于这段等待的最后那条 pending-switch 提示；
 * 没有待切换了（已切 / 已取消）就没有 —— 它退回成普通的一句话。
 * 返回 null 而还有待切换 = 那条提示还没进列表（这一轮正在流式输出时提示先攒着，见 useAcp 的 heldNotesRef）：
 * 界面把卡片画在列表最底下，跟在正在输出的回复后面，不拆开回复。
 */
export function livePendingNoteId(
  messages: ReadonlyArray<{ id: string; kirolex?: boolean; noteGroup?: string; timestamp?: number }>,
  since: number | undefined,
): string | null {
  if (since === undefined) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!(m.kirolex && m.noteGroup === PENDING_SWITCH_NOTE_GROUP)) continue;
    /* 早于这段等待的那条是上一段等待留下的（已经切完 / 取消了），不算；留几秒余量给两边的时钟和落盘 */
    return (m.timestamp ?? 0) >= since - 5000 ? m.id : null;
  }
  return null;
}
