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
