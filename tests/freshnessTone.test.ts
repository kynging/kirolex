/**
 * 恢复页新旧对比标签按状态分色（backupGroups.ts 的 freshnessClass + global.css）。
 *
 * 「两边一样」绿（--success）、「云上较新」琥珀（--warning）、「本机较新」蓝（--info，不用紫色 --accent：
 * 和 Kiro 引擎色混）、「本地没有」中性（--text-secondary）。颜色只走 CSS 变量。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshnessClass, type Freshness } from '../src/renderer/backupGroups.ts';

const ALL: Freshness[] = ['same', 'cloud-newer', 'local-newer', 'missing'];
const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');
const UI = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupDialog.tsx'), 'utf8');

/** `.backup-tag.<cls> { … }` 那条规则的内容 */
const rule = (cls: string): string => {
  const m = CSS.match(new RegExp(String.raw`\.backup-tag\.${cls}\s*\{([^}]*)\}`));
  assert.ok(m, `global.css 里没有 .backup-tag.${cls}`);
  return m![1];
};

describe('freshnessClass', () => {
  test('四种状态各一个 class，互不相同', () => {
    const cls = ALL.map(freshnessClass);
    assert.deepEqual(cls, ['fresh-same', 'fresh-cloud', 'fresh-local', 'fresh-missing']);
    assert.equal(new Set(cls).size, 4);
  });
  test('不再用 over / new 二分', () => {
    for (const f of ALL) assert.doesNotMatch(freshnessClass(f), /^(over|new)$/);
  });
});

describe('global.css', () => {
  const want: Array<[string, string]> = [
    ['fresh-same', '--success'], ['fresh-cloud', '--warning'], ['fresh-local', '--info'], ['fresh-missing', '--text-secondary'],
  ];
  for (const [cls, v] of want) {
    test(`.backup-tag.${cls} 用 ${v}（文字 + 55% 边框），不写死颜色`, () => {
      const body = rule(cls);
      assert.match(body, new RegExp(String.raw`color:\s*var\(${v}\)`));
      assert.match(body, new RegExp(String.raw`border-color:\s*color-mix\(in srgb, var\(${v}\) 55%, transparent\)`));
      assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b/i);
      assert.doesNotMatch(body, /--accent/);
    });
  }
  test('--info 在 :root 有定义', () => {
    const root = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('}', CSS.indexOf(':root {')));
    assert.match(root, /--info:\s*#[0-9a-f]{6};/i);
  });
  test('--info 文字对比度过 WCAG AA（对 --bg-primary / --bg-secondary ≥ 4.5）', () => {
    const root = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('}', CSS.indexOf(':root {')));
    const hex = (name: string): string => root.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, 'i'))![1];
    const lum = (h: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    for (const bg of ['bg-primary', 'bg-secondary']) assert.ok(ratio(hex('info'), hex(bg)) >= 4.5, bg);
  });
});

describe('接线', () => {
  test('恢复页每行按 freshnessClass 给 class', () => {
    assert.match(UI, /className=\{`backup-tag \$\{freshnessClass\(fresh\)\}`\}/);
    assert.doesNotMatch(UI, /fresh === 'cloud-newer' \? 'over' : 'new'/);
  });
  test('同步页「已同步」（原来也是灰）按「两边一样」上绿色', () => {
    assert.match(UI, /<span className=\{`backup-tag \$\{freshnessClass\('same'\)\}`\}>\{t\('Synced'\)\}<\/span>/);
  });
});
