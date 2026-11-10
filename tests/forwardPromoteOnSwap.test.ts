import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { takeReadyAwaiting, forwardReconnectVerdict, retryUntilIdle } from '../src/main/forwardReconnect.ts';

/*
 * 「远程 Claude Code 会话：回复完又白重连一次显得『没起来』」（s_1792550354705_bq53af，2026-11-10）
 *
 * 06:38:20 换远端那次准备：context7（HTTP 转发）还没探过 → 不交、进 awaitingForward；06:38:22 探测通过 → 等空闲重连；
 * 06:38:47 新执行器 session/new —— 交的还是 06:38:20 那份 mcpServers，于是回复完（空闲）又断开重连一次挂 context7。
 * 现在交出去之前（session/new / load / fork）再对一遍：这一刻已就绪的直接交、从 awaitingForward 去掉，空闲后不再重连。
 */

describe('takeReadyAwaiting：交给执行器之前，已就绪的从等着的名单里拿出来', () => {
  test('就绪的拿走、没就绪的留下，顺序不变', () => {
    const r = takeReadyAwaiting(['context7', 'builder-mcp', 'web'], (n) => n !== 'builder-mcp');
    assert.deepEqual(r.promoted, ['context7', 'web']);
    assert.deepEqual(r.rest, ['builder-mcp']);
  });
  test('空 / 没有名单', () => {
    assert.deepEqual(takeReadyAwaiting(undefined, () => true), { promoted: [], rest: [] });
    assert.deepEqual(takeReadyAwaiting([], () => true), { promoted: [], rest: [] });
  });
  test('换执行器时已挂上的：空闲后的那次检查是 cancel，不再重连', () => {
    const spec = { awaitingForward: ['context7'] };
    const base = { specCurrent: true, deleted: false, quitting: false, attached: true, busy: false, reconfiguring: false };
    /* 06:38:22 探测通过时正在换执行器：等 */
    assert.equal(forwardReconnectVerdict({ ...base, reconfiguring: true, awaiting: spec.awaitingForward.includes('context7') }), 'wait');
    /* 新执行器 session/new 前对了一遍：context7 已就绪 → 交出去、移出名单 */
    spec.awaitingForward = takeReadyAwaiting(spec.awaitingForward, () => true).rest;
    let ran = 0;
    const timers: Array<() => void> = [];
    retryUntilIdle(
      () => forwardReconnectVerdict({ ...base, awaiting: spec.awaitingForward.includes('context7') }),
      () => { ran += 1; },
      { setTimer: (fn) => timers.push(fn) },
    );
    assert.equal(ran, 0, '空闲了也不重连');
    assert.equal(timers.length, 0, '也不再排下一次检查');
  });
});

describe('接线：执行器交 mcpServers 之前先让 spec 把已就绪的转发补上', () => {
  const root = path.join(import.meta.dirname, '..', 'src', 'main');
  const C = fs.readFileSync(path.join(root, 'acp-client.ts'), 'utf8');
  const M = fs.readFileSync(path.join(root, 'index.ts'), 'utf8');

  test('session/new / load / fork 都先 await refreshHanded', () => {
    for (const fn of ['async newSession(', 'async loadSession(', 'async forkSession(']) {
      const body = C.slice(C.indexOf(fn), C.indexOf('\n  }\n', C.indexOf(fn)));
      const refresh = body.indexOf('await this.refreshHanded();');
      assert.ok(refresh > 0 && refresh < body.indexOf('this.sendRequest('), fn);
      assert.match(body, /mcpServers: this\.mcpServers,/, fn);
    }
    const h = C.slice(C.indexOf('private async refreshHanded('), C.indexOf('private async refreshHanded(') + 600);
    assert.match(h, /await this\.localTools\?\.refreshHanded\?\.\(\)/);
  });

  test('Claude Code / Codex 分支的 spec 带 refreshHanded；补上的进 mcpServers、清掉当前不可用', () => {
    const at = M.indexOf('async function ensureLocalTools(');
    const body = M.slice(at, M.indexOf('const forwardable = profile.kiroAgent', at));
    assert.match(body, /spec\.refreshHanded = \(\) => promoteReadyForwards\(/);
    const fn = M.slice(M.indexOf('async function promoteReadyForwards('), M.indexOf('async function promoteReadyForwards(') + 3000);
    assert.match(fn, /takeReadyAwaiting\(spec\.awaitingForward,/);
    assert.match(fn, /spec\.awaitingForward = rest/);
    assert.match(fn, /spec\.mcpServers = \[\.\.\.\(spec\.mcpServers \|\| \[\]\), \.\.\.added\]/);
    assert.match(fn, /clearForwardUnavailable\(spec, name\)/);
    assert.match(fn, /httpHandedNow\(httpForwardOkAt\.get\(httpForwardKey\(/);
    assert.match(fn, /localToolsBySession\.get\(sessionId\) !== spec/);
  });
});
