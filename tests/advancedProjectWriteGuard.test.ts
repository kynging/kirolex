import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
  「不许把会话放进 advanced 专属项目」收到写盘那一道关：发消息、新建、移动、S3 恢复、跟随云端归属、
  冲突合并……各路径都有前置拒绝，这里直接调写盘函数，确认最后一道兜底也挡得住。

  临时 HOME：
    projects/周报/runs/ + flows/周报.json，只有 flow-main 会话 → advanced 专属项目
    Plain / Other                                           → 普通项目
*/
describe('sessionStore write layer: projectId never lands in an advanced-only project', () => {
  let home = '';
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let store: typeof import('../src/main/sessionStore.ts');
  const K = () => path.join(home, '.kirolex');
  const write = (rel: string, text: string) => {
    const f = path.join(K(), rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  const session = (id: string, projectId?: string, purpose?: string) => write(`sessions/${id}/record.json`, JSON.stringify({
    schemaVersion: 1, id, createdAt: 1, updatedAt: 1000, title: id,
    profile: projectId ? { projectId } : {}, executorState: 'detached',
    ...(purpose ? { purpose, flow: projectId } : {}),
  }, null, 2));
  const onDisk = (id: string) => JSON.parse(fs.readFileSync(path.join(K(), 'sessions', id, 'record.json'), 'utf-8'));
  const withProject = (rec: any, projectId: string) => ({ ...rec, profile: { ...rec.profile, projectId } });

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-advwrite-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assert.equal(os.homedir(), home);
    write('projects/周报/runs/run_1.json', '{}');
    write('flows/周报.json', JSON.stringify({ name: '周报', steps: [] }));
    session('s_weekly_main', '周报', 'flow-main');
    session('s_in_plain', 'Plain');
    session('s_loose');
    session('s_patch', 'Plain');
    session('s_keep', 'Plain');
    session('s_ok', 'Plain');
    store = await import('../src/main/sessionStore.ts');
    assert.equal(store.isAdvancedOnlyProjectName('周报'), true);
  });
  after(() => {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('writeRecord: a session in a normal project keeps its projectId on disk; the rest of the write goes through', () => {
    const rec = store.readRecord('s_in_plain')!;
    store.writeRecord({ ...withProject(rec, '周报'), title: 'renamed' });
    const d = onDisk('s_in_plain');
    assert.equal(d.profile.projectId, 'Plain');
    assert.equal(d.title, 'renamed', 'other fields are still written');
    assert.equal(store.isAdvancedOnlyProjectName('周报'), true, 'the project stays protected');
  });

  test('writeRecord: an ungrouped session stays ungrouped', () => {
    const rec = store.readRecord('s_loose')!;
    store.writeRecord(withProject(rec, ' 周报 '));
    assert.equal(onDisk('s_loose').profile.projectId, undefined);
  });

  test('patchRecord / writeRecordKeepUpdatedAt are covered too', () => {
    const rec = store.readRecord('s_patch')!;
    assert.equal(store.patchRecord('s_patch', { profile: { ...rec.profile, projectId: '周报' } } as any), 'written');
    assert.equal(onDisk('s_patch').profile.projectId, 'Plain');

    const keep = store.readRecord('s_keep')!;
    store.writeRecordKeepUpdatedAt(withProject(keep, '周报'));
    const d = onDisk('s_keep');
    assert.equal(d.profile.projectId, 'Plain');
    assert.equal(d.updatedAt, 1000, 'still does not bump updatedAt');
  });

  test('createSession straight into an advanced-only project lands ungrouped', () => {
    store.createSession('s_new', { projectId: '周报' } as any);
    assert.equal(onDisk('s_new').profile.projectId, undefined);
    assert.equal(store.isAdvancedOnlyProjectName('周报'), true);
  });

  test('a normal project change is written as usual', () => {
    const rec = store.readRecord('s_ok')!;
    store.writeRecord(withProject(rec, 'Other'));
    assert.equal(onDisk('s_ok').profile.projectId, 'Other');
  });

  test('a record that is not on disk yet (S3 restore of a new session) lands ungrouped, updatedAt as given', () => {
    store.writeRecordKeepUpdatedAt({
      schemaVersion: 1, id: 's_restored', createdAt: 1, updatedAt: 777, title: 'r', profile: { projectId: '周报' }, executorState: 'detached',
    } as any);
    const d = onDisk('s_restored');
    assert.equal(d.profile.projectId, undefined);
    assert.equal(d.updatedAt, 777);
  });

  test('markAllExecutorsDetached goes through the same write (state reset, updatedAt kept)', () => {
    session('s_attached', 'Plain');
    const f = path.join(K(), 'sessions', 's_attached', 'record.json');
    fs.writeFileSync(f, JSON.stringify({ ...onDisk('s_attached'), executorState: 'attached' }, null, 2));
    store.markAllExecutorsDetached();
    const d = onDisk('s_attached');
    assert.equal(d.executorState, 'detached');
    assert.equal(d.updatedAt, 1000);
    assert.equal(d.profile.projectId, 'Plain');
  });
});

/*
  路径覆盖：index.ts 里写会话记录的那几条路（S3 恢复的合并 / 新会话 / 位置 / 改回本机、
  桶里冲突自动合并、置顶）都走 `store.writeRecordKeepUpdatedAt`，不再自己写 record.json。
*/
describe('index.ts: every session-record write goes through the guarded store writer', () => {
  const main = fs.readFileSync(path.join(import.meta.dirname, '../src/main/index.ts'), 'utf8');
  const store = fs.readFileSync(path.join(import.meta.dirname, '../src/main/sessionStore.ts'), 'utf8');
  const fnBody = (src: string, start: string, end: string) => {
    const at = src.indexOf(start);
    assert.ok(at >= 0, start);
    return src.slice(at, src.indexOf(end, at));
  };

  test('s3:restore: merge, new-session copy, placement and make-local all use the store writer', () => {
    const body = fnBody(main, "ipcMain.handle('s3:restore'", '\n  });');
    assert.match(body, /const isRecord = abs === path\.join\(localDir, 'record\.json'\);/);
    assert.match(body, /if \(isRecord\) store\.writeRecordKeepUpdatedAt\(\{ \.\.\.mergeRecords\(mine, theirs\), id: sessionId \}\);/);
    assert.match(body, /if \(rec && typeof rec === 'object'\) store\.writeRecordKeepUpdatedAt\(\{ \.\.\.rec, id: sessionId \}\);/);
    assert.match(body, /store\.writeRecordKeepUpdatedAt\(\{ \.\.\.next, id: sessionId \}\);/);
    assert.match(body, /store\.writeRecordKeepUpdatedAt\(\{ \.\.\.recAfter, id: sessionId \}\);/);
    assert.doesNotMatch(body, /fs\.writeFileSync\(recordPath|fs\.renameSync\(tmp, recordPath\)|JSON\.stringify\((next|recAfter), null, 2\)/);
  });

  test('mergeBucketSession and pin use the store writer', () => {
    const merge = fnBody(main, 'async function mergeBucketSession(', '\n}\n');
    assert.match(merge, /store\.writeRecordKeepUpdatedAt\(\{ \.\.\.merged, id: sessionId \}\)/);
    assert.doesNotMatch(merge, /fs\.renameSync\(tmp, rAbs\)|JSON\.stringify\(merged/);
    const pin = fnBody(main, "ipcMain.handle('acp:set-session-pinned'", '\n  });');
    assert.match(pin, /store\.writeRecordKeepUpdatedAt\(\{ \.\.\.rec, id: sessionId \}\);/);
    assert.doesNotMatch(pin, /record\.json|fs\.writeFileSync/);
  });

  test('sessionStore: only writeRecord / writeRecordKeepUpdatedAt write record.json', () => {
    const writers = store.match(/fs\.renameSync\(tmp, recordPath\(rec\.id\)\)/g) || [];
    assert.equal(writers.length, 2);
    assert.equal((store.match(/recordPath\(id\)\)/g) || []).length, 0, 'no other function renames onto record.json');
    const sweep = fnBody(store, 'export function markAllExecutorsDetached', '\n}\n');
    assert.match(sweep, /writeRecordKeepUpdatedAt\(\{ \.\.\.rec, id \}\)/);
  });
});
