/**
 * 审计 3a / 3b / 12（docs/claude-code-feature-audit.md）的数据映射与渲染判定。
 * 样本取自 scripts/claude-feature-probe.mjs 实测收到的帧（附录 A1–A10）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRecordToolCall, summarizeToolInput, toolTraceFields, toolTimes, mergeToolTrace } from '../src/main/toolTrace.ts';
import { toolRowsOf, mainlineCommands, nestedToolIds, toolDuration, toolResultSummary, childProgress, isSubagentCall, toolState } from '../src/renderer/toolRows.ts';
import { diffView, sumDiffStats } from '../src/renderer/diffView.ts';

describe('toolTraceFields：从真实帧里取工具名 / 入参摘要 / 父调用', () => {
  test('Grep（附录样本形状）', () => {
    const f = toolTraceFields({
      _meta: { claudeCode: { toolName: 'Grep' } },
      rawInput: { pattern: 'world', path: 'D:\\ab\\tmp\\x', output_mode: 'files_with_matches' },
    });
    assert.equal(f.toolName, 'Grep');
    assert.equal(f.input, 'path=D:\\ab\\tmp\\x pattern=world');
    assert.equal(f.parentToolCallId, undefined);
  });
  test('子代理里的 Bash：带 parentToolUseId', () => {
    const f = toolTraceFields({ _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: 'toolu_parent' } }, rawInput: { command: 'echo sub-hello', description: 'Print' } });
    assert.equal(f.parentToolCallId, 'toolu_parent');
    assert.match(f.input!, /^command="echo sub-hello" description=Print$/);
  });
  test('第一条 tool_call 的 rawInput 是 {}：不带 input；没 _meta 时退回 name 字段', () => {
    assert.deepEqual(toolTraceFields({ rawInput: {}, name: 'Bash' }), { toolName: 'Bash' });
    assert.deepEqual(toolTraceFields({}), {});
  });
  test('入参摘要：认不得的键整份 JSON 截短；长值截短', () => {
    assert.equal(summarizeToolInput({ foo: 1 }), '{"foo":1}');
    assert.equal(summarizeToolInput(undefined), undefined);
    assert.equal(summarizeToolInput({}), undefined);
    const long = summarizeToolInput({ prompt: 'x'.repeat(500) })!;
    assert.ok(long.length <= 200);
  });
  test('合并：update 只带变了的字段，没带的沿用', () => {
    assert.deepEqual(mergeToolTrace({ toolName: 'Read', input: 'a' }, { input: 'b' }), { toolName: 'Read', input: 'b' });
    assert.deepEqual(mergeToolTrace(undefined, {}), {});
  });
});

describe('shouldRecordToolCall：kiro 判据不变，Claude / Codex 每条都记', () => {
  test('kiro：只记动过文件 / 跑过东西 / 浏览器', () => {
    assert.equal(shouldRecordToolCall('kiro', { kind: 'read' }), false);
    assert.equal(shouldRecordToolCall('kiro', { kind: 'search' }), false);
    assert.equal(shouldRecordToolCall('kiro', { kind: 'read', locations: ['/x'] }), true);
    assert.equal(shouldRecordToolCall('kiro', { kind: 'execute' }), true);
    assert.equal(shouldRecordToolCall('kiro', { kind: 'browser' }), true);
    assert.equal(shouldRecordToolCall(undefined, { kind: 'fetch' }), false, '不知道引擎时按 kiro');
  });
  test('Claude Code / Codex：Grep / WebFetch / Task 也记', () => {
    for (const e of ['claude', 'codex'] as const) {
      for (const kind of ['search', 'fetch', 'think', 'other', undefined]) assert.equal(shouldRecordToolCall(e, { kind }), true);
    }
  });
  test('起止时间：第一次见到记开始，第一次结束记结束，之后不再改', () => {
    assert.deepEqual(toolTimes(undefined, 'pending', 100), { startedAt: 100 });
    assert.deepEqual(toolTimes({ startedAt: 100 }, 'completed', 350), { startedAt: 100, endedAt: 350 });
    assert.deepEqual(toolTimes({ startedAt: 100, endedAt: 350 }, 'completed', 999), { startedAt: 100, endedAt: 350 });
  });
});

describe('toolRowsOf：「用过的工具」那一块', () => {
  const calls = [
    { toolCallId: 'r', title: 'Read hello.txt', kind: 'read', toolName: 'Read', status: 'completed', locations: ['/h'] },
    { toolCallId: 'g', title: 'grep "world"', kind: 'search', toolName: 'Grep', status: 'completed' },
    { toolCallId: 'w', title: 'Write out.txt', kind: 'edit', toolName: 'Write', status: 'completed', diffs: [{}] },
    { toolCallId: 'b', title: 'echo hi', kind: 'execute', toolName: 'Bash', status: 'completed' },
    { toolCallId: 't', title: 'Run shell command', kind: 'think', toolName: 'Agent', status: 'completed', startedAt: 1000, endedAt: 4200 },
    { toolCallId: 'tb', title: 'echo sub-hello', kind: 'execute', toolName: 'Bash', status: 'completed', parentToolCallId: 't' },
    { toolCallId: 'tr', title: 'Read x', kind: 'read', toolName: 'Read', status: 'failed', parentToolCallId: 't' },
    { toolCallId: 'orphan', title: 'Glob', kind: 'search', toolName: 'Glob', status: 'completed', parentToolCallId: 'not-in-turn' },
  ];
  test('只读的进这一块；命令 / 改文件留在各自面板；Task 带着孩子', () => {
    const rows = toolRowsOf(calls);
    assert.deepEqual(rows.map((r) => r.call.toolCallId), ['r', 'g', 't', 'orphan']);
    assert.deepEqual(rows.find((r) => r.call.toolCallId === 't')!.children.map((c) => c.toolCallId), ['tb', 'tr']);
    assert.deepEqual(nestedToolIds(calls), new Set(['tb', 'tr']));
  });
  test('实测：Agent 那一条自己带着 parentToolUseId = 自己的 id —— 不能把它当成自己的孩子藏起来', () => {
    /* 截图那一轮落盘的样子（s_1792732848071_0kn1sw）：Agent 的 parent 是它自己，三个孩子指向它 */
    assert.deepEqual(toolTraceFields({ toolCallId: 'Gu8y', _meta: { claudeCode: { toolName: 'Agent', parentToolUseId: 'Gu8y' } } }), { toolName: 'Agent' });
    const rows = toolRowsOf([
      { toolCallId: 'Gu8y', title: 'Subagent test', kind: 'think', toolName: 'Agent', status: 'completed', parentToolCallId: 'Gu8y' },
      { toolCallId: 'PkFo', title: 'echo sub-hello', kind: 'execute', toolName: 'Bash', status: 'completed', parentToolCallId: 'Gu8y' },
      { toolCallId: 'w1Zh', title: 'Find `*.txt`', kind: 'search', toolName: 'Glob', status: 'completed', parentToolCallId: 'Gu8y' },
      { toolCallId: 'wGUK', title: 'Read missing2.txt', kind: 'read', toolName: 'Read', status: 'failed', parentToolCallId: 'Gu8y' },
    ]);
    assert.deepEqual(rows.map((r) => r.call.toolCallId), ['Gu8y']);
    assert.deepEqual(rows[0].children.map((c) => c.toolCallId), ['PkFo', 'w1Zh', 'wGUK']);
  });
  test('子代理跑的命令不混进主线的「运行的命令」', () => {
    assert.deepEqual(mainlineCommands(calls).map((c) => c.toolCallId), ['b']);
  });
  test('同一 id 多次出现只算一行（以最后一次为准）', () => {
    const rows = toolRowsOf([{ toolCallId: 'g', title: 'grep', kind: 'search', status: 'pending' }, { toolCallId: 'g', title: 'grep "x"', kind: 'search', status: 'completed' }]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].call.status, 'completed');
  });
  test('kiro 的一轮（只有命令 / 改文件）：这一块是空的', () => {
    assert.deepEqual(toolRowsOf([{ toolCallId: 'k', title: 'Running: ls', kind: 'execute', status: 'completed' }]), []);
  });
  test('Task 行：用时、子代理进度、状态', () => {
    assert.equal(isSubagentCall(calls[4]), true);
    assert.equal(isSubagentCall(calls[0]), false);
    assert.equal(toolDuration(calls[4], 0), '3.2s');
    assert.equal(toolDuration({ startedAt: 0 }, 65_000), '1m 05s');
    assert.equal(toolDuration({}, 5), '');
    assert.deepEqual(childProgress([calls[5], calls[6], { toolCallId: 'z', title: '', status: 'pending' }]), { done: 1, failed: 1, running: 1 });
    assert.equal(toolState('pending'), 'running');
    assert.equal(toolState('failed'), 'failed');
  });
  test('结果摘要：第一行非空、跳过代码围栏', () => {
    assert.equal(toolResultSummary('```\nFile does not exist.\n```'), 'File does not exist.');
    assert.equal(toolResultSummary(undefined), '');
  });
});

describe('diffView：Edit 显示 - / +，Write 是新文件', () => {
  test('实测的 Edit：alpha → beta', () => {
    const v = diffView('alpha', 'beta');
    assert.equal(v.isNew, false);
    assert.deepEqual(v.lines, [{ op: '-', text: 'alpha' }, { op: '+', text: 'beta' }]);
    assert.deepEqual([v.added, v.removed], [1, 1]);
  });
  test('原来的行数差在这里是 0/0 —— 现在按行比出真实增删', () => {
    const v = diffView('a\nb\nc', 'a\nB\nc\nd');
    assert.deepEqual([v.added, v.removed], [2, 1]);
    assert.deepEqual(v.lines.map((l) => l.op + l.text), [' a', '-b', '+B', ' c', '+d']);
  });
  test('Write（oldText 为 null）：新文件，全是 +', () => {
    const v = diffView(null, 'p\nq');
    assert.equal(v.isNew, true);
    assert.deepEqual(v.lines, [{ op: '+', text: 'p' }, { op: '+', text: 'q' }]);
    assert.deepEqual([v.added, v.removed], [2, 0]);
    assert.equal(diffView(undefined, '').added, 0);
    /* 实测（截图那一轮）：Write 'alpha\nbeta\ngamma\n' 原来多出一行空的 +、计成 +4 */
    const w = diffView(null, 'alpha\nbeta\ngamma\n');
    assert.deepEqual(w.lines.map((l) => l.op + l.text), ['+alpha', '+beta', '+gamma']);
    assert.equal(w.added, 3);
  });
  test('长的不变段折成「…」，只留上下文', () => {
    const old = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    const v = diffView(old, old.replace('l15', 'L15'));
    assert.deepEqual([v.added, v.removed], [1, 1]);
    assert.ok(v.lines.filter((l) => l.op === '…').length === 2);
    assert.ok(v.lines.length < 15);
  });
  test('一样的文本：没有改动行', () => {
    assert.deepEqual(diffView('x', 'x'), { isNew: false, added: 0, removed: 0, lines: [] });
  });
  test('同一个文件改了几次：增删合计', () => {
    assert.deepEqual(sumDiffStats([{ oldText: 'alpha', newText: 'beta' }, { oldText: null, newText: 'p' }]), { added: 2, removed: 1, isNew: true });
  });
});
