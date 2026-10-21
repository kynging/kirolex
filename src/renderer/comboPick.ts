/**
 * **Claude Code / Codex 左下角「组合」下拉该显示哪一项**（`ChatArea.tsx` 用）。
 *
 * 会话记住的组合 id 在本机的 `mcp-combos.json` 里找不到时（别的电脑上建的、被删了、文件有错），
 * main 那边按「通用」起执行器，并在清单里带 `missing`。以前下拉只认 `current`，于是悄悄显示「通用」——
 * 「组合那里明明写的投研，为什么显示是通用」。现在选中一条不可选的提示项，明说找不到、按通用在跑。
 */
export type ComboListView = {
  combos: Array<{ id: string; name: string; effort?: string }>;
  current: string;
  missing?: string;
  error?: string;
};

type T = (key: string, vars?: Record<string, string | number>) => string;

export function comboSelectView(
  list: ComboListView | null,
  pendingCombo: string | undefined,
  t: T,
): { value: string; missing?: { id: string; label: string } } {
  /* pending 里记的是组合 id（和显示名、界面语言无关），直接对上选项 */
  if (pendingCombo !== undefined && list?.combos.some((c) => c.id === pendingCombo)) return { value: pendingCombo };
  const id = list?.missing;
  if (id && !list!.combos.some((c) => c.id === id)) {
    const label = list!.error
      ? t('Combo "{id}" could not be read (the combo file has an error); running as General', { id })
      : t('Combo "{id}" does not exist on this machine; running as General', { id });
    return { value: id, missing: { id, label } };
  }
  return { value: list?.current || 'default' };
}

/**
 * **「新会话默认组合」下拉的选项**（设置里的全局那个、侧栏项目菜单里的项目覆盖）。
 *
 * 设的那个在本机的 `mcp-combos.json` 里没有时（别的电脑上的、被删了、文件有错），新会话按「通用」——
 * 和上面 `comboSelectView` 同一个说法：加一条选中的、不可选的提示项明说，不悄悄显示成「通用」。
 * `follow`：项目菜单里的第一项「跟随全局（…）」，值是 ''。
 */
export type DefaultComboInfo = {
  combos: Array<{ id: string; name: string }>;
  global: string;
  project?: string;
  error?: string;
};

export type DefaultComboOption = { value: string; label: string; selected: boolean; disabled?: boolean };

export function defaultComboOptions(
  info: DefaultComboInfo,
  scope: 'global' | 'project',
  t: T,
): DefaultComboOption[] {
  const chosen = scope === 'global' ? (info.global || 'default') : (info.project || '');
  const nameOf = (id: string) => info.combos.find((c) => c.id === id)?.name;
  const out: DefaultComboOption[] = [];
  if (scope === 'project') {
    const g = info.global || 'default';
    const gName = nameOf(g) || t('General purpose');
    out.push({ value: '', label: t('Follow global ({name})', { name: gName }), selected: chosen === '' });
  }
  for (const c of info.combos) out.push({ value: c.id, label: c.name, selected: c.id === chosen });
  if (chosen && !info.combos.some((c) => c.id === chosen)) {
    out.push({
      value: chosen,
      label: info.error
        ? t('Combo "{id}" could not be read (the combo file has an error); new sessions use General', { id: chosen })
        : t('Combo "{id}" does not exist on this machine; new sessions use General', { id: chosen }),
      selected: true,
      disabled: true,
    });
  }
  return out;
}
