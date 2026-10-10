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
 * 「名字应该叫移动项目。里面不应该有移动到未分组的选项。而且现在第一个项目怎么显示在左边了，根本点不了」：
 * 入口原来写「🏷️ 移到项目：<当前项目>」，看起来就像左边菜单里一个能点的项目 —— 其实只是入口，点了没反应。
 */
describe('「移动项目」是一个子菜单入口', () => {
  const at = SB.indexOf("<Submenu label=\"🏷️ 移动项目\">");
  const block = SB.slice(at, SB.indexOf('</Submenu>', at));

  test('入口文字固定是「移动项目」，不带当前项目名', () => {
    assert.ok(at > 0);
    assert.equal(/移到项目：|归到项目/.test(SB), false);
  });
  test('不再平铺 Move to project / Assign to project 标题', () => {
    assert.equal(/'Move to project'|'Assign to project'/.test(SB), false);
  });
  test('子菜单里没有「移到未分组」，只有其他项目', () => {
    assert.equal(block.includes("t('Unassign')"), false);
    assert.equal(block.includes('onMoveSession(ctxSession.id, null)'), false);
    assert.ok(block.includes('projects.filter((p) => p !== ctxSession.projectId)'));
    assert.ok(block.includes('onMoveSession(ctxSession.id, p)'));
  });
  test('没有其他项目时显示一行灰色、不能点的提示', () => {
    assert.match(block, /context-menu-item disabled[^]*没有其他项目/);
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
