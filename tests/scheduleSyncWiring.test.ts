import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { endedElsewhereSummary, lastCheckText, runnerOfflineHours, sessionScheduleSummary, takeOverDetails, type ScheduleView } from '../src/renderer/scheduleView.ts';

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf-8');
const MAIN = read('../src/main/index.ts');
const CHAT = read('../src/renderer/components/ChatArea.tsx');
const PRELOAD = read('../src/main/preload.ts');

const fnBody = (src: string, start: string, end: string) => {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `missing ${start}`);
  return src.slice(at, src.indexOf(end, at + start.length));
};

describe('scheduler: only the runner runs it', () => {
  test('the ticker drops jobs that do not run here before anything is scheduled', () => {
    const tick = fnBody(MAIN, 'const scheduleTicker = setInterval(', 'SCHEDULE_TICK_MS);');
    const filter = tick.indexOf('.filter(scheduleRunsHere)');
    assert.ok(filter > 0, 'ticker does not check the runner');
    assert.ok(filter < tick.indexOf('expireSchedule(job, now)'), 'runner checked before expiry');
    assert.ok(filter < tick.indexOf('isDue(job.state, now)'), 'runner checked before due');
  });

  test('runScheduledJob re-checks the runner (and the takeover anchor) before the session gate and checkCommand', () => {
    const body = fnBody(MAIN, 'async function runScheduledJob(', 'function runScheduleCheck(');
    const gate = body.indexOf('scheduleRunsHere(fresh)');
    assert.ok(gate > 0);
    assert.ok(gate < body.indexOf('if (!scheduleOwnerAllows(id, state.sessionId)) return;'));
    assert.ok(gate < body.indexOf('runScheduleCheck(id, state)'));
    assert.match(body, /isDue\(timingState\(fresh\.state\), Date\.now\(\)\)/);
  });

  test('scheduleRunsHere = canRunHere(runner, locally approved definition) and logs the skip with id and runner', () => {
    const body = fnBody(MAIN, 'function scheduleRunsHere(', '\n}\n');
    assert.match(body, /canRunHere\(job\.state, me, scheduleStore\.readApprovedHash\(job\.id, os\.homedir\(\)\)\)/);
    assert.ok(body.includes("logger.info('schedule', `skip id=${job.id}"), 'skip not logged with the id');
    assert.ok(body.includes('runner=${job.state.runner'), 'skip not logged with the runner');
  });

  test('take-over: checks the definition the user saw, approves it, logs id + runner, pushes', () => {
    const body = fnBody(MAIN, "ipcMain.handle('schedule:take-over'", '\n  });\n');
    const check = body.indexOf('definitionHash(job.state) !== defHash');
    assert.ok(check > 0 && check < body.indexOf('takeOver(job.state'));
    assert.match(body, /scheduleStore\.approveSchedule\(id, definitionHash\(state\)/);
    assert.match(body, /logger\.info\('schedule', `takeover id=\$\{id\}[^`]*runner=/);
    assert.match(PRELOAD, /scheduleTakeOver: \(id: string, defHash: string\) => ipcRenderer\.invoke\('schedule:take-over', id, defHash\)/);
  });

  test('a queued wake is re-checked against the runner right before it is sent (dispatcher + deliver)', () => {
    const stale = fnBody(MAIN, 'const wakeDispatcher = new WakeDispatcher({', '\n});\n');
    assert.match(stale, /isStale: \(item\) => \(item\.source === 'schedule' && item\.ref\s*\? scheduleDeliveryBlocker\([^\n]*\?\? scheduleNotRunnerHere\(item\.ref\)/);
    const deliver = fnBody(MAIN, 'wakeDeliver = async (item) => {', '\n  };\n');
    assert.match(deliver, /const stillWanted = \(\) => \(item\.source === 'schedule' && item\.ref\s*\? scheduleWakeBlocked\(item\.ref\)/);
    assert.match(fnBody(MAIN, 'function scheduleWakeBlocked(', '\n}\n'), /scheduleDeliveryBlocker\([^\n]*\?\? scheduleNotRunnerHere\(id\)/);
    const helper = fnBody(MAIN, 'function scheduleNotRunnerHere(', '\n}\n');
    assert.match(helper, /return job && !scheduleRunsHere\(job\) \? 'not-runner' : null;/);
  });

  test('when the check command returns after a hand-over: no charge, no wake', () => {
    const body = fnBody(MAIN, 'async function runScheduledJob(', 'function runScheduleCheck(');
    const recheck = body.indexOf('if (!latestJob || !scheduleRunsHere(latestJob))');
    assert.ok(recheck > body.indexOf('runScheduleCheck(id, state)'), 're-checked after the check command');
    assert.ok(recheck < body.indexOf('const charged = recordRun('), 're-checked before charging');
    assert.ok(recheck < body.indexOf('wakeDispatcher.enqueue('), 're-checked before waking');
  });

  test('the check-command flow is told whether this computer is still the runner', () => {
    const body = fnBody(MAIN, 'function runScheduleCheck(id: string, state: ScheduleState)', '\n  }\n');
    assert.match(body, /stillRunsHere: \(jobId\) => \{ const j = scheduleStore\.readSchedule\(jobId, os\.homedir\(\)\); return !!j && scheduleRunsHere\(j\); \}/);
  });

  test('losing the runner in a sync drops the queued wake', () => {
    const body = fnBody(MAIN, 'async function syncSchedulesWithBucket(', '\nlet schedulePushTimer');
    assert.match(body, /if \(a\.notes\.lostTo\) \{\s*wakeDispatcher\.dropRef\(a\.id, 'handed over'\)/);
  });

  test('deletion markers go to their own object, and a marker in the listing wins over the live object', () => {
    const body = fnBody(MAIN, 'async function syncSchedulesWithBucket(', '\nlet schedulePushTimer');
    assert.match(body, /key: objKey\(a\.sessionId, a\.id, true\), body: tombstoneBody\(/);
    assert.match(body, /collectBucketSchedules\(/);
    assert.match(body, /for \(const \[id, d\] of listed\.deleted\)/);
    assert.doesNotMatch(body, /pushed\) continue/, 'a pushed marker must not stop us from reading the bucket');
  });

  test('hand-over (lost the runner) is logged with id and runner and told to the user', () => {
    const body = fnBody(MAIN, 'async function syncSchedulesWithBucket(', '\nlet schedulePushTimer');
    assert.match(body, /if \(a\.notes\.lostTo\) \{\s*wakeDispatcher\.dropRef\([^\n]*\n\s*logger\.info\('schedule', `handover: id=\$\{a\.id\}[^`]*runner=/);
    assert.match(body, /sessionNotice\(a\.state\.sessionId/);
  });
});

describe('s3: schedules are uploaded, pulled and restored', () => {
  test('the regular sync includes schedules', () => {
    const body = fnBody(MAIN, 'async function runS3Sync(', '\nfunction rescheduleS3Sync');
    assert.match(body, /await syncSchedulesWithBucket\(creds!, cfg\.prefix, \{ upload: true \}\)/);
  });

  test('syncSchedulesWithBucket lists, downloads and uploads under schedules/, scope by syncsSession, skips advanced', () => {
    const body = fnBody(MAIN, 'async function syncSchedulesWithBucket(', '\nlet schedulePushTimer');
    assert.match(body, /listObjects\(creds, `\$\{keyFor\(prefix, root\)\}\/`\)/);
    assert.match(body, /getObjectIfExists\(creds, keyFor\(prefix, l\.rel/);
    assert.match(body, /putObject\(creds, u\.key/);
    assert.match(body, /syncsSession\(cfg, rec\)/);
    assert.match(body, /store\.isAdvancedOnlySession\(sid\)/);
    assert.match(body, /parseRemoteSchedule\(/);
    /* pulled jobs are written raw: never approved, so never run without a takeover */
    assert.match(body, /scheduleStore\.writeScheduleRaw\(a\.id, a\.state, home\)/);
    assert.doesNotMatch(body, /approveSchedule/);
  });

  test('s3:restore and the cloud-only download pull the session\'s schedules (pull only)', () => {
    const restore = fnBody(MAIN, "ipcMain.handle('s3:restore'", '\n  });\n');
    assert.match(restore, /syncSchedulesWithBucket\(creds!, cfg\.prefix, \{ only: sessionId, upload: false \}\)/);
    const offload = fnBody(MAIN, 'async function offloadRestoreImpl(', '\n}\n');
    assert.match(offload, /syncSchedulesWithBucket\(creds!, [\s\S]{0,120}\{ only: id, upload: false \}\)/);
  });
});

describe('banner on a computer that does not run the job', () => {
  test('a take-over button that asks first, showing the full task, then calls onTakeOverSchedule', () => {
    const at = CHAT.indexOf('className="schedule-banner-takeover"');
    assert.ok(at > 0, 'no take-over button');
    const btn = CHAT.slice(at, CHAT.indexOf('</button>', at));
    const ask = btn.indexOf('setConfirm(');
    assert.ok(ask > 0, 'takes over without asking');
    assert.ok(btn.indexOf('takeOverDetails(job') > ask);
    assert.ok(btn.indexOf('onConfirm:') > ask);
    assert.ok(btn.indexOf('onTakeOverSchedule(job.id, job.defHash') > btn.indexOf('onConfirm:'), 'only after confirming');
  });

  const view = (over: Partial<ScheduleView> = {}): ScheduleView => ({
    id: 'j1', sessionId: 's1', prompt: 'line one\nline two', describe: 'Every 1 h', runs: 3, maxRuns: 10, paused: false,
    lastRunAt: 1_700_000_000_000, lastError: null, nextRunAt: 1_700_000_000_000 + 3600_000,
    until: 'build is green', checkCommand: 'node scripts/check.js --very-long-flag ' + 'x'.repeat(500),
    runsHere: false, runnerName: 'desk-b', runnerSeenAt: 1_700_000_000_000, staleAfterMs: 3600_000, defHash: 'h',
    ...over,
  });

  test('the confirmation text carries prompt, schedule, goal and the whole checkCommand', () => {
    const text = takeOverDetails(view(), 'en');
    assert.ok(text.includes('line one\nline two'));
    assert.ok(text.includes('Every 1 h'));
    assert.ok(text.includes('build is green'));
    assert.ok(text.includes(view().checkCommand!), 'checkCommand shown in full');
  });

  test('summary: where it runs, and the offline hint after the stale window', () => {
    const now = 1_700_000_000_000 + 30 * 60_000;
    const fresh = sessionScheduleSummary([view()], now, 'en')!;
    assert.deepEqual(fresh.elsewhere, { name: 'desk-b', needsConfirm: false, offlineHours: null, lastCheck: null });
    assert.match(fresh.text, /Ran 3\/10/);
    assert.match(fresh.text, /Last run/);
    const later = sessionScheduleSummary([view()], 1_700_000_000_000 + 5 * 3600_000, 'en')!;
    assert.equal(later.elsewhere?.offlineHours, 5);
    assert.equal(sessionScheduleSummary([view({ runsHere: true })], now, 'en')!.elsewhere, null);
    assert.equal(sessionScheduleSummary([view({ needsConfirm: true })], now, 'en')!.elsewhere?.needsConfirm, true);
  });

  test('runnerOfflineHours', () => {
    assert.equal(runnerOfflineHours(null, 10, 5), null);
    assert.equal(runnerOfflineHours(0, 3600_000, 7200_000), null);
    assert.equal(runnerOfflineHours(0, 3 * 3600_000, 3600_000), 3);
  });
});

describe('last check result: stored by the runner, synced, shown on the other computers', () => {
  test('the card on a non-runner shows the last check: when, verdict, exit code and the output tail', () => {
    const v: ScheduleView = {
      id: 'j1', sessionId: 's1', prompt: 'p', describe: 'Every 1 h', runs: 2, maxRuns: null, paused: false,
      lastRunAt: 1_700_000_000_000, lastError: null, nextRunAt: null, until: 'green', checkCommand: 'node c.js',
      runsHere: false, runnerName: 'desk-b', runnerSeenAt: null, staleAfterMs: 3600_000, defHash: 'h',
      lastCheck: { at: 1_700_000_000_000, result: 'unchanged', code: 1, output: '2 tests\n  failing' },
    };
    const s = sessionScheduleSummary([v], 1_700_000_000_000, 'en')!;
    assert.ok(s.elsewhere?.lastCheck);
    assert.match(s.elsewhere!.lastCheck!, /Last check .*not reached yet, output unchanged \(exit 1\) · 2 tests failing/);
    assert.equal(sessionScheduleSummary([{ ...v, runsHere: true }], 1_700_000_000_000, 'en')!.elsewhere, null);
    assert.match(lastCheckText({ at: 1, result: 'error', code: null, output: '' }, 'en')!, /failed \(did not finish\)$/);
    assert.equal(lastCheckText(null, 'en'), null);
  });

  test('wired: main lists it, the banner renders it', () => {
    assert.match(fnBody(MAIN, 'function scheduleListRow(', '\n  }\n'), /lastCheck: job\.state\.lastCheck \?\? null,/);
    assert.match(CHAT, /scheduleSummary\.elsewhere\?\.lastCheck && \(/);
  });
});

describe('a job that ended on another computer keeps a card here', () => {
  const base: ScheduleView = {
    id: 'j1', sessionId: 's1', prompt: 'p', describe: 'Every 1 h', runs: 5, maxRuns: null, paused: false,
    lastRunAt: 1_700_000_000_000, lastError: null, nextRunAt: null, until: 'green', checkCommand: 'node c.js',
    runsHere: false, runnerName: 'desk-b', runnerSeenAt: null, staleAfterMs: 3600_000, defHash: 'h',
    terminal: 'achieved', endedText: 'Scheduled task ended: goal reached (Every 1 h, ran 5 time(s))',
    lastCheck: { at: 1_700_000_000_000, result: 'achieved', code: 0, output: 'all green' },
  };

  test('achieved on the runner: the live summary is gone, the ended card shows machine, runs, reason and final check', () => {
    assert.equal(sessionScheduleSummary([base], 1_700_000_000_000, 'en'), null, 'not live any more');
    const s = endedElsewhereSummary([base], 'en')!;
    assert.ok(s, 'the card stays');
    assert.equal(s.ended, base.endedText);
    assert.match(s.text, /goal reached .*ran 5 time/);
    assert.equal(s.elsewhere?.name, 'desk-b');
    assert.match(s.elsewhere!.lastCheck!, /goal reached \(exit 0\) · all green/);
    assert.equal(s.next?.id, 'j1', 'delete still targets it');
  });

  test('expired / exhausted also stay; ended jobs that ran HERE do not get the card; a live job takes precedence', () => {
    assert.ok(endedElsewhereSummary([{ ...base, terminal: 'expired', endedText: 'ended: expired' }], 'en'));
    assert.ok(endedElsewhereSummary([{ ...base, terminal: null, maxRuns: 5, runs: 5, endedText: null }], 'en')?.ended, 'run cap reached');
    assert.equal(endedElsewhereSummary([{ ...base, runsHere: true }], 'en'), null);
    assert.equal(endedElsewhereSummary([{ ...base, terminal: null, endedText: null }], 'en'), null, 'still live: not an ended card');
  });

  test('wired: main sends the ended sentence; the banner falls back to it; run controls are hidden on an ended card', () => {
    assert.match(fnBody(MAIN, 'function scheduleListRow(', '\n  }\n'), /endedText: \(\(\) => \{ const ended = scheduleTerminal\(job\.state\); return ended \? scheduleEndedText\(job\.state, ended\) : null; \}\)\(\),/);
    const APP = read('../src/renderer/App.tsx');
    assert.match(APP, /scheduleSummaryFor\(sid\) \?\? endedElsewhereSummary\(/);
    assert.match(APP, /scheduleSummary=\{scheduleBannerFor\(sid\)\}/);
    assert.match(CHAT, /\{!scheduleSummary\.ended && \(\s*<button\s+className="schedule-banner-pause"/);
    assert.match(CHAT, /scheduleSummary\.expiresAt !== null && !scheduleSummary\.ended/);
    assert.match(CHAT, /scheduleSummary\.elsewhere && !scheduleSummary\.ended && onTakeOverSchedule/);
  });
});
