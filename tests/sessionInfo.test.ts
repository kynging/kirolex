import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sessionInfoRows, sessionInfoText } from '../src/renderer/sessionInfo.ts';

/**
 * 会话信息 ——「会话能查看/复制 id，并能按 id 找会话」。
 *
 * 会话 id（`s_<时间戳>_<6位>`）原来只在磁盘目录、日志和控制入口里看得到，排查时得靠标题去猜是哪条。
 * 这里守两件事：信息面板里**一次拿全**（id、后端会话 id、运行位置、引擎、会话目录）；
 * 「全部复制」出来的是 `key=value`，能直接拿去 `sessionId=` 过滤日志。
 */
const tr = (s: string, vars?: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_m, k) => String(vars?.[k] ?? ''));

const REMOTE = {
  id: 's_1760000000000_dl006j',
  cliSessionId: '0b8c-uuid',
  engine: 'claude' as const,
  remote: { label: 'gpu-box', sshHost: 'ubuntu@10.0.0.5' },
  dir: 'C:\\Users\\me\\.kirolex\\sessions\\s_1760000000000_dl006j',
};

describe('会话信息面板的几行', () => {
  test('五项都在，顺序固定：id、后端 id、运行位置、引擎、目录', () => {
    const rows = sessionInfoRows(REMOTE, tr);
    assert.deepEqual(rows.map((r) => r.key), ['id', 'cli', 'where', 'engine', 'dir']);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.equal(by.id.value, REMOTE.id);
    assert.equal(by.id.copy, REMOTE.id);
    assert.equal(by.cli.copy, '0b8c-uuid');
    assert.equal(by.where.value, 'gpu-box (ubuntu@10.0.0.5)');
    assert.equal(by.engine.value, 'Claude Code');
    assert.equal(by.dir.value, REMOTE.dir);
    assert.equal(by.dir.open, REMOTE.dir, '目录那一行能点开');
  });

  test('本地、kiro、还没连过后端：没有可复制的后端 id，而不是复制一句说明文字', () => {
    const rows = sessionInfoRows({ id: 's_1_abcdef', dir: '/h/.kirolex/sessions/s_1_abcdef' }, tr);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.equal(by.where.value, 'Local');
    assert.equal(by.engine.value, 'Kiro');
    assert.equal(by.cli.copy, '');
    assert.ok(by.cli.value.length > 0, '空着要说一声，不留白');
  });

  test('「全部复制」是 key=value，能直接拿去过滤日志', () => {
    const text = sessionInfoText(REMOTE);
    assert.match(text, /^sessionId=s_1760000000000_dl006j$/m);
    assert.match(text, /^cliSessionId=0b8c-uuid$/m);
    assert.match(text, /^where=ubuntu@10\.0\.0\.5$/m);
    assert.match(text, /^engine=claude$/m);
    assert.match(text, /^dir=C:\\Users\\me\\\.kirolex\\sessions\\s_1760000000000_dl006j$/m);
    assert.match(sessionInfoText({ id: 'x' }), /^where=local$/m);
    assert.match(sessionInfoText({ id: 'x' }), /^engine=kiro$/m);
  });
});

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
const SIDEBAR = read('renderer', 'components', 'Sidebar.tsx');
const MAIN = read('main', 'index.ts');
const PRELOAD = read('main', 'preload.ts');

describe('接线：菜单项、信息面板、按 id 找会话', () => {
  test('会话右键菜单里有「复制会话 id」，复制的就是这条会话的 id', () => {
    const at = SIDEBAR.indexOf("t('Copy session id')");
    assert.ok(at > 0, '菜单里要有这一项');
    const block = SIDEBAR.slice(Math.max(0, at - 600), at);
    assert.match(block, /copyToClipboard\(ctxSession\.id/);
  });

  test('会话右键菜单里有「会话信息…」，打开的是这条会话的信息', () => {
    const at = SIDEBAR.indexOf("t('Session info…')");
    assert.ok(at > 0);
    assert.match(SIDEBAR.slice(Math.max(0, at - 400), at), /setInfoFor\(ctxSession\.id\)/);
  });

  test('信息面板走 acp:session-info，三处都接上', () => {
    assert.ok(MAIN.includes("ipcMain.handle('acp:session-info'"));
    assert.ok(PRELOAD.includes("ipcRenderer.invoke('acp:session-info'"));
    assert.match(SIDEBAR, /kiroApi\?\.sessionInfo\?\.\(/);
    assert.match(SIDEBAR, /sessionInfoRows\(/);
  });

  test('主进程给的后端 id 先看活着的执行器、再看记录', () => {
    const at = MAIN.indexOf("ipcMain.handle('acp:session-info'");
    const block = MAIN.slice(at, at + 1500);
    assert.match(block, /sessionClients\.get\(/);
    assert.match(block, /cliSessionId/);
    assert.match(block, /store\.sessionDirPath\(/);
  });

  test('找会话的框用的是 searchSessions（同一份「什么算命中」，含 id）', () => {
    assert.match(SIDEBAR, /searchSessions\(sessions, finderQuery\)/);
    assert.ok(SIDEBAR.includes("t('Find chat by title or id…')"));
  });
});
