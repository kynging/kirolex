import { isKirolexNote } from '../main/kirolexNote.ts';

/**
 * 渲染端拼进 `<hidden>` 历史块的那段正文（复制出来的会话、编辑重跑保留的历史、跨会话同步的增量）。
 *
 * KiroLex 自己插进对话的提示（换模型等）以 `role: 'user'` 落盘 —— 只按 role 拼的话，它会以「User: …」
 * 进到模型那儿，被当成你的指令（判据和主进程共用 `isKirolexNote`，见 `main/kirolexNote.ts`）。
 */
export function chatHistoryBody(messages: Array<{ role: string; content: string; kirolex?: true | boolean }>): string {
  return messages
    .filter((m) => !isKirolexNote(m))
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
}
