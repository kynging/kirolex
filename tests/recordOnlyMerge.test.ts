import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { mergeRecords } from '../src/main/transcriptMerge.ts';
import { recordSyncChanges, runBucketMerge, type BucketMergeIO } from '../src/main/s3Pull.ts';

/*
 * 第 12 轮（2026-11-27）：「在另一台电脑上重命名会话，本机不会跟着改名」。
 * 空合并原来只看「桶里有没有本机缺的消息 / 文件」，不看 record.json —— 别的电脑只改了名，本机记下「看过了」，那份改名永远并不进来。
 * 现在：记录在「会同步的字段」上有差别就只写回记录（不断开执行器、不碰 transcript）；标题按手动改名的时刻 titleChangedAt 谁新用谁。
 * 测试数据全是造的。
 */

const base = (over: any = {}) => ({ id: 's_1', updatedAt: 1000, title: 'frp', profile: { model: 'm' }, ...over });

describe('recordSyncChanges：合并后的记录和本机比，会同步的字段变了哪些', () => {
  test('① 只有标题不同（对方手动改了名）→ 报 title；合并结果用 titleChangedAt 新的那份', () => {
    const local = base({ titleChangedAt: 100 });
    const theirs = base({ title: 'frp 隧道', titleChangedAt: 500, updatedAt: 900 });
    const merged = mergeRecords(local, theirs);
    assert.equal(merged.title, 'frp 隧道');
    assert.equal(merged.titleChangedAt, 500);
    assert.ok(recordSyncChanges(local, merged).includes('title'));
  });

  test('② A 改名后 B 只是又聊了一句（updatedAt 更新、没改名）→ 合并保留 A 的名字', () => {
    const a = base({ title: 'A 改的名字', titleChangedAt: 5000, updatedAt: 5000 });
    const b = base({ title: 'frp', updatedAt: 9000 });   // B 从没手动改过名（没有 titleChangedAt）
    assert.equal(mergeRecords(a, b).title, 'A 改的名字', 'A 这台合并 B 的');
    assert.equal(mergeRecords(b, a).title, 'A 改的名字', 'B 这台合并 A 的');
    /* B 后来也手动改了名 → B 的赢 */
    assert.equal(mergeRecords(a, { ...b, title: 'B 改的', titleChangedAt: 8000 }).title, 'B 改的');
  });

  test('两边都没有 titleChangedAt → 照旧按 updatedAt', () => {
    assert.equal(mergeRecords(base(), base({ title: '新', updatedAt: 2000 })).title, '新');
    assert.equal(mergeRecords(base({ updatedAt: 3000 }), base({ title: '新', updatedAt: 2000 })).title, 'frp');
  });

  test('③ 只有 profile.remote / kiroAgent / localDir 不同 → 不算差别（仍是空合并）', () => {
    const local = base({ localDir: '/Users/me/p', profile: { model: 'm', remote: { id: 'a', sshHost: 'u@a' }, kiroAgent: 'x' } });
    const theirs = base({ updatedAt: 9000, localDir: 'C:\\Users\\o\\p', profile: { model: 'm', remote: { id: 'b', sshHost: 'u@b' }, kiroAgent: 'y' }, executorState: 'attached', cliSessionId: 'other' });
    assert.deepEqual(recordSyncChanges(local, mergeRecords(local, theirs)), []);
  });

  test('别的只在记录里的改动也算：项目 / 归档（placementChangedAt 新）、tags', () => {
    const local = base({ placementChangedAt: 1, profile: { model: 'm', projectId: 'A' } });
    const theirs = base({ placementChangedAt: 9, archived: true, tags: ['t'], profile: { model: 'm', projectId: 'B' } });
    const ch = recordSyncChanges(local, mergeRecords(local, theirs));
    for (const k of ['archived', 'profile.projectId', 'tags']) assert.ok(ch.includes(k), k);
  });
});

describe('runBucketMerge：只有记录变了 → 只写回记录，不 apply（不断开执行器、不改 transcript）', () => {
  const fake = (over: { changes?: string[]; busy?: boolean; newMsgs?: number } = {}) => {
    const log: string[] = [];
    const io: BucketMergeIO = {
      fetch: async () => ({ transcript: 'theirs', missingFiles: 0 }),
      countNew: () => over.newMsgs ?? 0,
      isBusy: () => !!over.busy,
      pullFiles: async () => 0,
      apply: () => { log.push('apply'); return over.newMsgs ?? 0; },
      recordChanges: () => over.changes ?? [],
      applyRecord: () => { log.push('applyRecord'); },
    };
    return { io, log };
  };
  test('记录有差别 → recordOnly，只调 applyRecord', async () => {
    const { io, log } = fake({ changes: ['title'] });
    assert.deepEqual(await runBucketMerge(io), { added: 0, pulledFiles: 0, recordOnly: ['title'] });
    assert.deepEqual(log, ['applyRecord']);
  });
  test('记录也一样 → noop，什么都不调', async () => {
    const { io, log } = fake({ changes: [] });
    assert.deepEqual(await runBucketMerge(io), { added: 0, pulledFiles: 0, noop: true });
    assert.deepEqual(log, []);
  });
  test('忙 → 推迟（不写记录）', async () => {
    const { io, log } = fake({ changes: ['title'], busy: true });
    assert.deepEqual(await runBucketMerge(io), { added: 0, pulledFiles: 0, deferred: true });
    assert.deepEqual(log, []);
  });
  test('有新消息 → 照旧走 apply（transcript 和记录一起合）', async () => {
    const { io, log } = fake({ changes: ['title'], newMsgs: 2 });
    assert.deepEqual(await runBucketMerge(io), { added: 2, pulledFiles: 0 });
    assert.deepEqual(log, ['apply']);
  });
});

describe('接线（index.ts，源码扫描）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  const H = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf-8');
  test('④ 只改记录时不断开执行器：applyRecord 里没有 detachExecutor / 改 transcript，executorState 保留本机的', () => {
    const fn = M.slice(M.indexOf('async function mergeBucketSession('), M.indexOf('async function keepLocalSession('));
    const at = fn.indexOf('applyRecord: () => {');
    assert.ok(at > 0);
    const body = fn.slice(at, fn.indexOf('\n    },', at));
    assert.ok(!body.includes('detachExecutor'), '不断开执行器');
    assert.ok(!body.includes('tAbs') && !body.includes('mergeTranscripts'), '不碰 transcript');
    assert.ok(body.includes('next.executorState = m.mine.executorState'));
    assert.ok(body.includes('store.writeRecordKeepUpdatedAt(next)'));
    assert.ok(fn.includes('recordChanges: () => { const m = mergedRecord(); return m ? recordSyncChanges(m.mine, m.merged) : []; }'));
  });
  test('同步循环：recordOnly 写日志「只改了记录（…），已合并」、推给界面、这一轮重传 record.json', () => {
    assert.ok(M.includes('if (r.recordOnly) { recordOnlyIds.push(c.id); notifyRecordMerged(c.id, r.recordOnly); continue; }'));
    const n = M.slice(M.indexOf('function notifyRecordMerged('));
    assert.ok(n.slice(0, 300).includes('只改了记录（${changes.join(\' / \')}），已合并'));
    assert.ok(M.includes("const rel = path.join('sessions', id, 'record.json');"));
    assert.ok(M.includes("mainWindow.webContents.send('session:title-changed', { sessionId, title: rec.title || 'New Chat' })"));
    assert.ok(H.includes('onSessionTitleChanged?.('), '渲染层改侧栏标题');
  });
  test('改名：手动改名记 titleChangedAt（acp:mark-title-changed）、自动起名不记；开着同步的改名后补一轮同步', () => {
    const h = M.slice(M.indexOf("ipcMain.handle('acp:mark-title-changed'"));
    const body = h.slice(0, h.indexOf('\n  });'));
    assert.ok(body.includes('store.patchRecord(id, { titleChangedAt: Date.now() } as any)'));
    assert.ok(body.includes("store.readRecord(id)?.crossDevice === true) requestCrossDeviceSync("));
    const manual = H.slice(H.indexOf('const renameSession = useCallback'), H.indexOf('const renameSession = useCallback') + 1600);
    assert.ok(manual.includes('markSessionTitleChanged?.(sessionId)'), '手动改名发');
    const auto = H.slice(H.indexOf('const maybeAutoTitle = ('));
    assert.ok(!auto.slice(0, auto.indexOf('\n  };')).includes('markSessionTitleChanged'), '自动起名不发');
  });
});

/* 审查意见：改名和新消息一起拉回（走完整合并）时，侧栏标题也要更新 —— 原来只发 history-changed 和 profile-sync（都不带标题） */
describe('改名和新消息一起拉回：完整合并也把标题推给侧栏（后台会话也更新）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  const H = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf-8');
  test('记录上：标题按最后一次改名并进来，recordSyncChanges 报 title', () => {
    const local = base({ updatedAt: 1000 });
    const theirs = base({ updatedAt: 9000, title: 'frp 隧道', titleChangedAt: 8000 });
    const merged = mergeRecords(local, theirs);
    assert.equal(merged.title, 'frp 隧道');
    assert.deepEqual(recordSyncChanges(local, merged).filter((k) => k === 'title'), ['title']);
  });
  test('接线：apply 里算出记录的改动，带出来；同步循环在完整合并后调 notifyRecordMerged → 发 session:title-changed', () => {
    const fn = M.slice(M.indexOf('async function mergeBucketSession('), M.indexOf('async function keepLocalSession('));
    const apply = fn.indexOf('apply: () => {');
    assert.ok(fn.indexOf('fullRecordChanges = recordSyncChanges(mine, merged);') > apply, 'apply 里算');
    assert.ok(fn.includes('return { ...r, recordChanges: fullRecordChanges }'));
    const loop = M.slice(M.indexOf("pushProfileSync([c.id], 's3-merge');"), M.indexOf("pushProfileSync([c.id], 's3-merge');") + 300);
    assert.ok(loop.includes('if (r.recordChanges?.length) notifyRecordMerged(c.id, r.recordChanges, { withMessages: true });'));
    const n = M.slice(M.indexOf('function notifyRecordMerged('), M.indexOf('function notifyRecordMerged(') + 1400);
    assert.ok(n.includes("if (changes.includes('title')) mainWindow.webContents.send('session:title-changed'"));
  });
  test('渲染层：按 id 改列表里的那条（不限当前打开的会话）', () => {
    const at = H.indexOf('onSessionTitleChanged?.(');
    const body = H.slice(at, at + 400);
    assert.ok(body.includes('prev.map((s) => (s.id === d.sessionId && s.title !== d.title ? { ...s, title: d.title } : s))'));
    assert.ok(!body.includes('currentSessionId'), '不只改当前会话');
  });
});
