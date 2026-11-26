import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { getObjectIfExists, putObject, type S3Creds } from '../src/main/s3Client.ts';
import { serialQueue } from '../src/main/catalogStore.ts';
import { SyncRounds } from '../src/main/syncRound.ts';

/*
 * 审查意见（2026-11-26）：requestOnce 只靠 https.request 的 `timeout`（socket 空闲超时）—— DNS 解析 / 建连挂住时
 * 是否结束取决于 socket 的超时事件会不会来；看门狗只放锁、不取消底层请求，挂在 catalogQueue 里的一项会把后面的都堵住。
 * 现在从请求开始到收到响应头有一个独立的硬截止：到点销毁请求、明确 reject，收到响应头就清掉。
 *
 * 这里用一个**什么事件都不发**的假请求（DNS / 建连永远不返回，socket 的 timeout 也永远不来 —— 最坏的情况），
 * 再用 mock.timers 把时间拨过去。
 */

const creds: S3Creds = { accessKeyId: 'AKIA', secretAccessKey: 's', region: 'us-east-1', bucket: 'b' };

/** 一个永远没有动静的 ClientRequest：不连上、不报错、不发 timeout。 */
function silentRequest() {
  const destroyed: unknown[] = [];
  mock.method(https, 'request', () => {
    const req = new EventEmitter() as any;
    req.write = () => true;
    req.end = () => req;
    req.setTimeout = () => req;
    req.destroy = (err?: unknown) => { destroyed.push(err); return req; };
    return req;
  });
  return destroyed;
}

async function settle<T>(p: Promise<T>): Promise<string> {
  return p.then(() => 'resolved', (e) => `rejected: ${e?.message || e}`);
}

describe('S3 请求的硬截止（DNS / 建连 / 等响应）', () => {
  afterEach(() => { mock.timers.reset(); mock.restoreAll(); });

  test('DNS / 建连永远不返回、socket 超时也不来 → 到点销毁请求并 reject', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const destroyed = silentRequest();
    let state = 'pending';
    const p = settle(getObjectIfExists(creds, 'k')).then((s) => { state = s; return s; });
    mock.timers.tick(60_000);
    await Promise.resolve();
    assert.equal(state, 'pending', '还没到截止');
    mock.timers.tick(61_000);
    const s = await p;
    assert.match(s, /^rejected/);
    assert.equal(destroyed.length, 1, '到点要销毁底层请求');
  });

  /*
   * 审查意见（2026-11-26）：上传的截止原来是固定总时长（120s + 大小 / 32 KB/s）—— 8 MB 以 16 KB/s 持续在传，
   * 第 376 秒还是被掐断、下一轮从头传。现在截止按「没有进展」算：每块真的写出去就续期，写完之后再限等响应的时间。
   */
  /** 慢慢往外写的假请求：每 `everyMs` 才有一块真的写出去（write 回调），能手动回响应。 */
  function slowRequest(everyMs: number, stallAfter = Infinity) {
    const st = { written: 0, ended: false, destroyed: [] as unknown[], respond: (_status: number) => {} };
    mock.method(https, 'request', (_opts: any, onRes: any) => {
      const req = new EventEmitter() as any;
      const pending: Array<() => void> = [];
      const next = () => setTimeout(() => {
        if (st.written >= stallAfter) return;   // 停住：再也写不出去
        const cb = pending.shift();
        if (!cb) return;
        st.written += 1;
        cb();
        if (pending.length) next();
      }, everyMs);
      req.write = (_chunk: Buffer, cb?: () => void) => { pending.push(cb || (() => {})); if (pending.length === 1) next(); return true; };
      req.end = () => { st.ended = true; return req; };
      req.setTimeout = () => req;
      req.destroy = (err?: unknown) => { st.destroyed.push(err); pending.length = 0; return req; };
      st.respond = (status: number) => {
        const res = new EventEmitter() as any;
        res.statusCode = status; res.headers = {}; res.complete = true;
        onRes(res);
        res.emit('end');
        res.emit('close');
      };
      return req;
    });
    return st;
  }

  test('上传一直有进展（16 KB/s）、总时长跨过原来的固定截止（376 秒）也不被掐断，传完后照常拿到响应', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const st = slowRequest(4_000);   // 64 KB / 4 s = 16 KB/s
    const size = 8 * 1024 * 1024;    // 128 块 → 512 秒
    let state = 'pending';
    const p = settle(putObject(creds, 'k', Buffer.alloc(size))).then((s) => { state = s; return s; });
    for (let t = 0; t < 400_000; t += 4_000) mock.timers.tick(4_000);
    await Promise.resolve();
    assert.equal(state, 'pending', '持续在传的上传在原来的固定截止被掐断了');
    assert.equal(st.destroyed.length, 0);
    for (let t = 400_000; t < 512_000; t += 4_000) mock.timers.tick(4_000);
    assert.equal(st.written, 128, '全部写出去了');
    st.respond(200);
    assert.equal(await p, 'resolved');
  });

  test('上传中途停住（写不出去）→ 从最后一次进展起 120 秒到点掐断', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const st = slowRequest(4_000, 10);
    let state = 'pending';
    const p = settle(putObject(creds, 'k', Buffer.alloc(8 * 1024 * 1024))).then((s) => { state = s; return s; });
    for (let t = 0; t < 40_000; t += 4_000) mock.timers.tick(4_000);   // 写出去 10 块，最后一块在第 40 秒
    assert.equal(st.written, 10);
    mock.timers.tick(119_000);
    await Promise.resolve();
    assert.equal(state, 'pending', '停住还不到 120 秒');
    mock.timers.tick(2_000);
    assert.match(await p, /^rejected/);
    assert.equal(st.destroyed.length, 1);
  });

  test('写完了、服务器一直不回响应 → 最后一块写出去之后 120 秒到点掐断', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const st = slowRequest(1_000);
    let state = 'pending';
    const p = settle(putObject(creds, 'k', Buffer.alloc(4 * 64 * 1024))).then((s) => { state = s; return s; });
    for (let i = 0; i < 4; i++) mock.timers.tick(1_000);
    assert.equal(st.written, 4);
    mock.timers.tick(119_000);
    await Promise.resolve();
    assert.equal(state, 'pending', '还没到等响应的截止');
    mock.timers.tick(2_000);
    assert.match(await p, /^rejected/);
    assert.equal(st.destroyed.length, 1);
  });

  test('catalogQueue 前面一项的请求挂住 → 到点 reject，后面一项照常跑', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    silentRequest();
    const q = serialQueue();
    const first = settle(q(() => getObjectIfExists(creds, 'catalog.json')));
    let ran = false;
    const second = q(async () => { ran = true; return 'next'; });
    await Promise.resolve();
    assert.equal(ran, false, '前一项还在跑时后一项不该开始');
    mock.timers.tick(121_000);
    assert.match(await first, /^rejected/);
    assert.equal(await second, 'next');
    assert.equal(ran, true);
  });
});

describe('组合：真的 putObject + 真的 SyncRounds（15 分钟上限），慢网持续上传约 17 分钟', () => {
  afterEach(() => { mock.timers.reset(); mock.restoreAll(); });

  test('64 MB 以 64 KB/s 一直在传 → 跨过请求截止和看门狗上限，这一轮跑完、照常写 state', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    let written = 0;
    let respond: () => void = () => {};
    mock.method(https, 'request', (_opts: any, onRes: any) => {
      const req = new EventEmitter() as any;
      const pending: Array<() => void> = [];
      const next = () => setTimeout(() => { const cb = pending.shift(); if (!cb) return; written += 1; cb(); if (pending.length) next(); }, 1_000);
      req.write = (_c: Buffer, cb?: () => void) => { pending.push(cb || (() => {})); if (pending.length === 1) next(); return true; };
      req.end = () => req;
      req.setTimeout = () => req;
      req.destroy = () => { pending.length = 0; return req; };
      respond = () => { const res = new EventEmitter() as any; res.statusCode = 200; res.headers = {}; res.complete = true; onRes(res); res.emit('end'); res.emit('close'); };
      return req;
    });
    const lock = { value: false, get held() { return this.value; }, set held(v: boolean) { this.value = v; } };
    const logs: string[] = [];
    const rounds = new SyncRounds({ limitMs: 15 * 60_000, log: (_l, m) => logs.push(m) });
    const wrote: string[] = [];
    const run = rounds.run(lock, '定时', async (round) => {
      const c: S3Creds = { ...creds, live: () => round.check(), progress: () => round.progress() };
      round.stage('上传 sessions/s1/files/big.bin');
      round.check();
      await putObject(c, 'k', Buffer.alloc(64 * 1024 * 1024));
      round.check();
      wrote.push('state');
      return 'ok';
    }, () => 'abandoned');
    for (let i = 0; i < 1024; i++) mock.timers.tick(1_000);   // 1024 块 × 1 秒 ≈ 17 分钟
    assert.equal(written, 1024);
    assert.deepEqual(logs, [], `正常在传被看门狗放弃了：${logs.join(' | ')}`);
    respond();
    assert.equal(await run, 'ok');
    assert.deepEqual(wrote, ['state']);
    assert.equal(lock.value, false);
  });
});
