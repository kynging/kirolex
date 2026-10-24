/**
 * DURABLE LOOP RUNS: the round counter, owned by main and written to disk.
 *
 * The problem this fixes. `LoopRun` was deliberately built to be JSON-serializable, but
 * the live copy lived in the renderer's `loopsRef` — so the counter existed only inside
 * one window. Closing that window, or reloading it, reset the count to zero. A loop
 * declared "at most 20 rounds" therefore had no durable budget at all: every restart
 * handed it a fresh 20, which is precisely the unbounded-loop failure the round cap
 * exists to prevent.
 *
 * The four properties a loop needs to be called durable (Orkes/Conductor's list) are:
 *
 *   1. the counter is owned by the runtime, not the process   <- this file
 *   2. every round is checkpointed before the next begins     <- this file
 *   3. iteration boundaries are idempotent                   <- this file (the ledger) + loopDriver
 *   4. termination is explicit                                <- already in loopMachine
 *
 * `beginRound` delivers 1 and 2 together, and the order matters: the round is charged
 * and FLUSHED before it is handed back to be sent. Charging on completion instead would
 * mean a process that dies mid-round forgets it paid — the shape of a crash loop that
 * bills a model turn per restart, forever.
 *
 * WHAT THIS IS NOT. It is not the loop driver -- that is `loopDriver.ts`, also in main. This
 * file owns what must not be lost: the count, the budget decision, the iteration ledger
 * (`tryStartRound` / `commitRound`) and the record of why a run ended.
 *
 * `home` is a PARAMETER for the same reason as in flowStore: a module that reads
 * `os.homedir()` internally can only be tested by writing into the user's real data.
 */

import fs from 'fs';
import path from 'path';
import { tr } from './uiText.ts';
import { loopRoundMessageId } from './loopMachine.ts';

/** Structurally `LoopRun` from the renderer's loopMachine, kept as a loose shape on
 *  purpose. main's tsconfig pins `rootDir: ./src/main`, so importing the renderer's
 *  type would move the emit layout; and this module owns the COUNTER and the file, not
 *  the machine's semantics. The fields it actually reads are pinned by the tests. */
export interface StoredLoopRun {
  spec: {
    everySec?: number;
    stop: {
      maxIterations: number;
      maxWallClockSec?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  sessionId: string;
  iteration: number;
  startedAt: number;
  terminal: string | null;
  [key: string]: unknown;
}

interface Envelope {
  run: StoredLoopRun;
  updatedAt: number;
}

/**
 * 这条会话的循环文件**不归调用方管**（标准版里 = KiroLex Advanced 的会话，判据在 `advancedOnly.ts`，
 * 由 index.ts 传 `store.isAdvancedOnlySession` 进来）。是的话：写入抛错、记轮次拒绝、清除跳过 ——
 * 已有的文件字节不变，没有的也不新建。不传就是老行为。
 */
export type Protected = (sessionId: string) => boolean;

function loopDir(home: string): string {
  return path.join(home, '.kirolex', 'loop-runs');
}

export function loopRunPath(sessionId: string, home: string): string {
  // One file per session: a chat has at most one loop, and a new loop supersedes the
  // old one (`superseded`), so the session id is the natural key.
  return path.join(loopDir(home), `${encodeURIComponent(sessionId)}.json`);
}

/** Atomic write: temp + rename, as everywhere else in this codebase. A partially
 *  written counter is worse than none — it would read as a smaller number and hand the
 *  loop rounds it had already spent. */
export function writeLoop(sessionId: string, run: StoredLoopRun, home: string, isProtected?: Protected): void {
  if (isProtected?.(sessionId)) throw new Error(tr('This session belongs to KiroLex Advanced; the standard edition does not modify it.'));
  const dir = loopDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = loopRunPath(sessionId, home);
  const tmp = `${file}.tmp`;
  const envelope: Envelope = { run, updatedAt: Date.now() };
  fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/** Null when absent or unparseable. A truncated record must NOT present as a fresh
 *  loop at iteration 0: that would restart a run which had already spent its budget. */
export function readLoop(sessionId: string, home: string): StoredLoopRun | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(loopRunPath(sessionId, home), 'utf-8')) as Envelope;
    if (!parsed?.run || typeof parsed.run.iteration !== 'number' || !parsed.run.spec?.stop) return null;
    return parsed.run;
  } catch {
    return null;
  }
}

/**
 * Charge one round and flush it, or refuse.
 *
 * This is `beginIteration` from the state machine, made durable: the same two budget
 * checks, but against the PERSISTED counter and start time, and with the result written
 * to disk before it is returned. The terminal is persisted too, so the reason a run
 * ended is not lost with the process that decided it.
 */
export function beginRound(
  sessionId: string,
  home: string,
  now: number,
  isProtected?: Protected,
): { run: StoredLoopRun | null; terminal: string | null; error?: string } {
  if (isProtected?.(sessionId)) {
    return { run: null, terminal: null, error: tr('This session belongs to KiroLex Advanced; the standard edition does not modify it.') };
  }
  const run = readLoop(sessionId, home);
  if (!run) return { run: null, terminal: null, error: tr('No loop record found for this session') };
  // Already over: report the recorded reason rather than inventing a new one.
  if (run.terminal) return { run, terminal: run.terminal };

  const settle = (terminal: string) => {
    const ended = { ...run, terminal };
    writeLoop(sessionId, ended, home);
    return { run: ended, terminal };
  };

  if (run.iteration >= run.spec.stop.maxIterations) return settle('exhausted');
  const budget = run.spec.stop.maxWallClockSec;
  if (budget && now - run.startedAt >= budget * 1000) return settle('exhausted');

  // Charge, then FLUSH, then hand back. A round that is only recorded once it finishes
  // is a round a killed process does not know it paid for.
  const charged = { ...run, iteration: run.iteration + 1 };
  writeLoop(sessionId, charged, home);
  return { run: charged, terminal: null };
}

/** The "started" half of the iteration ledger (§4 property 3): which round was handed to
 *  the backend, under which message id, and when. Cleared by `commitRound`. */
export interface LoopInFlight {
  iteration: number;
  messageId: string;
  at: number;
}

/** The message id round `iteration` of this run is sent under. DETERMINISTIC on purpose:
 *  after a crash the ledger finds the round in the transcript by this id, and a re-send
 *  reuses it so `promptDedupe` neither appends a second user message nor re-runs a round
 *  that already answered. `startedAt` keeps two loops on the same chat apart. */
export function roundMessageId(run: Pick<StoredLoopRun, 'startedAt'>, iteration: number): string {
  return loopRoundMessageId(run, iteration);
}

/**
 * `beginRound` + the ledger's TryStart, in ONE atomic write.
 *
 * Two writes ("charge", then "mark in flight") would leave a window where a crash records
 * a round as paid for without any trace of whether it was sent -- the next start would
 * charge another round for the same work. Written together, every charged round either
 * has its `inFlight` entry or has been committed.
 */
export function tryStartRound(
  sessionId: string,
  home: string,
  now: number,
  isProtected?: Protected,
  /** Fields the caller needs written in the SAME write (e.g. the trigger event this round
   *  consumes): split into a second write, a crash in between would replay the event. */
  extra?: Record<string, unknown>,
): { run: StoredLoopRun | null; terminal: string | null; inFlight?: LoopInFlight; error?: string } {
  if (isProtected?.(sessionId)) {
    return { run: null, terminal: null, error: tr('This session belongs to KiroLex Advanced; the standard edition does not modify it.') };
  }
  const run = readLoop(sessionId, home);
  if (!run) return { run: null, terminal: null, error: tr('No loop record found for this session') };
  if (run.terminal) return { run, terminal: run.terminal };
  // A round already in flight is never charged twice: hand back the SAME round.
  const open = run.inFlight as LoopInFlight | null | undefined;
  if (open) return { run, terminal: null, inFlight: open };

  const settle = (terminal: string) => {
    const ended = { ...run, terminal };
    writeLoop(sessionId, ended, home);
    return { run: ended, terminal };
  };
  if (run.iteration >= run.spec.stop.maxIterations) return settle('exhausted');
  const budget = run.spec.stop.maxWallClockSec;
  if (budget && now - run.startedAt >= budget * 1000) return settle('exhausted');

  const iteration = run.iteration + 1;
  const inFlight: LoopInFlight = { iteration, messageId: roundMessageId(run, iteration), at: now };
  const charged = { ...run, ...(extra || {}), iteration, inFlight, lastRoundAt: now };
  writeLoop(sessionId, charged, home);
  return { run: charged, terminal: null, inFlight };
}

/** The "completed" half of the ledger: the round landed, so the next step is to verify
 *  it. Only clears the entry it was given -- a stale commit cannot close a newer round. */
export function commitRound(sessionId: string, home: string, messageId: string, now: number): StoredLoopRun | null {
  const run = readLoop(sessionId, home);
  if (!run) return null;
  const open = run.inFlight as LoopInFlight | null | undefined;
  if (!open || open.messageId !== messageId) return run;
  const committed = { ...run, inFlight: null, phase: 'verify', nextAt: now, committedIteration: open.iteration };
  writeLoop(sessionId, committed, home);
  return committed;
}

/** Every loop still running. The way to find a loop that was in flight when the app
 *  died — without it, an orphaned record leaves a session looking busy forever. */
export function listLiveLoops(home: string): StoredLoopRun[] {
  let names: string[];
  try { names = fs.readdirSync(loopDir(home)); } catch { return []; }
  const out: StoredLoopRun[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const run = readLoop(decodeURIComponent(name.slice(0, -'.json'.length)), home);
    if (run && !run.terminal) out.push(run);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

export function clearLoop(sessionId: string, home: string, isProtected?: Protected): void {
  if (isProtected?.(sessionId)) return;
  try { fs.rmSync(loopRunPath(sessionId, home), { force: true }); } catch { /* already gone */ }
}
