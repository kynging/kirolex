import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { probeHttpMcp, startLocalMcp } from '../src/main/localMcp.ts';
import {
  HTTP_PROBE_BACKOFF_MS, HTTP_PROBE_STEADY_MS, httpProbeDelay, probeUntilOk,
  forwardReconnectVerdict, retryUntilIdle, watchHttpForward, httpHandedNow, HTTP_FRESH_MS,
} from '../src/main/forwardReconnect.ts';
import { httpPendingNotice, httpForwardBackNotice, httpDroppedNotice } from '../src/main/forwardMcp.ts';
import { setUiLang } from '../src/main/uiText.ts';
import { NOTE_DETAIL_SEP } from '../src/main/kirolexNote.ts';

/*
 * 负责人 2026-10-24：HTTP 型转发 MCP 维持「不挡会话启动」，但探测没通过前不放进 mcpServers；
 * 后台按退避（2s/5s/15s/30s/60s，之后每 2 分钟）继续探测握手 + tools/list，通过后等会话空闲自动重连挂上，
 * 并在会话里说一句「X 已恢复可用」。
 *
 * 这里用真的 `probeHttpMcp` 打一个假的上游（起得慢 / 先拒后好），计时器换成很短的，
 * 后半段接上 index.ts 用的同一套「等空闲再重连」（`retryUntilIdle` + `forwardReconnectVerdict`）。
 */

type Upstream = { port: number; close: () => Promise<void> };
function startUpstream(port: number, healthy: () => boolean): Promise<Upstream> {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (!healthy()) { res.writeHead(401).end('bad key'); return; }
      const m = JSON.parse(raw || '{}');
      if (m.id === undefined) { res.writeHead(202).end(); return; }
      const result = m.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'up', version: '1' } }
        : { tools: [{ name: 'search', inputSchema: { type: 'object' } }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({
    port: (srv.address() as any).port,
    close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  })));
}
async function freePort(): Promise<number> {
  const u = await startUpstream(0, () => true);
  await u.close();
  return u.port;
}
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('等不到条件成立');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const fast = (fn: () => void) => { setTimeout(fn, 20); };
const base = { specCurrent: true, awaiting: true, deleted: false, quitting: false, attached: true, busy: false, reconfiguring: false };

describe('退避节奏', () => {
  test('2s / 5s / 15s / 30s / 60s，之后每 2 分钟', () => {
    assert.deepEqual(HTTP_PROBE_BACKOFF_MS, [2000, 5000, 15000, 30000, 60000]);
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 50].map(httpProbeDelay), [2000, 5000, 15000, 30000, 60000, 120000, 120000, 120000]);
    assert.equal(HTTP_PROBE_STEADY_MS, 120000);
  });
});

describe('上游慢启动 / 先失败后恢复：会话先起，稍后自动挂上', () => {
  test('上游慢启动（一开始连不上）：probeUntilOk 不挡调用方；起来后探测通过，会话空闲时重连恰好一次', async () => {
    const port = await freePort();
    const spec = { type: 'http' as const, name: 'websearch', url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 120_000 };
    const results: Array<{ ok: boolean; failures: number }> = [];
    let reconnects = 0;
    let busy = true;
    let returned = false;
    probeUntilOk({
      probe: () => probeHttpMcp(spec, { timeoutMs: 2000 }),
      alive: () => true,
      onResult: (r, failures) => {
        results.push({ ok: r.ok, failures });
        if (r.ok) retryUntilIdle(() => forwardReconnectVerdict({ ...base, busy }), () => { reconnects++; }, { setTimer: fast });
      },
      setTimer: fast,
    });
    returned = true;
    assert.equal(returned, true, '调用方（会话准备）不等探测');
    assert.equal(results.length, 0, '同步返回时一次探测都还没完成');

    await until(() => results.length >= 2);
    assert.ok(results.every((r) => !r.ok), '上游没起来时探测都失败');
    const up = await startUpstream(port, () => true);
    try {
      await until(() => results.some((r) => r.ok));
      const ok = results.find((r) => r.ok)!;
      assert.ok(ok.failures >= 2, '之前失败过几次');
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(reconnects, 0, '会话在忙：不打断');
      busy = false;
      await until(() => reconnects === 1);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(reconnects, 1, '只重连一次');
      const n = results.length;
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(results.length, n, '通过之后不再探');
    } finally { await up.close(); }
  });

  test('首次探测失败（上游拒绝）后恢复：下一次退避后的探测通过 → 自动挂上', async () => {
    let healthy = false;
    const up = await startUpstream(0, () => healthy);
    try {
      const spec = { type: 'http' as const, name: 'websearch', url: `http://127.0.0.1:${up.port}/mcp` };
      const results: Array<{ ok: boolean; failures: number; error?: string }> = [];
      let reconnects = 0;
      probeUntilOk({
        probe: () => probeHttpMcp(spec, { timeoutMs: 2000 }),
        alive: () => true,
        onResult: (r, failures) => {
          results.push({ ok: r.ok, failures, error: r.error });
          if (!r.ok && failures === 1) healthy = true;    // 第一次失败之后上游修好了
          if (r.ok) retryUntilIdle(() => forwardReconnectVerdict(base), () => { reconnects++; }, { setTimer: fast });
        },
        setTimer: fast,
      });
      await until(() => reconnects === 1);
      assert.equal(results[0].ok, false);
      assert.match(String(results[0].error), /401/);
      assert.equal(results[1].ok, true);
      assert.equal(results.length, 2);
    } finally { await up.close(); }
  });

  test('会话已换掉 / 删了（alive 假）：不再探、不报结果', async () => {
    let calls = 0;
    let alive = true;
    const seen: boolean[] = [];
    probeUntilOk({
      probe: async () => { calls++; if (calls === 2) alive = false; return { ok: false }; },
      alive: () => alive,
      onResult: (r) => seen.push(r.ok),
      setTimer: fast,
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls, 2);
    assert.deepEqual(seen, [false], '第二次拿到结果时已经不活了：不报');
  });
});

describe('接线：HTTP 型这次探测没通过前不交给执行器，后台探到通过、重连前再确认一次才挂上', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const at = M.indexOf('async function ensureLocalTools(');
  const body = M.slice(at, M.indexOf('\n}\n', at));
  const sw = M.slice(M.indexOf('function startHttpWatch('), M.indexOf('\n}\n', M.indexOf('function startHttpWatch(')));

  test('交不交看 forwardHandedNow：HTTP 只认 HTTP_FRESH_MS 内证实过是好的（历史上通过过不算）', () => {
    const fn = M.slice(M.indexOf('function forwardHandedNow('), M.indexOf('function forwardHandedNow(') + 300);
    assert.match(fn, /if \(isHttpForward\(e\)\) return httpHandedNow\(httpForwardOkAt\.get\(httpForwardKey\(e\)\), Date\.now\(\)\);/);
    assert.equal(/httpForwardOk\.has/.test(M), false, '不再有「历史上通过过就交」的那份缓存');
    assert.match(body, /const handed = entries\.filter\(\(e\) => forwardHandedNow\(e, notReady\)\);/);
    assert.match(body, /forwardedHttp: handed\.filter\(isHttpForward\)/);
    assert.match(body, /const handedK = forwardable\.filter\(\(e\) => forwardHandedNow\(e, notReady\)\);/);
    assert.match(body, /httpEntries: http,/);
    assert.match(body, /httpEntries: forwardable\.filter\(isHttpForward\),/);
  });

  test('每份 spec 每个名字一个看护（startHttpWatch）：失败作废新鲜度 + 登记等着挂上，挂着 / 没挂上说法不同', () => {
    assert.match(M, /function watchHttpForwards\([^)]*\): void \{\n  for \(const h of http\) startHttpWatch\(sessionId, spec, h, !!spec\.forwardedHttp\?\.includes\(h\.name\)\);/);
    assert.match(sw, /if \(watching\.has\(h\.name\)\) return;/);
    assert.match(sw, /watchHttpForward\(\{/);
    assert.match(sw, /alive: \(\) => localToolsBySession\.get\(sessionId\) === spec && !deletedSessionIds\.has\(sessionId\) && !isQuitting/);
    assert.match(sw, /markFresh: \(ok\) => markHttpFresh\(h, ok\)/);
    assert.match(sw, /addAwaiting: \(\) => \{ if \(!spec\.awaitingForward\?\.includes\(h\.name\)\) \(spec\.awaitingForward \|\|= \[\]\)\.push\(h\.name\); \}/);
    assert.match(sw, /isMounted \? httpDroppedNotice\(h\.name, r\.error \|\| ''\) : httpPendingNotice\(h\.name, r\.error \|\| ''\)/);
    assert.match(sw, /httpForwardBackNotice\(h\.name\)/);
    assert.match(sw, /done: \(\) => watching\.delete\(h\.name\)/);
  });

  test('重连前再探一次（等空闲可能等了很久）：通过才重连，没通过回到看护', () => {
    assert.match(sw, /reconnect: \(\) => reconnectForForward\(sessionId, h\.name, spec, \{\n\s*confirm: \(\) => probe\(\)\.then\(\(r\) => \{ markHttpFresh\(h, r\.ok\); return r\.ok; \}, \(\) => false\),\n\s*onConfirmFail: \(\) => startHttpWatch\(sessionId, spec, h, false\),/);
    const rf = M.slice(M.indexOf('function reconnectForForward('), M.indexOf('function reconnectForwardNow('));
    assert.match(rf, /if \(!ok\) \{ opts\.onConfirmFail\?\.\(\); return; \}/);
    assert.match(rf, /if \(v === 'go'\) reconnectForwardNow\(sessionId, name, lt\);/);
  });

  test('运行中掉线：onProxyFail → httpForwardFailed 作废新鲜度、起看护；onProxyOk 记新鲜、移出等着的名单（按需不重连）', () => {
    assert.match(M, /onProxyFail: httpForwardFailed,/);
    const ff = M.slice(M.indexOf('function httpForwardFailed('), M.indexOf('\n}\n', M.indexOf('function httpForwardFailed(')));
    assert.match(ff, /markHttpFresh\(h, false\);/);
    assert.match(ff, /startHttpWatch\(sessionId, lt, h, !!lt\.forwardedHttp\?\.includes\(name\)\);/);
    const fr = M.slice(M.indexOf('function forwardRecovered('), M.indexOf('function forwardRecovered(') + 900);
    assert.match(fr, /if \(h\) markHttpFresh\(h, true\);/);
    assert.match(fr, /lt\.awaitingForward = lt\.awaitingForward\.filter\(\(n\) => n !== name\)/);
  });
});

describe('新鲜度：历史上探测成功过、当前上游不可用 → 这次不交', () => {
  test('httpHandedNow：60 秒内证实过才交；更早的、没有的、作废的都不交', () => {
    const now = 1_000_000;
    assert.equal(HTTP_FRESH_MS, 60_000);
    assert.equal(httpHandedNow(now - 10_000, now), true);
    assert.equal(httpHandedNow(now - 60_000, now), true);
    assert.equal(httpHandedNow(now - 60_001, now), false, '历史上通过过不算');
    assert.equal(httpHandedNow(undefined, now), false);
  });

  test('上游 2 分钟前探通过、现在停了：不交；看护探测失败、继续作废；上游回来后探通，重连挂上', async () => {
    const port = await freePort();
    const spec = { type: 'http' as const, name: 'websearch', url: `http://127.0.0.1:${port}/mcp` };
    let lastOkAt: number | undefined = Date.now() - 120_000;
    assert.equal(httpHandedNow(lastOkAt, Date.now()), false, '这次准备先不交（上游其实已经停了）');
    const st = { awaiting: ['websearch'], failed: 0, reconnects: 0, results: [] as boolean[] };
    watchHttpForward({
      probe: () => probeHttpMcp(spec, { timeoutMs: 2000 }),
      alive: () => true,
      mounted: false,
      markFresh: (ok) => { lastOkAt = ok ? Date.now() : undefined; },
      addAwaiting: () => { if (!st.awaiting.includes('websearch')) st.awaiting.push('websearch'); },
      noteResult: (r) => { st.results.push(r.ok); return !r.ok; },
      noticeFailed: () => { st.failed++; },
      noticeBack: () => {},
      reconnect: () => { st.reconnects++; },
      setTimer: fast,
    });
    await until(() => st.results.length >= 2);
    assert.equal(lastOkAt, undefined, '探测失败：作废');
    assert.equal(st.failed, 1);
    assert.equal(st.reconnects, 0);
    const up = await startUpstream(port, () => true);
    try {
      await until(() => st.reconnects === 1);
      assert.equal(httpHandedNow(lastOkAt, Date.now()), true, '刚探通：重连那次准备直接交');
    } finally { await up.close(); }
  });
});

describe('watchHttpForward：先成功挂载 → 中途掉线 → 恢复（真的本机转发 + 假上游）', () => {
  function harness(spec: { type: 'http'; name: string; url: string }) {
    const st = { awaiting: [] as string[], failedNotices: [] as boolean[], backNotices: 0, reconnects: 0, probes: 0, fresh: true, watching: false };
    const start = (mounted: boolean) => {
      if (st.watching) return;
      st.watching = true;
      watchHttpForward({
        probe: () => { st.probes++; return probeHttpMcp(spec, { timeoutMs: 2000 }); },
        alive: () => true,
        mounted,
        markFresh: (ok) => { st.fresh = ok; },
        addAwaiting: () => { if (!st.awaiting.includes(spec.name)) st.awaiting.push(spec.name); },
        noteResult: (r) => !r.ok,
        noticeFailed: (_r, m) => { st.failedNotices.push(m); },
        noticeBack: () => { if (st.awaiting.includes(spec.name)) st.backNotices++; },
        reconnect: () => retryUntilIdle(
          () => forwardReconnectVerdict({ ...base, awaiting: st.awaiting.includes(spec.name) }),
          () => { st.reconnects++; st.awaiting = []; },
          { setTimer: fast },
        ),
        done: () => { st.watching = false; },
        setTimer: fast,
      });
    };
    return { st, start };
  }

  test('挂着用得好好的 → 上游停了：远端那次调用失败 → onProxyFail 起看护（说一次「连不上上游」）→ 上游回来 → 说「已恢复可用」、空闲时重连一次', async () => {
    const port = await freePort();
    let up = await startUpstream(port, () => true);
    const spec = { type: 'http' as const, name: 'websearch', url: `http://127.0.0.1:${port}/mcp` };
    const { st, start } = harness(spec);
    const fails: string[] = [];
    const oks: string[] = [];
    const server = await startLocalMcp({
      log: () => {}, notice: () => {},
      onProxyOk: (_sid, name) => { oks.push(name); st.fresh = true; },
      onProxyFail: (_sid, name, error) => { fails.push(`${name}: ${error}`); st.fresh = false; start(true); },
    });
    try {
      const token = server.register({ sessionId: 's1', workdir: process.cwd() });
      server.setProxies('s1', [spec]);
      const call = async (id: number) => (await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}/websearch`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }),
      })).json() as any;

      /* 先成功挂载、用了一次 */
      assert.ok((await call(1)).result);
      assert.deepEqual(oks, ['websearch']);
      assert.equal(st.probes, 0, '好好的时候不探');

      /* 中途掉线 */
      await up.close();
      const bad = await call(2);
      assert.ok(bad.error, '远端拿到明确的错误');
      assert.equal(fails.length, 1);
      assert.match(fails[0], /websearch/);
      assert.equal(st.fresh, false, '作废新鲜度：这时再准备会话不会把它直接交出去');
      await until(() => st.probes >= 2);
      assert.deepEqual(st.failedNotices, [true], '说一次，用「挂着的连不上上游」那句');
      assert.deepEqual(st.awaiting, ['websearch']);
      assert.ok((await call(3)).error);
      assert.equal(fails.length, 2);
      assert.equal(st.failedNotices.length, 1, '已经在看护：不重复起、不重复说');

      /* 恢复 */
      up = await startUpstream(port, () => true);
      await until(() => st.reconnects === 1);
      assert.equal(st.backNotices, 1);
      assert.equal(st.fresh, true);
      assert.equal(st.watching, false, '看护结束，下次掉线能再起');
    } finally {
      server.stop();
      await up.close();
    }
  });

  test('按需：恢复前远端自己已经调通（onProxyOk 把它移出等着的名单）→ 看护探通后不说、不重连', async () => {
    const port = await freePort();
    const spec = { type: 'http' as const, name: 'websearch', url: `http://127.0.0.1:${port}/mcp` };
    const { st, start } = harness(spec);
    start(true);
    await until(() => st.probes >= 1 && st.failedNotices.length === 1);
    const up = await startUpstream(port, () => true);
    try {
      st.awaiting = [];                // forwardRecovered：远端调通了
      await until(() => !st.watching);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(st.backNotices, 0);
      assert.equal(st.reconnects, 0);
    } finally { await up.close(); }
  });

  test('上游正常回了一个 JSON-RPC error（工具自己报错）：不算掉线，不起看护', async () => {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const m = JSON.parse(raw || '{}');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'bad args' } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const fails: string[] = [];
    const server = await startLocalMcp({ log: () => {}, notice: () => {}, onProxyFail: (_s, n) => fails.push(n) });
    try {
      const token = server.register({ sessionId: 's1', workdir: process.cwd() });
      server.setProxies('s1', [{ type: 'http', name: 'x', url: `http://127.0.0.1:${(srv.address() as any).port}/mcp` }]);
      const r: any = await (await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}/x`, {
        method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'q' } }),
      })).json();
      assert.equal(r.error.message, 'bad args');
      assert.deepEqual(fails, []);
    } finally {
      server.stop();
      await new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
    }
  });
});

describe('提示文案（docs/notices-glossary.md）', () => {
  test('中文：没通过 = 说清没挂它、会接着试、原因进详情；挂着掉线 = 调用会失败、恢复后说；通过 = 已恢复可用', () => {
    setUiLang('zh');
    const [main, detail] = httpPendingNotice('agentcore-websearch', '本机→上游（agentcore-websearch）HTTP 401').split(NOTE_DETAIL_SEP);
    assert.match(main, /^⚠️ 本机转发的 MCP「agentcore-websearch」暂时连不上，这条会话先不挂它/);
    assert.match(main, /自动挂上/);
    assert.equal(detail, '本机→上游（agentcore-websearch）HTTP 401');
    const [dm, dd] = httpDroppedNotice('agentcore-websearch', '连不上上游').split(NOTE_DETAIL_SEP);
    assert.match(dm, /^⚠️ 本机转发的 MCP「agentcore-websearch」现在连不上上游，调用它会失败/);
    assert.match(dm, /恢复后会说一声/);
    assert.equal(dd, '连不上上游');
    assert.match(httpForwardBackNotice('agentcore-websearch'), /^✅ 本机转发的 MCP「agentcore-websearch」已恢复可用/);
  });
});
