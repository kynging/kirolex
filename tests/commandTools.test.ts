/**
 * 「本机 / 后台 / 监视」这几个 MCP 命令工具当命令看（2026-11-25 第 6 轮）。
 *
 * 实测（Claude Code 远程会话 s_1795582682473_dj6azu）：一轮里 7 个 `mcp__kirolex-local__local_bash`（kind other，
 * title 就是工具名）都没进「⚡ 执行的命令」，面板里只剩一个 Claude 自带的 Bash（`sleep 20; echo`）被当成「正在运行」；
 * 折叠预览显示的是工具名 `mcp__kirolex-local__local_bash`，看不出命令；入参摘要截在 80 字。
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bareToolName, commandToolKind, isCommandCall, mergeToolTrace, shouldRecordToolCall, toolTraceFields, commandTraceFields,
} from '../src/main/toolTrace.ts';
import { callPreview, mainlineCommands, toolRowsOf, toolState } from '../src/renderer/toolRows.ts';
import { pickCurrent } from '../src/renderer/segmentFold.ts';

const LONG = Array.from({ length: 40 }, (_, i) => `aws ssm get-command-invocation --command-id c-${i} --instance-id i-0abc`).join(' && ');

// 三个引擎各自的样子
const claudeLocal = { toolCallId: 'c1', title: 'mcp__kirolex-local__local_bash', kind: 'other', toolName: 'mcp__kirolex-local__local_bash', command: 'for i in $(seq 1 40); do aws ssm list-commands; sleep 1; done', status: 'in_progress' };
const kiroLocal = { toolCallId: 'k1', title: '@kirolex-local/local_bash', kind: 'other', command: 'npm test', status: 'completed' };
const kiroLocal2 = { toolCallId: 'k2', title: 'Running local_bash from kirolex-local', kind: 'other', command: 'ls', status: 'completed' };
const bgRun = { toolCallId: 'b1', title: 'mcp__kirolex-wake__bg_run', kind: 'other', toolName: 'mcp__kirolex-wake__bg_run', command: 'aws cloudformation wait stack-create-complete --stack-name x', label: '等 CloudFormation 栈', status: 'completed' };
const watchCall = { toolCallId: 'w1', title: 'watch', kind: 'other', toolName: 'watch', command: 'tail -f build.log', label: '盯构建日志', status: 'in_progress' };
const codexLocal = { toolCallId: 'x1', title: 'kirolex-local.local_bash', kind: 'other', command: 'pwd', status: 'completed' };
const claudeBash = { toolCallId: 'e1', title: 'sleep 20; echo', kind: 'execute', toolName: 'Bash', status: 'completed' };

describe('认得出命令类 MCP 工具（带不带 mcp__<server>__ / @server/ 前缀，三个引擎）', () => {
  test('bareToolName 去掉各家前缀', () => {
    assert.equal(bareToolName('mcp__kirolex-local__local_bash'), 'local_bash');
    assert.equal(bareToolName('@kirolex-local/local_bash'), 'local_bash');
    assert.equal(bareToolName('Running local_bash from kirolex-local'), 'local_bash');
    assert.equal(bareToolName('kirolex-local.local_bash'), 'local_bash');
    assert.equal(bareToolName('kirolex-local/session_send'), 'session_send');
    assert.equal(bareToolName('Read'), 'Read');
    assert.equal(bareToolName('Read src/x.ts'), undefined, '带空格的标题不是工具名');
    assert.equal(bareToolName('Running: watch -n 1 ls'), undefined, 'kiro 的 shell 标题不是工具名');
  });
  test('commandToolKind：local_bash = 本机，bg_run = 后台，watch = 监视；自带的 Bash 不算', () => {
    assert.equal(commandToolKind(claudeLocal), 'local');
    assert.equal(commandToolKind(kiroLocal), 'local');
    assert.equal(commandToolKind(kiroLocal2), 'local');
    assert.equal(commandToolKind(codexLocal), 'local');
    assert.equal(commandToolKind(bgRun), 'background');
    assert.equal(commandToolKind(watchCall), 'watch');
    assert.equal(commandToolKind(claudeBash), null);
    assert.equal(commandToolKind({ title: 'mcp__kirolex-local__session_send', kind: 'other' }), null);
    assert.equal(commandToolKind({ title: 'watch', kind: 'execute' }), null, '执行类 kind 的 shell 命令叫 watch 也只是命令');
  });
  test('都进 mainlineCommands，不再进「用过的工具」', () => {
    const calls = [claudeBash, claudeLocal, kiroLocal, kiroLocal2, bgRun, watchCall, codexLocal, { toolCallId: 'r1', title: 'Read x', kind: 'read', toolName: 'Read' }];
    assert.deepEqual(mainlineCommands(calls).map((c) => c.toolCallId), ['e1', 'c1', 'k1', 'k2', 'b1', 'w1', 'x1']);
    assert.deepEqual(toolRowsOf(calls).map((r) => r.call.toolCallId), ['r1']);
    assert.ok([claudeLocal, kiroLocal, bgRun, watchCall].every(isCommandCall));
  });
  test('kiro 的记录判据也收它们（原来 kind=other 直接不记）', () => {
    assert.equal(shouldRecordToolCall('kiro', kiroLocal), true);
    assert.equal(shouldRecordToolCall('kiro', kiroLocal2), true);
    assert.equal(shouldRecordToolCall('kiro', { kind: 'other', title: '@kirolex-local/session_read' }), false, '其余的 kiro 判据不变');
  });
  test('Bash 已完成 + local_bash 运行中 → 折叠态选中 local_bash', () => {
    const cmds = mainlineCommands([claudeBash, claudeLocal]);
    const cur = pickCurrent(cmds, (c) => toolState(c.status) === 'running');
    assert.equal(cur.current?.toolCallId, 'c1');
    assert.equal(cur.running, true);
    assert.equal(cur.done, 1);
  });
});

describe('显示文字是命令，不是工具名', () => {
  test('local_bash → 命令 + 本机', () => {
    assert.deepEqual(callPreview(claudeLocal), { text: claudeLocal.command, tag: 'local' });
    assert.deepEqual(callPreview(kiroLocal), { text: 'npm test', tag: 'local' });
  });
  test('bg_run / watch → label + 命令，标后台 / 监视', () => {
    assert.deepEqual(callPreview(bgRun), { text: `等 CloudFormation 栈\n${bgRun.command}`, tag: 'background' });
    assert.deepEqual(callPreview(watchCall), { text: '盯构建日志\ntail -f build.log', tag: 'watch' });
  });
  test('自带的 Bash：标题就是命令（去掉 Running: 前缀），不带标签', () => {
    assert.deepEqual(callPreview(claudeBash), { text: 'sleep 20; echo', tag: null });
    assert.deepEqual(callPreview({ toolCallId: 'k', title: 'Running: npm ci', kind: 'execute' }), { text: 'npm ci', tag: null });
  });
  test('旧记录只有截断的 input：照旧显示截断版（带 …），不报错', () => {
    const old = { toolCallId: 'o1', title: 'mcp__kirolex-local__local_bash', kind: 'other', toolName: 'mcp__kirolex-local__local_bash', input: `command="${'x '.repeat(39)}x…"` };
    const p = callPreview(old);
    assert.equal(p.tag, 'local');
    assert.ok(p.text.startsWith('x x x') && p.text.endsWith('…'), p.text);
    assert.deepEqual(callPreview({ toolCallId: 'o2', title: 'mcp__kirolex-local__local_bash', kind: 'other', input: 'command=ls' }), { text: 'ls', tag: 'local' });
    assert.deepEqual(callPreview({ toolCallId: 'o3', title: '@kirolex-local/local_bash', kind: 'other' }), { text: 'local_bash', tag: 'local' }, '什么都没有：退回短工具名');
  });
});

describe('其他工具：短工具名 + 主要参数，去掉 mcp 前缀', () => {
  test('session_send → 对方会话 id', () => {
    const c = { toolCallId: 's1', title: 'mcp__kirolex-local__session_send', kind: 'other', toolName: 'mcp__kirolex-local__session_send', input: '{"id":"s_1792000000000_abc","text":"汇报一下进度"}' };
    assert.deepEqual(callPreview(c), { text: 'session_send → s_1792000000000_abc', tag: null });
  });
  test('Read → 文件路径；Grep → pattern', () => {
    assert.deepEqual(callPreview({ toolCallId: 'r', title: 'Read src/x.ts', kind: 'read', toolName: 'Read', input: 'file_path=src/x.ts' }), { text: 'Read src/x.ts', tag: null });
    assert.deepEqual(callPreview({ toolCallId: 'g', title: 'grep', kind: 'search', toolName: 'Grep', input: 'pattern="foo bar" path=src' }), { text: 'Grep foo bar', tag: null });
  });
  test('schedule_create 用 prompt；没有入参（kiro）就只给短工具名', () => {
    assert.deepEqual(callPreview({ toolCallId: 'p', title: 'mcp__kirolex-wake__schedule_create', toolName: 'mcp__kirolex-wake__schedule_create', input: 'prompt="查一下栈的状态"' }), { text: 'schedule_create 查一下栈的状态', tag: null });
    assert.deepEqual(callPreview({ toolCallId: 'q', title: '@kirolex-local/session_read', kind: 'other' }), { text: 'session_read', tag: null });
  });
  test('只有描述性标题、没有入参：用标题', () => {
    assert.deepEqual(callPreview({ toolCallId: 'w', title: 'Fetch https://example.com', kind: 'fetch' }), { text: 'Fetch https://example.com', tag: null });
  });
});

describe('记录里保存完整命令（上限 4000），其他参数的截断不变', () => {
  test('Claude：rawInput.command 整段保存，换行保留；label 一并记', () => {
    const cmd = `cat > a.sh <<'EOF'\n${LONG}\nEOF`;
    const f = toolTraceFields({ toolCallId: 'c', _meta: { claudeCode: { toolName: 'mcp__kirolex-wake__bg_run' } }, rawInput: { command: cmd, label: '跑脚本' } });
    assert.equal(f.command, cmd);
    assert.equal(f.label, '跑脚本');
    assert.ok(f.input!.length <= 200 && f.input!.includes('…'), '入参摘要照旧截短');
  });
  test('超过 4000 字截断并带 …', () => {
    const f = commandTraceFields({ title: 'mcp__kirolex-local__local_bash', rawInput: { command: 'y'.repeat(5000) } });
    assert.equal(f.command!.length, 4000);
    assert.ok(f.command!.endsWith('…'));
  });
  test('kiro：只看标题也认得；不是命令工具的不带', () => {
    assert.deepEqual(commandTraceFields({ title: '@kirolex-local/local_bash', rawInput: { command: 'ls -la' } }), { command: 'ls -la' });
    assert.deepEqual(commandTraceFields({ title: '@kirolex-local/session_send', rawInput: { id: 's_1' } }), {});
    assert.deepEqual(commandTraceFields({ kind: 'execute', title: 'Running: ls', rawInput: { command: 'ls' } }), {}, '自带 shell 的标题就是命令，不另存');
  });
  test('Claude / Codex 分批发参数：首帧有工具名、rawInput={}，后续帧只带长命令 + label → 仍存完整文本（审查 2026-11-25）', () => {
    const cmd = `for i in $(seq 1 40); do\n  ${LONG}\ndone`;
    const first = { toolCallId: 'c', title: 'mcp__kirolex-wake__bg_run', _meta: { claudeCode: { toolName: 'mcp__kirolex-wake__bg_run' } }, rawInput: {} };
    const later = { toolCallId: 'c', rawInput: { command: cmd, label: '轮询 SSM' } };
    /* 和主进程 / 渲染层的更新分支同一个合并法：mergeToolTrace(prev, toolTraceFields(u, prev)) */
    const prev = mergeToolTrace(undefined, toolTraceFields(first));
    const rec = { title: first.title, kind: 'other', ...prev };
    const merged = mergeToolTrace(rec, toolTraceFields(later, rec));
    assert.equal(merged.command, cmd);
    assert.equal(merged.label, '轮询 SSM');
    assert.ok(merged.input!.includes('…') && merged.input!.length <= 200, '入参摘要照旧截短');
    assert.deepEqual(callPreview({ toolCallId: 'c', ...rec, ...merged }), { text: `轮询 SSM\n${cmd}`, tag: 'background' });
    /* 没有上一条（老调用方式）时认不出来 —— 所以两处更新分支都要传 */
    assert.equal(toolTraceFields(later).command, undefined);
  });
  test('update 不带标题 / 入参时沿用前一次的', () => {
    const prev = { title: '@kirolex-local/local_bash', command: 'ls -la' };
    assert.deepEqual(commandTraceFields({ status: 'completed' }, prev), {});
    assert.deepEqual(mergeToolTrace(prev, commandTraceFields({ status: 'completed' }, prev)), { command: 'ls -la' });
    assert.deepEqual(commandTraceFields({ rawInput: { command: 'pwd' } }, prev), { command: 'pwd' });
  });
});
