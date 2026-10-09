/**
 * 钉住的会话「全部做完 / 出错停下」时发系统通知 —— 判定部分，纯逻辑,PURE。
 *
 * 「做完」指的是**真正闲下来**：这一轮结束、排队的消息全部发完处理完、没在等用户点「允许」。
 * 所以排队里还有消息时中间每一轮结束都不算；同一次闲置只发一条。
 *
 * 为什么要等 `IDLE_SETTLE_MS` 才算数：排队的下一条从「出队」到「开始流式」中间要先读记录、
 * 等执行器连上，这段时间里各个状态看起来都是闲的。不等一下，三条排队消息会在交接处弹出
 * 中间那几条通知。
 *
 * 窗口是不是用户正在看的，渲染端不判断 —— 那是主进程的事（`src/main/idleNotice.ts`）。
 */
import { t, type Lang } from './i18n.ts';

export const IDLE_SETTLE_MS = 1500;

/** 一条会话最后一轮是怎么结束的。新的一轮开始时回到 `ok`。 */
export type TurnOutcome =
  | { kind: 'ok' }
  | { kind: 'error'; message: string }
  /** 用户自己点了停止 / 取消 —— 这种停下不发通知 */
  | { kind: 'cancelled' };

export interface IdleSnapshot {
  pinned: boolean;
  /** 在流式 / 队列非空 / 队列那条正在发 / 后端被占 / 自动重发中 / 循环中 —— 任何一个都算忙 */
  busy: boolean;
  /** 卡在等用户点「允许」 */
  awaitingPermission: boolean;
  outcome: TurnOutcome;
}

export interface IdleTrack {
  /** 上次发通知（或启动）之后忙过 —— 只有忙过的会话闲下来才值得说一声 */
  armed: boolean;
  /** 从什么时候开始一直是闲的；忙的时候是 null */
  idleSince: number | null;
}

export type IdleNotice = { kind: 'done' } | { kind: 'error'; summary: string };

export interface IdleDecision {
  track: IdleTrack;
  notify: IdleNotice | null;
  /** 还在等稳定：多少毫秒后再查一次。null = 不需要再查 */
  recheckInMs: number | null;
}

const RESTING: IdleTrack = { armed: false, idleSince: null };

export function stepIdle(prev: IdleTrack | undefined, snap: IdleSnapshot, now: number): IdleDecision {
  if (snap.busy || snap.awaitingPermission) {
    return { track: { armed: true, idleSince: null }, notify: null, recheckInMs: null };
  }
  if (!prev?.armed) return { track: RESTING, notify: null, recheckInMs: null };
  const since = prev.idleSince ?? now;
  const waited = now - since;
  if (waited < IDLE_SETTLE_MS) {
    return { track: { armed: true, idleSince: since }, notify: null, recheckInMs: IDLE_SETTLE_MS - waited };
  }
  // 稳定下来了：这一次闲置到此为止，不管发不发都不再发第二次。
  if (!snap.pinned || snap.outcome.kind === 'cancelled') return { track: RESTING, notify: null, recheckInMs: null };
  const notify: IdleNotice = snap.outcome.kind === 'error'
    ? { kind: 'error', summary: summarizeError(snap.outcome.message) }
    : { kind: 'done' };
  return { track: RESTING, notify, recheckInMs: null };
}

const SUMMARY_MAX = 120;

/** 错误摘要：去掉开头的 ⚠️、压成一行、过长截断 —— 通知里放不下一整段堆栈 */
export function summarizeError(message: string | null | undefined): string {
  const flat = String(message ?? '').replace(/^\s*⚠️?\s*/u, '').replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

export function idleNoticeBody(lang: Lang, notice: IdleNotice): string {
  if (notice.kind === 'done') return t(lang, 'Finished');
  return notice.summary
    ? t(lang, 'Stopped with an error: {error}', { error: notice.summary })
    : t(lang, 'Stopped with an error');
}
