/**
 * **压缩中**：发出 `/compact` 之后，直到看到「压缩真的完成了」才放行下一条 —— PURE（`tests/compactWait.test.ts`）。
 *
 * 实测（2026-11-28，kyn-desktop，kiro 远程会话）：kiro 的 `/compact` 只回一句 "Compacting conversation..." 就 `end_turn`（130ms），
 * **压缩本身还在后台跑**；KiroLex 当它空闲了，22 秒后发出的下一条被 kiro 吞掉（不出字、不结束），15 分钟后才被卡死检测打断；
 * 压缩的花费（11.5 credits）还被记到了那条用户消息头上。
 *
 * 所以：
 *   - 发出 `/compact`（提醒按钮 / 自动压缩 / 手打都一样，主进程按正文认）就进「压缩中」；
 *   - 那一轮结束了也还算压缩中，直到收到**上下文占用骤降**的用量帧（kiro `_kiro.dev/metadata.contextUsagePercentage`、
 *     Claude / Codex `usage_update`）—— ACP 里没有单独的「压缩完成」通知，骤降是唯一可靠的信号（日志里 `context usage dropped sharply` 那一帧）；
 *   - 都没等到：从发出起最多 3 分钟（`COMPACT_WAIT_MAX_MS`），到了照常放行、记一行日志；
 *   - Claude Code / Codex 的 `/compact` 是同步的（压完这一轮才结束），一轮结束就算完成，不受影响；
 *   - 压缩中收到的用量帧（含压缩的花费）记在压缩那一条助手消息上，不记到下一条用户消息头上。
 */
import { foldTurnFrame, type TurnUsageAcc } from './turnUsage.ts';

export const COMPACT_WAIT_MAX_MS = 3 * 60_000;
/** 骤降：比发 /compact 时至少掉 10 个百分点，或者掉到原来的 70% 以下（原来就不高时 10 个点可能根本掉不出来）。 */
export const COMPACT_DONE_MIN_POINTS = 10;
export const COMPACT_DONE_MAX_RATIO = 0.7;
/** 攒下的花费合计（kiro 的 credits + Claude 的 cost），比一帧前后有没有变多用（变多了主进程就更新压缩那条上的补记）。 */
export function compactCostOf(acc: TurnUsageAcc | undefined): number {
  return (acc?.credits ?? 0) + (acc?.cost ?? 0);
}

export type CompactEngine = 'kiro' | 'claude' | 'codex';

export interface CompactWait {
  /**
   * 这一次压缩的批次号：状态每变一次都是新对象（`noteCompactUsage` / `noteCompactTurnEnd` 都返回新的），
   * 所以超时定时器认批次号、不认对象 —— 认对象的话 end_turn 之后它就永远对不上，3 分钟到了也不放行。
   */
  batch: number;
  startedAt: number;
  /** 发 /compact 时最后一次知道的占用；不知道 = null（只能等超时，或者看到一个明显很低的读数）。 */
  pctBefore: number | null;
  /** /compact 那一轮已经结束（之后的用量帧算压缩的，不算哪一轮的）。 */
  turnEnded: boolean;
  /** 压缩那一条助手消息（"Compacting conversation..."）的 id 和它回的那条 /compact 用户消息 —— 花费落在它上面。 */
  messageId?: string;
  replyTo?: string;
  /** 压缩那一轮结束之后到放行之前收到的用量（含压缩的花费）。 */
  acc?: TurnUsageAcc;
  /** 最后一次读数（日志 `finished pct=A->B`）。 */
  pctAfter?: number;
  /** 压缩那一轮还没结束就已经看到骤降了（同步压完）。 */
  droppedDuringTurn?: boolean;
  /** 完成了（或超时、出错放行了）。之后不再挡消息。notice = kiro 自己报了压缩完成（`_kiro.dev/compaction/status`）；stopped = 你按了停止（放弃等待，见 `stopCompactWait`）。 */
  finished?: { at: number; by: 'drop' | 'notice' | 'sync' | 'timeout' | 'error' | 'stopped' };
  /**
   * **花费归属关上了**：之后的帧不再算压缩的。不按时间窗口关 —— 按协议：kiro 一轮的计量在**那一轮的结尾**才报
   * （kiro-cli 里 `EndTurn: backend context usage` → turn metadata），压缩的计量是它自己那一帧（`metadata after compaction`）。
   * 所以放行之后、**下一轮还没出任何输出之前**到的计量只可能是压缩的；下一轮一出正文 / 工具调用（`isTurnOutputUpdate`），
   * 或者下一轮结束、又发了一次 /compact，才关。关之前每多一笔花费，主进程就更新一次压缩那条上的补记。
   */
  settled?: boolean;
  /** 上次补记到压缩那条上的花费合计（`writeCompactUsage` 判要不要再写一行）。 */
  writtenCost?: number;
  /** 超时放行之后发出去的那一条已经完整注入过记忆了：之后迟到的骤降不再要求下一轮再完整注入一次。 */
  fullSentAfterTimeout?: boolean;
}

let nextBatch = 1;
export function startCompactWait(now: number, pctBefore: number | null | undefined, batch: number = nextBatch++): CompactWait {
  return { batch, startedAt: now, pctBefore: typeof pctBefore === 'number' && Number.isFinite(pctBefore) ? pctBefore : null, turnEnded: false };
}

/** 这个读数算不算「压缩完成」（相对发 /compact 时的占用骤降）。 */
export function isCompactDrop(pctBefore: number | null, pct: number): boolean {
  if (!Number.isFinite(pct)) return false;
  if (pctBefore === null) return false;
  return pctBefore - pct >= COMPACT_DONE_MIN_POINTS || (pctBefore > 0 && pct <= pctBefore * COMPACT_DONE_MAX_RATIO);
}

/** 还在挡新消息（压缩中）。 */
export function compactHolds(w: CompactWait | undefined | null): boolean {
  return !!w && !w.finished;
}

/**
 * **压缩中按停止**（/compact 那一轮已经结束、压缩还在后台跑）：放弃等待 —— 照常放行排队的消息（同超时）。
 * 那一轮还在跑的交给普通的停止（一轮被停 → `noteCompactTurnEnd` ok=false）；已经压完的不动。
 */
export function stopCompactWait(w: CompactWait, now: number): CompactWait {
  if (!compactHolds(w) || !w.turnEnded) return w;
  return { ...w, finished: { at: now, by: 'stopped' } };
}

/** 没等到压完就放行了（超时 / 你按了停止）：压缩可能还在后台跑，之后迟到的骤降照样会来。 */
export function releasedBeforeDone(by: CompactFinishedBy | null | undefined): boolean {
  return by === 'timeout' || by === 'stopped';
}

/**
 * /compact 那一轮结束了。`ok=false`（出错 / 被停）→ 不再等，放行。
 * Claude Code / Codex：同步压缩，一轮结束就是压完了。kiro：这一轮里已经看到骤降就算完了，否则继续等。
 */
export function noteCompactTurnEnd(
  w: CompactWait,
  f: { engine: CompactEngine | undefined | null; ok: boolean; now: number; messageId?: string; replyTo?: string },
): CompactWait {
  const next: CompactWait = { ...w, turnEnded: true, ...(f.messageId ? { messageId: f.messageId } : {}), ...(f.replyTo ? { replyTo: f.replyTo } : {}) };
  if (next.finished) return next;
  if (!f.ok) return { ...next, finished: { at: f.now, by: 'error' } };
  if (f.engine === 'claude' || f.engine === 'codex') return { ...next, finished: { at: f.now, by: 'sync' } };
  if (w.droppedDuringTurn) return { ...next, finished: { at: f.now, by: 'drop' } };
  return next;
}

/**
 * 一帧用量。`pct` = 这一帧报的占用（不是用量帧 = null）。压缩那一轮还没结束时只看骤降（花费照旧算那一轮的），
 * 结束之后的帧（含压缩的花费）攒进 `acc`，直到收尾（`settleCompactWait`）。主进程只在会话没在跑新一轮时喂这里。
 */
export function noteCompactUsage(w: CompactWait, update: unknown, pct: number | null, now: number, costFold?: { turn: number; total: number; currency: string } | null): CompactWait {
  let next = w;
  if (w.turnEnded && !w.settled) next = { ...next, acc: foldTurnFrame(w.acc, update, costFold ?? null) };
  if (pct === null || !Number.isFinite(pct)) return next;
  /*
    发 /compact 时还不知道占用（这个执行器上还没收到过读数，例如刚打开就点了压缩）：第一次读数当基准 ——
    不然永远判不出骤降，每次都要白等满 3 分钟（真机截图那次日志 `pct=?->90`）。
  */
  if (w.pctBefore === null) return { ...next, pctBefore: pct, pctAfter: pct };
  next = { ...next, pctAfter: pct };
  if (next.finished || !isCompactDrop(w.pctBefore, pct)) return next;
  if (!w.turnEnded) return { ...next, droppedDuringTurn: true };
  return { ...next, finished: { at: now, by: 'drop' } };
}

/**
 * kiro 自己的压缩状态通知 `_kiro.dev/compaction/status`（kiro-cli 里 `Received compaction event` 之后发；
 * 字段名没有公开文档，从 kiro-cli 二进制里只确认了通知名和「compaction completed successfully / failed」这几种结果）——
 * 宽松地读：status / state / phase / type / event 里的字样。认不出来 → null（不靠它，照旧看骤降 / 超时）。
 */
export function compactionStatusOf(update: any): 'started' | 'completed' | 'failed' | null {
  if (!update || update.method !== '_kiro.dev/compaction/status') return null;
  const words = [update.status, update.state, update.phase, update.type, update.event, update.result]
    .filter((v) => typeof v === 'string').join(' ');
  if (/fail|error|cancel|abort/i.test(words)) return 'failed';
  if (/complet|success|succeed|done|finish|end/i.test(words)) return 'completed';
  if (/start|begin|progress|running|compacting/i.test(words)) return 'started';
  return null;
}

/** kiro 报了压缩完成 / 失败：放行（完成 = 和骤降一样算压完；失败 = 不再等）。开始 / 认不出 → 不变。 */
export function noteCompactNotice(w: CompactWait, status: 'started' | 'completed' | 'failed' | null, now: number): CompactWait {
  if (w.finished || !status || status === 'started') return w;
  /* /compact 那一轮还没结束：完成先记着，一轮结束时算完成（同「这一轮里就看到骤降」）；失败交给那一轮自己的结果 */
  if (!w.turnEnded) return status === 'completed' ? { ...w, droppedDuringTurn: true } : w;
  return { ...w, finished: { at: now, by: status === 'completed' ? 'notice' : 'error' } };
}

/** 这一帧是不是一轮的**输出**（正文 / 思考 / 工具调用）—— 下一轮出了输出，压缩的花费归属就关上（见 `settled`）。 */
export function isTurnOutputUpdate(update: any): boolean {
  const su = String(update?.sessionUpdate ?? '');
  return su === 'agent_message_chunk' || su === 'agent_thought_chunk' || su === 'agent_reasoning_chunk' || su === 'tool_call' || su === 'tool_call_update';
}

/** 关上花费归属：之后的帧不再算压缩的。返回攒下的用量（交给 `finishTurnUsage`）。 */
export function settleCompactWait(w: CompactWait): { wait: CompactWait; acc: TurnUsageAcc | undefined } {
  if (w.settled) return { wait: w, acc: undefined };
  return { wait: { ...w, settled: true }, acc: w.acc };
}

/** 到点了没等到完成信号：放行。 */
export function expireCompactWait(w: CompactWait, now: number): CompactWait {
  if (w.finished || now - w.startedAt < COMPACT_WAIT_MAX_MS) return w;
  return { ...w, finished: { at: now, by: 'timeout' } };
}

/**
 * 排这一次压缩的 3 分钟超时。到点时对**当前**状态做超时处理（`get()` 拿的是此刻的那份，不是排定时器时那份）；
 * 已经换成别的批次（又发了一次 /compact）或者已经完成了 → 什么都不做。主进程 `beginCompactWait` 用它。
 */
export function armCompactTimeout<T>(d: {
  batch: number;
  startedAt: number;
  get: () => CompactWait | undefined;
  set: (w: CompactWait) => void;
  onExpired: () => void;
  /** 到点时这条会话上**已经没有**压缩状态了（执行器断线 / 摘掉，状态没被收掉）：交给调用方收尾（放行在等的发送、告诉界面）。可选。 */
  onGone?: () => void;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => T;
}): T {
  return d.setTimer(() => {
    const cur = d.get();
    if (!cur) { d.onGone?.(); return; }
    if (cur.batch !== d.batch || !compactHolds(cur)) return;
    d.set(expireCompactWait(cur, Math.max(d.now(), cur.startedAt + COMPACT_WAIT_MAX_MS)));
    d.onExpired();
  }, Math.max(0, COMPACT_WAIT_MAX_MS - (d.now() - d.startedAt)) + 50);
}

/** 还要等多久超时（排定时器用）。 */
export function compactWaitRemainingMs(w: CompactWait, now: number): number {
  return Math.max(0, COMPACT_WAIT_MAX_MS - (now - w.startedAt));
}

/** 日志行（scope `context`）。 */
export function compactStartedLine(sessionId: string): string {
  return `compacting sessionId=${sessionId} started`;
}
export function compactFinishedLine(sessionId: string, w: CompactWait): string {
  const a = w.pctBefore === null ? '?' : String(Math.round(w.pctBefore));
  const b = typeof w.pctAfter === 'number' ? String(Math.round(w.pctAfter)) : '?';
  const secs = Math.round(((w.finished?.at ?? w.startedAt) - w.startedAt) / 1000);
  const by = w.finished?.by ?? 'drop';
  if (by === 'stopped') return `compacting sessionId=${sessionId} stopped by user after ${secs}s (pct=${a}->${b}) — releasing queued prompts`;
  return by === 'timeout'
    ? `compacting sessionId=${sessionId} timed out after ${secs}s without a completion signal (pct=${a}->${b}) — releasing queued prompts`
    : `compacting sessionId=${sessionId} finished pct=${a}->${b} after ${secs}s${by === 'drop' ? '' : ` (${by})`}`;
}

/**
 * 压缩的花费补记到压缩那一条上：transcript 只追加，所以写一行**补记**（`usageForMessageId`），
 * 读的时候（`transcriptParse.parseTranscriptLine`）并进那条助手消息的 `turnUsage`，这一行本身不显示。
 */
export function compactUsagePatch(messageId: string, turnUsage: object, now: number): { id: string; role: 'assistant'; content: ''; ts: number; usageForMessageId: string; turnUsage: object } {
  return { id: `usage_${messageId}_${now}`, role: 'assistant', content: '', ts: now, usageForMessageId: messageId, turnUsage };
}

/**
 * 自动压缩做完在会话里留哪一句（渲染端 App 的自动压缩）：**只有主进程确认压完了**（骤降 / 同步引擎一轮结束）才说「已压缩」；
 * 3 分钟没等到完成信号说「没确认完成、排着的消息照常发了」；/compact 那一轮出错、或者一直没收到结果，说没成功；
 * 你按停止放弃了等待（stopped）不留话。
 */
export type CompactFinishedBy = NonNullable<CompactWait['finished']>['by'];
export function autoCompactNoteKind(finishedBy: CompactFinishedBy | null | undefined, turnOk: boolean): 'done' | 'unconfirmed' | 'failed' | 'stopped' {
  if (!turnOk) return 'failed';
  /* 你自己按停止放弃了等待：不说已压缩、也不说失败 */
  if (finishedBy === 'stopped') return 'stopped';
  if (finishedBy === 'drop' || finishedBy === 'notice' || finishedBy === 'sync') return 'done';
  if (finishedBy === 'timeout') return 'unconfirmed';
  return 'failed';
}

/**
 * **一帧更新怎么走**（主进程 `wireSession` 每一帧调一次，`tests/compactWait.test.ts` 按真实顺序喂帧测）：
 *   - `close`：放行之后、下一轮**出了输出**（这一帧就是）→ 先关上压缩的花费归属（主进程 `settleCompactUsage` 写最后一次补记），
 *     这一帧算新一轮的；
 *   - 否则归属还开着：`wait` 是更新后的状态；`toCompact` = 这一帧的用量记在压缩那边、**不进**正在跑的那一轮
 *     （/compact 那一轮自己的帧照旧算那一轮）；`released` = 这一帧让压缩完成了（放行排着的消息）；
 *     `costGrew` = 放行之后又来了压缩的花费（更新补记）。
 */
export function routeCompactFrame(
  w: CompactWait | undefined,
  f: { inTurn: boolean; update: unknown; pct: number | null; now: number; costFold?: { turn: number; total: number; currency: string } | null },
): { close: boolean; wait?: CompactWait; toCompact: boolean; released: boolean; costGrew: boolean; settleAfter: boolean } {
  const none = { close: false, toCompact: false, released: false, costGrew: false, settleAfter: false };
  if (!w) return none;
  /* 花费归属已经关了、也不在挡消息：和压缩无关了 */
  if (w.settled && !compactHolds(w)) return none;
  if (!w.settled && w.turnEnded && f.inTurn && isTurnOutputUpdate(f.update)) return { ...none, close: true };
  const wasHolding = compactHolds(w);
  const costOpen = w.turnEnded && !w.settled;
  const costBefore = compactCostOf(w.acc);
  /* 归属关了（压缩那一笔已经到了）但还在等骤降 / 完成通知：noteCompactUsage 不再往 acc 里记，只看完成信号 */
  let wait = noteCompactUsage(w, f.update, f.pct, f.now, f.costFold ?? null);
  wait = noteCompactNotice(wait, compactionStatusOf(f.update), f.now);
  const grew = costOpen && compactCostOf(wait.acc) > costBefore;
  return {
    close: false,
    wait,
    toCompact: costOpen,
    released: wasHolding && !!wait.finished,
    costGrew: !wasHolding && grew,
    /*
      **压缩的计量只有一帧**（kiro-cli：压缩完成后单独发一帧 `metadata after compaction`；一轮的计量在那一轮结尾发）——
      /compact 那一轮结束之后收到第一笔花费，就是压缩的那一笔：记上、马上关上归属。之后的计量（哪怕下一轮一个字没出就结束了）
      都是下一轮自己的（审查：原来下一轮无输出时它的 0.9 也被算进压缩，变成 12.4）。
    */
    settleAfter: grew,
  };
}

/**
 * **执行器要摘掉了**（断线 / detach / 重连 / 换模型前先拿下，主进程 `endCompactWaitForExecutor`）：它身上的压缩怎么收。
 * `clear` = 停定时器、清掉状态（已经压完的也清：花费归属跟着旧进程一起结束）；
 * `abandon` = 还在压缩中、或者还有发送在等它 → 作废：放行在等的发送（接着走「没连着」那条恢复路）、告诉界面不再压缩中。
 */
export function compactOnExecutorGone(w: CompactWait | undefined, hasWaiters: boolean): { clear: boolean; abandon: boolean } {
  return { clear: !!w, abandon: compactHolds(w) || hasWaiters };
}
