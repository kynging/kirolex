import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startLocalMcp, type LocalMcpDeps } from '../src/main/localMcp.ts';
import { forwardNotReadyNotice, forwardGaveUpNotice, forwardRestartingNotice, forwardReadyReconnectNotice, forwardStartingNotice } from '../src/main/forwardMcp.ts';
import { setUiLang } from '../src/main/uiText.ts';
import { forwardReconnectVerdict, retryUntilIdle, reconnectBlockedBy } from '../src/main/forwardReconnect.ts';
import { NOTE_DETAIL_SEP } from '../src/main/kirolexNote.ts';

/*
 * 「远程会话里从本机转发的 MCP（builder-mcp / agentcore-websearch）间歇连不上：CONNECT_TIMEOUT」
 *
 * 根因：转发的 stdio MCP 是**懒启动**的 —— 远端适配器的第一个 initialize 到了才 spawn 本机进程，
 * 进程起得慢（Windows 上经 cmd 起 builder-mcp 这类要十几到几十秒）就超过适配器的建连超时（Claude Code 默认 30 秒），
 * 而同一条隧道上的 kirolex-local 是进程内直接回的，所以它一直好好的。
 *
 * 这里用一个假的 stdio MCP 复现：它起来后要等 START_DELAY 毫秒才开始读 stdin，而且**严格**——
 * 没 initialize 就调别的方法会报错（真 MCP SDK 的行为），用来看出"进程重启后没重新握手"。
 */

const FAKE = [
  'const fs = require("fs");',
  'const delay = Number(process.env.START_DELAY || 0);',
  'if (process.env.SPAWN_LOG) fs.appendFileSync(process.env.SPAWN_LOG, process.pid + "\\n");',
  'if (process.env.EXIT_AT_ONCE) process.exit(3);',
  'let inited = false;',
  'const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
  'function handle(m) {',
  '  if (m.id === undefined) return;',
  '  if (m.method === "initialize") { inited = true; return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }); }',
  '  if (!inited) return out({ jsonrpc: "2.0", id: m.id, error: { code: -32002, message: "not initialized" } });',
  '  if (m.method === "tools/list") return out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "pid", inputSchema: { type: "object" } }, { name: "die", inputSchema: { type: "object" } }] } });',
  '  if (m.method === "tools/call" && m.params.name === "die") process.exit(1);',
  '  if (m.method === "tools/call" && m.params.name === "slow") return setTimeout(() => out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "slow" }] } }), 300);',
  '  if (m.method === "tools/call") return out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(process.pid) }] } });',
  '  out({ jsonrpc: "2.0", id: m.id, result: {} });',
  '}',
  'setTimeout(() => {',
  '  let buf = "";',
  '  process.stdin.on("data", (d) => {',
  '    buf += d;',
  '    let i;',
  '    while ((i = buf.indexOf("\\n")) >= 0) {',
  '      const line = buf.slice(0, i); buf = buf.slice(i + 1);',
  '      if (line.trim()) handle(JSON.parse(line));',
  '    }',
  '  });',
  '}, delay);',
  'setInterval(() => {}, 1 << 30);',
].join('\n');

function fakeMcp(): { dir: string; script: string; spawnLog: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwdready-'));
  const script = path.join(dir, 'fake.js');
  fs.writeFileSync(script, FAKE);
  return { dir, script, spawnLog: path.join(dir, 'spawns.txt') };
}
const spawns = (file: string): number => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).length : 0);

/** 像远端适配器那样连：每个请求带一个很短的超时（模拟 Claude Code 的 MCP 建连超时）。 */
async function rpc(url: string, body: any, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 202) return null;
  return res.json();
}

const ADAPTER_TIMEOUT_MS = 800;
const START_DELAY_MS = 1500;   // > 适配器超时
const quickRetry = { baseMs: 50, maxMs: 200, maxFails: 3 };

function makeDeps(states: Array<{ sessionId: string; name: string; state: string; reason?: string }>): LocalMcpDeps {
  return {
    log: () => {},
    notice: () => {},
    forwardRetry: quickRetry,
    onProxyState: (sessionId, name, state, reason) => { states.push({ sessionId, name, state, reason }); },
  };
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('等不到条件成立');
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe('转发的 stdio MCP：交给适配器之前先就绪', () => {
  test('复现：不预热时，慢启动（> 适配器超时）的 MCP 在第一个 initialize 上超时 —— 就是 CONNECT_TIMEOUT', async () => {
    const f = fakeMcp();
    const server = await startLocalMcp(makeDeps([]));
    try {
      const token = server.register({ sessionId: 's1', workdir: f.dir });
      server.setProxies('s1', [{ name: 'slowmcp', command: process.execPath, args: [f.script], env: { START_DELAY: String(START_DELAY_MS) } }]);
      const url = `http://127.0.0.1:${server.port()}/mcp/${token}/slowmcp`;
      await assert.rejects(
        rpc(url, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cc', version: '1' } } }, ADAPTER_TIMEOUT_MS),
        /timeout|abort/i,
      );
    } finally { server.stop(); }
  });

  test('readyProxies 等它握手 + tools/list 通过；之后适配器用很短的超时也能连上、拿到工具', async () => {
    const f = fakeMcp();
    const states: any[] = [];
    const server = await startLocalMcp(makeDeps(states));
    try {
      const token = server.register({ sessionId: 's1', workdir: f.dir });
      server.setProxies('s1', [{ name: 'slowmcp', command: process.execPath, args: [f.script], env: { START_DELAY: String(START_DELAY_MS) } }]);
      const ready = await server.readyProxies('s1', { deadlineMs: 10_000 });
      assert.deepEqual(ready.map((r) => [r.name, r.ok, r.toolCount]), [['slowmcp', true, 2]]);
      assert.ok(states.some((s) => s.name === 'slowmcp' && s.state === 'up'));

      const url = `http://127.0.0.1:${server.port()}/mcp/${token}/slowmcp`;
      const init = await rpc(url, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cc', version: '1' } } }, ADAPTER_TIMEOUT_MS);
      assert.equal(init.id, 0, 'id 照远端发的配回去');
      assert.equal(init.result.serverInfo.name, 'fake', '回的是那个 MCP 自己的 initialize 结果');
      assert.equal(await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, ADAPTER_TIMEOUT_MS), null);
      const list = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, ADAPTER_TIMEOUT_MS);
      assert.deepEqual(list.result.tools.map((t: any) => t.name), ['pid', 'die']);
      const call = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pid', arguments: {} } }, ADAPTER_TIMEOUT_MS);
      assert.match(call.result.content[0].text, /^\d+$/);
      assert.equal(spawns(f.spawnLog), 0, '没设 SPAWN_LOG 时不记');
    } finally { server.stop(); }
  });

  test('远端重连复用同一个 JSON-RPC id 也不串：并发两条 id 相同的请求各拿各的答复', async () => {
    const f = fakeMcp();
    const server = await startLocalMcp(makeDeps([]));
    try {
      const token = server.register({ sessionId: 's1', workdir: f.dir });
      server.setProxies('s1', [{ name: 'm', command: process.execPath, args: [f.script] }]);
      assert.equal((await server.readyProxies('s1', { deadlineMs: 10_000 }))[0].ok, true);
      const url = `http://127.0.0.1:${server.port()}/mcp/${token}/m`;
      const [a, b] = await Promise.all([
        rpc(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'slow', arguments: {} } }, 5000),
        rpc(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'pid', arguments: {} } }, 5000),
      ]);
      assert.equal(a.id, 5);
      assert.equal(b.id, 5);
      assert.equal(a.result.content[0].text, 'slow');
      assert.match(b.result.content[0].text, /^\d+$/);
    } finally { server.stop(); }
  });

  test('起不来（一起就退）：按退避重试几次，最后报不可用和原因，不是一直挂着', async () => {
    const f = fakeMcp();
    const states: any[] = [];
    const server = await startLocalMcp(makeDeps(states));
    try {
      server.register({ sessionId: 's1', workdir: f.dir });
      server.setProxies('s1', [{ name: 'broken', command: process.execPath, args: [f.script], env: { EXIT_AT_ONCE: '1', SPAWN_LOG: f.spawnLog } }]);
      const [r] = await server.readyProxies('s1', { deadlineMs: 8000 });
      assert.equal(r.ok, false);
      assert.match(String(r.error), /code 3/);
      assert.equal(spawns(f.spawnLog), quickRetry.maxFails, '按 maxFails 重试，每次都是新进程');
      assert.ok(states.some((s) => s.name === 'broken' && s.state === 'failed'));
    } finally { server.stop(); }
  });

  test('一直没就绪（还在慢慢起）：到期限报"还没起来"，但进程不杀，起来之后照样能用', async () => {
    const f = fakeMcp();
    const states: any[] = [];
    const server = await startLocalMcp(makeDeps(states));
    try {
      const token = server.register({ sessionId: 's1', workdir: f.dir });
      server.setProxies('s1', [{ name: 'slowmcp', command: process.execPath, args: [f.script], env: { START_DELAY: '1200', SPAWN_LOG: f.spawnLog } }]);
      const [r] = await server.readyProxies('s1', { deadlineMs: 300 });
      assert.equal(r.ok, false);
      assert.equal(r.starting, true, '期限到了它还在起：调用方据此说"还在启动"');
      await until(() => states.some((s) => s.name === 'slowmcp' && s.state === 'up'));
      assert.equal(spawns(f.spawnLog), 1, '没因为等得久就杀掉重起');
      const url = `http://127.0.0.1:${server.port()}/mcp/${token}/slowmcp`;
      const list = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, ADAPTER_TIMEOUT_MS);
      assert.equal(list.result.tools.length, 2);
    } finally { server.stop(); }
  });
});

describe('中途掉线：本机 MCP 进程退出后自动拉起、重新握手', () => {
  test('进程退了：自动重起（不用等下一次调用），新进程先握手，远端之后的调用照常', async () => {
    const f = fakeMcp();
    const states: any[] = [];
    const server = await startLocalMcp(makeDeps(states));
    try {
      const token = server.register({ sessionId: 's1', workdir: f.dir });
      server.setProxies('s1', [{ name: 'm', command: process.execPath, args: [f.script], env: { SPAWN_LOG: f.spawnLog } }]);
      assert.equal((await server.readyProxies('s1', { deadlineMs: 10_000 }))[0].ok, true);
      const url = `http://127.0.0.1:${server.port()}/mcp/${token}/m`;
      await rpc(url, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cc', version: '1' } } }, 2000);
      const pid1 = (await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pid', arguments: {} } }, 2000)).result.content[0].text;

      const died = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'die', arguments: {} } }, 5000);
      assert.ok(died.error, '正在跑的那次调用拿到明确的错误，而不是挂着');
      assert.equal(died.id, 2);
      assert.ok(states.some((s) => s.name === 'm' && s.state === 'down'), '退出要报出来');

      await until(() => spawns(f.spawnLog) === 2 && states.filter((s) => s.name === 'm' && s.state === 'up').length === 2);
      /* 远端还拿着原来那条 MCP 连接（不会再发 initialize）：新进程必须已经被我们握过手，否则严格的 server 会回 not initialized */
      const after = await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pid', arguments: {} } }, 2000);
      assert.equal(after.error, undefined, JSON.stringify(after));
      assert.notEqual(after.result.content[0].text, pid1, '是新拉起的那个进程');
    } finally { server.stop(); }
  });

  test('重连 / 重新准备时同一份配置不重起进程（setProxies 复用还活着的那个）', async () => {
    const f = fakeMcp();
    const server = await startLocalMcp(makeDeps([]));
    try {
      server.register({ sessionId: 's1', workdir: f.dir });
      const spec = { name: 'm', command: process.execPath, args: [f.script], env: { SPAWN_LOG: f.spawnLog } };
      server.setProxies('s1', [spec]);
      assert.equal((await server.readyProxies('s1', { deadlineMs: 10_000 }))[0].ok, true);
      server.setProxies('s1', [{ ...spec }]);
      const r = await server.readyProxies('s1', { deadlineMs: 10_000 });
      assert.equal(r[0].ok, true);
      assert.equal(spawns(f.spawnLog), 1, '同一份配置：还是那一个进程');
      server.setProxies('s1', [{ ...spec, args: [f.script, '--other'] }]);
      assert.equal((await server.readyProxies('s1', { deadlineMs: 10_000 }))[0].ok, true);
      assert.equal(spawns(f.spawnLog), 2, '配置变了才换');
    } finally { server.stop(); }
  });

  test('执行器重建（forget 再 setProxies）前先 parkProxies：热着的进程留给新执行器', async () => {
    const f = fakeMcp();
    const server = await startLocalMcp(makeDeps([]));
    try {
      server.register({ sessionId: 's1', workdir: f.dir });
      const spec = { name: 'm', command: process.execPath, args: [f.script], env: { SPAWN_LOG: f.spawnLog } };
      server.setProxies('s1', [spec]);
      assert.equal((await server.readyProxies('s1', { deadlineMs: 10_000 }))[0].ok, true);
      server.parkProxies('s1');
      server.forget('s1');
      server.register({ sessionId: 's1', workdir: f.dir });
      server.setProxies('s1', [{ ...spec }]);
      assert.equal((await server.readyProxies('s1', { deadlineMs: 10_000 }))[0].ok, true);
      assert.equal(spawns(f.spawnLog), 1);
    } finally { server.stop(); }
  });
});

describe('接线：远程会话先等转发的 stdio MCP 就绪，再交给执行器（Claude Code / Codex 和 Kiro 两个分支）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const at = M.indexOf('async function ensureLocalTools(');
  const body = M.slice(at, M.indexOf('\n}\n', at));
  const nonKiro = body.slice(body.indexOf("if (engineOf(profile) !== 'kiro') {"), body.indexOf('const forwardable = profile.kiroAgent'));
  const kiro = body.slice(body.indexOf('const forwardable = profile.kiroAgent'));

  test('gateForwardStdio：await readyProxies，返回没就绪的那些；3 秒没好状态行说一句', () => {
    const fn = M.slice(M.indexOf('async function gateForwardStdio('), M.indexOf('function noteForwardNotReady('));
    assert.match(fn, /await server\.readyProxies\(sessionId\)/);
    assert.match(fn, /forwardStartingNotice\(stdioNames\)/);
    assert.match(fn, /forwardGating\.delete\(sessionId\)/);
    const note = M.slice(M.indexOf('function noteForwardNotReady('), M.indexOf('function noteForwardNotReady(') + 1200);
    assert.match(note, /markForwardUnavailable\(spec, n\.name, n\.reason\)/);
    assert.match(note, /noteInSession\(sessionId, forwardNotReadyNotice\(n\.name, n\.reason, n\.starting\)/);
  });

  test('Claude Code / Codex：setProxies → 等就绪 → 只把就绪的拼进 mcpServers', () => {
    const set = nonKiro.indexOf('server.setProxies(sessionId, localEntries);');
    const ready = nonKiro.indexOf('gateForwardStdio(server, sessionId, localEntries');
    const servers = nonKiro.indexOf('mcpServers: [mcp, ...remoteComboMcpServers(handed,');
    assert.ok(set >= 0 && ready > set && servers > ready, '顺序：setProxies → 等就绪 → 才拼 mcpServers');
    assert.match(nonKiro, /awaitingForward: \[\s*\.\.\.notReady\.filter\(\(n\) => n\.starting\)\.map\(\(n\) => n\.name\),\s*\.\.\.http\.filter\(\(h\) => !handed\.includes\(h\)\)/);
    assert.ok(nonKiro.indexOf('noteForwardNotReady(server, sessionId, spec, notReady)') > nonKiro.indexOf('localToolsBySession.set(sessionId, spec)'));
  });

  test('Kiro：setProxies → 等就绪 → 只把就绪的写进远端 agent（remoteForwardPlan 拿过滤后的）', () => {
    const set = kiro.indexOf('server.setProxies(sessionId, forwardable);');
    const ready = kiro.indexOf('await gateForwardStdio(server, sessionId,');
    const plan = kiro.indexOf('const plan = { ...remoteForwardPlan(handedK,');
    const write = kiro.indexOf('remoteAgentScript(');
    assert.ok(set >= 0 && ready > set && plan > ready && write > plan, '顺序：setProxies → 等就绪 → 拼计划 → 写远端 agent');
    assert.match(kiro, /awaitingForward: \[\s*\.\.\.notReady\.filter\(\(n\) => n\.starting\)\.map\(\(n\) => n\.name\),\s*\.\.\.forwardable\.filter\(isHttpForward\)\.filter\(\(h\) => !handedK\.includes\(h\)\)/);
    assert.ok(kiro.indexOf('noteForwardNotReady(server, sessionId, spec, notReady)') > kiro.indexOf('localToolsBySession.set(sessionId, spec)'));
  });

  test('本机工具服务接上 onProxyState；后来就绪的一直等到空闲，先停放进程再断开、走断线恢复接回来', () => {
    assert.match(M, /onProxyState: forwardProxyState,/);
    const fn = M.slice(M.indexOf('function reconnectForForward('), M.indexOf('type ForwardNotReady'));
    assert.match(fn, /retryUntilIdle\(/);
    assert.match(fn, /forwardReconnectVerdict\(/);
    /* 忙不忙跟着 busyReasonFor（含后端自己起的那一轮 entry.autonomous），不是只看 entry.busy */
    assert.match(fn, /busy: reconnectBlockedBy\(busyReasonFor\(sessionId\)\)/);
    assert.equal(/busy: !!entry\?\.busy/.test(fn), false);
    const br = M.slice(M.indexOf('function busyReasonFor('), M.indexOf('function emitSessionBusy('));
    assert.match(br, /if \(entry\?\.busy \|\| entry\?\.autonomous\) return 'turn';/);
    assert.equal(/tries/.test(fn), false, '不再有次数上限');
    const park = fn.indexOf('parkProxies(sessionId)');
    const detach = fn.indexOf('detachExecutor(sessionId)');
    assert.ok(park >= 0 && detach > park, '先 park 再 detach，否则重连又要冷启动');
    assert.match(fn, /startRemoteRecovery\(sessionId, \{ quiet: true \}\)/);
    const st = M.slice(M.indexOf('function forwardProxyState('), M.indexOf('function reconnectForForward('));
    assert.match(st, /forwardGaveUpNotice\(/);
    assert.match(st, /forwardRestartingNotice\(/);
    assert.match(st, /forwardRecovered\(sessionId, name\)/);
  });
});

describe('后来就绪：会话忙多久都等，空闲了才重连（retryUntilIdle + forwardReconnectVerdict）', () => {
  const base = { specCurrent: true, awaiting: true, deleted: false, quitting: false, attached: true, busy: false, reconfiguring: false };

  test('判据：忙 / 没连着 / 换执行器中 = 等；spec 换了 / 删了 / 退出 / 不在等着的名单 = 放弃；否则做', () => {
    assert.equal(forwardReconnectVerdict(base), 'go');
    assert.equal(forwardReconnectVerdict({ ...base, busy: true }), 'wait');
    assert.equal(forwardReconnectVerdict({ ...base, attached: false }), 'wait');
    assert.equal(forwardReconnectVerdict({ ...base, reconfiguring: true }), 'wait');
    assert.equal(forwardReconnectVerdict({ ...base, specCurrent: false }), 'cancel');
    assert.equal(forwardReconnectVerdict({ ...base, deleted: true, busy: true }), 'cancel');
    assert.equal(forwardReconnectVerdict({ ...base, quitting: true }), 'cancel');
    assert.equal(forwardReconnectVerdict({ ...base, awaiting: false }), 'cancel');
  });

  test('一轮跑了 10 分钟（远超 165 秒）：一直有下一次检查，空闲后重连恰好一次', () => {
    const timers: Array<() => void> = [];
    let now = 0;
    let busyUntil = 600_000;
    let runs = 0;
    retryUntilIdle(
      () => forwardReconnectVerdict({ ...base, busy: now < busyUntil }),
      () => { runs++; },
      { intervalMs: 15_000, setTimer: (fn, ms) => { timers.push(() => { now += ms; fn(); }); } },
    );
    let fired = 0;
    while (timers.length) { timers.shift()!(); fired++; if (fired > 1000) break; }
    assert.equal(runs, 1, '空闲后做了重连');
    assert.equal(fired, 40, '忙的 600 秒里每 15 秒看一次，第 40 次看到空闲');
    assert.equal(timers.length, 0, '做完不再排');
  });

  test('等的过程中会话删了：不再排、不重连', () => {
    const timers: Array<() => void> = [];
    let ticks = 0;
    let runs = 0;
    retryUntilIdle(
      () => forwardReconnectVerdict({ ...base, busy: true, deleted: ticks >= 3 }),
      () => { runs++; },
      { setTimer: (fn) => { timers.push(() => { ticks++; fn(); }); } },
    );
    while (timers.length) timers.shift()!();
    assert.equal(runs, 0);
    assert.equal(ticks, 3);
  });
});

describe('提示文案（docs/notices-glossary.md：说清是谁、为什么在详情、怎么办）', () => {

  test('中文：带上 MCP 名字，原因进详情', () => {
    setUiLang('zh');
    const a = forwardNotReadyNotice('builder-mcp', 'builder-mcp 退出了（code 1）', true);
    const [main, detail] = a.split(NOTE_DETAIL_SEP);
    assert.match(main, /^⚠️ 本机转发的 MCP「builder-mcp」还在启动/);
    assert.match(main, /自动重连/);
    assert.equal(detail, 'builder-mcp 退出了（code 1）');
    assert.match(forwardNotReadyNotice('x', 'r', false), /起不来.*检查它的命令/);
    assert.match(forwardGaveUpNotice('x', 'r'), /^⚠️ .*反复退出.*下次调用它时会再试/);
    assert.match(forwardRestartingNotice('x'), /^⏳ /);
    assert.match(forwardReadyReconnectNotice('x'), /^⏳ .*重连/);
    assert.match(forwardStartingNotice(['a', 'b']), /a、b/);
  });
});

describe('后端自己起的那一轮（autonomous）在跑：MCP 恢复了也不断开执行器，那一轮结束后才重连一次', () => {
  const base = { specCurrent: true, awaiting: true, deleted: false, quitting: false, attached: true, reconfiguring: false };

  test('reconnectBlockedBy：turn / priming / attaching / creating / reconfiguring 都挡；空闲和 prime-pending 不挡', () => {
    for (const r of ['turn', 'priming', 'attaching', 'creating', 'reconfiguring']) assert.equal(reconnectBlockedBy(r), true, r);
    assert.equal(reconnectBlockedBy(null), false);
    assert.equal(reconnectBlockedBy(undefined), false);
    assert.equal(reconnectBlockedBy('prime-pending'), false);
  });

  test('模拟一条 entry：busy=false 但 autonomous 在跑 —— 一直等；autonomous 收尾后重连恰好一次', () => {
    /* 和 index.ts busyReasonFor 同一条规则：entry.busy || entry.autonomous → 'turn' */
    const entry: { busy: boolean; autonomous?: object } = { busy: false, autonomous: { startedAt: 0 } };
    const reasonFor = () => (entry.busy || entry.autonomous ? 'turn' : null);
    const timers: Array<() => void> = [];
    let detached = 0;
    let ticks = 0;
    retryUntilIdle(
      () => forwardReconnectVerdict({ ...base, busy: reconnectBlockedBy(reasonFor()) }),
      () => { detached++; },
      { setTimer: (fn) => { timers.push(() => { ticks++; if (ticks === 5) delete entry.autonomous; fn(); }); } },
    );
    assert.equal(detached, 0, 'autonomous 那一轮在跑：MCP 恢复的那一刻不能断开执行器');
    while (timers.length) timers.shift()!();
    assert.equal(ticks, 5, '每 15 秒看一次，第 5 次看到那一轮结束了');
    assert.equal(detached, 1, '结束后重连恰好一次');
  });
});
