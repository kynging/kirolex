/**
 * 待确认的 steer 列表怎么随「IPC 结果」和「轮末」变化 —— PURE（`tests/steerPending.test.ts`）。
 *
 * 一条 steer 有两段不确定：
 *   1. **发送结果还没回来**（`inFlight`）：渲染端已经乐观显示、已经登记（必须在发 IPC 之前登记，否则会漏掉
 *      kiro 立刻发来的 consumed），但主进程还没说写成功没有；
 *   2. **写进去了、还没被吃**：等 `steer_consumed`。
 * 轮末对账只能把第 2 种放回队头（那是「写进去了但这一轮没来得及用」，沿用轮末回队规则）。
 * 第 1 种不能动：它可能马上就回来一个 unsupported / write-failed，那要标红让用户选，而不是已经静默进了队列。
 * 所以轮末只给它打个 `turnEnded` 记号，等 IPC 结果回来再定：
 *   · 失败 → 按失败原因处理（App 的 `steerFailureRoute`）；
 *   · 成功，但这一轮已经结束了 → 等于「这一轮已经结束」（`idle`），作为新消息发出。
 */

export interface PendingSteer<A = unknown> {
  msgId: string;
  /** 气泡里显示的原文 */
  content: string;
  attachments: A[];
  /** 真正写给模型的文字（带附件引用块时和 content 不同） */
  sent?: string;
  /** IPC 结果还没回来 */
  inFlight?: boolean;
  /** 结果还没回来的时候这一轮就结束了 */
  turnEnded?: boolean;
}

/** 轮末：已确认写进去、没被吃的那些交出去回队头；结果还没回来的留下并标 `turnEnded`。 */
export function settleAtTurnEnd<A>(list: PendingSteer<A>[]): { requeue: PendingSteer<A>[]; keep: PendingSteer<A>[] } {
  const requeue = list.filter((s) => !s.inFlight);
  const keep = list.filter((s) => s.inFlight).map((s) => ({ ...s, turnEnded: true }));
  return { requeue, keep };
}

export type SteerIpcOutcome =
  /** 已经被吃掉了（或者用户点了停止把它丢了）—— 什么都不用做 */
  | { kind: 'gone' }
  /** 写进去了，正在等被吃 */
  | { kind: 'steered' }
  /** 没写进去 / 写进去的时候这一轮已经结束：把它从待确认和气泡里拿掉，交给调用方按 reason 处理 */
  | { kind: 'failed'; reason?: string };

/** IPC 结果回来了。返回新的列表和结论。 */
export function settleIpcResult<A>(
  list: PendingSteer<A>[],
  msgId: string,
  res: { steered: boolean; reason?: string } | null | undefined,
): { list: PendingSteer<A>[]; outcome: SteerIpcOutcome } {
  const mine = list.find((s) => s.msgId === msgId);
  if (!mine) return { list, outcome: { kind: 'gone' } };
  const rest = list.filter((s) => s.msgId !== msgId);
  if (!res?.steered) return { list: rest, outcome: { kind: 'failed', reason: res?.reason } };
  if (mine.turnEnded) return { list: rest, outcome: { kind: 'failed', reason: 'idle' } };
  return {
    list: list.map((s) => {
      if (s.msgId !== msgId) return s;
      const { inFlight: _inFlight, ...settled } = s;
      return settled;
    }),
    outcome: { kind: 'steered' },
  };
}

/**
 * 没能追加到这一轮、用户还没选的 steer —— 重启 / 刷新之后**还是一条标红的失败消息**，带原因、附件和两个按钮，
 * 不变成排队（排队会在你打开那条会话时自动发出，等于替你选了「作为下一条发送」）。
 */
export interface FailedSteerRecord<A = unknown> {
  msgId: string;
  content: string;
  attachments: A[];
  reason?: string;
  /** 失败时的时间（显示用） */
  ts?: number;
  /** 它属于哪一轮：那一轮的用户消息 id（重启后挂回那一轮；找不到就挂到最后一轮） */
  baseId?: string;
}

/** 读盘上的 `kirolex-failed-steers`：形状不对的条目丢掉，整份坏了就当没有。 */
export function parseFailedSteers<A>(raw: string | null | undefined): Record<string, FailedSteerRecord<A>[]> {
  let obj: unknown;
  try { obj = JSON.parse(raw || '{}'); } catch { return {}; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, FailedSteerRecord<A>[]> = {};
  for (const [sid, list] of Object.entries(obj as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const kept = list
      .filter((f: any) => f && typeof f.msgId === 'string' && typeof f.content === 'string')
      .map((f: any) => ({
        msgId: f.msgId,
        content: f.content,
        attachments: Array.isArray(f.attachments) ? f.attachments : [],
        ...(typeof f.reason === 'string' ? { reason: f.reason } : {}),
        ...(Number.isFinite(Number(f.ts)) ? { ts: Number(f.ts) } : {}),
        ...(typeof f.baseId === 'string' ? { baseId: f.baseId } : {}),
      }));
    if (kept.length) out[sid] = kept;
  }
  return out;
}

interface MsgLike { id: string; role: string; steer?: string }

/** 把失败的 steer 作为标红消息插回这一轮（已经在的不重复插）。`fallbackIndex` 用 turnRecovery.steerInsertIndex。 */
export function withFailedSteers<M extends MsgLike, A>(
  msgs: M[],
  records: FailedSteerRecord<A>[] | undefined,
  make: (f: FailedSteerRecord<A>) => M,
  fallbackIndex: (msgs: M[]) => number,
): M[] {
  if (!records?.length) return msgs;
  let out = msgs;
  for (const f of records) {
    if (out.some((m) => m.id === f.msgId)) continue;
    let at = -1;
    const baseAt = f.baseId ? out.findIndex((m) => m.id === f.baseId) : -1;
    if (baseAt >= 0) {
      at = baseAt + 1;
      while (at < out.length && out[at].role === 'user' && out[at].steer) at++;
    } else {
      at = fallbackIndex(out);
    }
    const msg = make(f);
    out = at < 0 ? [...out, msg] : [...out.slice(0, at), msg, ...out.slice(at)];
  }
  return out;
}

/** 失败发生时这一轮的用户消息 id（`insertIndex` 用 turnRecovery.steerInsertIndex）。
 *  必须在**落盘之前同步**算出来：放进 React 的状态更新回调里算，回调可能晚于落盘执行，存下去的就没有它。 */
export function turnBaseId<M extends MsgLike>(msgs: M[], insertIndex: (msgs: M[]) => number): string | undefined {
  let base = insertIndex(msgs) - 1;
  while (base >= 0 && msgs[base].steer) base--;
  return base >= 0 ? msgs[base].id : undefined;
}

/** 比较用的正文：就是原文（去掉首尾空白），**图片路径原样保留** —— 同样的话配不同的图是两条不同的 steer。
 *  主进程会把大图路径换成缩小后的副本再写出去；渲染端登记的 `sent` 已经是换过的那份
 *  （`acp:cap-steer-text`，见 useAcp.steerMessage），所以和 kiro 回报的正文能精确对上。 */
export function steerMatchKey(text: string): string {
  return text.trim();
}

/** `steer_consumed` 的快照对应待确认列表里的哪几条（返回 msgId）。
 *  快照是一个或几个 `<user_message>` 块；旧版本是不带包裹的拼接正文；有的版本干脆不给正文 ——
 *  这时按 FIFO 只认最老的那一条。 */
export function matchConsumedSteers(list: PendingSteer<unknown>[], snapshot: string): Set<string> {
  const consumed = new Set<string>();
  if (list.length === 0) return consumed;
  if (snapshot) {
    // Match each block to exactly one pending entry so duplicate text is
    // consumed by count rather than all identical entries at once.
    const blocks = Array.from(
      snapshot.matchAll(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/g),
      (match) => steerMatchKey(match[1]),
    );
    if (blocks.length > 0) {
      for (const block of blocks) {
        const hit = list.find((item) => !consumed.has(item.msgId) && steerMatchKey(item.sent ?? item.content) === block);
        if (hit) consumed.add(hit.msgId);
      }
    } else {
      // Compatibility path for versions that emit unwrapped snapshots. Remove one
      // matched occurrence at a time to preserve duplicate counts and pending order.
      let remaining = steerMatchKey(snapshot);
      for (const item of list) {
        const key = steerMatchKey(item.sent ?? item.content);
        const index = remaining.indexOf(key);
        if (index < 0) continue;
        consumed.add(item.msgId);
        remaining = `${remaining.slice(0, index)}${remaining.slice(index + key.length)}`;
      }
    }
  }
  // Some versions omit the consumed content entirely. Their lifecycle remains
  // FIFO, so consume exactly the oldest pending steer.
  if (consumed.size === 0) consumed.add(list[0].msgId);
  return consumed;
}
