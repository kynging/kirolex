/**
 * 「缺 Claude Code / Codex 适配器时一键安装，别只叫人去设置里找」。
 *
 * 守的几件事：
 *   · 会话里那条「没连上：没找到 … 的 ACP 适配器」提示认得出来（本机 / 远端、中 / 英），带「安装」按钮；
 *   · 本机装法是**全局 npm**，cwd 是**家目录** —— 绝不在 KiroLex 自己的目录里 npm install / npm ci
 *     （Falcon 会把官方 Electron 当 malware 杀掉）；
 *   · 远端走「安装 AI 工具」那个脚本，但只装缺的那一个（`ONLY=<bin>`）；
 *   · 装完自动重连这条会话；失败把原因说出来（会话里 + 日志）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import {
  localInstallCommand, runLocalAdapterInstall, createSharedInstalls, remoteInstallCommand, remoteInstallOutcome, adapterInstallFailedMessage, installFailureReason,
} from '../src/main/adapterInstall.ts';
import { managerModuleRoots, findAdapterEntry, resolveAdapter, adapterMissingMessage } from '../src/main/engines.ts';
import { adapterProblemMessage } from '../src/main/remoteAdapterProbe.ts';
import { adapterInstallOffer } from '../src/renderer/adapterInstallOffer.ts';
import { createAdapterInstallStore, runAdapterInstall } from '../src/renderer/adapterInstallState.ts';
import { connectFailureNotice } from '../src/renderer/connectFailure.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');
const REPO = path.join(import.meta.dirname, '..');

/** 假的 child_process.spawn：记下怎么被调的，由测试决定输出和退出码。 */
function fakeSpawn(script: { out?: string[]; code?: number | null; error?: Error }) {
  const calls: Array<{ command: string; args: string[]; opts: any }> = [];
  const spawn = (command: string, args: string[], opts: any) => {
    calls.push({ command, args, opts });
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    setImmediate(() => {
      if (script.error) { child.emit('error', script.error); return; }
      for (const line of script.out || []) child.stdout.emit('data', Buffer.from(line));
      child.emit('close', script.code ?? 0);
    });
    return child;
  };
  return { spawn, calls };
}

describe('本机：全局 npm，cwd = 家目录', () => {
  const home = path.join(os.tmpdir(), 'kirolex-home-x');

  test('Windows：cmd /c npm install -g <包>，cwd 是家目录', () => {
    const c = localInstallCommand('claude', { platform: 'win32', home, env: { ComSpec: 'C:\\Windows\\cmd.exe' } });
    assert.equal(c.cwd, home);
    assert.equal(c.command, 'C:\\Windows\\cmd.exe');
    assert.deepEqual(c.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(c.args[3], /^npm install -g @agentclientprotocol\/claude-agent-acp$/);
  });

  test('macOS / Linux：登录 bash 里找 npm（含 fnm / nvm / Volta / asdf 的），先 cd 到家目录再 install -g', () => {
    const c = localInstallCommand('codex', { platform: 'darwin', home, env: {} });
    assert.equal(c.cwd, home);
    assert.equal(c.command, '/bin/bash');
    assert.equal(c.args[0], '-lc');
    const script = c.args[1];
    assert.match(script, /cd "\$HOME"/);
    assert.match(script, /install -g "\$kx_pkg"/);
    assert.match(script, /kx_pkg='@agentclientprotocol\/codex-acp'/);
    for (const dir of ['fnm', '.nvm', '.volta', '.asdf', '/opt/homebrew/bin']) assert.ok(script.includes(dir), dir);
  });

  test('绝不在 KiroLex 自己的目录里装：没有 npm ci、没有 --prefix、没有不带 -g 的 install，cwd 不在仓库里', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const engine of ['claude', 'codex'] as const) {
        const c = localInstallCommand(engine, { platform, home, env: {} });
        const all = [c.command, ...c.args].join(' ');
        assert.ok(!/\bnpm ci\b|\bci\b.*npm|--prefix/.test(all), all);
        assert.ok(/install -g/.test(all), all);
        assert.ok(!path.resolve(c.cwd).startsWith(path.resolve(REPO)), c.cwd);
        assert.equal(c.cwd, home);
      }
    }
  });

  test('点了「安装」→ 调全局 npm（cwd=家目录），输出边跑边给，装完确认找得到入口', async () => {
    const { spawn, calls } = fakeSpawn({ out: ['added 12 packages in 3s\n'], code: 0 });
    const seen: string[] = [];
    const r = await runLocalAdapterInstall('claude', {
      spawn: spawn as any, platform: 'win32', home, env: { PATH: 'x' },
      onOutput: (s) => seen.push(s), findEntry: () => 'C:/npm/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
    });
    assert.deepEqual(r, { ok: true, entry: 'C:/npm/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.cwd, home);
    assert.match(calls[0].args.join(' '), /npm install -g @agentclientprotocol\/claude-agent-acp/);
    assert.ok(seen.join('').includes('npm install -g @agentclientprotocol/claude-agent-acp'), '先说一句在跑哪条命令');
    assert.ok(seen.join('').includes('added 12 packages'));
  });

  test('npm 失败：带上原因（没有权限 / 最后几行输出）', async () => {
    const { spawn } = fakeSpawn({ out: ['npm ERR! code EACCES\n', 'npm ERR! path /usr/local/lib/node_modules\n'], code: 243 });
    const r = await runLocalAdapterInstall('codex', { spawn: spawn as any, platform: 'darwin', home, env: {}, findEntry: () => null });
    assert.equal(r.ok, false);
    assert.match((r as any).error, /EACCES/);
  });

  test('没有 npm：说要先装 Node.js，不贴一句看不懂的退出码', async () => {
    const win = await runLocalAdapterInstall('claude', {
      spawn: fakeSpawn({ out: ["'npm' is not recognized as an internal or external command,\n"], code: 1 }).spawn as any,
      platform: 'win32', home, env: {}, findEntry: () => null,
    });
    assert.equal(win.ok, false);
    assert.match((win as any).error, /Node\.js/);
    const mac = await runLocalAdapterInstall('claude', {
      spawn: fakeSpawn({ out: ['KX_NO_NPM\n'], code: 127 }).spawn as any, platform: 'darwin', home, env: {}, findEntry: () => null,
    });
    assert.match((mac as any).error, /Node\.js/);
  });

  test('npm 说装好了、却哪儿都找不到入口：算失败并说清楚', async () => {
    const r = await runLocalAdapterInstall('claude', {
      spawn: fakeSpawn({ out: ['added 1 package\n'], code: 0 }).spawn as any, platform: 'win32', home, env: {}, findEntry: () => null,
    });
    assert.equal(r.ok, false);
    assert.match((r as any).error, /@agentclientprotocol\/claude-agent-acp/);
  });

  test('npm 起不来（spawn 报错）也是失败、带原因', async () => {
    const r = await runLocalAdapterInstall('claude', {
      spawn: fakeSpawn({ error: new Error('spawn cmd.exe ENOENT') }).spawn as any, platform: 'win32', home, env: {}, findEntry: () => null,
    });
    assert.equal(r.ok, false);
    assert.match((r as any).error, /ENOENT/);
  });

  test('spawn 同步抛错（例如 EINVAL）：返回原始原因，不被别的异常顶掉', async () => {
    const r = await runLocalAdapterInstall('claude', {
      spawn: (() => { throw new Error('spawn EINVAL'); }) as any, platform: 'win32', home, env: {}, findEntry: () => null,
    });
    assert.equal(r.ok, false);
    assert.match((r as any).error, /spawn EINVAL/);
  });

  test('失败提示：说是哪台机器、哪个包、为什么', () => {
    const local = adapterInstallFailedMessage('claude', undefined, installFailureReason('npm ERR! 404 Not Found\n', 1));
    assert.match(local, /claude-agent-acp/);
    assert.match(local, /404 Not Found/);
    const remote = adapterInstallFailedMessage('codex', 'ec2-user@1.2.3.4', 'boom');
    assert.match(remote, /ec2-user@1\.2\.3\.4/);
    assert.match(remote, /codex-acp/);
  });
});

describe('本机装完的探测：沿用 fnm / nvm / Volta / asdf 那套目录', () => {
  test('各管理器的全局 node_modules 都在候选里，新版本排前面', () => {
    const home = '/Users/u';
    const dirs: Record<string, string[]> = {
      [path.join(home, '.local', 'share', 'fnm', 'node-versions')]: ['v20.1.0', 'v22.3.0'],
      [path.join(home, '.nvm', 'versions', 'node')]: ['v18.0.0'],
      [path.join(home, '.asdf', 'installs', 'nodejs')]: ['21.0.0'],
    };
    const roots = managerModuleRoots({}, home, (d) => dirs[d] || []);
    const fnm22 = path.join(home, '.local', 'share', 'fnm', 'node-versions', 'v22.3.0', 'installation', 'lib', 'node_modules');
    const fnm20 = path.join(home, '.local', 'share', 'fnm', 'node-versions', 'v20.1.0', 'installation', 'lib', 'node_modules');
    assert.ok(roots.indexOf(fnm22) >= 0 && roots.indexOf(fnm22) < roots.indexOf(fnm20));
    assert.ok(roots.includes(path.join(home, '.nvm', 'versions', 'node', 'v18.0.0', 'lib', 'node_modules')));
    assert.ok(roots.includes(path.join(home, '.asdf', 'installs', 'nodejs', '21.0.0', 'lib', 'node_modules')));
    assert.ok(roots.includes(path.join(home, '.volta', 'tools', 'image', 'packages', '@agentclientprotocol', 'claude-agent-acp', 'lib', 'node_modules')));
  });

  test('装进 fnm 的 node 下的适配器：找得到入口，用本进程的 node 起', () => {
    const root = '/Users/u/.local/share/fnm/node-versions/v22.3.0/installation/lib/node_modules';
    const want = path.join(root, '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
    assert.equal(findAdapterEntry('claude', {}, { roots: ['/nope', root], exists: (p) => p === want }), want);
    const a = resolveAdapter('claude', {}, { roots: [root], exists: (p) => p === want, execPath: '/electron', platform: 'darwin' });
    assert.deepEqual(a.args, [want]);
  });
});

describe('远端：「安装 AI 工具」那个脚本，只装缺的那一个', () => {
  test('命令带 ONLY=<那一个的命令名>，脚本落临时文件再跑、跑完删', () => {
    const c = remoteInstallCommand('/tmp/kx.sh', 'codex');
    assert.match(c, /^cat > \/tmp\/kx\.sh && ONLY=codex-acp bash \/tmp\/kx\.sh; rc=\$\?; rm -f \/tmp\/kx\.sh; exit \$rc$/);
    assert.match(remoteInstallCommand('/tmp/kx.sh', 'claude'), /ONLY=claude-agent-acp /);
  });

  test('脚本认 ONLY：只装那一个适配器，kiro-cli / claude / codex / 另一个适配器 / 登录 / sshd 全跳过', () => {
    const sh = read('scripts', 'remote-bootstrap.sh');
    assert.match(sh, /^ONLY="\$\{ONLY:-\}"$/m);
    assert.match(sh, /^want\(\) \{/m);
    assert.match(sh, /^full\(\) \{/m);
    /* 两个适配器各自只在被点名（或全装）时装 */
    assert.match(sh, /^want claude-agent-acp && npm_i '@agentclientprotocol\/claude-agent-acp' claude-agent-acp$/m);
    assert.match(sh, /^want codex-acp && npm_i '@agentclientprotocol\/codex-acp' codex-acp$/m);
    assert.match(sh, /^want claude-agent-acp && login_visible claude-agent-acp/m);
    assert.match(sh, /^want codex-acp && login_visible codex-acp/m);
    /* 适配器之前的那几步只在全装时跑 */
    for (const step of ['step "系统包', 'step "kiro-cli"', 'step "claude code / codex']) {
      const at = sh.indexOf(step);
      assert.ok(at > 0, step);
      assert.match(sh.slice(at - 40, at), /if full; then\s*$/, `${step} 前面要有 if full; then`);
    }
    assert.match(sh, /^if full; then\nif have claude/m, 'claude CLI 只在全装时装');
    assert.match(sh, /npm_i '@openai\/codex' codex\nfi\n/, 'codex CLI 只在全装时装');
    /* ONLY 模式装完那一个就收尾（退出码只看它），后面的默认模型 / 登录 / sshd / 全量自检都到不了 */
    const exitAt = sh.search(/if \[ -n "\$ONLY" \]; then\n  step "自检/);
    assert.ok(exitAt > 0);
    assert.match(sh.slice(exitAt), /^if \[ -n "\$ONLY" \]; then[\s\S]*?\n  exit "\$rc"\nfi\n/);
    for (const step of ['step "默认模型', 'step "kiro-cli 登录"', 'step "sshd 回收死连接"', 'step "自检"']) {
      assert.ok(sh.indexOf(step) > exitAt, `${step} 要在 ONLY 收尾之后`);
    }
    /* 只装一个时已有 node 不升级（升级会换掉全局 node_modules 的版本目录，另一家会"消失"） */
    assert.match(sh, /if \[ -n "\$ONLY" \] && have node; then/);
  });

  test('脚本里 npm 失败不再吞掉输出：最后几行加「  npm: 」前缀带出来', () => {
    const sh = read('scripts', 'remote-bootstrap.sh');
    const fn = sh.slice(sh.indexOf('npm_i() {'), sh.indexOf('\n}\n', sh.indexOf('npm_i() {')));
    assert.ok(!/npm install -g "\$pkg" >\/dev\/null/.test(fn), 'npm 的输出不能直接丢进 /dev/null');
    assert.match(fn, /tail -n 12 "\$npm_log"[^\n]*sed 's\/\^\/  npm: \/'/);
  });

  test('真跑一遍：远端 npm 失败时，具体原因（网络错误）出现在输出里，并进到失败提示', { skip: (() => { try { execFileSync('bash', ['-c', 'true']); return false; } catch { return '这台机器没有 bash'; } })() }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-only-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho v22.0.0\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'npm'), [
        '#!/bin/sh',
        `if [ "$1" = root ]; then echo "${dir.replace(/\\/g, '/')}/g"; exit 0; fi`,
        'echo "npm error code ENOTFOUND" >&2',
        'echo "npm error network request to https://registry.npmjs.org/@agentclientprotocol%2fcodex-acp failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org" >&2',
        'exit 1',
      ].join('\n') + '\n', { mode: 0o755 });
      const toPosix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
      let out = '';
      let code = 0;
      try {
        out = execFileSync('bash', ['-c', `export HOME="$1" PATH="$2:/usr/bin:/bin" ONLY=codex-acp; bash "$3" </dev/null 2>&1`, 'x', toPosix(dir), toPosix(bin), toPosix(path.join(REPO, 'scripts', 'remote-bootstrap.sh'))], { encoding: 'utf8' });
      } catch (e: any) { out = String(e.stdout || ''); code = e.status; }
      assert.notEqual(code, 0);
      assert.match(out, /^  npm: npm error code ENOTFOUND$/m);
      assert.ok(!/claude-agent-acp 装不上|npm i -g @agentclientprotocol\/claude-agent-acp/.test(out), '只装 codex-acp');
      const r = remoteInstallOutcome('codex', 'ec2-user@1.2.3.4', { code, output: out }, { ok: false, line: '⚠️ 装完起不来' });
      assert.equal(r.ok, false);
      assert.match((r as any).error, /ec2-user@1\.2\.3\.4/);
      assert.match((r as any).error, /getaddrinfo ENOTFOUND registry\.npmjs\.org/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('远端结论：npm 那几行（权限 / 网络）进失败提示；验证通过才算装好；ssh 没连上不验证', () => {
    const output = ['== ACP 适配器 codex-acp（npm 全局） ==', '→ npm i -g @agentclientprotocol/codex-acp',
      '  npm: npm error code EACCES', '  npm: npm error path /usr/lib/node_modules/@agentclientprotocol',
      '✗ @agentclientprotocol/codex-acp 装不上', '', '== 自检（codex-acp） ==', 'codex-acp : **登录 shell 里找不到**',
      '✗ codex-acp 没装好，见上面标 ✗ 的那几行。'].join('\n');
    const bad = remoteInstallOutcome('codex', 'h', { code: 1, output }, { ok: false, line: '⚠️ verify failed' }) as any;
    assert.equal(bad.ok, false);
    assert.match(bad.error, /EACCES/);
    assert.match(bad.error, /\/usr\/lib\/node_modules/);
    assert.match(bad.error, /✗ @agentclientprotocol\/codex-acp 装不上/);
    assert.match(bad.error, /verify failed/);
    assert.deepEqual(remoteInstallOutcome('codex', 'h', { code: 0, output: '' }, { ok: true, line: 'ok' }), { ok: true });
    const ssh = remoteInstallOutcome('codex', 'h', { code: 255, output: 'ssh: connect to host h port 22: Connection timed out' }) as any;
    assert.match(ssh.error, /Connection timed out/);
    const spawnErr = remoteInstallOutcome('codex', 'h', { code: null, output: '', error: 'spawn ssh ENOENT' }) as any;
    assert.match(spawnErr.error, /spawn ssh ENOENT/);
  });

  test('主进程把远端失败原因交给会话和日志（remoteInstallOutcome → noteInSession / logger.warn）', () => {
    const M = read('src', 'main', 'index.ts');
    const fn = M.slice(M.indexOf('async function installRemoteAdapter('), M.indexOf('function remotePreflight('));
    assert.match(fn, /remoteInstallOutcome\(engine, host, result, \{ ok: v\.ok, line \}\)/);
    const h = M.slice(M.indexOf("ipcMain.handle('acp:install-adapter'"), M.indexOf("ipcMain.handle('acp:install-adapter'") + 4000);
    assert.match(h, /logger\.warn\('engine', `install-adapter[^`]*没装上：\$\{error\}`\)/);
    assert.match(h, /noteInSession\(sid, error,/);
  });

  test('脚本仍是 LF（管道给远端 bash）', () => {
    assert.ok(!read('scripts', 'remote-bootstrap.sh').includes('\r\n'));
  });
});

describe('会话里的提示认得出「缺适配器」，带「安装」按钮', () => {
  test('本机：中英两种说法都认，按包名判是哪一家', () => {
    const en = 'Could not find the ACP adapter for Claude Code. Install it: `npm i -g @agentclientprotocol/claude-agent-acp` (no need to restart KiroLex afterwards, it is looked up again when you create a session).';
    const zh = '没找到 Codex 的 ACP 适配器。装一下：`npm i -g @agentclientprotocol/codex-acp`（装完不用重启 KiroLex，新建会话时会重新找）。';
    assert.deepEqual(adapterInstallOffer(connectFailureNotice(en, 1, 'en').content), { engine: 'claude' });
    assert.deepEqual(adapterInstallOffer(connectFailureNotice(zh, 1, 'zh').content), { engine: 'codex' });
  });

  test('远端：「<host> 上没有 … 的 ACP 适配器」中英都认', () => {
    const zh = 'ec2-user@166.117.109.70 上没有 Codex 的 ACP 适配器（codex-acp）。设置 → 🖥 机器 → 选中这台机器 →「安装 AI 工具」会装上它（@agentclientprotocol/codex-acp）；另外那台机器上要登录过 Codex。';
    const en = 'graviton has no ACP adapter for Claude Code (claude-agent-acp). Settings → 🖥 Machines → select this machine → "Install AI tools" will install it (@agentclientprotocol/claude-agent-acp). You also need to have signed in to Claude Code on that machine.';
    assert.deepEqual(adapterInstallOffer(zh), { engine: 'codex' });
    assert.deepEqual(adapterInstallOffer(en), { engine: 'claude' });
    /* 主进程真正说的那句（tr 出来的）也认 */
    assert.deepEqual(adapterInstallOffer(adapterProblemMessage('h', 'codex', { kind: 'missing' })!), { engine: 'codex' });
    assert.deepEqual(adapterInstallOffer(adapterMissingMessage('claude')), { engine: 'claude' });
  });

  test('「装了但没有 node 能跑」、登录问题、别的报错：不给安装按钮（重装治不了）', () => {
    const noNode = adapterProblemMessage('h', 'claude', { kind: 'no-node', manager: 'fnm', entry: '/h/.local/share/fnm/node-versions/v22/installation/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js' })!;
    assert.equal(adapterInstallOffer(noNode), null);
    assert.equal(adapterInstallOffer('Claude Code is not logged in on the machine running this session.'), null);
    assert.equal(adapterInstallOffer('ECONNREFUSED'), null);
    assert.equal(adapterInstallOffer(''), null);
  });

  test('提示里不带 Electron 的英文前缀（复用 9432ab38 的 cleanIpcError）', () => {
    const n = connectFailureNotice(`Error invoking remote method 'acp:new-session': Error: ${adapterMissingMessage('claude')}`, 1, 'zh');
    assert.ok(!/Error invoking remote method/.test(n.content));
    assert.deepEqual(adapterInstallOffer(n.content), { engine: 'claude' });
  });
});

describe('点「安装」之后：进度 → 装好自动重连；失败说原因', () => {
  test('成功：先显示安装中和输出，装完重连这条会话，连上了标「已连上」', async () => {
    const store = createAdapterInstallStore();
    const phases: string[] = [];
    store.subscribe(() => { const s = store.get('s1'); if (s && phases[phases.length - 1] !== s.phase) phases.push(s.phase); });
    const reconnected: string[] = [];
    const ok = await runAdapterInstall(store, 's1', 'claude', {
      install: async (sid, engine) => {
        assert.equal(sid, 's1'); assert.equal(engine, 'claude');
        store.append('s1', '$ npm install -g @agentclientprotocol/claude-agent-acp\nadded 3 packages\n');
        return { ok: true };
      },
      reconnect: async (sid) => { reconnected.push(sid); return { ok: true }; },
    });
    assert.equal(ok, true);
    assert.deepEqual(reconnected, ['s1']);
    assert.deepEqual(phases, ['installing', 'reconnecting', 'connected']);
    assert.match(store.get('s1')!.output, /added 3 packages/);
  });

  test('安装失败：不重连，状态是 failed、带原因', async () => {
    const store = createAdapterInstallStore();
    let reconnects = 0;
    const ok = await runAdapterInstall(store, 's2', 'codex', {
      install: async () => ({ ok: false, error: '在本机安装 Codex 的 ACP 适配器（@agentclientprotocol/codex-acp）没成功：EACCES' }),
      reconnect: async () => { reconnects += 1; return { ok: true }; },
    });
    assert.equal(ok, false);
    assert.equal(reconnects, 0);
    assert.equal(store.get('s2')!.phase, 'failed');
    assert.match(store.get('s2')!.error!, /EACCES/);
  });

  test('IPC 本身抛错也算失败（不卡在「安装中」）', async () => {
    const store = createAdapterInstallStore();
    const ok = await runAdapterInstall(store, 's3', 'claude', {
      install: async () => { throw new Error("Error invoking remote method 'acp:install-adapter': Error: boom"); },
      reconnect: async () => ({ ok: true }),
    });
    assert.equal(ok, false);
    assert.equal(store.get('s3')!.phase, 'failed');
    assert.equal(store.get('s3')!.error, 'boom');
  });

  test('装好了但重连失败：状态说重连没成，不说「已连上」', async () => {
    const store = createAdapterInstallStore();
    const ok = await runAdapterInstall(store, 's4', 'claude', {
      install: async () => ({ ok: true }),
      reconnect: async () => ({ ok: false, error: 'not logged in' }),
    });
    assert.equal(ok, false);
    assert.equal(store.get('s4')!.phase, 'reconnect-failed');
  });

  test('同一条会话装着的时候再点：不再起第二次', async () => {
    const store = createAdapterInstallStore();
    let installs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const deps = {
      install: async () => { installs += 1; await gate; return { ok: true as const }; },
      reconnect: async () => ({ ok: true }),
    };
    const a = runAdapterInstall(store, 's5', 'claude', deps);
    const b = runAdapterInstall(store, 's5', 'claude', deps);
    release();
    await Promise.all([a, b]);
    assert.equal(installs, 1);
  });
});

describe('同一机器、同一引擎的安装复用：进度和结果广播给所有在等的会话', () => {
  /** 主进程那一侧：每条会话一个 send（带自己的 sessionId），都 join 同一个 key；渲染层按 sessionId 收进各自的状态。 */
  function wire() {
    const shared = createSharedInstalls();
    const store = createAdapterInstallStore();
    const sent: Record<string, string> = {};
    const starts: string[] = [];
    let child: any;
    const spawn = (command: string, args: string[], opts: any) => {
      starts.push(opts.cwd);
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      return child;
    };
    const install = (sid: string, engine: 'claude' | 'codex', findEntry: () => string | null) => {
      const send = (chunk: string) => { sent[sid] = (sent[sid] || '') + chunk; store.append(sid, chunk); };
      return shared.join(`local|${engine}`, send, (broadcast) => runLocalAdapterInstall(engine, {
        spawn: spawn as any, platform: 'linux', home: '/home/u', env: {}, onOutput: broadcast, findEntry,
      })).promise;
    };
    return { shared, store, sent, starts, install, child: () => child };
  }

  test('两条会话先后点同一个安装：只起一次 npm，两边都收到进度（后点的补收前面的输出），装好都重连', async () => {
    const w = wire();
    const reconnected: string[] = [];
    const deps = (entry: string | null) => ({
      install: (sid: string, engine: 'claude' | 'codex') => w.install(sid, engine, () => entry),
      reconnect: async (sid: string) => { reconnected.push(sid); return { ok: true }; },
    });
    const a = runAdapterInstall(w.store, 'sA', 'claude', deps('/g/claude-agent-acp/dist/index.js'));
    w.child().stdout.emit('data', Buffer.from('fetching claude-agent-acp\n'));
    const b = runAdapterInstall(w.store, 'sB', 'claude', deps('/g/claude-agent-acp/dist/index.js'));
    assert.equal(w.shared.has('local|claude'), true);
    w.child().stdout.emit('data', Buffer.from('added 3 packages\n'));
    w.child().emit('close', 0);
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
    assert.equal(w.starts.length, 1, '同一个安装只起一次');
    for (const sid of ['sA', 'sB']) {
      assert.match(w.sent[sid], /fetching claude-agent-acp/, `${sid} 收到装之前的输出`);
      assert.match(w.sent[sid], /added 3 packages/, `${sid} 收到之后的输出`);
      assert.match(w.store.get(sid)!.output, /added 3 packages/);
      assert.equal(w.store.get(sid)!.phase, 'connected');
    }
    assert.deepEqual(reconnected.sort(), ['sA', 'sB']);
    assert.equal(w.shared.has('local|claude'), false, '装完就把 job 删掉，下次点重新装');
  });

  test('复用的安装失败：两边都拿到同一个失败原因、都不重连', async () => {
    const w = wire();
    let reconnects = 0;
    const deps = {
      install: (sid: string, engine: 'claude' | 'codex') => w.install(sid, engine, () => null),
      reconnect: async () => { reconnects += 1; return { ok: true }; },
    };
    const a = runAdapterInstall(w.store, 'sA', 'codex', deps);
    const b = runAdapterInstall(w.store, 'sB', 'codex', deps);
    w.child().stderr.emit('data', Buffer.from('npm ERR! code EACCES\n'));
    w.child().emit('close', 243);
    assert.deepEqual(await Promise.all([a, b]), [false, false]);
    assert.equal(w.starts.length, 1);
    assert.equal(reconnects, 0);
    for (const sid of ['sA', 'sB']) {
      assert.equal(w.store.get(sid)!.phase, 'failed');
      assert.match(w.store.get(sid)!.error!, /EACCES/);
      assert.match(w.sent[sid], /npm ERR! code EACCES/);
    }
  });

  test('不同引擎 / 不同机器不合并；一个订阅者的回调抛错不影响别的', async () => {
    const shared = createSharedInstalls();
    let n = 0;
    const got: string[] = [];
    const start = (broadcast: (s: string) => void) => { n += 1; broadcast('x'); return Promise.resolve({ ok: true as const }); };
    shared.join('local|claude', () => { throw new Error('窗口没了'); }, (broadcast) => new Promise((r) => setImmediate(() => { broadcast('y'); r({ ok: true }); })));
    shared.join('local|claude', (c) => got.push(c), start);
    await Promise.all([shared.join('local|codex', () => {}, start).promise, shared.join('graviton|claude', () => {}, start).promise]);
    assert.equal(n, 2);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(got, ['y']);
  });

  test('主进程的 acp:install-adapter 用共享安装：输出交给 broadcast，不再只绑第一次点的那条会话', () => {
    const M = read('src', 'main', 'index.ts');
    const at = M.indexOf("ipcMain.handle('acp:install-adapter'");
    const body = M.slice(at, at + 4000);
    assert.match(M, /const adapterInstallsInFlight = createSharedInstalls(<[^>]*>)?\(\)/);
    assert.match(body, /adapterInstallsInFlight\.join\(key, send,/);
    assert.match(body, /installRemoteAdapter\(remote!, engine, broadcast\)/);
    assert.match(body, /onOutput: broadcast,/);
  });
});

describe('接线', () => {
  const M = read('src', 'main', 'index.ts');
  const P = read('src', 'main', 'preload.ts');
  const C = read('src', 'renderer', 'components', 'ChatArea.tsx');
  const U = read('src', 'renderer', 'hooks', 'useAcp.ts');

  test('主进程注册 acp:install-adapter：本机用 runLocalAdapterInstall（家目录），远端用 ONLY 脚本 + 装完验证，失败写会话和日志', () => {
    const at = M.indexOf("ipcMain.handle('acp:install-adapter'");
    assert.ok(at > 0);
    const body = M.slice(at, at + 4000);
    assert.match(body, /runLocalAdapterInstall\(/);
    assert.match(body, /home: os\.homedir\(\)/);
    assert.match(body, /installRemoteAdapter\(/);
    assert.match(body, /noteInSession\(/);
    assert.match(body, /logger\.(warn|error)\(/);
    const fn = M.slice(M.indexOf('async function installRemoteAdapter('), M.indexOf('async function installRemoteAdapter(') + 3000);
    assert.match(fn, /remoteInstallCommand\(/);
    assert.match(fn, /verifyRemoteAdapter\(/);
  });

  test('preload 暴露 installAdapter 和进度事件', () => {
    assert.match(P, /installAdapter: \(sessionId: string, engine: string, remoteId\?: string\) =>\s*ipcRenderer\.invoke\('acp:install-adapter'/);
    assert.match(P, /'acp:adapter-install-output'/);
  });

  test('会话里那条 KiroLex 提示渲染安装按钮；useAcp 登记安装 + 重连', () => {
    assert.match(C, /<AdapterInstallAction /);
    assert.match(U, /setAdapterInstallRunner\(/);
    assert.match(U, /reconnectAfterInstall/);
  });
});
