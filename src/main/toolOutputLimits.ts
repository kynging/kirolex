/**
 * **本机工具交给模型的输出上限** —— PURE（渲染端的设置页也用，所以这里不 import 任何 Node 模块）。
 *
 * 实测（2026-11-27）：一轮 $64.86 的会话里连着二十几次 `local_*` 调用，每次最多 128KB 进上下文。
 * 所以默认 24KB（开头 8KB + 结尾 16KB，中间一行说完整输出存在哪），设置里可调 16–128KB。
 * 截断和落盘在 `toolOutputCap.ts`。
 */

export const TOOL_OUTPUT_DEFAULT_KB = 24;
export const TOOL_OUTPUT_MIN_KB = 16;
export const TOOL_OUTPUT_MAX_KB = 128;

/** 设置里的值 → 合法的 KB 数（坏值 = 默认，越界夹到范围内）。 */
export function normalizeToolOutputKb(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return TOOL_OUTPUT_DEFAULT_KB;
  return Math.min(TOOL_OUTPUT_MAX_KB, Math.max(TOOL_OUTPUT_MIN_KB, Math.round(n)));
}

/** 上限拆成头 / 尾：头三分之一（报错、命令回显多在开头），尾三分之二（结果、退出前的报错在结尾）。 */
export function toolOutputSplit(maxBytes: number): { head: number; tail: number } {
  const head = Math.floor(maxBytes / 3);
  return { head, tail: maxBytes - head };
}
