import { t, type Lang } from './i18n.ts';

/**
 * 主进程 `acp:delete-session` 的返回值该怎么在界面上体现。
 *
 * 三种情况必须分开：
 *   - `deleted`：`ok: true`，删干净了。
 *   - `tombstoned`：`ok: false, tombstoned: true` —— 会话**已经删了**（立了墓碑，侧栏和下次启动都不会再出现，
 *     文件已经在后台排着再删），只是有些文件暂时被占用。不能放回列表，也不能说「没有删除」。
 *   - `refused`：`ok: false` 且没有 `tombstoned` —— 真的被拒绝了，会话还活着，要放回原位并报错。
 */
export type DeleteOutcome =
  | { kind: 'deleted' }
  | { kind: 'tombstoned'; notice: string }
  | { kind: 'refused'; error: string };

/** 待清理提示的翻译 key（英文原文；中文在 i18n.ts 的表里） */
export const TOMBSTONED_NOTICE_KEY = 'Chat deleted. Some files are in use and will be cleaned up automatically later.';

export function classifyDeleteResult(res: any, lang: Lang): DeleteOutcome {
  if (!res || res.ok !== false) return { kind: 'deleted' };
  if (res.tombstoned === true) return { kind: 'tombstoned', notice: t(lang, TOMBSTONED_NOTICE_KEY) };
  return { kind: 'refused', error: t(lang, 'Chat not deleted: {reason}', { reason: res.error || t(lang, 'unknown reason') }) };
}
