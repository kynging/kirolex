/**
 * 外观：主题 / 文字对比度 / 强调色 + `~/.kirolex/theme.json` 覆盖（`src/main/themeConfig.ts`、`themeFileStore.ts`）。
 *
 * 守的是：
 *   1. theme.json 只收 global.css `:root` 里的颜色变量 + CSS 颜色值，其他逐项忽略并说第几项、为什么；坏 JSON 保留上一次有效配置；
 *   2. 优先级：默认 < 主题 + 对比度 + 强调色 < theme.json（common < 当前主题那组）；
 *   3. 深色 / 浅色默认值的对比度（WCAG 公式）：正文、次要文字 ≥ 4.5:1，muted ≥ 3:1（对 bg-primary / bg-secondary）；
 *      「高对比度」那组更高；
 *   4. 强调色只派生 --accent / --accent-hover / --accent-soft，不碰引擎色和权限风险色；
 *   5. 接线：设置页三项新控件 + 两个按钮，主进程 watch 文件、IPC 齐全。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCENT_PRESETS, CONTRAST_HIGH, THEME_COLOR_VARS, accentVars, computeThemeVars, contrastRatio, effectiveTheme,
  emptyOverrides, isCssColor, normalizeAccent, parseThemeFile, stripJsonComments, themeBackupName, themeSampleText,
} from '../src/main/themeConfig.ts';
import { ensureThemeFile, readThemeFile, resetThemeFile, themeFilePath, writeSyncedThemeFile } from '../src/main/themeFileStore.ts';
import { THEME_SURFACES } from '../src/renderer/engineTheme.ts';

const SRC = path.join(import.meta.dirname, '..', 'src');
const CSS = fs.readFileSync(path.join(SRC, 'renderer', 'styles', 'global.css'), 'utf8');
const block = (selector: string): string => {
  const i = CSS.indexOf(`${selector} {`);
  assert.ok(i >= 0, selector);
  return CSS.slice(i, CSS.indexOf('}', i));
};
const varsOf = (b: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of b.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
};
const ROOT = varsOf(block(':root'));
const LIGHT = varsOf(block('[data-theme="light"]'));

describe('颜色变量清单就是 global.css :root 里的颜色', () => {
  test('THEME_COLOR_VARS 和 :root 里值是颜色的变量一一对应', () => {
    const colorVars = Object.entries(ROOT).filter(([, v]) => isCssColor(v)).map(([k]) => k).sort();
    assert.deepEqual([...THEME_COLOR_VARS].sort(), colorVars);
  });
  test('浅色那组覆盖了 :root 里的全部颜色变量，而且值都是颜色', () => {
    for (const name of THEME_COLOR_VARS) {
      assert.ok(LIGHT[name], `[data-theme="light"] 没有 ${name}`);
      assert.ok(isCssColor(LIGHT[name]), `${name}=${LIGHT[name]}`);
    }
  });
  test('浅色底色就是 engineTheme 的 THEME_SURFACES.light（引擎强调色按这些底色配的）', () => {
    for (const name of ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover', '--input-bg']) {
      assert.ok(THEME_SURFACES.light.includes(LIGHT[name].toLowerCase()), `${name}=${LIGHT[name]}`);
    }
  });
});

describe('默认值的对比度（WCAG 2.x）', () => {
  for (const [mode, vars] of [['dark', ROOT], ['light', LIGHT]] as const) {
    for (const bg of ['--bg-primary', '--bg-secondary']) {
      test(`${mode}：正文 / 次要文字 ≥ 4.5:1、muted / tertiary ≥ 3:1（对 ${bg}）`, () => {
        assert.ok(contrastRatio(vars['--text-primary'], vars[bg]) >= 4.5, `primary ${contrastRatio(vars['--text-primary'], vars[bg])}`);
        assert.ok(contrastRatio(vars['--text-secondary'], vars[bg]) >= 4.5, `secondary ${contrastRatio(vars['--text-secondary'], vars[bg])}`);
        assert.ok(contrastRatio(vars['--text-muted'], vars[bg]) >= 3, `muted ${contrastRatio(vars['--text-muted'], vars[bg])}`);
        assert.ok(contrastRatio(vars['--text-tertiary'], vars[bg]) >= 3, `tertiary ${contrastRatio(vars['--text-tertiary'], vars[bg])}`);
      });
      test(`${mode}：「高对比度」那组比标准档更醒目，次要三档都 ≥ 4.5:1（对 ${bg}）`, () => {
        for (const name of ['--text-secondary', '--text-muted', '--text-tertiary'] as const) {
          const high = CONTRAST_HIGH[mode][name]!;
          assert.ok(contrastRatio(high, vars[bg]) > contrastRatio(vars[name], vars[bg]), `${name} 没有更醒目`);
          assert.ok(contrastRatio(high, vars[bg]) >= 4.5, `${name} ${high}`);
        }
      });
    }
    test(`${mode}：三级文字层次还在（primary 比 secondary 醒目，secondary 比 muted 醒目）`, () => {
      const bg = vars['--bg-primary'];
      assert.ok(contrastRatio(vars['--text-primary'], bg) > contrastRatio(vars['--text-secondary'], bg));
      assert.ok(contrastRatio(vars['--text-secondary'], bg) > contrastRatio(vars['--text-muted'], bg));
    });
  }
});

describe('CSS 颜色校验', () => {
  test('接受 #rgb / #rrggbb / #rrggbbaa、rgb() / rgba() / hsl() / hsla()', () => {
    for (const v of ['#fff', '#A0a0A0', '#11223344', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'rgb(1 2 3 / 50%)', 'hsl(250, 60%, 50%)', 'hsla(250deg 60% 50% / .4)', 'rgb(10%, 20%, 30%)', 'rgba(255, 255, 255, 50%)', 'hsl(0.5turn, 10%, 20%, 0.3)', 'rgb(1 2% 3)']) {
      assert.ok(isCssColor(v), v);
    }
  });
  test('浏览器不认的函数写法当非法值忽略，并在 ignored 里说明', () => {
    const r = parseThemeFile(JSON.stringify({ dark: { '--text-muted': 'hsl(250,60,50)', '--border': 'rgb(1,2 3)' } }));
    assert.ok(r.ok);
    assert.deepEqual(r.overrides.dark, {});
    assert.deepEqual(r.ignored.map((i) => i.reason), ['bad-value', 'bad-value']);
  });
  test('不接受别的（关键字、var()、url()、带分号 / 花括号的注入、长度不对的 hex）', () => {
    for (const v of ['red', 'transparent', 'var(--accent)', 'url(x)', '#ffff', '#12345', '#fff; color: red', 'rgb(1,2,3)}body{x:1', 'rgb(1,2)', 'rgb(1,2,3,4,5)', 'calc(1px)', 'rgb(1deg,2,3)', 12, null, {},
      /* 浏览器不认的：hsl 的饱和度 / 亮度缺 %、逗号和空格混用、旧写法里数字和百分比混用、空格写法里用逗号分隔透明度 */
      'hsl(250,60,50)', 'hsl(250 60 50)', 'hsla(250, 60%, 50, 0.5)', 'rgb(1,2 3)', 'rgb(1 2,3)', 'rgb(1, 2%, 3)', 'rgb(1 2 3, 0.5)', 'rgb(1,2,3 / 0.5)', 'hsl(250, 60%, 50% / 0.5)']) {
      assert.equal(isCssColor(v), false, String(v));
    }
  });
});

describe('theme.json 校验', () => {
  test('合法的按分组收下', () => {
    const r = parseThemeFile(JSON.stringify({ version: 1, dark: { '--text-muted': '#9a9a9a' }, light: { '--text-muted': '#5f5f5f' }, common: { '--accent': 'rgb(1, 2, 3)' } }));
    assert.ok(r.ok);
    assert.deepEqual(r.overrides, { dark: { '--text-muted': '#9a9a9a' }, light: { '--text-muted': '#5f5f5f' }, common: { '--accent': 'rgb(1, 2, 3)' } });
    assert.deepEqual(r.ignored, []);
  });
  test('非法键 / 非法值 / 不认识的分组逐项忽略，说第几项、为什么', () => {
    const r = parseThemeFile(JSON.stringify({
      version: 1,
      dark: { '--text-muted': '#9a9a9a', '--sidebar-width': '#fff', '--text-primary': 'red', 'color': '#000' },
      fonts: { a: 1 },
      light: 'oops',
      common: { '--accent': 'url(javascript:alert(1))' },
    }));
    assert.ok(r.ok);
    assert.deepEqual(r.overrides.dark, { '--text-muted': '#9a9a9a' });
    assert.deepEqual(r.overrides.light, {});
    assert.deepEqual(r.overrides.common, {});
    assert.deepEqual(r.ignored.map((i) => [i.n, i.where, i.reason]), [
      [2, 'dark."--sidebar-width"', 'unknown-var'],
      [3, 'dark."--text-primary"', 'bad-value'],
      [4, 'dark."color"', 'unknown-var'],
      [5, '"fonts"', 'unknown-section'],
      [6, 'light', 'bad-section'],
      [7, 'common."--accent"', 'bad-value'],
    ]);
  });
  test('version 不是 1 记一项忽略（其余照常读）', () => {
    const r = parseThemeFile('{"version": 2, "dark": {"--border": "#444"}}');
    assert.ok(r.ok);
    assert.equal(r.ignored[0].reason, 'bad-version');
    assert.deepEqual(r.overrides.dark, { '--border': '#444' });
  });
  test('坏 JSON → 不 ok（调用方保留上一次）；不是对象也不 ok', () => {
    assert.equal(parseThemeFile('{"dark": {').ok, false);
    assert.equal(parseThemeFile('[1,2]').ok, false);
  });
  test('允许注释；字符串里的 // 不当注释', () => {
    const r = parseThemeFile('// 说明\n{ /* 块 */ "dark": { "--text-muted": "#9a9a9a" // 行尾\n }, "common": {} }');
    assert.ok(r.ok);
    assert.deepEqual(r.overrides.dark, { '--text-muted': '#9a9a9a' });
    assert.equal(stripJsonComments('{"a":"http://x"}'), '{"a":"http://x"}');
  });
  test('生成的示例能通过校验，而且不改变任何颜色、不产生忽略项', () => {
    const r = parseThemeFile(themeSampleText());
    assert.ok(r.ok);
    assert.deepEqual(r.overrides, emptyOverrides());
    assert.deepEqual(r.ignored, []);
  });
});

describe('优先级合并', () => {
  test('默认（标准对比度、无强调色、无覆盖）→ 不写任何内联变量，全用样式表', () => {
    assert.deepEqual(computeThemeVars({ theme: 'dark', contrast: 'standard', accent: '', overrides: emptyOverrides() }), {});
  });
  test('对比度 + 强调色 < theme.json；common < 当前主题那组；另一主题那组不生效', () => {
    const overrides = { dark: { '--text-muted': '#111111' }, light: { '--text-muted': '#222222' }, common: { '--text-muted': '#333333', '--accent': '#444444' } };
    const v = computeThemeVars({ theme: 'dark', contrast: 'high', accent: '#3b82f6', overrides });
    assert.equal(v['--text-muted'], '#111111');                 // dark 组盖过 common 和高对比度
    assert.equal(v['--text-secondary'], CONTRAST_HIGH.dark['--text-secondary']);   // 高对比度
    assert.equal(v['--accent'], '#444444');                     // theme.json 盖过设置里的强调色
    assert.equal(v['--accent-hover'], accentVars('#3b82f6')!['--accent-hover']);   // 没覆盖的那几项照旧是设置派生的
    const l = computeThemeVars({ theme: 'light', contrast: 'standard', accent: '', overrides });
    assert.equal(l['--text-muted'], '#222222');
    assert.equal(l['--text-secondary'], undefined);
  });
  test('合并时再校验一遍覆盖（IPC 进来的非法键 / 值不生效）', () => {
    const v = computeThemeVars({ theme: 'dark', contrast: 'standard', accent: '', overrides: { dark: { '--sidebar-width': '1px', '--border': 'red;}' } as any, light: {}, common: {} } });
    assert.deepEqual(v, {});
  });
  test('跟随系统按 prefers-color-scheme', () => {
    assert.equal(effectiveTheme('system', true), 'dark');
    assert.equal(effectiveTheme('system', false), 'light');
    assert.equal(effectiveTheme('light', true), 'light');
  });
});

describe('强调色派生', () => {
  test('只派生 --accent / --accent-hover / --accent-soft；hover 更深，soft 是 22% 透明度', () => {
    const v = accentVars('#7C6FE0')!;
    assert.deepEqual(Object.keys(v).sort(), ['--accent', '--accent-hover', '--accent-soft']);
    assert.equal(v['--accent'], '#7c6fe0');
    assert.equal(v['--accent-soft'], 'rgba(124, 111, 224, 0.22)');
    assert.ok(contrastRatio(v['--accent-hover'], '#000000') < contrastRatio(v['--accent'], '#000000'), 'hover 比主色暗');
  });
  test('不碰引擎色和权限风险色', () => {
    const v = computeThemeVars({ theme: 'dark', contrast: 'high', accent: '#e07a3f', overrides: emptyOverrides() });
    for (const k of Object.keys(v)) assert.doesNotMatch(k, /engine|perm/);
  });
  test('非法强调色 = 用主题默认', () => {
    assert.equal(accentVars('red'), null);
    assert.equal(normalizeAccent('#abc'), '#aabbcc');
    assert.equal(normalizeAccent('url(x)'), '');
  });
  test('预设色都是合法的 #rrggbb，派生的 hover 也是', () => {
    for (const p of ACCENT_PRESETS) {
      assert.match(p.value, /^#[0-9a-f]{6}$/);
      assert.match(accentVars(p.value)!['--accent-hover'], /^#[0-9a-f]{6}$/);
    }
  });
});

describe('theme.json 文件：读 / 示例 / 恢复默认', () => {
  let home = '';
  afterEach(() => { if (home) fs.rmSync(home, { recursive: true, force: true }); home = ''; });
  const mk = () => (home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-theme-')));

  test('没有文件 = 没有覆盖；坏 JSON 保留上一次有效配置并带上错误', () => {
    mk();
    const none = readThemeFile(home, null);
    assert.equal(none.state.exists, false);
    fs.mkdirSync(path.join(home, '.kirolex'), { recursive: true });
    fs.writeFileSync(themeFilePath(home), '{"dark": {"--text-muted": "#9a9a9a", "--x": "#fff"}}');
    const good = readThemeFile(home, none.state);
    assert.deepEqual(good.state.overrides.dark, { '--text-muted': '#9a9a9a' });
    assert.equal(good.state.ignored.length, 1);
    fs.writeFileSync(themeFilePath(home), '{"dark": {"--text-muted": ');
    const bad = readThemeFile(home, good.state);
    assert.ok(bad.state.error);
    assert.deepEqual(bad.state.overrides.dark, { '--text-muted': '#9a9a9a' });
    assert.equal(bad.state.ignored.length, 1);
    assert.equal(bad.text, '{"dark": {"--text-muted": ');
  });
  test('打开：不存在就生成示例，已存在不覆盖', () => {
    mk();
    const a = ensureThemeFile(home);
    assert.equal(a.created, true);
    assert.equal(fs.readFileSync(a.path, 'utf-8'), themeSampleText());
    fs.writeFileSync(a.path, '{"dark":{}}');
    assert.equal(ensureThemeFile(home).created, false);
    assert.equal(fs.readFileSync(a.path, 'utf-8'), '{"dark":{}}');
  });
  test('恢复默认 = 改名成 theme.json.bak-<时间>，不删；同一秒两次不撞名', () => {
    mk();
    const now = new Date(2026, 10, 23, 9, 8, 7);
    assert.equal(themeBackupName(now), 'theme.json.bak-20261123-090807');
    assert.equal(resetThemeFile(home, now), null);
    ensureThemeFile(home);
    const bak = resetThemeFile(home, now)!;
    assert.equal(path.basename(bak), 'theme.json.bak-20261123-090807');
    assert.equal(fs.existsSync(themeFilePath(home)), false);
    assert.equal(fs.readFileSync(bak, 'utf-8'), themeSampleText());
    ensureThemeFile(home);
    assert.equal(path.basename(resetThemeFile(home, now)!), 'theme.json.bak-20261123-090807-2');
  });
  test('同步拉下来的：只差空白不写；null = 本机这份改名备份', () => {
    mk();
    fs.mkdirSync(path.join(home, '.kirolex'), { recursive: true });
    fs.writeFileSync(themeFilePath(home), '{"dark": {}}');
    assert.equal(writeSyncedThemeFile(home, '{ "dark" : { } }\n', new Date()), false);
    assert.equal(writeSyncedThemeFile(home, '{"light": {}}', new Date()), true);
    assert.equal(fs.readFileSync(themeFilePath(home), 'utf-8'), '{"light": {}}');
    assert.equal(writeSyncedThemeFile(home, null, new Date(2026, 0, 1)), true);
    assert.equal(fs.existsSync(themeFilePath(home)), false);
    assert.ok(fs.readdirSync(path.join(home, '.kirolex')).some((f) => f.startsWith('theme.json.bak-')));
  });
});

describe('接线（源码扫描）', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
  test('设置 → 外观页有 主题 / 文字对比度 / 强调色 三项和 theme.json 的两个按钮、同步开关', () => {
    const dlg = read('renderer', 'components', 'SettingsDialog.tsx');
    const ap = dlg.indexOf("{tab === 'appearance' && (\n          <div className=\"settings-col\">\n            <ThemeColorControls");
    assert.ok(ap >= 0, '外观页里挂了 ThemeColorControls');
    assert.match(dlg, /\{tab === 'appearance' && <ThemeFileControls settings=\{settings\} onChange=\{onChange\} \/>\}/);
    const ui = read('renderer', 'components', 'ThemeSettings.tsx');
    assert.match(ui, /<option value="dark">\{t\('Dark'\)\}<\/option>/);
    assert.match(ui, /<option value="light">\{t\('Light'\)\}<\/option>/);
    assert.match(ui, /<option value="system">\{t\('Follow system'\)\}<\/option>/);
    assert.match(ui, /t\('Text contrast'\)/);
    assert.match(ui, /<option value="high">\{t\('High'\)\}<\/option>/);
    assert.match(ui, /t\('Accent color'\)/);
    assert.match(ui, /ACCENT_PRESETS\.map/);
    assert.match(ui, /type="color"/);
    assert.match(ui, /accentColor: ''/, '强调色恢复默认');
    assert.match(ui, /openThemeConfig\?\.\(\)[\s\S]*t\('Open config file'\)/);
    assert.match(ui, /resetThemeConfig\?\.\(\)[\s\S]*t\('Reset to default'\)/);
    assert.match(ui, /t\('Item \{n\} ignored: \{where\} — \{reason\}'/);
    assert.match(ui, /t\('Sync appearance across computers'\)/);
    assert.match(ui, /disabled=\{!sync\?\.s3Enabled\}/, '没配 S3 时开关不可用、显示未启用');
  });
  test('App：data-theme + 内联变量、跟随系统实时切换、theme.json 推送和同步来的设置都接上了', () => {
    const app = read('renderer', 'App.tsx');
    assert.match(app, /matchMedia\('\(prefers-color-scheme: dark\)'\)/);
    assert.match(app, /addEventListener\('change', onChange\)/);
    assert.match(app, /applyTheme\(document\.documentElement, settings, themeOverrides, systemPrefersDark/);
    assert.match(app, /onThemeConfig\?\.\(/);
    assert.match(app, /onAppearanceSynced\?\.\(\(synced: any\) => setSettings\(\(cur\) => applySyncedSettings\(/);
  });
  test('主进程：watch theme.json（目录 watch + 轮询兜底），IPC 三个 handler', () => {
    const m = read('main', 'index.ts');
    assert.match(m, /fs\.watch\(KIROLEX_HOME, \(_ev, name\) => \{ if \(!name \|\| String\(name\) === THEME_FILE\) scheduleThemeReload\(\); \}\)/);
    assert.match(m, /fs\.watchFile\(themeFilePath\(os\.homedir\(\)\)/);
    for (const ch of ['app:theme-config-get', 'app:theme-config-open', 'app:theme-config-reset', 'app:appearance-sync-status']) {
      assert.ok(m.includes(`ipcMain.handle('${ch}'`), ch);
      assert.ok(read('main', 'preload.ts').includes(`'${ch}'`), `preload ${ch}`);
    }
    assert.match(m, /mainWindow\?\.webContents\.send\('app:theme-config', r\.state\)/);
  });
});
