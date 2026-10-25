/**
 * 一轮结束时主进程发来的**权威**回复（`acp:assistant-final`）怎么并进界面上那条助手消息。
 *
 * 两件事：
 *   1. 正文：界面可能漏收尾部几块，比主进程的短就换成完整的；比它长就不动（never shrink）。
 *   2. `toolTailFrom`（这一轮最后一次真实工具调用开始时正文的长度，见 `main/textToolCall.ts`）：
 *      正文一样也要更新 —— 实时那一轮的工具调用只并进 `toolCalls`，界面原来不知道它发生在正文的哪个位置，
 *      于是「先写了 invoke 标记、随后真的调了工具、之后没再写字」那一轮会被标成「未执行」，直到从盘上重新读回来。
 *      界面这条消息只是完整正文的一段时，换算成这一段里的位置。
 *
 * 纯函数：返回新的字段，没有变化就返回 null。
 */
import type { Message } from './App';
import { isQuestionMessage } from './questionCards.ts';

export function mergeAssistantFinal(
  msg: { content: string; toolTailFrom?: number },
  text: string,
  toolTailFrom?: number,
): { content: string; toolTailFrom?: number } | null {
  const content = text.length >= msg.content.length ? text : msg.content;
  let tail = msg.toolTailFrom;
  if (typeof toolTailFrom === 'number' && toolTailFrom > 0) {
    if (content === text) tail = toolTailFrom;
    /* 界面这条比主进程的长（never shrink，保留界面的）—— 主进程的正文是它的开头一段：位置不变 */
    else if (content.startsWith(text)) tail = toolTailFrom;
    /* 主进程的正文是它的结尾一段：位置往后挪过前面多出来的那段 */
    else if (content.endsWith(text)) tail = toolTailFrom + (content.length - text.length);
    /* 对不上：宁可不标「未执行」（主进程那边已经按完整正文判过了） */
    else tail = content.length;
  }
  if (content === msg.content && tail === msg.toolTailFrom) return null;
  return { content, ...(typeof tail === 'number' ? { toolTailFrom: tail } : {}) };
}

type TurnMsg = Pick<Message, 'id' | 'role' | 'content' | 'toolTailFrom' | 'question' | 'kirolex' | 'steer'>;

/** 这一轮回复正文的一段（💭 思考段、提问卡片、KiroLex 提示都不算） */
const isReplySegment = (m: TurnMsg) => m.role === 'assistant' && !m.content.startsWith('💭 ') && !isQuestionMessage(m) && !m.kirolex;
/** 一轮的边界：你发的消息（追加指令 / KiroLex 提示不算） */
const isTurnBoundary = (m: TurnMsg) => m.role === 'user' && !m.kirolex && !m.steer;

/**
 * 把权威正文（主进程这一轮攒的**整份**，`acp:assistant-final`）并进界面上这一轮的回复 —— 按段并。
 *
 * **为什么按段**：界面上一轮可能被思考块（💭）切成好几段（`liveReply.appendAgentText`），主进程却把所有正文攒成一份、
 * 用第一个 messageId 落盘。原来只按 id 找到第一段、"比它长就整份换上"，于是后面几段的字又在第一段里出现一遍
 * （Codex：commentary → 思考 → final_answer，final_answer 显示两遍，盘上只有一份；`tests/codexDuplicateReply.test.ts`）。
 *
 * 规则：
 *   · 主进程给了每段的起点（`segmentBreaks`，`main/replySegments.ts`）、段数也对得上 → 每段直接换成权威正文里属于它的那一截：
 *     哪一段漏收了块（开头、中间、结尾都一样）都补回来，界面和盘上一字不差；
 *   · 没给 / 段数对不上：从 id 对上的那一段起（对不上就在这一轮里找）到最后，几段拼起来是权威正文的开头 → 只把缺的尾巴补到最后一段；
 *     权威正文是它的开头 → 正文不动（never shrink）。几段拼起来对不上 → 正文不动（宁可少一点，也不显示两遍）。
 *   · 只有一段 → 和原来一样（`mergeAssistantFinal`）。
 * `toolTailFrom`（整份正文里的位置）换算到它落在的那一段；它前面的段整段都在最后一次工具调用之前。
 *
 * 返回 `{ list, idx }`：`idx` 是去重标记挂的那一条（和原来一样：id 对上的，否则最后一条助手消息）；没变化时 `list` 原样返回。
 * 没有可并的消息 → null。
 */
export function mergeAssistantFinalIntoTurn<T extends TurnMsg>(
  list: T[],
  messageId: string,
  text: string,
  toolTailFrom?: number,
  segmentBreaks?: readonly number[],
): { list: T[]; idx: number } | null {
  let idx = list.findIndex((m) => m.id === messageId);
  const byId = idx >= 0;
  if (!byId) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'assistant' && !list[i].content.startsWith('💭 ') && !isQuestionMessage(list[i])) { idx = i; break; }
    }
  }
  if (idx < 0) return null;

  let segs: number[] = [];
  if (byId) {
    for (let i = idx; i < list.length && (i === idx || !isTurnBoundary(list[i])); i++) if (isReplySegment(list[i])) segs.push(i);
  } else {
    let from = list.length - 1;
    while (from > 0 && !isTurnBoundary(list[from - 1])) from--;
    for (let i = from; i < list.length; i++) if (isReplySegment(list[i])) segs.push(i);
  }
  if (byId && segs[0] !== idx) segs = [];

  const single = () => {
    const merged = mergeAssistantFinal(list[idx], text, toolTailFrom);
    if (!merged) return { list, idx };
    const next = [...list];
    next[idx] = { ...next[idx], ...merged };
    return { list: next, idx };
  };
  if (segs.length < 2) return single();

  /* 把这几段的正文换成 `contents`，再把 toolTailFrom（整份正文里的位置）换算到它落在的那一段 */
  const apply = (run: number[], contents: string[]) => {
    const next = [...list];
    run.forEach((i, k) => { if (next[i].content !== contents[k]) next[i] = { ...next[i], content: contents[k] }; });
    const last = run[run.length - 1];
    if (typeof toolTailFrom === 'number' && toolTailFrom > 0) {
      let start = 0;
      for (const i of run) {
        const len = next[i].content.length;
        if (toolTailFrom <= start + len || i === last) {
          const tail = Math.min(toolTailFrom - start, len);
          if (next[i].toolTailFrom !== tail) next[i] = { ...next[i], toolTailFrom: tail };
          break;
        }
        start += len;
      }
    }
    const changed = next.some((m, i) => m !== list[i]);
    return { list: changed ? next : list, idx };
  };

  /* 主进程给了切点：按段切开权威正文，一段对一段（界面每段只会比它那一截少，不会多 —— 多了就不信它，走下面） */
  const cuts = segmentBreaks?.length ? [0, ...segmentBreaks, text.length] : null;
  if (cuts && cuts.every((c, k) => k === 0 || c >= cuts[k - 1]) && segs.length >= segmentBreaks!.length + 1) {
    const run = byId ? segs : segs.slice(segs.length - segmentBreaks!.length - 1);
    if (run.length === segmentBreaks!.length + 1) {
      const slices = run.map((_, k) => text.slice(cuts[k], cuts[k + 1]));
      if (run.every((i, k) => slices[k].length >= list[i].content.length)) return apply(run, slices);
    }
  }

  /* id 对上：只认从它起的那几段；对不上：从最早的一段往后试，第一组能和权威正文对上的 */
  const starts = byId ? [0] : segs.map((_, k) => k).slice(0, -1);
  for (const k of starts) {
    const run = segs.slice(k);
    const joined = run.map((i) => list[i].content).join('');
    if (!text.startsWith(joined) && !joined.startsWith(text)) continue;
    const contents = run.map((i) => list[i].content);
    if (text.length > joined.length) contents[contents.length - 1] += text.slice(joined.length);
    return apply(run, contents);
  }
  if (byId) return { list, idx };
  return single();
}
