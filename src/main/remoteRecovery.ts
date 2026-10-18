/**
 * **断了的远程会话自己接回来** ——「重建真的会发生」的另一半。
 *
 * 只靠"活着的执行器 / 正在 attach 的会话"判断"这台机器还有人要用"是不够的：复用 master 一断，
 * 走在它上面的每条会话的 ssh 也跟着退出，`disconnected` 把它们从 `sessionClients` 里删掉；
 * 渲染层只自动重连**一次**，网络还没回来那次就失败了 —— 于是这台机器上"没有会话"、重建停了，
 * 可用户明明还开着这些会话。Windows 上没有复用连接，更是只剩那一次尝试。
 *
 * 所以单独记一份"要恢复的远程会话"，**和执行器活没活着无关**：按退避（`healDelay`，几秒 →
 * 封顶一分钟）一直试，直到接上、或者用户把它归档 / 删掉 / 切回本地（每次动手前都按记录再判一次，
 * 判据是调用方给的 `target`）、或者 KiroLex 退出。会话上挂一句「正在重连（第 N 次）」，接上后换成"恢复了"。
 *
 * 复用平台上每一轮先把那台机器的连接拉起来（`ensureConnection`，同一台机器并发只握一次手），
 * 连接没回来就不起执行器 —— 不然 N 条会话各自 preflight 就是 N 次握手砸向 sshd 的 `MaxStartups`。
 */

import { HEAL_BACKOFF_MS, healDelay } from './sshMux.ts';
import { tr } from './uiText.ts';

export interface RecoveryTarget {
  /** 那台机器的 muxKey —— 连接回来时按它把等着的会话叫醒。 */
  key: string;
}

export interface RecoveryDeps<T extends RecoveryTarget = RecoveryTarget> {
  /** 这条会话还该不该恢复（记录在、没归档、没删、仍是远程、没在退出）。不该就返回 undefined。 */
  target(sessionId: string): T | undefined;
  /** 执行器活着吗、有没有本地工具、是不是正在跑一轮。 */
  attached(sessionId: string): boolean;
  toolless(sessionId: string): boolean;
  busy(sessionId: string): boolean;
  /** 收掉一个"连着但没有本地工具"的执行器（只有换执行器才补得上工具）。 */
  detach(sessionId: string): Promise<void>;
  /** 先把那台机器的连接拉起来（复用平台）；拉不起来就抛。不需要的平台给 undefined。 */
  ensureConnection?(target: T): Promise<unknown>;
  /** 把会话挂回来；成功返回 true。 */
  reattach(sessionId: string): Promise<boolean>;
  /** `group`：同类提示的键，界面据此把「第 1 次 / 第 2 次…」并成一条计数（`renderer/noticeMerge.ts`） */
  notice(sessionId: string, text: string, sticky: boolean, group?: string): void;
  /** 接回来了（渲染层要把它标成"连着"）。 */
  recovered?(sessionId: string, attempts: number): void;
  log?(message: string): void;
  /** 退避表。可注入只为测试。 */
  backoffMs?: readonly number[];
  /** 连接回来时叫醒等着的会话，相邻两条错开多久（别一口气 N 次 attach）。 */
  staggerMs?: number;
}

export const RECONNECTING_TEXT = (n: number): string =>
  tr('⚠️ The local tools connection dropped; reconnecting (attempt {n}). Until then this remote session can\'t read or write your files.', { n });
/** 「正在重连」「已恢复」两类提示的键 —— index.ts 的 sshMux 那一路用同一对，两处说的是同一件事 */
export const LOCAL_TOOLS_RECONNECT_GROUP = 'local-tools-reconnect';
export const LOCAL_TOOLS_RESTORED_GROUP = 'local-tools-restored';
/** 按当前界面语言取（所以是函数，不是常量） */
export const RECOVERED_TEXT = (): string => tr('Local tools connection restored.');

interface State { attempt: number; timer?: NodeJS.Timeout; running?: boolean }

export class RemoteRecovery<T extends RecoveryTarget = RecoveryTarget> {
  private states = new Map<string, State>();
  private deps: RecoveryDeps<T>;

  constructor(deps: RecoveryDeps<T>) { this.deps = deps; }

  has(sessionId: string): boolean { return this.states.has(sessionId); }
  keys(): string[] { return [...this.states.keys()]; }
  attemptOf(sessionId: string): number { return this.states.get(sessionId)?.attempt || 0; }

  /** 这台机器上在等的会话（给复用连接的"还有没有人要用"那个判据）。 */
  waitingOn(key: string): string[] {
    return this.keys().filter((sid) => this.deps.target(sid)?.key === key);
  }

  /** `quiet`：不是断线、是主动重接（端口变了）—— 第一句不说"中断了"。 */
  start(sessionId: string, opts: { quiet?: boolean } = {}): void {
    if (this.states.has(sessionId) || !this.deps.target(sessionId)) return;
    this.states.set(sessionId, { attempt: 0 });
    this.schedule(sessionId, opts.quiet);
  }

  stop(sessionId: string): void {
    const st = this.states.get(sessionId);
    if (st?.timer) clearTimeout(st.timer);
    this.states.delete(sessionId);
  }

  stopAll(): void { for (const sid of this.keys()) this.stop(sid); }

  /** 那台机器的连接回来了：在等它的那几条现在就试（不等各自的退避定时器）。 */
  kick(key: string): void {
    let i = 0;
    for (const sid of this.waitingOn(key)) {
      const t = setTimeout(() => { void this.tick(sid); }, (this.deps.staggerMs ?? 1_500) * i);
      t.unref?.();
      i += 1;
    }
  }

  private schedule(sessionId: string, quiet = false): void {
    const st = this.states.get(sessionId);
    if (!st) return;
    if (!this.deps.target(sessionId)) { this.stop(sessionId); return; }
    const delay = healDelay(st.attempt, this.deps.backoffMs || HEAL_BACKOFF_MS);
    st.attempt += 1;
    if (!quiet) this.deps.notice(sessionId, RECONNECTING_TEXT(st.attempt), true, LOCAL_TOOLS_RECONNECT_GROUP);
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => { void this.tick(sessionId); }, delay);
    /* `unref`：别让这个定时器挡住退出 */
    st.timer.unref?.();
  }

  /** 试一次。公开只为测试和 `kick`。 */
  async tick(sessionId: string): Promise<void> {
    const st = this.states.get(sessionId);
    if (!st || st.running) return;
    if (st.timer) { clearTimeout(st.timer); st.timer = undefined; }
    const target = this.deps.target(sessionId);
    if (!target) { this.stop(sessionId); return; }
    st.running = true;
    /*
      **每一次 await 之后都要重新判**：等连接 / 挂载的那几秒里用户可能归档了、删了、切回本地了，
      或者 KiroLex 在退出（`stopAll`）。只在开头判一次的话，那条会话会在用户关掉之后被重新挂上。
    */
    const wanted = (): boolean => this.states.get(sessionId) === st && !!this.deps.target(sessionId);
    let ok = false;
    let cancelled = false;
    try {
      if (this.deps.attached(sessionId) && !this.deps.toolless(sessionId)) {
        ok = true;                                    // 别处（渲染层那次重连、用户发消息）已经接上了
      } else if (this.deps.attached(sessionId) && this.deps.busy(sessionId)) {
        ok = false;                                   // 没工具但正在跑一轮：不打断，下一轮再看
      } else {
        if (this.deps.attached(sessionId)) await this.deps.detach(sessionId);
        if (!wanted()) { cancelled = true; return; }
        if (this.deps.ensureConnection) await this.deps.ensureConnection(target);
        if (!wanted()) { cancelled = true; return; }
        const attachedNow = await this.deps.reattach(sessionId);
        /* 挂载的过程中被取消了：刚起来的执行器不能留着 */
        if (!wanted()) {
          cancelled = true;
          if (attachedNow || this.deps.attached(sessionId)) await this.deps.detach(sessionId).catch(() => {});
          return;
        }
        ok = attachedNow && !this.deps.toolless(sessionId);
      }
    } catch (err: any) {
      this.deps.log?.(`自动重连这一轮没成 sessionId=${sessionId}: ${err?.message || err}`);
      ok = false;
      /* 失败的同时已经被取消了：万一挂了一半，也收掉 */
      if (!wanted()) {
        cancelled = true;
        if (this.deps.attached(sessionId)) await this.deps.detach(sessionId).catch(() => {});
      }
    } finally {
      st.running = false;
      if (cancelled) {
        this.deps.log?.(`恢复途中这条会话被关掉了（归档 / 删除 / 切回本地 / 退出），不再挂上 sessionId=${sessionId}`);
        if (this.states.get(sessionId) === st) this.stop(sessionId);
      }
    }
    if (cancelled) return;
    if (this.states.get(sessionId) !== st) return;   // 这期间被停掉了（归档 / 删除 / 退出）
    if (!ok) { this.schedule(sessionId); return; }
    this.stop(sessionId);
    this.deps.log?.(`远程会话自动接回来了 sessionId=${sessionId}（第 ${st.attempt} 次）`);
    this.deps.notice(sessionId, RECOVERED_TEXT(), false, LOCAL_TOOLS_RESTORED_GROUP);
    try { this.deps.recovered?.(sessionId, st.attempt); } catch { /* 通知失败不影响恢复本身 */ }
  }
}
