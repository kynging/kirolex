/**
 * 「上下文工程」的跨会话上下文（输入框旁的 🛠️）—— 来源进度的账本。纯逻辑，`useAcp` 负责读 transcript 和发送。
 *
 * ## 进度按消息 id 记，不按位置
 *
 * 原来记的是 `syncedCount`（"来源的前 N 条已经发过了"），发送时 `slice(syncedCount)`。跨电脑同步上线以后
 * 这个记法是错的：同步合并 transcript 是**按 id 去重、按 ts 排序**（`src/main/transcriptMerge.ts`），
 * 另一台电脑上更早的消息会插到中间 —— 按位置截就会漏掉插进来的、或者把注入过的再发一遍；
 * 来源被清空 / 重写变短以后 `syncedCount` 超出长度，这条关联就永远不再注入任何东西，而且看不出来。
 *
 * 所以和同步一样认 id：每条关联记下**已经注入过的来源消息 id**（`injectedIds`）。来源里没注入过的 id
 * 都是新增，不管它在数组哪儿，按 ts 排好再注入；注入完，集合 = 来源里现有的全部 id（不存在的顺手清掉，
 * 集合不会无限增长）。同一条消息永远只注入一次。
 *
 * ## 来源换了 id
 *
 * 会话被合并成另一个 id 时，新的 record 带 `migratedFrom`（旧 id，或几条旧 id）。关联指着旧 id 的，
 * 改到新 id、已注入集合原样带过去 —— 旧会话删掉以后关联也不会悄悄失效。
 *
 * 关联本身是**每台电脑自己的设置**（和运行位置、agent 一样），只存本机 ui-state，不进 S3。
 */

export interface ContextLink {
  sourceId: string;
  sourceTitle: string;
  /** 已经注入过的来源消息 id。没有这个字段 = 旧格式，还没迁移 */
  injectedIds?: string[];
  /** 旧格式：按位置记的进度。第一次读到来源时迁移成 `injectedIds`，之后不再用 */
  syncedCount?: number;
}

export interface SourceMessage {
  id?: string;
  ts?: number;
  timestamp?: number;
  role: string;
  content: string;
  [k: string]: unknown;
}

/** 消息的身份。transcript 里每条都有 id；没有的（极老的缓存）退回按内容算一个，保证同一条认得出来 */
function msgKey(msg: SourceMessage): string {
  if (typeof msg.id === 'string' && msg.id) return msg.id;
  const text = `${msg.role}\u0000${String(msg.content ?? '')}`;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `~${Number(msg.ts ?? msg.timestamp) || 0}:${text.length}:${h}`;
}

/**
 * 算出这次要注入的新增消息，以及注入后的关联。
 *
 * `keepMissing`：来源没读到（读 transcript 出错、退回渲染层缓存）时传 true —— 这时"来源里没有"不等于
 * "来源里真没了"，集合不清，免得恢复后把旧消息重发一遍。
 */
export function takeContextDelta<M extends SourceMessage>(
  link: ContextLink,
  srcMsgs: M[],
  opts: { keepMissing?: boolean } = {},
): { delta: M[]; link: ContextLink; changed: boolean } {
  const msgs = Array.isArray(srcMsgs) ? srcMsgs : [];
  const legacy = !Array.isArray(link.injectedIds);
  const injected = legacy
    ? new Set(msgs.slice(0, Math.max(0, Number(link.syncedCount) || 0)).map(msgKey))
    : new Set(link.injectedIds);

  /* 没注入过的 id = 新增；同一个 id 只算一次 */
  const seen = new Set<string>();
  const fresh: { msg: M; at: number; i: number }[] = [];
  let lastTs = -Infinity;
  msgs.forEach((msg, i) => {
    const raw = Number(msg.ts ?? msg.timestamp);
    /* 没有 ts 的跟着前一条走 —— 排序保持可传递 */
    if (Number.isFinite(raw)) lastTs = raw;
    const key = msgKey(msg);
    if (seen.has(key)) return;
    seen.add(key);
    if (!injected.has(key)) fresh.push({ msg, at: lastTs, i });
  });
  fresh.sort((a, b) => (a.at - b.at) || (a.i - b.i));

  const nextIds = opts.keepMissing ? [...new Set([...injected, ...seen])] : [...seen];
  const before = legacy ? null : link.injectedIds!;
  const changed = legacy || before!.length !== nextIds.length || nextIds.some((id) => !injected.has(id));
  const { syncedCount: _drop, ...rest } = link;
  return {
    delta: fresh.map((f) => f.msg),
    link: changed ? { ...rest, injectedIds: nextIds } : link,
    changed,
  };
}

/** 还是旧格式（按位置记的 `syncedCount`），没换成 id */
export function isLegacyLink(link: ContextLink): boolean {
  return !Array.isArray(link.injectedIds);
}

/**
 * 只做旧格式迁移：来源 transcript 的前 `syncedCount` 条记为已注入，之后不再用 `syncedCount`。
 * `srcMsgs` 必须是**这条关联原来指着的那条来源**的 transcript —— 来源被合并成新 id 之前就要迁移，
 * 合并后的 transcript 里多了别处的消息，前 N 条已经不是当初发过的那 N 条了。
 */
export function migrateLegacyLink(link: ContextLink, srcMsgs: SourceMessage[]): ContextLink {
  if (!isLegacyLink(link)) return link;
  const n = Math.max(0, Number(link.syncedCount) || 0);
  const { syncedCount: _drop, ...rest } = link;
  return { ...rest, injectedIds: [...new Set((Array.isArray(srcMsgs) ? srcMsgs : []).slice(0, n).map(msgKey))] };
}

/** 读 ui-state 里的 `kirolex-context-links`：老版本每个目标只存一个对象；坏条目丢掉 */
export function normalizeSavedLinks(entries: unknown): [string, ContextLink[]][] {
  if (!Array.isArray(entries)) return [];
  const out: [string, ContextLink[]][] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
    const list = (Array.isArray(entry[1]) ? entry[1] : [entry[1]])
      .filter((l: any) => l && typeof l.sourceId === 'string' && l.sourceId);
    if (list.length > 0) out.push([entry[0], list]);
  }
  return out;
}

interface SessionLike { id: string; title?: string; migratedFrom?: string | string[] }

function fromIds(s: SessionLike): string[] {
  const v = s.migratedFrom;
  return (Array.isArray(v) ? v : v ? [v] : []).filter((x): x is string => typeof x === 'string' && !!x && x !== s.id);
}

/** 旧 id 现在叫什么（顺着 `migratedFrom` 一路走到头）。没有迁移、或者迁移成环，给 null */
export function migrationSuccessor(id: string, sessions: SessionLike[]): string | null {
  const next = new Map<string, string>();
  for (const s of sessions) for (const old of fromIds(s)) if (!next.has(old)) next.set(old, s.id);
  let cur = id;
  const visited = new Set([id]);
  while (next.has(cur)) {
    cur = next.get(cur)!;
    if (visited.has(cur)) return null;
    visited.add(cur);
  }
  return cur === id ? null : cur;
}

/**
 * 把指着旧 id 的关联改到新 id。已注入集合保留；新 id 已经关联过就并成一条（两边集合取并）；
 * 来源被并进了目标会话自己，就去掉这条（不能自己同步自己）。没有要改的原样返回同一个 Map。
 *
 * 某个目标的关联里还有旧格式（`syncedCount`）的，这个目标先**不动**：旧进度要先按原来那条来源的
 * transcript 换成 id（`migrateLegacyLink`），否则一合并就丢了。调用方迁移完再调一次。
 */
export function retargetContextLinks(
  links: Map<string, ContextLink[]>,
  sessions: SessionLike[],
): { links: Map<string, ContextLink[]>; changed: boolean } {
  if (!sessions.some((s) => fromIds(s).length > 0)) return { links, changed: false };
  let changed = false;
  const out = new Map<string, ContextLink[]>();
  for (const [target, arr] of links) {
    if (arr.some(isLegacyLink)) { out.set(target, arr); continue; }
    const merged: ContextLink[] = [];
    for (const l of arr) {
      const to = migrationSuccessor(l.sourceId, sessions);
      if (!to) { pushMerged(merged, l); continue; }
      changed = true;
      if (to === target) continue;
      const title = sessions.find((s) => s.id === to)?.title || l.sourceTitle;
      pushMerged(merged, { ...l, sourceId: to, sourceTitle: title });
    }
    if (merged.length > 0) out.set(target, merged);
  }
  return changed ? { links: out, changed } : { links, changed: false };
}

/* 走到这里的都已经按 id 记（旧格式的目标在上面整个跳过了），同一来源两条就把集合取并 */
function pushMerged(list: ContextLink[], l: ContextLink): void {
  const at = list.findIndex((x) => x.sourceId === l.sourceId);
  if (at < 0) { list.push(l); return; }
  list[at] = { ...list[at], injectedIds: [...new Set([...(list[at].injectedIds || []), ...(l.injectedIds || [])])] };
}

/**
 * 来源会话已经确认删掉了（而且没有 `migratedFrom` 后继可跟 —— 先调 `retargetContextLinks`）：去掉指着它的关联。
 * `dropped` 是每条被删的来源、它原来给几个会话提供上下文，调用方据此给用户一句提示。
 */
export function dropGoneSources(
  links: Map<string, ContextLink[]>,
  gone: Iterable<string>,
): { links: Map<string, ContextLink[]>; changed: boolean; dropped: { sourceId: string; sourceTitle: string; targets: number }[] } {
  const goneSet = new Set(gone);
  if (goneSet.size === 0) return { links, changed: false, dropped: [] };
  const out = new Map<string, ContextLink[]>();
  const dropped = new Map<string, { sourceId: string; sourceTitle: string; targets: number }>();
  for (const [target, arr] of links) {
    if (goneSet.has(target)) continue;   // 目标自己删了，它的关联一起去掉（不用提示）
    const kept = arr.filter((l) => {
      if (!goneSet.has(l.sourceId)) return true;
      const d = dropped.get(l.sourceId) || { sourceId: l.sourceId, sourceTitle: l.sourceTitle, targets: 0 };
      d.targets++;
      dropped.set(l.sourceId, d);
      return false;
    });
    if (kept.length > 0) out.set(target, kept);
  }
  const changed = out.size !== links.size || dropped.size > 0;
  return changed ? { links: out, changed, dropped: [...dropped.values()] } : { links, changed: false, dropped: [] };
}
