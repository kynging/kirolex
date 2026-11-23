import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 输入框永远不能被最小化。
 *
 * 用户反馈（2026-11-23）：输入框上方拖动条右侧有个悬停才出现的 ▼「隐藏输入框」按钮，紧挨着拖动改高度的把手，
 * 拖高度时误点，整个 chat-input-area 不渲染，看到的是「运行中输入框突然不见了」。
 * 现在删掉这个按钮和 inputCollapsed 状态：非 readOnly 时拖动把手和输入区始终渲染，
 * 渲染条件里只能有 readOnly（分屏旁观窗格本来就没有输入框，不算最小化）。
 */
const root = path.join(import.meta.dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const CHAT = read('src', 'renderer', 'components', 'ChatArea.tsx');
const CSS = read('src', 'renderer', 'styles', 'global.css');
const ZH = read('src', 'renderer', 'i18nZh', 'chat.ts');

describe('composer never collapses', () => {
  test('ChatArea has no collapse state or button', () => {
    assert.doesNotMatch(CHAT, /inputCollapsed|setInputCollapsed/);
    assert.doesNotMatch(CHAT, /input-collapse-btn/);
    assert.doesNotMatch(CHAT, /'Show input'|'Hide input'/);
  });

  test('chat-input-area renders whenever the pane is not readOnly', () => {
    const at = CHAT.indexOf('className="chat-input-area"\n');
    assert.ok(at > 0, 'composer chat-input-area not found');
    const head = CHAT.slice(CHAT.lastIndexOf('{', CHAT.lastIndexOf('<div', at)), at);
    assert.match(head, /^\{!readOnly && \(\s*<div\s*$/, `unexpected render guard: ${head}`);
  });

  test('resize handle renders unconditionally inside the non-readOnly resize area', () => {
    const at = CHAT.indexOf('<div className="input-resize-area">');
    assert.ok(at > 0);
    const block = CHAT.slice(at, CHAT.indexOf('className="input-resize-handle"', at));
    assert.doesNotMatch(block, /&&/, `resize handle is gated: ${block}`);
    assert.match(CHAT.slice(at, at + 1200), /onDoubleClick=\{\(\) => setInputHeight\(140\)\}/);
    assert.match(CHAT.slice(at, at + 1200), /Math\.max\(96,/);
  });

  test('collapse-only styles and i18n keys are gone', () => {
    assert.doesNotMatch(CSS, /\.input-collapse-btn/);
    assert.doesNotMatch(ZH, /"Show input"|"Hide input"/);
  });
});
