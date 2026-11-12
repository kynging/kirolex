/**
 * **把别的电脑上的新会话、新消息拉回本机** ——「S3 同步：自动把别的电脑上的新会话和新消息拉回本机（双向同步）」。
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
 *   · **建「来自别的电脑」的占位**（`planRemotePlaceholders`）：catalog 里来自别的设备、本机没有、没被本机删过、
 *     项目没设成不同步、不是 advanced 专属、不在云端回收站里的条目 —— 复用「移到云端」的占位（`sessionOffload.ts`），
 *     只是 `origin: 'remote'`。不下载，点开才拉。
 *   · **删除跟着走**：catalog 里已经没有这条（别的电脑删了它的备份、或者它进了云端回收站）→ 去掉这条外来占位；
 *     本机真有内容的会话不在这里处理。外来占位**不算本机持有**（`manifestSessionsWithOffloaded` 跳过它们），
 *     否则别的电脑删了它，云端回收站永远等不到「所有设备都没有了」。
 *
 * 不 import electron；文件路径都由参数传入。
 */

import fs from 'fs';
import path from 'path';
import { sessionPrefix, type Catalog, type CatalogEntry } from './s3Sync.ts';
import { normalizeCatalog, uploadedAtOf } from './catalogStore.ts';
import { readOffloadStateStrict, writeOffloadState, type OffloadPlaceholder } from './sessionOffload.ts';

/** 「上次合并时看到的桶里那份」那张表（相对 `~/.kirolex`）。只在本机，不同步。 */
export const BUCKET_SEEN_FILE = 's3-bucket-seen.json';

/** 会话 id → 来源设备（catalog 的 `from`）→ 上次合并时看到的那条的 `uploadedAt`（那台设备的时钟）。 */
export type BucketSeen = Record<string, Record<string, number>>;

const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;

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

/** 设置里「自动显示其他电脑上的会话」（`s3Sync.autoShowRemoteSessions`，缺省开）。 */
export function showRemoteSessions(cfg: { autoShowRemoteSessions?: unknown } | null | undefined): boolean {
  return cfg?.autoShowRemoteSessions !== false;
}

/** catalog 的 `from`（`machineTag`：`<6 位摘要>-<主机名>`）→ 显示用的主机名。 */
export function hostOfTag(from: string | undefined): string {
  const s = String(from || '');
  return s.replace(/^[0-9a-f]{6}-/, '') || s;
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

/** 本机这几条会话里，这一轮要从桶里合并的那些（catalog 先按删除记录收拾过）。 */
export function planBucketMerges(
  catalog: Catalog | null, localIds: Iterable<string>, thisMachine: string, seen: BucketSeen, now = Date.now(),
): CatalogEntry[] {
  if (!catalog || !Array.isArray(catalog.entries)) return [];
  let c: Catalog;
  try { c = normalizeCatalog(catalog, now); } catch { return []; }
  const byId = new Map(c.entries.map((e) => [e.id, e]));
  const out: CatalogEntry[] = [];
  for (const id of localIds) {
    const e = byId.get(id);
    if (e && bucketMergeVerdict(e, thisMachine, seen).merge) out.push(e);
  }
  return out;
}

/* ------------------------------------------------------------------ 外来占位 */

export type RemoteSkip = 'own' | 'no-source' | 'local' | 'placeholder' | 'deleted' | 'excluded' | 'advanced' | 'cloud-trash' | 'bad-id';
export type RemoteRemoveWhy = 'gone' | 'deleted' | 'excluded' | 'advanced' | 'turned-off' | 'cloud-trash';

export interface RemotePlanInput {
  /** 这一轮最新的 catalog（读不到 = null：这一轮不建也不删） */
  catalog: Catalog | null;
  thisMachine: string;
  prefix: string | undefined;
  now: number;
  /** 设置「自动显示其他电脑上的会话」 */
  enabled: boolean;
  /** 本机有的会话（记录 + sessions/ 下的目录 + advanced 的） */
  localIds: ReadonlySet<string>;
  /** 现有的占位（本机移到云端的 + 来自别的电脑的） */
  placeholders: Record<string, OffloadPlaceholder>;
  /** 本机删过的（deleted-sessions.json、s3-deleted-at.json、回收站里的 `<id>__<时间>`、这次运行里删的） */
  deleted: ReadonlySet<string>;
  /** 这一轮云端清理刚移进云端回收站的 */
  inCloudTrash?: ReadonlySet<string>;
  /** 项目 / 会话设成了不同步 */
  excluded: (e: { id: string; project?: string }) => boolean;
  /** KiroLex Advanced 专属的项目（`isAdvancedOnlyProjectName`） */
  advanced: (project: string) => boolean;
}

export interface RemotePlan {
  create: OffloadPlaceholder[];
  /** 已有的外来占位：标题 / 项目 / 归档 / 最后活动跟着 catalog 走 */
  update: OffloadPlaceholder[];
  remove: Array<{ id: string; why: RemoteRemoveWhy }>;
  skipped: Array<{ id: string; reason: RemoteSkip }>;
}

/** 这条占位是不是「从别的电脑来的」（不是本机移到云端的）。 */
export function isRemotePlaceholder(p: OffloadPlaceholder | undefined | null): boolean {
  return !!p && p.origin === 'remote';
}

/** catalog 条目 → 外来占位。打开时按 `cloudKey` 下载（`restoreOffloadedSession`）。 */
export function remotePlaceholderFor(e: CatalogEntry, prefix: string | undefined, now: number): OffloadPlaceholder {
  const project = typeof e.project === 'string' ? e.project.trim() : '';
  return {
    id: e.id,
    title: typeof e.title === 'string' && e.title ? e.title : 'New Chat',
    ...(project ? { project } : null),
    ...(e.archived ? { archived: true } : null),
    lastActiveAt: Number(e.updatedAt) || 0,
    offloadedAt: now,
    cloudKey: sessionPrefix(prefix || '', e.id),
    bytes: Number(e.bytes) || 0,
    files: 0,
    origin: 'remote',
    fromMachine: String(e.from || ''),
    fromHost: hostOfTag(e.from),
    seenUploadedAt: uploadedAtOf(e),
  };
}

/** **这一轮要建 / 改 / 去掉哪些外来占位**。纯函数；本机移到云端的占位一概不碰。 */
export function planRemotePlaceholders(i: RemotePlanInput): RemotePlan {
  const plan: RemotePlan = { create: [], update: [], remove: [], skipped: [] };
  if (!i.catalog || !Array.isArray(i.catalog.entries)) return plan;
  let c: Catalog;
  try { c = normalizeCatalog(i.catalog, i.now); } catch { return plan; }
  const byId = new Map(c.entries.map((e) => [e.id, e]));
  const trash = i.inCloudTrash || new Set<string>();
  const projectOf = (e: { project?: string }): string => (typeof e.project === 'string' ? e.project.trim() : '');

  for (const p of Object.values(i.placeholders)) {
    if (!isRemotePlaceholder(p)) continue;
    /* 本机已经有了（下载回来了、收尾前中断）：占位交给下载那一路收尾，这里不动 */
    if (i.localIds.has(p.id)) continue;
    const e = byId.get(p.id);
    const why: RemoteRemoveWhy | null = !i.enabled ? 'turned-off'
      : i.deleted.has(p.id) ? 'deleted'
      : trash.has(p.id) ? 'cloud-trash'
      : !e ? 'gone'
      : i.excluded({ id: p.id, project: projectOf(e) }) ? 'excluded'
      : projectOf(e) && i.advanced(projectOf(e)) ? 'advanced'
      : null;
    if (why) { plan.remove.push({ id: p.id, why }); continue; }
    const next = { ...remotePlaceholderFor(e!, i.prefix, p.offloadedAt), ...(p.trashDir ? { trashDir: p.trashDir } : null) };
    /* 云端位置不跟着现在的前缀改：建占位时记下的那个才是这份所在的地方（和本机移走的占位同一条） */
    next.cloudKey = p.cloudKey;
    if (JSON.stringify(next) !== JSON.stringify(p)) plan.update.push(next);
  }

  if (!i.enabled) return plan;
  for (const e of c.entries) {
    const skip = (reason: RemoteSkip): void => { plan.skipped.push({ id: e.id, reason }); };
    if (!e?.id || !SAFE_ID.test(e.id)) { if (e?.id) skip('bad-id'); continue; }
    const from = String(e.from || '');
    if (!from) { skip('no-source'); continue; }
    if (from === i.thisMachine) { skip('own'); continue; }
    if (i.localIds.has(e.id)) { skip('local'); continue; }
    if (i.placeholders[e.id]) { skip('placeholder'); continue; }
    if (i.deleted.has(e.id)) { skip('deleted'); continue; }
    if (trash.has(e.id)) { skip('cloud-trash'); continue; }
    const project = projectOf(e);
    if (i.excluded({ id: e.id, project })) { skip('excluded'); continue; }
    if (project && i.advanced(project)) { skip('advanced'); continue; }
    plan.create.push(remotePlaceholderFor(e, i.prefix, i.now));
  }
  return plan;
}

/**
 * 把计划写进占位文件（严格读：文件坏了就不写，返回 null —— 写回会盖掉里面的「保留在本机」名单和本机移走的占位）。
 * 只动外来占位：要去掉 / 更新的那条在文件里已经不是外来的（期间被本机移到云端了）就不动。
 */
export function applyRemotePlaceholders(stateFile: string, plan: RemotePlan): { created: string[]; updated: string[]; removed: string[] } | null {
  if (!plan.create.length && !plan.update.length && !plan.remove.length) return { created: [], updated: [], removed: [] };
  const st = readOffloadStateStrict(stateFile);
  if (!st) return null;
  const created: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  for (const r of plan.remove) {
    if (!isRemotePlaceholder(st.offloaded[r.id])) continue;
    delete st.offloaded[r.id];
    removed.push(r.id);
  }
  for (const p of plan.update) {
    if (!isRemotePlaceholder(st.offloaded[p.id])) continue;
    st.offloaded[p.id] = p;
    updated.push(p.id);
  }
  for (const p of plan.create) {
    if (st.offloaded[p.id]) continue;
    st.offloaded[p.id] = p;
    created.push(p.id);
  }
  if (created.length || updated.length || removed.length) writeOffloadState(stateFile, st);
  return { created, updated, removed };
}

/**
 * 本机删掉一条外来占位（侧栏右键「从这台电脑的列表里移除」）。只删外来的；本机移到云端的不走这里。
 * 调用方接着写删除记录（`noteDeletion`）—— 下一轮不会又建回来，云端回收站也知道这台删过它。
 */
export function dismissRemotePlaceholder(stateFile: string, id: string): { ok: true } | { ok: false; why: string } {
  if (!SAFE_ID.test(id)) return { ok: false, why: 'invalid session id' };
  const st = readOffloadStateStrict(stateFile);
  if (!st) return { ok: false, why: 'the placeholder file is unreadable; not overwriting it' };
  if (!isRemotePlaceholder(st.offloaded[id])) return { ok: false, why: 'not a session from another computer' };
  delete st.offloaded[id];
  writeOffloadState(stateFile, st);
  return { ok: true };
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
