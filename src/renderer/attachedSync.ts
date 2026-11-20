/**
 * 主进程 `acp:list-attached` 回来的那份里，**还不在渲染层 attached 集合里的**会话 id（去重、只要非空字符串）。
 * 回的不是数组（老主进程没有这个 IPC / 出错）就一个都不加 —— 照旧按 eager-attach 那一批连。
 */
export function attachedFromMain(current: ReadonlySet<string>, reply: unknown): string[] {
  if (!Array.isArray(reply)) return [];
  const out: string[] = [];
  for (const id of reply) {
    if (typeof id !== 'string' || !id || current.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}
