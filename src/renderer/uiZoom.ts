/**
 * 界面缩放（整窗按比例放大 / 缩小，等同浏览器整页缩放；由 webFrame.setZoomFactor 落地）。
 *
 * 存的是**整数百分比**（100 = 原大），不是 1.1 这种小数 —— 反复加减一档不会攒出 1.0999999。
 * 和「聊天字号」（settings.fontSize）是两回事：那个只改聊天内容区的字。
 */
export const UI_ZOOM_MIN = 80;
export const UI_ZOOM_MAX = 200;
export const UI_ZOOM_STEP = 10;
export const UI_ZOOM_DEFAULT = 100;

export type UiZoomAction = 'in' | 'out' | 'reset';

/** 旧配置没有这个值 / 坏值 → 100；越界的夹回范围；不在档位上的取最近一档。 */
export function normalizeUiZoom(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return UI_ZOOM_DEFAULT;
  const snapped = Math.round(v / UI_ZOOM_STEP) * UI_ZOOM_STEP;
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, snapped));
}

/** 放大 / 缩小一档，或回到 100%；到 80% / 200% 就不再变。 */
export function stepUiZoom(cur: unknown, action: UiZoomAction): number {
  if (action === 'reset') return UI_ZOOM_DEFAULT;
  const base = normalizeUiZoom(cur);
  return normalizeUiZoom(base + (action === 'in' ? UI_ZOOM_STEP : -UI_ZOOM_STEP));
}
