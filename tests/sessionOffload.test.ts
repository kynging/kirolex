import assert from 'node:assert/strict';
import { describe, test, afterEach } from 'node:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  decideOffload, planOffloadRound, offloadSettings, offloadBlocked, lastActivityAt, lastMessageTs,
  verifyCloudCopy, offloadSession, finishOffloadRestore, readOffloadState, writeOffloadState,
  setKeepLocal, manifestSessionsWithOffloaded, offloadTrashDirFor, filesMatchSyncState, idsWithItems, restoreOffloadedSession, offloadStagingRoot, RESTORE_COMPLETE_MARK,
  readOffloadStateStrict, strictSessionRefs, scheduleRefs, loopRefs, offloadedIdsInTrash, prefixFromCloudKey, offloadedPasteRefs, transcriptExternalRefs,
  MAX_OFFLOAD_PER_ROUND, DEFAULT_OFFLOAD_DAYS, type OffloadFacts, type OffloadBucket,
} from '../src/main/sessionOffload.ts';
import { decideCleanup, buildDeviceManifest, withDeviceManifest, deletionsFromTrashNames, DAY_MS } from '../src/main/cloudTrash.ts';
import { keyFor, type Catalog } from '../src/main/s3Sync.ts';

/*
 * 「超过 30 天不用的会话移到云端」：确认云端那份是最新的才删本机副本，侧栏留占位，点开自动恢复。
 * 绝不能写删除记录 —— 否则 cloudTrash 会把它判成「所有设备都删了」移进云端回收站。
 * 所有拿不准的情况都按「不移」处理：下面每个「不移」的用例守的都是这一条。
 */

const NOW = Date.parse('2026-10-30T00:00:00Z');
const OLD = NOW - 45 * DAY_MS;
const base = (over: Partial<OffloadFacts> = {}): OffloadFacts => ({
  id: 's_1',
  updatedAt: OLD,
  lastMessageAt: OLD - 1000,
  inCatalog: true,
  mark: { at: OLD + 1000, updatedAt: OLD },
  filesClean: true,
  open: false, busy: false, queued: false, scheduled: false, looping: false, bgJobs: false, pendingSteers: false,
  pinned: false, advancedOnly: false, excludedProject: false, excludedSession: false, keepLocal: false, offloaded: false,
  ...over,
});
const decide = (f: OffloadFacts, idleDays = 30) => decideOffload(f, { now: NOW, idleDays });

describe('decideOffload：每一条都满足才移', () => {
  test('都满足 → 移', () => {
    assert.deepEqual(decide(base()), { offload: true, lastActiveAt: OLD });
  });

  test('最后活动没早于 N 天 → 不移（updatedAt 和最后一条消息取较晚的）', () => {
    assert.equal(decide(base({ updatedAt: NOW - 10 * DAY_MS })).offload, false);
    /* updatedAt 很旧，但 transcript 最后一条消息是最近的 → 按较晚的算 → 不移 */
    const r = decide(base({ lastMessageAt: NOW - 2 * DAY_MS }));
    assert.equal(r.offload, false);
    assert.equal((r as any).reason, 'recent');
    /* 天数可调：45 天前的在 60 天门槛下不移 */
    assert.equal(decide(base(), 60).offload, false);
  });

  test('天数 0（关掉）→ 不移', () => {
    assert.equal(decide(base(), 0).offload, false);
  });

  test('catalog 里没有这条 → 不移', () => {
    assert.equal((decide(base({ inCatalog: false })) as any).reason, 'not-in-catalog');
  });

  test('云端标记比本机旧（本机有未上传的改动）→ 不移', () => {
    /* mark.updatedAt 早于本机 record.updatedAt：最后一次上传之后本机又改过 */
    const r = decide(base({ updatedAt: OLD + 5000, mark: { at: OLD + 1000, updatedAt: OLD } }));
    assert.equal(r.offload, false);
    assert.equal((r as any).reason, 'unsynced');
    /* 从没上传过（没有 mark / at 为 0）*/
    assert.equal((decide(base({ mark: undefined })) as any).reason, 'unsynced');
    assert.equal((decide(base({ mark: { at: 0, updatedAt: OLD } })) as any).reason, 'unsynced');
    /* 文件和同步状态表对不上（大小 / 修改时间变了，没传上去）*/
    assert.equal((decide(base({ filesClean: false })) as any).reason, 'unsynced');
  });

  const flags: Array<[keyof OffloadFacts, string]> = [
    ['open', 'open'], ['busy', 'busy'], ['queued', 'queued'], ['scheduled', 'scheduled'], ['looping', 'looping'],
    ['bgJobs', 'bg-jobs'], ['pendingSteers', 'pending-steers'], ['pinned', 'pinned'], ['advancedOnly', 'advanced'],
    ['excludedProject', 'excluded'], ['excludedSession', 'excluded'], ['keepLocal', 'keep-local'], ['offloaded', 'offloaded'],
  ];
  for (const [k, reason] of flags) {
    test(`${String(k)} → 不移（${reason}）`, () => {
      const r = decide(base({ [k]: true } as any));
      assert.equal(r.offload, false);
      assert.equal((r as any).reason, reason);
    });
  }

  test('任何一项判断不了（null）→ 不移', () => {
    const unknowns: Array<keyof OffloadFacts> = [
      'updatedAt', 'lastMessageAt', 'inCatalog', 'filesClean', 'open', 'busy', 'queued', 'scheduled', 'looping',
      'bgJobs', 'pendingSteers', 'pinned', 'advancedOnly', 'excludedProject', 'excludedSession', 'keepLocal', 'offloaded',
    ];
    for (const k of unknowns) {
      const r = decide(base({ [k]: null } as any));
      assert.equal(r.offload, false, `${String(k)} 判断不了却移了`);
      assert.equal((r as any).reason, 'unknown', String(k));
    }
    /* 时间是坏值（NaN / 将来）也算判断不了 */
    assert.equal((decide(base({ updatedAt: Number.NaN })) as any).reason, 'unknown');
    assert.equal((decide(base({ lastMessageAt: NOW + DAY_MS })) as any).reason, 'unknown');
    assert.equal((decide(base({ mark: null })) as any).reason, 'unknown');
  });

  test('lastActivityAt 取较晚的那个；没有消息（0）按 updatedAt', () => {
    assert.equal(lastActivityAt(10, 20), 20);
    assert.equal(lastActivityAt(30, 0), 30);
    assert.equal(lastActivityAt(null, 5), null);
  });
});

describe('planOffloadRound：一轮最多 20 条，最久没用的先', () => {
  test('最多 MAX_OFFLOAD_PER_ROUND 条，按最后活动从旧到新', () => {
    const facts = Array.from({ length: 30 }, (_, i) => base({ id: `s_${i}`, updatedAt: OLD - i * 1000, lastMessageAt: 0 }));
    const plan = planOffloadRound(facts, { now: NOW, idleDays: 30 });
    assert.equal(MAX_OFFLOAD_PER_ROUND, 20);
    assert.equal(plan.picked.length, 20);
    assert.equal(plan.picked[0].id, 's_29');
    assert.equal(plan.skipped.length, 0);
  });
  test('不满足的进 skipped 并带原因', () => {
    const plan = planOffloadRound([base({ id: 'a' }), base({ id: 'b', pinned: true })], { now: NOW, idleDays: 30 });
    assert.deepEqual(plan.picked.map((p) => p.id), ['a']);
    assert.deepEqual(plan.skipped, [{ id: 'b', reason: 'pinned' }]);
  });
});

describe('设置：开关默认开、天数默认 30；S3 没配好 / 没开时整个不跑', () => {
  test('缺省 = 开 + 30 天；0 或开关关 = 不移；乱填回默认', () => {
    assert.deepEqual(offloadSettings({}), { enabled: true, days: DEFAULT_OFFLOAD_DAYS });
    assert.deepEqual(offloadSettings({ autoOffload: false }), { enabled: false, days: 30 });
    assert.deepEqual(offloadSettings({ offloadIdleDays: 0 }), { enabled: false, days: 0 });
    assert.deepEqual(offloadSettings({ offloadIdleDays: 90 }), { enabled: true, days: 90 });
    assert.deepEqual(offloadSettings({ offloadIdleDays: 'x' as any }), { enabled: true, days: 30 });
    assert.deepEqual(offloadSettings(null), { enabled: true, days: 30 });
  });
  test('offloadBlocked：备份没开 / 凭据有问题 / 设置关掉 → 说出原因；都好 → null', () => {
    assert.match(String(offloadBlocked({ enabled: false }, null)), /backup|备份/i);
    assert.match(String(offloadBlocked({ enabled: true }, 'no bucket')), /no bucket/);
    assert.ok(offloadBlocked({ enabled: true, autoOffload: false }, null));
    assert.ok(offloadBlocked({ enabled: true, offloadIdleDays: 0 }, null));
    assert.equal(offloadBlocked({ enabled: true }, null), null);
  });
});

/* ------------------------------------------------------------------ 真 I/O：临时目录 + 内存假桶 */

let tmp: string[] = [];
afterEach(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); tmp = []; });
const mkHome = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-offload-')); tmp.push(d); return d; };

const md5 = (b: Buffer) => `"${crypto.createHash('md5').update(b).digest('hex')}"`;
function memBucket(): OffloadBucket & { data: Map<string, Buffer>; etagOverride?: (key: string) => string | undefined } {
  const data = new Map<string, Buffer>();
  const b: any = {
    data,
    async list(prefix: string) {
      return [...data.keys()].filter((k) => k.startsWith(prefix)).sort()
        .map((key) => ({ key, size: data.get(key)!.length, etag: b.etagOverride?.(key) ?? md5(data.get(key)!) }));
    },
    async get(key: string) { return data.has(key) ? Buffer.from(data.get(key)!) : null; },
  };
  return b;
}

/** 本机建一条会话 + 原样传进假桶（等同一轮同步传完）。 */
function seedSession(home: string, bucket: ReturnType<typeof memBucket>, id: string, prefix = 'kx', updatedAt = OLD) {
  const dir = path.join(home, 'sessions', id);
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  const rec = { schemaVersion: 1, id, title: `标题 ${id}`, createdAt: OLD - DAY_MS, updatedAt, profile: { projectId: 'P', engine: 'claude' }, executorState: 'detached' };
  fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify(rec, null, 2));
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), `${JSON.stringify({ id: 'm1', role: 'user', content: 'hi', ts: OLD - 5000 })}\n`);
  fs.writeFileSync(path.join(dir, 'history.md'), '# hi\n');
  fs.writeFileSync(path.join(dir, 'files', 'out.txt'), 'x'.repeat(5000));
  for (const rel of ['record.json', 'transcript.jsonl', 'history.md', path.join('files', 'out.txt')]) {
    bucket.data.set(keyFor(prefix, path.join('sessions', id, rel)), fs.readFileSync(path.join(dir, rel)));
  }
  return rec;
}

describe('verifyCloudCopy：动手之前核对云端对象和本机文件（数量 + 摘要）', () => {
  test('全部一致 → ok，带文件数和字节数', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    const v = await verifyCloudCopy(b, 'kx', home, 's_a');
    assert.equal(v.ok, true);
    assert.equal((v as any).files, 4);
    assert.ok((v as any).bytes > 5000);
  });
  test('本机有一个文件云上没有 → 不 ok', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    fs.writeFileSync(path.join(home, 'sessions', 's_a', 'files', 'new.txt'), 'new');
    const v = await verifyCloudCopy(b, 'kx', home, 's_a');
    assert.equal(v.ok, false);
    assert.match((v as any).why, /new\.txt/);
  });
  test('内容不一样（大小相同）→ 不 ok', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    fs.writeFileSync(path.join(home, 'sessions', 's_a', 'history.md'), '# HI\n');
    assert.equal((await verifyCloudCopy(b, 'kx', home, 's_a')).ok, false);
  });
  test('ETag 不是 MD5（例如 KMS 加密）→ 下载下来比内容；一样就 ok', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    b.etagOverride = () => '"abc-2"';
    assert.equal((await verifyCloudCopy(b, 'kx', home, 's_a')).ok, true);
  });
  test('列不出来（网络错误）→ 不 ok，不抛', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    (b as any).list = async () => { throw new Error('ECONNRESET'); };
    const v = await verifyCloudCopy(b, 'kx', home, 's_a');
    assert.equal(v.ok, false);
    assert.match((v as any).why, /ECONNRESET/);
  });
});

describe('filesMatchSyncState：本机文件和同步状态表一致（最后一次上传之后没改过）', () => {
  test('一致 → true；改过一个 → false；状态表里缺一个 → false', () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    const state: Record<string, { size: number; mtimeMs: number }> = {};
    for (const rel of ['record.json', 'transcript.jsonl', 'history.md', path.join('files', 'out.txt')]) {
      const r = path.join('sessions', 's_a', rel);
      const st = fs.statSync(path.join(home, r));
      state[r] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    }
    assert.equal(filesMatchSyncState(home, 's_a', state), true);
    const missing = { ...state }; delete missing[path.join('sessions', 's_a', 'history.md')];
    assert.equal(filesMatchSyncState(home, 's_a', missing), false);
    fs.appendFileSync(path.join(home, 'sessions', 's_a', 'transcript.jsonl'), '{"id":"m2","ts":1}\n');
    assert.equal(filesMatchSyncState(home, 's_a', state), false);
    assert.equal(filesMatchSyncState(home, 's_none', state), null);
  });
});

describe('lastMessageTs：transcript 最后一条消息的时间', () => {
  test('读最后一行；没有文件 = 0；最后一行坏了 = null（判断不了）', () => {
    const home = mkHome();
    const f = path.join(home, 't.jsonl');
    assert.equal(lastMessageTs(f), 0);
    fs.writeFileSync(f, `${JSON.stringify({ id: 'a', ts: 5 })}\n${JSON.stringify({ id: 'b', ts: 9, content: 'y'.repeat(200_000) })}\n\n`);
    assert.equal(lastMessageTs(f), 9);
    fs.appendFileSync(f, '{"id":"c","ts":');
    assert.equal(lastMessageTs(f), null);
  });
});

describe('端到端：移到云端 → 不进云端回收站 → 恢复回来', () => {
  test('移：本机目录进回收站、占位在、catalog 不变、不写删除记录', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    const catalogBefore: Catalog = { version: 1, entries: [{ id: 's_a', title: '标题 s_a', updatedAt: OLD, bytes: 1, from: 'd_me', syncedAt: OLD, uploadedAt: OLD }] };
    b.data.set('kx/v1/catalog.json', Buffer.from(JSON.stringify(catalogBefore)));
    const catalogRaw = Buffer.from(b.data.get('kx/v1/catalog.json')!);
    const stateFile = path.join(home, 'sessions-offloaded.json');
    const deletedAt = path.join(home, 's3-deleted-at.json');

    const r = await offloadSession(b, {
      prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, remoteHost: 'devbox',
      recheck: () => null,
    });
    assert.equal(r.ok, true, (r as any).why);
    assert.equal(fs.existsSync(path.join(home, 'sessions', 's_a')), false, '本机目录还在');
    const trashed = offloadTrashDirFor(home, 's_a', NOW);
    assert.equal(fs.existsSync(path.join(trashed, 'record.json')), true, '没进本机回收站');
    const st = readOffloadState(stateFile);
    const p = st.offloaded['s_a'];
    assert.equal(p.title, '标题 s_a');
    assert.equal(p.project, 'P');
    assert.equal(p.engine, 'claude');
    assert.equal(p.remoteHost, 'devbox');
    assert.equal(p.lastActiveAt, OLD);
    assert.equal(p.offloadedAt, NOW);
    assert.equal(p.cloudKey, 'kx/v1/sessions/s_a/');
    assert.ok(p.bytes > 5000);
    assert.deepEqual(b.data.get('kx/v1/catalog.json'), catalogRaw, 'catalog 被改了');
    assert.equal(fs.existsSync(deletedAt), false, '写了删除记录');
    assert.equal(fs.existsSync(path.join(home, 'deleted-sessions.json')), false, '写了墓碑');
    /* 回收站目录名不能被 cloudTrash 认成删除记录 */
    const names = fs.readdirSync(path.join(home, 'trash'));
    assert.deepEqual(deletionsFromTrashNames(names), {});

    /* 接着跑一轮 decideCleanup：本机清单把已移到云端的 id 当成「仍持有」上报 → 不进云端回收站 */
    const local = manifestSessionsWithOffloaded([], st);
    assert.deepEqual(local.map((s) => s.id), ['s_a']);
    const manifest = buildDeviceManifest('d_me', NOW, local, deletionsFromTrashNames(names));
    assert.deepEqual(manifest.deleted, []);
    /* 就算另一台设备删过它（有删除记录），本机仍持有 → 不清 */
    const other = buildDeviceManifest('d_other', NOW, [], { s_a: NOW - DAY_MS });
    const c = withDeviceManifest(withDeviceManifest(catalogBefore, manifest), other);
    const d = decideCleanup(c, { now: NOW + 1000, activeDays: 90 });
    assert.equal(d.blocked, null);
    assert.deepEqual(d.candidates, []);
    /* 反证：如果不把它当成「仍持有」，同样的局面就会被清 —— 这正是要挡的 */
    const bad = withDeviceManifest(withDeviceManifest(catalogBefore, buildDeviceManifest('d_me', NOW, [], {})), other);
    assert.deepEqual(decideCleanup(bad, { now: NOW + 1000, activeDays: 90 }).candidates.map((x) => x.entry.id), ['s_a']);

    /* 恢复：模拟 s3:restore 把桶里那份拉回本机，再收尾 → 目录回来、占位删掉、updatedAt 刷新 */
    for (const [key, body] of b.data) {
      if (!key.startsWith('kx/v1/sessions/s_a/')) continue;
      const abs = path.join(home, ...key.slice('kx/v1/'.length).split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    const later = NOW + 3 * DAY_MS;
    const fin = finishOffloadRestore(stateFile, home, 's_a', later);
    assert.equal(fin.ok, true);
    assert.equal(readOffloadState(stateFile).offloaded['s_a'], undefined, '占位没删');
    const rec = JSON.parse(fs.readFileSync(path.join(home, 'sessions', 's_a', 'record.json'), 'utf-8'));
    assert.equal(rec.updatedAt, later, 'updatedAt 没刷新');
    assert.equal(rec.title, '标题 s_a');
    /* 刚恢复回来不会马上又被移走：最后活动 = 现在 */
    assert.equal(decideOffload(base({ updatedAt: rec.updatedAt, lastMessageAt: OLD }), { now: later + DAY_MS, idleDays: 30 }).offload, false);
  });

  test('核对不通过 → 什么都不动（目录在、没有占位、不进回收站）', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    b.data.delete(keyFor('kx', path.join('sessions', 's_a', 'history.md')));
    const stateFile = path.join(home, 'sessions-offloaded.json');
    const r = await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => null });
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(path.join(home, 'sessions', 's_a', 'record.json')), true);
    assert.deepEqual(readOffloadState(stateFile).offloaded, {});
    assert.equal(fs.existsSync(path.join(home, 'trash')), false);
  });

  test('核对完、移动之前那一刻再问一次（被打开了）→ 不动', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    const stateFile = path.join(home, 'sessions-offloaded.json');
    const r = await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => 'open' });
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(path.join(home, 'sessions', 's_a', 'record.json')), true);
    assert.deepEqual(readOffloadState(stateFile).offloaded, {});
  });

  test('恢复收尾：本机目录没回来 → 不删占位', () => {
    const home = mkHome();
    const stateFile = path.join(home, 'sessions-offloaded.json');
    writeOffloadState(stateFile, { version: 1, offloaded: { s_a: { id: 's_a', title: 't', lastActiveAt: OLD, offloadedAt: NOW, cloudKey: 'kx/v1/sessions/s_a/', bytes: 1, files: 1 } }, keepLocal: [] });
    assert.equal(finishOffloadRestore(stateFile, home, 's_a', NOW).ok, false);
    assert.ok(readOffloadState(stateFile).offloaded['s_a']);
  });
});

describe('占位文件 / keepLocal', () => {
  test('读坏的 / 没有的占位文件 = 空；keepLocal 打上 / 去掉', () => {
    const home = mkHome();
    const f = path.join(home, 'sessions-offloaded.json');
    assert.deepEqual(readOffloadState(f), { version: 1, offloaded: {}, keepLocal: [] });
    fs.writeFileSync(f, '{oops');
    assert.deepEqual(readOffloadState(f).offloaded, {});
    /* 坏了的文件：显示时当空，但判定 / 写入不当空 —— 不覆盖它 */
    assert.equal(readOffloadStateStrict(f), null);
    assert.equal(setKeepLocal(f, 's_a', true), false);
    assert.equal(fs.readFileSync(f, 'utf-8'), '{oops');
    fs.rmSync(f);
    assert.deepEqual(readOffloadStateStrict(f), { version: 1, offloaded: {}, keepLocal: [] }, '没有文件 = 从没移过');
    assert.equal(setKeepLocal(f, 's_a', true), true);
    setKeepLocal(f, 's_a', true);
    assert.deepEqual(readOffloadState(f).keepLocal, ['s_a']);
    setKeepLocal(f, 's_a', false);
    assert.deepEqual(readOffloadState(f).keepLocal, []);
  });
  test('manifestSessionsWithOffloaded：本机有的照旧，已移到云端的补上（不重复）', () => {
    const st = { version: 1 as const, offloaded: { s_b: { id: 's_b', title: 't', project: 'P', lastActiveAt: 1, offloadedAt: 2, cloudKey: 'kx/v1/sessions/s_a/', bytes: 1, files: 1 } }, keepLocal: [] };
    const out = manifestSessionsWithOffloaded([{ id: 's_a' }, { id: 's_b' }], st);
    assert.deepEqual(out.map((s) => s.id), ['s_a', 's_b']);
    assert.deepEqual(manifestSessionsWithOffloaded([], st), [{ id: 's_b', project: 'P' }]);
  });
});

describe('verifyCloudCopy：只在本机的文件', () => {
  test('events.jsonl / last-injection.md 不进备份，丢了也无妨 → 不挡', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    fs.writeFileSync(path.join(home, 'sessions', 's_a', 'events.jsonl'), '{}\n');
    fs.writeFileSync(path.join(home, 'sessions', 's_a', 'last-injection.md'), 'x');
    const v = await verifyCloudCopy(b, 'kx', home, 's_a');
    assert.equal(v.ok, true);
    assert.equal((v as any).files, 4);
  });
  test('别的只在本机的文件（context-override.md、files/ 里不进备份的依赖目录 / 压缩包）→ 不移，免得只剩回收站那一份', async () => {
    for (const rel of ['context-override.md', 'pending-handoffs.json', path.join('files', 'node_modules', 'x.js'), path.join('files', 'build.zip')]) {
      const home = mkHome(); const b = memBucket();
      seedSession(home, b, 's_a');
      const abs = path.join(home, 'sessions', 's_a', rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'local only');
      assert.equal((await verifyCloudCopy(b, 'kx', home, 's_a')).ok, false, rel);
    }
  });
});

describe('idsWithItems：ui-state 里排队 / 未消费 steer 的会话', () => {
  test('有条目的才算；没有这一项 = 空；读不懂 = null（判断不了）', () => {
    assert.deepEqual([...idsWithItems(JSON.stringify({ a: [1], b: [] }))!], ['a']);
    assert.deepEqual([...idsWithItems(undefined)!], []);
    assert.equal(idsWithItems('{bad'), null);
    assert.equal(idsWithItems(JSON.stringify({ a: 'x' })), null);
  });
});

/* 接线：index.ts 不能 import，把源码当文本读 */
describe('接线（index.ts）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  test('每轮同步成功之后跑一次（在云端清理之后、syncFailures 清零之前）；失败路径不跑', () => {
    const start = M.indexOf('async function runS3Sync(');
    const body = M.slice(start, M.indexOf('function rescheduleS3Sync', start));
    const call = body.indexOf('runOffloadRound(creds!, cfg, wrote.catalog)');
    assert.ok(call > body.indexOf('runCloudCleanup('), '要在云端清理之后');
    assert.ok(call < body.indexOf('syncFailures = 0;'), '要在成功路径上');
    assert.ok(call < body.indexOf('} catch (err: any) {\n    const hint'), '不能在失败路径上');
  });
  test('S3 没开 / 设置关掉时整个不跑；本机清单把占位当成仍持有', () => {
    const fn = M.slice(M.indexOf('async function runOffloadRound('), M.indexOf('async function runS3Sync('));
    assert.match(fn.slice(0, 300), /offloadBlocked\(cfg, null\)[\s\S]*if \(blocked\) return null/);
    const man = M.slice(M.indexOf('function thisDeviceManifest('), M.indexOf('function loadSyncConfig('));
    const push = man.indexOf('for (const s of manifestSessionsWithOffloaded([], readOffloadState(OFFLOAD_STATE_PATH))) sessions.push(s);');
    assert.ok(push > 0, '清单没把占位补进去');
    assert.ok(push < man.indexOf('buildDeviceManifest(deviceId, now, sessions, deletions, host)'), '要在建清单之前补');
  });
  test('移的那条路不写删除记录 / 墓碑', () => {
    const fn = M.slice(M.indexOf('async function runOffloadRound('), M.indexOf('async function runS3Sync('));
    assert.doesNotMatch(fn, /noteDeletion|TOMBSTONES_PATH|purgeSession|deletedSessionIds\.add/);
  });
});

/** 暂存目录里还有没有这条的残留 */
const stagingLeft = (home: string): boolean => { try { return fs.readdirSync(offloadStagingRoot(home)).some((n) => n.startsWith('s_a-')); } catch { return false; } };

describe('下载回本机：先暂存，全部成功才发布（中途失败不留半份）', () => {
  /** 先移到云端，返回桶和占位文件 */
  async function offloaded() {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    const stateFile = path.join(home, 'sessions-offloaded.json');
    const r = await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => null });
    assert.equal(r.ok, true, (r as any).why);
    return { home, b, stateFile };
  }

  test('全部下完 → sessions/<id> 整份回来、占位删掉、updatedAt 刷新、暂存目录不留', async () => {
    const { home, b, stateFile } = await offloaded();
    const later = NOW + DAY_MS;
    const r = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: later });
    assert.equal(r.ok, true, (r as any).why);
    assert.equal((r as any).files, 4);
    const dir = path.join(home, 'sessions', 's_a');
    assert.equal(fs.readFileSync(path.join(dir, 'files', 'out.txt'), 'utf-8'), 'x'.repeat(5000));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'record.json'), 'utf-8')).updatedAt, later);
    assert.equal(readOffloadState(stateFile).offloaded['s_a'], undefined);
    assert.equal(stagingLeft(home), false);
  });

  test('record.json 已下载、后面的文件下载失败（网络断了）→ 正式目录不出现、占位保留、暂存清掉；再点一次能成', async () => {
    const { home, b, stateFile } = await offloaded();
    const realGet = b.get.bind(b);
    const got: string[] = [];
    (b as any).get = async (key: string) => {
      got.push(key);
      if (key.endsWith('transcript.jsonl')) throw new Error('socket hang up');
      return realGet(key);
    };
    const r = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW + 1 });
    assert.equal(r.ok, false);
    assert.match((r as any).why, /socket hang up/);
    assert.ok(got.some((k) => k.endsWith('record.json')), '这个用例要的是 record.json 已经下载过');
    assert.equal(fs.existsSync(path.join(home, 'sessions', 's_a')), false, '留下了半份会话');
    assert.ok(readOffloadState(stateFile).offloaded['s_a'], '占位没了');
    assert.equal(stagingLeft(home), false, '暂存目录没清');
    /* 网络好了再试 */
    (b as any).get = realGet;
    const again = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW + 2 });
    assert.equal(again.ok, true, (again as any).why);
    assert.equal(fs.existsSync(path.join(home, 'sessions', 's_a', 'transcript.jsonl')), true);
  });

  test('下到的大小和列出来的对不上 → 失败、不发布', async () => {
    const { home, b, stateFile } = await offloaded();
    const realGet = b.get.bind(b);
    (b as any).get = async (key: string) => (key.endsWith('history.md') ? Buffer.from('#') : realGet(key));
    const r = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(path.join(home, 'sessions', 's_a')), false);
    assert.ok(readOffloadState(stateFile).offloaded['s_a']);
  });

  test('云端已没有 → gone，占位保留；审查拒绝（advanced）→ 不动任何本地文件', async () => {
    const { home, b, stateFile } = await offloaded();
    const r1 = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW, vet: async () => ({ refused: 'advanced' }) });
    assert.deepEqual(r1, { ok: false, why: 'advanced' });
    assert.equal(stagingLeft(home), false);
    for (const k of [...b.data.keys()]) if (k.includes('/sessions/s_a/')) b.data.delete(k);
    const r2 = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW });
    assert.equal(r2.ok, false);
    assert.equal((r2 as any).gone, true);
    assert.ok(readOffloadState(stateFile).offloaded['s_a']);
    assert.equal(fs.existsSync(path.join(home, 'sessions', 's_a')), false);
  });
});

describe('接线：占位下载走暂存实现', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  test('s3:restore 碰到占位就转给 offloadRestoreImpl（在写任何文件之前）；有占位就不许挂载', () => {
    const h = M.slice(M.indexOf("ipcMain.handle('s3:restore'"));
    const redirect = h.indexOf('if (isOffloadedPlaceholder(sessionId)) return offloadRestoreImpl(sessionId);');
    assert.ok(redirect > 0 && redirect < h.indexOf('listObjects('), '要在动本地文件之前');
    const fn = M.slice(M.indexOf('function isOffloadedPlaceholder('), M.indexOf('async function offloadRestoreImpl('));
    /* 占位文件读得了：只看占位（半份目录不会让它消失）；只有占位文件坏了才退回看本机有没有记录 */
    assert.ok(fn.includes('return !!st.offloaded[id];'), '占位是否还在要只看占位');
    assert.ok(fn.indexOf('existsSync') < 0 || fn.indexOf('existsSync') < fn.indexOf('return !!st.offloaded[id];') && fn.slice(0, fn.indexOf('existsSync')).includes('if (!st)'), '看本机目录只能在占位文件读不了的那一支');
    const impl = M.slice(M.indexOf('async function offloadRestoreImpl('), M.indexOf('async function runOffloadRound('));
    assert.match(impl, /restoreOffloadedSession\(/);
    assert.match(impl, /refuseAdvancedBackup\(/);
  });
});

describe('下载回本机：正式目录已经在 / 并发', () => {
  async function offloaded() {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    const stateFile = path.join(home, 'sessions-offloaded.json');
    const r = await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => null });
    assert.equal(r.ok, true, (r as any).why);
    return { home, b, stateFile };
  }
  const dir = (home: string) => path.join(home, 'sessions', 's_a');

  test('只有 record.json、transcript / files 缺失的旧半份目录 → 不当成已恢复：挪进回收站（不删），从云端整份重下', async () => {
    const { home, b, stateFile } = await offloaded();
    fs.mkdirSync(dir(home), { recursive: true });
    fs.writeFileSync(path.join(dir(home), 'record.json'), JSON.stringify({ id: 's_a', title: 'half', updatedAt: 1 }));
    let listed = 0;
    const realList = b.list.bind(b);
    (b as any).list = async (p: string) => { listed += 1; return realList(p); };
    const r = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW + 5 });
    assert.equal(r.ok, true, (r as any).why);
    assert.ok(listed > 0, '没访问云端就当成恢复好了');
    assert.equal(fs.readFileSync(path.join(dir(home), 'files', 'out.txt'), 'utf-8'), 'x'.repeat(5000));
    assert.ok(fs.existsSync(path.join(dir(home), 'transcript.jsonl')));
    assert.equal(fs.existsSync(path.join(dir(home), RESTORE_COMPLETE_MARK)), false, '收尾没删完整凭据');
    const aside = (r as any).setAside as string;
    assert.equal(JSON.parse(fs.readFileSync(path.join(aside, 'record.json'), 'utf-8')).title, 'half', '旧半份没留在回收站里');
    assert.equal(readOffloadState(stateFile).offloaded['s_a'], undefined);
  });

  test('旧半份目录 + 这次下载又失败 → 占位保留、正式目录不出现、旧半份还在回收站', async () => {
    const { home, b, stateFile } = await offloaded();
    fs.mkdirSync(dir(home), { recursive: true });
    fs.writeFileSync(path.join(dir(home), 'record.json'), JSON.stringify({ id: 's_a', title: 'half' }));
    const realGet = b.get.bind(b);
    (b as any).get = async (key: string) => { if (key.endsWith('out.txt')) throw new Error('ECONNRESET'); return realGet(key); };
    const r = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW + 5 });
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(dir(home)), false);
    assert.ok(readOffloadState(stateFile).offloaded['s_a']);
    const trashNames = fs.readdirSync(path.join(home, 'trash'));
    assert.ok(trashNames.some((n) => n.startsWith('offload-incomplete-')), '旧半份被删了');
  });

  test('有完整凭据、文件对得上（上次发布完、收尾前中断）→ 只补收尾；凭据列的文件少了一个 → 不认', async () => {
    const { home, b, stateFile } = await offloaded();
    const first = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW + 1 });
    assert.equal(first.ok, true);
    /* 模拟收尾前中断：凭据还在、占位还在 */
    const files = [{ rel: 'record.json', size: fs.statSync(path.join(dir(home), 'record.json')).size }, { rel: path.join('files', 'out.txt'), size: 5000 }];
    fs.writeFileSync(path.join(dir(home), RESTORE_COMPLETE_MARK), JSON.stringify({ files }));
    const st = readOffloadState(stateFile);
    st.offloaded['s_a'] = { id: 's_a', title: 't', lastActiveAt: OLD, offloadedAt: NOW, cloudKey: 'kx/v1/sessions/s_a/', bytes: 1, files: 1 };
    writeOffloadState(stateFile, st);
    let gets = 0;
    const realGet = b.get.bind(b);
    (b as any).get = async (k: string) => { gets += 1; return realGet(k); };
    const r = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW + 2 });
    assert.equal(r.ok, true);
    assert.equal((r as any).alreadyLocal, true);
    assert.equal(gets, 0);
    assert.equal(readOffloadState(stateFile).offloaded['s_a'], undefined);
    /* 凭据说有 out.txt，但它没了 → 不认，挪开重下 */
    fs.writeFileSync(path.join(dir(home), RESTORE_COMPLETE_MARK), JSON.stringify({ files }));
    fs.rmSync(path.join(dir(home), 'files', 'out.txt'));
    st.offloaded['s_a'] = { id: 's_a', title: 't', lastActiveAt: OLD, offloadedAt: NOW, cloudKey: 'kx/v1/sessions/s_a/', bytes: 1, files: 1 };
    writeOffloadState(stateFile, st);
    const r2 = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW + 3 });
    assert.equal(r2.ok, true);
    assert.ok(!(r2 as any).alreadyLocal);
    assert.ok(fs.existsSync(path.join(dir(home), 'files', 'out.txt')));
  });

  test('同一条同时来两次（侧栏点开 + 备份页恢复）→ 共用一次下载，结果完整', async () => {
    const { home, b, stateFile } = await offloaded();
    let gets = 0;
    const realGet = b.get.bind(b);
    (b as any).get = async (k: string) => { gets += 1; await new Promise((r) => setTimeout(r, 5)); return realGet(k); };
    const [r1, r2] = await Promise.all([
      restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW + 1 }),
      restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW + 2 }),
    ]);
    assert.equal(r1.ok, true, (r1 as any).why);
    assert.deepEqual(r2, r1);
    assert.equal(gets, 4, '下载了不止一遍');
    for (const f of ['record.json', 'transcript.jsonl', 'history.md', path.join('files', 'out.txt')]) assert.ok(fs.existsSync(path.join(dir(home), f)), f);
    assert.equal(stagingLeft(home), false);
  });
});

describe('移走之前整份重判一遍', () => {
  const run = async (mutate: (home: string) => void, refacts: (home: string) => OffloadFacts | null, duringList?: (home: string) => void) => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    mutate(home);
    if (duringList) {
      const realList = b.list.bind(b);
      (b as any).list = async (p: string) => { duringList(home); return realList(p); };
    }
    const stateFile = path.join(home, 'sessions-offloaded.json');
    const r = await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => null, refacts: () => refacts(home), idleDays: 30 });
    return { r, home, stateFile };
  };
  const stays = (x: { r: any; home: string; stateFile: string }) => {
    assert.equal(x.r.ok, false);
    assert.ok(fs.existsSync(path.join(x.home, 'sessions', 's_a', 'record.json')), '被移走了');
    assert.deepEqual(readOffloadState(x.stateFile).offloaded, {});
  };
  test('核对期间打上「保留在本机」→ 不移', async () => stays(await run(() => {}, () => base({ id: 's_a', keepLocal: true }))));
  test('核对期间被置顶 → 不移', async () => stays(await run(() => {}, () => base({ id: 's_a', pinned: true }))));
  test('核对期间挂上定时任务 → 不移', async () => stays(await run(() => {}, () => base({ id: 's_a', scheduled: true }))));
  test('重判算不出来（null）→ 不移', async () => stays(await run(() => {}, () => null)));
  test('核对期间本机文件被改了 → 不移', async () => {
    stays(await run(() => {}, () => base({ id: 's_a' }), (home) => {
      fs.appendFileSync(path.join(home, 'sessions', 's_a', 'files', 'out.txt'), 'more');
    }));
  });
  test('什么都没变 → 照常移', async () => {
    const x = await run(() => {}, () => base({ id: 's_a' }));
    assert.equal(x.r.ok, true, x.r.why);
  });
});

describe('接线：移走前整份重判', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  test('runOffloadRound 给 offloadSession 传 refacts（按同一套事实重算）和天数', () => {
    const fn = M.slice(M.indexOf('async function runOffloadRound('), M.indexOf('async function runS3Sync('));
    assert.ok(fn.includes('refacts: () => factsNow(p.id)[0] ?? null'), '移走前没按同一套事实重判');
    assert.ok(fn.includes('idleDays: () => offloadSettings(loadSyncConfig()).days'), '重判的天数没按最新设置现读');
  });
});

describe('核对双方文件集合：云上多出来的也不移', () => {
  test('本机删掉了一个已上传的 files/old.txt，云上还留着 → 不移（恢复会把它带回来）', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    b.data.set(keyFor('kx', path.join('sessions', 's_a', 'files', 'old.txt')), Buffer.from('old'));
    const v = await verifyCloudCopy(b, 'kx', home, 's_a');
    assert.equal(v.ok, false);
    assert.match((v as any).why, /old.txt/);
    const stateFile = path.join(home, 'sessions-offloaded.json');
    const r = await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => null });
    assert.equal(r.ok, false);
    assert.ok(fs.existsSync(path.join(home, 'sessions', 's_a', 'record.json')));
  });
  test('只在本机的调试文件（events.jsonl）照旧不挡；别的会话的对象不算多出来', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    seedSession(home, b, 's_ab');
    fs.writeFileSync(path.join(home, 'sessions', 's_a', 'events.jsonl'), '{}');
    assert.equal((await verifyCloudCopy(b, 'kx', home, 's_a')).ok, true);
  });
});

describe('判定用的严格读取：读不了 / 坏了 = 判断不了', () => {
  const sched = (sessionId: string, terminal: string | null = null) => JSON.stringify({ id: 'j', state: { sessionId, terminal, spec: {}, runs: 0 } });
  test('定时任务目录：不存在 = 空；有效记录列出会话（结束了的不算）；坏 JSON / 形状不对 = null', () => {
    const home = mkHome();
    const dir = path.join(home, 'schedules');
    assert.deepEqual([...strictSessionRefs(dir, scheduleRefs)!], []);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.json'), sched('s_a'));
    fs.writeFileSync(path.join(dir, 'b.json'), sched('s_b', 'done'));
    fs.writeFileSync(path.join(dir, 'c.json.tmp'), '{half');
    assert.deepEqual([...strictSessionRefs(dir, scheduleRefs)!], ['s_a']);
    fs.writeFileSync(path.join(dir, 'd.json'), '{"id":"j","sta');
    assert.equal(strictSessionRefs(dir, scheduleRefs), null, '坏记录被当成没有');
    fs.writeFileSync(path.join(dir, 'd.json'), '{"id":"j"}');
    assert.equal(strictSessionRefs(dir, scheduleRefs), null, '形状不对被当成没有');
  });
  test('目录本身读不了（是个文件）= null', () => {
    const home = mkHome();
    const notDir = path.join(home, 'loop-runs');
    fs.writeFileSync(notDir, 'x');
    assert.equal(strictSessionRefs(notDir, loopRefs), null);
  });
  test('循环记录：自己 + 触发它的那条会话；结束了的不算', () => {
    const home = mkHome();
    const dir = path.join(home, 'loop-runs');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 's_a.json'), JSON.stringify({ run: { sessionId: 's_a', terminal: null, spec: { trigger: { kind: 'turn-end', sessionId: 's_t' } } } }));
    fs.writeFileSync(path.join(dir, 's_b.json'), JSON.stringify({ run: { sessionId: 's_b', terminal: 'stopped', spec: {} } }));
    assert.deepEqual([...strictSessionRefs(dir, loopRefs)!].sort(), ['s_a', 's_t']);
  });
  test('占位文件坏了：移走那一步不覆盖它（目录放回原处）', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    const stateFile = path.join(home, 'sessions-offloaded.json');
    fs.writeFileSync(stateFile, '{"keepLocal":["s_x"');
    const r = await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => null });
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(stateFile, 'utf-8'), '{"keepLocal":["s_x"', '坏了的名单被覆盖了');
    assert.ok(fs.existsSync(path.join(home, 'sessions', 's_a', 'record.json')), '目录没放回来');
  });
  test('占位文件坏了：清单仍按回收站里的 offload-<时间>/<id> 报成本机持有', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    const stateFile = path.join(home, 'sessions-offloaded.json');
    assert.equal((await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => null })).ok, true);
    fs.writeFileSync(stateFile, 'garbage');
    assert.deepEqual(offloadedIdsInTrash(path.join(home, 'trash')), ['s_a']);
  });
});

describe('接线：判定读的是严格结果', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  const fn = M.slice(M.indexOf('async function runOffloadRound('), M.indexOf('async function runS3Sync('));
  test('定时 / 循环 / 占位都走严格读；占位文件读不了整轮不移', () => {
    assert.ok(fn.includes('strictSessionRefs(scheduleStore.scheduleDir(os.homedir()), scheduleRefs)'));
    assert.ok(fn.includes("strictSessionRefs(path.join(os.homedir(), '.kirolex', 'loop-runs'), loopRefs)"));
    for (const bad of ['listSchedules(', 'listLiveLoops(', 'readOffloadState(']) assert.ok(!fn.includes(bad), `判定还在用宽松读取 ${bad}`);
    const guard = fn.indexOf('if (!readOffloadStateStrict(OFFLOAD_STATE_PATH)) {');
    assert.ok(guard > 0 && fn.slice(guard, guard + 300).includes('return null;'), '占位文件读不了没有整轮停下');
  });
  test('清单也报回收站里已移走的 id', () => {
    const man = M.slice(M.indexOf('function thisDeviceManifest('), M.indexOf('function loadSyncConfig('));
    assert.ok(man.includes('offloadedIdsInTrash(SESSION_TRASH_DIR)'));
  });
});

describe('占位名单：合法 JSON 但里面有坏条目 = 判断不了，不覆盖', () => {
  const good = { id: 's_a', title: 't', lastActiveAt: 1, offloadedAt: 2, cloudKey: 'kx/v1/sessions/s_a/', bytes: 1, files: 1 };
  for (const [what, body] of [
    ['占位是 null', { offloaded: { s_a: null }, keepLocal: [] }],
    ['占位缺云端位置', { offloaded: { s_a: { ...good, cloudKey: undefined } }, keepLocal: [] }],
    ['占位时间不是数字', { offloaded: { s_a: { ...good, offloadedAt: 'x' } }, keepLocal: [] }],
    ['占位 id 形状不对', { offloaded: { '../x': good }, keepLocal: [] }],
    ['keepLocal 里有数字', { offloaded: { s_a: good }, keepLocal: [123] }],
    ['keepLocal 里有坏 id', { offloaded: {}, keepLocal: ['s_ok', 'a/b'] }],
  ] as const) {
    test(`${what} → 严格读 null；打保留标记不写；移走不写、目录放回`, async () => {
      const home = mkHome(); const b = memBucket();
      seedSession(home, b, 's_b');
      const f = path.join(home, 'sessions-offloaded.json');
      const raw = JSON.stringify(body);
      fs.writeFileSync(f, raw);
      assert.equal(readOffloadStateStrict(f), null);
      assert.equal(setKeepLocal(f, 's_b', true), false);
      const r = await offloadSession(b, { prefix: 'kx', home, id: 's_b', stateFile: f, now: NOW, lastActiveAt: OLD, recheck: () => null });
      assert.equal(r.ok, false);
      assert.equal(fs.readFileSync(f, 'utf-8'), raw, '名单被覆盖了');
      assert.ok(fs.existsSync(path.join(home, 'sessions', 's_b', 'record.json')));
    });
  }
  test('全部条目都合法 → 照常读出来', () => {
    const home = mkHome();
    const f = path.join(home, 'sessions-offloaded.json');
    fs.writeFileSync(f, JSON.stringify({ offloaded: { s_a: good }, keepLocal: ['s_k'] }));
    const st = readOffloadStateStrict(f)!;
    assert.equal(st.offloaded['s_a'].cloudKey, 'kx/v1/sessions/s_a/');
    assert.deepEqual(st.keepLocal, ['s_k']);
  });
});

describe('移走之后改了 Key 前缀：旧占位按原来的云端位置恢复', () => {
  test('同一个桶，前缀从 kx 改成 newpfx → 仍从 kx/v1/sessions/<id>/ 下载回来', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a', 'kx');
    const stateFile = path.join(home, 'sessions-offloaded.json');
    const off = await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => null });
    assert.equal(off.ok, true, (off as any).why);
    assert.equal(readOffloadState(stateFile).offloaded['s_a'].cloudKey, 'kx/v1/sessions/s_a/');
    /* 之后设置里的前缀改成了 newpfx（新前缀下什么都没有）*/
    const listed: string[] = [];
    const realList = b.list.bind(b);
    (b as any).list = async (p: string) => { listed.push(p); return realList(p); };
    let vettedAt = '';
    const r = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW + 1, vet: async (_o, key) => { vettedAt = key; return { get: (k) => b.get(k) }; } });
    assert.equal(r.ok, true, (r as any).why);
    assert.ok(listed.every((p) => p === 'kx/v1/sessions/s_a/'), `按别的位置找了：${listed.join(', ')}`);
    assert.equal(vettedAt, 'kx/v1/sessions/s_a/');
    assert.equal(fs.readFileSync(path.join(home, 'sessions', 's_a', 'files', 'out.txt'), 'utf-8'), 'x'.repeat(5000));
  });
  test('没有前缀（桶根）也认得；云端位置形状不对 → 不猜、不动', async () => {
    assert.equal(prefixFromCloudKey('v1/sessions/s_a/', 's_a'), '');
    assert.equal(prefixFromCloudKey('a/b/v1/sessions/s_a/', 's_a'), 'a/b');
    assert.equal(prefixFromCloudKey('kx/v1/sessions/s_b/', 's_a'), null);
    assert.equal(prefixFromCloudKey('kxv1/sessions/s_a/', 's_a'), null);
    const home = mkHome(); const b = memBucket();
    const stateFile = path.join(home, 'sessions-offloaded.json');
    writeOffloadState(stateFile, { version: 1, offloaded: { s_a: { id: 's_a', title: 't', lastActiveAt: 1, offloadedAt: 2, cloudKey: 'weird', bytes: 1, files: 1 } }, keepLocal: [] });
    const r = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW });
    assert.equal(r.ok, false);
    assert.ok(readOffloadState(stateFile).offloaded['s_a']);
  });
});

describe('接线：恢复按占位的云端位置审', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  test('offloadRestoreImpl 不再用现在的前缀拼位置', () => {
    const impl = M.slice(M.indexOf('async function offloadRestoreImpl('), M.indexOf('async function runOffloadRound('));
    assert.ok(impl.includes('vet: async (objects, cloudKey) => refuseAdvancedBackup(creds!, cloudKey, objects, id)'));
    assert.ok(!impl.includes('cfg.prefix'));
  });
});

describe('归档的会话：移走前后都在「已归档」里', () => {
  test('占位记下归档；侧栏行带 archived；下载回来记录仍是归档', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    /* 种成归档的（同时传进假桶，保持两边一致） */
    const recPath = path.join(home, 'sessions', 's_a', 'record.json');
    fs.writeFileSync(recPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(recPath, 'utf-8')), archived: true }, null, 2));
    b.data.set(keyFor('kx', path.join('sessions', 's_a', 'record.json')), fs.readFileSync(recPath));
    const stateFile = path.join(home, 'sessions-offloaded.json');
    const r = await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => null });
    assert.equal(r.ok, true, (r as any).why);
    const p = readOffloadStateStrict(stateFile)!.offloaded['s_a'];
    assert.equal(p.archived, true);
    const { placeholderRows } = await import('../src/renderer/offloadView.ts');
    assert.equal(placeholderRows([p], [])[0].archived, true, '侧栏会把它当成普通会话');
    const back = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW + 1 });
    assert.equal(back.ok, true, (back as any).why);
    assert.equal(JSON.parse(fs.readFileSync(recPath, 'utf-8')).archived, true);
  });
  test('没归档的：占位不带 archived（侧栏按原项目分组）', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    const stateFile = path.join(home, 'sessions-offloaded.json');
    assert.equal((await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => null })).ok, true);
    assert.equal(readOffloadStateStrict(stateFile)!.offloaded['s_a'].archived, undefined);
  });
  test('占位里 archived 不是布尔 → 名单当判断不了', () => {
    const home = mkHome();
    const f = path.join(home, 'sessions-offloaded.json');
    fs.writeFileSync(f, JSON.stringify({ offloaded: { s_a: { id: 's_a', title: 't', lastActiveAt: 1, offloadedAt: 2, cloudKey: 'kx/v1/sessions/s_a/', archived: 'yes' } }, keepLocal: [] }));
    assert.equal(readOffloadStateStrict(f), null);
  });
});

describe('核对期间调高天数门槛 → 按新的判', () => {
  test('45 天没用：核对期间从 30 天改成 180 天 → 不移；关掉（0）→ 不移；没变 → 移', async () => {
    for (const [days, moved] of [[180, false], [0, false], [30, true]] as const) {
      const home = mkHome(); const b = memBucket();
      seedSession(home, b, 's_a');
      let current = 30;
      const realList = b.list.bind(b);
      (b as any).list = async (p: string) => { current = days; return realList(p); };   // 核对进行中改了设置
      const stateFile = path.join(home, 'sessions-offloaded.json');
      const r = await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => null,
        refacts: () => base({ id: 's_a' }), idleDays: () => current });
      assert.equal(r.ok, moved, `改成 ${days} 天：${(r as any).why || ''}`);
      assert.equal(fs.existsSync(path.join(home, 'sessions', 's_a', 'record.json')), !moved);
    }
  });
});

describe('移走的会话引用的粘贴 / 附件：启动清理不删，恢复后还在', () => {
  /** 和 index.ts 启动时的粘贴垃圾清理同一个算法：sessions/ 下剩下的 transcript + 占位记下的引用；判断不了就不删 */
  function bootPasteGc(home: string, stateFile: string, now: number): number {
    const extra = offloadedPasteRefs(stateFile);
    if (!extra) return -1;
    const referenced = new Set<string>(extra);
    for (const id of fs.existsSync(path.join(home, 'sessions')) ? fs.readdirSync(path.join(home, 'sessions')) : []) {
      for (const r of transcriptExternalRefs(path.join(home, 'sessions', id, 'transcript.jsonl')) || []) referenced.add(r);
    }
    let removed = 0;
    for (const d of ['pasted', 'pastes'].map((x) => path.join(home, x))) {
      for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) {
        const full = path.resolve(path.join(d, f));
        if (referenced.has(full) || now - fs.statSync(full).mtimeMs < 24 * 3600_000) continue;
        fs.unlinkSync(full); removed += 1;
      }
    }
    return removed;
  }

  test('移走 → 启动清理（只删真孤儿）→ 恢复后图片和文本都能读', async () => {
    const home = mkHome(); const b = memBucket();
    const img = path.join(home, 'pasted', 'shot.png');
    const txt = path.join(home, 'pastes', 'long.txt');
    const orphan = path.join(home, 'pastes', 'orphan.txt');
    for (const [f, body] of [[img, 'PNG'], [txt, '很长的粘贴文本'], [orphan, 'nobody']] as const) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
      const old = new Date(NOW - 40 * DAY_MS); fs.utimesSync(f, old, old);   // 早过了 24 小时宽限
    }
    seedSession(home, b, 's_a');
    /* transcript 里有一条带图片附件和粘贴的消息（同时传进假桶，保持一致） */
    const tPath = path.join(home, 'sessions', 's_a', 'transcript.jsonl');
    fs.appendFileSync(tPath, JSON.stringify({ id: 'm2', role: 'user', content: 'see', ts: OLD - 4000, attachments: [{ name: 'shot.png', path: img, isImage: true }], pastes: [{ id: 'p1', path: txt }] }) + '\n');
    b.data.set(keyFor('kx', path.join('sessions', 's_a', 'transcript.jsonl')), fs.readFileSync(tPath));
    const stateFile = path.join(home, 'sessions-offloaded.json');
    const r = await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => null });
    assert.equal(r.ok, true, (r as any).why);
    assert.deepEqual(readOffloadStateStrict(stateFile)!.offloaded['s_a'].externalRefs!.sort(), [path.resolve(img), path.resolve(txt)].sort());
    /* 下次启动：粘贴垃圾清理 */
    assert.equal(bootPasteGc(home, stateFile, NOW + DAY_MS), 1, '只该删掉真正的孤儿');
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.readFileSync(img, 'utf-8'), 'PNG');
    assert.equal(fs.readFileSync(txt, 'utf-8'), '很长的粘贴文本');
    /* 恢复：卡片引用的文件都还在 */
    const back = await restoreOffloadedSession(b, { home, id: 's_a', stateFile, now: NOW + 2 * DAY_MS });
    assert.equal(back.ok, true, (back as any).why);
    const refs = transcriptExternalRefs(tPath)!;
    assert.equal(refs.length, 2);
    for (const f of refs) assert.ok(fs.existsSync(f), `恢复后 ${f} 不见了`);
    assert.equal(fs.readFileSync(txt, 'utf-8'), '很长的粘贴文本');
    /* 恢复之后占位没了，引用由 sessions/ 下的 transcript 接着护着 */
    assert.equal(bootPasteGc(home, stateFile, NOW + 3 * DAY_MS), 0);
    assert.ok(fs.existsSync(img) && fs.existsSync(txt));
  });

  test('占位文件坏了 → 这次清理一个都不删', () => {
    const home = mkHome();
    const stateFile = path.join(home, 'sessions-offloaded.json');
    fs.writeFileSync(stateFile, '{bad');
    assert.equal(offloadedPasteRefs(stateFile), null);
    assert.equal(bootPasteGc(home, stateFile, NOW), -1);
  });

  test('transcript 有一行读不懂 → 判断不了它引用了什么 → 不移', async () => {
    const home = mkHome(); const b = memBucket();
    seedSession(home, b, 's_a');
    const tPath = path.join(home, 'sessions', 's_a', 'transcript.jsonl');
    fs.appendFileSync(tPath, '{"id":"m2","pastes":[{"path":\n');
    b.data.set(keyFor('kx', path.join('sessions', 's_a', 'transcript.jsonl')), fs.readFileSync(tPath));
    assert.equal(transcriptExternalRefs(tPath), null);
    const stateFile = path.join(home, 'sessions-offloaded.json');
    const r = await offloadSession(b, { prefix: 'kx', home, id: 's_a', stateFile, now: NOW, lastActiveAt: OLD, recheck: () => null });
    assert.equal(r.ok, false);
    assert.ok(fs.existsSync(tPath));
  });

  test('占位里 externalRefs 形状不对 → 名单当判断不了', () => {
    const home = mkHome();
    const f = path.join(home, 'sessions-offloaded.json');
    fs.writeFileSync(f, JSON.stringify({ offloaded: { s_a: { id: 's_a', title: 't', lastActiveAt: 1, offloadedAt: 2, cloudKey: 'kx/v1/sessions/s_a/', externalRefs: [1] } }, keepLocal: [] }));
    assert.equal(readOffloadStateStrict(f), null);
  });

  test('接线：启动的粘贴清理把占位的引用算进去，读不了就不清', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
    const at = M.indexOf('// GC of pasted blobs');
    const gc = M.slice(at, at + 4000);
    assert.ok(gc.includes('const offloadedRefs = offloadedPasteRefs(OFFLOAD_STATE_PATH);'));
    assert.ok(gc.includes('if (dirs.length && offloadedRefs) {'));
    assert.ok(gc.includes('for (const r of offloadedRefs) referenced.add(r);'));
  });
});
