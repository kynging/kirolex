/**
 * **外观配色：主题 / 文字对比度 / 强调色 + `~/.kirolex/theme.json` 覆盖** ——「次要文字（命令、工具、时间戳）太暗看不清，
 * 希望能自己调颜色」。
 *
 * 纯逻辑，不碰 fs / electron，主进程（读 theme.json、校验）和渲染端（算出最终变量、对比度）共用。
 *
 * 优先级（低 → 高）：
 *   1. global.css 的默认值（`:root` = 深色，`[data-theme="light"]` = 浅色，由 `<html data-theme>` 切换）；
 *   2. 设置里的「文字对比度：高」（`CONTRAST_HIGH`）和「强调色」（`accentVars`，只换 --accent / --accent-hover / --accent-soft）；
 *   3. theme.json：先 `common`，再当前主题那一组（`dark` / `light`）。
 * 2、3 由渲染端写成 `<html>` 上的内联变量（`computeThemeVars` 算出来那张表），盖过样式表。
 *
 * theme.json **只接受颜色变量**（`THEME_COLOR_VARS`，就是 global.css `:root` 里定义的那些颜色）和
 * **CSS 颜色值**（#rgb / #rrggbb / #rrggbbaa、rgb() / rgba() / hsl() / hsla()）——不接受任意 CSS，免得改坏布局或注入规则。
 * 其他键 / 值逐项忽略，设置页显示「第 N 项被忽略：原因」。文件允许 `//` 和 `/* *\/` 注释（生成的示例里有说明）。
 */

/** global.css `:root` 里的颜色变量 —— theme.json 能覆盖的只有这些（测试核对和 global.css 一致）。 */
export const THEME_COLOR_VARS = [
  '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover',
  '--text-primary', '--text-secondary', '--text-muted', '--text-tertiary', '--text',
  '--accent', '--accent-hover', '--accent-soft',
  '--border', '--border-strong',
  '--success', '--error', '--warning', '--info', '--input-bg',
  '--perm-danger', '--perm-danger-border', '--perm-danger-bg',
  '--perm-caution', '--perm-caution-border', '--perm-caution-bg',
  '--perm-safe', '--perm-safe-border', '--perm-safe-bg',
  '--perm-neutral',
] as const;
export type ThemeColorVar = typeof THEME_COLOR_VARS[number];

export type ThemeChoice = 'dark' | 'light' | 'system';
export type EffectiveTheme = 'dark' | 'light';
export type ContrastChoice = 'standard' | 'high';

export const THEME_CHOICES: ThemeChoice[] = ['dark', 'light', 'system'];
export const CONTRAST_CHOICES: ContrastChoice[] = ['standard', 'high'];

export function normalizeThemeChoice(v: unknown): ThemeChoice {
  return v === 'light' || v === 'system' ? v : 'dark';
}
export function normalizeContrast(v: unknown): ContrastChoice {
  return v === 'high' ? 'high' : 'standard';
}
/** 「跟随系统」按 prefers-color-scheme 落到深 / 浅。 */
export function effectiveTheme(choice: ThemeChoice, systemPrefersDark: boolean): EffectiveTheme {
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light';
  return choice;
}

/**
 * 「文字对比度：高」：次要那三档文字提亮（深色）/ 加深（浅色）。标准档就是 global.css 里的值，不另写。
 * 深色：#c4c4c4 / #9a9a9a 对 #242424 分别约 9.6 / 5.6:1；浅色：#3d3d3d / #555555 对 #f5f5f5 约 10 / 6.8:1。
 */
export const CONTRAST_HIGH: Record<EffectiveTheme, Partial<Record<ThemeColorVar, string>>> = {
  dark: { '--text-secondary': '#c4c4c4', '--text-muted': '#9a9a9a', '--text-tertiary': '#9a9a9a' },
  light: { '--text-secondary': '#3d3d3d', '--text-muted': '#555555', '--text-tertiary': '#555555' },
};

/** 强调色预设（设置页的色块）。空串 = 主题默认（深色 #7c6fe0 / 浅色 #6b5fd4）。 */
export const ACCENT_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'Purple', value: '#7c6fe0' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Green', value: '#2e9d5b' },
  { label: 'Orange', value: '#e07a3f' },
  { label: 'Pink', value: '#d9578f' },
  { label: 'Gray', value: '#7b8290' },
];

// ── 颜色解析 ───────────────────────────────────────────────

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUM = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[+-]?\\d+)?';
const N = `(?:${NUM})`;
const P = `(?:${NUM}%)`;
const NP = `(?:${NUM}%?)`;
const HUE = `(?:${NUM}(?:deg|grad|rad|turn)?)`;
const C = '\\s*,\\s*';
const S = '\\s+';
const ALPHA_MODERN = `(?:\\s*\\/\\s*${NP})?`;
/**
 * 允许的函数写法（CSS Color 3 / 4 里 Chromium 认的那几种，按单位和分隔形式逐种列出，不认的一律不收）：
 *   · rgb / rgba 旧写法：逗号分隔，三个分量要么全是数字、要么全是百分比，可选第 4 个透明度（数字或百分比）；
 *   · rgb / rgba 新写法：空格分隔三个分量（数字或百分比），可选 `/ 透明度`；
 *   · hsl / hsla 旧写法：逗号分隔，色相（数字或带角度单位），饱和度和亮度**必须带 %**，可选透明度；
 *   · hsl / hsla 新写法：空格分隔，同样饱和度 / 亮度带 %，可选 `/ 透明度`。
 * 逗号和空格不能混用（`rgb(1,2 3)` 浏览器不认，这里也不认）。
 */
const COLOR_FN_RES = [
  new RegExp(`^rgba?\\(\\s*${N}${C}${N}${C}${N}(?:${C}${NP})?\\s*\\)$`, 'i'),
  new RegExp(`^rgba?\\(\\s*${P}${C}${P}${C}${P}(?:${C}${NP})?\\s*\\)$`, 'i'),
  new RegExp(`^rgba?\\(\\s*${NP}${S}${NP}${S}${NP}${ALPHA_MODERN}\\s*\\)$`, 'i'),
  new RegExp(`^hsla?\\(\\s*${HUE}${C}${P}${C}${P}(?:${C}${NP})?\\s*\\)$`, 'i'),
  new RegExp(`^hsla?\\(\\s*${HUE}${S}${P}${S}${P}${ALPHA_MODERN}\\s*\\)$`, 'i'),
];


/**
 * 是不是一个允许的 CSS 颜色：#rgb / #rrggbb / #rrggbbaa，或上面那几种 rgb()/rgba()/hsl()/hsla() 写法 ——
 * 没有 var()、url()、分号、花括号，拼进样式也改不了别的东西。
 */
export function isCssColor(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length > 64) return false;
  if (HEX_RE.test(s)) return true;
  return COLOR_FN_RES.some((re) => re.test(s));
}

/** #rgb / #rrggbb / #rrggbbaa → [r, g, b, a]（a 0～1）。不是 hex 返回 null。 */
export function parseHex(hex: string): [number, number, number, number] | null {
  const s = hex.trim();
  if (!HEX_RE.test(s)) return null;
  let h = s.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** WCAG 2.x 相对亮度。 */
export function relativeLuminance(hex: string): number {
  const p = parseHex(hex);
  if (!p) return NaN;
  const [r, g, b] = p.slice(0, 3).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x 对比度（只算 hex；带透明度的按不透明算）。 */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** 强调色的规整：只认 #rgb / #rrggbb（取色器给的就是 #rrggbb），统一成小写 #rrggbb；别的 = 空（用主题默认）。 */
export function normalizeAccent(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return '';
  const p = parseHex(s)!;
  return toHex(p[0], p[1], p[2]);
}

/**
 * 由一个主色派生三档强调色：hover 比主色暗 7 个百分点的亮度（默认 #7c6fe0 → ≈ #6b5fd4 那种深一档），
 * soft 是主色 22% 透明度（和 global.css 原来的 `--accent-soft` 同一个透明度）。主色不合法 → null。
 */
export function accentVars(accent: string): Record<'--accent' | '--accent-hover' | '--accent-soft', string> | null {
  const hex = normalizeAccent(accent);
  if (!hex) return null;
  const [r, g, b] = parseHex(hex)!;
  const [h, s, l] = rgbToHsl(r, g, b);
  const hover = toHex(...hslToRgb(h, s, Math.max(0, l - 0.07)));
  return { '--accent': hex, '--accent-hover': hover, '--accent-soft': `rgba(${r}, ${g}, ${b}, 0.22)` };
}

// ── 主题预设 ─────────────────────────────────────────────────

/**
 * **可以切换的主题** ——「应该给 KiroLex 设计一些可以切换的 theme」。
 *
 * 一个主题 = **一整套颜色变量**（`THEME_COLOR_VARS` 的全部取值），不是只换强调色。`base` 决定 `<html data-theme>`：
 * 浅色底的主题挂 `light`，于是 global.css 里浅色那批写死颜色的修正、引擎强调色的浅色那组都跟着生效。
 *
 * 每个内置主题都要满足（`tests/themePresets.test.ts` 逐个算）：
 *   · --text-primary / --text-secondary 对 --bg-primary / --bg-secondary ≥ 4.5:1，--text-muted / --text-tertiary ≥ 3:1；
 *   · 引擎色（engineTheme.ts，Kiro 紫 / Claude 橙 / Codex 青绿）和权限风险色（红 / 琥珀 / 绿）语义不变：
 *     权限色就用同 base 的那一组（`PERM_VARS`，只按明暗分），引擎色同样按 base 取 —— 测试核对它们落在这些底色上仍然可读；
 *   · 强调色底上画白字（按钮）≥ 3:1。
 * 配色参考各主题公开色板（Nord、Solarized、GitHub Primer、Dracula、One Dark），为了过上面的对比度，
 * 次要文字 / 强调色等个别值在原色相上调了明度。
 */
export interface ThemePreset {
  id: string;
  name: { zh: string; en: string };
  base: EffectiveTheme;
  vars: Record<ThemeColorVar, string>;
  /** 自定义主题（来自 theme.json 的 "themes"）。 */
  custom?: boolean;
}

/** 权限风险色：和 global.css / permissionTone.ts 的 TONE_COLORS 一致（测试核对），只按明暗分两组。 */
export const PERM_VARS: Record<EffectiveTheme, Pick<Record<ThemeColorVar, string>,
  '--perm-danger' | '--perm-danger-border' | '--perm-danger-bg' | '--perm-caution' | '--perm-caution-border' | '--perm-caution-bg'
  | '--perm-safe' | '--perm-safe-border' | '--perm-safe-bg' | '--perm-neutral'>> = {
  dark: {
    '--perm-danger': '#ff8f8a', '--perm-danger-border': '#ef5350', '--perm-danger-bg': 'rgba(239, 83, 80, 0.12)',
    '--perm-caution': '#e8b85a', '--perm-caution-border': '#d9a441', '--perm-caution-bg': 'rgba(217, 164, 65, 0.12)',
    '--perm-safe': '#8fd16a', '--perm-safe-border': '#5cb85c', '--perm-safe-bg': 'rgba(92, 184, 92, 0.12)',
    '--perm-neutral': '#a8a8a8',
  },
  light: {
    '--perm-danger': '#a51d17', '--perm-danger-border': '#c62828', '--perm-danger-bg': 'rgba(198, 40, 40, 0.12)',
    '--perm-caution': '#7a5000', '--perm-caution-border': '#a06a00', '--perm-caution-bg': 'rgba(160, 106, 0, 0.12)',
    '--perm-safe': '#2b6312', '--perm-safe-border': '#4a8a1c', '--perm-safe-bg': 'rgba(74, 138, 28, 0.12)',
    '--perm-neutral': '#555555',
  },
};

interface Palette {
  /** bg-primary / bg-secondary / bg-tertiary / bg-hover / input-bg */
  bg: [string, string, string, string, string];
  /** text-primary / text-secondary / text-muted（text-tertiary 和 muted 同一档） */
  text: [string, string, string];
  accent: string;
  /** 不给就由 accent 派生（`accentVars`） */
  accentHover?: string;
  /** border / border-strong */
  border: [string, string];
  success: string; error: string; warning: string; info: string;
}

function presetVars(base: EffectiveTheme, p: Palette): Record<ThemeColorVar, string> {
  const acc = accentVars(p.accent)!;
  return {
    '--bg-primary': p.bg[0], '--bg-secondary': p.bg[1], '--bg-tertiary': p.bg[2], '--bg-hover': p.bg[3], '--input-bg': p.bg[4],
    '--text-primary': p.text[0], '--text-secondary': p.text[1], '--text-muted': p.text[2], '--text-tertiary': p.text[2], '--text': p.text[0],
    '--accent': acc['--accent'], '--accent-hover': p.accentHover || acc['--accent-hover'], '--accent-soft': acc['--accent-soft'],
    '--border': p.border[0], '--border-strong': p.border[1],
    '--success': p.success, '--error': p.error, '--warning': p.warning, '--info': p.info,
    ...PERM_VARS[base],
  };
}

const preset = (id: string, zh: string, en: string, base: EffectiveTheme, p: Palette): ThemePreset => ({ id, name: { zh, en }, base, vars: presetVars(base, p) });

export const DEFAULT_THEME_ID: Record<EffectiveTheme, string> = { dark: 'kirolex-dark', light: 'kirolex-light' };

/** 内置主题。前两个就是 global.css `:root` / `[data-theme="light"]` 里的值（测试核对），选它们时界面和以前完全一样。 */
export const THEME_PRESETS: ThemePreset[] = [
  preset('kirolex-dark', 'KiroLex 深色', 'KiroLex Dark', 'dark', {
    bg: ['#1a1a1a', '#242424', '#2d2d2d', '#353535', '#2a2a2a'], text: ['#e8e8e8', '#a0a0a0', '#767676'],
    accent: '#7c6fe0', accentHover: '#6b5fd4', border: ['#333333', '#4a4a4a'],
    success: '#4caf50', error: '#ef5350', warning: '#ff9800', info: '#4f9fe0',
  }),
  preset('kirolex-light', 'KiroLex 浅色', 'KiroLex Light', 'light', {
    bg: ['#ffffff', '#f5f5f5', '#ebebeb', '#e4e4e4', '#f0f0f0'], text: ['#1f1f1f', '#555555', '#6e6e6e'],
    accent: '#6b5fd4', accentHover: '#5a4fc0', border: ['#d6d6d6', '#b8b8b8'],
    success: '#2e7d32', error: '#c62828', warning: '#a35a00', info: '#1565c0',
  }),
  /* Nord：Polar Night 底（bg-secondary 取 nord0 / nord1 之间，nord1 上 Claude 橙文字只有 4.4:1） + Snow Storm 字 + Frost 强调（nord10 #5e81ac，白字才看得清）；muted 在 nord4 / nord3 之间取 */
  preset('nord', 'Nord', 'Nord', 'dark', {
    bg: ['#2e3440', '#353c4a', '#3b4252', '#434c5e', '#323946'], text: ['#eceff4', '#d8dee9', '#a3adbf'],
    accent: '#5e81ac', border: ['#434c5e', '#4c566a'],
    success: '#a3be8c', error: '#e57f88', warning: '#ebcb8b', info: '#88c0d0',
  }),
  /* Solarized Dark：base03 / base02 底，base2 / base1 字；base01 太暗，muted 提亮到 #7f9399 */
  preset('solarized-dark', 'Solarized 深色', 'Solarized Dark', 'dark', {
    bg: ['#002b36', '#073642', '#0d404d', '#124a58', '#04313c'], text: ['#eee8d5', '#a8b4b4', '#7f9399'],
    accent: '#2075c7', border: ['#1a4c58', '#2b5f6b'],
    success: '#9bb300', error: '#f2615e', warning: '#d6a400', info: '#2aa198',
  }),
  /* Solarized Light：base3 / base2 底，base02 / base01 字 */
  preset('solarized-light', 'Solarized 浅色', 'Solarized Light', 'light', {
    bg: ['#fdf6e3', '#eee8d5', '#e6dfc6', '#ddd5bb', '#f5eedb'], text: ['#073642', '#4f6268', '#657b83'],
    accent: '#1f6fb5', border: ['#d9d2bb', '#bfb79f'],
    success: '#566e00', error: '#c1302c', warning: '#7f5f00', info: '#1d7770',
  }),
  /* GitHub Light（Primer）：canvas default / subtle，fg default / muted，accent.fg */
  preset('github-light', 'GitHub 浅色', 'GitHub Light', 'light', {
    bg: ['#ffffff', '#f6f8fa', '#eaeef2', '#e3e8ee', '#f6f8fa'], text: ['#1f2328', '#59636e', '#6e7781'],
    accent: '#0969da', border: ['#d0d7de', '#afb8c1'],
    success: '#1a7f37', error: '#cf222e', warning: '#9a6700', info: '#0969da',
  }),
  /* Dracula：Background / Current Line 底，Foreground 字；Comment #6272a4 太暗，次要文字往 Foreground 提；强调色取紫但压暗到白字可读 */
  preset('dracula', 'Dracula', 'Dracula', 'dark', {
    bg: ['#282a36', '#21222c', '#343746', '#44475a', '#2b2d3a'], text: ['#f8f8f2', '#c3c6d9', '#8c95bb'],
    accent: '#8457e8', border: ['#3a3d4f', '#4f5370'],
    success: '#50fa7b', error: '#ff5555', warning: '#ffb86c', info: '#8be9fd',
  }),
  /* One Dark（Atom）：#282c34 底，#abb2bf 字；强调色取蓝但压暗到白字可读 */
  preset('one-dark', 'One Dark', 'One Dark', 'dark', {
    bg: ['#282c34', '#21252b', '#2c313a', '#3a3f4b', '#1e2227'], text: ['#dcdfe4', '#abb2bf', '#7f8896'],
    accent: '#3d6fd1', border: ['#3a3f4b', '#4b5263'],
    success: '#98c379', error: '#e06c75', warning: '#e5c07b', info: '#61afef',
  }),
  /* 高对比深色：纯黑底、纯白字，边框也更实 */
  preset('high-contrast-dark', '高对比深色', 'High Contrast Dark', 'dark', {
    bg: ['#000000', '#0d0d0d', '#1a1a1a', '#262626', '#121212'], text: ['#ffffff', '#e6e6e6', '#b3b3b3'],
    accent: '#6b5fd4', border: ['#8a8a8a', '#c4c4c4'],
    success: '#6fe07a', error: '#ff7b72', warning: '#ffc14d', info: '#6cb6ff',
  }),
];

const BUILTIN_BY_ID = new Map(THEME_PRESETS.map((t) => [t.id, t]));
export function builtinTheme(id: string): ThemePreset | undefined {
  return BUILTIN_BY_ID.get(id);
}

/** 主题 id：小写字母 / 数字开头，只有小写字母、数字、- 和 _，最长 40。 */
export const THEME_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export function normalizeThemeId(v: unknown, base: EffectiveTheme): string {
  return typeof v === 'string' && THEME_ID_RE.test(v) ? v : DEFAULT_THEME_ID[base];
}

/** theme.json 里 "themes" 的一条（校验过、还没展开 extends）。 */
export interface CustomThemeDef {
  id: string;
  name: string;
  base?: EffectiveTheme;
  extends?: string;
  vars: Partial<Record<ThemeColorVar, string>>;
}

/**
 * 把自定义主题展开成完整主题：先找 `extends`（内置或另一个自定义，可以一层层继承；没写 = 同 base 的 KiroLex 默认），
 * 再盖上自己的 `vars`。`base` 没写就跟着被继承的那个。继承链断了（指向不存在的）或成环 → 这一条不要（`problems` 里说）。
 * 和内置 id 重名的在校验时就挡掉了。
 */
export function resolveCustomThemes(defs: CustomThemeDef[]): { themes: ThemePreset[]; problems: Array<{ id: string; reason: 'unknown-extends' | 'extends-cycle' }> } {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const done = new Map<string, ThemePreset>();
  const problems: Array<{ id: string; reason: 'unknown-extends' | 'extends-cycle' }> = [];
  const resolve = (id: string, seen: Set<string>): ThemePreset | null => {
    const b = builtinTheme(id);
    if (b) return b;
    if (done.has(id)) return done.get(id)!;
    const d = byId.get(id);
    if (!d) return null;
    if (seen.has(id)) return null;
    seen.add(id);
    const parentId = d.extends || DEFAULT_THEME_ID[d.base || 'dark'];
    const parent = resolve(parentId, seen);
    if (!parent) return null;
    const base = d.base || parent.base;
    const t: ThemePreset = { id: d.id, name: { zh: d.name, en: d.name }, base, vars: { ...parent.vars, ...d.vars }, custom: true };
    done.set(id, t);
    return t;
  };
  for (const d of defs) {
    const seen = new Set<string>();
    if (resolve(d.id, seen)) continue;
    const parentId = d.extends || DEFAULT_THEME_ID[d.base || 'dark'];
    problems.push({ id: d.id, reason: builtinTheme(parentId) || byId.has(parentId) ? 'extends-cycle' : 'unknown-extends' });
  }
  return { themes: defs.map((d) => done.get(d.id)).filter((t): t is ThemePreset => !!t), problems };
}

/** 下拉里能选的全部主题：内置在前，自定义在后。 */
export function allThemes(defs: CustomThemeDef[]): ThemePreset[] {
  return [...THEME_PRESETS, ...resolveCustomThemes(defs).themes];
}

/**
 * 现在用哪个主题：模式（深 / 浅 / 跟随系统）选出用哪一格（「深色时用」/「浅色时用」），再按 id 找。
 * 找不到（另一台电脑同步来的自定义主题，这台的 theme.json 里没有）→ 回退到**这一格**的 KiroLex 默认，`missing` 带上原 id 给设置页提示。
 * `preview`：设置页下拉里悬停 / 选中时临时预览的 id，优先于设置。
 */
export function pickTheme(input: {
  mode: ThemeChoice;
  systemPrefersDark: boolean;
  themeDark?: unknown;
  themeLight?: unknown;
  preview?: string | null;
  custom: CustomThemeDef[];
}): { theme: ThemePreset; slot: EffectiveTheme; missing?: string } {
  const slot = effectiveTheme(input.mode, input.systemPrefersDark);
  const list = allThemes(input.custom);
  const find = (id: string) => list.find((t) => t.id === id);
  if (input.preview) {
    const p = find(input.preview);
    if (p) return { theme: p, slot };
  }
  const id = normalizeThemeId(slot === 'dark' ? input.themeDark : input.themeLight, slot);
  const t = find(id);
  if (t) return { theme: t, slot };
  return { theme: builtinTheme(DEFAULT_THEME_ID[slot])!, slot, missing: id };
}

/** 「高」对比度：KiroLex 自己的两套用原来那组值；别的主题把次要文字往正文色靠（同色相，不换成灰）。 */
export function highContrastVars(t: ThemePreset): Partial<Record<ThemeColorVar, string>> {
  if (t.id === DEFAULT_THEME_ID.dark || t.id === DEFAULT_THEME_ID.light) return CONTRAST_HIGH[t.base];
  const sec = mixHex(t.vars['--text-secondary'], t.vars['--text-primary'], 0.5);
  const muted = mixHex(t.vars['--text-muted'], t.vars['--text-primary'], 0.45);
  if (!sec || !muted) return CONTRAST_HIGH[t.base];
  return { '--text-secondary': sec, '--text-muted': muted, '--text-tertiary': muted };
}

/** a 和 b 按 t（0 = a，1 = b）混色；只认 hex。 */
export function mixHex(a: string, b: string, t: number): string | null {
  const x = parseHex(a), y = parseHex(b);
  if (!x || !y) return null;
  return toHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
}

/** 下拉每一项的色块预览：背景、正文、次要文字、强调色。 */
export function themeSwatches(t: ThemePreset): string[] {
  return [t.vars['--bg-primary'], t.vars['--text-primary'], t.vars['--text-secondary'], t.vars['--accent']];
}

// ── theme.json ─────────────────────────────────────────────

export type ThemeSection = 'dark' | 'light' | 'common';
export const THEME_SECTIONS: ThemeSection[] = ['dark', 'light', 'common'];
export type ThemeOverrides = Record<ThemeSection, Partial<Record<ThemeColorVar, string>>>;

export function emptyOverrides(): ThemeOverrides {
  return { dark: {}, light: {}, common: {} };
}

/** 被忽略的一项。`reason` 是代码，界面按它出中英文（`ignoredReasonText`）。 */
export interface IgnoredItem {
  /** 第几项（文件里从上往下数，从 1 开始；见 `parseThemeFile`）。 */
  n: number;
  /** 这一项在文件里的位置，例如 `dark."--text-muted"` / `"fonts"`。 */
  where: string;
  reason: 'unknown-var' | 'bad-value' | 'unknown-section' | 'bad-section' | 'bad-version'
    /* "themes" 里的自定义主题 */
    | 'bad-theme' | 'bad-theme-id' | 'builtin-theme-id' | 'bad-theme-name' | 'bad-base' | 'unknown-theme-key' | 'unknown-extends' | 'extends-cycle';
  /** 原值（截短），给人看。 */
  value?: string;
}

export type ThemeParse =
  | { ok: true; overrides: ThemeOverrides; themes: CustomThemeDef[]; ignored: IgnoredItem[] }
  | { ok: false; error: string };

/** 去掉 `//` 行注释和 `/* *\/` 块注释（字符串里的不动），让 JSON.parse 能读带说明的示例文件。 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < text.length) { out += text[i + 1]; i += 2; continue; }
      if (c === '"') inStr = false;
      i += 1;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i += 1; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const short = (v: unknown): string => {
  let s: string;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  s = String(s);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
};

/**
 * 校验 theme.json 的原文。JSON 本身坏了 → `{ok:false}`（调用方保留上一次有效的配置）；
 * 能读 → 逐项挑出合格的，不合格的进 `ignored`。
 *
 * 「第 N 项」怎么数：文件里从上往下，三个分组里的每一条算一项；顶层不认识的键、不是对象的分组、不对的 version
 * 也各算一项（`version: 1` 和三个分组名本身不算）。
 */
export function parseThemeFile(text: string): ThemeParse {
  let raw: unknown;
  try {
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    raw = JSON.parse(stripJsonComments(body));
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
  if (!isObj(raw)) return { ok: false, error: 'top level must be an object { ... }' };
  const overrides = emptyOverrides();
  const ignored: IgnoredItem[] = [];
  const themes: CustomThemeDef[] = [];
  /** 每个自定义主题本身是第几项（extends 断了 / 成环时报在这一项上） */
  const themeItemN = new Map<string, number>();
  let n = 0;
  const allowed = new Set<string>(THEME_COLOR_VARS);
  for (const [key, val] of Object.entries(raw)) {
    if (key === 'version') {
      if (val !== 1) ignored.push({ n: ++n, where: 'version', reason: 'bad-version', value: short(val) });
      continue;
    }
    if (key === 'themes') {
      if (!isObj(val)) { ignored.push({ n: ++n, where: 'themes', reason: 'bad-section', value: short(val) }); continue; }
      for (const [id, def] of Object.entries(val)) {
        const tn = ++n;
        const where = `themes.${JSON.stringify(id)}`;
        if (!THEME_ID_RE.test(id)) { ignored.push({ n: tn, where, reason: 'bad-theme-id' }); continue; }
        if (builtinTheme(id)) { ignored.push({ n: tn, where, reason: 'builtin-theme-id' }); continue; }
        if (!isObj(def)) { ignored.push({ n: tn, where, reason: 'bad-theme', value: short(def) }); continue; }
        const d: CustomThemeDef = { id, name: id, vars: {} };
        themeItemN.set(id, tn);
        for (const [k, v] of Object.entries(def)) {
          const w = `${where}.${k}`;
          if (k === 'name') {
            if (typeof v === 'string' && v.trim() && v.trim().length <= 40) d.name = v.trim();
            else ignored.push({ n: ++n, where: w, reason: 'bad-theme-name', value: short(v) });
          } else if (k === 'base') {
            if (v === 'dark' || v === 'light') d.base = v;
            else ignored.push({ n: ++n, where: w, reason: 'bad-base', value: short(v) });
          } else if (k === 'extends') {
            if (typeof v === 'string' && THEME_ID_RE.test(v)) d.extends = v;
            else ignored.push({ n: ++n, where: w, reason: 'unknown-extends', value: short(v) });
          } else if (k === 'vars') {
            if (!isObj(v)) { ignored.push({ n: ++n, where: w, reason: 'bad-section', value: short(v) }); continue; }
            for (const [name, color] of Object.entries(v)) {
              n += 1;
              const wv = `${w}.${JSON.stringify(name)}`;
              if (!allowed.has(name)) { ignored.push({ n, where: wv, reason: 'unknown-var' }); continue; }
              if (!isCssColor(color)) { ignored.push({ n, where: wv, reason: 'bad-value', value: short(color) }); continue; }
              d.vars[name as ThemeColorVar] = color.trim();
            }
          } else {
            ignored.push({ n: ++n, where: w, reason: 'unknown-theme-key' });
          }
        }
        themes.push(d);
      }
      continue;
    }
    if (!(THEME_SECTIONS as string[]).includes(key)) {
      ignored.push({ n: ++n, where: JSON.stringify(key), reason: 'unknown-section' });
      continue;
    }
    if (!isObj(val)) {
      ignored.push({ n: ++n, where: key, reason: 'bad-section', value: short(val) });
      continue;
    }
    for (const [name, color] of Object.entries(val)) {
      n += 1;
      const where = `${key}.${JSON.stringify(name)}`;
      if (!allowed.has(name)) { ignored.push({ n, where, reason: 'unknown-var' }); continue; }
      if (!isCssColor(color)) { ignored.push({ n, where, reason: 'bad-value', value: short(color) }); continue; }
      overrides[key as ThemeSection][name as ThemeColorVar] = color.trim();
    }
  }
  /* extends 指向不存在的主题 / 成环 → 这个主题不要，报在它自己那一项上 */
  const { problems } = resolveCustomThemes(themes);
  const dropped = new Set<string>();
  for (const pr of problems) {
    dropped.add(pr.id);
    ignored.push({ n: themeItemN.get(pr.id) ?? 0, where: `themes.${JSON.stringify(pr.id)}`, reason: pr.reason });
  }
  ignored.sort((a, b) => a.n - b.n);
  return { ok: true, overrides, themes: themes.filter((t) => !dropped.has(t.id)), ignored };
}

/** IPC 传过来的自定义主题再校验一遍（只留合法 id / base / extends 和合法颜色）。 */
export function sanitizeThemeDefs(v: unknown): CustomThemeDef[] {
  if (!Array.isArray(v)) return [];
  const allowed = new Set<string>(THEME_COLOR_VARS);
  const out: CustomThemeDef[] = [];
  for (const d of v) {
    if (!isObj(d) || typeof d.id !== 'string' || !THEME_ID_RE.test(d.id) || builtinTheme(d.id)) continue;
    const def: CustomThemeDef = { id: d.id, name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 40) : d.id, vars: {} };
    if (d.base === 'dark' || d.base === 'light') def.base = d.base;
    if (typeof d.extends === 'string' && THEME_ID_RE.test(d.extends)) def.extends = d.extends;
    if (isObj(d.vars)) for (const [k, c] of Object.entries(d.vars)) if (allowed.has(k) && isCssColor(c)) def.vars[k as ThemeColorVar] = c.trim();
    out.push(def);
  }
  return out;
}

/** 重新校验一遍（IPC 传过来的对象不直接信）：只留合法键、合法值。 */
export function sanitizeOverrides(v: unknown): ThemeOverrides {
  const out = emptyOverrides();
  if (!isObj(v)) return out;
  const allowed = new Set<string>(THEME_COLOR_VARS);
  for (const sec of THEME_SECTIONS) {
    const s = v[sec];
    if (!isObj(s)) continue;
    for (const [k, c] of Object.entries(s)) if (allowed.has(k) && isCssColor(c)) out[sec][k as ThemeColorVar] = c.trim();
  }
  return out;
}

/** 渲染端拿到的状态。`error` 有值 = 文件坏了，`overrides` 是上一次有效的那份。 */
export interface ThemeFileState {
  path: string;
  exists: boolean;
  overrides: ThemeOverrides;
  /** theme.json 的 "themes"（自定义主题，校验过）。老文件没有 → 空。 */
  themes: CustomThemeDef[];
  ignored: IgnoredItem[];
  error?: string;
}

export interface ThemeInputs {
  /** 没给 `preset` 时用这个 base 的 KiroLex 默认主题。 */
  theme: EffectiveTheme;
  /** 当前主题（`pickTheme` 选出来的）。 */
  preset?: ThemePreset;
  contrast: ContrastChoice;
  /** 设置里的强调色，空 = 主题自带的 --accent。 */
  accent: string;
  overrides: ThemeOverrides;
}

const normColor = (c: string): string => {
  const h = parseHex(c);
  return h && h[3] === 1 ? toHex(h[0], h[1], h[2]) : c.trim().toLowerCase().replace(/\s+/g, '');
};

/**
 * 要写到 `<html>` 上的内联变量（盖过 global.css）。后写的赢：
 *   预设主题 → 对比度「高」→ 强调色设置（没设 = 主题自带的 --accent）→ theme.json common → theme.json 当前 base 那组。
 * 和同 base 的 KiroLex 默认（就是 global.css 里由 `data-theme` 选中的那组）一样的值不写 —— 样式表里已经是它，
 * 默认主题 + 什么都不改时一个内联变量都没有，和以前完全一样。
 */
export function computeThemeVars(input: ThemeInputs): Record<string, string> {
  const t = input.preset || builtinTheme(DEFAULT_THEME_ID[input.theme])!;
  const base = t.base;
  const vars: Record<string, string> = { ...t.vars };
  if (input.contrast === 'high') Object.assign(vars, highContrastVars(t));
  const acc = accentVars(input.accent);
  if (acc) Object.assign(vars, acc);
  const o = sanitizeOverrides(input.overrides);
  Object.assign(vars, o.common, o[base]);
  const def = builtinTheme(DEFAULT_THEME_ID[base])!.vars as Record<string, string>;
  for (const k of Object.keys(vars)) if (def[k] !== undefined && normColor(def[k]) === normColor(vars[k])) delete vars[k];
  return vars;
}

/** 「恢复默认」时旧文件改成的名字：`theme.json.bak-<YYYYMMDD-HHMMSS>`（本地时间）。 */
export function themeBackupName(now: Date): string {
  const p = (v: number) => String(v).padStart(2, '0');
  return `theme.json.bak-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** 「打开配置文件」时文件不存在就生成的示例：带注释说明，覆盖项都是注释掉的（生成出来不改变任何颜色）。 */
export function themeSampleText(): string {
  return `// KiroLex 颜色覆盖 / color overrides —— 保存后立即生效，不用重启。
// 优先级 / precedence：主题（设置里选的预设 / 下面 "themes" 里的自定义主题）< 文字对比度「高」< 强调色 < 这个文件的 dark / light / common 覆盖。
//
// · "dark" 只在深色主题下生效，"light" 只在浅色主题下生效，"common" 两套都生效（同名时 dark / light 优先）。
// · 只能覆盖颜色变量：${THEME_COLOR_VARS.join(' ')}
// · 值只接受 CSS 颜色：#rgb / #rrggbb / #rrggbbaa / rgb() / rgba() / hsl() / hsla()。
// · 其他键和值会被忽略，设置 → 外观里会显示「第 N 项被忽略：原因」。
// · 文件写坏了（不是合法 JSON）会继续用上一次的有效配置，并在设置页提示。
// · 「恢复默认」会把这个文件改名为 theme.json.bak-<时间>，不会删除。
// · 可选 "themes"：自定义主题，会出现在设置里「深色时用 / 浅色时用」的下拉里：
//     "<id>": { "name": "名字", "base": "dark" 或 "light", "extends": "已有主题的 id", "vars": { "颜色变量": "颜色" } }
//   id 只能用小写字母、数字、- 和 _；不写 extends = 同 base 的 KiroLex 默认；vars 的规则和上面一样。
//   内置主题 id：${THEME_PRESETS.map((t) => t.id).join(' ')}
// 把下面某一行前面的 // 去掉就能生效，例如让次要文字更亮：
{
  "version": 1,
  "dark": {
    // "--text-secondary": "#b8b8b8",
    // "--text-muted": "#9a9a9a"
  },
  "light": {
    // "--text-muted": "#5f5f5f"
  },
  "common": {
    // "--accent": "#3b82f6"
  },
  "themes": {
    // "my-nord": { "name": "我的 Nord", "base": "dark", "extends": "nord", "vars": { "--accent": "#4c6f9a" } }
  }
}
`;
}
