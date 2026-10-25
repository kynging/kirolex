/**
 * **按引擎区分的强调色** ——「不同 agent 用略微不同的配色（例如 kiro 就是紫的），一眼能看出这条会话是哪个引擎」。
 *
 * 只是**强调色**，不是整套主题：只用在侧栏会话行左边的细色条、分屏标题旁的引擎徽标、输入框获得焦点时的边框、
 * 发送按钮、流式输出时的进度点（`tests/engineTheme.test.ts` 扫 global.css 守着这张名单）。正文、代码块、提示卡片、
 * 其余按钮还是统一的 `--accent`。远程 / 本机不另加颜色（那是运行位置标识的事）。
 *
 * 用法：元素上挂 `data-accent-engine="kiro|claude|codex"`，App 把 `engineAccentCss()` 生成的规则注入成一个 <style>，
 * 规则给这个属性的元素定义 `--engine-accent*` 这几个变量（继承下去）。设置「按引擎区分颜色」关掉时，生成的规则
 * 三个引擎都取统一色（就是现在的 `--accent`），并把侧栏色条藏起来 —— 界面回到原样。
 *
 * 每个引擎三档颜色：
 *   - `accent`：图形用（色条、边框、发送按钮底、进度点），对所有底色 ≥ 3:1（WCAG AA 非文字）；
 *   - `text`：当文字用（徽标上的引擎名），对所有底色 ≥ 4.5:1（WCAG AA 正文）；
 *   - `onAccent`：画在 `accent` 上的图标（发送按钮的箭头），对 `accent` ≥ 3:1。
 * 测试逐个算对比度。界面现在只有暗色一套；亮色那组按同样的标准配好，挂在 `[data-theme="light"]` 下面，
 * 将来有亮色主题时直接生效。
 */

export const ACCENT_ENGINES = ['kiro', 'claude', 'codex'] as const;
export type AccentEngine = typeof ACCENT_ENGINES[number];
export const THEME_MODES = ['dark', 'light'] as const;
export type ThemeMode = typeof THEME_MODES[number];

export interface AccentSet {
  accent: string;
  text: string;
  onAccent: string;
}

/** 强调色会落在上面的那些底色。暗色就是 global.css `:root` 里的 bg-primary / secondary / tertiary / input-bg / hover。 */
export const THEME_SURFACES: Record<ThemeMode, string[]> = {
  dark: ['#1a1a1a', '#242424', '#2d2d2d', '#2a2a2a', '#353535'],
  light: ['#ffffff', '#f5f5f5', '#ebebeb', '#f0f0f0', '#e4e4e4'],
};

/** 关掉开关时用的统一强调色 —— 暗色就是现在的 `--accent`。 */
export const UNIFIED_ACCENT: Record<ThemeMode, AccentSet> = {
  dark: { accent: '#7c6fe0', text: '#a99ff0', onAccent: '#ffffff' },
  light: { accent: '#6b5fd4', text: '#5b4fc4', onAccent: '#ffffff' },
};

export const ENGINE_ACCENTS: Record<ThemeMode, Record<AccentEngine, AccentSet>> = {
  dark: {
    /* Kiro 品牌紫（参考 #9046ff，HSL 色相 264°）：#9046ff 本身在暗底上不到 3:1，所以色相不动、只提亮度。
       色相守在 255°–275°（再往上就读成粉 / 洋红了），和 Claude 橙、Codex 青绿两两 ΔE2000 ≥ 20（测试算）；
       和统一色 #7c6fe0 相近没关系 —— Kiro 本来就是紫 */
    kiro: { accent: '#a274ff', text: '#c4a8ff', onAccent: '#ffffff' },
    /* Claude Code 赤陶橙 */
    claude: { accent: '#d97757', text: '#e8987a', onAccent: '#ffffff' },
    /* Codex 青绿 */
    codex: { accent: '#119e8a', text: '#4fd1b8', onAccent: '#ffffff' },
  },
  light: {
    kiro: { accent: '#6f3fe0', text: '#5a2fc4', onAccent: '#ffffff' },
    claude: { accent: '#b4532f', text: '#9a4526', onAccent: '#ffffff' },
    codex: { accent: '#0b7a6b', text: '#08695c', onAccent: '#ffffff' },
  },
};

/** 会话记录里 `engine` 缺省 = kiro；不认识的也按 kiro（和 `engineLabel` 一致）。 */
export function accentEngine(engine: string | null | undefined): AccentEngine {
  return engine === 'claude' || engine === 'codex' ? engine : 'kiro';
}

export function engineAccent(engine: string | null | undefined, enabled: boolean, mode: ThemeMode = 'dark'): AccentSet {
  return enabled ? ENGINE_ACCENTS[mode][accentEngine(engine)] : UNIFIED_ACCENT[mode];
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 焦点光圈 / 悬停阴影用的浅色版本，和 global.css 的 `--accent-soft` 同一个透明度。 */
export function softOf(hex: string, alpha = 0.22): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** WCAG 2.x 相对亮度对比度。 */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = rgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * `--engine-accent-border`（输入框焦点边框）只在开关打开时定义，值就是纯的 `accent`（对 input-bg ≥ 3:1）。
 * 不和 `--border` 混：原来那种 58% 混色实测只有 2.1～2.4:1。关掉时不定义，CSS 退回原来的混色，界面和以前一样。
 */
function varsFor(set: AccentSet, enabled: boolean): string {
  return `--engine-accent: ${set.accent}; --engine-accent-soft: ${softOf(set.accent)}; --engine-accent-text: ${set.text}; --engine-on-accent: ${set.onAccent};${enabled ? ` --engine-accent-border: ${set.accent};` : ''}`;
}

/** App 注入的那段 CSS。`enabled` = 设置「按引擎区分颜色」。 */
export function engineAccentCss(enabled: boolean): string {
  const rules: string[] = [];
  for (const engine of ACCENT_ENGINES) {
    rules.push(`[data-accent-engine="${engine}"] { ${varsFor(engineAccent(engine, enabled, 'dark'), enabled)} }`);
    rules.push(`[data-theme="light"] [data-accent-engine="${engine}"] { ${varsFor(engineAccent(engine, enabled, 'light'), enabled)} }`);
  }
  if (!enabled) rules.push('.session-accent-strip { display: none; }');
  return rules.join('\n');
}
