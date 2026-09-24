/**
 * **把你这台机器的文件和命令，做成远端能调的 MCP 工具** ——「要不把镜像去掉，我们尝试一下给远程
 * 配一些能调用本地 MCP 的能力？」
 *
 * ## 为什么这条路成立
 *
 * 远端的 kiro-cli 不用 ACP 的客户端 fs 能力（实测 0 回调），所以"让它读你的文件"过去只有镜像一条路。
 * 但它**认 HTTP 的 MCP server**（`kiro-cli mcp add --url`）—— 而 MCP 是它自己会去调的东西。
 * 于是：
 *
 * ```
 * 你的 Mac：这个模块，只听 127.0.0.1 的一个随机端口
 *           ssh -R <远端端口>:127.0.0.1:<本地端口>   ← 执行器本来就是 ssh 起的
 * 远端：    agent JSON 里一条 { type: "http", url: "http://127.0.0.1:<远端端口>/mcp/<token>" }
 * ```
 *
 * 远端不需要装任何东西，文件也不用搬。
 *
 * ## 184 毫秒决定了工具的粒度
 *
 * 实测到那台东京机器的 RTT 是 **184 ms**。所以工具**必须粗**：`local_read` 一次收多个路径、
 * `grep`/`glob`/`git` 都在**你机器上**跑完只回结果。做成"一次一个文件"的话，一轮 50 次读
 * 就是 9 秒纯延迟 —— 那就比镜像（一次 5–21 秒、之后全程本地速度）更慢了。
 *
 * ## 边界：说实话，不做安全剧场
 *
 * 工具面里有 `local_bash`（你要的），所以**这条通道等于那台远端机器在你 Mac 上有一个 shell**。
 * 既然如此，再给读写加路径牢笼就是自欺 —— 能跑 bash 就能 `cat` 任何东西。真正起作用的是这三条：
 *   · **只听 loopback**，而且只能顺着**那条 ssh** 的反向隧道进来；
 *   · **URL 里带 token**（`mcp add` 没有 `--headers`，所以 token 只能放路径）——
 *     EC2 上任何有 shell 的东西都能敲 `127.0.0.1:<端口>`，token 是那一层的锁；
 *     token 一条会话一个，会话结束即失效；
 *   · **每一次调用都留痕**：写文件和跑命令还会在会话状态行上说出来。看得见比拦得住更重要 ——
 *     拦得住的清单总能被绕过，而看不见的操作你连事后都查不出来。
 *
 * 另外 `cwd` 一律是这条会话的工作目录（不是 KiroLex 的进程目录）：相对路径的含义必须和
 * "它以为自己在哪" 一致，否则它写出来的文件会散落在你想不到的地方。
 */

import { execFile, spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

/** MCP 协议版本：跟 kiro-cli 报的那个对齐（它不认就会在 initialize 上直接失败）。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * 单个文件读取上限 —— 再大就不该整份塞进上下文。
 *
 * **必须小于 `MAX_OUTPUT_BYTES`**：单测里踩到的一个真问题 —— 上限设成 256 KB 而总输出上限
 * 128 KB 时，"只读了前 N 字节"那句说明自己被总输出的截断切掉了，于是模型拿到的是
 * **一份看起来完整的半个文件**，而它会照着残缺内容改代码。
 */
export const MAX_READ_BYTES = 64 * 1024;
/** 一次调用总输出上限（grep 打爆上下文是真实发生的事）。 */
export const MAX_OUTPUT_BYTES = 128 * 1024;
/** `local_bash` 的默认超时。它跑在你机器上，卡住的是这一轮。 */
export const BASH_TIMEOUT_MS = 120_000;

export interface LocalMcpSession {
  sessionId: string;
  /** 这条会话在本地的工作目录 —— 所有相对路径、`local_bash` 的 cwd 都以它为准。 */
  workdir: string;
}

export interface LocalMcpDeps {
  log(level: 'info' | 'warn', message: string): void;
  /** 写文件 / 跑命令要在会话里说出来（看得见比拦得住重要）。 */
  notice(sessionId: string, text: string): void;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** 工具清单 —— 给模型看的描述里要写清"这是用户那台机器"。 */
export function toolDefs(): Array<{ name: string; description: string; inputSchema: any }> {
  return [
    {
      name: 'local_read',
      description: '读用户本机上的文件。**一次可以给多个路径**（每多一次调用就多一个往返，'
        + '所以要读三个文件就一次给三个）。相对路径相对这条会话的工作目录。',
      inputSchema: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' }, description: '文件路径，可多个' } },
        required: ['paths'],
      },
    },
    {
      name: 'local_write',
      description: '写用户本机上的文件（会创建缺失的目录）。整份覆盖 —— 改一小块也要给完整内容。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'local_glob',
      description: '在用户本机上按通配符找文件（在本地跑完，只回结果）。例如 `src/**/*.ts`。',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' }, dir: { type: 'string', description: '起始目录，默认工作目录' } },
        required: ['pattern'],
      },
    },
    {
      name: 'local_grep',
      description: '在用户本机上搜内容（ripgrep，没有就退回 grep -rn）。在本地跑完，只回匹配行。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          dir: { type: 'string' },
          glob: { type: 'string', description: '只搜匹配这个通配符的文件' },
        },
        required: ['query'],
      },
    },
    {
      name: 'local_git',
      description: '在用户本机的仓库上跑 git（只读子命令：status/diff/log/show/branch/rev-parse/ls-files）。',
      inputSchema: {
        type: 'object',
        properties: { args: { type: 'array', items: { type: 'string' } } },
        required: ['args'],
      },
    },
    {
      name: 'local_bash',
      description: '在用户本机上跑一条 shell 命令（cwd = 这条会话的工作目录）。'
        + '构建、测试、git 提交这类事都在这里做 —— 你所在的那台远端机器上没有用户的文件。',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeoutMs: { type: 'number', description: `默认 ${BASH_TIMEOUT_MS}` },
        },
        required: ['command'],
      },
    },
  ];
}

/** `local_git` 允许的子命令 —— 写操作走 `local_bash`（那条路是你明确要的，留痕即可）。 */
export const GIT_READONLY = ['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame'];

function clip(s: string, max = MAX_OUTPUT_BYTES): string {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= max) return s;
  return `${b.subarray(0, max).toString('utf8')}\n…（输出被截断：共 ${b.length} 字节，上限 ${max}）`;
}

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: clip(t) }], isError: isError || undefined };
}

/**
 * 跑一条命令。
 *
 * `spawnFailed` 是**单独一件事**：命令根本不存在时 `err.code` 是字符串（`ENOENT`），
 * 而原来那句 `typeof err.code === 'number' ? … : 1` 把它折成了退出码 1 ——
 * 于是 `local_grep` 把"这台机器上没装 ripgrep"读成了"没有匹配"，直接返回"（没有匹配）"
 * 而根本没去试 grep（单测里抓到的）。"没搜到"和"没法搜"必须分得开。
 */
function run(file: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string; spawnFailed?: boolean }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err: any, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        spawnFailed: !!err && typeof err.code === 'string',
        out: `${String(stdout || '')}${stderr ? `\n[stderr]\n${stderr}` : ''}`,
      }));
  });
}

/** 把工具调用真的执行掉。`session` 决定工作目录。 */
export async function callTool(
  name: string,
  args: any,
  session: LocalMcpSession,
  deps: LocalMcpDeps,
): Promise<ToolResult> {
  const cwd = session.workdir;
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(cwd, p));
  switch (name) {
    case 'local_read': {
      const paths: string[] = Array.isArray(args?.paths) ? args.paths : [args?.path].filter(Boolean);
      if (!paths.length) return text('local_read 需要 paths', true);
      const parts: string[] = [];
      for (const p of paths) {
        const f = abs(String(p));
        try {
          const st = fs.statSync(f);
          if (st.isDirectory()) { parts.push(`=== ${f} ===\n（这是一个目录，用 local_glob）`); continue; }
          const buf = fs.readFileSync(f);
          /* 截断的说明放在**开头**：放结尾的话它会被总输出的截断切掉，
             而"没有说明的半个文件"比拿不到文件更危险（它会照着残缺内容改代码）。 */
          const cut = buf.length > MAX_READ_BYTES;
          const head = cut ? `=== ${f} ===（**只有前 ${MAX_READ_BYTES} 字节，全文 ${buf.length} 字节** —— 需要后面的部分就用 local_bash 里的 sed/awk 取）` : `=== ${f} ===`;
          parts.push(`${head}\n${(cut ? buf.subarray(0, MAX_READ_BYTES) : buf).toString('utf8')}`);
        } catch (err: any) {
          parts.push(`=== ${f} ===\n（读不到：${err?.message || err}）`);
        }
      }
      return text(parts.join('\n\n'));
    }
    case 'local_write': {
      const f = abs(String(args?.path || ''));
      if (!args?.path) return text('local_write 需要 path', true);
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, String(args?.content ?? ''));
      } catch (err: any) {
        return text(`写不进去：${err?.message || err}`, true);
      }
      deps.notice(session.sessionId, `📝 远端那条会话改了你本机的 \`${f}\`。`);
      deps.log('info', `local_write ${f} sessionId=${session.sessionId}`);
      return text(`已写入 ${f}（${Buffer.byteLength(String(args?.content ?? ''))} 字节）`);
    }
    case 'local_glob': {
      const dir = args?.dir ? abs(String(args.dir)) : cwd;
      const pattern = String(args?.pattern || '*');
      // `find` 一定在；`-path` 能表达 `src/**/*.ts` 这种写法
      // （这里用行注释：`**/*` 里的 `*/` 会把块注释提前关掉 —— 那一下让 tsc 失败、dev:main 起不来）
      const spec = pattern.includes('/') ? ['-path', `*${pattern.replace(/\*\*/g, '*')}`] : ['-name', pattern];
      const r = await run('find', [dir, '-type', 'f', ...spec, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'], cwd, 30_000);
      return text(r.out.trim() || '（没有匹配的文件）');
    }
    case 'local_grep': {
      const dir = args?.dir ? abs(String(args.dir)) : cwd;
      const q = String(args?.query || '');
      if (!q) return text('local_grep 需要 query', true);
      const rg = await run('rg', ['-n', '--no-heading', ...(args?.glob ? ['-g', String(args.glob)] : []), '--', q, dir], cwd, 60_000);
      /* `spawnFailed` = 没装 ripgrep（不是"没搜到"）—— 那就退回 grep，见 `run` 那段 */
      if (!rg.spawnFailed && (rg.code === 0 || rg.code === 1)) return text(rg.out.trim() || '（没有匹配）');
      const g = await run('grep', ['-rn', '--exclude-dir=node_modules', '--exclude-dir=.git', '--', q, dir], cwd, 60_000);
      return text(g.out.trim() || '（没有匹配）');
    }
    case 'local_git': {
      const argv: string[] = Array.isArray(args?.args) ? args.args.map(String) : [];
      if (!argv.length) return text('local_git 需要 args', true);
      if (!GIT_READONLY.includes(argv[0])) {
        return text(`local_git 只跑只读子命令（${GIT_READONLY.join('/')}）。要提交、切分支这类事用 local_bash —— `
          + '那条路会在用户的会话里留痕。', true);
      }
      const r = await run('git', argv, cwd, 60_000);
      return text(r.out.trim() || '（没有输出）');
    }
    case 'local_bash': {
      const command = String(args?.command || '');
      if (!command) return text('local_bash 需要 command', true);
      const timeoutMs = Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : BASH_TIMEOUT_MS;
      /* 留痕：跑在**你**机器上的命令，你必须看得见（截断到一行长度，全文在日志里） */
      deps.notice(session.sessionId, `⌨️ 远端那条会话在你本机跑了：\`${command.replace(/\s+/g, ' ').slice(0, 120)}\``);
      deps.log('info', `local_bash sessionId=${session.sessionId} cwd=${cwd} cmd=${command.replace(/\s+/g, ' ').slice(0, 400)}`);
      const r = await run('bash', ['-lc', command], cwd, timeoutMs);
      return text(`[exit ${r.code}]\n${r.out.trim()}`);
    }
    default:
      return text(`没有这个工具：${name}`, true);
  }
}

/* ------------------------------------------------------------- JSON-RPC */

/** 处理一条 JSON-RPC 消息。返回 `null` = 这是通知，不该回包。 */
export async function handleRpc(
  msg: any,
  session: LocalMcpSession,
  deps: LocalMcpDeps,
): Promise<any | null> {
  const id = msg?.id;
  const reply = (result: any): any => ({ jsonrpc: '2.0', id, result });
  switch (msg?.method) {
    case 'initialize':
      return reply({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'kirolex-local', version: '1' },
      });
    /* 通知没有 id，绝不能回包 —— 回了会被当成协议错误 */
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'tools/list':
      return reply({ tools: toolDefs() });
    case 'tools/call': {
      const r = await callTool(String(msg?.params?.name || ''), msg?.params?.arguments || {}, session, deps);
      return reply(r);
    }
    case 'ping':
      return reply({});
    default:
      if (id === undefined) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${msg?.method}` } };
  }
}

/* --------------------------------------------- 把本机的 MCP 转发给远端会话 */

/**
 * **本机那些 MCP 也该给远端用** ——「那操作本地的 playwright 和 compute use 呢」。
 *
 * 问题：远程会话的 agent 里如果有 `playwright`，它跑的是**远端**那台机器的浏览器（没有显示器、
 * 也不是你在看的那个）。而你要的显然是"点我这台机器上的浏览器"。
 *
 * 做法和 `local_*` 完全一样，只是多一层：那些 MCP 是 **stdio** 的，所以 KiroLex 在本机把它们
 * 起起来，然后在同一个 HTTP 端点上多开一个路径 `/mcp/<token>/<名字>`，把 JSON-RPC 原样转发。
 * 远端的 kiro-cli 看到的就是一个普通的 HTTP MCP server，而它的工具（`browser_click`…）
 * 落在**你的**机器上执行。
 *
 * 为什么是"原样转发"而不是自己包一层工具：那些 server 的工具清单、schema、行为都由它们自己说，
 * 包一层就等于要跟着它们的版本走 —— 而转发连它们的 `initialize` 响应都不用看懂。
 */
export interface ProxySpec {
  /** MCP 的名字（远端 agent 配置里也用这个名字）。 */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** 一个被代理的 stdio MCP：懒启动、按 id 配对、会话结束时杀掉。 */
class StdioProxy {
  private spec: ProxySpec;
  private log: LocalMcpDeps['log'];
  private child: ChildProcess | null = null;
  private buf = '';
  private pending = new Map<string | number, (msg: any) => void>();

  constructor(spec: ProxySpec, log: LocalMcpDeps['log']) {
    this.spec = spec;
    this.log = log;
  }

  private ensure(): ChildProcess {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child;
    /*
      **懒启动**：这些 server 很重（playwright 会拉起一个浏览器），没人调就不该起。
      `env` 合并进当前环境：那些 server 常常靠 PATH / HOME 找自己的东西。
    */
    const child = spawn(this.spec.command, this.spec.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.spec.env || {}) },
    });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => {
      this.buf += d.toString('utf-8');
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        /* 对不上 id 的是它主动推的通知 —— 我们没有地方送，丢掉（不能当成某个请求的答复） */
        const resolve = msg?.id !== undefined ? this.pending.get(msg.id) : undefined;
        if (resolve) { this.pending.delete(msg.id); resolve(msg); }
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      const t = d.toString('utf-8').trim();
      if (t) this.log('info', `[${this.spec.name}] ${t.slice(0, 300)}`);
    });
    child.on('close', (code) => {
      this.log('warn', `[${this.spec.name}] 退了（code ${code}）—— 下一次调用会重新起它`);
      for (const [, r] of this.pending) r({ jsonrpc: '2.0', error: { code: -32000, message: `${this.spec.name} 退出了（code ${code}）` } });
      this.pending.clear();
      this.child = null;
      this.buf = '';
    });
    this.log('info', `[${this.spec.name}] 起在本机：${this.spec.command} ${(this.spec.args || []).join(' ')}`);
    return child;
  }

  /** 转发一条 JSON-RPC。通知（没有 id）不等回复。 */
  call(msg: any, timeoutMs = PROXY_TIMEOUT_MS): Promise<any | null> {
    const child = this.ensure();
    const line = `${JSON.stringify(msg)}\n`;
    if (msg?.id === undefined) {
      try { child.stdin?.write(line); } catch { /* 它刚退了；下一次调用会重起 */ }
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(msg.id)) return;
        this.pending.delete(msg.id);
        resolve({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `${this.spec.name} 超时（${timeoutMs}ms 没回）` } });
      }, timeoutMs);
      this.pending.set(msg.id, (answer) => { clearTimeout(timer); resolve(answer); });
      try { child.stdin?.write(line); } catch {
        clearTimeout(timer);
        this.pending.delete(msg.id);
        resolve({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `写不进 ${this.spec.name} 的 stdin` } });
      }
    });
  }

  stop(): void {
    const c = this.child;
    this.child = null;
    try { c?.stdin?.end(); } catch {}
    try { c?.kill(); } catch {}
  }
}

/**
 * 被代理的 MCP 一次调用的上限。
 *
 * 比 `local_bash` 宽得多：`browser_navigate` 要等页面加载、`browser_click` 可能触发跳转，
 * 而超时在这里的代价是"远端以为这个工具坏了"。
 */
export const PROXY_TIMEOUT_MS = 180_000;

/* ------------------------------------------------------------ HTTP 服务 */

export interface LocalMcpServer {
  /** 实际监听的本地端口（只在 127.0.0.1 上）。 */
  port(): number;
  /**
   * 这条会话要转发哪些本机 MCP。每个会一个 `/mcp/<token>/<名字>` 端点。
   * 重复调用会把上一批停掉 —— 换 agent 时转发的集合可能变。
   */
  setProxies(sessionId: string, specs: ProxySpec[]): void;
  /** 登记一条会话，拿到它的 token（URL 里用）。 */
  register(session: LocalMcpSession): string;
  /** 会话没了就作废它的 token。 */
  forget(sessionId: string): void;
  urlPathFor(sessionId: string): string | undefined;
  stop(): void;
}

/** token → 会话。token 一条会话一个，会话结束即失效。 */
export function newToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function startLocalMcp(deps: LocalMcpDeps, port = 0): Promise<LocalMcpServer> {
  const sessions = new Map<string, LocalMcpSession>();   // token -> session
  /** `<sessionId>\0<名字>` -> 那个被代理的本机 MCP。 */
  const proxies = new Map<string, StdioProxy>();
  const stopProxies = (sessionId: string): void => {
    for (const [k, v] of proxies) {
      if (k.startsWith(`${sessionId}\u0000`)) { v.stop(); proxies.delete(k); }
    }
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    /* `/mcp/<token>` = KiroLex 自己那组工具；`/mcp/<token>/<名字>` = 转发本机那个 MCP */
    const m = /^\/mcp\/([0-9a-f]{32})(?:\/([\w.-]{1,40}))?$/.exec(url.pathname);
    if (!m || !sessions.has(m[1])) {
      /* 不说为什么：能敲到这个端口的东西不该从错误消息里学到 token 的形状 */
      res.writeHead(404).end();
      return;
    }
    const session = sessions.get(m[1])!;
    const proxyName = m[2];
    const proxy = proxyName ? proxies.get(`${session.sessionId}\u0000${proxyName}`) : undefined;
    if (proxyName && !proxy) { res.writeHead(404).end(); return; }
    if (req.method === 'GET') {
      /* 有些客户端会开一条 SSE 通道等服务端主动推。我们没有要推的东西，但也不能报错 —— 挂着即可。 */
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': ok\n\n');
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 8 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      let msg: any;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } }));
        return;
      }
      try {
        /* 转发的那些：**原样**送进本机那个 server，把它的答复原样送回 —— 中间不解释语义 */
        const route = (one: any): Promise<any | null> => (proxy ? proxy.call(one) : handleRpc(one, session, deps));
        const out = Array.isArray(msg)
          ? (await Promise.all(msg.map(route))).filter(Boolean)
          : await route(msg);
        if (out === null || (Array.isArray(out) && out.length === 0)) { res.writeHead(202).end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      } catch (err: any) {
        deps.log('warn', `local mcp 调用失败：${err?.message || err}`);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(err?.message || err) },
        }));
      }
    });
  });
  return new Promise((resolve) => {
    /* **只听 127.0.0.1** —— 这是整条通道的第一道边界：外面进不来，只有反向隧道能进 */
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      deps.log('info', `local mcp 起在 127.0.0.1:${actual}`);
      resolve({
        port: () => actual,
        register(session) {
          for (const [t, s] of sessions) if (s.sessionId === session.sessionId) sessions.delete(t);
          const token = newToken();
          sessions.set(token, session);
          return token;
        },
        setProxies(sessionId, specs) {
          stopProxies(sessionId);
          for (const spec of specs) {
            if (!spec?.name || !spec?.command) continue;
            proxies.set(`${sessionId}\u0000${spec.name}`, new StdioProxy(spec, deps.log));
          }
        },
        forget(sessionId) {
          for (const [t, s] of sessions) if (s.sessionId === sessionId) sessions.delete(t);
          /* 会话没了，那个浏览器也不该继续开着 */
          stopProxies(sessionId);
        },
        urlPathFor(sessionId) {
          for (const [t, s] of sessions) if (s.sessionId === sessionId) return `/mcp/${t}`;
          return undefined;
        },
        stop() {
          for (const [, v] of proxies) v.stop();
          proxies.clear();
          try { server.close(); } catch {}
        },
      });
    });
  });
}
