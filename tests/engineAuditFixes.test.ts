import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { contextMarkerHolds, isAuthRequiredError, adapterAuthMessage, adapterMissingMessage } from '../src/main/engines.ts';
import { staleVerdict } from '../src/main/staleSession.ts';
import { AcpClient } from '../src/main/acp-client.ts';

/**
 * Claude Code / Codex 运行模式审计（docs/engine-audit-claude-codex.md）里**已修**的那几条。
 * 每条对应文档里的一个编号；守的是「kiro-cli 的假设不能原样套在两个适配器上」，同时 kiro 的行为一点不变。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf-8');
const M = read('src', 'main', 'index.ts');
const AC = read('src', 'main', 'acp-client.ts');

/** 从 `anchor` 起截一段源码（找不到就让测试直接失败，别静默变成永远通过） */
function slice(src: string, anchor: string, len = 2500): string {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `找不到锚点：${anchor}`);
  return src.slice(at, at + len);
}

/** 不真起进程：把 send 换成收集器，用 handleMessage 喂消息 */
function fakeClient(engine: 'kiro' | 'claude' | 'codex', permissionMode: 'ask' | 'auto-approve' = 'ask') {
  const c: any = new AcpClient('m', {}, undefined, permissionMode, undefined, undefined, engine);
  const sent: any[] = [];
  c.send = (msg: any) => { sent.push(msg); };
  return { c, sent };
}

describe('A1 换新后端会话后把会话记着的模型 / effort / 模式设回去', () => {
  test('recreateBackendSession 在 newSession 之后对非 kiro 调 applyEngineModel 并等它落定', () => {
    const body = slice(M, 'async function recreateBackendSession(', 1800);
    const made = body.indexOf('await entry.client.newSession(cwd)');
    const apply = body.indexOf('applyEngineModel(sessionId, entry)');
    assert.ok(made > 0 && apply > made, '新的后端会话建好之后要重新设选项');
    assert.match(body, /engineOf\(entry\.profile\) !== 'kiro'/, 'kiro 不走这条（applyEngineModel 对 kiro 本来就是空操作，这里也明确只给另外两家）');
    assert.match(body, /await entry\.engineOptionsReady/, '要等设完再让调用方重发，否则重发那一轮跑在默认模式上');
  });
});

describe('A2 kiro 的「换模型重发」不能作用在 Claude Code / Codex 上', () => {
  test('swapSessionModel 对非 kiro 直接返回 null（不拿 kiro 的回退链去重起适配器）', () => {
    const body = slice(M, 'async function swapSessionModel(', 400);
    assert.match(body, /if \(!entry \|\| engineOf\(entry\.profile\) !== 'kiro'\) return null;/);
  });
  test('prompt 路上两处换模型的条件都先判引擎（不记 model_swap 事件、不动计数）', () => {
    const block = slice(M, 'const producedThisTurn = !!entry.assistantBuf', 4000);
    assert.match(block, /if \(engineOf\(entry\.profile\) === 'kiro' && isBareInternalError\(text\) && bareStreak >= POISONED_AFTER/);
    assert.match(block, /if \(engineOf\(entry\.profile\) === 'kiro' && isModelUnavailableError\(text\) && modelSwaps < MAX_MODEL_SWAPS\)/);
  });
});

describe('A3 一次笼统 Internal error 不能因为 pid 变了就扔掉适配器里真实存在的会话', () => {
  const base = { error: 'Internal error', contextPid: 54799, clientPid: 18444, alreadyRetried: false };
  test('kiro：pid 不一致照旧重建（行为不变）', () => {
    assert.equal(staleVerdict(base), 'recreate');
    assert.equal(staleVerdict({ ...base, persistentBackend: false }), 'recreate');
  });
  test('Claude Code / Codex：会话存在适配器那边，换进程不等于上下文没了 → 只报错', () => {
    assert.equal(staleVerdict({ ...base, persistentBackend: true }), 'report');
  });
  test('连着坏两次（毒了）对哪个引擎都照样换', () => {
    assert.equal(staleVerdict({ ...base, persistentBackend: true, consecutiveFailures: 2 }), 'recreate');
  });
  test('index.ts 把引擎传进去', () => {
    const call = slice(M, 'const verdict = staleVerdict({', 400);
    assert.match(call, /persistentBackend: backendPersistsSessions\(engineOf\(entry\.profile\)\)/);
  });
});

describe('A4 「上下文已在后端」标记：kiro 绑进程，适配器只认会话 id', () => {
  test('纯判据', () => {
    const marker = { for: 'cli-1', pid: 100 };
    /* kiro：同 id 同进程才算（kiro-cli 不持久化 ACP 会话） */
    assert.equal(contextMarkerHolds('kiro', marker, { cliSessionId: 'cli-1', pid: 100 }), true);
    assert.equal(contextMarkerHolds('kiro', marker, { cliSessionId: 'cli-1', pid: 200 }), false);
    /* 适配器：session/load 接回的是同一段对话，新进程照样有上下文 */
    assert.equal(contextMarkerHolds('claude', marker, { cliSessionId: 'cli-1', pid: 200 }), true);
    assert.equal(contextMarkerHolds('codex', marker, { cliSessionId: 'cli-1', pid: undefined }), true);
    /* 后端会话换了 id（新建 / resume 失败）谁都不算 */
    assert.equal(contextMarkerHolds('claude', marker, { cliSessionId: 'cli-2', pid: 100 }), false);
    assert.equal(contextMarkerHolds('kiro', {}, { cliSessionId: 'cli-1', pid: 100 }), false);
    assert.equal(contextMarkerHolds('claude', {}, { cliSessionId: 'cli-1', pid: 100 }), false);
  });
  test('发送前的判据和 attach 时的判据都走它', () => {
    const fn = slice(M, 'function contextEstablished(sessionId: string, entry: SessionEntry): boolean {', 500);
    assert.match(fn, /contextMarkerHolds\(engineOf\(entry\.profile\)/);
    const attach = slice(M, 'const establishedFor = existing?.contextEstablishedFor;', 500);
    assert.match(attach, /!contextMarkerHolds\(engineOf\(profile\)/);
  });
});

describe('A5 适配器自己推来的配置变更（config_option_update / current_mode_update）', () => {
  const opts = [
    { id: 'mode', category: 'mode', currentValue: 'plan', options: [{ value: 'plan', name: 'Plan' }, { value: 'default', name: 'Default' }] },
    { id: 'model', category: 'model', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }] },
  ];
  test('config_option_update 整份替换清单，并发 config-options 事件', () => {
    const { c } = fakeClient('claude');
    c.noteConfigOptions(opts);
    let fired = 0;
    c.on('config-options', () => { fired++; });
    c.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: {
      sessionUpdate: 'config_option_update', configOptions: [{ ...opts[0] }, { ...opts[1], currentValue: 'sonnet' }],
    } } });
    assert.equal(c.modelOptions.current, 'sonnet');
    assert.equal(fired, 1);
  });
  test('current_mode_update 改 mode 那一项的当前值', () => {
    const { c } = fakeClient('claude');
    c.noteConfigOptions(opts);
    let fired = 0;
    c.on('config-options', () => { fired++; });
    c.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' } } });
    assert.equal(c.selectOptions('mode').current, 'default');
    assert.equal(fired, 1);
    /* 原来那份对象没被原地改（别的地方可能还拿着引用） */
    assert.equal(opts[0].currentValue, 'plan');
  });
  test('wireSession 收到后把下拉推给界面', () => {
    const w = slice(M, 'function wireSession(sessionId: string, entry: SessionEntry) {', 6000);
    assert.match(w, /client\.on\('config-options', \(\) => \{[\s\S]{0,200}session:engine-models/);
  });
});

describe('A6 停止时按 ACP 规定回答挂着的权限请求（cancelled）', () => {
  const ask = (c: any, id: number) => c.handleMessage({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
    sessionId: 's', toolCall: { toolCallId: 't' }, options: [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }],
  } });
  test('Claude Code / Codex：cancelPrompt 发 session/cancel，并把每个挂着的请求答成 cancelled', async () => {
    for (const engine of ['claude', 'codex'] as const) {
      const { c, sent } = fakeClient(engine);
      ask(c, 7);
      assert.equal(c.awaitingPermission, true);
      await c.cancelPrompt('s');
      assert.ok(sent.some((m) => m.method === 'session/cancel'));
      const answer = sent.find((m) => m.id === 7);
      assert.deepEqual(answer?.result, { outcome: { outcome: 'cancelled' } });
      assert.equal(c.awaitingPermission, false);
    }
  });
  test('kiro：行为不变（只发 session/cancel）', async () => {
    const { c, sent } = fakeClient('kiro', 'ask');
    ask(c, 7);
    await c.cancelPrompt('s');
    assert.ok(sent.some((m) => m.method === 'session/cancel'));
    assert.equal(sent.some((m) => m.id === 7), false);
  });
});

describe('A7 等人批准权限时不算卡死（Claude Code / Codex 永远是 ask）', () => {
  test('看门狗在非 kiro 会话等权限时把静默计时往后推，不打断', () => {
    const wd = slice(M, 'const watchdog = setInterval(() => {', 600);
    assert.match(wd, /engineOf\(e\.profile\) !== 'kiro' && e\.client\.awaitingPermission\) \{\s*e\.lastStreamAt = Date\.now\(\);\s*return;/);
  });
});

describe('A8 没登录 / 没装：报错说清是哪个工具、去哪弄', () => {
  test('认 ACP 的 auth_required（-32000）', () => {
    assert.equal(isAuthRequiredError({ code: -32000, message: 'Authentication required' }), true);
    assert.equal(isAuthRequiredError({ message: 'Authentication required' }), true);
    assert.equal(isAuthRequiredError({ code: -32603, message: 'Internal error' }), false);
    assert.equal(isAuthRequiredError({ code: -32602, message: 'Invalid params' }), false);
  });
  test('提示里有引擎名和登录命令', () => {
    assert.match(adapterAuthMessage('claude'), /Claude Code/);
    assert.match(adapterAuthMessage('claude'), /claude auth login/);
    assert.match(adapterAuthMessage('codex'), /codex login/);
    assert.match(adapterMissingMessage('codex'), /npm i -g @agentclientprotocol\/codex-acp/);
  });
  test('适配器回 auth_required → 请求的错误换成这句（原文留在 data）', async () => {
    const { c } = fakeClient('claude');
    const p = c.sendRequest('session/new', {});
    c.handleMessage({ jsonrpc: '2.0', id: 0, error: { code: -32000, message: 'Authentication required' } });
    await assert.rejects(p, (err: any) => /claude auth login/.test(err.message) && err.code === -32000);
  });
  test('kiro 的错误原样（行为不变）', async () => {
    const { c } = fakeClient('kiro');
    const p = c.sendRequest('session/new', {});
    c.handleMessage({ jsonrpc: '2.0', id: 0, error: { code: -32000, message: 'Authentication required' } });
    await assert.rejects(p, (err: any) => err.message === 'Authentication required');
  });
  test('非 Windows 退回 PATH 上的名字时 spawn ENOENT → 换成「装哪个包」', () => {
    const err = slice(AC, "this.process.on('error', (err", 500);
    assert.match(err, /ENOENT/);
    assert.match(err, /adapterMissingMessage\(this\.engine\)/);
  });
});
