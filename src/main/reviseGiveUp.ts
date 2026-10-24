/**
 * **改写排队等了 20 分钟还没轮到、放弃了 —— 在会话里明说，原文带上**（docs/notices-audit.md #83）。
 *
 * 原来只把「等了 20 分钟这条会话还在忙」作为错误交回文件预览，会话里一个字都没有；而「⏳ 已排队…轮到时自动发出」
 * 那句已经在状态行说过了 —— 于是看起来像是它会一直等下去。现在放弃时在对话记录里说一句：等了多久、放弃了、原文是什么。
 * 意见本身照旧放回文件预览里那一处（同一张 ticket，`retrySame`），再点 ✓ 就按同一次重发。
 *
 * 纯的（不 import electron），`index.ts` 里三处等空闲超时（改写、格式不对的追问、deck 一页文字）共用。
 */
import { tr, trConcat } from './uiText.ts';
import { NOTE_DETAIL_SEP } from './kirolexNote.ts';

/** 同一处改写再放弃一次只算一条（界面按 group 合并计数） */
export function reviseGaveUpGroup(label: string): string {
  return `revise-gave-up:${label}`;
}

/** 放弃那一句：主句 + 原文（你的话，不折叠）；一直在忙的原因折进「详情」 */
export function reviseGaveUpNote(label: string, original: string, busy: string): string {
  return trConcat(
    tr('⚠️ Waited 20 minutes and this revision never got its turn, so it was dropped: {label}. Your comment is below; click ✓ on it in the file preview to send it again.', { label }),
    '\n',
    tr('Your comment: {note}', { note: String(original || '').trim() }),
    NOTE_DETAIL_SEP,
    tr('The session stayed busy: {busy}', { busy }),
  );
}
