/**
 * 界面缩放调大、窗口按 CSS px 变窄时，侧栏 / 预览栏临时让位，聊天区（输入框、发送键）不能被挤没。
 * 1024×768 / 1366×768 的窗口开 200%，按 CSS px 算只有 512 / 683 宽。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { autoFoldPanels, CHAT_FIT_MIN, PANEL_FIT_RESERVE, filePanelMax } from '../src/renderer/panelFit.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');
const base = { sidebarWidth: 240, sidebarCollapsed: false, previewOpen: true, previewWidth: 320 };
const chatWidth = (winWidth: number, r: { sidebar: boolean; preview: boolean }, i = base) =>
  winWidth - (!i.sidebarCollapsed && !r.sidebar ? i.sidebarWidth : 0) - (i.previewOpen && !r.preview ? i.previewWidth : 0) - PANEL_FIT_RESERVE;

describe('放得下就什么都不收', () => {
  test('100% 下常见窗口（1024 / 1920 宽）两栏都在', () => {
    assert.deepEqual(autoFoldPanels({ ...base, winWidth: 1024 }), { sidebar: false, preview: false });
    assert.deepEqual(autoFoldPanels({ ...base, winWidth: 1920 }), { sidebar: false, preview: false });
  });
});

describe('放不下时先收侧栏，再收预览栏', () => {
  test('1366 宽开 200%（683）：收侧栏，预览栏留着，聊天区够宽', () => {
    const r = autoFoldPanels({ ...base, winWidth: 683 });
    assert.deepEqual(r, { sidebar: true, preview: false });
    assert.ok(chatWidth(683, r) >= CHAT_FIT_MIN);
  });

  test('1024 宽开 200%（512）：两栏都收，聊天区够宽', () => {
    const r = autoFoldPanels({ ...base, winWidth: 512 });
    assert.deepEqual(r, { sidebar: true, preview: true });
    assert.ok(chatWidth(512, r) >= CHAT_FIT_MIN);
  });

  test('没开预览栏时只看侧栏', () => {
    const i = { ...base, previewOpen: false };
    assert.deepEqual(autoFoldPanels({ ...i, winWidth: 683 }), { sidebar: false, preview: false });
    assert.deepEqual(autoFoldPanels({ ...i, winWidth: 600 }), { sidebar: false, preview: false });
    assert.deepEqual(autoFoldPanels({ ...i, winWidth: 512 }), { sidebar: true, preview: false });
  });

  test('用户自己收起的栏不算在里面（本来就不占地方）', () => {
    assert.deepEqual(autoFoldPanels({ ...base, sidebarCollapsed: true, winWidth: 683 }), { sidebar: false, preview: false });
  });

  test('窗口变宽 / 缩放调小，同一组输入算出来就不收了（不需要「恢复」这一步）', () => {
    assert.deepEqual(autoFoldPanels({ ...base, winWidth: 512 }), { sidebar: true, preview: true });
    assert.deepEqual(autoFoldPanels({ ...base, winWidth: 1024 }), { sidebar: false, preview: false });
  });
});

describe('用户在当前宽度下亲手点开的那一栏不收', () => {
  test('点开了侧栏 → 侧栏留着，改收预览栏', () => {
    assert.deepEqual(autoFoldPanels({ ...base, winWidth: 683, pinnedSidebar: true }), { sidebar: false, preview: true });
  });
  test('两栏都点开了 → 都不收（用户自己的选择）', () => {
    assert.deepEqual(autoFoldPanels({ ...base, winWidth: 512, pinnedSidebar: true, pinnedPreview: true }), { sidebar: false, preview: false });
  });
});

describe('接线', () => {
  const app = read('src', 'renderer', 'App.tsx');
  test('App 用 autoFoldPanels 的结果决定两栏显示，用的是缩放后的窗口宽度', () => {
    assert.match(app, /autoFoldPanels\(\{/);
    assert.match(app, /winWidth/);
    // 侧栏、预览栏的渲染都看「实际是否收起」而不是只看用户的开关
    assert.match(app, /\{!sidebarHidden && \(\s*<div style=\{\{ width: sidebarWidth/);
    assert.match(app, /\(fileViewerLoading \|\| fileViewer\) && !previewHidden && \(/);
  });
  test('自动收起不写进用户的开关（不改、不存 sidebarCollapsed / fileViewerHidden）', () => {
    const at = app.indexOf('autoFoldPanels({');
    const seg = app.slice(at, at + 800);
    assert.doesNotMatch(seg, /setSidebarCollapsed|setFileViewerHidden/);
  });
});

describe('右侧栏最宽能拉到多少：只看窗口宽 − 侧栏 − 聊天区最少 240，没有固定上限', () => {
  const max = (winWidth: number, sidebarShownWidth: number) =>
    filePanelMax({ winWidth, sidebarShownWidth, chatMin: 240, panelMin: 320 });
  test('1920 宽、侧栏开着：能拉到聊天区只剩 240（不再被 1100 卡住）', () => {
    assert.equal(max(1920, 240), 1920 - 240 - 240);
    assert.equal(max(1920, 0), 1920 - 240);
  });
  test('窗口变窄，上限跟着收回，聊天区永远留 240', () => {
    for (const w of [2560, 1920, 1512, 1440, 1024, 800]) {
      assert.equal(w - 240 - max(w, 240), 240, `窗口 ${w}`);
    }
  });
  test('再窄也不低于 FILE_PANEL_MIN（那时由 autoFoldPanels 收栏保聊天区）', () => {
    assert.equal(max(600, 240), 320);
    assert.equal(max(300, 0), 320);
  });
  test('App 按它夹拖拽和显示宽度，不再写死 1100', () => {
    const app = read('src', 'renderer', 'App.tsx');
    assert.match(app, /const fileViewerMax = filePanelMax\(\{ winWidth, sidebarShownWidth: sidebarHidden \? 0 : sidebarWidth, chatMin: CHAT_MIN_WIDTH, panelMin: FILE_PANEL_MIN \}\);/);
    assert.doesNotMatch(app, /Math\.min\(1100,/);
  });
});
