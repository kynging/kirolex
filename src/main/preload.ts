import { contextBridge, ipcRenderer, webFrame } from 'electron';

/** Shared UI state (project groups, split layout, settings, widths…).
 *
 *  Exposed SYNCHRONOUSLY: the renderer reads these inside `useState(() => …)`
 *  initializers, so an async IPC would come back too late. `sendSync` hands over
 *  the whole snapshot once at preload time; writes go back asynchronously.
 *
 *  This replaces localStorage for those keys because localStorage is origin-scoped,
 *  and KiroLex's renderer origin differs between `file://` (normal start) and
 *  `http://localhost:5173` (dev/HMR) -- which silently gave each mode its own copy
 *  of the UI state. */
contextBridge.exposeInMainWorld('kiroUiState', {
  initial: (() => {
    try { return ipcRenderer.sendSync('app:ui-state-all') || {}; } catch { return {}; }
  })(),
  set: (key: string, value: string | null) => { ipcRenderer.send('app:ui-state-set', key, value); },
});

contextBridge.exposeInMainWorld('kiroApi', {
  // Connection
  connect: (options: { model?: string }) => ipcRenderer.invoke('acp:connect', options),
  disconnect: () => ipcRenderer.invoke('acp:disconnect'),
  
  // Sessions (one executor process per session, keyed by sessionId)
  newSession: (
    kiroLexId: string,
    cwd: string,
    model: string,
    projectId?: string,
    kiroAgent?: string,
    permissionMode: 'auto-approve' | 'ask' = 'auto-approve',
    /** 这条会话跑在哪台机器上（`undefined` = 本地）。见 docs/DESIGN_remote_sessions.md。 */
    remoteId?: string,
    /** 哪个引擎：'kiro'（默认）/ 'claude' / 'codex'。见 src/main/engines.ts。 */
    engine?: string,
  ) => ipcRenderer.invoke(
    'acp:new-session',
    kiroLexId,
    cwd,
    model,
    projectId,
    kiroAgent,
    permissionMode,
    remoteId,
    engine,
  ),
  loadSession: (sessionId: string, cwd: string, model: string) => ipcRenderer.invoke('acp:load-session', sessionId, cwd, model),
  /** 会话里「缺 ACP 适配器」提示上的「安装」：本机全局 npm / 远端只装那一个。engine / remoteId 只在还没有记录（新建失败）时用。 */
  installAdapter: (sessionId: string, engine: string, remoteId?: string) =>
    ipcRenderer.invoke('acp:install-adapter', sessionId, engine, remoteId),
  /** 三个引擎在一台机器上的状态（'local' = 本机）：✅ / ⚠️ 没登录 / ❌ 没装；5 分钟缓存，force 跳过。 */
  enginesStatus: (machine: string, opts?: { force?: boolean }) => ipcRenderer.invoke('engines:status', machine, opts),
  /** ❌ → 直接装（本机 kiro-cli / 适配器；远端适配器只装那一个）。进度从 onEnginesInstallOutput 出来。 */
  enginesInstall: (machine: string, engine: string) => ipcRenderer.invoke('engines:install', machine, engine),
  onEnginesInstallOutput: (callback: (d: { machine: string; engine: string; chunk: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('engines:install-output', handler);
    return () => ipcRenderer.removeListener('engines:install-output', handler);
  },
  /** ⚠️ → 登录：本机开终端跑登录命令（{opened}）；远端回去哪登（{how}）。 */
  enginesLogin: (machine: string, engine: string) => ipcRenderer.invoke('engines:login', machine, engine),
  onAdapterInstallOutput: (callback: (d: { sessionId: string; chunk: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:adapter-install-output', handler);
    return () => ipcRenderer.removeListener('acp:adapter-install-output', handler);
  },
  primeHistory: (sessionId: string, force?: boolean) =>
    ipcRenderer.invoke('acp:prime-history', sessionId, force),
  /** Called when a chat becomes the active one, so its context is verified (and
   *  rebuilt) at open time rather than on the user's first send. */
  ensureContext: (sessionId: string) => ipcRenderer.invoke('acp:ensure-context', sessionId),
  setPrimeMode: (sessionId: string, primeMode: 'snapshot' | 'full') =>
    ipcRenderer.invoke('acp:set-prime-mode', sessionId, primeMode),
  listSessions: () => ipcRenderer.invoke('acp:list-sessions'),
  /**
   * 命名 agent 列表。**要传机器**：远程会话能用的是**那台**机器上 `~/.kiro/agents/` 里的那几个
   * （kiro-cli 只认它自己机器上的）。不传 = 本机。
   */
  listKiroAgents: (machine?: string) => ipcRenderer.invoke('kiro:list-agents', machine),
  /* 机器人按钮的其余 tab —— 跟着会话所在的机器（见 index.ts 的 kiro:config-*） */
  /** 机器人面板的 tab；按引擎（不传 = kiro）。 */
  kiroConfigCategories: (engine?: string) => ipcRenderer.invoke('kiro:config-categories', engine),
  kiroConfigList: (sessionId: string | undefined, category: string) => ipcRenderer.invoke('kiro:config-list', sessionId, category),
  kiroConfigRead: (sessionId: string | undefined, category: string, name?: string) => ipcRenderer.invoke('kiro:config-read', sessionId, category, name),
  kiroConfigWrite: (sessionId: string | undefined, category: string, name: string | undefined, content: string) =>
    ipcRenderer.invoke('kiro:config-write', sessionId, category, name, content),

  /* ----------------------------------------------------------- S3 备份 */
  /**
   * **secret 只往一个方向走** —— `getS3Config` 回的是 `hasSecret: boolean`，从不回明文。
   * 回一次就多一个泄漏面（渲染进程、devtools、任何一个 console.log 都够）。
   */
  getS3Config: () => ipcRenderer.invoke('s3:get-config'),
  /** 不传 `secretAccessKey` = 不改它（界面上那个框平时是空的）。 */
  saveS3Config: (input: any) => ipcRenderer.invoke('s3:save-config', input),
  /** 测连通：真写一个小对象再读回来 —— ListBucket 通不代表 PutObject 通。 */
  testS3: () => ipcRenderer.invoke('s3:test'),
  syncS3Now: () => ipcRenderer.invoke('s3:sync-now'),
  listS3Backups: () => ipcRenderer.invoke('s3:list-backups'),
  deleteS3Sessions: (ids: string[]) => ipcRenderer.invoke('s3:delete-sessions', ids),
  forgetS3Backups: (ids: string[]) => ipcRenderer.invoke('s3:forget-backups', ids),
  keepLocalS3Sessions: (ids: string[]) => ipcRenderer.invoke('s3:keep-local', ids),
  /** 云端自动清理：参与判定 / 已忽略的设备；云端回收站的列出、恢复到云端备份、立即彻底删除（要把目录名原样传回来） */
  s3CloudDevices: () => ipcRenderer.invoke('s3:cloud-devices'),
  listS3CloudTrash: () => ipcRenderer.invoke('s3:list-cloud-trash'),
  restoreS3CloudTrash: (dir: string) => ipcRenderer.invoke('s3:restore-cloud-trash', dir),
  purgeS3CloudTrash: (dir: string, confirm: string) => ipcRenderer.invoke('s3:purge-cloud-trash', dir, confirm),
  /** 同步时自动合并改了这条会话的 transcript —— 界面缓存要扔掉重读 */
  onSessionHistoryChanged: (callback: (d: { sessionId: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('session:history-changed', handler);
    return () => ipcRenderer.removeListener('session:history-changed', handler);
  },
  /** 同步时跟随了别的机器挪过的项目 / 归档 —— 侧栏要按新位置分组 */
  onSessionPlacementChanged: (callback: (d: { sessionId: string; projectId: string | null; archived: boolean }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('session:placement-changed', handler);
    return () => ipcRenderer.removeListener('session:placement-changed', handler);
  },
  /**
   * 有哪些项目、各多少条会话、哪些设成了不同步（「你得按 project 整理，有些project可以选择不同步」）。
   * 从会话记录现算 —— 这一页要回答的是"同步会覆盖到哪些东西"。
   */
  s3Projects: (): Promise<{
    projects: Array<{
      project: string; bytes: number; updatedAt: number; excluded: boolean;
      /** 这个项目下每条会话的同步状态（`state`: never / pending / synced）。 */
      sessions: Array<{
        id: string; title: string; updatedAt: number; bytes: number;
        syncedAt: number; state: 'never' | 'pending' | 'synced';
        /** 这条会话单独设成了不同步。 */
        excluded?: boolean;
      }>;
    }>;
    excludeProjects: string[];
    excludeSessions?: string[];
  }> => ipcRenderer.invoke('s3:projects'),
  /**
   * **删掉一个项目在桶里的备份**（不动本地）。不可逆，所以 `confirm` 必须原样是项目名 ——
   * 界面弹过一次确认，这一层再要一次是防"手滑点到别的项目那一行"。
   */
  s3DeleteProject: (project: string, confirm: string): Promise<{
    ok: boolean; error?: string; sessions?: number; deleted?: number; failed?: string[];
  }> => ipcRenderer.invoke('s3:delete-project', project, confirm),
  /** 恢复一条会话（覆盖同 id，覆盖前本地那份会被挪进 trash）。 */
  restoreS3Session: (sessionId: string) => ipcRenderer.invoke('s3:restore', sessionId),
  onS3SyncDone: (cb: (d: any) => void) => {
    const h = (_e: any, d: any) => cb(d);
    ipcRenderer.on('s3:sync-done', h);
    return () => ipcRenderer.removeListener('s3:sync-done', h);
  },
  openKiroAgentConfig: (sessionId: string, agentName: string, source?: 'built-in' | 'global' | 'local') => ipcRenderer.invoke('kiro:open-agent-config', sessionId, agentName, source),
  saveKiroAgentConfig: (sessionId: string, agentName: string, source: 'built-in' | 'global' | 'local' | undefined, content: string) => ipcRenderer.invoke('kiro:save-agent-config', sessionId, agentName, source, content),
  switchKiroAgent: (sessionId: string, agentName: string) => ipcRenderer.invoke('acp:switch-kiro-agent', sessionId, agentName),
  switchModel: (sessionId: string, model: string) => ipcRenderer.invoke('acp:switch-model', sessionId, model),
  engineModels: (sessionId: string) => ipcRenderer.invoke('acp:engine-models', sessionId),
  setEngineModel: (sessionId: string, model: string) => ipcRenderer.invoke('acp:set-engine-model', sessionId, model),
  setEngineOption: (sessionId: string, category: 'thought_level' | 'mode' | 'collaboration_mode', value: string) => ipcRenderer.invoke('acp:set-engine-option', sessionId, category, value),
  onEngineModels: (cb: (d: { sessionId: string; current: string; options: Array<{ value: string; name: string }>; effort?: any; mode?: any; busyEnter?: string }) => void) => {
    const handler = (_e: any, d: any) => cb(d);
    ipcRenderer.on('session:engine-models', handler);
    return () => ipcRenderer.removeListener('session:engine-models', handler);
  },
  /** Claude Code / Codex 的「组合」（`~/.kirolex/mcp-combos.json`，本机全局） */
  mcpCombos: (sessionId?: string) => ipcRenderer.invoke('acp:mcp-combos', sessionId),
  mcpCombosFile: () => ipcRenderer.invoke('acp:mcp-combos-file'),
  saveMcpCombos: (text: string) => ipcRenderer.invoke('acp:save-mcp-combos', text),
  /** 新会话默认组合：不传 project = 全局；传了 = 那个项目的覆盖（'' = 跟随全局） */
  defaultCombo: (project?: string) => ipcRenderer.invoke('acp:default-combo', project),
  setDefaultCombo: (comboId: string, project?: string) => ipcRenderer.invoke('acp:set-default-combo', comboId, project),
  switchMcpCombo: (sessionId: string, comboId: string) => ipcRenderer.invoke('acp:switch-mcp-combo', sessionId, comboId),
  onMcpCombosChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('acp:mcp-combos-changed', handler);
    return () => ipcRenderer.removeListener('acp:mcp-combos-changed', handler);
  },
  switchPermissionMode: (sessionId: string, permissionMode: 'auto-approve' | 'ask') =>
    ipcRenderer.invoke('acp:switch-permission-mode', sessionId, permissionMode),
  /** 忙时记下、这一轮跑完再切的那些切换（`pendingSwitch.ts`）：`{ [sessionId]: { kind: 新值 } }` */
  getPendingSwitches: (sessionId?: string) => ipcRenderer.invoke('acp:get-pending-switches', sessionId),
  /** `{ [sessionId]: 这段等待的开始时刻 }` —— 会话里那张卡片的「已等 N 秒」 */
  getPendingSwitchSince: () => ipcRenderer.invoke('acp:get-pending-switch-since'),
  cancelPendingSwitch: (sessionId: string, kind?: string) => ipcRenderer.invoke('acp:cancel-pending-switch', sessionId, kind),
  onPendingSwitches: (cb: (d: { sessionId: string; pending: Record<string, string>; since?: number | null }) => void) => {
    const handler = (_e: any, d: any) => cb(d);
    ipcRenderer.on('acp:pending-switches', handler);
    return () => ipcRenderer.removeListener('acp:pending-switches', handler);
  },
  onPendingSwitchResult: (cb: (d: { sessionId: string; applied: string[]; failed: Array<{ kind: string; label: string; error: string }>; profile: any; pending: Record<string, string>; since?: number | null }) => void) => {
    const handler = (_e: any, d: any) => cb(d);
    ipcRenderer.on('acp:pending-switch-result', handler);
    return () => ipcRenderer.removeListener('acp:pending-switch-result', handler);
  },
  readTranscript: (sessionId: string) => ipcRenderer.invoke('acp:read-transcript', sessionId),
  /** Store a pasted text blob on disk (composer keeps only a placeholder). */
  savePasteText: (text: string) => ipcRenderer.invoke('app:save-paste-text', text),
  /** Read a stored paste blob back (used when expanding a placeholder). */
  readPaste: (filePath: string) => ipcRenderer.invoke('app:read-paste', filePath),
  /** Paste blobs referenced by an unsent draft (per session, disk-backed). */
  /** Prompts already auto-resent after an interruption (per session). */
  getAutoResent: () => ipcRenderer.invoke('app:get-auto-resent'),
  setAutoResent: (sessionId: string, key: string) => ipcRenderer.invoke('app:set-auto-resent', sessionId, key),
  getDraftPastes: () => ipcRenderer.invoke('app:get-draft-pastes'),
  setDraftPastes: (sessionId: string, blocks: any[]) => ipcRenderer.invoke('app:set-draft-pastes', sessionId, blocks),
  truncateTranscriptBefore: (sessionId: string, messageId: string) =>
    ipcRenderer.invoke('acp:truncate-transcript-before', sessionId, messageId),
  /** 编辑重发：Claude Code / Codex 从保留下来的最后一条回复处分出新的后端会话（审计 10，main `acp:fork-backend-for-edit`） */
  forkBackendForEdit: (sessionId: string, keepIds: string[]) => ipcRenderer.invoke('acp:fork-backend-for-edit', sessionId, keepIds),
  rewriteTranscript: (sessionId: string, messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: any[] }>) =>
    ipcRenderer.invoke('acp:rewrite-transcript', sessionId, messages),
  // Durable on-disk session index (source of truth for the sidebar).
  listDurableSessions: () => ipcRenderer.invoke('acp:list-durable-sessions'),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('acp:delete-session', sessionId),
  // Write-once project assignment (design §6.4)
  assignProject: (sessionId: string, projectId: string) => ipcRenderer.invoke('acp:assign-project', sessionId, projectId),
  // Project-level force set/clear (rename/delete project)
  setProject: (sessionId: string, projectId: string | null) => ipcRenderer.invoke('acp:set-project', sessionId, projectId),
  moveSession: (sessionId: string, projectId: string | null) => ipcRenderer.invoke('acp:move-session', sessionId, projectId),
  archiveSession: (sessionId: string, archived: boolean) => ipcRenderer.invoke('acp:archive-session', sessionId, archived),
  /** 「会话信息」：会话 id / 后端会话 id / 运行位置 / 引擎 / 会话目录，排查时一次拿全 */
  sessionInfo: (sessionId: string) => ipcRenderer.invoke('acp:session-info', sessionId),
  getExecutorCap: () => ipcRenderer.invoke('acp:get-executor-cap'),
  reveal: () => ipcRenderer.invoke('acp:reveal'),
  /** 无边框窗口的三个按钮 —— 'minimize' | 'toggle-maximize' | 'close' */
  windowControl: (action: 'minimize' | 'toggle-maximize' | 'close') => ipcRenderer.invoke('window:control', action),
  /** 窗口是否最大化 + 标题条该留多高（Windows / Linux 自己画的那条，见 createWindow） */
  onWindowMaximized: (callback: (data: { maximized: boolean; height: number }) => void) => {
    const handler = (_event: any, data: { maximized: boolean; height: number }) => callback(data);
    ipcRenderer.on('window:maximized', handler);
    return () => ipcRenderer.removeListener('window:maximized', handler);
  },
  /** 界面缩放（整窗，像浏览器整页缩放）。factor = 百分比 / 100，值由渲染端的设置 uiZoom 决定 */
  setUiZoom: (factor: number) => { webFrame.setZoomFactor(factor); },
  /** Ctrl(⌘) + 加号 / 减号 / 0 —— 主进程 before-input-event 拦下后转过来（见 zoomKeys.ts） */
  onUiZoomKey: (callback: (action: 'in' | 'out' | 'reset') => void) => {
    const handler = (_event: any, action: 'in' | 'out' | 'reset') => callback(action);
    ipcRenderer.on('app:ui-zoom-key', handler);
    return () => ipcRenderer.removeListener('app:ui-zoom-key', handler);
  },
  splashStatus: (text: string) => ipcRenderer.invoke('acp:splash-status', text),
  deleteProjectMemory: (projectId: string) => ipcRenderer.invoke('acp:delete-project-memory', projectId),
  readMemory: (projectId?: string, sessionId?: string) => ipcRenderer.invoke('acp:read-memory', projectId, sessionId),
  /** 这条会话的斜杠命令表 —— 后端一条会话只推一次，窗口重载后渲染进程靠这个补回来。 */
  sessionCommands: (sessionId: string) => ipcRenderer.invoke('acp:session-commands', sessionId),
  /** The context blocks the LAST send actually carried (archived at send time), plus
   *  whether a hand-edited override is pinned for this chat -- the Snapshot tab has to
   *  say which of the two the next message will carry. */
  readLastInjection: (sessionId?: string) => ipcRenderer.invoke('acp:read-last-injection', sessionId),
  /** Pin a hand-edited context block; the next send uses it verbatim. Saving an empty
   *  string means "stop overriding", not "send an empty context". */
  writeContextOverride: (sessionId: string, text: string) => ipcRenderer.invoke('acp:write-context-override', sessionId, text),
  /** Drop the override and go back to the generated snapshot. */
  clearContextOverride: (sessionId: string) => ipcRenderer.invoke('acp:clear-context-override', sessionId),
  /** 清掉后端的活动上下文（`/clear`）—— flow 复用会话时用，transcript 不动。见 flowContext.ts */
  clearContext: (sessionId: string) => ipcRenderer.invoke('acp:clear-context', sessionId),
  /** 输入框 `/clear` 的历史水位线落盘 —— 之前的消息不再读回来，transcript 不删。见 `SessionRecord.clearedAt` */
  markCleared: (sessionId: string) => ipcRenderer.invoke('acp:mark-cleared', sessionId),
  writeMemory: (scope: 'global' | 'project' | 'session', projectId: string | undefined, sessionId: string | undefined, content: string) => ipcRenderer.invoke('acp:write-memory', scope, projectId, sessionId, content),
  /** 三层记忆各自的字节数。每轮注入后主进程也会主动推 `acp:memory-bytes`；这个 invoke 是给
   *  「打开就要看到」和「手动清理完立刻更新」两个时机用的。 */
  memoryBytes: (projectId?: string, sessionId?: string) => ipcRenderer.invoke('acp:memory-bytes', projectId, sessionId),
  /** 压缩某一层记忆前先备份（每层各留最近 3 份）。让模型重写自己的记忆文件而没有备份太危险 ——
   *  删会话时 memory 是硬删不进 trash，已经真实丢过一次。 */
  backupMemory: (scope: 'global' | 'project' | 'session', projectId?: string, sessionId?: string) =>
    ipcRenderer.invoke('acp:backup-memory', scope, projectId, sessionId),

  // Chat
  prompt: (sessionId: string, prompt: any[], model: string, projectId?: string, display?: { messageId?: string; displayText?: string; mergeIntoMessageId?: string; attachments?: any[]; pastes?: any[]; fromHandoff?: string[] }) => ipcRenderer.invoke('acp:prompt', sessionId, prompt, model, projectId, display),
  cancel: (sessionId: string, model: string, suppressInterruptionNotice = false) =>
    ipcRenderer.invoke('acp:cancel', sessionId, model, suppressInterruptionNotice),
  // Mid-turn steer: inject text into the running turn (kiro-cli _session/steer).
  // Resolves to { steered, reason } — the renderer falls back to the queue when
  // steered is false so the message is never dropped.
  // `msgId`: the optimistic steer's id -- if the adapter turns it into a turn of its own
  // (Codex `startedNewTurn`), that turn's user message id derives from it (detachedTurnMessageId).
  steer: (sessionId: string, message: string, msgId?: string) =>
    ipcRenderer.invoke('acp:steer', sessionId, message, msgId),
  /** 忙时 Enter 交给适配器排队（promptQueueing）：发出去就回 { accepted }（见主进程 acp:handoff-prompt） */
  handoffPrompt: (sessionId: string, prompt: any[], model?: string, projectId?: string, display?: { messageId?: string; displayText?: string; attachments?: any[]; pastes?: any[] }) =>
    ipcRenderer.invoke('acp:handoff-prompt', sessionId, prompt, model, projectId, display),
  /** 上一次运行留下的、交给了适配器却没轮到的那几条（窗口启动时取一次，放回 KiroLex 队列） */
  takePendingHandoffs: () => ipcRenderer.invoke('acp:take-pending-handoffs'),
  /** 没轮到就失败的那条已经放回 KiroLex 队列：主进程把队列写盘后摘掉它的记录 */
  ackHandoffFailed: (sessionId: string, messageId: string) => ipcRenderer.invoke('acp:ack-handoff-failed', sessionId, messageId),
  onHandoffFailed: (cb: (d: { sessionId: string; messageId?: string; notStarted: boolean; error: string; content?: string; attachments?: any[]; pastes?: any[] }) => void) => {
    const handler = (_e: any, d: any) => cb(d);
    ipcRenderer.on('acp:handoff-failed', handler);
    return () => ipcRenderer.removeListener('acp:handoff-failed', handler);
  },
  /** The exact text acp:steer will write (oversized image paths swapped for their capped copies),
   *  so the renderer can match the CONSUMED snapshot against it exactly. */
  capSteerText: (message: string) =>
    ipcRenderer.invoke('acp:cap-steer-text', message),
  /** Persist a steer the backend reported CONSUMED. Steers do not travel through
   *  `prompt`, so this is their only path to the durable transcript — and the
   *  transcript is what the context snapshot and history.md are rendered from. */
  persistSteer: (sessionId: string, text: string, messageId?: string, attachments?: { id?: string; name: string; path: string; isImage?: boolean }[]) =>
    ipcRenderer.invoke('acp:persist-steer', sessionId, text, messageId, attachments),
  /** Persist a renderer-produced assistant note (currently: why a loop ended).
   *  Same reason as persistSteer -- a message created in the renderer never reaches
   *  the durable transcript on its own, so the reason a loop stopped would die with
   *  the window. */
  persistNote: (sessionId: string, text: string, variants?: { zh: string; en: string }) =>
    ipcRenderer.invoke('acp:persist-note', sessionId, text, variants),

  /** This session's RUN EVENT LOG (events.jsonl): timestamped prompt/tool/permission
   *  boundaries. A separate file from the transcript on purpose -- the transcript has
   *  one timestamp per message, so tool durations and time spent waiting for a human
   *  are not recoverable from it. */
  readEvents: (sessionId: string, limit?: number) =>
    ipcRenderer.invoke('acp:read-events', sessionId, limit),

  /** Declare the verification command for this session's loop. Only a command
   *  registered here can later be executed by `loopVerify` -- the agent must never
   *  be able to choose its own check, or maker/checker separation is gone. Passing
   *  an empty command clears the registration (a level-0 loop). */
  loopRegisterVerifier: (sessionId: string, command: string, timeoutSec: number) =>
    ipcRenderer.invoke('loop:register-verifier', sessionId, command, timeoutSec),
  /** Run that command ONCE, out of band, on the same host as the agent (over SSH for
   *  a remote session). Resolves to a result even when the command could not start:
   *  `ran: false` is "the checker is broken", which the loop must not read as "the
   *  work is not done yet". */
  loopVerify: (sessionId: string, command: string, timeoutSec: number) =>
    ipcRenderer.invoke('loop:verify', sessionId, command, timeoutSec),
  respondPermission: (requestId: number | string, optionId: string, sessionId: string) =>
    ipcRenderer.invoke('acp:request-permission-response', requestId, optionId, sessionId),
  /** 回答 / 跳过模型的一次提问（提问卡片，main/elicitation.ts）。 */
  answerQuestion: (sessionId: string, cardId: string, action: 'accept' | 'decline', values?: Record<string, unknown>) =>
    ipcRenderer.invoke('acp:answer-question', sessionId, cardId, action, values),
  /** 切走一条会话时取消它挂着的提问（回 cancel、关卡片、落盘）。 */
  cancelQuestions: (sessionId: string) => ipcRenderer.invoke('acp:cancel-questions', sessionId),
  /** 还挂着的提问卡片（窗口重载后补回来）。 */
  pendingQuestions: () => ipcRenderer.invoke('acp:pending-questions'),

  /* ── DURABLE LOOPS ──
   *
   * The round counter lives in MAIN. It used to live in this window, so closing or
   * reloading the window reset it and a declared round cap silently became a fresh
   * budget on every restart. */

  /** Write the run down (spec + counters + terminal), at every round boundary. */
  loopPersist: (sessionId: string, run: any) => ipcRenderer.invoke('loop:persist', sessionId, run),
  /** Charge one round against the DURABLE counter, checkpointed before the send. Returns
   *  the updated run, or a terminal when the budget is spent. */
  loopBeginRound: (sessionId: string) => ipcRenderer.invoke('loop:begin-round', sessionId),
  loopRead: (sessionId: string) => ipcRenderer.invoke('loop:read', sessionId),
  /** Loops main is driving right now (they survive a reload and a restart). */
  loopListLive: () => ipcRenderer.invoke('loop:list-live'),
  loopClear: (sessionId: string) => ipcRenderer.invoke('loop:clear', sessionId),
  /** Start a loop: main drives it from here on (loopDriver.ts). */
  loopStart: (sessionId: string, spec: any) => ipcRenderer.invoke('loop:start', sessionId, spec),
  /** The user stopped it (Stop, /stop, force-stop). */
  loopStop: (sessionId: string) => ipcRenderer.invoke('loop:stop', sessionId, 'aborted'),
  /** A loop started, advanced or ended: re-read `loopListLive`. */
  onLoopChanged: (cb: (payload: any) => void) => {
    const handler = (_e: any, payload: any) => cb(payload);
    ipcRenderer.on('loop:changed', handler);
    return () => ipcRenderer.removeListener('loop:changed', handler);
  },

  /* ── SKILL FLOWS ──
   *
   * The step-by-step half of a skill: declared steps, out-of-band checks, human
   * approval gates, per-item idempotency on writes. The run lives in MAIN (and on
   * disk), not here: a gate has to survive this window being closed, which is exactly
   * what a renderer-owned run cannot do. */

  /* ── SCHEDULED TASKS (replaced loop mode) ──
   *
   * The ticker runs in MAIN, so "every Monday 9am" fires with no window open -- the old
   * loop's setTimeout lived in this window and stopped when it closed. */
  scheduleCreate: (sessionId: string, spec: any) => ipcRenderer.invoke('schedule:create', sessionId, spec),
  scheduleList: () => ipcRenderer.invoke('schedule:list'),
  schedulePause: (id: string, paused: boolean) => ipcRenderer.invoke('schedule:pause', id, paused),
  scheduleRemove: (id: string) => ipcRenderer.invoke('schedule:remove', id),
  /* 聊天顶部那条定时任务上的「⏳ 延长…」弹层：{ mode:'extend', ms } / { mode:'until', at } / { mode:'never' }（只有用户能设成不过期） */
  scheduleSetExpiry: (id: string, change: { mode: 'extend'; ms: number } | { mode: 'until'; at: number } | { mode: 'never' }) => ipcRenderer.invoke('schedule:set-expiry', id, change),
  /** 控制入口的「等待退出」（agent-board「拉取并重启」）：为真时排队消息先不发，等正在跑的那几轮结束后退出 */
  getPendingQuit: () => ipcRenderer.invoke('control:pending-quit'),
  onPendingQuit: (cb: (pending: boolean) => void) => {
    const handler = (_e: any, pending: boolean) => cb(!!pending);
    ipcRenderer.on('control:pending-quit', handler);
    return () => ipcRenderer.removeListener('control:pending-quit', handler);
  },
  /** 控制入口的 `POST /sessions/:id/send`：主进程转来，界面按 Enter 的同一套路由处理，再用 controlSendResult 回话 */
  onControlSend: (cb: (req: { reqId: string; sessionId: string; text: string; mode: 'auto' | 'next'; origin?: 'ctl' | 'xs' }) => void) => {
    const handler = (_e: any, req: any) => cb(req);
    ipcRenderer.on('control:send', handler);
    return () => ipcRenderer.removeListener('control:send', handler);
  },
  controlSendResult: (reqId: string, reply: unknown) => ipcRenderer.invoke('control:send-result', reqId, reply),
  controlReady: () => ipcRenderer.invoke('control:ready'),
  onScheduleChanged: (cb: (payload: any) => void) => {
    const handler = (_e: any, payload: any) => cb(payload);
    ipcRenderer.on('schedule:changed', handler);
    return () => ipcRenderer.removeListener('schedule:changed', handler);
  },

  /* ── 模型起的后台命令 / 监视（bg_run / watch，进程在 MAIN 里）—— 这里只列出来、给一个停止按钮 ── */
  bgList: () => ipcRenderer.invoke('bg:list'),
  bgStop: (jobId: string) => ipcRenderer.invoke('bg:stop', jobId),
  onBgChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('bg:changed', handler);
    return () => ipcRenderer.removeListener('bg:changed', handler);
  },
  /** 主进程自己发起的一轮（定时到点 / 后台命令退出 / 监视事件 / 「写成文字」的纠正）：插进这条消息，接管这一轮的流。`kirolex` = 显示成 KiroLex 提示。 */
  onMainTurn: (cb: (data: { sessionId: string; messageId: string; content: string; ts: number; kirolex?: true; handoff?: true; attachments?: any[] }) => void) => {
    const handler = (_e: any, data: any) => cb(data);
    ipcRenderer.on('acp:main-turn', handler);
    return () => ipcRenderer.removeListener('acp:main-turn', handler);
  },

  /** THE SKILLS KIRO HAS: ~/.kiro/skills/<name>/SKILL.md, parsed. Read-only -- a kiro
   *  skill is triggered by the MODEL matching its frontmatter description, not by a
   *  command, so KiroLex observes it and does not drive it. */

  /* ── RUNS: a project's instances of a registered skill ── */
  /** `name` 是你给这次运行起的名字（可省）—— 序号说不清这次跑的是什么，见 `StoredRun.name`。 */
  /** 给一次运行改名。传空字符串 = 清掉名字，回到显示 `#N`。 */
  /** 让这个 run 换上新版定义 —— 只有没跑过的部分能换，动到跑过的会被拒（见 `runAdopt`）。 */
  /** A project rename is a migration for its runs — they live under its name. */
  /** 退回这些步骤（连带下游）并释放它们的会话 —— 「关闭旧 session 然后重起新 session」 */
  /** 打开一个 run 时对一次账：把「写着 running 但没人在驱动」的节点补上记账（见 runReconcile.ts） */
  /** 某一步交出来的材料：按它 produces 声明的名字存进 run，下一步靠这个名字取 */
  /**
   * 一个 `file:` 产出的正文 —— 门上要能逐段 comment 它。
   *
   * 「这个门引用了一个文件，我无法对文件进行 comment 和要求修改」：`file:` 的产出不进 run `values`，
   * 所以门上原来只有一个链接按钮。路径的算法和 `fileOutputs` 那条检查同一套（见主进程 `run:read-file`）。
   */
  /** 太长装不进提示词的上游材料，落到工作目录里，返回给它的路径（`~/…`）。 */
  /** 你在画布上填的输入：存在 run 上，刷新还在，另一个窗口也看得到 */
  /** 在流程窗口里加的一步：只写进这个 run 的 draft 副本，定义和指纹都不动 */
  /** 把会话的角色写进记录（flow 主会话的删除保护靠它，必须活过重启） */
  /** 会话标题落盘 —— 不落盘的话一刷新就退回 `New Chat`（见 `acp:rename-session`） */
  renameSessionOnDisk: (sessionId: string, title: string) => ipcRenderer.invoke('acp:rename-session', sessionId, title),
  markSessionPurpose: (sessionId: string, purpose: string, flow?: string) =>
    ipcRenderer.invoke('acp:mark-session-purpose', sessionId, purpose, flow),
  /** 把一个 flow 从这个 project 移出（配置动作，历史不动） */
  /** 这些项目名里哪些是 KiroLex Advanced 专属的 flow 项目（标准版不显示）。 */
  advancedOnlyProjects: (names: string[]) => ipcRenderer.invoke('app:advanced-only-projects', names),
  /** project 的工作目录 —— 它的会话都在这儿干活（空 = 家目录） */
  projectGetWorkspace: (project: string) => ipcRenderer.invoke('project:get-workspace', project),
  projectSetWorkspace: (project: string, workspace: string) =>
    ipcRenderer.invoke('project:set-workspace', project, workspace),
  /** 删掉某个 flow 在这个 project 的全部运行历史（进回收站，返回条数） */
  /** A skill's execution environment: which kiro agent its steps run under. */
  /** 注册表变了(保存/确认/配 agent/配模型/删除)。画布靠它按文件重画 */
  onFlowRegChanged: (callback: (data: { name: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    return () => ipcRenderer.removeListener('flowreg:changed', handler);
  },
  /** Refused unless that chat is in the run's own project — 「在跑的必须是project里面的会话」. */
  openRunWindow: (project: string, id: string) => ipcRenderer.invoke('window:open-run', project, id),
  /** From the run window: bring the main window forward on the chat that ran a step. */
  focusSession: (sessionId: string) => ipcRenderer.invoke('window:focus-session', sessionId),
  /** 钉住的会话闲下来了：主进程判断窗口不在前台才弹系统通知；点通知走 `onFocusSessionRequest` 那条路。 */
  notifySessionIdle: (payload: { sessionId: string; title: string; body: string }) => ipcRenderer.invoke('app:notify-session-idle', payload),
  onFocusSessionRequest: (handler: (payload: { sessionId: string }) => void) => {
    const listener = (_e: unknown, payload: { sessionId: string }) => handler(payload);
    ipcRenderer.on('session:focus-request', listener);
    return () => ipcRenderer.removeListener('session:focus-request', listener);
  },
  /** Main owns run state; every window hears about a change. Returns an unsubscribe. */
  onRunChanged: (handler: (payload: { project: string; id: string }) => void) => {
    const listener = (_e: unknown, payload: { project: string; id: string }) => handler(payload);
    return () => ipcRenderer.removeListener('run:changed', listener);
  },

  /** Validate a flow file and return its parsed shape, without running anything. */
  /** Start a run and drive it to its first stopping point (a gate, a failure, or done). */
  /** Answer a gate. The run is re-read from disk first, so an approval given after a
   *  restart lands on the real state rather than on a copy this window remembers. */
  /** Every run on disk, pending gates included -- the way back to a paused flow when
   *  no id survived in memory. */
  /** One run in full (steps + ledger + flowPath), for the visualiser. */
  onFlowUpdate: (cb: (payload: any) => void) => {
    const handler = (_e: any, payload: any) => cb(payload);
    ipcRenderer.on('flow:update', handler);
    return () => ipcRenderer.removeListener('flow:update', handler);
  },
  onFlowNote: (cb: (payload: any) => void) => {
    const handler = (_e: any, payload: any) => cb(payload);
    ipcRenderer.on('flow:note', handler);
    return () => ipcRenderer.removeListener('flow:note', handler);
  },
  
  // Models
  /**
   * 某台机器上能用的模型。`machine` 省略 / `'local'` = 本机；否则是设置里那台远端的 id。
   * 远程会话必须问**它自己那台机器** —— 两边 kiro-cli 版本不同，模型集就不同。
   */
  listModels: (machine?: string) => ipcRenderer.invoke('acp:list-models', machine),
  listHelperModels: (opts?: { cachedOnly?: boolean }) => ipcRenderer.invoke('acp:list-helper-models', opts),
  getUsage: () => ipcRenderer.invoke('acp:get-usage'),
  generateTitle: (firstUser: string, firstAssistant?: string, sessionId?: string) => ipcRenderer.invoke('app:generate-title', firstUser, firstAssistant, sessionId),
  generateSuggestions: (recentConvo: string, meta?: { sessionId?: string | null; messages?: number; paneFocused?: boolean }) => ipcRenderer.invoke('app:generate-suggestions', recentConvo, meta),
  setSessionPinned: (id: string, pinned: boolean) => ipcRenderer.invoke('acp:set-session-pinned', id, pinned),
  getHomeDir: () => ipcRenderer.invoke('app:get-home-dir'),
  getLogs: (maxLines?: number) => ipcRenderer.invoke('app:get-logs', maxLines),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  /* 渲染层的会话视图诊断进主进程日志（见 index.ts 的 diag:session-view） */
  diagSessionView: (event: string, detail: Record<string, unknown>) => ipcRenderer.send('diag:session-view', event, detail),
  openExternal: (target: string, sessionId?: string) =>
    ipcRenderer.invoke('app:open-external', target, sessionId),
  getExecutorCapInfo: () => ipcRenderer.invoke('app:get-executor-cap-info'),
  /** User-selectable features. Both sides read live values, so a toggle takes
   *  effect on the next operation without restarting the app. */
  /** Cap an image attachment's dimensions (Bedrock rejects >2000px in multi-image
   *  requests, and the check covers the whole conversation history). */
  prepareImageAttachment: (filePath: string) => ipcRenderer.invoke('app:prepare-image-attachment', filePath),
  getFeatures: () => ipcRenderer.invoke('app:get-features'),
  /** 开/关 kiro-cli 的 trace 日志 —— 一个代价按 GB 计的开关，界面上必须看得见（见 `app:get-features`） */
  setKiroTrace: (enabled: boolean) => ipcRenderer.invoke('app:set-kiro-trace', enabled),
  setFeature: (key: string, enabled: boolean) => ipcRenderer.invoke('app:set-feature', key, enabled),
  setExecutorCap: (n: number) => ipcRenderer.invoke('app:set-executor-cap', n),
  /** Silence threshold, in seconds, before a protocol-silent turn is treated as wedged
   *  and interrupted. 0 = never interrupt. Protocol silence is the WHOLE rule now: the
   *  CPU corroboration was removed as uninformative. */
  getWedgeTimeout: () => ipcRenderer.invoke('app:get-wedge-timeout'),
  setWedgeTimeout: (n: number) => ipcRenderer.invoke('app:set-wedge-timeout', n),
  /** 「远程会话从本机转发的 MCP」名单（存在 ~/.kirolex/config.json，不进 Kiro 的 agent 文件）。 */
  getForwardMcp: () => ipcRenderer.invoke('app:get-forward-mcp'),
  /** local_browser（接管用户已登录的浏览器，只读）：设置 / 连接状态 / 新域名确认。 */
  browserStatus: () => ipcRenderer.invoke('browser:get-status'),
  browserSetConfig: (patch: { enabled?: boolean; browser?: string; firefoxPort?: number }) => ipcRenderer.invoke('browser:set-config', patch),
  browserConnect: (kind: string) => ipcRenderer.invoke('browser:connect', kind),
  browserRestartFirefox: () => ipcRenderer.invoke('browser:restart-firefox'),
  browserDomainReply: (id: string, decision: 'once' | 'session' | 'deny') => ipcRenderer.invoke('browser:domain-reply', id, decision),
  browserPendingAsks: () => ipcRenderer.invoke('browser:pending-asks'),
  onBrowserDomainAsk: (callback: (ask: any) => void) => {
    const handler = (_event: any, ask: any) => callback(ask);
    ipcRenderer.on('browser:domain-ask', handler);
    return () => ipcRenderer.removeListener('browser:domain-ask', handler);
  },
  /** 总开关被关掉：这些还没答复的确认作废了，界面上收掉。 */
  onBrowserDomainAskCancelled: (callback: (ids: string[]) => void) => {
    const handler = (_event: any, ids: string[]) => callback(ids);
    ipcRenderer.on('browser:domain-ask-cancelled', handler);
    return () => ipcRenderer.removeListener('browser:domain-ask-cancelled', handler);
  },
  onBrowserStatusChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('browser:status-changed', handler);
    return () => ipcRenderer.removeListener('browser:status-changed', handler);
  },
  setForwardMcp: (list: Array<{ name: string; timeoutSec?: number }>) => ipcRenderer.invoke('app:set-forward-mcp', list),
  /** How long an open tool call may go without an update before it stops counting as
   *  progress. Bounds the tool-call guard so a missing closing update cannot disable
   *  wedge detection for a whole turn. */
  getToolStallTimeout: () => ipcRenderer.invoke('app:get-tool-stall-timeout'),
  setToolStallTimeout: (n: number) => ipcRenderer.invoke('app:set-tool-stall-timeout', n),
  /** Models for KiroLex's own background chores (chat titles, prompt suggestions).
   *  Primary is tried first, fallback only if it cannot answer. */
  getWorkspaceDir: () => ipcRenderer.invoke('app:get-workspace-dir'),
  setWorkspaceDir: (dir: string) => ipcRenderer.invoke('app:set-workspace-dir', dir),
  getHelperModels: () => ipcRenderer.invoke('app:get-helper-models'),
  setHelperModels: (model: string, fallback: string) => ipcRenderer.invoke('app:set-helper-models', model, fallback),
  pickFiles: () => ipcRenderer.invoke('app:pick-files'),
  saveClipboardImage: () => ipcRenderer.invoke('app:save-clipboard-image'),

  /* Registered skills: a skill must be registered (structure rewritten, reviewed, frozen) before a
     project can select it. Stored under ~/.kirolex/flows, never under ~/.kiro. */
  /** Confirming carries the fingerprint the human was looking at; main refuses a mismatch. */
  /** 重命名：注册表 + run 记录 + 会话记录上的 flow 引用一起迁（主进程编排，见 `flowreg:rename`） */
  /** sessionId is an OPTIONAL hint that only decides the default directory and what
   *  relative paths resolve against — the browser works with no chat connected. */
  workspaceList: (sessionId?: string | null, directory?: string) =>
    ipcRenderer.invoke('workspace:list', sessionId, directory),
  workspaceRead: (sessionId: string | null | undefined, filePath: string) =>
    ipcRenderer.invoke('workspace:read', sessionId, filePath),
  /** Session-independent image read, for attachment thumbnails. workspaceRead
   *  refuses when the chat has no live backend, which is not a sensible condition
   *  for showing a picture that is sitting on disk. */
  readImageDataUrl: (filePath: string) =>
    ipcRenderer.invoke('app:image-data-url', filePath),
  pathExists: (filePath: string, sessionId?: string) =>
    ipcRenderer.invoke('app:path-exists', filePath, sessionId),
  /** 在资源管理器 / Finder 里打开文件所在文件夹并选中该文件 */
  showItemInFolder: (filePath: string, sessionId?: string) =>
    ipcRenderer.invoke('app:show-in-folder', filePath, sessionId),
  workspaceDownload: (sessionId: string | null | undefined, filePath: string) =>
    ipcRenderer.invoke('workspace:download', sessionId, filePath),
  /** 远程会话落在远端的文件 → 经 ssh 读出来写进这条会话的本机文件夹，回本机路径 */
  copyRemoteToLocal: (sessionId: string, remotePath: string) =>
    ipcRenderer.invoke('workspace:copy-remote-to-local', sessionId, remotePath),
  /**
   * 侧栏 review 的「✓ 确认」：把一条意见发给**打开这份文件的那条会话**，等它回改完的正文。
   * 正忙就在主进程里排队；`cannot` = 它说这条改不了单独一段（渲染层据此升级到 `patch`）。
   */
  reviseInSession: (input: { sessionId: string; where: string; note: string; about?: string; scope?: 'block' | 'patch' | 'insert'; label?: string; full?: string; fromLine?: number; toLine?: number; ticket?: string; apply?: { path: string; mode: 'splice' | 'insert' | 'patch'; from?: number; to?: number; base: string } }) =>
    ipcRenderer.invoke('review:revise-in-session', input),
  /** 把改完的正文写回这份文件 —— 路径按这条会话解析，只许写这条会话的标签页读过的，写前备份。 */
  reviewWriteFile: (sessionId: string | null | undefined, filePath: string, text: string, expectBase?: string) =>
    ipcRenderer.invoke('review:write-file', sessionId, filePath, text, expectBase),
  /** 只拷一份（「提交给这份文件的会话」那条路：会话自己改文件，走不到上面那道写前备份）。 */
  reviewBackupFile: (sessionId: string | null | undefined, filePath: string) =>
    ipcRenderer.invoke('review:backup-file', sessionId, filePath),
  /** `.pptx`/`.docx`… → 一个 PDF（`.pdf` 直通，不需要 LibreOffice）+ 讲稿。路径按 `sessionId` 解析。 */
  previewDeck: (sessionId: string | null | undefined, filePath: string, force?: boolean) =>
    ipcRenderer.invoke('preview:deck', sessionId, filePath, force),
  /** PDF 的字节（base64）—— 渲染层取不到 `file://`。只给预览缓存里的，或这条会话读过的 `.pdf`。 */
  previewPdfBytes: (sessionId: string | null | undefined, pdfPath: string) =>
    ipcRenderer.invoke('preview:pdf-bytes', sessionId, pdfPath),
  /** 改**一页**的演讲者备注（一页一个 XML part，不重导整份）—— 写前备份。 */
  deckWriteNote: (sessionId: string | null | undefined, filePath: string, page: number, text: string, expect?: string) =>
    ipcRenderer.invoke('deck:write-note', sessionId, filePath, page, text, expect),
  /** 问打开这份 deck 的会话这一页的字该怎么改，KiroLex 按 run 地址写进去（正忙就排队）。 */
  /** 取消侧栏 comment 提交的**那一次**改写（按 ticket）—— 没轮到的直接不跑，在跑的只停它那一轮，不碰别的对话。 */
  reviewCancel: (ticket: string) => ipcRenderer.invoke('review:cancel', ticket),
  /** 这几个 ticket 里哪些已经在主进程写完盘了（窗口 reload 回来时用：做完的不再当标记放回去）。 */
  reviewTicketsDone: (tickets: string[]): Promise<string[]> => ipcRenderer.invoke('review:tickets-done', tickets),
  reviewTicketsStatus: (tickets: string[]): Promise<Record<string, string>> => ipcRenderer.invoke('review:tickets-status', tickets),
  deckReviseSlideText: (input: { sessionId: string; filePath: string; page: number; note: string; ticket?: string }) =>
    ipcRenderer.invoke('deck:revise-slide-text', input),
  /** 读一页幻灯片上的文字（按 run 地址）。 */
  deckReadSlideText: (sessionId: string | null | undefined, filePath: string, page: number) =>
    ipcRenderer.invoke('deck:read-slide-text', sessionId, filePath, page),
  /** 按 run 地址直接写一页的文字（`地址` 形如 `2.0.0`）。 */
  deckWriteSlideText: (sessionId: string | null | undefined, filePath: string, page: number, edits: Array<{ at: string; text: string }>) =>
    ipcRenderer.invoke('deck:write-slide-text', sessionId, filePath, page, edits),
  /** 在某条会话里留一行 KiroLex 自己说的话（显示，但不发给模型）。 */
  sessionNote: (sessionId: string, text: string, variants?: { zh: string; en: string }) => ipcRenderer.invoke('session:note', sessionId, text, variants),
  /** Watch exactly these files for on-disk edits, replacing any previous set.
   *  Main watches their parent directories (a save is usually write+rename, which a
   *  per-file watcher stops following), and reports each change once, debounced. */
  workspaceWatchFiles: (sessionId: string | null | undefined, paths: string[]) =>
    ipcRenderer.invoke('workspace:watch-files', sessionId, paths),
  /** One watched file changed on disk (or disappeared: `exists: false`). */
  onWorkspaceFileChanged: (callback: (data: { path: string; exists: boolean; mtimeMs: number }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('workspace:file-changed', handler);
    return () => ipcRenderer.removeListener('workspace:file-changed', handler);
  },

  /* ---------------------------------------------------- 远程会话（远端执行） */
  /** 可选的远端列表。flag 关着时 `enabled: false` + 空列表 → 界面完全不显示目标选择。 */
  remoteTargets: (): Promise<{
    enabled: boolean;
    targets: { id: string; label: string; sshHost: string; remoteWorkdir?: string; bins?: { kiro?: string; claude?: string; codex?: string } }[];
    localBins?: { kiro?: string; claude?: string; codex?: string };
  }> => ipcRenderer.invoke('app:remote-targets'),
  /** 加/改一台远端（只动 config.json 的 `remotes`，原子写）。 */
  remoteSave: (input: { id?: string; label?: string; sshHost: string; sshPort?: number; identityFile?: string; proxyJump?: string; remoteWorkdir?: string }) =>
    ipcRenderer.invoke('remote:save', input),
  /** 从可选列表里删掉一台（正在用它的会话不受影响 —— 目标存在各自的 profile 里）。 */
  remoteDelete: (id: string) => ipcRenderer.invoke('remote:delete', id),
  /**
   * **一键把远端装齐**：kiro-cli / claude code / codex / rsync / git / node。
   * 输出边跑边从 `onRemoteBootstrapOutput` 出来（装东西要几分钟，不给看就像卡死）。
   */
  remoteBootstrap: (input: { sshHost: string; sshPort?: number; identityFile?: string; proxyJump?: string; force?: boolean }) =>
    ipcRenderer.invoke('remote:bootstrap', input),
  onRemoteBootstrapOutput: (callback: (d: { sshHost: string; chunk: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('remote:bootstrap-output', handler);
    return () => ipcRenderer.removeListener('remote:bootstrap-output', handler);
  },
  /** 远程机器的 AI 工具配置（`~/.kirolex/agent-profiles/`）：读 / 存 / 和某台机器比 / 同步过去（index.ts `agent-profile:*`）。 */
  agentProfileRead: () => ipcRenderer.invoke('agent-profile:read'),
  agentProfileSave: (engine: 'claude' | 'codex', text: string, expected?: string | null) => ipcRenderer.invoke('agent-profile:save', engine, text, expected),
  agentProfileOpenDir: () => ipcRenderer.invoke('agent-profile:open-dir'),
  agentProfileDiff: (remoteId: string) => ipcRenderer.invoke('agent-profile:diff', remoteId),
  agentProfilePlan: (remoteId: string) => ipcRenderer.invoke('agent-profile:plan', remoteId),
  agentProfileSync: (remoteId: string) => ipcRenderer.invoke('agent-profile:sync', remoteId),
  onAgentProfileSyncOutput: (callback: (d: { remoteId: string; chunk: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('agent-profile:sync-output', handler);
    return () => ipcRenderer.removeListener('agent-profile:sync-output', handler);
  },
  onAgentProfileChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('agent-profile:changed', handler);
    return () => ipcRenderer.removeListener('agent-profile:changed', handler);
  },
  /**
   * **把一条已有会话切到另一台机器（或切回本地）**。`remoteId` 传 null = 本地。
   * 切到远端时要给项目目录（没给就用记录里的那个；都没有会报错 —— 远端要镜像的就是它）。
   */
  setRemoteTarget: (sessionId: string, remoteId: string | null, localDir?: string, hint?: { projectId?: string | null; engine?: string; remoteId?: string | null }) =>
    ipcRenderer.invoke('acp:set-remote-target', sessionId, remoteId, localDir, hint),
  /**
   * **KiroLex 自己对你说的一句话**（推/拉进度、冲突、换机器…）。
   *
   * 这些不进 transcript：它们不是对话内容，写进去会打断对话的读法、把 transcript 撑大
   * （远程会话每轮都要推它），还得靠"别发给模型"那条过滤一直兜着。界面显示在输入框上方、自动消失。
   */
  onSessionNotice: (callback: (d: { sessionId: string; text: string; ts: number; copyRemote?: string[]; sticky?: boolean; variants?: { zh: string; en: string } }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('session:notice', handler);
    return () => ipcRenderer.removeListener('session:notice', handler);
  },
  /**
   * 存**本机**那三个 CLI 的启动命令（kiro / claude / codex）。
   * 空 = 用默认。远端那份跟着各自的机器配置走（`remoteSave` 里的 `bins`）。
   */
  /** 本机工作目录（没归项目的本地会话在这里干活；默认 `~/kirolex`）。 */
  localSaveWorkdir: (dir: string) => ipcRenderer.invoke('local:save-workdir', dir),
  localSaveBins: (bins: { kiro?: string; claude?: string; codex?: string }) =>
    ipcRenderer.invoke('local:save-bins', bins),
  /**
   * **自动检测那三个工具**（`machine` = `'local'` 或某台远端的 id）。
   * 返回每个工具的候选：命令、版本、能不能起来、以及"以前起过"（历史里有）。
   */
  binsDetect: (machine: string): Promise<{
    ok: boolean;
    error?: string;
    tools?: Record<'kiro' | 'claude' | 'codex', Array<{ command: string; version?: string; ok: boolean; error?: string; known?: boolean }>>;
  }> => ipcRenderer.invoke('bins:detect', machine),
  /** 测一条命令能不能起来。 */
  binsTest: (machine: string, command: string): Promise<{ ok: boolean; version?: string; error?: string }> =>
    ipcRenderer.invoke('bins:test', machine, command),
  /**
   * **两边的 kiro-cli 各是什么版本**。`remote` 是 undefined 时表示"还没探过那台机器",
   * 而那**不等于**旧 —— 界面别在那种情况下显示"落后"。
   */
  kiroVersions: (machine?: string): Promise<{
    ok: boolean; error?: string; local?: string; remote?: string; outdated?: boolean;
  }> => ipcRenderer.invoke('kiro:versions', machine),
  /**
   * **更新某台机器上的 kiro-cli**（`'local'` 或某台远端的 id —— 两边一视同仁）。
   *
   * 有会话连着时第一次返回 `needsConfirm` 和"有几条在用"，人看过之后再带 `force` 调一次:
   * 那个二进制是那台机器上**所有**执行器共用的，换掉之后下一次重连/换模型就是新版本。
   */
  kiroUpdate: (machine: string, force?: boolean): Promise<{
    ok: boolean; error?: string; needsConfirm?: boolean; inUse?: number;
    from?: string; to?: string; changed?: boolean; log?: string;
  }> => ipcRenderer.invoke('kiro:update', machine, force),
  /** 选一个项目目录（切到远端时用）。 */
  remotePickDir: (): Promise<{ path: string }> => ipcRenderer.invoke('remote:pick-dir'),
  /**
   * 某条会话的运行位置变了（换机器）。
   *
   * 徽标和右键菜单里那句「运行位置：…」用的是**同一份**会话状态，不听这个事件的话两处都会停在旧值上
   * —— 实测就是这样：切完了，但侧栏没徽标、菜单还写着"本地"。
   */
  /** 🔑 登录：远端机器上 Claude Code / Codex 的登录状态 / 写网关配置 / 官方账号登录。 */
  aiLoginStatus: (machine: string) => ipcRenderer.invoke('ai-login:status', machine),
  aiLoginApply: (machine: string, input: any) => ipcRenderer.invoke('ai-login:apply', machine, input),
  /** 本机那份配置变成编辑器文本（「拷入本机配置」）；只读本机，不写任何地方。 */
  aiLoginLocalConfig: (tool: 'claude' | 'codex') => ipcRenderer.invoke('ai-login:local-config', tool),
  aiLoginRun: (machine: string, tool: 'claude' | 'codex', opts?: { console?: boolean }) => ipcRenderer.invoke('ai-login:run', machine, tool, opts),
  aiLoginInput: (runId: string, line: string) => ipcRenderer.invoke('ai-login:input', runId, line),
  aiLoginCancel: (runId: string) => ipcRenderer.invoke('ai-login:cancel', runId),
  onAiLoginOutput: (callback: (d: { runId: string; chunk: string }) => void) => {
    const handler = (_event: any, d: any) => callback(d);
    ipcRenderer.on('ai-login:output', handler);
    return () => ipcRenderer.removeListener('ai-login:output', handler);
  },
  onAiLoginExit: (callback: (d: { runId: string; code: number | null }) => void) => {
    const handler = (_event: any, d: any) => callback(d);
    ipcRenderer.on('ai-login:exit', handler);
    return () => ipcRenderer.removeListener('ai-login:exit', handler);
  },
  /** 给已有的会话换引擎（kiro / claude / codex）。没连着的只改记录。 */
  switchEngine: (sessionId: string, engine: string, hint?: { projectId?: string | null; engine?: string; remoteId?: string | null }) => ipcRenderer.invoke('acp:switch-engine', sessionId, engine, hint),
  onEngineChanged: (callback: (d: { sessionId: string; engine: 'kiro' | 'claude' | 'codex' }) => void) => {
    const handler = (_event: any, d: any) => callback(d);
    ipcRenderer.on('session:engine-changed', handler);
    return () => ipcRenderer.removeListener('session:engine-changed', handler);
  },
  onTargetsChanged: (callback: (d: { sessionId: string; remoteHost: string | null; remoteId?: string | null; localDir?: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('session:targets-changed', handler);
    return () => ipcRenderer.removeListener('session:targets-changed', handler);
  },
  /** 用 Finder 选私钥（默认开在 ~/.ssh，并显示隐藏文件 —— 否则那个目录根本看不到）。 */
  remotePickKey: (): Promise<{ path: string }> => ipcRenderer.invoke('remote:pick-key'),
  /** 测试连接：工具装齐了吗、登录了吗、连得上吗。三种情况三句话。 */
  remoteTest: (input: { sshHost: string; sshPort?: number; identityFile?: string; proxyJump?: string; remoteWorkdir?: string }) =>
    ipcRenderer.invoke('remote:test', input),

  // Events
  onUpdate: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:update', handler);
    return () => ipcRenderer.removeListener('acp:update', handler);
  },
  /** 主进程在启动清扫里收掉了这些会话（无主的 flow worker）—— 渲染层要按 id 把它们从侧栏摘掉，
   *  否则会留下一排点进去是空的行，要到下次启动才消失。 */
  /**
   * 主进程记完一步的账之后推一把 —— run 可能有新的一波能跑了。
   *
   * 驱动器在渲染层，而它那条 promise 链会随窗口重载一起消失（见 `run:advance` 的注释）。
   */
  onRunAdvance: (callback: (data: { project: string; id: string }) => void) => {
    const handler = (_e: unknown, data: { project: string; id: string }) => callback(data);
    return () => ipcRenderer.removeListener('run:advance', handler);
  },
  onSessionsPurged: (callback: (data: { sessionIds: string[] }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:sessions-purged', handler);
    return () => ipcRenderer.removeListener('acp:sessions-purged', handler);
  },
  /** 每轮注入后播报的三层记忆体积。横幅靠它自动出现和自动消失。 */
  onMemoryBytes: (callback: (data: {
    sessionId: string; projectId: string | null; global: number; project: number; session: number;
  }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:memory-bytes', handler);
    return () => ipcRenderer.removeListener('acp:memory-bytes', handler);
  },
  onError: (callback: (error: any) => void) => {
    const handler = (_event: any, error: any) => callback(error);
    ipcRenderer.on('acp:error', handler);
    return () => ipcRenderer.removeListener('acp:error', handler);
  },
  /** 后端 stderr 里筛出来的那几行（MCP / 认证 / 工具 / 明确的 error），见 `stderrNotice.ts`。 */
  onNotice: (callback: (n: { sessionId: string; level: string; kind: string; label: string; text: string }) => void) => {
    const handler = (_event: any, n: any) => callback(n);
    ipcRenderer.on('acp:notice', handler);
    return () => ipcRenderer.removeListener('acp:notice', handler);
  },
  /** Per-session backend occupancy (turn / reconfiguring / attaching / priming). */
  onSessionBusy: (callback: (data: { sessionId: string; reason: string | null; detail?: string; detailVariants?: { zh: string; en: string } }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:session-busy', handler);
    return () => ipcRenderer.removeListener('acp:session-busy', handler);
  },
  /**
   * KIRO'S NATIVE SUBAGENTS for one chat, as kiro reports them (`_kiro.dev/subagent/list_update`).
   * The full roster every time — the last one of a turn is the one that says everything terminated,
   * which is what ends the left-rail tag.
   */
  onSubagents: (callback: (data: {
    sessionId: string;
    subagents: Array<{ sessionId: string; name: string; agentName: string; task: string; statusType: string; statusMessage?: string; group?: string; createdAtMs?: number }>;
  }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:subagents', handler);
    return () => ipcRenderer.removeListener('acp:subagents', handler);
  },
  /** 主进程 `noteInSession` 刚写进对话记录的一条 KiroLex 提示 —— 界面当场插进那条会话（不用等重新打开才看见）。 */
  onUserMessage: (callback: (data: { sessionId: string; messageId: string; content: string; ts: number; kirolex?: true; variants?: { zh: string; en: string }; noteGroup?: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:user-message', handler);
    return () => ipcRenderer.removeListener('acp:user-message', handler);
  },
  getBusyMap: (): Promise<Record<string, string>> => ipcRenderer.invoke('acp:get-busy-map'),
  /** 新建会话走到哪一步了（连接远端 / 检查环境 / 启动引擎 / 就绪 / 失败）—— 见 main/creationGate.ts */
  getCreateStages: (): Promise<any[]> => ipcRenderer.invoke('acp:get-create-stages'),
  getCreateArgs: (sessionId: string): Promise<any> => ipcRenderer.invoke('acp:get-create-args', sessionId),
  onCreateStage: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:create-stage', handler);
    return () => ipcRenderer.removeListener('acp:create-stage', handler);
  },
  /** Is a turn RUNNING for this chat, and what has it produced so far? Lets a reloaded window
   *  adopt a turn that never stopped, instead of resending the question and billing it twice. */
  peekTurn: (sessionId: string): Promise<{ live: boolean; messageId: string | null; text: string; startedAt: number | null }> =>
    ipcRenderer.invoke('acp:peek-turn', sessionId),
  /** Authoritative full assistant text at turn end (heals dropped chunks). */
  onAssistantFinal: (callback: (data: { sessionId: string; messageId: string; text: string; toolTailFrom?: number; replyTo?: string; replyComplete?: true; segmentBreaks?: number[] }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:assistant-final', handler);
    return () => ipcRenderer.removeListener('acp:assistant-final', handler);
  },
  /** The model a session is REALLY running (after a connect-time or prompt-time
   *  fallback). The selector must follow this, not the last locally-chosen value. */
  onSessionModel: (callback: (data: { sessionId: string; model: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:session-model', handler);
    return () => ipcRenderer.removeListener('acp:session-model', handler);
  },
  /** The current turn is being resent (stall retry / model swap): drop the
   *  partial assistant output so the retry does not duplicate it on screen. */
  onTurnRestart: (callback: (data: { sessionId: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:turn-restart', handler);
    return () => ipcRenderer.removeListener('acp:turn-restart', handler);
  },
  /** A turn has produced no output for a long while. INFORMATIONAL ONLY — the
   *  turn keeps running; KiroLex never interrupts a long task by itself.
   *
   *  `boundBy`/`boundSeconds` say WHICH threshold the countdown comes from, so the
   *  notice can name it: with a tool call open the governing bound is the tool
   *  no-progress limit, not the silence threshold shown first in Settings. */
  onTurnQuiet: (callback: (data: { sessionId: string; quietSeconds: number; openTools?: number; toolIdleSeconds?: number; interruptInSeconds?: number | null; boundBy?: 'tool' | 'quiet'; boundSeconds?: number }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:turn-quiet', handler);
    return () => ipcRenderer.removeListener('acp:turn-quiet', handler);
  },
  /** Unlike onTurnQuiet this is NOT advisory: the silence outlasted the threshold and
   *  main has already interrupted the turn. `produced` reports whether a partial reply
   *  survived — it is what decides auto-resend vs. asking the user. */
  onTurnWedged: (callback: (data: { sessionId: string; produced: boolean }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:turn-wedged', handler);
    return () => ipcRenderer.removeListener('acp:turn-wedged', handler);
  },
  onDisconnected: (callback: (data?: { sessionId?: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:disconnected', handler);
    return () => ipcRenderer.removeListener('acp:disconnected', handler);
  },
  // Seam hook A (design §11): a session's executor attached and is ready for its
  // first prompt. Carries { sessionId, projectId } for the memory layer + UI.
  /**
   * 主进程自己把一条断了的远程会话接回来了（断线恢复按退避一直重试，见 index.ts `remoteRecovery`）——
   * 渲染层只在它自己 loadSession 成功时才把会话标成"连着"，所以要告诉它。
   */
  onReattached: (callback: (data: { sessionId: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:reattached', handler);
    return () => ipcRenderer.removeListener('acp:reattached', handler);
  },
  onSessionReady: (callback: (data: { sessionId: string; projectId?: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('session:ready-for-first-prompt', handler);
    return () => ipcRenderer.removeListener('session:ready-for-first-prompt', handler);
  },
});
