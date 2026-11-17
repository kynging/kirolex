/**
 * 恢复卡「回滚到某条消息」的执行步骤（`sessionRollback.performRollback`）：
 * 备份进回收站、截短、作废手改的上下文快照、换后端会话；换后端失败就整个撤回。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performRollback, BACKUP_FILES } from '../src/main/sessionRollback.ts';

type M = { id: string; role: string; content: string };
const MSGS: M[] = [
  { id: 'u1', role: 'user', content: 'first' },
  { id: 'a1', role: 'assistant', content: 'reply one' },
  { id: 'u2', role: 'user', content: 'SECRET LATER TURN' },
  { id: 'a2', role: 'assistant', content: 'reply two' },
];

/** 一份假的会话目录：transcript.jsonl 用每行一条 JSON（和 sessionStore 一样），可选手改快照。 */
function fixture(opts: { override?: string; swap?: () => Promise<unknown>; rewrite?: (kept: M[]) => void } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-rollback-'));
  const sessionDir = path.join(root, 'sessions', 's1');
  const backupDir = path.join(root, 'trash', 'rollback-20261117-000000-000', 's1');
  fs.mkdirSync(sessionDir, { recursive: true });
  const tPath = path.join(sessionDir, 'transcript.jsonl');
  const oPath = path.join(sessionDir, 'context-override.md');
  const original = MSGS.map((m) => JSON.stringify(m)).join('\n') + '\n';
  fs.writeFileSync(tPath, original);
  fs.writeFileSync(path.join(sessionDir, 'record.json'), '{"id":"s1"}');
  fs.writeFileSync(path.join(sessionDir, 'history.md'), '# whole history incl. SECRET LATER TURN');
  if (opts.override !== undefined) fs.writeFileSync(oPath, opts.override);
  const read = (): M[] => fs.readFileSync(tPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let swaps = 0;
  const deps = {
    sessionDir,
    backupDir,
    readTranscript: read,
    rewriteTranscript: opts.rewrite || ((kept: M[]) => fs.writeFileSync(tPath, kept.map((m) => JSON.stringify(m)).join('\n') + '\n')),
    /* 和 store.clearContextOverride 一样：删掉文件 */
    clearContextOverride: () => { try { fs.unlinkSync(oPath); } catch { /* 没有就算了 */ } },
    swapBackend: async () => { swaps++; return opts.swap ? opts.swap() : { oldId: 'a', newId: 'b' }; },
  };
  return { root, sessionDir, backupDir, tPath, oPath, original, read, deps, swaps: () => swaps };
}

describe('performRollback', () => {
  test('正常：保留到选中那条（含），之后的去掉；整份先备份；换了后端', async () => {
    const f = fixture();
    const r = await performRollback('a1', f.deps);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.removed, 2);
    assert.deepEqual(f.read().map((m) => m.id), ['u1', 'a1']);
    assert.equal(f.swaps(), 1);
    /* 备份是回滚前的原样 */
    assert.equal(fs.readFileSync(path.join(f.backupDir, 'transcript.jsonl'), 'utf-8'), f.original);
    assert.ok(fs.existsSync(path.join(f.backupDir, 'record.json')));
    assert.ok(fs.existsSync(path.join(f.backupDir, 'history.md')));
    assert.equal(r.overrideCleared, false);
  });

  test('手改保存过上下文快照：先备份、再作废 —— 新后端不会再从旧快照拿到回滚点之后的内容', async () => {
    const f = fixture({ override: 'curated context … SECRET LATER TURN …' });
    const r = await performRollback('a1', f.deps);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.overrideCleared, true);
    assert.equal(fs.existsSync(f.oPath), false, '旧快照不再生效');
    assert.equal(fs.readFileSync(path.join(f.backupDir, 'context-override.md'), 'utf-8'), 'curated context … SECRET LATER TURN …', '可以从备份找回');
    /* 剩下能进上下文的 transcript 里没有回滚点之后的内容 */
    assert.ok(!fs.readFileSync(f.tPath, 'utf-8').includes('SECRET LATER TURN'));
  });

  test('作废快照发生在换后端之前（换后端时 / 之后的第一条消息不会读到旧快照）', async () => {
    let overrideAtSwap: boolean | null = null;
    const f = fixture({ override: 'old snapshot', swap: async () => { overrideAtSwap = fs.existsSync(path.join(f.sessionDir, 'context-override.md')); } });
    const r = await performRollback('u1', f.deps);
    assert.equal(r.ok, true);
    assert.equal(overrideAtSwap, false);
  });

  test('换后端失败：整个撤回 —— transcript / history / 快照原样放回，报失败', async () => {
    const f = fixture({ override: 'curated snapshot', swap: async () => { throw new Error('This session is busy'); } });
    const historyBefore = fs.readFileSync(path.join(f.sessionDir, 'history.md'), 'utf-8');
    const r = await performRollback('u1', f.deps);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.stage, 'swap');
    assert.equal(r.restored, true);
    assert.match(r.error, /busy/);
    assert.equal(fs.readFileSync(f.tPath, 'utf-8'), f.original, 'transcript 回到原样');
    assert.equal(fs.readFileSync(f.oPath, 'utf-8'), 'curated snapshot', '快照放回去');
    assert.equal(fs.readFileSync(path.join(f.sessionDir, 'history.md'), 'utf-8'), historyBefore);
    /* 备份仍在回收站 */
    assert.ok(fs.existsSync(path.join(f.backupDir, 'transcript.jsonl')));
  });

  test('换后端失败、原来没有快照：撤回后也没有凭空多出快照', async () => {
    const f = fixture({ swap: async () => { throw new Error('Session not connected'); } });
    const r = await performRollback('a1', f.deps);
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(f.oPath), false);
    assert.equal(fs.readFileSync(f.tPath, 'utf-8'), f.original);
  });

  test('快照清理函数没抛错、但快照还在（删不掉）：不换后端，整个撤回', async () => {
    const f = fixture({ override: 'curated … SECRET LATER TURN …' });
    /* 和 store.clearContextOverride 删不掉时一样：吞掉错误、什么都不抛 */
    f.deps.clearContextOverride = () => { /* unlink 失败被吞掉 */ };
    const r = await performRollback('a1', f.deps);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.stage, 'truncate');
    assert.equal(r.restored, true);
    assert.equal(f.swaps(), 0, '没换后端');
    assert.equal(fs.readFileSync(f.tPath, 'utf-8'), f.original, 'transcript 回到原样');
    assert.equal(fs.readFileSync(f.oPath, 'utf-8'), 'curated … SECRET LATER TURN …');
  });

  test('截短本身失败：撤回，不换后端', async () => {
    const f = fixture({ rewrite: () => { fs.writeFileSync(f.tPath, 'torn'); throw new Error('disk full'); } });
    const r = await performRollback('a1', f.deps);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.stage, 'truncate');
    assert.equal(f.swaps(), 0);
    assert.equal(fs.readFileSync(f.tPath, 'utf-8'), f.original);
  });

  test('备份不成：什么都不动、不换后端', async () => {
    const f = fixture();
    /* 备份目录的位置被一个文件占了 → mkdir 失败 */
    fs.mkdirSync(path.dirname(f.backupDir), { recursive: true });
    fs.writeFileSync(f.backupDir, 'not a dir');
    const r = await performRollback('a1', f.deps);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.stage, 'backup');
    assert.equal(f.swaps(), 0);
    assert.equal(fs.readFileSync(f.tPath, 'utf-8'), f.original);
  });

  test('找不到那条消息：什么都不动', async () => {
    const f = fixture();
    const r = await performRollback('nope', f.deps);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.stage, 'not-found');
    assert.equal(fs.existsSync(f.backupDir), false);
    assert.equal(f.swaps(), 0);
  });

  test('备份清单含会进上下文的文件', () => {
    for (const f of ['transcript.jsonl', 'history.md', 'context-override.md', 'record.json']) assert.ok((BACKUP_FILES as readonly string[]).includes(f), f);
  });
});
