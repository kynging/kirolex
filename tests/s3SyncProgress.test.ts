import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { putObject, getObject, type S3Creds } from '../src/main/s3Client.ts';
import { SyncRounds } from '../src/main/syncRound.ts';
import type { RunLock } from '../src/main/awsProfileCreds.ts';

/*
 * 审查意见（2026-11-26）：上传前 round.stage() 之后，`await putObject()` 期间看门狗收不到任何进展 ——
 * 慢网下一个大文件正常地传超过上限（例：64 MB / 64 KB/s ≈ 17 分钟 > 15 分钟）就被放弃，传完也被 checkLive 拒掉，
 * 不写 state，下一轮再从头传，永远传不完。
 * 现在 S3 请求在真有数据流动时调 `creds.progress`（上传分块交给系统后、下载每收到一块），这一轮的凭证把它接到
 * `round.progress()`：有进展就重新计时；停住不动的照样到点放弃、放锁。
 *
 * 组合测试：真的 s3Client + 真的 SyncRounds，看门狗上限压到 150ms，假 S3 限速收上传 —— 整个上传远超上限。
 */

const base: S3Creds = { accessKeyId: 'AKIA', secretAccessKey: 's', region: 'us-east-1', bucket: 'b' };

function makeLock(): RunLock & { value: boolean } {
  const l = { value: false, get held() { return l.value; }, set held(v: boolean) { l.value = v; } };
  return l;
}

let server: http.Server | null = null;
let timers: Array<ReturnType<typeof setInterval>> = [];
afterEach(() => {
  for (const t of timers) clearInterval(t);
  timers = [];
  mock.restoreAll(); server?.closeAllConnections(); server?.close(); server = null;
});

/** 假 S3：上传按 `bytesPerTick` / 10ms 限速读（stallAfter 之后再也不读）；GET 回 `download` 字节，同样限速发。 */
async function slowS3(opts: { bytesPerTick: number; stallAfter?: number; download?: number }) {
  const got = { bytes: 0, done: false };
  server = await new Promise<http.Server>((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.method === 'GET') {
        const total = opts.download || 0;
        res.writeHead(200, { 'content-length': String(total) });
        let sent = 0;
        const t = setInterval(() => {
          const n = Math.min(opts.bytesPerTick, total - sent);
          res.write(Buffer.alloc(n));
          sent += n;
          if (sent >= total) { clearInterval(t); res.end(); }
        }, 10);
        timers.push(t);
        return;
      }
      req.pause();
      const t = setInterval(() => {
        if (opts.stallAfter !== undefined && got.bytes >= opts.stallAfter) return;   // 停住：再也不读
        let n = 0;
        let c: Buffer | null;
        while (n < opts.bytesPerTick && (c = req.read(Math.min(16 * 1024, opts.bytesPerTick - n))) !== null) { got.bytes += c.length; n += c.length; }
      }, 10);
      timers.push(t);
      req.on('end', () => { clearInterval(t); got.done = true; res.writeHead(200); res.end(); });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  mock.method(https, 'request', (o: any, cb: any) => http.request({ ...o, host: '127.0.0.1', port }, cb));
  return got;
}

/** 和 runS3SyncRound 一样：这一轮的凭证挂 live / progress。 */
const roundCreds = (round: any): S3Creds => ({ ...base, live: () => round.check(), progress: () => round.progress() });

describe('看门狗认得传输进展', () => {
  test('持续正常上传、总时长远超看门狗上限 → 这一轮跑完，传完之后照常往下走（写 state）', async () => {
    const LIMIT = 1500;   // 本机回环上传按 socket 缓冲一阵一阵地走（Windows 上约 0.5 秒一阵），上限要比这个间隔长
    const size = 24 * 1024 * 1024;
    const got = await slowS3({ bytesPerTick: 128 * 1024 });   // 实测约 4 MB/s（定时器粒度）→ 24 MB 要 6 秒左右
    const lock = makeLock();
    const logs: string[] = [];
    const rounds = new SyncRounds({ limitMs: LIMIT, log: (_l, m) => logs.push(m) });
    const wrote: string[] = [];
    const t0 = Date.now();
    const r = await rounds.run(lock, '定时', async (round) => {
      const creds = roundCreds(round);
      round.stage('上传 sessions/s1/transcript.jsonl');
      round.check();
      await putObject(creds, 'k', Buffer.alloc(size));
      round.check();
      wrote.push('state');
      return 'ok';
    }, () => 'abandoned');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed > LIMIT * 3, `上传只用了 ${elapsed}ms，没超过上限，测不出东西`);
    assert.equal(r, 'ok', `正常在传的上传被看门狗放弃了：${logs.join(' | ')}`);
    assert.equal(got.done, true);
    assert.equal(got.bytes, size);
    assert.deepEqual(wrote, ['state']);
    assert.equal(lock.value, false);
  });

  test('持续正常下载（慢）、总时长远超上限 → 不被放弃', async () => {
    const LIMIT = 150;
    await slowS3({ bytesPerTick: 16 * 1024, download: 2 * 1024 * 1024 });   // ≈ 1.6 MB/s → 2 MB 要 1 秒多
    const lock = makeLock();
    const rounds = new SyncRounds({ limitMs: LIMIT, log: () => {} });
    const t0 = Date.now();
    const r = await rounds.run(lock, '定时', async (round) => {
      round.stage('合并 s1：下载 files/a.bin');
      const body = await getObject(roundCreds(round), 'k');
      round.check();
      return body.length;
    }, () => 'abandoned');
    assert.ok(Date.now() - t0 > LIMIT * 4);
    assert.equal(r, 2 * 1024 * 1024);
  });

  test('上传传到一半停住不动 → 照样到点放弃、放锁', async () => {
    const LIMIT = 150;
    await slowS3({ bytesPerTick: 256 * 1024, stallAfter: 1024 * 1024 });
    const lock = makeLock();
    const logs: string[] = [];
    const rounds = new SyncRounds({ limitMs: LIMIT, log: (_l, m) => logs.push(m) });
    const wrote: string[] = [];
    const r = await rounds.run(lock, '定时', async (round) => {
      round.stage('上传 big');
      await putObject(roundCreds(round), 'k', Buffer.alloc(32 * 1024 * 1024));
      round.check();
      wrote.push('state');
      return 'ok';
    }, () => 'abandoned');
    assert.equal(r, 'abandoned');
    assert.equal(lock.value, false);
    assert.ok(logs.some((m) => /看门狗/.test(m) && /上传 big/.test(m)));
    assert.deepEqual(wrote, []);
  });

  test('被放弃之后的进展不会让这一轮复活', async () => {
    const lock = makeLock();
    const rounds = new SyncRounds({ limitMs: 50, log: () => {} });
    let late: any = null;
    const r = await rounds.run(lock, '定时', async (round) => {
      late = round;
      await new Promise(() => {});
      return 'ok';
    }, () => 'abandoned');
    assert.equal(r, 'abandoned');
    late.progress();
    assert.equal(late.abandoned, true);
    assert.throws(() => late.check());
    assert.equal(lock.value, false);
  });
});

describe('index.ts 接线', () => {
  test('这一轮的凭证把 S3 的传输进展接到看门狗', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/main/index.ts'), 'utf8');
    assert.match(M, /const creds = resolved\.creds \? \{ \.\.\.resolved\.creds, live: \(\) => round\.check\(\), progress: \(\) => round\.progress\(\) \} : undefined;/);
  });
});
