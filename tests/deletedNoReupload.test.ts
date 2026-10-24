/**
 * 删掉的云端备份不再被重新传上去 ——「删掉的云端备份还会被重新传上去，要统一」（2026-10-24）。
 *
 * 以前：点「删除备份」的那台电脑下次同步就把这条会话整条重传（它的状态表被清了），别的电脑要等会话有新改动才传。
 * 现在所有电脑一样：删除记录（catalog 的 deleted，带删除时刻）之后，这条会话的最后修改时间（record.updatedAt）
 * 不晚于删除时刻 → 跳过上传、不写 catalog 条目（恢复页不显示）；晚于 → 整条重传，重新出现。
 *
 * 两台"电脑"各用一个临时目录，按 index.ts 的顺序走真实的 planUpload / deletedSessionPlan / writeSyncCatalog，
 * 桶是内存里的假 S3。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deletedSessionPlan, dropSessionState, deleteSessionBackups, writeSyncCatalog, readCatalog, catalogIO,
  sessionIdsFromPrefixes, type CatalogBucket,
} from '../src/main/catalogStore.ts';
import { planUpload, keyFor, sessionChangedAt, type SyncState, type CatalogEntry, type Catalog } from '../src/main/s3Sync.ts';

const P = 'kx';

class FakeS3 implements CatalogBucket {
  objects = new Map<string, { body: Buffer; etag: string }>();
  n = 0;
  async get(key: string) { const o = this.objects.get(key); return o ? { body: Buffer.from(o.body), etag: o.etag } : null; }
  async put(key: string, body: Buffer, cond: { ifMatch: string } | { ifNoneMatch: '*' } | null) {
    const cur = this.objects.get(key);
    if (cond && 'ifMatch' in cond && (!cur || cur.etag !== cond.ifMatch)) return 'conflict' as const;
    if (cond && 'ifNoneMatch' in cond && cur) return 'conflict' as const;
    this.objects.set(key, { body: Buffer.from(body), etag: `"e${++this.n}"` });
    return 'ok' as const;
  }
  async list(prefix: string) { return [...this.objects.keys()].filter((k) => k.startsWith(prefix)); }
  async del(key: string) { this.objects.delete(key); }
  async sessionIds() {
    const head = `${P}/v1/sessions/`;
    return sessionIdsFromPrefixes(P, [...new Set([...this.objects.keys()].filter((k) => k.startsWith(head))
      .map((k) => head + k.slice(head.length).split('/')[0] + '/'))]);
  }
  async deletedAt(id: string) { return (await this.list(`${P}/v1/sessions/${id}/`)).length ? 'live' as const : null; }
}

/** 一台"电脑"：本地 ~/.kirolex（临时目录）+ 它的状态表 + 上次真传完的时刻。 */
class Machine {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-del-'));
  state: SyncState = {};
  uploadedAt = new Map<string, number>();
  name: string;
  constructor(name: string) { this.name = name; }
  write(id: string, updatedAt: number, transcript: string) {
    const dir = path.join(this.home, 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ id, title: id, updatedAt }));
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), transcript);
    /* history.md 只在第一次写 —— 之后新消息不动它，用来验"整条重传"连没变的文件也传 */
    if (!fs.existsSync(path.join(dir, 'history.md'))) fs.writeFileSync(path.join(dir, 'history.md'), '# s');
  }
  sessions() {
    const root = path.join(this.home, 'sessions');
    return fs.readdirSync(root).map((id) => {
      const rec = JSON.parse(fs.readFileSync(path.join(root, id, 'record.json'), 'utf-8')) as { id: string; updatedAt: number };
      /* 和 index.ts 一样：「有没有新改动」看对话本身（transcript），不看 record.updatedAt */
      return { ...rec, changedAt: sessionChangedAt(this.home, id) };
    });
  }
  /** 执行器断开 / 回收：只改 record.json（executorState + updatedAt 变成现在），对话一个字没动。 */
  touchRecordOnly(id: string) {
    const f = path.join(this.home, 'sessions', id, 'record.json');
    const rec = JSON.parse(fs.readFileSync(f, 'utf-8'));
    fs.writeFileSync(f, JSON.stringify({ ...rec, executorState: 'detached', updatedAt: Date.now() }));
  }
  /** 一轮同步：和 index.ts 的 runS3Sync 同一个顺序。返回这一轮传了哪些文件。 */
  async sync(s3: FakeS3, hooks: { afterPlan?: () => Promise<void> } = {}): Promise<string[]> {
    const catalog = await readCatalog(catalogIO(s3, P));
    const all = this.sessions();
    const plan0 = deletedSessionPlan(all, catalog);
    dropSessionState(this.state, plan0.reupload);
    const sessions = all.filter((r) => !plan0.skip.has(r.id));
    const plan = planUpload(this.home, sessions.map((r) => r.id), this.state);
    /* 读完目录、做完计划之后，上传之前 —— 测试在这里插一次别处的删除 */
    if (hooks.afterPlan) await hooks.afterPlan();
    for (const rel of plan.upload) {
      const abs = path.join(this.home, rel);
      await s3.put(keyFor(P, rel), fs.readFileSync(abs), null);
      const st = fs.statSync(abs);
      this.state[rel] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
      this.uploadedAt.set(rel.split(/[\\/]/)[1], Date.now());
    }
    const fresh: CatalogEntry[] = sessions.map((r) => ({
      id: r.id, title: r.id, updatedAt: r.updatedAt, bytes: 1, from: this.name, syncedAt: Date.now(),
      ...(this.uploadedAt.get(r.id) ? { uploadedAt: this.uploadedAt.get(r.id) } : null),
    }));
    /* 和 index.ts 一样把每条会话「对话最后一次变的时刻」交给写目录那一步，按最新的删除记录再核对一遍 */
    await writeSyncCatalog(s3, P, fresh, Date.now(), undefined, new Map(sessions.map((r) => [r.id, r.changedAt])));
    return plan.upload.map((r) => r.split(path.sep).join('/'));
  }
  /** 点「删除备份」：和 index.ts 的 deleteBackupsOf 一样，删桶里的、清本机状态表。 */
  async deleteBackup(s3: FakeS3, id: string) {
    await deleteSessionBackups(s3, P, [id]);
    dropSessionState(this.state, [id]);
    this.uploadedAt.delete(id);
  }
}

const restoreList = async (s3: FakeS3): Promise<string[]> => ((await readCatalog(catalogIO(s3, P))) as Catalog).entries.map((e) => e.id).sort();
const tick = () => new Promise((r) => setTimeout(r, 5));

async function setup() {
  const s3 = new FakeS3();
  const A = new Machine('A');
  const B = new Machine('B');
  const t0 = Date.now() - 60_000;
  for (const m of [A, B]) { m.write('s1', t0, '{"id":"m1"}\n'); m.write('s2', t0, '{"id":"m1"}\n'); }
  await A.sync(s3);
  await B.sync(s3);
  assert.deepEqual(await restoreList(s3), ['s1', 's2']);
  await tick();
  await A.deleteBackup(s3, 's1');
  assert.deepEqual(await restoreList(s3), ['s2']);
  return { s3, A, B, t0 };
}

describe('删除之后没有新改动 → 哪台电脑都不重传', () => {
  test('点删除的那台（A）和另一台（B）各同步两轮：s1 一个文件都不传，恢复页不显示', async () => {
    const { s3, A, B } = await setup();
    for (let round = 0; round < 2; round++) {
      assert.deepEqual((await A.sync(s3)).filter((r) => r.includes('/s1/')), [], `A 第 ${round + 1} 轮不该传 s1`);
      assert.deepEqual((await B.sync(s3)).filter((r) => r.includes('/s1/')), [], `B 第 ${round + 1} 轮不该传 s1`);
    }
    assert.deepEqual(await restoreList(s3), ['s2']);
    assert.deepEqual([...await s3.sessionIds()].sort(), ['s2'], '桶里也没有 s1 的文件');
    /* 删除记录还在，之后的同步照样认 */
    assert.ok((((await readCatalog(catalogIO(s3, P))) as Catalog).deleted || []).some((t) => t.id === 's1'));
  });

  test('最后修改时间正好等于删除时刻也算"没有新改动"', () => {
    const plan = deletedSessionPlan([{ id: 's1', changedAt: 500 }], { version: 1, entries: [], deleted: [{ id: 's1', at: 500 }] }, 1000);
    assert.deepEqual([...plan.skip], ['s1']);
    assert.deepEqual([...plan.reupload], []);
  });
});

describe('只是执行器断开 / 回收、或者删除记录很旧了 → 照样不重传', () => {
  test('删除之后执行器断开 / 被回收（record.json 的 updatedAt 变成现在，对话没动）→ 两台都不重传', async () => {
    const { s3, A, B } = await setup();
    await tick();
    A.touchRecordOnly('s1');
    B.touchRecordOnly('s1');
    assert.deepEqual((await A.sync(s3)).filter((r) => r.includes('/s1/')), []);
    assert.deepEqual((await B.sync(s3)).filter((r) => r.includes('/s1/')), []);
    assert.deepEqual(await restoreList(s3), ['s2']);
  });

  test('删除记录超过一年、会话一直没改 → 还是不重传（删除记录不过期）', () => {
    const now = Date.now();
    const yearAndMore = 400 * 86_400_000;
    const catalog: Catalog = { version: 1, entries: [], deleted: [{ id: 's1', at: now - yearAndMore }] };
    const plan = deletedSessionPlan([{ id: 's1', changedAt: now - yearAndMore - 60_000 }], catalog, now);
    assert.deepEqual([...plan.skip], ['s1']);
    assert.deepEqual([...plan.reupload], []);
  });

  test('删除记录超过一年，点删除那台（状态表已清）同步：还是不传', async () => {
    const { s3, A } = await setup();
    /* 把桶里的删除记录改成 400 天前、本地对话也是那之前的 */
    const old = Date.now() - 400 * 86_400_000;
    const c = (await readCatalog(catalogIO(s3, P))) as Catalog;
    await s3.put(`${P}/v1/catalog.json`, Buffer.from(JSON.stringify({ ...c, deleted: [{ id: 's1', at: old }] })), null);
    const tr = path.join(A.home, 'sessions', 's1', 'transcript.jsonl');
    fs.utimesSync(tr, new Date(old - 60_000), new Date(old - 60_000));
    assert.deepEqual((await A.sync(s3)).filter((r) => r.includes('/s1/')), []);
    assert.deepEqual(await restoreList(s3), ['s2']);
  });
});

describe('删除和正在进行的同步撞在一起', () => {
  test('B 的同步先读目录 → A 完成删除 → B 继续上传 s1 的旧文件：s1 不重新出现，删除记录还在', async () => {
    const s3 = new FakeS3();
    const A = new Machine('A');
    const B = new Machine('B');
    const t0 = Date.now() - 60_000;
    for (const m of [A, B]) { m.write('s1', t0, '{"id":"m1"}'); m.write('s2', t0, '{"id":"m1"}'); }
    await A.sync(s3);
    await B.sync(s3);
    /* s1 在删除之前就有一条 B 还没传的改动，所以 B 这一轮的计划里有它 */
    await tick();
    B.write('s1', Date.now(), '{"id":"m1"}{"id":"m-b"}');
    await tick();
    const sent = await B.sync(s3, {
      /* B 已经读完目录（那时 s1 还没有删除记录）、做完计划；这时 A 把 s1 的备份删掉 */
      afterPlan: async () => { await tick(); await A.deleteBackup(s3, 's1'); await tick(); },
    });
    assert.ok(sent.some((r) => r.includes('/s1/')), 'B 这一轮确实在删除之后把 s1 的旧文件传了上去');
    assert.deepEqual(await restoreList(s3), ['s2'], 's1 不能因为「上传时间晚于删除」就重新出现');
    assert.ok((((await readCatalog(catalogIO(s3, P))) as Catalog).deleted || []).some((t) => t.id === 's1'), '删除记录不能被清掉');
    /* 之后两台都没有新改动 → 还是不传、不出现 */
    assert.deepEqual((await B.sync(s3)).filter((r) => r.includes('/s1/')), []);
    assert.deepEqual((await A.sync(s3)).filter((r) => r.includes('/s1/')), []);
    assert.deepEqual(await restoreList(s3), ['s2']);
  });

  test('接线：同一台电脑上，同步这一轮开始之后本机删掉的会话，剩下的文件不再上传', () => {
    const MI = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = MI.indexOf('async function runS3Sync');
    const body = MI.slice(at, MI.indexOf('function rescheduleS3Sync', at));
    assert.match(body, /if \(owner && \(backupDeletedAt\.get\(owner\) \?\? 0\) >= syncStartedAt\) continue;/);
    /* 写 catalog 时把对话最后一次变的时刻交进去，按最新的删除记录再核对 */
    assert.match(body, /\(c\) => withDeviceManifest\(c, manifest\), changedAtById\)\)/);
    assert.ok(body.indexOf('backupDeletedAt.get(owner)') < body.indexOf('await putObject(creds!, key, body'), '判断在上传之前');
  });
});

describe('删除之后有新消息 → 整条重传、重新出现', () => {
  test('另一台（B）上来了新消息：整条（含没变的文件）重传，恢复页又有 s1；A 之后同步也不再跳过它', async () => {
    const { s3, A, B } = await setup();
    await B.sync(s3);
    await tick();   // 新消息要晚于删除时刻（同一毫秒算「没有新改动」）
    B.write('s1', Date.now(), '{"id":"m1"}\n{"id":"m2"}\n');
    const sent = (await B.sync(s3)).filter((r) => r.includes('/s1/')).sort();
    assert.deepEqual(sent, ['sessions/s1/history.md', 'sessions/s1/record.json', 'sessions/s1/transcript.jsonl']);
    assert.deepEqual(await restoreList(s3), ['s1', 's2']);
    assert.ok((await s3.sessionIds()).has('s1'));
    /* 重新上传之后删除记录作废 —— 不会再把它挡掉 */
    assert.equal((((await readCatalog(catalogIO(s3, P))) as Catalog).deleted || []).some((t) => t.id === 's1'), false);
  });

  test('点删除的那台（A）自己之后又聊了：A 下一轮整条重传', async () => {
    const { s3, A } = await setup();
    assert.deepEqual((await A.sync(s3)).filter((r) => r.includes('/s1/')), []);
    await tick();   // 新消息要晚于删除时刻（同一毫秒算「没有新改动」）
    A.write('s1', Date.now(), '{"id":"m1"}\n{"id":"m2"}\n');
    const sent = (await A.sync(s3)).filter((r) => r.includes('/s1/')).sort();
    assert.deepEqual(sent, ['sessions/s1/history.md', 'sessions/s1/record.json', 'sessions/s1/transcript.jsonl']);
    assert.deepEqual(await restoreList(s3), ['s1', 's2']);
  });
});

describe('接线（index.ts）', () => {
  const MI = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const at = MI.indexOf('async function runS3Sync');
  const body = MI.slice(at, MI.indexOf('function rescheduleS3Sync', at));
  test('同步在做上传计划之前按删除记录筛会话：跳过的不传、不进 catalog；要重传的先清状态表', () => {
    /* 「有没有新改动」看对话（transcript 的修改时间），不看 record.updatedAt —— 执行器断开也会改它 */
    assert.match(body, /const changedAtById = new Map\(syncable\.map\(\(r\) => \[r\.id, sessionChangedAt\(KIROLEX_HOME, r\.id\)\]\)\);/);
    assert.match(body, /const deletedPlan = deletedSessionPlan\(syncable\.map\(\(r\) => \(\{ id: r\.id, changedAt: changedAtById\.get\(r\.id\) \}\)\), oldCatalog\);/);
    assert.match(body, /dropSessionState\(state, deletedPlan\.reupload\);/);
    assert.match(body, /const sessions = syncable\.filter\(\(r\) => !deletedPlan\.skip\.has\(r\.id\)\);/);
    assert.ok(body.indexOf('deletedSessionPlan(') < body.indexOf('planUpload('), '筛在上传计划之前');
  });
});
