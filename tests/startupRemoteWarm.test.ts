import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { remoteWarmCut, sessionsToWarm, RECENT_REMOTE_WARM } from '../src/renderer/projectActivity.ts';

/*
  「启动时不要一口气自动 attach 一大批远程会话」—— 2026-10-22 实测（tokyo-arm）：启动时一起起来 8 个
  kiro-cli acp，加上 2 个 claude-agent-acp 正好把那条 ssh 复用连接的 10 个 session（sshd MaxSessions
  默认值）用完，之后切换组合就报 `Session open refused by peer`。

  规则：远程会话启动时只连**看得见的**（落屏那条 + 分屏里的）和**最近用过的** RECENT_REMOTE_WARM 条；
  其余点开再连。本机会话照旧（不占 ssh session）。总数上限仍是 sessionsToWarm 的 cap - 1。
*/
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const s = (id: string, minsAgo: number, remoteHost?: string) => ({ id, timestamp: NOW - minsAgo * MIN, ...(remoteHost ? { remoteHost } : {}) });

describe('启动时远程会话只连看得见的和最近用过的', () => {
  const sessions = [
    s('local1', 5), s('local2', 50),
    s('r-old', 300, 'tokyo-arm'), s('r-new', 1, 'tokyo-arm'), s('r-mid', 20, 'tokyo-arm'),
    s('r-pane', 900, 'tokyo-arm'), s('r-land', 1000, 'tokyo-arm'), s('r-other', 10, 'osaka'),
  ];
  const all = sessions.map((x) => x.id);

  test('本机会话不动；远程的只留落屏 / 分屏 + 最近用过的两条', () => {
    const out = remoteWarmCut(all, sessions, { visible: ['r-land', 'r-pane'] });
    assert.deepEqual(out, ['local1', 'local2', 'r-new', 'r-pane', 'r-land', 'r-other']);
    assert.equal(RECENT_REMOTE_WARM, 2);
  });

  test('看得见的那几条不占「最近用过」的名额', () => {
    const out = remoteWarmCut(all, sessions, { visible: ['r-new'] });
    assert.deepEqual(out.filter((id) => id.startsWith('r-')), ['r-new', 'r-mid', 'r-other']);
  });

  test('没有远程会话时原样返回；顺序不变（落屏那条在最前时仍在最前）', () => {
    const locals = [s('a', 3), s('b', 1)];
    assert.deepEqual(remoteWarmCut(['b', 'a'], locals, { visible: [] }), ['b', 'a']);
    assert.deepEqual(remoteWarmCut(['r-land', 'local1', 'r-new'], sessions, { visible: ['r-land'] }), ['r-land', 'local1', 'r-new']);
  });

  test('只在候选里挑 —— 不会把 sessionsToWarm 没选的会话加回来（上限规则不变）', () => {
    const out = remoteWarmCut(['local1', 'r-old'], sessions, { visible: ['r-pane'] });
    assert.deepEqual(out, ['local1', 'r-old'], 'r-old 是候选里最近的远程会话；r-pane 不在候选里就不加');
  });

  test('和 sessionsToWarm 串起来：Unassigned 里一堆远程会话，启动只连 落屏 + 2 条', () => {
    const many = Array.from({ length: 10 }, (_, i) => s(`r${i}`, i + 1, 'tokyo-arm'));
    const warm = remoteWarmCut(sessionsToWarm(many, { now: NOW, limit: 19, keepId: 'r9' }), many, { visible: ['r9'] });
    assert.deepEqual(warm.sort(), ['r0', 'r1', 'r9']);
  });

  test('接线：启动那一轮用的是它，可见 = 落屏那条 + 分屏', () => {
    const U = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');
    const at = U.indexOf('const limit = Math.max(1, cap - 1);');
    assert.ok(at > 0);
    const chunk = U.slice(at, at + 3000);
    assert.match(chunk, /remoteWarmCut\(\s*sessionsToWarm\(sessionsRef\.current, \{ now: Date\.now\(\), limit, keepId: lastSid \}\)/);
    assert.match(chunk, /uiGet\('kirolex-split-session'\)/);
  });
});
