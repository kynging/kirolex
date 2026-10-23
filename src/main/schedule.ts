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
 * THE ONE OPT-IN EXCEPTION: a model-created job may carry `until` (a goal in words) and an
 * optional `checkCommand` (exit 0 = reached). That is for "watch X until it ends", where the
 * number of runs cannot be known up front. KiroLex still judges nothing itself: the command
 * (or the model, via `schedule_delete`) says when it is over; expiry stays as the backstop.
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
   *  with no ceiling is the failure these rules exist to prevent.
   *  唯一的例外：带 `until` 的目标型任务可以是 `null`（不按次数停）—— 它仍受过期时间和单会话 20 个的约束。 */
  maxRuns: number | null;
  /** 目标型任务：写清什么情况算达成（模型的 `schedule_create` 才有）。每次到点的消息里都带上它，
   *  提醒模型达成后 `schedule_delete`。 */
  until?: string;
  /** 目标型任务的**机械检查**：到点先在本机跑这条命令（同 `bg_run`），不花模型 ——
   *  退出码 0 = 达成（结束并叫醒做最终汇报），1 = 还没达成（输出和上次一样就不叫醒），其他 = 出错。 */
  checkCommand?: string;
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
  /** 目标型任务的 `checkCommand` 退出码 0：目标达成。最后那一条汇报照发（见 `scheduleDeliveryBlocker`）。 */
  | 'achieved'
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
  /** `checkCommand` 上一次「还没达成」时输出的指纹（不存输出本身 —— 见头注释，也免得把凭证落盘）。 */
  lastCheckHash?: string | null;
  /** `checkCommand` 连续出错几次了；到 `CHECK_ERROR_LIMIT` 自动暂停。 */
  checkErrors?: number;
  /** `'check-errors'`：是检查命令连续出错自动暂停的（不是用户按的）—— 那一次的错误汇报照发给模型（见 `scheduleDeliveryBlocker`）。
   *  用户暂停 / 继续时清掉。 */
  pausedBy?: 'check-errors' | null;
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

/** 次数用完了吗。`maxRuns: null`（目标型任务）永远不算用完。 */
export function runCapReached(state: ScheduleState): boolean {
  return typeof state.spec.maxRuns === 'number' && state.runs >= state.spec.maxRuns;
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
  const goalOnly = (spec.maxRuns === null || spec.maxRuns === undefined) && !!spec.until?.trim();
  if (!goalOnly && (!Number.isFinite(spec.maxRuns) || Number(spec.maxRuns) < 1)) errors.push(trIn(lang, 'The run limit must be at least 1'));
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
  if (runCapReached(state)) return false;
  return now >= dueAt(state.spec, state.lastRunAt, state.createdAt);
}

/** When this will next fire, or null when it never will again. */
export function nextRunAt(state: ScheduleState): number | null {
  if (state.terminal || runCapReached(state)) return null;
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
  if (runCapReached(state)) return 'exhausted';
  if (now !== undefined && isExpired(state, now)) return 'expired';
  return null;
}

/**
 * 到点那一刻会话正忙，这一次就排着等（`wakeQueue.ts`）。**真正发之前**再看一眼盘上的任务：
 * 被删了 / 暂停了 / 结束了 / 过期了就不发，返回原因；照发返回 null。
 * 不看 `runs >= maxRuns`：这一次在排队前已经记过账，最后一次排着的时候 runs 本来就等于上限。
 * `achieved` 也不挡：那是检查命令刚判定达成、正要发的最终汇报；检查命令连续出错自动暂停（`pausedBy: 'check-errors'`）同理。
 */
export function scheduleDeliveryBlocker(state: ScheduleState | null, now: number): string | null {
  if (!state) return 'removed';
  /* 检查命令连续出错自动暂停的：暂停的同时那一条错误汇报还要发给模型，不能被自己的暂停挡掉 */
  if (state.paused && state.pausedBy !== 'check-errors') return 'paused';
  if (state.terminal === 'achieved') return null;
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
/** `expiresInDays` 夹在这个范围里。模型不能设成不过期 —— 只有用户能（聊天顶部那条定时任务上）。 */
export const MODEL_SCHEDULE_MIN_DAYS = 1;
export const MODEL_SCHEDULE_MAX_DAYS = 30;
/** 聊天顶部「⏳ 延长…」弹层交给 `schedule:set-expiry` 的具体值（延长多久由用户定）。 */
export type ScheduleExpiryChange = { mode: 'extend'; ms: number } | { mode: 'until'; at: number } | { mode: 'never' };

/**
 * 用户改过期时间：`extend` 从「现在和原到期时间里较晚的那个」起加 `ms`；`until` 设成那个时刻（必须晚于现在）；
 * `never` 不过期。**用户设的没有 30 天上限**（那只约束模型的 `expiresInDays`）。
 * 只对还没结束、带着过期时间的任务；参数不合法返回给人看的错误，什么都不改。
 */
export function computeScheduleExpiry(state: ScheduleState, change: unknown, now: number, lang: UiLang = uiLang()):
  { expiresAt: number | null } | { error: string } {
  if (state.terminal || typeof state.expiresAt !== 'number') return { error: trIn(lang, 'This scheduled task has no expiry to change') };
  const c = (change && typeof change === 'object' ? change : {}) as Record<string, unknown>;
  if (c.mode === 'never') return { expiresAt: null };
  if (c.mode === 'extend') {
    const ms = c.ms;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return { error: trIn(lang, 'The extension must be a positive length of time') };
    return { expiresAt: Math.max(now, state.expiresAt) + ms };
  }
  if (c.mode === 'until') {
    const at = c.at;
    if (typeof at !== 'number' || !Number.isFinite(at)) return { error: trIn(lang, 'Choose a valid expiry time') };
    if (at <= now) return { error: trIn(lang, 'The expiry time must be later than now') };
    return { expiresAt: at };
  }
  return { error: trIn(lang, 'Unknown expiry change') };
}
/** `checkCommand` 连续出错这么多次就自动暂停（并提示用户）。 */
export const CHECK_ERROR_LIMIT = 3;

/** `expiresInDays` → 毫秒：不给 / 不是数用默认 7 天，其余夹在 1–30 天。 */
function modelTtlMs(v: unknown): number {
  if (v === undefined || v === null || v === '') return MODEL_SCHEDULE_TTL_MS;
  const days = Number(v);
  if (Number.isNaN(days)) return MODEL_SCHEDULE_TTL_MS;
  return Math.min(MODEL_SCHEDULE_MAX_DAYS, Math.max(MODEL_SCHEDULE_MIN_DAYS, days)) * 24 * 3600 * 1000;
}

/**
 * `schedule_create` 的参数 → 一份 `ScheduleSpec`（加上过期时间），或者一句给模型看的错误。
 *
 * 和对话框建的任务走**同一个** `validateSchedule`（最短 60 秒、maxRuns ≥ 1、时间格式），只多两条：
 *   · 循环类 `maxRuns` **必须给** —— 对话框里它是一个看得见的预填数字，模型这边没有人看着，
 *     替它挑一个次数就是程序替人决定花多少轮；
 *   · `once` 可以用 `delaySec`（「N 秒后叫醒我」），`maxRuns` 不给就是 1。
 * 目标型（给了 `until`）的循环任务 `maxRuns` 可以不给 —— 停在目标达成，兜底是过期时间（`expiresInDays`，1–30 天，默认 7）。
 */
export function modelScheduleFromArgs(args: any, now: number, lang: UiLang = uiLang()):
  { spec: ScheduleSpec; expiresAt: number | null } | { error: string } {
  const kind = String(args?.kind || '') as ScheduleKind;
  if (!['interval', 'daily', 'weekly', 'once'].includes(kind)) {
    return { error: trIn(lang, 'kind must be one of interval / daily / weekly / once') };
  }
  const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number(v));
  const until = String(args?.until ?? '').trim();
  const checkCommand = String(args?.checkCommand ?? '').trim();
  if (checkCommand && !until) return { error: trIn(lang, 'checkCommand needs until (what counts as reached)') };
  let maxRuns: number | null | undefined = num(args?.maxRuns);
  if (maxRuns === undefined) {
    if (kind === 'once') maxRuns = 1;
    else if (until) maxRuns = null;
    else return { error: trIn(lang, 'maxRuns is required for a recurring job (how many times it may run at most)') };
  }
  const spec: ScheduleSpec = {
    prompt: String(args?.prompt ?? ''),
    kind,
    everySec: kind === 'interval' ? Number(num(args?.everySec) ?? NaN) : 0,
    maxRuns: maxRuns === null ? null : Math.floor(maxRuns),
  };
  if (until) spec.until = until;
  if (checkCommand) spec.checkCommand = checkCommand;
  if (kind === 'daily' || kind === 'weekly') spec.atTime = String(args?.atTime ?? '');
  if (kind === 'weekly') spec.weekday = num(args?.weekday);
  if (kind === 'once') {
    const delay = num(args?.delaySec);
    spec.atEpoch = delay !== undefined ? (delay >= 0 ? now + delay * 1000 : NaN) : num(args?.atEpoch);
  }
  const problems = validateSchedule(spec, lang);
  if (problems.length) return { error: problems.join(trIn(lang, '; ')) };
  return { spec, expiresAt: kind === 'once' ? null : now + modelTtlMs(args?.expiresInDays) };
}

/** `checkCommand` 跑一次的结果（index.ts 经 `BgJobManager.runCheck` 拿到）。 */
export type ScheduleCheckResult =
  /** `fingerprint`：完整输出的指纹（`BgJobManager.runCheck` 给）。`output` 只是末尾，长输出前面变了它看不出来；没给才退回按 `output` 算。 */
  | { status: 'exited'; code: number | null; output: string; fingerprint?: string }
  | { status: 'timeout'; output: string }
  | { status: 'failed'; output: string };

/**
 * 检查命令跑完之后怎么办 —— 纯判断，不记次数（叫醒的那几种由调用方照旧 `recordRun` 先记账再发）：
 *   · `achieved`：退出码 0，任务结束，叫醒模型做最终汇报；
 *   · `skip`：退出码 1 且输出和上次一样，这一次不叫醒（只把检查时间记成 `lastRunAt`，下一次从这次算起）；
 *   · `wake`：退出码 1 但输出变了（第一次也算变了），或者出错了（还没到上限）—— 叫醒并附上输出；
 *   · `paused`：连续出错到 `CHECK_ERROR_LIMIT` 次，自动暂停；`text` 照样是叫醒模型的错误汇报，`note` 是给用户看的提示。
 */
export function planScheduleCheck(state: ScheduleState, result: ScheduleCheckResult, now: number, lang: UiLang = uiLang()):
  { action: 'achieved' | 'skip' | 'wake' | 'paused'; state: ScheduleState; text: string; note?: string } {
  const output = String(result.output ?? '').replace(/\s+$/, '');
  const shown = output || trIn(lang, '(no output)');
  if (result.status === 'exited' && result.code === 0) {
    return {
      action: 'achieved',
      state: { ...state, lastRunAt: now, checkErrors: 0, terminal: 'achieved' },
      text: `${trIn(lang, '✅ The check command exited with 0: the goal is reached and this scheduled task has ended. Give the final report.')}\n${shown}`,
    };
  }
  if (result.status === 'exited' && result.code === 1) {
    const hash = result.fingerprint || outputFingerprint(output);
    const checked = { ...state, lastRunAt: now, checkErrors: 0, lastCheckHash: hash };
    if (state.lastCheckHash === hash) return { action: 'skip', state: checked, text: '' };
    return { action: 'wake', state: checked, text: `${trIn(lang, '🔎 The check command exited with 1 (not reached yet), and its output changed:')}\n${shown}` };
  }
  const errors = (state.checkErrors ?? 0) + 1;
  const why = result.status === 'timeout' ? trIn(lang, 'timed out')
    : result.status === 'failed' ? trIn(lang, 'could not run')
    : trIn(lang, 'exit code {code}', { code: result.code ?? '?' });
  const failed = { ...state, lastRunAt: now, checkErrors: errors };
  if (errors >= CHECK_ERROR_LIMIT) {
    return {
      action: 'paused',
      state: { ...failed, paused: true, pausedBy: 'check-errors' },
      text: `${trIn(lang, '⚠️ The check command failed ({why}) {n} times in a row, so this scheduled task paused itself until the user resumes it:', { why, n: errors })}\n${shown}`,
      note: `${trIn(lang, '⏸️ The check command of a scheduled task failed {n} times in a row ({why}), so the task was paused. Fix the command, then resume it at the top of the chat, or cancel it.', { n: errors, why })}\n${shown}`,
    };
  }
  return {
    action: 'wake',
    state: failed,
    text: `${trIn(lang, '⚠️ The check command failed ({why}), {n} time(s) in a row; after {max} the task pauses itself:', { why, n: errors, max: CHECK_ERROR_LIMIT })}\n${shown}`,
  };
}

/** 输出的指纹（cyrb53）—— 只用来判断「和上次一样吗」，不存输出本身。纯 JS：这个模块渲染端也 import。 */
export function outputFingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/**
 * 目标型任务每次到点时接在 prompt **后面**的那段：目标、（有的话）检查命令这次的结果、达成后怎么结束。
 * 没有 `until` 的任务返回空串 —— prompt 原样发，和以前一样。
 */
export function scheduleGoalSuffix(state: ScheduleState, id: string, check: string, lang: UiLang = uiLang()): string {
  const until = state.spec.until?.trim();
  if (!until) return '';
  const lines = [trIn(lang, '🎯 Goal: {until}', { until })];
  if (check) lines.push(check);
  if (state.terminal !== 'achieved' && !state.paused) {
    lines.push(trIn(lang, '(This is scheduled task {id}. Once the goal is reached, call schedule_delete with id {id} to end it; until then just finish this turn and you will be called again on schedule.)', { id }));
  }
  return `\n\n${lines.join('\n')}`;
}

/** 任务结束时在会话里留的那一句。目标型任务到期（或次数用完）时明说「目标还没达成」，不悄悄消失。 */
export function scheduleEndedText(state: ScheduleState, terminal: ScheduleTerminal, lang: UiLang = uiLang()): string {
  const v = { why: scheduleTerminalLabel(terminal, lang), schedule: describeSchedule(state.spec, lang), n: state.runs };
  const until = state.spec.until?.trim();
  if (until && (terminal === 'expired' || terminal === 'exhausted')) {
    return trIn(lang, 'Scheduled task ended: {why}, but the goal was not reached yet ({schedule}, ran {n} time(s)). Goal: {until}', { ...v, until });
  }
  return trIn(lang, 'Scheduled task ended: {why} ({schedule}, ran {n} time(s))', v);
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
    case 'achieved': return trIn(lang, 'Goal reached');
  }
}
