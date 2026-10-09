/**
 * **本机控制入口** —— 给 agent-board 的「拉取并重启」用：让外部工具请 KiroLex 走正常流程退出。
 *
 * 只听 127.0.0.1 的一个随机端口；端口、token、pid 写在 `~/.kirolex/control.json`，退出时删掉。
 *
 * - `GET /ping`  → 200 `{"ok":true,"pid":…,"busy":<忙的会话数>}`，等待退出期间再加 `"pendingQuit":true`。不要 token。
 * - `POST /quit` → 要 `Authorization: Bearer <token>`，否则 401。
 *   - 没有会话在跑 → 202 `{"quitting":true}`，然后调 `onQuit`。
 *   - 有 → 202 `{"quitting":false,"waiting":<数量>}`，进入「等待退出」：`onPendingChange(true)` 让 index.ts
 *     停掉排队消息和定时 / 循环任务的新一轮，每秒查一次，全部空下来再调 `onQuit`。
 *   - `?force=1` → 不等，直接 `onQuit`（备用）。
 * - `POST /quit/cancel` → 要 token。取消等待，`onPendingChange(false)` 恢复排队和定时任务。
 * - 其它一律 404。
 *
 * **用户正在用的会话不能被打断** —— 所以默认是等，不是退。
 *
 * `onQuit` 由 index.ts 传进来，就是托盘「Quit」那条路径（`isQuitting = true; app.quit()`），
 * 这样 `before-quit` 会照常断开每条 kiro-cli 会话、释放会话锁 —— 不能 `process.exit`。
 *
 * 这里不 import electron，单测能直接起。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blocksQuit, type BusySession } from './busySessions.ts';

export const CONTROL_FILE = path.join(os.homedir(), '.kirolex', 'control.json');
export const QUIT_POLL_MS = 1000;

/* ───────────────────────── 等待退出 ───────────────────────── */

export interface QuitCoordinatorOptions {
  onQuit: () => void;
  /** 现在忙的会话；默认谁都不忙 */
  getBusy?: () => BusySession[];
  /** 进入 / 离开「等待退出」—— index.ts 据此暂停 / 恢复排队和定时任务 */
  onPendingChange?: (pending: boolean) => void;
  pollMs?: number;
  log?: (msg: string) => void;
}

export type QuitDecision = { quitting: true } | { quitting: false; waiting: number };

export interface QuitCoordinator {
  /** `force` 时不等 */
  request: (force?: boolean) => QuitDecision;
  /** 取消等待；返回之前是不是在等 */
  cancel: () => boolean;
  readonly pending: boolean;
  /** 已经调过 onQuit 了 */
  readonly quitting: boolean;
  /** 停掉计时器（不调任何回调） */
  dispose: () => void;
}

export function createQuitCoordinator(opts: QuitCoordinatorOptions): QuitCoordinator {
  const getBusy = opts.getBusy ?? (() => []);
  const pollMs = opts.pollMs ?? QUIT_POLL_MS;
  const log = opts.log ?? (() => {});
  let timer: NodeJS.Timeout | null = null;
  let pending = false;
  let quitting = false;

  /** 真的还在跑、要等的那些 —— 判不出来就当它在忙（宁可多等一秒，不能打断） */
  const blocking = (): number => {
    try { return getBusy().filter(blocksQuit).length; } catch { return 1; }
  };
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  const setPending = (p: boolean) => {
    if (pending === p) return;
    pending = p;
    try { opts.onPendingChange?.(p); } catch { /* 回调不该挡住退出 */ }
  };
  const quitNow = () => {
    if (quitting) return;
    quitting = true;
    stopTimer();
    // 先让 202 发出去再退
    setImmediate(() => { try { opts.onQuit(); } catch { /* 退出路径不抛 */ } });
  };

  return {
    request(force = false) {
      if (quitting) return { quitting: true };
      const waiting = blocking();
      if (force || waiting === 0) {
        log(`quit ${force ? 'forced' : 'requested, nothing busy'} -> quitting`);
        quitNow();
        return { quitting: true };
      }
      log(`quit requested, ${waiting} session(s) busy -> waiting`);
      setPending(true);
      if (!timer) {
        timer = setInterval(() => {
          if (blocking() > 0) return;
          log('all sessions idle -> quitting');
          quitNow();
        }, pollMs);
        timer.unref?.();
      }
      return { quitting: false, waiting };
    },
    cancel() {
      if (!pending || quitting) return false;
      stopTimer();
      setPending(false);
      log('pending quit cancelled');
      return true;
    },
    get pending() { return pending; },
    get quitting() { return quitting; },
    dispose: stopTimer,
  };
}

/* ───────────────────────── HTTP ───────────────────────── */

export interface ControlServerOptions extends QuitCoordinatorOptions {
  /** 写 `{port, token, pid}` 的地方；默认 `~/.kirolex/control.json` */
  file?: string;
  token?: string;
  pid?: number;
}

export interface ControlServer {
  port: number;
  token: string;
  file: string;
  quit: QuitCoordinator;
  close: () => Promise<void>;
}

/** 常量时间比较，长度不同直接 false */
function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header || '');
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export function createControlServer(opts: ControlServerOptions): Promise<ControlServer> {
  const file = opts.file ?? CONTROL_FILE;
  const token = opts.token ?? crypto.randomBytes(32).toString('hex');
  const pid = opts.pid ?? process.pid;
  const quit = createQuitCoordinator(opts);
  const busyCount = () => { try { return (opts.getBusy?.() ?? []).length; } catch { return 0; } };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    const route = `${req.method} ${u.pathname}`;
    if (route === 'GET /ping') {
      return send(res, 200, { ok: true, pid, busy: busyCount(), ...(quit.pending ? { pendingQuit: true } : null) });
    }
    if (route === 'POST /quit' || route === 'POST /quit/cancel') {
      if (!tokenMatches(req.headers.authorization, token)) return send(res, 401, { ok: false, error: 'unauthorized' });
      if (route === 'POST /quit/cancel') return send(res, 200, { ok: true, cancelled: quit.cancel() });
      const force = ['1', 'true'].includes(u.searchParams.get('force') || '');
      return send(res, 202, quit.request(force));
    }
    send(res, 404, { ok: false, error: 'not found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const port = (server.address() as { port: number }).port;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ port, token, pid }), { mode: 0o600 });
      } catch (err) {
        quit.dispose();
        server.close();
        return reject(err);
      }
      let closed: Promise<void> | null = null;
      const close = () => closed ??= new Promise<void>((done) => {
        quit.dispose();
        removeControlFile(file, pid);
        server.close(() => done());
        server.closeAllConnections?.();
      });
      resolve({ port, token, file, quit, close });
    });
  });
}

/** 只删自己写的那份 —— 另一个实例（比如刚起来的新进程）已经覆盖了的话不动它 */
export function removeControlFile(file: string, pid: number): void {
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cur?.pid !== pid) return;
  } catch { /* 读不出来也照删 */ }
  try { fs.rmSync(file, { force: true }); } catch { /* 删不掉就算了 */ }
}
