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
  BG_ALPHA, ENGINE_MODE_TONES, TONE_COLORS, TONE_ICONS, modeTone, optionTone, toneClass,
} from '../src/renderer/permissionTone.ts';
import { THEME_SURFACES, contrastRatio } from '../src/renderer/engineTheme.ts';

const SRC = path.join(import.meta.dirname, '..', 'src', 'renderer');
const CSS = fs.readFileSync(path.join(SRC, 'styles', 'global.css'), 'utf8');
const CHAT = fs.readFileSync(path.join(SRC, 'components', 'ChatArea.tsx'), 'utf8');
const BAR = fs.readFileSync(path.join(SRC, 'components', 'PermissionBar.tsx'), 'utf8');

describe('权限模式的风险档', () => {
  const cases: Array<[string, string, string]> = [
    ['kiro', 'auto-approve', 'danger'],
    ['kiro', 'ask', 'normal'],
    ['claude', 'default', 'normal'],
    ['claude', 'acceptEdits', 'caution'],
    ['claude', 'plan', 'neutral'],
    ['claude', 'auto', 'caution'],
    ['claude', 'bypassPermissions', 'danger'],
    ['codex', 'read-only', 'normal'],
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
    assert.equal(modeTone(null, 'ask'), 'normal');
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
  });

  test('danger 有 ⚠ 图标，四档图标各不相同', () => {
    assert.equal(TONE_ICONS.danger, '⚠');
    assert.equal(new Set(Object.values(TONE_ICONS)).size, 4);
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
        if (tone !== 'neutral') assert.ok(c.border, '红 / 琥珀两档要有边框和浅底');
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
    const rules = CSS.split('}').filter((r) => /\.perm-(danger|caution|neutral)/.test(r));
    assert.ok(rules.length >= 3);
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
    assert.ok(/from '\.\.\/permissionTone'/.test(BAR));
    assert.ok(/optionTone\(/.test(BAR));
  });
});
