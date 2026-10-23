/**
 * **三个引擎在一台机器上能不能用** —— 新建会话选引擎时、设置 → 机器 → 本机那页提前标出来：
 * ✅ 可用 / ⚠️ 没登录 / ❌ 没装（适配器或 CLI）。原来都是事后才知道：建了会话、发了消息、失败了。
 *
 * 也放着本机两件"补缺口"的事的纯逻辑：
 *   · 本机装 kiro-cli（官方安装方式，和远端「安装 AI 工具」里装 kiro-cli 同一个思路：官方包 + 官方安装器）；
 *   · 本机登录：开一个终端跑那家的登录命令（远端 🔑 登录是在 KiroLex 里跑登录流程，本机直接给一个真终端，
 *     各家登录时要问的那几句由人自己答）。
 *
 * 纯模块（不 import electron）：取事实（跑 `--version` / `whoami`、读文件、ssh）在 index.ts，这里只判定。
 */
import path from 'path';
import { ENGINE_LABEL, type Engine } from './engines.ts';
import { judgeAdapterProbe, parseAdapterProbe, remoteAuthConfigured } from './remoteAdapterProbe.ts';
import { tr } from './uiText.ts';

export type EngineState = 'ok' | 'not-logged-in' | 'missing' | 'unknown';

export interface EngineStatus {
  engine: Engine;
  state: EngineState;
  /** 那个工具自己报的版本（拿得到才有）。 */
  version?: string;
  /** 一句说明（为什么是这个状态 / 去哪修）。 */
  detail?: string;
  /** 登录状态是猜不出来的（例如 macOS 上 Claude Code 的凭据在钥匙串里）：照「可用」显示，但说一声。 */
  loginUnknown?: boolean;
}

export interface EngineFacts {
  /** 能起（CLI 跑得起来 / 适配器找得到）。 */
  installed: boolean;
  version?: string;
  /** true = 登录过（或配了 Bedrock / API key）；false = 没有；undefined = 看不出来。 */
  loggedIn?: boolean;
  detail?: string;
}

/** 事实 → 状态。顺序：没装 → 没登录 → 可用（没装的时候谈登录没意义）。 */
export function judgeEngineStatus(engine: Engine, f: EngineFacts): EngineStatus {
  const base = { engine, ...(f.version ? { version: f.version } : {}), ...(f.detail ? { detail: f.detail } : {}) };
  if (!f.installed) return { ...base, state: 'missing' };
  if (f.loggedIn === false) return { ...base, state: 'not-logged-in' };
  return { ...base, state: 'ok', ...(f.loggedIn === undefined ? { loginUnknown: true } : {}) };
}

const truthy = (v: unknown): boolean => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const nonEmpty = (v: unknown): boolean => typeof v === 'string' ? v.trim().length > 0 : v != null && v !== false;

function parseJson(text: string | null): any {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * 本机 Claude Code / Codex 登录 / 配置过没有 —— 只看文件和环境变量（和远端探测 `adapterProbeScript` 认的同一批痕迹）。
 * true = 有痕迹；false = 一样都没有。看不出来（macOS 上凭据在钥匙串里）由调用方再问那个 CLI。
 */
export function localAuthFromFiles(
  engine: 'claude' | 'codex',
  read: (p: string) => string | null,
  home: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (engine === 'claude') {
    if (nonEmpty(read(path.join(home, '.claude', '.credentials.json')))) return true;
    const settings = parseJson(read(path.join(home, '.claude', 'settings.json')));
    const sEnv = { ...(settings?.env || {}) };
    if (truthy(sEnv.CLAUDE_CODE_USE_BEDROCK) || truthy(sEnv.CLAUDE_CODE_USE_VERTEX)) return true;
    if (nonEmpty(sEnv.ANTHROPIC_API_KEY) || nonEmpty(sEnv.ANTHROPIC_AUTH_TOKEN) || nonEmpty(settings?.apiKeyHelper)) return true;
    if (nonEmpty(parseJson(read(path.join(home, '.claude.json')))?.primaryApiKey)) return true;
    if (truthy(env.CLAUDE_CODE_USE_BEDROCK) || truthy(env.CLAUDE_CODE_USE_VERTEX)) return true;
    return nonEmpty(env.ANTHROPIC_API_KEY) || nonEmpty(env.ANTHROPIC_AUTH_TOKEN);
  }
  if (nonEmpty(read(path.join(home, '.codex', 'auth.json')))) return true;
  if (/^\s*model_provider\s*=\s*"[^"]+"/m.test(read(path.join(home, '.codex', 'config.toml')) || '')) return true;
  return nonEmpty(env.OPENAI_API_KEY) || nonEmpty(env.CODEX_API_KEY);
}

/**
 * 远端：「测试连接」那一次 ssh 的输出（kiro 预检 + 两家适配器探测，`testConnectionScript`）→ 三个引擎的状态。
 * 连不上 = 三个都是 unknown（带原因），不猜。
 */
export function remoteEngineStatuses(
  host: string,
  run: { code: number | null; kiro: string; claude: string; codex: string },
  unreachable?: string,
): EngineStatus[] {
  if (unreachable) return (['kiro', 'claude', 'codex'] as Engine[]).map((engine) => ({ engine, state: 'unknown', detail: unreachable }));
  const kiroOut = String(run.kiro || '');
  const kver = /^KVER (\d+\.\d+\.\d+)/m.exec(kiroOut)?.[1];
  const kiro = judgeEngineStatus('kiro', {
    installed: /^HAVE kiro-cli\b/m.test(kiroOut),
    loggedIn: /AUTH no/.test(kiroOut) ? false : /AUTH ok/.test(kiroOut) ? true : undefined,
    version: kver,
    detail: /^HAVE kiro-cli\b/m.test(kiroOut) ? undefined : tr('kiro-cli is not installed on {host}.', { host }),
  });
  const adapter = (engine: 'claude' | 'codex', out: string): EngineStatus => {
    const p = parseAdapterProbe(out);
    const v = judgeAdapterProbe(p);
    const installed = v.kind === 'path' || v.kind === 'absolute';
    return judgeEngineStatus(engine, {
      installed,
      loggedIn: installed ? remoteAuthConfigured(engine, p) : undefined,
      detail: v.kind === 'no-node'
        ? tr('The {engine} adapter is installed on {host}, but there is no node to run it.', { engine: ENGINE_LABEL[engine], host })
        : installed ? undefined : tr('The {engine} ACP adapter is not installed on {host}.', { engine: ENGINE_LABEL[engine], host }),
    });
  };
  return [kiro, adapter('claude', run.claude), adapter('codex', run.codex)];
}

/* ─────────── 缓存：同一台机器 5 分钟内不再问（打开新建会话框不该每次都卡一下） ─────────── */

export const STATUS_TTL_MS = 5 * 60_000;

export function createStatusCache(ttlMs = STATUS_TTL_MS) {
  const entries = new Map<string, { at: number; value: EngineStatus[] }>();
  return {
    get(machine: string, now = Date.now()): EngineStatus[] | undefined {
      const e = entries.get(machine);
      return e && now - e.at < ttlMs ? e.value : undefined;
    },
    set(machine: string, value: EngineStatus[], now = Date.now()): void { entries.set(machine, { at: now, value }); },
    /** 装完 / 登录完 / 改了启动命令：那台机器下次重新问。不给机器 = 全清。 */
    invalidate(machine?: string): void { if (machine === undefined) entries.clear(); else entries.delete(machine); },
  };
}

/* ─────────── 本机装 kiro-cli ─────────── */

/** 官方安装说明页（装不上时给人自己去下）。 */
export const KIRO_DOWNLOAD_URL = 'https://kiro.dev/docs/cli/installation/';

/**
 * 本机装 kiro-cli 的官方命令。cwd 用家目录（和装适配器一样，绝不在 KiroLex 自己的目录里跑安装）。
 *   · Windows：`irm https://cli.kiro.dev/install.ps1 | iex`（官方 MSI，装到 `C:\Program Files\Kiro-Cli\`）；
 *   · macOS / Linux：`curl -fsSL https://cli.kiro.dev/install | bash`（官方脚本：自己挑架构和 glibc / musl 的包、
 *     校验 checksum，CLI 放进 `~/.local/bin` —— 和远端「安装 AI 工具」装 kiro-cli 是同一套包）。
 */
export function kiroInstallCommand(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): { command: string; args: string[]; cwd: string; display: string } {
  if (platform === 'win32') {
    const ps = env.SystemRoot ? `${env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
    const script = 'irm https://cli.kiro.dev/install.ps1 | iex';
    return { command: ps, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], cwd: home, display: script };
  }
  const script = 'curl -fsSL https://cli.kiro.dev/install | bash';
  return { command: '/bin/bash', args: ['-lc', `cd "$HOME" && ${script}`], cwd: home, display: script };
}

export function kiroInstallFailedMessage(why: string): string {
  return tr('❌ Installing kiro-cli on this machine failed: {why}\nYou can download and install it yourself from the official page: {url} — then click Install again (KiroLex will find it).', { why, url: KIRO_DOWNLOAD_URL });
}

/* ─────────── 本机登录：开一个终端跑登录命令 ─────────── */

/** 各家的登录子命令（跟在那个 CLI 的路径后面）。 */
export const LOGIN_ARGS: Record<Engine, string[]> = { kiro: ['login'], claude: ['auth', 'login'], codex: ['login'] };

function winQuote(s: string): string { return /[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function shQuote(s: string): string { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/**
 * 在一个**新的终端窗口**里跑 `argv`（登录要问的那几句人自己答；跑完窗口留着，看得到结果）。
 * `env` 是要叠加的变量（例如用 Electron 自带的 node 跑 Claude Code 的 cli.js 时的 `ELECTRON_RUN_AS_NODE=1`）。
 * Linux 返回几个候选终端，调用方按顺序试。
 */
export function terminalLaunches(
  platform: NodeJS.Platform,
  argv: string[],
  env: Record<string, string> = {},
  /** Windows：批处理文件放哪（调用方写进去再起）。 */
  winScriptPath = 'kirolex-login.cmd',
): Array<{ command: string; args: string[]; verbatim?: boolean; script?: { path: string; content: string } }> {
  if (platform === 'win32') {
    /*
      **命令写进一个临时 .cmd 再让新窗口跑它** —— 在这台 Windows 上实测：直接 `start … cmd /k "<程序>" <参数>` 时，
      里面那层 cmd 按它的引号规则剥掉首尾两个引号，带引号的程序路径就断了，窗口开了、命令没跑；`&&` 还会被外层 cmd 吃掉。
      批处理里一行一条，引号原样；`%` 写成 `%%`。最后 `pause`：跑完窗口留着，看得到结果（`/k` 在这里实测不跑批处理）。
    */
    const esc = (s: string) => s.replace(/%/g, '%%');
    const lines = [
      '@echo off',
      ...Object.entries(env).map(([k, v]) => `set "${esc(k)}=${esc(v)}"`),
      esc(argv.map(winQuote).join(' ')),
      'echo.',
      'pause',
    ];
    return [{
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `start "KiroLex login" cmd /c "${winScriptPath}"`],
      verbatim: true,
      script: { path: winScriptPath, content: `${lines.join('\r\n')}\r\n` },
    }];
  }
  const line = `${Object.entries(env).map(([k, v]) => `${k}=${shQuote(v)} `).join('')}${argv.map(shQuote).join(' ')}`;
  if (platform === 'darwin') {
    const apple = `"${line.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return [{ command: 'osascript', args: ['-e', `tell application "Terminal" to do script ${apple}`, '-e', 'tell application "Terminal" to activate'] }];
  }
  const keep = `${line}; echo; echo "(you can close this window)"; exec bash`;
  return [
    { command: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', keep] },
    { command: 'gnome-terminal', args: ['--', 'bash', '-lc', keep] },
    { command: 'konsole', args: ['-e', 'bash', '-lc', keep] },
    { command: 'xterm', args: ['-e', 'bash', '-lc', keep] },
  ];
}

/** 远端那台机器没登录时给的登录方法（在 KiroLex 里怎么登）。 */
export function remoteLoginHow(engine: Engine, host: string): string {
  return engine === 'kiro'
    ? tr('kiro-cli on {host} is not logged in: Settings → 🖥 Machines → that machine → "Install AI tools" walks you through logging in (device flow), or run `kiro-cli login` on that machine.', { host })
    : tr('{engine} on {host} is not logged in: create the chat, then use 🔑 Login at the bottom left of the chat (official login, Bedrock or an API key).', { engine: ENGINE_LABEL[engine], host });
}
