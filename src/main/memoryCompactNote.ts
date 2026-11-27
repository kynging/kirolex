/**
 * 「已整理 <层> 记忆」那条 KiroLex 提示的 noteGroup —— PURE，主进程写、渲染端读（卡片上的「查看差异」「撤销」按它找备份）。
 * 备份路径整段放在冒号后面（Windows 路径里本身有冒号，所以只认第一个冒号前的前缀）。
 */
export const MEMORY_COMPACT_GROUP_PREFIX = 'memory-compact:';

export function memoryCompactGroup(backupPath: string): string {
  return `${MEMORY_COMPACT_GROUP_PREFIX}${backupPath}`;
}

/** 这条提示的备份路径；不是这类提示返回 null。 */
export function parseMemoryCompactGroup(group: string | null | undefined): string | null {
  const g = String(group || '');
  if (!g.startsWith(MEMORY_COMPACT_GROUP_PREFIX)) return null;
  const p = g.slice(MEMORY_COMPACT_GROUP_PREFIX.length);
  return p || null;
}
