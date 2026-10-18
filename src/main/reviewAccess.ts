/**
 * 侧栏 review「✓ 确认」写回的那道闸，和远端文件的写回 —— PURE（读写盘、ssh 都由调用方注入），主进程接线在 index.ts。
 *
 * 闸是"**这条会话**的标签页读过这一份"：`workspace:read` 读成功就按会话登记（`ReviewedPaths`），写回只认登记过的。
 * 远端文件（远程会话在它那台机器上写的，本机没有）按 `remoteReviewKey(机器, 路径)` 登记 —— 和本地同一个闸，
 * 别的会话不能借道；本机碰巧有个同名路径（Mac 上的 `/home/...`）也不会和它混。
 */

import { tr } from './uiText.ts';

/** 远端文件在白名单里的键 —— 带上机器。 */
export function remoteReviewKey(sshHost: string, remotePath: string): string {
  return `ssh://${sshHost}${remotePath}`;
}

/**
 * 每条会话为预览**读过**哪些文件 —— 键 `''` = 没带会话读的。只在内存里：进程重启就清空，
 * 恢复出来的标签页要重新读一次才算（渲染层第一次提交前会读，见 ReviewPane 的 `registerOnce`）。
 */
export class ReviewedPaths {
  private readonly bySession = new Map<string, Set<string>>();
  mark(sessionId: string | null | undefined, key: string): void {
    const sid = String(sessionId || '');
    let set = this.bySession.get(sid);
    if (!set) { set = new Set(); this.bySession.set(sid, set); }
    set.add(key);
  }
  has(sessionId: string | null | undefined, key: string): boolean {
    return !!this.bySession.get(String(sessionId || ''))?.has(key);
  }
}

export type ReviewTarget<R> =
  | { ok: true; want: string; remote?: R }
  | { ok: false; error: string; notPreviewed?: true };

/** 没登记过时给界面的那句话 —— 说清楚怎么办，而不是只说"不写"。 */
export const NOT_PREVIEWED = (): string => tr('This file was not opened for preview in a tab of this session, so it was not written (refresh the tab and submit again)');

/**
 * 渲染层给的路径 → 要写的那一份。顺序和 `workspace:read` 一样：本机解析出来的那份登记过就是它；
 * 本机没有这个路径、而它是那台机器上的路径（`remoteFor`）并且按远端键登记过 → 写那台机器上的同一个路径。
 */
export function pickReviewTarget<R extends { sshHost: string }>(input: {
  raw: string;
  resolveLocal: (raw: string) => string;
  localExists: (p: string) => boolean;
  remoteFor: (raw: string) => { target: R; path: string } | null;
  reviewed: (key: string) => boolean;
  /**
   * 这条会话的文件**不许改**时给出原因（标准版里 = KiroLex Advanced 的会话，判据在 `advancedOnly.ts`）。
   * 最先判 —— "预览过"也不放行：预览只是读，读过不等于这条会话归标准版管。
   */
  refuse?: () => string | null;
}): ReviewTarget<R> {
  const refused = input.refuse?.();
  if (refused) return { ok: false, error: refused };
  const raw = String(input.raw || '');
  if (!raw) return { ok: false, error: tr('No path') };
  let want: string;
  try { want = input.resolveLocal(raw); } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
  if (input.reviewed(want)) return { ok: true, want };
  if (!input.localExists(want)) {
    const remote = input.remoteFor(raw);
    if (remote && input.reviewed(remoteReviewKey(remote.target.sshHost, remote.path))) {
      return { ok: true, want: remote.path, remote: remote.target };
    }
  }
  return { ok: false, error: NOT_PREVIEWED(), notPreviewed: true };
}

/**
 * 写回一份文本：读 → 比 → 备份 → 写，和本地 `writeReviewFile` 同一套判据（不新建、比预览上限大不写、
 * `expectBase` 对不上不写、内容一样不写、**备份不成不写**）。远端文件用它：读写走 ssh，备份存本机。
 */
export async function writeTextVia(io: {
  max: number;
  /** 读不到（不存在 / 是目录）给 `null`；连不上就抛。`size` 是文件声明的大小，`bytes` 是实际读回来的字节数。 */
  read: () => Promise<{ size: number; bytes: number; text: string } | null>;
  backup: (previous: string) => Promise<boolean> | boolean;
  write: (text: string) => Promise<void>;
}, text: string, expectBase?: string): Promise<{ ok: boolean; error?: string; mismatch?: true; unchanged?: true; bytes?: number; was?: number }> {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: tr('The content is empty, so nothing was written') };
  try {
    const got = await io.read();
    if (!got) return { ok: false, error: tr('This file cannot be read right now. Not creating it; check that the path is right first') };
    if (got.size > io.max) {
      return { ok: false, error: tr('This file is larger than the preview limit (512KB). The preview only has the first part and writing it back would cut off the rest, so nothing was written') };
    }
    /* 读回来的比声明的少（ssh 中途断了）：拿残缺的原文去备份、去比，写下去就是丢内容 */
    if (got.bytes !== got.size) {
      return { ok: false, error: tr('The original read back is incomplete ({got} / {size} bytes). Nothing was backed up or written; submit again once the connection is stable', { got: got.bytes, size: got.size }) };
    }
    const previous = got.text;
    if (typeof expectBase === 'string' && previous !== expectBase) {
      return { ok: false, mismatch: true, error: tr('This file was changed by something else during the rewrite. This result was not written; check the new text and submit again') };
    }
    if (previous === text) return { ok: true, unchanged: true };
    if (!(await io.backup(previous))) {
      return { ok: false, error: tr('The pre-write backup failed. Without a copy to roll back to, nothing was changed this time. Check that ~/.kirolex/backups is writable.') };
    }
    await io.write(text);
    return { ok: true, bytes: text.length, was: previous.length };
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/**
 * 一份文件的备份文件名前缀：`<文件名>__<完整路径的短指纹>__`（后面接时间戳）。
 *
 * 带指纹是为了**按文件**清理（`reviewBackupsToPrune`）：只按文件名分的话，`a/README.md` 和 `b/README.md` 共用一份额度。
 * 文件名摆在最前面 —— 翻 `~/.kirolex/backups/review-files/` 找回某个文件时一眼认得出来。
 * 两种分隔符都认（Windows 路径是 `\`），文件名那一段最多留 `BACKUP_NAME_MAX` 个字符：备份名要在
 * 常见的 255 字符文件名上限以内，否则备份写不成、整次写回被拒。截掉的部分靠指纹区分。
 */
const BACKUP_NAME_MAX = 100;
export function reviewBackupPrefix(want: string): string {
  const name = (String(want || '').split(/[\\/]/).pop() || '').replace(/[^\w.-]+/g, '_').slice(0, BACKUP_NAME_MAX) || 'file';
  let h = 0x811c9dc5;
  for (const ch of String(want || '')) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return `${name}__${h.toString(16).padStart(8, '0')}__`;
}

/**
 * 刚给 `want` 写了一份备份之后，要删掉哪些（返回文件名）—— **只看这份文件自己的**，按时间留最近 `keep` 份。
 *
 * 原来是整个目录一起排、一共留 12 份：改别的文件十几次，这个文件改之前唯一的那份备份就被挤掉了。
 */
export function reviewBackupsToPrune(entries: Array<{ name: string; t: number }>, want: string, keep: number): string[] {
  const prefix = reviewBackupPrefix(want);
  return entries
    .filter((e) => e.name.startsWith(prefix))
    .sort((a, b) => b.t - a.t)
    .slice(keep)
    .map((e) => e.name);
}
