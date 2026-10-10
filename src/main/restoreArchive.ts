/**
 * **恢复页里的「本机已归档」** —— 纯逻辑，`index.ts` 的 `s3:list-backups` / `s3:restore` 收集状态后传进来。
 *
 * catalog 只记"备份时属于哪个项目"，不知道本机已经把这条归档了。于是本机归档的会话在恢复页里
 * 还挂在原项目下，点恢复走合并、合并完 archived 还是 true —— 侧栏项目里看不到它，看起来像恢复失败。
 * 这里只靠**本机记录**判断（不改 catalog 格式、不动上传）。
 */

/** 给每条备份加 `archivedLocally`：本机同 id 那条记录的 archived；本机没有就是 false。 */
export function markArchivedLocally<T extends { id: string }>(
  entries: T[],
  localRecs: Array<{ id: string; archived?: boolean }>,
): Array<T & { archivedLocally: boolean }> {
  const archived = new Set(localRecs.filter((r) => r.archived).map((r) => r.id));
  return entries.map((e) => ({ ...e, archivedLocally: archived.has(e.id) }));
}

/**
 * 恢复（合并）完成后取消归档。`wasArchived` 是**合并之前**本机那份记录的 archived。
 *
 * 返回要写回的新记录（`archived: false`，项目沿用合并后记录里的 `profile.projectId` —— 就是它原来的项目），
 * 不需要动时返回 null。`archived` 写成显式 false 而不是删掉：渲染端水化用的是 `rec.archived ?? existing.archived`，
 * 字段不存在会退回内存里那个旧的 true。
 */
export function unarchiveRestoredRecord(merged: any, wasArchived: boolean): { record: any; projectId?: string } | null {
  if (!wasArchived || !merged || typeof merged !== 'object') return null;
  const projectId = typeof merged.profile?.projectId === 'string' && merged.profile.projectId ? merged.profile.projectId : undefined;
  return { record: { ...merged, archived: false }, projectId };
}
