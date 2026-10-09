import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createControlServer, createQuitCoordinator, type ControlServerOptions } from '../src/main/controlServer.ts';
import { blocksQuit, collectBusySessions, queueCounts, type BusySession } from '../src/main/busySessions.ts';

/*
 * agent-board 的「拉取并重启」靠这个入口让 KiroLex 自己退出：退出必须走托盘「Quit」那条路径，
 * 这样 before-quit 才会断开 kiro-cli、释放会话锁。并且**用户正在用的会话不能被打断** —— 有会话在跑就等。
 * 这里钉 HTTP 这一层（token、ping、回调、control.json）和等待逻辑（喂假的会话状态）。
 */
function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kctl-')), 'sub', 'control.json');
}

/** 一份可以随手改的假会话状态；`calls()` 是 getBusy 被查了几次（用来确认轮询真的跑过） */
function fakeState() {
  const turns = new Set<string>();
  const scheduleRuns = new Map<string, string>();
  const queues = new Map<string, number>();
  let calls = 0;
  const getBusy = (): BusySession[] => {
    calls++;
    return collectBusySessions({
      turns, scheduleRuns: scheduleRuns.values(), queues: queues.entries(),
      titleOf: (id) => `title of ${id}`,
    });
  };
  return { turns, scheduleRuns, queues, getBusy, calls: () => calls };
}

async function start(extra: Partial<ControlServerOptions> = {}) {
  let quits = 0;
  const file = tmpFile();
  const srv = await createControlServer({ onQuit: () => { quits++; }, file, pollMs: 10, ...extra });
  const url = (p: string) => `http://127.0.0.1:${srv.port}${p}`;
  const post = (p: string, token: string | null = srv.token) =>
    fetch(url(p), { method: 'POST', headers: token === null ? {} : { Authorization: `Bearer ${token}` } });
  return { srv, file, url, post, quits: () => quits };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询到条件成立；机器忙的时候计时器会晚到，所以不用固定等待，超时才算失败 */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`等了 ${timeoutMs}ms 还没等到：${what}`);
    await sleep(5);
  }
}

/** 等 getBusy 再被查 n 次 —— 「不该退」的断言要在轮询确实跑过之后才有意义 */
async function waitPolls(calls: () => number, n = 3): Promise<void> {
  const target = calls() + n;
  await waitFor(() => calls() >= target, `再轮询 ${n} 次`);
}

describe('controlServer：control.json', () => {
  test('写 control.json：port / token / pid', async () => {
    const { srv, file } = await start();
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(j, { port: srv.port, token: srv.token, pid: process.pid });
      assert.ok(srv.token.length >= 32);
    } finally { await srv.close(); }
  });

  test('close 删掉 control.json', async () => {
    const { srv, file } = await start();
    await srv.close();
    assert.equal(fs.existsSync(file), false);
  });

  test('别的进程已经覆盖了 control.json 时 close 不删它', async () => {
    const { srv, file } = await start();
    fs.writeFileSync(file, JSON.stringify({ port: 1, token: 'x', pid: process.pid + 1 }));
    await srv.close();
    assert.equal(fs.existsSync(file), true);
  });
});

describe('controlServer：HTTP', () => {
  test('GET /ping 不要 token，报忙的会话数', async () => {
    const st = fakeState();
    const { srv, url } = await start({ getBusy: st.getBusy });
    try {
      let r = await fetch(url('/ping'));
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, pid: process.pid, busy: 0 });
      st.turns.add('a');
      st.queues.set('b', 2);
      r = await fetch(url('/ping'));
      assert.deepEqual(await r.json(), { ok: true, pid: process.pid, busy: 2 });
    } finally { await srv.close(); }
  });

  test('POST /quit 和 /quit/cancel 没 token / 错 token → 401，不退出', async () => {
    const { srv, url, post, quits } = await start();
    try {
      assert.equal((await post('/quit', null)).status, 401);
      assert.equal((await post('/quit', 'nope')).status, 401);
      assert.equal((await fetch(url('/quit'), { method: 'POST', headers: { Authorization: srv.token } })).status, 401);
      assert.equal((await post('/quit/cancel', null)).status, 401);
      assert.equal((await post('/quit/cancel', 'nope')).status, 401);
      await sleep(30);
      assert.equal(quits(), 0);
    } finally { await srv.close(); }
  });

  test('空闲时 POST /quit → 202 {quitting:true}，然后只调一次退出回调', async () => {
    const { srv, post, quits } = await start({ getBusy: fakeState().getBusy });
    try {
      const r = await post('/quit');
      assert.equal(r.status, 202);
      assert.deepEqual(await r.json(), { quitting: true });
      await post('/quit');
      await waitFor(() => quits() > 0, '退出回调');
      await sleep(30);
      assert.equal(quits(), 1);
    } finally { await srv.close(); }
  });

  test('忙时 POST /quit → 202 {quitting:false, waiting}，ping 带 pendingQuit；空下来再退', async () => {
    const st = fakeState();
    const pendingSeen: boolean[] = [];
    const { srv, url, post, quits } = await start({ getBusy: st.getBusy, onPendingChange: (p) => pendingSeen.push(p) });
    try {
      st.turns.add('a');
      st.scheduleRuns.set('sched_1', 'b');
      const r = await post('/quit');
      assert.equal(r.status, 202);
      assert.deepEqual(await r.json(), { quitting: false, waiting: 2 });
      assert.deepEqual(pendingSeen, [true]);
      assert.deepEqual(await (await fetch(url('/ping'))).json(), { ok: true, pid: process.pid, busy: 2, pendingQuit: true });

      st.turns.delete('a');
      await waitPolls(st.calls);
      assert.equal(quits(), 0, '还有一个定时任务在跑');
      st.scheduleRuns.clear();
      await waitFor(() => quits() > 0, '空下来后退出');
      assert.equal(quits(), 1);
    } finally { await srv.close(); }
  });

  test('POST /quit?force=1 忙也不等', async () => {
    const st = fakeState();
    st.turns.add('a');
    const { srv, post, quits } = await start({ getBusy: st.getBusy });
    try {
      const r = await post('/quit?force=1');
      assert.equal(r.status, 202);
      assert.deepEqual(await r.json(), { quitting: true });
      await waitFor(() => quits() > 0, '强制退出');
      assert.equal(quits(), 1);
    } finally { await srv.close(); }
  });

  test('POST /quit/cancel 取消等待：不退，pendingQuit 消失，恢复排队', async () => {
    const st = fakeState();
    st.turns.add('a');
    const pendingSeen: boolean[] = [];
    const { srv, url, post, quits } = await start({ getBusy: st.getBusy, onPendingChange: (p) => pendingSeen.push(p) });
    try {
      await post('/quit');
      const r = await post('/quit/cancel');
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, cancelled: true });
      assert.deepEqual(pendingSeen, [true, false]);
      st.turns.clear();
      await sleep(40);
      assert.equal(quits(), 0, '取消之后空下来也不退');
      assert.deepEqual(await (await fetch(url('/ping'))).json(), { ok: true, pid: process.pid, busy: 0 });
      // 没在等的时候取消：什么都不做
      assert.deepEqual(await (await post('/quit/cancel')).json(), { ok: true, cancelled: false });
    } finally { await srv.close(); }
  });

  test('其它路径和方法 → 404', async () => {
    const { srv, url } = await start();
    try {
      assert.equal((await fetch(url('/'))).status, 404);
      assert.equal((await fetch(url('/quit'))).status, 404);
      assert.equal((await fetch(url('/quit/cancel'))).status, 404);
      assert.equal((await fetch(url('/ping'), { method: 'POST' })).status, 404);
    } finally { await srv.close(); }
  });
});

describe('等待退出（不依赖 HTTP）', () => {
  test('空闲 → 立即退出，不进入等待', async () => {
    let quits = 0;
    const pendingSeen: boolean[] = [];
    const q = createQuitCoordinator({ onQuit: () => quits++, getBusy: () => [], onPendingChange: (p) => pendingSeen.push(p), pollMs: 10 });
    assert.deepEqual(q.request(), { quitting: true });
    await waitFor(() => quits > 0, '退出回调');
    assert.equal(quits, 1);
    assert.equal(q.pending, false);
    assert.deepEqual(pendingSeen, []);
  });

  test('忙 → 等待；等待期间告诉调用方暂停新一轮；空下来才退', async () => {
    const st = fakeState();
    st.turns.add('a');
    let quits = 0;
    let paused = false;
    const q = createQuitCoordinator({ onQuit: () => quits++, getBusy: st.getBusy, onPendingChange: (p) => { paused = p; }, pollMs: 10 });
    assert.deepEqual(q.request(), { quitting: false, waiting: 1 });
    assert.equal(q.pending, true);
    assert.equal(paused, true, '等待期间排队 / 定时任务要暂停');
    await waitPolls(st.calls);
    assert.equal(quits, 0);
    // 再请求一次：还在等，不重复起计时器
    assert.deepEqual(q.request(), { quitting: false, waiting: 1 });
    st.turns.clear();
    await waitFor(() => quits > 0, '空下来后退出');
    assert.equal(quits, 1);
    q.dispose();
  });

  test('只排着消息不挡退出（等待期间队列是冻住的，否则永远等不完）', async () => {
    const st = fakeState();
    st.queues.set('a', 3);
    let quits = 0;
    const q = createQuitCoordinator({ onQuit: () => quits++, getBusy: st.getBusy, pollMs: 10 });
    assert.deepEqual(q.request(), { quitting: true });
    await waitFor(() => quits > 0, '退出回调');
    assert.equal(quits, 1);
  });

  test('判断忙不忙时抛错 → 当作忙，不退', async () => {
    let quits = 0;
    let calls = 0;
    const q = createQuitCoordinator({ onQuit: () => quits++, getBusy: () => { calls++; throw new Error('boom'); }, pollMs: 10 });
    assert.equal(q.request().quitting, false);
    await waitPolls(() => calls);
    assert.equal(quits, 0);
    q.dispose();
  });

  test('force → 忙也立即退', async () => {
    const st = fakeState();
    st.turns.add('a');
    let quits = 0;
    const q = createQuitCoordinator({ onQuit: () => quits++, getBusy: st.getBusy, pollMs: 10 });
    q.request();
    assert.deepEqual(q.request(true), { quitting: true });
    await waitFor(() => quits > 0, '强制退出');
    assert.equal(quits, 1);
    const polled = st.calls();
    await sleep(30);
    assert.equal(st.calls(), polled, '计时器也停了');
    assert.equal(quits, 1, '计时器也停了，不会再退一次');
  });

  test('cancel → 恢复，之后空下来也不退', async () => {
    const st = fakeState();
    st.turns.add('a');
    let quits = 0;
    let paused = false;
    const q = createQuitCoordinator({ onQuit: () => quits++, getBusy: st.getBusy, onPendingChange: (p) => { paused = p; }, pollMs: 10 });
    q.request();
    assert.equal(q.cancel(), true);
    assert.equal(paused, false);
    assert.equal(q.pending, false);
    st.turns.clear();
    await sleep(30);
    assert.equal(quits, 0);
    assert.equal(q.cancel(), false);
  });
});

describe('busySessions', () => {
  test('同一会话多种原因合成一条，带标题和排队条数', () => {
    const busy = collectBusySessions({
      turns: ['a'],
      scheduleRuns: ['a', 'b'],
      revisePending: [['c', 1], ['d', 0]],
      queues: [['a', 2], ['e', 1]],
      titleOf: (id) => (id === 'a' ? '会话 A' : undefined),
    });
    assert.deepEqual(busy, [
      { id: 'a', reasons: ['turn', 'schedule', 'queued'], queued: 2, title: '会话 A' },
      { id: 'b', reasons: ['schedule'] },
      { id: 'c', reasons: ['revise'] },
      { id: 'e', reasons: ['queued'], queued: 1 },
    ]);
    assert.deepEqual(busy.filter(blocksQuit).map((s) => s.id), ['a', 'b', 'c']);
  });

  test('queueCounts 读 kirolex-queues，坏数据当没有', () => {
    assert.deepEqual(queueCounts(JSON.stringify({ a: [{ id: 1 }, { id: 2 }], b: [], c: 'x' })), [['a', 2]]);
    assert.deepEqual(queueCounts(null), []);
    assert.deepEqual(queueCounts('{not json'), []);
  });
});
