/**
 * **把本地工具接到远端那条会话上** —— `localMcp.ts` 的接线层。
 *
 * 远端的 kiro-cli 认 HTTP 的 MCP server（`kiro-cli mcp add --url`），而 ssh 本来就能开反向隧道，
 * 于是不用在那台机器上装任何东西：
 *
 * ```
 * ssh -R 127.0.0.1:<远端端口>:127.0.0.1:<本地端口>   ← 执行器本来就是 ssh 起的
 * 远端 agent JSON： { "type": "http", "url": "http://127.0.0.1:<远端端口>/mcp/<token>" }
 * ```
 *
 * ## 为什么 agent 配置必须**一条会话一份**
 *
 * token 在 URL 里（`mcp add` 没有 `--headers`，放不到 header），而 token 就是"你是哪条会话"——
 * 服务端靠它决定 cwd 是哪个目录。共用一份配置就等于共用一个 token，那服务端分不出是谁在调，
 * 于是它只能猜一个工作目录 —— 而猜错的表现是"它在另一个项目里改文件"。
 *
 * 所以这里为每条会话生成一个 `kirolex-local-<id>` agent：**拷你选的那个 agent**（它的 prompt、
 * 工具、别的 MCP 一个都不能少），只加上这一条 MCP。生成的文件只在远端，断开时删掉。
 *
 * kiro-cli 对 agent JSON 是**严格校验**的（实测：多一个 `permissions` 字段就整份拒绝，
 * 而拒绝之后它会**静默退回默认 agent**）。所以这里只碰 `mcpServers` / `name` / `tools`，
 * 别的字段原样抄过去。
 */

/** 远端那条 MCP 的名字。工具名在模型那边会显示成 `@kirolex-local/local_read` 这种形状。 */
export const MCP_SERVER_NAME = 'kirolex-local';

/** 反向隧道用的远端端口区间 —— 挑高位，避开远端自己的服务。 */
export const REMOTE_PORT_BASE = 39100;
export const REMOTE_PORT_SPAN = 400;

/**
 * 给这条会话挑一个远端端口。`used` 是**这台机器上**已经分出去的那些。
 *
 * 端口冲突不能靠运气：ssh 那边加了 `ExitOnForwardFailure=yes`，端口被占时执行器**起不来**
 * （而不是起来了却没有工具）—— 所以这里只要保证 KiroLex 自己不撞自己。
 */
export function allocateRemotePort(used: Iterable<number>): number {
  const taken = new Set(used);
  for (let i = 0; i < REMOTE_PORT_SPAN; i += 1) {
    const p = REMOTE_PORT_BASE + i;
    if (!taken.has(p)) return p;
  }
  throw new Error(`没有空闲的远端端口了（${REMOTE_PORT_BASE}–${REMOTE_PORT_BASE + REMOTE_PORT_SPAN}）。`);
}

/** 那条会话专用 agent 的名字。 */
export function sessionAgentName(sessionId: string): string {
  return `kirolex-local-${String(sessionId).replace(/[^\w.-]+/g, '_').slice(-24)}`;
}

/** 远端 MCP 的 URL（token 在路径里 —— 见文件头）。 */
export function mcpUrl(remotePort: number, urlPath: string): string {
  return `http://127.0.0.1:${remotePort}${urlPath}`;
}

/**
 * **那条会话专用 agent 是在远端拼出来的** ——「切换远程的时候，对面不会有同样的 agent 配置，
 * 这时候如果有同名的 agent 就用同名的，没有就切回默认的」。
 *
 * 上一版是拿**本机**那份定义内联过去。那是错的方向：你要的是"远端自己配一些和本地不一样的"，
 * 而本机那份里的 MCP 命令、`resources` 路径在远端根本不成立（实测：`/opt/homebrew/bin/node`
 * 不存在 → kiro-cli 静默少工具；`file:///Users/...` → 每次启动打 `File URI not found`）。
 *
 * 所以规则是**在远端解析**：
 *   · 远端有同名的 `<agent>.json` → 拿**它**做底子（它的 prompt / MCP / resources 都是那台机器上
 *     成立的东西），只并上这一条 `kirolex-local`。
 *   · 没有 → 用默认 agent（只有 `kirolex-local`），并且**在会话里说一句** ——
 *     悄悄换一个 agent 是这条路上最贵的静默失败（产出是另一个 agent 干的，界面一个字不说）。
 *
 * 合并动作只能在远端做（底子文件在那儿），所以这里返回一段脚本。参数走**环境变量**而不是拼进
 * 命令行：agent 名和 URL 都会进 shell，拼字符串迟早在引号上出事。程序里一个单引号都不用，
 * 这样它整段可以安全地待在 `'…'` 里。
 */
export function remoteAgentScript(
  sessionAgent: string,
  baseAgent: string | undefined,
  url: string,
  /** 额外要并进去的 MCP（从本机转发过来的那些）：名字 → 它在远端要敲的 URL。 */
  forwarded: Array<{ name: string; url: string }> = [],
): string {
  const program = [
    'import json, os',
    'h = os.path.expanduser("~/.kiro/agents")',
    'base = os.environ.get("KX_BASE", "")',
    'out = os.environ["KX_OUT"]',
    'url = os.environ["KX_URL"]',
    'name = "' + MCP_SERVER_NAME + '"',
    'tag = "@" + name',
    'src = {}',
    'found = ""',
    'if base:',
    '    try:',
    '        src = json.load(open(os.path.join(h, base + ".json")))',
    '        found = base',
    '    except Exception:',
    '        src = {}',
    'cfg = {"name": out, "description": "KiroLex: remote session + local tools"}',
    /* 远端那份自己的 MCP **要留着** —— 它们的命令在那台机器上是真的 */
    'cfg["mcpServers"] = dict(src.get("mcpServers") or {})',
    'cfg["mcpServers"][name] = {"type": "http", "url": url}',
    /* 从本机转发过来的那些（`/mcp/<token>/<名字>`）—— 和上面那条同一个形状 */
    'for fname, furl in json.loads(os.environ.get("KX_FWD", "{}")).items():',
    '    cfg["mcpServers"][fname] = {"type": "http", "url": furl}',
    'for k in ("prompt", "model", "resources", "hooks", "toolsSettings", "includeMcpJson", "useLegacyMcpJson"):',
    '    if k in src: cfg[k] = src[k]',
    'tools = src.get("tools")',
    'tags = [tag] + ["@" + k for k in json.loads(os.environ.get("KX_FWD", "{}")).keys()]',
    'if isinstance(tools, list):',
    /* 白名单里要有它们，否则"工具在但调不动"（而且失败是静默的） */
    '    cfg["tools"] = tools if "*" in tools else (tools + [t for t in tags if t not in tools])',
    'else:',
    /* 缺 `tools` 字段 = 一个工具都不给（实测：远端回"我手上没有任何可调用的工具"） */
    '    cfg["tools"] = ["*"]',
    'allowed = list(src.get("allowedTools") or [])',
    'cfg["allowedTools"] = allowed + [t for t in tags if t not in allowed]',
    'os.makedirs(h, exist_ok=True)',
    'open(os.path.join(h, out + ".json"), "w").write(json.dumps(cfg, indent=2))',
    'print("KX_AGENT " + (found or "default"))',
  ].join('\n');
  const fwd = JSON.stringify(Object.fromEntries(forwarded.map((f) => [f.name, f.url])));
  const env = `KX_OUT=${shq(sessionAgent)} KX_URL=${shq(url)} KX_BASE=${shq(baseAgent || '')} KX_FWD=${shq(fwd)}`;
  return `mkdir -p ~/.kiro/agents && ${env} python3 -c '${program}'`;
}

/** 解析上面那段脚本的输出：用的是哪个底子（`default` = 远端没有同名 agent）。 */
export function parseAgentBase(out: string): string {
  const m = /KX_AGENT\s+(\S+)/.exec(String(out || ''));
  return m ? m[1] : '';
}

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}


/** 断开时把它删掉 —— 不删的话远端会慢慢堆满每条会话的临时 agent。 */
export function removeAgentScript(name: string): string {
  return `rm -f ~/.kiro/agents/${name}.json`;
}

/**
 * 注入里那段说明。
 *
 * **必须说清"文件在用户那台机器上"**：不说的话它会拿远端的路径去找（那里什么都没有），
 * 而"找不到"会被它解释成"这个东西不存在"，然后基于错误结论往下做 —— 这是远程会话里
 * 最贵的一类错，之前已经踩过一次（`remoteContext`）。
 */
export function localToolsHelp(localDir: string | string[]): string {
  /* 多目录 ——「会话目录应该可以设置多个」。第一个是 cwd（相对路径和 `local_bash` 以它为准），
     其余也要**列出来**：不列的话它只会在第一个里找，然后把"没找到"当成"没有这个东西"。 */
  const dirs = (Array.isArray(localDir) ? localDir : [localDir]).filter((d) => String(d || '').trim());
  const primary = dirs[0] || '';
  const rest = dirs.slice(1);
  return `· **用户的文件在他自己那台机器上，不在这里。** 你有一组直连他机器的工具`
    + `（\`local_read\` / \`local_write\` / \`local_glob\` / \`local_git\` / \`local_grep\` / \`local_bash\`）——`
    + `工作目录是 \`${primary}\`（那是**他机器上**的路径）`
    + (rest.length
      ? `，这条会话还带着另外 ${rest.length} 个目录：${rest.map((d) => `\`${d}\``).join('、')}`
        + `（\`local_glob\` / \`local_grep\` 不指定目录时会把**这几棵树一起**搜掉）。`
      : '。')
    + `读文件、改文件、跑构建和测试都用这些工具，不要在这台机器上找他的项目。`
    + `每次往返大约 200 毫秒，所以 \`local_read\` 一次把要读的文件都给上，别一个一个读。`;
}
