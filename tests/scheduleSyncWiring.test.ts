import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { endedElsewhereSummary, lastCheckText, sessionScheduleSummary, takeOverDetails, type ScheduleView } from '../src/renderer/scheduleView.ts';

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf-8');
const MAIN = read('../src/main/index.ts');
const CHAT = read('../src/renderer/components/ChatArea.tsx');
const PRELOAD = read('../src/main/preload.ts');

const fnBody = (src: string, start: string, end: string) => {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `missing ${start}`);
  return src.slice(at, src.indexOf(end, at + start.length));
};

describe('scheduler: whichever eligible computer is online runs it (lease)', () => {
  test('the ticker only considers jobs this computer is eligible for, then tries the lease', () => {
    const tick = fnBody(MAIN, 'const scheduleTicker = setInterval(', 'SCHEDULE_TICK_MS);');
    const filter = tick.indexOf('.filter(scheduleEligibleHere)');
    assert.ok(filter > 0, 'ticker does not check eligibility');
    assert.ok(filter < tick.indexOf('expireSchedule(job, now)'), 'eligibility checked before expiry');
    assert.ok(filter < tick.indexOf('isDue(job.state, now)'), 'eligibility checked before due');
    assert.match(tick, /if \(isDue\(job\.state, now\)\) void attemptScheduledJob\(job\);/);
  });

  test('eligibility = session here + definition confirmed here + (cross-device on, or created here); skips logged with the id', () => {
    const why = fnBody(MAIN, 'function scheduleIneligibleReason(', '\n}\n');
    assert.match(why, /if \(!rec\) return '会话不在本机';/);
    assert.match(why, /if \(!definitionApproved\(job\.state, scheduleStore\.readApprovedHash\(job\.id, os\.homedir\(\)\)\)\) return/);
    assert.match(why, /creatorOf\(job\.state\) !== scheduleMachine\(\)\.id && !isShared\(rec\)/);
    const el = fnBody(MAIN, 'function scheduleEligibleHere(', '\n}\n');
    assert.ok(el.includes("logger.info('schedule', `skip id=${job.id}"), 'skip not logged with the id');
  });

  test('attemptScheduledJob: session gate first, then attemptScheduleRun with the lease key, the bucket (or null = offline) and the real run', () => {
    const body = fnBody(MAIN, 'async function attemptScheduledJob(', '\n  /**\n   * **真的跑这一次**');
    const gate = body.indexOf('if (!scheduleOwnerAllows(id, job.state.sessionId)) return;');
    assert.ok(gate > 0 && gate < body.indexOf('attemptScheduleRun(id, {'), 'session checked before touching the lease');
    assert.match(body, /leaseRel\(job\.state\.sessionId, id\)/);
    assert.match(body, /bucket: ctx \? scheduleLeaseBucket\(ctx\.creds\) : null/);
    /* offline fallback (creator only): no bucket for the run → local accounting, no upload required */
    assert.match(body, /await runScheduledJob\(\{ id, state: st, updatedAt: Date\.now\(\) \}, \{ manual: opts\.manual, runFor, ctx: lease\.offline \? null : ctx \}\)/);
    assert.match(body, /every: \(ms, fn\) => \{ const t = setInterval\(fn, ms\); return \(\) => clearInterval\(t\); \}/, 'renewal timer');
    /* lost the lease / offline and not the creator: back off instead of retrying (credentials, lease read, log) every 20 s */
    assert.match(body, /if \(!opts\.manual && Date\.now\(\) < \(scheduleRetryAfter\.get\(id\) \?\? 0\)\) return;/);
    assert.match(body, /if \(result === 'held'\) scheduleRetryAfter\.set\(id, Date\.now\(\) \+ SCHEDULE_RETRY_HELD_MS\);/);
    assert.match(body, /else if \(result === 'offline-not-creator'\) scheduleRetryAfter\.set\(id, Date\.now\(\) \+ SCHEDULE_RETRY_OFFLINE_MS\);/);
  });

  test('the lease bucket uses conditional writes; no S3 / not cross-device / no creds → offline (creator only)', () => {
    const b = fnBody(MAIN, 'function scheduleLeaseBucket(', '\n}\n');
    assert.match(b, /putObjectIfEtag\(creds, key, Buffer\.from\(body, 'utf-8'\), 'application\/json', cond\)/);
    assert.match(b, /deleteObjectIf\(creds, key, etag\)/);
    const ctx = fnBody(MAIN, 'async function scheduleLeaseContext(', '\n}\n');
    assert.match(ctx, /if \(!cfg\.enabled \|\| !cfg\.bucket\) return null;/);
    assert.match(ctx, /if \(!rec \|\| !isShared\(rec\) \|\| !syncsSession\(cfg, rec\)\) return null;/);
    assert.match(ctx, /if \(r\.problem \|\| !r\.creds\) return null;/);
  });

  test('runScheduledJob: charge (with the planned slot) and publish BEFORE waking; a lost lease means no charge, no wake', () => {
    const body = fnBody(MAIN, 'async function runScheduledJob(', 'function runScheduleCheck(');
    const lost = body.indexOf('scheduleLeaseLost.get(id)?.()');
    assert.ok(lost > body.indexOf('runScheduleCheck(id, state)'), 'checked after the check command');
    assert.ok(lost < body.indexOf('const charged = recordRun('), 'checked before charging');
    const mark = body.indexOf('state = markRunBy(state, opts.runFor, scheduleMachine(), Date.now());');
    assert.ok(mark > 0 && mark < body.indexOf('const charged = recordRun('));
    const commit = body.indexOf('if (!(await commitScheduleCharge(id, beforeCharge, charged, opts))) return;');
    assert.ok(commit > body.indexOf('const charged = recordRun(') && commit < body.indexOf('wakeDispatcher.enqueue('), 'published (and confirmed) before waking');
    /* publish failed or lease lost → the charge is undone and nobody is woken */
    const c = fnBody(MAIN, 'async function commitScheduleCharge(', '\n  }\n');
    assert.match(c, /return commitCharge\(beforeCharge, \{/, 'the pure, tested commit / undo decision');
    assert.match(c, /offline: !opts\.ctx,/);
    assert.match(c, /lost: \(\) => !!scheduleLeaseLost\.get\(id\)\?\.\(\),/);
    assert.match(c, /publish: \(\) => publishScheduleState\(opts\.ctx, id,/);
    assert.match(c, /readCurrent: \(\) => scheduleStore\.readSchedule\(id, os\.homedir\(\)\)\?\.state \?\? null,/, 'undo starts from the current record');
    assert.match(c, /deleted: \(\) => !!scheduleStore\.readScheduleTombstones\(os\.homedir\(\)\)\[id\],/, 'deleted tasks are not written back');
    assert.match(fnBody(MAIN, 'async function publishScheduleState(', '\n}\n'), /return false;/, 'publish reports failure');
    /* after the (possibly long) wait for the session: lease lost → no more state writes for this run */
    const lostAt = body.indexOf('if (await scheduleLeaseLostAfterWake(id, opts, !!delivered.skipped, beforeCharge)) return;');
    assert.ok(lostAt > body.indexOf('wakeDispatcher.enqueue(') && lostAt < body.indexOf('if (delivered.skipped) {'), 'checked before the refund / final write');
  });

  test('"charged but not yet delivered": marked before waking, cleared on delivery; a lost-before-send run leaves it for the next computer', () => {
    const body = fnBody(MAIN, 'async function runScheduledJob(', 'function runScheduleCheck(');
    const mark = body.indexOf('if (opts.ctx) state = markPendingRun(state, beforeCharge, opts.runFor, scheduleMachine(), Date.now(), preCheck);');
    assert.ok(mark > 0 && mark < body.indexOf('const charged = recordRun('), 'the uploaded charge carries the note');
    /* the restore snapshot is taken BEFORE the check command (so a takeover is not blocked by this check's own time / fingerprint / achieved) */
    const pre = body.indexOf('const preCheck = scheduleStore.readSchedule(id, os.homedir())?.state ?? state;');
    assert.ok(pre > 0 && pre < body.indexOf('runScheduleCheck(id, state)'), 'snapshot before the check');
    assert.match(body, /const settled = \{ \.\.\.latest\.state, lastError: failure \?\? null, pendingRun: null \};/, 'delivered → note cleared (and published at the end)');
    const lost = fnBody(MAIN, 'async function scheduleLeaseLostAfterWake(', '\n  }\n');
    assert.match(lost, /if \(skipped\) \{[\s\S]{0,200}if \(cur && !deleted\) scheduleStore\.writeScheduleRaw\(id, cur\.pendingRun \? restorePending\(cur\) : undoCharge\(cur, beforeCharge, CHARGE_KEYS\), home\);/, 'not sent: undo only locally (same restore as the computer taking over)');
    assert.match(lost, /p\.by === scheduleMachine\(\)\.id && p\.runFor === opts\.runFor/, 'sent: confirm only our own unconfirmed charge');
    assert.match(lost, /putObjectIf\(opts\.ctx\.creds, key, [^\n]*\{ ifMatch: got\.etag \}\)/);
    const tick = fnBody(MAIN, 'const scheduleTicker = setInterval(', 'SCHEDULE_TICK_MS);');
    assert.match(tick, /else if \(pendingStale\(job\.state, now\)\) void attemptScheduledJob\(job\);/, 'a stale note makes this computer try even though it looks "not due"');
    const att = fnBody(MAIN, 'async function attemptScheduledJob(', '\n  /**\n   * **真的跑这一次**');
    assert.match(att, /persist: \(st\) => \{\s*if \(!scheduleStore\.readSchedule\(id, home\) \|\| scheduleStore\.readScheduleTombstones\(home\)\[id\]\) return;\s*scheduleStore\.writeScheduleRaw\(id, st, home\);/, 'never re-creates a deleted task');
  });

  test('the "not yet confirmed" note is written BEFORE the check command starts (bucket mode), and cleared when an unchanged check completes the run', () => {
    const body = fnBody(MAIN, 'async function runScheduledJob(', 'function runScheduleCheck(');
    const mark = body.indexOf('state = markCheckPending(id, state, preCheck, opts);');
    assert.ok(mark > body.indexOf('const preCheck = ') && mark < body.indexOf('runScheduleCheck(id, state)'), 'before the check writes its start time');
    const fn = fnBody(MAIN, 'function markCheckPending(', '\n  }\n');
    assert.match(fn, /if \(!opts\.ctx\) return state;/, 'offline fallback: no note');
    assert.match(fn, /markPendingRun\(state, preCheck, opts\.runFor, scheduleMachine\(\), Date\.now\(\), preCheck\)/);
    assert.match(fn, /scheduleStore\.writeScheduleRaw\(id, marked, os\.homedir\(\)\);/);
    const check = fnBody(MAIN, 'function runScheduleCheck(id: string, state: ScheduleState)', '\n  }\n');
    assert.match(check, /const marked = \{ \.\.\.markRunBy\(s, cur\.runFor, scheduleMachine\(\), Date\.now\(\)\), pendingRun: null \};/);
  });

  test('"sent" stage: uploaded right before the prompt is handed to the session; not sent if that upload fails', () => {
    const mark = fnBody(MAIN, 'async function scheduleMarkSent(', '\n}\n');
    assert.match(mark, /if \(!run\?\.ctx\) return null;/, 'offline fallback: nothing to upload');
    assert.match(mark, /if \(scheduleLeaseLost\.get\(id\)\?\.\(\)\) return 'lease-lost';/);
    assert.match(mark, /const sent = markSent\(cur, scheduleMachine\(\), Date\.now\(\)\);/, 'a newer state version (statusAt), see markSent');
    assert.match(mark, /if \(!\(await publishScheduleState\(run\.ctx, id, sent\)\) \|\| scheduleLeaseLost\.get\(id\)\?\.\(\)\) \{[\s\S]*return 'not-confirmed';/);
    const send = fnBody(MAIN, 'async function sendPromptOnce(', 'store.appendMessage(sessionId, {');
    assert.match(send, /if \(!attempt\) await onSendGate\(display, !!\(\(entry\.busy \|\| entry\.autonomous\) && !handoff\)\);/, 'not marked when it would bounce as busy');
    const gate = fnBody(MAIN, 'async function onSendGate(', '\n}\n');
    assert.match(gate, /if \(!display\?\.onSend \|\| bounce\) return;\s*const pre = display\.stillWanted\?\.\(\);\s*if \(pre\) throw new WakeSkipped\(pre\);\s*const blocked = await display\.onSend\(\);\s*if \(blocked\) throw new WakeSkipped\(blocked\);/, 'uploaded before the prompt is handed over');
    /* before the final re-gate (no await may sit between that and the hand-off, see sendPrep.test.ts) */
    assert.ok(send.indexOf('await onSendGate(display,') < send.indexOf("if (handoff?.kind === 'queued') regateQueuedHandoff(sessionId, entry);"));
    const deliver = fnBody(MAIN, 'wakeDeliver = async (item) => {', '\n  };\n');
    assert.match(deliver, /onSend: sentHook\(item\), stillWanted,/);
    const att = fnBody(MAIN, 'async function attemptScheduledJob(', '\n  /**\n   * **真的跑这一次**');
    assert.match(att, /scheduleActiveRun\.set\(id, \{ runFor, ctx: lease\.offline \? null : ctx \}\);/);
  });

  test('the queued wake itself is blocked once the lease is lost (send time), not only before queueing', () => {
    const fn = fnBody(MAIN, 'function scheduleNotEligibleHere(', '\n}\n');
    assert.match(fn, /if \(scheduleLeaseLost\.get\(id\)\?\.\(\)\) return 'lease-lost';/);
  });

  test('the unchanged-output path only counts as done once it is in the bucket', () => {
    const body = fnBody(MAIN, 'function runScheduleCheck(id: string, state: ScheduleState)', '\n  }\n');
    const skip = body.slice(body.indexOf('recordSkip: async (jobId, s) => {'));
    assert.match(skip, /await commitScheduleCharge\(jobId, before, marked, cur, MARK_KEYS\);/, 'undoes only the mark, same rules as a full run');
  });

  test('the check-command flow is told whether this computer still holds the run', () => {
    const body = fnBody(MAIN, 'function runScheduleCheck(id: string, state: ScheduleState)', '\n  }\n');
    assert.match(body, /stillRunsHere: \(jobId\) => \{ const j = scheduleStore\.readSchedule\(jobId, os\.homedir\(\)\); return !!j && !scheduleLeaseLost\.get\(jobId\)\?\.\(\) && scheduleEligibleHere\(j\); \}/);
    /* a check with unchanged output (no wake) still records the planned slot and publishes before the lease is released */
    const skip = body.slice(body.indexOf('recordSkip: async (jobId, s) => {'));
    assert.match(skip, /if \(!cur \|\| scheduleLeaseLost\.get\(jobId\)\?\.\(\)\) return;/);
    assert.match(skip, /markRunBy\(s, cur\.runFor, scheduleMachine\(\), Date\.now\(\)\)/);
    assert.match(skip, /await commitScheduleCharge\(jobId, before, marked, cur, MARK_KEYS\);/);
    const run = fnBody(MAIN, 'async function runScheduledJob(', 'function runScheduleCheck(');
    assert.match(run, /scheduleRunNow\.set\(id, \{ runFor: opts\.runFor, ctx: opts\.ctx \}\);\s*const checked = await runScheduleCheck\(id, state\)/);
  });

  test('a queued wake is re-checked right before it is sent (dispatcher + deliver)', () => {
    const stale = fnBody(MAIN, 'const wakeDispatcher = new WakeDispatcher({', '\n});\n');
    assert.match(stale, /isStale: \(item\) => \(item\.source === 'schedule' && item\.ref\s*\? scheduleDeliveryBlocker\([^\n]*\?\? scheduleNotEligibleHere\(item\.ref\)/);
    const deliver = fnBody(MAIN, 'wakeDeliver = async (item) => {', '\n  };\n');
    assert.match(deliver, /const stillWanted = \(\) => \(item\.source === 'schedule' && item\.ref\s*\? scheduleWakeBlocked\(item\.ref\)/);
    assert.match(fnBody(MAIN, 'function scheduleWakeBlocked(', '\n}\n'), /scheduleDeliveryBlocker\([^\n]*\?\? scheduleNotEligibleHere\(id\)/);
  });

  test('confirm (approve): checks the definition the user saw, records it, logs, and tries due runs', () => {
    const body = fnBody(MAIN, "ipcMain.handle('schedule:approve'", '\n  });\n');
    const check = body.indexOf('definitionHash(job.state) !== defHash');
    assert.ok(check > 0 && check < body.indexOf('scheduleStore.approveSchedule(id, defHash'));
    assert.match(body, /logger\.info\('schedule', `approve id=\$\{id\}/);
    assert.match(body, /runDueSchedulesNow\(/);
    assert.match(PRELOAD, /scheduleApprove: \(id: string, defHash: string\) => ipcRenderer\.invoke\('schedule:approve', id, defHash\)/);
    assert.doesNotMatch(MAIN, /ipcMain\.handle\('schedule:take-over'/, 'no takeover any more');
    assert.doesNotMatch(PRELOAD, /scheduleTakeOver/);
  });

  test('run now: any eligible computer, through the lease', () => {
    const body = fnBody(MAIN, "ipcMain.handle('schedule:run-now'", '\n  });\n');
    assert.match(body, /if \(!scheduleEligibleHere\(job\)\) return \{ ok: false/);
    assert.match(body, /void attemptScheduledJob\(job, \{ manual: true \}\)/);
  });

  test('startup and resume catch up missed runs through the same lease path', () => {
    const fn = fnBody(MAIN, 'function runDueSchedulesNow(', '\n  }\n');
    assert.match(fn, /\.filter\(scheduleEligibleHere\)/);
    assert.match(fn, /for \(const job of due\) void attemptScheduledJob\(job\);/);
    assert.match(MAIN, /powerMonitor\.on\('resume', \(\) => runDueSchedulesNow\('resume'\)\);/);
    assert.match(MAIN, /setTimeout\(\(\) => runDueSchedulesNow\('startup'\), 30_000\);/);
  });

  test('sync: definition changes are logged; task uploads are conditional (no stale overwrite); leases are read for display; markers stay separate', () => {
    const body = fnBody(MAIN, 'async function syncSchedulesWithBucket(', '\nlet schedulePushTimer');
    assert.match(body, /if \(a\.notes\.defChanged\) logger\.warn\('schedule', `sync: id=\$\{a\.id\} 的定义/);
    assert.match(body, /putObjectIf\(creds, u\.key, Buffer\.from\(u\.body, 'utf-8'\), 'application\/json', u\.etag \? \{ ifMatch: u\.etag \} : \{ ifNoneMatch: '\*' \}\)/);
    assert.match(body, /parseLeaseRel\(/);
    assert.match(body, /scheduleLeaseSeen\.set\(k\.id, lease\)/);
    assert.match(body, /key: objKey\(a\.sessionId, a\.id, true\), body: tombstoneBody\(/);
    assert.match(body, /collectBucketSchedules\(/);
    assert.match(body, /for \(const \[id, d\] of listed\.deleted\)/);
    assert.doesNotMatch(body, /pushed\) continue/, 'a pushed marker must not stop us from reading the bucket');
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
    assert.match(body, /getObjectWithEtag\(creds, keyFor\(prefix, l\.rel/);
    assert.match(body, /putObject\(creds, u\.key/);
    assert.match(body, /syncsSession\(cfg, rec\)/);
    assert.match(body, /store\.isAdvancedOnlySession\(sid\)/);
    assert.match(body, /parseRemoteSchedule\(/);
    /* pulled jobs are written raw: never approved, so never run here until the user confirms them */
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

describe('banner: who runs it, confirm before this computer joins', () => {
  test('no takeover button; a confirm button that asks first with the full task, then calls onApproveSchedule', () => {
    assert.doesNotMatch(CHAT, /schedule-banner-takeover/, 'takeover is gone');
    const at = CHAT.indexOf('className="schedule-banner-confirm"');
    assert.ok(at > 0, 'no confirm button');
    const btn = CHAT.slice(CHAT.lastIndexOf('{scheduleSummary.live?.needsConfirm', at), CHAT.indexOf('</button>', at));
    assert.match(btn, /scheduleSummary\.live\?\.needsConfirm && !scheduleSummary\.ended && onApproveSchedule/);
    const ask = btn.indexOf('setConfirm(');
    assert.ok(ask > 0, 'confirms without asking');
    assert.ok(btn.indexOf('takeOverDetails(job') > ask, 'full task shown');
    assert.ok(btn.indexOf('onApproveSchedule(job.id, job.defHash') > btn.indexOf('onConfirm:'), 'only after confirming');
  });

  test('run once now on any eligible computer; rows for "not confirmed", "running on X", overdue and "last run by X"', () => {
    const at = CHAT.indexOf('className="schedule-banner-run-now"');
    const guard = CHAT.slice(CHAT.lastIndexOf('{!scheduleSummary.ended', at), at);
    assert.match(guard, /!scheduleSummary\.ended && !scheduleSummary\.paused && \(scheduleSummary\.live\?\.canRun \?\? !scheduleSummary\.elsewhere\) && onRunScheduleNow/);
    assert.match(CHAT, /t\('🖥️ This computer has not confirmed this task, so it does not run here'\)/);
    assert.match(CHAT, /t\('🖥️ Running on \{machine\}', \{ machine: scheduleSummary\.live\.runningOn \}\)/);
    assert.match(CHAT, /scheduleSummary\.live\?\.lastRunBy && \(/);
  });

  const view = (over: Partial<ScheduleView> = {}): ScheduleView => ({
    id: 'j1', sessionId: 's1', prompt: 'line one\nline two', describe: 'Every 1 h', runs: 3, maxRuns: 10, paused: false,
    lastRunAt: 1_700_000_000_000, lastError: null, nextRunAt: 1_700_000_000_000 + 3600_000,
    until: 'build is green', checkCommand: 'node scripts/check.js --very-long-flag ' + 'x'.repeat(500),
    runsHere: false, canRun: true, runnerName: 'desk-b', lastRunBy: { name: 'desk-b', here: false }, defHash: 'h',
    ...over,
  });

  test('the confirmation text carries prompt, schedule, goal and the whole checkCommand', () => {
    const text = takeOverDetails(view(), 'en');
    assert.ok(text.includes('line one\nline two'));
    assert.ok(text.includes('Every 1 h'));
    assert.ok(text.includes('build is green'));
    assert.ok(text.includes(view().checkCommand!), 'checkCommand shown in full');
  });

  test('summary: last run by X, running on X, not confirmed, overdue with nobody online', () => {
    const now = 1_700_000_000_000 + 30 * 60_000;
    const s = sessionScheduleSummary([view()], now, 'en')!;
    assert.equal(s.elsewhere, null, 'live tasks have no "elsewhere" (that is the ended card)');
    assert.match(s.live!.lastRunBy!, /^🖥️ Last run by desk-b \(/);
    assert.equal(s.live!.canRun, true);
    assert.equal(s.live!.runningOn, null);
    assert.match(s.text, /Ran 3\/10/);
    assert.match(sessionScheduleSummary([view({ lastRunBy: { name: 'me', here: true } })], now, 'en')!.live!.lastRunBy!, /Last run on this computer/);
    assert.equal(sessionScheduleSummary([view({ runningOn: 'desk-b' })], now, 'en')!.live!.runningOn, 'desk-b');
    const unconfirmed = sessionScheduleSummary([view({ needsConfirm: true, canRun: false })], now, 'en')!;
    assert.equal(unconfirmed.live!.needsConfirm, true);
    assert.equal(unconfirmed.live!.canRun, false);
    const overdue = sessionScheduleSummary([view()], 1_700_000_000_000 + 5 * 3600_000, 'en')!;
    assert.match(overdue.live!.overdue!, /Overdue by 4 h; no online computer can run it/);
    assert.equal(sessionScheduleSummary([view({ runningOn: 'desk-b' })], 1_700_000_000_000 + 5 * 3600_000, 'en')!.live!.overdue, null, 'running somewhere: not overdue');
  });
});

describe('last check result: stored by the computer that ran it, synced, shown everywhere', () => {
  test('the card shows the last check: when, verdict, exit code and the output tail', () => {
    const v: ScheduleView = {
      id: 'j1', sessionId: 's1', prompt: 'p', describe: 'Every 1 h', runs: 2, maxRuns: null, paused: false,
      lastRunAt: 1_700_000_000_000, lastError: null, nextRunAt: null, until: 'green', checkCommand: 'node c.js',
      runsHere: false, runnerName: 'desk-b', defHash: 'h',
      lastCheck: { at: 1_700_000_000_000, result: 'unchanged', code: 1, output: '2 tests\n  failing' },
    };
    const s = sessionScheduleSummary([v], 1_700_000_000_000, 'en')!;
    assert.ok(s.live?.lastCheck);
    assert.match(s.live!.lastCheck!, /Last check .*not reached yet, output unchanged \(exit 1\) · 2 tests failing/);
    assert.match(lastCheckText({ at: 1, result: 'error', code: null, output: '' }, 'en')!, /failed \(did not finish\)$/);
    assert.equal(lastCheckText(null, 'en'), null);
  });

  test('wired: main lists it, the banner renders it', () => {
    assert.match(fnBody(MAIN, 'function scheduleListRow(', '\n  }\n'), /lastCheck: job\.state\.lastCheck \?\? null,/);
    assert.match(CHAT, /scheduleSummary\.live\?\.lastCheck && \(/);
    assert.match(CHAT, /scheduleSummary\.elsewhere\?\.lastCheck && \(/, 'the ended card keeps it too');
  });
});

describe('a job that ended on another computer keeps a card here (for 30 min after it ended)', () => {
  /* 第 11 轮起「已结束」卡只是结束后 30 分钟内的短暂提示：这几条都是刚结束 1 分钟时的样子 */
  const SOON = { now: 1_700_000_000_000 + 60_000 };
  const base: ScheduleView = {
    id: 'j1', sessionId: 's1', prompt: 'p', describe: 'Every 1 h', runs: 5, maxRuns: null, paused: false,
    lastRunAt: 1_700_000_000_000, lastError: null, nextRunAt: null, until: 'green', checkCommand: 'node c.js',
    runsHere: false, runnerName: 'desk-b', runnerSeenAt: null, staleAfterMs: 3600_000, defHash: 'h',
    terminal: 'achieved', endedText: 'Scheduled task ended: goal reached (Every 1 h, ran 5 time(s))',
    lastCheck: { at: 1_700_000_000_000, result: 'achieved', code: 0, output: 'all green' },
    endedAt: 1_700_000_000_000,
  };

  test('achieved on the runner: the live summary is gone, the ended card shows machine, runs, reason and final check', () => {
    assert.equal(sessionScheduleSummary([base], 1_700_000_000_000, 'en'), null, 'not live any more');
    const s = endedElsewhereSummary([base], 'en', SOON)!;
    assert.ok(s, 'the card stays');
    assert.equal(s.ended, base.endedText);
    assert.match(s.text, /goal reached .*ran 5 time/);
    assert.equal(s.elsewhere?.name, 'desk-b');
    assert.match(s.elsewhere!.lastCheck!, /goal reached \(exit 0\) · all green/);
    assert.equal(s.next?.id, 'j1', 'delete still targets it');
  });

  test('expired / exhausted also stay; ended jobs that ran HERE do not get the card; a live job takes precedence', () => {
    assert.ok(endedElsewhereSummary([{ ...base, terminal: 'expired', endedText: 'ended: expired' }], 'en', SOON));
    assert.ok(endedElsewhereSummary([{ ...base, terminal: null, maxRuns: 5, runs: 5, endedText: null }], 'en', SOON)?.ended, 'run cap reached');
    assert.equal(endedElsewhereSummary([{ ...base, runsHere: true }], 'en', SOON), null);
    assert.equal(endedElsewhereSummary([{ ...base, terminal: null, endedText: null }], 'en', SOON), null, 'still live: not an ended card');
  });

  test('wired: main sends the ended sentence; the banner falls back to it; run controls are hidden on an ended card', () => {
    assert.match(fnBody(MAIN, 'function scheduleListRow(', '\n  }\n'), /endedText: \(\(\) => \{ const ended = scheduleTerminal\(job\.state\); return ended \? scheduleEndedText\(job\.state, ended\) : null; \}\)\(\),/);
    const APP = read('../src/renderer/App.tsx');
    assert.match(APP, /scheduleSummaryFor\(sid\) \?\? endedElsewhereSummary\(/);
    assert.match(APP, /scheduleSummary=\{scheduleBannerFor\(sid\)\}/);
    assert.match(CHAT, /\{!scheduleSummary\.ended && \(\s*<button\s+className="schedule-banner-pause"/);
    assert.match(CHAT, /scheduleSummary\.expiresAt !== null && !scheduleSummary\.ended/);
    /* 第 12 轮起没有「接管」了；「确认」按钮同样不出现在已结束卡上 */
    assert.match(CHAT, /scheduleSummary\.live\?\.needsConfirm && !scheduleSummary\.ended && onApproveSchedule/);
  });
});
