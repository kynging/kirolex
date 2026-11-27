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
import { shouldSyncSession, type SessionSyncLists } from '../main/syncChoice.ts';

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
  /** 整组：本机没有的在前，已在本机的在后（`[...notLocal, ...local]`） */
  rows: T[];
  /** 本机没有的 —— 真正要恢复的那些，排在前面；组头「全选」只勾这些 */
  notLocal: T[];
  /** 已经在这台电脑上的 —— 通常不用恢复、只要开自动同步；收进组末尾的「已在本机 N 条」子段 */
  local: T[];
}

/** 拆成本机没有 / 已在本机两段，各自保持原来的顺序 */
const splitLocal = <T extends { existsLocally?: boolean }>(rows: T[]): { rows: T[]; notLocal: T[]; local: T[] } => {
  const notLocal = rows.filter((e) => !e.existsLocally);
  const local = rows.filter((e) => !!e.existsLocally);
  return { rows: [...notLocal, ...local], notLocal, local };
};

export function groupBackups<T extends { project?: string; updatedAt?: number; archived?: boolean; existsLocally?: boolean }>(
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
    .map(([name, rows]) => ({ key: name, name: displayName(name, lang), archived: false, project: name === UNGROUPED ? '' : name, ...splitLocal(rows) }));
  groups.push({ key: ARCHIVED_GROUP, name: t(lang, 'Archived'), archived: true, ...splitLocal(archived) });
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

/**
 * 新旧对比标签的颜色（global.css 里 `.backup-tag.fresh-*`）：四种各一种，一眼分得出——
 * 两边一样 = 绿（恢复不会带来任何变化）、云上较新 = 琥珀（会把云端的新内容并进来）、
 * 本机较新 = 蓝（--info）、本地没有 = 中性（恢复只是新增一条）。
 */
const FRESHNESS_CLASS: Record<Freshness, string> = {
  same: 'fresh-same',
  'cloud-newer': 'fresh-cloud',
  'local-newer': 'fresh-local',
  missing: 'fresh-missing',
};
export const freshnessClass = (f: Freshness): string => FRESHNESS_CLASS[f];

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

type Pickable = { id: string; busy?: boolean; missing?: boolean };

/**
 * 同步页每行的开关 ——「项目不开备份时，会话也能单独打开」。判据和主进程同一份（`shouldSyncSession`，单条优先于项目）：
 * 项目关着时组内每条照常给开关（默认关，可单独打开）；「已归档」组里的按它原来那个项目算默认值。
 * `custom`：这条单独开 / 关过（在 includeSessions 或 excludeSessions 里），行内标「单独设置」。
 */
export function syncRowState(
  x: { id: string; project: string },
  lists: SessionSyncLists,
): { on: boolean; custom: boolean } {
  const inList = (l: string[] | null | undefined): boolean => Array.isArray(l) && l.includes(x.id);
  return { on: shouldSyncSession(lists, x.id, x.project), custom: inList(lists.includeSessions) || inList(lists.excludeSessions) };
}

export interface SyncCounts { synced: number; notSynced: number }

/** 组头的汇总：几条同步、几条不同步。 */
export function syncSummary(rows: Array<{ id: string; project: string }>, lists: SessionSyncLists): SyncCounts {
  const n: SyncCounts = { synced: 0, notSynced: 0 };
  for (const x of rows) if (syncRowState(x, lists).on) n.synced += 1; else n.notSynced += 1;
  return n;
}

/** 汇总文案，数字为 0 的段不显示（全 0 时是空串）。 */
export function syncSummaryText(n: SyncCounts, lang: Lang = 'zh'): string {
  return [
    n.synced ? t(lang, '{n} syncing', { n: n.synced }) : '',
    n.notSynced ? t(lang, '{n} not syncing', { n: n.notSynced }) : '',
  ].filter(Boolean).join(' · ');
}

/**
 * 关着的项目里还有几条单独打开、照样同步的（含已归档的）—— 项目开关旁提示「其中 K 条单独开着，仍会同步」。
 * 项目开着时是 0（那时它们本来就同步，不用提示）。
 */
export function includedWhileProjectOff(
  project: string,
  sessions: Array<{ id: string; project: string }>,
  lists: SessionSyncLists,
): number {
  if (!(lists.excludeProjects || []).includes(project)) return 0;
  return sessions.filter((x) => x.project === project && shouldSyncSession(lists, x.id, x.project)).length;
}

/** 能勾的行：正在跑的（busy）和桶里已经没有文件的（missing）都不能勾。 */
export const isPickable = (e: Pickable): boolean => !e.busy && !e.missing;

/**
 * 一组里勾了哪些（只算能选的 —— 正在跑的 busy 行、没有文件的 missing 行不算），以及组头全选框该显示成什么：
 * 一条没勾 none、勾了一部分 some（半选）、能选的全勾了 all。
 */
export function groupPickState<T extends Pickable>(
  rows: T[],
  picked: ReadonlySet<string>,
): { pickedIds: string[]; selectable: number; state: 'none' | 'some' | 'all' } {
  const ok = rows.filter(isPickable);
  const pickedIds = ok.filter((e) => picked.has(e.id)).map((e) => e.id);
  const state = !pickedIds.length ? 'none' : pickedIds.length === ok.length ? 'all' : 'some';
  return { pickedIds, selectable: ok.length, state };
}

/** 组头的全选框：没全选 → 把这一组能选的都勾上；已全选 → 取消这一组的。别的组不动。 */
export function toggleGroupPick<T extends Pickable>(picked: ReadonlySet<string>, rows: T[]): Set<string> {
  const next = new Set(picked);
  const ok = rows.filter(isPickable);
  if (groupPickState(rows, picked).state === 'all') for (const e of ok) next.delete(e.id);
  else for (const e of ok) next.add(e.id);
  return next;
}

/**
 * 同步摘要里关于云端清理的那一句 ——「这次有 X 条移进云端回收站、Y 条到期清空」。
 * 这一轮没跑清理（开关关着 / 出错）时主进程不给这两个字段 → 不说。
 */
export function cleanupSentence(r: { cloudTrashed?: number; cloudPurged?: number } | null | undefined, lang: Lang = 'zh'): string {
  if (!r || (r.cloudTrashed === undefined && r.cloudPurged === undefined)) return '';
  return t(lang, '{trashed} moved to the cloud trash and {purged} expired and cleared this time.', { trashed: r.cloudTrashed || 0, purged: r.cloudPurged || 0 });
}

/**
 * 桶 / 凭证配好了没有（`getS3Config` 的返回）：缺字段，或者主进程说密钥用不了（换过机器 / 重装）都算没配好。
 * ☁️ 对话框据此决定一打开停在「设置」还是「同步」；配置页据此给「移到云端」置灰。
 */
export function backupConfigured(cfg: {
  bucket?: string; region?: string; credentialSource?: string; accessKeyId?: string; hasSecret?: boolean; credsProblem?: string;
} | null | undefined): boolean {
  if (!cfg) return false;
  const keysOk = (cfg.credentialSource || 'keys') !== 'keys' || !!(cfg.accessKeyId && cfg.hasSecret);
  return !!(cfg.bucket && cfg.region && keysOk) && !cfg.credsProblem;
}

/**
 * 恢复页组头的全选框 —— 只管**本机没有的**那几条（已在本机的通常不用恢复）。
 * 已在本机的仍然可以单独勾来恢复（比如云上较新、想立即合并），不影响组头的状态；组头的删除仍按整组勾了的算。
 */
export function groupHeadPick<T extends Pickable>(g: { notLocal: T[] }, picked: ReadonlySet<string>) {
  return groupPickState(g.notLocal, picked);
}
export function toggleGroupHeadPick<T extends Pickable>(picked: ReadonlySet<string>, g: { notLocal: T[] }): Set<string> {
  return toggleGroupPick(picked, g.notLocal);
}

export interface RestoreCounts {
  /** 云上一共几条 */
  total: number;
  /** 本机没有 */
  notLocal: number;
  /** 已在本机 */
  local: number;
  /** 已在本机、但没开自动同步（「在其他电脑上同步」） */
  localNoSync: number;
  localNoSyncIds: string[];
}

/** 恢复页顶部那行计数：「云上 N 条：本机没有 A 条，已在本机 B 条（其中 C 条没开自动同步）」 */
export function restoreCounts(entries: Array<{ id: string; existsLocally?: boolean; crossDevice?: boolean }>): RestoreCounts {
  const local = entries.filter((e) => e.existsLocally);
  const noSync = local.filter((e) => !e.crossDevice);
  return { total: entries.length, notLocal: entries.length - local.length, local: local.length, localNoSync: noSync.length, localNoSyncIds: noSync.map((e) => e.id) };
}

export function restoreCountsText(c: RestoreCounts, lang: Lang = 'zh'): string {
  const head = t(lang, '{total} in the cloud: {notLocal} not on this machine, {local} already here', { total: c.total, notLocal: c.notLocal, local: c.local });
  return c.localNoSync ? head + t(lang, ' ({n} without auto-sync)', { n: c.localNoSync }) : head;
}
