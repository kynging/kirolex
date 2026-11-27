import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 大份记忆整理（token 优化 4/5）的接线：index.ts / ChatArea.tsx 不能 import，按源码文本断言。
 */
const src = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf-8');
const M = src('main', 'index.ts');
const slice = (text: string, anchor: string, len = 3000): string => {
  const at = text.indexOf(anchor);
  assert.ok(at >= 0, `找不到 ${anchor}`);
  return text.slice(at, at + len);
};

describe('主进程接线', () => {
  test('一轮结束时触发（和旧的会话记忆整理并排），不等它', () => {
    assert.match(M, /void maybeConsolidateSessionMemory\(sessionId\);\s*\n(?:\s*\/\/[^\n]*\n)?\s*void maybeCompactLargeMemory\(sessionId\);/);
  });

  test('全局层不进自动整理：只轮会话 / 项目两层，并且经 autoCompactDue 判', () => {
    const body = slice(M, 'async function maybeCompactLargeMemory(');
    const end = body.indexOf('\n}\n');
    const fn = body.slice(0, end);
    assert.match(fn, /for \(const scope of \['session', 'project'\] as const\)/);
    assert.doesNotMatch(fn, /'global'/);
    assert.match(fn, /autoCompactDue\(/);
    assert.match(fn, /isFeatureEnabled\('largeMemoryCompact'\)/);
  });

  test('手动「立即整理」也不整理全局层', () => {
    const h = slice(M, "ipcMain.handle('acp:memory-compact-now'", 600);
    assert.match(h, /scope !== 'session' && scope !== 'project'/);
  });

  test('开关默认开', () => {
    assert.match(slice(M, 'const FEATURE_DEFAULTS', 4000), /largeMemoryCompact: true/);
  });

  test('写成了在会话里留提示，noteGroup 带备份路径；先记一天一次的账再整理', () => {
    const fn = slice(M, 'async function compactLargeMemoryLayer(', 4000);
    assert.match(fn, /noteInSession\(noteSessionId,[\s\S]*memoryCompactGroup\(outcome\.backupPath\)\)/);
    assert.ok(fn.indexOf('recordCompactDay(') < fn.indexOf('runLargeCompaction('));
    assert.match(fn, /backupMemoryFile\(file, new Date\(\)\)/);
  });

  test('一天一次在锁里重判：自动的走 gatedCompaction（现读账本 / 大小），手动的不看', () => {
    const fn = slice(M, 'async function compactLargeMemoryLayer(', 4000);
    assert.match(fn, /gatedCompaction\(scope, key, auto,/);
    assert.match(fn, /recheck: \(\) => \(\{\s*lastDay: readCompactLedger\(MEMORY_COMPACT_LEDGER\)\[key\]/);
    assert.match(fn, /fs\.statSync\(file\)\.size/);
    assert.match(M, /await compactLargeMemoryLayer\(scope, projectId, sessionId, sessionId, true\);/);
    assert.match(slice(M, "ipcMain.handle('acp:memory-compact-now'", 800), /compactLargeMemoryLayer\(scope, projectId, sid, sid, false\)/);
  });

  test('1200 字符以下的旧路径不变：超过上限照旧跳过', () => {
    const fn = slice(M, 'async function maybeConsolidateSessionMemory(', 2000);
    assert.match(fn, /autoConsolidationSkipReason\(existing\)/);
  });

  test('撤销 / 看差异只认备份路径（memoryFileForBackup）', () => {
    assert.match(slice(M, "ipcMain.handle('acp:memory-compact-undo'", 500), /memoryFileForBackup\(backupPath, MEMORY_ROOT\)/);
    assert.match(slice(M, "ipcMain.handle('acp:memory-compact-diff'", 500), /memoryFileForBackup\(backupPath, MEMORY_ROOT\)/);
  });
});

describe('界面接线', () => {
  test('「已整理记忆」提示下面挂查看差异 / 撤销', () => {
    const C = src('renderer', 'components', 'ChatArea.tsx');
    assert.match(C, /parseMemoryCompactGroup\(group\.message\.noteGroup\)[\s\S]{0,200}<MemoryCompactActions backupPath=/);
    const A = src('renderer', 'components', 'MemoryCompactActions.tsx');
    assert.match(A, /t\('View diff'\)/);
    assert.match(A, /t\('Undo'\)/);
    assert.match(A, /memoryCompactDiff\?\.\(backupPath\)/);
    assert.match(A, /memoryCompactUndo\?\.\(backupPath\)/);
  });

  test('立即整理期间这一层不能编辑 / 保存；结果回来时编辑框已不是开始时的内容就不覆盖', () => {
    const D = src('renderer', 'components', 'MemoryDialog.tsx');
    assert.match(D, /value=\{text\[tab\]\}[\s\S]{0,200}readOnly=\{compacting === tab\}/);
    assert.match(D, /disabled=\{compacting === tab\} onClick=\{\(\) => save\(tab\)\}/);
    const fn = slice(D, 'const compactNow = async', 1500);
    assert.match(fn, /const started = text\[scope\];/);
    assert.match(fn, /setText\(\(prev\) => \(prev\[scope\] === started \? \{ \.\.\.prev, \[scope\]: m\[scope\] \} : prev\)\)/);
    assert.ok(fn.indexOf('const started') < fn.indexOf('compactMemoryNow'), '开始时的内容要在调用之前记下');
  });

  test('手动整理没整理成：按状态给界面文案，不把主进程的英文原因直接拼进去', () => {
    const D = src('renderer', 'components', 'MemoryDialog.tsx');
    assert.match(D, /t\('Not compacted: \{why\}', \{ why: compactFailText\(r\?\.status, r\?\.error\) \}\)/);
    assert.doesNotMatch(D, /why: r\?\.error \|\|/);
    const fn = slice(D, 'const compactFailText', 1500);
    for (const s of ["'unchanged'", "'busy'", "'rejected'", "'skipped'", "'refused'"]) assert.ok(fn.includes(`status === ${s}`), s);
    for (const reason of ["'memory is empty'", "'backup failed'"]) assert.ok(fn.includes(reason), reason);
  });

  test('记忆对话框有「立即整理」，设置里有开关', () => {
    assert.match(src('renderer', 'components', 'MemoryDialog.tsx'), /compactMemoryNow\?\.\(scope, projectId, sessionId\)/);
    assert.match(src('renderer', 'components', 'SettingsDialog.tsx'), /key: 'largeMemoryCompact', store: 'feature'/);
    assert.match(src('main', 'preload.ts'), /compactMemoryNow:[\s\S]*memoryCompactDiff:[\s\S]*memoryCompactUndo:/);
  });
});
