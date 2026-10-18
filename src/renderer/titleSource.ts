import { isKirolexNote } from '../main/kirolexNote.ts';

/**
 * 自动命名用的材料：**你**的第一条消息（话题在那儿）。
 *
 * KiroLex 自己的提示也以 `role: 'user'` 存着（例如新建会话时就插进来的「本机没有模型 X，改用 Y」），
 * 它排在你真正的问题前面 —— 只按 role 挑的话，标题会围着"模型不可用"起。所以跳过它们（判据和主进程共用 `isKirolexNote`）。
 */
export function firstUserText(messages: Array<{ role: string; content?: string; kirolex?: true | boolean }>): string {
  return (messages.find((m) => m.role === 'user' && !isKirolexNote(m) && (m.content || '').trim())?.content || '').trim();
}
