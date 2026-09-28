/**
 * **定时把会话备份到 S3，并且能把某一条挑回本地** ——「加一个定时向 S3 同步的功能，
 * 然后用户可以选择哪个会话恢复回本地，S3 认证用 AKSK」。
 *
 * ## 同步什么（以及为什么不是"整个目录"）
 *
 * 镜像时代踩过一次：判据是"把工作目录推上去"，结果一条 cwd 是 `~` 的会话把整个家目录
 * 推了上去 —— 2.6 → 6.1 GB，里面有 `.aws/credentials`、`.aws/sso/cache` 和 17 把 `.pem`。
 * 所以这里**只列白名单**，而且每一项都要能说出"恢复时需要它"：
 *
 *   · `sessions/<id>/{record.json, transcript.jsonl, history.md}` —— 恢复一条会话的最小集合；
 *   · `memory/**` —— 三层记忆，不带的话恢复回来的会话"忘了你教过它的事"；
 *   · `attachments/**`、`pasted/**` —— 会话里引用的图片。
 *
 * **不同步** `config.json`（里面是这台机器的路径、identityFile、远端主机），也不同步
 * `logs/`、`previews/`、`loffice-profile/` 这些纯本地产物。用户选的范围就是上面这三类。
 *
 * ## 只传变化的
 *
 * 一份本地状态（`s3-sync-state.json`）记 `路径 → {size, mtimeMs}`。两者都没变就跳过 ——
 * 不用内容 hash 是因为这些文件是 append 为主的日志（transcript/history），读一遍全文去算 hash
 * 比直接传还贵；而 size+mtime 在"文件被改回原样"这种极端情况下会漏，那个代价（一次没备份到）
 * 远小于每轮都全量读盘。
 *
 * ## 恢复是**覆盖同 id**（用户选的）
 *
 * 覆盖不可逆，所以覆盖之前把本地那份挪进 `~/.kirolex/trash/restore-<时间>/` ——
 * "用户选了覆盖"不等于"用户愿意丢掉"。
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** 对象 key 的版本前缀 —— 布局以后要改时，老的还在，不会被当成损坏的数据读。 */
export const LAYOUT = 'v1';

/** 一条会话恢复回来必须有的那几个文件。顺序无关，但**只有这几个**。 */
export const SESSION_FILES = ['record.json', 'transcript.jsonl', 'history.md'];

/** 整体同步的那几棵树（相对 `~/.kirolex`）。 */
export const SHARED_DIRS = ['memory', 'attachments', 'pasted'];

/** 默认间隔。30 分钟：会话是聊出来的，丢 30 分钟等于丢一两轮。 */
export const DEFAULT_INTERVAL_MINUTES = 30;

/** 单个文件上限 —— 超了跳过并说一句。备份不该被一个巨大的粘贴图拖死。 */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

export interface SyncConfig {
  enabled?: boolean;
  bucket?: string;
  region?: string;
  /** key 前缀，例如 `kirolex`。空 = 直接放桶根。 */
  prefix?: string;
  intervalMinutes?: number;
  /**
   * **不同步的那些项目** ——「有些project可以选择不同步」。
   *
   * 存"排除"而不是"包含"：新建的项目默认**跟着同步**。存包含列表的话，
   * 每建一个项目都要记得回来勾一次，而漏勾的表现是"它一直没被备份"——
   * 而那件事只有等你需要恢复时才会发现。
   *
   * 已经传上去的不会被删：这是**停止继续备份**，不是"把备份删掉"。
   * 那些条目还留在 catalog 里、照旧可以恢复 —— catalog 描述的是桶里有什么，不是策略。
   */
  excludeProjects?: string[];
  accessKeyId?: string;
  /** `safeStorage` 加密后的 secret（base64）。**明文永不落盘**。 */
  secretCipher?: string;
  endpoint?: string;
}

/** 状态文件里一条记录。 */
export interface FileState { size: number; mtimeMs: number }
export type SyncState = Record<string, FileState>;

/** 目录里那条会话在 S3 上的 key 前缀。 */
export function sessionPrefix(prefix: string, sessionId: string): string {
  return `${joinPrefix(prefix)}${LAYOUT}/sessions/${sessionId}/`;
}

export function joinPrefix(prefix?: string): string {
  const p = String(prefix || '').replace(/^\/+|\/+$/g, '');
  return p ? `${p}/` : '';
}

/** 恢复列表那份目录的 key。一次 GET 就能拉到全部候选，不必 LIST 整个桶。 */
export function catalogKey(prefix?: string): string {
  return `${joinPrefix(prefix)}${LAYOUT}/catalog.json`;
}

export interface CatalogEntry {
  id: string;
  title: string;
  /**
   * 这条会话属于哪个项目（`record.profile.projectId`）——「你得按 project 整理」。
   *
   * 记在 catalog 里而不是恢复时去读每份 record：恢复列表是一次 GET 拿到整张 catalog 的,
   * 为了分组去逐个下载 record.json 等于把一次请求变成几十次。
   * 老的 catalog 没有这个字段 → 归到"未分组"。
   */
  project?: string;
  updatedAt: number;
  /** 这条会话备份了多少字节（给人一个"是不是完整"的感觉）。 */
  bytes: number;
  /** 上传这份备份的机器名 —— 多台机器往同一个桶备份时，这是唯一能分清来源的东西。 */
  from?: string;
  syncedAt: number;
}

export interface Catalog { version: 1; entries: CatalogEntry[] }

/**
 * 这一轮要传哪些文件。
 *
 * 返回的是**相对 `~/.kirolex` 的路径**，调用方拼绝对路径 —— 这样这个函数可以纯粹地测。
 * `state` 是上一次的记录；`skipped` 里说清为什么跳过（太大 / 没变），因为"没上传"这件事
 * 必须能解释，否则一条始终没备份的会话会一直沉默着。
 */
export function planUpload(
  root: string,
  sessionIds: string[],
  state: SyncState,
): { upload: string[]; skippedUnchanged: number; skippedTooBig: string[] } {
  const upload: string[] = [];
  const skippedTooBig: string[] = [];
  let skippedUnchanged = 0;

  const consider = (rel: string): void => {
    let st: fs.Stats;
    try { st = fs.statSync(path.join(root, rel)); } catch { return; }
    if (!st.isFile()) return;
    if (st.size > MAX_FILE_BYTES) { skippedTooBig.push(rel); return; }
    const prev = state[rel];
    if (prev && prev.size === st.size && prev.mtimeMs === Math.floor(st.mtimeMs)) { skippedUnchanged += 1; return; }
    upload.push(rel);
  };

  for (const id of sessionIds) for (const f of SESSION_FILES) consider(path.join('sessions', id, f));
  for (const dir of SHARED_DIRS) for (const rel of walk(root, dir)) consider(rel);
  return { upload, skippedUnchanged, skippedTooBig };
}

/** 相对路径递归列举。目录不存在就当空 —— 没有 `pasted/` 不是错误。 */
export function walk(root: string, rel: string): string[] {
  const abs = path.join(root, rel);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const childRel = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(root, childRel));
    else out.push(childRel);
  }
  return out;
}

/** 本地路径 → S3 key（带前缀和布局版本）。分隔符一律 `/` —— key 里不能出现 `\`。 */
export function keyFor(prefix: string | undefined, rel: string): string {
  return `${joinPrefix(prefix)}${LAYOUT}/${rel.split(path.sep).join('/')}`;
}

/** S3 key → 本地相对路径（`keyFor` 的逆）。不属于这个布局的返回 `null`。 */
export function relFor(prefix: string | undefined, key: string): string | null {
  const head = `${joinPrefix(prefix)}${LAYOUT}/`;
  if (!key.startsWith(head)) return null;
  const rel = key.slice(head.length);
  /* 绝不接受能跳出 root 的路径 —— key 是远端来的数据，`../` 会写到 `~/.kirolex` 之外 */
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return null;
  return rel.split('/').join(path.sep);
}

/** 内容类型 —— 只为了在 S3 控制台里点开能看，不参与任何判断。 */
export function contentTypeFor(rel: string): string {
  if (rel.endsWith('.json')) return 'application/json';
  if (rel.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (rel.endsWith('.jsonl')) return 'application/x-ndjson';
  if (rel.endsWith('.png')) return 'image/png';
  if (rel.endsWith('.jpg') || rel.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

/**
 * **另一台机器是不是也在动同一条会话** ——（参考 Tabby 那个云同步插件 v1.8.0 的
 * `Improved conflict detection, safe conflict backups`）。
 *
 * 判据：远端那条 catalog 条目**来自别的机器**，而且它的 `updatedAt` 比本机这条新。
 * 这时本机这一轮上传会把对方更新的内容盖掉 —— 而 S3 没有版本控制的话那是不可逆的。
 *
 * 为什么不用"谁的时间晚谁赢"：两台机器的时钟不一定一致，而"悄悄丢掉另一台的对话"
 * 是这类同步里最贵的失败。所以冲突时**照样把本机这份传上去**（否则本机的改动也没了），
 * 但传到一个**旁路 key**，并在界面上说出来 —— 让人自己决定留哪份。
 *
 * 同一台机器的旧条目不算冲突（那就是我们自己上一轮传的）。
 */
export function detectConflicts(
  remote: Catalog | null,
  fresh: CatalogEntry[],
  thisMachine: string,
): CatalogEntry[] {
  const byId = new Map((remote?.entries || []).map((e) => [e.id, e]));
  const out: CatalogEntry[] = [];
  for (const mine of fresh) {
    const theirs = byId.get(mine.id);
    if (!theirs) continue;
    if ((theirs.from || '') === thisMachine) continue;        // 自己上一轮传的
    if (!theirs.from) continue;                              // 老条目没记来源，不当冲突
    if ((theirs.updatedAt || 0) > (mine.updatedAt || 0)) out.push(theirs);
  }
  return out;
}

/** 冲突时本机那份放哪儿 —— 旁路 key，不盖对方的。 */
export function conflictKeyFor(prefix: string | undefined, sessionId: string, machine: string, rel: string): string {
  return `${joinPrefix(prefix)}${LAYOUT}/conflicts/${sessionId}/${machine}/${rel.split(path.sep).join('/')}`;
}

/**
 * **连续失败之后退避** ——（同样参考那个插件：`improved retry behavior after repeated failures`）。
 *
 * 不退避的表现：桶名写错之后，每 30 分钟准时失败一次，日志里堆一模一样的报错，而"它一直在重试"
 * 这件事本身没有任何价值 —— 错的东西重试一百次还是错的。退避到最多 8 倍间隔，
 * 成功一次就清零。
 */
export const MAX_BACKOFF_MULTIPLIER = 8;

export function backoffMultiplier(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 1;
  return Math.min(MAX_BACKOFF_MULTIPLIER, 2 ** Math.min(consecutiveFailures, 3));
}

/** 把新的 catalog 条目并进旧的（同 id 用**新的**那条），按更新时间倒序。 */
export function mergeCatalog(old: Catalog | null, fresh: CatalogEntry[]): Catalog {
  const byId = new Map<string, CatalogEntry>();
  for (const e of old?.entries || []) byId.set(e.id, e);
  for (const e of fresh) byId.set(e.id, e);
  const entries = Array.from(byId.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { version: 1, entries };
}

/**
 * 覆盖之前把本地那份挪到哪儿。
 *
 * 用户选了"覆盖同 id"，但"选了覆盖"不等于"愿意丢掉"：一次点错就把一条聊了很久的会话
 * 换成了几天前的快照，而那是不可逆的。挪进 trash 的代价是一点磁盘。
 */
export function trashDirFor(root: string, sessionId: string, now = new Date()): string {
  /* `20260925-080910` —— 日期和时间分开，排序和肉眼读都友好 */
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
  return path.join(root, 'trash', `restore-${stamp}`, sessionId);
}

/**
 * **每条会话最后一次真的传上去是什么时候** ——「每一个会话同步应该有最新同步到什么时间」。
 *
 * 为什么不能拿 catalog 里的 `syncedAt` 回答这个问题：那个字段是**每一轮**给所有条目盖同一个
 * `now`（见 `catalogEntriesFor`），它说的是"catalog 是什么时候写的"。一条一周没动过的会话
 * 文件根本没有重传，但它的 `syncedAt` 每 30 分钟还是会往前跳 ——
 * 拿它当"最新同步时间"会让人以为刚刚备份过，而实际上那份内容是一周前上去的。
 *
 * 也不能拿文件状态表（`路径 → {size, mtimeMs}`）回答：那里面记的是**本地文件**的大小和改动时间,
 * 和"什么时候上传的"是两件事。
 *
 * 所以单独记一张表：会话 id → { 上传时间, 当时的 updatedAt }。存 `updatedAt` 是为了能算出
 * **有没有还没传上去的改动** —— "上次同步是两天前"和"有两天的改动没备份"是完全不同的两句话,
 * 而后者才是人需要采取行动的那一句。
 *
 * 单独一个文件（不是塞进 `s3-sync-state.json`）：那个文件是扁平的 `路径 → 状态`，
 * 改形状要迁移，而迁移失败的表现是"下一轮全量重传"。
 */
export interface SessionSyncMark {
  /** 这条会话最后一次有文件被上传的时刻。 */
  at: number;
  /** 上传那一刻它的 `record.updatedAt` —— 用来判断之后有没有新改动。 */
  updatedAt: number;
}
export type SessionSyncMarks = Record<string, SessionSyncMark>;

export function readSessionMarks(file: string): SessionSyncMarks {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return (d && typeof d === 'object') ? d as SessionSyncMarks : {};
  } catch { return {}; }
}

export function writeSessionMarks(file: string, marks: SessionSyncMarks): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marks));
  } catch { /* 写不进去只是下次少一点信息，不值得报错 */ }
}

/**
 * 这条会话现在是什么同步状态。
 *
 * · 没记过 → `never`（从没传上去过）；
 * · 本地 `updatedAt` 比上传时记下的那个新 → `pending`（有改动还没备份）；
 * · 否则 → `synced`。
 *
 * 判据用 `updatedAt` 而不是比文件 mtime：`record.json` 每次 `writeRecord` 都会动
 * （哪怕内容没变），拿 mtime 判断会把"刚 attach 了一次"也算成"有改动没备份"。
 */
export function sessionSyncState(
  mark: SessionSyncMark | undefined,
  localUpdatedAt: number,
): 'never' | 'pending' | 'synced' {
  if (!mark || !mark.at) return 'never';
  return (Number(localUpdatedAt) || 0) > (Number(mark.updatedAt) || 0) ? 'pending' : 'synced';
}

/** 从上传的相对路径里认出会话 id（`sessions/<id>/…`）。不是会话文件就返回空。 */
export function sessionIdOfRel(rel: string): string {
  const parts = String(rel || '').split(/[\\/]/);
  return parts[0] === 'sessions' && parts[1] ? parts[1] : '';
}

/** 状态文件读写 —— 坏了就当空（备份不该因为一个状态文件坏掉而停）。 */
export function readState(file: string): SyncState {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return (d && typeof d === 'object') ? d as SyncState : {};
  } catch { return {}; }
}

export function writeState(file: string, state: SyncState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch { /* 状态写不进去只是下次多传一遍，不值得报错 */ }
}

/** 给日志用：只露 access key 的后 4 位。 */
export function maskKeyId(id?: string): string {
  const s = String(id || '');
  return s.length <= 4 ? '****' : `****${s.slice(-4)}`;
}

/** 本机标识（catalog 里的 `from`）—— 多台机器备份到同一个桶时用来分清来源。 */
export function machineTag(hostname: string): string {
  return crypto.createHash('sha1').update(hostname).digest('hex').slice(0, 6) + `-${hostname.split('.')[0]}`;
}
