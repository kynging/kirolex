/**
 * 一轮之外到达的对话正文要不要丢 —— PURE（`tests/replayGuard.test.ts`）。
 *
 * 「远程（graviton）新建会话界面仍出现历史会话内容」：盘上 0 条、`tail` 0 条，界面上却是一大段历史。
 * 主进程原来把执行器发来的**每一条** `session/update` 都转给渲染层，不管这条会话此刻有没有在跑一轮；
 * 渲染层对「没在流式」的会话一律把正文块写进它的消息缓存（`commitBackgroundMessages`），
 * 下一次 `switchSession` 就把这份缓存画出来。KiroLex 自己发起的 prompt 只有两种 —— 用户这一轮
 * （`sendPromptOnce`，先置 `busy`）和重建历史（`priming`，前面已经整段吞掉）—— 所以**不在一轮里**
 * 收到的 `user_message_chunk` / `agent_message_chunk` / 思考块，只能是后端自己回放的旧对话
 * （`session/load` / 远端 kiro-cli 按目录或按 id 恢复出来的那段，ACP 规定回放就是这几种块），
 * 不是这条会话这一刻的消息。它们既不能显示成本会话的消息，也不能进 `assistantBuf`
 * （否则下一轮结束时会被当成回复的开头写进 transcript）。
 *
 * 只认正文这几种：命令表（`_kiro.dev/commands/available`）、subagent 名册、plan、权限请求这些不是消息，
 * 一轮之外照常转发。
 */
const MESSAGE_CHUNKS = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'agent_reasoning_chunk',
]);

export function isReplayOutsideTurn(update: { sessionUpdate?: unknown } | null | undefined, inTurn: boolean): boolean {
  if (inTurn) return false;
  return MESSAGE_CHUNKS.has(String(update?.sessionUpdate ?? ''));
}
