import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createControlServer, type ControlSessionAccess, type ControlSendResult } from '../src/main/controlServer.ts';
import {
  CONTROL_SEND_MAX, CONTROL_TAIL_MAX, CONTROL_TEXT_MAX,
  checkSendBody, controlMessageId, filterByTitle, isControlMessageId, parseTailCount, tailEntries,
  type ControlSessionSummary,
} from '../src/main/controlSessions.ts';

/*
 * 控制入口的「读会话 / 发消息」：让本机工具不开 CDP 调试端口也能给会话发一句话、看结果。
 * 守的是：要 token、开关默认关（关着一律 403，/ping /quit 不受影响）、advanced / 不存在的会话 404、
 * tail 截断且不外泄工具输出、日志里没有正文和 token。
 */

const SECRET_TOOL_OUTPUT = 'AWS_SECRET_ACCESS_KEY=abcd1234-tool-output';

function fakeAccess(over: Partial<ControlSessionAccess> = {}) {
  let enabled = false;
  const sends: Array<{ id: string; text: string; mode: string }> = [];
  const sessions: ControlSessionSummary[] = [
    { id: 's_1', title: '修 CDE 部署', projectId: 'p', busy: false, remote: 'cde-box', archived: false, updatedAt: 2 },
    { id: 's_2', title: 'Weekly notes', projectId: null, busy: true, remote: null, archived: true, updatedAt: 1 },
  ];
  const known = new Set(sessions.map((s) => s.id));
  const access: ControlSessionAccess = {
    enabled: () => enabled,
    list: () => sessions,
    exists: (id) => known.has(id),
    tail: (id, n) => tailEntries([
      { id: 'u1', role: 'user', content: 'hello', ts: 1 },
      { id: 'a1', role: 'assistant', content: 'done', ts: 2, toolCalls: [{ title: 'Read file', content: SECRET_TOOL_OUTPUT }] },
    ], n),
    status: () => ({ busy: false, turnStartedAt: null, queued: 0, lastMessageAt: 2 }),
    send: async (id, text, mode): Promise<ControlSendResult> => {
      sends.push({ id, text, mode });
      return { ok: true, messageId: 'user_ctl_1', routed: mode === 'next' ? 'queued' : 'sent' };
    },
    ...over,
  };
  return { access, sends, setEnabled: (v: boolean) => { enabled = v; } };
}

async function start(access: ControlSessionAccess) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kctl-s-')), 'control.json');
  const logs: string[] = [];
  const srv = await createControlServer({ onQuit: () => {}, file, sessions: access, log: (m) => logs.push(m) });
  const url = (p: string) => `http://127.0.0.1:${srv.port}${p}`;
  const auth = (token: string | null = srv.token): Record<string, string> => (token === null ? {} : { Authorization: `Bearer ${token}` });
  const get = (p: string, token?: string | null) => fetch(url(p), { headers: auth(token) });
  const post = (p: string, body: unknown, token?: string | null) => fetch(url(p), {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { srv, url, get, post, logs };
}

describe('控制入口 /sessions：鉴权与开关', () => {
  test('没 token / 错 token → 401（开关开着也一样），不调发送', async () => {
    const f = fakeAccess(); f.setEnabled(true);
    const { srv, get, post } = await start(f.access);
    try {
      assert.equal((await get('/sessions', null)).status, 401);
      assert.equal((await get('/sessions', 'wrong')).status, 401);
      assert.equal((await get('/sessions/s_1/tail', 'wrong')).status, 401);
      assert.equal((await get('/sessions/s_1/status', null)).status, 401);
      assert.equal((await post('/sessions/s_1/send', { text: 'hi' }, 'wrong')).status, 401);
      assert.equal(f.sends.length, 0);
    } finally { await srv.close(); }
  });

  test('开关关着（默认）→ 新路由一律 403 {error:disabled}；/ping 照常', async () => {
    const f = fakeAccess();
    const { srv, get, post, url } = await start(f.access);
    try {
      for (const res of [
        await get('/sessions'),
        await get('/sessions/s_1/tail'),
        await get('/sessions/s_1/status'),
        await post('/sessions/s_1/send', { text: 'hi' }),
      ]) {
        assert.equal(res.status, 403);
        assert.equal((await res.json()).error, 'disabled');
      }
      assert.equal(f.sends.length, 0);
      assert.equal((await fetch(url('/ping'))).status, 200);
    } finally { await srv.close(); }
  });

  test('打开后 GET /sessions → 200 列表；?q= 按标题子串过滤', async () => {
    const f = fakeAccess(); f.setEnabled(true);
    const { srv, get } = await start(f.access);
    try {
      const res = await get('/sessions');
      assert.equal(res.status, 200);
      const list = await res.json();
      assert.deepEqual(list.map((s: any) => s.id), ['s_1', 's_2']);
      assert.deepEqual(Object.keys(list[0]).sort(), ['archived', 'busy', 'id', 'projectId', 'remote', 'title', 'updatedAt']);
      const q = await (await get(`/sessions?q=${encodeURIComponent('cde')}`)).json();
      assert.deepEqual(q.map((s: any) => s.id), ['s_1']);
    } finally { await srv.close(); }
  });

  test('不存在 / 不许碰（exists=false，例如 advanced 的会话）/ 形状不对的 id → 404，不调发送', async () => {
    const f = fakeAccess(); f.setEnabled(true);
    const { srv, get, post } = await start(f.access);
    try {
      assert.equal((await get('/sessions/s_nope/tail')).status, 404);
      assert.equal((await get('/sessions/s_nope/status')).status, 404);
      assert.equal((await post('/sessions/s_nope/send', { text: 'hi' })).status, 404);
      assert.equal((await post('/sessions/..%2Fetc/send', { text: 'hi' })).status, 404);
      assert.equal(f.sends.length, 0);
    } finally { await srv.close(); }
  });

  test('没有命令类路由：方法不对 / 别的动作 → 404', async () => {
    const f = fakeAccess(); f.setEnabled(true);
    const { srv, url, post } = await start(f.access);
    try {
      assert.equal((await fetch(url('/sessions/s_1/send'), { headers: { Authorization: `Bearer ${srv.token}` } })).status, 404);
      assert.equal((await post('/sessions/s_1/delete', {})).status, 404);
      assert.equal((await post('/sessions', {})).status, 404);
      assert.equal((await fetch(url('/sessions/s_1'), { method: 'DELETE', headers: { Authorization: `Bearer ${srv.token}` } })).status, 404);
    } finally { await srv.close(); }
  });
});

describe('控制入口 /sessions/:id/send', () => {
  test('转给注入的 send（同一套 Enter 路由在界面里），回 {accepted, messageId, routed}', async () => {
    const f = fakeAccess(); f.setEnabled(true);
    const { srv, post } = await start(f.access);
    try {
      const a = await post('/sessions/s_1/send', { text: '  继续  ' });
      assert.equal(a.status, 200);
      assert.deepEqual(await a.json(), { accepted: true, messageId: 'user_ctl_1', routed: 'sent' });
      const b = await post('/sessions/s_1/send', { text: 'next one', mode: 'next' });
      assert.equal((await b.json()).routed, 'queued');
      assert.deepEqual(f.sends, [{ id: 's_1', text: '继续', mode: 'auto' }, { id: 's_1', text: 'next one', mode: 'next' }]);
    } finally { await srv.close(); }
  });

  test('空文字 / 坏 JSON / 坏 mode / 超长 / 斜杠命令 → 400，不调发送', async () => {
    const f = fakeAccess(); f.setEnabled(true);
    const { srv, post } = await start(f.access);
    try {
      for (const [body, err] of [
        [{ text: '   ' }, 'empty-text'],
        [{}, 'empty-text'],
        ['{not json', 'bad-json'],
        [{ text: 'x', mode: 'now' }, 'bad-mode'],
        [{ text: 'x'.repeat(CONTROL_SEND_MAX + 1) }, 'too-long'],
        [{ text: '/clear' }, 'slash-command'],
      ] as const) {
        const res = await post('/sessions/s_1/send', body);
        assert.equal(res.status, 400, String(err));
        assert.equal((await res.json()).error, err);
      }
      assert.equal(f.sends.length, 0);
      // 刚好 20000 字可以
      assert.equal((await post('/sessions/s_1/send', { text: 'y'.repeat(CONTROL_SEND_MAX) })).status, 200);
    } finally { await srv.close(); }
  });

  test('界面没就绪 → 503 {error:ui-not-ready}（主进程不绕过界面直接发）', async () => {
    const f = fakeAccess({ send: async () => ({ ok: false, status: 503, error: 'ui-not-ready' }) }); f.setEnabled(true);
    const { srv, post } = await start(f.access);
    try {
      const res = await post('/sessions/s_1/send', { text: 'hi' });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'ui-not-ready');
    } finally { await srv.close(); }
  });

  test('日志：记路由、会话 id、字数；不记正文、不记 token；响应里也没有 token', async () => {
    const f = fakeAccess(); f.setEnabled(true);
    const { srv, post, get, logs } = await start(f.access);
    const secretText = '请把这段机密正文发过去-' + 'z'.repeat(20);
    try {
      const res = await post('/sessions/s_1/send', { text: secretText });
      const bodyText = await res.text();
      await (await get('/sessions')).text();
      const tail = await (await get('/sessions/s_1/tail')).text();
      const line = logs.find((l) => l.includes('/send'));
      assert.ok(line, '应有一行发送日志');
      assert.match(line!, /session=s_1/);
      assert.match(line!, new RegExp(`chars=${secretText.length}`));
      assert.match(line!, /-> sent/);
      for (const l of logs) {
        assert.ok(!l.includes(secretText), `日志里不该有正文：${l}`);
        assert.ok(!l.includes(srv.token), `日志里不该有 token：${l}`);
      }
      assert.ok(!bodyText.includes(srv.token));
      assert.ok(!tail.includes(srv.token));
    } finally { await srv.close(); }
  });
});

describe('控制入口 tail：截断、工具输出不外泄', () => {
  test('n 默认 10、上限 50、下限 1', () => {
    assert.equal(parseTailCount(null), 10);
    assert.equal(parseTailCount(''), 10);
    assert.equal(parseTailCount('abc'), 10);
    assert.equal(parseTailCount('3'), 3);
    assert.equal(parseTailCount('999'), CONTROL_TAIL_MAX);
    assert.equal(parseTailCount('0'), 1);
    assert.equal(parseTailCount('-5'), 1);
  });

  test('只给最后 n 条；正文截到 8000 字', () => {
    const msgs = Array.from({ length: 80 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `c${i}`, ts: i }));
    const out = tailEntries(msgs, 999);
    assert.equal(out.length, CONTROL_TAIL_MAX);
    assert.equal(out[out.length - 1].id, 'm79');
    assert.deepEqual(Object.keys(out[0]).sort(), ['id', 'role', 'text', 'ts']);
    const long = tailEntries([{ id: 'x', role: 'assistant', content: 'a'.repeat(CONTROL_TEXT_MAX + 500), ts: 1 }], 1);
    assert.ok(long[0].text.length <= CONTROL_TEXT_MAX + 1);
  });

  test('工具调用只给一行标题，工具输出 / diff 不出去；<hidden> 块不出去', () => {
    const out = tailEntries([
      { id: 'u', role: 'user', content: '<hidden>file:/secret/path\n请读取这些文件内容</hidden>\n\n看看这个', ts: 1 },
      {
        id: 'a', role: 'assistant', content: '读完了', ts: 2,
        toolCalls: [{ title: 'Read\n/etc/passwd', kind: 'read', status: 'completed', content: SECRET_TOOL_OUTPUT, ...({ diffs: [{ path: 'x', newText: SECRET_TOOL_OUTPUT }] } as any) }],
      },
    ], 10);
    assert.equal(out[0].text, '看看这个');
    assert.equal(out[1].text, '[tool] Read /etc/passwd\n读完了');
    assert.ok(!JSON.stringify(out).includes(SECRET_TOOL_OUTPUT));
  });

  test('HTTP tail 里也没有工具输出', async () => {
    const f = fakeAccess(); f.setEnabled(true);
    const { srv, get } = await start(f.access);
    try {
      const res = await get('/sessions/s_1/tail?n=5');
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes(SECRET_TOOL_OUTPUT));
      assert.equal(JSON.parse(text).length, 2);
    } finally { await srv.close(); }
  });
});

describe('控制入口：小工具', () => {
  test('请求体校验', () => {
    assert.deepEqual(checkSendBody({ text: ' hi ' }), { ok: true, text: 'hi', mode: 'auto' });
    assert.deepEqual(checkSendBody({ text: 'hi', mode: 'next' }), { ok: true, text: 'hi', mode: 'next' });
    assert.equal(checkSendBody(null).ok, false);
    assert.equal(checkSendBody({ text: 3 }).ok, false);
  });

  test('经控制入口发出的消息 id 带标记；普通 id 不带', () => {
    for (const kind of ['user', 'steer', 'queue'] as const) assert.ok(isControlMessageId(controlMessageId(kind)));
    assert.equal(isControlMessageId('user_1786_abc'), false);
    assert.equal(isControlMessageId('steer_1786_abc'), false);
    assert.equal(isControlMessageId('queue_1786_abc'), false);
    assert.equal(isControlMessageId(undefined), false);
  });

  test('标题过滤不分大小写，空 q 不过滤', () => {
    const list = [{ title: 'Alpha' }, { title: 'beta' }];
    assert.equal(filterByTitle(list, '').length, 2);
    assert.deepEqual(filterByTitle(list, 'ALP'), [{ title: 'Alpha' }]);
  });
});
