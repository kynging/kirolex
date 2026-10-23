import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AcpClient } from '../src/main/acp-client.ts';
import {
  detachedTurnMessageId,
  dropFollowUp,
  enlistFollowUp,
  handOverTurn,
  holdTarget,
  keepsBusy,
  nextFollowUp,
  type FollowUp,
  type FollowUpDeps,
  type HandoffSpec,
} from '../src/main/followUpTurns.ts';
import { detachedTurnEnded } from '../src/main/busyEnterCaps.ts';
import { steerFailureRoute, busyEnterKind } from '../src/renderer/steerRoute.ts';

/**
 * 忙时 Enter 交给适配器 —— 排在当前这一轮后面的那一轮（`followUpTurns.ts`）。
 *
 * 下面的 `harness` 用**真的** AcpClient（只把写管道换成收集器、用 handleMessage 喂适配器的帧）和**真的**
 * holdTarget / enlistFollowUp / handOverTurn，按 index.ts `sendPromptOnce` 的顺序跑一轮：
 *   登记（handoff）→ busy → 清零这一轮的缓冲 → 交出攒着的输出 → 等响应 → flush 进记录 → 收尾（keepsBusy → 交棒）。
 * index.ts 里是不是真按这个顺序接的，见最后一组源码断言。
 */

const CLAUDE_INIT = {
  agentCapabilities: { _meta: { claudeCode: { promptQueueing: true } } },
  _meta: { steering: { supported: true } },
};
const QUEUEING_ONLY = { agentCapabilities: { _meta: { claudeCode: { promptQueueing: true } } } };
const CODEX_INIT = {
  agentInfo: { name: '@agentclientprotocol/codex-acp', version: '2.1.1' },
  agentCapabilities: { _meta: { authStatus: {} } },
  _meta: { steering: { supported: true } },
};

const chunk = (text: string) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cli', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const threadStatus = (type: 'active' | 'idle') => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cli', update: { sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type } } } } } });

function harness(engine: 'claude' | 'codex', init: any) {
  const c: any = new AcpClient('m', {}, undefined, 'ask', undefined, undefined, engine);
  const sent: any[] = [];
  c.send = (msg: any) => { sent.push(msg); };
  c.process = { stdin: { writable: true } };
  c.initializeResult = init;
  const entry: any = { cliSessionId: 'cli', client: c, busy: false };
  /** 「落盘」的对话记录 */
  const transcript: Array<{ role: string; id?: string; replyTo?: string; text?: string }> = [];
  /** 这一轮的助手缓冲（index.ts 的 assistantBuf） */
  let buf = '';
  let current = '';
  let busyEvents = 0;
  const handle = (d: any) => {
    if (entry.detachedEnd) {
      if (detachedTurnEnded(d?.update)) { if (entry.detachedSeen) entry.detachedEnd(); }
      else entry.detachedSeen = true;
    }
    if (d?.update?.sessionUpdate === 'agent_message_chunk') buf += d.update.content.text;
  };
  entry.replayUpdates = (list: any[]) => list.forEach(handle);
  /* wireSession 的 client.on('update')：先问 holdTarget，再交给处理函数 */
  c.on('update', (d: any) => {
    const h = holdTarget(entry, d, c.promptInFlight);
    if (h) { h.held.push(d); return; }
    handle(d);
  });
  const deps: FollowUpDeps = {
    isCurrent: () => true,
    emitBusy: () => { busyEvents++; },
    notConnected: () => new Error('Session not connected'),
  };
  /** 一轮（index.ts sendPromptOnce 的骨架） */
  async function turn(messageId: string, prompt: any[], handoff?: HandoffSpec) {
    let pre: Promise<any> | undefined;
    let fu: FollowUp | undefined;
    const persistUser = () => { current = messageId; transcript.push({ role: 'user', id: messageId }); };
    if (handoff) {
      const r = await enlistFollowUp(entry, handoff, prompt, messageId, persistUser, deps);
      fu = r.followUp;
      pre = r.response;
    } else {
      persistUser();
    }
    entry.busy = true;
    entry.turnRunning = true;
    let owns = false;
    try {
      buf = '';
      let s: Promise<any>;
      if (pre) {
        s = pre;
        if (fu!.kind === 'detached') {
          const f = fu!;
          entry.detachedSeen = false;
          entry.detachedEnd = () => { entry.detachedEnd = undefined; f.endDetached?.({ stopReason: 'end_turn' }); };
        }
        fu!.live = true;
        const held = fu!.held.splice(0);
        if (held.length) entry.replayUpdates(held);
      } else {
        s = c.sendPrompt('cli', prompt);
      }
      const r = await s;
      transcript.push({ role: 'assistant', replyTo: current, text: buf });
      buf = '';
      return r;
    } finally {
      if (fu) { dropFollowUp(entry, fu); entry.detachedEnd = undefined; }
      if (keepsBusy(entry)) owns = true; else entry.busy = false;
      entry.turnRunning = false;
      if (owns) handOverTurn(entry, deps);
      else if (entry.limbo && !(entry.steeringInFlight || 0) && !entry.followUps?.length) {
        const held = entry.limbo.held;
        entry.limbo = undefined;
        if (held.length) entry.replayUpdates(held);
      }
    }
  }
  return { c, sent, entry, transcript, turn, busyEvents: () => busyEvents, buf: () => buf };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('纯判据：这条输出归谁、下一个该谁', () => {
  const f = (over: Partial<FollowUp>): FollowUp => ({ kind: 'queued', messageId: 'm', held: [], started: false, live: false, begin() {}, abort() {}, ...over });
  test('带 promptId 的：只有对上一个还没接手完的 queued 才攒', () => {
    const q = f({ promptId: 2 });
    const host = { followUps: [q] };
    assert.equal(holdTarget(host, { promptId: 2 }, true), q);
    assert.equal(holdTarget(host, { promptId: 1 }, true), null, '最老那个在途的 prompt 的输出照常处理');
    q.started = true;
    assert.equal(holdTarget(host, { promptId: 2 }, true), q, '交棒了但还没清零计数：接着攒，否则顺序会乱');
    q.live = true;
    assert.equal(holdTarget(host, { promptId: 2 }, true), null);
  });
  test('没带 promptId 的：有 prompt 在途就照常；没有在途的才归 detached / limbo', () => {
    const d = f({ kind: 'detached' });
    assert.equal(holdTarget({ followUps: [d] }, {}, true), null);
    assert.equal(holdTarget({ followUps: [d] }, {}, false), d);
    const limbo = { held: [] };
    assert.equal(holdTarget({ limbo }, {}, false), limbo);
    assert.equal(holdTarget({}, {}, false), null, 'kiro / 没有任何排着的：一条都不攒（行为不变）');
  });
  test('收尾时 busy 留不留：有人排着、或者 steering 还在途', () => {
    assert.equal(keepsBusy({}), false);
    assert.equal(keepsBusy({ steeringInFlight: 1 }), true);
    assert.equal(keepsBusy({ followUps: [f({})] }), true);
    assert.equal(keepsBusy({ followUps: [f({ started: true })] }), false);
    assert.equal(nextFollowUp({ followUps: [f({ started: true, messageId: 'a' }), f({ messageId: 'b' })] })?.messageId, 'b');
  });
  test('Codex 那一轮的用户消息 id 由 steer 的 id 推出来，控制入口的标记留着', () => {
    assert.equal(detachedTurnMessageId('steer_123_abc'), 'user_123_abc_turn');
    assert.equal(detachedTurnMessageId('steer_ctl_9_x'), 'user_ctl_9_x_turn');
  });
});

describe('只声明 promptQueueing：忙时再发一个 session/prompt，两个在途时输出和落盘的归属', () => {
  test('渲染端的路由：prompt-queue → handoff（不进 KiroLex 队列）；都没有 → queue', () => {
    assert.equal(busyEnterKind('claude', 'prompt-queue'), 'handoff');
    assert.equal(busyEnterKind('claude', 'steering'), 'steer');
    assert.equal(busyEnterKind('codex', 'queue'), 'queue');
    assert.equal(busyEnterKind(undefined, undefined), 'steer', 'kiro 不变');
  });

  test('前一轮的响应就是它的结束：之后流过来的归第二条；第二条在前一轮落盘之后才落盘；一条不丢不串', async () => {
    const h = harness('claude', QUEUEING_ONLY);
    assert.equal(h.c.supportsPromptQueueing, true);
    const t1 = h.turn('user_1', [{ type: 'text', text: 'first' }]);
    h.c.handleMessage(chunk('A'));
    let accepted: any;
    const t2 = h.turn('user_2', [{ type: 'text', text: 'second' }], { kind: 'queued', onAccepted: (r) => { accepted = r; } });
    assert.deepEqual(accepted, { accepted: true }, '发出去就回话，不等它那一轮');
    assert.deepEqual(h.sent.map((m) => m.method), ['session/prompt', 'session/prompt'], '真的再发了一个 session/prompt，交给 CLI 排');
    const [p1, p2] = h.sent;
    assert.deepEqual(p2.params, { sessionId: 'cli', prompt: [{ type: 'text', text: 'second' }] });
    h.c.handleMessage(chunk('B'));                       // 第一条还在途：归第一条
    // 同一批数据里：第一条的响应紧跟着第二条的第一块输出（处理是同步的，响应的 then 还没跑）
    h.c.handleMessage({ jsonrpc: '2.0', id: p1.id, result: { stopReason: 'end_turn' } });
    h.c.handleMessage(chunk('C'));
    await t1;
    assert.equal(h.entry.busy, true, '交棒：busy 不放开，KiroLex 队列 / 定时不会趁空档插进来');
    h.c.handleMessage(chunk('D'));
    h.c.handleMessage({ jsonrpc: '2.0', id: p2.id, result: { stopReason: 'end_turn' } });
    await t2;
    assert.deepEqual(h.transcript, [
      { role: 'user', id: 'user_1' },
      { role: 'assistant', replyTo: 'user_1', text: 'AB' },
      { role: 'user', id: 'user_2' },
      { role: 'assistant', replyTo: 'user_2', text: 'CD' },
    ]);
    assert.equal(h.entry.busy, false);
    assert.equal(h.entry.followUps, undefined);
  });

  test('排了两条：一条接一条交棒', async () => {
    const h = harness('claude', QUEUEING_ONLY);
    const t1 = h.turn('user_1', []);
    const t2 = h.turn('user_2', [], { kind: 'queued', onAccepted() {} });
    const t3 = h.turn('user_3', [], { kind: 'queued', onAccepted() {} });
    const [p1, p2, p3] = h.sent;
    h.c.handleMessage({ jsonrpc: '2.0', id: p1.id, result: { stopReason: 'end_turn' } });
    h.c.handleMessage(chunk('two'));
    h.c.handleMessage({ jsonrpc: '2.0', id: p2.id, result: { stopReason: 'end_turn' } });
    h.c.handleMessage(chunk('three'));
    h.c.handleMessage({ jsonrpc: '2.0', id: p3.id, result: { stopReason: 'end_turn' } });
    await Promise.all([t1, t2, t3]);
    assert.deepEqual(h.transcript.filter((m) => m.role === 'assistant').map((m) => [m.replyTo, m.text]), [['user_1', ''], ['user_2', 'two'], ['user_3', 'three']]);
    assert.equal(h.entry.busy, false);
  });

  test('还没轮到它就失败了（执行器没了）→ 带 handoffNotStarted 拒绝：没落盘，调用方放回 KiroLex 队列', async () => {
    const h = harness('claude', QUEUEING_ONLY);
    const t1 = h.turn('user_1', []);
    const t2 = h.turn('user_2', [], { kind: 'queued', onAccepted() {} });
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[1].id, error: { code: -32603, message: 'boom' } });
    await assert.rejects(t2, (err: any) => err.handoffNotStarted === true);
    assert.equal(h.entry.followUps, undefined);
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[0].id, result: { stopReason: 'end_turn' } });
    await t1;
    assert.equal(h.entry.busy, false, '没人排着了：照常放开');
    assert.deepEqual(h.transcript.map((m) => m.id || m.replyTo), ['user_1', 'user_1'], '第二条没进记录');
  });

  test('点了停止：Claude Code 把排着的一起取消 —— 第二条照样按顺序接手、以 cancelled 收尾（消息在记录里，不重发）', async () => {
    const h = harness('claude', QUEUEING_ONLY);
    const t1 = h.turn('user_1', []);
    const t2 = h.turn('user_2', [], { kind: 'queued', onAccepted() {} });
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[0].id, result: { stopReason: 'cancelled' } });
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[1].id, result: { stopReason: 'cancelled' } });
    assert.equal((await t2).stopReason, 'cancelled');
    await t1;
    assert.equal(h.sent.length, 2);
    assert.equal(h.entry.busy, false);
  });
});

describe('steering 出错 + 声明了 promptQueueing → 走「交给 CLI 排」那条，不退回 KiroLex 队列', () => {
  test('-32601 → handoff，接着同一条消息作为第二个 session/prompt 发出、按顺序接手', async () => {
    const h = harness('claude', CLAUDE_INIT);
    const t1 = h.turn('user_1', []);
    const steer = h.c.steering('cli', '补一句');
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[1].id, error: { code: -32601, message: 'Method not found' } });
    const res = await steer;
    assert.equal(steerFailureRoute(res.reason), 'handoff');
    // 渲染端拿到 handoff → acp:handoff-prompt → sendPromptOnce 的 queued 模式
    const t2 = h.turn('user_2', [{ type: 'text', text: '补一句' }], { kind: 'queued', onAccepted() {} });
    assert.deepEqual(h.sent.map((m) => m.method), ['session/prompt', '_session/steering', 'session/prompt']);
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[0].id, result: { stopReason: 'end_turn' } });
    h.c.handleMessage(chunk('ok'));
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[2].id, result: { stopReason: 'end_turn' } });
    await Promise.all([t1, t2]);
    assert.deepEqual(h.transcript.at(-1), { role: 'assistant', replyTo: 'user_2', text: 'ok' });
  });
});

describe('Codex：steering 碰上这一轮刚结束 → 它自己起的那一轮认成这条消息的一轮', () => {
  test('一轮还在跑：injected，插进当前这一轮（不另起）', async () => {
    const h = harness('codex', CODEX_INIT);
    assert.equal(h.c.busyEnter, 'steering');
    const t1 = h.turn('user_1', []);
    h.entry.steeringInFlight = 1;
    const steer = h.c.steering('cli', 'PINEAPPLE');
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[1].id, result: { outcome: 'injected' } });
    assert.equal((await steer).steered, true);
    h.entry.steeringInFlight = 0;
    h.c.handleMessage(chunk('…PINEAPPLE'));
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[0].id, result: { stopReason: 'end_turn' } });
    await t1;
    assert.deepEqual(h.transcript, [{ role: 'user', id: 'user_1' }, { role: 'assistant', replyTo: 'user_1', text: '…PINEAPPLE' }]);
    assert.equal(h.entry.busy, false);
  });

  test('startedNewTurn：前一轮收尾时 busy 留着（steering 在途），那一轮的输出先攒着，登记好后归它；Codex 报 idle 就收尾', async () => {
    const h = harness('codex', CODEX_INIT);
    const t1 = h.turn('user_1', []);
    h.c.handleMessage(chunk('one'));
    // acp:steer：在途计数 +1，再发 steering
    h.entry.steeringInFlight = 1;
    const steer = h.c.steering('cli', 'PINEAPPLE');
    // Codex：前一轮先完（它的 idle、它的响应），再起新的一轮（active + 输出），最后才回 steering 的结果
    h.c.handleMessage(threadStatus('idle'));
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[0].id, result: { stopReason: 'end_turn' } });
    await t1;
    assert.equal(h.entry.busy, true, '在等 steering 的结果：busy 不放（不然新一轮的输出会被当成一轮之外的回放丢掉）');
    assert.ok(h.entry.limbo, '进 limbo，没标 prompt 的输出先攒着');
    h.c.handleMessage(threadStatus('active'));
    h.c.handleMessage(chunk('X'));
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[1].id, result: { outcome: 'startedNewTurn' } });
    const res = await steer;
    assert.equal(res.reason, 'handed-off');
    assert.equal(steerFailureRoute(res.reason), 'handed-off', '渲染端不再发：消息已经在 Codex 手里');
    // acp:steer 的 handed-off 分支：limbo 接着攒，按 detached 跑一轮；登记好之后在途计数才 -1
    h.entry.limbo ||= { held: [] };
    let settled = false;
    const t2 = h.turn(detachedTurnMessageId('steer_1_a'), [{ type: 'text', text: 'PINEAPPLE' }], {
      kind: 'detached', held: [], onEnlisted: () => { settled = true; h.entry.steeringInFlight = 0; },
    });
    await tick();
    assert.equal(settled, true);
    h.c.handleMessage(chunk('Y'));
    h.c.handleMessage(threadStatus('idle'));
    await t2;
    assert.deepEqual(h.transcript, [
      { role: 'user', id: 'user_1' },
      { role: 'assistant', replyTo: 'user_1', text: 'one' },
      { role: 'user', id: 'user_1_a_turn' },
      { role: 'assistant', replyTo: 'user_1_a_turn', text: 'XY' },
    ]);
    assert.equal(h.entry.busy, false);
    assert.equal(h.entry.limbo, undefined);
    assert.equal(h.sent.filter((m) => m.method === 'session/prompt').length, 1, '那条消息没有再发一遍');
  });

  test('steering 回来不是 startedNewTurn（前一轮已经收完在等）→ 放开 busy，攒着的照常处理', async () => {
    const h = harness('codex', CODEX_INIT);
    const t1 = h.turn('user_1', []);
    h.entry.steeringInFlight = 1;
    const steer = h.c.steering('cli', 'x');
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[0].id, result: { stopReason: 'end_turn' } });
    await t1;
    assert.equal(h.entry.busy, true);
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[1].id, error: { code: -32603, message: 'boom' } });
    assert.equal((await steer).reason, 'unsupported');
    h.entry.steeringInFlight = 0;
    // acp:steer：前一轮在等这个结果才肯交棒 → handOverTurn
    handOverTurn(h.entry, { isCurrent: () => true, emitBusy() {}, notConnected: () => new Error('nc') });
    assert.equal(h.entry.busy, false);
    assert.equal(h.entry.limbo, undefined);
  });
});

describe('index.ts 的接线（和上面 harness 的顺序一致）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const fnBody = (name: string, len = 120000) => { const at = M.indexOf(name); assert.ok(at > 0, name); return M.slice(at, at + len); };

  test('wireSession：先问 holdTarget，攒着的经 replayUpdates 交给同一个处理函数', () => {
    assert.match(M, /client\.on\('update', onUpdate = \(data: any, replayed\?: boolean\) => \{\n\s*if \(superseded\(\)\) return;\n\s*if \(!replayed\) \{\n\s*const hold = holdTarget\(entry, data, client\.promptInFlight\);\n\s*if \(hold\) \{ hold\.held\.push\(data\); return; \}\n\s*\}/);
    assert.match(M, /entry\.replayUpdates = \(list\) => \{ for \(const d of list\) onUpdate\(d, true\); \};/);
    assert.ok(M.includes('if (detachedTurnEnded(data?.update)) { if (entry.detachedSeen) entry.detachedEnd(); }'));
  });

  test('sendPromptOnce：handoff 不被「正忙」拒绝、用户消息推迟到交棒时落盘、不带历史快照', () => {
    const body = fnBody('async function sendPromptOnce(');
    assert.match(body, /const handoff = attempt === 0 \? display\?\.handoff : undefined;/);
    assert.match(body, /if \(entry\.busy && !handoff\) \{/);
    assert.match(body, /const rideAlong = isFeatureEnabled\('rideAlongContext'\)[\s\S]{0,700}?&& !handoff;/);
    assert.match(body, /if \(!handoff\) persistUserMessage\(\);/);
    const enlist = body.indexOf('const enlisted = await enlistFollowUp(');
    const busyOn = body.indexOf('entry.busy = true; // in-flight turn');
    assert.ok(enlist > 0 && enlist < busyOn, '先登记（等交棒），再接 busy');
    assert.ok(body.slice(enlist, enlist + 600).includes('persistThenRelease(dir, userMessageId, persistUserMessage)'), '交棒时落盘用户消息（写上了才摘恢复记录）');
  });

  test('第一次等的是早就发出去的那个响应；先 live 再把攒着的交出去', () => {
    const body = fnBody('async function sendPromptOnce(');
    const pre = body.indexOf('const adoptPreResponse = async (pending: Promise<any>): Promise<any> => {');
    const live = body.indexOf('followUp.live = true;', pre);
    const replay = body.indexOf('ent.replayUpdates?.(held);', pre);
    const ret = body.indexOf('return pending;', pre);
    const use = body.indexOf('const result = pre ? await adoptPreResponse(pre) : await entry.client.sendPrompt(entry.cliSessionId, prompt);', pre);
    assert.ok(pre > 0 && pre < live && live < replay && replay < ret && ret < use);
  });

  test('收尾：有人排着就留 busy，最外层 finally 交棒；排着的时候不自己重发 / 换后端会话', () => {
    const body = fnBody('async function sendPromptOnce(');
    assert.match(body, /if \(keepsBusy\(e\)\) ownsHandOver = true;\n\s*else \{ e\.busy = false; e\.lastUsedAt = Date\.now\(\); \}/);
    assert.match(body, /if \(ownsHandOver\) handOverTurn\(sessionId, entry\);/);
    const noRetry = body.indexOf('if (ownsHandOver) throw err;');
    assert.ok(noRetry > 0 && noRetry < body.indexOf('const verdict = staleVerdict({'));
  });

  test('acp:steer：在途计数；startedNewTurn → 按 detached 跑一轮（用户消息作为新的一条，announce 给界面）', () => {
    const body = fnBody("ipcMain.handle('acp:steer'", 6000);
    assert.match(body, /entry\.steeringInFlight = \(entry\.steeringInFlight \|\| 0\) \+ 1;/);
    assert.match(body, /if \(res\.reason === 'handed-off'\) \{/);
    assert.match(body, /handoff: \{ kind: 'detached', held: \[\], onEnlisted: settle \},/);
    assert.match(body, /announce: true,/);
    assert.match(body, /if \(entry\.limbo && !entry\.turnRunning && !\(entry\.steeringInFlight \|\| 0\)\) handOverTurn\(sessionId, entry\);/);
  });

  test('acp:handoff-prompt：queued 模式，发出去就回话；没轮到就失败 → acp:handoff-failed（notStarted）', () => {
    const body = fnBody("ipcMain.handle('acp:handoff-prompt'", 3000);
    assert.match(body, /handoff: \{ kind: 'queued', onAccepted: answer \},/);
    assert.match(body, /mainWindow\?\.webContents\.send\('acp:handoff-failed', \{\n\s*sessionId, messageId: display\?\.messageId, notStarted,/);
  });
});

describe('渲染端的接线', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
  const APP = read('renderer', 'App.tsx');
  const ACP = read('renderer', 'hooks', 'useAcp.ts');
  const between = (src: string, from: string, to: string) => { const at = src.indexOf(from); assert.ok(at > 0, from); return src.slice(at, src.indexOf(to, at)); };
  const steer = between(APP, 'const handleSteerMessage = useCallback', 'const handleQueueMessage = useCallback');

  test('忙时 Enter：handoff 在发 steering 之前；steering 回 handoff / handed-off 各有去处', () => {
    const kind = steer.indexOf("if (enterKind === 'handoff') { await handOff(); return; }");
    assert.ok(kind > 0 && kind < steer.indexOf('await steerMessage('));
    assert.ok(steer.includes("if (route === 'handoff') { await handOff(); return; }"));
    assert.ok(steer.includes("if (route === 'handed-off') {"));
  });

  test('交不出去：这一轮已结束 → 普通发送；其余 → KiroLex 队列（不丢）', () => {
    const fn = between(steer, 'const handOff = async () =>', '\n    };');
    assert.ok(fn.includes("if (r.reason === 'idle') {"));
    assert.ok(fn.includes('await sendNowOrNext(sessionId, content, attachments,'));
    assert.ok(fn.trimEnd().endsWith('queueAsNext();'));
  });

  test('没轮到它就失败了（acp:handoff-failed notStarted）→ 放回 KiroLex 队列队头', () => {
    const fn = between(APP, 'window.kiroApi.onHandoffFailed?.((d) => {', '}), [dropHandoff]);');
    assert.ok(fn.includes('if (!d.notStarted) return;'));
    assert.ok(fn.includes('const list = requeueFailedHandoff(current[sid] || [], { ...d, messageId: handoffId }, card, newId);'));
  });

  test('接手的那一轮：窗口自己的上一轮还没收尾时，收尾那一下转成「接管」，流不断', () => {
    assert.ok(ACP.includes('} else if (handoff && !adoptedTurnsRef.current.has(sid)) {'));
    const rs = between(ACP, 'const removeStreaming = (sid: string | null) => {', 'setSessionActiveTool(sid, null);\n    // Same');
    /* 判据和事件先后的行为测试在 tests/handoffAdoption.test.ts */
    assert.ok(rs.includes("if (onOwnTurnEnd(adoptionRef.current, sid, streamingIdsRef.current.has(sid)) === 'keep-streaming') {"));
  });

  test('⌘/Ctrl+Enter 不变：仍进 KiroLex 自己的队列（handleQueueMessage 不碰 handoff）', () => {
    const q = between(APP, 'const handleQueueMessage = useCallback', '}, [');
    assert.ok(!q.includes('handOff'));
    assert.ok(!q.includes('handoffPrompt'));
  });
});

describe('Codex 实测的顺序：先回 startedNewTurn，再 active → 输出 → usage → idle', () => {
  test('那一轮的输出全归这条消息；它开始之前漏进来的 idle 不会把它提前收掉', async () => {
    const h = harness('codex', CODEX_INIT);
    const t1 = h.turn('user_1', []);
    h.entry.steeringInFlight = 1;
    const steer = h.c.steering('cli', 'PINEAPPLE');
    h.c.handleMessage(threadStatus('idle'));            // 前一轮自己的 idle（它的响应之前，照常处理）
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[0].id, result: { stopReason: 'end_turn' } });
    await t1;
    h.c.handleMessage(threadStatus('idle'));            // 万一又来一个（在 limbo 里攒着）
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[1].id, result: { outcome: 'startedNewTurn' } });
    assert.equal((await steer).reason, 'handed-off');
    h.entry.limbo ||= { held: [] };
    const t2 = h.turn('user_9_turn', [], { kind: 'detached', held: [], onEnlisted: () => { h.entry.steeringInFlight = 0; } });
    await tick();
    assert.equal(h.entry.busy, true, '那个提前的 idle 没把它收掉');
    h.c.handleMessage(threadStatus('active'));
    h.c.handleMessage(chunk('ok PINEAPPLE'));
    h.c.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cli', update: { sessionUpdate: 'usage_update', used: 1, size: 2 } } });
    h.c.handleMessage(threadStatus('idle'));
    await t2;
    assert.deepEqual(h.transcript.slice(2), [{ role: 'user', id: 'user_9_turn' }, { role: 'assistant', replyTo: 'user_9_turn', text: 'ok PINEAPPLE' }]);
    assert.equal(h.entry.busy, false);
  });
});

describe('回归：旧 prompt 的响应和新一轮的输出在同一次管道读取里连着到（中间不 await）', () => {
  test('steering 在途：响应之后紧跟着的输出不进前一轮的缓冲，攒给适配器自己起的那一轮', async () => {
    const h = harness('codex', CODEX_INIT);
    const t1 = h.turn('user_1', []);
    h.c.handleMessage(chunk('OLD'));
    h.entry.steeringInFlight = 1;
    const steer = h.c.steering('cli', 'PINEAPPLE');
    // 同一次读取：响应 + 新一轮的输出，同步连着处理（主进程那一轮的异步收尾还没跑）
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[0].id, result: { stopReason: 'end_turn' } });
    h.c.handleMessage(threadStatus('active'));
    h.c.handleMessage(chunk('NEW'));
    assert.equal(h.entry.limbo?.held.length, 2, '同步就攒起来了');
    await t1;
    assert.deepEqual(h.transcript, [{ role: 'user', id: 'user_1' }, { role: 'assistant', replyTo: 'user_1', text: 'OLD' }], '前一轮只有它自己的输出');
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[1].id, result: { outcome: 'startedNewTurn' } });
    assert.equal((await steer).reason, 'handed-off');
    const t2 = h.turn('user_7_turn', [], { kind: 'detached', held: [], onEnlisted: () => { h.entry.steeringInFlight = 0; } });
    await tick();
    h.c.handleMessage(threadStatus('idle'));
    await t2;
    assert.deepEqual(h.transcript.at(-1), { role: 'assistant', replyTo: 'user_7_turn', text: 'NEW' });
    assert.equal(h.entry.busy, false);
  });

  test('steering 回来不是「自己起了一轮」、而前一轮还没收尾：limbo 在前一轮收尾时原样交还（不卡住、不丢）', async () => {
    const h = harness('claude', CLAUDE_INIT);
    const t1 = h.turn('user_1', []);
    h.entry.steeringInFlight = 1;
    const steer = h.c.steering('cli', 'x');
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[0].id, result: { stopReason: 'end_turn' } });
    h.c.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cli', update: { sessionUpdate: 'usage_update', used: 1, size: 2 } } });
    h.c.handleMessage({ jsonrpc: '2.0', id: h.sent[1].id, result: { outcome: 'promptRequired', reason: 'noRunningTurn' } });
    h.entry.steeringInFlight = 0;
    assert.equal((await steer).reason, 'idle');
    await t1;
    assert.equal(h.entry.limbo, undefined, '交还了');
    assert.equal(h.entry.busy, false);
  });
});
