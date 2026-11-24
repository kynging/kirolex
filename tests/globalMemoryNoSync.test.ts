import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planUpload, memoryRelsFor, isGlobalMemoryRel, memorySyncInScope } from '../src/main/s3Sync.ts';

/** 「全局记忆不应该同步」（2026-11-24）：每台电脑各用各的 ~/.kirolex/memory/global.md */
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kxgmem-'));
  const put = (rel: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'x');
  };
  put('sessions/s_1/record.json');
  put('memory/global.md');
  put('memory/projects/P/memory.md');
  put('memory/sessions/s_1/memory.md');
  return root;
}

describe('全局记忆不同步', () => {
  test('isGlobalMemoryRel：/ 和 \\ 都认，别的不认', () => {
    for (const r of ['memory/global.md', 'memory\\global.md', path.join('memory', 'global.md'), './memory/global.md']) {
      assert.equal(isGlobalMemoryRel(r), true, r);
    }
    for (const r of ['memory/global.md.bak', 'memory/projects/global.md', 'memory/sessions/s/global.md', 'global.md', 'xmemory/global.md', '', 'memory/global.MD.tmp']) {
      assert.equal(isGlobalMemoryRel(r), false, r);
    }
  });

  test('memoryRelsFor 不再带 global.md', () => {
    const root = fixture();
    assert.deepEqual(memoryRelsFor(root, ['s_1'], ['P']).sort(), [
      path.join('memory', 'projects', 'P', 'memory.md'),
      path.join('memory', 'sessions', 's_1', 'memory.md'),
    ].sort());
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('planUpload 带 / 不带 memory 参数都不传 global.md，项目 / 会话记忆照传', () => {
    const root = fixture();
    for (const memory of [undefined, { projects: ['P'] }]) {
      const up = planUpload(root, ['s_1'], {}, memory).upload;
      assert.ok(!up.some(isGlobalMemoryRel), `不该传 global.md：${up}`);
      assert.ok(up.includes(path.join('memory', 'projects', 'P', 'memory.md')));
      assert.ok(up.includes(path.join('memory', 'sessions', 's_1', 'memory.md')));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('拉取 / 三方合并的范围：global.md 不在，项目 / 会话记忆仍在', () => {
    const o = { projectSynced: (p: string) => p === 'P', sessionIds: ['s_1'] };
    assert.equal(memorySyncInScope(path.join('memory', 'global.md'), o), false);
    assert.equal(memorySyncInScope('memory\\global.md', o), false);
    assert.equal(memorySyncInScope(path.join('memory', 'projects', 'P', 'memory.md'), o), true);
    assert.equal(memorySyncInScope(path.join('memory', 'projects', 'Q', 'memory.md'), o), false);
    assert.equal(memorySyncInScope(path.join('memory', 'sessions', 's_1', 'memory.md'), o), true);
    assert.equal(memorySyncInScope(path.join('memory', 'sessions', 's_2', 'memory.md'), o), false);
    assert.equal(memorySyncInScope(path.join('memory', 'other.md'), o), true, '顶层别的 .md 照旧');
    assert.equal(memorySyncInScope(path.join('memory', 'x', 'y.md'), o), false);
    assert.equal(memorySyncInScope(path.join('memory', 'projects', 'P', 'x.bak'), o), false);
  });

  test('接线：定期同步用 memorySyncInScope；s3:restore 的 memPrefixes 不含 global.md；启动后第一次同步记一行', () => {
    const M = fs.readFileSync('src/main/index.ts', 'utf8');
    assert.match(M, /memorySyncInScope\(rel, \{/);
    const at = M.indexOf('const memPrefixes = [');
    assert.ok(at > 0);
    const block = M.slice(at, M.indexOf('];', at));
    assert.ok(!/global/.test(block), block);
    assert.ok(block.includes("'sessions', sessionId"));
    assert.ok(block.includes("'projects', project"));
    assert.match(M, /全局记忆不再同步（本机各自一份）/);
  });
});
