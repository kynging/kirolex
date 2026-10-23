/**
 * 交给适配器却没轮到的那条，怎么放回 KiroLex 队列 —— PURE（`tests/pendingHandoffs.test.ts`）。
 *
 *   · `requeueFailedHandoff`：这一次运行里没轮到就失败了（`acp:handoff-failed` 带 notStarted）。内容优先用窗口里那张卡片，
 *     卡片没了（窗口刷新过）就用主进程随事件带来的整条消息。放回队头，带 `fromHandoff`。
 *   · `recoverPendingHandoffs`：上一次运行留下的（主进程 `acp:take-pending-handoffs`）。
 * 两条路都按 `fromHandoff` 认「已经放回过了」：失败回退放回了、主进程的记录还没来得及摘就退出了，重启时不再放第二遍。
 */
export interface HandoffItemLike {
  id: string;
  content: string;
  attachments: any[];
  pastes?: any[];
  createdAt: number;
  restored?: boolean;
  fromHandoff?: string;
}

export interface FailedHandoffEvent {
  messageId: string;
  content?: string;
  attachments?: any[];
  pastes?: any[];
}

export function requeueFailedHandoff<T extends HandoffItemLike>(
  queue: T[],
  evt: FailedHandoffEvent,
  card: { content: string; attachments: any[]; pastes?: any[] } | undefined,
  newId: () => string,
): T[] {
  if (queue.some((i) => i.fromHandoff === evt.messageId)) return queue;
  const pastes = card?.pastes ?? evt.pastes;
  const item = {
    id: newId(),
    content: card?.content ?? evt.content ?? '',
    attachments: card?.attachments ?? (Array.isArray(evt.attachments) ? evt.attachments : []),
    ...(pastes?.length ? { pastes } : {}),
    createdAt: Date.now(),
    fromHandoff: evt.messageId,
  } as T;
  return [item, ...queue];
}

export function recoverPendingHandoffs<T extends HandoffItemLike>(
  queue: T[],
  recovered: Array<{ id: string; content: string; attachments?: any[]; pastes?: any[]; ts?: number }>,
  newId: (fromId: string) => string,
): T[] {
  const already = new Set(queue.map((i) => i.fromHandoff).filter(Boolean));
  const back = recovered.filter((h) => !already.has(h.id));
  if (!back.length) return queue;
  return [
    ...back.map((h) => ({
      id: newId(h.id),
      content: h.content,
      attachments: Array.isArray(h.attachments) ? h.attachments : [],
      ...(Array.isArray(h.pastes) && h.pastes.length ? { pastes: h.pastes } : {}),
      createdAt: Number(h.ts) || Date.now(),
      restored: true,
      fromHandoff: h.id,
    }) as T),
    ...queue,
  ];
}
