/**
 * **kiro 原生子代理：谁做了什么**（PURE，有测试 `tests/subagentGroups.test.ts`）。
 *
 * 2026-11-25「能看到子代理在跑，但看不到子代理都在干啥」：kiro 派子代理是一条 `Spawning agent crew` 调用，
 * 每个子代理用它自己的 ACP session id 发调用和消息（主进程在 `acp:update` 上带 `childSessionId`）。
 * 原来这些调用和主线混在一起显示成一串「Running: @kirolex-local/local_read」，看不出是谁做的、给了它什么任务。
 *
 * 这里把一轮里带 `childSessionId` 的调用按子代理归组，名单（`TurnSubagent`，`main/subagents.ts`）补上名字 / 任务 / 状态；
 * 名单没到之前到的调用先按 id 归组，名单到了自动补名字。主线调用不进来（`toolRows.ts` 也把它们挡在主线外面）。
 * Claude Code 的 Task 嵌套（`parentToolCallId`）不走这里。
 */
import type { TurnSubagent } from '../main/subagents.ts';
import { toolState, type ToolCallLike } from './toolRows.ts';

export interface SubagentGroup<T extends ToolCallLike = ToolCallLike> {
  sessionId: string;
  /** 名单里的名字；名单没到时是 id 的前 8 位 */
  name: string;
  agentName: string;
  task: string;
  statusType: string;
  statusMessage?: string;
  /** 名单里有它（否则只见过它的调用 / 输出） */
  named: boolean;
  /** 这一轮还在跑、而且它没结束 */
  running: boolean;
  /** 它的调用，按到达顺序（同一个 id 只算一次，最后一次的状态为准） */
  calls: T[];
  text: string;
  thinking: string;
  startedAt?: number;
  endedAt?: number;
}

export function isSubagentChildCall(c: { childSessionId?: string }): boolean {
  return !!c.childSessionId;
}

/** 一轮的几段消息各自带的 `subagents` 合成一份：同一个 id 后面的覆盖前面的，正文 / 思考取长的那份 */
export function mergeTurnSubagents(lists: (TurnSubagent[] | undefined)[]): TurnSubagent[] {
  const out: TurnSubagent[] = [];
  const at = new Map<string, number>();
  for (const list of lists) {
    for (const s of list || []) {
      const i = at.get(s.sessionId);
      if (i === undefined) { at.set(s.sessionId, out.length); out.push(s); continue; }
      const prev = out[i];
      const longer = (a?: string, b?: string) => ((b || '').length >= (a || '').length ? b : a);
      const text = longer(prev.text, s.text);
      const thinking = longer(prev.thinking, s.thinking);
      const seen = [prev.seenAtMs, s.seenAtMs].filter((n): n is number => typeof n === 'number');
      out[i] = {
        ...prev,
        ...s,
        name: s.name || prev.name,
        agentName: s.agentName || prev.agentName,
        task: s.task || prev.task,
        statusType: s.statusType === 'unknown' ? prev.statusType : s.statusType,
        ...(seen.length ? { seenAtMs: Math.min(...seen) } : {}),
        ...(text ? { text } : {}),
        ...(thinking ? { thinking } : {}),
      };
    }
  }
  return out;
}

/**
 * 「子代理 → 它的调用」分组。顺序：名单里的按名单顺序，名单里没有的按它第一条调用到达的顺序排在后面。
 * `live` = 这一轮还在跑：没在跑的一轮里，谁都不算「运行中」（执行器断了、最后一份名单没到也一样）。
 */
export function subagentGroups<T extends ToolCallLike>(calls: T[], roster: TurnSubagent[] | undefined, live: boolean): SubagentGroup<T>[] {
  const byId = new Map<string, T>();
  for (const c of calls) if (c.childSessionId) byId.set(c.toolCallId, c);
  const callsOf = new Map<string, T[]>();
  const order: string[] = [];
  for (const c of byId.values()) {
    const sid = c.childSessionId!;
    if (!callsOf.has(sid)) { callsOf.set(sid, []); order.push(sid); }
    callsOf.get(sid)!.push(c);
  }
  const info = new Map((roster || []).map((s) => [s.sessionId, s] as const));
  const ids = [...(roster || []).map((s) => s.sessionId), ...order.filter((id) => !info.has(id))];
  return ids.map((sid) => {
    const s = info.get(sid);
    const list = callsOf.get(sid) || [];
    const named = !!s?.name;
    const statusType = s?.statusType || 'unknown';
    const anyRunning = list.some((c) => toolState(c.status) === 'running');
    /* 名单说了算；名单还没到就看它有没有调用在跑（只有输出、没有调用的也算在跑） */
    const running = live && (statusType !== 'unknown' ? statusType !== 'terminated' : anyRunning || !list.length);
    const starts = [s?.seenAtMs, ...list.map((c) => c.startedAt)].filter((n): n is number => typeof n === 'number');
    const ends = list.map((c) => c.endedAt).filter((n): n is number => typeof n === 'number');
    const endedAt = running ? undefined : s?.endedAtMs ?? (ends.length ? Math.max(...ends) : undefined);
    return {
      sessionId: sid,
      name: s?.name || sid.slice(0, 8),
      agentName: s?.agentName || '',
      task: s?.task || '',
      statusType,
      ...(s?.statusMessage ? { statusMessage: s.statusMessage } : {}),
      named,
      running,
      calls: list,
      text: s?.text || '',
      thinking: s?.thinking || '',
      ...(starts.length ? { startedAt: Math.min(...starts) } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
    };
  });
}

/** 某个子代理「正在做的那一步」：最后一条还在跑的调用，没有就最后一条（同 7ac50c62 折叠态口径） */
export function currentStep<T extends ToolCallLike>(g: SubagentGroup<T>): T | undefined {
  let cur: T | undefined;
  for (const c of g.calls) if (toolState(c.status) === 'running') cur = c;
  return cur ?? g.calls[g.calls.length - 1];
}

/**
 * 把一个改动应用到「这一轮」带子代理的那条助手消息上（实时那一侧用；落盘那份由主进程一轮结束时写）：
 * 这一轮里已经有 `subagents` 的那条优先（别在几段之间来回挂），没有就最后一条助手消息；
 * 一条都没有、而且 `create` 给了，就新建一条。`apply` 拿到这一轮开始的时间和这一轮里见过的子代理 id。
 */
export function withTurnSubagents<M extends { role: string; timestamp: number; subagents?: TurnSubagent[]; toolCalls?: ToolCallLike[] }>(
  list: M[],
  isTurnStart: (m: M) => boolean,
  isTarget: (m: M) => boolean,
  apply: (prev: TurnSubagent[] | undefined, ctx: { turnStartedAt: number; knownIds: Set<string> }) => TurnSubagent[],
  create: (() => M) | null,
): M[] {
  let start = -1;
  for (let i = list.length - 1; i >= 0; i--) if (isTurnStart(list[i])) { start = i; break; }
  const knownIds = new Set<string>();
  let holder = -1;
  let lastAssistant = -1;
  for (let i = start + 1; i < list.length; i++) {
    const m = list[i];
    for (const c of m.toolCalls || []) if (c.childSessionId) knownIds.add(c.childSessionId);
    for (const s of m.subagents || []) knownIds.add(s.sessionId);
    if (m.role === 'assistant' && isTarget(m)) {
      lastAssistant = i;
      if (m.subagents?.length) holder = i;
    }
  }
  const ctx = { turnStartedAt: start >= 0 ? list[start].timestamp : 0, knownIds };
  const at = holder >= 0 ? holder : lastAssistant;
  if (at < 0) {
    if (!create) return list;
    const fresh = create();
    const next = apply(undefined, ctx);
    return next.length ? [...list, { ...fresh, subagents: next }] : list;
  }
  const prev = list[at].subagents;
  const next = apply(prev, ctx);
  if (next === prev || (!prev?.length && !next.length)) return list;
  return list.map((m, i) => (i === at ? { ...m, subagents: next } : m));
}
