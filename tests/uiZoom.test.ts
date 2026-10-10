/**
 * 界面缩放（整窗按比例放大 / 缩小，像浏览器整页缩放）。
 *
 * 守的是：范围 80%～200%、一档 10%、到头不再变；旧配置没有这个值 / 坏值一律按 100%；
 * Ctrl(⌘) + 加号 / 减号 / 0 的识别（= 和小键盘 + 都算），以及不按 Ctrl 的 +/-/0 不归它管
 * —— 那是 PDF 预览自己的缩放键。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { UI_ZOOM_DEFAULT, UI_ZOOM_MAX, UI_ZOOM_MIN, UI_ZOOM_STEP, normalizeUiZoom, stepUiZoom } from '../src/renderer/uiZoom.ts';
import { zoomKeyAction } from '../src/main/zoomKeys.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');

describe('缩放值', () => {
  test('范围 80～200，一档 10，默认 100', () => {
    assert.equal(UI_ZOOM_MIN, 80);
    assert.equal(UI_ZOOM_MAX, 200);
    assert.equal(UI_ZOOM_STEP, 10);
    assert.equal(UI_ZOOM_DEFAULT, 100);
  });

  test('旧配置没有这个值、或者是坏值 → 100', () => {
    assert.equal(normalizeUiZoom(undefined), 100);
    assert.equal(normalizeUiZoom(null), 100);
    assert.equal(normalizeUiZoom('abc'), 100);
    assert.equal(normalizeUiZoom(NaN), 100);
    assert.equal(normalizeUiZoom(Infinity), 100);
  });

  test('越界的夹回范围，不在档位上的取最近一档', () => {
    assert.equal(normalizeUiZoom(10), 80);
    assert.equal(normalizeUiZoom(500), 200);
    assert.equal(normalizeUiZoom(123), 120);
    assert.equal(normalizeUiZoom(150), 150);
  });

  test('一档一档加减', () => {
    assert.equal(stepUiZoom(100, 'in'), 110);
    assert.equal(stepUiZoom(110, 'out'), 100);
    assert.equal(stepUiZoom(150, 'reset'), 100);
  });

  test('到 80% / 200% 就不再继续变', () => {
    assert.equal(stepUiZoom(200, 'in'), 200);
    assert.equal(stepUiZoom(80, 'out'), 80);
    let z = 100;
    for (let i = 0; i < 30; i++) z = stepUiZoom(z, 'in');
    assert.equal(z, 200);
    for (let i = 0; i < 30; i++) z = stepUiZoom(z, 'out');
    assert.equal(z, 80);
  });

  test('反复加减没有浮点漂移（存的是整数百分比）', () => {
    let z = 100;
    for (let i = 0; i < 7; i++) z = stepUiZoom(z, 'in');
    assert.equal(z, 170);
    assert.ok(Number.isInteger(z));
  });
});

describe('快捷键识别', () => {
  const key = (k: Partial<Parameters<typeof zoomKeyAction>[0]>) =>
    ({ type: 'keyDown', key: '', code: '', control: false, meta: false, alt: false, shift: false, ...k });

  test('Ctrl + = / + / 小键盘 + → 放大', () => {
    assert.equal(zoomKeyAction(key({ control: true, key: '=', code: 'Equal' }), 'win32'), 'in');
    assert.equal(zoomKeyAction(key({ control: true, shift: true, key: '+', code: 'Equal' }), 'win32'), 'in');
    assert.equal(zoomKeyAction(key({ control: true, key: '+', code: 'NumpadAdd' }), 'win32'), 'in');
  });

  test('Ctrl + - / 小键盘 - → 缩小；Ctrl + 0 / 小键盘 0 → 回 100%', () => {
    assert.equal(zoomKeyAction(key({ control: true, key: '-', code: 'Minus' }), 'win32'), 'out');
    assert.equal(zoomKeyAction(key({ control: true, key: '-', code: 'NumpadSubtract' }), 'linux'), 'out');
    assert.equal(zoomKeyAction(key({ control: true, key: '0', code: 'Digit0' }), 'win32'), 'reset');
    assert.equal(zoomKeyAction(key({ control: true, key: '0', code: 'Numpad0' }), 'win32'), 'reset');
  });

  test('macOS 用 ⌘，不用 Ctrl', () => {
    assert.equal(zoomKeyAction(key({ meta: true, key: '=', code: 'Equal' }), 'darwin'), 'in');
    assert.equal(zoomKeyAction(key({ control: true, key: '=', code: 'Equal' }), 'darwin'), null);
    assert.equal(zoomKeyAction(key({ meta: true, key: '=', code: 'Equal' }), 'win32'), null);
  });

  test('不按 Ctrl 的 +/-/0 不归它管（PDF 预览自己的缩放键）', () => {
    assert.equal(zoomKeyAction(key({ key: '+', code: 'NumpadAdd' }), 'win32'), null);
    assert.equal(zoomKeyAction(key({ key: '-', code: 'Minus' }), 'win32'), null);
    assert.equal(zoomKeyAction(key({ key: '0', code: 'Digit0' }), 'win32'), null);
  });

  test('只认按下；带 Alt 的、别的键都不算', () => {
    assert.equal(zoomKeyAction(key({ type: 'keyUp', control: true, key: '=', code: 'Equal' }), 'win32'), null);
    assert.equal(zoomKeyAction(key({ control: true, alt: true, key: '=', code: 'Equal' }), 'win32'), null);
    assert.equal(zoomKeyAction(key({ control: true, key: '1', code: 'Digit1' }), 'win32'), null);
    // NumLock 关着时小键盘 0 是 Insert —— Ctrl+Insert 是复制，不能被抢成「回到 100%」
    assert.equal(zoomKeyAction(key({ control: true, key: 'Insert', code: 'Numpad0' }), 'win32'), null);
  });
});

describe('接线', () => {
  const app = read('src', 'renderer', 'App.tsx');
  const main = read('src', 'main', 'index.ts');
  const preload = read('src', 'main', 'preload.ts');
  const dialog = read('src', 'renderer', 'components', 'SettingsDialog.tsx');
  const pdf = read('src', 'renderer', 'components', 'PdfView.tsx');

  test('读设置时把 uiZoom 规整一遍（旧配置没有 → 100）', () => {
    const at = app.indexOf('function loadSettings');
    assert.ok(at > 0);
    assert.match(app.slice(at, at + 1200), /merged\.uiZoom\s*=\s*normalizeUiZoom\(merged\.uiZoom\)/);
  });

  test('设置变了就把缩放应用到窗口', () => {
    assert.match(app, /setUiZoom\?\.\(\s*normalizeUiZoom\(settings\.uiZoom\)\s*\/\s*100\s*\)/);
    assert.match(preload, /webFrame\.setZoomFactor/);
  });

  test('快捷键在主进程 before-input-event 里拦下来，再交给渲染端改同一个设置', () => {
    const at = main.indexOf("'before-input-event'");
    assert.ok(at > 0, '主窗口要挂 before-input-event');
    const seg = main.slice(at, at + 600);
    assert.match(seg, /zoomKeyAction\(/);
    assert.match(seg, /preventDefault\(\)/);
    assert.match(seg, /'app:ui-zoom-key'/);
    assert.match(app, /onUiZoomKey\?\.\(/);
    assert.match(app, /stepUiZoom\(/);
  });

  test('设置对话框里有界面缩放（− 数值% + 和重置），字号改名为聊天字号', () => {
    assert.match(dialog, /t\('Interface zoom'\)/);
    assert.match(dialog, /settings\.uiZoom|zoom\}%/);
    assert.match(dialog, /t\('Chat font size'\)/);
  });

  test('PDF 预览按 Ctrl 的组合键仍然让开（不按 Ctrl 的 +/-/0 归它）', () => {
    assert.match(pdf, /if \(e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey\) return;/);
  });
});
