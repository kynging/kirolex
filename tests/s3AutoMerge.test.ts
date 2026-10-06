import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { conflictPrefixFor } from '../src/main/s3Sync.ts';

/*
  「这个不对，很显然应该自动合并」—— 原来冲突时本机这份只往 conflicts/ 旁路传，界面上又没地方处理，
  于是每一轮报同一句"被别的机器更新过"，永远不收敛。
*/
const M = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');

test('冲突先自动合并；只有正在跑的、合并出错的才走旁路', () => {
  const at = M.indexOf('const conflicts = detectConflicts(');
  const body = M.slice(at, at + 3200);
  assert.match(body, /if \(live\?\.busy\) \{ conflictIds\.add\(c\.id\); continue; \}/);
  assert.match(body, /await mergeBucketSession\(creds!, cfg\.prefix, c\.id\)/);
  assert.match(body, /catch \(err: any\) \{\s*conflictIds\.add\(c\.id\)/);
  /* 合并完要重新传、catalog 按合并后的记录 —— 不然下一轮又判冲突 */
  assert.match(body, /freshEntries = catalogEntriesFor\(/);
  assert.match(body, /session:history-changed/);
});

test('合并用的是恢复那套函数，而且合并后 updatedAt 取较大者', () => {
  const at = M.indexOf('async function mergeBucketSession(');
  const body = M.slice(at, M.indexOf('\n}\n', at));
  assert.match(body, /mergeTranscripts\(mine, rt\.toString/);
  assert.match(body, /mergeRecords\(mine, theirs\)/);
  assert.match(body, /merged\.updatedAt = Math\.max\(/);
  /* 动之前备份 */
  assert.match(body, /before-merge-/);
});

test('以本机为准：先删桶里这条（含 conflicts/），再传，catalog 换成本机', () => {
  const at = M.indexOf('async function keepLocalSession(');
  const body = M.slice(at, M.indexOf('\n}\n', at));
  assert.ok(body.indexOf('deleteObject') < body.indexOf('putObject(creds, keyFor'), '先删后传');
  assert.match(body, /conflictPrefixFor\(prefix, sessionId\)/);
  assert.match(body, /filter\(\(e\) => e\.id !== sessionId\)/);
  assert.equal(conflictPrefixFor('', 's_1'), 'v1/conflicts/s_1/');
});

test('界面在合并后扔掉缓存重读', () => {
  const H = fs.readFileSync(new URL('../src/renderer/hooks/useAcp.ts', import.meta.url), 'utf8');
  assert.match(H, /onSessionHistoryChanged\?\.\(/);
  assert.match(H, /messagesCacheRef\.current\.delete\(d\.sessionId\)/);
  assert.match(H, /switchSessionRef\.current = switchSession;/);
});

test('从桶里拉的文件只许落在本会话 files/ 或 memory/ 下（key 是远端数据）', () => {
  assert.match(M, /function containedPath\(base: string, rel: string\)/);
  assert.match(M, /abs\.startsWith\(root \+ path\.sep\)/);
  const at = M.indexOf('async function mergeBucketSession(');
  const body = M.slice(at, M.indexOf('\n}\n', at));
  assert.match(body, /if \(!o\.key\.startsWith\(fpfx\)\) continue;/);
  assert.match(body, /containedPath\(filesRoot,/);
  assert.match(M, /containedPath\(memRoot, path\.relative\('memory', rel\)\)/);
});
