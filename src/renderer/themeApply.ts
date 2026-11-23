/**
 * 把外观设置落到 `<html>` 上：`data-theme`（选 global.css 里深 / 浅那一组默认值）+ 内联颜色变量
 * （对比度 / 强调色 / theme.json 覆盖，算法在 `main/themeConfig.ts` 的 `computeThemeVars`）。
 * 上一次写过、这一次不再需要的变量要删掉，否则关掉「高对比度」/ 恢复默认强调色之后旧值还留着。
 */
import { computeThemeVars, effectiveTheme, normalizeAccent, normalizeContrast, normalizeThemeChoice, type ThemeOverrides } from '../main/themeConfig.ts';

export interface StyleTarget {
  setAttribute(name: string, value: string): void;
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
}

/** 应用一次，返回这次写了哪些变量（下一次传回来当 `prevKeys`）。 */
export function applyTheme(
  el: StyleTarget,
  settings: { theme?: unknown; contrast?: unknown; accentColor?: unknown },
  overrides: ThemeOverrides,
  systemPrefersDark: boolean,
  prevKeys: string[],
): string[] {
  const theme = effectiveTheme(normalizeThemeChoice(settings.theme), systemPrefersDark);
  el.setAttribute('data-theme', theme);
  const vars = computeThemeVars({ theme, contrast: normalizeContrast(settings.contrast), accent: normalizeAccent(settings.accentColor), overrides });
  for (const k of prevKeys) if (!(k in vars)) el.style.removeProperty(k);
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  return Object.keys(vars);
}
