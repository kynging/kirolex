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
  /** 它要改的那一行已经被前面的改动改掉 / 删掉了（`remapReviewLines`）—— 开跑时不再按原文去找别处。 */
  lost?: true;
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

/**
 * 这份文件落盘之后，排在后面的那些跟着它们那一行走（`keep`：旧行号 → 新行号）。整篇那条不挪。
 *
 * **目标那一行被这次改掉 / 删掉了**（`keep` 里没有它）：标成 `lost` —— 那一条要改的东西已经不在了，开跑时不许再按原文
 * 去找（一份里有两行一样的 `- TODO` 时会找到另一处，把那一处改掉 / 删掉）。行号挪到它**大概**在的位置
 * （前面最近一个留下来的行之后同样的距离），只是为了放回意见、排队那一行摆的地方别差太远。
 */
export function remapReviewLines(path: string, keep: Record<number, number> | ((line: number) => number | null)): void {
  /* 给的是按改动范围算的那张（`exactLineMap`，认得准）或者全文对齐的 `keep`（只在不知道改了哪一段时用） */
  const map = typeof keep === 'function' ? keep : (line: number) => keep[line] ?? null;
  let changed = false;
  for (const [id, it] of items) {
    if (it.path !== path || it.kind === 'whole') continue;
    const to = map(it.line);
    if (to) {
      if (to !== it.line) { items.set(id, { ...it, line: to }); changed = true; }
      continue;
    }
    /* 往前找最近一个还认得的行，按同样的距离放 */
    let near = it.line;
    for (let k = it.line - 1; k >= 1; k -= 1) { const m = map(k); if (m) { near = m + (it.line - k); break; } }
    items.set(id, { ...it, line: Math.max(1, near), lost: true });
    changed = true;
  }
  if (changed) emit();
}

/** 这一条要改的那一行已经被前面的改动改掉 / 删掉了（见 `remapReviewLines`）—— 开跑时据此不做、提示冲突、意见放回去。 */
export function reviewItemLost(id: string): boolean {
  return !!items.get(id)?.lost;
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

/** 这一条**此刻**指的那一行（跟着前面的落盘挪过，见 `remapReviewLines`）；已经不在队里了返回 undefined。 */
export function reviewItemLine(id: string): number | undefined {
  return items.get(id)?.line;
}

/**
 * 这一条的标记键**按此刻的行号**（`persist.key` 是提交那一刻的）—— 没写完就被 reload 打断时按它存、按它放回去，
 * 否则前面的改动挪了行号之后，放回去的意见会挂到别的行上。讲稿 `note:页`、整篇 `whole` 不随正文挪。
 */
export function liveMarkKey(item: Pick<ReviewQueueItem, 'kind' | 'line' | 'persist'>): string {
  const key = String(item.persist?.key ?? '');
  const m = /^(\+|=|drop:)?\d+$/.exec(key);
  return m && item.kind !== 'whole' && item.kind !== 'note' ? `${m[1] || ''}${item.line}` : key;
}
