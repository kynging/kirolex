/**
 * 聊天区底部「正在压缩上下文… N 秒」的已用时间（`ChatArea` 压缩中那一格）—— 从发出 /compact 起算
 * （收到主进程 `acp:compacting` 的时刻，它在发出 /compact 时同步发；窗口刷新后不知道就从这个窗口第一次看到压缩中算）。
 */
export function compactingElapsedSeconds(since: number | null | undefined, now: number): number {
  if (typeof since !== 'number' || !Number.isFinite(since)) return 0;
  return Math.max(0, Math.floor((now - since) / 1000));
}
