/**
 * THE LOOP DRIVER, in main. Decides the next round, sends it, waits for it, verifies it.
 *
 * It used to be the renderer's job (a `setTimeout` in `useAcp`), which is why a window
 * reload interrupted a running loop and why nothing time- or event-triggered could exist:
 * the thing deciding "now run round 5" lived and died with the window. Here it lives with
 * the executors, the schedule ticker and the wake queue; the renderer only mirrors the
 * live list (`loop:changed`) and relays Stop. Design: docs/loop-engineering-notes.md §13.
 *
 * PURE in the codebase's sense: no electron, no `os.homedir()`, no timers of its own. Every
 * effect (send a round, run the check, read the transcript, write into the chat, tell the
 * window) is injected by index.ts, so the whole state machine runs under `node --test`.
 *
 * DURABILITY. Everything the driver needs to continue is in `loop-runs/<sid>.json`: the
 * phase, when the next step is due, and the iteration ledger. In-memory state is only
 * "which sessions am I in the middle of stepping right now" (`active`), so a fresh driver
 * over the same files -- i.e. KiroLex restarted -- picks every loop up where it stood.
 *
 * IDEMPOTENT ITERATION BOUNDARIES (§4 property 3). A round is charged and marked in flight
 * in ONE write (`loopStore.tryStartRound`), sent under a deterministic message id, and
 * committed once the send returns. An in-flight entry that is not this process's own is
 * resolved against the transcript (`promptDedupe.messageIdStatus`):
 *
 *   answered            -> it landed: commit, verify, never re-send
 *   absent / unanswered -> the model never started it: re-send the SAME round, uncharged
 *   started             -> IN DOUBT: it did something and did not finish. Stop and say so.
 *                          Re-sending could repeat side effects nothing can take back.
 */

import {
  advance,
  createRun,
  endWith,
  nextPromptText,
  noEvidenceVerdict,
  shouldReportTerminal,
  terminalSummary,
  TOLERATED_RETRY_FLOOR_SEC,
  validateSpec,
  verdictFromCommand,
  verdictRound,
  type VerdictRound,
  type LoopRun,
  type LoopSpec,
  type LoopTerminal,
  type LoopVerdict,
} from './loopMachine.ts';
import * as loopStore from './loopStore.ts';
import { type LoopInFlight, type StoredLoopRun } from './loopStore.ts';
import { dueAt, type ScheduleSpec } from './schedule.ts';
import { type MessageIdStatus } from './promptDedupe.ts';
import { trIn, uiLang, type UiLang } from './uiText.ts';
import { withNoteDetail } from './kirolexNote.ts';

/** A main-driven run as it is stored: the machine's `LoopRun` plus the driver's fields. */
export type DriverRun = LoopRun & {
  /** Only records carrying this are driven. A record left by an older, renderer-driven
   *  build is NOT resumed after an upgrade: that would be a billable turn nobody asked for. */
  driver: 'main';
  /** `wait`: waiting for the trigger. `verify`: the round landed; check it (again). */
  phase: 'wait' | 'verify';
  /** When the next step is due (epoch ms). Unused by `turn-end`, which waits for an event. */
  nextAt: number;
  inFlight: LoopInFlight | null;
  /** Start of the latest round: the anchor for a scheduled trigger's next slot. */
  lastRoundAt?: number | null;
  /** `turn-end`: the watched chat's last complete reply this loop has already consumed. */
  lastTriggerSeen?: string | null;
  /** Set when the run stopped because a round was in doubt. */
  inDoubt?: { iteration: number; messageId: string } | null;
  /** Every measured round's verdict line + clipped output, in both languages: the folded card. */
  verdictRounds?: Array<{ zh: VerdictRound; en: VerdictRound }>;
};

export interface LoopVerifyResult {
  ran: boolean;
  exitCode: number | null;
  output: string;
  error?: string;
}

export interface LoopDriverDeps {
  home: string;
  now(): number;
  /** May a round start in this session right now? False while quitting is pending, or for
   *  a session that is gone. Busy sessions are fine: the send path waits for the turn. */
  canStart(sessionId: string): boolean;
  /** Send one round and resolve when its turn has ENDED (or it could not be sent). */
  send(sessionId: string, text: string, messageId: string): Promise<{ ok: boolean; skipped?: boolean; error?: string }>;
  /** Run the declared check out of band, on the session's host. */
  verify(sessionId: string, command: string, timeoutSec: number): Promise<LoopVerifyResult>;
  /** Where this message stands in the durable transcript (see promptDedupe.ts). */
  messageStatus(sessionId: string, messageId: string): MessageIdStatus;
  /** Id of the last COMPLETE assistant reply in a chat, or null. Drives `turn-end`. */
  lastCompletedReply(sessionId: string): string | null;
  /** Does this chat exist (and may a loop point at it)? */
  sessionExists(sessionId: string): boolean;
  /** Write a KiroLex note into the chat (durable; not part of the model's history). */
  note(sessionId: string, text: string, variants?: { zh: string; en: string }): void;
  /** Tell the window. May fail or go nowhere (window reloading): the driver does not care. */
  changed(sessionId: string, run: DriverRun | null): void;
  /** Withdraw a round that is still waiting in the send queue. */
  dropPending?(messageId: string): void;
  isProtected?(sessionId: string): boolean;
  lang?(): UiLang;
  log?(message: string): void;
}

/** Terminals `stop()` accepts: the two that are a person's decision. The rest are the
 *  loop's own outcomes, or `superseded`, which only `start()` may write. */
export type StopReason = Extract<LoopTerminal, 'aborted' | 'discarded'>;

export class LoopDriver {
  private readonly deps: LoopDriverDeps;
  /** Sessions whose step is in progress in THIS process. Not persisted, by design: after a
   *  restart nothing is active, which is exactly how an orphaned `inFlight` is recognized. */
  private readonly active = new Set<string>();

  constructor(deps: LoopDriverDeps) {
    this.deps = deps;
  }

  /** Live, main-driven loops. */
  list(): DriverRun[] {
    return loopStore.listLiveLoops(this.deps.home)
      .filter((r) => (r as any).driver === 'main' && !this.deps.isProtected?.(r.sessionId)) as unknown as DriverRun[];
  }

  isLooping(sessionId: string): boolean {
    return this.list().some((r) => r.sessionId === sessionId);
  }

  /** Start a loop on `sessionId`, replacing (`superseded`) any loop already there. */
  start(sessionId: string, spec: LoopSpec): { ok: true; run: DriverRun } | { ok: false; error: string } {
    const lang = this.lang();
    if (this.deps.isProtected?.(sessionId)) return { ok: false, error: trIn(lang, 'This session belongs to KiroLex Advanced; the standard edition does not modify it.') };
    const errors = validateSpec(spec, lang);
    const trigger = spec.trigger;
    if (trigger?.kind === 'turn-end') {
      if (trigger.sessionId === sessionId) errors.push(trIn(lang, 'A loop cannot be triggered by its own turns ending'));
      else if (trigger.sessionId && !this.deps.sessionExists(trigger.sessionId)) errors.push(trIn(lang, 'The chat that should trigger this loop does not exist'));
    }
    if (errors.length) return { ok: false, error: errors.join('; ') };

    const now = this.deps.now();
    const previous = loopStore.readLoop(sessionId, this.deps.home);
    if (previous && !previous.terminal) {
      const ended = endWith(previous as unknown as LoopRun, 'superseded') as unknown as StoredLoopRun;
      loopStore.writeLoop(sessionId, ended, this.deps.home, this.deps.isProtected);
      const open = (previous as any).inFlight as LoopInFlight | null | undefined;
      if (open) this.deps.dropPending?.(open.messageId);
      this.report(ended as unknown as DriverRun, 'superseded');
    }

    // A loop started twice in the same millisecond would reuse message ids; nudge it.
    const startedAt = previous && previous.startedAt >= now ? previous.startedAt + 1 : now;
    const base = createRun(sessionId, spec, startedAt);
    const run: DriverRun = {
      ...base,
      driver: 'main',
      phase: 'wait',
      nextAt: firstStartAt(spec, startedAt),
      inFlight: null,
      lastRoundAt: null,
      lastTriggerSeen: trigger?.kind === 'turn-end' ? this.deps.lastCompletedReply(trigger.sessionId) : null,
      inDoubt: null,
    };
    loopStore.writeLoop(sessionId, run as unknown as StoredLoopRun, this.deps.home, this.deps.isProtected);
    this.log(`start session=${sessionId} trigger=${trigger?.kind ?? 'immediate'} level=${spec.verifier.level} max=${spec.stop.maxIterations}`);
    this.broadcast(sessionId, run);
    return { ok: true, run };
  }

  /** End a loop from outside. False when there is no live main-driven loop on the chat. */
  stop(sessionId: string, terminal: StopReason): boolean {
    const run = this.read(sessionId);
    if (!run || run.terminal) return false;
    const ended = endWith(run, terminal) as DriverRun;
    if (run.inFlight) this.deps.dropPending?.(run.inFlight.messageId);
    if (terminal === 'discarded') {
      // The chat is being deleted: nothing to report into, and nothing worth keeping.
      loopStore.clearLoop(sessionId, this.deps.home, this.deps.isProtected);
    } else {
      this.write(ended);
      this.report(ended, terminal);
    }
    this.log(`stop session=${sessionId} terminal=${terminal} iteration=${run.iteration}`);
    this.broadcast(sessionId, null);
    return true;
  }

  /**
   * One pass over every live loop: start whatever is due, resolve orphaned rounds.
   * Resolves when every step it started has finished -- index.ts does not await it (a step
   * spans a whole model turn); tests do.
   */
  tick(): Promise<void> {
    const steps: Promise<void>[] = [];
    for (const run of this.list()) {
      const sid = run.sessionId;
      if (this.active.has(sid)) continue;
      this.active.add(sid);
      steps.push(this.step(run)
        .catch((err) => { this.log(`step failed session=${sid}: ${(err as Error)?.message || err}`); })
        .finally(() => { this.active.delete(sid); }));
    }
    return Promise.all(steps).then(() => undefined);
  }

  // ───────────────────────────── steps ─────────────────────────────

  private async step(run: DriverRun): Promise<void> {
    const sid = run.sessionId;
    // Not this process's round (nothing is active after a restart): settle it from the ledger.
    if (run.inFlight) return this.resolveInFlight(run);
    if (!this.deps.canStart(sid)) return;
    const now = this.deps.now();
    const budget = run.spec.stop.maxWallClockSec;
    if (budget && now - run.startedAt >= budget * 1000) {
      // Checked while WAITING too: a turn-end loop whose event never comes must still end.
      return this.finish(run, 'exhausted');
    }
    if (run.phase === 'verify') {
      if (now >= run.nextAt) await this.verifyRound(run);
      return;
    }
    const trigger = run.spec.trigger;
    let extra: Record<string, unknown> | undefined;
    if (trigger?.kind === 'turn-end') {
      const last = this.deps.lastCompletedReply(trigger.sessionId);
      if (!last || last === run.lastTriggerSeen) return;
      // Consumed in the same write that charges the round: a crash cannot replay the event.
      extra = { lastTriggerSeen: last };
    } else if (now < run.nextAt) {
      return;
    }
    const started = loopStore.tryStartRound(sid, this.deps.home, now, this.deps.isProtected, extra);
    if (started.terminal && started.run) return this.finish(started.run as unknown as DriverRun, started.terminal as LoopTerminal, true);
    if (!started.run || !started.inFlight) return;
    const charged = started.run as unknown as DriverRun;
    this.log(`round session=${sid} iteration=${charged.iteration}/${charged.spec.stop.maxIterations} message=${started.inFlight.messageId}`);
    this.broadcast(sid, charged);
    await this.sendRound(charged, started.inFlight);
  }

  /** An in-flight round this process did not send (or no longer remembers sending). */
  private async resolveInFlight(run: DriverRun): Promise<void> {
    const open = run.inFlight!;
    const status = this.deps.messageStatus(run.sessionId, open.messageId);
    this.log(`ledger session=${run.sessionId} iteration=${open.iteration} message=${open.messageId} status=${status}`);
    if (status === 'answered') {
      const msg = (l: UiLang) => trIn(l, '⏳ Round {i} of the loop had already finished before the restart, so it was not sent again; continuing with its check.', { i: open.iteration });
      this.deps.note(run.sessionId, msg(this.lang()), this.both(msg));
      const committed = this.commit(run, open);
      if (committed) await this.verifyRound(committed);
      return;
    }
    if (status === 'started') return this.inDoubt(run, open);
    // absent / unanswered: the model never touched it. Same round, same id, not re-charged.
    if (!this.deps.canStart(run.sessionId)) return;
    await this.sendRound(run, open);
  }

  private async sendRound(run: DriverRun, open: LoopInFlight): Promise<void> {
    const sid = run.sessionId;
    const result = await this.deps.send(sid, nextPromptText(run), open.messageId);
    const latest = this.mine(sid, run.startedAt);
    if (!latest || latest.inFlight?.messageId !== open.messageId) return;   // stopped / replaced meanwhile
    if (result.skipped) return;   // withdrawn before it was sent: the ledger re-decides next tick
    /*
      Whether the round LANDED is a question about the transcript, never about the send's
      return value. `ok` from the wake queue only means `sendPromptOnce` did not throw -- and
      it returns normally for a turn cut short (max_tokens, a cancel, the wedge watchdog). Such
      a turn has no complete reply on disk (`replyComplete` is only set by a normal end), so
      committing it would verify half-done work and start the next round on top of side effects
      nobody saw finish. Only `answered` is committed; `started` is in doubt, as after a crash.
    */
    const status = this.deps.messageStatus(sid, open.messageId);
    if (status === 'answered') {
      const committed = this.commit(latest, open);
      if (committed) await this.verifyRound(committed);
      return;
    }
    if (status === 'started') return this.inDoubt(latest, open);
    const msg = result.ok
      // Returned without a complete reply and without the model having done anything.
      ? (l: UiLang) => trIn(l, '⚠️ Round {i} of the loop ended without a complete reply, so the loop has stopped.', { i: open.iteration })
      : (l: UiLang) => trIn(l, '⚠️ Round {i} of the loop could not be sent: {err}', { i: open.iteration, err: String(result.error || 'send failed').slice(0, 200) });
    this.deps.note(sid, msg(this.lang()), this.both(msg));
    this.finish({ ...latest, inFlight: null }, 'blocked');
  }

  private async verifyRound(run: DriverRun): Promise<void> {
    const sid = run.sessionId;
    const verifier = run.spec.verifier;
    let verdict: LoopVerdict;
    if (verifier.level === 0 || verifier.kind !== 'command') {
      verdict = noEvidenceVerdict(this.deps.now());
    } else {
      const result = await this.deps.verify(sid, verifier.command, verifier.timeoutSec)
        .catch((err): LoopVerifyResult => ({ ran: false, exitCode: null, output: '', error: String((err as Error)?.message || err) }));
      verdict = verdictFromCommand(verifier.level, result, this.deps.now());
    }
    const latest = this.mine(sid, run.startedAt);
    if (!latest || latest.phase !== 'verify' || latest.inFlight) return;
    const now = this.deps.now();
    const out = advance(latest, verdict, now);
    let next = { ...latest, ...out.run } as DriverRun;
    let terminal = out.terminal;
    if (!terminal && out.retryVerifierOnly) {
      const budget = next.spec.stop.maxWallClockSec;
      if (budget && now - next.startedAt >= budget * 1000) {
        terminal = 'exhausted';
        next = { ...next, terminal };
      } else {
        next = { ...next, phase: 'verify', nextAt: now + Math.max(TOLERATED_RETRY_FLOOR_SEC, next.spec.everySec) * 1000 };
      }
    } else if (!terminal) {
      next = { ...next, phase: 'wait', nextAt: nextStartAt(next, now) };
    }
    next = this.withVerdictRound(next, verdict);
    this.write(next);
    this.log(`verdict session=${sid} iteration=${next.iteration} pass=${verdict.pass} unrunnable=${!!verdict.unrunnable} terminal=${terminal ?? 'none'}`);
    if (terminal) {
      this.report(next, terminal);
      this.broadcast(sid, null);
    } else {
      this.broadcast(sid, next);
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private commit(run: DriverRun, open: LoopInFlight): DriverRun | null {
    const committed = loopStore.commitRound(run.sessionId, this.deps.home, open.messageId, this.deps.now()) as unknown as DriverRun | null;
    if (!committed || committed.inFlight) return null;
    this.broadcast(run.sessionId, committed);
    return committed;
  }

  private inDoubt(run: DriverRun, open: LoopInFlight): void {
    const msg = (l: UiLang) => trIn(l, '⚠️ Round {i} of the loop started running (it produced output or ran tools) but did not finish, so KiroLex did not send it again: its effects may already have happened, and sending it again could do them twice. The loop has stopped; check what that round did, then start the loop again if needed.', { i: open.iteration });
    this.log(`IN-DOUBT session=${run.sessionId} iteration=${open.iteration} message=${open.messageId} -- not re-sent`);
    this.deps.note(run.sessionId, msg(this.lang()), this.both(msg));
    this.finish({ ...run, inFlight: null, inDoubt: { iteration: open.iteration, messageId: open.messageId } }, 'blocked');
  }

  /** Write the terminal and say why. `alreadyWritten`: the store settled it itself. */
  private finish(run: DriverRun, terminal: LoopTerminal, alreadyWritten = false): void {
    const ended = { ...run, terminal: run.terminal ?? terminal } as DriverRun;
    if (!alreadyWritten) this.write(ended);
    this.report(ended, ended.terminal as LoopTerminal);
    this.broadcast(run.sessionId, null);
  }

  private report(run: DriverRun, terminal: LoopTerminal): void {
    if (!shouldReportTerminal(terminal)) return;
    const now = this.deps.now();
    const rounds = run.verdictRounds || [];
    const text = (l: UiLang) => withNoteDetail(terminalSummary(run, terminal, now, l), rounds.map((r) => (r[l].output ? `${r[l].line}\n${r[l].output}` : r[l].line)).join('\n\n'));
    this.deps.note(run.sessionId, text(this.lang()), this.both(text));
  }

  /**
   * Add this round to the run's folded verdict card (`verdictRounds`, both languages).
   *
   * ONE card per loop, not one message per round (loop-engineering-notes §11 #6): the window
   * renders the run's rounds as a single KiroLex card replaced in place (`showVerdict` in
   * useAcp, from `loop:changed` / `loop:list-live`), so a reload re-draws it from this record.
   * The durable copy is the terminal note, which carries every round in its 详情 (`report`).
   */
  private withVerdictRound(run: DriverRun, verdict: LoopVerdict): DriverRun {
    if (verdict.noEvidence) return run;      // level 0: nothing was measured, nothing to show
    const round = { zh: verdictRound(run, verdict, 'zh'), en: verdictRound(run, verdict, 'en') };
    return { ...run, verdictRounds: [...(run.verdictRounds || []), round] };
  }

  /** The current record if it is still THIS live run (same start), else null. */
  private mine(sessionId: string, startedAt: number): DriverRun | null {
    const run = this.read(sessionId);
    return run && !run.terminal && run.startedAt === startedAt ? run : null;
  }

  private read(sessionId: string): DriverRun | null {
    const run = loopStore.readLoop(sessionId, this.deps.home) as unknown as DriverRun | null;
    return run && run.driver === 'main' ? run : null;
  }

  private write(run: DriverRun): void {
    loopStore.writeLoop(run.sessionId, run as unknown as StoredLoopRun, this.deps.home, this.deps.isProtected);
  }

  private broadcast(sessionId: string, run: DriverRun | null): void {
    // A window that is reloading (or absent) must not be able to break the loop.
    try { this.deps.changed(sessionId, run); } catch { /* nobody listening */ }
  }

  private lang(): UiLang {
    return this.deps.lang?.() ?? uiLang();
  }

  private both(make: (lang: UiLang) => string): { zh: string; en: string } {
    return { zh: make('zh'), en: make('en') };
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}

/** Asked by the send path right before it submits a loop round (the wake queue's
 *  `isStale` / `stillWanted`): a reason not to send, or null. The round may have waited
 *  behind a busy turn while the user stopped or replaced the loop -- the record on disk
 *  decides, the same way a paused schedule's queued run is dropped. */
export function loopRoundBlocker(home: string, sessionId: string, messageId: string | undefined): string | null {
  const run = loopStore.readLoop(sessionId, home) as unknown as DriverRun | null;
  if (!run || run.driver !== 'main') return 'loop gone';
  if (run.terminal) return `loop ended (${run.terminal})`;
  if (!messageId || run.inFlight?.messageId !== messageId) return 'not the round in flight';
  return null;
}

/** The schedule a `schedule` trigger stands for, in the shape `schedule.ts` computes with. */
function scheduleOf(spec: LoopSpec): ScheduleSpec | null {
  const trigger = spec.trigger;
  if (trigger?.kind !== 'schedule') return null;
  return { ...trigger.schedule, prompt: spec.prompt, maxRuns: spec.stop.maxIterations };
}

/** When round 1 may start. A scheduled loop follows `dueAt`'s rule for a never-run job:
 *  an interval starts now, a wall-clock slot waits for the first slot after creation. */
export function firstStartAt(spec: LoopSpec, startedAt: number): number {
  const schedule = scheduleOf(spec);
  if (schedule) return dueAt(schedule, null, startedAt);
  return 0;   // immediate: now; turn-end: waits for an event instead
}

/** When the round after this one may start (`turn-end` waits for an event instead). */
export function nextStartAt(run: DriverRun, now: number): number {
  const schedule = scheduleOf(run.spec);
  if (schedule) return dueAt(schedule, run.lastRoundAt ?? null, run.startedAt);
  if (run.spec.trigger?.kind === 'turn-end') return 0;
  return now + Math.max(0, run.spec.everySec) * 1000;
}
