import assert from 'node:assert/strict';
import { describe, test, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bucketMergeVerdict, planBucketMerges, noteBucketSeen, readBucketSeen, writeBucketSeen, planRemotePlaceholders,
  applyRemotePlaceholders, dismissRemotePlaceholder, remotePlaceholderFor, showRemoteSessions, hostOfTag, isRemotePlaceholder,
  runBucketMerge, type BucketMergeIO, type BucketSeen, type RemotePlanInput,
} from '../src/main/s3Pull.ts';
import { manifestSessionsWithOffloaded, readOffloadState, readOffloadStateStrict, writeOffloadState, type OffloadPlaceholder } from '../src/main/sessionOffload.ts';
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

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 's_1', title: 'T', updatedAt: NOW - 1000, bytes: 10, from: B, syncedAt: NOW - 500, uploadedAt: NOW - 600, ...over,
});
const cat = (entries: CatalogEntry[], extra: Partial<Catalog> = {}): Catalog => ({ version: 1, entries, ...extra });

const tmps: string[] = [];
const mkHome = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-s3pull-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const planInput = (over: Partial<RemotePlanInput> = {}): RemotePlanInput => ({
  catalog: cat([entry()]), thisMachine: A, prefix: 'kx', now: NOW, enabled: true,
  localIds: new Set(), placeholders: {}, deleted: new Set(),
  excluded: () => false, advanced: () => false,
  ...over,
});

describe('(a) 别的电脑上的新会话 → 建占位', () => {
  test('来自别的设备、本机没有 → 建外来占位（不下载，记下来源和云端位置）', () => {
    const plan = planRemotePlaceholders(planInput());
    assert.equal(plan.create.length, 1);
    const p = plan.create[0];
    assert.equal(p.id, 's_1');
    assert.equal(p.origin, 'remote');
    assert.equal(p.fromMachine, B);
    assert.equal(p.fromHost, 'b0be83784d7d');
    assert.equal(p.cloudKey, 'kx/v1/sessions/s_1/');
    assert.equal(p.seenUploadedAt, NOW - 600);
    assert.ok(isRemotePlaceholder(p));
  });

  test('排除项：自己传的 / 本机有的 / 已有占位 / 本机删过的 / 不同步的项目 / advanced / 云端回收站 / 没记来源', () => {
    const cases: Array<[string, Partial<RemotePlanInput>, string]> = [
      ['own', { catalog: cat([entry({ from: A })]) }, 'own'],
      ['no-source', { catalog: cat([entry({ from: undefined })]) }, 'no-source'],
      ['local', { localIds: new Set(['s_1']) }, 'local'],
      ['placeholder', { placeholders: { s_1: { ...remotePlaceholderFor(entry(), 'kx', 1), origin: undefined } as OffloadPlaceholder } }, 'placeholder'],
      ['deleted', { deleted: new Set(['s_1']) }, 'deleted'],
      ['excluded', { catalog: cat([entry({ project: 'Secret' })]), excluded: (e) => e.project === 'Secret' }, 'excluded'],
      ['advanced', { catalog: cat([entry({ project: 'flow-x' })]), advanced: (p) => p === 'flow-x' }, 'advanced'],
      ['cloud-trash', { inCloudTrash: new Set(['s_1']) }, 'cloud-trash'],
    ];
    for (const [name, over, reason] of cases) {
      const plan = planRemotePlaceholders(planInput(over));
      assert.equal(plan.create.length, 0, name);
      assert.deepEqual(plan.skipped.map((s) => s.reason), [reason], name);
    }
  });

  test('catalog 里删除记录比条目新（墓碑）→ 不建', () => {
    const plan = planRemotePlaceholders(planInput({ catalog: cat([entry()], { deleted: [{ id: 's_1', at: NOW - 100 }] }) }));
    assert.equal(plan.create.length, 0);
  });

  test('设置关掉「自动显示其他电脑上的会话」→ 不建；已有的外来占位去掉；缺省是开', () => {
    const p = remotePlaceholderFor(entry(), 'kx', 1);
    const plan = planRemotePlaceholders(planInput({ enabled: false, catalog: cat([entry(), entry({ id: 's_2' })]), placeholders: { s_1: p } }));
    assert.equal(plan.create.length, 0);
    assert.deepEqual(plan.remove, [{ id: 's_1', why: 'turned-off' }]);
    assert.equal(showRemoteSessions({}), true);
    assert.equal(showRemoteSessions(undefined), true);
    assert.equal(showRemoteSessions({ autoShowRemoteSessions: false }), false);
  });

  test('catalog 读不到 → 什么都不做', () => {
    const p = remotePlaceholderFor(entry(), 'kx', 1);
    const plan = planRemotePlaceholders(planInput({ catalog: null, placeholders: { s_1: p } }));
    assert.deepEqual(plan, { create: [], update: [], remove: [], skipped: [] });
  });

  test('写进占位文件：本机移到云端的占位不被碰；本机删过的占位（删除记录）下一轮不再建', () => {
    const home = mkHome();
    const f = path.join(home, 'sessions-offloaded.json');
    const local: OffloadPlaceholder = { id: 's_local', title: 'L', lastActiveAt: 1, offloadedAt: 2, cloudKey: 'kx/v1/sessions/s_local/', bytes: 1, files: 1 };
    writeOffloadState(f, { version: 1, offloaded: { s_local: local }, keepLocal: [] });
    const c = cat([entry(), entry({ id: 's_local' })]);
    const r = applyRemotePlaceholders(f, planRemotePlaceholders(planInput({ catalog: c, placeholders: readOffloadState(f).offloaded })));
    assert.deepEqual(r?.created, ['s_1']);
    assert.deepEqual(readOffloadState(f).offloaded.s_local, local);
    /* 本机删掉这条外来占位：去掉 + 调用方写删除记录 → 下一轮不建回来 */
    assert.deepEqual(dismissRemotePlaceholder(f, 's_1'), { ok: true });
    assert.equal(dismissRemotePlaceholder(f, 's_local').ok, false, '本机移走的占位不走这条');
    const again = planRemotePlaceholders(planInput({ catalog: c, placeholders: readOffloadState(f).offloaded, deleted: new Set(['s_1']) }));
    assert.equal(again.create.length, 0);
    /* 占位文件坏了 → 不写 */
    fs.writeFileSync(f, '{bad');
    assert.equal(applyRemotePlaceholders(f, planRemotePlaceholders(planInput())), null);
    assert.equal(fs.readFileSync(f, 'utf-8'), '{bad');
  });

  test('旧版本读得懂新字段；origin 乱填 → 整份当读不懂（不静默丢）', () => {
    const home = mkHome();
    const f = path.join(home, 'sessions-offloaded.json');
    writeOffloadState(f, { version: 1, offloaded: { s_1: remotePlaceholderFor(entry(), 'kx', 1) }, keepLocal: [] });
    assert.equal(readOffloadStateStrict(f)?.offloaded.s_1.origin, 'remote');
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
    raw.offloaded.s_1.origin = 'weird';
    fs.writeFileSync(f, JSON.stringify(raw));
    assert.equal(readOffloadStateStrict(f), null);
  });

  test('主机名：去掉 machineTag 前面那 6 位摘要', () => {
    assert.equal(hostOfTag('bb0f24-b0be83784d7d'), 'b0be83784d7d');
    assert.equal(hostOfTag('kyn-desktop'), 'kyn-desktop');
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

describe('(d) 别的电脑删了 → 外来占位去掉；本机真会话不动', () => {
  test('catalog 墓碑比条目新 → 去掉外来占位；本机移到云端的占位、本机有的会话都不在这里处理', () => {
    const remote = remotePlaceholderFor(entry(), 'kx', 1);
    const localOff: OffloadPlaceholder = { id: 's_off', title: 'O', lastActiveAt: 1, offloadedAt: 2, cloudKey: 'kx/v1/sessions/s_off/', bytes: 1, files: 1 };
    const c = cat([entry(), entry({ id: 's_off' }), entry({ id: 's_real' })], {
      deleted: [{ id: 's_1', at: NOW }, { id: 's_off', at: NOW }, { id: 's_real', at: NOW }],
    });
    const plan = planRemotePlaceholders(planInput({ catalog: c, placeholders: { s_1: remote, s_off: localOff }, localIds: new Set(['s_real']) }));
    assert.deepEqual(plan.remove, [{ id: 's_1', why: 'gone' }]);
    assert.equal(plan.create.length, 0);
  });

  test('条目从 catalog 里没了（进了云端回收站）→ 去掉；这一轮刚移进回收站的也去掉', () => {
    const remote = remotePlaceholderFor(entry(), 'kx', 1);
    assert.deepEqual(planRemotePlaceholders(planInput({ catalog: cat([]), placeholders: { s_1: remote } })).remove, [{ id: 's_1', why: 'gone' }]);
    assert.deepEqual(planRemotePlaceholders(planInput({ placeholders: { s_1: remote }, inCloudTrash: new Set(['s_1']) })).remove, [{ id: 's_1', why: 'cloud-trash' }]);
  });

  test('还在：标题 / 项目跟着 catalog 改，云端位置不变', () => {
    const remote = remotePlaceholderFor(entry(), 'kx', 1);
    const plan = planRemotePlaceholders(planInput({ prefix: 'other', catalog: cat([entry({ title: 'Renamed', project: 'P' })]), placeholders: { s_1: remote } }));
    assert.equal(plan.update.length, 1);
    assert.equal(plan.update[0].title, 'Renamed');
    assert.equal(plan.update[0].project, 'P');
    assert.equal(plan.update[0].cloudKey, 'kx/v1/sessions/s_1/');
    assert.equal(plan.update[0].offloadedAt, 1);
    /* 没变就不改 */
    assert.equal(planRemotePlaceholders(planInput({ placeholders: { s_1: remote } })).update.length, 0);
  });
});

describe('(e) 云端回收站的设备清单不把没打开过的外来占位算成持有', () => {
  test('manifestSessionsWithOffloaded 跳过 origin=remote；本机移走的照旧算', () => {
    const st = {
      version: 1 as const, keepLocal: [],
      offloaded: {
        s_1: remotePlaceholderFor(entry(), 'kx', 1),
        s_off: { id: 's_off', title: 'O', lastActiveAt: 1, offloadedAt: 2, cloudKey: 'kx/v1/sessions/s_off/', bytes: 1, files: 1 } as OffloadPlaceholder,
      },
    };
    assert.deepEqual(manifestSessionsWithOffloaded([], st).map((s) => s.id), ['s_off']);
  });

  test('端到端：B 删了它、A 只有外来占位 → 判成可以移进云端回收站', () => {
    const e = entry({ uploadedAt: NOW - 10 * DAY_MS, syncedAt: NOW - 10 * DAY_MS });
    const st = { version: 1 as const, keepLocal: [], offloaded: { s_1: remotePlaceholderFor(e, 'kx', 1) } };
    const mA = buildDeviceManifest('devA', NOW - 1000, manifestSessionsWithOffloaded([], st), {}, A);
    const mB = buildDeviceManifest('devB', NOW - 2000, [], { s_1: NOW - 5 * DAY_MS }, B);
    const c = withDeviceManifest(withDeviceManifest(cat([e]), mA), mB);
    const d = decideCleanup(c, { now: NOW, activeDays: 90 });
    assert.deepEqual(d.candidates.map((x) => x.entry.id), ['s_1']);
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

  test('外来占位在同步成功之后建（云端清理之后，用刚写完的 catalog）', () => {
    const call = body.indexOf('syncRemotePlaceholders(');
    assert.ok(call > body.indexOf('runCloudCleanup('));
    assert.ok(call < body.indexOf('syncFailures = 0;'));
  });

  test('侧栏「从这台电脑的列表里移除」写删除记录', () => {
    const h = M.slice(M.indexOf("ipcMain.handle('offload:dismiss'"));
    assert.match(h.slice(0, 1200), /dismissRemotePlaceholder\(OFFLOAD_STATE_PATH, id\)[\s\S]*noteDeletion\(S3_DELETED_AT_PATH, id,/);
  });
});

describe('侧栏：外来占位说清在哪台电脑上', () => {
  test('placeholderRows 带上 remote；悬停写「在另一台电脑上（主机名）」；本机移走的照旧', async () => {
    const { placeholderRows, offloadTooltip } = await import('../src/renderer/offloadView.ts');
    const rows = placeholderRows([
      { ...remotePlaceholderFor(entry(), 'kx', 1) },
      { id: 's_off', title: 'O', lastActiveAt: NOW - 40 * DAY_MS, offloadedAt: 2, bytes: 1 },
    ], []);
    assert.deepEqual(rows[0].offloaded.remote, { host: 'b0be83784d7d' });
    assert.equal(rows[1].offloaded.remote, undefined);
    assert.match(offloadTooltip(rows[0].offloaded, NOW, 'zh'), /在另一台电脑上（b0be83784d7d）/);
    assert.match(offloadTooltip(rows[1].offloaded, NOW, 'zh'), /已移到云端/);
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
