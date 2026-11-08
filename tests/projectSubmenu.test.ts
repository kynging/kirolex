/**
 * 会话右键菜单：「移到项目」收进右侧展开的子菜单 —— 项目一多，平铺的菜单在屏幕里显示不全。
 * 子菜单本身也可能很长：限高 + 自己滚动，往下展开会出屏幕底部就往上挪。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { placeSubmenu } from '../src/renderer/menuPlacement.ts';

const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');
const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');

describe('子菜单竖直方向留在屏幕内', () => {
  test('放得下时就贴着入口那一行（默认 -5px）', () => {
    assert.equal(placeSubmenu({ rowTop: 100, height: 200, viewportHeight: 800 }), -5);
  });
  test('往下会出底部就往上挪，底边留边', () => {
    // 入口在 600，面板 300 高：600-5+300=895 > 794 → 顶到 800-6-300=494，相对入口 -106
    assert.equal(placeSubmenu({ rowTop: 600, height: 300, viewportHeight: 800 }), -106);
  });
  test('比屏幕还高时贴顶（CSS 限高后其实不会发生），不出现负坐标', () => {
    assert.equal(placeSubmenu({ rowTop: 600, height: 2000, viewportHeight: 800 }), 6 - 600);
  });
});

/*
 * 「名字应该叫移动项目。……而且现在第一个项目怎么显示在左边了，根本点不了」（当时还说「里面不应该有移动到
 * 未分组的选项」，2026-11-08 被用户推翻，见下）：
 * 入口原来写「🏷️ 移到项目：<当前项目>」，看起来就像左边菜单里一个能点的项目 —— 其实只是入口，点了没反应。
 */
describe('「移动项目」是一个子菜单入口', () => {
  const at = SB.indexOf("<Submenu label={t('🏷️ Move to project')}>");
  const block = SB.slice(at, SB.indexOf('</Submenu>', at));

  test('入口文字固定是「移动项目」，不带当前项目名', () => {
    assert.ok(at > 0);
    assert.equal(/移到项目：|归到项目/.test(SB), false);
  });
  test('不再平铺 Move to project / Assign to project 标题', () => {
    assert.equal(/'Move to project'|'Assign to project'/.test(SB), false);
  });
  /*
   * 2026-11-08 用户口径改了：「右键移到项目里没有未分组」—— 拖到 Unassigned 早就能取消分组，归档菜单也有
   * 「恢复到未分组」，只有右键子菜单不行，规则自相矛盾。现在子菜单顶部加「📥 未分组」。
   */
  const unassign = block.indexOf("📥 {t('Unassigned')}");
  const list = block.indexOf('projects.filter(');
  test('在项目里的会话：子菜单顶部有「📥 未分组」，点了走 moveInto(id, null)', () => {
    assert.ok(unassign > 0, '子菜单里要有「📥 未分组」');
    assert.ok(unassign < list, '「未分组」在项目列表上面');
    const item = block.slice(block.lastIndexOf('<div', unassign), unassign);
    assert.match(item, /onClick=\{\(\) => \{ moveInto\(ctxSession\.id, null\); setContextMenu\(null\); \}\}/,
      '和拖到未分组同一条路径（moveInto），点完关菜单');
  });
  test('已在未分组的会话不出现该项：只在有 projectId 时渲染；和项目列表之间有分隔线', () => {
    assert.match(block.slice(0, unassign), /^[^]*\{ctxSession\.projectId && \(\s*<>\s*<div[^<]*$/,
      '「未分组」那一项被 ctxSession.projectId 包着');
    assert.match(block.slice(unassign, list), /context-menu-divider/);
  });
  test('其他项目照旧列出', () => {
    assert.ok(block.includes('projects.filter((p) => p !== ctxSession.projectId)'));
    assert.ok(block.includes('moveInto(ctxSession.id, p)'));
  });
  test('既没有其他项目、也不能移到未分组时，才显示一行灰色、不能点的提示', () => {
    assert.match(block, /context-menu-item disabled[^]*t\('No other projects'\)/);
    assert.match(block, /\{!ctxSession\.projectId && !projects\.some\(\(p\) => p !== ctxSession\.projectId\) && \(/,
      '会话在项目里时「未分组」本身就是可选项，不该再说"没有其他项目"');
  });
});

describe('子菜单面板限高、可滚动', () => {
  test('max-height 不超过可见区域，纵向滚动', () => {
    assert.match(CSS, /\.context-submenu-panel \{[^}]*max-height: calc\(100vh - 12px\)/s);
    assert.match(CSS, /\.context-submenu-panel \{[^}]*overflow-y: auto/s);
  });
  test('Submenu 量完自己的高度再用 placeSubmenu 定位', () => {
    assert.match(SB, /placeSubmenu\(/);
  });
});
