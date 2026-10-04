import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { mergeMemoryText, projectMemoryMarkKey } from '../src/main/s3Sync.ts';

/*
  **记忆上传前先合并桶里那份** —— 实测：Windows 首次同步把 Mac 上 22 KB 的 Dev 记忆、5 KB 的 Blog
  记忆在桶里盖成了 23/24 字节的空壳。会话有冲突检测，记忆没有，上传是"谁最后传谁赢"。
*/
const M = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');

test('空壳 + 真内容 → 真内容一行不少', () => {
  const shell = '# Project memory\n';
  const real = '# Project memory\n\n- 用 brazil-build\n- 别动 prod\n';
  const merged = mergeMemoryText(shell, real);
  assert.ok(merged.includes('用 brazil-build') && merged.includes('别动 prod'));
  /* 反过来（本地是真内容）也不丢 */
  assert.equal(mergeMemoryText(real, shell), real);
});

test('上传循环：记忆先读桶里那份、合并、写回本地，再传', () => {
  const at = M.indexOf('for (const rel of plan.upload)');
  const body = M.slice(at, at + 4000);
  const get = body.indexOf('getObjectIfExists(creds!, key)');
  const merge = body.indexOf('mergeMemoryText(localText');
  const put = body.indexOf('await putObject(creds!, key, body');
  assert.ok(get > 0 && merge > get && put > merge, '顺序必须是 读桶 → 合并 → 传');
  assert.match(body, /fs\.renameSync\(tmp, abs\)/, '合并结果要写回本地（原子写）');
  /* 读不到桶里那份就跳过这一个 —— 盖掉一份读不到的记忆正是要防的事 */
  assert.match(body.slice(merge, put), /continue;/);
});

test('项目记忆的 mark 键不会和会话 id 撞', () => {
  assert.equal(projectMemoryMarkKey('Dev'), 'memory:projects/Dev');
  assert.equal(projectMemoryMarkKey('Dev').startsWith('s_'), false);
});

test('两页都显示项目记忆的状态', () => {
  const UI = fs.readFileSync(new URL('../src/renderer/components/BackupDialog.tsx', import.meta.url), 'utf8');
  assert.match(UI, /记忆 \{memSize\(p\.memory\.bytes\)\}/, '同步页');
  assert.match(UI, /bucketMemory\[proj\]/, '恢复页');
  /* 空壳要一眼看得出来 —— kb() 会把 23 B 写成 1 KB */
  assert.match(UI, /EMPTY_MEMORY_BYTES/);
  assert.match(M, /memory: memoryOf\(v\.project\)/);
  assert.match(M, /memoryByProject,/);
});
