/**
 * 切会话时回到「上次离开时看到的位置」—— 纯逻辑部分（ChatArea 负责量 DOM、写 scrollTop）。
 *
 * 不记 scrollTop：图片加载、折叠展开、新消息都会改高度，单记 scrollTop 回来就错位。
 * 记的是**锚点**：视口顶部第一条可见的消息组 id + 它的顶边相对视口顶部的偏移；
 * 外加当时窗口化渲染挂了多少组（`loadedGroups` = renderLimit），回来先把这些组挂回去，锚点才在 DOM 里。
 *
 * 贴底（停在最下面）只记 `{ stick: true }`：回来到**新的**最下面，并继续跟随输出。
 */

export type ScrollMemo =
  | { stick: true }
  | { stick: false; anchorId: string; offset: number; loadedGroups: number };

/** 一组消息在视口里的位置（相对滚动容器可视区顶部，单位 px）。 */
export type AnchorBox = { id: string; top: number; bottom: number };

/** 视口顶部第一条（底边在视口顶部之下的）消息组；offset = 它的顶边 - 视口顶部（部分滚出上方时为负）。 */
export function pickAnchor(items: AnchorBox[]): { anchorId: string; offset: number } | null {
  for (const it of items) {
    if (it.bottom > 1) return { anchorId: it.id, offset: it.top };
  }
  return null;
}

/** 离开时的快照。贴底或量不到锚点（空会话）都记成贴底。 */
export function snapshotPosition(atBottom: boolean, items: AnchorBox[], loadedGroups: number): ScrollMemo {
  if (atBottom) return { stick: true };
  const a = pickAnchor(items);
  if (!a) return { stick: true };
  return { stick: false, anchorId: a.anchorId, offset: a.offset, loadedGroups };
}

export type RestorePlan =
  | { kind: 'bottom' }
  | { kind: 'anchor'; anchorId: string; offset: number; renderLimit: number };

/**
 * 回来时怎么恢复。`groupIds` 是现在这份记录的全部消息组 id（按显示顺序）。
 * 锚点没了（被删、编辑后重跑记录被重写）→ 到底部。
 * 窗口至少要挂到锚点那一组：期间来了新消息，原来的 loadedGroups 就不够了。
 */
export function planRestore(memo: ScrollMemo | undefined, groupIds: string[], initialLimit: number): RestorePlan {
  if (!memo || memo.stick) return { kind: 'bottom' };
  const idx = groupIds.indexOf(memo.anchorId);
  if (idx < 0) return { kind: 'bottom' };
  const need = groupIds.length - idx;
  return {
    kind: 'anchor',
    anchorId: memo.anchorId,
    offset: memo.offset,
    renderLimit: Math.max(initialLimit, memo.loadedGroups, need),
  };
}

/**
 * 回原位置前要不要再等一等。只看记录是不是还在加载：加载完了哪怕一条消息都没有也不再等 ——
 * 空记录交给 `planRestore`，它找不到锚点就退回底部。
 */
export function restoreGate(historyLoading: boolean): 'wait' | 'go' {
  return historyLoading ? 'wait' : 'go';
}

/** 让锚点顶边回到原偏移需要的 scrollTop。`anchorTop` 是锚点现在相对视口顶部的位置。 */
export function anchorScrollTop(scrollTop: number, anchorTop: number, offset: number): number {
  return Math.max(0, scrollTop + anchorTop - offset);
}

/**
 * 一格自己的位置快照。滚动时只记在这一格里，**离开**（切走 / 卸载 / 刷新前）才交给共享的 `ScrollMemory`：
 * 同一会话同时开在两格时，以最后离开的那一格为准，而不是最后滚动的那一格。
 * 交的是滚动时量好的快照，离开那一刻不再量（单屏原地切会话时 DOM 已经换成新会话了）。
 */
export class PaneScroll {
  private snap: { sid: string; memo: ScrollMemo } | null = null;
  record(sid: string, memo: ScrollMemo): void { this.snap = { sid, memo }; }
  /** 看一眼还没提交的快照（落盘时叠上去用，不提交）。 */
  peek(): { sid: string; memo: ScrollMemo } | null { return this.snap; }
  /** 位置作废（例如锚点没了、退回底部）：不再提交旧快照。 */
  clear(): void { this.snap = null; }
  commit(memory: { set(id: string, memo: ScrollMemo): void }): void {
    if (this.snap) memory.set(this.snap.sid, this.snap.memo);
    this.snap = null;
  }
}

/** 按会话 id 记位置；超过 `max` 条丢最久没更新的（持久化时不让它无限长）。 */
export class ScrollMemory {
  private map = new Map<string, ScrollMemo>();
  private max: number;
  constructor(max = 200) { this.max = max; }
  get(id: string): ScrollMemo | undefined { return this.map.get(id); }
  set(id: string, memo: ScrollMemo): void {
    this.map.delete(id);
    this.map.set(id, memo);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }
  delete(id: string): void { this.map.delete(id); }
  /** 只存位置，不存消息内容。 */
  toJSON(): Record<string, ScrollMemo> { return Object.fromEntries(this.map); }
  /** 读坏的 / 旧格式的条目直接丢掉，不报错。 */
  static fromJSON(raw: string | null, max = 200): ScrollMemory {
    const m = new ScrollMemory(max);
    if (!raw) return m;
    let obj: unknown;
    try { obj = JSON.parse(raw); } catch { return m; }
    if (!obj || typeof obj !== 'object') return m;
    for (const [id, v] of Object.entries(obj as Record<string, any>)) {
      if (!v || typeof v !== 'object') continue;
      if (v.stick === true) m.set(id, { stick: true });
      else if (v.stick === false && typeof v.anchorId === 'string' && Number.isFinite(v.offset) && Number.isFinite(v.loadedGroups)) {
        m.set(id, { stick: false, anchorId: v.anchorId, offset: v.offset, loadedGroups: v.loadedGroups });
      }
    }
    return m;
  }
}
