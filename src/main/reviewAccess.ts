/**
 * 侧栏 review「✓ 确认」写回的那道闸，和远端文件的写回 —— PURE（读写盘、ssh 都由调用方注入），主进程接线在 index.ts。
 *
 * 闸是"**这条会话**的标签页读过这一份"：`workspace:read` 读成功就按会话登记（`ReviewedPaths`），写回只认登记过的。
 * 远端文件（远程会话在它那台机器上写的，本机没有）按 `remoteReviewKey(机器, 路径)` 登记 —— 和本地同一个闸，
 * 别的会话不能借道；本机碰巧有个同名路径（Mac 上的 `/home/...`）也不会和它混。
 */

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
export const NOT_PREVIEWED = '这个文件不是这条会话的标签页打开预览过的 —— 不写（刷新一下这个标签页再提交）';

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
}): ReviewTarget<R> {
  const raw = String(input.raw || '');
  if (!raw) return { ok: false, error: '没有路径' };
  let want: string;
  try { want = input.resolveLocal(raw); } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
  if (input.reviewed(want)) return { ok: true, want };
  if (!input.localExists(want)) {
    const remote = input.remoteFor(raw);
    if (remote && input.reviewed(remoteReviewKey(remote.target.sshHost, remote.path))) {
      return { ok: true, want: remote.path, remote: remote.target };
    }
  }
  return { ok: false, error: NOT_PREVIEWED, notPreviewed: true };
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
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '内容是空的，不写' };
  try {
    const got = await io.read();
    if (!got) return { ok: false, error: '这个文件现在读不到 —— 不新建，先确认路径对不对' };
    if (got.size > io.max) {
      return { ok: false, error: '这个文件比预览上限（512KB）大 —— 预览里只有前半截，写回去会把后面截掉，所以不写' };
    }
    /* 读回来的比声明的少（ssh 中途断了）：拿残缺的原文去备份、去比，写下去就是丢内容 */
    if (got.bytes !== got.size) {
      return { ok: false, error: `读回来的原文不完整（${got.bytes} / ${got.size} 字节）—— 没备份、没写，等连接稳定了再提交` };
    }
    const previous = got.text;
    if (typeof expectBase === 'string' && previous !== expectBase) {
      return { ok: false, mismatch: true, error: '这份文件在改写期间被别的改动动过了 —— 这次的结果没写进去，看一眼新的正文再提一次' };
    }
    if (previous === text) return { ok: true, unchanged: true };
    if (!(await io.backup(previous))) {
      return { ok: false, error: '写前备份失败 —— 没有可回滚的副本，所以这次不改。检查 ~/.kirolex/backups 能不能写。' };
    }
    await io.write(text);
    return { ok: true, bytes: text.length, was: previous.length };
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error) };
  }
}
