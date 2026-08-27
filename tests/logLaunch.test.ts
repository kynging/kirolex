import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { launchLogName, logsToPrune, LAUNCH_LOGS_KEPT } from '../src/main/logger.ts';

/**
 * ONE LOG FILE PER LAUNCH — 「日志你有没有按不同启动分文件，这个功能要加一下」.
 *
 * Everything used to append to a single `main.log`, rotated only when it passed 2 MB. Reading it meant
 * finding where the last start was, and the boundary that matters most when something breaks is exactly
 * "this run versus the previous one" — a restart was the fix for three separate problems this week.
 *
 * The name sorts chronologically as a string, which is what makes pruning a sort rather than a stat call,
 * and pruning is not optional: a file per launch on a machine that restarts the app twenty times a day is
 * the disk problem this project already has enough of.
 */
describe('a launch gets its own log file', () => {
  test('the name carries the launch time, sorted-friendly', () => {
    // Built from LOCAL components on purpose: the stamp is in the reader's own clock, so asserting a
    // UTC instant would only pass in one timezone.
    const at = new Date(2026, 7, 14, 9, 15, 30).getTime();
    assert.equal(launchLogName(at, 0), 'main-20260814-091530.log');
  });

  test('two launches in the same second do not share a file', () => {
    const at = new Date(2026, 7, 14, 9, 15, 30).getTime();
    assert.notEqual(launchLogName(at, 0), launchLogName(at, 1));
  });

  test('names sort in launch order as plain strings', () => {
    const early = launchLogName(new Date('2026-08-14T09:15:30Z').getTime(), 0);
    const late = launchLogName(new Date('2026-08-14T11:02:01Z').getTime(), 0);
    const nextDay = launchLogName(new Date('2026-08-15T00:00:00Z').getTime(), 0);
    assert.deepEqual([late, nextDay, early].sort(), [early, late, nextDay]);
  });
});

describe('old launches are pruned, because one file per launch adds up', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) =>
    launchLogName(new Date(`2026-08-${String(i + 1).padStart(2, '0')}T09:00:00Z`).getTime(), 0));

  test('the newest N are kept and the rest named for deletion', () => {
    const all = names(15);
    const gone = logsToPrune(all, 10);
    assert.equal(gone.length, 5);
    assert.deepEqual(gone, all.slice(0, 5), '删的是最旧的那几个');
  });

  test('under the limit nothing is deleted', () => {
    assert.deepEqual(logsToPrune(names(3), 10), []);
  });

  test('files that are not launch logs are left alone', () => {
    // `dev-hot.log` is written by the dev supervisor, and `main.log.1` is the old rotation scheme.
    const mixed = [...names(12), 'dev-hot.log', 'main.log', 'main.log.1'];
    for (const kept of ['dev-hot.log', 'main.log', 'main.log.1']) {
      assert.ok(!logsToPrune(mixed, 10).includes(kept), `${kept} 不该被这条规则删掉`);
    }
  });

  test('the default kept count is a real number, not a guess at call sites', () => {
    assert.ok(LAUNCH_LOGS_KEPT >= 5);
    assert.deepEqual(logsToPrune(names(LAUNCH_LOGS_KEPT), LAUNCH_LOGS_KEPT), []);
  });
});
