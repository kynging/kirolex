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
 * 生成那条会话专用的 agent JSON。
 *
 * **按白名单挑字段，不是整份拷过去** ——「你把远程 kiro 的那些 agent 啥的清理一下，
 * 包括 mcp 啥的应该都不需要了」。
 *
 * 带过去的只有"让这条会话像你选的那个 agent"所必需的东西：`prompt` / `tools` / `allowedTools`
 * （以及 `model`，如果那个 agent 钉了一个）。**刻意丢掉**的是：
 *
 *   · `mcpServers` —— 本机那些 MCP 的命令是本机路径（`/opt/homebrew/bin/node`、
 *     `~/.local/bin/mcp-proxy-for-aws`…），在远端**不存在**。拷过去不是"多一点工具"，
 *     而是 kiro-cli 静默少掉这些工具（它不报错）。真要用本机的 MCP，正确做法是把它**转发**过去
 *     （和 `local_*` 走同一条反向隧道），那是另一件事。
 *   · `resources` / `hooks` —— 同理：`file:///Users/...` 在远端打不开，实测每次启动都打
 *     `File URI not found`。
 *   · `includeMcpJson` / `useLegacyMcpJson` —— 它们会把**远端那台机器**的全局 mcp.json 拉进来，
 *     那是一组你没选过的工具。
 *
 * 结果是这份配置**只由 KiroLex 说了算**：一条 `kirolex-local` 加上你选的那个 agent 的人格。
 * 以后要给远端配一些和本地不一样的东西时，那也应该是显式的一份远端配置，而不是靠拷本机的。
 *
 * `tools`：kiro-cli 的 `tools` 是**白名单**，而且**缺这个字段等于一个都不给**（实测：
 * 不写它的时候远端那条会话回的是"我手上没有任何可调用的工具"，连 fs_read 都没有，
 * 而隧道其实是通的）。所以 base 没写时要显式写 `["*"]`。
 */
export function buildSessionAgent(base: any, opts: { name: string; url: string }): any {
  const src = (base && typeof base === 'object') ? base : {};
  const entry = `@${MCP_SERVER_NAME}`;
  const out: any = {
    name: opts.name,
    description: typeof src.description === 'string' && src.description
      ? src.description
      : 'KiroLex：这条远程会话 + 用户本机的工具',
    /* 这条会话专用的本地工具 —— 唯一一条 MCP */
    mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: opts.url } },
  };
  if (typeof src.prompt === 'string' && src.prompt.trim()) out.prompt = src.prompt;
  if (typeof src.model === 'string' && src.model.trim()) out.model = src.model;
  out.tools = (Array.isArray(src.tools) && !src.tools.includes('*'))
    ? [...src.tools.filter((t: any) => typeof t === 'string' && !t.startsWith('@')), entry]
    : ['*'];
  /* 本机工具**不要每次都问一遍**：这条通道是你明确开的，而一轮里它可能调十几次 ——
     每次弹一个确认框的话这个功能没法用。留痕在会话状态行上（`localMcp` 里每次写/跑都报）。 */
  out.allowedTools = [
    ...(Array.isArray(src.allowedTools)
      ? src.allowedTools.filter((t: any) => typeof t === 'string' && !t.startsWith('@'))
      : []),
    entry,
  ];
  return out;
}

/** 在远端写下这份 agent（内容走 stdin —— 命令行里塞 JSON 是自找的引号地狱）。 */
export function writeAgentScript(name: string): string {
  return `mkdir -p ~/.kiro/agents && cat > ~/.kiro/agents/${name}.json`;
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
export function localToolsHelp(localDir: string): string {
  return `· **用户的文件在他自己那台机器上，不在这里。** 你有一组直连他机器的工具`
    + `（\`local_read\` / \`local_write\` / \`local_glob\` / \`local_grep\` / \`local_git\` / \`local_bash\`）——`
    + `工作目录是 \`${localDir}\`（那是**他机器上**的路径）。`
    + `读文件、改文件、跑构建和测试都用这些工具，不要在这台机器上找他的项目。`
    + `每次往返大约 200 毫秒，所以 \`local_read\` 一次把要读的文件都给上，别一个一个读。`;
}
