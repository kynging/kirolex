/**
 * 每条回复后面那一格「这一轮的真实消耗」怎么显示。PURE（`tests/turnUsage.test.ts`）。
 *
 * 数据是主进程一轮结束时挂在助手消息上的 `turnUsage`（`main/turnUsage.ts`，落盘在 transcript）：
 *   kiro          → 「0.42 credits」
 *   Claude Code   → 「$0.031」（小于 $0.001 显示「<$0.001」）
 *   Codex         → 「上下文 +12.3k tokens」（不知道上一轮时给这一轮结束时的绝对值）
 * 拿不到真实值（老消息、引擎没报）才回退到按可见文字的估算，并标明是估算。
 */
import type { TurnUsage } from '../main/turnUsage.ts';

export type { TurnUsage };
/** 调用方的 `t`（ChatArea 里是 `useT()`，跟着界面语言） */
export type Tr = (key: string, vars?: Record<string, string | number>) => string;

const okNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const okPos = (v: unknown): v is number => okNum(v) && v >= 0;

/** transcript / IPC 里读回来的那份：形状不对就当没有 */
export function asTurnUsage(raw: any): TurnUsage | undefined {
  if (!raw || typeof raw !== 'object' || typeof raw.engine !== 'string' || !raw.engine) return undefined;
  const out: TurnUsage = { engine: raw.engine };
  for (const k of ['credits', 'cost', 'sessionCost', 'contextUsed', 'contextSize', 'contextPercent'] as const) {
    if (raw[k] === undefined) continue;
    if (!okPos(raw[k])) return undefined;
    out[k] = raw[k];
  }
  if (raw.contextDelta !== undefined) {
    if (!okNum(raw.contextDelta)) return undefined;
    out.contextDelta = raw.contextDelta;
  }
  if (typeof raw.currency === 'string' && raw.currency) out.currency = raw.currency;
  if (typeof raw.model === 'string' && raw.model) out.model = raw.model;
  return out;
}

/** 一个气泡里可能有几条带记账的助手消息：本轮值相加，累计 / 上下文 / 模型取最后一条的 */
export function combineTurnUsage(list: (TurnUsage | undefined)[]): TurnUsage | undefined {
  const xs = list.filter((u): u is TurnUsage => !!u);
  if (xs.length === 0) return undefined;
  if (xs.length === 1) return xs[0];
  const out: TurnUsage = { ...xs[xs.length - 1] };
  const sum = (k: 'credits' | 'cost' | 'contextDelta') => {
    const vals = xs.map((u) => u[k]).filter(okNum);
    if (vals.length) out[k] = vals.reduce((a, b) => a + b, 0);
  };
  sum('credits'); sum('cost'); sum('contextDelta');
  return out;
}

export const formatCredits = (n: number): string => n.toFixed(2);

export function formatMoney(v: number, currency = 'USD', digits = 3): string {
  const tiny = v > 0 && v < 0.001;
  const n = tiny ? '0.001' : v.toFixed(digits);
  if (currency === 'USD') return tiny ? `<$${n}` : `$${n}`;
  return tiny ? `<${n} ${currency}` : `${n} ${currency}`;
}

export function formatTokensShort(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1000) return `${(a / 1000).toFixed(1)}k`;
  return String(Math.round(a));
}

/** 带符号的 token 增量：「+12.3k」/「−7.7k」 */
export const signedTokens = (n: number): string => `${n < 0 ? '−' : '+'}${formatTokensShort(n)}`;

const full = (n: number) => Math.round(n).toLocaleString('en-US');

export interface TurnUsageLabel {
  text: string;
  title: string;
  /** true = 没有真实值，显示的是按可见文字的估算 */
  estimated: boolean;
}

/** 这一轮显示哪一个值（没有能显示的 → null） */
function headline(u: TurnUsage, t: Tr): string | null {
  if (okPos(u.credits)) return `${formatCredits(u.credits)} ${t('credits')}`;
  if (okPos(u.cost)) return formatMoney(u.cost, u.currency || 'USD');
  if (okNum(u.contextDelta)) return t('Context {delta} tokens', { delta: signedTokens(u.contextDelta) });
  if (okPos(u.contextUsed)) return t('Context {used} tokens', { used: formatTokensShort(u.contextUsed) });
  return null;
}

/**
 * message-actions 里那一格。`soFar`：本会话到这一轮为止的累计（`sessionTurnTotals`；Claude 优先用记录里的 `sessionCost`）。
 * `estimatedTokens`：没有真实值时的回退（null = 这一轮还在流，不显示）。
 */
export function turnUsageLabel(
  u: TurnUsage | undefined,
  estimatedTokens: number | null,
  t: Tr,
  soFar?: { credits?: number; cost?: number },
): TurnUsageLabel | null {
  const text = u ? headline(u, t) : null;
  if (!u || !text) {
    if (estimatedTokens === null) return null;
    return {
      text: t('≈ {n} tokens (estimated)', { n: estimatedTokens.toLocaleString('en-US') }),
      title: t('Estimated from the visible question and answer; the engine does not report exact per-turn token counts.'),
      estimated: true,
    };
  }
  const lines = [t('This turn: {value}', { value: text })];
  const currency = u.currency || 'USD';
  if (okPos(u.credits) && okPos(soFar?.credits)) {
    lines.push(t('This session so far: {value}', { value: `${formatCredits(soFar!.credits!)} ${t('credits')}` }));
  } else if (okPos(u.cost)) {
    const total = okPos(u.sessionCost) ? u.sessionCost : soFar?.cost;
    if (okPos(total)) lines.push(t('This session so far: {value}', { value: formatMoney(total, currency, 4) }));
    lines[0] = t('This turn: {value}', { value: formatMoney(u.cost, currency, 4) });
  }
  if (u.model) lines.push(t('Model: {model}', { model: u.model }));
  if (okNum(u.contextDelta) && !okPos(u.credits) && !okPos(u.cost)) {
    /* Codex 的本轮值就是增量，第一行已经说了 */
  } else if (okNum(u.contextDelta)) {
    lines.push(t('Context change this turn: {delta} tokens', { delta: signedTokens(u.contextDelta) }));
  }
  if (okPos(u.contextUsed)) {
    lines.push(okPos(u.contextSize) && u.contextSize > 0
      ? t('Context {used} / {size} tokens', { used: full(u.contextUsed), size: full(u.contextSize) })
      : t('Context {used} tokens', { used: full(u.contextUsed) }));
  } else if (okPos(u.contextPercent)) {
    lines.push(t('Context {pct}% used', { pct: u.contextPercent.toFixed(1) }));
  }
  return { text, title: lines.join('\n'), estimated: false };
}

interface MsgLike { id: string; role: string; turnUsage?: TurnUsage }

/** 按消息顺序的本会话累计（到这一条为止，含这一条）：消息 id → { credits, cost } */
export function sessionTurnTotals(messages: MsgLike[]): Map<string, { credits: number; cost: number }> {
  const out = new Map<string, { credits: number; cost: number }>();
  let credits = 0;
  let cost = 0;
  for (const m of messages) {
    const u = m.turnUsage;
    if (!u) continue;
    if (okPos(u.credits)) credits += u.credits;
    if (okPos(u.cost)) cost += u.cost;
    out.set(m.id, { credits, cost });
  }
  return out;
}

/**
 * 用量栏悬停的「本会话共 N 轮，平均每轮 X」。
 * N = 记过账的轮数（有 turnUsage 的回复，和有没有某一项读数无关 —— Codex 的第一轮只有 used、没有增量，照样算一轮）；
 * 平均值只在有这项读数的轮上算，少于 N 轮时说清楚是按几轮算的（例如 Codex 第一轮没有上一轮作基准）。没有记过账 → null
 */
export function sessionTurnStats(messages: MsgLike[], engine: string | undefined | null, t: Tr): string | null {
  const us = messages.map((m) => m.turnUsage).filter((u): u is TurnUsage => !!u);
  if (!us.length) return null;
  const avgOf = (vals: number[]) => vals.reduce((a, b) => a + b, 0) / vals.length;
  let vals: number[];
  let avg: (v: number) => string;
  if (!engine || engine === 'kiro') {
    vals = us.map((u) => u.credits).filter(okPos);
    avg = (v) => `${formatCredits(v)} ${t('credits')}`;
  } else if (us.some((u) => okPos(u.cost))) {
    vals = us.map((u) => u.cost).filter(okPos);
    const currency = us.find((u) => okPos(u.cost))?.currency || 'USD';
    avg = (v) => formatMoney(v, currency);
  } else {
    vals = us.map((u) => u.contextDelta).filter(okNum);
    avg = (v) => t('context {delta} tokens', { delta: signedTokens(v) });
  }
  const n = us.length;
  if (!vals.length) return t('Turns this session: {n}', { n });
  if (vals.length === n) return t('Turns this session: {n}, average {avg} per turn', { n, avg: avg(avgOf(vals)) });
  return t('Turns this session: {n}, average {avg} per turn (over the {m} turns that have it)', { n, m: vals.length, avg: avg(avgOf(vals)) });
}

/**
 * 一轮结束时主进程推来的本轮消耗挂到哪一条回复上：先认主进程落盘用的那个 id；界面上没有这个 id（只调了工具的轮、
 * 界面自己起的 id）就挂到**这一轮之内**最后一条助手消息上。
 *
 * 这一轮的边界是 `turnStart`（主进程给的：回的那条用户消息 / 后台纠正那条 KiroLex 提示 / 自发轮的来源标记）——
 * 只在它之后找；它之后夹着的 KiroLex 提示（一轮中途的说明）跳过，碰到你的消息就停。没给 `turnStart` 时碰到任何一条
 * user 消息（含 KiroLex 提示）都算边界；给了但界面上没有那一条 → 不往回找（宁可补一条，也不能改掉上一轮的值）。
 *
 * 这一轮之内一条助手消息都没有（没有正文、只跑了不记录的工具）：主进程已经为它落了一条空回复（id 就是 messageId），
 * 给了 `make` 就照样补一条，消耗马上看得到、和盘上一致；没给 → 原样返回。
 */
export function attachTurnUsage<T extends { id: string; role: string; turnUsage?: TurnUsage; kirolex?: true }>(
  list: T[], messageId: string, usage: TurnUsage, make?: () => T, turnStart?: string,
): T[] {
  let idx = list.findIndex((m) => m.id === messageId);
  if (idx < 0) {
    const startAt = turnStart ? list.findIndex((m) => m.id === turnStart) : -1;
    if (startAt >= 0) {
      /*
        从这一轮的开头往后找、碰到你的下一条消息就停：这一轮之内最后一条助手消息。刚结束的那一轮和原来从末尾往回找一样；
        **晚到的那一份**（压缩的花费在压缩真正完成时才到，那时你的下一条已经在界面上了，`main/compactWait.ts`）也挂得对 ——
        从末尾往回找会先撞上那条新消息、找不到，补一条空回复挂到最后。
      */
      for (let i = startAt + 1; i < list.length; i++) {
        if (list[i].role === 'user' && !list[i].kirolex) break;
        if (list[i].role === 'assistant') idx = i;
      }
    } else if (!turnStart) {
      for (let i = list.length - 1; i > startAt; i--) {
        if (list[i].role === 'user') break;
        if (list[i].role === 'assistant') { idx = i; break; }
      }
    }
  }
  if (idx < 0) return make ? [...list, { ...make(), turnUsage: usage }] : list;
  const next = [...list];
  next[idx] = { ...next[idx], turnUsage: usage };
  return next;
}
