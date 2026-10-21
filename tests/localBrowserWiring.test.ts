import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

/* local_browser 的接线（index.ts / 渲染端不能直接 import，按源码扫描守着） */

const src = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
const M = src('main', 'index.ts');

test('退出 KiroLex 时收掉浏览器连接（session.end / detach）', () => {
  /* 必须经过 createQuitGuard（挡住退出、等收尾），不能是 void 掉的 Promise */
  const at = M.indexOf("app.on('before-quit', createQuitGuard({");
  assert.ok(at > 0, 'before-quit 走 createQuitGuard');
  const block = M.slice(at, at + 400);
  assert.match(block, /needed: \(\) => !!localBrowserHost\?\.manager\.hasConnections\(\)/);
  assert.match(block, /cleanup: \(\) => localBrowserHost\?\.shutdown\(\)/);
  assert.match(block, /quit: \(\) => \{ isQuitting = true; app\.quit\(\); \}/);
  assert.doesNotMatch(M, /void localBrowserHost\.shutdown\(\)/);
});

test('本地工具通道带上浏览器工具；本地会话（新建 + 重连）挂上 kirolex-local，浏览器工具只在开关开着时列出', () => {
  const start = M.slice(M.indexOf('localMcpStarting = startLocalMcp({'), M.indexOf('localMcpStarting = startLocalMcp({') + 400);
  assert.match(start, /browser: \{\s*enabled: \(\) => localBrowser\(\)\.enabled\(\)/);
  /* 本地会话现在总是挂这条通道（定时 / 后台命令那组工具也在上面），不再只在浏览器开关开着时挂 */
  assert.match(M, /if \(!remote\?\.sshHost\) return withLocalBrowser\(sessionId, localComboTools\(sessionId, profile\)\);/);
  const AC = src('main', 'acp-client.ts');
  assert.match(AC, /if \(this\.engine === 'kiro' && !this\.remote\?\.sshHost && this\.localTools\?\.mcpServers\?\.length\) return this\.localTools\.mcpServers;/, '远程 kiro 不走这条');
  /* 新建也带上组合里的 MCP（新会话默认组合），和重连那条同一个写法 */
  assert.match(M, /: await withLocalBrowser\(kiroLexId, localComboTools\(kiroLexId, profile\)\);/);
  const fn = M.slice(M.indexOf('async function withLocalBrowser('), M.indexOf('async function withLocalBrowser(') + 900);
  assert.match(fn, /browserOnly: true/);
  /* 开关关着：浏览器那几个工具不列（判据在 tools/list，见 localMcp.toolDefs） */
  const LM = src('main', 'localMcp.ts');
  assert.match(LM, /tools: toolDefs\(\{ browser: !!deps\.browser\?\.enabled\(\), browserOnly: session\.browserOnly/);
  assert.match(LM, /const browser = opts\.browser \? browserToolDefs\(\) : \[\];/);
});

test('浏览器操作作为 kind=browser 的工具调用落盘、进回合面板', () => {
  assert.match(M, /ranSomething \|\| kindLower === 'browser'\)/);
  assert.match(M, /kind: 'browser', status/);
  const acp = src('renderer', 'hooks', 'useAcp.ts');
  assert.match(acp, /\|\| tc\.kind === 'browser'\) attachFileChangeToLatestTurn/);
  const chat = src('renderer', 'components', 'ChatArea.tsx');
  assert.match(chat, /<BrowserPanel fileChanges=\{turnFileChanges\} \/>/);
});

test('截图落盘前过 1500px 上限', () => {
  const fn = M.slice(M.indexOf('function localBrowser(): LocalBrowserHost'), M.indexOf('function localBrowser(): LocalBrowserHost') + 2000);
  assert.match(fn, /capPng: \(png\) => \{[\s\S]*capImageSize\(img\)/);
});

test('新域名确认框挂在 App 里，设置页在「开关」那一页', () => {
  assert.match(src('renderer', 'App.tsx'), /<BrowserDomainPrompt /);
  assert.match(src('renderer', 'components', 'SettingsDialog.tsx'), /<LocalBrowserSettings \/>/);
});
