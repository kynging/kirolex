import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { decideMemory, projectMemoryMarkKey, memorySyncStep, reconcileMemoryText } from '../src/main/s3Sync.ts';

/*
  **记忆：谁新用谁，本机第一次先拉** ——「记忆不必合并，只要自己的是最新的就可以上传。
  第一次同步的时候确保先拉而不是传空的就行」。
  实测撞过：Windows 新装，记忆是刚建的空壳（mtime = 现在），一同步就把桶里 22 KB 的 Dev 记忆盖成 23 字节。
  后来又撞过反方向的（见下面「合并」几条）：两边都有内容时整份拉会盖掉本机独有的 —— 那种情况改成合并。
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

/*
  **两边都有内容且不一样 → 合并，不覆盖**。实测撞过：kyn-desktop 把 Dev 从不同步的项目里拿出来后第一轮，
  「本机第一次同步就拉」把本机 32855 B 的会话记忆盖成了桶里 11921 B 的那份 —— 两台各自记过东西，本机独有的全没了。
*/
test('真实决策：两边都有这份就先要内容 —— 第一次同步、只有一边动过、两边都动过都一样', () => {
  const last = { size: 100, mtimeMs: T0, remoteAt: T0 + 5, remoteSize: 100 };
  const fetch = { kind: 'fetch' };
  /* 第一次同步（state 里没这条） */
  assert.deepEqual(memorySyncStep({ size: 32855, mtimeMs: T0 }, { size: 11921, at: T0 }, undefined), fetch);
  assert.deepEqual(memorySyncStep({ size: 0, mtimeMs: T0 }, { size: 11921, at: T0 }, undefined), fetch);
  /* 非第一次：两边都动过 / 只有本机动过 / 只有桶里动过 */
  assert.deepEqual(memorySyncStep({ size: 110, mtimeMs: T0 + 200_000 }, { size: 130, at: T0 + 100_000 }, last), fetch);
  assert.deepEqual(memorySyncStep({ size: 120, mtimeMs: T0 + 60_000 }, { size: 100, at: T0 + 5 }, last), fetch);
  assert.deepEqual(memorySyncStep({ size: 100, mtimeMs: T0 }, { size: 130, at: T0 + 90_000 }, last), fetch);
  /* 都没动 → 不用拿；只有一边有文件 → 直接拉 / 直接传 */
  assert.deepEqual(memorySyncStep({ size: 100, mtimeMs: T0 }, { size: 100, at: T0 + 5 }, last), { kind: 'none' });
  assert.deepEqual(memorySyncStep(undefined, { size: 11921, at: T0 }, undefined), { kind: 'pull' });
  assert.deepEqual(memorySyncStep(undefined, { size: 130, at: T0 + 90_000 }, last), { kind: 'pull' });
  assert.deepEqual(memorySyncStep({ size: 100, mtimeMs: T0 }, undefined, undefined), { kind: 'upload' });
  assert.deepEqual(memorySyncStep({ size: 120, mtimeMs: T0 + 60_000 }, undefined, last), { kind: 'upload' });
});

test('真实决策：两边各有独有条目 → 合并（第一次同步和非第一次同步、哪边动过都一样）', () => {
  const last = { size: 100, mtimeMs: T0, remoteAt: T0 + 5, remoteSize: 100 };
  const texts = { local: '- 本机 A\n- 共有 B\n- 本机 C\n', remote: '- 共有 B\n- 桶里 D\n' };
  const merged = { kind: 'merge', text: '- 本机 A\n- 共有 B\n- 本机 C\n- 桶里 D\n', extraLines: 1 };
  assert.deepEqual(memorySyncStep({ size: 32855, mtimeMs: T0 }, { size: 11921, at: T0 }, undefined, texts), merged);
  assert.deepEqual(memorySyncStep({ size: 110, mtimeMs: T0 + 200_000 }, { size: 130, at: T0 + 100_000 }, last, texts), merged);
  assert.deepEqual(memorySyncStep({ size: 110, mtimeMs: T0 + 100_000 }, { size: 130, at: T0 + 200_000 }, last, texts), merged);
  assert.deepEqual(memorySyncStep({ size: 120, mtimeMs: T0 + 60_000 }, { size: 100, at: T0 + 5 }, last, texts), merged, '只有本机动过');
  assert.deepEqual(memorySyncStep({ size: 100, mtimeMs: T0 }, { size: 130, at: T0 + 90_000 }, last, texts), merged, '只有桶里动过');
  /* 桶里没有本机缺的 → 传；一模一样 → 只记状态 */
  assert.deepEqual(memorySyncStep({ size: 120, mtimeMs: T0 + 60_000 }, { size: 100, at: T0 + 5 }, last, { local: '- a\n- b\n', remote: '- b\n' }), { kind: 'upload' });
  assert.deepEqual(memorySyncStep({ size: 32855, mtimeMs: T0 }, { size: 11921, at: T0 }, undefined, { local: '- a\n', remote: '- a\n' }), { kind: 'same' });
});

test('真实决策：一边是空的 → 缺的那边直接拿，不会把有内容的那边盖成空', () => {
  const last = { size: 100, mtimeMs: T0, remoteAt: T0 + 5, remoteSize: 100 };
  /* 已有 state：本机变成 0 字节、桶里没动 —— decideMemory 会说传，但不能把桶里的盖成空 → 拉 */
  assert.equal(decideMemory({ size: 0, mtimeMs: T0 + 60_000 }, { size: 100, at: T0 + 5 }, last), 'upload');
  assert.deepEqual(memorySyncStep({ size: 0, mtimeMs: T0 + 60_000 }, { size: 100, at: T0 + 5 }, last, { local: '', remote: '- 桶里\n' }), { kind: 'pull' });
  /* 已有 state：桶里变成 0 字节、本机没动 —— decideMemory 会说拉，但不能把本机的盖成空 → 传 */
  assert.equal(decideMemory({ size: 100, mtimeMs: T0 }, { size: 0, at: T0 + 90_000 }, last), 'pull');
  assert.deepEqual(memorySyncStep({ size: 100, mtimeMs: T0 }, { size: 0, at: T0 + 90_000 }, last, { local: '- 本机\n', remote: '' }), { kind: 'upload' });
  /* 第一次同步：本机空 → 拉；桶里空 → 传 */
  assert.deepEqual(memorySyncStep({ size: 23, mtimeMs: T0 + 9_999_999 }, { size: 22042, at: T0 }, undefined, { local: ' \n', remote: '- 真记忆\n' }), { kind: 'pull' });
  assert.deepEqual(memorySyncStep({ size: 100, mtimeMs: T0 }, { size: 0, at: T0 }, undefined, { local: '- 本机\n', remote: '' }), { kind: 'upload' });
});

test('合并：本机 3 条、桶里 2 条其中 1 条重复 → 4 条，本机原有的一条不少', () => {
  const local = '- 本机 A\n- 共有 B\n- 本机 C\n';
  const remote = '- 共有 B\n- 桶里 D\n';
  const r = reconcileMemoryText(local, remote);
  assert.equal(r.use, 'merged');
  assert.equal(r.extraLines, 1);
  assert.equal(r.text, '- 本机 A\n- 共有 B\n- 本机 C\n- 桶里 D\n');
  const lines = r.text.split('\n').filter(Boolean);
  assert.equal(lines.length, 4);
  for (const l of local.split('\n').filter(Boolean)) assert.ok(lines.includes(l), `本机的「${l}」不能少`);
  /* 合并结果再和桶里那份比：没有新东西了 → 用本机的（只需上传） */
  assert.deepEqual(reconcileMemoryText(r.text, remote), { use: 'local', text: r.text, extraLines: 0 });
});

test('合并：本机空 → 直接拉；桶里空 → 直接传；桶里没有独有行 → 用本机', () => {
  assert.deepEqual(reconcileMemoryText('  \n', '- 桶里\n'), { use: 'remote', text: '- 桶里\n', extraLines: 0 });
  assert.deepEqual(reconcileMemoryText('- 本机\n', ''), { use: 'local', text: '- 本机\n', extraLines: 0 });
  assert.deepEqual(reconcileMemoryText('- 本机\n', '\n \n'), { use: 'local', text: '- 本机\n', extraLines: 0 });
  assert.deepEqual(reconcileMemoryText('- a\n- b\n', '- b\n'), { use: 'local', text: '- a\n- b\n', extraLines: 0 });
});

test('接线：两边都有内容时先合并再传；读不到桶里列表就一份记忆都不传', () => {
  assert.match(M, /let step = memorySyncStep\(local, remote, state\[rel\]\);/);
  assert.match(M, /step = memorySyncStep\(local, remote, state\[rel\], \{ local: fs\.readFileSync\(abs, 'utf-8'\), remote: buf\.toString\('utf-8'\) \}\);/);
  assert.match(M, /合并：本机 \$\{local!?\.size\} B \+ 桶里独有 \$\{step\.extraLines\} 行 → \$\{Buffer\.byteLength\(step\.text\)\} B/);
  assert.match(M, /if \(memListed\) \{/);
  assert.match(M, /\.\.\.plan\.upload\.filter\(\(r\) => !isMemoryRel\(r\)\),\s*\.\.\.memUpload,/);
  /* 拉 / 合并写回之前把被换掉的那份挪进 trash（两条路走同一个写回函数） */
  assert.match(M, /memory-pull-\$\{Date\.now\(\)\}/);
  assert.match(M, /const replaceLocalMemory = /);
});

test('项目记忆的 mark 键不会和会话 id 撞；两页都显示记忆状态', () => {
  assert.equal(projectMemoryMarkKey('Dev'), 'memory:projects/Dev');
  const UI = fs.readFileSync(new URL('../src/renderer/components/BackupDialog.tsx', import.meta.url), 'utf8');
  assert.match(UI, /\{t\('Memory \{size\}', \{ size: memSize\(p\.memory\.bytes\) \}\)\}/);
  assert.match(UI, /bucketMemory\[proj\]/);
});
