import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { busyEnterMode, detachedTurnEnded, withoutSteering, steeringParams, steeringPromptBlocks, steeringVerdict } from '../src/main/busyEnterCaps.ts';
import { AcpClient } from '../src/main/acp-client.ts';
import { steerFailureRoute, steerPayload, engineCanSteer, busyEnterRoute } from '../src/renderer/steerRoute.ts';
import { matchConsumedSteers } from '../src/renderer/steerPending.ts';

/**
 * Claude Code 忙时 Enter 交给适配器：按 initialize 的能力声明走 `_session/steering`（插进当前轮）/ promptQueueing，
 * 不再一律扣在 KiroLex 队列里。
 */

/** claude-agent-acp 0.88.0 initialize 响应（dist/acp-agent.js 的 `initialize()`，只留和这里有关的字段） */
const CLAUDE_INIT = {
  protocolVersion: 1,
  agentCapabilities: {
    _meta: { claudeCode: { promptQueueing: true }, authStatus: {} },
    promptCapabilities: { image: true, embeddedContext: true },
    loadSession: true,
  },
  agentInfo: { name: '@agentclientprotocol/claude-agent-acp', version: '0.88.0' },
  _meta: { steering: { supported: true } },
};
/** 任务描述里写的位置：agentCapabilities._meta 下、和 claudeCode 同级 */
const CLAUDE_INIT_CAPS_META = {
  protocolVersion: 1,
  agentCapabilities: { _meta: { claudeCode: { promptQueueing: true }, steering: { supported: true } } },
};
/** codex-acp 2.1.1 initialize 响应（实测，只留相关字段） */
const CODEX_INIT = {
  protocolVersion: 1,
  agentInfo: { name: '@agentclientprotocol/codex-acp', title: 'Codex', version: '2.1.1' },
  agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true, image: true }, _meta: { authStatus: {} } },
  _meta: { steering: { supported: true } },
};
const QUEUEING_ONLY = { protocolVersion: 1, agentCapabilities: { _meta: { claudeCode: { promptQueueing: true } } } };
const NOTHING = { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } };

function fakeClient(engine: 'kiro' | 'claude' | 'codex', init?: any) {
  const c: any = new AcpClient('m', {}, undefined, 'ask', undefined, undefined, engine);
  const sent: any[] = [];
  c.send = (msg: any) => { sent.push(msg); };
  c.process = { stdin: { writable: true } };
  c.initializeResult = init;
  const updates: any[] = [];
  c.on('update', (u: any) => updates.push(u));
  let configEvents = 0;
  c.on('config-options', () => { configEvents++; });
  return { c, sent, updates, configEvents: () => configEvents };
}

describe('能力声明 → 忙时普通 Enter 的路由', () => {
  test('kiro → kiro 的 _session/steer（不看 initialize）', () => {
    assert.equal(busyEnterMode('kiro', undefined), 'steer');
    assert.equal(busyEnterMode(undefined, CLAUDE_INIT), 'steer');
  });
  test('声明了 steering → _session/steering（顶层 _meta 和 agentCapabilities._meta 两处都认）', () => {
    assert.equal(busyEnterMode('claude', CLAUDE_INIT), 'steering');
    assert.equal(busyEnterMode('claude', CLAUDE_INIT_CAPS_META), 'steering');
  });
  test('Codex（codex-acp 2.1.1 实测的 initialize：顶层 _meta.steering，没有 promptQueueing）→ _session/steering', () => {
    assert.equal(busyEnterMode('codex', CODEX_INIT), 'steering');
    assert.equal(withoutSteering('codex', CODEX_INIT), 'queue', 'steering 不可用时两样都没有 → KiroLex 队列');
    assert.equal(fakeClient('codex', CODEX_INIT).c.supportsPromptQueueing, false);
    assert.equal(fakeClient('claude', CLAUDE_INIT).c.supportsPromptQueueing, true);
  });
  test('Codex 那一轮的结束信号：session_info_update 的 _meta.codex.threadStatus.type === idle', () => {
    assert.equal(detachedTurnEnded({ sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'idle' } } } }), true);
    assert.equal(detachedTurnEnded({ sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'active', activeFlags: [] } } } }), false);
    assert.equal(detachedTurnEnded({ sessionUpdate: 'agent_message_chunk', content: { text: 'idle' } }), false);
  });
  test('只声明了 promptQueueing → 直接再发 session/prompt（prompt-queue）', () => {
    assert.equal(busyEnterMode('claude', QUEUEING_ONLY), 'prompt-queue');
  });
  test('都没有（或还没 initialize）→ KiroLex 自己的队列', () => {
    assert.equal(busyEnterMode('claude', NOTHING), 'queue');
    assert.equal(busyEnterMode('codex', undefined), 'queue');
    assert.equal(busyEnterMode('claude', { _meta: { steering: { supported: 'yes' } } }), 'queue', '只认 === true');
  });
  test('steering 不可用了往下退一档', () => {
    assert.equal(withoutSteering('claude', CLAUDE_INIT), 'prompt-queue');
    assert.equal(withoutSteering('codex', { _meta: { steering: { supported: true } } }), 'queue');
    assert.equal(withoutSteering('kiro', undefined), 'steer');
  });
  test('AcpClient.busyEnter / supportsSteer 跟着能力声明走', () => {
    assert.equal(fakeClient('claude', CLAUDE_INIT).c.busyEnter, 'steering');
    assert.equal(fakeClient('claude', CLAUDE_INIT).c.supportsSteer, true);
    assert.equal(fakeClient('claude', QUEUEING_ONLY).c.supportsSteer, false);
    assert.equal(fakeClient('claude', NOTHING).c.supportsSteer, false);
    assert.equal(fakeClient('kiro').c.supportsSteer, true);
  });
  test('渲染端：busyEnter 决定 canSteer；只有 promptQueueing 的还是排队', () => {
    assert.equal(engineCanSteer('claude', 'steering'), true);
    assert.equal(engineCanSteer('claude', 'prompt-queue'), false);
    assert.equal(engineCanSteer('claude', 'queue'), false);
    assert.equal(engineCanSteer(undefined, 'steer'), true);
    assert.equal(busyEnterRoute({ busy: 'turn', canSteer: engineCanSteer('claude', 'steering') }), 'steer');
    assert.equal(busyEnterRoute({ busy: 'turn', canSteer: engineCanSteer('claude', 'queue') }), 'queue');
  });
});

describe('_session/steering 请求的参数', () => {
  test('sessionId + ContentBlock 数组 + _meta.steering.idleBehavior:"promptRequired"', () => {
    assert.deepEqual(steeringParams('cli-1', '再看一下 README'), {
      sessionId: 'cli-1',
      prompt: [{ type: 'text', text: '再看一下 README' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    });
  });
  test('附件和普通发送一样：引用块一块、正文一块；只有附件时只有引用块', () => {
    const att = [{ path: '/tmp/a.png', isImage: true }];
    assert.deepEqual(steeringPromptBlocks(steerPayload('看图', att)), [
      { type: 'text', text: '<hidden>file:/tmp/a.png\n请读取这些文件内容</hidden>' },
      { type: 'text', text: '看图' },
    ]);
    assert.deepEqual(steeringPromptBlocks(steerPayload('', att)), [
      { type: 'text', text: '<hidden>file:/tmp/a.png\n请读取这些文件内容</hidden>' },
    ]);
  });
  test('AcpClient.steering 发出的帧', async () => {
    const { c, sent } = fakeClient('claude', CLAUDE_INIT);
    const p = c.steering('cli-1', '  补一句  ');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, '_session/steering');
    assert.equal(typeof sent[0].id, 'number', '是请求（要等响应），不是通知');
    assert.deepEqual(sent[0].params, {
      sessionId: 'cli-1',
      prompt: [{ type: 'text', text: '补一句' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    });
    c.handleMessage({ jsonrpc: '2.0', id: sent[0].id, result: { outcome: 'injected' } });
    assert.deepEqual(await p, { steered: true });
  });
});

describe('_session/steering 的三种结果', () => {
  test('injected → steered，并发一条和 kiro 一样的 steer_consumed（气泡标「已追加」、落盘走 acp:persist-steer）', async () => {
    const { c, sent, updates } = fakeClient('claude', CLAUDE_INIT);
    const p = c.steering('cli-1', '换成中文');
    c.handleMessage({ jsonrpc: '2.0', id: sent[0].id, result: { outcome: 'injected' } });
    assert.deepEqual(await p, { steered: true });
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.sessionUpdate, 'steer_consumed');
    // 渲染端的对账能认出它
    const consumed = matchConsumedSteers([{ msgId: 'x', content: '换成中文', attachments: [] }], updates[0].update.text);
    assert.deepEqual([...consumed], ['x']);
  });
  test('promptRequired（这一轮刚好结束）→ reason idle → 改成普通发送', async () => {
    const { c, sent, updates } = fakeClient('claude', CLAUDE_INIT);
    const p = c.steering('cli-1', 'hi');
    c.handleMessage({ jsonrpc: '2.0', id: sent[0].id, result: { outcome: 'promptRequired', reason: 'noRunningTurn' } });
    const res = await p;
    assert.deepEqual(res, { steered: false, reason: 'idle' });
    assert.equal(steerFailureRoute(res.reason), 'send-now');
    assert.equal(updates.length, 0, '没插进去就不能标成已追加');
  });
  test('报错（-32601）+ 声明了 promptQueueing → 降级成交给 CLI 排（handoff），不退回 KiroLex 队列、不标红；以后不再试 steering', async () => {
    const { c, sent, configEvents } = fakeClient('claude', CLAUDE_INIT);
    const p = c.steering('cli-1', 'hi');
    c.handleMessage({ jsonrpc: '2.0', id: sent[0].id, error: { code: -32601, message: 'Method not found' } });
    const res = await p;
    assert.equal(res.steered, false);
    assert.equal(res.reason, 'handoff');
    assert.equal(steerFailureRoute(res.reason), 'handoff');
    assert.equal(c.busyEnter, 'prompt-queue');
    assert.equal(c.supportsSteer, false);
    assert.equal(configEvents(), 1, '让界面重拿 busyEnter');
  });
  test('报错 + 两样都没有（Codex）→ KiroLex 队列，不标红', async () => {
    const { c, sent } = fakeClient('codex', CODEX_INIT);
    const p = c.steering('cli-1', 'hi');
    c.handleMessage({ jsonrpc: '2.0', id: sent[0].id, error: { code: -32601, message: 'Method not found' } });
    const res = await p;
    assert.equal(res.reason, 'unsupported');
    assert.equal(steerFailureRoute(res.reason), 'queue', '排队作为下一条，不是 ask（标红）');
    assert.equal(c.busyEnter, 'queue');
  });
  test('别的错误 / outcome:failed → 同样降级，但不永久关掉', async () => {
    const { c, sent } = fakeClient('claude', CLAUDE_INIT);
    const p = c.steering('cli-1', 'hi');
    c.handleMessage({ jsonrpc: '2.0', id: sent[0].id, error: { code: -32603, message: 'Internal error' } });
    assert.equal(steerFailureRoute((await p).reason), 'handoff');
    assert.equal(c.busyEnter, 'steering');
    assert.equal(steeringVerdict({ outcome: 'failed' }), 'failed');
  });
  test('这一轮刚好结束、适配器自己起了一轮（Codex 的 startedNewTurn）→ handed-off：不重发、不标成追加，也不降级', async () => {
    assert.equal(steeringVerdict({ outcome: 'startedNewTurn' }), 'detached');
    const { c, sent, updates } = fakeClient('codex', CODEX_INIT);
    const p = c.steering('cli-1', 'hi');
    c.handleMessage({ jsonrpc: '2.0', id: sent[0].id, result: { outcome: 'startedNewTurn' } });
    const res = await p;
    assert.equal(res.steered, false);
    assert.equal(res.reason, 'handed-off');
    assert.equal(steerFailureRoute(res.reason), 'handed-off', '渲染端什么都不再发：主进程把那一轮认成这条消息的');
    assert.equal(updates.length, 0, '它不是追加进上一轮的：不发 steer_consumed（不会并进上一轮的用户消息）');
    assert.equal(c.busyEnter, 'steering');
  });
});

describe('旧轮结束和 _session/steering 请求交错', () => {
  test('请求发出后旧轮的 session/prompt 先结束、适配器回 promptRequired → 当普通消息发（新的一轮归 KiroLex 管）', async () => {
    const { c, sent, updates } = fakeClient('claude', CLAUDE_INIT);
    const turn = c.sendPrompt('cli-1', [{ type: 'text', text: 'run it' }]);
    const steer = c.steering('cli-1', '再补一句');
    assert.deepEqual(sent.map((m: any) => m.method), ['session/prompt', '_session/steering'], '两个请求同时在途，各自按 id 等响应');
    // 旧轮先结束
    c.handleMessage({ jsonrpc: '2.0', id: sent[0].id, result: { stopReason: 'end_turn' } });
    assert.deepEqual(await turn, { stopReason: 'end_turn' });
    // 适配器发现没有在跑的一轮：原样退回，不自己起一轮
    c.handleMessage({ jsonrpc: '2.0', id: sent[1].id, result: { outcome: 'promptRequired', reason: 'noRunningTurn' } });
    const res = await steer;
    assert.deepEqual(res, { steered: false, reason: 'idle' });
    assert.equal(steerFailureRoute(res.reason), 'send-now', '渲染端走 sendNowOrNext → acp:prompt，这一轮的开始、结束、落盘都归 KiroLex');
    assert.equal(updates.length, 0, '没插进去就不标成已追加、不落盘成追加');
    assert.equal(c.busyEnter, 'steering', '这是正常情况，不降级');
  });
  test('插进去了：steering 的响应在这一轮的 session/prompt 结束之前回来（输出都在一轮之内，replayGuard 不会丢）', async () => {
    const { c, sent } = fakeClient('claude', CLAUDE_INIT);
    let turnDone = false;
    const turn = c.sendPrompt('cli-1', [{ type: 'text', text: 'run it' }]).then(() => { turnDone = true; });
    const steer = c.steering('cli-1', '再补一句');
    c.handleMessage({ jsonrpc: '2.0', id: sent[1].id, result: { outcome: 'injected' } });
    assert.deepEqual(await steer, { steered: true });
    assert.equal(turnDone, false);
    c.handleMessage({ jsonrpc: '2.0', id: sent[0].id, result: { stopReason: 'end_turn' } });
    await turn;
    assert.equal(turnDone, true);
  });
});

describe('kiro 照旧走 _session/steer（逐字不变）', () => {
  test('fire-and-forget、正文包 <user_message>、params 只有 sessionId + message', () => {
    const { c, sent } = fakeClient('kiro');
    assert.equal(c.steer('k-1', '  hello  '), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, '_session/steer');
    assert.deepEqual(sent[0].params, { sessionId: 'k-1', message: '<user_message>\nhello\n</user_message>' });
    assert.equal(c.busyEnter, 'steer');
  });
});

describe('接线', () => {
  const src = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
  const M = src('main', 'index.ts');
  test('acp:steer：声明了 steering 的走 client.steering，kiro 那行 client.steer 原样留着', () => {
    const at = M.indexOf("ipcMain.handle('acp:steer'");
    const body = M.slice(at, M.indexOf("ipcMain.handle('acp:persist-steer'", at));
    const branch = body.indexOf("if (entry.client.busyEnter === 'steering')");
    assert.ok(branch > 0);
    assert.ok(body.includes('const capped = capImageRefsInText(message);'));
    assert.ok(branch < body.indexOf('res = await entry.client.steering(entry.cliSessionId, capped);'));
    assert.ok(branch > body.indexOf('steerRefusal('), '先过同一道 steerRefusal（没连上 / 重建 / 已空闲）');
    assert.match(body, /const steered = entry\.client\.steer\(entry\.cliSessionId, capImageRefsInText\(message\)\);/);
  });
  test('engine-models 把 busyEnter 带给渲染端', () => {
    const at = M.indexOf('function engineModelsPayload(');
    assert.match(M.slice(at, at + 800), /busyEnter: entry\.client\.busyEnter,/);
  });
});

describe('Codex 自己起的那一轮：主进程从 steer 文字拆回显示用的正文和附件', () => {
  test('带附件：正文 + 附件；只有附件：正文为空；没有附件：原样', async () => {
    const { steerDisplay } = await import('../src/main/busyEnterCaps.ts');
    const att = [{ path: '/tmp/a.png', isImage: true }, { path: 'C:\\work\\notes.md' }];
    assert.deepEqual(steerDisplay(steerPayload('看这两个', att)), {
      text: '看这两个',
      files: [{ name: 'a.png', path: '/tmp/a.png', isImage: true }, { name: 'notes.md', path: 'C:\\work\\notes.md' }],
    });
    assert.deepEqual(steerDisplay(steerPayload('', [att[0]])), { text: '', files: [{ name: 'a.png', path: '/tmp/a.png', isImage: true }] });
    assert.deepEqual(steerDisplay('  就一句话  '), { text: '就一句话', files: [] });
  });
});
