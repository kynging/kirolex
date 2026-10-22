/**
 * **一轮被取消时，把还开着的工具调用收尾** —— 审计 3d（`docs/claude-code-feature-audit.md`）。
 *
 * 实测（scripts/claude-feature-probe.mjs 的 cancelTool / cancelTask）：Claude Code 停一轮只回 `stopReason: cancelled`，
 * 被打断的 Bash / Task 不再发最终状态，停在 `pending`（`session/load` 回放时它自己才标成 failed）。
 * 「运行的命令」面板把不是 completed / failed 的都当「运行中」，于是这一条永远显示运行中，落盘的记录里也是。
 *
 * 只对非 kiro：kiro 的取消路径不动。纯函数，不改传进来的数组。
 */
import type { Engine } from './engines.ts';

interface ToolCallLike { toolCallId: string; status?: string }

export function settleCancelledToolCalls<T extends ToolCallLike>(
  engine: Engine,
  stopReason: unknown,
  calls: T[],
): { calls: T[]; settled: string[] } {
  if (engine === 'kiro' || stopReason !== 'cancelled') return { calls, settled: [] };
  const settled: string[] = [];
  const next = calls.map((c) => {
    if (c.status === 'completed' || c.status === 'failed') return c;
    settled.push(c.toolCallId);
    return { ...c, status: 'failed' };
  });
  return settled.length ? { calls: next, settled } : { calls, settled };
}
