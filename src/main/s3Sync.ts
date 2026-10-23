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
 *   · `mcp-combos.json` —— Claude Code / Codex 的「组合」，多台电脑共用一份（两边都改过时合并，见 `mcpCombosSync.ts`）。
 *   · `agent-profiles/**` —— 远程机器的 AI 工具配置，同样多台电脑共用（两边都改过时留冲突副本，见 `agentProfileSync.ts`）。
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

/**
 * 会话生成的文件放在 `sessions/<id>/<这个目录>/` 下 ——「这样这个文件夹也可以和会话的内容一起被同步、
 * 恢复、或者删除」。整棵跟着会话传（单个文件仍受 `MAX_FILE_BYTES` 限制）；恢复是按 `sessions/<id>/` 前缀拉的，
 * 删会话 / 删备份也是按这个前缀，所以它自动跟着走。
 */
export const SESSION_FILES_DIR = 'files';

/** 整体同步的那几棵树（相对 `~/.kirolex`）。 */
export const SHARED_DIRS = ['memory', 'attachments', 'pasted'];

/** 默认间隔。30 分钟：会话是聊出来的，丢 30 分钟等于丢一两轮。 */
export const DEFAULT_INTERVAL_MINUTES = 30;

/** 单个文件上限 —— 超了跳过并说一句。备份不该被一个巨大的粘贴图拖死。 */
/*
  200MB ——「32MB 的限制可能太低了」。会话 files/ 现在是工作目录，pptx / pdf / 录音这类真产出
  常常过 32MB。压缩包和安装包另有一道按扩展名的排除（见 `isArchiveFile`），不靠这个上限挡。
*/
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

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
  /**
   * **不同步的会话**（按会话 id）——「我现在还是不能选择是否备份会话」。和项目那张表同一个口径：
   * 存"排除"，新会话默认跟着同步；已经传上去的不删，只是不再继续传。
   */
  excludeSessions?: string[];
  accessKeyId?: string;
  /** `safeStorage` 加密后的 secret（base64）。**明文永不落盘**。 */
  secretCipher?: string;
  endpoint?: string;
}

/** 状态文件里一条记录。 */
export interface FileState {
  size: number;
  mtimeMs: number;
  /**
   * 记忆文件专用：上一次同步时**桶里那份**是什么样（S3 的 LastModified 毫秒 + 大小）。
   * 没有它就分不清"桶里那份是别的机器改的"还是"就是我自己上次传的" —— 而那正是
   * "谁新用谁"要回答的问题。`remoteAt` 为 0 = 刚传上去、还没从列表里读到服务器时间（见 `decideMemory`）。
   */
  remoteAt?: number;
  remoteSize?: number;
}
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
  /** 这条会话是不是归档了（`record.archived`）。老条目没有 → 当未归档。 */
  archived?: boolean;
  /**
   * 项目 / 归档最后一次被**用户**改动的时刻（`record.placementChangedAt`）——
   * 「同步时让会话的项目和归档状态在多台机器间自动跟随」。见 `placementToFollow`。
   * 老条目没有 → 0（永远不会被拿去跟随）。
   */
  placementChangedAt?: number;
  /**
   * 这条会话的文件**真的**传到桶里的最后时刻（上传那台机器的时钟）——和删除记录比谁新用（见 `catalogStore.ts`）。
   * 不能用 `syncedAt`：那个每一轮给所有条目盖同一个 now，没传文件的条目也会显得"刚传过"，删掉的就又复活了。
   * 老条目没有 → 0（有删除记录时一律当删除更新）。
   */
  uploadedAt?: number;
}

/**
 * **删除记录（tombstone）** —— 某条会话的备份在 `at`（删除那台机器的时钟）被删掉了。
 * 格式和云端回收站（DeviceManifest.deleted）共用：`{ id, at }`。
 * 合并时删除记录比条目新（`at >= uploadedAt`）→ 条目不许复活；之后真的又上传过（`uploadedAt > at`）→ 条目回来、记录作废。
 */
export interface Tombstone { id: string; at: number }

export interface Catalog {
  version: 1;
  entries: CatalogEntry[];
  /** 删除记录。老 catalog 没有。 */
  deleted?: Tombstone[];
}

/**
 * 一条会话"放在哪儿"：哪个项目、归没归档、这个位置是什么时候被用户改的。
 *
 * 为什么单独一个时间戳而不是用 `updatedAt`：`updatedAt` 每发一条消息都会动。A 把会话移到 Y 之后，
 * B 上这条只要又聊过一句，B 的 `updatedAt` 就更新 —— 按它判谁新，B 会把旧的项目传回去，
 * A 的移动被悄悄盖掉。位置只该跟"谁后挪的"走。
 */
export interface Placement { projectId: string; archived: boolean; placementChangedAt: number }

export function placementOf(rec: { profile?: any; archived?: any; placementChangedAt?: any } | null | undefined): Placement {
  const pid = (rec?.profile as any)?.projectId;
  return {
    projectId: typeof pid === 'string' ? pid.trim() : '',
    archived: !!rec?.archived,
    placementChangedAt: Number(rec?.placementChangedAt) || 0,
  };
}

/**
 * 本机这条要不要跟随桶里那条的位置 —— 要就返回跟随成什么，不要就 `null`。
 *
 * 只看 `placementChangedAt`：桶里的严格更新才跟。老条目 / 老记录没有这个字段当 0 ——
 * 桶里是 0 就永远不跟，所以升级前的 catalog 不会把本机的位置乱改。
 */
export function placementToFollow(
  local: { profile?: any; archived?: any; placementChangedAt?: any } | null | undefined,
  theirs: CatalogEntry | null | undefined,
  /**
   * 这个项目**不许跟进去**（标准版里 = KiroLex Advanced 专属的 flow 项目，判据在 `advancedOnly.ts`）。
   * 别的机器把会话挪进了这样的项目 → 这台不跟，保持本机的位置；否则一条普通会话进去，那个项目就不再受保护。
   */
  refuseProject?: (projectId: string) => boolean,
): Placement | null {
  if (!local || !theirs) return null;
  const at = Number(theirs.placementChangedAt) || 0;
  if (at <= placementOf(local).placementChangedAt) return null;
  const projectId = typeof theirs.project === 'string' ? theirs.project.trim() : '';
  if (projectId && projectId !== placementOf(local).projectId && refuseProject?.(projectId)) return null;
  return {
    projectId,
    archived: !!theirs.archived,
    placementChangedAt: at,
  };
}

/** 把位置写进一份记录的副本 —— 只动 projectId / archived / placementChangedAt，别的原样。 */
export function applyPlacement<T extends { profile?: any }>(rec: T, p: Placement): T {
  const profile = { ...(rec.profile || {}) };
  if (p.projectId) profile.projectId = p.projectId;
  else delete profile.projectId;
  return { ...rec, profile, archived: p.archived, placementChangedAt: p.placementChangedAt };
}

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
  /**
   * **记忆跟着会话 / 项目走** ——「会话和 project 备份时把 project 和 session 的记忆也备份进去」。
   * 给了这个参数，`memory/` 就不再整棵传：只传 `global.md`、**要备份的**项目那几份、**要备份的**会话那几份。
   * 以前整棵传的结果是：设成不同步的项目（和它下面的会话）的记忆照样上了桶。
   * 不给 = 老行为（整棵传），只为了老调用方。
   */
  memory?: { projects: string[] },
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

  for (const id of sessionIds) {
    for (const f of SESSION_FILES) consider(path.join('sessions', id, f));
    for (const rel of walkSessionFiles(root, path.join('sessions', id, SESSION_FILES_DIR))) consider(rel);
  }
  if (memory) {
    for (const rel of memoryRelsFor(root, sessionIds, memory.projects)) consider(rel);
    for (const dir of SHARED_DIRS) if (dir !== 'memory') for (const rel of walk(root, dir)) consider(rel);
  } else {
    for (const dir of SHARED_DIRS) for (const rel of walk(root, dir)) consider(rel);
  }
  return { upload, skippedUnchanged, skippedTooBig };
}

/** 只属于这几条会话、这几个项目的记忆文件（加上全局那一份）。项目 / 会话 id 里带路径分隔符的不认。 */
export function memoryRelsFor(root: string, sessionIds: string[], projects: string[]): string[] {
  const safe = (x: string): boolean => !!x && !/[\\/]|\.\./.test(x);
  return [
    ...walk(root, 'memory').filter((rel) => path.dirname(rel) === 'memory'),
    ...projects.filter(safe).flatMap((p) => walk(root, path.join('memory', 'projects', p))),
    ...sessionIds.filter(safe).flatMap((id) => walk(root, path.join('memory', 'sessions', id))),
  ];
}

/**
 * **恢复记忆 = 合并，不是覆盖** —— 记忆是一行一条的 markdown（「append a concise bullet」），
 * 所以"本地的原样保留，备份里有而本地没有的行按原顺序补在后面"是不丢东西的那个答案：
 * 本机后来教的不会被一份旧备份盖掉，备份里有的也都回来了。比较按去掉首尾空白的整行，空行不算。
 */
/**
 * **记忆怎么同步：谁新用谁，本机第一次先拉** ——「记忆不必合并，只要自己的是最新的就可以上传。
 * 第一次同步的时候确保先拉而不是传空的就行」。
 *
 * 实测撞过的那件事：Windows 是新装的，记忆文件是刚建出来的空壳，mtime 是"现在" —— 按文件时间比，
 * 它们比桶里 Mac 传的真记忆**更新**，于是一同步就把 22 KB 的 Dev 记忆盖成了 23 字节。
 * 所以"新"不能按 mtime 跟桶比，要按"**自上次同步以来谁动过**"：
 *
 *   · 本机从没同步过这一份（`last` 为空）：桶里有就**拉**；桶里没有才传。
 *   · 只有本机动过 → 传；只有桶里动过（别的机器传的）→ 拉。
 *   · 两边都动过 → 时间新的那边赢（本机 mtime 对桶的 LastModified）。
 *   · 都没动 → 什么都不做。
 *
 * "桶里动过"的判据：记着上次看到的 LastModified 就比它；刚传完还没读到（`remoteAt` 为 0）就比大小 ——
 * 不拿本机时钟去比服务器时钟，两边差一秒就会把自己刚传的当成"别人改的"再拉回来。
 */
export function decideMemory(
  local: { size: number; mtimeMs: number } | undefined,
  remote: { size: number; at: number } | undefined,
  last: FileState | undefined,
): 'pull' | 'upload' | 'none' {
  if (!last) {
    if (remote) return 'pull';
    return local ? 'upload' : 'none';
  }
  if (!local && !remote) return 'none';
  if (!local) return 'pull';                       // 本机被删了但桶里有：拉回来（删记忆该在界面里删，不是靠同步）
  const localChanged = local.size !== last.size || Math.floor(local.mtimeMs) !== last.mtimeMs;
  if (!remote) return 'upload';                    // 桶里没有（被删了 / 新桶）：传
  const remoteChanged = last.remoteAt
    ? remote.at > last.remoteAt
    : remote.size !== (last.remoteSize ?? last.size);
  if (localChanged && !remoteChanged) return 'upload';
  if (!localChanged && remoteChanged) return 'pull';
  if (localChanged && remoteChanged) return local.mtimeMs >= remote.at ? 'upload' : 'pull';
  return 'none';
}

/**
 * 项目记忆在 mark 表里的键。和会话 id 共用一张表（`s3-session-sync.json`）——
 * 加 `memory:` 前缀，会话 id 永远不会以它开头，所以不会撞。
 */
export function projectMemoryMarkKey(project: string): string {
  return `memory:projects/${project}`;
}

export function mergeMemoryText(local: string, backup: string): string {
  if (!local.trim()) return backup;
  const have = new Set(local.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const extra: string[] = [];
  for (const l of backup.split(/\r?\n/)) {
    const k = l.trim();
    if (!k || have.has(k)) continue;
    have.add(k);
    extra.push(l);
  }
  if (!extra.length) return local;
  return `${local.replace(/\s*$/, '')}\n${extra.join('\n')}\n`;
}

/**
 * **会话 files/ 里不同步的依赖目录** ——「S3 里只存代码」。
 *
 * files/ 现在是会话的工作目录，模型会在里面 `pip install -t build/`、`npm install`、建 venv。
 * 实测把旧的 Downloads 输出搬进来之后，三条会话的 files/ 是 1.4G / 689M / 99M、合计九万个文件，
 * 去掉依赖之后只剩几十个 —— 全是可以重新装出来的东西，传上去只会把同步拖死。
 *
 * 按**内容**认依赖目录，不按名字猜：`build/` 有时是依赖（`pip install -t build`），有时是产出。
 *   · 名字是公认的依赖/缓存目录；
 *   · 或者里面有 `pyvenv.cfg`（venv）；
 *   · 或者里面有 `*.dist-info`（`pip install -t` 装出来的）；
 *   · 或者里面有 `.git`（clone 下来的代码仓库，正本在 git 远端）。
 * 点开头的（`.venv` / `.git`）`walk` 本来就跳过。
 */
const DEP_DIR_NAMES = new Set(['node_modules', '__pycache__', 'site-packages', 'venv', 'cdk.out', 'bower_components']);
export function isDependencyDir(abs: string, name: string): boolean {
  if (DEP_DIR_NAMES.has(name)) return true;
  let kids: string[];
  try { kids = fs.readdirSync(abs); } catch { return false; }
  /* 带 .git 的是 clone 下来的代码仓库 ——「code repo 和大块东西不用动」：它在 git 远端有正本，不进备份 */
  return kids.includes('.git') || kids.includes('pyvenv.cfg') || kids.some((k) => k.endsWith('.dist-info'));
}

/**
 * 压缩包 / 安装包不进备份 ——「提到 200MB，但 .zip/.pkg 这类安装包和压缩包不传」。
 * 会话里的这类文件几乎都是部署产物（打包的 Lambda、下载的 AWS CLI 安装器），能重新生成或重新下载。
 * 只对会话 files/ 生效：attachments/ 里的是用户自己贴进来的，照常同步。
 */
const ARCHIVE_EXT = /\.(zip|pkg|dmg|msi|exe|deb|rpm|iso|tar|tgz|gz|bz2|xz|7z|rar|whl|jar|war)$/i;
export function isArchiveFile(name: string): boolean {
  return ARCHIVE_EXT.test(name);
}

/** 会话 files/ 的列举：和 `walk` 一样，但跳过依赖目录（见 `isDependencyDir`）和压缩包/安装包。 */
export function walkSessionFiles(root: string, rel: string): string[] {
  const abs = path.join(root, rel);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const childRel = path.join(rel, e.name);
    if (e.isDirectory()) {
      if (isDependencyDir(path.join(abs, e.name), e.name)) continue;
      out.push(...walkSessionFiles(root, childRel));
    } else if (!isArchiveFile(e.name)) out.push(childRel);
  }
  return out;
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

/** 某条会话在 conflicts/ 下的前缀（以本机为准时要一起清掉）。 */
export function conflictPrefixFor(prefix: string | undefined, sessionId: string): string {
  return `${joinPrefix(prefix)}${LAYOUT}/conflicts/${sessionId}/`;
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
  /* 别的字段（删除记录 deleted 等）原样带着 —— 丢了删除记录，删掉的条目就会被别的机器的旧条目复活 */
  return { ...(old || {}), version: 1, entries };
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
  /**
   * 这条会话最后一个文件**真的传完**的时刻 —— catalog 条目的 `uploadedAt`，和删除记录比谁新（见 catalogStore.ts）。
   * 不能用 `at`：那是整轮同步结束时才盖的，传完之后、这一轮结束之前别的机器删了它，`at` 会晚于删除记录，
   * 下一轮没上传也会被当成"删除之后又传过"，把没文件的条目复活。老的 marks 没有这个字段。
   */
  uploadedAt?: number;
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
  /**
   * 文件状态表里有没有这条会话的记录 —— 也就是"**传过**，但不知道是什么时候"。
   *
   * 这个参数不是可选的锦上添花，它挡的是两个必然会出现的错报：
   *
   * 1. **增量同步会跳过没变的文件**，于是一条内容没动过的会话永远不会再进
   *    `touchedSessions`，也就永远拿不到 mark —— 没有这个兜底的话它会被一直说成"没备份过",
   *    而它其实躺在桶里好好的；
   * 2. **这张 mark 表是后加的**，存量会话一个 mark 都没有。升级之后满屏"没备份过"
   *    会让人以为备份从来没工作过，然后去点「立即同步」—— 而那一轮只会跳过它们，
   *    界面一个字都不变。
   *
   * 所以"传过但时间不明"要能表达出来：`synced` + `at: 0`，界面上说"已同步（时间未知）"。
   * 编一个时间比说"不知道"糟 —— 那会让人拿一个假时间去判断备份新不新。
   */
  uploadedBefore = false,
): 'never' | 'pending' | 'synced' {
  if (!mark || !mark.at) return uploadedBefore ? 'synced' : 'never';
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
