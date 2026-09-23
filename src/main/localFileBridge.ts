/**
 * **让远程会话读写镜像之外的本地文件** ——「给远程会话也加上读和修改本地文件的能力啊」。
 *
 * 为什么需要这一层：远端的 kiro-cli 只能看见**远端**的文件系统（实测它不用 ACP 的客户端 fs 能力，
 * 客户端声明了 `fs.readTextFile/writeTextFile` 之后它照样自己读，回调客户端 0 次）。所以一条远程
 * 会话能碰到的本地东西，只有**被镜像的那一个目录**；你让它读 `~/Downloads/x.md` 或另一个仓库里的
 * 文件，它在那台机器上根本没有那个路径 —— 而"读不到"会被它解释成"没有这个东西"。
 *
 * 做法：你在消息里提到的**绝对路径**，在这一轮开始前被**摆渡**进镜像里的一个暂存目录，
 * 消息里的路径同时改写成远端那一份；它改完之后，暂存目录里的内容按清单**写回原处**。
 *
 * 三条刻意的规则：
 *   · 只摆渡**你自己提到的**路径。不扫目录、不猜 —— 悄悄把一棵树搬过去正是这个功能最危险的走法
 *     （那笔账见 `mirrorRefusal`：一次误判推走了 6.1 GB 家目录和 17 把私钥）。
 *   · 凭据类路径一律不摆渡（和 `SENSITIVE_EXCLUDES` 同一份判据）。
 *   · 写回时沿用冲突规则：本地那份在这一轮里也变过，就**不覆盖**，远端那份落成 `<file>.remote`。
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** 暂存目录（镜像里的一个子目录，两边同名）。 */
export const BRIDGE_DIR = '_kirolex-local';

/** 摆渡单个文件的上限：再大就不是"一个文件"了，而且每轮都要来回传。 */
export const MAX_BRIDGE_BYTES = 8 * 1024 * 1024;

/** 不摆渡的路径（凭据 + KiroLex 自己的数据）。 */
const NEVER = [
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.gnupg\//,
  /(^|\/)\.kube\//,
  /(^|\/)\.kirolex\//,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.netrc$/,
  /\.pem$/,
  /(^|\/)id_(rsa|ecdsa|ed25519)(\.pub)?$/,
];

export function bridgeRefused(p: string): boolean {
  return NEVER.some((re) => re.test(p));
}

/**
 * 从一段文本里挑出**绝对路径**。
 *
 * 只认以 `/` 或 `~/` 开头、看起来像文件的东西（带后缀，或明确带目录分隔）。宁可漏，不可多：
 * 多认一个就意味着把一个你没打算给它的文件搬到另一台机器上。
 */
export function mentionedPaths(text: string, home = os.homedir()): string[] {
  const out = new Set<string>();
  const re = /(?:^|[\s"'`（(\[<])((?:~|\/)[^\s"'`）)\]>,;]+)/g;
  for (const m of String(text || '').matchAll(re)) {
    let p = m[1];
    /* 结尾的标点不算路径的一部分（中文句读也要去掉） */
    p = p.replace(/[.,;:!?。，；：！？、)]+$/u, '');
    if (p.startsWith('~')) p = path.join(home, p.slice(1));
    if (!path.isAbsolute(p)) continue;
    /* 看起来像文件：有后缀，或者至少两层目录 */
    if (!/\.[A-Za-z0-9]{1,8}$/.test(p) && p.split('/').length < 3) continue;
    out.add(p);
  }
  return [...out];
}

/** 暂存里的相对路径：`_kirolex-local/<目录哈希>/<文件名>`（同名文件来自不同目录时不会互相盖）。 */
export function stagedRel(localPath: string): string {
  const h = crypto.createHash('sha1').update(path.dirname(localPath)).digest('hex').slice(0, 8);
  return `${BRIDGE_DIR}/${h}/${path.basename(localPath)}`;
}

export interface BridgeEntry {
  /** 原始本地路径。 */
  local: string;
  /** 暂存里的相对路径。 */
  rel: string;
  /** 摆渡时的内容指纹 —— 写回时用它判断"远端改过没有"。 */
  hash: string;
  /** 摆渡时本地那份的指纹 —— 写回时用它判断"本地也改过没有"（冲突判定的另一半）。 */
  localHash: string;
}

export function fileHash(p: string): string {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return '';
  }
}

/** 清单落在镜像根下（它自己也会被同步过去，但模型用不到它 —— 只是给写回用的账本）。 */
export function manifestPath(localDir: string): string {
  return path.join(localDir, BRIDGE_DIR, 'manifest.json');
}

export function readManifest(localDir: string): BridgeEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(localDir), 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function writeManifest(localDir: string, entries: BridgeEntry[]): void {
  try {
    fs.mkdirSync(path.dirname(manifestPath(localDir)), { recursive: true });
    fs.writeFileSync(manifestPath(localDir), JSON.stringify(entries, null, 2));
  } catch { /* 账本写不下去时下面那步会跳过写回 —— 不写回比写错地方好 */ }
}

export interface StageResult {
  /** 这一轮新摆渡/刷新过的条目。 */
  staged: BridgeEntry[];
  /** 拒绝了的路径 + 原因（要告诉人，不能默默不管）。 */
  refused: { local: string; why: string }[];
}

/**
 * 把这些本地路径摆渡进镜像（已经在镜像里的、不存在的、凭据类的、太大的都跳过）。
 */
export function stageFiles(localDir: string, paths: string[]): StageResult {
  const staged: BridgeEntry[] = [];
  const refused: { local: string; why: string }[] = [];
  const existing = new Map(readManifest(localDir).map((e) => [e.local, e]));
  for (const p of paths) {
    const abs = path.resolve(p);
    if (abs.startsWith(`${path.resolve(localDir)}${path.sep}`)) continue;   // 已经在镜像里
    if (bridgeRefused(abs)) { refused.push({ local: abs, why: '凭据类路径不摆渡' }); continue; }
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { continue; }                      // 不存在就当没提
    if (st.isDirectory()) { refused.push({ local: abs, why: '只摆渡单个文件，不整目录搬' }); continue; }
    if (st.size > MAX_BRIDGE_BYTES) {
      refused.push({ local: abs, why: `太大（${(st.size / 1048576).toFixed(1)} MB）` });
      continue;
    }
    const rel = stagedRel(abs);
    const dest = path.join(localDir, rel);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    } catch (err: any) {
      refused.push({ local: abs, why: `拷不过去：${err?.message || err}` });
      continue;
    }
    const h = fileHash(dest);
    const entry: BridgeEntry = { local: abs, rel, hash: h, localHash: h };
    existing.set(abs, entry);
    staged.push(entry);
  }
  if (staged.length) writeManifest(localDir, [...existing.values()]);
  return { staged, refused };
}

export interface WriteBackResult {
  written: string[];
  conflicts: string[];
}

/**
 * 把暂存里被改过的内容写回原处。
 *
 * 判据和镜像那边一致：**远端改过**（暂存里的指纹和摆渡时不同）才写；如果**本地原文也变过**，
 * 就不覆盖，远端那份落成 `<原路径>.remote`。
 */
export function writeBack(localDir: string): WriteBackResult {
  const written: string[] = [];
  const conflicts: string[] = [];
  const entries = readManifest(localDir);
  if (!entries.length) return { written, conflicts };
  const next: BridgeEntry[] = [];
  for (const e of entries) {
    const staged = path.join(localDir, e.rel);
    const now = fileHash(staged);
    if (!now || now === e.hash) { next.push(e); continue; }        // 远端没改
    const localNow = fileHash(e.local);
    if (localNow && localNow !== e.localHash) {
      /* 两边都改了 —— 不动你的那份 */
      try { fs.copyFileSync(staged, `${e.local}.remote`); conflicts.push(e.local); } catch {}
      next.push({ ...e, hash: now });
      continue;
    }
    try {
      fs.copyFileSync(staged, e.local);
      written.push(e.local);
      next.push({ ...e, hash: now, localHash: now });
    } catch {
      next.push(e);
    }
  }
  writeManifest(localDir, next);
  return { written, conflicts };
}
