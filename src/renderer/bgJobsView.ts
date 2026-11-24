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
}

export function runningBgJobs(list: BgJobRow[], sessionId: string | null): BgJobRow[] {
  if (!sessionId) return [];
  return list.filter((j) => j.sessionId === sessionId && j.state === 'running').sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * 会话顶部那一块：本机的只列还在跑的（同 `runningBgJobs`）；别的电脑上的（跨电脑同步来的）结束了也列 ——
 * 本机的结果已经作为一条消息回到会话里了，别的电脑上的那条消息要等会话记录同步过来，卡片上先给退出码和输出末尾。
 */
export function bannerBgJobs(list: BgJobRow[], sessionId: string | null): BgJobRow[] {
  if (!sessionId) return [];
  const local = runningBgJobs(list.filter((j) => !j.elsewhere), sessionId);
  const remote = list.filter((j) => j.elsewhere && j.sessionId === sessionId).sort((a, b) => a.startedAt - b.startedAt);
  return [...local, ...remote];
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
