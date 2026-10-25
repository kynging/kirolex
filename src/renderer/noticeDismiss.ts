/**
 * **KiroLex 提示能关、同一类能「不再提醒」** ——「报错没有关闭按钮就很烦」（2026-10-25）。
 *
 * 只改显示：关掉的提示照旧留在对话记录里（transcript 一个字不删；KiroLex 提示本来就不发给模型，`modelFacing`）。
 *   · 关掉（×）：按消息 id 记，这一条不再显示；以后再来一条新的照样显示。
 *   · 不再提醒：按「类型」记（`muteKeyOf`）—— 没带上的 MCP（`mcp-unavailable:<MCP 配置>`）按整个 group，
 *     也就是「这个 MCP 配置」；其余按 group 冒号前的类型（`forward-mcp-failed:builder-mcp` → `forward-mcp-failed`）。
 *     没有 group 的提示没有「类型」可记，只能关。
 * 都存在 ui-state（`uiGet / uiSet`，本机的 `~/.kirolex/ui-state.json`，不跟 S3 走）—— 「这台电脑」上不再提醒。
 */
import { uiGet, uiSet } from './uiStore.ts';

export const DISMISSED_NOTES_KEY = 'kirolex-dismissed-notes';
export const MUTED_NOTICES_KEY = 'kirolex-muted-notices';
/** 关掉的最多记多少条（旧的先挤掉；被挤掉的那条会重新显示 —— 只是显示，没关系）。 */
export const DISMISSED_MAX = 2000;

/**
 * 没有 noteGroup 的几类提示自己的类型键（「不再提醒」按它记，这台电脑）：
 *   · 「这条会话没连上」（只在界面上的 `role: 'kirolex'`，connectFailure.ts）；
 *   · 「这条会话没能启动」横幅（StartupBanner，失败时）；
 *   · 会话的错误横幅 / 空会话中央的错误卡片（`connectionError`）。
 * 只改显示：错误照旧记着，重试 / 重连 / 错误处理都不变。
 */
export const CONNECT_FAILURE_GROUP = 'connect-failure';
export const STARTUP_FAILED_GROUP = 'startup-failed';
export const SESSION_ERROR_GROUP = 'session-error';

/** 这一类现在是不是被「不再提醒」了。 */
export function isMuted(group: string, s: NoticeHideState): boolean {
  const k = muteKeyOf(group);
  return !!k && s.muted.has(k);
}

/** 「不再提醒」记的键；null = 没有类型可记（没有 group）。 */
export function muteKeyOf(group: string | null | undefined): string | null {
  const g = String(group || '').trim();
  if (!g) return null;
  if (g.startsWith('mcp-unavailable:')) return g;
  const i = g.indexOf(':');
  return i > 0 ? g.slice(0, i) : g;
}

/** 「不再提醒」按钮上说的范围。 */
export function muteScope(group: string | null | undefined): 'profile' | 'kind' | null {
  const k = muteKeyOf(group);
  if (!k) return null;
  return k.startsWith('mcp-unavailable:') ? 'profile' : 'kind';
}

export interface NoticeHideState { dismissed: ReadonlySet<string>; muted: ReadonlySet<string> }

/** 这条提示现在显不显示（只看显示状态，不看内容）。 */
export function isNoticeHidden(n: { id: string; noteGroup?: string | null }, s: NoticeHideState): boolean {
  if (s.dismissed.has(n.id)) return true;
  const k = muteKeyOf(n.noteGroup);
  return !!k && s.muted.has(k);
}

function readList(key: string): string[] {
  try {
    const v = JSON.parse(uiGet(key) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

let state: NoticeHideState = { dismissed: new Set(readList(DISMISSED_NOTES_KEY)), muted: new Set(readList(MUTED_NOTICES_KEY)) };
const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) l(); };

export const noticeHideStore = {
  subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
  get(): NoticeHideState { return state; },
};

/** 关掉这一条（只改显示）。 */
export function dismissNotice(id: string): void {
  if (!id || state.dismissed.has(id)) return;
  const list = [...state.dismissed, id].slice(-DISMISSED_MAX);
  state = { ...state, dismissed: new Set(list) };
  uiSet(DISMISSED_NOTES_KEY, JSON.stringify(list));
  emit();
}

/** 同一类不再提醒（这台电脑；只改显示）。没有类型可记的 → 什么都不做。 */
export function muteNotice(group: string | null | undefined): void {
  const k = muteKeyOf(group);
  if (!k || state.muted.has(k)) return;
  const list = [...state.muted, k];
  state = { ...state, muted: new Set(list) };
  uiSet(MUTED_NOTICES_KEY, JSON.stringify(list));
  emit();
}
