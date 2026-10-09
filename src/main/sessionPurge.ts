import * as fs from 'fs';
import * as path from 'path';

/**
 * 删除会话时「把目录移进回收站」那一步，带**真正等待**的重试。
 *
 * 在 Windows 上，刚断开的 kiro-cli（以及它起的子进程）要过一会儿才放手 `sessions/<id>/files`，这期间
 * rename 报 EBUSY / EPERM。原来的写法连试 5 次、中间不等，几毫秒就全部失败，于是删除报「被占用」。
 * 这里每次失败后 `await` 一段逐次加长的时间（默认合计约 4 秒）—— 是异步等待，不会把主进程卡住。
 *
 * 仍然是**先移到回收站**（可恢复）；只有最后一次还失败、或者错误不是「被占用」（例如跨盘 rename）时，才退回
 * 原来那条强删的路，让「删除」不会静默失败。
 */
export const LOCK_RETRY_DELAYS_MS = [100, 200, 300, 500, 800, 1000, 1200];

/** 运行期间的后台补删：目录一直被占用时，隔 30 秒、2 分钟、5 分钟再试，不只靠下次启动。 */
export const BACKGROUND_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];

export type FsOps = {
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string, opts: { recursive: true }) => unknown;
  renameSync: (from: string, to: string) => void;
  /** 兜底强删 —— **异步**（`fs.promises.rm`）：它自己的重试和等待都不占主进程，界面和别的会话照常响应 */
  rm: (p: string, opts: { recursive: true; force: true; maxRetries?: number; retryDelay?: number }) => Promise<void>;
};

const NODE_FS_OPS: FsOps = {
  existsSync: (p) => fs.existsSync(p),
  mkdirSync: (p, o) => fs.mkdirSync(p, o),
  renameSync: (a, b) => fs.renameSync(a, b),
  rm: (p, o) => fs.promises.rm(p, o),
};

export type MoveToTrashOptions = {
  trashDir: string;
  /** 回收站里的目录名前缀（会话 id），后面再拼时间戳 */
  name: string;
  fsOps?: FsOps;
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (level: 'info' | 'warn', msg: string) => void;
};

/** 「被占用」一类、等一会儿可能就好的错误。 */
export function isLockError(err: any): boolean {
  const code = err?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 移进回收站；成功（或目录本来就不在）返回 null，否则返回错误说明。 */
export async function moveDirToTrash(dir: string, opts: MoveToTrashOptions): Promise<string | null> {
  const f = opts.fsOps || NODE_FS_OPS;
  const delays = opts.delaysMs || LOCK_RETRY_DELAYS_MS;
  const sleep = opts.sleep || defaultSleep;
  const now = opts.now || (() => new Date());
  const log = opts.log || (() => {});
  const attempts = delays.length + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (!f.existsSync(dir)) return null;
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      const grave = path.join(opts.trashDir, `${opts.name}__${stamp}`);
      f.mkdirSync(opts.trashDir, { recursive: true });
      f.renameSync(dir, grave);
      if (!f.existsSync(dir)) {
        log('info', `moved to trash: ${grave} (restore by moving it back to ${dir})`);
        return null;
      }
    } catch (err: any) {
      const last = attempt === attempts - 1;
      if (isLockError(err) && !last) {
        await sleep(delays[attempt]);
        continue;
      }
      // A cross-device rename (or a directory that stayed locked through every
      // wait) cannot be helped by retrying; fall back to the destructive path so
      // "delete" never silently fails and resurrects the chat on next boot.
      try {
        await f.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
        log('warn', `could not move to trash (${err?.message}); removed permanently: ${dir}`);
        return f.existsSync(dir) ? 'directory still present after retries' : null;
      } catch (hardErr: any) {
        return hardErr?.message || err?.message || String(err);
      }
    }
  }
  return f.existsSync(dir) ? 'directory still present after retries' : null;
}

/**
 * 在后台按 `delaysMs` 依次再试 `attempt`，直到它返回 true（删干净了）或次数用完。
 * 定时器 `unref`，不会因为它拖住退出。返回一个取消函数。
 */
export function scheduleBackgroundRetries(
  attempt: () => Promise<boolean>,
  opts: {
    delaysMs?: number[];
    setTimer?: (fn: () => void, ms: number) => unknown;
    onGiveUp?: () => void;
  } = {},
): () => void {
  const delays = opts.delaysMs || BACKGROUND_RETRY_DELAYS_MS;
  const setTimer = opts.setTimer || ((fn: () => void, ms: number) => {
    const t: any = setTimeout(fn, ms);
    t?.unref?.();
    return t;
  });
  let cancelled = false;
  const step = (i: number) => {
    if (cancelled) return;
    if (i >= delays.length) { opts.onGiveUp?.(); return; }
    setTimer(() => {
      if (cancelled) return;
      attempt().then((done) => { if (!done) step(i + 1); }, () => step(i + 1));
    }, delays[i]);
  };
  step(0);
  return () => { cancelled = true; };
}

/** 等 `p` 完成，但最多等 `ms`；超时不抛错，返回 false。 */
export async function waitAtMost(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([p.then(() => true, () => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
