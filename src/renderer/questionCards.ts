/**
 * 提问卡片（模型向用户的提问，`main/elicitation.ts`）在消息列表里放在哪、怎么更新 —— PURE。
 *
 * 一张卡片 = 一条 `role:'assistant'`、正文为空、带 `question` 的消息，它是这一轮回复气泡里的一段。
 *
 * ## 放在这一轮的**开头**（这一轮的用户消息 / 追加指令后面，回复正文前面）
 *
 * 盘上就是这个顺序：卡片关掉时落盘，这一轮的回复要等这一轮结束才落盘（§7），所以重启后读回来是
 * 「卡片 → 回复」。实时的时候也放在这儿，两边一致；而且不会把流式正文切成两段 —— 正文继续追加在原来那一段上，
 * 一轮结束时主进程发来的权威正文（`acp:assistant-final`）也照旧并进那一段，不会出现半截重复。
 *
 * 更新只按卡片 id 覆盖（主进程是权威：答了 / 跳过 / 取消 / 超时 / 撤回都由它推一份新的过来）。
 */
import type { Message } from './App';
import type { QuestionCard } from '../main/elicitation.ts';

export function isQuestionMessage(m: Pick<Message, 'question'> | null | undefined): boolean {
  return !!m?.question;
}

/** 这一轮（从 `index` 往前到最后一条你发的消息）里有没有提问卡片。 */
export function turnHasQuestion(messages: readonly Pick<Message, 'role' | 'kirolex' | 'steer' | 'question'>[], index: number): boolean {
  for (let i = Math.min(index, messages.length - 1); i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && !m.kirolex && !m.steer) return false;
    if (m.question) return true;
  }
  return false;
}

/**
 * 从 `outgoing` 切到 `next` 时要不要取消 `outgoing` 挂着的提问：真的换了会话、而且它不在分屏里继续显示（看得见的那格还能答）。
 */
export function shouldCancelOnLeave(outgoing: string | null | undefined, next: string, onScreen: ReadonlySet<string>): boolean {
  return !!outgoing && outgoing !== next && !onScreen.has(outgoing);
}

/**
 * 屏幕上的会话集合（分屏各格 + 焦点）变了：哪些会话**不在屏幕上了**。分屏里换掉一格（那一格不是焦点）走的是这条，
 * 不经过 `shouldCancelOnLeave` 的「焦点从它身上移走」。
 */
export function leftScreen(prev: ReadonlySet<string>, next: ReadonlySet<string>): string[] {
  return [...prev].filter((id) => !next.has(id));
}

/** 切走之后等这么久再确认一次「它真的不在屏幕上了」才取消 —— 启动 / 换布局时屏幕集合会短暂抖一下，切走马上又切回来也不算。 */
export const LEAVE_CONFIRM_MS = 1500;

/** 卡片 → 消息（transcript 里也是这个形状：正文空、ts 是提问的时刻）。 */
export function questionMessage(card: QuestionCard): Message {
  return { id: card.id, role: 'assistant', content: '', timestamp: card.askedAt, question: card };
}

/**
 * 插入或覆盖一张卡片。已有同 id 的 → 只换 `question`（位置不动）；没有 → 放在这一轮开头
 * （最后一条用户消息、它的追加指令、紧跟着的 KiroLex 提示和之前的卡片之后）。
 */
export function upsertQuestionCard(messages: Message[], card: QuestionCard): Message[] {
  const at = messages.findIndex((m) => m.id === card.id);
  if (at >= 0) {
    const next = [...messages];
    next[at] = { ...next[at], question: card };
    return next;
  }
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && !m.kirolex && !m.steer) { lastUser = i; break; }
  }
  let i = lastUser + 1;
  while (i < messages.length && (messages[i].role === 'user' || isQuestionMessage(messages[i]))) i++;
  return [...messages.slice(0, i), questionMessage(card), ...messages.slice(i)];
}

/**
 * **画的时候**还挂着的卡片排到这一轮的最下面（在正文和工具块后面）——「选择永远应该在下方」。
 * 只挪画法、不挪数据（上面说的「放在开头」照旧）；答完的卡片回到原位置，读历史时顺序和发生的顺序一致。
 * 返回两组下标：`flow` 按原顺序画，`asks` 画在最后。
 */
export function splitTurnAsks(segments: readonly Pick<Message, 'question'>[]): { flow: number[]; asks: number[] } {
  const flow: number[] = [];
  const asks: number[] = [];
  segments.forEach((s, i) => (s.question?.status === 'pending' ? asks : flow).push(i));
  return { flow, asks };
}

/** 列表里最后一张还挂着的提问卡片的 id（没有就是 null）：ChatArea 拿它决定滚过去还是显示「有待你选择 ↓」 */
export function pendingQuestionId(messages: readonly Pick<Message, 'question'>[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const card = messages[i].question;
    if (card?.status === 'pending') return card.id;
  }
  return null;
}
