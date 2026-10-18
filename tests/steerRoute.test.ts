import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  steerPayload,
  busyEnterRoute,
  steerFailureRoute,
  steerFailureReasonKey,
  isRebuildingHistory,
  withAfterRebuild,
} from '../src/renderer/steerRoute.ts';

/**
 * 忙时普通 Enter = **永远 steer 当前这一轮** —— 不再悄悄变成排队。
 *
 * 实测：会话在跑一个 120 秒的 `local_bash`，前面三次 steer 都成功了，第四次 Enter 却进了队列
 * （`kirolex-queues` 里那张卡的内容还是 `[ 粘贴 #1 · 81 行 ]` 占位符）。这里守的是路由判据本身。
 */

describe('带附件的 steer：附件和普通消息一样按本机路径交给模型', () => {
  test('没有附件 → 原文', () => {
    assert.equal(steerPayload('再看一下日志', []), '再看一下日志');
  });

  test('有附件 → 和普通消息同一个 file: 引用块，后面跟文字', () => {
    const out = steerPayload('看这两个', [
      { path: 'C:/u/a.png', isImage: true },
      { path: '/tmp/b.txt' },
    ]);
    assert.equal(out, '<hidden>file:C:/u/a.png\nfile:/tmp/b.txt\n请读取这些文件内容</hidden>\n\n看这两个');
  });

  test('只有附件没有文字 → 只有引用块（不带空段落）', () => {
    assert.equal(steerPayload('  ', [{ path: '/x.pdf' }]), '<hidden>file:/x.pdf\n请读取这些文件内容</hidden>');
  });
});

describe('steer 失败怎么办：不再静默转排队', () => {
  test('这一轮已经结束（idle）→ 直接作为新消息发出', () => {
    assert.equal(steerFailureRoute('idle'), 'send-now');
  });

  test('正在重建历史（main 才知道的竞态）→ 等重建结束后发', () => {
    assert.equal(steerFailureRoute('priming'), 'after-rebuild');
  });

  test('其余原因一律交给用户选：标红 + 两个按钮', () => {
    for (const r of ['unsupported', 'write-failed', 'not-connected', 'reconfiguring', 'ipc-error', undefined, 'whatever']) {
      assert.equal(steerFailureRoute(r), 'ask', String(r));
    }
  });

  test('每个原因都有人话（未知原因也有兜底）', () => {
    const keys = ['unsupported', 'write-failed', 'not-connected', 'reconfiguring', 'ipc-error', undefined, 'zzz'].map(steerFailureReasonKey);
    for (const k of keys) assert.ok(k && !/^[a-z-]+$/.test(k), `不是裸 reason：${k}`);
    assert.notEqual(steerFailureReasonKey('unsupported'), steerFailureReasonKey('write-failed'));
  });
});

describe('忙时普通 Enter 先走哪条路', () => {
  test('正在跑一轮 → steer（不管队列里有没有东西、带不带附件 / 粘贴 —— 这些都不在判据里）', () => {
    assert.equal(busyEnterRoute({ busy: 'turn' }), 'steer');
    assert.equal(busyEnterRoute({ busy: undefined }), 'steer');
    assert.equal(busyEnterRoute.length, 1);
  });
  test('重建历史中 → 重建结束后发', () => {
    assert.equal(busyEnterRoute({ busy: 'priming' }), 'after-rebuild');
    assert.equal(busyEnterRoute({ busy: 'prime-pending' }), 'after-rebuild');
  });
});

describe('重建历史期间', () => {
  test('priming / prime-pending 算重建，turn 不算', () => {
    assert.equal(isRebuildingHistory('priming'), true);
    assert.equal(isRebuildingHistory('prime-pending'), true);
    assert.equal(isRebuildingHistory('turn'), false);
    assert.equal(isRebuildingHistory(undefined), false);
  });

  test('重建结束后它是**下一条**：排在已有的「重建后发送」之后、普通排队之前', () => {
    const q = [
      { id: 'r1', afterRebuild: true },
      { id: 'q1' },
      { id: 'q2' },
    ];
    const out = withAfterRebuild(q, { id: 'r2', afterRebuild: true });
    assert.deepEqual(out.map((i) => i.id), ['r1', 'r2', 'q1', 'q2']);
    assert.deepEqual(q.map((i) => i.id), ['r1', 'q1', 'q2'], '不改原数组');
  });

  test('空队列 → 就它一条', () => {
    assert.deepEqual(withAfterRebuild([], { id: 'r', afterRebuild: true }).map((i) => i.id), ['r']);
  });
});
