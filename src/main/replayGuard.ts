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

/**
 * **回放和后端自己起的一轮要分开** ——「Claude Code 自发的一轮（CronCreate 到点 / 后台任务跟进）被当回放丢掉」。
 *
 * 上面那个判据的前提「KiroLex 不发 prompt 就不会有正文」对 kiro-cli 成立，对 Claude Code 不成立：
 * 2026-10-22 远端实测（claude-agent-acp 0.88.0 + Claude Code 2.1.284），`CronCreate` 定的一次性提示到点时，
 * **没有任何在途的 session/prompt**，适配器自己推了 `usage_update` → `agent_message_chunk "PONG"` → `usage_update`（带 cost）。
 * 适配器源码管这叫 autonomous cycle（`AUTONOMOUS_RESULT_ORIGINS`），后台 Bash / 后台子代理完成后的跟进也这样到。
 *
 * **回放窗口**（`SessionEntry.replayWindow`）：回放只会在 attach / `session/load`（远端 kiro-cli 按目录或 id 恢复同理）之后、
 * KiroLex 发起的第一轮之前出现 —— ACP 的回放是对 load 的响应，而 load 只发生在挂执行器那一下
 * （`acpReplayTiming.test.ts` 钉着：活着的 client 上没有别的 load）。所以判据是**状态**而不是时长：
 *   · 开：`wireSession`（每次挂上执行器），以及 `recreateBackendSession`（同一 client 上 session/new，「响应之后才回放」那种形状）；
 *   · 关：`sendPromptOnce` 真正开始一轮（`entry.busy = true` 那一下）。
 * 不用「load 响应 + 几秒」：回放可能晚于响应任意久（`acpReplayTiming` 的 replay-after-new），按时长关会把它放出来。
 * 代价是窗口里来的自发正文也丢 —— 但那时这个后端进程里还没跑过任何一轮，不可能有它自己定的 cron / 后台任务。
 *
 * 窗口外、不在一轮里的**助手正文 / 思考块** → `autonomous`：调用方按「后端自己起了一轮」走正常路径（`autonomousTurn.ts`）。
 * 窗口外的 `user_message_chunk` 仍按回放丢（不伪造用户消息）。
 * **kiro 会话行为不变**：kiro-cli 不会自己起一轮，一轮之外的正文照旧全按回放丢（没有引擎信息也按 kiro）。
 */
export type OutsideTurnVerdict = 'replay' | 'autonomous' | null;

export function outsideTurnVerdict(
  update: { sessionUpdate?: unknown } | null | undefined,
  s: { inTurn: boolean; replayWindow: boolean; engine?: string },
): OutsideTurnVerdict {
  if (!isReplayOutsideTurn(update, s.inTurn)) return null;
  if (s.replayWindow || !s.engine || s.engine === 'kiro') return 'replay';
  return update?.sessionUpdate === 'user_message_chunk' ? 'replay' : 'autonomous';
}
