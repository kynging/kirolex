# 会话串台排查（session isolation audit）

「串台」= 一条会话的内容、状态或动作出现在 / 作用到另一条会话上。这份文档按任务列出的 7 类路径逐条给结论。

- 结论只用三种：**没问题** / **有问题已修** / **有风险已加防护**（另有个别「有风险未改」，写明原因）。
- 证据栏的测试名都在 `tests/sessionIsolation.test.ts`（下文简称 `SI`），除非另注文件名。
- 修复提交：`10abe4e`（代码 + 回归测试）。`SI` 里前 10 条在修复前全部失败，修复后通过。

排查方法：先把主进程全部 63 处 `webContents.send` 逐个核对 sessionId 的来源，再把渲染端每个监听者核对「按事件里的 id 落地」还是「按当前焦点落地」，最后把每个 `await` 之后用到的会话 id 是闭包里捕获的还是现取的焦点逐处看一遍。

---

## 1. 分屏

| 子路径 | 结论 | 证据 | 修复 |
|---|---|---|---|
| 流式 chunk / 工具调用卡片 | 没问题 | `onUpdate` 按事件里的 `sessionId` 路由；没带 id 时只在恰好一条在流式时才归它，否则丢掉，从不猜焦点。非焦点格读 `paneViews[sid]`，缓存写入受 `messagesOwner` 守卫。SI「流式事件：主进程每条 acp:update 都带闭包里的 sessionId…」；`messagesOwner.test.ts`、`paneIndependence.test.ts` | — |
| 编辑重跑 / 自动重发（断线后 `recoverInterruptedTurn` 对**后台**会话重发） | **有问题已修** | 原来是 `setMessages(retained)`：焦点那条的界面被换成另一条的历史，归属记成焦点会话，缓存 effect 再把它存成焦点会话的。SI「编辑重跑 / 自动重发：截短后的视图按目标会话写…」 | `10abe4e`：改成 `mutateSessionMessages(sid, …)`；全局工具调用表只在重跑的正是焦点会话时才清 |
| 发送重试失败的错误气泡 | **有问题已修** | 原来 `setMessages(prev => [...prev, err])` 写进焦点会话。SI「发送重试失败的错误气泡写进目标会话…」 | `10abe4e` |
| 非焦点那一格发消息时带的模型 | **有问题已修** | `handleSendMessage` 带的 `selectedModel` 是焦点会话的（还是 await 之前的闭包值）。重连重试 `loadSession(sid, cwd, activeModel)` 会把 B 挂到 A 的模型上。SI「非焦点那一格发消息不带焦点会话的模型」 | `10abe4e`：sid ≠ 焦点时不传，由 `modelForSession(sid)` 决定 |
| `/stop`、`/usage` 的回显 | **有问题已修** | await 之后 `sendMessage` 不带 sid，落回焦点（同 `/clear` 当年的教训）。SI「/stop、/usage 的回显发给敲命令的那一格…」 | `10abe4e` |
| 粘贴块（大段文字粘贴，await 落盘） | **有问题已修** | await 期间这一格换了会话：旧会话的文字加占位符被 `setInput` 塞进新会话的输入框，盖掉新会话的草稿。SI「粘贴大段文字：await 期间这一格换了会话…」 | `10abe4e`：写回原会话存着的草稿 |
| Claude Code / Codex 的模型 / 组合下拉 | **有问题已修** | 首次拉取没有 alive 检查，切换结果回来时也不核对会话，A 的清单可能出现在 B 的下拉里。另外「忙」和失败原因是一格一份：A 发起切换、等待期间这一格换成 B，A 失败后错误显示在 B 的模型栏上，忙状态也挂在 B 上。SI「Claude Code / Codex 的模型 / 组合下拉…」「…A 发起切换 → 这一格换成 B → A 的请求失败…」「…B 自己的请求照常显示忙和错误…」 | `10abe4e`；忙 / 错误改成按会话记（`sessionRequestStatus.ts`），见审查跟进提交 |
| KiroLex 提示（noticeMerge / useSessionNotice 会话级缓存）、×N 计数 | 没问题 | 提示 hub 按会话存 `stickyBySession`，`useSessionNotice` 按 `noticeSessionId !== sessionId` 过滤。`sessionNoticeHub.test.ts`（两格订阅仍计 ×1、切会话后保留）、`noticeMerge.test.ts` | — |
| 滚动位置记忆 | 没问题 | `ScrollMemory` 按 sid，`PaneScroll` 离开时提交。`scrollMemory.test.ts`（同一会话开在两格：最后离开的那格为准）、`scrollIsolation.test.ts`。截图 43 里两格各停在自己的位置 | — |
| 追加指令失败标红 | 没问题 | `failedSteersRef` 按 sid 存，调用方都带 `paneSid`。`steerRestore.test.ts`、`steerPending.test.ts` | — |
| 排队卡片 / 重建后发送 | 没问题 | `queuesBySession[sid]`，取 / 改 / 删都带 `paneSid`。`queuePaneScope.test.ts`；截图 42：右格的排队卡片只在右格 | — |
| 输入框草稿、附件 | 没问题 | 草稿按会话存 `composerDrafts`，切会话时用 layout effect 换；附件按 `attachedBySession[sid]`。`composerBehaviour.test.ts`、`queuePaneScope.test.ts` | — |
| 一格流式时另一格发消息 / steer / 排队 | 没问题 | 截图 41–43（手工实测，见文末） | — |
| 同一条会话开在两格 | 没问题（界面上做不到） | `toggleSplitSession` 会把已在分屏里的那条移除。只有手改 / 损坏的 ui-state 才可能重复，那时两格共用同一份草稿（同一 key） | — |
| 拖拽调整分屏、关闭一格、刷新窗口 | 没问题 | 布局状态只是 sid 列表 + 尺寸（`splitLayout.ts`），不带会话内容；关格走 `unfocusSession`，不碰后端。`splitLayout.test.ts`、`paneIndependence.test.ts` | — |

## 2. 后台唤醒（bg_run / watch / schedule_*）

| 子路径 | 结论 | 证据 | 修复 |
|---|---|---|---|
| 任务归属 | 没问题 | 本地 MCP 的 URL token 对应 KiroLex `sessionId`，`callWakeTool(name, args, sid)` 一路带下去，没有任何「当前会话」。SI「后台唤醒：两条会话同时有后台任务，结果各回各的（真起进程）」；`bgJobs.test.ts`「只能看 / 停自己会话的任务」 | — |
| 投递 / 忙时延后 | 没问题 | `WakeDispatcher` 的队列和忙判定都按 sid；`wakeDeliver` 只认 `item.sessionId`。SI「后台唤醒：一条忙、一条闲…」「后台唤醒接线：投递只认 item.sessionId」；`wakeQueue.test.ts`「不同会话互不阻塞」 | — |
| 换后端（`new-backend` / `recreateBackendSession`）后续发 | 没问题 | 变的只是 `entry.cliSessionId`，唤醒路由从不看后端会话 id。`textToolRecovery.test.ts`、`wakeWiring.test.ts` | — |
| 切换运行位置后 | 没问题 | `ensureLocalTools` 用同一个 sid 重新登记；远程 → 本机用 `keepToken`（9f68aec）。端口复用也不会串：选会话的是 token，不是端口。`wakeSwitchTarget.test.ts` | — |

## 3. 控制入口 `/sessions/:id/send|tail|status|new-backend`

| 子路径 | 结论 | 证据 | 修复 |
|---|---|---|---|
| id 路由 | 没问题 | `controlServer.ts` 从路径取 id，原样交给 `access.*(id)`；`new-backend` 的 `swapBackendSessionWhenIdle(id)` 按 id 现取 entry。`controlSessions.test.ts` | — |
| 发送时界面焦点在另一条 | 没问题 | `control:send` 带 `sessionId` 到渲染端，`handleControlSend` 全程用 `req.sessionId`，并且不抢焦点（`ctl`）。SI「控制入口接线：…渲染端用 req.sessionId 分流（不用焦点）」；`controlSendRoute.test.ts` | — |

## 4. 切换会话时

| 子路径 | 结论 | 证据 | 修复 |
|---|---|---|---|
| 切走的会话还在流式 | 没问题 | 后台会话的 chunk 写进它自己的缓存 + 分屏镜像（`commitBackgroundMessages`）；`switchSession` 只把 messages 带走给它真正的归属会话。`messagesOwner.test.ts`、`paneIndependence.test.ts` | — |
| 复制出来的会话发首条消息（`pending_dup_*` → 建真会话要等几秒） | **有问题已修** | 等待期间你切到 C，原来照样把焦点拉回新会话，而 messages 还是 C 的。第一个 chunk 一到，C 的消息加 chunk 就被记成新会话的；跨会话上下文链接也按焦点搬家（见下一行）。SI「复制出来的会话首条消息建好真会话后：你已经切走了就不抢焦点」 | `10abe4e` |
| 跨会话上下文链接搬家 | **有问题已修** | 原条件比的是焦点会话：给另一格 / 后台排队 / 控制入口发消息时，焦点会话的链接被整份搬到目标会话。SI「跨会话上下文链接只在「pending → 真 id」时搬家…」 | `10abe4e` |
| 正在重建历史 / 换模型时切走、切回 | 没问题（同一会话内有一处小风险，未改） | 主进程 `sendPromptOnce` 每次 await 后按 sid 现取 entry，执行器换了就重启这一轮；切换期间的发送进排队（`isBackendOccupied`）。风险：重建历史的 `finally` 清的是「当前 entry」，如果这段时间执行器刚好被换掉，会把新 entry 的 `busy` / 半截回复一起清掉。窗口极小，而且不会跨会话；新 entry 是 `{...entry}` 复制出来的、继承了 `priming=true`，正要靠这个 finally 清掉，改动有风险，所以没动 | — |

## 5. 主进程事件

| 子路径 | 结论 | 证据 | 修复 |
|---|---|---|---|
| 所有会话事件带 sessionId | 没问题 | 63 处 `webContents.send` 全部核对过：会话事件的 sessionId 都来自参数或闭包（`wireSession(sessionId, entry)`），没有一处用「当前会话」 | — |
| 渲染端按 sessionId 过滤 | 没问题 | `onUpdate` / `onNotice` / `onSessionBusy` / `onTurnRestart` / `onPendingSwitches` / `onEngineModels` 等都按事件里的 id；`onAssistantFinal` 只在 `sid === currentSessionRef.current` 时写焦点视图 | — |
| await 之后用捕获的 sid | **有问题已修** | 即上面 1、4 里那几处（重跑、重试报错、`/stop`、`/usage`、粘贴、引擎下拉、复制会话首发） | `10abe4e` |

## 6. 远程 / 本机混合

| 子路径 | 结论 | 证据 | 修复 |
|---|---|---|---|
| 一条远程、一条本机同时跑 | 没问题 | 每条会话一个执行器，一份本地工具 token；路由全按 KiroLex id | — |
| 切换运行位置（以及换引擎 / 换 MCP 组合 / 换 agent）时旧执行器的迟到事件 | **有问题已修** | 换机器 / 换引擎 / 换组合这三条路是「先 await 旧的 disconnect，再 set 新的」：旧进程 close → `disconnected` 时 map 里还是旧 entry，身份守卫放行。于是删掉 entry、记录写成 detached、给渲染层发 `acp:disconnected`（渲染端随即走断线恢复 / 标中断），远程会话还会对着**旧那台机器**起 `startRemoteRecovery`。换 agent 那条是先 set 新的再断旧的，旧 client 迟到的 `update` 会被当成这条会话的流式输出发出去。SI「主进程：被换下来的执行器…的迟到事件一律丢掉」；`remoteRecovery.test.ts` | `10abe4e`：新增 `retireExecutor`，所有换执行器的地方先登记再断开；`update` / `error` / `disconnected` 丢掉已登记的、或已不是这条会话当前执行器的 client 的事件 |

## 7. 记忆 / 历史

| 子路径 | 结论 | 证据 | 修复 |
|---|---|---|---|
| 记忆注入 | 没问题 | `buildMemoryInjection(effectiveProjectId, sessionId)` 两个参数都来自这一次发送；会话层路径只看 sessionId | — |
| 会话记忆整理 | **有风险已加防护** | 整理要 await 一次 7–26 s 的 lite 调用，之后用 await 之前读的 record **整份**写回：这期间换后端 / 换机器写进去的 `cliSessionId`、`profile` 会被改回旧值。会话在这期间被删的话，`writeMemory` / `writeRecord` 会把它的目录重新建出来。都不跨会话，但会写错状态。SI「主进程：会话记忆整理完成时会话已删就不写；只补 memoryConsolidatedAt…」 | `10abe4e`：await 之后会话已删 / 记录没了就不写；记录改成 `patchRecord` 只补这一个字段 |
| history.md | 没问题 | `refreshHistoryFile(id)` 是同步的，用的就是传进来的 id | — |
| 跨会话拼上下文 | 有问题已修 | 见 4「跨会话上下文链接搬家」 | `10abe4e` |
| 复制会话 | 有问题已修 | 见 4「复制出来的会话发首条消息」；历史注入按 `pendingId` 取（`duplicateHistoryRef`），本来就对 | `10abe4e` |

---

## 手工复现 / 验证步骤（分屏两格同时流式 + 一格 steer、一格排队）

截图在 `.agent-board/screenshots/`，用 `shot.mjs` 驱动真的 kiro-cli 跑出来：

1. 分屏 1x2，左右各一条会话。
2. 左格发「写一篇约 3000 字的短篇《灯塔》」，紧接着右格发「写一篇约 3000 字的短篇《渡口》」。
3. 约 12 s 后两格都在流式（`41-both-streaming.png`）。
4. 左格普通 Enter 发「（插话·A）结尾加一句：A 收到了这条插话」→ 进左格当前这一轮，标「追加指令」。
   右格 Ctrl+Enter 发「（排队·B）…」→ 只在右格出现排队卡片（`42-steer-left-queue-right.png`）。
5. 两轮跑完（`43-after.png`），两格的滚动位置各自独立。再对照两条会话盘上的 `transcript.jsonl`：
   - 左格（A）：用户消息只有【A】和那条插话；回复是《灯塔》，结尾正是「A 收到了这条插话」——插话进了同一轮，没有另起一轮；
   - 右格（B）：《渡口》写完（08:22:07）之后，排队消息才作为下一条发出，回复「B 的排队消息已执行」；
   - 两份记录里都没有对方的任何内容。

## 没有改、留给以后的

- 模型切换失败回滚（`restoreOldExecutor`）起旧执行器时没有重新挂本地工具，回滚之后 bg_run / `local_*` 不可用（和 9f68aec 同类，不是串台）。
- 换模型 / 换机器 / 换引擎几条路在多次 await 之后 `store.readRecord(id) || store.createSession(id, …)`，没有再查 `deletedSessionIds`：切换期间删掉会话会把它建回来（不是串台）。
- 重建历史的 `finally` 清的是当前 entry（见 4）。
