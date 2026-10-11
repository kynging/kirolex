/**
 * **Ctrl+A 归谁** —— 聊天区在 document 上挂了一个全局 Ctrl+A（选聊天记录）。用户最后一次点在（或焦点落在）
 * 文件侧栏里时，侧栏的 `ReviewPane` 先接住（捕获阶段、`preventDefault`），聊天区看到 `defaultPrevented` 就让开。
 *
 * 这里只放判断，不碰 DOM 的具体结构 —— 方便单测（tests/selectAllScope.test.ts）。
 */

type Containerish = { contains: (n: any) => boolean };

/** 最后一次 mousedown / focusin 落在哪 —— 两者谁晚算谁（Tab 进侧栏也算"在侧栏里"）。 */
let lastTarget: unknown = null;
if (typeof document !== 'undefined') {
  const remember = (e: Event) => { lastTarget = e.target; };
  document.addEventListener('mousedown', remember, true);
  document.addEventListener('focusin', remember, true);
}
export const lastInteraction = (): unknown => lastTarget;

/** 焦点在输入框 / textarea / contenteditable 里 —— Ctrl+A 交给浏览器，只全选那个框。 */
export function isEditableEl(el: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable;
}

/**
 * 侧栏要不要接管这次 Ctrl+A：
 *  - `ignore`  不管（焦点在输入框里，或者最后点的不是侧栏）—— 浏览器 / 聊天区照旧；
 *  - `swallow` 吞掉、什么也不选（deck 逐页预览是画出来的图，没有文字层）—— 至少不去选聊天记录；
 *  - `select`  只选这份文件的正文。
 */
export function reviewSelectAll(o: {
  zone: Containerish | null;
  last: unknown;
  active: { tagName?: string; isContentEditable?: boolean } | null;
  deck: boolean;
}): 'ignore' | 'swallow' | 'select' {
  if (isEditableEl(o.active)) return 'ignore';
  if (!o.zone || !o.last || !o.zone.contains(o.last)) return 'ignore';
  return o.deck ? 'swallow' : 'select';
}

/** 选区是不是正好从正文头到正文尾（= 侧栏 Ctrl+A 选出来的那一个）—— 是的话复制时写文件原文。 */
export function coversWhole(
  r: { startContainer: unknown; startOffset: number; endContainer: unknown; endOffset: number } | null | undefined,
  body: { childNodes: { length: number } } | null | undefined,
): boolean {
  if (!r || !body) return false;
  return r.startContainer === body && r.startOffset === 0
    && r.endContainer === body && r.endOffset === body.childNodes.length;
}
