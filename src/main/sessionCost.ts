/**
 * **本会话花费**（Claude Code / Codex 会话的用量栏，审计 F3）。PURE（`tests/sessionCost.test.ts`）。
 *
 * 协议语义：ACP `UsageUpdate.cost` 是 *Cumulative session cost*。claude-agent-acp 0.88.0 填的是 SDK result 的
 * `total_cost_usd` —— **这个适配器进程**里累计的：进程重启（换后端、重开会话、断线重连）就从 0 重新数。
 * codex-acp 只发 `{ used, size }`，不带 cost。
 *
 * 2026-10-24 真机核实：旧进程 0.0309 → 0.0521；新进程 session/load、session/resume 之后第一帧 0.0214 / 0.0216 ——
 * 只是那一轮，**不带**之前的花费（Claude Code 没把旧花费恢复进新进程）。
 *
 * 所以记录里存两样：`total`（这条会话一共花了多少，跨进程累计）和 `reading`（上一帧的读数）。
 * 计数器的边界由调用方明确给（`freshCounter`：新执行器 / 新后端会话的第一帧，主进程知道）—— 那一帧整笔算这一轮；
 * 同一个计数器里本轮 = 新读数 − 上次读数。光看读数认不出边界：新进程第一轮比旧进程整段还贵时读数并不变小。
 * 读数变小但调用方没说换了（不该发生）仍按重来处理，不往回扣。
 */

export interface SessionCost {
  /** 这条会话累计花费（跨适配器进程） */
  total: number;
  /** 最近一轮的花费 */
  turn: number;
  /** 适配器上一次报的累计值（判断计数器有没有重来） */
  reading: number;
  currency: string;
  at: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** 一帧里的花费；不是带 cost 的 `usage_update` 就是 null */
export function costOfUpdate(update: any): { amount: number; currency: string } | null {
  if (update?.sessionUpdate !== 'usage_update' || !update.cost || typeof update.cost !== 'object') return null;
  const amount = num(update.cost.amount);
  if (amount === null) return null;
  const currency = typeof update.cost.currency === 'string' && update.cost.currency ? update.cost.currency : 'USD';
  return { amount, currency };
}

export function foldSessionCost(
  prev: SessionCost | undefined | null,
  cost: { amount: number; currency: string },
  now: number,
  freshCounter = false,
): SessionCost {
  const total = num(prev?.total);
  const reading = num(prev?.reading);
  if (total === null) return { total: cost.amount, turn: cost.amount, reading: cost.amount, currency: cost.currency, at: now };
  const turn = !freshCounter && reading !== null && cost.amount >= reading ? cost.amount - reading : cost.amount;
  return { total: total + turn, turn, reading: cost.amount, currency: cost.currency, at: now };
}
