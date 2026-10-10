import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, clipboard, dialog, shell, safeStorage, Notification } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync, execFileSync, execFile, spawn, type ChildProcess } from 'child_process';
import { AcpClient, type EngineOptionCategory, resolveKiroCli, buildSshArgs, shellQuote, kiroTraceEnabled, setLocalKiroBin, setRemoteBinResolver, setMuxSocketResolver, kiroBinProblem, remoteKiroBin } from './acp-client';
import { setPasswordDecryptor, sshEnv } from './sshAuth.ts';
import { noticesFromStderr, noticeLabel } from './stderrNotice.ts';
import { ADAPTER_PACKAGE, ENGINE_LABEL, REMOTE_ADAPTER_BIN, engineOf } from './engines.ts';
import { claudeBedrockSettings, codexBedrockToml, claudeBedrockOf, codexBedrockOf, BEDROCK_DEFAULTS, applyCodexProvider, claudeEditorText, codexEditorText, codexGateway, mergeClaudeSettings, parseClaudeEditor, parseClaudeStatus, parseCodexEditor, parseCodexStatus, pickClaudeEnv } from './aiLogin.ts';
import { SshMux, muxKey, muxSupported, MUX_DIR } from './sshMux';
import {
  CATEGORIES as KIRO_CONFIG_CATEGORIES, categoriesFor as kiroCategoriesFor, categorySpec, LocalKiroConfig, pickEntries, validateContent,
  remoteListScript, remoteReadScript, parseRemoteRead, remoteWriteScript, relPath, parseRemoteList, pluginWriteError,
} from './kiroConfig';
import { rewriteImagePaths } from './imagePaths';
import { parseModelList, parseModelListJson, pickAvailableModel, pinAgentModel } from './modelAvailability.ts';
import { parseAgentList } from './kiroAgentList.ts';
import { Breaker, BREAKER_MS, PREFLIGHT_ATTEMPTS, backoffMs, worthRetrying } from './reachability.ts';
import { readMetaCache, writeMetaCache, mergeMeta, enrichModels } from './modelMeta.ts';
import {
  SyncConfig, Catalog, CatalogEntry, SESSION_FILES, MAX_FILE_BYTES, DEFAULT_INTERVAL_MINUTES,
  planUpload, keyFor, relFor, catalogKey, contentTypeFor, mergeCatalog, readState, writeState, walk,
  maskKeyId, machineTag, trashDirFor, detectConflicts, conflictKeyFor, backoffMultiplier,
  readSessionMarks, writeSessionMarks, sessionSyncState, sessionIdOfRel, mergeMemoryText, SESSION_FILES_DIR, projectMemoryMarkKey, walkSessionFiles, conflictPrefixFor,
  decideMemory, memoryRelsFor, placementOf, placementToFollow, applyPlacement,
} from './s3Sync.ts';
import { mergeTranscripts, mergeRecords } from './transcriptMerge.ts';
import { markArchivedLocally, unarchiveRestoredRecord } from './restoreArchive.ts';
import { S3Creds, S3Error, putObject, deleteObject, getObject, getObjectIfExists, listObjects } from './s3Client.ts';
import { AgentProfile, DEFAULT_MODEL, MODEL_FALLBACK_ORDER, deriveProjectId, canAssignProjectId, keepRecordPlacement, sessionCwd, resolveRemoteWorkdir, type ExecutorBins, type RemoteTarget } from './config';
import * as loopVerify from './loopVerify';
import * as eventLog from './eventLog';
import * as store from './sessionStore';
import { parseSkillDoc, describeSkill, kiroSkillTarget, backupsToPrune } from './skillDoc.ts';
import { isSubagentListUpdate, parseSubagentList, mergeSubagentList, activeSubagents, type SubagentRow } from './subagents.ts';
import * as loopStore from './loopStore.ts';
import { createSchedule as newSchedule, describeSchedule, isDue, nextRunAt, recordRun, scheduleTerminal, scheduleTerminalLabel, validateSchedule, type ScheduleSpec } from './schedule.ts';
import * as scheduleStore from './scheduleStore.ts';
import * as projectStore from './projectStore.ts';
import { backupMemoryLayer, buildMemoryInjection, deleteProjectMemory, deleteSessionMemory, memoryLayerBytes, readMemory, writeMemory } from './memory';
import type { MemoryScope } from './memoryPolicy.ts';
import { shouldConsolidate, buildConsolidationPrompt, mergeSessionMemory, CONSOLIDATE_EVERY } from './sessionMemory.ts';
import { staleVerdict, staleRecoveryNote, isBareInternalError, POISONED_AFTER, RECREATE_COOLDOWN_MS } from './staleSession.ts';
import { isTransientTransportError as isTransientTransportErrorImpl } from './transientError.ts';
import { planRetry, retriesExhaustedNote, MAX_AUTO_RETRIES, maxRetriesFor } from './promptRetry.ts';
import { cliErrorContext, trimHugeCliLogs } from './kiroCliLog.ts';
import { writeFailureBundle } from './failureBundle.ts';
import { hostFor, loadTimeoutFor, type HostOps } from './hostOps.ts';
import { judgePreflight, preflightScript, MODEL_PROBE, parseModels, remoteExecutorCap, REMOTE_MB_PER_SESSION, REMOTE_LOW_MEM_MB, remoteHeadroom, isOlderVersion } from './remotePreflight.ts';
import { remoteContextBlock } from './remoteContext.ts';
import { LOCAL_MARKER, MAX_LOCAL_ACTIONS_PER_TURN, parseLocalActions } from './localAction.ts';
import { detectScript, detectWindows, whichAll, PROBE_TIMEOUT_SEC, testScript, parseDetect, parseTest, mergeHistory, type ToolId } from './binDetect.ts';
import { startLocalMcp, type LocalMcpServer } from './localMcp.ts';
import { createControlServer, type ControlServer } from './controlServer.ts';
import { collectBusySessions, queueCounts, type BusySession } from './busySessions.ts';
import { windowIsActive } from './idleNotice.ts';
import { moveDirToTrash, scheduleBackgroundRetries, waitAtMost } from './sessionPurge.ts';
import { forwardableFrom, localAgentJson } from './forwardMcp.ts';
import {
  allocateRemotePort, localToolsHelp, mcpUrl, parseAgentBase,
  remoteAgentScript, removeAgentScript, sessionAgentName, SESSION_AGENT_PREFIX,
  sweepAgentsScript, STALE_AGENT_MINUTES, orphanSweepScript, parseOrphanSweep,
  staleExecutorSweepScript, parseStaleSweep,
  ownerTag, ownedAgentPrefix,
} from './remoteLocalTools.ts';
import { parseWhoami, loginEnv } from './kiroLogin.ts';
import { expandHome, listRemoteTargets, findRemoteTarget, saveRemoteTarget, deleteRemoteTarget, validateTarget, labelForHost, localBins, saveLocalBins, localWorkdir, localWorkdirSetting, saveLocalWorkdir, binHistory, rememberBinSuccess, type RemoteTargetInput } from './remoteTargets.ts';
import { isKirolexNote, modelFacing, stripKirolexNotes, KIROLEX_NOTE_OPENINGS } from './kirolexNote.ts';
import { parseRevised, settlePatchRevision, reviseInSessionPrompt, replyUsable, reviseSlideTextPrompt, parseSlideEdits } from './reviseBlock.ts';
import { applyRevision, type ReviewApply } from './reviewApply.ts';
import {
  SOFFICE_BUNDLE_PATHS, SOFFICE_PATH_NAMES, pickConverter, sofficeBinary, pathProbeCommand, firstProbeHit,
  installConverterCmd, noConverterWhy, pythonCandidates, PPTX_PROBE_SCRIPT, pythonEnv, noPythonPptxWhy,
  previewKey, needsConversion, isPreviewable, canEditDeck, NOTES_SCRIPT, WRITE_NOTE_SCRIPT, SLIDE_TEXT_SCRIPT,
  SLIDE_OPS_SCRIPT, WRITE_SLIDE_TEXT_SCRIPT, parseSlideRuns, parseWriteNote, parseNotesResult,
} from './deckPreview.ts';
import { ConvertOnce, LO_PROFILE_DIR, userInstallationArg } from './convertOnce.ts';
import { logger } from './logger';
import { zoomKeyAction } from './zoomKeys.ts';
import { primeVerdict, primeGiveUpNote } from './primeRetry.ts';

// Silence Electron's dev-only "Insecure Content-Security-Policy" console warning.
// It fires because the Vite dev server is served without a CSP (a strict CSP would
// break HMR's inline/eval), and only ever shows in an unpackaged/dev renderer with
// DevTools open -- it is never emitted in the packaged production app. Suppressing
// it keeps the auto-opened DevTools console clean on every startup.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// Windows 只给登记过 AppUserModelId 的程序弹通知；必须和打包配置（package.json 的 build.appId）一致，
// 否则「钉住的会话做完了」那条通知不显示，点了也回不到这个窗口。
if (process.platform === 'win32') app.setAppUserModelId('com.kirolex.app');

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
// True only once the renderer has completed its gated reveal (hydration + eager
// attach) via acp:reveal -> showMainWindow(). Until then, OS-driven show paths
// (macOS `activate` on launch/dock-click, `second-instance`, tray) must NOT
// reveal the still-loading window — otherwise the main UI flashes before load.
let mainWindowRevealed = false;
let tray: Tray | null = null;
let isQuitting = false;
/** 控制入口的「等待退出」：为真时不再开始新的一轮（定时 / 循环任务的 ticker、渲染端的排队排空都停下） */
let quitPending = false;
/** 正在跑一轮的定时 / 循环任务：schedule id → sessionId。控制入口据此判断"忙"。 */
const schedulesInFlight = new Map<string, string>();

process.on('uncaughtException', (error) => {
  logger.error('process', 'uncaughtException', error);
});
process.on('unhandledRejection', (reason) => {
  logger.error('process', 'unhandledRejection', reason);
});
logger.info('app', 'main process starting');
/** Startup clock. The window is revealed only AFTER hydrate + eager-attach, and the
 *  stretch between "main process starting" and the first attach -- measured at 17-26s
 *  all day, in dev AND production -- had NO logging at all, so "startup is slow" could
 *  not be attributed to anything. These marks make each phase attributable. */
const STARTUP_T0 = Date.now();
function startupMark(phase: string, extra?: string): void {
  logger.info('startup', `+${((Date.now() - STARTUP_T0) / 1000).toFixed(2)}s ${phase}${extra ? ' ' + extra : ''}`);
}

// PER-SESSION executors (design §3): exactly one AcpClient process per session,
// keyed by sessionId. Replaces the previous per-model pooling. This gives
// isolation by construction, per-session targets, and clean independent
// migrate/reconnect (later PRs).
interface SessionEntry {
  client: AcpClient;
  /** kiro-cli's session id for this executor. The Map key is the KiroLex id;
   *  client calls (sendPrompt/cancel/load) use THIS. */
  cliSessionId: string;
  profile: AgentProfile;
  /** Working directory used when creating/loading replacement executors. */
  cwd: string;
  /**
   * **本地那个目录** —— 远程会话里 `cwd` 是远端镜像的路径，而镜像、冲突判定、同项目并发都要
   * 按本地目录算（`docs/DESIGN_remote_sessions.md`：本地是唯一真相）。本地会话里它和 `cwd` 相同，
   * 所以不设也不会错 —— 但设上之后就不用在每个用点再判一次"这是远程吗"。
   */
  localDir?: string;
  /** accumulates the in-flight assistant response; flushed to the durable
   *  store only when the turn completes (asymmetric durability, §7). */
  assistantBuf: string;
  assistantMsgId: string | null;
  /** File-changing tool calls accumulated for the in-flight assistant turn. */
  fileChanges: store.StoredToolCall[];
  /** Tool calls the backend has OPENED and not yet closed, by toolCallId.
   *
   *  Second guard for wedge detection, and the only one left that is PROTOCOL TRUTH
   *  rather than a heuristic: an open tool call is the backend stating outright that the
   *  turn is busy, so it suppresses the interrupt (bounded by TOOL_STALL_MS).
   *
   *  Tracked separately from `fileChanges`, which only records calls that touched
   *  files or ran something and would therefore miss the rest.
   *
   *  Maps toolCallId -> the time its last update arrived, so the suppression is
   *  BOUNDED. Suppressing on mere openness was unbounded and turned one failure mode
   *  into another: a `search` call that never got its closing update left a turn
   *  hanging for over five hours with detection permanently off — the exact
   *  never-ending hang this feature exists to end. Past TOOL_STALL_MS with no update,
   *  an unclosed call is breakage rather than progress.
   *
   *  Refreshed on EVERY update, so a long command that reports intermediate progress
   *  keeps its session protected for as long as it keeps reporting. */
  openToolCalls?: Map<string, { startedAt: number; lastUpdate: number }>;
  /**
   * **这一轮后端开过几个工具调用** —— 自动重试的安全闸（见 `promptRetry`）。
   *
   * `fileChanges` 不能用来回答这个问题：它只记"动过文件/跑过命令"的那些，一轮里纯读取和
   * 查询类的调用不进去；`openToolCalls` 也不行，它只留还没关闭的。而"这一轮跑过工具吗"
   * 恰恰是决定能不能闭眼重发的那个事实 —— 实测挂掉的那一轮里有 `aws ssm send-command`，
   * 重发一次就是再执行一遍。所以单独数，每轮开始清零，`tool_call`（不含 update）时 +1。
   */
  toolsThisTurn?: number;
  /**
   * **这一轮有没有工具可能写过文件**（只远程会话用）。
   *
   * 纯生成的任务（写文案、答问题）远端一个文件都没动，而一次拉是两趟 SSH 往返、实测 5–7 秒 ——
   * 没必要挂在每一轮的尾巴上。判据用的就是防抖拉那个（判宽不判窄：疑似写过就拉）。
   */
  /**
   * **远程会话的「在你机器上做一件事」通道**（见 `localAction.ts`）。
   *
   * `localLineBuf`：流式文本要**按整行**解析 —— 半行会把 URL 截成两半，而截半的地址可能仍然
   * 合法（`https://x.com/a` 之于 `https://x.com/admin/delete`），那就成了"开了一个它没说的地址"。
   * `localActionsThisTurn` / `openedLocally`：一轮最多两个、同一个地址一条会话只开一次 ——
   * 防的是它**热心**（每验证一次弹一个标签页），不是恶意。
   */
  localLineBuf?: string;
  localActionsThisTurn?: number;
  openedLocally?: Set<string>;
  /**
   * **这一轮最大的一次工具输出有多少字符**（未裁剪的原始长度）——「好像 curl 那个大 json 的时候断掉了」。
   *
   * kiro-cli 把工具输出放在 `tool_call_update` 的 content 里，KiroLex 自己存盘时会裁
   * （`clampToolOutput`），但**发给模型的那一份是 kiro-cli 自己攥着的、没裁**。所以一轮里
   * 冒出一个几百 KB 的 JSON 时，后端最后答的是 `EmptyResponse` / `Internal error` ——
   * 而界面上只有一句"生成不出回答"，看不出是被哪一步撑死的。
   *
   * 记原始长度就是为了把这句话说出来。只在这一轮失败时才用它。
   */
  maxToolOutputThisTurn?: number;
  /** kiro's native subagents for THIS chat, as last reported by `_kiro.dev/subagent/list_update`.
   *  Kept so the left rail can carry a tag for as long as one is still running. */
  subagents?: SubagentRow[];
  /**
   * 这条会话能用的斜杠命令（`/clear`、`/agent`、`/model`…），后端在 `_kiro.dev/commands/available`
   * 里推过来的**原样**那一份。
   *
   * 为什么要在主进程留一份：那条通知**一条会话只推一次**（连上之后），而渲染进程原来只把它放在
   * `commandsMapRef`（内存里的 Map）。窗口一重载（开发时一次 HMR 也算）那份 Map 就空了，
   * 而后端不会再推 —— 于是输入 `/` 什么都不弹，直到你新建会话或者重连。
   * 主进程活得比渲染进程久，所以这份留在这儿；渲染进程发现自己空了就来取（`acp:session-commands`）。
   *
   * 存原始形状而不是解析后的：解析只在渲染进程那一处（`src/renderer/slashCommands.ts`），两条路进来的东西
   * 走同一段解析，语义才一定一致。
   */
  commands?: any[];
  /* No memory-injection bookkeeping here on purpose: the block goes out on EVERY
     turn, so there is no "has it been sent yet / has it changed" decision to carry.
     Three fields used to exist for that decision and were the reason a standing rule
     was stated once and never repeated. The durable record of what was sent lives in
     record.json (`lastMemoryInjection`) and in the [memory] log line. */
  /** Set when a session is (re)attached onto a FRESH kiro-cli backend (resume
   *  failed, migrated session, or expired cli session). On the FIRST prompt,
   *  KiroLex rebuilds the full prior context from its OWN durable transcript and
   *  injects it, so the chat remembers its context regardless of whether kiro-cli
   *  still has its native session. Cleared after the first injection. */
  needsHistoryPrime?: boolean;
  /** True while a background history-priming turn is in flight. Its streamed
   *  output is fully suppressed (not shown, not persisted) — see wireSession. */
  priming?: boolean;
  /** LRU bookkeeping: last time this executor was created/attached/prompted.
   *  Used to pick an eviction victim when the attached-executor cap is hit. */
  lastUsedAt: number;
  /** true only while an interrupt-and-merge cancellation is settling. Chunks
   *  emitted after cancellation (for example the standard interruption notice)
   *  are control output and must not enter chat history. */
  suppressCancellationChunks?: boolean;
  /** true while a prompt turn is in flight — a busy executor is never evicted. */
  busy?: boolean;
  /** monotonic turn tag: only the invocation that set `busy` may clear it. */
  turnSeq?: number;
  /** ms timestamp of the last inbound stream activity (stall watchdog). */
  lastStreamAt?: number;
  /** Set ONLY when KiroLex's own timeout interrupted the turn. flushAssistant
   *  appends it to that turn's message, so the reason lands in the conversation
   *  permanently instead of living in a floating banner that outlives the turn
   *  it describes. Never set for a user-pressed Stop. */
  wedgeNote?: string;
  /** ms timestamp of the moment KiroLex's own timeout decided to interrupt this
   *  turn. The auto-continue that follows may arrive before the cancel has
   *  released `busy`; sendPromptOnce waits it out instead of rejecting. */
  wedgedAt?: number;
  /** In-flight history rebuild, so a user prompt WAITS for it instead of being
   *  sent into an empty backend. Shared by the eager (post-attach) path and the
   *  lazy (pre-prompt) path so the rebuild happens exactly once. */
  primePromise?: Promise<{ ok: boolean; error?: string }>;
  /** Rebuild attempts so far. Informational only. A run gives up on a chunk per
   *  `primeVerdict` (primeRetry.ts), but the history is never truncated: a
   *  partial history is indistinguishable from a complete one to the model. */
  primeAttempts?: number;
  /** Chunks already ACCEPTED by this backend. A retry resumes from here rather
   *  than re-sending accepted chunks, which would duplicate the history and push
   *  the conversation further past the limit it just failed at. Reset to 0 when
   *  the executor is replaced -- a new kiro-cli process starts empty. */
  primeCursor?: number;
  /** Chunk snapshot for the current rebuild so retries replay identical content
   *  (and the cursor keeps meaning the same thing). */
  primeChunks?: string[];
  /** Last rebuild error. After a give-up this holds the `primeGiveUpNote`. */
  primeLastError?: string;
  /** The last run GAVE UP (`primeVerdict` → 'give-up'). `needsHistoryPrime` stays
   *  set -- that was not a success -- but the session is released and nothing
   *  re-schedules the rebuild automatically; the next real use (send / open /
   *  manual rebuild) tries again and clears this. Without it the owed flag would
   *  re-queue the run within a second: the same endless loop by another door. */
  primeGaveUp?: boolean;
  /** Human-readable rebuild progress ("重建历史上下文 2/5"), surfaced to the
   *  renderer with the busy event so a long rebuild is visible, not a freeze. */
  primeDetail?: string;
  /** User explicitly gave up on the rebuild (Stop). The session is RELEASED so it
   *  can be used again, accepting that the backend lacks history. A lock the user
   *  cannot escape is a worse failure than a context-less answer they chose. */
  primeAbandoned?: boolean;
  /** A ride-along context snapshot was marked as established but the request
   *  carrying it has NOT been accepted yet.
   *
   *  The marker is written before the send (so a crash mid-turn does not re-inject
   *  a history the backend already has), which means EVERY failure path afterwards
   *  has to take it back -- otherwise the next message sees "context established"
   *  for a snapshot that never reached the backend and gets answered from nothing,
   *  which is the exact failure this whole mechanism exists to prevent. Only the
   *  streaming catch used to undo it, leaving the busy rejection (thrown before
   *  that try block) able to strand the marker. */
  rideAlongUnconfirmed?: boolean;
  /** Message id of the user message of the turn currently in flight.
   *
   *  Mid-turn steers are not sent through acp:prompt, so they have no message of
   *  their own on disk; this is the id they merge into once the backend reports
   *  them CONSUMED (see acp:persist-steer). */
  currentUserMessageId?: string;
}
const sessionClients: Map<string, SessionEntry> = new Map();
// Serializes model/Agent replacement per session. Renderer locks are UX only;
// this guard is authoritative against racing IPC calls and background queues.
const reconfiguringSessions = new Set<string>();
/** requestId -> when the permission prompt was raised, so the answer can record how
 *  long the turn was blocked. Lives here (not on the entry) because a permission may
 *  be answered after a model swap replaced the executor. */
const permissionWaitStartedAt = new Map<string, number>();
/** Sessions with an attach (acp:load-session) in flight. kiro-cli owns a session
 *  from ONE process only, so an attach and a model/Agent switch racing on the
 *  same session both try to session/load it and the loser gets a bare
 *  -32603 "Internal error". These two sets make the operations mutually
 *  exclusive instead of letting them collide. */
const attachingSessions = new Set<string>();
/** In-flight attach promise per session, so concurrent acp:load-session calls for
 *  the SAME session share one executor instead of racing kiro-cli's
 *  single-process session ownership. */
const attachInFlight = new Map<string, Promise<any>>();
/** Wait (bounded) for an in-flight attach on this session to finish. */
async function awaitAttachIdle(sessionId: string, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (attachingSessions.has(sessionId) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (attachingSessions.has(sessionId)) {
    throw new Error('会话正在重新连接，请稍候再切换模型/Agent。');
  }
}
/** Wait (bounded) for a model/Agent/permission switch on this session to finish.
 *
 *  The MIRROR of `awaitAttachIdle`, and it was missing: a switch waited politely
 *  for an attach, but an attach REJECTED outright while a switch was running
 *  ("会话正在切换模型/Agent，稍后会自动重连。"). That asymmetry is what surfaced as a
 *  raw `Error invoking remote method 'acp:load-session'` — and because a send
 *  attaches on demand, the rejection reached the user's message rather than any
 *  background task.
 *
 *  Waiting is not just cosmetic: a switch ENDS with the session attached again
 *  (`sessionClients` holds the new executor), so by the time this resolves the
 *  attach usually has nothing left to do and returns immediately. Rejecting threw
 *  away a request that was about to become trivially satisfiable.
 *
 *  Bounded, and the timeout still throws: a switch that never finishes must not
 *  turn every later attach into an unbounded hang. 30s covers a cold kiro-cli
 *  start plus a `session/load`, both of which a switch performs. */
async function awaitReconfigureIdle(sessionId: string, timeoutMs = 30000): Promise<void> {
  if (!reconfiguringSessions.has(sessionId)) return;
  const deadline = Date.now() + timeoutMs;
  logger.info('session', `attach waiting for model/Agent switch sessionId=${sessionId}`);
  while (reconfiguringSessions.has(sessionId) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (reconfiguringSessions.has(sessionId)) {
    throw new Error('会话切换模型/Agent 超过 30 秒仍未完成，暂时无法连接。');
  }
  logger.info('session', `attach resuming after model/Agent switch sessionId=${sessionId}`);
}
/** Start an executor for `profile`, falling back through MODEL_FALLBACK_ORDER
 *  when the requested model cannot start (unavailable / retired / throttled).
 *  Returns the live client plus the model that actually worked, so the caller can
 *  persist the effective model instead of a dead one. */
/**
 * 这个后端**证实过跑不了**的模型 —— 每次运行重新发现一次。
 *
 * ## 为什么必须记
 *
 * 关键在下面那段注释说的事实：kiro-cli **只在真跑一轮时**才报模型退役，`connect()` 一定成功。
 * 于是 `preferredModel` 排在候选第一位时，每条会话都会：连上死模型 → 第一轮报错 →
 * `swapSessionModel` 杀掉执行器、换模型、重载会话、重发 —— 实测这个窗口 **30 秒**，而且
 * 期间界面上一点动静都没有（那正是「第二个分屏的会话卡住了」看到的东西）。
 *
 * 不记的话每条会话各付一次。实测一次运行里就发生了两遍（两条不同会话，间隔 65 秒），
 * 而 `claude-opus-5` 压根不在这个 kiro-cli 的清单里（它只有 gpt-5.6-* / deepseek / minimax /
 * glm / qwen）。
 *
 * ## 为什么是**进程级**而不是落盘
 *
 * 模型清单会变（升级 kiro-cli、后端上线新模型）。落盘会把一次探测的结论永久钉住，
 * 而重启一次重新探测的代价只是一次 30 秒 —— 那个代价换来的是「装了新版本就自动恢复」。
 */
/** 这条会话跑在哪台机器上 —— 模型可用性、启动命令、agent 都是按这个分的。 */
/**
 * **`file://` URL → 本机路径** ——「看一下有没有 windows 上不能跑的东西」。
 *
 * 原来四处各写一遍 `replace(/^file:\/\//, '')`。在 macOS 上那是对的
 * （`file:///Users/k/a.txt` → `/Users/k/a.txt`），在 Windows 上是错的：
 * `file:///C:/Users/k/a.txt` 剥完剩 `/C:/Users/k/a.txt` —— `path.isAbsolute` 接受它,
 * 而 `fs.statSync` 拒绝。表现是"从聊天里点一个文件打不开"，而错误信息里那条路径
 * 看起来完全正常（只是前面多一个斜杠）。
 *
 * 顺手也解 percent-encoding：`file://` URL 里空格是 `%20`，而那是真会出现的
 * （macOS 上带空格的文件名很常见）。解不开就用原样 —— 一个畸形的 URL 不该让整个操作抛。
 *
 * 不是 `file://` 的原样返回（去掉首尾空白）：调用方传进来的通常就是一个裸路径。
 */
export function stripFileUrl(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!/^file:\/\//i.test(raw)) return raw;
  let p = raw.replace(/^file:\/\/[^/]*/i, '');     // 顺带吃掉 `localhost` 这种 authority
  try { p = decodeURIComponent(p); } catch { /* 畸形的编码：用原样 */ }
  /* Windows：`/C:/Users/…` → `C:/Users/…`（盘符前那个斜杠是 URL 的，不是路径的） */
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

function machineKeyOf(profile: { remote?: { sshHost?: string } }): string {
  return profile.remote?.sshHost || 'local';
}

/*
  **按机器分** —— 一个模型在这台机器上跑不了，不代表在别的机器上跑不了。实测就是这样：
  这台 Mac 的出口 IP 被地域过滤，Claude 全系不可用；而同一个账号在东京那台 EC2 上全都好。
  共用一个 Set 的话，一条本地会话把 `claude-opus-5` 标成死的，所有远程会话都会把它排到最后
  —— 于是远程会话也用不上 Claude，而那恰恰是远程会话存在的理由。
*/
const modelsKnownDeadBy = new Map<string, Set<string>>();
function deadModelsFor(machine: string): Set<string> {
  let set = modelsKnownDeadBy.get(machine);
  if (!set) { set = new Set<string>(); modelsKnownDeadBy.set(machine, set); }
  return set;
}

/**
 * **本机 kiro-cli 自己报的模型清单** —— 一次运行只问一次。
 *
 * 为什么值得问：上面那段说的"每条会话先付一轮 30 秒失败"完全可以免掉 —— `chat --list-models`
 * 不花额度、不调模型，两三秒就回来，而它正好回答那一轮失败要发现的事。实测这一版
 * （2.23.1）清单里**一个 Claude 都没有**，而 `DEFAULT_MODEL` 是 `claude-opus-5`，
 * 也就是每条新会话都在付那一轮。
 *
 * 失败时返回空数组，而**不缓存空**：探测本身可能是暂时坏的（超时、二进制还没配），
 * 把"没探到"钉成"什么模型都没有"会让所有判断失去依据。空数组的含义是"这次没依据"，
 * 下游一律按不做处理。
 */
let localModelIdsCache: string[] | null = null;
let localModelIdsInFlight: Promise<string[]> | null = null;
async function localModelIds(): Promise<string[]> {
  if (localModelIdsCache) return localModelIdsCache;
  if (!localModelIdsInFlight) {
    localModelIdsInFlight = runKiroCli('chat --list-models --format json', 30000)
      .then((out) => {
        const ids = parseModelList(out);
        if (ids.length) localModelIdsCache = ids;
        return ids;
      })
      .catch((err: any) => {
        logger.warn('model', `问不到本机模型清单：${err?.message || err}（这次不做可用性判断）`);
        return [];
      })
      .finally(() => { localModelIdsInFlight = null; });
  }
  return localModelIdsInFlight;
}

async function connectWithModelFallback(
  profile: AgentProfile,
  label: string,
  /** 远程会话的本地工具通道（`ensureLocalTools` 的结果）。本地会话是 undefined。 */
  localTools?: { remotePort: number; localPort: number; agentOverride: string },
  /** 有它才能在会话里说一句"你选的模型这台机器上没有"。没有就只进日志。 */
  sessionId?: string,
): Promise<{ client: AcpClient; model: string }> {
  /*
    **Claude Code / Codex 不走这套降级** —— 下面的模型清单、"哪个模型在这台机器上挣来的"、
    降级顺序、记住成功的 kiro 启动命令，全都是 kiro 的东西。另外两家用它们自己 CLI 配的默认模型，
    起一次就行；起不来就把原因（多半是"没装适配器"）原样交出去。
  */
  const engine = engineOf(profile);
  if (engine !== 'kiro') {
    const client = new AcpClient(profile.model, shellEnv, undefined, profile.permissionMode, profile.remote, localTools, engine);
    await client.connect();
    logger.info('engine', `${label}: ${ENGINE_LABEL[engine]} 适配器起来了（${client.launchedWith || '?'}）`);
    return { client, model: profile.model };
  }
  const machine = machineKeyOf(profile);
  const modelsKnownDead = deadModelsFor(machine);
  /*
    **别采信在另一台机器上挣来的模型** —— `modelEarnedOn` 那段注释里那个实测：
    一条在本机被降级成 deepseek 的会话，切到远端之后还在跑 deepseek。
  */
  /*
    **没有这个字段的老记录也不采信** —— 这次的 26 条就全是这种（它们在本机被降级成
    deepseek / gpt-5.6-sol，字段是这一版才加的）。按"就当是这台挣的"处理等于让这个 bug
    在既有会话上继续活着，而它的表现正是用户看到的那个。

    代价很小：不采信只是让候选回到 `preferredModel`（attach 时没有就用默认），
    而"本机没有 Claude"现在是先问清单**立刻**知道的事，不再是等一轮失败的 30 秒。
  */
  const earnedHere = !!profile.modelEarnedOn && profile.modelEarnedOn === machine;
  const earned = earnedHere ? profile.model : undefined;
  if (!earnedHere && profile.model) {
    logger.info('model', `${label}: 记录里的 '${profile.model}' 不是在 ${machine} 上挣来的`
      + `（记着 ${profile.modelEarnedOn || '没记'}）—— 不采信它，回到偏好模型`);
  }
  const all: string[] = [profile.preferredModel, earned, ...MODEL_FALLBACK_ORDER]
    .filter((m): m is string => !!m)
    .filter((m, i, arr) => arr.indexOf(m) === i);
  /*
    已知跑不了的排到**最后**而不是删掉：万一它们是唯一剩下的（清单探测错了、或者别的模型
    也都挂了），还得能试。删掉的话一次误判会让整个会话连不上，那比多等 30 秒糟得多。
  */
  /*
    **先问清单，别用一轮失败去发现** —— 本机那条路上这一步能省掉整整 30 秒。

    kiro-cli 只在真跑一轮时才报模型退役（`connect()` 一定成功），所以上面那套
    "失败 → 换模型 → 重载 → 重发"是必要的兜底；但它不必是**发现**手段。
    `chat --list-models` 不花额度、几秒就回，实测这一版清单里一个 Claude 都没有，
    而默认模型就是 `claude-opus-5`。

    远程会话不走这儿：那台机器的清单由 `pickRemoteModel` 按 preflight 的结果判断。
    清单问不到（空数组）时什么都不做 —— 没依据的判断比不判断糟。
  */
  if (!profile.remote?.sshHost) {
    const available = await localModelIds();
    if (available.length) {
      for (const m of all) {
        if (!available.includes(m) && !modelsKnownDead.has(m)) {
          modelsKnownDead.add(m);
          logger.info('model', `${label}: 本机 kiro-cli 的清单里没有 ${m}（清单：${available.join(', ')}）—— 不必等它跑一轮才知道`);
        }
      }
      /*
        **换了模型就得说一句** —— 远程那条路（`pickRemoteModel`）本来就在说，本地这条以前不说：
        界面上写着 claude-opus-5，实际跑的是 gpt-5.6-sol，而唯一的痕迹在日志里。

        顺便把原因说出来，因为它是**查了一整轮才定下来的**、而且在这台机器上是长期状态：
        出口 IP 落在 Anthropic 不支持的地区时，Kiro 会把 Claude **连同 `auto`** 一起从清单里过滤掉
        （实测这台 Mac 出口是 CN / AS4837，19 个模型只剩 8 个，缺的正好是 10 个 Claude + `auto`；
        同一个账号在东京那台 EC2 上 19 个全在）。和 kiro-cli 版本无关 —— 有人直接探过
        `ListAvailableModels`，伪装 appVersion 2.12.0→2.23.0 每次都是 19 个。

        判据就用那个签名：清单里**一个 Claude 都没有、也没有 `auto`**。不满足时只说"没有这个模型"，
        不乱归因 —— 归错因比不归因贵，人会照着错方向查。
      */
      const wanted = profile.preferredModel || profile.model;
      if (sessionId && wanted && !available.includes(wanted)) {
        const geoFiltered = !available.some((m) => m.startsWith('claude-')) && !available.includes('auto');
        sessionNotice(sessionId, `⚠️ 本机 kiro-cli 的模型清单里没有「${wanted}」，这条会话会用清单里有的一个。`
          + `（本机可用：${available.slice(0, 8).join('、')}${available.length > 8 ? '…' : ''}）`
          + (geoFiltered
            ? `\n清单里 Claude 系列和 \`auto\` 整体消失，通常是**出口 IP 的地域过滤**（Anthropic 的模型分地区）——`
              + `换 kiro-cli 版本没用。要用 Claude 就把这条会话切到远端机器上。`
            : ''));
      }
    }
  }
  const dead = all.filter((m) => modelsKnownDead.has(m));
  const candidates = dead.length ? [...all.filter((m) => !modelsKnownDead.has(m)), ...dead] : all;
  if (dead.length) {
    logger.info('model', `${label}: 跳过本次运行里已证实跑不了的模型（${dead.join(', ')}）—— 它们排到最后`);
  }
  let lastError: any = null;
  /*
    连上了就把那条命令记进历史 —— 「记住历史成功的启动命令或位置」。
    放在**连接成功**之后而不是"配置保存"时：配置里那条可能是错的，而这里是事实。
    `rememberBinSuccess` 自己会在没变化时跳过写盘。
  */
  const remember = (client: AcpClient): void => {
    const machine = profile.remote?.sshHost
      ? (listRemoteTargets(KIROLEX_CONFIG_PATH).find((t) => t.sshHost === profile.remote?.sshHost)?.id || profile.remote.sshHost)
      : 'local';
    if (client.launchedWith) {
      try { rememberBinSuccess(KIROLEX_CONFIG_PATH, machine, 'kiro' as ToolId, client.launchedWith); } catch { /* 记不住不该影响连接 */ }
    }
  };
  for (const model of candidates) {
    const client = new AcpClient(model, shellEnv, profile.kiroAgent, profile.permissionMode, profile.remote, localTools, engineOf(profile));
    try {
      await client.connect();
      if (model !== profile.model) {
        // NB: `model` is simply the first candidate that started — with a
        // preferredModel it may WIN AHEAD of profile.model, which was then never
        // attempted. Don't claim profile.model was unavailable.
        logger.warn('model', `${label}: started on '${model}' (record model '${profile.model}', preferred '${profile.preferredModel || '-'}')`);
      }
      remember(client);
      return { client, model };
    } catch (err: any) {
      lastError = err;
      logger.warn('model', `${label}: model '${model}' failed to start: ${err?.message || err}`);
      try { await client.disconnect(); } catch {}
    }
  }
  throw lastError || new Error('No usable model: every candidate failed to start.');
}

/** kiro-cli reports a retired/unavailable model only when the turn actually runs:
 *  the executor starts fine, then the response stream errors with
 *  "The model 'X' is not available. Please use '/model' ...". So model health
 *  CANNOT be established at connect time alone -- this matcher is what lets the
 *  prompt path fall back instead of dead-ending on every send. */
/* 传输层瞬时错误的判据在 `transientError.ts`（纯的、要给 `promptRetry` 复用）。 */
export const isTransientTransportError = isTransientTransportErrorImpl;

function isModelUnavailableError(text: string): boolean {
  return /model\s+'[^']+'\s+is not available/i.test(text) || /use\s+'\/model'\s+to select a different model/i.test(text);
}

/** Tell the renderer which model a session is REALLY running. Without this the
 *  composer selector shows whatever was last requested/persisted locally while
 *  the executor runs something else entirely (observed: selector said
 *  'gpt-5.6-sol' while every prompt failed on 'claude-opus-5'). */
function emitSessionModel(sessionId: string, model: string) {
  mainWindow?.webContents.send('acp:session-model', { sessionId, model });
}

/** Replace a live session's executor with one running `model`, keeping the same
 *  kiro-cli session id (so history/context is preserved), then persist + announce
 *  the effective model. Returns false if no candidate could take over, in which
 *  case the caller must surface the original failure. */
/** 这个模型此刻还在那台机器（本机 / 远端）的 `--list-models` 清单里吗。问不到就当"不在"（维持原来的保守判断）。 */
async function modelStillListed(profile: AgentProfile, modelId: string): Promise<boolean> {
  try {
    const list = profile.remote?.sshHost ? await remotePreflight(profile.remote) : await localModelIds();
    return Array.isArray(list) && list.includes(modelId);
  } catch { return false; }
}

async function swapSessionModel(sessionId: string, failedModel: string, label: string, exclude?: Set<string>): Promise<string | null> {
  const entry = sessionClients.get(sessionId);
  if (!entry) return null;
  const candidates = MODEL_FALLBACK_ORDER.filter((m) => m && m !== failedModel && !exclude?.has(m));
  const cliSessionId = entry.cliSessionId;
  const cwd = entry.cwd;
  /*
    换执行器期间**必须报 busy**。

    这一段会杀掉执行器、连一个新的、重载会话、再重发 —— 实测 30 秒。而它一进来就
    `sessionClients.delete`，于是 `busyReason` 查不到 entry、返回 null：**一轮正在飞的对话
    在界面上显示为空闲**，没有活动指示、没有任何解释。那就是「第二个分屏的会话卡住了」
    看到的东西 —— 后端在干活（实测那一轮 47 个事件、4 分 24 秒后正常完成），界面一动不动。

    用已有的 `reconfiguringSessions`：`busyReason` 第一条就查它并返回 `'reconfiguring'`，
    界面本来就认得这个状态（用户手动换模型走的是同一条）。`finally` 里清，否则一次失败的
    换模型会把这条会话永久钉在「切换中」——`awaitReconfigureIdle` 会等 30 秒然后抛错。
  */
  reconfiguringSessions.add(sessionId);
  sessionClients.delete(sessionId);               // release single-process ownership
  try { await entry.client.disconnect(); } catch {}
  try {
  /*
    **先问那台机器：它的模型清单里还有没有这个模型** ——「为什么这两个会话的模型又变回 GPT 了」。
    实测（10-06 15:22）：到东京的 ssh 断了一下，两条会话一起重连、一起重发，重发那一轮 kiro-cli
    报了「model is not available」，于是两条都被换成 gpt-5.6-sol、偏好也清掉了 —— 可那台机器的
    `--list-models` 里 claude-opus-5.5 好好地在。那是一次抖动，不是退役。
    清单里还在 → 只是这一轮换掉（让对话接着走），**偏好留着、不记成死模型、不记"在这台机器上挣来的"**，
    下次连上就回到你选的那个；清单里真没有了 → 才按退役处理（下面那段原来的规则）。
  */
  const stillListed = await modelStillListed(entry.profile, failedModel);
  for (const model of candidates) {
    /*
      **偏好一并丢掉。**

      `MODEL_FALLBACK_ORDER` 上面那段写着「自动降级绝不覆盖 `preferredModel`，下次 attach 再试
      一遍真正被选中的那个」。那条规则对**连接失败**是对的（限流、一时抖动，下次也许就好了），
      但这里的失败不是那种：走到 `swapSessionModel` 的路径是 `isModelUnavailableError` ——
      kiro-cli 明说「这个模型不可用，请用 /model 换一个」。那是**确定性事实**，不是抖动。

      留着偏好的代价是实测过的：偏好在下次 attach 抢先连上（连接对死模型永远成功）→ 第一轮
      再报退役 → 再换一次 → 每次重启都付一遍那 30 秒的静默窗口。

      丢掉而不是改成 `model`：把一个自动选中的模型写成「你偏好的」正是上面那条规则要防的事。
      丢掉的意思是「你那个偏好在这个后端满足不了，先按记录里能跑的来」——想要回去，在 composer
      里重新选一次就会重新写上（手动切换同时更新 `model` 和 `preferredModel`）。
    */
    /* 记下是**哪台机器**挣的：换机器之后这条降级就不该再生效（见 `modelEarnedOn`） */
    const profile: AgentProfile = stillListed
      ? { ...entry.profile, model, modelEarnedOn: undefined }
      : { ...entry.profile, model, preferredModel: undefined, modelEarnedOn: machineKeyOf(entry.profile) };
    /* 换执行器 = 换 ssh = 换隧道：本地工具要重新备一次（token 和端口都跟着这次启动） */
    const localTools = await ensureLocalTools(sessionId, profile, localProjectDirOf(sessionId, entry));
    const client = new AcpClient(model, shellEnv, profile.kiroAgent, profile.permissionMode, profile.remote, localTools, engineOf(profile));
    try {
      await client.connect();
      await withLoadTimeout(client.loadSession(cliSessionId, cwd), loadTimeoutFor(profile.remote));
      const next: SessionEntry = {
        ...entry, client, profile, lastUsedAt: Date.now(),
        assistantBuf: '', assistantMsgId: null, fileChanges: [],
      };
      sessionClients.set(sessionId, next);
      wireSession(sessionId, next);
      const rec = store.readRecord(sessionId) || store.createSession(sessionId, profile);
      /* 项目归属以盘上为准：这一轮中途移出项目时 entry 里还是旧项目，整份写回就把移出撤销了 */
      rec.profile = keepRecordPlacement(profile, rec.profile);
      rec.cliSessionId = cliSessionId;
      rec.executorState = 'attached';
      store.writeRecord(rec);
      logger.warn('model', `${label}: '${failedModel}' unavailable at prompt time -> switched to '${model}'`
        + (stillListed
          ? `（但那台机器的模型清单里还有 '${failedModel}' —— 当作一时抖动：偏好留着，下次连上回到它）`
          : `${entry.profile.preferredModel === failedModel ? `（并清掉偏好 '${failedModel}' —— 清单里也没有它了，是真退役）` : ''}`));
      /*
        换成功了 = `failedModel` 在这个后端确实跑不了，记下来。不记的话下一条会话再付一次
        30 秒（实测一次运行里发生了两遍）。只在**换成功**时记：连接失败可能是限流或一时抖动，
        那种不该被当成「这个模型死了」。
      */
      /* 记到**这台机器**名下 —— 同一个模型在另一台机器上可能是好的（见 `modelsKnownDeadBy`） */
      if (!stillListed) deadModelsFor(machineKeyOf(entry.profile)).add(failedModel);
      emitSessionModel(sessionId, model);
      return model;
    } catch (err: any) {
      logger.warn('model', `${label}: fallback '${model}' failed to take over: ${err?.message || err}`);
      try { await client.disconnect(); } catch {}
    }
  }
  return null;
  } finally {
    reconfiguringSessions.delete(sessionId);
  }
}

/** Agent used for KiroLex's own background TEXT chores (chat titles, prompt
 *  suggestions). It has no tools, no MCP servers and no hooks, because the
 *  DEFAULT agent cold-loads 9 MCP servers on every one-shot spawn: measured 26.1s
 *  / 0.15 credits / ~190% CPU across 6 processes just to write three lines, and
 *  it repeated that per turn. With this agent the same call is 7.3s / 0.01
 *  credits and starts no MCP process at all. Lives in ~/.kiro/agents/. */
const LITE_AGENT = 'kirolex-lite';

/** Run a short text-only one-shot through the lite agent, trying the configured
 *  helper model first and the configured fallback second. Both live in Settings.
 *  If the lite agent itself is absent (it lives in the user's ~/.kiro, not in this
 *  repo) the call still goes through on the default agent — degraded, never broken.
 *
 *  Uses `resolveKiroCli()` rather than the bare name for the same reason as
 *  runKiroCli: on Windows, and on any install reachable only through KIRO_CLI_PATH,
 *  `kiro-cli` is not on PATH, and this call is what produces prompt suggestions and
 *  smart chat titles — both would have failed silently.
 *
 *  @param prompt The full one-shot prompt; passed as a single argv entry, so no
 *    shell is involved and no quoting is needed.
 *  @param label Log tag, e.g. 'suggestions' or 'title'.
 *  @returns The model's stdout, trimmed by the caller. Throws only if EVERY
 *    model/agent combination failed; the last error is rethrown. */
async function runLiteOneShot(prompt: string, label: string): Promise<string> {
  // Local requires: this predates the module-level imports and is left as-is because
  // execFile/promisify are needed nowhere else in this file's argv-array form.
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const run = promisify(execFile);
  const opts = { env: shellEnv, timeout: 60000, maxBuffer: 1024 * 1024 };
  const { model, fallback } = loadHelperModels();
  let models = [model, fallback].filter((m, i, arr) => !!m && arr.indexOf(m) === i);
  /*
    **先按本机真实清单筛一遍** —— 否则这个循环只是把同一个失败付两遍（每次最多 60 秒）。
    清单问不到就原样保留：没依据的时候照旧试，慢总比不做好。
  */
  const available = await localModelIds();
  if (available.length) {
    const usable = models.filter((m) => available.includes(m));
    if (!usable.length) {
      /* 两个都退役了：挑一个清单里真有的，并说清是谁替了谁 —— 悄悄换掉才是那个查了很久的病 */
      const picked = pickAvailableModel(models[0] || '', available, MODEL_FALLBACK_ORDER);
      logger.warn(label, `设置里的辅助模型（${models.join('、')}）在本机 kiro-cli 上都没有 -> 用 ${picked}`
        + `（清单：${available.join(', ')}）`);
      models = [picked];
    } else {
      models = usable;
    }
  }
  let lastError: any = null;
  for (const m of models) {
    for (const withAgent of [true, false]) {
      /*
        **`--model` 在 `chat --no-interactive` 上是空操作** —— 实测：它一律先打一行
        `[warn] failed to set model 'X': Method not found`，然后用别的模型跑（传不存在的
        名字也一样不报错）。真正说话的是 **agent JSON 里的 `model` 字段**。

        所以设置里那个"辅助模型"以前从来没生效过：`kirolex-lite.json` 当时钉着
        `claude-haiku-4.5`，而这一版 kiro-cli 的清单里一个 Claude 都没有 ——
        于是标题、建议、会话记忆压缩**全都**失败，而且怎么改设置都没用。

        `--model` 仍然传着：别的版本上它是管用的，而多传一个被忽略的参数不花任何代价。
      */
      if (withAgent) {
        const pinned = pinAgentModel(LITE_AGENT, m);
        if (pinned.changed) logger.info(label, `把 ${LITE_AGENT} 的模型钉成 ${m}（--model 在这一版上不生效）`);
        else if (pinned.reason) logger.warn(label, `钉不进 ${LITE_AGENT}：${pinned.reason}`);
      }
      const args = withAgent
        ? ['chat', '--no-interactive', '--agent', LITE_AGENT, '--model', m, prompt]
        : ['chat', '--no-interactive', '--model', m, prompt];
      try {
        /* 辅助模型（标题/建议）也走设置里那个二进制 —— 不许悄悄退回一个裸名字 */
        const helperProblem = kiroBinProblem();
        if (helperProblem) throw new Error(helperProblem);
        const { stdout } = await run(resolveKiroCli()!, args, opts);
        if (m !== models[0]) {
          logger.warn(label, `helper model '${models[0]}' unusable -> answered with fallback '${m}'`);
        }
        return String(stdout);
      } catch (err: any) {
        lastError = err;
        const text = `${err?.message || ''} ${err?.stderr || ''}`;
        // Missing lite agent is the ONLY reason to retry the same model without
        // --agent; anything else means try the next model instead.
        const agentMissing = /agent/i.test(text) && /(not found|unknown|does not exist|no such)/i.test(text);
        if (withAgent && agentMissing) {
          logger.warn(label, `lite agent '${LITE_AGENT}' unavailable, retrying on the default agent (slower, pricier)`);
          continue;
        }
        logger.warn(label, `model '${m}' failed: ${err?.killed ? 'timeout/killed' : (err?.message || err)}`);
        break; // next model
      }
    }
  }
  throw lastError || new Error('No helper model could answer.');
}

/**
 * 会话记忆的自动维护 —— 「你在 memory 里加一个 session memory」。
 *
 * 三层记忆(全局 ⊕ project ⊕ 这个会话)早就在了,每一轮都注入;缺的是**没人写这一层** —— 它是个手填的
 * 文本框,而没人会在聊天中途停下来写笔记。所以每一轮结束后判断一次:攒够 CONSOLIDATE_EVERY 条新消息,
 * 就用和生成标题同一条便宜的一次性调用(`runLiteOneShot`)把最近这段压成几行事实,合并进那个文件。
 *
 * 失败一律静默:它是背景工作,不该为一次压缩失败弹任何东西 —— 但必须记日志,否则「记忆怎么没更新」
 * 就成了不可查的问题。
 */
const memoryConsolidating = new Set<string>();

async function maybeConsolidateSessionMemory(sessionId: string): Promise<void> {
  if (!isFeatureEnabled('sessionMemory')) return;
  try {
    const messages = store.readTranscript(sessionId) || [];
    const record = store.readRecord(sessionId);
    if (!record) return;
    if (!shouldConsolidate({
      messages: messages.length,
      consolidatedAt: (record as any).memoryConsolidatedAt || 0,
      inFlight: memoryConsolidating.has(sessionId),
    })) return;
    memoryConsolidating.add(sessionId);
    const projectId = (record.profile as any)?.projectId || undefined;
    const existing = readMemory(projectId, sessionId).session || '';
    /* 只喂最近这一段:更早的已经被上一次压缩吸收进 existing 了,再喂一遍是重复付钱 */
    const recent = messages
      .slice(-CONSOLIDATE_EVERY * 2)
      /*
        **KiroLex 自己的通知不能进记忆** —— 这一条比别处都要紧：记忆是压缩完永久留着、
        而且每一轮都注入的。一句「⚠️ 这条会话现在跑在 gpt-5.6-sol 上」被压进去，
        之后每一轮模型都会读到它，一句临时通知就变成了长期上下文。判据见 `kirolexNote`。
      */
      .filter(modelFacing)
      .map((m: any) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${String(m.content || '').slice(0, 800)}`)
      .join('\n\n');
    if (!recent.trim()) return;
    const produced = cleanLiteOutput(await runLiteOneShot(buildConsolidationPrompt(recent, existing), 'session-memory'));
    const merged = mergeSessionMemory(existing, produced);
    if (merged && merged !== existing) {
      writeMemory('session', projectId, sessionId, merged);
      logger.info('memory', `session ${sessionId}: consolidated at ${messages.length} messages (${merged.length} chars)`);
    }
    store.writeRecord({ ...record, memoryConsolidatedAt: messages.length } as any);
  } catch (err: any) {
    logger.warn('memory', `session ${sessionId}: consolidation failed (${err?.message || err})`);
  } finally {
    memoryConsolidating.delete(sessionId);
  }
}


/** Cap on the tool OUTPUT kept per tool call in the transcript.
 *
 *  Output was never persisted at all (StoredToolCall.content existed but no writer
 *  ever filled it), so a restart lost every command's stdout and every read result.
 *  Storing it in full is not an option either: one measured chat holds 324 tool calls
 *  in a 636KB transcript, and unbounded output could multiply that several times over.
 *
 *  HEAD AND TAIL are both kept, not a prefix: the head says what ran, while a failure
 *  message is almost always at the END — a head-only clamp would reliably discard the
 *  one part worth reading. */
const TOOL_OUTPUT_HEAD = 600;
const TOOL_OUTPUT_TAIL = 500;
function clampToolOutput(text: string): string {
  const total = text.length;
  if (total <= TOOL_OUTPUT_HEAD + TOOL_OUTPUT_TAIL) return text;
  const dropped = total - TOOL_OUTPUT_HEAD - TOOL_OUTPUT_TAIL;
  const marker = `\n…[省略 ${dropped} 字符]…\n`;
  // Clamping must never make the payload BIGGER. Just past the threshold the marker
  // costs more than the handful of characters it removes.
  if (marker.length >= dropped) return text;
  return text.slice(0, TOOL_OUTPUT_HEAD) + marker + text.slice(-TOOL_OUTPUT_TAIL);
}

/**
 * **"这一轮里最大的一次工具输出"那句提示** ——「好像 curl 那个大 json 的时候断掉了」。
 *
 * 实测那条会话：一轮里 109 个工具调用、里面有整段 `aws ec2 describe-*` 的 JSON，最后后端回
 * `EmptyResponse`（模型自己在日志里读到的原话），而界面上只有一句"生成不出回答"。
 * 发给模型的那一份输出是 kiro-cli 攥着的、没裁过，所以这个数字是唯一能指向原因的东西。
 *
 * 阈值 20000 字符：低于这个量的输出不值得提，提了只会变成每条错误后面的一句废话。
 */
function bigOutputHint(maxChars?: number): string {
  const n = Number(maxChars) || 0;
  if (n < 20000) return '';
  return `（其中最大的一次输出 ${Math.round(n / 1000)}K 字符 —— 后端很可能是在这上面答不出来的，`
    + '下次给那条命令加上 `--query` / `| head` 把输出截小）';
}

/** Text an ACP tool call reported
 *  The renderer's live path reads only block [0]; joining every block means a
 *  reopened chat cannot show less than the live one did. */
function extractToolOutput(blocks: unknown): string {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block: any) => (typeof block?.content?.text === 'string' ? block.content.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Strip kiro-cli's DECORATION from a one-shot answer so the text can be used as
 *  data. It emits ANSI colour plus a '> ' prompt marker ahead of the reply — the
 *  captured bytes for a title request are literally
 *  `\x1b[38;5;141m> \x1b[0m检查项目 Windows 兼容性`.
 *
 *  Central on purpose. This knowledge previously lived only as a comment inside the
 *  suggestions handler, so the title handler stripped the colour but not the marker
 *  and every generated chat title arrived as "> Foo". One place, so a third caller
 *  cannot inherit the same bug. */
function cleanLiteOutput(stdout: string): string {
  return String(stdout)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/^\s*(?:>\s*)+/, '')
    .trim();
}

/** Why a session's backend is currently occupied (null = free). The renderer
 *  renders this so an occupied session is VISIBLE up front instead of only
 *  surfacing as a "still in progress" / "Internal error" banner afterwards. */
type BusyReason = 'turn' | 'reconfiguring' | 'attaching' | 'priming' | 'prime-pending' | null;
function busyReasonFor(sessionId: string): BusyReason {
  if (reconfiguringSessions.has(sessionId)) return 'reconfiguring';
  if (attachingSessions.has(sessionId)) return 'attaching';
  const entry = sessionClients.get(sessionId);
  if (entry?.priming) return 'priming';
  if (entry?.busy) return 'turn';
  // Context owed. This OCCUPIES the session on purpose: a chat whose backend has
  // no history must not accept a new message that would be answered from nothing.
  // New messages queue behind the rebuild instead.
  if (entry?.needsHistoryPrime) {
    // …unless the user abandoned it, or the last run gave up (primeVerdict): then
    // the session is released and the next send retries the rebuild itself.
    if (entry.primeAbandoned || entry.primeGaveUp) return null;
    return 'prime-pending';
  }
  return null;
}
function emitSessionBusy(sessionId: string) {
  const reason = busyReasonFor(sessionId);
  const detail = reason === 'priming' ? sessionClients.get(sessionId)?.primeDetail : undefined;
  mainWindow?.webContents.send('acp:session-busy', { sessionId, reason, detail });
  /*
    只要还在报 prime-pending,就确保有一次重建排着 —— 「这次还是没有重试」。

    上一版只在**刚被标记**的那一刻排一次:一个在这段代码存在之前就已经被标成 prime-pending 的会话
    (或者那次排空因为执行器不在而被跳过的),就永远等不到第二次。这里是每次上报状态都过一遍,而
    `schedulePrime` 本身是幂等的(已在队列或在跑就直接返回),所以不会堆叠。
  */
  if (reason === 'prime-pending') schedulePrime(sessionId);
}

/**
 * 欠着的重建要有人去跑 —— 「我的两个会话重启之后为什么检测到会话正忙就不再恢复了」。
 *
 * `prime-pending` 是**占用**状态,而且故意没有次数上限:它只在重建完成、你按 Stop、或者你清掉历史时释放。
 * 可重启之后没有任何东西去**启动**那次重建 —— 主进程只在执行器被换掉(切模型/切 agent)时自动踢一次,
 * 渲染端的兜底只踢你正打开的那一个。于是后台那几条会话就一直「忙」着,而根本没有活在跑:看着就是
 * 「检测到正忙,然后再也不恢复」。
 *
 * 所以「欠着」这件事本身就去排一次重建。两个限制是必须的,理由都写在原注释里:
 *   并发 2   启动时十几条会话同时 attach,一起打到模型上会把每一条都拖慢(原来靠渲染端只踢一条来避免)
 *   间隔     排空之间留一点空隙,让真正的用户操作插得进去
 */
const MAX_CONCURRENT_PRIMES = 2;
const primeWaiting: string[] = [];
const primeInFlight = new Set<string>();

function drainPrimeQueue(): void {
  while (primeInFlight.size < MAX_CONCURRENT_PRIMES) {
    const sessionId = primeWaiting.shift();
    if (!sessionId) return;
    const entry = sessionClients.get(sessionId);
    // 排队期间情况可能已经变了：执行器没了、你放弃了、或者别人已经重建完了
    if (!entry || entry.primeAbandoned || entry.primeGaveUp || entry.priming || !entry.needsHistoryPrime) continue;
    primeInFlight.add(sessionId);
    logger.info('prime', `auto-start sessionId=${sessionId} (owed rebuild, ${primeWaiting.length} still waiting)`);
    void primeHistoryNow(sessionId)
      .catch((err: any) => logger.warn('prime', `auto-start failed sessionId=${sessionId}: ${err?.message || err}`))
      .finally(() => {
        primeInFlight.delete(sessionId);
        setTimeout(drainPrimeQueue, 400);
      });
  }
}

function schedulePrime(sessionId: string): void {
  if (primeInFlight.has(sessionId) || primeWaiting.includes(sessionId)) return;
  primeWaiting.push(sessionId);
  setTimeout(drainPrimeQueue, 300);
}


/** Render one transcript message for history priming. Attachments are carried
 *  as `file:<path>` refs so a fresh backend can RE-READ an image/file the user
 *  sent earlier -- without this the transcript only has the visible text and an
 *  earlier image is forgotten completely.
 *
 *  Tool calls are summarised too, and that is load-bearing: everything the
 *  assistant actually DID (files created, edited, read, commands run) lives in
 *  `toolCalls`, never in `content`. A rebuild from `content` alone therefore
 *  produced a model that could not name a single document it had written -- some
 *  turns are literally 0 chars of text with 4 tool calls. Only title/kind/paths
 *  are carried, never `diffs`: the diffs hold whole file bodies (403KB of the
 *  810KB transcript in one real chat) and the file itself is the source of truth,
 *  so pointing at the path is both smaller and more accurate.
 */
const HISTORY_TOOLS_PER_MESSAGE = 12;
/** Tool kinds that RUN something rather than touch a file.
 *
 *  Deliberately a set of candidates, not one guessed string: across every recorded
 *  session (327 tool calls) the only kinds ever persisted were `edit` and `read`, so
 *  the exact spelling kiro-cli uses for a shell command has never been observed here.
 *  ACP's vocabulary says `execute`; the aliases cost nothing and avoid silently
 *  dropping commands again if it differs. `unobservedToolKinds` below logs whatever
 *  actually arrives, so this can be narrowed on evidence instead of guesswork. */
const RUN_KINDS = new Set(['execute', 'run', 'bash', 'shell', 'command', 'terminal']);
/** Tool-call kinds seen with neither locations nor diffs, logged once each. This is
 *  the missing evidence: it tells us what kiro-cli really calls a command. */
const unobservedToolKinds = new Set<string>();
/**
 * **哪些消息能发给模型** ——「这他妈什么玩意，为什么按照会话发出去了」。
 *
 * 两类要挡住：
 *   · 思考流水（`💭 `）—— 它是过程，不是内容；
 *   · **KiroLex 自己说的话**（`kirolex: true`）：「⚠️ 这条会话现在跑在 gpt-5.6-sol 上」
 *     「♻️ 已经换成新的后端会话」「⏳ 已排队」。它们是对**你**说的，原来以 `role: 'user'` 落进
 *     transcript，而快照和 history.md 都是从 transcript 建的 —— 于是模型下一轮真的读到
 *     "我现在跑在 gpt-5.6-sol 上"，还当成你的指令。
 *
 * 三条发给模型的路径（history.md、ride-along 快照、逐段重建）共用这一个判据 ——
 * 分开写必然漏掉一条，而漏掉的那条就是模型看到它的那条。
 */
/*
 * **判据搬到了 `src/main/kirolexNote.ts`** ——「这个还没修啊」。
 *
 * 第一次只接在三条路上（ride-along 快照、`history.md`、逐段重建），而实测今天的日志里它又出去了：
 * `[suggestions] … Based on the conversation below … User: ⚠️ 这条会话现在跑在 gpt-5.6-sol 上…`。
 * 漏的是**追问建议**和**会话记忆压缩**两条 —— 后者把这句话压进 memory，然后每一轮都注入，
 * 一句临时通知变成了永久上下文。
 *
 * 判据散在一处、调用点散在五处，漏掉是必然的。所以它现在是主进程和渲染进程共用的同一个函数。
 */

function historyLine(m: {
  role: string;
  content: string;
  attachments?: { name: string; path: string }[];
  toolCalls?: { title?: string; kind?: string; status?: string; locations?: string[] }[];
}, forExecutor: (p: string) => string = (p) => p): string {
  const who = m.role === 'user' ? 'User' : 'Assistant';
  // Every historical attachment is re-emitted here on EVERY turn, so an oversized
  // image referenced once keeps failing every later request in the chat. Resolve
  // each one to a copy within the backend's dimension limit -- see safeImageRef.
  //
  // 附件路径**原样**是用户机器上的绝对路径。远程会话里 kiro-cli 在另一台机器上，那个路径在它
  // 那儿不存在 —— 但它有 `local_read`（`localMcp.ts`），注入里也明说了"附件都在用户机器上，
  // 用 local_read 去读"。镜像时代这里要把路径改写成镜像路径，现在不需要了：不改写才是对的。
  const refs = (m.attachments || []).filter((a) => a?.path).map((a) => `file:${forExecutor(safeImageRef(a.path))}`);
  const tail = refs.length
    ? `\n[本条消息附带的文件/图片，需要时可直接读取]\n${refs.join('\n')}`
    : '';
  const tools = m.toolCalls || [];
  let actions = '';
  if (tools.length) {
    const seen = new Set<string>();
    const rows: string[] = [];
    for (const t of tools) {
      const paths = (t.locations || []).filter(Boolean);
      const key = `${t.kind || ''}|${t.title || ''}|${paths.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const failed = t.status === 'failed' ? '（失败）' : '';
      rows.push(`- [${t.kind || 'tool'}]${failed} ${t.title || ''}${paths.length ? `\n  ${paths.join('\n  ')}` : ''}`);
      if (rows.length >= HISTORY_TOOLS_PER_MESSAGE) break;
    }
    const more = tools.length > rows.length ? `\n- …另有 ${tools.length - rows.length} 项操作` : '';
    actions = `\n[本轮实际执行的操作与涉及的文件，内容以磁盘上的文件为准，需要时直接读取]\n${rows.join('\n')}${more}`;
  }
  // Cap EVERY image path in the finished line, not just the attachment refs above.
  // The tool rows carry original paths ("[read] Reading image /…/paste_x.png") and
  // the model happily re-reads them, so an oversized original kept coming back on
  // every turn even though the attachment refs were already capped. Prose paths get
  // the same treatment for the same reason. See capImagePathsInText.
  return capImagePathsInText(`${who}: ${m.content}${actions}${tail}`);
}

/** One rebuild prompt carries at most this many characters. A whole 100k+ char
 *  transcript sent as a SINGLE prompt is what used to fail (or instantly blow the
 *  context window and get compacted away), which silently left the chat with no
 *  memory of its own history. Chunking makes a large rebuild converge. */
const PRIME_CHUNK_CHARS = 24000;
/** NO cap on how much history is replayed. Truncating the replay was rejected as
 *  a design: a silently shortened history is indistinguishable from a complete one
 *  on the model's side, which is exactly the failure this machinery exists to
 *  prevent. The rebuild retries with backoff; when one chunk keeps failing,
 *  `primeVerdict` decides split / give-up (limits below). Giving up leaves the
 *  rebuild owed, so the next use retries it. Stop and clearing the history remain
 *  the user's own ways out. */
const PRIME_RETRY_BASE_MS = 5000;
const PRIME_RETRY_MAX_MS = 60000;
/** After this many consecutive failures on the SAME chunk, halve it and retry.
 *  Helps when the backend rejects a single oversized request; harmless when it
 *  does not. */
const PRIME_SPLIT_AFTER = 2;
/** Floor for that halving, so a hard failure cannot devolve into thousands of
 *  microscopic prompts. */
const PRIME_MIN_CHUNK_CHARS = 2000;
/** Failures on ONE chunk before giving up, whatever the reason. Without it a chunk
 *  that kept failing was retried every 60s forever (`chunk 1/6 FAILED tries=20`). */
const PRIME_MAX_TRIES = 8;
/** Failures on a chunk already at the floor before giving up: its size is no
 *  longer the cause, so more tries only repeat the same failure. */
const PRIME_GIVE_UP_AT_FLOOR = 3;
/** How much of the tail of the conversation a snapshot rebuild carries verbatim.
 *  Everything older is reachable through the rendered history file. */
const SNAPSHOT_RECENT_CHARS = 18000;
/** Model swaps allowed per rebuild cycle. Observed without a cap: 'sonnet-4.6'
 *  and 'sonnet-5' each reported unavailable and the loop ping-ponged between them
 *  16 times over 12 minutes, replacing the executor (and resetting the chunk
 *  cursor) every single time -- then chunk 1 succeeded on the model it had
 *  already rejected 8 times. The unavailability is transient, so after this many
 *  swaps the right move is to wait and retry, not to keep switching. */
const PRIME_MAX_MODEL_SWAPS = 2;
/** Models already tried in the current rebuild cycle, so a swap never returns to
 *  one that just failed. Cleared when the rebuild finishes or is called off. */
const primeModelsTried = new Map<string, Set<string>>();

function contextEstablished(sessionId: string, entry: SessionEntry): boolean {
  try {
    const rec = store.readRecord(sessionId);
    return !!rec
      && rec.contextEstablishedFor === entry.cliSessionId
      && rec.contextEstablishedPid === entry.client.pid;
  } catch { return false; }
}

/** Flag a chat whose backend cannot be shown to hold its history, so the session
 *  reports busy and queues instead of answering from nothing. Returns true when a
 *  rebuild is owed. Called from BOTH the send gate and session activation: doing
 *  it only on send meant the chat sat there looking idle after a restart and the
 *  rebuild began only once the user had already typed something. */
function markContextOwedIfUnverified(sessionId: string, trigger: string): boolean {
  const entry = sessionClients.get(sessionId);
  if (!entry) return false;
  if (entry.priming || entry.needsHistoryPrime) return true;
  if (entry.primeAbandoned) return false;                       // user opted out
  /**
   * flow 自己的那两种会话不欠重建 —— 「修改 flow 这个会话为什么会需要重建上下文，太荒谬了」。
   *
   * 荒谬在于**重放它的历史毫无意义**:
   *   `skill`(画布/注册那条)  它的全部内容就是一份生成提示词加一份 JSON 结构;而结构的权威副本在注册表里,
   *                           画布也是从那儿渲染的。后端换了执行器,正确的做法是把结构提示词**再发一次**,
   *                           不是把几万字的 JSON 一轮一轮重放 —— 那不但贵,还会把上下文塞满。
   *   `flow-worker`           一步的输入由 run 重新拼出来(`assembleStepPrompt`:起跑输入 + 上游材料 + 指令),
   *                           所以重跑一步比重放它的历史更准确,也是驱动本来就在做的事。
   * 而流程主会话(`flow-main`)不在这里:它是你和它商量状态的那条线程,历史有价值,照旧重建。
   */
  try {
    const purpose = store.readRecord(sessionId)?.purpose;
    if (purpose === 'skill' || purpose === 'flow-worker') {
      logger.info('prime', `skip rebuild for ${purpose} sessionId=${sessionId} trigger=${trigger} — 它的内容由结构/run 重新产生，重放没有意义`);
      return false;
    }
  } catch { /* 读不到记录就按普通会话处理 */ }
  if (store.transcriptFileSize(sessionId) <= 0) return false;    // nothing to restore
  if (contextEstablished(sessionId, entry)) return false;
  entry.needsHistoryPrime = true;
  entry.primeCursor = 0;
  entry.primeChunks = undefined;
  let establishedFor: string | undefined;
  let establishedPid: number | undefined;
  try {
    const rec = store.readRecord(sessionId);
    establishedFor = rec?.contextEstablishedFor;
    establishedPid = rec?.contextEstablishedPid;
  } catch {}
  logger.info('prime', `unverified backend sessionId=${sessionId} trigger=${trigger} cli=${entry.cliSessionId} pid=${entry.client.pid} establishedFor=${establishedFor} establishedPid=${establishedPid} -> rebuild owed`);
  emitSessionBusy(sessionId);
  // 欠着就去排一次 —— 占用状态必须伴随真的有活在跑，否则它就是个死锁
  schedulePrime(sessionId);
  return true;
}

/** The executor was just REPLACED (model or Agent switch). Decide how this chat's
 *  context comes back.
 *
 *  Both switches end on a brand new kiro-cli process, so `contextEstablished` --
 *  which pins the pid -- is necessarily false and the new backend really is empty.
 *  What was wrong was the response: both handlers used to mark the rebuild owed and
 *  fire `primeHistoryNow` immediately, which
 *
 *    1. contradicted `acp:ensure-context`, where the SAME conclusion ("this backend
 *       is empty") deliberately does nothing in snapshot mode, and
 *    2. actively FORECLOSED the free path: `!entry.needsHistoryPrime` is one of the
 *       ride-along preconditions, and marking the debt is the first thing
 *       `markContextOwedIfUnverified` does -- so switching model turned a zero-cost
 *       restore into a locked chat plus a dedicated model turn that can fail and
 *       retry (observed: three rebuild attempts in five minutes, all failing on an
 *       unavailable model, the chat unusable throughout).
 *
 *  In snapshot mode the correct action is NOTHING: the marker already fails, so the
 *  next message carries the snapshot in the same request, at no extra cost. The
 *  original justification -- "until the user types, the chat looks connected while
 *  remembering nothing" -- does not apply, because without a turn there is nothing
 *  that could answer from an empty context.
 *
 *  Verbatim ('full') mode still needs a real rebuild: one turn PER CHUNK cannot
 *  ride along on a single message. */
function restoreContextAfterExecutorSwap(sessionId: string, trigger: string): void {
  if (store.readRecord(sessionId)?.primeMode === 'full') {
    if (markContextOwedIfUnverified(sessionId, trigger)) {
      void primeHistoryNow(sessionId).catch(() => {});
    }
    return;
  }
  logger.info('prime', `context RIDES ALONG after ${trigger} sessionId=${sessionId} — no rebuild turn, chat stays usable`);
}

/** ONE prompt that restores what actually matters, instead of replaying the whole
 *  conversation turn by turn on every launch.
 *
 *  This is not the truncation that was rejected earlier. What made truncation
 *  unacceptable was that a shortened history is indistinguishable from a complete
 *  one on the model's side. Here the prompt states plainly that it is a digest,
 *  how many turns are not inlined, and the absolute path of the fully rendered
 *  history -- so the omitted text is retrievable rather than gone, and the model
 *  knows to go get it. */
/** Render this chat's transcript to `history.md` and return its path.
 *
 *  Called from the rebuild AND after every turn. The refresh matters because the
 *  snapshot hands the model this path and tells it to read the file for anything
 *  older than the inlined tail. Written only once at rebuild time, the file froze
 *  at that moment while the conversation moved on -- so hours later the model
 *  would read a file that OMITS everything since, while its own header claimed
 *  "全部 N 条消息，未删减". A stale-but-authoritative-looking history is exactly
 *  the failure mode this machinery exists to prevent. */
function renderHistoryFile(sessionId: string): { path: string; count: number } | null {
  try {
    const stored = store.readTranscript(sessionId)
      .filter(modelFacing);
    const lines = stored.map((m) => historyLine(m));
    if (!lines.join('').trim()) return null;
    const path = store.writeHistoryFile(
      sessionId,
      `# ${sessionId} — 完整对话历史（由 KiroLex 从自身记录渲染）\n`
      + `# 渲染时间 ${new Date().toISOString()}，共 ${lines.length} 条消息\n\n`
      + `${lines.join('\n\n---\n\n')}\n`,
    );
    return { path, count: lines.length };
  } catch (err: any) {
    logger.info('prime', `render history FAILED sessionId=${sessionId} err=${err?.message}`);
    return null;
  }
}

/** Mark this backend as holding this chat's history. Bound to BOTH the cli session
 *  id and the pid, because kiro-cli hands back the same id for a brand new empty
 *  conversation after a restart. */
function markContextEstablished(sessionId: string, entry: SessionEntry): void {
  try {
    const rec = store.readRecord(sessionId);
    if (!rec) return;
    rec.contextEstablishedFor = entry.cliSessionId;
    rec.contextEstablishedPid = entry.client.pid;
    store.writeRecord(rec);
  } catch {}
}

function clearContextEstablished(sessionId: string): void {
  try {
    const rec = store.readRecord(sessionId);
    if (!rec) return;
    delete rec.contextEstablishedFor;
    delete rec.contextEstablishedPid;
    store.writeRecord(rec);
  } catch {}
}

/** The hand-off line the ride-along block must end with, or the model answers the
 *  restored context instead of the message that follows it. */
const RIDE_ALONG_HANDOFF = '\n\n---\n\n以上是恢复的上下文。下面是用户这一条新消息，请正常回答它：';

/** Drop the archive header `writeLastInjection` puts on `last-injection.md`.
 *
 *  The Snapshot tab shows that file verbatim, so a block edited there arrives with the
 *  `# …` preamble and its `=====` rule. Those lines would be harmless to send but they
 *  claim a send time that is no longer true, so they are cut -- and only when the text
 *  before the rule really is all comments, so a conversation that happens to contain a
 *  row of `=` is left alone. */
function stripArchiveHeader(text: string): string {
  const rule = text.match(/^={10,}\s*$/m);
  if (!rule || rule.index === undefined) return text;
  const head = text.slice(0, rule.index);
  const allComments = head.split('\n').filter((l) => l.trim()).every((l) => l.trimStart().startsWith('#'));
  if (!allComments) return text;
  return text.slice(rule.index + rule[0].length).replace(/^\n+/, '');
}

/** The snapshot, worded to ride along with the user's own message rather than to
 *  be a standalone priming turn (so: no "reply OK", and it explicitly hands off to
 *  the real message that follows it). */
function buildHistoryRideAlong(sessionId: string): string {
  try {
    // A HAND-EDITED block wins over the generated one, and is used VERBATIM: what the
    // user sees in the Snapshot tab is what goes out, which is the only predictable
    // rule for something they curated themselves.
    const override = store.readContextOverride(sessionId);
    if (override) {
      let text = stripArchiveHeader(override.text).trimEnd();
      // …with one exception: the hand-off is restored if it was edited away. Without it
      // the model treats the restored history as the thing to reply to, which shows up
      // as "Kiro answered a question I did not ask".
      if (!text.includes('请正常回答它')) {
        text += RIDE_ALONG_HANDOFF;
        logger.info('prime', `context override had no hand-off line sessionId=${sessionId} -> appended`);
      }
      logger.info('prime', `context OVERRIDE (hand-edited) sessionId=${sessionId} chars=${text.length}`);
      return text;
    }
    const stored = store.readTranscript(sessionId)
      .filter(modelFacing);
    const lines = stored.map((m) => historyLine(m));
    if (!lines.join('').trim()) return '';
    return `${buildSnapshot(sessionId, stored, lines, { rideAlong: true })}${RIDE_ALONG_HANDOFF}`;
  } catch (err: any) {
    logger.info('prime', `ride-along build FAILED sessionId=${sessionId} err=${err?.message}`);
    return '';
  }
}

/** Refresh `history.md` at TURN END, immediately.
 *
 *  Measured on the transcripts here: 31ms for the largest (3.0MB read, 2.7MB
 *  rendered, atomic replace included), against a turn that takes seconds -- so
 *  debouncing bought nothing and cost two real things: a window in which the file
 *  the backend was told to read lagged the conversation, and a pending timer that
 *  could re-render from a transcript the user had just cleared.
 *
 *  Called ONLY at turn end, not on every append: the user message is already on
 *  disk by then, so one write per turn covers both halves of the exchange.
 *
 *  Only refreshes chats that already HAVE the file, i.e. ones whose backend was
 *  handed the path -- it never CREATES it for chats that were never primed. */
function refreshHistoryFile(sessionId: string): void {
  if (!isFeatureEnabled('historyFileRefresh')) return;
  if (!store.hasHistoryFile(sessionId)) return;
  const res = renderHistoryFile(sessionId);
  if (res) logger.info('prime', `history file refreshed sessionId=${sessionId} messages=${res.count}`);
}

function buildSnapshot(sessionId: string, stored: any[], lines: string[], opts?: { rideAlong?: boolean }): string {
  const rendered = renderHistoryFile(sessionId);
  const historyPath = rendered?.path || store.historyFilePath(sessionId);
  const recent: string[] = [];
  let acc = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (recent.length && acc + lines[i].length > SNAPSHOT_RECENT_CHARS) break;
    recent.unshift(lines[i]);
    acc += lines[i].length;
  }
  const omitted = lines.length - recent.length;
  const manifest = artifactManifest(stored);
  const parts = [
    opts?.rideAlong
      ? '以下是本会话之前的对话记录（由 KiroLex 保存并恢复；kiro-cli 不持久化 ACP 会话，所以每次重启后端都是空的）。不要复述它，也不要重新回答其中已经回答过的问题，只把它当作你和用户此前的共同上下文。'
      : '以下是本会话之前对话的恢复上下文（由 KiroLex 保存并恢复；kiro-cli 不持久化 ACP 会话，所以每次重启后端都是空的）。请只回复“OK”，不要复述、不要重新回答其中内容。',
    `完整历史原文（全部 ${lines.length} 条消息，未删减）保存在这个文件里：\n${historyPath}\n这个文件会随本会话继续更新，任何时候重新读它拿到的都是最新的完整记录。下面只内联了最近 ${recent.length} 条${omitted > 0 ? `，更早的 ${omitted} 条没有内联` : ''}。凡是需要更早的细节、原话或数字，直接读这个文件，不要凭印象作答，也不要说“不记得”。`,
  ];
  if (manifest) {
    parts.push(`本会话全程产出/修改过的文件（内容一律以磁盘上的文件为准，需要时直接读取）：\n${manifest}`);
  }
  parts.push(`最近 ${recent.length} 条对话原文：\n\n${recent.join('\n\n')}`);
  return parts.join('\n\n');
}

/** Every file the assistant created/edited across the WHOLE conversation, newest
 *  last. Cheap (a few hundred chars) and it is the single most important fact a
 *  rebuilt backend needs: what it produced and where. */
function artifactManifest(msgs: { toolCalls?: { kind?: string; title?: string; locations?: string[] }[] }[]): string {
  const MUTATING = new Set(['edit', 'create', 'write', 'delete', 'move', 'rename']);
  const seen = new Map<string, string>();
  for (const m of msgs) {
    for (const tc of m.toolCalls || []) {
      if (!MUTATING.has((tc.kind || '').toLowerCase())) continue;
      for (const p of tc.locations || []) if (p) seen.set(p, tc.title || '');
    }
  }
  if (!seen.size) return '';
  return Array.from(seen.entries()).map(([p, title]) => `- ${p}${title ? `  （${title}）` : ''}`).join('\n');
}

/** Split rendered history on MESSAGE boundaries so no single message is torn in
 *  half across two rebuild prompts. A message that is BY ITSELF over the limit
 *  (a full generated report easily is) gets hard-split on line boundaries --
 *  otherwise one such message reproduces the very problem this fixes: a single
 *  enormous prompt. */
function splitHistory(lines: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let cur = '';
  const flush = () => { if (cur) { chunks.push(cur); cur = ''; } };
  const add = (piece: string) => {
    if (cur && cur.length + piece.length + 2 > maxChars) flush();
    cur = cur ? `${cur}\n\n${piece}` : piece;
  };
  for (const line of lines) {
    if (line.length <= maxChars) { add(line); continue; }
    // Oversized single message: emit it as its own sequence of bounded pieces.
    flush();
    let buf = '';
    for (const seg of line.split('\n')) {
      if (buf && buf.length + seg.length + 1 > maxChars) { chunks.push(buf); buf = ''; }
      if (seg.length > maxChars) {
        // Pathological single line (minified blob / one-line table): hard slice.
        if (buf) { chunks.push(buf); buf = ''; }
        for (let i = 0; i < seg.length; i += maxChars) chunks.push(seg.slice(i, i + maxChars));
        continue;
      }
      buf = buf ? `${buf}\n${seg}` : seg;
    }
    if (buf) chunks.push(buf);
  }
  flush();
  return chunks;
}

/** Rebuild a fresh backend's context from KiroLex's OWN durable transcript.
 *
 *  Contract, and why it is written this way:
 *   - `needsHistoryPrime` is cleared ONLY after every chunk landed. A failure
 *     therefore leaves the flag set and gets retried, instead of permanently
 *     losing the history (the old code cleared it BEFORE sending and swallowed
 *     the error, so one failed send discarded the whole conversation silently).
 *   - Concurrent callers share one `primePromise`; the rebuild runs once.
 *   - Every outcome is logged. The old path logged success only, which made a
 *     lost history invisible in the log.
 */
async function primeHistoryNow(
  sessionId: string,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const entry = sessionClients.get(sessionId);
  const force = !!opts?.force;
  logger.info('prime', `requested sessionId=${sessionId} force=${force} attached=${!!entry} needs=${!!entry?.needsHistoryPrime} busy=${!!entry?.busy} priming=${!!entry?.priming}`);
  if (!entry) {
    logger.info('prime', `SKIP sessionId=${sessionId} reason=not-attached`);
    return { ok: false, error: '该会话尚未连接后端，先打开它再重建' };
  }
  if (entry.primePromise) {
    logger.info('prime', `JOIN sessionId=${sessionId} reason=already-in-flight`);
    return entry.primePromise;
  }
  // Forced rebuild (user-invoked). Needed because a SUCCESSFUL session/load says
  // nothing about whether kiro-cli actually restored any conversation: it can
  // resume an id that was itself created empty, and then KiroLex believes the
  // context is fine while the model knows nothing. That case is only detectable
  // by the human, so it needs a manual entry point.
  if (force) {
    entry.needsHistoryPrime = true;
    entry.primeAttempts = 0;
    entry.primeCursor = 0;
    entry.primeChunks = undefined;
    entry.primeAbandoned = false;   // an explicit rebuild request revokes the opt-out
  }
  if (!entry.needsHistoryPrime) {
    logger.info('prime', `SKIP sessionId=${sessionId} reason=not-needed`);
    return { ok: true, skipped: true };
  }
  if (entry.primeAbandoned) {
    logger.info('prime', `SKIP sessionId=${sessionId} reason=user-abandoned (右键「重建上下文」可重新发起)`);
    return { ok: true, skipped: true };
  }
  if (entry.busy) {
    // Do NOT fail: a turn (or context compaction) is settling. The flag is set, so
    // the rebuild runs before the next message is accepted. Queue, do not reject.
    emitSessionBusy(sessionId);
    logger.info('prime', `QUEUED sessionId=${sessionId} reason=backend-busy (will rebuild before next message)`);
    return { ok: true, queued: true } as any;
  }

  let stored: any[] = [];
  let lines: string[];
  try {
    stored = store.readTranscript(sessionId)
      .filter(modelFacing);
    lines = stored.map((m) => historyLine(m));
  } catch (err: any) {
    logger.info('prime', `read transcript FAILED sessionId=${sessionId} err=${err?.message}`);
    return { ok: false, error: 'read transcript failed' };
  }
  if (!lines.join('').trim()) {
    entry.needsHistoryPrime = false;
    logger.info('prime', `SKIP sessionId=${sessionId} reason=empty-transcript`);
    return { ok: true, skipped: true };
  }

  // How the context is restored. Default 'snapshot': one prompt (manifest + recent
  // turns + the path of the complete rendered history) instead of one model turn
  // per chunk on every launch. 'full' replays everything verbatim -- exact, but a
  // 3MB chat is 78 turns EVERY restart, because kiro-cli cannot restore an ACP
  // session. Small chats fit in a single chunk anyway, so they always go verbatim.
  let mode: 'snapshot' | 'full' = 'snapshot';
  try { if (store.readRecord(sessionId)?.primeMode === 'full') mode = 'full'; } catch {}
  const fullChunks = splitHistory(lines, PRIME_CHUNK_CHARS);
  if (fullChunks.length <= 1) mode = 'full';

  let chunks = entry.primeChunks && entry.primeChunks.length
    ? entry.primeChunks                      // retry: replay byte-identical content
    : mode === 'full'
      ? fullChunks
      : splitHistory([buildSnapshot(sessionId, stored, lines)], PRIME_CHUNK_CHARS);
  if (!entry.primeChunks) {
    // Full replay prepends the artifact manifest (never a substitute for the
    // history): "which files exist and where" is the fact that gets lost first,
    // and it costs a few hundred chars. Snapshot mode already embeds it.
    if (mode === 'full' && chunks.length > 1) {
      const manifest = artifactManifest(stored);
      if (manifest) {
        chunks = [`（以下先给出本会话全程产出/修改过的文件清单，内容一律以磁盘上的文件为准，需要时直接读取。随后是完整对话历史，共 ${chunks.length} 段。）\n\n${manifest}`, ...chunks];
        logger.info('prime', `manifest prepended sessionId=${sessionId} chars=${manifest.length}`);
      }
    }
    logger.info('prime', `plan sessionId=${sessionId} mode=${mode} messages=${lines.length} chars=${lines.reduce((n, l) => n + l.length, 0)} chunks=${chunks.length} (full replay would be ${fullChunks.length})`);
    entry.primeChunks = chunks;
    entry.primeCursor = 0;
  }
  entry.primeAttempts = (entry.primeAttempts || 0) + 1;
  entry.primeGaveUp = false;   // this IS the "next use": try again from the cursor

  const run = (async (): Promise<{ ok: boolean; error?: string }> => {
    entry.busy = true;
    entry.priming = true;
    try {
      let sameChunkFailures = 0;
      // "Backend still settling" retries: they drive the backoff but are NOT
      // failures, so they never count towards giving up.
      let busyWaits = 0;
      // Retry until every chunk is accepted, never truncating. A chunk that keeps
      // failing ends the run per `primeVerdict` (flag stays set, next use retries).
      // The user's other ways out are Stop (abandon) and clearing history.
      while ((entry.primeCursor || 0) < chunks.length) {
        // The executor can be replaced under us (model swap / re-attach). A new
        // kiro-cli process starts EMPTY, so this run's cursor is meaningless
        // there; stop and let that executor's own gate rebuild from scratch.
        if (sessionClients.get(sessionId) !== entry) {
          logger.info('prime', `ABORT sessionId=${sessionId} reason=executor-replaced (new backend will rebuild from 0)`);
          return { ok: false, error: '后端已被替换，将重新开始重建' };
        }
        if (entry.primeAbandoned) {
          logger.info('prime', `ABORT sessionId=${sessionId} reason=user-abandoned mid-rebuild cursor=${entry.primeCursor}/${chunks.length}`);
          return { ok: false, error: '用户已放弃重建' };
        }
        const i = entry.primeCursor || 0;
        const totalNow = chunks.length;
        const retryNote = sameChunkFailures ? `（第 ${sameChunkFailures + 1} 次尝试）` : '';
        entry.primeDetail = totalNow > 1
          ? `重建历史上下文 ${i + 1}/${totalNow}${retryNote}`
          : `重建历史上下文${retryNote}`;
        emitSessionBusy(sessionId);
        const head = totalNow > 1
          ? `以下是本会话之前对话历史的第 ${i + 1}/${totalNow} 部分（由 KiroLex 保存并恢复）。请只回复"OK"，不要复述、不要重新回答其中内容；全部部分接收完毕后把它们作为后续对话的已知上下文。`
          : `以下是本会话之前的完整对话历史（由 KiroLex 保存并恢复）。请只回复"OK"确认已读取，不要复述或重新回答其中内容；把它作为后续对话的已知上下文。`;
        try {
          await entry.client.sendPrompt(entry.cliSessionId, [
            { type: 'text', text: `<hidden>${head}\n\n${chunks[i]}</hidden>` },
          ]);
          logger.info('prime', `chunk ${i + 1}/${totalNow} ok sessionId=${sessionId} chars=${chunks[i].length}`);
          entry.primeCursor = i + 1;
          entry.primeLastError = undefined;
          sameChunkFailures = 0;
          busyWaits = 0;
          continue;
        } catch (err: any) {
          // Surface WHY. kiro-cli answers many backend faults with a bare -32603
          // "Internal error" and puts the real reason in `error.data`; the first
          // version of this loop logged only `message`, which is why a 4-minute
          // chunk-7 failure was undiagnosable after the fact.
          let detail = '';
          try { detail = err?.data ? (typeof err.data === 'string' ? err.data : JSON.stringify(err.data)) : ''; } catch {}
          const msg = `${err?.message || 'prime failed'}${detail ? ` — ${detail}` : ''}`;
          entry.primeLastError = msg;
          // A turn is still settling in the backend (often context compaction).
          // Not an error state: wait it out and retry the SAME chunk.
          const stillBusy = /prompt already in progress|active turn|compaction/i.test(msg);
          if (stillBusy) busyWaits++;
          else sameChunkFailures++;
          logger.info('prime', `chunk ${i + 1}/${totalNow} FAILED sessionId=${sessionId} chars=${chunks[i].length} tries=${sameChunkFailures} busyWaits=${busyWaits} err=${msg}`);

          // Model retired mid-rebuild: swapping replaces the executor, whose new
          // process is empty, so this run ends and the fresh one rebuilds from 0.
          // Bounded, and never back to a model this cycle already tried -- the
          // unbounded version ping-ponged between two unavailable models 16 times
          // and then succeeded on one it had rejected 8 times, i.e. the condition
          // was transient and switching was the wrong response.
          if (isModelUnavailableError(msg)) {
            const tried = primeModelsTried.get(sessionId) || new Set<string>();
            tried.add(entry.profile.model);
            primeModelsTried.set(sessionId, tried);
            if (tried.size <= PRIME_MAX_MODEL_SWAPS) {
              const swapped = await swapSessionModel(sessionId, entry.profile.model, `prime ${sessionId}`, tried);
              if (swapped) {
                logger.info('prime', `model unavailable during rebuild sessionId=${sessionId} swapped=${swapped} tried=${Array.from(tried).join(',')}`);
                return { ok: false, error: `模型不可用，已切换后端（${msg}）` };
              }
            }
            logger.info('prime', `model unavailable during rebuild sessionId=${sessionId} NOT swapping (tried=${Array.from(tried).join(',')}) -> backing off and retrying same model`);
          }
          const verdict = primeVerdict({
            tries: sameChunkFailures,
            chunkChars: chunks[i].length,
            stillBusy,
            minChunkChars: PRIME_MIN_CHUNK_CHARS,
            splitAfter: PRIME_SPLIT_AFTER,
            maxTries: PRIME_MAX_TRIES,
            giveUpAtFloor: PRIME_GIVE_UP_AT_FLOOR,
          });
          if (verdict === 'give-up') {
            // NOT a success: needsHistoryPrime stays set so the next use retries
            // (resuming at this cursor). primeGaveUp releases the session and keeps
            // the owed flag from re-queuing this run straight away.
            const note = primeGiveUpNote({
              chunk: i + 1, total: totalNow, chars: chunks[i].length, tries: sameChunkFailures, error: msg,
              atFloor: chunks[i].length <= PRIME_MIN_CHUNK_CHARS,
            });
            entry.primeLastError = note;
            entry.primeGaveUp = true;
            primeModelsTried.delete(sessionId);
            logger.info('prime', `GAVE UP sessionId=${sessionId} chunk=${i + 1}/${totalNow} chars=${chunks[i].length} tries=${sameChunkFailures} cursor=${entry.primeCursor}/${chunks.length} err=${msg} (still owed; next use retries)`);
            return { ok: false, error: note };
          }
          // Repeated failure on one chunk: halve it. Helps if the backend is
          // rejecting this single request's size; harmless otherwise.
          if (verdict === 'split') {
            const half = splitHistory([chunks[i]], Math.max(PRIME_MIN_CHUNK_CHARS, Math.floor(chunks[i].length / 2)));
            if (half.length > 1) {
              chunks.splice(i, 1, ...half);
              entry.primeChunks = chunks;
              sameChunkFailures = 0;
              busyWaits = 0;
              logger.info('prime', `chunk ${i + 1} SPLIT into ${half.length} sessionId=${sessionId} sizes=${half.map((c) => c.length).join(',')} total=${chunks.length}`);
              continue;
            }
          }
          const wait = Math.min(PRIME_RETRY_MAX_MS, PRIME_RETRY_BASE_MS * Math.pow(2, Math.max(0, sameChunkFailures + busyWaits - 1)));
          entry.primeDetail = `重建历史上下文 ${i + 1}/${totalNow} 失败，${Math.round(wait / 1000)}s 后重试`;
          emitSessionBusy(sessionId);
          logger.info('prime', `retry in ${wait}ms sessionId=${sessionId} chunk=${i + 1}/${totalNow}`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      // Success is the ONLY thing that clears the flag.
      entry.needsHistoryPrime = false;
      entry.primeChunks = undefined;
      primeModelsTried.delete(sessionId);
      // Persist WHICH backend holds the context -- id AND pid. `session/load`
      // reporting success is not evidence: kiro-cli does not persist ACP
      // sessions, so the same id in a new process is a blank conversation.
      try {
        const rec = store.readRecord(sessionId);
        if (rec) {
          rec.contextEstablishedFor = entry.cliSessionId;
          rec.contextEstablishedPid = entry.client.pid;
          store.writeRecord(rec);
        }
      } catch {}
      logger.info('prime', `history primed sessionId=${sessionId} mode=${mode} cli=${entry.cliSessionId} pid=${entry.client.pid} chunks=${chunks.length} chars=${chunks.reduce((n, c) => n + c.length, 0)} attempt=${entry.primeAttempts}`);
      return { ok: true };
    } catch (err: any) {
      const msg = err?.message || 'prime failed';
      logger.info('prime', `history rebuild ABORTED sessionId=${sessionId} attempt=${entry.primeAttempts} cursor=${entry.primeCursor}/${chunks.length} err=${msg}`);
      return { ok: false, error: msg };
    } finally {
      const e = sessionClients.get(sessionId);
      if (e) {
        e.priming = false;
        e.busy = false;
        e.primeDetail = undefined;
        e.primePromise = undefined;
        e.assistantBuf = '';
        e.assistantMsgId = null;
      }
      emitSessionBusy(sessionId);
    }
  })();

  entry.primePromise = run;
  return run;
}

/**
 * **一次 `session/load` 最多等多久** ——「❌ Error invoking remote method 'acp:switch-model':
 * Error: session/load 超时（12s 无响应）」。
 *
 * 这个闸的目的是防**卡死**（一个 stale `cliSessionId` 不停流、把空闲计时器一直顶住，于是
 * `reconfiguring` 标记永远不清，之后每一次切换都答「Another model, Agent, or permission change
 * is still in progress.」）—— 它**不是**性能预算。原来的 12s 把这两件事混在一起了。
 *
 * 实测（2026-09-18 07:59 / 08:00，同一条会话连着两次失败）：切模型要起一个**冷的** kiro-cli，
 * 而同一时刻常规 attach 的 `session/load` 用了 **32 秒**（07:59:37 → 08:00:09 `resume ok`）。
 * 也就是说 12s 根本不够 —— 于是新执行器超时、回滚旧执行器又超时，会话被留在"没连着"的状态，
 * 而界面上只看到一句没头没尾的超时。45s 仍然是有界的（卡死照样会被打断），但把正常的冷启动放进去了。
 *
 * 远程会话的上限是另一个数字（`loadTimeoutFor`）：SSH 握手 + 远端冷启动都要算进去，
 * 拿本地这个 45s 去量远端，只会把"慢一点"判成"起不来"，然后去做完全没必要的重建。
 */
/**
 * **取证读哪台机器** —— 远程会话里 kiro-cli 的日志和会话都在远端（`docs/DESIGN_remote_sessions.md`）。
 *
 * `hostFor` 拿到 `undefined` 就是本地，所以本地路径的行为一个字节都没变；SSH 那一侧复用
 * `buildSshArgs`/`shellQuote`，和 `connect()`、`loopVerify` 是同一个决策 —— 三处各写一遍
 * 迟早会分叉，而分叉的那一处就是连不上又说不清为什么的那一处。
 */
const diagHost = (remote?: RemoteTarget): HostOps => hostFor(remote, { buildSshArgs, shellQuote });

/**
 * **KiroLex 自己的提示走状态行，不进对话** ——「你自己写的那个提示什么的不要中断弄回对话框」。
 *
 * 这些话（⏳ 正在推/拉、⚠️ 本地不是最新的/有冲突、🔀 换了机器）是**对你说的**，不是对话内容：
 * 写进 transcript 的代价有三样 —— 打断对话的读法、把 transcript 撑大（远程会话里它每轮都要推）、
 * 以及"KiroLex 说的话别发给模型"那条规则要一直靠过滤兜着（那个坑今天已经踩过一次）。
 *
 * 所以它们只发事件，界面显示在输入框上方、自己会消失。
 */
function sessionNotice(sessionId: string, text: string): void {
  try {
    mainWindow?.webContents.send('session:notice', { sessionId, text, ts: Date.now() });
  } catch { /* 提示永远不能让主流程失败 */ }
  logger.info('notice', `${sessionId}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
}

/**
 * **本地工具通道** ——「把镜像去掉，给远程配一些能调用本地 MCP 的能力」。
 *
 * 一个 MCP server（只听 127.0.0.1），每条远程会话一个 token + 一个远端端口。
 * server 懒启动：没有远程会话的时候不开端口。
 */
let localMcpServer: LocalMcpServer | undefined;
const localToolsBySession = new Map<string, { remotePort: number; localPort: number; agentOverride: string; forwarded?: string[]; mcpServers?: any[] }>();

/**
 * **只起一个** MCP server ——「重复利用」顺手挖出来的一个真 bug。
 *
 * 原来是 `if (!localMcpServer) localMcpServer = await startLocalMcp(...)`。那个 `await`
 * 前面没有任何闸门，而 `ensureLocalTools` 是**7 条会话同时**进来的：七条都看到
 * `undefined`，于是**起了七个 HTTP server**（实测 61713–61719 全在 listen），
 * 而变量最后只剩最后那一个。前六条会话的 token 登记在**变量已经不指向的那些 server** 上。
 *
 * 为什么以前没露出来：以前一条会话一个远端端口、一条隧道，各自通向"自己那次"起的那个
 * server —— 每条会话都恰好能找到自己的 token，七个 server 只是白占端口。
 * 共用一条隧道之后它立刻致命：隧道通向最后那个 server，于是**六条会话的工具全 404**，
 * 而且是静默的（模型只会说"这个文件不存在"）。
 *
 * 和刚修的端口竞态、preflight 风暴是同一个病：**await 前面少一道"已经有人在做了"的闸门**。
 */
let localMcpStarting: Promise<LocalMcpServer> | undefined;
function ensureLocalMcpServer(): Promise<LocalMcpServer> {
  if (localMcpServer) return Promise.resolve(localMcpServer);
  if (localMcpStarting) return localMcpStarting;
  localMcpStarting = startLocalMcp({
    log: (level, message) => logger[level]('localmcp', message),
    notice: (sid, text) => sessionNotice(sid, text),
  }).then((srv) => { localMcpServer = srv; return srv; })
    .finally(() => { localMcpStarting = undefined; });
  return localMcpStarting;
}

/**
 * 给这条远程会话备好本地工具：登记 token、分配远端端口、在远端写下那条会话专用的 agent。
 *
 * 失败就返回 `undefined` 并说出来 —— **不静默降级**：没有本地工具的远程会话根本读不到用户的
 * 文件，而它会把"读不到"解释成"这个东西不存在"。
 */
/**
 * 本地工具**没备上**的那些会话。
 *
 * 在失败的那一刻记下来，而不是事后去猜：`SessionEntry` 不带 `localTools`，
 * 而 `AcpClient` 里那份是私有的 —— 从外面推断"它有没有工具"只会推错。
 * master 自愈回来之后要重接的就是这批（见 `rearmLocalToolsFor`）。
 */
const toollessSessions = new Set<string>();

async function ensureLocalTools(
  sessionId: string,
  profile: AgentProfile,
  localDir: string,
): Promise<{ remotePort: number; localPort: number; agentOverride: string; forwarded?: string[]; mcpServers?: any[] } | undefined> {
  const remote = profile.remote;
  if (!remote?.sshHost) return undefined;
  try {
    const server = await ensureLocalMcpServer();
    const agentOverride = sessionAgentName(sessionId, OWNER);
    const token = server.register({ sessionId, workdir: localDir });
    const urlPath = server.urlPathFor(sessionId) || `/mcp/${token}`;
    /*
      **端口归机器，不归会话** ——「重复利用」。

      以前是一条会话一个远端端口、一条 ssh 一个 `-R`，于是有两个必然的麻烦：

        · 并发分配要抢：启动时两条会话并行 attach，都在"分配"和"登记"之间 await 了一次，
          于是拿到同一个 39100，而 `ExitOnForwardFailure=yes` 让第二条 ssh 直接起不来；
        · 换 agent / 换模型必须换端口：那条路是**先起新执行器、成功了再关旧的**（故意的，
          失败时不丢会话），新 ssh 去绑旧端口时旧 ssh 还占着 —— 看起来像"SSH 掉线"，
          其实是必然发生而且重试必然再撞。

      两个麻烦同一个根：端口被当成了会话的东西。而它唯一的工作是"能连到本机那个 MCP server",
      分辨会话的是 URL 里的 token。所以现在一台机器一条隧道、一个端口，所有会话共用它 ——
      抢不起来，也不用换。
    */
    /*
      **复用不可用时回到"每条会话自己一条隧道"** ——「看一下有没有 windows 上不能跑的东西」。

      Win32-OpenSSH 没有实现连接多路复用（`ControlMaster` 它不认），而这个模块的探活是
      unix socket 形状的 —— 所以在 Windows 上复用**永远建不起来**。原来这里直接 await，
      于是每条远程会话等满 12 秒然后失败：这是我加复用时引入的回归。

      回退那条路就是复用之前的行为：自己分一个远端端口、ssh 自己带 `-R`。
      少了复用的好处（少握手、少端口），但功能是全的 —— 而那正是取舍该有的样子。
    */
    let remotePort: number;
    if (muxSupported()) {
      remotePort = (await sshMux.ensure(remote)).remotePort;
    } else {
      /* 按会话分端口：把**自己当前那个**也算进"已占用"，避免"先起新的再关旧的"时撞上自己 */
      /*
        **还活着的 ssh 占着的端口也算** —— 实测：两条会话前后两秒各切到 Claude Code，第一条把自己那格
        从 39101 改成 39102（表里 39101 就"空"了），可它旧的 ssh 要等新的连上才关、还占着 39101；
        第二条于是又分到 39101，`ExitOnForwardFailure=yes` 让它的 ssh 当场退出 →「连不上远程」。
      */
      const used = [
        ...[...localToolsBySession.values()].map((v) => v.remotePort),
        ...[...sessionClients.values()].map((e) => e.client.forwardedRemotePort).filter((p): p is number => typeof p === 'number'),
      ];
      remotePort = allocateRemotePort(used);
      if (!muxWarned) {
        muxWarned = true;
        logger.info('sshmux', `这个平台（${process.platform}）的 ssh 不支持连接复用 ——`
          + `每条远程会话各用一条 ssh 和一个远端端口（功能一样，只是少了复用的好处）`);
      }
    }
    localToolsBySession.set(sessionId, { remotePort, localPort: server.port(), agentOverride });
    /*
      **远端那个草稿目录要先建出来** —— 实测：`sessionCwd` 给的是
      `<workdir>/scratch/<id>`，而镜像去掉之后**没有任何东西再去创建它**（以前是 rsync 顺手建的）。
      于是 `session/new` 的 cwd 指向一个不存在的目录：kiro-cli 起来了，但那一轮里它的 shell
      工具 pwd 落在 `/tmp`，而模型看到"说好的目录不存在"就开始怀疑整套接线。
    */
    await writeRemoteFile(remote, `mkdir -p ${shellQuote(sessionCwd(profile, localDir))}`, '');
    /*
      **那条会话专用的 agent 在远端拼**：有同名的就拿远端那一份做底子，没有就用默认
      （见 `remoteAgentScript`）。退到默认时**必须说出来** —— 悄悄换一个 agent 是这条路上
      最贵的静默失败：产出是另一个 agent 干的，而界面一个字都不会说。
    */
    /*
      **本机那些 MCP 转发过去** ——「那操作本地的 playwright 和 compute use 呢」。
      判据在 `forwardMcp`：命令是本机路径的（远端必然起不来、而且是静默少工具），
      以及按名字就该在本机跑的（`playwright` —— 远端那台没有你在看的那个浏览器）。
    */
    /*
      **Claude Code / Codex：同一条隧道，换一种交法** —— 它们没有 kiro 的 agent 文件，
      ACP 本身就有 `mcpServers`（两个适配器都声明了 `mcpCapabilities.http`）。所以不往远端写
      agent JSON，直接把那个带 token 的 URL 作为一个 http MCP 交给 session/new / load。
    */
    if (engineOf(profile) !== 'kiro') {
      const mcp = { type: 'http', name: 'kirolex-local', url: mcpUrl(remotePort, urlPath), headers: [] };
      const spec = { remotePort, localPort: server.port(), agentOverride, forwarded: [] as string[], mcpServers: [mcp] };
      localToolsBySession.set(sessionId, spec);
      toollessSessions.delete(sessionId);
      logger.info('localmcp', `本地工具已备好（${ENGINE_LABEL[engineOf(profile)]}，走 mcpServers）sessionId=${sessionId} 远端端口=${remotePort} workdir=${localDir}`);
      return spec;
    }
    const forwardable = profile.kiroAgent ? forwardableFrom(localAgentJson(profile.kiroAgent)) : [];
    server.setProxies(sessionId, forwardable);
    const forwarded = forwardable.map((f) => ({ name: f.name, url: `${mcpUrl(remotePort, urlPath)}/${f.name}` }));
    const agentOut = await runRemoteCapture(remote,
      remoteAgentScript(agentOverride, profile.kiroAgent, mcpUrl(remotePort, urlPath), forwarded));
    if (forwarded.length) {
      logger.info('localmcp', `转发本机 MCP 给 sessionId=${sessionId}：${forwarded.map((f) => f.name).join(', ')}`);
    }
    const usedBase = parseAgentBase(agentOut);
    if (profile.kiroAgent && usedBase === 'default') {
      sessionNotice(sessionId, `⚠️ ${remote.sshHost} 上没有 agent「${profile.kiroAgent}」，`
        + `这条会话用**默认 agent** + 你本机的工具。要它按那个 agent 跑，在那台机器上建一份同名配置。`);
      logger.warn('localmcp', `远端没有 agent ${profile.kiroAgent}，退到默认 sessionId=${sessionId}`);
    } else if (usedBase && usedBase !== 'default') {
      logger.info('localmcp', `远端用它自己的 agent「${usedBase}」做底子 sessionId=${sessionId}`);
    }
    const spec = {
      remotePort, localPort: server.port(), agentOverride,
      forwarded: forwarded.map((f) => f.name),
    };
    localToolsBySession.set(sessionId, spec);
    toollessSessions.delete(sessionId);
    logger.info('localmcp', `本地工具已备好 sessionId=${sessionId} 远端端口=${remotePort} 本地端口=${spec.localPort} workdir=${localDir}`);
    return spec;
  } catch (err: any) {
    /* 记下来：master 自愈回来之后要重接的就是这批（见 `rearmLocalToolsFor`） */
    toollessSessions.add(sessionId);
    sessionNotice(sessionId, `⚠️ 本地工具通道没起来：${err?.message || err}。`
      + `这条远程会话读不到你机器上的文件 —— 先别让它改东西。`
      + `连接恢复后会自动重接这条会话。`);
    logger.warn('localmcp', `准备失败 sessionId=${sessionId}: ${err?.message || err}`);
    return undefined;
  }
}

/**
 * **开机扫一遍远端留下的会话 agent** ——「清理远程 agent 你清了没有」。
 *
 * 一台机器扫一次，失败只记日志：这是清垃圾，不该拦住任何会话。
 * 判据和阈值在 `sweepAgentsScript` 那段注释里（按"多久没动过"，不按"谁还活着"）。
 */
/**
 * **杀掉本机遗留的 ssh 客户端** —— 整条"打爆远程机器"的链条的**源头**就在这儿。
 *
 * 实测链条：KiroLex 被 `pkill` / 崩溃结束 → macOS 把它的 ssh 子进程**收养给 launchd**（不发 SIGHUP）
 * → 那些 ssh 还连着 → 远端的 sshd 和 `kiro-cli acp` 也就都还活着。所以远端那边查 PPID==1
 * 一个孤儿都看不到（它们的父进程好好地在），而进程却在不停累积 —— 之前一次清出 85 个就是这么来的。
 *
 * 判据是 **PPID == 1**：活着的 ssh 挂在某个 Electron 底下；被收养的才是上一条命留下的。
 * 再加上命令行里得有 KiroLex 的印记，这样不碰用户自己开的 ssh：
 *   · 执行器那些带 `kirolex-local-…`（我们拼的 agent 名）；
 *   · 复用连接那条（`ssh -N`）命令行里没有 agent 名，认的是 `ControlPath` 里的
 *     `kirolex-mux/` —— 漏掉它的话每次重启都留一条连着的 ssh，
 *     而那正是这段注释里那条累积链的第一环。
 *
 * ## 这一轮**不**按 owner 过滤（跟远端那一轮不一样）
 *
 * owner 是 `主机名 + 用户名` 的 hash，为的是"一台远端被好几台笔记本用"时别删别人的东西。
 * 但本机这一轮的 `ps` 里只有**这台 Mac 自己**的进程 —— 而同一台 Mac 上的两份 KiroLex
 * （standard 和 flow）主机名和用户名完全一样，owner 也就一样，按它过滤什么都分不出来。
 *
 * 真正分得清的是 PPID：别人那份**活着**的 ssh 挂在它自己的 Electron 底下，PPID 不是 1。
 * 而 PPID==1 的那些谁的父进程都没了 —— 它不属于任何人，只是还连着远端、还养着那边的执行器。
 *
 * 按 owner 过滤反而会漏：实测这次启动时留着 4 条 PPID==1 的 ssh，名字是**改 owner 之前**
 * 生成的 `kirolex-local-s_…`，于是一条都没被认出来 —— 而那台 EC2 当时正好又在报
 * `banner exchange` 超时。漏掉的代价就是那个。
 *
 * 杀本机这一端就够：远端那个 kiro-cli 失去 sshd 之后会被 reparent 到 1，
 * 下一次 `orphanSweepScript` 顺手收掉（或者它自己退出）。
 */
function sweepStrayLocalSsh(): void {
  /*
    **Windows 上 `ps` 和 PPID==1 两个都不成立** ——「看一下有没有 windows 上不能跑的东西」。

    没有 `ps`（execFileSync 直接 ENOENT，被下面的 catch 吞掉），而 Windows 也没有
    "孤儿 reparent 到 PID 1"这个约定 —— 所以这一轮在 Windows 上是彻底的 no-op,
    泄漏的 ssh 会一直累积。而这**正是压死那台 EC2 的那条链的第一环**：
    本机 ssh 还连着 → 远端 sshd 和 kiro-cli 也就都还活着 → 越堆越多。

    Windows 上换成 `wmic` 的等价查询（pid / 父 pid / 完整命令行），判据从 "PPID==1"
    换成 "**父进程已经不在了**"——那是同一个意思的可移植说法：
    Unix 上父进程死了会 reparent 到 1，Windows 上 pid 直接变成一个不存在的进程。
    （Unix 上不改判据：PPID==1 更便宜，而且那条路是实测过的。）
  */
  if (process.platform === 'win32') { sweepStrayLocalSshWindows(); return; }
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const victims: number[] = [];
    for (const line of out.split('\n')) {
      if (!line.includes(SESSION_AGENT_PREFIX) && !line.includes(`${MUX_DIR}/`)) continue;
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      if (Number(m[2]) !== 1) continue;             // 挂在当前 app 底下的是活的
      if (!/(^|\/)ssh\s/.test(m[3])) continue;       // 只杀 ssh 客户端
      victims.push(Number(m[1]));
    }
    for (const pid of victims) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* 已经走了 */ }
    }
    if (victims.length) {
      logger.warn('remote', `杀掉 ${victims.length} 个上一次留下的 ssh 客户端（pid ${victims.join(', ')}）——`
        + `它们被 launchd 收养之后还连着远端，远端那些执行器也就一直活着`);
    }
  } catch (err: any) {
    logger.info('remote', `扫本机遗留 ssh 没成功（${err?.message || err}）—— 只是清垃圾，不影响会话`);
  }
}

/**
 * Windows 版的"杀掉遗留的 ssh 客户端"。
 *
 * `ps` 不存在，所以用 PowerShell 的 CIM 查询拿 `ProcessId` / `ParentProcessId` /
 * `CommandLine` —— `wmic` 在新版 Windows 上已经被标记淘汰了，`Get-CimInstance` 是替代。
 *
 * 判据和 Unix 那边是**同一个意思**，只是换了说法：Unix 上父进程死了会 reparent 到 PID 1,
 * 所以 `PPID==1` 就是"没人管了"；Windows 上 pid 不会被重新挂，父 pid 只是指向一个
 * 已经不存在的进程 —— 所以判据是"**父进程不在活着的 pid 集合里**"。
 *
 * 同样要带 KiroLex 的印记（agent 名或 `kirolex-mux/`），这样不碰用户自己开的 ssh。
 */
function sweepStrayLocalSshWindows(): void {
  try {
    const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'ssh.exe\'" | '
      + 'ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    const rows: Array<{ pid: number; ppid: number; cmd: string }> = [];
    for (const line of String(out).split(/\r?\n/)) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
      rows.push({ pid, ppid, cmd: parts.slice(2).join('\t') });
    }
    /* 所有活着的 ssh.exe 的 pid —— 用来判断"父进程还在不在"。父进程可能不是 ssh，
       所以这里只能判断"父 pid 不在我们看到的任何进程里"时才算孤儿，于是再查一次全量 pid。 */
    const alive = new Set<number>();
    try {
      const all = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId }'], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      });
      for (const l of String(all).split(/\r?\n/)) {
        const n = Number(l.trim());
        if (Number.isFinite(n)) alive.add(n);
      }
    } catch { return; }              // 拿不到全量 pid 就**什么都不杀** —— 宁可漏，不可错杀

    const victims: number[] = [];
    for (const r of rows) {
      if (!r.cmd.includes(SESSION_AGENT_PREFIX) && !r.cmd.includes(`${MUX_DIR}/`)) continue;
      if (alive.has(r.ppid)) continue;              // 父进程还在 → 这条是活的
      victims.push(r.pid);
    }
    for (const pid of victims) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* 已经走了 */ }
    }
    if (victims.length) {
      logger.warn('remote', `杀掉 ${victims.length} 个上一次留下的 ssh 客户端（pid ${victims.join(', ')}）——`
        + `它们的父进程已经没了，但还连着远端，远端那些执行器也就一直活着`);
    }
  } catch (err: any) {
    logger.info('remote', `扫本机遗留 ssh 没成功（${err?.message || err}）—— 只是清垃圾，不影响会话`);
  }
}

async function sweepRemoteSessionAgents(): Promise<void> {
  /* 先杀本机这一端：远端那些失去 sshd 之后才会变成 PPID==1，下面那一轮才认得出来 */
  sweepStrayLocalSsh();
  for (const target of listRemoteTargets(KIROLEX_CONFIG_PATH)) {
    if (!target.sshHost) continue;
    try {
      const out = await runRemoteCapture(target, sweepAgentsScript(OWNER));
      const n = Number(String(out).trim().split(/\s+/).pop());
      if (n > 0) logger.info('localmcp', `${target.sshHost}: 扫掉 ${n} 个上次留下的会话 agent（超过 ${STALE_AGENT_MINUTES / 60} 小时没动过）`);
      /*
        **孤儿进程也要扫** ——「为什么会打爆远程机器」。agent 文件只是垃圾，孤儿**进程**是病因：
        实测那台 t3.medium 被它们扫盘扫到 CPU 100%、`VolumeReadOps` 46,240/小时、网络归零，
        最后 sshd 和 SSM 都饿死，只能从 EC2 API 强制 stop/start 救回来。
        判据是 PPID==1（见 `orphanSweepScript`）—— 在真机上验过：活着的 12 个 PPID 全不是 1。
      */
      await sweepRemoteExecutors(target, '启动');
    } catch (err: any) {
      logger.info('localmcp', `${target.sshHost}: 扫会话 agent 没成功（${err?.message || err}）—— 只是清垃圾，不影响会话`);
    }
  }
}


/**
 * 这台机器上**我此刻持有**的执行器 —— 第二道清理的保留名单（见 `staleExecutorSweepScript`）。
 *
 * 有 `remotePid` 的按 pid 留；还没拿到 pid 的（刚 spawn）、正在 attach / 换模型的，按会话整条跳过。
 * 宁可多留：漏留一条的代价是把一条正在用的会话杀掉，多留一条的代价是晚一轮再清。
 */
function heldExecutorsOn(target: RemoteTarget): { pids: number[]; sessions: string[] } {
  const pids: number[] = [];
  const sessions = new Set<string>([...attachingSessions, ...reconfiguringSessions, ...attachInFlight.keys()]);
  for (const [sessionId, entry] of sessionClients) {
    const r = entry.profile.remote;
    if (!r?.sshHost || r.sshHost !== target.sshHost || (r.sshPort || 22) !== (target.sshPort || 22)) continue;
    const pid = (entry.client as any).remotePid as number | undefined;
    if (pid) pids.push(pid); else sessions.add(sessionId);
  }
  return { pids, sessions: [...sessions] };
}

/**
 * **远端执行器两道清理** ——「你应该让 kirolex 去清理和检查远端孤儿」。
 *
 *   1. PPID==1（`orphanSweepScript`）：本机 ssh 死了、远端 sshd 也跟着走了的那种；
 *   2. 带我标签但**我没持有**（`staleExecutorSweepScript`）：本机那头死了、远端 sshd 没察觉的那种
 *      —— 实测挂了 7.5 小时、14 个进程，第 1 道一个都认不出来。
 *
 * 原来只在启动时跑一次，所以一次网络抖动留下的垃圾要等到下次重启才清。现在三个时机：
 * 启动、每 `REMOTE_SWEEP_MS` 一轮（只对**正有会话**的机器）、以及复用连接重连回来的那一刻
 * （死连接留下的旧进程正是在那时候变成"没人持有"）。
 */
async function sweepRemoteExecutors(target: RemoteTarget, why: string): Promise<void> {
  try {
    const orphans = parseOrphanSweep(await runRemoteCapture(target, orphanSweepScript(OWNER)));
    if (orphans > 0) {
      logger.warn('localmcp', `${target.sshHost}: 杀掉 ${orphans} 个孤儿执行器进程（父进程已没了，${why}）`);
    }
    const stale = parseStaleSweep(await runRemoteCapture(target, staleExecutorSweepScript(OWNER, heldExecutorsOn(target))));
    if (stale > 0) {
      logger.warn('localmcp', `${target.sshHost}: 杀掉 ${stale} 个没人持有的执行器（带本机标签但不是这个 KiroLex 正连着的，${why}）`);
    }
  } catch (err: any) {
    logger.info('localmcp', `${target.sshHost}: 远端执行器清理没成功（${err?.message || err}）—— 只是清垃圾，不影响会话`);
  }
}

/** 定期清理的间隔。10 分钟：死连接在 sshd 那边最多挂 2 分钟（ClientAlive），这一轮是兜底。 */
const REMOTE_SWEEP_MS = 10 * 60_000;
setInterval(() => {
  for (const target of listRemoteTargets(KIROLEX_CONFIG_PATH)) {
    /* 只扫正在用的机器：没会话的那台可能已经关了，定时去敲门只会攒一堆超时 */
    if (target.sshHost && hasSessionOn(target)) void sweepRemoteExecutors(target, '定时');
  }
}, REMOTE_SWEEP_MS).unref?.();

/** 会话的执行器没了：作废 token、放开端口、把远端那份临时 agent 删掉。 */
function releaseLocalTools(sessionId: string, remote?: RemoteTarget): void {
  const spec = localToolsBySession.get(sessionId);
  localToolsBySession.delete(sessionId);
  localMcpServer?.forget(sessionId);
  if (spec && remote?.sshHost) {
    /* 不等结果：收尾动作卡住会让"换模型"看起来像界面挂了 */
    void writeRemoteFile(remote, removeAgentScript(spec.agentOverride), '').catch(() => {});
    /*
      **最后一条会话走了才关那条复用连接** —— 它是这台机器上所有会话共用的，
      跟着任意一条会话退出就会把别人的工具通道一起带走。

      注意这个删除动作要在**上面那句 writeRemoteFile 之后**判断：那句还要用这条连接。
      它是 fire-and-forget 的，所以连接在它发出去之后才关 —— 关早了的表现是
      远端那份临时 agent 删不掉，也就是我们刚修好的那种垃圾。
    */
    if (!hasSessionOn(remote)) {
      /*
        **等一下再关** —— 上面那句 `writeRemoteFile` 是 fire-and-forget 的，而它走的正是
        这条连接。关早了的表现是远端那份临时 agent 删不掉，也就是我们刚修好的那种垃圾。

        到点再确认一次：这几秒里完全可能又在这台机器上开了一条会话。
      */
      setTimeout(() => {
        if (hasSessionOn(remote)) return;
        const key = muxKey(remote.sshHost, remote.sshPort);
        if (!sshMux.liveSocketFor(remote)) return;
        logger.info('sshmux', `${key} 上已经没有会话了，关掉那条复用连接`);
        sshMux.close(key);
      }, 5_000);
    }
  }
}

/**
 * 这台机器上还有别的远程会话吗（那条复用连接该不该留着）。
 *
 * 判据取**活着的执行器**（`sessionClients`）而不是记录：记录里那些"配了远端但没连上"的会话
 * 没有占用连接，把它们算进来的话这条连接永远关不掉 —— 而它是一条开着的 ssh。
 */
function hasSessionOn(remote: RemoteTarget): boolean {
  for (const entry of sessionClients.values()) {
    const r = entry.profile.remote;
    if (r?.sshHost === remote.sshHost && (r?.sshPort || 22) === (remote.sshPort || 22)) return true;
  }
  return false;
}

/**
 * 跑一段探测脚本。`machine` 是 `local` 或配置里的 target id。
 *
 * 两条路**共用同一段脚本**（见 `binDetect`）：本机 `bash -lc`，远端 ssh + `bash -lc`。
 * 脚本走 `-c` 而不是 stdin：探测脚本自己会 `< /dev/null` 掉每个被测命令的 stdin，
 * 而用 `bash -s` 把脚本喂进 stdin 的话，第一个读 stdin 的命令就会把剩下的脚本吞掉
 * （实测踩过：那次 `claude-code-acp --version` 吃掉了自检部分，然后整段"成功"退出）。
 */
/**
 * 跑一次 `<cmd> --version` 并把第一行带回来 —— 给 `detectWindows` 用。
 *
 * `execFile` 不走 shell：命令是一个**绝对路径**（`detectWindows` 已经在 PATH 上解析过了），
 * 走 shell 只会引入引号问题（cmd.exe 不认 POSIX 单引号）。
 * `.cmd` / `.bat` 是例外 —— 那些 Windows 上必须由 cmd.exe 解释，所以单独给 `shell: true`。
 */
function probeOneLocal(cmd: string, arg: string): Promise<{ ok: boolean; first: string }> {
  /* npm 装的工具在 Windows 上是 `.cmd` shim，`execFile` 直接执行不了 */
  const needsShell = /\.(cmd|bat)$/i.test(cmd);
  return new Promise((resolve) => {
    execFile(needsShell ? `"${cmd}"` : cmd, [arg], {
      timeout: PROBE_TIMEOUT_SEC * 1000,
      encoding: 'utf8',
      shell: needsShell,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const first = String(stdout || stderr || '').split(/\r?\n/)[0]?.trim() || '';
      resolve({ ok: !err, first: first || (err ? String(err.message) : '') });
    });
  });
}

function runProbe(machine: string, script: string): Promise<string> {
  const timeout = 120_000;
  if (!machine || machine === 'local') {
    return new Promise((resolve, reject) => {
      execFile('bash', ['-lc', script], { timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          /* 探测脚本自己**不会**非零退出（`set +e` + 每个分支都 echo），所以非零 = 真的跑不了 */
          if (err && !String(stdout || '').includes('KX_BIN')) reject(new Error(String(stderr || err.message).split('\n')[0]));
          else resolve(String(stdout || ''));
        });
    });
  }
  const target = findRemoteTarget(KIROLEX_CONFIG_PATH, machine);
  if (!target?.sshHost) return Promise.reject(new Error(`找不到这台机器（${machine}）—— 设置里删掉了？`));
  return new Promise((resolve, reject) => {
    execFile('ssh', [...buildSshArgs(target, `bash -lc ${shellQuote(script)}`)],
      { timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: sshEnv(target) }, (err, stdout, stderr) => {
        if (err && !String(stdout || '').includes('KX_BIN')) {
          /* SSH 的后量子告警每次都在，不是原因 —— 认它会让每次失败都指错（踩过） */
          const real = String(stderr || err.message).split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !/post-quantum|store now, decrypt later|openssh\.com|^\*\*/.test(l))[0];
          reject(new Error(real || `ssh 退出码 ${(err as any).code}`));
        } else resolve(String(stdout || ''));
      });
  });
}

/** 在远端跑一条命令并**拿回 stdout**（`writeRemoteFile` 丢掉输出）。 */
function runRemoteCapture(remote: RemoteTarget, script: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ssh', [...buildSshArgs(remote, `bash -lc ${shellQuote(script)}`)],
      /* 默认 60 秒够所有探测用；`kiro-cli update` 要下一个几十 MB 的二进制，调用方会放宽 */
      { timeout: timeoutMs, encoding: 'utf8', env: sshEnv(remote) },
      (err, stdout, stderr) => {
        if (err && !String(stdout || '')) {
          /* SSH 的后量子告警每次都在，不是原因 —— 认它会让每次失败都指错（踩过） */
          const real = String(stderr || err.message).split('\n').map((l) => l.trim())
            .filter((l) => l && !/post-quantum|store now, decrypt later|openssh\.com|^\*\*/.test(l))[0];
          reject(new Error(real || String(err.message)));
        } else resolve(String(stdout || ''));
      });
  });
}

/** 在远端跑一条 shell 命令，内容从 stdin 送进去（JSON 走命令行是引号地狱）。 */
function writeRemoteFile(remote: RemoteTarget, script: string, stdin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [...buildSshArgs(remote, `bash -lc ${shellQuote(script)}`)];
    const child = execFile('ssh', args, { timeout: 60_000, env: sshEnv(remote) }, (err) => (err ? reject(err) : resolve()));
    try { child.stdin?.end(stdin); } catch { /* 命令已经退了 */ }
  });
}





/**
 * **执行远程会话要求的本地动作** ——「那个本地工具调用的问题你能不能想想办法」。
 *
 * 唯一的动作是"在**你的**浏览器里打开一个 http(s) 地址"（边界和理由都在 `localAction.ts`）。
 * 这里只负责三件事：按整行喂给解析器、守住额度、以及**每次都说出来** ——
 * 你的机器上凭空弹出一个窗口，必须能对上是谁要求的。
 */
function runLocalActions(sessionId: string, entry: SessionEntry, chunk: string): void {
  if (!chunk) return;
  /* 整行才解析：半行可能把一个 URL 截成另一个仍然合法的地址 */
  const buf = `${entry.localLineBuf || ''}${chunk}`;
  const lines = buf.split('\n');
  entry.localLineBuf = lines.pop() || '';
  for (const line of lines) {
    if (!line.includes(LOCAL_MARKER)) continue;
    const { actions, rejected } = parseLocalActions(line);
    for (const r of rejected) {
      sessionNotice(sessionId, `⚠️ 它想让你这台机器做一件我不认的事：\`${r.raw.slice(0, 120)}\` —— ${r.why}。`);
    }
    for (const a of actions) {
      if (entry.openedLocally?.has(a.target)) continue;   // 同一个地址一条会话只开一次
      if ((entry.localActionsThisTurn || 0) >= MAX_LOCAL_ACTIONS_PER_TURN) {
        sessionNotice(sessionId, `⚠️ 这一轮它已经要求打开 ${MAX_LOCAL_ACTIONS_PER_TURN} 个页面了，`
          + `剩下的没开（\`${a.target}\`）—— 链接就在上面，需要的话点它。`);
        return;
      }
      /*
        **调用点再检一次 scheme** —— 后台安全审查提的那条（模型可控的 `openExternal`）。
        `parseLocalActions` 已经只放 http(s) 过（见 `localAction.ts`），这是**第二道**：
        两处离得远，将来有人放宽解析器、或者多一条别的路往这里送 action，就会静默变成
        "任意 scheme 交给 macOS 的应用启动器" —— 而那一类错是不可逆的。

        **没有**加"屏蔽 localhost / 私网"和每次弹窗：这条通道能做的事（让你的浏览器打开一个地址）
        严格弱于同一条会话已经拿到的 `local_bash`（用户明确选的，能在他机器上跑任何命令）。
        有 shell 的前提下给 URL 加网段牢笼，正是设计文档里「不做安全剧场」那条要防的；
        而 `http://localhost:3000` 恰好是主要用例 —— agent 在**用户机器上**起了 dev server 让他看。
      */
      const scheme = (() => { try { return new URL(a.target).protocol; } catch { return ''; } })();
      if (scheme !== 'http:' && scheme !== 'https:') {
        noteInSession(sessionId, `⚠️ 拒绝在本机打开 \`${String(a.target).slice(0, 120)}\` —— 只允许 http/https。`);
        logger.warn('localaction', `拒绝非 http(s) 目标 sessionId=${sessionId} scheme=${scheme || '(解析不了)'}`);
        continue;
      }
      entry.localActionsThisTurn = (entry.localActionsThisTurn || 0) + 1;
      (entry.openedLocally ||= new Set()).add(a.target);
      const host = labelForHost(KIROLEX_CONFIG_PATH, entry.profile.remote?.sshHost) || '远端';
      void shell.openExternal(a.target).then(
        () => sessionNotice(sessionId, `🌐 已在**你的**浏览器里打开 \`${a.target}\`（${host} 上的它要求的）。`),
        (err: any) => sessionNotice(sessionId, `⚠️ 它要求打开 \`${a.target}\`，但没打开：${err?.message || err}`),
      );
      logger.info('remote', `本地动作 open ${a.target} sessionId=${sessionId}`);
    }
  }
}

/**
 * 这条会话要注入的「运行环境：远程」说明（本地会话返回空串）。
 *
 * 路径两边都给：远端那份是 `entry.cwd`（就是镜像），本地那份是 `entry.localDir`。
 * 它们本来就是同一个项目的两个名字，而模型只有被明确告知才会做这个换算。
 */
function remoteContextFor(sessionId: string, entry: SessionEntry): string {
  const remote = entry.profile.remote;
  if (!remote?.sshHost) return '';
  const workdir = resolveRemoteWorkdir(remote.remoteWorkdir, remote.sshHost);
  return remoteContextBlock({
    hostLabel: labelForHost(KIROLEX_CONFIG_PATH, remote.sshHost) || remote.sshHost,
    remoteDir: entry.cwd,
    /* `local_*` 真正的工作目录（会话的 files/）；项目目录另外说（`projectDir`） */
    localDir: localProjectDirOf(sessionId, entry),
    filesDir: sessionFilesDir(sessionId),
    projectDir: projectWorkspaceFor(entry.profile),
    movedFrom: previousFilesDirs(sessionId),
    /*
      **他那边到底有没有工程** ——「我让它找一个纯远程的项目但它总是在本地找」。

      判据**不能只看 `entry.localDir` 有没有值** —— 这是上一版的错，实测撞到了：
      那条没归项目的远程会话记录里 `localDir` 就是
      `~/.kirolex/sessions/<id>`（会话草稿目录本身被持久化进去了），
      于是 `!!entry.localDir` 是 true，注入里那套"他的仓库和工具链在他机器上、
      构建测试用 local_bash"照样发了出去 —— 而那条会话根本没有本地工程。

      所以要**排除草稿目录**：它是 KiroLex 自己存 record / transcript / history 的地方，
      不是任何人的工程。

      主进程这边**不用**渲染层那个按形状匹配的 `isSessionScratchDir`：它知道确切路径,
      所以直接和 `getSessionDir(sessionId)` 比 —— 精确判断比正则可靠
      （而且省掉一份会慢慢长歪的重复实现）。
    */
    hasLocalProject: !!projectWorkspaceFor(entry.profile),
    /* 从本机转发过去的那些（`playwright`…）—— 它们作用在用户机器上，这件事必须说 */
    forwarded: localToolsBySession.get(sessionId)?.forwarded,
  });
}


/**
 * **项目 id 不能从会话目录推出来** ——「为什么还是移动不了」。
 *
 * 一条没归项目的远程会话，镜像根是它自己的会话目录（`~/.kirolex/sessions/<id>/`）。
 * 而 `deriveProjectId` 取的是目录名 —— 于是它推出来的"项目"就是**会话 id 本身**：
 * 实测侧栏里真的出现了一个叫 `s_1790128678028_da1rhi` 的分组，那条会话每次 attach 都被塞回去，
 * 你把它移到别处、下次连上又回来，表现就是"怎么移都移不动"。
 *
 * `~/.kirolex` 下的任何目录都不是项目：那是 KiroLex 自己的数据目录。
 */
function derivedProjectFor(sessionId: string, dir: string): string | undefined {
  const d = String(dir || '');
  if (!d || d === os.homedir()) return undefined;
  if (d === getSessionDir(sessionId) || d.startsWith(path.join(os.homedir(), '.kirolex'))) return undefined;
  return deriveProjectId(d);
}

/**
 * **"没有项目目录"的统一说法** ——「现在显示不能把家目录推到远程服务器」。
 *
 * 空字符串和家目录是**同一件事**：都表示"这条会话没有项目目录"。家目录之所以会出现，
 * 是因为渲染层 attach 时三处都硬写 `'~'`（见 `SessionRecord.localDir`），它从来不是一个真实选择。
 *
 * 上一版把这两种情况分开处理（空 → 用会话目录；家目录 → 报错"不能把家目录推到远端"），
 * 于是从老会话切到远端时就撞上那句拒绝 —— 而人根本没选过家目录。统一到这里：
 * 两种都退回**会话目录**（本地那条路的 cwd 本来就是它）。
 */
function localDirOrSessionDir(sessionId: string, _candidate?: string): string {
  /*
    **不看传进来的目录** ——「这个 folder 通常不是 code repo，而是一些中间产物或生成物。code repo 一般会在
    其他 folder。我认为这个 folder 完全不应该动」：换项目、进出未分组、换机器，这条会话的文件夹都不变。
    项目设了工作目录的，那个目录作为"项目在哪"告诉模型（见 `workdirNoteFor`），不再拿来当 cwd。
  */
  return sessionFilesDir(sessionId);
}

/** 项目设的工作目录（「设置工作目录」）—— 没归项目 / 没设就是空。 */
function projectWorkspaceFor(profile: AgentProfile): string {
  const project = String(profile.projectId || '').trim();
  if (!project) return '';
  try { return String(projectStore.readProject(os.homedir(), project).workspace || '').trim(); } catch { return ''; }
}

/**
 * 每一轮告诉模型"文件放哪、项目在哪"。cwd 固定是会话的 files/ 之后，项目目录只能靠这一句让它知道 ——
 * 不说的话它会在 files/ 里找项目代码，然后把"没找到"当成"没有"。远程会话这件事由 `remoteContextFor` 说。
 */
function workdirNoteFor(sessionId: string, entry: SessionEntry): string {
  if (entry.profile.remote?.sshHost) return '';
  const files = sessionFilesDir(sessionId);
  const ws = projectWorkspaceFor(entry.profile);
  return [
    `[文件位置] 当前目录是这条会话自己的文件夹 \`${files}\`：中间产物、生成的文件默认放这里`
      + '（它跟着这条会话一起备份、恢复、删除）。',
    ws ? `这个项目的目录在 \`${ws}\` —— 要读写项目里的东西，用这个绝对路径。` : '',
    movedFilesNote(previousFilesDirs(sessionId)),
  ].filter(Boolean).join('');
}

/**
 * **这条会话的 files/ 以前在哪些路径上**（不含现在这个）——「如果 chat 被恢复到了另一个机器路径变了怎么办」。
 *
 * 现在的路径每次按这台机器现算，永远对；会错的是对话历史和 memory 里写死的旧路径（"存到了
 * `C:\Users\…\files\out.csv`"），恢复到 Mac 上之后模型会照着历史去那儿找。所以每次都对一遍：
 * 现在的路径不在记录里就记上；以前记过的别的路径原样返回，由调用方告诉模型"那就是这个文件夹"。
 * 合并两份备份时这张表取并集（`mergeRecords`），两台机器各自用过的都在。
 */
function previousFilesDirs(sessionId: string): string[] {
  const current = sessionFilesDir(sessionId);
  const same = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
  const rec = store.readRecord(sessionId);
  if (!rec) return [];
  const seen = Array.isArray(rec.filesDirs) ? rec.filesDirs.filter((d) => typeof d === 'string' && d) : [];
  if (!seen.some((d) => same(d, current))) {
    rec.filesDirs = [...seen, current];
    store.writeRecord(rec);
    if (seen.length) logger.info('session', `files/ 路径变了 sessionId=${sessionId}：${seen.join(' | ')} -> ${current}`);
  }
  return seen.filter((d) => !same(d, current));
}

function movedFilesNote(previous: string[]): string {
  if (!previous.length) return '';
  return ` 注意：这条会话是从别处恢复/搬过来的，对话历史和 memory 里出现的 ${previous.map((d) => `\`${d}\``).join('、')}`
    + ' 就是这个文件夹以前的路径 —— 那些文件现在都在上面这个新路径下，按新路径找，别去旧路径。';
}

/**
 * **会话生成的文件默认放在会话自己的目录里** ——「当前会话生成的文件应该默认在会话目录下的一个单独文件夹」+
 * 「这样这个文件夹也可以和会话的内容一起被同步、恢复、或者删除」。
 *
 * `~/.kirolex/sessions/<id>/files/`：和 record / transcript 同一个目录（删会话、进回收站、备份、恢复都是
 * 按这个目录走的），但单独一层 —— 不然模型写的文件和 KiroLex 自己的 record.json 混在一起。
 * 以前本地会话默认是共用的 `~/kirolex`（所有会话的文件堆在一起，删会话也不跟着走），
 * 远程会话的本地工具直接写进会话目录本身。
 */
function sessionFilesDir(sessionId: string): string {
  const dir = path.join(getSessionDir(sessionId), SESSION_FILES_DIR);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 建不了就让执行器自己报 cwd 不存在 */ }
  return dir;
}

/** 这条会话在**本地**的工作目录 —— 固定是它的 files/（见 `localDirOrSessionDir`）。 */
function localProjectDirOf(sessionId: string, _entry: { localDir?: string; cwd: string; profile: AgentProfile }): string {
  return sessionFilesDir(sessionId);
}

/**
 * 起远程执行器之前问清三件事（工具、登录、连通）。
 *
 * 不问的代价不是"少一条提示"：没装 rsync → 推送失败 → 界面上是"这一轮没发出去"；
 * 远端没登录 → 执行器起得来但每一轮都空回 —— 看起来就是那个查了一整天的 `EmptyResponse`。
 */
const reachability = new Breaker();

/**
 * **这台机器的 KiroLex 的身份** ——「你需要确保 kirolex 只管理自己创建的 session」。
 *
 * 一台远端机器可以同时被好几台笔记本上的 KiroLex 用，而清理的判据原来只看 `kirolex-local-`
 * 这个**所有** KiroLex 共用的前缀 —— 那意味着 agent 文件那一轮（按"12 小时没动过"删）可能删掉
 * 另一台笔记本上**还活着**的那条会话的配置，孤儿进程那一轮也会去动别人家的进程。
 *
 * 算一次、全程用它：会话 agent 的名字、两个清理脚本的过滤器都带上它。
 */
const OWNER = ownerTag(os.hostname(), os.userInfo().username);
const OWNED_AGENT_PREFIX = ownedAgentPrefix(OWNER);

/**
 * **一台机器一条 ssh、一个反向隧道** ——「你应该加的是垃圾清理和重复利用」的后半截。
 *
 * 远端端口不再属于任何一条会话（见 `sshMux.ts` 开头）：它唯一的工作是"能连到本机那个 MCP
 * server"，而"你是哪条会话"靠 URL 里的 token 区分 —— 所以一个端口 + N 个 token 就够。
 *
 * `usedRemotePorts` 收的是**已经建起来的那些机器**的端口：两台远端机器各要一条隧道，
 * 它们的远端端口互不相干（各自的 127.0.0.1），沿用 `allocateRemotePort` 只是让日志里
 * 一眼能分清哪条隧道是哪台机器的。
 */
const sshMux: SshMux = new SshMux({
  log: (level, message) => logger[level]('sshmux', message),
  localPort: () => localMcpServer?.port() || 0,
  usedRemotePorts: (): number[] => sshMux.keys()
    .map((k: string) => sshMux.remotePortFor(k))
    .filter((port): port is number => typeof port === 'number'),
  allocateRemotePort,
  owner: OWNER,
  /*
    **自愈的判据：这台机器上还有连着的会话吗** —— 见 `sshMux.scheduleHeal`。
    没有会话就别敲门（机器可能已经关了），有会话就一直试 —— 那几条会话正指着它。
  */
  hasSessions: (key: string): boolean => {
    for (const entry of sessionClients.values()) {
      const r = entry.profile.remote;
      if (r?.sshHost && muxKey(r.sshHost, r.sshPort) === key) return true;
    }
    return false;
  },
  /*
    master 回来之后，把那台机器上**连着但没有工具**的会话重新备一次。

    光有 master 不够：这些执行器是在 `localTools` 为 undefined 时起的（见
    `ensureLocalTools` 的 catch），它们那条 kiro-cli 根本没被配上本地 MCP，
    端口回来了也用不上 —— 实测就是这个状态：执行器活着、`local_*` 全是死的。
  */
  onReady: (key: string) => {
    void rearmLocalToolsFor(key);
    /* 连接刚断过：死连接下面那批执行器现在没人持有了，顺手收掉 */
    const target = listRemoteTargets(KIROLEX_CONFIG_PATH).find((t) => t.sshHost && muxKey(t.sshHost, t.sshPort) === key);
    if (target) setTimeout(() => { void sweepRemoteExecutors(target, '连接恢复后'); }, 30_000).unref?.();
  },
});

/**
 * 把某台机器上「连着但没有本地工具」的会话重新接一次。
 *
 * **为什么是重新 attach 而不是只补一个 MCP**：本地工具是在**起执行器**时接进去的
 * （agent JSON 里写着 URL + token，而那份 JSON 是启动参数的一部分）。所以一条在
 * `localTools === undefined` 下起来的会话，没有任何办法在不换进程的前提下补上工具。
 *
 * 一条一条来、而且带间隔：这台机器上可能有 7 条这样的会话，一口气全重连就是 7 次
 * ssh 握手砸向 sshd 的 `MaxStartups`（10:30:100）—— 那正是当初把那台 EC2 弄挂的成因。
 * 正在跑的那一轮不动：打断一轮正在产出的对话比晚几秒拿回工具更贵。
 */
async function rearmLocalToolsFor(key: string): Promise<void> {
  const victims: string[] = [];
  for (const [sessionId, entry] of sessionClients) {
    const r = entry.profile.remote;
    if (!r?.sshHost || muxKey(r.sshHost, r.sshPort) !== key) continue;
    if (!toollessSessions.has(sessionId)) continue;   // 它有工具，别碰
    if (entry.busy) continue;                         // 正在产出，别打断
    victims.push(sessionId);
  }
  if (!victims.length) return;
  logger.info('sshmux', `${key} 的连接回来了 —— ${victims.length} 条会话缺本地工具，逐条重接：${victims.join(' ')}`);
  for (const sessionId of victims) {
    try {
      sessionNotice(sessionId, '🔌 本地工具通道回来了，正在重接这条会话的执行器 —— 之后它就能读写你机器上的文件了。');
      detachExecutor(sessionId);
      toollessSessions.delete(sessionId);
      /* 不在这里主动起：下一次打开/发消息会按记录接上，而那条路本来就是对的 */
    } catch (err: any) {
      logger.warn('sshmux', `重接失败 sessionId=${sessionId}: ${err?.message || err}`);
    }
  }
}
/** 「这个平台不支持复用」只说一次 —— 每条会话都说一遍就是噪音。 */
let muxWarned = false;
/* 每条 ssh 都先问一句"这台机器有没有现成的连接" —— 有就当 channel 走，没有照旧建新的 */
setMuxSocketResolver((remote) => (remote?.sshHost ? sshMux.liveSocketFor(remote) : undefined));

/** 哪几台机器的规格已经报过了 —— 同一条信息不必每次 attach 都刷一遍。 */
const remoteSpecsLogged = new Set<string>();
/** 每台机器最近一次报的 kiro-cli 版本（preflight 顺路带回来的）。 */
const remoteKiroVersions = new Map<string, string>();
/** "落后了"这句话一台机器只说一次 —— 每条会话都说一遍等于把它变成噪音。 */
const remoteVersionWarned = new Set<string>();
/** 每台机器最近一次报过"内存快满"的时刻 —— 10 分钟内不重复说（每条会话 attach 都报就是噪音）。 */
const remoteMemWarned = new Map<string, number>();

/**
 * 本机 kiro-cli 的版本。问一次就缓存 —— 它在一次运行里不会变（真更新了也要重启 app）。
 */
let localKiroVersionCache: string | undefined;
async function localKiroVersion(): Promise<string | undefined> {
  if (localKiroVersionCache) return localKiroVersionCache;
  try {
    const out = await runKiroCli('--version', 15_000);
    const m = /(\d+\.\d+\.\d+)/.exec(String(out || ''));
    localKiroVersionCache = m ? m[1] : undefined;
  } catch { /* 问不到就不下"落后"的结论 */ }
  return localKiroVersionCache;
}

/**

/**
 * **退避重试 + 整机级熔断** ——「有重试机制吗」：原来没有，一次不成就抛。
 *
 * 判据和理由都在 `reachability.ts`。这里只把它接上：
 *   · 这台机器刚被判定连不上（熔断窗口内）→ 直接复用那个结论，**不再碰 sshd**；
 *   · 连接层面的失败退避重试（实测那种 `banner exchange` 超时常常是 `MaxStartups` 的滑动窗口，
 *     几秒内自愈）；结论确定的失败（密钥不对、没装 kiro-cli）**不重试** —— 那只是把同一句
 *     错误说三遍，还让人多等 4 秒。
 *
 * `force` 给"人点了重连"那条路：熔断挡的是启动时 20 条会话同时 attach 的瞬间并发，
 * 不是明确的人类意图。
 */
/**
 * **同一台机器同时只探一次** —— 熔断器挡不住的那半边。
 *
 * 熔断器是在**整段探测失败之后**才记的（下面那句 `reachability.fail`），而"整段"含
 * 3 次尝试、每次 30 秒超时。所以 7 条会话在同一毫秒进来时，谁都还没失败过，
 * `recentFailure` 对谁都是空的 —— 于是 **7 × 3 = 21 次**并发握手同时打出去。
 *
 * 实测就是这样：日志里 21 条一模一样的 `banner exchange` 超时，时间戳挤在一秒内。
 * 而 sshd 的 `MaxStartups` 默认 `10:30:100` 数的正是"连上了还没认证完"的连接，
 * 每个失败的尝试还会占着那个槽直到 `LoginGraceTime`（默认 120 秒）——
 * 也就是说**重试本身把队列撑满了**，然后所有人都超时，然后再重试。
 *
 * 所以在熔断器**前面**再加一层：这台机器已经有一次探测在路上，就等它的结论。
 * 连 `force` 也一起等 —— 手动点重连要的是"现在的答案"，而在路上那次正是现在的答案。
 */
const preflightInFlight = new Map<string, Promise<string[]>>();

/**
 * **本地会话在哪个目录里干活** ——「本机应该有工作目录这个功能，默认是用户目录下的 kirolex」。
 *
 * 项目设了工作目录的用那个目录；其余的（渲染层给的是家目录 / 什么都没给 / 老记录里存的会话目录或 `~/kirolex`）
 * 一律用**会话自己的 files/**（见 `sessionFilesDir`）—— 后来改的：「当前会话生成的文件应该默认在会话目录下的
 * 一个单独文件夹」。老会话第一次换过来时 Claude Code 那边按目录找不到原来的后端会话，会新起一条，
 * 上下文照常随下一条消息带过去（和换机器一样）。
 *
 * 新建和重连**都走这一个函数**：原来新建给的是每会话目录、重连给的是记录里的家目录，两次不是
 * 同一个地方。kiro 不在乎（它每次都重建上下文），但 Claude Code 是按目录存会话的 —— 重连换了目录
 * 就找不回原来那段对话。
 */
function localCwdFor(sessionId: string, dir?: string): string {
  /* 本地会话和远程会话的本地那一侧用同一条规则 */
  return localDirOrSessionDir(sessionId, dir);
}

/**
 * Claude Code / Codex 的远端检查：只问那台机器上**有没有适配器**。kiro 那套 preflight 查的是
 * kiro-cli、kiro 登录和 kiro 的模型清单，对另外两家全都不相干（而且会因为"没有 kiro-cli"误拒）。
 * 不在就说清楚怎么装 —— 否则失败会伪装成"ssh 断了"。
 */
async function remoteAdapterCheck(remote: RemoteTarget, engine: 'claude' | 'codex'): Promise<void> {
  const bin = REMOTE_ADAPTER_BIN[engine];
  let out = '';
  try {
    out = await runRemoteCapture(remote, `command -v ${bin} >/dev/null 2>&1 && echo KX_HAVE || echo KX_MISSING`, 30_000);
  } catch (err: any) {
    throw new Error(`连不上 ${remote.sshHost}：${err?.message || err}`);
  }
  if (!out.includes('KX_HAVE')) {
    throw new Error(`${remote.sshHost} 上没有 ${ENGINE_LABEL[engine]} 的 ACP 适配器（${bin}）。`
      + `设置 → 🖥 机器 → 选中这台机器 →「安装 AI 工具」会装上它（${ADAPTER_PACKAGE[engine]}）；`
      + `另外那台机器上要登录过 ${ENGINE_LABEL[engine]}。`);
  }
}

function remotePreflight(remote: RemoteTarget, opts?: { force?: boolean }): Promise<string[]> {
  const host = remote.sshHost || '';
  const running = preflightInFlight.get(host);
  if (running) {
    logger.info('remote', `preflight ${host}: 已经有一次在路上了 —— 等它的结论`
      + `（并发探测会把 sshd 的 MaxStartups 队列撑满，那正是"连不上"的成因之一）`);
    return running;
  }
  const p = runPreflight(remote, opts).finally(() => { preflightInFlight.delete(host); });
  preflightInFlight.set(host, p);
  return p;
}

async function runPreflight(remote: RemoteTarget, opts?: { force?: boolean }): Promise<string[]> {
  const host = remote.sshHost || '';
  if (!opts?.force) {
    const recent = reachability.recentFailure(host);
    if (recent) {
      logger.info('remote', `preflight ${host}: 跳过（${BREAKER_MS / 1000}s 内刚判定连不上）—— 复用上次结论`);
      throw new Error(recent);
    }
  }
  const args = buildSshArgs(remote, `bash -lc ${shellQuote(preflightScript())}`);
  let verdict = { code: 'unreachable', message: `连不上 ${host}` } as ReturnType<typeof judgePreflight>;
  for (let attempt = 1; attempt <= PREFLIGHT_ATTEMPTS; attempt += 1) {
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile('ssh', args, { timeout: 30_000, encoding: 'utf8', env: sshEnv(remote) }, (err: any, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      }));
    });
    verdict = judgePreflight(out.code, out.stdout, out.stderr, remote);
    logger.info('remote', `preflight ${host}: ${verdict.code} — ${verdict.message}`
      + (attempt > 1 ? `（第 ${attempt}/${PREFLIGHT_ATTEMPTS} 次）` : ''));
    if (verdict.code === 'ok') {
      reachability.ok(host);
      /*
        **记下那台机器的规格** ——「远程能承受多少个远程 session」。上限按**它**算，
        而不是按本机的默认值（`DEFAULT_EXECUTOR_CAP`）。判据和实测数字见
        `remoteExecutorCap`。
      */
      /*
        规格**只报一次给人看**，不拿它设上限 —— 上限是我一度加错的东西：它引发"赶走-又回来"的
        循环（实测：新建一条会话等了 46 秒，期间点模型下拉直接报 `Session not connected`）。
        要治的是浪费（孤儿清理 + 复用），不是拦着你开会话。
      */
      /*
        **版本对比** ——「怎么控制远端的版本呢，远端应该也定期更新一下」。
        只报，不自己动手：换掉那个二进制会影响这台机器上**所有**会话，而且新版本可能改行为
        （这一轮好几个 bug 就是 1.27.0 和 2.24.1 的差异带出来的）。什么时候更新是人的决定。
        `remoteKiroVersions` 存着给设置页看（那里有「更新」按钮）。
      */
      if (verdict.kiroVersion) {
        remoteKiroVersions.set(host, verdict.kiroVersion);
        const mine = await localKiroVersion();
        if (isOlderVersion(verdict.kiroVersion, mine) && !remoteVersionWarned.has(host)) {
          remoteVersionWarned.add(host);
          logger.warn('remote', `${host} 上的 kiro-cli 是 ${verdict.kiroVersion}，本机是 ${mine} —— 落后了。`
            + `旧版本缺的东西是实打实的（1.27.0 连 \`--list-models\` 都没有，所以模型倍率只能靠猜）。`
            + `设置 → 🖥 机器 → 那台机器 →「安装 AI 工具」会顺带更新它。`);
        }
      }
      /*
        **内存快到顶时说一句** ——「我又开了几条会话，这个远程机器能处理吗，没有又卡挂了吧」。

        这是告知，**不是上限**（上限那套机械删掉了，它引发过"赶走-又回来"的循环）。
        但不说也不行：实测 2.24.1 之后一条会话要 ~350 MB（1.27.0 时是 155），
        3.8 GB 的机器开到 10 条就吃干，而**没有 swap** 的机器吃干是 OOM killer
        直接杀掉正在跑的那一轮 —— 不是变慢。那种失败看起来像"会话莫名消失"。

        每次 preflight 都判断（不像规格那样只报一次）：余量是会变的，
        而"现在还能不能再开一条"正是你要问的那件事。但同一台机器 10 分钟内只说一次，
        否则每条会话 attach 都报一遍就成了噪音。
      */
      if (verdict.memAvailMB) {
        const room = remoteHeadroom(verdict.memAvailMB);
        const last = remoteMemWarned.get(host) || 0;
        if (verdict.memAvailMB < REMOTE_LOW_MEM_MB && Date.now() - last > 10 * 60_000) {
          remoteMemWarned.set(host, Date.now());
          logger.warn('remote', `${host} 内存快满了：可用 ${verdict.memAvailMB} MB，`
            + `一条会话大约要 ${REMOTE_MB_PER_SESSION} MB —— 大概还能开 ${Math.max(0, room)} 条。`
            + (verdict.swapMB
              ? `（有 ${verdict.swapMB} MB swap，吃紧时会变慢而不是被杀）`
              : `**这台机器没有 swap**，吃干的表现是 OOM killer 直接杀掉正在跑的那一轮，不是变慢。`));
        }
      }
      if (verdict.cpus && verdict.memMB && !remoteSpecsLogged.has(host)) {
        remoteSpecsLogged.add(host);
        logger.info('remote', `${host}: ${verdict.cpus} vCPU / ${verdict.memMB} MB`
          + `（一条远程会话 2 个进程 ≈ ${REMOTE_MB_PER_SESSION} MB —— 只是告知，不设上限）`);
      }
      return verdict.models || [];
    }
    if (!worthRetrying(verdict.message) || attempt === PREFLIGHT_ATTEMPTS) break;
    const wait = backoffMs(attempt);
    logger.info('remote', `preflight ${host}: ${wait}ms 后再试一次（这类失败常在几秒内自愈）`);
    await new Promise((r) => setTimeout(r, wait));
  }
  /* 记进熔断器：紧接着的那些会话直接复用，别把 sshd 压得更死 */
  reachability.fail(host, verdict.message);
  throw new Error(verdict.message);
}

/**
 * **这条会话要用的模型，远端真的有吗** ——「模型列表其实也完全不一样，你看看能不能行」。
 *
 * 实测这两台机器上一样（各 19 个），但没验过就等于赌：远端要是个旧版少了那个模型，
 * kiro-cli **静默退回**（日志里见过 `Available models: auto`），于是这一轮是另一个模型答的。
 *
 * 处理方式和本机"模型退役"那条路一致：按 `MODEL_FALLBACK_ORDER` 挑一个远端真有的，
 * 并在会话里说一句 —— 而不是拦住不让跑（拦住的代价比换一个大），也不是闷着换（那就是我们在治的病）。
 * 列表问不到（空数组）时什么都不做：没依据的判断比不判断糟。
 */
function pickRemoteModel(sessionId: string, wanted: string, models: string[], host: string): string {
  if (!models.length || models.includes(wanted)) return wanted;
  const fallback = MODEL_FALLBACK_ORDER.find((m) => models.includes(m)) || models.find((m) => m !== 'auto') || 'auto';
  sessionNotice(sessionId, `⚠️ ${host} 上没有模型「${wanted}」，这条会话改用「${fallback}」。`
    + `（远端可用：${models.slice(0, 8).join('、')}${models.length > 8 ? '…' : ''}）`
    + `kiro-cli 对这种情况是静默退回默认模型的，所以这里明说一句。`);
  logger.warn('remote', `模型 ${wanted} 在 ${host} 上没有 -> 用 ${fallback}`);
  return fallback;
}

const LOAD_TIMEOUT_MS = 45000;
function withLoadTimeout<T>(p: Promise<T>, ms = LOAD_TIMEOUT_MS, what = 'session/load'): Promise<T> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    /* 实际耗时进日志 —— 下次要调这个数字时得有依据，而不是再猜一个 */
    p.then((v) => {
      const took = Date.now() - t0;
      if (took > 8000) logger.info('load', `${what} 用了 ${(took / 1000).toFixed(1)}s（上限 ${ms / 1000}s）`);
      return v;
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} 超时（${ms / 1000}s 无响应）`)), ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
// Sessions deleted during this runtime. Guards against a concurrent/in-flight
// acp:load-session (e.g. startup eager-attach) racing a delete and RECREATING the
// session's record.json on disk — which would resurrect a chat the user just
// closed (it reappears after restart via disk hydrate). In-memory only: after a
// restart the dir is gone so hydrate never re-adds it.
const deletedSessionIds = new Set<string>();
// Soft cap on ATTACHED executors (design §8). Dormant sessions are unbounded.
// Default is a fixed 10 (「默认会话数设为 10」). It used to be auto-sized from RAM/CPU
// into [4, 16], which on most machines simply meant 16 -- more kiro-cli processes
// (~0.4GB each) than anyone keeps busy. `executorCap` in ~/.kirolex/config.json
// still overrides it.
const DEFAULT_EXECUTOR_CAP = 10;
const MAX_CONCURRENT_SESSIONS_AUTO = DEFAULT_EXECUTOR_CAP;
// User-configurable cap: persisted override in ~/.kirolex/config.json wins over
// the auto-sized value. 0/undefined = auto. Clamped to a sane range.
const KIROLEX_CONFIG_PATH = path.join(os.homedir(), '.kirolex', 'config.json');

/*
  **配置里指定的 kiro-cli 从进程一开始就生效** ——「不管是本地还是远程必须要配置启动命令」。

  不在这里设的话，第一次用到它的是执行器，而模型列表/agent 列表/usage 那几处各自 resolve
  一遍 —— 于是"跑的是哪一个 kiro-cli"在同一个进程里都可能不一致。
*/
setLocalKiroBin(localBins(KIROLEX_CONFIG_PATH)?.kiro);
/*
  远端那台机器的启动命令**按 sshHost 现查配置**，不看会话记录里那份快照 ——
  记录里存的是建会话那一刻的目标，后来配的 `bins` 到不了已有的会话（实测：配置里 tokyo
  有 `bins.kiro`，而那几条老会话全部报"还没有设置…"）。和 `labelForHost` 同一条教训。
*/
setRemoteBinResolver((sshHost) => listRemoteTargets(KIROLEX_CONFIG_PATH)
  .find((t) => t.sshHost === sshHost)?.bins?.kiro);

/** ONE shared copy of the renderer's UI state (project groups, split layout,
 *  settings, panel widths…).
 *
 *  It lives on disk rather than in localStorage because localStorage is
 *  ORIGIN-scoped and this app has two renderer origins: `file://` for a normal
 *  start and `http://localhost:5173` in dev (Vite/HMR). Each therefore had its own
 *  private copy, so switching modes wiped the project groups, collapsed the split
 *  layout and reset the settings -- with the data itself perfectly intact, which is
 *  what made it look like chats had disappeared. Electron's leveldb was holding
 *  both origins at once; this file is the single source both of them read.
 *
 *  Same fix that was already applied to sessions/pinned/archived. These keys were
 *  what remained on the fragile store. */
/** Bedrock rejects a request when ANY image in it exceeds 2000px on a side, and
 *  the check applies to the WHOLE conversation, not just the new message. That made
 *  one oversized paste poison a chat permanently: a 3948x2188 Retina screenshot was
 *  read into the history, and every later turn re-sent it, so the session answered
 *  nothing but "image dimensions exceed max allowed size for many-image requests"
 *  -- compressing and re-attaching could not help, because the offending copy was
 *  already in the transcript the backend replays.
 *
 *  So images are capped BEFORE they can enter a conversation. 1500 (not 2000) keeps
 *  margin under the limit and cuts token cost; screenshots stay readable. */
const MAX_IMAGE_EDGE = 1500;
function capImageSize(img: Electron.NativeImage): { img: Electron.NativeImage; from?: string; to?: string } {
  const { width, height } = img.getSize();
  const longest = Math.max(width, height);
  if (!longest || longest <= MAX_IMAGE_EDGE) return { img };
  const scale = MAX_IMAGE_EDGE / longest;
  const next = img.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'good',
  });
  const size = next.getSize();
  return { img: next, from: `${width}x${height}`, to: `${size.width}x${size.height}` };
}

/** Capping at PASTE time is not enough, and this is why.
 *
 *  Attachments are handed to kiro-cli as `file:<path>` references, and kiro-cli --
 *  not KiroLex -- reads those files and base64-encodes them into the request. Every
 *  historical attachment is re-emitted as such a reference by `historyLine()` on
 *  every single turn (the ride-along snapshot). So ONE oversized file on disk keeps
 *  poisoning EVERY later request in that chat, forever:
 *
 *    messages.54.content.0.image ... exceed max allowed size for many-image
 *    requests: 2000 pixels          <- index 54 of the REPLAYED history
 *
 *  Observed live: six 3210x1496..4504x1912 screenshots under ~/.kirolex/pasted/,
 *  all pasted before the paste-time cap existed. Restarting did not help (the
 *  replay re-read them), and neither did re-pasting a smaller copy (the old paths
 *  are still in the transcript, so they are still replayed).
 *
 *  The gate therefore belongs on the REFERENCE, not on the paste: any path about to
 *  be shown to kiro-cli is resolved to a copy within limits. Non-destructive on
 *  purpose -- the original stays untouched so thumbnails and "open original" keep
 *  working (the renderer reads files directly and has no size limit); only what
 *  reaches the model is downscaled. Copies are deterministic and reused, so this
 *  costs one resize per distinct oversized image, not one per turn. */
const CAPPED_IMAGE_DIR = path.join(os.homedir(), '.kirolex', 'capped');
/** Shared by the file-preview reader and the thumbnail reader, so the two can
 *  never disagree about what counts as a previewable image. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
};
const IMAGE_PATH_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
/** key: `path|mtime|size` -> safe path. Keyed on mtime+size so a replaced file is
 *  re-examined rather than served from a stale entry. */
const cappedImageRefs = new Map<string, string>();
/** Source paths already reported as capped, so the log states the fact once per
 *  process instead of once per turn (the snapshot re-resolves them every turn). */
const loggedCaps = new Set<string>();

function safeImageRef(filePath: string): string {
  try {
    if (!filePath || !IMAGE_PATH_RE.test(filePath) || !fs.existsSync(filePath)) return filePath;
    const st = fs.statSync(filePath);
    const key = `${filePath}|${st.mtimeMs}|${st.size}`;
    const cached = cappedImageRefs.get(key);
    if (cached) {
      // Log once per distinct source path per process. Without this a cache hit --
      // i.e. the normal case -- produced NO evidence the cap had run at all, so
      // diagnosing "still too large" meant reverse-engineering it from history.md.
      if (cached !== filePath && !loggedCaps.has(filePath)) {
        loggedCaps.add(filePath);
        logger.info('image', `ref capped (reusing copy): ${filePath} -> ${cached}`);
      }
      return cached;
    }
    const raw = nativeImage.createFromPath(filePath);
    if (raw.isEmpty()) { cappedImageRefs.set(key, filePath); return filePath; }
    const capped = capImageSize(raw);
    if (!capped.from) { cappedImageRefs.set(key, filePath); return filePath; }
    fs.mkdirSync(CAPPED_IMAGE_DIR, { recursive: true });
    const stem = path.basename(filePath).replace(/\.[^.]+$/, '');
    const out = path.join(CAPPED_IMAGE_DIR, `${stem}_${MAX_IMAGE_EDGE}px.png`);
    if (!fs.existsSync(out)) {
      fs.writeFileSync(out, capped.img.toPNG());
      logger.info('image', `ref capped ${capped.from} -> ${capped.to}: ${filePath} -> ${out}`);
    }
    cappedImageRefs.set(key, out);
    return out;
  } catch (err: any) {
    logger.warn('image', `safeImageRef failed ${filePath}: ${err?.message}`);
    return filePath;
  }
}

/** Rewrite every `file:` reference in a prompt/history text so no oversized image
 *  can reach the backend, whatever produced the reference -- a fresh send, a resend,
 *  a rerun, or the replayed history. This is the single choke point; the three
 *  renderer call sites that build these references do not need to know about it. */
function capImageRefsInText(text: string): string {
  if (!text) return text;
  return capImagePathsInText(text);
}

/** Cap every image path in an outgoing text.
 *
 *  The pattern and the reasoning behind it live in ./imagePaths (pure, and covered by
 *  tests/imagePaths.test.ts); safeImageRef is the mapper that turns an oversized
 *  original into its 1500px copy and returns anything else untouched. */
function capImagePathsInText(text: string): string {
  return rewriteImagePaths(text, safeImageRef);
}

const UI_STATE_PATH = path.join(os.homedir(), '.kirolex', 'ui-state.json');

/** Deleted chats are MOVED here instead of being destroyed, and only aged out
 *  later. Deleting a chat used to be irreversible: one accidental delete removed a
 *  37-message chat plus its rendered history, and with no Time Machine destination
 *  and no APFS local snapshots there was nothing to restore from. */
const SESSION_TRASH_DIR = path.join(os.homedir(), '.kirolex', 'trash');
/** Retention for trashed chats. Long enough to notice a mistake days later. */
const SESSION_TRASH_KEEP_DAYS = 30;
function pruneSessionTrash(): void {
  try {
    if (!fs.existsSync(SESSION_TRASH_DIR)) return;
    const cutoff = Date.now() - SESSION_TRASH_KEEP_DAYS * 86400_000;
    for (const name of fs.readdirSync(SESSION_TRASH_DIR)) {
      const p = path.join(SESSION_TRASH_DIR, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) {
          fs.rmSync(p, { recursive: true, force: true });
          logger.info('trash', `aged out ${name} (older than ${SESSION_TRASH_KEEP_DAYS} days)`);
        }
      } catch {}
    }
  } catch {}
}
function loadUiState(): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(UI_STATE_PATH, 'utf-8'));
    if (raw && typeof raw === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
      return out;
    }
  } catch {}
  return {};
}
let uiStateCache: Record<string, string> | null = null;
function uiState(): Record<string, string> {
  if (!uiStateCache) uiStateCache = loadUiState();
  return uiStateCache;
}
let uiStateFlush: NodeJS.Timeout | null = null;
function setUiStateKey(key: string, value: string | null): void {
  if (!key || typeof key !== 'string') return;
  const state = uiState();
  if (value === null) delete state[key];
  else state[key] = String(value);
  // Coalesced: widths and drafts can change on every mouse move.
  if (uiStateFlush) clearTimeout(uiStateFlush);
  uiStateFlush = setTimeout(() => {
    uiStateFlush = null;
    try {
      fs.mkdirSync(path.dirname(UI_STATE_PATH), { recursive: true });
      const tmp = `${UI_STATE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(uiState(), null, 2));
      fs.renameSync(tmp, UI_STATE_PATH);
    } catch { /* best-effort */ }
  }, 400);
}

/** Keys that were persisted by code that no longer exists.
 *
 *  They cannot be removed by editing ui-state.json by hand: `uiStateCache` holds the
 *  whole object and EVERY setUiStateKey rewrites the file from it, so an external
 *  edit is silently undone by the next panel resize or draft keystroke. And they
 *  cannot be removed once: the migration sweep below imports every `kirolex-*` key
 *  from the file:// origin's localStorage, where uiSet also mirrored them, so a
 *  deleted key comes straight back if ui-state.json is ever recreated. Hence a
 *  declared list, pruned at startup and excluded from the sweep.
 *
 *  kirolex-workspace-dir: the Workspace panel's location. Superseded by
 *  `lastWorkspaceDir` in ~/.kirolex/config.json (app:get/set-workspace-dir); no
 *  reader or writer for this key remains in src/. */
const DEAD_UI_STATE_KEYS = new Set(['kirolex-workspace-dir']);

/** Keys whose lifetime is ONE RUN: persisted while the app is up, wiped at boot.
 *
 *  kirolex-composer-drafts: half-written prompts, one per chat. They must survive
 *  anything that happens WITHIN a run -- switching chats, a layout change that
 *  remounts the composer, a renderer reload from HMR -- which is why they are on disk
 *  and not in a module variable. They must NOT survive a restart: text you typed
 *  yesterday, greeting you with no indication of its age, is worse than no text.
 *
 *  Clearing them here rather than in the renderer is deliberate: the renderer cannot
 *  tell a fresh launch from a reload of the same run (both are just a new page), and
 *  main is the only place that knows the process has just started. */
const RUN_SCOPED_UI_STATE_KEYS = new Set(['kirolex-composer-drafts']);
function clearRunScopedUiState(): void {
  const state = uiState();
  const dropped = [...RUN_SCOPED_UI_STATE_KEYS].filter((k) => Object.prototype.hasOwnProperty.call(state, k));
  if (dropped.length === 0) return;
  for (const k of dropped) delete state[k];
  try {
    fs.mkdirSync(path.dirname(UI_STATE_PATH), { recursive: true });
    const tmp = `${UI_STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, UI_STATE_PATH);
    logger.info('ui-state', `cleared run-scoped key(s) at boot: ${dropped.join(', ')}`);
  } catch (err: any) {
    logger.warn('ui-state', `failed to clear run-scoped key(s): ${err?.message || err}`);
  }
}
function pruneDeadUiStateKeys(): void {
  const state = uiState();
  const dropped = [...DEAD_UI_STATE_KEYS].filter((k) => Object.prototype.hasOwnProperty.call(state, k));
  if (dropped.length === 0) return;
  for (const k of dropped) delete state[k];
  try {
    fs.mkdirSync(path.dirname(UI_STATE_PATH), { recursive: true });
    const tmp = `${UI_STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, UI_STATE_PATH);
    logger.info('ui-state', `pruned dead key(s): ${dropped.join(', ')}`);
  } catch (err: any) {
    logger.warn('ui-state', `failed to prune dead key(s) ${dropped.join(', ')}: ${err?.message || err}`);
  }
}

/** Dev mode = load the renderer from Vite (HMR) instead of the built bundle.
 *
 *  Detected from ARGV, not only NODE_ENV: the old `dev:main` script set it with
 *  `set NODE_ENV=development&&`, which is Windows CMD syntax and silently does
 *  NOTHING on macOS/Linux (verified: NODE_ENV stays undefined). So `npm run dev`
 *  ran the app in PRODUCTION mode off the built files, which is why every UI tweak
 *  needed a full `npm run build` + restart even though HMR was right there. An
 *  argv flag behaves identically on every platform and needs no extra dependency. */
const IS_DEV = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';

/** DEV ONLY: expose Chrome DevTools Protocol on 127.0.0.1:9222.
 *
 *  Why it is here at all: several UI defects in split view (a pane appearing to
 *  re-render when another is clicked, transcripts shifting) can only be settled by
 *  MEASURING the live window -- which DOM nodes mutate, what the real heights are.
 *  Without a port there is no way in, and diagnosing by reading code alone produced
 *  two wrong root causes.
 *
 *  SECURITY: an open CDP port is remote-code-execution equivalent for anything that
 *  can reach it. It is bound to loopback and gated on `--dev`, which a packaged build
 *  never passes, so it cannot reach a normal install. Do not widen it, do not remove
 *  the guard, and prefer removing this block once the layout work is done. */
if (IS_DEV) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
  app.commandLine.appendSwitch('remote-allow-origins', 'http://localhost:9222');
}
const DEV_SERVER_URL = process.env.KIROLEX_DEV_URL || 'http://localhost:5173';
/** 重新加载 dev server（`did-fail-load` 用）。只在 dev 下装上。 */
let reloadDevServer: ((attempt: number) => void) | null = null;
// Paste blobs referenced by an UNSENT composer draft. Kept on disk (not in the
// renderer's localStorage) for two reasons: the draft is per-session and must
// survive a restart, and the boot GC has to see these paths — otherwise a blob
// that only a draft references looks like an orphan and gets deleted.
// Sessions the user deleted. Durable because the in-memory guard dies with the
// process: if the directory could not be removed (still locked), the chat used to
// reappear on the next start. A tombstoned id is hidden from hydrate and its files
// are retried at boot.
// Which interrupted prompt each session has ALREADY been auto-resent for, keyed by a
// hash of the prompt text. Durable, because the point is to survive restarts: without
// it every restart while a long turn is unfinished fires (and bills) another resend.
const AUTO_RESENT_PATH = path.join(os.homedir(), '.kirolex', 'auto-resent.json');
function loadAutoResent(): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTO_RESENT_PATH, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
function saveAutoResent(map: Record<string, string>) {
  try {
    fs.mkdirSync(path.dirname(AUTO_RESENT_PATH), { recursive: true });
    const tmp = AUTO_RESENT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, AUTO_RESENT_PATH);
  } catch { /* best-effort */ }
}

const TOMBSTONES_PATH = path.join(os.homedir(), '.kirolex', 'deleted-sessions.json');
function loadSessionTombstones(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(TOMBSTONES_PATH, 'utf-8'));
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}
function saveSessionTombstones(ids: string[]) {
  try {
    fs.mkdirSync(path.dirname(TOMBSTONES_PATH), { recursive: true });
    const tmp = TOMBSTONES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ids, null, 2));
    fs.renameSync(tmp, TOMBSTONES_PATH);
  } catch { /* best-effort */ }
}
function addSessionTombstone(id: string) {
  const ids = loadSessionTombstones();
  if (!ids.includes(id)) saveSessionTombstones([...ids, id]);
}
function clearSessionTombstone(id: string) {
  const ids = loadSessionTombstones();
  if (ids.includes(id)) saveSessionTombstones(ids.filter((x) => x !== id));
}

const DRAFT_PASTES_PATH = path.join(os.homedir(), '.kirolex', 'draft-pastes.json');
function loadDraftPastes(): Record<string, any[]> {
  try {
    const raw = JSON.parse(fs.readFileSync(DRAFT_PASTES_PATH, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
function saveDraftPastes(map: Record<string, any[]>) {
  try {
    fs.mkdirSync(path.dirname(DRAFT_PASTES_PATH), { recursive: true });
    const tmp = DRAFT_PASTES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, DRAFT_PASTES_PATH);
  } catch { /* best-effort */ }
}
function loadExecutorCapOverride(): number {
  try {
    const cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'));
    const n = Number(cfg?.executorCap);
    if (Number.isFinite(n) && n >= 1) return Math.max(1, Math.min(64, Math.floor(n)));
  } catch {}
  return 0;
}
function saveExecutorCapOverride(n: number) {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
  cfg.executorCap = n > 0 ? Math.max(1, Math.min(64, Math.floor(n))) : 0;
  try { fs.mkdirSync(path.dirname(KIROLEX_CONFIG_PATH), { recursive: true }); } catch {}
  fs.writeFileSync(KIROLEX_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
let MAX_CONCURRENT_SESSIONS = loadExecutorCapOverride() || MAX_CONCURRENT_SESSIONS_AUTO;

/** Wedge detection tuning.
 *
 *  Two inputs only: an OPEN TOOL CALL (protocol truth — never interrupt) and how long
 *  the turn has been silent (a heuristic). Nothing local can do better; the inference
 *  runs on a remote server, so "slow" and "dead" are locally indistinguishable. Several
 *  OS-level corroborations were tried, measured, and removed as uninformative — the last
 *  of them was the CPU probe; see the note where it used to be defined.
 *
 *  The threshold is therefore user-tunable, since it is the whole judgement: a turn
 *  whose FIRST token is genuinely slow is indistinguishable from a hung one. Raise it if
 *  a legitimate slow turn is ever interrupted; set 0 to switch the interrupt off and keep
 *  only the advisory 5-minute notice. What makes the heuristic acceptable is that its
 *  consequence is cheap: a turn that produced nothing is auto-resent, and one that
 *  produced a partial reply is left alone for the user to decide. */
const WATCHDOG_TICK_MS = 30000;             // how often silence is re-checked
/** 10 minutes, raised from 3.
 *
 *  180s was chosen while a CPU probe could still postpone the interrupt; with that probe
 *  gone this number IS the entire policy, and 3 minutes of silence is not enough evidence
 *  of a hang to spend a turn on. It also put the two signals in the wrong order: the
 *  advisory notice appears at 5 minutes (QUIET_NOTICE_MS), so at 180s the turn was already
 *  cut before the user was ever told anything -- the "no tool is running" branch of that
 *  notice was in practice unreachable. At 600s the notice comes first and carries a
 *  countdown, and the interrupt only follows if the silence really does continue. */
const WEDGE_CONFIRM_SECONDS_DEFAULT = 600;
const WEDGE_CONFIRM_SECONDS_MIN = 30;
const WEDGE_CONFIRM_SECONDS_MAX = 3600;
/** Persisted silence threshold in SECONDS. 0 means the user turned the interrupt off;
 *  an absent key means "never configured" and yields the default. */
function loadWedgeConfirmSeconds(): number {
  try {
    const cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'));
    const raw = cfg?.wedgeConfirmSeconds;
    if (raw === 0) return 0;                // explicitly disabled
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return Math.max(WEDGE_CONFIRM_SECONDS_MIN, Math.min(WEDGE_CONFIRM_SECONDS_MAX, Math.floor(n)));
    }
  } catch { /* unreadable config -> default */ }
  return WEDGE_CONFIRM_SECONDS_DEFAULT;
}
function saveWedgeConfirmSeconds(n: number) {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
  cfg.wedgeConfirmSeconds = n > 0
    ? Math.max(WEDGE_CONFIRM_SECONDS_MIN, Math.min(WEDGE_CONFIRM_SECONDS_MAX, Math.floor(n)))
    : 0;
  try { fs.mkdirSync(path.dirname(KIROLEX_CONFIG_PATH), { recursive: true }); } catch {}
  fs.writeFileSync(KIROLEX_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
/** 0 disables wedge interruption. Mutable: the Settings handler applies it live. */
let WEDGE_CONFIRM_MS = loadWedgeConfirmSeconds() * 1000;

/** How long an OPEN tool call may go without any update before it stops counting as
 *  progress. This bound is what keeps the tool-call guard from being a second way to
 *  hang forever (observed: a `search` call missing its closing update suppressed
 *  detection for 5+ hours). Generous by default because a legitimate long command may
 *  report nothing between start and finish — raise it if a real build is ever cut off. */
const TOOL_STALL_SECONDS_DEFAULT = 1800;   // 30 min
const TOOL_STALL_SECONDS_MIN = 60;
const TOOL_STALL_SECONDS_MAX = 86400;
function loadToolStallSeconds(): number {
  try {
    const cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'));
    const n = Number(cfg?.toolStallSeconds);
    if (Number.isFinite(n) && n > 0) {
      return Math.max(TOOL_STALL_SECONDS_MIN, Math.min(TOOL_STALL_SECONDS_MAX, Math.floor(n)));
    }
  } catch { /* unreadable config -> default */ }
  return TOOL_STALL_SECONDS_DEFAULT;
}
function saveToolStallSeconds(n: number) {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
  cfg.toolStallSeconds = Math.max(TOOL_STALL_SECONDS_MIN, Math.min(TOOL_STALL_SECONDS_MAX, Math.floor(n || TOOL_STALL_SECONDS_DEFAULT)));
  try { fs.mkdirSync(path.dirname(KIROLEX_CONFIG_PATH), { recursive: true }); } catch {}
  fs.writeFileSync(KIROLEX_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
let TOOL_STALL_MS = loadToolStallSeconds() * 1000;

/* The CPU-progress probe that used to live here is GONE, deliberately.
 *
 * It sampled the executor's process tree and postponed an interrupt while that tree was
 * burning CPU, on the rule "do not kill a process that is actively computing". It was
 * measured carefully, and it still could not answer the question that matters: CPU use
 * proves only that a process is NOT BLOCKED. A spin-wait or a livelock pegs a core
 * forever, and a turn waiting on remote inference burns none at all -- so the signal was
 * uninformative in BOTH directions. It also cost a 5s sample plus a full process sweep
 * (`ps -Ao` / one CIM query) per decision, and it made the timeout non-deterministic:
 * the same silence could be cut at 3 minutes or at 9, depending on unrelated activity.
 *
 * The two bounds are now the whole policy: silence past WEDGE_CONFIRM_MS, or an open tool
 * call that has stopped reporting for longer than TOOL_STALL_MS. Both are user-visible
 * settings, and both are deterministic. If a long, genuinely-working command is ever cut
 * short, the fix is to raise 「工具无进度多久判定卡死」 -- not to infer intent from CPU counters.
 */

/** USER-SELECTABLE FEATURES.
 *
 *  Every flag defaults to ON, so an untouched install behaves exactly as before.
 *  Read at the CALL SITE, never cached at boot -- that is the whole point: toggling
 *  one takes effect on the next operation, with no restart. Kept deliberately small
 *  and concrete; these are behaviours that have each caused a real problem at some
 *  point, so being able to switch one off without editing code is worth having. */
const FEATURE_DEFAULTS: Record<string, boolean> = {
  /** Prepend the history snapshot to the next message instead of spending a
   *  dedicated rebuild turn. Off = fall back to the chunked rebuild. */
  rideAlongContext: true,
  /** Re-render history.md at every turn end so the path handed to the backend
   *  never points at a frozen snapshot. Off = only written when a rebuild runs. */
  historyFileRefresh: true,
  /** Inject the layered memory block (global ⊕ project ⊕ this chat) into EVERY turn.
   *  Off = the model never sees the memory files at all. ~1.3k chars per turn. */
  memoryInjection: true,
  /** Generate chat titles with the helper model. */
  smartTitle: true,
  /** 会话记忆自动维护：一轮结束、攒够新消息就压一次（`sessionMemory.ts`） */
  sessionMemory: true,
  /**
   * **远程会话**：把这条会话的 kiro-cli 跑在另一台机器上，文件留在本机、通过反向隧道读写
   * （`localMcp.ts`）。见 `docs/DESIGN_remote_sessions.md`。
   *
   * 默认**开** ——「为什么加了远程机器还没有切换到远程会话的选项」。原来默认关，理由是它改了
   * "发送前先 rsync 推镜像"那条主路；镜像早就去掉了，剩下的效果只是：你在设置里配好一台机器，
   * 新建对话里却永远看不到它。配一台机器本身就是选择要用它；一台没配时这个开关什么也不改变。
   */
  remoteSessions: true,
  /** Store a large paste on disk and show a placeholder in the composer. */
  pasteFolding: true,
  /** Draggable dividers between split panes. */
  splitDragResize: true,
  /** Starter-prompt chips above an empty composer. */
  promptSuggestions: true,
};
function loadFeatureFlags(): Record<string, boolean> {
  const out = { ...FEATURE_DEFAULTS };
  try {
    const cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'));
    const f = cfg?.features;
    if (f && typeof f === 'object') {
      for (const key of Object.keys(FEATURE_DEFAULTS)) {
        if (typeof f[key] === 'boolean') out[key] = f[key];
      }
    }
  } catch {}
  return out;
}
/**
 * 某个**后端 session** 上连着失败了几次 ——「无法继续执行，总是断」。
 *
 * 键是 `cliSessionId`（不是 KiroLex 的会话 id）：要判的是"这段后端对话是不是坏了"，而重建会换掉
 * 这个 id —— 换完计数自然从零开始，正好。成功一轮就清零：连续性是这个判据的全部内容。
 *
 * 实测那条会话：一次 `write` 工具失败之后，每次发送都回 `Kiro failed to generate a response`，
 * 8 秒一次连着 6 次，pid 从头到尾没变 —— 而原来的重建判据只认 pid 不一致，所以永远不触发。
 */
/**
 * 换项目时这一轮还在跑 → 重置执行器推迟到本轮结束（见 `acp:move-session`）。
 * 不推迟就得在一轮中间 detach，把正在跑的那一轮连根拔掉；而拒绝换项目又让人在最想整理的时候动不了。
 */
const pendingProjectReset = new Set<string>();
/** 消化欠下的执行器重置。必须在这一轮的回复落盘之后调：detachExecutor 会立刻把 entry 拿掉。 */
function consumePendingProjectReset(sessionId: string, why: string): void {
  if (pendingProjectReset.delete(sessionId)) {
    logger.info('session', `${why} sessionId=${sessionId}`);
    void detachExecutor(sessionId);
  }
}
const cliFailStreak = new Map<string, number>();
/**
 * **这条会话上一次换后端会话是什么时候** ——「我他妈说的是最近那几次 workshop 的」。
 *
 * 查到底的结论：那几次不是这条对话的问题。kiro-cli 自己存的会话状态里，换出来的新会话
 * 上下文只占 3.82% / 3.85%（几乎是空的）照样连着失败，而最后好了的那个反而是最大的 9.11%；
 * 失败按时间聚堆（07:30–07:54 十三失败一成功，07:55 之后九成功一失败），kiro-cli 日志里
 * 全是 `err=EmptyResponse`。换会话对这种故障没用 —— 判据见 `staleVerdict` 里的 `lastRecreateAgoMs`。
 */
const cliRecreatedAt = new Map<string, number>();
/**
 * **这条会话连着几次被后端拒绝生成**（`Internal error` / `EmptyResponse` 那一族）——
 * 「首先换成 sol 没好。是我后来换成 kiro-cli 才好了。」「这个问题很严重必须修好」。
 *
 * 和 `cliFailStreak` 的区别是**键**：那个按后端 session 记，而换会话会把它清零 ——
 * 于是"换了三个后端会话、每个都失败两次"在它眼里永远只是 2，永远推不出"该换模型了"。
 * 这个按 KiroLex 会话记，跨换会话累计，成功一轮清零。
 */
const bareFailStreak = new Map<string, number>();

function noteInSession(sessionId: string, body: string): boolean {
  const sid = String(sessionId || '').trim();
  const text = String(body || '').trim();
  if (!sid || !text) return false;
  const messageId = `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_note`;
  try {
    /**
     * **标成 KiroLex 自己说的话** ——「这他妈什么玩意，为什么按照会话发出去了」。
     *
     * 这些是对**你**说的（换模型了、换后端会话了、排队了），原来以 `role: 'user'` 落盘，
     * 而快照 / history.md / 逐段重建都是从 transcript 建的 —— 模型下一轮真的读到
     * 「⚠️ 这条会话现在跑在 gpt-5.6-sol 上」并当成你的指令。
     *
     * 界面照旧显示（可见性是这些话存在的理由），但每一条发给模型的路径都跳过它（`modelFacing`）。
     */
    store.appendMessage(sid, { id: messageId, role: 'user', content: text, ts: Date.now(), kirolex: true });
    refreshHistoryFile(sid);
    mainWindow?.webContents.send('acp:user-message', {
      sessionId: sid, messageId, content: text, ts: Date.now(), kirolex: true,
    });
    return true;
  } catch { return false; }
}

/* ───────────────── 侧栏文件预览的「✓ 确认」：在那条会话里改一处 ─────────────────
 *
 * 从 feature/flow 搬过来（那边门上和侧栏共用），这里只留文件预览那条路：
 * `review:revise-in-session` 把意见发给**打开这份文件的那条会话**，等这一轮的完整回复，
 * 渲染层拼回整份之后再走 `review:write-file` 落盘。
 */

/**
 * 某条会话上**正在等一轮完整回复**的那一个 —— `review:revise-in-session` 挂上，一轮成功收尾时兑付。
 *
 * 只在**成功收尾**那一处兑付（见 `sendPromptOnce` 里 `flushAssistant` 之后那段），不在 `flushAssistant`
 * 里兑付：出错 / 取消那两条路也会 flush 半截输出，而半截正文拿去写盘就是把文件后半截删掉。
 * 那两条路走完 `sendPromptOnce` 照样返回（或抛），等待者由调用方自己摘掉。
 */
const askWaiters = new Map<string, {
  resolve: (reply: { text: string; stopReason: string; wedged: boolean }) => void;
  timer: NodeJS.Timeout;
}>();

/**
 * **侧栏 comment 那一次次改写的 ticket** —— 取消要能认出"就是这一次"，而不是"这条会话此刻在跑的那一轮"：
 * 一次改写可能还排在 `enqueueRevise` 里、或者在等你自己那一轮对话跑完（`waitIdle`），那时按会话去 cancel
 * 停掉的是**你的对话**。所以：取消只记一笔；轮到它时看一眼，被取消了就不发；已经在等回复（`asking`）的，
 * 停的是它自己那一轮（那时 `askWaiters` 上挂的就是它）。
 */
const reviseTickets = new Map<string, { sessionId: string; cancelled: boolean; asking: boolean }>();
function openTicket(ticket: string | undefined, sessionId: string) {
  if (ticket) reviseTickets.set(ticket, { sessionId, cancelled: false, asking: false });
  return {
    cancelled: () => !!ticket && !!reviseTickets.get(ticket)?.cancelled,
    asking: (on: boolean) => { const t = ticket ? reviseTickets.get(ticket) : undefined; if (t) t.asking = on; },
    close: () => { if (ticket) reviseTickets.delete(ticket); },
  };
}

/** 兑付这条会话上的等待者。没有等待者就什么都不做（绝大多数轮次都是这样）。 */
function settleAsk(sessionId: string, reply: { text: string; stopReason: string; wedged: boolean }) {
  const w = askWaiters.get(sessionId);
  if (!w) return;
  askWaiters.delete(sessionId);
  clearTimeout(w.timer);
  w.resolve(reply);
}

/**
 * 每条会话上**排队等着改写**的那些 —— 「如果有会话已经在跑的话确认会失败，这个不对，把它改成加入到 queue」。
 *
 * 原来是直接拒：`busyReasonFor` 说忙就返回错误，让你等它停下来再点一次。那是把调度推给你 ——
 * 而你判断不了它什么时候停（那一轮可能跑十分钟），也不该记着"我还有三条要提"。
 * 现在按会话串成一条链：一条跑完下一条自动接上。链**按 sessionId** 分 —— 不同会话之间没有理由互等。
 */
const reviseChain = new Map<string, Promise<unknown>>();

/**
 * 每条会话上**还没跑完**的改写条数 —— 只为了「前面还有 N 条」那句话说得准。
 *
 * 不能用 `reviseChain.has()` 代替：那个 map 的键从来不删（它存的是"下一条接在谁后面"），
 * 所以第二条改写起它永远为真 —— 实测因此报了两次不存在的排队。
 */
const revisePending = new Map<string, number>();

/**
 * 排到这条会话的队尾，轮到了再跑。失败不断链（否则一次失败会把后面几条全带走）。
 *
 * **真的要等的时候说一声**：队列只活在主进程里，等待期间会话里一个字都没有 —— 而"什么都没发生"和
 * "排上队了"在屏幕上长得一模一样。不等的那些（绝大多数）什么都不说：一条"已排队"紧接着一条"已改完"
 * 只是噪音。
 */
function enqueueRevise<T>(sessionId: string, job: () => Promise<T>, label?: string): Promise<T> {
  const ahead = revisePending.get(sessionId) || 0;
  if (label) {
    const busy = busyReasonFor(sessionId);
    if (ahead > 0) {
      noteInSession(sessionId, `⏳ 已排队：${label} —— 前面还有 ${ahead} 条改写没跑完，轮到它会自动发出去。`);
    } else if (busy) {
      noteInSession(sessionId, `⏳ 已排队：${label} —— 这条会话正忙（${busy}），空下来会自动发出去。`);
    }
  }
  revisePending.set(sessionId, ahead + 1);
  const prev = reviseChain.get(sessionId) || Promise.resolve();
  const next = prev.then(job, job);
  reviseChain.set(sessionId, next.then(() => {}, () => {}).then(() => {
    const left = (revisePending.get(sessionId) || 1) - 1;
    if (left > 0) revisePending.set(sessionId, left);
    else revisePending.delete(sessionId);
  }));
  return next;
}

/** 等这条会话空下来 —— 轮到自己之后还要等它自己那一轮跑完（用户手动发的那些）。返回还忙的原因，空了是 null。 */
async function waitIdle(sessionId: string, maxMs: number): Promise<string | null> {
  const started = Date.now();
  for (;;) {
    const why = busyReasonFor(sessionId);
    if (!why) return null;
    if (Date.now() - started > maxMs) return String(why);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * 每条会话为预览**读过**哪些文件（解析之后的绝对路径）—— `review:write-file` 的白名单。
 *
 * 不用路径形状去判（那种判据要么太松要么挡住正常路径），用"你确实以这条会话的身份打开看过它"这个事实：
 * 你对着它提的意见，写回同一份才成立。**按会话记**：写回只允许打开这个标签页的那条会话
 * （`FileTab.ownerSessionId`）—— 和改写走的是同一条会话，别的会话不能借这条通道去写它没读过的文件。
 * 键 `''` = 没带会话读的（工作区面板、没有当前会话时）。进程重启就清空 —— 重启之后你没看过任何东西。
 */
const reviewedPaths = new Map<string, Set<string>>();
function markReviewed(sessionId: string | null | undefined, resolvedPath: string): void {
  const key = String(sessionId || '');
  let set = reviewedPaths.get(key);
  if (!set) { set = new Set(); reviewedPaths.set(key, set); }
  set.add(resolvedPath);
}
function wasReviewed(sessionId: string | null | undefined, resolvedPath: string): boolean {
  return !!reviewedPaths.get(String(sessionId || ''))?.has(resolvedPath);
}

function isFeatureEnabled(key: keyof typeof FEATURE_DEFAULTS | string): boolean {
  const flags = loadFeatureFlags();
  return flags[key] !== false;
}
function saveFeatureFlag(key: string, enabled: boolean): Record<string, boolean> {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
  if (!cfg.features || typeof cfg.features !== 'object') cfg.features = {};
  if (key in FEATURE_DEFAULTS) cfg.features[key] = !!enabled;
  try { fs.mkdirSync(path.dirname(KIROLEX_CONFIG_PATH), { recursive: true }); } catch {}
  const tmp = `${KIROLEX_CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, KIROLEX_CONFIG_PATH);
  logger.info('features', `${key}=${!!enabled} (takes effect on the next operation, no restart)`);
  return loadFeatureFlags();
}

/** Models used for KiroLex's own background TEXT chores (chat titles, prompt
 *  suggestions) -- NOT for the chats themselves. The primary is tried first and
 *  the fallback only if it cannot answer, so a throttled/retired helper model
 *  never silently kills titles and suggestions. User-adjustable in Settings and
 *  persisted in ~/.kirolex/config.json. */
const DEFAULT_HELPER_MODEL = 'claude-sonnet-5';
const DEFAULT_HELPER_FALLBACK_MODEL = 'gpt-5.6-terra';
/* ---------------------------------------------------------------- S3 备份 */

/**
 * **AKSK 的 secret 不落明文** —— 这是 ARCC 那条规矩在本机上的等价做法。
 *
 * ARCC 这次没查到（`arcc` CLI 报 Midway 401，属于环境没登录，不是"没有这条规矩"），
 * 所以按标准做法办：secret 用 Electron `safeStorage` 加密后再写进 `config.json`
 * （macOS 上落在 Keychain 保护的密钥下），日志里只出现 access key 的后 4 位。
 *
 * `safeStorage` 不可用时（某些 Linux 桌面环境没有 keyring）**拒绝保存**，而不是退回明文：
 * "我帮你存了"和"我把你的密钥明文写进了一个 JSON"之间，用户有权知道是哪一个。
 */
function encryptSecret(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('这台机器上没有可用的加密存储（keychain / keyring）—— 拒绝把 secret 明文写进配置。');
  }
  return safeStorage.encryptString(plain).toString('base64');
}

function decryptSecret(cipher?: string): string {
  if (!cipher) return '';
  try { return safeStorage.decryptString(Buffer.from(cipher, 'base64')); } catch { return ''; }
}

/* SSH 密码和 S3 secret 同一套加解密（sshAuth.ts 拿不到 safeStorage，由这里注入） */
setPasswordDecryptor((cipher) => decryptSecret(cipher));

/**
 * 界面送来的密码字段 → 要存的密文。明文**只活在这一次调用里**。
 *   · `clearPassword: true` → 清掉（空串）
 *   · `password` 非空 → 加密（没有加密存储时 encryptSecret 会抛，拒绝明文落盘）
 *   · 都没有 → `{}`：不动已存的那份（界面拿不到密文，所以"没给"是常态）
 */
function passwordFields(input: any): { passwordCipher?: string } {
  if (input?.clearPassword) return { passwordCipher: '' };
  const plain = typeof input?.password === 'string' ? input.password : '';
  return plain ? { passwordCipher: encryptSecret(plain) } : {};
}

/** 测试连接 / 安装时要用的密文：刚输入的优先，否则用这台机器已存的。 */
function passwordCipherForUse(input: any): string | undefined {
  const f = passwordFields(input);
  if (f.passwordCipher !== undefined) return f.passwordCipher || undefined;
  return input?.id ? findRemoteTarget(KIROLEX_CONFIG_PATH, String(input.id))?.passwordCipher : undefined;
}

const KIROLEX_HOME = path.join(os.homedir(), '.kirolex');
/** 模型元数据缓存（倍率 / 上下文窗口）—— 见 `modelMeta.ts`。 */
const MODEL_META_PATH = path.join(KIROLEX_HOME, 'model-meta.json');
const S3_STATE_PATH = path.join(KIROLEX_HOME, 's3-sync-state.json');
/** 每条会话最后一次真的上传是什么时候（见 `readSessionMarks` 那段）。 */
const S3_MARKS_PATH = path.join(KIROLEX_HOME, 's3-session-sync.json');

function loadSyncConfig(): SyncConfig {
  try {
    const cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'));
    return (cfg?.s3Sync && typeof cfg.s3Sync === 'object') ? cfg.s3Sync as SyncConfig : {};
  } catch { return {}; }
}

function saveSyncConfig(next: SyncConfig): void {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
  cfg.s3Sync = next;
  try { fs.mkdirSync(path.dirname(KIROLEX_CONFIG_PATH), { recursive: true }); } catch {}
  fs.writeFileSync(KIROLEX_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/** 配好了没有 —— 缺哪一项就说哪一项（"同步没生效"必须能查）。 */
function syncCredsOrProblem(): { creds?: S3Creds; problem?: string } {
  const cfg = loadSyncConfig();
  const missing = [
    !cfg.bucket && 'bucket',
    !cfg.region && 'region',
    !cfg.accessKeyId && 'Access Key ID',
    !cfg.secretCipher && 'Secret Access Key',
  ].filter(Boolean) as string[];
  if (missing.length) return { problem: `S3 备份还没配好：缺 ${missing.join('、')}（设置 → ☁️ 备份）。` };
  const secretAccessKey = decryptSecret(cfg.secretCipher);
  if (!secretAccessKey) {
    return { problem: 'S3 的 secret 解不开了 —— keychain 里那把密钥变了（换过机器/重装过？）。重新填一次。' };
  }
  return {
    creds: {
      accessKeyId: cfg.accessKeyId!, secretAccessKey,
      region: cfg.region!, bucket: cfg.bucket!, endpoint: cfg.endpoint,
    },
  };
}

let syncRunning = false;
let syncTimer: NodeJS.Timeout | null = null;
/**
 * **连续失败之后退避**（参考 Tabby 那个云同步插件：`improved retry behavior after repeated failures`）。
 *
 * 不退避的表现：桶名写错之后，每 30 分钟准时失败一次，日志里堆一模一样的报错 ——
 * 而"它一直在重试"本身没有价值，错的东西重试一百次还是错的。手动点「立即同步」**不受退避限制**：
 * 那是人明确要求的，而且人刚改完配置想马上验证。
 */
let syncFailures = 0;
let syncNextAllowedAt = 0;
let lastSyncSummary: { at: number; uploaded: number; skipped: number; bytes: number; error?: string } | null = null;

/**
 * 跑一轮同步。
 *
 * **串行、可重入保护**：定时器和"立即同步"按钮都会调它，两个同时跑会把状态文件写花。
 * 失败不抛 —— 备份是背景工作，但**必须留下摘要**，否则"同步没生效"是个不可查的问题。
 */
/** 这一轮的 catalog 条目 —— 冲突检测和最终写 catalog 用的是同一份，不能算两遍。 */
/**
 * 这条会话属于哪个项目。没归项目的返回空串（界面上是「未分组」）。
 *
 * 取 `profile.projectId` —— 那是唯一的真相。**不要**从会话目录名去推：
 * 一条没归项目的远程会话，目录名就是会话 id 本身，于是会推出一个叫 `s_179…` 的"项目"
 * （侧栏那个 bug 就是这么来的，见 `deriveProjectId` 上面那段）。
 */
function projectOf(rec: { profile?: any } | null | undefined): string {
  const id = (rec?.profile as any)?.projectId;
  return typeof id === 'string' ? id.trim() : '';
}

/**
 * 这个项目要不要同步 ——「有些project可以选择不同步」。
 *
 * 空串（未分组）也能被排除，它在列表里就是一个普通的组。
 */
function projectExcluded(cfg: SyncConfig, project: string): boolean {
  const list = Array.isArray(cfg.excludeProjects) ? cfg.excludeProjects : [];
  return list.includes(project);
}

/** 这条会话要不要同步 ——「我现在还是不能选择是否备份会话」。项目关着的话整组都不传，这里是再细一层。 */
function sessionExcluded(cfg: SyncConfig, sessionId: string): boolean {
  return Array.isArray(cfg.excludeSessions) && cfg.excludeSessions.includes(sessionId);
}

function catalogEntriesFor(
  sessions: Array<{ id: string; title?: string; updatedAt?: number; profile?: any; archived?: boolean; placementChangedAt?: number }>,
  machine: string,
): CatalogEntry[] {
  const now = Date.now();
  return sessions.map((r) => ({
    id: r.id,
    title: r.title || 'New Chat',
    /* 分组用 —— 恢复列表是一次 GET 拿整张 catalog，不该为了分组再去下几十个 record.json */
    project: projectOf(r) || undefined,
    updatedAt: r.updatedAt || 0,
    bytes: [...SESSION_FILES, ...walkSessionFiles(path.join(KIROLEX_HOME, 'sessions', r.id), SESSION_FILES_DIR)].reduce((sum, f) => {
      try { return sum + fs.statSync(path.join(KIROLEX_HOME, 'sessions', r.id, f)).size; } catch { return sum; }
    }, 0),
    from: machine,
    syncedAt: now,
    /* 位置跟随用（见 `placementToFollow`）：别的机器按它判断要不要跟着这台挪项目 / 归档 */
    archived: !!r.archived,
    placementChangedAt: placementOf(r).placementChangedAt,
  }));
}

/**
 * **项目 / 归档跟着别的机器走** ——「同步时让会话的项目和归档状态在多台机器间自动跟随」。
 *
 * 读到桶里的 catalog 之后、生成本机条目和上传计划**之前**调：桶里那条的 `placementChangedAt`
 * 比本机新（别的机器后挪过），就把本机记录的 projectId / archived / placementChangedAt 改成桶里的。
 * 不先做这一步的话，本机只要又聊过一句（updatedAt 更新），就会把旧位置传上去盖掉对方的移动。
 *
 * 只动这三个字段，transcript 和别的字段不碰；`updatedAt` 也不碰（这不是一次新的对话改动，
 * 碰了会打乱侧栏排序、还会让对方下一轮误判"本机更新"）。
 * 正在跑一轮的照样改（同 `acp:move-session`）：记录立刻改，重置执行器推迟到这一轮结束。
 * 设成不同步的项目 / 会话不参与 —— 那些本来就不和桶来往。
 */
function followBucketPlacements(cfg: SyncConfig, catalog: Catalog | null, sessions: store.SessionRecord[]): string[] {
  const byId = new Map((catalog?.entries || []).map((e) => [e.id, e]));
  const changed: string[] = [];
  for (const r of sessions) {
    if (projectExcluded(cfg, projectOf(r)) || sessionExcluded(cfg, r.id)) continue;
    const theirs = byId.get(r.id);
    if (!placementToFollow(r, theirs)) continue;
    /* 写之前按磁盘再读一遍 —— 列表那份可能已经旧了，拿它写回去会丢掉这期间别的改动 */
    const cur = store.readRecord(r.id);
    const p = placementToFollow(cur, theirs);
    if (!cur || !p) continue;
    const before = placementOf(cur);
    try {
      store.writeRecordKeepUpdatedAt(applyPlacement(cur, p));
    } catch (err: any) {
      logger.warn('s3', `位置跟随 ${r.id} 写不进记录：${err?.message || err}`);
      continue;
    }
    const projectChanged = before.projectId !== p.projectId;
    const archiveChanged = before.archived !== p.archived;
    if (!projectChanged && !archiveChanged) continue;          // 位置本来就一样，只是补上时间戳
    const describe = (x: { projectId: string; archived: boolean }) => `项目「${x.projectId || '未分组'}」${x.archived ? '·已归档' : ''}`;
    logger.info('s3', `位置跟随 ${r.id}（${cur.title || 'New Chat'}）：${describe(before)} → ${describe(p)}`
      + `（来自 ${theirs?.from || '未知机器'}，${new Date(p.placementChangedAt).toLocaleString()} 改的）`);
    /* 换了项目要换 memory scope、归档要把执行器让出来 —— 和 move-session / archive-session 一样 */
    if (projectChanged || p.archived) {
      const live = sessionClients.get(r.id);
      if (live?.busy) pendingProjectReset.add(r.id);
      else if (live) void detachExecutor(r.id);
    }
    mainWindow?.webContents.send('session:placement-changed', { sessionId: r.id, projectId: p.projectId || null, archived: p.archived });
    changed.push(r.id);
  }
  return changed;
}

/**
 * 桶里拉下来的对象落到本地之前，确认它真的在 `base` 下面。
 * `relFor` 已经拒了 `..` 和绝对路径，这里是第二道：key 是远端来的数据，
 * 而这个路径会被直接写盘 —— 一个越界的 key 就是写到 ~/.kirolex 之外。
 */
function containedPath(base: string, rel: string): string | null {
  const root = path.resolve(base);
  const abs = path.resolve(root, rel);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/**
 * **冲突时自动合并** ——「这个不对，很显然应该自动合并」。
 *
 * 原来判成冲突（桶里那份是别的机器传的、而且更新）就把本机这份传到 conflicts/ 旁路、等人来处理，
 * 而界面上没有处理它的地方 —— 于是每一轮都报同一句"被别的机器更新过"，永远不收敛。
 *
 * transcript 是 append-only 的事件流、每条带 id 和 ts，按 id 去重 + 按 ts 排序就是精确的并集
 * （`mergeTranscripts`，和恢复同一个函数）；record 取 updatedAt 新的那份、数组取并集（`mergeRecords`）。
 * 桶里有而本地没有的 files/ 文件拉下来；两边都有的以本地为准（下面会正常传上去）。
 * 动之前把本地那两份挪进 trash。history.md 是渲染产物，不拉，由调用方从合并后的 transcript 重建。
 */
async function mergeBucketSession(creds: S3Creds, prefix: string | undefined, sessionId: string): Promise<{ added: number; pulledFiles: number }> {
  const sdir = getSessionDir(sessionId);
  const tAbs = path.join(sdir, 'transcript.jsonl');
  const rAbs = path.join(sdir, 'record.json');
  const tKey = keyFor(prefix, path.join('sessions', sessionId, 'transcript.jsonl'));
  const rKey = keyFor(prefix, path.join('sessions', sessionId, 'record.json'));
  const [rt, rr] = await Promise.all([getObjectIfExists(creds, tKey), getObjectIfExists(creds, rKey)]);
  const bak = trashDirFor(KIROLEX_HOME, sessionId);
  fs.mkdirSync(bak, { recursive: true });
  for (const f of [tAbs, rAbs]) { try { fs.copyFileSync(f, path.join(bak, `before-merge-${path.basename(f)}`)); } catch { /* 本地没有 */ } }
  let added = 0;
  if (rt) {
    const mine = fs.existsSync(tAbs) ? fs.readFileSync(tAbs, 'utf-8') : '';
    const r = mergeTranscripts(mine, rt.toString('utf-8'));
    if (r.text !== mine) { const tmp = `${tAbs}.kirolex-${process.pid}.tmp`; fs.writeFileSync(tmp, r.text); fs.renameSync(tmp, tAbs); }
    added = r.added;
  }
  if (rr) {
    let mine: any; let theirs: any;
    try { mine = JSON.parse(fs.readFileSync(rAbs, 'utf-8')); } catch { mine = undefined; }
    try { theirs = JSON.parse(rr.toString('utf-8')); } catch { theirs = undefined; }
    const merged = mergeRecords(mine, theirs);
    /* 合并之后这一份就是"最新"的：updatedAt 取两边的较大者，不然下一轮又被判成冲突 */
    merged.updatedAt = Math.max(Number(mine?.updatedAt) || 0, Number(theirs?.updatedAt) || 0, Date.now());
    const tmp = `${rAbs}.kirolex-${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(merged, null, 2)); fs.renameSync(tmp, rAbs);
  }
  let pulledFiles = 0;
  const fpfx = `${keyFor(prefix, path.join('sessions', sessionId, SESSION_FILES_DIR))}/`;
  const filesRoot = path.join(sdir, SESSION_FILES_DIR);
  for (const o of await listObjects(creds, fpfx)) {
    if (!o.key.startsWith(fpfx)) continue;
    const rel = relFor(prefix, o.key);
    if (!rel) continue;
    /* 只许落在这条会话自己的 files/ 下 */
    const abs = containedPath(filesRoot, path.relative(path.join('sessions', sessionId, SESSION_FILES_DIR), rel));
    if (!abs || fs.existsSync(abs)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, await getObject(creds, o.key));
    pulledFiles += 1;
  }
  try { refreshHistoryFile(sessionId); } catch { /* 下次打开时会重建 */ }
  return { added, pulledFiles };
}

/**
 * **以本机为准**：删掉桶里这条会话的全部对象（含 conflicts/ 旁路），再把本机这份整条传上去，
 * catalog 里这一条的来源改成本机 ——「先删掉 windows 那里上传的版本重新弄 mac 版上去」。
 */
async function keepLocalSession(creds: S3Creds, prefix: string | undefined, sessionId: string, thisMachine: string): Promise<{ deleted: number; uploaded: number }> {
  let deleted = 0;
  for (const pfx of [`${keyFor(prefix, path.join('sessions', sessionId))}/`, conflictPrefixFor(prefix, sessionId)]) {
    for (const o of await listObjects(creds, pfx)) { await deleteObject(creds, o.key); deleted += 1; }
  }
  const rels = [
    ...SESSION_FILES.map((f) => path.join('sessions', sessionId, f)),
    ...walkSessionFiles(KIROLEX_HOME, path.join('sessions', sessionId, SESSION_FILES_DIR)),
  ].filter((rel) => { try { return fs.statSync(path.join(KIROLEX_HOME, rel)).isFile(); } catch { return false; } });
  const state = readState(S3_STATE_PATH);
  let uploaded = 0;
  for (const rel of rels) {
    const abs = path.join(KIROLEX_HOME, rel);
    const st = fs.statSync(abs);
    if (st.size > MAX_FILE_BYTES) continue;
    await putObject(creds, keyFor(prefix, rel), fs.readFileSync(abs), contentTypeFor(rel));
    state[rel] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    uploaded += 1;
  }
  writeState(S3_STATE_PATH, state);
  /* catalog：这一条换成本机的 —— 不换的话下一轮还是"别的机器传的、更新"，又判冲突 */
  const raw = await getObjectIfExists(creds, catalogKey(prefix));
  let catalog: Catalog = { version: 1, entries: [] };
  try { if (raw) catalog = JSON.parse(raw.toString('utf-8')); } catch { /* 坏了就当空的 */ }
  const rec = store.readRecord(sessionId);
  const fresh = rec ? catalogEntriesFor([rec], thisMachine) : [];
  const next: Catalog = { version: 1, entries: [...(catalog.entries || []).filter((e) => e.id !== sessionId), ...fresh] };
  await putObject(creds, catalogKey(prefix), Buffer.from(JSON.stringify(next, null, 2)), 'application/json');
  const marks = readSessionMarks(S3_MARKS_PATH);
  marks[sessionId] = { at: Date.now(), updatedAt: rec?.updatedAt || 0 };
  writeSessionMarks(S3_MARKS_PATH, marks);
  return { deleted, uploaded };
}

/**
 * 删掉桶里若干条会话的备份（对象 + catalog 条目），并清掉本地"传过什么"的记录。
 * `s3:delete-project` 和 `s3:delete-sessions` 共用 —— 顺序和理由见下面每一步。
 */
async function deleteBackupsOf(
  creds: any, prefix: string | undefined, catalog: Catalog, goneIds: Set<string>,
): Promise<{ deleted: number; failed: string[] }> {
  let deleted = 0;
  const failed: string[] = [];
  for (const id of goneIds) {
    const pfx = `${keyFor(prefix, path.join('sessions', id))}/`;
    for (const obj of await listObjects(creds, pfx)) {
      try { await deleteObject(creds, obj.key); deleted += 1; }
      catch (err: any) { failed.push(`${obj.key}：${err?.message || err}`); }
    }
  }
  /*
    catalog 最后写：先写的话中途失败会留下一个"指向已删对象"的 catalog，
    而那比"多列了几条还在的"更糟 —— 点恢复只会得到一句看不懂的错误。
  */
  const nextCatalog: Catalog = { version: 1, entries: (catalog.entries || []).filter((e) => !goneIds.has(e.id)) };
  await putObject(creds, catalogKey(prefix), Buffer.from(JSON.stringify(nextCatalog, null, 2)), 'application/json');
  /*
    **本地那张"传过什么"的状态表也要清掉这几条** —— 不清的话下一轮同步会认为
    "这些文件没变、跳过"，于是本地还在的那些**再也不会被重新传上去**。
  */
  const state = readState(S3_STATE_PATH);
  for (const rel of Object.keys(state)) {
    const sid = sessionIdOfRel(rel);
    if (sid && goneIds.has(sid)) delete state[rel];
  }
  writeState(S3_STATE_PATH, state);
  const marks = readSessionMarks(S3_MARKS_PATH);
  for (const id of goneIds) delete marks[id];
  writeSessionMarks(S3_MARKS_PATH, marks);
  return { deleted, failed };
}

/** 一个目录下的子目录名（没有这个目录就是空）。 */
/** 记忆文件（`memory/` 下的 .md）—— 它们走"谁新用谁"那一套，见 `decideMemory`。 */
function isMemoryRel(rel: string): boolean {
  return rel.startsWith(`memory${path.sep}`) && rel.endsWith('.md');
}

function walkDirs(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}

async function runS3Sync(reason: string): Promise<{ ok: boolean; uploaded: number; skipped: number; error?: string }> {
  if (syncRunning) return { ok: false, uploaded: 0, skipped: 0, error: '上一轮还在跑' };
  if (reason === '定时' && Date.now() < syncNextAllowedAt) {
    logger.info('s3', `跳过这一次定时同步（连续失败 ${syncFailures} 次，退避到 ${new Date(syncNextAllowedAt).toLocaleTimeString()}）`);
    return { ok: false, uploaded: 0, skipped: 0, error: '退避中' };
  }
  const { creds, problem } = syncCredsOrProblem();
  if (problem) return { ok: false, uploaded: 0, skipped: 0, error: problem };
  syncRunning = true;
  const cfg = loadSyncConfig();
  const state = readState(S3_STATE_PATH);
  const marks = readSessionMarks(S3_MARKS_PATH);
  /** 这一轮真的传了文件的那些会话 —— 只给它们更新"最后同步时间"。 */
  const touchedSessions = new Set<string>();
  let uploaded = 0;
  let bytes = 0;
  try {
    /*
      **按项目筛一遍** ——「有些project可以选择不同步」。筛在这里（枚举会话的地方）
      而不是 `planUpload` 里面：那个函数只认"路径 + 上次的状态"，把项目概念塞进去
      会让它同时对两件事负责。
    */
    const thisMachine = machineTag(os.hostname());
    /*
      **先看桶里有没有别人动过同一条会话**（参考 Tabby 插件的 `conflict detection` +
      `safe conflict backups`）。catalog 要在上传**之前**读：读晚了就已经盖掉对方了。
      也要在**列会话、做上传计划之前**读 —— 位置跟随（`followBucketPlacements`）得先把别的机器挪过的
      项目 / 归档改到本机，后面的计划和 catalog 条目才是新位置，不会把旧位置再传上去。
    */
    const oldRaw0 = await getObjectIfExists(creds!, catalogKey(cfg.prefix));
    let oldCatalog: Catalog | null = null;
    try { oldCatalog = oldRaw0 ? JSON.parse(oldRaw0.toString('utf-8')) : null; } catch { oldCatalog = null; }
    followBucketPlacements(cfg, oldCatalog, store.listSessions());   // 侧栏按 session:placement-changed 逐条改
    const allSessions = store.listSessions();
    const sessions = allSessions.filter((r) => !projectExcluded(cfg, projectOf(r)) && !sessionExcluded(cfg, r.id));
    const excludedCount = allSessions.length - sessions.length;
    if (excludedCount) {
      logger.info('s3', `跳过 ${excludedCount} 条会话（项目设成了不同步：`
        + `${(cfg.excludeProjects || []).map((p) => p || '未分组').join('、') || '无'}；单独设成不同步的会话 ${(cfg.excludeSessions || []).length} 条）`);
    }
    const ids = sessions.map((r) => r.id);
    /*
      **记忆按同一个口径筛** ——「会话和 project 备份时把 project 和 session 的记忆也备份进去」。
      项目：本地所有有记忆的项目里，没被设成不同步的那些（一个项目底下暂时没有会话，它的记忆也该在）。
    */
    const memoryProjects = walkDirs(path.join(KIROLEX_HOME, 'memory', 'projects'))
      .filter((p) => !projectExcluded(cfg, p));
    const plan = planUpload(KIROLEX_HOME, ids, state, { projects: memoryProjects });
    let freshEntries = catalogEntriesFor(sessions, thisMachine);
    const conflicts = detectConflicts(oldCatalog, freshEntries, thisMachine);
    /*
      **冲突自动合并** ——「这个不对，很显然应该自动合并」（见 `mergeBucketSession`）。
      合并完本地那份就是两边的并集，照常传上去。只有两种情况退回旁路（conflicts/）：
      正在跑一轮的（产出还没落盘，这时候动 transcript 会丢东西，下一轮再合），和合并出错的。
    */
    const conflictIds = new Set<string>();
    const mergedIds: string[] = [];
    for (const c of conflicts) {
      const live = sessionClients.get(c.id);
      if (live?.busy) { conflictIds.add(c.id); continue; }
      try {
        if (live) detachExecutor(c.id);              // 执行器手上那份不能再写盘，下次打开按合并后的记录重新接上
        const r = await mergeBucketSession(creds!, cfg.prefix, c.id);
        mergedIds.push(c.id);
        logger.info('s3', `自动合并 ${c.id}（桶里那份来自 ${c.from}）：并进 ${r.added} 条消息${r.pulledFiles ? `、拉下 ${r.pulledFiles} 个文件` : ''}`);
        mainWindow?.webContents.send('session:history-changed', { sessionId: c.id });
      } catch (err: any) {
        conflictIds.add(c.id);
        logger.warn('s3', `自动合并 ${c.id} 失败，这一轮本机这份传到 conflicts/：${err?.message || err}`);
      }
    }
    if (mergedIds.length) {
      /* 合并改了本地的 record/transcript：这几条要重新传，catalog 条目也按合并后的记录来 */
      for (const id of mergedIds) {
        for (const f of SESSION_FILES) {
          const rel = path.join('sessions', id, f);
          if (!plan.upload.includes(rel) && fs.existsSync(path.join(KIROLEX_HOME, rel))) plan.upload.push(rel);
        }
      }
      const reread = new Map(mergedIds.map((id) => [id, store.readRecord(id)]));
      freshEntries = catalogEntriesFor(sessions.map((r) => reread.get(r.id) || r), thisMachine);
    }
    if (conflictIds.size) {
      logger.warn('s3', `${conflictIds.size} 条会话这一轮没合并（${[...conflictIds].join('、')}）—— 本机这份传到 conflicts/，下一轮再合`);
      mainWindow?.webContents.send('s3:conflicts', conflicts.filter((c) => conflictIds.has(c.id)));
    }
    logger.info('s3', `同步开始（${reason}）：${plan.upload.length} 个要传、${plan.skippedUnchanged} 个没变`
      + `${plan.skippedTooBig.length ? `、${plan.skippedTooBig.length} 个太大跳过` : ''}`
      + ` bucket=${cfg.bucket} key=${maskKeyId(cfg.accessKeyId)}`);
    for (const rel of plan.skippedTooBig) {
      logger.warn('s3', `跳过（超过 ${MAX_FILE_BYTES / 1024 / 1024}MB）：${rel}`);
    }
    const touchedProjectMemory = new Map<string, number>();
    /*
      **记忆：谁新用谁，本机第一次先拉**（判据在 `decideMemory`）。planUpload 只看本地改没改，
      而记忆还要看桶里那份是不是别的机器改过 —— 所以这里先把记忆从计划里拿出来单独决定。
      桶里的列表读不到就**这一轮一份记忆都不传**：不知道桶里是什么就传，正是把真记忆盖成空壳的那条路。
    */
    let memoryPulled = 0;
    const memRemote = new Map<string, { size: number; at: number }>();
    let memListed = false;
    try {
      const mpfx = `${keyFor(cfg.prefix, 'memory')}/`;
      for (const o of await listObjects(creds!, mpfx)) {
        const rel = relFor(cfg.prefix, o.key);
        if (rel) memRemote.set(path.join(...rel.split('/')), { size: o.size, at: Date.parse(o.lastModified) || 0 });
      }
      memListed = true;
    } catch (err: any) {
      logger.warn('s3', `读不到桶里的记忆列表，这一轮记忆不传也不拉：${err?.message || err}`);
    }
    const memScope = (rel: string): boolean => {
      const parts = rel.split(path.sep);
      if (parts[0] !== 'memory' || !rel.endsWith('.md')) return false;
      if (parts.length === 2) return true;                                   // global.md 那一层
      if (parts[1] === 'projects') return !projectExcluded(cfg, parts[2]);   // 别的机器建的项目也拉
      if (parts[1] === 'sessions') return ids.includes(parts[2]);            // 只管本机有的会话
      return false;
    };
    const memUpload = new Set<string>();
    if (memListed) {
      const candidates = new Set<string>([
        ...plan.upload.filter((r) => isMemoryRel(r)),
        ...memoryRelsFor(KIROLEX_HOME, ids, memoryProjects).filter((r) => r.endsWith('.md')),
        ...memRemote.keys(),
      ]);
      const memRoot = path.join(KIROLEX_HOME, 'memory');
      for (const rel of candidates) {
        if (!memScope(rel)) continue;
        /* 记忆的路径可能来自桶里的列表 —— 只许落在 ~/.kirolex/memory 下 */
        const abs = containedPath(memRoot, path.relative('memory', rel));
        if (!abs) continue;
        let local: { size: number; mtimeMs: number } | undefined;
        try { const st = fs.statSync(abs); local = { size: st.size, mtimeMs: st.mtimeMs }; } catch { /* 本机没有 */ }
        const remote = memRemote.get(rel);
        const firstTime = !state[rel];
        const action = decideMemory(local, remote, state[rel]);
        if (action === 'upload') { memUpload.add(rel); continue; }
        if (action === 'pull' && remote) {
          try {
            const buf = await getObjectIfExists(creds!, keyFor(cfg.prefix, rel));
            if (!buf) continue;
            /* 被换掉的那份先挪进 trash —— 拉是覆盖，覆盖之前留一份 */
            if (local && local.size > 0) {
              const bak = path.join(KIROLEX_HOME, 'trash', `memory-pull-${Date.now()}`, rel);
              fs.mkdirSync(path.dirname(bak), { recursive: true });
              fs.copyFileSync(abs, bak);
            }
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            const tmp = `${abs}.kirolex-${process.pid}.tmp`;
            fs.writeFileSync(tmp, buf);
            fs.renameSync(tmp, abs);
            const st = fs.statSync(abs);
            state[rel] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs), remoteAt: remote.at, remoteSize: remote.size };
            memoryPulled += 1;
            logger.info('s3', `记忆 ${rel}：从桶里拉回（${firstTime ? '本机第一次同步，' : '桶里那份更新，'}桶里 ${remote.size} B，本机原来 ${local?.size ?? 0} B）`);
          } catch (err: any) {
            logger.warn('s3', `记忆 ${rel} 拉不下来：${err?.message || err}`);
          }
          continue;
        }
        /* 都没动：把刚传完那次还没读到的服务器时间补上，下一轮就按时间比 */
        if (remote && state[rel] && !state[rel].remoteAt && remote.size === (state[rel].remoteSize ?? state[rel].size)) {
          state[rel] = { ...state[rel], remoteAt: remote.at };
        }
      }
    }
    /* 计划里的记忆只留"决定要传"的那些；读不到桶里列表时一份都不留 */
    const uploadList = [
      ...plan.upload.filter((r) => !isMemoryRel(r)),
      ...memUpload,
    ];
    for (const rel of uploadList) {
      const abs = path.join(KIROLEX_HOME, rel);
      let body: Buffer;
      let st: fs.Stats;
      try { body = fs.readFileSync(abs); st = fs.statSync(abs); } catch { continue; }
      const owner = rel.startsWith(`sessions${path.sep}`) ? rel.split(path.sep)[1] : '';
      const key = owner && conflictIds.has(owner)
        ? conflictKeyFor(cfg.prefix, owner, thisMachine, rel)
        : keyFor(cfg.prefix, rel);
      await putObject(creds!, key, body, contentTypeFor(rel));
      state[rel] = isMemoryRel(rel)
        /* remoteAt=0：刚传上去、服务器时间下一轮从列表里读（见 decideMemory） */
        ? { size: st.size, mtimeMs: Math.floor(st.mtimeMs), remoteAt: 0, remoteSize: st.size }
        : { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
      uploaded += 1;
      bytes += body.length;
      /*
        **记下这条会话是什么时候真的传上去的** ——「每一个会话同步应该有最新同步到什么时间」。
        不能用 catalog 的 `syncedAt` 回答：那个每一轮给所有条目盖同一个 now，
        一条一周没动过的会话也会被说成"刚刚同步过"（见 `readSessionMarks` 那段）。
      */
      const sid = sessionIdOfRel(rel);
      if (sid) touchedSessions.add(sid);
      /* 项目记忆也记一笔「什么时候真的传上去的」—— 备份/恢复界面的项目行要显示它 */
      const pm = /^memory[\\/]projects[\\/]([^\\/]+)[\\/]memory\.md$/.exec(rel);
      if (pm) touchedProjectMemory.set(pm[1], Math.floor(st.mtimeMs));
    }
    /*
      catalog 最后传：它是"有哪些备份可恢复"的唯一入口，先传会指向还没上传完的东西。
      **冲突的那几条不进 catalog** —— 它们传到了 conflicts/ 下，让 catalog 指向它们
      等于把"可恢复"这件事说错了。
    */
    const merged = mergeCatalog(oldCatalog, freshEntries.filter((e) => !conflictIds.has(e.id)));
    await putObject(creds!, catalogKey(cfg.prefix), Buffer.from(JSON.stringify(merged, null, 2)), 'application/json');
    writeState(S3_STATE_PATH, state);
    /*
      **只更新这一轮真的传过的那些**。给所有会话盖一个 now 就又回到 catalog 那个毛病了：
      "最后同步时间"会变成"最后跑过一轮的时间"，而那两句话的区别正是这张表存在的理由。
      `updatedAt` 一起记下来 —— 之后本地再动过就能算出"有改动还没备份"。
    */
    if (touchedProjectMemory.size) {
      const now = Date.now();
      for (const [proj, mtime] of touchedProjectMemory) marks[projectMemoryMarkKey(proj)] = { at: now, updatedAt: mtime };
      writeSessionMarks(S3_MARKS_PATH, marks);
    }
    if (touchedSessions.size) {
      const now = Date.now();
      const byId = new Map(sessions.map((r) => [r.id, r]));
      for (const id of touchedSessions) {
        marks[id] = { at: now, updatedAt: byId.get(id)?.updatedAt || 0 };
      }
      writeSessionMarks(S3_MARKS_PATH, marks);
    }
    syncFailures = 0;
    syncNextAllowedAt = 0;
    lastSyncSummary = {
      at: Date.now(), uploaded, skipped: plan.skippedUnchanged, bytes,
      ...(conflictIds.size ? { conflicts: Array.from(conflictIds) } : null),
    };
    logger.info('s3', `同步完成：传了 ${uploaded} 个文件 / ${(bytes / 1024).toFixed(0)} KB`
      + `${memoryPulled ? `，从桶里拉回 ${memoryPulled} 份记忆（别的机器更新的 / 本机第一次同步）` : ''}`);
    mainWindow?.webContents.send('s3:sync-done', lastSyncSummary);
    return { ok: true, uploaded, skipped: plan.skippedUnchanged };
  } catch (err: any) {
    const hint = err instanceof S3Error ? `\n${err.hint}` : '';
    const message = `${err?.message || err}${hint}`;
    /* 部分成功也把 state 写下来：已经传上去的下次不必再传 */
    writeState(S3_STATE_PATH, state);
    syncFailures += 1;
    const minutes = Math.max(5, Number(cfg.intervalMinutes) || DEFAULT_INTERVAL_MINUTES);
    syncNextAllowedAt = Date.now() + minutes * 60_000 * backoffMultiplier(syncFailures);
    lastSyncSummary = { at: Date.now(), uploaded, skipped: 0, bytes, error: message };
    logger.warn('s3', `同步失败（${reason}，连续第 ${syncFailures} 次）：${message}`
      + ` —— 下一次定时同步不早于 ${new Date(syncNextAllowedAt).toLocaleTimeString()}`);
    mainWindow?.webContents.send('s3:sync-done', lastSyncSummary);
    return { ok: false, uploaded, skipped: 0, error: message };
  } finally {
    syncRunning = false;
  }
}

/** 按配置重排定时器。关掉时清掉 —— 留着一个不干活的定时器只会让人以为它在跑。 */
function rescheduleS3Sync(): void {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  const cfg = loadSyncConfig();
  if (!cfg.enabled) { logger.info('s3', '定时同步：关'); return; }
  const minutes = Math.max(5, Number(cfg.intervalMinutes) || DEFAULT_INTERVAL_MINUTES);
  syncTimer = setInterval(() => { void runS3Sync('定时'); }, minutes * 60_000);
  logger.info('s3', `定时同步：每 ${minutes} 分钟一次`);
}

function loadHelperModels(): { model: string; fallback: string } {
  try {
    const cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'));
    return {
      model: String(cfg?.helperModel || '').trim() || DEFAULT_HELPER_MODEL,
      fallback: String(cfg?.helperFallbackModel ?? '').trim() || DEFAULT_HELPER_FALLBACK_MODEL,
    };
  } catch {
    return { model: DEFAULT_HELPER_MODEL, fallback: DEFAULT_HELPER_FALLBACK_MODEL };
  }
}
function saveHelperModels(model: string, fallback: string) {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
  cfg.helperModel = String(model || '').trim() || DEFAULT_HELPER_MODEL;
  // Empty fallback is a legitimate choice: "primary only, no second attempt".
  cfg.helperFallbackModel = String(fallback ?? '').trim();
  try { fs.mkdirSync(path.dirname(KIROLEX_CONFIG_PATH), { recursive: true }); } catch {}
  fs.writeFileSync(KIROLEX_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/** Wire a freshly-created client's events, routing everything by sessionId. */
/**
 * **Claude Code / Codex 的模型** ——「右侧的选模型为什么没有」。清单来自适配器自己（session/new / load 的
 * `configOptions`），这里只负责：连上之后把这条会话记着的那个设回去，再把清单推给界面。
 */
function engineModelsPayload(sessionId: string, entry: SessionEntry) {
  return {
    sessionId,
    ...(entry.client.modelOptions || { current: '', options: [] }),
    /* 「改成 effort 吧」—— 原来显示引擎名的那一格 */
    effort: entry.client.selectOptions('thought_level'),
    /* 「claude code 那个就不应该叫 auto 了」—— 顶上那颗按钮在这两家是它们自己的权限模式 */
    mode: entry.client.selectOptions('mode'),
  };
}

/**
 * **没选过权限模式时用哪个** ——「默认是 bypass 就好」。只给 Claude Code 定：它的适配器起来时报什么取决于
 * 那台机器的 settings（`permissions.defaultMode`），而 KiroLex 里 kiro 会话默认就是自动批准，两边该一致。
 * Codex 的那几档同时管着沙箱（read-only / workspace-write …），不替人选，用它自己的默认。
 */
const DEFAULT_ENGINE_MODE: Partial<Record<'claude' | 'codex', string>> = { claude: 'bypassPermissions' };

/** 这条会话记着的那几个值（模型 / effort / 模式），按"先模型后 effort"的顺序 —— 换模型可能会换掉 effort 的可选值。 */
function wantedEngineOptions(profile: AgentProfile): Array<[EngineOptionCategory, string]> {
  const engine = engineOf(profile);
  if (engine === 'kiro') return [];
  const saved = profile.engineOptions?.[engine] || {};
  const out: Array<[EngineOptionCategory, string]> = [];
  const model = profile.engineModels?.[engine];
  if (model) out.push(['model', model]);
  if (saved.thought_level) out.push(['thought_level', saved.thought_level]);
  const mode = saved.mode || DEFAULT_ENGINE_MODE[engine];
  if (mode) out.push(['mode', mode]);
  return out;
}

async function applyEngineModel(sessionId: string, entry: SessionEntry): Promise<void> {
  const engine = engineOf(entry.profile);
  if (engine === 'kiro') return;
  for (const [cat, want] of wantedEngineOptions(entry.profile)) {
    const opts = entry.client.selectOptions(cat);
    if (!opts || opts.current === want || !opts.options.some((o) => o.value === want)) continue;
    try { await entry.client.setSelectOption(entry.cliSessionId, cat, want); } catch (err) {
      logger.warn('engine-model', `重设 ${ENGINE_LABEL[engine]} ${cat}=${want} 失败 sessionId=${sessionId}`, err);
    }
  }
  if (sessionClients.get(sessionId) === entry) mainWindow?.webContents.send('session:engine-models', engineModelsPayload(sessionId, entry));
}

function wireSession(sessionId: string, entry: SessionEntry) {
  const { client } = entry;
  void applyEngineModel(sessionId, entry);
  client.on('update', (data: any) => {
    // A background history-priming turn's output must never surface: don't
    // forward to the UI, accumulate, or persist it.
    //
    // This is the ONLY prompt KiroLex issues on its own behalf. There was briefly a
    // second kind -- a hidden `/clear` sent when the user cleared a chat -- and it
    // needed the same suppression, because without it kiro-cli's reply reached both
    // the screen (a ghost message in the chat just emptied) and `assistantBuf`, from
    // where the next real turn's flush wrote it into the transcript. That command is
    // gone: the user types `/clear` themselves and it travels as an ordinary turn,
    // so there is nothing to suppress and no second flag to keep in step with this
    // one. Anything added here later that sends a prompt the user did not type must
    // suppress it the same way.
    if (entry.priming) return;
    // Stall watchdog: any inbound stream activity proves the turn is alive.
    entry.lastStreamAt = Date.now();
    // Accumulate assistant text so we can persist the COMPLETE message on
    // turn end (never the in-flight partial, §7). The ACP session/update
    // payload is { sessionId, update: { sessionUpdate, content: { text } } }.
    try {
      const u = data?.update;
      if (
        entry.suppressCancellationChunks &&
        u?.sessionUpdate === 'agent_message_chunk'
      ) {
        return;
      }
      if (u?.sessionUpdate === 'agent_message_chunk') {
        entry.assistantBuf += u?.content?.text || '';
        if (!entry.assistantMsgId) entry.assistantMsgId = u?.messageId || `a_${Date.now()}`;
        /* 远程会话：它可能在这几行里要求"在用户机器上打开某个页面"—— 边流边认，别等到一轮结束
           （一轮可能还要跑几分钟，而"让我看看进度"的价值就在于**现在**看） */
        if (entry.profile.remote?.sshHost) runLocalActions(sessionId, entry, u?.content?.text || '');
      }
      if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') {
        const toolCallId = u?.toolCallId || `tool_${Date.now()}`;
        /* 只数新开的调用（不数 update）—— 这是"这一轮动过东西没有"的依据，见 `toolsThisTurn`。 */
        if (u?.sessionUpdate === 'tool_call') entry.toolsThisTurn = (entry.toolsThisTurn || 0) + 1;
        /*
          远程会话：这一步可能在远端写了文件 —— 防抖拉一次（不等它）。这是让 gate / file review
          在一轮**进行中**就看得到改动的那一半；只在一轮结束时拉的话，界面会一直显示上一版。
        */
        /*
          **先看协议事实，再看标题** ——「一直在从远端下载啥啊」：每轮收尾都拉一次、而且"改了 0 个文件"。
          原因是判据只看标题，而这条会话在跑网页搜索/知识库查询（`Searching the web`、
          `Querying knowledge base`），标题里带 search/fetch 就被判成"可能写过文件"。
          `locations`/`diffs` 是后端**明说**动过哪些文件的地方 —— 有它就一定拉；没有它再退回标题判断，
          而纯读类的标题（search/grep/list…）本来就被排除。
        */
        const touchedFiles = (Array.isArray(u?.locations) && u.locations.length > 0)
          || (Array.isArray(u?.content) && u.content.some((c: any) => c?.type === 'diff'));
        const previous = entry.fileChanges.find((change) => change.toolCallId === toolCallId);
        const locations: string[] = Array.from(new Set<string>(
          (Array.isArray(u?.locations) ? u.locations : [])
            .map((location: any) => typeof location === 'string' ? location : location?.path)
            .filter((value: any): value is string => typeof value === 'string' && value.length > 0),
        ));
        const diffs = (Array.isArray(u?.content) ? u.content : [])
          .filter((block: any) => block?.type === 'diff' && typeof block.path === 'string' && typeof block.newText === 'string')
          .map((block: any) => ({ path: block.path, oldText: block.oldText ?? undefined, newText: block.newText }));
        const rawStatus = u?.status;
        const status: store.StoredToolCall['status'] =
          rawStatus === 'in_progress' || rawStatus === 'completed' || rawStatus === 'failed'
            ? rawStatus
            : 'pending';
        // A later update carrying no output must not erase what an earlier one
        // reported, hence the fallback to `previous`.
        const output = extractToolOutput(u?.content);
        /* 原始长度（裁剪之前）—— 见 `maxToolOutputThisTurn`：失败时要能说出是被哪一步撑死的 */
        if (output.length > (entry.maxToolOutputThisTurn || 0)) entry.maxToolOutputThisTurn = output.length;
        const next: store.StoredToolCall = {
          toolCallId,
          title: u?.title || previous?.title || 'Tool call',
          status,
          kind: u?.kind || previous?.kind,
          locations: locations.length > 0 ? locations : previous?.locations,
          diffs: diffs.length > 0 ? diffs : previous?.diffs,
          content: output ? clampToolOutput(output) : previous?.content,
        };
        // Outstanding-tool bookkeeping for wedge detection (see openToolCalls).
        // `lastUpdate` is rewritten on every update, so it measures STALENESS, not
        // age: a tool that keeps reporting keeps its session protected. `startedAt`
        // is kept separately so a finished call can report how long it took.
        const open = (entry.openToolCalls ??= new Map<string, { startedAt: number; lastUpdate: number }>());
        const finished = status === 'completed' || status === 'failed';
        const wasOpen = open.get(toolCallId);
        // BOUNDARY LOGGING, first and last update only. Between `received` and `done`
        // main used to log nothing whatsoever, so a 37-minute turn that ran 73 tool
        // calls was indistinguishable from a hung one both live and afterwards --
        // and the transcript could not help, because a turn's tool calls are only
        // persisted when it ends (asymmetric durability, sessionStore §1). Interior
        // updates stay silent: they repeat per tool and would bury everything else.
        const label = String(next.title).replace(/\s+/g, ' ').slice(0, 100);
        if (finished) {
          // A tool whose ONLY update is terminal (instant ones do that) was never
          // opened, so there is no start time to subtract — log it anyway, otherwise
          // it leaves no trace at all, which is the gap this logging exists to close.
          const took = wasOpen ? ` after=${((Date.now() - wasOpen.startedAt) / 1000).toFixed(1)}s` : '';
          logger.info('tool', `${status} sessionId=${sessionId} id=${toolCallId.slice(-8)}${took} ${label}`);
          // Same boundaries into the run event log, with the duration attached: a
          // StoredToolCall has no timestamp at all, so this is the only place a tool
          // span survives the process.
          eventLog.appendEvent(sessionId, {
            ts: Date.now(),
            type: 'tool_end',
            turn: entry.currentUserMessageId,
            toolCallId,
            title: label,
            kind: next.kind,
            status,
            ms: wasOpen ? Date.now() - wasOpen.startedAt : 0,
          });
          open.delete(toolCallId);
        } else if (wasOpen) {
          wasOpen.lastUpdate = Date.now();
        } else {
          const now = Date.now();
          open.set(toolCallId, { startedAt: now, lastUpdate: now });
          logger.info('tool', `start sessionId=${sessionId} id=${toolCallId.slice(-8)} kind=${next.kind || '-'} ${label}`);
          eventLog.appendEvent(sessionId, {
            ts: now,
            type: 'tool_start',
            turn: entry.currentUserMessageId,
            toolCallId,
            title: label,
            kind: next.kind,
          });
        }
        // Record a call when it touched files OR when it RAN something.
        //
        // Requiring locations/diffs dropped every command outright, which is why no
        // `execute` kind exists in any transcript. A turn that wrote a script and then
        // ran it was persisted as "created a script" and nothing else -- so when the
        // script is what actually produces the artifact (python-pptx writing a .pptx),
        // the causal chain lost its middle link and the output file looked like it came
        // from nowhere.
        const kindLower = (next.kind || '').toLowerCase();
        const ranSomething = RUN_KINDS.has(kindLower);
        if (!next.locations?.length && !next.diffs?.length && !unobservedToolKinds.has(kindLower)) {
          // One line per distinct kind, so the guess-set above can be replaced by fact.
          unobservedToolKinds.add(kindLower);
          logger.info('tool', `tool_call with no locations/diffs kind=${next.kind || '<none>'} recorded=${ranSomething} title=${String(next.title).slice(0, 120)}`);
        }
        if (next.locations?.length || next.diffs?.length || ranSomething) {
          const index = entry.fileChanges.findIndex((change) => change.toolCallId === toolCallId);
          if (index >= 0) entry.fileChanges[index] = next;
          else entry.fileChanges.push(next);
        }
      }
    } catch {}
    // WAITING FOR A HUMAN starts here. This is the single most valuable event in the
    // log: an unanswered permission prompt is the usual reason a turn took 20 minutes,
    // and it was previously persisted NOWHERE -- after a restart the wait was simply
    // invisible, so a slow turn and a turn waiting on you looked identical.
    // (`data.update`, not the `u` above: that one is scoped to the try block.)
    const pending = data?.update;
    if (pending?.sessionUpdate === 'permission_request') {
      const requestKey = String(pending?.requestId ?? '');
      if (requestKey) permissionWaitStartedAt.set(requestKey, Date.now());
      eventLog.appendEvent(sessionId, {
        ts: Date.now(),
        type: 'permission_request',
        turn: entry.currentUserMessageId,
        title: String(pending?.toolCall?.title || pending?.title || pending?.toolName || '需要批准的工具调用').slice(0, 120),
        detail: requestKey,
      });
      logger.info('permission', `asked sessionId=${sessionId} id=${requestKey}`);
    }
    /**
     * NATIVE SUBAGENTS — the roster, and WHOSE session each update really came from.
     *
     * Two facts measured with `scripts/acp-probe.mjs` meet here:
     *
     *   ① `_kiro.dev/subagent/list_update` is a full roster (name, worker agent, task, status) and it
     *      repeats until everything reads `terminated`. That is exactly the tag 「如果有subagent在运行
     *      左侧的会话上也应该有一个tag，直到subagent被关掉」 needs, so it is kept and broadcast rather
     *      than dropped into the generic `_kiro_internal` channel nothing consumes.
     *
     *   ② Most of a delegating turn's notifications DO NOT come from this chat's backend session: each
     *      subagent has its own ACP session id, and its tool calls and permission requests arrive under
     *      that id. The line below has to relabel them with the KiroLex id (that is what routes them to
     *      the right chat), but relabelling used to DESTROY the distinction — a subagent's output became
     *      indistinguishable from the parent's. `childSessionId` preserves it: present means "a subagent
     *      did this", and it is the child's real, addressable ACP session.
     */
    /* 把这份命令表留下来 —— 见 `SessionEntry.commands`。 */
    if (data?.update?.method === '_kiro.dev/commands/available' && Array.isArray(data.update.commands)) {
      /*
        只在真的变了才记一行 —— 后端一次启动可能连推好几次同一份整表（每个 MCP server 初始化完就重发）。
        比名字，不比整对象：描述/提示词后端可能顺手改字，而这行日志答的是"这条会话现在能用哪些命令"。
        缓存照旧每次都写 —— 幂等，而且描述真变了也该跟上。
      */
      const names = data.update.commands.map((c: any) => String(c?.name || '')).join(',');
      const before = (entry.commands || []).map((c: any) => String(c?.name || '')).join(',');
      entry.commands = data.update.commands;
      if (names !== before) {
        logger.info('acp', `commands: ${data.update.commands.length} 条 (sessionId=${sessionId})`);
      }
    }
    if (isSubagentListUpdate(data?.update?.method)) {
      const roster = parseSubagentList(data.update);
      entry.subagents = mergeSubagentList(entry.subagents, roster);
      const live = activeSubagents(entry.subagents);
      logger.info('subagent', `sessionId=${sessionId} roster=${roster.length} 运行中=${live.length}`);
      mainWindow?.webContents.send('acp:subagents', { sessionId, subagents: entry.subagents });
    }
    const originAcpSessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
    const childSessionId = originAcpSessionId && entry.cliSessionId && originAcpSessionId !== entry.cliSessionId
      ? originAcpSessionId
      : undefined;
    mainWindow?.webContents.send('acp:update', { ...data, sessionId, ...(childSessionId ? { childSessionId } : null) });
  });
  /*
    后端 stderr 里**值得看的那几行**送到界面上（判据在 `stderrNotice`）—— 原来这里只进日志，
    渲染层的 `onError` 只 `console.error`，于是 MCP server 起不来时界面上什么都没说。
    只筛 stderr 这一路；其余 error 事件照旧。
  */
  const reportStderr = (message: string) => {
    for (const n of noticesFromStderr(message)) {
      logger.warn('backend', `${n.kind} sessionId=${sessionId}: ${n.text}`);
      mainWindow?.webContents.send('acp:notice', {
        sessionId, level: n.level, kind: n.kind, label: noticeLabel(n.kind), text: n.text,
      });
    }
  };
  client.on('error', (error: any) => {
    logger.warn('session', `error event sessionId=${sessionId}`, error?.message || error);
    if (error?.type === 'stderr') reportStderr(String(error.message || ''));
    mainWindow?.webContents.send('acp:error', { ...error, sessionId });
  });
  /* 接线之前（connect / newSession / loadSession 期间）的 stderr —— MCP 初始化失败就在这一段 */
  for (const message of client.takeEarlyStderr()) reportStderr(message);
  client.on('disconnected', () => {
    logger.info('session', `disconnected sessionId=${sessionId} cli=${entry.cliSessionId} busy=${entry.busy} remote=${!!entry.profile.remote?.sshHost}`);
    // Identity guard: a detached executor's process 'close' fires asynchronously.
    // If the session was already re-attached (move-reset, LRU, reconnect), the
    // map now holds a DIFFERENT entry — this stale event must not delete it or
    // spuriously notify the renderer.
    if (sessionClients.get(sessionId) !== entry) return;
    sessionClients.delete(sessionId);
    const rec = store.readRecord(sessionId);
    if (rec) { rec.executorState = 'detached'; store.writeRecord(rec); }
    mainWindow?.webContents.send('acp:disconnected', { sessionId });
  });
}

/** Flush the accumulated assistant message to the durable transcript (called on
 *  turn completion). No-op if nothing accumulated. */
function flushAssistant(sessionId: string) {
  const entry = sessionClients.get(sessionId);
  // A wedge note alone is enough to persist: a turn cut before it produced
  // anything still owes the user an explanation for why it stopped.
  if (!entry || (!entry.assistantBuf && entry.fileChanges.length === 0 && !entry.wedgeNote)) return;
  const finalId = entry.assistantMsgId || `a_${Date.now()}`;
  const finalText = entry.wedgeNote
    ? (entry.assistantBuf ? `${entry.assistantBuf}\n\n${entry.wedgeNote}` : entry.wedgeNote)
    : entry.assistantBuf;
  store.appendMessage(sessionId, {
    id: finalId,
    role: 'assistant',
    content: finalText,
    ts: Date.now(),
    ...(entry.fileChanges.length > 0 ? { toolCalls: entry.fileChanges } : {}),
  });
  // Keep the rendered history.md in step with the conversation, so the path the
  // backend was given never points at a frozen snapshot of an older turn.
  refreshHistoryFile(sessionId);
  // AUTHORITATIVE RECONCILE: main accumulates every chunk, the renderer can miss
  // trailing ones (its append is gated on the session still being marked
  // streaming). Ship the complete text so the on-screen message can never end up
  // shorter than what was actually produced (observed: reply cut mid-sentence in
  // the UI while the transcript on disk was complete).
  if (finalText && !entry.priming) {
    mainWindow?.webContents.send('acp:assistant-final', {
      sessionId,
      messageId: finalId,
      text: finalText,
    });
  }
  entry.assistantBuf = '';
  entry.assistantMsgId = null;
  entry.fileChanges = [];
  entry.wedgeNote = undefined;
}

/** Actively detach one session's executor: free the slot immediately, kill the
 *  kiro-cli process, mark the record dormant, and tell the renderer (dot ->
 *  dormant). The session's durable transcript + memory are untouched; a later
 *  prompt/open transparently re-attaches (loadSession).
 *
 *  Returns the disconnect promise (never rejects) so `purgeSession` can wait for
 *  the process to really be gone before moving its directory; every other caller
 *  ignores it, exactly as before. `killTree` is the delete path only: on Windows it
 *  also ends the processes kiro-cli started (see `AcpClient.disconnect`). */
function detachExecutor(sessionId: string, opts: { killTree?: boolean } = {}): Promise<void> {
  const entry = sessionClients.get(sessionId);
  if (!entry) return Promise.resolve();
  sessionClients.delete(sessionId); // free the slot synchronously
  let disconnected: Promise<void> = Promise.resolve();
  try {
    disconnected = Promise.resolve(entry.client.disconnect(opts.killTree ? { killTree: true } : undefined)).catch(() => {});
  } catch { /* process may already be gone */ }
  const rec = store.readRecord(sessionId);
  if (rec) { rec.executorState = 'detached'; store.writeRecord(rec); }
  /*
    **本地工具通道也要收掉**：token 立刻作废（远端那条 ssh 已经没了，隧道也就没了，
    但 token 留着就等于一把还能用的钥匙），远端那份临时 agent 顺手删掉，
    否则远端的 `~/.kiro/agents` 会按会话数量一直长。
  */
  releaseLocalTools(sessionId, entry.profile.remote);
  mainWindow?.webContents.send('acp:disconnected', { sessionId });
  return disconnected;
}

/** LRU auto-detach: before attaching another executor, evict the least-recently-
 *  used NON-busy executor(s) until there is room under the cap. This removes the
 *  hard ceiling — dormant sessions are unbounded and the coldest live one is
 *  recycled on demand. `excludeId` protects the session about to be (re)attached.
 *  If every live executor is busy (all mid-turn), we cannot evict and the caller
 *  falls back to rejecting, so a streaming turn is never killed. */
function ensureExecutorCapacity(excludeId?: string): boolean {
  /**
   * 回收谁 —— 先按「回收它的代价」分层,同层内才比最近使用时间。
   *
   * 「我要求这个窗口和功能修改不影响其他会话的进行」:正在跑的回合本来就不会被回收(下面 `e.busy` 那一跳),
   * 可**空闲**会话被回收之后并不是没事 —— 它再连上时后端已经没有这段历史了,于是欠一次重建,变成占用状态,
   * 它自己排着的消息也要等在重建后面。也就是说 flow 起几个会话,可能让你另一条对话「突然要重建」。
   *
   * 所以代价排序:
   *   0  没有 transcript —— 什么都不欠,回收它等于免费
   *   1  ride-along —— 上下文搭在下一条消息上,不需要单独一轮
   *   2  primeMode: 'full' —— 真的要一轮一轮重放,最贵,最后才动
   * 这不改变「不杀正在跑的」这条硬规则,只是在能选的人里选伤害最小的那个。
   */
  const evictionCost = (id: string): number => {
    try {
      if (store.transcriptFileSize(id) <= 0) return 0;
      return store.readRecord(id)?.primeMode === 'full' ? 2 : 1;
    } catch { return 1; }
  };
  while (sessionClients.size >= MAX_CONCURRENT_SESSIONS) {
    let victim: string | null = null;
    let best: { cost: number; used: number } | null = null;
    for (const [id, e] of sessionClients) {
      if (id === excludeId || e.busy) continue;
      const candidate = { cost: evictionCost(id), used: e.lastUsedAt ?? 0 };
      if (!best || candidate.cost < best.cost || (candidate.cost === best.cost && candidate.used < best.used)) {
        best = candidate;
        victim = id;
      }
    }
    if (!victim) return false; // all remaining executors are busy — cannot evict
    // 记下代价:一条对话「为什么突然要重建」必须查得出来
    logger.info('executor', `evicting ${victim} for ${excludeId || 'a new session'} (cost=${best?.cost}, idle since ${best?.used})`);
    detachExecutor(victim);
  }
  return true;
}

// Enforce single instance to prevent localStorage/leveldb corruption from
// multiple processes (the tray keeps the app alive after closing the window)
const gotSingleInstanceLock = app.requestSingleInstanceLock();
/** Distinct exit code so the dev supervisor can tell "another instance owns the
 *  lock" apart from "the code I just compiled is broken" -- retrying the first case
 *  forever is pointless, and that is what a bare non-zero exit looked like. */
const EXIT_CODE_ALREADY_RUNNING = 42;
if (!gotSingleInstanceLock) {
  // Say so. This used to quit in total silence, which is indistinguishable from
  // "the app will not start": a stale instance (e.g. one left behind by a dev
  // session whose window never rendered) holds the lock, so every relaunch died
  // instantly with nothing but `main process starting` in the log. Naming it is the
  // difference between a 30-second fix and a hunt.
  /* 收拾办法按平台给 —— 这是 app 拒绝启动时唯一的一句话，叫 Windows 用户去跑 `pkill` 没用 */
  const howToKill = process.platform === 'win32'
    ? '任务管理器里结束 KiroLex / electron，或者 `taskkill /F /IM electron.exe`'
    : '退掉它（Cmd-Q）或者 `pkill -f "kirolex/node_modules/electron"`';
  logger.info('app', 'another KiroLex instance already holds the single-instance lock -> exiting. '
    + `If no window is visible, that instance is stale: ${howToKill}.`);
  app.exit(EXIT_CODE_ALREADY_RUNNING);
} else {
  app.on('second-instance', () => {
    // Someone tried to launch a second instance - focus our window instead, but
    // only if the initial gated reveal already happened (never force-show a
    // still-loading window).
    if (mainWindow && mainWindowRevealed) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Load full shell environment (proxy, PATH, etc.) for subprocess spawning
function getShellEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PATH: process.platform === 'win32'
      ? process.env.PATH || ''
      : `${os.homedir()}/.local/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ''}`,
  };

  if (process.platform === 'win32') {
    // Read Windows system proxy from registry
    try {
      const regOutput = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { encoding: 'utf-8', timeout: 3000 }
      );
      const proxyEnabled = regOutput.includes('0x1');

      if (proxyEnabled) {
        const serverOutput = execSync(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
          { encoding: 'utf-8', timeout: 3000 }
        );
        const match = serverOutput.match(/ProxyServer\s+REG_SZ\s+(.+)/);
        if (match) {
          const proxyServer = match[1].trim();
          const proxyUrl = proxyServer.startsWith('http') ? proxyServer : `http://${proxyServer}`;
          env.HTTP_PROXY = proxyUrl;
          env.HTTPS_PROXY = proxyUrl;
          env.http_proxy = proxyUrl;
          env.https_proxy = proxyUrl;

          // Read NO_PROXY / ProxyOverride
          try {
            const overrideOutput = execSync(
              'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride',
              { encoding: 'utf-8', timeout: 3000 }
            );
            const overrideMatch = overrideOutput.match(/ProxyOverride\s+REG_SZ\s+(.+)/);
            if (overrideMatch) {
              const noProxy = overrideMatch[1].trim().replace(/;/g, ',');
              env.NO_PROXY = noProxy;
              env.no_proxy = noProxy;
            }
          } catch {}
        }
      }
    } catch {}
  } else {
    // macOS/Linux: try sourcing shell profile to get proxy and other vars
    try {
      const shellOutput = execSync(
        'source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null; echo "HTTP_PROXY=$HTTP_PROXY"; echo "HTTPS_PROXY=$HTTPS_PROXY"; echo "ALL_PROXY=$ALL_PROXY"; echo "NO_PROXY=$NO_PROXY"',
        { encoding: 'utf-8', shell: '/bin/zsh', timeout: 3000 }
      ).trim();

      for (const line of shellOutput.split('\n')) {
        const [key, ...rest] = line.split('=');
        const value = rest.join('=');
        if (key && value) {
          env[key] = value;
        }
      }
    } catch {}
  }

  return env;
}

const shellEnv = getShellEnv();

// Apply proxy to Electron's own network stack
if (shellEnv.HTTP_PROXY || shellEnv.HTTPS_PROXY) {
  const proxyUrl = shellEnv.HTTPS_PROXY || shellEnv.HTTP_PROXY;
  app.commandLine.appendSwitch('proxy-server', proxyUrl!);
  if (shellEnv.NO_PROXY) {
    app.commandLine.appendSwitch('proxy-bypass-list', shellEnv.NO_PROXY);
  }
}

/** Run a CLI command WITHOUT blocking the main process. Always bounded.
 *
 *  `execSync` halts the ENTIRE Electron main process: the event loop stops, no IPC
 *  is serviced, no window repaints, every chat freezes -- for as long as the child
 *  takes. So a wedged `kiro-cli` did not just break one chat, it took the whole app
 *  down with it, which is never an acceptable coupling: the UI must survive its
 *  backend misbehaving.
 *
 *  Worst of the four call sites was `acp:list-models`, which had NO timeout and NO
 *  catch, and runs on EVERY renderer load (App.tsx populates the model list on
 *  mount) -- so one `kiro-cli chat --list-models` that never returned froze KiroLex
 *  permanently, with nothing logged because the logger could not run either.
 *
 *  `timeoutMs` is required, not optional: an unbounded external call is exactly the
 *  bug being removed here. On timeout the child is SIGKILLed and the promise
 *  rejects, so callers fall back (cached model list, empty listing) instead of
 *  waiting on a process that is never going to answer.
 *
 *  @param command Full shell command line (`shell: true`, so redirections such as
 *    `2>&1` work on both cmd.exe and POSIX shells).
 *  @param timeoutMs Hard wall-clock budget; the child is killed when it elapses.
 *  @returns The child's stdout. Rejects on timeout, non-zero exit, or spawn failure.
 */
function runCli(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, {
      encoding: 'utf-8',
      env: shellEnv,
      shell: true,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        // On Windows there are no real signals; Node still sets `killed` when it
        // terminates the child for exceeding `timeout`, so that is the primary test.
        const timedOut = (err as any).killed === true || (err as any).signal === 'SIGKILL';
        if (timedOut) logger.warn('cli', `timed out after ${timeoutMs}ms (killed): ${command}`);
        reject(timedOut ? new Error(`\`${command}\` did not answer within ${timeoutMs}ms`) : err);
        return;
      }
      resolve(String(stdout ?? ''));
    });
  });
}

/** Run a `kiro-cli …` command line against the RESOLVED executable.
 *
 *  These helpers used to shell out to the bare name `kiro-cli`, i.e. they depended on
 *  PATH, while the ACP executor resolved the binary by searching known install
 *  locations. The two disagreed in two real cases:
 *    - the binary is reachable only through `KIRO_CLI_PATH`, with PATH untouched;
 *    - WINDOWS, where `getShellEnv()` deliberately leaves PATH alone and the
 *      installer drops `kiro-cli.exe` under %LOCALAPPDATA%.
 *  In both, chats worked while the model list, agent list, session list and the usage
 *  panel silently failed. Routing through the same resolver keeps them consistent.
 *
 *  The path is quoted because install locations can contain spaces. If nothing
 *  resolves, the bare name is used as a last resort so a PATH-only install still works.
 *
 *  @param argsLine Everything after the executable, e.g. `chat --list-models --format json`.
 *  @param timeoutMs Hard wall-clock budget, forwarded to runCli.
 */
/**
 * SINGLE-FLIGHT 槽位：这两条命令在渲染进程挂载时会被并发发起两次，而每次 spawn 都要付 kiro-cli
 * 完整启动开销（含加载全部 MCP server）—— 两个一起启就双双超时。实测裸跑 2.6–3.7 秒，应用里却在
 * 10s/15s 被 kill 了 13 次。合并成一次调用是治因，不是调参。
 */
let listModelsInFlight: Promise<any> | null = null;
let listAgentsInFlight: Promise<string> | null = null;

function runKiroCli(argsLine: string, timeoutMs: number): Promise<string> {
  /*
    **设置里没配就不跑** ——「所有的会话必须用 setting 里面设置的本地或远程 agent 起任务，
    如果设置是空的不应该起任何连接」。这里是模型列表 / agent 列表 / usage 那几条路，
    它们必须和执行器**用同一个二进制**：不一致的表现是"聊天能用，但模型列表少几个"。
  */
  const problem = kiroBinProblem();
  if (problem) return Promise.reject(new Error(problem));
  return runCli(`"${resolveKiroCli()}" ${argsLine}`, timeoutMs);
}

// Each session gets its own directory to avoid cwd collision
const sessionsBaseDir = path.join(os.homedir(), '.kirolex', 'sessions');
function getSessionDir(sessionId?: string): string {
  const id = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(sessionsBaseDir, id);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// (per-model getClient removed — executors are now created per-session in the
//  acp:new-session / acp:load-session handlers, keyed by sessionId.)

/** Windows / Linux 自己画的标题条有多高（无边框窗口；最大化时它自动隐藏，见渲染层 .win-titlebar）。 */
const WIN_TITLEBAR_HEIGHT = 32;

function createWindow() {
  startupMark('createWindow: start');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    /*
      **Windows / Linux 不要系统那条白色标题栏** ——「全屏模式下总有一个上面的白框，kirolex 标题」→
      「能让上面这个程序框自动隐藏吗」。
      第一版用的是 titleBarOverlay（系统画三个按钮）—— 但系统那三个按钮**藏不掉**，于是最大化时那条
      没法自动隐藏。所以改成完全无边框（frame: false），最小化 / 最大化 / 关闭由渲染层自己画（window:control），
      标题条在最大化时自动收起、鼠标碰到顶边才滑下来。代价只有一个：Win11 悬停最大化按钮弹出的
      「贴靠布局」菜单没了（那是系统按钮自带的）；拖到屏幕边贴靠、双击标题条最大化、边缘拖拽缩放都还在。
    */
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? {} : { frame: false }),
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    show: false, // Hidden until connected
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Remove menu bar entirely on Windows/Linux
  if (process.platform !== 'darwin') {
    mainWindow.setMenuBarVisibility(false);
    mainWindow.setMenu(null);
    /* 最大化 / 全屏时渲染层把标题条收起来（自动隐藏），还原时放回去（kiroApi.onWindowMaximized） */
    const win = mainWindow;
    const applyTitleBar = (): void => {
      if (win.isDestroyed()) return;
      const maximized = win.isMaximized() || win.isFullScreen();
      win.webContents.send('window:maximized', { maximized, height: WIN_TITLEBAR_HEIGHT });
    };
    for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) win.on(ev as any, applyTitleBar);
    win.webContents.on('did-finish-load', applyTitleBar);
  }

  // EVERY web link leaves the app — always to the OS default browser, never into
  // an Electron window. The renderer already routes normal clicks through
  // openExternal, but that only covers plain left-clicks on our own anchors:
  // cmd/middle-click, target=_blank, window.open and dropping a URL onto the
  // window all bypass it. Without these two guards the first opens a bare
  // Electron window and the second NAVIGATES THE APP AWAY from its own UI
  // (looks like KiroLex crashed and needs a restart). Local file paths are
  // unaffected: they never become real hrefs — they open in KiroLex's own viewer.
  const EXTERNAL_SCHEME = /^(https?:|mailto:|tel:)/i;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_SCHEME.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() || '';
    if (url === current) return;            // in-page reload
    if (/^(file:|http:\/\/localhost:5173)/i.test(url) && !EXTERNAL_SCHEME.test(url)) return; // own UI
    event.preventDefault();
    if (EXTERNAL_SCHEME.test(url)) void shell.openExternal(url);
  });

  /*
    **界面缩放快捷键**：Ctrl(⌘) + 加号 / 减号 / 0。在这里拦，不在页面 keydown 里拦：
    这里先于页面拿到按键，光标在输入框里也一样；macOS 自带菜单的 ⌘=/⌘-/⌘0 也被挡下，
    不会绕过设置自己改缩放。真正的值在渲染端的设置里（settings.uiZoom），这里只把「哪一下」告诉它。
  */
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const action = zoomKeyAction(input, process.platform);
    if (!action) return;
    event.preventDefault();
    mainWindow?.webContents.send('app:ui-zoom-key', action);
  });

  // Renderer load lifecycle: this is the phase that owns most of the unexplained
  // gap (dev serves hundreds of unbundled modules; production loads one bundle).
  mainWindow.webContents.on('did-start-loading', () => startupMark('renderer: did-start-loading'));
  mainWindow.webContents.on('dom-ready', () => startupMark('renderer: dom-ready'));
  mainWindow.webContents.on('did-finish-load', () => startupMark('renderer: did-finish-load'));
  /**
   * **加载失败要自己重来，不能留一个白屏** ——「现在根本看不到东西」。
   *
   * 原来这里只记一行日志，而重试只发生在**启动**那一次（`loadDevServer` 的 promise 被 reject）。
   * 于是 Vite 一重启（它自己会 restart，比如多出一个 html 入口时），窗口那一瞬间加载失败，
   * 之后**没有任何人再加载它** —— 实测的表现就是：Vite 好着（5173 返回 200），
   * 而窗口里连 `#root` 都没有、标题退化成 `localhost:5173`。人看到的是"整个 app 没了"。
   */
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    startupMark('renderer: did-fail-load', `code=${code} ${desc}`);
    if (!IS_DEV || !isMainFrame) return;
    logger.warn('app', `renderer 加载失败（${code} ${desc}）—— 重新加载 ${DEV_SERVER_URL}`);
    reloadDevServer?.(1);
  });

  if (IS_DEV) {
    // Vite dev server = renderer HMR: editing src/renderer/** takes effect in
    // milliseconds with no rebuild and no restart. Retry the load, because the
    // supervisor may launch Electron before Vite has finished binding the port --
    // without this the window just sits blank and looks like a crash.
    const loadDevServer = (attempt = 1) => {
      mainWindow?.loadURL(DEV_SERVER_URL).catch(() => {
        if (attempt <= 30 && mainWindow && !mainWindow.isDestroyed()) {
          logger.info('app', `dev server not up yet (${DEV_SERVER_URL}), retry ${attempt}/30`);
          setTimeout(() => loadDevServer(attempt + 1), 500);
        }
      });
    };
    /* 同一条重试逻辑给 `did-fail-load` 用（Vite 重启后的白屏走这条） */
    reloadDevServer = (attempt: number) => { setTimeout(() => loadDevServer(attempt), 400); };
    loadDevServer();
    // DevTools no longer auto-opens in dev; opt in with KIROLEX_DEVTOOLS=1.
    if (process.env.KIROLEX_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools();
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Minimize to tray on close instead of quitting
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  // Lightning bolt (⚡) drawn programmatically — the packaged app only ships
  // dist/, so there is no icon file on disk to load here.
  //
  // Hand-crafted at 16x16 but rasterized at 2x: Windows scales tray icons to the
  // display DPI and 125%/150% is the laptop default, so a 16x16 source is visibly
  // blurry. Declaring scaleFactor keeps it a logical 16x16 image.
  const LOGICAL = 16;
  const SCALE = 2;
  const size = LOGICAL * SCALE;
  const canvas = Buffer.alloc(size * size * 4);

  // NOTE: nativeImage raw bitmaps are BGRA-ordered, not RGBA — writing R first
  // rendered the bolt sky-blue instead of gold.
  const setPixel = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || x >= LOGICAL || y < 0 || y >= LOGICAL) return;
    for (let dy = 0; dy < SCALE; dy++) {
      for (let dx = 0; dx < SCALE; dx++) {
        const idx = ((y * SCALE + dy) * size + (x * SCALE + dx)) * 4;
        canvas[idx] = b;
        canvas[idx + 1] = g;
        canvas[idx + 2] = r;
        canvas[idx + 3] = a;
      }
    }
  };

  // Lightning bolt pixels (hand-crafted 16x16)
  const boltPixels = [
    [8,0],[9,0],[10,0],
    [7,1],[8,1],[9,1],
    [6,2],[7,2],[8,2],
    [5,3],[6,3],[7,3],
    [4,4],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[11,4],
    [4,5],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],
    [7,6],[8,6],[9,6],[10,6],
    [8,7],[9,7],[10,7],
    [7,8],[8,8],[9,8],
    [6,9],[7,9],[8,9],
    [5,10],[6,10],[7,10],
    [4,11],[5,11],[6,11],
    [5,12],[6,12],
    [6,13],[7,13],
    [7,14],
    [8,15],
  ];

  for (const [x, y] of boltPixels) {
    setPixel(x, y, 255, 184, 0, 255); // Golden yellow
  }

  const icon = nativeImage.createFromBuffer(canvas, { width: size, height: size, scaleFactor: SCALE });

  tray = new Tray(icon);
  tray.setToolTip('KiroLex');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show KiroLex',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 320,
    height: 200,
    frame: false,
    resizable: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const splashHtml = `
    <html>
    <body style="margin:0; display:flex; align-items:center; justify-content:center; height:100vh; background:#1a1a1a; border-radius:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#e8e8e8; user-select:none;">
      <div style="text-align:center;">
        <div style="font-size:40px; margin-bottom:12px;">⚡</div>
        <div style="font-size:16px; font-weight:600; margin-bottom:16px;">KiroLex</div>
        <div id="splash-status" style="font-size:12px; color:#a0a0a0; margin-bottom:12px;">Starting…</div>
        <div style="width:120px; height:3px; background:#333; border-radius:2px; margin:0 auto; overflow:hidden;">
          <div style="width:40px; height:100%; background:#7c6fe0; border-radius:2px; animation:loading 1.2s ease-in-out infinite;"></div>
        </div>
      </div>
      <style>
        html, body {
          -webkit-app-region: drag;
          app-region: drag;
          cursor: grab;
        }
        body:active { cursor: grabbing; }
        @keyframes loading {
          0% { transform: translateX(-40px); }
          100% { transform: translateX(120px); }
        }
      </style>
    </body>
    </html>
  `;

  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml)}`);
  splashWindow.center();
  splashWindow.show();
}

function showMainWindow() {
  if (splashWindow) {
    splashWindow.close();
    splashWindow = null;
  }
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindowRevealed = true;
  }
}

app.whenReady().then(async () => {
  startupMark('app ready');
  // Carry the UI state off the origin-scoped localStorage BEFORE any window opens:
  // preload hands the renderer a synchronous snapshot, so the shared store has to
  // be populated by then or the first paint uses defaults (no project groups, 1x1
  // split) even though the data exists.
  try { await migrateUiStateFromFileOrigin(); } catch {}
  // Immediately after the migration, so a key the sweep might have re-imported is
  // gone before the renderer ever receives its snapshot.
  try { pruneDeadUiStateKeys(); } catch {}
  // A fresh process means a fresh composer: drafts are kept on disk so they survive a
  // renderer reload mid-run, and dropped here so they never survive a restart.
  try { clearRunScopedUiState(); } catch {}
  startupMark('ui-state migration done');
  // Age out trashed chats (30 days). Deliberately after the migration and before
  // anything else touches the sessions tree.
  /**
   * **kiro-cli 那几个日志超限就就地截断** ——「这些进程仍持有已经删除的 kiro-chat.log、lsp.log，
   * 共占 21.72GB」。
   *
   * kiro-cli 自己不轮转它们（实测一个执行器就攥着 7.86 GB + 5.60 GB），而 KiroLex 只管自己那份。
   * 判据和"为什么是截断不是删除"都在 `trimHugeCliLogs` 里 —— 删掉的话正在写它的进程会把空间
   * 一直攥到退出为止，那就是这次 21.72 GB 的成因。
   *
   * 放在起执行器**之前**：这时候还没有人持着新 fd，截断最干净。
   */
  const trimCliLogsNow = async (why: string, host: HostOps = diagHost()) => {
    try {
      const trim = await trimHugeCliLogs(host);
      if (trim.trimmed.length) {
        logger.warn('logs', `kiro-cli 日志超限已就地截断（${why}），回收 ${(trim.freed / 2 ** 30).toFixed(2)} GB：`
          + trim.trimmed.map((f) => `${f.name} ${(f.bytes / 2 ** 30).toFixed(2)}GB`).join('、'));
      }
    } catch {}
  };
  /* 等它做完再往下：这一步的全部意义是"在还没人持着新 fd 的时候截断"，不等就没有这个性质了 */
  await trimCliLogsNow('启动');
  /**
   * **每半小时再扫一次** ——「一次启动检查兜不住」。
   *
   * 实测这台机器上 app 能连着跑 24 小时以上，而 `lsp.log` 在那段时间里长到 5.6 GB ——
   * 只在启动时看一眼，等于把上限交给"你多久重启一次"。半小时一次：日志再怎么长也就多那半小时的量，
   * 而截断本身是一次 `truncate`（不读内容、不复制），代价可以忽略。
   */
  setInterval(() => { void trimCliLogsNow('定时'); }, 30 * 60 * 1000).unref?.();
  // Age out trashed chats (30 days). Deliberately after the migration and before
  // anything else touches the sessions tree.
  try { pruneSessionTrash(); } catch {}
  startupMark('trash pruned');
  // No executors survive a restart — reset any stale live executorState so the
  // durable records are truthful from boot.
  try { store.markAllExecutorsDetached(); } catch {}
  // Retry deletions that could not finish last run (locked files) and keep those
  // ids suppressed so a half-deleted chat never comes back.
  try {
    const pending = loadSessionTombstones();
    if (pending.length) {
      const stillThere: string[] = [];
      for (const id of pending) {
        deletedSessionIds.add(id);
        const dir = path.join(os.homedir(), '.kirolex', 'sessions', id);
        try {
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
          if (fs.existsSync(dir)) stillThere.push(id);
        } catch { stillThere.push(id); }
      }
      saveSessionTombstones(stillThere);
      logger.info('delete-session', `retried ${pending.length} pending deletion(s); ${stillThere.length} still locked`);
    }
  } catch {}

  // Sweep leftovers nothing else owns:
  //   *.bak / *.bak.<ts>  — one-off backups from past migrations/scripts. Nothing in
  //                         the app writes these, so an old one is pure residue.
  //   *.tmp               — every durable write is "write .tmp then rename", which is
  //                         atomic and leaves no trace. A .tmp that survived is the
  //                         debris of a crash mid-write, and it will never be reused.
  // Both are age-gated so an in-flight write or a backup taken minutes ago is safe.
  try {
    const home = os.homedir();
    const BAK_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // keep a month of manual backups
    const TMP_MAX_AGE_MS = 24 * 3600 * 1000;      // a real .tmp lives milliseconds
    const dirs = [path.join(home, '.kirolex')];
    const sessionsDir = path.join(home, '.kirolex', 'sessions');
    try {
      for (const id of fs.readdirSync(sessionsDir)) {
        const d = path.join(sessionsDir, id);
        if (fs.statSync(d).isDirectory()) dirs.push(d);
      }
    } catch { /* no sessions yet */ }
    let removed = 0;
    let bytes = 0;
    for (const dir of dirs) {
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        const isBak = /\.bak(\.|$)/.test(name);
        const isTmp = name.endsWith('.tmp');
        if (!isBak && !isTmp) continue;
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          const age = Date.now() - st.mtimeMs;
          if (age < (isBak ? BAK_MAX_AGE_MS : TMP_MAX_AGE_MS)) continue;
          fs.unlinkSync(full);
          removed++; bytes += st.size;
        } catch { /* skip anything we cannot stat/remove */ }
      }
    }
    if (removed) {
      logger.info('cleanup', `removed ${removed} stale .bak/.tmp file(s), ${Math.round(bytes / 1024)} KB`);
    }
  } catch {}

  // GC of pasted blobs — images AND text — in ONE reference-aware pass.
  //
  // The image directory used to be wiped wholesale on every boot ("leftover temp
  // files"), which silently destroyed every image the user had pasted into a chat:
  // the transcript kept the attachment path, the file was gone, so reopening the
  // chat showed a dead chip and history re-injection handed the model a `file:`
  // reference to nothing. A pasted blob is NOT a temp file — it is the only copy of
  // that message's content. So delete exactly what no surviving transcript
  // references (chat deleted, or a blob abandoned before sending) and keep the rest.
  try {
    const home = os.homedir();
    const dirs = [
      path.join(home, '.kirolex', 'pasted'),  // images
      path.join(home, '.kirolex', 'pastes'),  // text blobs
    ].filter((d) => fs.existsSync(d));
    if (dirs.length) {
      const referenced = new Set<string>();
      for (const rec of store.listSessions()) {
        for (const m of store.readTranscript(rec.id) as any[]) {
          for (const a of (m?.attachments || [])) if (a?.path) referenced.add(path.resolve(a.path));
          for (const p of (m?.pastes || [])) if (p?.path) referenced.add(path.resolve(p.path));
        }
      }
      // An unsent draft's blobs are referenced too — deleting them would leave the
      // composer holding a placeholder that can never expand again. Only THIS run's
      // drafts can matter: composer text is no longer restored across a restart, so
      // yesterday's entries reference blobs no composer will ever ask for again. They
      // are cleared below, after the GC has had its look, and the 24h grace above
      // still protects anything pasted recently.
      for (const blocks of Object.values(loadDraftPastes())) {
        for (const b of (blocks || [])) if (b?.path) referenced.add(path.resolve(b.path));
      }
      const GRACE_MS = 24 * 3600 * 1000; // freshly pasted, not yet in any draft/transcript
      let removed = 0;
      let kept = 0;
      for (const dir of dirs) {
        for (const f of fs.readdirSync(dir)) {
          const full = path.resolve(path.join(dir, f));
          if (referenced.has(full)) { kept++; continue; }
          try {
            if (Date.now() - fs.statSync(full).mtimeMs < GRACE_MS) { kept++; continue; }
            fs.unlinkSync(full); removed++;
          } catch {}
        }
      }
      logger.info('pastes', `GC kept ${kept} referenced/recent blob(s), removed ${removed} orphan(s)`);
    }
  } catch {}

  // Start with no draft paste references. Composer text does not survive a restart any
  // more, so every entry here belongs to a draft that no longer exists; keeping them
  // would pin their blobs against the GC forever. The renderer re-registers a session's
  // blocks as soon as something is pasted in this run.
  try {
    const stale = Object.keys(loadDraftPastes()).length;
    if (stale) {
      saveDraftPastes({});
      logger.info('pastes', `dropped draft paste refs for ${stale} chat(s): drafts do not survive a restart`);
    }
  } catch { /* best-effort */ }

  createTray();
  createSplashWindow();
  createWindow();

  // The main window is revealed ONLY by the renderer after disk hydration,
  // initial transcript restore, and eager session attach complete. There is no
  // time-based fallback: a slow load must stay behind the splash rather than
  // exposing a partially-loaded chat UI.

  // IPC handlers
  ipcMain.handle('acp:connect', async () => {
    // Backend readiness only — does NOT reveal. The window is shown via
    // acp:reveal after the renderer finishes warming sessions behind the splash.
    return { connected: true };
  });

  // Update the splash status line while the renderer warms sessions behind it.
  ipcMain.handle('acp:splash-status', async (_event, text: string) => {
    try {
      if (splashWindow && !splashWindow.isDestroyed()) {
        await splashWindow.webContents.executeJavaScript(
          `(function(){var e=document.getElementById('splash-status'); if(e) e.textContent=${JSON.stringify(String(text))};})()`
        );
      }
    } catch { /* splash may have closed */ }
    return { ok: true };
  });

  // Reveal the main window only after the renderer explicitly reports that
  // hydration, initial transcript restore, and eager attach are complete.
  /* ------------------------------------------------------------ S3 备份 IPC */

  ipcMain.handle('s3:get-config', async () => {
    const cfg = loadSyncConfig();
    /* **secret 一个字节都不回渲染层** —— 它只需要知道"填过了"。回去一次就多一个泄漏面。 */
    return {
      enabled: !!cfg.enabled,
      bucket: cfg.bucket || '',
      region: cfg.region || '',
      prefix: cfg.prefix || '',
      endpoint: cfg.endpoint || '',
      intervalMinutes: Number(cfg.intervalMinutes) || DEFAULT_INTERVAL_MINUTES,
      accessKeyId: cfg.accessKeyId || '',
      hasSecret: !!cfg.secretCipher,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      last: lastSyncSummary,
    };
  });

  ipcMain.handle('s3:save-config', async (_event, input: any) => {
    const cur = loadSyncConfig();
    const next: SyncConfig = {
      ...cur,
      /*
        **键在 input 里才动它** —— 和机器配置那边同一条规矩：漏传一个字段不该等于"清空它"。
        secret 尤其：不传 = 不改（界面上那个框平时是空的，因为我们从不回传明文）。
      */
      ...(input?.enabled !== undefined ? { enabled: !!input.enabled } : null),
      ...(input?.bucket !== undefined ? { bucket: String(input.bucket).trim() } : null),
      ...(input?.region !== undefined ? { region: String(input.region).trim() } : null),
      ...(input?.prefix !== undefined ? { prefix: String(input.prefix).trim() } : null),
      ...(input?.endpoint !== undefined ? { endpoint: String(input.endpoint).trim() } : null),
      ...(input?.intervalMinutes !== undefined ? { intervalMinutes: Math.max(5, Number(input.intervalMinutes) || DEFAULT_INTERVAL_MINUTES) } : null),
      /*
        **不同步的项目** ——「有些project可以选择不同步」。去重并只收字符串：
        这张表会被用来和 `projectId` 做 `includes` 比较，混进一个数字就是一条永不命中的规则。
      */
      ...(Array.isArray(input?.excludeProjects)
        ? {
          excludeProjects: (input.excludeProjects as unknown[])
            .filter((v): v is string => typeof v === 'string')
            .filter((v, i, a) => a.indexOf(v) === i),
        }
        : null),
      /* 不同步的会话：同一套清洗（只收非空字符串、去重） */
      ...(Array.isArray(input?.excludeSessions)
        ? {
          excludeSessions: (input.excludeSessions as unknown[])
            .filter((v): v is string => typeof v === 'string' && !!v)
            .filter((v, i, a) => a.indexOf(v) === i),
        }
        : null),
      ...(input?.accessKeyId !== undefined ? { accessKeyId: String(input.accessKeyId).trim() } : null),
    };
    if (typeof input?.secretAccessKey === 'string' && input.secretAccessKey.trim()) {
      next.secretCipher = encryptSecret(input.secretAccessKey.trim());
    }
    if (input?.clearSecret) delete next.secretCipher;
    saveSyncConfig(next);
    rescheduleS3Sync();
    logger.info('s3', `配置已保存 bucket=${next.bucket} region=${next.region} key=${maskKeyId(next.accessKeyId)}`
      + ` 定时=${next.enabled ? `${next.intervalMinutes}分钟` : '关'}`);
    return { ok: true };
  });

  /**
   * 测连通：写一个小对象再读回来。
   *
   * 为什么要**写**而不是只 LIST：备份的动作是 PutObject，而 `s3:ListBucket` 和 `s3:PutObject`
   * 是两条独立的权限 —— 只列成功的话，人会以为配好了，然后在第一次定时同步时才发现不能写。
   */
  ipcMain.handle('s3:test', async () => {
    const { creds, problem } = syncCredsOrProblem();
    if (problem) return { ok: false, error: problem };
    const cfg = loadSyncConfig();
    const key = `${keyFor(cfg.prefix, '.kirolex-write-test')}`;
    const stamp = new Date().toISOString();
    try {
      await putObject(creds!, key, Buffer.from(stamp), 'text/plain');
      const back = await getObject(creds!, key);
      if (back.toString('utf-8') !== stamp) return { ok: false, error: '写进去又读回来的内容不一致 —— 桶上可能有改写内容的策略。' };
      /*
        **写完就删掉** ——「测试应该是写完然后删除」。留着那个 `.kirolex-write-test`
        是往用户桶里扔垃圾，而且每次测都会覆盖它 —— 桶开了版本控制的话还会攒一堆版本。

        删不掉**不算测试失败**：这条测试要证明的是"能读能写"，而那两件事已经成立了。
        但必须**说出来** —— 桶里留了个对象、以及"这个 key 没有 DeleteObject 权限"
        都是用户该知道的事（后者会让以后的清理动作也失败）。
      */
      let leftover = '';
      try {
        await deleteObject(creds!, key);
      } catch (delErr: any) {
        leftover = `（测试对象没删掉：${delErr?.message || delErr} —— 桶里留了 ${key}，`
          + `这个 key 可能没有 s3:DeleteObject）`;
      }
      return { ok: true, message: `可读可写（${cfg.bucket} / ${cfg.region}）${leftover}` };
    } catch (err: any) {
      const hint = err instanceof S3Error ? err.hint : '';
      return { ok: false, error: `${err?.message || err}${hint ? `\n${hint}` : ''}` };
    }
  });

  ipcMain.handle('s3:sync-now', async () => runS3Sync('手动'));

  /** 恢复列表：一次 GET 拿到 catalog，不 LIST 整个桶。 */
  /**
   * **有哪些项目、各有多少条会话、哪些不同步** ——「你得按 project 整理，
   * 有些project可以选择不同步」。
   *
   * 从**会话记录**现算，而不是读 ui-state 里那串项目名：这一页要回答的是
   * "同步会覆盖到哪些东西"，而那取决于会话实际归在哪个项目下。
   * 一个空项目（有名字、没会话）在这里不出现 —— 它没有任何东西要同步。
   */
  ipcMain.handle('s3:projects', () => {
    const cfg = loadSyncConfig();
    const marks = readSessionMarks(S3_MARKS_PATH);
    /*
      **哪些会话"传过但不知道什么时候"** —— 文件状态表里有它的路径就算传过。
      两个必然的错报要靠它挡住：增量同步跳过没变的文件（那些会话永远进不了 mark 表）,
      以及 mark 表是后加的（存量会话一个都没有）。见 `sessionSyncState` 那段。
    */
    const uploadedIds = new Set<string>();
    for (const rel of Object.keys(readState(S3_STATE_PATH))) {
      const sid = sessionIdOfRel(rel);
      if (sid) uploadedIds.add(sid);
    }
    interface Row { project: string; sessions: any[]; bytes: number; updatedAt: number }
    const byProject = new Map<string, Row>();
    for (const rec of store.listSessions()) {
      const key = projectOf(rec);
      const cur = byProject.get(key) || { project: key, sessions: [], bytes: 0, updatedAt: 0 };
      cur.updatedAt = Math.max(cur.updatedAt, rec.updatedAt || 0);
      let bytes = 0;
      for (const f of SESSION_FILES) {
        try { bytes += fs.statSync(path.join(KIROLEX_HOME, 'sessions', rec.id, f)).size; } catch { /* 少一个文件不算错 */ }
      }
      cur.bytes += bytes;
      /*
        **每条会话的同步状态** ——「每一个会话同步应该有最新同步到什么时间」。
        三种：从没传过 / 有改动还没备份 / 已同步。判据见 `sessionSyncState`。
      */
      cur.sessions.push({
        id: rec.id,
        title: rec.title || 'New Chat',
        updatedAt: rec.updatedAt || 0,
        bytes,
        syncedAt: marks[rec.id]?.at || 0,
        state: sessionSyncState(marks[rec.id], rec.updatedAt || 0, uploadedIds.has(rec.id)),
        excluded: sessionExcluded(cfg, rec.id),
      });
      byProject.set(key, cur);
    }
    /*
      **项目记忆的同步状态** ——「project 上面也得显示到底 project memory 是否同步了、最新时间是什么时候」。
      判据和会话那一套同一个（`sessionSyncState`）：mark 表里有就用它（精确到哪一刻传的），
      没有但文件状态表里有 = "传过但时间不明"，都没有 = 没传过。本地改动时间取文件 mtime。
    */
    const fileState = readState(S3_STATE_PATH);
    const memoryOf = (project: string) => {
      if (!project) return undefined;           // 未分组没有项目记忆
      const rel = path.join('memory', 'projects', project, 'memory.md');
      let st: fs.Stats | undefined;
      try { st = fs.statSync(path.join(KIROLEX_HOME, rel)); } catch { /* 还没有记忆文件 */ }
      if (!st) return { exists: false, bytes: 0, updatedAt: 0, syncedAt: 0, state: 'never' as const };
      const mark = marks[projectMemoryMarkKey(project)];
      const mtime = Math.floor(st.mtimeMs);
      /* 状态表里的 mtime 和现在一样 = 传上去的就是这一版 */
      const sameAsUploaded = fileState[rel]?.mtimeMs === mtime && fileState[rel]?.size === st.size;
      return {
        exists: true,
        bytes: st.size,
        updatedAt: mtime,
        syncedAt: mark?.at || 0,
        state: mark
          ? sessionSyncState(mark, mtime)
          : (sameAsUploaded ? 'synced' as const : (fileState[rel] ? 'pending' as const : 'never' as const)),
      };
    };
    const projects = [...byProject.values()]
      .map((v) => ({
        ...v,
        /* 组内也按最近动过排 —— 和恢复那一页一致 */
        sessions: v.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
        excluded: projectExcluded(cfg, v.project),
        memory: memoryOf(v.project),
      }))
      /* 未分组排最后，其余按最近动过的排 —— 你要找的通常是刚用过的那个 */
      .sort((a, b) => (a.project ? 0 : 1) - (b.project ? 0 : 1) || b.updatedAt - a.updatedAt);
    return { projects, excludeProjects: cfg.excludeProjects || [], excludeSessions: cfg.excludeSessions || [] };
  });

  ipcMain.handle('s3:list-backups', async () => {
    const { creds, problem } = syncCredsOrProblem();
    if (problem) return { entries: [], error: problem };
    const cfg = loadSyncConfig();
    try {
      const raw = await getObjectIfExists(creds!, catalogKey(cfg.prefix));
      if (!raw) return { entries: [], error: '这个桶里还没有备份（先同步一次）。' };
      const catalog = JSON.parse(raw.toString('utf-8')) as Catalog;
      const localRecs = store.listSessions();
      const local = new Set(localRecs.map((r) => r.id));
      /*
        **老 catalog 没有 `project` 字段** —— 那是这一版才加的。对还在本地的那些会话,
        项目归属可以直接从本地记录补上，于是升级之前传上去的备份也能正确分组
        （否则 33 条全挤在「未分组」里，而"按 project 整理"就等于没生效）。
        本地已经没有的那些补不了，留空 → 未分组，这是诚实的：我们确实不知道它属于哪摊。
      */
      const projectById = new Map(localRecs.map((r) => [r.id, projectOf(r)]));
      /*
        **正连着的那些也标出来** —— 恢复它们会被拒（内存里那份会把恢复的内容盖回去，
        见 `s3:restore`）。在列表里就说清，比让人勾上、点了恢复、再收到一句拒绝好：
        多选恢复的时候那一条会夹在一堆成功里，很容易被漏掉。
      */
      /*
        **桶里每个项目的记忆是什么时候、多大** —— 恢复页的项目组头要显示它（「project memory 是否同步了、
        最新时间」）。一次 list 拿全，不按项目逐个查。大小一起给：空壳（二十几字节）一眼就能看出来，
        那正是 Windows 首次同步把真记忆盖掉时桶里的样子。
      */
      const memoryByProject: Record<string, { bytes: number; lastModified: string }> = {};
      try {
        const mpfx = `${keyFor(cfg.prefix, path.join('memory', 'projects'))}/`;
        for (const o of await listObjects(creds!, mpfx)) {
          const m = /^([^/]+)\/memory\.md$/.exec(o.key.slice(mpfx.length));
          if (m) memoryByProject[m[1]] = { bytes: o.size, lastModified: o.lastModified };
        }
      } catch { /* 列不出来就不显示，不挡恢复 */ }
      return {
        memoryByProject,
        /*
          **本机已经归档的标出来**（`archivedLocally`）—— catalog 不知道本机归档了它，于是恢复页把它
          挂在原项目下；恢复页据此把它挪进「已归档」组，恢复时会顺手取消归档（见 `s3:restore`）。
        */
        entries: markArchivedLocally(catalog.entries || [], localRecs).map((e) => ({
          ...e,
          project: e.project || projectById.get(e.id) || undefined,
          existsLocally: local.has(e.id),
          /*
            只把**正在跑一轮**的标出来 ——「恢复的未分组里面怎么有这么多正连着」。
            原来标的是"有执行器"，而启动预热会把未分组整组拉起来，于是一大片都显示正连着、
            都不给勾。现在恢复会自己先断开（见 `s3:restore`），真正不能动的只剩正在产出的那几条。
          */
          busy: !!sessionClients.get(e.id)?.busy,
        })),
      };
    } catch (err: any) {
      const hint = err instanceof S3Error ? err.hint : '';
      return { entries: [], error: `${err?.message || err}${hint ? `\n${hint}` : ''}` };
    }
  });

  /**
   * **把一个项目在桶里的备份删掉** ——「同步这里没有删除按钮」。
   *
   * 和「不同步」是两件不同的事，两个都要有：
   *
   *   · 不同步 = 以后不再往上传，已经传的**还在**（那是一份可用的历史备份）；
   *   · 删除   = 把桶里那些对象删掉，腾出空间 / 真的不想让它留在云上。
   *
   * ## 这是不可逆的，所以
   *
   * S3 上删了就没了（除非桶开了版本控制，而我们不知道也不该假设）。所以：
   *
   * 1. **要求调用方把 project 名原样传回来**（`confirm` 参数）——
   *    界面那边已经弹过一次确认，这一层再要一次是防"手滑点到别的项目那一行"；
   * 2. **catalog 里对应的条目一起删掉**，否则恢复列表还会列出已经不存在的备份,
   *    而点下去只会得到一句"桶里没有它的文件"；
   * 3. **本地一个字都不动** —— 这是删云上的备份，不是删会话。说清这件事很重要:
   *    "删除备份"和"删除会话"只差两个字，而后者不可挽回。
   */
  ipcMain.handle('s3:delete-project', async (_event, project: string, confirm?: string) => {
    const { creds, problem } = syncCredsOrProblem();
    if (problem) return { ok: false, error: problem };
    if (typeof project !== 'string') return { ok: false, error: '项目名不合法。' };
    if (confirm !== project) return { ok: false, error: '没确认 —— 要删哪个项目得原样传回来。' };
    const cfg = loadSyncConfig();
    try {
      /*
        **桶里有哪些会话属于这个项目**：catalog 是权威的（它记的是"备份时属于哪个项目"）。
        本地记录只用来补 catalog 里缺 project 的老条目 —— 和恢复列表同一条规则。
      */
      const raw = await getObjectIfExists(creds!, catalogKey(cfg.prefix));
      if (!raw) return { ok: false, error: '桶里还没有 catalog（没同步过）。' };
      let catalog: Catalog;
      try { catalog = JSON.parse(raw.toString('utf-8')) as Catalog; } catch { return { ok: false, error: 'catalog 读不出来。' }; }
      const projectById = new Map(store.listSessions().map((r) => [r.id, projectOf(r)]));
      const mine = (catalog.entries || []).filter((e) => (e.project || projectById.get(e.id) || '') === project);
      if (!mine.length) return { ok: false, error: `桶里没有属于「${project || '未分组'}」的备份。` };

      const { deleted, failed } = await deleteBackupsOf(creds!, cfg.prefix, catalog, new Set(mine.map((e) => e.id)));
      logger.warn('s3', `删掉了「${project || '未分组'}」在桶里的备份：${mine.length} 条会话 / ${deleted} 个对象`
        + `${failed.length ? `，${failed.length} 个没删掉` : ''}（本地一个字都没动）`);
      return { ok: true, sessions: mine.length, deleted, failed };
    } catch (err: any) {
      const hint = err instanceof S3Error ? err.hint : '';
      return { ok: false, error: `${err?.message || err}${hint ? `\n${hint}` : ''}` };
    }
  });

  /**
   * **删掉某几条会话在桶里的备份** ——「远程会话恢复中需要有一个删除按钮，现在这里面有好多
   * New Chat 之类没用的会话」。
   *
   * 那些没用的大多是**本地早就删了、桶里还留着**的：同步只往上传，从不删桶里的东西，
   * 所以本地删过的会话会一直挂在恢复列表里。
   *
   * 只删备份，本地一个字不动。本地还在的那几条，下一轮同步会再传上去（状态表已清）——
   * 那是诚实的结果：要它彻底消失，得在侧栏把本地那条也删掉。界面上会把这几条单独说出来。
   */
  /**
   * **以本机为准** —— 删掉桶里这几条会话的全部对象（含 conflicts/），把本机这份整条传上去
   * （见 `keepLocalSession`）。「先删掉 windows 那里上传的版本重新弄 mac 版上去」。
   */
  ipcMain.handle('s3:keep-local', async (_event, ids: string[]) => {
    const { creds, problem } = syncCredsOrProblem();
    if (problem) return { ok: false, error: problem };
    const want = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && /^[\w.-]+$/.test(id) && store.readRecord(id));
    if (!want.length) return { ok: false, error: '没选会话，或者本机没有这几条。' };
    const cfg = loadSyncConfig();
    const thisMachine = machineTag(os.hostname());
    const done: Array<{ id: string; deleted: number; uploaded: number }> = [];
    try {
      for (const id of want) {
        const r = await keepLocalSession(creds!, cfg.prefix, id, thisMachine);
        done.push({ id, ...r });
        logger.warn('s3', `以本机为准 ${id}：删掉桶里 ${r.deleted} 个对象，传上本机 ${r.uploaded} 个文件`);
      }
      return { ok: true, done };
    } catch (err: any) {
      const hint = err instanceof S3Error ? err.hint : '';
      return { ok: false, done, error: `${err?.message || err}${hint ? `\n${hint}` : ''}` };
    }
  });

  ipcMain.handle('s3:delete-sessions', async (_event, ids: string[]) => {
    const { creds, problem } = syncCredsOrProblem();
    if (problem) return { ok: false, error: problem };
    const want = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && /^[\w.-]+$/.test(id));
    if (!want.length) return { ok: false, error: '没选会话。' };
    const cfg = loadSyncConfig();
    try {
      const raw = await getObjectIfExists(creds!, catalogKey(cfg.prefix));
      if (!raw) return { ok: false, error: '桶里还没有 catalog（没同步过）。' };
      let catalog: Catalog;
      try { catalog = JSON.parse(raw.toString('utf-8')) as Catalog; } catch { return { ok: false, error: 'catalog 读不出来。' }; }
      const inBucket = new Set((catalog.entries || []).map((e) => e.id));
      const gone = new Set(want.filter((id) => inBucket.has(id)));
      if (!gone.size) return { ok: false, error: '选的这些桶里已经没有了。' };
      const local = new Set(store.listSessions().map((r) => r.id));
      const willReturn = [...gone].filter((id) => local.has(id));
      const { deleted, failed } = await deleteBackupsOf(creds!, cfg.prefix, catalog, gone);
      logger.warn('s3', `删掉了 ${gone.size} 条会话的备份 / ${deleted} 个对象`
        + `${failed.length ? `，${failed.length} 个没删掉` : ''}（本地没动；其中 ${willReturn.length} 条本地还在，下次同步会再传）`);
      return { ok: true, sessions: gone.size, deleted, failed, willReturn };
    } catch (err: any) {
      const hint = err instanceof S3Error ? err.hint : '';
      return { ok: false, error: `${err?.message || err}${hint ? `\n${hint}` : ''}` };
    }
  });

  /**
   * 把一条会话恢复回本地。**覆盖同 id**（用户选的），但覆盖前先挪进 trash。
   *
   * 不恢复正在连着的那条：它的执行器手上握着 transcript，覆盖文件只会让内存和磁盘打架。
   */
  ipcMain.handle('s3:restore', async (_event, sessionId: string) => {
    const { creds, problem } = syncCredsOrProblem();
    if (problem) return { ok: false, error: problem };
    if (!sessionId || !/^[\w.-]+$/.test(sessionId)) return { ok: false, error: '会话 id 不合法。' };
    /*
      **连着的先断开，不再让人手动去断** —— 恢复现在是合并（同 id 去重、按时间排），
      断开之后执行器手上那份不会再写盘，合并完下次打开按记录重新接上。
      只有**正在跑一轮**的才拒：那一轮的产出还没落盘，这时候断开会把它弄丢。
    */
    const live = sessionClients.get(sessionId);
    if (live?.busy) {
      return { ok: false, error: '这条会话正在跑一轮 —— 等它跑完再恢复，不然这一轮还没落盘的内容会丢。' };
    }
    if (live) {
      logger.info('s3', `恢复前先断开 sessionId=${sessionId}（它连着执行器，内存里那份会把恢复的内容盖回去）`);
      detachExecutor(sessionId);
      mainWindow?.webContents.send('session:detached-for-restore', { sessionId });
    }
    const cfg = loadSyncConfig();
    try {
      const prefix = `${keyFor(cfg.prefix, path.join('sessions', sessionId))}/`;
      const objects = await listObjects(creds!, prefix);
      if (!objects.length) return { ok: false, error: `桶里没有 ${sessionId} 的文件。` };

      const localDir = path.join(KIROLEX_HOME, 'sessions', sessionId);
      const existed = fs.existsSync(localDir);
      /* 合并**之前**本机这条是不是归档的 —— 合并完要取消归档，否则它恢复回来还藏在归档里 */
      const wasArchived = existed && !!store.readRecord(sessionId)?.archived;
      /*
        **动手之前先把本地那份挪走** —— 合并也一样：合并是个算法，算法会有 bug，
        而"选了合并"不等于"愿意拿这条会话赌一次"。挪进 trash 的代价只是一点磁盘。
      */
      let backedUp: string | null = null;
      if (existed) {
        backedUp = trashDirFor(KIROLEX_HOME, sessionId);
        fs.mkdirSync(path.dirname(backedUp), { recursive: true });
        fs.cpSync(localDir, backedUp, { recursive: true });
      }

      /*
        **本地已经有这条 → 合并，而不是覆盖** ——「备份是不是应该有合并的功能」。

        判据在 `transcriptMerge.ts`：transcript 是 append-only 的事件流、每条带 id 和 ts，
        所以"按 id 去重、按 ts 排序"是精确答案而不是猜。本地没有这条时就是纯恢复。
      */
      let merged: { added: number; clashed: number } | undefined;
      let restored = 0;
      for (const obj of objects) {
        const rel = relFor(cfg.prefix, obj.key);
        if (!rel) continue;                                  // 不属于这个布局 / 含 `..`
        const abs = path.join(KIROLEX_HOME, rel);
        const body = await getObject(creds!, obj.key);
        const base = path.basename(rel);

        if (existed && base === 'transcript.jsonl') {
          const mine = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
          const r = mergeTranscripts(mine, body.toString('utf-8'));
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, r.text);
          merged = { added: r.added, clashed: r.clashed };
          restored += 1;
          continue;
        }
        if (existed && base === 'record.json') {
          let mine: any;
          try { mine = JSON.parse(fs.readFileSync(abs, 'utf-8')); } catch { mine = undefined; }
          let theirs: any;
          try { theirs = JSON.parse(body.toString('utf-8')); } catch { theirs = undefined; }
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, JSON.stringify(mergeRecords(mine, theirs), null, 2));
          restored += 1;
          continue;
        }
        /*
          合并完 `history.md` 是**过期**的（它是 transcript 的渲染产物）。所以合并那条路上
          不要把远端那份写下来 —— 下面从合并后的 transcript 重建。直接抄过来的表现是
          "界面上的历史比 transcript 少一半"，而且没有任何报错。
        */
        if (existed && base === 'history.md') continue;

        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
        restored += 1;
      }
      /* 合并之后重建 history.md —— 它是渲染产物，不是数据 */
      if (merged) refreshHistoryFile(sessionId);

      const recordPath = path.join(localDir, 'record.json');
      let recAfter: any;
      try { recAfter = JSON.parse(fs.readFileSync(recordPath, 'utf-8')); } catch { recAfter = undefined; }

      /*
        **记忆跟着会话回来** ——「你看看是不是连 memory 一起被备份了」。备份时 `memory/**` 整个传了，
        恢复却只拉了 `sessions/<id>/`，于是恢复回来的会话"忘了你教过它的事"。
          · 这条会话自己的记忆：直接恢复（只属于它）。
          · 它所在项目的记忆：本地**没有**才拉 —— 本地有的那份多半更新，不盖。
      */
      /*
        后来定成 ——「恢复也增加这些，就默认自带不必在界面上有单独入口」：
          · 会话记忆、项目记忆、全局记忆都跟着回来，**一律合并**（`mergeMemoryText`：本地原样保留，
            备份里多出来的行补在后面）。以前会话那份是直接覆盖的 —— 本机后来教它的会被一份旧备份盖掉；
            项目那份本地有就不拉 —— 备份里多的那几条就回不来。
          · `.bak` 之类的别的文件：本地没有才写。
          · 动之前把本地那几份记忆也挪进同一个 trash 目录。
      */
      let memoryFiles = 0;
      const project = typeof recAfter?.profile?.projectId === 'string' ? recAfter.profile.projectId : '';
      const memTrash = path.join(backedUp || trashDirFor(KIROLEX_HOME, sessionId), '__memory');
      const memPrefixes = [
        `${keyFor(cfg.prefix, path.join('memory', 'sessions', sessionId))}/`,
        ...(project && !/[\\/]|\.\./.test(project) ? [`${keyFor(cfg.prefix, path.join('memory', 'projects', project))}/`] : []),
        keyFor(cfg.prefix, path.join('memory', 'global.md')),
      ];
      for (const pfx of memPrefixes) {
        for (const obj of await listObjects(creds!, pfx)) {
          const rel = relFor(cfg.prefix, obj.key);
          if (!rel) continue;
          if (pfx.endsWith('.md') && obj.key !== pfx) continue;   // global.md 那个前缀别带出 global.md.xxx
          const abs = path.join(KIROLEX_HOME, rel);
          const body = await getObject(creds!, obj.key);
          const local = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
          let next: string | Buffer | null;
          if (local === null) next = body;
          else if (rel.endsWith('.md')) {
            const m = mergeMemoryText(local, body.toString('utf-8'));
            next = m === local ? null : m;
          } else next = null;                                     // 本地已有的 .bak 等不动
          if (next === null) continue;
          if (local !== null) {
            const dest = path.join(memTrash, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(abs, dest);
          }
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, next);
          memoryFiles += 1;
        }
      }

      /*
        **恢复回来默认在本机跑** ——「恢复的会话应该默认在本地，不应该弄到一个本机可能不知道的远程 host 上」。
        记录里那份 `profile.remote` 是**备份它的那台机器**的配置（主机、密钥路径都是那边的），在这台
        机器上多半连不上。要跑远端的话右键「运行位置」选一台这台机器认识的。合并那条路本地记录说了算，不动。
      */
      let madeLocal = false;
      if (!existed && recAfter?.profile?.remote) {
        delete recAfter.profile.remote;
        fs.writeFileSync(recordPath, JSON.stringify(recAfter, null, 2));
        madeLocal = true;
      }
      /*
        **本机归档过的，恢复 = 取消归档、回到原项目** —— 不然合并完 archived 还是 true，侧栏项目里
        看不到它，看起来像恢复失败。项目用合并后记录里那个（就是它原来的项目）。
        渲染端那边，恢复页恢复完会发 `kirolex:sessions-restored` 让侧栏从磁盘重新水化，它就出现在项目里了。
      */
      let unarchived: { projectId?: string } | undefined;
      const un = unarchiveRestoredRecord(recAfter, wasArchived);
      if (un) {
        const tmp = `${recordPath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(un.record, null, 2));
        fs.renameSync(tmp, recordPath);
        recAfter = un.record;
        unarchived = { projectId: un.projectId };
      }
      /* 以前在这台机器上删过它的话，墓碑会让它在水化时继续隐身 —— 恢复就是要它回来 */
      clearSessionTombstone(sessionId);
      deletedSessionIds.delete(sessionId);

      logger.info('s3', `${merged ? '合并' : '恢复'} ${sessionId}：${restored} 个文件`
        + `${merged ? `（并进 ${merged.added} 条${merged.clashed ? `，${merged.clashed} 条同 id 冲突保留本地` : ''}）` : ''}`
        + `${memoryFiles ? `，记忆 ${memoryFiles} 个文件` : ''}${madeLocal ? '，改成在本机跑' : ''}`
        + `${unarchived ? `，已取消归档（回到「${unarchived.projectId || '未分组'}」）` : ''}`
        + `${backedUp ? `（本地那份已挪到 ${backedUp}）` : ''}`);
      return { ok: true, restored, backedUp, merged, memoryFiles, madeLocal, projectId: project || undefined, unarchived };
    } catch (err: any) {
      const hint = err instanceof S3Error ? err.hint : '';
      return { ok: false, error: `${err?.message || err}${hint ? `\n${hint}` : ''}` };
    }
  });

  /** 无边框窗口自己画的最小化 / 最大化 / 关闭（见 createWindow 的 frame: false）。关闭走窗口自己的 close —— 托盘那套逻辑照旧。 */
  ipcMain.handle('window:control', (_event, action: string) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return { maximized: false };
    if (action === 'minimize') win.minimize();
    else if (action === 'toggle-maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === 'close') win.close();
    return { maximized: win.isMaximized() || win.isFullScreen() };
  });

  ipcMain.handle('acp:reveal', async () => {
    startupMark('reveal: window shown (hydrate + eager-attach finished)');
    showMainWindow();
    /*
      **窗口出来之后再扫**，而且不 await：扫远端垃圾要开 ssh，放在启动路径上等于让窗口
      多等一个网络往返 —— 而这件事一分钟后做和现在做没有任何区别。
    */
    void sweepRemoteSessionAgents();
    /* 定时同步的时钟从窗口出来那一刻开始走（启动路径上不该多一次网络往返） */
    rescheduleS3Sync();
    /*
      **启动后补一轮**，而不是退出前。

      `before-quit` 是同步回调 —— 在那里 await 一次上传会被直接丢掉；要真等就得
      `preventDefault()` 然后让窗口挂在那儿等一个网络往返，而用户点退出时看到 app 卡住
      比"下次启动补上"糟得多。更重要的是：**崩溃和被 kill 根本不会走 before-quit**，
      而那正是最需要补的两种情况。启动后补一轮对这三种都有效。

      60 秒之后再跑：那时 attach 风暴已经过去，不和会话抢网络和 CPU。
    */
    if (loadSyncConfig().enabled) {
      setTimeout(() => { void runS3Sync('启动后补一轮'); }, 60_000);
    }
    return { revealed: true };
  });

  ipcMain.handle('acp:disconnect', async () => {
    for (const [, entry] of sessionClients) {
      try { await entry.client.disconnect(); } catch {}
    }
    sessionClients.clear();
  });

  ipcMain.handle('acp:new-session', async (
    _event,
    kiroLexId: string,
    cwd: string,
    model: string,
    projectId?: string,
    kiroAgent?: string,
    permissionMode: 'auto-approve' | 'ask' = 'auto-approve',
    /**
     * **这条会话在哪台机器上跑** —— `undefined` = 本地（默认）。
     *
     * 按会话选，不是全局开关（`docs/DESIGN_remote_sessions.md` 「混用」）：这样会话 A 本地、
     * 会话 B 远程可以同时跑，而"共存"正是这个功能的要求之一。选定之后存进 profile，
     * 重启后 attach 从记录里读回同一台机器。
     */
    remoteId?: string,
    /** 哪个引擎跑这条会话（`engines.ts`）；不传 = kiro，和所有老调用点一样。 */
    engineArg?: string,
  ) => {
    const engine = engineOf({ engine: engineArg });
    /*
      **渲染层到底传了没有** ——「新会话就没有远程 tag」查了两轮都没抓到：`kirolex-new-chat-remote`
      明明是 `tokyo`，而 `[model] new-session` 报的机器却是 `local`。两种可能（渲染层没传 / 传了但
      这边没认）要查的地方完全不同，而这一行就把它们分开。留着不删：这条路以后还会被改。
    */
    logger.info('remote', `new-session ${kiroLexId}: remoteId=${remoteId ?? '(没传)'} project=${projectId || '(无)'} model=${model}`);
    if (!ensureExecutorCapacity()) {
      throw new Error('All live sessions are busy; cannot start another right now.');
    }
    const sessionDir = getSessionDir(kiroLexId);
    let resolvedCwd = cwd === '~' ? os.homedir() : cwd;
    const derived = derivedProjectFor(kiroLexId, resolvedCwd);
    /*
      feature flag 关着的时候一条远程会话都建不起来 —— 主路上那几句同步代码就是死代码。
      老配置里的 `agents[].remote`（全局开关）不再自动生效：它只会作为一个**可选目标**
      出现在列表里（`remoteTargets`），选不选由这一次新建决定。
    */
    const remote = isFeatureEnabled('remoteSessions')
      ? findRemoteTarget(KIROLEX_CONFIG_PATH, remoteId)
      : undefined;
    if (remoteId && !remote) {
      throw new Error(`找不到远端目标 ${remoteId}（配置里的 remotes 变了？）—— 没有猜一台机器，这条会话没有建。`);
    }
    /* kiro 的模型 id 对另外两家没有意义：它们用自己 CLI 配的默认模型，记录里写个占位 */
    const engineModel = engine === 'kiro' ? (model || DEFAULT_MODEL) : 'default';
    const profile: AgentProfile = {
      model: engineModel,
      // Set at creation, NOT left undefined. An absent preference used to be
      // back-filled on the next attach from profile.model — which by then may
      // already be an automatic fallback, laundering a model the user never chose
      // into their "preferred" one permanently.
      preferredModel: engineModel,
      permissionMode: permissionMode === 'ask' ? 'ask' : 'auto-approve',
      projectId: projectId ?? derived,
      kiroAgent: engine === 'kiro' ? (kiroAgent || undefined) : undefined,
      remote,
      ...(engine !== 'kiro' ? { engine } : {}),
    };
    // Remote sessions run kiro-cli on the remote host, so its working directory
    // must be a REMOTE path, not the local per-session scratch dir.
    /*
      **远程会话的 cwd 必须是「项目镜像」，不是「会话目录的镜像」** —— 实测踩到：
      让远端写一个文件，文件落在了 `<workdir>/s_<id>-<hash>/`（会话目录的镜像）里，
      而同步的是 `<workdir>/<项目>-<hash>/`，于是那个文件**永远回不到本地**，
      界面上看起来就是"模型说做了，本地什么都没有"。

      根因是这两条路本来就不一致：新建这条传 `sessionDir`（每会话的临时目录），attach 那条传
      `resolvedCwd`（真正的项目目录）。本地会话无所谓（两者都在本机、都能写），远程会话就成了
      两个不同的镜像。所以远程这一路显式用项目目录，**本地那一路一个字节都不动**。
    */
    /* 本地：项目目录，没项目就是本机工作目录（`localCwdFor`）—— 和重连那条路给同一个目录 */
    if (!profile.remote?.sshHost) resolvedCwd = localCwdFor(kiroLexId, resolvedCwd);
    // Model fallback: use the first candidate that actually starts, and persist
    // the effective model so the session isn't stuck pointing at a dead one.
    /*
      **远程会话不许把家目录当项目** —— 实测的事故：一条 cwd 是 `~` 的远程会话把整个家目录
      推上了远端，2.6 GB / 49064 个文件，里面有 `.aws/credentials`、`.aws/sso/cache`，
      以及连那台机器用的私钥本身。挡在**建会话**这一步，因为等到第一次推送才报错时，
      那一轮已经等了几分钟、而且人根本不知道在等什么。
    */
    if (profile.remote?.sshHost) {
      /*
        没归项目的会话，本地 cwd 就是它自己的会话目录 —— 远程照办（镜像那一份就够，
        history.md 和附件本来就在里面）。所以"家目录"在这里不是错误，只是"没有项目"的表现形式。
      */
      const normalized = localDirOrSessionDir(kiroLexId, resolvedCwd);
      if (normalized !== resolvedCwd) {
        logger.info('remote', `新建远程会话没有项目目录 -> 镜像会话目录 ${normalized}`);
        resolvedCwd = normalized;
      }
      /* 没有任何东西会被推到远端了，所以「这个目录能不能当镜像根」那道闸不存在了 */
      /* 起执行器之前先问清工具/登录/连通 —— 不问的话失败会伪装成别的东西 */
      if (engineOf(profile) !== 'kiro') {
        await remoteAdapterCheck(profile.remote, engineOf(profile) as 'claude' | 'codex');
      } else {
        const remoteModels = await remotePreflight(profile.remote);
        profile.model = pickRemoteModel(kiroLexId, profile.model, remoteModels, profile.remote.sshHost || '');
      }
    }
    const startLocalTools = profile.remote?.sshHost
      ? await ensureLocalTools(kiroLexId, profile, resolvedCwd)
      : undefined;
    /*
      **远端 cwd 要在 `resolvedCwd` 定下来之后再算** —— 实测：它原来算在上面那段"没有项目目录 → 用会话目录"
      **之前**，于是 session/new 拿到的是按家目录算的 `scratch/C__Users_…-<hash>`，而 `ensureLocalTools`
      建出来的是按会话目录算的那个。kiro-cli 不在乎 cwd 在不在，Claude Code 的适配器在 validate-cwd 就拒了 ——
      表现是新建的远程 Claude Code 会话一直"连接中"。
    */
    const cliCwd = profile.remote?.sshHost
      ? sessionCwd(profile, resolvedCwd)
      : resolvedCwd;
    const started = await connectWithModelFallback(profile, 'new-session', startLocalTools, kiroLexId);
    const client = started.client;
    profile.model = started.model;
    let cliSessionId: string;
    try {
      cliSessionId = (await client.newSession(cliCwd)).sessionId;
    } catch (err) {
      /* 起来了的执行器要收掉 —— 不收的话它在那台机器上一直空跑着 */
      try { await client.disconnect(); } catch { /* 已经没了 */ }
      logger.warn('session', `new-session 失败 sessionId=${kiroLexId} engine=${ENGINE_LABEL[engine]} cwd=${cliCwd}`, err);
      throw err;
    }
    const entry: SessionEntry = { client, cliSessionId, profile, cwd: cliCwd, localDir: resolvedCwd, assistantBuf: '', assistantMsgId: null, fileChanges: [], lastUsedAt: Date.now() };
    sessionClients.set(kiroLexId, entry);
    /* 远程会话：两份镜像（项目目录 + 会话目录）登记进同步编排 */
    wireSession(kiroLexId, entry);
    // Durable record (design §4), keyed by the KiroLex id; store the cli mapping.
    const rec = store.createSession(kiroLexId, profile);
    rec.cliSessionId = cliSessionId;
    rec.executorState = 'attached';
    /* **本地工作目录进记录** —— 渲染层 attach 时传的是 `'~'`（三处硬写），
       以它为准的话每次重连都会把家目录当项目（远程会话就是把整个家目录推上远端）。见 `localDir`。 */
    rec.localDir = resolvedCwd;
    store.writeRecord(rec);
    mainWindow?.webContents.send('session:ready-for-first-prompt', { sessionId: kiroLexId, projectId: profile.projectId });
    return { sessionId: kiroLexId };
  });

  ipcMain.handle('acp:prompt', async (_event, sessionId: string, prompt: any[], model?: string, projectId?: string, display?: { messageId?: string; displayText?: string; mergeIntoMessageId?: string; attachments?: any[]; pastes?: any[] }) => {
    /**
     * 已经删掉的会话不许再发东西进去 —— 否则那一发**会把它复活**。
     *
     * `acp:prompt` 一路会走到 `store.appendMessage`，而写 transcript 会把目录重新建出来（记录本来就是
     * 「第一次 prompt 创建」的）。attach 那两处早就有这道守卫（『Session was deleted; not re-attaching.』），
     * 唯独发送这条路没有。
     *
     * 实测的样子：flow 重置一步 → 那条 worker 被回收进回收站 → **7 秒后**它那一发在途的 prompt 到了 →
     * 目录重新出现，成了一条没有任何节点引用的孤儿 worker。这就是「很多没用的子会话还在那」的来源之一。
     */
    if (deletedSessionIds.has(sessionId)) {
      logger.warn('prompt', `refused: sessionId=${sessionId} was deleted —— 不再复活它`);
      throw new Error('这个会话已经被删除了，不再向它发送。');
    }
    /*
      **归档的会话不接消息** —— 这道守卫本来是隐含的（界面把输入框换成了横幅），
      而 `acp:archive-session` 靠抹掉 `projectId` 来保证"归档期间不带项目记忆"。
      现在那个字段留着了（它是备份界面分组的依据），所以这条不变量必须**显式**写在这里：
      归档 = 彻底停下来，包括不注入它那个项目的记忆。

      放在 `sendPrompt` 的入口而不是算 `effectiveProjectId` 的地方：真正要保证的是
      "归档会话不产生任何一轮"，只挡记忆等于让它用空项目继续聊。
    */
    if (store.readRecord(sessionId)?.archived) {
      logger.warn('prompt', `refused: sessionId=${sessionId} 已归档 —— 归档的语义是彻底停下来`);
      throw new Error('这个会话已经归档了。取消归档之后才能继续聊。');
    }
    try {
      return await sendPromptOnce(sessionId, prompt, projectId, display, model);
    } catch (err) {
      // LAST LINE OF DEFENCE for the ride-along marker. sendPromptOnce writes it
      // before the send and only its streaming catch used to take it back, so
      // anything that throws EARLIER left the marker asserting a history the
      // backend never got -- and the next message would then be answered from an
      // empty conversation while KiroLex believed the context was there.
      //
      // The reachable one was the busy rejection: it is thrown outside that try
      // block, so neither catch saw it. Sequence: a send fails, its catch drops the
      // marker and awaits a model swap while `busy` is still set; a second message
      // arrives in that window, finds no marker, rides along (writing the marker),
      // and is then rejected as busy and queued -- the snapshot never went out, but
      // the marker says it did. Clearing it here covers that and every other
      // pre-send throw, without wrapping 400 lines in another try.
      const e = sessionClients.get(sessionId);
      if (e?.rideAlongUnconfirmed) {
        e.rideAlongUnconfirmed = false;
        clearContextEstablished(sessionId);
        logger.info('prime', `send failed before the snapshot was accepted sessionId=${sessionId} -> context marker withdrawn, next message will inject again`);
      }
      throw err;
    }
  });

  /** One send attempt. Kept as a named function (rather than an inline handler) so
   *  the failure classification below stays readable. */
  async function sendPromptOnce(sessionId: string, prompt: any[], projectId?: string, display?: { messageId?: string; displayText?: string; mergeIntoMessageId?: string; attachments?: any[]; pastes?: any[] }, _model?: string, attempt = 0): Promise<any> {
    // `let`, not `const`: a mid-flight model swap (retired model) replaces this
    // session's executor, and the rest of the turn must continue on the new one.
    let entry = sessionClients.get(sessionId);
    if (!entry) throw new Error('Session not connected');
    logger.info('prompt', `received sessionId=${sessionId} cli=${entry.cliSessionId} busy=${entry.busy}`);
    /*
      **你自己写的那段文字** —— 摆渡只看它，别看注入进去的东西（`userPromptText`）。

      实测的账：这一轮往 `prompt` 前面还要塞 memory、运行环境说明、以及 19k 字符的历史快照，
      而摆渡原来扫的是**拼完之后**的全文。于是 memory 里写着的 `~/Downloads`、历史里出现过的
      `星辰证券-需求理解纪要-v0.2.md` 全被当成"你这一轮提到的文件"——一条消息刷出 20 条提示、
      还真的搬了 7 个文件过去。摆渡的全部前提是"**你自己**写出来的路径"，所以在任何注入之前取。
    */
    const userPromptText = (prompt || [])
      .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
      .join('\n');
    // EVERY outgoing `file:` reference is resolved to a within-limits copy here.
    // This is the one place all send paths converge -- fresh send, auto-resend,
    // rerun, overwrite, queue drain -- and it is the only reason capping works at
    // all: a rerun re-sends the attachment PATHS stored in the transcript, so it
    // never passes through the paste-time cap. Capping only at paste left every
    // pre-existing oversized screenshot able to re-enter a conversation, and once
    // inside, the backend replays it on every later turn:
    //   messages.48.content.0.image ... exceed max allowed size ... 2000 pixels
    prompt = (prompt || []).map((block: any) => (
      block && block.type === 'text' && typeof block.text === 'string'
        ? { ...block, text: capImageRefsInText(block.text) }
        : block
    ));
    // A model/Agent switch is replacing this session's executor. WAIT for it
    // rather than rejecting the message: the renderer queues on the pushed
    // 'reconfiguring' state, but that state travels over IPC, so a send fired in
    // the same instant as the switch would otherwise be answered with an error on
    // the user's own message. `entry` is re-read afterwards because the switch
    // installs a NEW executor for the same session.
    await awaitReconfigureIdle(sessionId);
    const afterSwitch = sessionClients.get(sessionId);
    if (!afterSwitch) throw new Error('Session not connected');
    entry = afterSwitch;
    // The backend was rebuilt from scratch (resume failed) and its context has NOT
    // been restored yet -> WAIT for the rebuild, then send. Sending now would hand
    // the model an empty conversation, which looked like "Kiro forgot everything it
    // just wrote". Runs before the busy check on purpose: priming marks the entry
    // busy, and that must not be reported as "an active turn".
    // Verify, lazily, that THIS backend has actually been given this chat's
    // history -- before letting a message reach it.
    //
    // Why here and not at attach: attach fires for every warmed session at
    // startup, and some transcripts here are 3MB / 5000+ messages, so deciding
    // eagerly would mass-replay chats nobody opened. Deciding at send time means
    // only the chat you actually use pays the (bounded) cost, exactly once --
    // after a successful rebuild `contextEstablishedFor` matches the backend and
    // this never fires again for it.
    //
    // A "successful" session/load is NOT evidence: it can resume an id that was
    // itself created empty in an earlier run. Absent/mismatched marker means we
    // have no proof the backend holds anything, so treat it as missing.
    // Verify, lazily, that THIS backend has actually been given this chat's
    // history -- before letting a message reach it. Runs before the busy check on
    // purpose: priming marks the entry busy, and that must not be reported as "an
    // active turn". Session activation performs the same check (see
    // acp:ensure-context), so by the time you type this has usually already run.
    // RIDE-ALONG CONTEXT (no rebuild turn at all).
    //
    // kiro-cli does not persist ACP sessions, so a restart always means an empty
    // backend -- that part is unavoidable. What IS avoidable is paying a dedicated
    // model turn to refill it. The snapshot is just text, so it is prepended to the
    // message the user was going to send anyway: same bytes, ZERO extra turns, no
    // locked session, no queue, no waiting, and nothing at all for chats never
    // opened. This is the same mechanism the memory block already uses below.
    //
    // Verbatim mode ('full') cannot ride along -- it is one turn PER CHUNK by
    // definition -- so that path keeps the chunked, retried rebuild.
    const rideAlong = isFeatureEnabled('rideAlongContext')
      && !contextEstablished(sessionId, entry)
      && !entry.primeAbandoned
      && !entry.priming
      && !entry.needsHistoryPrime
      && store.readRecord(sessionId)?.primeMode !== 'full'
      && store.transcriptFileSize(sessionId) > 0;
    // The context snapshot exactly as sent, kept for the Snapshot view. Captured here
    // rather than re-derived later: it is built from the transcript, so rebuilding it
    // afterwards describes the CURRENT conversation, not the one this turn carried.
    // Memory layers are deliberately NOT captured — they are editable in their own
    // tabs, so copying them in would just be noise.
    let sentContextSnapshot = '';
    // Built and MARKED here, but not prepended until after the user message has
    // been persisted -- see the deferred prepend below for why the order matters.
    let rideAlongBlock = '';
    if (rideAlong) {
      rideAlongBlock = buildHistoryRideAlong(sessionId);
      if (rideAlongBlock) {
        sentContextSnapshot = rideAlongBlock;
        // Marked here, before the bytes go out, so a crash mid-turn does not
        // re-inject a history the backend already received. That makes it OWED
        // bookkeeping: `rideAlongUnconfirmed` says the claim is not yet backed by
        // an accepted request, and every failure path takes the marker back (the
        // acp:prompt wrapper below catches the ones that throw before the
        // streaming try block, which is how the busy rejection used to strand it).
        markContextEstablished(sessionId, entry);
        entry.rideAlongUnconfirmed = true;
        logger.info('prime', `context RIDE-ALONG sessionId=${sessionId} chars=${rideAlongBlock.length} cli=${entry.cliSessionId} pid=${entry.client.pid} (no rebuild turn)`);
      }
    }
    markContextOwedIfUnverified(sessionId, 'prompt');
    if (entry.priming || entry.needsHistoryPrime) {
      const primed = await primeHistoryNow(sessionId);
      entry = sessionClients.get(sessionId) || entry;
      // The user opted out (Stop). Respect it: send WITHOUT the history rather
      // than blocking the message -- they were told the context is incomplete.
      if (entry.primeAbandoned) {
        logger.info('prime', `proceeding WITHOUT history sessionId=${sessionId} (user abandoned the rebuild)`);
      } else if (!primed.ok && !primed.skipped) {
        // Do NOT silently continue on an empty backend. Surfacing this is the
        // whole point: the flag stays set, so the next send retries the rebuild.
        throw new Error(entry.primeGaveUp
          ? `历史上下文重建未完成（${primed.error || '未知原因'}），这条消息未发出以免在空上下文上作答。再发一次会重新尝试重建；不想重建就按 Stop 放弃（之后的消息会照常发出，只是后端没有历史）。`
          : `历史上下文重建未完成（${primed.error || '未知原因'}），这条消息未发出以免在空上下文上作答。重建会继续自动重试；不想等就按 Stop 放弃重建（这一条消息会照常发出，只是后端没有历史）。`);
      }
    }
    // Kiro CLI performs context compaction inside the active session/prompt
    // request. Keep that original request authoritative until it fully settles;
    // queued follow-ups must never overlap it or run during compaction.
    /*
      **超时中断后的自动续写，别被"还忙着"挡回去** —— 实测 ONTAP 那条：WEDGED 之后 4ms
      续写就到了（窗口刚 reload 过，渲染端不知道这一轮还在跑，没等它收尾），而 cancel
      要 170ms 才放开 busy —— 续写被这里拒掉，那一轮就停在"已中断"、没有任何重试。
      只对 KiroLex 自己刚判卡死的那一轮等（最多 20 秒，teardown 本身 15 秒封顶），
      别的情况照旧拒绝，不让排队的消息和正在跑的那一轮重叠。
    */
    if (entry.busy && entry.wedgedAt && Date.now() - entry.wedgedAt < 30000) {
      const waitUntil = Date.now() + 20000;
      while (entry.busy && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 200));
      logger.info('prompt', `waited for wedged turn to release sessionId=${sessionId} busy=${entry.busy}`);
    }
    if (entry.busy) {
      throw new Error('Wait for the active turn (including context compaction) to finish before sending the queued message.');
    }
    // Most-recently-used: protect this session from LRU eviction this turn.
    entry.lastUsedAt = Date.now();
    // Reconcile the renderer's authoritative projectId onto the executor + record
    // (covers assignment after attach, and executor/profile drift).
    if (projectId !== undefined && projectId !== entry.profile.projectId) {
      entry.profile.projectId = projectId;
      const r = store.readRecord(sessionId);
      if (r) { r.profile.projectId = projectId; store.writeRecord(r); }
    }
    const effectiveProjectId = projectId ?? entry.profile.projectId;
    // Persist the user message the instant it is sent (asymmetric durability, §7).
    const userMessageId = display?.messageId || `u_${Date.now()}`;
    entry.currentUserMessageId = userMessageId;
    /**
     * **自动重发的那几次不能再落一遍盘** —— `appendMessage` 是无条件追加（见 sessionStore），
     * 所以重发一次 transcript 里就多一条同样的用户消息；而 ride-along 快照正是从 transcript 建的，
     * 于是"重试了 3 次"会变成"同一个问题在历史里问了 4 遍"。`attempt > 0` 时这条已经在盘上了。
     */
    if (attempt > 0) {
      /* 这一条早就在盘上了（见上面）—— 什么都不做 */
    } else try {
      const promptText = Array.isArray(prompt)
        ? prompt.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('')
        : String(prompt ?? '');
      store.appendMessage(sessionId, {
        id: userMessageId,
        role: 'user',
        content: display?.displayText ?? promptText,
        ts: Date.now(),
        ...(display?.mergeIntoMessageId ? { mergeIntoMessageId: display.mergeIntoMessageId } : {}),
        ...(display?.attachments?.length
          ? {
              attachments: display.attachments.map((a: any) => ({
                id: a?.id, name: a?.name, path: a?.path, isImage: !!a?.isImage,
              })),
            }
          : {}),
        // Where the `[ 粘贴 #N · M 行 ]` placeholders in `content` resolve to.
        ...(display?.pastes?.length
          ? {
              pastes: display.pastes.map((p: any) => ({
                seq: Number(p?.seq) || 0,
                lines: Number(p?.lines) || 0,
                chars: Number(p?.chars) || 0,
                path: String(p?.path || ''),
              })).filter((p: any) => p.path),
            }
          : {}),
      });
    } catch {}
    // Inject layered memory (global ⊕ project ⊕ this chat) on EVERY turn.
    //
    // It used to go out only when the block's CONTENT changed, which is right for
    // "background facts" and wrong for the rules people actually put in there. A rule
    // like 「每次回复的结尾都必须打印本轮最终生成物的完整路径」 has to hold for every
    // reply, but it was stated once and then never again: measured on one chat, a single
    // injection at 17:07 followed by 7 turns that carried nothing, at 66.5% context. The
    // block is also deliberately kept OUT of the transcript and history.md, so nothing
    // restates it after a compaction either -- once it falls out of the live context it
    // is simply gone, invisibly.
    //
    // Cost is small and bounded: this block is ~1.3k chars (~300 tokens) per turn.
    // Rebuilt from disk each time, so an edit takes effect on the next message.
    //
    // Prepended BEFORE the ride-along snapshot below, which means it ends up AFTER it in
    // the final array -- i.e. as close to the user's own text as possible. A standing
    // instruction buried in front of a 19k-char history dump is the position least likely
    // to be honoured.
    /*
      **远程会话：先告诉它自己在哪台机器上** ——「你是不是应该给他一些提示词告诉他本地和远程目录的区别」。
      不说的话它会拿对话里的 `/Users/...` 去搜（那个路径在远端不存在），把"搜不到"当成"没有这个东西"。
      和 memory 块同一个位置注入：越靠近用户那句话越可能被遵守。
    */
    try {
      const note = workdirNoteFor(sessionId, entry);
      if (note) prompt = [{ type: 'text', text: note }, ...prompt];
    } catch {}
    try {
      const rc = remoteContextFor(sessionId, entry);
      if (rc) {
        prompt = [{ type: 'text', text: rc }, ...prompt];
        logger.info('remote', `注入运行环境说明 sessionId=${sessionId} chars=${rc.length}`);
      }
    } catch {}
    try {
      const block = isFeatureEnabled('memoryInjection')
        /* 远程会话的 memory 文件在**用户机器**上，只有 `local_write` 到得了（见 memory.ts） */
        ? buildMemoryInjection(effectiveProjectId, sessionId, { remote: !!entry.profile.remote?.sshHost })
        : '';
      if (block) {
        prompt = [{ type: 'text', text: block }, ...prompt];
        const rec = store.readRecord(sessionId);
        if (rec) { rec.lastMemoryInjection = { charCount: block.length, at: Date.now() }; store.writeRecord(rec); }
        // Logged per turn on purpose: without it "was the memory actually delivered?"
        // could only be answered by reading record.json, and only for the LAST turn.
        logger.info('memory', `injected sessionId=${sessionId} chars=${block.length} project=${effectiveProjectId || '(none)'}`);
      }
    } catch {}
    /**
     * 顺路播报三层各自的体积 —— 这是横幅「压缩完自己消失」的依据。
     *
     * 放在这里而不是单独轮询：这一轮刚刚把这些文件读过一遍，`statSync` 拿个 size 几乎零成本，
     * 而且时机天然正确 —— 压缩那一轮结束后的下一轮就会带上新的数字。
     *
     * 刻意**不**放在上面那个 try 里：那一块被 `memoryInjection` feature flag 门控，寄生进去
     * 会让关掉 flag 静默杀死横幅，而且没有任何报错。
     */
    try {
      const bytes = memoryLayerBytes(effectiveProjectId, sessionId);
      mainWindow?.webContents.send('acp:memory-bytes', {
        sessionId, projectId: effectiveProjectId || null, ...bytes,
      });
    } catch {}
    // DEFERRED PREPEND. The snapshot joins the request only now, AFTER the user
    // message is on disk, for the same reason the memory block does: `promptText`
    // above is derived from `prompt`, so a block prepended earlier is inside the
    // fallback that runs whenever `display.displayText` is absent -- and that
    // fallback would write the ENTIRE history snapshot into the transcript as if
    // the user had typed it. It would then be rendered into history.md, be carried
    // by the NEXT snapshot, and grow on itself. Every current renderer call site
    // does pass displayText, so nothing was corrupted; this removes the trap
    // instead of relying on all future call sites remembering.
    if (rideAlongBlock) prompt = [{ type: 'text', text: rideAlongBlock }, ...prompt];
    // History rebuild already happened above (awaited, chunked, retried) before
    // this message was accepted, so there is nothing to inject inline here. The
    // old inline path prepended the ENTIRE transcript onto the user's own prompt
    // in one shot -- for a large chat that is 100k+ chars, which either failed or
    // was immediately compacted away.
    // Archive the context snapshot at the moment it goes out. Without this it existed
    // only on the wire — the log kept a char count and nothing else, so "what
    // background was this session given?" was unanswerable, and unrecoverable once the
    // transcript moved on. One file per session, overwritten each send.
    if (sentContextSnapshot) {
      try {
        store.writeLastInjection(sessionId, sentContextSnapshot);
      } catch { /* diagnostics must never block a send */ }
    }
    try {
      entry.busy = true; // in-flight turn — exempt from LRU eviction
      emitSessionBusy(sessionId);
      // Tag this turn so a *rejected duplicate* invocation can never clear the
      // busy flag belonging to the turn that is actually running.
      const myTurn = (entry.turnSeq = (entry.turnSeq || 0) + 1);
      try {
        // QUIET MONITOR — OBSERVE ONLY, NEVER INTERRUPT. An earlier version
        // cancelled a turn after 3 minutes of silence and resent it, on the theory
        // that silence meant "wedged". That was wrong: a long tool call, a big
        // context compaction or plain long model thinking legitimately emits
        // nothing for many minutes, so the watchdog threw away real work and
        // reported it as "已自动中断并重试". The user always has Stop, which makes
        // an automatic kill all cost and no benefit. So now we only REPORT the
        // silence (so a genuinely hung turn is visible) and let the turn run.
        const QUIET_NOTICE_MS = 300000;   // 5 min of silence -> inform, do not act
        let modelSwaps = 0;
        /* 空响应换模型**一轮最多一次** —— 真的整段时间都在返空响应时，把回退链全走一遍
           就是几分钟的静默；换一次够了，剩下的交给退避重发和那句说明。 */
        let emptySwaps = 0;
        // Every model already proven dead THIS turn. Without carrying this across
        // swaps the chain ping-pongs between the first two entries and never
        // reaches a working one (see the swap call below).
        const triedModels = new Set<string>();
        // One attempt per chain entry. `triedModels` makes repeats impossible, so
        // the walk terminates on its own and the budget is just the chain length —
        // a fixed 2 stopped short whenever several dead models led the chain.
        const MAX_MODEL_SWAPS = MODEL_FALLBACK_ORDER.length;
        for (;;) {
          entry.lastStreamAt = Date.now();
          // Stale entries from a previous turn would otherwise suppress detection
          // forever: a turn killed mid-tool never sends the closing update.
          entry.openToolCalls?.clear();
          entry.toolsThisTurn = 0;       // 这一轮的工具计数从零开始（自动重试的安全闸）
          entry.localActionsThisTurn = 0;      // 「在你机器上打开」的额度按轮给（见 localAction.ts）
          entry.localLineBuf = '';             // 上一轮的半行不能拼到这一轮的第一行上
          entry.maxToolOutputThisTurn = 0;
          entry.wedgeNote = undefined;   // never let one turn's note reach another
          let noticeSent = false;
          let interrupting = false;
          let wedgeHandled = false;
          const watchdog = setInterval(() => {
            const e = sessionClients.get(sessionId);
            if (!e || e !== entry) return;
            const quietFor = Date.now() - (e.lastStreamAt || Date.now());
            // Freshest update among the OPEN tool calls; -1 when none are open.
            const freshestToolUpdate = e.openToolCalls?.size
              ? Math.max(...Array.from(e.openToolCalls.values(), (v) => v.lastUpdate))
              : -1;
            const toolIdleFor = freshestToolUpdate >= 0 ? Date.now() - freshestToolUpdate : -1;
            // The interrupt needs BOTH bounds passed (see the two `return`s below), so
            // the time left is the LATER of the two -- computed once here because the
            // notice below has to name which one it came from.
            const quietLeftMs = WEDGE_CONFIRM_MS - quietFor;
            const toolLeftMs = toolIdleFor >= 0 ? TOOL_STALL_MS - toolIdleFor : 0;
            if (quietFor > QUIET_NOTICE_MS) {
              // Name the open tool and its idle time: "still running" alone gave no way
              // to tell a working command from one whose completion was never reported.
              const toolNote = toolIdleFor >= 0
                ? ` (${e.openToolCalls!.size} tool call(s) open, last update ${Math.round(toolIdleFor / 1000)}s ago)`
                : ' (no tool call open)';
              if (!noticeSent) {
                noticeSent = true;   // the LOG stays one-shot; the UI does not
                logger.info('prompt', `quiet sessionId=${sessionId} cli=${e.cliSessionId} quiet=${Math.round(quietFor / 1000)}s${toolNote} -- still running, NOT interrupting`);
              }
              // Re-sent EVERY tick, not once. A one-shot froze the on-screen elapsed
              // time at its first value, so a turn that went on to hang for half an
              // hour kept claiming "5 minutes" — and the eventual timeout interrupt
              // arrived with no warning. Carrying the countdown makes it expected.
              mainWindow?.webContents.send('acp:turn-quiet', {
                sessionId,
                quietSeconds: Math.round(quietFor / 1000),
                openTools: toolIdleFor >= 0 ? e.openToolCalls!.size : 0,
                toolIdleSeconds: toolIdleFor >= 0 ? Math.round(toolIdleFor / 1000) : 0,
                // null = the interrupt is switched off in Settings, so nothing is
                // counting down and the UI must not imply otherwise.
                interruptInSeconds: WEDGE_CONFIRM_MS
                  ? Math.max(0, Math.round(Math.max(quietLeftMs, toolLeftMs) / 1000))
                  : null,
                // WHICH of the two thresholds the countdown comes from, and its value.
                //
                // Without this the UI could only show the remaining time, and the number
                // looked like a contradiction: with a tool open the countdown is derived
                // from TOOL_STALL_MS (30 min by default), while Settings prominently
                // shows the silence threshold (10 min) -- so a notice saying "23 more
                // minutes" appeared to disagree with the 600 on screen. Both were right;
                // the interrupt needs BOTH bounds passed, so the later one governs.
                boundBy: toolLeftMs > quietLeftMs ? 'tool' : 'quiet',
                boundSeconds: Math.round(
                  (toolLeftMs > quietLeftMs ? TOOL_STALL_MS : WEDGE_CONFIRM_MS) / 1000,
                ),
              });
            }

            if (wedgeHandled || interrupting) return;
            if (!WEDGE_CONFIRM_MS) return;   // interrupt disabled in Settings
            // PROTOCOL TRUTH, and the only hard fact available: a tool the backend has
            // not closed means the turn is legitimately busy. Long commands (builds,
            // test suites, scripts) report nothing between the opening and closing
            // update, so without this every one of them looks like a hang.
            // Suppress while a tool call is plausibly still working — but BOUNDED. An
            // open call that has not been updated for TOOL_STALL_MS is treated as
            // breakage, otherwise a missing closing update disables detection for the
            // whole turn (measured: 5+ hours of silence with the interrupt switched off).
            if (toolIdleFor >= 0 && toolIdleFor < TOOL_STALL_MS) return;
            if (quietFor <= WEDGE_CONFIRM_MS) return;

            // Both bounds have passed, so this turn is wedged. There is deliberately no
            // third check: the CPU probe that used to postpone here was removed because
            // it could not distinguish computing from spinning, and made the timeout
            // non-deterministic. See the note where it used to be defined.
            wedgeHandled = true;
            interrupting = true;
            const staleToolCount = toolIdleFor >= 0 ? e.openToolCalls!.size : 0;
            const produced = !!(e.assistantBuf || e.fileChanges.length);
            const quietSeconds = Math.round(quietFor / 1000);
            const why = staleToolCount
              ? `${staleToolCount} tool call(s) open but stale for ${Math.round(toolIdleFor / 1000)}s`
              : 'no open tool call';
            // Written into the turn's own message (see flushAssistant). Phrased as OUR
            // timeout firing, not as a backend fault: a measured case had the tool
            // genuinely still working, so blaming the backend would have been false.
            const dur = (ms: number) => (ms < 90000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60000)} 分钟`);
            e.wedgeNote = staleToolCount
              ? `⚠️ 这一轮被 KiroLex 按超时中断：静默 ${dur(quietFor)}，其中 ${staleToolCount} 个工具调用有 ${dur(toolIdleFor)}没有进度更新（上限 ${Math.round(TOOL_STALL_MS / 60000)} 分钟）。工具本身可能仍在后台继续跑。可在设置「工具无进度多久判定卡死」里调大。`
              : `⚠️ 这一轮被 KiroLex 按超时中断：静默 ${dur(quietFor)}（上限 ${Math.round(WEDGE_CONFIRM_MS / 60000)} 分钟），没有工具在运行。可在设置「静默多久判定卡死」里调大。`;
            e.wedgedAt = Date.now();
            logger.warn('prompt', `WEDGED sessionId=${sessionId} cli=${entry.cliSessionId} quiet=${quietSeconds}s produced=${produced} -- ${why}, interrupting`);
            // `produced` is the whole payload the renderer acts on: it decides
            // auto-resend vs. leaving the partial reply alone. The human-readable
            // reason travels in wedgeNote instead, inside the turn's own message,
            // because a floating banner outlives the turn it describes.
            mainWindow?.webContents.send('acp:turn-wedged', { sessionId, produced });

            // Only the teardown is async now that nothing is probed before deciding.
            void (async () => {
              // Polite first: a cancel notification lets kiro-cli end the turn and
              // report its own stopReason.
              try { await entry.client.cancelPrompt(entry.cliSessionId); } catch { /* pipe may be dead */ }
              const deadline = Date.now() + 15000;
              while (entry.busy && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 250));
              }
              // A process blocked on a socket read may never service stdin, so the
              // cancel can go unanswered. Tearing down the executor rejects the
              // pending session/prompt, which is what actually releases the turn
              // (the catch below then flushes whatever was produced).
              if (entry.busy && sessionClients.get(sessionId) === entry) {
                logger.warn('prompt', `WEDGED sessionId=${sessionId} ignored session/cancel -- replacing executor`);
                try { await entry.client.disconnect(); } catch { /* already gone */ }
              }
            })();
          }, WATCHDOG_TICK_MS);
          // RUN EVENT LOG (events.jsonl, see eventLog.ts). Written here rather than
          // derived from the transcript because the transcript has one timestamp per
          // MESSAGE: the moment a turn starts and the moment it ends are otherwise
          // unrecoverable, and so is everything in between.
          const turnKey = entry.currentUserMessageId || `turn_${Date.now()}`;
          const turnStartedAt = Date.now();
          eventLog.appendEvent(sessionId, {
            ts: turnStartedAt,
            type: 'prompt_start',
            turn: turnKey,
            model: entry.profile.model,
            // What was actually SENT, memory block and ride-along snapshot included.
            // The transcript stores only the user's own text, so this is the one
            // record of how big the real request was.
            chars: prompt.reduce((sum: number, block: any) => sum + (typeof block?.text === 'string' ? block.text.length : 0), 0),
          });
          try {
            const result = await entry.client.sendPrompt(entry.cliSessionId, prompt);
            // Our OWN cancel ended this turn. kiro-cli does not always label it
            // A turn now ends ONLY because kiro-cli ended it or because the user
            // pressed Stop. There is no automatic cancel/retry any more, so any
            // stopReason we see is the backend's own verdict and is reported as-is.
            /* 这一轮成了 —— 那条后端对话是好的，两个连续失败计数都清零 */
            if (entry.cliSessionId) cliFailStreak.delete(entry.cliSessionId);
            bareFailStreak.delete(sessionId);
            /*
              远程会话：把远端这一轮改的文件取回来。**在 review / diff 能被打开之前**，
              因为本地是唯一真相，而 review 读的就是本地文件。拉失败不抛（这一轮已经成了），
              但会留一个"远端有未取回的改动"并在会话里说一句 —— 绝不让人以为本地是新的。
            */
            const producedOutput = !!(entry.assistantBuf || entry.fileChanges.length);
            /*
              侧栏 review 的「✓ 确认」在等这一轮的完整回复（见 `askWaiters`）—— 在 flush 清空之前取，
              只取模型自己写的那部分（`wedgeNote` 是 KiroLex 加的说明，不是正文）。
              priming 那一轮不算：那是在补历史，不是对这条改写的回答。
            */
            const askReply = entry.priming ? null : {
              text: entry.assistantBuf,
              stopReason: String(result?.stopReason ?? 'n/a'),
              wedged: !!entry.wedgeNote,
            };
            flushAssistant(sessionId); // turn complete -> persist the full assistant msg
            if (askReply) settleAsk(sessionId, askReply);
            // The request was accepted and answered, so the snapshot it carried IS
            // in this backend now: the claim written before the send is confirmed.
            // Re-marked against the CURRENT entry rather than just clearing the
            // flag, because a mid-turn model swap replaced the executor (new pid,
            // and the catch below dropped the marker) -- the resend carried the same
            // snapshot, so the new backend is the one that must be recorded.
            if (rideAlong && entry.rideAlongUnconfirmed) {
              markContextEstablished(sessionId, entry);
              entry.rideAlongUnconfirmed = false;
            }
            // Surface WHY the turn ended. A non-end_turn reason (max_tokens,
            // refusal, ...) is exactly the "reply stopped mid-sentence with no
            // error" case -- it must not look like a normal completion.
            /*
              **收尾时把最后那半行也当成一整行处理** ——「远程调用本地工具」实测踩到的：
              标记按整行解析（半行会把 URL 截成另一个仍然合法的地址），而模型的回复
              **最后一行通常没有换行符** —— 实测那一轮的整个回复就是一行
              `KIROLEX-LOCAL: open https://…`，于是它一直躺在缓冲里，谁都没执行。
              补一个 `\n` 就是"这一行收完了"。
            */
            if (entry.profile.remote?.sshHost) runLocalActions(sessionId, entry, '\n');
            logger.info('prompt', `done sessionId=${sessionId} stopReason=${String(result?.stopReason ?? 'n/a')} produced=${producedOutput}`);
            eventLog.appendEvent(sessionId, {
              ts: Date.now(),
              type: 'prompt_end',
              turn: turnKey,
              ms: Date.now() - turnStartedAt,
              model: entry.profile.model,
              stopReason: String(result?.stopReason ?? 'n/a'),
              produced: producedOutput,
            });
            // 一轮结束就看看要不要压一次会话记忆 —— 不等它，也不让它影响这一轮的返回
            void maybeConsolidateSessionMemory(sessionId);
            /*
              换项目 / 归档时欠下的执行器重置，在这里消化（那时它正忙，不能 detach）。
              **必须排在 flushAssistant 和上面的收尾之后**：detachExecutor 会立刻把 entry 从 sessionClients
              拿掉，排在前面的话 flushAssistant 找不到 entry 直接返回 —— 这一轮的完整回复就没落盘。
            */
            consumePendingProjectReset(sessionId, '本轮结束，执行下推的执行器重置');
            // Tag the result so the renderer can flag an abnormal end even when
            // kiro-cli reports no stopReason at all (silent empty turn).
            return { ...(result || {}), __kirolex: { produced: producedOutput } };
          } catch (err: any) {
            // MODEL RETIRED MID-FLIGHT. The executor started fine, so the
            // connect-time fallback chain never saw a problem; the failure only
            // shows up here, in the response stream. Previously this dead-ended
            // every single send with a raw "Internal error — The model 'X' is not
            // available". Now: take over the SAME kiro-cli session with the next
            // model in the chain, persist + announce it, and resend once.
            let detail = '';
            try { detail = err?.data ? (typeof err.data === 'string' ? err.data : JSON.stringify(err.data)) : ''; } catch {}
            const text = `${err?.message || ''} ${detail}`;
            // The ride-along context was part of THIS failed request, so the backend
            // may never have received it. Drop the marker: the next message injects
            // again rather than assuming a history that was never delivered.
            // `rideAlongUnconfirmed` deliberately stays SET -- if this failure leads
            // to a model swap and the resend succeeds, the success path above
            // re-marks against the new executor.
            if (rideAlong) clearContextEstablished(sessionId);
            eventLog.appendEvent(sessionId, {
              ts: Date.now(),
              type: 'prompt_error',
              turn: turnKey,
              ms: Date.now() - turnStartedAt,
              model: entry.profile.model,
              detail: String(err?.message || err).slice(0, 300),
            });
            /**
             * **连着被拒绝生成 → 换模型重发**，用的是 model-unavailable 那条路同一套机器
             * （杀执行器、换模型、重载会话、`acp:turn-restart`、原样重发）。
             *
             * 为什么要有这一条：实测那 25 分钟里，换后端会话换了三个都没用（新会话上下文只占
             * 3.8% 照样失败），而人自己换个别的跑法就好了 —— 也就是说这种故障要动的是**模型**，
             * 不是会话。原来只有 kiro-cli 明说"这个模型不可用"才会换，而它对空响应从来不这么说。
             *
             * 两道闸：
             *   · `bareFailStreak >= POISONED_AFTER` —— 单次 Internal error 太常见，换模型是有代价的
             *     （~30 秒静默窗口，还会换掉你选的模型）；
             *   · **这一轮什么都没产出** —— 跑过工具的轮子换模型重发等于把副作用再做一遍。
             */
            const bareStreak = bareFailStreak.get(sessionId) || 0;
            const producedThisTurn = !!entry.assistantBuf || (entry.toolsThisTurn || 0) > 0;
            if (isBareInternalError(text) && bareStreak >= POISONED_AFTER && !producedThisTurn
                && emptySwaps < 1 && modelSwaps < MAX_MODEL_SWAPS) {
              modelSwaps++;
              emptySwaps++;
              const failedModel = entry.profile.model;
              triedModels.add(failedModel);
              eventLog.appendEvent(sessionId, {
                ts: Date.now(),
                type: 'model_swap',
                turn: turnKey,
                model: failedModel,
                detail: `后端连着 ${bareStreak + 1} 次拒绝生成（空响应），换模型重发`,
              });
              const swapped = await swapSessionModel(sessionId, failedModel, `prompt ${sessionId} 空响应`, triedModels);
              if (swapped) {
                const next = sessionClients.get(sessionId);
                if (next) {
                  logger.warn('prompt', `连着 ${bareStreak + 1} 次空响应，模型 '${failedModel}' → '${swapped}' 重发 sessionId=${sessionId}`);
                  noteInSession(sessionId, `🔀 后端连着 ${bareStreak + 1} 次拒绝为这一轮生成回答（kiro-cli 日志里是 `
                    + `\`EmptyResponse\`，流开了但一个 token 都没发）。换后端会话对这种情况没用`
                    + `（实测换三个都失败），所以这次换的是模型：${failedModel} → ${swapped}，原话原样重发。`);
                  entry = next;
                  entry.busy = true;
                  entry.turnSeq = myTurn;
                  entry.assistantBuf = '';
                  entry.assistantMsgId = null;
                  entry.fileChanges = [];
                  entry.toolsThisTurn = 0;
                  mainWindow?.webContents.send('acp:turn-restart', { sessionId });
                  continue;
                }
              }
            }
            if (isModelUnavailableError(text) && modelSwaps < MAX_MODEL_SWAPS) {
              modelSwaps++;
              eventLog.appendEvent(sessionId, {
                ts: Date.now(),
                type: 'model_swap',
                turn: turnKey,
                model: entry.profile.model,
                detail: `${entry.profile.model} 不可用，按回退链换模型重发`,
              });
              const failedModel = entry.profile.model;
              // An unavailable model CONNECTS fine and only fails once a turn runs,
              // so swapSessionModel cannot tell a dead candidate from a live one. It
              // therefore has to be told which ones already failed — otherwise it
              // hands back a model this turn has provably just rejected.
              triedModels.add(failedModel);
              const swapped = await swapSessionModel(sessionId, failedModel, `prompt ${sessionId}`, triedModels);
              if (swapped) {
                const next = sessionClients.get(sessionId);
                if (next) {
                  entry = next;                    // continue on the new executor
                  entry.busy = true;
                  entry.turnSeq = myTurn;
                  entry.assistantBuf = '';
                  entry.assistantMsgId = null;
                  entry.fileChanges = [];
                  mainWindow?.webContents.send('acp:turn-restart', { sessionId });
                  continue;                        // resend the same prompt
                }
              }
            }
            throw err;
          } finally {
            clearInterval(watchdog);
          }
        }
      } finally {
        const e = sessionClients.get(sessionId);
        if (e && e.turnSeq === myTurn) { e.busy = false; e.lastUsedAt = Date.now(); }
        emitSessionBusy(sessionId);
        /**
         * 一轮对话结束 —— 如果这条会话正在替某个 flow 节点干活，**在这里**把账记上。
         *
         * ## 为什么记账必须在主进程
         *
         * 原来这件事只发生在渲染层（那条驱动链已随 flow 移出这一版）。
         * 那个回调活在窗口的 JS 堆里，窗口一刷新（`Cmd+R`、dev-hot、崩一次）它就没了 —— 而**回复是主进程
         * 写进 transcript 的**，于是答案在磁盘上、账没记、节点永远停在 `running`。实测丢过一次 35 418 字
         * 的日历数据（靠 A 那套对账捞回来的）。
         *
         * 这一段就是本文件 3560 行那条注释说的原则的落地：「一件必须活过窗口的事，不能写在会跟窗口一起
         * 死的那一侧」；`acp:prompt` 本来就 owns turn completion。
         *
         * ## 为什么不需要新的登记表
         *
         * 「这条会话正在替哪个节点干活」磁盘上已经写着了：那个节点是 `running`、`sessionId` 是它、还存了
         * 实际发出去的 `prompt`。所以直接复用 `reconcileRun` —— 它按 `prompt` 在 transcript 里认领回复
         * （会话是复用的，只看"最后一条"会认错人）。同一个函数管三件事：这里、打开 run、启动。
         *
         * ## 位置的三个讲究
         *
         *   1. 在 `busy = false` **之后**：对账见到 busy 会让路（那是 A 的分界：不抢正在飞的那一轮）。
         *   2. 成功路径上 `flushAssistant`（3272）已经把回复落盘了，所以认领得到。
         *   3. 出错路径的 `flushAssistant`（3367）在这个 `finally` **之后**才跑，所以这里会判 `failed` ——
         *      这是对的：一段半截的输出不该被当成这一步的产出。判完就不是 `running` 了，后面那次落盘也
         *      不会让它被提拔成 `done`。而**出错原本是完全没人管的**：`.then` 不会在 reject 时执行，
         *      所以以前一次失败的发送同样把节点永久留在 `running` 上。
         *
         * 整段包在 try 里：记账再重要也不能让一轮正常的对话失败。
         */
        try {
          const rec = store.readRecord(sessionId) as any;
        } catch (err: any) {
          logger.warn('run', `post-turn reconcile skipped for ${sessionId}: ${err?.message || err}`);
        }
      }
    } catch (err: any) {
      flushAssistant(sessionId); // persist whatever completed before the error
      // Surface WHY: kiro-cli returns a bare JSON-RPC -32603 "Internal error"
      // for many backend faults (bad session state, stale lock, concurrent
      // prompt). Log the full error + any JSON-RPC `data` detail so it is
      // diagnosable, and enrich the thrown message when it's the bare form.
      let detail = '';
      try { detail = err?.data ? ` — ${typeof err.data === 'string' ? err.data : JSON.stringify(err.data)}` : ''; } catch {}
      /* 这一轮的规模跟着错误一起进日志 —— 「好像 curl 那个大 json 的时候断掉了」这种判断
         原来只能靠人去翻 tool 行数。 */
      logger.warn('prompt', `error sessionId=${sessionId} cli=${entry.cliSessionId}`
        + ` 工具=${entry.toolsThisTurn || 0} 最大工具输出=${entry.maxToolOutputThisTurn || 0}字符`
        + `: ${err?.message || err}${detail}`);
      /**
       * **去 kiro-cli 自己的日志里拿那句真话** ——「还是不知道为什么会断」。
       *
       * ACP 上回来的是万能包装（`Internal error — Kiro failed to generate a response`），
       * 而同一秒 kiro-cli 的日志里写的是 `err=EmptyResponse` / `dispatch failure` /
       * `ValidationException` —— 五种完全不同的病，在界面上长得一模一样。判据在 `kiroCliLog`。
       */
      const cliWhy = await cliErrorContext(diagHost(entry.profile.remote));
      if (cliWhy) logger.warn('prompt', `kiro-cli 那边的原因 sessionId=${sessionId}: ${cliWhy}`);
      /**
       * **把这一刻整包留下来** —— 见 `failureBundle`。查到最后卡在"同一时间同一模型，
       * kiro-cli 里好的、KiroLex 里不好"，而故障不能按需复现；下一次犯的时候要能对着差异看，
       * 而不是再猜一轮。同一条会话 1 分钟内只落一包、每条只留最近 5 包。
       */
      const bundle = await writeFailureBundle({
        sessionId,
        cliSessionId: entry.cliSessionId,
        promptText: (prompt || []).map((b: any) => (typeof b === 'string' ? b : b?.text || '')).join(''),
        error: `${err?.message || err}${detail}`,
        model: entry.profile.model,
        pid: entry.client.pid,
        toolsThisTurn: entry.toolsThisTurn || 0,
        maxToolOutput: entry.maxToolOutputThisTurn || 0,
        /* 证据从**跑 kiro-cli 那台机器**上抄（远程会话就是远端那份，否则整包都是空的） */
        host: diagHost(entry.profile.remote),
        /* trace 开着的时候日志涨得极快，多抄一些才盖得住这一次请求 */
        cliLogTailBytes: kiroTraceEnabled() ? 8 * 1024 * 1024 : undefined,
      });
      if (bundle) logger.info('prompt', `失败现场已存档 sessionId=${sessionId} -> ${bundle}`);
      // kiro-cli refuses a second session/prompt while one is still running.
      // That is NOT a dead session: the earlier turn is alive in the backend
      // (often mid context-compaction). Say so plainly instead of leaking a raw
      // "Internal error", and keep the wording matchable as an active turn.
      if (/prompt already in progress/i.test(`${err?.message || ''}${detail}`)) {
        throw new Error('上一回合仍在后端运行（active turn，可能在压缩上下文）。请等它结束，或点 Stop 中断后再发送。');
      }
      // NOTE: an oversized image is deliberately NOT recovered from here.
      //
      // It genuinely poisons the backend's conversation -- Bedrock re-validates every
      // image in the replayed history, so once one is in, every later request in that
      // conversation is rejected regardless of what is sent next, and regardless of the
      // file on disk having since been shrunk. Swapping the backend did cure it, but it
      // is a compensation at the wrong layer: ~10s of teardown plus a deliberate
      // disconnect that reads as the chat dying, all to work around a constraint only
      // kiro-cli can actually enforce (it is the one party that holds the bytes AND
      // builds the request, so downscaling belongs in its image read).
      //
      // PREVENTION is what is kept, and it covers everything KiroLex hands over:
      // capImagePathsInText on this path and on steer, plus historyLine for the
      // snapshot. The only remaining hole is a file the MODEL picks itself, which
      // cannot be intercepted at all -- tool calls arrive as a `session/update`
      // NOTIFICATION (no response to veto) and KiroLex declares `capabilities: {}` so
      // reads never route through it. For that case the error is reported as-is.
      /* 这条后端对话又坏了一次 —— 连着到阈值就当它毒了（判据在 `staleVerdict`） */
      const failKey = entry.cliSessionId || '';
      const streak = (cliFailStreak.get(failKey) || 0) + 1;
      if (failKey) cliFailStreak.set(failKey, streak);
      /* 跨换会话累计的那一份 —— 换模型的判据要用它（见 bareFailStreak） */
      if (isBareInternalError(`${err?.message || ''}${detail}`)) {
        bareFailStreak.set(sessionId, (bareFailStreak.get(sessionId) || 0) + 1);
      }
      const verdict = staleVerdict({
        error: `${err?.message || ''}${detail}`,
        contextPid: store.readRecord(sessionId)?.contextEstablishedPid,
        clientPid: entry.client.pid,
        /**
         * **预算是 `MAX_AUTO_RETRIES` 次，不是一次** ——「你难道不能让它自动重试吗，挂了你他妈也不管啊」。
         *
         * 实测那条会话要换**三个**后端会话才通（9a74213c → f45ba8b6 → a9085b1c，最后
         * `produced=true`）。原来这里是 `alreadyRetried: retriedStale`，一次用户发送只肯自救一次，
         * 于是"换三次"被摊到三次手动重发上 —— 人看到的就是"总是断，也没人管"。
         */
        /* 远程那条路多给两次 —— 它多了 ssh / 隧道 / 那台机器这一整段会抖的东西（见 maxRetriesFor） */
        alreadyRetried: attempt >= maxRetriesFor(!!entry.profile.remote?.sshHost),
        consecutiveFailures: streak,
        /* 刚换过一个几乎空的新会话又是同一个错 → 别再换（见 cliRecreatedAt） */
        lastRecreateAgoMs: cliRecreatedAt.has(sessionId) ? Date.now() - cliRecreatedAt.get(sessionId)! : undefined,
      });
      const errText = `${err?.message || ''}${detail}`;
      /**
       * **这一轮到底能不能自己重发** —— 判据在 `promptRetry`（纯的、有测试）。
       * 三条恢复路径（换会话、传输层抖动、后端笼统 Internal error）全部共用它，
       * 所以"已经跑过工具就不重发"这条硬闸不可能只在其中一条上生效。
       */
      const plan = planRetry({
        error: errText,
        attempt,
        producedText: !!entry.assistantBuf,
        toolsRan: entry.toolsThisTurn || 0,
        /* 远程多给两次 —— 它多了 ssh / 隧道 / 那台机器这一整段会抖的东西 */
        remote: !!entry.profile.remote?.sshHost,
      });
      if (verdict === 'recreate') {
        let made: { sessionId: string } | null = null;
        try {
          const oldId = entry.cliSessionId;
          /* 和 attach 那边同一个来源 —— cwd 不一致的话新会话会落在别的目录上 */
          const cwd = entry.cwd || sessionCwd(entry.profile, os.homedir());
          made = await entry.client.newSession(cwd);
          entry.cliSessionId = made.sessionId;
          const rec2 = store.readRecord(sessionId);
          if (rec2) { rec2.cliSessionId = made.sessionId; store.writeRecord(rec2); }
          /* 新会话里当然什么都没有 —— 清掉"已建立"，让上下文跟着这一次重发带过去 */
          clearContextEstablished(sessionId);
          markContextOwedIfUnverified(sessionId, 'stale-session-recreate');
          /* 换完 id，那条旧对话的失败计数就没意义了 */
          cliFailStreak.delete(oldId);
          cliRecreatedAt.set(sessionId, Date.now());
          const poisoned = streak >= POISONED_AFTER;
          const note = poisoned
            ? `后端连着 ${streak} 次拒绝为这段对话生成回答（${String(err?.message || '').slice(0, 60)}）——`
              + `pid 没变，所以不是"会话过期"，是这段历史本身后端咽不下去（常见成因：某次工具调用的结果）。`
              + `已经换成新的后端会话（${made.sessionId.slice(0, 8)}…）并把上下文带过去；磁盘上的对话记录一条都没动。`
            : staleRecoveryNote(oldId, made.sessionId,
              store.readRecord(sessionId)?.contextEstablishedPid ?? 0, entry.client.pid ?? 0);
          logger.warn('prompt', `${poisoned ? 'poisoned' : 'stale'} cli session recreated sessionId=${sessionId}: ${note}`);
          /*
            **在会话里说一句** —— 不说的话你看到的是"前几条都失败、这一条突然成了"，
            而中间换过后端会话这件事解释了为什么。只在"毒了"这条路上说：pid 不一致那条是常规现象
            （kiro-cli 不持久化 ACP 会话），每次都播报只会变成噪音。
          */
          if (poisoned) {
            noteInSession(sessionId, `♻️ ${note}`);
          }
        } catch (again: any) {
          /* 换会话本身失败了（连不上进程之类）—— 照实报原来那个错，不是这里的新错。 */
          logger.warn('prompt', `stale recreate FAILED sessionId=${sessionId}: ${again?.message || again}`);
          made = null;
        }
        /**
         * **换完会话要不要顺手重发** —— 这是"自动重试"和"自动重做副作用"的分界线。
         *
         * 这一轮已经跑过工具（或者已经流出过文字）时**只换会话、不重发**：后端会话换新的，
         * 下一条消息就落在干净的后端上，点一下重跑就能继续；而闭眼重发会把那 13 个
         * `aws ssm send-command` 再跑一遍。什么都没产出时才重发 —— 那时重发是幂等的。
         */
        if (made && !plan.retry && (plan.reason === 'side-effects' || plan.reason === 'produced')) {
          logger.warn('prompt', `换了新后端会话但不重发 sessionId=${sessionId}: `
            + `这一轮已产出（文字=${!!entry.assistantBuf} 工具=${entry.toolsThisTurn || 0} `
            + `最大工具输出=${entry.maxToolOutputThisTurn || 0} 字符），重发会重复副作用`);
          throw new Error(`${errText}\n\n`
            + `（这一轮已经跑了 ${entry.toolsThisTurn || 0} 个工具调用${bigOutputHint(entry.maxToolOutputThisTurn)}，`
            + '重发会把它们再执行一遍，所以 KiroLex 只换了新的后端会话'
            + `（${made.sessionId.slice(0, 8)}…）、没有自动重发。点重跑或者再发一条就会落在新会话上。）`
            + (cliWhy ? `\n\n${cliWhy}` : ''));
        }
        if (made && plan.retry) {
          await new Promise((r) => setTimeout(r, plan.delayMs));
          logger.info('prompt', `换完后端会话自动重发 sessionId=${sessionId}`
            + ` attempt=${attempt + 1}/${maxRetriesFor(!!entry.profile.remote?.sshHost)}`);
          return await sendPromptOnce(sessionId, prompt, projectId, display, _model, attempt + 1);
        }
      }
      /**
       * **自己重发** —— 「你难道不能让它自动重试吗，挂了你他妈也不管啊」。
       *
       * 两类错走这一条：传输层抖动（`dispatch failure`，实测一条会话上 9 次、6 次挤在 20 秒内）和
       * kiro-cli 的笼统 `Internal error`（"生成不出回答"）。两者的共同点是**重发有可能就好**，
       * 而原来两者都是把原话甩到界面上、等人再发一遍。
       *
       * 闸全在 `planRetry` 里（`producedText` / `toolsRan` / 预算），所以这里只剩"发"。
       * 递增间隔：瞬时故障立刻重试还是同一个结果。
       */
      if (plan.retry) {
        logger.warn('prompt', `自动重发 ${attempt + 1}/${maxRetriesFor(!!entry.profile.remote?.sshHost)}（等 ${plan.delayMs}ms）`
          + ` sessionId=${sessionId}: ${errText.slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, plan.delayMs));
        return await sendPromptOnce(sessionId, prompt, projectId, display, _model, attempt + 1);
      }
      /* 预算用光了：说清试过几次 —— 不然看着像"它就是不行"，而实际上已经试了 4 次。 */
      if (plan.reason === 'budget') {
        logger.warn('prompt', `自动重发用光预算（${attempt} 次）sessionId=${sessionId}: ${errText.slice(0, 160)}`);
        const why = cliWhy ? `\n\n${cliWhy}` : '';
        throw new Error(isTransientTransportError(errText)
          ? `连不上后端（${errText.slice(0, 120)}）—— KiroLex 自己重发了 ${attempt} 次都失败。检查网络/VPN 后再发一次。${why}`
          : retriesExhaustedNote(errText, attempt) + why);
      }
      if (/^internal error$/i.test(String(err?.message || '')) && detail) {
        const e2: any = new Error(`${err.message}${detail}${cliWhy ? `\n\n${cliWhy}` : ''}`);
        throw e2;
      }
      /* 报出去之前把 kiro-cli 那句真话带上 —— 光一句 Internal error 谁也不知道该干什么 */
      if (cliWhy && isBareInternalError(errText)) throw new Error(`${errText}\n\n${cliWhy}`);
      throw err;
    } finally {
      /*
        **这一轮报错收场也要消化欠下的执行器重置** —— 只在成功收尾那一处消化的话，回复期间被挪了项目 / 归档
        （尤其是同步跟随：位置时间戳已经跟上了，下一次同步不会再触发）、这一轮又报错，旧执行器就会
        带着旧项目的记忆一直用下去。放在 finally：上面的 catch 已经先 flushAssistant 把半截回复落了盘。
        成功那条路已经消化过（再调是空操作）；自动重发那条路由里层那次调用消化。
        别的一轮正在跑（busy）就不动 —— 它收尾时会消化。
      */
      if (!sessionClients.get(sessionId)?.busy) consumePendingProjectReset(sessionId, '本轮报错结束，执行下推的执行器重置');
    }
  }

  /**
   * WHAT IS THIS SESSION DOING RIGHT NOW, and what has it produced so far.
   *
   * Exists so an interrupted-looking chat can be RECOVERED BY ADOPTION rather than by resending.
   * A window reload does not stop a turn: this process holds the ACP connection, keeps filling
   * `assistantBuf`, and flushes the complete text when the turn ends. The renderer had no way to
   * learn that, so it resent the question and paid for the same answer twice.
   *
   * Live state only -- `sessionClients`, never the transcript on disk. A completed turn is
   * already IN the transcript; the whole point here is the part that is not.
   */
  ipcMain.handle('acp:peek-turn', (_event, sessionId: string) => {
    const entry = sessionId ? sessionClients.get(sessionId) : undefined;
    // `priming` is a turn KIROLEX issued (a history rebuild), and its output is suppressed
    // everywhere -- not forwarded, not accumulated, not persisted. Reporting it as live would
    // be the one way that internal reply could still reach the user's chat.
    if (!entry || !entry.busy || entry.priming) {
      return { live: false, messageId: null, text: '', startedAt: null };
    }
    return {
      live: true,
      messageId: entry.assistantMsgId,
      text: entry.assistantBuf || '',
      startedAt: entry.lastUsedAt ?? null,
    };
  });

  /**
   * 这条会话的斜杠命令表 —— 渲染进程重载之后来这儿补（见 `SessionEntry.commands`）。
   * 拿不到就返回空数组：这条会话可能还没连上（后端还没推过），界面照旧不弹菜单，不会更差。
   */
  ipcMain.handle('acp:session-commands', async (_event, sessionId: string) => {
    const entry = sessionClients.get(String(sessionId || ''));
    return { commands: Array.isArray(entry?.commands) ? entry!.commands : [] };
  });

  ipcMain.handle('acp:cancel', async (
    _event,
    sessionId: string,
    _model?: string,
    suppressInterruptionNotice = false,
  ) => {
    const entry = sessionClients.get(sessionId);
    if (!entry) return { idle: true };
    /*
      **Stop 也要把正在跑的同步掐掉** ——「为啥远程会话一直没有响应」那次，卡住的不是模型，
      是一个还在跑的 rsync（上限 10 分钟）。不掐它，按了 Stop 也得干等到它自己结束 ——
      那等于 Stop 没用。放在最前面：这一步不依赖后端状态，而且越早停越好。
    */
    // Stop DURING a rebuild = the user opting out of the rebuild. Earlier this was
    // refused outright, which left them with no way to stop anything at all (Stop
    // became a no-op and even a pending auto-resend could not be called off). A
    // lock the user cannot escape is worse than the problem it prevents, so: abort
    // the rebuild, release the session, and keep the flag so it can be retried
    // later from the right-click menu.
    if (entry.priming) {
      entry.primeAbandoned = true;
      primeModelsTried.delete(sessionId);
      logger.info('prime', `ABANDONED by user (stop) sessionId=${sessionId} — releasing session, history stays incomplete (cursor=${entry.primeCursor}/${entry.primeChunks?.length ?? '?'})`);
      try { await entry.client.cancelPrompt(entry.cliSessionId); } catch {}
      emitSessionBusy(sessionId);
      return { idle: false, abandonedPrime: true };
    }
    // Stop while a rebuild is merely OWED: cancel the obligation rather than
    // silently doing nothing, so the chat becomes usable immediately.
    if (entry.needsHistoryPrime && !entry.primeAbandoned) {
      entry.primeAbandoned = true;
      primeModelsTried.delete(sessionId);
      logger.info('prime', `pending rebuild ABANDONED by user (stop) sessionId=${sessionId}`);
      emitSessionBusy(sessionId);
      return { idle: true, abandonedPrime: true };
    }
    entry.suppressCancellationChunks = suppressInterruptionNotice;
    try {
      await entry.client.cancelPrompt(entry.cliSessionId);

      // session/cancel is a notification, so wait for the in-flight prompt RPC to
      // settle before allowing an interrupt-and-steer prompt onto the same client.
      const deadline = Date.now() + 10000;
      while (entry.busy && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (entry.busy) throw new Error('Timed out waiting for the active turn to stop.');
      flushAssistant(sessionId); // preserve partial output produced before cancel
      return { idle: true };
    } finally {
      entry.suppressCancellationChunks = false;
    }
  });

  // Mid-turn steer: inject text into the CURRENTLY RUNNING turn via kiro-cli's
  // _session/steer, on the SAME executor/connection. Unlike acp:prompt this does
  // NOT set busy, does NOT start a new turn, and does NOT cancel the in-flight
  // prompt — the steered reply streams back inside the same session/prompt and
  // is accumulated by wireSession like any other chunk. Returns { steered,
  // reason } so the renderer can fall back to the queue (never dropping the
  // message) when the turn is not steerable.
  //
  // The steered user message is deliberately not persisted HERE, because a steer
  // that is written into the turn is not yet a steer the backend accepted: an
  // un-consumed one is reconciled back into the queue and re-sent through
  // acp:prompt, which persists it there, so writing it now would double it. It IS
  // persisted — on the CONSUMED notification, via acp:persist-steer below. Until
  // that existed, a consumed steer never reached the transcript at all, and since
  // the ride-along snapshot and history.md are both rendered from the transcript, a
  // restored chat showed the model answering a question nobody had asked.
  ipcMain.handle('acp:steer', async (_event, sessionId: string, message: string) => {
    const entry = sessionClients.get(sessionId);
    if (!entry) return { steered: false, reason: 'not-connected' };
    if (reconfiguringSessions.has(sessionId)) return { steered: false, reason: 'reconfiguring' };
    // A history rebuild is a LOCKED task, not a conversational turn. Steering into
    // it would inject the user's text into a hidden priming turn (invisible, and
    // answered without the very context being restored). Report it as queueable so
    // the renderer parks the message until the rebuild finishes.
    if (entry.priming) {
      logger.info('prime', `steer REFUSED during rebuild sessionId=${sessionId} -> renderer should queue`);
      return { steered: false, reason: 'priming' };
    }
    if (!entry.client.supportsSteer) return { steered: false, reason: 'unsupported' };
    // A steer only makes sense while a turn is actually in flight. If the turn
    // already finished (race between the renderer deciding to steer and this IPC
    // arriving), report idle so the renderer queues it instead — it will drain
    // immediately on the now-idle session.
    if (!entry.busy) return { steered: false, reason: 'idle' };
    entry.lastUsedAt = Date.now();
    // Same cap as the prompt path: a steer can carry attachments too.
    const steered = entry.client.steer(entry.cliSessionId, capImageRefsInText(message));
    return { steered, reason: steered ? undefined : 'write-failed' };
  });

  /** Persist a steer that the backend reported CONSUMED.
   *
   *  Steers bypass acp:prompt entirely (they are written into the turn already
   *  running), so this is the only writer for them. Without it the durable
   *  transcript kept the assistant reply that answered a steer but not the steer,
   *  which matters beyond display: the ride-along context snapshot and history.md
   *  are both rendered FROM that transcript, so every restored chat showed the
   *  model answering a question that was not in the conversation.
   *
   *  Stored as an append-only merge event rather than a standalone message, using
   *  the machinery that already exists for it (`mergeIntoMessageId`, folded into the
   *  base user message by readTranscript) — which is also exactly how the renderer
   *  renders it: one user bubble, the steers as separate paragraphs inside it.
   *
   *  Called on CONSUMED only. An un-consumed steer goes back to the queue and is
   *  re-sent through acp:prompt, which persists it there. */
  ipcMain.handle('acp:persist-steer', async (_event, sessionId: string, text: string, messageId?: string) => {
    if (!sessionId || !text) return { ok: false, error: 'no text' };
    const entry = sessionClients.get(sessionId);
    // The turn's own user message is the merge target. If it is unknown (a steer
    // into a turn this process did not start — e.g. after a hot restart), fall back
    // to a standalone user message: out of order is still better than lost.
    const mergeInto = entry?.currentUserMessageId;
    try {
      store.appendMessage(sessionId, {
        id: messageId || `steer_${Date.now()}`,
        role: 'user',
        content: text,
        ts: Date.now(),
        ...(mergeInto ? { mergeIntoMessageId: mergeInto } : {}),
      });
      logger.info('prompt', `steer persisted sessionId=${sessionId} chars=${text.length} mergeInto=${mergeInto || '<none, standalone>'}`);
      return { ok: true, merged: !!mergeInto };
    } catch (err: any) {
      logger.warn('prompt', `steer persist FAILED sessionId=${sessionId} err=${err?.message || err}`);
      return { ok: false, error: err?.message || 'append failed' };
    }
  });

  /** Persist a note the RENDERER produced, as an assistant message.
   *
   *  Same reason `acp:persist-steer` exists: a message created in the renderer
   *  reaches `setMessages` and the in-memory cache but NOT the durable transcript,
   *  so it dies with the window. The loop's terminal reason is precisely the fact
   *  that must outlive the run — "why did this loop stop" is unanswerable after a
   *  restart otherwise, which is the defect this whole feature set is about.
   *
   *  Deliberately narrow: assistant role, one short text, no tool calls, and only
   *  for a session that already exists on disk. It is NOT a general-purpose writer
   *  for model output — that path stays with `acp:prompt`, which owns turn
   *  completion and the asymmetric-durability rule. */
  ipcMain.handle('acp:persist-note', async (_event, sessionId: string, text: string) => {
    if (!sessionId || !text || !text.trim()) return { ok: false, error: 'no text' };
    if (!store.readRecord(sessionId)) return { ok: false, error: 'unknown session' };
    const content = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
    try {
      store.appendMessage(sessionId, {
        id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        content,
        ts: Date.now(),
      });
      logger.info('loop', `note persisted sessionId=${sessionId} chars=${content.length}`);
      return { ok: true };
    } catch (err: any) {
      logger.warn('loop', `note persist FAILED sessionId=${sessionId} err=${err?.message || err}`);
      return { ok: false, error: err?.message || 'append failed' };
    }
  });

  /** Verifier commands the USER approved by starting a loop, per session.
   *
   *  This is the guard that makes `loop:verify` narrower than "run anything":
   *  verification only accepts a command that is byte-identical to the one
   *  registered here, so a later call cannot substitute a different one. It matters
   *  because the whole value of out-of-band verification is that the agent does not
   *  choose the check — if model output could reach this map, the model could
   *  propose `true` and maker/checker separation would be gone on round one. */
  const registeredVerifiers = new Map<string, { command: string; timeoutSec: number }>();
  /** One verifier per session at a time: a slow check must not be re-entered by the
   *  next round while it is still running. */
  const verifiersInFlight = new Set<string>();

  ipcMain.handle('loop:register-verifier', (_event, sessionId: string, command: string, timeoutSec: number) => {
    if (!sessionId) return { ok: false, error: 'no session' };
    if (!command || !command.trim()) {
      registeredVerifiers.delete(sessionId);
      logger.info('loop', `verifier cleared sessionId=${sessionId}`);
      return { ok: true, registered: false };
    }
    const rejected = loopVerify.rejectRequest(command, timeoutSec);
    if (rejected) return { ok: false, error: rejected };
    registeredVerifiers.set(sessionId, { command, timeoutSec });
    logger.info('loop', `verifier registered sessionId=${sessionId} timeoutSec=${timeoutSec} command=${JSON.stringify(command)}`);
    return { ok: true, registered: true };
  });

  /** Run this session's registered verifier once, OUT OF BAND.
   *
   *  On the same host as the agent: a remote session's check runs over SSH in the
   *  remote workdir, because a verifier inspecting the local filesystem while the
   *  agent edits an EC2 box reports green forever. The remote decision comes from
   *  the session's own profile, exactly like the executor's. */
  ipcMain.handle('loop:verify', async (_event, sessionId: string, command: string, timeoutSec: number) => {
    if (!sessionId) return { ran: false, exitCode: null, output: '', host: 'local', durationMs: 0, timedOut: false, error: 'no session' };
    const approved = registeredVerifiers.get(sessionId);
    if (!approved || approved.command !== command) {
      // Not an error the user caused: it means something asked to run a command
      // this session's loop never declared.
      logger.warn('loop', `verify REFUSED sessionId=${sessionId} — command not registered by a loop start`);
      return { ran: false, exitCode: null, output: '', host: 'local', durationMs: 0, timedOut: false, error: '校验命令未经循环设置登记，已拒绝执行' };
    }
    const rejected = loopVerify.rejectRequest(command, timeoutSec);
    if (rejected) return { ran: false, exitCode: null, output: '', host: 'local', durationMs: 0, timedOut: false, error: rejected };
    if (verifiersInFlight.has(sessionId)) {
      return { ran: false, exitCode: null, output: '', host: 'local', durationMs: 0, timedOut: false, error: '上一次校验尚未结束' };
    }
    const record = store.readRecord(sessionId);
    const profile = record?.profile;
    const entry = sessionClients.get(sessionId);
    const remote = profile?.remote?.sshHost ? profile.remote : undefined;
    // Prefer the LIVE executor's cwd for a local session: that is the directory the
    // agent is actually working in. Fall back to the profile's resolved session cwd.
    const cwd = remote
      ? sessionCwd(profile!, os.homedir())
      : (entry?.cwd || (profile ? sessionCwd(profile, os.homedir()) : os.homedir()));
    verifiersInFlight.add(sessionId);
    try {
      // The ssh builders come from acp-client, i.e. the executor's own: the check
      // has to be launched by the same rules as the agent it is checking.
      const result = await loopVerify.runVerifier(
        { command, timeoutSec, cwd, remote }, shellEnv, { buildSshArgs, shellQuote });
      logger.info('loop', `verify sessionId=${sessionId} host=${result.host} cwd=${cwd}`
        + ` exit=${result.exitCode ?? 'n/a'} ran=${result.ran} ms=${result.durationMs} command=${JSON.stringify(command)}`);
      return result;
    } finally {
      verifiersInFlight.delete(sessionId);
    }
  });

  /* ─────────────────────────── SCHEDULED TASKS ───────────────────────────
   *
   * Replaces loop mode. The loop re-sent a message and judged each round with a verifier
   * command, stopping when the check passed -- a coding shape. The real scenarios here
   * (weekly report, SFDC logging, oncall) are time-triggered: the previous run's result
   * does not change the next run's action, which is the only test of whether something is
   * a loop. So there is no goal and no verifier.
   *
   * THE TICKER LIVES HERE, not in the renderer, and that is the whole point: "every Monday
   * 9am" has to fire with no window open. The old loop's `setTimeout` lived in `useAcp`,
   * so closing the window stopped it.
   *
   * EACH RUN IS INDEPENDENT. Nothing from the previous run is injected -- KiroCrew's cron
   * calls accumulated context "the other half of the bug" (cron.py:204) and shipped a
   * stateless mode to switch it off, because carrying the last result forward is what makes
   * a scheduled job report the same thing every morning. */
  const SCHEDULE_TICK_MS = 20_000;
  /* Jobs currently mid-run (`schedulesInFlight`, module level), so a slow turn is never re-entered by the next tick. */

  async function runScheduledJob(job: scheduleStore.StoredSchedule): Promise<void> {
    const { id, state } = job;
    if (schedulesInFlight.has(id)) return;
    schedulesInFlight.set(id, state.sessionId);
    try {
      // CHARGE THE RUN FIRST, and flush it. Recording only on completion means a process
      // killed mid-run forgets it paid -- the shape of a job that bills a turn per restart.
      const charged = recordRun(state, Date.now());
      scheduleStore.writeSchedule(id, charged, os.homedir());

      let failure: string | undefined;
      try {
        await sendPromptOnce(state.sessionId, [{ type: 'text', text: state.spec.prompt }], undefined, {
          messageId: `sched_${id}_${Date.now()}`,
          displayText: state.spec.prompt,
        });
      } catch (err: any) {
        failure = err?.message || '发送失败';
      }

      // Re-read: the user may have paused or removed the job during the turn.
      const latest = scheduleStore.readSchedule(id, os.homedir());
      if (!latest) return;
      const settled = { ...latest.state, lastError: failure ?? null };
      const terminal = scheduleTerminal(settled);
      const final = terminal ? { ...settled, terminal } : settled;
      scheduleStore.writeSchedule(id, final, os.homedir());
      logger.info('schedule', `run id=${id} session=${state.sessionId} runs=${final.runs}/${final.spec.maxRuns}`
        + ` error=${failure ? JSON.stringify(failure) : 'none'} terminal=${terminal ?? 'none'}`);

      if (terminal) {
        try {
          store.appendMessage(state.sessionId, {
            id: `sched_end_${Date.now()}`,
            role: 'assistant',
            content: `⏰ 定时任务结束：${scheduleTerminalLabel(terminal)}\n${describeSchedule(final.spec)} · 共运行 ${final.runs} 次`,
            ts: Date.now(),
          });
        } catch {}
      }
      mainWindow?.webContents.send('schedule:changed', { id, state: final });
    } finally {
      schedulesInFlight.delete(id);
    }
  }

  const scheduleTicker = setInterval(() => {
    // 等待退出期间不开新一轮；到期的任务留着，取消等待或重启后下一跳照样触发
    if (quitPending) return;
    const now = Date.now();
    for (const job of scheduleStore.listSchedules(os.homedir())) {
      if (isDue(job.state, now)) void runScheduledJob(job);
    }
  }, SCHEDULE_TICK_MS);
  app.on('before-quit', () => clearInterval(scheduleTicker));
  /* 正在跑的同步要跟着死 —— 不掐的话它会被 launchd 收养（ppid=1）继续推，没人读结果还吃光上行 */
  /*
    **退出时也要收掉远端的执行器** —— 实测同一条会话在远端留了两个 kiro-cli：
    杀掉 KiroLex 只杀掉本地的 ssh，远端那个进程照样活着并占着会话锁，
    下次启动就撞上「Session is active in another process」。
    `disconnect()` 里那条 `kill -TERM <远端 PID>` 只在正常断开时跑，所以这里补一遍。
  */
  for (const [sid, e] of sessionClients) {
    if (e.profile.remote?.sshHost) { try { void e.client.disconnect(); } catch { /* 退出路径不抛 */ } }
    void sid;
  }

  ipcMain.handle('schedule:create', (_event, sessionId: string, spec: ScheduleSpec) => {
    if (!sessionId || sessionId.startsWith('pending_')) return { ok: false, error: '请先选择一个已创建的会话' };
    const problems = validateSchedule(spec);
    if (problems.length) return { ok: false, error: problems.join('；') };
    const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const state = newSchedule(sessionId, spec, Date.now());
    scheduleStore.writeSchedule(id, state, os.homedir());
    logger.info('schedule', `created id=${id} session=${sessionId} ${describeSchedule(spec)} maxRuns=${spec.maxRuns}`);
    // Announced like every other mutation: the window that created the job learns of it the
    // same way as any other, so its banner appears without a reload. The end of a RUN used to
    // be the only broadcast, which left create/pause/remove invisible until the next reload.
    mainWindow?.webContents.send('schedule:changed', { id, state });
    return { ok: true, id, nextRunAt: nextRunAt(state), describe: describeSchedule(spec) };
  });

  ipcMain.handle('schedule:list', () => scheduleStore.listSchedules(os.homedir()).map((job) => ({
    id: job.id,
    sessionId: job.state.sessionId,
    prompt: job.state.spec.prompt,
    describe: describeSchedule(job.state.spec),
    runs: job.state.runs,
    maxRuns: job.state.spec.maxRuns,
    paused: job.state.paused,
    terminal: job.state.terminal,
    lastRunAt: job.state.lastRunAt,
    lastError: job.state.lastError,
    nextRunAt: nextRunAt(job.state),
  })));

  ipcMain.handle('schedule:pause', (_event, id: string, paused: boolean) => {
    const job = scheduleStore.readSchedule(id, os.homedir());
    if (!job) return { ok: false, error: '找不到这个定时任务' };
    const state = { ...job.state, paused };
    scheduleStore.writeSchedule(id, state, os.homedir());
    logger.info('schedule', `${paused ? 'paused' : 'resumed'} id=${id}`);
    mainWindow?.webContents.send('schedule:changed', { id, state });
    return { ok: true };
  });

  ipcMain.handle('schedule:remove', (_event, id: string) => {
    scheduleStore.removeSchedule(id, os.homedir());
    logger.info('schedule', `removed id=${id}`);
    // `state: null` says GONE. The renderer re-reads the list either way, but a payload that
    // omitted the outcome would make "removed" indistinguishable from "changed somehow".
    mainWindow?.webContents.send('schedule:changed', { id, state: null });
    return { ok: true };
  });

  /* ────────────────────── DURABLE LOOP COUNTER ──────────────────────
   *
   * The round counter is owned HERE, not in the window that started the loop. It used
   * to live in the renderer's `loopsRef`, which meant closing or reloading the window
   * reset it to zero -- so a loop declared "at most 20 rounds" got a fresh 20 on every
   * restart, and its budget was not a budget at all.
   *
   * The send path is still driven from the renderer (it needs the streaming state and
   * the message list). What moved is the part that must survive: the count, the budget
   * decision, and the recorded reason a run ended. */
  ipcMain.handle('loop:persist', (_event, sessionId: string, run: any) => {
    if (!sessionId || !run?.spec?.stop) return { ok: false, error: 'no run' };
    try {
      loopStore.writeLoop(sessionId, run, os.homedir());
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'persist failed' };
    }
  });

  /** Charge a round against the DURABLE counter and checkpoint it before it is sent.
   *  The renderer must call this instead of counting locally, or the count goes back to
   *  being per-window. */
  ipcMain.handle('loop:begin-round', (_event, sessionId: string) => {
    const result = loopStore.beginRound(sessionId, os.homedir(), Date.now());
    if (result.run) {
      logger.info('loop', `round sessionId=${sessionId} iteration=${result.run.iteration}`
        + `/${result.run.spec.stop.maxIterations} terminal=${result.terminal ?? 'none'}`);
    }
    return result;
  });

  ipcMain.handle('loop:read', (_event, sessionId: string) => loopStore.readLoop(sessionId, os.homedir()));
  ipcMain.handle('loop:list-live', () => loopStore.listLiveLoops(os.homedir()));
  ipcMain.handle('loop:clear', (_event, sessionId: string) => {
    loopStore.clearLoop(sessionId, os.homedir());
    return { ok: true };
  });

  /* ─────────────────────────── SKILL FLOWS ───────────────────────────
   *
   * A flow is the reliable, step-by-step half of a skill: declared steps, out-of-band
   * checks, human approval gates, and per-item idempotency for anything that writes to
   * an external system.
   *
   * The DRIVER lives in flowDriver.ts and the DECISIONS in flowRun.ts; this section is
   * only the wiring — it supplies the three effects the driver cannot perform itself
   * (send a prompt, run a check, write the record) and exposes them over IPC.
   *
   * Runs in flight, so a gate's answer reaches the run that is waiting for it. NOT the
   * source of truth: that is the file on disk, which is why a run answered after a
   * restart still works. */
  const liveFlowRuns = new Map<string, { sessionId: string; flowPath?: string; driving: boolean }>();

  /** Verifier commands a FLOW declared, per run. Same guard as the loop's registry and
   *  for the same reason: `loop:verify` only executes a command a human put in a file,
   *  never one that came back from a model. A flow's commands are read from flow.yaml
   *  at load time and registered here, before any step runs. */
  const flowVerifiers = new Map<string, Set<string>>();

  /** Run one flow step's check out of band, on the agent's own host. Deliberately built
   *  on the same `loopVerify` module as the loop: a second copy of the remote/local
   *  decision is exactly the thing that drifts and silently verifies the wrong host. */
  async function runFlowVerify(runId: string, sessionId: string, command: string, timeoutSec: number) {
    const allowed = flowVerifiers.get(runId);
    if (!allowed?.has(command)) {
      logger.warn('flow', `verify REFUSED runId=${runId} — command not declared by the flow file`);
      return { ran: false, exitCode: null, output: '', error: '校验命令不在流程声明中，已拒绝执行' };
    }
    const rejected = loopVerify.rejectRequest(command, timeoutSec);
    if (rejected) return { ran: false, exitCode: null, output: '', error: rejected };
    const record = store.readRecord(sessionId);
    const profile = record?.profile;
    const entry = sessionClients.get(sessionId);
    const remote = profile?.remote?.sshHost ? profile.remote : undefined;
    const cwd = remote
      ? sessionCwd(profile!, os.homedir())
      : (entry?.cwd || (profile ? sessionCwd(profile, os.homedir()) : os.homedir()));
    const result = await loopVerify.runVerifier(
      { command, timeoutSec, cwd, remote }, shellEnv, { buildSshArgs, shellQuote });
    logger.info('flow', `verify runId=${runId} host=${result.host} exit=${result.exitCode ?? 'n/a'}`
      + ` ran=${result.ran} ms=${result.durationMs} command=${JSON.stringify(command)}`);
    return result;
  }

  /**
   * RUNS — the instances a project owns. 「只把在运行中的skill归属到project」.
   *
   * Main is the single source of truth on purpose: the run canvas opens in its OWN window (the user's
   * choice), and two windows agreeing about a status is only possible if neither of them owns it. Every
   * change is broadcast to every window.
   */
  /**
   * 注册表变了就说一声 —— 「flow 应该在第一次生成的时候就保存,这样可以直接通过写文件的方式刷新」。
   *
   * 有了它,画布就不必靠内存里那份状态活着:落盘 → 广播 → 界面按文件重画。一份真相,重启也一致。
   */
  const broadcastFlowReg = (name: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('flowreg:changed', { name });
    }
  };

  const broadcastRun = (project: string, id: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('run:changed', { project, id });
    }
  };

  /**
   * 打开一个 run 的时候对一次账。
   *
   * 启动那一遍收拾的是"上次退出时留下的"；这一遍收拾的是"窗口刷新之后那一轮才答完的"—— 主进程没重启，
   * 所以启动清扫不会再跑，而那一轮完成时已经没有渲染层在等它了。你回来看这个 run 的时候正好是该发现
   * 它的时候。
   */
  /**
   * 清掉一条会话在后端的活动上下文 —— flow 复用会话时用。
   *
   * 「flow 里面确实存在几个步骤在同一个会话里面跑，但这些应该只保留关键信息，否则可能长期跑 flow
   * 会变得臃肿」。走 kiro-cli 的 `/clear`，和你在输入框里敲它是同一条路：**只清模型那一侧的对话，
   * 磁盘上的 transcript 不动**，所以这一步之前发生过什么仍然查得到，审计链完整。
   *
   * 为什么不是"每步调一次模型压缩"：那要花钱，而且压缩本身会丢东西。而该留的关键信息**已经结构化地
   * 留在别处了** —— 每一步的产出按 `produces` 进 run 的 `values`，下一步按 `consumes` 拼进自己的提示词。
   * 赖在会话里的那一份是纯冗余。判据（哪些步骤可以清）见 `flowContext.shouldClearBeforeStep`。
   *
   * `display` 不给可见文本：这是流程的内务，不该在你的对话里留下一条"用户说了 /clear"。
   */
  ipcMain.handle('acp:clear-context', async (_event, sessionId: string) => {
    if (!sessionId?.trim()) return { ok: false, error: '没有指定会话' };
    try {
      await sendPromptOnce(sessionId, [{ type: 'text', text: '/clear' }], undefined, {
        messageId: `flow_clear_${Date.now()}`,
      });
      logger.info('flow', `cleared context sessionId=${sessionId}`);
      return { ok: true };
    } catch (err: any) {
      // 清不掉不该让这一步跑不了 —— 最坏结果是上下文继续臃肿，而那是可以忍的
      logger.warn('flow', `clear context failed sessionId=${sessionId}: ${err?.message || err}`);
      return { ok: false, error: err?.message || 'clear failed' };
    }
  });

  /**
   * project 的工作目录 —— 它的会话都在这儿干活。
   *
   * 读:界面要显示当前值。写:先校验(不存在 / 不是目录 / 不是绝对路径都当场说),因为它错了的表现是
   * 「所有会话都起不来」,那时候人只会看到一条抽象的失败。
   */
  ipcMain.handle('project:get-workspace', async (_event, project: string) => ({
    workspace: projectStore.readProject(os.homedir(), project).workspace || '',
  }));

  ipcMain.handle('project:set-workspace', async (_event, project: string, workspace: string) => {
    const why = projectStore.whyNotWorkspace(workspace);
    if (why) return { ok: false, error: why };
    projectStore.writeProject(os.homedir(), project, { workspace });
    logger.info('project', `${project} workspace=${workspace || '(cleared → home)'}`);
    return { ok: true };
  });

  /**
   * OPEN THE CHAT THAT RAN A STEP — from the run window, in the main window.
   *
   * A run's steps each execute in their own session, and 「执行状态要在普通对话 UI 里看得见」: the canvas says
   * WHICH step is running, and the conversation is where you read what it actually said. The run window has no
   * chat of its own on purpose — there is no single conversation for a whole run.
   */
  ipcMain.handle('window:focus-session', async (_event, sessionId: string) => {
    if (!sessionId?.trim()) return { ok: false, error: '没有会话 id' };
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '主窗口不在' };
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('session:focus-request', { sessionId });
    return { ok: true };
  });

  /**
   * 钉住的会话全部做完 / 出错停下 —— 系统通知（Windows 右下角弹窗、macOS 通知中心），带提示音。
   *
   * 「是不是真的闲了、钉没钉住、写什么」渲染端已经判过了（`renderer/idleNotify.ts`）；这里只管
   * 「用户是不是正在看 KiroLex」—— 正在看就不发。点通知：窗口恢复到前台并切到那条会话。
   * 通知对象要留着引用，否则被 GC 掉之后点击事件就没了。
   */
  const idleNotices = new Set<Notification>();
  ipcMain.handle('app:notify-session-idle', async (_event, payload: { sessionId: string; title: string; body: string }) => {
    const sessionId = String(payload?.sessionId || '');
    if (!sessionId) return { shown: false, reason: 'no session' };
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const active = windowIsActive({
      exists: !!win,
      focused: !!win?.isFocused(),
      visible: !!win?.isVisible(),
      minimized: !!win?.isMinimized(),
    });
    if (active) return { shown: false, reason: 'window active' };
    if (!Notification.isSupported()) return { shown: false, reason: 'unsupported' };
    const notice = new Notification({
      title: String(payload?.title || 'KiroLex'),
      body: String(payload?.body || ''),
      silent: false,
    });
    idleNotices.add(notice);
    notice.on('click', () => {
      idleNotices.delete(notice);
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('session:focus-request', { sessionId });
    });
    notice.on('close', () => { idleNotices.delete(notice); });
    notice.show();
    logger.info('notify', `idle notice sessionId=${sessionId}`);
    return { shown: true };
  });

  /**
   * THE RUN CANVAS GETS ITS OWN WINDOW — the user's decision, and it needs main to own the state (above).
   *
   * Same renderer bundle, different view, chosen by query string: `?view=run`. One window per run, so asking
   * twice focuses the one already open rather than opening a second copy of the same thing.
   */
  const runWindows = new Map<string, BrowserWindow>();
  ipcMain.handle('window:open-run', async (_event, project: string, id: string) => {
    const key = `${project}/${id}`;
    const open = runWindows.get(key);
    if (open && !open.isDestroyed()) { open.focus(); return { ok: true, focused: true }; }
    const win = new BrowserWindow({
      width: 1180,
      height: 720,
      minWidth: 640,
      minHeight: 420,
      backgroundColor: '#1a1a1a',
      autoHideMenuBar: true,
      title: `运行 · ${id}`,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    runWindows.set(key, win);
    win.on('closed', () => runWindows.delete(key));
    const query = `view=run&project=${encodeURIComponent(project)}&run=${encodeURIComponent(id)}`;
    if (IS_DEV) win.loadURL(`${DEV_SERVER_URL}/?${query}`);
    else win.loadFile(path.join(__dirname, '../renderer/index.html'), { search: query });
    logger.info('run', `opened window for ${key}`);
    return { ok: true };
  });

  const approvalLocks = new Map<string, Promise<void>>();

  /** Deleted sessions whose files were still locked: id -> cancel its background retries. */
  const pendingPurgeRetries = new Map<string, () => void>();

  /**
   * THE ACTUAL DELETE — no guard here on purpose.
   *
   * 「这些会话应该删不了才对，都得让 flow 自行处理」：worker 会话属于**那次运行**，不属于侧栏。所以手删被
   * 拒（上面那道守卫），而 flow 自己的回收（重置一步、删一次运行、删一个 flow 的历史）必须仍然收得掉它
   * —— 否则「不许手删」就等于「永远删不掉」。守卫放在 IPC 那一层，这个函数是两条路共用的动作。
   */
  const purgeSession = async (sessionId: string): Promise<{ ok: boolean; tombstoned?: boolean; error?: string }> => {
    // Kill this chat's executor first (frees a slot, stops the kiro-cli process)
    // so deleting a chat never leaves an orphaned process running.
    //
    // Log WHAT is being deleted before touching anything. This path used to log
    // nothing at all, so when a 37-message chat vanished the only trace was the
    // parent directory's mtime -- who deleted it, and what it contained, were
    // unrecoverable facts. Title and size make an accidental delete obvious.
    try {
      const doomed = store.readRecord(sessionId);
      const bytes = store.transcriptFileSize(sessionId);
      logger.info('delete-session', `requested sessionId=${sessionId} title=${JSON.stringify(doomed?.title || '')}`
        + ` project=${JSON.stringify(doomed?.profile?.projectId || '')} transcriptBytes=${bytes}`);
    } catch {}
    deletedSessionIds.add(sessionId); // block any racing/subsequent load-session resurrection
    // Durable tombstone FIRST: `deletedSessionIds` is in-memory only, so if the
    // directory cannot be removed right now (kiro-cli may still hold the
    // transcript open — disconnect is asynchronous) the chat used to come back on
    // the next boot. The tombstone hides it and gets the removal retried.
    addSessionTombstone(sessionId);
    // WAIT for the executor to really be gone before touching the directory.
    // kiro-cli's working directory is sessions/<id>/files, and on Windows a live
    // process (or a shell it started) keeps that directory from being moved --
    // that was the EBUSY on delete. disconnect() waits up to 5s for a clean exit,
    // then force-kills (with its process tree on Windows); cap the wait so a
    // wedged teardown can never hang the delete.
    await waitAtMost(detachExecutor(sessionId, { killTree: true }), 8000);

    // Remove the directory, retrying with real (async) waits: the rename can fail with EBUSY/EPERM
    // while the just-disconnected process releases its file handles. The old code
    // called rmSync once with no try/catch, so a failure rejected the IPC — and the
    // renderer swallowed that error, leaving the chat on disk to be rehydrated.
    //
    // RECOVERABLE BY DEFAULT: the directory is MOVED to ~/.kirolex/trash/ rather
    // than destroyed. A real chat -- 37 messages, its rendered history, its whole
    // transcript -- was lost this way, and with no Time Machine destination and no
    // local snapshots on this machine there was nothing to restore from. A rename
    // is also atomic and cannot half-finish, unlike a recursive delete. Only the
    // trash is ever hard-deleted, and only once it ages out.
    // (Retry policy and the trash fallback live in `sessionPurge.ts`, where they are tested.)
    const removeDirs = async (delaysMs?: number[]): Promise<string | null> => {
      const removeDir = (dir: string) => moveDirToTrash(dir, {
        trashDir: SESSION_TRASH_DIR,
        name: sessionId,
        delaysMs,
        log: (level, msg) => logger[level]('delete-session', msg),
      });
      let error: string | null = await removeDir(path.join(sessionsBaseDir, sessionId));
      // Sweep any directory whose name embeds this session id (legacy layouts).
      try {
        if (fs.existsSync(sessionsBaseDir)) {
          for (const dir of fs.readdirSync(sessionsBaseDir)) {
            if (dir === sessionId || dir.includes(sessionId)) {
              const e = await removeDir(path.join(sessionsBaseDir, dir));
              if (e && !error) error = e;
            }
          }
        }
      } catch { /* best-effort */ }
      return error;
    };

    const error: string | null = await removeDirs();
    // Also delete this chat's session-specific memory.
    try { deleteSessionMemory(sessionId); } catch { /* best-effort */ }
    // Drop draft paste refs for the gone chat so its blobs become collectable.
    try {
      const map = loadDraftPastes();
      if (map[sessionId]) { delete map[sessionId]; saveDraftPastes(map); }
    } catch {}

    /**
     * 告诉窗口这条会话没了 —— 在**唯一的回收入口**上广播，而不是让每个调用方各自记得回传 id。
     *
     * 「run 删了之后左侧还是显示有三个空的会话」：`run:remove` 里 `purgeRunSessions` 返回的是**个数**，
     * 会话 id 从来没回传给渲染层，而渲染层只 forget 了 `cascaded`（锚）—— 于是被真正关掉的 worker
     * 还留在侧栏，点进去是空的，要到下次启动才消失。
     *
     * 补在这里而不是补 `run:remove`：回收的入口有五六处（重置、删 run、删 flow 历史、清扫、手删），
     * 逐个补一遍，下一个新增的路径又会漏。这条广播在**文件真的移走之后**发，所以它说的是既成事实。
     *
     * 即使文件没能完全删掉（下面那个 error 分支）也要广播：那种情况已经立了墓碑、会话对 app 来说
     * 就是不存在了，留在侧栏才是错的。
     */
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('acp:sessions-purged', { sessionIds: [sessionId] });
    }
    if (error) {
      logger.warn('delete-session', `${sessionId}: files not fully removed (${error}); tombstoned, will retry in the background and at next start`);
      // Don't rely on the next boot alone: retry a few times while the app runs
      // (30s, 2min, 5min). The tombstone stays until a retry really removes it.
      pendingPurgeRetries.get(sessionId)?.();
      pendingPurgeRetries.set(sessionId, scheduleBackgroundRetries(async () => {
        const e = await removeDirs([200, 500, 1000]);
        if (e) {
          logger.warn('delete-session', `${sessionId}: background retry still blocked (${e})`);
          return false;
        }
        pendingPurgeRetries.delete(sessionId);
        clearSessionTombstone(sessionId);
        logger.info('delete-session', `${sessionId}: background retry removed the leftover files`);
        return true;
      }, { onGiveUp: () => pendingPurgeRetries.delete(sessionId) }));
      return { ok: false, tombstoned: true, error };
    }
    pendingPurgeRetries.get(sessionId)?.();
    pendingPurgeRetries.delete(sessionId);
    clearSessionTombstone(sessionId); // fully gone — no need to keep the marker
    return { ok: true };
  };

  /**
   * 按**会话记录**收掉一个 flow 在一个 project 里的会话 —— 不经过 run 文件。
   *
   * 为什么不能只有 `purgeFlowRunSessions`：那个函数遍历 run 去拿 `node.sessionId`，也就是说
   * **run 是会话的唯一索引**。于是「删运行」如果不先收会话，那些 worker 就再也枚举不到 —— 实测过一次：
   * 一个 project 里该 flow 的 run 一条不剩，而它的主会话和 3 条 worker 还躺在侧栏里，worker 又被
   * `acp:delete-session` 无条件拒绝手删，能带走它们的主会话则因为「这个 project 还在用这个 flow」
   * 而拒删 —— 三方互锁，没有任何入口能收。
   *
   * 所以判据换成记录自己带的 `flow` + `projectId`：它不依赖 run 还在不在，因此既是删运行时的正路，
   * 也能顺手收掉之前已经锁死的那些。
   *
   * `includeAnchor` 分开给：删**一条** run 时只该收这条 run 的 worker，主会话还锚着别的运行；只有这个
   * flow 在这个 project 里一条运行都不剩时，主会话才没有东西可锚。
   * 结构会话（`skill`／「修改 flow · X」）一律不收 —— 它对着的是**定义**，跟某次运行的存亡无关。
   */
  const purgeFlowSessionsByRecord = async (
    project: string,
    flow: string,
    opts: { includeAnchor: boolean; except?: string },
  ): Promise<string[]> => {
    const name = (flow || '').trim();
    const want = (project || '').trim();
    if (!name) return [];
    const purged: string[] = [];
    for (const other of store.listSessions()) {
      if (opts.except && other.id === opts.except) continue;
      const purpose = (other as any).purpose;
      if (purpose !== 'flow-worker' && !(opts.includeAnchor && purpose === 'flow-main')) continue;
      if ((other.flow || '').trim() !== name) continue;
      if ((((other as any).profile)?.projectId || '').trim() !== want) continue;
      try {
        await purgeSession(other.id);
        purged.push(other.id);
      } catch (err: any) {
        logger.warn('session', `cascade delete failed for ${other.id}: ${err?.message || err}`);
      }
    }
    return purged;
  };

  ipcMain.handle('acp:delete-session', async (_event, sessionId: string) => {
    /**
     * A FLOW'S MAIN SESSION IS NOT DELETABLE — refused HERE, not only in the menu.
     *
     * 「这个会话不能被用户手动删掉」/「只能通过 flow 内部的按钮删会话，不能通过左侧的删除会话按钮」。
     * 菜单把它置灰，但目录是在这里真的消失的，而只写在菜单里的规则离被绕过只差一个快捷键或一条以后新增的
     * 代码路径。flow 自己的回收走 `purgeSession`（不经过这道守卫），所以「不许手删」不等于「永远删不掉」。
     */
    // 这条记录既被下面的守卫用，也被再下面的级联用，所以读一次、共用一份。
    const rec = store.readRecord(sessionId);
    {
      /**
       * 子会话（`flow-worker` / `skill`）：无条件拒。它们由流程创建、由流程关闭，进度和上下文也由
       * 流程自己保留；手删一条正在跑某一步的 worker，run 记录里那个 sessionId 就指向一个不存在的
       * 会话 —— 那一步既不会完成也不会失败。
       *
       * 不看「project 还在不在用这个 flow」：worker 属于**某一次运行**，不属于那个使用关系。
       * 流程自己的回收走 `purgeSession`（见上），所以这条守卫不会挡住它该做的清理。
       */
      if (rec?.purpose === 'flow-worker') {
        const flow = (rec.flow || '').trim();
        const project = ((rec.profile as any)?.projectId || '').trim();
        /**
         * 和主会话**同一套判据**：`!detached && definitionExists && runsLeft > 0`。
         *
         * 只有在流程还活着的时候拦才有意义 —— 那时候流程界面能删它。一旦这个 flow 的运行被清空
         * （或被移出 project、或定义已从库里删掉），流程界面就够不着这条 worker 了，再拦着就是死锁：
         * 实测磁盘上有 3 条这样的 worker（flow「SFDC activity」的 run 已全部清零），侧栏删不掉、
         * 流程界面里也不存在。
         */
        void project;
      }
      if (rec?.purpose === 'flow-main') {
        const flow = (rec.flow || '').trim();
        const project = ((rec.profile as any)?.projectId || '').trim();
      }
    }
    /**
     * 级联：删掉 flow 的锚（主会话 / skill 会话）时，把属于它的 worker 子会话一起删 ——
     * 「删的时候需要把它所属的子会话也删掉」。
     *
     * 为什么必须级联：worker 被禁止手删（上面那道守卫），所以如果删锚不带走它们，它们就成了永远
     * 删不掉的孤儿 —— 侧栏里躺着一堆属于已经不存在的流程的会话，而唯一能删它们的入口（流程界面）
     * 也随着锚一起没了。
     *
     * 归属的判据是 `flow` + `project`，和已有的 `removeFlowRuns(home, project, flow)` 同一套口径 ——
     * 记录里没有 parentSessionId，这两个字段是现有的唯一线索。
     *
     * 走 `purgeSession` 而不是递归回这个 handler：那样会被 worker 的守卫拒掉。这正是那句注释说的
     * 「flow 自己的回收走 purgeSession，所以『不许手删』不等于『永远删不掉』」。
     */
    const cascaded: string[] = [];
    if (rec?.purpose === 'flow-main' || rec?.purpose === 'skill') {
      const flow = (rec.flow || '').trim();
      const project = ((rec.profile as any)?.projectId || '').trim();
      if (flow) {
        for (const other of store.listSessions()) {
          if (other.id === sessionId) continue;
          if (other.purpose !== 'flow-worker') continue;
          if ((other.flow || '').trim() !== flow) continue;
          if ((((other as any).profile)?.projectId || '').trim() !== project) continue;
          try {
            await purgeSession(other.id);
            cascaded.push(other.id);
          } catch (err: any) {
            logger.warn('session', `cascade delete failed for ${other.id}: ${err?.message || err}`);
          }
        }
      }
      if (cascaded.length) {
        logger.info('session', `deleting ${rec.purpose} ${sessionId}: cascaded ${cascaded.length} worker session(s) of ${flow}`);
      }
    }
    const result = await purgeSession(sessionId);
    // `cascaded` 交给渲染层：它是按 id 从列表里摘会话的，不然这些会话要到下次启动才消失。
    return { ...result, cascaded };
  });


  // Named kiro-cli agents available to the composer selector. The CLI has no
  // JSON mode for this command, so parse its stable tabular output from both
  // stdout and stderr (some kiro-cli versions write the listing to stderr).
  ipcMain.handle('kiro:list-agents', async (_event, machine?: string) => {
    try {
      /*
        **agent 列表也按机器分** ——「对远程会话，那个机器人按钮显示的还是本地的 agent 列表，
        不是远程的」。

        和模型清单同一个病（`acp:list-models`）：kiro-cli 只认**它自己机器上** `~/.kiro/agents/`
        里的 agent，所以一条远程会话能用的是**那台**机器上的那几个。拿本机的列表给它选，
        选中的名字在远端不存在 —— 而那条路是有兜底的（`remoteAgentScript` 会退回默认 agent
        并在会话里说一句），也就是说下拉在骗你、而且结果是静默换了个 agent。

        列表里要滤掉 KiroLex 自己生成的 `kirolex-local-<会话>` —— 那是每条远程会话的私有配置
        （URL 里带着它的 token），选它等于把两条会话的工具通道接到一起。
      */
      if (machine && machine !== 'local') {
        const target = findRemoteTarget(KIROLEX_CONFIG_PATH, machine);
        if (!target?.sshHost) throw new Error(`找不到这台机器（${machine}）—— 设置里删掉了？`);
        const bin = remoteKiroBin(target);
        if (!bin) throw new Error(`还没有设置 ${target.sshHost} 上的 kiro 启动命令（设置 → 🖥 机器）。`);
        const out = await runRemoteCapture(target, `${shellQuote(bin)} agent list 2>&1`)
          .catch((err) => { throw new Error(`问不到 ${target.sshHost} 的 agent 列表：${err?.message || err}`); });
        /*
          这里用**共用**前缀而不是 `OWNED_AGENT_PREFIX`：下拉要隐藏所有 KiroLex 生成的会话 agent，
          包括别台笔记本留下的 —— 它们对你同样不可选（URL 里带着别人那条会话的 token）。
          "只管自己的"那条规矩管的是**删和杀**，不是显示。
        */
        return { agents: parseAgentList(out).filter((a) => !a.name.startsWith(SESSION_AGENT_PREFIX)) };
      }
      // 和 list-models 同一个病：日志里 `agent list` 也在 15s 反复被 kill，同样是挂载时并发双发。
      // single-flight + 30s，理由见 `acp:list-models` 那段注释。
      //
      // 共享的是**原始输出**而不是解析结果：解析在下面，第二个调用者拿到字符串再自己走同一段解析，
      // 语义完全一致；如果直接把解析后的对象缓存起来共享，就得把这段解析抽出去，而它只有一个用处。
      if (!listAgentsInFlight) {
        listAgentsInFlight = runKiroCli('agent list 2>&1', 30000)
          .finally(() => { listAgentsInFlight = null; });
      }
      const output = await listAgentsInFlight;
      return { agents: parseAgentList(output) };
    } catch (err: any) {
      return { agents: [], error: err?.message || String(err) };
    }
  });

  const resolveKiroAgentConfigPath = (
    sessionId: string,
    agentName: string,
    source?: 'built-in' | 'global' | 'local',
  ): { path?: string; error?: string } => {
    if (!/^[A-Za-z0-9_.-]+$/.test(agentName)) {
      return { error: 'Invalid Agent name.' };
    }
    if (source === 'built-in') {
      return { error: `${agentName} is a built-in Agent and cannot be edited.` };
    }

    const workspaceDirectory = sessionClients.get(sessionId)?.cwd || process.cwd();
    const localDirectory = path.join(workspaceDirectory, '.kiro', 'agents');
    const globalDirectory = path.join(os.homedir(), '.kiro', 'agents');
    const directories = source === 'local'
      ? [localDirectory]
      : source === 'global'
      ? [globalDirectory]
      : [localDirectory, globalDirectory];

    const findConfigInDirectory = (directory: string): string | undefined => {
      // Most user-created Agents use <name>.json, so keep the zero-scan path.
      const directPath = path.join(directory, `${agentName}.json`);
      if (fs.existsSync(directPath)) return directPath;
      if (!fs.existsSync(directory)) return undefined;

      // AIM-managed configs can carry a package prefix in the filename (for
      // example AmazonBuilderCoreAIAgents-apollo-deployment-assistant.json).
      // The JSON `name` field is the authoritative displayed Agent name.
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const candidate = path.join(directory, entry.name);
        try {
          const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
          if (parsed?.name === agentName) return candidate;
        } catch {
          // Ignore unrelated invalid JSON here; the editor validates the
          // selected config after it has been resolved.
        }
      }
      return undefined;
    };

    const configPath = directories
      .map(findConfigInDirectory)
      .find((candidate): candidate is string => !!candidate);

    return configPath
      ? { path: configPath }
      : { error: `No ${source || 'local or global'} configuration file was found for ${agentName}.` };
  };

  /*
    **机器人按钮的其余几个 tab**（MCP / Steering / Prompts / Skills / Powers / Settings）——
    见 `kiroConfig.ts`。

    **跟着会话所在的机器走**：远程会话的执行器读的是那台机器上的 `~/.kiro`，在这台 Mac 上改
    等于什么都没改（而且看起来改成功了 —— 最难查的那种）。没有会话时按本机。
  */
  const kiroConfigTargetFor = (sessionId?: string): RemoteTarget | undefined => {
    if (!sessionId) return undefined;
    const r = sessionClients.get(sessionId)?.profile.remote || store.readRecord(sessionId)?.profile?.remote;
    return r?.sshHost ? r : undefined;
  };
  /**
   * 在远端 `~/.kiro/agents` 里找某个 agent 的文件：先 `<名字>.json`，找不到再按 JSON 里的
   * `"name"` 字段找（AIM 装的那些文件名带包前缀）—— 和本机 `resolveKiroAgentConfigPath` 同一个找法。
   * 输出 `PATH <相对家目录的路径>` + base64 内容。名字调用前已过 `[A-Za-z0-9_.-]` 白名单。
   */
  const remoteAgentFindScript = (agentName: string): string => [
    `n=${shellQuote(agentName)}; d="$HOME/.kiro/agents"; f="$d/$n.json"`,
    `[ -f "$f" ] || f=$(grep -lE "\"name\"[[:space:]]*:[[:space:]]*\"$n\"" "$d"/*.json 2>/dev/null | head -1)`,
    'if [ -n "$f" ] && [ -f "$f" ]; then echo "PATH ${f#"$HOME"/}"; base64 -w0 < "$f"; echo; else echo NOTFOUND; fi',
  ].join('; ');
  const kiroConfigWhere = (t?: RemoteTarget): string =>
    (t ? (labelForHost(KIROLEX_CONFIG_PATH, t.sshHost) || t.sshHost) : '本机');

  ipcMain.handle('kiro:config-categories', (_event, engine?: string) =>
    /* RegExp 过不了 IPC，渲染层也用不到它。按会话的引擎给 tab（不传 = kiro，和原来一样） */
    kiroCategoriesFor(engineOf({ engine })).map(({ match: _m, ...rest }) => rest));

  ipcMain.handle('kiro:config-list', async (_event, sessionId: string | undefined, category: string) => {
    const spec = categorySpec(category);
    if (!spec) return { ok: false, error: `不认识的类别 ${category}` };
    const target = kiroConfigTargetFor(sessionId);
    try {
      if (!target) return { ok: true, where: kiroConfigWhere(), entries: new LocalKiroConfig(os.homedir()).list(spec) };
      const out = await runRemoteCapture(target, remoteListScript(spec, shellQuote), 30_000);
      const lines = String(out || '').split('\n').filter(Boolean);
      const entries = spec.kind === 'single'
        ? lines.slice(0, 1).map((l) => ({ name: spec.file!, size: Number(l.split('\t')[1]) }))
        : parseRemoteList(spec, String(out || ''));
      return { ok: true, where: kiroConfigWhere(target), entries };
    } catch (err: any) {
      return { ok: false, where: kiroConfigWhere(target), error: err?.message || String(err) };
    }
  });

  ipcMain.handle('kiro:config-read', async (_event, sessionId: string | undefined, category: string, name?: string) => {
    const spec = categorySpec(category);
    if (!spec) return { ok: false, error: `不认识的类别 ${category}` };
    const target = kiroConfigTargetFor(sessionId);
    try {
      if (!target) {
        const r = new LocalKiroConfig(os.homedir()).read(spec, name);
        return 'error' in r ? { ok: false, error: r.error } : { ok: true, ...r, where: kiroConfigWhere() };
      }
      const rel = relPath(spec, name);
      if (!rel) return { ok: false, error: '名字不合规。' };
      const got = parseRemoteRead(await runRemoteCapture(target, remoteReadScript(rel, shellQuote), 30_000));
      return {
        ok: true, path: `~/${rel}`, where: kiroConfigWhere(target), exists: got.exists,
        content: got.exists ? got.content : (spec.json ? '{}\n' : ''),
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('kiro:config-write', async (
    _event, sessionId: string | undefined, category: string, name: string | undefined, content: string,
  ) => {
    const spec = categorySpec(category);
    if (!spec) return { ok: false, error: `不认识的类别 ${category}` };
    const why = validateContent(spec, String(content ?? '')) || pluginWriteError(name);
    if (why) return { ok: false, error: why };
    const target = kiroConfigTargetFor(sessionId);
    try {
      if (!target) {
        const r = new LocalKiroConfig(os.homedir()).write(spec, name, String(content));
        if ('error' in r) return { ok: false, error: r.error };
        logger.info('kiro-config', `本机 ${spec.id} 已保存 ${r.path}`);
        return { ok: true, path: r.path };
      }
      const rel = relPath(spec, name);
      if (!rel) return { ok: false, error: '名字不合规。' };
      await writeRemoteFile(target, remoteWriteScript(rel, shellQuote), Buffer.from(String(content), 'utf-8').toString('base64'));
      logger.info('kiro-config', `${target.sshHost} ${spec.id} 已保存 ~/${rel}`);
      return { ok: true, path: `~/${rel}` };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('kiro:open-agent-config', async (
    _event,
    sessionId: string,
    agentName: string,
    source?: 'built-in' | 'global' | 'local',
  ) => {
    /*
      **远程会话改远端那份** —— 和其余几个 tab 一致（见 `kiroConfigTargetFor`）。
      原来这里永远读写本机 `~/.kiro/agents`，而远程会话的执行器用的是那台机器上的 agent：
      在这里改了、看着保存成功了，远端什么都没变。
    */
    const remoteT = kiroConfigTargetFor(sessionId);
    if (remoteT) {
      if (!/^[A-Za-z0-9_.-]+$/.test(agentName)) return { opened: false, error: 'Invalid Agent name.' };
      if (source === 'built-in') return { opened: false, error: `${agentName} 是内置的，不能改。` };
      try {
        const got = await runRemoteCapture(remoteT, remoteAgentFindScript(agentName), 30_000);
        const m = /^PATH (.+)$/m.exec(got);
        if (!m) return { opened: false, error: `${kiroConfigWhere(remoteT)} 上没有 ${agentName} 的配置文件（~/.kiro/agents）。` };
        const body = got.slice(got.indexOf(m[0]) + m[0].length).trim();
        return { opened: true, path: `${kiroConfigWhere(remoteT)}:~/${m[1]}`, content: Buffer.from(body, 'base64').toString('utf-8') };
      } catch (err: any) {
        return { opened: false, error: err?.message || String(err) };
      }
    }
    const resolved = resolveKiroAgentConfigPath(sessionId, agentName, source);
    if (!resolved.path) return { opened: false, error: resolved.error };

    try {
      return {
        opened: true,
        path: resolved.path,
        content: await fs.promises.readFile(resolved.path, 'utf-8'),
      };
    } catch (error: any) {
      return { opened: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('kiro:save-agent-config', async (
    _event,
    sessionId: string,
    agentName: string,
    source: 'built-in' | 'global' | 'local' | undefined,
    content: string,
  ) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error: any) {
      return { saved: false, error: `Invalid JSON: ${error?.message || String(error)}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { saved: false, error: 'Agent configuration must be a JSON object.' };
    }

    const remoteT = kiroConfigTargetFor(sessionId);
    if (remoteT) {
      if (!/^[A-Za-z0-9_.-]+$/.test(agentName) || source === 'built-in') return { saved: false, error: '这个 agent 不能改。' };
      try {
        const got = await runRemoteCapture(remoteT, remoteAgentFindScript(agentName), 30_000);
        const m = /^PATH (\.kiro\/agents\/[^\n/]+\.json)$/m.exec(got);
        if (!m) return { saved: false, error: `${kiroConfigWhere(remoteT)} 上找不到 ${agentName} 的配置文件。` };
        await writeRemoteFile(remoteT, remoteWriteScript(m[1], shellQuote), Buffer.from(content, 'utf-8').toString('base64'));
        logger.info('kiro-config', `${remoteT.sshHost} agent ${agentName} 已保存 ~/${m[1]}`);
        return { saved: true, path: `${kiroConfigWhere(remoteT)}:~/${m[1]}` };
      } catch (err: any) {
        return { saved: false, error: err?.message || String(err) };
      }
    }
    const resolved = resolveKiroAgentConfigPath(sessionId, agentName, source);
    if (!resolved.path) return { saved: false, error: resolved.error };

    const temporaryPath = `${resolved.path}.kirolex-${process.pid}.tmp`;
    try {
      const originalMode = (await fs.promises.stat(resolved.path)).mode;
      await fs.promises.writeFile(temporaryPath, content, {
        encoding: 'utf-8',
        mode: originalMode,
      });
      await fs.promises.rename(temporaryPath, resolved.path);
      return { saved: true, path: resolved.path };
    } catch (error: any) {
      try { await fs.promises.unlink(temporaryPath); } catch {}
      return { saved: false, error: error?.message || String(error) };
    }
  });

  // A model is bound at kiro-cli process launch. Replace the executor while
  // loading the SAME ACP session so conversation context survives and the new
  // model applies to the next prompt. The old executor stays live on failure.
  /**
   * **把一条已有会话切到另一台机器（或切回本地）** ——「AI角色扮演这个应该是远程的」。
   *
   * 设计里定的就是这条路（`docs/DESIGN_remote_sessions.md`「中途切换」）：换执行器 + 逐段重建，
   * 和换模型走同一套机械（kiro-cli 的后端会话跟进程绑定，换机器必然换进程）。
   *
   * 三件事的顺序是**故意**的：
   *   · 有一轮在跑就拒绝 —— 切换会把执行器连根拔掉，那一轮的产出会凭空消失。
   *   · **切回本地之前先把远端的改动拉干净**：不拉就等于把远端那份工作永久留在那台机器上，
   *     而本地是唯一真相 —— 这一步失败就中止切换（宁可不切，也不丢东西）。
   *   · 切到远程之前要有一个**具体的项目目录**：没有目录没法做镜像，而拿家目录顶上就是
   *     —— 这一条随镜像一起没了：远端没有副本，目录只决定 `local_*` 的相对路径。
   */
  /**
   * 换机器 / 换工作目录共用的那一段机械。
   *
   * 收的是一个 `RemoteTarget`（不是 id）：只改目录那条路不该再去配置里按 label 反查一遍 ——
   * 查不到时反查会得到 `undefined`，而"没有目标"的意思是**切回本地**。只想换个目录、
   * 顺手把会话从远端切了下来，是那种改完很久才发现的错。
   */
  /**
   * **还没连上过的新会话没有记录** ——「新会话无法切换引擎或运行位置，显示找不到会话记录」。
   * 记录是 acp:new-session 连上之后才写的；连不上（比如本机 kiro-cli 坏了）的新会话就一直没有记录，
   * 而那正是最想把它换个引擎 / 换台机器的时候。这里给它建一份最小的（默认模型 + 渲染层告诉我们的项目），
   * 切换写进去，下次连接就按新的来。删掉过的会话（墓碑）不建 —— 否则会把它复活。
   */
  const coldRecordFor = (sessionId: string, hint?: { projectId?: string | null }): store.SessionRecord | null => {
    const existing = store.readRecord(sessionId);
    if (existing) return existing;
    if (!/^s_[\w-]+$/.test(sessionId)) return null;
    if (deletedSessionIds.has(sessionId) || loadSessionTombstones().includes(sessionId)) return null;
    const profile: AgentProfile = {
      model: DEFAULT_MODEL, preferredModel: DEFAULT_MODEL, permissionMode: 'auto-approve',
      ...(hint?.projectId ? { projectId: hint.projectId } : {}),
    };
    logger.info('session', `新会话还没有记录（没连上过），切换前先建一份 sessionId=${sessionId} project=${hint?.projectId || '(无)'}`);
    return store.createSession(sessionId, profile);
  };

  const applySessionTarget = async (
    sessionId: string,
    target: RemoteTarget | undefined,
    localDir?: string,
    hint?: { projectId?: string | null },
  ): Promise<{ ok: boolean; unchanged?: boolean; remoteHost?: string | null; cold?: boolean }> => {
    const oldEntry = sessionClients.get(sessionId);
    /*
      **右键菜单优先于正在跑的任务** ——「这些右键菜单应该优先级大于正在跑的任务」。

      换机器必然换执行器，所以那一轮确实会断。上一版为此直接拒绝，结果一条长回合跑着的时候
      什么都做不了 —— 而那正是你想改设置的时候。现在照做，只是**明确告诉你那一轮被打断了**：
      对话内容一条不丢（transcript 已经落盘），断掉的只是这一轮还没产出的部分。
    */
    const interrupted = !!oldEntry?.busy;
    if (reconfiguringSessions.has(sessionId)) throw new Error('上一次切换还没完成，稍等。');

    const rec0 = oldEntry ? store.readRecord(sessionId) : coldRecordFor(sessionId, hint);
    if (!oldEntry && !rec0) throw new Error('找不到这条会话的记录。');
    const currentRemote = oldEntry?.profile.remote?.sshHost || rec0?.profile?.remote?.sshHost || '';
    const wasRemote = !!currentRemote;
    /*
      目标没变**而且目录也没变**才算没变化 —— 切机器时可以顺带给一个新的本地目录，
      短路写成只看目标的话那次改动会被当成 no-op 吞掉。
    */
    const dirChanged = !!localDir
      && localDir !== (store.readRecord(sessionId)?.localDir || oldEntry?.localDir || '');
    if ((target?.sshHost || '') === currentRemote && !dirChanged) return { ok: true, unchanged: true };

    /*
      **切回本地不再需要"先把远端的改动拉回来"** —— 镜像没了（见 `localMcp.ts`）：远端从来没有
      这个项目的副本，它一直是通过反向隧道改**你机器上**那一份。所以切回本地没有东西要搬，
      那一步、以及它那句"拉不回来就不切"的拒绝，跟着镜像一起去掉。
    */

    /*
      **没有项目目录不是问题** ——「为什么还需要什么具体项目目录啊」。

      本地那条没归项目的会话，cwd 用的就是它自己的会话目录（`~/.kirolex/sessions/<id>/`）。
      远程没有任何理由多要一个目录：镜像同一个东西就行（它本来就在推 —— history.md 和附件都在里面）。
      上一版在这里要求"必须指定一个项目目录"，那是我把"必须镜像点什么"和"必须有个项目"混成了一件事。

      家目录那道闸仍然要过 —— 只有一种情况会撞上它：目录真的是家目录（渲染层传 `'~'` 的那条老路）。
    */
    const nextLocalDir = localDirOrSessionDir(
      sessionId,
      localDir || rec0?.localDir || oldEntry?.localDir,
    );
    /* 家目录那道闸随镜像一起去掉了：没有东西会被推走 */

    const hostLabelOf = (t?: RemoteTarget): string | null =>
      (t ? (labelForHost(KIROLEX_CONFIG_PATH, t.sshHost) || t.sshHost || null) : null);

    /*
      **没连上的会话：只改记录就够** ——「会话还没连上也应该能切远程切 project 啊」。
      执行器是下次打开时按记录起的，所以这时候没有任何东西要换；要求"先连上"纯属多余的门槛。
    */
    if (!oldEntry) {
      const rec = rec0!;
      rec.profile = { ...rec.profile, remote: target ? { ...target } : undefined } as AgentProfile;
      rec.localDir = nextLocalDir;
      store.writeRecord(rec);
      const where = target ? `远端 ${hostLabelOf(target)}` : '本地';
      sessionNotice(sessionId, `🔀 这条会话下次打开会跑在**${where}**上（工作目录 \`${nextLocalDir}\`）。`
        + `它现在没有连着，所以没有执行器要换；对话一条都没动。`);
      logger.info('remote', `切换目标（未连接）sessionId=${sessionId} -> ${target?.sshHost || '本地'}`);
      mainWindow?.webContents.send('session:targets-changed', { sessionId, remoteHost: hostLabelOf(target), localDir: nextLocalDir });
      return { ok: true, remoteHost: hostLabelOf(target), cold: true };
    }

    await awaitAttachIdle(sessionId);
    reconfiguringSessions.add(sessionId);
    emitSessionBusy(sessionId);
    const profile: AgentProfile = { ...oldEntry.profile, remote: target ? { ...target } : undefined };
    try {
      if (target) {
        if (engineOf(profile) !== 'kiro') {
          await remoteAdapterCheck(profile.remote!, engineOf(profile) as 'claude' | 'codex');
        } else {
          const models = await remotePreflight(profile.remote!);
          profile.model = pickRemoteModel(sessionId, profile.model, models, profile.remote!.sshHost || '');
        }
      }
      /* 换机器 = 换进程 = 后端是空的：起一条**新的**后端会话，上下文按既有那条路重建 */
      const cliCwd = sessionCwd(profile, nextLocalDir);
      const localTools = await ensureLocalTools(sessionId, profile, nextLocalDir);
      const client = new AcpClient(profile.model, shellEnv, profile.kiroAgent, profile.permissionMode, profile.remote, localTools, engineOf(profile));
      try {
        await client.connect();
        const made = await withLoadTimeout(client.newSession(cliCwd), loadTimeoutFor(profile.remote), 'session/new');
        const nextEntry: SessionEntry = {
          ...oldEntry,
          client,
          cliSessionId: made.sessionId,
          profile,
          cwd: cliCwd,
          localDir: nextLocalDir,
          assistantBuf: '',
          assistantMsgId: null,
          fileChanges: [],
          lastUsedAt: Date.now(),
          busy: false,
        };
        try { await oldEntry.client.disconnect(); } catch { /* 旧的已经没用了 */ }
        sessionClients.set(sessionId, nextEntry);
        wireSession(sessionId, nextEntry);

        const rec = store.readRecord(sessionId) || store.createSession(sessionId, profile);
        rec.profile = profile;
        rec.cliSessionId = made.sessionId;
        rec.localDir = nextLocalDir;
        rec.executorState = 'attached';
        store.writeRecord(rec);
        clearContextEstablished(sessionId);
        markContextOwedIfUnverified(sessionId, 'switch-remote-target');
        restoreContextAfterExecutorSwap(sessionId, 'switch-remote-target');

        const where = target ? `远端 ${hostLabelOf(target)}` : '本地';
        sessionNotice(sessionId, `🔀 这条会话从现在开始跑在**${where}**上（工作目录 \`${nextLocalDir}\`）。`
          + `后端会话是新的，上下文会随下一条消息带过去；之前的对话一条都没动。`
          + (interrupted ? `\n（切换打断了正在跑的那一轮 —— 已产出的内容都在，未完成的那部分没了，需要的话重发一次。）` : ''));
        logger.info('remote', `切换目标 sessionId=${sessionId} -> ${target?.sshHost || '本地'} dir=${nextLocalDir}`);
        mainWindow?.webContents.send('session:targets-changed', { sessionId, remoteHost: hostLabelOf(target), localDir: nextLocalDir });
        return { ok: true, remoteHost: hostLabelOf(target) };
      } catch (err) {
        try { await client.disconnect(); } catch {}
        throw err;
      }
    } finally {
      reconfiguringSessions.delete(sessionId);
      emitSessionBusy(sessionId);
    }
  };

  ipcMain.handle('acp:set-remote-target', async (
    _event,
    sessionId: string,
    remoteId: string | null,
    localDir?: string,
    hint?: { projectId?: string | null },
  ) => {
    const target = remoteId ? findRemoteTarget(KIROLEX_CONFIG_PATH, remoteId) : undefined;
    if (remoteId && !target) throw new Error(`找不到远端目标 ${remoteId}（设置里删掉了？）—— 没有猜一台机器。`);
    return applySessionTarget(sessionId, target, localDir, hint);
  });

  ipcMain.handle('acp:engine-models', (_event, sessionId: string) => {
    const entry = sessionClients.get(sessionId);
    return entry && engineOf(entry.profile) !== 'kiro' ? engineModelsPayload(sessionId, entry) : null;
  });

  /**
   * Claude Code / Codex 换模型 / effort / 权限模式：同一个进程里 `session/set_config_option` 就行，
   * 不用像 kiro 那样换执行器。选了就记在会话上，下次连上（`applyEngineModel`）设回去。
   */
  const setEngineOption = async (sessionId: string, category: EngineOptionCategory, value: string) => {
    const entry = sessionClients.get(sessionId);
    if (!entry) throw new Error('这条会话现在没有连着，连上之后再换（点一下它或发一条消息就会重连）。');
    const engine = engineOf(entry.profile);
    if (engine === 'kiro') throw new Error('kiro 会话不走这条路');
    if (entry.busy) throw new Error('等这一轮回复完再换。');
    await entry.client.setSelectOption(entry.cliSessionId, category, value);
    entry.profile = category === 'model'
      ? { ...entry.profile, engineModels: { ...entry.profile.engineModels, [engine]: value } }
      : {
        ...entry.profile,
        engineOptions: { ...entry.profile.engineOptions, [engine]: { ...entry.profile.engineOptions?.[engine], [category]: value } },
      };
    const rec = store.readRecord(sessionId);
    if (rec) { rec.profile = entry.profile; store.writeRecord(rec); }
    const payload = engineModelsPayload(sessionId, entry);
    mainWindow?.webContents.send('session:engine-models', payload);
    return payload;
  };
  ipcMain.handle('acp:set-engine-model', (_event, sessionId: string, model: string) => setEngineOption(sessionId, 'model', model));
  ipcMain.handle('acp:set-engine-option', (_event, sessionId: string, category: string, value: string) => {
    if (category !== 'thought_level' && category !== 'mode') throw new Error(`不认识的选项 ${category}`);
    return setEngineOption(sessionId, category, value);
  });

  /**
   * **休眠的会话也能改 model / agent / 权限** —— 「❌ Error invoking remote method
   * 'acp:switch-kiro-agent': Error: Session not connected」。
   *
   * 三个 switch 原来都是"没有活的执行器就抛错"。可一次重启之后大多数会话都在休眠 ——
   * 于是点开任意一条老对话去换 agent，得到的是一句 Electron 的原始报错。而这件事根本不需要
   * 执行器：kiro-cli 是在**启动进程时**绑定 `--agent` / `--model` 的，所以"下次挂起时用哪个"
   * 本来就只是记录里的字段（attach 那边读的正是 `existing.profile`）。换引擎 / 换机器早就是
   * 这么做的（没连着就只改记录），这里补上剩下三条。
   *
   * 所以休眠时**写记录、返回成功**，并标 `dormant: true` 让界面别把它标成 attached。
   * `executorState` 不动 —— 它本来就不是 attached。没有记录才是真错误（attach 那边同样
   * 拒绝重建，见 "ATTACH MUST NOT CREATE"）。`onlyKiro` 给 model / agent 用：Claude Code /
   * Codex 会话的这两样不归 kiro 管，休眠时也一样拒绝。
   */
  const setDormantProfile = (
    sessionId: string, patch: Partial<AgentProfile>, what: string, onlyKiro?: string,
  ): { ok: true; dormant: true } => {
    const rec = store.readRecord(sessionId);
    if (!rec) throw new Error('该会话在磁盘上不存在（可能已被删除）。');
    if (onlyKiro && engineOf(rec.profile) !== 'kiro') throw new Error(onlyKiro);
    rec.profile = { ...rec.profile, ...patch };
    store.writeRecord(rec);
    logger.info('acp', `${what} on dormant session ${sessionId} —— 下次挂起时生效`);
    return { ok: true, dormant: true };
  };

  ipcMain.handle('acp:switch-model', async (_event, sessionId: string, model: string) => {
    const oldEntry = sessionClients.get(sessionId);
    /* 模型下拉是 kiro 的清单；Claude Code / Codex 用它们自己 CLI 配的模型（界面上也不显示这个下拉） */
    const notKiroModel = (p: AgentProfile) => `${ENGINE_LABEL[engineOf(p)]} 会话的模型在它自己的 CLI 里配，这里还不能切。`;
    if (oldEntry && engineOf(oldEntry.profile) !== 'kiro') throw new Error(notKiroModel(oldEntry.profile));
    const normalizedModel = model.trim() || DEFAULT_MODEL;
    /*
      休眠：`--model` 是启动执行器时绑的，记下来就行（见 `setDormantProfile`）。两个字段一起写 ——
      `preferredModel` 是"你选的"（attach 只认它），`model` 是"这次用的"；和下面活着那条一样记机器。
    */
    if (!oldEntry) {
      const rec = store.readRecord(sessionId);
      return {
        ...setDormantProfile(sessionId, {
          model: normalizedModel, preferredModel: normalizedModel,
          modelEarnedOn: machineKeyOf(rec?.profile || {}),
        }, `model -> ${normalizedModel}`, rec ? notKiroModel(rec.profile) : undefined),
        model: normalizedModel,
      };
    }
    if (oldEntry.busy) throw new Error('Wait for the current response to finish before switching models.');
    if (reconfiguringSessions.has(sessionId)) throw new Error('Another model, Agent, or permission change is still in progress.');

    if (oldEntry.profile.model === normalizedModel) return { ok: true, model: normalizedModel };

    // Never release/reload a session while an attach is mid-flight on it --
    // that race is what produced the bare "Internal error" from kiro-cli.
    await awaitAttachIdle(sessionId);
    reconfiguringSessions.add(sessionId);
    emitSessionBusy(sessionId);
    // An EXPLICIT user choice also becomes the new preference (retried first on
    // later attaches), unlike an automatic fallback which leaves it untouched.
    const profile: AgentProfile = {
      ...oldEntry.profile, model: normalizedModel, preferredModel: normalizedModel,
      /* 手动选的也记机器：它同时进了 `preferredModel`，所以换机器时仍然会先试它 */
      modelEarnedOn: machineKeyOf(oldEntry.profile),
    };
    const cliSessionId = oldEntry.cliSessionId;
    const cwd = oldEntry.cwd;
    // kiro-cli enforces single-process ownership of a session: session/load on an
    // id still held by another process fails with
    //   "Failed to start session: Session is active in another process (PID n)".
    // So the OLD executor must release the session BEFORE the replacement loads
    // it; starting the replacement first can never succeed. On failure we restore
    // the previous executor (old model) so the chat is not left detached.
    const restoreOldExecutor = async () => {
      const previous = new AcpClient(
        oldEntry.profile.model, shellEnv, oldEntry.profile.kiroAgent,
        oldEntry.profile.permissionMode, oldEntry.profile.remote, undefined, engineOf(oldEntry.profile),
      );
      try {
        await previous.connect();
        await withLoadTimeout(previous.loadSession(cliSessionId, cwd), loadTimeoutFor(oldEntry.profile.remote));
        const restored: SessionEntry = {
          ...oldEntry, client: previous, lastUsedAt: Date.now(),
          assistantBuf: '', assistantMsgId: null, fileChanges: [],
        };
        sessionClients.set(sessionId, restored);
        wireSession(sessionId, restored);
      } catch (restoreError) {
        logger.warn('switch-model', `failed to restore previous executor sessionId=${sessionId}`, restoreError);
        try { await previous.disconnect(); } catch {}
        /*
          **在会话里说一句** —— 只写日志的话用户看到的是"模型没换成，然后这条会话不能用了",
          而原因（那条 kiro-cli 会话的锁还被上一个进程握着）只有日志里有。
        */
        sessionNotice(sessionId, `⚠️ 换模型失败，而且回滚也没成功 —— 这条会话现在没连着执行器。`
          + `点一下它会自动重连（重连走的是常规那条路，是可靠的）。`);
        /*
          **回滚也失败了 → 把盘上的状态说成实话** —— 实测这条路走过两次（07:59、08:00），
          而记录里还写着 `attached`：于是界面以为它连着，下一次发送答的是「Session not connected」。
          写成 detached 之后走的是常规的"没连着 → 连上"那条路（`ensureAttached` / 点一下会话），
          那条路本来就是可靠的。
        */
        const rec = store.readRecord(sessionId);
        if (rec) { rec.executorState = 'detached'; store.writeRecord(rec); }
        emitSessionBusy(sessionId);
      }
    };

    sessionClients.delete(sessionId); // release the slot + ownership claim
    try { await oldEntry.client.disconnect(); } catch {}

    /* 换执行器 = 换 ssh = 换隧道：本地工具要重新备一次（token 和端口都跟着这次启动） */
    const localTools = await ensureLocalTools(sessionId, profile, localProjectDirOf(sessionId, oldEntry));
    const client = new AcpClient(profile.model, shellEnv, profile.kiroAgent, profile.permissionMode, profile.remote, localTools, engineOf(profile));
    try {
      await client.connect();
      await withLoadTimeout(client.loadSession(cliSessionId, cwd), loadTimeoutFor(profile.remote));
      const nextEntry: SessionEntry = {
        client,
        cliSessionId,
        profile,
        cwd,
        assistantBuf: '',
        assistantMsgId: null,
        fileChanges: [],
        lastUsedAt: Date.now(),
      };
      sessionClients.set(sessionId, nextEntry);
      wireSession(sessionId, nextEntry);

      const rec = store.readRecord(sessionId) || store.createSession(sessionId, profile);
      rec.profile = profile;
      rec.cliSessionId = cliSessionId;
      rec.executorState = 'attached';
      store.writeRecord(rec);
      // A model switch means a NEW kiro-cli process, i.e. a blank backend even
      // though the session id is unchanged. In snapshot mode the snapshot rides
      // along with the next message (nothing to do here); only verbatim mode owes
      // a real rebuild. See restoreContextAfterExecutorSwap.
      restoreContextAfterExecutorSwap(sessionId, 'switch-model');
      return { ok: true, model: normalizedModel };
    } catch (err) {
      try { await client.disconnect(); } catch {}
      await restoreOldExecutor();
      throw err;
    } finally {
      reconfiguringSessions.delete(sessionId);
      emitSessionBusy(sessionId);
    }
  });


  // Auto/Ask is handled at the ACP permission-request boundary, so it can be
  // changed instantly without replacing the executor or reloading the session.
  ipcMain.handle('acp:switch-permission-mode', async (
    _event,
    sessionId: string,
    permissionMode: 'auto-approve' | 'ask',
  ) => {
    const entry = sessionClients.get(sessionId);
    const normalizedMode = permissionMode === 'ask' ? 'ask' : 'auto-approve';
    /* 休眠：写记录就够了 —— 下次挂起时按记录起（见 `setDormantProfile`） */
    if (!entry) {
      return {
        ...setDormantProfile(sessionId, { permissionMode: normalizedMode }, `permission -> ${normalizedMode}`),
        permissionMode: normalizedMode,
      };
    }

    entry.client.setPermissionMode(normalizedMode);
    entry.profile.permissionMode = normalizedMode;

    const rec = store.readRecord(sessionId)
      || store.createSession(sessionId, entry.profile);
    rec.profile = { ...rec.profile, permissionMode: normalizedMode };
    rec.cliSessionId = entry.cliSessionId;
    rec.executorState = 'attached';
    store.writeRecord(rec);

    return { ok: true, permissionMode: normalizedMode };
  });

  // kiro-cli binds --agent at process launch, so changing agents requires a
  // fresh executor. Start the replacement first; only swap it into the live
  // map after it is ready, then disconnect the old executor. This avoids a
  // failed switch taking down an otherwise healthy session. The visible chat
  // and durable transcript remain; the selected agent starts fresh context and
  // receives the normal layered-memory injection on its next prompt.
  ipcMain.handle('acp:switch-kiro-agent', async (_event, sessionId: string, agentName: string) => {
    const oldEntry = sessionClients.get(sessionId);
    const normalizedAgent = agentName.trim() || undefined;
    /* 休眠：`--agent` 是启动执行器时才绑的，所以现在只需要记下"下次用哪个"（见 `setDormantProfile`） */
    if (!oldEntry) {
      return {
        ...setDormantProfile(sessionId, { kiroAgent: normalizedAgent }, `agent -> ${normalizedAgent || '(default)'}`, 'kiro agent 只对 Kiro 会话有用。'),
        kiroAgent: normalizedAgent || '',
      };
    }
    if (engineOf(oldEntry.profile) !== 'kiro') throw new Error('kiro agent 只对 Kiro 会话有用。');
    if (oldEntry.busy) throw new Error('Wait for the current response to finish before switching agents.');
    if (reconfiguringSessions.has(sessionId)) throw new Error('Another model, Agent, or permission change is still in progress.');

    if (oldEntry.profile.kiroAgent === normalizedAgent) {
      return { ok: true, kiroAgent: normalizedAgent || '' };
    }

    await awaitAttachIdle(sessionId);
    reconfiguringSessions.add(sessionId);
    emitSessionBusy(sessionId);
    const profile: AgentProfile = { ...oldEntry.profile, kiroAgent: normalizedAgent };
    /* 换执行器 = 换 ssh = 换隧道：本地工具要重新备一次（token 和端口都跟着这次启动） */
    const localTools = await ensureLocalTools(sessionId, profile, localProjectDirOf(sessionId, oldEntry));
    const client = new AcpClient(profile.model, shellEnv, profile.kiroAgent, profile.permissionMode, profile.remote, localTools, engineOf(profile));
    try {
      await client.connect();
      const created = await client.newSession(oldEntry.cwd);
      const nextEntry: SessionEntry = {
        client,
        cliSessionId: created.sessionId,
        profile,
        cwd: oldEntry.cwd,
        assistantBuf: '',
        assistantMsgId: null,
        fileChanges: [],
        lastUsedAt: Date.now(),
      };
      sessionClients.set(sessionId, nextEntry);
      wireSession(sessionId, nextEntry);
      try { await oldEntry.client.disconnect(); } catch {}

      const rec = store.readRecord(sessionId) || store.createSession(sessionId, profile);
      rec.profile = profile;
      rec.cliSessionId = created.sessionId;
      rec.executorState = 'attached';
      store.writeRecord(rec);
      mainWindow?.webContents.send('session:ready-for-first-prompt', {
        sessionId,
        projectId: profile.projectId,
      });
      // Agent switch is even more destructive than a model switch: a brand new
      // process AND a brand new cli session id, so the backend is unquestionably
      // empty. That still does not make a dedicated rebuild turn the right answer
      // in snapshot mode -- the snapshot is built from KiroLex's own transcript, so
      // it restores a fresh cli session just as well while riding along with the
      // next message. Same policy as the model switch, deliberately one function.
      restoreContextAfterExecutorSwap(sessionId, 'switch-agent');
      return { ok: true, kiroAgent: normalizedAgent || '' };
    } catch (err) {
      try { await client.disconnect(); } catch {}
      throw err;
    } finally {
      reconfiguringSessions.delete(sessionId);
      emitSessionBusy(sessionId);
    }
  });

  /**
   * **给已有的会话换引擎** ——「我还需要现有会话也能切换 agent 运行类型」。
   *
   * 和换机器 / 换 kiro agent 同一套机械：先起新的、再断旧的，后端会话是新的，上下文从 KiroLex
   * 自己的记录重建（随下一条消息带过去）。对话一条都不动。没连着的会话只改记录 —— 下次打开时
   * 按新引擎起（和「运行位置」那条路一样，「没连上也应该能切」）。
   */
  ipcMain.handle('acp:switch-engine', async (_event, sessionId: string, engineArg: string, hint?: { projectId?: string | null }) => {
    const engine = engineOf({ engine: engineArg });
    const label = ENGINE_LABEL[engine];
    const oldEntry = sessionClients.get(sessionId);
    /* 没连着、也还没有记录的新会话：先建一份（见 coldRecordFor） */
    const rec0 = oldEntry ? store.readRecord(sessionId) : coldRecordFor(sessionId, hint);
    const before = engineOf(oldEntry?.profile || rec0?.profile);
    if (before === engine) return { ok: true, unchanged: true, engine };
    /* kiro 的模型 id / agent 对另外两家没意义；切回 kiro 时用你选过的偏好模型 */
    const reshape = (p: AgentProfile): AgentProfile => {
      const next: AgentProfile = { ...p };
      if (engine === 'kiro') {
        delete (next as any).engine;
        const pref = p.preferredModel && p.preferredModel !== 'default' ? p.preferredModel : DEFAULT_MODEL;
        next.model = pref;
        next.preferredModel = pref;
        next.modelEarnedOn = undefined;
      } else {
        (next as any).engine = engine;
        next.model = 'default';
        next.kiroAgent = undefined;
      }
      return next;
    };

    if (!oldEntry) {
      if (!rec0) throw new Error('找不到这条会话的记录。');
      rec0.profile = reshape(rec0.profile);
      store.writeRecord(rec0);
      sessionNotice(sessionId, `🤖 这条会话下次打开会由 **${label}** 来跑。它现在没有连着，所以没有执行器要换；对话一条都没动。`);
      mainWindow?.webContents.send('session:engine-changed', { sessionId, engine });
      logger.info('engine', `切换引擎（未连接）sessionId=${sessionId} ${ENGINE_LABEL[before]} -> ${label}`);
      return { ok: true, engine, cold: true };
    }
    if (oldEntry.busy) throw new Error('这一轮还在跑 —— 等它结束再换引擎。');
    if (reconfiguringSessions.has(sessionId)) throw new Error('另一个切换（模型 / agent / 机器）还没做完。');

    await awaitAttachIdle(sessionId);
    reconfiguringSessions.add(sessionId);
    emitSessionBusy(sessionId);
    const profile = reshape(oldEntry.profile);
    let client: AcpClient | undefined;
    try {
      if (profile.remote?.sshHost) {
        if (engine !== 'kiro') await remoteAdapterCheck(profile.remote, engine);
        else {
          const models = await remotePreflight(profile.remote);
          profile.model = pickRemoteModel(sessionId, profile.model, models, profile.remote.sshHost || '');
        }
      }
      const localTools = await ensureLocalTools(sessionId, profile, localProjectDirOf(sessionId, oldEntry));
      const started = await connectWithModelFallback(profile, 'switch-engine', localTools, sessionId);
      client = started.client;
      profile.model = started.model;
      const created = await client.newSession(oldEntry.cwd);
      const nextEntry: SessionEntry = {
        ...oldEntry,
        client,
        cliSessionId: created.sessionId,
        profile,
        assistantBuf: '',
        assistantMsgId: null,
        fileChanges: [],
        lastUsedAt: Date.now(),
        busy: false,
      };
      try { await oldEntry.client.disconnect(); } catch { /* 旧的已经没用了 */ }
      sessionClients.set(sessionId, nextEntry);
      wireSession(sessionId, nextEntry);

      const rec = store.readRecord(sessionId) || store.createSession(sessionId, profile);
      rec.profile = profile;
      rec.cliSessionId = created.sessionId;
      rec.executorState = 'attached';
      store.writeRecord(rec);
      clearContextEstablished(sessionId);
      markContextOwedIfUnverified(sessionId, 'switch-engine');
      restoreContextAfterExecutorSwap(sessionId, 'switch-engine');
      sessionNotice(sessionId, `🤖 这条会话从现在开始由 **${label}** 来跑。后端会话是新的，上下文会随下一条消息带过去；之前的对话一条都没动。`);
      mainWindow?.webContents.send('session:engine-changed', { sessionId, engine });
      logger.info('engine', `切换引擎 sessionId=${sessionId} ${ENGINE_LABEL[before]} -> ${label}`);
      return { ok: true, engine };
    } catch (err) {
      if (client) { try { await client.disconnect(); } catch {} }
      logger.warn('engine', `切换引擎失败 sessionId=${sessionId} ${ENGINE_LABEL[before]} -> ${label}`, err);
      throw err;
    } finally {
      reconfiguringSessions.delete(sessionId);
      emitSessionBusy(sessionId);
    }
  });

  /**
   * **🔑 登录** —— Claude Code / Codex 在**远端机器上**的登录（「不要在当前电脑登录，要在远程机器上打开登录」）。
   * 只对远端：本机的登录是你自己在这台电脑上配好的，这一页不碰它。三种方式见 `aiLogin.ts`。
   */
  const aiLoginTarget = (machine: string): RemoteTarget => {
    /*
      机器人面板里那一页传的是**会话 id**（「放到右侧会话框的左下角那个机器人图案中」）：登录给这条会话跑的那台机器。
      本机的会话不在这里登录 ——「不要在当前电脑登录」。
    */
    if (/^s_/.test(machine)) {
      const r = kiroConfigTargetFor(machine);
      if (!r) throw new Error('这条会话在本机跑 —— 本机的 Claude Code / Codex 登录是你自己在这台电脑上配的，这里不碰。要在远端登录，先右键「运行位置」把会话切到那台机器。');
      return r;
    }
    const t = findRemoteTarget(KIROLEX_CONFIG_PATH, machine);
    if (!t?.sshHost) throw new Error(`找不到这台机器（${machine}）—— 设置里删掉了？`);
    return t;
  };
  const SEP = 'KX_LOGIN_SEP_7f3a';

  /** 状态：一次 ssh 问齐。只回状态和网关主机名 —— 密钥读到主进程为止，不出去。 */
  ipcMain.handle('ai-login:status', async (_event, machine: string) => {
    try {
      const remote = aiLoginTarget(machine);
      const out = await runRemoteCapture(remote, [
        /* 「装没装」和「登没登」分开判：`codex login status` 没登录时退出码非 0，用 `&& … ||` 会被当成"没装" */
        'if command -v claude >/dev/null 2>&1; then claude auth status --json </dev/null 2>&1; else echo KX_NO_CLAUDE; fi',
        `echo ${SEP}`,
        'if command -v codex >/dev/null 2>&1; then codex login status </dev/null 2>&1; else echo KX_NO_CODEX; fi',
        `echo ${SEP}`,
        'cat ~/.claude/settings.json 2>/dev/null || true',
        `echo ${SEP}`,
        'cat ~/.codex/config.toml 2>/dev/null || true',
      ].join('; '), 45_000);
      const [claudeOut, codexOut, settings, toml] = out.split(SEP).map((x) => x.trim());
      const gw = pickClaudeEnv(settings || '').ANTHROPIC_BASE_URL;
      /* 走 Bedrock 时没有"登录"这回事（凭证是那台机器的 AWS 凭证链），状态直接说走的是 Bedrock */
      const cb = claudeBedrockOf(settings || '');
      const xb = codexBedrockOf(toml || '');
      const claude = parseClaudeStatus(claudeOut || '', gw);
      const codex = parseCodexStatus(codexOut || '', codexGateway(toml || ''));
      return {
        ok: true,
        claude: cb && claude.installed ? { ...claude, loggedIn: true, detail: `走 Amazon Bedrock（global，${cb.region || '?'}）`, gateway: undefined } : claude,
        codex: xb && codex.installed ? { ...codex, loggedIn: true, detail: `走 Amazon Bedrock（${xb.model || '?'} @ ${xb.region || '?'}）`, gateway: undefined } : codex,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  /**
   * **「拷入本机配置」**：把这台电脑上那份变成编辑器里的文本（`aiLogin.ts` 的 claudeEditorText / codexEditorText）。
   * 只读本机文件、不写任何地方；你在编辑器里看一眼、改一改，点「写到那台机器上」才会动远端。
   */
  ipcMain.handle('ai-login:local-config', (_event, tool: 'claude' | 'codex') => {
    const read = (...rel: string[]): string => { try { return fs.readFileSync(path.join(os.homedir(), ...rel), 'utf-8'); } catch { return ''; } };
    return tool === 'claude'
      ? { ok: true, text: claudeEditorText(read('.claude', 'settings.json')) }
      : { ok: true, text: codexEditorText(read('.codex', 'config.toml')) };
  });

  /**
   * **把编辑器里的配置写到那台机器上** ——「手动填写」就是那个编辑器。
   * Claude Code：JSON（env 的键值）→ 合并进那台机器的 ~/.claude/settings.json 的 `env`；
   * Codex：TOML 片段（顶层 model / model_provider + 一个 [model_providers.<id>] 段）→ 合并进 ~/.codex/config.toml。
   * 写之前把原文件备份成 `.kirolex-bak`；只改这几项，其余逐字保留（见 aiLogin.ts）。
   */
  /** 那台机器的 AWS region：先问 IMDSv2（EC2），再看 AWS CLI 的配置；最后一行是结果 */
  const REMOTE_REGION_SCRIPT = 'T=$(curl -s -m 3 -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null); '
    + 'R=$(curl -s -m 3 -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null); '
    + '[ -z "$R" ] && R=$(aws configure get region 2>/dev/null); echo "${R:-us-east-1}"';

  ipcMain.handle('ai-login:apply', async (_event, machine: string, input: { tool: 'claude' | 'codex'; text?: string; mode?: 'manual' | 'bedrock' }) => {
    try {
      const remote = aiLoginTarget(machine);
      const writeTo = async (file: string, content: string): Promise<void> => {
        const dir = file.slice(0, file.lastIndexOf('/'));
        await writeRemoteFile(remote,
          `mkdir -p ${dir} && { [ -f ${file} ] && cp -p ${file} ${file}.kirolex-bak || true; } && cat > ${file} && chmod 600 ${file}`,
          content);
      };
      /*
        **Amazon Bedrock（默认推荐）** ——「默认将模型设置为 bedrock 的 global endpoint」。不写任何凭证：用那台机器的
        AWS 凭证链（EC2 实例角色等）。Claude Code 用那台机器自己的 region（global 推理配置文件在各区都能用）；
        Codex 的 region 固定 us-east-1（见 aiLogin.ts 的 BEDROCK_DEFAULTS）。手动填写 / 官方登录照旧可选。
      */
      if (input.mode === 'bedrock') {
        if (input.tool === 'claude') {
          const region = (await runRemoteCapture(remote, REMOTE_REGION_SCRIPT, 30_000)).trim().split(/\s+/).pop() || 'us-east-1';
          const existing = await runRemoteCapture(remote, 'cat ~/.claude/settings.json 2>/dev/null || true', 30_000);
          await writeTo('~/.claude/settings.json', claudeBedrockSettings(existing, region));
          logger.info('ai-login', `Claude Code 改成走 Amazon Bedrock（${remote.sshHost}，region=${region}，global 推理配置文件）`);
        } else {
          const existing = await runRemoteCapture(remote, 'cat ~/.codex/config.toml 2>/dev/null || true', 30_000);
          await writeTo('~/.codex/config.toml', codexBedrockToml(existing));
          logger.info('ai-login', `Codex 改成走 Amazon Bedrock（${remote.sshHost}，${BEDROCK_DEFAULTS.codex.model} @ ${BEDROCK_DEFAULTS.codex.region}）`);
        }
        return { ok: true };
      }
      if (input.tool === 'claude') {
        const env = parseClaudeEditor(String(input.text || ''));
        const existing = await runRemoteCapture(remote, 'cat ~/.claude/settings.json 2>/dev/null || true', 30_000);
        await writeTo('~/.claude/settings.json', mergeClaudeSettings(existing, env));
        logger.info('ai-login', `Claude Code 配置写到 ${remote.sshHost}（${Object.keys(env).join('/')}）`);
      } else {
        const provider = parseCodexEditor(String(input.text || ''));
        const existing = await runRemoteCapture(remote, 'cat ~/.codex/config.toml 2>/dev/null || true', 30_000);
        await writeTo('~/.codex/config.toml', applyCodexProvider(existing, provider));
        logger.info('ai-login', `Codex 配置写到 ${remote.sshHost}（provider=${provider.id}）`);
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  /**
   * **官方账号登录**：在那台机器上跑 `claude auth login` / `codex login --device-auth`，输出原样推给界面
   * （里面有授权网址和验证码），界面上那颗「在浏览器打开」用这台电脑的浏览器打开它（「那还是就在当前设备打开浏览器吧」），
   * Claude 那条还要把浏览器给的 code 贴回去（`ai-login:input`）。命令本身跑在**远端**：登录落在那台机器上。
   */
  const loginRuns = new Map<string, ChildProcess>();
  ipcMain.handle('ai-login:run', async (_event, machine: string, tool: 'claude' | 'codex', opts?: { console?: boolean }) => {
    try {
      const remote = aiLoginTarget(machine);
      const cmd = tool === 'claude' ? `claude auth login${opts?.console ? ' --console' : ''}` : 'codex login --device-auth';
      const runId = `login_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const child = spawn('ssh', buildSshArgs(remote, `bash -lc ${shellQuote(cmd)}`), { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnv(remote) });
      loginRuns.set(runId, child);
      /* ANSI 颜色/光标码去掉 —— 界面上是一段纯文本 */
      const clean = (b: Buffer): string => b.toString('utf-8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      const push = (chunk: string): void => { mainWindow?.webContents.send('ai-login:output', { runId, chunk }); };
      child.stdout?.on('data', (b: Buffer) => push(clean(b)));
      child.stderr?.on('data', (b: Buffer) => push(clean(b)));
      child.on('exit', (code) => {
        loginRuns.delete(runId);
        mainWindow?.webContents.send('ai-login:exit', { runId, code });
        logger.info('ai-login', `${tool} 官方登录（${remote.sshHost}）结束 code=${code}`);
      });
      logger.info('ai-login', `${tool} 官方登录开始（${remote.sshHost}）：${cmd}`);
      return { ok: true, runId };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
  ipcMain.handle('ai-login:input', (_event, runId: string, line: string) => {
    const child = loginRuns.get(runId);
    if (!child?.stdin) return { ok: false, error: '这次登录已经结束了。' };
    child.stdin.write(`${String(line).trim()}\n`);
    return { ok: true };
  });
  ipcMain.handle('ai-login:cancel', (_event, runId: string) => {
    const child = loginRuns.get(runId);
    if (child) { try { child.kill(); } catch { /* 已经走了 */ } }
    return { ok: true };
  });

  ipcMain.handle('app:get-home-dir', () => {
    return os.homedir();
  });

  ipcMain.handle('app:get-logs', (_event, maxLines?: number) => {
    return { text: logger.tail(maxLines || 500), path: logger.logPath };
  });

  ipcMain.handle('app:open-logs', async () => {
    try {
      shell.showItemInFolder(logger.logPath);
      return { ok: true };
    } catch (error: any) {
      logger.error('open-logs', 'failed to reveal log file', error);
      return { ok: false, error: error?.message || String(error) };
    }
  });

  const WORKSPACE_PREVIEW_MAX_BYTES = 512 * 1024;

  // Open a URL in the default browser, or a file/folder path in the OS. Used by
  // clickable links/paths rendered in chat messages.
  ipcMain.handle('app:open-external', async (_event, target: string, sessionId?: string) => {
    if (!target) return { ok: false };
    try {
      if (/^(https?:|mailto:|tel:)/i.test(target)) {
        await shell.openExternal(target);
      } else {
        // Resolve the SAME way app:path-exists / workspace:read do, so a relative
        // or ~-prefixed path handed over from chat still points at the real file
        // instead of being resolved against the app process cwd.
        const p = resolveUserPath(target, sessionId);
        const err = await shell.openPath(p);
        if (err) return { ok: false, error: err };
      }
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  // 预览侧栏的「📂 打开位置」：在资源管理器 / Finder 里打开文件所在文件夹并选中它。
  // 和 app:open-external 走同一个 resolveUserPath，相对路径 / ~ 开头的也指向真文件。
  ipcMain.handle('app:show-in-folder', (_event, target: string, sessionId?: string) => {
    if (!target) return { ok: false, error: 'No path.' };
    try {
      const p = resolveUserPath(target, sessionId);
      if (!fs.existsSync(p)) return { ok: false, error: 'File not found.' };
      shell.showItemInFolder(p);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  // Read an image straight off disk as a data URL, with NO session involved.
  //
  // Attachment thumbnails used to go through `workspace:read`, which starts with
  // `if (!entry) throw new Error('This chat is not connected.')` -- so a purely
  // local file read was gated behind that chat having a live kiro-cli. A chat that
  // was dormant (or simply not attached yet when its messages first rendered) showed
  // 🖼️ + "Screenshot 1" instead of the picture, and never retried. The bytes on
  // disk have nothing to do with the backend, so nothing here asks about one.
  ipcMain.handle('app:image-data-url', (_event, filePath: string) => {
    try {
      if (!filePath) return null;
      let p = stripFileUrl(filePath);
      if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
      if (!path.isAbsolute(p)) p = path.resolve(os.homedir(), p);
      const mime = IMAGE_MIME_BY_EXT[path.extname(p).toLowerCase()];
      if (!mime) return null;
      const stats = fs.statSync(p);
      if (!stats.isFile() || stats.size > 25 * 1024 * 1024) return null;
      return { path: p, dataUrl: `data:${mime};base64,${fs.readFileSync(p).toString('base64')}` };
    } catch {
      return null; // missing/unreadable: the caller falls back to an icon
    }
  });


  ipcMain.handle('app:path-exists', (_event, filePath: string, sessionId?: string) => {
    try {
      if (!filePath) return false;
      /*
        和打开走同一个解析（resolveUserPath）—— 原来这里自己按 `entry.cwd || 家目录` 解析，远程会话还一律
        回 true：于是"显示成链接"和"点了能不能打开"是两套判断，看起来是链接、点了 ENOENT。
        远程那头的文件（只在那台机器上的路径）在本机打不开，就不该显示成链接。
      */
      if (fs.existsSync(resolveUserPath(filePath, sessionId))) return true;
      /* 远端那台机器上的路径：直接算"能点"（不为每个链接开一次 ssh —— 一次要好几秒），点开时再去读，
         真没有就在标签页里说清楚（见 readRemoteFile） */
      return !!remoteFileFor(sessionId, filePath);
    } catch {
      return false;
    }
  });

  /** Where to start browsing, and what relative paths are relative TO.
   *
   *  A session is an optional HINT here, never a requirement. The whole workspace
   *  trio used to open with `if (!entry) throw new Error('This chat is not
   *  connected.')`, so the file browser died with that message whenever the focused
   *  chat had no live kiro-cli -- which is the normal state for a dormant chat, and
   *  the state of every chat before its executor attaches. Listing a local directory
   *  has nothing to do with whether a backend exists. `app:path-exists` and
   *  `app:open-external` already take sessionId as an optional resolution base for
   *  exactly this reason; these three now match them.
   *
   *  A REMOTE session's cwd is a path on the other host, so it is deliberately not
   *  used as a local base -- it would only ENOENT. Home is used instead and the
   *  panel's path bar shows where it actually landed. */
  function workspaceBase(sessionId?: string | null): string {
    const entry = sessionId ? sessionClients.get(sessionId) : undefined;
    if (entry && !entry.profile.remote?.sshHost && entry.cwd) return entry.cwd;
    return os.homedir();
  }

  /**
   * Expand `file://` and `~`, then resolve relatives.
   *
   * **相对路径按这条会话自己的目录找** ——「为啥这两个会话里的文件链接打不开」。会话里写出来的相对路径
   * （`files/blog-draft-v1.md`、`channel/digest_diff.py`）指的是这条会话在本机的文件夹：cwd 固定成
   * `sessions/<id>/files/` 之后，模型有时相对 files/ 说、有时相对会话目录说（"files/xxx"）。原来一律按
   * workspaceBase 解析 —— 远程会话和渲染层没带会话 id 的情况都落到家目录，于是全部 ENOENT。
   * 现在依次试：会话的 files/ → 会话目录 → 项目设的工作目录 → workspaceBase（家目录 / 本地 cwd），
   * 取第一个存在的；都不存在就返回第一个（报错里给的是最可能的那个路径）。会话不需要连着。
   */
  function resolveUserPath(filePath: string, sessionId?: string | null): string {
    let p = stripFileUrl(filePath);
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (path.isAbsolute(p)) return p;
    const bases: string[] = [];
    if (sessionId && /^[\w.-]+$/.test(sessionId) && fs.existsSync(path.join(sessionsBaseDir, sessionId))) {
      bases.push(path.join(sessionsBaseDir, sessionId, SESSION_FILES_DIR), path.join(sessionsBaseDir, sessionId));
      const profile = sessionClients.get(sessionId)?.profile || store.readRecord(sessionId)?.profile;
      const ws = profile ? projectWorkspaceFor(profile) : '';
      if (ws) bases.push(ws);
    }
    bases.push(workspaceBase(sessionId));
    const candidates = bases.map((b) => path.resolve(b, p));
    return candidates.find((c) => fs.existsSync(c)) || candidates[0];
  }

  ipcMain.handle('workspace:list', (_event, sessionId?: string | null, directory?: string) => {
    const target = path.resolve(directory || workspaceBase(sessionId));
    const entries = fs.readdirSync(target, { withFileTypes: true })
      .map((dirent) => ({ name: dirent.name, isDir: dirent.isDirectory() }))
      .sort((left, right) => (
        left.isDir === right.isDir
          ? left.name.localeCompare(right.name)
          : left.isDir ? -1 : 1
      ));
    return { path: target, parent: path.dirname(target), entries };
  });

  /**
   * **远程会话在它自己那台机器上写的文件** ——「在会话中我根本不能点开看文件」。
   *
   * 远端那条会话用它自己的工具写文件，落在那台机器上（`/home/ec2-user/kirolex/scratch/…`），本机根本
   * 没有 —— 于是"这一轮改了哪些文件"里一排都是「文件已不存在」。本机找不到、而它像是那台机器上的路径时，
   * 返回那台机器和远端路径，由 `readRemoteFile` 用 ssh 读。
   *   · POSIX 绝对路径，但**不含 `/Users/`**：那是 Mac 上的路径（这些会话以前在 Mac 上跑过），哪儿都读不到；
   *   · 相对路径按那条会话在远端的 cwd 拼。
   * 只读：远端文件不进 `reviewedPaths`，`review:write-file` 照旧拒写。
   */
  function remoteFileFor(sessionId: string | null | undefined, rawPath: string): { target: RemoteTarget; path: string } | null {
    if (!sessionId) return null;
    const target = kiroConfigTargetFor(sessionId);
    if (!target?.sshHost) return null;
    const p = stripFileUrl(rawPath).trim();
    if (!p || p.includes('\\') || /^[A-Za-z]:/.test(p) || p.startsWith('~')) return null;
    if (p.startsWith('/')) return p.startsWith('/Users/') ? null : { target, path: p };
    const cwd = sessionClients.get(sessionId)?.cwd;
    return cwd && cwd.startsWith('/') ? { target, path: path.posix.join(cwd, p) } : null;
  }

  /** 用 ssh 读远端一个文件（base64 回来，和配置面板那条路一样），形状和本地读的结果一致。 */
  async function readRemoteFile(target: RemoteTarget, remotePath: string) {
    const MAX = WORKSPACE_PREVIEW_MAX_BYTES;
    const script = `f=${shellQuote(remotePath)}; if [ -d "$f" ]; then echo KXDIR; elif [ -f "$f" ]; then printf 'KXSIZE %s\\n' "$(wc -c <"$f" | tr -d ' ')"; head -c ${MAX} "$f" | base64 -w0; else echo KXMISSING; fi`;
    const out = String(await runRemoteCapture(target, script, 30_000) || '');
    const host = labelForHost(KIROLEX_CONFIG_PATH, target.sshHost) || target.sshHost;
    if (out.startsWith('KXDIR')) throw new Error(`${host} 上的 ${remotePath} 是目录，不是文件。`);
    if (!out.startsWith('KXSIZE ')) throw new Error(`${host} 上没有这个文件：${remotePath}`);
    const nl = out.indexOf('\n');
    const size = Number(out.slice(7, nl)) || 0;
    const buffer = Buffer.from(out.slice(nl + 1).trim(), 'base64');
    const base = { path: remotePath, remote: true, remoteHost: host, readOnly: true };
    const ext = path.posix.extname(remotePath).toLowerCase();
    if (IMAGE_MIME_BY_EXT[ext]) {
      if (size > MAX) return { ...base, content: `图片过大（${(size / 1048576).toFixed(1)} MB），在 ${host} 上查看。`, binary: true, truncated: false };
      return { ...base, image: true, dataUrl: `data:${IMAGE_MIME_BY_EXT[ext]};base64,${buffer.toString('base64')}`, content: '' };
    }
    if (buffer.includes(0)) return { ...base, content: '(binary file — preview unavailable)', binary: true, truncated: false };
    return { ...base, content: buffer.toString('utf-8'), truncated: size > MAX };
  }

  ipcMain.handle('workspace:read', async (_event, sessionId: string | null | undefined, filePath: string) => {
    /*
      镜像没了之后**读之前不需要先拉**：远端没有这个项目的副本，review / diff / gate 读的
      本来就是你机器上那一份 —— 而远端那条会话改的也正是这一份（`local_write`）。
    */
    // No session required: see workspaceBase. The session, when present, only
    // decides what a relative path is relative to.
    const rawPath = filePath;
    filePath = resolveUserPath(filePath, sessionId);
    /* 本机没有、而它是远端那台机器上的路径 → 从那台机器读（只读，见 remoteFileFor） */
    if (!fs.existsSync(filePath)) {
      const remote = remoteFileFor(sessionId, rawPath);
      if (remote) return readRemoteFile(remote.target, remote.path);
    }
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) throw new Error('Path is a directory, not a file.');
    /*
      **记下这一份，记在这条会话名下**：侧栏 review 的「✓ 确认」要把改完的正文写回这个文件，而那是
      离开 KiroLex 自己数据目录的写 —— 路径不能只凭渲染进程说。判据是"这条会话的标签页确实读过它"
      （见 `reviewedPaths` / `review:write-file`）。
    */
    markReviewed(sessionId, filePath);

    // Image files: return a base64 data URL so the renderer can show them inline
    // as an <img> instead of the "binary — no preview" fallback.
    const IMG_MIME = IMAGE_MIME_BY_EXT;
    const ext = path.extname(filePath).toLowerCase();
    if (IMG_MIME[ext]) {
      const IMG_MAX_BYTES = 25 * 1024 * 1024;
      if (stats.size > IMG_MAX_BYTES) {
        return {
          path: filePath,
          content: `图片过大（${(stats.size / 1048576).toFixed(1)} MB），请下载后查看。`,
          binary: true,
          truncated: false,
        };
      }
      const data = fs.readFileSync(filePath);
      return {
        path: filePath,
        image: true,
        dataUrl: `data:${IMG_MIME[ext]};base64,${data.toString('base64')}`,
        content: '',
      };
    }

    const descriptor = fs.openSync(filePath, 'r');
    try {
      const previewSize = Math.min(stats.size, WORKSPACE_PREVIEW_MAX_BYTES);
      const buffer = Buffer.alloc(previewSize);
      fs.readSync(descriptor, buffer, 0, previewSize, 0);
      if (buffer.includes(0)) {
        return {
          path: filePath,
          content: '(binary file — preview unavailable)',
          binary: true,
          truncated: false,
        };
      }
      return {
        path: filePath,
        content: buffer.toString('utf-8'),
        truncated: stats.size > WORKSPACE_PREVIEW_MAX_BYTES,
      };
    } finally {
      fs.closeSync(descriptor);
    }
  });

  /** Files the viewer currently has open, watched so an edit on disk refreshes it.
   *
   *  Watching the PARENT DIRECTORY rather than the file is deliberate: a save is very
   *  often write-to-temp + rename (editors do it, and so does KiroLex's own atomic
   *  write), which replaces the inode. `fs.watch` on the file path follows the old
   *  inode and goes silent after exactly one such save -- the failure mode would be a
   *  viewer that refreshes once and then never again. A directory watcher sees the
   *  rename as a `rename` event for the basename, so it keeps working.
   *
   *  One watcher per directory, shared by every open file in it, and events are
   *  debounced: a single save can emit several (`rename` + `change`), and a build can
   *  rewrite a file many times a second. */
  const viewerWatchers = new Map<string, fs.FSWatcher>();   // dir -> watcher
  const viewerFiles = new Map<string, Set<string>>();       // dir -> basenames
  const viewerDebounce = new Map<string, NodeJS.Timeout>(); // full path -> timer

  function stopViewerWatch(): void {
    for (const w of viewerWatchers.values()) { try { w.close(); } catch { /* already closed */ } }
    viewerWatchers.clear();
    viewerFiles.clear();
    for (const t of viewerDebounce.values()) clearTimeout(t);
    viewerDebounce.clear();
  }

  /** Replace the watched set with exactly these files. Returns how many are watched. */
  ipcMain.handle('workspace:watch-files', (_event, sessionId: string | null | undefined, paths: string[]) => {
    stopViewerWatch();
    const wanted = (Array.isArray(paths) ? paths : []).slice(0, 32);   // the viewer caps tabs
    for (const raw of wanted) {
      let full: string;
      try { full = resolveUserPath(String(raw), sessionId); } catch { continue; }
      const dir = path.dirname(full);
      const base = path.basename(full);
      const names = viewerFiles.get(dir) || new Set<string>();
      names.add(base);
      viewerFiles.set(dir, names);
      if (viewerWatchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, (_type, changed) => {
          if (!changed) return;
          const name = String(changed);
          if (!viewerFiles.get(dir)?.has(name)) return;   // some other file in the dir
          const full2 = path.join(dir, name);
          const prev = viewerDebounce.get(full2);
          if (prev) clearTimeout(prev);
          viewerDebounce.set(full2, setTimeout(() => {
            viewerDebounce.delete(full2);
            let exists = true;
            let mtimeMs = 0;
            try { mtimeMs = fs.statSync(full2).mtimeMs; } catch { exists = false; }
            mainWindow?.webContents.send('workspace:file-changed', { path: full2, exists, mtimeMs });
          }, 180));
        });
        watcher.on('error', () => { try { watcher.close(); } catch {} viewerWatchers.delete(dir); });
        viewerWatchers.set(dir, watcher);
      } catch (err: any) {
        // An unreadable or deleted directory is not an error worth failing the call
        // over: the viewer simply does not auto-refresh that file.
        logger.info('workspace', `watch skipped ${dir}: ${err?.message || err}`);
      }
    }
    return { ok: true, watching: wanted.length, dirs: viewerWatchers.size };
  });

  ipcMain.handle('workspace:download', async (_event, sessionId: string | null | undefined, filePath: string) => {
    filePath = resolveUserPath(filePath, sessionId);
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) throw new Error('Path is not a file.');
    const options = {
      title: 'Save workspace file',
      defaultPath: path.join(os.homedir(), 'Downloads', path.basename(filePath)),
    };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      fs.copyFileSync(filePath, result.filePath);
      return { ok: true, path: result.filePath };
    } catch (copyError: any) {
      return { ok: false, error: copyError?.message || 'Download failed.' };
    }
  });

  ipcMain.handle('app:pick-files', async () => {
    const options = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => ({
      path: filePath,
      name: path.basename(filePath),
      isImage: /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath),
    }));
  });

  // Save the current clipboard image to a temp file so it can be attached and
  // read by the agent (attachments are referenced by file path). Returns the
  /** Cap an image FILE that is about to be attached. Returns the original path when
   *  it is already small enough, otherwise the path of a downscaled copy -- the
   *  user's file on disk is never modified. */
  ipcMain.handle('app:prepare-image-attachment', (_event, filePath: string) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { path: filePath };
      const raw = nativeImage.createFromPath(filePath);
      if (raw.isEmpty()) return { path: filePath };          // not a decodable image
      const capped = capImageSize(raw);
      if (!capped.from) return { path: filePath };            // already within limits
      const dir = path.join(os.homedir(), '.kirolex', 'attachments');
      fs.mkdirSync(dir, { recursive: true });
      const base = path.basename(filePath).replace(/\.[^.]+$/, '');
      const out = path.join(dir, `${base}_${MAX_IMAGE_EDGE}px_${Date.now()}.png`);
      fs.writeFileSync(out, capped.img.toPNG());
      logger.info('image', `attachment downscaled ${capped.from} -> ${capped.to}: ${filePath} -> ${out}`);
      return { path: out, downscaled: true, from: capped.from, to: capped.to };
    } catch (err: any) {
      logger.info('image', `prepare-image-attachment FAILED ${filePath}: ${err?.message}`);
      return { path: filePath };
    }
  });

  // path, filename, and a small thumbnail data URL for preview.
  ipcMain.handle('app:save-clipboard-image', () => {
    try {
      const raw = clipboard.readImage();
      if (raw.isEmpty()) return null;
      // Cap BEFORE writing: this file is what kiro-cli reads into the conversation.
      const capped = capImageSize(raw);
      const img = capped.img;
      if (capped.from) logger.info('image', `clipboard screenshot downscaled ${capped.from} -> ${capped.to} (max ${MAX_IMAGE_EDGE}px)`);
      const dir = path.join(os.homedir(), '.kirolex', 'pasted');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `paste_${Date.now()}.png`);
      fs.writeFileSync(filePath, img.toPNG());
      const { width } = img.getSize();
      const thumb = width > 160 ? img.resize({ width: 160 }) : img;
      return { path: filePath, name: path.basename(filePath), thumbnail: thumb.toDataURL() };
    } catch {
      return null;
    }
  });

  /** 本机那份（single-flight —— 理由在 handler 里那段注释）。 */
  const listModelsLocal = (): Promise<any> => {
    if (!listModelsInFlight) {
      listModelsInFlight = runKiroCli('chat --list-models --format json', 30000)
        .then((result) => JSON.parse(result))
        .finally(() => { listModelsInFlight = null; });
    }
    return listModelsInFlight;
  };

  ipcMain.handle('acp:list-models', async (_event, machine?: string) => {
    /*
      **模型列表按机器分** ——「确认下右侧界面远程会话显示的是远程的 agent 和模型」。

      以前只有一份：跑本机 kiro-cli，所有会话共用。而两台机器的 kiro-cli 版本不一样
      （实测本机 2.23.1、东京 1.27.0），于是下拉里完全可能有远端没有的模型 ——
      启动那一刻 `pickRemoteModel` 会替换成可用的并在会话里说一句，也就是不会静默跑错，
      但下拉在骗你。远程会话就去问**那台机器**。

      远端那边用的是同一个探测（`preflightScript` 里那段：故意传一个不存在的模型，
      kiro-cli 在参数校验就会把可用列表打出来 —— 不真调模型、不花额度）。
    */
    if (machine && machine !== 'local') {
      const target = findRemoteTarget(KIROLEX_CONFIG_PATH, machine);
      if (!target?.sshHost) throw new Error(`找不到这台机器（${machine}）—— 设置里删掉了？`);
      const bin = remoteKiroBin(target);
      if (!bin) throw new Error(`还没有设置 ${target.sshHost} 上的 kiro 启动命令（设置 → 🖥 机器）。`);
    /*
      **先问那台机器自己要完整清单** —— 2.24.1 起远端的 kiro-cli 认
      `chat --list-models --format json`，回的是和本机**一模一样**的结构
      （`model_id` / `model_name` / `rate_multiplier` / `context_window_tokens`）。

      这比下面那条"故意传一个不存在的模型、从参数校验的报错里抠 id"强的地方不是少一次调用，
      而是**倍率终于来自真正提供这些模型的那台机器**：实测远端更新到 2.24.1 之后
      `claude-opus-5.5` 报的是 2.00x，而那个数字本机给不出来（本机清单被地域过滤，
      一个 Claude 都没有，内置兜底表里也没有 5.5）—— 也就是用户看到的"没有乘数"。

      旧的探测留着做兜底：远端可能还是老版本（这条路上见过 1.27.0，它连 `--list-models`
      都不认）。顺序是"能问就问，问不到才猜"。
    */
      const jsonOut = await runRemoteCapture(target,
        `${shellQuote(bin)} chat --list-models --format json 2>/dev/null || true`).catch(() => '');
      const remoteList = parseModelListJson(jsonOut);
      if (remoteList.length) {
        /* 真实元数据进缓存 —— 它是按 model_id 存的，所以本机那边的显示也跟着修好了 */
        const cache0 = readMetaCache(MODEL_META_PATH);
        if (mergeMeta(cache0, remoteList)) writeMetaCache(MODEL_META_PATH, cache0);
        const liveRemote: Record<string, any> = {};
        for (const m of remoteList) if (m?.model_id) liveRemote[m.model_id] = m;
        logger.info('model', `${target.sshHost}: 自己报出了 ${remoteList.length} 个模型（带倍率）`);
        return { models: enrichModels(remoteList.map((m) => m.model_id!), liveRemote, cache0) };
      }
      const out = await runRemoteCapture(target,
        `${shellQuote(bin)} chat --model ${MODEL_PROBE} --no-interactive x 2>&1 | grep -o 'Available models:.*' | head -1`)
        .catch((err) => { throw new Error(`问不到 ${target.sshHost} 的模型列表：${err?.message || err}`); });
      const ids = parseModels(out);
      if (!ids.length) throw new Error(`${target.sshHost} 没有报出模型列表（kiro-cli 版本不认这个探测？）`);
      /*
        远端只给得出 **id**：那台机器的 kiro-cli（实测 1.27.0）连 `--list-models` 都不认
        （`error: unexpected argument '--list-models'`），所以唯一的来源就是上面那条参数校验的
        错误信息，而它只列 id。
        
        **名字/上下文窗口/乘数从本机那份补上** —— 我先前的说法（"不跨机器借用"）是错的：
        机器决定的是**有哪些模型**（版本不同、集合不同），而"claude-opus-5 的计费倍率是 2.2、
        上下文窗口多大"是**模型自己的属性**，不随机器变。本机不认识的 id 就留裸的 —— 
        那种情况下少一点信息，总好过编一个。
      */
      /*
        **元数据三层兜底** ——「这个远程会话为什么又看不到模型乘数了」。

        远端只给得出一串 id（1.27.0 没有 `--list-models`），名字/倍率/上下文窗口一直是按 id
        从本机那份补的。本机出口被地域过滤之后清单里一个 Claude 都没有，于是补不到东西、
        `· 2.2x` 就消失了。现在：实时清单 → 持久缓存 → 内置快照（见 `modelMeta.ts`）。
      */
      const localList: any[] = await listModelsLocal().then((d) => d?.models || []).catch(() => []);
      const live: Record<string, any> = {};
      for (const m of localList) if (m?.model_id) live[m.model_id] = m;
      const cache = readMetaCache(MODEL_META_PATH);
      /* 顺手把这次拿到的真实元数据记下来 —— "某台机器暂时不报它"不该等于"这个模型的属性丢了" */
      if (mergeMeta(cache, localList)) writeMetaCache(MODEL_META_PATH, cache);
      return { models: enrichModels(ids, live, cache) };
    }
    /**
     * SINGLE-FLIGHT，而且超时给足 —— 两者都是实测逼出来的。
     *
     * 现场：日志里 13 次 `timed out after 10000ms (killed)`，而同一时刻在终端裸跑同一条命令只要
     * 2.6–3.7 秒。关键线索是超时**成对出现**（同一毫秒两条，如 15:35:57.573 / .575）：渲染进程
     * 挂载时并发发起了两次，每次都要付 kiro-cli 完整启动开销（含加载全部 MCP server），两个一起
     * 启就超过 10 秒预算。于是永远走 `.catch()`，回退到缓存 —— 而那份缓存早先已被一次退化结果
     * 写坏（只剩 `auto`），所以「网恢复了却还是显示模型都不可用」。
     *
     * single-flight 消掉并发这个直接原因；30s 给 kiro-cli 冷启动留出真实余量（这个调用本来就是
     * 非阻塞的，等久一点没有代价，拿不到列表才有代价）。成功结果不在这里长期记忆：模型会上下线，
     * 该由渲染层用 `shouldReplaceModelCache` 决定要不要落盘。
     */
    return listModelsLocal();
  });

  ipcMain.handle('acp:get-usage', async () => {
    try {
      const result = await runKiroCli('chat --no-interactive "/usage" 2>&1', 20000);
      const clean = result.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g, '').trim();
      return { text: clean };
    } catch (err: any) {
      const output = (err.stdout || '') + (err.stderr || '');
      const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g, '').trim();
      return { text: clean || 'Failed to get usage' };
    }
  });

  // Generate a concise chat title from the first message via a one-shot kiro-cli
  // call. execFile (args array) — user text is never shell-interpolated.
  ipcMain.handle('app:generate-title', async (_event, firstUser: string, firstAssistant?: string) => {
    const convo = `User: ${String(firstUser || '').slice(0, 1500)}`
      + (firstAssistant ? `\n\nAssistant: ${String(firstAssistant).slice(0, 1500)}` : '');
    if (!isFeatureEnabled('smartTitle')) {
      logger.info('title', 'skipped: smartTitle is off');
      return { ok: false, skipped: true, reason: 'feature disabled' };
    }
    const prompt = `Generate a very short chat title (3-6 words) summarizing the topic below. Reply with ONLY the title on a single line — no quotes, no trailing punctuation, no preamble.\n\n${convo}`;
    try {
      // Logged like `suggestions` next door. This handler used to log NOTHING, on any
      // branch -- including the silent `{ error: 'empty' }` one -- so "chats stopped
      // naming themselves" left no trace anywhere and got misdiagnosed twice.
      const stdout = await runLiteOneShot(prompt, 'title');
      const clean = cleanLiteOutput(stdout);
      const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
      let title = lines[lines.length - 1] || '';
      title = title
        // The marker is stripped from the whole reply above, but the title is taken
        // from the LAST line, which may carry its own.
        .replace(/^\s*(?:>\s*)+/, '')
        .replace(/^["'“”「『]+|["'“”」』]+$/g, '')
        .replace(/^title[:：]\s*/i, '')
        .replace(/[。.、,，]+$/, '')
        .trim()
        .slice(0, 60);
      if (!title) {
        logger.warn('title', `model answered but no usable title survived cleanup (${clean.length} chars in)`);
        return { error: 'empty' };
      }
      logger.info('title', `generated "${title}"`);
      return { title };
    } catch (err: any) {
      logger.warn('title', `failed: ${err?.killed ? 'timeout/killed' : ''} ${err?.message || err}`);
      return { error: err?.message || 'failed' };
    }
  });

  // Dynamic, conversation-aware prompt suggestions: given the recent transcript,
  // produce a few short follow-up prompts the user is likely to want next. One-
  // shot kiro-cli via execFile (args array — the convo text can't shell-inject).
  ipcMain.handle('app:generate-suggestions', async (_event, recentConvo: string) => {
    /*
      **在发出去的这一处再挡一次** —— 实测泄漏就是从这条路出去的：
      `[suggestions] … Based on the conversation below … User: ⚠️ 这条会话现在跑在 gpt-5.6-sol 上…`。
      上游（渲染进程）也会过滤，但这里不能依赖它：再多一个调用点，漏的就是那一个。
    */
    const convo = stripKirolexNotes(String(recentConvo || '')).slice(0, 4000);
    if (!convo.trim()) return { suggestions: [] };
    const prompt = `Based on the conversation below, propose 3 short follow-up prompts the user might send next. Each must be a concrete, actionable next step in the SAME language as the conversation, max 12 words, no numbering, no quotes. Reply with ONLY the 3 prompts, one per line.\n\n${convo}`;
    try {
      const stdout = await runLiteOneShot(prompt, 'suggestions');
      const clean = cleanLiteOutput(stdout);
      const suggestions = clean
        .split('\n')
        // Per line, on top of the leading marker cleanLiteOutput already removed:
        // list bullets/numbering, and a marker on any line but the first.
        .map((l) => l.replace(/^\s*(?:>\s*)?[-*\d.)、]*\s*/, '').replace(/^["'“”「『]+|["'“”」』]+$/g, '').trim())
        .filter((l) => l.length > 0 && l.length <= 80)
        .slice(-3);
      logger.info('suggestions', `generated ${suggestions.length}`);
      return { suggestions };
    } catch (err: any) {
      // Never fail silently: a killed/timed-out one-shot used to look exactly
      // like "suggestions are gone".
      logger.warn('suggestions', `failed: ${err?.killed ? 'timeout/killed' : ''} ${err?.message || err}`);
      return { suggestions: [], error: err?.message || 'failed' };
    }
  });

  ipcMain.handle('acp:list-sessions', async () => {
    try {
      const result = await runKiroCli('chat --list-sessions --format json', 10000);
      return JSON.parse(result);
    } catch {
      return { sessions: [] };
    }
  });

  let firstAttachMarked = false;
  /**
   * 挂载一条会话 —— **抽成函数是为了让主进程自己也能调**（见下面的 `ensureAttached`）。
   * 函数体就是原来那个 `acp:load-session` handler，原样搬出来，逻辑一个字节没改；IPC 那侧只是转发。
   */
  const loadSessionImpl = async (sessionId: string, cwd: string, model: string): Promise<any> => {
    if (!firstAttachMarked) { firstAttachMarked = true; startupMark('attach: first loadSession', `sessionId=${sessionId}`); }
    const askedCwd = cwd === '~' ? os.homedir() : cwd;
    /*
      **一条已存在会话的工作目录，以记录为准** ——「为什么会话不是远程的？」查出来的根因。

      渲染层三处 attach 都硬写 `'~'`（`loadSession(id, '~', model)`），所以这里收到的 `cwd`
      对**任何**会话都是家目录。本地会话无所谓（它的 cwd 本来就是每会话的临时目录），
      远程会话则是双重灾难：镜像目录按它算 —— 于是每次 re-attach 都把整个家目录推上远端
      （实测两次，5.1 GB / 6.1 GB，`.aws/credentials` 和 17 把 .pem 都在里面）；
      而"家目录不能做镜像"那道闸接着把这条会话降级成本地 —— 看起来就是"我建的远程会话怎么变本地了"。

      记录里存了 `localDir` 就用它；没有（老会话）才退回渲染层给的那个。
    */
    let resolvedCwd = store.readRecord(sessionId)?.localDir || askedCwd;
    // Never re-attach (and thus recreate the record.json of) a session the user
    // deleted this runtime — prevents a racing startup eager-attach from
    // resurrecting a just-closed chat.
    if (deletedSessionIds.has(sessionId)) {
      throw new Error('Session was deleted; not re-attaching.');
    }
    // Mutual exclusion with model/Agent/permission switches: both paths do a
    // session/load on the same cliSessionId and kiro-cli allows only one owner.
    // WAIT for the switch instead of rejecting. A switch already waits for an
    // attach (awaitAttachIdle), and only this direction failed hard -- so a send
    // that lands while the model is being swapped (the send attaches on demand)
    // got a raw IPC error on the user's own message. A switch finishes WITH the
    // session attached, so after the wait this handler almost always returns
    // immediately with the new executor.
    await awaitReconfigureIdle(sessionId);
    // The switch may have been the last thing that touched this session before a
    // delete landed; re-check rather than attaching a corpse.
    if (deletedSessionIds.has(sessionId)) {
      throw new Error('Session was deleted; not re-attaching.');
    }
    // COALESCE concurrent attaches of the SAME session. The main window is now
    // revealed BEFORE the background warm-up finishes, so clicking a session that
    // is still attaching would otherwise start a second executor for the same
    // cliSessionId -- and kiro-cli allows exactly one owner ("Session is active in
    // another process (PID n)"). Joining the in-flight attach is both correct and
    // faster than serialising behind it.
    const inFlight = attachInFlight.get(sessionId);
    if (inFlight) return inFlight;
    const attachPromise = (async () => {
    attachingSessions.add(sessionId);
    emitSessionBusy(sessionId);
    try {
    let entry = sessionClients.get(sessionId);
    let freshBackendResult = false;
    if (!entry) {
      if (!ensureExecutorCapacity(sessionId)) {
        throw new Error('All live sessions are busy; cannot attach another right now.');
      }
      const existing = store.readRecord(sessionId);
      // ATTACH MUST NOT CREATE. `createSession` below used to run for any unknown
      // id, so attaching a stale entry (a chat deleted on disk, or deleted while the
      // renderer index still listed it) RE-CREATED its record — and the chat came
      // back at the next start, "deleted" but alive. Creation belongs to
      // acp:new-session only; resuming an id with no record on disk is an error.
      if (!existing) {
        throw new Error('该会话在磁盘上不存在（可能已被删除），不再重建。');
      }
      const derived = derivedProjectFor(sessionId, resolvedCwd);
      /* 你亲手移出项目的，不按目录再反推回去（见 `AgentProfile.unassigned`） */
      const projectId = existing?.profile.projectId ?? (existing?.profile.unassigned ? undefined : derived);
      const profile: AgentProfile = {
        model: model || existing?.profile.model || DEFAULT_MODEL,
        // ONLY a recorded preference, else the default. Deliberately does NOT fall
        // back to `model` or `existing.profile.model`: both carry the EFFECTIVE
        // model, which after an automatic fallback is a model the user never chose.
        // Back-filling from them turned one Opus outage into a permanent silent
        // downgrade (observed: preferred became 'claude-sonnet-4.6' on a session
        // created as 'claude-opus-5'). An explicit user switch is the only thing
        // that sets a preference — see acp:switch-model.
        preferredModel: existing?.profile.preferredModel || DEFAULT_MODEL,
        /* 带着走，否则每次 attach 都当成"没记"，那这个字段就白加了 */
        modelEarnedOn: existing?.profile.modelEarnedOn,
        permissionMode: existing?.profile.permissionMode || 'auto-approve',
        projectId,
        /* 白名单：漏了的话下一次把 entry.profile 整份写回记录（切模型等）就把这个标记丢了 */
        ...(existing?.profile.unassigned ? { unassigned: true as const } : {}),
        kiroAgent: existing?.profile.kiroAgent,
        // Persisted remote target survives restarts; a remote session re-attaches
        // over SSH exactly as it was created.
        remote: existing?.profile.remote,
        /* 引擎也归记录所有 —— 这里是白名单，漏了它的话 Claude/Codex 会话一重启就变回 kiro */
        ...(existing?.profile.engine ? { engine: existing.profile.engine } : {}),
        /* 同一张白名单：漏了的话手选的模型 / effort / 模式一重连就丢（实测：选了 sonnet，重启后回到 opus） */
        ...(existing?.profile.engineModels ? { engineModels: existing.profile.engineModels } : {}),
        ...(existing?.profile.engineOptions ? { engineOptions: existing.profile.engineOptions } : {}),
      };
      if (!profile.remote?.sshHost) resolvedCwd = localCwdFor(sessionId, resolvedCwd);
      // For a remote session the executor's working directory is a REMOTE path,
      // not the local `cwd` the renderer passed in.
      const cliCwd = sessionCwd(profile, resolvedCwd);
      /*
        **重新连接时不许把这条会话变成死结** —— 实测踩到：家目录闸门原来在这里
        直接抛错，于是那条已经存在的远程会话**再也打不开了** —— 它有历史、界面上却没有任何出路，
        每次点开只弹一句同样的错误。

        闸门要挡的是"把凭据推到远端"，不是"让这条对话消失"。所以这里**退回本地**：
        清掉 `remote`（连记录一起改，否则下次又走这条路）、在会话里说清为什么，然后照常 attach。
        本地是唯一真相，这条对话的全部内容都在本地 —— 退回本地不丢任何东西。

        建**新**会话那一步仍然是硬拒绝：那时候还没有任何历史，明确报错比悄悄换目标好。
      */
      let localTools: { remotePort: number; localPort: number; agentOverride: string } | undefined;
      if (profile.remote?.sshHost) {
        /* 没有项目目录（记录里没记、渲染层又只给了 `'~'`）→ 用会话目录，和本地那条路一致 */
        resolvedCwd = localDirOrSessionDir(sessionId, resolvedCwd);
        /*
          家目录那道闸连同镜像一起去掉了：没有任何东西会被推到远端，
          所以"这个目录能不能当镜像根"这个问题不存在了。它原来还有一条**退回本地**的分支
          （那是为了不让一条已存在的远程会话变成死结），现在也不需要了。
        */
        if (engineOf(profile) !== 'kiro') {
          await remoteAdapterCheck(profile.remote, engineOf(profile) as 'claude' | 'codex');
        } else {
          const remoteModels = await remotePreflight(profile.remote);
          profile.model = pickRemoteModel(sessionId, profile.model, remoteModels, profile.remote.sshHost || '');
        }
        localTools = await ensureLocalTools(sessionId, profile, resolvedCwd);
      }
      const started = await connectWithModelFallback(profile, `attach ${sessionId}`, localTools, sessionId);
      const client = started.client;
      profile.model = started.model;
      // Resume the mapped kiro-cli session; fall back to id (legacy records where
      // KiroLex id WAS the cli id), and to a fresh session if resume fails.
      // The resume is raced against a FIXED wall-clock timeout (not the request's
      // idle timeout): resuming a stale cliSessionId -- from an old kiro-cli store,
      // a restored backup, or a version change -- can stream updates that keep
      // resetting the idle timer while the session/load response never arrives,
      // wedging the attach forever (sidebar dot stuck yellow "connecting"). On
      // timeout OR error we fall back to a fresh session so attach never hangs.
      let cliSessionId = existing?.cliSessionId || sessionId;
      let freshBackend = false;
      // Scale the wall-clock budget with how much history kiro-cli has to load.
      // A fixed 10s made every LARGE chat time out on every restart, silently
      // swapping in an empty backend -- that is what discarded the context.
      // Still bounded (and retried once) so a genuinely stale id cannot wedge
      // the attach forever.
      const historyBytes = store.transcriptFileSize(sessionId);
      const RESUME_TIMEOUT_MS = Math.min(90000, 20000 + Math.floor(historyBytes / 100000) * 15000);
      const tryResume = async () => {
        await Promise.race([
          client.loadSession(cliSessionId, cliCwd),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`session/load resume timed out after ${RESUME_TIMEOUT_MS}ms`)), RESUME_TIMEOUT_MS),
          ),
        ]);
      };
      /*
        **没聊过的 Claude Code / Codex 会话不去 resume** —— 实测 claude-agent-acp 只在第一条消息之后才把会话
        写盘，于是一条只建了没用过的会话每次连上都是 `Resource not found`，日志里一次"resume 失败 + 重试 +
        放弃"。那里本来就什么都没有：直接起一条新的，也不欠重建。
      */
      const skipResume = engineOf(profile) !== 'kiro' && historyBytes === 0;
      if (skipResume) {
        cliSessionId = (await client.newSession(cliCwd)).sessionId;
        logger.info('attach', `${ENGINE_LABEL[engineOf(profile)]} 会话还没聊过，不 resume，直接新起 sessionId=${sessionId} cli=${cliSessionId}`);
      } else try {
        try {
          await tryResume();
        } catch (first: any) {
          /* `Resource not found` 是确定的答案（那边就是没有这条），重试一次只是再等一遍 */
          if (/Resource not found/i.test(String(first?.message || ''))) throw first;
          logger.info('attach', `resume attempt 1 failed sessionId=${sessionId} cli=${cliSessionId} bytes=${historyBytes} budget=${RESUME_TIMEOUT_MS}ms err=${first?.message}`);
          await tryResume();
          logger.info('attach', `resume attempt 2 succeeded sessionId=${sessionId} cli=${cliSessionId}`);
        }
      } catch (resumeErr: any) {
        logger.info('attach', `resume GAVE UP sessionId=${sessionId} cli=${cliSessionId} bytes=${historyBytes} budget=${RESUME_TIMEOUT_MS}ms err=${resumeErr?.message} -> fresh backend, history will be rebuilt`);
        const created = await client.newSession(cliCwd);
        cliSessionId = created.sessionId;
        // Backend is FRESH (resume failed / migrated / expired cli session).
        // Flag it so the context is rebuilt from KiroLex's own transcript BEFORE
        // the next user message is accepted -- the chat must remember its history
        // independent of whether kiro-cli could resume.
        freshBackend = true;
      }
      // A resume that "succeeded" is NOT proof the context is there. Verified
      // against kiro-cli's own store: it does NOT persist ACP sessions (none of a
      // real chat's five backend ids exist in data.sqlite3, while its
      // `--no-interactive` conversations do), so `session/load` accepts a known id
      // by starting an EMPTY conversation for it. The marker must therefore match
      // BOTH the id and the process that was actually fed -- a new pid means a
      // blank backend even when the id is unchanged.
      if (!freshBackend) {
        const establishedFor = existing?.contextEstablishedFor;
        const establishedPid = existing?.contextEstablishedPid;
        if (establishedFor !== undefined && (establishedFor !== cliSessionId || establishedPid !== client.pid)) {
          logger.info('attach', `resume ok but context is NOT in this backend sessionId=${sessionId} resumed=${cliSessionId} pid=${client.pid} establishedFor=${establishedFor} establishedPid=${establishedPid} -> will rebuild when the chat is used`);
          freshBackend = true;
        }
      }
      // Attach does NOT rebuild and does NOT lock the chat. With ride-along
      // context there is nothing to do here: the snapshot travels with the user's
      // first message, so a chat becomes ready at zero extra cost the moment it is
      // used, and chats never opened cost nothing at all. Only verbatim ('full')
      // mode still needs a real rebuild, and that one waits until the chat is used.
      const verbatimOwed = freshBackend && store.readRecord(sessionId)?.primeMode === 'full';
      if (freshBackend) {
        logger.info('prime', `context owed sessionId=${sessionId} mode=${verbatimOwed ? 'full (rebuild on first use)' : 'snapshot (rides along with the next message)'}`);
      }
      entry = { client, cliSessionId, profile, cwd: cliCwd, localDir: resolvedCwd, assistantBuf: '', assistantMsgId: null, fileChanges: [], lastUsedAt: Date.now(), needsHistoryPrime: verbatimOwed };
      freshBackendResult = verbatimOwed;
      // A delete may have landed during the async connect/resume above. If so,
      // tear the fresh client down and do NOT recreate the record on disk.
      if (deletedSessionIds.has(sessionId)) {
        try { await client.disconnect(); } catch {}
        throw new Error('Session was deleted during attach; aborted.');
      }
      sessionClients.set(sessionId, entry);
      /* 远程会话：两份镜像（项目目录 + 会话目录）登记进同步编排 */
      wireSession(sessionId, entry);
      const rec = store.readRecord(sessionId) || store.createSession(sessionId, profile);
      rec.cliSessionId = cliSessionId;
      rec.executorState = 'attached';
      /*
        老会话补写目录，但**只在渲染层给了具体目录时**才写。
        `'~'` 是它的默认值、不是这条会话的目录 —— 把它当真存下来等于给每条会话钉上"家目录"，
        而那正好会触发"家目录不能做镜像"（实测：上一版这么写，一次重启就给 6 条会话写上了
        `/Users/keyinan`）。宁可留空、下次再说。
      */
      if (!rec.localDir && cwd !== '~') rec.localDir = askedCwd;
      /*
        Persist the model that ACTUALLY started. Without this the record keeps
        pointing at a retired model (e.g. claude-opus-5), so EVERY later startup
        burns a full initialize timeout on it before falling back again — which is
        exactly what wedged the splash at "Connecting sessions… (0/N)".

        ── 但「降级」和「偏好抢先」是相反的两件事，不能共用这一次写 ────────────────

        `connectWithModelFallback` 返回的是**哪个候选连上了**，而连上对一个已退役的模型
        永远成立（见 `isModelUnavailableError` 上面那段：kiro-cli 只在真跑一轮时才报退役）。
        于是当 `preferredModel` 抢在记录的模型前面连上时，这里会把一个**从没成功跑过一轮**的
        模型写成「有效模型」，而被它盖掉的那个是上一次真跑成一轮挣来的。

        实测：记录里正确的 `gpt-5.6-sol` 被 `claude-opus-5` 反复盖掉，于是每次重启都从死模型
        开始 —— 换模型那 30 秒的静默窗口因此每次运行都要付一次（见 `modelsKnownDead`）。

        判据就在手边，300 行那段注释早就写了：偏好抢先时**记录的模型压根没被尝试过**，
        所以不能声称它不可用。所以只在**真的降级**时写（连上的不是偏好的那个 = 偏好确实失败了，
        或者压根没设偏好）。
      */
      const preferenceWonAhead = !!profile.preferredModel && profile.model === profile.preferredModel;
      /*
        **但"别盖掉记录里那个"只在记录里那个是在这台机器上挣来的时候才成立** ——
        「为什么远程会话又退回到 deepseek 了」。

        那条会话的记录是 `deepseek-3.2`（在**本机**被降级挣来的），切到远端之后执行器真的跑在
        `claude-opus-5` 上，但这一支拒绝写记录 —— 于是记录永远和现实不一致，而下游每一次
        从磁盘 hydrate 都会把界面和"下次 attach 用哪个模型"重新拉回 deepseek
        （`useAcp` 里那句 `sessionModelRef.current.set(rec.id, rec.model)`）。表现就是"又退回去了"。

        原来那条守卫保护的是**这台机器上真跑成一轮挣来的**模型，那是对的。而另一台机器挣来的
        对这台机器没有任何证明力 —— 替换它不叫"盖掉事实"，叫"换掉一条不适用的记录"。
      */
      const earnedOnThisMachine = (rec.profile as any).modelEarnedOn === machineKeyOf(profile);
      if (rec.profile.model !== profile.model && (!preferenceWonAhead || !earnedOnThisMachine)) {
        logger.info('model', `attach ${sessionId}: persisting effective model '${profile.model}' (was '${rec.profile.model}', preferred '${profile.preferredModel}')`
          + (!earnedOnThisMachine ? ` —— 旧值不是在 ${machineKeyOf(profile)} 上挣来的，留着它每次 hydrate 都会把界面拉回去` : ''));
        rec.profile.model = profile.model;
        /* 记下是哪台机器挣的 —— 换机器之后这条就不该再生效（见 `modelEarnedOn`） */
        rec.profile.modelEarnedOn = machineKeyOf(profile);
        // Preference is sticky: it is retried first on the next attach.
        rec.profile.preferredModel = profile.preferredModel;
        // Announce it: otherwise the composer selector keeps showing the model the
        // renderer last knew about while the executor runs a different one.
        emitSessionModel(sessionId, profile.model);
      } else if (rec.profile.model !== profile.model) {
        logger.info('model', `attach ${sessionId}: 跑在偏好模型 '${profile.model}' 上，但**不写进记录**`
          + ` —— 记录里的 '${rec.profile.model}' 是上一次真跑成一轮挣来的，而"连上了"什么都不证明`);
        /*
          **不写记录，但必须告诉界面** —— 「为什么切到远程 default 到 deepseek 了」里被看见的
          就是这一格：执行器跑的是 `claude-opus-5`，而下拉显示记录里那个 `deepseek-3.2`。
          不写盘是对的（"连上了"证明不了那个模型能跑完一轮），但**显示错的模型**是另一回事：
          人会照着下拉去判断这条会话在用什么，然后基于错的前提做决定（比如以为远端也没有 Claude）。
        */
        emitSessionModel(sessionId, profile.model);
      }
      store.writeRecord(rec);
      mainWindow?.webContents.send('session:ready-for-first-prompt', { sessionId, projectId: profile.projectId });
    }
    return { ok: true, freshBackend: freshBackendResult };
    } finally {
      attachingSessions.delete(sessionId);
      emitSessionBusy(sessionId);
    }
    })();
    attachInFlight.set(sessionId, attachPromise);
    try {
      const result = await attachPromise;
      // No rebuild is kicked here, and none is needed: the snapshot rides along
      // with the user's next message (zero extra turns). Verbatim ('full') chats do
      // owe a real rebuild and are marked as such, but it waits until the chat is
      // actually used -- firing N-turn replays at boot for chats nobody opened is
      // the cost this whole design exists to avoid.
      return result;
    } finally {
      attachInFlight.delete(sessionId);
    }
  };
  ipcMain.handle('acp:load-session', async (_event, sessionId: string, cwd: string, model: string) =>
    loadSessionImpl(sessionId, cwd, model));

  /**
   * 把一条会话挂起来（主进程自己调）—— **改写之前先挂回来**。
   *
   * 「你应该评估一下什么时候应该回收会话」：问题不在"何时回收"，而在**回收之后还能不能用**。
   * 归档 / LRU 会 `detachExecutor`，而侧栏 review 的改写走 `review:revise-in-session`，`sendPromptOnce`
   * 只认活着的执行器 —— 于是"回收得早"直接变成"改写不了"（`Session not connected`）。
   * 正确的分工是：**回收该早**，**要用的时候自己挂回来**。挂载只有一份实现（`loadSessionImpl`，
   * IPC 那侧只是转发），重试、race、`deletedSessionIds` 那些判据都在里面。
   *
   * 挂载失败**不抛**：调用方后面还会自己判一次，而且有更合适的报错。
   */
  const ensureAttached = async (sessionId: string): Promise<boolean> => {
    const sid = String(sessionId || '').trim();
    if (!sid) return false;
    if (sessionClients.get(sid)) return true;
    try {
      await loadSessionImpl(sid, '~', store.readRecord(sid)?.profile.model || DEFAULT_MODEL);
    } catch (err: any) {
      logger.warn('revise', `按需挂起失败 sessionId=${sid}: ${err?.message || err}`);
    }
    return !!sessionClients.get(sid);
  };

  /** 改写前的整份副本留多少份。要回滚也只会回到最近几版。 */
  const REVIEW_BACKUPS_KEPT = 12;

  /**
   * 改写这个文件之前先拷一份，并**顺手把老的清掉**（按 mtime 留最近 N 份）。
   *
   * 清理放在写备份之后：先保证这一份在，再删旧的 —— 反过来的话中间崩一下就两头空。
   * 返回备份路径；拷不成返回 null（调用方据此**不写**，见 `review:write-file`）。
   */
  const saveReviewBackup = (want: string, bytes: Buffer | string): string | null => {
    try {
      const backupDir = path.join(os.homedir(), '.kirolex', 'backups', 'review-files');
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const name = path.basename(want).replace(/[^\w.-]+/g, '_');
      const at = path.join(backupDir, `${name}__${stamp}`);
      fs.writeFileSync(at, bytes as any);
      try {
        const old = fs.readdirSync(backupDir)
          .map((n) => { const full = path.join(backupDir, n); try { return { full, t: fs.statSync(full).mtimeMs }; } catch { return null; } })
          .filter((e): e is { full: string; t: number } => !!e)
          .sort((a, b) => b.t - a.t)
          .slice(REVIEW_BACKUPS_KEPT);
        for (const e of old) { try { fs.rmSync(e.full, { force: true }); } catch { /* 下次再说 */ } }
      } catch { /* 清理是 best-effort，不能拦住主流程 */ }
      return at;
    } catch { return null; }
  };

  /**
   * 渲染层给的 (会话, 路径) → 要写的那个绝对路径 + 能不能写 —— 两个 review 写盘通道共用这一道闸。
   *
   * 解析走**和读的时候同一个** `resolveUserPath(filePath, sessionId)`：相对路径落到这条会话自己的
   * `sessions/<id>/files/`。闸是"**这条会话**的标签页读过这一份"（`wasReviewed`）—— 不凭渲染进程说它想写哪儿。
   */
  const reviewTarget = (sessionId: string | null | undefined, filePath: string): { ok: true; want: string } | { ok: false; error: string } => {
    const raw = String(filePath || '');
    if (!raw) return { ok: false, error: '没有路径' };
    let want: string;
    try { want = resolveUserPath(raw, sessionId); } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
    if (!wasReviewed(sessionId, want)) {
      logger.warn('review', `refused: not previewed by session=${sessionId || '(none)'} (${want})`);
      return { ok: false, error: '这个文件不是这条会话的标签页打开预览过的 —— 不写' };
    }
    return { ok: true, want };
  };

  /**
   * **拷一份，什么都不改** —— 侧栏 review 的「提交给这份文件的会话」那条路要用。
   *
   * 那条路是**会话自己写这个文件**（意见拼成一条普通消息发过去），走不到 `review:write-file` 里那段
   * "写前拷一份"。备在**发之前**：文件在它落笔前一个字节都没变，这时拷的就是"改之前"。
   */
  ipcMain.handle('review:backup-file', async (_event, sessionId: string | null | undefined, filePath: string) => {
    const t = reviewTarget(sessionId, filePath);
    if (!t.ok) return t;
    try {
      const bytes = fs.readFileSync(t.want);
      const at = saveReviewBackup(t.want, bytes);
      if (!at) return { ok: false, error: '备份写不进去' };
      logger.info('review', `backed up ${t.want} -> ${at} (${bytes.length} bytes)`);
      return { ok: true, at, bytes: bytes.length };
    } catch (error: any) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  /**
   * WRITE BACK A FILE THE REVIEW PANE IS LOOKING AT —— 侧栏 review 的「✓ 确认」落盘用。
   *
   * 「确认一条就当场改完并写回」：模型只回正文（提示词里禁止它自己动文件 —— 两个写者对同一个文件
   * 要么改两遍要么互相覆盖），落盘由这里统一做。四道闸：
   *   · 路径按**这条会话**解析，而且必须是这条会话的标签页读过的（`reviewTarget`）；
   *   · 文件必须已经存在（改的是你正在看的那一份，不新建）；
   *   · 文件不能比预览上限大 —— 预览只读了前 512KB，拿它拼出来的"整份"写回去等于把后面截掉；
   *   · 写前留备份（`~/.kirolex/backups/review-files/`），**拷不成就不写**；内容一样就什么都不做。
   */
  /**
   * 写回一份 review 的文件 —— `review:write-file` 和改写那条路（`apply`）共用。
   * `expectBase`：盘上此刻必须正好是这一份才写 —— 改写跑的那几分钟里文件被别的改动动过，拼上去就是错位。
   */
  const writeReviewFile = (sessionId: string | null | undefined, filePath: string, text: string, expectBase?: string): any => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '内容是空的，不写' };
    const t = reviewTarget(sessionId, filePath);
    if (!t.ok) return t;
    const want = t.want;
    try {
      let previous = '';
      try {
        if (fs.statSync(want).size > WORKSPACE_PREVIEW_MAX_BYTES) {
          return { ok: false, error: '这个文件比预览上限（512KB）大 —— 预览里只有前半截，写回去会把后面截掉，所以不写' };
        }
        previous = fs.readFileSync(want, 'utf-8');
      } catch {
        return { ok: false, error: '这个文件现在读不到 —— 不新建，先确认路径对不对' };
      }
      if (typeof expectBase === 'string' && previous !== expectBase) {
        return { ok: false, mismatch: true, error: '这份文件在改写期间被别的改动动过了 —— 这次的结果没写进去，看一眼新的正文再提一次' };
      }
      if (previous === text) return { ok: true, path: want, unchanged: true };
      if (!saveReviewBackup(want, previous)) {
        return { ok: false, error: '写前备份失败 —— 没有可回滚的副本，所以这次不改。检查 ~/.kirolex/backups 能不能写。' };
      }
      fs.writeFileSync(want, text, 'utf-8');
      logger.info('review', `wrote ${want} (${text.length} chars, was ${previous.length}) session=${sessionId || '(none)'}`);
      return { ok: true, path: want, bytes: text.length, was: previous.length };
    } catch (error: any) {
      return { ok: false, error: String(error?.message || error) };
    }
  };
  /** 只读：按和 `writeReviewFile` 同样的规则解析路径，读出盘上此刻的正文；读不到给 `null`。 */
  const readReviewFile = (sessionId: string | null | undefined, filePath: string): string | null => {
    const t = reviewTarget(sessionId, filePath);
    if (!t.ok) return null;
    try { return fs.readFileSync(t.want, 'utf-8'); } catch { return null; }
  };
  /* `expectBase`（可选）：盘上此刻不是这一份就不写 —— 侧栏撤销「AI 刚改过」那一处用它，不会盖掉预览还没刷出来的改动 */
  ipcMain.handle('review:write-file', async (_event, sessionId: string | null | undefined, filePath: string, text: string, expectBase?: unknown) =>
    writeReviewFile(sessionId, filePath, text, typeof expectBase === 'string' ? expectBase : undefined));

  /**
   * 哪些 ticket 已经在主进程这边**写完盘**了 —— 窗口 reload 回来时，"上次没做完"的那些里有些其实做完了
   * （回复到的时候没有窗口，主进程自己拼、自己写的）；渲染层问一句，做完的就不再当标记放回去。
   */
  const doneTickets = new Map<string, number>();
  const markTicketDone = (ticket: string | undefined) => {
    if (!ticket) return;
    doneTickets.set(ticket, Date.now());
    if (doneTickets.size > 500) for (const k of [...doneTickets.keys()].slice(0, 100)) doneTickets.delete(k);
  };
  ipcMain.handle('review:tickets-done', async (_event, tickets: string[]) =>
    (Array.isArray(tickets) ? tickets : []).filter((t) => doneTickets.has(String(t))));

  /** 在某条会话里留一行 **KiroLex 自己说的话**（改写落盘之后报一句"写进去了"）—— 不发给模型，见 `noteInSession`。 */
  ipcMain.handle('session:note', async (_event, sessionId: string, text: string) => {
    return noteInSession(sessionId, text) ? { ok: true } : { ok: false };
  });

  /**
   * 发一轮给这条会话，**等这一轮成功收尾的那份完整回复** —— 侧栏 review 的两条「✓ 确认」（文本一块 /
   * deck 一页）共用这一份，等待者的挂、摘、超时只写一遍。调用方已经排好队、挂回来、等到空闲。
   *
   *   · 兜底超时 8 分钟：等不到就报错**并把等待者摘掉** —— 留着它的话，这条会话下一轮正常对话的回复
   *     会被当成这次改写的结果；
   *   · 这一发走完了却没兑付 = 这一轮不是正常收尾（被取消、出错后没重发成、priming 吃掉了）——
   *     那条路上 flush 的是半截输出，不能拿去写盘（见 `askWaiters`）。
   */
  const askOnce = (sessionId: string, prompt: string, displayText: string): Promise<{ text: string; stopReason: string; wedged: boolean }> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        askWaiters.delete(sessionId);
        reject(new Error('等了 8 分钟没等到回复'));
      }, 8 * 60 * 1000);
      askWaiters.set(sessionId, { resolve, timer });
      /** 还挂着的是**这一次**的等待者就摘掉 —— 返回摘没摘 */
      const drop = (): boolean => {
        const w = askWaiters.get(sessionId);
        if (w && w.timer === timer) { askWaiters.delete(sessionId); clearTimeout(w.timer); return true; }
        return false;
      };
      sendPromptOnce(sessionId, [{ type: 'text', text: prompt }], undefined, { displayText }).then(() => {
        if (drop()) reject(new Error('这一轮没有正常结束（被取消或没有回复）'));
      }, (err: any) => {
        drop();
        reject(err);
      });
    });

  /**
   * 侧栏 review 的改写 —— **在打开这份文件的那条会话里做**（「否则新的 session 缺少必要的上下文」）。
   *
   * 判据（提示词、输出清洗、"改不了"的记号、什么样的回复能写盘）在 `reviseBlock.ts`，纯的、有测试。
   * 这里只管：排队（正忙不是报错）→ 挂回来 → 等它空下来 → 发一轮 → 等**成功收尾**的那份完整回复。
   *
   * 返回 `cannot` 时**不改任何东西**；渲染层据此升级到 `scope: 'patch'`，或者把原因摆给你看。
   *
   * 返回值（`patch` 档另外多 `changes`）：
   *   `{ ok: true, text, scope, written?, fullText?, changes? }` / `{ ok: false, cannot | error | cancelled }`
   *   · `patch` 档的 `text` 和 `fullText` 都是拼好的整份正文；
   *   · `changes: PatchChange[]`（见 `reviewApply.ts`）—— 这次实际改动的每一处：`from..to` 新文件里的行范围、
   *     `oldText` 原来的文本、`oldFrom..oldTo` 原文件里的行范围。给界面做高亮和逐段撤销。
   *   · `patch` 档**只在主进程写盘**：成功一定带 `written`；文件在等回复期间被动过（和 `apply.base` 对不上）
   *     返回 `{ ok: false, conflict: true, error }`，不交回正文 —— 见 `settlePatchRevision`。
   */
  ipcMain.handle('review:revise-in-session', async (_event, input: {
    sessionId: string; where: string; note: string; about?: string;
    /** `block`（默认，快）/ `patch`（跨段的意见：只交回要换的那几处）/ `insert` —— 见 `reviseInSessionPrompt`。 */
    scope?: 'block' | 'patch' | 'insert';
    /** 会话里那条消息显示成什么位置（「a.md 第 12 行」）—— 回头翻会话要看得出说的是哪儿。 */
    label?: string;
    /** `patch` 档的基准正文（盘上此刻那一份，行号按它编）—— 见 `reviseInSessionPrompt.full`。 */
    full?: string;
    /** 意见指的那一处在 `full` 里的行范围 —— `patch` 档写进提示词；整篇的意见不传。 */
    fromLine?: number;
    toLine?: number;
    /** 这一次改写的 ticket —— 取消按它认（见 `reviseTickets`）。 */
    ticket?: string;
    /**
     * **回复由主进程拼回去、写盘**（见 `reviewApply.ts`）—— 窗口在这几分钟里 reload 了也不丢。
     * 不传就退回老路：只回改写结果，由渲染层自己拼、自己写。
     */
    apply?: ReviewApply;
  }) => {
    const sessionId = String(input?.sessionId || '').trim();
    const note = String(input?.note ?? '').trim();
    const where = String(input?.where ?? '');
    const tk = openTicket(typeof input?.ticket === 'string' ? input.ticket : undefined, sessionId);
    if (!sessionId) return { ok: false, error: '这个标签页没有归属会话 —— 没地方问' };
    if (!note) return { ok: false, error: '没有意见' };
    if (deletedSessionIds.has(sessionId)) return { ok: false, error: '这条会话已经删掉了' };
    if (store.readRecord(sessionId)?.archived) return { ok: false, error: '这条会话已经归档了 —— 取消归档之后才能在里面改' };
    /*
      **正忙就排队，不是报错**：排到这条会话的队尾（`enqueueRevise`），轮到了再等它空下来（`waitIdle`）——
      插进一轮正在跑的对话里，改写会和它正在做的事混在一起。
    */
    return enqueueRevise(sessionId, async () => {
      try { return await reviseOnce(); } finally { tk.close(); }
    }, input?.label || '改写');

    async function reviseOnce() {
      /* 排队期间被取消了 —— 一个字都不发 */
      if (tk.cancelled()) return { ok: false, cancelled: true };
      await ensureAttached(sessionId);
      if (!sessionClients.get(sessionId)) return { ok: false, error: '这条会话连不上 —— 点一下它让它连上再试' };
      const stillBusy = await waitIdle(sessionId, 20 * 60 * 1000);
      if (stillBusy) return { ok: false, error: `等了 20 分钟这条会话还在忙（${stillBusy}）` };
      if (askWaiters.has(sessionId)) return { ok: false, error: '这条会话上已经有一次改写在等回复' };
      /* 等它空下来的那段时间里被取消了 —— 同样不发 */
      if (tk.cancelled()) return { ok: false, cancelled: true };
      /* 白名单而不是透传：这个值来自渲染进程，越界的写法落回默认那一档 */
      const wantScope = input?.scope === 'patch' ? 'patch' : input?.scope === 'insert' ? 'insert' : 'block';
      /* patch 的行号按哪一份编，拼回去就得按同一份拼 —— 有 apply 就用它的 base */
      const patchBase = typeof input?.apply?.base === 'string' ? input.apply.base
        : typeof input?.full === 'string' ? input.full : undefined;
      if (wantScope === 'patch' && patchBase === undefined) return { ok: false, error: '没有带上正文 —— 没法按行号改' };
      const prompt = reviseInSessionPrompt({
        where, note, about: input?.about, scope: wantScope,
        full: wantScope === 'patch' ? patchBase : undefined,
        fromLine: input?.fromLine, toLine: input?.toLine,
      });
      const started = Date.now();
      try {
        tk.asking(true);
        const reply = await askOnce(
          sessionId, prompt,
          /* 位置写进显示文本 —— 回头翻会话要看得出这条是说哪一处的 */
          input?.label ? `【改写 · ${input.label}】${note}` : `【改写】${note}`,
        ).finally(() => tk.asking(false));
        if (tk.cancelled()) return { ok: false, cancelled: true };
        const usable = replyUsable({ stopReason: reply.stopReason, wedged: reply.wedged });
        if (!usable.ok) {
          logger.warn('revise', `in-session ${sessionId}: ${usable.why}`);
          return { ok: false, error: usable.why };
        }
        if (wantScope === 'patch') {
          const first = await finishPatch(reply.text, patchBase!, started, false);
          if (first.ok || !('followUp' in first) || !first.followUp) return first;
          return await followUpPatch(first.followUp, patchBase!, started);
        }
        const out = parseRevised(reply.text, where);
        if (out.cannot) {
          logger.info('revise', `not local (in-session ${sessionId}): ${out.cannot}`);
          return { ok: false, cannot: out.cannot };
        }
        logger.info('revise', `in-session ${sessionId} scope=${wantScope}: ${out.text.length} chars in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        const apply = input?.apply;
        if (apply && typeof apply.base === 'string' && typeof apply.path === 'string') {
          const fullText = applyRevision(apply, out.text);
          if (fullText === null) return { ok: false, error: '拼不回去（位置不对）—— 没写' };
          const wrote = writeReviewFile(sessionId, apply.path, fullText, apply.base);
          /*
            盘上和渲染层手里那一份对不上（换行符、别的改动……）：主进程不写，把结果照老样子交回去，由渲染层按它手里那份拼、写 ——
            和以前一样，只是少了"窗口不在也不丢"那层保险。不能因为这一层就让改写整个失败。
          */
          if (!wrote?.ok && wrote?.mismatch) return { ok: true, text: out.text, scope: wantScope };
          if (!wrote?.ok) return { ok: false, error: wrote?.error || '写不进这个文件' };
          markTicketDone(input?.ticket);
          /* 窗口可能不在 —— 落盘这件事由主进程自己在会话里说一句 */
          noteInSession(sessionId, `✅ 已按意见改了${input?.label || '这份文件'}（现在 ${fullText.length} 字）\n文件：${wrote.path || apply.path}\nKiroLex 落盘完成（写前已备份到 ~/.kirolex/backups/review-files/）。`);
          return { ok: true, text: out.text, scope: wantScope, written: true, fullText };
        }
        /* 回报实际走的那一档 —— 渲染端的「＋」靠它确认主进程认得 insert（旧主进程会把它当 block，回来的是改过的原文） */
        return { ok: true, text: out.text, scope: wantScope };
      } catch (err: any) {
        /* 我们自己停的那一轮：askOnce 会以"没有正常结束"拒掉 —— 那不是失败，是取消 */
        if (tk.cancelled()) return { ok: false, cancelled: true };
        logger.warn('revise', `in-session ${sessionId} failed: ${err?.message || err}`);
        return { ok: false, error: String(err?.message || err) };
      }
    }

    /**
     * `patch` 档：回复 → 几处 `{from, to, text}` → 一次拼进 base → 写盘（照旧写前备份、对比 expectBase）。
     * 判据全在 `settlePatchRevision`（纯的、有测试）：任何一处不对整轮不写；**盘上和 base 对不上也是失败**，
     * 不像 block 那档把结果交回渲染层去写 —— 渲染层那次写不带 expectBase，会把等待期间的改动盖掉。
     */
    async function finishPatch(replyText: string, base: string, started: number, followedUp: boolean) {
      const apply = input?.apply;
      const canWrite = !!apply && typeof apply.path === 'string' && typeof apply.base === 'string';
      const res = settlePatchRevision({
        replyText, base, followedUp,
        write: canWrite ? (fullText, expectBase) => writeReviewFile(sessionId, apply!.path, fullText, expectBase) : undefined,
        /* 要追问之前先看一眼盘上那一份 —— 已经被改过就不追问，直接报冲突 */
        onDisk: canWrite ? () => readReviewFile(sessionId, apply!.path) : undefined,
      });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (!res.ok) {
        if ('cannot' in res) logger.info('revise', `not local (in-session ${sessionId} patch): ${res.cannot}`);
        else logger.warn('revise', `in-session ${sessionId} patch not written${res.conflict ? ' (conflict)' : ''}${res.followUp ? ' (will ask once more)' : ''}: ${res.error}`);
        /* 格式没解析出来 —— 记下原始回复的前一段，以后排查它到底写成了什么样 */
        if ('badFormat' in res && res.badFormat) logger.warn('revise', `in-session ${sessionId} patch raw reply${followedUp ? ' (after follow-up)' : ''}: ${String(replyText).slice(0, 2000)}`);
        return res;
      }
      logger.info('revise', `in-session ${sessionId} scope=patch: ${res.changes.length} edit(s) in ${secs}s${res.written ? ', written' : ''}`);
      if (res.written) {
        markTicketDone(input?.ticket);
        noteInSession(sessionId, `✅ 已按意见改了${input?.label || '这份文件'}（${res.changes.length} 处，现在 ${res.fullText.length} 字）\n文件：${res.path || apply!.path}\nKiroLex 落盘完成（写前已备份到 ~/.kirolex/backups/review-files/）。`);
      }
      return res;
    }

    /**
     * `patch` 档的回复格式不对（空块、看不懂的块头、一块都没有）—— 在**同一条会话**里追问**一次**，
     * 要它把这一轮的全部改动按原格式重交；行号基准还是 `base`。第二次还不对就照常报失败（见 `settlePatchRevision`）。
     * 和第一轮一样：还在这条会话的改写队列里，先等它空下来；取消按同一个 ticket 停；落盘还是 `finishPatch`。
     */
    async function followUpPatch(followUp: string, base: string, started: number) {
      const stillBusy = await waitIdle(sessionId, 20 * 60 * 1000);
      if (stillBusy) return { ok: false, error: `回复格式不对，想让它补一次，但等了 20 分钟这条会话还在忙（${stillBusy}）` };
      if (tk.cancelled()) return { ok: false, cancelled: true };
      if (askWaiters.has(sessionId)) return { ok: false, error: '回复格式不对，想让它补一次，但这条会话上已经有一次改写在等回复' };
      tk.asking(true);
      const again = await askOnce(
        sessionId, followUp,
        input?.label ? `【改写 · ${input.label}】上一条格式不对，请重交一遍` : '【改写】上一条格式不对，请重交一遍',
      ).finally(() => tk.asking(false));
      if (tk.cancelled()) return { ok: false, cancelled: true };
      const usable = replyUsable({ stopReason: again.stopReason, wedged: again.wedged });
      if (!usable.ok) {
        logger.warn('revise', `in-session ${sessionId} follow-up: ${usable.why}`);
        return { ok: false, error: usable.why };
      }
      return await finishPatch(again.text, base, started, true);
    }
  });

  /**
   * 取消侧栏 comment 提交的**那一次**改写 —— 见 `reviseTickets`。还没轮到 / 还在等会话空下来的：记一笔，
   * 轮到时不发。已经发出去在等回复的：停**它自己那一轮**（那时这条会话上挂着的等待者就是它，不会误停你的对话）。
   */
  ipcMain.handle('review:cancel', async (_event, ticket: string) => {
    const t = reviseTickets.get(String(ticket || ''));
    if (!t) return { ok: false };
    t.cancelled = true;
    if (t.asking && askWaiters.has(t.sessionId)) {
      const entry = sessionClients.get(t.sessionId);
      if (entry?.busy && !entry.priming) {
        logger.info('revise', `cancel ticket ${ticket}: stopping its own turn sessionId=${t.sessionId}`);
        try { await entry.client.cancelPrompt(entry.cliSessionId); } catch { /* 管道可能已经断了 */ }
      }
    }
    return { ok: true };
  });

  /* ───────────────── 侧栏文件预览：PDF / deck（`.pptx` 等先转成 PDF）─────────────────
   *
   * 从 feature/flow 搬过来。判据全在 `deckPreview.ts`（纯的、有测试）：转换器在哪儿找、缓存 key 怎么算、
   * 那几段 python-pptx 脚本、输出怎么解析。这里只负责探测、spawn、缓存、闸门。
   *
   * 闸门和文本那侧（`review:write-file`）同一套：路径按**标签页主人会话**解析（`resolveUserPath`），
   * 写的只许是这条会话读过的（`reviewTarget`），写前二进制备份、备份不成不写。
   */

  /** 一次 LibreOffice 转换最多等多久。冷启动（第一次建 profile）在 Windows 上实测要慢不少，给足。 */
  const PREVIEW_TIMEOUT_MS = 180_000;
  /** 预览缓存留多少份。key 里有 deck 的 mtime，改一次就多一份，而旧那份再也不会命中。 */
  const PREVIEW_CACHE_KEPT = 10;
  const previewsRoot = path.join(os.homedir(), '.kirolex', 'previews');

  /** 一个目录里只留按 mtime 最新的 N 项 —— 预览缓存用（备份那边在 `saveReviewBackup` 里自己清）。 */
  const keepNewestIn = (dir: string, keep: number, what: string): void => {
    try {
      const old = fs.readdirSync(dir)
        .map((n) => { const full = path.join(dir, n); try { return { full, t: fs.statSync(full).mtimeMs }; } catch { return null; } })
        .filter((e): e is { full: string; t: number } => !!e)
        .sort((a, b) => b.t - a.t)
        .slice(keep);
      for (const e of old) { try { fs.rmSync(e.full, { recursive: true, force: true }); } catch { /* 下次再说 */ } }
      if (old.length) logger.info('prune', `${what}: 清掉 ${old.length} 份，留最近 ${keep} 份`);
    } catch { /* 目录不存在就什么都不做 */ }
  };

  /**
   * 能跑 python-pptx 的那个解释器 —— **只缓存找到了的结果**。
   *
   * 候选按平台给（`pythonCandidates`：Windows 上是 `python` / `py -3`，没有 `python3`）。没找到不缓存：
   * 你照提示 `pip install python-pptx` 之后，下一次打开就该能用，而不是要重启 KiroLex。
   */
  let pythonPptx: { cmd: string; args: string[] } | null = null;
  const findPythonPptx = async (): Promise<{ cmd: string; args: string[] } | null> => {
    if (pythonPptx) return pythonPptx;
    for (const c of pythonCandidates(process.platform)) {
      const ok = await new Promise<boolean>((resolve) => {
        execFile(c.cmd, [...c.args, '-c', PPTX_PROBE_SCRIPT],
          { timeout: 15_000, env: pythonEnv(process.env) as NodeJS.ProcessEnv, windowsHide: true },
          (err, stdout) => resolve(!err && String(stdout || '').includes('ok')));
      });
      if (ok) { pythonPptx = c; logger.info('deck', `python-pptx via ${c.cmd} ${c.args.join(' ')}`.trim()); return c; }
    }
    return null;
  };
  /** 没有 python-pptx 时抛的那个错 —— 调用方据此把 `noPythonPptxWhy` 原样给界面，而不是一句 ENOENT。 */
  class NoPythonPptx extends Error {}
  /** 跑一段 python-pptx 脚本，文本走 stdin（讲稿动辄六百字、带引号换行，塞进 argv 迟早翻车）。 */
  const runPy = async (script: string, args: string[], stdin = ''): Promise<string> => {
    const py = await findPythonPptx();
    if (!py) throw new NoPythonPptx(noPythonPptxWhy(process.platform));
    return new Promise((resolve, reject) => {
      const child = execFile(py.cmd, [...py.args, '-c', script, ...args],
        { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: pythonEnv(process.env) as NodeJS.ProcessEnv, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
      child.stdin?.end(stdin, 'utf-8');
    });
  };
  const pyError = (err: any): string => String(err?.message || err).slice(0, 300);

  /**
   * 这台机器上的 LibreOffice —— PATH（Windows 用 `where`，别处 `command -v`）优先，其次固定安装位置。
   * 每次现找（几十毫秒）：装完回来点刷新就该能用，不能要求重启。
   */
  const findSoffice = (): { bin: string | null; looked: string[] } => {
    const looked: string[] = [];
    for (const name of SOFFICE_PATH_NAMES) {
      looked.push(`PATH 上的 ${name}（${process.platform === 'win32' ? 'where' : 'command -v'}）`);
      try {
        const out = execSync(pathProbeCommand(name, process.platform), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        const hit = firstProbeHit(String(out || ''));
        if (hit) return { bin: sofficeBinary(hit, (p) => fs.existsSync(p)), looked };
      } catch { /* 没找到 —— `where` 找不到时退出码非零 */ }
    }
    looked.push(...SOFFICE_BUNDLE_PATHS);
    return { bin: sofficeBinary(null, (p) => fs.existsSync(p)), looked };
  };

  /**
   * 同一份 deck 只转一次 —— 见 `convertOnce` 文件头。dev 下 StrictMode 把 effect 跑两遍、
   * 加上"读不到就 force 重转"那条退路，同一瞬间要两次很常见，而 LibreOffice 是单实例的。
   */
  const deckConversions = new ConvertOnce<{ ok: boolean; pdf?: string; why?: string }>();

  /** 这份 PDF 的内容指纹 —— 渲染那侧靠它判断"要不要重新交给 pdf.js"（比路径可靠：缓存 key 每次都变）。 */
  const pdfStamp = (p: string): string | null => {
    try {
      const { createHash } = require('crypto');
      return createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
    } catch { return null; }
  };
  const sha16 = (t: string): string => {
    const { createHash } = require('crypto');
    return createHash('sha1').update(t).digest('hex').slice(0, 16);
  };

  /**
   * `.pptx` / `.docx`… → **一个 PDF**；`.pdf` 直接返回它自己（**不需要 LibreOffice**）。
   *
   * 返回的 `pdf` 是主进程这边的路径，渲染层拿它去 `preview:pdf-bytes` 换字节 —— 渲染层自己取不到 `file://`。
   * 讲稿（`notes`）可降级：没有 python-pptx 时是 `null` 外加一句 `notesWhy`，预览照样能看。
   */
  ipcMain.handle('preview:deck', async (_event, sessionId: string | null | undefined, rawPath: string, force?: boolean) => {
    if (!String(rawPath || '').trim()) return { ok: false, why: '没有指定文件' };
    let file: string;
    try { file = resolveUserPath(String(rawPath), sessionId); } catch (e: any) { return { ok: false, why: String(e?.message || e) }; }
    if (!isPreviewable(file)) return { ok: false, why: `这种文件不走这条预览：${path.basename(file)}` };
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return { ok: false, why: `读不到这个文件：${file}` }; }
    /* 预览本身就是"读过" —— 和 workspace:read 一样记在这条会话名下（写回的闸看这个） */
    markReviewed(sessionId, file);
    const editable = canEditDeck(file);

    if (!needsConversion(file)) {
      return { ok: true, pdf: file, pages: null, notes: null, pdfHash: pdfStamp(file), editable: false };
    }

    /* 讲稿先抽 —— 下面两条返回路径都要用它。抽不到不算失败，只是不显示那一列（并说清为什么） */
    let notes: string[] | null = null;
    let notesWhy: string | undefined;
    if (editable) {
      try {
        notes = parseNotesResult(await runPy(NOTES_SCRIPT, [file]))?.notes ?? null;
      } catch (err: any) {
        notesWhy = err instanceof NoPythonPptx ? err.message : `读不出讲稿：${pyError(err)}`;
      }
    }

    const key = previewKey({ path: file, mtimeMs: stat.mtimeMs, size: stat.size }, sha16);
    const outDir = path.join(previewsRoot, key);
    const cached = path.join(outDir, 'deck.pdf');
    /* 缓存命中的条件是**这个 PDF 真的能读**（非空、首字节读得到），不是"目录里有个同名文件" */
    const usable = (pdf: string): boolean => {
      try {
        if (fs.statSync(pdf).size <= 0) return false;
        const fd = fs.openSync(pdf, 'r');
        try { return fs.readSync(fd, Buffer.alloc(1), 0, 1, 0) === 1; } finally { fs.closeSync(fd); }
      } catch { return false; }
    };
    const done = (pdf: string) => ({
      ok: true, pdf, pages: null, notes, pdfHash: pdfStamp(pdf), editable,
      ...(notesWhy ? { notesWhy } : null),
    });
    if (fs.existsSync(cached) && !force && usable(cached)) {
      logger.info('preview', `cache hit ${file} key=${key}`);
      return done(cached);
    }
    if (fs.existsSync(outDir)) {
      logger.warn('preview', `stale cache dropped ${outDir} (force=${!!force})`);
      fs.rmSync(outDir, { recursive: true, force: true });
    }

    const { bin: soffice, looked } = findSoffice();
    if (!pickConverter({ soffice: !!soffice }) || !soffice) {
      logger.warn('preview', `no converter for ${file} (looked: ${looked.join(' | ')})`);
      /* `install` 单独给 —— 界面配一个一键复制，而不是让人从一段话里选中命令 */
      return {
        ok: false,
        why: noConverterWhy({ platform: process.platform, looked, ext: path.extname(file) }),
        install: installConverterCmd(process.platform),
        noConverter: true,
      };
    }

    /*
      转到**临时目录再原子改名**：中途失败或超时留下的是半个 PDF，下一次会被当成缓存命中。
      同一个 key 只转一次：并发的第二个请求**等**这一次的结果（见 `ConvertOnce`）。
    */
    const outcome = await deckConversions.run(key, async () => {
      const stage = `${outDir}.partial-${Date.now()}`;
      fs.mkdirSync(stage, { recursive: true });
      try {
        /* 自己那份 LO profile —— 不跟用户自己开着的 LibreOffice 抢默认 profile（见 `convertOnce`） */
        const profile = path.join(os.homedir(), '.kirolex', LO_PROFILE_DIR);
        fs.mkdirSync(profile, { recursive: true });
        await new Promise<void>((resolve, reject) => {
          execFile(soffice, [
            userInstallationArg(profile),
            '--headless', '--convert-to', 'pdf', '--outdir', stage, file,
          ], { timeout: PREVIEW_TIMEOUT_MS, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
        });
        const made = fs.readdirSync(stage).find((n) => /\.pdf$/i.test(n));
        if (!made) throw new Error(`${soffice} 跑完了但没产出 PDF`);
        fs.renameSync(path.join(stage, made), path.join(stage, 'deck.pdf'));
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.renameSync(stage, outDir);
        logger.info('preview', `converted ${file} via ${soffice} key=${key}`);
        keepNewestIn(previewsRoot, PREVIEW_CACHE_KEPT, '预览缓存');
        return { ok: true, pdf: cached };
      } catch (err: any) {
        fs.rmSync(stage, { recursive: true, force: true });
        const why = err?.killed || /timed? ?out/i.test(String(err?.message || ''))
          ? `转 PDF 超时（${PREVIEW_TIMEOUT_MS / 1000}s）—— 可以用顶栏「↗ 打开文件」交给系统应用`
          : `转 PDF 失败：${String(err?.message || err).slice(0, 200)}`;
        logger.warn('preview', `${file}: ${why}`);
        return { ok: false, why };
      }
    });
    if (!outcome.ok || !outcome.pdf) return { ok: false, why: outcome.why };
    return done(outcome.pdf);
  });

  /**
   * 把一个 PDF 的字节交给渲染层 —— **`file://` 在渲染层取不到**（dev 下 origin 是 `http://localhost:5173`，
   * Chromium 不许它加载 `file://` 子资源，`fetch` 直接 `Failed to fetch`）。base64 和图片那条 `dataUrl` 同一个形状。
   *
   * 只给两种路径：我们自己的预览缓存（`~/.kirolex/previews` 下面），或者**这条会话读过的** `.pdf`。
   * 不凭渲染进程说它想读哪儿 —— 这条通道能把盘上任何一个 PDF 的字节读出去。
   */
  ipcMain.handle('preview:pdf-bytes', async (_event, sessionId: string | null | undefined, rawPath: string) => {
    let file: string;
    try { file = resolveUserPath(String(rawPath || ''), sessionId); } catch { return { ok: false, why: '路径不对' }; }
    if (!/\.pdf$/i.test(file)) return { ok: false, why: '只接受 .pdf 路径' };
    const rel = path.relative(previewsRoot, file);
    const inCache = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (!inCache && !wasReviewed(sessionId, file)) {
      logger.warn('preview', `refused pdf bytes: ${file} (session=${sessionId || '(none)'})`);
      return { ok: false, why: '这个 PDF 不是这条会话的标签页打开过的' };
    }
    try {
      const buf = fs.readFileSync(file);
      return { ok: true, base64: buf.toString('base64'), bytes: buf.length };
    } catch (err: any) {
      return { ok: false, why: `读不到这个 PDF：${String(err?.message || err).slice(0, 160)}` };
    }
  });

  /** deck 写盘那几条共用的闸：会话 + 路径 → 要写的那个 `.pptx`（解析、读过、只认 `.pptx`、页码）。 */
  const deckTarget = (sessionId: string | null | undefined, filePath: string, page: number):
    { ok: true; want: string; at: number } | { ok: false; error: string } => {
    const t = reviewTarget(sessionId, filePath);
    if (!t.ok) return t;
    if (!canEditDeck(t.want)) return { ok: false, error: '只有 .pptx 能这么改（.ppt / .odp / 文档类只能预览和整体提交）' };
    const at = Number(page);
    if (!Number.isInteger(at) || at < 1) return { ok: false, error: '页码不对' };
    return { ok: true, want: t.want, at };
  };
  /** 写前二进制备份；拷不成返回那句错误（调用方据此**不写**）。 */
  const backupDeck = (want: string): string | null => {
    try {
      if (!saveReviewBackup(want, fs.readFileSync(want))) {
        return '写前备份失败 —— 没有可回滚的副本，所以这次不改。检查 ~/.kirolex/backups 能不能写。';
      }
      return null;
    } catch (e: any) { return String(e?.message || e); }
  };

  /**
   * WRITE ONE SLIDE'S SPEAKER NOTES —— **一页一个 XML part，不重导整份**（见 `WRITE_NOTE_SCRIPT`）。
   *
   * 写完把所有页的备注重抽一遍返回 —— 界面要的是磁盘上那一份。顺手把已经转好的 PDF **搬到新 key 下面**：
   * 改讲稿必然改 mtime（缓存 key 失效），而讲稿根本不进 PDF；这次改动是我们做的，我们清楚只有讲稿变了。
   */
  ipcMain.handle('deck:write-note', async (_event, sessionId: string | null | undefined, filePath: string, page: number, text: string) => {
    const g = deckTarget(sessionId, filePath, page);
    if (!g.ok) return g;
    const { want, at } = g;
    try {
      const beforeStat = fs.statSync(want);
      const bad = backupDeck(want);
      if (bad) return { ok: false, error: bad };
      const parsed = parseWriteNote(await runPy(WRITE_NOTE_SCRIPT, [want, String(at)], String(text ?? '')));
      if (!parsed.ok) {
        logger.warn('deck', `note write failed: ${parsed.error}`);
        return { ok: false, error: parsed.error };
      }
      try {
        const oldKey = previewKey({ path: want, mtimeMs: beforeStat.mtimeMs, size: beforeStat.size }, sha16);
        const st2 = fs.statSync(want);
        const newKey = previewKey({ path: want, mtimeMs: st2.mtimeMs, size: st2.size }, sha16);
        const from = path.join(previewsRoot, oldKey);
        const to = path.join(previewsRoot, newKey);
        if (oldKey !== newKey && fs.existsSync(path.join(from, 'deck.pdf')) && !fs.existsSync(path.join(to, 'deck.pdf'))) {
          fs.mkdirSync(to, { recursive: true });
          /* 搬，不是拷 —— 旧 key 再也不会被查到，拷一份就是留一个死文件。跨设备 rename 失败才退回拷 */
          try { fs.renameSync(path.join(from, 'deck.pdf'), path.join(to, 'deck.pdf')); } catch {
            fs.copyFileSync(path.join(from, 'deck.pdf'), path.join(to, 'deck.pdf'));
          }
          try { fs.rmdirSync(from); } catch { /* 里面还有别的东西就留着 */ }
          logger.info('deck', `carried preview cache ${oldKey} -> ${newKey} (notes-only edit)`);
        }
      } catch (err: any) {
        logger.info('deck', `preview cache carry skipped: ${err?.message || err}`);
      }
      logger.info('deck', `wrote notes of page ${at} in ${path.basename(want)} (${String(text ?? '').length} chars)`);
      return { ok: true, notes: parsed.notes };
    } catch (error: any) {
      return { ok: false, error: error instanceof NoPythonPptx ? error.message : pyError(error) };
    }
  });

  /**
   * 写一页幻灯片上的文字 —— 按 run 地址逐个替换，格式一个字节不动（见 `WRITE_SLIDE_TEXT_SCRIPT`）。
   * 普通函数，因为两个入口都要用它：`deck:write-slide-text`（渲染进程直接写）和 `deck:revise-slide-text`。
   * 调用方已经过了 `deckTarget` 那道闸。
   */
  const writeSlideText = async (want: string, at: number, edits: Array<{ at: string; text: string }>): Promise<any> => {
    const rows = (Array.isArray(edits) ? edits : [])
      .filter((e) => e && typeof e.at === 'string' && /^\d+\.\d+\.\d+$/.test(e.at) && typeof e.text === 'string');
    if (!rows.length) return { ok: false, error: '没有可写的改动（地址要形如 `2.0.0`）' };
    /* 换行会把 stdin 那一行切断（一行一条 `地址<TAB>文本`）—— 换成空格，别把它写成两条 */
    const payload = rows.map((e) => `${e.at}\t${e.text.replace(/[\r\n]+/g, ' ')}`).join('\n');
    try {
      const bad = backupDeck(want);
      if (bad) return { ok: false, error: bad };
      const parsed = parseSlideRuns(await runPy(WRITE_SLIDE_TEXT_SCRIPT, [want, String(at)], payload));
      if (!parsed.ok) {
        logger.warn('deck', `slide text write failed: ${parsed.error}`);
        return { ok: false, error: parsed.error };
      }
      logger.info('deck', `wrote ${parsed.changed} run(s) on page ${at} of ${path.basename(want)}`);
      return { ok: true, runs: parsed.runs, changed: parsed.changed ?? rows.length };
    } catch (error: any) {
      return { ok: false, error: error instanceof NoPythonPptx ? error.message : pyError(error) };
    }
  };

  /**
   * **动版面**：删框 / 加框 / 挪框 / 改字号 / 改项目符号 / 改层级（见 `SLIDE_OPS_SCRIPT`）。
   * 和 `writeSlideText` 并排而不是合并：那条一个字节都不多动，这条会改结构 —— 但闸和备份是同一套。
   */
  const writeSlideOps = async (want: string, at: number, ops: any[]): Promise<any> => {
    const rows = (Array.isArray(ops) ? ops : []).filter((o) => o && typeof o.op === 'string');
    if (!rows.length) return { ok: false, error: '没有可执行的版面指令' };
    try {
      const bad = backupDeck(want);
      if (bad) return { ok: false, error: bad };
      const parsed = parseSlideRuns(await runPy(SLIDE_OPS_SCRIPT, [want, String(at)], rows.map((o) => JSON.stringify(o)).join('\n')));
      if (!parsed.ok) {
        logger.warn('deck', `slide ops failed: ${parsed.error}`);
        return { ok: false, error: parsed.error };
      }
      logger.info('deck', `slide ops: ${parsed.changed ?? rows.length} 条生效 on page ${at} of ${path.basename(want)}`);
      return { ok: true, runs: parsed.runs, changed: parsed.changed ?? rows.length };
    } catch (error: any) {
      return { ok: false, error: error instanceof NoPythonPptx ? error.message : pyError(error) };
    }
  };

  /**
   * 一步做完：**问那条会话这一页的文字该怎么改，然后自己写进去** —— 「现在就做一个工具吧」。
   *
   * 一次往返（模型只出 `地址<TAB>新文本` 和几条版面指令），落盘由 python-pptx 按地址做 ——
   * 格式一个字节不动。对照：让它自己写 python-pptx 代码时实测九次往返、四分多钟，工具只占 6 秒。
   * **文字先改，版面后动**：版面一动形状下标就全变了，而文字那条用的是按下标的地址。
   */
  ipcMain.handle('deck:revise-slide-text', async (_event, input: {
    sessionId: string; filePath: string; page: number; note: string;
    /** 这一次改写的 ticket —— 取消按它认（见 `reviseTickets`）。 */
    ticket?: string;
  }) => {
    const sid = String(input?.sessionId || '').trim();
    const note = String(input?.note || '').trim();
    if (!sid) return { ok: false, error: '这份文件没有归属会话 —— 没地方问' };
    if (!note) return { ok: false, error: '没有意见' };
    const g = deckTarget(sid, String(input?.filePath || ''), Number(input?.page));
    if (!g.ok) return g;
    const { want, at: page } = g;
    if (!(await findPythonPptx())) return { ok: false, error: noPythonPptxWhy(process.platform) };
    const tk = openTicket(typeof input?.ticket === 'string' ? input.ticket : undefined, sid);
    return enqueueRevise(sid, async () => {
      if (tk.cancelled()) { tk.close(); return { ok: false, cancelled: true }; }
      await ensureAttached(sid);
      if (!sessionClients.get(sid)) { tk.close(); return { ok: false, error: '这条会话连不上 —— 点一下它让它连上再试' }; }
      const stillBusy = await waitIdle(sid, 20 * 60 * 1000);
      if (stillBusy) { tk.close(); return { ok: false, error: `等了 20 分钟这条会话还在忙（${stillBusy}）` }; }
      if (askWaiters.has(sid)) { tk.close(); return { ok: false, error: '这条会话上已经有一次改写在等回复' }; }
      if (tk.cancelled()) { tk.close(); return { ok: false, cancelled: true }; }
      try {
        /* 先把这一页现有的文字读出来 —— 模型要按地址回，就得先看见地址 */
        const cur = parseSlideRuns(await runPy(SLIDE_TEXT_SCRIPT, [want, String(page)]));
        if (!cur.ok) return { ok: false, error: cur.error };
        if (!cur.runs.length && !cur.shapes?.length) return { ok: false, error: '这一页没有可改的文字（可能只有图）' };
        const prompt = reviseSlideTextPrompt({
          runs: cur.runs, note, page, path: want,
          ...(cur.shapes?.length ? { shapes: cur.shapes } : null),
          ...(cur.page ? { pageW: cur.page.w, pageH: cur.page.h } : null),
        });
        const started = Date.now();
        tk.asking(true);
        const reply = await askOnce(sid, prompt, `【改写 · ${path.basename(want)} 第 ${page} 页版面文字】${note}`)
          .finally(() => tk.asking(false));
        /* 我们自己停的那一轮 —— 回复不用，也不写 */
        if (tk.cancelled()) return { ok: false, cancelled: true };
        const usable = replyUsable({ stopReason: reply.stopReason, wedged: reply.wedged });
        if (!usable.ok) return { ok: false, error: usable.why };
        const got = parseSlideEdits(reply.text);
        if (!got.edits.length && !got.ops.length) {
          /* 一条都没解析出来时把它回的原话记下来 —— 否则这个失败查不了 */
          if (!got.cannot) logger.warn('deck', `slide text: 一条都没解析出来 (page ${page})，它回的是：\n${String(reply.text).slice(0, 600)}`);
          return { ok: false, ...(got.cannot ? { cannot: got.cannot } : { error: '它没有给出可用的改动行' }) };
        }
        logger.info('deck', `slide: ${got.edits.length} 处文字 + ${got.ops.length} 条版面指令 for page ${page}`
          + ` in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        let changed = 0;
        if (got.edits.length) {
          const wroteText = await writeSlideText(want, page, got.edits);
          if (!wroteText?.ok) return wroteText;
          changed += Number(wroteText.changed) || 0;
        }
        if (got.ops.length) {
          const wroteOps = await writeSlideOps(want, page, got.ops);
          if (!wroteOps?.ok) {
            /* 文字已经改进去了就不算全败 —— 说清哪一半没成 */
            return got.edits.length
              ? { ok: true, changed, partial: `版面那几条没做成：${wroteOps.error}` }
              : wroteOps;
          }
          changed += Number(wroteOps.changed) || 0;
        }
        return { ok: true, changed };
      } catch (err: any) {
        if (tk.cancelled()) return { ok: false, cancelled: true };
        logger.warn('deck', `slide text revise failed: ${err?.message || err}`);
        return { ok: false, error: err instanceof NoPythonPptx ? err.message : String(err?.message || err) };
      } finally {
        tk.close();
      }
    }, `${path.basename(want)} 第 ${page} 页版面文字`);
  });

  ipcMain.handle('deck:read-slide-text', async (_event, sessionId: string | null | undefined, filePath: string, page: number) => {
    const g = deckTarget(sessionId, filePath, page);
    if (!g.ok) return g;
    try {
      const parsed = parseSlideRuns(await runPy(SLIDE_TEXT_SCRIPT, [g.want, String(g.at)]));
      return parsed.ok ? { ok: true, runs: parsed.runs } : { ok: false, error: parsed.error };
    } catch (error: any) {
      return { ok: false, error: error instanceof NoPythonPptx ? error.message : pyError(error) };
    }
  });

  ipcMain.handle('deck:write-slide-text', async (
    _event, sessionId: string | null | undefined, filePath: string, page: number, edits: Array<{ at: string; text: string }>,
  ) => {
    const g = deckTarget(sessionId, filePath, page);
    if (!g.ok) return g;
    return writeSlideText(g.want, g.at, edits);
  });

  /** Manual rebuild. `force` also covers the case a successful session/load
   *  cannot rule out: kiro-cli resumed an id that was itself empty. */
  ipcMain.handle('acp:prime-history', async (_event, sessionId: string, force?: boolean) => {
    return primeHistoryNow(sessionId, { force: !!force });
  });

  /** The chat the user just opened. Verifies the backend really holds this chat's
   *  history and starts the rebuild if not.
   *
   *  Why a separate signal instead of doing it at attach: attach also fires for
   *  every session warmed at startup, and rebuilding all of them would be absurd.
   *  Why not leave it to the send gate: it meant a restored chat looked idle and
   *  the rebuild only began after the user had typed and sent something -- which is
   *  exactly what was observed. Activation is the earliest point where the intent
   *  to use this chat is known. */
  ipcMain.handle('acp:ensure-context', async (_event, sessionId: string) => {
    if (!sessionId || sessionId.startsWith('pending_')) return { ok: true, skipped: true };
    const entry = sessionClients.get(sessionId);
    if (!entry) return { ok: false, error: 'not attached' };
    // Opening a chat costs NOTHING for the default (snapshot) path: the context
    // rides along with the next message, so there is no rebuild to start and the
    // chat must not be locked. Verified from the logs that leaving this handler
    // rebuilding was exactly why "switching chats rebuilds every time" persisted
    // even after the ride-along was added: `trigger=activate` fired its own turn.
    // Only verbatim ('full') mode has a real rebuild to perform.
    if (store.readRecord(sessionId)?.primeMode !== 'full') {
      return { ok: true, skipped: true, rideAlong: true };
    }
    if (!markContextOwedIfUnverified(sessionId, 'activate')) return { ok: true, skipped: true };
    // Fire-and-forget: opening a chat must not block on the rebuild. The session
    // is already reported busy, so the composer queues instead of firing.
    void primeHistoryNow(sessionId).catch(() => {});
    return { ok: true, rebuilding: true };
  });

  /** Switch how this chat restores context: one snapshot prompt (default) or a
   *  verbatim replay of every chunk. Kept per session because the cost difference
   *  is enormous on big chats and only the user can judge whether the exactness is
   *  worth 78 model turns per launch. */
  ipcMain.handle('acp:set-prime-mode', async (_event, sessionId: string, primeMode: 'snapshot' | 'full') => {
    if (!sessionId) return { ok: false, error: 'no sessionId' };
    try {
      /*
        `patchRecord` 而不是「读-改-写」：这个 IPC 也是在会话刚建出来时被调用的(flow 编辑会话交底那一步),
        而记录要到**第一次 prompt** 才创建 —— 读-改-写在那个窗口里必然失败,而且是静默的。实测:
        `purpose LOST … 等了 2s 记录还没出现` 之后 5 秒才有 `prompt received`。
      */
      const mode = primeMode === 'full' ? 'full' : 'snapshot';
      const where = store.patchRecord(sessionId, { primeMode: mode });
      const entry = sessionClients.get(sessionId);
      if (entry) { entry.primeChunks = undefined; entry.primeCursor = 0; }
      logger.info('prime', `mode set sessionId=${sessionId} primeMode=${mode} (${where})`);
      return { ok: true, primeMode: mode };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'failed' };
    }
  });


  // Initial occupancy snapshot: the renderer paints per-session busy state on
  // hydrate/session switch instead of waiting for the next push.
  ipcMain.handle('acp:get-busy-map', async () => {
    const map: Record<string, string> = {};
    const ids = new Set<string>([
      ...sessionClients.keys(),
      ...reconfiguringSessions,
      ...attachingSessions,
    ]);
    for (const id of ids) {
      const reason = busyReasonFor(id);
      if (reason) map[id] = reason;
    }
    return map;
  });

  ipcMain.handle('acp:request-permission-response', async (
    _event,
    requestId: number | string,
    optionId: string,
    sessionId: string,
  ) => {
    const entry = sessionClients.get(sessionId);
    if (!entry) throw new Error('Session not connected');
    // Close the wait span. Measured from the REQUEST, not from when the dialog was
    // rendered: the wait the user cares about is the whole time the turn was blocked.
    const requestKey = String(requestId ?? '');
    const startedAt = permissionWaitStartedAt.get(requestKey);
    permissionWaitStartedAt.delete(requestKey);
    eventLog.appendEvent(sessionId, {
      ts: Date.now(),
      type: 'permission_response',
      turn: entry.currentUserMessageId,
      optionId,
      ms: startedAt ? Date.now() - startedAt : 0,
      detail: requestKey,
    });
    if (startedAt) {
      logger.info('permission', `answered sessionId=${sessionId} option=${optionId} waited=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    }
    return entry.client.respondToPermission(requestId, optionId);
  });

  /** Read this session's run event log (timeline + event stream views). */
  ipcMain.handle('acp:read-events', (_event, sessionId: string, limit?: number) => {
    if (!sessionId) return { events: [], path: '', truncated: false };
    return eventLog.readEvents(sessionId, Math.min(Math.max(1, Number(limit) || 4000), 20000));
  });

  // Write-once project assignment (design §6.4). Allowed only for the
  // null/undefined -> concrete transition; project->project or un-set is
  // rejected. Persists to the durable record and syncs any live executor.
  ipcMain.handle('acp:assign-project', async (_event, sessionId: string, projectId: string) => {
    const rec = store.readRecord(sessionId);
    if (!rec) throw new Error('No such session');
    if (!canAssignProjectId(rec.profile.projectId, projectId)) {
      throw new Error('projectId is write-once; it cannot be changed once set.');
    }
    rec.profile.projectId = projectId;
    delete rec.profile.unassigned;
    rec.placementChangedAt = Date.now(); // 多台机器之间位置按它跟随（placementToFollow）
    store.writeRecord(rec);
    const entry = sessionClients.get(sessionId);
    if (entry) { entry.profile.projectId = projectId; delete entry.profile.unassigned; } // keep live executor in sync
    return { sessionId, projectId };
  });

  // Project-level force set/clear (used by rename/delete PROJECT, an explicit
  // admin operation). Unlike acp:assign-project this bypasses the write-once
  // check on purpose; per-session Assign still goes through the checked path.
  ipcMain.handle('acp:set-project', async (_event, sessionId: string, projectId: string | null) => {
    const rec = store.readRecord(sessionId);
    if (!rec) return { sessionId, projectId };
    rec.profile.projectId = projectId ?? undefined;
    if (projectId) delete rec.profile.unassigned; else rec.profile.unassigned = true;
    rec.placementChangedAt = Date.now(); // 多台机器之间位置按它跟随（placementToFollow）
    store.writeRecord(rec);
    const entry = sessionClients.get(sessionId);
    if (entry) {
      entry.profile.projectId = projectId ?? undefined;
      if (projectId) delete entry.profile.unassigned; else entry.profile.unassigned = true;
    }
    return { sessionId, projectId };
  });

  // Move a session to another project (or unassign with null) WITH an executor
  // reset. Changing the project changes the injected memory scope; a live
  // executor already has the OLD project's memory in its context. We detach it
  // so a fresh executor attaches on next use, re-injecting ONLY the new scope's
  // memory (old injection state is discarded with the entry). The durable
  // transcript + memory are untouched; the backend session resumes on re-attach,
  // so the conversation is preserved. Unlike assign-project this is not
  // write-once — it is an explicit user move.
  ipcMain.handle('acp:move-session', async (_event, sessionId: string, projectId: string | null) => {
    /*
      **一轮在跑的时候不许换项目** ——「为什么远程 session 换不了 project」。
      换项目要重置执行器（换 memory scope），而 `detachExecutor` 是无条件的：跑着的那一轮会被
      连根拔掉，界面上的表现就是"点了没反应 / 换不了"（实测那条会话当时正有一轮在跑，
      控制台里是 `Wait for the active turn … to finish`）。
      说清楚比悄悄杀掉一轮好 —— 那一轮的产出没了是不可逆的。
    */
    /*
      **换项目只是改个标签，不该被一轮跑着的对话卡住** ——「为什么远程 session 换不了 project」。

      上一版在 busy 时直接拒绝（因为 `detachExecutor` 无条件、会把那一轮连根拔掉），结果一条长回合
      跑着的时候就完全动不了 —— 而那正是你最想整理侧栏的时候。
      现在：**记录立刻改**（分组马上就对），只把"重置执行器"这一步推迟到这一轮结束。
      代价是这一轮剩下的部分仍用旧的 memory scope —— 它已经跑了一半，换 scope 反而更怪。
    */
    const busy = !!sessionClients.get(sessionId)?.busy;
    const rec = store.readRecord(sessionId);
    if (rec) {
      rec.profile.projectId = projectId ?? undefined;
      if (projectId) delete rec.profile.unassigned; else rec.profile.unassigned = true;
      rec.archived = false; // moving a chat brings it out of the archive
      rec.placementChangedAt = Date.now(); // 多台机器之间位置按它跟随（placementToFollow）
      store.writeRecord(rec);
    }
    if (busy) {
      /* 这一轮结束再重置：`pendingProjectReset` 由 prompt 的收尾去消化 */
      pendingProjectReset.add(sessionId);
      sessionNotice(sessionId, `📁 项目已改为**${projectId || '未分组'}**。这一轮还在跑，`
        + `所以执行器（memory scope）会在它结束之后再重置 —— 这一轮剩下的部分仍用原来的范围。`);
      logger.info('session', `移动项目 sessionId=${sessionId} -> ${projectId || '(未分组)'}（执行器重置推迟到本轮结束）`);
      return { sessionId, projectId: projectId ?? null, deferredReset: true };
    }
    detachExecutor(sessionId); // executor reset -> fresh memory scope on re-attach
    return { sessionId, projectId: projectId ?? null };
  });

  // Expose the auto-sized executor cap so the renderer warms the right number
  // of sessions at startup (instead of a hardcoded count).
  ipcMain.handle('acp:get-executor-cap', async () => MAX_CONCURRENT_SESSIONS);

  // Helper (background chore) models: chat titles + prompt suggestions. Exposed in
  // Settings so a throttled/retired helper model can be swapped without a rebuild.
  // Last browsed workspace directory. GLOBAL and stored in ~/.kirolex/config.json
  // rather than localStorage: it is a single app-wide preference, and this
  // project has already lost localStorage state when the origin changed.
  ipcMain.handle('app:get-workspace-dir', () => {
    try {
      const cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'));
      const dir = String(cfg?.lastWorkspaceDir || '').trim();
      if (!dir) { logger.info('workspace', 'no remembered dir yet -> panel will open at its default'); return null; }
      if (fs.existsSync(dir)) { logger.info('workspace', `remembered dir: ${dir}`); return dir; }
      // The directory is gone (deleted, renamed, unmounted). Walk UP to the nearest
      // ancestor that still exists instead of dropping the user back at home: being
      // one level above where you were is far closer to "where I was" than $HOME.
      let up = path.dirname(dir);
      while (up !== path.dirname(up) && !fs.existsSync(up)) up = path.dirname(up);
      const fallback = fs.existsSync(up) ? up : null;
      logger.info('workspace', `remembered dir is gone (${dir}) -> nearest existing ancestor: ${fallback || '<none>'}`);
      return fallback;
    } catch { return null; }
  });
  ipcMain.handle('app:set-workspace-dir', (_event, dir: string) => {
    try {
      let cfg: any = {};
      try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
      cfg.lastWorkspaceDir = String(dir || '').trim();
      const tmp = `${KIROLEX_CONFIG_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      fs.renameSync(tmp, KIROLEX_CONFIG_PATH);
      return { ok: true };
    } catch (error: any) {
      // A silent failure here means the directory is remembered for this run only
      // and is gone after a restart, with nothing anywhere saying why.
      logger.warn('workspace', `failed to remember dir ${dir}: ${error?.message || error}`);
      return { ok: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('app:get-helper-models', async () => {
    const { model, fallback } = loadHelperModels();
    return { model, fallback, defaults: { model: DEFAULT_HELPER_MODEL, fallback: DEFAULT_HELPER_FALLBACK_MODEL } };
  });
  ipcMain.handle('app:set-helper-models', async (_event, model: string, fallback: string) => {
    saveHelperModels(model, fallback);
    const saved = loadHelperModels();
    logger.info('helper-models', `primary='${saved.model}' fallback='${saved.fallback || '(none)'}'`);
    return saved;
  });
  // Report the auto-computed cap + whether an override is active (for Settings UI).
  ipcMain.handle('app:get-executor-cap-info', async () => ({
    cap: MAX_CONCURRENT_SESSIONS,
    auto: MAX_CONCURRENT_SESSIONS_AUTO,
    overridden: loadExecutorCapOverride() > 0,
  }));
  // Set a persisted cap override (0 = revert to auto). Applies live.
  ipcMain.handle('app:set-executor-cap', async (_event, n: number) => {
    saveExecutorCapOverride(n);
    MAX_CONCURRENT_SESSIONS = (n > 0 ? Math.max(1, Math.min(64, Math.floor(n))) : MAX_CONCURRENT_SESSIONS_AUTO);
    return { ok: true, cap: MAX_CONCURRENT_SESSIONS };
  });

  ipcMain.handle('app:get-wedge-timeout', async () => ({
    seconds: Math.round(WEDGE_CONFIRM_MS / 1000),
    default: WEDGE_CONFIRM_SECONDS_DEFAULT,
    min: WEDGE_CONFIRM_SECONDS_MIN,
    max: WEDGE_CONFIRM_SECONDS_MAX,
  }));
  // 0 turns the wedge interrupt off (the advisory quiet notice stays). Applies live:
  // the watchdog reads WEDGE_CONFIRM_MS on every tick, so in-flight turns pick it up.
  ipcMain.handle('app:set-wedge-timeout', async (_event, n: number) => {
    saveWedgeConfirmSeconds(n);
    WEDGE_CONFIRM_MS = loadWedgeConfirmSeconds() * 1000;
    logger.info('features', `wedge interrupt threshold = ${WEDGE_CONFIRM_MS ? `${WEDGE_CONFIRM_MS / 1000}s` : 'off'}`);
    return { ok: true, seconds: Math.round(WEDGE_CONFIRM_MS / 1000) };
  });

  ipcMain.handle('app:get-tool-stall-timeout', async () => ({
    seconds: Math.round(TOOL_STALL_MS / 1000),
    default: TOOL_STALL_SECONDS_DEFAULT,
    min: TOOL_STALL_SECONDS_MIN,
    max: TOOL_STALL_SECONDS_MAX,
  }));
  ipcMain.handle('app:set-tool-stall-timeout', async (_event, n: number) => {
    saveToolStallSeconds(n);
    TOOL_STALL_MS = loadToolStallSeconds() * 1000;
    logger.info('features', `tool stall bound = ${TOOL_STALL_MS / 1000}s`);
    return { ok: true, seconds: Math.round(TOOL_STALL_MS / 1000) };
  });

  // Archive / unarchive a session. Archiving hides it from the main list and
  // frees its executor slot (a later unarchive/open re-attaches transparently);
  // the durable transcript + memory are untouched. Not a delete.
  ipcMain.handle('acp:archive-session', async (_event, sessionId: string, archived: boolean) => {
    const rec = store.readRecord(sessionId);
    if (rec) {
      rec.archived = !!archived;
      rec.placementChangedAt = Date.now(); // 多台机器之间位置按它跟随（placementToFollow）
      /*
        **归档不再抹掉项目绑定** ——「可是你现在所有的 archive 会话都显示在未分组中」。

        原来这里是 `if (archived) rec.profile.projectId = undefined`，理由写的是
        "归档期间不带项目记忆"。那个理由**已经被别的守卫满足了**：归档会话发不了消息
        （ChatArea 把输入框换成「unarchive it to continue chatting」横幅，而 `acp:prompt`
        下面也会拒），而项目记忆只在 prompt 时注入 —— 所以抹这个字段防不住任何事。

        它的代价却是实打实的两条：
          · 备份界面按项目分组时，**所有**归档会话都掉进「未分组」；
          · 取消归档回不到原来的项目（老注释自己写着 returns it to the Unassigned
            bucket）—— 那不是设计，那是绑定被销毁之后唯一还能做的事。

        而且这个代价是**不可逆**的：记录里没有别的地方记着这个对应关系，`localDir`
        同时也被清掉了。实测 14 条历史归档会话里只有 2 条能从两个月前的记录备份里找回来。
      */
      store.writeRecord(rec);
    }
    if (archived) detachExecutor(sessionId); // give the warm slot back
    return { sessionId, archived: !!archived };
  });

  // Delete a project's memory directory (project deletion).
  ipcMain.handle('acp:delete-project-memory', async (_event, projectId: string) => {
    deleteProjectMemory(projectId);
    return { projectId };
  });

  // Memory editor UI: read/write layered memory.
  // Authoritative transcript read (design §4): the durable, uncapped,
  // per-KiroLex-id record. Used by cross-session context sync so it works for
  // chats beyond the renderer's 20-session cache and survives restart.
  // Pasted TEXT blobs live on disk, mirroring how pasted images already work: the
  // composer keeps only a `[ 粘贴 #N · M 行 ]` placeholder, the bytes go to a file.
  // NOT under ~/.kirolex/pasted (that whole directory is wiped on every boot for
  // image temp files) — a paste file is PRIMARY data: the transcript stores the
  // placeholder, so losing the file would lose the message's real content.
  ipcMain.handle('app:save-paste-text', (_event, text: string) => {
    try {
      const body = String(text ?? '');
      if (!body) return null;
      const dir = path.join(os.homedir(), '.kirolex', 'pastes');
      fs.mkdirSync(dir, { recursive: true });
      const name = `paste_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`;
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, body, 'utf-8');
      return {
        path: filePath,
        lines: body.split('\n').length,
        chars: body.length,
        preview: body.slice(0, 200),
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle('app:get-auto-resent', () => loadAutoResent());
  ipcMain.handle('app:set-auto-resent', (_event, sessionId: string, key: string) => {
    if (!sessionId) return { ok: false };
    const map = loadAutoResent();
    if (key) map[sessionId] = String(key); else delete map[sessionId];
    saveAutoResent(map);
    return { ok: true };
  });

  ipcMain.handle('app:get-draft-pastes', () => loadDraftPastes());
  ipcMain.handle('app:set-draft-pastes', (_event, sessionId: string, blocks: any[]) => {
    if (!sessionId) return { ok: false };
    const map = loadDraftPastes();
    if (Array.isArray(blocks) && blocks.length) {
      map[sessionId] = blocks.map((b: any) => ({
        seq: Number(b?.seq) || 0,
        lines: Number(b?.lines) || 0,
        chars: Number(b?.chars) || 0,
        path: String(b?.path || ''),
      })).filter((b: any) => b.path);
    } else {
      delete map[sessionId];
    }
    saveDraftPastes(map);
    return { ok: true };
  });

  ipcMain.handle('app:read-paste', (_event, filePath: string) => {
    try {
      const dir = path.join(os.homedir(), '.kirolex', 'pastes');
      const resolved = path.resolve(String(filePath || ''));
      // Confine reads to the paste directory: this path comes from persisted
      // message metadata, so it must never be able to read arbitrary files.
      if (!resolved.startsWith(dir + path.sep)) return null;
      return fs.readFileSync(resolved, 'utf-8');
    } catch {
      return null;
    }
  });

  ipcMain.handle('acp:read-transcript', async (_event, sessionId: string) => {
    return store.readTranscript(sessionId);
  });

  ipcMain.handle('acp:truncate-transcript-before', async (
    _event,
    sessionId: string,
    messageId: string,
  ) => store.truncateTranscriptBefore(sessionId, messageId));

  // Rewrite the transcript to exactly the given messages (edit-and-rerun). Robust
  // against renderer messages that were never persisted under that id (steers).
  ipcMain.handle('acp:rewrite-transcript', async (
    _event,
    sessionId: string,
    messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: store.StoredToolCall[] }>,
  ) => {
    const next = Array.isArray(messages) ? messages : [];
    /*
      **保留的消息必须本来就是这条会话的** ——「有的会话似乎内容混了」。
      重跑 / 打断后覆盖都是"保留前面一段、丢掉后面"，所以 next 里的消息 id 一定出现在现有 transcript 里。
      一条都对不上，说明渲染层传来的是**别的会话**的消息（切会话那一拍的缓存错配，见 useAcp 的
      messagesOwner）—— 照写就是把这条会话的历史整份换成别人的。拒绝，留下现状。
    */
    const existing = store.readTranscript(sessionId);
    if (existing.length && next.length) {
      const have = new Set(existing.map((m) => m.id));
      const known = next.filter((m) => have.has(m.id)).length;
      if (known === 0) {
        logger.error('session', `拒绝重写 transcript sessionId=${sessionId}：要保留的 ${next.length} 条消息一条都不在这条会话里`
          + `（现有 ${existing.length} 条）—— 多半是别的会话的消息，照写会把它的历史换掉`);
        return { ok: false, error: '要保留的消息不属于这条会话，没有重写（防止把别的会话的内容写进来）。' };
      }
    }
    store.rewriteTranscript(sessionId, next);
    return { ok: true };
  });

  // Durable session index (design §4): the on-disk record.json set is the
  // source of truth for which sessions exist. The renderer hydrates its sidebar
  // from this so an origin change (dev port drift) or a cleared localStorage can
  // never make sessions "disappear" — the transcripts on disk are intact.
  ipcMain.handle('acp:list-durable-sessions', async () => {
    // Hydrate: the renderer asking for the session list is the START of its own
    // work, so this mark separates "renderer booting" from "renderer hydrating".
    startupMark('hydrate: list-durable-sessions requested');
    const tombstoned = new Set([...loadSessionTombstones(), ...deletedSessionIds]);
    return store.listSessions().filter((rec) => !tombstoned.has(rec.id)).map((rec) => ({
      id: rec.id,
      title: rec.title,
      projectId: rec.profile?.projectId,
      model: rec.profile?.model,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      archived: !!rec.archived,
      pinned: !!rec.pinned,
      // 持久化的角色标记：删除保护和「别回收主会话」都要靠它，重启后必须还在
      ...(rec.purpose ? { purpose: rec.purpose } : null),
      ...(rec.flow ? { flow: rec.flow } : null),
      /**
       * 这条会话跑在哪个 agent 下 —— 记录里一直有（`profile.kiroAgent`），但从来没发给渲染层。
       *
       * `Session.kiroAgent` 因此只在你**手动切 agent** 时才有值，别的时候都是 undefined。撞到的后果：
       * 泳道复用要比 agent（会话的 agent 创建时就定了，换不了），比到的永远是 undefined，于是
       * 一个配了 agent 的 flow **每一步都另起一条会话** —— 复用被静默禁掉，而没有任何报错。
       */
      ...(rec.profile?.kiroAgent ? { kiroAgent: rec.profile.kiroAgent } : null),
      /* 哪个引擎（Claude Code / Codex）—— 侧栏 tag 和"藏掉 kiro 的模型/agent 下拉"都靠它 */
      ...(rec.profile?.engine ? { engine: rec.profile.engine } : null),
      /**
       * **这条会话跑在哪台机器上** —— 远程会话（`docs/DESIGN_remote_sessions.md`）。
       *
       * 侧栏要常驻一个徽标：任何时候都不该去猜"这一轮是在哪台机器上跑的"。发的是**给人看的名字**
       * （不是整串 `user@host`），因为徽标的位置只有几个字。
       */
      ...(rec.profile?.remote?.sshHost
        ? { remoteHost: labelForHost(KIROLEX_CONFIG_PATH, rec.profile.remote.sshHost) }
        : null),
      /**
       * **这条会话在哪棵树上干活** ——「工作目录这个东西放到右侧会话」。
       *
       * 会话界面上要常驻显示它，所以它必须跟着会话状态一起过来。记录里一直有
       * （`SessionRecord.localDir`，磁盘为准），只是从来没发给渲染层 —— 而"它读哪个目录"
       * 恰恰是远程会话最容易搞错的一件事（远端只看得见被镜像的那一个目录）。
       */
      ...(rec.localDir ? { localDir: rec.localDir } : null),
    }));
  });

  /**
   * 把「这个会话是干什么的」写进记录 —— `flow-main` 的删除保护靠它，所以不能只活在 renderer 内存里。
   *
   * **等记录出现再写** —— 实测这个标记从来没写成功过:全部 11 份日志里 `[session] purpose` 出现 0 次,而
   * `~/.kirolex/sessions/s_1786935225555_jpec0z/record.json` 里 purpose 是空的。原因是调用时机:renderer 在
   * `newSession` 一返回就标记,那时记录还没落盘,`readRecord` 给 null,这里就 `return { ok:false }` 走了 ——
   * 而调用方是 `void`,没人看返回值,所以是**静默**丢失。后果一路传到分屏:purpose 没了,「flow 会话不进分屏」
   * 的判据就失效,自动 seed / 领养那两条效果照样把它塞进格子(改名同理,标题兜底也一起没了)。
   *
   * **等不是办法，挂起才是** —— 上一版让这里轮询 2 秒，方向就错了：记录不是「晚一点写」，而是**第一次 prompt
   * 才创建**。实测同一条会话：`03:53:54 purpose LOST … 等了 2s` → `03:53:59 prompt received`（记录此刻才有）。
   * 所以改成 `patchRecord`：记录在就直接写，不在就挂起，`createSession` 一建记录立刻应用。
   */
  ipcMain.handle('acp:mark-session-purpose', async (_event, sessionId: string, purpose: string, flow?: string) => {
    if (!sessionId) return { ok: false, error: 'no sessionId' };
    const patch: Partial<ReturnType<typeof store.readRecord> & object> = {
      purpose: (purpose || '').trim() || undefined,
    };
    if (flow !== undefined) (patch as any).flow = (flow || '').trim() || undefined;
    const where = store.patchRecord(sessionId, patch as any);
    logger.info('session', `purpose ${sessionId} = ${(purpose || '').trim() || '(cleared)'}${flow ? ' flow=' + flow : ''} (${where})`);
    return { ok: true, deferred: where === 'pending' };
  });

  /**
   * 会话标题落盘 —— 「这个 project 里面还是有一条没用的 new chat」的一半原因。
   *
   * `renameSession` 一直**只改渲染层内存**（`setSessions(... { ...s, title })`），主进程连一个改标题的
   * IPC 都没有。于是标题一刷新就退回磁盘上的 `New Chat` —— 实测 SFDC 那个 project 下四条会话
   * （一条主会话 + 三条 worker）在磁盘上**全都叫 `New Chat`**，而侧栏上它们本来显示着步骤名。
   *
   * flow 起的会话尤其吃亏：它们的名字是驱动器现取的（`${flow} · ${步骤名}`），而一条没有名字的
   * 子会话在侧栏里就是"一条没用的 new chat"，你没法判断它属于谁、能不能动。
   *
   * 走 `patchRecord`（和 `acp:mark-session-purpose` 一样）：它能处理"记录还没建出来"的情况 ——
   * flow 的 worker 恰好就是这种，记录是第一次 prompt 才创建的，而改名发生在那之前。
   */
  ipcMain.handle('acp:rename-session', async (_event, sessionId: string, title: string) => {
    if (!sessionId) return { ok: false, error: 'no sessionId' };
    const next = String(title || '').trim();
    if (!next) return { ok: false, error: 'empty title' };
    const where = store.patchRecord(sessionId, { title: next } as any);
    logger.info('session', `renamed ${sessionId} -> ${JSON.stringify(next)} (${where})`);
    return { ok: true, deferred: where === 'pending' };
  });

  // Persist pin state to the durable record so it survives restart / origin
  // changes. Writes directly (no updatedAt bump) so pinning never reorders the list.
  ipcMain.handle('acp:set-session-pinned', async (_event, sessionId: string, pinned: boolean) => {
    const rec = store.readRecord(sessionId);
    if (rec) {
      rec.pinned = !!pinned;
      try {
        const p = path.join(os.homedir(), '.kirolex', 'sessions', sessionId, 'record.json');
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
        fs.renameSync(tmp, p);
      } catch { /* best-effort */ }
    }
    return { sessionId, pinned: !!pinned };
  });

  /** User-selectable features. Reading is cheap and uncached on purpose, so the
   *  Settings panel and every call site always agree on the live value. */
  /**
   * **可选的远端有哪些**（`docs/DESIGN_remote_sessions.md`）。
   *
   * flag 关着就返回空列表 —— 界面据此**完全不显示**目标选择，而不是显示一个选了会报错的选项。
   */
  ipcMain.handle('app:remote-targets', () => {
    /*
      **开关关着也要把已配的机器发出去** —— 原来这里直接回空列表，而「存」照样能存：于是设置页
      永远看不到你刚加的那台，每次回来都是一张空表，再加一次 —— 实测 config.json 里攒了
      aws-tokyo、aws-tokyo-2、-3、-4 四条同一个 IP。`enabled` 照旧带着，"能不能新建远程会话"
      由调用方看它（useRemoteTargets 关着时自己当空列表）。
    */
    return {
      enabled: isFeatureEnabled('remoteSessions'),
      /*
        **字段要发全** ——「我为什么选了密钥不生效」。这里原来只发 id/label/sshHost/remoteWorkdir，
        漏了 `identityFile` 和 `sshPort`：于是设置界面永远显示"没有选私钥"（明明配置里有），
        而自动保存又会把这份**缺字段**的草稿写回去 —— 等于每次编辑都在悄悄抹掉密钥和端口。
        投影列白名单的代价就是这个：漏一个字段不是少显示一行，是把它删掉。
      */
      targets: listRemoteTargets(KIROLEX_CONFIG_PATH).map((t) => ({
        id: t.id,
        label: t.label,
        sshHost: t.sshHost,
        sshPort: t.sshPort,
        identityFile: t.identityFile,
        proxyJump: t.proxyJump,
        remoteWorkdir: t.remoteWorkdir,
        /* 三个 CLI 的启动命令 —— 漏发一个字段 = 自动保存把它抹掉（见上面那段） */
        bins: t.bins,
        /* 设置页靠它决定默认显示哪一台（最近编辑的） */
        editedAt: t.editedAt,
        /* 密码只说"有没有"，密文和明文都不出主进程 */
        hasPassword: !!t.passwordCipher,
      })),
      /** 本机那份（和远端同样三个字段）——「不管是本地还是远程必须要配置」。 */
      localBins: localBins(KIROLEX_CONFIG_PATH),
      /** 本机工作目录（没展开的写法，默认 `~/kirolex`）—— 没归项目的本地会话在这里干活。 */
      localWorkdir: localWorkdirSetting(KIROLEX_CONFIG_PATH),
    };
  });

  /**
   * **自动检测那三个工具**（本机或某台远端）——「分别自动检测位置和启动命令、
   * 自动检测是否能正常启动、记住历史成功的启动命令」。
   *
   * 同一段脚本两台机器共用：本机 `bash -lc`，远端走 ssh。一份判据不会分叉 ——
   * 而"本地判一套、远端判另一套"正是那种查不出来的差异。
   */
  ipcMain.handle('bins:detect', async (_event, machine: string) => {
    try {
      /*
        **Windows 上的本机探测走 Node，不走 shell** —— `detectScript()` 是一段 POSIX shell,
        而 Windows 上没有 `bash`，原来这里直接 ENOENT：设置里那颗「自动检测」按钮是死的,
        而 `kiroBinProblem()` 在配好之前拒绝起任何会话 —— 也就是没有出路。见 `detectWindows`。

        远端那一半照旧走脚本（远端是 Linux），所以判据是"**本机**且在 Windows 上"。
      */
      const localWin = (!machine || machine === 'local') && process.platform === 'win32';
      const found = localWin
        ? await detectWindows(probeOneLocal)
        : parseDetect(await runProbe(machine, detectScript()));
      const hist = binHistory(KIROLEX_CONFIG_PATH)[machine] || {};
      /* 历史排前面并打上 known —— 一个真的起过会话的命令比"文件在这儿"可信得多 */
      const merged = {
        kiro: mergeHistory(found.kiro, hist.kiro),
        claude: mergeHistory(found.claude, hist.claude),
        codex: mergeHistory(found.codex, hist.codex),
      };
      logger.info('bins', `检测 ${machine}：kiro=${merged.kiro.length} claude=${merged.claude.length} codex=${merged.codex.length}`);
      return { ok: true, tools: merged };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  /** 测一条命令能不能起来（界面上那个「测试」）。 */
  ipcMain.handle('bins:test', async (_event, machine: string, command: string) => {
    if (!command?.trim()) return { ok: false, error: '没有给命令' };
    try {
      /*
        本机 + Windows：和「自动检测」同一个理由 —— `testScript()` 是 POSIX shell。
        这里多一步：填进来的可能是**裸名字**（`kiro-cli`），所以先在 PATH 上解析一次;
        解析不到就原样试（可能是个绝对路径，也可能确实不存在 —— 那时报错本身就是答案）。
      */
      if ((!machine || machine === 'local') && process.platform === 'win32') {
        const raw = command.trim();
        const onPath = raw.includes('/') || raw.includes('\\') ? [] : whichAll(raw);
        const target = onPath[0] || raw;
        const r = await probeOneLocal(target, '--version');
        return r.ok
          ? { ok: true, version: r.first.slice(0, 160) }
          : { ok: false, error: r.first.slice(0, 160) || '跑不起来' };
      }
      return parseTest(await runProbe(machine, testScript(command.trim())));
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  /**
   * 存本机那三个启动命令。
   *
   * 存完**立刻生效**（`setLocalKiroBin`）：不设的话要重启才算数，而"改了配置没反应"
   * 会让人以为配置项是假的。已经起着的执行器不动 —— 它绑在那个进程上，下次起才换。
   */
  /** 本机工作目录。新会话立刻用它；已经连着的会话下次重连才换（换目录 = 换执行器，不在这里偷偷做）。 */
  ipcMain.handle('local:save-workdir', (_event, dir: string) => {
    try {
      const saved = saveLocalWorkdir(KIROLEX_CONFIG_PATH, dir);
      logger.info('app', `本机工作目录：${saved}`);
      return { ok: true, dir: saved };
    } catch (err: any) {
      return { ok: false, error: err?.message || '保存失败' };
    }
  });

  ipcMain.handle('local:save-bins', (_event, bins: ExecutorBins) => {
    try {
      const saved = saveLocalBins(KIROLEX_CONFIG_PATH, bins || {});
      setLocalKiroBin(saved?.kiro);
      logger.info('app', `本机启动命令：kiro=${saved?.kiro || '(默认)'} claude=${saved?.claude || '(默认)'} codex=${saved?.codex || '(默认)'}`);
      return { ok: true, bins: saved };
    } catch (err: any) {
      return { ok: false, error: err?.message || '保存失败' };
    }
  });

  /** 这条会话当前的同步状态（界面重新挂载时问一次 —— 只靠事件会丢掉挂载之前的状态）。 */

  /*
    **在界面上加/改/删一台远端** ——「界面上甚至没有配置远程EC2的地方」。
    功能做出来了却只能手改 config.json，等于没有入口。写的时候只动 `remotes` 这一个键，
    而且是原子写（这是用户唯一的配置文件）。
  */
  ipcMain.handle('remote:save', (_event, input: RemoteTargetInput) => {
    try {
      /* 明文密码不往下传：saveRemoteTarget 只见密文 */
      const { password: _pw, clearPassword: _clr, ...rest } = input as any;
      const saved = saveRemoteTarget(KIROLEX_CONFIG_PATH, { ...rest, ...passwordFields(input) });
      logger.info('remote', `保存远端 ${saved.id} (${saved.sshHost})${saved.passwordCipher ? '，带密码' : ''}`);
      return { ok: true, target: { id: saved.id, label: saved.label, sshHost: saved.sshHost, sshPort: saved.sshPort, identityFile: saved.identityFile, proxyJump: saved.proxyJump, remoteWorkdir: saved.remoteWorkdir, bins: saved.bins, editedAt: saved.editedAt, hasPassword: !!saved.passwordCipher } };
    } catch (err: any) {
      return { ok: false, error: err?.message || '保存失败' };
    }
  });

  ipcMain.handle('remote:delete', (_event, id: string) => {
    /* 正在用这台机器的会话不受影响：它们的 remote 存在自己的 profile 里（按会话固定），
       删掉只是让它不再出现在"新建会话"的列表里。 */
    const gone = deleteRemoteTarget(KIROLEX_CONFIG_PATH, id);
    logger.info('remote', `删除远端 ${id} -> ${gone ? 'ok' : '不在列表里（可能是老 agents[].remote）'}`);
    return { ok: gone, error: gone ? undefined : '这一条不在可编辑的列表里（来自旧配置 agents[].remote，请手动删除）' };
  });

  /**
   * **测试连接** —— 把 `remotePreflight` 的判定直接给人看。
   *
   * 这是那三句话该出现的地方：连不上（网络/密钥）、缺 rsync/git（跑一次预置脚本）、
   * 没登录（去远端 `kiro-cli login`）。在这里看到，比建完会话才发现好得多。
   */
  /**
   * **一个按钮把远端装齐** —— 「我让你加一个按钮给这台远程机器跑个脚本装 kiro-cli claude code codex
   * 还有其他依赖项」。
   *
   * 做法：把 `scripts/remote-bootstrap.sh` 推上去（`cat | bash -s` 而不是 scp —— 少一次往返，
   * 也不在对方磁盘上留文件），然后**边跑边把输出发给界面**。装东西可能要几分钟（kiro-cli 那个包
   * 几百 MB），中间一个字都不给看的话，人只会以为卡死了。
   *
   * 这是"在别人机器上装东西"，所以它只在**你按下按钮**时发生：没有任何自动触发的路径。
   */
  ipcMain.handle('remote:bootstrap', async (event, input: RemoteTargetInput & { force?: boolean }) => {
    const why = validateTarget(input);
    if (why) return { ok: false, error: why };
    const target = {
      sshHost: String(input.sshHost).trim(),
      sshPort: Number(input.sshPort) > 0 ? Number(input.sshPort) : 22,
      identityFile: input.identityFile ? expandHome(String(input.identityFile)) : undefined,
      proxyJump: input.proxyJump ? String(input.proxyJump).trim() : undefined,
      passwordCipher: passwordCipherForUse(input),
    } as RemoteTarget;
    /* 脚本跟着 app 走：dev 下在仓库里，打包后在 resources 里 */
    const candidates = [
      path.join(app.getAppPath(), 'scripts', 'remote-bootstrap.sh'),
      path.join(process.resourcesPath || '', 'scripts', 'remote-bootstrap.sh'),
      path.join(__dirname, '..', '..', 'scripts', 'remote-bootstrap.sh'),
    ];
    const scriptPath = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (!scriptPath) return { ok: false, error: '找不到 remote-bootstrap.sh（应该在 app 的 scripts/ 下）' };
    const script = fs.readFileSync(scriptPath, 'utf-8');

    const send = (chunk: string) => {
      try { event.sender.send('remote:bootstrap-output', { sshHost: target.sshHost, chunk }); } catch {}
    };
    /*
      **脚本落到远端的临时文件再跑，不用 `bash -s`** —— 实测踩过：脚本从 stdin 进去的时候，
      脚本里任何**读 stdin 的命令**都会把剩下的脚本吃掉。`claude-code-acp --version` 就是这种
      （它是个 stdio 上的 ACP 服务），于是自检那一整段从来没跑过，而退出码还是 0 ——
      "看起来成功了，其实少做了一半"。落成文件之后 stdin 是干净的，跑完就删。
    */
    const remoteTmp = `/tmp/kirolex-bootstrap-${Date.now()}.sh`;
    /*
      **把本机 kiro-cli 默认 agent 的 web search MCP 也带过去** ——「把这个 mcp 也装到这个
      claude code 上面」。端点是这个账号自己的网关地址，所以**不写进脚本**：从本机实际在跑的那份
    */
    /*
      **登录参数也从本机读**（和 MCP 端点同一个道理）：远端没有浏览器，走 device flow 需要
      `--identity-provider` 和 `--region`，而这两个值是这个账号自己的，不写进仓库。
      本机已经登录，`kiro-cli whoami` 的输出里就有（start URL + profile ARN 里的 region）。
    */
    let loginEnvStr = '';
    try {
      const cli = resolveKiroCli();
      if (!cli) throw new Error('本机找不到 kiro-cli');
      /*
        **不要用 `shellQuote` 走 shell** ——「看一下有没有 windows 上不能跑的东西」。
        `shellQuote` 包的是 POSIX 单引号，而 `execSync` 在 Windows 上走 cmd.exe ——
        那边 `'…'` 不是引号，于是命令变成字面的 `'C:\…\kiro-cli.exe' whoami` 然后失败。
        失败被下面的 catch 吞掉，表现是 bootstrap **静默丢掉登录参数**，
        远端装好了却没登录，而日志里只有一句"没读到本机的登录参数"。

        `execFileSync` 不经过 shell：参数按数组传，两个平台都不需要引号。
        （下面那个 `loginEnvStr` 仍然用 `shellQuote` —— 它是拼给**远端 bash** 的，那是对的。）
      */
      const who = execFileSync(cli, ['whoami'], { encoding: 'utf8', timeout: 20_000 });
      const env = loginEnv(parseWhoami(who));
      loginEnvStr = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)} `).join('');
      if (loginEnvStr) logger.info('remote', `bootstrap 会带上登录参数（${env.KIRO_LOGIN_PROVIDER}）`);
      else logger.info('remote', 'bootstrap 没读到本机的登录参数 —— 远端没登录时只会提示');
    } catch { /* 读不到就只提示，不猜 */ }
    const args = buildSshArgs(
      target,
      `cat > ${remoteTmp} && ${loginEnvStr}FORCE=${input.force ? 1 : 0} bash ${remoteTmp}; rc=$?; rm -f ${remoteTmp}; exit $rc`,
    );
    logger.info('remote', `bootstrap 开始 ${target.sshHost}${input.force ? '（强制重装）' : ''}`);
    return await new Promise<{ ok: boolean; code: number | null; error?: string }>((resolve) => {
      const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnv(target) });
      let tail = '';
      const onData = (b: Buffer) => {
        const t = b.toString('utf-8');
        tail = (tail + t).slice(-4000);
        send(t);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      /* 脚本从 stdin 进去：不在对方磁盘上留文件，也少一次 scp 往返 */
      child.stdin.write(script);
      child.stdin.end();
      /* 15 分钟：kiro-cli 那个 zip 几百 MB，npm 装三个包也要几分钟 */
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 15 * 60 * 1000);
      child.on('error', (err) => {
        clearTimeout(killer);
        resolve({ ok: false, code: null, error: err?.message || 'ssh 起不来' });
      });
      child.on('close', (code) => {
        clearTimeout(killer);
        logger.info('remote', `bootstrap 结束 ${target.sshHost} code=${code}`);
        resolve({
          ok: code === 0,
          code,
          /* 失败时把最后一段输出带回去：自检那几行就在里面，比一句 exit 1 有用得多 */
          error: code === 0 ? undefined : (tail.trim().split('\n').slice(-6).join('\n') || `退出码 ${code}`),
        });
      });
    });
  });

  /**
   * **用 Finder 选私钥** ——「我是需要能到 finder 里面去找到密钥文件而不是还得自己写路径」。
   *
   * 手写路径的代价不是麻烦，是**错了看不出来**：路径少一个字母，表现是 SSH 认证失败，
   * 跟"机器没开"、"安全组没放行"长得一模一样。
   *
   * `showHiddenFiles`：密钥通常在 `~/.ssh` 里，而那是个隐藏目录 —— 不给这个选项，
   * 对话框打开之后你在 Finder 里根本看不到它。默认目录也直接指到 `~/.ssh`。
   */
  /** 选一个项目目录（切到远端时要指定要镜像的那个目录）。 */
  ipcMain.handle('remote:pick-dir', async () => {
    const options = {
      title: '选择要在远端镜像的项目目录',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { path: '' };
    return { path: result.filePaths[0] };
  });

  ipcMain.handle('remote:pick-key', async () => {
    const sshDir = path.join(os.homedir(), '.ssh');
    const options = {
      title: '选择 SSH 私钥',
      defaultPath: fs.existsSync(sshDir) ? sshDir : os.homedir(),
      properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'] as Array<'openFile' | 'showHiddenFiles' | 'dontAddToRecent'>,
      /* `.pem` 单列一项（EC2 给的就是它），但保留"所有文件"—— `id_rsa` 这类根本没有后缀 */
      filters: [
        { name: '私钥', extensions: ['pem', 'key', 'cer'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { path: '' };
    return { path: result.filePaths[0] };
  });

  /**
   * **两边的 kiro-cli 各是什么版本** ——「怎么控制远端的版本呢？本地现在是什么版本？」。
   *
   * 版本差不是"数字不一样"这么轻：实测远端停在 1.27.0、本机 2.24.1，而 1.27.0 **没有**
   * `--list-models`，所以那台机器的模型清单只能靠"故意传个错模型、从参数校验的报错里抠 id",
   * 倍率只能拿本机那份去补 —— 本机清单又被地域过滤（一个 Claude 都没有），
   * 于是 `claude-opus-5.5` 彻底没有倍率。更新到 2.24.1 之后它自己就报 2.00x 了。
   *
   * 远端那个值取 preflight 顺路带回来的（不额外开一次 ssh）；没探过就是 undefined，
   * 而 `undefined` 的含义是"不知道"，不是"旧"—— 界面据此不该显示"落后"。
   */
  ipcMain.handle('kiro:versions', async (_event, machine?: string) => {
    const local = await localKiroVersion();
    if (!machine || machine === 'local') return { ok: true, local };
    const target = findRemoteTarget(KIROLEX_CONFIG_PATH, machine);
    if (!target?.sshHost) return { ok: false, error: `找不到这台机器（${machine}）` };
    const remote = remoteKiroVersions.get(target.sshHost);
    return { ok: true, local, remote, outdated: isOlderVersion(remote, local) };
  });

  /**
   * **更新那台机器上的 kiro-cli**（`kiro-cli update -y`）。
   *
   * 两件事是刻意的：
   *
   * 1. **有会话连着就先说清，不偷偷换**。那个二进制被这台机器上**所有**执行器握着 ——
   *    换掉之后正在跑的不会当场死，但下一次 attach / 换模型就是新版本了，而新版本可能改行为。
   *    所以默认拦住并说出有几条会话在用；`force` 只在人看过那句话之后才会传过来。
   * 2. **报出前后两个版本号**。"更新成功了"这句话本身不含信息 —— 实测有价值的正是
   *    `1.27.0 → 2.24.1` 这一对（它解释了为什么倍率突然有了）。
   */
  ipcMain.handle('kiro:update', async (_event, machine: string, force?: boolean) => {
    const pick = (t: string): string | undefined => /(\d+\.\d+\.\d+)/.exec(String(t || ''))?.[1];
    const local = !machine || machine === 'local';

    /*
      **本机那条也一样要拦** ——「本地的版本你也帮忙看一下，做个类似的功能」。
      本机的二进制被本地会话的执行器握着，而且 KiroLex 自己问模型清单 / agent 列表
      也在跑它。所以判据一样：有几条在用就说几条，人确认过再换。
    */
    const inUse = local
      ? [...sessionClients.values()].filter((e) => !e.profile.remote?.sshHost).length
      : 0;
    let target: RemoteTarget | undefined;
    let bin = '';
    if (!local) {
      target = findRemoteTarget(KIROLEX_CONFIG_PATH, machine);
      if (!target?.sshHost) return { ok: false, error: `找不到这台机器（${machine}）` };
      bin = remoteKiroBin(target) || '';
      if (!bin) return { ok: false, error: `还没有设置 ${target.sshHost} 上的 kiro 启动命令。` };
    }
    const remoteInUse = target
      ? [...sessionClients.values()].filter((e) => e.profile.remote?.sshHost === target!.sshHost).length
      : 0;
    const busy = local ? inUse : remoteInUse;
    if (busy && !force) {
      return {
        ok: false, needsConfirm: true, inUse: busy,
        error: `${local ? '本机' : target!.sshHost} 上还有 ${busy} 条会话连着。`
          + `更新会把它们正在用的那个二进制换掉 —— 正在跑的那一轮不会当场死，`
          + `但下一次重连/换模型就是新版本了，而新版本可能改行为。要继续就再点一次。`,
      };
    }
    try {
      let from: string | undefined;
      let to: string | undefined;
      let log = '';
      if (local) {
        from = await localKiroVersion();
        /* `-y`：非交互。超时给足 —— 它要下载一个几十 MB 的二进制 */
        log = String(await runKiroCli('update -y', 600_000)).trim().slice(-1200);
        /* 缓存必须失效，否则界面上还是旧的那个号 */
        localKiroVersionCache = undefined;
        to = await localKiroVersion();
        logger.info('remote', `本机 kiro-cli ${from || '?'} → ${to || '?'}`);
      } else {
        const before = await runRemoteCapture(target!, `${shellQuote(bin)} --version 2>&1 | head -1`).catch(() => '');
        log = String(await runRemoteCapture(target!, `${shellQuote(bin)} update -y 2>&1 | tail -20`, 600_000)).trim().slice(-1200);
        const after = await runRemoteCapture(target!, `${shellQuote(bin)} --version 2>&1 | head -1`).catch(() => '');
        from = pick(before);
        to = pick(after);
        if (to) remoteKiroVersions.set(target!.sshHost, to);
        /* 版本变了就把"落后"那句话的记忆清掉，否则下次还会提醒 */
        if (to && !isOlderVersion(to, await localKiroVersion())) remoteVersionWarned.delete(target!.sshHost);
        logger.info('remote', `${target!.sshHost}: kiro-cli ${from || '?'} → ${to || '?'}`);
      }
      return { ok: true, from, to, changed: !!from && !!to && from !== to, log };
    } catch (err: any) {
      return { ok: false, error: `更新失败：${err?.message || err}` };
    }
  });

  ipcMain.handle('remote:test', async (_event, input: RemoteTargetInput) => {
    const why = validateTarget(input);
    if (why) return { ok: false, code: 'invalid', message: why };
    const target = {
      sshHost: String(input.sshHost).trim(),
      sshPort: Number(input.sshPort) > 0 ? Number(input.sshPort) : 22,
      identityFile: input.identityFile ? expandHome(String(input.identityFile)) : undefined,
      proxyJump: input.proxyJump ? String(input.proxyJump).trim() : undefined,
      remoteWorkdir: input.remoteWorkdir || undefined,
      passwordCipher: passwordCipherForUse(input),
    } as RemoteTarget;
    /* 「测试连接」不问模型列表 —— 那是最慢的一段，而它不改变"连不连得上"这个结论 */
    const args = buildSshArgs(target, `bash -lc ${shellQuote(preflightScript(undefined, { models: false }))}`);
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile('ssh', args, { timeout: 30_000, encoding: 'utf8', env: sshEnv(target) }, (err: any, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      }));
    });
    const verdict = judgePreflight(out.code, out.stdout, out.stderr, target);
    /*
      **「测试连接」通了就把熔断清掉** —— 否则你刚点完"通了"，紧接着打开会话还要空等一个
      20 秒的窗口（熔断记的是"刚才连不上"，而你手里这次探测正是更新的证据）。
      这条路自己拼 ssh、不走 `remotePreflight`，所以它天生不被熔断挡住 —— 那也是对的：
      熔断挡的是启动时一堆会话的瞬间并发，不是明确的人类意图。
    */
    if (verdict.code === 'ok') reachability.ok(target.sshHost || '');
    logger.info('remote', `test ${target.sshHost}: ${verdict.code}`);
    return { ok: verdict.code === 'ok', code: verdict.code, message: verdict.message, missing: verdict.missing };
  });

  ipcMain.handle('app:get-features', () => ({
    flags: loadFeatureFlags(),
    defaults: { ...FEATURE_DEFAULTS },
    /**
     * **kiro-cli 的 trace 日志开着吗** —— 「配置中未发现人为启用特殊日志级别」。
     *
     * 那个开关不在 kiro 的配置里，而在 KiroLex 侧（`~/.kirolex/kiro-trace`），所以查 kiro 的配置
     * 一定查不到；而它一开就是每秒几十 KB、一天十几 GB。开着的时候界面上原来**一个字都没有** ——
     * 一个悄无声息、代价按 GB 计的开关，忘了关就是磁盘被填满。所以状态跟着这份 payload 一起给出去，
     * 侧栏挂一个显眼的标记（`kiroTrace`）。
     */
    kiroTrace: kiroTraceEnabled(),
  }));
  /** 开/关 kiro-cli 的 trace 日志（标记文件；下一次起执行器生效）。 */
  ipcMain.handle('app:set-kiro-trace', (_event, enabled: boolean) => {
    const file = path.join(os.homedir(), '.kirolex', 'kiro-trace');
    try {
      if (enabled) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
      } else {
        fs.rmSync(file, { force: true });
      }
      logger.warn('logs', `kiro-cli trace 日志 -> ${enabled ? '开' : '关'}（下一次起执行器生效）`);
      return { ok: true, kiroTrace: kiroTraceEnabled() };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  });  ipcMain.handle('app:set-feature', (_event, key: string, enabled: boolean) => {
    if (!key || !(key in FEATURE_DEFAULTS)) return { ok: false, error: `unknown feature: ${key}` };
    return { ok: true, flags: saveFeatureFlag(key, !!enabled) };
  });

  /** The EXACT block that would be injected on the next message, assembled from the
   *  same pure function the send path uses — so the preview cannot drift from reality.
   *  Injection was otherwise invisible: the record keeps only a char count, leaving no
   *  way to check what the model was actually told. */
  /** What the last send ACTUALLY carried, read back from the archive written at send
   *  time. Deliberately not re-derived: rebuilding the snapshot now would describe the
   *  current transcript, not the one this session was primed with. */
  ipcMain.handle('acp:read-last-injection', async (_event, sessionId?: string) => {
    if (!sessionId) return { text: '', at: null, path: null, override: false, overrideAt: null, overridePath: null };
    const rec = store.readLastInjection(sessionId);
    // The override is reported alongside, because the Snapshot tab has to say WHICH of
    // the two will actually be sent next -- an editor that silently shows the archive
    // while a curated block is in force would be the worst of both.
    const override = store.readContextOverride(sessionId);
    return {
      text: override?.text ?? rec?.text ?? '',
      at: rec?.at ?? null,
      path: store.lastInjectionPath(sessionId),
      override: !!override,
      overrideAt: override?.at ?? null,
      overridePath: store.contextOverridePath(sessionId),
      /** The archive, always -- so "restore the generated one" can show what it will
       *  go back to without a second round trip. */
      sentText: rec?.text ?? '',
    };
  });

  /** Pin a hand-edited context block for this chat. Used verbatim by the next send. */
  ipcMain.handle('acp:write-context-override', async (_event, sessionId: string, text: string) => {
    if (!sessionId) return { ok: false, error: 'no sessionId' };
    try {
      if (!text.trim()) {
        // Saving an empty editor means "stop overriding", not "send nothing".
        const cleared = store.clearContextOverride(sessionId);
        logger.info('prime', `context override cleared by empty save sessionId=${sessionId} existed=${cleared}`);
        return { ok: true, override: false };
      }
      store.writeContextOverride(sessionId, text);
      logger.info('prime', `context override SAVED sessionId=${sessionId} chars=${text.length} -> next message sends this instead of the generated snapshot`);
      return { ok: true, override: true, path: store.contextOverridePath(sessionId) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'failed' };
    }
  });

  /** Back to the generated snapshot. */
  ipcMain.handle('acp:clear-context-override', async (_event, sessionId: string) => {
    if (!sessionId) return { ok: false, error: 'no sessionId' };
    const existed = store.clearContextOverride(sessionId);
    logger.info('prime', `context override removed sessionId=${sessionId} existed=${existed} -> generated snapshot again`);
    return { ok: true, existed };
  });

  ipcMain.handle('acp:read-memory', async (_event, projectId?: string, sessionId?: string) => {
    return readMemory(projectId, sessionId);
  });  ipcMain.handle('acp:write-memory', async (_event, scope: 'global' | 'project' | 'session', projectId: string | undefined, sessionId: string | undefined, content: string) => {
    writeMemory(scope, projectId, sessionId, content);
    return { ok: true };
  });

  /** 三层体积，按需取一次。给两个时机用：会话切换/启动（打开就能看到横幅），以及
   *  MemoryDialog 保存之后（你手动清理完立刻消失，不用等下一轮对话）。 */
  ipcMain.handle('acp:memory-bytes', async (_event, projectId?: string, sessionId?: string) => {
    return memoryLayerBytes(projectId, sessionId);
  });

  /** 压缩前备份某一层记忆。时间戳由主进程生成，渲染进程不需要关心命名规则。 */
  ipcMain.handle('acp:backup-memory', async (
    _event, scope: MemoryScope, projectId?: string, sessionId?: string,
  ) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const at = backupMemoryLayer(scope, projectId, sessionId, stamp);
    if (at) logger.info('memory', `backed up ${scope} -> ${at}`);
    else logger.warn('memory', `nothing to back up for scope=${scope}`);
    return { ok: !!at, at };
  });
});

/** Shared UI state. Registered OUTSIDE the app-ready IPC block because preload
 *  asks for it synchronously while the window is being created. */
ipcMain.on('app:ui-state-all', (event) => {
  event.returnValue = uiState();
});
ipcMain.on('app:ui-state-set', (_event, key: string, value: string | null) => {
  const isNew = value !== null && !Object.prototype.hasOwnProperty.call(uiState(), key);
  setUiStateKey(key, value);
  // Logged on first sight so a migration from the old per-origin localStorage is
  // observable rather than assumed.
  if (isNew) logger.info('ui-state', `adopted key=${key} chars=${String(value).length} -> ${UI_STATE_PATH}`);
});

/** One-time migration of the UI state out of the origin-scoped localStorage.
 *
 *  The real, current values live in the `file://` origin (a normal start). Dev mode
 *  runs on `http://localhost:5173`, whose localStorage holds a STALE copy from
 *  whenever dev last ran -- so dev must never seed the shared store from its own
 *  localStorage, and it also cannot read the good one directly.
 *
 *  So: open a hidden, EMPTY page on the file:// origin and read the keys from
 *  there. An empty page is used deliberately rather than the real index.html --
 *  loading the app again would boot a second renderer and attach every session.
 *
 *  Runs only while the shared store is still empty, i.e. exactly once, and it means
 *  `npm run dev:hot` needs no preparatory production launch. */
async function migrateUiStateFromFileOrigin(): Promise<void> {
  if (Object.keys(uiState()).length > 0) return;
  const htmlPath = path.join(__dirname, '..', 'renderer', '_ui-state-migrate.html');
  try {
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    // Recreated on demand: `vite build` empties dist/renderer.
    fs.writeFileSync(htmlPath, '<!doctype html><meta charset="utf-8"><title>ui-state</title>');
  } catch (err: any) {
    logger.info('ui-state', `migration skipped (cannot write probe page): ${err?.message}`);
    return;
  }
  const probe = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  try {
    await probe.loadFile(htmlPath);
    const dump = await probe.webContents.executeJavaScript(
      `(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) {`
      + ` const k = localStorage.key(i); if (k && k.indexOf('kirolex-') === 0) o[k] = localStorage.getItem(k); } return o; })()`,
    );
    let n = 0;
    const skipped: string[] = [];
    for (const [k, v] of Object.entries(dump || {})) {
      // The sweep is a blanket `kirolex-*` import, so it would faithfully carry a
      // retired key back in. Filter here as well as pruning after.
      if (DEAD_UI_STATE_KEYS.has(k)) { skipped.push(k); continue; }
      // Same reason, different lifetime: a run-scoped key must start empty, so the
      // stale localStorage mirror from the PREVIOUS run must not be carried in.
      if (RUN_SCOPED_UI_STATE_KEYS.has(k)) { skipped.push(k); continue; }
      if (typeof v === 'string' && v) { setUiStateKey(k, v); n += 1; }
    }
    if (skipped.length) logger.info('ui-state', `skipped retired key(s) during migration: ${skipped.join(', ')}`);
    logger.info('ui-state', n > 0
      ? `migrated ${n} key(s) from the file:// origin -> ${UI_STATE_PATH} (${Object.keys(dump || {}).join(', ')})`
      : 'migration found no kirolex-* keys on the file:// origin (nothing to carry over)');
  } catch (err: any) {
    logger.info('ui-state', `migration FAILED: ${err?.message} -- start once with \`npm start\` to seed it`);
  } finally {
    try { probe.destroy(); } catch {}
  }
}

app.on('before-quit', () => {
  isQuitting = true;
  // Kill all per-session kiro-cli child processes so none are orphaned
  for (const [, entry] of sessionClients) {
    try { entry.client.disconnect(); } catch {}
  }
  sessionClients.clear();
  /*
    **那些复用连接也关掉** —— 每台机器一条 `ssh -N`，是我们自己起的进程。留着的话它们会被
    launchd 收养（PPID 变 1），也就是下一次启动要扫的垃圾 —— 而那正是那台 EC2 被压死的
    累积链的第一环（见 `sweepStrayLocalSsh`）。
  */
  try { sshMux.closeAll(); } catch { /* 退出路径不抛 */ }
});

/** 本机控制入口（agent-board「拉取并重启」）：`POST /quit` 走的就是托盘「Quit」那条路径。 */
let controlServer: ControlServer | null = null;
/** 现在忙的会话（带标题）—— 判据见 busySessions.ts */
function getBusySessions(): BusySession[] {
  const turns = new Set<string>([...attachingSessions, ...reconfiguringSessions]);
  for (const [id, e] of sessionClients) if (e.busy) turns.add(id);
  return collectBusySessions({
    turns,
    scheduleRuns: schedulesInFlight.values(),
    revisePending: revisePending.entries(),
    queues: queueCounts(uiState()['kirolex-queues']),
    titleOf: (id) => store.readRecord(id)?.title,
  });
}
ipcMain.handle('control:pending-quit', () => quitPending);
app.whenReady().then(async () => {
  try {
    controlServer = await createControlServer({
      onQuit: () => { isQuitting = true; app.quit(); },
      /*
        **只刷新窗口，不动主进程** —— 会话、kiro-cli、排队、定时任务全在这边，原样留着。
        和 `/quit` 一样只在没有会话忙的时候才调到这里（有忙的就先等，见 controlServer.ts）；
        渲染端回来时从 ui-state.json 恢复标签 / 分屏 / 草稿。
      */
      onReload: () => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed() || win === splashWindow) continue;
          logger.info('control', `reloading window "${win.getTitle()}"`);
          win.webContents.reloadIgnoringCache();
        }
      },
      getBusy: getBusySessions,
      onPendingChange: (pending) => {
        quitPending = pending;
        mainWindow?.webContents.send('control:pending-quit', pending);
        if (pending) {
          const busy = getBusySessions();
          logger.info('app', `pending ${controlServer?.quit.pendingAction ?? 'quit/reload'}: waiting for ${busy.map((b) => `${b.title || b.id}[${b.reasons.join(',')}]`).join(' ')}`);
        }
      },
      log: (msg) => logger.info('control', msg),
    });
    logger.info('app', `control server on 127.0.0.1:${controlServer.port}`);
  } catch (err: any) {
    logger.info('app', `control server failed to start: ${err?.message}`);
  }
});
app.on('will-quit', () => { void controlServer?.close(); });

/** Turn a supervisor's SIGTERM into a REAL app quit.
 *
 *  The dev supervisor relaunches Electron whenever main is recompiled. Without
 *  this, SIGTERM tears the process down without running `before-quit`, so each
 *  kiro-cli child dies without closing stdin -- which leaves a STALE session lock
 *  and makes the next `session/load` fail with "Session is active in another
 *  process (PID n)" even though that pid is long gone. Quitting properly is what
 *  makes "edit KiroLex inside KiroLex" survivable. */
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    logger.info('app', `${sig} received -> graceful quit (releasing kiro-cli sessions)`);
    try { app.quit(); } catch { process.exit(0); }
    // Backstop: if quit stalls (a busy turn, a hung child), leave anyway.
    setTimeout(() => process.exit(0), 5000);
  });
}

/** The same graceful quit, asked for by FILE -- because Windows has no signals.
 *
 *  There `kill('SIGTERM')` is an immediate TerminateProcess: the handler above never
 *  runs, the kiro-cli children are orphaned with their session locks held, and after
 *  the supervisor's relaunch every local chat fails `session/load` with "Session is
 *  active in another process". So under `--dev` on win32 the supervisor (scripts/
 *  dev-hot.mjs) drops this file instead and main quits itself. Polled rather than
 *  fs.watch'ed: watch on Windows drops events for files created right after start. */
const DEV_QUIT_REQUEST = path.join(os.homedir(), '.kirolex', 'dev-quit-request');
if (IS_DEV && process.platform === 'win32') {
  /*
    **只清"我起来之前"的那份** —— 实测的竞态：刚启动两秒就又触发一次重启，监管进程写了退出请求，
    而这个进程那时还没走到这里，一上来就把它当成陈旧的删了 —— 于是它永远等不到退出请求，
    成了占着单实例锁的孤儿，之后每一次重启都撞「another instance is running」。
  */
  try {
    const startedAt = Date.now() - process.uptime() * 1000;
    if (fs.statSync(DEV_QUIT_REQUEST).mtimeMs < startedAt) fs.rmSync(DEV_QUIT_REQUEST, { force: true });
  } catch { /* 没有就算了 */ }
  setInterval(() => {
    if (!fs.existsSync(DEV_QUIT_REQUEST)) return;
    try { fs.rmSync(DEV_QUIT_REQUEST, { force: true }); } catch { /* 下面照样退 */ }
    logger.info('app', 'dev quit request received -> graceful quit (releasing kiro-cli sessions)');
    try { app.quit(); } catch { process.exit(0); }
    setTimeout(() => process.exit(0), 5000);
  }, 500).unref();
}

app.on('window-all-closed', () => {
  // Don't quit on Windows/Linux when window is hidden to tray
  if (process.platform === 'darwin') {
    // macOS: keep app running
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else if (mainWindowRevealed) {
    // Only restore on dock-click AFTER the initial gated reveal. Before that,
    // launch-time `activate` must not show the still-loading window.
    mainWindow.show();
  }
});
