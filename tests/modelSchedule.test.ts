import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_SCHEDULE_TTL_MS,
  createSchedule,
  isDue,
  modelScheduleFromArgs,
  recordRun,
  scheduleTerminal,
  scheduleDeliveryBlocker,
  refundRun,
  type ScheduleState,
} from '../src/main/schedule.ts';

/**
 * 模型自己建的定时任务（kirolex-local 的 `schedule_create`）。
 *
 * 守的是：它**复用**同一套 `ScheduleState` / `dueAt` / `isDue`（不是另起一套计时），
 * 只在两处不同 —— 标了「由模型创建」，循环类默认 7 天过期；护栏（最短 60 秒、maxRuns 必填）照旧生效。
 */
const NOW = new Date(2026, 9, 18, 10, 0, 0).getTime();

describe('schedule_create 的参数 → ScheduleSpec', () => {
  test('interval：everySec + maxRuns，标成模型创建、7 天后过期', () => {
    const r = modelScheduleFromArgs({ prompt: '查一下 date', kind: 'interval', everySec: 60, maxRuns: 3 }, NOW, 'zh');
    assert.ok('spec' in r, JSON.stringify(r));
    assert.equal(r.spec.kind, 'interval');
    assert.equal(r.spec.everySec, 60);
    assert.equal(r.spec.maxRuns, 3);
    assert.equal(r.expiresAt, NOW + MODEL_SCHEDULE_TTL_MS);
    assert.equal(MODEL_SCHEDULE_TTL_MS, 7 * 24 * 3600 * 1000);
  });

  test('once + delaySec 就是「N 秒后叫醒我」：atEpoch = now + delaySec，只跑一次', () => {
    const r = modelScheduleFromArgs({ prompt: '继续看栈状态', kind: 'once', delaySec: 300 }, NOW, 'zh');
    assert.ok('spec' in r, JSON.stringify(r));
    assert.equal(r.spec.atEpoch, NOW + 300_000);
    assert.equal(r.spec.maxRuns, 1);
  });

  test('once + atEpoch（毫秒）也认', () => {
    const r = modelScheduleFromArgs({ prompt: 'x', kind: 'once', atEpoch: NOW + 1000, maxRuns: 1 }, NOW, 'zh');
    assert.ok('spec' in r);
    assert.equal(r.spec.atEpoch, NOW + 1000);
  });

  test('daily / weekly 用 atTime / weekday', () => {
    const d = modelScheduleFromArgs({ prompt: 'x', kind: 'daily', atTime: '09:30', maxRuns: 5 }, NOW, 'zh');
    assert.ok('spec' in d);
    assert.equal(d.spec.atTime, '09:30');
    const w = modelScheduleFromArgs({ prompt: 'x', kind: 'weekly', atTime: '09:30', weekday: 1, maxRuns: 5 }, NOW, 'zh');
    assert.ok('spec' in w);
    assert.equal(w.spec.weekday, 1);
  });

  test('护栏：interval 少于 60 秒拒绝', () => {
    const r = modelScheduleFromArgs({ prompt: 'x', kind: 'interval', everySec: 10, maxRuns: 3 }, NOW, 'zh');
    assert.ok('error' in r);
    assert.match(r.error, /60/);
  });

  test('护栏：循环类不给 maxRuns 拒绝（不替模型挑一个花钱的次数）', () => {
    const r = modelScheduleFromArgs({ prompt: 'x', kind: 'interval', everySec: 60 }, NOW, 'zh');
    assert.ok('error' in r);
    assert.match(r.error, /maxRuns/);
  });

  test('空 prompt / 未知 kind 拒绝', () => {
    assert.ok('error' in modelScheduleFromArgs({ prompt: '  ', kind: 'once', delaySec: 60 }, NOW, 'zh'));
    assert.ok('error' in modelScheduleFromArgs({ prompt: 'x', kind: 'hourly', maxRuns: 1 }, NOW, 'zh'));
  });
});

describe('过期', () => {
  const spec = { prompt: 'x', kind: 'interval' as const, everySec: 60, maxRuns: 1000 };
  test('过期之后不再到点，终态是 expired', () => {
    const s: ScheduleState = { ...createSchedule('s1', spec, NOW), createdBy: 'model', expiresAt: NOW + 1000 };
    assert.equal(isDue(s, NOW), true);
    assert.equal(isDue(s, NOW + 1000), false);
    assert.equal(scheduleTerminal(s, NOW + 1000), 'expired');
    assert.equal(scheduleTerminal(s, NOW + 999), null);
  });

  test('用户建的（没有 expiresAt）不受影响', () => {
    const s = createSchedule('s1', spec, NOW);
    assert.equal(isDue(s, NOW + 365 * 24 * 3600_000), true);
    assert.equal(scheduleTerminal(s, NOW + 365 * 24 * 3600_000), null);
  });
});

describe('睡眠/唤醒：错过多次到点，醒来只补一次', () => {
  test('interval：睡了 10 个周期，醒来到点一次；跑完之后不会再立刻到点', () => {
    let s = recordRun(createSchedule('s1', { prompt: 'x', kind: 'interval', everySec: 60, maxRuns: 100 }, NOW), NOW);
    const wake = NOW + 10 * 60_000 + 5_000;
    assert.equal(isDue(s, wake), true);
    s = recordRun(s, wake);
    assert.equal(isDue(s, wake + 1), false, '补过一次之后不该再连着补');
    assert.equal(s.runs, 2);
  });

  test('daily：睡了三天，醒来只补一次，下一次是明天那个点', () => {
    let s = recordRun(createSchedule('s1', { prompt: 'x', kind: 'daily', everySec: 0, atTime: '09:00', maxRuns: 100 }, NOW), NOW);
    const wake = NOW + 3 * 24 * 3600_000;
    assert.equal(isDue(s, wake), true);
    s = recordRun(s, wake);
    assert.equal(isDue(s, wake + 60_000), false);
  });
});

describe('weekly 的 weekday 必须是 0–6 的整数（否则 dueAt 找不到那一天、主进程卡死）', () => {
  for (const bad of [1.5, 'abc', 7, -1, NaN, undefined]) {
    test(`weekday=${String(bad)} 拒绝`, () => {
      const r = modelScheduleFromArgs({ prompt: 'x', kind: 'weekly', atTime: '09:00', weekday: bad, maxRuns: 3 }, NOW, 'zh');
      assert.ok('error' in r, JSON.stringify(r));
    });
  }
  test('weekday="3"（数字字符串）接受', () => {
    const r = modelScheduleFromArgs({ prompt: 'x', kind: 'weekly', atTime: '09:00', weekday: '3', maxRuns: 3 }, NOW, 'zh');
    assert.ok('spec' in r);
    assert.equal(r.spec.weekday, 3);
  });
  test('盘上已经有一份坏的 weekday：dueAt 也不能死循环', () => {
    const s = createSchedule('s1', { prompt: 'x', kind: 'weekly', everySec: 0, atTime: '09:00', weekday: 1.5, maxRuns: 3 }, NOW);
    assert.equal(isDue(s, NOW + 1000), false);
  });
});

describe('排着等会话空下来的那一次，发之前再看一眼任务还在不在', () => {
  const base = () => recordRun(createSchedule('s1', { prompt: 'x', kind: 'interval', everySec: 60, maxRuns: 3 }, NOW), NOW);
  test('还在、没暂停、没过期 → 照发（哪怕这一次已经记了账、runs 到了上限）', () => {
    assert.equal(scheduleDeliveryBlocker(base(), NOW), null);
    const last = { ...base(), runs: 3 };
    assert.equal(scheduleDeliveryBlocker(last, NOW), null);
  });
  test('被删 / 暂停 / 取消 / 过期 → 不发', () => {
    assert.ok(scheduleDeliveryBlocker(null, NOW));
    assert.ok(scheduleDeliveryBlocker({ ...base(), paused: true }, NOW));
    assert.ok(scheduleDeliveryBlocker({ ...base(), terminal: 'cancelled' }, NOW));
    assert.ok(scheduleDeliveryBlocker({ ...base(), expiresAt: NOW - 1 }, NOW));
  });
  test('退回记账：没发出去的那一次不算', () => {
    const before = base();
    const charged = recordRun(before, NOW + 60_000);
    const back = refundRun(charged, before);
    assert.equal(back.runs, before.runs);
    assert.equal(back.lastRunAt, before.lastRunAt);
  });
});
