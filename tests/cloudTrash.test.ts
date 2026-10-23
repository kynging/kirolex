import assert from 'node:assert/strict';
import { describe, test, afterEach } from 'node:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  decideCleanup, buildDeviceManifest, withDeviceManifest, cleanupSettings, daysLeft, trashExpired,
  deletionsFromTrashNames, trashDirName, parseTrashDirName, runCloudCleanup, listCloudTrash,
  restoreFromCloudTrash, purgeCloudTrashItem, readDeletionMarks, noteDeletion, forgetDeletion, pruneDeletionMarks,
  updateCatalog, deleteTrashObjects, CATALOG_WRITE_TRIES, DAY_MS, type BucketOps,
  loadOrCreateDeviceId, deleteOriginalVersion, probeConditionalDelete,
  lastUploadOf, UPLOAD_MARGIN_MS,
  sessionsInUse, rebuiltHold,
  updateTrashMeta, RESTORE_LOCK_STALE_MS,
  deleteAllVersions,
} from '../src/main/cloudTrash.ts';
import { mergeCatalog, catalogKey, type Catalog, type CatalogEntry } from '../src/main/s3Sync.ts';
import { writeSyncCatalog, updateCatalog as updateCatalogStore, catalogIO, type CatalogBucket } from '../src/main/catalogStore.ts';

/*
 * 「云端备份里的会话，如果在所有设备上都已经不在，就应该自动丢进回收站，过一定期限后清空」。
 * 绝不允许误删：所有拿不准的情况都按「不清理」处理 —— 下面每个"不清"的用例守的都是这一条。
 */

const H = 3600_000;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const entry = (id: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, title: `标题-${id}`, updatedAt: T0, bytes: 1, from: 'A', syncedAt: T0, ...over,
});
const dev = (machine: string, syncedAt: number, sessions: string[], deleted: Record<string, number> = {}) =>
  buildDeviceManifest(machine, syncedAt, sessions.map((id) => ({ id })), deleted);
const cat = (entries: CatalogEntry[], ...devices: ReturnType<typeof dev>[]): Catalog =>
  devices.reduce((c, d) => withDeviceManifest(c, d), { version: 1, entries } as Catalog);
const ids = (c: Catalog, now: number, activeDays = 90) => decideCleanup(c, { now, activeDays }).candidates.map((x) => x.entry.id);

describe('decideCleanup：多台设备清单组合', () => {
  const now = T0 + 3 * DAY_MS;

  test('所有活跃设备都没有 + 有删除记录 → 清', () => {
    const c = cat([entry('s1')], dev('A', T0 + DAY_MS, [], { s1: T0 + H }), dev('B', T0 + 2 * DAY_MS, []));
    const d = decideCleanup(c, { now, activeDays: 90 });
    assert.equal(d.blocked, null);
    assert.deepEqual(d.candidates.map((x) => x.entry.id), ['s1']);
    assert.deepEqual(d.candidates[0].deletedBy, ['A']);
    assert.match(d.candidates[0].reason, /A 在 .* 删除/);
  });

  test('任一台活跃设备还有（项目里 / 未分组 / 已归档都算有）→ 不清', () => {
    const b = buildDeviceManifest('B', T0 + 2 * DAY_MS, [{ id: 's1', archived: true }], {});
    const c = cat([entry('s1')], dev('A', T0 + DAY_MS, [], { s1: T0 + H }), b);
    assert.deepEqual(ids(c, now), []);
  });

  test('超过 N 天没同步的设备不参与：它还留着也照清；它读不懂也不挡', () => {
    const old = dev('C', T0 - 100 * DAY_MS, ['s1']);
    const c = cat([entry('s1')], dev('A', T0 + DAY_MS, [], { s1: T0 + H }), old);
    const d = decideCleanup(c, { now, activeDays: 90 });
    assert.deepEqual(d.candidates.map((x) => x.entry.id), ['s1']);
    assert.equal(d.devices.find((x) => x.machine === 'C')!.active, false);
    /* N 改大到把 C 也算进来 → C 还有 → 不清 */
    assert.deepEqual(ids(c, now, 200), []);
    const broken = { ...c, devices: { ...c.devices, C: { machine: 'C', syncedAt: T0 - 100 * DAY_MS, sessions: 'x' } as any } };
    assert.deepEqual(ids(broken, now), ['s1']);
  });

  test('某台活跃设备的清单读不到（形状不对）→ 整轮不清', () => {
    const c = cat([entry('s1')], dev('A', T0 + DAY_MS, [], { s1: T0 + H }));
    c.devices!.B = { machine: 'B', syncedAt: T0 + DAY_MS, sessions: null } as any;
    const d = decideCleanup(c, { now, activeDays: 90 });
    assert.match(String(d.blocked), /读不到.*B/);
    assert.deepEqual(d.candidates, []);
  });

  test('最近往桶里传过、却没有清单的机器（旧版本）→ 整轮不清；太久以前的不挡', () => {
    const c = cat([entry('s1'), entry('s2', { from: 'OLD', syncedAt: T0 + DAY_MS })], dev('A', T0 + 2 * DAY_MS, [], { s1: T0 + H }));
    assert.match(String(decideCleanup(c, { now, activeDays: 90 }).blocked), /OLD/);
    const c2 = cat([entry('s1'), entry('s2', { from: 'OLD', syncedAt: T0 - 200 * DAY_MS })], dev('A', T0 + 2 * DAY_MS, [], { s1: T0 + H }));
    assert.deepEqual(ids(c2, now), ['s1']);
  });

  test('某台活跃设备的清单比这条最后一次上传还旧 → 不清', () => {
    /* B 最后一次同步在 s1 被（B 自己或别人）上传之前：B 还没说过它有没有 */
    const c = cat([entry('s1', { syncedAt: T0 + 2 * DAY_MS })], dev('A', T0 + 3 * DAY_MS - H, [], { s1: T0 + 2 * DAY_MS + H }), dev('B', T0 + DAY_MS, []));
    const d = decideCleanup(c, { now, activeDays: 90 });
    assert.deepEqual(d.candidates, []);
    assert.match(d.undecided[0].why, /B 的清单/);
  });

  test('有删除记录，但那台机器的清单早于删除时间 → 不清', () => {
    const a = dev('A', T0 + DAY_MS, [], {});
    a.deleted.push({ id: 's1', at: T0 + 2 * DAY_MS });         // 删除记录比清单还新：数据对不上
    const c = cat([entry('s1')], a, dev('B', T0 + 2 * DAY_MS, []));
    const d = decideCleanup(c, { now, activeDays: 90 });
    assert.deepEqual(d.candidates, []);
    assert.match(d.undecided[0].why, /A 的清单早于/);
  });

  test('没有任何删除记录 → 不清（重装后清单是空的机器不会把整桶判成"都没有了"）', () => {
    const c = cat([entry('s1'), entry('s2')], dev('A', T0 + DAY_MS, []), dev('B', T0 + 2 * DAY_MS, []));
    assert.deepEqual(ids(c, now), []);
  });

  test('只有不活跃设备有删除记录 → 不清', () => {
    const c = cat([entry('s1', { syncedAt: T0 - 200 * DAY_MS })], dev('A', T0 + DAY_MS, []), dev('OLD', T0 - 100 * DAY_MS, [], { s1: T0 - 101 * DAY_MS }));
    assert.deepEqual(ids(c, now), []);
  });

  test('从云端回收站恢复过：恢复之前的删除记录不算数，之后新的删除才算', () => {
    const e = entry('s1', { restoredFromTrashAt: T0 + 2 * H });
    assert.deepEqual(ids(cat([e], dev('A', T0 + DAY_MS, [], { s1: T0 + H })), now), []);
    assert.deepEqual(ids(cat([e], dev('A', T0 + DAY_MS, [], { s1: T0 + 3 * H })), now), ['s1']);
  });

  test('没有活跃设备 / 没有 catalog → 不清', () => {
    assert.match(String(decideCleanup(cat([entry('s1')]), { now, activeDays: 90 }).blocked), /没有活跃设备/);
    assert.match(String(decideCleanup(null, { now, activeDays: 90 }).blocked), /catalog/);
  });
});

describe('清单与删除记录', () => {
  test('本机有的以"有"为准：删了又恢复回来的不报删除；重复 id 去掉', () => {
    const m = buildDeviceManifest('A', 10, [{ id: 'a', project: 'P' }, { id: 'a' }, { id: 'b', archived: true }], { a: 5, c: 6, future: 99 });
    assert.deepEqual(m.sessions, [{ id: 'a', project: 'P' }, { id: 'b', archived: true }]);
    assert.deepEqual(m.deleted, [{ id: 'c', at: 6 }]);
    assert.equal(m.syncedAt, 10);
  });

  test('mergeCatalog 不丢 devices（丢了就等于清单读不到）', () => {
    const c = cat([entry('s1')], dev('A', 5, ['s1']));
    assert.equal(mergeCatalog(c, [entry('s2')]).devices!.A.syncedAt, 5);
  });

  test('从本机回收站目录名补删除记录；认不出的跳过', () => {
    const at = Date.parse('2026-10-20T08:09:10.123Z');
    const name = `s_17__${new Date(at).toISOString().replace(/[:.]/g, '-')}`;
    assert.deepEqual(deletionsFromTrashNames([name, 'restore-20261020-080910', 'memory-pull-1', 'x__bad']), { s_17: at });
  });

  let dir = '';
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ''; });
  test('删除记录的读写：记 / 取新时间 / 恢复后作废 / 一年前的清掉', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-deleted-'));
    const f = path.join(dir, 's3-deleted-at.json');
    assert.deepEqual(readDeletionMarks(f), {});
    noteDeletion(f, 's1', 100); noteDeletion(f, 's1', 50); noteDeletion(f, '../bad', 1);
    assert.deepEqual(readDeletionMarks(f), { s1: 100 });
    forgetDeletion(f, 's1');
    assert.deepEqual(readDeletionMarks(f), {});
    assert.deepEqual(pruneDeletionMarks({ a: T0, b: T0 - 400 * DAY_MS }, T0), { a: T0 });
  });
});

describe('回收站到期计算', () => {
  test('还剩几天、到期了没有；时间未知的永远不自动到期', () => {
    assert.equal(daysLeft(T0, T0, 30), 30);
    assert.equal(daysLeft(T0, T0 + DAY_MS + 1, 30), 29);
    assert.equal(daysLeft(T0, T0 + 31 * DAY_MS, 30), 0);
    assert.equal(trashExpired(T0, T0 + 30 * DAY_MS - 1, 30), false);
    assert.equal(trashExpired(T0, T0 + 30 * DAY_MS, 30), true);
    assert.equal(trashExpired(0, T0 + 999 * DAY_MS, 30), false);
  });

  test('设置：默认开 / 90 天 / 30 天；乱填回到默认，上限 3650', () => {
    assert.deepEqual(cleanupSettings({}), { enabled: true, activeDays: 90, trashDays: 30 });
    assert.deepEqual(cleanupSettings({ autoCleanCloud: false, activeDeviceDays: '7', cloudTrashDays: 0 }), { enabled: false, activeDays: 7, trashDays: 30 });
    assert.equal(cleanupSettings({ activeDeviceDays: 99999 }).activeDays, 3650);
  });

  test('回收站目录名：带 id 和时间，能解析回来', () => {
    const at = Date.parse('2026-10-23T08:09:10.123Z');
    assert.equal(trashDirName('s_1', at), 's_1__20261023-080910-123');
    assert.deepEqual(parseTrashDirName('s_1__20261023-080910-123'), { id: 's_1', at });
    assert.equal(parseTrashDirName('../x'), null);
  });
});

/* ------------------------------------------------------------ 假 S3 */

/**
 * 内存里的桶。每次写入版本号加一当 ETag，`putIf` 和 S3 一样：版本对不上 → 'conflict'。
 * 钩子：`failPutOn` / `failDelOn` 让某个 key 写 / 删失败；`beforePutIf` 在条件写真正比对之前跑一次
 * （用来模拟"就在这一刻，另一台机器写了 catalog"）。
 */
type FakeBucket = BucketOps & {
  data: Map<string, Buffer>;
  failPutOn?: (key: string) => boolean;
  failDelOn?: (key: string) => boolean;
  beforePutIf?: (key: string) => void;
  /** 模拟不返回 ETag 的 S3 兼容存储 */
  noEtag?: boolean;
  /** 模拟开了版本控制的桶（每次写入一个新 VersionId；删具体版本时更旧的那版顶上来） */
  versioning?: boolean;
  /** 模拟暂停了版本控制的桶：新写入覆盖 null 版本（版本号还是 "null"），读回来带 "null" */
  suspended?: boolean;
  /** 让删某个具体版本失败（模拟"删到一半网络断了"） */
  failDelVersion?: (key: string, vid: string) => boolean;
  /** 模拟不支持条件删除的存储（delIf 回 'unsupported'） */
  noCondDelete?: boolean;
  /** 模拟悄悄忽略 If-Match 的存储（条件删除照删不误） */
  ignoreIfMatch?: boolean;
  /** 让某个 key 的条件写抛错（网络错误） */
  failPutIfOn?: (key: string) => boolean;
  /** 条件写成功之后跑一次（模拟"catalog 刚写完，另一台设备就往原位置传了新内容"） */
  afterPutIf?: (key: string) => void;
  /** 普通写 catalog 之前跑一次（模拟没有条件写时，别的机器恰好在这一刻写了） */
  beforePut?: (key: string) => void;
};
function fakeBucket(): FakeBucket {
  const data = new Map<string, Buffer>();
  const ver = new Map<string, number>();
  /*
    每个 key 的版本栈，从新到旧：{ vid, body } 是版本，{ vid, marker } 是删除标记。和真 S3 一样：
    · 没开版本控制：写入 = 唯一一个 VersionId 为 "null" 的版本（覆盖旧的 null 版本）；普通删除 = 删掉它；
    · 开了版本控制：写入 = 压一个新版本；普通删除 = 压一个删除标记（版本都还在，只是看不见）；
    · 开版本控制之前写的 null 版本，开了之后还留在栈底（"混合"）；
    · 现在可见的对象 = 栈顶，栈顶是删除标记就看不见。
  */
  const stacks = new Map<string, Array<{ vid: string; body?: Buffer; marker?: boolean }>>();
  let n = 0;
  /* ETag 和真 S3 一样是内容的 MD5：内容一样 → ETag 一样（恢复写回同样的内容，ETag 认不出它是新的） */
  const md5 = (body: Buffer) => `"${crypto.createHash('md5').update(body).digest('hex')}"`;
  const rawSet = data.set.bind(data);
  const rawDelete = data.delete.bind(data);
  /* 按栈顶刷新"现在可见的对象" */
  const refresh = (key: string) => {
    const top = (stacks.get(key) || [])[0];
    if (top && !top.marker) { rawSet(key, Buffer.from(top.body!)); ver.set(key, ++n); }
    else { rawDelete(key); ver.delete(key); }
    if (!(stacks.get(key) || []).length) stacks.delete(key);
  };
  const write = (key: string, body: Buffer) => {
    n += 1;
    const list = stacks.get(key) || [];
    if (b.versioning) stacks.set(key, [{ vid: `v${n}`, body: Buffer.from(body) }, ...list]);
    else stacks.set(key, [{ vid: 'null', body: Buffer.from(body) }, ...list.filter((v) => v.vid !== 'null')]);
    refresh(key);
  };
  /* 普通删除：开了版本控制就压一个删除标记（版本都还在）；没开就删掉 null 版本 */
  const remove = (key: string) => {
    n += 1;
    const list = stacks.get(key) || [];
    if (b.versioning) stacks.set(key, [{ vid: `dm${n}`, marker: true }, ...list]);
    /* 暂停版本控制：普通删除把 null 版本换成一个 null 删除标记（别的版本还在） */
    else if (b.suspended) stacks.set(key, [{ vid: 'null', marker: true }, ...list.filter((v) => v.vid !== 'null')]);
    else stacks.set(key, list.filter((v) => v.vid !== 'null'));
    refresh(key);
  };
  const b: any = {
    data,
    versioning: false,
    /* lastModified 用版本号代替服务器时间：每写一次就变 */
    async list(prefix: string) { return [...data.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key, size: data.get(key)!.length, lastModified: String(ver.get(key)), etag: md5(data.get(key)!) })); },
    async get(key: string) { return data.has(key) ? Buffer.from(data.get(key)!) : null; },
    async put(key: string, body: Buffer) {
      if (b.failPutOn?.(key)) throw new Error(`put 失败 ${key}`);
      const hook = b.beforePut; if (hook) { b.beforePut = undefined; hook(key); }
      write(key, body);
    },
    async del(key: string) { if (b.failDelOn?.(key)) throw new Error(`del 失败 ${key}`); remove(key); },
    async getWithEtag(key: string) {
      const body = await b.get(key);      // 走 get：测试里对 get 的拦截对它也生效
      if (!body) return null;
      const top = (stacks.get(key) || [])[0];
      return { body, etag: b.noEtag ? '' : md5(body), ...((b.versioning || b.suspended) && top ? { versionId: top.vid } : null)   /* 和真 S3 一样：开过版本控制的桶（开着 / 暂停）读 null 那一版，回的是 "null" */ };
    },
    async putIf(key: string, body: Buffer, _type: string, cond: { ifMatch: string } | { ifNoneMatch: '*' }) {
      if (b.failPutIfOn?.(key)) throw new Error(`putIf 失败 ${key}`);
      const isMeta = key.endsWith('/.kirolex-trash.json');
      const hook = isMeta ? undefined : b.beforePutIf; if (hook) { b.beforePutIf = undefined; hook(key); }
      const cur = data.has(key) ? md5(data.get(key)!) : null;
      if ('ifMatch' in cond ? cur !== cond.ifMatch : cur !== null) return 'conflict';
      write(key, body);
      const after = isMeta ? undefined : b.afterPutIf; if (after) { b.afterPutIf = undefined; after(key); }
      return 'ok';
    },
    /* 和 S3 一样：If-Match 对不上 → 412（conflict），不删；没有这个对象当删掉了 */
    async delIf(key: string, etag: string) {
      if (b.noCondDelete) return 'unsupported';
      if (b.ignoreIfMatch) { remove(key); return 'ok'; }
      if (b.failDelOn?.(key)) throw new Error(`del 失败 ${key}`);
      if (!data.has(key)) return 'ok';
      if (md5(data.get(key)!) !== etag) return 'conflict';
      remove(key);
      return 'ok';
    },
    /* 删一个具体版本（或删除标记）：删的是栈顶 → 下一个顶上来（真 S3 就是这样） */
    async delVersion(key: string, vid: string) {
      if (b.failDelOn?.(key) || b.failDelVersion?.(key, vid)) throw new Error(`del 失败 ${key} ${vid}`);
      stacks.set(key, (stacks.get(key) || []).filter((v) => v.vid !== vid));
      refresh(key);
    },
    async listVersions(key: string) {
      return (stacks.get(key) || []).map((v, i) => ({ versionId: v.vid, isLatest: i === 0, ...(v.marker ? { isDeleteMarker: true } : null) }));
    },
    async listVersionKeys(prefix: string) {
      return [...stacks.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
  /* 直接改 data 的地方（测试里手写 catalog / 模拟别的设备上传）也算一次写入 */
  data.set = (k: string, v: Buffer) => { write(k, v); return data; };
  /* 直接删 data 的地方（测试里模拟 catalog 不见了等）当普通删除 */
  data.delete = (k: string) => { const had = data.has(k); if (stacks.has(k)) remove(k); else rawDelete(k); return had; };
  return b;
}
const keysUnder = (b: { data: Map<string, Buffer> }, p: string) => [...b.data.keys()].filter((k) => k.startsWith(p)).sort();
const readCat = (b: { data: Map<string, Buffer> }): Catalog => JSON.parse(b.data.get(catalogKey(''))!.toString('utf-8'));

/**
 * 一台机器：本机有哪些会话、删过哪些。sync() 按 runS3Sync 的顺序：读 catalog（快照）→ 传会话 → 并 catalog + 本机清单
 * （条件写入，并进的是桶里**当前**那份）→ 清理。begin() / finish() 把它拆成两半，用来让两台机器的同步交错。
 */
function machine(name: string) {
  const local = new Map<string, { title: string; updatedAt: number }>();
  const deletions: Record<string, number> = {};
  return {
    name, local, deletions,
    create(id: string, at: number) { local.set(id, { title: `标题-${id}`, updatedAt: at }); delete deletions[id]; },
    remove(id: string, at: number) { local.delete(id); deletions[id] = at; },
    /** 同步前半：读 catalog 快照（runS3Sync 开头那次读，冲突检测 / 位置跟随用）、传会话文件。返回后半。 */
    begin(b: FakeBucket, now: number) {
      const raw = b.data.get(catalogKey(''));
      const snapshot: Catalog | null = raw ? JSON.parse(raw.toString('utf-8')) : null;
      for (const [id, r] of local) {
        b.data.set(`v1/sessions/${id}/record.json`, Buffer.from(JSON.stringify({ id, ...r })));
        b.data.set(`v1/sessions/${id}/transcript.jsonl`, Buffer.from(`{"id":"m1","text":"${id}"}\n`));
      }
      const fresh: CatalogEntry[] = [...local].map(([id, r]) => ({ id, title: r.title, updatedAt: r.updatedAt, bytes: 1, from: name, syncedAt: now, uploadedAt: now }));   // 和 runS3Sync 一样：这一轮真传了文件的带 uploadedAt
      const manifest = buildDeviceManifest(name, now, [...local.keys()].map((id) => ({ id })), { ...deletions });
      return {
        snapshot,
        /** 同步后半：和 runS3Sync 一样用 updateCatalog 写，再清理。 */
        finish: async (logs: string[] = []) => {
          await updateCatalog(b, '', (cur) => withDeviceManifest(mergeCatalog(cur, fresh), manifest));
          return runCloudCleanup(b, { now, settings: cleanupSettings({}), thisMachine: name, log: (_l, m) => logs.push(m) });
        },
      };
    },
    async sync(b: FakeBucket, now: number, logs: string[] = []) {
      return this.begin(b, now).finish(logs);
    },
  };
}

describe('端到端（假 S3，两台机器）', () => {
  test('一台删 → 不清；另一台也删 → 进回收站；恢复一次能回来；再删 → 进回收站；到期 → 彻底删除', async () => {
    const b = fakeBucket();
    const A = machine('A'); const B = machine('B');
    const logs: string[] = [];
    let now = T0;
    A.create('s1', now); A.create('s2', now);
    await A.sync(b, now);
    /* B 从备份恢复了 s1，两台都有 */
    now += H; B.create('s1', now); await B.sync(b, now);

    /* 第 1 天：A 删了 s1。B 还有 → 不清 */
    now = T0 + DAY_MS; A.remove('s1', now); now += 60_000;
    let r = await A.sync(b, now, logs);
    assert.deepEqual(r.trashed, []);
    assert.equal(keysUnder(b, 'v1/sessions/s1/').length, 2);

    /* 第 2 天：B 也删了 → 进回收站 */
    now = T0 + 2 * DAY_MS; B.remove('s1', now); now += 60_000;
    r = await B.sync(b, now, logs);
    assert.deepEqual(r.trashed.map((x) => x.id), ['s1']);
    assert.deepEqual(keysUnder(b, 'v1/sessions/s1/'), [], '原件删了');
    assert.equal(readCat(b).entries.some((e) => e.id === 's1'), false, 'catalog 里没有了');
    assert.equal(readCat(b).devices!.A.syncedAt, T0 + DAY_MS + 60_000, '别的机器的清单还在');
    const dir = r.trashed[0].dir;
    assert.equal(keysUnder(b, `v1/trash/${dir}/`).length, 3, '两个对象 + 说明文件');
    assert.ok(logs.some((l) => l.includes('s1') && l.includes('移进云端回收站') && l.includes('原因')), '日志带 id 和原因');
    assert.equal(keysUnder(b, 'v1/sessions/s2/').length, 2, 's2 没人删过，一直在');

    let items = await listCloudTrash(b, '', now, 30);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 's1');
    assert.equal(items[0].title, '标题-s1');
    assert.equal(items[0].daysLeft, 30);
    assert.deepEqual(items[0].deletedBy.sort(), ['A', 'B']);

    /* 第 3 天：用户在回收站页点「恢复到云端备份」→ 回到原位置；之后的同步不会再把它移走 */
    now = T0 + 3 * DAY_MS;
    const back = await restoreFromCloudTrash(b, '', dir, now, (_l, m) => logs.push(m));
    assert.equal(back.restored, 2);
    assert.equal(keysUnder(b, 'v1/sessions/s1/').length, 2);
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
    assert.equal(readCat(b).entries.find((e) => e.id === 's1')?.title, '标题-s1');
    r = await A.sync(b, now + H, logs);
    assert.deepEqual(r.trashed, [], '恢复之前的删除记录不再算数');

    /* A 把它恢复到本机、后来又删了；B 的清单比 A 那次上传旧 → 拿不准，不清；B 同步之后才清 */
    now = T0 + 4 * DAY_MS; A.create('s1', now); await A.sync(b, now);
    now = T0 + 5 * DAY_MS; A.remove('s1', now); now += 60_000;
    r = await A.sync(b, now, logs);
    assert.deepEqual(r.trashed, []);
    assert.ok(r.undecided.some((u) => u.id === 's1'));
    now += H;
    r = await B.sync(b, now, logs);
    assert.deepEqual(r.trashed.map((x) => x.id), ['s1']);
    const trashedAt = now;

    /* 没到期：不删 */
    r = await A.sync(b, trashedAt + 29 * DAY_MS, logs);
    assert.deepEqual(r.purged, []);
    items = await listCloudTrash(b, '', trashedAt + 29 * DAY_MS, 30);
    assert.equal(items[0].daysLeft, 1);
    /* 满 30 天：任意一台同步时彻底删除 */
    r = await A.sync(b, trashedAt + 30 * DAY_MS, logs);
    assert.deepEqual(r.purged.map((x) => x.id), ['s1']);
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
    assert.ok(logs.some((l) => l.includes('s1') && l.includes('彻底删除')));
    assert.equal(keysUnder(b, 'v1/sessions/s2/').length, 2, 's2 自始至终没动');
  });

  test('关掉自动清理 → 什么都不动', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const raw = b.data.get(catalogKey(''))!;
    const c = withDeviceManifest(JSON.parse(raw.toString()), buildDeviceManifest('A', T0 + 2 * H, [], A.deletions));
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(c)));
    const r = await runCloudCleanup(b, { now: T0 + 2 * H, settings: cleanupSettings({ autoCleanCloud: false }), thisMachine: 'A', log: () => {} });
    assert.deepEqual(r.trashed, []);
    assert.equal(keysUnder(b, 'v1/sessions/s1/').length, 2);
  });

  test('复制进回收站中途失败 → 原件和 catalog 都不动，也不留半份', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.failPutOn = (k) => k.startsWith('v1/trash/') && k.endsWith('transcript.jsonl');
    const r = await A.sync(b, T0 + 2 * H);
    assert.deepEqual(r.trashed, []);
    assert.equal(r.errors.length, 1);
    assert.equal(keysUnder(b, 'v1/sessions/s1/').length, 2);
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
    assert.ok(readCat(b).entries.some((e) => e.id === 's1'));
  });

  test('写 catalog 前重新判定：这期间别的机器同步说它还有 → 撤回，原件不动', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    let reads = 0;
    const get = b.get.bind(b);
    b.get = async (key: string) => {
      const v = await get(key);
      if (key === catalogKey('') && v && ++reads === 4) {      // A 同步写 catalog 前读（2）→ 清理第一次读（3）→ 清理条件写之前再读（4）
        const c = withDeviceManifest(JSON.parse(v.toString()), buildDeviceManifest('B', T0 + 3 * H, [{ id: 's1' }], {}));
        return Buffer.from(JSON.stringify(c));
      }
      return v;
    };
    reads = 1;
    const logs: string[] = [];
    const r = await A.sync(b, T0 + 2 * H, logs);
    assert.deepEqual(r.trashed, []);
    assert.ok(logs.some((l) => l.includes('s1') && l.includes('撤回')), '走的是"重新判定后撤回"那条路');
    assert.equal(keysUnder(b, 'v1/sessions/s1/').length, 2);
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
  });

  test('spare 筛掉的（advanced / 读不出 record.json）不动', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const c = withDeviceManifest(readCat(b), buildDeviceManifest('A', T0 + 2 * H, [], A.deletions));
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(c)));
    const r = await runCloudCleanup(b, { now: T0 + 2 * H, settings: cleanupSettings({}), thisMachine: 'A', spare: async (x) => new Set(x), log: () => {} });
    assert.deepEqual(r.trashed, []);
    assert.equal(keysUnder(b, 'v1/sessions/s1/').length, 2);
  });

  test('恢复时原位置已经有的对象不覆盖；手动彻底删除只删这一份', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); A.create('s2', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H); A.remove('s2', T0 + H);
    const r = await A.sync(b, T0 + 2 * H);
    assert.deepEqual(r.trashed.map((x) => x.id).sort(), ['s1', 's2']);
    const d1 = r.trashed.find((x) => x.id === 's1')!.dir;
    const d2 = r.trashed.find((x) => x.id === 's2')!.dir;
    /* 别的机器后来又传了一份 record.json 到原位置 */
    b.data.set('v1/sessions/s1/record.json', Buffer.from('后来的'));
    const back = await restoreFromCloudTrash(b, '', d1, T0 + 3 * H, () => {});
    assert.deepEqual([back.restored, back.kept], [1, 1]);
    assert.equal(b.data.get('v1/sessions/s1/record.json')!.toString(), '后来的');
    const gone = await purgeCloudTrashItem(b, '', d2, () => {});
    assert.equal(gone.deleted, 3);
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
    await assert.rejects(() => restoreFromCloudTrash(b, '', '../evil', T0, () => {}));
  });
});

describe('接线（index.ts / 界面）', () => {
  const M = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const bodyOf = (sig: string, end = '\n}\n') => { const at = M.indexOf(sig); assert.ok(at >= 0, sig); return M.slice(at, M.indexOf(end, at)); };

  test('runS3Sync：本机清单跟 catalog 一起写；清理在 catalog 写完之后、按开关跑、出错不算同步失败', () => {
    const body = bodyOf('async function runS3Sync(');
    /* 写 catalog 走 catalogStore 的 writeSyncCatalog（排队 + 写前重读 + 条件写），本机清单在同一次写里并进去 */
    const put = body.indexOf('writeSyncCatalog(catalogBucket(creds!, cfg.prefix)');
    assert.ok(put > 0, 'catalog 写前重读、条件写入，不再拿开头的快照无条件覆盖');
    assert.equal(body.includes('putObject(creds!, catalogKey(cfg.prefix)'), false);
    assert.ok(body.indexOf('thisDeviceManifest(thisDeviceId(), thisMachine') < put, '本机清单在写 catalog 之前算好');
    assert.match(body.slice(put, put + 260), /\(c\) => withDeviceManifest\(c, manifest\)/, '清单在同一次写里并进桶里当前那份');
    const run = body.indexOf('await runCloudCleanup(');
    assert.ok(run > put, '清理在 catalog 写完之后');
    assert.match(body.slice(body.indexOf('const clean = cleanupSettings(cfg)'), run), /if \(clean\.enabled\)/);
    assert.match(body, /云端清理没跑成（不影响备份）/);
    assert.match(body, /cloudTrashed: cleanup\.trashed\.length, cloudPurged: cleanup\.purged\.length/);
    assert.match(body, /spare: \(cand\) => cloudCleanupSpare\(/);
  });

  test('本机清单：不同步的、advanced 的、sessions/ 下的目录都算"有"；删除记录含本机回收站目录名', () => {
    const body = bodyOf('function thisDeviceManifest(');
    assert.match(body, /store\.listSessions\(\)/);
    assert.match(body, /store\.listAdvancedOnlyIds\(\)/);
    assert.match(body, /walkDirs\(path\.join\(KIROLEX_HOME, 'sessions'\)\)/);
    assert.match(body, /deletionsFromTrashNames\(/);
  });

  test('删会话记删除时间；从备份恢复回本地作废', () => {
    const del = M.indexOf('const purgeSession = async');
    assert.ok(M.slice(del, del + 3000).includes('noteDeletion(S3_DELETED_AT_PATH, sessionId, Date.now())'));
    const restore = bodyOf("ipcMain.handle('s3:restore'", '\n  });\n');
    assert.match(restore, /forgetDeletion\(S3_DELETED_AT_PATH, sessionId\)/);
  });

  test('别的写 catalog 的地方（手动删除备份 / 以本机为准）也是写前重读、只改目标条目', () => {
    /* 这两处用的是 catalogStore.ts 的那一套（main 上的「catalog 并发写」）；这里只守"不拿旧快照整份写回" */
    const del = bodyOf('async function deleteBackupsOf(');
    assert.match(del, /await deleteSessionBackups\(/);
    assert.equal(del.includes('putObject(creds, catalogKey'), false, '不再拿调用方读的快照无条件覆盖');
    const keep = bodyOf('async function keepLocalSession(');
    assert.match(keep, /catalogQueue\(\(\) => updateCatalog\(catalogIO\(/);
    assert.equal(keep.includes('putObject(creds, catalogKey'), false);
    /* 整个 index.ts 里不再有无条件写 catalog 的地方 */
    assert.equal(/putObject\(creds!?, catalogKey\(/.test(M), false);
  });

  test('清单按设备 ID 存，主机名只用来显示', () => {
    assert.match(M, /const DEVICE_ID_PATH = path\.join\(KIROLEX_HOME, 'device-id\.json'\)/);
    assert.match(bodyOf('async function runS3Sync('), /thisDeviceManifest\(thisDeviceId\(\), thisMachine, Date\.now\(\)\)/);
    assert.match(bodyOf('function thisDeviceManifest('), /buildDeviceManifest\(deviceId, now, sessions, deletions, host\)/);
  });

  test('立即彻底删除：主进程要求把目录名原样传回来；界面先弹确认框', () => {
    const body = bodyOf("ipcMain.handle('s3:purge-cloud-trash'", '\n  });\n');
    assert.match(body, /confirm !== dir/);
    const UI = fs.readFileSync(new URL('../src/renderer/components/BackupDialog.tsx', import.meta.url), 'utf8');
    const ask = UI.slice(UI.indexOf('const askPurge'), UI.indexOf('const syncingCount'));
    assert.match(ask, /destructive: true/);
    assert.ok(ask.indexOf('setConfirm(') < ask.indexOf('purgeS3CloudTrash'), '确认之后才发');
    assert.equal(/window\.confirm/.test(ask), false);
  });

  test('同步摘要那一句', async () => {
    const { cleanupSentence } = await import('../src/renderer/backupGroups.ts');
    assert.equal(cleanupSentence({ cloudTrashed: 2, cloudPurged: 1 }), '这次有 2 条移进云端回收站、1 条到期清空。');
    assert.equal(cleanupSentence({}), '', '没跑清理就不说');
    assert.equal(cleanupSentence({ cloudTrashed: 0, cloudPurged: 0 }, 'en'), '0 moved to the cloud trash and 0 expired and cleared this time.');
  });
});

describe('设置页的天数选项', () => {
  test('下拉里有默认值，手改过的当前值也列出来', async () => {
    const { dayChoices, ACTIVE_DEVICE_DAY_CHOICES, CLOUD_TRASH_DAY_CHOICES } = await import('../src/renderer/backupIntervals.ts');
    assert.ok(ACTIVE_DEVICE_DAY_CHOICES.includes(90));
    assert.ok(CLOUD_TRASH_DAY_CHOICES.includes(30));
    assert.deepEqual(dayChoices([7, 30], 45), [7, 30, 45]);
    assert.deepEqual(dayChoices([7, 30], 30), [7, 30]);
    assert.deepEqual(dayChoices([7, 30], 0), [7, 30]);
  });
});

describe('多台机器同时同步：catalog 条件写入，不覆盖别人刚写的清单', () => {
  /*
   * 审查发现的那个场景：A 删了 s1；B 后来把 s1 恢复到了本机，但 B 桶里的清单还是恢复之前那份（没有 s1）。
   * 两台同时同步：A 开头读了快照 → B 整轮同步完（清单里有 s1）→ A 写 catalog。
   * 旧写法拿 A 开头的快照无条件覆盖，B 刚写的"我有 s1"就没了，s1 被判成可清理。
   */
  const setup = async () => {
    const b = fakeBucket();
    const A = machine('A'); const B = machine('B');
    A.create('s1', T0); await A.sync(b, T0);
    await B.sync(b, T0 + H);
    A.remove('s1', T0 + DAY_MS);
    B.create('s1', T0 + DAY_MS + H);                 // B 从备份把 s1 恢复到了本机，还没同步
    return { b, A, B };
  };

  test('旧写法（拿开头快照无条件覆盖）会误判 —— 证明这个用例确实能抓住这个问题', async () => {
    const { b, A, B } = await setup();
    const now = T0 + 2 * DAY_MS;
    const a = A.begin(b, now);                       // A 读快照
    await B.sync(b, now + 1000);                     // B 整轮同步完：清单里有 s1
    assert.ok(readCat(b).devices!.B.sessions.some((x) => x.id === 's1'));
    const fresh = [...A.local].map(([id, r]) => ({ id, title: r.title, updatedAt: r.updatedAt, bytes: 1, from: 'A', syncedAt: now + 2000 }));
    const stale = withDeviceManifest(mergeCatalog(a.snapshot, fresh), buildDeviceManifest('A', now + 2000, [], A.deletions));
    assert.deepEqual(ids(stale, now + 3000), ['s1'], '覆盖之后 B 的新清单没了，s1 被判成可清理');
  });

  test('现在的写法：A 写 catalog 时并进的是桶里当前那份 → B 的清单还在 → s1 不清', async () => {
    const { b, A, B } = await setup();
    const now = T0 + 2 * DAY_MS;
    const a = A.begin(b, now);
    await B.sync(b, now + 1000);
    const r = await a.finish();
    assert.deepEqual(r.trashed, []);
    assert.equal(keysUnder(b, 'v1/sessions/s1/').length, 2);
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
    const c = readCat(b);
    assert.ok(c.devices!.B.sessions.some((x) => x.id === 's1'), 'B 刚写的清单没被 A 抹掉');
    assert.ok(c.devices!.A, 'A 的清单也写进去了');
    assert.ok(c.entries.some((e) => e.id === 's1' && e.from === 'B'));
  });

  test('写 catalog 那一刻正好被别的机器抢先：重新读、重新并，两边的清单都在', async () => {
    const b = fakeBucket();
    const A = machine('A'); const B = machine('B');
    A.create('a1', T0); B.create('b1', T0);
    await B.sync(b, T0);
    const a = A.begin(b, T0 + 1);
    /* A 读完 catalog、条件写还没比对的这一刻，B 又写了一版（多了 b2、清单更新） */
    let raced = 0;
    b.beforePutIf = (key) => {
      if (key !== catalogKey('')) return;
      raced += 1;
      const c = readCat(b);
      c.entries.push({ id: 'b2', title: 'b2', updatedAt: T0, bytes: 1, from: 'B', syncedAt: T0 + 2 });
      b.data.set(key, Buffer.from(JSON.stringify(withDeviceManifest(c, buildDeviceManifest('B', T0 + 2, [{ id: 'b1' }, { id: 'b2' }], {})))));
    };
    const putIf = b.putIf.bind(b);
    const results: string[] = [];
    b.putIf = async (k, body, type, cond) => { const r = await putIf(k, body, type, cond); if (k === catalogKey('')) results.push(r); return r; };
    await a.finish();
    assert.equal(raced, 1);
    assert.deepEqual(results.slice(0, 2), ['conflict', 'ok'], '第一次被抢先，重读重并之后写进去');
    const c = readCat(b);
    assert.deepEqual(c.devices!.B.sessions.map((x) => x.id), ['b1', 'b2'], 'B 抢先写的那版清单没被覆盖');
    assert.deepEqual(Object.keys(c.devices!).sort(), ['A', 'B']);
    assert.deepEqual(c.entries.map((e) => e.id).sort(), ['a1', 'b1', 'b2']);
  });

  test('清理写 catalog 时被抢先、对方说它还有 → 重新判定后撤回，原件和对方的清单都在', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('A', T0 + 2 * H, [], A.deletions)))));
    let raced = false;
    b.beforePutIf = (key) => {
      if (key !== catalogKey('')) return;
      raced = true;                                  // 就在清理写 catalog 的这一刻，B 同步了：它有 s1
      b.data.set(key, Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('B', T0 + 3 * H, [{ id: 's1' }], {})))));
    };
    const logs: string[] = [];
    const r = await runCloudCleanup(b, { now: T0 + 3 * H, settings: cleanupSettings({}), thisMachine: 'A', log: (_l, m) => logs.push(m) });
    assert.ok(raced, '确实走到了条件写入');
    assert.deepEqual(r.trashed, []);
    assert.equal(keysUnder(b, 'v1/sessions/s1/').length, 2);
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
    assert.ok(readCat(b).entries.some((e) => e.id === 's1'));
    assert.ok(readCat(b).devices!.B, 'B 的清单没被覆盖');
    assert.ok(logs.some((l) => l.includes('s1') && l.includes('撤回')));
  });

  test('从回收站恢复写 catalog 时被抢先：重新并，不抹掉对方刚写的清单', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    assert.equal(t.trashed.length, 1);
    /* 恢复先对文件做条件写，再写 catalog：钩子等到写 catalog 那一下才触发 */
    const hook = (key: string) => {
      if (key !== catalogKey('')) { b.beforePutIf = hook; return; }
      b.data.set(key, Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('C', T0 + 3 * H, [{ id: 'c1' }], {})))));
    };
    b.beforePutIf = hook;
    await restoreFromCloudTrash(b, '', t.trashed[0].dir, T0 + 3 * H, () => {});
    const c = readCat(b);
    assert.ok(c.devices!.C, 'C 刚写的清单还在');
    assert.ok(c.entries.find((e) => e.id === 's1')?.restoredFromTrashAt);
  });

  test('一直被抢先：试满次数就放弃并报错，不覆盖对方', async () => {
    const b = fakeBucket();
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify({ version: 1, entries: [] })));
    let others = 0;
    const putIf = b.putIf.bind(b);
    b.putIf = async (k, body, type, cond) => {
      others += 1;
      b.data.set(k, Buffer.from(JSON.stringify({ version: 1, entries: [], devices: { X: { n: others } } })));
      return putIf(k, body, type, cond);
    };
    await assert.rejects(() => updateCatalog(b, '', (cur) => ({ ...(cur || { version: 1, entries: [] }), mine: true } as any)), /抢先/);
    assert.equal(others, CATALOG_WRITE_TRIES);
    assert.equal((readCat(b) as any).mine, undefined, '没有写进去');
  });
});

describe('回收站删除删到一半失败', () => {
  const trashedOne = async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const r = await A.sync(b, T0 + 2 * H);
    assert.equal(r.trashed.length, 1);
    return { b, A, dir: r.trashed[0].dir, at: T0 + 2 * H };
  };

  test('先删内容、最后删说明文件', async () => {
    const { b, dir } = await trashedOne();
    const order: string[] = [];
    /* 回收站的删除现在按版本删（没开版本控制时删的是 "null" 版本），两条路都记下来 */
    const del = b.del.bind(b);
    b.del = async (k) => { order.push(k.split('/').pop()!); return del(k); };
    const delVersion = b.delVersion.bind(b);
    b.delVersion = async (k, v) => { order.push(k.split('/').pop()!); return delVersion(k, v); };
    await deleteTrashObjects(b, keysUnder(b, `v1/trash/${dir}/`));
    assert.equal(order[order.length - 1], '.kirolex-trash.json');
  });

  test('到期清空时 record.json 删不掉：说明文件留着、不算清空、记错误；下次同步接着删完', async () => {
    const { b, A, dir, at } = await trashedOne();
    b.failDelOn = (k) => k.endsWith('record.json');
    const logs: string[] = [];
    let r = await A.sync(b, at + 30 * DAY_MS, logs);
    assert.deepEqual(r.purged, [], '没删完不算已清空');
    assert.ok(r.errors.some((e) => e.includes('record.json')));
    assert.ok(logs.some((l) => l.includes('没删完')));
    assert.ok(b.data.has(`v1/trash/${dir}/.kirolex-trash.json`), '说明文件留着');
    const items = await listCloudTrash(b, '', at + 30 * DAY_MS, 30);
    assert.equal(items.length, 1);
    assert.ok(items[0].trashedAt > 0, '到期信息还在，不会变成"时间未知"');
    b.failDelOn = undefined;
    r = await A.sync(b, at + 31 * DAY_MS);
    assert.deepEqual(r.purged.map((x) => x.id), ['s1']);
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
  });

  test('手动彻底删除删不完：报错，说明文件留着', async () => {
    const { b, dir } = await trashedOne();
    b.failDelOn = (k) => k.endsWith('transcript.jsonl');
    await assert.rejects(() => purgeCloudTrashItem(b, '', dir, () => {}), /删不掉/);
    assert.ok(b.data.has(`v1/trash/${dir}/.kirolex-trash.json`));
  });
});

describe('云存储不返回 ETag（没法条件写入）', () => {
  test('别的机器刚写的清单被普通写覆盖了 → 云端清理整轮不移任何会话', async () => {
    const b = fakeBucket();
    b.noEtag = true;
    const A = machine('A'); const B = machine('B');
    A.create('s1', T0); await A.sync(b, T0);
    await B.sync(b, T0 + H);
    A.remove('s1', T0 + DAY_MS);
    B.create('s1', T0 + DAY_MS + H);                 // B 把 s1 恢复到了本机
    const now = T0 + 2 * DAY_MS;
    const a = A.begin(b, now);
    /* A 读完 catalog、普通写之前，B 正好写了"我有 s1"的清单；A 的普通写把它盖掉 */
    b.beforePut = (key) => {
      if (key !== catalogKey('')) return;
      const c = withDeviceManifest(readCat(b), buildDeviceManifest('B', now + 1000, [{ id: 's1' }], {}));
      b.data.set(key, Buffer.from(JSON.stringify(c)));
    };
    const logs: string[] = [];
    const r = await a.finish(logs);
    assert.equal(readCat(b).devices!.B.sessions.some((x) => x.id === 's1'), false, '确实被覆盖了（这正是要防的那种情况）');
    assert.deepEqual(ids(readCat(b), now + 2000), ['s1'], '只看 catalog 的话 s1 会被判成可清理');
    assert.match(String(r.blocked), /ETag/);
    assert.deepEqual(r.trashed, []);
    assert.equal(keysUnder(b, 'v1/sessions/s1/').length, 2, '原件没动');
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
  });

  test('回收站恢复：没有 ETag 就不改 catalog，报错说清', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    const before = b.data.get(catalogKey(''))!.toString();
    b.noEtag = true;
    await assert.rejects(() => restoreFromCloudTrash(b, '', t.trashed[0].dir, T0 + 3 * H, () => {}), /ETag/);
    assert.equal(b.data.get(catalogKey(''))!.toString(), before, 'catalog 没被改');
    assert.ok(b.data.has(`v1/trash/${t.trashed[0].dir}/.kirolex-trash.json`), '回收站那份还在');
  });

  test('有 ETag 时同步不会走普通写', async () => {
    const b = fakeBucket();
    let plain = 0;
    const put = b.put.bind(b);
    b.put = async (k, body, type) => { if (k === catalogKey('')) plain += 1; return put(k, body, type); };
    const A = machine('A'); A.create('a1', T0);
    await A.sync(b, T0); await A.sync(b, T0 + H);
    assert.equal(plain, 0);
  });
});

describe('移进回收站后原件删到一半失败', () => {
  const trashWithStuckOriginal = async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const logs: string[] = [];
    const r = await A.sync(b, T0 + 2 * H, logs);
    b.failDelOn = undefined;
    assert.equal(r.trashed.length, 1);
    assert.deepEqual(keysUnder(b, 'v1/sessions/s1/'), ['v1/sessions/s1/transcript.jsonl'], '这一个没删掉');
    const meta = JSON.parse(b.data.get(`v1/trash/${r.trashed[0].dir}/.kirolex-trash.json`)!.toString());
    assert.deepEqual(meta.pendingOriginals.map((x: any) => x.key), ['v1/sessions/s1/transcript.jsonl'], '记进了说明文件');
    assert.ok(logs.some((l) => l.includes('没删掉') && l.includes('重试')));
    return { b, A, dir: r.trashed[0].dir, at: T0 + 2 * H };
  };

  test('下次同步重试删掉；到期后回收站也清空 —— 桶里最后什么都不剩', async () => {
    const { b, A, dir, at } = await trashWithStuckOriginal();
    await A.sync(b, at + H);
    assert.deepEqual(keysUnder(b, 'v1/sessions/s1/'), [], '原件重试删掉了');
    const meta = JSON.parse(b.data.get(`v1/trash/${dir}/.kirolex-trash.json`)!.toString());
    assert.equal(meta.pendingOriginals, undefined, '说明文件里的待删记录清掉了');
    const r = await A.sync(b, at + 31 * DAY_MS);
    assert.deepEqual(r.purged.map((x) => x.id), ['s1']);
    assert.deepEqual(keysUnder(b, 'v1/sessions/s1/'), []);
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
  });

  test('还是删不掉：说明文件一直留着，到期也先不清空；能删了再清', async () => {
    const { b, A, dir, at } = await trashWithStuckOriginal();
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    let r = await A.sync(b, at + 31 * DAY_MS);
    assert.deepEqual(r.purged, [], '原件没删完，不清空');
    assert.ok(b.data.has(`v1/trash/${dir}/.kirolex-trash.json`));
    b.failDelOn = undefined;
    r = await A.sync(b, at + 32 * DAY_MS);
    assert.deepEqual(r.purged.map((x) => x.id), ['s1']);
    assert.deepEqual([...keysUnder(b, 'v1/sessions/s1/'), ...keysUnder(b, 'v1/trash/')], []);
  });

  test('原件在移进回收站之后被重新写过 → 不删它', async () => {
    const { b, A, at } = await trashWithStuckOriginal();
    b.data.set('v1/sessions/s1/transcript.jsonl', Buffer.from('后来别的机器重新传的'));
    const logs: string[] = [];
    await A.sync(b, at + H, logs);
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), '后来别的机器重新传的');
    assert.ok(logs.some((l) => l.includes('重新写过')));
  });

  test('这条会话又出现在某台设备的清单里 → 撤回整次移动（不再删原件，回收站那份放回去之后删掉）', async () => {
    const { b, A, dir, at } = await trashWithStuckOriginal();
    const B = machine('B'); B.create('s1', at + H);
    await B.sync(b, at + H);                         // B 又有 s1 了（重新传了上来）
    await A.sync(b, at + 2 * H);
    assert.ok(keysUnder(b, 'v1/sessions/s1/').length >= 2, 'B 那份完整留着');
    assert.deepEqual(keysUnder(b, `v1/trash/${dir}/`), [], '撤回做完，回收站那份删掉');
  });
});

describe('删原件只删复制的那一版（别的设备刚传的新内容不删）', () => {
  /* A 删了 s1；B 其实还有 s1（只是清单还没发布）——B 正好在这时往原位置传了新的 transcript */
  const setup = async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('A', T0 + 2 * H, [], A.deletions)))));
    return { b, A };
  };
  const run = (b: FakeBucket, logs: string[] = []) =>
    runCloudCleanup(b, { now: T0 + 3 * H, settings: cleanupSettings({}), thisMachine: 'A', log: (_l, m) => logs.push(m) });

  test('catalog 刚写完、删原件之前，别的设备传了新内容 → 不删它，整次移动撤回，桶里那份完整', async () => {
    const { b } = await setup();
    b.afterPutIf = (key) => {
      if (key === catalogKey('')) b.data.set('v1/sessions/s1/transcript.jsonl', Buffer.from('B 刚传的新内容'));
    };
    const logs: string[] = [];
    const r = await run(b, logs);
    assert.deepEqual(r.trashed, [], '不算移进了回收站');
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), 'B 刚传的新内容', '新内容没被删');
    assert.ok(b.data.has('v1/sessions/s1/record.json'), '别的原件也都在（删了的从回收站放回来了）');
    assert.ok(readCat(b).entries.some((e) => e.id === 's1'), 'catalog 条目放回去了');
    assert.deepEqual(keysUnder(b, 'v1/trash/'), [], '全放回去之后回收站那份删掉');
    assert.ok(logs.some((l) => l.includes('撤回')));
  });

  test('复制期间原件被更新 → 写 catalog 之前就撤回', async () => {
    const { b } = await setup();
    /* 复制完、写说明文件（条件写）的那一刻，别的设备传了新 transcript */
    const putIf = b.putIf.bind(b);
    let once = false;
    b.putIf = async (k, body, type, cond) => {
      const r = await putIf(k, body, type, cond);
      if (!once && k.endsWith('/.kirolex-trash.json')) { once = true; b.data.set('v1/sessions/s1/transcript.jsonl', Buffer.from('复制期间传的')); }
      return r;
    };
    const logs: string[] = [];
    const r = await run(b, logs);
    assert.deepEqual(r.trashed, []);
    assert.ok(readCat(b).entries.some((e) => e.id === 's1'), 'catalog 没动');
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), '复制期间传的');
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
    assert.ok(logs.some((l) => l.includes('复制期间原位置有变化')));
  });

  test('存储不支持条件删除（明说）：没有"先核对再普通删"的退路 —— 一条都不移、原件一个不删', async () => {
    const { b } = await setup();
    b.noCondDelete = true;
    const logs: string[] = [];
    const r = await run(b, logs);
    assert.deepEqual(r.trashed, []);
    assert.match(String(r.blocked), /按版本删除/);
    assert.equal(keysUnder(b, 'v1/sessions/s1/').length, 2, '原件都在');
    assert.deepEqual(keysUnder(b, 'v1/trash/'), [], '没复制');
    assert.ok(readCat(b).entries.some((e) => e.id === 's1'), 'catalog 没动');
  });

  test('存储悄悄忽略 If-Match（照删不误）：探测出来，同样一条都不移', async () => {
    const { b } = await setup();
    b.ignoreIfMatch = true;
    const r = await run(b);
    assert.deepEqual(r.trashed, []);
    assert.match(String(r.blocked), /按版本删除/);
    assert.equal(keysUnder(b, 'v1/sessions/s1/').length, 2);
  });

  test('核对和删除之间别的设备传了新版本 → 条件删除拒绝，新版本还在（不会被"先核对再删"删掉）', async () => {
    const { b } = await setup();
    /* 就在删原件的那一刻（条件删除比对之前），B 传了新的 transcript */
    const delIf = b.delIf.bind(b);
    let raced = false;
    b.delIf = async (k, etag) => {
      if (k === 'v1/sessions/s1/transcript.jsonl' && !raced) { raced = true; b.data.set(k, Buffer.from('B 刚传的')); }
      return delIf(k, etag);
    };
    const r = await run(b);
    assert.ok(raced);
    assert.deepEqual(r.trashed, []);
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), 'B 刚传的', '新版本没被删');
    assert.ok(b.data.has('v1/sessions/s1/record.json'), '别的原件也都在（撤回放回来了）');
  });

  test('重试删除时发现原件被重新写过 → 撤回，缺的原件放回去', async () => {
    const { b } = await setup();
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const r = await run(b);
    b.failDelOn = undefined;
    assert.equal(r.trashed.length, 1);
    assert.equal(b.data.has('v1/sessions/s1/record.json'), false, 'record.json 已经删了');
    b.data.set('v1/sessions/s1/transcript.jsonl', Buffer.from('后来传的'));
    await runCloudCleanup(b, { now: T0 + 4 * H, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), '后来传的');
    assert.ok(b.data.has('v1/sessions/s1/record.json'), 'record.json 从回收站放回来了');
    assert.ok(readCat(b).entries.some((e) => e.id === 's1'));
  });
});

describe('同名电脑：清单按设备 ID 存', () => {
  test('两台都叫 H：按主机名存会互相覆盖（复现），按设备 ID 存各是各的 → 一台还有 s1 就不清', () => {
    const now = T0 + 3 * DAY_MS;
    const keep = buildDeviceManifest('d_aaaaaaaa', T0 + 2 * DAY_MS, [{ id: 's1' }], {}, 'H');
    const del = buildDeviceManifest('d_bbbbbbbb', T0 + 2 * DAY_MS + H, [], { s1: T0 + DAY_MS }, 'H');
    /* 旧的键法：两份都写到 'H' 上，后写的盖掉前一台 */
    const byHost = (m: typeof keep) => ({ ...m, machine: 'H' });
    const collided = withDeviceManifest(withDeviceManifest({ version: 1, entries: [entry('s1', { from: 'H' })] }, byHost(keep)), byHost(del));
    assert.deepEqual(ids(collided, now), ['s1'], '按主机名存：还有 s1 的那台被盖掉，s1 被误判');
    /* 现在的键法 */
    const c = withDeviceManifest(withDeviceManifest({ version: 1, entries: [entry('s1', { from: 'H' })] }, keep), del);
    assert.deepEqual(Object.keys(c.devices!).sort(), ['d_aaaaaaaa', 'd_bbbbbbbb']);
    assert.deepEqual(ids(c, now), []);
    const d = decideCleanup(c, { now, activeDays: 90 });
    assert.deepEqual(d.devices.map((x) => x.name), ['H', 'H'], '显示名是主机名');
    assert.deepEqual(d.unknown, [], '条目 from 是主机名标签：有清单的设备按主机名也算认识');
  });

  let dir = '';
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ''; });
  test('设备 ID：存下来、下次还是它；主机名变了（比如整个目录拷到另一台）就换新的；两个数据目录各一个', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-devid-'));
    let n = 0;
    const rnd = () => `rand${String(++n).padStart(8, '0')}`;
    const f1 = path.join(dir, 'a', 'device-id.json');
    const f2 = path.join(dir, 'b', 'device-id.json');
    const id1 = loadOrCreateDeviceId(f1, 'H', rnd);
    assert.match(id1, /^d_/);
    assert.equal(loadOrCreateDeviceId(f1, 'H', rnd), id1, '存下来了');
    const id2 = loadOrCreateDeviceId(f2, 'H', rnd);
    assert.notEqual(id2, id1, '同名的另一个数据目录是另一个 ID');
    assert.notEqual(loadOrCreateDeviceId(f1, 'H2', rnd), id1, '主机名变了就换新的');
  });
});

describe('恢复 / 撤回和别的设备的上传交错', () => {
  test('恢复到云端备份时，别的设备正好往原位置传了同一个文件 → 保留新的，不被回收站里的旧文件盖掉', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    assert.equal(t.trashed.length, 1);
    /* 恢复写 transcript 之前的那一刻，B 传了新的 transcript */
    const hook = (key: string) => {
      if (key !== 'v1/sessions/s1/transcript.jsonl') { b.beforePutIf = hook; return; }
      b.data.set(key, Buffer.from('B 刚传的新内容'));
    };
    b.beforePutIf = hook;
    const r = await restoreFromCloudTrash(b, '', t.trashed[0].dir, T0 + 3 * H, () => {});
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), 'B 刚传的新内容', '新内容没变回旧的');
    assert.ok(b.data.has('v1/sessions/s1/record.json'), '原位置没有的照常放回去');
    assert.deepEqual([r.restored, r.kept], [1, 1]);
  });

  test('重试时发现原件被重写、撤回又失败 → 标成待撤回：到期不清空、不许手动删；下次同步撤回做完，文件都回来', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const t = await A.sync(b, T0 + 2 * H);
    b.failDelOn = undefined;
    assert.equal(t.trashed.length, 1);
    const dir = t.trashed[0].dir;
    assert.equal(b.data.has('v1/sessions/s1/record.json'), false, 'record.json 已经删了，此刻只在回收站里');
    /* 别的设备重写了 transcript；撤回时把 record.json 放回去失败（网络错误） */
    b.data.set('v1/sessions/s1/transcript.jsonl', Buffer.from('后来传的'));
    b.failPutIfOn = (k) => k === 'v1/sessions/s1/record.json';
    await A.sync(b, T0 + 3 * H);
    const meta = JSON.parse(b.data.get(`v1/trash/${dir}/.kirolex-trash.json`)!.toString());
    assert.equal(meta.undoPending, true, '待撤回记进了说明文件');
    /* 到期了也不清空 */
    let r = await A.sync(b, T0 + 2 * H + 31 * DAY_MS);
    assert.deepEqual(r.purged, []);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`), '只此一份的 record.json 还在回收站里');
    await assert.rejects(() => purgeCloudTrashItem(b, '', dir, () => {}), /撤回/);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`), '手动删也删不掉');
    /* 网络好了：下次同步撤回做完 */
    b.failPutIfOn = undefined;
    r = await A.sync(b, T0 + 2 * H + 32 * DAY_MS);
    assert.ok(b.data.has('v1/sessions/s1/record.json'), 'record.json 回到原位置');
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), '后来传的');
    assert.deepEqual(keysUnder(b, 'v1/trash/'), [], '撤回做完，回收站那份删掉');
  });
});

describe('按版本删原件：没有退路', () => {
  test('deleteOriginalVersion：不支持条件删除 / 没记到 ETag → 不删，对象还在', async () => {
    const b = fakeBucket();
    b.data.set('v1/sessions/s1/a', Buffer.from('x'));
    const etag = (await b.getWithEtag('v1/sessions/s1/a'))!.etag;
    b.noCondDelete = true;
    assert.equal(await deleteOriginalVersion(b, { key: 'v1/sessions/s1/a', etag }), 'unsupported');
    assert.ok(b.data.has('v1/sessions/s1/a'), '不支持时绝不退回普通删除');
    b.noCondDelete = false;
    assert.equal(await deleteOriginalVersion(b, { key: 'v1/sessions/s1/a', lastModified: '1' }), 'unsupported');
    assert.ok(b.data.has('v1/sessions/s1/a'), '没有 ETag 也不删');
    assert.equal(await deleteOriginalVersion(b, { key: 'v1/sessions/s1/a', etag }), 'deleted');
  });

  test('探测：支持 → true；明说不支持 / 悄悄忽略 If-Match → false；探测对象不留', async () => {
    const b = fakeBucket();
    assert.equal(await probeConditionalDelete(b, ''), true);
    b.noCondDelete = true;
    assert.equal(await probeConditionalDelete(b, ''), false);
    b.noCondDelete = false; b.ignoreIfMatch = true;
    assert.equal(await probeConditionalDelete(b, ''), false);
    assert.deepEqual([...b.data.keys()].filter((k) => k.includes('probe')), []);
  });
});

describe('首次移动时撤回失败', () => {
  test('写完 catalog 后有设备传了新内容，撤回又没放完 → 待撤回：到期不清空、不许手动删；网络好了再撤回，文件都回来', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('A', T0 + 2 * H, [], A.deletions)))));
    /* 原件按 key 顺序删：record.json 先删掉，删 transcript 之前别的设备传了新的 → 要撤回；撤回放 record.json 时网络错误 */
    const delIf = b.delIf.bind(b);
    b.delIf = async (k, etag) => {
      if (k === 'v1/sessions/s1/transcript.jsonl' && !b.data.get(k)!.toString().startsWith('B')) b.data.set(k, Buffer.from('B 刚传的'));
      return delIf(k, etag);
    };
    b.failPutIfOn = (k) => k === 'v1/sessions/s1/record.json';
    const r = await runCloudCleanup(b, { now: T0 + 3 * H, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
    assert.deepEqual(r.trashed, []);
    assert.ok(r.errors.some((e) => e.includes('撤回没有完成')));
    assert.equal(b.data.has('v1/sessions/s1/record.json'), false, 'record.json 此刻只在回收站里');
    const items = await listCloudTrash(b, '', T0 + 3 * H, 30);
    assert.equal(items.length, 1);
    assert.equal(items[0].undoPending, true, '待撤回');
    assert.equal(items[0].moving, true, '移动没做完的标记也还在');
    const dir = items[0].dir;
    /* 到期也不清空（撤回这一轮也还是失败） */
    const r2 = await runCloudCleanup(b, { now: T0 + 3 * H + 31 * DAY_MS, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
    assert.deepEqual(r2.purged, []);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
    await assert.rejects(() => purgeCloudTrashItem(b, '', dir, () => {}), /撤回/);
    /* 网络好了 */
    b.failPutIfOn = undefined;
    await runCloudCleanup(b, { now: T0 + 3 * H + 32 * DAY_MS, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
    assert.ok(b.data.has('v1/sessions/s1/record.json'), 'record.json 回到原位置');
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), 'B 刚传的');
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
  });
});

describe('回收站里的唯一副本：标记写不进去、设备只传了一部分', () => {
  /* A 删了 s1、移进回收站；transcript 删不掉，留着待删 —— record.json / history.md 此刻只在回收站里 */
  const setup = async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const t = await A.sync(b, T0 + 2 * H);
    b.failDelOn = undefined;
    assert.equal(t.trashed.length, 1);
    assert.equal(b.data.has('v1/sessions/s1/record.json'), false);
    return { b, A, dir: t.trashed[0].dir };
  };

  test('B 只发布了清单（一个文件都没重传）→ 撤回整次移动：缺的原件从回收站补齐，之后到期也不会丢', async () => {
    const { b, A, dir } = await setup();
    /* B 有 s1（它一直有，状态表说早就传过了），这一轮只写了清单，没传任何文件 */
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('B', T0 + 3 * H, [{ id: 's1' }], {})))));
    await A.sync(b, T0 + 4 * H);
    assert.ok(b.data.has('v1/sessions/s1/record.json'), 'record.json 补回原位置');
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'));
    assert.deepEqual(keysUnder(b, `v1/trash/${dir}/`), [], '全部补齐之后回收站那份才删');
    await A.sync(b, T0 + 2 * H + 31 * DAY_MS);
    assert.ok(b.data.has('v1/sessions/s1/record.json'), '到期之后也还在');
  });

  test('B 只传了改过的 transcript（record.json 没重传）→ 保留新 transcript，补回 record.json', async () => {
    const { b, A, dir } = await setup();
    b.data.set('v1/sessions/s1/transcript.jsonl', Buffer.from('B 改过的'));
    const c = readCat(b);
    c.entries.push(entry('s1', { from: 'B', syncedAt: T0 + 3 * H }));
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(withDeviceManifest(c, buildDeviceManifest('B', T0 + 3 * H, [{ id: 's1' }], {})))));
    await A.sync(b, T0 + 4 * H);
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), 'B 改过的', '新的保留');
    assert.ok(b.data.has('v1/sessions/s1/record.json'), '缺的补回来');
    assert.deepEqual(keysUnder(b, `v1/trash/${dir}/`), []);
  });

  test('补回文件失败、"待撤回"标记也写不进去，随后到期 → 这一轮和之后都不清空；网络好了撤回做完', async () => {
    const { b, A, dir } = await setup();
    /* 到期那天：B 发布了"我有 s1"；撤回放 record.json 失败；改说明文件也失败 */
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('B', T0 + 3 * H, [{ id: 's1' }], {})))));
    b.failPutIfOn = (k) => k === 'v1/sessions/s1/record.json' || k.endsWith('/.kirolex-trash.json');
    const expiry = T0 + 2 * H + 31 * DAY_MS;
    const logs: string[] = [];
    let r = await A.sync(b, expiry, logs);
    assert.deepEqual(r.purged, [], '同一轮不清空');
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`), '唯一副本还在');
    const meta = JSON.parse(b.data.get(`v1/trash/${dir}/.kirolex-trash.json`)!.toString());
    assert.equal(meta.undoPending, undefined, '标记确实没写进去（这正是要防的情况）');
    /* 下一轮：标记还是写不进去、撤回还是失败 → 靠"又在用了"的核对挡住 */
    r = await A.sync(b, expiry + DAY_MS, logs);
    assert.deepEqual(r.purged, []);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
    /* 网络好了 */
    b.failPutIfOn = undefined;
    await A.sync(b, expiry + 2 * DAY_MS);
    assert.ok(b.data.has('v1/sessions/s1/record.json'), '补回原位置');
    assert.deepEqual(keysUnder(b, `v1/trash/${dir}/`), []);
  });

  test('首次移动：复制时就写上 moving；去掉 moving 那一步写不进去 → 到期也不清空，下一轮把移动做完', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    /* 第一次写说明文件（复制时，带 moving）成功；之后改说明文件都失败 */
    let metaWrites = 0;
    b.failPutIfOn = (k) => k.endsWith('/.kirolex-trash.json') && ++metaWrites > 1;
    const t = await A.sync(b, T0 + 2 * H);
    assert.equal(t.trashed.length, 1);
    const dir = t.trashed[0].dir;
    assert.equal(JSON.parse(b.data.get(`v1/trash/${dir}/.kirolex-trash.json`)!.toString()).moving, true, '去不掉 moving');
    let r = await A.sync(b, T0 + 2 * H + 31 * DAY_MS);
    assert.deepEqual(r.purged, [], '移动没做完（看说明文件），不清空');
    b.failPutIfOn = undefined;
    /* 这一轮先把移动做完（去掉 moving），同一轮里接着照常到期清空 */
    r = await A.sync(b, T0 + 2 * H + 32 * DAY_MS);
    assert.deepEqual(r.purged.map((x) => x.id), ['s1'], '做完之后照常到期清空');
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
  });
});

describe('已经做完的移动：会话又被一台设备认领', () => {
  test('移动早已做完（没有任何标记）；一台久没同步的设备回来、说它有 s1；撤回失败、标记也写不进去 → 到期不清空；之后撤回做完', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    const dir = t.trashed[0].dir;
    const meta0 = JSON.parse(b.data.get(`v1/trash/${dir}/.kirolex-trash.json`)!.toString());
    assert.equal(meta0.moving, undefined, '移动做完了，没有 moving');
    assert.deepEqual(keysUnder(b, 'v1/sessions/s1/'), [], '原件都删了，回收站这份是唯一的');
    /* 到期那天：OLD 回来了，它本地还有 s1，只发布了清单；撤回失败，改说明文件也失败 */
    const expiry = T0 + 2 * H + 31 * DAY_MS;
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('OLD', expiry - H, [{ id: 's1' }], {})))));
    b.failPutIfOn = (k) => k.startsWith('v1/sessions/s1/') || k.endsWith('/.kirolex-trash.json');
    let r = await A.sync(b, expiry);
    assert.deepEqual(r.purged, [], '同一轮：撤回没做完，跳过');
    r = await A.sync(b, expiry + DAY_MS);
    assert.deepEqual(r.purged, [], '下一轮：标记还是没写进去，靠"又在用了"的核对挡住');
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`), '唯一副本还在');
    b.failPutIfOn = undefined;
    await A.sync(b, expiry + 2 * DAY_MS);
    assert.ok(b.data.has('v1/sessions/s1/record.json'), '撤回做完，文件回到原位置');
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'));
    assert.deepEqual(keysUnder(b, `v1/trash/${dir}/`), []);
  });

  test('同上，但"待撤回"写进去了、"又在用了"的核对读不到设备（OLD 又过了活跃期）→ 靠待撤回标记挡住', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    const dir = t.trashed[0].dir;
    const expiry = T0 + 2 * H + 31 * DAY_MS;
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('OLD', expiry - H, [{ id: 's1' }], {})))));
    b.failPutIfOn = (k) => k.startsWith('v1/sessions/s1/');
    await A.sync(b, expiry);                          // 撤回失败，但"待撤回"写进去了
    assert.equal(JSON.parse(b.data.get(`v1/trash/${dir}/.kirolex-trash.json`)!.toString()).undoPending, true);
    /* 撤回时 catalog 条目也放回去了 —— 去掉它和 OLD 的清单，让"又在用了"的核对看不到 s1 */
    const c = readCat(b);
    c.entries = c.entries.filter((e) => e.id !== 's1');
    delete c.devices!.OLD;
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(c)));
    const r = await A.sync(b, expiry + DAY_MS);
    assert.deepEqual(r.purged, [], '待撤回标记挡住');
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
  });
});

describe('到期清空的最后两道关（这一轮没跑撤回 / 重试时）', () => {
  /* 云存储这一轮不回 ETag：移动 / 重试 / 撤回那一段整个不走，只剩到期清空 —— 它自己要挡住 */
  const finished = async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    return { b, A, dir: t.trashed[0].dir, expiry: T0 + 2 * H + 31 * DAY_MS };
  };

  test('又有设备在用这条会话（清单里有它）→ 不清空', async () => {
    const { b, dir, expiry } = await finished();
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('OLD', expiry - H, [{ id: 's1' }], {})))));
    b.noEtag = true;
    const r = await runCloudCleanup(b, { now: expiry, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
    assert.deepEqual(r.purged, []);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
  });

  test('说明文件标着待撤回 → 不清空', async () => {
    const { b, dir, expiry } = await finished();
    const k = `v1/trash/${dir}/.kirolex-trash.json`;
    b.data.set(k, Buffer.from(JSON.stringify({ ...JSON.parse(b.data.get(k)!.toString()), undoPending: true })));
    b.noEtag = true;
    const r = await runCloudCleanup(b, { now: expiry, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
    assert.deepEqual(r.purged, []);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
  });

  test('读不出 catalog → 拿不准，一份都不清', async () => {
    const { b, dir, expiry } = await finished();
    b.data.set(catalogKey(''), Buffer.from('{坏了'));
    const r = await runCloudCleanup(b, { now: expiry, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
    assert.deepEqual(r.purged, []);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
  });

  test('对照：都没有 → 照常清空', async () => {
    const { b, expiry } = await finished();
    const r = await runCloudCleanup(b, { now: expiry, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
    assert.deepEqual(r.purged.map((x) => x.id), ['s1']);
  });

  test('云存储不回 ETag：给这一份上不了锁 → 不清空（拿不准）', async () => {
    const { b, dir, expiry } = await finished();
    b.noEtag = true;
    const r = await runCloudCleanup(b, { now: expiry, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
    assert.deepEqual(r.purged, []);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
  });
});

describe('拿不准就不删：catalog 没有、清单读不懂', () => {
  const finished = async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    assert.equal(t.trashed.length, 1);
    return { b, A, dir: t.trashed[0].dir, expiry: T0 + 2 * H + 31 * DAY_MS };
  };
  const run = (b: FakeBucket, now: number) => runCloudCleanup(b, { now, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });

  test('到期了，但 catalog 不存在（返回 null）→ 不清空', async () => {
    const { b, dir, expiry } = await finished();
    b.data.delete(catalogKey(''));
    const r = await run(b, expiry);
    assert.deepEqual(r.purged, []);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`), '唯一备份还在');
  });

  test('到期了，但某台活跃设备的清单读不懂 → 不清空（也报 blocked）', async () => {
    const { b, dir, expiry } = await finished();
    const c = readCat(b);
    c.devices!.B = { machine: 'B', syncedAt: expiry - H, sessions: 'x' } as any;
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(c)));
    const r = await run(b, expiry);
    assert.match(String(r.blocked), /读不到/);
    assert.deepEqual(r.purged, []);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
  });

  test('到期了，但有最近同步过、却没有清单的设备 → 不清空', async () => {
    const { b, dir, expiry } = await finished();
    const c = readCat(b);
    c.entries.push(entry('other', { from: 'OLDVER', syncedAt: expiry - H }));
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(c)));
    const r = await run(b, expiry);
    assert.deepEqual(r.purged, []);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
  });

  test('重试删原件时某台活跃设备的清单读不懂 → 不删原件、也不撤回；清单好了再接着删', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const t = await A.sync(b, T0 + 2 * H);
    b.failDelOn = undefined;
    const dir = t.trashed[0].dir;
    const c = readCat(b);
    c.devices!.B = { machine: 'B', syncedAt: T0 + 3 * H, sessions: null } as any;
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(c)));
    await run(b, T0 + 4 * H);
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'), '判断不了：不删');
    assert.ok(b.data.has(`v1/trash/${dir}/.kirolex-trash.json`), '也没撤回');
    const fixed = readCat(b);
    delete fixed.devices!.B;
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(fixed)));
    await run(b, T0 + 5 * H);
    assert.equal(b.data.has('v1/sessions/s1/transcript.jsonl'), false, '能判断了：接着删完');
  });
});

describe('设备清单要晚于这条会话真正传完的时刻（uploadedAt）', () => {
  const now = T0 + 3 * DAY_MS;
  const dev = (m: string, at: number, deleted: Record<string, number> = {}) => buildDeviceManifest(m, at, [], deleted);
  const cat = (e: CatalogEntry, ...ds: ReturnType<typeof dev>[]) => ds.reduce((c, d) => withDeviceManifest(c, d), { version: 1, entries: [e] } as Catalog);

  test('syncedAt < B 的清单 < uploadedAt → B 那时还没看到这次上传，不清', () => {
    const e = entry('s1', { syncedAt: T0, uploadedAt: T0 + 2 * H });
    const c = cat(e, dev('A', T0 + DAY_MS, { s1: T0 + 3 * H }), dev('B', T0 + H));
    const d = decideCleanup(c, { now, activeDays: 90 });
    assert.deepEqual(d.candidates, []);
    assert.match(d.undecided[0].why, /B 的清单/);
  });

  test('B 的清单晚于 uploadedAt → 照常清', () => {
    const e = entry('s1', { syncedAt: T0, uploadedAt: T0 + 2 * H });
    const c = cat(e, dev('A', T0 + DAY_MS, { s1: T0 + 3 * H }), dev('B', T0 + 3 * H));
    assert.deepEqual(decideCleanup(c, { now, activeDays: 90 }).candidates.map((x) => x.entry.id), ['s1']);
  });

  test('老条目没有 uploadedAt：按 syncedAt 往后算 6 小时 —— 清单在这之内不清，之后才清', () => {
    const e = entry('s1', { syncedAt: T0 });
    assert.equal(lastUploadOf(e), T0 + UPLOAD_MARGIN_MS);
    const within = cat(e, dev('A', T0 + DAY_MS, { s1: T0 + 7 * H }), dev('B', T0 + 5 * H));
    assert.deepEqual(decideCleanup(within, { now, activeDays: 90 }).candidates, []);
    const after = cat(e, dev('A', T0 + DAY_MS, { s1: T0 + 7 * H }), dev('B', T0 + 7 * H));
    assert.deepEqual(decideCleanup(after, { now, activeDays: 90 }).candidates.map((x) => x.entry.id), ['s1']);
  });
});

describe('设备清单的同步时间判断不了 → 不能当成不活跃忽略', () => {
  const now = T0 + 3 * DAY_MS;
  const bad = (syncedAt: unknown) => ({ machine: 'B', syncedAt, sessions: [{ id: 's1' }], deleted: [] } as any);
  for (const [name, v] of [['缺失', undefined], ['不是数字', 'x'], ['0', 0], ['负数', -5]] as const) {
    test(`B 的清单 syncedAt ${name}、仍列着 s1：不移、判断不了有没有人在用`, () => {
      const c = cat([entry('s1')], dev('A', T0 + DAY_MS, [], { s1: T0 + H }));
      c.devices!.B = bad(v);
      const d = decideCleanup(c, { now, activeDays: 90 });
      assert.deepEqual(d.candidates, []);
      assert.match(String(d.blocked), /读不到/);
      assert.equal(sessionsInUse(c, now, 90), null);
      assert.equal(d.devices.find((x) => x.machine === 'B')!.active, true, '时间判断不了就当活跃');
    });
  }

  test('到期清空 / 重试删原件：B 的清单没有 syncedAt → 都不做', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const t = await A.sync(b, T0 + 2 * H);
    b.failDelOn = undefined;
    const dir = t.trashed[0].dir;
    const c = readCat(b);
    c.devices!.B = bad(undefined);
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(c)));
    const r = await runCloudCleanup(b, { now: T0 + 2 * H + 31 * DAY_MS, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
    assert.deepEqual(r.purged, []);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'), '没删的原件也没删');
  });
});

describe('catalog 读不懂 / 不见了，被同步重建之后：自动清理停一个活跃期限', () => {
  /* 和 index.ts 一样走 catalogStore 的 writeSyncCatalog（假桶接成 CatalogBucket） */
  const catalogBucketOf = (b: FakeBucket): CatalogBucket => ({
    get: (k) => b.getWithEtag(k),
    put: (k, body, cond) => (cond ? b.putIf(k, body, 'application/json', cond) : b.put(k, body).then(() => 'ok' as const)),
    list: async (p) => (await b.list(p)).map((o) => o.key),
    del: (k) => b.del(k),
    sessionIds: async () => new Set([...b.data.keys()].filter((k) => k.startsWith('v1/sessions/')).map((k) => k.split('/')[2])),
    deletedAt: async () => null,
  });
  /* 真实同步的顺序：写 catalog（并进本机清单）→ 云端清理 */
  const realSync = async (b: FakeBucket, now: number, manifest: ReturnType<typeof buildDeviceManifest>) => {
    await writeSyncCatalog(catalogBucketOf(b), '', [], now, (c) => withDeviceManifest(c, manifest));
    return runCloudCleanup(b, { now, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
  };
  const trashed = async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    return { b, A, dir: t.trashed[0].dir, expiry: T0 + 2 * H + 31 * DAY_MS };
  };

  test('catalog 读不懂 → 同步重建（只剩本机清单）→ 到期也不清空；过了活跃期限、设备都重新登记了才恢复', async () => {
    const { b, A, dir, expiry } = await trashed();
    b.data.set(catalogKey(''), Buffer.from('{坏了'));
    let r = await realSync(b, expiry, buildDeviceManifest('A', expiry, [], A.deletions));
    assert.ok(readCat(b).rebuiltAt, '重建时记下了时刻');
    assert.match(String(r.blocked), /重建/);
    assert.deepEqual(r.purged, [], '重建出来的 catalog 看着可读，但不能据此清空');
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
    /* 之后的同步照样带着重建时刻（不会因为又写了一次就丢掉保护） */
    r = await realSync(b, expiry + 30 * DAY_MS, buildDeviceManifest('A', expiry + 30 * DAY_MS, [], A.deletions));
    assert.deepEqual(r.purged, []);
    assert.ok(readCat(b).rebuiltAt);
    /* 过了 90 天 */
    r = await realSync(b, expiry + 91 * DAY_MS, buildDeviceManifest('A', expiry + 91 * DAY_MS, [], A.deletions));
    assert.deepEqual(r.purged.map((x) => x.id), ['s1'], '过了活跃期限才恢复');
  });

  test('catalog 不见了、云端回收站里还有东西 → 同样当重建处理', async () => {
    const { b, A, dir, expiry } = await trashed();
    b.data.delete(catalogKey(''));
    const r = await realSync(b, expiry, buildDeviceManifest('A', expiry, [], A.deletions));
    assert.ok(readCat(b).rebuiltAt);
    assert.deepEqual(r.purged, []);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
  });

  test('全新的桶（什么都没有）第一次同步：不算重建，不停清理', async () => {
    const b = fakeBucket();
    await writeSyncCatalog(catalogBucketOf(b), '', [], T0, (c) => withDeviceManifest(c, buildDeviceManifest('A', T0, [], {})));
    assert.equal(readCat(b).rebuiltAt, undefined);
  });

  test('别的入口（以本机为准）也会把读不懂的 catalog 当空的重建 → 同样记下重建时刻', async () => {
    const b = fakeBucket();
    b.data.set(catalogKey(''), Buffer.from('{坏了'));
    const r = await updateCatalogStore(catalogIO(catalogBucketOf(b), ''), (c) => ({ ...c, entries: [entry('mine', { from: 'A' })] }), { onCorrupt: 'empty', now: () => T0 });
    assert.equal(r.catalog.rebuiltAt, T0);
    assert.equal(readCat(b).rebuiltAt, T0);
    assert.match(String(decideCleanup(readCat(b), { now: T0 + DAY_MS, activeDays: 90 }).blocked), /重建/);
  });

  test('rebuiltHold：时间读不懂也算刚重建', () => {
    assert.match(String(rebuiltHold({ version: 1, entries: [], rebuiltAt: 'x' as any }, T0, 90)), /重建/);
    assert.equal(rebuiltHold({ version: 1, entries: [], rebuiltAt: T0 - 91 * DAY_MS }, T0, 90), null);
    assert.equal(rebuiltHold({ version: 1, entries: [] }, T0, 90), null);
  });
});

describe('恢复 / 撤回 和 到期清空 / 手动删除：跨设备的锁', () => {
  const trashed = async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    assert.equal(t.trashed.length, 1);
    return { b, A, dir: t.trashed[0].dir, expiry: T0 + 2 * H + 31 * DAY_MS };
  };
  const metaOf = (b: FakeBucket, dir: string) => JSON.parse(b.data.get(`v1/trash/${dir}/.kirolex-trash.json`)!.toString());
  const purgeOn = (b: FakeBucket, now: number, machineName = 'B') =>
    runCloudCleanup(b, { now, settings: cleanupSettings({}), thisMachine: machineName, log: () => {} });

  test('恢复复制到一半，另一台设备正好跑到期清空 → 不清空；恢复成功、所有文件都在', async () => {
    const { b, dir, expiry } = await trashed();
    /* 恢复刚把 record.json 放回原位置，B 的同步就开始到期清空了 */
    const putIf = b.putIf.bind(b);
    let raced: Awaited<ReturnType<typeof purgeOn>> | null = null;
    let started = false;
    b.putIf = async (k, body, type, cond) => {
      const r = await putIf(k, body, type, cond);
      if (!started && k === 'v1/sessions/s1/record.json') { started = true; raced = await purgeOn(b, expiry); }   // 先置标记：里面那一轮也会走到这里
      return r;
    };
    const back = await restoreFromCloudTrash(b, '', dir, expiry, () => {});
    assert.ok(raced, '确实交错了');
    assert.deepEqual(raced!.purged, [], 'B 看到 restoring 锁，不清空');
    assert.equal(back.restored, 2);
    assert.ok(b.data.has('v1/sessions/s1/record.json'));
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'), '聊天正文也回来了');
    assert.deepEqual(keysUnder(b, 'v1/trash/'), [], '恢复做完才删回收站那份');
    assert.ok(readCat(b).entries.some((e) => e.id === 's1'));
  });

  test('反过来：到期清空先上了锁、删到一半，这时点恢复 → 恢复拒绝，原位置一个文件都不写', async () => {
    const { b, dir, expiry } = await trashed();
    let refused: unknown = null;
    const tryRestore = async (k: string) => {
      if (refused === null && k.startsWith(`v1/trash/${dir}/sessions/`)) {
        refused = await restoreFromCloudTrash(b, '', dir, expiry, () => {}).then(() => false, (e) => e);
      }
    };
    /* 回收站的删除现在按版本删（没开版本控制时删的是 "null" 版本），两条路都挂上 */
    const del = b.del.bind(b);
    b.del = async (k) => { await tryRestore(k); return del(k); };
    const delVersion = b.delVersion.bind(b);
    b.delVersion = async (k, v) => { await tryRestore(k); return delVersion(k, v); };
    const r = await purgeOn(b, expiry);
    assert.match(String((refused as any)?.message), /正在被彻底删除/);
    assert.deepEqual(r.purged.map((x) => x.id), ['s1']);
    assert.deepEqual(keysUnder(b, 'v1/sessions/s1/'), [], '恢复没往原位置写半份');
  });

  test('两边读到同一版说明文件、同时上锁：条件写只有一边成功 —— 清空方读完之后恢复方抢先上锁 → 清空方不删', async () => {
    const { b, dir, expiry } = await trashed();
    const metaKey = `v1/trash/${dir}/.kirolex-trash.json`;
    const get = b.getWithEtag.bind(b);
    let reads = 0;
    let restoreClaimed = false;
    b.getWithEtag = async (k) => {
      const g = await get(k);
      /* 清空方第一次读说明文件之后、条件写之前：恢复方上了 restoring 锁 */
      if (k === metaKey && ++reads === 1) {
        await updateTrashMeta(b, '', dir, (m) => ({ ...m, restoring: { at: expiry, by: 'restore' } }));
        restoreClaimed = true;
      }
      return g;
    };
    const r = await purgeOn(b, expiry);
    assert.ok(restoreClaimed);
    assert.deepEqual(r.purged, [], '清空方的条件写失败、重读看到 restoring → 不删');
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
    assert.ok(metaOf(b, dir).restoring, '恢复方的锁没被盖掉');
  });

  test('有"正在恢复"的锁（比如恢复中途失败）：到期也不自动清空；手动删除 1 小时内拒绝、之后放行', async () => {
    const { b, dir, expiry } = await trashed();
    await updateTrashMeta(b, '', dir, (m) => ({ ...m, restoring: { at: Date.now(), by: 'restore' } }));
    const r = await purgeOn(b, expiry);
    assert.deepEqual(r.purged, []);
    await assert.rejects(() => purgeCloudTrashItem(b, '', dir, () => {}), /正在被恢复/);
    await updateTrashMeta(b, '', dir, (m) => ({ ...m, restoring: { at: Date.now() - RESTORE_LOCK_STALE_MS - 1, by: 'restore' } }));
    const gone = await purgeCloudTrashItem(b, '', dir, () => {});
    assert.ok(gone.deleted > 0);
    assert.deepEqual(keysUnder(b, `v1/trash/${dir}/`), []);
  });

  test('恢复中途失败：锁留着，再点一次恢复接着做完', async () => {
    const { b, dir, expiry } = await trashed();
    b.failPutIfOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    await assert.rejects(() => restoreFromCloudTrash(b, '', dir, expiry, () => {}));
    assert.ok(metaOf(b, dir).restoring, '锁留着');
    assert.deepEqual((await purgeOn(b, expiry)).purged, [], '锁在就不自动清空');
    b.failPutIfOn = undefined;
    const back = await restoreFromCloudTrash(b, '', dir, expiry, () => {});
    assert.deepEqual([back.restored, back.kept], [1, 1]);
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'));
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
  });

  test('撤回进行中（拿着锁），另一台设备到期清空 → 不删', async () => {
    const { b, dir, expiry } = await trashed();
    /* B 说它还有 s1 → A 撤回；撤回放 record.json 时，B 跑到期清空 */
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('B', expiry - H, [{ id: 's1' }], {})))));
    const putIf = b.putIf.bind(b);
    let raced: Awaited<ReturnType<typeof purgeOn>> | null = null;
    let started = false;
    b.putIf = async (k, body, type, cond) => {
      const r = await putIf(k, body, type, cond);
      if (!started && k === 'v1/sessions/s1/record.json') { started = true; raced = await purgeOn(b, expiry, 'C'); }
      return r;
    };
    await runCloudCleanup(b, { now: expiry, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
    assert.ok(raced);
    assert.deepEqual(raced!.purged, []);
    assert.ok(b.data.has('v1/sessions/s1/record.json'));
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'));
  });
});

describe('到期清空前的"又在用了"核对：同一轮里重试之后、清空之前有设备发布了清单', () => {
  test('重试那一步时还没人认领，清空之前 B 发布了"我有 s1" → 不清空', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    const dir = t.trashed[0].dir;
    const expiry = T0 + 2 * H + 31 * DAY_MS;
    /* runCloudCleanup 里先是重试那一步列回收站，再是到期清空列回收站 —— 在第一次列完之后插入 B 的清单 */
    const list = b.list.bind(b);
    let trashLists = 0;
    b.list = async (p) => {
      const r = await list(p);
      if (p === 'v1/trash/' && ++trashLists === 1) {
        b.data.set(catalogKey(''), Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('B', expiry - 1, [{ id: 's1' }], {})))));
      }
      return r;
    };
    const r = await runCloudCleanup(b, { now: expiry, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
    assert.ok(trashLists >= 2, '重试和清空各列了一次');
    assert.deepEqual(r.purged, []);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/record.json`));
  });
});

describe('开了版本控制：删原件按 VersionId 删（主路径）', () => {
  const versioned = () => { const b = fakeBucket(); b.versioning = true; return b; };
  /* A 有 s1、同步过几次（原件有好几个版本），然后删了它 */
  const setup = async (syncs = 1) => {
    const b = versioned();
    const A = machine('A');
    A.create('s1', T0);
    for (let i = 0; i < syncs; i++) await A.sync(b, T0 + i * 1000);
    A.remove('s1', T0 + H);
    return { b, A };
  };

  test('复制时记下 VersionId；删的时候连更早的版本一起删 —— 原件不会以旧内容"复活"', async () => {
    const { b, A } = await setup(3);
    assert.equal((await b.listVersions('v1/sessions/s1/transcript.jsonl')).length, 3, '原件有 3 个版本');
    const r = await A.sync(b, T0 + 2 * H);
    assert.deepEqual(r.trashed.map((x) => x.id), ['s1']);
    assert.deepEqual(keysUnder(b, 'v1/sessions/s1/'), [], '原件没了，没有旧版本顶上来');
    assert.deepEqual(await b.listVersions('v1/sessions/s1/transcript.jsonl'), [], '版本都删干净了');
    assert.ok(b.data.has(`v1/trash/${r.trashed[0].dir}/sessions/s1/transcript.jsonl`));
  });

  test('A 开始删原件 → B 完成恢复 → A 接着删：恢复后的文件都还在（ETag 一样也认得出）', async () => {
    const { b, A } = await setup();
    const etagBefore = (await b.getWithEtag('v1/sessions/s1/transcript.jsonl'))!.etag;
    const vidBefore = (await b.getWithEtag('v1/sessions/s1/transcript.jsonl'))!.versionId;
    /* A 删掉第一个原件（record.json）之后，B 在另一台设备上把这一份恢复到云端备份 */
    const delVersion = b.delVersion.bind(b);
    let restored: Awaited<ReturnType<typeof restoreFromCloudTrash>> | null = null;
    let started = false;
    b.delVersion = async (k, vid) => {
      await delVersion(k, vid);
      if (!started && k === 'v1/sessions/s1/record.json') {
        started = true;
        const dir = (await listCloudTrash(b, '', T0 + 2 * H, 30))[0].dir;
        restored = await restoreFromCloudTrash(b, '', dir, T0 + 2 * H, () => {});
      }
    };
    const r = await A.sync(b, T0 + 2 * H);
    assert.ok(restored, '确实交错了');
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), '{"id":"m1","text":"s1"}\n', '聊天正文还在');
    assert.ok(b.data.has('v1/sessions/s1/record.json'));
    const after = (await b.getWithEtag('v1/sessions/s1/transcript.jsonl'))!;
    assert.equal(after.etag, etagBefore, '内容一样 → ETag 一样（按 ETag 删分不出来）');
    assert.notEqual(after.versionId, vidBefore, '但恢复写的是新版本');
    assert.deepEqual(r.trashed, [], 'A 看到有更新的版本，不算移走（撤回）');
    assert.ok(readCat(b).entries.some((e) => e.id === 's1'));
  });

  test('重试删原件时同样交错：B 恢复之后 A 再重试 → 恢复后的文件还在', async () => {
    const { b, A } = await setup();
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const t = await A.sync(b, T0 + 2 * H);
    b.failDelOn = undefined;
    assert.equal(t.trashed.length, 1);
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'), '这个原件还没删掉，留着待删');
    await restoreFromCloudTrash(b, '', t.trashed[0].dir, T0 + 3 * H, () => {});
    await A.sync(b, T0 + 4 * H);                       // A 的重试晚到
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), '{"id":"m1","text":"s1"}\n');
    assert.ok(b.data.has('v1/sessions/s1/record.json'));
  });

  test('晚到的清理任务只会删旧版本：恢复后拿复制时那一版去删 → 说"有更新的版本"，新版本不动', async () => {
    const { b, A } = await setup();
    const copied = { key: 'v1/sessions/s1/transcript.jsonl', versionId: (await b.getWithEtag('v1/sessions/s1/transcript.jsonl'))!.versionId };
    b.data.set('v1/sessions/s1/transcript.jsonl', Buffer.from('{"id":"m1","text":"s1"}\n'));   // 同样的内容，新版本
    assert.equal(await deleteOriginalVersion(b, copied), 'changed');
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'));
    void A;
  });
});

describe('没开版本控制：删原件要先拿到说明文件上的锁', () => {
  const setup = async () => {
    const b = fakeBucket();                            // versioning 关
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    return { b, A };
  };

  test('有人正在恢复（锁在）→ 重试删原件拿不到锁 → 一个都不删；锁没了才删', async () => {
    const { b, A } = await setup();
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const t = await A.sync(b, T0 + 2 * H);
    b.failDelOn = undefined;
    const dir = t.trashed[0].dir;
    await updateTrashMeta(b, '', dir, (m) => ({ ...m, restoring: { at: Date.now(), by: 'B' } }));
    const logs: string[] = [];
    await runCloudCleanup(b, { now: T0 + 3 * H, settings: cleanupSettings({}), thisMachine: 'A', log: (_l, m) => logs.push(m) });
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'), '拿不到锁：不删');
    assert.ok(logs.some((l) => l.includes('不删原件') || l.includes('上不了锁')));
    await updateTrashMeta(b, '', dir, (m) => { const { restoring: _r, ...rest } = m; return rest; });
    await runCloudCleanup(b, { now: T0 + 4 * H, settings: cleanupSettings({}), thisMachine: 'A', log: () => {} });
    assert.equal(b.data.has('v1/sessions/s1/transcript.jsonl'), false, '锁没了：删掉');
  });

  test('A 拿着锁删原件时 B 点恢复 → 恢复拒绝、一个文件都不写；A 删完后再恢复 → 成功', async () => {
    const { b, A } = await setup();
    const delIf = b.delIf.bind(b);
    let refused: unknown = null;
    b.delIf = async (k, etag) => {
      if (refused === null && k.startsWith('v1/sessions/s1/')) {
        const dir = (await listCloudTrash(b, '', T0 + 2 * H, 30))[0].dir;
        refused = await restoreFromCloudTrash(b, '', dir, T0 + 2 * H, () => {}).then(() => false, (e) => e);
      }
      return delIf(k, etag);
    };
    const t = await A.sync(b, T0 + 2 * H);
    assert.match(String((refused as any)?.message), /正在删这一份的原件/);
    assert.equal(t.trashed.length, 1);
    assert.deepEqual(keysUnder(b, 'v1/sessions/s1/'), [], 'A 删完了；B 没写半份');
    assert.equal(metaOfDir(b, t.trashed[0].dir).deleting, undefined, '删完锁放掉了');
    b.delIf = delIf;
    const back = await restoreFromCloudTrash(b, '', t.trashed[0].dir, T0 + 3 * H, () => {});
    assert.equal(back.restored, 2);
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), '{"id":"m1","text":"s1"}\n');
  });
});

function metaOfDir(b: FakeBucket, dir: string) { return JSON.parse(b.data.get(`v1/trash/${dir}/.kirolex-trash.json`)!.toString()); }

describe('写回原件：删除夹在恢复的"读"和"条件写"之间', () => {
  test('开了版本控制：恢复读到"还是复制的那一版"之后、条件写之前，那一版被删了 → 重新确认、写进去，文件在', async () => {
    const b = fakeBucket(); b.versioning = true;
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const t = await A.sync(b, T0 + 2 * H);
    b.failDelOn = undefined;
    const dir = t.trashed[0].dir;
    const copied = { key: 'v1/sessions/s1/transcript.jsonl', versionId: metaOfDir(b, dir).pendingOriginals[0].versionId };
    /* 恢复对原件做的那次 GET 之后，删原件那一边按版本把它删了 */
    const get = b.getWithEtag.bind(b);
    let deletedBetween = false;
    b.getWithEtag = async (k) => {
      const g = await get(k);
      if (!deletedBetween && k === copied.key) { deletedBetween = true; await deleteOriginalVersion(b, copied); }
      return g;
    };
    const back = await restoreFromCloudTrash(b, '', dir, T0 + 3 * H, () => {});
    assert.ok(deletedBetween, '确实夹进去了');
    assert.equal(b.data.get(copied.key)!.toString(), '{"id":"m1","text":"s1"}\n', '文件在');
    assert.equal(back.kept, 0, '不是"保留"——是重新写进去的');
    assert.deepEqual(keysUnder(b, 'v1/trash/'), []);
  });

  test('一直确认不了（每次都在读和写之间被删）→ 恢复失败，回收站那份留着', async () => {
    const b = fakeBucket(); b.versioning = true;
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    const dir = t.trashed[0].dir;
    /* 原位置总是"刚有、马上又没"：条件写一直冲突，读的时候又在 */
    b.data.set('v1/sessions/s1/transcript.jsonl', Buffer.from('别人的'));
    const putIf = b.putIf.bind(b);
    b.putIf = async (k, body, type, cond) => (k === 'v1/sessions/s1/transcript.jsonl' && 'ifMatch' in cond ? 'conflict' : putIf(k, body, type, cond));
    const get = b.getWithEtag.bind(b);
    b.getWithEtag = async (k) => {
      const g = await get(k);
      if (k === 'v1/sessions/s1/transcript.jsonl' && g) return { ...g, versionId: metaOfDir(b, dir).entry ? (await b.listVersions(k)).slice(-1)[0]?.versionId : g.versionId };
      return g;
    };
    /* 让"复制的那一版"看起来一直是现在这一版：说明文件里记的版本号改成当前的 */
    const curVid = (await get('v1/sessions/s1/transcript.jsonl'))!.versionId!;
    await updateTrashMeta(b, '', dir, (m) => ({ ...m, pendingOriginals: [{ key: 'v1/sessions/s1/transcript.jsonl', versionId: curVid }] }));
    b.getWithEtag = async (k) => { const g = await get(k); return k === 'v1/sessions/s1/transcript.jsonl' && g ? { ...g, versionId: curVid } : g; };
    await assert.rejects(() => restoreFromCloudTrash(b, '', dir, T0 + 3 * H, () => {}), /确认不了/);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/transcript.jsonl`), '回收站那份留着');
  });
});

describe('没开版本控制：删原件的锁过期了，旧任务醒来接着删', () => {
  test('A 拿着锁停住一个多小时 → B 恢复（回收站那份留着）→ A 醒来按 ETag 删 → 下一轮从回收站补回来；任何时刻都不会两份都没有', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const delIf = b.delIf.bind(b);
    let interleaved = false;
    let dir = '';
    b.delIf = async (k, etag) => {
      if (!interleaved && k.startsWith('v1/sessions/s1/')) {
        interleaved = true;
        dir = (await listCloudTrash(b, '', T0 + 2 * H, 30))[0].dir;
        /* A 在这里停了一个多小时：锁看着过期了 */
        await updateTrashMeta(b, '', dir, (m) => ({ ...m, deleting: { ...m.deleting!, at: Date.now() - 2 * H } }));
        const back = await restoreFromCloudTrash(b, '', dir, T0 + 2 * H, () => {});
        assert.ok(back.restored + back.kept >= 2);
        assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/transcript.jsonl`), 'B 恢复完，回收站那份还留着（锁还在）');
        assert.equal(metaOfDir(b, dir).undoPending, true);
      }
      const r = await delIf(k, etag);                // A 醒来，接着按 ETag 删（恢复写回的内容一样，ETag 也一样）
      /* 每删一个都检查：原位置和回收站那份不能同时没有 */
      for (const f of ['record.json', 'transcript.jsonl']) {
        assert.ok(b.data.has(`v1/sessions/s1/${f}`) || b.data.has(`v1/trash/${dir}/sessions/s1/${f}`), `${f} 两份都没了`);
      }
      return r;
    };
    await A.sync(b, T0 + 2 * H);
    assert.ok(interleaved);
    /*
      A 删完、收尾去掉锁之后，同一轮的重试看到"待撤回"：从回收站把缺的补回原位置，锁没了才删回收站那份。
      最后原位置是完整的。
    */
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), '{"id":"m1","text":"s1"}\n');
    assert.ok(b.data.has('v1/sessions/s1/record.json'));
    assert.deepEqual(keysUnder(b, `v1/trash/${dir}/`), []);
  });

  test('有"正在恢复"的锁，不管多旧，删原件都不越过它', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const t = await A.sync(b, T0 + 2 * H);
    b.failDelOn = undefined;
    const dir = t.trashed[0].dir;
    await updateTrashMeta(b, '', dir, (m) => ({ ...m, restoring: { at: Date.now() - 10 * DAY_MS, by: 'B#old' } }));
    await runCloudCleanup(b, { now: T0 + 3 * H, settings: cleanupSettings({}), thisMachine: 'A', deviceId: 'dA', log: () => {} });
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'), '恢复停住了也可能醒来：不删');
  });

  test('同一台设备的新一轮可以接手自己以前那一轮留下的锁，把删原件做完；别的设备的锁不接', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const t = await A.sync(b, T0 + 2 * H);
    b.failDelOn = undefined;
    const dir = t.trashed[0].dir;
    await updateTrashMeta(b, '', dir, (m) => ({ ...m, moving: true, deleting: { at: Date.now(), by: 'dOther#1' } }));
    await runCloudCleanup(b, { now: T0 + 3 * H, settings: cleanupSettings({}), thisMachine: 'A', deviceId: 'dA', log: () => {} });
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'), '别的设备的锁：不接');
    await updateTrashMeta(b, '', dir, (m) => ({ ...m, deleting: { at: Date.now(), by: 'dA#earlier' } }));
    await runCloudCleanup(b, { now: T0 + 4 * H, settings: cleanupSettings({}), thisMachine: 'A', deviceId: 'dA', log: () => {} });
    assert.equal(b.data.has('v1/sessions/s1/transcript.jsonl'), false, '自己设备以前那一轮的锁：接手、删完');
    assert.equal(metaOfDir(b, dir).deleting, undefined, '删完锁放掉');
  });
});

describe('开了版本控制：回收站的彻底删除清掉全部历史版本', () => {
  const versionsUnder = async (b: FakeBucket, dir: string) => {
    let n = 0;
    for (const k of ['sessions/s1/record.json', 'sessions/s1/transcript.jsonl', '.kirolex-trash.json']) n += (await b.listVersions(`v1/trash/${dir}/${k}`)).length;
    return n;
  };
  const trashed = async () => {
    const b = fakeBucket(); b.versioning = true;
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    const dir = t.trashed[0].dir;
    assert.ok((await b.listVersions(`v1/trash/${dir}/.kirolex-trash.json`)).length >= 2, '说明文件改过几次，有好几个版本');
    return { b, A, dir };
  };

  test('到期清空：内容和说明文件的所有版本都没了', async () => {
    const { b, A, dir } = await trashed();
    const r = await A.sync(b, T0 + 2 * H + 31 * DAY_MS);
    assert.deepEqual(r.purged.map((x) => x.id), ['s1']);
    assert.equal(await versionsUnder(b, dir), 0, '历史版本也清空了');
  });

  test('手动彻底删除：同样清干净', async () => {
    const { b, dir } = await trashed();
    await purgeCloudTrashItem(b, '', dir, () => {});
    assert.equal(await versionsUnder(b, dir), 0);
  });

  test('恢复之后删回收站那份：同样不留历史版本', async () => {
    const { b, dir } = await trashed();
    await restoreFromCloudTrash(b, '', dir, T0 + 3 * H, () => {});
    assert.equal(await versionsUnder(b, dir), 0);
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'));
  });

  test('deleteAllVersions：删除标记也一起删；没开版本控制就是普通删除', async () => {
    const markers: string[] = [];
    const b = fakeBucket();
    b.versioning = true;
    b.data.set('k', Buffer.from('a')); b.data.set('k', Buffer.from('b'));
    const lv = b.listVersions.bind(b);
    b.listVersions = async (k) => [{ versionId: 'dm1', isLatest: true, isDeleteMarker: true }, ...(await lv(k))];
    const dv = b.delVersion.bind(b);
    b.delVersion = async (k, v) => { if (v === 'dm1') { markers.push(v); return; } return dv(k, v); };
    await deleteAllVersions(b, 'k');
    assert.deepEqual(markers, ['dm1'], '删除标记也删了');
    assert.deepEqual(await lv('k'), []);
    const plain = fakeBucket();
    plain.data.set('k', Buffer.from('a'));
    await deleteAllVersions(plain, 'k');
    assert.equal(plain.data.has('k'), false);
  });
});

describe('写回原件 / 撤回：再补两个交错', () => {
  test('条件写说"已经有了"，紧接着读的时候它刚被删掉（读到不存在）→ 不算保留，再写一次，文件在', async () => {
    const b = fakeBucket(); b.versioning = true;
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const t = await A.sync(b, T0 + 2 * H);
    b.failDelOn = undefined;
    const dir = t.trashed[0].dir;
    const key = 'v1/sessions/s1/transcript.jsonl';
    const copied = { key, versionId: metaOfDir(b, dir).pendingOriginals[0].versionId };
    /* 恢复读原件之前的那一刻，删原件那一边把它删了 → 恢复读到"不存在" */
    const get = b.getWithEtag.bind(b);
    let deletedBefore = false;
    b.getWithEtag = async (k) => {
      if (!deletedBefore && k === key) { deletedBefore = true; await deleteOriginalVersion(b, copied); }
      return get(k);
    };
    const back = await restoreFromCloudTrash(b, '', dir, T0 + 3 * H, () => {});
    assert.ok(deletedBefore);
    assert.equal(b.data.get(key)!.toString(), '{"id":"m1","text":"s1"}\n', '文件在');
    assert.equal(back.kept, 0);
  });

  test('撤回时说明文件上有别的设备留下的旧 deleting 锁 → 文件补回去，但回收站那份留着；那边醒来删完、放掉锁之后才收尾', async () => {
    const b = fakeBucket();                            // 没开版本控制
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const t = await A.sync(b, T0 + 2 * H);
    b.failDelOn = undefined;
    const dir = t.trashed[0].dir;
    /* 别的设备拿着删原件的锁停住了（一个多小时）；同时 B 说它还有 s1 → 要撤回 */
    await updateTrashMeta(b, '', dir, (m) => ({ ...m, moving: true, deleting: { at: Date.now() - 2 * H, by: 'dOther#1' } }));
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('B', T0 + 3 * H, [{ id: 's1' }], {})))));
    await runCloudCleanup(b, { now: T0 + 3 * H, settings: cleanupSettings({}), thisMachine: 'A', deviceId: 'dA', log: () => {} });
    assert.ok(b.data.has('v1/sessions/s1/record.json'), '缺的补回去了');
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/transcript.jsonl`), '锁还在：回收站那份留着');
    /* 那边醒来，按 ETag 把原位置的 transcript 删了（内容一样）—— 回收站那份还在 */
    await b.delIf('v1/sessions/s1/transcript.jsonl', metaOfDir(b, dir).pendingOriginals[0].etag);
    assert.equal(b.data.has('v1/sessions/s1/transcript.jsonl'), false);
    assert.ok(b.data.has(`v1/trash/${dir}/sessions/s1/transcript.jsonl`), '保底还在');
    await updateTrashMeta(b, '', dir, (m) => { const { deleting: _d, ...rest } = m; return rest; });   // 那边收尾放掉锁
    await runCloudCleanup(b, { now: T0 + 4 * H, settings: cleanupSettings({}), thisMachine: 'A', deviceId: 'dA', log: () => {} });
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), '{"id":"m1","text":"s1"}\n', '补回来了');
    assert.deepEqual(keysUnder(b, `v1/trash/${dir}/`), [], '锁没了才删回收站那份');
  });
});

describe('deleteAllVersions：列不出版本（没有 ListBucketVersions 权限）', () => {
  test('桶没开版本控制 → 普通删除照常删掉；开了 → 报错、不做"只加删除标记"的假删除', async () => {
    const plain = fakeBucket();
    plain.data.set('k', Buffer.from('a'));
    plain.listVersions = async () => { throw new Error('AccessDenied'); };
    await deleteAllVersions(plain, 'k');
    assert.equal(plain.data.has('k'), false);

    const v = fakeBucket(); v.versioning = true;
    v.data.set('k', Buffer.from('a'));
    v.listVersions = async () => { throw new Error('AccessDenied'); };
    await assert.rejects(() => deleteAllVersions(v, 'k'), /AccessDenied/);
    assert.ok(v.data.has('k'), '没删');
  });
});

describe('彻底删除：被删除标记藏起来的旧版本、开版本控制前的 null 版本', () => {
  const trashedVersioned = async () => {
    const b = fakeBucket(); b.versioning = true;
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    return { b, A, dir: t.trashed[0].dir };
  };
  const allVersions = async (b: FakeBucket, dir: string) => {
    let n = 0;
    for (const k of await b.listVersionKeys(`v1/trash/${dir}/`)) n += (await b.listVersions(k)).length;
    return n;
  };

  test('删到一半（新版本删了、删除标记那一下网络失败）→ 说明文件留着；下一轮按版本列表找到被藏起来的 key，全删完才删说明文件', async () => {
    const { b, dir } = await trashedVersioned();
    const K = `v1/trash/${dir}/sessions/s1/transcript.jsonl`;
    /* 造出"新版本 + 删除标记 + 旧版本" */
    await b.del(K);
    b.data.set(K, Buffer.from('新版本'));
    const vs = await b.listVersions(K);
    assert.deepEqual(vs.map((v) => !!v.isDeleteMarker), [false, true, false]);
    const markerVid = vs[1].versionId;
    let failOnce = true;
    b.failDelVersion = (k, vid) => { if (k === K && vid === markerVid && failOnce) { failOnce = false; return true; } return false; };
    await assert.rejects(() => purgeCloudTrashItem(b, '', dir, () => {}));
    assert.ok(b.data.has(`v1/trash/${dir}/.kirolex-trash.json`), '说明文件留着');
    assert.equal(b.data.has(K), false, '普通列表里已经看不见这个 key 了');
    assert.ok((await b.listVersions(K)).length >= 2, '但删除标记和旧版本还在');
    /* 下一轮 */
    await purgeCloudTrashItem(b, '', dir, () => {});
    assert.deepEqual(await b.listVersions(K), [], '藏起来的旧版本也删了');
    assert.equal(await allVersions(b, dir), 0, '整个目录一个版本都不剩（说明文件最后删）');
  });

  test('一开始就藏着（只剩"删除标记 + 旧版本"）→ 到期清空照样找到、删干净', async () => {
    const { b, A, dir } = await trashedVersioned();
    const K = `v1/trash/${dir}/sessions/s1/record.json`;
    await b.del(K);                                    // 删除标记压在旧版本上
    assert.equal(b.data.has(K), false);
    const r = await A.sync(b, T0 + 2 * H + 31 * DAY_MS);
    assert.deepEqual(r.purged.map((x) => x.id), ['s1']);
    assert.deepEqual(await b.listVersions(K), []);
    assert.equal(await allVersions(b, dir), 0);
  });

  test('开版本控制之前写的 null 版本 + 之后的正常版本：deleteAllVersions 全删（null 版本不会重新变成当前对象）', async () => {
    const b = fakeBucket();                            // 先没开
    b.data.set('k', Buffer.from('开之前'));
    b.versioning = true;
    b.data.set('k', Buffer.from('开之后'));
    assert.deepEqual((await b.listVersions('k')).map((v) => v.versionId).slice(-1), ['null'], '栈底是 null 版本');
    await deleteAllVersions(b, 'k');
    assert.deepEqual(await b.listVersions('k'), []);
    assert.equal(b.data.has('k'), false, '没有旧的 null 版本顶上来');
  });

  test('回收站这一份在开版本控制之前就进来了，之后开了版本控制再到期：所有版本（含 null）都清空', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    const dir = t.trashed[0].dir;
    b.versioning = true;                               // 之后开了版本控制
    await updateTrashMeta(b, '', dir, (m) => ({ ...m }));   // 说明文件又被改过一次（多一个正常版本）
    const r = await A.sync(b, T0 + 2 * H + 31 * DAY_MS);
    assert.deepEqual(r.purged.map((x) => x.id), ['s1']);
    assert.equal(await allVersions(b, dir), 0);
  });
});

describe('彻底删除：说明文件删之前核对一遍', () => {
  test('删内容都"成功"了，但其实还剩一个版本（存储接了请求却没删掉）→ 核对出来，说明文件留着；下次删干净', async () => {
    const b = fakeBucket(); b.versioning = true;
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    const t = await A.sync(b, T0 + 2 * H);
    const dir = t.trashed[0].dir;
    const K = `v1/trash/${dir}/sessions/s1/transcript.jsonl`;
    const dv = b.delVersion.bind(b);
    let swallow = true;
    b.delVersion = async (k, vid) => { if (k === K && swallow) { swallow = false; return; } return dv(k, vid); };   // 报成功、其实没删
    await assert.rejects(() => purgeCloudTrashItem(b, '', dir, () => {}), /还有版本没删掉/);
    assert.ok(b.data.has(`v1/trash/${dir}/.kirolex-trash.json`), '说明文件留着');
    await purgeCloudTrashItem(b, '', dir, () => {});
    assert.deepEqual(await b.listVersionKeys(`v1/trash/${dir}/`), []);
  });
});

describe('开版本控制之前上传的原件（VersionId 是 "null"）', () => {
  const versionsAt = async (b: FakeBucket, prefix: string) => {
    const out: string[] = [];
    for (const k of await b.listVersionKeys(prefix)) for (const v of await b.listVersions(k)) out.push(`${k}#${v.versionId}${v.isDeleteMarker ? '(删除标记)' : ''}`);
    return out;
  };

  test('端到端：没开版本控制时上传 → 开了版本控制 → 两台设备都删了 → 移进回收站 → 到期清空：原位置和回收站都不剩任何版本或删除标记', async () => {
    const b = fakeBucket();                            // 先没开版本控制
    const A = machine('A'); const B = machine('B');
    A.create('s1', T0); await A.sync(b, T0);
    B.create('s1', T0 + H); await B.sync(b, T0 + H);
    assert.deepEqual((await b.listVersions('v1/sessions/s1/transcript.jsonl')).map((v) => v.versionId), ['null'], '原件是 null 版本');
    /* 两台都在本机删了它，然后桶开了版本控制（原件之后没人再重写过） */
    A.remove('s1', T0 + 2 * H); B.remove('s1', T0 + 2 * H + 1);
    b.versioning = true;
    await A.sync(b, T0 + 3 * H);
    const r = await B.sync(b, T0 + 3 * H + 1000);
    assert.deepEqual(r.trashed.map((x) => x.id), ['s1']);
    const dir = r.trashed[0].dir;
    assert.equal(metaOfDir(b, dir).pendingOriginals, undefined, '原件都删完了');
    assert.deepEqual(await versionsAt(b, 'v1/sessions/s1/'), [], '原位置：null 版本按版本删掉了，没有只加删除标记');
    const purged = await A.sync(b, T0 + 3 * H + 31 * DAY_MS);
    assert.deepEqual(purged.purged.map((x) => x.id), ['s1']);
    assert.deepEqual(await versionsAt(b, `v1/trash/${dir}/`), [], '回收站：一个版本都不剩');
    assert.deepEqual(await versionsAt(b, 'v1/sessions/s1/'), [], '原位置还是干净的');
  });

  test('null 版本：桶现在开着版本控制 → 按版本删（不留删除标记）；没开 / 暂停 → 走 ETag 条件删除', async () => {
    const b = fakeBucket();
    b.data.set('v1/sessions/s1/a', Buffer.from('x'));
    b.versioning = true;
    const got = (await b.getWithEtag('v1/sessions/s1/a'))!;
    assert.equal(got.versionId, 'null');
    assert.equal(await deleteOriginalVersion(b, { key: 'v1/sessions/s1/a', versionId: 'null', etag: got.etag }, true), 'deleted');
    assert.deepEqual(await b.listVersions('v1/sessions/s1/a'), [], '没有删除标记');

    const c = fakeBucket();                            // 没开：只能按 ETag 删
    c.data.set('v1/sessions/s1/a', Buffer.from('x'));
    const etag = (await c.getWithEtag('v1/sessions/s1/a'))!.etag;
    let byVersion = 0;
    const dv = c.delVersion.bind(c);
    c.delVersion = async (k, v) => { byVersion += 1; return dv(k, v); };
    assert.equal(await deleteOriginalVersion(c, { key: 'v1/sessions/s1/a', versionId: 'null', etag }, false), 'deleted');
    assert.equal(byVersion, 0, '没开 / 暂停时不按版本删（新写入会覆盖 null 版本）');
    assert.equal(c.data.has('v1/sessions/s1/a'), false);
  });

  test('null 版本的原件删除要拿锁（和恢复互斥）', async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    A.remove('s1', T0 + H);
    b.versioning = true;
    /* 复制完、删原件之前有人在恢复（restoring 锁）→ 这一次不删 */
    const putIf = b.putIf.bind(b);
    let locked = false;
    b.putIf = async (k, body, type, cond) => {
      const r = await putIf(k, body, type, cond);
      if (!locked && k === catalogKey('') && r === 'ok' && (await b.listVersionKeys('v1/trash/')).length) {
        locked = true;
        const dir = (await listCloudTrash(b, '', T0 + 2 * H, 30))[0].dir;
        await updateTrashMeta(b, '', dir, (m) => ({ ...m, restoring: { at: Date.now(), by: 'B#1' } }));
      }
      return r;
    };
    await A.sync(b, T0 + 2 * H);
    assert.ok(locked);
    assert.ok(b.data.has('v1/sessions/s1/transcript.jsonl'), '拿不到锁：null 版本的原件不删');
  });
});

describe('暂停版本控制的桶：新上传覆盖 null 版本，版本号还是 "null"', () => {
  /* 原件是 null 版本、桶暂停了版本控制；移进回收站时 transcript 没删掉（留着待删）；之后另一台设备上传了新内容 */
  const setup = async () => {
    const b = fakeBucket();
    const A = machine('A');
    A.create('s1', T0); await A.sync(b, T0);
    b.suspended = true;
    A.remove('s1', T0 + H);
    b.failDelOn = (k) => k === 'v1/sessions/s1/transcript.jsonl';
    const t = await A.sync(b, T0 + 2 * H);
    b.failDelOn = undefined;
    assert.equal(t.trashed.length, 1);
    const dir = t.trashed[0].dir;
    assert.equal(metaOfDir(b, dir).pendingOriginals[0].versionId, 'null', '记下的是 "null"');
    b.data.set('v1/sessions/s1/transcript.jsonl', Buffer.from('另一台设备后来传的新内容'));
    assert.equal((await b.getWithEtag('v1/sessions/s1/transcript.jsonl'))!.versionId, 'null', '新内容的版本号也还是 "null"');
    return { b, A, dir };
  };

  test('恢复：不拿回收站里的旧内容盖掉后来传的新内容', async () => {
    const { b, dir } = await setup();
    const back = await restoreFromCloudTrash(b, '', dir, T0 + 3 * H, () => {});
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), '另一台设备后来传的新内容');
    assert.ok(b.data.has('v1/sessions/s1/record.json'), '缺的照常补回来');
    assert.ok(back.kept >= 1);
  });

  test('撤回：同样不盖新内容', async () => {
    const { b, A, dir } = await setup();
    b.data.set(catalogKey(''), Buffer.from(JSON.stringify(withDeviceManifest(readCat(b), buildDeviceManifest('B', T0 + 3 * H, [{ id: 's1' }], {})))));
    await A.sync(b, T0 + 4 * H);
    assert.equal(b.data.get('v1/sessions/s1/transcript.jsonl')!.toString(), '另一台设备后来传的新内容');
    assert.ok(b.data.has('v1/sessions/s1/record.json'));
    assert.deepEqual(keysUnder(b, `v1/trash/${dir}/`), [], '撤回做完');
  });
});
