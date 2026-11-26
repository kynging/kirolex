/**
 * 会话顶部那一行「后台任务」—— 纯展示逻辑（模型用 `bg_run` / `watch` 起的命令，进程在主进程里）。
 *
 * 只列**还在跑**的：结束了的结果已经作为一条消息回到会话里了，挂在顶部只会让人以为它还在跑。
 * 运行时长按分钟粒度（秒只在第一分钟里显示）—— 和定时任务倒计时同一个理由：没人需要每秒变一次的数字。
 */

import { t, type Lang } from './i18n.ts';

export interface BgJobRow {
  jobId: string;
  sessionId: string;
  kind: 'run' | 'watch';
  label: string;
  command: string;
  state: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  pid: number | null;
  events: number;
  /**
   * 跨电脑同步来的（跑在别的电脑上，只读）：`command` 是完整命令。没有这个字段 = 本机进程表里的。
   * 停止 = 写停止请求（跑它的那台执行）；那台失联时可以确认全文后「在本机重新运行」。
   */
  elsewhere?: BgElsewhere;
  /** 本机的任务：本机失联期间被别的电脑「在那边重跑」了（只显示，本机进程照旧）。 */
  rerunElsewhere?: { byName: string; newJobId: string };
}

export interface BgElsewhere {
  runnerName: string;
  /** runner 最后一次更新它的时刻。 */
  updatedAt: number;
  staleAfterMs: number;
  /** runner 那台上的工作目录。 */
  cwd: string;
  /** 结束后的输出末尾（同唤醒消息的截断）。 */
  tail: string | null;
  timeoutMs: number;
  stopRequested: boolean;
  /** 命令太长没能完整同步：`command` 只是开头，不给重跑。 */
  commandTruncated?: boolean;
  rerun: { byName: string; here: boolean; newJobId: string } | null;
  /** 在本机重新运行会用的 cwd + 确认摘要（交回 main 核对）。 */
  localCwd: string;
  rerunHash: string;
  /** 结束了的：它的结束消息已经随会话记录同步到本机了（main 按 jobId 在 transcript 里查，`recordedBgJobIds`）。 */
  endRecorded?: boolean;
}

/** 别的电脑上结束了的，结束后最多在会话顶部留这么久（结束消息一直没同步过来也一样）。 */
export const ENDED_ELSEWHERE_SHOW_MS = 30 * 60_000;

export function runningBgJobs(list: BgJobRow[], sessionId: string | null): BgJobRow[] {
  if (!sessionId) return [];
  return list.filter((j) => j.sessionId === sessionId && j.state === 'running').sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * 别的电脑上的这一条要不要放在会话顶部：还在跑的（含失联的）放；结束了的只在**结束消息还没同步到本机记录**、
 * 结束不到 30 分钟、也没被收起时放 —— 结果一旦在记录里了，顶部再挂着只会让人以为它还在跑。
 */
export function showEndedElsewhere(row: BgJobRow, now: number, dismissed?: ReadonlySet<string>): boolean {
  const e = row.elsewhere;
  if (!e) return false;
  if (row.state === 'running') return true;
  if (e.endRecorded || dismissed?.has(row.jobId)) return false;
  return now - (row.endedAt ?? e.updatedAt) <= ENDED_ELSEWHERE_SHOW_MS;
}

/**
 * 会话顶部那一块：只放还在跑的 —— 本机的（同 `runningBgJobs`）和别的电脑上的一样；别的电脑上刚结束、结果消息还没同步过来的
 * 暂时也放（`showEndedElsewhere`），卡片上先给退出码和输出末尾。
 */
export function bannerBgJobs(list: BgJobRow[], sessionId: string | null, opts: { now?: number; dismissed?: ReadonlySet<string> } = {}): BgJobRow[] {
  if (!sessionId) return [];
  const now = opts.now ?? Date.now();
  const local = runningBgJobs(list.filter((j) => !j.elsewhere), sessionId);
  const remote = list.filter((j) => j.elsewhere && j.sessionId === sessionId && showEndedElsewhere(j, now, opts.dismissed))
    .sort((a, b) => a.startedAt - b.startedAt);
  return [...local, ...remote];
}

/** 「✕ 收起」过的（本机 ui-state 里记一笔，不同步）：jobId → 收起的时刻。超过 7 天的不再记（那时它早就不会再出现了）。 */
export const BG_DISMISSED_KEY = 'kirolex-bg-dismissed';
export function parseBgDismissed(raw: string | null | undefined, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const o = JSON.parse(raw || '{}');
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const [id, at] of Object.entries(o)) if (typeof at === 'number' && now - at <= 7 * 24 * 3600_000) out[id] = at;
    }
  } catch { /* 坏了：当作没收起过 */ }
  return out;
}

/** 跑它的那台失联了：还在「运行中」，状态超过约 2 个同步周期没更新（同 main 的 `bgRunnerLost`）。 */
export function bgRunnerLost(row: BgJobRow, now: number): boolean {
  const e = row.elsewhere;
  return !!e && row.state === 'running' && e.staleAfterMs > 0 && now - e.updatedAt > e.staleAfterMs;
}

/** 别的电脑上的那条结束了：一句话说清状态和退出码。 */
export function bgEndedText(row: BgJobRow, lang: Lang = 'zh'): string {
  const code = row.exitCode ?? '?';
  switch (row.state) {
    case 'exited': return t(lang, 'exited, exit code {code}', { code });
    case 'timeout': return t(lang, 'timed out and was stopped');
    case 'stopped': return t(lang, 'stopped');
    case 'rate-limited': return t(lang, 'stopped: too many events');
    case 'failed': return t(lang, 'could not run');
    default: return row.state;
  }
}

/** 「在本机重新运行」确认框里给人看的全文：命令、本机 cwd、原来的 cwd、种类、最长运行时间。 */
export function bgRerunDetails(row: BgJobRow, lang: Lang = 'zh'): string {
  const e = row.elsewhere!;
  const mins = Math.max(1, Math.round(e.timeoutMs / 60_000));
  return [
    `${t(lang, 'Command (runs in the local shell):')}\n${row.command}`,
    `${t(lang, 'Working directory on this computer:')} ${e.localCwd}`,
    `${t(lang, 'Working directory on {machine}:', { machine: e.runnerName })} ${e.cwd}`,
    `${t(lang, 'Kind:')} ${row.kind === 'watch' ? t(lang, 'Watching') : t(lang, 'Background command')}  ·  ${t(lang, 'Time limit: {n} min', { n: mins })}`,
  ].join('\n\n');
}

export function bgElapsedText(startedAt: number, now: number, lang: Lang = 'zh'): string {
  const secs = Math.max(0, Math.round((now - startedAt) / 1000));
  if (secs < 60) return t(lang, '{n}s', { n: secs });
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t(lang, '{n} min', { n: mins });
  return t(lang, '{h}h {m}m', { h: Math.floor(mins / 60), m: mins % 60 });
}
