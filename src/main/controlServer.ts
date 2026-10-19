/**
 * **本机控制入口** —— 给 agent-board 的「拉取并重启」用：让外部工具请 KiroLex 走正常流程退出。
 *
 * 只听 127.0.0.1 的一个随机端口；端口、token、pid 写在 `~/.kirolex/control.json`，退出时删掉。
 *
 * - `GET /ping`  → 200 `{"ok":true,"pid":…,"busy":<忙的会话数>}`，等待退出期间再加 `"pendingQuit":true`，
 *   等待刷新期间加 `"pendingReload":true`。不要 token。
 * - `POST /quit` → 要 `Authorization: Bearer <token>`，否则 401。
 *   - 没有会话在跑 → 202 `{"quitting":true}`，然后调 `onQuit`。
 *   - 有 → 202 `{"quitting":false,"waiting":<数量>}`，进入「等待退出」：`onPendingChange(true)` 让 index.ts
 *     停掉排队消息和定时 / 循环任务的新一轮，每秒查一次，全部空下来再调 `onQuit`。
 *   - `?force=1` → 不等，直接 `onQuit`（备用）。
 * - `POST /reload` → 要 token。**只重新加载窗口**（更新只改了界面时用），规则和 `/quit` 一样：
 *   - 没有会话在跑 → 200 `{"ok":true}`，然后调 `onReload`。
 *   - 有 → 202 `{"reloading":false,"waiting":<数量>}`，进入「等待刷新」（同一套等待：停掉新一轮），
 *     全部空下来先 `onPendingChange(false)` 恢复，再调 `onReload`。
 *   - `?force=1` → 不等，也是 200 `{"ok":true}`。
 *   - 已经在等退出 → 照样回等待（反正要退了）；在等刷新时来了 `/quit` → 改成等退出。
 *   - 没传 `onReload` → 501。
 *   会话、kiro-cli 进程都在主进程里，刷新不碰它们；界面状态靠 ui-state.json 恢复。
 * - `POST /quit/cancel` → 要 token。取消等待（退出或刷新都算），`onPendingChange(false)` 恢复排队和定时任务。
 * - **读会话 / 发消息**（`controlSessions.ts`，全部要 token；设置里的开关关着时一律 403 `{error:'disabled'}`）：
 *   - `GET /sessions[?q=]` → 会话列表（不含消息内容）；
 *   - `GET /sessions/:id/tail?n=10` → 最近 n 条（≤50），正文截到 8000 字，工具调用只给一行标题；
 *   - `GET /sessions/:id/status` → `{busy, turnStartedAt, queued, lastMessageAt}`；
 *   - `POST /sessions/:id/send` `{text, mode?:'auto'|'next'}` → 交给界面按 Enter 的同一套路由发
 *     （`{accepted:true, messageId, routed:'sent'|'steer'|'queued'}`）；界面没就绪 503 `{error:'ui-not-ready'}`。
 *   - `POST /sessions/:id/new-backend` → 换新的后端会话（和 EmptyResponse / 「写成文字」反复发作同一套，上下文带过去），
 *     `{ok:true, backendSessionId}`；这一轮还在跑 409 `{error:'busy'}`，换不了 502 `{error:'swap-failed'}`。
 *   会话不存在 / KiroLex Advanced 的会话 → 404。日志只记路由、会话 id、字数，不记正文、不记 token。
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
import {
  checkSendBody, filterByTitle, parseTailCount,
  type ControlRouted, type ControlSendMode, type ControlSessionSummary, type ControlTailEntry,
} from './controlSessions.ts';

export const CONTROL_FILE = path.join(os.homedir(), '.kirolex', 'control.json');
export const QUIT_POLL_MS = 1000;

/* ───────────────────────── 等待退出 / 刷新 ───────────────────────── */

export interface QuitCoordinatorOptions {
  onQuit: () => void;
  /** `POST /reload`：让所有窗口重新加载界面（index.ts 里是 `webContents.reloadIgnoringCache()`） */
  onReload?: () => void;
  /** 现在忙的会话；默认谁都不忙 */
  getBusy?: () => BusySession[];
  /** 进入 / 离开「等待」—— index.ts 据此暂停 / 恢复排队和定时任务 */
  onPendingChange?: (pending: boolean) => void;
  pollMs?: number;
  log?: (msg: string) => void;
}

export type QuitDecision = { quitting: true } | { quitting: false; waiting: number };
export type ReloadDecision = { reloading: true } | { reloading: false; waiting: number };
export type PendingAction = 'quit' | 'reload';

export interface QuitCoordinator {
  /** `force` 时不等 */
  request: (force?: boolean) => QuitDecision;
  /** 等所有会话空下来再刷新窗口；`force` 时不等 */
  requestReload: (force?: boolean) => ReloadDecision;
  /** 取消等待（退出或刷新）；返回之前是不是在等 */
  cancel: () => boolean;
  /** 在等（退出或刷新） */
  readonly pending: boolean;
  /** 在等的是哪一个 */
  readonly pendingAction: PendingAction | null;
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
  let action: PendingAction | null = null;
  let quitting = false;

  /** 真的还在跑、要等的那些 —— 判不出来就当它在忙（宁可多等一秒，不能打断） */
  const blocking = (): number => {
    try { return getBusy().filter(blocksQuit).length; } catch { return 1; }
  };
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  const setAction = (next: PendingAction | null) => {
    const was = action !== null;
    action = next;
    if (was === (next !== null)) return;
    try { opts.onPendingChange?.(next !== null); } catch { /* 回调不该挡住退出 */ }
  };
  const quitNow = () => {
    if (quitting) return;
    quitting = true;
    stopTimer();
    // 先让 202 发出去再退
    setImmediate(() => { try { opts.onQuit(); } catch { /* 退出路径不抛 */ } });
  };
  /** 刷新完就回到平常：先恢复排队和定时任务（新界面起来时读到的是「没在等」），再刷新 */
  const reloadNow = () => {
    stopTimer();
    setAction(null);
    setImmediate(() => { try { opts.onReload?.(); } catch (err: any) { log(`reload failed: ${err?.message || err}`); } });
  };
  const startWaiting = (next: PendingAction) => {
    setAction(next);
    if (timer) return;
    timer = setInterval(() => {
      if (blocking() > 0) return;
      log(`all sessions idle -> ${action}`);
      if (action === 'quit') quitNow(); else reloadNow();
    }, pollMs);
    timer.unref?.();
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
      startWaiting('quit');   // 在等刷新的话改成等退出
      return { quitting: false, waiting };
    },
    requestReload(force = false) {
      const waiting = blocking();
      if (quitting) return { reloading: false, waiting };
      if (action === 'quit') {
        log('reload requested while waiting to quit -> keep waiting to quit');
        return { reloading: false, waiting: Math.max(waiting, 1) };
      }
      if (force || waiting === 0) {
        log(`reload ${force ? 'forced' : 'requested, nothing busy'} -> reloading`);
        reloadNow();
        return { reloading: true };
      }
      log(`reload requested, ${waiting} session(s) busy -> waiting`);
      startWaiting('reload');
      return { reloading: false, waiting };
    },
    cancel() {
      if (action === null || quitting) return false;
      const was = action;
      stopTimer();
      setAction(null);
      log(`pending ${was} cancelled`);
      return true;
    },
    get pending() { return action !== null; },
    get pendingAction() { return action; },
    get quitting() { return quitting; },
    dispose: stopTimer,
  };
}

/* ───────────────────────── HTTP ───────────────────────── */

export interface ControlSessionStatus {
  busy: boolean;
  turnStartedAt: number | null;
  queued: number;
  lastMessageAt: number | null;
}

export type ControlSendResult =
  | { ok: true; messageId: string; routed: ControlRouted; steerFailed?: string }
  | { ok: false; status: number; error: string };

/** `/sessions…` 那几条路由的数据来源，index.ts 注入。会话不存在 / 不许碰（advanced 的）一律当不存在。 */
export interface ControlSessionAccess {
  /** 设置里的开关（默认关）。每次请求都现读 */
  enabled: () => boolean;
  list: () => ControlSessionSummary[];
  exists: (id: string) => boolean;
  tail: (id: string, n: number) => ControlTailEntry[];
  status: (id: string) => ControlSessionStatus;
  /** 交给界面按 Enter 的同一套路由发；界面没就绪就 `{ok:false, status:503, error:'ui-not-ready'}` */
  send: (id: string, text: string, mode: ControlSendMode) => Promise<ControlSendResult>;
  /** 换新的后端会话；不传 = 501 */
  newBackend?: (id: string) => Promise<ControlNewBackendResult>;
}

export type ControlNewBackendResult =
  | { ok: true; backendSessionId: string }
  | { ok: false; status: number; error: string };

export interface ControlServerOptions extends QuitCoordinatorOptions {
  /** 写 `{port, token, pid}` 的地方；默认 `~/.kirolex/control.json` */
  file?: string;
  token?: string;
  pid?: number;
  /** 不传 = 没有 `/sessions…` 路由（404） */
  sessions?: ControlSessionAccess;
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

/** 请求体上限：20000 字的 UTF-8 加上 JSON 转义也远小于它 */
const MAX_BODY_BYTES = 256 * 1024;

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { done = true; resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}

/** 和 sessionStore.safeId 同一个形状；别的一律当不存在 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const SESSION_ROUTE_RE = /^\/sessions\/([^/]+)\/(tail|status|send|new-backend)$/;

/**
 * `/sessions…`：已过 token。返回 false = 不是这几条路由。
 * 日志只记「路由 + 会话 id + 字数 + 结果」—— 不记正文，不记 token。
 */
async function handleSessions(
  req: http.IncomingMessage, res: http.ServerResponse, u: URL,
  access: ControlSessionAccess, log: (msg: string) => void,
): Promise<boolean> {
  const method = req.method || 'GET';
  const isList = u.pathname === '/sessions';
  const m = SESSION_ROUTE_RE.exec(u.pathname);
  if (!isList && !m) return false;
  const action = isList ? 'list' : m![2];
  const wantMethod = action === 'send' || action === 'new-backend' ? 'POST' : 'GET';
  if (method !== wantMethod) return false;
  let enabled = false;
  try { enabled = access.enabled(); } catch { enabled = false; }
  if (!enabled) { send(res, 403, { ok: false, error: 'disabled' }); return true; }
  if (isList) {
    const list = filterByTitle(access.list(), u.searchParams.get('q'));
    log(`GET /sessions -> ${list.length}`);
    send(res, 200, list);
    return true;
  }
  let id = '';
  try { id = decodeURIComponent(m![1]); } catch { id = ''; }
  if (!SESSION_ID_RE.test(id) || !access.exists(id)) {
    log(`${method} /sessions/:id/${action} session=${SESSION_ID_RE.test(id) ? id : '<invalid>'} -> 404`);
    send(res, 404, { ok: false, error: 'not-found' });
    return true;
  }
  if (action === 'tail') {
    const n = parseTailCount(u.searchParams.get('n'));
    log(`GET /sessions/:id/tail session=${id} n=${n}`);
    send(res, 200, access.tail(id, n));
    return true;
  }
  if (action === 'status') {
    send(res, 200, access.status(id));
    return true;
  }
  if (action === 'new-backend') {
    if (!access.newBackend) { send(res, 501, { ok: false, error: 'not-supported' }); return true; }
    let r: ControlNewBackendResult;
    try { r = await access.newBackend(id); } catch { r = { ok: false, status: 500, error: 'swap-failed' }; }
    log(`POST /sessions/:id/new-backend session=${id} -> ${r.ok ? 'ok' : `${r.status} ${r.error}`}`);
    if (!r.ok) send(res, r.status, { ok: false, error: r.error });
    else send(res, 200, { ok: true, backendSessionId: r.backendSessionId });
    return true;
  }
  const raw = await readBody(req);
  if (raw === null) {
    log(`POST /sessions/:id/send session=${id} -> 413`);
    send(res, 413, { ok: false, error: 'too-large' });
    return true;
  }
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { body = null; }
  const checked = checkSendBody(body);
  if (!checked.ok) {
    log(`POST /sessions/:id/send session=${id} -> 400 ${checked.error}`);
    send(res, 400, { ok: false, error: checked.error });
    return true;
  }
  let result: ControlSendResult;
  try { result = await access.send(id, checked.text, checked.mode); } catch { result = { ok: false, status: 500, error: 'send-failed' }; }
  const chars = checked.text.length;
  if (!result.ok) {
    log(`POST /sessions/:id/send session=${id} chars=${chars} mode=${checked.mode} -> ${result.status} ${result.error}`);
    send(res, result.status, { ok: false, error: result.error });
    return true;
  }
  log(`POST /sessions/:id/send session=${id} chars=${chars} mode=${checked.mode} -> ${result.routed}${result.steerFailed ? ` (steer failed: ${result.steerFailed})` : ''}`);
  send(res, 200, {
    accepted: true, messageId: result.messageId, routed: result.routed,
    ...(result.steerFailed ? { steerFailed: result.steerFailed } : null),
  });
  return true;
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
      const pend = quit.pendingAction;
      return send(res, 200, {
        ok: true, pid, busy: busyCount(),
        ...(pend === 'quit' ? { pendingQuit: true } : null),
        ...(pend === 'reload' ? { pendingReload: true } : null),
      });
    }
    if (route === 'POST /quit' || route === 'POST /quit/cancel') {
      if (!tokenMatches(req.headers.authorization, token)) return send(res, 401, { ok: false, error: 'unauthorized' });
      if (route === 'POST /quit/cancel') return send(res, 200, { ok: true, cancelled: quit.cancel() });
      const force = ['1', 'true'].includes(u.searchParams.get('force') || '');
      return send(res, 202, quit.request(force));
    }
    if (route === 'POST /reload') {
      if (!tokenMatches(req.headers.authorization, token)) return send(res, 401, { ok: false, error: 'unauthorized' });
      if (!opts.onReload) return send(res, 501, { ok: false, error: 'reload not supported' });
      const force = ['1', 'true'].includes(u.searchParams.get('force') || '');
      const decision = quit.requestReload(force);
      // 立即刷新 → 200 {ok:true}；要等 → 202 {reloading:false, waiting}
      return decision.reloading ? send(res, 200, { ok: true }) : send(res, 202, decision);
    }
    if (opts.sessions && (u.pathname === '/sessions' || u.pathname.startsWith('/sessions/'))) {
      if (!tokenMatches(req.headers.authorization, token)) return send(res, 401, { ok: false, error: 'unauthorized' });
      void handleSessions(req, res, u, opts.sessions, opts.log ?? (() => {})).then((handled) => {
        if (!handled) send(res, 404, { ok: false, error: 'not found' });
      }).catch(() => { if (!res.headersSent) send(res, 500, { ok: false, error: 'internal' }); });
      return;
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
