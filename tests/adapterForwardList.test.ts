import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adapterForwardPlan, remoteComboMcpServers, localKiroMcpSources, type ForwardListItem,
} from '../src/main/forwardMcp.ts';
import type { McpComboServer } from '../src/main/mcpCombos.ts';
import { remoteContextBlock } from '../src/main/remoteContext.ts';

/*
 * Claude Code / Codex 远程会话：设置里「远程会话从本机转发的 MCP」名单也要生效
 * （以前只看所选组合，没选组合 = 内置「通用」= 空，于是只剩 kirolex-local）。
 * 名单只存名字，定义从本机 Kiro 的 agent 文件 / ~/.kiro/settings/mcp.json 里找；
 * 组合里同名的以组合为准。两个引擎走的是同一条非 Kiro 分支、同一个函数。
 */

const TUNNEL = 'http://127.0.0.1:39100/mcp/0123456789abcdef0123456789abcdef';
const LIST: ForwardListItem[] = [
  { name: 'playwright', timeoutSec: 180 },
  { name: 'miaoxiang', timeoutSec: 240 },
];
/* 和 index.ts 非 Kiro 分支拼 mcpServers 的方式一样（那一行由下面的源码扫描钉住） */
const adapterRemoteMcpServers = (base: string, entries: any[]) => [
  { type: 'http', name: 'kirolex-local', url: base, headers: [] as never[] }, ...remoteComboMcpServers(entries, base),
];
const KIRO_SOURCES = [{
  from: '~/.kiro/agents/aws.json',
  servers: {
    playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
    miaoxiang: { url: 'https://mx.example.com/mcp', headers: { k: '${env:MX_KEY}' } },
    unlisted: { command: '/usr/local/bin/thing' },
  },
}];

describe('adapterForwardPlan：没选组合（内置「通用」是空的）', () => {
  const plan = adapterForwardPlan({ comboServers: {}, list: LIST, sources: KIRO_SOURCES, env: {} });
  const servers = adapterRemoteMcpServers(TUNNEL, plan.entries);

  test('mcpServers = kirolex-local + 名单里的那几个（只有隧道地址）', () => {
    assert.deepEqual(servers.map((s) => s.name), ['kirolex-local', 'playwright', 'miaoxiang']);
    assert.equal(servers[0].url, TUNNEL);
    assert.equal(servers[1].url, `${TUNNEL}/playwright`);
    for (const s of servers) { assert.equal(s.type, 'http'); assert.deepEqual(s.headers, []); }
    assert.deepEqual(plan.skipped, []);
  });

  test('名单外的不转发（这条路只认名单，不像 Kiro 那样按本机路径自动挑）', () => {
    assert.equal(plan.entries.some((e) => e.name === 'unlisted'), false);
  });

  test('http 型：上游 url / 头只在本机那份 entries 里，超时取名单的', () => {
    const mx: any = plan.entries.find((e) => e.name === 'miaoxiang');
    assert.equal(mx.type, 'http');
    assert.equal(mx.url, 'https://mx.example.com/mcp');
    assert.equal(mx.timeoutMs, 240_000);
    const wire = JSON.stringify(servers);
    assert.equal(wire.includes('mx.example.com'), false);
    assert.equal(wire.includes('MX_KEY'), false);
  });

  test('来源记下来（名单 / 组合），给会话信息用', () => {
    assert.deepEqual(plan.fromList, ['playwright', 'miaoxiang']);
    assert.deepEqual(plan.fromCombo, []);
  });
});

describe('adapterForwardPlan：有组合 → 合并、按名字去重，同名以组合为准', () => {
  const combo: Record<string, McpComboServer> = {
    playwright: { command: 'C:\\tools\\pw.exe', args: ['--combo'] },          // 组合里的定义赢
    drawio: { command: 'npx', args: ['drawio-mcp'], forwardFromLocal: true }, // 组合独有
  };
  const plan = adapterForwardPlan({ comboServers: combo, list: LIST, sources: KIRO_SOURCES, env: {} });
  const names = plan.entries.map((e) => e.name);

  test('每个名字只出现一次', () => {
    assert.deepEqual([...names].sort(), ['drawio', 'miaoxiang', 'playwright']);
    assert.equal(new Set(names).size, names.length);
  });

  test('同名用组合那份定义', () => {
    const pw: any = plan.entries.find((e) => e.name === 'playwright');
    assert.equal(pw.command, 'C:\\tools\\pw.exe');
    assert.deepEqual(pw.args, ['--combo']);
    assert.deepEqual(plan.fromCombo.sort(), ['drawio', 'playwright']);
    assert.deepEqual(plan.fromList, ['miaoxiang']);
  });

  test('组合里有、但没标「从本机转发」的 http：名单点了名 → 也转发（用组合的定义，env 在本机展开）', () => {
    const p = adapterForwardPlan({
      comboServers: { miaoxiang: { url: 'https://combo.example.com/mcp', headers: { k: '${env:K}' } } },
      list: LIST, sources: KIRO_SOURCES, env: { K: 'v' },
    });
    const mx: any = p.entries.find((e) => e.name === 'miaoxiang');
    assert.equal(mx.url, 'https://combo.example.com/mcp');
    assert.deepEqual(mx.headers, { k: 'v' });
  });

  test('组合里关掉的同名项：不从名单补回来，记为跳过并说原因', () => {
    const p = adapterForwardPlan({
      comboServers: { playwright: { command: 'npx', disabled: true } },
      list: LIST, sources: KIRO_SOURCES, env: {},
    });
    assert.equal(p.entries.some((e) => e.name === 'playwright'), false);
    const s = p.skipped.find((x) => x.name === 'playwright');
    assert.ok(s && s.origin === 'list' && s.reason);
  });
});

describe('adapterForwardPlan：名单里起不来的要说原因', () => {
  test('哪儿都没有定义 / 定义里 disabled / 既没 command 也没 url / 名字进不了隧道 URL / 和 kirolex-local 撞名', () => {
    const p = adapterForwardPlan({
      comboServers: {},
      list: [
        { name: 'ghost', timeoutSec: 180 }, { name: 'off', timeoutSec: 180 },
        { name: 'empty', timeoutSec: 180 }, { name: 'bad name', timeoutSec: 180 },
        { name: 'kirolex-local', timeoutSec: 180 },
      ],
      sources: [{ from: 'mcp.json', servers: { off: { command: 'x', disabled: true }, empty: {}, 'bad name': { command: 'x' }, 'kirolex-local': { command: 'x' } } }],
      env: {},
    });
    assert.deepEqual(p.entries, []);
    assert.deepEqual(p.skipped.map((s) => s.name), ['ghost', 'off', 'empty', 'bad name', 'kirolex-local']);
    for (const s of p.skipped) { assert.equal(s.origin, 'list'); assert.ok(s.reason, `${s.name} 要有原因`); }
  });

  test('多个来源都定义了同名：取排在前面的（会话自己的 agent 在最前）', () => {
    const p = adapterForwardPlan({
      comboServers: {}, list: [{ name: 'pw', timeoutSec: 180 }], env: {},
      sources: [{ from: 'a', servers: { pw: { command: 'first' } } }, { from: 'b', servers: { pw: { command: 'second' } } }],
    });
    assert.equal((p.entries[0] as any).command, 'first');
  });
});

describe('localKiroMcpSources：从本机 Kiro 配置里找定义', () => {
  let home = '';
  afterEach(() => { if (home) fs.rmSync(home, { recursive: true, force: true }); home = ''; });

  test('顺序：会话的 agent → ~/.kiro/settings/mcp.json → 其余 agent（按名字）；跳过 kirolex-local-* 和坏文件', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-fwdsrc-'));
    const agents = path.join(home, '.kiro', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.mkdirSync(path.join(home, '.kiro', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(agents, 'b.json'), JSON.stringify({ mcpServers: { x: { command: 'b' } } }));
    fs.writeFileSync(path.join(agents, 'a.json'), JSON.stringify({ mcpServers: { x: { command: 'a' } } }));
    fs.writeFileSync(path.join(agents, 'mine.json'), JSON.stringify({ mcpServers: { x: { command: 'mine' } } }));
    fs.writeFileSync(path.join(agents, 'kirolex-local-s_1.json'), JSON.stringify({ mcpServers: { x: { command: 'no' } } }));
    fs.writeFileSync(path.join(agents, 'broken.json'), '{not json');
    fs.writeFileSync(path.join(home, '.kiro', 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'global' } } }));
    const src = localKiroMcpSources(home, 'mine');
    assert.deepEqual(src.map((s) => s.servers.x.command), ['mine', 'global', 'a', 'b']);
  });

  test('没有 ~/.kiro：空表，不抛', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-fwdsrc-'));
    assert.deepEqual(localKiroMcpSources(home), []);
  });
});

describe('运行环境说明：碰本机的东西用 local_bash，列出这次转发过来的 MCP', () => {
  const t = remoteContextBlock({ hostLabel: 'ec2', remoteDir: '/home/u/w', localDir: 'C:\\u', forwarded: ['playwright'], forwardedHttp: ['miaoxiang'] });

  test('看板客户端 127.0.0.1:9333、board-cdp.mjs、~/agent-board、~/.kirolex 都点名，并说用 local_bash', () => {
    assert.match(t, /127\.0\.0\.1:9333/);
    assert.match(t, /~\/\.kirolex\/tools\/board-cdp\.mjs/);
    assert.match(t, /~\/agent-board/);
    assert.match(t, /`~\/\.kirolex`/);
    assert.match(t, /local_bash/);
  });

  test('列出这次实际接过来的本机工具：kirolex-local + 转发的名字', () => {
    assert.match(t, /这一轮从用户机器接过来的工具.*`kirolex-local`.*`playwright`.*`miaoxiang`/);
  });

  test('没有转发时也说清只有 kirolex-local', () => {
    const t2 = remoteContextBlock({ hostLabel: 'ec2', remoteDir: '/home/u/w', localDir: 'C:\\u' });
    assert.match(t2, /这一轮从用户机器接过来的工具.*只有 `kirolex-local`/);
  });

  test('没有本地工程时也要说（看板客户端照样在他机器上）', () => {
    const t3 = remoteContextBlock({ hostLabel: 'ec2', remoteDir: '/home/u/w', localDir: 'C:\\u', hasLocalProject: false });
    assert.match(t3, /127\.0\.0\.1:9333/);
  });
});

describe('接线（源码扫描）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const at = M.indexOf('async function ensureLocalTools(');
  const body = M.slice(at, M.indexOf('\n}\n', at));
  const nonKiro = body.slice(body.indexOf("if (engineOf(profile) !== 'kiro') {"), body.indexOf('const forwardable = profile.kiroAgent'));

  test('非 Kiro 分支（Claude Code 和 Codex 共用）：读名单、合并组合，kirolex-local + 转发项交给 mcpServers', () => {
    assert.match(body, /if \(engineOf\(profile\) !== 'kiro'\) \{/);
    assert.match(nonKiro, /loadForwardMcpList\(\)/);
    assert.match(nonKiro, /const \{ entries, skipped, fromCombo, fromList, notForwarded \} = adapterForwardPlan\(/);
    assert.match(nonKiro, /localKiroMcpSources\(/);
    assert.match(nonKiro, /server\.setProxies\(sessionId, entries\);/);
    assert.match(nonKiro, /const mcp = \{ type: 'http', name: 'kirolex-local', url: mcpUrl\(remotePort, urlPath\), headers: \[\] \};/);
    assert.match(nonKiro, /mcpServers: \[mcp, \.\.\.remoteComboMcpServers\(entries, mcpUrl\(remotePort, urlPath\)\)\]/);
    assert.match(nonKiro, /转发本机 MCP 给 sessionId=/);
  });

  test('Kiro 分支不变：仍是 forwardableFrom(localAgentJson(...), loadForwardMcpList())', () => {
    assert.match(body, /const forwardable = profile\.kiroAgent \? forwardableFrom\(localAgentJson\(profile\.kiroAgent\), loadForwardMcpList\(\)\) : \[\];/);
  });

  test('会话信息带上本机工具（acp:session-info 回 localTools）', () => {
    const h = M.indexOf("ipcMain.handle('acp:session-info'");
    const handler = M.slice(h, M.indexOf('\n  });\n', h));
    assert.match(handler, /localTools:/);
  });
});

describe('会话信息：这条会话实际拿到了哪些本机工具', async () => {
  const { sessionInfoRows, sessionInfoText } = await import('../src/renderer/sessionInfo.ts');
  const t = (k: string, v?: Record<string, string | number>) => k.replace(/\{(\w+)\}/g, (_m, n) => String(v?.[n] ?? ''));
  const base = { id: 's_1_abcdef', engine: 'codex' as const, remote: { label: 'box', sshHost: 'u@h' } };

  test('准备好了：列出 kirolex-local + 转发的，跳过的带原因', () => {
    const rows = sessionInfoRows({ ...base, localTools: { state: 'ready', forwarded: ['playwright', 'miaoxiang'], skipped: [{ name: 'ghost', reason: 'no definition' }] } }, t);
    const row = rows.find((r) => r.key === 'tools');
    assert.ok(row);
    assert.match(row!.value, /kirolex-local.*playwright.*miaoxiang/);
    assert.match(row!.value, /ghost.*no definition/);
    assert.equal(row!.copy, 'kirolex-local, playwright, miaoxiang');
    assert.match(sessionInfoText({ ...base, localTools: { state: 'ready', forwarded: ['playwright'], skipped: [] } }), /^localTools=kirolex-local,playwright$/m);
  });

  test('还没连上 / 通道没起来：说清楚，不留白、没东西可复制', () => {
    for (const state of ['not-ready', 'failed'] as const) {
      const row = sessionInfoRows({ ...base, localTools: { state, forwarded: [], skipped: [] } }, t).find((r) => r.key === 'tools');
      assert.ok(row && row.value.length > 0);
      assert.equal(row!.copy, '');
    }
  });

  test('本地会话没有这一行', () => {
    assert.equal(sessionInfoRows({ id: 'x', localTools: null }, t).some((r) => r.key === 'tools'), false);
  });
});
