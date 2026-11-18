import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  enqueuePermission,
  currentPermissions,
  settlePermission,
  allowAllPermissions,
  permissionToolKey,
  withoutPermissionCard,
} from '../src/renderer/permissionCards.ts';

/*
  同一会话同时来两个工具权限请求（实测 kiro 一次并行两个 web_search）：渲染层原来按会话只存一个槽位，
  第二个把第一个盖掉，被盖掉的那个在主进程里一直挂着，会话卡死。现在每个会话一个队列。
*/
const KIRO_OPTS = [
  { optionId: 'allow_once', kind: 'allow_once' },
  { optionId: 'allow_always', kind: 'allow_always' },
  { optionId: 'reject_once', kind: 'reject_once' },
];
const req = (requestId: string, toolKey: string, sessionId = 's1', options = KIRO_OPTS) =>
  ({ requestId, sessionId, toolTitle: toolKey, toolKey, options });

describe('每个会话的待批准权限请求队列', () => {
  test('同一会话连续两个请求：两个都在，第一个是当前显示项，标出还有 1 个', () => {
    let q = enqueuePermission({}, req('a', 'Searching the web'));
    q = enqueuePermission(q, req('b', 'Searching the web'));
    assert.deepEqual(q.s1.map((r) => r.requestId), ['a', 'b']);
    const cur = currentPermissions(q);
    assert.equal(cur.s1.requestId, 'a');
    assert.equal(cur.s1.queuedBehind, 1);
  });

  test('同一个 requestId 再来一次：原地替换，不重复', () => {
    let q = enqueuePermission({}, req('a', 'x'));
    q = enqueuePermission(q, { ...req('a', 'x'), toolTitle: 'new' });
    assert.equal(q.s1.length, 1);
    assert.equal(q.s1[0].toolTitle, 'new');
  });

  test('答复第一个（允许一次）后第二个仍在，并成为当前显示项', () => {
    let q = enqueuePermission({}, req('a', 'Searching the web'));
    q = enqueuePermission(q, req('b', 'Searching the web'));
    const { queues, alsoAnswer } = settlePermission(q, 's1', 'a', 'allow_once');
    assert.deepEqual(alsoAnswer, []);
    assert.deepEqual(queues.s1.map((r) => r.requestId), ['b']);
    assert.equal(currentPermissions(queues).s1.requestId, 'b');
    assert.equal(currentPermissions(queues).s1.queuedBehind, 0);
  });

  test('最后一个答完：这条会话的队列整个去掉', () => {
    const q = enqueuePermission({}, req('a', 'x'));
    const { queues } = settlePermission(q, 's1', 'a', 'allow_once');
    assert.equal('s1' in queues, false);
    assert.deepEqual(currentPermissions(queues), {});
  });

  test('allow_always：同一会话里同一工具的其它请求按同一选项一并答复，别的工具、别的会话不动', () => {
    let q = enqueuePermission({}, req('a', 'Searching the web'));
    q = enqueuePermission(q, req('b', 'Searching the web'));
    q = enqueuePermission(q, req('c', 'Running shell'));
    q = enqueuePermission(q, req('d', 'Searching the web', 's2'));
    const { queues, alsoAnswer } = settlePermission(q, 's1', 'a', 'allow_always');
    assert.deepEqual(alsoAnswer, [{ requestId: 'b', optionId: 'allow_always' }]);
    assert.deepEqual(queues.s1.map((r) => r.requestId), ['c']);
    assert.deepEqual(queues.s2.map((r) => r.requestId), ['d']);
  });

  test('reject_always 同理；对方的 optionId 不同时按 kind 找', () => {
    const optsA = [{ optionId: 'ra1', kind: 'reject_always' }, { optionId: 'ok1', kind: 'allow_once' }];
    const optsB = [{ optionId: 'ra2', kind: 'reject_always' }, { optionId: 'ok2', kind: 'allow_once' }];
    let q = enqueuePermission({}, req('a', 'Bash', 's1', optsA));
    q = enqueuePermission(q, req('b', 'Bash', 's1', optsB));
    const { queues, alsoAnswer } = settlePermission(q, 's1', 'a', 'ra1');
    assert.deepEqual(alsoAnswer, [{ requestId: 'b', optionId: 'ra2' }]);
    assert.equal('s1' in queues, false);
  });

  test('「始终」但对方没有同一种选项：留着让人答', () => {
    let q = enqueuePermission({}, req('a', 'Bash'));
    q = enqueuePermission(q, req('b', 'Bash', 's1', [{ optionId: 'allow_once', kind: 'allow_once' }]));
    const { queues, alsoAnswer } = settlePermission(q, 's1', 'a', 'allow_always');
    assert.deepEqual(alsoAnswer, []);
    assert.deepEqual(queues.s1.map((r) => r.requestId), ['b']);
  });

  test('切到「自动」：该会话所有待批准请求都按允许答复（优先允许一次），别的会话不动', () => {
    let q = enqueuePermission({}, req('a', 'Searching the web'));
    q = enqueuePermission(q, req('b', 'Running shell', 's1', [{ optionId: 'yes', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }]));
    q = enqueuePermission(q, req('d', 'x', 's2'));
    const { queues, answers } = allowAllPermissions(q, 's1');
    assert.deepEqual(answers, [{ requestId: 'a', optionId: 'allow_once' }, { requestId: 'b', optionId: 'yes' }]);
    assert.equal('s1' in queues, false);
    assert.deepEqual(queues.s2.map((r) => r.requestId), ['d']);
  });

  test('切到「自动」：没有任何允许选项的请求不替人拒，留着', () => {
    const q = enqueuePermission({}, req('a', 'x', 's1', [{ optionId: 'no', kind: 'reject_once' }]));
    const { queues, answers } = allowAllPermissions(q, 's1');
    assert.deepEqual(answers, []);
    assert.equal(queues, q);
  });

  test('停止 / 取消：整个队列清空，界面上的提示一起消失', () => {
    let q = enqueuePermission({}, req('a', 'x'));
    q = enqueuePermission(q, req('b', 'x'));
    const cleared = withoutPermissionCard(q, 's1');
    assert.equal('s1' in cleared, false);
    assert.deepEqual(currentPermissions(cleared), {});
  });

  test('工具键：有工具名用工具名，否则用标题', () => {
    assert.equal(permissionToolKey({ tool: { name: 'web_search' } }, 'Searching the web'), 'name:web_search');
    assert.equal(permissionToolKey({ toolName: 'fs_read' }, 'Reading'), 'name:fs_read');
    assert.equal(permissionToolKey({}, 'Searching the web'), 'title:Searching the web');
  });
});

describe('接线（useAcp / PermissionBar）', () => {
  const ACP = fs.readFileSync(new URL('../src/renderer/hooks/useAcp.ts', import.meta.url), 'utf8');
  const BAR = fs.readFileSync(new URL('../src/renderer/components/PermissionBar.tsx', import.meta.url), 'utf8');
  const slice = (src: string, from: string, n: number) => {
    const at = src.indexOf(from);
    assert.ok(at >= 0, `找不到 ${from}`);
    return src.slice(at, at + n);
  };

  test('permission_request 进队列，不再按会话覆盖', () => {
    const body = slice(ACP, "case 'permission_request': {", 2000);
    assert.match(body, /enqueuePermission\(current, \{/);
    assert.doesNotMatch(body, /\[requestSessionId\]: \{/);
  });

  test('答复后按 settlePermission 收掉，并把「始终」连带的请求也答了', () => {
    const body = slice(ACP, 'const respondPermission = useCallback(', 1200);
    assert.match(body, /settlePermission\(/);
    assert.match(body, /for \(const also of alsoAnswer\)/);
  });

  test('切到自动：allowAllPermissions 答复全部', () => {
    const body = slice(ACP, 'const changeSessionPermissionMode = useCallback(', 1800);
    assert.match(body, /permissionMode === 'auto-approve'/);
    assert.match(body, /allowAllPermissions\(/);
  });

  test('权限条显示「还有 N 个待批准」', () => {
    assert.match(BAR, /request\.queuedBehind/);
    assert.match(BAR, /\{n\} more waiting for approval/);
  });
});
