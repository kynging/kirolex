import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSchedule, modelScheduleFromArgs, nextRunAt, scheduleDeliveryBlocker, type ScheduleState } from '../src/main/schedule.ts';
import { runScheduleCheck, type ScheduleCheckDeps } from '../src/main/scheduleCheckRun.ts';

/**
 * 定时任务检查命令跑完之后的那段流程（index.ts 的 runScheduledJob 调它）：
 * 落盘、广播给界面、提示用户、交回要叫醒模型的那一条（或 null = 这一次不叫醒）。
 */
const NOW = new Date(2026, 9, 18, 10, 0, 0).getTime();

function job(over: Partial<ScheduleState> = {}): ScheduleState {
  const r = modelScheduleFromArgs({ prompt: '查看板', kind: 'interval', everySec: 1800, until: '都 done', checkCommand: 'node c.js' }, NOW, 'zh');
  assert.ok('spec' in r);
  return { ...createSchedule('s1', r.spec, NOW), createdBy: 'model', expiresAt: r.expiresAt, ...over };
}

function harness(initial: ScheduleState, results: any[]) {
  let disk: ScheduleState | null = initial;
  const changed: ScheduleState[] = [];
  const notes: string[] = [];
  let t = NOW;
  const deps: ScheduleCheckDeps = {
    now: () => t,
    read: () => disk,
    write: (_id, s) => { disk = s; },
    runCheck: async () => results.shift(),
    changed: (_id, s) => { changed.push(s); },
    noteUser: (_sid, text) => { notes.push(text); },
    log: () => {},
    lang: 'zh',
  };
  return { deps, changed, notes, disk: () => disk!, setDisk: (s: ScheduleState | null) => { disk = s; }, advance: (ms: number) => { t += ms; } };
}

describe('runScheduleCheck', () => {
  test('输出不变跳过：不叫醒模型，但广播更新（界面换成下一次检查的倒计时）', async () => {
    const h = harness(job({ lastRunAt: NOW - 1800_000 }), [
      { status: 'exited', code: 1, output: '2 open' },
      { status: 'exited', code: 1, output: '2 open' },
    ]);
    assert.ok(await runScheduleCheck('j', h.disk(), h.deps), '第一次：叫醒');
    h.advance(1800_000);
    const n = h.changed.length;
    assert.equal(await runScheduleCheck('j', h.disk(), h.deps), null, '没变化：不叫醒');
    assert.equal(h.changed.length, n + 1, '跳过也要广播');
    const last = h.changed[h.changed.length - 1];
    assert.equal(last.lastRunAt, NOW + 1800_000);
    assert.equal(nextRunAt(last), NOW + 3600_000, '界面拿到的是下一次检查的时间');
  });

  test('连续第 3 次出错：自动暂停、提示用户，同时交回一条错误汇报叫醒模型（不被暂停挡掉）', async () => {
    const h = harness(job({ checkErrors: 2 }), [{ status: 'timeout', output: 'slow...' }]);
    const r = await runScheduleCheck('j', h.disk(), h.deps);
    assert.ok(r, '要叫醒模型');
    assert.match(r!.text, /slow\.\.\./);
    assert.match(r!.text, /暂停/);
    assert.equal(r!.state.paused, true);
    assert.equal(h.disk().paused, true, '暂停已落盘');
    assert.equal(h.notes.length, 1, '提示了用户');
    assert.match(h.notes[0], /slow\.\.\./);
    assert.equal(scheduleDeliveryBlocker(h.disk(), NOW), null, '盘上是「检查出错暂停」：这一条汇报照发');
    assert.equal(scheduleDeliveryBlocker({ ...h.disk(), pausedBy: null }, NOW), 'paused', '用户按的暂停照旧挡住');
    assert.ok(h.changed.some((s) => s.paused));
  });

  test('退出 KiroLex 时被结束（stopped）：什么都不做', async () => {
    const h = harness(job(), [{ status: 'stopped', output: '' }]);
    assert.equal(await runScheduleCheck('j', h.disk(), h.deps), null);
    assert.equal(h.disk().checkErrors ?? 0, 0);
  });

  test('检查期间被用户暂停 / 删除：以盘上为准，不叫醒', async () => {
    const h = harness(job(), [{ status: 'exited', code: 0, output: 'done' }]);
    const p = runScheduleCheck('j', h.disk(), { ...h.deps, runCheck: async () => { h.setDisk({ ...h.disk(), paused: true }); return { status: 'exited', code: 0, output: 'done' }; } });
    assert.equal(await p, null);
  });
});

test('自动暂停那条汇报不再说「到点会再叫你」', async () => {
  const { scheduleGoalSuffix } = await import('../src/main/schedule.ts');
  const paused = { ...job(), paused: true, pausedBy: 'check-errors' as const };
  assert.doesNotMatch(scheduleGoalSuffix(paused, 'j', 'x', 'zh'), /到点会再叫你/);
  assert.match(scheduleGoalSuffix(job(), 'j', 'x', 'zh'), /到点会再叫你/);
});
