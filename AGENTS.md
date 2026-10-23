# AGENTS.md —— 写给改 KiroLex 的代理

开工前先读完这一份。这里每一条都对照过代码；文件名、函数名、IPC 通道名都是真名，可以直接搜。
行号会漂，所以基本只给名字；要定位就 `grep -n '<名字>' <文件>`。

> 不在这里的、或者这里和代码对不上的：**以代码为准**，并且只在你的任务需要时才去弄清楚。

---

## 1. 项目是什么

KiroLex 是一个 Electron + React + TypeScript 的桌面聊天客户端，前面是 GUI，后面每条会话各起一个
**ACP 执行器进程**（JSON-RPC over stdio）。

- 引擎三种：`kiro`（kiro-cli `acp`）、`claude`（Claude Code ACP 适配器）、`codex`（Codex ACP 适配器）——
  `src/main/engines.ts` 的 `Engine` 类型。注意 `src/main/config.ts` 顶部还写着"只用 kiro-cli"，那句已过时。
- 会话可以跑在本机，也可以跑在远端机器上（ssh）；**文件永远在本机**（见 §4.6）。
- 界面以中文为主，有中 / 英切换（`src/renderer/i18n.ts`）。
- 所有持久状态都在 `~/.kirolex/` 下（见 §4.3）。

设计文档（动相关功能前要读）：

| 文档 | 讲什么 |
|---|---|
| `docs/DESIGN_session_architecture.md` | 会话 = 持久记录，执行器 = 临时进程；durability 规则；记忆分层 |
| `docs/DESIGN_remote_sessions.md` | 远程会话："执行在远端、文件在本机"；反向隧道 + 本地 MCP 工具；孤儿进程 |
| `docs/WINDOWS_GAPS.md` | Windows 上修过 / 没修的差异 |
| `docs/loop-engineering-notes.md` | 循环 / 定时能力的调研和现状 |

`README.md` 里有功能列表和 `~/.kirolex/` 目录图，但它的 Architecture 一节不全（没列后来加的几十个模块）。

---

## 2. 构建 / 测试 / 运行

```bash
npm install
npm run build     # tsc -p tsconfig.main.json（main → dist/main）+ vite build（renderer → dist/renderer）
npm test          # node --test "tests/**/*.test.ts"
npm start         # electron .   跑 dist/ 里构建好的版本（file:// 源）
```

- **验证一律用 `npm run build` + `npm test`**（需要看界面时再 `npm start`）。
- **不要用 `npm run dev:hot` 做验证。** 它是给人在 KiroLex 里改 KiroLex 用的监管进程
  （`scripts/dev-hot.mjs`：Vite HMR + `tsc --watch` + 自动重启 Electron），会话不会退出、
  跑在 `http://localhost:5173` 源上、带 `--dev`（开 9222 调试端口），并且会一直重启 —— 不是一个能得出"过了 / 没过"结论的东西。
  `npm run dev` 同理。
- Node：测试依赖 Node 原生 TS 类型剥离（Node ≥ 22.18 / 23.6 默认开启；本机是 v24）。仓库里没有 `.nvmrc` / `engines` 钉版本。
- 没有 lint 脚本。`npm run build` 里的 `tsc` 就是 main 进程的类型检查；renderer 的 `tsconfig.json` 是 `noEmit`，
  vite build **不做类型检查**——改了 renderer 要自己跑 `npx tsc -p tsconfig.json`（当前是零报错，改完也应保持零报错）。
- **`npm start` 用的是真的 `~/.kirolex/`**：所有 worktree、所有 build 共用这一份数据（会话、ui-state、config）。
  所以：
  - 单实例锁（`app.requestSingleInstanceLock()`）：已经有一个 KiroLex 在跑时，第二个会以退出码 42 退出。
  - 不要同时跑两个不同版本的 build（`DESIGN_remote_sessions.md` 开头记录过两个 build 互相改写会话记录、看起来像"会话串了"）。
  - 不要在验证时删 / 改用户的会话数据。

---

## 3. 目录与模块地图

```
src/main/        Electron 主进程（CommonJS，tsconfig.main.json，输出 dist/main）
  index.ts       ≈11500 行：所有 IPC handler、执行器生命周期、托盘、ui-state、调度器、S3、远程……
  preload.ts     contextBridge：window.kiroApi / window.kiroUiState
  *.ts           从 index.ts 拆出去的纯逻辑模块（大多数不 import electron，能直接单测）
src/renderer/    React 渲染端（Vite，root 就是这个目录，输出 dist/renderer）
  main.tsx       入口：createRoot → <ErrorBoundary><App/>
  App.tsx        ≈4400 行：根组件，跨会话编排（排队 / 插话 / 分屏 / 文件查看器 / 侧栏预览挂载）
  hooks/useAcp.ts ≈4800 行：渲染端的会话引擎（连接、流式、hydration、steer、恢复、分屏镜像）
  components/ChatArea.tsx ≈4600 行：一个聊天格（消息列表、输入框、排队卡片）
  components/*.tsx 其余 UI；*.ts 是抽出来能单测的纯逻辑
tests/           node:test，约 110 个 *.test.ts
scripts/         dev-hot.mjs（dev 监管）、remote-bootstrap.sh（管道给远端 bash）、acp-probe.mjs / steer-smoke.mjs（真 kiro-cli 冒烟，花额度）、skill-validate.mjs
docs/            设计文档（§1）
```

### 3.1 进程边界和 IPC

- 只有 `src/main/index.ts` 和 `src/main/preload.ts` import `electron`。
- `preload.ts` 用 `contextBridge.exposeInMainWorld` 暴露两个对象：
  - `window.kiroApi` —— 绝大多数是 `ipcRenderer.invoke(...)` 的薄包装；
  - `window.kiroUiState` —— `initial`（启动时 `sendSync('app:ui-state-all')` 同步拿到的快照）和 `set`（`send('app:ui-state-set')`）。
  - 没有 `window.api` 这个名字。
- 主进程侧：handler 都在 `index.ts` 里内联注册，`ipcMain.handle('<命名空间>:<kebab-名>', …)`。
  命名空间：`acp:`（会话 / 执行器，最多）、`app:`、`kiro:`、`loop:`、`schedule:`、`remote:`、`review:`、`workspace:`、`deck:`、`s3:`、`ai-login:`、`bins:`、`control:` 等。
  主进程往渲染端推事件用 `mainWindow.webContents.send('acp:…')`。
- **加一个 IPC 要改三处**：`index.ts` 注册 handler、`preload.ts` 加包装、渲染端调用 + 类型声明（`window.kiroApi` 的类型在 `App.tsx` 顶部的 `declare global { interface Window … }` 里）。

### 3.2 主进程启动顺序（index.ts）

1. `app.requestSingleInstanceLock()`；拿不到 → 打印怎么杀掉旧进程，`app.exit(42)`。
2. 第一个 `app.whenReady()`：`migrateUiStateFromFileOrigin` → 清理 ui-state（`clearRunScopedUiState`、`pruneDeadUiStateKeys`）→
   `pruneSessionTrash`（回收站 30 天）→ `createTray()` / `createSplashWindow()` / `createWindow()`。
   渲染端 hydrate 完会话后发 `acp:reveal`，主窗口才显示（有时间兜底）。
3. 第二个 `app.whenReady()`：起控制入口 `createControlServer`（§3.11）。
4. 退出：`before-quit` 断开所有执行器 + `sshMux.closeAll()`；`SIGTERM`/`SIGINT` 转成 `app.quit()`；
   Windows dev 下轮询 `~/.kirolex/dev-quit-request`（§4.1）。`window-all-closed` 什么都不做（托盘常驻）。

### 3.3 会话（持久记录）

| 文件 | 关键点 |
|---|---|
| `src/main/sessionStore.ts` | `~/.kirolex/sessions/<id>/`：`record.json`（`SessionRecord`，`SESSION_SCHEMA_VERSION`）、`transcript.jsonl`（追加写）、`history.md`（由 transcript 重建的整篇）。函数：`createSession`、`readRecord`、`writeRecord`（tmp + rename）、`patchRecord`、`appendMessage`、`readTranscript`、`truncateTranscriptBefore` / `rewriteTranscript`（只有"编辑后重跑"会截短）、`markAllExecutorsDetached`（启动时）、`safeId`（id 必须是 `^[A-Za-z0-9_-]{1,120}$`） |
| `src/main/eventLog.ts` | 每会话 `events.jsonl`：运行事件时间戳（不存消息正文），4 MB 上限，`appendEvent` 不抛 |
| `src/main/projectStore.ts` | 项目（工作目录分组） |
| `src/main/transcriptMerge.ts` | 两份 transcript / record 合并（S3 冲突用，§3.9） |
| `index.ts` | `acp:new-session`、`acp:load-session` → `loadSessionImpl`（**挂载执行器只有这一份实现**）、`acp:delete-session` → `purgeSession`（写 `~/.kirolex/deleted-sessions.json` 墓碑 → `detachExecutor` → 目录移到 `~/.kirolex/trash/<id>__<时间>`）、`acp:archive-session`、`acp:read-transcript`、`acp:list-durable-sessions`。注意 `acp:list-sessions` 列的是 **kiro-cli 自己的**会话，不是 KiroLex 的 |
| 渲染端 | `useAcp.ts`（会话列表从磁盘的持久记录重建，消息正文不再缓存在 localStorage）、`components/Sidebar.tsx`、`sessionSearch.ts`、`projectActivity.ts`、`workspaceFilter.ts` |

### 3.4 ACP 与引擎（执行器）

| 文件 | 关键点 |
|---|---|
| `src/main/acp-client.ts` | `class AcpClient`：`connect()`（本机 kiro：`kiro-cli acp [--agent] --model`，路径由 `resolveKiroCli()` / `kiroCliCandidates()` 解析，顺序 `KIRO_CLI_PATH` → 已知安装位置 → PATH；远端：`ssh … buildRemoteKiroCommand`；claude/codex：`resolveAdapter`）、`initialize`、`newSession`、`loadSession`、`sendPrompt`（`session/prompt`，无超时）、`cancelPrompt`、`steer`（kiro 的 `_session/steer`）、`steering`（适配器的 `_session/steering`，按 initialize 能力声明，`busyEnter` / `supportsSteer`，判据在 `busyEnterCaps.ts`）、`handleAgentRequest`（权限请求）、`disconnect()`（§4.1）。`sendRequest` 默认 120 s 空闲超时 |
| `src/main/engines.ts` | `Engine`、`ENGINE_LABEL`、`engineOf(profile)`、`resolveAdapter`（用 Electron 自带 Node 跑 npm 适配器，`ELECTRON_RUN_AS_NODE=1`，避开 Windows 上 `.cmd` 的 `spawn EINVAL`；可用 `KIROLEX_<ENGINE>_ACP` 覆盖） |
| `index.ts` | `sessionClients: Map<sessionId, SessionEntry>`（活着的执行器）、`connectWithModelFallback`、`detachExecutor`、`ensureExecutorCapacity`（满了先回收最便宜的空闲执行器，**从不回收忙的**）、`DEFAULT_EXECUTOR_CAP = 10` / `MAX_CONCURRENT_SESSIONS`（`config.json` 的 `executorCap` 可覆盖，1–64）、`sendPromptOnce`（一次发送：拼记忆 / 远程上下文 / 图片截尺寸 / 看门狗） |
| `src/main/busySessions.ts` | `collectBusySessions`：忙的理由 `turn` / `schedule` / `revise` / `queued`；`blocksQuit`：只有 `queued` 不挡退出 |
| `src/main/staleSession.ts` | `staleVerdict`：裸 `Internal error` 之后是重建执行器还是报错 |
| `src/main/promptRetry.ts` | `planRetry`：只对瞬时传输错误自动重发；**已经出过文字或跑过任何工具就不重发**（避免重复副作用） |
| `src/main/transientError.ts`、`reachability.ts` | 错误分类、断路器 |
| `src/main/modelAvailability.ts`、`modelMeta.ts`、`renderer/modelList.ts` | 模型清单 / 可用性 / 倍率缓存 |
| `src/main/kiroAgentList.ts`、`kiroConfig.ts`、`skillDoc.ts`、`subagents.ts` | `~/.kiro/agents` 等 kiro 配置的读写 |
| `src/main/binDetect.ts` | 每台机器上 kiro / claude / codex 启动命令的检测（Windows 走 Node 原生探测 `detectWindows`） |
| 渲染端 | `hooks/useAcp.ts`、`turnRecovery.ts`（`decideTurnRecovery`：重载后先**接管**还活着的那一轮，真死了才重发） |

"卡死（wedge）"：`index.ts` 里 `WEDGE_CONFIRM_MS`（静默上限，默认 600 s，设置里可改，0 = 不打断）和 `TOOL_STALL_MS`（工具调用无输出上限）。
判成卡死后 `session/cancel`、发 `acp:turn-wedged`，渲染端用 `WEDGE_CONTINUE_PROMPT` 自动续（`useAcp.ts`）。
测试：`tests/wedgePolicy.test.ts`、`tests/wedgeContinueWaits.test.ts`。

### 3.5 远程会话

| 文件 | 关键点 |
|---|---|
| `src/main/remoteTargets.ts` | `config.json` 的 `remotes[]`：`listRemoteTargets`、`findRemoteTarget`、`saveRemoteTarget`、`validateTarget`、`expandHome`；每台机器的启动命令（`localBins`、`rememberBinSuccess`）。远端目标**按会话选**，不是全局一个 |
| `src/main/sshMux.ts` | `class SshMux`：每台机器一条 `ssh -N` 复用连接；`muxSupported()` 在 win32 上为 false（Win32-OpenSSH 没有 ControlMaster），回退成每会话一条 ssh |
| `src/main/sshProxy.ts`、`sshAuth.ts` | 跳板（`proxyArgs` 用 ProxyCommand）、`assertSafeSshHost`、密码 / askpass |
| `src/main/remotePreflight.ts` | 一次 ssh 拿到 `ok / unreachable / missing-tools / not-logged-in`；`remoteExecutorCap` |
| `src/main/localMcp.ts` | **跑在本机**的 HTTP MCP：`local_read / local_write / local_glob / local_grep / local_git / local_bash`，只听 127.0.0.1，URL 带 token |
| `src/main/localBrowser.ts`、`localBrowserHost.ts`、`wsLite.ts` | `local_browser_*`（同一条本地工具通道，总开关 `config.json` 的 `localBrowser`，默认关）：接管用户已登录的 Chrome / Edge（CDP，端点读 `DevToolsActivePort`）/ Firefox（WebDriver BiDi）读页面，只读。每个浏览器一条连接 + 一个 session（`LocalBrowserManager`），`before-quit` 收掉；协议方法有白名单；新域名确认按会话记。本地会话经 `withLocalBrowser`（index.ts）作为 `kirolex-browser` http MCP 挂上；每次操作以 `kind: 'browser'` 工具调用进回合面板 |
| `src/main/remoteLocalTools.ts` | 远端每会话一份 `kirolex-local-<id>.json` agent（`remoteAgentScript`）、端口分配、远端孤儿扫描脚本 |
| `src/main/forwardMcp.ts` | 哪些本机 MCP 要原样转发给远端（本机路径命令，或 `playwright` / `drawio` / `pencil`） |
| `src/main/remoteContext.ts` | 每轮注入"项目不在那台机器上、用 `local_*` 工具"的上下文块 |
| `src/main/localAction.ts` | 回复里的 `KIROLEX-LOCAL: open <url>` 行（只有 open、只收 http(s)） |
| `src/main/hostOps.ts` | `LocalHost`（fs）/ `SshHost`（unix 命令）两种宿主操作 |
| `index.ts` | `ensureLocalTools`、`releaseLocalTools`、`sweepRemoteExecutors`、`sweepStrayLocalSsh`（本机孤儿 ssh） |
| 渲染端 | `components/RemoteSettings.tsx`、`hooks/useRemoteTargets.ts`、`remotePick.ts` |

### 3.6 排队与插话（steer）

全部在渲染端；主进程只负责 steer 的发送和落盘。规则见 §4.2。

| 位置 | 关键点 |
|---|---|
| `App.tsx` | `queuesBySession`（每会话一条 FIFO，落盘在 ui-state 的 `kirolex-queues`，`QUEUES_KEY`）、`handleSteerMessage`（普通 Enter，运行中）、`handleFailedSteer`（失败 steer 的两个按钮）、`handleQueueMessage`（Ctrl/⌘+Enter，永远新加一条）、排空队列的 effect（一次一条；合并模式 `settings.mergeQueuedMessages` 一次最多 `MERGE_MAX_ITEMS = 10` 条拼成一轮）、轮次结束时把没被消费的 steer 放回队头 |
| `hooks/useAcp.ts` | `steerMessage`（乐观插入 `steer:'pending'` 消息，**先**登记到 `pendingSteersRef` 再发 IPC）、`takeUnconsumedSteers`、`discardUnconsumedSteers`（用户点停止时丢弃）、`takeOrphanSteers`（启动时把上次没消费的 steer 回队）、`withConsumedSteers`、`sendQueuedMessage`（按目标会话发，不依赖焦点）；持久化键 `kirolex-pending-steers` |
| `components/ChatArea.tsx` | `ChatInputBox`：运行中 Enter → `onSteer`，空闲 Enter → `onSend`，Ctrl/⌘+Enter → 排队；`QueueStack` 排队卡片（可编辑 / 取消 / 拖动排序） |
| `index.ts` | `acp:steer`（未连接 / 换执行器中 / 重建历史中 / 引擎不支持 / 已空闲时拒绝并给理由）、`acp:persist-steer`（被消费后并进那条用户消息写进 transcript） |
| `acp-client.ts` | `steer()`：fire-and-forget 的 `_session/steer`，正文包在 `<user_message>` 里；`steer_queued / steer_consumed / steer_cleared` 通知 |
| 测试 | `tests/queuePaneScope.test.ts`（分屏下必须读**那一格自己的**队列）；`scripts/steer-smoke.mjs`（真 kiro-cli，花额度，不是 CI） |

### 3.7 循环与定时

| 文件 | 关键点 |
|---|---|
| `src/main/schedule.ts` | 纯逻辑：`ScheduleKind = interval/daily/weekly/once`，`maxRuns` 必填（唯一例外：模型建的目标型任务带 `until` 时可为 `null`，按目标停），`dueAt`、`isDue`、`recordRun`、`validateSchedule`；`planScheduleCheck`（`checkCommand` 退出码 0 达成 / 1 没变化不叫醒 / 其他出错，连续 3 次暂停） |
| `src/main/scheduleStore.ts` | `~/.kirolex/schedules/<id>.json`，函数都收 `home` 参数（测试传临时目录） |
| `index.ts` | `scheduleTicker`（20 s 一跳）、`runScheduledJob`（**先记账再发** → `sendPromptOnce`）、`schedulesInFlight`、`schedule:create/list/pause/remove` + 广播 `schedule:changed` |
| `src/main/loopStore.ts` | `~/.kirolex/loop-runs/<sid>.json`，主进程持有的轮次计数器，`beginRound` 发送前先落盘；IPC `loop:persist / begin-round / read / list-live / clear` |
| `src/main/loopVerify.ts` | 跑校验命令只看退出码；远程会话在同一台远端上跑；`loop:verify` 只接受先 `loop:register-verifier` 登记过的命令（这是一个执行任意命令的口子） |
| `src/renderer/loopMachine.ts` | 循环规格 / 状态机（纯，`LoopRun` 必须可 JSON 序列化，有测试守着）。`useAcp.ts` 里 `createSchedule` 注释说它取代了 `startLoop`——渲染端循环入口是否还在用，改之前自己确认 |
| `src/renderer/scheduleView.ts` | 倒计时 / 摘要的纯展示逻辑 |

### 3.8 记忆

| 文件 | 关键点 |
|---|---|
| `src/main/memory.ts` | 三层 Markdown：`~/.kirolex/memory/global.md`、`memory/projects/<id>/memory.md`、`memory/sessions/<id>/memory.md`；`buildMemoryInjection`、`readMemory`、`writeMemory`、`backupMemoryLayer` |
| `index.ts` → `sendPromptOnce` | **每一轮**都在 prompt 前拼记忆块（受 feature flag `memoryInjection` 控制，默认开），记 `lastMemoryInjection`，广播 `acp:memory-bytes`。远程会话的注入会说"用 `local_write` 写记忆"——记忆文件在本机 |
| `src/main/memoryPolicy.ts` | 纯，渲染端也用：各层体积告警阈值、`MEMORY_BACKUPS`、压缩 prompt |
| `src/main/sessionMemory.ts` | 会话记忆自动整理（每 N 条消息），`index.ts` 的 `maybeConsolidateSessionMemory` 走便宜的 `runLiteOneShot` |
| 渲染端 | `components/MemoryDialog.tsx` |

### 3.9 S3 同步 / 备份

| 文件 | 关键点 |
|---|---|
| `src/main/s3Sync.ts` | **白名单**：`sessions/<id>/{record.json, transcript.jsonl, history.md}` + `sessions/<id>/files/`（跳过依赖目录、仓库、压缩包）、`memory/**`、`attachments/**`、`pasted/**`、`mcp-combos.json`（组合，两边都改过时按 id 合并，`mcpCombosSync.ts`）。**不同步** `config.json`、`logs/`、`previews/`。变更检测看 size+mtime（`s3-sync-state.json`），key 带版本前缀；记忆文件用 `decideMemory`（谁变了用谁，两边都变用新的）。S3 key 做了 `path.sep` ↔ `/` 转换 |
| `src/main/transcriptMerge.ts` | `mergeTranscripts`（按 `id` 去重、按 `ts` 稳定排序、同 id 内容不同时本地赢）、`mergeRecords`（`cliSessionId` / `executorState` 永远用本地的） |
| `src/main/s3Client.ts`、`awsSigV4.ts` | 手写 https + SigV4，没有 AWS SDK |
| `index.ts` | `mergeBucketSession`（桶里有别的机器更新的 → 自动合并，本地旧副本先进回收站）、`s3:restore`（现在是**合并**，先断开空闲执行器，正在跑一轮时拒绝；`s3Sync.ts` 头部"覆盖同 id"那句已过时） |
| 渲染端 | `components/BackupSettings.tsx`（密钥不回传渲染端）、`components/BackupDialog.tsx`、`backupIntervals.ts` |

### 3.10 侧栏预览与 comment

| 文件 | 关键点 |
|---|---|
| `components/ReviewPane.tsx` | 文件预览 + 逐行 comment（💬 改 / ＋ 插入 / ✕ 删除），`submitAll` 一次提交全部；`serializeFor(path)`：**每个文件一条串行链**（读 → 问 → 写），放在模块级，面板卸载也不断；模型调用是 `kiroApi.reviseInSession`，跑在**打开这个文件的那条会话里**；未提交的标记存 `kirolex-review-marks` |
| `components/CommentBox.tsx`、`components/PdfView.tsx` | 共用的 comment 输入框；pdf.js 逐页渲染 |
| `renderer/reviewBlocks.ts`、`reviewQueue.ts` | 块模型 + 把反馈打包成一条用户消息；review 自己的排队（`useSyncExternalStore`），**刻意不走聊天排队**，避免同一文件两个写者 |
| `renderer/rewritePatch.ts` | LCS diff，把整段改写拆回逐行改动，让剩余 comment 跟着行走 |
| `renderer/aiChanges.ts`、`aiMarkStore.ts` | "AI 刚改过"高亮 + 逐段撤销（`diffChanges`、`revertChange`、`planUndo`、`beginAiRound`） |
| `src/main/reviseBlock.ts`、`reviewApply.ts` | 纯：改写 prompt / 回复解析（`parseRevised`、`parsePatchReply`、`replyUsable`）、行拼接与 `applyPatch` |
| `src/main/deckPreview.ts` | pptx/docx → PDF 只走 LibreOffice；python-pptx 改讲稿 / 文字 |
| `index.ts` | `review:revise-in-session`（会话忙就排队不拒绝；patch 范围只在主进程写盘，文件中途被改报 `conflict`——渲染端重载也不会丢写）、`review:write-file`（写前备份） |

### 3.11 控制入口 controlServer

`src/main/controlServer.ts`（不 import electron，可直接单测；测试 `tests/controlServer.test.ts`）：

- 只听 `127.0.0.1` 随机端口；`{port, token, pid}` 写到 `~/.kirolex/control.json`（0600），退出时删掉。
- `GET /ping`：不要 token，回 `{ok, pid, busy, pendingQuit?}`。
- `POST /quit`：要 `Authorization: Bearer <token>`。没人忙 → 退；有人忙 → 进入"等待退出"，每秒查一次，空了再退；`?force=1` 直接退。
- `POST /quit/cancel`：取消等待。其他路径 404。
- `GET /sessions`、`GET /sessions/:id/tail|status`、`POST /sessions/:id/send`、`POST /sessions/:id/new-backend`（换新的后端会话，`index.ts` 的 `swapBackendSessionWhenIdle`）：读会话 / 发消息（`controlSessions.ts`，
  说明见 `docs/CONTROL_ENTRY.md`）。功能开关 `controlSessionAccess` **默认关**（关着 403）。`send` 由主进程经
  `control:send` 交给渲染端，`App.tsx` 的 `handleControlSend` 用 `steerRoute.enterRoute`（和 Enter 同一套）分流；
  经它发的消息 id 带 `_ctl_`（`isControlMessageId`），气泡上标「经控制入口发送」，transcript 里带 `via: 'control'`。
- `index.ts` 传进来的 `onQuit` 就是托盘 Quit 那条路（`isQuitting = true; app.quit()`），**不能换成 `process.exit`**（会跳过 `before-quit`，见 §4.1）。
  等待退出期间 `quitPending` 为真，排队消息和定时 / 循环任务不开始新一轮（`control:pending-quit` 推给渲染端）。
- 忙不忙由 `getBusySessions()`（`index.ts`）→ `collectBusySessions` 判定。
- 外部调用方是 agent-board 的"拉取并重启"，不在本仓库。

### 3.12 其他常碰到的

| 文件 | 关键点 |
|---|---|
| `src/main/imagePaths.ts` | 纯：从文字里找图片路径（POSIX + Windows），`rewriteImagePaths` |
| `src/main/logger.ts` | `logger.info/warn/error(scope, msg)`；每次启动一个 `~/.kirolex/logs/main-<YYYYMMDD-HHMMSS>.log`，单文件 2 MB 轮转，保留最近 10 个 |
| `src/main/failureBundle.ts` | 发送失败时写 `~/.kirolex/failures/` 诊断包 |
| `src/main/kiroCliLog.ts` | kiro-cli 自己日志的读取；`KIROLEX_KIRO_TRACE=1` 或文件 `~/.kirolex/kiro-trace` 打开 trace（一天十几 GB） |
| `src/main/aiLogin.ts`、`kiroLogin.ts` | 登录流程 |
| `renderer/uiStore.ts` | `uiGet / uiSet / uiRemove`：localStorage 形状的同步 API，底下是 `~/.kirolex/ui-state.json` |
| `renderer/uiRestore.ts` | `restoreGet / restoreSet`：受设置 `restoreUiState` 控制（关掉时只进 sessionStorage） |
| `renderer/i18n.ts`、`hooks/useLang.tsx` | `t(lang, '英文原文', vars)`；key 就是英文原文，漏翻退化成英文；会话内容 / 路径 / 模型名不翻译。新加的界面文案要进中文表：渲染层按区域分在 `renderer/i18nZh/*.ts`，主进程的在 `main/uiTextZh/*.ts`（`tr()` / `trIn()`，见 `main/uiText.ts`，语言跟着设置走）。`tests/i18nCoverage.test.ts` 扫全部 `src/` 调用点、核对中英两侧和占位符 —— key 必须是单个字面量。`App` 组件和 `useAcp` 在 LangProvider 外面，别用 `useT()` |
| `hooks/useFeatureFlags.ts` | 功能开关，主进程拥有（`config.json` 的 `features`），`app:get-features` |
| `renderer/splitLayout.ts` | 分屏几何（`1x1 / 1x2 / 2x1 / 2x2`，最多 2x2）；每一格是完整独立的会话（自己的输入框 / 队列 / 附件 / 模型），`tests/paneIndependence.test.ts` 守着 |
| `renderer/filePaths.ts`、`pathBits.ts` | 路径解析，两种分隔符都认 |

---

## 4. 不能破坏的规则（invariants）

每一条都有血的教训。改到相关代码时，**先读对应注释和测试**。

### 4.1 kiro-cli 会话锁只在进程正常退出时释放

- 事实：kiro-cli 对一条会话是**单进程独占**。关 stdin → 它 exit 0 → 释放锁；**被 kill 就留下一把陈旧的锁**，
  之后 `session/load` 报 `Session is active in another process (PID n)`，哪怕那个 PID 早就没了。
- 所以 `AcpClient.disconnect()`（`src/main/acp-client.ts`）是：关 stdin → 等最多 5 s 正常退出 → 超时才 kill。
  **不要把它改成直接 kill**，也不要在别处绕开 `disconnect()` 去杀执行器。
- 退出路径必须经过 `before-quit`（它对每个执行器调 `disconnect()`）：
  - `SIGTERM` / `SIGINT` 被转成 `app.quit()`（`index.ts` 末尾）；
  - Windows 没有信号（`kill('SIGTERM')` 就是 TerminateProcess），所以 `--dev` 下 `scripts/dev-hot.mjs` 写文件
    `~/.kirolex/dev-quit-request`，主进程每 500 ms 轮询、看到就自己 `app.quit()`（`DEV_QUIT_REQUEST`，两边的路径必须一致）；
  - 控制入口的 `onQuit` 走托盘 Quit 那条路，**不能 `process.exit`**。
- 远程会话：杀本机的 ssh **不会**带走远端的 kiro-cli（无 PTY、不在 stdin EOF 时退出），它会一直占着锁。
  所以远端命令先 `echo KIROLEX_REMOTE_PID $$` 再 `exec`，断开时按 PID 远程 kill（`remoteKillTree`），
  另外开机 / 定时 / 连接恢复后扫远端孤儿。实测孤儿攒到 85 个、把一台 t3.medium 钉死（`DESIGN_remote_sessions.md`）。
- 换模型 / 换 agent 是"先起新执行器、成功了再关旧的"，所以远端隧道端口**每次起执行器都换一个**。

### 4.2 插话（steer）与排队的顺序语义

渲染端 `App.tsx` 的 `handleSteerMessage` 注释是权威说明，规则如下：

- 运行中按**普通 Enter** = **永远 steer 当前这一轮**（判据在 `steerRoute.ts`，测试 `tests/steerRoute.test.ts` / `tests/steerAlways.test.ts`）：
  - 队列非空、带附件、带粘贴都照样 steer。附件按本机路径写进 steer 文字（和普通消息同一个 `file:` 引用块，`steerPayload`）；
    粘贴先展开（所有入口都把 `pastes` 带到 `handleSteerMessage`）。steer **不取消**这一轮，也不另起一轮
    （`scripts/steer-smoke.mjs` 断言的就是 `stopReason !== 'cancelled'`）。
  - 正在重建历史（`priming` / `prime-pending`）→ 存成 `afterRebuild` 条目（复用队列的落盘和排空，但界面上单独标
    「重建历史中，结束后发送」，不是排队卡片），重建一结束作为下一条单独发出。
- **Ctrl/⌘+Enter** 永远新加一条独立的 FIFO 项。
- steer 发送失败 → **不转排队**：消息标红「没能追加到这一轮：<原因>」，用户选「作为下一条发送」（进队头）或「放回输入框」
  （`addFailedSteer` / `takeFailedSteer`，未处理的落盘在 `kirolex-failed-steers`，重启后仍是标红的失败消息、挂回那一轮，不进队列）。「重建后发送」条目恢复时保留 `afterRebuild`。
  只有 `idle`（这一轮已经结束）直接作为新消息发出，并在状态行说一声。消息永远不丢。
- 被消费的确认（`steer_consumed`）按 FIFO 对应**最老的**待确认 steer；所以 `pendingSteersRef` 必须在**发 IPC 之前**登记
  （kiro 可能 stdin 一被读走就发 consumed，后登记会竞态）。
- 发 IPC 前登记的 steer 带 `inFlight`：结果没回来之前轮次结束，轮末对账**不动它**（只标 `turnEnded`），等结果回来再按失败原因处理 / 成功则当作「这一轮已结束」作为新消息发（`steerPending.ts`）。主进程 `acp:steer` 的拒绝顺序在 `steerGate.ts`：「这一轮已结束」排在「引擎不支持」前面。
- 轮次结束时**没被消费**的 steer → 按原顺序放回**队头**。用户点**停止** → 丢弃未消费的 steer，但**普通队列保留**。
- 每个会话的队列独立 FIFO、在后台独立排空（`sendQueuedMessage` 按目标会话发）；分屏下读的必须是**那一格自己的**队列
  （`queuesBySessionRef.current[sessionId]`，不能用跟着焦点走的 `currentQueue`——曾经导致输入文字静默消失）。
- 排空时要跳过：正在流式 / 后端被占（含重建历史）/ 被循环占用 / 正在发送 / 自动恢复中 / 正在换模型或 agent / 等待退出中。
- 忙时 Enter 能不能插进当前这一轮按执行器 initialize 的能力声明定（`busyEnterCaps.ts`、`AcpClient.busyEnter`）：kiro 走 `_session/steer`；声明了 `_meta.steering.supported` 的适配器（Claude Code / Codex）走 `_session/steering`；只声明 `promptQueueing` 的再发一个 `session/prompt` 交给 CLI 排（`followUpTurns.ts`）；都没有的直接进 KiroLex 队列。
- 队列落盘在 ui-state 的 `kirolex-queues`，未消费 steer 在 `kirolex-pending-steers`；重启后恢复（恢复的排队项带 `restored: true`）。
  控制入口把 `queued` 报为"忙"但**不挡退出**，正因为它已经落盘。

### 4.3 数据都在 `~/.kirolex/`，状态不放 localStorage

- 路径都是 `path.join(os.homedir(), '.kirolex', …)` 写死的，**没有环境变量能改**（`KIROLEX_HOME` 只是 `index.ts` 里的常量名）。
  主要内容：`sessions/<id>/`、`trash/`、`ui-state.json`、`config.json`、`logs/`、`capped/`、`pasted/`、`attachments/`、`memory/`、
  `schedules/`、`loop-runs/`、`failures/`、`control.json`、`deleted-sessions.json`、`s3-sync-state.json`。
- **为什么不用 localStorage**（`src/renderer/uiStore.ts` 头注释）：localStorage 按**源**隔离，而渲染端有两个源——
  `npm start` 是 `file://`，dev 是 `http://localhost:5173`。每次在两者间切换，整套 UI 状态就互换一次（项目分组没了、分屏塌了）；
  更早还因此"整批会话消失"过。所以：
  - 新的 UI 状态一律用 `uiGet / uiSet`（或 `restoreGet / restoreSet`），**不要直接用 `localStorage`**；
  - 会话 / 消息正文只认磁盘上的持久记录（消息正文曾在 localStorage 里缓存到 12.7 MB，已移除）。
- `ui-state.json` 由主进程独占：内存缓存 `uiState()`，`setUiStateKey` 400 ms 合并后 tmp + rename 写盘。
  渲染端启动时同步拿快照（`app:ui-state-all`），之后只发增量。
- `config.json`（agent profile、远端目标、执行器上限、功能开关等）由主进程读写（`remoteTargets.ts` 和 `index.ts`）。
- 写文件的约定：**写临时文件 + `renameSync`**，不要原地覆盖写 JSON（崩溃会留半个文件）。

### 4.4 durability：用户消息立即落盘，助手消息完整了才落盘

`sessionStore.ts` 头注释 + `DESIGN_session_architecture.md` §7：

- 用户发出的消息立刻追加进 `transcript.jsonl`；
- 助手回复**完整结束**才写；半截回复（崩溃 / 断线 / 退出）丢弃，不写；
- 所以 transcript 里只有完整消息，没有要对账的半截记录。不要加"边流边写"的逻辑。
- transcript 是追加写；只有"编辑后重跑"会截短。
- 启动时所有会话一律当作 `detached`（`markAllExecutorsDetached`），不假设上次的执行器还活着。
- 项目归属（`projectId`）是**写一次**：只允许 `null → 项目`，不能项目改项目（已注入的上下文收不回来）。归档也不清它。

### 4.5 一个会话 ↔ 一个执行器进程

- 执行器按会话起（`sessionClients` 以 sessionId 为键），**不按模型共享**（`DESIGN_session_architecture.md` §3 解释了为什么）。
- 执行器上限只限制**同时活着的执行器**，不限制会话数；满了回收空闲的，**从不回收忙的**。
- 换模型 / 换机器 = 拆掉执行器、起新的、回放上下文；会话 id 和 transcript 不变。

### 4.6 远程会话：执行在远端，文件在本机

- 会话记录、transcript、记忆——KiroLex 自己的数据全在**本机** `~/.kirolex/`，项目文件也在本机。远端只有 kiro-cli 进程和一个草稿 cwd
  （`config.ts` 的 `sessionCwd` 算出的 `<remoteWorkdir>/scratch/…`，不是项目目录；远端 agent 用它**自己的**工具写的文件会落在那台机器上）。没有镜像、没有 rsync（旧的镜像方案已整体移除；`config.ts` 里 rsync 那段注释是过时的，`sessionCwd` 才是准的）。
- 远端读写你的文件靠反向隧道调本机的 `local_*` 工具（`localMcp.ts`）。远端 agent 的 `tools` 是白名单，缺这个字段等于一个工具都没有。
- 安全边界是：只听 loopback + URL token + 每次写文件 / 跑命令在状态行上说出来。**不要加路径牢笼之类的"安全剧场"**（有 `local_bash` 就没意义），文档里明确说了不做。
- 远端没配 kiro 启动命令时执行器**直接拒绝启动**并说清楚去哪配——别改成猜一个默认路径（同一台机器上可能有两个 kiro-cli）。
- kiro-cli 对不存在的模型 / agent 是**静默退回**；凡是"悄悄换了"的地方都要在会话里说一句（`pickRemoteModel` 等）。

### 4.7 图片长边 1500px 上限

- Bedrock 只要整段对话里**任何一张**图超过 2000px 就拒绝**整个请求**，而且旧图留在 transcript 里每轮重发——一张大截图能让会话永久报错。
  所以图片在**进入对话之前**就截到 1500（留余量 + 省 token）。
- 实现在 `index.ts`：`MAX_IMAGE_EDGE = 1500`、`capImageSize`、`safeImageRef`（写到 `~/.kirolex/capped/`，原图不动，按路径+mtime+大小缓存）、
  `capImagePathsInText` / `capImageRefsInText`（用 `imagePaths.ts` 的 `rewriteImagePaths`）。
  用在：prompt 文字块、steer、历史行、粘贴图（`app:save-clipboard-image`）、附件（`app:prepare-image-attachment`）。
- 任何新的"把图片交给模型"的路径都必须过这一层。

### 4.8 自动重发不能重复副作用

- `promptRetry.ts` 的 `planRetry`：只要这一轮**已经出过文字或跑过任何工具**就不自动重发。
- 定时任务 / 循环轮次是**先记账（落盘）再发送**（`runScheduledJob`、`loopStore.beginRound`），崩溃后不会无限重跑。
- 重载后的轮次恢复是**先接管活着的那一轮**，确认死了才重发（`turnRecovery.ts`）。

### 4.9 其他

- `scripts/remote-bootstrap.sh` 会被读出来管道给远端 Linux 的 bash，**必须是 LF**（`.gitattributes` 守着 `*.sh` / `*.mjs` 为 LF）。
- `loop:verify` 只跑登记过的命令；`localAction.ts` 只认 `open` + http(s)。这两处收紧都是故意的。
- 新的确认框用 `components/ConfirmDialog.tsx`，不要用 `window.confirm`（会阻塞渲染端主线程；目前只有 `BackupDialog.tsx` 还在用）。
- React hooks 不能写在提前 `return` 之后（`tests/hookOrder.test.ts` 扫源码）。

---

## 5. 常见坑

### 5.1 Windows（详见 `docs/WINDOWS_GAPS.md`）

本仓库的代理通常就跑在 Windows 上，而原作者主要在 macOS 上开发，所以 POSIX 假设很常见：

- **没有 POSIX 信号**：`process.kill(pid, 'SIGTERM')` 是直接终止，`process.on('SIGTERM')` 永远不触发 → 见 §4.1 的文件请求退出。
- **Win32-OpenSSH 没有连接复用**（ControlMaster / unix socket）→ `sshMux.muxSupported()` 在 win32 返回 false。
- **不要用 bash / POSIX shell 做本机探测**：`binDetect.ts` 在 Windows 上走 `detectWindows`（PATH × PATHEXT，`.exe` / `.cmd` 都认，真跑 `--version` 校验）；
  `localMcp.ts` 的 find / grep / bash 有 Node 原生实现（`globNative` / `grepNative`）和 `%ComSpec% /d /s /c`；`loopVerify.ts` 同理。
- **`.cmd` shim**：Node 18.20.2 / 20.12.2 以后 `spawn()` 不带 `shell: true` 起 `.cmd` 会同步抛 `spawn EINVAL`。
  做法是用 Node 直接跑工具的入口脚本（`dev-hot.mjs` 的 `tool()`、`engines.ts` 的 `resolveAdapter`），或者 `shell: true` + 给路径加引号（`localMcp.ts`）。
- **路径**：
  - 两种分隔符都要认；不要 `path.split('/').pop()` 取文件名、不要手拼 `${dir}/${name}`（用 `path` 或 `renderer/pathBits.ts`）；
  - `file:///C:/…` 剥完是 `/C:/…`，要用 `index.ts` 的 `stripFileUrl` 处理；
  - 正则里判断路径要有 `[A-Za-z]:\\` 分支，UNC（`\\server\share`）也要认（`forwardMcp.isLocalPathCommand`）；
  - `~` 展开用 `remoteTargets.expandHome`（`~` 后必须紧跟分隔符或结尾）。
- **引号**：POSIX 单引号 `shellQuote` 在 cmd.exe 上无效——本机命令优先 `execFile` / `execFileSync`（不经 shell）。
- **PowerShell**：需要进程列表时用 `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process …"`（`dev-hot.mjs`、`sweepStrayLocalSshWindows`）。
  拿不到完整 pid 集合时**什么都不杀**——宁可漏，不可错杀。
- **rename 偶发 `EPERM` / `EBUSY`**：杀毒软件或索引器占着目标文件。不是代码 bug，但"配置偶尔存不上"时先想到它。
- **换行**：仓库文本一律 LF（`.gitattributes`）。读文本时要容忍 `\r\n`（`skillDoc.ts`、`localMcp.ts` 的分帧都是这样做的）；新写的解析逻辑也要容忍。
- `fs.watch` 在 Windows 上会丢"刚启动就创建的文件"事件 → `DEV_QUIT_REQUEST` 用的是轮询。
- 代理自己在 Windows 上跑命令时：先确认当前用的是哪种 shell（不同代理 / 环境不一样，不要假定）——
  PowerShell 用 PowerShell 语法（`$env:VAR`、`;` 分隔命令等），Git Bash 用 `/` 路径和 POSIX 语法；
  `npm test` 的 glob 带了引号，交给 Node 自己展开，两种 shell 下都一样。

### 5.2 测试里不要依赖固定等待时间

- 远端 CI 机（Windows Server）很忙，定时器会晚到。`tests/controlServer.test.ts` 曾因 `sleep(5/30/40)` 偶发失败
  （提交 `016a9b1`），修法是轮询直到条件成立：`waitFor(cond, what, timeoutMs)`（每 5 ms 查一次，超时 `assert.fail` 并说明在等什么），
  以及 `waitPolls`（等被测代码真的轮询过 N 次再断言"没有发生"）。
- 规则：**等"某事发生"用轮询 + 较长超时**；**断言"某事没发生"要先确认被测代码确实跑过了**，再加一小段 sleep。
- `src/main/sshMux.ts` 也导出了一个 `waitFor`，`tests/sshMux.test.ts` 在用。

### 5.3 其他

- 大文件里有很多过时的注释（例如 `App.tsx` 里"1x1 … 3x3"、`s3Sync.ts` 头部"覆盖同 id"、`config.ts` 的 rsync 镜像、`eventLog.ts` 提到的
  `renderer/runTimeline.ts` 已不存在）。**注释和代码冲突时以代码为准**，但不要顺手去改与任务无关的注释。
- 代码注释很长、中英混写，里面记了大量"实测过什么"。改一段逻辑前，先读紧挨着它的那段注释——它通常就是在解释你想删掉的那行为什么存在。
- `index.ts` 很多 handler 定义在单实例判断之后的分支或 `whenReady` 里；新增 handler 放在同类 handler 旁边。
- `index.ts` import 兄弟模块时不带扩展名（`from './memory'`），而**被测试 import 的模块**之间要带 `.ts`（`from './sshProxy.ts'`，见 §6）。

---

## 6. 测试约定

- 运行：`npm test` = `node --test "tests/**/*.test.ts"`。没有 Jest / Vitest / ts-node / loader，Node 直接剥类型跑 `.ts`。
  只跑一个文件：`node --test tests/schedule.test.ts`。
- 用 `node:test` 的 `test` / `describe` 和 `node:assert/strict`。测试名、注释用中文写清楚"守的是什么、为什么"。
- 当前基线：约 1630 个用例全过（有 7 个 skipped）。

### 6.1 能被测试 import 的模块必须满足

1. **不 import `electron`**（直接或间接）。所以逻辑要从 `index.ts` / `.tsx` 里抽成独立 `.ts` 模块，由 `index.ts` 收集状态后**传参**进去
   （范例：`busySessions.ts`、`controlServer.ts`、`transientError.ts`、`staleSession.ts`）。
2. **不是 `.tsx`**（Node 不认，`ERR_UNKNOWN_FILE_EXTENSION`）。渲染端要测的逻辑放进 `src/renderer/*.ts`（范例：`backupIntervals.ts`、`pathBits.ts`、`splitLayout.ts`、`aiChanges.ts`）。
3. **只用能被擦除的 TS 语法**：不要 `enum`、`namespace`、构造函数参数属性（`constructor(private x)`）——会报
   `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（`reachability.ts` 有注释说明）。tsconfig 里没开 `erasableSyntaxOnly`，编译不会替你拦。
4. **相对 import 带 `.ts` 扩展名**（`tsconfig.main.json` 开了 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`，编译时改写成 `.js`）。
   类型导入用 `import { type X }` / `import type`。
5. 文件系统路径**作为参数传入**（例如 `scheduleStore` 的函数都收 `home`），测试里用 `fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-…'))`，
   `afterEach` 删掉。**不要让测试读写真的 `~/.kirolex/`**。确实要改环境变量的（`tests/kiroCli.test.ts` 改 `HOME` / `LOCALAPPDATA` / `KIRO_CLI_PATH`），先存后恢复。

### 6.2 三种常见写法（照着现有测试抄）

- **纯函数测试**：import 小模块直接断言。范例 `tests/schedule.test.ts`、`tests/staleSession.test.ts`、`tests/splitLayout.test.ts`、`tests/imagePaths.test.ts`。
- **源码扫描测试**：`index.ts` / `App.tsx` / `ChatArea.tsx` 不能 import，就把源码当文本读，用正则或"锚定一个字符串再截一段"断言接线存在。
  范例 `tests/contextInvariants.test.ts`、`tests/hookOrder.test.ts`、`tests/scheduleWiring.test.ts`、`tests/windows.test.ts`
  （`M.indexOf("ipcMain.handle('bins:detect'")` 后 `slice` 一段）、`tests/paneIndependence.test.ts`。
  读文件用 `path.join(import.meta.dirname, '..', 'src', …)`。
  **注意**：这类测试会因为你改了措辞 / 变量名而失败。如果失败的是**你改动的那段代码**的接线测试，按新代码更新断言是合理的；
  不要为了让它过而删掉它守的那条性质。
- **临时目录 / 真 I/O 测试**：`tests/scheduleStore.test.ts`、`tests/memoryBackup.test.ts`、`tests/localMcp.test.ts`（起真的本地 HTTP server）、`tests/controlServer.test.ts`。

### 6.3 给新逻辑写测试

1. 把判断逻辑写成纯函数，放进（或新建）一个不依赖 electron 的 `.ts` 模块；`index.ts` / 组件只负责收集状态和调用它。
2. 在 `tests/<功能>.test.ts` 里测这个纯函数；接线（handler 真的调了它）用源码扫描测试补一条。
3. 涉及时间的逻辑把 `now` 作为参数注入（`reachability.ts` 的构造函数收 `now`、`schedule.ts` 的函数收时间）。

---

## 7. 改动纪律

- **只改需求范围内的东西。** 不要顺手重构、改名、挪代码、统一风格、修与任务无关的注释或"看起来不对"的地方——
  这个代码库里很多"奇怪"的写法是实测踩坑后故意的（看旁边的注释）。发现别的问题，写进总结里，别动手。
- **大文件里改动要小而集中**（`index.ts`、`App.tsx`、`useAcp.ts`、`ChatArea.tsx`）：
  - 找到确切的函数 / handler 再改，diff 只落在那几处；
  - 不要整段重排或重新格式化（diff 会淹没真正的改动，并发改同一文件的其他代理会冲突）；
  - 新逻辑能抽成独立纯模块的就抽出去（同时也就能测了），大文件里只留调用。
- **并发 / 状态逻辑要格外小心**：排队、steer、执行器挂载 / 回收、轮次恢复、等待退出这几块互相依赖。
  改之前把 §4 里相关的规则和对应测试读一遍；用 ref 读最新状态的地方（`queuesBySessionRef`、`pendingSteersRef` 等）不要改回读闭包里的 state。
- **和任务无关的测试失败不要去改它**（很可能是本身不稳定或环境相关）。在总结里写清楚哪个测试失败、为什么判断与本任务无关。
- 改完：`npm run build` 能过、`npm test` 能过。
- 新增界面文案走 `t()` 并补中文表；新增 UI 状态走 `uiStore` / `uiRestore`；新增持久文件放 `~/.kirolex/` 下并用 tmp + rename 写。
- 不确定的事情不要猜着写进代码或文档；去读代码确认，确认不了就在总结里说。
- 提交信息仓库惯例是中文一句话说清"改了什么"（看 `git log`）。
