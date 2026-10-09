/**
 * 右侧文件预览栏自己的搜索（Ctrl/Cmd+F）。
 *
 * 原来不管焦点在哪,Ctrl+F 都只开聊天区那一格的搜索条 —— 在预览栏里读文档时想搜一个词,
 * 结果搜的是旁边的聊天记录。现在焦点在预览栏里时,Ctrl+F 归预览栏;回到聊天区再归聊天区。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PREVIEW_FIND_KEY, PREVIEW_PANEL_SELECTOR, findOwner, isInPreview, keepActive, previewSearchable,
} from '../src/renderer/previewFind.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');
const CHAT = read('src', 'renderer', 'components', 'ChatArea.tsx');
const APP = read('src', 'renderer', 'App.tsx');
const PF = read('src', 'renderer', 'components', 'PreviewFind.tsx');
const HL = read('src', 'renderer', 'findHighlight.ts');

/** 假的 DOM 元素：只要有 `closest`,能说出自己在不在某个祖先里。 */
const fakeEl = (inside: boolean) => ({ closest: (sel: string) => (inside && sel === PREVIEW_PANEL_SELECTOR ? {} : null) });

describe('Ctrl+F 归谁', () => {
  test('焦点在预览栏里、预览栏开着 → 预览栏', () => {
    assert.equal(findOwner({ previewShown: true, focusInPreview: true }), 'preview');
  });

  test('焦点在聊天区 → 聊天区（照旧）', () => {
    assert.equal(findOwner({ previewShown: true, focusInPreview: false }), 'chat');
  });

  test('预览栏藏起来 / 关掉了,哪怕之前点过它也归聊天区 —— 否则按 Ctrl+F 什么都不出', () => {
    assert.equal(findOwner({ previewShown: false, focusInPreview: true }), 'chat');
  });
});

describe('点的 / 聚焦的东西在不在预览栏里', () => {
  test('预览栏里的元素算', () => {
    assert.equal(isInPreview(fakeEl(true)), true);
  });

  test('预览栏外的元素不算', () => {
    assert.equal(isInPreview(fakeEl(false)), false);
  });

  test('null、文本节点（没有 closest）、window 都不算,也不抛', () => {
    assert.equal(isInPreview(null), false);
    assert.equal(isInPreview(undefined), false);
    assert.equal(isInPreview({}), false);
    assert.equal(isInPreview('x'), false);
  });

  test('文本节点按它的父元素算 —— 点在一段字上,事件的 target 可能就是文本节点', () => {
    assert.equal(isInPreview({ parentElement: fakeEl(true) }), true);
    assert.equal(isInPreview({ parentElement: fakeEl(false) }), false);
  });
});

describe('哪些预览能搜', () => {
  test('文本 / Markdown / 代码能搜', () => {
    assert.equal(previewSearchable({ deck: false, image: false, binary: false }), true);
  });

  test('PDF / PPT（按页画出来的）、图片、二进制不能搜', () => {
    assert.equal(previewSearchable({ deck: true, image: false, binary: false }), false);
    assert.equal(previewSearchable({ deck: false, image: true, binary: false }), false);
    assert.equal(previewSearchable({ deck: false, image: false, binary: true }), false);
  });
});

describe('内容刷新后当前是第几个', () => {
  test('还在范围内就留在原地,不跳回第 1 个', () => {
    assert.equal(keepActive(3, 9), 3);
  });

  test('命中变少了就落到最后一个', () => {
    assert.equal(keepActive(7, 4), 4);
  });

  test('原来没定位过、现在有命中 → 第 1 个;现在没命中 → 0', () => {
    assert.equal(keepActive(0, 5), 1);
    assert.equal(keepActive(3, 0), 0);
  });
});

describe('接线', () => {
  test('高亮用独立的 key,不可能和聊天格（会话 id）撞上', () => {
    // 会话 id 只能是 ^[A-Za-z0-9_-]+$（sessionStore.safeId）,带冒号就永远不会重名
    assert.match(PREVIEW_FIND_KEY, /:/);
    assert.match(PF, /setPaneRanges\(PREVIEW_FIND_KEY/);
    assert.match(PF, /clearPane\(PREVIEW_FIND_KEY\)/);
  });

  test('「当前那一个」按格子分开存 —— 预览栏按 ↓ 不会抹掉聊天格当前项的颜色', () => {
    assert.match(HL, /const activeByPane = new Map<string, Range>\(\)/);
  });

  test('预览栏的搜索打开时,聊天格的 Ctrl+F 不响应', () => {
    assert.match(CHAT, /if \(!paneFocused \|\| findSuspended\) return;/);
    assert.match(APP, /findSuspended=\{previewOwnsFind\}/);
  });

  test('换标签页 / 切原文排版 / 开关批注 / 内容刷新都会重算', () => {
    const at = APP.indexOf('<PreviewFind');
    assert.ok(at > 0, 'App 里没有挂 PreviewFind');
    const block = APP.slice(at, at + 800);
    for (const prop of ['tabId=', 'raw=', 'commenting=', 'content=']) assert.ok(block.includes(prop), `少了 ${prop}`);
  });
});
