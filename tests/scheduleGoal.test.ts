import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_ERROR_LIMIT,
  MODEL_SCHEDULE_TTL_MS,
  createSchedule,
  isDue,
  modelScheduleFromArgs,
  nextRunAt,
  planScheduleCheck,
  recordRun,
  scheduleDeliveryBlocker,
  scheduleEndedText,
  scheduleGoalSuffix,
  scheduleTerminal,
  validateSchedule,
  type ScheduleState,
} from '../src/main/schedule.ts';

/**
 * 「跑到目标达成为止」的定时任务：`until`（文字目标）+ 可选 `checkCommand`（本机机械检查，没变化不叫醒模型）
 * + `expiresInDays`（1–30，默认 7）。
 */
const NOW = new Date(2026, 9, 18, 10, 0, 0).getTime();
const DAY = 24 * 3600 * 1000;

function goalJob(over: Partial<ScheduleState['spec']> = {}): ScheduleState {
  const r = modelScheduleFromArgs({ prompt: '查看板', kind: 'interval', everySec: 1800, until: 'd0a22e82 done', ...over }, NOW, 'zh');
  assert.ok('spec' in r, JSON.stringify(r));
  return { ...createSchedule('s1', r.spec, NOW), createdBy: 'model', expiresAt: r.expiresAt };
}

describe('until：不给 maxRuns 也能建', () => {
  test('给了 until 的循环任务 maxRuns 可选，不按次数停', () => {
    const r = modelScheduleFromArgs({ prompt: '查看板', kind: 'interval', everySec: 1800, until: '都 done' }, NOW, 'zh');
    assert.ok('spec' in r, JSON.stringify(r));
    assert.equal(r.spec.maxRuns, null);
    assert.equal(r.spec.until, '都 done');
    let s: ScheduleState = { ...createSchedule('s1', r.spec, NOW), expiresAt: r.expiresAt };
    for (let i = 0; i < 500; i += 1) s = recordRun(s, NOW + i * 1000);
    assert.equal(scheduleTerminal(s, NOW + 1000), null, '跑多少次都不算用尽');
    assert.ok(nextRunAt(s) !== null);
    assert.equal(isDue(s, NOW + 500 * 1000 + 1800_000), true);
  });

  test('until 和 maxRuns 都给：两个都算', () => {
    const r = modelScheduleFromArgs({ prompt: 'x', kind: 'interval', everySec: 60, until: 'y', maxRuns: 2 }, NOW, 'zh');
    assert.ok('spec' in r);
    assert.equal(r.spec.maxRuns, 2);
  });

  test('不给 until 时循环类照旧必须给 maxRuns', () => {
    const r = modelScheduleFromArgs({ prompt: 'x', kind: 'interval', everySec: 60 }, NOW, 'zh');
    assert.ok('error' in r);
  });

  test('checkCommand 需要 until（不然 exit 0 说的「达成」没有对象）', () => {
    const r = modelScheduleFromArgs({ prompt: 'x', kind: 'interval', everySec: 60, maxRuns: 3, checkCommand: 'true' }, NOW, 'zh');
    assert.ok('error' in r);
  });

  test('validateSchedule：没有 until 时 maxRuns 为空照样拒绝（对话框建的不受影响）', () => {
    assert.ok(validateSchedule({ prompt: 'x', kind: 'interval', everySec: 60, maxRuns: null } as any, 'zh').length > 0);
  });

  test('旧记录（没有新字段）照常到点、照常按次数用尽', () => {
    const old = { spec: { prompt: 'p', kind: 'interval', everySec: 60, maxRuns: 2 }, sessionId: 's', runs: 0, createdAt: NOW, lastRunAt: null, lastError: null, paused: false, terminal: null } as ScheduleState;
    assert.equal(isDue(old, NOW), true);
    const twice = recordRun(recordRun(old, NOW), NOW + 60_000);
    assert.equal(scheduleTerminal(twice), 'exhausted');
    assert.equal(scheduleGoalSuffix(old, 'id1', '', 'zh'), '', '没有目标就原样发 prompt');
  });
});

describe('到点消息里带上目标', () => {
  test('提醒达成后调用 schedule_delete', () => {
    const text = scheduleGoalSuffix(goalJob(), 'sched_1', '', 'zh');
    assert.match(text, /d0a22e82 done/);
    assert.match(text, /schedule_delete/);
    assert.match(text, /sched_1/);
  });
});

describe('expiresInDays', () => {
  const exp = (v: unknown) => {
    const r = modelScheduleFromArgs({ prompt: 'x', kind: 'interval', everySec: 60, maxRuns: 3, expiresInDays: v }, NOW, 'zh');
    assert.ok('spec' in r);
    return r.expiresAt;
  };
  test('默认 7 天不变', () => assert.equal(exp(undefined), NOW + MODEL_SCHEDULE_TTL_MS));
  test('夹在 1–30', () => {
    assert.equal(exp(3), NOW + 3 * DAY);
    assert.equal(exp(0), NOW + 1 * DAY);
    assert.equal(exp(-5), NOW + 1 * DAY);
    assert.equal(exp(100), NOW + 30 * DAY);
    assert.equal(exp(Infinity), NOW + 30 * DAY);
    assert.equal(exp('abc'), NOW + MODEL_SCHEDULE_TTL_MS);
  });
  test('模型不能设成不过期', () => {
    assert.equal(typeof exp(null), 'number');
    assert.equal(typeof exp('never'), 'number');
  });
});

describe('checkCommand：机械检查', () => {
  const job = () => goalJob({ checkCommand: 'node check.js' });

  test('退出码 0 → 任务结束（achieved）并叫醒模型做最终汇报', () => {
    const p = planScheduleCheck(job(), { status: 'exited', code: 0, output: 'all done' }, NOW, 'zh');
    assert.equal(p.action, 'achieved');
    assert.equal(p.state.terminal, 'achieved');
    assert.match(p.text, /all done/);
    assert.equal(scheduleDeliveryBlocker(p.state, NOW), null, '最终汇报那一条不能被自己的终态挡掉');
    assert.equal(isDue(p.state, NOW + DAY), false);
  });

  test('退出码 1 且输出和上次相同 → 跳过、不叫醒，不记次数', () => {
    const first = planScheduleCheck(job(), { status: 'exited', code: 1, output: '2 open' }, NOW, 'zh');
    assert.equal(first.action, 'wake', '第一次没有「上一次」可比：叫醒');
    const again = planScheduleCheck(first.state, { status: 'exited', code: 1, output: '2 open\n' }, NOW + 1800_000, 'zh');
    assert.equal(again.action, 'skip');
    assert.equal(again.state.runs, first.state.runs);
    assert.equal(again.state.lastRunAt, NOW + 1800_000, '下一次检查从这次算起');
  });

  test('输出变了 → 叫醒并附上新输出', () => {
    const first = planScheduleCheck(job(), { status: 'exited', code: 1, output: '2 open' }, NOW, 'zh');
    const changed = planScheduleCheck(first.state, { status: 'exited', code: 1, output: '1 open' }, NOW + 1800_000, 'zh');
    assert.equal(changed.action, 'wake');
    assert.match(changed.text, /1 open/);
    assert.match(scheduleGoalSuffix(changed.state, 'sched_1', changed.text, 'zh'), /1 open/);
  });

  test('出错（其他退出码 / 超时）→ 叫醒附错误；连续 3 次 → 暂停并提示用户', () => {
    let s = job();
    const a = planScheduleCheck(s, { status: 'exited', code: 2, output: 'boom' }, NOW, 'zh');
    assert.equal(a.action, 'wake');
    assert.match(a.text, /boom/);
    s = a.state;
    const b = planScheduleCheck(s, { status: 'timeout', output: 'slow' }, NOW + 1, 'zh');
    assert.equal(b.action, 'wake');
    s = b.state;
    const c = planScheduleCheck(s, { status: 'failed', output: 'spawn ENOENT' }, NOW + 2, 'zh');
    assert.equal(CHECK_ERROR_LIMIT, 3);
    assert.equal(c.action, 'paused');
    assert.equal(c.state.paused, true);
    assert.match(c.text, /spawn ENOENT/);
    assert.match(c.text, /3/);
  });

  test('中间成功一次就重新计数', () => {
    let s = job();
    s = planScheduleCheck(s, { status: 'exited', code: 2, output: 'e' }, NOW, 'zh').state;
    s = planScheduleCheck(s, { status: 'exited', code: 2, output: 'e' }, NOW, 'zh').state;
    s = planScheduleCheck(s, { status: 'exited', code: 1, output: 'ok' }, NOW, 'zh').state;
    assert.equal(planScheduleCheck(s, { status: 'exited', code: 2, output: 'e' }, NOW, 'zh').action, 'wake');
  });
});

describe('到期但目标没达成：说清楚', () => {
  test('目标型任务过期的消息写明目标还没达成', () => {
    const s = goalJob();
    const expired = { ...s, terminal: scheduleTerminal(s, NOW + 8 * DAY)! };
    assert.equal(expired.terminal, 'expired');
    const text = scheduleEndedText(expired, 'expired', 'zh');
    assert.match(text, /目标还没达成/);
    assert.match(text, /d0a22e82 done/);
  });

  test('普通任务的结束消息不变', () => {
    const r = modelScheduleFromArgs({ prompt: 'x', kind: 'interval', everySec: 60, maxRuns: 3 }, NOW, 'zh');
    assert.ok('spec' in r);
    const text = scheduleEndedText({ ...createSchedule('s', r.spec, NOW), runs: 3 }, 'exhausted', 'zh');
    assert.doesNotMatch(text, /目标/);
  });
});

describe('磁盘上的记录', () => {
  test('目标型任务落盘再读回：maxRuns 仍是 null、目标和检查命令都在；旧格式记录照常读、照常到点', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const store = await import('../src/main/scheduleStore.ts');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-goal-'));
    try {
      store.writeSchedule('g1', goalJob({ checkCommand: 'node c.js' }), home);
      const dir = store.scheduleDir(home);
      fs.writeFileSync(path.join(dir, 'old1.json'), JSON.stringify({
        id: 'old1', updatedAt: NOW,
        state: { spec: { prompt: 'p', kind: 'interval', everySec: 60, maxRuns: 5 }, sessionId: 's', runs: 1, createdAt: NOW, lastRunAt: NOW, lastError: null, paused: false, terminal: null },
      }));
      const jobs = store.listSchedules(home);
      const g = jobs.find((j) => j.id === 'g1')!;
      assert.equal(g.state.spec.maxRuns, null);
      assert.equal(g.state.spec.until, 'd0a22e82 done');
      assert.equal(g.state.spec.checkCommand, 'node c.js');
      assert.equal(isDue(g.state, NOW), true);
      const old = jobs.find((j) => j.id === 'old1')!;
      assert.equal(isDue(old.state, NOW + 60_000), true);
      assert.equal(scheduleGoalSuffix(old.state, 'old1', '', 'zh'), '');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('长输出：按完整输出的指纹比较', () => {
  test('展示的末尾一样、完整输出的指纹不同 → 叫醒；指纹一样 → 跳过', () => {
    const r = modelScheduleFromArgs({ prompt: 'x', kind: 'interval', everySec: 60, until: 'y', checkCommand: 'c' }, NOW, 'zh');
    assert.ok('spec' in r);
    const s0 = createSchedule('s', r.spec, NOW);
    const tail = 'x'.repeat(4000);
    const a = planScheduleCheck(s0, { status: 'exited', code: 1, output: tail, fingerprint: 'fp-open' }, NOW, 'zh');
    const b = planScheduleCheck(a.state, { status: 'exited', code: 1, output: tail, fingerprint: 'fp-done' }, NOW, 'zh');
    assert.equal(b.action, 'wake');
    const c = planScheduleCheck(b.state, { status: 'exited', code: 1, output: tail, fingerprint: 'fp-done' }, NOW, 'zh');
    assert.equal(c.action, 'skip');
  });
});
