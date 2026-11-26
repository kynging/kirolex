import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { getObjectIfExists, type S3Creds } from '../src/main/s3Client.ts';
import { SyncRounds, RoundAbandoned } from '../src/main/syncRound.ts';
import type { RunLock } from '../src/main/awsProfileCreds.ts';

/*
 * 「备份定时同步网络断开 / 睡眠唤醒后卡死不再跑」（2026-11-26，Mac）：
 * 最后一次「同步开始」之后再没有任何 [s3] 会话同步日志 —— 一轮占着 syncRunning、卡在永远不返回的 await 上，
 * 之后每次定时触发都在 `if (syncRunning) return` 静默返回。
 *
 *   1. 真因：S3 响应收到一半连接被断开（睡眠 / 换网时对面 RST）—— req 不报错、res 不 'end'，Promise 永远不结束。
 *   2. 整轮看门狗：超过上限就放掉锁，被放弃那一轮晚到的结果不写 state / catalog。
 *   3. 上一轮还在跑时再触发：记日志，不静默。
 */

const creds: S3Creds = { accessKeyId: 'AKIA', secretAccessKey: 's', region: 'us-east-1', bucket: 'b' };

/** 把 https.request 转到本机的 http 服务器上（不用证书）。 */
function routeHttpsTo(port: number): void {
  mock.method(https, 'request', (opts: any, cb: any) => http.request({ ...opts, host: '127.0.0.1', port }, cb));
}

function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}

/** 给 Promise 一个上限：测试本身不能跟着挂死。 */
function within<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);
}

describe('S3 请求：连接中途断开一定结束', () => {
  let server: http.Server | null = null;
  afterEach(() => { mock.restoreAll(); server?.closeAllConnections(); server?.close(); server = null; });

  test('响应头到了、正文收到一半连接被掐断 → 报错返回，不会永远挂着', async () => {
    server = await listen((req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('abc');
      setTimeout(() => req.socket.destroy(), 50);
    });
    routeHttpsTo((server.address() as AddressInfo).port);
    const r = await within(getObjectIfExists(creds, 'k').then(() => 'resolved', (e) => `rejected: ${e?.message}`), 3000);
    assert.notEqual(r, 'pending', '连接断了，请求却一直没结束');
    assert.match(String(r), /^rejected/);
  });

  test('正常的响应照常拿到正文', async () => {
    server = await listen((_req, res) => { res.writeHead(200, { 'content-length': '5' }); res.end('hello'); });
    routeHttpsTo((server.address() as AddressInfo).port);
    const body = await getObjectIfExists(creds, 'k');
    assert.equal(body?.toString(), 'hello');
  });
});

/** 一把和 index.ts 里 syncLock 一样的锁。 */
function makeLock(): RunLock & { value: boolean } {
  const l = { value: false, get held() { return l.value; }, set held(v: boolean) { l.value = v; } };
  return l;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('整轮看门狗（syncRound.ts）', () => {
  test('一轮卡在永不返回的 await 上 → 到点放掉锁、记 warn（带阶段）；下一轮照常开始；被放弃那一轮晚到的结果不写 state / catalog', async () => {
    const lock = makeLock();
    const logs: Array<{ level: string; msg: string }> = [];
    const rounds = new SyncRounds({ limitMs: 80, log: (level, msg) => logs.push({ level, msg }) });
    const writes: string[] = [];
    const hang = deferred<string>();
    /* 和 runS3Sync 一样的形状：读 catalog（这里永远不返回）→ 写 state → 写 catalog */
    const body = async (round: any) => {
      round.stage('读 catalog');
      const catalog = await hang.promise;
      round.check();
      writes.push(`state:${catalog}`);
      round.check();
      writes.push(`catalog:${catalog}`);
      return 'ok';
    };
    const first = rounds.run(lock, '定时', body, () => 'abandoned');
    assert.equal(lock.value, true, '跑的时候占着锁');
    assert.equal(await within(first, 2000), 'abandoned', '看门狗到点没放弃这一轮');
    assert.equal(lock.value, false, '看门狗放弃之后锁要放掉');
    const warn = logs.find((l) => l.level === 'warn');
    assert.ok(warn, '要记 warn');
    assert.match(warn!.msg, /读 catalog/, 'warn 要带卡在哪个阶段');
    assert.match(warn!.msg, /定时/);

    /* 下一轮照常开始、照常写 */
    const second = await rounds.run(lock, '定时', async (round) => { round.stage('写 state'); round.check(); writes.push('state:second'); return 'ok'; }, () => 'abandoned');
    assert.equal(second, 'ok');
    assert.equal(lock.value, false);

    /* 被放弃那一轮现在才 resolve：不许再写 */
    hang.resolve('late');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(writes, ['state:second'], '被放弃那一轮晚到的结果写了 state / catalog');
  });

  test('被放弃那一轮晚到时 check() 抛 RoundAbandoned，晚到的 finally 不碰新一轮的锁', async () => {
    const lock = makeLock();
    const rounds = new SyncRounds({ limitMs: 50, log: () => {} });
    const hang = deferred<void>();
    let lateError: unknown = null;
    const first = rounds.run(lock, '定时', async (round) => {
      await hang.promise;
      try { round.check(); } catch (e) { lateError = e; throw e; }
      return 'ok';
    }, () => 'abandoned');
    assert.equal(await first, 'abandoned');
    /* 新一轮开始、还没结束时，旧那一轮晚到 */
    const block = deferred<void>();
    const second = rounds.run(lock, '手动', async () => { await block.promise; return 'ok'; }, () => 'abandoned');
    hang.resolve();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(lateError instanceof RoundAbandoned);
    assert.equal(lock.value, true, '旧那一轮晚到不能把新一轮的锁放掉');
    block.resolve();
    assert.equal(await second, 'ok');
    assert.equal(lock.value, false);
  });

  test('正常跑完：放锁、不记 warn、看门狗不再触发', async () => {
    const lock = makeLock();
    const logs: string[] = [];
    const rounds = new SyncRounds({ limitMs: 30, log: (_l, m) => logs.push(m) });
    assert.equal(await rounds.run(lock, '手动', async () => 'ok', () => 'abandoned'), 'ok');
    assert.equal(lock.value, false);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(logs, []);
  });

  test('一直有进展（每传完一个文件换一次阶段）的长轮次不被放弃：看门狗按「没有进展」计时，不按总时长', async () => {
    const lock = makeLock();
    const logs: string[] = [];
    const rounds = new SyncRounds({ limitMs: 60, log: (_l, m) => logs.push(m) });
    const r = await rounds.run(lock, '定时', async (round) => {
      for (let i = 0; i < 8; i++) { round.stage(`上传 ${i}`); await new Promise((x) => setTimeout(x, 25)); round.check(); }
      return 'ok';
    }, () => 'abandoned');
    assert.equal(r, 'ok', '总共 200ms > 上限 60ms，但每 25ms 都有进展，不该被放弃');
    assert.deepEqual(logs, []);
  });

  test('body 抛错也放锁', async () => {
    const lock = makeLock();
    const rounds = new SyncRounds({ limitMs: 1000, log: () => {} });
    await assert.rejects(rounds.run(lock, '手动', async () => { throw new Error('boom'); }, () => 'abandoned'), /boom/);
    assert.equal(lock.value, false);
  });

  test('上一轮还在跑时再触发 → 记一条含「还在跑」的日志（带上一轮开始时间和阶段），返回 null', async () => {
    const lock = makeLock();
    const logs: Array<{ level: string; msg: string }> = [];
    const rounds = new SyncRounds({ limitMs: 10_000, log: (level, msg) => logs.push({ level, msg }) });
    const block = deferred<void>();
    const first = rounds.run(lock, '定时', async (round) => { round.stage('上传 sessions/a/transcript.jsonl'); await block.promise; return 'ok'; }, () => 'abandoned');
    const again = await rounds.run(lock, '定时', async () => 'second', () => 'abandoned');
    assert.equal(again, null);
    const line = logs.find((l) => /还在跑/.test(l.msg));
    assert.ok(line, `没有「还在跑」的日志：${JSON.stringify(logs)}`);
    assert.match(line!.msg, /上传 sessions\/a\/transcript\.jsonl/);
    assert.match(line!.msg, /开始/);
    block.resolve();
    assert.equal(await first, 'ok');
  });

  test('锁被别的操作（恢复等）占着、不是同步轮：也记「还在跑」', async () => {
    const lock = makeLock();
    lock.held = true;
    const logs: string[] = [];
    const rounds = new SyncRounds({ limitMs: 10_000, log: (_l, m) => logs.push(m) });
    assert.equal(rounds.noteSkipped('定时', 'skipped'), 'skipped');
    assert.ok(logs.some((m) => /还在跑/.test(m)));
    assert.equal(await rounds.run(lock, '定时', async () => 'x', () => 'abandoned'), null);
  });

  test('按墙上时间判超时（Mac 睡眠时定时器不走）：reclaimIfStale 立刻放弃超时的那一轮', async () => {
    const lock = makeLock();
    let now = 1_000_000;
    const logs: string[] = [];
    const rounds = new SyncRounds({ limitMs: 60_000, log: (_l, m) => logs.push(m), now: () => now });
    const hang = deferred<string>();
    const first = rounds.run(lock, '定时', async () => hang.promise, () => 'abandoned');
    assert.equal(rounds.reclaimIfStale(), false, '还没到上限不放弃');
    now += 61_000;   // 睡了一觉：墙上时间过了上限，单调时钟的定时器还没到
    assert.equal(rounds.reclaimIfStale(), true);
    assert.equal(await first, 'abandoned');
    assert.equal(lock.value, false);
    assert.ok(logs.some((m) => /看门狗/.test(m)));
  });
});

describe('index.ts 接线', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/main/index.ts'), 'utf8');
  const sync = M.slice(M.indexOf('async function runS3Sync('), M.indexOf('function rescheduleS3Sync('));

  test('runS3Sync 走 syncRounds.run（先占锁再取凭证），锁被占着时记日志', () => {
    const firstAwait = sync.indexOf('await ');
    assert.ok(firstAwait > 0);
    assert.match(sync.slice(0, firstAwait + 80), /syncRounds\.run\(syncLock, reason/);
    assert.match(sync, /if \(syncRunning\) return syncRounds\.noteSkipped\(reason, /);
  });

  test('写 state / catalog / marks 之前都核对这一轮还算数', () => {
    for (const anchor of [/writeState\(S3_STATE_PATH, state\);\s*\/\*\s*\*\*只更新/, /writeSyncCatalog\(/, /writeBucketSeen\(S3_BUCKET_SEEN_PATH/]) {
      const at = sync.search(anchor);
      assert.ok(at > 0, String(anchor));
      assert.match(sync.slice(Math.max(0, at - 200), at), /round\.check\(\)/, `${anchor} 前面没有 round.check()`);
    }
    /* 失败分支：被放弃的那一轮不写 state、不算失败次数 */
    const catchAt = sync.lastIndexOf('} catch (err: any) {');
    const tail = sync.slice(catchAt, catchAt + 600);
    assert.ok(tail.indexOf('round.abandoned') > 0 && tail.indexOf('round.abandoned') < tail.indexOf('writeState('));
  });

  test('睡眠唤醒后补跑一轮', () => {
    assert.match(M, /powerMonitor\.on\('resume'/);
    const at = M.indexOf("powerMonitor.on('resume'");
    const block = M.slice(at, at + 1200);
    assert.match(block, /syncRounds\.reclaimIfStale\(\)/);
    assert.match(block, /runS3Sync\('睡眠唤醒后补一轮'\)/);
  });
});
