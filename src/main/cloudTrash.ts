/**
 * **云端备份自动清理** ——「S3 云端备份里的会话，如果在所有设备上都已经不在（每台机器都删掉了），
 * 就应该自动丢进回收站，过一定期限后清空」。
 *
 * ## 判据：所有活跃设备的清单里都没有它，而且有人明确删过它
 *
 * 每台机器同步时往 catalog 里写一份自己的「现存会话清单」（`DeviceManifest`：id + 位置 + 上次同步时间 +
 * 本机的删除记录）。一条云端会话只有同时满足下面几条才进回收站（`decideCleanup`）：
 *
 *   · 每一台**活跃设备**（最近 N 天同步过）的清单里都没有它；太久没同步的机器不参与 ——
 *     不然一台丢掉的旧电脑会永远挡住清理；
 *   · 每一台活跃设备的清单都**晚于**这条会话最后一次被上传（catalog 的 `syncedAt`）——
 *     清单比它旧 = 那台机器还没来得及说它有没有，拿不准；
 *   · 至少一台活跃设备有它的**删除记录**，而且那台机器的清单晚于删除时间 —— 这是"删掉了"和
 *     "这台机器压根没见过它 / 重装后是空的"的区别。一台刚重装的机器清单是空的，没有这一条的话，
 *     它第一次同步就会把整个桶的会话判成"所有设备都没有了"；
 *   · 最近同步过、却没有清单的机器（还没升级的旧版本）出现 → 整轮不清。
 *
 * 任何一条拿不准都**不清理**。宁可云上多留一份，不可误删。
 *
 * ## 回收站：先复制、再改 catalog、最后才删原件
 *
 * S3 没有 rename。移进回收站 = 把 `sessions/<id>/` 下的对象逐个复制到 `trash/<id>__<时间>/sessions/<id>/`，
 * 再写一个 `.kirolex-trash.json`（原 catalog 条目 + 进回收站的时间和原因），catalog 去掉这一条，
 * 最后删原件。中途任何一步失败都停在"原件还在"的那一边。保留 M 天，到期由任意一台机器在同步时删掉。
 *
 * 只管会话备份：记忆层、mcp-combos、agent-profiles 都不在这里。
 *
 * 不 import electron、S3 操作经 `BucketOps` 注入 —— 测试用内存里的假桶跑端到端。
 */

import fs from 'fs';
import path from 'path';
import {
  LAYOUT, catalogKey, joinPrefix, sessionPrefix,
  type Catalog, type CatalogEntry, type DeviceManifest,
} from './s3Sync.ts';

export const DAY_MS = 86_400_000;
/** 活跃设备：最近这么多天内同步过。 */
export const DEFAULT_ACTIVE_DEVICE_DAYS = 90;
/** 云端回收站保留天数。 */
export const DEFAULT_CLOUD_TRASH_DAYS = 30;
/** 本机删除记录留多久。过了这么久还没被清理的，说明有别的机器一直留着它；那台机器删的时候会写它自己的记录。 */
export const DELETION_KEEP_DAYS = 365;
/** 回收站里每一份的说明文件名。 */
export const TRASH_META = '.kirolex-trash.json';

/**
 * 条目没有 `uploadedAt`（老版本写的、或者本机没记到真传完的时刻）时，"最后一次上传"按 `syncedAt` 再往后算这么久：
 * `syncedAt` 是那一轮**开始**时生成的，文件可能在它之后好一阵才传完 —— 拿不准就保守一点，晚几个小时清理不要紧。
 */
export const UPLOAD_MARGIN_MS = 6 * 3600_000;

/**
 * 这条会话**最后一次真的传完**是什么时候（拿不准时往后算）：有 `uploadedAt`（文件真传完的时刻）就取它和 `syncedAt` 里晚的那个；
 * 没有就用 `syncedAt + UPLOAD_MARGIN_MS`。设备清单必须比这还晚，才算"那台设备看过它之后说没有"。
 */
export function lastUploadOf(e: CatalogEntry): number {
  const synced = Number(e.syncedAt) || 0;
  const uploaded = Number(e.uploadedAt) || 0;
  return uploaded > 0 ? Math.max(synced, uploaded) : synced + UPLOAD_MARGIN_MS;
}

export interface CleanupSettings { enabled: boolean; activeDays: number; trashDays: number }

const clampDays = (v: unknown, def: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(3650, n) : def;
};

/** 设置里的三项：开关（默认开）、活跃设备天数（默认 90）、回收站保留天数（默认 30）。 */
export function cleanupSettings(cfg: { autoCleanCloud?: unknown; activeDeviceDays?: unknown; cloudTrashDays?: unknown } | null | undefined): CleanupSettings {
  return {
    enabled: cfg?.autoCleanCloud !== false,
    activeDays: clampDays(cfg?.activeDeviceDays, DEFAULT_ACTIVE_DEVICE_DAYS),
    trashDays: clampDays(cfg?.cloudTrashDays, DEFAULT_CLOUD_TRASH_DAYS),
  };
}

const SAFE_ID = /^[\w.-]{1,120}$/;

/* ------------------------------------------------------------------ 本机删除记录 */

/** 本机删过的会话：id → 删除时刻。存在 `~/.kirolex/s3-deleted-at.json`（会话彻底移走后 deleted-sessions.json 会清掉，不能靠它）。 */
export type DeletionMarks = Record<string, number>;

export function readDeletionMarks(file: string): DeletionMarks {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
    const out: DeletionMarks = {};
    for (const [id, at] of Object.entries(d)) if (SAFE_ID.test(id) && Number(at) > 0) out[id] = Number(at);
    return out;
  } catch { return {}; }
}

export function writeDeletionMarks(file: string, marks: DeletionMarks): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(marks));
    fs.renameSync(tmp, file);
  } catch { /* 写不进去只是这条暂时不会被云端清理（拿不准 = 不清），不值得报错 */ }
}

/** 记一条删除（同一条再删一次取新的时间）。 */
export function noteDeletion(file: string, id: string, at: number): void {
  if (!SAFE_ID.test(id)) return;
  const marks = readDeletionMarks(file);
  marks[id] = Math.max(marks[id] || 0, at);
  writeDeletionMarks(file, marks);
}

/** 本机又有这条了（从备份恢复回来）：删除记录作废。 */
export function forgetDeletion(file: string, id: string): void {
  const marks = readDeletionMarks(file);
  if (!(id in marks)) return;
  delete marks[id];
  writeDeletionMarks(file, marks);
}

export function pruneDeletionMarks(marks: DeletionMarks, now: number): DeletionMarks {
  const cutoff = now - DELETION_KEEP_DAYS * DAY_MS;
  return Object.fromEntries(Object.entries(marks).filter(([, at]) => at >= cutoff));
}

/**
 * 本机回收站目录名里的删除记录：`purgeSession` 把会话目录挪成 `trash/<id>__<ISO 时间，: 和 . 换成 ->`。
 * 这张表是新加的；靠它把升级前 30 天内删的那些也补上。认不出的名字（`restore-…`、`memory-pull-…`）跳过。
 */
export function deletionsFromTrashNames(names: string[]): DeletionMarks {
  const out: DeletionMarks = {};
  for (const name of names) {
    const m = /^([\w.-]+?)__(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name);
    if (!m || !SAFE_ID.test(m[1])) continue;
    const at = Date.parse(`${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z`);
    if (at > 0) out[m[1]] = Math.max(out[m[1]] || 0, at);
  }
  return out;
}

/* ------------------------------------------------------------------ 设备 ID */

/**
 * **每个本机数据目录一个独立的设备 ID** —— 清单按它存。原来按 `machineTag(主机名)` 存，两台同名电脑
 * （都叫 MacBook-Pro）会写到同一个键上，后同步的把前一台的清单整个盖掉：一台还有 s1、另一台删了，s1 就被判成没人有了。
 *
 * 存在 `~/.kirolex/device-id.json`（`{ id, host }`）。主机名只用来显示；主机名变了就换一个新 ID ——
 * 这也挡住了"把整个 ~/.kirolex 拷到另一台电脑"的情况（拷过去主机名不一样，不会两台共用一个 ID）。
 * 旧 ID 的清单不删：它会随时间变成"已忽略的设备"，在那之前只会让清理更保守。
 */
export function loadOrCreateDeviceId(file: string, host: string, random: () => string): string {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (d && typeof d.id === 'string' && /^d_[\w-]{8,64}$/.test(d.id) && d.host === host) return d.id;
  } catch { /* 没有 / 坏了：新建 */ }
  const id = `d_${random()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ id, host, createdAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* 写不进去：这一次用这个 ID，下次再换一个 —— 旧的清单会被当成另一台设备，只让清理更保守 */ }
  return id;
}

/* ------------------------------------------------------------------ 清单 */

/**
 * 这台机器这一轮的清单。本机有的会话以"有"为准：同一条又有删除记录（删了又恢复回来）就不报删除。
 * `machine` 是设备 ID（`loadOrCreateDeviceId`），`host` 只用来显示。
 */
export function buildDeviceManifest(
  machine: string,
  now: number,
  sessions: Array<{ id: string; project?: string; archived?: boolean }>,
  deletions: DeletionMarks,
  host?: string,
): DeviceManifest {
  const seen = new Set<string>();
  const list: DeviceManifest['sessions'] = [];
  for (const s of sessions) {
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    list.push({ id: s.id, ...(s.project ? { project: s.project } : null), ...(s.archived ? { archived: true } : null) });
  }
  const deleted = Object.entries(deletions)
    .filter(([id, at]) => !seen.has(id) && at > 0 && at <= now)
    .map(([id, at]) => ({ id, at }));
  return { machine, ...(host ? { host } : null), syncedAt: now, sessions: list, deleted };
}

export function withDeviceManifest(catalog: Catalog, m: DeviceManifest): Catalog {
  return { ...catalog, devices: { ...(catalog.devices || {}), [m.machine]: m } };
}

/** 一份清单读不读得懂。形状不对 = 读不到（不是"那台机器什么都没有"）。 */
export function readableManifest(raw: unknown): DeviceManifest | null {
  const m = raw as DeviceManifest;
  if (!m || typeof m !== 'object' || typeof m.machine !== 'string') return null;
  if (!(Number(m.syncedAt) > 0) || !Array.isArray(m.sessions) || !Array.isArray(m.deleted)) return null;
  if (m.sessions.some((s) => !s || typeof s.id !== 'string')) return null;
  if (m.deleted.some((d) => !d || typeof d.id !== 'string' || !(Number(d.at) > 0))) return null;
  return m;
}

export interface DeviceStatus {
  /** 清单的键（设备 ID）。 */
  machine: string;
  /** 显示用的名字（清单里的主机名；老清单没有就用键）。 */
  name: string;
  syncedAt: number;
  /** 最近 N 天同步过 → 参与判定。 */
  active: boolean;
  /** 清单读得懂。 */
  readable: boolean;
  sessions: number;
}

/**
 * 有哪些设备、哪些参与判定。`unknown` = 最近还往桶里传过会话、却没有清单的机器（旧版本）——
 * 它们手上有什么没人知道，出现一台整轮就不清。
 */
export function describeDevices(catalog: Catalog | null, now: number, activeDays: number): { devices: DeviceStatus[]; unknown: string[] } {
  const cutoff = now - activeDays * DAY_MS;
  const devices: DeviceStatus[] = [];
  for (const [machine, raw] of Object.entries(catalog?.devices || {})) {
    const m = readableManifest(raw);
    const syncedAt = Number((raw as any)?.syncedAt) || 0;
    devices.push({
      machine,
      name: typeof (raw as any)?.host === 'string' && (raw as any).host ? (raw as any).host : machine,
      syncedAt,
      /*
        读不懂的清单也按它写的时间算活跃 —— 活跃却读不懂，正是"拿不准"的那一种。
        **时间本身缺失 / 无效也算活跃**：只有一个有效的、确实早于活跃期限的时间，才能证明这台设备可以忽略；
        时间判断不了就不能忽略它（它这时也是读不懂的 → 整轮不清）。
      */
      active: !(Number.isFinite(syncedAt) && syncedAt > 0) || syncedAt >= cutoff,
      readable: !!m && m.machine === machine,
      sessions: m ? m.sessions.length : 0,
    });
  }
  /* catalog 条目的 from 是主机名标签：有清单的设备按键和主机名都算认识 */
  const known = new Set([...Object.keys(catalog?.devices || {}), ...devices.map((d) => d.name)]);
  const unknown = new Set<string>();
  for (const e of catalog?.entries || []) {
    if (e.from && !known.has(e.from) && (Number(e.syncedAt) || 0) >= cutoff) unknown.add(e.from);
  }
  devices.sort((a, b) => b.syncedAt - a.syncedAt);
  return { devices, unknown: [...unknown].sort() };
}

/**
 * catalog 最近被**重建**过（读不懂、当成空的重新写了一份，见 `Catalog.rebuiltAt`）→ 返回停清理的原因，否则 null。
 * 重建前有哪些设备、它们手上有什么都不知道了；要等过了一个活跃期限 —— 那时还活跃的设备都已经重新同步、登记了清单，
 * 没登记的也不算活跃了 —— 才重新拿得准。重建时间本身读不懂也算"刚重建"。
 */
export function rebuiltHold(catalog: Catalog, now: number, activeDays: number): string | null {
  if (catalog.rebuiltAt === undefined) return null;
  const at = Number(catalog.rebuiltAt);
  if (Number.isFinite(at) && at > 0 && now - at >= activeDays * DAY_MS) return null;
  return `catalog 在 ${Number.isFinite(at) && at > 0 ? fmt(at) : '某个时刻'}因为读不懂被重建过，重建前各设备的清单丢了，${activeDays} 天内不自动清理`;
}

export interface CleanupCandidate {
  entry: CatalogEntry;
  /** 哪几台机器删过它。 */
  deletedBy: string[];
  reason: string;
}

export interface CleanupDecision {
  /** 整轮不清的原因（null = 可以逐条判）。 */
  blocked: string | null;
  devices: DeviceStatus[];
  unknown: string[];
  candidates: CleanupCandidate[];
  /** 没删、因为拿不准的那些（有删除记录但不满足条件）—— 写日志用。 */
  undecided: Array<{ id: string; why: string }>;
}

const fmt = (ms: number): string => new Date(ms).toISOString();

/**
 * **哪些云端会话可以移进回收站**。纯函数；判据见文件头。
 *
 * 只有"有删除记录"的才会被考虑 —— 没人删过的会话（另一台没见过它的机器、重装后清单是空的机器）
 * 永远不是候选。
 */
export function decideCleanup(catalog: Catalog | null, opts: { now: number; activeDays: number }): CleanupDecision {
  const { devices, unknown } = describeDevices(catalog, opts.now, opts.activeDays);
  const out: CleanupDecision = { blocked: null, devices, unknown, candidates: [], undecided: [] };
  const active = devices.filter((d) => d.active);
  if (!catalog) { out.blocked = 'catalog 读不到'; return out; }
  { const hold = rebuiltHold(catalog, opts.now, opts.activeDays); if (hold) { out.blocked = hold; return out; } }
  if (!active.length) { out.blocked = '没有活跃设备的清单'; return out; }
  const unreadable = active.filter((d) => !d.readable);
  if (unreadable.length) { out.blocked = `活跃设备的清单读不到：${unreadable.map((d) => d.name).join('、')}`; return out; }
  if (unknown.length) { out.blocked = `最近同步过、但没有清单的设备（可能是旧版本）：${unknown.join('、')}`; return out; }

  const manifests = active.map((d) => readableManifest(catalog.devices![d.machine])!);
  const nameOf = (m: DeviceManifest): string => m.host || m.machine;
  const present = new Set<string>();
  for (const m of manifests) for (const s of m.sessions) present.add(s.id);

  for (const e of catalog.entries || []) {
    if (!e?.id || !SAFE_ID.test(e.id) || present.has(e.id)) continue;
    const restoredAt = Number(e.restoredFromTrashAt) || 0;
    const marks = manifests
      .map((m) => ({ m, t: m.deleted.find((d) => d.id === e.id) }))
      .filter((x) => x.t && Number(x.t.at) > restoredAt);
    if (!marks.length) continue;                    // 没人删过（或只有恢复之前的旧记录）：不是候选
    const lastUpload = lastUploadOf(e);
    const stale = manifests.filter((m) => m.syncedAt <= lastUpload);
    if (stale.length) {
      out.undecided.push({ id: e.id, why: `${stale.map(nameOf).join('、')} 的清单（${stale.map((m) => fmt(m.syncedAt)).join('、')}）不晚于这条最后一次上传（${fmt(lastUpload)}）` });
      continue;
    }
    const early = marks.filter((x) => x.m.syncedAt <= Number(x.t!.at));
    if (early.length) {
      out.undecided.push({ id: e.id, why: `${early.map((x) => nameOf(x.m)).join('、')} 的清单早于它记的删除时间` });
      continue;
    }
    const deletedBy = marks.map((x) => nameOf(x.m));
    out.candidates.push({
      entry: e,
      deletedBy,
      reason: `${marks.map((x) => `${nameOf(x.m)} 在 ${fmt(Number(x.t!.at))} 删除`).join('；')}；${active.length} 台活跃设备（${active.map((d) => d.name).join('、')}）上都没有了`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ 回收站 */

export interface BucketOps {
  /** `lastModified` 是**服务器**给的修改时间（S3 的 LastModified）—— 用来认出"这个对象后来被重新写过"。 */
  list(prefix: string): Promise<Array<{ key: string; size?: number; lastModified?: string; etag?: string }>>;
  /** 不存在返回 null。 */
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  del(key: string): Promise<void>;
  /** 带 ETag 读（catalog 的条件写入用）。不存在返回 null。 */
  getWithEtag(key: string): Promise<{ body: Buffer; etag: string; versionId?: string } | null>;
  /** 条件写：`ifMatch` = 桶里还是这一版才写；`ifNoneMatch: '*'` = 桶里还没有才写。别人先写了 → 'conflict'。 */
  putIf(key: string, body: Buffer, contentType: string, cond: { ifMatch: string } | { ifNoneMatch: '*' }): Promise<'ok' | 'conflict'>;
  /** 按版本删：对象还是 `etag` 那一版才删。'conflict' = 被改过，没删；'unsupported' = 存储不支持条件删除。 */
  delIf(key: string, etag: string): Promise<'ok' | 'conflict' | 'unsupported'>;
  /** 删一个具体版本（桶开了版本控制时）。 */
  delVersion(key: string, versionId: string): Promise<void>;
  /** 这一个 key 的所有版本，从新到旧；`isDeleteMarker` 为真的是删除标记（普通删除在开了版本控制的桶里留下的）。 */
  listVersions(key: string): Promise<Array<{ versionId: string; isLatest: boolean; isDeleteMarker?: boolean }>>;
  /** 一个前缀下所有有版本的 key（含当前是删除标记、普通列表看不见的）。没开版本控制的桶就是普通的 key。 */
  listVersionKeys(prefix: string): Promise<string[]>;
}
export type CleanupLog = (level: 'info' | 'warn', msg: string) => void;

export function cloudTrashRoot(prefix?: string): string {
  return `${joinPrefix(prefix)}${LAYOUT}/trash/`;
}

/** `<id>__20261023-080910-123`（UTC，带毫秒，同一秒移两次也不撞）。 */
export function trashDirName(id: string, now: number): string {
  const iso = new Date(now).toISOString();
  return `${id}__${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${iso.slice(20, 23)}`;
}

/** 回收站目录名 → 会话 id 和时间（说明文件读不到时给界面兜底显示；**不**拿它算到期）。 */
export function parseTrashDirName(dir: string): { id: string; at: number } | null {
  const m = /^([\w.-]+?)__(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/.exec(dir);
  if (!m || !SAFE_ID.test(m[1])) return null;
  const at = Date.parse(`${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:${m[7]}.${m[8]}Z`);
  return at > 0 ? { id: m[1], at } : null;
}

export interface TrashMeta {
  id: string;
  trashedAt: number;
  /** 哪台机器移进来的。 */
  by: string;
  reason: string;
  deletedBy: string[];
  /** 原来那条 catalog 条目 —— 恢复时放回去。 */
  entry: CatalogEntry;
  objects: number;
  /**
   * 移进回收站之后**没删掉的原件**（`sessions/<id>/` 下）和复制那一刻服务器给它的修改时间。
   * 每轮同步重试删（`retryPendingOriginals`）；修改时间对不上 = 后来被重新写过，不删。没删完之前这一份不做到期清空。
   */
  pendingOriginals?: OriginalVersion[];
  /**
   * **撤回没做完**：有设备又往原位置传了新内容，这次移动要撤回（把回收站里的放回原位置），但没放完 ——
   * 那些没放回去的文件此刻**只有回收站这一份**。在撤回做完之前：不到期清空、不许手动彻底删除，每轮同步重试撤回。
   */
  undoPending?: boolean;
  /**
   * **这次移动还没做完**：复制进回收站时就写上（那时原件一个都还没删 —— 写不进去，复制就算失败、整个回滚），
   * 原件全部按版本删完之后才去掉。带着它的这一份：不到期清空、每轮同步接着把移动做完（或者撤回）。
   * 去掉它那一步失败了也没关系 —— 只是多保护一轮。
   */
  moving?: boolean;
  /**
   * **跨设备的锁**（说明文件本身就是锁：只用条件写改它，见 `updateTrashMeta`）——
   * `restoring`：有人正在把这一份放回原位置（恢复到云端备份 / 撤回），读回收站里的文件之前就写上；
   * `purging`：有人正在彻底删除这一份，删之前写上。两者互斥：看到对方的锁就不动；
   * 两边读到同一版说明文件、同时去写，条件写只有一边成功。恢复中途失败时 restoring 留着 —— 这一份就一直不会被自动清空。
   */
  restoring?: { at: number; by: string };
  purging?: { at: number; by: string };
  /**
   * `deleting`：有人正在删这一份的原件（**只在桶没开版本控制时**才用 —— 那时只能按 ETag 删，而恢复写回同样的内容 ETag 也一样，
   * 必须和恢复 / 撤回互斥）。开了版本控制时按 VersionId 删，恢复写进去的是新版本，不需要这把锁。
   */
  deleting?: { at: number; by: string };
}

/** 手动彻底删除时，"正在恢复"的锁超过这么久才当成半途失败留下的、可以删（自动清空永远不越过它）。 */
export const RESTORE_LOCK_STALE_MS = 3600_000;

/** 一个原件和复制进回收站那一刻它的版本（ETag 是复制时 GET 回来的那个 = 复制的正是这一版）。 */
export interface OriginalVersion {
  key: string;
  etag?: string;
  lastModified?: string;
  /** 复制那一刻这个原件的 VersionId（桶开了版本控制才有）—— 删原件就删这一版（和更早的），见 `deleteOriginalVersion`。 */
  versionId?: string;
}

/** 是不是一个"开了版本控制之后才有"的真实版本号（"null" = 开版本控制之前写的 / 没开 / 暂停时写的那一版）。 */
export const realVersionId = (v: string | undefined): v is string => !!v && v !== 'null';

/** 锁的主人是不是这台设备（锁主写成 `<设备 ID>#<这一轮>`）：同一台设备同时只跑一轮同步，它自己以前那一轮留下的锁说明那一轮已经不在了。 */
export const sameDevice = (by: string | undefined, deviceId: string): boolean => !!by && by.split('#')[0] === deviceId;

/** 一把锁（restoring / deleting）是不是新的：超过 `RESTORE_LOCK_STALE_MS` 当成半途失败留下的。 */
const lockFresh = (l: { at: number } | undefined, now = Date.now()): boolean => !!l && now - (Number(l.at) || 0) < RESTORE_LOCK_STALE_MS;

export interface TrashItem {
  dir: string;
  id: string;
  title: string;
  project?: string;
  archived?: boolean;
  /** 0 = 说明文件读不到，时间未知 —— 不会自动到期删除。 */
  trashedAt: number;
  expiresAt: number;
  daysLeft: number;
  by?: string;
  deletedBy: string[];
  reason?: string;
  objects: number;
  bytes: number;
  /** 这一份的全部对象 key（含说明文件）。 */
  keys: string[];
  /** 说明文件原样（读不到是 null）—— 改写它（记 / 清 pendingOriginals）时用。 */
  meta: TrashMeta | null;
  /** 还没删掉的原件（见 `TrashMeta.pendingOriginals`）。 */
  pendingOriginals: OriginalVersion[];
  /** 撤回没做完（见 `TrashMeta.undoPending`）—— 这一份不能删。 */
  undoPending: boolean;
  /** 移动还没做完（见 `TrashMeta.moving`）—— 这一份不能删。 */
  moving: boolean;
  /** 有人正在恢复 / 撤回它（见 `TrashMeta.restoring`）。 */
  restoring: boolean;
}

export function daysLeft(trashedAt: number, now: number, trashDays: number): number {
  if (!trashedAt) return trashDays;
  return Math.max(0, Math.ceil((trashedAt + trashDays * DAY_MS - now) / DAY_MS));
}

/** 到期了没有。时间未知（说明文件读不到）的永远不算到期 —— 只能手动删。 */
export function trashExpired(trashedAt: number, now: number, trashDays: number): boolean {
  return trashedAt > 0 && now >= trashedAt + trashDays * DAY_MS;
}

/** 列回收站：按 `trash/<目录>/` 分组，读每份的说明文件。 */
export async function listCloudTrash(bucket: BucketOps, prefix: string | undefined, now: number, trashDays: number): Promise<TrashItem[]> {
  const root = cloudTrashRoot(prefix);
  const byDir = new Map<string, Array<{ key: string; size?: number }>>();
  for (const o of await bucket.list(root)) {
    if (!o.key.startsWith(root)) continue;
    const dir = o.key.slice(root.length).split('/')[0];
    if (!dir) continue;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(o);
  }
  const items: TrashItem[] = [];
  for (const [dir, objs] of byDir) {
    let meta: TrashMeta | null = null;
    if (objs.some((o) => o.key === `${root}${dir}/${TRASH_META}`)) {
      try {
        const raw = await bucket.get(`${root}${dir}/${TRASH_META}`);
        const m = raw ? JSON.parse(raw.toString('utf-8')) : null;
        if (m && typeof m.id === 'string' && Number(m.trashedAt) > 0) meta = m;
      } catch { meta = null; }
    }
    const parsed = parseTrashDirName(dir);
    const id = meta?.id || parsed?.id || dir;
    const trashedAt = meta ? Number(meta.trashedAt) : 0;
    const content = objs.filter((o) => !o.key.endsWith(`/${TRASH_META}`));
    items.push({
      dir,
      id,
      title: meta?.entry?.title || id,
      project: meta?.entry?.project,
      archived: !!meta?.entry?.archived,
      trashedAt,
      expiresAt: trashedAt ? trashedAt + trashDays * DAY_MS : 0,
      daysLeft: daysLeft(trashedAt, now, trashDays),
      by: meta?.by,
      deletedBy: Array.isArray(meta?.deletedBy) ? meta!.deletedBy : [],
      reason: meta?.reason,
      objects: content.length,
      bytes: content.reduce((s, o) => s + (Number(o.size) || 0), 0),
      keys: objs.map((o) => o.key),
      meta,
      pendingOriginals: Array.isArray(meta?.pendingOriginals) ? meta!.pendingOriginals.filter((x) => x && typeof x.key === 'string') : [],
      undoPending: !!meta?.undoPending,
      moving: !!meta?.moving,
      restoring: !!meta?.restoring,
    });
  }
  return items.sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
}

async function readCatalog(bucket: BucketOps, prefix: string | undefined): Promise<Catalog | null> {
  const raw = await bucket.get(catalogKey(prefix));
  if (!raw) return null;
  const c = JSON.parse(raw.toString('utf-8'));
  if (!c || !Array.isArray(c.entries)) throw new Error('catalog 的格式不对');
  return c as Catalog;
}

/** catalog 被别的机器抢先改了，最多重读重算几次。 */
export const CATALOG_WRITE_TRIES = 5;

/**
 * **改 catalog：读到哪一版，就只在桶里还是那一版时写** —— 多台机器同时同步时，拿开头读的旧快照无条件写回去
 * 会抹掉别的机器这期间写进来的清单（它刚说"我还有 s1"，被盖回旧的那份，s1 就会被误判成没人有了）。
 *
 * `mutate` 拿到桶里**当前**那份（读不懂时 `unreadable` 为真、`cur` 为 null），返回要写的新 catalog；
 * 返回 null = 这一次不写。条件写被别人抢先（412 / 409）→ 重新读、重新 `mutate`（判定也跟着重做）再试；
 * 连着 `CATALOG_WRITE_TRIES` 次都被抢先就抛。
 *
 * 桶不回 ETag（个别 S3 兼容存储）时没法条件写：`requireEtag` 为真（云端清理、回收站恢复）就**不写**
 * （`noEtag: true`）；否则（备份本身的同步）只能普通写 —— 不写的话这类存储上备份就停了。
 * 那种情况下别的机器的清单可能被覆盖，所以云端清理在拿不到 ETag 时整轮不动（见 `runCloudCleanup`）。
 */
export async function updateCatalog(
  bucket: BucketOps, prefix: string | undefined,
  mutate: (cur: Catalog | null, unreadable: boolean) => Catalog | null,
  opts: { requireEtag?: boolean } = {},
): Promise<{ written: Catalog | null; tries: number; noEtag?: boolean }> {
  const key = catalogKey(prefix);
  for (let i = 1; i <= CATALOG_WRITE_TRIES; i++) {
    const got = await bucket.getWithEtag(key);
    let cur: Catalog | null = null;
    let unreadable = false;
    if (got) {
      try {
        const c = JSON.parse(got.body.toString('utf-8'));
        if (c && Array.isArray(c.entries)) cur = c as Catalog; else unreadable = true;
      } catch { unreadable = true; }
    }
    if (got && !got.etag && opts.requireEtag) return { written: null, tries: i, noEtag: true };
    const next = mutate(cur, unreadable);
    if (!next) return { written: null, tries: i, ...(got && !got.etag ? { noEtag: true } : null) };
    const body = Buffer.from(JSON.stringify(next, null, 2));
    if (got && !got.etag) { await bucket.put(key, body, 'application/json'); return { written: next, tries: i, noEtag: true }; }
    const r = await bucket.putIf(key, body, 'application/json', got ? { ifMatch: got.etag } : { ifNoneMatch: '*' });
    if (r === 'ok') return { written: next, tries: i };
  }
  throw new Error(`catalog 连续 ${CATALOG_WRITE_TRIES} 次在写之前都被别的机器抢先改了，这一轮不写（没有覆盖对方）`);
}

/**
 * **彻底删掉回收站里的一个对象**：桶开了版本控制时，普通删除只加一个删除标记，历史版本（和说明文件改过的每一版）都还在桶里、
 * 列表上看不见、以后也没人再管 —— 那不是"彻底删除"。所以按 VersionId 把它的**全部版本和删除标记**都删掉。
 * 桶没开版本控制（列不出版本，或版本号是 "null"）→ 普通删除。只用在回收站里的对象上。
 */
export async function deleteAllVersions(bucket: BucketOps, key: string): Promise<void> {
  let listed: Awaited<ReturnType<BucketOps['listVersions']>>;
  try { listed = await bucket.listVersions(key); } catch (err) {
    /*
      列不出版本（常见：密钥没有 s3:ListBucketVersions）：桶没开版本控制（读回来没有 VersionId）→ 普通删除就是彻底删除；
      开了 → 抛，下一轮再试（不留一个只加了删除标记、历史版本还在的"假删除"）。
    */
    const got = await bucket.getWithEtag(key).catch(() => null);
    if (got && !realVersionId(got.versionId)) { await bucket.del(key); return; }
    if (!got) return;                                     // 已经没了
    throw err;
  }
  /*
    "null" 版本也要按版本删：桶开版本控制**之前**写进去的对象留着一个 VersionId 为 null 的版本，之后又有正常版本 ——
    只删正常版本的话，这个 null 版本还在、甚至重新变成当前对象。没开版本控制的桶列出来的也是 null 版本，按 null 删就是删掉它。
  */
  const vs = listed.filter((v) => v.versionId);
  if (!vs.length) { await bucket.del(key); return; }
  for (const v of vs) await bucket.delVersion(key, v.versionId);
}

/** 尽量删掉一批回收站里的 key（回滚用），删不掉的不抛。 */
async function delAll(bucket: BucketOps, keys: string[]): Promise<number> {
  let n = 0;
  for (const k of keys) { try { await deleteAllVersions(bucket, k); n += 1; } catch { /* 留着，下次再说 */ } }
  return n;
}

/**
 * 删掉回收站里的一份：**先删内容，全部删掉之后最后才删说明文件**。说明文件里有进回收站的时间 ——
 * 先删了它，删不完的内容就变成"时间未知"，永远不会再自动到期清空。删不全就留着说明文件，下次重试。
 *
 * 要删的不只是普通列表里看得见的 key：上一次删到一半（比如删掉了最新版本、删除标记那一下失败了）的 key
 * 只剩"删除标记 + 旧版本"，普通列表里没有它。所以按**版本列表**把这一份目录（\`…/trash/<dir>/\`，从 keys 推出来）整个枚举一遍；
 * 删完内容再按版本列表核对一次，目录里除了说明文件一个版本都不剩，才删说明文件。
 * 版本列不出来（没有 ListBucketVersions 权限）：桶没开版本控制 → 普通列表就是全部，照常删；开了 → 不删，下次再试。
 */
export async function deleteTrashObjects(bucket: BucketOps, keysIn: string[]): Promise<{ deleted: number; failed: string[] }> {
  const failed: string[] = [];
  let deleted = 0;
  const all = new Set(keysIn);
  const dirPrefix = keysIn.map((k) => (/^(.*\/trash\/[^/]+\/)/.exec(k) || [])[1]).find(Boolean);
  let canVerify = false;
  if (dirPrefix) {
    try {
      for (const k of await bucket.listVersionKeys(dirPrefix)) all.add(k);
      canVerify = true;
    } catch (err: any) {
      const metaKey = `${dirPrefix}${TRASH_META}`;
      const got = await bucket.getWithEtag(metaKey).catch(() => null);
      if (realVersionId(got?.versionId)) return { deleted, failed: [`${dirPrefix}: 列不出版本（开了版本控制的桶要 s3:ListBucketVersions），这一次不删：${err?.message || err}`] };
    }
  }
  const keys = [...all];
  const metas = keys.filter((k) => k.endsWith(`/${TRASH_META}`));
  const content = keys.filter((k) => !k.endsWith(`/${TRASH_META}`));
  for (const k of content) {
    try { await deleteAllVersions(bucket, k); deleted += 1; } catch (err: any) { failed.push(`${k}: ${err?.message || err}`); }
  }
  if (failed.length) return { deleted, failed };
  if (canVerify && dirPrefix) {
    let left: string[] = [];
    try { left = (await bucket.listVersionKeys(dirPrefix)).filter((k) => !k.endsWith(`/${TRASH_META}`)); } catch (err: any) {
      return { deleted, failed: [`${dirPrefix}: 删完核对不了还剩没剩版本，说明文件先留着：${err?.message || err}`] };
    }
    if (left.length) return { deleted, failed: left.map((k) => `${k}: 还有版本没删掉，说明文件先留着`) };
  }
  for (const k of metas) {
    try { await deleteAllVersions(bucket, k); deleted += 1; } catch (err: any) { failed.push(`${k}: ${err?.message || err}`); }
  }
  return { deleted, failed };
}

/**
 * 把一条会话的对象复制进回收站（**不**删原件、不改 catalog —— 那两步由调用方按顺序做）。
 * 复制中途失败：把已经复制过去的删掉再抛，原件一直都在。没有对象返回 null。
 */
export async function copySessionToCloudTrash(
  bucket: BucketOps, prefix: string | undefined, c: CleanupCandidate, now: number, by: string,
): Promise<{ dir: string; originals: OriginalVersion[]; copies: string[]; meta: TrashMeta } | null> {
  const src = sessionPrefix(prefix || '', c.entry.id);
  const objs = (await bucket.list(src)).filter((o) => o.key.startsWith(src));
  if (!objs.length) return null;
  const dir = trashDirName(c.entry.id, now);
  const dst = `${cloudTrashRoot(prefix)}${dir}/`;
  const inner = `sessions/${c.entry.id}/`;
  const copies: string[] = [];
  const originals: OriginalVersion[] = [];
  let meta: TrashMeta;
  try {
    for (const o of objs) {
      /* 带 ETag 读：记下复制的正是哪一版，之后只删这一版 */
      const got = await bucket.getWithEtag(o.key);
      if (!got) throw new Error(`读不到 ${o.key}`);
      const to = `${dst}${inner}${o.key.slice(src.length)}`;
      await bucket.put(to, got.body);
      copies.push(to);
      /* 版本号原样记，包括 "null"（开版本控制之前写的那一版）—— 丢了它，之后只能按 ETag 删，开着版本控制的桶里那只会加个删除标记 */
      originals.push({ key: o.key, etag: got.etag || o.etag, lastModified: o.lastModified, ...(got.versionId ? { versionId: got.versionId } : null) });
    }
    /* moving + 全部原件待删：从这一刻起，在移动做完之前这一份不会被清空（见 TrashMeta.moving） */
    meta = { id: c.entry.id, trashedAt: now, by, reason: c.reason, deletedBy: c.deletedBy, entry: c.entry, objects: objs.length, moving: true, pendingOriginals: originals };
    if (await bucket.putIf(`${dst}${TRASH_META}`, Buffer.from(JSON.stringify(meta, null, 2)), 'application/json', { ifNoneMatch: '*' }) !== 'ok') {
      throw new Error('回收站里同名的说明文件已经在了');
    }
    copies.push(`${dst}${TRASH_META}`);
  } catch (err) {
    await delAll(bucket, copies);
    throw err;
  }
  return { dir, originals, copies, meta };
}

const sameEtag = (a?: string, b?: string): boolean => !!a && !!b && a.replace(/^W\//, '').replace(/"/g, '') === b.replace(/^W\//, '').replace(/"/g, '');

/**
 * 原件从复制到现在有没有变：多了文件、少了文件、或者哪个文件的版本（ETag，没有就比修改时间）对不上 → 变了。
 * 变了 = 有设备正在往这条会话传东西，它不该被移走。
 */
export async function originalsChanged(bucket: BucketOps, prefix: string | undefined, id: string, originals: OriginalVersion[]): Promise<string | null> {
  const src = sessionPrefix(prefix || '', id);
  const now = (await bucket.list(src)).filter((o) => o.key.startsWith(src));
  const byKey = new Map(originals.map((o) => [o.key, o]));
  for (const o of now) {
    const was = byKey.get(o.key);
    if (!was) return `多了 ${o.key}`;
    const ok = was.etag && o.etag ? sameEtag(was.etag, o.etag) : (!!was.lastModified && was.lastModified === o.lastModified);
    if (!ok) return `${o.key} 被更新过`;
  }
  if (now.length !== originals.length) return '少了文件';
  return null;
}

/**
 * **只删复制的那一版**。
 *
 * **桶开了版本控制（记到了 VersionId，主路径）**：按 VersionId 删 —— 删复制的那一版和**比它更早的**那些版本（只删复制的那一版的话，
 * 更旧的那版会顶上来，原件以旧内容"复活"）；**比它新的版本一个不碰**：恢复 / 别的设备写进来的都是新版本，VersionId 不同，
 * 这一步就算晚到也碰不到它们。先删更早的、最后删复制的那一版 —— 这样中途断了再来时，"复制的那一版不在了"只可能是
 * 更早的也都删完了，剩下的就一定是更新的。删之前已经有更新的版本 → 'changed'（有人在用，调用方撤回）。
 *
 * **桶没开版本控制**：条件删除（`delIf`，带复制时的 ETag）——被别的设备更新过就不删（'changed'）。恢复写回同样的内容时
 * ETag 也一样，所以这条路**必须在拿着 deleting 锁的时候走**（调用方 `deleteOriginalsOfMove` 负责），和恢复 / 撤回互斥。
 * 没有"先核对再普通删"的退路；存储不支持条件删除、或者没记到 ETag → 'unsupported'，不删。删不掉（网络等）抛出，由调用方记下来下次重试。
 *
 * **VersionId 是 "null" 的原件**（桶开版本控制**之前**写进去、之后没重写过）：桶**现在是开着的**（`versioningEnabled`）→ 也按版本删
 * 这个 null 版本 —— 之后的写入都是新的、非 null 的版本，碰不到；按 ETag 条件删的话只会加一个删除标记，null 版本永远留在桶里。
 * 桶现在没开 / 暂停（新写入会**覆盖** null 版本）→ 按版本删可能删掉别的设备刚传的内容，只能走 ETag 条件删除。两种都在 deleting 锁下做。
 */
export async function deleteOriginalVersion(bucket: BucketOps, o: OriginalVersion, versioningEnabled = false): Promise<'deleted' | 'changed' | 'unsupported'> {
  if (realVersionId(o.versionId) || (o.versionId === 'null' && versioningEnabled)) {
    const versions = (await bucket.listVersions(o.key)).filter((v) => !v.isDeleteMarker);
    const idx = versions.findIndex((v) => v.versionId === o.versionId);
    if (idx < 0) return versions.length ? 'changed' : 'deleted';   // 复制的那一版（和更早的）已经删了；剩下的只可能是更新的
    if (idx > 0) return 'changed';                                  // 复制之后又有新版本：有人在用
    for (const v of versions.slice(idx + 1)) await bucket.delVersion(o.key, v.versionId);   // 先删更早的
    await bucket.delVersion(o.key, o.versionId);                                             // 最后删复制的那一版
    return 'deleted';
  }
  if (!o.etag) return 'unsupported';
  const r = await bucket.delIf(o.key, o.etag);
  if (r === 'ok') return 'deleted';
  if (r === 'conflict') return 'changed';
  return 'unsupported';
}

/**
 * **这个存储真的支持按版本删除吗**：写一个探测对象，用一个**故意错的**版本去删 —— 支持的会拒绝（412 → 'conflict'）；
 * 不支持的要么明说（'unsupported'），要么**悄悄忽略 If-Match 照删不误**（'ok'）。后两种都当不支持：
 * 那样的存储上删原件没法保证不删掉别的设备刚传的新版本，云端清理就不移任何会话。
 */
export async function probeConditionalDelete(bucket: BucketOps, prefix: string | undefined): Promise<boolean> {
  return (await probeDeleteMode(bucket, prefix)) !== 'none';
}

/**
 * 删原件能走哪条路：'versioned' = 桶**现在开着**版本控制（新写进去的对象带真实 VersionId）→ 按版本删；
 * 'conditional' = 没开 / 暂停，但支持 If-Match 条件删除；'none' = 都不行（不移任何会话）。
 */
export async function probeDeleteMode(bucket: BucketOps, prefix: string | undefined): Promise<'versioned' | 'conditional' | 'none'> {
  const key = `${joinPrefix(prefix)}${LAYOUT}/.kirolex-conditional-delete-probe`;
  await bucket.put(key, Buffer.from(new Date().toISOString()), 'text/plain');
  /* 桶开了版本控制（写进去有真实 VersionId）→ 删原件走按 VersionId 删，不需要 If-Match；探测对象按版本删干净 */
  const got = await bucket.getWithEtag(key);
  if (realVersionId(got?.versionId)) {
    try { for (const v of await bucket.listVersions(key)) await bucket.delVersion(key, v.versionId); } catch { /* 探测对象留着也无害 */ }
    return 'versioned';
  }
  let r: 'ok' | 'conflict' | 'unsupported';
  try { r = await bucket.delIf(key, '"kirolex-not-this-version"'); } finally {
    try { await deleteAllVersions(bucket, key); } catch { /* 探测对象留着也无害，下次同 key 覆盖 */ }
  }
  return r === 'conflict' ? 'conditional' : 'none';
}

/**
 * **把回收站里的一个文件放回原位置**（恢复 / 撤回共用）：
 *   · 原位置没有 → 写进去（If-None-Match: *）；
 *   · 原位置有，而且**正是复制进回收站的那一版**（VersionId 一样）→ 按它的 ETag 条件写一次同样的内容，变成一个**新版本**：
 *     删原件那一边只删复制的那一版（按 VersionId），留着它不动的话，恢复做完之后它照样会被删掉，而回收站那份已经没了；
 *   · 原位置有别的版本（别的设备后来传的）→ 保留，不盖。
 */
/**
 * 说明文件上现在有没有 `deleting` 锁（不管多旧）。有 → 删原件的那一边可能还会醒来接着按 ETag 删，
 * 回收站那份就是那些文件唯一的保底，恢复 / 撤回做完了也**不删它**，等持锁的一方自己把锁去掉。读不出来也当有。
 */
async function deletingLockOn(bucket: BucketOps, prefix: string | undefined, dir: string): Promise<boolean> {
  try {
    const got = await bucket.getWithEtag(`${cloudTrashRoot(prefix)}${dir}/${TRASH_META}`);
    if (!got) return false;
    return !!(JSON.parse(got.body.toString('utf-8')) as TrashMeta).deleting;
  } catch { return true; }
}

async function putBackOriginal(bucket: BucketOps, to: string, body: Buffer, copied: OriginalVersion | undefined): Promise<'restored' | 'kept'> {
  /*
    循环到能确认为止：条件写冲突、或者读的时候文件刚好被删了（删原件那一边正在删）→ 重新看一次。
    只有确认原位置是**别的版本**（不是复制的那一版）才算"保留"；几次都确认不了 → 抛（调用方让恢复 / 撤回失败、回收站那份留着）。
  */
  for (let i = 0; i < CATALOG_WRITE_TRIES; i++) {
    if (await bucket.putIf(to, body, 'application/octet-stream', { ifNoneMatch: '*' }) === 'ok') return 'restored';
    const cur = await bucket.getWithEtag(to);
    if (!cur) continue;                                   // 刚被删了：再写一次
    /*
      没记到版本号、或者是 "null"：有就留着（删原件那边和恢复靠 deleting / restoring 锁错开，见 deleteOriginalsOfMove）。
      "null" **不能**拿来认"还是复制的那一版"：桶暂停版本控制时，新上传会覆盖 null 版本、版本号照样是 "null" ——
      按它重写，就是拿回收站里的旧内容盖掉别的设备刚传的新内容。只有真实版本号才认得出是同一版。
    */
    if (!realVersionId(copied?.versionId)) return 'kept';
    if (cur.versionId && cur.versionId !== copied.versionId) return 'kept';   // 别的设备后来传的新版本：不盖
    if (cur.versionId === copied.versionId && cur.etag
      && await bucket.putIf(to, body, 'application/octet-stream', { ifMatch: cur.etag }) === 'ok') return 'restored';
  }
  throw new Error(`${to} 连续几次都确认不了放回去没有（删原件那边正在动它），这一次不算恢复成功`);
}

/** 说明文件里记的"复制进回收站的那一版"（按原件 key）。 */
const copiedVersions = (m: TrashMeta | null | undefined): Map<string, OriginalVersion> =>
  new Map((m?.pendingOriginals || []).filter((o) => o && typeof o.key === 'string').map((o) => [o.key, o]));

/**
 * **删一次移动的原件**（首次删除和重试共用）。
 *
 * 都记到了 VersionId（桶开了版本控制）→ 直接按版本删，不需要锁。有没记到的（桶没开版本控制）→ 先用条件写在说明文件上拿
 * `deleting` 锁（和恢复 / 撤回 / 彻底删除互斥），**拿不到就这一次一个都不删**（'locked'，下轮再试）；拿到了才按 ETag 删，
 * 删完由调用方收尾时去掉锁。返回 'changed' 时锁已经放掉了（调用方接着撤回，撤回要拿 restoring 锁）。
 */
export async function deleteOriginalsOfMove(
  bucket: BucketOps, prefix: string | undefined, dir: string, originals: OriginalVersion[], by: string, log: CleanupLog,
  versioningEnabled = false,
): Promise<{ result: 'done' | 'changed' | 'locked'; failed: OriginalVersion[]; deleted: number }> {
  /* 只有真实版本号才不需要锁；没记到的、和 "null"（开版本控制之前的那一版）都要锁 */
  const needLock = originals.some((o) => !realVersionId(o.versionId));
  if (needLock) {
    let locked: TrashMeta | null = null;
    try {
      /*
        不越过**任何** restoring（不管多旧 —— 恢复可能只是停住了，醒来还会接着写、接着删回收站那份）和**别的设备**的 deleting；
        这台设备自己以前那一轮留下的 deleting 可以接手（那一轮已经不在了）。
      */
      locked = await updateTrashMeta(bucket, prefix, dir, (m) => {
        if (m.purging || m.restoring || (m.deleting && m.deleting.by !== by && !sameDevice(m.deleting.by, by.split('#')[0]))) return null;
        return { ...m, deleting: { at: Date.now(), by } };
      });
    } catch (err: any) {
      log('warn', `云端清理：trash/${dir}/ 删原件之前上不了锁（${err?.message || err}），这一次不删，下轮再试`);
      return { result: 'locked', failed: [...originals], deleted: 0 };
    }
    if (!locked) {
      log('info', `云端清理：trash/${dir}/ 有人正在恢复 / 撤回 / 删它（说明文件上有锁），这一次不删原件，下轮再试`);
      return { result: 'locked', failed: [...originals], deleted: 0 };
    }
  }
  const failed: OriginalVersion[] = [];
  let deleted = 0;
  let changed = false;
  for (const o of originals) {
    try {
      const r = await deleteOriginalVersion(bucket, o, versioningEnabled);
      if (r === 'deleted') deleted += 1;
      else if (r === 'changed') { changed = true; break; }
      else failed.push(o);                                  // 确认不了版本：不删，留着
    } catch { failed.push(o); }
  }
  if (changed && needLock) {
    try { await patchTrashMeta(bucket, prefix, dir, (m) => { const { deleting: _d, ...rest } = m; return rest; }); } catch { /* 锁过一阵算失效，撤回照样能拿到 */ }
  }
  return { result: changed ? 'changed' : 'done', failed, deleted };
}

/**
 * **撤回一次移动**：有设备在这条会话移进回收站的过程中（或之后）又往原位置传了新内容 —— 它还在用。
 * 那台设备只会重传它改过的文件（别的它记着已经传过），所以已经删掉的原件要从回收站拷回去（只补缺的，不盖新的），
 * catalog 里放回原条目，全都放回去了才删回收站那份。放不回去就留着回收站那份，一个字节都不丢。
 */
export async function undoCloudTrashMove(
  bucket: BucketOps, prefix: string | undefined, dir: string, metaIn: TrashMeta, log: CleanupLog,
): Promise<boolean> {
  let meta = metaIn;
  const id = meta.id;
  const base = `${cloudTrashRoot(prefix)}${dir}/`;
  const inner = `${base}sessions/${id}/`;
  const dst = sessionPrefix(prefix || '', id);
  /*
    **先落盘"待撤回"**：撤回中途失败的话，这一份里就有只此一份的文件。写不进去也照样撤回（撤回只补文件、不删东西）——
    那种情况下这一份身上至少还有复制时写的 moving 标记；调用方这一轮也会跳过它，到期清空还会再核对它是不是又在用了。
  */
  /*
    上锁：写上 restoring（跨设备：别的设备的到期清空看到它就不删）和 undoPending。看到 purging（有人已经在彻底删除）→ 不撤回。
    锁写不进去（网络等）也照样撤回 —— 撤回只补文件、不删东西；这时靠 moving 标记、这一轮的跳过名单和到期前"又在用了"的核对挡着。
  */
  let purgingNow = false;
  try {
    const locked = await updateTrashMeta(bucket, prefix, dir, (m) => {
      if (m.purging || lockFresh(m.deleting)) { purgingNow = true; return null; }
      return { ...m, undoPending: true, restoring: m.restoring || { at: Date.now(), by: 'undo' } };
    });
    if (locked) meta = locked;
  } catch (err: any) {
    log('warn', `云端清理：撤回 ${id} 之前上不了锁（靠 moving 标记和到期前的核对挡着）：${err?.message || err}`);
  }
  if (purgingNow) {
    log('warn', `云端清理：撤回 ${id} 时发现有人正在删这一份（彻底删除 / 删原件），这一次不撤回`);
    return false;
  }
  const objs = (await bucket.list(base)).filter((o) => o.key.startsWith(base));
  const copied = copiedVersions(meta);
  let ok = true;
  for (const o of objs) {
    if (!o.key.startsWith(inner)) continue;
    const to = `${dst}${o.key.slice(inner.length)}`;
    try {
      const body = await bucket.get(o.key);
      if (!body) { ok = false; continue; }
      await putBackOriginal(bucket, to, body, copied.get(to));   // 缺的补上；还是复制的那一版的换成新版本；别人的新版本不盖
    } catch (err: any) {
      ok = false;
      log('warn', `云端清理：撤回 ${id} 时 ${to} 放不回去：${err?.message || err}`);
    }
  }
  /*
    catalog：放回条目，并且和「恢复到云端备份」一样记下 restoredFromTrashAt —— 撤回 = 它还在用；不记的话
    之前那批删除记录还算数，下一轮又把它（连同别的设备刚传的新内容）移进回收站。之后有人再删才会再进来。
  */
  const at = Date.now();
  try {
    await updateCatalog(bucket, prefix, (cur, unreadable) => {
      if (unreadable || !cur) return null;
      const has = (cur.entries || []).some((e) => e.id === id);
      return {
        ...cur,
        entries: has
          ? cur.entries.map((e) => (e.id === id ? { ...e, restoredFromTrashAt: Math.max(Number(e.restoredFromTrashAt) || 0, at) } : e))
          : [{ ...meta.entry, restoredFromTrashAt: at }, ...(cur.entries || [])],
      };
    }, { requireEtag: true });
  } catch (err: any) {
    log('warn', `云端清理：撤回 ${id} 时 catalog 写不进去（上传它的设备同步时会把条目带回来）：${err?.message || err}`);
  }
  if (!ok) {
    log('warn', `云端清理：撤回 ${id} 没有全部放回去，回收站那份 trash/${dir}/ 留着（待撤回：不到期清空、不许手动删，下次同步接着放）`);
    return false;
  }
  if (await deletingLockOn(bucket, prefix, dir)) {
    log('warn', `云端清理：撤回 ${id} 的文件都放回去了，但说明文件上还有"正在删原件"的锁（那一边可能还会醒来接着删），回收站那份先留着，下次同步再补、再删`);
    return false;
  }
  const r = await deleteTrashObjects(bucket, objs.map((o) => o.key));
  if (r.failed.length) log('warn', `云端清理：撤回 ${id} 之后回收站那份有 ${r.failed.length} 个对象删不掉，留着`);
  log('info', `云端清理：${id} 有设备又往原位置传了新内容（它还在用），这次移动撤回：缺的原件从回收站放回去了，catalog 条目也放回去了`);
  return true;
}

/**
 * **改说明文件：读最新的 → 改 → 条件写（If-Match 刚读到的 ETag），被别人抢先就重来**。
 * 说明文件同时是跨设备的锁（restoring / purging），所以绝不普通写 —— 普通写会把别人刚写上的锁盖掉。
 * `mutate` 作用在最新的那份上；返回 null = 不改（比如看到了对方的锁），函数也返回 null。
 * 说明文件不在 / 读不懂 / 存储不回 ETag → 抛（拿不准，调用方别做破坏性的事）。
 */
export async function updateTrashMeta(
  bucket: BucketOps, prefix: string | undefined, dir: string, mutate: (m: TrashMeta) => TrashMeta | null,
): Promise<TrashMeta | null> {
  const key = `${cloudTrashRoot(prefix)}${dir}/${TRASH_META}`;
  for (let i = 0; i < CATALOG_WRITE_TRIES; i++) {
    const got = await bucket.getWithEtag(key);
    if (!got) throw new Error('说明文件不在');
    if (!got.etag) throw new Error('云存储不返回 ETag，没法给回收站这一份上锁');
    let m: TrashMeta;
    try { m = JSON.parse(got.body.toString('utf-8')); } catch { throw new Error('说明文件读不懂'); }
    const next = mutate(m);
    if (!next) return null;
    if (await bucket.putIf(key, Buffer.from(JSON.stringify(next, null, 2)), 'application/json', { ifMatch: got.etag }) === 'ok') return next;
  }
  throw new Error(`说明文件连续 ${CATALOG_WRITE_TRIES} 次在写之前被别处抢先改了`);
}

/** 原来普通写说明文件的那几处：改成条件写，只动给出的这几个字段，别的（锁）原样留着。 */
async function patchTrashMeta(bucket: BucketOps, prefix: string | undefined, dir: string, patch: (m: TrashMeta) => TrashMeta): Promise<void> {
  await updateTrashMeta(bucket, prefix, dir, (m) => patch(m));
}

/**
 * 现在"有人在用"的会话：catalog 里有条目的，加上活跃设备清单里有的。
 * **判断不了就返回 null**（不能把"不知道"当成"没人用"）：没有 catalog、某台活跃设备的清单读不懂、
 * 有最近同步过却没有清单的设备（它手上有什么没人知道）。
 */
export function sessionsInUse(catalog: Catalog | null, now: number, activeDays: number): Set<string> | null {
  if (!catalog || !Array.isArray(catalog.entries)) return null;
  if (rebuiltHold(catalog, now, activeDays)) return null;      // 刚重建过：判断不了
  const { devices, unknown } = describeDevices(catalog, now, activeDays);
  if (unknown.length || devices.some((d) => d.active && !d.readable)) return null;
  const present = new Set((catalog.entries || []).map((e) => e.id));
  for (const d of devices) {
    if (!d.active) continue;
    for (const x of readableManifest(catalog.devices?.[d.machine])?.sessions || []) present.add(x.id);
  }
  return present;
}

/**
 * **把没做完的移动做完，或者撤回** —— 每轮同步对回收站里的每一份跑一遍：
 *
 *   · 待撤回的（上次撤回没放完）→ 接着撤回；
 *   · 这条会话**又在用了**（catalog 里有条目、或某台活跃设备的清单里有它）→ **撤回整次移动**：
 *     那台设备只会重传它改过的文件（甚至只发布了清单），原位置可能还缺 record.json 之类 —— 从回收站补齐缺的、
 *     保留新的，全部放回去才删回收站那份。不撤回的话，到期清空就把那些文件唯一的一份删了；
 *   · 移动还没做完（moving / 还有没删掉的原件）→ 按版本接着删；删的时候发现被重写过 → 撤回；全删完 → 去掉 moving。
 *
 * 不能按版本删（`canDelete` 为假）时只撤回、不删。返回这一轮撤回没做完的那些目录 —— 调用方这一轮的到期清空要跳过它们。
 */
export async function retryPendingOriginals(
  bucket: BucketOps, prefix: string | undefined, catalog: Catalog, items: TrashItem[],
  opts: { now: number; activeDays: number; log: CleanupLog; canDelete: boolean; by: string; versioned?: boolean },
): Promise<{ deleted: number; left: number; undoFailed: Set<string> }> {
  const present = sessionsInUse(catalog, opts.now, opts.activeDays);
  const undoFailed = new Set<string>();
  const undo = async (item: TrashItem, why: string): Promise<void> => {
    opts.log('info', `云端清理：${item.id} ${why}，撤回这次移动（从回收站补齐原位置缺的文件，保留新的）`);
    if (await undoCloudTrashMove(bucket, prefix, item.dir, item.meta!, opts.log)) { item.undoPending = false; item.moving = false; item.pendingOriginals = []; }
    else { item.undoPending = true; undoFailed.add(item.dir); }
  };
  let deleted = 0;
  let left = 0;
  for (const item of items) {
    if (!item.meta) continue;
    /* 上次没撤回完的：接着撤回（只补原位置缺的，不盖新的 —— 不管能不能按版本删都安全） */
    if (item.undoPending) { await undo(item, '上次撤回没做完'); continue; }
    /*
      判断不了有没有人在用（清单读不懂等）：不删原件、也不贸然撤回 —— 撤回会把一次也许合法的移动退回去，
      删原件则可能删掉别人还要的东西。等能判断了再说。只有上面"待撤回"的接着做（它本来就该撤回）。
    */
    if (!present) { left += item.pendingOriginals.length; continue; }
    /* 又在用了：不管这次移动做没做完，都撤回 —— 原位置可能缺着只在回收站里的文件 */
    if (present.has(item.id)) { await undo(item, '又出现在 catalog / 某台活跃设备的清单里了'); continue; }
    if (!item.moving && !item.pendingOriginals.length) continue;
    /* 存储不能按版本删：没删掉的原件留着、记录也留着，等能删了再说 */
    if (!opts.canDelete) { left += item.pendingOriginals.length; continue; }
    const d = await deleteOriginalsOfMove(bucket, prefix, item.dir, item.pendingOriginals, opts.by, opts.log, !!opts.versioned);
    deleted += d.deleted;
    /* 原位置被重新写过 = 有设备还在用它：撤回 */
    if (d.result === 'changed') { await undo(item, '的原件在移进回收站之后被重新写过'); continue; }
    /* 拿不到锁：一个都没删，记录原样留着，下轮再试 */
    if (d.result === 'locked') { left += item.pendingOriginals.length; continue; }
    const rest = d.failed;
    if (rest.length) opts.log('warn', `云端清理：${item.id} 还有 ${rest.length} 个原件删不掉，下次再试`);
    left += rest.length;
    /* 还有删不掉的：留着 moving 和待删记录；全删完：去掉 moving，这次移动做完了。deleting 锁一起去掉 */
    try {
      await patchTrashMeta(bucket, prefix, item.dir, (m) => {
        const { pendingOriginals: _old, moving: _mv, deleting: _dl, ...base } = m;
        return rest.length ? { ...base, moving: true, pendingOriginals: rest } : base;
      });
      item.pendingOriginals = rest;
      item.moving = rest.length > 0;
      if (!rest.length) opts.log('info', `云端清理：${item.id} 的移动做完了（原件都删掉了）`);
    } catch (err: any) {
      opts.log('warn', `云端清理：${item.id} 的说明文件改不了，下次再试（这一份照样受保护）：${err?.message || err}`);
    }
  }
  return { deleted, left, undoFailed };
}

export interface CleanupResult {
  trashed: Array<{ id: string; title: string; dir: string; reason: string }>;
  purged: Array<{ id: string; dir: string }>;
  blocked: string | null;
  undecided: Array<{ id: string; why: string }>;
  errors: string[];
}

/**
 * 一轮清理：判定 → 复制进回收站 → catalog 去掉这些条目 → 删原件；再把到期的彻底删掉。
 *
 * `spare`：调用方再筛一道（KiroLex Advanced 的会话、读不出 record.json 的）—— 返回的 id 这一轮不动。
 * catalog 用条件写入（`updateCatalog`），写之前按桶里**当前**那份重新判一遍：这期间别的机器同步过、说它又有这条了，
 * 就把这条的复制品撤掉；写的时候又被别人抢先，就再读再判。
 */
export async function runCloudCleanup(bucket: BucketOps, opts: {
  prefix?: string;
  now: number;
  settings: CleanupSettings;
  thisMachine: string;
  /** 这台设备的 ID（锁主用它：同一台设备的新一轮可以接手自己以前那一轮留下的锁）。不给就用 thisMachine。 */
  deviceId?: string;
  spare?: (ids: string[]) => Promise<Set<string>>;
  log: CleanupLog;
}): Promise<CleanupResult> {
  const res: CleanupResult = { trashed: [], purged: [], blocked: null, undecided: [], errors: [] };
  if (!opts.settings.enabled) return res;
  const { prefix, now, log } = opts;
  /* 这一轮撤回没做完的目录：说明文件上的标记要是也没写进去，这一轮的到期清空也绝不能碰它们 */
  const undoFailed = new Set<string>();
  /* deleting 锁的主人：这台机器的这一轮（同一轮里自己的锁可以接着用） */
  const lockOwner = `${opts.deviceId || opts.thisMachine}#${now}-${Math.random().toString(36).slice(2, 8)}`;

  let catalog: Catalog | null = null;
  let etagOk = false;
  try {
    const got = await bucket.getWithEtag(catalogKey(prefix));
    if (got) {
      const c = JSON.parse(got.body.toString('utf-8'));
      if (!c || !Array.isArray(c.entries)) throw new Error('catalog 的格式不对');
      catalog = c as Catalog;
      etagOk = !!got.etag;
    }
  } catch (err: any) { res.blocked = `catalog 读不懂：${err?.message || err}`; }
  /*
    **拿不到 ETag 就不移任何会话**：没法条件写入，别的机器刚写的清单可能已经被（任何一台的）普通写覆盖了 ——
    那份清单里说"我还有 s1"，被盖掉之后 s1 看起来就是没人有了。拿不准 = 不清。
  */
  if (catalog && !etagOk) {
    res.blocked = '云存储不返回 ETag，没法确认别的设备刚写的清单没有被覆盖';
    catalog = null;
  }
  if (catalog) {
    const d = decideCleanup(catalog, { now, activeDays: opts.settings.activeDays });
    res.blocked = d.blocked;
    res.undecided = d.undecided;
    for (const u of d.undecided) log('info', `云端清理：${u.id} 拿不准，不动（${u.why}）`);
    let cands = d.candidates;
    if (cands.length && opts.spare) {
      const spared = await opts.spare(cands.map((c) => c.entry.id));
      for (const id of spared) log('info', `云端清理：${id} 不动（KiroLex Advanced 的会话，或读不出它的 record.json）`);
      cands = cands.filter((c) => !spared.has(c.entry.id));
    }
    /* 移任何会话之前先确认这个存储能按版本删（见 probeConditionalDelete）；不能就这一轮一条都不移 */
    let canDelete: boolean | null = null;
    /* 桶现在是不是开着版本控制（探测出来的）—— 决定 "null" 版本的原件怎么删（见 deleteOriginalVersion） */
    let bucketVersioned = false;
    const ensureCanDelete = async (): Promise<boolean> => {
      if (canDelete === null) {
        try { const mode = await probeDeleteMode(bucket, prefix); canDelete = mode !== 'none'; bucketVersioned = mode === 'versioned'; } catch (err: any) {
          canDelete = false;
          log('warn', `云端清理：探测存储能不能按版本删除时出错，当作不能：${err?.message || err}`);
        }
        if (!canDelete) res.blocked = '云存储不支持按版本删除（DELETE 带 If-Match），删原件时没法保证不删掉别的设备刚传的新版本';
      }
      return canDelete;
    };
    if (cands.length && !await ensureCanDelete()) {
      log('info', `云端清理：${res.blocked}，这一轮不移任何会话（${cands.length} 条候选都留着）`);
      cands = [];
    }
    const copied: Array<{ c: CleanupCandidate } & NonNullable<Awaited<ReturnType<typeof copySessionToCloudTrash>>>> = [];
    for (const c of cands) {
      try {
        const r = await copySessionToCloudTrash(bucket, prefix, c, now, opts.thisMachine);
        if (!r) { log('info', `云端清理：${c.entry.id} 在桶里已经没有对象了，不动`); continue; }
        copied.push({ c, ...r });
      } catch (err: any) {
        res.errors.push(`${c.entry.id}: ${err?.message || err}`);
        log('warn', `云端清理：${c.entry.id} 复制进回收站失败，原件没动：${err?.message || err}`);
      }
    }
    /* 复制期间原件有没有变：变了 = 有设备正在传，撤掉复制品，这一轮不移 */
    for (const x of [...copied]) {
      const why = await originalsChanged(bucket, prefix, x.c.entry.id, x.originals).catch((err: any) => `列不出原件：${err?.message || err}`);
      if (!why) continue;
      await delAll(bucket, x.copies);
      copied.splice(copied.indexOf(x), 1);
      log('info', `云端清理：${x.c.entry.id} 复制期间原位置有变化（${why}），有设备正在传它，撤回、这一轮不移`);
    }
    if (copied.length) {
      /* 这一次真写进去的那份 catalog 里去掉了哪些 —— 只有它们才删原件 */
      let gone = new Set<string>();
      try {
        await updateCatalog(bucket, prefix, (fresh, unreadable) => {
          gone = new Set();
          if (!fresh || unreadable) return null;
          const again = new Set(decideCleanup(fresh, { now, activeDays: opts.settings.activeDays }).candidates.map((c) => c.entry.id));
          gone = new Set(copied.map((x) => x.c.entry.id).filter((id) => again.has(id)));
          return gone.size ? { ...fresh, entries: (fresh.entries || []).filter((e) => !gone.has(e.id)) } : null;
        }, { requireEtag: true });
      } catch (err: any) {
        gone = new Set();
        res.errors.push(`catalog: ${err?.message || err}`);
        log('warn', `云端清理：catalog 写不进去，这一轮撤回，原件没动：${err?.message || err}`);
      }
      const keep = copied.filter((x) => gone.has(x.c.entry.id));
      for (const x of copied.filter((y) => !gone.has(y.c.entry.id))) {
        await delAll(bucket, x.copies);
        if (!res.errors.some((e) => e.startsWith('catalog:'))) log('info', `云端清理：${x.c.entry.id} 写 catalog 前按桶里当前那份重新判定，不再满足条件（别的机器刚同步过），撤回`);
      }
      for (const x of keep) {
        /*
          **只删复制的那一版**（deleteOriginalVersion）。写完 catalog 之后、删到这里之前，别的设备要是又传了新内容
          （它有这条会话、只是清单还没发布），那一版对不上 → 不删它，并且整次移动撤回（已删的放回去）——
          那台设备只会重传改过的文件，不撤回的话它的备份就缺了别的文件。
        */
        const d = await deleteOriginalsOfMove(bucket, prefix, x.dir, x.originals, lockOwner, log, bucketVersioned);
        /* 确认不了版本的（没 ETag 等）也不删 —— 当成"被更新过"，整次移动撤回 */
        const changed = d.result === 'changed' || (d.result === 'done' && d.failed.some((o) => !o.versionId && !o.etag));
        const failed = d.failed;
        if (d.result === 'locked') {
          /* 拿不到锁：一个原件都没删；说明文件还是复制时那份（moving + 全部原件待删），下轮按规矩接着做 */
          res.trashed.push({ id: x.c.entry.id, title: x.c.entry.title || x.c.entry.id, dir: x.dir, reason: x.c.reason });
          log('info', `云端清理：${x.c.entry.id}（${x.c.entry.title || 'New Chat'}）移进云端回收站 trash/${x.dir}/，原因：${x.c.reason}（原件这一次没拿到锁、没删，下轮再删）`);
          continue;
        }
        if (changed) {
          if (d.result === 'done') {
            try { await patchTrashMeta(bucket, prefix, x.dir, (m) => { const { deleting: _d, ...rest } = m; return rest; }); } catch { /* 锁过一阵算失效 */ }
          }
          if (!await undoCloudTrashMove(bucket, prefix, x.dir, x.meta, log)) {
            undoFailed.add(x.dir);
            res.errors.push(`${x.c.entry.id}: 撤回没有完成，回收站那份留着`);
          }
          continue;
        }
        res.trashed.push({ id: x.c.entry.id, title: x.c.entry.title || x.c.entry.id, dir: x.dir, reason: x.c.reason });
        log('info', `云端清理：${x.c.entry.id}（${x.c.entry.title || 'New Chat'}）移进云端回收站 trash/${x.dir}/，原因：${x.c.reason}`
          + `${failed.length ? `（${failed.length} 个原件没删掉，记进回收站的说明文件，之后每轮同步重试）` : ''}`);
        /*
          删完了 → 去掉 moving；还有删不掉的 → 待删记录换成删不掉的那几个（moving 留着）。
          这一步写不进去：说明文件还是复制时那份（moving + 全部原件待删），照样受保护，下一轮按版本接着删（已删的算删掉了）。
        */
        try {
          await patchTrashMeta(bucket, prefix, x.dir, (m) => {
            const { pendingOriginals: _all, moving: _mv, deleting: _dl, ...done } = m;
            return failed.length ? { ...done, moving: true, pendingOriginals: failed } : done;
          });
        } catch (err: any) {
          res.errors.push(`${x.c.entry.id}: ${err?.message || err}`);
          log('warn', `云端清理：${x.c.entry.id} 的说明文件改不了（这一份照样受保护，下一轮接着做完）：${err?.message || err}`);
        }
      }
    }
    /* 以前移进回收站时没删掉的原件：按 retryPendingOriginals 的规矩再试（拿不到 ETag 时上面 catalog 已置空，不走这里） */
    try {
      /* 用桶里**现在**这份判"又在用了没有"——开头读的那份里还有这一轮刚移走的会话 */
      const got = await bucket.getWithEtag(catalogKey(prefix));
      const cur = got?.etag ? JSON.parse(got.body.toString('utf-8')) as Catalog : null;
      if (cur && Array.isArray(cur.entries)) {
        const items = await listCloudTrash(bucket, prefix, now, opts.settings.trashDays);
        /* 有没删掉的原件才需要探测（撤回不删原件，探测不探测都能做） */
        const needDelete = items.some((i) => !i.undoPending && (i.moving || i.pendingOriginals.length));
        const r = await retryPendingOriginals(bucket, prefix, cur, items,
          { now, activeDays: opts.settings.activeDays, log, canDelete: needDelete ? await ensureCanDelete() : false, by: lockOwner, versioned: bucketVersioned });
        for (const d of r.undoFailed) undoFailed.add(d);
      }
    } catch (err: any) {
      res.errors.push(`pending: ${err?.message || err}`);
      log('warn', `云端清理：重试删除没删掉的原件时出错，下次再试：${err?.message || err}`);
    }
  }

  /*
    到期的彻底删掉。删之前不只看说明文件上的标记（标记可能没写进去），还**现场核对**这条会话现在有没有人在用：
    catalog 里有条目、或者活跃设备的清单里有它 → 不清空（下一轮会撤回，把文件补回原位置）。catalog 读不出来 → 拿不准，这一轮一份都不清。
  */
  try {
    /* 没有 catalog、读不懂、或者有设备的清单判断不了 → inUse 为 null → 这一轮一份都不清（拿不准就不删） */
    let inUse: Set<string> | null = null;
    try {
      const got = await bucket.getWithEtag(catalogKey(prefix));
      inUse = got ? sessionsInUse(JSON.parse(got.body.toString('utf-8')) as Catalog, now, opts.settings.activeDays) : null;
    } catch { inUse = null; }
    for (const item of await listCloudTrash(bucket, prefix, now, opts.settings.trashDays)) {
      if (!trashExpired(item.trashedAt, now, opts.settings.trashDays)) continue;
      if (!inUse) { log('warn', `云端清理：catalog 没有 / 读不懂、或者有活跃设备的清单读不到，确认不了 ${item.id} 是不是又有人在用，这一轮不清空`); continue; }
      if (undoFailed.has(item.dir)) {
        log('warn', `云端清理：${item.id} 这一轮撤回没做完，不清空`);
        continue;
      }
      if (inUse.has(item.id)) {
        log('warn', `云端清理：${item.id} 到期了，但它又有人在用（catalog / 设备清单里有它），不清空，下一轮撤回、把文件补回原位置`);
        continue;
      }
      if (item.moving) {
        log('info', `云端清理：${item.id} 到期了，但这次移动还没做完，不清空，下一轮接着做`);
        continue;
      }
      /* 撤回没做完：这一份里有只此一份的文件，绝不清空 */
      if (item.undoPending) {
        log('warn', `云端清理：${item.id} 到期了，但它的撤回还没做完（有文件只在回收站里），不清空，下次同步接着撤回`);
        continue;
      }
      /* 原件还没删完：先不清空 —— 说明文件是这批原件唯一的记录，清空了就再也没人删它们 */
      if (item.pendingOriginals.length) {
        log('info', `云端清理：${item.id} 到期了，但移进回收站时还有 ${item.pendingOriginals.length} 个原件没删掉，先不清空，下次同步再说`);
        continue;
      }
      if (item.restoring) {
        log('info', `云端清理：${item.id} 到期了，但有人正在把它恢复 / 撤回（说明文件上有锁），不清空`);
        continue;
      }
      /*
        **上锁再删**（跨设备）：条件写说明文件写上 purging —— 写之前再看一遍最新的那份：有人在恢复 / 撤回、
        或者移动 / 撤回没做完，就不动；从我们读到它到写之间别人改过（比如刚上了 restoring 锁）→ 条件写失败 → 这一轮不删。
        之前没删完留下的 purging（自己或别的设备的）照样接着删：删除本身可以重复做，而恢复看到 purging 也不会再碰它。
      */
      let claimed: TrashMeta | null = null;
      try {
        claimed = await updateTrashMeta(bucket, prefix, item.dir, (m) =>
          (m.restoring || m.deleting || m.moving || m.undoPending || (m.pendingOriginals || []).length) ? null
            : { ...m, purging: m.purging || { at: now, by: opts.thisMachine } });
      } catch (err: any) {
        log('warn', `云端清理：${item.id} 到期了，但给它上锁没成功（${err?.message || err}），这一轮不清空`);
        continue;
      }
      if (!claimed) {
        log('info', `云端清理：${item.id} 到期了，但上锁前发现有人正在恢复 / 撤回它，不清空`);
        continue;
      }
      const r = await deleteTrashObjects(bucket, item.keys);
      if (r.failed.length) {
        res.errors.push(...r.failed.map((f) => `${item.id}: ${f}`));
        log('warn', `云端清理：${item.id}（${item.title}）到期清空没删完：${r.failed.length} 个对象删不掉（${r.failed[0]}），说明文件留着，下次同步再删`);
        continue;
      }
      res.purged.push({ id: item.id, dir: item.dir });
      log('info', `云端清理：${item.id}（${item.title}）在云端回收站满 ${opts.settings.trashDays} 天（${fmt(item.trashedAt)} 进的回收站），彻底删除 ${r.deleted} 个对象`);
    }
  } catch (err: any) {
    res.errors.push(`trash: ${err?.message || err}`);
    log('warn', `云端清理：读不到云端回收站，这一轮不清空到期的：${err?.message || err}`);
  }
  return res;
}

function trashDirOk(dir: string): boolean {
  return /^[\w.-]+__[\w-]+$/.test(dir) && !dir.includes('..');
}

/**
 * **恢复到云端备份**：把回收站里这一份移回 `sessions/<id>/`，catalog 放回原条目并记下恢复时间
 * （之前的删除记录从此不算数，见 `decideCleanup`）。原位置上已经有的对象不覆盖（那是别的机器后来传的）。
 * 顺序：复制回去 → 写 catalog → 删回收站里的。
 */
export async function restoreFromCloudTrash(bucket: BucketOps, prefix: string | undefined, dir: string, now: number, log: CleanupLog): Promise<{ id: string; restored: number; kept: number }> {
  if (!trashDirOk(dir)) throw new Error('回收站目录名不对');
  const base = `${cloudTrashRoot(prefix)}${dir}/`;
  const objs = (await bucket.list(base)).filter((o) => o.key.startsWith(base));
  if (!objs.length) throw new Error('云端回收站里已经没有这一份了');
  /*
    **先上锁，再读回收站里的文件**（跨设备）：条件写说明文件写上 restoring。别的设备的到期清空 / 手动删除看到它就不删；
    它们要是先上了 purging 锁 → 这一份正在被彻底删除，不恢复。两边同时写，条件写只有一边成功。
    没有说明文件的（时间未知、从来不会被自动清空）照旧恢复。恢复中途失败时锁留着：这一份不会被自动清空，再点一次恢复接着做。
  */
  let meta: TrashMeta | null = null;
  if (objs.some((o) => o.key === `${base}${TRASH_META}`)) {
    let purging = false;
    let deletingNow = false;
    meta = await updateTrashMeta(bucket, prefix, dir, (m) => {
      if (m.purging) { purging = true; return null; }
      if (lockFresh(m.deleting)) { deletingNow = true; return null; }
      return { ...m, restoring: m.restoring || { at: now, by: 'restore' } };
    });
    if (deletingNow) throw new Error('有设备正在删这一份的原件（桶没开版本控制时要和恢复错开），过一会儿再恢复');
    if (purging || !meta) throw new Error('这一份正在被彻底删除（别的设备到期清空 / 手动删除），不能恢复');
  }
  const id = meta?.id || parseTrashDirName(dir)?.id;
  if (!id || !SAFE_ID.test(id)) throw new Error('认不出这一份是哪条会话');
  const inner = `${base}sessions/${id}/`;
  const dst = sessionPrefix(prefix || '', id);
  const copied = copiedVersions(meta);
  let restored = 0;
  let kept = 0;
  for (const o of objs) {
    if (!o.key.startsWith(inner)) continue;
    const to = `${dst}${o.key.slice(inner.length)}`;
    const body = await bucket.get(o.key);
    if (!body) throw new Error(`读不到 ${o.key}`);
    /*
      **只在原位置没有这个文件时才写**（If-None-Match: *）：先列一遍再普通写的话，列完之后别的设备传上来的新文件
      会被回收站里的旧文件盖掉。已经有了 → 保留现有的（那是别的设备后来传的）——
      除非它**正是复制进回收站的那一版**（还没来得及按版本删）：那就写成一个新版本，免得恢复之后它被那边删掉（见 putBackOriginal）。
    */
    if (await putBackOriginal(bucket, to, body, copied.get(to)) === 'restored') restored += 1;
    else kept += 1;
  }
  const entry: CatalogEntry = { ...(meta?.entry || { id, title: id, updatedAt: 0, bytes: 0, syncedAt: 0 }), id, restoredFromTrashAt: now };
  /* 条件写入：不覆盖别的机器这期间写进来的清单 / 条目。读不懂就不写（不拿一份空的盖掉它） */
  const w = await updateCatalog(bucket, prefix, (cur, unreadable) => {
    if (unreadable) return null;
    const catalog = cur || { version: 1 as const, entries: [] };
    const has = (catalog.entries || []).some((e) => e.id === id);
    return {
      ...catalog,
      entries: has
        ? catalog.entries.map((e) => (e.id === id ? { ...e, restoredFromTrashAt: now } : e))
        : [entry, ...(catalog.entries || [])],
    };
  }, { requireEtag: true });
  if (!w.written) {
    throw new Error(w.noEtag
      ? '云存储不返回 ETag，没法安全地改 catalog（可能覆盖别的设备刚写的清单），没有改它；文件已经移回原位置，回收站里那份还留着'
      : 'catalog 读不懂，没有改它；文件已经移回原位置，回收站里那份还留着');
  }
  /* 说明文件上还有 deleting 锁（那一边停住了，醒来可能接着删）→ 回收站那份留着当保底，标成待撤回：之后每轮补缺的，锁没了再删 */
  if (meta && await deletingLockOn(bucket, prefix, dir)) {
    try { await patchTrashMeta(bucket, prefix, dir, (m) => ({ ...m, undoPending: true })); } catch { /* restoring 锁还在，照样不会被清空 */ }
    log('warn', `云端回收站：${id} 已恢复到云端备份，但有一次删原件还没收尾（说明文件上有锁），回收站那份先留着当保底，之后同步时自动补齐、收尾`);
    return { id, restored, kept };
  }
  const left = await deleteTrashObjects(bucket, objs.map((o) => o.key));
  if (left.failed.length) log('warn', `云端回收站：${id} 已恢复，但回收站里有 ${left.failed.length} 个对象删不掉（${left.failed[0]}），留着说明文件，到期时再删`);
  log('info', `云端回收站：${id}（${meta?.entry?.title || id}）恢复到云端备份：移回 ${restored} 个对象${kept ? `，${kept} 个原位置已有、保留原位置的` : ''}（用户手动恢复）`);
  return { id, restored, kept };
}

/** **立即彻底删除**回收站里的一份（用户确认过之后）。 */
export async function purgeCloudTrashItem(bucket: BucketOps, prefix: string | undefined, dir: string, log: CleanupLog): Promise<{ id: string; deleted: number }> {
  if (!trashDirOk(dir)) throw new Error('回收站目录名不对');
  const base = `${cloudTrashRoot(prefix)}${dir}/`;
  const objs = (await bucket.list(base)).filter((o) => o.key.startsWith(base));
  const id = parseTrashDirName(dir)?.id || dir;
  /* 上锁再删（同到期清空）：有人在恢复 / 撤回就不删；"正在恢复"的锁超过 RESTORE_LOCK_STALE_MS 才当成半途失败留下的 */
  if (objs.some((o) => o.key === `${base}${TRASH_META}`)) {
    let why = '';
    const claimed = await updateTrashMeta(bucket, prefix, dir, (m) => {
      if (m.undoPending) { why = '这一份正在撤回（有设备又在用这条会话），里面有还没放回原位置、只此一份的文件，不能彻底删除；下次同步放回去之后它会自己消失'; return null; }
      if (m.restoring && Date.now() - (Number(m.restoring.at) || 0) < RESTORE_LOCK_STALE_MS) { why = '这一份正在被恢复（这台或别的设备），不能彻底删除'; return null; }
      return { ...m, purging: m.purging || { at: Date.now(), by: 'manual' } };
    });
    if (!claimed) throw new Error(why || '这一份正在被恢复，不能彻底删除');
  }
  const r = await deleteTrashObjects(bucket, objs.map((o) => o.key));
  if (r.failed.length) {
    log('warn', `云端回收站：${id} 彻底删除没删完：${r.failed.length} 个对象删不掉（${r.failed[0]}），说明文件留着（用户手动确认）`);
    throw new Error(`${r.failed.length} 个对象删不掉：${r.failed[0]}`);
  }
  log('info', `云端回收站：${id} 彻底删除 ${r.deleted} 个对象（用户手动确认）`);
  return { id, deleted: r.deleted };
}
