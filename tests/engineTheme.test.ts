/**
 * 按引擎区分的强调色（Kiro 紫 / Claude Code 橙 / Codex 青绿）。
 *
 * 守的是：
 *   1. 三个引擎 × 明暗两套主题的颜色都满足 WCAG AA —— 当文字用的那一档对所有底色 ≥ 4.5:1，
 *      当图形用的那一档（色条、边框、发送按钮底、进度点）≥ 3:1，发送按钮上的图标对按钮底 ≥ 3:1；
 *   2. 开关关掉时三个引擎取的都是统一强调色（就是现在的 --accent），界面回到原样；
 *   3. 颜色不是唯一区分手段：每个引擎都有名字可显示；
 *   4. Kiro 是真正的紫（HSL 色相 255°–275°），三个引擎两两 ΔE2000 ≥ 20；
 *   5. 接线：侧栏行 / 分屏标题 / 会话区挂了 data-accent-engine，CSS 只在那几个小元素上用 --engine-accent，按钮（发送 / 排队等）一律不用。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ACCENT_ENGINES, ENGINE_ACCENTS, THEME_MODES, THEME_SURFACES, UNIFIED_ACCENT,
  accentEngine, contrastRatio, engineAccent, engineAccentCss, softOf,
} from '../src/renderer/engineTheme.ts';
import { engineLabel } from '../src/renderer/engineLabel.ts';

const SRC = path.join(import.meta.dirname, '..', 'src', 'renderer');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

describe('对比度计算本身是对的', () => {
  test('黑白 21:1、同色 1:1、与顺序无关', () => {
    assert.equal(Math.round(contrastRatio('#000000', '#ffffff') * 100) / 100, 21);
    assert.equal(contrastRatio('#7c6fe0', '#7c6fe0'), 1);
    assert.equal(contrastRatio('#d97757', '#1a1a1a'), contrastRatio('#1a1a1a', '#d97757'));
  });
  test('已知值：#767676 对白底约 4.54:1（AA 文字门槛附近的经典例子）', () => {
    const r = contrastRatio('#767676', '#ffffff');
    assert.ok(r > 4.5 && r < 4.6, `实际 ${r}`);
  });
});

describe('三引擎 × 明暗主题都满足 WCAG AA', () => {
  for (const mode of THEME_MODES) {
    for (const engine of ACCENT_ENGINES) {
      const set = ENGINE_ACCENTS[mode][engine];
      test(`${mode} · ${engine}：文字色对所有底色 ≥ 4.5:1`, () => {
        for (const bg of THEME_SURFACES[mode]) {
          const r = contrastRatio(set.text, bg);
          assert.ok(r >= 4.5, `${set.text} 对 ${bg} 只有 ${r.toFixed(2)}:1`);
        }
      });
      test(`${mode} · ${engine}：图形色对所有底色 ≥ 3:1`, () => {
        for (const bg of THEME_SURFACES[mode]) {
          const r = contrastRatio(set.accent, bg);
          assert.ok(r >= 3, `${set.accent} 对 ${bg} 只有 ${r.toFixed(2)}:1`);
        }
      });
      test(`${mode} · ${engine}：发送按钮上的图标对按钮底 ≥ 3:1`, () => {
        const r = contrastRatio(set.onAccent, set.accent);
        assert.ok(r >= 3, `${set.onAccent} 对 ${set.accent} 只有 ${r.toFixed(2)}:1`);
      });
    }
    test(`${mode}：统一强调色同样满足`, () => {
      const u = UNIFIED_ACCENT[mode];
      for (const bg of THEME_SURFACES[mode]) {
        assert.ok(contrastRatio(u.text, bg) >= 4.5, `${u.text} / ${bg}`);
        assert.ok(contrastRatio(u.accent, bg) >= 3, `${u.accent} / ${bg}`);
      }
      assert.ok(contrastRatio(u.onAccent, u.accent) >= 3);
    });
    test(`${mode}：三个引擎的颜色互不相同`, () => {
      const accents = ACCENT_ENGINES.map((e) => ENGINE_ACCENTS[mode][e].accent.toLowerCase());
      assert.equal(new Set(accents).size, 3);
    });
  }
  test('暗色主题的底色就是 global.css 里真实在用的那几个', () => {
    const css = read('styles', 'global.css');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    for (const name of ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover', '--input-bg']) {
      const m = root.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
      assert.ok(m, `${name} 没找到`);
      assert.ok(THEME_SURFACES.dark.includes(m![1].toLowerCase()), `${name}=${m![1]} 不在 THEME_SURFACES.dark 里`);
    }
  });
  test('统一色就是现在的 --accent / --accent-soft（全局强调色不改）', () => {
    const css = read('styles', 'global.css');
    assert.match(css, new RegExp(`--accent:\\s*${UNIFIED_ACCENT.dark.accent}`, 'i'));
    assert.match(css, /--accent-soft:\s*rgba\(124, 111, 224, 0\.22\)/);
    assert.equal(softOf(UNIFIED_ACCENT.dark.accent), 'rgba(124, 111, 224, 0.22)');
    assert.deepEqual(UNIFIED_ACCENT.dark, { accent: '#7c6fe0', text: '#a99ff0', onAccent: '#ffffff' });
  });
});

/** CIEDE2000（Sharma, Wu & Dalal 2005），输入 CIELAB。 */
function deltaE2000([L1, a1, b1]: number[], [L2, a2, b2]: number[]): number {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const ap1 = a1 * (1 + G), ap2 = a2 * (1 + G);
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hue = (b: number, a: number) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1 = hue(b1, ap1), h2 = hue(b2, ap2);
  let dh = 0;
  if (Cp1 * Cp2 !== 0) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dL = L2 - L1, dC = Cp2 - Cp1, dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);
  const Lbar = (L1 + L2) / 2, Cpbar = (Cp1 + Cp2) / 2;
  let hbar = h1 + h2;
  if (Cp1 * Cp2 !== 0) hbar = Math.abs(h1 - h2) > 180 ? (h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2) : (h1 + h2) / 2;
  const T = 1 - 0.17 * Math.cos((hbar - 30) * rad) + 0.24 * Math.cos(2 * hbar * rad)
    + 0.32 * Math.cos((3 * hbar + 6) * rad) - 0.2 * Math.cos((4 * hbar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbar - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cpbar ** 7 / (Cpbar ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const SC = 1 + 0.045 * Cpbar, SH = 1 + 0.015 * Cpbar * T, RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}
/** sRGB hex → CIELAB（D65）。 */
function hexToLab(hex: string): number[] {
  const n = parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047);
  const y = f(r * 0.2126729 + g * 0.7151522 + b * 0.072175);
  const z = f((r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a: string, b: string) => deltaE2000(hexToLab(a), hexToLab(b));

describe('色差：Kiro 和统一强调色、三个引擎之间一眼可分（ΔE2000 ≥ 15）', () => {
  test('ΔE2000 实现对得上 Sharma 2005 的官方测试数据', () => {
    const cases: [number[], number[], number][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
      [[50, 2.5, 0], [73, 25, -18], 27.1492],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
    ];
    for (const [a, b, want] of cases) {
      const got = deltaE2000(a, b);
      assert.ok(Math.abs(got - want) < 1e-4, `${a} / ${b}: ${got} ≠ ${want}`);
    }
    assert.ok(Math.abs(hexToLab('#ffffff')[0] - 100) < 1e-3);
    assert.ok(Math.abs(hexToLab('#000000')[0]) < 1e-9);
  });
  // 不要求 Kiro 和统一强调色拉开：Kiro 本来就是紫，统一色也是紫，相近可以接受
  // （以前那条「和统一色 ΔE ≥ 15」把 Kiro 推到了洋红，侧栏看着像粉色）
  for (const mode of THEME_MODES) {
    for (const key of ['accent', 'text'] as const) {
      test(`${mode}：三个引擎的 ${key} 两两 ΔE ≥ 20`, () => {
        for (let i = 0; i < ACCENT_ENGINES.length; i++) {
          for (let j = i + 1; j < ACCENT_ENGINES.length; j++) {
            const [x, y] = [ENGINE_ACCENTS[mode][ACCENT_ENGINES[i]][key], ENGINE_ACCENTS[mode][ACCENT_ENGINES[j]][key]];
            const d = deltaE(x, y);
            assert.ok(d >= 20, `${ACCENT_ENGINES[i]} ${x} / ${ACCENT_ENGINES[j]} ${y} 只有 ΔE ${d.toFixed(1)}`);
          }
        }
      });
    }
  }
});

/** sRGB hex → HSL 色相（度，0–360）。Kiro 「是不是紫」用这个口径。 */
function hslHue(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('Kiro 一眼就是紫（HSL 色相 255°–275°），不是粉 / 洋红', () => {
  test('色相算法本身是对的', () => {
    assert.equal(hslHue('#ff0000'), 0);
    assert.equal(hslHue('#0000ff'), 240);
    assert.equal(hslHue('#ff00ff'), 300);
    assert.ok(Math.abs(hslHue('#9046ff') - 264) < 0.1, `Kiro 品牌紫 #9046ff：${hslHue('#9046ff')}`);
    assert.ok(hslHue('#cc2cfa') > 275, '以前那个偏洋红的 #cc2cfa 应该落在范围外');
  });
  for (const mode of THEME_MODES) {
    for (const key of ['accent', 'text'] as const) {
      test(`${mode} · kiro.${key} 的色相在 255°–275°`, () => {
        const c = ENGINE_ACCENTS[mode].kiro[key];
        const h = hslHue(c);
        assert.ok(h >= 255 && h <= 275, `${c} 色相 ${h.toFixed(1)}°，不在 255°–275°`);
      });
    }
  }
});

describe('开关', () => {
  test('开：各引擎取自己的颜色；缺省 / 未知引擎按 kiro', () => {
    assert.deepEqual(engineAccent('claude', true, 'dark'), ENGINE_ACCENTS.dark.claude);
    assert.deepEqual(engineAccent('codex', true, 'light'), ENGINE_ACCENTS.light.codex);
    assert.deepEqual(engineAccent(undefined, true), ENGINE_ACCENTS.dark.kiro);
    assert.equal(accentEngine('weird'), 'kiro');
    assert.equal(accentEngine(null), 'kiro');
  });
  test('关：三个引擎、两套主题全部取统一色', () => {
    for (const mode of THEME_MODES) {
      for (const engine of ACCENT_ENGINES) {
        assert.deepEqual(engineAccent(engine, false, mode), UNIFIED_ACCENT[mode]);
      }
    }
  });
  test('生成的 CSS：开时每个引擎一条规则、带各自的颜色；关时全是统一色并藏起侧栏色条', () => {
    const on = engineAccentCss(true);
    for (const e of ACCENT_ENGINES) {
      assert.ok(on.includes(`[data-accent-engine="${e}"]`), e);
      assert.ok(on.includes(ENGINE_ACCENTS.dark[e].accent), e);
      assert.ok(on.includes(ENGINE_ACCENTS.light[e].accent), e);
    }
    assert.ok(!/session-accent-strip[^}]*display:\s*none/.test(on));
    const off = engineAccentCss(false);
    assert.ok(!off.includes(ENGINE_ACCENTS.dark.claude.accent));
    assert.ok(!off.includes(ENGINE_ACCENTS.dark.codex.accent));
    assert.ok(!off.includes(ENGINE_ACCENTS.dark.kiro.accent));
    assert.ok(!off.includes(ENGINE_ACCENTS.light.kiro.accent));
    assert.ok(off.includes(UNIFIED_ACCENT.dark.accent));
    assert.match(off, /\.session-accent-strip\s*\{\s*display:\s*none/);
  });
});

describe('颜色不是唯一区分手段', () => {
  test('每个引擎都有名字（徽标和色条的提示里显示）', () => {
    assert.deepEqual(ACCENT_ENGINES.map((e) => engineLabel(e)), ['Kiro', 'Claude Code', 'Codex']);
  });
  test('分屏标题旁的徽标同时带图标和引擎名', () => {
    const app = read('App.tsx');
    const i = app.indexOf('className="engine-badge"');
    assert.ok(i > 0, '没找到 engine-badge');
    const seg = app.slice(i - 300, i + 600);
    assert.match(seg, /EngineIcon|EngineBadgeIcon|IconClaudeSpark|IconCodex/);
    assert.match(seg, /engineLabel\(/);
  });
});

describe('接线', () => {
  test('App 按设置注入生成的 CSS，设置默认开', () => {
    const app = read('App.tsx');
    assert.match(app, /engineAccentCss\(settings\.engineAccents !== false\)/);
    assert.match(app, /engineAccents\?: boolean/);
    const dlg = read('components', 'SettingsDialog.tsx');
    assert.match(dlg, /key: 'engineAccents', store: 'settings'/);
  });
  test('侧栏行、分屏格、会话区都挂了 data-accent-engine', () => {
    assert.match(read('components', 'Sidebar.tsx'), /data-accent-engine=\{accentEngine\(session\.engine\)\}/);
    assert.match(read('components', 'Sidebar.tsx'), /className="session-accent-strip"/);
    assert.match(read('App.tsx'), /data-accent-engine=\{accentEngine\(session\?\.engine\)\}/);
    assert.match(read('components', 'ChatArea.tsx'), /data-accent-engine=\{accentEngine\(engine\)\}/);
  });
  test('只在那几个小元素上用 --engine-accent', () => {
    const css = read('styles', 'global.css');
    const users = new Set<string>();
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
      if (/var\(--engine-/.test(m[2])) for (const s of m[1].split(',')) users.add(s.replace(/\/\*[\s\S]*?\*\//g, '').trim());
    }
    const allowed = [
      '.session-accent-strip', '.engine-badge', '.engine-icon', '.composer:focus-within',
      '.thinking-dots span', '.agent-activity-pulse',
    ];
    assert.deepEqual([...users].filter((s) => !allowed.includes(s)), [], '强调色用到了允许范围之外');
    for (const s of ['.session-accent-strip', '.engine-badge', '.composer:focus-within', '.thinking-dots span']) {
      assert.ok(users.has(s), `${s} 没用 --engine-accent`);
    }
  });
  test('发送 / 排队 / 追加 / 停止按钮（.composer-send 各状态）不随引擎变色', () => {
    const css = read('styles', 'global.css');
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    let seen = 0;
    while ((m = re.exec(css))) {
      if (!m[1].includes('.composer-send')) continue;
      seen++;
      assert.ok(!/--engine-/.test(m[2]), `${m[1].trim()} 还在用 --engine-* 变量`);
    }
    assert.ok(seen >= 2, '没找到 .composer-send 的规则');
    const i = css.indexOf('.composer-send {');
    assert.match(css.slice(i, css.indexOf('}', i)), /background: var\(--accent\);/);
  });
});

describe('输入框焦点：按最终渲染出来的颜色算对比度，背景保持统一色', () => {
  const css = read('styles', 'global.css');
  const i = css.indexOf('.composer:focus-within {');
  const rule = css.slice(i, css.indexOf('}', i));
  const decl = (prop: string) => (rule.match(new RegExp(`\\n\\s*${prop}:\\s*([^;]+);`)) || [])[1]?.trim();
  /** CSS color-mix(in srgb, a p%, b) —— 线性按通道插值（sRGB 空间） */
  const mix = (a: string, p: number, b: string) => {
    const ch = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
    const [x, y] = [ch(a), ch(b)];
    return '#' + x.map((v, k) => Math.round(v * p + y[k] * (1 - p)).toString(16).padStart(2, '0')).join('');
  };
  const varIn = (text: string, name: string) => (text.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1];

  test('开：边框就是纯的引擎色（不再和 --border 混），对输入框底色和外面的底色都 ≥ 3:1', () => {
    assert.equal(decl('border-color'), 'var(--engine-accent-border, color-mix(in srgb, var(--accent) 58%, var(--border)))');
    const on = engineAccentCss(true).split('\n');
    for (const mode of THEME_MODES) {
      for (const engine of ACCENT_ENGINES) {
        const line = on.find((l) => l.startsWith(mode === 'light' ? `[data-theme="light"] [data-accent-engine="${engine}"]` : `[data-accent-engine="${engine}"]`))!;
        const border = varIn(line, '--engine-accent-border');
        assert.equal(border, ENGINE_ACCENTS[mode][engine].accent, `${mode}/${engine}`);
        // 焦点时输入框的底色是 input-bg 94% + 统一 accent 6%（见下一条）；外面是会话区底色
        const inputBg = THEME_SURFACES[mode][3];
        const focusedBg = mix(inputBg, 0.94, UNIFIED_ACCENT[mode].accent);
        for (const bg of [inputBg, focusedBg, THEME_SURFACES[mode][0]]) {
          const r = contrastRatio(border!, bg);
          assert.ok(r >= 3, `${mode}/${engine} 边框 ${border} 对 ${bg} 只有 ${r.toFixed(2)}:1`);
        }
      }
    }
  });
  test('原来那种 58% 混色确实不到 3:1（所以开关开着时不能再用它）', () => {
    for (const engine of ACCENT_ENGINES) {
      const mixed = mix(ENGINE_ACCENTS.dark[engine].accent, 0.58, '#333333');
      assert.ok(contrastRatio(mixed, '#2a2a2a') < 3, engine);
    }
  });
  test('关：不定义 --engine-accent-border，边框退回原来的统一混色', () => {
    assert.ok(!engineAccentCss(false).includes('--engine-accent-border'));
  });
  test('焦点时的背景不跟引擎变，还是原来的统一计算', () => {
    assert.equal(decl('background'), 'color-mix(in srgb, var(--input-bg) 94%, var(--accent) 6%)');
  });
});
