import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import http from 'node:http';
import { HttpProxy, startLocalMcp, sessionGoneText, HTTP_SESSION_RENEW_IDLE_MS } from '../src/main/localMcp.ts';
import { watchHttpForward, HTTP_FLAP_QUIET_MS } from '../src/main/forwardReconnect.ts';

/*
 * 「HTTP 转发 MCP（context7）大约每 18 分钟报一次 HTTP 400，然后又『已恢复可用』」
 *
 * 一个**有状态**的 Streamable HTTP 上游：initialize 发 Mcp-Session-Id，之后要求带上；会话空闲超过 TTL 就作废，
 * 再带着旧 id 来就回 400 + JSON-RPC 错误体（MCP TS SDK 的写法）。
 */
type Up = { url: string; inits: () => number; rejects: () => number; reqs: Array<{ method?: string; sid?: string }>; close: () => Promise<void> };
async function statefulUpstream(opts: { ttlMs: number; body?: string }): Promise<Up> {
  let seq = 0;
  let inits = 0;
  let rejects = 0;
  const live = new Map<string, number>();   // sid -> lastUsed
  const reqs: Array<{ method?: string; sid?: string }> = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const m = JSON.parse(raw || '{}');
      const sid = String(req.headers['mcp-session-id'] || '') || undefined;
      reqs.push({ method: m.method, sid });
      if (m.method === 'initialize') {
        inits++;
        const s = `s${++seq}`;
        live.set(s, Date.now());
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': s })
          .end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'up' } } }));
        return;
      }
      const last = sid ? live.get(sid) : undefined;
      if (last === undefined || Date.now() - last > opts.ttlMs) {
        if (sid) live.delete(sid);
        rejects++;
        res.writeHead(400, { 'content-type': 'application/json' })
          .end(opts.body ?? JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID provided' }, id: null }));
        return;
      }
      live.set(sid!, Date.now());
      if (m.id === undefined) { res.writeHead(202).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'tools/list' ? { tools: [{ name: 'q', inputSchema: {} }] } : { content: [{ type: 'text', text: 'ok' }] } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(srv.address() as any).port}/mcp`,
    inits: () => inits, rejects: () => rejects, reqs,
    close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('上游会话过期（400「session 失效」）：转发层透明重建，引擎和用户无感', () => {
  test('经本机转发：会话过期后的那次调用 → 自动重新 initialize、换新 session id、重放成功；不触发 onProxyFail', async () => {
    const up = await statefulUpstream({ ttlMs: 150 });
    const fails: string[] = [];
    const oks: string[] = [];
    const server = await startLocalMcp({ log: () => {}, notice: () => {}, onProxyFail: (_s, n, e) => fails.push(`${n}:${e}`), onProxyOk: (_s, n) => oks.push(n) });
    try {
      const token = server.register({ sessionId: 's1', workdir: process.cwd() });
      server.setProxies('s1', [{ type: 'http', name: 'context7', url: up.url }]);
      const post = async (body: any) => {
        const r = await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}/context7`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return r.status === 202 ? null : r.json() as any;
      };
      await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } } });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.length, 1);
      await sleep(300);   // 上游会话过期
      const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'q', arguments: {} } });
      assert.equal(r.id, 2, 'id 原样配回');
      assert.equal(r.result.content[0].text, 'ok', '重放成功，远端拿到正常结果');
      assert.equal(up.rejects(), 1, '旧 id 被拒了一次');
      assert.equal(up.inits(), 2, '透明地重新 initialize 了一次');
      const calls = up.reqs.filter((q) => q.method === 'tools/call');
      assert.equal(calls.length, 2, '这次调用：带旧 id 被拒一次 + 带新 id 重放一次');
      assert.notEqual(calls[0].sid, calls[1].sid, '换了新 session id');
      assert.deepEqual(fails, [], '不进「转发失败 → 后台探测」');
      assert.ok(oks.includes('context7'));
    } finally { server.stop(); await up.close(); }
  });

  test('watchHttpForward 不会被起：没有 onProxyFail 就没有探测、没有提示（由上一条保证）；重建后仍失败才算转发失败', async () => {
    /* 上游重建会话也立刻作废（TTL 0）：重放还是 400 → 这才交给 onProxyFail */
    const up = await statefulUpstream({ ttlMs: -1 });
    const fails: string[] = [];
    const server = await startLocalMcp({ log: () => {}, notice: () => {}, onProxyFail: (_s, n) => fails.push(n) });
    try {
      const token = server.register({ sessionId: 's1', workdir: process.cwd() });
      server.setProxies('s1', [{ type: 'http', name: 'context7', url: up.url }]);
      const post = async (body: any) => (await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}/context7`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })).json() as any;
      /* 先握手拿到 session id（第 8 轮起，没带 session id 的 400 不算会话失效，见下面的 server/discover 那组） */
      await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cc', version: '1' } } });
      const r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.ok(r.error);
      assert.equal(up.inits(), 2, '重建了一次');
      assert.deepEqual(fails, ['context7'], '重建后仍被拒：这才算上游不可用');
    } finally { server.stop(); await up.close(); }
  });

  test('「Server not initialized」（换到了不认识这条会话的上游实例）也算会话失效', () => {
    assert.equal(sessionGoneText('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}'), true);
    assert.equal(sessionGoneText('Bad Request: No valid session ID provided'), true);
    assert.equal(sessionGoneText('Bad Request: Mcp-Session-Id header is required'), true);
    assert.equal(sessionGoneText('Invalid argument sessionDate'), false, '参数错误不算');
    assert.equal(sessionGoneText('Bad Request: Unsupported protocol version: 1999-01-01'), false);
  });

  test('上游回「Server not initialized」：重建一次再重放，成功', async () => {
    const up = await statefulUpstream({ ttlMs: 150, body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Server not initialized' }, id: null }) });
    try {
      const p = new HttpProxy({ type: 'http', name: 'c7', url: up.url }, () => {});
      await p.call({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
      await sleep(300);
      const r = await p.call({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
      assert.equal(r.result.tools.length, 1);
      assert.equal(up.inits(), 2);
    } finally { await up.close(); }
  });
});

describe('空闲续期：空闲超过阈值后，下一次请求前先重新 initialize（不等真实请求撞上过期）', () => {
  test('默认阈值 10 分钟，比实测的上游会话寿命（约 18 分钟）短', () => {
    assert.equal(HTTP_SESSION_RENEW_IDLE_MS, 10 * 60_000);
  });

  test('空闲超过阈值：先续期（新 session id），真实请求一次就成功，上游一次都没拒', async () => {
    const up = await statefulUpstream({ ttlMs: 250 });
    try {
      const logs: string[] = [];
      const p = new HttpProxy({ type: 'http', name: 'c7', url: up.url }, (_l, m) => logs.push(m), { renewIdleMs: 100 });
      await p.call({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
      assert.equal((await p.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.length, 1);
      await sleep(400);   // 比续期阈值久，也比上游寿命久
      const r = await p.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.equal(r.result.tools.length, 1);
      assert.equal(up.rejects(), 0, '续期在真实请求之前：上游没拒过');
      assert.equal(up.inits(), 2);
      assert.equal(up.reqs.filter((q) => q.method === 'tools/list').length, 2, '真实请求只发了一次');
      assert.ok(logs.some((l) => /空闲.*续期/.test(l)), '日志里记一笔');
    } finally { await up.close(); }
  });

  test('没空闲那么久：不续期', async () => {
    const up = await statefulUpstream({ ttlMs: 10_000 });
    try {
      const p = new HttpProxy({ type: 'http', name: 'c7', url: up.url }, () => {}, { renewIdleMs: 5_000 });
      await p.call({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
      await p.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      await p.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.equal(up.inits(), 1);
    } finally { await up.close(); }
  });
});

describe('诊断：上游非 2xx 时日志里记方法和错误的类别（正文本身不进日志）', () => {
  test('400 不支持的协议版本 → 记「协议版本」类，正文原文不出现', async () => {
    const srv = http.createServer((req, res) => {
      let raw = ''; req.on('data', (d) => { raw += d; });
      req.on('end', () => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Unsupported protocol version: 1999-01-01 secret-xyz' }, id: null })));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const logs: string[] = [];
      const p = new HttpProxy({ type: 'http', name: 'c7', url: `http://127.0.0.1:${(srv.address() as any).port}/mcp` }, (_l, m) => logs.push(m));
      const r = await p.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.ok(r.error);
      const line = logs.find((l) => /HTTP 400/.test(l) && /tools\/list/.test(l));
      assert.ok(line, logs.join('\n'));
      assert.match(line!, /协议版本/);
      assert.match(line!, /-32000/);
      assert.equal(logs.some((l) => l.includes('secret-xyz')), false, '正文不进日志');
    } finally { await new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }); }
  });
});

describe('提示限频：同一 MCP 短时间失败又恢复，不插提示', () => {
  test(`挂着的上游失败、${HTTP_FLAP_QUIET_MS / 1000} 秒内恢复：不说「连不上」、不说「已恢复可用」、不重连`, async () => {
    let n = 0;
    const st = { failed: 0, back: 0, reconnects: 0, fresh: [] as boolean[] };
    let t = 0;
    watchHttpForward({
      probe: async () => ({ ok: ++n >= 3 }),       // 失败两次，第三次通过
      alive: () => true,
      mounted: true,
      markFresh: (ok) => st.fresh.push(ok),
      addAwaiting: () => {},
      noteResult: (r) => !r.ok,
      noticeFailed: () => { st.failed++; },
      noticeBack: () => { st.back++; },
      reconnect: () => { st.reconnects++; },
      now: () => t,
      setTimer: (fn, ms) => { t += ms; setTimeout(fn, 0); },
    });
    await sleep(50);
    assert.equal(n, 3);
    assert.ok(t < HTTP_FLAP_QUIET_MS, '模拟时间里不到静默窗口');
    assert.deepEqual([st.failed, st.back, st.reconnects], [0, 0, 0]);
    assert.deepEqual(st.fresh, [false, false, true], '状态照记（新鲜度、不可用），只是不插提示');
  });

  test('一直连不上超过静默窗口：说一次「连不上」；之后恢复：说「已恢复可用」并重连', async () => {
    let n = 0;
    const st = { failed: 0, back: 0, reconnects: 0 };
    let t = 0;
    watchHttpForward({
      probe: async () => ({ ok: ++n >= 7 }),
      alive: () => true,
      mounted: true,
      markFresh: () => {},
      addAwaiting: () => {},
      noteResult: (r) => !r.ok,
      noticeFailed: () => { st.failed++; },
      noticeBack: () => { st.back++; },
      reconnect: () => { st.reconnects++; },
      now: () => t,
      setTimer: (fn, ms) => { t += ms; setTimeout(fn, 0); },
    });
    await sleep(80);
    assert.equal(n, 7);
    assert.deepEqual([st.failed, st.back, st.reconnects], [1, 1, 1]);
  });

  test('没挂上的（准备时没交）一探就通：不说「已恢复可用」（用户没见过它坏），但照样重连挂上', async () => {
    const st = { back: 0, reconnects: 0 };
    watchHttpForward({
      probe: async () => ({ ok: true }),
      alive: () => true,
      mounted: false,
      markFresh: () => {},
      addAwaiting: () => {},
      noteResult: () => false,
      noticeFailed: () => {},
      noticeBack: () => { st.back++; },
      reconnect: () => { st.reconnects++; },
    });
    await sleep(20);
    assert.deepEqual([st.back, st.reconnects], [0, 1]);
  });
});

describe('接线：「已恢复可用 / 又能用了」只在说过「连不上」之后说', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  test('看护越过静默窗口说「连不上」时记下；看护探通 / 远端先调通，谁先到谁取走记录并说，没记录不说', () => {
    const sw = M.slice(M.indexOf('function startHttpWatch('), M.indexOf('\n}\n', M.indexOf('function startHttpWatch(')));
    assert.match(sw, /noteHttpNoticed\(spec, h\.name, true\);/);
    assert.match(sw, /noticeBack: \(\) => \{ if \(noteHttpNoticed\(spec, h\.name, false\) && /);
    const fr = M.slice(M.indexOf('function forwardRecovered('), M.indexOf('\n}\n', M.indexOf('function forwardRecovered(')));
    assert.match(fr, /if \(h && !httpNoticed\.get\(lt\)\?\.delete\(name\)\) return;/);
    assert.ok(fr.indexOf('if (h && !httpNoticed') < fr.indexOf("works again"), '先判断再说');
  });
});
