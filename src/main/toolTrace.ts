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
 * 所以：非 kiro 的会话**每个调用都记**，带上工具名、入参摘要、父调用、起止时间；kiro 照旧，只多收命令类 MCP 工具（local_bash / bg_run / watch）。
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
  /** 命令类 MCP 工具（local_bash / bg_run / watch）的完整命令（`COMMAND_MAX` 以内，换行保留）—— 显示用，入参摘要只有 80 字 */
  command?: string;
  /** bg_run / watch 给人看的名字 */
  label?: string;
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

/**
 * **工具名去掉各家的 MCP 前缀**（2026-11-25 第 6 轮）：
 * Claude Code `mcp__kirolex-local__local_bash`、kiro `@kirolex-local/local_bash` / `Running local_bash from kirolex-local`、
 * Codex `kirolex-local.local_bash` / `kirolex-local/local_bash` → `local_bash`；本来就没前缀的（`Read`）原样。
 * 带空格的描述性标题（`Read src/x.ts`、kiro 的 `Running: ls`）不是工具名 → undefined。
 */
export function bareToolName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const t = name.trim().replace(/^Tool:\s*/, '');
  const from = /^Running\s+([\w.-]+)\s+from\s+\S+$/.exec(t);
  if (from) return from[1];
  if (!t || /\s/.test(t)) return undefined;
  const m = /^mcp__.+?__(.+)$/.exec(t) || /^@[^/]+\/(.+)$/.exec(t) || /^[\w-]+[./]([\w-]+)$/.exec(t);
  return m ? m[1] : t;
}

/** 「跑命令」的那几个 MCP 工具：本机 shell / 后台任务 / 监视 —— 它们是命令，进「⚡ 执行的命令」 */
export type CommandToolKind = 'local' | 'background' | 'watch';
const COMMAND_TOOLS: Record<string, CommandToolKind> = { local_bash: 'local', bg_run: 'background', watch: 'watch' };

/** 这条调用是不是命令类 MCP 工具（看工具名，没有就看标题）；执行类 kind 本身就是命令，不算这一类 */
export function commandToolKind(call: { kind?: string; title?: string; toolName?: string }): CommandToolKind | null {
  if (RUN_KINDS.has((call.kind || '').toLowerCase())) return null;
  for (const n of [call.toolName, call.title]) {
    const bare = bareToolName(n);
    if (bare && Object.prototype.hasOwnProperty.call(COMMAND_TOOLS, bare)) return COMMAND_TOOLS[bare];
  }
  return null;
}

/** 算不算「执行的命令」：执行类 kind，或者命令类 MCP 工具 */
export function isCommandCall(call: { kind?: string; title?: string; toolName?: string }): boolean {
  return RUN_KINDS.has((call.kind || '').toLowerCase()) || !!commandToolKind(call);
}

const COMMAND_MAX = 4000;

/**
 * 命令类 MCP 工具的完整命令 / label（`rawInput.command` / `rawInput.label`）。三个引擎都取（kiro 的记录也带上这两个字段）。
 * update 常常不带标题 / 工具名，用 `prev` 的判断是不是这一类；不是 → {}。
 */
export function commandTraceFields(u: any, prev?: { title?: string; toolName?: string; kind?: string }): { command?: string; label?: string } {
  const meta = u?._meta?.claudeCode;
  const call = {
    kind: u?.kind || prev?.kind,
    title: u?.title || prev?.title,
    toolName: (typeof meta?.toolName === 'string' && meta.toolName) || (typeof u?.name === 'string' && u.name) || prev?.toolName,
  };
  if (!commandToolKind(call)) return {};
  const raw = u?.rawInput;
  const command = raw && typeof raw.command === 'string' && raw.command.trim() ? clip(raw.command.trim(), COMMAND_MAX) : undefined;
  const label = raw && typeof raw.label === 'string' && raw.label.trim() ? clip(oneLine(raw.label), 80) : undefined;
  return { ...(command ? { command } : {}), ...(label ? { label } : {}) };
}

/**
 * 一条 tool_call / tool_call_update 里的工具名、入参摘要、父调用 —— 字段没有就不带。
 * `prev` = 这个调用之前记下的那条：Claude / Codex 分批发参数（首帧有工具名、rawInput 是 {}，后面的帧只带 rawInput），
 * 后面的帧要靠它认出是命令类工具，才能存下完整命令。
 */
export function toolTraceFields(u: any, prev?: { title?: string; toolName?: string; kind?: string }): ToolTraceFields {
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
    ...commandTraceFields(u, prev),
  };
}

/**
 * 这条调用要不要记进这一轮（落盘 / 挂到回合上）。
 *   kiro：原来的判据，一字不改 —— 动过文件（locations / diff）、跑过东西、或者 local_browser 的操作记录；
 *   Claude Code / Codex：每一条都记（只读的那些要在对话里留痕，子代理的调用要能归到 Task 下面）。
 */
export function shouldRecordToolCall(
  engine: Engine | undefined,
  call: { kind?: string; title?: string; toolName?: string; locations?: unknown[]; diffs?: unknown[] },
): boolean {
  if (engine && engine !== 'kiro') return true;
  const kind = (call.kind || '').toLowerCase();
  /* 命令类 MCP 工具（kind 是 other）也是「跑过东西」：原来 kiro 的 local_bash 整个不记，「执行的命令」里看不到它 */
  return !!(call.locations?.length || call.diffs?.length || isCommandCall(call) || kind === 'browser');
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
  const command = next.command || prev?.command;
  const label = next.label || prev?.label;
  return {
    ...(toolName ? { toolName } : {}),
    ...(input ? { input } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
    ...(command ? { command } : {}),
    ...(label ? { label } : {}),
  };
}
