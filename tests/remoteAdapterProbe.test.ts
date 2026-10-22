/**
 * 远端 Claude Code / Codex 适配器的探测 ——「远程机器的 Node 由 fnm/nvm 管时，已装的 claude-agent-acp 被判成没装」。
 *
 * 守的是：
 *   · 登录 shell（`bash -lc`）里没有 node 时，照样能在 fnm / nvm / volta / asdf 的目录里找到适配器，
 *     并给出「node 绝对路径 + 适配器入口」的启动命令；
 *   · 「没装」「装了但没有 node 能跑它」是两句不同的话，后者说出是哪个 Node 管理器、怎么修，不引导重装；
 *   · 安装后的验证失败要说清原因（退出码 / stderr 最后几行 / 超时）；
 *   · 远端 Claude Code / Codex 没登录、也没配 Bedrock / API key 时，连上就能知道。
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  adapterProbeScript, parseAdapterProbe, judgeAdapterProbe, adapterProblemMessage, adapterHiddenNotice,
  adapterExecLine, judgeAdapterVerify, adapterVerifyMessage, remoteAuthConfigured, remoteLoginHint,
  rememberRemoteAdapterLaunch, remoteAdapterLaunchFor, managerFix,
} from '../src/main/remoteAdapterProbe.ts';
import { buildRemoteAdapterCommand } from '../src/main/acp-client.ts';
import { setUiLang } from '../src/main/uiText.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');

const FNM_ROOT = '/home/ec2-user/.local/share/fnm/node-versions/v22.23.3/installation';
const FNM_ENTRY = `${FNM_ROOT}/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`;
const NVM_ROOT = '/home/u/.nvm/versions/node/v20.11.1';
const NVM_ENTRY = `${NVM_ROOT}/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js`;

beforeEach(() => { setUiLang('zh'); });

describe('探测脚本', () => {
  test('找登录 shell 的 PATH，也扫 fnm / nvm / volta / asdf 的目录', () => {
    const s = adapterProbeScript('claude');
    assert.match(s, /command -v 'claude-agent-acp'/);
    assert.match(s, /command -v node/);
    assert.match(s, /fnm\}?"?\/node-versions\/\*\/installation/);
    assert.match(s, /\.nvm\}?"?\/versions\/node\/\*/);
    assert.match(s, /\.volta\}?"?\/tools\/image\/node\/\*/);
    assert.match(s, /\.asdf\}?"?\/installs\/nodejs\/\*/);
    assert.match(s, /kx_pkg='@agentclientprotocol\/claude-agent-acp'/);
    assert.match(s, /\/lib\/node_modules\/\$kx_pkg\/dist\/index\.js/);
    assert.match(adapterProbeScript('codex'), /kx_pkg='@agentclientprotocol\/codex-acp'/);
  });

  test('解析：认得出每一类行，profile 里打印的杂音不算', () => {
    const p = parseAdapterProbe([
      'Welcome to Amazon Linux',
      `KX_NODE\tfnm\t${FNM_ROOT}/bin/node`,
      `KX_ENTRY\tfnm\t${FNM_ENTRY}`,
      `KX_ENTRY\tfnm\t${FNM_ENTRY}`,
      'KX_AUTH\tsettings',
      '',
    ].join('\r\n'));
    assert.equal(p.pathBin, undefined);
    assert.equal(p.loginNode, undefined);
    assert.deepEqual(p.nodes, [{ manager: 'fnm', path: `${FNM_ROOT}/bin/node` }]);
    assert.deepEqual(p.entries, [{ manager: 'fnm', path: FNM_ENTRY }], '重复的去掉');
    assert.deepEqual(p.auth, ['settings']);
  });
});

describe('判定：fnm / nvm 布局下登录 shell 没有 node', () => {
  test('fnm：登录 shell 里既没有适配器也没有 node → 用 fnm 的 node 绝对路径 + 入口', () => {
    const v = judgeAdapterProbe(parseAdapterProbe([
      `KX_NODE\tfnm\t${FNM_ROOT}/bin/node`,
      `KX_ENTRY\tfnm\t${FNM_ENTRY}`,
    ].join('\n')));
    assert.deepEqual(v, { kind: 'absolute', manager: 'fnm', node: `${FNM_ROOT}/bin/node`, entry: FNM_ENTRY });
    const line = adapterExecLine('claude-agent-acp', v);
    assert.equal(line, `export PATH='${FNM_ROOT}/bin':"$PATH"; exec '${FNM_ROOT}/bin/node' '${FNM_ENTRY}'`,
      'node 的目录也放进 PATH：适配器自己再起 node 子进程时要找得到');
  });

  test('nvm：几个版本里挑和适配器同一个版本目录的那个 node', () => {
    const v = judgeAdapterProbe(parseAdapterProbe([
      'KX_NODE\tnvm\t/home/u/.nvm/versions/node/v22.1.0/bin/node',
      `KX_NODE\tnvm\t${NVM_ROOT}/bin/node`,
      `KX_ENTRY\tnvm\t${NVM_ENTRY}`,
    ].join('\n')));
    assert.deepEqual(v, { kind: 'absolute', manager: 'nvm', node: `${NVM_ROOT}/bin/node`, entry: NVM_ENTRY });
  });

  test('适配器在登录 PATH 上（npm prefix 的 symlink），但它是 node 脚本、登录 shell 没有 node → 用找到的 node 跑它', () => {
    const v = judgeAdapterProbe(parseAdapterProbe([
      'KX_PATHBIN\t/home/u/.local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js\t#!/usr/bin/env node',
      `KX_NODE\tfnm\t${FNM_ROOT}/bin/node`,
    ].join('\n')));
    assert.deepEqual(v, {
      kind: 'absolute', manager: 'fnm', node: `${FNM_ROOT}/bin/node`,
      entry: '/home/u/.local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
    });
  });

  test('登录 shell 里适配器和 node 都在 → 照旧 exec 命令名（不改原来那条路）', () => {
    const v = judgeAdapterProbe(parseAdapterProbe([
      'KX_PATHBIN\t/usr/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js\t#!/usr/bin/env node',
      'KX_LOGINNODE\t/usr/bin/node',
      `KX_NODE\tfnm\t${FNM_ROOT}/bin/node`,
    ].join('\n')));
    assert.deepEqual(v, { kind: 'path' });
    assert.equal(adapterExecLine('claude-agent-acp', v), "exec 'claude-agent-acp'");
  });

  test('登录 PATH 上是个 sh 包装脚本（不需要登录 shell 里有 node）→ exec 命令名', () => {
    const v = judgeAdapterProbe(parseAdapterProbe('KX_PATHBIN\t/home/u/.local/bin/claude-agent-acp\t#!/bin/sh'));
    assert.deepEqual(v, { kind: 'path' });
  });

  test('哪儿都没有 → missing；有适配器但哪儿都没有 node → no-node（带上管理器）', () => {
    assert.deepEqual(judgeAdapterProbe(parseAdapterProbe(`KX_NODE\tfnm\t${FNM_ROOT}/bin/node`)), { kind: 'missing' });
    assert.deepEqual(judgeAdapterProbe(parseAdapterProbe(`KX_ENTRY\tfnm\t${FNM_ENTRY}`)),
      { kind: 'no-node', manager: 'fnm', entry: FNM_ENTRY });
  });
});

describe('三种提示', () => {
  test('没装：引导「安装 AI 工具」', () => {
    const m = adapterProblemMessage('ec2-user@h', 'claude', { kind: 'missing' })!;
    assert.match(m, /ec2-user@h 上没有 Claude Code 的 ACP 适配器（claude-agent-acp）/);
    assert.match(m, /安装 AI 工具/);
  });

  test('装了但没有 node 能跑它：说出管理器和修法，不引导重装', () => {
    const m = adapterProblemMessage('ec2-user@h', 'claude', { kind: 'no-node', manager: 'fnm', entry: FNM_ENTRY })!;
    assert.match(m, /装了 Claude Code 的 ACP 适配器/);
    assert.match(m, /fnm/);
    assert.match(m, /fnm env/, '告诉怎么修');
    assert.doesNotMatch(m, /安装 AI 工具|重装/);
    const en = (setUiLang('en'), adapterProblemMessage('h', 'codex', { kind: 'no-node', manager: 'nvm', entry: NVM_ENTRY })!);
    assert.match(en, /nvm/);
    assert.match(en, /nvm\.sh/);
  });

  test('装了但登录 shell 看不到（自动用绝对路径起了）：状态行说是哪个管理器、怎么让登录 shell 看得到', () => {
    const m = adapterHiddenNotice('ec2-user@h', 'claude', { kind: 'absolute', manager: 'fnm', node: `${FNM_ROOT}/bin/node`, entry: FNM_ENTRY })!;
    assert.match(m, /登录 shell 找不到/);
    assert.match(m, /fnm/);
    assert.match(m, /fnm env/);
    assert.doesNotMatch(m, /安装 AI 工具|重装/);
    assert.equal(adapterHiddenNotice('h', 'claude', { kind: 'path' }), undefined);
    assert.equal(adapterProblemMessage('h', 'claude', { kind: 'path' }), undefined);
  });

  test('每个管理器都有修法', () => {
    for (const m of ['fnm', 'nvm', 'volta', 'asdf', 'npm-prefix', 'system'] as const) assert.ok(managerFix(m).length > 5, m);
  });
});

describe('安装后验证', () => {
  test('回了 initialize 才算能起', () => {
    assert.deepEqual(judgeAdapterVerify({ stdout: '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n', stderr: '', exitCode: null, timedOut: false }), { ok: true });
  });

  test('起不来：说出退出码和 stderr 最后几行（ssh 的后量子告警不算原因）', () => {
    const v = judgeAdapterVerify({
      stdout: '', exitCode: 127, timedOut: false,
      stderr: '** WARNING: connection is not using a post-quantum key exchange algorithm.\nKIROLEX_REMOTE_PID 4242\n/usr/bin/env: ‘node’: No such file or directory\n',
    });
    assert.equal(v.ok, false);
    const m = adapterVerifyMessage('h', 'claude', v);
    assert.match(m, /装完按会话的启动方式（bash -lc）在 h 上试起 Claude Code 的适配器，没起来/);
    assert.match(m, /127/);
    assert.match(m, /No such file or directory/);
    assert.doesNotMatch(m, /post-quantum|KIROLEX_REMOTE_PID/);
  });

  test('超时：说是没回 initialize', () => {
    const v = judgeAdapterVerify({ stdout: '', stderr: '', exitCode: null, timedOut: true });
    assert.match(adapterVerifyMessage('h', 'codex', v), /没回 initialize/);
  });

  test('探测本身就判成没装 / 没 node：验证报的就是那一句', () => {
    const m = adapterVerifyMessage('h', 'claude', { ok: false, problem: adapterProblemMessage('h', 'claude', { kind: 'missing' }) });
    assert.match(m, /没有 Claude Code 的 ACP 适配器/);
  });
});

describe('安装脚本：装到登录 shell 看得见的地方', () => {
  const SH = read('scripts', 'remote-bootstrap.sh');
  test('两个适配器（含早就装好的）都要过 login_visible；看不到就在 ~/.local/bin 放用 node 绝对路径的包装脚本', () => {
    /* `want <bin> && `：全装时永远为真；只装一个（ONLY，会话里的「安装」）时只过那一个 */
    assert.match(SH, /^(want claude-agent-acp && )?login_visible claude-agent-acp '@agentclientprotocol\/claude-agent-acp'$/m);
    assert.match(SH, /^(want codex-acp && )?login_visible codex-acp '@agentclientprotocol\/codex-acp'$/m);
    assert.match(SH, /^want\(\) \{ \[ -z "\$ONLY" \] \|\| \[ "\$ONLY" = "\$1" \]; \}$/m, '不设 ONLY 时 want 永远为真');
    assert.match(SH, /bash -lc "command -v \$bin && command -v node"/, '判据和起适配器时一样：登录 shell 里连同 node');
    assert.match(SH, /readlink -f "\$nodebin"/, 'fnm 的 multishell 链接是临时的，要解到真正的安装目录');
    assert.match(SH, /rm -f "\$w"\n/, '先删：可能是 npm 的 symlink，直接写会改掉适配器入口');
    assert.match(SH, /exec '\$nodebin' '\$entry' "\\\$@"/);
    const at = SH.indexOf('login_visible claude-agent-acp');
    assert.ok(at > SH.indexOf("npm_i '@agentclientprotocol/codex-acp' codex-acp"), '装完之后');
  });
});

describe('登录状态', () => {
  test('Claude Code：有凭据 / 打开了 Bedrock 或 Vertex / 有非空的 key → 算配过；都没有 → 提示一句', () => {
    const ok = (out: string) => remoteAuthConfigured('claude', parseAdapterProbe(out));
    assert.equal(ok('KX_AUTH\tcredentials'), true);
    assert.equal(ok('KX_CFG\tsettings\tCLAUDE_CODE_USE_BEDROCK\t1'), true);
    assert.equal(ok('KX_CFG\tsettings\tCLAUDE_CODE_USE_VERTEX\ttrue'), true);
    assert.equal(ok('KX_CFG\tsettings\tANTHROPIC_API_KEY\tset'), true);
    assert.equal(ok('KX_CFG\tsettings\tapiKeyHelper\tset'), true);
    assert.equal(ok('KX_CFG\tclaudejson\tprimaryApiKey\tset'), true);
    assert.equal(ok('KX_CFG\tenv\tANTHROPIC_AUTH_TOKEN\tset'), true);
    assert.equal(ok('KX_CFG\tenv\tCLAUDE_CODE_USE_BEDROCK\t1'), true);
    assert.equal(ok(`KX_ENTRY\tfnm\t${FNM_ENTRY}`), false);
  });

  test('只写了名字不算：空 key、开关是 0 / false、只配了网关地址 → 仍然提示', () => {
    const ok = (out: string) => remoteAuthConfigured('claude', parseAdapterProbe(out));
    assert.equal(ok('KX_CFG\tsettings\tANTHROPIC_API_KEY\tempty'), false, '空的 API key');
    assert.equal(ok('KX_CFG\tsettings\tANTHROPIC_AUTH_TOKEN\tempty\nKX_CFG\tclaudejson\tprimaryApiKey\tempty'), false);
    assert.equal(ok('KX_CFG\tsettings\tCLAUDE_CODE_USE_BEDROCK\t0'), false, 'Bedrock 关着');
    assert.equal(ok('KX_CFG\tsettings\tCLAUDE_CODE_USE_BEDROCK\tfalse'), false);
    assert.equal(ok('KX_CFG\tenv\tCLAUDE_CODE_USE_BEDROCK\t0'), false, '环境变量里 Bedrock=0');
    assert.equal(ok('KX_CFG\tsettings\tANTHROPIC_BASE_URL\tset'), false, '只有地址、没有 key');
  });

  test('Codex：auth.json 非空 / config.toml 里有非空的 model_provider / 非空的 key 环境变量', () => {
    const ok = (out: string) => remoteAuthConfigured('codex', parseAdapterProbe(out));
    assert.equal(ok('KX_AUTH\tauth-json'), true);
    assert.equal(ok('KX_AUTH\tprovider'), true);
    assert.equal(ok('KX_CFG\tenv\tOPENAI_API_KEY\tset'), true);
    assert.equal(ok('KX_CFG\tenv\tOPENAI_API_KEY\tempty'), false);
    assert.equal(ok(''), false);
  });

  test('探测脚本：凭据文件要非空、key 只回报「有 / 空」不回传值、开关回传值', () => {
    const s = adapterProbeScript('claude');
    assert.match(s, /\[ -s "\$HOME\/\.claude\/\.credentials\.json" \]/);
    assert.match(s, /kx_secret ANTHROPIC_API_KEY/);
    assert.match(s, /kx_flag CLAUDE_CODE_USE_BEDROCK/);
    assert.match(adapterProbeScript('codex'), /\[ -s "\$HOME\/\.codex\/auth\.json" \]/);
    assert.match(adapterProbeScript('codex'), /model_provider\[\[:space:\]\]\*=\[\[:space:\]\]\*"\[\^"\]\+"/);
  });

  test('提示文案', () => {
    const m = remoteLoginHint('ec2-user@h', 'claude');
    assert.match(m, /ec2-user@h 上的 Claude Code 还没登录/);
    assert.match(m, /Bedrock/);
    assert.match(m, /^⚠️ /);
  });

  test('探测脚本查的是这几样', () => {
    const s = adapterProbeScript('claude');
    assert.match(s, /\.claude\/\.credentials\.json/);
    assert.match(s, /CLAUDE_CODE_USE_BEDROCK/);
    assert.match(s, /ANTHROPIC_API_KEY/);
    const c = adapterProbeScript('codex');
    assert.match(c, /\.codex\/auth\.json/);
    assert.match(c, /model_provider/);
    assert.match(c, /OPENAI_API_KEY/);
  });
});

describe('启动命令接上探测结果', () => {
  test('记下的绝对路径启动方式，按机器 + 引擎取；没探测过就照旧用命令名', () => {
    const remote = { sshHost: 'ec2-user@h', sshPort: 22 } as any;
    assert.equal(remoteAdapterLaunchFor(remote, 'claude'), undefined);
    rememberRemoteAdapterLaunch(remote, 'claude', { kind: 'absolute', manager: 'fnm', node: `${FNM_ROOT}/bin/node`, entry: FNM_ENTRY });
    const v = remoteAdapterLaunchFor(remote, 'claude');
    assert.equal(v?.kind, 'absolute');
    assert.equal(remoteAdapterLaunchFor(remote, 'codex'), undefined);
    assert.equal(remoteAdapterLaunchFor({ sshHost: 'ec2-user@h', sshPort: 2222 } as any, 'claude'), undefined);
    const cmd = buildRemoteAdapterCommand('claude-agent-acp', v);
    assert.match(cmd, /^bash -lc /);
    assert.match(cmd, /KIROLEX_REMOTE_PID \$\$/, 'remoteKillTree 靠这个 PID 收尸');
    assert.ok(cmd.includes(FNM_ENTRY));
    rememberRemoteAdapterLaunch(remote, 'claude', { kind: 'path' });
    assert.equal(remoteAdapterLaunchFor(remote, 'claude')?.kind, 'path');
  });

  test('接线：检查记下结果、连接时取出来、安装后按同一条命令验证', () => {
    const M = read('src', 'main', 'index.ts');
    const AC = read('src', 'main', 'acp-client.ts');
    const at = M.indexOf('async function remoteAdapterCheck(');
    const body = M.slice(at, at + 3000);
    assert.match(body, /adapterProbeScript\(engine\)/);
    assert.match(body, /rememberRemoteAdapterLaunch\(remote, engine, verdict\)/);
    assert.match(body, /remoteLoginHint\(/);
    /* 第三个参数是会话标记（远端孤儿清扫用，见 engineAuditFixes2 的 A9）；启动方式仍取自探测结果 */
    assert.match(AC, /buildRemoteAdapterCommand\(bin, remoteAdapterLaunchFor\(this\.remote, this\.engine\)(\)|, this\.localTools\?\.agentOverride\))/);
    const b = M.slice(M.indexOf("ipcMain.handle('remote:bootstrap'"), M.indexOf("ipcMain.handle('remote:bootstrap'") + 12000);
    assert.match(b, /verifyRemoteAdapter\(/);
    assert.match(read('src', 'main', 'index.ts'), /buildSshArgs\(remote, buildRemoteAdapterCommand\(REMOTE_ADAPTER_BIN\[engine\], verdict\)\)/,
      '验证用的就是会话启动用的那条命令');
  });
});
