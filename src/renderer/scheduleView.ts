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
  /* 跨电脑同步（main 的 scheduleSync.ts）：只有执行者那台跑。老的 main 不给这些字段 = 本机跑。 */
  /** 本机就是执行者（而且定义在本机确认过）。`false` = 本机只显示，不跑。 */
  runsHere?: boolean;
  /** 不在本机跑的：按接管之前的状态已经到点了 —— 错过几次、上次运行、本应运行的第一次（接管确认框说明「会立刻补跑一次」）。没错过 = null。 */
  catchUp?: { missed: number; lastRunAt: number | null; firstMissedAt: number | null } | null;
  /** 结束了的话：结束原因 + 跑了几次的那一句（main 的 `scheduleEndedText`，和执行者那台写进会话的一样）。没结束 = null。 */
  endedText?: string | null;
  /** 上一次检查的结果（执行者那台写的，跟着同步过来）：时刻、结论、退出码、输出末尾一小段。 */
  lastCheck?: { at: number; result: 'achieved' | 'unchanged' | 'changed' | 'error'; code: number | null; output: string } | null;
  /** 不在本机跑时：在哪台上跑（主机名）。 */
  runnerName?: string | null;
  /** 执行者写着本机、但定义没在本机确认过（恢复会话拉回来的）：同样要接管确认才跑。 */
  needsConfirm?: boolean;
  /** 执行者那台最后一次同步的时刻（不知道 = null）。 */
  runnerSeenAt?: number | null;
  /** 超过多久没同步就提示「可能关机了」（约 2 个同步周期）。 */
  staleAfterMs?: number;
  /** 定义的摘要：接管时交回 main 核对「确认的就是这份」。 */
  defHash?: string;
}

/**
 * 执行者那台多久没同步了：超过 `staleAfterMs` 给小时数（至少 1），界面提示「可能关机了，可以接管到本机」；
 * 没超过 / 不知道它什么时候同步过 → null。
 */
export function runnerOfflineHours(seenAt: number | null | undefined, now: number, staleAfterMs: number | undefined): number | null {
  if (typeof seenAt !== 'number' || !Number.isFinite(seenAt) || !(typeof staleAfterMs === 'number' && staleAfterMs > 0)) return null;
  const gap = now - seenAt;
  if (gap <= staleAfterMs) return null;
  return Math.max(1, Math.floor(gap / 3600_000));
}

/** 到点后超过这么久还没运行，才算「已逾期」（调度器 20 秒一跳，同步也有延迟）。 */
export const OVERDUE_AFTER_MS = 10 * 60_000;

/**
 * 不在本机跑的任务**已经逾期**了吗：下一次运行时间过去超过 `OVERDUE_AFTER_MS` 还没跑（执行者那台多半关机了）→
 * 「已逾期 N 小时没运行（<机器名> 可能关机了）」；没逾期 / 暂停着 / 在本机跑 → null。
 */
export function overdueText(job: ScheduleView, now: number, lang: Lang = 'zh'): string | null {
  if (job.runsHere !== false || job.paused || !isLive(job)) return null;
  const at = job.nextRunAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const gap = now - at;
  if (gap <= OVERDUE_AFTER_MS) return null;
  const machine = job.runnerName || '?';
  if (gap < 3600_000) return t(lang, '🖥️ Overdue by {n} min without running ({machine} may be off)', { n: Math.floor(gap / 60_000), machine });
  return t(lang, '🖥️ Overdue by {n} h without running ({machine} may be off)', { n: Math.floor(gap / 3600_000), machine });
}

/** 接管确认框里「已错过 N 次（上次运行 X，本应在 Y 运行）。接管后会立刻补跑一次」那一段；没错过 = null。 */
export function catchUpNotice(job: ScheduleView, lang: Lang = 'zh'): string | null {
  const c = job.catchUp;
  if (!c || !(c.missed > 0)) return null;
  const fmt = (ms: number | null) => (typeof ms === 'number' && Number.isFinite(ms)
    ? new Date(ms).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : t(lang, 'never'));
  return t(lang, 'Missed {n} time(s) (last run {last}, it should have run at {due}). After the takeover it runs once right away.',
    { n: c.missed, last: fmt(c.lastRunAt), due: fmt(c.firstMissedAt) });
}

/** 「上次检查」那一行：时刻 + 结论（+ 退出码）+ 输出末尾；没有检查过 = null。 */
export function lastCheckText(c: ScheduleView['lastCheck'], lang: Lang = 'zh'): string | null {
  if (!c || typeof c.at !== 'number') return null;
  const when = new Date(c.at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const verdict = c.result === 'achieved' ? t(lang, 'goal reached (exit 0)')
    : c.result === 'unchanged' ? t(lang, 'not reached yet, output unchanged (exit 1)')
    : c.result === 'changed' ? t(lang, 'not reached yet, output changed (exit 1)')
    : c.code === null ? t(lang, 'failed (did not finish)') : t(lang, 'failed (exit {code})', { code: c.code });
  const out = String(c.output || '').replace(/\s+/g, ' ').trim();
  return t(lang, '🔎 Last check {when}: {verdict}', { when, verdict }) + (out ? ` · ${out}` : '');
}

/** 接管确认弹窗里的全文：prompt、checkCommand、目标、周期一条不省。 */
export function takeOverDetails(job: ScheduleView, lang: Lang = 'zh'): string {
  const lines = [
    t(lang, 'Schedule: {schedule}', { schedule: job.describe }),
    t(lang, 'Message sent each time:'),
    job.prompt,
  ];
  if (job.until) lines.push('', t(lang, 'Goal (until): {goal}', { goal: job.until }));
  if (job.checkCommand) lines.push('', t(lang, 'Check command (runs in a shell on this computer):'), job.checkCommand);
  return lines.join('\n');
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
  /** `next` 不在本机跑：在哪台上跑、是否只差本机确认、那台多久没同步了（小时，没超时 = null）。在本机跑 = null。 */
  elsewhere: { name: string; needsConfirm: boolean; offlineHours: number | null; lastCheck: string | null; overdue: string | null } | null;
  /** 已经结束的任务（只在不跑它的那台上保留这张卡，`endedElsewhereSummary`）：结束那一句。还在跑 = 没有 / null。 */
  ended?: string | null;
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
  /*
    没暂停、却没有下一次自动运行的（接管时取消了补跑的一次性任务）：**不是暂停** —— 还能「▶ 立即运行一次」。
    有排着的就先说排着的；都没有时说它，而不是说成「已暂停」。
  */
  const unpaused = live.filter((job) => !job.paused);
  const pool = active.length ? active : unpaused.length ? unpaused : live;
  const next = pool.reduce<ScheduleView | null>((best, job) => {
    if (best === null) return job;
    const a = job.nextRunAt ?? Number.POSITIVE_INFINITY;
    const b = best.nextRunAt ?? Number.POSITIVE_INFINITY;
    return a < b ? job : best;
  }, null);

  const allPaused = unpaused.length === 0;
  const hasError = live.some((job) => !!job.lastError);
  const byGoal = !!next && typeof next.maxRuns !== 'number';
  const budget = next && !byGoal ? `${next.runs}/${next.maxRuns}` : '';
  const expiresAt = typeof next?.expiresAt === 'number' && Number.isFinite(next.expiresAt) ? next.expiresAt : null;
  const countdown = allPaused ? null : countdownText(next?.nextRunAt ?? null, now, lang);

  const parts: string[] = [];
  if (next) parts.push(next.describe);
  if (allPaused) parts.push(t(lang, 'Paused'));
  else if (countdown) parts.push(countdown);
  else if (next && next.nextRunAt === null) parts.push(t(lang, 'No automatic run scheduled'));
  if (budget) parts.push(t(lang, 'Ran {budget}', { budget }));
  if (byGoal) parts.push(t(lang, 'Ran {n} · stops when the goal is reached', { n: next!.runs }));
  if (expiresAt !== null) {
    parts.push(t(lang, 'Expires {when}', { when: new Date(expiresAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }));
  }
  /* 不在本机跑：本机看不到它什么时候跑过，把执行者那台上次运行的时刻也写上 */
  if (next && next.runsHere === false && typeof next.lastRunAt === 'number') {
    parts.push(t(lang, 'Last run {when}', { when: new Date(next.lastRunAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }));
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
    elsewhere: next && next.runsHere === false
      ? { name: next.runnerName || '?', needsConfirm: !!next.needsConfirm, offlineHours: next.needsConfirm ? null : runnerOfflineHours(next.runnerSeenAt, now, next.staleAfterMs), lastCheck: lastCheckText(next.lastCheck, lang), overdue: overdueText(next, now, lang) }
      : null,
  };
}

/**
 * **在别的电脑上跑完了的任务**（跨电脑同步）：执行者那台结束时会在会话里说一声，这边却只有任务记录 ——
 * 还在跑的一个都没有时，留一张「已结束」卡：在哪台上跑的、结束原因和跑了几次、最后一次检查的结果。
 * 只认不在本机跑的（本机跑的结束时，结局那一句就在本机的会话里）。几条都结束了取最后跑的那条。没有 = null。
 */
export function endedElsewhereSummary(jobs: ScheduleView[], lang: Lang = 'zh'): ScheduleSummary | null {
  const ended = jobs.filter((job) => job.runsHere === false && !isLive(job));
  if (!ended.length) return null;
  const last = ended.reduce((a, b) => ((b.lastRunAt ?? 0) > (a.lastRunAt ?? 0) ? b : a));
  const ranText = t(lang, 'Ended · ran {n} time(s)', { n: last.runs });
  const endedText = last.endedText || ranText;
  const parts = [endedText];
  if (last.lastError) parts.push(t(lang, 'Last failure: {error}', { error: String(last.lastError) }));
  return {
    count: 0,
    text: parts.join(' · '),
    short: t(lang, 'Ended'),
    paused: false,
    hasError: !!last.lastError,
    next: last,
    byModel: last.createdBy === 'model',
    goal: last.until?.trim() || null,
    expiresAt: null,
    elsewhere: { name: last.runnerName || '?', needsConfirm: false, offlineHours: null, lastCheck: lastCheckText(last.lastCheck, lang), overdue: null },
    ended: endedText,
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
