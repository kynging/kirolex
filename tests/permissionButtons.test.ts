/**
 * 权限条上的按钮（`PermissionBar.tsx` → `permissionButtons.ts`）。
 *
 * 实测（scripts/claude-feature-probe.mjs 的 plan 步骤）：Claude Code 批准计划（ExitPlanMode）给的是五个选项，
 * 其中三个都是 allow_always。原来按「每种 kind 取第一个」只画三个通用按钮，于是「⟲ 总是允许」点下去是
 * `exit-plan-clear-bypass` ——「清空上下文并跳过所有权限」，另外两个选项根本看不到。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { permissionButtons } from '../src/renderer/permissionButtons.ts';

const exitPlan = [
  { optionId: 'exit-plan-default', name: 'Yes, manually approve edits', kind: 'allow_once' },
  { optionId: 'exit-plan-clear-bypass', name: 'Yes, clear context (4% used) and bypass permissions', kind: 'allow_always' },
  { optionId: 'exit-plan-bypass', name: 'Yes, and bypass permissions', kind: 'allow_always' },
  { optionId: 'exit-plan-auto', name: 'Yes, and use auto mode', kind: 'allow_always' },
  { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' },
];

test('同一种 kind 有好几个选项（批准计划）：每个选项一个按钮，用它自己的名字，顺序不变', () => {
  const b = permissionButtons(exitPlan);
  assert.deepEqual(b.map((x) => x.optionId), exitPlan.map((o) => o.optionId));
  assert.deepEqual(b.map((x) => x.label), exitPlan.map((o) => o.name));
  assert.deepEqual(b.map((x) => x.role), ['allow_once', 'allow_always', 'allow_always', 'allow_always', 'reject']);
});

test('普通的三选一（kiro、Claude 的 Bash / WebFetch）：照旧三个通用按钮，不带名字', () => {
  const b = permissionButtons([
    { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
    { optionId: 'allow-with-updates', name: "Yes, and don't ask again for example.com", kind: 'allow_always' },
    { optionId: 'reject', name: 'No', kind: 'reject_once' },
  ]);
  assert.deepEqual(b, [
    { optionId: 'allow-once', role: 'allow_once' },
    { optionId: 'allow-with-updates', role: 'allow_always' },
    { optionId: 'reject', role: 'reject' },
  ]);
});

test('通用按钮的挑法和原来一样：拒绝优先 reject_once，其次 reject_always', () => {
  const b = permissionButtons([
    { optionId: 'ra', kind: 'reject_always' },
    { optionId: 'ao', kind: 'allow_once' },
  ]);
  assert.deepEqual(b, [{ optionId: 'ao', role: 'allow_once' }, { optionId: 'ra', role: 'reject' }]);
  assert.deepEqual(permissionButtons([]), []);
});

test('PermissionBar 用的是 permissionButtons，有名字时显示名字', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'PermissionBar.tsx'), 'utf8');
  assert.match(src, /permissionButtons\(request\.options\)/);
  assert.match(src, /b\.label \|\|/);
  /* 逐个列出时按钮区可换行，不然五个长名字会被挤出格子 */
  assert.match(src, /buttons\.some\(\(b\) => b\.label\) \? ' named' : ''/);
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'styles', 'global.css'), 'utf8');
  assert.match(css, /\.permission-bar-actions\.named \{[^}]*flex: 1 1 100%;/);
});
