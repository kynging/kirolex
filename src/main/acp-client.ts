import { spawn, execFile, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PermissionMode, RemoteTarget } from './config';
import { ToolCallLedger } from './remoteWriteGuard.ts';
import { proxyArgs, assertSafeSshHost } from './sshProxy.ts';
import { batchModeFor, hasPassword, sshEnv } from './sshAuth.ts';
import { ENGINE_LABEL, REMOTE_ADAPTER_BIN, adapterAuthMessage, adapterMissingMessage, isAuthRequiredError, resolveAdapter, type Engine } from './engines.ts';
import { adapterExecLine, remoteAdapterLaunchFor, type AdapterVerdict } from './remoteAdapterProbe.ts';
import { ADAPTER_TAG_ENV } from './remoteLocalTools.ts';
import { isSshTransportExit, sshDropMessage } from './transientError.ts';
import { tr } from './uiText.ts';
import { forceKillExecutorTree, listWindowsProcesses, snapshotExecutorTree, sweepExecutorChildren, taskkillOne, taskkillTree, type TreeDeps } from './procTree.ts';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: any;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: any;
}

type JsonRpcId = number | string;
type PermissionOption = { optionId: string; name?: string; kind?: string };

// Mid-turn steer lifecycle discriminants carried on the `update.sessionUpdate`
// field of a `session/update` (kiro-cli v2.9) or `_kiro.dev/session/update`
// (v2.7) notification. Both the OLD (AgentExecution*) and NEW (steering_*)
// event names are recognized so a steer works across kiro-cli versions.
const STEER_DISCRIMINANTS = new Set([
  'steering_queued',
  'steering_consumed',
  'steering_cleared',
  'AgentExecutionUserMessageQueued',
  'AgentExecutionSteeringInjected',
]);

/** Wall/idle budget for the ACP `initialize` handshake. Deliberately much
 *  shorter than the generic request timeout: a healthy kiro-cli answers in a
 *  second or two, whereas a RETIRED model never answers at all — so this is the
 *  gate that decides how fast the model-fallback chain can move on. Kept
 *  generous enough to survive a cold start with several executors booting at
 *  once (MCP server loading). */
const INITIALIZE_TIMEOUT_MS = 45000;

/**
 * kiro-cli 的 trace 日志开关（默认关）——「必须修好」那条路上唯一能拿到 HTTP 层证据的东西。
 * 见下面 spawn 处那段注释。文件方式存在的理由：不用从终端带环境变量启动 app。
 */
export function kiroTraceEnabled(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): boolean {
  if (/^(1|true|on|yes)$/i.test(String(env.KIROLEX_KIRO_TRACE || ''))) return true;
  try { return fs.existsSync(path.join(home, '.kirolex', 'kiro-trace')); } catch { return false; }
}

/** Where kiro-cli might live, most specific first. */
/**
 * **配置里指定的那个 kiro-cli** ——「不管是本地还是远程必须要配置 kiro、claude、codex 的启动命令」。
 *
 * 一个模块级的值而不是往五个调用点各传一遍参数：`resolveKiroCli()` 被执行器、模型列表、
 * agent 列表、usage 面板共用，而"跑的到底是哪一个 kiro-cli"在这几处**必须一致** ——
 * 不一致的表现是"聊天能用，但模型列表少了几个"，那种问题查半天看不出根因。
 * 主进程在启动和改配置时设置它（`localBins`）。
 */
let configuredKiroBin: string | undefined;

export function setLocalKiroBin(bin?: string): void {
  configuredKiroBin = (bin || '').trim() || undefined;
}

/**
 * **远端那台机器的启动命令按 sshHost 现查** ——「所有的会话必须用 setting 里面设置的
 * 本地或远程 agent 起任务」。
 *
 * 为什么不能用会话记录里那一份：记录里存的是**建会话那一刻**的目标快照
 * （`rec.profile.remote = {...target}`），所以后来在设置里配的 `bins` 永远到不了已有的会话 ——
 * 实测就是这样：配置里 tokyo 明明有 `bins.kiro`，而那几条老会话全部报"还没有设置…"。
 *
 * 和 `labelForHost` 是同一条教训：**会变的东西不要存进会话，按 host 反查**。
 * 主进程在启动时注入这个查询（它才有配置文件的访问权）。
 */
let remoteBinResolver: ((sshHost: string) => string | undefined) | undefined;

export function setRemoteBinResolver(fn?: (sshHost: string) => string | undefined): void {
  remoteBinResolver = fn;
}

/** 这台远端机器该用哪条命令：先看配置（现查），再退回记录里那份快照。 */
export function remoteKiroBin(remote: RemoteTarget): string | undefined {
  const live = remote.sshHost ? remoteBinResolver?.(remote.sshHost) : undefined;
  return (live || '').trim() || (remote.bins?.kiro || '').trim() || undefined;
}

/**
 * **没配就不起** ——「所有的会话必须用 setting 里面设置的本地或远程 agent 起任务，
 * 如果设置是空的不应该起任何连接」。
 *
 * 为什么这是对的：猜出来的那个二进制**可能不是你要用的那个**（这台机器上就有两个
 * ——`kiro-cli 2.23.1` 和 Kiro IDE 的 `kiro 0.12.333`），而猜错的表现不是报错，是
 * "模型列表少几个"、"agent 没生效"这类查半天看不出根因的事。设置是唯一的真相，
 * 空的时候宁可明确拒绝，也不要悄悄换一个。
 *
 * 返回一句话 = 不能起；`null` = 可以。
 */
export function kiroBinProblem(): string | null {
  if (configuredKiroBin) return null;
  return tr('No kiro launch command is set for **this machine** yet. Open Settings → 🖥 Machines → 💻 This machine and click "Auto-detect the three tools on this machine", or enter a path by hand. Without this setting KiroLex won\'t guess a binary.');
}

export function kiroCliCandidates(): string[] {
  /* 配了就**只用**它：不再往下试那串猜测路径（见 `kiroBinProblem`） */
  if (configuredKiroBin) return [configuredKiroBin];
  /* 变量没设时**不生成**这一项：否则模板字符串会拼出 `undefined\Kiro-Cli\…` 这种假路径，
     `.filter(Boolean)` 去不掉。HOME 在 Windows 上（资源管理器启动）常常没有，退回 os.homedir()。 */
  const local = process.env.LOCALAPPDATA;
  const roaming = process.env.APPDATA;
  const home = process.env.HOME || os.homedir();
  return [
    process.env.KIRO_CLI_PATH,
    // Windows
    local && `${local}\\Kiro-Cli\\kiro-cli.exe`,
    local && `${local}\\Programs\\kiro-cli\\kiro-cli.exe`,
    roaming && `${roaming}\\kiro-cli\\kiro-cli.exe`,
    // macOS/Linux
    home && `${home}/.local/bin/kiro-cli`,
    '/usr/local/bin/kiro-cli',
    '/opt/homebrew/bin/kiro-cli',
  ].filter(Boolean) as string[];
}

/** The kiro-cli executable, or `null` if none of the known locations exist.
 *
 *  Exported because the ACP executor and the plain CLI helpers used to disagree:
 *  the executor SEARCHED these paths (so a chat worked), while `--list-models`,
 *  `--list-sessions`, `agent list` and `/usage` shelled out to the bare name
 *  `kiro-cli` and relied on PATH. On macOS that mostly held because PATH is
 *  augmented with ~/.local/bin and the Homebrew dirs, but it breaks whenever the
 *  binary is only reachable via KIRO_CLI_PATH -- and on WINDOWS it breaks by
 *  default, since PATH is left untouched there and the installer drops
 *  kiro-cli.exe under %LOCALAPPDATA%. Result: chats work, but the model list,
 *  agent list and usage panel all fail. One resolver for both paths. */
export function resolveKiroCli(): string | null {
  for (const p of kiroCliCandidates()) {
    /* **裸命令名直接用**：配置里可以填 `kiro-cli-dev` 这种 PATH 上的名字，
       而 `existsSync('kiro-cli-dev')` 当然是 false —— 按文件判断会把它悄悄丢掉。 */
    if (!p.includes('/') && !p.includes('\\')) return p;
    try { if (fs.existsSync(p)) return p; } catch { /* unreadable candidate */ }
  }
  return null;
}

/** Claude Code / Codex 在 configOptions 里给的那几类下拉（ACP 的 category）。 */
export type EngineOptionCategory = 'model' | 'thought_level' | 'mode';
export interface EngineSelect { current: string; options: Array<{ value: string; name: string }> }

export class AcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  /** 起 `process` 的那一刻（毫秒）。删除时用它核对「这个 pid 还是不是我们起的那个进程」（Windows 会复用 pid）。 */
  private spawnedAt?: number;
  private nextId = 0;
  private pendingRequests: Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout>; idleMs: number }> = new Map();
  private model: string;
  private kiroAgent?: string;
  private permissionMode: PermissionMode;
  private pendingPermissions = new Map<JsonRpcId, PermissionOption[]>();
  private buffer = '';
  private env: Record<string, string>;
  private remote?: RemoteTarget;
  private localTools?: { remotePort: number; localPort: number; agentOverride: string; mcpServers?: any[] };
  /** 最近一点 stderr —— ssh 退出码 255 的**原因**在里面（见 stderr 处理那一段）。 */
  private lastStderr = '';
  /**
   * **会话接线之前**的 stderr —— MCP server 起不来正好发生在这一段。
   *
   * `wireSession` 要等 connect / newSession / loadSession 跑完才挂监听，这之间的 `error` 事件
   * 只落到构造函数里那个空监听上，于是启动期的 MCP 初始化失败从来到不了界面。先攒着，
   * 接线时由 `takeEarlyStderr()` 一次性取走；取走之后不再攒（之后的走正常监听）。
   */
  private earlyStderr: string[] | null = [];
  /** 远端那个 kiro-cli 的 PID（它自己报的）—— 断开时要把它杀掉，见 `KIROLEX_PID`。 */
  remotePid?: number;
  /**
   * **这次真的用哪条命令起来的** ——「记住历史成功的启动命令或位置」。
   *
   * 本机是 `resolveKiroCli()` 挑中的那个路径，远端是那台机器配的（或 `kiro-cli`）。
   * 主进程在连接成功后把它记进历史 —— 一个真的起过会话的命令比任何检测结果都可信。
   */
  launchedWith?: string;
  /** 哪个引擎（kiro / claude / codex）。见 `engines.ts`：只有起进程那一步和 kiro 专有的扩展不同。 */
  readonly engine: Engine;
  /**
   * 远程会话的写文件闸（`remoteWriteGuard.remoteWriteVerdict`，index.ts 的 `wireSession` 接上）。
   * 给它权限请求里那个 toolCall，回 `block: true` 就直接拒，不自动批准、也不转给人。
   */
  remoteWriteGuard?: (toolCall: any) => { block: boolean; paths: string[] } | null | undefined;
  /** 通知里每个工具调用的 kind / rawInput（权限请求里没有，按 toolCallId 合并 —— 见 `ToolCallLedger`）。 */
  private toolLedger = new ToolCallLedger();

  constructor(
    model: string,
    env?: Record<string, string>,
    kiroAgent?: string,
    permissionMode: PermissionMode = 'auto-approve',
    remote?: RemoteTarget,
    /**
     * **本地工具通道**（`localMcp.ts`）——「给远程配一些能调用本地 MCP 的能力」。
     *
     * `remoteForward`：`ssh -R <远端端口>:127.0.0.1:<本地端口>`，让远端的 kiro-cli 能敲到
     * 跑在你 Mac 上的那个 MCP server。
     * `agentOverride`：那条会话专用的 agent 名字 —— MCP 的 URL 里带着会话 token，所以配置**必须**
     * 一条会话一份（共用一份的话服务端分不出是谁在调，也就不知道 cwd 是哪个目录）。
     * 它只影响这次启动，不写进记录（记录里仍然是你选的那个 agent）。
     */
    localTools?: {
      remotePort: number; localPort: number; agentOverride: string;
      /** 非 kiro 引擎：本地工具通道直接作为 ACP 的 `mcpServers` 交给 session/new / load（kiro 走 agent JSON）。 */
      mcpServers?: any[];
    },
    engine: Engine = 'kiro',
  ) {
    super();
    this.engine = engine;
    this.model = model;
    this.kiroAgent = kiroAgent;
    this.localTools = localTools;
    /*
      **Claude Code / Codex：问不问由它们自己的 mode 决定**（上面那颗按钮在这两家是 mode 下拉）。
      KiroLex 这一层要是还"自动批准"，选了 Manual 也照样一路放行 —— 所以这里永远原样转给人看。
      bypass / full access 这类 mode 下它们根本不会来问。
    */
    this.permissionMode = engine === 'kiro' ? permissionMode : 'ask';
    this.env = env || (process.env as Record<string, string>);
    this.remote = remote;
    // A client can receive stderr (e.g. SSH warnings) BEFORE the owner attaches
    // its listeners (wireSession runs after connect/loadSession). An unlistened
    // 'error' emit makes Node throw ERR_UNHANDLED_ERROR, which crashed the main
    // process and surfaced as "Internal error" on IPCs like acp:switch-model.
    // This no-op keeps 'error' always listened; real handling is additive.
    this.on('error', () => {});
  }

  /** 接线前的 stderr 攒起来（只留最近 50 段，防止一直没人接线时无限长） */
  private noteEarlyStderr(msg: string): void {
    if (!this.earlyStderr) return;
    this.earlyStderr.push(msg);
    if (this.earlyStderr.length > 50) this.earlyStderr.shift();
  }

  /**
   * 取走接线前攒下的 stderr，并停止再攒 —— 由 `wireSession` 挂好监听之后调用一次。
   * 第二次调用返回空：同一段不会被报两遍。
   */
  takeEarlyStderr(): string[] {
    const out = this.earlyStderr || [];
    this.earlyStderr = null;
    return out;
  }

  async connect(): Promise<any> {
    return new Promise((resolve, reject) => {
      let command: string;
      let args: string[];
      /** 适配器要叠的环境（`ELECTRON_RUN_AS_NODE`）。kiro 那条路是空的。 */
      let extraEnv: Record<string, string> = {};

      if (this.engine !== 'kiro') {
        /*
          **Claude Code / Codex**：起它们的 ACP 适配器（`engines.ts`）。没有 `--agent` / `--model`
          这些 kiro 的启动参数 —— 模型用那个 CLI 自己配的默认值，登录也沿用它自己的。
          远程先不做：远端那条路（ssh + 反向隧道 + 每会话 agent 配置）全是按 kiro 写的。
        */
        if (this.remote?.sshHost) {
          /*
            **远端照样起适配器** ——「为什么 remote 不行？只要 remote 也安装 ACP 不就行了吗」。
            ssh 透明地传 stdio，和 kiro-cli 那条路一样；不同的只有那条命令（没有 --model/--agent），
            以及本地工具通道走 `mcpServers` 而不是 kiro 的 agent 文件（见 newSession）。
            命令名是适配器装出来的那个（`安装 AI 工具` 装的就是它），走 `bash -lc` 拿到登录 shell 的 PATH。
          */
          command = 'ssh';
          const bin = REMOTE_ADAPTER_BIN[this.engine];
          this.launchedWith = bin;
          args = buildSshArgs(
            this.remote,
            /* 探测（`remoteAdapterCheck`）记下的起法：登录 shell 看不到时是 node 绝对路径 + 入口 */
            buildRemoteAdapterCommand(bin, remoteAdapterLaunchFor(this.remote, this.engine), this.localTools?.agentOverride),
            this.localTools ? { remotePort: this.localTools.remotePort, localPort: this.localTools.localPort } : undefined,
          );
        } else try {
          const a = resolveAdapter(this.engine, this.env as NodeJS.ProcessEnv);
          command = a.command;
          args = a.args;
          extraEnv = a.env;
          this.launchedWith = a.args[0] || a.command;
        } catch (err) {
          reject(err);
          return;
        }
      } else if (this.remote?.sshHost) {
        // Remote executor: run `kiro-cli acp` on the remote host over SSH. ACP is
        // line-delimited JSON-RPC on stdio, which SSH pipes transparently, so the
        // rest of this client is unchanged. The remote kiro-cli operates on the
        // remote filesystem and loads the remote host's own MCP/agent config.
        command = 'ssh';
        const remoteBin = remoteKiroBin(this.remote) || '';
        if (!remoteBin) {
          reject(new Error(tr('No kiro launch command is set for {host} yet. Open Settings → 🖥 Machines, select this machine and click "Auto-detect the three tools on this machine". Without this setting KiroLex won\'t guess the remote binary (a wrong guess shows up as "it starts, but behaves oddly").', { host: this.remote.sshHost })));
          return;
        }
        this.launchedWith = remoteBin;
        args = buildSshArgs(
          this.remote,
          buildRemoteKiroCommand(this.model, this.localTools?.agentOverride || this.kiroAgent, remoteBin),
          this.localTools ? { remotePort: this.localTools.remotePort, localPort: this.localTools.localPort } : undefined,
        );
      } else {
        /* 没配就不起（见 `kiroBinProblem`）—— 这条会话根本不该有一个"猜出来的"执行器 */
        const problem = kiroBinProblem();
        if (problem) { reject(new Error(problem)); return; }
        /*
          **用同一个解析器** ——「看一下有没有 windows 上不能跑的东西」。

          这里原来自己写了一遍"挨个 `fs.existsSync`"，于是**裸命令名会被悄悄丢掉**：
          配置里填 `kiro-cli` 或 `kiro-cli-dev`（PATH 上的名字）时 `existsSync` 当然是 false,
          用户看到的是"kiro-cli not found"，而那个名字明明能跑。

          Windows 上这件事最疼：磁盘上的名字总是带 `.exe`，人很自然会填 `kiro-cli`,
          然后被拒 —— 而设置里的自动检测在 Windows 上又是死的（见 `detectLocal`),
          于是**没有任何一条路能把它配好**。

          `resolveKiroCli()` 本来就处理了这两种情况（裸名字直接用、带分隔符的才查文件），
          而且它的注释已经写着"一个解析器给两条路"—— 这里没照做是个疏漏。
        */
        const cliPath = resolveKiroCli();
        if (!cliPath) {
          reject(new Error(
            tr('kiro-cli not found. Tried these:\n{candidates}\n\nEnter a path in Settings → 🖥 Machines → 💻 This machine, or set KIRO_CLI_PATH. (A bare name on PATH works too, it doesn\'t have to be an absolute path.)', { candidates: kiroCliCandidates().join('\n') }),
          ));
          return;
        }

        command = cliPath;
        this.launchedWith = cliPath;
        args = ['acp'];
        if (this.kiroAgent) args.push('--agent', this.kiroAgent);
        args.push('--model', this.model);
        // Do not pass --trust-all-tools here. That launch-time flag prevents
        // kiro-cli from emitting permission requests, so an Auto session cannot
        // later switch back to Ask. Auto mode is implemented below by selecting
        // an allow option immediately when session/request_permission arrives.
      }

      /**
       * **可选：让 kiro-cli 记 trace 级日志** ——「这个问题很严重必须修好」。
       *
       * 查这次那几十次"断"最后卡在一件事上：ACP 上只能看到一句 `Internal error`，而请求体是
       * kiro-cli 拼的、KiroLex 连不到。实测 `KIRO_LOG_LEVEL=trace` 之后它会把整条
       * `CodeWhispererStreaming.GenerateAssistantResponse` 的往返记下来（HTTP 状态、响应头、
       * 请求 id、`received response from service` 那一行），也就是**能拿去找 Kiro 团队的东西**。
       *
       * 默认关：trace 一次运行能写几 MB。两种打开方式，都不用改代码 ——
       *   · 环境变量 `KIROLEX_KIRO_TRACE=1`
       *   · 或者 `touch ~/.kirolex/kiro-trace`（下一次起执行器就生效，不必从终端启动 app）
       * 关掉就把那个文件删掉。开着的时候 `failureBundle` 会多抄一段日志（见那边的 tailBytes）。
       */
      /* 远端：给 ssh 带上密码（没配密码时 sshEnv 原样返回） */
      const env = this.remote?.sshHost ? sshEnv(this.remote, this.env) : { ...this.env };
      if (this.engine === 'kiro' && kiroTraceEnabled()) env.KIRO_LOG_LEVEL = 'trace';
      Object.assign(env, extraEnv);
      this.spawnedAt = Date.now();
      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        windowsHide: true,
      });

      this.process.stdout!.on('data', (data: Buffer) => {
        this.buffer += data.toString('utf-8');
        this.processBuffer();
      });

      this.process.stderr!.on('data', (data: Buffer) => {
        const msg = data.toString('utf-8').trim();
        /* 留着最后一点 stderr：ssh 退出码 255 只说"连接没了"，**原因**在这里面
           （典型的一条：`Warning: remote port forwarding failed for listen port 39100`）。 */
        if (msg) this.lastStderr = `${this.lastStderr}\n${msg}`.slice(-2000);
        /* 远端自报的 PID：记下来，断开时要杀它（见 buildRemoteKiroCommand 那段） */
        const pid = parseRemotePid(msg);
        if (pid) this.remotePid = pid;
        if (msg) {
          this.noteEarlyStderr(msg);
          this.emit('error', { type: 'stderr', message: msg });
        }
      });

      this.process.on('close', (code) => {
        this.emit('disconnected', { code });
        /*
          **`code 0` 要说成"退出了"，不是"失败了"** ——「重连会话好像也会被当作失败处理？」

          实测那一串：`disconnected … busy=true` → `[prompt] error … Process exited with code 0`
          → `resume attempt 2 succeeded` → 消息被重发、上下文随行。也就是说这一轮**最终是成好的**，
          而中间那句以 `error` 的身份进了界面。`code 0` 是**正常退出**（kiro-cli 自己收摊了），
          把它和 code 1 那种真崩溃说成同一件事，只会让人以为自己的这一轮坏了。

          仍然 reject（那些在飞的请求确实等不到回答了），只是把话说准：谁看见这条消息，
          都该往"重连"想，而不是往"我的输入有问题"想。
        */
        /*
          远程执行器多一种形状：`ssh` 这一层断了会给 **255**（远端命令自己的退出码 ssh 原样透传）。
          那是掉线，不是"这条对话在后端坏了" —— 说成后者会让恢复逻辑去重建会话，而重建对掉线
          毫无用处，只会把后端那段历史白扔一次。判据在 `transientError.ts`。
        */
        this.rejectAllPending(new Error(code === 0
          ? tr('The executor exited normally (code 0); KiroLex reconnects automatically.')
          : this.remote?.sshHost && isSshTransportExit(code)
            ? sshDropMessage(code, this.lastStderr)
            /* Claude Code / Codex 一起来就退（没 node、node 版本不对、配置坏了）：原因只在 stderr 里，带上最后几行 */
            : `Process exited with code ${code}${this.engine !== 'kiro' ? adapterExitDetail(this.lastStderr) : ''}`));
      });

      this.process.on('error', (err: NodeJS.ErrnoException) => {
        /* 非 Windows 上没找到适配器包时退回的是 PATH 上的裸名字（`resolveAdapter`）：不在 PATH 上就是 ENOENT，
           说成「装哪个包」，别让人对着一句 `spawn claude-agent-acp ENOENT` 猜 */
        if (this.engine !== 'kiro' && !this.remote?.sshHost && err?.code === 'ENOENT') {
          reject(Object.assign(new Error(adapterMissingMessage(this.engine)), { code: err.code }));
          return;
        }
        reject(err);
      });

      // Send initialize
      setTimeout(async () => {
        try {
          // Bounded handshake. The default request timeout (120s) meant a RETIRED
          // model — kiro-cli never answers initialize for one — stalled the whole
          // executor start for two minutes before the model fallback could kick in.
          // With N sessions warming at boot that alone wedged the splash screen.
          const result = await this.sendRequest('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'KiroLex', version: '0.1.0' },
            capabilities: {},
          }, INITIALIZE_TIMEOUT_MS);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }, 500);
    });
  }

  /**
   * Release this executor. kiro-cli holds SINGLE-PROCESS OWNERSHIP of a session
   * and only releases it when the process exits cleanly: closing stdin makes it
   * exit 0 and free the session, whereas killing it leaves a STALE lock so any
   * later session/load fails with "Session is active in another process (PID n)"
   * even though that PID is gone. So: close stdin, wait for a clean exit, and
   * only escalate to a kill if it does not exit in time.
   */
  async disconnect(opts: { killTree?: boolean } = {}) {
    const proc = this.process;
    this.process = null;
    if (proc) {
      const exited = new Promise<void>((resolve) => {
        // 删除时进程可能早就退了（close 已经发过），别白等 5 秒
        if (opts.killTree && (proc.exitCode !== null || proc.signalCode !== null)) { resolve(); return; }
        proc.once('close', () => resolve());
      });
      /*
        **删除会话时（`killTree`）在 Windows 上连子进程一起收**：kiro-cli 起的 shell / python 等不会随它退出，
        而它们的工作目录常常就在 `sessions/<id>/files` 里，Windows 就不让移动这个目录（EBUSY）。
        所以趁 kiro-cli 还活着先拍一张「它下面有哪些进程」的快照（pid + 创建时间，只认这一棵树，不碰别的会话），
        它退出后再把快照里还活着的收掉；它不肯退出要强杀时，用 `taskkill /T /F` 整棵树一起结束。

        **旧 pid 不可信**：执行器已经退出的话，它的 pid 可能已被另一个会话的 kiro-cli 复用 —— 那时按 pid 查树
        就会把别人的子进程当成自己的。所以执行器已退出就不查；查到的根还要核对创建时间是不是我们 spawn 的那一刻
        （见 `snapshotExecutorTree`），对不上就什么都不认，强杀也退回 `proc.kill()`（走 Node 自己的进程句柄）。
      */
      const treeDeps: TreeDeps = {
        list: () => listWindowsProcesses(2000),
        kill: (pid) => taskkillTree(pid),
        killOne: (pid) => taskkillOne(pid),
      };
      const tree = opts.killTree && process.platform === 'win32'
        ? await snapshotExecutorTree(proc, this.spawnedAt, treeDeps)
        : null;
      try { proc.stdin?.end(); } catch { /* already closed */ }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), 5000);
      });
      const outcome = await Promise.race([exited.then(() => 'exited' as const), timeout]);
      if (timer) clearTimeout(timer);
      if (outcome === 'timeout') {
        if (!(await forceKillExecutorTree(proc, tree, treeDeps))) {
          try { proc.kill(); } catch { /* already gone */ }
        }
      }
      await sweepExecutorChildren(tree, treeDeps);
    }
    /*
      **远端那个进程要单独杀** —— 杀掉本地的 ssh 并不会带走它（实测那台 EC2 上攒了 85 个孤儿
      kiro-cli，最老的 2 天 23 小时），而它一直占着那条 kiro-cli 会话的锁：下一次 attach 或者
      换模型就报「Session is active in another process」，然后一连串 `Session not connected`。
      不等结果、也不管失败：这是收尾动作，卡在这儿会把"换模型"变成"界面卡住"。
    */
    if (this.remote?.sshHost && this.remotePid) {
      const pid = this.remotePid;
      this.remotePid = undefined;
      try {
        execFile('ssh', [...buildSshArgs(this.remote, remoteKillTree(pid))],
          { timeout: 15_000, env: sshEnv(this.remote) }, () => {});
      } catch { /* 收尾失败不该影响断开本身 */ }
    }
    this.rejectAllPending(new Error('Disconnected'));
  }

  /**
   * Change how future ACP permission requests are handled without replacing
   * the executor. KiroLex deliberately starts kiro-cli without
   * --trust-all-tools so both Auto and Ask remain reversible at runtime.
   */
  setPermissionMode(mode: PermissionMode) {
    if (this.engine !== 'kiro') return;   // 见构造函数：那两家按它们自己的 mode
    this.permissionMode = mode;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  /** kiro 的工具来自它的 agent 文件（远程会话那份由 KiroLex 每会话生成），所以给它的永远是空表；
   *  Claude Code / Codex 没有那种文件，远程会话的本地工具通道就在这里交给它们。 */
  /** 这个执行器的 ssh 用 `-R` 占着的那个远端端口（没有就 undefined）—— 分端口时要避开它。 */
  get forwardedRemotePort(): number | undefined {
    return this.localTools?.remotePort;
  }

  private get mcpServers(): any[] {
    /*
      唯一的 kiro 例外：**本地 kiro 会话 + local_browser 开着**（index.ts `withLocalBrowser`）——
      kiro-cli 的 initialize 声明了 `mcpCapabilities.http`，浏览器那几个工具就从这里交给它。
      远程 kiro 照旧走 agent 文件（下面那行）。
    */
    if (this.engine === 'kiro' && !this.remote?.sshHost && this.localTools?.mcpServers?.length) return this.localTools.mcpServers;
    return this.engine !== 'kiro' ? (this.localTools?.mcpServers || []) : [];
  }

  async newSession(cwd: string): Promise<{ sessionId: string }> {
    const r = await this.sendRequest('session/new', {
      cwd,
      mcpServers: this.mcpServers,
    });
    this.noteConfigOptions(r?.configOptions);
    return r;
  }

  async loadSession(sessionId: string, cwd: string): Promise<any> {
    const r = await this.sendRequest('session/load', {
      sessionId,
      cwd,
      mcpServers: this.mcpServers,
    });
    this.noteConfigOptions(r?.configOptions);
    return r;
  }

  /**
   * Claude Code / Codex 的模型清单 ——「右侧的选模型为什么没有」。两个适配器都在 session/new（/load）
   * 的 `configOptions` 里给一个 `id: 'model'` 的 select，切换走 `session/set_config_option`（实测两边都认）。
   */
  private configOptions: any[] = [];
  private noteConfigOptions(opts: unknown): void {
    if (Array.isArray(opts)) this.configOptions = opts;
  }
  /**
   * 一类下拉的清单（`model` / `thought_level` …，按 ACP 的 category 认，id 两家不一样：
   * Claude Code 的 effort 叫 `effort`，Codex 叫 `reasoning_effort`）。没有就是 null。
   */
  selectOptions(category: EngineOptionCategory): EngineSelect | null {
    const o = this.findOption(category);
    if (!o || !Array.isArray(o.options)) return null;
    return {
      current: String(o.currentValue ?? ''),
      options: o.options.map((x: any) => ({ value: String(x.value ?? x.id ?? ''), name: String(x.name ?? x.value ?? '') }))
        .filter((x: { value: string }) => x.value),
    };
  }
  get modelOptions(): EngineSelect | null {
    return this.selectOptions('model');
  }
  /** 设一类的值。返回的 configOptions 整份记下来 —— 换模型时 effort 的可选值可能跟着变。 */
  async setSelectOption(sessionId: string, category: EngineOptionCategory, value: string): Promise<void> {
    const o = this.findOption(category);
    if (!o) throw new Error(category === 'model' ? tr('This engine did not provide a model list') : category === 'mode' ? tr('This engine did not provide permission modes') : tr('This engine did not provide effort options'));
    const r = await this.sendRequest('session/set_config_option', { sessionId, configId: o.id, value });
    this.noteConfigOptions(r?.configOptions);
  }
  async setModelOption(sessionId: string, value: string): Promise<void> {
    return this.setSelectOption(sessionId, 'model', value);
  }
  private findOption(category: EngineOptionCategory): any {
    return this.configOptions.find((x) => x?.category === category) || this.configOptions.find((x) => x?.id === category);
  }

  async sendPrompt(sessionId: string, prompt: any[]): Promise<any> {
    // NO client-side idle abort for prompts. kiro-cli performs context
    // compaction (and long silent tool steps) INSIDE session/prompt while
    // emitting nothing at all, which used to trip the idle timer: KiroLex gave
    // up on a turn that was still running in the backend, cleared `busy`, and
    // every resend/rerun then hit kiro-cli's "Prompt already in progress".
    // A turn is terminated by the user (session/cancel) or by disconnect --
    // never by a local stopwatch.
    return this.sendRequest('session/prompt', {
      sessionId,
      prompt,
    }, 0);
  }

  async cancelPrompt(sessionId: string) {
    this.sendNotification('session/cancel', { sessionId });
    /*
      ACP：发了 session/cancel，客户端**必须**把挂着的 session/request_permission 都答成 cancelled ——
      适配器那一轮在等这个回答，不答它就停不下来（停止按钮等到超时）。只对 Claude Code / Codex：
      它们在 KiroLex 里永远是 ask（见构造函数），kiro 这条路保持原样。
    */
    if (this.engine !== 'kiro') {
      for (const id of [...this.pendingPermissions.keys()]) {
        this.pendingPermissions.delete(id);
        try { this.send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } }); } catch { /* 进程已经没了 */ }
      }
    }
  }

  /** 有没有权限请求在等人回答（看门狗据此不把「等人」当成卡死）。 */
  get awaitingPermission(): boolean {
    return this.pendingPermissions.size > 0;
  }

  /**
   * Inject a mid-turn steer into the CURRENTLY RUNNING turn via kiro-cli's
   * `_session/steer` ext-method (kiro-cli >= 2.7). Fire-and-forget by design:
   * the in-flight `session/prompt` read loop is the SINGLE consumer of this
   * process's stdout, so we must NOT await a JSON-RPC response here — a second
   * awaiting reader would steal the running turn's own streamed messages and
   * corrupt the stream. We therefore write the request with a fresh id but
   * register NO pending handler; kiro-cli's `{queued:true}` ack lands in
   * handleMessage(), finds no matching pendingRequests entry (which is keyed by
   * our numeric id — string/number ids alike simply miss), and is harmlessly
   * ignored. Nothing is cancelled and no new turn is started.
   *
   * Delivery is confirmed asynchronously by the `steering_consumed` lifecycle
   * notification (normalized to `steer_consumed` in handleNotification), NOT by
   * this call. The message is wrapped in <user_message> tags so kiro-cli's
   * concatenated multi-steer snapshot keeps an unambiguous per-message boundary.
   *
   * Returns false (not steered) for an empty message or a dead/unwritable pipe;
   * true once the request bytes are written. Never throws — a write failure is
   * reported as false so the caller can fall back to the queue.
   */
  steer(sessionId: string, message: string): boolean {
    const text = (message || '').trim();
    if (!text) return false;
    if (!this.process?.stdin?.writable) return false;
    const wrapped = `<user_message>\n${text}\n</user_message>`;
    try {
      // Raw fire-and-forget write. NOT sendRequest() (which registers a pending
      // promise + idle timeout that would later reject unhandled), and NOT a
      // notification (kiro-cli expects a request id to ack). The id is consumed
      // from the same counter so it never collides with a tracked request; its
      // ack is intentionally unhandled.
      const id = this.nextId++;
      this.send({ jsonrpc: '2.0', id, method: '_session/steer', params: { sessionId, message: wrapped } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether this backend supports mid-turn steer (`_session/steer`). KiroLex
   * targets kiro-cli only, whose ACP implements the ext-method from v2.7. An
   * older binary answers -32601 to the fire-and-forget request, which is
   * ignored (no steer, no crash); callers still fall back to the queue on a
   * false `steered` result so a message is never dropped.
   */
  get supportsSteer(): boolean {
    /* `_session/steer` 是 kiro-cli 的扩展；适配器那两家没有（会回 -32601，消息就丢了） */
    return this.engine === 'kiro';
  }

  /** OS pid of the kiro-cli child, or undefined once it has exited. Used to bind
   *  a "history was primed" marker to the process that actually holds it: ACP
   *  sessions are in-memory only, so the same session id in a NEW process is a
   *  blank conversation. */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  async respondToPermission(requestId: JsonRpcId, decision: boolean | string) {
    const options = this.pendingPermissions.get(requestId) || [];
    this.pendingPermissions.delete(requestId);
    const option = typeof decision === 'string'
      ? options.find((candidate) => candidate.optionId === decision)
      : pickPermissionOption(options, decision);
    this.send({
      jsonrpc: '2.0',
      id: requestId,
      result: option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } },
    });
  }

  // Reset the idle timers of all pending requests (called on any inbound data,
  // so long-running requests stay alive as long as the agent is producing output)
  private resetPendingTimers() {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.idleMs <= 0) continue; // never-expiring request (session/prompt)
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          pending.reject(new Error(`Request timed out (no activity)`));
        }
      }, pending.idleMs);
    }
  }

  /** idleMs <= 0 means the request NEVER expires locally (see sendPrompt). */
  private sendRequest(method: string, params: any, idleMs: number = 120000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;

      const timer = idleMs > 0
        ? setTimeout(() => {
            if (this.pendingRequests.has(id)) {
              this.pendingRequests.delete(id);
              reject(new Error(`Request ${method} timed out`));
            }
          }, idleMs)
        : (undefined as unknown as NodeJS.Timeout);

      this.pendingRequests.set(id, { resolve, reject, timer, idleMs });

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.send(request);
    });
  }

  private sendNotification(method: string, params: any) {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.send(notification);
  }

  private send(msg: any) {
    if (!this.process?.stdin?.writable) {
      throw new Error(tr('Process not connected'));
    }
    const line = JSON.stringify(msg) + '\n';
    this.process.stdin.write(line);
  }

  private processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      try {
        const msg = JSON.parse(trimmed);
        this.handleMessage(msg);
      } catch {
        // Skip non-JSON lines (e.g., log output)
      }
    }
  }

  private handleMessage(msg: any) {
    // Any inbound data means the agent is alive - keep pending requests from timing out
    this.resetPendingTimers();

    // Response to a request we made
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if ('error' in msg) {
          // Attach the JSON-RPC error.data so callers can surface WHY (kiro-cli
          // often sends a bare "Internal error" message with the real reason in
          // data, e.g. a stale session lock or bad session state).
          /* Claude Code / Codex 没登录：ACP 的 auth_required —— 换成说清是哪个工具、去哪登录的那句（原文留在 data） */
          const authMissing = this.engine !== 'kiro' && isAuthRequiredError(msg.error);
          const e: any = new Error(authMissing
            ? adapterAuthMessage(this.engine as Exclude<Engine, 'kiro'>)
            : (msg.error.message || JSON.stringify(msg.error)));
          if (authMissing) e.data = msg.error.data ?? msg.error.message;
          else if (msg.error.data !== undefined) e.data = msg.error.data;
          if (msg.error.code !== undefined) e.code = msg.error.code;
          pending.reject(e);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Notification from agent
    if ('method' in msg && !('id' in msg)) {
      this.handleNotification(msg);
      return;
    }

    // Request from agent (e.g., session/request_permission)
    if ('method' in msg && 'id' in msg) {
      this.handleAgentRequest(msg);
      return;
    }
  }

  private handleNotification(msg: any) {
    const { method, params } = msg;

    // Mid-turn steer lifecycle rides on `session/update` (kiro-cli v2.9) or
    // `_kiro.dev/session/update` (v2.7); the `update.sessionUpdate` discriminant
    // distinguishes it from ordinary updates / subagent activity. Normalize BOTH
    // the old/new event names AND the old/new payload fields (v2.7 `message` on
    // queued / `content` on consumed; v2.9 `content` for both; `content` may be a
    // bare string OR a { text } object) into one stable renderer shape so the
    // renderer handles a single { sessionUpdate: 'steer_queued'|'steer_consumed'
    // |'steer_cleared', text } set of names.
    if (method === 'session/update' || method === '_kiro.dev/session/update') {
      const update = params?.update;
      const disc = update?.sessionUpdate;
      if (disc && STEER_DISCRIMINANTS.has(disc)) {
        const kind = (disc === 'steering_queued' || disc === 'AgentExecutionUserMessageQueued')
          ? 'steer_queued'
          : (disc === 'steering_consumed' || disc === 'AgentExecutionSteeringInjected')
          ? 'steer_consumed'
          : 'steer_cleared';
        const rawContent = update.content ?? update.message;
        const text = typeof rawContent === 'string' ? rawContent : (rawContent?.text || '');
        this.emit('update', { sessionId: params?.sessionId, update: { sessionUpdate: kind, text } });
        return;
      }
    }

    if (method === 'session/update') {
      /*
        **适配器自己改了配置**（Claude 批准 ExitPlanMode 后离开 plan 模式、`/model` 换模型…）：ACP 用
        `config_option_update`（整份清单）/ `current_mode_update`（只报模式）通知。原来没人接，下拉一直停在旧值。
        记下来再发 `config-options`，index.ts 把下拉重推给界面。kiro 不发这两种。
      */
      const cu = params?.update;
      if (cu?.sessionUpdate === 'config_option_update' && Array.isArray(cu.configOptions)) {
        this.noteConfigOptions(cu.configOptions);
        this.emit('config-options');
      } else if (cu?.sessionUpdate === 'current_mode_update' && typeof cu.currentModeId === 'string') {
        const mode = this.findOption('mode');
        if (mode) {
          this.configOptions = this.configOptions.map((o) => (o === mode ? { ...o, currentValue: cu.currentModeId } : o));
          this.emit('config-options');
        }
      }
      /* 权限请求只带 toolCallId / title；写文件闸要的 kind / rawInput 在这里（只有远程会话接了闸才记） */
      const su = params?.update?.sessionUpdate;
      if (this.remoteWriteGuard && (su === 'tool_call' || su === 'tool_call_update')) this.toolLedger.remember(params.update);
      this.emit('update', params);
    } else if (method.startsWith('_kiro.dev/')) {
      // Kiro-specific notifications (mcp init, commands, etc.)
      this.emit('update', { 
        sessionId: params?.sessionId, 
        update: { sessionUpdate: '_kiro_internal', method, ...params }
      });
    } else {
      this.emit('update', { method, params });
    }
  }

  /** 提示里怎么叫这个执行器：kiro 说 kiro-cli，另外两家说引擎名 */
  private get cliName(): string {
    return this.engine === 'kiro' ? 'kiro-cli' : ENGINE_LABEL[this.engine];
  }

  private handleAgentRequest(msg: any) {
    const { method, id, params } = msg;
    
    if (method === 'session/request_permission') {
      const options: Array<{ optionId: string; kind?: string }> = params?.options || [];
      /*
        **远程会话：远端自带的写文件工具写到缓存以外 → 拒** ——「用户需要的文件一律落在本机」。
        排在自动批准 / 问人**之前**：两种模式都不该把交付文件放到那台机器上。判据在 `remoteWriteGuard.ts`
        （由 index.ts 按会话接上），拒掉之后说一声（`remote-write-blocked`），模型按提示词改用 `local_write`。
      */
      const guard = this.remoteWriteGuard?.(this.toolLedger.join(params?.toolCall ?? params));
      if (guard?.block) {
        const reject = pickPermissionOption(options, false);
        this.send({
          jsonrpc: '2.0',
          id,
          result: reject
            ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
            : { outcome: { outcome: 'cancelled' } },
        });
        this.emit('remote-write-blocked', { sessionId: params?.sessionId, paths: guard.paths, title: params?.toolCall?.title });
        return;
      }
      if (this.permissionMode === 'auto-approve') {
        const allow = pickPermissionOption(options, true);
        this.send({
          jsonrpc: '2.0',
          id,
          result: allow
            ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
            : { outcome: { outcome: 'cancelled' } },
        });
        return;
      }

      this.pendingPermissions.set(id, options);
      this.emit('update', {
        sessionId: params?.sessionId,
        update: {
          sessionUpdate: 'permission_request',
          requestId: id,
          ...params,
        },
      });
    } else {
      /*
        **代用户回答之前必须先说出来**。

        这里原来一句注释 `Auto-approve unknown requests` 就把任何不认识的请求回成 `{}`。
        今天只有 `session/request_permission` 会向客户端要答案（翻过那个二进制里所有方法名，
        `session/request_user_input` / `ask` / `choice` 一个都没有），所以这条分支现在走不到。

        但它是个**静默**的兜底：kiro-cli 哪天加了一种"问用户"的请求，KiroLex 会替用户答一个
        空对象，而用户、日志、界面三处都看不到发生过这件事 —— 那一轮就是按一个没人给过的
        答案继续跑的。

        仍然回 `{}`（不回会让那一轮挂住等超时，那更糟），但走 `error` 这条已有的通道说出来：
        它既进日志、也发到界面（见 index.ts 的 `client.on('error')`）。出现一次就该按
        真正的语义去处理它，而不是继续猜。
      */
      this.emit('error', {
        type: 'unknown-request',
        message: tr('{engine} sent an unknown request `{method}`; KiroLex replied {}. If it was asking you something, this turn went on with an answer nobody gave. Please report this to KiroLex.', { engine: this.cliName, method }),
        method,
        params,
      });
      this.send({ jsonrpc: '2.0', id, result: {} });
    }
  }

  private rejectAllPending(error: Error) {
    for (const [, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(error);
    }
    this.pendingRequests.clear();
    this.pendingPermissions.clear();
  }
}

function pickPermissionOption(
  options: Array<{ optionId: string; kind?: string }>,
  granted: boolean,
): { optionId: string; kind?: string } | undefined {
  if (granted) {
    return options.find((option) => option.kind === 'allow_once')
      || options.find((option) => option.kind === 'allow_always')
      || options.find((option) => option.kind?.startsWith('allow'))
      || options[0];
  }
  return options.find((option) => option.kind === 'reject_once')
    || options.find((option) => option.kind === 'reject_always')
    || options.find((option) => option.kind?.startsWith('reject'));
}

/** POSIX single-quote a value so it is safe to embed in a remote shell command. */
/** Single-quote a value for a POSIX shell. Exported because the verifier runner
 *  (loopVerify.ts) has to quote a remote command line the same way this file does —
 *  two independent quoting rules for the same SSH invocation is how a verifier ends
 *  up running something subtly different from the agent's own command. */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the command string run on the remote host by SSH. It launches
 * `kiro-cli acp` under a login shell (`bash -lc`) so the remote PATH picks up
 * kiro-cli's default install dir (~/.local/bin). The session working directory
 * is supplied later via ACP `session/new` cwd, so no `cd` is needed here.
 */
/**
 * 远端要跑的那条命令。
 *
 * **先把 PID 报出来再 exec** ——「Session is active in another process (PID 1272360)」。
 * 实测那台 EC2 上堆了 **85 个**孤儿 kiro-cli（最老的跑了 2 天 23 小时）：ssh 这边死掉之后，
 * 远端那个进程**不会**跟着退（没有 PTY，它也不在读到 EOF 时退出），于是它一直占着那条
 * kiro-cli 会话的锁。下一次 attach / 换模型就撞上"会话在另一个进程里"，然后表现成
 * 一连串 `Session not connected` —— 看起来就是"这条会话串了/坏了"。
 *
 * `$$` 是那个 bash 的 PID，而 `exec` 之后 kiro-cli **就是同一个 PID**，所以这一行报出来的
 * 就是要杀的那个。走 stderr：stdout 是 ACP 的协议流，掺一个字节进去就毁了它。
 */
/** 远端起 Claude Code / Codex 的 ACP 适配器：和 kiro 那条一样先报 PID（`remoteKillTree` 靠它收尸）。 */
export function buildRemoteAdapterCommand(bin: string, launch?: AdapterVerdict, tag?: string): string {
  /* 带上会话标记：整棵进程树都继承它，远端清扫靠它认出崩溃 / 断网留下的适配器（`adapterSweepScript`） */
  const mark = tag && /^[\w.-]+$/.test(tag) ? `export ${ADAPTER_TAG_ENV}=${tag}; ` : '';
  return `bash -lc ${shellQuote(`echo "${REMOTE_PID_MARKER} $$" >&2; ${mark}${adapterExecLine(bin, launch)}`)}`;
}

function buildRemoteKiroCommand(model: string, kiroAgent: string | undefined, bin: string): string {
  /* `bin` 是**必填**的：调用点（`connect`）在它为空时就已经拒绝启动了（`remoteKiroBin`）。
     这里留一个 `|| 'kiro-cli'` 兜底等于在代码里留一句"我们会猜"，而那正是要去掉的行为。 */
  let cli = `${shellQuote(bin)} acp --model ${shellQuote(model)}`;
  if (kiroAgent) cli += ` --agent ${shellQuote(kiroAgent)}`;
  return `bash -lc ${shellQuote(`echo "${REMOTE_PID_MARKER} $$" >&2; exec ${cli}`)}`;
}

/**
 * **杀掉那条执行器的整棵树，不是只杀报上来的那个 PID** ——
 * 「❌ Error invoking remote method 'acp:switch-model': Error: Session not connected」。
 *
 * 远端的进程结构是两层：
 *
 * ```
 * kiro-cli （就是 `buildRemoteKiroCommand` 报出来的那个 $$）
 *   └── kiro-cli-chat   ← 真正握着那条 kiro-cli 会话锁的是**它**
 * ```
 *
 * 只杀父进程的后果不是"少收一个进程"：`kiro-cli-chat` 被 reparent 到 1 之后**继续活着**，
 * 锁还在它手上。于是紧接着那次 `session/load` 撞上"会话在另一个进程里"，
 * 而 ACP 上只报一句 `Internal error` —— 换模型那条路是"杀旧的 → 起新的 → 新的 load 失败 →
 * 回滚也 load 失败"，最后这条会话一个执行器都没有，之后每次换模型都报 `Session not connected`。
 *
 * 实测：用户连着试了三次换模型，远端就多了三个 PPID==1 的 `kiro-cli-chat`
 * （etime 5:32 / 2:50 / 2:40），而 12 个正常进程之外恰好多出这些。这也是把那台 EC2
 * 压到 CPU 100% 的同一个泄漏 —— 只不过开机那一遍孤儿清理会收掉，所以之前只在**运行中**表现出来。
 *
 * 为什么不用进程组（`kill -- -<pgid>`）：sshd 起这条命令时不保证给它一个独立的进程组，
 * 打偏的话会连着这条连接上别的东西一起杀。所以这里**显式地**先收子进程再收父进程，
 * 范围是确定的。`|| true` 让每一步都不至于因为"它已经自己走了"而让整句失败。
 */
export function remoteKillTree(pid: number): string {
  /* 两层就够：实测树深就是 2（kiro-cli → kiro-cli-chat）。多写一层是为了"孙子"那种情况，
     代价只是一句 pgrep —— 而漏掉一层的代价是又一个握着锁的孤儿。 */
  return [
    `for g in $(pgrep -P ${pid} 2>/dev/null); do`,
    `  for gg in $(pgrep -P $g 2>/dev/null); do kill -TERM $gg 2>/dev/null || true; done;`,
    `  kill -TERM $g 2>/dev/null || true;`,
    `done;`,
    `kill -TERM ${pid} 2>/dev/null || true`,
  ].join(' ');
}

/**
 * 适配器异常退出时 stderr 的最后几行（去掉远端自报 PID 那行），拼在 `Process exited with code N` 后面。
 * 不带的话「适配器崩了 / 远端没 node / 版本不对」在界面上都只是同一句退出码，分不清。
 */
export function adapterExitDetail(lastStderr: string): string {
  const lines = String(lastStderr || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith(REMOTE_PID_MARKER));
  const tail = lines.slice(-3).join('\n').slice(-400);
  return tail ? `\n${tail}` : '';
}

/** 远端 kiro-cli 自报 PID 用的前缀（stderr 上的一行）。 */
export const REMOTE_PID_MARKER = 'KIROLEX_REMOTE_PID';

/** 从 stderr 里认出那一行。认不出返回 undefined —— 杀不掉比杀错好。 */
export function parseRemotePid(chunk: string): number | undefined {
  const m = new RegExp(`${REMOTE_PID_MARKER}\\s+(\\d+)`).exec(String(chunk || ''));
  const pid = m ? Number(m[1]) : NaN;
  return Number.isFinite(pid) && pid > 1 ? pid : undefined;
}

/**
 * Assemble `ssh` arguments for a remote target. BatchMode avoids interactive
 * password prompts (key-only auth), ConnectTimeout fails fast on an unreachable
 * host (instead of the ~75s+ default TCP timeout, which would otherwise stall
 * the connect until initialize's idle timeout fires), keepalives detect dead
 * links after connect, and accept-new avoids a first-connect host-key prompt
 * while still pinning the key thereafter. Values originate from the user's local
 * trusted config; the remote command is passed as a single argument.
 *
 * EXPORTED and shared with the loop verifier: a verification command must run on
 * the same host as the agent it is checking. A verifier that runs on this Mac while
 * the agent edits files on an EC2 box is inspecting an unrelated filesystem, and
 * such a loop reports green forever. Sharing this function keeps the "is it remote"
 * decision identical to the one `AcpClient.connect()` makes.
 */
/**
 * **这台机器有没有一条能复用的连接** ——「重复利用」。
 *
 * 由 `sshMux` 注入，而且**只在它刚探活过**的时候返回 socket（见那边的 `liveSocketFor`）。
 * 返回 `undefined` 时这里照原样建一条新连接 —— 那些在 mux 建立**之前**就要跑的路径
 * （preflight、自动检测）本来就得自己连。
 */
let muxSocketResolver: ((remote: RemoteTarget) => string | undefined) | undefined;
export function setMuxSocketResolver(fn?: (remote: RemoteTarget) => string | undefined): void {
  muxSocketResolver = fn;
}

export function buildSshArgs(
  remote: RemoteTarget,
  remoteCommand: string,
  /**
   * 反向隧道：远端的 `127.0.0.1:remotePort` 通到你 Mac 上的 `127.0.0.1:localPort`
   * —— 本地工具通道就走它（`localMcp.ts`）。
   *
   * `ExitOnForwardFailure=yes` 是**故意**的：端口占用时宁可连不上，也不要起一个
   * "看起来好了、其实没有本地工具"的执行器 —— 那种降级是静默的，而模型会把
   * "工具调不通"解释成"这个文件不存在"。
   *
   * 走复用连接时**不传这个**：隧道归 master（`sshMux.ts`），一台机器一条，
   * 所有会话共用那一个远端端口、各自用自己的 token。
   */
  forward?: { remotePort: number; localPort: number },
): string[] {
  /*
    **能复用就复用** ——「你应该加的是垃圾清理和重复利用」。

    ssh 原生支持在一条连接上开多个 channel。复用之后 N 条会话只做**一次**握手：
    不再占 `MaxStartups` 的槽（默认 10:30:100），而那个槽位耗尽正是那台 EC2
    `Connection timed out during banner exchange` 的直接成因 —— 开机时 20 条会话
    ×最多 3 次重试 = 60 次并发握手。
  */
  assertSafeSshHost(remote.sshHost);
  const socket = muxSocketResolver?.(remote);
  if (socket) {
    return [
      '-o', batchModeFor(remote),
      /*
        `ControlMaster=no` 是关键：不加的话这条 ssh 会在 master 不在时**自己变成 master**，
        而它是带命令的 —— 命令一结束连接就没了，于是隧道被一条会话的退出带走，
        别的会话"突然读不到文件了"。宁可直接失败：那时候该做的是把 master 拉起来。
      */
      '-o', 'ControlMaster=no',
      '-o', `ControlPath=${socket}`,
      /* `-i` / `-p` / `-R` 都是**建连接**时才有意义的，走已有连接时全都不带 */
      remote.sshHost, remoteCommand,
    ];
  }
  const args: string[] = [
    '-o', batchModeFor(remote),
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  /* 密码错了就失败，不要在后台反复问（askpass 每次都给同一个答案，问三次也是白问） */
  if (hasPassword(remote)) args.push('-o', 'NumberOfPasswordPrompts=1');
  if (forward) {
    args.push('-o', 'ExitOnForwardFailure=yes');
    args.push('-R', `127.0.0.1:${forward.remotePort}:127.0.0.1:${forward.localPort}`);
  }
  if (remote.identityFile) args.push('-i', remote.identityFile);
  if (remote.sshPort && remote.sshPort !== 22) args.push('-p', String(remote.sshPort));
  /*
    跳板要在**建连接**的这一路上（复用路径上面已经 return 了 —— 走已有连接时那一跳早就跳过了）。
  */
  args.push(...proxyArgs(remote));
  args.push(remote.sshHost, remoteCommand);
  return args;
}
