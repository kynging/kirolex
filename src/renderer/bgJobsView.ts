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
}

export function runningBgJobs(list: BgJobRow[], sessionId: string | null): BgJobRow[] {
  if (!sessionId) return [];
  return list.filter((j) => j.sessionId === sessionId && j.state === 'running').sort((a, b) => a.startedAt - b.startedAt);
}

export function bgElapsedText(startedAt: number, now: number, lang: Lang = 'zh'): string {
  const secs = Math.max(0, Math.round((now - startedAt) / 1000));
  if (secs < 60) return t(lang, '{n}s', { n: secs });
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t(lang, '{n} min', { n: mins });
  return t(lang, '{h}h {m}m', { h: Math.floor(mins / 60), m: mins % 60 });
}
