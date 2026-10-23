import { isKirolexNote } from '../main/kirolexNote.ts';
import { foldTextToolCall } from '../main/textToolCall.ts';
import { questionTailText, type QuestionCard } from '../main/elicitation.ts';

/**
 * 渲染端拼进 `<hidden>` 历史块的那段正文（复制出来的会话、编辑重跑保留的历史、跨会话同步的增量）。
 *
 * KiroLex 自己插进对话的提示（换模型等）以 `role: 'user'` 落盘 —— 只按 role 拼的话，它会以「User: …」
 * 进到模型那儿，被当成你的指令（判据和主进程共用 `isKirolexNote`，见 `main/kirolexNote.ts`）。
 *
 * 助手把工具调用写成了文字（没执行）的那段折叠成一句说明，不原样喂回模型（`main/textToolCall.ts`）。
 * 提问卡片（正文是空的）写成「问了什么、答了什么」（和主进程 `historyLine` 同一个 `questionTailText`）。
 */
export function chatHistoryBody(messages: Array<{ role: string; content: string; kirolex?: true | boolean; toolTailFrom?: number; question?: QuestionCard }>): string {
  return messages
    .filter((m) => !isKirolexNote(m))
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.question ? questionTailText(m.question) : m.role === 'user' ? m.content : foldTextToolCall(m.content, m.toolTailFrom)}`)
    .join('\n\n');
}
