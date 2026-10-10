/**
 * KEEPING A CONTEXT MENU ON SCREEN — pure, because the arithmetic is the whole bug.
 *
 * A menu opened from a row near the bottom or the right edge was positioned at the pointer and then simply ran
 * off the viewport: the items past the edge were unreachable, and for the session menu those are 「Delete」 and
 * the project list. Clamping is not enough on its own — a menu that would overflow DOWNWARD is better flipped to
 * open UPWARD from the pointer (it stays next to what you right-clicked) and only clamped when it cannot fit
 * either way, which is the case for a menu taller than the window.
 */
export interface Placement {
  left: number;
  top: number;
}

export function placeMenu(opts: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}): Placement {
  const margin = opts.margin ?? 6;
  const { x, y, width, height, viewportWidth: vw, viewportHeight: vh } = opts;

  // Horizontal: prefer the pointer, flip to the left of it when the menu would cross the right edge.
  let left = x;
  if (left + width > vw - margin) left = x - width;
  left = Math.max(margin, Math.min(left, Math.max(margin, vw - width - margin)));

  // Vertical: same, flipping UP so the menu still touches the row it belongs to.
  let top = y;
  if (top + height > vh - margin) top = y - height;
  top = Math.max(margin, Math.min(top, Math.max(margin, vh - height - margin)));

  return { left, top };
}

/**
 * 子菜单（右侧展开）竖直方向放哪儿 —— 返回相对入口那一行的 `top`（px）。
 *
 * 默认贴着入口（-5px，和面板的 padding 对齐）；往下展开会超出屏幕底部就往上挪到刚好放得下，
 * 再高也不越过屏幕顶部（CSS 已把面板限高到可见区域内，超出的在面板里滚动）。
 */
export function placeSubmenu(opts: {
  rowTop: number;
  height: number;
  viewportHeight: number;
  margin?: number;
}): number {
  const margin = opts.margin ?? 6;
  const { rowTop, height, viewportHeight: vh } = opts;
  let top = rowTop - 5;
  if (top + height > vh - margin) top = vh - margin - height;
  top = Math.max(margin, top);
  return top - rowTop;
}
