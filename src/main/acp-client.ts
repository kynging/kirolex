import { spawn, execFile, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PermissionMode, RemoteTarget } from './config';
import { isSshTransportExit, sshDropMessage } from './transientError.ts';

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
  return '还没有设置**本机**的 kiro 启动命令。打开 设置 → 🖥 机器 → 💻 本机，'
    + '点「自动检测这台机器上的三个工具」，或者手填一个路径 —— 没有这个设置 KiroLex 不会去猜一个二进制。';
}

export function kiroCliCandidates(): string[] {
  /* 配了就**只用**它：不再往下试那串猜测路径（见 `kiroBinProblem`） */
  if (configuredKiroBin) return [configuredKiroBin];
  return [
    process.env.KIRO_CLI_PATH,
    // Windows
    `${process.env.LOCALAPPDATA}\\Kiro-Cli\\kiro-cli.exe`,
    `${process.env.LOCALAPPDATA}\\Programs\\kiro-cli\\kiro-cli.exe`,
    `${process.env.APPDATA}\\kiro-cli\\kiro-cli.exe`,
    // macOS/Linux
    `${process.env.HOME}/.local/bin/kiro-cli`,
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

export class AcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private nextId = 0;
  private pendingRequests: Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout>; idleMs: number }> = new Map();
  private model: string;
  private kiroAgent?: string;
  private permissionMode: PermissionMode;
  private pendingPermissions = new Map<JsonRpcId, PermissionOption[]>();
  private buffer = '';
  private env: Record<string, string>;
  private remote?: RemoteTarget;
  private localTools?: { remotePort: number; localPort: number; agentOverride: string };
  /** 最近一点 stderr —— ssh 退出码 255 的**原因**在里面（见 stderr 处理那一段）。 */
  private lastStderr = '';
  /** 远端那个 kiro-cli 的 PID（它自己报的）—— 断开时要把它杀掉，见 `KIROLEX_PID`。 */
  remotePid?: number;
  /**
   * **这次真的用哪条命令起来的** ——「记住历史成功的启动命令或位置」。
   *
   * 本机是 `resolveKiroCli()` 挑中的那个路径，远端是那台机器配的（或 `kiro-cli`）。
   * 主进程在连接成功后把它记进历史 —— 一个真的起过会话的命令比任何检测结果都可信。
   */
  launchedWith?: string;

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
    localTools?: { remotePort: number; localPort: number; agentOverride: string },
  ) {
    super();
    this.model = model;
    this.kiroAgent = kiroAgent;
    this.localTools = localTools;
    this.permissionMode = permissionMode;
    this.env = env || (process.env as Record<string, string>);
    this.remote = remote;
    // A client can receive stderr (e.g. SSH warnings) BEFORE the owner attaches
    // its listeners (wireSession runs after connect/loadSession). An unlistened
    // 'error' emit makes Node throw ERR_UNHANDLED_ERROR, which crashed the main
    // process and surfaced as "Internal error" on IPCs like acp:switch-model.
    // This no-op keeps 'error' always listened; real handling is additive.
    this.on('error', () => {});
  }

  async connect(): Promise<any> {
    return new Promise((resolve, reject) => {
      let command: string;
      let args: string[];

      if (this.remote?.sshHost) {
        // Remote executor: run `kiro-cli acp` on the remote host over SSH. ACP is
        // line-delimited JSON-RPC on stdio, which SSH pipes transparently, so the
        // rest of this client is unchanged. The remote kiro-cli operates on the
        // remote filesystem and loads the remote host's own MCP/agent config.
        command = 'ssh';
        const remoteBin = remoteKiroBin(this.remote) || '';
        if (!remoteBin) {
          reject(new Error(`还没有设置 ${this.remote.sshHost} 上的 kiro 启动命令。`
            + '打开 设置 → 🖥 机器 → 选中这台机器，点「自动检测这台机器上的三个工具」——'
            + '没有这个设置 KiroLex 不会去猜远端的二进制（猜错的表现是"起来了但行为不对"）。'));
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
        // Local executor: search for the kiro-cli binary on this machine.
        const possiblePaths = kiroCliCandidates();

        let cliPath: string | null = null;
        for (const p of possiblePaths) {
          if (fs.existsSync(p)) {
            cliPath = p;
            break;
          }
        }

        if (!cliPath) {
          reject(new Error(
            `kiro-cli not found. Searched:\n${possiblePaths.join('\n')}\n\nPlease install kiro-cli or set KIRO_CLI_PATH environment variable.`
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
      const env = { ...this.env };
      if (kiroTraceEnabled()) env.KIRO_LOG_LEVEL = 'trace';
      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
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
          ? '执行器已退出（正常退出，code 0）—— KiroLex 会自动重连并重发这一轮。'
          : this.remote?.sshHost && isSshTransportExit(code)
            ? sshDropMessage(code, this.lastStderr)
            : `Process exited with code ${code}`));
      });

      this.process.on('error', (err) => {
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
  async disconnect() {
    const proc = this.process;
    this.process = null;
    if (proc) {
      const exited = new Promise<void>((resolve) => {
        proc.once('close', () => resolve());
      });
      try { proc.stdin?.end(); } catch { /* already closed */ }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), 5000);
      });
      const outcome = await Promise.race([exited.then(() => 'exited' as const), timeout]);
      if (timer) clearTimeout(timer);
      if (outcome === 'timeout') {
        try { proc.kill(); } catch { /* already gone */ }
      }
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
        execFile('ssh', [...buildSshArgs(this.remote, `kill -TERM ${pid} 2>/dev/null || true`)],
          { timeout: 15_000 }, () => {});
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
    this.permissionMode = mode;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  async newSession(cwd: string): Promise<{ sessionId: string }> {
    return this.sendRequest('session/new', {
      cwd,
      mcpServers: [],
    });
  }

  async loadSession(sessionId: string, cwd: string): Promise<any> {
    return this.sendRequest('session/load', {
      sessionId,
      cwd,
      mcpServers: [],
    });
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
    return true;
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
      throw new Error('Process not connected');
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
          const e: any = new Error(msg.error.message || JSON.stringify(msg.error));
          if (msg.error.data !== undefined) e.data = msg.error.data;
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

  private handleAgentRequest(msg: any) {
    const { method, id, params } = msg;
    
    if (method === 'session/request_permission') {
      const options: Array<{ optionId: string; kind?: string }> = params?.options || [];
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
      // Auto-approve unknown requests
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
function buildRemoteKiroCommand(model: string, kiroAgent: string | undefined, bin: string): string {
  /* `bin` 是**必填**的：调用点（`connect`）在它为空时就已经拒绝启动了（`remoteKiroBin`）。
     这里留一个 `|| 'kiro-cli'` 兜底等于在代码里留一句"我们会猜"，而那正是要去掉的行为。 */
  let cli = `${shellQuote(bin)} acp --model ${shellQuote(model)}`;
  if (kiroAgent) cli += ` --agent ${shellQuote(kiroAgent)}`;
  return `bash -lc ${shellQuote(`echo "${REMOTE_PID_MARKER} $$" >&2; exec ${cli}`)}`;
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
   */
  forward?: { remotePort: number; localPort: number },
): string[] {
  const args: string[] = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (forward) {
    args.push('-o', 'ExitOnForwardFailure=yes');
    args.push('-R', `127.0.0.1:${forward.remotePort}:127.0.0.1:${forward.localPort}`);
  }
  if (remote.identityFile) args.push('-i', remote.identityFile);
  if (remote.sshPort && remote.sshPort !== 22) args.push('-p', String(remote.sshPort));
  args.push(remote.sshHost, remoteCommand);
  return args;
}
