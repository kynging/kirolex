/**
 * 一轮回复在界面上被切成了几段、每段从整份正文（`assistantBuf`）的哪里开始 —— PURE。
 *
 * 界面（`renderer/liveReply.ts`）的规则：正文追加到最后一条助手消息上，除非它是 💭 思考段 —— 思考之后再来的正文新开一条。
 * 主进程按同一条规则记下"新开一段"那一刻 `assistantBuf` 的长度（第一段从 0 开始，不记），一轮结束时随
 * `acp:assistant-final` 一起发过去：界面就能把权威正文**按段**切开、一段一段对上（`assistantFinal.mergeAssistantFinalIntoTurn`），
 * 中间哪一段漏收了几块也能补回来，不用猜。
 *
 * `bufLen` 是这一块并进 `assistantBuf` **之前**的长度。`assistantBuf` 清空过（落盘 / 重发）之后的第一块正文把旧的切点一起清掉。
 */
export interface ReplySegments {
  /** 第 2、3…段在整份正文里的起点 */
  breaks: number[];
  /** 上一块正文之后来过非空的思考块 */
  afterThought: boolean;
}

export function trackReplySegments(seg: ReplySegments | undefined, update: any, bufLen: number): ReplySegments | undefined {
  const kind = update?.sessionUpdate;
  if (kind === 'agent_thought_chunk' || kind === 'agent_reasoning_chunk') {
    /* 界面只为非空的思考块开 💭 段（useAcp：`if (!text) break`） */
    if (!update?.content?.text) return seg;
    return { breaks: seg?.breaks ?? [], afterThought: true };
  }
  if (kind !== 'agent_message_chunk') return seg;
  const breaks = bufLen === 0 ? [] : [...(seg?.breaks ?? [])];
  if (seg?.afterThought && bufLen > 0) breaks.push(bufLen);
  return { breaks, afterThought: false };
}
