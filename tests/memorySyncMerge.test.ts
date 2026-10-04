import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { decideMemory, projectMemoryMarkKey } from '../src/main/s3Sync.ts';

/*
  **记忆：谁新用谁，本机第一次先拉** ——「记忆不必合并，只要自己的是最新的就可以上传。
  第一次同步的时候确保先拉而不是传空的就行」。
  实测撞过：Windows 新装，记忆是刚建的空壳（mtime = 现在），一同步就把桶里 22 KB 的 Dev 记忆盖成 23 字节。
*/
const M = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
const T0 = 1_700_000_000_000;

test('本机第一次同步：桶里有就拉 —— 哪怕本机的 mtime 更新（那正是空壳的样子）', () => {
  const shell = { size: 23, mtimeMs: T0 + 9_999_999 };      // 新装，刚建出来
  const real = { size: 22042, at: T0 };
  assert.equal(decideMemory(shell, real, undefined), 'pull');
  /* 桶里没有才传 */
  assert.equal(decideMemory(shell, undefined, undefined), 'upload');
});

test('只有本机动过 → 传；只有桶里动过 → 拉；都没动 → 不动', () => {
  const last = { size: 100, mtimeMs: T0, remoteAt: T0 + 5, remoteSize: 100 };
  assert.equal(decideMemory({ size: 120, mtimeMs: T0 + 60_000 }, { size: 100, at: T0 + 5 }, last), 'upload');
  assert.equal(decideMemory({ size: 100, mtimeMs: T0 }, { size: 130, at: T0 + 90_000 }, last), 'pull');
  assert.equal(decideMemory({ size: 100, mtimeMs: T0 }, { size: 100, at: T0 + 5 }, last), 'none');
});

test('两边都动过 → 时间新的那边赢', () => {
  const last = { size: 100, mtimeMs: T0, remoteAt: T0 + 5, remoteSize: 100 };
  assert.equal(decideMemory({ size: 110, mtimeMs: T0 + 200_000 }, { size: 130, at: T0 + 100_000 }, last), 'upload');
  assert.equal(decideMemory({ size: 110, mtimeMs: T0 + 100_000 }, { size: 130, at: T0 + 200_000 }, last), 'pull');
});

test('刚传完还没读到服务器时间时按大小判 —— 不拿本机时钟比服务器时钟', () => {
  /* remoteAt=0：上一轮刚传。桶里那份 LastModified 必然比本机 mtime 晚，按时间比会把自己刚传的当成别人改的 */
  const justUploaded = { size: 100, mtimeMs: T0, remoteAt: 0, remoteSize: 100 };
  assert.equal(decideMemory({ size: 100, mtimeMs: T0 }, { size: 100, at: T0 + 3_000 }, justUploaded), 'none');
  /* 大小变了才算别人改过 */
  assert.equal(decideMemory({ size: 100, mtimeMs: T0 }, { size: 140, at: T0 + 3_000 }, justUploaded), 'pull');
});

test('接线：不再合并；读不到桶里列表就一份记忆都不传', () => {
  assert.equal(/mergeMemoryText\(localText/.test(M), false, '同步路径上不该再有合并');
  assert.match(M, /const action = decideMemory\(local, remote, state\[rel\]\);/);
  assert.match(M, /if \(memListed\) \{/);
  assert.match(M, /\.\.\.plan\.upload\.filter\(\(r\) => !isMemoryRel\(r\)\),\s*\.\.\.memUpload,/);
  /* 拉之前把被换掉的那份挪进 trash */
  assert.match(M, /memory-pull-\$\{Date\.now\(\)\}/);
});

test('项目记忆的 mark 键不会和会话 id 撞；两页都显示记忆状态', () => {
  assert.equal(projectMemoryMarkKey('Dev'), 'memory:projects/Dev');
  const UI = fs.readFileSync(new URL('../src/renderer/components/BackupDialog.tsx', import.meta.url), 'utf8');
  assert.match(UI, /记忆 \{memSize\(p\.memory\.bytes\)\}/);
  assert.match(UI, /bucketMemory\[proj\]/);
});
