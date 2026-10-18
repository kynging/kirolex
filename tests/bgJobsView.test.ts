import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runningBgJobs, bgElapsedText, type BgJobRow } from '../src/renderer/bgJobsView.ts';
import { sessionScheduleSummary, type ScheduleView } from '../src/renderer/scheduleView.ts';

/**
 * 会话顶部那一行「后台任务」和定时任务横幅上的「由模型创建」—— 纯展示逻辑。
 *
 * 守的是「看得见、停得掉」：只列这条会话**还在跑**的后台命令 / 监视（结束了的不挂着），按开始时间排；
 * 运行时长按分钟粒度；模型建的定时任务在横幅 / 侧栏上标出来。
 */

const row = (over: Partial<BgJobRow>): BgJobRow => ({
  jobId: 'bg_1', sessionId: 's1', kind: 'run', label: 'x', command: 'c', state: 'running',
  startedAt: 0, endedAt: null, exitCode: null, pid: 1, events: 0, ...over,
});

describe('后台任务列表', () => {
  test('只列这条会话还在跑的，按开始时间', () => {
    const list = [
      row({ jobId: 'b', startedAt: 20 }),
      row({ jobId: 'a', startedAt: 10, kind: 'watch' }),
      row({ jobId: 'done', state: 'exited' }),
      row({ jobId: 'other', sessionId: 's2' }),
    ];
    assert.deepEqual(runningBgJobs(list, 's1').map((j) => j.jobId), ['a', 'b']);
    assert.deepEqual(runningBgJobs(list, null), []);
  });

  test('运行时长', () => {
    assert.equal(bgElapsedText(0, 30_000, 'zh'), '30 秒');
    assert.equal(bgElapsedText(0, 5 * 60_000 + 10_000, 'zh'), '5 分钟');
    assert.equal(bgElapsedText(0, 2 * 3600_000 + 5 * 60_000, 'zh'), '2 小时 5 分钟');
    assert.equal(bgElapsedText(0, 30_000, 'en'), '30s');
  });
});

describe('由模型创建', () => {
  const job = (over: Partial<ScheduleView>): ScheduleView => ({
    id: 'j', sessionId: 's1', prompt: 'p', describe: '每 1 分钟', runs: 0, maxRuns: 3, paused: false,
    terminal: null, lastRunAt: null, lastError: null, nextRunAt: 60_000, ...over,
  });
  test('下一个要跑的是模型建的 → byModel', () => {
    assert.equal(sessionScheduleSummary([job({ createdBy: 'model' })], 0, 'zh')?.byModel, true);
    assert.equal(sessionScheduleSummary([job({})], 0, 'zh')?.byModel, false);
  });
});
