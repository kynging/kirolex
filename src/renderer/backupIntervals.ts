/**
 * 定时同步的间隔选项 ——「时间留几个选项就行，不要比 5 分钟更频繁」。
 *
 * 单独一个 `.ts`（不是跟着组件放在 `.tsx` 里）：单测直接跑 TypeScript 源码，
 * 而 node 的 type-stripping **不认 `.tsx`**（`ERR_UNKNOWN_FILE_EXTENSION`）——
 * 逻辑放在组件文件里就没法测。
 */

import { t, type Lang } from './i18n.ts';

/**
 * 可选的间隔（分钟）。
 *
 * 下界是 5：每一轮同步都要遍历一遍会话目录并向 S3 发请求，比这更密除了烧请求数没有好处
 * （会话是聊出来的，丢 5 分钟顶多丢一两轮）。上界给到一天，够"只想有个每天的兜底"那种用法。
 *
 * 原来这里是个 `type="number"` 输入框：能敲进 `1`，也能敲进 `0` —— 而 `Number('0') || 30`
 * 会把 0 悄悄变回 30，你以为设成 0 了，其实是 30。给固定几项就没有这种事。
 */
export const INTERVAL_CHOICES = [5, 15, 30, 60, 360, 1440];

/**
 * 下拉里实际列哪些。**把当前值也放进去**（哪怕它不在上面那张表里）——
 * 配置文件是可以手改的，而一个 `value` 不在 options 里的 `<select>` 会显示成空白，
 * 然后你随手一选就把原来那个值悄悄改掉了。
 *
 * 低于 5 的旧值不收：那是主进程会钳掉的东西（`Math.max(5, …)`），
 * 列出来等于承诺一个做不到的间隔。
 */
export function intervalChoices(current?: number): number[] {
  const cur = Number(current);
  const extra = Number.isFinite(cur) && cur >= 5 && !INTERVAL_CHOICES.includes(cur) ? [cur] : [];
  return [...INTERVAL_CHOICES, ...extra].sort((a, b) => a - b);
}

/** `60` → `1 小时`。到了小时级还写"60 分钟"要人自己换算。 */
export function intervalLabel(minutes: number, lang: Lang = 'zh'): string {
  if (minutes % 1440 === 0) { const n = minutes / 1440; return n === 1 ? t(lang, '1 day') : t(lang, '{n} days', { n }); }
  if (minutes % 60 === 0) { const n = minutes / 60; return n === 1 ? t(lang, '1 hour') : t(lang, '{n} hours', { n }); }
  return t(lang, '{n} min', { n: minutes });
}

/**
 * 云端自动清理的两个天数（「活跃设备 = 最近 N 天同步过」「云端回收站保留 M 天」）—— 和间隔同一个理由给下拉不给输入框。
 * 当前值不在表里（手改过配置）也列出来，同 `intervalChoices`。
 */
export const ACTIVE_DEVICE_DAY_CHOICES = [30, 60, 90, 180, 365];
export const CLOUD_TRASH_DAY_CHOICES = [7, 14, 30, 60, 90];

export function dayChoices(base: number[], current?: number): number[] {
  const cur = Math.floor(Number(current));
  const extra = Number.isFinite(cur) && cur >= 1 && !base.includes(cur) ? [cur] : [];
  return [...base, ...extra].sort((a, b) => a - b);
}
