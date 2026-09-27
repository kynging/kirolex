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

/**
 * 那条会话专用 agent 的名字前缀。
 *
 * 单独拿出来是因为 agent 列表要**按它过滤**：这些是 KiroLex 每条远程会话私有的配置
 * （URL 里带着那条会话的 token），出现在下拉里的话，选中它等于把两条会话的工具通道接到一起。
 */
export const SESSION_AGENT_PREFIX = 'kirolex-local-';

/** 那条会话专用 agent 的名字。 */
export function sessionAgentName(sessionId: string): string {
  return `${SESSION_AGENT_PREFIX}${String(sessionId).replace(/[^\w.-]+/g, '_').slice(-24)}`;
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
 * **扫掉远端的孤儿执行器进程** ——「为什么会打爆远程机器，这个 bug 应该修一下」。
 *
 * ## 它是怎么打爆的（实测）
 *
 * 那台 t3.medium 从 2026-09-25 17:26 UTC 起 CPU 钉在 96%+ 再没下来，`NetworkOut` 恒为 0，
 * 而 `VolumeReadOps` 是 **46,240/小时**、写只有 1.17 —— 只读不写的死循环。最后 sshd 都排不到
 * CPU，ssh 停在 banner 交换（TCP 握手成功、用户态永远没机会回那句 banner），SSM Agent 同样饿死，
 * 只能从 EC2 API 强制 stop/start 才救回来。CPU 是 `unlimited` 模式，所以没有任何限流兜底。
 *
 * 源头是**孤儿累积**：远端的 `kiro-cli acp` 不跟着 ssh 退出（无 PTY、也不在 stdin EOF 时退），
 * 而 KiroLex 被 SIGKILL / 崩溃 / 拔电结束时，`disconnect()` 里那条 `kill -TERM <远端 PID>` 和
 * `before-quit` 都不会跑。之前在那台机器上一次清出 **85 个**，最老的 2 天 23 小时 ——
 * 每条会话是 2 个进程（`kiro-cli` + `kiro-cli-chat`），也就是 40 多条会话的残留在同时扫盘。
 *
 * ## 判据：PPID == 1
 *
 * 活着的执行器一定挂在它那条 sshd 底下（实测 PPID = 11933 / 12181 …）；ssh 一死，它被
 * reparent 到 **PID 1**。所以"PPID 是 1 且命令行里带我们的 agent 前缀"就是精确的孤儿特征 ——
 * 不用靠 etime 猜，也不可能误杀一个正在服务的执行器（那个有 sshd 父进程）。
 *
 * 连同 `kirolex-local-` 前缀一起判：这台机器上可能还有别人手动起的 kiro-cli，那不是我们的事。
 */
export function orphanSweepScript(): string {
  /* `ps -eo ppid=,pid=,args=`：只看 PPID 为 1、且 args 里带我们前缀的那些 */
  return [
    `ps -eo ppid=,pid=,args= | awk '$1==1 && index($0, "${SESSION_AGENT_PREFIX}")>0 {print $2}'`,
    '> /tmp/.kirolex-orphans || true',
    '; n=$(wc -l < /tmp/.kirolex-orphans | tr -d " ")',
    '; [ "$n" -gt 0 ] && xargs -r kill -TERM < /tmp/.kirolex-orphans 2>/dev/null',
    '; rm -f /tmp/.kirolex-orphans',
    '; echo "KIROLEX_ORPHANS ${n:-0}"',
  ].join(' ');
}

/** `orphanSweepScript` 的输出里那个数字。认不出来返回 0 —— 清垃圾的统计不值得抛错。 */
export function parseOrphanSweep(out: string): number {
  const m = /KIROLEX_ORPHANS\s+(\d+)/.exec(String(out || ''));
  return m ? Number(m[1]) : 0;
}

/** 扫掉多久没动过的会话 agent 才算孤儿。 */
export const STALE_AGENT_MINUTES = 12 * 60;

/**
 * **扫掉上一次留下的会话 agent** ——「清理远程 agent 你清了没有」。
 *
 * 正常断开会删掉自己那一份（`removeAgentScript`），`before-quit` 也补一遍。但 KiroLex 被**硬杀**时
 * （崩溃、`pkill`、拔电）两条都不走，于是 `kirolex-local-<会话>.json` 全留在远端。它们不只是垃圾：
 * 每一份里带着**那一次**的隧道端口和 token，而端口每次启动都换 —— 留下的是一份指向死端口的配置。
 *
 * 判据是**多久没动过**，不是"谁还活着"：
 *
 * · 活着的那些每次起执行器都会被重写，所以永远是新的；孤儿只会越来越旧（进程那边实测过
 *   同一个形状：那台机器上攒了 85 个孤儿 kiro-cli，最老的 2 天 23 小时）。
 * · 不用"活着的名单"是因为它在启动早期是**空的**（执行器还没起来）—— 那时按名单删等于
 *   把所有配置都删掉；而按"现在没有远程会话"就跳过，又会让孤儿永远留着。
 * · 不拿本机的时钟去比：`-mmin` 是相对**远端自己**的 now，跨机器的时钟偏移进不来。
 * · 12 小时这个阈值留给"另一个 KiroLex 正开着"的情况：它那些文件也在被不断重写，所以不会被误删。
 */
export function sweepAgentsScript(minutes = STALE_AGENT_MINUTES): string {
  return `find ~/.kiro/agents -maxdepth 1 -name '${SESSION_AGENT_PREFIX}*.json'`
    + ` -mmin +${Math.max(1, Math.floor(minutes))} -print -delete 2>/dev/null | wc -l`;
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
    + `**他项目里的**文件要读要改就用这些工具，别在这台机器上找他的项目（这里没有副本）。`
    + `注意这不等于"什么都回他机器上做" —— 默认仍然在你这台机器上干活，见下面那条。`
    + `每次往返大约 200 毫秒，所以 \`local_read\` 一次把要读的文件都给上，别一个一个读。`;
}
