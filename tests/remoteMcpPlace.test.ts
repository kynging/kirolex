import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  placeForwardStdio, placeEligible, commandBasename, normalizeRunOn, remoteWhichScript, parseRemoteWhich,
  remoteStdioServer, remoteMcpProbeScript, parseRemoteProbe,
} from '../src/main/remoteMcpPlace.ts';
import { parseMcpCombos, localizeServer } from '../src/main/mcpCombos.ts';
import { setMachineOverride, comboForwardStdio } from '../src/main/comboAvailability.ts';
import { missingCommandItem, failedItem, notForwardedItem, splitQuietMcpItems, mcpUnavailableNotice } from '../src/main/mcpUnavailable.ts';
import type { McpEntry } from '../src/main/forwardMcp.ts';
import { setUiLang } from '../src/main/uiText.ts';

setUiLang('zh');

/*
 * 「从本机转发」的 MCP 在这台电脑上没装时，别逼用户装（2026-10-25）：
 * builder-mcp、agentcore-websearch 标了 forwardFromLocal，命令是 Mac 上的路径，配置经 S3 同步到了 Windows。
 * 远端 aws-tokyo 上有 ~/.local/bin/mcp-proxy-for-aws（agentcore-websearch 直接在那儿跑是通的），builder-mcp 只有 Mac 上有。
 */

const BUILDER: McpEntry = { name: 'builder-mcp', command: '/Users/keyinan/.toolbox/bin/builder-mcp', args: [] };
const WEBSEARCH: McpEntry = {
  name: 'agentcore-websearch',
  command: '/Users/keyinan/.local/bin/mcp-proxy-for-aws',
  args: ['https://example.amazonaws.com/mcp', '--config', '/Users/keyinan/.aws/x.json'],
  env: { AWS_REGION: 'us-east-1' },
};
const LOCAL_OK: McpEntry = { name: 'drawio-local', command: 'C:\\tools\\drawio-mcp.exe', args: [] };
const REMOTE_FOUND = new Map([['mcp-proxy-for-aws', '/home/ubuntu/.local/bin/mcp-proxy-for-aws']]);

const base = {
  entries: [LOCAL_OK, WEBSEARCH, BUILDER],
  eligible: () => true,
  runOn: () => 'auto' as const,
  localHas: (e: McpEntry) => e === LOCAL_OK,
  remoteHost: 'aws-tokyo',
};

describe('三种分支：本机有 / 只有远端有 / 都没有', () => {
  test('先不查远端：本机有的直接本机；其余按 basename 列出要去远端查的', () => {
    const r = placeForwardStdio(base);
    assert.deepEqual(r.local.map((e) => e.name), ['drawio-local']);
    assert.deepEqual(r.needRemote, ['mcp-proxy-for-aws', 'builder-mcp'], '远端按命令的 basename 找，不按 MCP 名字、不按完整路径');
    assert.deepEqual(r.remote, []);
    assert.deepEqual(r.missing, []);
  });

  test('查完远端：本机有 → 本机转发；只有远端有 → 远端起；都没有 → 不起', () => {
    const r = placeForwardStdio({ ...base, remoteFound: REMOTE_FOUND });
    assert.deepEqual(r.local.map((e) => e.name), ['drawio-local']);
    assert.deepEqual(r.remote.map((p) => [p.entry.name, p.remoteCommand]), [['agentcore-websearch', '/home/ubuntu/.local/bin/mcp-proxy-for-aws']]);
    assert.deepEqual(r.missing.map((m) => m.entry.name), ['builder-mcp']);
    assert.equal(r.missing[0].reason, '这台电脑和 aws-tokyo 上都找不到 builder-mcp');
  });

  test('远端起的：交给远端适配器的是普通 stdio MCP，命令换成远端路径，参数（包括路径型参数）和 env 原样', () => {
    const r = placeForwardStdio({ ...base, remoteFound: REMOTE_FOUND });
    assert.deepEqual(remoteStdioServer(r.remote[0]), {
      name: 'agentcore-websearch',
      command: '/home/ubuntu/.local/bin/mcp-proxy-for-aws',
      args: ['https://example.amazonaws.com/mcp', '--config', '/Users/keyinan/.aws/x.json'],
      env: [{ name: 'AWS_REGION', value: 'us-east-1' }],
    });
    assert.ok(!('url' in remoteStdioServer(r.remote[0])), '不走转发（没有隧道地址）');
  });

  test('提示：只有远端有的不算不可用；都没有的进徽标、不进会话正文', () => {
    const r = placeForwardStdio({ ...base, remoteFound: REMOTE_FOUND });
    const items = [
      ...r.missing.map((m) => missingCommandItem(m.entry.name, m.entry.command, m.reason)),
      notForwardedItem('context7', 'http', ''),
    ];
    const { loud, quiet } = splitQuietMcpItems(items);
    assert.deepEqual(quiet.map((i) => i.name), ['builder-mcp'], '找不到程序的只进徽标');
    assert.deepEqual(loud.map((i) => i.name), ['context7']);
    assert.ok(mcpUnavailableNotice(items).includes('builder-mcp'), '徽标点开的详情里列出来');
    assert.ok(mcpUnavailableNotice(items).includes('这台电脑和 aws-tokyo 上都找不到 builder-mcp'));
    assert.ok(!mcpUnavailableNotice(loud).includes('builder-mcp'), '进对话记录的那条里没有它');
    /* 起不来（远端握手没过）的照旧按原规则说 */
    assert.deepEqual(splitQuietMcpItems([failedItem('agentcore-websearch', 'x')]).loud.length, 1);
  });

  test('本机会话找不到命令：同样安静跳过（只进徽标）', () => {
    const item = missingCommandItem('builder-mcp', BUILDER.command, '这台电脑上找不到 x');
    assert.deepEqual(splitQuietMcpItems([item]), { loud: [], quiet: [item] });
  });
});

describe('手动覆盖优先于自动', () => {
  test('总是在远端运行：本机有也去远端；远端没有 → 不起（说明是设成了远端）', () => {
    const runOn = (n: string) => (n === 'drawio-local' || n === 'builder-mcp' ? 'remote' as const : 'auto' as const);
    const first = placeForwardStdio({ ...base, runOn });
    assert.deepEqual(first.local, [], '本机有的 drawio-local 也不留在本机');
    assert.ok(first.needRemote.includes('drawio-mcp'), 'Windows 的 .exe 去掉后按 basename 查');
    const found = new Map([...REMOTE_FOUND, ['drawio-mcp', '/usr/local/bin/drawio-mcp']]);
    const r = placeForwardStdio({ ...base, runOn, remoteFound: found });
    assert.deepEqual(r.remote.map((p) => p.entry.name), ['drawio-local', 'agentcore-websearch']);
    assert.equal(r.missing[0].reason, 'aws-tokyo 上找不到 builder-mcp（设成了总是在远端运行）');
  });

  test('总是本机转发：本机没有、远端有也不挪（交给本机那条「找不到程序」）', () => {
    const r = placeForwardStdio({ ...base, runOn: () => 'local' as const, remoteFound: REMOTE_FOUND });
    assert.deepEqual(r.local.map((e) => e.name), ['drawio-local', 'agentcore-websearch', 'builder-mcp']);
    assert.deepEqual(r.remote, []);
    assert.deepEqual(r.needRemote, []);
  });

  test('perMachine 里的 runOn 按这台电脑带出来；别的电脑的不算', () => {
    const s = { command: BUILDER.command, forwardFromLocal: true, perMachine: { 'WIN-BOX': { runOn: 'remote' as const }, darwin: { runOn: 'local' as const } } };
    assert.equal(normalizeRunOn(localizeServer(s, { hostname: 'win-box', platform: 'win32' }).runOn), 'remote');
    assert.equal(normalizeRunOn(localizeServer(s, { hostname: 'mac', platform: 'darwin' }).runOn), 'local');
    assert.equal(normalizeRunOn(localizeServer(s, { hostname: 'other', platform: 'linux' }).runOn), 'auto');
  });

  test('标了 forwardFromLocal 的一律走三步（playwright / drawio / pencil 也是）；只因名字才转发、没标的自动模式下不挪，手动选了远端才挪；HTTP 型不管', () => {
    assert.equal(placeEligible('builder-mcp', { command: BUILDER.command, forwardFromLocal: true }), true);
    for (const name of ['playwright', 'drawio', 'pencil']) {
      assert.equal(placeEligible(name, { command: '/Users/keyinan/bin/x', forwardFromLocal: true }), true, `${name} 标了 forwardFromLocal`);
      assert.equal(placeEligible(name, { command: '/Users/keyinan/bin/x' }), false, `${name} 没标：只因名字转发，不挪`);
      assert.equal(placeEligible(name, { command: '/Users/keyinan/bin/x', runOn: 'remote' }), true, `${name} 手动选了远端`);
    }
    assert.equal(placeEligible('playwright', { command: 'npx', forwardFromLocal: true, runOn: 'remote' }), true);
    assert.equal(placeEligible('web', { url: 'https://x/mcp', forwardFromLocal: true }), false);
    assert.equal(placeEligible('off', { command: BUILDER.command, forwardFromLocal: true, disabled: true }), false);
  });
});

describe('远端按 basename 找命令', () => {
  test('basename：去路径、去引号、去 Windows 扩展名；不安全的名字不查', () => {
    assert.equal(commandBasename('/Users/keyinan/.local/bin/mcp-proxy-for-aws'), 'mcp-proxy-for-aws');
    assert.equal(commandBasename('"C:\\Program Files\\x\\builder-mcp.exe"'), 'builder-mcp');
    assert.equal(commandBasename('uvx'), 'uvx');
    assert.equal(commandBasename('/bin/$(rm -rf ~)'), '');
  });

  test('脚本在 PATH、~/.local/bin、~/bin 里找；解析出完整路径', () => {
    const sh = remoteWhichScript(['mcp-proxy-for-aws', 'builder-mcp', 'bad name']);
    assert.ok(sh.includes("'mcp-proxy-for-aws'") && sh.includes("'builder-mcp'"));
    assert.ok(!sh.includes('bad name'));
    assert.ok(sh.includes('command -v') && sh.includes('$HOME/.local/bin') && sh.includes('$HOME/bin'));
    assert.ok(!/install|apt|pip|curl/.test(sh), '远端只查、不装');
    const m = parseRemoteWhich('noise\nKXWHICH mcp-proxy-for-aws\t/home/ubuntu/.local/bin/mcp-proxy-for-aws\nKXWHICH x\trelative\n');
    assert.deepEqual([...m], [['mcp-proxy-for-aws', '/home/ubuntu/.local/bin/mcp-proxy-for-aws']]);
  });
});

describe('就绪检查（远端起一次，initialize → tools/list）', () => {
  const placed = { entry: WEBSEARCH, remoteCommand: '/home/ubuntu/.local/bin/mcp-proxy-for-aws' };
  test('脚本只用 bash：不依赖远端有 python / node；命令换成远端路径，参数和 env 原样（单引号转义）', () => {
    const sh = remoteMcpProbeScript(placed, 7);
    assert.ok(!/python|\bnode\b/.test(sh), '不依赖 python / node');
    assert.ok(sh.includes(`'${placed.remoteCommand}' 'https://example.amazonaws.com/mcp' '--config' '/Users/keyinan/.aws/x.json'`));
    assert.ok(sh.includes(`env 'AWS_REGION=us-east-1'`));
    assert.ok(sh.includes('"method":"initialize"') && sh.includes('"method":"tools/list"') && sh.includes('notifications/initialized'));
    assert.ok(sh.includes('SECONDS + 7'));
  });

  test('结果解析：ok / fail / 没输出（ssh 断了）都按实际结果，没有「没查当成功」', () => {
    assert.deepEqual(parseRemoteProbe('KXPROBE ok 1\n'), { ok: true, toolCount: 1 });
    assert.deepEqual(parseRemoteProbe('KXPROBE fail no reply to initialize: boom'), { ok: false, toolCount: 0, error: 'no reply to initialize: boom' });
    assert.equal(parseRemoteProbe('KXPROBE nopy').ok, false, '不认得的输出不算就绪');
    assert.equal(parseRemoteProbe('').ok, false);
  });

  /* 真跑一遍（bash + 假 MCP，只用 bash 的那个 fixture）：远端没有 python 也能查出就绪 / 不就绪 */
  const fixture = path.join(import.meta.dirname, 'fixtures', 'fakeStdioMcp.sh');
  const posix = process.platform === 'win32'
    ? fixture.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, '/')
    : fixture;
  const run = (args: string[], env: Record<string, string> = {}, timeoutSec = 3) => {
    const sh = remoteMcpProbeScript({ entry: { name: 'x', command: 'x', args, env }, remoteCommand: posix }, timeoutSec);
    const r = spawnSync('bash', ['-c', sh], { encoding: 'utf8', timeout: 30_000 });
    return { out: parseRemoteProbe(r.stdout), stdout: r.stdout };
  };
  const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';

  test('就绪：握手 + tools/list 通过，数出工具数；参数（带空格）和 env（带单引号）原样到了', { skip: !hasBash && 'no bash' }, () => {
    const r = run(['ok', 'a b'], { KX_T: "a'b" });
    assert.deepEqual(r.out, { ok: true, toolCount: 2 }, r.stdout);
  });
  test('不回话：到时间算没就绪（不交、后台接着试）', { skip: !hasBash && 'no bash' }, () => {
    const t = Date.now();
    const r = run(['silent'], {}, 2);
    assert.equal(r.out.ok, false);
    assert.match(r.out.error!, /no reply to initialize/);
    assert.ok(Date.now() - t < 15_000);
  });
  test('initialize 回错 / 一起来就退出：没就绪，原因带上它 stderr 的话', { skip: !hasBash && 'no bash' }, () => {
    const e = run(['error']);
    assert.equal(e.out.ok, false);
    assert.match(e.out.error!, /initialize failed/);
    const x = run(['exit']);
    assert.equal(x.out.ok, false);
    assert.match(x.out.error!, /boom: missing credentials/);
  });
});

describe('MCP 配置面板：「在哪跑」存成这台电脑的 perMachine 覆盖', () => {
  const text = JSON.stringify([{
    id: 'default', name: '通用（带本机工具）', mcpServers: {
      'builder-mcp': { command: BUILDER.command, forwardFromLocal: true, perMachine: { 'mac-1': { command: '/x' } } },
      'context7': { url: 'https://mcp.context7.com/mcp' },
      'playwright': { command: 'npx', args: ['@playwright/mcp'] },
      'pencil': { command: '/Applications/Pencil.app/Contents/mcp', forwardFromLocal: true },
    },
  }], null, 2);

  test('选「总是在远端运行」写 runOn；选回「自动」把这台电脑的键删掉；别的电脑的覆盖不动', () => {
    const remote = setMachineOverride(text, 'default', 'builder-mcp', 'WIN-BOX', { runOn: 'remote' })!;
    const s1 = JSON.parse(remote)[0].mcpServers['builder-mcp'];
    assert.deepEqual(s1.perMachine, { 'mac-1': { command: '/x' }, 'WIN-BOX': { runOn: 'remote' } });
    assert.equal(parseMcpCombos(remote).ok, true, '写出来的能通过校验');
    const auto = setMachineOverride(remote, 'default', 'builder-mcp', 'WIN-BOX', { runOn: 'auto' })!;
    assert.deepEqual(JSON.parse(auto)[0].mcpServers['builder-mcp'].perMachine, { 'mac-1': { command: '/x' } });
  });

  test('校验：runOn 只能是 remote / local，http 型不能写', () => {
    const bad = (pm: unknown, extra: Record<string, unknown> = { command: 'x' }) =>
      parseMcpCombos(JSON.stringify([{ id: 'a', name: 'a', mcpServers: { m: { ...extra, perMachine: pm } } }]));
    assert.equal(bad({ h: { runOn: 'local' } }).ok, true);
    assert.equal(bad({ h: { runOn: 'elsewhere' } }).ok, false);
    assert.equal(bad({ h: { runOn: 'remote' } }, { url: 'https://x/mcp' }).ok, false);
  });

  test('面板列出会走回退的那几条和这台电脑上的设置', () => {
    const rows = comboForwardStdio(setMachineOverride(text, 'default', 'builder-mcp', 'win-box', { runOn: 'local' })!, { hostname: 'WIN-BOX', platform: 'win32' });
    assert.deepEqual(rows.map((r) => [r.server, r.runOn]), [['builder-mcp', 'local'], ['pencil', 'auto']], '标了 forwardFromLocal 的 pencil 也有「在哪跑」可选；没标的 playwright 没有');
  });
});

describe('接线（index.ts）', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const block = src.slice(src.indexOf('async function ensureLocalTools('), src.indexOf('function sweepStrayLocalSsh('));
  test('远程会话准备：先决定放哪，本机的才 setProxies，远端的就绪检查后才写进 mcpServers，没就绪的后台看护 + 重连', () => {
    assert.ok(block.includes('placeComboForwardStdio(sessionId, remote, combo, entries, fromList)'));
    assert.ok(block.includes('server.setProxies(sessionId, localEntries)'));
    assert.ok(block.includes('probeRemoteRun(remote, p)'));
    assert.ok(block.includes('...remoteHanded.map(remoteStdioServer)'));
    assert.ok(block.includes('startRemoteRunWatch(sessionId, spec, remote, p, r)'));
    assert.ok(/function startRemoteRunWatch[\s\S]*?watchHttpForward\([\s\S]*?reconnectForForward\(/.test(src), '复用 61004ec5 的看护 + 空闲重连');
  });
  test('合并提示：找不到程序的不进对话记录', () => {
    const ann = src.slice(src.indexOf('function announceMcpUnavailable('), src.indexOf('async function gateForwardStdio('));
    assert.ok(ann.includes('splitQuietMcpItems(items)'));
    assert.ok(ann.includes('planMcpNotice(loud,'));
    assert.ok(ann.includes('noteInSession(sessionId, mcpUnavailableNotice(loud)'));
  });
});
