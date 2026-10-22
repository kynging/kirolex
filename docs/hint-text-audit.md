# 提示文案审计：写死「Kiro / kiro-cli」的地方（2026-10-22）

KiroLex 有三种引擎（kiro-cli / Claude Code / Codex），很多提示是只有 kiro 时写的。这一次把面向用户的提示里
带 kiro / Kiro / kiro-cli / `~/.kiro` 字样的词条逐条过了一遍（只写 KiroLex、`~/.kirolex` 的是应用自己的名字，不算）。

范围：渲染层 `src/renderer/**` 的 `t('…')` 原文 + `src/renderer/i18n.ts` 基础表 + `src/renderer/i18nZh/*`；
主进程 `src/main/uiText*.ts` / `uiTextZh/*` 以及主进程发给会话的 notice / 抛给界面的报错。

结论标记：**改** = 这次改了；**不改** = 只在 kiro 路径出现 / 说的就是 kiro，写了理由；**记录** = 有问题但这次不改（和排队任务撞、或要动行为），写了原因。

渲染层判 kiro 的依据：`ChatArea.tsx` 的 `nonKiro = !!engine && engine !== 'kiro'`，输入框下面那一排在 `nonKiro` 为假时才走 kiro 分支
（agent 下拉、Credits、kiro 模型下拉）。会话记录里 `engine` 缺省 = kiro。

引擎名的写法：新加的 `src/renderer/engineLabel.ts`（和主进程 `engines.ts` 的 `ENGINE_LABEL` 同一份名字；那个文件 import 了 fs，渲染端用不了）。
`engineLabel()` 给「Kiro / Claude Code / Codex」，`engineCliName()` 在 kiro 会话里给「kiro-cli」——这样 kiro 会话看到的文案和原来一字不差。

---

## 一、改了的（Claude Code / Codex 会话里会出现）

| # | 原文（英文 key） | 出现位置 | 在哪些引擎 / 场景出现 | 问题 | 改成 |
|---|---|---|---|---|---|
| 1 | `Sent, waiting for Kiro to respond…`（中：已发送，等待 Kiro 响应…） | `src/renderer/hooks/useAcp.ts:4066` `sendMessage`；中文 `i18nZh/chat.ts:90` | 三种引擎每次发送后的状态行 | Claude Code / Codex 会话里也说「等待 Kiro」 | `Sent, waiting for {engine} to respond…` / 「已发送，等待 {engine} 响应…」，`{engine}` 按这条会话的引擎（kiro 会话仍是「Kiro」） |
| 2 | `Kiro CLI will summarize older conversation context … inside this active Kiro session.` | `src/renderer/App.tsx:4807`；中文 `i18nZh/shell.ts:162` | 点占比条 →「管理上下文 → 压缩」。占比条只看 `usage`，Claude Code / Codex 的 `usage_update` 也会让它亮（docs/claude-code-feature-audit.md 9b） | 写死 Kiro CLI | `{engine} will summarize … inside this active {engine} session.`；kiro 会话仍是「Kiro CLI」，另外两家是引擎名（`usageEngineName`） |
| 3 | `Kiro CLI will discard the active conversation context, and KiroLex will clear the currently displayed history. …` | `App.tsx:4809`；中文 `shell.ts:164` | 「管理上下文 → 清空」，同上 | 同上。后半句「KiroLex 也会清掉当前显示的历史」核对过是真的（`handleSendMessage` 的 `/clear` 分支先 `markCleared` 再 `clearConversation`） | `{engine} will discard …` |
| 4 | `Files stay local. The remote kiro-cli reads and writes the files on this machine through a tunnel (nothing is copied).` | `App.tsx:4675`（新建会话对话框）；中文 `shell.ts:28` | 只看选没选远端机器（`newChatRemoteId`），不看选的引擎 | 选 Claude Code / Codex + 远端时也说 kiro-cli。隧道那半句对三家都成立（`acp-client.ts` 的 `-R`） | `The remote {engine} reads …`，`{engine}` = `engineCliName(newChatEngine)` |
| 5 | `This chat’s kiro-cli runs on {host}; the files stay on this machine. …` | `src/renderer/components/Sidebar.tsx:384`（侧栏 🌐 远端标签的悬停提示）；中文 `shell.ts:37` | 只看 `session.remoteHost` | 远程 Claude Code / Codex 会话也说 kiro-cli | `This chat’s {engine} runs on {host}; …`，`engineCliName(session.engine)` |
| 6 | `Estimated from the visible question and answer; Kiro CLI does not expose exact per-turn token counts.` | `src/renderer/components/ChatArea.tsx:1068`（每条回复 token 估算的悬停提示）；中文 `chat.ts:207` | 三种引擎（只看 `estimatedTokens`） | 写死 Kiro CLI。三家都不给「每一轮」的精确数（Claude Code / Codex 的 `usage_update` 是累计的上下文占用） | `…; the engine does not report exact per-turn token counts.` /「…；引擎不提供每一轮的精确 token 数。」（`MessageItem` 拿不到引擎，用不点名的说法；kiro 会话里这一句从「Kiro CLI」变成「引擎」） |
| 7 | `Kiro CLI commands`（屏幕阅读器标签） | `ChatArea.tsx:2207` 斜杠命令菜单的 `aria-label`；中文在 `i18n.ts:140` 基础表 | 三种引擎（命令来自 ACP 的 `available_commands_update`） | 写死 Kiro CLI | `Slash commands` /「斜杠命令」 |
| 8 | `This is the copy the kiro-cli on this machine reads` | `src/renderer/components/KiroConfigPanel.tsx:156`；中文 `settingsPanels.ts:273` | kiro 的 agent 配置编辑器，**以及** Claude Code / Codex 的配置面板（`ChatArea.tsx` `engineConfigOpen && nonKiro` 也渲染这个组件） | Claude Code 面板里的 `~/.claude/...` 也说「kiro-cli 读的」 | `This is the copy the {engine} on this machine reads`，按分类自带的 `engine`（主进程 `CategorySpec.engine`，经 IPC 原样过来；渲染端接口补上这个字段） |
| 9 | ` or right-click → "Run on" lets a session run its kiro-cli on that machine. ` | `src/renderer/components/RemoteSettings.tsx:425`（设置 → 机器 顶部说明）；中文 `settingsPanels.ts:162` | 设置页，不分引擎 | 三家都能跑在远端 | ` or right-click → "Run on" lets a session run on that machine. ` /「或右键「运行位置」就能让某条会话跑在那台机器上 ——」 |
| 10 | `Enter the names used under mcpServers in your Kiro agent file (e.g. mx-ds-mcp). In remote Kiro sessions their requests are sent from this machine: …` | `src/renderer/components/ForwardMcpSettings.tsx:65`；中文 `i18n.ts:181` 基础表 | 设置 → 机器 →「远程会话从本机转发的 MCP」 | 名单对远程 Claude Code / Codex 会话同样生效（`index.ts` `adapterForwardPlan` 的 `list: loadForwardMcpList()`）；「定义在 Kiro agent 文件里找」那半句是对的（`localKiroMcpSources`），保留 | `In remote sessions (Kiro, Claude Code and Codex alike) …` /「远程会话里（Kiro、Claude Code、Codex 都一样）…」 |
| 11 | `kiro-cli sent an unknown request \`{method}\`; KiroLex replied {}. …` | `src/main/acp-client.ts:960`；中文 `uiTextZh/modulesB.ts:38` | 执行器发来 KiroLex 不认识的请求，不分引擎（`handleAgentRequest` 的 else 分支） | 适配器发的也说 kiro-cli | `{engine} sent an unknown request …`，kiro 仍是「kiro-cli」，另外两家是 `ENGINE_LABEL` |
| 12 | `{label} is managed by kiro-cli and cannot be edited here.` | `src/main/kiroConfig.ts:211` `validateContent`；中文 `modulesB.ts:103` | 只读分类：kiro 的 Powers，**以及 Claude Code 的 Plugins**（`claude-plugins`）。界面上已经不让改，只有直接调 IPC 才走到 | Claude Code 的插件不归 kiro-cli 管 | `{label} is managed by {owner} …`，`owner` 按分类的引擎（kiro-cli / Claude Code / Codex） |

两套语言同步改了：英文原文换了的，中文表里的 key 一起换（`tests/i18nCoverage.test.ts` 继续守着）。

## 二、不改：只在 kiro 路径出现，或者说的就是 kiro

| 原文（英文 key，节选） | 中文表位置 | 使用位置 | 为什么不改 |
|---|---|---|---|
| `Agent (switching restarts this chat's executor with the selected Kiro agent)` | `chat.ts:251` | `ChatArea.tsx:5012` | 在 `nonKiro ? … : (agent 下拉)` 的 kiro 分支里 |
| `Kiro Agent configurations` / `Kiro Agents` | `chat.ts:266` / `:268` | `ChatArea.tsx:5146` / `:5165` | agent 编辑器只从 kiro 分支的按钮打开（`kirolex:open-agent-config` 事件没人发） |
| `This resets the Credits counter … or Kiro credit records.` | `shell.ts:166` | `App.tsx:4810` | 只能从 Credits 按钮进，按钮包在 `{!nonKiro && …}` 里（F3） |
| `kiro launch command` / `Empty = use kiro-cli from PATH…` | `settingsPanels.ts:143-144` | `RemoteSettings.tsx:195` | 这一格本来就是 kiro 的启动命令 |
| `Which command launches kiro / claude / codex on each machine…` | `settingsPanels.ts:158` | `RemoteSettings.tsx:424` | 三家都点名了，准确 |
| `Empty = look in the usual install locations… two kiro-cli installs…` | `settingsPanels.ts:167` | `RemoteSettings.tsx:449` | 说的是 kiro 那一格 |
| `Install kiro-cli / claude code / codex on this machine…` / `Installing AI tools on {host}… (the kiro-cli package is several hundred MB…)` | `settingsPanels.ts:191` / `:199` | `RemoteSettings.tsx:545` / `:563` | 说的就是要装的东西，准确 |
| `kiro-cli not updated / update failed / updated / already up to date` | `settingsPanels.ts:152-155` | `RemoteSettings.tsx:403-405` | 「安装 AI 工具」之后那一步就是更新 kiro-cli（`kiroUpdate`）。只配了 Claude Code / Codex 的机器上可能看到「kiro-cli 没更新：还没有设置 … kiro 启动命令」——字面是真的，没核实是否会出现，记在第三节 |
| `🧩 Kiro skills` / `These files belong to kiro` / `~/.kiro/skills/<name>/SKILL.md` | `settingsPanels.ts:302/307/312` | `SkillDialog.tsx:118/146/156` | 这个对话框现在打不开（`setShowSkill(true)` 没有调用点） |
| `Run with kiro-cli (kiro’s models and agents)` | `shell.ts:45` | `Sidebar.tsx:1304` | 「切到 Kiro」那一项的说明 |
| `kiro-cli trace logging is **on**…` / `kiro trace logging is on…` | `shell.ts:59-61` | `Sidebar.tsx:1539-1540` | trace 只对 kiro 有效（`acp-client.ts` `engine === 'kiro'`） |
| `\nNo Claude model and no \`auto\` in the list… (switching kiro-cli versions won't help)…` | `uiTextZh/indexA.ts:8` | `index.ts:649` `connectWithModelFallback` | 非 kiro 提前返回 |
| `No kiro launch command is set for {host} yet (Settings → 🖥 Machines).` | `indexB.ts:38` | `index.ts:9539`（`kiro:list-agents`）、`:11486`（`acp:list-models`） | 远程 Claude Code / Codex 会话也会调 agent 清单，但渲染端吞掉了错误（`App.tsx` `refreshAgents` / `refreshModels` 的 `catch {}`），不上屏 |
| `{where} has no config file for {name} (~/.kiro/agents).` | `indexB.ts:42` | `index.ts:9730` | 只从 kiro agent 编辑器进 |
| `kiro sessions do not go through this path` | `indexB.ts:58` | `index.ts:10069` / `:10708` | 只在 kiro 会话误走到引擎选项那条路时抛，正常看不到 |
| `A kiro agent only applies to Kiro sessions.` | `indexB.ts:64` | `index.ts:10297` / `:10301` | 本来就是对非 kiro 说的，准确 |
| `{host} did not report a model list (does its kiro-cli version not support this probe?)` | `indexB.ts:89` | `index.ts:11516` | kiro 模型清单；渲染端吞掉错误 |
| `No kiro launch command is set for {host} yet.` | `indexB.ts:154` | `index.ts:14039` `kiro:update` | 只在更新 kiro-cli 这一步 |
| `Kiro: {why}` | `modulesB.ts:9` | `remoteAdapterProbe.ts:387`「测试连接」 | 说的就是 kiro 那一项的结果 |
| `No kiro launch command is set for **this machine** yet…` / `…for {host} yet. Open Settings…` / `kiro-cli not found. Tried these…` | `modulesB.ts:28-33` | `acp-client.ts:312/323/342`（`connect()` 的 kiro 分支；非 kiro 在 `:272` 就分走了）、`index.ts` `runLiteOneShot` / `runKiroCli` | 只在 kiro 路径；轻量任务对非 kiro 已跳过（`skipLiteHelperFor`） |
| `Auto title, follow-up suggestions and session-memory tidying run on Kiro, so they are off for this {engine} session…` | `modulesB.ts:63` | `engines.ts:231` `liteHelperSkipReason` | 本来就是对非 kiro 说的，准确（这些确实用 kiro 跑） |
| `no definition for it in the local Kiro agent files or ~/.kiro/settings/mcp.json` | `modulesB.ts:76` | `forwardMcp.ts:405` → `index.ts` 会话 notice | 远程 Claude Code / Codex 会话会看到，但说的是真的：定义就是去本机 Kiro 配置里找（`localKiroMcpSources`） |
| `Installed Powers, managed by kiro-cli…` / `kiro-cli settings (default model…)…` | `modulesB.ts:92-93` | `kiroConfig.ts:92/96` | kiro 的分类 |
| `User-level standing instructions: every session reads it (same purpose as kiro's Steering).` | `modulesB.ts:95` | `kiroConfig.ts:112`（CLAUDE.md） | 有意拿 kiro 做类比，准确 |
| `{host} is missing {tools}…` / `kiro-cli on {host} is not logged in…` / `{host}: kiro-cli is installed and logged in…` | `modulesB.ts:166-171` | `remotePreflight.ts:176/190/191` | 会话里的预检只在 kiro 分支调（非 kiro 走 `remoteAdapterCheck`）；「测试连接」里说的就是 kiro 那一项 |
| `Clashes with the local tool channel kirolex-local` 等只含 `kirolex` 的 | — | — | 应用自己的名字，不在范围内 |

## 三、记录：有问题，这次不改

| 原文 / 现象 | 位置 | 问题 | 为什么不改 |
|---|---|---|---|
| `Cannot connect to {host}: {why}. {hint} (kiro-cli and the files for this machine live on it, so nothing runs without a connection).`（及不带 `{hint}` 的那句） | `remotePreflight.ts:150/157`；中文 `modulesB.ts:154-157` | 会话里只在 kiro 分支出现；但「测试连接」连不上时对只配了 Claude Code / Codex 的机器也原样给出（`remoteAdapterProbe.ts:383`）。另外「文件都在它上面」和「文件永远在本机」的设计不符（远端只有草稿目录） | 排队任务 036d815c（SSH 会话数满的报错翻译）要动这几句的 `{hint}` / 原因部分，避免冲突 |
| `SSH connection closed (ssh exit {code}): remote port {port} is in use … a leftover kiro-cli on that machine may hold the port.` | `transientError.ts:45` `sshDropMessage`；中文 `modulesB.ts:217` | 远程 Claude Code / Codex 也用同一条 `-R` 隧道，残留的会是适配器进程 | 同样是 SSH 报错那一片，留给 036d815c 一起改 |
| 会话报错后面追加的「kiro-cli 日志：…」/「kiro-cli 报了错。」 | `index.ts:8269` `cliErrorContext` → `kiroCliLog.ts:102/112`；中文 `modulesB.ts:84-85` | 没按引擎区分：Claude Code / Codex 会话出错时，如果 30 秒内有 kiro 会话写过错误日志，那句 kiro-cli 的原因会被拼到这条无关的报错后面 | 要改的是「什么时候去读 kiro 日志」（行为），不是文案 → 需要拍板 |
| 历史快照开头「以下是本会话之前的对话记录（由 KiroLex 保存并恢复；kiro-cli 不持久化 ACP 会话…）」 | `index.ts:1515-1516` `buildSnapshot` | 发给模型的上下文，不是界面提示；换引擎后随首条消息带过去时，Claude Code / Codex 会读到「kiro-cli」。在「已发送的上下文」快照里用户也看得到 | 不是提示文案，改了会影响发给模型的内容 → 记录 |
| `kiro-cli not updated: No kiro launch command is set for {host} yet.` | `RemoteSettings.tsx:403-405` + `index.ts:14039` | 只配了 Claude Code / Codex 的机器跑完「安装 AI 工具」后可能看到这一句，像是出错了 | 没实测确认会不会出现；要改得先确认 `bootstrap()` 什么时候调 `kiroUpdate`（行为） |
| `Combo "{id}" does not exist on this machine; running as General`（已按通用运行）等四句 | `chat.ts:168-171`，`indexA.ts:23` | 「已按通用运行」是否和实际一致属于组合下拉那块 | 排队任务 cfcd2d52（组合下拉 / 通用）会动，只记录 |
| `this engine cannot add to a running turn`（这个引擎不支持往正在跑的一轮里追加） | `chat.ts:233` | Claude Code / Codex 忙时按 Enter 的失败说明 | 排队任务 d0a22e82（忙时 Enter 走 `_session/steering`）会改「追加指令」这批文案，只记录 |

## 四、切换失败的 ✗（顺带说明）

Claude Code / Codex 的模型 / 组合下拉右边原来只有一个红色 ✗：原因只在悬停提示里、关不掉、只有下一次切换才清。现在：

- 失败时在这条会话的状态行说一句：「⚠️ 切换组合失败：<原因>」（模型 / effort / 权限模式同理）。原因 = `cleanIpcError` 去掉 Electron 那层 +
  `messageVariants` 换成当前语言；主进程的报错本身已经是「换组合「x」失败（…）」那整句时不再套一层（`sessionRequestStatus.ts` `switchFailureNotice`）。
- ✗ 旁边写「切换失败」，悬停看原因，点一下关掉（`dismissErr`）。
- 这条会话之后成功连上（全局 `status === 'connected'`，且它的执行器挂着、不在连接中；**按会话**看从没连上变成连上，后台恢复的会话也算）或者切换成功时自动清（`clearErrOnReady`、`runSessionRequest` 开始时清）。
  原来是「连接状态一变就清」：掉线也会清，一直连着又一直挂着。
