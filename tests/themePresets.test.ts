/**
 * 可以切换的主题（`src/main/themeConfig.ts` 的 THEME_PRESETS / pickTheme / resolveCustomThemes，`src/renderer/themeApply.ts`）——
 * 「应该给 KiroLex 设计一些可以切换的 theme」。
 *
 * 守的是：
 *   1. 每个内置主题都是一整套颜色变量；KiroLex 深 / 浅两套就是 global.css 里的值（选它们界面和以前一样）；
 *   2. 每个内置主题的对比度：正文 / 次要文字 ≥ 4.5:1、muted ≥ 3:1；引擎色和权限风险色落在它的底色上仍可读，权限色语义不变；
 *   3. 叠加顺序：预设 < 对比度「高」< 强调色设置（没设 = 主题自带）< theme.json 覆盖；
 *   4. theme.json 的 "themes"：校验（只收颜色变量 + CSS 颜色，错的列原因）、extends（内置 / 自定义链、断链、成环）、老格式照常；
 *   5. 选中的主题 id 进外观同步；这台电脑没有那个自定义主题 → 回退到同一格的 KiroLex 默认，并带上 missing 给设置页提示；
 *   6. 接线：设置页两个主题下拉（色块、悬停预览、Esc 恢复），App 把预览 id 传给 applyTheme。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTRAST_HIGH, DEFAULT_THEME_ID, PERM_VARS, THEME_COLOR_VARS, THEME_PRESETS, accentVars, allThemes, builtinTheme,
  computeThemeVars, contrastRatio, emptyOverrides, highContrastVars, isCssColor, parseHex, parseThemeFile, pickTheme,
  resolveCustomThemes, sanitizeThemeDefs, themeSampleText, themeSwatches, type CustomThemeDef,
} from '../src/main/themeConfig.ts';
import { SYNCED_DEFAULTS, makePayload, pickSyncedSettings, serializeBundle } from '../src/main/appearanceSync.ts';
import { ENGINE_ACCENTS } from '../src/renderer/engineTheme.ts';
import { TONE_COLORS } from '../src/renderer/permissionTone.ts';
import { applyTheme } from '../src/renderer/themeApply.ts';

const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const CSS = read('renderer', 'styles', 'global.css');
const block = (selector: string): Record<string, string> => {
  const i = CSS.indexOf(`${selector} {`);
  assert.ok(i >= 0, selector);
  const out: Record<string, string> = {};
  for (const m of CSS.slice(i, CSS.indexOf('}', i)).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
};
const norm = (c: string) => { const h = parseHex(c); return h ? `#${h.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}` : c.replace(/\s+/g, ''); };
const hueOf = (hex: string) => {
  const [r, g, b] = parseHex(hex)!.slice(0, 3).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

describe('内置主题表', () => {
  test('至少有这 9 个，id 不重复，中英名都有', () => {
    const ids = THEME_PRESETS.map((t) => t.id);
    for (const id of ['kirolex-dark', 'kirolex-light', 'nord', 'solarized-dark', 'solarized-light', 'github-light', 'dracula', 'one-dark', 'high-contrast-dark']) {
      assert.ok(ids.includes(id), id);
    }
    assert.equal(new Set(ids).size, ids.length);
    for (const t of THEME_PRESETS) assert.ok(t.name.zh && t.name.en, t.id);
    assert.equal(builtinTheme('nord')!.base, 'dark');
    assert.equal(builtinTheme('solarized-light')!.base, 'light');
    assert.equal(builtinTheme('github-light')!.base, 'light');
  });
  test('每个主题都是 THEME_COLOR_VARS 的完整取值，值都是合法 CSS 颜色', () => {
    for (const t of THEME_PRESETS) {
      assert.deepEqual(Object.keys(t.vars).sort(), [...THEME_COLOR_VARS].sort(), t.id);
      for (const [k, v] of Object.entries(t.vars)) assert.ok(isCssColor(v), `${t.id} ${k}=${v}`);
    }
  });
  test('KiroLex 深色 / 浅色就是 global.css :root / [data-theme="light"] 里的值', () => {
    for (const [id, sel] of [['kirolex-dark', ':root'], ['kirolex-light', '[data-theme="light"]']] as const) {
      const css = block(sel);
      for (const k of THEME_COLOR_VARS) assert.equal(norm(builtinTheme(id)!.vars[k]), norm(css[k]), `${id} ${k}`);
    }
  });
  test('主题不只换强调色：除了 KiroLex 两套，底色 / 文字 / 边框这些基础色大半都和同 base 的默认不同', () => {
    const core = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover', '--input-bg', '--text-primary', '--text-secondary', '--text-muted', '--border'] as const;
    for (const t of THEME_PRESETS.filter((x) => !x.id.startsWith('kirolex-'))) {
      const def = builtinTheme(DEFAULT_THEME_ID[t.base])!.vars;
      const diff = core.filter((k) => norm(t.vars[k]) !== norm(def[k])).length;
      assert.ok(diff >= 7, `${t.id} 只有 ${diff} 个基础色不同`);
    }
  });
});

describe('每个内置主题的对比度（WCAG 2.x）', () => {
  for (const t of THEME_PRESETS) {
    test(`${t.id}：正文 / 次要文字 ≥ 4.5:1，muted / tertiary ≥ 3:1（对 bg-primary / bg-secondary）`, () => {
      for (const bg of ['--bg-primary', '--bg-secondary'] as const) {
        for (const [k, min] of [['--text-primary', 4.5], ['--text-secondary', 4.5], ['--text-muted', 3], ['--text-tertiary', 3]] as const) {
          const c = contrastRatio(t.vars[k], t.vars[bg]);
          assert.ok(c >= min, `${t.id} ${k} / ${bg} = ${c.toFixed(2)}`);
        }
      }
    });
    test(`${t.id}：「高对比度」比标准档更醒目，次要三档 ≥ 4.5:1`, () => {
      const h = highContrastVars(t);
      for (const bg of ['--bg-primary', '--bg-secondary'] as const) {
        for (const k of ['--text-secondary', '--text-muted', '--text-tertiary'] as const) {
          assert.ok(contrastRatio(h[k]!, t.vars[bg]) > contrastRatio(t.vars[k], t.vars[bg]), `${t.id} ${k}`);
          assert.ok(contrastRatio(h[k]!, t.vars[bg]) >= 4.5, `${t.id} ${k} ${h[k]}`);
        }
      }
    });
    test(`${t.id}：权限风险色就是同 base 那组（语义不变），落在底色上 ≥ 4.5:1`, () => {
      for (const [k, v] of Object.entries(PERM_VARS[t.base])) assert.equal(t.vars[k as keyof typeof t.vars], v, `${t.id} ${k}`);
      for (const [tone, c] of Object.entries(TONE_COLORS[t.base])) {
        assert.equal(t.vars[`--perm-${tone}` as keyof typeof t.vars], c.text);
        for (const bg of ['--bg-primary', '--bg-secondary'] as const) {
          assert.ok(contrastRatio(c.text, t.vars[bg]) >= 4.5, `${t.id} perm-${tone} / ${bg}`);
        }
      }
    });
    test(`${t.id}：引擎色（按 base 取那一组）文字 ≥ 4.5:1、图形 ≥ 3:1；Kiro 仍是紫（255°–275°）`, () => {
      for (const [engine, set] of Object.entries(ENGINE_ACCENTS[t.base])) {
        for (const bg of ['--bg-primary', '--bg-secondary'] as const) {
          assert.ok(contrastRatio(set.text, t.vars[bg]) >= 4.5, `${t.id} ${engine}.text / ${bg} = ${contrastRatio(set.text, t.vars[bg]).toFixed(2)}`);
          assert.ok(contrastRatio(set.accent, t.vars[bg]) >= 3, `${t.id} ${engine}.accent / ${bg}`);
        }
      }
      const h = hueOf(ENGINE_ACCENTS[t.base].kiro.accent);
      assert.ok(h >= 255 && h <= 275, `kiro hue ${h}`);
    });
    test(`${t.id}：强调色底上的白字（按钮）≥ 3:1`, () => {
      assert.ok(contrastRatio('#ffffff', t.vars['--accent']) >= 3, `${t.id} ${t.vars['--accent']}`);
    });
  }
  test('权限色两组和 global.css / permissionTone.ts 一致', () => {
    for (const [base, sel] of [['dark', ':root'], ['light', '[data-theme="light"]']] as const) {
      const css = block(sel);
      for (const [k, v] of Object.entries(PERM_VARS[base])) assert.equal(css[k], v, `${sel} ${k}`);
    }
  });
});

describe('叠加顺序：预设 < 对比度「高」< 强调色设置 < theme.json', () => {
  const nord = builtinTheme('nord')!;
  test('只选了主题：写的就是主题的整套颜色（和默认一样的不写）', () => {
    const v = computeThemeVars({ theme: 'dark', preset: nord, contrast: 'standard', accent: '', overrides: emptyOverrides() });
    assert.equal(v['--bg-primary'], nord.vars['--bg-primary']);
    assert.equal(v['--text-primary'], nord.vars['--text-primary']);
    assert.equal(v['--accent'], nord.vars['--accent'], '没改强调色时用主题自带的');
    assert.equal(v['--perm-danger'], undefined, '和默认一样的权限色不写，样式表里就是它');
  });
  test('默认主题 + 什么都不改 → 一个内联变量都没有（和以前一样）', () => {
    for (const base of ['dark', 'light'] as const) {
      assert.deepEqual(computeThemeVars({ theme: base, preset: builtinTheme(DEFAULT_THEME_ID[base]), contrast: 'standard', accent: '', overrides: emptyOverrides() }), {});
    }
  });
  test('高对比度盖过主题；强调色设置盖过主题自带的；theme.json 盖过一切（common < 当前 base）', () => {
    const v = computeThemeVars({ theme: 'dark', preset: nord, contrast: 'high', accent: '#e07a3f', overrides: emptyOverrides() });
    assert.equal(v['--text-secondary'], highContrastVars(nord)['--text-secondary']);
    assert.equal(v['--accent'], '#e07a3f');
    assert.equal(v['--accent-hover'], accentVars('#e07a3f')!['--accent-hover']);
    const o = { dark: { '--text-secondary': '#111111' }, light: { '--accent': '#222222' }, common: { '--accent': '#333333', '--text-secondary': '#444444' } };
    const w = computeThemeVars({ theme: 'dark', preset: nord, contrast: 'high', accent: '#e07a3f', overrides: o });
    assert.equal(w['--text-secondary'], '#111111');
    assert.equal(w['--accent'], '#333333');
    assert.equal(w['--bg-primary'], nord.vars['--bg-primary']);
  });
  test('浅色 base 的主题按 light 那组 theme.json 覆盖', () => {
    const sl = builtinTheme('solarized-light')!;
    const v = computeThemeVars({ theme: 'dark', preset: sl, contrast: 'standard', accent: '', overrides: { dark: { '--border': '#010101' }, light: { '--border': '#020202' }, common: {} } });
    assert.equal(v['--border'], '#020202');
  });
  test('KiroLex 默认主题的高对比度仍是原来那组值', () => {
    assert.deepEqual(highContrastVars(builtinTheme('kirolex-dark')!), CONTRAST_HIGH.dark);
    assert.deepEqual(highContrastVars(builtinTheme('kirolex-light')!), CONTRAST_HIGH.light);
  });
});

describe('theme.json 的 "themes"（自定义主题）', () => {
  test('合法的：extends 内置、只给几项 vars、base 跟着被继承的；出现在下拉清单里', () => {
    const r = parseThemeFile(JSON.stringify({ themes: { 'my-nord': { name: '我的 Nord', extends: 'nord', vars: { '--accent': '#4c6f9a' } } } }));
    assert.ok(r.ok);
    assert.deepEqual(r.ignored, []);
    const t = resolveCustomThemes(r.themes).themes[0];
    assert.equal(t.id, 'my-nord');
    assert.equal(t.base, 'dark');
    assert.equal(t.vars['--accent'], '#4c6f9a');
    assert.equal(t.vars['--bg-primary'], builtinTheme('nord')!.vars['--bg-primary']);
    assert.ok(allThemes(r.themes).some((x) => x.id === 'my-nord' && x.custom));
  });
  test('不写 extends = 同 base 的 KiroLex 默认；自定义可以继承自定义', () => {
    const r = parseThemeFile(JSON.stringify({ themes: { a: { base: 'light', vars: { '--bg-primary': '#fafafa' } }, b: { extends: 'a', vars: { '--text-primary': '#101010' } } } }));
    assert.ok(r.ok);
    const [a, b] = resolveCustomThemes(r.themes).themes;
    assert.equal(a.vars['--text-primary'], builtinTheme('kirolex-light')!.vars['--text-primary']);
    assert.equal(b.base, 'light');
    assert.equal(b.vars['--bg-primary'], '#fafafa');
    assert.equal(b.vars['--text-primary'], '#101010');
  });
  test('错的逐项忽略并说原因：非法键 / 非法值 / 坏 id / 占用内置 id / 坏 base / 不认识的键 / 不是对象', () => {
    const r = parseThemeFile(JSON.stringify({
      dark: { '--text-muted': '#9a9a9a' },
      themes: {
        ok: { name: 'OK', base: 'dark', vars: { '--bg-primary': '#101010', '--sidebar-width': '#fff', '--border': 'red', '--accent': 'hsl(1,2,3)' }, color: 1 },
        'Bad Id': { vars: {} },
        nord: { vars: {} },
        b2: { base: 'sepia' },
        b3: 'oops',
      },
    }));
    assert.ok(r.ok);
    assert.deepEqual(r.overrides.dark, { '--text-muted': '#9a9a9a' }, '老格式照常');
    assert.deepEqual(r.themes.map((t) => t.id), ['ok', 'b2']);
    assert.deepEqual(r.themes[0].vars, { '--bg-primary': '#101010' });
    assert.deepEqual(r.ignored.map((i) => [i.n, i.reason]), [
      [4, 'unknown-var'], [5, 'bad-value'], [6, 'bad-value'], [7, 'unknown-theme-key'],
      [8, 'bad-theme-id'], [9, 'builtin-theme-id'], [11, 'bad-base'], [12, 'bad-theme'],
    ]);
  });
  test('extends 指向不存在的 / 成环 → 这个主题不要，报原因', () => {
    const r = parseThemeFile(JSON.stringify({ themes: { x: { extends: 'nope' }, c1: { extends: 'c2' }, c2: { extends: 'c1' }, fine: { extends: 'dracula' } } }));
    assert.ok(r.ok);
    assert.deepEqual(r.themes.map((t) => t.id), ['fine']);
    assert.deepEqual(r.ignored.map((i) => [i.where, i.reason]), [
      ['themes."x"', 'unknown-extends'], ['themes."c1"', 'extends-cycle'], ['themes."c2"', 'extends-cycle'],
    ]);
  });
  test('IPC 进来的自定义主题再校验一遍', () => {
    const defs = sanitizeThemeDefs([{ id: 'ok', name: 'x', base: 'dark', vars: { '--bg-primary': '#000', '--x': '#fff', '--border': 'url(x)' } }, { id: 'nord' }, { id: 'BAD' }, 3]);
    assert.deepEqual(defs, [{ id: 'ok', name: 'x', base: 'dark', vars: { '--bg-primary': '#000' } }]);
  });
  test('示例文件仍然不改任何颜色，也没有自定义主题', () => {
    const r = parseThemeFile(themeSampleText());
    assert.ok(r.ok);
    assert.deepEqual(r.themes, []);
    assert.deepEqual(r.ignored, []);
  });
});

describe('选哪个主题 / 回退', () => {
  const custom: CustomThemeDef[] = [{ id: 'mine', name: 'Mine', base: 'light', extends: 'github-light', vars: {} }];
  test('模式选格子：深色用「深色时用」，浅色用「浅色时用」，跟随系统按系统', () => {
    const base = { themeDark: 'nord', themeLight: 'solarized-light', custom };
    assert.equal(pickTheme({ ...base, mode: 'dark', systemPrefersDark: false }).theme.id, 'nord');
    assert.equal(pickTheme({ ...base, mode: 'light', systemPrefersDark: true }).theme.id, 'solarized-light');
    assert.equal(pickTheme({ ...base, mode: 'system', systemPrefersDark: true }).theme.id, 'nord');
    assert.equal(pickTheme({ ...base, mode: 'system', systemPrefersDark: false }).theme.id, 'solarized-light');
    assert.equal(pickTheme({ ...base, mode: 'light', systemPrefersDark: true, themeLight: 'mine' }).theme.id, 'mine');
  });
  test('这台电脑没有那个自定义主题 → 回退到这一格的 KiroLex 默认，带上 missing', () => {
    const r = pickTheme({ mode: 'dark', systemPrefersDark: true, themeDark: 'from-other-pc', themeLight: 'kirolex-light', custom: [] });
    assert.equal(r.theme.id, 'kirolex-dark');
    assert.equal(r.missing, 'from-other-pc');
    const l = pickTheme({ mode: 'light', systemPrefersDark: true, themeDark: 'x', themeLight: 'gone', custom: [] });
    assert.equal(l.theme.id, 'kirolex-light');
    assert.equal(l.missing, 'gone');
  });
  test('缺省 / 坏值 = KiroLex 默认，不算 missing', () => {
    const r = pickTheme({ mode: 'dark', systemPrefersDark: true, custom: [] });
    assert.equal(r.theme.id, 'kirolex-dark');
    assert.equal(r.missing, undefined);
  });
  test('预览 id 优先于设置；预览的 id 不存在就照设置', () => {
    assert.equal(pickTheme({ mode: 'dark', systemPrefersDark: true, themeDark: 'nord', preview: 'github-light', custom }).theme.id, 'github-light');
    assert.equal(pickTheme({ mode: 'dark', systemPrefersDark: true, themeDark: 'nord', preview: 'nope', custom }).theme.id, 'nord');
  });
  test('applyTheme：data-theme = 主题的 base；换回默认主题时删掉上一次写的变量', () => {
    const attrs: Record<string, string> = {};
    const props: Record<string, string> = {};
    const el = { setAttribute: (k: string, v: string) => { attrs[k] = v; }, style: { setProperty: (k: string, v: string) => { props[k] = v; }, removeProperty: (k: string) => { delete props[k]; } } };
    const file = { overrides: emptyOverrides(), themes: custom };
    let keys = applyTheme(el, { theme: 'dark', themeDark: 'nord' }, file, true, []);
    assert.equal(attrs['data-theme'], 'dark');
    assert.equal(props['--bg-primary'], builtinTheme('nord')!.vars['--bg-primary']);
    keys = applyTheme(el, { theme: 'dark', themeDark: 'nord' }, file, true, keys, 'mine');
    assert.equal(attrs['data-theme'], 'light', '预览浅色 base 的主题时 data-theme 跟着变');
    keys = applyTheme(el, { theme: 'dark', themeDark: 'kirolex-dark' }, file, true, keys);
    assert.equal(attrs['data-theme'], 'dark');
    assert.deepEqual(props, {});
    assert.deepEqual(keys, []);
  });
  test('色块预览：背景、正文、次要文字、强调色', () => {
    const t = builtinTheme('dracula')!;
    assert.deepEqual(themeSwatches(t), [t.vars['--bg-primary'], t.vars['--text-primary'], t.vars['--text-secondary'], t.vars['--accent']]);
  });
});

describe('外观同步带上主题 id', () => {
  test('载荷里有 themeDark / themeLight（缺省是 KiroLex 默认），坏 id 不进载荷，uiZoom 仍不同步', () => {
    const p = makePayload({ themeDark: 'my-nord', themeLight: 'solarized-light', uiZoom: 150 }, null);
    assert.equal(p.settings.themeDark, 'my-nord');
    assert.equal(p.settings.themeLight, 'solarized-light');
    assert.equal('uiZoom' in p.settings, false);
    assert.ok(serializeBundle({ version: 1, updatedAt: 1, payload: p }).includes('"themeDark": "my-nord"'));
    assert.equal(makePayload({}, null).settings.themeDark, 'kirolex-dark');
    assert.equal(makePayload({}, null).settings.themeLight, 'kirolex-light');
    assert.deepEqual(pickSyncedSettings({ themeDark: '../x', themeLight: 'A B' }), {});
  });
  test('同步默认值和 App.tsx 的 DEFAULT_SETTINGS 一致', () => {
    const app = read('renderer', 'App.tsx');
    const i = app.indexOf('const DEFAULT_SETTINGS: Settings = {');
    const line = app.slice(i, app.indexOf('};', i));
    assert.ok(line.includes(`themeDark: '${SYNCED_DEFAULTS.themeDark}', themeLight: '${SYNCED_DEFAULTS.themeLight}'`), line);
  });
});

describe('接线（源码扫描）', () => {
  test('设置页：主题模式 + 深色时用 / 浅色时用两个下拉，色块预览、悬停预览、Esc 取消恢复、缺失主题提示', () => {
    const ui = read('renderer', 'components', 'ThemeSettings.tsx');
    assert.match(ui, /t\('Theme mode'\)/);
    assert.match(ui, /\{slotRow\('dark'\)\}\s*\{slotRow\('light'\)\}/);
    assert.match(ui, /t\('Theme when dark'\)/);
    assert.match(ui, /t\('Theme when light'\)/);
    assert.match(ui, /themeSwatches\(th\)/);
    assert.match(ui, /onMouseEnter=\{\(\) => preview\(i\)\}/);
    assert.match(ui, /e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); close\(\); \}/);
    assert.match(ui, /const close = \(\) => \{ setOpen\(false\); setActive\(-1\); onPreview\?\.\(null\); \}/);
    assert.match(ui, /useEffect\(\(\) => \(\) => onPreview\?\.\(null\), \[\]\)/, '卸载时恢复');
    assert.match(ui, /t\('Theme "\{id\}" is not on this computer/);
  });
  test('App：预览 id 传给 applyTheme；关掉设置时清掉预览；自定义主题从 theme.json 推送里来', () => {
    const app = read('renderer', 'App.tsx');
    assert.match(app, /applyTheme\(document\.documentElement, settings, \{ overrides: themeOverrides, themes: customThemes \}, systemPrefersDark, themeVarKeysRef\.current, themePreview\)/);
    assert.match(app, /onPreviewTheme=\{setThemePreview\}/);
    assert.match(app, /onClose=\{\(\) => \{ setThemePreview\(null\); setShowSettings\(false\); \}\}/);
    assert.match(app, /setCustomThemes\(sanitizeThemeDefs\(st\.themes\)\)/);
    const dlg = read('renderer', 'components', 'SettingsDialog.tsx');
    assert.match(dlg, /<ThemeColorControls settings=\{settings\} onChange=\{onChange\} onPreviewTheme=\{onPreviewTheme\} \/>/);
  });
});
