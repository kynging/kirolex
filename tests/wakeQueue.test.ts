import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_BUSY, WakeDispatcher, WakeSkipped, isWakeBusyError, type WakeItem } from '../src/main/wakeQueue.ts';

/**
 * 后台唤醒的投递（定时到点 / 后台命令退出 / 监视事件）。
 *
 * 守的是任务里「不打断正在跑的一轮」那条：会话忙就等这一轮结束再发，作为**新的一条**发
 * （不 steer、不进用户的排队卡片、不和别的合并），多个同时到期的按时间顺序逐条发。
 */

async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) assert.fail(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function harness() {
  const busy = new Set<string>();
  const sent: WakeItem[] = [];
  let polls = 0;
  let failNext: Error | null = null;
  const d = new WakeDispatcher({
    isBusy: (sid) => { polls += 1; return busy.has(sid); },
    deliver: async (item) => {
      if (failNext) { const e = failNext; failNext = null; throw e; }
      busy.add(item.sessionId);              // 发出去就是一轮
      sent.push(item);
      await new Promise((r) => setTimeout(r, 10));
      busy.delete(item.sessionId);
    },
    isBusyError: (err) => /active turn/.test(String((err as any)?.message)),
    pollMs: 5,
  });
  return { d, busy, sent, polls: () => polls, failWith: (e: Error) => { failNext = e; } };
}

const item = (sessionId: string, text: string, at: number): Omit<WakeItem, 'id'> => ({ sessionId, text, at, source: 'bg' });

describe('忙时延后', () => {
  test('会话正忙：不发；这一轮结束后才发', async () => {
    const h = harness();
    h.busy.add('s1');
    const done = h.d.enqueue(item('s1', '后台命令结束', 1));
    const before = h.polls();
    await waitFor(() => h.polls() >= before + 3, '轮询过几次');
    assert.equal(h.sent.length, 0, '忙的时候一条都不能发');
    h.busy.delete('s1');
    const r = await done;
    assert.equal(r.ok, true);
    assert.deepEqual(h.sent.map((x) => x.text), ['后台命令结束']);
  });

  test('空闲：立刻发', async () => {
    const h = harness();
    const r = await h.d.enqueue(item('s1', 'a', 1));
    assert.equal(r.ok, true);
    assert.equal(h.sent.length, 1);
  });

  test('发的时候撞上「还在跑」（和用户的排队消息抢）：留在队头，空了再发，不丢', async () => {
    const h = harness();
    h.failWith(new Error('Wait for the active turn (including context compaction) to finish'));
    const r = await h.d.enqueue(item('s1', 'a', 1));
    assert.equal(r.ok, true);
    assert.deepEqual(h.sent.map((x) => x.text), ['a']);
  });

  test('别的错误：报给调用方，不卡住后面的', async () => {
    const h = harness();
    h.failWith(new Error('Session not connected'));
    const first = h.d.enqueue(item('s1', 'a', 1));
    const second = h.d.enqueue(item('s1', 'b', 2));
    const r1 = await first;
    const r2 = await second;
    assert.equal(r1.ok, false);
    assert.match(String(r1.error), /not connected/);
    assert.equal(r2.ok, true);
    assert.deepEqual(h.sent.map((x) => x.text), ['b']);
  });
});

describe('顺序与不合并', () => {
  test('同时到期的多条：按时间顺序逐条发（入队顺序不同也一样），每条单独一轮', async () => {
    const h = harness();
    h.busy.add('s1');
    const ps = [
      h.d.enqueue(item('s1', 'third', 30)),
      h.d.enqueue(item('s1', 'first', 10)),
      h.d.enqueue(item('s1', 'second', 20)),
    ];
    assert.deepEqual(h.d.pending('s1').map((x) => x.text), ['first', 'second', 'third']);
    h.busy.delete('s1');
    await Promise.all(ps);
    assert.deepEqual(h.sent.map((x) => x.text), ['first', 'second', 'third']);
    assert.equal(h.sent.length, 3, '不合并成一条');
  });

  test('不同会话互不阻塞', async () => {
    const h = harness();
    h.busy.add('s1');
    const p1 = h.d.enqueue(item('s1', 'a', 1));
    await h.d.enqueue(item('s2', 'b', 2));
    assert.deepEqual(h.sent.map((x) => x.text), ['b']);
    h.busy.delete('s1');
    await p1;
  });

  test('drop：会话删了，排着的全部作废', async () => {
    const h = harness();
    h.busy.add('s1');
    const p = h.d.enqueue(item('s1', 'a', 1));
    h.d.drop('s1');
    const r = await p;
    assert.equal(r.ok, false);
    h.busy.delete('s1');
    await new Promise((r2) => setTimeout(r2, 30));
    assert.equal(h.sent.length, 0);
  });
});

describe('排着的时候任务被取消 / 暂停', () => {
  test('dropRef：按 ref 撤掉还没发的那几条（别的不动）', async () => {
    const h = harness();
    h.busy.add('s1');
    const a = h.d.enqueue({ ...item('s1', 'sched a', 1), source: 'schedule', ref: 'sched_a' });
    const b = h.d.enqueue({ ...item('s1', 'other', 2), ref: 'bg_1' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.d.dropRef('sched_a'), 1);
    const ra = await a;
    assert.equal(ra.ok, false);
    assert.equal(ra.skipped, true);
    h.busy.delete('s1');
    await b;
    assert.deepEqual(h.sent.map((x) => x.text), ['other']);
  });

  test('发之前再问一次 isStale：等的期间被暂停 / 删除 / 过期的不发', async () => {
    const stale = new Set<string>();
    const busy = new Set<string>(['s1']);
    const sent: string[] = [];
    const d = new WakeDispatcher({
      isBusy: (sid) => busy.has(sid),
      deliver: async (it) => { sent.push(it.text); },
      isStale: (it) => (it.ref && stale.has(it.ref) ? 'paused' : null),
      pollMs: 5,
    });
    const p = d.enqueue({ ...item('s1', 'sched', 1), source: 'schedule', ref: 'sched_x' });
    await new Promise((r) => setTimeout(r, 20));
    stale.add('sched_x');
    busy.delete('s1');
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.deepEqual(sent, []);
  });
});

describe('已经开始发（挂执行器 / 等切换）的那一条，中途被取消', () => {
  test('deliver 抛 WakeSkipped：算 skipped，不算失败，后面的照发', async () => {
    const sent: string[] = [];
    const d = new WakeDispatcher({
      isBusy: () => false,
      deliver: async (it) => {
        if (it.text === 'cancelled-mid-attach') throw new WakeSkipped('paused');
        sent.push(it.text);
      },
      pollMs: 5,
    });
    const a = d.enqueue({ ...item('s1', 'cancelled-mid-attach', 1), source: 'schedule', ref: 'sched_x' });
    const b = d.enqueue(item('s1', 'next', 2));
    const ra = await a;
    assert.equal(ra.ok, false);
    assert.equal(ra.skipped, true);
    assert.equal(ra.error, 'paused');
    assert.equal((await b).ok, true);
    assert.deepEqual(sent, ['next']);
  });
});

describe('撞上忙的判据不看界面语言', () => {
  test('中文报错 + SESSION_BUSY 错误码：认作忙；只看会话此刻忙不忙也认', () => {
    const zh = Object.assign(new Error('请等当前这一轮（包括上下文压缩）结束后再发送排队消息。'), { code: SESSION_BUSY });
    assert.equal(isWakeBusyError(zh, false), true);
    assert.equal(isWakeBusyError(new Error('请等当前这一轮结束'), true), true, '会话此刻正忙');
    assert.equal(isWakeBusyError(new Error('会话没连上'), false), false);
  });

  test('中文界面下撞上别人先开的那一轮：通知留着，空了再发成功（只算一次）', async () => {
    const busy = new Set<string>();
    let attempts = 0;
    const sent: string[] = [];
    const d = new WakeDispatcher({
      isBusy: (sid) => busy.has(sid),
      deliver: async (it) => {
        attempts += 1;
        if (attempts === 1) {
          busy.add(it.sessionId);                                   // 用户的消息抢先开了一轮
          setTimeout(() => busy.delete(it.sessionId), 30);
          throw Object.assign(new Error('请等当前这一轮（包括上下文压缩）结束后再发送排队消息。'), { code: SESSION_BUSY });
        }
        sent.push(it.text);
      },
      isBusyError: (err) => isWakeBusyError(err, false),
      pollMs: 5,
    });
    const r = await d.enqueue(item('s1', '🔔 后台命令结束', 1));
    assert.equal(r.ok, true);
    assert.equal(attempts, 2);
    assert.deepEqual(sent, ['🔔 后台命令结束']);
  });
});
