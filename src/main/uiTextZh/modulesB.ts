/** 主进程各模块（第二组） 的中文文案。key 是英文原文（约定见 `src/main/uiText.ts`）。 */
export const ZH_MODULES_B: Record<string, string> = {
  // ── remoteAdapterProbe.ts ──
  '{engine}: adapter not installed ({bin}).': '{engine}：没装适配器（{bin}）。',
  '{engine}: adapter found, but there is no node to run it.': '{engine}：适配器在，但没有能跑它的 node。',
  '{engine}: ready.': '{engine}：可以用。',
  '{engine}: installed, but not signed in (no Bedrock / API key configured either).': '{engine}：装了，但还没登录（也没配 Bedrock / API key）。',
  '{host} is reachable.': '{host} 连得上。',
  'Kiro: {why}': 'Kiro：{why}',
  '{host} has no ACP adapter for {engine} ({bin}). Settings → 🖥 Machines → select this machine → "Install AI tools" will install it ({pkg}). You also need to have signed in to {engine} on that machine.':
    '{host} 上没有 {engine} 的 ACP 适配器（{bin}）。设置 → 🖥 机器 → 选中这台机器 →「安装 AI 工具」会装上它（{pkg}）；另外那台机器上要登录过 {engine}。',
  '{host} has the ACP adapter for {engine} installed ({entry}), but no node to run it: the login shell (bash -lc) has no node, and none was found under fnm / nvm / Volta / asdf either. The adapter belongs to {manager}; add this line to ~/.bash_profile (or ~/.profile) on that machine so the login shell sees it: {fix}':
    '{host} 上装了 {engine} 的 ACP 适配器（{entry}），但没有 node 能跑它：登录 shell（bash -lc）里没有 node，fnm / nvm / Volta / asdf 下也没找到。适配器归 {manager} 管；在那台机器的 ~/.bash_profile（没有就 ~/.profile）里加这一行，让登录 shell 看得到：{fix}',
  "The login shell on {host} can't find the {engine} adapter; started it with {manager}'s node directly.":
    '{host} 的登录 shell 找不到 {engine} 适配器，已直接用 {manager} 的 node 起。',
  "The node on that machine is managed by {manager}, which only adds itself to PATH in interactive shells, so `bash -lc` can't see it. To make the login shell see it, add this line to ~/.bash_profile (or ~/.profile) there: {fix}\nnode: {node}\nadapter: {entry}":
    '那台机器的 node 由 {manager} 管，它只在交互 shell 里加 PATH，所以 `bash -lc` 看不到。要让登录 shell 也看得到，在那台机器的 ~/.bash_profile（没有就 ~/.profile）里加这一行：{fix}\nnode：{node}\n适配器：{entry}',
  '⚠️ Claude Code on {host} is not signed in and has no Bedrock / API key configured, so messages will fail. Set it up under 🔑 Login at the bottom left of this session.':
    '⚠️ {host} 上的 Claude Code 还没登录，也没配 Bedrock / API key，发消息会失败。在这条会话左下角「🔑 登录」里配置。',
  '⚠️ Codex on {host} is not signed in and has no provider / API key configured, so messages will fail. Set it up under 🔑 Login at the bottom left of this session.':
    '⚠️ {host} 上的 Codex 还没登录，也没配 provider / API key，发消息会失败。在这条会话左下角「🔑 登录」里配置。',
  '✅ {engine} adapter on {host} starts the way sessions start it (bash -lc).': '✅ {host} 上的 {engine} 适配器按会话的启动方式（bash -lc）能起。',
  'it did not answer initialize within the time limit': '限定时间内没回 initialize',
  'it exited with code {code}': '它退出了，退出码 {code}',
  '⚠️ After installing, tried to start the {engine} adapter on {host} the way sessions do (bash -lc), and it did not start: {why}.{stderr}':
    '⚠️ 装完按会话的启动方式（bash -lc）在 {host} 上试起 {engine} 的适配器，没起来：{why}。{stderr}',
  // ── acp-client.ts ──
  "No kiro launch command is set for **this machine** yet. Open Settings → 🖥 Machines → 💻 This machine and click \"Auto-detect the three tools on this machine\", or enter a path by hand. Without this setting KiroLex won't guess a binary.":
    '还没有设置**本机**的 kiro 启动命令。打开 设置 → 🖥 机器 → 💻 本机，点「自动检测这台机器上的三个工具」，或者手填一个路径 —— 没有这个设置 KiroLex 不会去猜一个二进制。',
  "No kiro launch command is set for {host} yet. Open Settings → 🖥 Machines, select this machine and click \"Auto-detect the three tools on this machine\". Without this setting KiroLex won't guess the remote binary (a wrong guess shows up as \"it starts, but behaves oddly\").":
    '还没有设置 {host} 上的 kiro 启动命令。打开 设置 → 🖥 机器 → 选中这台机器，点「自动检测这台机器上的三个工具」——没有这个设置 KiroLex 不会去猜远端的二进制（猜错的表现是"起来了但行为不对"）。',
  "kiro-cli not found. Tried these:\n{candidates}\n\nEnter a path in Settings → 🖥 Machines → 💻 This machine, or set KIRO_CLI_PATH. (A bare name on PATH works too, it doesn't have to be an absolute path.)":
    'kiro-cli 找不到。试过这些：\n{candidates}\n\n在 设置 → 🖥 机器 → 💻 本机 里填一个路径，或者设 KIRO_CLI_PATH。（可以填 PATH 上的裸名字，不必是绝对路径。）',
  'The executor exited normally (code 0); KiroLex reconnects automatically.': '执行器正常退出了（code 0），会自动重连。',
  'This engine did not provide a model list': '这个引擎没有给出 模型清单',
  'This engine did not provide permission modes': '这个引擎没有给出 权限模式',
  'This engine did not provide effort options': '这个引擎没有给出 effort 选项',
  '{engine} sent an unknown request `{method}`; KiroLex replied {}. If it was asking you something, this turn went on with an answer nobody gave. Please report this to KiroLex.':
    '{engine} 发来一个 KiroLex 不认识的请求 `{method}`，已回空对象 {} —— 如果它是在"问你"，那这一轮是按一个没人给过的答案继续跑的。请把这条报给 KiroLex。',
  // ── aiLogin.ts ──
  'Claude Code is not installed': '没装 Claude Code',
  'Could not get the login status': '问不到登录状态',
  'API key ({source})': 'API key（{source}）',
  'Claude account': 'Claude 账号',
  'Logged in: {how}': '已登录：{how}',
  'Not logged in': '没登录',
  'Codex is not installed': '没装 Codex',
  'Using custom gateway "{id}"': '走自定义网关「{id}」',
  'Not valid JSON: {err}': '不是合法的 JSON：{err}',
  'It must be a JSON object (keys are variable names, values are strings).': '要是一个 JSON 对象（键是变量名，值是字符串）。',
  'The value of "{key}" must be a string.': '「{key}」的值要是字符串。',
  'At least ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is required.': '至少要有 ANTHROPIC_API_KEY（或 ANTHROPIC_AUTH_TOKEN）。',
  'Missing the top-level model_provider = "<name>" (it must come before every [section]).': '缺顶层的 model_provider = "<名字>"（要写在所有 [段] 之前）。',
  'Missing the [model_providers.{id}] section.': '缺 [model_providers.{id}] 这一段。',
  'base_url in [model_providers.{id}] cannot be empty.': '[model_providers.{id}] 里的 base_url 不能为空。',
  // ── binDetect.ts ──
  'Fails to run': '跑不起来',
  'It runs, but it does not look like {label} (it reports "{version}")': '跑起来了，但看着不是 {label}（它报的是「{version}」）',
  'No probe result (could not connect, or the shell on that machine did not answer)': '没有拿到探测结果（连不上，或者那台机器的 shell 没回话）',
  'Not detected this time (it worked before)': '这次没检测到（以前起过）',
  'Version output does not look like {label}: {output}': '版本输出不像 {label}：{output}',
  // ── engines.ts ──
  'Auto title, follow-up suggestions and session-memory tidying run on Kiro, so they are off for this {engine} session (its content is not sent to another AI). The title is taken from your first message; session memory can still be edited by hand.':
    '自动起标题、追问建议和会话记忆整理是用 Kiro 跑的，所以这条 {engine} 会话不用它们（会话内容不会交给另一家 AI）。标题取你的第一条消息；会话记忆仍然可以手动编辑。',
  'Could not find the ACP adapter for {engine}. Install it: `{install}` (no need to restart KiroLex afterwards, it is looked up again when you create a session).':
    '没找到 {engine} 的 ACP 适配器。装一下：`{install}`（装完不用重启 KiroLex，新建会话时会重新找）。',
  '{engine} is not logged in on the machine running this session. Run `{login}` in a terminal on that machine (remote sessions: 🔑 Login in the session panel), then try again.':
    '跑这条会话的那台机器上 {engine} 还没登录。在那台机器的终端里跑 `{login}`（远程会话：会话面板里的 🔑 登录），再试一次。',
  // ── forwardMcp.ts ──
  'Unknown error': '未知错误',
  'Local→upstream ({name}) {why}': '本机→上游（{name}）{why}',
  '⚠️ The MCP "{name}" forwarded from this machine is unavailable: {msg}. Fix the local config and reopen the session.': '⚠️ 本机转发的 MCP「{name}」暂时用不了：{msg}。改好本机配置后重开会话。',
  'Names may only use letters, digits, _ . - (at most 40), otherwise they cannot go into the forwarding URL': '名字只能用字母、数字、_ . -（最多 40 个），否则放不进转发地址',
  'Clashes with the local tool channel kirolex-local': '和本地工具通道 kirolex-local 重名',
  'it is turned off in the current combo': '当前组合里把它关掉了',
  'no definition for it in the local Kiro agent files or ~/.kiro/settings/mcp.json': '本机的 Kiro agent 文件和 ~/.kiro/settings/mcp.json 里都没有它的定义',
  'it is disabled in {from}': '它在 {from} 里是关掉的',
  'it has neither command nor url in {from}': '{from} 里它既没有 command 也没有 url',
  // ── kiroCliLog.ts ──
  'The service returned an empty reply, unrelated to your message and this history. Try again in a few minutes, or switch models.': '服务端返回了空回复，与你的消息和这段历史都无关。过几分钟再试，或换个模型。',
  "Can't reach the model service. Check your network/VPN.": '连不上模型服务，检查网络/VPN。',
  'Rate limited: wait a moment before sending again, or switch models.': '被限流了：等一下再发，或者换个模型。',
  'The service rejected this request; usually something in the history is over the limit (an image, a very long block).': '请求被服务端拒绝，通常是历史里有超限的内容（图片、过长的一段）。',
  'kiro-cli reported an error.': 'kiro-cli 报了错。',
  'kiro-cli log: {detail}': 'kiro-cli 日志：{detail}',
  // ── kiroConfig.ts (category hints, translated in categoriesFor) ──
  "Global MCP servers (shared by every agent). An agent's own mcpServers are edited under Agents.": "全局 MCP server（所有 agent 共用）。某个 agent 自己的 mcpServers 在 Agents 里改。",
  "Standing rules: sent to the model on every turn.": "常驻规则：每一轮都会带给模型。",
  "Saved prompts. Call one up in a session with @name.": "存下来的提示词，在会话里用 @名字 调出来。",
  "Each skill's SKILL.md (scripts/reference files in the same folder are not edited here). Entries tagged with a plugin name come from plugins and are read-only.": "每个 skill 的 SKILL.md（同目录下的脚本/参考文件不在这里改）。标着插件名的是插件带的，只读。",
  "Each skill's SKILL.md (scripts/reference files in the same folder are not edited here).": "每个 skill 的 SKILL.md（同目录下的脚本/参考文件不在这里改）。",
  "Installed Powers, managed by kiro-cli. View only here (editing by hand would conflict with its install records).": "已安装的 Powers —— 由 kiro-cli 管理，这里只看不改（手改会和它的安装记录打架）。",
  "kiro-cli settings (default model, autoApprove, MCP timeouts...). Same file as `kiro-cli settings <key> <value>`.": "kiro-cli settings（默认模型、autoApprove、MCP 超时…）。和 `kiro-cli settings <键> <值>` 是同一个文件。",
  "Claude Code user settings (env holds the gateway URL and key; also permissions, model...). For remote sessions this edits the copy on that machine.": "Claude Code 的用户设置（env 里是网关地址和 key、permissions、model…）。远程会话改的是那台机器上的这份。",
  "User-level standing instructions: every session reads it (same purpose as kiro's Steering).": "用户级的常驻说明：每个会话都会读它（和 kiro 的 Steering 一个用途）。",
  "Subagent definitions (one .md each, starting with YAML front matter). Entries tagged with a plugin name come from plugins and are read-only.": "子代理定义（每个一份 .md，开头是 YAML front matter）。标着插件名的是插件带的，只读。",
  "Custom slash commands: the file name is the command name (/name). Entries tagged with a plugin name come from plugins (/plugin:name) and are read-only.": "自定义斜杠命令：文件名就是命令名（/名字）。标着插件名的是插件带的（/插件:名字），只读。",
  "Installed plugins (managed by Claude Code, view only here). Install / uninstall with `claude plugin install|uninstall`; toggle them via enabledPlugins in Settings.": "装了哪些插件（由 Claude Code 管理，这里只看）。装 / 卸用 `claude plugin install|uninstall`；开关在 Settings 的 enabledPlugins。",
  "Codex config (model, model_provider, [model_providers.*], MCP, sandbox...). It is TOML, not JSON.": "Codex 的配置（model、model_provider、[model_providers.*]、MCP、sandbox…）。是 TOML，不是 JSON。",
  "User-level standing instructions: every session reads it.": "用户级的常驻说明：每个会话都会读它。",
  "Custom prompts: the file name is the command name (/prompts:name).": "自定义提示词：文件名就是命令名（/prompts:名字）。",
  "Each skill's SKILL.md.": "每个 skill 的 SKILL.md。",
  '{label} is managed by {owner} and cannot be edited here.': '{label} 由 {owner} 管理，这里不能改。',
  'Larger than 1 MB. A config this big is most likely something pasted by mistake.': '超过 1 MB —— 这么大的配置多半是贴错了东西。',
  'Must be a JSON object.': '必须是一个 JSON 对象。',
  'JSON error: {err}': 'JSON 有错：{err}',
  'This comes from a plugin and is read-only (edits would be overwritten when the plugin updates). To change it, create your own file with the same name under Skills / Commands / Agents.':
    '这是插件带的，只读（改它会在插件更新时被盖掉）。要改就在 Skills / Commands / Agents 里建一份自己的同名文件。',
  'Invalid name.': '名字不合规。',
  // ── localAction.ts ──
  'only open is supported, not `{verb}`': '只支持 open，不认 `{verb}`',
  'no address given': '没给地址',
  'only http/https addresses can be opened (other schemes are app launchers on macOS)': '只能开 http/https 地址（别的 scheme 在 macOS 上是应用启动器）',
  'not a valid address': '不是一个合法地址',
  // ── loopStore.ts ──
  'No loop record found for this session': '没有找到这个会话的循环记录',
  // ── loopVerify.ts ──
  'The verifier command did not finish within {sec} seconds and was stopped': '校验命令超过 {sec} 秒未结束，已终止',
  'Verifier command not found (shell exit code {code}): {detail}': '找不到校验命令（shell 退出码 {code}）：{detail}',
  'the command does not exist or is not executable': '命令不存在或不可执行',
  // ── memoryPolicy.ts (memory banner labels; the renderer passes lang) ──
  'Global memory': '全局记忆',
  'Project memory "{project}"': '项目记忆「{project}」',
  "This chat's memory": '本会话记忆',
  // ── subagents.ts (sidebar tooltip; the renderer passes lang) ──
  '{name} ({agent})': '{name}（{agent}）',
  'unknown agent': '未知 agent',
  // ── reviewApply.ts ──
  'Nothing to change': '没有要改的地方',
  'Lines {from}-{to} are not a valid range. Nothing was written': '第 {from}-{to} 行这个范围不成立 —— 没写',
  'Lines {from}-{to} go past the end of the file (it only has {n} lines). Nothing was written': '第 {from}-{to} 行超出了文件（一共只有 {n} 行）—— 没写',
  'The edits at lines {aFrom}-{aTo} and {bFrom}-{bTo} overlap. Nothing was written': '第 {aFrom}-{aTo} 行和第 {bFrom}-{bTo} 行两处改动重叠了 —— 没写',
  'Line {line} does not match: it says "{hint}" is there, but it is actually "{actual}". It probably miscounted the lines. Nothing was written':
    '第 {line} 行对不上：它说那里是「{hint}」，实际是「{actual}」—— 多半数错了行，没写',
  'Cannot change this: {reason}. Try phrasing it differently': '改不了：{reason} —— 换个说法再试',
  'Rewrite failed: {error}': '改写失败：{error}',
  'no response': '没有返回',
  'The main process is an older version that does not support cross-block rewrites. Restart KiroLex and try again (nothing was written this time)':
    '主进程还是旧版本，不认跨段改写 —— 重启 KiroLex 之后再试（这次什么都没写）',
  'This result was not written to the file. Refresh, check the text, and submit again': '这次的结果没有写进文件 —— 刷新看一眼正文再提一次',
  // ── remoteWriteGuard.ts ──
  '{paths}, etc. ({n} in total)': '{paths} 等 {n} 个',
  ' ({paths})': '（{paths}）',
  '⚠️ Blocked a file write to {host}{where}: delivered files must land on this machine; it should use `local_write` instead (`{dir}`).': '⚠️ 已拦下往 {host} 写文件{where}：交付文件要写在本机，它应改用 `local_write`（`{dir}`）。',
  '⚠️ Blocked a file write to {host}{where}: delivered files must land on this machine; it should use `local_write` instead.': '⚠️ 已拦下往 {host} 写文件{where}：交付文件要写在本机，它应改用 `local_write`。',
  "⚠️ This turn wrote files on {host} ({paths}). Click \"⇩ Copy to this machine\" to bring them here.": '⚠️ 这一轮把文件写在了 {host} 上（{paths}），点「⇩ 复制到本机」拿回来。',
  // ── sshMux.ts ──
  'The shared connection to {host} was closed while it was being set up': '{host} 的复用连接在建立过程中被关掉了',
  'The shared connection to {host} could not be set up. {detail}': '{host} 的复用连接没建起来。{detail}',
  '(ssh printed nothing)': '（ssh 没有输出）',
  '{host} has run out of SSH sessions (sshd MaxSessions, default 10). Running "Install AI tools" for this machine in Settings raises the limit to 64; or close a few remote sessions you are not using.':
    '{host} 的 SSH 会话数满了（sshd MaxSessions，默认 10）。在设置里对这台机器跑一次『安装 AI 工具』会把上限调到 64；或者关掉几条不用的远程会话。',
  // ── remoteLocalTools.ts ──
  'No free remote ports left ({from}–{to}).': '没有空闲的远端端口了（{from}–{to}）。',
  // ── remotePreflight.ts ──
  'Cannot connect to {host}: {why}. Check the network/keys/security group (kiro-cli and the files for this machine live on it, so nothing runs without a connection).':
    '连不上 {host}：{why}。检查网络/密钥/安全组（这台机器的 kiro-cli 和文件都在它上面，连不上就跑不了）。',
  'Cannot connect to {host}: {why}. {hint} (kiro-cli and the files for this machine live on it, so nothing runs without a connection).':
    '连不上 {host}：{why}。{hint}（这台机器的 kiro-cli 和文件都在它上面，连不上就跑不了）。',
  'the private key file permissions are too open, so ssh refuses to use it': '私钥文件权限太宽，ssh 拒绝使用它',
  '<private key path>': '<私钥路径>',
  'Restrict it so only you can read it: `{cmd}`': '把它收紧到只有自己可读：`{cmd}`',
  'the remote host key has changed (rebuilding the instance or changing its IP does this)': '远端的主机密钥变了（重建过实例或换了 IP 都会这样）',
  '<host>': '<主机>',
  'After confirming it is your own machine, remove the old entry and connect again: `{cmd}`': '确认是你自己的机器后，删掉旧记录再连：`{cmd}`',
  'the remote does not accept this key': '远端不接受这把密钥',
  'Check that the configured private key belongs to this machine and that the user name is right': '检查配置里的私钥是不是这台机器的、用户名对不对',
  '{host} is missing {tools}. Run the bootstrap script on the remote once to install everything: `{cmd}` (KiroLex does not install things on the remote for you).':
    '{host} 上缺 {tools}。在远端跑一次预置脚本装齐：`{cmd}`（KiroLex 不替你在远端装东西）。',
  'kiro-cli on {host} is not logged in. Run `kiro-cli login` on that machine once. Without a login the executor starts, but every turn comes back empty, which looks just like the server returning empty responses.':
    '{host} 上的 kiro-cli 没登录。去那台机器跑一次 `kiro-cli login`——没登录的话执行器起得来、但每一轮都空回，看起来就像服务端在返空响应。',
  '{host}: kiro-cli is installed and logged in, {n} models available.': '{host}：kiro-cli 在，也登录了，{n} 个可用模型。',
  '{host}: kiro-cli is installed and logged in.': '{host}：kiro-cli 在，也登录了。',
  // ── remoteRecovery.ts ──（「本机工具连接中断，正在重连」「本机工具连接已恢复」和 index.ts 用同一个 key，文案在 indexA）
  // ── remoteTargets.ts ──
  'The working directory must be an absolute path (or start with ~).': '工作目录要写绝对路径（或以 ~ 开头）。',
  'The IP address cannot be empty.': 'IP 地址不能为空。',
  'The IP address cannot contain spaces.': 'IP 地址里不能有空格。',
  'The IP address cannot start with `-`.': 'IP 地址不能以 `-` 开头。',
  'The port must be a number between 1 and 65535.': '端口要是 1–65535 之间的数字。',
  'The jump host must be `user@host` or `user@host:port` (letters, digits, `@ . - _ :` and IPv6 brackets).': '跳板地址只能是 `用户@主机` 或 `用户@主机:端口`（字母、数字、`@ . - _ :` 和 IPv6 的方括号）。',
  'The working directory must be an absolute path (starting with `/` or `~`).': '工作目录要写绝对路径（以 `/` 或 `~` 开头）。',
  // ── reviewAccess.ts ──
  'This file was not opened for preview in a tab of this session, so it was not written (refresh the tab and submit again)': '这个文件不是这条会话的标签页打开预览过的 —— 不写（刷新一下这个标签页再提交）',
  'No path': '没有路径',
  'The content is empty, so nothing was written': '内容是空的，不写',
  'This file cannot be read right now. Not creating it; check that the path is right first': '这个文件现在读不到 —— 不新建，先确认路径对不对',
  'This file is larger than the preview limit (512KB). The preview only has the first part and writing it back would cut off the rest, so nothing was written':
    '这个文件比预览上限（512KB）大 —— 预览里只有前半截，写回去会把后面截掉，所以不写',
  'The original read back is incomplete ({got} / {size} bytes). Nothing was backed up or written; submit again once the connection is stable':
    '读回来的原文不完整（{got} / {size} 字节）—— 没备份、没写，等连接稳定了再提交',
  'This file was changed by something else during the rewrite. This result was not written; check the new text and submit again':
    '这份文件在改写期间被别的改动动过了 —— 这次的结果没写进去，看一眼新的正文再提一次',
  'The pre-write backup failed. Without a copy to roll back to, nothing was changed this time. Check that ~/.kirolex/backups is writable.':
    '写前备份失败 —— 没有可回滚的副本，所以这次不改。检查 ~/.kirolex/backups 能不能写。',
  // ── skillDoc.ts ──
  '(untitled)': '(未命名)',
  '{n} rules': '{n} 条规则',
  '{n} need a person': '{n} 处要人参与',
  '{n} write to external systems': '{n} 处写外部系统',
  '{tables} tables / {rows} rows': '{tables} 张表 / {rows} 行',
  'No path given': '没有给路径',
  'Not under {root}': '不在 {root} 下面',
  'A skill must be exactly <name>/SKILL.md': 'skill 必须是 <名字>/SKILL.md 这一层',
  'Only SKILL.md can be written': '只能写 SKILL.md',
  // ── primeRetry.ts ──
  'failed {tries} times in a row: {error}': '连续 {tries} 次失败：{error}',
  'This chunk is already small, so size is not the cause; the session connection is most likely broken. ': '这一块已经很小，不是太大的问题，多半是会话的连接坏了。',
  'The same chunk hit the retry limit ({n}). ': '同一块已到重试上限（{n} 次）。',
  'Rebuilding history got stuck at chunk {chunk}/{total} ({chars} chars) after {tries} tries: {error}. {why}It retries the next time you send; you can also fork this session and continue in the new one.': '重建历史卡在第 {chunk}/{total} 块（{chars} 字），试了 {tries} 次都失败：{error}。{why}下次发消息时会再试；也可以分叉出一条新会话继续。',
  // ── stderrNotice.ts ──
  'MCP server problem': 'MCP 服务器有问题',
  'Backend authentication problem': '后端认证有问题',
  'Tool call problem': '工具调用有问题',
  'Backend error': '后端报错',
  // ── promptRetry.ts ──
  '(Resent automatically {n} times with the same result. Press Rerun to try again, or split this turn into smaller messages.)': '（已自动重发 {n} 次，结果相同。可点「重跑」再试，或把这一轮拆小。）',
  // ── transientError.ts ──
  'SSH connection closed (ssh exit {code}): remote port {port} is in use, so the local tools connection was not set up; retrying on another port. If it keeps happening, a leftover kiro-cli on that machine may hold the port.': 'SSH connection closed（ssh exit {code}）：远端端口 {port} 被占用，本机工具连接没建起来，会换端口重试。反复出现的话，可能是那台机器上残留的 kiro-cli 占着端口。',
  'SSH connection closed (ssh exit {code}): lost the connection to the remote. KiroLex reconnects; the turn is resent automatically only if it had produced nothing yet.': 'SSH connection closed（ssh exit {code}）：和远端的连接断了。会自动重连；这一轮还没产出时才自动重发。',
  // ── projectStore.ts ──
  'Must be an absolute path (like C:\\Users\\you\\project)': '要写绝对路径（像 C:\\Users\\你\\项目）',
  'Must be an absolute path (starting with /)': '要写绝对路径（从 / 开始）',
  'This is not a directory': '这不是一个目录',
  'This directory does not exist': '这个目录不存在',
  // ── sshProxy.ts ──
  'The SSH address cannot start with `-` ({host}). Refusing to put it into an ssh command.': 'SSH 地址不能以 `-` 开头（{host}）—— 拒绝拼进 ssh 命令。',
  // ── sessionStore.ts ──
  'Invalid session id: {id}. Only letters, digits, underscores and hyphens are allowed': '会话 id 不合法：{id} —— 只允许字母、数字、下划线和短横',
  'Message {id} was not found in the saved transcript.': '保存的对话记录里找不到消息 {id}。',
  // ── acp-client.ts ──
  'Process not connected': '执行器进程没连着',
  // ── localBrowserHost.ts（回合面板里的浏览器操作）──
  'List tabs': '列出标签',
  'Open': '打开',
  'Read': '读取',
  'Screenshot': '截图',
  'Close tab': '关闭标签',
  '⚠️ {what} failed {url}: {error}': '⚠️ {what}失败 {url}：{error}',
  '🗂 Listed {n} browser tabs': '🗂 列出了 {n} 个浏览器标签',
  '🌐 Opened {url}': '🌐 打开了 {url}',
  '📖 Read {n} of {total} chars from {url}': '📖 读了 {url} 的 {n} 字（全文 {total} 字）',
  '📖 Read {n} chars from {url}': '📖 读了 {url} 的 {n} 字',
  '📸 Screenshot of {url} → {path}': '📸 截图 {url} → {path}',
  '✖ Closed tab {url}': '✖ 关闭了标签 {url}',
  'Session not found': '找不到这条会话',
  // ── adapterInstall.ts（会话里「安装」缺的 ACP 适配器）──
  'it did not finish within {min} minutes': '{min} 分钟内没装完',
  'npm was not found on this machine. Install Node.js (it comes with npm) first, then click Install again.': '这台机器上找不到 npm。先装 Node.js（自带 npm），再点一次「安装」。',
  'npm has no permission to write its global folder (EACCES).': 'npm 没有权限写它的全局目录（EACCES）。',
  '❌ Installing the {engine} ACP adapter ({pkg}) on {host} failed: {why}': '❌ 在 {host} 上安装 {engine} 的 ACP 适配器（{pkg}）没成功：{why}',
  '❌ Installing the {engine} ACP adapter ({pkg}) on this machine failed: {why}': '❌ 在本机安装 {engine} 的 ACP 适配器（{pkg}）没成功：{why}',
  'npm reported success, but KiroLex cannot find {pkg} in any global node_modules folder it knows about.': 'npm 说装好了，但 KiroLex 在它知道的全局 node_modules 目录里都找不到 {pkg}。',
  'This session does not use Claude Code or Codex.': '这条会话用的不是 Claude Code / Codex。',

  // ── agentProfile.ts / index.ts agent-profile:* ──
  "Not valid JSON: {error}": "不是合法的 JSON：{error}",
  "The top level must be a JSON object { … }": "最外层必须是一个 JSON 对象 { … }",
  "\"{key}\" must be an object": "「{key}」必须是一个对象",
  "Do not know where to install marketplace {name} from (add its source under \"marketplaces\"); plugins from it are skipped.": "不知道插件市场 {name} 从哪装（在 \"marketplaces\" 里写上它的来源）；这次先跳过它下面的插件。",
  "{dir} is larger than {mb} MB; not copied": "{dir} 超过 {mb} MB，没有拷",
  "{dir} does not exist on this computer": "本机没有 {dir}",
  "The remote probe did not return a result: {tail}": "远端探测没有给出结果：{tail}",
  "There is no AI tool config yet: save one above first.": "还没有 AI 工具配置：先在上面存一份。",
  "A sync to {host} is already running": "已经在往 {host} 同步了",
  "{file} was changed on disk after you opened it (for example pulled in by S3 sync from another computer). Not saved, so the newer file is not overwritten.": "{file} 在你打开之后被改过了（比如 S3 同步从别的电脑拉回了新版本）。这次没保存，免得把更新的那份盖掉。",
};
