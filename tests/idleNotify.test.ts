/**
 * 钉住的会话「全部做完 / 出错停下」时的系统通知 —— 守的是「什么时候发、发几条、写什么」。
 *
 * 判定分两半：渲染端（`idleNotify.ts`）知道会话忙不忙、排队空没空、最后一轮怎么结束的；
 * 主进程（`idleNotice.ts`）知道窗口是不是用户正在看的那个。两半都是纯函数，这里分别钉住。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDLE_SETTLE_MS,
  idleNoticeBody,
  stepIdle,
  summarizeError,
  type IdleSnapshot,
  type IdleTrack,
  type TurnOutcome,
} from '../src/renderer/idleNotify.ts';
import { windowIsActive } from '../src/main/idleNotice.ts';

const OK: TurnOutcome = { kind: 'ok' };
const snap = (over: Partial<IdleSnapshot> = {}): IdleSnapshot => ({
  pinned: true,
  busy: false,
  awaitingPermission: false,
  outcome: OK,
  ...over,
});

/** 按时间顺序喂一串快照，收集所有发出的通知。 */
function run(steps: Array<[number, Partial<IdleSnapshot>]>) {
  let track: IdleTrack | undefined;
  const fired: Array<{ at: number; kind: string; summary?: string }> = [];
  for (const [at, over] of steps) {
    const d = stepIdle(track, snap(over), at);
    track = d.track;
    if (d.notify) fired.push({ at, ...d.notify });
  }
  return { fired, track };
}

describe('什么时候发', () => {
  test('一轮 + 两条排队全部跑完：中间不发，最后只发一条「已完成」', () => {
    const { fired } = run([
      [0, { busy: true }],                          // 第一轮在跑（队列里还有两条）
      [1000, { busy: true }],                       // 第一轮结束、队列非空 —— 仍然忙
      [2000, { busy: true }],                       // 第二轮
      [3000, { busy: true }],                       // 第三轮
      [4000, { busy: false }],                      // 队列空、最后一轮结束
      [4000 + IDLE_SETTLE_MS, { busy: false }],     // 稳定下来
      [4000 + IDLE_SETTLE_MS * 3, { busy: false }], // 再查一次：同一次闲置不重复
    ]);
    assert.deepEqual(fired.map((f) => f.kind), ['done']);
  });

  test('两轮之间闪过一瞬"看起来闲"（排队那条还没开始流式）不发', () => {
    const { fired } = run([
      [0, { busy: true }],
      [1000, { busy: false }],                      // 交接空档
      [1000 + IDLE_SETTLE_MS - 1, { busy: true }],  // 下一轮在稳定之前就开始了
      [5000, { busy: false }],
      [5000 + IDLE_SETTLE_MS, { busy: false }],
    ]);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].at, 5000 + IDLE_SETTLE_MS);
  });

  test('刚闲下来还没稳定时不发，并告诉调用方多久后再查', () => {
    const first = stepIdle(undefined, snap({ busy: true }), 0);
    const idle = stepIdle(first.track, snap(), 100);
    assert.equal(idle.notify, null);
    assert.equal(idle.recheckInMs, IDLE_SETTLE_MS);
    const half = stepIdle(idle.track, snap(), 100 + 500);
    assert.equal(half.notify, null);
    assert.equal(half.recheckInMs, IDLE_SETTLE_MS - 500);
  });

  test('没钉住的会话跑完：不发', () => {
    const { fired } = run([
      [0, { pinned: false, busy: true }],
      [1000, { pinned: false }],
      [1000 + IDLE_SETTLE_MS, { pinned: false }],
    ]);
    assert.equal(fired.length, 0);
  });

  test('从来没忙过（刚启动、一直闲着）：不发', () => {
    const { fired } = run([[0, {}], [IDLE_SETTLE_MS * 2, {}]]);
    assert.equal(fired.length, 0);
  });

  test('等用户点「允许」时不算闲置：不发；点完跑完才发', () => {
    const { fired } = run([
      [0, { busy: true }],
      [1000, { busy: false, awaitingPermission: true }],
      [1000 + IDLE_SETTLE_MS * 5, { busy: false, awaitingPermission: true }],
    ]);
    assert.equal(fired.length, 0);
    const after = run([
      [0, { busy: true }],
      [1000, { awaitingPermission: true }],
      [9000, { busy: true }],
      [10000, {}],
      [10000 + IDLE_SETTLE_MS, {}],
    ]);
    assert.deepEqual(after.fired.map((f) => f.kind), ['done']);
  });

  test('用户自己点停止：不发，而且不会留到下一次闲置才补发', () => {
    const { fired, track } = run([
      [0, { busy: true }],
      [1000, { outcome: { kind: 'cancelled' } }],
      [1000 + IDLE_SETTLE_MS, { outcome: { kind: 'cancelled' } }],
    ]);
    assert.equal(fired.length, 0);
    assert.equal(track?.armed, false);
    const later = stepIdle(track, snap(), 99999);
    assert.equal(later.notify, null);
  });

  test('最后一轮出错停下：发「出错」，带错误摘要', () => {
    const { fired } = run([
      [0, { busy: true }],
      [1000, { outcome: { kind: 'error', message: '⚠️ Internal error: model unavailable' } }],
      [1000 + IDLE_SETTLE_MS, { outcome: { kind: 'error', message: '⚠️ Internal error: model unavailable' } }],
    ]);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].kind, 'error');
    assert.equal(fired[0].summary, 'Internal error: model unavailable');
  });

  test('发过一次之后再忙再闲：是新的一次闲置，再发一条', () => {
    const { fired } = run([
      [0, { busy: true }],
      [1000, {}],
      [1000 + IDLE_SETTLE_MS, {}],
      [9000, { busy: true }],
      [10000, {}],
      [10000 + IDLE_SETTLE_MS, {}],
    ]);
    assert.equal(fired.length, 2);
  });
});

describe('写什么', () => {
  test('正常做完 →「已完成」；出错 →「出错了」+ 摘要', () => {
    assert.equal(idleNoticeBody('zh', { kind: 'done' }), '已完成');
    assert.equal(idleNoticeBody('zh', { kind: 'error', summary: '' }), '出错了');
    assert.equal(idleNoticeBody('zh', { kind: 'error', summary: '连接断开' }), '出错了：连接断开');
    assert.equal(idleNoticeBody('en', { kind: 'done' }), 'Finished');
    assert.equal(idleNoticeBody('en', { kind: 'error', summary: 'boom' }), 'Stopped with an error: boom');
  });

  test('错误摘要：去掉开头的 ⚠️、压成一行、过长截断', () => {
    assert.equal(summarizeError('⚠️  first line\n\nsecond   line'), 'first line second line');
    const long = summarizeError('x'.repeat(500));
    assert.ok(long.length <= 120);
    assert.ok(long.endsWith('…'));
    assert.equal(summarizeError(undefined), '');
  });
});

describe('窗口是不是用户正在看的', () => {
  test('有焦点、可见、没最小化 → 正在看（不发）', () => {
    assert.equal(windowIsActive({ exists: true, focused: true, visible: true, minimized: false }), true);
  });
  test('没焦点 / 最小化 / 藏进托盘 / 窗口没了 → 不在看（发）', () => {
    assert.equal(windowIsActive({ exists: true, focused: false, visible: true, minimized: false }), false);
    assert.equal(windowIsActive({ exists: true, focused: true, visible: true, minimized: true }), false);
    assert.equal(windowIsActive({ exists: true, focused: true, visible: false, minimized: false }), false);
    assert.equal(windowIsActive({ exists: false, focused: false, visible: false, minimized: false }), false);
  });
});
