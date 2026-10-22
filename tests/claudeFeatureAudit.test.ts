/**
 * Claude Code 功能逐项实测审计（docs/claude-code-feature-audit.md）里直接修的两条渲染层问题：
 *   F3 分叉 / 复制一条 Claude Code 会话，新会话悄悄建成了 Kiro 会话；
 *   F4 Claude Code / Codex 会话的用量栏永远显示「0.00 credits」（那是 kiro 的计费口径）。
 * 两处都在 .tsx / 大 hook 里，没法直接 import，用源码扫描钉住接线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');

test('F3 分叉 / 复制：引擎跟着源会话（首条消息建后端时读 intendedEngineRef）', () => {
  const A = read('renderer', 'hooks', 'useAcp.ts');
  const d = A.slice(A.indexOf('const duplicateSession = useCallback('), A.indexOf('/** The live view for a chat that is on screen but has no PaneView entry YET.'));
  assert.ok(d.length > 0);
  assert.match(d, /if \(src\.engine && src\.engine !== 'kiro'\) intendedEngineRef\.current\.set\(newId, src\.engine\);/);
  assert.match(d, /\.\.\.\(src\.engine && src\.engine !== 'kiro' \? \{ engine: src\.engine \} : null\)/, '侧栏行上的引擎徽标也要当场对');
  /* 首条消息那条路确实读的是这张表 */
  assert.match(A, /\(pendingId && intendedEngineRef\.current\.get\(pendingId\)\) \|\| undefined,/);
});

test('F4 Credits 计数只给 kiro 会话显示', () => {
  const C = read('renderer', 'components', 'ChatArea.tsx');
  const i = C.indexOf('className="composer-credits composer-usage-action"');
  assert.ok(i > 0);
  const before = C.slice(Math.max(0, i - 400), i);
  assert.match(before, /\{!nonKiro && \(/);
  assert.match(C, /const nonKiro = !!engine && engine !== 'kiro';/);
});
