/**
 * 窗口（按 CSS px 算）放不下时，左侧会话栏 / 右侧预览栏**临时让位**，保证中间的聊天区还能用。
 *
 * 界面缩放调大以后，同一个物理窗口按 CSS px 算就变窄了：1024 宽的窗口开 200% 只剩 512。
 * 侧栏（默认 240）和预览栏（最窄 FILE_PANEL_MIN）都有最低宽度，于是聊天区被挤成 0，输入框和发送键没了。
 *
 * 规则：
 * - 这里只算「这一刻要不要临时收起」，**不改、不存**用户自己的开 / 关（`sidebarCollapsed` / `fileViewerHidden`）——
 *   窗口变宽 / 缩放调小，收起的自己回来；重启也不会留下一个莫名其妙收着的栏。
 * - 先收侧栏（它只是导航，宽度小；预览栏里通常是你正在看的东西），还不够再收预览栏。
 * - 用户在**当前这个宽度**下亲手点开的那一栏（`pinned*`）不收 —— 否则点了没反应，像按钮坏了。
 */
export interface PanelFitInput {
  /** 窗口宽度（CSS px，即 window.innerWidth —— 已经是缩放后的） */
  winWidth: number;
  sidebarWidth: number;
  /** 用户自己收起了侧栏 */
  sidebarCollapsed: boolean;
  /** 有预览栏可显示（开着文件）且用户没有自己把它藏起来 */
  previewOpen: boolean;
  /** 预览栏显示时占多宽 */
  previewWidth: number;
  pinnedSidebar?: boolean;
  pinnedPreview?: boolean;
}

/** 聊天区至少要留这么宽，输入框和它那一排按钮才放得下 */
export const CHAT_FIT_MIN = 280;
/** 两条折叠按钮条、分屏「加一格」条等零碎占的宽度 */
export const PANEL_FIT_RESERVE = 60;

export function autoFoldPanels(i: PanelFitInput): { sidebar: boolean; preview: boolean } {
  let sidebarShown = !i.sidebarCollapsed;
  let previewShown = i.previewOpen;
  const room = () => i.winWidth - (sidebarShown ? i.sidebarWidth : 0) - (previewShown ? i.previewWidth : 0) - PANEL_FIT_RESERVE;
  let sidebar = false;
  let preview = false;
  if (sidebarShown && !i.pinnedSidebar && room() < CHAT_FIT_MIN) { sidebarShown = false; sidebar = true; }
  if (previewShown && !i.pinnedPreview && room() < CHAT_FIT_MIN) { previewShown = false; preview = true; }
  return { sidebar, preview };
}

/**
 * 右侧文件 / comment 栏拖宽时最宽能到多少：窗口宽 − 侧栏（开着时）− 聊天区至少留的宽度，不低于 `panelMin`。
 * 原来还有个固定上限 1100px，大窗口（1920 宽最大化）里它先卡住，聊天区还剩 500 多 px 也拉不动 —— 去掉了。
 * 窗口窄到连 `panelMin` 都放不下时，由 `autoFoldPanels` 收栏保住聊天区。
 */
export function filePanelMax(i: { winWidth: number; sidebarShownWidth: number; chatMin: number; panelMin: number }): number {
  return Math.max(i.panelMin, i.winWidth - i.sidebarShownWidth - i.chatMin);
}
