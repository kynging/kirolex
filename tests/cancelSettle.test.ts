/**
 * 审计 3d / 3c（docs/claude-code-feature-audit.md）。
 *
 * 3d 实测：停止一轮时 Claude Code 只回 `stopReason: cancelled`，被打断的 Bash / Task 不再发最终状态，停在 `pending`；
 *    「运行的命令」面板把不是 completed / failed 的都当运行中 → 这一条永远显示「运行中」，落盘的记录里也是。
 *    现在非 kiro 的一轮以 cancelled 结束时，在落盘之前把还开着的调用收成 failed，并推一条 tool_call_update 给界面。kiro 不动。
 * 3c：失败命令的「失败」标记用的是 stat-del，但红色规则只匹配文件面板 —— Claude / Codex 会话里补上红色，kiro 不动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { settleCancelledToolCalls } from '../src/main/cancelSettle.ts';

const calls = [
  { toolCallId: 'a', title: 'echo hi', status: 'completed' as const },
  { toolCallId: 'b', title: 'sleep 40', status: 'pending' as const },
  { toolCallId: 'c', title: 'Task', status: 'in_progress' as const },
  { toolCallId: 'd', title: 'bad', status: 'failed' as const },
  { toolCallId: 'e', title: 'no status' },
];

test('Claude / Codex 一轮被取消：还开着的调用收成 failed，已结束的不动', () => {
  for (const engine of ['claude', 'codex'] as const) {
    const r = settleCancelledToolCalls(engine, 'cancelled', calls);
    assert.deepEqual(r.settled, ['b', 'c', 'e']);
    assert.deepEqual(r.calls.map((c) => c.status), ['completed', 'failed', 'failed', 'failed', 'failed']);
    assert.equal(r.calls[1].title, 'sleep 40', '别的字段原样');
    assert.equal(calls[1].status, 'pending', '不改传进来的数组');
  }
});

test('kiro 照旧：一个都不收', () => {
  const r = settleCancelledToolCalls('kiro', 'cancelled', calls);
  assert.deepEqual(r.settled, []);
  assert.equal(r.calls, calls);
});

test('不是取消结束的一轮（end_turn 等）：不动', () => {
  for (const stop of ['end_turn', 'max_tokens', undefined, '']) {
    const r = settleCancelledToolCalls('claude', stop, calls);
    assert.deepEqual(r.settled, []);
    assert.equal(r.calls, calls);
  }
});

const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

test('接线：一轮结束落盘之前收尾，并推 tool_call_update 给界面', () => {
  const flushAt = M.indexOf('flushAssistant(sessionId); // turn complete -> persist the full assistant msg');
  assert.ok(flushAt > 0);
  const from = M.lastIndexOf('const producedOutput = !!(entry.assistantBuf || entry.fileChanges.length);', flushAt);
  assert.ok(from > 0 && flushAt - from < 4000, '同一段收尾里');
  const before = M.slice(from, flushAt);
  assert.match(before, /settleCancelledToolCalls\(engineOf\(entry\.profile\), result\?\.stopReason, entry\.fileChanges\)/);
  assert.match(before, /entry\.fileChanges = settled\.calls;/);
  assert.match(before, /sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed'/);
});

test('3c：失败标记的红色只给 Claude / Codex 会话（chat-main 带 data-engine，kiro 不带）', () => {
  const C = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf8');
  assert.match(C, /className=\{`chat-main [^`]*`\}\s*\n[^\n]*\n\s*data-engine=\{nonKiro \? engine : undefined\}/);
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'styles', 'global.css'), 'utf8');
  assert.match(css, /\.chat-main\[data-engine\] \.files-item-row > \.stat-del \{ color: #e5534b; \}/);
  /* 文件面板原来那条规则不动 */
  assert.match(css, /\.files-item-stat \.stat-del \{ color: #e5534b; \}/);
});
