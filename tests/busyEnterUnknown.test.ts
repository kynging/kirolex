import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { busyEnterMode, busyEnterLogLine, isMethodNotFound, steeringDegradedLogLine, steeringFailureLogLine } from '../src/main/busyEnterCaps.ts';
import { AcpClient } from '../src/main/acp-client.ts';
import { busyEnterKind, busyEnterLogMode, cacheableBusyEnter, engineCanSteer, steerFailureRoute } from '../src/renderer/steerRoute.ts';

/**
 * 「现在 Claude Code 只能 queue 了」：执行器的 initialize 结果还没存好时 busyEnter 算成 'queue'（和「不支持」一样），
 * 渲染端把它缓存住，之后忙时 Enter 一直进 KiroLex 队列，日志里一个字没有。
 * 现在：能力未知 = 'unknown'，渲染端不缓存、现问；挂上执行器必推一次；只有 -32601 才降级，换后端会话 / 重连清零；每次忙时 Enter 记一行。
 */

/** claude-agent-acp 0.94.0 initialize 响应里和这里有关的字段（远端 tokyo-graviton 实测） */
const CLAUDE_INIT = {
  protocolVersion: 1,
  agentCapabilities: { _meta: { claudeCode: { promptQueueing: true } }, loadSession: true },
  agentInfo: { name: '@agentclientprotocol/claude-agent-acp', version: '0.94.0' },
  _meta: { steering: { supported: true } },
};

function fakeClient(engine: 'kiro' | 'claude' | 'codex', init?: any) {
  const c: any = new AcpClient('m', {}, undefined, 'ask', undefined, undefined, engine);
  const sent: any[] = [];
  c.send = (msg: any) => { sent.push(msg); };
  c.process = { stdin: { writable: true } };
  c.refreshHanded = async () => {};
  c.initializeResult = init;
  return { c, sent };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('能力未知 ≠ 不支持', () => {
  test('initialize 还没到 → unknown（不是 queue）；到了 → steering', () => {
    assert.equal(busyEnterMode('claude', undefined), 'unknown');
    assert.equal(busyEnterMode('codex', null), 'unknown');
    assert.equal(busyEnterMode('claude', CLAUDE_INIT), 'steering');
    assert.equal(busyEnterMode('kiro', undefined), 'steer', 'kiro 不看 initialize');
    const { c } = fakeClient('claude');
    assert.equal(c.busyEnter, 'unknown');
    assert.equal(c.supportsSteer, false, '主进程那一刻真插不进去：acp:steer 回 unsupported → KiroLex 队列，不标红');
    c.initializeResult = CLAUDE_INIT;
    assert.equal(c.busyEnter, 'steering');
  });
  test('渲染端只缓存明确的能力：unknown / 空值不缓存', () => {
    assert.equal(cacheableBusyEnter('unknown'), undefined);
    assert.equal(cacheableBusyEnter(undefined), undefined);
    assert.equal(cacheableBusyEnter(''), undefined);
    assert.equal(cacheableBusyEnter('bogus'), undefined);
    for (const m of ['steer', 'steering', 'prompt-queue', 'queue']) assert.equal(cacheableBusyEnter(m), m);
  });
  test('现问过一次仍是 unknown → 先试 steer，由主进程按那一刻的能力决定；不是直接进 KiroLex 队列', () => {
    assert.equal(busyEnterKind('claude', 'unknown'), 'steer');
    assert.equal(busyEnterKind('claude', 'steering'), 'steer');
    assert.equal(busyEnterKind('claude', 'queue'), 'queue');
    assert.equal(busyEnterKind('codex', undefined), 'queue', '问不到（没连着）：照旧按引擎兜底');
    assert.equal(steerFailureRoute('unsupported'), 'queue', '主进程那边也还未知：排队，不标红');
    assert.equal(engineCanSteer('claude', 'unknown'), false, '输入框文案按引擎兜底');
    assert.equal(engineCanSteer(undefined, 'unknown'), true);
  });
  test('日志里的 mode：缓存着的明确能力，没有时 kiro=steer、另外两家=unknown', () => {
    assert.equal(busyEnterLogMode('claude', 'steering'), 'steering');
    assert.equal(busyEnterLogMode('claude', undefined), 'unknown');
    assert.equal(busyEnterLogMode('claude', 'unknown'), 'unknown');
    assert.equal(busyEnterLogMode(undefined, undefined), 'steer');
  });
});

describe('steering 降级：只认 -32601，新执行器 / 换后端会话清零', () => {
  test('-32601 → 降级到 prompt-queue，结果带 code 和 degraded', async () => {
    const { c, sent } = fakeClient('claude', CLAUDE_INIT);
    const p = c.steering('cli-1', 'hi');
    c.handleMessage({ jsonrpc: '2.0', id: sent[0].id, error: { code: -32601, message: 'Method not found' } });
    const res = await p;
    assert.equal(res.reason, 'handoff');
    assert.equal(res.code, -32601);
    assert.equal(res.degraded, true);
    assert.equal(c.busyEnter, 'prompt-queue');
    /* 已经降级了，再来一次 -32601 不再算「刚降级」（不重复记那一行） */
    const p2 = c.steering('cli-1', 'hi');
    c.handleMessage({ jsonrpc: '2.0', id: sent[1].id, error: { code: -32601, message: 'Method not found' } });
    assert.equal((await p2).degraded, undefined);
  });
  test('别的错误不降级：-32603、消息里写着 method not found 但不是 -32601、没有 code 的（超时）', async () => {
    for (const error of [{ code: -32603, message: 'Internal error' }, { code: -32000, message: 'Method not found: tool x' }]) {
      const { c, sent } = fakeClient('claude', CLAUDE_INIT);
      const p = c.steering('cli-1', 'hi');
      c.handleMessage({ jsonrpc: '2.0', id: sent[0].id, error });
      const res = await p;
      assert.equal(res.code, error.code);
      assert.equal(res.degraded, undefined);
      assert.equal(c.busyEnter, 'steering', `${error.code} 不降级`);
    }
    assert.equal(isMethodNotFound(new Error('Request _session/steering timed out')), false);
    assert.equal(isMethodNotFound({ message: 'Method not found' }), false, '只认明确的 code');
    assert.equal(isMethodNotFound({ code: -32601 }), true);
  });
  test('outcome 不认识 → 结果带 outcome，不降级', async () => {
    const { c, sent } = fakeClient('claude', CLAUDE_INIT);
    const p = c.steering('cli-1', 'hi');
    c.handleMessage({ jsonrpc: '2.0', id: sent[0].id, result: { outcome: 'failed' } });
    const res = await p;
    assert.equal(res.outcome, 'failed');
    assert.equal(res.code, undefined);
    assert.equal(c.busyEnter, 'steering');
  });
  test('新执行器不带旧执行器的降级', async () => {
    const old = fakeClient('claude', CLAUDE_INIT);
    const p = old.c.steering('cli-1', 'hi');
    old.c.handleMessage({ jsonrpc: '2.0', id: old.sent[0].id, error: { code: -32601, message: 'Method not found' } });
    await p;
    assert.equal(old.c.busyEnter, 'prompt-queue');
    assert.equal(fakeClient('claude', CLAUDE_INIT).c.busyEnter, 'steering');
  });
  for (const method of ['loadSession', 'newSession'] as const) {
    test(`同一个执行器换后端会话（${method}）→ 降级清零，重新按能力声明判断`, async () => {
      const { c, sent } = fakeClient('claude', CLAUDE_INIT);
      const p = c.steering('cli-1', 'hi');
      c.handleMessage({ jsonrpc: '2.0', id: sent[0].id, error: { code: -32601, message: 'Method not found' } });
      await p;
      assert.equal(c.busyEnter, 'prompt-queue');
      const q = method === 'loadSession' ? c.loadSession('cli-2', '/w') : c.newSession('/w');
      await tick();
      const req = sent[sent.length - 1];
      assert.equal(req.method, method === 'loadSession' ? 'session/load' : 'session/new');
      c.handleMessage({ jsonrpc: '2.0', id: req.id, result: { sessionId: 'cli-2' } });
      await q;
      assert.equal(c.busyEnter, 'steering');
    });
  }
});

describe('日志行', () => {
  test('忙时 Enter：[prompt] busy-enter sessionId=… engine=… mode=… route=… reason=…', () => {
    assert.equal(
      busyEnterLogLine({ sessionId: 's_1', engine: 'claude', mode: 'steering', route: 'steered', reason: 'caps-steering' }),
      'busy-enter sessionId=s_1 engine=claude mode=steering route=steered reason=caps-steering',
    );
    assert.equal(busyEnterLogLine({ sessionId: 's_1', route: 'kirolex-queue' }), 'busy-enter sessionId=s_1 engine=kiro mode=unknown route=kirolex-queue reason=-');
    assert.doesNotMatch(busyEnterLogLine({ sessionId: 's_1\n2026 [info] [x] fake', route: 'steered' }), /\n/, '渲染端报上来的值拼不出假日志行');
  });
  test('steering 失败 / 降级各一行，带错误码 / outcome', () => {
    assert.match(steeringFailureLogLine('s_1', { reason: 'handoff', code: -32603, detail: 'Internal error' }), /^steering failed sessionId=s_1 code=-32603 outcome=- fallback=handoff detail=Internal error$/);
    assert.match(steeringFailureLogLine('s_1', { reason: 'unsupported', outcome: 'failed' }), /code=- outcome=failed fallback=unsupported/);
    assert.match(steeringDegradedLogLine('s_1', 'claude', -32601, 'prompt-queue'), /^steering degraded sessionId=s_1 engine=claude code=-32601 busyEnter=prompt-queue/);
  });
});

describe('接线（源码）', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
  const INDEX = read('main', 'index.ts');
  const APP = read('renderer', 'App.tsx');
  const CLIENT = read('main', 'acp-client.ts');
  const PRELOAD = read('main', 'preload.ts');
  const between = (src: string, from: string, to: string) => {
    const at = src.indexOf(from);
    assert.ok(at >= 0, `找不到 ${from}`);
    const end = src.indexOf(to, at + from.length);
    assert.ok(end > at, `找不到 ${to}`);
    return src.slice(at, end);
  };
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('挂上执行器（wireSession：attach / 重连 / 换后端会话 / 换模型换机器都经过它）就推一次 session:engine-models', () => {
    const wire = code(between(INDEX, 'function wireSession(sessionId: string, entry: SessionEntry) {', '\n}\n'));
    assert.match(wire, /if \(!superseded\(\)\) pushEngineModels\(sessionId\);\s*$/, 'wireSession 最后一件事：所有监听都接好之后推');
    assert.match(code(between(INDEX, 'function pushEngineModels(sessionId: string): boolean {', '\n}')), /session:engine-models', engineModelsPayload\(sessionId, entry\)/);
    assert.match(code(between(INDEX, 'function engineModelsPayload(', '\n}')), /busyEnter: entry\.client\.busyEnter,/);
    /* 每条挂执行器的路都是先 connect（initialize）、再 wireSession */
    const wires = INDEX.split('wireSession(').length - 2;   // 减掉定义本身
    assert.ok(wires >= 8, `wireSession 调用点 ${wires}`);
    /* 断线自动恢复接回来也推 */
    assert.match(code(between(INDEX, 'recovered: (sessionId) => {', '},')), /pushEngineModels\(sessionId\);/);
  });
  test('窗口刷新：渲染端挂好监听后握手，主进程给每条连着的会话推一次 session:engine-models', () => {
    const block = code(between(APP, 'const busyEnterRef = useRef<Record<string, string>>({});', 'const busyEnterFor = useCallback'));
    const subscribed = block.indexOf('const off = window.kiroApi.onEngineModels?.(');
    const ready = block.indexOf('window.kiroApi.engineModelsReady?.();');
    assert.ok(subscribed > 0 && ready > subscribed, '先挂监听，再握手');
    assert.match(block, /return off;/);
    assert.match(PRELOAD, /engineModelsReady: \(\) => ipcRenderer\.send\('acp:engine-models-ready'\)/);
    const handler = code(between(INDEX, "ipcMain.on('acp:engine-models-ready'", '\n  });'));
    assert.match(handler, /for \(const sessionId of sessionClients\.keys\(\)\) if \(pushEngineModels\(sessionId\)\) pushed\+\+;/);
    assert.doesNotMatch(code(between(INDEX, "mainWindow.webContents.on('did-finish-load'", '\n')), /engine-models/, '不在 did-finish-load 推（监听可能还没挂上）');
  });
  test('AcpClient：initialize / session/load / session/new 之后清掉 steering 降级', () => {
    assert.match(code(between(CLIENT, 'this.initializeResult = result;', 'resolve(result);')), /this\.resetSteering\(\);/);
    assert.match(code(between(CLIENT, 'async loadSession(sessionId: string, cwd: string)', 'return r;')), /this\.resetSteering\(\);/);
    assert.match(code(between(CLIENT, 'async newSession(cwd: string)', 'return r;')), /this\.resetSteering\(\);/);
  });
  test('acp:steer 记 steering 失败 / 降级', () => {
    const steer = code(between(INDEX, "ipcMain.handle('acp:steer'", "ipcMain.handle('acp:persist-steer'"));
    assert.match(steer, /logger\.warn\('prompt', steeringFailureLogLine\(sessionId, res\)\)/);
    assert.match(steer, /if \(res\.degraded\) logger\.warn\('prompt', steeringDegradedLogLine\(/);
  });
  test('忙时 Enter 每条路都记那一行', () => {
    assert.match(INDEX, /ipcMain\.on\('acp:busy-enter-log', \(_event, d[^)]*\) => \{\s*logger\.info\('prompt', busyEnterLogLine\(d \|\| \{\}\)\);/);
    assert.match(PRELOAD, /logBusyEnter: \(d[^)]*\) => ipcRenderer\.send\('acp:busy-enter-log', d\)/);
    const steer = code(between(APP, 'const handleSteerMessage = useCallback', 'const handleQueueMessage = useCallback'));
    assert.match(steer, /window\.kiroApi\.logBusyEnter\?\.\(\{ sessionId, engine: engine \|\| 'kiro', mode: busyEnterLogMode\(engine, busyEnterRef\.current\[sessionId\]\), route, reason: busyReason \}\)/);
    assert.match(between(steer, 'const queueAsNext = () => {', '\n    };'), /logBusyEnter\('kirolex-queue'\);/);
    assert.match(between(steer, 'const parkUntilRebuilt = () => {', '\n    };'), /logBusyEnter\('after-rebuild'\);/);
    assert.match(between(steer, 'const handOff = async () => {', '\n    };'), /if \(r\.accepted\) \{ logBusyEnter\('handoff'\);/);
    assert.match(steer, /if \(res\.steered\) \{ logBusyEnter\('steered'\);/);
    assert.match(steer, /logBusyEnter\('failed'\);\s*const failedId = addFailedSteer\(/);
  });
  test('渲染端：推过来的和现问到的都过 cacheableBusyEnter；推过来的 unknown 清掉旧值', () => {
    const block = code(between(APP, 'const busyEnterRef = useRef<Record<string, string>>({});', 'const [handoffsBySession'));
    assert.match(block, /const v = cacheableBusyEnter\(d\.busyEnter\);\s*if \(v\) busyEnterRef\.current\[d\.sessionId\] = v;\s*else if \(d\.busyEnter === 'unknown'\) delete busyEnterRef\.current\[d\.sessionId\];/);
    assert.match(block, /const v = cacheableBusyEnter\(d\?\.busyEnter\);\s*if \(v\) busyEnterRef\.current\[sid\] = v;/);
    assert.doesNotMatch(block, /busyEnterRef\.current\[[^\]]+\] = d\??\.busyEnter/, '不直接缓存主进程给的原值');
  });
});
