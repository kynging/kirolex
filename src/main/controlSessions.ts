/**
 * **控制入口的「读会话 / 发消息」** 那一半的纯逻辑 —— `controlServer.ts` 的 `/sessions…` 路由用。
 *
 * 外部工具（用户本机的 Claude Code、脚本）要能「给某条会话发一句话、看结果」，又不能为此打开 CDP 调试端口
 * （那等于 RCE）。所以只给这几样：列会话、读最近几条、看状态、发一条消息 —— 不执行命令、不改设置、
 * 不切模型、不删会话。设置里的开关默认关（`config.json` 的 `features.controlSessionAccess`）。
 *
 * 这里只管形状：截断、过滤、请求体校验。会话从哪来、消息怎么发，由 index.ts 注入。
 * 只 import 纯的 `kirolexNote.ts`，测试和渲染端都能直接用（渲染端用 `isControlMessageId` 给气泡挂标签）。
 */

import { isKirolexNote } from './kirolexNote.ts';
import { questionTailText, type QuestionCard } from './elicitation.ts';

/** `GET /sessions/:id/tail?n=` 的上限 */
export const CONTROL_TAIL_MAX = 50;
export const CONTROL_TAIL_DEFAULT = 10;
/** tail 里每条消息的正文截到这么长 */
export const CONTROL_TEXT_MAX = 8000;
/** `POST /sessions/:id/send` 单条最长 */
export const CONTROL_SEND_MAX = 20000;

/**
 * **这条消息是经控制入口发出的** —— 记在消息 id 里（`user_ctl_…` / `steer_ctl_…` / `queue_ctl_…`）。
 *
 * 放在 id 里而不是另加字段：一条消息从发出到落盘要经过排队卡片（ui-state）、乐观气泡、追加指令的
 * 合并事件（`mergeIntoMessageId` / `steerParts`）、整份重写 transcript……每一处都只保证 id 原样带着走。
 * 主进程落盘时另外写一个显式的 `via: 'control'`，对话记录里看得见。
 */
const CONTROL_ID_RE = /^(user|steer|queue)_ctl_/;
/** `xs`：会话间工具（`session_send`，sessionCalls.ts）发的 —— 界面显示「📨 来自会话」而不是「经控制入口发送」。 */
const SESSION_ID_RE = /^(user|steer|queue)_xs_/;
export type ControlIdKind = 'user' | 'steer' | 'queue';
/** 消息从哪来：`ctl` = 本机工具经控制入口（HTTP），`xs` = 另一条会话经 `session_send`。 */
export type MarkOrigin = 'ctl' | 'xs';

export function controlMessageId(kind: ControlIdKind, now = Date.now(), origin: MarkOrigin = 'ctl'): string {
  return `${kind}_${origin}_${now}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isControlMessageId(id: unknown): boolean {
  return typeof id === 'string' && CONTROL_ID_RE.test(id);
}

export function isSessionMessageId(id: unknown): boolean {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

/** 这条 id 带的是哪种来源标记；没带就是 null */
export function markOrigin(id: unknown): MarkOrigin | null {
  return isControlMessageId(id) ? 'ctl' : isSessionMessageId(id) ? 'xs' : null;
}

/**
 * **一条消息换了 id 也不丢来源** —— 失败的追加指令「作为下一条发送」、启动时把没被吃掉的追加指令放回队列、
 * 中断后自动重发，都会给同一段话一个新 id。原来那条带标记（控制入口 / 别的会话），新 id 带同一种；否则返回 undefined（调用方用普通 id）。
 */
export function carryControlMark(fromId: unknown, kind: ControlIdKind, now = Date.now()): string | undefined {
  const origin = markOrigin(fromId);
  return origin ? controlMessageId(kind, now, origin) : undefined;
}

/** 写盘那一行要带的显式来源：控制入口 `{via:'control'}`、别的会话 `{via:'session'}`，否则什么都不加 */
export function viaFor(id: unknown): { via: 'control' | 'session' } | Record<string, never> {
  const origin = markOrigin(id);
  return origin === 'ctl' ? { via: 'control' } : origin === 'xs' ? { via: 'session' } : {};
}

/* ───────────────────────── 列表 ───────────────────────── */

export interface ControlSessionSummary {
  id: string;
  title: string;
  projectId: string | null;
  busy: boolean;
  /** 远程会话：机器的显示名；本机：null */
  remote: string | null;
  archived: boolean;
  updatedAt: number;
}

/** `?q=`：按标题子串过滤（不分大小写）；空 = 不过滤 */
export function filterByTitle<T extends { title: string }>(list: T[], q: string | null | undefined): T[] {
  const needle = (q || '').trim().toLowerCase();
  if (!needle) return list;
  return list.filter((s) => (s.title || '').toLowerCase().includes(needle));
}

/* ───────────────────────── tail ───────────────────────── */

export interface TranscriptLike {
  id: string;
  role: string;
  content?: string;
  /** KiroLex 自己插进对话的提示（`isKirolexNote`）—— 落盘也是 role:'user' */
  kirolex?: true | boolean;
  ts?: number;
  toolCalls?: Array<{ title?: string; kind?: string; status?: string; content?: string }>;
  /** 模型向用户的提问（`elicitation.ts`）：落盘的是关掉的，还挂着的由 index.ts 接在最后 */
  question?: QuestionCard;
}

export interface ControlTailEntry { id: string; role: string; ts: number; text: string }

/** `?n=`：默认 10，1–50 */
export function parseTailCount(raw: string | null | undefined): number {
  const n = Math.floor(Number(raw));
  if (raw == null || raw === '' || !Number.isFinite(n)) return CONTROL_TAIL_DEFAULT;
  return Math.min(CONTROL_TAIL_MAX, Math.max(1, n));
}

function clip(text: string, max = CONTROL_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 一行，去掉换行 —— 工具调用只给标题 */
function oneLine(s: string, max = 200): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * 最近 n 条，给外部看的形状。
 *
 * - `<hidden>…</hidden>`（附件引用、复制会话带的历史）不给：那是给模型的，不是对话；
 * - 工具调用**只给一行标题**（`[tool] 标题`），工具输出原文（`toolCalls[].content`、diff）一律不出去 ——
 *   里面可能是读到的文件、命令输出、凭据；
 * - 正文截到 8000 字；
 * - KiroLex 自己插进对话的提示（换模型等）落盘是 `role: 'user'`，这里给 `role: 'kirolex'` ——
 *   外部调用方不能把它当成用户发的。
 * - 提问卡片给 `role: 'question'`，正文是问题、选项、状态（`[question pending]` 就是还在等人回答）和答案。
 */
export function tailEntries(transcript: TranscriptLike[], n: number): ControlTailEntry[] {
  const count = Math.min(CONTROL_TAIL_MAX, Math.max(1, Math.floor(n) || CONTROL_TAIL_DEFAULT));
  return transcript.slice(-count).map((m) => {
    if (m.question) return { id: String(m.id), role: 'question', ts: Number(m.ts) || 0, text: clip(questionTailText(m.question)) };
    const body = String(m.content ?? '').replace(/<hidden>[\s\S]*?<\/hidden>/g, '').trim();
    const tools = (Array.isArray(m.toolCalls) ? m.toolCalls : [])
      .map((tc) => `[tool] ${oneLine(String(tc?.title || tc?.kind || 'tool'))}`);
    const text = [...tools, ...(body ? [body] : [])].join('\n');
    return { id: String(m.id), role: isKirolexNote(m) ? 'kirolex' : String(m.role), ts: Number(m.ts) || 0, text: clip(text) };
  });
}

/* ───────────────────────── send ───────────────────────── */

export type ControlSendMode = 'auto' | 'next';
export type ControlRouted = 'sent' | 'steer' | 'queued';

export type SendBodyCheck =
  | { ok: true; text: string; mode: ControlSendMode }
  | { ok: false; error: string };

/**
 * `POST /sessions/:id/send` 的请求体。
 *
 * 以 `/` 开头的不收：输入框里 `/stop` `/clear` `/model`… 是界面自己处理的命令（断开执行器、清屏、切模型），
 * 控制入口只发消息，不做这些。
 */
export function checkSendBody(body: unknown): SendBodyCheck {
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad-json' };
  const b = body as { text?: unknown; mode?: unknown };
  if (typeof b.text !== 'string' || !b.text.trim()) return { ok: false, error: 'empty-text' };
  const text = b.text.trim();
  if (text.length > CONTROL_SEND_MAX) return { ok: false, error: 'too-long' };
  if (text.startsWith('/')) return { ok: false, error: 'slash-command' };
  const mode = b.mode === undefined || b.mode === null ? 'auto' : b.mode;
  if (mode !== 'auto' && mode !== 'next') return { ok: false, error: 'bad-mode' };
  return { ok: true, text, mode };
}

/* ───────────────────────── answer ───────────────────────── */

export type AnswerBodyCheck =
  | { ok: true; questionId?: string; action: 'accept' | 'decline'; answers: Record<string, unknown> }
  | { ok: false; error: string };

export type ControlAnswerResult =
  | { ok: true; questionId: string; status: string }
  | { ok: false; status: number; error: string; missing?: string[]; invalid?: string[] };

/**
 * `POST /sessions/:id/answer` 的请求体：`{questionId?, action?: 'accept'|'decline', answers?: {字段: 值}}`。
 * `questionId` 不给 = 这条会话唯一挂着的那一张（tail 里 `role:'question'` 那条的 id）；`action` 默认 accept。
 * 值的校验（选项、必填、数字）和界面提交走同一个 `buildAcceptContent`，在 index.ts 里做。
 */
export function checkAnswerBody(body: unknown): AnswerBodyCheck {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'bad-json' };
  const b = body as { questionId?: unknown; action?: unknown; answers?: unknown };
  const action = b.action === undefined || b.action === null ? 'accept' : b.action;
  if (action !== 'accept' && action !== 'decline') return { ok: false, error: 'bad-action' };
  if (b.questionId !== undefined && (typeof b.questionId !== 'string' || !b.questionId)) return { ok: false, error: 'bad-question-id' };
  if (b.answers !== undefined && (!b.answers || typeof b.answers !== 'object' || Array.isArray(b.answers))) return { ok: false, error: 'bad-answers' };
  return { ok: true, ...(b.questionId ? { questionId: b.questionId as string } : {}), action, answers: (b.answers as Record<string, unknown>) || {} };
}
