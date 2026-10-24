/**
 * 用量栏右边那一格显示什么（审计 F3）。PURE（`tests/sessionCost.test.ts`）。
 *
 *   kiro          → credits（`_kiro.dev/metadata` 的计费口径），原样
 *   Claude Code   → 本会话累计花费「$0.42」（主进程跨适配器进程累计，见 `main/sessionCost.ts`），悬停给本轮和 token
 *   没报 cost 的  → token 用量（Codex 只报 `used / size`）；token 也没有就整块不显示 —— 不再显示「0.00 credits」
 */
/** 调用方的 `t`（ChatArea 里是 `useT()`，跟着界面语言） */
export type Tr = (key: string, vars?: Record<string, string | number>) => string;

export interface UsageView {
  contextPercent: number;
  credits: number;
  turnMs?: number;
  /** 本会话累计花费 / 最近一轮花费（非 kiro，适配器报了 cost 才有） */
  cost?: number;
  turnCost?: number;
  currency?: string;
  /** 上下文已用 / 窗口大小（token，`usage_update` 的 used / size） */
  usedTokens?: number;
  sizeTokens?: number;
}

export type UsageChip =
  | { kind: 'credits'; text: string; title?: undefined }
  | { kind: 'cost' | 'tokens'; text: string; title: string };

const okNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function money(v: number, currency: string, digits: number): string {
  if (currency === 'USD') return `$${v.toFixed(digits)}`;
  return `${v.toFixed(digits)} ${currency}`;
}

function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

const full = (n: number) => Math.round(n).toLocaleString('en-US');

function tokensLine(u: UsageView, t: Tr): string | null {
  if (!okNum(u.usedTokens)) return null;
  return okNum(u.sizeTokens) && u.sizeTokens > 0
    ? t('Context {used} / {size} tokens', { used: full(u.usedTokens), size: full(u.sizeTokens) })
    : t('Context {used} tokens', { used: full(u.usedTokens) });
}

export function usageChip(engine: string | undefined | null, usage: UsageView | null | undefined, t: Tr): UsageChip | null {
  if (!usage) return null;
  if (!engine || engine === 'kiro') return { kind: 'credits', text: usage.credits.toFixed(2) };
  const tokens = tokensLine(usage, t);
  if (okNum(usage.cost)) {
    const currency = usage.currency || 'USD';
    const text = usage.cost > 0 && usage.cost < 0.01 ? `<${money(0.01, currency, 2)}` : money(usage.cost, currency, 2);
    const lines = [t('This session spent {total} so far', { total: money(usage.cost, currency, 4) })];
    if (okNum(usage.turnCost)) lines.push(t('Last turn {turn}', { turn: money(usage.turnCost, currency, 4) }));
    if (tokens) lines.push(tokens);
    return { kind: 'cost', text, title: lines.join('\n') };
  }
  if (tokens && okNum(usage.usedTokens)) {
    return { kind: 'tokens', text: t('{n} tokens', { n: shortTokens(usage.usedTokens) }), title: tokens };
  }
  return null;
}
