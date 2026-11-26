import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  getObjectIfExists, getObjectWithEtag, putObject, putObjectIf, listObjects, listCommonPrefixes, deleteObject, checkLive, type S3Creds,
} from '../src/main/s3Client.ts';
import { writeSyncCatalog, type CatalogBucket } from '../src/main/catalogStore.ts';
import { syncComboFile } from '../src/main/mcpCombosSync.ts';
import { SyncRounds, RoundAbandoned } from '../src/main/syncRound.ts';
import type { RunLock } from '../src/main/awsProfileCreds.ts';

/*
 * 审查意见（2026-11-26）：只在子流程返回后 / catalog 队列回调开头核对轮次不够 —— 子流程内部的等待期间被看门狗放弃，
 * 读取晚到之后仍会写 catalog（writeSyncCatalog 里 sessionIds → 读 catalog → put）、改本机文件、写同步标记。
 * 现在每一轮的凭证挂着 `live`（= round.check）：每个 S3 请求**发出前、收到响应后**都核对（s3Client 的 request），
 * 子流程改本机之前 `checkLive(creds)`（吞掉 S3 报错继续往下走的子流程也拦得住）。
 */

const creds: S3Creds = { accessKeyId: 'AKIA', secretAccessKey: 's', region: 'us-east-1', bucket: 'b' };

function makeLock(): RunLock & { value: boolean } {
  const l = { value: false, get held() { return l.value; }, set held(v: boolean) { l.value = v; } };
  return l;
}

let server: http.Server | null = null;
afterEach(() => { mock.restoreAll(); server?.closeAllConnections(); server?.close(); server = null; });

/** 一个假 S3（https.request 转到本机 http）：记下收到的每个请求；`gate.hold` 打开时响应等 release 才回。 */
async function fakeS3(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: string[] = [];
  const gate = { hold: false, waiting: [] as Array<() => void> };
  server = await new Promise<http.Server>((resolve) => {
    const s = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        const go = () => handler(req, res);
        if (gate.hold) gate.waiting.push(go); else go();
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  mock.method(https, 'request', (opts: any, cb: any) => http.request({ ...opts, host: '127.0.0.1', port }, cb));
  return { seen, gate, release: () => { gate.hold = false; for (const w of gate.waiting.splice(0)) w(); } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('被放弃那一轮的凭证：晚到的读取拿不到结果，之后的写发不出去', () => {
  test('s3Client：响应晚到 → 调用方拿到 RoundAbandoned 而不是结果；被放弃之后写请求不发出', async () => {
    const s3 = await fakeS3((_req, res) => { res.writeHead(200, { 'content-length': '2', etag: '"e"' }); res.end('{}'); });
    let dead = false;
    const c: S3Creds = { ...creds, live: () => { if (dead) throw new RoundAbandoned(1); } };
    s3.gate.hold = true;
    const late = getObjectIfExists(c, 'k').then(() => 'resolved', (e) => e);
    await sleep(50);
    dead = true;
    s3.release();
    assert.ok((await late) instanceof RoundAbandoned, '晚到的响应还是交给了调用方');
    const before = s3.seen.length;
    await assert.rejects(putObject(c, 'k2', Buffer.from('x')), RoundAbandoned);
    assert.equal(s3.seen.length, before, '被放弃之后写请求还是发出去了');
  });

  test('没挂 live 的凭证（恢复 / 单独同步定时任务等）照常', async () => {
    await fakeS3((_req, res) => { res.writeHead(200, { 'content-length': '2' }); res.end('ok'); });
    assert.equal((await getObjectIfExists(creds, 'k'))?.toString(), 'ok');
  });

  test('真的 writeSyncCatalog：内部读取（列会话 id）挂着时看门狗放弃这一轮，读取随后返回 → 不 PUT catalog', async () => {
    const s3 = await fakeS3((req, res) => {
      if (req.method === 'GET' && /list-type=2/.test(req.url || '')) {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
        return;
      }
      if (req.method === 'GET') { res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>'); return; }
      res.writeHead(200, { etag: '"new"' }); res.end();
    });
    const lock = makeLock();
    const rounds = new SyncRounds({ limitMs: 80, log: () => {} });
    s3.gate.hold = true;   // 第一个请求就挂住
    let finished: unknown = 'pending';
    const r = await rounds.run(lock, '定时', async (round) => {
      /* 和 index.ts 的 catalogBucket 一样，全部接到 s3Client 上；凭证和 runS3SyncRound 一样挂 live */
      const c: S3Creds = { ...creds, live: () => round.check() };
      const bucket: CatalogBucket = {
        get: (key) => getObjectWithEtag(c, key),
        put: async (key, body, cond) => {
          if (cond) return putObjectIf(c, key, body, 'application/json', cond);
          await putObject(c, key, body, 'application/json');
          return 'ok';
        },
        list: async (pfx) => (await listObjects(c, pfx)).map((o) => o.key),
        del: (key) => deleteObject(c, key),
        sessionIds: async () => new Set((await listCommonPrefixes(c, 'v1/sessions/')).map((p) => p.split('/').at(-2) || '')),
        deletedAt: async () => null,
      };
      round.stage('写 catalog');
      try {
        await writeSyncCatalog(bucket, '', [{ id: 's1', title: 't', updatedAt: 1, bytes: 1, from: 'm', syncedAt: 1, uploadedAt: 1 } as any], Date.now());
        finished = 'wrote';
      } catch (e) { finished = e; throw e; }
      return 'ok';
    }, () => 'abandoned');
    assert.equal(r, 'abandoned');
    assert.equal(lock.value, false);
    s3.release();   // 挂着的读取现在才回来
    await sleep(150);
    assert.ok(finished instanceof RoundAbandoned, `被放弃那一轮的 writeSyncCatalog 应该以 RoundAbandoned 结束，实际：${String(finished)}`);
    assert.deepEqual(s3.seen.filter((l) => l.startsWith('PUT')), [], '被放弃那一轮还是写了 catalog');
  });

  test('子流程（组合文件）：读取挂着时被放弃，读取晚到 → 不改本机文件、不写同步标记、不上传', async () => {
    const s3 = await fakeS3((req, res) => {
      if (req.method === 'GET') { res.writeHead(200, { etag: '"r"' }); res.end(JSON.stringify({ version: 1, combos: [{ id: 'a', name: 'A', servers: [] }] })); return; }
      res.writeHead(200, { etag: '"n"' }); res.end();
    });
    const lock = makeLock();
    const rounds = new SyncRounds({ limitMs: 80, log: () => {} });
    const local: string[] = [];
    s3.gate.hold = true;
    let finished: unknown = 'pending';
    const r = await rounds.run(lock, '定时', async (round) => {
      const c: S3Creds = { ...creds, live: () => round.check() };
      /* 和 index.ts 的 syncMcpCombosWithBucket 一样的接法：写本机 / 写标记的回调先 checkLive */
      try {
        await syncComboFile({
          get: async () => { const g = await getObjectWithEtag(c, 'mcp-combos.json'); return g ? { text: g.body.toString('utf-8'), etag: g.etag } : null; },
          put: (text, cond) => putObjectIf(c, 'mcp-combos.json', Buffer.from(text), 'application/json', cond),
          readLocal: () => undefined,
          writeLocal: (text) => { checkLive(c); local.push(`file:${text.length}`); },
          readMark: () => null,
          writeMark: () => { checkLive(c); local.push('mark'); },
        });
        finished = 'done';
      } catch (e) { finished = e; throw e; }
      return 'ok';
    }, () => 'abandoned');
    assert.equal(r, 'abandoned');
    s3.release();
    await sleep(150);
    assert.ok(finished instanceof RoundAbandoned, String(finished));
    assert.deepEqual(local, [], '被放弃那一轮改了本机');
    assert.deepEqual(s3.seen.filter((l) => l.startsWith('PUT')), []);
  });
});

describe('index.ts 接线：每一轮的凭证挂 live，子流程改本机之前核对', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/main/index.ts'), 'utf8');
  const fn = (start: string) => { const at = M.indexOf(start); assert.ok(at > 0, start); return M.slice(at, M.indexOf('\n}\n', at)); };

  test('runS3SyncRound 用的凭证带 live: round.check', () => {
    assert.match(fn('async function runS3Sync('), /const creds = resolved\.creds \? \{ \.\.\.resolved\.creds, live: \(\) => round\.check\(\), progress: \(\) => round\.progress\(\) \} : undefined;/);
  });

  test('外观 / agent-profiles：写本机、写标记之前 checkLive(creds)（组合文件 2026-11-26 起不再同步）', () => {
    assert.doesNotMatch(M, /async function syncMcpCombosWithBucket\(/);
    assert.match(fn('async function syncAppearanceWithBucket('), /apply: \(payload, updatedAt, from\) => \{\s*checkLive\(creds\);/);
    const prof = fn('async function syncAgentProfilesWithBucket(');
    assert.match(prof, /writeLocal: \(rel, body\) => \{\s*checkLive\(creds\);/);
    assert.match(prof, /writeConflictCopy: \(rel, body\) => \{\s*checkLive\(creds\);/);
    assert.match(prof, /writeMarks: \(m\) => \{ checkLive\(creds\);/);
  });

  test('定时任务 / 后台任务：网络等完、改本机之前 checkLive(creds)；后台任务的账本和停进程都过这一道', () => {
    const sch = fn('async function syncSchedulesWithBucket(');
    const at = sch.indexOf('checkLive(creds);');
    assert.ok(at > 0 && at < sch.indexOf('const plan = planScheduleSync('));
    const bg = fn('async function syncBgJobsWithBucket(');
    const guarded = 'const ledger = (fn: (l: BgSyncLedger) => BgSyncLedger): void => { checkLive(creds); updateBgLedger(fn); };';
    assert.ok(bg.includes(guarded));
    assert.equal(bg.replace(guarded, '').includes('updateBgLedger('), false, '后台任务同步里还有没过 checkLive 的 updateBgLedger');
    assert.match(bg, /checkLive\(creds\);\s*await bgJobs\.stop\(/);
  });

  test('offload：挪目录之前最后一问里核对这一轮还算数', () => {
    assert.match(fn('async function runOffloadRound('), /recheck: \(\) => \{\s*if \(!isLive\(creds\)\) return 'the sync round was abandoned';/);
  });

  test('云端清理 / offload 的 try 不吞 RoundAbandoned', () => {
    const sync = fn('async function runS3Sync(');
    const clean = sync.slice(sync.indexOf('cleanup = await runCloudCleanup('));
    assert.match(clean.slice(0, clean.indexOf('logger.warn(\'s3\', `云端清理没跑成')), /if \(err instanceof RoundAbandoned\) throw err;/);
    const off = sync.slice(sync.indexOf('offloaded = await runOffloadRound('));
    assert.match(off.slice(0, off.indexOf('logger.warn(\'offload\'')), /if \(err instanceof RoundAbandoned\) throw err;/);
  });
});
