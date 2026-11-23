/**
 * 把外观设置落到 `<html>` 上：`data-theme`（= 当前主题的 base，选 global.css 里深 / 浅那一组默认值和写死颜色的修正）
 * + 内联颜色变量（预设主题 / 对比度 / 强调色 / theme.json 覆盖，算法在 `main/themeConfig.ts` 的 `pickTheme` + `computeThemeVars`）。
 * 上一次写过、这一次不再需要的变量要删掉，否则换回默认主题 / 关掉「高对比度」/ 恢复默认强调色之后旧值还留着。
 */
import {
  computeThemeVars, normalizeAccent, normalizeContrast, normalizeThemeChoice, pickTheme,
  type CustomThemeDef, type ThemeOverrides,
} from '../main/themeConfig.ts';

export interface StyleTarget {
  setAttribute(name: string, value: string): void;
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
}

/** 应用一次，返回这次写了哪些变量（下一次传回来当 `prevKeys`）。`preview` = 设置页下拉里正在预览的主题 id。 */
export function applyTheme(
  el: StyleTarget,
  settings: { theme?: unknown; themeDark?: unknown; themeLight?: unknown; contrast?: unknown; accentColor?: unknown },
  file: { overrides: ThemeOverrides; themes: CustomThemeDef[] },
  systemPrefersDark: boolean,
  prevKeys: string[],
  preview: string | null = null,
): string[] {
  const { theme, slot } = pickTheme({
    mode: normalizeThemeChoice(settings.theme), systemPrefersDark,
    themeDark: settings.themeDark, themeLight: settings.themeLight, preview, custom: file.themes,
  });
  el.setAttribute('data-theme', theme.base);
  const vars = computeThemeVars({ theme: slot, preset: theme, contrast: normalizeContrast(settings.contrast), accent: normalizeAccent(settings.accentColor), overrides: file.overrides });
  for (const k of prevKeys) if (!(k in vars)) el.style.removeProperty(k);
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  return Object.keys(vars);
}
