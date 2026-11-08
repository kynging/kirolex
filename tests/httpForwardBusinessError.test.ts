import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { HttpProxy, startLocalMcp, probeHttpMcp, jsonRpcErrorBody } from '../src/main/localMcp.ts';

/*
 * 第 8 轮：「context7 的 400 不是会话过期」。上一轮加的日志给出了真正原因：
 *   上游回 HTTP 400（server/discover，没带 session id）：像是协议版本不被接受，JSON-RPC 错误码 -32020
 * 引擎 / 适配器发来的 server/discover（新协议方法）被 context7 以「协议版本不支持」拒掉 —— 这是上游对**这一条请求**的业务回答，
 * 转发层却把它当成整个上游挂了 → 后台探测 → 会话提示。
 *
 * 假上游照 context7 的样子：server/discover 回 400 + JSON-RPC 错误体（-32020），initialize / tools 正常（无状态，不发 session id）。
 */
const DISCOVER_400 = JSON.stringify({
  jsonrpc: '2.0', id: null,
  error: { code: -32020, message: 'Bad Request: Unsupported protocol version for server/discover (supported versions: 2025-11-25, 2025-06-18, 2025-03-26)' },
});

async function context7Like(): Promise<{ url: string; methods: string[]; close: () => Promise<void> }> {
  const methods: string[] = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const m = JSON.parse(raw || '{}');
      methods.push(m.method);
      if (m.method === 'server/discover') { res.writeHead(400, { 'content-type': 'application/json' }).end(DISCOVER_400); return; }
      if (m.id === undefined) { res.writeHead(202).end(); return; }
      const result = m.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Context7' } }
        : m.method === 'tools/list'
          ? { tools: [{ name: 'resolve-library-id', inputSchema: {} }, { name: 'query-docs', inputSchema: {} }] }
          : { content: [{ type: 'text', text: 'docs' }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(srv.address() as any).port}/mcp`,
    methods,
    close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

describe('上游对 server/discover 回 400 + -32020：原样转回，不算上游不可用', () => {
  test('经本机转发：客户端收到同样的 400 和同样的正文；不 onProxyFail（不进后台探测、没有提示）；之后 initialize / tools 正常', async () => {
    const up = await context7Like();
    const fails: string[] = [];
    const oks: string[] = [];
    const logs: string[] = [];
    const server = await startLocalMcp({
      log: (l, m) => logs.push(`${l} ${m}`), notice: () => {},
      onProxyFail: (_s, n, e) => fails.push(`${n}: ${e}`), onProxyOk: (_s, n) => oks.push(n),
    });
    try {
      const token = server.register({ sessionId: 's1', workdir: process.cwd() });
      server.setProxies('s1', [{ type: 'http', name: 'context7', url: up.url }]);
      const url = `http://127.0.0.1:${server.port()}/mcp/${token}/context7`;
      const post = (body: any) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

      const disc = await post({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
      assert.equal(disc.status, 400, 'HTTP 状态原样');
      assert.equal(await disc.text(), DISCOVER_400, '正文原样');
      assert.deepEqual(fails, [], '不判定上游不可用：不进「转发失败 → 后台探测 → 提示」');
      assert.equal(logs.some((l) => /^warn .*本机→上游（context7）/.test(l)), false, '不记成转发失败');

      /* 客户端自己降级到 initialize，之后一切照常 */
      const init: any = await (await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } } })).json();
      assert.equal(init.result.serverInfo.name, 'Context7');
      assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
      const list: any = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json();
      assert.equal(list.result.tools.length, 2);
      const call: any = await (await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'query-docs', arguments: {} } })).json();
      assert.equal(call.result.content[0].text, 'docs');
      assert.deepEqual(fails, []);
      assert.ok(oks.length >= 3);
      assert.equal(up.methods.filter((m) => m === 'initialize').length, 1, '没带 session id 的 400 不当会话失效：没有多余的重建');
    } finally { server.stop(); await up.close(); }
  });

  test('-32601 方法不存在（4xx + JSON-RPC 错误体）同样原样转回、不算不可用', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found' } });
    const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.writeHead(404, { 'content-type': 'application/json' }).end(body)); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const fails: string[] = [];
    const server = await startLocalMcp({ log: () => {}, notice: () => {}, onProxyFail: (_s, n) => fails.push(n) });
    try {
      const token = server.register({ sessionId: 's1', workdir: process.cwd() });
      server.setProxies('s1', [{ type: 'http', name: 'x', url: `http://127.0.0.1:${(srv.address() as any).port}/mcp` }]);
      const r = await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}/x`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'resources/templates/list' }) });
      assert.equal(r.status, 404);
      assert.equal(await r.text(), body);
      assert.deepEqual(fails, []);
    } finally { server.stop(); await new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }); }
  });

  test('只有网络错误 / 5xx 才算不可用：上游 503 → onProxyFail；连不上 → onProxyFail', async () => {
    const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.writeHead(503).end('busy')); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    const fails: string[] = [];
    const server = await startLocalMcp({ log: () => {}, notice: () => {}, onProxyFail: (_s, n) => fails.push(n) });
    try {
      const token = server.register({ sessionId: 's1', workdir: process.cwd() });
      server.setProxies('s1', [{ type: 'http', name: 'x', url: `http://127.0.0.1:${port}/mcp` }]);
      const call = () => fetch(`http://127.0.0.1:${server.port()}/mcp/${token}/x`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then((r) => r.json() as any);
      assert.ok((await call()).error);
      assert.deepEqual(fails, ['x'], '5xx 算');
      await new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
      assert.ok((await call()).error);
      assert.deepEqual(fails, ['x', 'x'], '连不上算');
    } finally { server.stop(); }
  });

  test('initialize 本身失败（没有 JSON-RPC 错误体的 4xx，例如 401）算不可用；别的请求 401 不算', async () => {
    const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.writeHead(401).end('no key')); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const p = new HttpProxy({ type: 'http', name: 'x', url: `http://127.0.0.1:${(srv.address() as any).port}/mcp` }, () => {});
      const a = await p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
      assert.equal(a.unavailable, true);
      const b = await p.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'q' } });
      assert.ok(b.error);
      assert.equal(b.unavailable, false);
    } finally { await new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }); }
  });

  test('正文里出现过本机密钥的，原样转回前抹掉', async () => {
    const SECRET = 'sk-c7-SECRET-1234567890';
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: `bad key header ${SECRET}` } })));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const p = new HttpProxy({ type: 'http', name: 'x', url: `http://127.0.0.1:${(srv.address() as any).port}/mcp`, headers: { 'x-api-key': SECRET } }, () => {});
      const r = await p.send({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
      assert.equal(r.passthrough?.status, 400);
      assert.equal(r.passthrough!.body.includes(SECRET), false);
      assert.equal(r.unavailable, false);
    } finally { await new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }); }
  });

  test('jsonRpcErrorBody：只认 JSON-RPC 错误回复（单条 / 一批），别的正文不算', () => {
    assert.ok(jsonRpcErrorBody(DISCOVER_400));
    assert.ok(jsonRpcErrorBody(JSON.stringify([{ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } }])));
    assert.equal(jsonRpcErrorBody('Bad Request'), null);
    assert.equal(jsonRpcErrorBody(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })), null);
    assert.equal(jsonRpcErrorBody(JSON.stringify({ error: 'x' })), null);
  });
});

describe('会话失效的重建只在确认时触发：这条请求带了 session id，且上游明确说会话无效 / 404', () => {
  test('没带 session id 的 400「No valid session ID」：原样转回，不重建', async () => {
    let inits = 0;
    const srv = http.createServer((req, res) => {
      let raw = ''; req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const m = JSON.parse(raw || '{}');
        if (m.method === 'initialize') inits++;
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const p = new HttpProxy({ type: 'http', name: 'x', url: `http://127.0.0.1:${(srv.address() as any).port}/mcp` }, () => {});
      const r = await p.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
      assert.equal(inits, 0, '没有会话可失效：不重建');
      assert.equal(r.passthrough?.status, 400);
      assert.equal(r.unavailable, false);
    } finally { await new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }); }
  });
});

describe('KiroLex 自己的探测 / 握手：不发 server/discover，直接 initialize', () => {
  test('probeHttpMcp 对一个拒绝 server/discover 的上游照样通过，而且从不发 server/discover', async () => {
    const up = await context7Like();
    try {
      const r = await probeHttpMcp({ type: 'http', name: 'context7', url: up.url });
      assert.equal(r.ok, true);
      assert.equal(r.toolCount, 2);
      assert.equal(up.methods.includes('server/discover'), false);
      assert.equal(up.methods[0], 'initialize');
    } finally { await up.close(); }
  });

  test('源码里 KiroLex 自己没有任何地方发 server/discover（探测、重建会话、续期都用 initialize）', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'localMcp.ts'), 'utf8');
    assert.equal(/method:\s*['"]server\/discover['"]/.test(src), false);
    const rf = src.slice(src.indexOf('private reinitialize('), src.indexOf('private reinitialize(') + 900);
    assert.match(rf, /method: 'initialize'/);
  });
});

describe('握手之后（带着 session id）上游回 404 + -32601：业务错误优先于会话失效', () => {
  test('经本机转发：客户端收到同样的 404 和正文；不额外 initialize；不 onProxyFail', async () => {
    const NOT_FOUND = JSON.stringify({ jsonrpc: '2.0', id: 5, error: { code: -32601, message: 'Method not found' } });
    const methods: string[] = [];
    const srv = http.createServer((req, res) => {
      let raw = ''; req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const m = JSON.parse(raw || '{}');
        methods.push(m.method);
        if (m.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-A' })
            .end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'up' } } }));
          return;
        }
        if (m.id === undefined) { res.writeHead(202).end(); return; }
        if (m.method === 'resources/templates/list') { res.writeHead(404, { 'content-type': 'application/json' }).end(NOT_FOUND); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'q', inputSchema: {} }] } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const fails: string[] = [];
    const server = await startLocalMcp({ log: () => {}, notice: () => {}, onProxyFail: (_s, n) => fails.push(n) });
    try {
      const token = server.register({ sessionId: 's1', workdir: process.cwd() });
      server.setProxies('s1', [{ type: 'http', name: 'x', url: `http://127.0.0.1:${(srv.address() as any).port}/mcp` }]);
      const post = (body: any) => fetch(`http://127.0.0.1:${server.port()}/mcp/${token}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cc', version: '1' } } });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const r = await post({ jsonrpc: '2.0', id: 5, method: 'resources/templates/list' });
      assert.equal(r.status, 404, 'HTTP 状态原样');
      assert.equal(await r.text(), NOT_FOUND, '正文原样');
      assert.equal(methods.filter((m) => m === 'initialize').length, 1, '没有额外的重建');
      assert.deepEqual(fails, [], '不算上游不可用');
      /* 同一会话之后照常 */
      const list: any = await (await post({ jsonrpc: '2.0', id: 6, method: 'tools/list' })).json();
      assert.equal(list.result.tools.length, 1);
      assert.equal(methods.filter((m) => m === 'initialize').length, 1);
    } finally { server.stop(); await new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }); }
  });

  test('真正的会话失效照旧重建：带 session id 的裸 404，以及 404 + 正文明确说会话不存在', async () => {
    for (const body of ['', JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } })]) {
      let inits = 0;
      let rejected = false;
      const srv = http.createServer((req, res) => {
        let raw = ''; req.on('data', (d) => { raw += d; });
        req.on('end', () => {
          const m = JSON.parse(raw || '{}');
          if (m.method === 'initialize') {
            inits++;
            res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `sess-${inits}` })
              .end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'up' } } }));
            return;
          }
          if (m.id === undefined) { res.writeHead(202).end(); return; }
          if (!rejected && req.headers['mcp-session-id'] === 'sess-1') { rejected = true; res.writeHead(404, body ? { 'content-type': 'application/json' } : {}).end(body); return; }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }));
        });
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
      try {
        const p = new HttpProxy({ type: 'http', name: 'x', url: `http://127.0.0.1:${(srv.address() as any).port}/mcp` }, () => {});
        await p.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
        const r = await p.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        assert.equal(r.error, null, `body=${JSON.stringify(body)}`);
        assert.deepEqual(r.answer.result.tools, []);
        assert.equal(inits, 2, '重建了一次');
      } finally { await new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }); }
    }
  });
});
