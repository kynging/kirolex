/**
 * 折叠态的命令文字要看得清（2026-11-21 第 4 轮：「颜色太暗，几乎看不见命令是什么」）。
 *
 * 守：命令文字（.run-preview-text / .tool-collapsed-preview）用主文字色、≥12px、不叠 opacity；
 * 「已完成 N 条」「+N 行」用 --text-secondary、不叠 opacity；用主题变量不写死色值；
 * 两档文字色在折叠条可能落的底色上对比度 ≥ 4.5:1。
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { contrastRatio } from '../src/renderer/engineTheme.ts';

const css = fs.readFileSync(path.join(import.meta.dirname, '../src/renderer/styles/global.css'), 'utf8');

/** 某个选择器第一处规则块的内容 */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`));
  assert.ok(m, `找不到规则 ${selector}`);
  return m![1];
}
/** 一个主题块里的变量表（`:root` 或 `[data-theme="light"]`） */
function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)) out[m[1]] = m[2];
  return out;
}
const hex6 = (h: string) => (h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h);

describe('折叠态命令文字的颜色 / 字号', () => {
  test('命令文字：主文字色、不小于 12px、不叠 opacity', () => {
    for (const sel of ['.run-preview-text', '.tool-collapsed-preview']) {
      const r = rule(sel);
      assert.match(r, /color: var\(--text-primary\);/, sel);
      assert.doesNotMatch(r, /opacity/, sel);
    }
    assert.match(rule('.tool-collapsed-preview'), /font-size: 12px;/);
    assert.match(rule('.run-preview'), /font-size: 12px;/, '.run-preview-text 继承它的字号');
    assert.doesNotMatch(rule('.run-preview-text'), /font-size/, '不另设更小的字号');
    assert.doesNotMatch(css, /\.tool-collapsed-preview:hover \{[^}]*opacity/, '不再靠 hover 才恢复亮度');
  });
  test('辅助信息（已完成 N 条 / +N 行）：--text-secondary，不用 --text-muted，不叠 opacity', () => {
    const r = rule('.run-preview-more,\n.run-preview-done');
    assert.match(r, /color: var\(--text-secondary\);/);
    assert.doesNotMatch(r, /opacity/);
    assert.doesNotMatch(rule('.run-preview'), /--text-muted|opacity/);
  });
  test('运行指示的蓝色保留', () => {
    assert.match(rule('.tool-running-indicator'), /color: #58a6ff;/);
  });
});

describe('对比度 ≥ 4.5:1（每个主题的文字色 × 折叠条可能落的底色）', () => {
  const root = vars(css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {'))));
  const lightStart = css.indexOf('[data-theme="light"] {');
  const light = { ...root, ...vars(css.slice(lightStart, css.indexOf('}', lightStart))) };
  for (const [name, theme] of [['深色', root], ['浅色', light]] as const) {
    test(name, () => {
      for (const fg of ['--text-primary', '--text-secondary']) {
        for (const bg of ['--bg-primary', '--bg-secondary', '--bg-tertiary']) {
          const ratio = contrastRatio(hex6(theme[fg]), hex6(theme[bg]));
          assert.ok(ratio >= 4.5, `${name} ${fg} on ${bg}: ${ratio.toFixed(2)}`);
        }
      }
    });
  }
});
