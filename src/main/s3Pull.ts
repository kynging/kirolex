/**
 * **把别的电脑上的新消息拉回本机已有的会话** ——「S3 同步：自动把别的电脑上的新会话和新消息拉回本机（双向同步）」，
 * 第 3 轮收窄成：只对开了「在其他电脑上同步」的会话、只拉本机已有会话的新内容。
 *
 * 原来的拉回只有冲突合并一处（`detectConflicts`：桶里那条来自别的机器、而且 `updatedAt` 比本机新）。实测两件事：
 *
 *   1. 在 B 上新建 / 恢复后继续聊的会话，A 上永远不出现 —— 没有人去看「catalog 里有、本机没有」的条目；
 *   2. A 本机已有的会话常常拉不到 B 的新消息，而另外两条会话两台机器来回「合并 0 条」一百多次：
 *      `record.updatedAt` 会被状态记账（执行器断开 / attach）改成现在，合并本身又把它改成现在 ——
 *      每台机器每轮都把所有本机会话的 catalog 条目写成「来自自己、updatedAt = 本机的」，
 *      于是谁新取决于谁刚断开过执行器，而不是谁真有新消息。
 *
 * 这里的判据（都是纯函数，index.ts 收集状态后传进来）：
 *
 *   · **要不要合并**（`bucketMergeVerdict`）：桶里这条来自别的设备，而且它的 `uploadedAt`（那台机器**真的**上传文件的时刻）
 *     比本机上次合并时**从同一台设备**看到的那个新。按设备分开记（`BucketSeen`：id → 来源 → uploadedAt），
 *     比较的两边永远是同一台机器的时钟。合并完（哪怕并进 0 条）就记下，下一轮同一份桶内容不再合。
 *   · **不给本机没有的会话建占位**：上一版（b720c90）会给 catalog 里所有来自别的电脑、本机没有的会话建「云端占位」，
 *     实测一下子冒出 16 条用户不需要的会话、点开就整条下载 —— 这个功能取消了，启动时清掉留下的（`clearRemotePlaceholders`）。
 *     只拉**本机已有的**会话在别的电脑上的新消息。
 *
 * **只对开了「在其他电脑上同步」的会话**（第 3 轮，用户实测：「很多我不需要的会话都被下载下来了，其实应该是按照我的要求
 * 只对特定的会话开启同步」）：会话记录上的 `crossDevice`（跟着 catalog 条目的 `crossDevice` 传）。缺省关 ——
 * 没开的会话只备份、不自动合并。手动「从备份恢复」成功后自动开启（`withCrossDeviceOn`）。两台都有的会话，开 / 关按
 * `crossDeviceChangedAt`「谁后改听谁」跟随（`crossDeviceToFollow`，和项目 / 归档的 placementChangedAt 同一套）。
 *
 * 不 import electron；文件路径都由参数传入。
 */

import fs from 'fs';
import path from 'path';
import { placementOf, type Catalog, type CatalogEntry, type Placement } from './s3Sync.ts';
import { looksLikeSessionId } from './projectSanity.ts';
import { normalizeCatalog, uploadedAtOf } from './catalogStore.ts';
import { readOffloadStateStrict, writeOffloadState, type OffloadPlaceholder } from './sessionOffload.ts';

/** 「上次合并时看到的桶里那份」那张表（相对 `~/.kirolex`）。只在本机，不同步。 */
export const BUCKET_SEEN_FILE = 's3-bucket-seen.json';

/** 会话 id → 来源设备（catalog 的 `from`）→ 上次合并时看到的那条的 `uploadedAt`（那台设备的时钟）。 */
export type BucketSeen = Record<string, Record<string, number>>;

export function readBucketSeen(file: string): BucketSeen {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
    const out: BucketSeen = {};
    for (const [id, by] of Object.entries(d)) {
      if (!by || typeof by !== 'object' || Array.isArray(by)) continue;
      const row: Record<string, number> = {};
      for (const [from, at] of Object.entries(by as Record<string, unknown>)) if (typeof at === 'number' && Number.isFinite(at)) row[from] = at;
      out[id] = row;
    }
    return out;
  } catch { return {}; }
}

/** 写不进去：下一轮会对同一份桶内容再合一次（并进 0 条、不动本机），不值得报错。 */
export function writeBucketSeen(file: string, seen: BucketSeen): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(seen));
    fs.renameSync(tmp, file);
  } catch { /* 见上 */ }
}

/** 记下这一次合并看到的那条（同一来源只往大里记）。 */
export function noteBucketSeen(seen: BucketSeen, id: string, entry: Pick<CatalogEntry, 'from' | 'uploadedAt'>): void {
  const from = String(entry.from || '');
  if (!from) return;
  const at = Number(entry.uploadedAt) || 0;
  const row = seen[id] || (seen[id] = {});
  row[from] = Math.max(row[from] ?? at, at);
}

/** 这条 catalog 条目 / 会话记录开了「在其他电脑上同步」没有（缺省关）。 */
export function isShared(x: { crossDevice?: unknown } | null | undefined): boolean {
  return x?.crossDevice === true;
}

/**
 * 本机这条要不要跟随桶里那条的「在其他电脑上同步」开关 —— 要就返回跟随成什么，不要就 `null`。
 * 和 `placementToFollow` 同一个口径：只看 `crossDeviceChangedAt`，桶里的严格更新才跟（老条目没有 = 0，永远不跟）。
 */
export function crossDeviceToFollow(
  local: { crossDevice?: unknown; crossDeviceChangedAt?: unknown } | null | undefined,
  theirs: { crossDevice?: unknown; crossDeviceChangedAt?: unknown } | null | undefined,
): { crossDevice: boolean; crossDeviceChangedAt: number } | null {
  if (!local || !theirs) return null;
  const at = Number(theirs.crossDeviceChangedAt) || 0;
  if (at <= (Number(local.crossDeviceChangedAt) || 0)) return null;
  return { crossDevice: isShared(theirs), crossDeviceChangedAt: at };
}

export type MergeSkip = 'none' | 'no-source' | 'own' | 'seen';

/**
 * **桶里这条要不要并进本机**。只看来源和 `uploadedAt`，不看 `updatedAt`（见文件头）。
 * 本机从没从这台设备合并过这条（`seen` 里没有）→ 合并一次（并集，不会丢东西；并进 0 条也就是记一笔）。
 */
export function bucketMergeVerdict(
  entry: CatalogEntry | undefined, thisMachine: string, seen: BucketSeen,
): { merge: true } | { merge: false; reason: MergeSkip } {
  if (!entry) return { merge: false, reason: 'none' };
  const from = String(entry.from || '');
  if (!from) return { merge: false, reason: 'no-source' };          // 老条目没记来源
  if (from === thisMachine) return { merge: false, reason: 'own' };  // 自己上一轮传的
  const last = seen[entry.id]?.[from];
  if (last !== undefined && uploadedAtOf(entry) <= last) return { merge: false, reason: 'seen' };
  return { merge: true };
}

/** 本机这条和桶里那条合起来，「在其他电脑上同步」到底开没开：桶里改得严格更晚听桶里的，否则听本机的（本机没有 = 听桶里的）。 */
export function effectiveShared(
  local: { crossDevice?: unknown; crossDeviceChangedAt?: unknown } | null | undefined,
  theirs: { crossDevice?: unknown; crossDeviceChangedAt?: unknown } | null | undefined,
): boolean {
  if (!local) return isShared(theirs);
  const f = crossDeviceToFollow(local, theirs);
  return f ? f.crossDevice : isShared(local);
}

/**
 * 本机这几条会话里，这一轮要从桶里合并的那些（catalog 先按删除记录收拾过）。
 * **只合开了「在其他电脑上同步」的**，开没开按「谁后改听谁」算（`effectiveShared`）：桶里那条的开关改得比本机晚就听桶里的，
 * 否则听本机的 —— 本机后关掉的，桶里还留着旧的「开」也不合；另一台后开的（任一台开了就算开），本机还没跟上也照合。
 * 都没开 → 只备份，不自动合并（回到双向同步之前的行为）。
 */
export function planBucketMerges(
  catalog: Catalog | null, localIds: Iterable<string>, thisMachine: string, seen: BucketSeen, now = Date.now(),
  localFlags: ReadonlyMap<string, { crossDevice?: unknown; crossDeviceChangedAt?: unknown }> = new Map(),
): CatalogEntry[] {
  if (!catalog || !Array.isArray(catalog.entries)) return [];
  let c: Catalog;
  try { c = normalizeCatalog(catalog, now); } catch { return []; }
  const byId = new Map(c.entries.map((e) => [e.id, e]));
  const out: CatalogEntry[] = [];
  for (const id of localIds) {
    const e = byId.get(id);
    if (!e || !effectiveShared(localFlags.get(id), e)) continue;
    if (bucketMergeVerdict(e, thisMachine, seen).merge) out.push(e);
  }
  return out;
}

/* ------------------------------------------------------------------ 上一版的外来占位 */

/**
 * 这条占位是不是上一版（b720c90）建的「从别的电脑来的」占位（`origin: 'remote'`）。
 * 那个功能已经取消（「很多我不需要的会话都被下载下来了」）：不再给本机没有的会话建占位，启动时把留下的清掉。
 */
export function isRemotePlaceholder(p: OffloadPlaceholder | undefined | null): boolean {
  return !!p && p.origin === 'remote';
}

/**
 * **启动时清掉上一版建的外来占位**：只删 `origin: 'remote'` 的那些（它们只是指向云端的指针，本机从来没有过内容，删了什么都不丢），
 * 本机移到云端的占位一条不碰。占位文件读不了 / 坏了 → 不写（写回会盖掉里面的「保留在本机」名单和本机移走的占位），返回 null。
 */
export function clearRemotePlaceholders(stateFile: string): string[] | null {
  const st = readOffloadStateStrict(stateFile);
  if (!st) return null;
  const gone = Object.values(st.offloaded).filter((p) => isRemotePlaceholder(p)).map((p) => p.id);
  if (!gone.length) return [];
  for (const id of gone) delete st.offloaded[id];
  writeOffloadState(stateFile, st);
  return gone;
}

/* ------------------------------------------------------------------ 合并的顺序 */

/** `runBucketMerge` 用到的那几步（index.ts 的 mergeBucketSession 接真 S3 / 真文件；测试用假的）。 */
export interface BucketMergeIO {
  /** 下载桶里那份 transcript / record，列出桶里有、本机没有的 files/ 文件（网络，会等） */
  fetch(): Promise<{ transcript: string | null; missingFiles: number }>;
  /** 桶里那份 transcript 比本机多几条（按本机**现在**的 transcript 算） */
  countNew(theirs: string): number;
  /** 这条会话现在忙不忙（正在跑一轮 / 正在接上 / 正在换执行器）—— 忙的不断开、不改写 */
  isBusy(): boolean;
  /** 把桶里有、本机没有的 files/ 文件拉下来（网络，会等；只新增文件，不碰 transcript / record）。返回拉了几个 */
  pullFiles(): Promise<number>;
  /** 断开执行器 + 备份 + 改写 transcript / record（同步完成，中间不等任何东西）。返回并进几条 */
  apply(): number;
}

export type BucketMergeResult = { added: number; pulledFiles: number; noop?: boolean; deferred?: boolean };

/**
 * **合并一条会话的顺序**：下载 → 空合并就什么都不动（`noop`）→ 忙了就推迟（`deferred`）→ 拉文件 → **再问一次忙不忙** →
 * 断开执行器并改写（同步完成）。调用方进来之前查过一次忙，但下载、列文件、拉文件都要等网络，这期间用户或排队任务
 * 可能已经开始了新一轮 —— 这时断开执行器、改写 transcript 会把这一轮打断、丢掉它的产出。所以真正动手前紧挨着再查一次；
 * 推迟的不算「看过了」（调用方不记 bucketSeen），下一轮再合。
 */
export async function runBucketMerge(io: BucketMergeIO): Promise<BucketMergeResult> {
  const got = await io.fetch();
  if (!got.missingFiles && (got.transcript === null || io.countNew(got.transcript) === 0)) return { added: 0, pulledFiles: 0, noop: true };
  if (io.isBusy()) return { added: 0, pulledFiles: 0, deferred: true };
  const pulledFiles = got.missingFiles ? await io.pullFiles() : 0;
  if (io.isBusy()) return { added: 0, pulledFiles, deferred: true };
  return { added: io.apply(), pulledFiles };
}

/* ------------------------------------------------------------------ 下载回本机时放在哪儿 */

/**
 * **占位下载回本机之后放在哪儿**（第 3 轮：「两条在 catalog 里 archived=true，下载后『放进未分组』、record 里 archived 丢了」）。
 *
 * 原来占位下载走的是 s3:restore 那条规则（`restoreTarget`，6165543「从云端恢复的默认进未分组」）：
 *   · 传的是 `entry: undefined`、`putBack: false` —— 项目一律清掉、标 unassigned；
 *   · 归档只取**下载下来的那份 record.json**，侧栏上看到的（占位记下的、catalog 里的）位置完全不参与 ——
 *     桶里的 record.json 比 catalog 条目旧（catalog 每轮按上传那台**现在的**记录重写，record.json 只在它本身被重传时才变）时，
 *     侧栏里在「已归档」的那条，下载回来就成了未分组里一条能连接的普通会话。
 * 占位不是「从备份恢复」：它就是侧栏里那一行，点开只是把内容拿回来，位置应当和点开之前一样。所以：
 *   · 位置按「谁的 placementChangedAt 新听谁」取占位（catalog）和下载下来的记录里较新的那份；一样新（或占位没记时间）时，
 *     归档取两边的「或」—— 宁可多留在归档里（取消归档是一下的事），不能把归档的放出来自动连接；
 *   · 项目本机侧栏有（不是会话 id 形状、不是 advanced 专属）就放回去，没有才进未分组（标 unassigned）。
 */
export function placeholderPlacement(
  record: { profile?: any; archived?: any; placementChangedAt?: any } | null | undefined,
  placeholder: Pick<OffloadPlaceholder, 'project' | 'archived' | 'placementChangedAt'> | null | undefined,
  localProjects: ReadonlySet<string>,
  refuseProject?: (projectId: string) => boolean,
): { placement: Placement; unassigned: boolean; origin?: string } {
  const r = placementOf(record);
  const pAt = Number(placeholder?.placementChangedAt) || 0;
  const pProject = typeof placeholder?.project === 'string' ? placeholder.project.trim() : '';
  const pArchived = !!placeholder?.archived;
  const placeholderNewer = !!placeholder && pAt > r.placementChangedAt;
  const recordNewer = !placeholder || (pAt > 0 && r.placementChangedAt > pAt);
  const archived = placeholderNewer ? pArchived : recordNewer ? r.archived : (r.archived || pArchived);
  const wanted = placeholderNewer ? pProject : recordNewer ? r.projectId : (r.projectId || pProject);
  const ok = !!wanted && localProjects.has(wanted) && !looksLikeSessionId(wanted) && !refuseProject?.(wanted);
  return {
    placement: { projectId: ok ? wanted : '', archived, placementChangedAt: Math.max(pAt, r.placementChangedAt) },
    unassigned: !ok,
    ...(wanted ? { origin: wanted } : null),
  };
}

/**
 * **手动「从备份恢复」成功 = 开启「在其他电脑上同步」**：恢复回来就是要在这台接着用、并拿到另一台后来的新消息。
 * 开关时间记成现在（比另一台的旧开关新 —— 另一台下一轮也跟着开，谁后改听谁）。只动这两个字段。
 */
export function withCrossDeviceOn<T extends { crossDevice?: boolean; crossDeviceChangedAt?: number }>(rec: T, now: number): T {
  return { ...rec, crossDevice: true, crossDeviceChangedAt: Math.max(now, (Number(rec.crossDeviceChangedAt) || 0) + 1) };
}
