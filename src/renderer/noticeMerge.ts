/**
 * **连续重复的同类提示只显示一条并计数（「×3」）** —— 不刷屏（写法见 `docs/notices-glossary.md`）。
 *
 * 怎么算"同类"：
 *   · 提示带了 `group`（主进程发提示时给的「类型:对象[→结果]」，例如 `local-tools-reconnect`、
 *     `model-fallback:claude-opus-5→gpt-5.6-sol`）→ group 相同就合并，**保留最新那条的内容**
 *     （「第 3 次」「详情里的新原因」都以最新为准），次数累计；对象或结果不同 group 就不同，分开显示。
 *   · 没带 group（旧记录、渲染层自己说的话）→ 退回"一字不差才合并"。
 * 纯函数：聊天区（相邻的 KiroLex 卡片）和状态行（还挂着时又来同类的一句）各用一个。
 */

/** 合并用的键：有 group 用 group，没有就用整句文字。 */
export function noticeKey(n: { group?: string | null; text: string }): string {
  return n.group ? `g:${n.group}` : `t:${n.text}`;
}

/**
 * 把相邻、`keyOf` 相同的几项并成一项（保留**最后**那一项，`count` 记几条）。
 * `keyOf` 返回 null 的项从不合并（你和 agent 的消息）。
 */
export function collapseAdjacent<T>(items: T[], keyOf: (x: T) => string | null): Array<{ item: T; count: number }> {
  const out: Array<{ item: T; count: number; key: string | null }> = [];
  for (const item of items) {
    const key = keyOf(item);
    const last = out[out.length - 1];
    if (key !== null && last && last.key === key) {
      last.item = item;
      last.count += 1;
      continue;
    }
    out.push({ item, count: 1, key });
  }
  return out.map(({ item, count }) => ({ item, count }));
}

/** 状态行上的一句（只用到这几个字段）。 */
export interface CountedNotice {
  text: string;
  /** 同类提示的键（见文件头）；没有就按整句比 */
  group?: string;
  count?: number;
}

/**
 * 状态行来了新的一句：和还挂着的那句同类（`noticeKey` 相同）→ 显示新的这句、计数 +1；否则换成新的。
 * `prev` 为 null 表示状态行现在是空的（上一句已经淡出）—— 淡出之后再来同一句就从 1 重新数。
 */
export function mergeNotice<N extends CountedNotice>(prev: N | null, next: N): N {
  if (prev && noticeKey(prev) === noticeKey(next)) return { ...next, count: (prev.count || 1) + 1 };
  return next;
}

/** 计数的显示：1 条不显示。 */
export function repeatBadge(count: number | undefined): string {
  return count && count > 1 ? `×${count}` : '';
}

/** 会话内提示固定用的那几个 emoji（含义见 `docs/notices-glossary.md`）。 */
export const NOTICE_EMOJI = ['⚠️', '⏳', '🔀', '✅'] as const;

/**
 * 错误横幅的开头：句子自己已经带了一个固定 emoji 就不再叠一个；没有就补 ⚠️（失败）。
 * 原来横幅一律前缀 ❌，于是「⚠️ 这一轮没有任何输出」显示成「❌ ⚠️ …」—— 一条里叠两个。
 */
export function bannerText(text: string): string {
  const s = String(text ?? '');
  return NOTICE_EMOJI.some((e) => s.trimStart().startsWith(e)) ? s : `⚠️ ${s}`;
}

/**
 * 主进程刚写进对话记录的一条 KiroLex 提示，当场插进界面上那条会话的消息列表。
 *
 * · 已经有这条（同 id，比如刚从盘上读回来）→ 不重复插；
 * · 界面上这条会话还**没读过历史**（列表是空的）→ 不插：往空列表里塞一条会让历史看起来像没了，
 *   等打开时从盘上读，这一条自然在里面（同 `connectFailure.historyBeforeNotice` 的道理）。
 * · 例外：`freshSession`（这个窗口里正在新建的会话）本来就没有历史，空列表照样插。
 * 返回新列表；返回 null 表示什么都不做。
 */
export function withLiveNote<T extends { id: string }>(current: T[], note: T, freshSession = false): T[] | null {
  /* 刚在这个窗口里新建的会话本来就没有历史 —— 空列表也插（例如新建时就改用了备用模型） */
  if (!current.length && !freshSession) return null;
  if (current.some((m) => m.id === note.id)) return null;
  return [...current, note];
}
