import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  adapterForwardPlan, comboHttpDirect, forwardableFromCombo, notForwardedNotice, notForwardedWhy,
  remoteDirectMcpServers, remoteComboMcpServers, httpDirectProbeNotice,
} from '../src/main/forwardMcp.ts';
import { remoteHttpProbeScript, parseRemoteProbe } from '../src/main/remoteMcpPlace.ts';
import { setUiLang, trIn } from '../src/main/uiText.ts';
import { sessionInfoRows, sessionInfoText } from '../src/renderer/sessionInfo.ts';

/*
 * 远程 Claude Code / Codex 会话：组合里没标 forwardFromLocal 的 http MCP（context7 这类公开地址）
 * 像 Kiro 远程那条一样交给远端适配器自己连；头里用了 `${env:…}` 的不直连（会把本机密钥送到远端）。
 */

const CONTEXT7 = 'https://mcp.context7.com/mcp';
const TUNNEL = 'http://127.0.0.1:39100/mcp/0123456789abcdef0123456789abcdef';
const DIRECT_FAIL = '⚠️ The MCP "{name}" is unavailable: {host} (where this session runs) can\'t reach it ({error}). If only this computer can reach that address, add "forwardFromLocal": true to it in 🧩 MCP profiles and reopen the session; KiroLex then sends its requests from this computer.';
const ENV_WHY = 'Its URL or headers use environment variables of this computer (${env:…}), and keys from this computer\'s environment are not sent to the remote machine by default. Marked forwardFromLocal, KiroLex sends its requests from this computer and the key stays here. Adding it to the "forward from this machine" list in Settings works too.';
/* 英文原文和中文各看一遍（tr() 按当前界面语言出字，测完换回默认的中文） */
const inEn = <T>(fn: () => T): T => { setUiLang('en'); try { return fn(); } finally { setUiLang('zh'); } };
const plan = (comboServers: any, env: Record<string, string> = {}) => adapterForwardPlan({ comboServers, list: [], sources: [], env });

describe('comboHttpDirect：能不能交给远端直连（纯函数）', () => {
  test('没头 / 头里没有 env 引用 → 能', () => {
    assert.equal(comboHttpDirect({ url: CONTEXT7 }), true);
    assert.equal(comboHttpDirect({ url: CONTEXT7, headers: { 'X-Client': 'kirolex' } }), true);
  });
  test('头里有 ${env:…} → 不能', () => {
    assert.equal(comboHttpDirect({ url: CONTEXT7, headers: { Authorization: 'Bearer ${env:X}' } }), false);
  });
  test('url 里有 ${env:…} → 不能（同样会把本机的值送出去）', () => {
    assert.equal(comboHttpDirect({ url: 'https://x.example/mcp?key=${env:K}' }), false);
  });
  test('标了 forwardFromLocal / 关掉的 / 不是 http 的 → 不算直连', () => {
    assert.equal(comboHttpDirect({ url: CONTEXT7, forwardFromLocal: true }), false);
    assert.equal(comboHttpDirect({ url: CONTEXT7, disabled: true }), false);
    assert.equal(comboHttpDirect({ command: 'npx' }), false);
  });
});

describe('adapterForwardPlan：http 三种情况', () => {
  test('{url}（无 header）→ 直连项，不进 notForwarded、不进本机转发', () => {
    const p = plan({ context7: { url: CONTEXT7 } });
    assert.deepEqual(p.direct, [{ name: 'context7', url: CONTEXT7, headers: {} }]);
    assert.deepEqual(p.notForwarded, []);
    assert.deepEqual(p.entries, []);
    assert.deepEqual(p.skipped, []);
  });

  test('不带 env 引用的 header 原样带上', () => {
    const p = plan({ pub: { url: ' https://p.example/mcp ', headers: { 'X-Client': 'kirolex' } } });
    assert.deepEqual(p.direct, [{ name: 'pub', url: 'https://p.example/mcp', headers: { 'X-Client': 'kirolex' } }]);
  });

  test('{url, headers:{Authorization:"Bearer ${env:X}"}} → 不直连、进 notForwarded，原因是 env 密钥', () => {
    const p = plan({ secret: { url: CONTEXT7, headers: { Authorization: 'Bearer ${env:X}' } } }, { X: 'sk-local' });
    assert.deepEqual(p.direct, []);
    assert.deepEqual(p.entries, []);
    assert.deepEqual(p.notForwarded, [{ name: 'secret', kind: 'http' }]);
    const why = inEn(() => notForwardedWhy(p.notForwarded[0]));
    assert.equal(why, ENV_WHY);
    assert.match(why, /environment variable/);
    assert.match(why, /forwardFromLocal/);
    assert.match(trIn('zh', ENV_WHY), /带本机环境变量的密钥默认不发到远端机器/);
    /* 本机的值一个字都不出现在直连项里 */
    assert.equal(JSON.stringify(p.direct).includes('sk-local'), false);
  });

  test('{url, forwardFromLocal:true} → 本机代发不变', () => {
    const p = plan({ mx: { url: CONTEXT7, forwardFromLocal: true } });
    assert.deepEqual(p.direct, []);
    assert.deepEqual(p.notForwarded, []);
    assert.equal(p.entries.length, 1);
    assert.equal((p.entries[0] as any).type, 'http');
    assert.equal((p.entries[0] as any).url, CONTEXT7);
  });

  test('设置名单里点了名的 http 按「从本机转发」算，不直连', () => {
    const p = adapterForwardPlan({ comboServers: { c7: { url: CONTEXT7 } }, list: [{ name: 'c7', timeoutSec: 180 }], sources: [], env: {} });
    assert.deepEqual(p.direct, []);
    assert.deepEqual(p.entries.map((e) => e.name), ['c7']);
  });

  test('和 kirolex-local 重名的不直连，记为跳过', () => {
    const p = plan({ 'kirolex-local': { url: CONTEXT7 } });
    assert.deepEqual(p.direct, []);
    assert.deepEqual(p.skipped.map((s) => s.name), ['kirolex-local']);
  });

  test('forwardableFromCombo 也带出 direct（关掉的不算）', () => {
    const r = forwardableFromCombo({ a: { url: CONTEXT7 }, off: { url: CONTEXT7, disabled: true } }, {});
    assert.deepEqual(r.direct.map((d) => d.name), ['a']);
  });
});

describe('remoteDirectMcpServers：交给适配器的直连项', () => {
  test('url 原样（不是隧道地址），头转成 [{name,value}]', () => {
    const p = plan({ context7: { url: CONTEXT7 }, pub: { url: 'https://p.example/mcp', headers: { 'X-Client': 'k' } } });
    const servers = remoteDirectMcpServers(p.direct);
    assert.deepEqual(servers, [
      { type: 'http', name: 'context7', url: CONTEXT7, headers: [] },
      { type: 'http', name: 'pub', url: 'https://p.example/mcp', headers: [{ name: 'X-Client', value: 'k' }] },
    ]);
    for (const s of servers) assert.equal(s.url.startsWith(TUNNEL), false);
    /* 转发项照旧只拿隧道地址 */
    assert.deepEqual(remoteComboMcpServers(p.entries, TUNNEL), []);
  });
});

describe('提示文案', () => {
  test('notForwardedWhy：只剩 stdio 不在本机 / 带 env 密钥的 http 两种', () => {
    const http = inEn(() => notForwardedWhy({ name: 'x', kind: 'http' }));
    const stdio = inEn(() => notForwardedWhy({ name: 'x', kind: 'stdio' }));
    assert.notEqual(http, stdio);
    assert.match(stdio, /stdio/);
    assert.equal(/only when it is marked forwardFromLocal/.test(http), false, '不再说「http 只有标了才带进去」');
    assert.match(notForwardedNotice({ name: 'x', kind: 'http' }, 'P'), /forwardFromLocal/);
    assert.notEqual(trIn('zh', ENV_WHY), ENV_WHY, 'http 那句有中文');
  });

  test('httpDirectProbeNotice：说清是远端机器连不上，提示可改标 forwardFromLocal', () => {
    const t = inEn(() => httpDirectProbeNotice('context7', 'tokyo-graviton', 'HTTP 503'));
    assert.match(t, /tokyo-graviton \(where this session runs\) can't reach it/);
    assert.match(t, /context7/);
    assert.match(t, /tokyo-graviton/);
    assert.match(t, /HTTP 503/);
    assert.match(t, /forwardFromLocal/);
    const zh = trIn('zh', DIRECT_FAIL, { name: 'context7', host: 'tokyo-graviton', error: 'HTTP 503' });
    assert.notEqual(zh, t);
    assert.match(zh, /tokyo-graviton.*连不上/);
    assert.match(zh, /forwardFromLocal/);
  });
});

describe('remoteHttpProbeScript：远端自己敲一次 initialize', () => {
  test('用 curl POST initialize，带上头，地址原样；结果走 parseRemoteProbe', () => {
    const s = remoteHttpProbeScript({ name: 'pub', url: CONTEXT7, headers: { 'X-Client': "it's" } });
    assert.match(s, /curl/);
    assert.ok(s.includes(`'${CONTEXT7}'`));
    assert.ok(s.includes(`'X-Client: it'\\''s'`));
    assert.match(s, /"method":"initialize"/);
    assert.match(s, /KXPROBE ok/);
    assert.match(s, /KXPROBE fail/);
    assert.deepEqual(parseRemoteProbe('KXPROBE fail HTTP 404'), { ok: false, toolCount: 0, error: 'HTTP 404' });
  });
});

describe('会话信息：如实显示「远端直连」', () => {
  const base = { id: 's_1', engine: 'claude' as const, remote: { label: 'tokyo', sshHost: 'tokyo' } };
  const tt = (k: string, v?: Record<string, string | number>) => k.replace(/\{(\w+)\}/g, (_m, n) => String(v?.[n] ?? ''));
  test('直连的列出来并标明；探测失败的按不可用显示', () => {
    const rows = sessionInfoRows({ ...base, localTools: { state: 'ready', forwarded: ['mx'], direct: ['context7'], skipped: [] } }, tt);
    const tools = rows.find((r) => r.key === 'tools')!;
    assert.match(tools.value, /context7 \(direct from the remote machine\)/);
    assert.match(tools.value, /mx/);
    const down = sessionInfoRows({ ...base, localTools: { state: 'ready', forwarded: [], direct: ['context7'], skipped: [], unavailable: [{ name: 'context7', reason: 'HTTP 503' }] } }, tt);
    const v = down.find((r) => r.key === 'tools')!.value;
    assert.equal(/direct from the remote machine/.test(v), false);
    assert.match(v, /context7 \(unavailable: HTTP 503\)/);
  });
  test('「全部复制」里单独一行 direct=', () => {
    const text = sessionInfoText({ ...base, localTools: { state: 'ready', forwarded: [], direct: ['context7'], skipped: [] } });
    assert.match(text, /\ndirectMcp=context7/);
  });
});

describe('接线（源码扫描）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const at = M.indexOf('async function ensureLocalTools(');
  const body = M.slice(at, M.indexOf('\n}\n', at));
  const nonKiro = body.slice(body.indexOf("if (engineOf(profile) !== 'kiro') {"), body.indexOf('const forwardable = profile.kiroAgent'));
  test('直连项追加进 mcpServers、记进 spec.direct、后台在远端探测（不 await）', () => {
    assert.match(nonKiro, /\.\.\.remoteDirectMcpServers\(direct\)/);
    assert.match(nonKiro, /direct: direct\.map\(\(d\) => d\.name\)/);
    assert.match(nonKiro, /\n\s*watchDirectHttp\(sessionId, spec, remote, direct\);/);
    const fn = M.slice(M.indexOf('function watchDirectHttp('), M.indexOf('\n}\n', M.indexOf('function watchDirectHttp(')));
    assert.match(fn, /remoteHttpProbeScript\(/);
    assert.match(fn, /httpDirectProbeNotice\(/);
    assert.match(fn, /markForwardUnavailable\(/);
  });
  test('会话信息带上 direct', () => {
    assert.match(M, /direct: lt\.direct \|\| \[\]/);
  });
});
