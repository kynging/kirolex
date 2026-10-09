/**
 * **哪些会话在忙** —— 控制入口（agent-board「拉取并重启」）据此决定现在退还是等。
 *
 * 判据只用 main 里可靠的状态，由 index.ts 收集好传进来（这里不碰 electron，单测直接喂假状态）：
 *
 * - `turn`     —— session/prompt 还没返回（`entry.busy`），或者执行器正在 attach / 换模型。
 * - `schedule` —— 循环 / 定时任务正在跑一轮（`schedulesInFlight`）。
 * - `revise`   —— 侧栏 review 排着、还没跑完的改写（`revisePending`）。
 * - `queued`   —— 渲染端排着等发送的消息（同步到 ui-state 的 `kirolex-queues`）。
 *
 * **`queued` 报出来，但不挡退出**：等待退出期间排队消息是冻住的（不再开始新一轮），如果它也算
 * "还没完"就永远等不完。它本来就落盘在 ui-state.json，重启后原样恢复，所以不会丢。
 */

export type BusyReason = 'turn' | 'schedule' | 'revise' | 'queued';

export interface BusySession {
  id: string;
  title?: string;
  reasons: BusyReason[];
  /** 排着的消息条数（只有 `queued` 时有意义） */
  queued?: number;
}

export interface BusyInput {
  /** 有一轮在飞（或正在 attach / 换执行器）的会话 */
  turns: Iterable<string>;
  /** 正在跑一轮的循环 / 定时任务所属的会话 */
  scheduleRuns?: Iterable<string>;
  /** sessionId → 还没跑完的改写条数 */
  revisePending?: Iterable<[string, number]>;
  /** sessionId → 排着的消息条数 */
  queues?: Iterable<[string, number]>;
  titleOf?: (sessionId: string) => string | undefined;
}

export function collectBusySessions(input: BusyInput): BusySession[] {
  const byId = new Map<string, BusySession>();
  const add = (id: string, reason: BusyReason) => {
    if (!id) return;
    let s = byId.get(id);
    if (!s) byId.set(id, s = { id, reasons: [] });
    if (!s.reasons.includes(reason)) s.reasons.push(reason);
    return s;
  };
  for (const id of input.turns) add(id, 'turn');
  for (const id of input.scheduleRuns ?? []) add(id, 'schedule');
  for (const [id, n] of input.revisePending ?? []) if (n > 0) add(id, 'revise');
  for (const [id, n] of input.queues ?? []) {
    if (n > 0) { const s = add(id, 'queued'); if (s) s.queued = n; }
  }
  const out = [...byId.values()];
  if (input.titleOf) {
    for (const s of out) {
      try { const t = input.titleOf(s.id); if (t) s.title = t; } catch { /* 标题只是显示 */ }
    }
  }
  return out;
}

/** 这条会话是不是**还在跑**（要等它跑完才能退）—— 只排着消息的不算，见文件头 */
export function blocksQuit(s: BusySession): boolean {
  return s.reasons.some((r) => r !== 'queued');
}

/** `kirolex-queues`（渲染端落盘的 `{ [sessionId]: QueuedMessage[] }`）→ 每条会话排着几条 */
export function queueCounts(raw: string | null | undefined): Array<[string, number]> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    return Object.entries(parsed as Record<string, unknown>)
      .map(([id, items]) => [id, Array.isArray(items) ? items.length : 0] as [string, number])
      .filter(([, n]) => n > 0);
  } catch { return []; }
}
