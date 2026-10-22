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
    ...managerModuleRoots(env, home),
  ];
  return roots.filter((r, i, a): r is string => !!r && a.indexOf(r) === i);
}

/** 目录名里的版本号（`v22.23.3`）；认不出的排最后。 */
function versionKey(p: string): number[] {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(path.basename(p));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
}

/**
 * **fnm / nvm / Volta / asdf 各自的全局 node_modules** —— 和远端探测（`remoteAdapterProbe.ts` 的 `adapterProbeScript`）
 * 同一套目录布局。这几家只在交互 shell 里加 PATH，GUI 起的 KiroLex 里 `npm root -g` 要么问不到、要么问到另一份 node，
 * 于是在会话里点「安装」装进那个管理器 node 下的适配器会被判成"还是没装"。
 * 找到的入口照样用本进程自己的 node 跑（`resolveAdapter`），不需要那个管理器的 node 在 PATH 里。新版本排前面。
 */
export function managerModuleRoots(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  listDir: (dir: string) => string[] = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } },
): string[] {
  const versions = (dir: string, tail: string[]): string[] => listDir(dir)
    .map((v) => path.join(dir, v))
    .sort((a, b) => {
      const va = versionKey(a), vb = versionKey(b);
      for (let i = 0; i < 3; i += 1) if (va[i] !== vb[i]) return vb[i] - va[i];
      return 0;
    })
    .map((d) => path.join(d, ...tail));
  const fnmDirs = [env.FNM_DIR, path.join(home, '.local', 'share', 'fnm'), path.join(home, '.fnm'), path.join(home, 'Library', 'Application Support', 'fnm')]
    .filter((d, i, a): d is string => !!d && a.indexOf(d) === i);
  const volta = env.VOLTA_HOME || path.join(home, '.volta');
  return [
    ...fnmDirs.flatMap((d) => versions(path.join(d, 'node-versions'), ['installation', 'lib', 'node_modules'])),
    ...versions(path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node'), ['lib', 'node_modules']),
    /* Volta 把每个全局包装在自己的目录里 */
    ...Object.values(ADAPTER_PACKAGE).map((pkg) => path.join(volta, 'tools', 'image', 'packages', ...pkg.split('/'), 'lib', 'node_modules')),
    ...versions(path.join(env.ASDF_DATA_DIR || path.join(home, '.asdf'), 'installs', 'nodejs'), ['lib', 'node_modules']),
  ];
}

/** 适配器包的 JS 入口在哪（各个全局 node_modules 里找），找不到 = null。「安装」装完用它确认真的找得到。 */
export function findAdapterEntry(
  engine: Exclude<Engine, 'kiro'>,
  env: NodeJS.ProcessEnv = process.env,
  opts: { roots?: string[]; exists?: (p: string) => boolean } = {},
): string | null {
  const spec = ADAPTERS[engine];
  const exists = opts.exists || ((p: string) => { try { return fs.existsSync(p); } catch { return false; } });
  for (const root of opts.roots || globalModuleRoots(env)) {
    const entry = path.join(root, ...spec.pkg.split('/'), ...spec.entry);
    if (exists(entry)) return entry;
  }
  return null;
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
  const entry = findAdapterEntry(engine, env, { roots: opts.roots, exists });
  if (entry) return { command: opts.execPath || process.execPath, args: [entry], env: { ELECTRON_RUN_AS_NODE: '1' } };
  /* 非 Windows 上 PATH 里的可执行文件可以直接起（那边 npm 装的是带 shebang 的脚本） */
  if ((opts.platform || process.platform) !== 'win32') return { command: spec.bin, args: [], env: {} };
  npmRootCache = undefined;   // 下次再问（多半是还没装，装完就能找到）
  throw new Error(adapterMissingMessage(engine));
}

/** 适配器没装时说的那句（Windows 上找不到入口、别处 spawn 裸名字 ENOENT，说的是同一件事）。 */
export function adapterMissingMessage(engine: Exclude<Engine, 'kiro'>): string {
  return tr('Could not find the ACP adapter for {engine}. Install it: `{install}` (no need to restart KiroLex afterwards, it is looked up again when you create a session).', { engine: ENGINE_LABEL[engine], install: ADAPTERS[engine].install });
}

/** 那个 CLI 自己的登录命令（适配器沿用它的登录）。 */
const LOGIN_COMMAND: Record<Exclude<Engine, 'kiro'>, string> = { claude: 'claude auth login', codex: 'codex login' };

/**
 * ACP 的 `auth_required`（-32000）—— 适配器起来了、但那个 CLI 没登录。
 * 不认出来的话界面上只有一句英文 `Authentication required`，和"没装"、"崩了"分不清，也不知道去哪登。
 */
export function isAuthRequiredError(err: { code?: unknown; message?: unknown } | null | undefined): boolean {
  return err?.code === -32000 || /authentication required|auth_required/i.test(String(err?.message ?? ''));
}

export function adapterAuthMessage(engine: Exclude<Engine, 'kiro'>): string {
  return tr('{engine} is not logged in on the machine running this session. Run `{login}` in a terminal on that machine (remote sessions: 🔑 Login in the session panel), then try again.', { engine: ENGINE_LABEL[engine], login: LOGIN_COMMAND[engine] });
}

/**
 * 后端自己会不会把 ACP 会话存盘、换个进程 `session/load` 能不能接回同一段对话。
 * kiro-cli 不会（index.ts `loadSessionImpl` 那段实测：load 一个旧 id 得到的是空对话）；
 * 两个适配器会（Claude Code 写 `~/.claude/projects/…`，Codex 写它的 rollout 文件）。
 */
export function backendPersistsSessions(engine: Engine): boolean {
  return engine !== 'kiro';
}

/**
 * 记录里「上下文已经在后端里」那个标记（`contextEstablishedFor` / `contextEstablishedPid`）对现在这个后端还算不算数。
 * kiro：同一个后端会话 id **且**同一个进程；适配器：同一个后端会话 id 就够（新进程 load 回来的就是那段对话）。
 */
export function contextMarkerHolds(
  engine: Engine,
  marker: { for?: string; pid?: number },
  backend: { cliSessionId: string; pid?: number },
): boolean {
  if (marker.for === undefined || marker.for !== backend.cliSessionId) return false;
  return backendPersistsSessions(engine) || marker.pid === backend.pid;
}

/** 找不到适配器时缓存的 `npm root -g` 也该重新问一次（刚装完的情况）。 */
export function forgetAdapterCache(): void { npmRootCache = undefined; }

/**
 * 这一轮开始时，后端是不是已经握着这条会话的全部历史 —— 是的话这一轮成功结束就该记「上下文已建立」。
 * 只对会存盘的后端（适配器）：之前的标记仍然算数，或者盘上还一条消息都没有（第一轮，后端会话就是为它新建的）。
 * kiro 永远 false：它的标记只由随行快照 / 重建历史来记，规则不变。
 */
export function backendHeldAtTurnStart(engine: Engine, markerHolds: boolean, transcriptEmpty: boolean): boolean {
  return backendPersistsSessions(engine) && (markerHolds || transcriptEmpty);
}

/**
 * **KiroLex 自己的辅助小任务**（自动标题、追问建议、会话记忆整理）是用 kiro-cli 一次性跑的（index.ts `runLiteOneShot`）。
 * Claude Code / Codex 会话不跑：只装了这两家的机器上 kiro-cli 根本起不来（原来静默失败、记忆整理每轮重试一次），
 * 装了 kiro 的机器上则是把这条会话的内容交给另一家模型、记在 Kiro 的额度上。返回要对用户说的那句（只说一次）；kiro / 不知道是哪条会话 → null（原样跑）。
 */
export function liteHelperSkipReason(engine: Engine | undefined): string | null {
  if (!engine || engine === 'kiro') return null;
  return tr('Auto title, follow-up suggestions and session-memory tidying run on Kiro, so they are off for this {engine} session (its content is not sent to another AI). The title is taken from your first message; session memory can still be edited by hand.', { engine: ENGINE_LABEL[engine] });
}
