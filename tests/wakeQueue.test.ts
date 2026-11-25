import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_BUSY, SESSION_NOT_CONNECTED, WakeDispatcher, WakeSkipped, connRetryDelay, isWakeBusyError, isWakeConnectionError, wakeAlreadyDelivered, type WakeItem } from '../src/main/wakeQueue.ts';

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

describe('会话没连着（断网 / ssh 断开 / 凭证拿不到）：不丢，等连上再发', () => {
  const notConnected = () => Object.assign(new Error('会话没连着'), { code: SESSION_NOT_CONNECTED });

  function connHarness(opts: { giveUpMs?: number; firstMs?: number; maxMs?: number } = {}) {
    let now = 1_000_000;
    let connected = false;
    let attempts = 0;
    const sent: WakeItem[] = [];
    const waiting: WakeItem[] = [];
    const gaveUp: Array<{ item: WakeItem; error: string }> = [];
    let saved: WakeItem[] = [];
    const deps = {
      isBusy: () => false,
      deliver: async (it: WakeItem) => {
        attempts += 1;
        if (!connected) throw notConnected();
        sent.push(it);
      },
      now: () => now,
      connRetry: { firstMs: opts.firstMs ?? 5, maxMs: opts.maxMs ?? 20, giveUpMs: opts.giveUpMs ?? 24 * 3600_000 },
      waitingForConnection: (it: WakeItem) => { waiting.push(it); },
      gaveUp: (it: WakeItem, error: string) => { gaveUp.push({ item: it, error }); },
      persist: (it: WakeItem) => it.source === 'session',
      changed: (list: WakeItem[]) => { saved = list; },
      pollMs: 5,
    };
    const d = new WakeDispatcher(deps);
    return {
      d, deps, sent, waiting, gaveUp, saved: () => saved, attempts: () => attempts,
      connect: () => { connected = true; }, advance: (ms: number) => { now += ms; },
    };
  }

  test('错误码判断，不看文字', () => {
    assert.equal(isWakeConnectionError(notConnected()), true);
    assert.equal(isWakeConnectionError(new Error('Session not connected')), false, '没有错误码的不算');
    assert.equal(isWakeConnectionError(Object.assign(new Error('x'), { code: SESSION_BUSY })), false);
  });

  test('退避：15s → 30s → … 最多 5 分钟一次', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => connRetryDelay(n)), [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });

  test('deliver 抛连接类错误：条目仍在 pending()，发起方会话里提示一次；连上后发出、只发一次', async () => {
    const h = connHarness();
    let result: any = null;
    void h.d.enqueue({ sessionId: 's_a', text: '📨 回复', at: 1, source: 'session', ref: 'reply_1' }).then((r) => { result = r; });
    await waitFor(() => h.attempts() >= 3, '退避重试几次');
    assert.equal(result, null, '还没放弃');
    assert.deepEqual(h.d.pending('s_a').map((x) => x.text), ['📨 回复']);
    assert.equal(h.waiting.length, 1, '等连接的提示只说一次');
    assert.equal(h.sent.length, 0);
    h.connect();
    await waitFor(() => result !== null, '连上后发出');
    assert.equal(result.ok, true);
    assert.equal(h.sent.length, 1);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(h.sent.length, 1, '只发一次');
    assert.equal(h.waiting.length, 1, '发出后不再提示');
    assert.deepEqual(h.d.pending('s_a'), []);
  });

  test('有「连上了」的事件就不用等退避：kick 立刻再试', async () => {
    const h = connHarness({ firstMs: 60_000, maxMs: 60_000 });
    const p = h.d.enqueue({ sessionId: 's_a', text: 'x', at: 1, source: 'bg', ref: 'bg_1' });
    await waitFor(() => h.attempts() === 1, '第一次失败');
    await new Promise((r) => setTimeout(r, 10));
    h.connect();
    h.d.kick('s_a');
    const r = await p;
    assert.equal(r.ok, true);
    assert.equal(h.attempts(), 2);
  });

  test('超过上限才放弃：resolve(ok:false)，并交给 gaveUp 在会话里留提示', async () => {
    const h = connHarness({ giveUpMs: 1000 });
    let result: any = null;
    void h.d.enqueue({ sessionId: 's_a', text: '📨 回复', at: 1, source: 'session', ref: 'r' }).then((r) => { result = r; });
    await waitFor(() => h.attempts() >= 2, '重试');
    assert.equal(result, null, '没到上限不放弃');
    h.advance(1000);
    await waitFor(() => result !== null, '放弃');
    assert.equal(result.ok, false);
    assert.equal(h.gaveUp.length, 1);
    assert.equal(h.gaveUp[0].item.text, '📨 回复');
    assert.deepEqual(h.d.pending('s_a'), []);
    assert.deepEqual(h.saved(), [], '放弃后盘上也不留');
  });

  test('等连接期间照样先过 isStale：定时任务被暂停了就不发', async () => {
    let stale = false;
    const h = connHarness();
    const d = new WakeDispatcher({ ...h.deps, isStale: () => (stale ? 'paused' : null) });
    const p = d.enqueue({ sessionId: 's_a', text: 'sched', at: 1, source: 'schedule', ref: 'sched_1' });
    await waitFor(() => h.attempts() >= 2, '重试');
    stale = true;
    const r = await p;
    assert.equal(r.skipped, true);
    assert.equal(h.sent.length, 0);
  });

  test('等连接期间落盘；重启（新建实例 + restore）后接着等、连上后发出', async () => {
    const h = connHarness();
    void h.d.enqueue({ sessionId: 's_a', text: '📨 回复', at: 1, source: 'session', ref: 'reply_1' });
    void h.d.enqueue({ sessionId: 's_a', text: 'bg 输出', at: 2, source: 'bg', ref: 'bg_1' });
    await waitFor(() => h.saved().length === 1 && h.saved()[0].waitingSince !== undefined, '落盘');
    assert.equal(h.saved()[0].text, '📨 回复', '只落 session 回复');
    assert.equal(h.saved()[0].waitNoted, true);
    const onDisk = JSON.parse(JSON.stringify(h.saved()));
    h.d.drop('s_a', 'test over');

    const h2 = connHarness();
    const results: any[] = [];
    h2.d.restore(onDisk, (_it, r) => { results.push(r); });
    await waitFor(() => h2.attempts() >= 2, '重启后接着试');
    assert.equal(h2.waiting.length, 0, '重启前已经提示过，不再提示');
    h2.connect();
    await waitFor(() => results.length === 1, '连上后发出');
    assert.equal(results[0].ok, true);
    assert.deepEqual(h2.sent.map((x) => x.text), ['📨 回复']);
    assert.deepEqual(h2.saved(), []);
  });

  test('wakeAlreadyDelivered：重启前已经发进会话的不再发', () => {
    const it: WakeItem = { id: 'w', sessionId: 's', text: '📨 回复\n答', at: 100_000, source: 'session' };
    assert.equal(wakeAlreadyDelivered([{ id: 'u', role: 'user', content: '📨 回复\n答', ts: 100_200 }], it), true);
    assert.equal(wakeAlreadyDelivered([{ id: 'u', role: 'user', content: '📨 回复\n答', ts: 100_200, kirolex: true }], it), false, 'KiroLex 提示不算');
    assert.equal(wakeAlreadyDelivered([{ id: 'u', role: 'user', content: '别的', ts: 100_200 }], it), false);
    assert.equal(wakeAlreadyDelivered([{ id: 'u', role: 'user', content: '📨 回复\n答', ts: 1 }], it), false, '更早的同样文字不算');
  });
});
