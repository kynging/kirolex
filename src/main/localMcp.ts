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
  /** 主目录 —— 相对路径和 `local_bash` 的 cwd 以它为准。 */
  workdir: string;
  /**
   * **这条会话能动的所有目录**（含 `workdir`，它排第一）——「会话目录应该可以设置多个」。
   *
   * 只影响 `local_glob` / `local_grep` 不指定 `dir` 时搜哪儿：搜**全部**，而不是只搜主目录。
   * 一个目录的时候这件事看不出来；多目录之后"在我的项目里找 X"会静默漏掉后面几棵树 ——
   * 而"搜了没搜到"和"根本没搜那儿"在回复里长得一模一样。
   *
   * 不填 / 空数组等于 `[workdir]`。这**不是**权限边界（绝对路径照样能读，见文件头「边界」）。
   */
  dirs?: string[];
}

/* ------------------------------------------- Windows：没有 find / grep 时自己走 */

/** 走目录树时一律跳过的那些 —— 和 `find` 那条命令里的 `-not -path` 对齐。 */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** 一次遍历最多看多少个文件。没有上限的话一棵大树能把主进程卡住几十秒。 */
export const NATIVE_WALK_LIMIT = 20_000;

/** 递归列文件（相对/绝对都行，返回绝对路径）。 */
export function walkFiles(roots: string[], limit = NATIVE_WALK_LIMIT): string[] {
  const out: string[] = [];
  const stack = [...roots];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        out.push(path.join(dir, e.name));
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

/**
 * 把 `*.ts` 这种 glob 变成一个正则（也支持带目录的，例如 `src` 下所有 `.ts`）。
 *
 * 这段说明刻意不写出那个双星加斜杠的形状 —— 它里面的 `*` 加 `/` 会把块注释**提前关掉**
 * （这个文件里 `local_glob` 那儿已经因为同一件事栽过一次）。
 *
 * 只支持 `*` 和 `**`（那是这个工具面里实际会用到的）。`*` 不跨分隔符、`**` 跨 ——
 * 和 `find -path` 那条命令的行为对齐。分隔符两种都认：Windows 上路径是 `\`,
 * 而模型写出来的 pattern 几乎总是 `/`。
 */
export function globToRegExp(pattern: string): RegExp {
  const esc = (t: string): string => t.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  /** 分隔符：两种都认（Windows 上路径是反斜杠，而 pattern 几乎总是正斜杠）。 */
  const SEP = '[\\\\/]';
  const isSep = (c?: string): boolean => c === '/' || c === '\\';
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    /*
      **`/**\/` 当成一个整体：零个或多个目录** —— 实测错过一次。
      分开处理（分隔符 → 双星 → 分隔符）会让前后那两个分隔符都变成必需的，于是
      `src` + 双星 + `/*.ts` 只命中 `src/sub/a.ts`，**漏掉 `src/a.ts`** ——
      而 glob 的通例是"零个或多个"。表现是"明明有这个文件，搜不到"，
      那是这个工具最不该有的失败。
    */
    if (isSep(c) && pattern[i + 1] === '*' && pattern[i + 2] === '*' && isSep(pattern[i + 3])) {
      out += `${SEP}(?:.*${SEP})?`;
      i += 3;
      continue;
    }
    if (c === '*' && pattern[i + 1] === '*') { out += '.*'; i += 1; continue; }
    if (c === '*') { out += `[^\\\\/]*`; continue; }
    if (c === '?') { out += `[^\\\\/]`; continue; }
    if (isSep(c)) { out += SEP; continue; }
    out += esc(c);
  }
  // 不带分隔符的 pattern 只匹配文件名（`*.ts`）；带分隔符的匹配路径尾部
  return new RegExp(`${/[\\/]/.test(pattern) ? SEP : '^'}${out}$`);
}

/** `local_glob` 的 Windows 实现。 */
export function globNative(roots: string[], pattern: string): string[] {
  const re = globToRegExp(pattern);
  const hasSep = /[\\/]/.test(pattern);
  return walkFiles(roots).filter((f) => re.test(hasSep ? f : path.basename(f)));
}

/**
 * `local_grep` 的 Windows 兜底（ripgrep 不在时）。
 *
 * 输出格式对齐 `grep -rn`：`路径:行号:内容`。二进制文件跳过（有 NUL 就当二进制）——
 * 不跳的话一个 .png 能吐出几千行乱码，把这一轮的上下文吃光。
 */
export function grepNative(roots: string[], query: string, glob?: string, maxHits = 500): string[] {
  const re = glob ? globToRegExp(glob) : null;
  const hasSep = glob ? /[\\/]/.test(glob) : false;
  const out: string[] = [];
  for (const f of walkFiles(roots)) {
    if (re && !re.test(hasSep ? f : path.basename(f))) continue;
    let body: string;
    try {
      const buf = fs.readFileSync(f);
      if (buf.includes(0)) continue;                 // 二进制
      body = buf.toString('utf-8');
    } catch { continue; }
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes(query)) continue;
      out.push(`${f}:${i + 1}:${lines[i]}`);
      if (out.length >= maxHits) return out;
    }
  }
  return out;
}

/** 这条会话默认搜索的那几棵树（至少一个：主目录）。 */
export function sessionRoots(session: LocalMcpSession): string[] {
  const list = (session.dirs || []).filter((d) => typeof d === 'string' && d.trim());
  return list.length ? list : [session.workdir];
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
      description: '在用户本机上按通配符找文件（在本地跑完，只回结果）。例如 `src/**/*.ts`。'
        + '不给 `dir` 就搜这条会话的**全部**目录。',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' }, dir: { type: 'string', description: '起始目录；不给则搜会话的所有目录' } },
        required: ['pattern'],
      },
    },
    {
      name: 'local_grep',
      description: '在用户本机上搜内容（ripgrep，没有就退回 grep -rn）。在本地跑完，只回匹配行。'
        + '不给 `dir` 就搜这条会话的**全部**目录。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          dir: { type: 'string', description: '不给则搜会话的所有目录' },
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
      /* 不指定目录 = 搜全部。`find` 本来就收多个起点，所以多目录仍然是**一次**调用
         —— 184ms 的往返下，"每个目录搜一次"会把粒度打回镜像那版的形状。 */
      const roots = args?.dir ? [abs(String(args.dir))] : sessionRoots(session);
      const pattern = String(args?.pattern || '*');
      // `find` 一定在；`-path` 能表达 `src/**/*.ts` 这种写法
      // （这里用行注释：`**/*` 里的 `*/` 会把块注释提前关掉 —— 那一下让 tsc 失败、dev:main 起不来）
      /*
        **Windows 上没有 `find`** ——「看一下有没有 windows 上不能跑的东西」→「都修」。
        这些工具跑在**用户那台机器**上（远端通过反向隧道调过来），所以 Windows 用户一开
        远程会话就会碰到：`local_glob` / `local_grep` / `local_bash` 全都是 ENOENT,
        而模型会把"工具报错"解释成"这个东西不存在"。
        用 Node 自己走一遍目录树，行为和那条 `find` 对齐（含 node_modules / .git 的排除）。
      */
      if (process.platform === 'win32') {
        const hits = globNative(roots, pattern);
        return text(hits.length ? hits.join('\n') : '（没有匹配的文件）');
      }
      const spec = pattern.includes('/') ? ['-path', `*${pattern.replace(/\*\*/g, '*')}`] : ['-name', pattern];
      const r = await run('find', [...roots, '-type', 'f', ...spec, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'], cwd, 30_000);
      return text(r.out.trim() || '（没有匹配的文件）');
    }
    case 'local_grep': {
      const roots = args?.dir ? [abs(String(args.dir))] : sessionRoots(session);
      const q = String(args?.query || '');
      if (!q) return text('local_grep 需要 query', true);
      const rg = await run('rg', ['-n', '--no-heading', ...(args?.glob ? ['-g', String(args.glob)] : []), '--', q, ...roots], cwd, 60_000);
      /* `spawnFailed` = 没装 ripgrep（不是"没搜到"）—— 那就退回 grep，见 `run` 那段 */
      if (!rg.spawnFailed && (rg.code === 0 || rg.code === 1)) return text(rg.out.trim() || '（没有匹配）');
      /*
        ripgrep 没有时的兜底。Windows 上没有 `grep`，所以那边用 Node 自己搜 ——
        慢一些，但"慢"和"这个工具根本不工作"不是一个量级的问题。
      */
      if (process.platform === 'win32') {
        const hits = grepNative(roots, q, args?.glob ? String(args.glob) : undefined);
        return text(hits.length ? hits.join('\n') : '（没有匹配）');
      }
      const g = await run('grep', ['-rn', '--exclude-dir=node_modules', '--exclude-dir=.git', '--', q, ...roots], cwd, 60_000);
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
      /*
        **Windows 上没有 `bash`** —— 换成 `%ComSpec% /d /s /c`（`loopVerify.ts` 里
        已经是这个写法，这里跟它一致）。注意这意味着模型写的命令要是 **cmd 语法**:
        那件事在注入里说过（「运行环境」那段会说清这是哪台机器），而这里的替代方案是
        "这个工具完全不可用"，那更糟。
      */
      const r = process.platform === 'win32'
        ? await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], cwd, timeoutMs)
        : await run('bash', ['-lc', command], cwd, timeoutMs);
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
    /*
      **Windows 上 `npx` / `uvx` 是 `.cmd` shim，`spawn` 直接执行不了**
      ——「看一下有没有 windows 上不能跑的东西」。`spawn('npx', …)` 在 Windows 上
      得到 EINVAL / ENOENT，于是**所有转发过去的 MCP 都起不来**，
      而远端那边只会表现成"这个工具不存在"。

      判据：Windows + 命令不是一个带后缀的可执行文件（`.exe`/`.com`）→ 走 shell。
      走 shell 时命令要加引号（路径里有空格是常态：`C:\Program Files\…`）。
      非 Windows 一律不走 shell —— 那边不需要，而走 shell 会把参数里的特殊字符变成语法。
    */
    const winShim = process.platform === 'win32' && !/\.(exe|com)$/i.test(this.spec.command);
    const child = spawn(
      winShim ? `"${this.spec.command}"` : this.spec.command,
      this.spec.args || [],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(this.spec.env || {}) },
        shell: winShim,
        windowsHide: true,
      },
    );
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
