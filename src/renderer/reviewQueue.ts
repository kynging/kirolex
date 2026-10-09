import { useSyncExternalStore } from 'react';

/**
 * **侧栏 comment 提交之后排着的那些 —— 唯一的一份** ——「有 comment 提交在运行的时候，如果我又提交了新的 comment，
 * 为什么不直接用会话的 queue 功能？」/「为什么我点删除的时候 queue 里增加了两条消息？」
 *
 * 不直接塞进会话的消息队列：那里的每一条都是一轮普通对话，回复只进会话、没有人接住它去拼回文件，模型只能
 * 自己动手改文件（两个写者）；而且那条队列只等"上一轮结束"，不等"上一条写完盘"。所以执行仍然走
 * `ReviewPane` 自己那条串行队列（闭包里跑），**状态只记在这里**：
 *
 *   · `ChatArea` 按会话读出来，摆在它自己的排队消息旁边，每条带一个取消；
 *   · `ReviewPane` 按文件读出来，画「排队中 / 进行中」、锁住那几行。
 *
 * 状态原来在 pane 自己的 `useState` 里 —— pane 一卸掉（换标签、藏预览栏）再挂上，新的那个看不见还在后台跑的那些，
 * 又按"上次没做完"把它们当标记放回去；你再提交一次（实测是点了个删除），同一条改写就排了两遍。
 */
export interface ReviewQueueItem {
  id: string;
  /** 打开这份文件的那条会话 —— 改写在它里面跑，所以挂在它的队列旁边。 */
  sessionId: string;
  /** 文件的完整路径（`ReviewPane` 按它认自己的那些）。 */
  path: string;
  /** 文件名（不带目录）。 */
  file: string;
  kind: 'revise' | 'insert' | 'delete' | 'whole' | 'note' | 'edit';
  /** 它此刻指的那一行 / 那一页 —— 前面的改动落盘后跟着挪（`remapReviewLines`）。 */
  line: number;
  /** 「改写 · 第 38 行」这种。 */
  label: string;
  state: 'queued' | 'running';
  cancel: () => void;
  /** 这一条的标记长什么样 —— 真被打断（reload / 重启）时按它放回去。 */
  persist?: { key: string; text: string; ticket?: string };
}

const items = new Map<string, ReviewQueueItem>();
const listeners = new Set<() => void>();
/** `useSyncExternalStore` 要一个**稳定**的快照：同一份内容返回同一个数组，变了才换。 */
let snapshot: ReviewQueueItem[] = [];
const emit = () => {
  snapshot = [...items.values()];
  for (const l of listeners) l();
};

export function putReviewItem(item: ReviewQueueItem): void {
  items.set(item.id, item);
  emit();
}

export function patchReviewItem(id: string, patch: Partial<ReviewQueueItem>): void {
  const cur = items.get(id);
  if (!cur) return;
  items.set(id, { ...cur, ...patch });
  emit();
}

export function removeReviewItem(id: string): void {
  if (items.delete(id)) emit();
}

/** 这份文件落盘之后，排在后面的那些跟着它们那一行走（`keep`：旧行号 → 新行号）。整篇那条不挪。 */
export function remapReviewLines(path: string, keep: Record<number, number>): void {
  let changed = false;
  for (const [id, it] of items) {
    if (it.path !== path || it.kind === 'whole') continue;
    const to = keep[it.line];
    if (to && to !== it.line) { items.set(id, { ...it, line: to }); changed = true; }
  }
  if (changed) emit();
}

/** 此刻还在排 / 在跑的那些（不订阅）—— pane 挂载时拿它判断哪些"上次没做完"其实还活着。 */
export function liveReviewItems(path: string): ReviewQueueItem[] {
  return snapshot.filter((x) => x.path === path);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** 这条会话名下排着的那些（按提交先后）。 */
export function useReviewQueue(sessionId: string | null | undefined): ReviewQueueItem[] {
  const all = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return sessionId ? all.filter((x) => x.sessionId === sessionId) : [];
}

/** 这份文件的那些（按提交先后）。 */
export function useReviewQueueForPath(path: string): ReviewQueueItem[] {
  const all = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return all.filter((x) => x.path === path);
}
