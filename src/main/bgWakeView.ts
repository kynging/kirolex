/**
 * 后台命令 / 监视结束的唤醒在会话里怎么显示 —— 纯解析，不碰发给模型的文字。
 *
 * `bgJobs.ts` 结束时发进会话的那条（「🔔 后台命令「…」已结束：退出码 0，用时 …（bg_xxx）」+ 输出末尾）原样落盘、
 * 原样发给模型；这里只是把它**拆开来显示**成和「⏰ 定时」同一套的紧凑卡片：图标 + 标签 + 状态 + 用时一行，
 * 内部 id 进详情，输出末尾折起来。认法只看正文（中英两版都认），历史里的旧消息重开也一样；认不出来的返回 null，照旧当用户消息。
 */

import { trIn, type UiLang } from './uiText.ts';
import { templateRe, type WakeLike } from './scheduleWakeView.ts';

export type BgWakeStatus = 'ok' | 'exit' | 'failed' | 'stopped';

export interface BgWakeCard {
  kind: 'bg' | 'watch';
  label: string;
  /** ok = 退出码 0；exit = 非 0（或不知道，`?`）；failed = 没能运行；stopped = 超时 / 到时间上限 / 被限流，由 KiroLex 停掉。 */
  status: BgWakeStatus;
  /** 退出码；原文是「?」记 null。没能运行 / 被停掉的没有。 */
  exitCode?: number | null;
  /** 用时 / 时间上限（原文那段，例如「1 分 4 秒」）；原文里没有就没有。 */
  duration?: string;
  /** 为什么停掉的。 */
  stop?: 'timeout' | 'rate-limited';
  /** 没能运行的原因。 */
  reason?: string;
  jobId: string;
  /** 输出末尾（不含「输出末尾：」那行；「（没有输出）」记成空串）。原文不带输出的没有。 */
  output?: string;
}

const LANGS: UiLang[] = ['zh', 'en'];

const FINISHED = '🔔 Background command "{label}" finished: exit code {code}, ran {dur} ({id})';
const FAILED = '🔔 Background command "{label}" could not run: {why} ({id})';
const WATCH_ENDED = '👀 Watch "{label}" ended: the command exited with code {code} ({id})';
const BG_TIMEOUT = '🔔 Background command "{label}" timed out after {dur} and was stopped ({id})';
const WATCH_TIMEOUT = '👀 Watch "{label}" reached its time limit ({dur}) and was stopped ({id})';
const WATCH_LIMITED = '👀 Watch "{label}" was stopped: too many events (more than {n} within {sec} sec). Use a command that prints less often, or filter its output ({id})';
const LAST_OUTPUT = 'Last output:';
const NO_OUTPUT = '(no output)';

/** 认的那几句（测试拿它对 bgJobs.ts，保证和发出去的是同一套原文）。 */
export const BG_WAKE_TEMPLATES = [FINISHED, FAILED, WATCH_ENDED, BG_TIMEOUT, WATCH_TIMEOUT, WATCH_LIMITED, LAST_OUTPUT, NO_OUTPUT];

const CAPS = { label: '[\\s\\S]+?', why: '[\\s\\S]*?', code: '-?\\d+|\\?', id: '[^\\s()（）]+', n: '\\d+', sec: '\\d+' };

/** 带输出末尾的两句：第一段是标题，空一行后是「输出末尾：…」或「（没有输出）」。 */
const WITH_TAIL = new Set([FINISHED, BG_TIMEOUT]);

function parseTail(rest: string): string | null {
  for (const lang of LANGS) {
    if (rest === trIn(lang, NO_OUTPUT)) return '';
    const head = `${trIn(lang, LAST_OUTPUT)}\n`;
    if (rest.startsWith(head)) return rest.slice(head.length);
  }
  return null;
}

/** 一条消息是后台命令 / 监视结束的唤醒吗；是就拆开。 */
export function parseBgWake(msg: WakeLike): BgWakeCard | null {
  if (!msg || msg.role !== 'user' || msg.kirolex) return null;
  const text = String(msg.content ?? '');
  if (!/^(🔔|👀)/u.test(text)) return null;
  const cut = text.indexOf('\n\n');
  for (const key of [FINISHED, FAILED, WATCH_ENDED, BG_TIMEOUT, WATCH_TIMEOUT, WATCH_LIMITED]) {
    const tail = WITH_TAIL.has(key);
    if (tail && cut < 0) continue;
    for (const lang of LANGS) {
      const g = templateRe(key, lang, CAPS).exec(tail ? text.slice(0, cut) : text)?.groups;
      if (!g) continue;
      let output: string | undefined;
      if (tail) {
        const o = parseTail(text.slice(cut + 2));
        if (o === null) continue;
        output = o;
      }
      const code = g.code === undefined ? undefined : g.code === '?' ? null : Number(g.code);
      const base = { kind: key.startsWith('👀') ? 'watch' as const : 'bg' as const, label: g.label };
      const end = { jobId: g.id, ...(output !== undefined ? { output } : {}) };
      if (key === FAILED) return { ...base, status: 'failed', reason: g.why, ...end };
      if (key === WATCH_LIMITED) return { ...base, status: 'stopped', stop: 'rate-limited', ...end };
      if (key === BG_TIMEOUT || key === WATCH_TIMEOUT) return { ...base, status: 'stopped', stop: 'timeout', duration: g.dur, ...end };
      return { ...base, status: code === 0 ? 'ok' : 'exit', exitCode: code, ...(g.dur ? { duration: g.dur } : {}), ...end };
    }
  }
  return null;
}
