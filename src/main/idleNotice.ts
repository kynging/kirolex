/**
 * 钉住的会话闲下来时的系统通知 —— 主进程这一半的判定，纯逻辑（不 import electron）。
 *
 * 只有 KiroLex 窗口**不是**用户正在看的那个时才发：没焦点、最小化、藏进托盘都算不在看。
 * 「要不要发」的另一半（会话是不是真的闲了、钉没钉住）在渲染端 `src/renderer/idleNotify.ts`。
 */
export interface WindowState {
  exists: boolean;
  focused: boolean;
  visible: boolean;
  minimized: boolean;
}

export function windowIsActive(w: WindowState): boolean {
  return w.exists && w.visible && !w.minimized && w.focused;
}
