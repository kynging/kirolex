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
| 1b | effort：组合里设了 effort、当前模型不支持（haiku）时，换模型 / 重连不再把它塞过去、不报错，组合旁边说明「暂不生效」 | 有 bug | 低 | **已修**（2026-10-23） |
| 2 | 权限模式 default / acceptEdits / plan / bypassPermissions 的切换和显示；批准计划后离开 plan，下拉跟着变 | 正常（显示）；离开 plan 不写回偏好 | 低 | 上轮已列入拍板 |
| 2b | 批准计划时看不到计划正文（权限条只有标题「Approve Plan」）→ 权限卡里渲染计划 Markdown，长了可折叠 | 有 bug | 中 | **已修**（2026-10-23） |
| 3 | 工具调用标题 / 状态 / locations / 文件链接 | 部分正常 | — | — |
| 3a | Read / Grep / Glob / WebFetch / WebSearch / Task 等只读调用在对话里不留痕 → 「🔧 用过的工具」一条一行（工具名 / 参数 / 结果 / 状态），落盘，失败标红 | 有 bug | 中 | **已修**（2026-10-23） |
| 3b | Edit 的 diff 只显示 `newText`、`+/-` 是行数差 → 按行 `-` / `+` 着色、增删行数按行比，Write 显示为新文件 | 有 bug | 中 | **已修**（2026-10-23） |
| 3c | 失败的命令「失败」标记不是红色（CSS 只给文件面板里的 `stat-del` 上了色） | 有 bug | 低 | **已修**（Claude / Codex 会话） |
| 3d | 停止之后，被打断的命令永远显示「运行中」（Claude 不给被取消的工具发最终状态） | 有 bug | 低中 | **已修** |
| 4 | 计划 / 待办（`plan` sessionUpdate，新版 Claude Code 用 TaskCreate / TaskUpdate 产生） | 正常 | — | — |
| 5 | 思考块（`agent_thought_chunk`）显示和折叠 | 正常 | — | — |
| 6 | 附件和图片 | 本机正常（走路径，Claude 用 Read 读图）；远程无法验证 | — | — |
| 7 | 斜杠命令菜单、选中执行、skills / 自定义命令进菜单 | 正常 | — | — |
| 7b | `/compact`、`/clear` 前面拼了记忆块（上轮 U4）还算不算命令 | **实测正常**（两者都生效） | — | U4 关闭 |
| 7c | `/model`、`/usage` 被 KiroLex 按 kiro 拦下：`/model` 什么都不做、`/usage` 去跑 kiro-cli | 有 bug（只记录） | 低中 | 不做（负责人 2026-10-23：界面已有对应入口，保持现状） |
| 8 | 取消：跑工具中 / 等权限中 / 子代理跑着时停止，之后下一条能发 | 正常（3d 已修） | — | — |
| 9 | 用量：上下文占比 `used/size` 口径对 | 正常（F3 已修） | — | — |
| 9b | 「管理上下文」确认框写死「Kiro CLI 会…」 | 有 bug | 低 | **已修**（9883dffc 提示文案审计，按引擎显示） |
| 10 | 编辑并重发：只截 KiroLex 自己的记录，Claude 后端里旧的那几轮还在 → 用 `session/fork` 从保留部分最后一条回复处分出新后端会话；分不了时说明 | 有 bug | 中 | **已修**（2026-10-23） |
| 10b | 分叉不带源会话的机器（远程会话分叉后落到「新会话默认机器」上） | 有 bug | 中 | **已修** |
| 11 | 会话恢复：session/load 回来完整历史，模型记得之前的对话 | 本机正常；远程无法验证 | — | — |
| 12 | 子代理：Task 的工具调用和主线混在一起 → 按 `parentToolUseId` 归到 Task 行下面，折叠显示，行上显示调用数和用时 | 有 bug | 中 | **已修**（2026-10-23） |
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
- **测试**：`tests/permissionButtons.test.ts`。截图 `03-plan-card.png` / `03b-plan-card-expanded.png`（真实 Claude Code 会话、plan 模式，分屏的窄格子里五个选项都在，计划正文在它们上面，见 2b）。

### F2 分叉 Claude Code 会话变成 Kiro 会话（中高）

- **哪里**：`src/renderer/hooks/useAcp.ts:3218` `duplicateSession`。
- **原来**：分叉 / 复制出来的 `pending_dup_*` 会话首条消息建后端时，引擎读的是 `intendedEngineRef`（`useAcp.ts` 搜 `intendedEngineRef.current.get(pendingId)`），
  而 `duplicateSession` 从来不往里记 → 主进程按「没传 = kiro」建；侧栏那一行也没有引擎徽标。
- **现在**：源会话是 Claude Code / Codex 时记进 `intendedEngineRef`，侧栏行带上 `engine`。kiro 会话的分叉不变。
- **测试**：`tests/claudeFeatureAudit.test.ts` F3（源码接线）。
- 另一半（机器）见 10b，已修。

### F3 「0.00 credits」（低）

- **哪里**：`ChatArea.tsx` 用量栏（搜 `composer-credits`）。
- **原来**：Credits 是 kiro 的计量（`_kiro.dev/metadata` 的 `meteringUsage`），Claude Code 只发 `usage_update`（`used / size / cost`），
  于是 Claude / Codex 会话永远显示「0.00 credits」，旁边还能点「重置」。
- **现在**：非 kiro 会话不显示这个按钮；上下文占比条照旧（口径 `used/size`，对）。
- **测试**：`tests/claudeFeatureAudit.test.ts` F4。截图里 Claude Code 会话的底栏都只有上下文占比条和模型、没有 Credits（例如 `04-edit-resend-forgets.png` 右边那一格）。
- 要不要改成显示 `usage_update.cost`（美元）见「需要拍板」。

---

## 逐项结论

### 1 模型 / effort

- **正常**：模型下拉来自适配器的 `configOptions`（`category: 'model'`，实测选项 `default / sonnet / global.anthropic.claude-fable-5-1 / opus / haiku`，
  `acp-client.ts` `noteConfigOptions`），切换走 `session/set_config_option`，返回的新 `configOptions` 立即生效（实测切到 haiku 后
  `usage_update._meta._claude/model` 就是 haiku）。重连：实测 `session/load` 之后适配器把模型退回 `opus`、模式退回 `default`（附录末尾的 load 结果），
  KiroLex 在 `wireSession` → `applyEngineModel` 里按记录（`profile.engineModels` / `engineOptions`）重新设回去，上一轮 A1 已覆盖新后端会话那条路。
- **1b 已修（2026-10-23，负责人定：不恢复独立下拉，effort 留在「组合」里）**：
  - 实测 effort 跟着模型走：sonnet 上有 `default/low/medium/high/xhigh/max`；**切到 haiku 后适配器的 configOptions 里没有 effort 那一项，硬设回 `Internal error`**。
  - 原来：重连（`applyEngineModel`）时组合要的 effort 在 haiku 上走 `applyComboEffort` 的退回分支，会话里冒一句「没有默认档位可退」；**换模型**（`acp:set-engine-model`）根本不重对 effort，
    换回 sonnet 之后组合的档位就丢了；界面上组合照样显示，看不出 effort 没生效。
  - 现在：`modelOffersEffort`（`src/main/mcpCombos.ts`）判当前模型给不给 effort —— 不给就**不设、不报错、不在会话里说**（只记日志），`applyEngineModel` 和换模型两条路都先判它；
    换回支持的模型时按组合把档位设回去（设不上走原来的 `applyComboEffort` 退回 + 提示，失败只记日志，不挡换模型）。
    界面：组合下拉旁边一个虚线小标「effort 暂不生效」，悬停是整句「当前模型不支持 effort，组合里的 effort（high）暂不生效」（`renderer/comboPick.ts` `comboEffortNote`，
    没连上 / 组合没设 effort / 模型支持时不出）。
  - 测试：`tests/claudeDesignItems.test.ts`「1b」（判定 + 接线）。
  - 实测（2026-10-23，真 Claude Code 适配器，沙盒家目录里放一个带 `"effort": "high"` 的测试组合「effort 测试」，不碰共用的组合清单）：
    选这个组合 → 主进程日志 `组合「effort 测试」effort -> high`；切到 sonnet → `换到 sonnet：组合「effort 测试」effort -> high`，组合旁边没有说明；
    切到 haiku → `换到 haiku：当前模型不支持 effort，组合「effort 测试」的 effort=high 暂不生效`，没有 Internal error、会话里没有报错，组合旁边出现「effort 暂不生效」
    （悬停：「当前模型不支持 effort，组合里的 effort（high）暂不生效」）；再切回 sonnet → `effort -> high`，说明消失。
    截图 `06-effort-not-applied-on-haiku.png`、`07-effort-back-on-sonnet.png`。

### 2 权限模式 / plan

- **正常（显示）**：模式下拉（`ChatArea.tsx` `composer-mode-select`）来自 `category: 'mode'`，实测五个值
  `default(Manual) / acceptEdits / plan / auto / bypassPermissions`（比任务里列的多一个 `auto`，下拉照单全收）。KiroLex 默认把 Claude 会话设成
  `bypassPermissions`（`index.ts:5311` `DEFAULT_ENGINE_MODE`）。批准计划后适配器发 `config_option_update` + `current_mode_update`（附录 A7、A8），
  `acp-client.ts` 收了并重推 `session:engine-models`，下拉跟着变（上轮 A5）。
- 离开 plan 后的模式不写回会话偏好，下次重连会被设回 `plan` —— 上一轮文档「需要拍板」第 2 条已列，这次不重复。
- **2b 已修（2026-10-23）**：批准计划（ExitPlanMode）时权限卡里**直接渲染计划正文**。
  - 正文取 `toolCall.rawInput.plan`，没有再取 `toolCall.content[0].content.text`（附录 A12）；只认工具名 ExitPlanMode / kind `switch_mode` 的请求，普通工具的 content 是入参说明、不当计划（`renderer/permissionButtons.ts` `planTextOf`）。
  - 用聊天里同一套 Markdown 渲染（ChatArea 把 `MarkdownView` 作为 `renderMarkdown` 传给 `PermissionBar`，避免反向 import），占权限卡一整行；超过 14 行或 700 字默认折起来（`planIsLong`），「展开整份计划 / 收起计划」切换；开着时最高 320px、可滚动。
  - 五个批准选项（F1）照旧各自一个按钮，排在计划下面。
  - 测试：`tests/claudeDesignItems.test.ts`「2b」。截图 `03-plan-card.png`（真实 Claude Code、plan 模式、haiku）。

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
- **3a 已修（2026-10-23）**：Claude Code / Codex 会话里**每个工具调用都记进这一轮、落盘进 transcript**，重启后还在。
  - 判据换成 `shouldRecordToolCall`（`src/main/toolTrace.ts`）：kiro 照原来那条（动过文件 / 跑过东西 / browser，一字不改，测试钉着），非 kiro 每条都记；主进程落盘（`index.ts` wireSession 的 tool_call 段）和渲染层实时（`useAcp.ts` tool_call / tool_call_update）用同一个。
  - 记录里多几个可选字段（`StoredToolCall`）：`toolName`（`_meta.claudeCode.toolName`）、`input`（`rawInput` 的一行摘要：`file_path` / `pattern` / `url` / `command` … 认得的键拼起来，认不得的 JSON 截短）、`parentToolCallId`（子代理，见 12）、`startedAt` / `endedAt`。只给非 kiro 写，kiro 的记录形状不变。
  - 界面：回合面板里新加「🔧 用过的工具」（`ChatArea.tsx` `ToolsPanel`，判定在 `renderer/toolRows.ts`）—— 不归「运行的命令 / 改动的文件 / 浏览器操作」管的调用一条一行：工具名徽章 + 标题 + 入参摘要 + `→` 结果第一行 + 用时 + 状态，点开看完整入参和输出；行样式和「运行的命令」同一套。
    失败的整行标题和「失败」标记都是红的，面板头上写「N 个失败」。跑着时展开、跑完收起（和命令面板一样）。只给非 kiro 会话画：kiro 的老判据也会落盘带 locations 的 Read，按引擎判断，kiro 会话里不出这块。
  - 附带：`producedOutput`（一轮「有没有产出」）对只跑了只读工具的 Claude 回合现在为真 —— 它确实干了活；自动重发的判据用的是 `toolsThisTurn`，不受影响。
  - 测试：`tests/toolTrace.test.ts`（数据映射 / 归行判定，样本取自实测帧）、`tests/claudeDesignItems.test.ts`「3a / 3b / 12」（接线、kiro 不变）。截图 `02-tools-and-subagent.png`。
- **3b 已修（2026-10-23）**：「改动的文件」里的 diff 对 Claude Code / Codex 会话**按行显示 `-` 原来的 / `+` 改成的**（红 / 绿底），前后各留 3 行上下文，更长的不变段折成「…（中间没改的行）…」；
  增删行数按行比（`renderer/diffView.ts`，底下用 `aiChanges.diffChanges` 的 LCS，几千行的大文件自动退化成整段一处）。
  Write（`oldText` 为 null）显示为「新文件」徽章 + 全是 `+`（文件末尾的换行不算一行）。同一个文件这一轮被 Edit 了好几次：每一段都列出来、增删合计（原来只留第一段）。
  实测：`alpha → beta` 原来显示成一行 `beta`、没有 `+/-`；现在是 `- beta` / `+ BETA`，计 `+1 -1`。kiro 会话的面板一字不改（按引擎分开，`FileChangesPanel` 的 `engine`）。
  测试：`tests/toolTrace.test.ts`「diffView」。截图 `01-edit-diff.png`。
- **3c 已修**：失败的命令有「失败」标记（`ChatArea.tsx:2544`），但颜色规则原来只有 `.files-item-stat .stat-del`（`global.css:2356`），
  命令 / 浏览器面板里的标记不在 `.files-item-stat` 下，所以不是红的。现在 Claude / Codex 会话的 `chat-main` 带 `data-engine`，`global.css` 加 `.chat-main[data-engine] .files-item-row > .stat-del` 标红；kiro 会话不带这个属性，显示不变。失败的 Read 不进任何面板（3a）。测试 `tests/cancelSettle.test.ts`。
- **3d 已修**：实测停止一轮时 Claude 只回 `stopReason: cancelled`，**被打断的 Bash / Task 不再发最终状态**，停在 `pending`
  （附录 A13；`session/load` 回放里它们才变成 `failed`）。「运行的命令」面板按「不是 completed / failed 就是运行中」（`ChatArea.tsx:2432` `commandStillRunning`）
  把它永远标成「运行中」，落盘的记录里也是。现在非 kiro 的一轮以 `cancelled` 结束时，在 `flushAssistant` 落盘之前用 `settleCancelledToolCalls`（`src/main/cancelSettle.ts`）把还开着的调用收成 `failed`（和适配器自己回放时的状态一致），并给界面推一条 `tool_call_update`（界面因此显示「失败」、状态行的「运行中 · …」也随之清掉）。kiro 的取消路径不动。测试 `tests/cancelSettle.test.ts`。截图 `05-claude-stopped-command.png`：真实 Claude 会话跑 `sleep 40` 时点停止、重启 KiroLex 之后，那一条显示红色「失败」（读的是落盘的记录）。

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
- **7c 只记录（负责人 2026-10-23 定：不做 —— 界面已有对应入口，保持现状）**：`/model`、`/agent` 被 `slashPicker.ts:44` `slashIntent` 拦下，走 kiro 的模型清单和 kiro 的模型下拉 ref（Claude 会话里那个下拉不渲染），
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
- **9b 已修（由 9883dffc 提示文案审计修掉，本轮核对过）**：「管理上下文 → 压缩 / 清空」确认框现在是「{engine} 会总结较早的上下文…」/「{engine} 会丢弃当前对话上下文…」（`App.tsx` 搜 `usageEngineName`），Claude 会话里显示 Claude Code。
  命令本身对 Claude 是生效的（7b）。本轮没改代码。

### 10 消息操作

- **10 已修（2026-10-23）**：编辑某条消息重发时，Claude Code 的后端也**真正忘掉**被编辑之后的内容。
  - 适配器（claude-agent-acp 0.88）声明 `sessionCapabilities.fork`，`session/fork` 认一个分叉点：`_meta.jetbrains.air.fork = { version: 1, messageId }`，`messageId` 是某条**助手消息**的 ACP messageId（流式 chunk 上那个），
    分出来的新会话只到那条为止（`fork-session.js` → `forkClaudeSession(..., { upToMessageId })`）。ACP 标准的 fork 请求没有分叉点字段（Codex 的适配器也路由了 `session/fork`，但不带点等于整份复制）。
  - 所以：每条助手消息落盘时记下这一轮**主线**最后一个 messageId 和当时的后端会话 id（`acpMessageId` / `acpSessionId`；子代理里的 chunk 不算；整份重写 transcript 时按盘上的补回去，`editFork.carryBackendAnchors`）。
  - 编辑重发（`useAcp.ts` `rerunFromMessage`）在**截短 transcript 之前**调 `acp:fork-backend-for-edit`，传保留下来的消息 id；主进程按 `planEditFork`（`src/main/editFork.ts`）走三条路之一：
    - **fork**：Claude Code + 声明了 fork + 保留部分最后一条回复有锚点、锚点就是当前后端会话里的 → `session/fork`（带分叉点）→ `session/load` 新的 → 后端会话 id 换成它、写进记录、标上下文已建立（不用再带快照）、设回模型 / effort / 模式（load 回来是适配器默认的）。
      load 会把分出来的那段历史回放一遍：下一轮开始前一律丢掉，包括工具调用（`dropReplayUntilTurn`；原来的 `isReplayOutsideTurn` 只认正文）。
    - **fresh**：保留部分里一条回复都没有（编辑的是第一条）→ 换一个新的后端会话（Claude Code / Codex 都适用）。
    - **snapshot**：分不了（原因同下面的 fallback），但当前后端没被确认握着这条会话的历史（`contextEstablished` 为假，例如重启后 resume 失败、换了新的后端会话）→ 不提示：
      下一条本来就会带一份快照，而快照是按**截短之后**的记录建的，模型看不到被编辑掉的那段。实测踩到：界面里第二次编辑时恰好是这种（重启时 resume 失败换了后端 `88e2bc73`，锚点在旧的 `bcf21f7e`），
      原来会说一句「后端仍记得旧内容」—— 说错了，模型回答的是 APPLE。
    - **fallback**：适配器不支持带点分叉（Codex、没声明 fork）/ 老记录没锚点 / 锚点属于别的后端会话（换过引擎 / 机器 / 后端）/ fork 失败 → 照原来的做法重发，会话里说一句「ℹ️ 编辑重发：{原因}，所以按原来的做法重发了 —— {引擎} 的后端仍记得被编辑掉的那部分内容。」
  - **连着两次编辑同一条消息**（审查意见，已修）：原来分叉成功后只换了记录里的后端会话 id，保留下来的那几条回复的锚点（`acpSessionId`）还是旧后端；
    整份重写 transcript 时 `carryBackendAnchors` 又把旧的带回来，于是第二次编辑必然判成 other-backend、退回普通重发，模型照样记得第一次换上去的内容。
    现在分叉成功后立刻把保留下来的回复的锚点改到新后端（`editFork.remapAnchorsToFork` / `sessionStore.remapBackendAnchors`，只改保留下来的、属于被分叉那个后端的助手消息）。
    分出来的会话是拷贝，messageId 原样带过去 —— 实测（`claude-feature-probe.mjs` 的 `fork2` 步骤）：APPLE → BANANA，从第 1 轮分叉；在分出来的会话里 CHERRY，
    再从**分出来的会话**按同一个锚点分叉 → 问「记住了哪些词」答 **APPLE**（没有 BANANA、没有 CHERRY）。
    界面实测（沙盒、Claude Code + sonnet）：APPLE → BANANA → 把第 2 条编辑成 CHERRY → 再把同一条编辑成「记住了哪些词？」，主进程两次 `forked … anchors-remapped=1`
    （第二次是从第一次分出来的后端 `1dee8ee4…` 再分到 `aa62c6dd…`），回答 **APPLE**。截图 `08-edit-same-message-twice.png`。
    测试：`tests/editFork.test.ts`「连着两次编辑同一条消息」（完整走两遍：第一次 fork → 改锚点 → 整份重写 → 第二次仍是 fork；原来是 other-backend）。
  - 自动重发（`carryMark`）不分叉（那一轮通常什么都没产出）；kiro 不走这条（渲染层不调，主进程也直接返回）。
  - 实测（`scripts/claude-feature-probe.mjs` 的 `fork` 步骤，真适配器 + haiku）：第 1 轮「记住 APPLE」、第 2 轮「再记住 BANANA」，从第 1 轮最后一个 messageId 分叉 → 在分出来的会话里问「让你记住了哪些词」答 **APPLE**；原来那个会话答 **APPLE、BANANA**。
    界面里同样的流程（真 Claude Code + haiku：第 1 条「记住 APPLE」、第 2 条「再记住 BANANA」，然后把第 2 条编辑成「让你记住了哪些词？」）：主进程日志
    `[edit-fork] forked sessionId=s_1792738616326_7nulo1 08e8e581… -> 5084b6f3… at msg_bdrk_q3ze…`，记录的后端会话 id 换成了 `5084b6f3`，回答是 **APPLE**（transcript 里这条回复的 `acpSessionId` 就是分出来的那个）。截图 `04-edit-resend-forgets.png`。
  - 测试：`tests/editFork.test.ts`（四条路的判据；真 AcpClient 对一个假的 Claude 适配器，`session/fork` 的线上形状和能力判定；接线顺序：fork 在 rewriteTranscript 之前、fork → load → 换 id → 写记录 → 标已建立 → 设回模型）。
    源码扫描 `tests/acpReplayTiming.test.ts` 原来断言「没有别处在活着的 client 上 load」—— 现在唯一的例外就是这一处，测试改成钉住「只此一处、load 前先挂丢回放的标记」。
- **分叉**：引擎已修（F2）。历史作为一个 `<hidden>` 块随首条消息带过去，对 Claude 成立。
- **10b 已修**：分叉不带源会话的机器 —— `duplicateSession` 不记 `intendedRemoteRef`，首条消息时退到「新会话默认机器」（`kirolex-new-chat-remote`）。
  渲染层的会话行只有机器的显示名（`remoteHost`）没有 id，kiro / Claude Code / Codex 三种会话都受影响。
  **怎么修的**：`listDurableSessions` 和 `session:targets-changed` 给会话行带上 `remoteId`（`coldRecord.ts` `durableRemoteId`：记录里存了 id 就只认这个 id，设置里删了就标 `remoteMissing`，不换成同地址的另一台；没存 id 的老记录才按 host + 端口认回）；
  `duplicateSession` 在记引擎（F2）的同一处把源会话的机器记进 `intendedRemoteRef`（本机记成空串，算「记过」），侧栏行同时带上机器名；
  首条消息建后端改用 `firstSendRemoteId`（`src/renderer/forkTarget.ts`）：记过的优先，没记过才用默认机器。
  源会话的机器在设置里已经删了：照样记原来的 id（主进程报「找不到、没替你猜」，不换机器），会话里钉一句「设置里已经没有这台机器了…右键 →『运行位置』选一台」（说法同 `coldRecordFor`）；
  还没发过消息的会话右键菜单原来没有「运行位置」、调了也会报「找不到记录」：现在菜单里有，改的是渲染层记下的机器（`retargetPendingSession`）。
  分叉后没发消息就重启：`intendedRemoteRef` 只在内存里，所以机器意图同时记在会话行上（`forkRemoteId`，`''` = 本机，行整份存进 `kirolex-sessions`），启动时由 `restoredForkIntents` 灌回去，机器已删的再钉一次提示。
  工作目录：每条会话的 cwd 本来就是它自己的文件夹，项目（及项目设的工作目录）随 `duplicateProjectRef` 沿用，未改、加了测试。
  测试：`tests/forkRemote.test.ts`（纯函数）、`tests/claudeFeatureAudit.test.ts` 10b（接线）。

### 11 会话恢复

- **本机正常**：新进程里 `session/load` 实测回放了全部历史（`user_message_chunk` 10 条、`agent_message_chunk`、`tool_call` 等，附录 A15），
  之后问「我第一次让你回复什么」答对了。KiroLex 不渲染回放（`isReplayOutsideTurn` 丢掉一轮之外的消息块，`index.ts:5418` 一带），界面历史来自本机 transcript，
  不会重复。回放里的工具调用 / `available_commands_update` 在 `wireSession` 之前到达、没人接 —— 菜单靠下一次 `available_commands_update`（每轮开始都会发）补上，实测无影响。
- **远程无法验证**：没有可用的远端机器。代码路径上远程 Claude 走 `remoteAdapterCheck` → 同一个 `session/load`（上轮已审）。

### 12 子代理

- **12 已修（2026-10-23）**：Task（工具名 `Agent`，kind `think`）派出去的子代理，它的工具调用和主线在**同一个 ACP sessionId** 下发来，只靠 `_meta.claudeCode.parentToolUseId` 区分（附录 A9、A10）。
  现在这个字段记成 `parentToolCallId`（实时和落盘都有，见 3a），「🔧 用过的工具」里 Task 那一行下面挂它派出去的调用（`toolRowsOf`），**折叠显示**：行上写「🤖 N 个调用」（悬停是完成 / 失败 / 在跑各几个）、Task 的用时和状态，点开是子代理的每个调用（工具名 / 标题 / 结果 / 用时 / 状态，失败标红）。
  子代理跑的命令不再混进主线的「运行的命令」（`mainlineCommands`；kiro 没有父调用，结果和原来一样）；改的文件仍进「改动的文件」（那块按文件汇总）。父调用不在这一轮里的孩子（例如后台跑完、结果落到下一轮）按普通一行显示，不丢。
  实测踩到一处：Agent 那一条**自己的** update 上 `parentToolUseId` 就是它自己的 id（截图那一轮落盘的记录 `s_1792732848071_0kn1sw`）—— 不排除的话它被当成自己的孩子藏起来，连带三个孩子一起不见。现在读字段时丢掉指向自己的父调用（`toolTraceFields`），归组时也不认（`nestedToolIds`，老记录照样对）。
  Codex 的适配器没有对应字段（`parentToolUseId` 在它的包里不存在），它的调用照 3a 一条一行。
  测试：`tests/toolTrace.test.ts`「toolRowsOf」、`tests/claudeDesignItems.test.ts`。截图 `02-tools-and-subagent.png`。

### Codex（2026-10-23 同一轮里实测：`PROBE_ENGINE=codex`，codex-acp 2.1.1，这台机器经 Bedrock 登录）

- 能力：`sessionCapabilities` 里有 `fork`，但标准 fork 请求没有分叉点字段 → 编辑重发对 Codex 走 `fresh`（编辑第一条）/ `snapshot` / `fallback`（会话里说明后端仍记得），不分叉（`supportsForkPoint` 只认 Claude Code）。
- 工具调用：读 / 写 / 改 / grep 一律走 PowerShell（kind `execute`，带 `rawInput.command` / `cwd`，content 是 `terminal`）→ 进「运行的命令」（原来就进）；
  每条命令后跟一条「Guardian Review」（kind `think`，`rawInput` 是审查记录）→ 现在进「🔧 用过的工具」（3a），入参摘要是 JSON 截短。
  这一轮里没有 `diff` 块（没用到 apply_patch）、没有 `_meta` 工具名、没有父调用字段 → 3b 有 diff 时同样按行显示（判据只看引擎），12 对 Codex 不适用。

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

负责人 2026-10-23 已定，这一轮全部按定下的做了（见上面各条）：

1. ~~工具调用要不要单独列出来（3a、12）~~ → 列：「🔧 用过的工具」，子代理按 Task 归组。**已修**。
2. ~~Edit diff 怎么显示（3b）~~ → `-` / `+` 按行着色，只对非 kiro。**已修**。
3. ~~批准计划时显示计划正文（2b）~~ → 权限卡里渲染 Markdown，长了可折叠。**已修**。
4. ~~effort（1b）~~ → 不恢复独立下拉；不支持时不设、不报错、组合旁边说明。**已修**。
5. ~~编辑重发对 Claude 后端（10）~~ → 用 `session/fork` 分叉；不支持时退回并说明。**已修**。
6. ~~`/model`、`/usage` 在 Claude 会话里（7c）~~ → **不做**，保持现状。
7. **用量栏显示 Claude 的花费**（F3）：要不要把 `usage_update.cost`（美元）显示在原来 Credits 的位置 —— 还没定。

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

**2026-10-23 这一轮补的样本**（`fork` 步骤、界面实测会话、`PROBE_ENGINE=codex`）

**A16 Agent 那一条落盘后的样子：`parentToolCallId` 就是它自己的 id（取自实测会话 s_1792732848071_0kn1sw 的 transcript；审计 12 踩到的）**

```json
{"toolCallId":"toolu_bdrk_01Y31jXrhaDfhoQYGu8yL9WL","title":"Subagent test: echo, glob, read","status":"completed","kind":"think","content":"Here are all the outputs:\n\n1. **Echo command**: `sub-hello`\n\n2. **Glob for *.txt files**: Found one file: `notes.txt`\n\n3…","toolName":"Agent","input":"description=\"Subagent test: echo, glob, read\" subagent_type=general-purpose prompt=\"Run the shell command echo sub-hello…","parentToolCallId":"toolu_bdrk_01Y31jXrhaDfhoQYGu8yL9WL","startedAt":1792732935949,"endedAt":1792732984327}
{"toolCallId":"toolu_bdrk_01N6C6sE2GfoW24oPkFoVPXe","title":"echo sub-hello","status":"completed","kind":"execute","content":"```console\nsub-hello\n```…","toolName":"Bash","input":"command=\"echo sub-hello\" description=\"Echo the string sub-hello\"…","parentToolCallId":"toolu_bdrk_01Y31jXrhaDfhoQYGu8yL9WL","startedAt":1792732939958,"endedAt":1792732981853}
```

**A17 编辑重发的分叉请求（带分叉点）**

```json
{"jsonrpc":"2.0","id":6,"method":"session/fork","params":{"sessionId":"…","cwd":"<cwd>","mcpServers":[],"_meta":{"jetbrains":{"air":{"fork":{"version":1,"messageId":"msg_bdrk_6dut5e33b6qrlzwrxnjig2ixwcrfd6lqudofp5jkychkvesurpfa"}}}}}}
```

**A18 session/fork 的结果**

```json
{"jsonrpc":"2.0","id":6,"result":{"sessionId":"…"}}
```

**A19 Codex 的 initialize：声明了 fork，但标准 fork 没有分叉点**

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"@agentclientprotocol/codex-acp","title":"Codex","version":"2.1.1"},"agentCapabilities":{"auth":{"logout":{}},"providers":{},"loadSession":true,"promptCapabilities":{"embeddedContext":true,"image":true},"sessionCapabilities":{"resume":{},"list":{},"close":{},"delete":{},"fork":{},"additionalDirectories":{},"subagents":{}},"mcpCapabilities":{"acp":false,"http":true,"sse":false},"_meta":{"authStatus":{}}},"authMethods":[{"id":"api-key","name":"API Key","description":"Use an API key to authenticate","_meta":{"api-key":{"provider":"openai"}}},{"id":"chat-gpt","name":"ChatGPT","description":"Use ChatGPT to authenticate"}]," …(截断)
```

## 忙时 Enter 交给适配器：`_session/steering` 实跑（2026-10-22）

脚本：`PROBE_STEPS=steering node scripts/claude-feature-probe.mjs`（claude-agent-acp **0.88.0**，模型切到 haiku，看板机器 `D:\ab\tools\npm-global` 里已登录的那份）。
KiroLex 的判据和发法在 `src/main/busyEnterCaps.ts` / `AcpClient.steering`，测试 `tests/busyEnterCaps.test.ts`。

**能力声明在哪**（initialize 响应原文）：

```json
"agentCapabilities": {"_meta":{"claudeCode":{"promptQueueing":true},"authStatus":{}}, …}
"_meta": {"steering":{"supported":true}}
```

`steering.supported` 在响应**顶层**的 `_meta`（和 `agentCapabilities` 同级），不在 `agentCapabilities._meta` 下；
KiroLex 两处都认。Codex 适配器（codex-acp 2.1.1）同样在顶层 `_meta` 声明了 steering，没有声明 promptQueueing，
而且**不认** `idleBehavior:"promptRequired"`：没有在跑的一轮时它自己起一轮（`startedNewTurn`）。见下面「Codex 实跑」。

**实跑结果**：

| 步骤 | 看到的 |
|---|---|
| 一轮在跑、Bash `sleep 12` 进行中（tool_call 之后 2.5 s）发 `_session/steering`，`_meta.steering.idleBehavior:"promptRequired"` | 响应 `{"outcome":"injected"}`，在 `session/prompt` 的响应**之前**回来 |
| 模型有没有在同一轮里看到追加内容 | 看到了：steering 之后、同一个 `session/prompt` 结束之前的 thought 原文是 "They've also asked me to end my final reply with the word PINEAPPLE." |
| 这一轮怎么结束 | 适配器按它的注释把正在跑的 Bash **挪到后台**（"A steer during a foreground tool call moves that tool to the background"），haiku 读了一次后台输出、调了 `ScheduleWakeup`，回「命令还在跑」就 `end_turn` 了 —— 最后那句没带 PINEAPPLE，因为它没写出最终答复，不是没看到 |
| 空闲时再发同样的请求 | `{"outcome":"promptRequired","reason":"noRunningTurn"}`，没有起新的一轮、没有任何 session/update |

**和 replayGuard 的关系**：插进去之后的输出（thought / message / tool_call）全部落在原来那个 `session/prompt` 返回之前，
也就是 KiroLex 的 `entry.busy` 还是 true 的时候 —— 在「一轮之内」，`isReplayOutsideTurn` 不会丢掉它们。

**已知限制**：
- 工具跑到一半时 steering 会让 Claude Code 把那个工具挪到后台，这一轮可能在工具跑完之前就结束（上面那次就是）。这是 Claude Code 自己的行为。
- Codex 不认 `promptRequired`：碰上这一轮刚结束，它自己起一轮（见下面「Codex 实跑」），KiroLex 把那一轮认成这条消息的一轮。

### promptQueueing：一轮在跑时再发 `session/prompt`（2026-10-22 实跑）

`PROBE_STEPS=queueing node scripts/claude-feature-probe.mjs`（claude-agent-acp 0.88.0，haiku）：Bash `sleep 10` 在跑时再发一个 `session/prompt`（"Reply with exactly: TWO"）。
收到的顺序：`tool_call` → 发第二个 → **第一个的响应**（`end_turn`）→ 第二轮的输出（"ONE" —— Claude Code 把两条一起答了）→ **第二个的响应**（`end_turn`）。
也就是「前一个 `session/prompt` 的响应 = 前一轮结束，之后流过来的都属于下一个」。KiroLex 就按这个切分（`AcpClient` 给每条输出标上当时最老的在途 prompt id；
`followUpTurns.ts` 把下一轮的输出攒到它接手为止）：

- 只声明 promptQueueing 的执行器（或 steering 出错、而声明了 promptQueueing）：忙时 Enter 直接再发 `session/prompt`（主进程 `acp:handoff-prompt`），
  界面上是一张「已交给 Claude Code，这一轮结束后执行」的卡片；前一轮收尾时同步交棒 —— 用户消息这时落盘、进对话，它的输出 / 结束 / 看门狗 / 落盘都归它。
- 有一轮排在后面时，前一轮出错不自己重发、不换后端会话（重发会排到它后面去）；还没轮到它就失败了 → 放回 KiroLex 队列队头。
- 点停止：Claude Code 把排着的一起取消；排着的那一轮接手时也补一个 cancel。

### Codex 实跑（codex-acp 2.1.1，2026-10-22）

同一个脚本，`KIROLEX_CLAUDE_ACP=<codex-acp>/dist/index.js PROBE_STEPS=steering`：

| 步骤 | 看到的 |
|---|---|
| initialize | `agentCapabilities._meta` 只有 `authStatus`（**没有** promptQueueing）；顶层 `_meta: {"steering":{"supported":true}}` |
| 一轮在跑、`sleep 12` 进行中发 `_session/steering` | `{"outcome":"injected"}`；最后的回复是 `finished\n\nPINEAPPLE`，同一个 `session/prompt` 之内 |
| 空闲时再发 | `{"outcome":"startedNewTurn"}` —— 它不读 `_meta`（`dist/index.js` 的 `performSteeringRequest` → `startNewTurnFromExternalPrompt`：先等上一个 prompt 收完，再自己起一轮） |
| 每一轮开始 / 结束 | `session_info_update`，`_meta.codex.threadStatus` 是 `{"type":"active"}` / `{"type":"idle"}`（`thread/status/changed` → `createCodexSessionInfoUpdate`） |

所以 Codex 忙时 Enter 走 `_session/steering`。碰上这一轮刚结束（`startedNewTurn`）：前一轮收尾时 busy 先不放（steering 还在途），
那段时间的输出先攒着；结果一回来就把 Codex 自己起的那一轮认成这条消息的正常一轮 —— 用户消息作为新的一条落盘、进对话，
输出归它，见到 `threadStatus: idle` 就收尾（`busyEnterCaps.detachedTurnEnded`）。消息不会再发一遍。

### 一轮之外的自发轮：CronCreate 到点（2026-10-23 看板机器实跑）

背景：Claude Code 的 `CronCreate` 到点、后台 Bash / 后台子代理完成后的跟进，都是适配器在**没有在途 `session/prompt`** 时
自己起一轮（适配器源码里叫 autonomous cycle，`AUTONOMOUS_RESULT_ORIGINS`）。原来 `replayGuard.isReplayOutsideTurn`
把一轮之外的正文一律当回放丢 —— 回复用户看不到、也不落盘。现在分开（`replayGuard.outsideTurnVerdict`）：

- **回放窗口**（`entry.replayWindow`）：挂上执行器（`wireSession`）/ 同一 client 上换后端会话（`recreateBackendSession`）时开，
  KiroLex 发起的第一轮开始时关。窗口内一轮之外的正文照旧当回放丢（「远程新会话出现历史内容」的防护不变）。
- 窗口外、不在一轮里的助手正文 / 思考块（Claude Code / Codex）→ 后端自发的一轮（`autonomousTurn.ts`）：会话里先落一条
  KiroLex 提示「⏰ 后台触发：Claude Code 自己起了这一轮…」，界面接管这一轮的流，busy 报 turn；见到带 `cost` 的 `usage_update`
  （或 Codex 的 `threadStatus: idle`、或 90 s 没有新帧）就收尾，落盘一条带 `origin: 'autonomous'` 的助手消息。
  窗口外的 `user_message_chunk` 仍丢；kiro 会话不变。
- Claude Code / Codex 会话每轮注入一句：定时 / 稍后再看用 `schedule_create`，不要用 `CronCreate` / `ScheduleWakeup`（`wakeTools.ADAPTER_SCHEDULE_NOTE`）。
- 有待触发的 Claude cron（调用过 `CronCreate`、没有对应的 `CronDelete`，`claudeCron.ts`）的执行器被 LRU 回收时，在那条会话里提示一句。

**实跑**：`PROBE_STEPS=cron node scripts/claude-feature-probe.mjs`（claude-agent-acp 0.88.0，本机 Claude Code 2.1.293，haiku）。
脚本让模型用 `CronCreate` 定一个约 2 分钟后的一次性提示（「Reply with exactly: PONG」），那一轮 `end_turn` 之后，把没有在途 prompt 时收到的帧
逐条交给 KiroLex 的真判据（`outsideTurnVerdict`，回放窗口已关、`engine: 'claude'`；`autonomousTurnEnded`；`claudeCron`）：

| 看到的 | KiroLex 的判定 |
|---|---|
| CronCreate 的 tool_call：`rawInput` 先是 `{}`，后面的 update 里才补全（`cron` / `prompt` / `recurring`）；结果在 `_meta.claudeCode.toolResponse`：`{"id":"7fd20cad","humanSchedule":"…","recurring":false,"durable":false}` | 有待触发的 Claude cron（LRU 回收时会提示）；`CronDelete` 按这个 id 对 |
| 定时那一轮结束后 91 s：`usage_update`（无 cost） | 照常转发 |
| `agent_thought_chunk` × 30（"The user is asking me to reply with exactly: PONG…"） | 第一块起 **自发轮**，其余在这一轮里 |
| `agent_message_chunk "PONG"` | 在自发轮里（显示、进 assistantBuf） |
| `usage_update`（无 cost）→ `usage_update` 带 `cost: {"amount":0.0434,"currency":"USD"}` | 带 cost 那帧 → **收尾落盘** |

注意：这次自发轮先来的是思考块（10-22 远端那次只有 message chunk），两种都起自发轮；cron 这一轮的 result 上**没有** `_meta["_claude/origin"]`
（适配器只给 `AUTONOMOUS_RESULT_ORIGINS` 那几类带），所以判据不能靠 origin，只能靠「回放窗口外、没有在途 prompt」。
另外模型自己算 cron 时间不可靠（第一次 haiku 把「1 分钟后」写成了 9 小时后的 `01 14 23 10 *`），脚本改成直接给 cron 表达式。

**已知限制**：Claude 的 cron 仍然只活在适配器进程里 —— LRU 回收、换模型 / 换机器、重启都会让它消失（KiroLex 只提示、不阻止）；
一次性 cron 到点后 Claude Code 自己删掉，KiroLex 看不到，所以那之后回收仍会提示一次（宁多勿漏）。
