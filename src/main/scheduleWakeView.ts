/**
 * 定时唤醒在会话里怎么显示 —— 纯解析，不碰发给模型的文字。
 *
 * 到点发进会话的那条（`runScheduledJob`：`prompt + scheduleGoalSuffix`）原样落盘、原样发给模型；这里只是把它
 * **拆开来显示**成一张紧凑的「⏰ 定时」卡片：哪个定时、第几次、发生了什么（检查有变化 / 目标已达成 / 检查出错 /
 * 按时唤醒），检查输出只摆和上一次相比变了的行；完整 prompt、目标、完整输出、给模型的说明都折进「详情」。
 *
 * 认法：新消息看 id（`sched_<定时 id>[_r<第几次>]_<时间>`，`scheduleWakeMessageId`）；旧记录看正文特征
 * （「🎯 目标：」后缀 + 检查结果那行或「这是定时任务 …」那行，中英两版都认）。认不出来的返回 null，照旧当用户消息。
 *
 * 结束那句（`scheduleEndedText`）和连续出错自动暂停那句（`planScheduleCheck` 的 `note`）是 KiroLex 提示，
 * `parseScheduleEnd` 认出来后画成同一种卡片的收尾样式；主进程写它们时带 `noteGroup: schedule-end:<id>`，用来找回定时的名字。
 */

import { trIn, type UiLang } from './uiText.ts';

export type ScheduleWakeStatus = 'changed' | 'achieved' | 'error' | 'timer';

export interface ScheduleWakeCard {
  /** 定时任务的 id（消息 id 或说明行里带的）；都没有就 undefined。 */
  scheduleId?: string;
  /** prompt 的前 20 个字（定时任务没有单独的名字）。 */
  name: string;
  /** 第几次（消息 id 里带的；旧消息由 `scheduleWakeCards` 按出现顺序数）。 */
  run?: number;
  status: ScheduleWakeStatus;
  /** 检查命令连续出错、任务已自动暂停。 */
  paused: boolean;
  /** 检查输出里和上一次相比变了的行：新出现的和没了的（`removed`）；第一次 = 全部非空行。界面只摆前 `SCHEDULE_CARD_LINES` 行。 */
  changedLines: ChangedLine[];
  details: {
    prompt: string;
    until?: string;
    /** 检查结果那行（给模型看的，例如「🔎 检查命令退出码 1（还没达成），输出和上次不同：」）。 */
    checkHeader?: string;
    /** 完整的检查输出（「（没有输出）」记成空串）。 */
    checkOutput?: string;
    /** 「（这是定时任务 … 结束它 …）」那句给模型的说明。 */
    note?: string;
  };
}

export interface ScheduleEndCard {
  kind: 'ended' | 'paused';
  scheduleId?: string;
  /** 一行说清结局，例如「目标达成（每 5 分钟，共运行 12 次）」。 */
  outcome: string;
  until?: string;
  /** 暂停那句后面跟的检查输出 / 旧写法第一行后面的内容。 */
  output?: string;
}

/** 卡片上直接摆几行变化的输出，超出的「展开」。 */
export const SCHEDULE_CARD_LINES = 5;

const LANGS: UiLang[] = ['zh', 'en'];

const GOAL = '🎯 Goal: {until}';
const NOTE = '(This is scheduled task {id}. Once the goal is reached, call schedule_delete with id {id} to end it; until then just finish this turn and you will be called again on schedule.)';
const HEADERS: { key: string; status: ScheduleWakeStatus; paused?: true }[] = [
  { key: '🔎 The check command exited with 1 (not reached yet), and its output changed:', status: 'changed' },
  { key: '✅ The check command exited with 0: the goal is reached and this scheduled task has ended. Give the final report.', status: 'achieved' },
  { key: '⚠️ The check command failed ({why}) {n} times in a row, so this scheduled task paused itself until the user resumes it:', status: 'error', paused: true },
  { key: '⚠️ The check command failed ({why}), {n} time(s) in a row; after {max} the task pauses itself:', status: 'error' },
];
const NO_OUTPUT = '(no output)';
const ENDED_GOAL = 'Scheduled task ended: {why}, but the goal was not reached yet ({schedule}, ran {n} time(s)). Goal: {until}';
const ENDED = 'Scheduled task ended: {why} ({schedule}, ran {n} time(s))';
const PAUSED_NOTE = '⏸️ The check command of a scheduled task failed {n} times in a row ({why}), so the task was paused. Fix the command, then resume it at the top of the chat, or cancel it.';

const SCHEDULE_END_GROUP = 'schedule-end:';

/** 结束 / 暂停那句的 `noteGroup`（主进程写、这里读回是哪个定时）。 */
export function scheduleEndGroup(id: string): string {
  return `${SCHEDULE_END_GROUP}${id}`;
}

/** 定时唤醒那条用户消息的 id：`sched_<定时 id>_r<第几次>_<时间>`（没给次数就没有 `_r` 段，同旧写法）。 */
export function scheduleWakeMessageId(ref: string | undefined, run: number | undefined, now: number): string {
  return `sched_${ref}${run ? `_r${run}` : ''}_${now}`;
}

/** 反过来拆 id。旧写法没有 `_r` 段。不是定时唤醒的 id 返回 null。 */
export function parseWakeId(id: string | undefined): { scheduleId: string; run?: number } | null {
  const m = /^sched_(.+?)(?:_r(\d+))?_(\d+)$/.exec(String(id || ''));
  if (!m || m[1] === 'end') return null;
  return { scheduleId: m[1], ...(m[2] ? { run: Number(m[2]) } : {}) };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 模板（`{name}` 占位）→ 整行匹配的正则；同名占位第二次出现用反向引用。 */
const reCache = new Map<string, RegExp>();
function templateRe(key: string, lang: UiLang, caps: Record<string, string> = {}): RegExp {
  const k = `${lang}\u0000${key}`;
  const hit = reCache.get(k);
  if (hit) return hit;
  const seen = new Set<string>();
  const src = trIn(lang, key).split(/(\{\w+\})/).map((part) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (!m) return esc(part);
    if (seen.has(m[1])) return `\\k<${m[1]}>`;
    seen.add(m[1]);
    return `(?<${m[1]}>${caps[m[1]] ?? '.+?'})`;
  }).join('');
  const re = new RegExp(`^${src}$`);
  reCache.set(k, re);
  return re;
}

/** prompt 的前 20 个字（空白压成一个空格），长了加「…」。 */
export function scheduleName(prompt: string): string {
  const flat = Array.from(String(prompt || '').replace(/\s+/g, ' ').trim());
  return flat.length > 20 ? `${flat.slice(0, 20).join('')}…` : flat.join('');
}

/** 变了的一行：新出现的（`removed` 没有），或者上一次有、这一次没了的（`removed: true`）。 */
export interface ChangedLine {
  text: string;
  removed?: true;
}

/** 超过这么多格（上次行数 × 这次行数）就不做逐行对齐，退回按行计数（删掉的在前、新出现的在后）。 */
const DIFF_CELLS_MAX = 250_000;

const outputLines = (text: string) => String(text || '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());

/**
 * `cur` 和 `prev` 相比变了的行：新出现的和**没了的**（按行对齐，同样的行出现几次就抵掉几次；空行不算）。
 * 没有上一次 = 这次全部非空行都算新出现的。
 */
export function changedLines(cur: string, prev?: string): ChangedLine[] {
  const b = outputLines(cur);
  if (prev === undefined) return b.map((text) => ({ text }));
  const a = outputLines(prev);
  if (a.length * b.length > DIFF_CELLS_MAX) {
    const left = new Map<string, number>();
    for (const l of b) left.set(l, (left.get(l) ?? 0) + 1);
    const removed: ChangedLine[] = [];
    for (const l of a) {
      const n = left.get(l) ?? 0;
      if (n > 0) left.set(l, n - 1);
      else removed.push({ text: l, removed: true });
    }
    const seen = new Map<string, number>();
    for (const l of a) seen.set(l, (seen.get(l) ?? 0) + 1);
    const added = b.filter((l) => {
      const n = seen.get(l) ?? 0;
      if (n > 0) { seen.set(l, n - 1); return false; }
      return true;
    }).map((text) => ({ text }));
    return [...removed, ...added];
  }
  /* 最长公共子序列：lcs[i][j] = a[i..] 和 b[j..] 的公共行数 */
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: ChangedLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i += 1; j += 1; }
    else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ text: a[i++], removed: true });
    else out.push({ text: b[j++] });
  }
  return out;
}

export interface WakeLike {
  id?: string;
  role?: string;
  content?: string;
  kirolex?: true | boolean;
  noteGroup?: string;
}

/**
 * 一条消息是定时唤醒吗；是就拆开。`prevOutput`：同一个定时上一次的检查输出（算变了的行）；`run`：id 里没带时由调用方数。
 */
export function parseScheduleWake(msg: WakeLike, opts: { prevOutput?: string; run?: number } = {}): ScheduleWakeCard | null {
  if (!msg || msg.role !== 'user' || msg.kirolex) return null;
  const text = String(msg.content ?? '');
  const byId = parseWakeId(msg.id);

  /* 「🎯 目标：」后缀从最后一处算（prompt 里引用了这几个字也不会切错） */
  let at = -1;
  let goalLang: UiLang = 'zh';
  for (const lang of LANGS) {
    const i = text.lastIndexOf(`\n\n${trIn(lang, GOAL).split('{until}')[0]}`);
    if (i > at) { at = i; goalLang = lang; }
  }
  const base = { run: byId?.run ?? opts.run, paused: false };
  if (at < 0) {
    if (!byId) return null;
    return { ...base, scheduleId: byId.scheduleId, name: scheduleName(text), status: 'timer', changedLines: [], details: { prompt: text } };
  }

  const prompt = text.slice(0, at);
  const rest = text.slice(at + 2).split('\n');
  let note: string | undefined;
  let noteId: string | undefined;
  const last = rest[rest.length - 1];
  for (const lang of LANGS) {
    const m = templateRe(NOTE, lang, { id: '\\S+?' }).exec(last);
    if (m) { note = last; noteId = m.groups?.id; rest.pop(); break; }
  }
  let headAt = -1;
  let head: (typeof HEADERS)[number] | undefined;
  for (let i = 1; i < rest.length && headAt < 0; i += 1) {
    for (const lang of LANGS) {
      head = HEADERS.find((h) => templateRe(h.key, lang).test(rest[i]));
      if (head) { headAt = i; break; }
    }
  }
  /* 旧记录只凭正文认：除了「🎯 目标：」还得有检查结果那行或说明那行，不然可能就是你自己写的字 */
  if (!byId && !note && headAt < 0) return null;

  const goalHead = trIn(goalLang, GOAL).split('{until}')[0];
  const until = rest.slice(0, headAt < 0 ? rest.length : headAt).join('\n').slice(goalHead.length);
  let checkOutput: string | undefined;
  if (headAt >= 0) {
    const raw = rest.slice(headAt + 1).join('\n');
    checkOutput = LANGS.some((lang) => raw === trIn(lang, NO_OUTPUT)) ? '' : raw;
  }
  const status: ScheduleWakeStatus = head?.status ?? 'timer';
  return {
    ...base,
    paused: !!head?.paused,
    scheduleId: byId?.scheduleId ?? noteId,
    name: scheduleName(prompt),
    status,
    changedLines: checkOutput !== undefined ? changedLines(checkOutput, opts.prevOutput) : [],
    details: {
      prompt,
      until,
      ...(head ? { checkHeader: rest[headAt], checkOutput } : {}),
      ...(note ? { note } : {}),
    },
  };
}

/**
 * 一条会话里所有的定时唤醒（消息 id → 卡片）。同一个定时（按 id；没有 id 按 prompt）串起来：
 * id 里没带第几次的旧消息按出现顺序数，变了的行和这个定时上一次的检查输出比。
 */
export function scheduleWakeCards(messages: readonly WakeLike[]): Map<string, ScheduleWakeCard> {
  const out = new Map<string, ScheduleWakeCard>();
  const counts = new Map<string, number>();
  const prev = new Map<string, string>();
  for (const m of messages) {
    if (m?.role !== 'user' || m.kirolex || !m.id) continue;
    const first = parseScheduleWake(m);
    if (!first) continue;
    const key = first.scheduleId ?? `prompt:${first.details.prompt}`;
    const run = first.run ?? (counts.get(key) ?? 0) + 1;
    counts.set(key, run);
    const card = parseScheduleWake(m, { prevOutput: prev.get(key), run });
    if (!card) continue;
    if (card.details.checkOutput !== undefined) prev.set(key, card.details.checkOutput);
    out.set(m.id, card);
  }
  return out;
}

/** KiroLex 提示里的定时结束 / 自动暂停那句；不是就 null。 */
export function parseScheduleEnd(msg: WakeLike): ScheduleEndCard | null {
  if (!msg || msg.role !== 'user' || !msg.kirolex) return null;
  const text = String(msg.content ?? '').trim().replace(/^⏰\s*/, '');
  const group = String(msg.noteGroup || '');
  const scheduleId = group.startsWith(SCHEDULE_END_GROUP) ? group.slice(SCHEDULE_END_GROUP.length) : undefined;
  const withId = <T extends object>(card: T) => ({ ...card, ...(scheduleId ? { scheduleId } : {}) });
  const [firstLine, ...more] = text.split('\n');
  const output = more.join('\n');
  for (const lang of LANGS) {
    /* 结束语的开头（不带变量那段）；旧写法前面还多一个 ⏰，上面已经去掉 */
    const head = trIn(lang, ENDED).split('{why}')[0];
    if (!text.startsWith(head)) continue;
    const goal = templateRe(ENDED_GOAL, lang, { until: '[\\s\\S]+' }).exec(text);
    if (goal?.groups) {
      const until = goal.groups.until;
      return withId({ kind: 'ended' as const, outcome: text.slice(head.length, text.length - until.length).replace(/[.。]?\s*(Goal:|目标：)\s*$/, ''), until });
    }
    if (templateRe(ENDED, lang).test(text)) return withId({ kind: 'ended' as const, outcome: text.slice(head.length) });
    /* 更早的写法：「⏰ 定时任务结束：运行次数用完\n每天 09:00 · 共运行 3 次」—— 第一行是结局，后面的进详情 */
    return withId({ kind: 'ended' as const, outcome: firstLine.slice(head.length), ...(output ? { output } : {}) });
  }
  for (const lang of LANGS) {
    if (templateRe(PAUSED_NOTE, lang).test(firstLine)) {
      return withId({ kind: 'paused' as const, outcome: firstLine.replace(/^⏸️\s*/, ''), output });
    }
  }
  return null;
}
