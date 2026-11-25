import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSubagentList, foldTurnRoster, noteSubagent, appendSubagentOutput, asTurnSubagents, subagentTag,
  type TurnSubagent,
} from '../src/main/subagents.ts';
import { subagentGroups, mergeTurnSubagents, currentStep, withTurnSubagents, isSubagentChildCall } from '../src/renderer/subagentGroups.ts';
import { mainlineCommands, toolRowsOf, type ToolCallLike } from '../src/renderer/toolRows.ts';
import { shouldRecordToolCall, subagentTraceFields } from '../src/main/toolTrace.ts';

/**
 * kiro 原生子代理「谁做了什么」（2026-11-25「能看到子代理在跑，但看不到子代理都在干啥」，会话 s_1795593792807_uwz4w9）：
 * 带 childSessionId 的调用按子代理归组、名单补名字 / 任务 / 状态；主线不受影响；落盘再读回来一样。
 */

const A = 'd3bc9734-c3dc-46b5-bb07-cc8403859957';
const B = '5e930dee-1b49-4ac6-a645-e32942eeb2ea';
const T0 = 1_786_843_340_000;

/** 照 `scripts/acp-probe.mjs` 抓到的原样名单 */
const roster = (statusA: string, statusB?: string) => parseSubagentList({
  subagents: [
    { sessionId: A, sessionName: 'probe-b', agentName: 'probe-worker', initialQuery: 'Read the directory /tmp/probe-b.\nReport how many .txt files it contains.', status: { type: statusA, ...(statusA === 'working' ? { message: 'Running' } : {}) }, group: 'crew-Inspect probe direct', createdAtMs: T0 + 9_979 },
    ...(statusB ? [{ sessionId: B, sessionName: 'probe-a', agentName: 'probe-worker', initialQuery: 'Read /tmp/probe-a', status: { type: statusB }, createdAtMs: T0 + 10_100 }] : []),
  ],
});

const call = (id: string, extra: Partial<ToolCallLike> = {}): ToolCallLike => ({ toolCallId: id, title: `Running: @kirolex-local/local_read`, status: 'completed', kind: 'other', ...extra });

describe('foldTurnRoster：名单折进这一轮', () => {
  test('还在跑的收进来；上一轮早就 terminated 的不收；状态说明跟着最新那份', () => {
    const old = parseSubagentList({ subagents: [{ sessionId: 'old-1', sessionName: 'stale', agentName: 'w', status: { type: 'terminated' }, createdAtMs: T0 - 60_000 }] });
    let turn = foldTurnRoster(undefined, [...old, ...roster('working')], { turnStartedAt: T0, now: T0 + 10_000 });
    assert.deepEqual(turn.map((s) => s.sessionId), [A]);
    assert.equal(turn[0].statusMessage, 'Running');
    assert.equal(turn[0].seenAtMs, T0 + 10_000);
    turn = foldTurnRoster(turn, roster('terminated', 'terminated'), { turnStartedAt: T0, now: T0 + 40_000 });
    assert.deepEqual(turn.map((s) => [s.name, s.statusType]), [['probe-b', 'terminated'], ['probe-a', 'terminated']]);
    assert.equal(turn[0].statusMessage, undefined, 'terminated 那份不带 message，不能留着「Running」');
    assert.equal(turn[0].endedAtMs, T0 + 40_000);
    /* B 一出现就是 terminated，但它在这一轮开始之后创建 → 是这一轮的 */
    assert.equal(turn[1].endedAtMs, T0 + 40_000);
  });

  test('见过它的调用（knownIds）的，就算第一次在名单里就是 terminated、钟对不上，也收', () => {
    const turn = foldTurnRoster(undefined, roster('terminated'), { turnStartedAt: T0 + 999_999, now: T0, knownIds: [A] });
    assert.deepEqual(turn.map((s) => s.name), ['probe-b']);
  });

  test('名单没到之前的占位行（只有 id），名单到了补上名字和任务、保留输出', () => {
    let turn = appendSubagentOutput(undefined, A, 'text', '我读完了', T0);
    assert.equal(turn[0].name, '');
    turn = foldTurnRoster(turn, roster('working'), { turnStartedAt: T0, now: T0 + 5 });
    assert.equal(turn.length, 1);
    assert.equal(turn[0].name, 'probe-b');
    assert.match(turn[0].task, /probe-b/);
    assert.equal(turn[0].text, '我读完了');
    assert.equal(turn[0].seenAtMs, T0, '用时从第一次见到算');
  });

  test('侧栏标记不受影响：subagentTag 照旧只看进程级名单', () => {
    assert.equal(subagentTag(roster('working'), 'en')?.count, 1);
    assert.equal(subagentTag(roster('terminated'), 'en'), null);
  });
});

describe('appendSubagentOutput：子代理的正文 / 思考接在它自己那一行', () => {
  test('正文和思考分开攒，太长只留最后那段', () => {
    let turn = noteSubagent(undefined, A, T0);
    turn = appendSubagentOutput(turn, A, 'thinking', '想一下', T0);
    turn = appendSubagentOutput(turn, A, 'text', 'abc', T0);
    turn = appendSubagentOutput(turn, A, 'text', 'def', T0);
    assert.equal(turn[0].text, 'abcdef');
    assert.equal(turn[0].thinking, '想一下');
    const long = appendSubagentOutput(undefined, B, 'text', 'x'.repeat(50) + 'END', T0, 10);
    assert.equal(long[0].text!.length, 10);
    assert.ok(long[0].text!.startsWith('…') && long[0].text!.endsWith('END'));
  });
});

describe('subagentGroups：子代理 → 它的调用', () => {
  const calls: ToolCallLike[] = [
    call('main-1', { title: 'Running: ls', kind: 'execute' }),
    call('a-1', { childSessionId: A, toolName: 'local_read', input: 'path=/tmp/probe-b/a.txt', startedAt: T0 + 11_000, endedAt: T0 + 12_000 }),
    call('b-1', { childSessionId: B, toolName: 'local_write', input: 'path=/tmp/out.md', status: 'in_progress', startedAt: T0 + 11_500 }),
    call('a-2', { childSessionId: A, toolName: 'local_bash', title: 'Running: @kirolex-local/local_bash', command: 'wc -l *.txt', status: 'in_progress', startedAt: T0 + 13_000 }),
    call('main-2', { title: 'Summarizing', kind: 'other' }),
  ];

  test('名单没到：按 childSessionId 归组，名字先用 id 前 8 位；主线调用不进来', () => {
    const groups = subagentGroups(calls, undefined, true);
    assert.deepEqual(groups.map((g) => [g.name, g.calls.map((c) => c.toolCallId)]), [[A.slice(0, 8), ['a-1', 'a-2']], [B.slice(0, 8), ['b-1']]]);
    assert.ok(groups.every((g) => !g.named && g.running));
    assert.equal(currentStep(groups[0])?.toolCallId, 'a-2', '正在做的那一步 = 最后一条还在跑的');
  });

  test('名单到了：补上名字 / 任务 / 状态，顺序按名单；已结束的不算运行中、有结束时间', () => {
    const turn = foldTurnRoster(undefined, roster('terminated', 'working'), { turnStartedAt: T0, now: T0 + 20_000 });
    const groups = subagentGroups(calls, turn, true);
    assert.deepEqual(groups.map((g) => [g.name, g.agentName, g.statusType, g.running]), [
      ['probe-b', 'probe-worker', 'terminated', false],
      ['probe-a', 'probe-worker', 'working', true],
    ]);
    assert.match(groups[0].task, /Read the directory/);
    assert.equal(groups[0].endedAt, T0 + 20_000);
    assert.equal(groups[0].startedAt, T0 + 11_000);
  });

  test('这一轮已经结束：谁都不算运行中', () => {
    const groups = subagentGroups(calls, undefined, false);
    assert.ok(groups.every((g) => !g.running));
  });

  test('名单里有、还没调用过的也有一行（任务和状态先看得到）', () => {
    const turn = foldTurnRoster(undefined, roster('working'), { turnStartedAt: T0, now: T0 });
    const groups = subagentGroups([], turn, true);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].calls.length, 0);
    assert.equal(groups[0].running, true);
  });

  test('主线的「⚡ 执行的命令」「🔧 用过的工具」不含子代理的调用', () => {
    assert.deepEqual(mainlineCommands(calls).map((c) => c.toolCallId), ['main-1']);
    assert.ok(toolRowsOf(calls).every((r) => !isSubagentChildCall(r.call)));
    assert.deepEqual(toolRowsOf(calls).map((r) => r.call.toolCallId), ['main-2']);
  });

  test('Claude Code 的 Task 嵌套照旧（没有 childSessionId 的不受影响）', () => {
    const cc: ToolCallLike[] = [
      { toolCallId: 't', title: 'Task', toolName: 'Agent', status: 'completed' },
      { toolCallId: 'k', title: 'ls', kind: 'execute', parentToolCallId: 't', status: 'completed' },
    ];
    assert.deepEqual(toolRowsOf(cc).map((r) => [r.call.toolCallId, r.children.map((c) => c.toolCallId)]), [['t', ['k']]]);
    assert.deepEqual(mainlineCommands(cc), []);
    assert.deepEqual(subagentGroups(cc, undefined, true), []);
  });
});

describe('子代理调用的记录口径', () => {
  test('kiro：带 childSessionId 的每条都记；主线的判据不变', () => {
    assert.equal(shouldRecordToolCall('kiro', { kind: 'other', title: 'Running: @kirolex-local/local_read', childSessionId: A }), true);
    assert.equal(shouldRecordToolCall('kiro', { kind: 'other', title: 'Running: @kirolex-local/local_read' }), false);
  });

  test('工具名从 kiro 标题里剥出来，入参摘要带路径 / 命令', () => {
    const f = subagentTraceFields({ toolCallId: 'x', title: 'Running: @kirolex-local/local_read', rawInput: { path: '/tmp/probe-b/a.txt' } });
    assert.equal(f.toolName, 'local_read');
    assert.equal(f.input, 'path=/tmp/probe-b/a.txt');
    /* 后面的 update 不带标题：沿用前一条的 */
    const g = subagentTraceFields({ toolCallId: 'y', rawInput: { command: 'wc -l *.txt' } }, { title: 'Running: @kirolex-local/local_bash' });
    assert.equal(g.toolName, 'local_bash');
    assert.equal(g.command, 'wc -l *.txt');
  });
});

describe('mergeTurnSubagents / withTurnSubagents：实时那一侧挂到这一轮上', () => {
  test('几段消息的名单合成一份：后面的覆盖、正文取长的、占位行不盖掉已知名字', () => {
    const a: TurnSubagent[] = [{ sessionId: A, name: 'probe-b', agentName: 'w', task: 't', statusType: 'working', text: 'abc', seenAtMs: 5 }];
    const b: TurnSubagent[] = [{ sessionId: A, name: '', agentName: '', task: '', statusType: 'unknown', text: 'ab', seenAtMs: 9 }];
    const m = mergeTurnSubagents([a, b]);
    assert.deepEqual([m[0].name, m[0].statusType, m[0].text, m[0].seenAtMs], ['probe-b', 'working', 'abc', 5]);
  });

  test('挂到这一轮已经有 subagents 的那条；这一轮还没有助手消息就新建一条', () => {
    type M = { id: string; role: string; timestamp: number; subagents?: TurnSubagent[]; toolCalls?: ToolCallLike[] };
    const add = (prev: TurnSubagent[] | undefined) => appendSubagentOutput(prev, A, 'text', 'hi', 1);
    const isUser = (m: M) => m.role === 'user';
    let list: M[] = [{ id: 'u1', role: 'user', timestamp: 100 }];
    list = withTurnSubagents(list, isUser, () => true, add, () => ({ id: 'new', role: 'assistant', timestamp: 101 }));
    assert.deepEqual(list.map((m) => m.id), ['u1', 'new']);
    list = [...list, { id: 'a2', role: 'assistant', timestamp: 102 }];
    let seenCtx: any = null;
    list = withTurnSubagents(list, isUser, () => true, (p, ctx) => { seenCtx = ctx; return add(p); }, null);
    assert.equal(list[1].subagents![0].text, 'hihi', '还挂在原来那条上，不在两段之间来回挂');
    assert.equal(list[2].subagents, undefined);
    assert.equal(seenCtx.turnStartedAt, 100);
    assert.ok(seenCtx.knownIds.has(A));
    /* 没有这一轮、也不让新建：原样返回 */
    const none: M[] = [{ id: 'u', role: 'user', timestamp: 1 }];
    assert.equal(withTurnSubagents(none, isUser, () => true, add, null), none);
  });
});

describe('落盘再读回：分组一致', () => {
  let home = '';
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let store: typeof import('../src/main/sessionStore.ts');
  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-subagents-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assert.equal(os.homedir(), home);
    store = await import('../src/main/sessionStore.ts');
  });
  after(() => {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('toolCalls 带 childSessionId、消息带 subagents，读回来分组和写之前一样', () => {
    const sid = 's_subagent_roundtrip';
    fs.mkdirSync(path.join(home, '.kirolex', 'sessions', sid), { recursive: true });
    let turn = foldTurnRoster(undefined, roster('working', 'working'), { turnStartedAt: T0, now: T0 + 10_000 });
    turn = appendSubagentOutput(turn, A, 'text', '一共 3 个 .txt', T0 + 15_000);
    turn = appendSubagentOutput(turn, B, 'thinking', '先读目录', T0 + 15_000);
    turn = foldTurnRoster(turn, roster('terminated', 'terminated'), { turnStartedAt: T0, now: T0 + 30_000 });
    const toolCalls = [
      { toolCallId: 'main-1', title: 'Running: ls', status: 'completed' as const, kind: 'execute' },
      { toolCallId: 'a-1', title: 'Running: @kirolex-local/local_read', status: 'completed' as const, kind: 'other', childSessionId: A, toolName: 'local_read', input: 'path=/tmp/probe-b/a.txt', startedAt: T0 + 11_000, endedAt: T0 + 12_000 },
      { toolCallId: 'b-1', title: 'Running: @kirolex-local/local_write', status: 'completed' as const, kind: 'other', childSessionId: B, toolName: 'local_write', input: 'path=/tmp/out.md', startedAt: T0 + 11_500, endedAt: T0 + 14_000 },
    ];
    const before = subagentGroups(toolCalls, turn, false);
    store.appendMessage(sid, { id: 'a_1', role: 'assistant', content: '父回复', ts: T0 + 31_000, toolCalls, subagents: turn });
    const [back] = store.readTranscript(sid);
    assert.equal(back.content, '父回复', '子代理的正文没拼进父回复');
    const after = subagentGroups(back.toolCalls || [], asTurnSubagents((back as any).subagents), false);
    assert.deepEqual(after, before);
    assert.deepEqual(after.map((g) => [g.name, g.calls.length, g.text, g.thinking]), [['probe-b', 1, '一共 3 个 .txt', ''], ['probe-a', 1, '', '先读目录']]);
    assert.deepEqual(mainlineCommands(back.toolCalls || []).map((c) => c.toolCallId), ['main-1']);
  });

  test('只有子代理输出（没有父回复、没有调用）的一轮：落盘后读回来，名单和它们的正文 / 思考都在', () => {
    const sid = 's_subagent_only';
    fs.mkdirSync(path.join(home, '.kirolex', 'sessions', sid), { recursive: true });
    let turn = foldTurnRoster(undefined, roster('working'), { turnStartedAt: T0, now: T0 + 1_000 });
    turn = appendSubagentOutput(turn, A, 'thinking', '先看目录', T0 + 2_000);
    turn = appendSubagentOutput(turn, A, 'text', '目录是空的', T0 + 3_000);
    turn = foldTurnRoster(turn, roster('terminated'), { turnStartedAt: T0, now: T0 + 4_000 });
    const before = subagentGroups([], turn, false);
    /* flushAssistant 这种轮次写出来的形状：正文空、没有 toolCalls，只有 subagents */
    store.appendMessage(sid, { id: 'a_only', role: 'assistant', content: '', ts: T0 + 5_000, subagents: turn });
    const [back] = store.readTranscript(sid);
    assert.equal(back.content, '');
    assert.equal(back.toolCalls, undefined);
    const after = subagentGroups(back.toolCalls || [], asTurnSubagents((back as any).subagents), false);
    assert.deepEqual(after, before);
    assert.deepEqual(after.map((g) => [g.name, g.task.slice(0, 18), g.text, g.thinking, g.statusType]), [['probe-b', 'Read the directory', '目录是空的', '先看目录', 'terminated']]);
  });

  test('asTurnSubagents 丢掉形状不对的行', () => {
    assert.equal(asTurnSubagents(undefined), undefined);
    assert.equal(asTurnSubagents([{ name: 'no id' }]), undefined);
    assert.deepEqual(asTurnSubagents([{ sessionId: 'x', name: 1 }]), [{ sessionId: 'x', name: '', agentName: '', task: '', statusType: 'unknown' }]);
  });
});

describe('接线（源码扫描）', () => {
  const src = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf-8');

  test('主进程：子代理的正文 / 思考进 turnSubagents，不拼进父回复；一轮结束随助手消息落盘', () => {
    const M = src('main', 'index.ts');
    const at = M.indexOf('const u = ownUpdate(data);');
    assert.ok(at > 0);
    /* 父回复的记账（assistantBuf / 分段）都读 `u`：子代理的正文 / 思考在这之前就被吃掉，`u` 是 undefined */
    assert.ok(at < M.indexOf('entry.assistantBuf +=', at));
    assert.match(M, /function ownUpdate\(d: any\): any \{ return takeSubagentOutput\(sessionId, entry, d\); \}/);
    const take = M.slice(M.indexOf('function takeSubagentOutput('), M.indexOf('function takeSubagentOutput(') + 800);
    assert.match(take, /entry\.turnSubagents = appendSubagentOutput\(entry\.turnSubagents, child, kind, text/);
    assert.match(take, /return undefined;/);
    /* 带上 childSessionId 要在决定记不记（shouldRecordToolCall）之前 */
    const assign = M.indexOf('Object.assign(next, subagentCallFields(entry, data, previous, status));');
    assert.ok(assign > 0 && assign < M.indexOf('if (shouldRecordToolCall(engineOf(entry.profile), next))', assign));
    assert.match(M, /return \{ \.\.\.subagentTraceFields\(u, previous\), \.\.\.toolTimes\(previous, status, Date\.now\(\)\), childSessionId \};/);
    assert.match(M, /entry\.turnSubagents = foldTurnRoster\(/);
    const flush = M.slice(M.indexOf('function flushAssistant('), M.indexOf('function flushAssistant(') + 3000);
    assert.match(flush, /subagents: entry.turnSubagents/);
    /* 只有子代理输出的一轮不能被「没东西可落」提前 return 掉 */
    assert.ok(flush.includes('if (!entry || (!entry.assistantBuf && entry.fileChanges.length === 0 && !entry.wedgeNote && !turnUsage && !entry.turnSubagents?.length)) {'));
  });

  test('渲染层：带 childSessionId 的正文 / 思考挂到子代理那一行，调用带上 childSessionId；读盘带回 subagents', () => {
    const U = src('renderer', 'hooks', 'useAcp.ts');
    const at = U.indexOf('const childSid = ');
    const seg = U.slice(at, at + 1200);
    assert.match(seg, /appendSubagentOutput\(prev, childSid, kind, text/);
    assert.ok(seg.indexOf('return;') > 0 && seg.indexOf('return;') < seg.indexOf("switch (update.sessionUpdate)"), '在追加父回复之前就返回');
    assert.match(U, /childSessionId: childSid \}/);
    assert.equal(U.split('...turnSubagentsOf(m),').length - 1, 5, '读盘的每一处都带回 subagents');
    assert.match(U, /\.\.\.\(m\.subagents\?\.length \? \{ subagents: m\.subagents \} : \{\}\)/, '整份重写时写回去');
  });

  test('聊天里：这一轮的面板先画子代理卡片', () => {
    const C = src('renderer', 'components', 'ChatArea.tsx');
    assert.match(C, /<SubagentsPanel calls=\{turnFileChanges\} roster=\{turnSubagents\} live=\{isStreaming && isLastAssistant\} autoFold=\{foldTools\} \/>/);
  });
});
