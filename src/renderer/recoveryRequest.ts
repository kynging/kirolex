/**
 * **主动调出「恢复」选择器**（侧栏会话菜单 →「🔧 恢复这条会话…」）：不出错也能打开同一张恢复卡（ChatArea 的 SafeguardCard）。
 * 只是界面上的一次请求，不落盘、不进会话记录。菜单那边先切到这条会话，显示它的那个聊天格认领请求（`takeRecoveryRequest`）。
 */
const pending = new Set<string>();
const listeners = new Set<() => void>();

export function requestRecovery(sessionId: string): void {
  if (!sessionId) return;
  pending.add(sessionId);
  for (const fn of listeners) fn();
}

/** 这条会话有没有排着的请求；有就认领（只认领一次）。 */
export function takeRecoveryRequest(sessionId: string | null | undefined): boolean {
  return !!sessionId && pending.delete(sessionId);
}

export function subscribeRecoveryRequests(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
