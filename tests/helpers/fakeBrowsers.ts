/**
 * 假的 CDP / BiDi 服务端 —— `tests/localBrowser.test.ts` 用来做集成测试（真 WebSocket、真 JSON-RPC）。
 *
 * 只实现 `localBrowser.ts` 会发的那些方法；页面里的表达式按 `PAGE_EXPR` 的常量认。
 * 每个页面都带一个 cookie / localStorage 值，测试断言它们**不会**出现在任何返回结果里。
 */

import http from 'http';
import type { Socket } from 'net';
import { acceptKey, encodeFrame, FrameParser } from '../../src/main/wsLite.ts';
import { PAGE_EXPR } from '../../src/main/localBrowser.ts';

export const SECRET_COOKIE = 'SESSIONID=super-secret-cookie-value';
export const SECRET_STORAGE = 'localStorage-token-abc123';

export interface FakePage { id: string; url: string; title: string; text: string; html: string; ready: 'loading' | 'complete' }

/** 一个页面的内容：文字里只有正文；html 里故意塞了 script / hidden 字段（应被去掉）。 */
export function pageFor(id: string, url: string, title = `Title of ${url}`, text = `Body of ${url}`): FakePage {
  return {
    id, url, title, text, ready: 'complete',
    html: `<html><head><title>${title}</title><script>window.__cfg={cookie:"${SECRET_COOKIE}",ls:"${SECRET_STORAGE}"}</script></head>`
      + `<body><p>${text}</p><input type="hidden" name="csrf" value="${SECRET_STORAGE}"><input type="password" value="hunter2"></body></html>`,
  };
}

interface Conn { socket: Socket; send(obj: any): void }

abstract class FakeWsServer {
  server: http.Server;
  port = 0;
  /** 握手次数（= 建了几条连接）。 */
  handshakes = 0;
  /** 收到的所有方法名（断言白名单 / 单例用）。 */
  methods: string[] = [];
  /** 握手前故意等多久（模拟浏览器在弹"允许"）。 */
  holdMs = 0;
  /** 收到某个方法时先调它（测试用来"在这一步的途中"做事，例如关掉总开关）。 */
  onMethod?: (method: string, params: any) => void;
  /** 直接拒绝握手（模拟没开调试 / 用户拒绝）。 */
  refuse = false;
  pages = new Map<string, FakePage>();
  /** 打开某个网址时服务端让它跳到哪儿（模拟重定向 / SSO 跳转）。 */
  redirects = new Map<string, string>();
  /** 模拟页面自己导航走（链接 / 脚本）。 */
  navigateTab(id: string, url: string): void { this.pages.set(id, pageFor(id, url)); }
  conns: Conn[] = [];
  private seq = 0;

  private wsPath: RegExp;

  constructor(wsPath: RegExp) {
    this.wsPath = wsPath;
    this.server = http.createServer((_req, res) => { res.writeHead(404).end(); });
    this.server.on('upgrade', (req, socket: Socket, head) => {
      if (this.refuse || !this.wsPath.test(req.url || '')) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const finish = () => {
        this.handshakes += 1;
        const key = String(req.headers['sec-websocket-key'] || '');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
          + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
        const parser = new FrameParser();
        const conn: Conn = {
          socket,
          send: (obj) => { try { socket.write(encodeFrame(1, Buffer.from(JSON.stringify(obj)), false)); } catch {} },
        };
        this.conns.push(conn);
        const onData = (d: Buffer) => {
          for (const f of parser.push(d)) {
            if (f.opcode === 8) { socket.end(); return; }
            if (f.opcode !== 1) continue;
            const msg = JSON.parse(f.payload.toString('utf8'));
            this.methods.push(msg.method);
            this.onMethod?.(msg.method, msg.params);
            this.handle(conn, msg);
          }
        };
        socket.on('data', onData);
        socket.on('close', () => { this.conns = this.conns.filter((c) => c !== conn); this.onClose(conn); });
        socket.on('error', () => {});
        if (head?.length) onData(head);
      };
      if (this.holdMs) setTimeout(finish, this.holdMs); else finish();
    });
  }

  nextId(prefix: string): string { this.seq += 1; return `${prefix}${this.seq}`; }

  listen(): Promise<number> {
    return new Promise((r) => this.server.listen(0, '127.0.0.1', () => {
      const a = this.server.address();
      this.port = typeof a === 'object' && a ? a.port : 0;
      r(this.port);
    }));
  }

  /** 模拟浏览器那头断开（浏览器重启 / 调试被关掉）。 */
  dropAll(): void { for (const c of this.conns) c.socket.destroy(); }

  close(): Promise<void> {
    this.dropAll();
    return new Promise((r) => this.server.close(() => r()));
  }

  evalExpr(page: FakePage | undefined, expression: string): string {
    if (!page) throw new Error('no such page');
    if (expression === PAGE_EXPR.state) return JSON.stringify({ ready: page.ready, url: page.url, title: page.title, len: page.text.length });
    if (expression === PAGE_EXPR.text) return JSON.stringify({ url: page.url, title: page.title, body: page.text });
    if (expression === PAGE_EXPR.html) return JSON.stringify({ url: page.url, title: page.title, body: page.html });
    throw new Error(`unexpected expression: ${expression}`);
  }

  protected abstract handle(conn: Conn, msg: any): void;
  protected onClose(_conn: Conn): void {}
}

/** 浏览器级 CDP 端点：`/devtools/browser/<id>`。 */
export class FakeCdp extends FakeWsServer {
  browserPath = '/devtools/browser/0d3b4c7e-aaaa-bbbb-cccc-1234567890ab';
  sessions = new Map<string, string>();   // CDP sessionId -> targetId

  constructor() {
    super(/^\/devtools\/browser\/[\w-]+$/);
    /* 用户自己已经开着的一个标签（不许被读 / 关） */
    this.pages.set('USER1', pageFor('USER1', 'https://mail.example.com/inbox', 'User inbox', 'private mail'));
  }

  devToolsActivePort(): string { return `${this.port}\n${this.browserPath}\n`; }

  protected handle(conn: Conn, msg: any): void {
    const ok = (result: any) => conn.send({ id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : null) });
    const err = (message: string) => conn.send({ id: msg.id, error: { code: -32000, message } });
    const p = msg.params || {};
    switch (msg.method) {
      case 'Target.getTargets':
        return ok({ targetInfos: [...this.pages.values()].map((pg) => ({ targetId: pg.id, type: 'page', title: pg.title, url: pg.url, attached: false })) });
      case 'Target.createTarget': {
        const id = this.nextId('T');
        this.pages.set(id, pageFor(id, this.redirects.get(p.url) || p.url));
        return ok({ targetId: id });
      }
      case 'Target.attachToTarget': {
        if (!this.pages.has(p.targetId)) return err('No target with given id found');
        const sid = this.nextId('S');
        this.sessions.set(sid, p.targetId);
        return ok({ sessionId: sid });
      }
      case 'Target.detachFromTarget':
        this.sessions.delete(p.sessionId);
        return ok({});
      case 'Target.closeTarget':
        this.pages.delete(p.targetId);
        return ok({ success: true });
      case 'Runtime.evaluate': {
        const page = this.pages.get(this.sessions.get(msg.sessionId) || '');
        try { return ok({ result: { type: 'string', value: this.evalExpr(page, p.expression) } }); } catch (e: any) { return err(e.message); }
      }
      case 'Page.captureScreenshot':
        return ok({ data: Buffer.from('PNGDATA-cdp').toString('base64') });
      default:
        return err(`'${msg.method}' wasn't found`);
    }
  }
}

/** Firefox 的 BiDi 端点：`/session`；同时只允许一个 session（和真 Firefox 一样）。 */
export class FakeBidi extends FakeWsServer {
  activeSession: string | null = null;
  sessionNews = 0;
  sessionEnds = 0;
  /** 真 Firefox：连接断了，那条连接上建的 session 也就没了。 */
  endOnDisconnect = true;
  private sessionConn: Conn | null = null;

  constructor() {
    super(/^\/session$/);
    this.pages.set('USERCTX', pageFor('USERCTX', 'https://bank.example.com/', 'User bank', 'balance'));
  }

  protected onClose(conn: Conn): void {
    if (this.endOnDisconnect && conn === this.sessionConn) { this.activeSession = null; this.sessionConn = null; }
  }

  protected handle(conn: Conn, msg: any): void {
    const ok = (result: any) => conn.send({ type: 'success', id: msg.id, result });
    const err = (error: string, message: string) => conn.send({ type: 'error', id: msg.id, error, message });
    const p = msg.params || {};
    if (msg.method !== 'session.new' && !this.activeSession) return err('invalid session id', 'no active session');
    switch (msg.method) {
      case 'session.new':
        if (this.activeSession) return err('session not created', 'Maximum number of active sessions');
        this.sessionNews += 1;
        this.activeSession = this.nextId('BIDI');
        this.sessionConn = conn;
        return ok({ sessionId: this.activeSession, capabilities: {} });
      case 'session.end':
        this.sessionEnds += 1;
        this.activeSession = null;
        this.sessionConn = null;
        return ok({});
      case 'browsingContext.getTree':
        return ok({ contexts: [...this.pages.values()].map((pg) => ({ context: pg.id, url: pg.url, children: [], parent: null })) });
      case 'browsingContext.create': {
        const id = this.nextId('CTX');
        this.pages.set(id, { ...pageFor(id, 'about:blank'), ready: 'complete' });
        return ok({ context: id });
      }
      case 'browsingContext.navigate': {
        const pg = this.pages.get(p.context);
        if (!pg) return err('no such frame', p.context);
        this.pages.set(p.context, pageFor(p.context, this.redirects.get(p.url) || p.url));
        return ok({ navigation: null, url: p.url });
      }
      case 'script.evaluate': {
        try { return ok({ type: 'success', result: { type: 'string', value: this.evalExpr(this.pages.get(p.target?.context), p.expression) }, realm: 'r' }); } catch (e: any) { return err('javascript error', e.message); }
      }
      case 'browsingContext.captureScreenshot':
        return ok({ data: Buffer.from('PNGDATA-bidi').toString('base64') });
      case 'browsingContext.close':
        this.pages.delete(p.context);
        return ok({});
      default:
        return err('unknown command', msg.method);
    }
  }
}
