/**
 * **发送前的准备要等（异步读历史 / 记忆）—— 等的这段时间里执行器不能悄悄换掉**（审查意见）。
 *
 * 原来 sendPromptOnce 从「这一轮在跑吗」到 `entry.busy = true` 之间是同步的，执行器不可能被换。读历史快照、读记忆改成异步之后，
 * 这段时间里 `busy` 还是 false：
 *   - 空闲回收（`ensureExecutorCapacity`）会把它当成空闲的收掉 → 这里用 `PrepHolds` 占住，回收跳过它（`canEvict`）；
 *   - 换模型 / 换机器 / 换 agent 会替换它（`sessionClients` 里换成新的），或者正换到一半（`reconfiguring` / 正在应用待切换）
 *     → 等完再看一眼（`prepOnExecutor`），变了就告诉调用方「执行器动过」，由它等切换落定、按**当前**执行器从头重走这一条。
 * 纯模块，不 import electron；index.ts 注入「当前执行器是谁」「是不是正在切换」。
 */
import { compactHolds, type CompactWait } from './compactWait.ts';

/** 正在为哪几条会话准备发送（同一条可以有几次并发的准备，按次数算） */
export class PrepHolds {
  private readonly n = new Map<string, number>();
  hold(sessionId: string): () => void {
    this.n.set(sessionId, (this.n.get(sessionId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.n.get(sessionId) || 1) - 1;
      if (left > 0) this.n.set(sessionId, left); else this.n.delete(sessionId);
    };
  }
  has(sessionId: string): boolean { return this.n.has(sessionId); }
}

/**
 * 空闲回收能不能收这一条：正在跑的、后端自己起的一轮、**正在准备发送的**、**还在压缩的**都不收。
 * 压缩中：kiro 的 /compact 回了 end_turn（busy 清掉了），压缩本身还在这个进程里跑 —— 收掉就打断压缩、丢掉完成信号和花费帧（`compactWait.ts`）。
 */
export function canEvict(id: string, e: { busy?: boolean; autonomous?: unknown; compactWait?: CompactWait }, excludeId: string | undefined, holds: PrepHolds): boolean {
  if (compactHolds(e.compactWait)) return false;
  return id !== excludeId && !e.busy && !e.autonomous && !holds.has(id);
}

export interface PrepDeps<E> {
  /** 这条会话现在挂着的执行器 */
  current: (sessionId: string) => E | undefined;
  /** 正在换执行器（换模型 / 机器 / agent 的那一下，或者正在应用待切换） */
  switching: (sessionId: string) => boolean;
  holds: PrepHolds;
}

export type PrepResult<T> = { moved: false; value: T } | { moved: true; why: 'replaced' | 'gone' | 'switching' };

/**
 * 占住执行器做一段要等的准备；做完看执行器还是不是这一个、有没有正在切换。
 * `moved: true` = 准备的东西作废，调用方别往下发（等切换落定、按当前执行器重走）。
 */
export async function prepOnExecutor<E, T>(sessionId: string, entry: E, deps: PrepDeps<E>, work: () => Promise<T>): Promise<PrepResult<T>> {
  const release = deps.holds.hold(sessionId);
  try {
    const value = await work();
    const now = deps.current(sessionId);
    if (now === undefined) return { moved: true, why: 'gone' };
    if (now !== entry) return { moved: true, why: 'replaced' };
    if (deps.switching(sessionId)) return { moved: true, why: 'switching' };
    return { moved: false, value };
  } finally {
    release();
  }
}

/**
 * **交给适配器排（queued handoff）之前的那道闸**，和 sendPromptOnce 里最先那一段同一个顺序：后端自己起的一轮 → 退回队列；
 * 这一轮已经结束 → 按普通消息发（`idle`）；占着的不是普通一轮 / 适配器不能排 → 退回队列；有切换欠着（忙时选的）/ 正在应用 → 退回队列（切换完再发）。
 * 读记忆要等（审查意见）：等的时候这一轮可能结束了、可能**新登记了待切换** —— 读完、交出去之前按这里再过一遍，不让它在旧执行器上抢在切换前面。
 */
export interface QueuedHandoffFacts {
  autonomous: boolean;
  busy: boolean;
  turnRunning: boolean;
  supportsPromptQueueing: boolean;
  switchOwed: boolean;
}
export function queuedHandoffRefusal(f: QueuedHandoffFacts): null | 'unsupported' | 'idle' | 'switch-owed' {
  if (f.autonomous) return 'unsupported';
  if (!f.busy) return 'idle';
  if (!f.turnRunning || !f.supportsPromptQueueing) return 'unsupported';
  if (f.switchOwed) return 'switch-owed';
  return null;
}
