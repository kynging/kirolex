import assert from 'node:assert/strict';
import { describe, test, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bucketMergeVerdict, planBucketMerges, noteBucketSeen, readBucketSeen, writeBucketSeen, clearRemotePlaceholders, isRemotePlaceholder,
  isShared, crossDeviceToFollow, placeholderPlacement, withCrossDeviceOn,
  runBucketMerge, type BucketMergeIO, type BucketSeen,
} from '../src/main/s3Pull.ts';
import { readOffloadState, writeOffloadState, type OffloadPlaceholder } from '../src/main/sessionOffload.ts';
import { buildDeviceManifest, decideCleanup, withDeviceManifest, DAY_MS } from '../src/main/cloudTrash.ts';
import { mergeCatalog, type Catalog, type CatalogEntry } from '../src/main/s3Sync.ts';

/*
 * 「S3 同步：自动把别的电脑上的新会话和新消息拉回本机」。
 * 守的几件事：别的电脑上的新会话在本机出现占位（不下载）；本机已有的会话按「桶里真的上传的时刻」判要不要合并，
 * 不再看会被状态记账刷新的 updatedAt；并进 0 条就记下、下一轮不再合 —— 两台机器不在同一条上来回合并；
 * 别的电脑删了 → 外来占位跟着去掉；外来占位不算本机持有（否则云端回收站永远等不到）。
 */

const A = 'aaaaaa-mac';
const B = 'bb0f24-b0be83784d7d';
const NOW = Date.parse('2026-11-12T00:00:00Z');

/* 缺省是开了「在其他电脑上同步」的条目（下面大部分用例讲的是开着的会话）；没开的单独测 */
const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 's_1', title: 'T', updatedAt: NOW - 1000, bytes: 10, from: B, syncedAt: NOW - 500, uploadedAt: NOW - 600, crossDevice: true, crossDeviceChangedAt: NOW - 2000, ...over,
});
const cat = (entries: CatalogEntry[], extra: Partial<Catalog> = {}): Catalog => ({ version: 1, entries, ...extra });

const tmps: string[] = [];
const mkHome = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-s3pull-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('(1) 只合并开了「在其他电脑上同步」的会话；任一台开了就算开', () => {
  const plain = { crossDevice: undefined, crossDeviceChangedAt: undefined };
  test('两边都没开 → 不合并（只备份）', () => {
    assert.deepEqual(planBucketMerges(cat([entry(plain)]), ['s_1'], A, {}), []);
  });
  test('桶里那条开着（另一台开的）→ 合并；本机这条开着、桶里那条还没开 → 也合并', () => {
    assert.deepEqual(planBucketMerges(cat([entry()]), ['s_1'], A, {}).map((x) => x.id), ['s_1']);
    assert.deepEqual(planBucketMerges(cat([entry(plain)]), ['s_1'], A, {}, NOW, new Map([['s_1', { crossDevice: true, crossDeviceChangedAt: 5 }]])).map((x) => x.id), ['s_1']);
  });
  test('谁后改听谁：本机后关（20）、桶里还是旧的开（10）→ 不合并；桶里后开（30）、本机旧的关（20）→ 合并', () => {
    const off = new Map([['s_1', { crossDeviceChangedAt: 20 }]]);
    assert.deepEqual(planBucketMerges(cat([entry({ crossDeviceChangedAt: 10 })]), ['s_1'], A, {}, NOW, off), []);
    assert.deepEqual(planBucketMerges(cat([entry({ crossDeviceChangedAt: 30 })]), ['s_1'], A, {}, NOW, off).map((x) => x.id), ['s_1']);
    /* 本机开着（20）、桶里后关（30）→ 不合并 */
    assert.deepEqual(planBucketMerges(cat([entry({ crossDevice: undefined, crossDeviceChangedAt: 30 })]), ['s_1'], A, {}, NOW, new Map([['s_1', { crossDevice: true, crossDeviceChangedAt: 20 }]])), []);
  });
  test('开关跟随：桶里改得更晚 → 跟（开 / 关都跟）；一样新或更早 → 不跟；老条目没有时间 → 不跟', () => {
    assert.deepEqual(crossDeviceToFollow({ crossDeviceChangedAt: 5 }, { crossDevice: true, crossDeviceChangedAt: 9 }), { crossDevice: true, crossDeviceChangedAt: 9 });
    assert.deepEqual(crossDeviceToFollow({ crossDevice: true, crossDeviceChangedAt: 5 }, { crossDeviceChangedAt: 9 }), { crossDevice: false, crossDeviceChangedAt: 9 });
    assert.equal(crossDeviceToFollow({ crossDevice: true, crossDeviceChangedAt: 9 }, { crossDeviceChangedAt: 9 }), null);
    assert.equal(crossDeviceToFollow({ crossDevice: true, crossDeviceChangedAt: 9 }, { crossDevice: false }), null);
  });
  test('合并记录：开关按自己的改动时刻谁新用谁（不跟 updatedAt）；一样新时开着的赢', async () => {
    const { mergeRecords } = await import('../src/main/transcriptMerge.ts');
    const local = { id: 's', updatedAt: 100, crossDevice: true, crossDeviceChangedAt: 50 };
    const remote = { id: 's', updatedAt: 200, crossDeviceChangedAt: 10 };
    assert.equal(mergeRecords(local, remote).crossDevice, true, '本机后开的，对方后聊一句也不能把它关掉');
    assert.equal(mergeRecords({ ...local, crossDeviceChangedAt: 5 }, remote).crossDevice, undefined, '对方后关的就关');
    assert.equal(mergeRecords({ id: 's', updatedAt: 300, crossDeviceChangedAt: 10 }, { ...remote, crossDevice: true }).crossDevice, true);
  });
});

describe('(b) 本机已有的会话：按桶里真的上传的时刻判要不要合并', () => {
  test('本机 updatedAt 被状态记账刷成现在，桶里 uploadedAt 更新 → 仍判出要合并', () => {
    const seen: BucketSeen = { s_1: { [B]: NOW - 5000 } };
    /* 判据里根本没有本机的 updatedAt：桶里那条 updatedAt 再旧也照样合 */
    const e = entry({ updatedAt: 1, uploadedAt: NOW - 600 });
    assert.deepEqual(bucketMergeVerdict(e, A, seen), { merge: true });
    assert.deepEqual(planBucketMerges(cat([e]), ['s_1'], A, seen).map((x) => x.id), ['s_1']);
  });

  test('合并过同一份（uploadedAt 没变）→ 不合；自己传的 / 没来源 → 不合；本机没有的不在这里', () => {
    const seen: BucketSeen = { s_1: { [B]: NOW - 600 } };
    assert.deepEqual(bucketMergeVerdict(entry(), A, seen), { merge: false, reason: 'seen' });
    assert.deepEqual(bucketMergeVerdict(entry({ from: A }), A, {}), { merge: false, reason: 'own' });
    assert.deepEqual(bucketMergeVerdict(entry({ from: undefined }), A, {}), { merge: false, reason: 'no-source' });
    assert.deepEqual(planBucketMerges(cat([entry()]), ['s_other'], A, {}), []);
  });

  test('按来源设备分开记：另一台设备的 uploadedAt 不拿来和这台的比（时钟不同）', () => {
    const seen: BucketSeen = { s_1: { [B]: NOW } };
    assert.deepEqual(bucketMergeVerdict(entry({ from: 'cccccc-pc', uploadedAt: 5 }), A, seen), { merge: true });
  });

  test('删除记录比条目新 → 不合并', () => {
    assert.deepEqual(planBucketMerges(cat([entry()], { deleted: [{ id: 's_1', at: NOW }] }), ['s_1'], A, {}), []);
  });

  test('记下的表：只往大里记，读写回环；坏文件当空', () => {
    const home = mkHome();
    const f = path.join(home, 's3-bucket-seen.json');
    const seen: BucketSeen = {};
    noteBucketSeen(seen, 's_1', { from: B, uploadedAt: 10 });
    noteBucketSeen(seen, 's_1', { from: B, uploadedAt: 5 });
    assert.equal(seen.s_1[B], 10);
    writeBucketSeen(f, seen);
    assert.deepEqual(readBucketSeen(f), { s_1: { [B]: 10 } });
    fs.writeFileSync(f, 'nope');
    assert.deepEqual(readBucketSeen(f), {});
  });
});

/*
 * (c) A/B 交替同步：照 index.ts runS3Sync 的形状模拟两台机器 ——
 * 读 catalog → 按 planBucketMerges 合并（并集；并进 0 条且没拉文件 = 不动本机、只记下）→ 本机变了才上传 →
 * 把所有本机会话的条目写成「来自自己」（uploadedAt = 本机上次真传的时刻，和 entryUploadedAt 一样）。
 */
interface Machine { tag: string; clock: number; msgs: Map<string, Set<string>>; dirty: Set<string>; lastUpload: Map<string, number>; seen: BucketSeen; merges: number; noopMerges: number; detaches: number }
const machine = (tag: string, clock: number): Machine => ({ tag, clock, msgs: new Map(), dirty: new Set(), lastUpload: new Map(), seen: {}, merges: 0, noopMerges: 0, detaches: 0 });
function round(m: Machine, bucket: { catalog: Catalog; transcripts: Map<string, Set<string>> }): void {
  m.clock += 1000;
  for (const e of planBucketMerges(bucket.catalog, m.msgs.keys(), m.tag, m.seen, m.clock)) {
    const mine = m.msgs.get(e.id)!;
    const theirs = bucket.transcripts.get(e.id) || new Set<string>();
    const add = [...theirs].filter((x) => !mine.has(x));
    noteBucketSeen(m.seen, e.id, e);
    if (!add.length) { m.noopMerges += 1; continue; }     // 并进 0 条：不 detach、不重传、不改本机
    m.detaches += 1;
    for (const x of add) mine.add(x);
    m.dirty.add(e.id);
    m.merges += 1;
  }
  for (const id of m.dirty) { bucket.transcripts.set(id, new Set(m.msgs.get(id))); m.lastUpload.set(id, m.clock); }
  m.dirty.clear();
  const fresh: CatalogEntry[] = [...m.msgs.keys()].map((id) => entry({ id, from: m.tag, updatedAt: m.clock, syncedAt: m.clock, uploadedAt: m.lastUpload.get(id) }));
  bucket.catalog = mergeCatalog(bucket.catalog, fresh);
}

describe('(c) 并进 0 条 → 不动本机、下一轮不再合；A/B 交替同步收敛', () => {
  test('两边已经一样：第一轮各合一次（0 条），之后再也不合', () => {
    const bucket = { catalog: cat([]), transcripts: new Map<string, Set<string>>() };
    const a = machine(A, NOW); const b = machine(B, NOW + 7 * 3600_000);   // 两台的时钟差 7 小时
    for (const m of [a, b]) m.msgs.set('s_x', new Set(['m1', 'm2']));
    a.dirty.add('s_x'); b.dirty.add('s_x');
    for (let i = 0; i < 10; i++) { round(a, bucket); round(b, bucket); }
    assert.equal(a.merges + b.merges, 0, '没有要并进的就不算合并');
    assert.ok(a.noopMerges <= 1 && b.noopMerges <= 1, `空合并最多一次（a=${a.noopMerges} b=${b.noopMerges}）`);
    assert.equal(a.detaches + b.detaches, 0, '空合并不 detach');
  });

  test('B 上聊了几句 → A 下一轮并进来；之后两边都不再合并（不来回空转）', () => {
    const bucket = { catalog: cat([]), transcripts: new Map<string, Set<string>>() };
    const a = machine(A, NOW); const b = machine(B, NOW - 3 * 3600_000);
    for (const m of [a, b]) m.msgs.set('s_x', new Set(['m1']));
    a.dirty.add('s_x');
    for (let i = 0; i < 3; i++) { round(a, bucket); round(b, bucket); }
    const before = { a: a.merges + a.noopMerges, b: b.merges + b.noopMerges };
    b.msgs.get('s_x')!.add('b2'); b.msgs.get('s_x')!.add('b3'); b.dirty.add('s_x');
    round(b, bucket);
    round(a, bucket);
    assert.deepEqual([...a.msgs.get('s_x')!].sort(), ['b2', 'b3', 'm1']);
    /* A 合并后把并集传上去；B 看到 A 的新上传 → 合一次（0 条）→ 记下 → 之后安静 */
    for (let i = 0; i < 10; i++) { round(b, bucket); round(a, bucket); }
    const after = { a: a.merges + a.noopMerges - before.a, b: b.merges + b.noopMerges - before.b };
    assert.equal(a.merges, 1, 'A 只真的合并一次');
    assert.ok(after.a + after.b <= 3, `B 的新消息只引起有限几次合并，不是每轮一次（a=${after.a} b=${after.b}）`);
    assert.deepEqual([...b.msgs.get('s_x')!].sort(), [...a.msgs.get('s_x')!].sort());
  });

  test('两边交替各聊一句，多轮之后两边内容一致，空合并次数有限', () => {
    const bucket = { catalog: cat([]), transcripts: new Map<string, Set<string>>() };
    const a = machine(A, NOW); const b = machine(B, NOW + 1);
    for (const m of [a, b]) m.msgs.set('s_x', new Set(['m0']));
    a.dirty.add('s_x');
    for (let i = 0; i < 6; i++) {
      const m = i % 2 ? b : a;
      m.msgs.get('s_x')!.add(`${m.tag}-${i}`); m.dirty.add('s_x');
      round(a, bucket); round(b, bucket);
    }
    const settled = a.noopMerges + b.noopMerges + a.merges + b.merges;
    for (let i = 0; i < 20; i++) { round(a, bucket); round(b, bucket); }
    assert.equal(a.noopMerges + b.noopMerges + a.merges + b.merges - settled <= 2, true, '安静下来之后不再合并');
    assert.deepEqual([...a.msgs.get('s_x')!].sort(), [...b.msgs.get('s_x')!].sort());
    assert.equal(a.msgs.get('s_x')!.size, 7);
  });
});

/* 接线：index.ts 不能 import，把源码当文本读 */
describe('接线（index.ts）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  const start = M.indexOf('async function runS3Sync(');
  const body = M.slice(start, M.indexOf('function rescheduleS3Sync', start));

  test('合并按 planBucketMerges 判（不再按 updatedAt 的 detectConflicts），合并完记下看到的那份', () => {
    assert.ok(body.includes('planBucketMerges('));
    assert.ok(!body.includes('detectConflicts('));
    assert.match(body, /noteBucketSeen\(bucketSeen, c\.id, c\)/);
    assert.match(body, /writeBucketSeen\(S3_BUCKET_SEEN_PATH, bucketSeen\)/);
  });

  test('空合并 / 中途变忙：mergeBucketSession 按 runBucketMerge 的顺序走，断开执行器和改写都在 apply 里；循环里推迟的不记「看过了」', () => {
    const merge = M.slice(M.indexOf('async function mergeBucketSession('), M.indexOf('async function keepLocalSession('));
    assert.ok(merge.includes('await runBucketMerge('));
    const apply = merge.indexOf('apply: () => {');
    assert.ok(apply > 0);
    for (const k of ['detachExecutor(', 'before-merge-', 'writeRecordKeepUpdatedAt', 'fs.renameSync(tmp, tAbs)']) assert.ok(merge.indexOf(k) > apply, k + ' 要在 apply 里');
    assert.ok(merge.includes('isBusy: () => !!sessionClients.get(sessionId)?.busy'));
    const loop = body.slice(body.indexOf('planBucketMerges('), body.indexOf('if (mergedIds.length)'));
    assert.ok(loop.indexOf('if (r.deferred)') < loop.indexOf('noteBucketSeen('), '推迟的不记看过了');
    assert.ok(loop.indexOf('if (r.noop)') < loop.indexOf('mergedIds.push(c.id)'));
  });

});

/*
 * 审查意见：调用方进来前查过一次忙，但下载 / 列文件要等网络 —— 这期间用户或排队任务可能开始了新一轮。
 * 真正断开执行器、改写 transcript 之前要再查一次；忙了就推迟（不断开、不合并），调用方也不记「看过了」。
 */
describe('runBucketMerge：等网络期间会话从空闲变忙 → 不断开、不合并', () => {
  const fake = (over: { transcriptNew?: number; missingFiles?: number; busyAfterFetch?: boolean; busyAfterPull?: boolean } = {}) => {
    const log: string[] = [];
    let busy = false;
    const io: BucketMergeIO = {
      fetch: async () => {
        log.push('fetch');
        await new Promise((r) => setTimeout(r, 5));          // 网络等待
        if (over.busyAfterFetch) busy = true;                // 这期间用户开始了新一轮
        return { transcript: 'theirs', missingFiles: over.missingFiles ?? 0 };
      },
      countNew: () => over.transcriptNew ?? 2,
      isBusy: () => busy,
      pullFiles: async () => {
        log.push('pull');
        await new Promise((r) => setTimeout(r, 5));
        if (over.busyAfterPull) busy = true;
        return over.missingFiles ?? 0;
      },
      apply: () => { log.push('apply'); return over.transcriptNew ?? 2; },
    };
    return { io, log };
  };

  test('空闲 → 照常合并', async () => {
    const { io, log } = fake();
    assert.deepEqual(await runBucketMerge(io), { added: 2, pulledFiles: 0 });
    assert.deepEqual(log, ['fetch', 'apply']);
  });

  test('下载期间变忙 → deferred，不 apply（不断开执行器、不改写）', async () => {
    const { io, log } = fake({ busyAfterFetch: true, missingFiles: 1 });
    assert.deepEqual(await runBucketMerge(io), { added: 0, pulledFiles: 0, deferred: true });
    assert.deepEqual(log, ['fetch']);
  });

  test('拉文件期间变忙 → deferred，不 apply（只补了本机没有的文件）', async () => {
    const { io, log } = fake({ busyAfterPull: true, missingFiles: 2 });
    assert.deepEqual(await runBucketMerge(io), { added: 0, pulledFiles: 2, deferred: true });
    assert.deepEqual(log, ['fetch', 'pull']);
  });

  test('没有新内容 → noop，忙不忙都不动', async () => {
    const { io, log } = fake({ transcriptNew: 0, busyAfterFetch: true });
    assert.deepEqual(await runBucketMerge(io), { added: 0, pulledFiles: 0, noop: true });
    assert.deepEqual(log, ['fetch']);
  });

  test('推迟的那一轮不记「看过了」：下一轮还会判出要合并', async () => {
    const seen: BucketSeen = {};
    const e = entry();
    const { io } = fake({ busyAfterFetch: true });
    const r = await runBucketMerge(io);
    if (!r.deferred) noteBucketSeen(seen, e.id, e);       // 和 index.ts 那个循环一样
    assert.deepEqual(planBucketMerges(cat([e]), ['s_1'], A, seen).map((x) => x.id), ['s_1']);
  });
});

/*
 * (3) 归档要保留 —— 实测：catalog 里 archived=true 的两条，下载回本机后「放进未分组」、record 里 archived 丢了，点开又能连接。
 * 根因：占位下载走的是 s3:restore 的规则（restoreTarget，entry: undefined、putBack: false）—— 项目一律清掉进未分组，
 * 归档只看下载下来的 record.json，侧栏上那一行（占位 / catalog）的位置不参与。
 */
describe('(3) 占位下载回本机：位置和侧栏里那一行一样（归档 / 项目都保留）', () => {
  const projects = new Set(['Blog', 'Dev']);
  test('占位（catalog）说归档、桶里的 record.json 是旧的没归档 → 下载回来仍是归档', () => {
    const rec = { profile: { projectId: 'Blog' }, archived: false, placementChangedAt: 10 };
    const r = placeholderPlacement(rec, { archived: true, project: 'Blog', placementChangedAt: 20 }, projects);
    assert.equal(r.placement.archived, true);
    assert.equal(r.placement.projectId, 'Blog', '项目本机有 → 放回去，不再一律进未分组');
    assert.equal(r.unassigned, false);
    assert.equal(r.placement.placementChangedAt, 20);
  });
  test('上一版建的外来占位没记位置时间 → 归档取两边的「或」（宁可留在归档里）', () => {
    const rec = { profile: {}, archived: false, placementChangedAt: 10 };
    assert.equal(placeholderPlacement(rec, { archived: true }, projects).placement.archived, true);
    assert.equal(placeholderPlacement({ ...rec, archived: true }, { archived: false }, projects).placement.archived, true);
  });
  test('记录里的位置更新（下载下来的比占位新）→ 听记录的', () => {
    const rec = { profile: { projectId: 'Dev' }, archived: false, placementChangedAt: 30 };
    const r = placeholderPlacement(rec, { archived: true, project: 'Blog', placementChangedAt: 20 }, projects);
    assert.equal(r.placement.archived, false);
    assert.equal(r.placement.projectId, 'Dev');
  });
  test('项目本机没有 / 形如会话 id / advanced 专属 → 进未分组（标 unassigned），原项目带回来给提示', () => {
    const rec = { profile: { projectId: 'Gone' }, placementChangedAt: 5 };
    const r = placeholderPlacement(rec, { project: 'Gone', placementChangedAt: 5 }, projects);
    assert.deepEqual([r.placement.projectId, r.unassigned, r.origin], ['', true, 'Gone']);
    assert.equal(placeholderPlacement({ profile: { projectId: 's_1790000000000_abcdef' } }, null, new Set(['s_1790000000000_abcdef'])).placement.projectId, '');
    assert.equal(placeholderPlacement({ profile: { projectId: 'Blog' } }, null, projects, (p) => p === 'Blog').placement.projectId, '');
  });
  test('本机移走的占位记下记录的位置时间（下载回来时和记录比谁新）', () => {
    const S = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'sessionOffload.ts'), 'utf-8');
    assert.ok(S.includes('...(Number(rec?.placementChangedAt) > 0 ? { placementChangedAt: Number(rec.placementChangedAt) } : null),'));
  });
  test('接线：offloadRestoreImpl 用 placeholderPlacement（不再走 restoreTarget 的「一律未分组」）', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
    const at = M.indexOf('async function offloadRestoreImpl(');
    const body = M.slice(at, M.indexOf('\n}\n', at));
    assert.ok(body.includes('const rt = placeholderPlacement(placedRec, placeholder,'));
    assert.ok(!body.includes('restoreTarget('));
  });
});

describe('(3) 归档的会话（含刚下载回来的）点开只读，不 attach、不起后端', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  const H = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf-8');
  test('主进程：loadSessionImpl 一进来就过检查点（归档 / 删除就拒），归档按记录现读', () => {
    const at = M.indexOf('const loadSessionImpl = async (');
    const head = M.slice(at, at + 900);
    assert.ok(head.includes("attachCheckpoint(attachLive, sessionId, 'start');"));
    assert.ok(M.includes('archived: (id) => !!store.readRecord(id)?.archived,'));
  });
  test('渲染端：切换会话判归档读最新列表（刚下载回来就打开的那条不在闭包里）', () => {
    assert.ok(H.includes('const isArchived = !!(sessionsRef.current.find((s) => s.id === sessionId) ?? sessions.find((s) => s.id === sessionId))?.archived;'));
  });
});

describe('(4) 删除后不许再 attach：路上的每一步之间都查', async () => {
  const { attachCheckpoint, AttachCancelled } = await import('../src/main/attachCancel.ts');
  test('模拟实测：准备本地工具期间被删 → 不选模型、不起后端，已备好的本地工具释放', async () => {
    const deleted = new Set<string>();
    const live = { deleted: (id: string) => deleted.has(id), archived: () => false, message: (w: string) => w };
    const log: string[] = [];
    const attach = async (id: string): Promise<void> => {
      attachCheckpoint(live, id, 'start');
      log.push('local tools');
      await new Promise((r) => setTimeout(r, 5));          // 准备本地工具要等（实测 20 秒）
      try { attachCheckpoint(live, id, 'local tools'); } catch (e) { log.push('release tools'); throw e; }
      log.push('pick model + start executor');
    };
    const p = attach('s_1');
    deleted.add('s_1');                                     // 用户这时删掉了它
    await assert.rejects(p, (e: any) => e instanceof AttachCancelled && e.why === 'deleted' && e.stage === 'local tools');
    assert.deepEqual(log, ['local tools', 'release tools']);
    /* 删掉之后再来的 attach（排队的预热）：一进来就拒 */
    await assert.rejects(attach('s_1'), AttachCancelled);
    assert.deepEqual(log, ['local tools', 'release tools']);
  });
  test('归档了也停', () => {
    assert.throws(() => attachCheckpoint({ deleted: () => false, archived: () => true, message: (w) => w }, 's', 'x'), (e: any) => e.why === 'archived');
  });
  test('接线：本地工具备好后、执行器起来后、逐个候选模型之前都有检查', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
    const at = M.indexOf('const loadSessionImpl = async (');
    const body = M.slice(at, M.indexOf("ipcMain.handle('acp:load-session'", at));
    const tools = body.lastIndexOf('localTools = await ensureLocalTools(');
    const cpTools = body.indexOf("attachCheckpoint(attachLive, sessionId, 'local tools')");
    const connect = body.indexOf('await connectWithModelFallback(');
    const cpExec = body.indexOf("attachCheckpoint(attachLive, sessionId, 'executor started')");
    assert.ok(tools > 0 && tools < cpTools && cpTools < connect && connect < cpExec, '顺序：备工具 → 查 → 起执行器 → 查');
    assert.ok(body.slice(cpTools, connect).includes('releaseLocalTools(sessionId, profile.remote)'));
    assert.ok(body.slice(cpExec, cpExec + 300).includes('client.disconnect()'));
    const fb = M.slice(M.indexOf('async function connectWithModelFallback('));
    const loop = fb.indexOf('for (let i = 0; i < candidates.length; i += 1) {');
    assert.ok(fb.slice(loop, loop + 900).includes('if (sessionId && deletedSessionIds.has(sessionId)) throw'));
  });
});

describe('(5) 本机删掉会话：只写本机的删除记录；不删另一台的备份、不让另一台删它的副本', () => {
  test('A 删了（删除记录），B 还有 → 云端清理不把它当候选（所有活跃设备都没有才进回收站）', () => {
    const e = entry({ uploadedAt: NOW - 10 * DAY_MS, syncedAt: NOW - 10 * DAY_MS });
    const mA = buildDeviceManifest('devA', NOW - 1000, [], { s_1: NOW - 5 * DAY_MS }, A);
    const mB = buildDeviceManifest('devB', NOW - 2000, [{ id: 's_1' }], {}, B);
    const c = withDeviceManifest(withDeviceManifest(cat([e]), mA), mB);
    assert.deepEqual(decideCleanup(c, { now: NOW, activeDays: 90 }).candidates, []);
  });
  test('本机删除只写本机的删除记录：purgeSession 不碰桶（不写 catalog 墓碑、不删对象）', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
    const at = M.indexOf('const purgeSession = async (');
    const body = M.slice(at, M.indexOf('\n  };\n', at));
    assert.ok(body.includes('noteDeletion(S3_DELETED_AT_PATH, sessionId,'));
    for (const k of ['deleteSessionBackups(', 'deleteBackupsOf(', 'withTombstones(', 'deleteObject(']) assert.ok(!body.includes(k), k);
  });
});

/*
 * 范围收窄（审查转达的用户最新要求）：不再给本机没有的会话建「其他电脑上的会话」占位，上一版建的启动时清掉；
 * 手动「从备份恢复」成功后自动开启「在其他电脑上同步」。
 */
describe('不再建外来占位；启动时清掉上一版建的（本机移到云端的不碰）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  const P = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 's3Pull.ts'), 'utf-8');
  test('同步那一轮不建、不改、不跟着删任何外来占位；建占位的那套函数和「从列表里移除」都没了', () => {
    for (const k of ['syncRemotePlaceholders', 'planRemotePlaceholders', 'applyRemotePlaceholders', 'dismissRemotePlaceholder', "'offload:dismiss'"]) {
      assert.ok(!M.includes(k), `index.ts 里不该再有 ${k}`);
    }
    for (const k of ['export function planRemotePlaceholders', 'export function remotePlaceholderFor', 'export function applyRemotePlaceholders']) assert.ok(!P.includes(k), k);
    const R = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'offloadView.ts'), 'utf-8');
    assert.ok(!R.includes("origin === 'remote'"), '侧栏不再画外来占位的「在另一台电脑上」');
    const S = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'Sidebar.tsx'), 'utf-8');
    assert.ok(!S.includes('onOffloadDismiss') && !S.includes('session-remote-elsewhere'));
  });
  test('启动清理：只删 origin=remote 的，本机移到云端的和「保留在本机」名单原样留着；文件坏了不写', () => {
    const home = mkHome();
    const f = path.join(home, 'sessions-offloaded.json');
    const local: OffloadPlaceholder = { id: 's_local', title: 'L', lastActiveAt: 1, offloadedAt: 2, cloudKey: 'kx/v1/sessions/s_local/', bytes: 1, files: 1 };
    const remote = { id: 's_r1', title: 'R', lastActiveAt: 1, offloadedAt: 2, cloudKey: 'kx/v1/sessions/s_r1/', bytes: 1, files: 0, origin: 'remote', fromMachine: B, fromHost: 'x', seenUploadedAt: 3 } as OffloadPlaceholder;
    writeOffloadState(f, { version: 1, offloaded: { s_local: local, s_r1: remote, s_r2: { ...remote, id: 's_r2' } }, keepLocal: ['s_keep'] });
    assert.ok(isRemotePlaceholder(remote) && !isRemotePlaceholder(local));
    assert.deepEqual(clearRemotePlaceholders(f), ['s_r1', 's_r2']);
    const st = readOffloadState(f);
    assert.deepEqual(Object.keys(st.offloaded), ['s_local']);
    assert.deepEqual(st.offloaded.s_local, local);
    assert.deepEqual(st.keepLocal, ['s_keep']);
    assert.deepEqual(clearRemotePlaceholders(f), [], '再跑一次什么都不动');
    fs.writeFileSync(f, '{bad');
    assert.equal(clearRemotePlaceholders(f), null);
    assert.equal(fs.readFileSync(f, 'utf-8'), '{bad');
  });
  test('接线：启动时（回收站清理旁边）清一次', () => {
    const at = M.indexOf('try { pruneSessionTrash(); } catch {}');
    assert.ok(at > 0);
    assert.ok(M.slice(at, at + 900).includes('clearRemotePlaceholders(OFFLOAD_STATE_PATH)'));
  });
});

describe('手动「从备份恢复」成功 → 自动开启「在其他电脑上同步」', () => {
  test('备份里没带标记 / 带的是关 → 都改成开，开关时间记成现在（比旧的新）', () => {
    const NOW2 = 1_000_000;
    assert.deepEqual(withCrossDeviceOn({ id: 's' } as any, NOW2), { id: 's', crossDevice: true, crossDeviceChangedAt: NOW2 });
    const off = withCrossDeviceOn({ id: 's', crossDevice: false, crossDeviceChangedAt: 500 } as any, NOW2);
    assert.equal(off.crossDevice, true);
    assert.equal(off.crossDeviceChangedAt, NOW2);
    /* 另一台的关比本机时钟还「晚」：也要比它新，另一台下一轮才会跟着开 */
    assert.ok(withCrossDeviceOn({ crossDeviceChangedAt: NOW2 + 50 } as any, NOW2).crossDeviceChangedAt! > NOW2 + 50);
    /* 开着以后另一台跟随（谁后改听谁）、合并照常 */
    const rec = withCrossDeviceOn({} as any, NOW2);
    assert.equal(crossDeviceToFollow({ crossDeviceChangedAt: 10 }, rec)?.crossDevice, true);
    assert.deepEqual(planBucketMerges(cat([entry({ crossDevice: undefined, crossDeviceChangedAt: 10 })]), ['s_1'], A, {}, NOW, new Map([['s_1', rec]])).map((x) => x.id), ['s_1']);
  });
  test('接线：s3:restore 成功分支写记录并通知界面', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
    const at = M.indexOf("ipcMain.handle('s3:restore'");
    const body = M.slice(at, M.indexOf("ipcMain.handle('offload:list'", at));
    const on = body.indexOf('withCrossDeviceOn(cur, Date.now())');
    assert.ok(on > 0);
    assert.ok(body.slice(on, on + 400).includes("webContents.send('session:cross-device-changed', { sessionId, crossDevice: true })"));
    assert.ok(on < body.indexOf('ok: true, restored, backedUp, merged'), '在成功返回之前');
    assert.ok(on > body.indexOf('forgetDeletion(S3_DELETED_AT_PATH, sessionId)'), '在恢复写盘之后');
  });
});

/*
 * 审查意见：最后一个检查点在 resume 之前 —— 等 resume 期间删了，失败后照样重试、照样 newSession；
 * 等 resume 期间归档了而 resume 成功，最后只查删除，执行器照样登记上去。
 */
describe('(4) resume 期间删除 / 归档 → 不重试、不新起、不挂上', async () => {
  const { resumeOrFresh, attachCheckpoint, AttachCancelled } = await import('../src/main/attachCancel.ts');
  const setup = () => {
    const state = { deleted: false, archived: false };
    const live = { deleted: () => state.deleted, archived: () => state.archived, message: (w: string) => w };
    const log: string[] = [];
    return { state, log, checkpoint: (stage: string) => attachCheckpoint(live, 's_1', stage) };
  };
  test('等 resume 期间被删、resume 失败 → 不重试、不新起后端会话', async () => {
    const { state, log, checkpoint } = setup();
    const p = resumeOrFresh({
      tryResume: async () => { log.push('resume'); await new Promise((r) => setTimeout(r, 5)); throw new Error('session/load resume timed out'); },
      newSession: async () => { log.push('newSession'); return 'cli-new'; },
      checkpoint, definitiveMiss: () => false,
    });
    state.deleted = true;                                     // 用户在 resume 等待期间删了它
    await assert.rejects(p, (e: any) => e instanceof AttachCancelled && e.why === 'deleted' && e.stage === 'before resume retry');
    assert.deepEqual(log, ['resume'], '只 resume 了一次，没重试、没 newSession');
  });
  test('确定失败（Resource not found）期间被删 → 不新起', async () => {
    const { state, log, checkpoint } = setup();
    const p = resumeOrFresh({
      tryResume: async () => { log.push('resume'); await new Promise((r) => setTimeout(r, 5)); throw new Error('Resource not found'); },
      newSession: async () => { log.push('newSession'); return 'x'; },
      checkpoint, definitiveMiss: (e) => /Resource not found/.test(e.message),
    });
    state.deleted = true;
    await assert.rejects(p, (e: any) => e instanceof AttachCancelled && e.stage === 'before fresh backend session');
    assert.deepEqual(log, ['resume']);
  });
  test('等 resume 期间被归档、resume 成功 → 抛 AttachCancelled（调用方不登记执行器）', async () => {
    const { state, log, checkpoint } = setup();
    const p = resumeOrFresh({
      tryResume: async () => { log.push('resume'); await new Promise((r) => setTimeout(r, 5)); },
      newSession: async () => { log.push('newSession'); return 'x'; },
      checkpoint, definitiveMiss: () => false,
    });
    state.archived = true;
    await assert.rejects(p, (e: any) => e instanceof AttachCancelled && e.why === 'archived' && e.stage === 'resumed');
    assert.deepEqual(log, ['resume']);
  });
  test('新起后端会话期间被删 → 新起完立刻停（调用方断开）', async () => {
    const { state, checkpoint } = setup();
    const p = resumeOrFresh({
      tryResume: async () => { throw new Error('Resource not found'); },
      newSession: async () => { await new Promise((r) => setTimeout(r, 5)); return 'x'; },
      checkpoint, definitiveMiss: () => true,
    });
    await new Promise((r) => setTimeout(r, 1));
    state.deleted = true;
    await assert.rejects(p, (e: any) => e instanceof AttachCancelled && e.stage === 'fresh backend session started');
  });
  test('没人动：第一次失败 → 重试成功；两次都失败 → 新起', async () => {
    const { checkpoint } = setup();
    let n = 0;
    assert.deepEqual(await resumeOrFresh({ tryResume: async () => { if (++n === 1) throw new Error('t'); }, newSession: async () => 'x', checkpoint, definitiveMiss: () => false }), { fresh: false });
    assert.deepEqual(await resumeOrFresh({ tryResume: async () => { throw new Error('t'); }, newSession: async () => 'cli-2', checkpoint, definitiveMiss: () => false }), { fresh: true, cliSessionId: 'cli-2' });
  });
  test('接线：loadSessionImpl 用 resumeOrFresh；取消时断开执行器、释放本地工具；登记执行器之前再查一次（删除和归档）', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
    const at = M.indexOf('const loadSessionImpl = async (');
    const body = M.slice(at, M.indexOf("ipcMain.handle('acp:load-session'", at));
    const r = body.indexOf('await resumeOrFresh({');
    assert.ok(r > 0);
    assert.ok(!body.includes('await tryResume();'), '不再有绕过检查点的 resume 重试');
    const cancel = body.indexOf('if (err instanceof AttachCancelled) {', r);
    assert.ok(cancel > r && body.slice(cancel, cancel + 500).includes('client.disconnect()') && body.slice(cancel, cancel + 500).includes('releaseLocalTools(sessionId, profile.remote)'));
    const mount = body.indexOf("attachCheckpoint(attachLive, sessionId, 'before mount')");
    const set = body.indexOf('sessionClients.set(sessionId, entry)');
    assert.ok(mount > cancel && mount < set, '登记执行器之前');
    assert.ok(!body.slice(mount, set).includes('await new') && !/await (?!client\.disconnect)/.test(body.slice(body.indexOf('\n', mount), set).replace(/try \{ await client\.disconnect\(\); \} catch \{[^}]*\}/g, '')), '检查点到登记之间（正常路径）不再等任何东西');
  });
});

/*
 * 审查意见：候选模型循环只查删除不查归档；等换配置（awaitReconfigureIdle）之后也只查删除，归档了照样准备本地工具。
 */
describe('(3)(4) 连接途中被归档：不再试下一个候选模型、不准备本地工具', async () => {
  const { attachCheckpoint, AttachCancelled } = await import('../src/main/attachCancel.ts');
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  test('模拟：第一个候选模型连接失败期间被归档 → 不再试第二个，抛 AttachCancelled（调用方释放本地工具）', async () => {
    const state = { archived: false };
    const live = { deleted: () => false, archived: () => state.archived, message: (w: string) => w };
    const tried: string[] = [];
    let released = false;
    /* 和 connectWithModelFallback 的循环同一个形状：每个候选之前过检查点 */
    const connectAll = async (candidates: string[], checkpoint: (s: string) => void): Promise<string> => {
      for (let i = 0; i < candidates.length; i += 1) {
        checkpoint(`model candidate ${i + 1}/${candidates.length}`);
        tried.push(candidates[i]);
        await new Promise((r) => setTimeout(r, 5));
        if (i === 0) { state.archived = true; continue; }  // 第一个连不上，这期间用户归档了它
        return candidates[i];
      }
      throw new Error('No usable model');
    };
    try {
      await connectAll(['m1', 'm2', 'm3'], (st) => attachCheckpoint(live, 's_1', st));
      assert.fail('should cancel');
    } catch (err) {
      if (err instanceof AttachCancelled) released = true;
      assert.ok(err instanceof AttachCancelled && err.why === 'archived' && err.stage === 'model candidate 2/3');
    }
    assert.deepEqual(tried, ['m1']);
    assert.ok(released);
  });
  test('接线：connectWithModelFallback 每个候选之前调 checkpoint；loadSessionImpl 传进去，取消时释放本地工具', () => {
    const fb = M.slice(M.indexOf('async function connectWithModelFallback('));
    const loop = fb.indexOf('for (let i = 0; i < candidates.length; i += 1) {');
    const head = fb.slice(loop, loop + 1000);
    assert.ok(head.includes('if (sessionId) attachCheckpoints.get(sessionId)?.(`model candidate ${i + 1}/${candidates.length}`);'));
    assert.ok(head.indexOf('attachCheckpoints.get(') < head.indexOf('new AcpClient('), '先查再起执行器');
    assert.ok(head.indexOf('attachCheckpoints.get(') < head.indexOf('deletedSessionIds.has(sessionId)) throw new Error('), '登记的检查点先查（抛 AttachCancelled），不被普通的删除 Error 抢先');
    const at = M.indexOf('const loadSessionImpl = async (');
    const body = M.slice(at, M.indexOf("ipcMain.handle('acp:load-session'", at));
    const call = body.indexOf('started = await connectWithModelFallback(');
    const reg = body.indexOf('attachCheckpoints.set(sessionId, (stage) => attachCheckpoint(attachLive, sessionId, stage));');
    assert.ok(call > 0 && reg > 0 && reg < call, '连之前登记');
    assert.ok(body.slice(call, call + 700).includes('if (err instanceof AttachCancelled || deletedSessionIds.has(sessionId)) releaseLocalTools(sessionId, profile.remote);'));
    assert.ok(body.slice(call, call + 600).includes('attachCheckpoints.delete(sessionId);'), '试完去掉');
  });
  test('接线：等换配置结束后查删除和归档，准备本地工具之前再查一次', () => {
    const at = M.indexOf('const loadSessionImpl = async (');
    const body = M.slice(at, M.indexOf("ipcMain.handle('acp:load-session'", at));
    const wait = body.indexOf('await awaitReconfigureIdle(sessionId);');
    const cpWait = body.indexOf("attachCheckpoint(attachLive, sessionId, 'after reconfigure wait')");
    const cpTools = body.indexOf("attachCheckpoint(attachLive, sessionId, 'before local tools')");
    const tools = body.indexOf('ensureLocalTools(');
    assert.ok(wait > 0 && wait < cpWait && cpWait < cpTools && cpTools < tools, '等完 → 查 → 查 → 准备工具');
    /* 归档按记录现读：attachLive.archived */
    assert.ok(M.includes('archived: (id) => !!store.readRecord(id)?.archived,'));
  });
});

/* 审查意见：第一个候选模型失败期间被删除 —— 循环先抛普通 Error，绕过检查点，调用方只在 AttachCancelled 时释放本地工具 */
describe('(4) 候选模型失败期间被删除 → 不试下一个，本地工具释放', async () => {
  const { attachCheckpoint, AttachCancelled } = await import('../src/main/attachCancel.ts');
  test('模拟：和 connectWithModelFallback 同一个顺序（先登记的检查点、再删除检查），调用方和 loadSessionImpl 同一个释放判据', async () => {
    const deleted = new Set<string>();
    const live = { deleted: (id: string) => deleted.has(id), archived: () => false, message: (w: string) => w };
    const checkpoints = new Map<string, (s: string) => void>([['s_1', (st) => attachCheckpoint(live, 's_1', st)]]);
    const tried: string[] = [];
    let released = false;
    const connectAll = async (sessionId: string, candidates: string[]): Promise<string> => {
      for (let i = 0; i < candidates.length; i += 1) {
        checkpoints.get(sessionId)?.(`model candidate ${i + 1}/${candidates.length}`);
        if (deleted.has(sessionId)) throw new Error('Session was deleted; not re-attaching.');
        tried.push(candidates[i]);
        await new Promise((r) => setTimeout(r, 5));
        if (i === 0) { deleted.add(sessionId); continue; }   // 第一个连不上，这期间用户删了它
        return candidates[i];
      }
      throw new Error('No usable model');
    };
    await assert.rejects(async () => {
      try { await connectAll('s_1', ['m1', 'm2']); }
      catch (err) { if (err instanceof AttachCancelled || deleted.has('s_1')) released = true; throw err; }
    }, (e: any) => e instanceof AttachCancelled && e.why === 'deleted' && e.stage === 'model candidate 2/2');
    assert.deepEqual(tried, ['m1'], '没试第二个');
    assert.ok(released, '本地工具释放了');
  });
});
