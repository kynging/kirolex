/**
 * "WHEN DOES THIS FIRE NEXT" — PURE. No React, no clock of its own (`now` is passed in).
 *
 * A schedule the user cannot see is indistinguishable from one that silently stopped, so
 * a chat carrying scheduled jobs says so in two places: a banner above its transcript, and
 * the next-run time on its sidebar row. Both are computed here rather than inside JSX, for
 * the usual reason — the awkward cases (due right now, paused, finished, several jobs on
 * one chat) are where this goes wrong, and they are only testable if they are data.
 *
 * THE COUNTDOWN IS DELIBERATELY COARSE. Past a minute it reports minutes, and past a day
 * it reports a date rather than "37 小时后". Two reasons: a per-second tick on a
 * Monday-morning job would re-render the sidebar tens of thousands of times to convey
 * nothing (those rows are memoised precisely to avoid that churn), and a duration nobody
 * can act on is less useful than the date itself.
 */

import { t, type Lang } from './i18n.ts';

export interface ScheduleView {
  id: string;
  sessionId: string;
  prompt: string;
  /** Human rendering of the trigger, e.g. `每周一 09:00`. Comes from main's
   *  `describeSchedule`, so the two surfaces cannot word it differently. */
  describe: string;
  runs: number;
  /** `null`：目标型任务（模型的 `schedule_create` 带 `until`），不按次数停。 */
  maxRuns: number | null;
  paused: boolean;
  terminal?: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  nextRunAt: number | null;
  /** `'model'` = 会话里的模型用 `schedule_create` 自己建的（横幅 / 侧栏标「由模型创建」）。 */
  createdBy?: string | null;
  expiresAt?: number | null;
  /** 目标型任务的目标（文字）。 */
  until?: string | null;
  checkCommand?: string | null;
}

export interface ScheduleSummary {
  /** Live (neither finished nor cancelled) jobs on this chat. */
  count: number;
  /** The one line shown in the banner and as the row's tooltip. */
  text: string;
  /** Short form for the sidebar row, where there is no space for a sentence. */
  short: string;
  paused: boolean;
  hasError: boolean;
  /** The soonest job, so a click can act on the thing being described. */
  next: ScheduleView | null;
  /** 横幅描述的那一个（`next`）是模型自己建的 —— 标「由模型创建」，人一眼能看出这不是自己设的。 */
  byModel: boolean;
  /** `next` 的目标（目标型任务），横幅上单独显示「🎯 目标：…」；没有就是 null。 */
  goal: string | null;
  /** `next` 的过期时间；有它横幅才给「延长 / 不过期」。 */
  expiresAt: number | null;
}

/**
 * How long until `at`, in words. Null when there is no next run.
 *
 * `即将运行` rather than a negative number: the main-process ticker fires every 20s, so
 * "due" and "started" are not the same instant, and a countdown that goes negative reads
 * as a bug.
 */
export function countdownText(at: number | null, now: number, lang: Lang = 'zh'): string | null {
  if (at === null || !Number.isFinite(at)) return null;
  const ms = at - now;
  if (ms <= 0) return t(lang, 'Due now');
  const secs = Math.round(ms / 1000);
  if (secs < 60) return t(lang, 'in {n}s', { n: secs });
  const mins = Math.round(secs / 60);
  if (mins < 60) return t(lang, 'in {n} min', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t(lang, 'in {h}h {m}m', { h: hours, m: mins % 60 });
  // Beyond a day the date is the useful fact. Locale-formatted, because this is the same
  // string a person would read off a calendar.
  return new Date(at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Is this job still going to run again? */
function isLive(job: ScheduleView): boolean {
  if (job.terminal) return false;
  if (typeof job.maxRuns === 'number' && job.runs >= job.maxRuns) return false;
  return true;
}

/**
 * One line for a chat that has scheduled jobs, or null when it has none.
 *
 * With several jobs the SOONEST one is described, because that is the next thing that will
 * actually happen — showing whichever was created first would name a run that is not next.
 */
export function sessionScheduleSummary(jobs: ScheduleView[], now: number, lang: Lang = 'zh'): ScheduleSummary | null {
  const live = jobs.filter(isLive);
  if (live.length === 0) return null;

  // A paused job has no next run, so it must not be picked as "soonest" while an active
  // one exists -- but if everything is paused, the line has to say that rather than nothing.
  const active = live.filter((job) => !job.paused && job.nextRunAt !== null);
  const pool = active.length ? active : live;
  const next = pool.reduce<ScheduleView | null>((best, job) => {
    if (best === null) return job;
    const a = job.nextRunAt ?? Number.POSITIVE_INFINITY;
    const b = best.nextRunAt ?? Number.POSITIVE_INFINITY;
    return a < b ? job : best;
  }, null);

  const allPaused = active.length === 0;
  const hasError = live.some((job) => !!job.lastError);
  const byGoal = !!next && typeof next.maxRuns !== 'number';
  const budget = next && !byGoal ? `${next.runs}/${next.maxRuns}` : '';
  const expiresAt = typeof next?.expiresAt === 'number' && Number.isFinite(next.expiresAt) ? next.expiresAt : null;
  const countdown = allPaused ? null : countdownText(next?.nextRunAt ?? null, now, lang);

  const parts: string[] = [];
  if (next) parts.push(next.describe);
  if (allPaused) parts.push(t(lang, 'Paused'));
  else if (countdown) parts.push(countdown);
  if (budget) parts.push(t(lang, 'Ran {budget}', { budget }));
  if (byGoal) parts.push(t(lang, 'Ran {n} · stops when the goal is reached', { n: next!.runs }));
  if (expiresAt !== null) {
    parts.push(t(lang, 'Expires {when}', { when: new Date(expiresAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }));
  }
  if (live.length > 1) parts.push(t(lang, '{n} jobs in total', { n: live.length }));
  // The error goes LAST but is never dropped: a daily job that has failed every morning
  // must not read the same as one that has been working.
  if (hasError) {
    const failing = live.find((job) => job.lastError)!;
    parts.push(t(lang, 'Last failure: {error}', { error: String(failing.lastError) }));
  }

  return {
    count: live.length,
    text: parts.join(' · '),
    short: allPaused ? t(lang, 'Paused') : (countdown || next?.describe || ''),
    paused: allPaused,
    hasError,
    next,
    byModel: next?.createdBy === 'model',
    goal: next?.until?.trim() || null,
    expiresAt,
  };
}

/** Group jobs by the chat they belong to, so the sidebar can look one up per row. */
export function schedulesBySession(jobs: ScheduleView[]): Map<string, ScheduleView[]> {
  const out = new Map<string, ScheduleView[]>();
  for (const job of jobs) {
    const list = out.get(job.sessionId);
    if (list) list.push(job);
    else out.set(job.sessionId, [job]);
  }
  return out;
}

/** 聊天顶部「⏳ 延长…」弹层里的常用档（天）。点一下就从「现在和原到期时间里较晚的那个」起延长这么久。 */
export const EXPIRY_PRESET_DAYS = [1, 3, 7, 14, 30] as const;

/**
 * 弹层里「自定义延长」那一格：正整数的天或小时 → 毫秒，或者一句就地提示。
 * 用户设的没有 30 天上限（那只约束模型的 `expiresInDays`）。
 */
export function parseExtendInput(text: string, unit: 'day' | 'hour', lang: Lang = 'zh'): { ms: number } | { error: string } {
  const raw = String(text ?? '').trim();
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) return { error: t(lang, 'Enter a whole number greater than 0') };
  return { ms: Number(raw) * (unit === 'hour' ? 3600_000 : 24 * 3600_000) };
}

/** 弹层里「直接选到期时间」那一格（`<input type="datetime-local">` 的值，本地时间）→ epoch 毫秒；必须晚于现在。 */
export function parseUntilInput(text: string, now: number, lang: Lang = 'zh'): { at: number } | { error: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return { error: t(lang, 'Choose a date and time') };
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
  if (!Number.isFinite(at)) return { error: t(lang, 'Choose a date and time') };
  if (at <= now) return { error: t(lang, 'The expiry time must be later than now') };
  return { at };
}
