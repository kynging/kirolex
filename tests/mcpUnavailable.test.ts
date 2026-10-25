import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCommand, commandMissingReason } from '../src/main/commandResolve.ts';
import { startLocalMcp, type LocalMcpDeps } from '../src/main/localMcp.ts';
import { decodeShellOutput } from '../src/main/winShell.ts';
import {
  mcpUnavailableNotice, notForwardedItem, missingCommandItem, failedItem, skippedItem,
  planMcpNotice, mcpNoticeScope, readMcpNoticeSeen, writeMcpNoticeSeen, mcpNoticeSeenPath,
} from '../src/main/mcpUnavailable.ts';
import { parseMcpCombos, localizeServer, localizeCombo, perMachineKey, buildAcpMcpServers } from '../src/main/mcpCombos.ts';
import { forwardableFromCombo } from '../src/main/forwardMcp.ts';
import { NOTE_DETAIL_SEP, splitNoteDetail } from '../src/main/kirolexNote.ts';
import { setUiLang } from '../src/main/uiText.ts';

setUiLang('zh');

/*
 * 「会话里的 KiroLex 提示刷屏且关不掉 … 跨电脑同步的 MCP 配置路径在本机不存在要说人话」（2026-10-25 用户 Windows 机实测）：
 * mcp-combos.json 跟着 S3 从 Mac 同步过来，`/Users/keyinan/.toolbox/bin/builder-mcp` 在 Windows 上根本没有；
 * 原来照样起（乱码的「系统找不到指定的路径」+「退出了（code 1）」），重拉 6 次，每条新会话再报一遍。
 */

const MAC_PATH = '/Users/keyinan/.toolbox/bin/builder-mcp';

describe('resolveCommand：spawn 之前先看命令在不在', () => {
  test('绝对路径：看那个文件；Windows 上另一台 Mac 的路径找不到', () => {
    const files = new Set(['/usr/local/bin/x']);
    assert.equal(resolveCommand('/usr/local/bin/x', { platform: 'linux', isFile: (p) => files.has(p) }), '/usr/local/bin/x');
    assert.equal(resolveCommand(MAC_PATH, { platform: 'linux', isFile: (p) => files.has(p) }), null);
    assert.equal(resolveCommand(MAC_PATH, { platform: 'win32', cwd: 'C:\\work', env: {}, isFile: () => false }), null);
  });

  test('Windows 裸命令：当前目录、再 PATH，每个目录按 PATHEXT 试（npx → npx.cmd）', () => {
    const files = new Set(['C:\\node\\npx.cmd']);
    const env = { Path: 'C:\\Windows;C:\\node', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(resolveCommand('npx', { platform: 'win32', env, cwd: 'C:\\work', isFile: (p) => files.has(p) }), 'C:\\node\\npx.cmd');
    assert.equal(resolveCommand('builder-mcp', { platform: 'win32', env, cwd: 'C:\\work', isFile: (p) => files.has(p) }), null);
    /* 带扩展名的绝对路径直接看；没扩展名的按 PATHEXT 补 */
    const f2 = new Set(['C:\\tools\\srv.exe']);
    assert.equal(resolveCommand('C:\\tools\\srv', { platform: 'win32', env, isFile: (p) => f2.has(p) }), 'C:\\tools\\srv.exe');
    assert.equal(resolveCommand('"C:\\tools\\srv.exe"', { platform: 'win32', env, isFile: (p) => f2.has(p) }), 'C:\\tools\\srv.exe');
  });

  test('POSIX 裸命令按 PATH 找', () => {
    const files = new Set(['/opt/bin/builder-mcp']);
    assert.equal(resolveCommand('builder-mcp', { platform: 'darwin', env: { PATH: '/usr/bin:/opt/bin' }, isFile: (p) => files.has(p) }), '/opt/bin/builder-mcp');
    assert.equal(resolveCommand('nope', { platform: 'darwin', env: { PATH: '/usr/bin:/opt/bin' }, isFile: (p) => files.has(p) }), null);
  });

  test('真文件系统：本机的 node 找得到，编出来的路径找不到', () => {
    assert.ok(resolveCommand(process.execPath));
    assert.equal(resolveCommand(path.join(os.tmpdir(), 'kirolex-no-such-dir', 'nope-mcp')), null);
  });

  test('原因写出路径、说可能来自另一台电脑', () => {
    const r = commandMissingReason(MAC_PATH);
    assert.ok(r.includes(MAC_PATH));
    assert.match(r, /这台电脑上找不到/);
    assert.match(r, /另一台电脑/);
  });
});

function deps(logs: string[], states: any[], extra: Partial<LocalMcpDeps> = {}): LocalMcpDeps {
  return {
    log: (_l, m) => { logs.push(m); },
    notice: () => {},
    forwardRetry: { baseMs: 50, maxMs: 200, maxFails: 3 },
    onProxyState: (sessionId, name, state, reason) => { states.push({ sessionId, name, state, reason }); },
    ...extra,
  };
}

describe('转发的 stdio MCP：命令不存在 → 不 spawn、不重试', () => {
  test('readyProxies 立刻回「找不到」，原因含路径，没起过进程、没排重试', async () => {
    const logs: string[] = []; const states: any[] = [];
    const server = await startLocalMcp(deps(logs, states));
    const missing = path.join(os.tmpdir(), 'kirolex-no-such-dir', 'builder-mcp');
    try {
      const token = server.register({ sessionId: 's1', workdir: os.tmpdir() });
      server.setProxies('s1', [{ name: 'builder-mcp', command: missing, args: [] }]);
      const t0 = Date.now();
      const [r] = await server.readyProxies('s1', { deadlineMs: 10_000 });
      assert.ok(Date.now() - t0 < 2000, '不等到期限');
      assert.equal(r.ok, false);
      assert.equal(r.starting, undefined, '不是「还在起」');
      assert.equal(r.missing, missing);
      assert.ok(String(r.error).includes(missing), String(r.error));
      assert.match(String(r.error), /这台电脑上找不到/);
      await new Promise((res) => setTimeout(res, 400));      // 重试节奏是 50ms 起：真排了重试这时早该起过了
      assert.ok(!logs.some((l) => l.includes('起在本机')), `不该 spawn：${logs.join(' | ')}`);
      assert.ok(!logs.some((l) => /后重新拉起/.test(l)), '不该排重试');
      /* 远端来调也一样：直接回不可用，照样不起 */
      const res = await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}/builder-mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const body = await res.json();
      assert.ok(String(body.error?.message).includes(missing));
      assert.ok(!logs.some((l) => l.includes('起在本机')));
      assert.deepEqual(states, [], '准备时的状态由调用方统一说，不另报');
    } finally { server.stop(); }
  });

  test('源码接线：spawn 前查命令（resolveCommand），找不到不走 countFailure', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'localMcp.ts'), 'utf-8');
    const hs = src.slice(src.indexOf('private startHandshake'), src.indexOf('async ready('));
    assert.ok(hs.indexOf('missingReason()') >= 0 && hs.indexOf('missingReason()') < hs.indexOf('this.spawnChild()'), '先查再起');
    assert.match(hs, /instanceof MissingCommandError[\s\S]*?return;[\s\S]*?this\.countFailure\(\)/);
  });
});

describe('转发的 stdio MCP：stderr 按系统代码页解，原因里带上它', () => {
  test('子进程写 GBK 的「系统找不到指定的路径。」后退出：原因里是能读的中文，不是乱码', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbkerr-'));
    const script = path.join(dir, 'gbk.js');
    /* 「系统找不到指定的路径。」的 GBK 字节（cmd 在 936 代码页上就这么写） */
    const gbk = Buffer.from('cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4c2b7beb6a1a3', 'hex');
    fs.writeFileSync(script, `process.stderr.write(Buffer.from('${gbk.toString('hex')}', 'hex')); process.stderr.write('\\r\\n'); setTimeout(() => process.exit(1), 50);`);
    const logs: string[] = []; const states: any[] = [];
    const server = await startLocalMcp(deps(logs, states, { decodeStderr: (b) => decodeShellOutput(b, 'gbk') }));
    try {
      server.register({ sessionId: 's1', workdir: dir });
      server.setProxies('s1', [{ name: 'builder-mcp', command: process.execPath, args: [script] }]);
      const [r] = await server.readyProxies('s1', { deadlineMs: 15_000 });
      assert.equal(r.ok, false);
      assert.match(String(r.error), /退出了（code 1）：系统找不到指定的路径。/);
      assert.ok(!String(r.error).includes('\ufffd'), '没有乱码');
      assert.ok(logs.some((l) => l.includes('系统找不到指定的路径')), '日志里也是能读的');
    } finally { server.stop(); }
  });

  test('源码接线：默认解码用 decodeLocalOutput（local_bash 那一个）', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'localMcp.ts'), 'utf-8');
    assert.match(src, /this\.decode = opts\.decodeStderr \|\| decodeLocalOutput;/);
    assert.match(src, /child\.stderr\?\.on\('data', \(d: Buffer\) => \{[\s\S]{0,200}this\.decode\(d\)/);
  });
});

describe('同一次会话准备的多条 MCP 提示合并成一条', () => {
  const items = [
    notForwardedItem('context7', 'http', '为什么……'),
    missingCommandItem('builder-mcp', MAC_PATH, commandMissingReason(MAC_PATH)),
    missingCommandItem('agentcore-websearch', 'agentcore-websearch', commandMissingReason('agentcore-websearch')),
  ];

  test('主句：几个、名字、按原因并在一起；详情：每个一行（原因 + 怎么改）', () => {
    const text = mcpUnavailableNotice(items);
    const { main, detail } = splitNoteDetail(text);
    assert.equal(main, '⚠️ 本次没带上 3 个 MCP：context7（远程会话需标 forwardFromLocal）、builder-mcp、agentcore-websearch（这台电脑上找不到程序）。展开「详情」看原因和怎么改。');
    assert.ok(text.includes(NOTE_DETAIL_SEP));
    const lines = String(detail).split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^· context7：.*forwardFromLocal/);
    assert.ok(lines[1].includes(MAC_PATH) && /为这台电脑设置命令/.test(lines[1]));
    assert.match(lines[2], /^· agentcore-websearch：/);
  });

  test('起不来 / 跳过 也能并进来；空列表不出话', () => {
    const t = mcpUnavailableNotice([failedItem('x', 'x 退出了（code 1）'), skippedItem('y', '缺环境变量 K')]);
    assert.match(splitNoteDetail(t).main, /本次没带上 2 个 MCP：x（起不来）、y（跳过）/);
    assert.equal(mcpUnavailableNotice([]), '');
  });

  test('英文版也是一句', () => {
    setUiLang('en');
    try {
      const { main } = splitNoteDetail(mcpUnavailableNotice(items));
      assert.equal(main, '⚠️ This session is missing 3 MCP(s): context7 (a remote session needs forwardFromLocal), builder-mcp, agentcore-websearch (program not found on this computer). See Details for why and how to fix.');
    } finally { setUiLang('zh'); }
  });
});

describe('同一台电脑 + 同一个 MCP 配置 + 同一个原因只说一次', () => {
  const scope = mcpNoticeScope('WIN-BOX', 'default');
  const a = missingCommandItem('builder-mcp', MAC_PATH, commandMissingReason(MAC_PATH));
  const b = notForwardedItem('context7', 'http', '');

  test('第一次说；第二条会话同样的原因不说；原因变了重新说', () => {
    const p1 = planMcpNotice([a, b], {}, scope);
    assert.equal(p1.say, true);
    assert.deepEqual(p1.fresh, ['builder-mcp', 'context7']);
    const p2 = planMcpNotice([a, b], p1.next, scope);
    assert.equal(p2.say, false, '同样的原因不再进对话记录');
    const changed = failedItem('builder-mcp', 'builder-mcp 退出了（code 1）');
    const p3 = planMcpNotice([changed, b], p2.next, scope);
    assert.equal(p3.say, true);
    assert.deepEqual(p3.fresh, ['builder-mcp']);
  });

  test('别的 MCP 配置 / 别的电脑算新的', () => {
    const p1 = planMcpNotice([a], {}, scope);
    assert.equal(planMcpNotice([a], p1.next, mcpNoticeScope('WIN-BOX', 'research')).say, true);
    assert.equal(planMcpNotice([a], p1.next, mcpNoticeScope('other-pc', 'default')).say, true);
  });

  test('好过一次之后再坏（原因一样）也重新说', () => {
    const p1 = planMcpNotice([a], {}, scope);
    const ok = planMcpNotice([], p1.next, scope, ['builder-mcp']);
    assert.equal(ok.say, false);
    assert.equal(planMcpNotice([a], ok.next, scope).say, true);
  });

  test('记录落在 ~/.kirolex/mcp-notice-seen.json，读回来一样；坏文件当没说过', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seen-'));
    assert.deepEqual(readMcpNoticeSeen(home), {});
    const p = planMcpNotice([a], {}, scope);
    writeMcpNoticeSeen(home, p.next);
    assert.deepEqual(readMcpNoticeSeen(home), p.next);
    fs.writeFileSync(mcpNoticeSeenPath(home), '{oops');
    assert.deepEqual(readMcpNoticeSeen(home), {});
  });
});

describe('mcp-combos.json 按机器覆盖 command / args（perMachine）', () => {
  const file = JSON.stringify([{
    id: 'default', name: '通用',
    mcpServers: {
      'builder-mcp': {
        command: MAC_PATH, forwardFromLocal: true,
        perMachine: {
          'WIN-BOX': { command: 'C:\\tools\\builder-mcp.exe', args: ['--stdio'] },
          linux: { disabled: true },
        },
      },
      ws: { command: 'agentcore-websearch', perMachine: { win32: { command: 'C:\\ws\\ws.cmd' } } },
      context7: { url: 'https://mcp.context7.com/mcp', perMachine: { 'WIN-BOX': { disabled: true } } },
    },
  }]);

  test('能通过校验；主机名优先（不分大小写、不看 .local），其次按系统；没有覆盖的照原样', () => {
    const r = parseMcpCombos(file);
    assert.ok(r.ok, (r as any).error);
    const s = (r as any).combos[0].mcpServers;
    const win = { hostname: 'win-box.local', platform: 'win32' };
    assert.equal(perMachineKey(s['builder-mcp'], win), 'WIN-BOX');
    assert.deepEqual(localizeServer(s['builder-mcp'], win), { command: 'C:\\tools\\builder-mcp.exe', args: ['--stdio'], forwardFromLocal: true });
    assert.equal(localizeServer(s.ws, win).command, 'C:\\ws\\ws.cmd', '按 os 覆盖');
    assert.equal(localizeServer(s.ws, { hostname: 'mac', platform: 'darwin' }).command, 'agentcore-websearch');
    assert.equal(localizeServer(s['builder-mcp'], { hostname: 'box', platform: 'linux' }).disabled, true);
    assert.equal(localizeServer(s.context7, win).disabled, true, 'http 型可以按机器关掉');
    assert.equal(localizeServer(s['builder-mcp'], { hostname: 'mac', platform: 'darwin' }).command, MAC_PATH);
    assert.equal('perMachine' in localizeServer(s['builder-mcp'], { hostname: 'mac', platform: 'darwin' }), false, '交出去的配置里没有 perMachine');
  });

  test('套过之后交给适配器 / 转发的是本机那份', () => {
    const r = parseMcpCombos(file) as any;
    const combo = localizeCombo(r.combos[0], { hostname: 'WIN-BOX', platform: 'win32' });
    const local = buildAcpMcpServers(combo, {});
    assert.deepEqual(local.servers.map((x: any) => [x.name, x.command ?? x.url]), [['builder-mcp', 'C:\\tools\\builder-mcp.exe'], ['ws', 'C:\\ws\\ws.cmd']]);
    const fwd = forwardableFromCombo(combo.mcpServers, {});
    assert.deepEqual(fwd.entries.map((e: any) => [e.name, e.command, e.args]), [['builder-mcp', 'C:\\tools\\builder-mcp.exe', ['--stdio']], ['ws', 'C:\\ws\\ws.cmd', []]]);
  });

  test('写错了说清楚', () => {
    const bad = (pm: unknown, extra: Record<string, unknown> = { command: 'x' }) => parseMcpCombos(JSON.stringify([{ id: 'a', name: 'A', mcpServers: { m: { ...extra, perMachine: pm } } }]));
    assert.equal(bad([]).ok, false);
    assert.equal(bad({ mac: 'x' }).ok, false);
    assert.equal(bad({ mac: { command: '' } }).ok, false);
    assert.equal(bad({ mac: { args: [1] } }).ok, false);
    assert.equal(bad({ mac: { env: {} } }).ok, false);
    assert.equal(bad({ mac: { command: 'y' } }, { url: 'https://x' }).ok, false, 'http 型只能按机器 disabled');
    assert.equal(bad({ mac: { disabled: true } }, { url: 'https://x' }).ok, true);
  });

  test('旧格式（没有 perMachine）照样读，套一遍不变', () => {
    const old = JSON.stringify([{ id: 'default', name: '通用', mcpServers: { 'builder-mcp': { command: 'builder-mcp', forwardFromLocal: true }, context7: { url: 'https://mcp.context7.com/mcp' } } }]);
    const r = parseMcpCombos(old) as any;
    assert.ok(r.ok);
    const s = r.combos[0].mcpServers;
    assert.equal(localizeServer(s['builder-mcp'], { hostname: 'x', platform: 'win32' }), s['builder-mcp'], '原样返回同一个对象');
    assert.deepEqual(localizeCombo(r.combos[0], { hostname: 'x', platform: 'win32' }).mcpServers, s);
  });
});

describe('「🧩 MCP 配置」面板：这台电脑不可用 + 一键设置命令 / 禁用', async () => {
  const { comboLocalAvailability, setMachineOverride } = await import('../src/main/comboAvailability.ts');
  const text = JSON.stringify([{ id: 'default', name: '通用', mcpServers: {
    'builder-mcp': { command: MAC_PATH, forwardFromLocal: true },
    ok: { command: 'node' },
    off: { command: '/nope/x', disabled: true },
    context7: { url: 'https://mcp.context7.com/mcp' },
  } }]);
  const machine = { hostname: 'WIN-BOX', platform: 'win32' };
  const opts = { platform: 'win32', env: { PATH: 'C:\\node' }, cwd: 'C:\\work', isFile: (p: string) => p === 'C:\\node\\node.exe' || p === 'C:\\tools\\b.exe' };

  test('只标找不到命令的 stdio MCP（关掉的、http 的不标）', () => {
    const items = comboLocalAvailability(text, machine, opts);
    assert.deepEqual(items.map((i) => [i.comboId, i.fileId, i.server, i.command]), [['default', 'default', 'builder-mcp', MAC_PATH]]);
    assert.ok(items[0].reason.includes(MAC_PATH));
  });

  test('为这台电脑设置命令：写进 perMachine[主机名]，之后就不标了；别的电脑照旧用原命令', () => {
    const next = setMachineOverride(text, 'default', 'builder-mcp', 'WIN-BOX', { command: 'C:\\tools\\b.exe', disabled: false })!;
    assert.ok(next);
    assert.ok(parseMcpCombos(next).ok);
    assert.deepEqual(JSON.parse(next)[0].mcpServers['builder-mcp'].perMachine, { 'WIN-BOX': { command: 'C:\\tools\\b.exe' } });
    assert.deepEqual(comboLocalAvailability(next, machine, opts), []);
    const mac = localizeServer((parseMcpCombos(next) as any).combos[0].mcpServers['builder-mcp'], { hostname: 'mbp', platform: 'darwin' });
    assert.equal(mac.command, MAC_PATH);
  });

  test('在这台电脑上禁用：perMachine[主机名].disabled = true；找不到那条 → null', () => {
    const next = setMachineOverride(text, 'default', 'builder-mcp', 'WIN-BOX', { disabled: true })!;
    assert.deepEqual(comboLocalAvailability(next, machine, opts), []);
    assert.equal(localizeServer((parseMcpCombos(next) as any).combos[0].mcpServers['builder-mcp'], machine).disabled, true);
    assert.equal(setMachineOverride(text, 'default', 'nope', 'WIN-BOX', { disabled: true }), null);
    assert.equal(setMachineOverride('{bad', 'default', 'builder-mcp', 'WIN-BOX', { disabled: true }), null);
  });
});
