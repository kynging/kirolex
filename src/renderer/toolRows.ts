/**
 * **一轮里的工具调用怎么排成行** —— 审计 3a / 12（PURE，有测试 `tests/toolRows.test.ts`）。
 *
 * 「运行的命令」「改动的文件」「浏览器操作」三块面板照旧；这里管第四块「用过的工具」：
 *   · 不属于那三块的调用（Read / Grep / Glob / WebFetch / WebSearch / Task / ToolSearch …）一条一行；
 *   · Task（子代理）那一行下面挂它派出去的调用（按 `parentToolCallId` 认），折叠显示；
 *   · 子代理里跑的命令归到 Task 下面，不再混进主线的「运行的命令」（改的文件仍然进「改动的文件」—— 那块是按文件汇总的）。
 * 只给 Claude Code / Codex 会话画（ChatArea 按引擎判）：kiro 的老判据也会落盘带 locations 的 Read，不能让它们在 kiro 会话里冒出这一块。
 */
import { RUN_KINDS } from '../main/toolTrace.ts';

export interface ToolCallLike {
  toolCallId: string;
  title: string;
  status?: string;
  kind?: string;
  content?: string;
  locations?: string[];
  diffs?: unknown[];
  toolName?: string;
  input?: string;
  parentToolCallId?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface ToolRow<T extends ToolCallLike = ToolCallLike> {
  call: T;
  /** 子代理（Task）派出去的调用，按到达顺序 */
  children: T[];
}

const MUTATING = new Set(['edit', 'create', 'write', 'delete', 'move', 'rename']);

/** 这一轮里有父调用、而且父调用也在这一轮里的那些 id —— 它们挂在父调用下面显示 */
export function nestedToolIds(calls: ToolCallLike[]): Set<string> {
  const ids = new Set(calls.map((c) => c.toolCallId));
  /* 父调用是自己的不算（实测 Agent 那一条带着自己的 id；落过盘的老记录里也有） */
  return new Set(calls.filter((c) => c.parentToolCallId && c.parentToolCallId !== c.toolCallId && ids.has(c.parentToolCallId)).map((c) => c.toolCallId));
}

/** 已经在别的面板里有一行的（命令 / 改文件 / 浏览器） */
function ownPanel(c: ToolCallLike): boolean {
  const kind = (c.kind || '').toLowerCase();
  return RUN_KINDS.has(kind) || kind === 'browser' || MUTATING.has(kind) || !!c.diffs?.length;
}

/** 是不是派子代理的那种调用（Claude Code 的 Task 工具名是 `Agent`，老版本 `Task`） */
export function isSubagentCall(c: ToolCallLike): boolean {
  return c.toolName === 'Agent' || c.toolName === 'Task';
}

/**
 * 「用过的工具」那一块的行：主线上不归别的面板管的调用 + 有孩子的调用（Task），孩子挂在下面。
 * 同一个 id 只算一次（最后一次的状态为准）。
 */
export function toolRowsOf<T extends ToolCallLike>(calls: T[]): ToolRow<T>[] {
  const byId = new Map<string, T>();
  for (const c of calls) byId.set(c.toolCallId, c);
  const all = Array.from(byId.values());
  const nested = nestedToolIds(all);
  const kids = new Map<string, T[]>();
  for (const c of all) {
    if (!nested.has(c.toolCallId)) continue;
    const list = kids.get(c.parentToolCallId!) || [];
    list.push(c);
    kids.set(c.parentToolCallId!, list);
  }
  const rows: ToolRow<T>[] = [];
  for (const c of all) {
    if (nested.has(c.toolCallId)) continue;
    const children = kids.get(c.toolCallId) || [];
    if (!children.length && ownPanel(c)) continue;
    rows.push({ call: c, children });
  }
  return rows;
}

/** 「运行的命令」只列主线上的命令：子代理跑的命令在它的 Task 下面 */
export function mainlineCommands<T extends ToolCallLike>(calls: T[]): T[] {
  const nested = nestedToolIds(calls);
  const byId = new Map<string, T>();
  for (const c of calls) {
    if (RUN_KINDS.has((c.kind || '').toLowerCase()) && !nested.has(c.toolCallId)) byId.set(c.toolCallId, c);
  }
  return Array.from(byId.values());
}

export type ToolState = 'running' | 'completed' | 'failed';
export function toolState(status?: string): ToolState {
  return status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'running';
}

/** 用时：`0.4s` / `12s` / `1m 05s`；没开始时间就是空串。还在跑用 `now` 算。 */
export function toolDuration(c: { startedAt?: number; endedAt?: number }, now: number): string {
  if (typeof c.startedAt !== 'number') return '';
  const ms = Math.max(0, (c.endedAt ?? now) - c.startedAt);
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** 结果摘要：输出的第一行非空文字（去掉代码围栏），截短 */
export function toolResultSummary(content: string | undefined, max = 140): string {
  if (!content) return '';
  const line = content.split('\n').map((l) => l.trim()).find((l) => l && !/^```/.test(l)) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** 子代理的进度：孩子里几个完成 / 失败 / 还在跑 */
export function childProgress(children: ToolCallLike[]): { done: number; failed: number; running: number } {
  let done = 0, failed = 0, running = 0;
  for (const c of children) {
    const s = toolState(c.status);
    if (s === 'completed') done++; else if (s === 'failed') failed++; else running++;
  }
  return { done, failed, running };
}
