/**
 * 右侧文件预览栏自己的搜索（Ctrl/Cmd+F）—— 纯逻辑,PURE。
 *
 * 聊天区每格一条搜索条（`paneFind.ts`）;预览栏是另一块内容,也要有自己的一条。
 * 一次 Ctrl+F 只能归一处:焦点在预览栏里（点过它,或者焦点就在它里面的元素上）归预览栏,
 * 否则照旧归聊天区那一格。命中怎么算、怎么画,和聊天区共用 `paneFind.ts` / `findHighlight.ts`。
 */

/**
 * 预览栏在高亮注册表（`findHighlight.ts`）里的 key。
 * 带冒号:会话 id 只能是 `^[A-Za-z0-9_-]+$`,所以它不可能和任何一格聊天撞名 —— 撞了就会互相清掉。
 */
export const PREVIEW_FIND_KEY = 'preview:file';

/** 预览栏的根元素。 */
export const PREVIEW_PANEL_SELECTOR = '.workspace-file-panel';

/** 这次 Ctrl+F 归谁。预览栏藏起来 / 关掉之后,之前点过它也不算 —— 否则按下去什么都不出。 */
export function findOwner(arg: { previewShown: boolean; focusInPreview: boolean }): 'preview' | 'chat' {
  return arg.previewShown && arg.focusInPreview ? 'preview' : 'chat';
}

/**
 * 事件的 target 在不在预览栏里。文本节点没有 `closest`,按它的父元素算;
 * `window` / `document` / null 之类一律不算,也不抛。
 */
export function isInPreview(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = typeof (target as any).closest === 'function' ? target : (target as any).parentElement;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest(PREVIEW_PANEL_SELECTOR);
}

/** 只搜文字:PDF / PPT（按页画出来的）、图片、二进制都不搜。 */
export function previewSearchable(arg: { deck: boolean; image: boolean; binary: boolean }): boolean {
  return !arg.deck && !arg.image && !arg.binary;
}

/**
 * 内容在原地变了（批注模式里改了一块、异步内容挂上来）之后重算命中,当前项尽量留在原地 ——
 * 跳回第 1 个会让人以为自己按的 ↓ 全白按了。命中变少就落到最后一个。
 */
export function keepActive(active: number, total: number): number {
  if (total <= 0) return 0;
  if (active <= 0) return 1;
  return Math.min(active, total);
}
