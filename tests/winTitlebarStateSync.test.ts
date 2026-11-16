import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/*
  「非全屏模式下右上角最小化 / 最大化按钮消失了」：窗口已经离开最大化（远程桌面重连、贴靠、从最小化还原……）
  却没收到 unmaximize，渲染层的 winMaxed 卡在 true，标题条一直自动收起。
*/
const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');
const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');

test('主进程：除了 maximize/unmaximize/全屏，还在 restore / show / resize（去抖）/ 显示器变化时重算，状态变了才推', () => {
  assert.match(M, /import \{[^}]*\bscreen\b[^}]*\} from 'electron';/);
  assert.match(M, /const maximized = win\.isMaximized\(\) \|\| win\.isFullScreen\(\);/);
  assert.match(M, /if \(!force && maximized === lastTitleBarMaxed\) return;/);
  assert.match(M, /for \(const ev of \['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore', 'show'\] as const\) win\.on\(ev as any, \(\) => applyTitleBar\(\)\);/);
  assert.match(M, /win\.on\('resize', scheduleTitleBarCheck\);/);
  assert.match(M, /titleBarCheckTimer = setTimeout\(\(\) => \{ titleBarCheckTimer = null; applyTitleBar\(\); \}, \d+\);/);
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) assert.ok(M.includes(`'${ev}'`), ev);
  assert.match(M, /screen\.on\(ev as any, scheduleTitleBarCheck\)/);
  assert.match(M, /screen\.removeListener\(ev as any, scheduleTitleBarCheck\)/, '窗口关掉要摘掉 screen 监听');
  assert.match(M, /win\.webContents\.on\('did-finish-load', \(\) => applyTitleBar\(true\)\);/, '页面重载后一定要推一次');
});

test('主进程 + preload：只读的 window:state 返回真实 {maximized, height}', () => {
  assert.match(M, /ipcMain\.handle\('window:state', \(\) => \{/);
  assert.match(M, /return \{ maximized: win\.isMaximized\(\) \|\| win\.isFullScreen\(\), height: WIN_TITLEBAR_HEIGHT \};/);
  assert.match(P, /windowState: \(\) => ipcRenderer\.invoke\('window:state'\)/);
});

test('渲染层：重新获得焦点 / 页面重新可见时向主进程要一次真实状态，对不上就纠正 winMaxed', () => {
  assert.match(A, /kiroApi\?\.windowState\?\.\(\)/);
  assert.match(A, /if \(r\.maximized === winMaxedRef\.current\) return;/);
  assert.match(A, /setWinMaxed\(r\.maximized\);/);
  assert.match(A, /window\.addEventListener\('focus', syncWinState\);/);
  assert.match(A, /document\.addEventListener\('visibilitychange', onVisible\);/);
  assert.match(A, /window\.removeEventListener\('focus', syncWinState\);/);
  assert.match(A, /document\.removeEventListener\('visibilitychange', onVisible\);/);
});
