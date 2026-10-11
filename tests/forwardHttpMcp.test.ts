import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  forwardableFrom, normalizeForwardList, remoteForwardPlan, upstreamUrlKey, forwardHttpHelp,
  httpProbeNotice, FORWARD_TIMEOUT_SEC_DEFAULT,
} from '../src/main/forwardMcp.ts';
import { remoteAgentScript, parseDroppedDupes, MCP_SERVER_NAME } from '../src/main/remoteLocalTools.ts';
import { remoteContextBlock } from '../src/main/remoteContext.ts';

/*
 * 「远程会话从本机转发的 MCP」名单 —— 妙想这类 HTTP MCP：密钥只在本机、上游要看到本机出口 IP。
 * 以前 HTTP 型（有 url、没有 command）一律跳过，于是本机 agent 里写的妙想在远程会话里根本没有。
 */

const UPSTREAM = 'https://mxapi.eastmoney.com/mxds/mcp';
const KEY = 'sk-live-abcdef1234567890';

/** 一份典型的本机 agent：一个妙想（http）、一个本机路径 stdio、一个远端也有的 stdio、一个 playwright。 */
const AGENT = {
  mcpServers: {
    'mx-ds-mcp': { type: 'http', url: UPSTREAM, headers: { em_api_key: '${env:EM_API_KEY}' } },
    other_http: { type: 'http', url: 'https://example.com/mcp' },
    drawio: { command: '/opt/homebrew/bin/node', args: ['x.js'] },
    builder: { command: 'builder-mcp', args: ['--x'] },
    playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
    off_http: { type: 'http', url: 'https://off.example.com/mcp', disabled: true },
  },
};

describe('名单：规范化', () => {
  test('去空名、去重、超时默认 180 秒、乱值退回默认', () => {
    assert.deepEqual(normalizeForwardList(undefined), []);
    assert.deepEqual(normalizeForwardList('x'), []);
    assert.deepEqual(normalizeForwardList([
      { name: ' mx-ds-mcp ' },
      { name: 'mx-ds-mcp', timeoutSec: 30 },        // 同名第二次不要
      { name: '' },
      { name: 'slow', timeoutSec: 600 },
      { name: 'bad', timeoutSec: 'abc' },
      { name: 'neg', timeoutSec: -5 },
      null,
    ]), [
      { name: 'mx-ds-mcp', timeoutSec: FORWARD_TIMEOUT_SEC_DEFAULT },
      { name: 'slow', timeoutSec: 600 },
      { name: 'bad', timeoutSec: FORWARD_TIMEOUT_SEC_DEFAULT },
      { name: 'neg', timeoutSec: FORWARD_TIMEOUT_SEC_DEFAULT },
    ]);
    assert.equal(FORWARD_TIMEOUT_SEC_DEFAULT, 180);
  });
});

describe('forwardableFrom：有名单 / 无名单', () => {
  test('无名单：和以前完全一样 —— HTTP 型跳过，只转本机路径命令和按名字白名单', () => {
    const picked = forwardableFrom(AGENT);
    assert.deepEqual(picked.map((p) => p.name).sort(), ['drawio', 'playwright']);
    assert.equal(picked.some((p: any) => p.type === 'http'), false);
    /* 空名单同理 */
    assert.deepEqual(forwardableFrom(AGENT, []), picked);
  });

  test('名单里的 HTTP 型：产出 http 规格，带 url、原样的 ${env:…} 头、超时', () => {
    const picked = forwardableFrom(AGENT, [{ name: 'mx-ds-mcp', timeoutSec: 240 }]);
    const mx: any = picked.find((p) => p.name === 'mx-ds-mcp');
    assert.deepEqual(mx, {
      type: 'http', name: 'mx-ds-mcp', url: UPSTREAM,
      headers: { em_api_key: '${env:EM_API_KEY}' },     // 不在这里展开：由 HttpProxy 在本机展开
      timeoutMs: 240_000,
    });
    /* 不在名单里的 HTTP 型照旧跳过；其余照旧 */
    assert.deepEqual(picked.map((p) => p.name).sort(), ['drawio', 'mx-ds-mcp', 'playwright']);
  });

  test('名单里的 stdio 一律转发（哪怕命令不是本机路径），disabled 的 HTTP 不转', () => {
    const picked = forwardableFrom(AGENT, [
      { name: 'builder', timeoutSec: 180 },
      { name: 'off_http', timeoutSec: 180 },
      { name: 'not-in-agent', timeoutSec: 180 },
    ]);
    assert.deepEqual(picked.map((p) => p.name).sort(), ['builder', 'drawio', 'playwright']);
    const b: any = picked.find((p) => p.name === 'builder');
    assert.equal(b.type, undefined, 'stdio 规格的形状不变');
    assert.equal(b.command, 'builder-mcp');
    assert.deepEqual(b.args, ['--x']);
  });

  test('名单同时有 http 和 stdio', () => {
    const picked = forwardableFrom(AGENT, normalizeForwardList([{ name: 'mx-ds-mcp' }, { name: 'builder' }]));
    assert.deepEqual(picked.map((p) => p.name).sort(), ['builder', 'drawio', 'mx-ds-mcp', 'playwright']);
    const mx: any = picked.find((p) => p.name === 'mx-ds-mcp');
    assert.equal(mx.timeoutMs, 180_000);
  });
});

describe('远端会话 agent：只写隧道地址，绝不写上游 url / headers / 密钥', () => {
  const base = 'http://127.0.0.1:39100/mcp/tok';
  const entries = forwardableFrom(AGENT, [{ name: 'mx-ds-mcp', timeoutSec: 180 }]);

  test('remoteForwardPlan：转发项全部指向隧道，http 项只交出上游 url 的指纹', () => {
    const plan = remoteForwardPlan(entries, base);
    assert.deepEqual(plan.forwarded.find((f) => f.name === 'mx-ds-mcp'), { name: 'mx-ds-mcp', url: `${base}/mx-ds-mcp` });
    for (const f of plan.forwarded) assert.ok(f.url.startsWith(`${base}/`));
    assert.deepEqual(plan.dropUpstream, [upstreamUrlKey(UPSTREAM)]);
    assert.deepEqual(plan.httpNames, ['mx-ds-mcp']);
    assert.deepEqual(plan.stdioNames.sort(), ['drawio', 'playwright']);
  });

  test('remoteAgentScript 输出里没有上游 url、头名、${env:…} 引用和密钥', () => {
    const plan = remoteForwardPlan(entries, base);
    const sc = remoteAgentScript('kirolex-local-s1', 'aws-agent', base, plan.forwarded, plan.dropUpstream);
    assert.equal(sc.includes(UPSTREAM), false);
    assert.equal(sc.includes('mxapi.eastmoney.com'), false);
    assert.equal(sc.includes('em_api_key'), false);
    assert.equal(sc.includes('EM_API_KEY'), false);
    assert.equal(sc.includes(KEY), false);
    assert.match(sc, /KX_FWD='[^']*"mx-ds-mcp":"http:\/\/127\.0\.0\.1:39100\/mcp\/tok\/mx-ds-mcp"/);
    /* 程序里仍然一个单引号都不能有 */
    const prog = sc.slice(sc.indexOf("python3 -c '") + 12, sc.length - 1);
    assert.equal(prog.includes("'"), false);
  });

  test('指纹：去掉首尾空白和末尾斜杠后比较，不可逆（不是 url 本身）', () => {
    assert.equal(upstreamUrlKey(` ${UPSTREAM}/ `), upstreamUrlKey(UPSTREAM));
    assert.notEqual(upstreamUrlKey(UPSTREAM), upstreamUrlKey('https://example.com/mcp'));
    assert.match(upstreamUrlKey(UPSTREAM), /^[0-9a-f]{64}$/);
  });

  test('同 url 剔除：脚本里带上指纹，并且剔除只发生在会话 agent（不写回底子文件）', () => {
    const plan = remoteForwardPlan(entries, base);
    const sc = remoteAgentScript('out', 'a', base, plan.forwarded, plan.dropUpstream);
    assert.match(sc, new RegExp(`KX_DROP='\\["${upstreamUrlKey(UPSTREAM)}"\\]'`));
    const prog = sc.slice(sc.indexOf("python3 -c '") + 12, sc.length - 1);
    assert.match(prog, /hashlib\.sha256/);
    assert.match(prog, /print\("KX_DROP " \+ k\)/);
    /* 只写 out.json，不写 base.json */
    assert.equal(/open\(os\.path\.join\(h, base \+ "\.json"\), "w"\)/.test(prog), false);
    assert.deepEqual(parseDroppedDupes('KX_DROP mx-direct\nKX_AGENT a\nKX_DROP other\n'), ['mx-direct', 'other']);
    assert.deepEqual(parseDroppedDupes('KX_AGENT a'), []);
  });

  test('同 url 剔除真跑一遍：远端底子里同上游的别名条目被去掉，同名的被覆盖，别的留着', {
    skip: process.platform === 'win32' && '远端脚本（bash + python3 + HOME）只在 POSIX 上能本机冒烟',
  }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fwdhttp-'));
    const agents = path.join(home, '.kiro', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    const baseDoc = {
      mcpServers: {
        'mx-direct': { type: 'http', url: `${UPSTREAM}/`, headers: { em_api_key: 'remote-key' } },
        'mx-ds-mcp': { type: 'http', url: UPSTREAM },
        keep: { command: '/usr/bin/true' },
      },
      tools: ['fs_read', '@mx-direct'], allowedTools: ['@mx-direct/search'],
    };
    fs.writeFileSync(path.join(agents, 'a.json'), JSON.stringify(baseDoc));
    const plan = remoteForwardPlan(entries, base);
    const out = execFileSync('bash', ['-lc', remoteAgentScript('out', 'a', base, plan.forwarded, plan.dropUpstream)],
      { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.deepEqual(parseDroppedDupes(out), ['mx-direct']);
    const j = JSON.parse(fs.readFileSync(path.join(agents, 'out.json'), 'utf8'));
    assert.equal('mx-direct' in j.mcpServers, false);
    assert.deepEqual(j.mcpServers['mx-ds-mcp'], { type: 'http', url: `${base}/mx-ds-mcp` });
    assert.ok('keep' in j.mcpServers);
    assert.equal(j.tools.includes('@mx-direct'), false);
    assert.equal(j.allowedTools.includes('@mx-direct/search'), false);
    /* 远端原文件不动 */
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agents, 'a.json'), 'utf8')), baseDoc);
    assert.equal(JSON.stringify(j).includes(UPSTREAM), false);
  });
});

describe('提示：探测失败 / 模型注入', () => {
  test('探测失败的提示写明 MCP 名和「本机→上游」', () => {
    const n = httpProbeNotice('mx-ds-mcp', '本机→上游（mx-ds-mcp）鉴权失败：HTTP 401，请检查本机配置的密钥');
    assert.match(n, /mx-ds-mcp/);
    assert.match(n, /本机→上游（mx-ds-mcp）鉴权失败/);
    /* 上游原样透传的错误不带前缀时补上 */
    assert.match(httpProbeNotice('x', 'Invalid params'), /本机→上游（x）/);
  });

  test('注入：说明请求从用户机器发出、别在远端另配同名 MCP 直连；没有就不说', () => {
    assert.equal(forwardHttpHelp([]), '');
    const h = forwardHttpHelp(['mx-ds-mcp']);
    assert.match(h, /mx-ds-mcp/);
    assert.match(h, /从用户那台机器发出/);
    assert.match(h, /不要.*同名/);
    const b = remoteContextBlock({ hostLabel: 'h', remoteDir: '/r', localDir: '/l', forwardedHttp: ['mx-ds-mcp'] });
    assert.match(b, /从用户那台机器发出/);
    assert.equal(/从用户那台机器发出/.test(remoteContextBlock({ hostLabel: 'h', remoteDir: '/r', localDir: '/l' })), false);
  });
});

describe('接线（源码扫描）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const at = M.indexOf('async function ensureLocalTools(');
  const body = M.slice(at, M.indexOf('\n}\n', at));

  test('Kiro 分支按名单挑、http 规格一起交给 setProxies、只把隧道地址写进远端 agent', () => {
    assert.match(body, /forwardableFrom\(localAgentJson\(profile\.kiroAgent\), loadForwardMcpList\(\)\)/);
    assert.match(body, /server\.setProxies\(sessionId, forwardable\);/);
    assert.match(body, /remoteForwardPlan\(forwardable, mcpUrl\(remotePort, urlPath\)\)/);
    assert.match(body, /remoteAgentScript\(agentOverride, profile\.kiroAgent, mcpUrl\(remotePort, urlPath\), plan\.forwarded, plan\.dropUpstream\)/);
    assert.match(body, /parseDroppedDupes\(agentOut\)/);
  });

  test('每个 http 转发条目都探测，失败只提示不阻断（不 await）', () => {
    assert.match(body, /probeHttpMcp\(/);
    assert.match(body, /httpProbeNotice\(/);
    assert.equal(/await\s+probeHttpMcp/.test(body), false, '探测不能挡住会话准备');
  });

  test('名单存在 config.json，有读写 IPC', () => {
    assert.match(M, /ipcMain\.handle\('app:get-forward-mcp'/);
    assert.match(M, /ipcMain\.handle\('app:set-forward-mcp'/);
    assert.match(M, /cfg\.remoteForwardMcp = /);
    const P = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    assert.match(P, /getForwardMcp: \(\) => ipcRenderer\.invoke\('app:get-forward-mcp'\)/);
    assert.match(P, /setForwardMcp: /);
  });
});
