import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createLagMonitor, PhaseTracker, LAG_THRESHOLD_MS, LAG_INTERVAL_MS } from '../src/main/mainLag.ts';

/**
 * 「远程会话连接的前半段输入框没法输入」—— 主进程事件循环被同步调用卡住时，Windows 上整个窗口都不响应键盘，
 * 而原来没有任何日志能说明是哪一段卡的。这里守的是：
 *   - 卡 ≥ 300ms 一定记一行 `blocked=<ms>`，卡 200ms 一定不记 —— **不管卡的那一下从两跳之间的哪个时刻开始**
 *     （审查意见：原来按「间隔 − 采样周期」算，紧跟在上一跳之后开始的 350ms 只算出 250ms，一行都不记）；
 *   - 阶段标记：卡的那一下结束之后才轮到定时器，那时阶段可能已经结束了 —— 仍然要报出来。
 * 时钟注入，不靠真的 sleep（CI 机很忙，真等 200ms 也可能被拖到 300ms 以上）。
 */
function harness(thresholdMs = LAG_THRESHOLD_MS) {
  let now = 1_000;
  let last = now;            // 上一跳跑的时刻
  const lines: string[] = [];
  const phases = new PhaseTracker(() => now);
  const mon = createLagMonitor({
    thresholdMs, now: () => now, phases,
    log: (line) => lines.push(line),
    /* 不起真定时器：测试自己调 tick()（采样周期用默认值） */
    setTimer: () => 0 as any, clearTimer: () => {},
  });
  mon.start();
  const tick = () => { mon.tick(); last = now; };
  return {
    mon, phases, lines,
    /** 正常跑一跳（没卡） */
    idle: () => { now = last + LAG_INTERVAL_MS; tick(); },
    /**
     * 照真定时器的样子模拟一次卡顿：上一跳之后 `offset` ms 开始同步卡 `ms` ms；
     * 定时器本该在上一跳 + 周期时到，被卡住就等卡完才跑。
     */
    block: (offset: number, ms: number) => {
      now = last + offset + ms;
      if (now < last + LAG_INTERVAL_MS) now = last + LAG_INTERVAL_MS;
      tick();
    },
    advance: (ms: number) => { now += ms; },
  };
}

/** 卡的那一下从两跳之间的不同时刻开始：紧跟上一跳 / 中间 / 下一跳该到的前一刻 */
const OFFSETS = [0, 1, Math.floor(LAG_INTERVAL_MS / 2), LAG_INTERVAL_MS - 1];

describe('主进程事件循环延迟监控', () => {
  test('模拟阻塞 500ms：记一行 blocked≈500', () => {
    const h = harness();
    h.idle();
    h.block(0, 500);
    assert.equal(h.lines.length, 1);
    assert.match(h.lines[0], /^blocked=500\b/);
  });

  for (const offset of OFFSETS) {
    test(`卡的那一下在上一跳之后 ${offset}ms 开始：300ms / 350ms / 500ms 都记，200ms 不记`, () => {
      for (const ms of [300, 350, 500]) {
        const h = harness();
        h.idle();
        h.block(offset, ms);
        h.idle();
        assert.equal(h.lines.length, 1, `卡 ${ms}ms 要记一行`);
        const got = Number(/^blocked=(\d+)/.exec(h.lines[0])![1]);
        assert.ok(got >= ms && got <= ms + LAG_INTERVAL_MS, `记的 ${got} 在 [${ms}, ${ms + LAG_INTERVAL_MS}] 里`);
      }
      const h = harness();
      h.idle();
      h.block(offset, 200);
      h.idle();
      assert.deepEqual(h.lines, [], '卡 200ms 不记');
    });
  }

  test('正常跑（没卡）一行都不记', () => {
    const h = harness();
    for (let i = 0; i < 100; i++) h.idle();
    assert.deepEqual(h.lines, []);
  });

  test('带上当时正在做的阶段（还没结束的）', () => {
    const h = harness();
    const end = h.phases.enter('attach s_1');
    h.advance(100 + 800);
    h.mon.tick();
    end();
    assert.match(h.lines[0], /phase=.*attach s_1/);
  });

  test('卡的那一段在定时器跑之前就结束了：也报出来（不然最关键的那一段永远看不见）', () => {
    const h = harness();
    const end = h.phases.enter('sweep');
    h.advance(100 + 600);
    end();                           // 同步活干完了，定时器才排到
    h.mon.tick();
    assert.match(h.lines[0], /phase=.*sweep/);
    /* 报过一次就清掉：下一次卡不再挂着它 */
    h.advance(100 + 700);
    h.mon.tick();
    assert.doesNotMatch(h.lines[1], /sweep/);
    assert.match(h.lines[1], /phase=-/);
  });

  test('PhaseTracker.run：同步 / 异步都能包，抛错也会退出阶段', async () => {
    const h = harness();
    assert.equal(h.phases.run('a', () => 7), 7);
    assert.equal(await h.phases.run('b', async () => 8), 8);
    assert.throws(() => h.phases.run('c', () => { throw new Error('x'); }));
    await assert.rejects(h.phases.run('d', async () => { throw new Error('y'); }));
    assert.deepEqual(h.phases.active(), []);
  });

  test('stop 之后不再记', () => {
    const h = harness();
    h.mon.stop();
    h.advance(5_000);
    h.mon.tick();
    assert.deepEqual(h.lines, []);
  });

  test('真定时器：默认 unref（不挡进程退出）', () => {
    let unrefCalled = false;
    const mon = createLagMonitor({
      log: () => {},
      setTimer: () => ({ unref: () => { unrefCalled = true; } }) as any,
      clearTimer: () => {},
    });
    mon.start();
    mon.stop();
    assert.equal(unrefCalled, true);
  });
});

describe('重活串行化（多条会话同时 attach 时不一次叠满）', () => {
  test('同时排进来的一个接一个跑；前一个失败不影响后一个', async () => {
    const { createSerialLane } = await import('../src/main/mainLag.ts');
    const lane = createSerialLane();
    let running = 0; let peak = 0; const order: number[] = [];
    const job = (n: number, fail = false) => async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setImmediate(r));
      order.push(n); running--;
      if (fail) throw new Error(`job ${n}`);
      return n;
    };
    const results = await Promise.allSettled([lane(job(1)), lane(job(2, true)), lane(job(3))]);
    assert.equal(peak, 1, '同一时刻只跑一个');
    assert.deepEqual(order, [1, 2, 3]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  });
});
