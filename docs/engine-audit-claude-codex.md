# Claude Code / Codex 运行模式审计（本机 + 远程）

KiroLex 的三种引擎（`src/main/engines.ts`）里 kiro-cli 是日常用的，Claude Code（`@agentclientprotocol/claude-agent-acp`）和
Codex（`@agentclientprotocol/codex-acp`）测得少。这份文档把这两种引擎从起进程到一轮结束的代码路径过了一遍，
本机和远程（ssh）都看了，逐类给结论。

- **状态**一栏只有四种写法：**已修**（本次改了代码，配了测试）/ **未修**（确认有问题，但改动面大或要先拍板，写了原因）/
  **待实测**（读代码看到风险，但取决于适配器的真实行为，本机没装适配器、没法验证）/ **已查，无问题**。
- 行号是本次提交后的行号（会漂；函数名可以直接 grep）。
- 已修的每一条都在 `tests/engineAuditFixes.test.ts`（A1–A8）/ `tests/engineAuditFixes2.test.ts`（A4b、A9–A13）/ `tests/engineAuditFixes3.test.ts`（A14、A15）（后两份是审查后补的）里有对应的 `A<n>` 用例：在修复前的代码上全部失败，修复后通过；
  另有几条「kiro 行为不变」的用例，修复前后都通过（守的是「没顺手改 kiro」）。
- 修复都只对 `engine !== 'kiro'` 生效，kiro-cli 的现有行为一处没动。

## 总表（按严重程度）

| # | 问题 | 严重 | 状态 |
|---|---|---|---|
| A1 | 换新后端会话后，会话记着的模型 / effort / 权限模式全丢了（Claude 退回机器默认模式，每个工具都来问） | 高 | 已修 |
| A2 | 连着几次空回复时，kiro 的「换模型重发」作用在 Claude Code / Codex 上：重起适配器、把 kiro 的模型 id 写进记录、在对话里说一句假的「已换模型」 | 中高 | 已修 |
| A6 | 停止时没把挂着的权限请求答成 cancelled（ACP 规定必须答）；适配器那一轮等着这个回答，停不下来 | 中高 | 已修 |
| A7 | 等人批准权限被看门狗当成卡死：600 s 后取消、自动续一轮、又来问一次 | 中 | 已修 |
| A3 | 重连后第一次笼统 `Internal error` 就因为「pid 变了」换掉后端会话，扔掉适配器里真实存在的那段历史 | 中 | 已修 |
| A4 | 每次重启 / 重连后，把整段历史快照重新塞给已经 `session/load` 回全部历史的适配器（重复上下文、白花 token） | 中 | 已修 |
| A8 | 没登录只显示 `Authentication required`；macOS/Linux 上没装适配器只显示 `spawn claude-agent-acp ENOENT` —— 和别的错分不清、不知道去哪弄 | 中 | 已修 |
| A5 | 适配器自己改了模式 / 模型（`config_option_update` / `current_mode_update`）时下拉不跟着变 | 中低 | 已修 |
| A14（原 U1） | 标题、建议、会话记忆整理永远用 kiro-cli 跑（只装了 Claude/Codex 的机器上这三样静默失效；装了 kiro 时把 Claude 会话的内容发给 Kiro 计费） | 中 | 已修 |
| A15（原 3.3） | 设置里 claude / codex 两格标着「启动命令」、说明写着「KiroLex 只起 kiro-cli」，实际会话起的是适配器、不读这两格 | 低中 | 已修 |
| A9（原 U2） | 远端孤儿清扫认不出适配器进程（只认 kiro 的 agent 前缀 / `kiro-cli acp`） | 中 | 已修 |
| A10（原 U3） | 「测试连接」只查 kiro-cli；只装了 Claude/Codex 的机器报「缺 kiro-cli」 | 中 | 已修 |
| U4 | `/compact`、`/clear` 这类斜杠命令前面被拼上记忆 / 目录说明块，适配器多半认不出是命令 | 中 | 待实测 |
| U5 | 斜杠命令菜单对 Claude/Codex 是空的（只认 kiro 的 `_kiro.dev/commands/available`，没接 ACP 标准的 `available_commands_update`） | 中低 | 已修（A11） |
| A12（原 3.1） | 适配器一起来就退出时只报退出码，stderr 里的原因没进界面 | 中 | 已修 |
| A13（原 3.4） | 远程 Claude/Codex 会话照样去远端问 kiro 的模型清单 | 低 | 已修 |
| 其余 | 见各节 | 低 | 未修（写了原因）/ 待实测 |

---

## 1. 新建会话、恢复会话、重启后端、切换引擎、切换运行位置

kiro-cli **不持久化** ACP 会话（`loadSessionImpl` 注释里的实测：`session/load` 一个旧 id 得到的是空对话），所以 KiroLex 的
「上下文在不在后端」判据绑进程 pid。两个适配器**会**持久化（Claude Code 写 `~/.claude/projects/…`，Codex 写 rollout 文件；
`engines.ts` 头注释里实测 `loadSession: true`），这条假设对它们不成立 —— 本节 A3、A4 都出在这里。

| # | 文件:行号 | 触发条件 | 实际表现 | 该有的表现 | 严重 | 状态 |
|---|---|---|---|---|---|---|
| A1 | `src/main/index.ts:3939` `recreateBackendSession` | Claude/Codex 会话换新后端会话：连续 Internal error 的自愈（`:7901`）、「写成文字」反复发作、控制入口 `POST /sessions/:id/new-backend`（都经 `swapBackendSessionWhenIdle`） | `session/new` 拿到的是适配器默认的模型 / effort / 模式；`applyEngineModel` 只在 `wireSession` 里跑，这里没人设回去。Claude 退回那台机器的 `defaultMode`（不是 `DEFAULT_ENGINE_MODE` 的 bypassPermissions），而非 kiro 在 KiroLex 里永远是 ask，于是每个工具都弹权限；界面下拉也没刷新 | 新后端会话沿用会话记着的选项，界面同步 | 高 | **已修**：`newSession` 后对非 kiro `await applyEngineModel(...)`（它最后会推 `session:engine-models`）。测试 A1 |
| A2 | `index.ts:694` `swapSessionModel`；调用点 `:7675`（连着空回复）、`:7711`（模型不可用）、`:1724`（重建历史） | Claude/Codex 一轮连着 ≥2 次笼统 `Internal error`（适配器对 API 异常就回 -32603）且没产出 | 断开适配器、按 kiro 的 `MODEL_FALLBACK_ORDER` 重起（适配器不认 `--model`，等于原样重起），把 kiro 的模型 id 和 `modelEarnedOn` 写进 Claude 会话的记录，把 `default` 记成死模型，跑 kiro 的 `--list-models` 检查（远端没 kiro-cli 时还会失败），并在对话里写一句「已把模型从 default 换成 …」——都是假的 | 这条 kiro 专有的恢复对另外两家不走 | 中高 | **已修**：两处条件先判 `engineOf(...) === 'kiro'`，`swapSessionModel` 对非 kiro 直接 `return null`。测试 A2 |
| A3 | `src/main/staleSession.ts` `staleVerdict`；调用 `index.ts:7864` | Claude/Codex 会话重启 / 重连过（pid 变了）后，一轮回了一次笼统 `Internal error` | 「pid 不一致 → 这个 id 在新进程里没有上下文」→ 换新后端会话：适配器里那段真实存在的历史被扔掉，靠快照随行补（有损），提示词还说是「kiro-cli 不持久化」 | 只报错；连着坏两次（`consecutiveFailures`）那条照旧换 | 中 | **已修**：`StaleInput.persistentBackend`（`backendPersistsSessions(engine)`）为真时跳过 pid 判据。测试 A3 |
| A4 | `index.ts:1228` `contextEstablished`、`:11325` attach 时的判据 | Claude/Codex 会话重启 app、被 LRU 回收后再打开、ssh 断线恢复 —— `session/load` 成功 | 「上下文已建立」标记要求 pid 相同，新进程必然不同 → 下一条消息前面带一份最多 1.8 万字的历史快照（`primeMode='full'` 时还会逐段重建），而适配器已经 load 回了全部历史：上下文重复、白花 token、模型可能把旧问题再答一遍 | 适配器只认后端会话 id：同一个 id load 成功就算建立 | 中 | **已修**：纯判据 `contextMarkerHolds`（`engines.ts`）——kiro 仍要求同 id 同 pid，适配器同 id 即可；两处判据都走它。**补（审查意见 1）**：新会话第一轮成功结束原来不写标记，只聊一轮就重启时适配器 load 回了历史，判据仍找不到标记、照样带快照 —— 现在 Claude/Codex 一轮开始时后端已握着全部历史（之前的标记仍算数，或盘上还一条都没有）就在这一轮成功结束时记标记（`backendHeldAtTurnStart`，`index.ts` 发送前的 `heldBackendAtStart`；一轮中后端会话换了 id 不记）。kiro 不走这条。测试 A4、A4b（按主进程顺序走「第一轮完成 → 重启 → load 成功 → 发送」） |
| 1.1 | `index.ts:9893` `switchEngineImpl`（休眠分支）、`:11271` `cliSessionId = existing?.cliSessionId \|\| sessionId` | 会话没连着时换引擎（kiro→claude 等），再打开 | 记录里留着旧引擎的 `cliSessionId`，新引擎拿它去 `session/load`。适配器回 `Resource not found` 就立刻退回新建（白一次请求）；换成 kiro 时它对陌生 id 的回答没实测，最坏两次 `RESUME_TIMEOUT_MS`（20–90 s）才退回 | 换引擎后直接 `session/new` | 低 | 未修：清掉 `cliSessionId` 后 attach 会退到「用 KiroLex id 去 load」那条老兼容路，效果一样，要改 attach 的兜底，牵涉 kiro，不在本次范围 |
| 1.2 | `index.ts` `applySessionTarget`（休眠分支） | 没连着的 Claude/Codex 会话换运行位置（本机↔远程） | 同上：拿另一台机器上的会话 id 去 load，白一次请求后退回新建 + 快照随行 | 同上 | 低 | 未修（同 1.1） |
| 1.3 | `index.ts:5053` `wireSession` 里 `engineOptionsReady` 不被等待 | 刚连上就发第一条 | `sendPromptOnce` 不等 `applyEngineModel`，第一轮可能跑在适配器默认模式上（忙时切换那条 `runPendingSwitches` 是等的） | 第一轮前设好 | 低 | 待实测（适配器设选项很快，窗口很小） |
| 1.4 | 换组合（`switchMcpComboImpl`） | Claude/Codex 换 MCP 组合 | 起新进程后 `session/new`，扔掉适配器里持久化的会话，靠快照补 | 带新 `mcpServers` 去 `session/load` 也许能保住原历史 | 低 | 未修（设计取舍，要实测 load 时换 MCP 是否生效） |
| 1.5 | `index.ts:7135` ride-along 判据（**引擎无关**） | 任何引擎的新会话发第二条 | 读代码看：新会话第一轮正常跑完后没有任何地方打「上下文已建立」标记，第二条会带上第一轮的快照 | 不带 | — | 待实测（影响 kiro，不在本次范围；看日志里新会话第二条有没有 `context RIDE-ALONG`） |

**已查，无问题**：`acp:new-session`（引擎写进 profile、远程走 `remoteAdapterCheck` 而不是 kiro 的 `remotePreflight`、模型记 `default`）；
`connectWithModelFallback` 非 kiro 分支（只起一次，不走 kiro 降级链）；`loadSessionImpl`（引擎和选项从记录读回；没聊过的会话不 resume，`:11293`；
`Resource not found` 不重试；cwd 稳定）；热切换引擎 / 运行位置 / 组合都经 `wireSession`（会重设选项）；`switchModelImpl` / `switchKiroAgentImpl` 对非 kiro 明确拒绝；
每一处 `new AcpClient(...)` 都带 `engine`（`tests/engines.test.ts` 守着）；`disconnect()` 对适配器也是先关 stdin、远端按自报 PID `remoteKillTree`；
断线恢复（`disconnected` 处理）引擎无关；错误文字匹配里没有只认 kiro 的「Session is active in another process」逻辑（只在注释里）。

## 2. 流式输出、工具调用、权限请求、取消、追加指令、排队、忙时切换

| # | 文件:行号 | 触发条件 | 实际表现 | 该有的表现 | 严重 | 状态 |
|---|---|---|---|---|---|---|
| A6 | `src/main/acp-client.ts:621` `cancelPrompt` | Claude/Codex 有权限请求在等（它们永远是 ask；Codex 默认就问，Claude 非 bypass 模式也问），用户点停止 / 看门狗取消 | 只发 `session/cancel`，挂着的 `session/request_permission` 不回答。ACP 规定客户端此时**必须**答 `cancelled`；适配器那一轮等着这个回答，停止按钮等到 10 s 超时，这一轮继续占着「忙」 | 发 cancel 的同时把挂着的每个请求答成 `cancelled` | 中高 | **已修**：非 kiro 在 `cancelPrompt` 里逐个答 `cancelled` 并清掉；kiro 原样。测试 A6 |
| A7 | `index.ts:7420` 看门狗；`permissionWaitStartedAt`（`:5277`）只记日志，看门狗不读 | Claude/Codex 的权限请求超过 `WEDGE_CONFIRM_MS`（默认 600 s）没人点 | 被判卡死 → `session/cancel` → 自动发 `WEDGE_CONTINUE_PROMPT` 续一轮 → 通常又来问一次 | 等人的时候不计静默 | 中 | **已修**：`AcpClient.awaitingPermission`；非 kiro 有请求在等时把 `lastStreamAt` 往后推、不打断。kiro 的 ask 模式有同样的问题，按「不改 kiro 行为」没动。测试 A7 |
| 2.1 | `src/renderer/hooks/useAcp.ts:2450` 设权限卡片，只在点了之后清 | 一轮结束 / 停止 / 断线时还有卡片 | 卡片留在屏幕上，`awaitingPermission` 一直为真（影响空闲提醒），点它答的是一个已经作废的请求 id | 轮次结束 / 断线时清掉 | 低 | 未修（引擎无关，kiro 的 ask 模式同样如此；A6 修好后点旧卡片只是答一个没人等的 id，无害） |
| 2.2 | `useAcp.ts:2450` 每会话只存一个权限请求 | Claude 子代理 / Codex 并行执行同时来问 | 后来的覆盖先来的，先来的那个永远没人答，那一轮挂住 | 每会话一个列表 | 中 | 待实测（不确定两个适配器会不会并发发权限请求） |
| 2.3 | `index.ts:5167` 工具状态缺省成 `pending` | `tool_call_update` 不带 `status`（Claude 常见） | 落盘的状态退回 `pending`；如果发生在 `completed` 之后，这个调用会被重新算作「开着」（日志多一行 start，看门狗按工具上限多等） | 缺省沿用上一次的状态 | 低 | 待实测（没确认适配器会在完成后再发无 status 的更新） |
| 2.4 | `index.ts:5277` `permissionWaitStartedAt` 按 JSON-RPC 请求 id 全局记 | 两条会话的适配器各自从 0 开始编 id | 等待时长日志可能串（只影响日志里的 waited=…） | 按会话 + id 记 | 低 | 未修（只影响日志） |
| 2.5 | `acp-client.ts:956` 未知请求的提示 | 适配器发来 KiroLex 不认识的请求 | 提示文字写死「kiro-cli sent an unknown request」 | 说对是哪个引擎 | 低 | 未修（只是措辞；按要求不改提示文案） |

**已查，无问题**：
- 流式：`agent_message_chunk` 累积 / 一轮结束才落盘、`usage_update`（两个适配器都发，喂上下文百分比，`useAcp.ts`）、`isReplayOutsideTurn`（只丢一轮之外的正文块，不影响适配器在 `session/new` 后推的命令表等）、`noticeForStopReason` / 空回复提示。
- 工具调用：`extractToolOutput` / `extractDiffs`、`remoteWriteGuard.writeTargets`（认 Claude 的 `file_path` / `notebook_path`、Codex 的 `changes`）、`ToolCallLedger` 合并。
- 权限：非 kiro 永远原样转给人（`acp-client.ts:235`，问不问由它们自己的 mode 决定）；`pickPermissionOption`、`respondToPermission`、`setPermissionMode` 对非 kiro 是空操作。
- 追加指令：`supportsSteer` 只给 kiro；`steerGate.ts` 先判「这一轮已结束」再判「引擎不支持」；渲染端 `steerFailureRoute` → 标红「这个引擎不支持往正在跑的一轮里追加」，让用户选「作为下一条发送 / 放回输入框」，消息不丢（AGENTS.md §4.2 的既定设计）。
- 排队、忙时切换：`queueSwitchWhileBusy` 对 `engineModel` / `engineEffort` / `engineMode` 同样生效；`runPendingSwitches` 的即时项等 `engineOptionsReady`；`withEngineOption` 能改休眠会话；`wantedEngineOptions` 先模型后 effort。

## 3. 模型列表 / 模式 / 登录状态的探测和显示；没装、没登录、版本不对的报错

| # | 文件:行号 | 触发条件 | 实际表现 | 该有的表现 | 严重 | 状态 |
|---|---|---|---|---|---|---|
| A8a | `acp-client.ts:807`（请求出错时）；判据 `engines.ts` `isAuthRequiredError` | 那台机器上 Claude Code / Codex 没登录，`session/new` 或 `session/prompt` 回 ACP 的 `auth_required`（-32000） | 界面上只有一句英文 `Authentication required`，跟没装、崩了分不清，也不知道去哪登录；本机会话还没有任何地方能看登录状态（`aiLoginTarget` 只给远程） | 说清是哪个工具没登录、在哪台机器的终端里跑什么命令 | 中 | **已修**：非 kiro 的 -32000 / `Authentication required` 换成「跑这条会话的那台机器上 {engine} 还没登录。在那台机器的终端里跑 `claude auth login` / `codex login`（远程会话：会话面板里的 🔑 登录），再试一次。」原文留在 `err.data`，错误码不变。测试 A8 |
| A8b | `acp-client.ts:426`；`engines.ts` `resolveAdapter` 非 Windows 退回 PATH 上的裸名字 | macOS / Linux 本机没装适配器 | `spawn claude-agent-acp ENOENT` | 和 Windows 上一样说「装哪个包」 | 中 | **已修**：本机非 kiro 的 spawn ENOENT 换成 `adapterMissingMessage`（和 Windows 那句同一个文案）。测试 A8 |
| A5 | `acp-client.ts:869`（`handleNotification`）；`index.ts:5084` | Claude 批准 ExitPlanMode 后自己离开 plan 模式、`/model` 换模型等 | `configOptions` 只从 `session/new` / `load` / `set_config_option` 的响应里更新，ACP 的 `config_option_update` / `current_mode_update` 通知没人接，模式 / 模型下拉停在旧值 | 下拉跟着变 | 中低 | **已修**：两种通知更新缓存并发 `config-options`，`wireSession` 重推 `session:engine-models`。只刷新显示，没把适配器自己换的模式写回会话偏好（下次连上仍按用户选的那个设回去）——要不要写回见「需要拍板」。测试 A5 |
| 3.1 | `index.ts` 连接失败路径；`acp-client.ts` `takeEarlyStderr` 只在 `wireSession` 里取 | 适配器一起来就退出（远端没 node、Electron 自带的 node 版本适配器不支持、配置坏了） | 只显示 `Process exited with code 1/127`，stderr 里那句原因没进界面（只在连接成功后才取） | 连接失败时把最后几行 stderr 带上 | 中 | **已修（A12）**：只对 Claude Code / Codex，异常退出的 `Process exited with code N` 后面拼上 stderr 最后三行（去掉远端自报 PID 那行，`adapterExitDetail`）；kiro 那句不变。测试 A12 |
| U3 | `src/main/remotePreflight.ts:45` `REQUIRED_TOOLS = ['kiro-cli']`；`index.ts:13363` `remote:test` | 只为 Claude/Codex 配的远端机器点「测试连接」 | 报「缺 kiro-cli」/「kiro-cli 没登录」；反过来装了 kiro、没装适配器的机器报 OK。真正建会话时是对的（`remoteAdapterCheck`） | 按引擎分别报 | 中 | **已修（A10）**：同一次 ssh 里 kiro 预检之后接两家的 `adapterProbeScript`（fnm / nvm 管的 node 也认，main 的探测逻辑），`judgeTestConnection` 合成结论：kiro 通了照旧算通、多两行适配器情况；kiro 不行但有一家能起也算通，并分别说清三家；都不行时 code / missing 和原来一样；连不上原样。返回结构不变，设置界面照常显示这段文字。测试 A10 |
| 3.2 | `index.ts:3064` `remoteAdapterCheck` | 远端有适配器命令但没有 node / 没登录 | 只查 `command -v` 适配器，报错文案里说「还要登录」但不查 | 顺带查 node 和登录 | 低中 | 已由合进来的 main（`977b349`）解决：`remoteAdapterCheck` 现在走 `adapterProbeScript`，没 node 单独报（`no-node`），没登录 / 没配 Bedrock、API key 时先提示一句（`remoteLoginHint`）。本次复核无问题 |
| 3.3 | `src/main/binDetect.ts:68-85` | 设置里「自动检测三个工具」 | 探测的是 `claude` / `claude-code-acp` / `codex`，不是适配器 `claude-agent-acp` / `codex-acp`；存下的 `bins.claude` / `bins.codex` 起会话时根本不读（本机走 `resolveAdapter`，远端走 `REMOTE_ADAPTER_BIN`）。检测显示 ✓ 也可能起不来，改这两格也没用 | 探测适配器，或者不显示这两格 | 低中 | **已修（A15，按审查意见二选一里的「界面说清实际用途」）**：这两格检测的是 `claude` / `codex` 这两个 CLI，而会话起的是适配器（本机 `resolveAdapter`：`KIROLEX_<引擎>_ACP` 或 npm 全局包；远端 `remoteAdapterProbe`），让启动去读这一格等于拿 CLI 的路径去起适配器，起不来。所以改成标签「claude / codex CLI（仅供参考，会话不读这一格）」，说明写出真正起的是哪个适配器、本机按什么找、能用哪个环境变量覆盖（`KIROLEX_CLAUDE_ACP` / `KIROLEX_CODEX_ACP`，测试核对它就是 `resolveAdapter` 认的那个），去掉已经不对的「KiroLex 只起 kiro-cli」。截图 05 里能看到新标签。测试 A15 |
| 3.4 | `src/renderer/App.tsx:3840` `modelsFor(session)` | 远程 Claude/Codex 会话 | 照样去远端问 kiro 的模型清单（白一次 ssh；没 kiro 的机器上报错被吞掉）。kiro 的模型下拉对它们是隐藏的，所以界面无误 | 非 kiro 不问 | 低 | **已修（A13）**：`modelsFor` 的远程分支先看引擎，Claude Code / Codex 直接返回空（它们的清单来自 engine-models）；本机分支和 kiro 不变。测试 A13 |

**已查，无问题**：模型 / effort / 模式三个下拉都取自适配器的 `configOptions`（`selectOptions` 按 ACP category 认，Claude 的 `effort` 和 Codex 的 `reasoning_effort` 都对得上）；
`setEngineOption` 拒绝 kiro、`switchModelImpl` 拒绝非 kiro；`applyEngineModel` 只设清单里有的值；kiro 的模型可用性缓存（`modelAvailability.ts`）不作用于非 kiro（A2 修掉的是唯一漏网的一处）；
`EngineLoginPane` 按会话的引擎选工具，Claude 会话不会显示 kiro 的登录状态；`ai-login:status` 把「装没装」和「登没登」分开判（`parseClaudeStatus` / `parseCodexStatus`，Bedrock / 自定义网关也认）；
Windows 上 `resolveAdapter` 找不到包时给的是能照着做的那句。

## 4. MCP 转发（forwardMcp、mcpCombos）和记忆注入

| # | 文件:行号 | 触发条件 | 实际表现 | 该有的表现 | 严重 | 状态 |
|---|---|---|---|---|---|---|
| U4 | `index.ts:7307-7330` `sendPromptOnce` 给每一轮前面拼目录说明 / 远程运行环境 / 记忆块 | Claude/Codex 会话里发 `/compact`（上下文用量菜单里就有，`App.tsx:3088`）或 `/clear` | 第一个文本块不是 `/compact` 而是 `<hidden>…` / `[文件位置]…`；适配器多半只在 prompt 以 `/` 开头时当命令，于是当普通文字发给模型，什么都没压缩 / 清空 | 斜杠命令原样送到 | 中 | 待实测（本机没装适配器；kiro 对同样的拼接怎么处理也没验证） |
| 4.1 | `src/main/forwardMcp.ts:245` `forwardableFromCombo` | 远程 Claude/Codex 会话用一个本机能用的组合，其中 http server 没标 `forwardFromLocal`、stdio server 不是本机路径也不在白名单 | 静默跳过，不进 `skipped`，没有提示；模型就是少了这个工具 | 说一声为什么没带上 | 低中 | 未修（代码注释说是有意为之，提示要新文案） |
| 4.2 | `acp-client.ts:443` initialize 结果不看 | 某个适配器版本没声明 `mcpCapabilities.http` | 照样发 `type: 'http'` 的 `kirolex-local`；按规范对方可以拒绝 `session/new` 或忽略，后台任务 / 浏览器 / 本地文件工具没了也没提示 | 看能力再发，或者说一声 | 低 | 待实测（现有注释说两个适配器都声明了） |
| 4.3 | `src/main/memory.ts:214-255`、`src/main/remoteContext.ts` | Claude Code 会话 | 提示词里写的工具名是 `local_write` 等，Claude Code 里实际叫 `mcp__kirolex-local__local_write`；`remoteContext.ts` 还提到 kiro 的 `fs_write` | 按引擎写准 | 低 | 待实测（模型通常能对上，没观察到失败） |

**已查，无问题**：
- 本机 Claude/Codex：`withLocalBrowser` / `ensureLocalTools` 把 `kirolex-local`（`bg_*` / `watch` / `schedule_*` 唤醒工具 + 浏览器工具）作为 ACP `mcpServers` 交给 `session/new` 和 `session/load`（`acp-client.ts` 的 `mcpServers` getter；`tests/engines.test.ts` 守着两处都带），`bg_run` 的 cwd 按会话的 `localDir`。
- 远程 Claude/Codex：不写 kiro 的 agent JSON，`kirolex-local` 走反向隧道 URL，转发的本机 MCP 经 `remoteComboMcpServers` 一起交给适配器；格式符合 ACP（http：`{type,name,url,headers:[{name,value}]}`，stdio：`{name,command,args,env:[{name,value}]}`）。
- 组合（mcpCombos）只作用于非 kiro（`setDormantProfile` 的 notKiro 判断）；组合里的 effort 经 `applyComboEffort` 设，设不上会退回默认并说一句。
- 记忆注入：`buildMemoryInjection` 每一轮都拼，和引擎无关；远程会话的记忆块写的是「用 `local_write` 写」（记忆文件在本机）。
- 远程写文件闸 `remoteWriteGuard` 对非 kiro 远程会话同样接上（权限那一层拒 + 不来问的模式事后认出来给「复制到本机」）。

## 5. 控制入口（controlSessions）和会话请求状态（sessionRequestStatus）

| # | 文件:行号 | 触发条件 | 实际表现 | 该有的表现 | 严重 | 状态 |
|---|---|---|---|---|---|---|
| — | `POST /sessions/:id/new-backend` → `swapBackendSessionWhenIdle` → `recreateBackendSession` | 对 Claude/Codex 会话换新后端 | 新后端丢了模型 / effort / 模式 | — | 高 | **已修**（即 A1） |
| 5.1 | `src/renderer/App.tsx:3350` `handleControlSend` → `steerRoute.enterRoute` | 外部调用方 `mode: 'auto'` 往一条正在跑的 Claude/Codex 会话发消息 | 和在输入框按 Enter 一样走 steer → 被拒 `unsupported` → 标红等人点「作为下一条发送」；调用方拿到 `{routed:'steer', steerFailed:'unsupported'}`，消息不丢但要人手处理 | 自动调用方可能更想要「排进队列」 | 低 | 未修（和 AGENTS.md §4.2「Enter 永远 steer」的既定语义一致，要不要对控制入口例外需要拍板） |

**已查，无问题**：`controlSessions.ts` 的 list / status / tail 不看引擎，读的是 KiroLex 自己的记录和 transcript；`newBackend` 按 id 现取 entry（除 A1 外无引擎相关逻辑）；
`busySessions.collectBusySessions` 引擎无关；`src/renderer/sessionRequestStatus.ts` 的忙 / 失败原因按会话记，Claude/Codex 的模型 / 组合下拉都经它（`docs/session-isolation-audit.md` §1 那次修的），本次复核无问题。

## 6. 其他写死 kiro-cli 行为、对另外两家不成立的地方

| # | 文件:行号 | 触发条件 | 实际表现 | 该有的表现 | 严重 | 状态 |
|---|---|---|---|---|---|---|
| U1 | `index.ts:810` `runLiteOneShot`（调用：`:897` `maybeConsolidateSessionMemory`、`:11041` `app:generate-title`、`app:generate-suggestions`） | 只装了 Claude Code / Codex 的机器；或者任何 Claude/Codex 会话 | 永远用 kiro-cli `chat --no-interactive` 跑。没配 kiro → 标题、输入建议、会话记忆整理静默不工作（只进日志），整理失败不推进 `memoryConsolidatedAt`，于是每轮都重试一次；配了 kiro → Claude 会话的内容被发给 Kiro 的模型、花 Kiro 的额度 | 用会话自己的引擎跑，或者明确跳过并说一声 | 中 | **已修（A14，按审查意见二选一里的「明确提示并跳过」）**：Claude Code / Codex 会话的这三样都不再起 kiro-cli（`skipLiteHelperFor` → `engines.ts` 的 `liteHelperSkipReason`）：会话内容不再交给另一家；记忆整理在读记忆、调 `runLiteOneShot` 之前就返回，不再每轮失败重试；标题 IPC 带上会话 id，被跳过时渲染层直接用第一条消息当标题（不再空等三次）；追问建议返回空，输入框上面照常是固定的那几条。每条会话第一次跳过时在会话里说一句（截图 02），之后静默。kiro 会话、以及没带会话 id 的老调用照旧跑。没有改成「用那家适配器跑」：那要为每个标题 / 建议另起一个适配器进程、记在那家的额度上，见文末「需要拍板」。测试 A14 |
| U2 | `src/main/remoteLocalTools.ts:275` `orphanSweepScript`、`:315` `staleExecutorSweepScript`；`index.ts` `sweepStrayLocalSsh(Windows)`；`acp-client.ts` `buildRemoteAdapterCommand` | 远程 Claude/Codex 执行器在 KiroLex 崩溃 / 被杀 / 断网时没走 `disconnect()` | 两个远端清扫只认 kiro 的 per-session agent 前缀（只出现在 kiro 的 `--agent` 参数里）或 `kiro-cli acp`；适配器命令 `exec claude-agent-acp` 没有任何标记，孤儿进程（连同它起的 `claude` CLI、MCP、shell）永远扫不到。Windows 本机的残留 ssh 也认不出 | 适配器命令带一个可识别的标记，两边清扫都认 | 中 | **已修（A9）**：远端适配器命令先 `export KIROLEX_EXECUTOR=<会话 agent 名>`（就是 `sessionAgentName`，带本机 owner 前缀）再 exec —— 整棵进程树都继承它。`sweepRemoteExecutors` 在两道 kiro 清扫之后跑 `adapterSweepScript`：从 `/proc/<pid>/environ` 认标记，按「顶」（父进程不带标记的那个）分组；孤儿 = 顶的父进程是 1，没人持有 = 顶不在持有的 pid 里、会话不在 attach 中、活了 ≥120 s；收的时候连子孙一起（顺带补上 `remoteKillTree` 只收两层的缺口）。同一条会话新旧两个执行器带同一个标记，所以按顶分组、不按标记。本机 Windows 的残留 ssh 清扫看命令行里的 agent 前缀，命令里带上标记后它也认得了。判据那段 awk 在测试里拿假进程表真跑。测试 A9。没在真远端上跑过（这台机器没有可用的远端），脚本只用 `/proc`、`ps -o ppid=,etimes=`、`awk`，非 Linux 上什么都找不到 = 什么都不杀 |
| U5 | `index.ts:5305`、`useAcp.ts` 命令表只认 `_kiro.dev/commands/available` | Claude/Codex 会话里打 `/` | 菜单是空的：ACP 标准的 `available_commands_update` 没人接（`acp:session-commands` 也返回空） | 接上标准通知 | 中低 | **已修（A11）**：`wireSession` 对非 kiro 把 `available_commands_update` 换成 kiro 那份表的形状（`acpCommands.ts` 的 `acpAvailableCommands`：名字补 `/`、`input.hint` 进 `meta.hint`），之后走同一份缓存（`acp:session-commands`）和渲染层同一个 `toSlashCommands`。截图 03。发出去的命令能不能生效仍取决于 U4（待实测） |
| 6.1 | `acp-client.ts:443` `initialize` 发 `capabilities: {}` | — | ACP 字段名是 `clientCapabilities`；发了个对方不认的字段，等价于「什么能力都不声明」——这正是想要的（不让适配器走客户端读写文件 / 终端） | — | — | 已查，无问题（结果正确，只是字段名不对） |

---

## 本次已修 —— 改了哪里、怎么测

| # | 改动 | 测试（`tests/engineAuditFixes.test.ts`） |
|---|---|---|
| A1 | `index.ts` `recreateBackendSession`：非 kiro 在 `newSession` 后 `await applyEngineModel` | 「A1 …」源码接线 |
| A2 | `index.ts` `swapSessionModel` 开头非 kiro 返回 null；prompt 路上两处条件先判 kiro | 「A2 …」源码接线 |
| A3 | `staleSession.ts` 新增 `persistentBackend`；`index.ts` 传 `backendPersistsSessions(engine)` | 「A3 …」纯函数 + 接线 |
| A4 | `engines.ts` 新增 `backendPersistsSessions` / `contextMarkerHolds`；`contextEstablished` 和 attach 判据改用它（kiro 判据逐字等价） | 「A4 …」纯函数 + 接线 |
| A5 | `acp-client.ts` 接 `config_option_update` / `current_mode_update`，发 `config-options`；`wireSession` 重推下拉 | 「A5 …」真 `AcpClient` 喂通知 + 接线 |
| A6 | `acp-client.ts` `cancelPrompt`：非 kiro 把挂着的权限请求答成 cancelled；新增 `awaitingPermission` | 「A6 …」真 `AcpClient`（含 kiro 不变） |
| A7 | `index.ts` 看门狗：非 kiro 有权限请求在等时不计静默 | 「A7 …」源码接线 |
| A4b | `engines.ts` `backendHeldAtTurnStart`；`index.ts` 发送前记 `heldBackendAtStart`、成功结束且后端没换时 `markContextEstablished` | `engineAuditFixes2`「A4b …」状态顺序 + 接线 |
| A9 | `remoteLocalTools.ts` `ADAPTER_TAG_ENV` / `adapterVictimsAwk` / `adapterSweepScript` / `parseAdapterSweep`；`acp-client.ts` `buildRemoteAdapterCommand` 带标记；`index.ts` `sweepRemoteExecutors` 多扫两遍 | `engineAuditFixes2`「A9 …」（awk 真跑假进程表） |
| A10 | `remoteAdapterProbe.ts` `testConnectionScript` / `splitTestOutput` / `adapterTestLine` / `judgeTestConnection`；`index.ts` `remote:test`；中文表补 6 条 | `engineAuditFixes2`「A10 …」 |
| A14 | `engines.ts` `liteHelperSkipReason`；`index.ts` `skipLiteHelperFor` 接在记忆整理 / 标题 / 追问建议三处；`preload.ts` + `App.tsx` 类型 + `useAcp.ts` 标题调用带会话 id、被跳过直接取第一条消息；中文表补一条 | `engineAuditFixes3`「A14 …」 |
| A15 | `RemoteSettings.tsx` 两格的标签和说明；中文表换成新的三条 | `engineAuditFixes3`「A15 …」 |
| A12 | `acp-client.ts` `adapterExitDetail`，只拼在非 kiro 的退出码后面 | `engineAuditFixes2`「A12 …」 |
| A13 | `App.tsx` `modelsFor` 远程分支先看引擎 | `engineAuditFixes2`「A13 …」 |
| A11 | 新文件 `src/main/acpCommands.ts`；`index.ts` `wireSession` 换形状 | `engineAuditFixes2`「A11 …」 |
| A8 | `engines.ts` 新增 `isAuthRequiredError` / `adapterAuthMessage` / `adapterMissingMessage`；`acp-client.ts` 请求错误和 spawn ENOENT 两处换成能照着做的那句；中文表 `uiTextZh/modulesB.ts` 补一条 | 「A8 …」纯函数 + 真 `AcpClient`（含 kiro 不变） |

## 截图（模拟数据）

本机没装真的适配器，截图用的是一个按 ACP 协议回话的**假 Claude Code 适配器**（`KIROLEX_CLAUDE_ACP` 指向它，只在截图时用，没进仓库），
在一个临时的家目录里起应用（没碰真的 `~/.kirolex/`）。截图在 `.agent-board/screenshots/`：

1. `01`：连上后 —— 权限模式按 KiroLex 的默认设成 Bypass Permissions，模型 Opus（来自适配器的 configOptions）。
2. `02`：发一条消息，假适配器在这一轮里自己发 `current_mode_update`（→ Accept Edits）和 `config_option_update`（模型 → Sonnet）—— 左下模式、右下模型都跟着变了（A5；修之前停在 Bypass / Opus）。
3. `03`：打 `/` 弹出适配器发来的 `/compact`、`/review <pr number>`、`/init`（A11；修之前是空的）。
4. `04`：假适配器回 `auth_required`（-32000）—— 界面上说「跑这条会话的那台机器上 Claude Code 还没登录，在那台机器的终端里跑 `claude auth login`…」（A8；修之前只有 `Authentication required`）。

5. `05`：设置 → 🖥 机器 → 填一台机器 →「测试连接」。这一张的 ssh 是**假的**（一个只会打固定探测输出的 `ssh.exe`，放在截图用的 PATH 最前面，没进仓库），模拟「没装 kiro-cli、Claude Code 适配器装好并登录、没装 Codex」：结果分四行完整显示 —— 连得上 / Claude Code：可以用 / Codex：没装适配器（codex-acp）/ Kiro：缺 kiro-cli（原来的那句）。同一张里能看到 A15 的新标签「claude CLI（仅供参考，会话不读这一格）」。

截图 02–04 里还能看到 A14 那句一次性的说明，和直接取第一条消息的标题。远端清扫（A9）要一台真的远端，没截图，靠测试覆盖。

## 需要拍板

1. **辅助小任务要不要改用会话自己的引擎跑**（A14 现在是「跳过并说一声」）：改的话每个标题 / 追问建议 / 记忆整理都要另起一个 Claude Code / Codex 适配器进程、记在那家的额度上；不改则这三样对这两种会话一直关着（标题取第一条消息，记忆可以手动编辑）。
2. **适配器自己换的模式要不要写回会话偏好**（A5 现在只刷新显示）：写回的话下次连上沿用它换过的模式（例如批准计划后离开 plan）；不写回则每次连上都回到你在下拉里选的那个。
3. **控制入口往正在跑的 Claude Code / Codex 会话发 `auto`**（5.1）：现在和按 Enter 一样标红等人处理；要不要对控制入口例外、直接排进队列。
