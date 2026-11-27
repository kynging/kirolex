/**
 * **上下文占用提醒 / 压缩** —— PURE（渲染端也用：`components/ContextReminder.tsx`、`App.tsx` 的自动压缩）。
 *
 * 实测（2026-11-27，4 天日志）：每轮花费跟着上下文占用走 —— kiro 同会话同模型 12% 时约 0.9 credits/轮，
 * 80–90% 时约 10 credits/轮；原来只有引擎自己在快满时才压缩，会话长时间停在 50–90%。
 * 所以：到 60% 在输入框上方提醒一次（可关，关了到下一个 10% 档再提醒）；设置里可选「到 X% 自动压缩」（默认关）。
 * 不碰引擎自己的自动压缩，也不碰上下文回放（prime / ride-along）。
 */

export type ContextEngine = 'kiro' | 'claude' | 'codex';

/** 从多少开始提醒。 */
export const CONTEXT_REMIND_MIN_PCT = 60;
/** 自动压缩阈值：默认 / 范围。 */
export const AUTO_COMPACT_DEFAULT_PCT = 75;
export const AUTO_COMPACT_MIN_PCT = 50;
export const AUTO_COMPACT_MAX_PCT = 90;

/** 占用落在哪个 10% 档（60、70、80…，100 封顶）；不到 60 / 坏值 → null。 */
export function reminderBand(pct: number): number | null {
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < CONTEXT_REMIND_MIN_PCT) return null;
  return Math.min(100, Math.floor(pct / 10) * 10);
}

/**
 * 要不要显示提醒。`dismissedBand` = 这条会话上次关掉时所在的档（没关过 = undefined）：
 * 只有到了**更高**的档才再提醒（60 关掉 → 65 不提醒、70 提醒）。
 */
export function shouldRemind(pct: number, dismissedBand: number | null | undefined): boolean {
  const band = reminderBand(pct);
  if (band === null) return false;
  return typeof dismissedBand !== 'number' || band > dismissedBand;
}

/**
 * 各引擎现有的压缩方式（发给会话的那条斜杠命令）。
 * kiro / Claude Code：`/compact`（和「管理上下文 → 压缩」同一条）。
 * Codex：null —— codex-acp 只认第一个 prompt 块里的斜杠命令，而 KiroLex 每轮都在前面拼了上下文块，
 * `/compact` 到不了它的命令解析（同 `/plan`，见 AGENTS.md §3.4）；所以只给「换后端会话并带摘要」。
 */
export function compactCommandFor(engine: ContextEngine | undefined | null): string | null {
  if (engine === 'codex') return null;
  return '/compact';
}

/** 设置里的阈值规整到 50–90 的整数；坏值 → 默认 75。 */
export function normalizeAutoCompactPct(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return AUTO_COMPACT_DEFAULT_PCT;
  return Math.min(AUTO_COMPACT_MAX_PCT, Math.max(AUTO_COMPACT_MIN_PCT, Math.round(n)));
}

export interface AutoCompactFacts {
  /** 设置「上下文到 X% 时自动压缩」开着（默认关）。 */
  enabled: boolean;
  thresholdPct: number;
  pct: number;
  /** 这条会话刚结束了一轮（不是「刚打开 KiroLex 就停在高位」）。 */
  turnEnded: boolean;
  /** 会话空闲：不在跑、后端没被占（重建历史 / 换执行器 / 挂载中）、没有排队、没在循环 / 恢复 / 换模型。 */
  idle: boolean;
  engine: ContextEngine | undefined | null;
  /**
   * 上次自动压缩之后，占用回落到过阈值以下（或者从没自动压缩过）。
   * 压完读数还在高位（引擎没报新读数、压缩没压下来）时不连着再压 —— 否则每轮结束都发一次 /compact。
   */
  armed: boolean;
}

export type AutoCompactDecision = { compact: true; command: string } | { compact: false; reason: string };

export function decideAutoCompact(f: AutoCompactFacts): AutoCompactDecision {
  if (!f.enabled) return { compact: false, reason: 'off' };
  if (!f.turnEnded) return { compact: false, reason: 'no-turn-end' };
  if (!f.idle) return { compact: false, reason: 'busy' };
  if (!(typeof f.pct === 'number' && f.pct >= normalizeAutoCompactPct(f.thresholdPct))) return { compact: false, reason: 'below-threshold' };
  if (!f.armed) return { compact: false, reason: 'not-rearmed' };
  const command = compactCommandFor(f.engine);
  if (!command) return { compact: false, reason: 'no-compact-command' };
  return { compact: true, command };
}

/** 主进程日志里那一行（scope 是 `context`，整行 `[context] remind|compact sessionId=… pct=…`）。 */
export function contextLogLine(d: { kind?: string; sessionId?: string; pct?: number; via?: string }): string {
  const kind = d.kind === 'compact' ? 'compact' : 'remind';
  const sid = String(d.sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || '?';
  const pct = typeof d.pct === 'number' && Number.isFinite(d.pct) ? String(Math.round(d.pct)) : '?';
  const via = typeof d.via === 'string' && /^[a-z-]{1,24}$/.test(d.via) ? ` via=${d.via}` : '';
  return `${kind} sessionId=${sid} pct=${pct}${via}`;
}

/**
 * 占用回落到 60 以下（压缩 / 换后端会话之后）就把「关掉过的档」清掉：之后再涨到 60 照常提醒。
 * 0 不算回落 —— 会话刚挂上、还没报读数时那一格是占位的 0。
 */
export function nextDismissal(pct: number, dismissedBand: number | null | undefined): number | undefined {
  if (typeof dismissedBand !== 'number') return undefined;
  if (typeof pct === 'number' && Number.isFinite(pct) && pct > 0 && pct < CONTEXT_REMIND_MIN_PCT) return undefined;
  return dismissedBand;
}

/** 每条会话的自动压缩跟踪状态（渲染端 App 里按会话存一份，只活在这次运行里）。 */
export interface AutoCompactTrack {
  /** 上次看的时候在跑一轮。 */
  wasRunning: boolean;
  /** 一轮结束之后还没开始新的一轮（读数可能在轮末稍后才到，所以留着这一位直到下一轮开始）。 */
  turnEnded: boolean;
  /** 见 `AutoCompactFacts.armed`。 */
  armed: boolean;
}

/**
 * 每次会话状态 / 读数变化时走一步：返回新的跟踪状态，和要不要现在发压缩命令。
 * 发了之后 `armed = false`：压缩那一轮自己结束也是「一轮结束」，读数还没降下来时不会接着再压。
 */
export function stepAutoCompact(
  prev: AutoCompactTrack | undefined,
  f: {
    running: boolean; idle: boolean; pct: number; enabled: boolean; thresholdPct: number; engine: ContextEngine | undefined | null;
    /**
     * 这一轮不是正常结束的：用户点了停止 / 被打断、在等你重发（输入框下一条会**覆盖**那一轮）/ 出错。
     * 这样的轮末**作废**（不算「一轮结束」）：这时发 /compact 会被当成「重发」吃掉覆盖标记、把停下的那一轮从记录里截掉。
     */
    interrupted?: boolean;
  },
): { track: AutoCompactTrack; command?: string } {
  const t = prev || { wasRunning: false, turnEnded: false, armed: true };
  if (f.running) return { track: { wasRunning: true, turnEnded: false, armed: t.armed } };
  if (f.interrupted) return { track: { wasRunning: false, turnEnded: false, armed: t.armed } };
  const turnEnded = t.turnEnded || t.wasRunning;
  const armed = t.armed || (typeof f.pct === 'number' && Number.isFinite(f.pct) && f.pct < normalizeAutoCompactPct(f.thresholdPct));
  const d = decideAutoCompact({ enabled: f.enabled, thresholdPct: f.thresholdPct, pct: f.pct, turnEnded, idle: f.idle, engine: f.engine, armed });
  if (d.compact) return { track: { wasRunning: false, turnEnded: false, armed: false }, command: d.command };
  return { track: { wasRunning: false, turnEnded, armed } };
}
