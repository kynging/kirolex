/**
 * 实时那一轮的正文 / 思考块怎么并进消息列表 —— PURE（useAcp 的 `agent_message_chunk` / `agent_thought_chunk` 两个分支，
 * 前台、后台缓存同一套）。抽出来是为了回放测试能喂真实的事件序列（`tests/codexDuplicateReply.test.ts`）。
 *
 * 规则（和原来一样）：
 *   · 正文追加到最后一条助手消息上，除非它是 💭 思考段或提问卡片 —— 那就新开一条（这一轮就被切成了几段，
 *     一轮结束时的权威正文要按段并，见 `assistantFinal.mergeAssistantFinalIntoTurn`）；
 *   · 思考追加到最后一条 💭 段上，不是就新开一条 `💭 ` 开头的。
 * `fresh(content)` 造新的那一条（id / 时间戳 / 其余字段由调用方定）。
 */
import type { Message } from './App';
import { isQuestionMessage } from './questionCards.ts';

type Live = Pick<Message, 'role' | 'content' | 'question'>;

export function appendAgentText<T extends Live>(list: T[], text: string, fresh: (content: string) => T): T[] {
  const last = list[list.length - 1];
  if (last?.role === 'assistant' && !last.content.startsWith('💭 ') && !isQuestionMessage(last)) {
    return [...list.slice(0, -1), { ...last, content: last.content + text }];
  }
  return [...list, fresh(text)];
}

export function appendAgentThought<T extends Live>(list: T[], text: string, fresh: (content: string) => T): T[] {
  const last = list[list.length - 1];
  if (last?.role === 'assistant' && last.content.startsWith('💭 ')) {
    return [...list.slice(0, -1), { ...last, content: last.content + text }];
  }
  return [...list, fresh('💭 ' + text)];
}
