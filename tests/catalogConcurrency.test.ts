/**
 * catalog.json 的并发写 ——「恢复页里点恢复报『桶里没有 <id> 的文件』」。
 *
 * 实测：连点几次「删除备份」、或删除和定时同步交错，后写的那一方拿着旧快照整份写回，把刚删掉的条目复活了
 * （文件已删、条目还在）。守的是：
 *   · 并发两次删除 → 两批都消失；删除和同步交错 → 删掉的不复活；
 *   · 删除记录之后另一台机器**真的又上传了** → 条目回来；
 *   · 同步时把「没文件 + 有 delete marker」的老条目清掉；恢复页把没文件的条目标出来。
 * 用内存里的假 S3（支持 If-Match / If-None-Match、delete marker、随机延迟）跑真实的 catalogStore 代码。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeCatalog, withTombstones, updateCatalog, serialQueue, catalogIO, deleteSessionBackups,
  writeSyncCatalog, forgetMissingEntries, missingEntries, sessionIdsFromPrefixes, markMissing,
  type CatalogBucket,
} from '../src/main/catalogStore.ts';
import { catalogKey, type Catalog, type CatalogEntry } from '../src/main/s3Sync.ts';

const PREFIX = 'kirolex';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 内存里的假 S3：带 ETag 的条件写、开了版本控制（删 = 打 delete marker）、每个请求随机延迟。 */
class FakeS3 implements CatalogBucket {
  objects = new Map<string, { body: Buffer; etag: string }>();
  markers = new Map<string, number>();
  n = 0;
  opts: { honorConditions?: boolean; jitter?: number; clock?: () => number; versioned?: boolean };
  constructor(opts: { honorConditions?: boolean; jitter?: number; clock?: () => number; versioned?: boolean } = {}) { this.opts = opts; }
  private async lag() { await sleep(Math.floor(Math.random() * (this.opts.jitter ?? 4))); }
  private now() { return (this.opts.clock || Date.now)(); }
  seed(key: string, body: string | Buffer) { this.objects.set(key, { body: Buffer.from(body), etag: `"e${++this.n}"` }); this.markers.delete(key); }
  async get(key: string) { await this.lag(); const o = this.objects.get(key); return o ? { body: Buffer.from(o.body), etag: o.etag } : null; }
  async put(key: string, body: Buffer, cond: { ifMatch: string } | { ifNoneMatch: '*' } | null) {
    await this.lag();
    const cur = this.objects.get(key);
    if (this.opts.honorConditions !== false && cond) {
      if ('ifMatch' in cond && (!cur || cur.etag !== cond.ifMatch)) return 'conflict' as const;
      if ('ifNoneMatch' in cond && cur) return 'conflict' as const;
    }
    this.seed(key, body);
    return 'ok' as const;
  }
  async list(prefix: string) { await this.lag(); return [...this.objects.keys()].filter((k) => k.startsWith(prefix)); }
  async del(key: string) { await this.lag(); if (this.objects.delete(key)) this.markers.set(key, this.now()); }
  async sessionIds() {
    await this.lag();
    const head = `${PREFIX}/v1/sessions/`;
    const cps = new Set([...this.objects.keys()].filter((k) => k.startsWith(head)).map((k) => head + k.slice(head.length).split('/')[0] + '/'));
    return sessionIdsFromPrefixes(PREFIX, [...cps]);
  }
  async deletedAt(id: string) {
    const pfx = `${PREFIX}/v1/sessions/${id}/`;
    if ([...this.objects.keys()].some((k) => k.startsWith(pfx))) return 'live' as const;
    if (this.opts.versioned === false) return null;          // 没开版本控制 / 没权限：看不出删除时间
    const ts = [...this.markers].filter(([k]) => k.startsWith(pfx)).map(([, t]) => t);
    return ts.length ? Math.max(...ts) : null;
  }
  catalog(): Catalog { return JSON.parse(this.objects.get(catalogKey(PREFIX))!.body.toString('utf-8')); }
  ids(): string[] { return this.catalog().entries.map((e) => e.id).sort(); }
}

const entry = (id: string, over: Partial<CatalogEntry> = {}): CatalogEntry =>
  ({ id, title: id, updatedAt: 1, bytes: 1, syncedAt: 1, from: 'mac', uploadedAt: 1000, ...over });

/** 桶里放 n 条会话（每条两个文件）+ 一份 catalog。 */
function seeded(ids: string[], opts?: ConstructorParameters<typeof FakeS3>[0]): FakeS3 {
  const s3 = new FakeS3(opts);
  for (const id of ids) {
    s3.seed(`${PREFIX}/v1/sessions/${id}/record.json`, '{}');
    s3.seed(`${PREFIX}/v1/sessions/${id}/transcript.jsonl`, '');
  }
  s3.seed(catalogKey(PREFIX), JSON.stringify({ version: 1, entries: ids.map((id) => entry(id)) }));
  return s3;
}

const IDS = Array.from({ length: 10 }, (_, i) => `s${i}`);

describe('删除记录（tombstone）的合并规则', () => {
  test('删除记录比条目新 → 条目去掉；条目之后真的又上传过 → 回来、记录作废', () => {
    const c: Catalog = { version: 1, entries: [entry('a', { uploadedAt: 100 }), entry('b', { uploadedAt: 300 })], deleted: [{ id: 'a', at: 200 }, { id: 'b', at: 200 }] };
    const n = normalizeCatalog(c, 1000);
    assert.deepEqual(n.entries.map((e) => e.id), ['b']);
    assert.deepEqual(n.deleted, [{ id: 'a', at: 200 }]);
  });
  test('老条目没有 uploadedAt → 有删除记录就当删除更新', () => {
    const c: Catalog = { version: 1, entries: [entry('a', { uploadedAt: undefined })], deleted: [{ id: 'a', at: 1 }] };
    assert.equal(normalizeCatalog(c, 10).entries.length, 0);
  });
  test('同一个 id 多条记录取最新；很老的记录也留着（不过期，见 deletedNoReupload.test.ts）；别的字段（devices 等）原样带着', () => {
    const now = 1000 * 86_400_000;
    const c: any = { version: 1, entries: [], devices: { mac: { x: 1 } }, deleted: [{ id: 'a', at: now - 9000 }, { id: 'a', at: now - 1000 }, { id: 'old', at: 1 }] };
    const n: any = normalizeCatalog(c, now);
    assert.deepEqual(n.deleted, [{ id: 'a', at: now - 1000 }, { id: 'old', at: 1 }]);
    assert.deepEqual(n.devices, { mac: { x: 1 } });
  });
  test('withTombstones：去掉条目、写记录，别的条目不动', () => {
    const c = withTombstones({ version: 1, entries: [entry('a'), entry('b')] }, ['a'], 50);
    assert.deepEqual(c.entries.map((e) => e.id), ['b']);
    assert.deepEqual(c.deleted, [{ id: 'a', at: 50 }]);
  });
});

describe('并发写不再互相覆盖', () => {
  test('并发两次删除（不排队，靠条件写）→ 两批条目都消失', async () => {
    for (let round = 0; round < 20; round++) {
      const s3 = seeded(IDS);
      await Promise.all([
        deleteSessionBackups(s3, PREFIX, ['s1', 's2', 's3']),
        deleteSessionBackups(s3, PREFIX, ['s4', 's5']),
      ]);
      assert.deepEqual(s3.ids(), ['s0', 's6', 's7', 's8', 's9']);
      assert.deepEqual(s3.catalog().deleted!.map((t) => t.id).sort(), ['s1', 's2', 's3', 's4', 's5']);
    }
  });

  test('删除和同步交错：同步拿着旧条目（含刚删的）写回 → 删掉的不复活', async () => {
    for (let round = 0; round < 20; round++) {
      const s3 = seeded(IDS);
      /* 同步那一轮：本机所有会话都出条目，uploadedAt 是上次真传的时刻（早于删除）—— 和 index.ts 一样 */
      const fresh = IDS.map((id) => entry(id, { from: 'win', syncedAt: Date.now(), uploadedAt: 1000 }));
      await Promise.all([
        deleteSessionBackups(s3, PREFIX, ['s1', 's2']),
        (async () => { await sleep(Math.random() * 6); await writeSyncCatalog(s3, PREFIX, fresh); })(),
      ]);
      assert.deepEqual(s3.ids(), ['s0', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
    }
  });

  test('删除之后另一台机器真的重新上传了（uploadedAt 晚于删除）→ 条目回来', async () => {
    const s3 = seeded(IDS);
    const t0 = Date.now();
    await deleteSessionBackups(s3, PREFIX, ['s1'], t0);
    assert.ok(!s3.ids().includes('s1'));
    s3.seed(`${PREFIX}/v1/sessions/s1/record.json`, '{}');
    await writeSyncCatalog(s3, PREFIX, [entry('s1', { from: 'mac', uploadedAt: t0 + 5 })], t0 + 10);
    assert.ok(s3.ids().includes('s1'));
    assert.equal((s3.catalog().deleted || []).some((t) => t.id === 's1'), false);
  });

  test('另一台机器只是拿旧条目来写（没重新上传）→ 不复活', async () => {
    const s3 = seeded(IDS);
    const t0 = Date.now();
    await deleteSessionBackups(s3, PREFIX, ['s1'], t0);
    await writeSyncCatalog(s3, PREFIX, [entry('s1', { from: 'mac', uploadedAt: t0 - 60_000 })], t0 + 10);
    assert.ok(!s3.ids().includes('s1'));
  });

  test('桶不认条件写时：同一台机器上排队 + 写前重读，连点删除也不互相覆盖', async () => {
    const s3 = seeded(IDS, { honorConditions: false });
    const q = serialQueue();
    await Promise.all([['s1'], ['s2'], ['s3']].map((ids) => q(() => deleteSessionBackups(s3, PREFIX, ids))));
    assert.deepEqual(s3.ids(), ['s0', 's4', 's5', 's6', 's7', 's8', 's9']);
  });

  test('假 S3 端到端：连点 3 次删除 + 中间插一次定时同步 → catalog 只剩没删的', async () => {
    for (let round = 0; round < 10; round++) {
      const s3 = seeded(IDS, { jitter: 8 });
      const q = serialQueue();
      /* 同步那一轮：开头读 catalog（做冲突检测），中间传文件，最后写 catalog —— 只有最后一步进队列 */
      const sync = (async () => {
        await s3.get(catalogKey(PREFIX));
        await sleep(Math.random() * 10);
        await s3.put(`${PREFIX}/v1/sessions/s0/transcript.jsonl`, Buffer.from('new'), null);
        const fresh = IDS.map((id) => entry(id, { from: 'win', syncedAt: Date.now(), uploadedAt: id === 's0' ? Date.now() : 1000 }));
        await q(() => writeSyncCatalog(s3, PREFIX, fresh));
      })();
      const clicks = [['s1', 's2'], ['s3'], ['s4', 's5', 's6']].map(async (ids, i) => {
        await sleep(i * 3);
        return q(() => deleteSessionBackups(s3, PREFIX, ids));
      });
      await Promise.all([sync, ...clicks]);
      assert.deepEqual(s3.ids(), ['s0', 's7', 's8', 's9']);
      /* 文件也确实删了 */
      assert.deepEqual([...await s3.sessionIds()].sort(), ['s0', 's7', 's8', 's9']);
    }
  });

  test('一直冲突就放弃，不覆盖对方', async () => {
    const io = { get: async () => ({ text: '{"version":1,"entries":[]}', etag: '"x"' }), put: async () => 'conflict' as const };
    await assert.rejects(updateCatalog(io, (c) => c, { tries: 3 }), /3 次/);
  });

  test('读不懂的 catalog：删除那一路报错、不整份盖掉', async () => {
    const s3 = new FakeS3();
    s3.seed(catalogKey(PREFIX), 'not json');
    await assert.rejects(updateCatalog(catalogIO(s3, PREFIX), (c) => c));
    assert.equal(s3.objects.get(catalogKey(PREFIX))!.body.toString(), 'not json');
  });

  test('队列：前一个失败不挡后一个，按顺序跑', async () => {
    const q = serialQueue();
    const seen: number[] = [];
    const a = q(async () => { await sleep(5); seen.push(1); throw new Error('x'); });
    const b = q(async () => { seen.push(2); return 2; });
    await assert.rejects(a);
    assert.equal(await b, 2);
    assert.deepEqual(seen, [1, 2]);
  });
});

describe('没文件的条目', () => {
  test('同步时一次性清理：没文件 + 有 delete marker → 移掉并带回来写日志；没 marker 的留着；条目说刚传过、文件却不在的也不留', async () => {
    const s3 = seeded(['a', 'b', 'c', 'd']);
    /* a、b 的文件被老版本删了（delete marker），catalog 条目还在 —— 实测桶里那 18 条就是这样 */
    for (const k of await s3.list(`${PREFIX}/v1/sessions/a/`)) await s3.del(k);
    for (const k of await s3.list(`${PREFIX}/v1/sessions/b/`)) await s3.del(k);
    /* c 的文件没了但看不出来是怎么没的（没开版本控制）—— 不自动清，交给恢复页的「从目录里移除」 */
    for (const k of await s3.list(`${PREFIX}/v1/sessions/c/`)) s3.objects.delete(k);
    /* b 的条目说比 delete marker 晚传过，但文件此刻不在 —— 不凭上传时间留它（审查意见：文件不存在时不许复活） */
    const r = await writeSyncCatalog(s3, PREFIX, [entry('b', { uploadedAt: Date.now() + 1000 })]);
    assert.deepEqual(r.removed.map((x) => x.id).sort(), ['a', 'b']);
    assert.deepEqual(s3.ids(), ['c', 'd']);
  });

  test('本机还留着本地副本、但没重新上传（uploadedAt 早于 delete marker）→ 本机这一轮的条目也清掉', async () => {
    const s3 = seeded(['a', 'b']);
    for (const k of await s3.list(`${PREFIX}/v1/sessions/a/`)) await s3.del(k);
    const r = await writeSyncCatalog(s3, PREFIX, [entry('a', { from: 'win', syncedAt: Date.now(), uploadedAt: 1000 })]);
    assert.deepEqual(r.removed.map((x) => x.id), ['a']);
    assert.deepEqual(s3.ids(), ['b']);
  });

  test('恢复页：没文件的条目标成 missing（带删除时刻），有文件的不标', async () => {
    const s3 = seeded(['a', 'b']);
    for (const k of await s3.list(`${PREFIX}/v1/sessions/a/`)) await s3.del(k);
    const present = await s3.sessionIds();
    const miss = await missingEntries(s3, s3.catalog(), present);
    const out = markMissing(s3.catalog().entries, miss);
    const a = out.find((e) => e.id === 'a')!;
    const b = out.find((e) => e.id === 'b')!;
    assert.equal(a.missing, true);
    assert.ok((a.deletedAt || 0) > 0);
    assert.equal(b.missing, false);
  });

  test('从目录里移除：只移确实没文件的，有文件的留着', async () => {
    const s3 = seeded(['a', 'b']);
    for (const k of await s3.list(`${PREFIX}/v1/sessions/a/`)) await s3.del(k);
    const r = await forgetMissingEntries(s3, PREFIX, ['a', 'b']);
    assert.deepEqual(r, { removed: ['a'], kept: ['b'] });
    assert.deepEqual(s3.ids(), ['b']);
  });

  test('CommonPrefixes → 会话 id（别的前缀、怪名字不算）', () => {
    const ids = sessionIdsFromPrefixes(PREFIX, [`${PREFIX}/v1/sessions/s_1/`, `${PREFIX}/v1/memory/`, `${PREFIX}/v1/sessions/../`]);
    assert.deepEqual([...ids], ['s_1']);
  });
});

describe('接线（index.ts）', () => {
  const MI = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  test('catalog 不再有「读快照 → 整份 putObject」的写法', () => {
    assert.doesNotMatch(MI, /putObject\(creds!?, catalogKey\(/);
  });
  test('删除 / 同步 / 恢复 / 以本机为准 / 从目录里移除都走同一个队列', () => {
    const uses = MI.match(/catalogQueue\(/g) || [];
    assert.ok(uses.length >= 6, `catalogQueue 用了 ${uses.length} 处`);
    assert.match(MI, /writeSyncCatalog\(/);
    assert.match(MI, /deleteSessionBackups\(/);
    assert.match(MI, /forgetMissingEntries\(/);
    assert.match(MI, /ipcMain\.handle\('s3:forget-backups'/);
  });
});

describe('S3 列表解析', () => {
  test('CommonPrefixes', async () => {
    const { parseCommonPrefixes } = await import('../src/main/s3Client.ts');
    const xml = '<ListBucketResult><CommonPrefixes><Prefix>k/v1/sessions/a/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>k/v1/sessions/b&amp;c/</Prefix></CommonPrefixes></ListBucketResult>';
    assert.deepEqual(parseCommonPrefixes(xml), ['k/v1/sessions/a/', 'k/v1/sessions/b&c/']);
  });
  test('ListObjectVersions：只看 IsLatest；最新全是 delete marker → 取最晚的时刻；有活的最新版本 → live', async () => {
    const { parseVersionsPage } = await import('../src/main/s3Client.ts');
    const dead = '<R><DeleteMarker><Key>a/record.json</Key><IsLatest>true</IsLatest><LastModified>2026-10-22T13:35:00.000Z</LastModified></DeleteMarker>'
      + '<DeleteMarker><Key>a/t.jsonl</Key><IsLatest>true</IsLatest><LastModified>2026-10-22T13:36:00.000Z</LastModified></DeleteMarker>'
      + '<Version><Key>a/t.jsonl</Key><IsLatest>false</IsLatest><LastModified>2026-10-01T00:00:00.000Z</LastModified></Version></R>';
    assert.deepEqual(parseVersionsPage(dead), { live: false, latestMarkerAt: Date.parse('2026-10-22T13:36:00.000Z') });
    const back = '<R><DeleteMarker><Key>a/x</Key><IsLatest>false</IsLatest><LastModified>2026-10-22T13:35:00.000Z</LastModified></DeleteMarker>'
      + '<Version><Key>a/x</Key><IsLatest>true</IsLatest><LastModified>2026-10-23T00:00:00.000Z</LastModified></Version></R>';
    assert.equal(parseVersionsPage(back).live, true);
  });
});

describe('uploadedAt 用真的上传时刻，不用整轮同步结束的时刻', () => {
  test('A 传完 → B 删除 → A 这一轮结束存 marks → A 下一轮没上传：条目不复活、删除记录还在', async () => {
    const { entryUploadedAt, syncMark } = await import('../src/main/catalogStore.ts');
    const s3 = seeded(['a', 'b']);
    const t1 = Date.now() - 10_000;        // A 这一轮把 a 的文件传完
    const thisRound = new Map([['a', t1]]);
    await writeSyncCatalog(s3, PREFIX, [entry('a', { from: 'A', uploadedAt: entryUploadedAt('a', thisRound, {}) })]);
    const t2 = t1 + 2_000;                 // B 删除了 a 的备份
    await deleteSessionBackups(s3, PREFIX, ['a'], t2);
    const t3 = t1 + 5_000;                 // A 这一轮结束才存 marks（at 晚于删除）
    const marks = { a: syncMark(t3, 7, thisRound.get('a')) };
    assert.equal(marks.a.at, t3);
    assert.equal(marks.a.uploadedAt, t1);
    /* A 下一轮：a 没变、没上传 —— uploadedAt 只能是 t1，不能是 marks.at（t3 > t2 会把删除记录作废） */
    const next = entryUploadedAt('a', new Map(), marks);
    assert.equal(next, t1);
    await writeSyncCatalog(s3, PREFIX, [entry('a', { from: 'A', uploadedAt: next })]);
    assert.ok(!s3.ids().includes('a'), '没文件的条目不能复活');
    assert.ok((s3.catalog().deleted || []).some((t) => t.id === 'a'), '删除记录不能被清掉');
  });

  test('老的 marks 只有 at（整轮时刻，不可信）→ 不当上传时刻用', async () => {
    const { entryUploadedAt } = await import('../src/main/catalogStore.ts');
    assert.equal(entryUploadedAt('a', new Map(), { a: { at: 999, updatedAt: 1 } }), undefined);
    assert.equal(entryUploadedAt('a', new Map([['a', 5]]), { a: { at: 999, updatedAt: 1, uploadedAt: 3 } }), 5);
  });

  test('接线：同步和「以本机为准」都存真的上传时刻', () => {
    const MI = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.doesNotMatch(MI, /marks\[e\.id\]\?\.at/);
    assert.match(MI, /entryUploadedAt\(e\.id, uploadedAtBySession, marks\)/);
    assert.match(MI, /marks\[id\] = syncMark\(now, byId\.get\(id\)\?\.updatedAt \|\| 0, uploadedAtBySession\.get\(id\)\)/);
    assert.match(MI, /marks\[sessionId\] = syncMark\(Date\.now\(\), rec\?\.updatedAt \|\| 0, lastPutAt \|\| undefined\)/);
  });
});

describe('乱序删除：同一个 id 的删除记录取最晚的', () => {
  test('已有删除时间 200，再写一条 100 → 留 200；uploadedAt=150 的旧条目不复活', () => {
    const c0: Catalog = { version: 1, entries: [], deleted: [{ id: 'a', at: 200 }] };
    const c1 = withTombstones(c0, ['a'], 100);
    assert.deepEqual(c1.deleted, [{ id: 'a', at: 200 }]);
    const n = normalizeCatalog({ ...c1, entries: [entry('a', { uploadedAt: 150 })] }, 1000);
    assert.equal(n.entries.length, 0);
    assert.deepEqual(n.deleted, [{ id: 'a', at: 200 }]);
  });

  test('假 S3：较晚删除先写、较早删除后写 → 旧条目照样不复活', async () => {
    const s3 = seeded(['a', 'b']);
    const now = Date.now();
    await deleteSessionBackups(s3, PREFIX, ['a'], now);           // B：较晚的删除先写进去
    await deleteSessionBackups(s3, PREFIX, ['a'], now - 5_000);   // A：较早开始、较晚写入
    assert.deepEqual(s3.catalog().deleted, [{ id: 'a', at: now }]);
    await writeSyncCatalog(s3, PREFIX, [entry('a', { from: 'C', uploadedAt: now - 2_000 })], now + 10);
    assert.ok(!s3.ids().includes('a'));
  });
});

describe('删除和上传交错、桶没开版本控制（看不到 delete marker）', () => {
  test('删除开始 → 同步上传完成 → 删除删掉刚传的文件 → 同步写目录：条目不回来', async () => {
    const s3 = seeded(['a', 'b'], { versioned: false, jitter: 0 });
    let uploadedAt = 0;
    /* 删除：开始时先等一下，让同步的上传先完成；删除记录要用文件真删完的时刻 */
    const slowList = s3.list.bind(s3);
    let first = true;
    s3.list = async (pfx: string) => {
      if (first && pfx.includes('/sessions/a/')) {
        first = false;
        await s3.put(`${PREFIX}/v1/sessions/a/transcript.jsonl`, Buffer.from('new'), null);   // 同步的上传
        uploadedAt = Date.now();
        await sleep(5);
      }
      return slowList(pfx);
    };
    const startedAt = Date.now() - 1_000;   // 删除「开始」的时刻早于上传
    await deleteSessionBackups(s3, PREFIX, ['a']);
    s3.list = slowList;
    assert.ok(uploadedAt >= startedAt);
    assert.deepEqual([...await s3.sessionIds()].sort(), ['b'], 'a 的文件确实删光了');
    const t = (s3.catalog().deleted || []).find((x) => x.id === 'a');
    assert.ok(t && t.at >= uploadedAt, '删除记录的时刻不早于那次上传');
    await writeSyncCatalog(s3, PREFIX, [entry('a', { from: 'win', uploadedAt })]);
    assert.ok(!s3.ids().includes('a'), '没文件的条目不能复活');
    assert.ok((s3.catalog().deleted || []).some((x) => x.id === 'a'), '删除记录不能被清掉');
  });

  test('条目的 uploadedAt 比删除记录新、但桶里没有文件（也看不到 marker）→ 不凭上传时间清掉删除记录', async () => {
    const s3 = seeded(['a', 'b'], { versioned: false });
    for (const k of await s3.list(`${PREFIX}/v1/sessions/a/`)) await s3.del(k);
    const now = Date.now();
    s3.seed(catalogKey(PREFIX), JSON.stringify({ version: 1, entries: [entry('b')], deleted: [{ id: 'a', at: now - 10_000 }] }));
    await writeSyncCatalog(s3, PREFIX, [entry('a', { from: 'win', uploadedAt: now - 5_000 })], now);
    assert.ok(!s3.ids().includes('a'));
    assert.deepEqual(s3.catalog().deleted, [{ id: 'a', at: now - 10_000 }]);
  });

  test('删除记录之后真的重新上传了、文件也在 → 照样回来', async () => {
    const s3 = seeded(['a'], { versioned: false });
    const now = Date.now();
    s3.seed(catalogKey(PREFIX), JSON.stringify({ version: 1, entries: [], deleted: [{ id: 'a', at: now - 10_000 }] }));
    await writeSyncCatalog(s3, PREFIX, [entry('a', { from: 'mac', uploadedAt: now - 5_000 })], now);
    assert.ok(s3.ids().includes('a'));
    assert.equal(s3.catalog().deleted, undefined);
  });
});
