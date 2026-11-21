/**
 * **备份 / 恢复里老会话显示「New Chat」** —— 侧栏上它们明明有标题。
 *
 * 这些会话的标题是在 `acp:rename-session`（标题落盘）出现之前起的或改的：当时只改了渲染层内存和
 * ui-state 的 `kirolex-sessions`，`sessions/<id>/record.json` 的 title 一直是 `New Chat`。备份 catalog
 * 和备份对话框读的是 record.title，于是显示 New Chat，传到云端、别的电脑恢复页里看到的也是它。
 *
 * 两步：
 * 1. 启动时把侧栏标题补进记录（`pickTitleBackfills`）—— 只补记录是空 / New Chat 的；记录已有正常标题不动（磁盘为准）。
 * 2. 还没补上的（侧栏也没名字），catalog / 备份列表显示时用第一条用户消息兜底（`displayTitleFor`），不写回记录。
 *
 * 纯函数，不碰磁盘。
 */
import { isKirolexNote } from './kirolexNote.ts';

const PLACEHOLDER = 'New Chat';
const FALLBACK_MAX_CHARS = 40;

/** 空 / `New Chat` 开头（`New Chat`、`New Chat 3`）算没有名字。 */
export function isPlaceholderTitle(title: unknown): boolean {
  const t = typeof title === 'string' ? title.trim() : '';
  return !t || /^New Chat\b/.test(t);
}

/** 记录标题是占位、侧栏是正常标题的会话 → 要写进记录的标题。 */
export function pickTitleBackfills(
  records: Array<{ id: string; title?: string }>,
  sidebar: unknown,
): Array<{ id: string; title: string }> {
  if (!Array.isArray(sidebar)) return [];
  const sidebarTitle = new Map<string, string>();
  for (const s of sidebar) {
    if (!s || typeof s.id !== 'string' || typeof s.title !== 'string') continue;
    sidebarTitle.set(s.id, s.title.trim());
  }
  const out: Array<{ id: string; title: string }> = [];
  for (const r of records) {
    if (!isPlaceholderTitle(r.title)) continue;
    const t = sidebarTitle.get(r.id);
    if (!t || isPlaceholderTitle(t)) continue;
    out.push({ id: r.id, title: t });
  }
  return out;
}

/** 第一条用户消息（不算 KiroLex 自己插的提示）去换行、截前 40 字；没有就是 New Chat。 */
export function titleFromFirstUserMessage(messages: Array<{ role?: string; content?: unknown; kirolex?: unknown }>): string {
  for (const m of messages || []) {
    if (!m || m.role !== 'user' || typeof m.content !== 'string') continue;
    if (isKirolexNote(m as any)) continue;
    const flat = m.content.replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    return Array.from(flat).slice(0, FALLBACK_MAX_CHARS).join('').trim();
  }
  return PLACEHOLDER;
}

/** 备份 catalog / 备份列表显示用的标题：记录有正常标题用它；否则才读 transcript 兜底（读不了就 New Chat）。 */
export function displayTitleFor(recTitle: string | undefined, readMessages: () => Array<{ role?: string; content?: unknown }>): string {
  if (!isPlaceholderTitle(recTitle)) return String(recTitle).trim();
  try { return titleFromFirstUserMessage(readMessages()); } catch { return PLACEHOLDER; }
}
