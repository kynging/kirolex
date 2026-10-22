/**
 * **`~/.kirolex/agent-profiles/` 跟着 S3 同步** ——「这份配置也要进备份」，和 `mcp-combos.json` 一样跨电脑共用。
 *
 * 和会话同一个桶、同一个 key 布局（`<prefix>/v1/agent-profiles/<相对路径>`）。逐个文件按**内容摘要**判断谁动过
 * （同 `mcpCombosSync.ts` 的理由：大小相同、内容不同的文件按大小比会被当成没变）：
 *   · 只有一边有 / 只有一边动过 → 用那一边（拉之前本机那份先进 trash，由调用方做）；
 *   · **两边都动过 / 本机第一次同步但两边内容不同** → **冲突：两边都不覆盖**。本机这份留着，桶里那份存成
 *     `agent-profiles/.conflicts/<时间>/<相对路径>`（不下发、不上传），界面上列出来让人自己挑；
 *     摘要记成「两边各是什么」，下一轮不重复报，直到某一边再改。
 *   · 上传带 ETag 条件：下载之后别的电脑又传过 → 这个文件这一轮不传（不盖掉对方），下一轮再比。
 *
 * 纯逻辑，不碰 electron、不碰网络；`index.ts` 的 `syncAgentProfilesWithBucket` 接 S3 和磁盘。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_PROFILES_REL, PROFILE_CONFLICTS_DIR } from './agentProfile.ts';

/** 单个文件上限（profile.json / rules 都是小文本；大文件多半是放错了地方）。 */
export const PROFILE_FILE_MAX = 2 * 1024 * 1024;

export interface ProfileFileMark { localHash: string; remoteHash: string }
export type ProfileMarks = Record<string, ProfileFileMark>;

export function contentHash(text: string | Buffer): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 这个相对路径（`/` 分隔，相对 agent-profiles）要不要同步：冲突副本、临时文件、隐藏文件不同步，`..` 一律不收。 */
export function syncableRel(rel: string): boolean {
  if (!rel || rel.includes('\\') || rel.startsWith('/')) return false;
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) return false;
  if (parts[0] === PROFILE_CONFLICTS_DIR) return false;
  return !/\.tmp$|~$/.test(rel);
}

/** 本机 agent-profiles 下要同步的文件（相对路径用 `/`）。 */
export function listLocalProfileFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(path.join(dir, e.name), r); continue; }
      if (!e.isFile() || !syncableRel(r)) continue;
      try { if (fs.statSync(path.join(dir, e.name)).size <= PROFILE_FILE_MAX) out.push(r); } catch { /* 读不了 */ }
    }
  };
  walk(root, '');
  return out.sort();
}

export type ProfileFileAction = 'none' | 'upload' | 'pull' | 'conflict';

/** 一个文件这一轮怎么办。`local` / `remote` 是内容摘要（没有 = undefined）。 */
export function planProfileFile(local: string | undefined, remote: string | undefined, mark: ProfileFileMark | undefined): ProfileFileAction {
  if (local === undefined && remote === undefined) return 'none';
  if (local !== undefined && local === remote) return 'none';
  if (remote === undefined) return 'upload';
  if (local === undefined) return 'pull';
  const localChanged = !mark || local !== mark.localHash;
  const remoteChanged = !mark || remote !== mark.remoteHash;
  if (localChanged && remoteChanged) return 'conflict';
  if (localChanged) return 'upload';
  if (remoteChanged) return 'pull';
  return 'none';
}

export interface ProfileSyncIo {
  /** 桶里 agent-profiles 下有哪些文件（相对路径，`/` 分隔）。 */
  listRemote: () => Promise<string[]>;
  get: (rel: string) => Promise<{ body: Buffer; etag: string } | null>;
  put: (rel: string, body: Buffer, cond: { ifMatch: string } | { ifNoneMatch: '*' }) => Promise<'ok' | 'conflict'>;
  listLocal: () => string[];
  readLocal: (rel: string) => Buffer | undefined;
  /** 拉：覆盖本机（调用方先把旧的放进 trash）。 */
  writeLocal: (rel: string, body: Buffer) => void;
  /** 冲突：把桶里那份存成冲突副本，返回存在哪。 */
  writeConflictCopy: (rel: string, body: Buffer) => string;
  readMarks: () => ProfileMarks;
  writeMarks: (marks: ProfileMarks) => void;
}

export interface ProfileSyncReport {
  uploaded: string[];
  pulled: string[];
  conflicts: Array<{ rel: string; copy: string }>;
  /** 同步途中有一边又变了（上传时别的电脑刚传过 / 要拉的时候本机刚改过）：这一轮没动它。 */
  raced: string[];
}

export async function syncProfileFiles(io: ProfileSyncIo): Promise<ProfileSyncReport> {
  const report: ProfileSyncReport = { uploaded: [], pulled: [], conflicts: [], raced: [] };
  const marks = { ...io.readMarks() };
  const remoteList = (await io.listRemote()).filter(syncableRel);
  const rels = [...new Set([...io.listLocal().filter(syncableRel), ...remoteList])].sort();
  for (const rel of rels) {
    const got = remoteList.includes(rel) ? await io.get(rel) : null;
    if (got && got.body.length > PROFILE_FILE_MAX) continue;
    /*
      **本机内容在下载完之后才读**：下载要等网络，这期间你可能在界面上刚存了一份（或者新建了这个文件）。
      先读后等的话，判断用的是旧内容，拉下来就把你刚存的盖掉了。从这里到写盘之间没有 await，
      主进程里别的写入（保存走的也是主进程）插不进来；写之前再核对一遍，作为第二道。
    */
    const localBuf = io.readLocal(rel);
    const lh = localBuf ? contentHash(localBuf) : undefined;
    const rh = got ? contentHash(got.body) : undefined;
    const action = planProfileFile(lh, rh, marks[rel]);
    if (action === 'none') {
      if (lh && rh) marks[rel] = { localHash: lh, remoteHash: rh };
      continue;
    }
    if (action === 'pull' && got) {
      const nowBuf = io.readLocal(rel);
      if ((nowBuf ? contentHash(nowBuf) : undefined) !== lh) { report.raced.push(rel); continue; }   // 本机刚又变了：这一轮不拉，下一轮按冲突 / 上传重新判
      io.writeLocal(rel, got.body);
      marks[rel] = { localHash: rh!, remoteHash: rh! };
      report.pulled.push(rel);
      continue;
    }
    if (action === 'upload' && localBuf) {
      const r = await io.put(rel, localBuf, got ? { ifMatch: got.etag } : { ifNoneMatch: '*' });
      if (r === 'conflict') { report.raced.push(rel); continue; }
      marks[rel] = { localHash: lh!, remoteHash: lh! };
      report.uploaded.push(rel);
      continue;
    }
    if (action === 'conflict' && got && lh) {
      const copy = io.writeConflictCopy(rel, got.body);
      marks[rel] = { localHash: lh, remoteHash: rh! };
      report.conflicts.push({ rel, copy });
    }
  }
  io.writeMarks(marks);
  return report;
}

export function readProfileMarks(file: string): ProfileMarks {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const out: ProfileMarks = {};
    if (v && typeof v === 'object') {
      for (const [k, m] of Object.entries<any>(v)) {
        if (typeof m?.localHash === 'string' && typeof m?.remoteHash === 'string') out[k] = { localHash: m.localHash, remoteHash: m.remoteHash };
      }
    }
    return out;
  } catch { return {}; }
}

export function writeProfileMarks(file: string, marks: ProfileMarks): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marks));
  fs.renameSync(tmp, file);
}

/** 本机现有的冲突副本（界面上列出来）：`.conflicts/<时间>/<相对路径>`。 */
export function listConflictCopies(root: string): string[] {
  const base = path.join(root, PROFILE_CONFLICTS_DIR);
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) out.push(`${AGENT_PROFILES_REL}/${PROFILE_CONFLICTS_DIR}/${r}`);
    }
  };
  walk(base, '');
  return out.sort();
}
