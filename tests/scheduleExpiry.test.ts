import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeScheduleExpiry, createSchedule, modelScheduleFromArgs, MODEL_SCHEDULE_TTL_MS, type ScheduleState } from '../src/main/schedule.ts';
import { EXPIRY_PRESET_DAYS, parseExtendInput, parseUntilInput } from '../src/renderer/scheduleView.ts';

/**
 * 聊天顶部那条定时任务的「⏳ 延长…」：延长多久由用户定（常用档 / 自定义天数或小时 / 直接选到期时间 / 不过期）。
 * 主进程 `schedule:set-expiry` 收具体值：{ mode:'extend', ms } / { mode:'until', at } / { mode:'never' }。
 */
const NOW = new Date(2026, 9, 23, 10, 0, 0).getTime();
const H = 3600_000;
const D = 24 * H;

function job(over: Partial<ScheduleState> = {}): ScheduleState {
  const r = modelScheduleFromArgs({ prompt: 'p', kind: 'interval', everySec: 1800, until: 'done' }, NOW, 'zh');
  assert.ok('spec' in r);
  return { ...createSchedule('s1', r.spec, NOW), createdBy: 'model', expiresAt: r.expiresAt, ...over };
}

describe('computeScheduleExpiry（schedule:set-expiry 的计算）', () => {
  test('extend：从「现在和原到期时间里较晚的那个」起加 ms', () => {
    assert.deepEqual(computeScheduleExpiry(job({ expiresAt: NOW + 2 * D }), { mode: 'extend', ms: 3 * D }, NOW, 'zh'), { expiresAt: NOW + 5 * D });
    assert.deepEqual(computeScheduleExpiry(job({ expiresAt: NOW - D }), { mode: 'extend', ms: 5 * H }, NOW, 'zh'), { expiresAt: NOW + 5 * H }, '原到期已过就从现在算');
  });

  test('用户设的没有 30 天上限', () => {
    assert.deepEqual(computeScheduleExpiry(job({ expiresAt: NOW }), { mode: 'extend', ms: 90 * D }, NOW, 'zh'), { expiresAt: NOW + 90 * D });
    assert.deepEqual(computeScheduleExpiry(job(), { mode: 'until', at: NOW + 200 * D }, NOW, 'zh'), { expiresAt: NOW + 200 * D });
  });

  test('until：设成那个时刻；必须晚于现在', () => {
    assert.deepEqual(computeScheduleExpiry(job(), { mode: 'until', at: NOW + H }, NOW, 'zh'), { expiresAt: NOW + H });
    assert.ok('error' in computeScheduleExpiry(job(), { mode: 'until', at: NOW }, NOW, 'zh'));
    assert.ok('error' in computeScheduleExpiry(job(), { mode: 'until', at: NOW - H }, NOW, 'zh'));
  });

  test('never：不过期', () => {
    assert.deepEqual(computeScheduleExpiry(job(), { mode: 'never' }, NOW, 'zh'), { expiresAt: null });
  });

  test('非法输入被拒：ms<=0、非数字、未知 mode、缺字段', () => {
    for (const bad of [
      { mode: 'extend', ms: 0 }, { mode: 'extend', ms: -5 }, { mode: 'extend', ms: 'abc' }, { mode: 'extend', ms: NaN },
      { mode: 'extend', ms: Infinity }, { mode: 'extend' }, { mode: 'until', at: 'tomorrow' }, { mode: 'until' },
      { mode: 'forever' }, 'extend', null, undefined, 7,
    ]) {
      const r = computeScheduleExpiry(job(), bad as any, NOW, 'zh');
      assert.ok('error' in r, `${JSON.stringify(bad)} 应被拒`);
    }
  });

  test('已经结束的 / 没有过期时间的（用户建的）不让改', () => {
    assert.ok('error' in computeScheduleExpiry(job({ terminal: 'expired' }), { mode: 'never' }, NOW, 'zh'));
    assert.ok('error' in computeScheduleExpiry(job({ expiresAt: null }), { mode: 'extend', ms: D }, NOW, 'zh'));
  });
});

describe('弹层里的输入解析', () => {
  test('常用档：1 / 3 / 7 / 14 / 30 天', () => assert.deepEqual([...EXPIRY_PRESET_DAYS], [1, 3, 7, 14, 30]));

  test('自定义：正整数的天或小时', () => {
    assert.deepEqual(parseExtendInput('10', 'day', 'zh'), { ms: 10 * D });
    assert.deepEqual(parseExtendInput(' 5 ', 'hour', 'zh'), { ms: 5 * H });
    assert.deepEqual(parseExtendInput('45', 'day', 'zh'), { ms: 45 * D }, '用户设的没有 30 天上限');
    for (const bad of ['', '0', '-1', '1.5', 'abc', '3天', '1e3']) {
      assert.ok('error' in parseExtendInput(bad, 'day', 'zh'), `${JSON.stringify(bad)} 应提示`);
    }
  });

  test('自定义：直接选到期日期时间（必须晚于现在）', () => {
    const later = new Date(NOW + 2 * D);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T${pad(later.getHours())}:${pad(later.getMinutes())}`;
    assert.deepEqual(parseUntilInput(local, NOW, 'zh'), { at: NOW + 2 * D });
    assert.ok('error' in parseUntilInput('', NOW, 'zh'));
    assert.ok('error' in parseUntilInput('not a date', NOW, 'zh'));
    const earlier = new Date(NOW - H);
    assert.ok('error' in parseUntilInput(`${earlier.getFullYear()}-${pad(earlier.getMonth() + 1)}-${pad(earlier.getDate())}T${pad(earlier.getHours())}:${pad(earlier.getMinutes())}`, NOW, 'zh'));
  });
});

describe('源码：横幅不再写死 7 天', () => {
  const SRC = path.join(import.meta.dirname, '..', 'src');
  const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
  test('横幅 / 文案里没有「延长 7 天 / Extend 7 days」，主进程没有固定的 SCHEDULE_EXTEND_MS', () => {
    for (const f of [['renderer', 'components', 'ChatArea.tsx'], ['renderer', 'components', 'ScheduleExpiryPopover.tsx'], ['renderer', 'i18nZh', 'chat.ts'], ['renderer', 'scheduleView.ts']]) {
      assert.doesNotMatch(read(...f), /Extend 7 days|延长 7 天|by 7 days|往后推 7 天/, f.join('/'));
    }
    assert.doesNotMatch(read('main', 'schedule.ts'), /SCHEDULE_EXTEND_MS/);
    assert.doesNotMatch(read('main', 'index.ts'), /SCHEDULE_EXTEND_MS/);
  });

  test('横幅上是「⏳ 延长…」弹层，「不过期」在弹层里；IPC 收具体值', () => {
    const chat = read('renderer', 'components', 'ChatArea.tsx');
    assert.match(chat, /<ScheduleExpiryPopover/);
    assert.doesNotMatch(chat, /schedule-banner-never/, '「不过期」不再是横幅上单独的按钮');
    const pop = read('renderer', 'components', 'ScheduleExpiryPopover.tsx');
    assert.match(pop, /'⏳ Extend…'/);
    const body = pop.slice(pop.indexOf('className="schedule-expiry-popover"'));
    assert.ok(body.length > 0);
    assert.match(body, /mode: 'never'/);
    assert.match(body, /EXPIRY_PRESET_DAYS\.map/);
    assert.match(body, /mode: 'until'/);
    assert.match(pop, /'Escape'/, 'Esc 关闭');
    assert.match(read('main', 'index.ts'), /ipcMain\.handle\('schedule:set-expiry'[\s\S]{0,600}computeScheduleExpiry\(/);
  });

  test('模型侧不变：默认 7 天', () => {
    const r = modelScheduleFromArgs({ prompt: 'p', kind: 'interval', everySec: 60, maxRuns: 2 }, NOW, 'zh');
    assert.ok('spec' in r);
    assert.equal(r.expiresAt, NOW + MODEL_SCHEDULE_TTL_MS);
  });
});
