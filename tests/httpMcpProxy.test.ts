import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import http from 'node:http';
import {
  HttpProxy, startLocalMcp, maskSecret, maskUrl, expandEnvRefs, probeHttpMcp, httpProxyTimeout,
  HTTP_PROXY_MIN_TIMEOUT_MS, PROXY_TIMEOUT_MS,
} from '../src/main/localMcp.ts';

/*
 * 「HTTP 型转发」：远端发来的 JSON-RPC 由本机代为发往一个**固定的**上游网址（例如妙想
 * https://mxapi.eastmoney.com/mxds/mcp，StreamableHttp，请求头 em_api_key 鉴权）。
 * 上游看到的是本机出口 IP，密钥也只在本机。这里用本地起的假 HTTP MCP 服务把整条路走一遍。
 */

const SECRET = 'sk-SUPERSECRET-0123456789';

interface Seen { path: string; headers: http.IncomingHttpHeaders; body: any }
type Handler = (req: http.IncomingMessage, body: any, res: http.ServerResponse, seen: Seen[]) => void;

async function fakeUpstream(handler: Handler): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body: any = null;
      try { body = JSON.parse(raw); } catch {}
      seen.push({ path: req.url || '', headers: req.headers, body });
      handler(req, body, res, seen);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}/mxds/mcp`,
    seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** 一个守规矩的 StreamableHttp MCP：initialize 发 session id，之后要求带上。 */
function wellBehaved(opts: { sse?: boolean; sessionId?: string } = {}): Handler {
  return (req, body, res) => {
    const reply = (obj: any, extra: Record<string, string> = {}) => {
      if (opts.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...extra });
        /* 先推一条通知（应被丢掉），再推真正的响应 */
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { p: 1 } })}\n\n`);
        res.write(`event: message\r\ndata: ${JSON.stringify(obj)}\r\n\r\n`);
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(obj));
      }
    };
    if (body?.id === undefined) { res.writeHead(202).end(); return; }
    if (body.method === 'initialize') {
      reply({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } },
        { 'mcp-session-id': opts.sessionId || 'sess-1' });
      return;
    }
    if (body.method === 'tools/list') {
      reply({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'a', inputSchema: {} }, { name: 'b', inputSchema: {} }] } });
      return;
    }
    if (body.method === 'tools/call') {
      reply({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: '一' }, { type: 'text', text: '二' }] } });
      return;
    }
    reply({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } });
  };
}

function collectLogs(): { log: (l: string, m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { lines, log: (l, m) => { lines.push(`${l} ${m}`); } };
}

describe('HttpProxy：JSON / SSE 回复', () => {
  test('application/json 原样返回；发往的就是 spec.url，带上 spec.headers 和 Accept', async () => {
    const up = await fakeUpstream(wellBehaved());
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url, headers: { em_api_key: SECRET } }, () => {});
      const r = await p.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.deepEqual(r, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a', inputSchema: {} }, { name: 'b', inputSchema: {} }] } });
      assert.equal(up.seen[0].path, '/mxds/mcp');
      assert.equal(up.seen[0].headers['em_api_key'], SECRET);
      assert.equal(up.seen[0].headers['accept'], 'application/json, text/event-stream');
      assert.equal(up.seen[0].headers['content-type'], 'application/json');
    } finally { await up.close(); }
  });

  test('text/event-stream：取出对应 id 的那条响应，其余通知丢弃；isError 和多段 content 原样透传', async () => {
    const up = await fakeUpstream(wellBehaved({ sse: true }));
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url }, () => {});
      const r = await p.call({ jsonrpc: '2.0', id: 'x9', method: 'tools/call', params: { name: 'a', arguments: {} } });
      assert.deepEqual(r, { jsonrpc: '2.0', id: 'x9', result: { isError: true, content: [{ type: 'text', text: '一' }, { type: 'text', text: '二' }] } });
    } finally { await up.close(); }
  });

  test('上游自己返回的 JSON-RPC error 原样透传', async () => {
    const up = await fakeUpstream(wellBehaved());
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url }, () => {});
      const r = await p.call({ jsonrpc: '2.0', id: 3, method: 'weird' });
      assert.deepEqual(r, { jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'nope' } });
    } finally { await up.close(); }
  });

  test('通知（没有 id）：发出去即返回 null（本地服务据此回 202）', async () => {
    const up = await fakeUpstream(wellBehaved());
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url }, () => {});
      const r = await p.call({ jsonrpc: '2.0', method: 'notifications/initialized' });
      assert.equal(r, null);
      assert.equal(up.seen.length, 1);
      assert.equal(up.seen[0].body.method, 'notifications/initialized');
    } finally { await up.close(); }
  });

  test('SSE 里没有对应 id 的响应 → 可读的解析失败错误', async () => {
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} })}\n\n`);
    });
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url }, () => {});
      const r = await p.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(r.id, 1);
      assert.equal(r.error.code, -32000);
      assert.match(r.error.message, /^本机→上游（mx）响应解析失败/);
    } finally { await up.close(); }
  });

  test('JSON 解析失败 → 可读错误', async () => {
    const up = await fakeUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('<html>oops');
    });
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url }, () => {});
      const r = await p.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.match(r.error.message, /^本机→上游（mx）响应解析失败/);
    } finally { await up.close(); }
  });
});

describe('HttpProxy：mcp-session-id', () => {
  test('保存上游返回的 session id，后续请求带上', async () => {
    const up = await fakeUpstream(wellBehaved({ sessionId: 'abc-123' }));
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url }, () => {});
      await p.call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kiro' } } });
      await p.call({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await p.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.equal(up.seen[0].headers['mcp-session-id'], undefined);
      assert.equal(up.seen[1].headers['mcp-session-id'], 'abc-123');
      assert.equal(up.seen[2].headers['mcp-session-id'], 'abc-123');
    } finally { await up.close(); }
  });

  test('上游 404（会话失效）→ 清掉 session id，重新 initialize 一次再重试原请求', async () => {
    let gen = 0;
    const live = new Set<string>();
    const up = await fakeUpstream((req, body, res) => {
      const sid = req.headers['mcp-session-id'] as string | undefined;
      if (body?.method === 'initialize') {
        const s = `s${++gen}`;
        live.add(s);
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': s })
          .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
        return;
      }
      if (!sid || !live.has(sid)) { res.writeHead(404).end('Session not found'); return; }
      if (body?.id === undefined) { res.writeHead(202).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [], sid } }));
    });
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url }, () => {});
      await p.call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kiro' } } });
      const a = await p.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.equal(a.result.sid, 's1');
      live.clear();   // 上游重启了 / 会话过期
      const b = await p.call({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
      assert.equal(b.id, 3);
      assert.equal(b.result.sid, 's2', '重建后用新的 session 重试原请求');
      const methods = up.seen.map((s) => s.body?.method);
      assert.deepEqual(methods.slice(-4), ['tools/list', 'initialize', 'notifications/initialized', 'tools/list']);
      /* 重建时用的是远端最初的 initialize 参数 */
      const reinit = up.seen[up.seen.length - 3];
      assert.equal(reinit.headers['mcp-session-id'], undefined, '重建前要清掉旧的 session id');
      assert.deepEqual(reinit.body.params.clientInfo, { name: 'kiro' });
    } finally { await up.close(); }
  });
});

describe('HttpProxy：并发请求同时遇到会话过期', () => {
  test('晚到的旧会话 404 不能清掉刚重建的新会话：两条请求都带 s2 重试成功', async () => {
    let gen = 0;
    const live = new Set<string>();
    let stale = 0;
    let heldB: http.ServerResponse | null = null;
    const up = await fakeUpstream((req, body, res) => {
      const sid = req.headers['mcp-session-id'] as string | undefined;
      if (body?.method === 'initialize') {
        const s = `s${++gen}`;
        live.add(s);
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': s })
          .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
        return;
      }
      if (!sid || !live.has(sid)) {
        /* 第一条旧会话请求立刻 404（它去重建）；第二条先压着，等重建走到 initialized 时才放 */
        if (++stale === 2) { heldB = res; return; }
        res.writeHead(404).end('Session not found');
        return;
      }
      if (body?.id === undefined) {
        /* 重建已拿到 s2、还在等 initialized 的回复 —— 这时把 B 那条旧会话的 404 放出去 */
        if (heldB) { heldB.writeHead(404).end('Session not found'); heldB = null; }
        setTimeout(() => res.writeHead(202).end(), 80);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [], sid } }));
    });
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url }, () => {});
      await p.call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kiro' } } });
      live.clear();   // s1 过期
      stale = 0;
      const [a, b] = await Promise.all([
        p.call({ jsonrpc: '2.0', id: 'A', method: 'tools/list' }),
        p.call({ jsonrpc: '2.0', id: 'B', method: 'tools/list' }),
      ]);
      assert.equal(a.result?.sid, 's2', JSON.stringify(a));
      assert.equal(b.result?.sid, 's2', JSON.stringify(b));
      assert.equal(up.seen.filter((s) => s.body?.method === 'initialize').length, 2, '只重建一次');
    } finally { await up.close(); }
  });
});

describe('HttpProxy：只在明确的会话失效时重建', () => {
  test('400「Invalid argument sessionDate」是参数错误：不重建、工具只调一次', async () => {
    const up = await fakeUpstream((req, body, res) => {
      if (body?.method === 'tools/call') { res.writeHead(400).end('Invalid argument sessionDate'); return; }
      wellBehaved()(req, body, res, []);
    });
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url }, () => {});
      await p.call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      const r = await p.call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'a', arguments: { sessionDate: 'x' } } });
      assert.equal(r.error.code, -32000);
      assert.equal(r.error.message, '本机→上游（mx）请求失败：HTTP 400');
      assert.equal(up.seen.filter((s) => s.body?.method === 'tools/call').length, 1, '工具请求只能发一次');
      assert.equal(up.seen.filter((s) => s.body?.method === 'initialize').length, 1, '不该重新 initialize');
    } finally { await up.close(); }
  });

  test('400「No valid session ID provided」是明确的会话失效：重建一次再重试', async () => {
    let inits = 0;
    const up = await fakeUpstream((req, body, res) => {
      if (body?.method === 'initialize') inits++;
      if (body?.method === 'tools/list' && inits < 1) { res.writeHead(400).end('Bad Request: No valid session ID provided'); return; }
      wellBehaved()(req, body, res, []);
    });
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url }, () => {});
      const r = await p.call({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
      assert.equal(r.id, 9);
      assert.equal(r.result.tools.length, 2);
      assert.equal(up.seen.filter((s) => s.body?.method === 'initialize').length, 1);
    } finally { await up.close(); }
  });
});

describe('HttpProxy：错误文案', () => {
  test('401 → 「本机→上游（名字）鉴权失败：HTTP 401，请检查本机配置的密钥」', async () => {
    const up = await fakeUpstream((_req, _body, res) => { res.writeHead(401).end(`bad key ${SECRET}`); });
    const logs = collectLogs();
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx-ds-mcp', url: up.url, headers: { em_api_key: SECRET } }, logs.log);
      const r = await p.call({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
      assert.deepEqual(r, { jsonrpc: '2.0', id: 5, error: { code: -32000, message: '本机→上游（mx-ds-mcp）鉴权失败：HTTP 401，请检查本机配置的密钥' } });
      for (const l of logs.lines) assert.ok(!l.includes(SECRET), `日志里不能有密钥：${l}`);
    } finally { await up.close(); }
  });

  test('403 同样是鉴权失败；500 写明状态码', async () => {
    let status = 403;
    const up = await fakeUpstream((_req, _body, res) => { res.writeHead(status).end('boom'); });
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url }, () => {});
      const a = await p.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.match(a.error.message, /^本机→上游（mx）鉴权失败：HTTP 403/);
      status = 500;
      const b = await p.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.equal(b.error.code, -32000);
      assert.match(b.error.message, /^本机→上游（mx）.*HTTP 500/);
    } finally { await up.close(); }
  });

  test('连接被拒 → 可读错误，不抛', async () => {
    const up = await fakeUpstream(() => {});
    const url = up.url;
    await up.close();
    const p = new HttpProxy({ type: 'http', name: 'mx', url }, () => {});
    const r = await p.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(r.error.code, -32000);
    assert.match(r.error.message, /^本机→上游（mx）连不上上游.*连接被拒绝/);
  });

  test('超时 → 可读错误', async () => {
    const up = await fakeUpstream(() => { /* 永远不回 */ });
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url }, () => {});
      const t0 = Date.now();
      const r = await p.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 300);
      assert.ok(Date.now() - t0 < 5000);
      assert.equal(r.id, 1);
      assert.match(r.error.message, /^本机→上游（mx）超时/);
    } finally { await up.close(); }
  });

  test('超时配置：默认 180000，下限 120000', () => {
    assert.equal(httpProxyTimeout({ type: 'http', name: 'a', url: 'http://x' }), PROXY_TIMEOUT_MS);
    assert.equal(PROXY_TIMEOUT_MS, 180_000);
    assert.equal(httpProxyTimeout({ type: 'http', name: 'a', url: 'http://x', timeoutMs: 5000 }), HTTP_PROXY_MIN_TIMEOUT_MS);
    assert.equal(HTTP_PROXY_MIN_TIMEOUT_MS, 120_000);
    assert.equal(httpProxyTimeout({ type: 'http', name: 'a', url: 'http://x', timeoutMs: 300_000 }), 300_000);
  });

  test('上游要求跳转 → 不跟随（密钥不能被带去别的地方）', async () => {
    const other = await fakeUpstream(wellBehaved());
    const up = await fakeUpstream((_req, _body, res) => { res.writeHead(302, { location: other.url }).end(); });
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url, headers: { em_api_key: SECRET } }, () => {});
      const r = await p.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.match(r.error.message, /^本机→上游（mx）.*HTTP 302/);
      assert.equal(other.seen.length, 0);
    } finally { await up.close(); await other.close(); }
  });
});

describe('请求头引用本机环境变量', () => {
  test('${env:NAME} 和 ${NAME} 都展开', () => {
    const env = { MX_KEY: 'k1', OTHER: 'k2' };
    assert.equal(expandEnvRefs('${env:MX_KEY}', env), 'k1');
    assert.equal(expandEnvRefs('Bearer ${OTHER}', env), 'Bearer k2');
    assert.equal(expandEnvRefs('plain', env), 'plain');
    assert.throws(() => expandEnvRefs('${env:NOPE}', env), (e: any) => e.envName === 'NOPE');
  });

  test('转发时展开成 process.env 的值', async () => {
    const up = await fakeUpstream(wellBehaved());
    process.env.KIROLEX_TEST_MX_KEY = SECRET;
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url, headers: { em_api_key: '${env:KIROLEX_TEST_MX_KEY}' } }, () => {});
      await p.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(up.seen[0].headers['em_api_key'], SECRET);
    } finally { delete process.env.KIROLEX_TEST_MX_KEY; await up.close(); }
  });

  test('变量不存在 → 配置错误（不发请求）', async () => {
    const up = await fakeUpstream(wellBehaved());
    delete process.env.KIROLEX_TEST_MISSING;
    try {
      const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url, headers: { em_api_key: '${KIROLEX_TEST_MISSING}' } }, () => {});
      const r = await p.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(r.error.code, -32000);
      assert.match(r.error.message, /^本机→上游（mx）配置错误.*KIROLEX_TEST_MISSING/);
      assert.equal(up.seen.length, 0);
    } finally { await up.close(); }
  });
});

describe('打码', () => {
  test('maskSecret 只留前 4 位；短的全打码', () => {
    assert.equal(maskSecret('abcdefghij'), 'abcd******');
    assert.equal(maskSecret('short'), '*****');
    assert.equal(maskSecret(''), '');
  });

  test('maskUrl 把 query 参数的值打码', () => {
    const m = maskUrl(`https://h.example/mcp?key=${SECRET}&x=1`);
    assert.ok(!m.includes(SECRET));
    assert.match(m, /^https:\/\/h\.example\/mcp\?key=sk-S\*+&x=\*$/);
  });

  test('HttpProxy 的日志里没有请求头原值，也没有 URL 里的密钥', async () => {
    process.env.KIROLEX_TEST_MX_KEY2 = SECRET;
    const up = await fakeUpstream((req, body, res) => {
      if (body?.method === 'tools/list') { res.writeHead(500).end(`internal: ${SECRET}`); return; }
      wellBehaved()(req, body, res, []);
    });
    const logs = collectLogs();
    try {
      const p = new HttpProxy({
        type: 'http', name: 'mx', url: `${up.url}?token=${SECRET}`,
        headers: { em_api_key: SECRET, 'x-other': '${KIROLEX_TEST_MX_KEY2}' },
      }, logs.log);
      await p.call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      const r = await p.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.ok(!JSON.stringify(r).includes(SECRET), '返回给远端的错误里也不能有密钥');
      assert.ok(logs.lines.length > 0, '应当有日志');
      for (const l of logs.lines) assert.ok(!l.includes(SECRET), `日志里不能有密钥：${l}`);
      assert.ok(logs.lines.some((l) => l.includes('sk-S')), '打码后的前缀可以出现，便于核对是哪把钥匙');
    } finally { delete process.env.KIROLEX_TEST_MX_KEY2; await up.close(); }
  });
});

describe('上游回显密钥也不能漏', () => {
  for (const [label, headerValue, secret] of [
    ['Authorization: Bearer <密钥>，上游只回显密钥本身', `Bearer ${SECRET}`, SECRET],
    ['3 位的短密钥', 'q7Z', 'q7Z'],
  ] as const) {
    test(label, async () => {
      const up = await fakeUpstream((_req, _body, res) => { res.writeHead(500).end(`echo: ${secret}`); });
      const logs = collectLogs();
      try {
        const p = new HttpProxy({ type: 'http', name: 'mx', url: up.url, headers: { authorization: headerValue } }, logs.log);
        const r = await p.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        assert.equal(r.error.message, '本机→上游（mx）请求失败：HTTP 500');
        assert.ok(!JSON.stringify(r).includes(secret), '返回的错误里不能有密钥');
        assert.ok(logs.lines.length > 0);
        for (const l of logs.lines) assert.ok(!l.includes(secret), `日志里不能有密钥：${l}`);
      } finally { await up.close(); }
    });
  }
});

describe('接进本地 MCP 服务', () => {
  test('远端无法改变目标地址、路径和请求头', async () => {
    const up = await fakeUpstream(wellBehaved());
    const server = await startLocalMcp({ log: () => {}, notice: () => {} });
    try {
      const token = server.register({ sessionId: 's1', workdir: process.cwd() });
      server.setProxies('s1', [{ type: 'http', name: 'mx', url: up.url, headers: { em_api_key: SECRET } }]);
      const base = `http://127.0.0.1:${server.port()}/mcp/${token}/mx`;
      const res = await fetch(`${base}?url=http://evil.example/&target=x`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-forwarded-host': 'evil.example', 'em_api_key': 'remote-key',
          'mcp-session-id': 'remote-sid', authorization: 'Bearer evil',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', url: 'http://evil.example/' }),
      });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as any).id, 1);
      assert.equal(up.seen.length, 1);
      assert.equal(up.seen[0].path, '/mxds/mcp', '只发往 spec.url');
      assert.equal(up.seen[0].headers['em_api_key'], SECRET, '远端的同名请求头不能覆盖本机配置');
      assert.equal(up.seen[0].headers['authorization'], undefined);
      assert.equal(up.seen[0].headers['x-forwarded-host'], undefined);
      assert.equal(up.seen[0].headers['mcp-session-id'], undefined);

      /* 子路径不认 */
      const sub = await fetch(`${base}/extra`, { method: 'POST', body: '{}' });
      assert.equal(sub.status, 404);

      /* 通知 → 202 */
      const note = await fetch(base, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
      assert.equal(note.status, 202);
    } finally { server.stop(); await up.close(); }
  });

  test('上游挂了不影响同一会话的 local_* 工具', async () => {
    const up = await fakeUpstream(() => {});
    const dead = up.url;
    await up.close();
    const server = await startLocalMcp({ log: () => {}, notice: () => {} });
    try {
      const token = server.register({ sessionId: 's1', workdir: process.cwd() });
      server.setProxies('s1', [{ type: 'http', name: 'mx', url: dead }]);
      const base = `http://127.0.0.1:${server.port()}/mcp/${token}`;
      const bad: any = await (await fetch(`${base}/mx`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json();
      assert.equal(bad.error.code, -32000);
      const ok: any = await (await fetch(base, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json();
      assert.ok(ok.result.tools.length > 0);
    } finally { server.stop(); }
  });
});

describe('probeHttpMcp', () => {
  test('initialize + initialized + tools/list → { ok, toolCount }', async () => {
    const up = await fakeUpstream(wellBehaved({ sse: true }));
    try {
      const r = await probeHttpMcp({ type: 'http', name: 'mx', url: up.url });
      assert.deepEqual(r, { ok: true, toolCount: 2 });
      assert.deepEqual(up.seen.map((s) => s.body?.method), ['initialize', 'notifications/initialized', 'tools/list']);
      assert.equal(up.seen[2].headers['mcp-session-id'], 'sess-1');
    } finally { await up.close(); }
  });

  test('initialized 通知回 401 → ok:false（即使 tools/list 能回清单）', async () => {
    const up = await fakeUpstream((req, body, res) => {
      if (body?.method === 'notifications/initialized') { res.writeHead(401).end(); return; }
      wellBehaved()(req, body, res, []);
    });
    try {
      const r = await probeHttpMcp({ type: 'http', name: 'mx', url: up.url });
      assert.deepEqual(r, { ok: false, toolCount: 0, error: '本机→上游（mx）鉴权失败：HTTP 401，请检查本机配置的密钥' });
    } finally { await up.close(); }
  });

  test('initialized 通知超时 → ok:false', async () => {
    const up = await fakeUpstream((req, body, res) => {
      if (body?.method === 'notifications/initialized') return;   // 永远不回
      wellBehaved()(req, body, res, []);
    });
    try {
      const r = await probeHttpMcp({ type: 'http', name: 'mx', url: up.url }, { timeoutMs: 300 });
      assert.equal(r.ok, false);
      assert.equal(r.toolCount, 0);
      assert.match(r.error!, /^本机→上游（mx）超时/);
    } finally { await up.close(); }
  });

  test('远端那条路不变：通知失败照样回 202', async () => {
    const up = await fakeUpstream((_req, _body, res) => { res.writeHead(401).end(); });
    const server = await startLocalMcp({ log: () => {}, notice: () => {} });
    try {
      const token = server.register({ sessionId: 's1', workdir: process.cwd() });
      server.setProxies('s1', [{ type: 'http', name: 'mx', url: up.url }]);
      const note = await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}/mx`, {
        method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assert.equal(note.status, 202);
    } finally { server.stop(); await up.close(); }
  });

  test('鉴权失败 → { ok: false, error }', async () => {
    const up = await fakeUpstream((_req, _body, res) => { res.writeHead(401).end(); });
    try {
      const r = await probeHttpMcp({ type: 'http', name: 'mx-ds-mcp', url: up.url, headers: { em_api_key: SECRET } });
      assert.equal(r.ok, false);
      assert.equal(r.toolCount, 0);
      assert.match(r.error!, /^本机→上游（mx-ds-mcp）鉴权失败：HTTP 401/);
    } finally { await up.close(); }
  });
});
