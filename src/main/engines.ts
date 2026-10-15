/**
 * **一条会话由哪个 AI 引擎来跑** ——「看一下 kirolex 如何加 claude code 和 codex 支持……
 * 模式参考现有的 kirolex 会话模式」。
 *
 * 三家说的都是 ACP（stdio 上的 JSON-RPC）：kiro-cli 自己就是 ACP agent（`kiro-cli acp`），
 * Claude Code 和 Codex 各有一个官方适配器：
 *   · `@agentclientprotocol/claude-agent-acp`（基于 Claude Agent SDK；登录沿用 Claude Code 自己的
 *     `~/.claude/settings.json` / 凭据）
 *   · `@agentclientprotocol/codex-acp`（登录沿用 `~/.codex/auth.json`）
 * 实测这两个都走通了 KiroLex 用的那条路：initialize → session/new → session/prompt，
 * 流式 `agent_message_chunk`、标准 `usage_update`、`loadSession: true`。
 *
 * 所以"加一个引擎"在 KiroLex 里就是"换一条起进程的命令"，会话、记录、上下文重建都不变。
 * 不同的只有 kiro 专有的那几样（`--agent` / `--model` 启动参数、`_session/steer`、
 * `_kiro.dev/*` 扩展、kiro 的模型清单），对另外两家一律不用。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { tr } from './uiText.ts';

export type Engine = 'kiro' | 'claude' | 'codex';
export const ENGINES: Engine[] = ['kiro', 'claude', 'codex'];
export const ENGINE_LABEL: Record<Engine, string> = { kiro: 'Kiro', claude: 'Claude Code', codex: 'Codex' };
/** 远端机器上适配器的命令名（`npm i -g` 装出来的 bin；「安装 AI 工具」装的就是这两个包）。 */
export const REMOTE_ADAPTER_BIN: Record<Exclude<Engine, 'kiro'>, string> = { claude: 'claude-agent-acp', codex: 'codex-acp' };
export const ADAPTER_PACKAGE: Record<Exclude<Engine, 'kiro'>, string> = {
  claude: '@agentclientprotocol/claude-agent-acp', codex: '@agentclientprotocol/codex-acp',
};

/** 记录里没有 engine 的（所有老会话）就是 kiro。 */
export function engineOf(profile: { engine?: string } | undefined): Engine {
  const e = profile?.engine;
  return e === 'claude' || e === 'codex' ? e : 'kiro';
}

interface AdapterSpec { pkg: string; entry: string[]; bin: string; install: string }
const ADAPTERS: Record<Exclude<Engine, 'kiro'>, AdapterSpec> = {
  claude: {
    pkg: '@agentclientprotocol/claude-agent-acp', entry: ['dist', 'index.js'], bin: 'claude-agent-acp',
    install: 'npm i -g @agentclientprotocol/claude-agent-acp',
  },
  codex: {
    pkg: '@agentclientprotocol/codex-acp', entry: ['dist', 'index.js'], bin: 'codex-acp',
    install: 'npm i -g @agentclientprotocol/codex-acp',
  },
};

let npmRootCache: string | null | undefined;
/** `npm root -g`，问一次就记住（几百毫秒，而且答案在这个进程里不会变）。 */
function npmGlobalRoot(env: NodeJS.ProcessEnv): string | null {
  if (npmRootCache !== undefined) return npmRootCache;
  try {
    const win = process.platform === 'win32';
    const out = execFileSync(win ? (process.env.ComSpec || 'cmd.exe') : 'npm', win ? ['/d', '/s', '/c', 'npm root -g'] : ['root', '-g'], {
      encoding: 'utf8', timeout: 15_000, env, windowsHide: true,
    });
    npmRootCache = out.trim().split(/\r?\n/).pop() || null;
  } catch {
    npmRootCache = null;
  }
  return npmRootCache;
}

/** 全局 node_modules 可能在的地方。`npm root -g` 排第一，其余是它问不到时的常见位置。 */
export function globalModuleRoots(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): string[] {
  const roots = [
    npmGlobalRoot(env),
    platform === 'win32' && env.APPDATA ? path.join(env.APPDATA, 'npm', 'node_modules') : null,
    '/opt/homebrew/lib/node_modules',
    '/usr/local/lib/node_modules',
    path.join(home, '.npm-global', 'lib', 'node_modules'),
    path.join(home, '.local', 'lib', 'node_modules'),
  ];
  return roots.filter((r, i, a): r is string => !!r && a.indexOf(r) === i);
}

export interface AdapterLaunch {
  command: string;
  args: string[];
  /** 叠到子进程环境上的变量。 */
  env: Record<string, string>;
}

/**
 * 起这个引擎的适配器用哪条命令。
 *
 * 找到适配器包的 JS 入口时，用**本进程自己的 node** 跑它（Electron 里是 `ELECTRON_RUN_AS_NODE=1`
 * 的 electron.exe）：不经过 npm 的 `.cmd` shim —— 新版 Node 在 Windows 上直接 spawn `.cmd`
 * 会抛 `spawn EINVAL`（CVE-2024-27980 的修复），而那正是 npm 在 Windows 上装出来的东西。
 * 也不要求用户机器上另有一份 node 在 PATH 里。
 *
 * 找不到就抛一句**能照着做**的话（装哪个包），不猜一个名字去起。
 */
export function resolveAdapter(
  engine: Exclude<Engine, 'kiro'>,
  env: NodeJS.ProcessEnv = process.env,
  opts: { roots?: string[]; exists?: (p: string) => boolean; execPath?: string; platform?: NodeJS.Platform } = {},
): AdapterLaunch {
  const spec = ADAPTERS[engine];
  const exists = opts.exists || ((p: string) => { try { return fs.existsSync(p); } catch { return false; } });
  const override = env[`KIROLEX_${engine.toUpperCase()}_ACP`];
  if (override) {
    return /\.(c|m)?js$/i.test(override)
      ? { command: opts.execPath || process.execPath, args: [override], env: { ELECTRON_RUN_AS_NODE: '1' } }
      : { command: override, args: [], env: {} };
  }
  for (const root of opts.roots || globalModuleRoots(env)) {
    const entry = path.join(root, ...spec.pkg.split('/'), ...spec.entry);
    if (exists(entry)) {
      return { command: opts.execPath || process.execPath, args: [entry], env: { ELECTRON_RUN_AS_NODE: '1' } };
    }
  }
  /* 非 Windows 上 PATH 里的可执行文件可以直接起（那边 npm 装的是带 shebang 的脚本） */
  if ((opts.platform || process.platform) !== 'win32') return { command: spec.bin, args: [], env: {} };
  npmRootCache = undefined;   // 下次再问（多半是还没装，装完就能找到）
  throw new Error(tr('Could not find the ACP adapter for {engine}. Install it: `{install}` (no need to restart KiroLex afterwards, it is looked up again when you create a session).', { engine: ENGINE_LABEL[engine], install: spec.install }));
}

/** 找不到适配器时缓存的 `npm root -g` 也该重新问一次（刚装完的情况）。 */
export function forgetAdapterCache(): void { npmRootCache = undefined; }
