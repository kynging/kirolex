import { uiGet, uiSet, uiRemove } from './uiStore';

/**
 * **界面状态要不要活过重启** ——「之前那个左侧会话栏是不是打开、右侧 comment 中有哪些内容，这个 kirolex
 * 一重启就重置了，应该记录下来自动恢复原先的设置。这个可以作为可选功能按钮在 setting 里」。
 *
 * 开（默认）：存进 ui-state（`uiSet`，盘上那一份），重启照样在。
 * 关：存进 sessionStorage —— 窗口 reload 还在（那是一直就该有的），整个 KiroLex 重启就清掉。
 *
 * 两边读写都经过这里，开关一拨，下一次写就落到另一边；读的时候先看当前那边，没有再看另一边一眼
 * （刚拨开关时另一边还留着上一份）。
 */
export const RESTORE_SETTING_KEY = 'restoreUiState';

export function restoreUiOn(): boolean {
  try {
    const raw = uiGet('kirolex-settings');
    return !raw || JSON.parse(raw)?.[RESTORE_SETTING_KEY] !== false;
  } catch {
    return true;
  }
}

export function restoreGet(key: string): string | null {
  const disk = () => { try { return uiGet(key); } catch { return null; } };
  const tab = () => { try { return sessionStorage.getItem(key); } catch { return null; } };
  return restoreUiOn() ? (disk() ?? tab()) : (tab() ?? null);
}

export function restoreSet(key: string, value: string | null): void {
  const on = restoreUiOn();
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* 存不了就只是不恢复 */ }
  try {
    /* 关着的时候把盘上那份也清掉 —— 不然拨回"开"会恢复一份很久以前的状态 */
    if (on && value !== null) uiSet(key, value); else uiRemove(key);
  } catch { /* 同上 */ }
}

/** JSON 版本 —— 坏值当没有。 */
export function restoreGetJson<T>(key: string): T | null {
  const raw = restoreGet(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}
