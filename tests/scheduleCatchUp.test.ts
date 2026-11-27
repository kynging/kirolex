import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSchedule, isDue, nextRunAt, recordRun, type ScheduleSpec, type ScheduleState } from '../src/main/schedule.ts';
import { isCatchUpRun, missedRuns, takeOver, timingState } from '../src/main/scheduleSync.ts';

/*
  接管时补跑一次（用户 2026-11-27：「定时任务过期了也不会立刻执行？」）。
  现场：每日 08:30，runner 是另一台，上次运行 11-25 20:30，之后那台没开；11-27 10:46 在本机接管 ——
  原来的规则把锚点挪到接管时刻，下一次变成 11-28 08:30，今天错过的不跑。
*/
const ME = { id: 'devA', name: 'kyn-workstation' };
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m, 0, 0).getTime();   // 2026-11-<d>

function daily(over: Partial<ScheduleState> = {}): ScheduleState {
  const spec: ScheduleSpec = { prompt: 'daily report', kind: 'daily', everySec: 0, atTime: '08:30', maxRuns: 100 };
  return { ...createSchedule('s1', spec, at(20, 9)), runs: 6, lastRunAt: at(25, 20, 30), runner: 'devB', runnerName: 'kyn-desktop', runnerChangedAt: at(20, 9), ...over };
}

/** 调度器那一跳：ticker 用原状态的 isDue，runScheduledJob 再用 timingState 判一次 —— 两个都过才跑。 */
const tickRuns = (s: ScheduleState, now: number) => isDue(s, now) && isDue(timingState(s), now);

describe('takeover catch-up', () => {
  test('the reported case: due at takeover → runs on the next tick, once; then next run is counted from that run', () => {
    const takeoverAt = at(27, 10, 46);
    const s = takeOver(daily(), ME, takeoverAt, { catchUp: true });
    assert.equal(s.catchUpPending, 2, 'missed 11-26 08:30 and 11-27 08:30');
    assert.equal(isCatchUpRun(s), true);
    assert.equal(tickRuns(s, takeoverAt + 20_000), true, 'next tick runs it');
    /* the run happens */
    const ran = recordRun(s, takeoverAt + 20_000);
    assert.equal(isCatchUpRun(ran), false);
    assert.equal(tickRuns(ran, takeoverAt + 40_000), false, 'only one catch-up, not one per missed slot');
    assert.equal(nextRunAt(timingState(ran)), at(28, 8, 30), 'then the normal schedule from this run');
  });

  test('missed 3 times → still exactly one catch-up run', () => {
    const takeoverAt = at(28, 12);
    const s = takeOver(daily(), ME, takeoverAt, { catchUp: true });
    assert.equal(missedRuns(daily(), takeoverAt).missed, 3);
    assert.equal(s.catchUpPending, 3);
    const ran = recordRun(s, takeoverAt + 1);
    assert.equal(tickRuns(ran, takeoverAt + 2), false);
    assert.equal(tickRuns(ran, at(29, 8, 30)), true, 'next regular slot');
  });

  test('not due at takeover → no early run; waits for the next slot as usual', () => {
    const fresh = daily({ lastRunAt: at(27, 8, 30) });   // already ran today
    const takeoverAt = at(27, 10, 46);
    assert.equal(missedRuns(fresh, takeoverAt).missed, 0);
    const s = takeOver(fresh, ME, takeoverAt, { catchUp: true });
    assert.equal(s.catchUpPending, null);
    assert.equal(tickRuns(s, takeoverAt + 20_000), false);
    assert.equal(tickRuns(s, at(28, 8, 30)), true);
  });

  test('once: past atEpoch and never ran → runs right after the takeover', () => {
    const spec: ScheduleSpec = { prompt: 'remind me', kind: 'once', everySec: 0, atEpoch: at(26, 9), maxRuns: 1 };
    const once = { ...createSchedule('s1', spec, at(25, 9)), runner: 'devB', runnerChangedAt: at(25, 9) };
    const s = takeOver(once, ME, at(27, 10), { catchUp: true });
    assert.equal(s.catchUpPending, 1);
    assert.equal(tickRuns(s, at(27, 10) + 20_000), true);
    assert.equal(missedRuns({ ...once, runs: 1, lastRunAt: at(26, 9) }, at(27, 10)).missed, 0, 'already ran: nothing missed');
  });

  test('unchecked box → old rule: counted from the takeover moment', () => {
    const takeoverAt = at(27, 10, 46);
    const s = takeOver(daily(), ME, takeoverAt, { catchUp: false });
    assert.equal(s.catchUpPending, null);
    assert.equal(tickRuns(s, takeoverAt + 20_000), false);
    assert.equal(nextRunAt(timingState(s)), at(28, 8, 30));
  });

  test('once: past atEpoch, never ran, catch-up unchecked → does NOT run (that one-off is skipped), and is not "due" for display', () => {
    const spec: ScheduleSpec = { prompt: 'remind me', kind: 'once', everySec: 0, atEpoch: at(26, 9), maxRuns: 1 };
    const once = { ...createSchedule('s1', spec, at(25, 9)), runner: 'devB', runnerChangedAt: at(25, 9) };
    const s = takeOver(once, ME, at(27, 10), { catchUp: false });
    assert.equal(s.catchUpPending, null);
    assert.equal(s.catchUpDeclined, true);
    assert.equal(tickRuns(s, at(27, 10) + 20_000), false, 'next tick does not run it');
    assert.equal(tickRuns(s, at(30, 10)), false, 'nor later');
    assert.equal(Number.isFinite(nextRunAt(timingState(s)) ?? NaN), false, 'no next run');
    assert.equal(s.spec.atEpoch, at(26, 9), 'the stored definition is untouched');
  });

  test('interval not due yet at takeover (checked or not) → keeps its original next run, not pushed back', () => {
    const spec: ScheduleSpec = { prompt: 'p', kind: 'interval', everySec: 3600, maxRuns: 50 };
    const hourly = { ...createSchedule('s1', spec, at(27, 0)), lastRunAt: at(27, 10), runner: 'devB', runnerChangedAt: at(27, 0) };
    for (const catchUp of [true, false]) {
      const s = takeOver(hourly, ME, at(27, 10, 30), { catchUp });
      assert.equal(s.catchUpPending, null, `catchUp=${catchUp}`);
      assert.equal(s.catchUpDeclined, null, `catchUp=${catchUp}: nothing to decline`);
      assert.equal(nextRunAt(timingState(s)), at(27, 11), `catchUp=${catchUp}: still 11:00, not 11:30`);
      assert.equal(tickRuns(s, at(27, 10, 50)), false);
      assert.equal(tickRuns(s, at(27, 11, 0) + 1000), true);
    }
  });

  test('daily not due yet at takeover → original next slot', () => {
    const fresh = daily({ lastRunAt: at(27, 8, 30) });
    const s = takeOver(fresh, ME, at(27, 10, 46), { catchUp: false });
    assert.equal(s.catchUpDeclined, null);
    assert.equal(nextRunAt(timingState(s)), at(28, 8, 30));
  });

  test('expired / paused / run cap reached → no catch-up', () => {
    const takeoverAt = at(27, 10, 46);
    for (const [label, over] of [
      ['expired', { expiresAt: at(27, 9) }],
      ['paused', { paused: true }],
      ['cap reached', { runs: 100 }],
      ['ended', { terminal: 'achieved' as const }],
    ] as const) {
      const s = takeOver(daily(over as Partial<ScheduleState>), ME, takeoverAt, { catchUp: true });
      assert.equal(s.catchUpPending, null, label);
      assert.equal(tickRuns(s, takeoverAt + 20_000), false, label);
    }
  });

  test('the runner\'s own catch-up after sleep / shutdown is unchanged (no takeover involved)', () => {
    const own = daily({ runner: ME.id });
    assert.equal(timingState(own), own, 'no takeover: timing untouched');
    assert.equal(tickRuns(own, at(27, 10, 46)), true, 'due by lastRunAt → runs on the next tick');
    const ran = recordRun(own, at(27, 10, 47));
    assert.equal(tickRuns(ran, at(27, 10, 48)), false, 'once');
  });

  test('interval: counts missed periods; never-run interval counts from creation', () => {
    const spec: ScheduleSpec = { prompt: 'p', kind: 'interval', everySec: 3600, maxRuns: 50 };
    const s = { ...createSchedule('s1', spec, at(27, 0)), lastRunAt: at(27, 5) };
    assert.equal(missedRuns(s, at(27, 9, 30)).missed, 4, '06,07,08,09');
    assert.equal(missedRuns(s, at(27, 5, 30)).missed, 0);
    assert.equal(missedRuns({ ...s, lastRunAt: null }, at(27, 2, 30)).missed, 3, '00,01,02');
  });
});

/* ── 接线 + 界面 ── */
import fs from 'fs';
import { catchUpNotice, overdueText, sessionScheduleSummary, type ScheduleView } from '../src/renderer/scheduleView.ts';

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf-8');
const MAIN = read('../src/main/index.ts');
const CHAT = read('../src/renderer/components/ChatArea.tsx');
const PRELOAD = read('../src/main/preload.ts');
const DIALOG = read('../src/renderer/components/ConfirmDialog.tsx');
const slice = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `missing ${start}`);
  return src.slice(i, src.indexOf(end, i + start.length));
};

describe('wiring: takeover catch-up, run now, resume', () => {
  test('take-over passes the checkbox choice into takeOver and kicks the scheduler when a catch-up is pending', () => {
    const body = slice(MAIN, "ipcMain.handle('schedule:take-over'", '\n  });\n');
    assert.match(body, /\(_event, id: string, defHash: string, catchUp\?: boolean\)/);
    assert.match(body, /takeOver\(job\.state, me, Date\.now\(\), \{ catchUp: catchUp === true \}\)/);
    assert.ok(body.indexOf('definitionHash(job.state) !== defHash') < body.indexOf('takeOver(job.state'), 'definition check still first');
    assert.match(body, /if \(state\.catchUpPending\) runDueSchedulesNow\(/);
  });

  test('a catch-up run is logged as `schedule catch-up id=… missed=N`', () => {
    const body = slice(MAIN, 'async function runScheduledJob(', 'function runScheduleCheck(');
    assert.match(body, /isCatchUpRun\(fresh\.state\)\) logger\.info\('schedule', `schedule catch-up id=\$\{id\} missed=\$\{fresh\.state\.catchUpPending\}/);
    assert.ok(body.indexOf('scheduleRunsHere(fresh)') < body.indexOf('schedule catch-up'), 'still runner-gated');
  });

  test('run now: runner only, refused when paused / ended / expired / cap reached / already running, then a manual run', () => {
    const body = slice(MAIN, "ipcMain.handle('schedule:run-now'", '\n  });\n');
    assert.match(body, /if \(!scheduleRunsHere\(job\)\) return \{ ok: false/);
    assert.match(body, /if \(job\.state\.paused\) return \{ ok: false/);
    assert.match(body, /if \(scheduleTerminal\(job\.state, Date\.now\(\)\)\) return \{ ok: false/);
    assert.match(body, /if \(schedulesInFlight\.has\(id\)\) return \{ ok: false/);
    assert.match(body, /void runScheduledJob\(job, \{ manual: true \}\)/);
    const run = slice(MAIN, 'async function runScheduledJob(', 'function runScheduleCheck(');
    assert.match(run, /\(!opts\.manual && !isDue\(timingState\(fresh\.state\), Date\.now\(\)\)\)/, 'manual skips only the due check');
    assert.match(PRELOAD, /scheduleRunNow: \(id: string\) => ipcRenderer\.invoke\('schedule:run-now', id\)/);
  });

  test('resume from sleep checks the schedules right away (same rules as the tick)', () => {
    assert.match(MAIN, /powerMonitor\.on\('resume', \(\) => runDueSchedulesNow\('resume'\)\);/);
    const fn = slice(MAIN, 'function runDueSchedulesNow(', '\n  }\n');
    assert.match(fn, /\.filter\(scheduleRunsHere\)/);
    assert.match(fn, /!expireSchedule\(job, now\) && isDue\(job\.state, now\)/);
    assert.match(fn, /if \(quitPending\) return;/);
  });

  test('takeover dialog: missed-run notice + a default-checked "run once right away" checkbox wired to the choice', () => {
    const btn = slice(CHAT, 'className={`schedule-banner-takeover', '</button>');
    assert.match(btn, /const missed = catchUpNotice\(job, findLang\);/);
    assert.match(btn, /\.\.\.\(missed \? \{ checkbox: \{ label: t\('Run once right away'\), defaultChecked: true \} \} : \{\}\)/);
    assert.match(btn, /onConfirm: \(checked\) => \{\s*void onTakeOverSchedule\(job\.id, job\.defHash \|\| '', missed \? checked : true\)/);
    assert.ok(btn.indexOf('takeOverDetails(job') > 0, 'full task (checkCommand) still shown');
    assert.match(btn, /schedule-banner-takeover\$\{scheduleSummary\.elsewhere\.overdue \? ' urgent' : ''\}/, 'louder when overdue');
    assert.match(DIALOG, /run\?\.\(!!request\?\.checkbox && checked\)/);
    assert.match(DIALOG, /<input type="checkbox" checked=\{checked\}/);
  });

  test('runner card has "▶ Run once now"; not on other computers, ended or paused cards', () => {
    const at = CHAT.indexOf('className="schedule-banner-run-now"');
    assert.ok(at > 0, 'no run-now button');
    const guard = CHAT.slice(CHAT.lastIndexOf('{!scheduleSummary.elsewhere', at), at);
    assert.match(guard, /!scheduleSummary\.elsewhere && !scheduleSummary\.ended && !scheduleSummary\.paused && onRunScheduleNow/);
    assert.match(CHAT.slice(at, at + 500), /onRunScheduleNow\(scheduleSummary\.next!\.id\)/);
  });
});

describe('view: overdue hint and the catch-up notice', () => {
  const view = (over: Partial<ScheduleView> = {}): ScheduleView => ({
    id: 'j1', sessionId: 's1', prompt: 'p', describe: 'Every day at 08:30', runs: 6, maxRuns: 100, paused: false,
    lastRunAt: at(25, 20, 30), lastError: null, nextRunAt: at(26, 8, 30), runsHere: false, runnerName: 'kyn-desktop',
    runnerSeenAt: null, staleAfterMs: 3600_000, defHash: 'h',
    catchUp: { missed: 2, lastRunAt: at(25, 20, 30), firstMissedAt: at(26, 8, 30) }, ...over,
  });

  test('overdue: hours / minutes, not within 10 min, not when paused or running here', () => {
    assert.match(overdueText(view(), at(27, 10, 46), 'en')!, /Overdue by 26 h without running \(kyn-desktop may be off\)/);
    assert.match(overdueText(view(), at(26, 8, 55), 'en')!, /Overdue by 25 min/);
    assert.equal(overdueText(view(), at(26, 8, 35), 'en'), null);
    assert.equal(overdueText(view({ paused: true }), at(27, 10), 'en'), null);
    assert.equal(overdueText(view({ runsHere: true }), at(27, 10), 'en'), null);
    assert.match(sessionScheduleSummary([view()], at(27, 10, 46), 'en')!.elsewhere!.overdue!, /Overdue by 26 h/);
  });

  test('catch-up notice: missed N, last run, should-have-run; nothing when nothing was missed', () => {
    const text = catchUpNotice(view(), 'en')!;
    assert.match(text, /^Missed 2 time\(s\) \(last run .+, it should have run at .+\)\. After the takeover it runs once right away\.$/);
    assert.equal(catchUpNotice(view({ catchUp: null }), 'en'), null);
    assert.match(catchUpNotice(view({ catchUp: { missed: 1, lastRunAt: null, firstMissedAt: at(26, 9) } }), 'en')!, /last run never/);
  });
});

describe('card: a one-off whose catch-up was declined is not "paused"', () => {
  /** The same mapping main's schedule:list row does for a job that runs here. */
  function row(id: string, s: ScheduleState): ScheduleView {
    const n = nextRunAt(timingState(s));
    return {
      id, sessionId: s.sessionId, prompt: s.spec.prompt, describe: 'Once', runs: s.runs, maxRuns: s.spec.maxRuns,
      paused: s.paused, terminal: s.terminal, lastRunAt: s.lastRunAt, lastError: s.lastError,
      nextRunAt: n !== null && Number.isFinite(n) ? n : null, runsHere: true,
    };
  }
  const onceSpec: ScheduleSpec = { prompt: 'remind me', kind: 'once', everySec: 0, atEpoch: at(26, 9), maxRuns: 1 };
  const declined = takeOver({ ...createSchedule('s1', onceSpec, at(25, 9)), runner: 'devB', runnerChangedAt: at(25, 9) }, ME, at(27, 10), { catchUp: false });

  test('decline → list row → summary: not paused, says there is no automatic run, still targets the job (so "▶ Run once now" shows)', () => {
    const v = row('j1', declined);
    assert.equal(v.nextRunAt, null);
    const s = sessionScheduleSummary([v], at(27, 10, 1), 'en')!;
    assert.ok(s, 'the card is still there');
    assert.equal(s.paused, false, 'not shown as paused');
    assert.equal(s.next?.id, 'j1');
    assert.match(s.text, /No automatic run scheduled/);
    assert.doesNotMatch(s.text, /Paused/);
    assert.notEqual(s.short, 'Paused');
    /* the button's guard in ChatArea: !elsewhere && !ended && !paused && onRunScheduleNow */
    assert.equal(!s.elsewhere && !s.ended && !s.paused, true);
  });

  test('a scheduled job still wins as "next"; a really paused job is still "Paused"', () => {
    const daily = { ...createSchedule('s1', { prompt: 'p', kind: 'daily', everySec: 0, atTime: '08:30', maxRuns: 9 } as ScheduleSpec, at(26, 9)), lastRunAt: at(27, 8, 30) };
    const both = sessionScheduleSummary([row('j1', declined), { ...row('j2', daily), describe: 'Daily' }], at(27, 10), 'en')!;
    assert.equal(both.next?.id, 'j2');
    assert.equal(both.paused, false);
    const paused = sessionScheduleSummary([{ ...row('j2', daily), paused: true }], at(27, 10), 'en')!;
    assert.equal(paused.paused, true);
    assert.match(paused.text, /Paused/);
  });
});
