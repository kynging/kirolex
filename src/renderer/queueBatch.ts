/**
 * 排队消息发出时取哪几张卡片 —— PURE（`tests/queueMergeOnSend.test.ts`）。
 *
 * 「合并排队消息」（`settings.mergeQueuedMessages`）**只在发送时**生效：入队永远新建一张卡片
 * （⌘/Ctrl+Enter、steer 失败后「作为下一条发送」、重建历史期间……都不并进已有卡片）；
 * 关着时一张一张发，开着时才把队首若干张合并成一条发。
 */

/** 合并模式一批最多几张：没有上限的话，长队列会变成一条巨大的 prompt；剩下的下一轮再发。 */
export const QUEUE_MERGE_MAX_ITEMS = 10;

/** 这一次要发出去的卡片：合并 → 队首最多 QUEUE_MERGE_MAX_ITEMS 张；不合并 → 只有队首那一张。不改原数组。 */
export function queuedBatch<T>(queue: T[], merge: boolean): T[] {
  if (!queue.length) return [];
  return merge ? queue.slice(0, QUEUE_MERGE_MAX_ITEMS) : [queue[0]];
}

/** 这一批的显示文字。空内容的卡片是真的（只带附件），直接拼会在合并的 prompt 里留下空段落，所以先滤掉。 */
export function joinQueuedBatch(batch: { content?: string }[], header: (n: number) => string): string {
  const parts = batch.map((item) => (item.content || '').trim()).filter(Boolean);
  return parts.length > 1 ? `${header(parts.length)}\n\n${parts.join('\n\n')}` : (parts[0] ?? '');
}
