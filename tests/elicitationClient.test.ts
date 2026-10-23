/**
 * AcpClient 这一层的提问（`elicitation/create`）：声明能力、收到请求、四种回包、停止 / 撤回 / 断开。
 *
 * 不起真进程：把 `send` 换成收集器，用 `handleMessage` 喂 JSON-RPC 消息（和 engineAuditFixes 一样）。
 * 真适配器的实测记在 `src/main/elicitation.ts` 头注释里。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AcpClient } from '../src/main/acp-client.ts';

const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'acp-client.ts'), 'utf8');

function fakeClient(engine: 'kiro' | 'claude' | 'codex' = 'claude') {
  const c: any = new AcpClient('m', {}, undefined, 'ask', undefined, undefined, engine);
  const sent: any[] = [];
  c.send = (msg: any) => { sent.push(msg); };
  const asked: any[] = [];
  const closed: any[] = [];
  const errors: any[] = [];
  c.on('elicitation', (d: any) => asked.push(d));
  c.on('elicitation-closed', (d: any) => closed.push(d));
  c.on('error', (e: any) => errors.push(e));
  return { c, sent, asked, closed, errors };
}

const FORM = {
  mode: 'form', sessionId: 'acp-1', message: 'Pick one',
  requestedSchema: { type: 'object', properties: { q: { type: 'string', oneOf: [{ const: 'a', title: 'A' }] } } },
};

describe('initialize 声明 clientCapabilities', () => {
  test('发的是 ACP 规范的 clientCapabilities（不是 capabilities），内容是 CLIENT_CAPABILITIES', () => {
    const at = SRC.indexOf("this.sendRequest('initialize'");
    assert.ok(at > 0);
    const body = SRC.slice(at, at + 900).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(body, /clientCapabilities: CLIENT_CAPABILITIES/);
    assert.doesNotMatch(body, /\bcapabilities: \{\}/);
  });
  test('三个引擎都发（initialize 不按引擎分支）', () => {
    const at = SRC.indexOf("this.sendRequest('initialize'");
    const before = SRC.slice(Math.max(0, at - 400), at);
    assert.doesNotMatch(before, /engine\s*[!=]==/);
  });
});

describe('收到 elicitation/create', () => {
  for (const engine of ['kiro', 'claude', 'codex'] as const) {
    test(`${engine}：form 模式交给上层（elicitation 事件），先不回包；awaitingQuestion 为真`, () => {
      const { c, sent, asked } = fakeClient(engine);
      c.handleMessage({ jsonrpc: '2.0', id: 5, method: 'elicitation/create', params: FORM });
      assert.equal(asked.length, 1);
      assert.equal(asked[0].requestId, 5);
      assert.equal(asked[0].params.message, 'Pick one');
      assert.deepEqual(sent, []);
      assert.equal(c.awaitingQuestion, true);
    });
  }

  test('url 模式（没声明）：直接回 cancel 并报出来，不交给界面', () => {
    const { c, sent, asked, errors } = fakeClient();
    c.handleMessage({ jsonrpc: '2.0', id: 6, method: 'elicitation/create', params: { mode: 'url', sessionId: 's', message: 'm', url: 'https://x', elicitationId: 'e' } });
    assert.deepEqual(asked, []);
    assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 6, result: { action: 'cancel' } }]);
    assert.equal(errors[0]?.type, 'unsupported-elicitation');
  });
});

describe('四种回包', () => {
  test('accept 带 content；只回一次（第二次返回 false、不发）', () => {
    const { c, sent } = fakeClient();
    c.handleMessage({ jsonrpc: '2.0', id: 7, method: 'elicitation/create', params: FORM });
    assert.equal(c.respondToElicitation(7, { action: 'accept', content: { q: 'a' } }), true);
    assert.equal(c.respondToElicitation(7, { action: 'decline' }), false);
    assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 7, result: { action: 'accept', content: { q: 'a' } } }]);
    assert.equal(c.awaitingQuestion, false);
  });

  test('decline（跳过）', () => {
    const { c, sent } = fakeClient('codex');
    c.handleMessage({ jsonrpc: '2.0', id: 'x1', method: 'elicitation/create', params: FORM });
    c.respondToElicitation('x1', { action: 'decline' });
    assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 'x1', result: { action: 'decline' } }]);
  });

  test('停止这一轮（cancelPrompt）：挂着的提问回 cancel，并通知上层关卡片', () => {
    for (const engine of ['kiro', 'claude'] as const) {
      const { c, sent, closed } = fakeClient(engine);
      c.handleMessage({ jsonrpc: '2.0', id: 8, method: 'elicitation/create', params: FORM });
      c.cancelPrompt('acp-1');
      assert.deepEqual(sent.filter((m) => m.id === 8), [{ jsonrpc: '2.0', id: 8, result: { action: 'cancel' } }]);
      assert.deepEqual(closed, [{ requestId: 8, reason: 'cancelled' }]);
      assert.equal(c.awaitingQuestion, false);
    }
  });

  test('超时由上层按 cancel 回（respondToElicitation 的 cancel 形状）', () => {
    const { c, sent } = fakeClient();
    c.handleMessage({ jsonrpc: '2.0', id: 9, method: 'elicitation/create', params: FORM });
    c.respondToElicitation(9, { action: 'cancel' });
    assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 9, result: { action: 'cancel' } }]);
  });
});

describe('代理撤回 / 进程断开', () => {
  test('$/cancel_request：不再回包，卡片记成撤回', () => {
    const { c, sent, closed } = fakeClient('codex');
    c.handleMessage({ jsonrpc: '2.0', id: 10, method: 'elicitation/create', params: FORM });
    c.handleMessage({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 10 } });
    assert.deepEqual(closed, [{ requestId: 10, reason: 'withdrawn' }]);
    assert.equal(c.respondToElicitation(10, { action: 'cancel' }), false);
    assert.deepEqual(sent, []);
  });

  test('elicitation/complete 按 elicitationId 关掉对应那一张，别的不动', () => {
    const { c, closed } = fakeClient();
    c.handleMessage({ jsonrpc: '2.0', id: 11, method: 'elicitation/create', params: { ...FORM, elicitationId: 'e-1' } });
    c.handleMessage({ jsonrpc: '2.0', id: 12, method: 'elicitation/create', params: FORM });
    c.handleMessage({ jsonrpc: '2.0', method: 'elicitation/complete', params: { elicitationId: 'e-1' } });
    assert.deepEqual(closed, [{ requestId: 11, reason: 'withdrawn' }]);
    assert.equal(c.awaitingQuestion, true);
  });

  test('断开（rejectAllPending）：挂着的都记成取消', () => {
    const { c, closed } = fakeClient();
    c.handleMessage({ jsonrpc: '2.0', id: 13, method: 'elicitation/create', params: FORM });
    c.rejectAllPending(new Error('Disconnected'));
    assert.deepEqual(closed, [{ requestId: 13, reason: 'cancelled' }]);
    assert.equal(c.awaitingQuestion, false);
  });
});
