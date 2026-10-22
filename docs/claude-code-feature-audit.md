# Claude Code 功能逐项实测审计

上一轮（`docs/engine-audit-claude-codex.md`，提交 e764806）主要靠读代码，看的是会话生命周期、权限、MCP 转发、控制入口这些
「运行模式」层面的事。这一轮按功能逐项看 Claude Code 在 KiroLex 里好不好用，**尽量用真实适配器跑**：

- 适配器：`@agentclientprotocol/claude-agent-acp` 0.88.0（看板机器 `D:\ab\tools\npm-global`，已登录），模型切到 haiku 控制花费。
- 集成脚本：`scripts/claude-feature-probe.mjs`（只手动跑，不进 `npm test`；不含任何凭证，用 Claude Code 自己的登录）。
  它和 `src/main/acp-client.ts` 说同一套 NDJSON / ACP，把每一帧原样写进 `PROBE_LOG`，每步打一段摘要。
  用法：`PROBE_STEPS=tools,plan,task PROBE_LOG=/tmp/cc.log node scripts/claude-feature-probe.mjs`（步骤名见脚本头注释）。
  这次一共跑了三轮（约 30 次 prompt，单次 0.03 美元上下），关键样本在文末附录。
- 跑不了界面的地方，用适配器真实发出的帧去对照渲染层的处理代码（`useAcp.ts` 的 `onUpdate`、`ChatArea.tsx` 的各个面板）。
- 行号是本次提交后的（会漂；函数名可以直接 grep）。

**结论写法**：正常 / 有 bug（已修）/ 有 bug（只记录）/ 无法验证（写了原因）。已修的每条都有测试；只记录的写了为什么没动。
所有修复都不改 kiro-cli 的行为（kiro 走的分支逐字不变，测试里有「kiro 照旧」的断言）。

## 总表

| # | 功能 | 结论 | 严重 | 状态 |
|---|---|---|---|---|
| B1 | 没建成的新会话右键换机器 / 目录 / 引擎：冷记录丢了引擎和机器，「远程 Codex」悄悄变本机 kiro | 有 bug | 高 | **已修** |
| B2 | 本机 Claude Code 会话 attach 失败，主进程日志一行都没有 | 有 bug | 中 | **已修** |
| F1 | 批准计划（ExitPlanMode）：「⟲ 总是允许」实际是「清空上下文并跳过所有权限」，另外两个选项看不到 | 有 bug | 高 | **已修** |
| F2 | 分叉 / 复制一条 Claude Code 会话，新会话建成了 Kiro 会话 | 有 bug | 中高 | **已修** |
| F3 | Claude Code / Codex 会话的用量栏永远显示「0.00 credits」（kiro 的计费口径） | 有 bug | 低 | **已修** |
| 1 | 模型下拉（来自 configOptions）、切换生效、重连保持 | 正常 | — | — |
| 1b | effort：没有独立下拉，只能经「组合」设；haiku 上适配器不给 effort 选项、设了报 Internal error | 有 bug（只记录） | 低 | 待拍板 |
| 2 | 权限模式 default / acceptEdits / plan / bypassPermissions 的切换和显示；批准计划后离开 plan，下拉跟着变 | 正常（显示）；离开 plan 不写回偏好 | 低 | 上轮已列入拍板 |
| 2b | 批准计划时看不到计划正文（权限条只有标题「Approve Plan」） | 有 bug（只记录） | 中 | 待拍板 |
| 3 | 工具调用标题 / 状态 / locations / 文件链接 | 部分正常 | — | — |
| 3a | Read / Grep / WebFetch / WebSearch / Task 等不改文件、不跑命令的工具在对话里完全不留痕（只在运行时闪一下状态行） | 有 bug（只记录） | 中 | 待拍板 |
| 3b | Edit 的 diff 只显示 `newText`，`+/-` 是行数差：`alpha → beta` 显示成一行 `beta`、没有加减 | 有 bug（只记录） | 中 | 待拍板 |
| 3c | 失败的命令「失败」标记不是红色（CSS 只给文件面板里的 `stat-del` 上了色） | 有 bug | 低 | **已修**（Claude / Codex 会话） |
| 3d | 停止之后，被打断的命令永远显示「运行中」（Claude 不给被取消的工具发最终状态） | 有 bug | 低中 | **已修** |
| 4 | 计划 / 待办（`plan` sessionUpdate，新版 Claude Code 用 TaskCreate / TaskUpdate 产生） | 正常 | — | — |
| 5 | 思考块（`agent_thought_chunk`）显示和折叠 | 正常 | — | — |
| 6 | 附件和图片 | 本机正常（走路径，Claude 用 Read 读图）；远程无法验证 | — | — |
| 7 | 斜杠命令菜单、选中执行、skills / 自定义命令进菜单 | 正常 | — | — |
| 7b | `/compact`、`/clear` 前面拼了记忆块（上轮 U4）还算不算命令 | **实测正常**（两者都生效） | — | U4 关闭 |
| 7c | `/model`、`/usage` 被 KiroLex 按 kiro 拦下：`/model` 什么都不做、`/usage` 去跑 kiro-cli | 有 bug（只记录） | 低中 | 未修 |
| 8 | 取消：跑工具中 / 等权限中 / 子代理跑着时停止，之后下一条能发 | 正常（3d 已修） | — | — |
| 9 | 用量：上下文占比 `used/size` 口径对 | 正常（F3 已修） | — | — |
| 9b | 「管理上下文」确认框写的是「Kiro CLI 会…」 | 有 bug（只记录） | 低 | 未修 |
| 10 | 编辑并重发 / 重试：只截 KiroLex 自己的记录，Claude 后端里旧的那几轮还在 | 有 bug（只记录） | 中 | 待拍板 |
| 10b | 分叉不带源会话的机器（远程会话分叉后落到「新会话默认机器」上） | 有 bug（只记录） | 中 | 未修 |
| 11 | 会话恢复：session/load 回来完整历史，模型记得之前的对话 | 本机正常；远程无法验证 | — | — |
| 12 | 子代理：Task 派出去的工具调用带 `parentToolUseId`，界面上和主线混在一起、不分组 | 有 bug（只记录） | 中 | 待拍板 |
| 13 | 其他写死 kiro 的地方 | 见第 13 节 | — | — |

---

## 已修

### B1 冷记录丢了新建时选的引擎和机器（高）

- **哪里**：`src/main/index.ts:9735` `coldRecordFor`（被 `applySessionTarget`、`switchEngineImpl` 调）。
- **怎么触发**：新建一条「远程 Codex」会话，远端没装适配器 → `acp:new-session` 失败，没有记录 → 右键「运行位置」或换工作目录。
- **原来**：`coldRecordFor` 建的最小记录只带 `projectId`，`engine` 和 `remote` 都没了：这条会话下次连接按本机 kiro 起，界面上没有任何提示
  （实例 `s_1792637464721_r0sfi7`）。换引擎那条路也一样（`before` 按 kiro 算）。
- **现在**：
  - `acp:new-session` 一进来（任何可能失败的步骤之前）就把「选了哪个引擎 / 哪台机器 / 哪个项目」记进 `newSessionIntents`，记录落盘后才清（`index.ts` 搜 `newSessionIntents`）。
  - 侧栏右键「换引擎 / 换运行位置」的 hint 里带上这条会话的 `engine` 和 `remoteId`（`Sidebar.tsx` `coldHintFor`，按侧栏行上的机器名反查 id）。
  - `coldRecordFor` 用纯函数 `coldProfileBits`（`src/main/coldRecord.ts`）合成：先用主进程记下的，再用 hint，都没有才按本机 kiro 建；
    **补不全时在会话里明说一句**（「找不回这条新会话建时选的引擎 / 机器，先按「Kiro · 本地」记下；不对的话在右键菜单里改」），
    选过的远端在设置里已经删掉了也单独说。
- **测试**：`tests/coldRecordEngine.test.ts`（纯函数 5 条 + 接线 3 条）。

### B2 attach 失败没有日志（中）

- **哪里**：`index.ts` `loadSessionImpl`（`acp:load-session`）。
- **原来**：本机 Claude Code 适配器没装时报 `adapterMissingMessage`，异常抛回渲染层，主进程日志停在「本地会话挂上 kirolex-local」，看着像卡住。
- **现在**：attach 的那一份 promise 里 `catch` 写 `logger.warn('attach', …)`：`attach 失败 sessionId=… engine=claude remote=local: <原因>`
  （`index.ts:11859`，格式在 `coldRecord.ts` `attachFailureLine`，原因压成一行），然后照样抛。跟进同一个 in-flight attach 的调用方不会重复记。
- **测试**：`tests/coldRecordEngine.test.ts`（`attachFailureLine` + 接线：在 `attachInFlight.set` 之前、记完照样 `throw`）。

### F1 批准计划的按钮挑错了选项（高）

- **哪里**：`src/renderer/components/PermissionBar.tsx`（现在用 `src/renderer/permissionButtons.ts`）。
- **实测**：plan 模式下 Claude 调 ExitPlanMode，`session/request_permission` 给五个选项（附录 A12）：
  `exit-plan-default`（allow_once，「Yes, manually approve edits」）、`exit-plan-clear-bypass`（allow_always，「Yes, clear context and bypass permissions」）、
  `exit-plan-bypass`（allow_always）、`exit-plan-auto`（allow_always）、`reject`（「No, keep planning」）。
- **原来**：权限条按 kind 各取第一个画三个通用按钮。「⟲ 总是允许」= `exit-plan-clear-bypass` —— 点了会**清空这条会话的上下文并切到跳过所有权限**；
  「跳过权限（不清上下文）」「auto 模式」两个选项根本没有按钮。
- **现在**：同一种 kind 出现不止一个选项时，每个选项各画一个按钮、用适配器给的名字（不翻译，和模型名一样），顺序照适配器给的。
  每种 kind 只有一个时（kiro 的所有请求、Claude 的 Bash / Write / WebFetch）照旧是那三个通用按钮，选哪个 optionId 和原来逐个相同。
- 选项名字很长、一共五个，窄格子里原来的那一排不换行会被挤出右边：逐个列出时给按钮区加 `named`（`global.css` `.permission-bar-actions.named`，占满一行、可换行），三个通用按钮的排版不变。
- **测试**：`tests/permissionButtons.test.ts`。截图 `02-plan-approval.png`（真实 Claude Code 会话、plan 模式、haiku，分屏的窄格子里五个选项都在）。

### F2 分叉 Claude Code 会话变成 Kiro 会话（中高）

- **哪里**：`src/renderer/hooks/useAcp.ts:3218` `duplicateSession`。
- **原来**：分叉 / 复制出来的 `pending_dup_*` 会话首条消息建后端时，引擎读的是 `intendedEngineRef`（`useAcp.ts` 搜 `intendedEngineRef.current.get(pendingId)`），
  而 `duplicateSession` 从来不往里记 → 主进程按「没传 = kiro」建；侧栏那一行也没有引擎徽标。
- **现在**：源会话是 Claude Code / Codex 时记进 `intendedEngineRef`，侧栏行带上 `engine`。kiro 会话的分叉不变。
- **测试**：`tests/claudeFeatureAudit.test.ts` F3（源码接线）。
- 没修的另一半见 10b（机器）。

### F3 「0.00 credits」（低）

- **哪里**：`ChatArea.tsx` 用量栏（搜 `composer-credits`）。
- **原来**：Credits 是 kiro 的计量（`_kiro.dev/metadata` 的 `meteringUsage`），Claude Code 只发 `usage_update`（`used / size / cost`），
  于是 Claude / Codex 会话永远显示「0.00 credits」，旁边还能点「重置」。
- **现在**：非 kiro 会话不显示这个按钮；上下文占比条照旧（口径 `used/size`，对）。
- **测试**：`tests/claudeFeatureAudit.test.ts` F4。截图 `03-claude-usage-no-credits.png` 右边那一格的底栏（只有上下文占比条和模型，没有 Credits）。
- 要不要改成显示 `usage_update.cost`（美元）见「需要拍板」。

---

## 逐项结论

### 1 模型 / effort

- **正常**：模型下拉来自适配器的 `configOptions`（`category: 'model'`，实测选项 `default / sonnet / global.anthropic.claude-fable-5-1 / opus / haiku`，
  `acp-client.ts` `noteConfigOptions`），切换走 `session/set_config_option`，返回的新 `configOptions` 立即生效（实测切到 haiku 后
  `usage_update._meta._claude/model` 就是 haiku）。重连：实测 `session/load` 之后适配器把模型退回 `opus`、模式退回 `default`（附录末尾的 load 结果），
  KiroLex 在 `wireSession` → `applyEngineModel` 里按记录（`profile.engineModels` / `engineOptions`）重新设回去，上一轮 A1 已覆盖新后端会话那条路。
- **1b 有 bug（只记录）**：
  - 没有独立的 effort 下拉（`ChatArea.tsx` 组合下拉那段注释：「组合取代原来的 effort 下拉」），effort 只能经「组合」设。
  - 实测 effort 跟着模型走：sonnet 上有 `default/low/medium/high/xhigh/max`，可设；**切到 haiku 后适配器的 configOptions 里没有 effort 了，
    硬设回 `Internal error`**。组合里带着 effort 的会话换到 haiku 时 `applyEngineModel` 会跳过不在清单里的值（`index.ts` `applyEngineModel` 判 `options` 里有没有），
    不会报错，但组合显示的 effort 实际没生效，界面不说。要不要恢复独立 effort 下拉、换模型后提示 effort 失效 → 拍板。

### 2 权限模式 / plan

- **正常（显示）**：模式下拉（`ChatArea.tsx` `composer-mode-select`）来自 `category: 'mode'`，实测五个值
  `default(Manual) / acceptEdits / plan / auto / bypassPermissions`（比任务里列的多一个 `auto`，下拉照单全收）。KiroLex 默认把 Claude 会话设成
  `bypassPermissions`（`index.ts:5311` `DEFAULT_ENGINE_MODE`）。批准计划后适配器发 `config_option_update` + `current_mode_update`（附录 A7、A8），
  `acp-client.ts` 收了并重推 `session:engine-models`，下拉跟着变（上轮 A5）。
- 离开 plan 后的模式不写回会话偏好，下次重连会被设回 `plan` —— 上一轮文档「需要拍板」第 2 条已列，这次不重复。
- **2b 有 bug（只记录）**：批准计划时权限条只显示 `toolCall.title`（「Approve Plan」），计划正文在 `toolCall.rawInput.plan` / `toolCall.content[0]`
  （附录 A12），`useAcp.ts` `permission_request` 只取 `update.description / tool.description / _meta.trustOptions`，都没有。
  Claude 同时把计划写进 `~/.claude/plans/*.md`（Write，kind edit），这一条会出现在「改动的文件」面板里、能点开 —— 所以不是完全看不到，
  但批准那一刻要自己去翻。权限条里怎么排一大段 Markdown 是界面设计问题 → 拍板。

### 3 工具调用的渲染

实测各工具的 `kind` / 标题（附录 A1–A3）：

| 工具 | kind | 标题（先 → 后） | content | locations |
|---|---|---|---|---|
| Read | read | `Read File` → `Read hello.txt` | content | 有（含 line） |
| Grep | search | `grep` → `grep "world" <目录>` | content | 无 |
| Write | edit | `Preparing file…` → `Write out.txt` | diff（oldText null） | 有 |
| Edit | edit | `Edit` → `Edit out.txt` | diff（只是那一段 old_string → new_string） | 有 |
| Bash | execute | `Terminal` → `echo hi` | content | 无 |
| WebFetch | fetch | `Fetch` → `Fetch https://example.com` | content | 无 |
| Task（Agent） | think | `Task` → 任务描述 | content | 无 |
| ExitPlanMode | switch_mode | `Approve Plan` → `Exited Plan Mode` | content（计划正文） | 无 |
| /compact | think | `Compact conversation` | — | 无 |
| 失败的 Read | read | `Read missing-file.txt` | content（错误文字），`status: failed` | 有 |

- **正常**：标题取最新的非空 title（`useAcp.ts` `tool_call_update` 合并），Write / Edit 进「改动的文件」面板，路径可点（`FileChangePath` → `openPathInApp`），
  Bash 进「运行的命令」面板。Windows 路径（`D:\…`）实测照常。
- **3a 只记录**：只有带 locations / diff、或者 kind 是执行类 / browser 的调用才挂到那一轮上（`useAcp.ts:2406`，主进程落盘同样的判据 `index.ts:5575`）。
  Read 虽然有 locations，但 `FileChangesPanel` 只列 MUTATING kind 的 locations，所以 Read / Grep / WebFetch / WebSearch / Task / ToolSearch
  跑完就**在对话里不留任何痕迹**，只在运行时闪一下状态行。kiro 也是这么设计的（面板名就叫「改动的文件」「运行的命令」），给 Claude 单独加一个
  「工具调用」列表是界面改动 → 拍板。
- **3b 只记录**：`FileChangesPanel` 的 diff 预览只显示 `newText`（`ChatArea.tsx:2729`），`+/-` 是行数差（`diffStats`，`ChatArea.tsx:2406`）。
  Claude 的 Edit diff 只是被替换的那一段（附录 A1：`oldText: "alpha"`、`newText: "beta"`），于是显示成一行 `beta`、没有任何 `+/-`；
  同一个文件改几次只留一条。kiro 给的是整份文件，同一个面板对它是够用的；为了不动 kiro 的显示，没有在这次改。
- **3c 已修**：失败的命令有「失败」标记（`ChatArea.tsx:2544`），但颜色规则原来只有 `.files-item-stat .stat-del`（`global.css:2356`），
  命令 / 浏览器面板里的标记不在 `.files-item-stat` 下，所以不是红的。现在 Claude / Codex 会话的 `chat-main` 带 `data-engine`，`global.css` 加 `.chat-main[data-engine] .files-item-row > .stat-del` 标红；kiro 会话不带这个属性，显示不变。失败的 Read 不进任何面板（3a）。测试 `tests/cancelSettle.test.ts`。
- **3d 已修**：实测停止一轮时 Claude 只回 `stopReason: cancelled`，**被打断的 Bash / Task 不再发最终状态**，停在 `pending`
  （附录 A13；`session/load` 回放里它们才变成 `failed`）。「运行的命令」面板按「不是 completed / failed 就是运行中」（`ChatArea.tsx:2432` `commandStillRunning`）
  把它永远标成「运行中」，落盘的记录里也是。现在非 kiro 的一轮以 `cancelled` 结束时，在 `flushAssistant` 落盘之前用 `settleCancelledToolCalls`（`src/main/cancelSettle.ts`）把还开着的调用收成 `failed`（和适配器自己回放时的状态一致），并给界面推一条 `tool_call_update`（界面因此显示「失败」、状态行的「运行中 · …」也随之清掉）。kiro 的取消路径不动。测试 `tests/cancelSettle.test.ts`。截图 `04-claude-stopped-command.png`：真实 Claude 会话跑 `sleep 40` 时点停止、重启 KiroLex 之后，那一条显示红色「失败」（读的是落盘的记录）。

### 4 计划和待办

- **正常**。这台机器上的 Claude Code 已经没有 TodoWrite 了（实测模型自己说「没有 TodoWrite 工具，有 TaskCreate / TaskUpdate」），
  适配器把 TaskCreate / TaskUpdate 的任务状态转成 ACP `plan`（附录 A6），每次发整份。`useAcp.ts:2452` 整份替换、`PlanPanel` 显示，对得上。
  另：任务没做完时适配器会在**之后每一轮开头**再发一次同样的 plan（实测 `/compact`、`/clear` 那几轮也带着），整份替换下没有副作用；
  `/clear` 之后发的是空 plan，面板会清掉，也对。

### 5 思考块

- **正常**。`agent_thought_chunk`（附录 A4，haiku 每轮都有）进一条以 `💭 ` 开头的临时消息，`MessageItem` 渲染成可折叠的「💭 Thinking」，
  跟着设置 `foldThinking` 自动折叠（`useAcp.ts:2364`、`ChatArea.tsx:965`）。只在流式时显示、不落盘（`useAcp.ts` 持久化时过滤），和 kiro 一致。

### 6 附件和图片

- **本机正常**。KiroLex 从不发 ACP `image` 块：附件 / 粘贴图都变成一段 `<hidden>file:<本机路径>…</hidden>` 文字（`App.tsx:3048`），大图先截到 1500px。
  实测两种都能读到图：直接发 image 块时适配器把图存成文件再自己 Read；发路径时 Claude 用 Read 读那个路径（附录里 `image` 两步都答出「Red」）。
  注意：`initialize` 发的字段名是 `capabilities: {}`（`acp-client.ts:447`，ACP 叫 `clientCapabilities`），不影响结果（缺省就是不提供 fs / terminal）。
- 在 Manual（default）模式下，读 cwd 之外的路径（`~/.kirolex/pasted/…`）会不会每次弹权限：本次在 bypassPermissions 下跑的，**没验证**。
- **远程无法验证**：这台机器没有可用的远端。远程会话里路径是本机路径，远端的 Claude 只能经 `local_read`（MCP 名在 Claude 里是
  `mcp__kirolex-local__local_read`）去读；读不读得到图片取决于 `local_read` 能不能回二进制，没测。

### 7 斜杠命令

- **菜单正常**：`available_commands_update` 实测带了 skills（`superpowers:*`、`dataviz`、`deep-research` 这类）和内置命令，
  经 `acpCommands.ts` 换成 kiro 那份表的形状进菜单（上轮 A11）。选中只是把 `/名字 ` 填进输入框，回车照普通消息发。
- **7b（上轮 U4）实测正常**：KiroLex 发出去的形状是「记忆块、工作目录说明各占一个 text 块，用户的字在最后一个块」（`sendPromptOnce`）。
  实测 `[记忆块][工作目录说明]["/compact"]` 照样触发压缩（出现 `Compact conversation` 工具调用、没有模型回复），`[记忆块]["/clear"]` 之后再问
  「之前问过什么吗」回答「No」—— 都生效。**只有把记忆和命令拼进同一个 text 块才会失效**（实测 `"<memory>…\n\n/context"` 被当成普通消息），KiroLex 不这么拼。
- **7c 只记录**：`/model`、`/agent` 被 `slashPicker.ts:44` `slashIntent` 拦下，走 kiro 的模型清单和 kiro 的模型下拉 ref（Claude 会话里那个下拉不渲染），
  于是 Claude 会话里 `/model` 什么都不做、`/model opus` 报「没有这个模型」；`/usage` 去跑 `kiro-cli chat --no-interactive "/usage"`（`index.ts:11455`）。
  Claude 自己的 `/model`、`/usage` 也就到不了适配器。改成「非 kiro 不拦、原样发」需要先确认 Claude 的这两个命令经 ACP 回来的是什么（`/model` 在适配器的
  `REPLAY_HIDDEN_COMMANDS` 里），没在这次做。

### 8 取消

- **正常**（实测三种都干净停下，下一条都能正常发、正常回复）：
  - 跑 Bash `sleep 40` 中途 `session/cancel` → 立刻 `stopReason: cancelled`；
  - 在 Manual 模式下等 Bash 的权限时取消，同时把挂着的请求答 `cancelled`（上轮 A6 修的就是这一步）→ `cancelled`；
  - Task 子代理里跑着 `sleep 40` 时取消 → `cancelled`，子代理一起停。
- 被打断的工具停在 pending 的问题见 3d（已修）。另：渲染层停止后把那条消息放回输入框、下一次发送是「覆盖重发」（`markTurnInterrupted`），和 kiro 一样，见第 10 项。

### 9 用量和上下文

- **正常**：`usage_update` 实测 `{used, size: 200000, cost: {amount, currency: 'USD'}}`（附录 A5），渲染层 `contextPercent = used/size*100`
  （`useAcp.ts:2537`），不读 kiro 的 `_kiro.dev/metadata`。`/context` 实测 15%，与 `used/size` 对得上。
- 「0.00 credits」已修（F3）。`cost` 没人读。
- **9b 只记录**：点占比条弹的「管理上下文 → 压缩 / 清空」确认框写的是「Kiro CLI 会总结较早的上下文…」（`App.tsx:4782` 一带），Claude 会话里也这么说。
  命令本身对 Claude 是生效的（7b），只是文案。

### 10 消息操作

- **10 只记录**：编辑并重发 / 重试 / 停止后覆盖重发都走 `rerunFromMessage`（`useAcp.ts:4228`）：截短 KiroLex 自己的 transcript，在**同一个**后端会话里重发。
  `useAcp.ts:4276` 的注释说这是接受过的折中（「后端保留它自己的历史」）。对 kiro 影响小；对 Claude 来说适配器的会话是持久的（`session/load` 实测能回来全部历史），
  被编辑掉的那几轮**一直留在 Claude 的上下文里**，重启后也还在。适配器声明了 `sessionCapabilities.fork`，理论上可以从某一轮分叉出新的后端会话，
  但那是新的后端交互，改动面大 → 拍板。
- **分叉**：引擎已修（F2）。历史作为一个 `<hidden>` 块随首条消息带过去，对 Claude 成立。
- **10b 只记录**：分叉不带源会话的机器 —— `duplicateSession` 不记 `intendedRemoteRef`，首条消息时退到「新会话默认机器」（`kirolex-new-chat-remote`）。
  渲染层的会话行只有机器的显示名（`remoteHost`）没有 id，要补得先让 `listDurableSessions` 带出 remote id；kiro 会话也一样受影响，没在这次改。

### 11 会话恢复

- **本机正常**：新进程里 `session/load` 实测回放了全部历史（`user_message_chunk` 10 条、`agent_message_chunk`、`tool_call` 等，附录 A15），
  之后问「我第一次让你回复什么」答对了。KiroLex 不渲染回放（`isReplayOutsideTurn` 丢掉一轮之外的消息块，`index.ts:5418` 一带），界面历史来自本机 transcript，
  不会重复。回放里的工具调用 / `available_commands_update` 在 `wireSession` 之前到达、没人接 —— 菜单靠下一次 `available_commands_update`（每轮开始都会发）补上，实测无影响。
- **远程无法验证**：没有可用的远端机器。代码路径上远程 Claude 走 `remoteAdapterCheck` → 同一个 `session/load`（上轮已审）。

### 12 子代理

- **只记录**：Task（工具名 `Agent`，kind `think`）派出去的子代理，它的工具调用和主线在**同一个 ACP sessionId** 下发来，
  只靠 `_meta.claudeCode.parentToolUseId` 区分（附录 A9、A10）。KiroLex 哪儿都不读这个字段，于是：子代理跑的命令和主线的命令混在同一个「运行的命令」面板里；
  子代理的 Read / Grep 不留痕（3a）；`index.ts` 算的 `childSessionId` 只对 kiro（子代理各有自己的 session）成立。
  状态行认得出 Task（`ChatArea.tsx` 按标题正则显示「🤖 子代理运行中」）。
  另：实测模型会把 Task 放到后台跑（「Agent launched and is running in the background」），结果在同一轮稍后才回来，界面上不区分。按父调用分组是界面改动 → 拍板。

### 13 其他写死 kiro 的地方

- 压缩提示靠正则匹配回复文字里的「compacting」（`useAcp.ts:2315`）。Claude 的 `/compact` 发的是一个 `Compact conversation` 工具调用、不出文字，
  所以这条提示对 Claude 不亮；状态行会显示「⚙️ Compact conversation」，不算错。
- `/model`、`/usage`（7c）；「Kiro CLI 会…」文案（9b）；Credits（F3，已修）。
- 远程会话注入的上下文里提到 `fs_write`（`remoteContext.ts`），Claude 里没有这个工具名 —— 上轮 4.3 已记，不重复。
- 适配器默认模式在这台机器上是 `bypassPermissions`（`session/new` 返回的 `currentModeId`），所以本机不手动切模式时，Claude 会话**从不弹权限**；
  KiroLex 的 `DEFAULT_ENGINE_MODE` 也设的是它。这是既定选择，不是 bug，但用户要知道「看不到权限条」是因为这个。

---

### 实测中顺带看到的

- 用 `shot.mjs` 起的应用里（环境变量里没有 `KIROLEX_CLAUDE_ACP`，适配器只装在 `D:ab	ools
pm-global`）新建 Claude Code 会话，日志停在「本地会话挂上 kirolex-local」之后 3 分钟没有下文、界面一直「连接中」；设了 `KIROLEX_CLAUDE_ACP` 后 1.5 秒连上。卡在 `resolveAdapter` 找适配器（`npm root -g`）那一步还是别处，这次没查清，只记录。

## 需要拍板

1. **工具调用要不要单独列出来**（3a、12）：给 Claude / Codex 加一个「这一轮用过的工具」列表（含 Read / Grep / WebFetch、按子代理分组、失败标红），
   还是保持现在 kiro 的「只列改了的文件和跑过的命令」。
2. **Edit diff 怎么显示**（3b）：把 `oldText` 也显示出来（`-` / `+` 两段），只对非 kiro 生效还是一起改。
3. **批准计划时显示计划正文**（2b）：在权限条里展开 Markdown，还是只给一个「查看计划」按钮打开 `~/.claude/plans/*.md`。
4. **effort**（1b）：恢复独立下拉，还是继续只放在「组合」里；换到不支持 effort 的模型时要不要提示。
5. **编辑重发对 Claude 后端**（10）：用适配器的 fork 能力从被编辑的那一轮之前分叉出新后端会话，还是维持现在的折中。
6. **`/model`、`/usage` 在 Claude 会话里**（7c）：不拦、原样交给 Claude，还是让 `/model` 打开 Claude 的模型下拉。
7. **用量栏显示 Claude 的花费**（F3）：要不要把 `usage_update.cost`（美元）显示在原来 Credits 的位置。

---

## 附录：集成脚本收到的关键 sessionUpdate 样本

原样摘自 `scripts/claude-feature-probe.mjs` 写的帧日志（适配器 0.88.0、haiku）。`sessionId` 换成了 `…`，过长的截断了；路径是临时目录。

**A1 Edit 的 tool_call_update（带 diff：只是 old_string → new_string 那一段）**

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"_meta":{"claudeCode":{"toolName":"Edit"}},"toolCallId":"toolu_bdrk_01VCDfyEkKfT3wWwATdPoFbW","sessionUpdate":"tool_call_update","rawInput":{"replace_all":false,"file_path":"<cwd>\\out.txt","old_string":"alpha","new_string":"beta"},"content":[{"type":"diff","path":"<cwd>\\out.txt","oldText":"alpha","newText":"beta"}]}}}
```

**A2 失败的 Read（status: failed）**

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"_meta":{"claudeCode":{"toolName":"Read"}},"toolCallId":"toolu_bdrk_01LAgGNxHumWNj2RLKWjAS7g","sessionUpdate":"tool_call_update","status":"failed","rawOutput":"File does not exist. Note: your current working directory is <cwd>.","content":[{"type":"content","content":{"type":"text","text":"```\nFile does not exist. Note: your current working directory is <cwd>.\n```"}}]}}}
```

**A3 Bash 的 tool_call**

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"_meta":{"claudeCode":{"toolName":"Bash"}},"toolCallId":"toolu_bdrk_01FVX3RdzTjbPYFYfPdsoeom","sessionUpdate":"tool_call","name":"Bash","rawInput":{},"status":"pending","title":"Terminal","kind":"execute","content":[]}}}
```

**A4 agent_thought_chunk**

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"The user wants"},"messageId":"msg_bdrk_u2y7cvwayjiay3aaj7jkq6cb2mcrc74xie6cyrdxamjmxwv7rrpq"}}}
```

**A5 usage_update（一轮结束时带 cost）**

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"sessionUpdate":"usage_update","used":24881,"size":200000,"cost":{"amount":0.0350394,"currency":"USD"},"_meta":{"_claude/origin":{"kind":"human"},"_claude/model":"anthropic.claude-haiku-4-5-20251001-v1:0"}}}}
```

**A6 plan（TaskCreate / TaskUpdate 转过来的）**

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"sessionUpdate":"plan","entries":[{"content":"step A","status":"completed","priority":"medium"},{"content":"step B","status":"pending","priority":"medium"}]}}}
```

**A7 current_mode_update（批准计划之后）**

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"sessionUpdate":"current_mode_update","currentModeId":"default"}}}
```

**A8 config_option_update**

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"sessionUpdate":"config_option_update","configOptions":[{"id":"mode","name":"Mode","description":"Session permission mode","category":"mode","type":"select","currentValue":"plan","options":[{"value":"default","name":"Manual","description":"Always ask before making changes"},{"value":"acceptEdits","name":"Accept edits","description":"Automatically accept all file edits"},{"value":"plan","name":"Plan","description":"Create a plan before making changes"},{"value":"auto","name":"Auto","description":"Claude handles permission decisions"},{"value":"bypassPermissions","name":"Bypass permissions","description":"Accepts al …(截断)
```

**A9 子代理里的 tool_call（带 parentToolUseId）**

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"_meta":{"claudeCode":{"toolName":"Bash","parentToolUseId":"toolu_bdrk_01AMEdK3gajH7jMZXqXnF8bD"}},"toolCallId":"toolu_bdrk_01BFAuQtHhvK6fQ8EcMZR39E","sessionUpdate":"tool_call","name":"Bash","rawInput":{"command":"echo sub-hello","description":"Run echo command"},"status":"pending","title":"echo sub-hello","kind":"execute","content":[{"type":"content","content":{"type":"text","text":"Run echo command"}}]}}}
```

**A10 Task（Agent）工具本身的 tool_call**

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"_meta":{"claudeCode":{"toolName":"Agent"}},"toolCallId":"toolu_bdrk_01AMEdK3gajH7jMZXqXnF8bD","sessionUpdate":"tool_call","name":"Agent","rawInput":{},"status":"pending","title":"Task","kind":"think","content":[]}}}
```

**A11 /compact 的 tool_call**

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"sessionUpdate":"tool_call","toolCallId":"8febd9f5-07bb-46aa-b42b-22057521722c","title":"Compact conversation","kind":"think","status":"in_progress","_meta":{"claudeCode":{"toolName":"compact"}}}}}
```

**A12 批准计划的 session/request_permission**

```json
{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"toolCall":{"toolCallId":"toolu_bdrk_01JNgoYCAoQ8kgkEr4uaWGqD","name":"ExitPlanMode","status":"pending","rawInput":{"plan":"## Context\nMinimal request: create a file `plan.txt` in <cwd>.\n\n## Plan\nCreate `plan.txt` containing exactly \"p\".\n\n## Verification\nRead `plan.txt` and confirm its contents are \"p\".\n","planFilePath":"D:\\ab\\claude-task\\plans\\agile-prancing-dongarra.md"},"title":"Approve Plan","kind":"switch_mode","content":[{"type":"content","content":{"type":"text","text":"## Context\nMinimal request: create a file `plan.txt` in <cwd>.\n\n## Plan\nCreate `plan.txt` containing exactly \"p\".\n\n## Verification\nRead `plan.txt` and confirm its contents are \"p\".\n"}}]},"options":[{"optionId":"exit-plan-default","name":"Yes, manually approve edits","kind":"allow_once"},{"optionId":"exit-plan-clear-bypass","name":"Yes, clear context (4% used) and bypass permissions","kind":"allow_always"},{"optionId":"exit-plan-bypass","name":"Yes, and bypass permissions","kind":"allow_always"},{"optionId":"exit-plan-auto","name":"Yes, and use auto mode","kind":"allow_always"},{"optionId":"reject","name":"No, keep planning","kind":"reject_once"}],"sessionId":"…"}}
```

**A13 停止一轮之后 session/prompt 的结果**

```json
{"jsonrpc":"2.0","id":14,"result":{"stopReason":"cancelled","usage":{"inputTokens":10,"outputTokens":289,"cachedReadTokens":18786,"cachedWriteTokens":4470,"totalTokens":23555},"_meta":{"quota":{"token_count":{"totalTokens":23555,"inputTokens":10,"cachedInputTokens":18786,"cachedWriteTokens":4470,"outputTokens":289,"reasoningOutputTokens":0},"model_usage":[{"model":"global.anthropic.claude-haiku-4-5-20251001-v1:0","token_count":{"totalTokens":23555,"inputTokens":10,"cachedInputTokens":18786,"cachedWriteTokens":4470,"outputTokens":289,"reasoningOutputTokens":0}}]}}}}
```

**A14 available_commands_update**

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"deep-research","description":"Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report. (dynamic workflow)","input":null},{"name":"superpowers:brainstorming","description":"(superpowers) You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation."," …(截断)
```

**A15 session/load 回放的 user_message_chunk**

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent:\n   The current request is to create a detailed summary …(截断)
```

**load 那一步的 session/load 结果**（脚本摘要）：`{"modes":"default","configOptions":["mode=default","model=opus","effort=default"]}` —— 适配器在新进程里把模型 / 模式退回默认，靠 KiroLex 重新设回去。

