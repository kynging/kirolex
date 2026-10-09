/**
 * "THE PREVIOUS TURN IS STILL WRAPPING UP" — WHAT TO DO ABOUT IT. PURE.
 *
 * A reload or an app restart does not stop a turn. Main owns the ACP connection: it keeps
 * accumulating the reply in `assistantBuf` and flushes the complete text to the transcript when
 * the turn ends (`flushAssistant`). What breaks is only the renderer's belief -- it comes back
 * knowing nothing about streams in progress, sees a user message with no answer under it, and
 * concluded the turn was interrupted.
 *
 * The old conclusion was to WAIT for the backend to go idle and then RESEND the question. That
 * pays for the same answer twice and can produce two replies to one question: the first turn was
 * never lost, it was merely unobserved.
 *
 * So: ask main whether a turn is live, and if it is, ADOPT it -- take ownership of the stream
 * that is already running. Resending stays the answer for the case it was actually written for:
 * a turn that really did die (killed process, crashed executor) and left a question unanswered.
 *
 * This module is the decision and the painting, kept out of the hook because every wrong branch
 * costs either a duplicate billable turn or a question that is never answered.
 */

import { isKirolexNote } from '../main/kirolexNote.ts';

/** What main can tell us about a session's in-flight turn. */
export interface TurnPeek {
  /** Is a turn running right now for this session? */
  live: boolean;
  /** The id main will use when it flushes, so an adopted bubble can be patched by
   *  `acp:assistant-final` rather than guessed at by position. */
  messageId: string | null;
  /** What the turn has produced SO FAR. May be empty for a turn seconds old. */
  text: string;
  startedAt: number | null;
}

export type RecoveryAction =
  /** Take over the running stream: paint what it has produced and mark the chat streaming. */
  | { action: 'adopt'; messageId: string | null; text: string }
  /** The turn is gone and the question is unanswered: send it again. */
  | { action: 'resend' }
  /** Busy with something that is not a turn (attach, history rebuild, compaction). Prompting
   *  into it is rejected by the backend, so hold. */
  | { action: 'wait' }
  | { action: 'stand-down'; reason: string };

export interface RecoveryInput {
  /** Null when main cannot be asked (IPC absent) -- then never adopt. */
  peek: TurnPeek | null;
  busyReason: string | null;
  /** Does the RENDERER already think it is streaming this chat? */
  streaming: boolean;
  /** The user called the recovery off. */
  cancelled: boolean;
  /** The user switched OFF "重启后自动重发未完成的提问". Gates the resend only: that setting is
   *  about spending turns, and adoption spends none -- it shows an answer already paid for. */
  resendDisabled?: boolean;
  attempts: number;
  maxAttempts: number;
}

/** Busy reasons that are not a conversation turn and cannot be adopted or prompted into. */
const NON_TURN_BUSY = new Set(['attaching', 'priming', 'prime-pending', 'reconfiguring', 'compacting']);

export function decideTurnRecovery(input: RecoveryInput): RecoveryAction {
  const { peek, busyReason, streaming, cancelled, resendDisabled, attempts, maxAttempts } = input;

  if (cancelled) return { action: 'stand-down', reason: 'cancelled' };
  // Already on screen as a live stream: there is nothing to recover, and adopting would
  // re-seed a bubble the chunk handler is actively appending to.
  if (streaming) return { action: 'stand-down', reason: 'already streaming' };

  // ADOPTION COMES FIRST, and is checked before the attempt budget on purpose: that budget
  // bounds RESENDS (each one costs a turn). Adoption costs nothing -- it observes work already
  // paid for -- so a chat reloaded many times mid-turn must not run out of recoveries.
  if (peek?.live) return { action: 'adopt', messageId: peek.messageId, text: peek.text };

  if (resendDisabled) return { action: 'stand-down', reason: 'auto-resend switched off' };
  if (attempts >= maxAttempts) return { action: 'stand-down', reason: 'attempt budget spent' };
  if (busyReason && NON_TURN_BUSY.has(busyReason)) return { action: 'wait' };
  return { action: 'resend' };
}

/** The renderer's message shape, narrowed to what painting needs. NO index signature: the
 *  renderer's own `Message` has none, and requiring one here made this module unusable from the
 *  very hook it exists for. */
interface Msg {
  id: string;
  role: string;
  content: string;
  timestamp: number;
}

/**
 * Paint an adopted turn's partial output into the transcript.
 *
 * Idempotent, because it runs on adoption AND can run again on a later peek: the same turn must
 * extend one bubble rather than accumulate several.
 */
export function adoptedMessages<T extends Msg>(msgs: T[], peek: TurnPeek): T[] {
  if (!peek.live || !peek.text) return msgs;      // nothing to show yet
  const last = msgs[msgs.length - 1];

  // Same turn, already painted: extend it. NEVER shrink -- chunks that land between a peek and
  // the state update are dropped by the chunk handler (it gates on `streamingIds`), so the
  // buffer can legitimately be behind what is on screen.
  if (last && peek.messageId && last.id === peek.messageId) {
    if (peek.text.length <= last.content.length) return msgs;
    return [...msgs.slice(0, -1), { ...last, content: peek.text }];
  }

  // A completed reply is already there: leave it alone. The caller checks this too; a second
  // bubble under a finished turn would be the hardest failure here to explain.
  if (last && last.role === 'assistant' && !last.content.startsWith('💭 ')) return msgs;

  // Under the question, or after a live-only 💭 thinking segment (reply text starts a fresh
  // message -- same rule the chunk handler follows).
  // Built from nothing, NOT spread from `last`: spreading copied the user message's own fields
  // into the reply -- `steer` among them, which is what the recovery walk-back reads to find a
  // turn's base message, and `attachments`, which would re-render the user's files under the
  // answer.
  const seeded = {
    id: peek.messageId || `a_adopted_${peek.startedAt ?? 0}`,
    role: 'assistant',
    content: peek.text,
    timestamp: peek.startedAt ?? (last?.timestamp ?? 0),
  } as unknown as T;
  return [...msgs, seeded];
}

/**
 * 这一轮是不是侧栏 review 发的**改写**（`askOnce` 的显示文本都以「【改写」开头）—— PURE。
 *
 * 「这个功能中断的话不要让 kirolex 做回填」：改写那一轮被取消 / 卡死 / 窗口重载打断之后，它的那条
 * 用户消息就成了"没答完的提问"，自动重发和自动续写都会把它当普通问题再发一遍 —— 可那一轮的回复
 * 本该由 KiroLex 接住、拼回文件，重发出去的那轮没有人等，模型只能自己动手改文件（正是改写这条路要避免的
 * 两个写者）。所以这种轮次中断了就停在那儿：要改，回到侧栏再按一次「✓ 确认」。
 */
export function isReviseRequest(text: string | null | undefined): boolean {
  return /^【改写/.test(String(text ?? '').trim());
}

/** 往回找没答的提问时要看的那几样（渲染进程的 `Message` 收窄成这些）。 */
interface RecoveryMsg {
  role: string;
  content: string;
  steer?: 'pending' | 'consumed';
  kirolex?: boolean;
}

/** 一轮里**已经被模型吃进去的** steer，接在基础那条后面一起重发 —— PURE。
 *  KiroLex 自己的提示（`isKirolexNote`）夹在中间时跳过，不拼进去。 */
export function consumedSteersText(msgs: RecoveryMsg[], baseIndex: number): string {
  const parts = [msgs[baseIndex]?.content || ''];
  for (let j = baseIndex + 1; j < msgs.length && msgs[j].role === 'user' && (msgs[j].steer || isKirolexNote(msgs[j])); j++) {
    if (isKirolexNote(msgs[j])) continue;
    if (msgs[j].steer === 'consumed' && msgs[j].content.trim()) parts.push(msgs[j].content);
  }
  return parts.filter((p) => p.trim()).join('\n');
}

export type RecoveryTarget =
  /** 没有可续跑的东西（空记录、只有提示、基础那条是空的…）。 */
  | { kind: 'none' }
  /** 最后一条实打实的消息是助手回复：这一轮答完了（调用方仍要 peek 一下是不是还在跑）。 */
  | { kind: 'answered' }
  /** 没答的提问：`base` 是这一轮的基础那条，`text` 是要重发的内容。 */
  | { kind: 'unanswered'; base: number; text: string };

/**
 * 重启 / 刷新后，这条会话最后是不是一个没答的提问 —— PURE。
 *
 * 往回找时跳过助手的 `💭 ` 思考段，也跳过 **KiroLex 自己的提示**（noteInSession 以
 * `role:'user', kirolex:true` 落盘，例如「✅ 已按意见改了…」）：那是对你说的话，不是你的提问；
 * 原来不跳，刷新后就把它当新 prompt 发给了模型。
 */
export function findRecoveryTarget(msgs: RecoveryMsg[], opts?: { interrupted?: boolean }): RecoveryTarget {
  const thinking = (m: RecoveryMsg) => m.role === 'assistant' && m.content.startsWith('💭 ');
  let i = msgs.length - 1;
  while (i >= 0 && (thinking(msgs[i]) || isKirolexNote(msgs[i]))) i--;
  /* 中途死掉的那一轮可能已经吐了半截回复：那不是"答完了"，重跑这一轮 */
  if (opts?.interrupted) while (i >= 0 && (msgs[i].role === 'assistant' || isKirolexNote(msgs[i]))) i--;
  if (i < 0) return { kind: 'none' };
  if (msgs[i].role !== 'user') return { kind: 'answered' };
  // Anchor to the turn's BASE user message (steers are merged into it on disk, separate in memory).
  let base = i;
  while (base > 0 && (msgs[base].steer || isKirolexNote(msgs[base]))) base--;
  const target = msgs[base];
  if (target.role !== 'user' || isKirolexNote(target) || !target.content.trim()) return { kind: 'none' };
  return { kind: 'unanswered', base, text: consumedSteersText(msgs, base) };
}

/**
 * 插话（steer）放在哪 —— PURE。紧跟这一轮**基础那条**提问（和它前面已有的 steer）后面，
 * 也就是这一轮所有助手 / 工具段之前。找基础那条时跳过 KiroLex 自己的提示：它也是 `role:'user'`，
 * 不跳的话 steer 会落在提示后面、和基础那条之间隔着助手回复，中断续跑时就把它漏掉了。
 * 返回 -1 = 没有基础那条（接在最后）。
 */
export function steerInsertIndex(msgs: RecoveryMsg[]): number {
  let baseIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && !msgs[i].steer && !isKirolexNote(msgs[i])) { baseIdx = i; break; }
  }
  if (baseIdx < 0) return -1;
  let insertAt = baseIdx + 1;
  while (insertAt < msgs.length && msgs[insertAt].role === 'user' && msgs[insertAt].steer) insertAt++;
  return insertAt;
}
