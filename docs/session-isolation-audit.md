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
| 前台新会话里出现别的会话的大量历史，切走切回还在（10-19 18:33 `s_1792405989036_iq5q03`；盘上 / `tail` / `last-injection.md` 都干净） | **有问题已修**（写入在 `74a459a`；自愈在本次） | 同时刻 CDE（刚从远程切到本机）后台跑完一轮：旧执行器迟到的 `disconnected` → 断线恢复 → `recoverInterruptedTurn(CDE)` → `rerunFromMessage(CDE)`，9f68aec 里这一步是 `setMessages(retained)`——前台新会话的界面被换成 CDE 的历史、归属记成新会话，缓存 effect 存进新会话的格子；`switchSession` 见缓存非空不读盘，所以一直错。`messageCacheReconcile.test.ts`「交错（复现 9f68aec）…」（旧写法下复现）、「交错：后台会话跑完一轮并断线重跑时…切走切回仍然对」（现写法）、「交错：就算缓存已经被污染…自愈」 | 写入：`74a459a`（上面「编辑重跑 / 自动重发」、§6 迟到事件）。自愈：`switchSession` 有缓存时也读 transcript 对账（`messageReconcile.ts`，按用户消息 id；渲染层为这条会话写的——发出的用户消息、本地回显、发送失败气泡、复制会话带来的历史——按会话登记为 localOnly 不算，其余陌生消息不论时间早晚都算；助手消息按所属那一轮核对——那一轮的用户消息得是这条会话的、正文得在 store 那一轮落盘的回复里，兼容流式分段和 id 差异；反过来 store 每一轮的回复也得在缓存那一轮里完整出现，缺了 / 截短了都重载；store 为空也对账），对不上以 store 为准重载；**对完账才查自动重发**（只拿对过账的那份），而且自动重发在截短 / `rewriteTranscript` 之前再对一次账、确认那条提问在这条会话的 store 里（或是本会话登记的未落盘消息）才发——否则污染缓存末尾外来的未答提问会被当成本会话的重发、污染历史写进干净的 transcript（`messageCacheReconcile.test.ts`「交错（复现）：旧顺序…」及读盘早于 / 晚于恢复检查的几条）；正在流式 / 建会话 / 有没吃完的追加指令时不对账 |
| 远程（graviton）新建会话界面出现别的会话的历史（10-20 18:40 `s_1792492836455_jmu79y`；逐步复现记录见本节末「附」；盘上 / `tail` 都是 0 条；运行版本已含 `74a459a` + `e3ae4d2`） | **有风险已加防护；现场来源未确认**（没有那次的渲染端记录，graviton 上的 kiro-cli 版本没测到） | **排除了什么（实测）**：本机 kiro-cli 2.13.0 用 `scripts/acp-replay-probe.mjs` 录帧——session/new（同 cwd，同进程或新进程）**不吐任何对话正文**；session/load 旧 id 的回放（user/agent_message_chunk）**全在响应之前**（探针按 §4.1 关 stdin 正常退出、请求报错即失败；复测 A/B 都 `exited cleanly code=0`，load 成功，new 前后 0 块、load 前 2 块后 0 块）。主进程每一处都是 await 响应之后才 `wireSession`，所以这两种回放到不了界面：`acpReplayTiming.test.ts` 用真的 `AcpClient`（真子进程 + stdio）对着按录帧行为写的假 agent，按主进程的顺序接监听，两条都转发 0 条；只有「响应**之后**才吐旧对话」这种实测没出现的形状会被当成新会话的更新转发出去（同文件第 3 条，没守卫时复现）。也就是说线索①在 kiro 2.13 上不成立，graviton 上是否成立要在那台跑一次探针。**仍然存在的缺口（代码事实，`newSessionReplay.test.ts` 的状态模型重放）**：删掉正看着的会话 D 后 App 立即 `unfocusSession()`；远程删除要等执行器退出（最多 8 s），这期间新建 N，删除返回时 `deleteSession` 拿闭包里点删除那一刻的焦点判断，照样「自动切到最新那条」= 正在建的 N → `switchSession(N)` 原来对正在建的会话不对账、还拿缓存查自动重发；N 的缓存只要有外来内容就原样画出来。外来内容从哪来没有找到可复现的路径。**真实应用里的复现尝试（10-20，本机 Electron + 真 kiro-cli，分屏开着、另一格是有历史的会话）**：新建 D → 删掉正看着的 D → 0.6 s 内新建 N。删除用了 2.3 s，N 建好时删除还没返回（竞态确实发生，新版日志 `[view] delete: focus moved during the delete, not auto-switching`）；把渲染层换回 `e3ae4d2`、再把新建人为拖慢 8 s 模拟远程各跑一遍，N 都只显示欢迎页 —— 竞态本身不会带进历史，必须 N 的缓存里先有外来内容，而那一步在本机复现不出来 | ① `replayGuard.ts`：一轮之外（`!entry.busy`）的对话正文块丢掉、不进 `assistantBuf`，日志 `[acp] dropped replayed … backend=<来源 id>`（防「响应之后回放」）。② 删除返回时看**此刻**的焦点。③ 正在建的会话切到时也对账（store 为空 → 清空），不查自动重发。④ **诊断**：缓存和 store 对不上被重载时，渲染层把「丢掉了哪些 id、它们在哪条会话的缓存里」写进主进程日志（`[view] cache reloaded from store … droppedOwners`），删除期间焦点变了也记一行 —— 下次再出现就能从日志直接看到历史来自哪条会话 |
| 正在重建历史 / 换模型时切走、切回 | 没问题（同一会话内有一处小风险，未改） | 主进程 `sendPromptOnce` 每次 await 后按 sid 现取 entry，执行器换了就重启这一轮；切换期间的发送进排队（`isBackendOccupied`）。风险：重建历史的 `finally` 清的是「当前 entry」，如果这段时间执行器刚好被换掉，会把新 entry 的 `busy` / 半截回复一起清掉。窗口极小，而且不会跨会话；新 entry 是 `{...entry}` 复制出来的、继承了 `priming=true`，正要靠这个 finally 清掉，改动有风险，所以没动 | — |

### 附：远程新建会话串历史 —— 按现场顺序的逐步复现记录（10-21）

现场证据（用户 Mac `main-20261019-205732.log`，运行版本 `e3ae4d2`；graviton 实测）：

- graviton 的 kiro-cli 是 **2.27.1**。在那台上跑 `scripts/acp-replay-probe.mjs`：A session/new before=0 after=0；A session/prompt before=3 after=0；B session/new（新进程同 cwd）before=0 after=0；B session/load before=2 after=0 —— 和本机 2.13 一样，**远端回放排除**（回放只在 session/load、只在响应之前，主进程 await 之后才接监听，见 `acpReplayTiming.test.ts`）。
- session/new 返回的 `modes` 里列着 8 个别的会话残留的 `kirolex-local-ca7bbd-<会话 id>` agent：渲染层**不读** `modes` / `availableModes`，agent 下拉（`kiro:list-agents`）按 `kirolex-local-` 前缀滤掉，所以它们不会出现在界面上，更不会成为消息（`newSessionReplay.test.ts`「残留的每会话 agent…」）。
- 10:3x 最活跃的是远程会话 `dl006j`（825 条，39 次日志）。10:40:30.666 删空的远程 New Chat `z2z1ha`；10:40:36.456 new-session `jmu79y`；10:40:39 preflight + localmcp；10:40:42 `commands: 25`；10:40:45 `[suggestions] generated 3`。

**「10:40:45 generated」不能当成「jmu79y 的 messages 那时非空」的证据**：追问建议每一格的 ChatArea 都会触发（不只焦点那格，也不只新会话），条件是这一格的 `(会话 id, 最后一条助手消息 id)` 没生成过；而 `generated` 是**完成**时才记的。本机实测：渲染层 00:47:12.8 触发 → 主进程 00:47:40 才起 kiro-cli → 00:47:55 出结果（42 s）。所以 10:40:45 那次完全可能是 10:40:36 之前触发的（例如 dl006j 刚跑完一轮，或刚切到它）。原来的日志里没有「谁触发的」，现在 `app:generate-suggestions` 在**发起时**记 `[suggestions] requested sessionId=… messages=… paneFocused=…`，下次可以直接对上。

**按现场顺序复现（本机 Electron + 真 kiro-cli；渲染层换回 `e3ae4d2`；主进程临时加延时模拟远程：新建 preflight+隧道 3.5 s、session/new 后 2 s，删除在执行器退出后再等 7 s；渲染层临时在 `setMessages` 和追问建议触发处打日志）**，单格和分屏（1x2，另一格是有历史的会话）各跑一遍：

| t（ms） | 动作 | `setMessages` 记录（焦点 = 当时 currentSessionRef, 条数） | 追问建议触发 |
|---|---|---|---|
| 7003 | 新建 D | D, 0 | — |
| 15593 | 点开有历史的会话 H（zmjtfs） | H, 4 | 单格：`H:<最后一条助手 id>`（H 自己的，正常） |
| 19024 | 删 D（D 不是焦点；删除要 7 s+ 才返回） | — | — |
| 20475 | 删除还没返回时点「新建会话」→ N | N, 0（`newSession` 里 `currentSessionRef = N` 与 `setMessages([])` 同一拍） | — |
| 20475–42682 | 等 N 连上（建好约 5.5 s 后）、删除返回（≈ 7 s 后） | **无**（删除返回时闭包里的焦点是 H ≠ D，不自动切；N 期间没有任何 setMessages） | **无**（N 的 messages 一直是 []） |

结果：两种布局下 N 都只显示欢迎页，`currentSessionId` 从点新建起一直是 N，缓存里没有 N 的条目，没有任何对 N 的写入；删除完成（≈ +7 s）晚于 N 建好（≈ +5.5 s），两者谁先都不影响。上一轮另做了「删掉的是**正看着的**那条」的变体（会走闭包里的自动切换 → `switchSession(N)`），新旧代码也都只显示欢迎页。**按这个顺序仍然复现不了**，所以这次交付的是三处防护（一轮之外的回放丢掉、删除后按此刻焦点决定、正在建的会话也对账）+ 诊断：`[view] cache reloaded from store … droppedOwners`（丢掉的消息原来在哪条会话的缓存里）、`[view] delete: focus moved…`、`[suggestions] requested sessionId=…`、`[acp] dropped replayed …`。下次再出现时把这几行连同时间发回来，就能直接定位写入路径。

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
