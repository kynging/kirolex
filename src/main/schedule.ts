/**
 * TIME-TRIGGERED TASKS — PURE. No timers, no IPC, no clock of its own.
 *
 * WHAT THIS REPLACES, and why. "Loop mode" re-sent one message on an interval and judged
 * each round with a verifier command (L1/L2/L3), stopping when the check passed. That is a
 * coding shape. Against the four real target scenarios — weekly report, SFDC activity
 * logging, oncall, research — none of them is a loop by the only test that matters: does
 * the previous round's RESULT change the next round's ACTION? A weekly report does not
 * depend on last week's; an oncall check reads the current queue. They are time-triggered
 * tasks, so this models time, and nothing else.
 *
 * DELIBERATELY ABSENT: goal, verifier, and the `success` / `no-op` / `stalled` terminals.
 * All three require a judgeable completion condition, which these tasks do not have —
 * claiming a schedule "succeeded" would assert something nothing measured. The stop
 * conditions are the two that survive without a goal: A PERSON (pause / cancel) and A
 * BUDGET (`maxRuns`).
 *
 * EACH RUN IS INDEPENDENT, and that is load-bearing rather than a simplification.
 * KiroCrew's cron carries the previous result forward by default and its own source calls
 * that "the other half of the bug" (`cron.py:204`), shipping a stateless mode to switch it
 * off; Warp's scheduled agents open a fresh session per run for the same reason. Feeding
 * the last result back is exactly what makes a scheduled job report the same thing every
 * morning. So this state records THAT a run happened and when — never its output.
 *
 * Wall-clock kinds (`daily` / `weekly`) are not sugar over an interval: an every-86400s
 * job drifts by however long each run took, so a 9am report slides later every day.
 */

import { trIn, uiLang, type UiLang } from './uiText.ts';

export type ScheduleKind = 'interval' | 'daily' | 'weekly' | 'once';

export interface ScheduleSpec {
  /** What to send. One prompt, sent verbatim, every time. */
  prompt: string;
  kind: ScheduleKind;
  /** `interval` only: seconds between runs. */
  everySec: number;
  /** `daily` / `weekly`: local wall-clock time, `HH:MM`, 24-hour. */
  atTime?: string;
  /** `weekly`: 0 = Sunday … 6 = Saturday, matching `Date.getDay()`. */
  weekday?: number;
  /** `once`: the moment to fire, epoch ms. */
  atEpoch?: number;
  /** Hard cap on runs. REQUIRED: every run costs a model turn, and an unattended job
   *  with no ceiling is the failure these rules exist to prevent. */
  maxRuns: number;
}

/** Why a schedule stopped. Three, and none of them is a verdict on the WORK — only on
 *  whether the schedule itself is still live. */
export type ScheduleTerminal =
  /** A `once` job fired, or the run budget was spent exactly. */
  | 'completed'
  /** The run budget ran out. */
  | 'exhausted'
  /** The user removed it. */
  | 'cancelled'
  /** A model-created job outlived its `expiresAt` (default 7 days, `MODEL_SCHEDULE_TTL_MS`). */
  | 'expired';

export interface ScheduleState {
  spec: ScheduleSpec;
  /** The chat this job sends into. */
  sessionId: string;
  runs: number;
  createdAt: number;
  lastRunAt: number | null;
  /** The last run's failure, kept so a job failing every time is visible instead of
   *  looking healthy. Never the last run's OUTPUT — see the header. */
  lastError: string | null;
  paused: boolean;
  terminal: ScheduleTerminal | null;
  /** 「由模型创建」：会话里的模型自己用 `schedule_create` 建的（kirolex-local 工具）。用户建的没有这个字段。 */
  createdBy?: 'model';
  /** 过了这一刻就不再触发（终态 `expired`）。模型建的循环任务默认 7 天；用户建的没有。 */
  expiresAt?: number | null;
}

/** Floor on the interval, matching KiroCrew's cron. Every run costs a model turn, so a
 *  5-second schedule is a way to spend money quickly rather than a useful setting. */
export const MIN_INTERVAL_SEC = 60;

/** Prefill for the dialog. A VISIBLE number the user can change — never a silent
 *  fallback for an empty field, which is how a program ends up choosing how many
 *  billable turns to spend. */
export const DEFAULT_MAX_RUNS = 20;

/** 「每周X HH:MM」 —— 中英文语序不同，所以按星期整句查表（0 = 周日，同 `Date.getDay()`）。 */
function weeklyText(weekday: number, time: string, lang: UiLang): string {
  const v = { time };
  switch (weekday) {
    case 1: return trIn(lang, 'Every Monday at {time}', v);
    case 2: return trIn(lang, 'Every Tuesday at {time}', v);
    case 3: return trIn(lang, 'Every Wednesday at {time}', v);
    case 4: return trIn(lang, 'Every Thursday at {time}', v);
    case 5: return trIn(lang, 'Every Friday at {time}', v);
    case 6: return trIn(lang, 'Every Saturday at {time}', v);
    default: return trIn(lang, 'Every Sunday at {time}', v);
  }
}

/** 0 = 周日 … 6 = 周六，必须是整数（1.5 / NaN 会让 `dueAt` 的找日子循环永远停不下来）。 */
function isWeekday(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6;
}

/** `HH:MM` → parts, or null when it is not a real time of day. */
export function parseClockTime(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function validateSchedule(spec: ScheduleSpec, lang: UiLang = uiLang()): string[] {
  const errors: string[] = [];
  if (!spec.prompt.trim()) errors.push(trIn(lang, 'The message to send is empty'));
  if (spec.kind === 'interval') {
    if (!Number.isFinite(spec.everySec) || spec.everySec < MIN_INTERVAL_SEC) {
      errors.push(trIn(lang, 'The interval must be at least {n} seconds', { n: MIN_INTERVAL_SEC }));
    }
  }
  if (spec.kind === 'daily' || spec.kind === 'weekly') {
    if (!parseClockTime(spec.atTime || '')) errors.push(trIn(lang, 'Time must be HH:MM (24-hour)'));
  }
  if (spec.kind === 'weekly' && !isWeekday(spec.weekday)) {
    errors.push(trIn(lang, 'Choose a day of the week'));
  }
  if (spec.kind === 'once' && !Number.isFinite(spec.atEpoch)) errors.push(trIn(lang, 'Choose when it should run'));
  if (!Number.isFinite(spec.maxRuns) || spec.maxRuns < 1) errors.push(trIn(lang, 'The run limit must be at least 1'));
  return errors;
}

/** Local midnight of the day containing `at`. */
function startOfDay(at: number): Date {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * The moment this schedule is next due, given when it last ran.
 *
 * `0` means "immediately": a never-run job fires now rather than one interval from now,
 * because a job that appears to do nothing for an hour after you create it reads as
 * broken.
 */
export function dueAt(spec: ScheduleSpec, lastRunAt: number | null, createdAt: number): number {
  if (spec.kind === 'once') return Number(spec.atEpoch ?? 0);
  if (spec.kind === 'interval') {
    // Only an interval job starts right away: "every hour" from now means the first one is now.
    if (lastRunAt === null) return 0;
    return lastRunAt + Math.max(MIN_INTERVAL_SEC, spec.everySec) * 1000;
  }

  const clock = parseClockTime(spec.atTime || '') || { hour: 0, minute: 0 };
  /**
   * THE ANCHOR: the last run, or -- for a job that has never run -- the moment it was CREATED.
   *
   * It used to be `Date.now()` for a never-run job, which had two effects. The function stopped
   * being a function (same arguments, different answers on different days), and creating
   * 「每天 09:00」 in the evening put its first slot at TODAY 09:00, already past, so the job was
   * immediately due and fired the moment it was created. Creating an unattended job must never
   * also mean running it now.
   *
   * A slot at or before the anchor is spent -- either it is the run that already happened there,
   * or the job was created after it passed.
   */
  const anchor = lastRunAt ?? createdAt;
  const candidate = startOfDay(anchor);
  candidate.setHours(clock.hour, clock.minute, 0, 0);

  if (spec.kind === 'daily') {
    if (anchor >= candidate.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }

  // Weekly: walk to the declared weekday, never returning a slot already spent.
  const target = spec.weekday ?? 0;
  /* 不是 0–6 的整数（盘上的坏文件）就永远不到点 —— 否则下面这个循环找不到那一天、把主进程卡死 */
  if (!isWeekday(target)) return Number.POSITIVE_INFINITY;
  while (candidate.getDay() !== target) candidate.setDate(candidate.getDate() + 1);
  if (anchor >= candidate.getTime()) candidate.setDate(candidate.getDate() + 7);
  return candidate.getTime();
}

export function isDue(state: ScheduleState, now: number): boolean {
  if (state.terminal || state.paused) return false;
  if (isExpired(state, now)) return false;
  if (state.runs >= state.spec.maxRuns) return false;
  return now >= dueAt(state.spec, state.lastRunAt, state.createdAt);
}

/** When this will next fire, or null when it never will again. */
export function nextRunAt(state: ScheduleState): number | null {
  if (state.terminal || state.runs >= state.spec.maxRuns) return null;
  return dueAt(state.spec, state.lastRunAt, state.createdAt);
}

/**
 * Fold one completed run in. A FAILED run still counts — otherwise a broken job retries
 * without limit, and the budget stops bounding anything.
 */
export function recordRun(state: ScheduleState, now: number, error?: string): ScheduleState {
  return { ...state, runs: state.runs + 1, lastRunAt: now, lastError: error ?? null };
}

/** Whether the schedule is over, and why. Not a verdict on the work. `now` only matters for
 *  jobs carrying an `expiresAt`; without it expiry is not judged. */
export function scheduleTerminal(state: ScheduleState, now?: number): ScheduleTerminal | null {
  if (state.terminal) return state.terminal;
  if (state.spec.kind === 'once' && state.runs >= 1) return 'completed';
  if (state.runs >= state.spec.maxRuns) return 'exhausted';
  if (now !== undefined && isExpired(state, now)) return 'expired';
  return null;
}

/**
 * 到点那一刻会话正忙，这一次就排着等（`wakeQueue.ts`）。**真正发之前**再看一眼盘上的任务：
 * 被删了 / 暂停了 / 结束了 / 过期了就不发，返回原因；照发返回 null。
 * 不看 `runs >= maxRuns`：这一次在排队前已经记过账，最后一次排着的时候 runs 本来就等于上限。
 */
export function scheduleDeliveryBlocker(state: ScheduleState | null, now: number): string | null {
  if (!state) return 'removed';
  if (state.paused) return 'paused';
  if (state.terminal) return state.terminal;
  if (isExpired(state, now)) return 'expired';
  return null;
}

/** 记了账却没发出去（排着的时候被取消 / 暂停）：把那一次退回去 —— 没跑的不该占预算。 */
export function refundRun(current: ScheduleState, beforeCharge: ScheduleState): ScheduleState {
  return { ...current, runs: Math.max(0, current.runs - 1), lastRunAt: beforeCharge.lastRunAt };
}

function isExpired(state: ScheduleState, now: number): boolean {
  return typeof state.expiresAt === 'number' && Number.isFinite(state.expiresAt) && now >= state.expiresAt;
}

/** 模型建的循环任务（interval / daily / weekly）默认多久过期。一个被忘掉的循环最多再花 7 天的钱。 */
export const MODEL_SCHEDULE_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * `schedule_create` 的参数 → 一份 `ScheduleSpec`（加上过期时间），或者一句给模型看的错误。
 *
 * 和对话框建的任务走**同一个** `validateSchedule`（最短 60 秒、maxRuns ≥ 1、时间格式），只多两条：
 *   · 循环类 `maxRuns` **必须给** —— 对话框里它是一个看得见的预填数字，模型这边没有人看着，
 *     替它挑一个次数就是程序替人决定花多少轮；
 *   · `once` 可以用 `delaySec`（「N 秒后叫醒我」），`maxRuns` 不给就是 1。
 */
export function modelScheduleFromArgs(args: any, now: number, lang: UiLang = uiLang()):
  { spec: ScheduleSpec; expiresAt: number | null } | { error: string } {
  const kind = String(args?.kind || '') as ScheduleKind;
  if (!['interval', 'daily', 'weekly', 'once'].includes(kind)) {
    return { error: trIn(lang, 'kind must be one of interval / daily / weekly / once') };
  }
  const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number(v));
  let maxRuns = num(args?.maxRuns);
  if (maxRuns === undefined) {
    if (kind !== 'once') return { error: trIn(lang, 'maxRuns is required for a recurring job (how many times it may run at most)') };
    maxRuns = 1;
  }
  const spec: ScheduleSpec = {
    prompt: String(args?.prompt ?? ''),
    kind,
    everySec: kind === 'interval' ? Number(num(args?.everySec) ?? NaN) : 0,
    maxRuns: Math.floor(maxRuns),
  };
  if (kind === 'daily' || kind === 'weekly') spec.atTime = String(args?.atTime ?? '');
  if (kind === 'weekly') spec.weekday = num(args?.weekday);
  if (kind === 'once') {
    const delay = num(args?.delaySec);
    spec.atEpoch = delay !== undefined ? (delay >= 0 ? now + delay * 1000 : NaN) : num(args?.atEpoch);
  }
  const problems = validateSchedule(spec, lang);
  if (problems.length) return { error: problems.join(trIn(lang, '; ')) };
  return { spec, expiresAt: kind === 'once' ? null : now + MODEL_SCHEDULE_TTL_MS };
}

export function createSchedule(sessionId: string, spec: ScheduleSpec, now: number): ScheduleState {
  return { spec, sessionId, runs: 0, createdAt: now, lastRunAt: null, lastError: null, paused: false, terminal: null };
}

/** Plain-language rendering, so a job in a list is never a black box. The lesson from
 *  n8n's bare "stopped due to max iterations": a limit that does not explain itself gets
 *  treated as an obstacle to route around. */
export function describeSchedule(spec: ScheduleSpec, lang: UiLang = uiLang()): string {
  switch (spec.kind) {
    case 'interval': {
      const secs = Math.max(MIN_INTERVAL_SEC, spec.everySec);
      return secs % 3600 === 0 ? trIn(lang, 'Every {n} h', { n: secs / 3600 })
        : secs % 60 === 0 ? trIn(lang, 'Every {n} min', { n: secs / 60 })
        : trIn(lang, 'Every {n} s', { n: secs });
    }
    case 'daily':
      return trIn(lang, 'Daily at {time}', { time: String(spec.atTime) });
    case 'weekly':
      return weeklyText(spec.weekday ?? 0, String(spec.atTime), lang);
    case 'once':
      return trIn(lang, 'One-time · {when}', { when: new Date(spec.atEpoch ?? 0).toLocaleString() });
  }
}

export function scheduleTerminalLabel(terminal: ScheduleTerminal, lang: UiLang = uiLang()): string {
  switch (terminal) {
    case 'completed': return trIn(lang, 'Completed');
    case 'exhausted': return trIn(lang, 'Run limit reached');
    case 'cancelled': return trIn(lang, 'Cancelled');
    case 'expired': return trIn(lang, 'Expired');
  }
}
