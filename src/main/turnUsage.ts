/**
 * **每一轮的真实消耗**（每条回复后面那一格）。PURE（`tests/turnUsage.test.ts`）。
 *
 * 只读引擎上报的值，不按单价自己换算：
 *   kiro         → 本轮 credits = 这一轮里收到的 `_kiro.dev/metadata` 的 `meteringUsage[0].value` 之和
 *                  （一轮可能有多帧，按轮累加；和用量栏累加的是同一个值）；
 *   Claude Code  → 本轮花费 = `sessionCost.ts` 的 `foldSessionCost` 算出的 `turn`（换后端 / 新进程第一帧的边界在那边判，
 *                  这里只把这一轮里每帧的 `turn` 加起来）；
 *   Codex        → 没有 cost：记这一轮结束时的上下文 used，以及相对上一轮结束时的增量。
 *
 * 主进程在每一帧（`wireSession` 的 update）喂 `foldTurnFrame`，一轮结束落盘助手消息时（`flushAssistant`）
 * 用 `finishTurnUsage` 收成一份 `TurnUsage` 挂在那条消息上 —— 用户发的轮、定时 / 后台 / 自发轮都走这一处。
 */

export interface TurnUsage {
  engine: string;
  /** kiro：本轮 credits */
  credits?: number;
  /** Claude Code：本轮花费 */
  cost?: number;
  currency?: string;
  /** Claude Code：这一轮结束时本会话累计花费（`SessionCost.total`） */
  sessionCost?: number;
  /** 这一轮结束时的上下文已用 / 窗口（token，`usage_update` 的 used / size） */
  contextUsed?: number;
  contextSize?: number;
  /** 上下文占用百分比（kiro 的 `contextUsagePercentage`，或 used / size） */
  contextPercent?: number;
  /** 相对上一轮结束时的上下文增量（上一轮不知道就没有） */
  contextDelta?: number;
  model?: string;
}

/** 一轮之内攒着的（还没收尾） */
export interface TurnUsageAcc {
  credits?: number;
  cost?: number;
  currency?: string;
  sessionCost?: number;
  contextUsed?: number;
  contextSize?: number;
  contextPercent?: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * 一帧喂进来。`costFold`：这一帧在 `foldSessionCost` 之后的结果（只有带 cost 的 `usage_update` 才有）。
 * 和本轮消耗无关的帧原样返回 `acc`。
 */
export function foldTurnFrame(
  acc: TurnUsageAcc | undefined,
  update: any,
  costFold?: { turn: number; total: number; currency: string } | null,
): TurnUsageAcc | undefined {
  if (update?.sessionUpdate === '_kiro_internal' && update.method === '_kiro.dev/metadata') {
    const credits = num(update.meteringUsage?.[0]?.value);
    const pct = num(update.contextUsagePercentage);
    if (credits === null && pct === null) return acc;
    const next: TurnUsageAcc = { ...acc };
    if (credits !== null) next.credits = (next.credits ?? 0) + credits;
    if (pct !== null) next.contextPercent = pct;
    return next;
  }
  if (update?.sessionUpdate === 'usage_update') {
    const used = num(update.used);
    const size = num(update.size);
    const turn = num(costFold?.turn);
    if (used === null && turn === null) return acc;
    const next: TurnUsageAcc = { ...acc };
    if (used !== null) {
      next.contextUsed = used;
      if (size !== null && size > 0) { next.contextSize = size; next.contextPercent = (used / size) * 100; }
    }
    if (turn !== null) {
      next.cost = (next.cost ?? 0) + turn;
      const total = num(costFold?.total);
      if (total !== null) next.sessionCost = total;
      next.currency = costFold?.currency || 'USD';
    }
    return next;
  }
  return acc;
}

/** 一轮结束：收成挂在助手消息上的那一份。一个真实值都没有 → null（界面回退到估算）。 */
export function finishTurnUsage(
  acc: TurnUsageAcc | undefined,
  opts: { engine: string; model?: string; prevContextUsed?: number | null },
): TurnUsage | null {
  if (!acc || (acc.credits === undefined && acc.cost === undefined && acc.contextUsed === undefined)) return null;
  const out: TurnUsage = { engine: opts.engine };
  if (acc.credits !== undefined) out.credits = acc.credits;
  if (acc.cost !== undefined) { out.cost = acc.cost; out.currency = acc.currency || 'USD'; }
  if (acc.sessionCost !== undefined) out.sessionCost = acc.sessionCost;
  if (acc.contextUsed !== undefined) out.contextUsed = acc.contextUsed;
  if (acc.contextSize !== undefined) out.contextSize = acc.contextSize;
  if (acc.contextPercent !== undefined) out.contextPercent = acc.contextPercent;
  const prev = num(opts.prevContextUsed);
  if (acc.contextUsed !== undefined && prev !== null) out.contextDelta = acc.contextUsed - prev;
  if (opts.model) out.model = opts.model;
  return out;
}
