/**
 * 恢复页的分组（纯逻辑，`BackupDialog.tsx` 用）。
 *
 * 按项目分组；**本机已归档**的（`archivedLocally`）不放进原项目组，统一放进最后的「已归档」组 ——
 * 否则它看起来还在那个项目里，而本机侧栏的项目里其实看不到它。
 * 组的顺序：各项目组按组内最近更新排，「未分组」在项目组之后，「已归档」在最后。
 */

/** 「已归档」组的 key —— 不和任何项目名撞（项目名也可能就叫「已归档」）。 */
export const ARCHIVED_GROUP = '\u0000archived';

const UNGROUPED = '未分组';

const projectLabel = (p?: string): string => (p && p.trim() ? p : UNGROUPED);

export interface BackupGroup<T> {
  /** 收起 / 展开用的 key */
  key: string;
  /** 组头显示的名字 */
  name: string;
  /** 这一组是不是「已归档」 */
  archived: boolean;
  rows: T[];
}

export function groupBackups<T extends { project?: string; updatedAt?: number; archivedLocally?: boolean }>(
  entries: T[],
): BackupGroup<T>[] {
  const map = new Map<string, T[]>();
  const archived: T[] = [];
  for (const e of entries) {
    if (e.archivedLocally) { archived.push(e); continue; }
    const key = projectLabel(e.project);
    const list = map.get(key) || [];
    list.push(e);
    map.set(key, list);
  }
  const byRecent = (a: T, b: T): number => (b.updatedAt || 0) - (a.updatedAt || 0);
  for (const list of map.values()) list.sort(byRecent);
  archived.sort(byRecent);
  const groups: BackupGroup<T>[] = [...map.entries()]
    .sort((a, b) => {
      if ((a[0] === '未分组') !== (b[0] === '未分组')) return a[0] === '未分组' ? 1 : -1;
      return (b[1][0]?.updatedAt || 0) - (a[1][0]?.updatedAt || 0);
    })
    .map(([name, rows]) => ({ key: name, name, archived: false, rows }));
  if (archived.length) groups.push({ key: ARCHIVED_GROUP, name: '已归档', archived: true, rows: archived });
  return groups;
}

type Pickable = { id: string; busy?: boolean };

/**
 * 一组里勾了哪些（只算能选的 —— 正在跑的 busy 行不算），以及组头全选框该显示成什么：
 * 一条没勾 none、勾了一部分 some（半选）、能选的全勾了 all。
 */
export function groupPickState<T extends Pickable>(
  rows: T[],
  picked: ReadonlySet<string>,
): { pickedIds: string[]; selectable: number; state: 'none' | 'some' | 'all' } {
  const ok = rows.filter((e) => !e.busy);
  const pickedIds = ok.filter((e) => picked.has(e.id)).map((e) => e.id);
  const state = !pickedIds.length ? 'none' : pickedIds.length === ok.length ? 'all' : 'some';
  return { pickedIds, selectable: ok.length, state };
}

/** 组头的全选框：没全选 → 把这一组能选的都勾上；已全选 → 取消这一组的。别的组不动。 */
export function toggleGroupPick<T extends Pickable>(picked: ReadonlySet<string>, rows: T[]): Set<string> {
  const next = new Set(picked);
  const ok = rows.filter((e) => !e.busy);
  if (groupPickState(rows, picked).state === 'all') for (const e of ok) next.delete(e.id);
  else for (const e of ok) next.add(e.id);
  return next;
}
