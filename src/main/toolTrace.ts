/**
 * **Claude Code / Codex 的工具调用怎么记、怎么归组** —— 审计 3a / 12（`docs/claude-code-feature-audit.md`）。
 *
 * 实测（`scripts/claude-feature-probe.mjs`）：
 *   · Read / Grep / Glob / WebFetch / WebSearch / Task 这些不改文件、不跑命令的调用，原来只在运行时闪一下状态行，
 *     对话里不留任何痕迹（主进程只落盘带 locations / diff、或执行类的调用；渲染层同一个判据）。
 *   · 工具名在 `_meta.claudeCode.toolName`，入参在 `rawInput`（第一条 tool_call 常常是空的 `{}`，后面的 update 才带全）。
 *   · Task（工具名 `Agent`）派出去的子代理，它的每个调用都在**同一个** ACP sessionId 下发来，只靠
 *     `_meta.claudeCode.parentToolUseId` 指回那一条 Task。
 *
 * 所以：非 kiro 的会话**每个调用都记**，带上工具名、入参摘要、父调用、起止时间；kiro 照旧（判据一字不改）。
 * 纯函数，不 import electron；渲染层也用（同一套判据，实时和重启后看到的一样）。
 */
import type { Engine } from './engines.ts';

/** 执行类 kind（和 index.ts / useAcp.ts 的 RUN_KINDS 同一张表） */
export const RUN_KINDS = new Set(['execute', 'run', 'bash', 'shell', 'command', 'terminal']);

export interface ToolTraceFields {
  /** 工具的真名（`Read` / `Grep` / `Agent` …）—— Claude Code 在 `_meta.claudeCode.toolName` */
  toolName?: string;
  /** 入参摘要（一行，截短） */
  input?: string;
  /** 子代理里的调用：派它出去的那条 Task 的 toolCallId */
  parentToolCallId?: string;
}

const INPUT_MAX = 200;

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** 常见入参里最能说明「干了什么」的那几个键，按这个顺序取 */
const INPUT_KEYS = ['file_path', 'path', 'notebook_path', 'pattern', 'query', 'url', 'command', 'description', 'subagent_type', 'prompt', 'glob', 'include'];

/**
 * 入参摘要：认得的键按 `键=值` 拼一行（`pattern="world" path=D:\x`），认不得的整份 JSON 截短。
 * 空对象 / 没有入参 → undefined（第一条 tool_call 常是 `{}`）。
 */
export function summarizeToolInput(raw: unknown, max = INPUT_MAX): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw.trim() ? clip(oneLine(raw), max) : undefined;
  if (typeof raw !== 'object') return clip(String(raw), max);
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (!keys.length) return undefined;
  const parts: string[] = [];
  for (const k of INPUT_KEYS) {
    const v = obj[k];
    if (v === undefined || v === null || v === '') continue;
    const s = typeof v === 'string' ? oneLine(v) : oneLine(JSON.stringify(v));
    parts.push(`${k}=${typeof v === 'string' && /\s/.test(v.trim()) ? JSON.stringify(clip(s, 80)) : clip(s, 80)}`);
  }
  if (parts.length) return clip(parts.join(' '), max);
  let json = '';
  try { json = JSON.stringify(obj); } catch { return undefined; }
  return json && json !== '{}' ? clip(oneLine(json), max) : undefined;
}

/** 一条 tool_call / tool_call_update 里的工具名、入参摘要、父调用 —— 字段没有就不带 */
export function toolTraceFields(u: any): ToolTraceFields {
  const meta = u?._meta?.claudeCode;
  const toolName = typeof meta?.toolName === 'string' && meta.toolName ? meta.toolName
    : typeof u?.name === 'string' && u.name ? u.name : undefined;
  /* 实测：Agent（Task）那一条自己的 update 上 parentToolUseId 就是它自己的 id —— 那不是父调用，丢掉（否则它被当成自己的孩子藏起来） */
  const parent = typeof meta?.parentToolUseId === 'string' && meta.parentToolUseId && meta.parentToolUseId !== u?.toolCallId ? meta.parentToolUseId : undefined;
  const input = summarizeToolInput(u?.rawInput);
  return {
    ...(toolName ? { toolName } : {}),
    ...(input ? { input } : {}),
    ...(parent ? { parentToolCallId: parent } : {}),
  };
}

/**
 * 这条调用要不要记进这一轮（落盘 / 挂到回合上）。
 *   kiro：原来的判据，一字不改 —— 动过文件（locations / diff）、跑过东西、或者 local_browser 的操作记录；
 *   Claude Code / Codex：每一条都记（只读的那些要在对话里留痕，子代理的调用要能归到 Task 下面）。
 */
export function shouldRecordToolCall(
  engine: Engine | undefined,
  call: { kind?: string; locations?: unknown[]; diffs?: unknown[] },
): boolean {
  if (engine && engine !== 'kiro') return true;
  const kind = (call.kind || '').toLowerCase();
  return !!(call.locations?.length || call.diffs?.length || RUN_KINDS.has(kind) || kind === 'browser');
}

/** 起止时间：第一次见到记 startedAt；第一次进入 completed / failed 记 endedAt（之后不再改） */
export function toolTimes(
  prev: { startedAt?: number; endedAt?: number } | undefined,
  status: string | undefined,
  now: number,
): { startedAt: number; endedAt?: number } {
  const startedAt = prev?.startedAt ?? now;
  const ended = prev?.endedAt ?? (status === 'completed' || status === 'failed' ? now : undefined);
  return ended !== undefined ? { startedAt, endedAt: ended } : { startedAt };
}

/** 合并一条 update 带来的追踪字段：新值优先，没带的沿用旧的（update 只带变了的字段） */
export function mergeToolTrace<T extends ToolTraceFields>(prev: T | undefined, next: ToolTraceFields): ToolTraceFields {
  const toolName = next.toolName || prev?.toolName;
  const input = next.input || prev?.input;
  const parentToolCallId = next.parentToolCallId || prev?.parentToolCallId;
  return {
    ...(toolName ? { toolName } : {}),
    ...(input ? { input } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
  };
}
