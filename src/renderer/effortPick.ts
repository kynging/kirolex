/**
 * **输入区 effort（推理强度）下拉怎么显示**（Claude Code / Codex，放在模型下拉左边）。
 * 清单和当前值来自适配器 configOptions 里当前模型的 effort 那一项（主进程 `engineEffort.ts` 认出来，经 engine-models 推过来）。
 *
 * 当前模型没有 effort（实测 haiku）：下拉**照样在**、禁用，悬停说「这个模型不支持调推理强度」—— 隐藏会让模型下拉左右跳。
 */
export type EffortSelectView = { current: string; options: Array<{ value: string; name: string }> } | null | undefined;
type T = (s: string, vars?: Record<string, string | number>) => string;

export interface EffortPickerView {
  value: string;
  options: Array<{ value: string; name: string; disabled?: boolean }>;
  disabled: boolean;
  /** 连上了、当前模型就是不给 effort */
  unsupported: boolean;
  title: string;
}

export function effortPickerView(
  effort: EffortSelectView,
  st: { connected: boolean; busy?: boolean; pending?: string },
  t: T,
): EffortPickerView {
  const has = !!effort && effort.options.length > 0;
  if (!has) {
    const unsupported = st.connected && effort !== undefined;
    return {
      value: '',
      options: [{ value: '', name: unsupported ? t('Effort: n/a') : t('Effort: …') }],
      disabled: true,
      unsupported,
      title: unsupported ? t('This model does not support adjusting reasoning effort') : t('Reasoning effort'),
    };
  }
  const value = st.pending ?? effort!.current;
  const options: EffortPickerView['options'] = effort!.options.map((o) => ({ value: o.value, name: t('Effort: {level}', { level: o.name }) }));
  /* 当前值不在清单里：照实列出来（不可选）—— 值对不上任何选项的 <select> 会悄悄显示第一项 */
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, name: t('Effort: {level}', { level: value }), disabled: true });
  return {
    value,
    options,
    disabled: !st.connected || !!st.busy,
    unsupported: false,
    title: t('Reasoning effort (this model)'),
  };
}
