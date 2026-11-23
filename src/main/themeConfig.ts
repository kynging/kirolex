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
  reason: 'unknown-var' | 'bad-value' | 'unknown-section' | 'bad-section' | 'bad-version';
  /** 原值（截短），给人看。 */
  value?: string;
}

export type ThemeParse =
  | { ok: true; overrides: ThemeOverrides; ignored: IgnoredItem[] }
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
  let n = 0;
  const allowed = new Set<string>(THEME_COLOR_VARS);
  for (const [key, val] of Object.entries(raw)) {
    if (key === 'version') {
      if (val !== 1) ignored.push({ n: ++n, where: 'version', reason: 'bad-version', value: short(val) });
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
  return { ok: true, overrides, ignored };
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
  ignored: IgnoredItem[];
  error?: string;
}

export interface ThemeInputs {
  theme: EffectiveTheme;
  contrast: ContrastChoice;
  /** 设置里的强调色，空 = 主题默认。 */
  accent: string;
  overrides: ThemeOverrides;
}

/**
 * 要写到 `<html>` 上的内联变量（盖过 global.css）。默认值不在这里 —— 它们在样式表里，由 `data-theme` 选。
 * 后写的赢：对比度 → 强调色 → theme.json common → theme.json 当前主题。
 */
export function computeThemeVars(input: ThemeInputs): Record<string, string> {
  const vars: Record<string, string> = {};
  if (input.contrast === 'high') Object.assign(vars, CONTRAST_HIGH[input.theme]);
  const acc = accentVars(input.accent);
  if (acc) Object.assign(vars, acc);
  const o = sanitizeOverrides(input.overrides);
  Object.assign(vars, o.common, o[input.theme]);
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
// 优先级 / precedence：默认值 < 设置里的「主题 + 文字对比度 + 强调色」 < 这个文件。
//
// · "dark" 只在深色主题下生效，"light" 只在浅色主题下生效，"common" 两套都生效（同名时 dark / light 优先）。
// · 只能覆盖颜色变量：${THEME_COLOR_VARS.join(' ')}
// · 值只接受 CSS 颜色：#rgb / #rrggbb / #rrggbbaa / rgb() / rgba() / hsl() / hsla()。
// · 其他键和值会被忽略，设置 → 外观里会显示「第 N 项被忽略：原因」。
// · 文件写坏了（不是合法 JSON）会继续用上一次的有效配置，并在设置页提示。
// · 「恢复默认」会把这个文件改名为 theme.json.bak-<时间>，不会删除。
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
  }
}
`;
}
