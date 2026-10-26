/**
 * 权限风险配色（`src/renderer/permissionTone.ts`）——「bypass permission 之类权限最大的选项按钮要变成红色」。
 *
 * 判据：三个引擎所有已知模式值、ExitPlanMode 的五个选项、普通的 allow_once / allow_always / reject；
 * 不认识的新模式默认 normal，名字带 bypass / full access 的兜底判 danger。
 * 颜色：暗色 / 亮色下文字 ≥ 4.5:1、边框 ≥ 3:1；global.css 里 `--perm-*` 和 TS 里的值一致，且不用引擎强调色。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BG_ALPHA, ENGINE_MODE_TONES, TONE_COLORS, TONE_ICONS, modeTone, optionTone, permissionIcon, toneClass,
} from '../src/renderer/permissionTone.ts';
import { ENGINE_ACCENTS, THEME_SURFACES, contrastRatio } from '../src/renderer/engineTheme.ts';

const SRC = path.join(import.meta.dirname, '..', 'src', 'renderer');
const CSS = fs.readFileSync(path.join(SRC, 'styles', 'global.css'), 'utf8');
const CHAT = fs.readFileSync(path.join(SRC, 'components', 'ChatArea.tsx'), 'utf8');
const BAR = fs.readFileSync(path.join(SRC, 'components', 'PermissionBar.tsx'), 'utf8');

describe('权限模式的风险档', () => {
  const cases: Array<[string, string, string]> = [
    ['kiro', 'auto-approve', 'danger'],
    ['kiro', 'ask', 'safe'],
    ['claude', 'default', 'safe'],
    ['claude', 'acceptEdits', 'caution'],
    ['claude', 'plan', 'safe'],
    ['claude', 'auto', 'caution'],
    ['claude', 'bypassPermissions', 'danger'],
    ['codex', 'read-only', 'safe'],
    ['codex', 'auto', 'caution'],
    ['codex', 'agent', 'caution'],
    ['codex', 'workspace-write', 'caution'],
    ['codex', 'full-access', 'danger'],
    ['codex', 'agent-full-access', 'danger'],
  ];
  for (const [engine, mode, tone] of cases) {
    test(`${engine} ${mode} → ${tone}`, () => assert.equal(modeTone(engine, mode), tone));
  }

  test('表里每一个已知模式都有用例', () => {
    for (const [engine, table] of Object.entries(ENGINE_MODE_TONES)) {
      for (const mode of Object.keys(table)) {
        assert.ok(cases.some(([e, m]) => e === engine && m === mode), `${engine} ${mode}`);
      }
    }
  });

  test('引擎缺省按 kiro', () => {
    assert.equal(modeTone(undefined, 'auto-approve'), 'danger');
    assert.equal(modeTone(null, 'ask'), 'safe');
  });

  test('不认识的新模式默认 normal；值或名字带 bypass / full access 的兜底判 danger', () => {
    assert.equal(modeTone('claude', 'someNewMode', 'Something new'), 'normal');
    assert.equal(modeTone('claude', 'dontAsk'), 'normal');
    assert.equal(modeTone('claude', 'bypassEverything'), 'danger');
    assert.equal(modeTone('codex', 'x', 'Full Access'), 'danger');
    assert.equal(modeTone('codex', 'danger-full-access'), 'danger');
    assert.equal(modeTone('claude', 'y', '跳过所有权限'), 'danger');
  });

  test('原型链上的名字不算已知模式', () => {
    assert.equal(modeTone('claude', 'toString'), 'normal');
    assert.equal(modeTone('kiro', 'constructor'), 'normal');
  });
});

describe('权限模式的图标：按模式区分，不只按档位', () => {
  const icons: Array<[string, string, string]> = [
    ['kiro', 'auto-approve', '⚠'],
    ['kiro', 'ask', '○'],
    ['claude', 'default', '○'],
    ['claude', 'acceptEdits', '◐'],
    ['claude', 'plan', '◌'],
    ['claude', 'auto', '●'],
    ['claude', 'bypassPermissions', '⚠'],
    ['codex', 'read-only', '○'],
    ['codex', 'auto', '●'],
    ['codex', 'agent', '◐'],
    ['codex', 'workspace-write', '◐'],
    ['codex', 'full-access', '⚠'],
    ['codex', 'agent-full-access', '⚠'],
  ];
  for (const [engine, mode, icon] of icons) {
    test(`${engine} ${mode} → ${icon}`, () => assert.equal(permissionIcon(engine, mode), icon));
  }

  test('表里每一个已知模式都有图标用例', () => {
    for (const [engine, table] of Object.entries(ENGINE_MODE_TONES)) {
      for (const mode of Object.keys(table)) {
        assert.ok(icons.some(([e, m]) => e === engine && m === mode), `${engine} ${mode}`);
      }
    }
  });

  test('同一引擎下已知模式的图标两两不同（auto 不再和 acceptEdits 一样是 ◐）', () => {
    /* codex 的 agent / workspace-write 是同一档「能写工作区」的新旧两个名字，不会同时出现在一个下拉里 */
    const dropdowns: Record<string, [string, string[]]> = {
      claude: ['claude', ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']],
      codex: ['codex', ['read-only', 'auto', 'agent', 'agent-full-access']],
      'codex（另一套名字）': ['codex', ['read-only', 'workspace-write', 'full-access']],
      kiro: ['kiro', ['ask', 'auto-approve']],
    };
    for (const [label, [engine, modes]] of Object.entries(dropdowns)) {
      const got = modes.map((m) => permissionIcon(engine, m));
      assert.equal(new Set(got).size, modes.length, `${label}: ${got.join(' ')}`);
    }
  });

  test('不认识的模式按档位兜底（TONE_ICONS）', () => {
    assert.equal(permissionIcon('claude', 'someNewMode', 'Something new'), TONE_ICONS.normal);
    assert.equal(permissionIcon('codex', 'x', 'Full Access'), TONE_ICONS.danger);
    assert.equal(permissionIcon('claude', 'toString'), TONE_ICONS.normal);
    assert.equal(permissionIcon(undefined, 'ask'), '○');
  });
});

describe('权限条选项的风险档', () => {
  test('ExitPlanMode 五个选项', () => {
    const exitPlan = [
      { optionId: 'exit-plan-default', name: 'Yes, manually approve edits', kind: 'allow_once' },
      { optionId: 'exit-plan-clear-bypass', name: 'Yes, clear context (4% used) and bypass permissions', kind: 'allow_always' },
      { optionId: 'exit-plan-bypass', name: 'Yes, and bypass permissions', kind: 'allow_always' },
      { optionId: 'exit-plan-auto', name: 'Yes, and use auto mode', kind: 'allow_always' },
      { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' },
    ];
    assert.deepEqual(exitPlan.map(optionTone), ['normal', 'danger', 'danger', 'caution', 'neutral']);
  });

  test('普通的三选一：允许一次 normal、总是允许 caution、拒绝 neutral', () => {
    assert.equal(optionTone({ optionId: 'allow-once', name: 'Yes', kind: 'allow_once' }), 'normal');
    assert.equal(optionTone({ optionId: 'allow-with-updates', name: "Yes, and don't ask again for example.com", kind: 'allow_always' }), 'caution');
    assert.equal(optionTone({ optionId: 'reject', name: 'No', kind: 'reject_once' }), 'neutral');
    assert.equal(optionTone({ optionId: 'reject-always', kind: 'reject_always' }), 'neutral');
  });

  test('名字 / optionId 带 bypass / full access / 跳过权限的判 danger（即使是 allow_once）', () => {
    assert.equal(optionTone({ optionId: 'x', name: 'Bypass permissions', kind: 'allow_once' }), 'danger');
    assert.equal(optionTone({ optionId: 'full_access', kind: 'allow_once' }), 'danger');
    assert.equal(optionTone({ optionId: 'y', name: '是，清空上下文并跳过权限', kind: 'allow_always' }), 'danger');
  });

  test('拒绝永远低调，哪怕名字里提到 bypass', () => {
    assert.equal(optionTone({ optionId: 'reject', name: "No, don't bypass permissions", kind: 'reject_once' }), 'neutral');
  });

  test('没有 kind 的选项按允许一次', () => {
    assert.equal(optionTone({ optionId: 'ok' }), 'normal');
  });

  test('class：normal 不挂（默认样式），其余是 perm-*', () => {
    assert.equal(toneClass('normal'), '');
    assert.equal(toneClass('danger'), 'perm-danger');
    assert.equal(toneClass('caution'), 'perm-caution');
    assert.equal(toneClass('neutral'), 'perm-neutral');
    assert.equal(toneClass('safe'), 'perm-safe');
  });

  test('danger 有 ⚠ 图标，danger / caution / normal / neutral 四档图标各不相同', () => {
    assert.equal(TONE_ICONS.danger, '⚠');
    assert.equal(new Set([TONE_ICONS.danger, TONE_ICONS.caution, TONE_ICONS.normal, TONE_ICONS.neutral]).size, 4);
  });

  test('权限条上不用绿：允许一次 normal、拒绝 neutral（绿在按钮上读作「通过」）', () => {
    const all = [
      { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'exit-plan-default', name: 'Yes, manually approve edits', kind: 'allow_once' },
      { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' },
      { optionId: 'reject', name: 'No', kind: 'reject_once' },
    ];
    assert.deepEqual(all.map(optionTone), ['normal', 'normal', 'neutral', 'neutral']);
  });
});

/* ── 对比度 ── */
const rgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const hex = (a: number[]) => '#' + a.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const over = (fg: string, alpha: number, bg: string) => hex(rgb(fg).map((v, i) => v * alpha + rgb(bg)[i] * (1 - alpha)));
/* 权限条自己的底：color-mix(--warning 12%, --input-bg)；亮色按同样的比例配 */
const SURFACES = {
  dark: [...THEME_SURFACES.dark, over('#ff9800', 0.12, '#2a2a2a')],
  light: [...THEME_SURFACES.light, over('#ff9800', 0.12, '#f0f0f0')],
};

describe('配色对比度（WCAG AA：文字 ≥ 4.5:1、图形 ≥ 3:1）', () => {
  for (const mode of ['dark', 'light'] as const) {
    for (const [tone, c] of Object.entries(TONE_COLORS[mode])) {
      test(`${mode} ${tone}`, () => {
        if (tone !== 'neutral') assert.ok(c.border, '红 / 琥珀 / 绿三档要有边框和浅底');
        for (const s of SURFACES[mode]) {
          const bgs = c.border ? [s, over(c.border, BG_ALPHA, s)] : [s];
          for (const bg of bgs) {
            const r = contrastRatio(c.text, bg);
            assert.ok(r >= 4.5, `文字 ${c.text} / ${bg} = ${r.toFixed(2)}`);
          }
          if (c.border) {
            const rb = contrastRatio(c.border, s);
            assert.ok(rb >= 3, `边框 ${c.border} / ${s} = ${rb.toFixed(2)}`);
          }
        }
      });
    }
  }
});

/** CIEDE2000（Sharma, Wu & Dalal 2005），和 tests/engineTheme.test.ts 里的同一份算法。 */
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
function hexToLab(h: string): number[] {
  const [r, g, b] = rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047);
  const y = f(r * 0.2126729 + g * 0.7151522 + b * 0.072175);
  const z = f((r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

describe('safe 绿和 Codex 青绿分得开（ΔE2000 ≥ 15）', () => {
  test('ΔE2000 实现对得上 Sharma 2005 的官方测试数据', () => {
    const cases: [number[], number[], number][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 2.5, 0], [73, 25, -18], 27.1492],
    ];
    for (const [a, b, want] of cases) assert.ok(Math.abs(deltaE2000(a, b) - want) < 1e-4);
  });
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}：safe 的文字 / 边框 vs Codex 的强调色 / 强调文字`, () => {
      const safe = TONE_COLORS[mode].safe;
      const codex = ENGINE_ACCENTS[mode].codex;
      for (const g of [safe.text, safe.border!]) {
        for (const c of [codex.accent, codex.text]) {
          const d = deltaE2000(hexToLab(g), hexToLab(c));
          assert.ok(d >= 15, `${g} vs ${c} ΔE = ${d.toFixed(1)}`);
        }
      }
    });
  }
});

describe('global.css 和 TS 一致、不随引擎变色', () => {
  const block = (selector: string) => {
    const i = CSS.indexOf(`${selector} {`);
    assert.ok(i >= 0, selector);
    return CSS.slice(i, CSS.indexOf('}', i));
  };
  const alphaOf = (h: string) => { const [r, g, b] = rgb(h); return `rgba(${r}, ${g}, ${b}, ${BG_ALPHA})`; };

  for (const [mode, selector] of [['dark', ':root'], ['light', '[data-theme="light"]']] as const) {
    test(`${selector} 里的 --perm-* 就是 TONE_COLORS.${mode}`, () => {
      const b = block(selector);
      for (const [tone, c] of Object.entries(TONE_COLORS[mode])) {
        assert.ok(b.includes(`--perm-${tone}: ${c.text};`), `${selector} --perm-${tone}`);
        if (!c.border) continue;
        assert.ok(b.includes(`--perm-${tone}-border: ${c.border};`), `${selector} --perm-${tone}-border`);
        assert.ok(b.includes(`--perm-${tone}-bg: ${alphaOf(c.border)};`), `${selector} --perm-${tone}-bg`);
      }
    });
  }

  test('暗色 danger 的边框就是 --error', () => {
    assert.ok(block(':root').includes(`--error: ${TONE_COLORS.dark.danger.border};`));
  });

  test('perm-* 的规则不用引擎强调色', () => {
    const rules = CSS.split('}').filter((r) => /\.perm-(danger|caution|safe|neutral)/.test(r));
    assert.ok(rules.length >= 4);
    assert.ok(rules.some((r) => /\.composer-mode\.perm-safe/.test(r)), '下拉关闭状态 / kiro 按钮有 safe 规则');
    assert.ok(rules.some((r) => /option\.perm-safe/.test(r)), '下拉展开的每一项有 safe 规则');
    for (const r of rules) assert.doesNotMatch(r, /engine-accent|--accent\b/, r);
  });

  test('Codex 的 Plan 开关开着时是低调灰（neutral），不用强调色', () => {
    const i = CSS.indexOf('.composer-mode.composer-plan.on {');
    assert.ok(i >= 0);
    const rule = CSS.slice(i, CSS.indexOf('}', i));
    assert.ok(rule.includes('color: var(--perm-neutral);'), rule);
    assert.ok(!/accent/.test(rule), rule);
    assert.equal(CSS.split('.composer-plan.on').length - 1, 1, '没有别的规则再覆盖它');
    /* 暗色：灰字落在 --bg-hover 上 ≥ 4.5:1；开着时前面有 ✓，不只靠颜色区分 */
    assert.ok(contrastRatio(TONE_COLORS.dark.neutral.text, '#353535') >= 4.5);
    assert.ok(CHAT.includes("{enginePlan.on ? '✓ ' : ''}{t('Plan')}"));
  });

  test('旧的 yolo / semi 已换成风险档', () => {
    assert.ok(!/\.composer-mode(\.composer-mode-select)?\.(yolo|semi)\b/.test(CSS));
    assert.ok(!/'yolo'|'semi'/.test(CHAT));
  });

  test('输入区的下拉 / kiro 按钮和权限条都用 permissionTone', () => {
    assert.ok(/from '\.\.\/permissionTone'/.test(CHAT));
    assert.ok(/modeTone\(engineMode\.engine/.test(CHAT));
    assert.ok(/modeTone\('kiro', permissionMode\)/.test(CHAT));
    assert.ok(/permissionIcon\(engineMode\.engine, o\.value, o\.name\)/.test(CHAT), '下拉每一项用 permissionIcon');
    assert.ok(/permissionIcon\('kiro', permissionMode\)/.test(CHAT), 'kiro 的 Ask 用 permissionIcon');
    assert.ok(!/TONE_ICONS\[/.test(CHAT), '不再按档位取图标');
    assert.ok(/from '\.\.\/permissionTone'/.test(BAR));
    assert.ok(/optionTone\(/.test(BAR));
  });
});
