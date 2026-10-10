/**
 * 设置 → 外观里字体下拉框的选项。
 *
 * 字体只能从预设里选。老设置里可能存着一个不在预设里的值（以前有手填输入框）——
 * 不能偷偷改掉它，也不能让下拉框显示成别的预设，所以这时多加一项「当前：<那个值>」，
 * value 就是原值，下拉框绑 settings 里的值时自然选中它；改选预设后这一项就不再生成。
 */
export interface FontOption { label: string; value: string }

export function fontSelectOptions(
  presets: FontOption[],
  current: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): FontOption[] {
  const opts = presets.map((p) => ({ label: t(p.label), value: p.value }));
  // 只有空白的值 App 当默认字体用（见 App.tsx 的 trim()），下拉框落到第一项「默认」即可。
  if (current.trim() && !presets.some((p) => p.value === current)) {
    opts.push({ label: t('Current: {value}', { value: current }), value: current });
  }
  return opts;
}
