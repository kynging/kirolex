/**
 * 控制入口看得到 / 能回答模型的提问（`elicitation.ts` 的卡片）：
 * tail 里 `role:'question'` 的一条（挂着的写 `[question pending]`），`POST /sessions/:id/answer` 回答。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createControlServer, type ControlSessionAccess } from '../src/main/controlServer.ts';
import { checkAnswerBody, tailEntries, type ControlAnswerResult } from '../src/main/controlSessions.ts';
import { closeQuestionCard, newQuestionCard } from '../src/main/elicitation.ts';

const SCHEMA = { type: 'object', properties: { q: { type: 'string', title: 'Color', oneOf: [{ const: 'red', title: 'Red' }, { const: 'blue', title: 'Blue' }] } } };
const card = newQuestionCard({ id: 'q_1', sessionId: 's_1', requestId: 3, now: 10, params: { message: 'Pick a color', requestedSchema: SCHEMA } });

describe('tail 里的提问', () => {
  test('挂着的：role question、文字里有问题和选项；答过的：带答案', () => {
    const answered = closeQuestionCard({ ...card, id: 'q_0' }, 'answered', 20, { q: 'blue' });
    const tail = tailEntries([
      { id: 'u1', role: 'user', content: 'hi', ts: 1 },
      { id: 'q_0', role: 'assistant', content: '', ts: 5, question: answered },
      { id: 'q_1', role: 'assistant', content: '', ts: 10, question: card },
    ], 10);
    assert.deepEqual(tail.map((e) => e.role), ['user', 'question', 'question']);
    assert.match(tail[1].text, /\[question answered\][\s\S]*→ Color = Blue/);
    assert.match(tail[2].text, /^\[question pending\] Pick a color\n- Color \[q\] \(single\): red \(Red\) \/ blue \(Blue\)$/);
  });
});

describe('checkAnswerBody', () => {
  test('默认 accept；questionId / answers 可选；坏的拒掉', () => {
    assert.deepEqual(checkAnswerBody({ answers: { q: 'red' } }), { ok: true, action: 'accept', answers: { q: 'red' } });
    assert.deepEqual(checkAnswerBody({ action: 'decline', questionId: 'q_1' }), { ok: true, questionId: 'q_1', action: 'decline', answers: {} });
    assert.deepEqual(checkAnswerBody(null), { ok: false, error: 'bad-json' });
    assert.deepEqual(checkAnswerBody({ action: 'cancel' }), { ok: false, error: 'bad-action' });
    assert.deepEqual(checkAnswerBody({ answers: ['x'] }), { ok: false, error: 'bad-answers' });
    assert.deepEqual(checkAnswerBody({ questionId: 5 }), { ok: false, error: 'bad-question-id' });
  });
});

describe('POST /sessions/:id/answer', () => {
  async function start(answer?: ControlSessionAccess['answer']) {
    const calls: any[] = [];
    const access: ControlSessionAccess = {
      enabled: () => true,
      list: () => [],
      exists: (id) => id === 's_1',
      tail: () => [],
      status: () => ({ busy: true, turnStartedAt: 1, queued: 0, lastMessageAt: 1 }),
      send: async () => ({ ok: false, status: 500, error: 'x' }),
      ...(answer ? { answer: (id, body) => { calls.push({ id, body }); return answer(id, body); } } : {}),
    };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kctl-q-')), 'control.json');
    const logs: string[] = [];
    const srv = await createControlServer({ onQuit: () => {}, file, sessions: access, log: (m) => logs.push(m) });
    const post = (p: string, body: unknown, token: string | null = srv.token) => fetch(`http://127.0.0.1:${srv.port}${p}`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { srv, post, calls, logs };
  }

  test('要 token；答案交给 access.answer，回 {ok, questionId, status}；日志不记答案内容', async () => {
    const { srv, post, calls, logs } = await start((): ControlAnswerResult => ({ ok: true, questionId: 'q_1', status: 'answered' }));
    try {
      assert.equal((await post('/sessions/s_1/answer', { answers: { q: 'red' } }, null)).status, 401);
      const r = await post('/sessions/s_1/answer', { answers: { q: 'top-secret-answer' } });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, questionId: 'q_1', status: 'answered' });
      assert.deepEqual(calls, [{ id: 's_1', body: { ok: true, action: 'accept', answers: { q: 'top-secret-answer' } } }]);
      assert.ok(!logs.join('\n').includes('top-secret-answer'));
    } finally { await srv.close(); }
  });

  test('access 报的错原样带出（没有挂着的 404 / 不合要求 400 带 missing）；坏请求体 400；不存在的会话 404', async () => {
    const { srv, post } = await start((): ControlAnswerResult => ({ ok: false, status: 400, error: 'invalid', missing: ['q'], invalid: [] }));
    try {
      const r = await post('/sessions/s_1/answer', {});
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { ok: false, error: 'invalid', missing: ['q'], invalid: [] });
      assert.equal((await post('/sessions/s_1/answer', 'not json')).status, 400);
      assert.equal((await post('/sessions/nope/answer', {})).status, 404);
    } finally { await srv.close(); }
  });

  test('没接 answer → 501', async () => {
    const { srv, post } = await start();
    try { assert.equal((await post('/sessions/s_1/answer', {})).status, 501); } finally { await srv.close(); }
  });
});
