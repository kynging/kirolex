import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forwardableFromCombo, remoteComboMcpServers, FORWARD_TIMEOUT_SEC_DEFAULT } from '../src/main/forwardMcp.ts';
import type { McpComboServer } from '../src/main/mcpCombos.ts';
import { remoteContextBlock } from '../src/main/remoteContext.ts';

/*
 * Claude Code / Codex 远程会话：组合里标了「从本机转发」的 MCP 经本机中转。
 * 远端适配器拿到的 mcpServers 只有隧道地址 —— 上游 url、头、env、密钥一个字都不出本机。
 */

const UPSTREAM = 'https://mxapi.eastmoney.com/mxds/mcp';
const KEY = 'sk-live-abcdef1234567890';
const ENV = { EM_API_KEY: KEY, TOKEN: 'tok-secret-998877' };
const TUNNEL = 'http://127.0.0.1:39100/mcp/0123456789abcdef0123456789abcdef';

const COMBO: Record<string, McpComboServer> = {
  miaoxiang: { url: UPSTREAM, headers: { em_api_key: '${env:EM_API_KEY}' }, forwardFromLocal: true, timeoutSec: 240 },
  plain_http: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
  playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
  localpath: { command: 'C:\\Users\\k\\node.exe', args: ['srv.js'] },
  marked_stdio: { command: 'uvx', args: ['thing'], env: { TOKEN: '${env:TOKEN}' }, forwardFromLocal: true },
  remote_stdio: { command: 'builder-mcp', args: ['--x'] },
  off: { url: 'https://off.example.com/mcp', forwardFromLocal: true, disabled: true },
};

describe('forwardableFromCombo：按规则挑', () => {
  const { entries, skipped } = forwardableFromCombo(COMBO, ENV);
  const names = entries.map((e) => e.name);

  test('标了的 http 中转；没标的 http、disabled 的不出现', () => {
    assert.ok(names.includes('miaoxiang'));
    assert.equal(names.includes('plain_http'), false);
    assert.equal(names.includes('off'), false);
    assert.deepEqual(skipped, []);
  });

  test('http 规格：上游 url、展开后的头、超时取 timeoutSec（默认 180 秒）', () => {
    const mx: any = entries.find((e) => e.name === 'miaoxiang');
    assert.equal(mx.type, 'http');
    assert.equal(mx.url, UPSTREAM);
    assert.deepEqual(mx.headers, { em_api_key: KEY });
    assert.equal(mx.timeoutMs, 240_000);
    const d: any = forwardableFromCombo({ m: { url: UPSTREAM, forwardFromLocal: true } }, {}).entries[0];
    assert.equal(d.timeoutMs, FORWARD_TIMEOUT_SEC_DEFAULT * 1000);
  });

  test('stdio：标了的、本机路径命令、FORWARD_BY_NAME 转发；其余不出现', () => {
    assert.ok(names.includes('playwright'));
    assert.ok(names.includes('localpath'));
    assert.ok(names.includes('marked_stdio'));
    assert.equal(names.includes('remote_stdio'), false);
    const s: any = entries.find((e) => e.name === 'marked_stdio');
    assert.equal(s.command, 'uvx');
    assert.deepEqual(s.args, ['thing']);
    assert.deepEqual(s.env, { TOKEN: 'tok-secret-998877' });
  });

  test('环境变量缺了 / 名字不能进 URL / 和本地工具通道重名：跳过并说明', () => {
    const r = forwardableFromCombo({
      a: { url: UPSTREAM, headers: { k: '${env:NOPE}' }, forwardFromLocal: true },
      '妙想': { url: UPSTREAM, forwardFromLocal: true },
      'kirolex-local': { command: '/bin/x' },
    }, {});
    assert.deepEqual(r.entries, []);
    assert.deepEqual(r.skipped.map((s) => s.name), ['a', '妙想', 'kirolex-local']);
    assert.deepEqual(r.skipped[0].missing, ['NOPE']);
    assert.ok(r.skipped[1].reason);
    assert.ok(r.skipped[2].reason);
  });
});

describe('remoteComboMcpServers：远端只拿到隧道地址', () => {
  const { entries } = forwardableFromCombo(COMBO, ENV);
  const servers = remoteComboMcpServers(entries, TUNNEL);

  test('每条都是 {type:http, name, url: 隧道/<名字>, headers: []}', () => {
    assert.deepEqual(servers.map((s) => s.name).sort(), ['localpath', 'marked_stdio', 'miaoxiang', 'playwright']);
    for (const s of servers) {
      assert.deepEqual(Object.keys(s).sort(), ['headers', 'name', 'type', 'url']);
      assert.equal(s.type, 'http');
      assert.equal(s.url, `${TUNNEL}/${s.name}`);
      assert.deepEqual(s.headers, []);
    }
  });

  test('序列化后不含上游 url、头名、env、密钥、命令', () => {
    const text = JSON.stringify(servers);
    for (const bad of [UPSTREAM, 'mxapi', 'em_api_key', KEY, KEY.slice(0, 8), 'tok-secret', 'TOKEN', 'env:', 'npx', 'node.exe', 'example.com']) {
      assert.equal(text.includes(bad), false, `远端 mcpServers 里出现了 ${bad}`);
    }
  });
});

describe('模型提示：非 Kiro 引擎同样注入', () => {
  test('forwarded / forwardedHttp 都说出来', () => {
    const t = remoteContextBlock({ hostLabel: 'ec2', remoteDir: '/home/u/w', localDir: 'C:\\u', forwarded: ['playwright'], forwardedHttp: ['miaoxiang'] });
    assert.match(t, /`playwright`/);
    assert.match(t, /`miaoxiang`/);
    assert.match(t, /从用户那台机器发出/);
    assert.match(t, /不要\*\*在这台机器上另配/);
  });
});

describe('接线（源码扫描）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const at = M.indexOf('async function ensureLocalTools(');
  const body = M.slice(at, M.indexOf('\n}\n', at));
  const nonKiro = body.slice(body.indexOf("if (engineOf(profile) !== 'kiro') {"), body.indexOf('const forwardable = profile.kiroAgent'));

  test('非 Kiro 分支：读组合、setProxies、隧道地址追加进 mcpServers、填 forwarded', () => {
    assert.match(nonKiro, /forwardableFromCombo\(/);
    assert.match(nonKiro, /server\.setProxies\(sessionId, /);
    assert.match(nonKiro, /remoteComboMcpServers\(/);
    assert.match(nonKiro, /forwardedHttp/);
    assert.equal(/forwarded: \[\] as string\[\]/.test(nonKiro), false);
  });

  test('非 Kiro 分支：http 中转条目探测，失败只提示不阻断', () => {
    assert.match(nonKiro, /probeHttpMcp\(/);
    assert.match(nonKiro, /httpProbeNotice\(/);
    assert.equal(/await\s+probeHttpMcp/.test(nonKiro), false);
  });

  test('切换组合后不再说「远程会话暂时还不挂组合里的 MCP」', () => {
    assert.equal(M.includes('远程会话暂时还不挂组合里的 MCP'), false);
  });

  test('切换组合时新执行器起不来：旧执行器的工具通道已被换掉，要把它收掉（下一条消息按原组合重接），不能留一条工具全失效的会话', () => {
    /* acp:switch-mcp-combo 的实现抽成了 switchMcpComboImpl（忙时记下的切换跑完后也走它） */
    const h = M.indexOf('const switchMcpComboImpl = async');
    const handler = M.slice(h, M.indexOf('\n  };\n', h));
    const tools = handler.indexOf('await ensureLocalTools(');
    const flag = handler.indexOf('toolsSwapped = !!profile.remote?.sshHost;');
    assert.ok(flag > 0 && flag < tools, '要在换通道之前记下"通道换了"');
    const caught = handler.slice(handler.indexOf('} catch (err) {'));
    assert.match(caught, /if \(toolsSwapped && sessionClients\.get\(sessionId\) === oldEntry\) \{\s*void detachExecutor\(sessionId\);/);
    /* 同一次失败只说一处：说明（仍用原组合、下一条消息重新连接）随抛出的错误给界面（组合下拉旁的 ✗），不另发状态行 */
    assert.match(caught, /throw new Error\(tr\('Switching to the combo "\{name\}" failed \(\{err\}\); the previous combo is kept and your next message reconnects with it\.'/);
    assert.doesNotMatch(caught, /sessionNotice\(sessionId, /);
    assert.match(caught, /throw err;/);
    /* 失败时记录不能被改成新组合：写记录只在成功那段（catch 之前） */
    assert.equal(/rec\.profile = profile/.test(caught), false);
  });
});
