/**
 * 备份窗口两页的分组（纯逻辑，`BackupDialog.tsx` 用）。
 *
 * · 同步页（`groupSyncProjects`）显示的是**这台机器上**的：会话按本机记录属于哪个项目分组，
 *   本机归档了的（`record.archived`）不放在原项目组里，统一放进最后的「已归档」组。
 * · 恢复页（`groupBackups`）显示的是**云上那份**（catalog）：按 catalog 条目自己的 `project` 分组，
 *   catalog 里 `archived` 为 true 的放进「已归档」组。本机归档了没有不影响这一页。
 *
 * 两页都固定显示「未分组」和「已归档」（空的也显示）。组的顺序：各项目组按组内最近更新排，
 * 然后「未分组」，最后「已归档」。
 */

import { t, type Lang } from './i18n.ts';

/** 「已归档」组的 key —— 不和任何项目名撞（项目名也可能就叫「已归档」）。 */
export const ARCHIVED_GROUP = '\u0000archived';

const UNGROUPED = '未分组';

const projectLabel = (p?: string): string => (p && p.trim() ? p : UNGROUPED);
/** 组头显示用的名字：「未分组」按界面语言翻译（key 仍是中文，收起状态和排序不受影响）。 */
const displayName = (name: string, lang: Lang): string => (name === UNGROUPED ? t(lang, 'Unassigned') : name);

export interface BackupGroup<T> {
  /** 收起 / 展开用的 key */
  key: string;
  /** 组头显示的名字 */
  name: string;
  /** 这一组是不是「已归档」 */
  archived: boolean;
  /** 这一组对应的项目（未分组是 ''；「已归档」组混着好几个项目，没有） */
  project?: string;
  rows: T[];
}

export function groupBackups<T extends { project?: string; updatedAt?: number; archived?: boolean }>(
  entries: T[],
  lang: Lang = 'zh',
): BackupGroup<T>[] {
  const map = new Map<string, T[]>([[UNGROUPED, []]]);
  const archived: T[] = [];
  for (const e of entries) {
    if (e.archived) { archived.push(e); continue; }
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
    .map(([name, rows]) => ({ key: name, name: displayName(name, lang), archived: false, project: name === UNGROUPED ? '' : name, rows }));
  groups.push({ key: ARCHIVED_GROUP, name: t(lang, 'Archived'), archived: true, rows: archived });
  return groups;
}

/** 恢复页每行的新旧对比：本机记录的 updatedAt 和 catalog 条目的 updatedAt 比。 */
export type Freshness = 'local-newer' | 'cloud-newer' | 'same' | 'missing';

export function compareFreshness(e: { existsLocally?: boolean; localUpdatedAt?: number; updatedAt?: number }): Freshness {
  if (!e.existsLocally) return 'missing';
  const mine = Number(e.localUpdatedAt) || 0;
  const theirs = Number(e.updatedAt) || 0;
  if (mine > theirs) return 'local-newer';
  if (mine < theirs) return 'cloud-newer';
  return 'same';
}

export const FRESHNESS_LABEL: Record<Freshness, string> = {
  'local-newer': '本机较新',
  'cloud-newer': '云上较新',
  same: '两边一样',
  missing: '本地没有',
};

/** 按界面语言给新旧对比的标签（中文和上面的 `FRESHNESS_LABEL` 一致）。 */
export function freshnessLabel(f: Freshness, lang: Lang = 'zh'): string {
  switch (f) {
    case 'local-newer': return t(lang, 'Newer on this machine');
    case 'cloud-newer': return t(lang, 'Newer in the cloud');
    case 'same': return t(lang, 'Same on both sides');
    default: return t(lang, 'Not on this machine');
  }
}

/** 同步页的一组。`project` 为 null 的是「已归档」组（混着好几个项目，没有项目级开关）。 */
export interface SyncGroup<S, P> {
  key: string;
  name: string;
  archived: boolean;
  project: string | null;
  /** 项目组：主进程给的那一行（未分组没有会话时是补出来的空行）；「已归档」组没有 */
  row?: P;
  /** 组内会话，带上它在本机属于哪个项目（「已归档」组每行要显示原属哪个项目） */
  sessions: Array<S & { project: string }>;
  bytes: number;
  updatedAt: number;
  /** 这个项目另有几条在「已归档」组里 */
  archivedCount: number;
}

export function groupSyncProjects<
  S extends { updatedAt?: number; bytes?: number; archived?: boolean },
  P extends { project: string; sessions: S[] },
>(projects: P[], blankUngrouped: () => P, lang: Lang = 'zh'): SyncGroup<S, P>[] {
  const rows = projects.some((p) => !p.project) ? projects : [...projects, blankUngrouped()];
  const archived: Array<S & { project: string }> = [];
  const byRecent = (a: { updatedAt?: number }, b: { updatedAt?: number }): number => (b.updatedAt || 0) - (a.updatedAt || 0);
  const groups: SyncGroup<S, P>[] = rows.map((p) => {
    const live: Array<S & { project: string }> = [];
    let archivedCount = 0;
    for (const s of p.sessions) {
      const x = { ...s, project: p.project };
      if (s.archived) { archived.push(x); archivedCount += 1; } else live.push(x);
    }
    live.sort(byRecent);
    return {
      key: p.project,
      name: displayName(projectLabel(p.project), lang),
      archived: false,
      project: p.project,
      row: p,
      sessions: live,
      bytes: live.reduce((n, s) => n + (s.bytes || 0), 0),
      updatedAt: live.reduce((n, s) => Math.max(n, s.updatedAt || 0), 0),
      archivedCount,
    };
  });
  groups.sort((a, b) => (a.project ? 0 : 1) - (b.project ? 0 : 1) || b.updatedAt - a.updatedAt);
  archived.sort(byRecent);
  groups.push({
    key: ARCHIVED_GROUP,
    name: t(lang, 'Archived'),
    archived: true,
    project: null,
    sessions: archived,
    bytes: archived.reduce((n, s) => n + (s.bytes || 0), 0),
    updatedAt: archived.reduce((n, s) => Math.max(n, s.updatedAt || 0), 0),
    archivedCount: 0,
  });
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
