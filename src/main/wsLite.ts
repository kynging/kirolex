/**
 * **最小的 WebSocket 客户端**（RFC 6455）—— 给 `localBrowser.ts` 连浏览器的调试端口用。
 *
 * 为什么自己写：Electron 31 带的 Node 20 没有全局 `WebSocket`，而为了连两个 127.0.0.1 上的端点
 * 去加一个依赖（或者像 CDE 那次一样往用户机器上装 `ws`）不划算。只做这条路要的那几件事：
 * 握手、文本帧、分片、ping/pong、close；只连 `ws://`（浏览器调试端点都只在 loopback 上）。
 *
 * 帧编解码单独导出（`encodeFrame` / `FrameParser`），测试里的假服务端也用它们。
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import http from 'http';
import type { Socket } from 'net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 一条消息的上限：整页截图的 base64 能到几 MB，留足但不能无限。 */
export const WS_MAX_MESSAGE = 64 * 1024 * 1024;

export function acceptKey(key: string): string {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** 编一帧。客户端发出的帧必须带掩码，服务端发的不带。 */
export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length;
  const head: number[] = [0x80 | (opcode & 0x0f)];
  const maskBit = mask ? 0x80 : 0;
  if (len < 126) head.push(maskBit | len);
  else if (len < 65536) head.push(maskBit | 126, (len >> 8) & 0xff, len & 0xff);
  else {
    head.push(maskBit | 127);
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(BigInt(len));
    head.push(...big);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = crypto.randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) body[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([Buffer.from(head), key, body]);
}

export interface WsFrame { fin: boolean; opcode: number; payload: Buffer }

/** 按字节流拆帧（两个方向都能用：有掩码就解掉）。 */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): WsFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: WsFrame[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(WS_MAX_MESSAGE)) throw new Error('websocket frame too large');
        len = Number(big);
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) break;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const key = this.buf.subarray(off, off + 4);
        const plain = Buffer.alloc(len);
        for (let i = 0; i < len; i += 1) plain[i] = payload[i] ^ key[i & 3];
        payload = plain;
      } else {
        payload = Buffer.from(payload);
      }
      out.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
      this.buf = this.buf.subarray(need);
    }
    return out;
  }
}

/**
 * 一条已经握手成功的连接。事件：`message`（完整的文本消息）、`close`。
 */
export class WsConnection extends EventEmitter {
  private socket: Socket;
  private parser = new FrameParser();
  private parts: Buffer[] = [];
  private partsLen = 0;
  private closed = false;

  constructor(socket: Socket, head?: Buffer) {
    super();
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    if (head && head.length) this.onData(head);
  }

  get isOpen(): boolean { return !this.closed; }

  private onData(d: Buffer): void {
    let frames: WsFrame[];
    try { frames = this.parser.push(d); } catch { this.close(); return; }
    for (const f of frames) {
      if (f.opcode === 0x8) { this.close(); return; }
      if (f.opcode === 0x9) { this.write(0xA, f.payload); continue; }
      if (f.opcode === 0xA) continue;
      if (f.opcode === 0x1 || f.opcode === 0x2 || f.opcode === 0x0) {
        this.parts.push(f.payload);
        this.partsLen += f.payload.length;
        if (this.partsLen > WS_MAX_MESSAGE) { this.close(); return; }
        if (f.fin) {
          const msg = Buffer.concat(this.parts).toString('utf8');
          this.parts = [];
          this.partsLen = 0;
          this.emit('message', msg);
        }
      }
    }
  }

  private write(opcode: number, payload: Buffer): void {
    if (this.closed) return;
    try { this.socket.write(encodeFrame(opcode, payload, true)); } catch { this.finish(); }
  }

  send(text: string): void {
    if (this.closed) throw new Error('websocket is closed');
    this.write(0x1, Buffer.from(text, 'utf8'));
  }

  close(): void {
    if (this.closed) return;
    this.write(0x8, Buffer.alloc(0));
    try { this.socket.end(); } catch { /* 已经断了 */ }
    setTimeout(() => { try { this.socket.destroy(); } catch {} }, 1000).unref?.();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

/**
 * 连一个 `ws://127.0.0.1:<port>/<path>`。
 *
 * **握手可能挂很久** —— Chrome / Edge 用 `chrome://inspect` 开的远程调试，每来一个外部连接就弹
 * "允许吗"，用户点之前握手不回。所以超时由调用方给（`timeoutMs`），而不是在这里拍一个短的。
 */
export function connectWs(url: string, timeoutMs: number): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { reject(new Error(`bad websocket url: ${url}`)); return; }
    if (u.protocol !== 'ws:') { reject(new Error(`only ws:// is supported: ${url}`)); return; }
    const key = crypto.randomBytes(16).toString('base64');
    /* 不带 Origin：Chrome 111+ 会拒掉带了不在白名单里的 Origin 的连接，不带才放行 */
    const req = http.request({
      host: u.hostname,
      port: Number(u.port) || 80,
      path: `${u.pathname}${u.search}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(Object.assign(new Error(`websocket handshake timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    req.on('upgrade', (res, socket, head) => {
      if (settled) { socket.destroy(); return; }
      settled = true;
      clearTimeout(timer);
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        reject(new Error('websocket handshake: bad accept key'));
        return;
      }
      resolve(new WsConnection(socket as Socket, head));
    });
    req.on('response', (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.resume();
      reject(Object.assign(new Error(`websocket handshake rejected: HTTP ${res.statusCode}`), { code: 'EHANDSHAKE', status: res.statusCode }));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}
