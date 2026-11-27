/**
 * **记忆 / 远程环境说明按需完整注入**（token 优化 3/5）—— PURE（渲染端的记忆设置也用这里的常量，所以不 import 任何 Node 模块）。
 *
 * 实测（2026-11-27，kyn-workstation 4 天日志）：每轮把三层记忆整份（21–25k 字符，frp 会话最高 39k）和远程环境说明（~2.5k）
 * 拼在用户消息前面，内容大多每轮不变，却一直累积在上下文里；而每轮花费跟上下文占用走。
 *
 * 但**每轮注入是有意的**：「每次回复都要做 X」这类规则只说一次，几轮后就会被忘（见 index.ts「Inject layered memory」那段）。
 * 所以不是改成只注入一次，而是：
 *   - 完整注入：后端会话的第一轮；压缩 / 换后端会话 / 回放之后的第一轮；任一层记忆内容变了（按哈希）之后的第一轮；
 *     距上次完整注入满 N 轮（默认 8，设置里 4–20）；或者设置「每轮都完整注入（旧行为）」打开。
 *   - 其余轮次只带「规则部分」（`<!-- always -->` 段 / 规则类二级节，≤1.5k）+ 一行完整记忆的路径。
 *   - 远程环境说明：每个后端会话只在第一轮和压缩 / 回放后完整注入，其余轮次一行简短的。
 *
 * 「压缩过了」不只靠 `/compact` 和流里那句「正在压缩」：Claude Code 自己静默自动压缩时两样都没有。
 * 所以还看后端每轮报的上下文占用（kiro 的 `contextUsagePercentage`、适配器 `usage_update` 的 used / size）——
 * 同一个后端会话里它只会涨，**大幅回落就是上下文被压缩 / 清掉了**（`noteContextUsage`）。
 *
 * 状态挂在执行器上（`SessionEntry.injectCadence`）：新执行器 = 新的一份 = 第一轮完整注入。不落盘 —— 重启后第一轮本来就该完整注入。
 */

export const MEMORY_FULL_INTERVAL_DEFAULT = 8;
export const MEMORY_FULL_INTERVAL_MIN = 4;
export const MEMORY_FULL_INTERVAL_MAX = 20;
/** 「规则部分」总长上限（字符；不含末尾那行完整记忆的路径和截断计数）。 */
export const MEMORY_RULES_MAX_CHARS = 1500;

/** 设置里的值 → 合法的间隔（坏值 = 默认，越界夹到范围内）。 */
export function normalizeMemoryFullInterval(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return MEMORY_FULL_INTERVAL_DEFAULT;
  return Math.min(MEMORY_FULL_INTERVAL_MAX, Math.max(MEMORY_FULL_INTERVAL_MIN, Math.round(n)));
}

export type MemoryMode = 'full' | 'rules';
export type RemoteMode = 'full' | 'brief';
/** 为什么这一轮完整注入记忆（进日志）：rules 轮次是 'rules'。 */
export type FullReason = 'every-turn' | 'first' | 'reset' | 'changed' | 'interval' | 'rules';

/** 一个执行器上的注入节奏。 */
export interface InjectCadence {
  /** 这份状态属于哪个后端会话（cliSessionId）—— 变了就是新后端会话的第一轮。 */
  backend: string;
  /** 这个后端会话上的第几轮（从 1 数）。 */
  turn: number;
  /** 上次完整注入记忆是第几轮。 */
  lastFullTurn: number;
  /** 上次完整注入时三层记忆的内容哈希。 */
  memoryHash: string;
  /** 后端最近一次报的上下文占用（%），看它有没有大幅回落（= 压缩过了）。 */
  contextPct?: number;
  /** 压缩 / 回放（重建历史）过了：下一轮记忆和远程说明都完整注入。 */
  reset: boolean;
  /** 上一次的决定（自动重发沿用它）。 */
  last?: TurnPlan;
}

export interface TurnPlan {
  turn: number;
  memory: MemoryMode;
  reason: FullReason;
  remote: RemoteMode;
}

export interface PlanInput {
  /** 当前后端会话 id（cliSessionId）。 */
  backend: string;
  /** 三层记忆内容的哈希；读不到记忆时 null（不影响计数）。 */
  memoryHash: string | null;
  /** 设置「每轮都完整注入（旧行为）」。 */
  fullEveryTurn: boolean;
  /** 每隔几轮完整注入一次（已 normalize）。 */
  interval: number;
  /** 这一轮带着历史回放（ride-along 快照）。 */
  replay: boolean;
  /** 自动重发（`attempt > 0`）：沿用上一次的决定，不多数一轮 —— 上一次很可能没送到后端。 */
  retry: boolean;
}

/** 决定这一轮怎么注入，并给出下一份状态（不改 `prev`）。 */
export function planInjection(prev: InjectCadence | undefined, inp: PlanInput): { plan: TurnPlan; next: InjectCadence } {
  const fresh = !prev || prev.backend !== inp.backend;
  if (!fresh && inp.retry && prev!.last) return { plan: prev!.last, next: prev! };
  const turn = fresh ? 1 : prev!.turn + 1;
  const reset = !fresh && (prev!.reset || inp.replay);
  const reason: FullReason = inp.fullEveryTurn ? 'every-turn'
    : fresh ? 'first'
    : reset ? 'reset'
    : inp.memoryHash !== null && inp.memoryHash !== prev!.memoryHash ? 'changed'
    : turn - prev!.lastFullTurn >= inp.interval ? 'interval'
    : 'rules';
  const memory: MemoryMode = reason === 'rules' ? 'rules' : 'full';
  const remote: RemoteMode = fresh || reset ? 'full' : 'brief';
  const plan: TurnPlan = { turn, memory, reason, remote };
  const next: InjectCadence = {
    backend: inp.backend,
    turn,
    lastFullTurn: memory === 'full' ? turn : prev!.lastFullTurn,
    memoryHash: memory === 'full' && inp.memoryHash !== null ? inp.memoryHash : (prev?.memoryHash ?? ''),
    ...(!fresh && prev!.contextPct !== undefined ? { contextPct: prev!.contextPct } : {}),
    reset: false,
    last: plan,
  };
  return { plan, next };
}

/** 压缩过了 / 历史重建完了：下一轮完整注入（还没有状态时下一轮本来就是第一轮）。 */
export function markContextReset(c: InjectCadence | undefined): void {
  if (c) c.reset = true;
}

/** 上下文占用回落多少算「压缩过了」：至少掉 10 个百分点，并且掉到原来的 70% 以下。 */
export const CONTEXT_DROP_MIN_POINTS = 10;
export const CONTEXT_DROP_MAX_RATIO = 0.7;

/**
 * 一帧更新里后端报的上下文占用（%）；不是用量帧返回 null。
 * kiro：`_kiro.dev/metadata` 的 `contextUsagePercentage`；Claude Code / Codex：`usage_update` 的 `used / size`（和渲染层 useAcp 同一个算法）。
 */
export function contextPercentOf(update: any): number | null {
  if (!update || typeof update !== 'object') return null;
  if (update.sessionUpdate === 'usage_update' && typeof update.used === 'number' && typeof update.size === 'number' && update.size > 0) {
    return (update.used / update.size) * 100;
  }
  if (update.method === '_kiro.dev/metadata' && typeof update.contextUsagePercentage === 'number') return update.contextUsagePercentage;
  return null;
}

/**
 * 记下后端报的上下文占用；比上一次**大幅回落**（压缩 / 清空了上下文，包括后端静默的自动压缩）→ 下一轮完整注入。
 * 返回这一帧是不是判成了压缩。还没有状态（第一轮还没发）时什么都不做：下一轮本来就是第一轮。
 */
export function noteContextUsage(c: InjectCadence | undefined, pct: number | null): boolean {
  if (!c || pct === null || !Number.isFinite(pct)) return false;
  const prev = c.contextPct;
  c.contextPct = pct;
  if (prev === undefined) return false;
  const dropped = prev - pct >= CONTEXT_DROP_MIN_POINTS && pct <= prev * CONTEXT_DROP_MAX_RATIO;
  if (dropped) c.reset = true;
  return dropped;
}

/** 远程会话非首轮带的那一行。 */
export function remoteBriefLine(hostLabel: string): string {
  return `[运行环境：远程 · ${hostLabel}]，详见首轮说明`;
}

// ---------------------------------------------------------------- 规则部分

const RULE_TITLE = /硬规矩|规矩|口径|规则/;
const ALWAYS_BLOCK = /<!--\s*always\s*-->([\s\S]*?)<!--\s*\/always\s*-->/gi;

/** 一段文字拆成「条」：顶层列表项（连同它的续行）、标题行、段落各算一条；空行结束一条。 */
function splitItems(text: string): string[] {
  const items: string[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.length) { items.push(cur.join('\n')); cur = []; } };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flush(); continue; }
    if (/^#{1,6}\s/.test(line)) { flush(); items.push(line); continue; }
    if (/^ ?([-*+]|\d+[.)])\s/.test(line)) flush();
    cur.push(line);
  }
  flush();
  return items;
}

/**
 * 一层记忆里的「规则部分」，拆成条：
 *   - 有 `<!-- always -->` … `<!-- /always -->` 标记的，只取标记里的（多段都认）；
 *   - 没有标记的，取标题含「硬规矩」「规矩」「口径」「规则」的**二级**节（标题行 + 到下一个一 / 二级标题为止的内容）。
 */
export function extractLayerRules(text: string): string[] {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  const marked = [...t.matchAll(ALWAYS_BLOCK)];
  if (marked.length) return marked.flatMap((m) => splitItems(m[1]));
  const out: string[] = [];
  let section: string[] | null = null;
  const close = () => { if (section) out.push(...splitItems(section.join('\n'))); section = null; };
  for (const line of t.split('\n')) {
    const h = /^(#{1,2})\s+(.*)$/.exec(line);
    if (h) {
      close();
      if (h[1] === '##' && RULE_TITLE.test(h[2])) section = [line];
      continue;
    }
    if (section) section.push(line);
  }
  close();
  return out;
}

export type RuleScope = 'global' | 'project' | 'session';
const SCOPE_LABEL: Record<RuleScope, string> = {
  global: '=== GLOBAL rules ===',
  project: '=== PROJECT rules ===',
  session: '=== THIS CHAT rules (highest precedence) ===',
};
const PRIORITY: RuleScope[] = ['session', 'project', 'global'];
const ORDER: RuleScope[] = ['global', 'project', 'session'];
const isHeading = (s: string) => /^#{1,6}\s/.test(s);

/**
 * 三层规则拼成「规则部分」，总长不超 `max`。超了按 会话 > 项目 > 全局 的优先级截：会话层先占，
 * 一条放不下，它和优先级更低的都截掉（截掉的条数不算标题）。一条本身就超长的整条截掉，不切半截。
 * 排列仍是 全局 → 项目 → 会话（和完整注入同序，冲突时后面的赢）。
 */
export function pickRules(layers: { scope: RuleScope; items: string[] }[], max = MEMORY_RULES_MAX_CHARS): { text: string; dropped: number } {
  const byScope = new Map(layers.map((l) => [l.scope, l.items]));
  const kept = new Map<RuleScope, string[]>();
  let used = 0;
  let dropped = 0;
  let full = false;
  for (const scope of PRIORITY) {
    const items = byScope.get(scope) || [];
    let pendingHeads: string[] = [];
    for (const item of items) {
      if (full) { if (!isHeading(item)) dropped++; continue; }
      if (isHeading(item)) { pendingHeads.push(item); continue; }
      const add = [...pendingHeads, item];
      const sec = kept.get(scope);
      const cost = (sec ? 0 : SCOPE_LABEL[scope].length + (kept.size ? 1 : 0)) + add.reduce((n, s) => n + 1 + s.length, 0);
      if (used + cost > max) { full = true; dropped++; continue; }
      used += cost;
      kept.set(scope, [...(sec || []), ...add]);
      pendingHeads = [];
    }
  }
  const text = ORDER.filter((s) => kept.has(s)).map((s) => [SCOPE_LABEL[s], ...kept.get(s)!].join('\n')).join('\n');
  return { text, dropped };
}
