/**
 * **一轮结束 / 停止 / 断线时收掉还挂着的权限卡片**（审计 2.1，`docs/engine-audit-claude-codex.md`）。
 *
 * 卡片原来只在点了之后才清：这一轮结束、被停止、执行器断了，卡片还留在屏幕上，`awaitingPermission`（空闲提醒看它）
 * 一直为真，点它答的是一个已经作废的请求 id。纯函数，测试 `tests/engineAuditFixes4.test.ts`。
 */

/** 去掉这条会话的那张卡片；本来就没有就原样返回（不触发重渲染）。 */
export function withoutPermissionCard<T>(cards: Record<string, T>, sid: string): Record<string, T> {
  if (!sid || !Object.prototype.hasOwnProperty.call(cards, sid)) return cards;
  const next = { ...cards };
  delete next[sid];
  return next;
}
