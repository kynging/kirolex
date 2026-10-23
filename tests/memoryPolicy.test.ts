import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MEMORY_WARN_BYTES,
  memoryWarnings,
  formatMemoryBytes,
  compactMemoryPrompt,
} from '../src/main/memoryPolicy.ts';

const none = { global: 0, project: 0, session: 0 };

describe('三层各有自己的阈值，因为每字节的代价不同', () => {
  test('全局层的阈值最低 —— 它注入进每一个会话，同样一个字节被付的次数最多', () => {
    assert.ok(MEMORY_WARN_BYTES.global < MEMORY_WARN_BYTES.project);
  });

  test('数值：全局 1 KB、项目 16 KB、会话 32 KB（2026-10-23「会话记忆 10 KB 太小……设为 32 KB」「全局记忆的阈值……就 1KB」）', () => {
    assert.deepEqual(MEMORY_WARN_BYTES, { global: 1024, project: 16 * 1024, session: 32 * 1024 });
    /* 全局仍然是三层里最严的 —— 它注入进每一个会话 */
    assert.ok(MEMORY_WARN_BYTES.global < MEMORY_WARN_BYTES.session && MEMORY_WARN_BYTES.global < MEMORY_WARN_BYTES.project);
  });

  test('横幅上有「编辑」，直接打开那一层、那个窗格的会话', () => {
    const C = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
    const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
    const D = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/MemoryDialog.tsx'), 'utf8');
    assert.ok(C.includes("<button className=\"memory-warn-btn edit\" onClick={() => onOpenMemory(warning.scope as 'global' | 'project' | 'session')}"), '编辑用自己的颜色，不和查看一样');
    assert.ok(A.includes('setMemoryTarget(scope ? { sessionId: sid || undefined, projectId: session?.projectId, scope } : null);'));
    assert.ok(A.includes('initialTab={memoryTarget?.scope}'));
    assert.ok(D.includes("const defaultTab = (): Tab => initialTab || (projectId ? 'project' : 'global');"));
  });

  test('正好等于阈值不报警，超出一个字节才报警', () => {
    assert.equal(memoryWarnings({ bytes: { ...none, global: MEMORY_WARN_BYTES.global } }).length, 0);
    assert.equal(memoryWarnings({ bytes: { ...none, global: MEMORY_WARN_BYTES.global + 1 } }).length, 1);
  });

  test('会话层：32 KB 及以下不报（包括原来会报的 10–32 KB），超过 32 KB 才报', () => {
    const s = (session: number) => memoryWarnings({ sessionId: 's_1', bytes: { ...none, session } }).map((x) => x.scope);
    assert.deepEqual(s(10 * 1024 + 1), [], '原来的 10 KB 线不再报');
    assert.deepEqual(s(20 * 1024), []);
    assert.deepEqual(s(32 * 1024), [], '正好 32 KB 不报');
    assert.deepEqual(s(32 * 1024 + 1), ['session']);
  });

  test('全局 / 项目阈值不变：全局超 1 KB、项目超 16 KB 才报', () => {
    const w = (bytes: typeof none) => memoryWarnings({ projectId: 'Dev', sessionId: 's_1', bytes }).map((x) => x.scope);
    assert.deepEqual(w({ ...none, global: 1024 }), []);
    assert.deepEqual(w({ ...none, global: 1024 + 1 }), ['global']);
    assert.deepEqual(w({ ...none, project: 16 * 1024 }), []);
    assert.deepEqual(w({ ...none, project: 16 * 1024 + 1 }), ['project']);
  });
});

describe('哪些层会报警', () => {
  test('没有 projectId，项目层多大都不报 —— 这条会话根本没有那一层', () => {
    const w = memoryWarnings({ bytes: { ...none, project: 999_999 } });
    assert.equal(w.length, 0);
  });

  test('没有 sessionId，会话层不报', () => {
    const w = memoryWarnings({ bytes: { ...none, session: 999_999 } });
    assert.equal(w.length, 0);
  });

  test('全局层不需要任何 id —— 它总是存在', () => {
    const w = memoryWarnings({ bytes: { ...none, global: 999_999 } });
    assert.deepEqual(w.map((x) => x.scope), ['global']);
  });

  test('三层同时超标时，顺序是 global → project → session，和注入的级联同序', () => {
    const w = memoryWarnings({
      projectId: 'Dev',
      sessionId: 's_1',
      bytes: { global: 999_999, project: 999_999, session: 999_999 },
    });
    assert.deepEqual(w.map((x) => x.scope), ['global', 'project', 'session']);
  });

  test('项目层的标签用项目名，另外两层用固定文案', () => {
    const w = memoryWarnings({
      projectId: 'Dev',
      sessionId: 's_1',
      bytes: { global: 999_999, project: 999_999, session: 999_999 },
    });
    assert.ok(w[1].label.includes('Dev'));
    assert.ok(w[0].label.length > 0 && !w[0].label.includes('Dev'));
  });

  test('清理到阈值以下，那一层就从列表里消失 —— 横幅会自己不见的依据', () => {
    const before = memoryWarnings({ projectId: 'Dev', bytes: { ...none, project: 82_234 } });
    const after = memoryWarnings({ projectId: 'Dev', bytes: { ...none, project: 3_000 } });
    assert.equal(before.length, 1);
    assert.equal(after.length, 0);
  });
});

describe('体积的显示', () => {
  test('用 KB，不给小数 —— 横幅只需要量级', () => {
    assert.equal(formatMemoryBytes(19_612), '19 KB');
    assert.equal(formatMemoryBytes(16 * 1024), '16 KB');
  });

  test('不足 1 KB 显示字节，不显示 0 KB', () => {
    assert.equal(formatMemoryBytes(814), '814 B');
    assert.equal(formatMemoryBytes(0), '0 B');
  });
});

describe('压缩用的固定提示词', () => {
  const p = compactMemoryPrompt({
    scope: 'project',
    filePath: '/Users/x/.kirolex/memory/projects/Dev/memory.md',
    bytes: 19_612,
  });

  test('带上要改的绝对路径 —— 否则模型得先猜文件在哪', () => {
    assert.ok(p.includes('/Users/x/.kirolex/memory/projects/Dev/memory.md'));
  });

  test('说清是合并去重而不是删减 —— 压缩记忆最大的风险是丢事实', () => {
    assert.ok(p.includes('不要删除任何仍然成立的事实'));
  });

  test('点名要保留原文的东西：路径、ID、命令、数字', () => {
    for (const kw of ['路径', 'ID', '命令', '数字']) assert.ok(p.includes(kw), kw);
  });

  test('三层的提示词都能生成，且各自说明自己是哪一层', () => {
    for (const scope of ['global', 'project', 'session'] as const) {
      const text = compactMemoryPrompt({ scope, filePath: '/tmp/memory.md', bytes: 9000 });
      assert.ok(text.includes('/tmp/memory.md'), scope);
      assert.ok(text.includes('不要删除任何仍然成立的事实'), scope);
    }
  });

  test('全局层的提示词要说明它影响所有会话 —— 压它的风险比压一个项目大', () => {
    const text = compactMemoryPrompt({ scope: 'global', filePath: '/tmp/g.md', bytes: 9000 });
    assert.ok(text.includes('所有会话'));
  });

  test('没有未填的占位符', () => {
    assert.ok(!/<[a-z_]+>|\{\{|TBD|TODO/i.test(p), p);
  });
});
