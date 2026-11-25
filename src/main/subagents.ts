/**
 * KIRO'S NATIVE SUBAGENTS, AS THEY ARRIVE — pure, so the shape can be tested against the real wire.
 *
 * kiro-cli's own delegation (`chat.enableDelegate true`, an agent whose
 * `toolsSettings.subagent.availableAgents` names a worker) is NOT a message inside the parent
 * transcript. Measured with `scripts/acp-probe.mjs`:
 *
 *   - the delegation is one tool call titled **`Spawning agent crew`** (kind `other`), which is why
 *     matching on the words "subagent" / "delegate" finds nothing;
 *   - each subagent gets its OWN ACP session id and its tool calls and permission requests arrive
 *     under that id — 87 of one turn's 127 notifications came from children;
 *   - a dedicated notification `_kiro.dev/subagent/list_update` carries the roster, repeatedly,
 *     with status moving `working` -> `terminated`.
 *
 * One captured row, verbatim:
 *
 *   { sessionId: 'd3bc9734-…', sessionName: 'probe-b', agentName: 'probe-worker',
 *     initialQuery: 'Read the directory /tmp/probe-b…', status: { type: 'working', message: 'Running' },
 *     group: 'crew-Inspect probe direct', role: 'probe-worker', dependsOn: [], hasLoop: false,
 *     loopIteration: 0, loopMaxIterations: 0, createdAtMs: 1786843349979 }
 *
 * So KiroLex does not have to invent bookkeeping for 「如果有subagent在运行左侧的会话上也应该有一个tag，
 * 直到subagent被关掉」: the name, the worker agent, the task and the liveness are all given. This module
 * only normalises them and answers "is anything still running".
 */

import { trIn, type UiLang } from './uiText.ts';

export interface SubagentRow {
  /** The subagent's OWN ACP session id — not a KiroLex session id, and not the parent's. */
  sessionId: string;
  /** Human name kiro assigned (`probe-b`), falling back to the worker agent when absent. */
  name: string;
  /** Which agent config is doing the work (`probe-worker`). */
  agentName: string;
  /** The task it was given, as delegated. Useful as the tag's tooltip. */
  task: string;
  /** `working` | `terminated` | whatever kiro adds later. Only `terminated` is treated as finished. */
  statusType: string;
  statusMessage?: string;
  group?: string;
  createdAtMs?: number;
}

/** Is this notification the subagent roster? Kept here so the method name lives in one place. */
export function isSubagentListUpdate(method: string | undefined | null): boolean {
  return String(method || '') === '_kiro.dev/subagent/list_update';
}

/**
 * Normalise one roster notification. Tolerant on purpose: an unknown field must not cost the tag,
 * and a row with no session id is not a worker anyone could open, so it is dropped.
 */
export function parseSubagentList(params: any): SubagentRow[] {
  const raw = Array.isArray(params?.subagents) ? params.subagents : [];
  const out: SubagentRow[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const sessionId = String(item?.sessionId || '').trim();
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const agentName = String(item?.agentName || item?.role || '').trim();
    out.push({
      sessionId,
      name: String(item?.sessionName || '').trim() || agentName || sessionId.slice(0, 8),
      agentName,
      task: String(item?.initialQuery || '').trim(),
      statusType: String(item?.status?.type || '').trim() || 'unknown',
      ...(item?.status?.message ? { statusMessage: String(item.status.message) } : null),
      ...(item?.group ? { group: String(item.group) } : null),
      ...(Number.isFinite(item?.createdAtMs) ? { createdAtMs: Number(item.createdAtMs) } : null),
    });
  }
  return out;
}

/**
 * STILL RUNNING = not terminated.
 *
 * Deliberately not a list of "live" status names: kiro sent `working` in this measurement and may add
 * more, and a status this file has never heard of is far more likely to be another form of running than
 * to mean finished. Only the one word observed to mean "over" ends the tag.
 */
export function activeSubagents(rows: SubagentRow[] | undefined): SubagentRow[] {
  return (rows || []).filter((row) => row.statusType !== 'terminated');
}

/**
 * What the left rail shows next to the chat — 「直到subagent被关掉」 is the whole requirement, so this is
 * `null` the moment the last one terminates, and the count is of the running ones only.
 */
export function subagentTag(rows: SubagentRow[] | undefined, lang: UiLang = 'zh'): { count: number; title: string } | null {
  const live = activeSubagents(rows);
  if (!live.length) return null;
  return {
    count: live.length,
    title: live.map((row) => `${trIn(lang, '{name} ({agent})', { name: row.name, agent: row.agentName || trIn(lang, 'unknown agent') })}${row.statusMessage ? ' · ' + row.statusMessage : ''}`).join('\n'),
  };
}

/**
 * The roster is a REPLACEMENT, not a delta: every notification carries the full list, and the last one
 * of a turn is the one that says everything terminated. Merging instead of replacing is how a tag gets
 * stuck on forever.
 */
export function mergeSubagentList(_previous: SubagentRow[] | undefined, next: SubagentRow[]): SubagentRow[] {
  return next;
}

/**
 * **这一轮里的子代理，落盘用**（2026-11-25「能看到子代理在跑，但看不到子代理都在干啥」）。
 *
 * 名单（`SubagentRow`）是进程级的整份替换，只够侧栏的标记用；聊天里要的是「这一轮派了谁、给了什么任务、
 * 它自己说了什么」，而且重启后还要看得到 —— 所以每轮攒一份，`flushAssistant` 挂到助手消息的 `subagents` 上。
 * 主进程（落盘）和渲染层（实时）用同一套折叠，两边看到的一样。
 */
export interface TurnSubagent {
  /** 子代理自己的 ACP session id —— 它的工具调用带的 `childSessionId` 就是这个 */
  sessionId: string;
  /** 名单还没到时是空串（只见过它的调用 / 输出），名单到了补上 */
  name: string;
  agentName: string;
  task: string;
  /** 名单没到时是 `unknown` */
  statusType: string;
  statusMessage?: string;
  group?: string;
  /** kiro 报的创建时间（执行器那台机器的钟，远程会话可能和本机差一点） */
  createdAtMs?: number;
  /** 本机第一次见到它（名单 / 调用 / 输出）—— 用时从这里算 */
  seenAtMs?: number;
  /** 本机第一次见到它 terminated */
  endedAtMs?: number;
  /** 子代理自己的正文 / 思考（不拼进父回复），太长只留最后 `SUBAGENT_OUTPUT_MAX` 字 */
  text?: string;
  thinking?: string;
}

export const SUBAGENT_OUTPUT_MAX = 20_000;

function placeholder(sessionId: string, now: number): TurnSubagent {
  return { sessionId, name: '', agentName: '', task: '', statusType: 'unknown', seenAtMs: now };
}

function withRow(cur: TurnSubagent | undefined, row: SubagentRow, now: number): TurnSubagent {
  const ended = row.statusType === 'terminated';
  const next: TurnSubagent = {
    ...(cur || {}),
    sessionId: row.sessionId,
    name: row.name,
    agentName: row.agentName,
    task: row.task || cur?.task || '',
    statusType: row.statusType,
    seenAtMs: cur?.seenAtMs ?? now,
  };
  /* 状态说明跟着这一份名单走：terminated 那份不带 message，留着上一份的「Running」就错了 */
  if (row.statusMessage) next.statusMessage = row.statusMessage; else delete next.statusMessage;
  if (row.group) next.group = row.group;
  if (row.createdAtMs !== undefined) next.createdAtMs = row.createdAtMs;
  if (ended) next.endedAtMs = cur?.endedAtMs ?? now; else delete next.endedAtMs;
  return next;
}

/**
 * 把一份名单折进这一轮。名单是进程级的，上一轮早就结束的子代理还会留在里面 —— 只收：
 * 已经在这一轮里的、这一轮见过它调用 / 输出的（`knownIds`）、还在跑的、或者在这一轮开始之后创建的。
 * 这一轮里有过、这份名单里没有的，留着（它做过的事是这一轮的一部分）。
 */
export function foldTurnRoster(
  prev: TurnSubagent[] | undefined,
  rows: SubagentRow[],
  opts: { turnStartedAt: number; now: number; knownIds?: Iterable<string> },
): TurnSubagent[] {
  const out = (prev || []).slice();
  const at = new Map(out.map((s, i) => [s.sessionId, i] as const));
  const known = new Set(opts.knownIds || []);
  for (const row of rows) {
    const i = at.get(row.sessionId);
    if (i !== undefined) { out[i] = withRow(out[i], row, opts.now); continue; }
    const fresh = known.has(row.sessionId) || row.statusType !== 'terminated'
      || (row.createdAtMs !== undefined && row.createdAtMs >= opts.turnStartedAt);
    if (!fresh) continue;
    at.set(row.sessionId, out.length);
    out.push(withRow(undefined, row, opts.now));
  }
  return out;
}

/** 见到一个子代理的调用：名单还没到就先按 id 占一行 */
export function noteSubagent(prev: TurnSubagent[] | undefined, childSessionId: string, now: number): TurnSubagent[] {
  const list = prev || [];
  if (!childSessionId || list.some((s) => s.sessionId === childSessionId)) return list;
  return [...list, placeholder(childSessionId, now)];
}

/** 子代理的一段正文 / 思考，接到它自己那一行上 */
export function appendSubagentOutput(
  prev: TurnSubagent[] | undefined,
  childSessionId: string,
  kind: 'text' | 'thinking',
  chunk: string,
  now: number,
  max = SUBAGENT_OUTPUT_MAX,
): TurnSubagent[] {
  if (!childSessionId || !chunk) return prev || [];
  const list = noteSubagent(prev, childSessionId, now);
  return list.map((s) => {
    if (s.sessionId !== childSessionId) return s;
    let joined = (s[kind] || '') + chunk;
    if (joined.length > max) joined = `…${joined.slice(joined.length - max + 1)}`;
    return { ...s, [kind]: joined };
  });
}

/** 读盘 / IPC 来的 `subagents` 字段：认得的留下，形状不对的丢掉（读者容忍未知字段） */
export function asTurnSubagents(raw: unknown): TurnSubagent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TurnSubagent[] = [];
  for (const item of raw) {
    const sessionId = typeof item?.sessionId === 'string' ? item.sessionId.trim() : '';
    if (!sessionId) continue;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const s: TurnSubagent = {
      sessionId,
      name: str(item.name),
      agentName: str(item.agentName),
      task: str(item.task),
      statusType: str(item.statusType) || 'unknown',
    };
    if (str(item.statusMessage)) s.statusMessage = item.statusMessage;
    if (str(item.group)) s.group = item.group;
    for (const k of ['createdAtMs', 'seenAtMs', 'endedAtMs'] as const) { const n = num(item[k]); if (n !== undefined) s[k] = n; }
    if (str(item.text)) s.text = item.text;
    if (str(item.thinking)) s.thinking = item.thinking;
    out.push(s);
  }
  return out.length ? out : undefined;
}
