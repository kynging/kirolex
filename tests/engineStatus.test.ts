/**
 * 「本机 Claude Code / kiro / Codex 跑不起来时有没有提示」的缺口：
 *   · 新建会话选引擎处、设置 → 机器 → 本机：提前标出 ✅ 可用 / ⚠️ 没登录 / ❌ 没装（三种 × 三个引擎）；
 *   · 状态检测缓存 5 分钟；
 *   · 本机 kiro-cli 没装：官方安装方式（Windows / macOS / Linux），装不了给官方下载链接；
 *   · 本机没登录：开终端跑那家的登录命令。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  judgeEngineStatus, localAuthFromFiles, remoteEngineStatuses, createStatusCache, STATUS_TTL_MS,
  kiroInstallCommand, kiroInstallFailedMessage, KIRO_DOWNLOAD_URL, terminalLaunches, LOGIN_ARGS, remoteLoginHow,
} from '../src/main/engineStatus.ts';
import { adapterProbeScript } from '../src/main/remoteAdapterProbe.ts';
import { kiroCliCandidates } from '../src/main/acp-client.ts';
import { TOOLS } from '../src/main/binDetect.ts';

const ENGINES = ['kiro', 'claude', 'codex'] as const;

describe('状态判定：没装 / 没登录 / 可用 × 三个引擎', () => {
  for (const engine of ENGINES) {
    test(`${engine}：没装 → missing（没装时不谈登录）`, () => {
      assert.equal(judgeEngineStatus(engine, { installed: false }).state, 'missing');
      assert.equal(judgeEngineStatus(engine, { installed: false, loggedIn: false }).state, 'missing');
    });
    test(`${engine}：装了没登录 → not-logged-in`, () => {
      const s = judgeEngineStatus(engine, { installed: true, loggedIn: false, version: '1.2.3' });
      assert.equal(s.state, 'not-logged-in');
      assert.equal(s.version, '1.2.3');
    });
    test(`${engine}：装了也登录了 → ok；登录看不出来 → ok 但标 loginUnknown`, () => {
      const ok = judgeEngineStatus(engine, { installed: true, loggedIn: true });
      assert.equal(ok.state, 'ok');
      assert.equal(ok.loginUnknown, undefined);
      const unk = judgeEngineStatus(engine, { installed: true });
      assert.equal(unk.state, 'ok');
      assert.equal(unk.loginUnknown, true);
    });
  }
});

describe('本机登录痕迹（文件 / 环境变量）', () => {
  const home = '/h';
  const files = (m: Record<string, string>) => (p: string) => m[p.split(path.sep).join('/')] ?? null;

  test('Claude Code：凭据文件 / Bedrock / API key 任一都算；空的、开关是 0 的不算', () => {
    assert.equal(localAuthFromFiles('claude', files({}), home, {}), false);
    assert.equal(localAuthFromFiles('claude', files({ '/h/.claude/.credentials.json': '{"x":1}' }), home, {}), true);
    assert.equal(localAuthFromFiles('claude', files({ '/h/.claude/settings.json': '{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}' }), home, {}), true);
    assert.equal(localAuthFromFiles('claude', files({ '/h/.claude/settings.json': '{"env":{"CLAUDE_CODE_USE_BEDROCK":"0","ANTHROPIC_API_KEY":""}}' }), home, {}), false);
    assert.equal(localAuthFromFiles('claude', files({ '/h/.claude.json': '{"primaryApiKey":"sk-x"}' }), home, {}), true);
    assert.equal(localAuthFromFiles('claude', files({}), home, { ANTHROPIC_API_KEY: 'sk' }), true);
  });

  test('Codex：auth.json / config.toml 的 model_provider / API key', () => {
    assert.equal(localAuthFromFiles('codex', files({}), home, {}), false);
    assert.equal(localAuthFromFiles('codex', files({ '/h/.codex/auth.json': '{"tokens":{}}' }), home, {}), true);
    assert.equal(localAuthFromFiles('codex', files({ '/h/.codex/config.toml': 'model_provider = "amazon-bedrock"\n' }), home, {}), true);
    assert.equal(localAuthFromFiles('codex', files({}), home, { OPENAI_API_KEY: 'sk' }), true);
  });
});

describe('远端：「测试连接」那一次 ssh 的输出 → 三个引擎的状态', () => {
  const adapterOut = (installed: boolean, auth: boolean) => [
    installed ? 'KX_PATHBIN\t/usr/local/bin/x\t#!/usr/bin/env node' : '',
    'KX_LOGINNODE\t/usr/bin/node',
    auth ? 'KX_AUTH\tcredentials' : '',
  ].join('\n');

  test('三种状态都认得出来', () => {
    const s = remoteEngineStatuses('h', {
      code: 0,
      kiro: 'HAVE kiro-cli\nAUTH no\nKVER 2.25.0\n',
      claude: adapterOut(true, true),
      codex: adapterOut(false, false),
    });
    assert.deepEqual(s.map((x) => [x.engine, x.state]), [['kiro', 'not-logged-in'], ['claude', 'ok'], ['codex', 'missing']]);
    assert.equal(s[0].version, '2.25.0');
    const s2 = remoteEngineStatuses('h', { code: 0, kiro: 'MISS kiro-cli\n', claude: adapterOut(true, false), codex: adapterOut(true, true) });
    assert.deepEqual(s2.map((x) => x.state), ['missing', 'not-logged-in', 'ok']);
    assert.match(s2[0].detail!, /kiro-cli/);
  });

  test('连不上：三个都是 unknown，带原因，不猜', () => {
    const s = remoteEngineStatuses('h', { code: 255, kiro: '', claude: '', codex: '' }, 'Cannot connect to h');
    assert.deepEqual(s.map((x) => x.state), ['unknown', 'unknown', 'unknown']);
    assert.match(s[0].detail!, /Cannot connect/);
  });

  test('探测脚本还是那一份（fnm / nvm 管的 node 也认）', () => {
    assert.match(adapterProbeScript('codex'), /fnm/);
  });
});

describe('缓存 5 分钟', () => {
  test('5 分钟内拿缓存，过了重新问；装完 / 登录完可以清掉', () => {
    const c = createStatusCache();
    const v = [judgeEngineStatus('kiro', { installed: true, loggedIn: true })];
    c.set('local', v, 1000);
    assert.equal(c.get('local', 1000 + STATUS_TTL_MS - 1), v);
    assert.equal(c.get('local', 1000 + STATUS_TTL_MS), undefined);
    c.set('local', v, 5000);
    c.invalidate('local');
    assert.equal(c.get('local', 5001), undefined);
    assert.equal(STATUS_TTL_MS, 5 * 60_000);
  });
});

describe('本机装 kiro-cli：官方安装方式，cwd = 家目录；装不了给官方下载链接', () => {
  test('Windows：官方 PowerShell 安装器（install.ps1，MSI）', () => {
    const c = kiroInstallCommand('win32', 'C:\\Users\\u', { SystemRoot: 'C:\\Windows' });
    assert.equal(c.cwd, 'C:\\Users\\u');
    assert.match(c.command, /powershell\.exe$/i);
    assert.ok(c.args.includes('irm https://cli.kiro.dev/install.ps1 | iex'));
  });
  for (const platform of ['darwin', 'linux'] as const) {
    test(`${platform}：官方 install 脚本（curl | bash），先 cd 到家目录`, () => {
      const c = kiroInstallCommand(platform, '/home/u', {});
      assert.equal(c.cwd, '/home/u');
      assert.equal(c.command, '/bin/bash');
      assert.match(c.args[1], /^cd "\$HOME" && curl -fsSL https:\/\/cli\.kiro\.dev\/install \| bash$/);
    });
  }
  test('失败提示带官方下载链接', () => {
    assert.match(kiroInstallFailedMessage('exit 1603'), new RegExp(KIRO_DOWNLOAD_URL.replace(/[./]/g, '\\$&')));
    assert.match(kiroInstallFailedMessage('exit 1603'), /1603/);
  });
  test('官方 Windows 安装器装到 C:\\Program Files\\Kiro-Cli —— 解析和自动检测都要认这个位置', () => {
    const saved = { ...process.env };
    try {
      process.env.ProgramFiles = 'C:\\Program Files';
      assert.ok(kiroCliCandidates().includes('C:\\Program Files\\Kiro-Cli\\kiro-cli.exe'));
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    assert.ok(TOOLS.find((t) => t.id === 'kiro')!.winPaths!.includes('%ProgramFiles%\\Kiro-Cli\\kiro-cli.exe'));
  });
});

describe('本机登录：开一个终端跑登录命令', () => {
  test('登录子命令', () => {
    assert.deepEqual(LOGIN_ARGS, { kiro: ['login'], claude: ['auth', 'login'], codex: ['login'] });
  });
  test('Windows：命令写进临时 .cmd，start 一个新窗口跑它（跑完 pause 留着）；带空格的路径加引号，环境变量用 set，% 转义', () => {
    const file = 'C:\\Users\\u\\AppData\\Local\\Temp\\kirolex login\\login.cmd';
    const [l] = terminalLaunches('win32', ['C:\\Program Files\\Kiro-Cli\\kiro-cli.exe', 'login', '100%'], { ELECTRON_RUN_AS_NODE: '1' }, file);
    assert.equal(l.command, 'cmd.exe');
    assert.equal(l.verbatim, true);
    /* 直接 `cmd /k "<程序>" …` 时里面那层 cmd 会剥掉首尾引号、命令断掉（这台 Windows 上实测）—— 所以只交给它一个带引号的批处理路径 */
    assert.equal(l.args[3], `start "KiroLex login" cmd /c "${file}"`);
    assert.equal(l.script!.path, file);
    assert.equal(l.script!.content, '@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"C:\\Program Files\\Kiro-Cli\\kiro-cli.exe" login 100%%\r\necho.\r\npause\r\n');
  });
  test('macOS：Terminal.app 跑；Linux：按顺序试几个终端', () => {
    const [m] = terminalLaunches('darwin', ['/Users/u/.local/bin/kiro-cli', 'login']);
    assert.equal(m.command, 'osascript');
    assert.match(m.args[1], /do script "'\/Users\/u\/\.local\/bin\/kiro-cli' 'login'"/);
    const linux = terminalLaunches('linux', ['codex', 'login']);
    assert.ok(linux.length >= 2);
    assert.equal(linux[0].command, 'x-terminal-emulator');
  });
  test('远端没登录：给 KiroLex 里的登录方法', () => {
    assert.match(remoteLoginHow('claude', 'h'), /🔑/);
    assert.match(remoteLoginHow('kiro', 'h'), /kiro-cli login/);
  });
});
