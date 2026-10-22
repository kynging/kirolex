/**
 * 两个已确认的 bug（任务 d427409b）：
 *   1. 没建成的新会话右键换机器 / 目录 / 引擎时，`coldRecordFor` 建的最小记录丢了新建时选的引擎和机器，
 *      一条「远程 Codex」悄悄变成本机 kiro（s_1792637464721_r0sfi7）。
 *   2. `acp:load-session`（attach）失败时主进程日志一行都没有。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attachFailureLine, coldProfileBits } from '../src/main/coldRecord.ts';

const tokyo = { sshHost: 'ec2-user@tokyo' };
const resolve = (id: string) => (id === 'tokyo' ? tokyo : undefined);

describe('coldProfileBits：冷记录按新建时选的引擎 / 机器建', () => {
  test('主进程记下的新建意图优先：远程 Codex 不会变成本机 kiro', () => {
    const b = coldProfileBits({ engine: 'codex', remote: tokyo, remoteId: 'tokyo', projectId: 'p1' }, { projectId: 'p1' }, resolve);
    assert.equal(b.engine, 'codex');
    assert.deepEqual(b.remote, tokyo);
    assert.equal(b.projectId, 'p1');
    assert.equal(b.source, 'intent');
    assert.equal(b.lost, false);
  });

  test('意图里只有 remoteId（新建时配置里没查到）：按 id 再查一次，查不到要明说', () => {
    const ok = coldProfileBits({ engine: 'claude', remoteId: 'tokyo' }, undefined, resolve);
    assert.deepEqual(ok.remote, tokyo);
    assert.equal(ok.lost, false);
    const gone = coldProfileBits({ engine: 'claude', remoteId: 'gone' }, undefined, resolve);
    assert.equal(gone.remote, undefined);
    assert.equal(gone.remoteMissing, 'gone');
    assert.equal(gone.lost, true);
    assert.equal(gone.engine, 'claude', '引擎照样保住');
  });

  test('没有意图时用渲染层 hint 带来的 engine / remoteId', () => {
    const b = coldProfileBits(undefined, { projectId: null, engine: 'codex', remoteId: 'tokyo' }, resolve);
    assert.equal(b.engine, 'codex');
    assert.deepEqual(b.remote, tokyo);
    assert.equal(b.source, 'hint');
    assert.equal(b.lost, false);
    const local = coldProfileBits(undefined, { engine: 'claude', remoteId: null }, resolve);
    assert.equal(local.engine, 'claude');
    assert.equal(local.remote, undefined);
    assert.equal(local.lost, false, 'remoteId: null = 渲染层明确知道是本地');
  });

  test('hint 只知道一半：缺的那一半按默认补，但 lost=true（要说一句）', () => {
    const b = coldProfileBits(undefined, { engine: 'codex' }, resolve);
    assert.equal(b.engine, 'codex');
    assert.equal(b.lost, true);
  });

  test('什么都不知道（老渲染层只带 projectId）：按本机 kiro 建，但不许静默 —— lost=true', () => {
    const b = coldProfileBits(undefined, { projectId: 'p1' }, resolve);
    assert.equal(b.engine, 'kiro');
    assert.equal(b.remote, undefined);
    assert.equal(b.projectId, 'p1');
    assert.equal(b.source, 'none');
    assert.equal(b.lost, true);
  });
});

describe('attachFailureLine：attach 失败那一行日志', () => {
  test('带 sessionId、engine、remote 和原因', () => {
    const line = attachFailureLine('s_1', { engine: 'claude' }, new Error('Claude Code 适配器没装\n去设置里装'));
    assert.match(line, /sessionId=s_1/);
    assert.match(line, /engine=claude/);
    assert.match(line, /remote=local/);
    assert.match(line, /Claude Code 适配器没装 去设置里装/, '原因压成一行');
    assert.match(attachFailureLine('s_2', { engine: 'codex', remote: { sshHost: 'u@h' } }, 'boom'), /engine=codex remote=u@h: boom/);
    assert.match(attachFailureLine('s_3', undefined, undefined), /engine=kiro remote=local: \(无原因\)/);
  });
});

describe('接线（源码扫描）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const S = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'Sidebar.tsx'), 'utf8');

  test('acp:new-session 一进来就记下引擎 / 机器，建成才清', () => {
    const h = M.slice(M.indexOf("ipcMain.handle('acp:new-session'"), M.indexOf("ipcMain.handle('acp:prompt'"));
    const set = h.indexOf('newSessionIntents.set(kiroLexId, { engine');
    assert.ok(set > 0, '要在 new-session 里记意图');
    assert.ok(set < h.indexOf('connectWithModelFallback('), '必须在起执行器（可能失败）之前记');
    assert.ok(h.indexOf('newSessionIntents.delete(kiroLexId)') > h.indexOf('store.createSession(kiroLexId'), '记录落盘之后才清');
  });

  test('coldRecordFor 用 coldProfileBits 补引擎 / 机器，补不全时在会话里说一句', () => {
    const c = M.slice(M.indexOf('const coldRecordFor = '), M.indexOf('const applySessionTarget = '));
    assert.match(c, /coldProfileBits\(newSessionIntents\.get\(sessionId\), hint/);
    assert.match(c, /engine !== 'kiro' \? \{ engine \}/);
    assert.match(c, /bits\.remote \? \{ remote:/);
    assert.match(c, /bits\.lost[\s\S]*sessionNotice\(/);
  });

  test('侧栏右键换机器 / 换引擎都把引擎和机器放进 hint', () => {
    assert.match(S, /api\.switchEngine\(sessionId, engine, coldHintFor\(sessionId\)\)/);
    assert.match(S, /api\.setRemoteTarget\(sessionId, remoteId, undefined, coldHintFor\(sessionId\)\)/);
    const h = S.slice(S.indexOf('const coldHintFor = '), S.indexOf('const onSetEngine = '));
    assert.match(h, /engine: s\?\.engine \|\| 'kiro'/);
    assert.match(h, /remoteId: rid/);
  });

  test('attach 失败写 logger.warn(\'attach\', …)，且在 attachPromise 里只记一次', () => {
    const a = M.slice(M.indexOf('const loadSessionImpl = '), M.indexOf("ipcMain.handle('acp:load-session'"));
    const i = a.indexOf("logger.warn('attach', attachFailureLine(sessionId");
    assert.ok(i > 0, 'attach 失败要进日志');
    assert.ok(i < a.indexOf('attachInFlight.set(sessionId, attachPromise)'), '记在那一份 attach 里，跟进来的 await 不重复记');
    assert.match(a.slice(i, i + 200), /throw err;/, '记完照样抛给调用方');
  });
});
