import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, clipboard, dialog, shell, safeStorage, Notification, type WebContents } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync, execFileSync, execFile, spawn, type ChildProcess } from 'child_process';
import { AcpClient, type EngineOptionCategory, resolveKiroCli, buildSshArgs, shellQuote, kiroTraceEnabled, setLocalKiroBin, setRemoteBinResolver, setMuxSocketResolver, kiroBinProblem, remoteKiroBin, buildRemoteAdapterCommand, parseRemotePid, remoteKillTree, setMuxSessionsFullHandler } from './acp-client';
import { setPasswordDecryptor, sshEnv } from './sshAuth.ts';
import { noticesFromStderr, noticeLabel } from './stderrNotice.ts';
import { acpAvailableCommands } from './acpCommands.ts';
import { ENGINE_LABEL, REMOTE_ADAPTER_BIN, backendHeldAtTurnStart, backendPersistsSessions, contextMarkerHolds, engineOf, liteHelperSkipReason, findAdapterEntry, forgetAdapterCache, adapterMissingMessage, adapterAuthMessage, type Engine } from './engines.ts';
import { runLocalAdapterInstall, createSharedInstalls, remoteInstallCommand, remoteInstallOutcome, adapterInstallFailedMessage, binOnPath, remoteInstallReason, installFailureReason, remoteKiroInstallOutcome } from './adapterInstall.ts';
import { createStatusCache, judgeEngineStatus, localAuthFromFiles, remoteEngineStatuses, kiroInstallCommand, kiroInstallFailedMessage, terminalLaunches, LOGIN_ARGS, remoteLoginHow, type EngineStatus } from './engineStatus.ts';
import { testConnectionScript, splitTestOutput, judgeTestConnection, adapterProbeScript, parseAdapterProbe, judgeAdapterProbe, adapterProblemMessage, adapterHiddenNotice, remoteAuthConfigured, remoteLoginHint, rememberRemoteAdapterLaunch, judgeAdapterVerify, adapterVerifyMessage, ACP_INITIALIZE_LINE, type AdapterVerifyResult } from './remoteAdapterProbe.ts';
import { claudeBedrockSettings, codexBedrockToml, claudeBedrockOf, codexBedrockOf, BEDROCK_DEFAULTS, applyCodexProvider, claudeEditorText, codexEditorText, codexGateway, mergeClaudeSettings, parseClaudeEditor, parseClaudeStatus, parseCodexEditor, parseCodexStatus, pickClaudeEnv } from './aiLogin.ts';
import { SshMux, muxKey, muxSupported, MUX_DIR, sshErrorKind, sessionsFullMessage } from './sshMux';
import { RemoteRecovery, LOCAL_TOOLS_RECONNECT_GROUP, LOCAL_TOOLS_RESTORED_GROUP } from './remoteRecovery.ts';
import { ModelFallbackNotes } from './modelFallbackNote.ts';
import { reviseGaveUpNote, reviseGaveUpGroup } from './reviseGiveUp.ts';
import { pickEngineModel, reshapeProfileForEngine, withEngineModelUsed } from './engineModelPick.ts';
import {
  CATEGORIES as KIRO_CONFIG_CATEGORIES, categoriesFor as kiroCategoriesFor, categorySpec, LocalKiroConfig, pickEntries, validateContent,
  remoteListScript, remoteReadScript, parseRemoteRead, remoteWriteScript, relPath, parseRemoteList, pluginWriteError,
} from './kiroConfig';
import { rewriteImagePaths } from './imagePaths';
import { steerRefusal } from './steerGate';
import { HandoffRefused, detachedTurnMessageId, dropFollowUp, enlistFollowUp as enlistFollowUpTurn, handOverTurn as handOverFollowUp, holdTarget, keepsBusy, type FollowUp, type FollowUpDeps, type HandoffSpec } from './followUpTurns';
import { detachedTurnEnded, steerDisplay, steeringPromptBlocks } from './busyEnterCaps';
import { ackRequeued, addPendingHandoff, handoffFacts, markHandoffStarted, persistThenRelease, readPendingHandoffs, recoverableHandoffs, removePendingHandoff, restoreStartedHandoffs, restoredUserMessage, type PendingHandoff } from './pendingHandoffs';
import { isReplayOutsideTurn, outsideTurnVerdict } from './replayGuard';
import { autonomousFrame, beginAutonomousTurn, endAutonomousTurn, type AutonomousDeps, type AutonomousTurn } from './autonomousTurn';
import { hasPendingClaudeCron, noteClaudeCronTool, type ClaudeCronTrack } from './claudeCron';
import { parseModelList, parseModelListJson, pickAvailableModel, pinAgentModel, firstWantedModel, remoteStartCandidates } from './modelAvailability.ts';
import { planHelperRoute, remoteLiteScript, parseRemoteLiteOutput, LOCAL_MACHINE as HELPER_LOCAL_MACHINE, type MachineModelList } from './helperModels.ts';
import { parseAgentList } from './kiroAgentList.ts';
import { Breaker, BREAKER_MS, PREFLIGHT_ATTEMPTS, backoffMs, worthRetrying } from './reachability.ts';
import { readMetaCache, writeMetaCache, mergeMeta, enrichModels } from './modelMeta.ts';
import {
  SyncConfig, Catalog, CatalogEntry, SESSION_FILES, MAX_FILE_BYTES, DEFAULT_INTERVAL_MINUTES,
  planUpload, keyFor, relFor, catalogKey, contentTypeFor, readState, writeState, walk,
  maskKeyId, machineTag, trashDirFor, detectConflicts, conflictKeyFor, backoffMultiplier,
  readSessionMarks, writeSessionMarks, sessionSyncState, sessionIdOfRel, sessionChangedAt, mergeMemoryText, SESSION_FILES_DIR, projectMemoryMarkKey, walkSessionFiles, conflictPrefixFor,
  decideMemory, memoryRelsFor, placementOf, placementToFollow, applyPlacement,
} from './s3Sync.ts';
import {
  cleanupSettings, buildDeviceManifest, withDeviceManifest, describeDevices, runCloudCleanup, listCloudTrash,
  restoreFromCloudTrash, purgeCloudTrashItem, noteDeletion, forgetDeletion, readDeletionMarks, writeDeletionMarks,
  pruneDeletionMarks, deletionsFromTrashNames, loadOrCreateDeviceId,
  type BucketOps, type CleanupResult,
} from './cloudTrash.ts';
import { mergeTranscripts, mergeRecords, guardMergedPlacement } from './transcriptMerge.ts';
import { restorePlacement, catalogProject } from './restoreArchive.ts';
import { fitHistory, historyTrimNote, HISTORY_BUDGET_BYTES } from './historyBudget.ts';
import { MCP_COMBOS_REL, syncComboFile, readComboMark, writeComboMark } from './mcpCombosSync.ts';
import { AGENT_PROFILES_REL, PROFILE_CONFLICTS_DIR, PROFILE_ENGINES, agentProfilesRoot, readProfileFile, saveProfileText, readLocalRules, parseClaudeProfile, parseCodexProfile, computeDiff, buildSyncPlan, planHasWork, probeScript, parseProbeOutput, runProfileSync, remotePinCommand, remoteApplyCommand, collectMarketplaceFiles, CLAUDE_PROFILE_TEMPLATE, CODEX_PROFILE_TEMPLATE, type ProfileEngine, type ProbeResult, type DiffItem, type SyncPlan, type ClaudeProfile, type CodexProfile } from './agentProfile.ts';
import { syncProfileFiles, listLocalProfileFiles, listConflictCopies, readProfileMarks, writeProfileMarks } from './agentProfileSync.ts';
import { S3Creds, S3Error, putObject, putObjectIf, deleteObject, deleteObjectIf, deleteObjectVersion, listObjectVersions, listVersionedKeys, getObject, getObjectIfExists, getObjectWithEtag, listObjects, listCommonPrefixes, prefixDeletedAt } from './s3Client.ts';
import {
  serialQueue, catalogIO, updateCatalog, readCatalog, deleteSessionBackups, writeSyncCatalog, forgetMissingEntries,
  missingEntries, markMissing, sessionIdsFromPrefixes, sessionKeyPrefix, entryUploadedAt, syncMark, deletedSessionPlan, dropSessionState, type CatalogBucket,
} from './catalogStore.ts';
import { AgentProfile, DEFAULT_MODEL, MODEL_FALLBACK_ORDER, deriveProjectId, canAssignProjectId, keepRecordPlacement, sessionCwd, resolveRemoteWorkdir, remoteHomeDir, type ExecutorBins, type RemoteTarget } from './config';
import * as loopVerify from './loopVerify';
import * as eventLog from './eventLog';
import * as store from './sessionStore';
import { isAdvancedOnly, findAdvancedBackups, vetBackupRecord, refusesProjectChange } from './advancedOnly.ts';
import { parseSkillDoc, describeSkill, kiroSkillTarget, backupsToPrune } from './skillDoc.ts';
import { isSubagentListUpdate, parseSubagentList, mergeSubagentList, activeSubagents, type SubagentRow } from './subagents.ts';
import * as loopStore from './loopStore.ts';
import { createSchedule as newSchedule, describeSchedule, isDue, nextRunAt, recordRun, refundRun, computeScheduleExpiry, scheduleDeliveryBlocker, scheduleEndedText, scheduleGoalSuffix, scheduleTerminal, validateSchedule, type ScheduleSpec, type ScheduleState } from './schedule.ts';
import * as scheduleStore from './scheduleStore.ts';
import { runScheduleCheck as runScheduleCheckWith } from './scheduleCheckRun.ts';
import { SESSION_BUSY, WakeDispatcher, WakeSkipped, isWakeBusyError, type WakeItem } from './wakeQueue.ts';
import { TEXT_TOOL_NUDGE_ID_PREFIX, isTextToolNudgeId, textToolCallVerdict, foldTextToolCall, stripTextToolCalls, type TextToolAction, type TextToolCall } from './textToolCall.ts';
import { SWAP_MAX, SWAP_WINDOW_MS, TEXT_TOOL_SWAP_ID_PREFIX, afterBackendSwap, afterUserMessage, decideTextToolRecovery, isUserTurnMessageId, recordAutoSwap, swapAbandoned, textToolWakeStale, type TextToolRecoveryState } from './textToolRecovery.ts';
import { canRetrySame, decidePromptDedupe, DUPLICATE_MESSAGE, DUPLICATE_STARTED, InFlightPrompts, reviseMessageId, turnCompletedNormally } from './promptDedupe.ts';
import { BG_DEFAULT_TIMEOUT_SEC, BgJobManager, interruptedNotice, takeInterruptedJobs, writeRunningJobs } from './bgJobs.ts';
import { adapterScheduleNote, callWakeTool, switchCarryOverText, type WakeHost } from './wakeTools.ts';
import * as projectStore from './projectStore.ts';
import { backupMemoryLayer, buildMemoryInjection, deleteProjectMemory, deleteSessionMemory, memoryLayerBytes, readMemory, writeMemory } from './memory';
import type { MemoryScope } from './memoryPolicy.ts';
import { shouldConsolidate, buildConsolidationPrompt, autoConsolidationSkipReason, applyAutoConsolidation, CONSOLIDATE_EVERY } from './sessionMemory.ts';
import { staleVerdict, staleRecoveryNote, isBareInternalError, POISONED_AFTER, RECREATE_COOLDOWN_MS } from './staleSession.ts';
import { isTransientTransportError as isTransientTransportErrorImpl } from './transientError.ts';
import { planRetry, retriesExhaustedNote, MAX_AUTO_RETRIES, maxRetriesFor } from './promptRetry.ts';
import { cliErrorContext, trimHugeCliLogs } from './kiroCliLog.ts';
import { bundleOmitsSessionContent, diagnosticPromptText, writeFailureBundle } from './failureBundle.ts';
import { hostFor, loadTimeoutFor, type HostOps } from './hostOps.ts';
import { judgePreflight, preflightScript, MODEL_PROBE, parseModels, remoteExecutorCap, REMOTE_MB_PER_SESSION, REMOTE_LOW_MEM_MB, remoteHeadroom, isOlderVersion } from './remotePreflight.ts';
import { remoteContextBlock } from './remoteContext.ts';
import { remoteWriteVerdict, strayRemoteDeliverables, blockedWriteNotice, strayWriteNotice, saveRemoteCopy, captureBufferFor } from './remoteWriteGuard.ts';
import { LOCAL_MARKER, MAX_LOCAL_ACTIONS_PER_TURN, parseLocalActions } from './localAction.ts';
import { detectScript, detectWindows, whichAll, PROBE_TIMEOUT_SEC, testScript, parseDetect, parseTest, mergeHistory, type ToolId } from './binDetect.ts';
import { probeHttpMcp, releaseSessionTools, startLocalMcp, type LocalMcpServer } from './localMcp.ts';
import { LocalBrowserHost, browserActionTitle, createQuitGuard } from './localBrowserHost.ts';
import { isBrowserKind, type BrowserAction } from './localBrowser.ts';
import { createControlServer, type ControlServer, type ControlSessionAccess, type ControlSendResult } from './controlServer.ts';
import { controlMessageId, isControlMessageId, isSessionMessageId, tailEntries, type MarkOrigin } from './controlSessions.ts';
import { PairRateLimiter, ReplyWatcher, callSessionTool, type ReplyWatch, type SessionCallsHost, type SessionInfo } from './sessionCalls.ts';
import { blocksQuit, collectBusySessions, queueCounts, type BusySession } from './busySessions.ts';
import { settleInFlightAttach } from './attachGate.ts';
import { attachFailureLine, coldProfileBits, durableRemoteId, type ColdRecordHint, type NewSessionIntent } from './coldRecord.ts';
import { createCreationGate } from './creationGate.ts';
import { settleCancelledToolCalls } from './cancelSettle.ts';
import { mergeToolTrace, shouldRecordToolCall, toolTimes, toolTraceFields } from './toolTrace.ts';
import { forkPointMeta, mainlineAcpMessageId, planEditFork, supportsForkPoint } from './editFork.ts';
import { windowIsActive } from './idleNotice.ts';
import { moveDirToTrash, scheduleBackgroundRetries, waitAtMost } from './sessionPurge.ts';
import {
  forwardableFrom, localAgentJson, normalizeForwardList, remoteForwardPlan, isHttpForward, httpProbeNotice,
  remoteComboMcpServers, adapterForwardPlan, localKiroMcpSources, type ForwardListItem,
  markForwardUnavailable, clearForwardUnavailable, type ForwardUnavailable,
} from './forwardMcp.ts';
import {
  allocateRemotePort, localToolsHelp, mcpUrl, parseAgentBase, parseDroppedDupes,
  remoteAgentScript, removeAgentScript, sessionAgentName, SESSION_AGENT_PREFIX,
  sweepAgentsScript, STALE_AGENT_MINUTES, orphanSweepScript, parseOrphanSweep,
  staleExecutorSweepScript, parseStaleSweep, adapterSweepScript, parseAdapterSweep,
  ownerTag, ownedAgentPrefix, LISTENING_PORTS_SCRIPT, parseListeningPorts,
} from './remoteLocalTools.ts';
import { parseWhoami, loginEnv } from './kiroLogin.ts';
import { expandHome, listRemoteTargets, findRemoteTarget, saveRemoteTarget, deleteRemoteTarget, validateTarget, labelForHost, localBins, saveLocalBins, localWorkdir, localWorkdirSetting, saveLocalWorkdir, binHistory, rememberBinSuccess, type RemoteTargetInput } from './remoteTargets.ts';
import { createAdapterNotes } from './adapterNotes.ts';
import { isKirolexNote, modelFacing, stripKirolexNotes, KIROLEX_NOTE_OPENINGS, NOTE_DETAIL_SEP, splitNoteDetail, noteAlreadyInTranscript } from './kirolexNote.ts';
import { newQuestionCard, closeQuestionCard, buildAcceptContent, elicitationResult, questionTailText, type QuestionCard, type QuestionStatus, type QuestionValue } from './elicitation.ts';
import { ReviewedPaths, remoteReviewKey, pickReviewTarget, writeTextVia, reviewBackupPrefix, reviewBackupsToPrune, type ReviewTarget } from './reviewAccess.ts';
import { parseRevised, keepHeading, settlePatchRevision, patchWritten,reviseInSessionPrompt, replyUsable, reviseSlideTextPrompt, parseSlideEdits } from './reviseBlock.ts';
import { applyRevision, type ReviewApply } from './reviewApply.ts';
import {
  SOFFICE_BUNDLE_PATHS, SOFFICE_PATH_NAMES, pickConverter, sofficeBinary, pathProbeCommand, firstProbeHit,
  installConverterCmd, noConverterWhy, pythonCandidates, PPTX_PROBE_SCRIPT, pythonEnv, noPythonPptxWhy,
  previewKey, needsConversion, isPreviewable, canEditDeck, NOTES_SCRIPT, WRITE_NOTE_SCRIPT, SLIDE_TEXT_SCRIPT, noteChanged,
  SLIDE_OPS_SCRIPT, WRITE_SLIDE_TEXT_SCRIPT, parseSlideRuns, parseWriteNote, parseNotesResult,
} from './deckPreview.ts';
import { ConvertOnce, LO_PROFILE_DIR, userInstallationArg } from './convertOnce.ts';
import { logger } from './logger';
import { zoomKeyAction } from './zoomKeys.ts';
import { primeVerdict, primeGiveUpNote } from './primeRetry.ts';
import { setUiLang, uiLang, tr, trConcat, trList, bothLangs, textVariants, asVariants, type TextVariants } from './uiText.ts';
import { defaultComboForNewSession, normalizeComboId, readGlobalDefaultCombo, writeGlobalDefaultCombo, resolveDefaultCombo } from './defaultCombo.ts';
import { readMcpCombos, saveMcpCombos, writeMcpCombosText, pickCombo, findCombo, comboDisplayName, buildAcpMcpServers, maskAcpServers, applyComboEffort, modelOffersEffort, mcpCombosPath, MCP_COMBOS_TEMPLATE, BUILTIN_COMBO_ID, type McpCombo } from './mcpCombos.ts';
import { PendingSwitchBook, PendingSwitchRunner, runPendingSwitches, withEngineOption, shouldQueueSwitch, pendingTargetText, isReconnectKind, PENDING_SWITCH_NOTE_GROUP, type PendingSwitch, type PendingKind } from './pendingSwitch.ts';

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
  /** 这一轮从什么时候开始跑（`busy` 为真时才有意义）—— 控制入口的 status 用 */
  turnStartedAt?: number;
  profile: AgentProfile;
  /** Working directory used when creating/loading replacement executors. */
  cwd: string;
  /**
   * **本地那个目录** —— 远程会话里 `cwd` 是远端镜像的路径，而镜像、冲突判定、同项目并发都要
   * 按本地目录算（`docs/DESIGN_remote_sessions.md`：本地是唯一真相）。本地会话里它和 `cwd` 相同，
   * 所以不设也不会错 —— 但设上之后就不用在每个用点再判一次"这是远程吗"。
   */
  localDir?: string;
  /** 远程会话：已经提示过"交付文件落在远端"的那些 toolCallId（每个调用只说一次，见 `wireSession`）。 */
  strayRemoteNoticed?: Set<string>;
  /** accumulates the in-flight assistant response; flushed to the durable
   *  store only when the turn completes (asymmetric durability, §7). */
  assistantBuf: string;
  assistantMsgId: string | null;
  /** Claude Code / Codex：这一轮主线最后一个 ACP messageId —— 落盘成 `acpMessageId`，编辑重发从这里分叉（`editFork.ts`） */
  lastAcpMessageId?: string;
  /** 编辑重发刚 fork + load 了新的后端会话：load 回放的工具调用 / 正文在下一轮开始前一律丢掉（不能当成这条会话的新输出记下来） */
  dropReplayUntilTurn?: boolean;
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
  /** 这一次发送（和 `toolsThisTurn` 同一处清零）模型有没有出过字 —— `planRetry` 的 producedText 看它：flush 会清空 `assistantBuf`，这个不会。 */
  textThisTurn?: boolean;
  /** 这一轮最后一次开工具调用那一刻 `assistantBuf` 的长度 —— 判「把工具调用写成了文字」只看这之后的正文（`textToolCall.ts`）。 */
  bufAtLastTool?: number;
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
  /** **回放窗口**：挂上执行器（`wireSession`）/ 换后端会话之后、KiroLex 发起的第一轮之前 —— 这段时间一轮之外的正文是回放（判据见 `replayGuard.outsideTurnVerdict`） */
  replayWindow?: boolean;
  /** 后端自己起的那一轮（Claude Code 的 cron 到点 / 后台任务跟进，`autonomousTurn.ts`）：界面上算一轮（busy 报 turn），不被 LRU 回收 */
  autonomous?: AutonomousTurn;
  /** 这个后端里 Claude 自己定的 cron（`claudeCron.ts`）：LRU 驱逐时提示一句 */
  claudeCrons?: ClaudeCronTrack;
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
  /** 新执行器接上后按 profile 恢复 Claude Code / Codex 的模型 / effort / 权限（`applyEngineModel`）——
   *  忙时记下的即时项要等它落定再设，否则会被它按旧 profile 设回去（见 applyPendingSwitchBatch）。 */
  engineOptionsReady?: Promise<void>;
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
  /** 交给适配器、排在当前这一轮后面的那几轮（`followUpTurns.ts`）：忙时 Enter 走 promptQueueing，或 steering 碰上这一轮刚结束 */
  followUps?: FollowUp[];
  /** `_session/steering` 请求还在途的条数 —— 结果可能是适配器自己起了一轮（`startedNewTurn`），前一轮收尾时 busy 先别放 */
  steeringInFlight?: number;
  /** 前一轮收完了、还在等 steering 结果：这段时间的输出先攒着（`followUpTurns.holdTarget`） */
  limbo?: { held: any[] };
  /** 把攒着的输出按原顺序交给 wireSession 的那个处理函数（接手的那一轮清零计数之后调） */
  replayUpdates?: (list: any[]) => void;
  /** 正在跑的是适配器自己起的那一轮（detached）：收到它的结束信号时调 */
  detachedEnd?: () => void;
  /** 那一轮已经有过动静（active / 输出）—— 之后的 idle 才算它的结束 */
  detachedSeen?: boolean;
  /** sendPromptOnce 的那一轮循环正在跑（它收尾时会交棒给排着的下一轮） */
  turnRunning?: boolean;
  /** 最近一次点「停止」的时间 —— 排在后面的那几轮接手时据此一并停掉 */
  cancelRequestedAt?: number;
  /** 这一轮**正常收尾**了：下一次 flush 的助手消息是回这一条用户消息的**完整**回复 —— 落盘成 `replyComplete`，去重按它认"答过了"（`promptDedupe.ts`）。flush 时取走。 */
  completedReplyTo?: string;
  /** 已经记过"模型开始做这一条了"的那个用户消息 id（`noteTurnStarted`）—— 一轮只记一次。 */
  startedNoted?: string;
}
const sessionClients: Map<string, SessionEntry> = new Map();
// Serializes model/Agent replacement per session. Renderer locks are UX only;
// this guard is authoritative against racing IPC calls and background queues.
const reconfiguringSessions = new Set<string>();
/** requestId -> when the permission prompt was raised, so the answer can record how
 *  long the turn was blocked. Lives here (not on the entry) because a permission may
 *  be answered after a model swap replaced the executor. */
const permissionWaitStartedAt = new Map<string, number>();
/**
 * 挂着的提问卡片（模型向用户提问，见 `elicitation.ts`）：卡片 id → 卡片 + 哪个执行器在等它的回答 + 超时计时器。
 * 放在模块级、不挂在 entry 上：执行器被换下来时（`rejectAllPending`）也要能找到它、记成「已取消」落盘。
 */
const openQuestions = new Map<string, { card: QuestionCard; client: AcpClient; timer: ReturnType<typeof setTimeout> }>();
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
    throw new Error(tr('This session is reconnecting. Wait a moment before switching the model/Agent.'));
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
    throw new Error(tr('The model/Agent switch for this session has not finished after 30 seconds, so it cannot connect right now.'));
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
  /**
   * 远程 kiro 会话：preflight 问到的那台机器的模型清单。传了它就表示 `profile.model` 是
   * `pickRemoteModel` 按这份清单挑过的 —— 它排第一，而且候选只留清单里有的（见 `remoteStartCandidates`）。
   */
  remoteModels?: string[],
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
  /* 远程且带着清单：`profile.model` 是 `pickRemoteModel` 刚按那台机器的清单挑的，不是记录里的旧值 */
  const remotePicked = !!profile.remote?.sshHost && !!remoteModels;
  if (!earnedHere && profile.model && !remotePicked) {
    logger.info('model', `${label}: 记录里的 '${profile.model}' 不是在 ${machine} 上挣来的`
      + `（记着 ${profile.modelEarnedOn || '没记'}）—— 不采信它，回到偏好模型`);
  }
  const base: string[] = [profile.preferredModel, earned, ...MODEL_FALLBACK_ORDER]
    .filter((m): m is string => !!m)
    .filter((m, i, arr) => arr.indexOf(m) === i);
  /*
    **远程会话按那台机器的清单排** —— 以前远程也用上面这串：`pickRemoteModel` 挑出来的 `profile.model`
    没有 `modelEarnedOn` 就被丢掉，排第一的反而是远端清单里根本没有的偏好模型。`connect()` 对它照样成功，
    kiro-cli 随后静默退回默认模型，会话里"改用 X"那句话就是假的。
    现在：挑出来的那个排第一，其余按原顺序、只留远端有的。
  */
  const all: string[] = remotePicked
    ? remoteStartCandidates([profile.model, ...base], remoteModels || [], MODEL_FALLBACK_ORDER)
    : base;
  if (remotePicked) {
    logger.info('model', `${label}: 按 ${machine} 的模型清单排启动候选：${all.join(', ')}`);
  }
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
  /** 本机清单里没有你选的模型（连上之后据此在会话里说一句，见下面的循环） */
  let localMissing: { wanted: string; available: string[]; geoFiltered: boolean } | null = null;
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
        /* 实际用哪个要等下面连上才知道 —— 那时再说（换了模型 → 进对话记录，见 modelFallback） */
        localMissing = { wanted, available, geoFiltered };
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
      /*
        **本机清单里没有你选的模型** —— 连上了才说，说的是实际跑的那个（换了模型影响结果 → 进对话记录）。
        trConcat / trList：整句（含列表的分隔符）都认得出两种语言；本机可用清单和"为什么没有 Claude"折进详情。
      */
      if (sessionId && localMissing && model !== localMissing.wanted) {
        const lm = localMissing;
        modelFallback.note(sessionId, lm.wanted, model, trConcat(tr('⚠️ This machine has no model "{wanted}", so this session uses "{model}" instead.', { wanted: lm.wanted, model }),
          NOTE_DETAIL_SEP,
          tr('Available here: {list}{more}', { list: trList(lm.available.slice(0, 8)), more: lm.available.length > 8 ? '…' : '' }),
          (lm.geoFiltered
            ? tr('\nNo Claude model and no `auto` in the list: usually your outbound IP is region-filtered (switching kiro-cli versions won\'t help). To use Claude, move this session to a remote machine.')
            : '')));
      } else if (sessionId && !profile.remote?.sshHost && model === (profile.preferredModel || profile.model)) {
        modelFallback.wantedInUse(sessionId);   // 又用上你选的那个了：下次再换要重新说
      }
      /* 远程：pickRemoteModel 挑过备用模型 → 按**实际起来的**这个说（它挑的那个可能没起来、换成了下一个） */
      if (sessionId && remotePicked) {
        if (modelFallback.hasRemotePick(sessionId)) modelFallback.remoteStarted(sessionId, model);
        else modelFallback.wantedInUse(sessionId);   // 远端有你选的那个：下次再换要重新说
      }
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
  /* 一个都没起来：挑过的备用模型也不算数，不写"改用了 X" */
  if (sessionId) modelFallback.remoteFailed(sessionId);
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
  /* 回退链、模型清单、死模型表都是 kiro 的：Claude Code / Codex 的模型由适配器自己管，换不了也不该换 */
  if (!entry || engineOf(entry.profile) !== 'kiro') return null;
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
      **偏好留着，只记"这个降级是在哪台机器上挣来的"。**

      kiro-cli 明说「这个模型不可用，请用 /model 换一个」是**这台机器**上的确定性事实，不是别的机器上的：
      本机因为出口 IP 的地域过滤一个 Claude 都没有，而远端那台 Claude 全在。上一版在这里把偏好清掉，
      于是一条在本机被降级成 GPT 的会话切到远端时 `firstWantedModel` 拿不到偏好、只能从兜底链头上取 GPT ——
      远端明明有你选的 Claude，也回不去了。

      原来清偏好是为了"偏好在下次 attach 抢先连上 → 第一轮再报退役 → 每次重启付 30 秒"。那件事现在由
      清单挡着：本机这台 `connectWithModelFallback` 先问 `localModelIds`，清单里没有的排到最后；远端按
      `remoteStartCandidates` 只留那台有的。只有清单问不到时才会再付一次那 30 秒，比把你的选择永久丢掉便宜。

      仍然**不**把 `model` 写成偏好：把一个自动选中的模型写成「你偏好的」正是 MODEL_FALLBACK_ORDER 那段要防的事。
    */
    /* 记下是**哪台机器**挣的：换机器之后这条降级就不该再生效（见 `modelEarnedOn`） */
    const profile: AgentProfile = stillListed
      ? { ...entry.profile, model, modelEarnedOn: undefined }
      : { ...entry.profile, model, modelEarnedOn: machineKeyOf(entry.profile) };
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
          : `${entry.profile.preferredModel === failedModel ? `（${machineKeyOf(entry.profile)} 的清单里也没有它，这台机器上记成跑不了；偏好留着 —— 换到有它的机器时回到它）` : ''}`));
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

/** 远程机器上的那份 lite agent：同样没工具、没 MCP、不读 legacy mcp.json（`model` 由 `remoteLiteScript` 钉）。 */
const REMOTE_LITE_AGENT: Record<string, unknown> = {
  name: LITE_AGENT,
  description: 'KiroLex: background text chores (titles, suggestions, memory)',
  mcpServers: {},
  tools: [],
  allowedTools: [],
  resources: [],
  hooks: {},
  useLegacyMcpJson: false,
};

/**
 * **每台远程机器的模型 id 清单**（辅助模型用）。按机器缓存 10 分钟、按机器 single-flight、
 * 每台各自超时 —— 单台慢 / 挂了只少那台。`force` 跳过缓存（设置里打开 / 点刷新），
 * 但仍复用正在跑的那次，不会并发打爆。实际怎么问由 `acp:list-models` 的远程分支决定（`remoteModelLister`）。
 */
const HELPER_REMOTE_TTL_MS = 10 * 60_000;
const HELPER_REMOTE_TIMEOUT_MS = 45_000;
const helperRemoteCache = new Map<string, { ids: string[]; at: number }>();
const helperRemoteInFlight = new Map<string, Promise<string[]>>();
/* 刚失败过的机器 2 分钟内不再问（不 force 时）：否则一台挂了的机器让每次生成标题都先白等 45 秒 */
const HELPER_REMOTE_FAIL_MS = 2 * 60_000;
const helperRemoteFailedAt = new Map<string, number>();
let remoteModelLister: ((machine: string) => Promise<string[]>) | null = null;
let helperListsInFlight: Promise<MachineModelList[]> | null = null;

function helperRemoteIds(machine: string, force: boolean): Promise<string[]> {
  const hit = helperRemoteCache.get(machine);
  if (!force && hit && Date.now() - hit.at < HELPER_REMOTE_TTL_MS) return Promise.resolve(hit.ids);
  const failedAt = helperRemoteFailedAt.get(machine);
  if (!force && !hit && failedAt && Date.now() - failedAt < HELPER_REMOTE_FAIL_MS) return Promise.reject(new Error('failed recently'));
  let p = helperRemoteInFlight.get(machine);
  if (!p) {
    const lister = remoteModelLister;
    p = new Promise<string[]>((resolve, reject) => {
      if (!lister) { reject(new Error('model lister not ready')); return; }
      const timer = setTimeout(() => reject(new Error(`timed out after ${HELPER_REMOTE_TIMEOUT_MS / 1000}s`)), HELPER_REMOTE_TIMEOUT_MS);
      lister(machine).then((ids) => {
        clearTimeout(timer);
        if (ids.length) { helperRemoteCache.set(machine, { ids, at: Date.now() }); helperRemoteFailedAt.delete(machine); }
        resolve(ids);
      }, (err) => { clearTimeout(timer); reject(err); });
    }).catch((err) => { helperRemoteFailedAt.set(machine, Date.now()); throw err; }).finally(() => { helperRemoteInFlight.delete(machine); });
    helperRemoteInFlight.set(machine, p);
  }
  return p;
}

/** 设置里每台远程机器的清单，并发拉，单台失败只标那台 `failed`。 */
function helperRemoteModelLists(force: boolean): Promise<MachineModelList[]> {
  return Promise.all(listRemoteTargets(KIROLEX_CONFIG_PATH).map(async (t): Promise<MachineModelList> => {
    const label = t.label || t.sshHost;
    if (!remoteKiroBin(t)) return { machine: t.id, label, status: 'failed', ids: [], error: tr('No kiro launch command is set for {host} yet (Settings → 🖥 Machines).', { host: t.sshHost }) };
    try {
      const ids = await helperRemoteIds(t.id, force);
      return ids.length ? { machine: t.id, label, status: 'ok', ids } : { machine: t.id, label, status: 'failed', ids: [], error: 'empty' };
    } catch (err: any) {
      return { machine: t.id, label, status: 'failed', ids: [], error: String(err?.message || err) };
    }
  }));
}

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
  const models = [model, fallback].filter((m, i, arr) => !!m && arr.indexOf(m) === i);
  /*
    **先按真实清单筛一遍** —— 否则这个循环只是把同一个失败付两遍（每次最多 60 秒）。
    本机清单问不到就原样保留：没依据的时候照旧试，慢总比不做好。

    **本机没有的去远程机器上找**（`helperModels.ts`）：本机 kiro-cli 会被地域过滤（一个 Claude 都不报），
    同一个账号在远程机器上是全的。设置里选的模型只有远程有 → 到报了它的那台上跑同一条一次性调用；
    远程也失败才走备用 / MODEL_FALLBACK_ORDER。远程清单只在本机缺、或本机清单问不到的时候才去问（有缓存）。
  */
  const available = await localModelIds();
  /* 本机清单问不到（超时 / 没配启动命令）也要看远程：下拉里已经确认在远程能用的模型，不能因为本机问不到就只在本机白试 */
  const needRemote = models.some((m) => !available.includes(m));
  const remotes = needRemote ? await helperRemoteModelLists(false) : [];
  const route = planHelperRoute({
    wanted: models, local: available, fallbackOrder: MODEL_FALLBACK_ORDER,
    remotes: remotes.filter((l) => l.status === 'ok').map((l) => ({ machine: l.machine, ids: l.ids })),
  });
  if (route.substituted) {
    /* 都没有：挑一个本机清单里真有的，并说清是谁替了谁 —— 悄悄换掉才是那个查了很久的病（设置里也会写出来） */
    logger.warn(label, `设置里的辅助模型（${models.join('、')}）本机和远程机器上都没有 -> 用 ${route.effective}`
      + `（本机清单：${available.join(', ')}）`);
  }
  let lastError: any = null;
  for (const attempt of route.attempts) {
    const m = attempt.model;
    if (attempt.machine !== HELPER_LOCAL_MACHINE) {
      try {
        const target = findRemoteTarget(KIROLEX_CONFIG_PATH, attempt.machine);
        const bin = target ? remoteKiroBin(target) : undefined;
        if (!target?.sshHost || !bin) throw new Error(`找不到机器 ${attempt.machine} 或它没配 kiro 启动命令`);
        /* 和本机一样靠 agent JSON 钉模型（`--model` 不生效）；prompt 走 stdin */
        const raw = await runRemoteCapture(target, remoteLiteScript(bin, LITE_AGENT, REMOTE_LITE_AGENT, m), 90_000, undefined, prompt);
        const out = parseRemoteLiteOutput(raw);
        if (out === null) throw new Error(`没有正常输出：${raw.trim().slice(0, 200) || '（空）'}`);
        logger.info(label, `辅助模型 '${m}' 本机没有 -> 在 ${target.label || target.sshHost} 上跑`);
        if (m !== route.attempts[0].model) logger.warn(label, `helper model '${route.attempts[0].model}' unusable -> answered with fallback '${m}'`);
        return out;
      } catch (err: any) {
        lastError = err;
        logger.warn(label, `model '${m}' on ${attempt.machine} failed: ${err?.message || err}`);
        continue; // next attempt
      }
    }
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

/** 已经说过「辅助小任务对这条 Claude Code / Codex 会话不跑」的会话 —— 一条会话只说一次 */
const liteSkipNoticed = new Set<string>();
/**
 * 这条会话的辅助小任务（标题 / 追问建议 / 记忆整理）要不要跳过 —— 判据在 `liteHelperSkipReason`（engines.ts）。
 * 跳过时第一次在会话里说一句、记一行日志；之后静默跳过（不起进程、不重试）。不知道是哪条会话（老调用方没带 id）→ 照旧跑。
 */
function skipLiteHelperFor(sessionId: string | null | undefined, what: string): boolean {
  if (!sessionId) return false;
  let profile: AgentProfile | undefined;
  try { profile = sessionClients.get(sessionId)?.profile || store.readRecord(sessionId)?.profile; } catch { /* 读不到 = 不知道 */ }
  const reason = profile ? liteHelperSkipReason(engineOf(profile)) : null;
  if (!reason) return false;
  if (!liteSkipNoticed.has(sessionId)) {
    liteSkipNoticed.add(sessionId);
    logger.info('lite', `${what} skipped sessionId=${sessionId} engine=${engineOf(profile)} —— 辅助小任务只用 kiro 跑，不把这条会话交给它`);
    sessionNotice(sessionId, reason, { group: 'lite-helper-skip' });
  }
  return true;
}

async function maybeConsolidateSessionMemory(sessionId: string): Promise<void> {
  if (!isFeatureEnabled('sessionMemory')) return;
  if (refuseAdvancedOnly(sessionId, 'consolidate-memory')) return;
  /* Claude Code / Codex 会话：不整理（原来起 kiro-cli，没装就每轮失败重试一次；装了就是把内容交给另一家） */
  if (skipLiteHelperFor(sessionId, 'session-memory')) return;
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
    /* 已有记忆超过上限（多半是用户手写的大份记忆）：不自动整理 —— 整理只产出 ≤12 行，写回就把它压没了；也不花这次模型调用。
       进度照记，不然每一轮都来判一次、写一行日志 */
    const skip = autoConsolidationSkipReason(existing);
    if (skip) {
      logger.info('memory', `session ${sessionId}: ${skip}`);
      store.patchRecord(sessionId, { memoryConsolidatedAt: messages.length } as any);
      return;
    }
    /* 只喂最近这一段:更早的已经被上一次压缩吸收进 existing 了,再喂一遍是重复付钱 */
    const recent = messages
      .slice(-CONSOLIDATE_EVERY * 2)
      /*
        **KiroLex 自己的通知不能进记忆** —— 这一条比别处都要紧：记忆是压缩完永久留着、
        而且每一轮都注入的。一句「⚠️ 这条会话现在跑在 gpt-5.6-sol 上」被压进去，
        之后每一轮模型都会读到它，一句临时通知就变成了长期上下文。判据见 `kirolexNote`。
      */
      .filter(modelFacing)
      .map((m: any) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${String(m.role === 'assistant' ? foldTextToolCall(m.content || '', m.toolTailFrom) : m.content || '').slice(0, 800)}`)
      .join('\n\n');
    if (!recent.trim()) return;
    const produced = cleanLiteOutput(await runLiteOneShot(buildConsolidationPrompt(recent, stripTextToolCalls(existing)), 'session-memory'));
    /* 早先压进记忆的文字版调用块（`<invoke …>`）这一次清掉 —— 记忆每一轮都注入，留着就是一轮一轮喂回模型（sessionMemory.ts / textToolCall.ts）。
       null = 不写：没变化，或者没清理、这次也没产出（别把已有记忆清成空）；清理后为空照样写回 */
    /*
      **等这一次调用的几秒里会话可能被删了**：再写 writeMemory / 记录就把它的目录重新建出来。
      记录也只补这一个字段 —— 上面那份 record 是 await 之前读的，整份写回会把这期间换后端 / 换机器写进去的
      cliSessionId、profile 等改回旧值。
    */
    if (deletedSessionIds.has(sessionId) || !store.readRecord(sessionId)) return;
    /* 写回前先备份原文件（和手动压缩同一套 backupMemoryLayer）；新结果行数变少时只追加、不删旧行（sessionMemory.ts） */
    applyAutoConsolidation(existing, produced, {
      /* 等模型那几秒里用户可能刚保存了手写记忆：和调用前读的不一样就不写，大小判断 / 合并 / 备份都得针对当前文件 */
      readCurrent: () => readMemory(projectId, sessionId).session || '',
      backup: () => backupMemoryLayer('session', projectId, sessionId, new Date().toISOString().replace(/[:.]/g, '-')),
      write: (merged) => {
        writeMemory('session', projectId, sessionId, merged);
        logger.info('memory', `session ${sessionId}: consolidated at ${messages.length} messages (${merged.length} chars)`);
      },
      log: (message) => logger.info('memory', `session ${sessionId}: ${message}`),
    });
    store.patchRecord(sessionId, { memoryConsolidatedAt: messages.length } as any);
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
  const marker = tr('\n…[{n} characters omitted]…\n', { n: dropped });
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
  return tr(' (the largest tool output was {k}K characters, likely what broke it; next time add `--query` / `| head` to that command)', { k: Math.round(n / 1000) });
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
type BusyReason = 'creating' | 'turn' | 'reconfiguring' | 'attaching' | 'priming' | 'prime-pending' | null;
function busyReasonFor(sessionId: string): BusyReason {
  /* 还在新建（执行器没起来）：占用 —— 这时发的消息进排队，就绪后自动发出 */
  if (creations.creating(sessionId)) return 'creating';
  if (reconfiguringSessions.has(sessionId)) return 'reconfiguring';
  if (attachingSessions.has(sessionId)) return 'attaching';
  const entry = sessionClients.get(sessionId);
  if (entry?.priming) return 'priming';
  /* 后端自己起的那一轮（autonomousTurn.ts）界面上也是一轮：渲染端接管它的流，结束信号就是这里不再报 turn */
  if (entry?.busy || entry?.autonomous) return 'turn';
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
  /* 重建进度是 tr() 出来的：两版一起带过去，界面切了语言这一行也跟着换 */
  const detailVariants = detail ? bothLangs(detail) : null;
  mainWindow?.webContents.send('acp:session-busy', { sessionId, reason, detail, ...(detailVariants ? { detailVariants } : {}) });
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
  toolTailFrom?: number;
  question?: QuestionCard;
}, forExecutor: (p: string) => string = (p) => p): string {
  const who = m.role === 'user' ? 'User' : 'Assistant';
  /* 提问卡片（正文是空的）：重建历史时把「问了什么、答了什么」交代给模型 */
  if (m.question) return `${who}: ${questionTailText(m.question)}`;
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
  /* 助手把工具调用写成了文字（没执行）的那段折叠成一句说明 —— 原样喂回去，模型会越学越像（textToolCall.ts） */
  const body = m.role === 'user' ? m.content : foldTextToolCall(m.content, m.toolTailFrom);
  return capImagePathsInText(`${who}: ${body}${actions}${tail}`);
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
    /* kiro 绑进程；Claude Code / Codex 的会话存在适配器那边，同一个后端会话 id 就够（见 `contextMarkerHolds`） */
    return !!rec && contextMarkerHolds(engineOf(entry.profile),
      { for: rec.contextEstablishedFor, pid: rec.contextEstablishedPid },
      { cliSessionId: entry.cliSessionId, pid: entry.client.pid });
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
    /* 有预算，不再整份全渲：实测 696 KB 的 history.md 让后端只回一句笼统的 `Internal error`。
       判据和"丢了要说出来"都在 `historyBudget.ts`；丢掉的部分不静默 —— 顶部那句说明给模型看，
       日志那句给人对账。 */
    const fitted = fitHistory(lines.map((line) => ({ line })));
    const note = historyTrimNote(fitted.dropped, lines.length);
    if (fitted.dropped) {
      logger.warn('prime', `history trimmed sessionId=${sessionId} kept=${fitted.kept.length}/${lines.length}`
        + ` bytes=${fitted.bytes} (budget ${HISTORY_BUDGET_BYTES})`);
    }
    const path = store.writeHistoryFile(
      sessionId,
      `# ${sessionId} — 对话历史（由 KiroLex 从自身记录渲染）\n`
      + `# 渲染时间 ${new Date().toISOString()}，共 ${lines.length} 条消息，`
      + `这份带 ${fitted.kept.length} 条\n`
      + note
      + `\n${fitted.kept.map((e) => e.line).join('\n\n---\n\n')}\n`,
    );
    return { path, count: fitted.kept.length };
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
    // 这句必须和文件里真有多少条一致：history.md 有预算，截断后还写「未删减」，
    // 模型会把半份历史当全部，对"之前说过什么"给出自信的错答案。
    // `rendered.count` 是实际写进文件的条数（`fitHistory` 之后）。
    (() => {
      const inFile = rendered?.count ?? lines.length;
      const missing = lines.length - inFile;
      const claim = missing > 0
        ? `这个文件里是**最近 ${inFile} 条**（共 ${lines.length} 条，更早的 ${missing} 条超出上下文预算没有写进去）`
        : `完整历史原文（全部 ${lines.length} 条消息，未删减）`;
      return `${claim}保存在这个文件里：\n${historyPath}\n这个文件会随本会话继续更新，任何时候重新读它拿到的都是最新的记录。`
        + `下面只内联了最近 ${recent.length} 条${omitted > 0 ? `，更早的 ${omitted} 条没有内联` : ''}。`
        + '凡是需要更早的细节、原话或数字，直接读这个文件，不要凭印象作答，也不要说“不记得”。'
        + (missing > 0 ? `文件里也没有的那 ${missing} 条，**问用户**，不要推断。` : '');
    })(),
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
    return { ok: false, error: tr('This session is not connected yet. Open it first, then rebuild history.') };
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
          return { ok: false, error: tr('The session reconnected; rebuilding history will start over.') };
        }
        if (entry.primeAbandoned) {
          logger.info('prime', `ABORT sessionId=${sessionId} reason=user-abandoned mid-rebuild cursor=${entry.primeCursor}/${chunks.length}`);
          return { ok: false, error: tr('You gave up rebuilding history') };
        }
        const i = entry.primeCursor || 0;
        const totalNow = chunks.length;
        const retryNote = sameChunkFailures ? tr(' (attempt {n})', { n: sameChunkFailures + 1 }) : '';
        entry.primeDetail = totalNow > 1
          ? tr('Rebuilding history {i}/{total}{retry}', { i: i + 1, total: totalNow, retry: retryNote })
          : tr('Rebuilding history{retry}', { retry: retryNote });
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
              const failedModel = entry.profile.model;
              const swapped = await swapSessionModel(sessionId, failedModel, `prime ${sessionId}`, tried);
              if (swapped) {
                logger.info('prime', `model unavailable during rebuild sessionId=${sessionId} swapped=${swapped} tried=${Array.from(tried).join(',')}`);
                /*
                  **换了模型要在会话里说一句**（AGENTS.md §4.6「悄悄换了的地方都要说一句」）—— 原来只出现在重建失败原因里。
                  走 `modelFallback`：同一对「失败的 → 换成的」每条会话只说一次（重建每次重来都会走到这里）。
                */
                modelFallback.note(sessionId, failedModel, swapped, trConcat(
                  tr('🔀 Model "{from}" is unavailable, so this session switched to "{to}"; rebuilding history starts over.', { from: failedModel, to: swapped }),
                  NOTE_DETAIL_SEP,
                  tr('Error while rebuilding history: {msg}', { msg }),
                ));
                modelFallback.commit(sessionId);
                return { ok: false, error: tr('Model unavailable, switched to {to}; rebuilding history starts over ({msg})', { msg, to: swapped }) };
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
          entry.primeDetail = tr('Rebuilding history {i}/{total} failed, retrying in {s}s', { i: i + 1, total: totalNow, s: Math.round(wait / 1000) });
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
      /*
        **重建占着会话期间选的切换，重建一结束（正常完成 / 被 Stop）就应用** —— 重建也设 busy，
        那段时间的切换都被记成了 pending，而它不走 sendPromptOnce 的收尾。
        等着这次重建的那条消息会在 sendPromptOnce 里等这批落定、按新执行器重走（见那边）。
      */
      void pendingSwitchRunner.kick(sessionId);
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
function sessionNotice(sessionId: string, text: string, extra?: { copyRemote?: string[]; group?: string }): void {
  try {
    /* `copyRemote`：远程会话里落在远端的交付文件 —— 状态行上给每个一颗「⇩ 复制到本机」（`workspace:copy-remote-to-local`） */
    /* `variants`：这句话的中英两版（tr() 出来的才有）—— 界面切了语言，挂着的这句也跟着换 */
    const variants = bothLangs(text);
    /* `group`：同类提示的键（「类型:对象」）—— 还挂着时又来同类的一句，界面只计数不刷新一条（`noticeMerge`） */
    mainWindow?.webContents.send('session:notice', { sessionId, text, ts: Date.now(), ...(variants ? { variants } : {}), ...(extra?.copyRemote?.length ? { copyRemote: extra.copyRemote } : {}), ...(extra?.group ? { group: extra.group } : {}) });
  } catch { /* 提示永远不能让主流程失败 */ }
  logger.info('notice', `${sessionId}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
}

/**
 * 同 `sessionNotice`，但**不自动消失**：一直挂到这条会话的下一句提示把它换掉
 * （「本机工具连接中断，正在重连（第 N 次）」要挂到连上为止，连上时那句"回来了"把它顶掉）。
 * `pinned`：别的提示也不换掉它 —— 盖在上面的那句淡出后回到它（见 `sessionNoticeHub` 的 `pinned`）。
 */
function stickySessionNotice(sessionId: string, text: string, group?: string, opts?: { pinned?: boolean }): void {
  try {
    const variants = bothLangs(text);
    mainWindow?.webContents.send('session:notice', { sessionId, text, ts: Date.now(), sticky: true, ...(opts?.pinned ? { pinned: true } : {}), ...(variants ? { variants } : {}), ...(group ? { group } : {}) });
  } catch { /* 提示永远不能让主流程失败 */ }
  logger.info('notice', `${sessionId}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
}

/** 撤掉这条会话 group 以 `prefix` 开头的钉住提示 —— 换了机器 / 引擎，旧的那句说的已经不是现状（见 `adapterNotes.forgetPinned`） */
function unpinSessionNotice(sessionId: string, prefix: string): void {
  try {
    mainWindow?.webContents.send('session:notice', { sessionId, text: '', ts: Date.now(), unpin: prefix });
  } catch { /* 提示永远不能让主流程失败 */ }
}

/**
 * **本地工具通道** ——「把镜像去掉，给远程配一些能调用本地 MCP 的能力」。
 *
 * 一个 MCP server（只听 127.0.0.1），每条远程会话一个 token + 一个远端端口。
 * server 懒启动：没有远程会话的时候不开端口。
 */
let localMcpServer: LocalMcpServer | undefined;
type LocalToolsSpec = { remotePort: number; localPort: number; agentOverride: string; forwarded?: string[]; forwardedHttp?: string[]; mcpServers?: any[]; skipped?: Array<{ name: string; reason: string }>; unavailable?: ForwardUnavailable[] };
const localToolsBySession = new Map<string, LocalToolsSpec>();

/**
 * 一个中转 HTTP MCP 的探测结果记到**这份** spec 上 —— 以前失败只发一句提示，会话信息和运行环境说明照旧列为可用。
 * spec 已被换掉（重连 / 换组合又准备了一遍）就不记：那一轮有它自己的探测。成功清掉（重连重探的那次）；
 * 失败不摘代理，远端下次调用成功时由 local MCP 服务的 `onProxyOk` 清掉（见 `forwardRecovered`）。
 * 返回 true = 这次失败记下了，调用方在会话里说一句（`httpProbeNotice`）。
 */
function noteHttpProbe(sessionId: string, spec: LocalToolsSpec, name: string, r: { ok: boolean; toolCount: number; error?: string }): boolean {
  if (localToolsBySession.get(sessionId) !== spec) return false;
  if (r.ok) {
    clearForwardUnavailable(spec, name);
    logger.info('localmcp', `中转 MCP「${name}」探测通过：${r.toolCount} 个工具 sessionId=${sessionId}`);
    return false;
  }
  markForwardUnavailable(spec, name, r.error || '');
  logger.warn('localmcp', `中转 MCP「${name}」探测失败 sessionId=${sessionId}: ${r.error}`);
  return true;
}

/** `onProxyOk`：远端再调通了一个记成不可用的中转 MCP：清掉（会话信息、下一轮的运行环境说明跟着恢复），说一句。 */
function forwardRecovered(sessionId: string, name: string): void {
  const lt = localToolsBySession.get(sessionId);
  if (!lt || !clearForwardUnavailable(lt, name)) return;
  logger.info('localmcp', `中转 MCP「${name}」调用成功，恢复为可用 sessionId=${sessionId}`);
  sessionNotice(sessionId, tr('✅ The MCP "{name}" forwarded from this machine works again.', { name }));
}

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
    browser: {
      enabled: () => localBrowser().enabled(),
      call: (name, args, sid) => localBrowser().tools.call(name, args, sid),
    },
    wake: wakeMcpTools,   /* schedule_* / bg_* / watch（见 wakeTools.ts） */
    sessions: sessionMcpTools,
    onProxyOk: forwardRecovered,
  }).then((srv) => { localMcpServer = srv; return srv; })
    .finally(() => { localMcpStarting = undefined; });
  return localMcpStarting;
}

/**
 * **local_browser** —— 接管用户已登录的 Chrome / Edge / Firefox 读页面（`localBrowser.ts`）。
 *
 * 懒建：`KIROLEX_CONFIG_PATH` 定义在这个文件更后面，模块求值到这里时还不能碰它。
 * 连接单例在它的 `manager` 里：所有会话共用、每个浏览器一条连接，退出时 `before-quit` 收掉。
 */
let localBrowserHost: LocalBrowserHost | undefined;
let browserActionSeq = 0;
let browserStatusTimer: NodeJS.Timeout | undefined;
function localBrowser(): LocalBrowserHost {
  if (localBrowserHost) return localBrowserHost;
  localBrowserHost = new LocalBrowserHost({
    configPath: KIROLEX_CONFIG_PATH,
    log: (level, message) => logger[level]('browser', message),
    sendAsk: (ask) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      mainWindow.webContents.send('browser:domain-ask', ask);
      /* 用户多半正看着浏览器：让 KiroLex 的窗口闪一下，确认框才不会没人看见 */
      try { if (!mainWindow.isFocused()) mainWindow.flashFrame(true); } catch { /* 不支持就算了 */ }
      return true;
    },
    onAsksCancelled: (ids) => { mainWindow?.webContents.send('browser:domain-ask-cancelled', ids); },
    onStatus: () => {
      if (browserStatusTimer) return;
      browserStatusTimer = setTimeout(() => {
        browserStatusTimer = undefined;
        mainWindow?.webContents.send('browser:status-changed');
      }, 200);
    },
    filesDir: (sid) => sessionFilesDir(sid),
    onAction: (sid, a) => noteBrowserAction(sid, a),
    /* 截图进会话之前就压到长边 1500（AGENTS.md §4.7：一张大图能让整条会话永久报错） */
    capPng: (png) => {
      const img = nativeImage.createFromBuffer(png);
      if (img.isEmpty()) return png;
      const capped = capImageSize(img);
      return capped.from ? capped.img.toPNG() : png;
    },
  });
  return localBrowserHost;
}

/**
 * 每一次浏览器操作都进**回合面板**（「🌐 浏览器操作」）：作为一条 `kind: 'browser'` 的工具调用
 * 走和后端工具调用同一条 `update` 路（落盘、发给界面都是现成的），标题就是"打开了什么 / 读了多少字 / 截图在哪"。
 */
function noteBrowserAction(sessionId: string, a: BrowserAction): void {
  logger.info('browser', `${a.action} ok=${a.ok} browser=${a.browser} url=${a.url || '-'}${a.chars !== undefined ? ` chars=${a.chars}/${a.total}` : ''}${a.path ? ` path=${a.path}` : ''}${a.error ? ` error=${a.error.slice(0, 200)}` : ''} sessionId=${sessionId}`);
  const entry = sessionClients.get(sessionId);
  if (!entry) return;
  browserActionSeq += 1;
  const toolCallId = `kbrowser_${Date.now()}_${browserActionSeq}`;
  const status = a.ok ? 'completed' : 'failed';
  const title = browserActionTitle(a);
  entry.client.emit('update', { sessionId: entry.cliSessionId, update: { sessionUpdate: 'tool_call', toolCallId, title, kind: 'browser', status } });
  /* 再补一条终态 update：界面上"正在跑的工具"那一格靠它清掉 */
  entry.client.emit('update', { sessionId: entry.cliSessionId, update: { sessionUpdate: 'tool_call_update', toolCallId, status } });
}

/**
 * **本地会话也挂上本地工具通道**（kirolex-local）：作为一个 http MCP 交给 session/new / load。
 * 本地会话只拿「过一会儿再看」那组工具（`schedule_*` / `bg_*` / `watch`，见 wakeTools.ts），
 * 外加总开关开着时的浏览器那几个（`browserOnly`：不给 `local_read` / `local_bash` —— 它们自己就有原生读写和 shell）。
 * kiro-cli 和两个适配器的 initialize 都声明了 `mcpCapabilities.http`。浏览器开关关着时浏览器工具不列（见 `toolDefs`）。
 */
async function withLocalBrowser(
  sessionId: string,
  spec: { remotePort: number; localPort: number; agentOverride: string; mcpServers?: any[] } | undefined,
): Promise<{ remotePort: number; localPort: number; agentOverride: string; mcpServers?: any[] } | undefined> {
  try {
    const server = await ensureLocalMcpServer();
    server.register({ sessionId, workdir: sessionFilesDir(sessionId), browserOnly: true });
    const urlPath = server.urlPathFor(sessionId);
    if (!urlPath) return spec;
    const mcp = { type: 'http', name: 'kirolex-local', url: `http://127.0.0.1:${server.port()}${urlPath}`, headers: [] };
    const base = spec || { remotePort: 0, localPort: 0, agentOverride: '' };
    logger.info('localmcp', `本地会话挂上 kirolex-local（定时 / 后台命令${localBrowser().enabled() ? ' / local_browser' : ''}）sessionId=${sessionId}`);
    return { ...base, mcpServers: [...(base.mcpServers || []), mcp] };
  } catch (err: any) {
    logger.warn('localmcp', `本地会话挂 kirolex-local 失败 sessionId=${sessionId}: ${err?.message || err}`);
    return spec;
  }
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

/**
 * 每条远程会话用的是哪台机器的复用连接（sessionId → muxKey）。
 *
 * 自愈要问"这台机器上还有会话吗"，而只看 `sessionClients` 会漏掉**正在 attach** 的那条：
 * 它的执行器还没登记，可它刚拿着这条连接的端口。实测就是这个口子 —— 连接"建立"后 0.06 秒
 * 退出，那一刻唯一的会话还在 attach，于是判成"没有会话"、重建被悄悄放弃，之后再也没人试。
 */
const muxUsers = new Map<string, string>();
/** 正在重连那几台机器上、已经被告知"中断了"的会话 —— 连上后要跟它们说一声"回来了"。 */
const muxDownNoticed = new Map<string, Set<string>>();

/** 这条会话所选的组合（读不了 / 找不到时退回「通用」并在会话里说一句）。本地和远程会话共用。 */
function sessionCombo(sessionId: string, profile: AgentProfile): McpCombo {
  const { combos, error } = readMcpCombos(os.homedir());
  const combo = pickCombo(combos, profile.mcpCombo);
  if (error) {
    logger.warn('mcp-combo', `${mcpCombosPath(os.homedir())} 读不了：${error}`);
    if (profile.mcpCombo && profile.mcpCombo !== BUILTIN_COMBO_ID) {
      sessionNotice(sessionId, tr('⚠️ The combo file has an error ({error}), so this time it starts as "General" with no MCP attached.', { error }));
    }
  } else if (profile.mcpCombo && combo !== findCombo(combos, profile.mcpCombo)) {
    sessionNotice(sessionId, tr('⚠️ Combo "{wanted}" not found (it may have been deleted), so this time it starts as "{used}".', { wanted: profile.mcpCombo, used: comboDisplayName(combo) }));
  }
  return combo;
}

/**
 * **本地 Claude Code / Codex 会话的「组合」** ——「不同对话挂不同的 MCP」。
 *
 * 所选组合里没 disabled 的 MCP 按 ACP 格式交给 session/new / load 的 `mcpServers`（环境变量在这里展开，
 * 用的是登录 shell 的环境）。`forwardFromLocal` 在本地会话里不起作用。缺环境变量的那一条跳过并在会话里说一句。
 * 借 `localTools` 那个参数交给 `AcpClient`（端口字段对本地会话没意义，填 0）。kiro 会话不走这里。
 */
function localComboTools(
  sessionId: string, profile: AgentProfile,
): { remotePort: number; localPort: number; agentOverride: string; mcpServers?: any[] } | undefined {
  if (engineOf(profile) === 'kiro') return undefined;
  const combo = sessionCombo(sessionId, profile);
  const { servers, skipped } = buildAcpMcpServers(combo, shellEnv as Record<string, string | undefined>);
  for (const s of skipped) {
    sessionNotice(sessionId, tr('⚠️ MCP "{mcp}" in combo "{combo}" needs environment variable(s) {vars}, not set on this machine; it is skipped this time.', { mcp: s.name, combo: comboDisplayName(combo), vars: trList(s.missing) }));
  }
  if (!servers.length) return undefined;
  logger.info('mcp-combo', `组合「${combo.name}」挂 ${servers.length} 个 MCP sessionId=${sessionId}: ${JSON.stringify(maskAcpServers(servers))}`);
  return { remotePort: 0, localPort: 0, agentOverride: '', mcpServers: servers };
}

async function ensureLocalTools(
  sessionId: string,
  profile: AgentProfile,
  localDir: string,
): Promise<{ remotePort: number; localPort: number; agentOverride: string; forwarded?: string[]; forwardedHttp?: string[]; mcpServers?: any[] } | undefined> {
  const remote = profile.remote;
  /* 本地会话：组合里的 MCP 之外再挂 kirolex-local（定时 / 后台命令，开关开着时还有浏览器，见 `withLocalBrowser`） */
  if (!remote?.sshHost) return withLocalBrowser(sessionId, localComboTools(sessionId, profile));
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
      muxUsers.set(sessionId, muxKey(remote.sshHost, remote.sshPort));
      remotePort = (await sshMux.ensure(remote)).remotePort;
    } else {
      /* 按会话分端口：把**自己当前那个**也算进"已占用"，避免"先起新的再关旧的"时撞上自己 */
      /*
        **还活着的 ssh 占着的端口也算** —— 实测：两条会话前后两秒各切到 Claude Code，第一条把自己那格
        从 39101 改成 39102（表里 39101 就"空"了），可它旧的 ssh 要等新的连上才关、还占着 39101；
        第二条于是又分到 39101，`ExitOnForwardFailure=yes` 让它的 ssh 当场退出 →「连不上远程」。
      */
      /*
        **远端已经有人在听的端口也算** —— 另一台电脑上的 KiroLex、没被回收的旧连接占着 39100 时，
        只看自己分出去的就会一直分到它、一直失败（见 `LISTENING_PORTS_SCRIPT`）。每次准备都现问，
        所以一次撞车之后下一次重连自然换到别的端口。问不到就当没有，不挡会话。
      */
      const remoteBusy = await runRemoteCapture(remote, LISTENING_PORTS_SCRIPT, 15_000)
        .then(parseListeningPorts, () => [] as number[]);
      const used = [
        ...[...localToolsBySession.values()].map((v) => v.remotePort),
        ...[...sessionClients.values()].map((e) => e.client.forwardedRemotePort).filter((p): p is number => typeof p === 'number'),
        ...remoteBusy,
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
      /*
        **所选组合里「从本机转发」的那些也经这条隧道** —— 规则见 `forwardableFromCombo`。
        本机这份 `entries`（上游 url / 头 / env）只交给 setProxies；远端适配器只拿到 `<隧道>/<名字>`。
        每次准备都 setProxies 一遍（没有就是空表）：换组合 / 换机器 / 重连时上一批代理和本机进程先停掉，
        会话结束时 `releaseLocalTools` → `forget` 停掉 —— 和 Kiro 同一条生命周期。
      */
      /*
        **设置里那份「远程会话从本机转发的 MCP」名单也算进来** ——「远程 Claude Code / Codex 会话没有本地工具」。
        以前这里只看组合，没选组合（内置「通用」是空的）就只剩 kirolex-local。名单只存名字，定义去本机 Kiro 配置里找；
        和组合按名字去重，同名以组合为准（规则见 `adapterForwardPlan`）。Claude Code 和 Codex 都走这里。
      */
      const combo = sessionCombo(sessionId, profile);
      const { entries, skipped, fromCombo, fromList } = adapterForwardPlan({
        comboServers: combo.mcpServers,
        list: loadForwardMcpList(),
        sources: localKiroMcpSources(os.homedir(), profile.kiroAgent),
        env: shellEnv as Record<string, string | undefined>,
      });
      /* 跳过的记下来给「会话信息」（`acp:session-info` 的 localTools）；会话里照旧一条一条说 */
      const skippedReasons: Array<{ name: string; reason: string }> = [];
      for (const s of skipped) {
        if (s.origin === 'list') {
          sessionNotice(sessionId, tr('⚠️ MCP "{mcp}" in the "forward from this machine" list can\'t be forwarded ({reason}); it is skipped this time.', { mcp: s.name, reason: String(s.reason) }));
          skippedReasons.push({ name: s.name, reason: String(s.reason) });
          continue;
        }
        sessionNotice(sessionId, s.missing
          ? tr('⚠️ MCP "{mcp}" in combo "{combo}" needs environment variable(s) {vars}, not set on this machine; it is skipped this time.', { mcp: s.name, combo: comboDisplayName(combo), vars: trList(s.missing) })
          : tr('⚠️ MCP "{mcp}" in combo "{combo}" can\'t be forwarded from this machine ({reason}); it is skipped this time.', { mcp: s.name, combo: comboDisplayName(combo), reason: String(s.reason) }));
        skippedReasons.push({ name: s.name, reason: s.missing ? tr('missing environment variable(s) {vars}', { vars: trList(s.missing) }) : String(s.reason) });
      }
      server.setProxies(sessionId, entries);
      const http = entries.filter(isHttpForward);
      const spec: LocalToolsSpec = {
        remotePort, localPort: server.port(), agentOverride,
        forwarded: entries.filter((e) => !isHttpForward(e)).map((e) => e.name),
        forwardedHttp: http.map((e) => e.name),
        mcpServers: [mcp, ...remoteComboMcpServers(entries, mcpUrl(remotePort, urlPath))],
        skipped: skippedReasons,
      };
      if (entries.length) {
        logger.info('localmcp', `转发本机 MCP 给 sessionId=${sessionId}：${entries.map((e) => e.name).join(', ')}`
          + `（组合「${combo.name}」：${fromCombo.join(', ') || '无'}；设置名单：${fromList.join(', ') || '无'}）`);
      }
      if (skippedReasons.length) {
        logger.info('localmcp', `没转发 sessionId=${sessionId}：${skippedReasons.map((s) => `${s.name}（${s.reason}）`).join('; ')}`);
      }
      localToolsBySession.set(sessionId, spec);
      toollessSessions.delete(sessionId);
      /* 探测，但不挡会话（同 Kiro 分支）；先登记 spec，失败才记得到它上面（`noteHttpProbe`） */
      for (const h of http) {
        void probeHttpMcp(h, { log: (level, message) => logger[level]('localmcp', message) })
          .then((r) => { if (noteHttpProbe(sessionId, spec, h.name, r)) sessionNotice(sessionId, httpProbeNotice(h.name, r.error || '')); })
          .catch(() => { /* 探测永远不能让会话准备失败 */ });
      }
      logger.info('localmcp', `本地工具已备好（${ENGINE_LABEL[engineOf(profile)]}，走 mcpServers）sessionId=${sessionId} 远端端口=${remotePort} workdir=${localDir}`);
      return spec;
    }
    /*
      设置里那份「远程会话从本机转发的 MCP」名单也算进来（妙想这类 HTTP MCP 由本机代发到上游）。
      远端 agent 里只写隧道地址 —— 上游 url / 头 / 密钥只在本机这份 forwardable 里（见 `remoteForwardPlan`）。
    */
    const forwardable = profile.kiroAgent ? forwardableFrom(localAgentJson(profile.kiroAgent), loadForwardMcpList()) : [];
    server.setProxies(sessionId, forwardable);
    const plan = remoteForwardPlan(forwardable, mcpUrl(remotePort, urlPath));
    const forwarded = plan.forwarded;
    const agentOut = await runRemoteCapture(remote,
      remoteAgentScript(agentOverride, profile.kiroAgent, mcpUrl(remotePort, urlPath), plan.forwarded, plan.dropUpstream));
    if (forwarded.length) {
      logger.info('localmcp', `转发本机 MCP 给 sessionId=${sessionId}：${forwarded.map((f) => f.name).join(', ')}`);
    }
    for (const dup of parseDroppedDupes(agentOut)) {
      logger.info('localmcp', `远端 agent 里的「${dup}」和本机中转的 MCP 指向同一上游，已从会话 agent 剔除（远端原文件没动）sessionId=${sessionId}`);
    }
    /*
      **探测，但不挡会话**：密钥错 / 上游连不上时在会话里说一句（同「本地工具通道没起来」那种提示），
      会话照常起来 —— local_* 和别的转发都不受影响，调到这个 MCP 时也会拿到同样可读的错误。
      （探测放在下面 spec 登记之后：失败要记到那份 spec 上，见 `noteHttpProbe`。）
    */
    const usedBase = parseAgentBase(agentOut);
    if (profile.kiroAgent && usedBase === 'default') {
      sessionNotice(sessionId, tr('⚠️ {host} has no agent "{agent}", so the default agent is used. To use it, create a config with that name on that machine.', { host: remote.sshHost, agent: profile.kiroAgent }));
      logger.warn('localmcp', `远端没有 agent ${profile.kiroAgent}，退到默认 sessionId=${sessionId}`);
    } else if (usedBase && usedBase !== 'default') {
      logger.info('localmcp', `远端用它自己的 agent「${usedBase}」做底子 sessionId=${sessionId}`);
    }
    const spec: LocalToolsSpec = {
      remotePort, localPort: server.port(), agentOverride,
      forwarded: plan.stdioNames,
      forwardedHttp: plan.httpNames,
    };
    localToolsBySession.set(sessionId, spec);
    toollessSessions.delete(sessionId);
    for (const h of forwardable.filter(isHttpForward)) {
      void probeHttpMcp(h, { log: (level, message) => logger[level]('localmcp', message) })
        .then((r) => { if (noteHttpProbe(sessionId, spec, h.name, r)) sessionNotice(sessionId, httpProbeNotice(h.name, r.error || '')); })
        .catch(() => { /* 探测永远不能让会话准备失败 */ });
    }
    logger.info('localmcp', `本地工具已备好 sessionId=${sessionId} 远端端口=${remotePort} 本地端口=${spec.localPort} workdir=${localDir}`);
    return spec;
  } catch (err: any) {
    /* 记下来：master 自愈回来之后要重接的就是这批（见 `rearmLocalToolsFor`） */
    toollessSessions.add(sessionId);
    /*
      没有复用连接的平台（Windows）没有 master 自愈，也就没有 onReady 来叫重接 ——
      交给 `remoteRecovery` 按退避一直试（每次重试都重新查远端占用、重新分端口）。
    */
    if (!muxSupported()) startRemoteRecovery(sessionId);
    sessionNotice(sessionId, tr('⚠️ The local tools connection failed ({error}); this remote session can\'t read or write your files for now. It reconnects automatically.', { error: String(err?.message || err) }));
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
    /* Claude Code / Codex 的适配器：上面两道认不出（命令行里没有 kiro 的 agent 前缀），按环境变量标记再扫一遍 */
    const adapterOrphans = parseAdapterSweep(await runRemoteCapture(target, adapterSweepScript(OWNER, null)));
    const adapterStale = parseAdapterSweep(await runRemoteCapture(target, adapterSweepScript(OWNER, heldExecutorsOn(target))));
    if (adapterOrphans + adapterStale > 0) {
      logger.warn('localmcp', `${target.sshHost}: 杀掉 ${adapterOrphans} 个孤儿、${adapterStale} 个没人持有的 Claude Code / Codex 适配器进程（${why}）`);
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
function releaseLocalTools(sessionId: string, remote?: RemoteTarget, opts: { keepToken?: boolean } = {}): void {
  const spec = localToolsBySession.get(sessionId);
  localToolsBySession.delete(sessionId);
  muxUsers.delete(sessionId);
  /* 换运行位置（远程 → 本机）时 token 已经交给了新执行器：只停中转，不作废（见 `releaseSessionTools`） */
  releaseSessionTools(localMcpServer, sessionId, { keepToken: opts.keepToken });
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
  if (!target?.sshHost) return Promise.reject(new Error(tr('Can\'t find this machine ({machine}). Was it removed in Settings?', { machine })));
  return new Promise((resolve, reject) => {
    execFile('ssh', [...buildSshArgs(target, `bash -lc ${shellQuote(script)}`)],
      { timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: sshEnv(target) }, (err, stdout, stderr) => {
        if (err && !String(stdout || '').includes('KX_BIN')) {
          /* SSH 的后量子告警每次都在，不是原因 —— 认它会让每次失败都指错（踩过） */
          const real = String(stderr || err.message).split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !/post-quantum|store now, decrypt later|openssh\.com|^\*\*/.test(l))[0];
          reject(new Error(real || tr('ssh exit code {code}', { code: String((err as any).code) })));
        } else resolve(String(stdout || ''));
      });
  });
}

/** 在远端跑一条命令并**拿回 stdout**（`writeRemoteFile` 丢掉输出）。 */
function runRemoteCapture(remote: RemoteTarget, script: string, timeoutMs = 60_000, maxBuffer?: number, stdin?: string): Promise<string> {
  return once(false);
  function once(sparedOnce: boolean): Promise<string> {
    const socket = sshMux.liveSocketFor(remote);
    return new Promise((resolve, reject) => {
      /* `stdin`：正文太长 / 带引号时从这里送（辅助模型的远程一次性调用把 prompt 走这条） */
      const child = execFile('ssh', [...buildSshArgs(remote, `bash -lc ${shellQuote(script)}`)],
        /* 默认 60 秒够所有探测用；`kiro-cli update` 要下一个几十 MB 的二进制，调用方会放宽 */
        /* `maxBuffer`：读大文件的调用方（「复制到本机」）要放宽，默认 1 MiB 装不下 base64 之后的正文 */
        { timeout: timeoutMs, encoding: 'utf8', env: sshEnv(remote), ...(maxBuffer ? { maxBuffer } : {}) },
        (err, stdout, stderr) => {
          if (err && !String(stdout || '')) {
            /* 复用连接 session 满了：换一条连接重试一次，还满就说人话（`onMuxSessionsFull`） */
            if (socket && sshErrorKind(String(stderr || '')) === 'sessions-full') {
              onMuxSessionsFull(remote, socket, sparedOnce).then((full) => {
                if (full.retry && !sparedOnce) once(true).then(resolve, reject);
                else reject(new Error(full.message));
              }, reject);
              return;
            }
            /* SSH 的后量子告警每次都在，不是原因 —— 认它会让每次失败都指错（踩过） */
            const real = String(stderr || err.message).split('\n').map((l) => l.trim())
              .filter((l) => l && !/post-quantum|store now, decrypt later|openssh\.com|^\*\*/.test(l))[0];
            reject(new Error(real || String(err.message)));
          } else resolve(String(stdout || ''));
        });
      if (stdin !== undefined) { try { child.stdin?.end(stdin); } catch { /* 命令已经退了 */ } }
    });
  }
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
      sessionNotice(sessionId, tr('⚠️ Ignored an unrecognised request for this machine: `{raw}` ({why}).', { raw: r.raw.slice(0, 120), why: r.why }));
    }
    for (const a of actions) {
      if (entry.openedLocally?.has(a.target)) continue;   // 同一个地址一条会话只开一次
      if ((entry.localActionsThisTurn || 0) >= MAX_LOCAL_ACTIONS_PER_TURN) {
        sessionNotice(sessionId, tr('⚠️ This turn already opened {n} pages, so `{target}` was not opened; click the link above if you need it.', { n: MAX_LOCAL_ACTIONS_PER_TURN, target: a.target }));
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
        /* 和同一组的另外几句一样走状态行：已经拦下了，不用你做什么 */
        sessionNotice(sessionId, tr('⚠️ Refused to open `{target}`: only http/https links can be opened on this machine.', { target: String(a.target).slice(0, 120) }));
        logger.warn('localaction', `拒绝非 http(s) 目标 sessionId=${sessionId} scheme=${scheme || '(解析不了)'}`);
        continue;
      }
      entry.localActionsThisTurn = (entry.localActionsThisTurn || 0) + 1;
      (entry.openedLocally ||= new Set()).add(a.target);
      const host = labelForHost(KIROLEX_CONFIG_PATH, entry.profile.remote?.sshHost) || tr('the remote');
      void shell.openExternal(a.target).then(
        () => sessionNotice(sessionId, tr('Opened `{target}` in your browser (requested from {host}).', { target: a.target, host })),
        (err: any) => sessionNotice(sessionId, tr('⚠️ Couldn\'t open `{target}`: {error}', { target: a.target, error: String(err?.message || err) })),
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
    forwardedHttp: localToolsBySession.get(sessionId)?.forwardedHttp,
    /* 探测失败的：不再列为可用，另说一句当前不可用（重试成功后清掉，下一轮就恢复） */
    unavailable: localToolsBySession.get(sessionId)?.unavailable,
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
 * 远端端口由那台机器的 sshd 分（`-R 127.0.0.1:0:…`），不再从 39100 起按机器递增 ——
 * 固定端口被别人（另一台电脑上的 KiroLex、没被回收的旧连接）占着时，重建会必然再失败。
 */
const sshMux: SshMux = new SshMux({
  log: (level, message) => logger[level]('sshmux', message),
  localPort: () => localMcpServer?.port() || 0,
  owner: OWNER,
  /*
    **自愈的判据：这台机器上还有连着的会话吗** —— 见 `sshMux.scheduleHeal`。
    没有会话就别敲门（机器可能已经关了），有会话就一直试 —— 那几条会话正指着它。
  */
  hasSessions: (key: string): boolean => muxSessionsOn(key).length > 0,
  /* 断了、排上了重建：那台机器上的每条会话都挂一句不会自己消失的提示，连上后由 onReady 顶掉 */
  onHealing: (key: string, attempt: number) => {
    const noticed = muxDownNoticed.get(key) || new Set<string>();
    muxDownNoticed.set(key, noticed);
    for (const sessionId of muxSessionsOn(key)) {
      /* 已经在 remoteRecovery 里的那几条有自己的「第 N 次」，别两套数字打架 */
      if (remoteRecovery.has(sessionId)) continue;
      noticed.add(sessionId);
      stickySessionNotice(sessionId, tr('⚠️ The local tools connection dropped; reconnecting (attempt {n}). Until then this remote session can\'t read or write your files.', { n: attempt }), LOCAL_TOOLS_RECONNECT_GROUP);
    }
  },
  /*
    master 回来之后，把那台机器上**连着但没有工具**的会话重新备一次。

    光有 master 不够：这些执行器是在 `localTools` 为 undefined 时起的（见
    `ensureLocalTools` 的 catch），它们那条 kiro-cli 根本没被配上本地 MCP，
    端口回来了也用不上 —— 实测就是这个状态：执行器活着、`local_*` 全是死的。
  */
  onReady: (key: string) => {
    void rearmLocalToolsFor(key);
    /* 断线时执行器已经没了的那几条：现在就接（不等它们各自的退避定时器） */
    remoteRecovery.kick(key);
    const noticed = muxDownNoticed.get(key);
    muxDownNoticed.delete(key);
    /* 要重接的那几条由 rearm 自己说；其余的（端口没变、工具本来就在）在这里把"正在重连"顶掉 */
    for (const sessionId of noticed || []) {
      if (needsRearm(sessionId, key)) continue;
      sessionNotice(sessionId, tr('Local tools connection restored.'), { group: LOCAL_TOOLS_RESTORED_GROUP });
    }
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
/**
 * 这台机器上算"在用这条连接"的会话：活着的执行器，加上正在 attach / 重配、已经登记过这台机器的
 * （见 `muxUsers`）。自愈判据、"正在重连"提示用的都是它。
 */
function muxSessionsOn(key: string): string[] {
  const ids = new Set<string>();
  for (const [sessionId, entry] of sessionClients) {
    const r = entry.profile.remote;
    if (r?.sshHost && muxKey(r.sshHost, r.sshPort) === key) ids.add(sessionId);
  }
  for (const [sessionId, k] of muxUsers) {
    if (k === key && (attachingSessions.has(sessionId) || reconfiguringSessions.has(sessionId))) ids.add(sessionId);
  }
  /* 断了、正在等这条连接回来的会话（执行器已经没了）—— 少了它们，master 一断重建就停 */
  for (const sessionId of remoteRecovery.waitingOn(key)) ids.add(sessionId);
  return [...ids];
}

/**
 * 这条会话要不要重接：没备上工具的，或者它 agent 里写的远端端口**不是**这条连接现在的端口
 * （远端端口由 sshd 分，重建之后多半变了 —— 见 `sshMux.ts` 文件头）。
 * 连接现在不在就不判：端口无从比较，等它回来时 `onReady` 会再叫一次。
 */
function needsRearm(sessionId: string, key: string): boolean {
  if (toollessSessions.has(sessionId)) return true;
  const port = sshMux.remotePortFor(key);
  const spec = localToolsBySession.get(sessionId);
  return typeof port === 'number' && !!spec && spec.remotePort !== port;
}

async function rearmLocalToolsFor(key: string): Promise<void> {
  const victims: string[] = [];
  let busyPending = false;
  for (const [sessionId, entry] of sessionClients) {
    const r = entry.profile.remote;
    if (!r?.sshHost || muxKey(r.sshHost, r.sshPort) !== key) continue;
    if (!needsRearm(sessionId, key)) continue;        // 它有工具、端口也对，别碰
    if (entry.busy) { busyPending = true; continue; } // 正在产出，别打断 —— 过一会儿再看
    victims.push(sessionId);
  }
  /*
    正在跑的那几条**不是不管**：它那一轮的本地工具已经是死的，这一轮结束后就该重接。
    过一会儿再看一次（连接又断了的话 needsRearm 判不出端口，就留给下一次 onReady）。
  */
  if (busyPending) setTimeout(() => { void rearmLocalToolsFor(key); }, 15_000).unref?.();
  if (!victims.length) return;
  logger.info('sshmux', `${key} 的连接回来了 —— ${victims.length} 条会话缺本地工具，逐条重接：${victims.join(' ')}`);
  for (const sessionId of victims) {
    try {
      sessionNotice(sessionId, tr('⏳ Local tools connection restored; reconnecting this session…'));
      detachExecutor(sessionId);
      toollessSessions.delete(sessionId);
      /* 主动接回来（不等用户下一次发消息）：走和断线恢复同一条路，接上之前一直按退避重试 */
      startRemoteRecovery(sessionId, { quiet: true });
    } catch (err: any) {
      logger.warn('sshmux', `重接失败 sessionId=${sessionId}: ${err?.message || err}`);
    }
  }
}
/**
 * **断了的远程会话自己接回来** —— 状态机在 `remoteRecovery.ts`（判据和理由都在那儿），这里只接线。
 *
 * 判据按**记录**来（还在、没归档、没删、仍是远程、没在退出）：执行器断了之后 `sessionClients` 里
 * 已经没有它，正是要靠记录才知道"用户还开着这条会话"。
 */
let reattachSession: ((sessionId: string) => Promise<boolean>) | undefined;
const remoteRecovery = new RemoteRecovery<{ key: string; remote: RemoteTarget }>({
  target: (sid) => {
    if (isQuitting || deletedSessionIds.has(sid)) return undefined;
    const rec = store.readRecord(sid);
    const remote = rec && !rec.archived ? rec.profile.remote : undefined;
    return remote?.sshHost ? { key: muxKey(remote.sshHost, remote.sshPort), remote } : undefined;
  },
  attached: (sessionId) => sessionClients.has(sessionId),
  toolless: (sessionId) => toollessSessions.has(sessionId),
  busy: (sessionId) => !!sessionClients.get(sessionId)?.busy,
  detach: async (sessionId) => { await detachExecutor(sessionId); toollessSessions.delete(sessionId); },
  /* 复用平台：先把这台机器的连接拉起来（并发只握一次手），没回来就不起执行器 */
  ensureConnection: muxSupported() ? (t) => sshMux.ensure(t.remote) : undefined,
  reattach: async (sessionId) => !!(await reattachSession?.(sessionId)),
  notice: (sessionId, text, sticky, group) => (sticky ? stickySessionNotice(sessionId, text, group) : sessionNotice(sessionId, text, { group })),
  /* 渲染层只在它自己 loadSession 成功时才把会话标成"连着" —— 主进程接上的要告诉它 */
  recovered: (sessionId) => { mainWindow?.webContents.send('acp:reattached', { sessionId }); },
  log: (message) => logger.info('remote', message),
});
function startRemoteRecovery(sessionId: string, opts: { quiet?: boolean } = {}): void {
  remoteRecovery.start(sessionId, opts);
}
/** 「这个平台不支持复用」只说一次 —— 每条会话都说一遍就是噪音。 */
let muxWarned = false;
/* 每条 ssh 都先问一句"这台机器有没有现成的连接" —— 有就当 channel 走，没有照旧建新的 */
setMuxSocketResolver((remote) => (remote?.sshHost ? sshMux.liveSocketFor(remote) : undefined));

/**
 * **复用连接的 session 满了**（sshd `MaxSessions`，默认 10）——「Session open refused by peer」。
 *
 * 2026-10-22 实测（tokyo-arm）：那条主连接下正好 10 个执行器，切换组合、远端清理全报这句英文。
 * 先把那条标成满的、再开一条主连接（`sshMux.openSpare`，换一个 ControlPath）让调用方重试一次；
 * 重试也满了（或开不出来）就说人话、写日志。执行器（`AcpClient.connect`）、预检、远端命令共用这一个。
 */
async function onMuxSessionsFull(remote: RemoteTarget, failedSocket: string | undefined, final: boolean): Promise<{ retry: boolean; message: string }> {
  const host = labelForHost(KIROLEX_CONFIG_PATH, remote.sshHost) || remote.sshHost;
  if (failedSocket) sshMux.markFull(failedSocket);
  if (!final && failedSocket) {
    const spare = await sshMux.openSpare(remote).catch(() => undefined);
    if (spare) {
      logger.info('remote', `${remote.sshHost}: 复用连接 ${failedSocket} 的 session 满了（Session open refused by peer）—— 改走另开的 ${spare} 重试一次`);
      return { retry: true, message: '' };
    }
  }
  const message = sessionsFullMessage(host);
  logger.warn('remote', `${remote.sshHost}: ${message}（ssh 报 Session open refused by peer；${final ? '换了一条连接重试也满' : '没能再开一条主连接'}）`);
  return { retry: false, message };
}
setMuxSessionsFullHandler(onMuxSessionsFull);

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
/** 熔断期间「跳过」那一行每台机器每个窗口只记一次（见 `runPreflight`）—— 记的时刻和之后又跳过了几次。 */
const preflightSkipLog = new Map<string, { at: number; skipped: number }>();

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
 *
 * 不只问登录 shell 的 `command -v`：Node 由 fnm / nvm 管的机器上登录 shell 里连 node 都没有，
 * 适配器装好了也会被判成"没装"（graviton 上实测）。探测和判定在 `remoteAdapterProbe.ts`；
 * 判出来的起法按机器 + 引擎记下，`AcpClient.connect` 起适配器时取（`remoteAdapterLaunchFor`）。
 * 顺带看一眼那家 CLI 登录 / 配过没有 —— 不然要等第一条消息失败才知道。
 */
async function remoteAdapterCheck(remote: RemoteTarget, engine: 'claude' | 'codex', sessionId?: string): Promise<void> {
  const host = remote.sshHost || '';
  let out = '';
  try {
    out = await runRemoteCapture(remote, adapterProbeScript(engine), 30_000);
  } catch (err: any) {
    throw new Error(tr('Can\'t connect to {host}: {error}', { host: remote.sshHost, error: String(err?.message || err) }));
  }
  const probe = parseAdapterProbe(out);
  const verdict = judgeAdapterProbe(probe);
  rememberRemoteAdapterLaunch(remote, engine, verdict);
  logger.info('remote', `适配器探测 ${host} ${engine}: ${verdict.kind}`
    + (verdict.kind === 'absolute' ? `（${verdict.manager}：${verdict.node} ${verdict.entry}）` : '')
    + (verdict.kind === 'no-node' ? `（${verdict.manager}：${verdict.entry}）` : '')
    + ` 登录痕迹=${[...probe.auth, ...probe.cfg.map((c) => `${c.src}:${c.key}=${c.val}`)].join(',') || '无'}`);
  const problem = adapterProblemMessage(host, engine, verdict);
  if (problem) throw new Error(problem);
  if (!sessionId) return;
  const hidden = adapterHiddenNotice(host, engine, verdict);
  if (hidden) adapterNotes.say(sessionId, 'status', hidden, `adapter-hidden:${host}:${engine}`);
  if (!remoteAuthConfigured(engine, probe)) adapterNotes.say(sessionId, 'note', remoteLoginHint(host, engine), `remote-login:${host}:${engine}`);
}

/**
 * `remoteAdapterCheck` 要说的话。同一条会话同一件事只说一次（每次重连 / 换组合都会走到）；
 * 新建会话时记录还没落盘（`noteInSession` 写不进），先攒着，`acp:new-session` 写好记录后 `commit`。
 *
 * 状态行那句（「登录 shell 看不到…已直接用 fnm 的 node 起」）钉住（pinned）：说的是这条会话现在怎么起的，
 * 几秒就消失的话晚点打开这条会话就看不到了；实测 40ms 后就来一句「自动起标题…」，普通 sticky 会被它换掉。
 * 进记录的那句（「还没登录」）重启后 `said` 是空的：记录里同组最新那条已经是这句就不再追加（`noteAlreadyInTranscript`）。
 */
const adapterNotes = (() => {
  const emit = (sid: string, how: 'note' | 'status', text: string, group: string): boolean => {
    if (how === 'status') { stickySessionNotice(sid, text, group, { pinned: true }); return true; }
    const v = textVariants(text);
    if (noteAlreadyInTranscript(store.readTranscript(sid), group, [text, v?.zh || '', v?.en || ''])) return true;
    return noteInSession(sid, text, undefined, group);
  };
  /* 记账（说过了 / 攒着 / 换机器换引擎时 `forgetPinned` 撤掉旧机器那句钉住提示）在 adapterNotes.ts */
  return createAdapterNotes({ hasRecord: (sid) => !!store.readRecord(sid), emit, unpin: (sid, prefix) => unpinSessionNotice(sid, prefix) });
})();

/**
 * 「安装 AI 工具」之后的验证：探测 → 用**会话起适配器的同一条命令**（`buildRemoteAdapterCommand` + 探测出的起法，
 * 同一套 `buildSshArgs`）起一次，发 ACP `initialize`，回了才算能起。起来的那个随即收掉（关 stdin，再按自报的 PID 杀树）。
 */
async function verifyRemoteAdapter(remote: RemoteTarget, engine: 'claude' | 'codex'): Promise<AdapterVerifyResult> {
  const host = remote.sshHost || '';
  let out = '';
  try {
    out = await runRemoteCapture(remote, adapterProbeScript(engine), 30_000);
  } catch (err: any) {
    return { ok: false, problem: tr('Can\'t connect to {host}: {error}', { host, error: String(err?.message || err) }) };
  }
  const verdict = judgeAdapterProbe(parseAdapterProbe(out));
  rememberRemoteAdapterLaunch(remote, engine, verdict);
  const problem = adapterProblemMessage(host, engine, verdict);
  if (problem) return { ok: false, problem };
  return await new Promise<AdapterVerifyResult>((resolve) => {
    const child = spawn('ssh', buildSshArgs(remote, buildRemoteAdapterCommand(REMOTE_ADAPTER_BIN[engine], verdict)), { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnv(remote) });
    let stdout = '';
    let stderr = '';
    let done = false;
    /* 远端自报的 PID（`buildRemoteAdapterCommand` 的第一行）：收尸用 */
    let pid: number | undefined;
    const finish = (timedOut: boolean, exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const r = judgeAdapterVerify({ stdout, stderr, exitCode, timedOut });
      try { child.stdin.end(); } catch { /* 已经退了 */ }
      if (pid) runRemoteCapture(remote, remoteKillTree(pid), 15_000).catch(() => { /* 收不掉就留给孤儿清扫 */ });
      setTimeout(() => { try { child.kill(); } catch { /* 已经退了 */ } }, 3_000);
      resolve(r);
    };
    child.stdout.on('data', (b: Buffer) => {
      stdout = (stdout + b.toString('utf-8')).slice(-8000);
      if (judgeAdapterVerify({ stdout, stderr: '', exitCode: null, timedOut: false }).ok) finish(false, null);
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf-8')).slice(-8000);
      pid = pid || parseRemotePid(stderr);
    });
    child.on('error', (err) => { stderr += `\n${err?.message || err}`; finish(false, null); });
    child.on('close', (code) => finish(false, code));
    const timer = setTimeout(() => finish(true, null), 60_000);
    try { child.stdin.write(ACP_INITIALIZE_LINE); } catch { /* close 会报 */ }
  });
}

/** `scripts/remote-bootstrap.sh` 的内容（脚本跟着 app 走：dev 下在仓库里，打包后在 resources 里）；找不到 = null。 */
function readBootstrapScript(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'scripts', 'remote-bootstrap.sh'),
    path.join(process.resourcesPath || '', 'scripts', 'remote-bootstrap.sh'),
    path.join(__dirname, '..', '..', 'scripts', 'remote-bootstrap.sh'),
  ];
  const scriptPath = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  return scriptPath ? fs.readFileSync(scriptPath, 'utf-8') : null;
}

/**
 * **会话里点「安装」装远端缺的那一个适配器** —— 和「安装 AI 工具」同一个脚本，带 `ONLY=<命令名>`
 * （`remoteInstallCommand`）：只装那一个，Node 已有就不动，kiro-cli / 另一家 / 登录 / sshd 都不碰。
 * 装完照「安装 AI 工具」那样按会话的起法真起一次（`verifyRemoteAdapter`，fnm / nvm / ~/.local/bin 包装脚本那套探测），
 * 起得来才算装好。输出边跑边交给 `onChunk`。
 */
async function installRemoteAdapter(remote: RemoteTarget, engine: 'claude' | 'codex', onChunk: (s: string) => void): Promise<{ ok: boolean; error?: string }> {
  const host = remote.sshHost || '';
  logger.info('remote', `会话里安装适配器 ${host} ${engine}（只装 ${REMOTE_ADAPTER_BIN[engine]}）`);
  const run = await runRemoteOnlyInstall(remote, engine, onChunk);
  if (run.noScript) return { ok: false, error: adapterInstallFailedMessage(engine, host, tr('remote-bootstrap.sh not found (it should be under the app’s scripts/)')) };
  logger.info('remote', `会话里安装适配器结束 ${host} ${engine} code=${run.code}${run.error ? ` error=${run.error}` : ''}`);
  const result = { code: run.code, output: run.tail, error: run.error };
  /* ssh 起不来 / 没连上（255）：脚本根本没跑，不用验证 */
  if (run.error || run.code === 255) return remoteInstallOutcome(engine, host, result);
  const v = await verifyRemoteAdapter(remote, engine);
  const line = adapterVerifyMessage(host, engine, v);
  logger.info('remote', `会话里安装适配器 验证 ${host} ${engine}: ${v.ok ? 'ok' : line}`);
  onChunk(`\n${line}\n`);
  /* 失败原因（含脚本带回来的 npm 那几行）由调用方写进会话和日志 */
  return remoteInstallOutcome(engine, host, result, { ok: v.ok, line });
}

/**
 * **远端缺 kiro-cli 时，状态里的「❌ 没装 → 安装」直接装** —— 原来只叫人去设置里点「安装 AI 工具」。
 * 同一个脚本带 `ONLY=kiro-cli`（系统包 + kiro-cli 本身，不碰 node / claude / codex / 登录 / sshd），
 * 装完按设置里「自动检测」那套在那台机器上找一遍（`detectScript`），找到能起的才算装好；
 * 那台机器还没配 kiro 启动命令就把找到的存进去（`remoteKiroInstallOutcome`）。登录照旧是另一步（状态里的 ⚠️）。
 */
async function installRemoteKiro(remote: RemoteTarget, onChunk: (s: string) => void): Promise<{ ok: boolean; error?: string }> {
  const host = remote.sshHost || '';
  const id = (remote as any).id || findRemoteIdForHost(host);
  logger.info('remote', `安装 kiro-cli ${host}（只装 kiro-cli）`);
  const run = await runRemoteOnlyInstall(remote, 'kiro', onChunk);
  if (run.noScript) return { ok: false, error: tr('❌ Installing kiro-cli on {host} failed: {why}', { host, why: tr('remote-bootstrap.sh not found (it should be under the app’s scripts/)') }) };
  logger.info('remote', `安装 kiro-cli 结束 ${host} code=${run.code}${run.error ? ` error=${run.error}` : ''}`);
  let found: { command: string; version?: string } | undefined;
  if (!run.error && run.code !== 255 && id) {
    onChunk(`\n${tr('Looking for kiro-cli on {host}…', { host })}\n`);
    try { found = parseDetect(await runProbe(id, detectScript())).kiro.find((c) => c.ok); } catch { /* 找不到就按没装好说 */ }
    if (found) onChunk(`✓ ${found.command}  ${found.version || ''}\n`);
  }
  const configured = remoteKiroBin(remote);
  const r = remoteKiroInstallOutcome(host, { code: run.code, output: run.tail, error: run.error }, found, configured);
  if (r.ok && r.saveAs && id) {
    const cur = findRemoteTarget(KIROLEX_CONFIG_PATH, id);
    saveRemoteTarget(KIROLEX_CONFIG_PATH, { id, sshHost: cur?.sshHost || host, bins: { ...(cur?.bins || {}), kiro: r.saveAs } } as RemoteTargetInput);
    logger.info('remote', `${host} 的 kiro 启动命令存为 ${r.saveAs}`);
  }
  return r.ok ? { ok: true } : r;
}

/** 远端跑「安装 AI 工具」那个脚本、只装 `engine` 那一个（ONLY），输出边跑边给 `onChunk`。 */
async function runRemoteOnlyInstall(remote: RemoteTarget, engine: 'claude' | 'codex' | 'kiro', onChunk: (s: string) => void): Promise<{ code: number | null; tail: string; error?: string; noScript?: boolean }> {
  const host = remote.sshHost || '';
  const script = readBootstrapScript();
  if (!script) return { code: null, tail: '', noScript: true };
  const remoteTmp = `/tmp/kirolex-adapter-${Date.now()}.sh`;
  onChunk(`$ ssh ${host} … ONLY=${engine === 'kiro' ? 'kiro-cli' : REMOTE_ADAPTER_BIN[engine]} bash remote-bootstrap.sh\n`);
  return await new Promise<{ code: number | null; tail: string; error?: string }>((resolve) => {
    const child = spawn('ssh', buildSshArgs(remote, remoteInstallCommand(remoteTmp, engine)), { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnv(remote) });
    let tail = '';
    const onData = (b: Buffer) => {
      const t = b.toString('utf-8');
      tail = (tail + t).slice(-4000);
      onChunk(t);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.write(script);
    child.stdin.end();
    /* 没有 node 时要先装 node，给 10 分钟 */
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } }, 10 * 60 * 1000);
    child.on('error', (err) => { clearTimeout(killer); resolve({ code: null, tail, error: err?.message || tr('ssh would not start') }); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, tail }); });
  });
}

/* ─────────── 三个引擎在一台机器上的状态（新建会话选引擎处 / 设置 → 机器 → 本机，`engineStatus.ts`） ─────────── */

const engineStatusCache = createStatusCache();
const engineStatusInFlight = new Map<string, Promise<EngineStatus[]>>();

function readTextOrNull(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** 本机的 kiro / claude / codex 候选 —— 和设置里「自动检测」同一套（Windows 走 Node，别处走 bash 脚本）。 */
async function detectLocalBins() {
  return process.platform === 'win32' ? detectWindows(probeOneLocal) : parseDetect(await runProbe('local', detectScript()));
}

/** 本机 PATH 上的某个 CLI（找不到 = undefined）。 */
function findLocalCli(name: string): string | undefined {
  if (process.platform === 'win32') return whichAll(name, shellEnv)[0];
  return String(shellEnv.PATH || '').split(':').filter(Boolean).map((d) => path.join(d, name)).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

/** 跑一个本机命令拿输出（不抛；`.cmd` 经 shell）。 */
function runLocalCapture(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string; timedOut: boolean }> {
  const needsShell = /\.(cmd|bat)$/i.test(cmd);
  return new Promise((resolve) => {
    execFile(needsShell ? `"${cmd}"` : cmd, args, { timeout: timeoutMs, encoding: 'utf8', shell: needsShell, windowsHide: true, env: shellEnv, cwd: os.homedir() }, (err: any, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`, timedOut: !!err?.killed });
    });
  });
}

/** 本机三个引擎的事实 → 状态。 */
async function localEngineStatuses(): Promise<EngineStatus[]> {
  const kiro = async (): Promise<EngineStatus> => {
    const notSet = kiroBinProblem();
    const cli = notSet ? null : resolveKiroCli();
    if (!cli) {
      return judgeEngineStatus('kiro', { installed: false, detail: notSet
        ? tr('kiro-cli is not set up on this machine yet (no launch command). Install finds an existing kiro-cli or installs it.')
        : tr('kiro-cli was not found at the configured launch command.') });
    }
    const ver = await probeOneLocal(cli, '--version');
    if (!ver.ok) return judgeEngineStatus('kiro', { installed: false, detail: tr('kiro-cli does not start: {why}', { why: ver.first.slice(0, 160) }) });
    /* 未登录时 `whoami` 非零退出（远端预检也是这么判的）；超时 = 看不出来 */
    const who = await runLocalCapture(cli, ['whoami'], 20_000);
    return judgeEngineStatus('kiro', {
      installed: true,
      version: /(\d+\.\d+\.\d+)/.exec(ver.first)?.[1],
      loggedIn: who.timedOut ? undefined : who.ok,
      detail: who.ok || who.timedOut ? undefined : tr('Run `kiro-cli login` on this machine (the Login button opens a terminal for it).'),
    });
  };
  const adapter = async (engine: 'claude' | 'codex'): Promise<EngineStatus> => {
    const override = shellEnv[`KIROLEX_${engine.toUpperCase()}_ACP`];
    const entry = override || findAdapterEntry(engine, shellEnv);
    const installed = !!entry || (process.platform !== 'win32' && !!findLocalCli(REMOTE_ADAPTER_BIN[engine]));
    if (!installed) return judgeEngineStatus(engine, { installed: false, detail: adapterMissingMessage(engine) });
    let version: string | undefined;
    if (entry && /index\.js$/.test(entry)) {
      try { version = JSON.parse(readTextOrNull(path.join(path.dirname(entry), '..', 'package.json')) || '{}').version; } catch { /* 没有就不写版本 */ }
    }
    let loggedIn: boolean | undefined = localAuthFromFiles(engine, readTextOrNull, os.homedir(), shellEnv) || undefined;
    if (!loggedIn) {
      /* 文件里看不出来：问那个 CLI（macOS 上 Claude Code 的凭据在钥匙串里）；CLI 也没有 —— macOS 上看不出来，别处就是没登录 */
      const cli = findLocalCli(engine);
      if (cli) {
        const r = await runLocalCapture(cli, engine === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], 20_000);
        loggedIn = r.timedOut ? undefined : (engine === 'claude' ? parseClaudeStatus(r.out) : parseCodexStatus(r.out)).loggedIn;
      } else {
        loggedIn = process.platform === 'darwin' ? undefined : false;
      }
    }
    return judgeEngineStatus(engine, {
      installed: true, version, loggedIn,
      detail: loggedIn === false ? adapterAuthMessage(engine) : undefined,
    });
  };
  return Promise.all([kiro(), adapter('claude'), adapter('codex')]);
}

/** 远端：和「测试连接」同一次 ssh（kiro 预检 + 两家适配器探测）。 */
async function remoteEngineStatusesFor(target: RemoteTarget): Promise<EngineStatus[]> {
  const host = target.sshHost || '';
  const args = buildSshArgs(target, `bash -lc ${shellQuote(testConnectionScript(preflightScript(undefined, { models: false })))}`);
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile('ssh', args, { timeout: 30_000, encoding: 'utf8', env: sshEnv(target) }, (err: any, stdout, stderr) => resolve({
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''),
    }));
  });
  const sections = splitTestOutput(out.stdout);
  const pre = judgePreflight(out.code, sections.kiro, out.stderr, target);
  return remoteEngineStatuses(host, { code: out.code, ...sections }, pre.code === 'unreachable' ? pre.message : undefined);
}

/** 一台机器的状态（`'local'` = 本机）：5 分钟缓存 + 同一台同时只问一次。 */
async function engineStatusesFor(machine: string, force = false): Promise<EngineStatus[]> {
  const key = machine || 'local';
  if (!force) {
    const cached = engineStatusCache.get(key);
    if (cached) return cached;
  }
  const running = engineStatusInFlight.get(key);
  if (running) return running;
  const job = (async () => {
    let statuses: EngineStatus[];
    if (key === 'local') statuses = await localEngineStatuses();
    else {
      const target = findRemoteTarget(KIROLEX_CONFIG_PATH, key);
      if (!target) throw new Error(tr('Machine not found'));
      statuses = await remoteEngineStatusesFor(target);
    }
    engineStatusCache.set(key, statuses);
    logger.info('engines', `状态 ${key}: ${statuses.map((s) => `${s.engine}=${s.state}${s.version ? `@${s.version}` : ''}`).join(' ')}`);
    return statuses;
  })().finally(() => { engineStatusInFlight.delete(key); });
  engineStatusInFlight.set(key, job);
  return job;
}

/**
 * **本机装 kiro-cli** —— 原来只叫人去设置里填路径。
 * 先找一遍本机已有的（和设置里「自动检测」同一套）：找到能跑的就直接存成本机启动命令（不重装）；
 * 没有才跑官方安装器（`kiroInstallCommand`，cwd 家目录），装完再找一遍、存起来。装不上给官方下载链接。
 */
async function installLocalKiro(onChunk: (s: string) => void): Promise<{ ok: boolean; error?: string }> {
  const save = (cmd: string) => {
    const saved = saveLocalBins(KIROLEX_CONFIG_PATH, { ...(localBins(KIROLEX_CONFIG_PATH) || {}), kiro: cmd });
    setLocalKiroBin(saved?.kiro);
    logger.info('engines', `本机 kiro 启动命令存为 ${saved?.kiro}`);
  };
  const pick = async () => { try { return (await detectLocalBins()).kiro.find((c) => c.ok); } catch { return undefined; } };
  onChunk(`${tr('Looking for an existing kiro-cli on this machine…')}\n`);
  let found = await pick();
  if (found) {
    onChunk(`✓ ${found.command}  ${found.version || ''}\n`);
    save(found.command);
    return { ok: true };
  }
  const cmd = kiroInstallCommand(process.platform, os.homedir(), shellEnv);
  onChunk(`$ ${cmd.display}  (cwd: ${cmd.cwd})\n`);
  logger.info('engines', `本机安装 kiro-cli：${cmd.display}`);
  const run = await new Promise<{ code: number | null; output: string; error?: string; timedOut?: boolean }>((resolve) => {
    let output = '';
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, env: shellEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) { resolve({ code: null, output, error: String(err?.message || err) }); return; }
    const onData = (b: Buffer) => { const s = b.toString('utf-8'); output = (output + s).slice(-8000); onChunk(s); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const killer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } }, 15 * 60_000);
    child.on('error', (err) => { clearTimeout(killer); resolve({ code: null, output, error: String(err?.message || err) }); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, output, timedOut }); });
  });
  if (run.error || run.code !== 0) {
    return { ok: false, error: kiroInstallFailedMessage(run.error || installFailureReason(run.output, run.code, { timedOut: run.timedOut })) };
  }
  found = await pick();
  if (found) {
    onChunk(`✓ ${found.command}  ${found.version || ''}\n`);
    save(found.command);
    return { ok: true };
  }
  return { ok: false, error: kiroInstallFailedMessage(tr('the installer finished, but KiroLex still cannot find a kiro-cli that starts')) };
}

/**
 * 装一个引擎（本机：kiro-cli / 适配器；远端：适配器只装缺的那一个）。会话里的「安装」和新建会话框 / 设置页的 ❌ 走同一份：
 * 同一机器、同一引擎只装一次，后来的订阅那一次（`createSharedInstalls`，进度和结果都广播）。装好了清掉那台机器的状态缓存。
 */
const engineInstalls = createSharedInstalls<{ ok: boolean; error?: string }>();
function engineInstallKey(remote: RemoteTarget | undefined, engine: Engine): string {
  return `${remote?.sshHost || 'local'}|${engine}`;
}
function runEngineInstall(remote: RemoteTarget | undefined, engine: Engine, onChunk: (s: string) => void): Promise<{ ok: boolean; error?: string }> {
  const host = remote?.sshHost || undefined;
  return engineInstalls.join(engineInstallKey(remote, engine), onChunk, (broadcast) => {
    let job: Promise<{ ok: boolean; error?: string }>;
    if (engine === 'kiro') {
      job = host ? installRemoteKiro(remote!, broadcast) : installLocalKiro(broadcast);
    } else if (host) {
      job = installRemoteAdapter(remote!, engine, broadcast);
    } else {
      job = runLocalAdapterInstall(engine, {
        spawn: spawn as any,
        platform: process.platform,
        home: os.homedir(),
        env: shellEnv,
        onOutput: broadcast,
        findEntry: () => { forgetAdapterCache(); return findAdapterEntry(engine, shellEnv); },
        binOnPath: (bin) => binOnPath(bin, shellEnv, (p) => { try { return fs.existsSync(p); } catch { return false; } }),
      });
    }
    return job.then((r) => {
      if (r.ok) engineStatusCache.invalidate(host ? findRemoteIdForHost(host) : 'local');
      return r;
    });
  }).promise;
}

/** 状态缓存按远端 id 记：装完按 host 找回 id 清掉（找不到就全清）。 */
function findRemoteIdForHost(host: string): string | undefined {
  try { return listRemoteTargets(KIROLEX_CONFIG_PATH).find((t: any) => t.sshHost === host)?.id; } catch { return undefined; }
}

/** 本机这一家的登录命令（数组：程序 + 参数）+ 要叠加的环境变量；做不到就是一句原因。 */
function localLoginArgv(engine: Engine): { argv: string[]; env?: Record<string, string> } | { error: string } {
  if (engine === 'kiro') {
    const cli = kiroBinProblem() ? null : resolveKiroCli();
    return cli ? { argv: [cli, ...LOGIN_ARGS.kiro] } : { error: tr('Install kiro-cli first.') };
  }
  const cli = findLocalCli(engine);
  if (cli) return { argv: [cli, ...LOGIN_ARGS[engine]] };
  if (engine === 'claude') {
    /* 没装 claude CLI：适配器自带的 Claude Agent SDK 里有 cli.js，用 KiroLex 自己的 node 跑它的登录 */
    const entry = findAdapterEntry('claude', shellEnv);
    if (entry) {
      const pkgDir = path.dirname(path.dirname(entry));
      const sdk = [
        path.join(pkgDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
        path.join(pkgDir, '..', '..', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
      ].find((p) => { try { return fs.existsSync(p); } catch { return false; } });
      if (sdk) return { argv: [process.execPath, sdk, ...LOGIN_ARGS.claude], env: { ELECTRON_RUN_AS_NODE: '1' } };
    }
    return { error: tr('Logging in to Claude Code needs the claude command: install Claude Code (https://claude.ai/install), or put a Bedrock / API key setup in ~/.claude/settings.json.') };
  }
  return { error: tr('Logging in to Codex needs the codex command: run `npm i -g @openai/codex` first, or set OPENAI_API_KEY.') };
}

/** 在一个新终端窗口里跑（Linux 按顺序试几个终端）。 */
function openLoginTerminal(argv: string[], env: Record<string, string> = {}): Promise<boolean> {
  const script = process.platform === 'win32'
    ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-login-')), 'login.cmd')
    : undefined;
  const tries = terminalLaunches(process.platform, argv, env, script);
  return new Promise((resolve) => {
    const next = (i: number) => {
      if (i >= tries.length) { resolve(false); return; }
      const t = tries[i];
      try {
        if (t.script) fs.writeFileSync(t.script.path, t.script.content);
        const command = t.command === 'cmd.exe' ? (shellEnv.ComSpec || 'cmd.exe') : t.command;
        const child = spawn(command, t.args, { detached: true, stdio: 'ignore', cwd: os.homedir(), env: shellEnv, windowsVerbatimArguments: !!t.verbatim });
        child.once('error', () => next(i + 1));
        child.once('spawn', () => { child.unref(); resolve(true); });
      } catch { next(i + 1); }
    };
    next(0);
  });
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
      /*
        **一个熔断窗口里只记一行**（外加跳过了几次）—— 实测远端连不上的 4 分钟里这一行刷了 488 次：
        调用方（排队排空）在紧循环里反复来问。调用方那边已经改成退避了，这里再兜一层，日志不被淹。
      */
      const now = Date.now();
      const last = preflightSkipLog.get(host);
      if (!last || now - last.at >= BREAKER_MS) {
        logger.info('remote', `preflight ${host}: 跳过（${BREAKER_MS / 1000}s 内刚判定连不上）—— 复用上次结论`
          + (last?.skipped ? `（上一个窗口里又跳过了 ${last.skipped} 次，没逐条记）` : ''));
        preflightSkipLog.set(host, { at: now, skipped: 0 });
      } else {
        last.skipped += 1;
      }
      throw new Error(recent);
    }
  }
  let args = buildSshArgs(remote, `bash -lc ${shellQuote(preflightScript())}`);
  let verdict = { code: 'unreachable', message: tr('Can\'t connect to {host}', { host }) } as ReturnType<typeof judgePreflight>;
  /** session 满了换连接重试过没有（只重试一次，见 `onMuxSessionsFull`） */
  let sparedOnce = false;
  for (let attempt = 1; attempt <= PREFLIGHT_ATTEMPTS; attempt += 1) {
    const socket = sshMux.liveSocketFor(remote);
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile('ssh', args, { timeout: 30_000, encoding: 'utf8', env: sshEnv(remote) }, (err: any, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      }));
    });
    verdict = judgePreflight(out.code, out.stdout, out.stderr, remote);
    if (verdict.code === 'unreachable' && socket && sshErrorKind(out.stderr) === 'sessions-full') {
      const full = await onMuxSessionsFull(remote, socket, sparedOnce);
      if (full.retry && !sparedOnce) {
        sparedOnce = true;
        args = buildSshArgs(remote, `bash -lc ${shellQuote(preflightScript())}`);
        attempt -= 1;   // 换了连接的这一次不算一次失败
        continue;
      }
      verdict = { code: 'unreachable', message: full.message, raw: full.message };
      break;
    }
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
 * **自动改用备用模型要留在对话记录里，而且说的是实际起来的那个** —— 判据在 `modelFallbackNote.ts`（纯的、有测试）：
 * 同一对「想要 → 实际」每条会话只记一次；新建会话时先攒着、记录落盘后补写；远端按连上之后实际起来的模型说。
 */
const modelFallback = new ModelFallbackNotes({
  note: (sid, text, group) => noteInSession(sid, text, undefined, group),
  /* 删掉的会话当作"在"：不攒、不补写，只在状态行说 */
  recordExists: (sid) => !!store.readRecord(sid) || deletedSessionIds.has(sid),
  status: (sid, text, group) => sessionNotice(sid, text, { group }),
  remoteText: (host, wanted, used, models) => trConcat(tr('⚠️ {host} has no model "{wanted}", so this session uses "{fallback}" instead.', { host, wanted, fallback: used }),
    NOTE_DETAIL_SEP,
    tr('Available there: {list}{more}', { list: trList(models.slice(0, 8)), more: models.length > 8 ? '…' : '' })),
});

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
  /* 每次挑都从头记：上一次没连上留下的那条不能带到这一次 */
  modelFallback.remoteReset(sessionId);
  if (!models.length || models.includes(wanted)) return wanted;
  /* 说不说、说哪个模型，等连上之后（modelFallback.remoteStarted）按实际起来的那个定 */
  modelFallback.remotePicked(sessionId, wanted, host, models);
  const fallback = MODEL_FALLBACK_ORDER.find((m) => models.includes(m)) || models.find((m) => m !== 'auto') || 'auto';
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
      timer = setTimeout(() => reject(new Error(tr('{what} timed out (no response for {s}s)', { what, s: ms / 1000 }))), ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
// Sessions deleted during this runtime. Guards against a concurrent/in-flight
// acp:load-session (e.g. startup eager-attach) racing a delete and RECREATING the
// session's record.json on disk — which would resurrect a chat the user just
// closed (it reappears after restart via disk hydrate). In-memory only: after a
// restart the dir is gone so hydrate never re-adds it.
const deletedSessionIds = new Set<string>();
/**
 * 新建时选的引擎 / 机器：`acp:new-session` 一进来就记、建成才清 —— 建不成的新会话没有记录，
 * 之后右键换机器 / 目录 / 引擎时 `coldRecordFor` 靠它把这两样补回来（见 `coldRecord.ts`）。
 */
const newSessionIntents = new Map<string, NewSessionIntent>();
/**
 * **正在新建的会话**（`creationGate.ts`）：阶段推给界面（`acp:create-stage`），忙闲报 `creating`（新消息进排队），
 * attach 遇到它先等它建完 —— 不按默认值（本机 kiro）去 attach 一条记录还没写完的会话。
 */
/**
 * 新建时渲染层传来的参数 —— 建成就删；没建成的留着，窗口刷新后阶段条上的「重试 / 改成本机运行」靠它照原样再建
 * （渲染层自己记的那份随窗口刷新没了，见 `acp:get-create-args`）。只在内存里：重启之后记录已经在盘上，普通 attach 就行。
 */
const newSessionArgs = new Map<string, { cwd: string; model: string; projectId?: string; kiroAgent?: string; remoteId?: string; engine?: 'kiro' | 'claude' | 'codex' }>();
const creations = createCreationGate({
  onChange: (info) => {
    mainWindow?.webContents.send('acp:create-stage', info);
    emitSessionBusy(info.sessionId);
  },
});
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
/** 主进程文案（托盘、对话框、通知、插进聊天的提示）跟着设置里的界面语言走 —— 见 `uiText.ts`。 */
function syncUiLangFromSettings(): void {
  const before = uiLang();
  let raw: unknown;
  try { raw = JSON.parse(uiState()['kirolex-settings'] || '{}')?.language; } catch { /* 坏值退回默认 */ }
  if (setUiLang(raw) !== before) refreshTrayMenu();
}
function setUiStateKey(key: string, value: string | null): void {
  if (!key || typeof key !== 'string') return;
  const state = uiState();
  if (value === null) delete state[key];
  else state[key] = String(value);
  if (key === 'kirolex-settings') syncUiLangFromSettings();
  // Coalesced: widths and drafts can change on every mouse move.
  if (uiStateFlush) clearTimeout(uiStateFlush);
  uiStateFlush = setTimeout(flushUiStateNow, 400);
}

/** 现在就把 ui-state 写盘（平时攒 400ms 一次）。要「写到盘上了才能删另一份」的地方用（acp:ack-handoff-failed）。 */
function flushUiStateNow(): boolean {
  if (uiStateFlush) { clearTimeout(uiStateFlush); uiStateFlush = null; }
  try {
    fs.mkdirSync(path.dirname(UI_STATE_PATH), { recursive: true });
    const tmp = `${UI_STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(uiState(), null, 2));
    fs.renameSync(tmp, UI_STATE_PATH);
    return true;
  } catch (err: any) {
    logger.warn('ui-state', `flush failed: ${err?.message || err}`);
    return false;
  }
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
/**
 * 「远程会话从本机转发的 MCP」名单（`config.json` 的 `remoteForwardMcp`）。
 * 只存在 KiroLex 自己的设置里 —— 绝不写进 Kiro 的 agent 文件（kiro-cli 严格校验，多一个字段就整份拒绝）。
 * 每次准备远程会话时现读，所以改完对下一条远程会话生效。
 */
function loadForwardMcpList(): ForwardListItem[] {
  try {
    return normalizeForwardList(JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'))?.remoteForwardMcp);
  } catch { return []; }
}
function saveForwardMcpList(list: unknown): ForwardListItem[] {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
  cfg.remoteForwardMcp = normalizeForwardList(list);
  fs.mkdirSync(path.dirname(KIROLEX_CONFIG_PATH), { recursive: true });
  const tmp = `${KIROLEX_CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, KIROLEX_CONFIG_PATH);
  return cfg.remoteForwardMcp;
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
  /*
    远程会话不再是开关（原来的 `remoteSessions`）：配一台机器本身就是选择要用它，一台没配时
    什么也不改变。表里没有这个键，老 config.json 里留着的 `features.remoteSessions: false` 也就不被认了。
  */
  /** Store a large paste on disk and show a placeholder in the composer. */
  pasteFolding: true,
  /** Draggable dividers between split panes. */
  splitDragResize: true,
  /** Starter-prompt chips above an empty composer. */
  promptSuggestions: true,
  /** 控制入口的「列会话 / 读最近消息 / 发消息」（controlServer.ts 的 `/sessions…`）。**默认关**：
   *  关着时那几条路由一律 403，`/ping` `/quit` `/reload` 不受影响。 */
  controlSessionAccess: false,
  /** 会话之间互相调用（kirolex-local 的 `sessions_list` / `session_read` / `session_send`，sessionCalls.ts）。默认开；
   *  关着时工具照样列出，调用时回一句清楚的错误（叫模型请用户自己转）。 */
  sessionCalls: true,
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
/** 会话忙时的 agent / 模型 / 权限 / 引擎 / 组合 / 运行位置切换：这一轮跑完再切（见 pendingSwitch.ts）。内存态。 */
const pendingSwitches = new PendingSwitchBook();
/** 真正应用一批 pending 的实现要用到 whenReady 里的那几个 switch，在那里赋值。 */
let applyPendingSwitchBatch: (sessionId: string, entries: PendingSwitch[]) => Promise<unknown> = async () => {};
/** 轮次结束 `kick`（sendPromptOnce 的 finally）、发送前 `settle`（sendPromptOnce 开头）。 */
const pendingSwitchRunner = new PendingSwitchRunner(pendingSwitches, {
  /* 后端自己起的那一轮（autonomousTurn.ts）也算：切换等它收尾（收尾时 kick，见 autonomousDeps.finish） */
  isBusy: (sessionId) => { const e = sessionClients.get(sessionId); return !!e?.busy || !!e?.autonomous; },
  apply: (sessionId, entries) => applyPendingSwitchBatch(sessionId, entries),
});
function emitPendingSwitches(sessionId: string): void {
  /* `since`：这段等待的开始时刻 —— 会话里那张卡片的「已等 N 秒」从它算 */
  mainWindow?.webContents.send('acp:pending-switches', { sessionId, pending: pendingSwitches.view(sessionId), since: pendingSwitches.sinceOf(sessionId) ?? null });
}
/**
 * 忙时（一轮在跑，或上一批 pending 正在应用）把这次切换记成 pending，返回 `{ ok: true, pending: true }`；
 * 不忙返回 null，调用方照常立即切换。`fromPending` = 正在应用 pending 的那一次调用，不能再记回去。
 */
function queueSwitchWhileBusy(
  sessionId: string, kind: PendingKind, value: any, label: string, fromPending?: boolean,
): { ok: true; pending: true } | null {
  /* 后端自己起的那一轮（autonomousTurn.ts）在跑也算忙：现在换执行器会截断正在输出的回复，收尾时 kick 再切 */
  const autonomousRunning = !!sessionClients.get(sessionId)?.autonomous && !fromPending;
  if (!shouldQueueSwitch({ busy: !!sessionClients.get(sessionId)?.busy, applying: pendingSwitchRunner.isApplying(sessionId), fromPending }) && !autonomousRunning) return null;
  const firstOfThisWait = !pendingSwitches.has(sessionId);
  pendingSwitches.set(sessionId, { kind, value, label });
  logger.info('pending-switch', `忙时切换先记下 sessionId=${sessionId} ${kind} -> ${label}（这一轮跑完再切）`);
  emitPendingSwitches(sessionId);
  /*
    **立刻在会话里说一声在等什么** ——「切换到本地 Claude Code 的时候不知为什么被拒绝或失败？也可能是后台让我在等，
    但会话没有提示」（实测那一轮又跑了 66 秒，期间只有输入框下方一个很小的 ⏳）。
    一段等待只插一条：同一段等待里再改选，界面上那张卡片（这条提示的活版本，见 ChatArea）跟着变，不刷屏。
    这条不进模型历史（noteInSession 那一套）。
  */
  if (firstOfThisWait) {
    noteInSession(sessionId, tr('⏳ This turn is still running; will switch to {target} once it finishes.', { target: pendingTargetForPeople(sessionId) }),
      undefined, PENDING_SWITCH_NOTE_GROUP);
  }
  return { ok: true, pending: true };
}
/** 每一类切换在提示里怎么称呼 */
function pendingKindName(kind: PendingKind): string {
  switch (kind) {
    case 'remote': return tr('Run location');
    case 'engine': return tr('Engine');
    case 'combo': return tr('Combo');
    case 'agent': return tr('Agent');
    case 'model': case 'engineModel': return tr('Model');
    case 'engineEffort': return tr('Effort');
    case 'engineMode': case 'permission': return tr('Permission mode');
    case 'engineCollab': return tr('Plan mode');
  }
}
/** 组合在 pending 里记的是 id（下拉按 id 对）：说给人看时换成当前语言的显示名 */
function pendingLabelForPeople(kind: PendingKind, label: string): string {
  if (kind !== 'combo') return label;
  const c = findCombo(readMcpCombos(os.homedir()).combos, label);
  return c ? comboDisplayName(c) : label;
}
/** 「跑完后切到 ___」：这条会话现在欠着的那几项 */
function pendingTargetForPeople(sessionId: string, only?: PendingSwitch[]): string {
  const view: Partial<Record<PendingKind, string>> = {};
  for (const sw of only || pendingSwitches.list(sessionId)) view[sw.kind] = pendingLabelForPeople(sw.kind, sw.label);
  return pendingTargetText(view, pendingKindName, tr(', '));
}
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

function noteInSession(sessionId: string, body: string, variants?: TextVariants, group?: string): boolean {
  const sid = String(sessionId || '').trim();
  const text = String(body || '').trim();
  if (!sid || !text) return false;
  if (refuseAdvancedOnly(sid, 'note')) return false;
  /*
    会话已经删了（或者盘上根本没有它的记录）就不说 —— `appendMessage` 会先建目录，侧栏后台那条改写写完盘时
    主人会话刚被删掉的话，`sessions/<id>/` 下就重新长出一个只有 transcript 的目录。
  */
  if (deletedSessionIds.has(sid) || !store.readRecord(sid)) return false;
  /* 中英两版一起落盘（tr() 出来的才认得；渲染层发起的自己带过来）—— 切了语言、重新打开都按当时的界面语言显示 */
  const v = asVariants(variants) ?? textVariants(text);
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
    /* `noteGroup`：同类提示的键（「类型:对象[→结果]」）—— 界面把相邻的同类几条并成一条「×N」 */
    const g = group ? { noteGroup: group } : {};
    store.appendMessage(sid, { id: messageId, role: 'user', content: text, ts: Date.now(), kirolex: true, ...(v ? { variants: v } : {}), ...g });
    refreshHistoryFile(sid);
    mainWindow?.webContents.send('acp:user-message', {
      sessionId: sid, messageId, content: text, ts: Date.now(), kirolex: true, ...(v ? { variants: v } : {}), ...g,
    });
    return true;
  } catch { return false; }
}

/* ─────────────── 模型自己安排的「过一会儿再看」：定时提示 / 后台命令 / 监视 ───────────────
 *
 * 工具在 kirolex-local 上（`wakeTools.ts`），结果都经 `wakeDispatcher` 作为**新的一条消息**发回会话：
 * 会话正忙就等这一轮结束（不 steer、不进渲染端的排队卡片、不被「合并排队消息」合并），多条按时间顺序逐条发。
 * 真正发送的那一下（`wakeDeliver`）要用 `sendPromptOnce` / `ensureAttached`，它们在 whenReady 里，到时候再挂上。
 */
let wakeDeliver: ((item: WakeItem) => Promise<void>) | null = null;
/** 控制入口 `new-backend` 要先挂上执行器 —— `ensureAttached` 在 whenReady 里，到时候再挂上。 */
let attachForControl: ((sessionId: string) => Promise<unknown>) | null = null;
/**
 * 每条会话开过几轮（`sendPromptOnce` 每次新发一条 +1，纠正那一轮不算）。
 * 「把工具调用写成了文字」的纠正排着的时候又开了别的一轮（你自己发了一条、排队的、后台唤醒），
 * 那条纠正就过时了 —— 不发（`textToolNudgeStale`）。
 * 换后端续做那一条只认 `userTurnStarts`（你自己发的几条）：后台结果 / 定时任务先到先跑一轮不取消它（`textToolWakeStale`）。
 */
const turnStarts = new Map<string, number>();
const userTurnStarts = new Map<string, number>();
function textToolNudgeStale(item: WakeItem): string | null {
  return textToolWakeStale(item, { turns: turnStarts.get(item.sessionId) || 0, userTurns: userTurnStarts.get(item.sessionId) || 0 });
}
const wakeDispatcher = new WakeDispatcher({
  /* 等待退出期间也算忙：不开新一轮（同定时任务 / 排队消息） */
  isBusy: (sid) => quitPending || !!busyReasonFor(sid),
  deliver: (item) => {
    if (!wakeDeliver) return Promise.reject(Object.assign(new Error('KiroLex is still starting'), { code: SESSION_BUSY }));
    return wakeDeliver(item);
  },
  /* 定时任务那一次排着的时候被删 / 暂停 / 过期了就不发（盘上的状态为准，见 `scheduleDeliveryBlocker`） */
  isStale: (item) => (item.source === 'schedule' && item.ref
    ? scheduleDeliveryBlocker(scheduleStore.readSchedule(item.ref, os.homedir())?.state ?? null, Date.now())
    : item.source === 'nudge' ? textToolNudgeStale(item) : null),
  /* 不看报错文字（tr() 出来的，中文界面下是中文）：看错误码，或者此刻会话是不是真的在忙 */
  isBusyError: (err, item) => isWakeBusyError(err, quitPending || !!busyReasonFor(item.sessionId)),
  log: (m) => logger.info('wake', m),
});

/**
 * **换新的后端会话**（同一个执行器进程里 `session/new`）—— EmptyResponse / 连续拒绝、「写成文字」反复发作、
 * 控制入口的 `new-backend` 共用这一套：新开后端会话、记进记录、清掉「已建立上下文」并标成欠着
 * （上下文跟着下一条带过去；历史里文字版调用块已折叠成一句，见 `historyLine`）。
 * KiroLex 的会话 id、transcript 不变；后台任务（bg_run / watch / 定时任务）按 KiroLex 会话 id 记账，不受影响。
 */
async function recreateBackendSession(sessionId: string, entry: SessionEntry, trigger: string): Promise<{ oldId: string; newId: string }> {
  const oldId = entry.cliSessionId;
  /* 和 attach 那边同一个来源 —— cwd 不一致的话新会话会落在别的目录上 */
  const cwd = entry.cwd || sessionCwd(entry.profile, os.homedir());
  const made = await entry.client.newSession(cwd);
  entry.cliSessionId = made.sessionId;
  /* 同一 client 上的 session/new：「响应之后才回放」那种形状也要丢（`replayGuard.outsideTurnVerdict`）—— 回放窗口重新打开 */
  entry.replayWindow = true;
  const rec2 = store.readRecord(sessionId);
  if (rec2) { rec2.cliSessionId = made.sessionId; store.writeRecord(rec2); }
  /* 新会话里当然什么都没有 —— 清掉"已建立"，让上下文跟着下一次发送带过去 */
  clearContextEstablished(sessionId);
  markContextOwedIfUnverified(sessionId, trigger);
  /*
    Claude Code / Codex：新的后端会话回到适配器默认的模型 / effort / 权限模式（Claude 会退回那台机器的
    defaultMode，于是每个工具都来问）。把这条会话记着的设回去，并且等设完 —— 调用方紧接着就重发。
  */
  if (engineOf(entry.profile) !== 'kiro') {
    entry.engineOptionsReady = applyEngineModel(sessionId, entry).catch(() => { /* 失败只记日志（applyEngineModel 里） */ });
    await entry.engineOptionsReady;
  }
  /* 换完 id，那条旧对话的失败计数就没意义了 */
  cliFailStreak.delete(oldId);
  return { oldId, newId: made.sessionId };
}

/**
 * 会话**空着**的时候换后端会话（「写成文字」的自动恢复、控制入口）：换的那一下占住会话（和换模型同一个标记），
 * 别让同一刻发出的一条新消息落到旧的后端会话上。正在跑一轮 / 重建历史 / 换执行器 / 挂载中 → 抛 `SESSION_BUSY`。
 */
async function swapBackendSessionWhenIdle(sessionId: string, trigger: string): Promise<{ oldId: string; newId: string }> {
  const entry = sessionClients.get(sessionId);
  if (!entry) throw new Error(tr('Session not connected'));
  const busy = busyReasonFor(sessionId);
  if (busy && busy !== 'prime-pending') {
    throw Object.assign(new Error(tr('This session is busy, so the backend session was not switched. Try again when it is idle.')), { code: SESSION_BUSY });
  }
  reconfiguringSessions.add(sessionId);
  emitSessionBusy(sessionId);
  try {
    const r = await recreateBackendSession(sessionId, entry, trigger);
    /* 新的后端是干净的：「写成文字」的计数从头来 */
    textToolRecovery.set(sessionId, afterBackendSwap(textToolRecovery.get(sessionId)));
    logger.warn('prompt', `backend session swapped (${trigger}) sessionId=${sessionId} ${r.oldId} -> ${r.newId}`);
    return r;
  } finally {
    reconfiguringSessions.delete(sessionId);
    emitSessionBusy(sessionId);
  }
}

/** 已经换过后端会话、还没续发出去的那几条（按唤醒项 id）—— 见 `wakeDeliver`。 */
const textToolSwapDone = new Set<string>();
/** 每条会话「写成文字」的恢复状态（检测次数、窗口里自动换过几次后端会话、是否停下）—— 判据见 `textToolRecovery.ts`。 */
const textToolRecovery = new Map<string, TextToolRecoveryState>();

/**
 * **模型把工具调用写成了文字就结束了这一轮**（判据见 `textToolCall.ts`，怎么处置见 `textToolRecovery.ts`）：
 *   · `nudge`（第一次）：作为新的一条补发纠正（显示为 KiroLex 提示，不算你的消息）—— 走后台唤醒同一条投递队列：
 *     等这一轮真的结束再发；排着的时候开了别的一轮就不发了（`textToolNudgeStale`）；
 *   · `swap`（第二次，含跨轮次）：同一条投递队列，发之前换新的后端会话（`wakeDeliver` 里），再把卡住的那一步发给新后端；
 *   · `halt`（30 分钟里已经自动换过 SWAP_MAX 次还这样）：会话里一句 ⚠️ + 详情，之后不再自动处理，直到你发下一条消息。
 */
function handleTextToolCall(sessionId: string, verdict: { action: TextToolAction; hit?: TextToolCall }, text: string): void {
  const d = decideTextToolRecovery(textToolRecovery.get(sessionId), { verdict, text, now: Date.now() });
  textToolRecovery.set(sessionId, d.state);
  const names = d.tools.join(', ') || '?';
  logger.warn('prompt', `tool call written as text sessionId=${sessionId} verdict=${verdict.action} action=${d.action} swaps=${d.swapsInWindow} tools=${names}`);
  if ((d.action === 'nudge' || d.action === 'swap') && d.prompt) {
    void wakeDispatcher.enqueue({
      sessionId, text: d.prompt, at: Date.now(), source: 'nudge',
      /* 纠正按「开过几轮」判过时；换后端续做按「你发过几条」判（见 textToolWakeStale） */
      ref: String((d.action === 'swap' ? userTurnStarts : turnStarts).get(sessionId) || 0),
      ...(d.action === 'swap' ? { swap: true } : {}),
    }).then((r) => {
      /* 换后端那一条没换成（被你的新消息取代 / 出错）：不记次数，下次再犯直接换 */
      if (d.action === 'swap' && (!r.ok || r.skipped)) textToolRecovery.set(sessionId, swapAbandoned(textToolRecovery.get(sessionId)));
      if (r.ok || r.skipped) return;
      logger.warn('prompt', `text-tool ${d.action} not sent session=${sessionId}: ${r.error}`);
      /* 换后端会话 / 续发没成：说一句，别让你以为它在继续 */
      if (d.action === 'swap') {
        noteInSession(sessionId, trConcat(
          tr('⚠️ Could not switch to a new backend session, so the step that did not run was not continued.'),
          NOTE_DETAIL_SEP,
          tr('Reason: {err}. Send a message to continue.', { err: String(r.error || '').slice(0, 160) })),
        undefined, 'text-tool-call-swap-failed');
      }
    });
    return;
  }
  if (d.action === 'halt') {
    noteInSession(sessionId, trConcat(
      tr('⚠️ The model still writes tool calls as text, so automatic handling has stopped until you send your next message.'),
      NOTE_DETAIL_SEP,
      tr('Within {window} minutes it already switched to a new backend session {n} time(s) automatically (limit {max}); the last tool it tried to call: {tools}. Until you send the next message, it will not correct or switch automatically.', {
        window: Math.round(SWAP_WINDOW_MS / 60_000), n: d.swapsInWindow, max: SWAP_MAX, tools: names,
      })),
    undefined, 'text-tool-call-halt');
  }
}

const bgJobs = new BgJobManager({
  wake: (sessionId, text, job) => {
    void wakeDispatcher.enqueue({ sessionId, text, at: Date.now(), source: job.kind === 'watch' ? 'watch' : 'bg', ref: job.jobId })
      .then((r) => { if (!r.ok) logger.warn('bg', `唤醒没发出去 job=${job.jobId} session=${sessionId}: ${r.error}`); });
  },
  /* 落进会话记录（重开也在）：`noteInSession` 同时推给界面当场插进这条会话（正在回复就等这一轮结束再插）；状态行上也说一声 */
  note: (sessionId, text) => { noteInSession(sessionId, text); sessionNotice(sessionId, text); },
  changed: (running) => {
    /* 只记标签和命令前 80 字（见 bgJobs.ts）—— 重启后据此补一句「已中断」 */
    try { writeRunningJobs(os.homedir(), running); } catch (err: any) { logger.warn('bg', `bg-jobs.json 写不进去: ${err?.message || err}`); }
    mainWindow?.webContents.send('bg:changed');
  },
  log: (m) => logger.info('bg', m),
});

/** 这条会话见过后台命令 / 监视的输出（唤醒里带着、或 bg_status 读到）：持久记下，之后的诊断包 / 上下文快照都不留会话内容。 */
function markBgOutputSeen(sessionId: string): void {
  try { if (!store.readRecord(sessionId)?.bgOutputSeen) store.patchRecord(sessionId, { bgOutputSeen: true }); } catch { /* 记录读写失败不挡工具 */ }
}

/**
 * 换运行位置时提示里的那句：后台任务 / 定时任务不跟执行器走（跑在本机、按会话 id 记账），
 * 还有在跑的就明说「照常」（见 `switchCarryOverText`）；没有就是空串。
 */
function wakeCarryOverFor(sessionId: string): string {
  const bgLive = bgJobs.list(sessionId).filter((j) => j.state === 'running').length;
  const schedLive = scheduleStore.listSchedules(os.homedir(), store.isAdvancedOnlySession)
    .filter((j) => j.state.sessionId === sessionId && !j.state.terminal && !j.state.paused).length;
  const text = switchCarryOverText(bgLive, schedLive);
  if (text) logger.info('remote', `切换运行位置时还有后台任务 ${bgLive} 个、定时任务 ${schedLive} 个，照常运行 sessionId=${sessionId}`);
  return text;
}

/** kirolex-local 上的 schedule_* / bg_* / watch：本地和远程会话都有。 */
const wakeMcpTools = {
  call: (name: string, args: any, sid: string, workdir: string) => callWakeTool(name, args, sid, workdir, wakeHost),
};

/*
  **会话之间互相调用**（kirolex-local 的 `sessions_list` / `session_read` / `session_send`，纯逻辑在 sessionCalls.ts）。
  走主进程，不经控制入口的 HTTP、不要 token。发送交给界面按 Enter 的同一套路由（`forwardToUi`，和控制入口共用那条内部 IPC）；
  界面没就绪就进唤醒队列，对方空了再发。`waitReply` 的回复由 `replyWatcher` 发现、经 `wakeDispatcher` 唤醒发起方。
  删掉的（墓碑）和 KiroLex Advanced 的会话一律当不存在。
*/
const sessionCallLimiter = new PairRateLimiter();
function sessionCallInfo(rec: store.SessionRecord, busy: Set<string>): SessionInfo {
  const host = rec.profile?.remote?.sshHost;
  return {
    id: rec.id,
    title: rec.title || 'New Chat',
    ...(rec.profile?.projectId ? { projectId: rec.profile.projectId } : {}),
    engine: rec.profile?.engine || 'kiro',
    location: host ? (labelForHost(KIROLEX_CONFIG_PATH, host) || host) : null,
    busy: busy.has(rec.id),
    archived: !!rec.archived,
  };
}
const sessionCallsHost: SessionCallsHost = {
  now: () => Date.now(),
  enabled: () => isFeatureEnabled('sessionCalls'),
  list: () => {
    const busy = controlBusyIds();
    const tombstoned = new Set([...loadSessionTombstones(), ...deletedSessionIds]);
    return store.listSessions().filter((rec) => !tombstoned.has(rec.id)).map((rec) => sessionCallInfo(rec, busy));
  },
  get: (id) => {
    const rec = controlVisibleRecord(id);
    return rec ? sessionCallInfo(rec, controlBusyIds()) : null;
  },
  transcript: (id) => store.readTranscript(id),
  send: async ({ from, to, text, mode }) => {
    const r = await forwardToUi(to, text, mode, 'xs');
    logger.info('sessions', `session_send ${from} -> ${to} chars=${text.length} mode=${mode} -> ${r.ok ? r.routed : `${r.status} ${r.error}`}`);
    /* 追加失败（对方引擎不收 / 写不进去）：界面已经把它标红等用户选；把原因交给 session_send，别当成发成功 */
    if (r.ok) return { ok: true, routed: r.routed, messageId: r.messageId, ...(r.steerFailed ? { steerFailed: r.steerFailed } : {}) };
    if (r.error === 'ui-not-ready') {
      /* 窗口没开 / 正在刷新：主进程的唤醒队列接着，对方空了再发（同后台唤醒：作为新的一条，不 steer） */
      const ref = controlMessageId('queue', Date.now(), 'xs');
      void wakeDispatcher.enqueue({ sessionId: to, text, at: Date.now(), source: 'session', ref })
        .then((w) => { if (!w.ok) logger.warn('sessions', `session_send 经唤醒队列没发出去 ${from} -> ${to}: ${w.error}`); });
      return { ok: true, routed: 'queued', messageId: ref };
    }
    const why: Record<string, string> = {
      archived: '对方已归档',
      'loop-running': '对方正被一个循环占着（循环跑完或用户停掉之后再发）',
      'ui-timeout': '界面 15 秒没回应 —— 可能已经发出去了，先用 session_read 看一眼再决定要不要重发',
    };
    return { ok: false, error: why[r.error] || r.error };
  },
  /* 发起方会话里的记录行：KiroLex 提示，落盘（noteInSession）；不发给模型 */
  note: (sid, text) => { noteInSession(sid, text); },
  watchReply: (w) => replyWatcher.add(w),
};
const sessionMcpTools = {
  call: (name: string, args: any, sid: string) => callSessionTool(name, args, sid, sessionCallsHost, sessionCallLimiter),
};

/** 等对方回复的登记落在这里（重启后接着等）。tmp + rename 写。 */
const SESSION_CALLS_FILE = path.join(os.homedir(), '.kirolex', 'session-calls.json');
const replyWatcher = new ReplyWatcher({
  now: () => Date.now(),
  transcript: (id) => store.readTranscript(id),
  /* 还在跑一轮 / 换执行器 / 重建历史，或者唤醒队列里还有要发给它的 —— 都还没「这一轮结束」 */
  isBusy: (id) => !!busyReasonFor(id) || wakeDispatcher.pending(id).length > 0,
  exists: (id) => !!controlVisibleRecord(id),
  title: (id) => store.readRecord(id)?.title || null,
  deliver: (sid, text, w) => {
    void wakeDispatcher.enqueue({ sessionId: sid, text, at: Date.now(), source: 'session', ref: w.id })
      .then((r) => { if (!r.ok) logger.warn('sessions', `回复没能唤醒发起方 ${w.id} session=${sid}: ${r.error}`); });
  },
  changed: (list) => {
    try {
      fs.mkdirSync(path.dirname(SESSION_CALLS_FILE), { recursive: true });
      if (!list.length) { fs.rmSync(SESSION_CALLS_FILE, { force: true }); return; }
      const tmp = `${SESSION_CALLS_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ watches: list }, null, 2));
      fs.renameSync(tmp, SESSION_CALLS_FILE);
    } catch (err: any) {
      logger.warn('sessions', `session-calls.json 写不进去: ${err?.message || err}`);
    }
  },
  log: (m) => logger.info('sessions', m),
});

/** kirolex-local 上那组工具的落地：定时任务就是现有的定时任务（同一个存储、同一个计时器）。 */
const wakeHost: WakeHost = {
  now: () => Date.now(),
  createSchedule: (sessionId, spec, expiresAt) => {
    if (refuseAdvancedOnly(sessionId, 'schedule:create')) return { ok: false, error: tr('This session belongs to KiroLex Advanced; the standard edition does not modify it.') };
    if (!store.readRecord(sessionId) || deletedSessionIds.has(String(sessionId))) return { ok: false, error: tr('Select a session that has already been created first') };
    const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const state = { ...newSchedule(sessionId, spec, Date.now()), createdBy: 'model' as const, expiresAt };
    try {
      scheduleStore.writeSchedule(id, state, os.homedir(), store.isAdvancedOnlySession);
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
    logger.info('schedule', `created by model id=${id} session=${sessionId} ${describeSchedule(spec)} maxRuns=${spec.maxRuns} expiresAt=${expiresAt ?? 'none'}`);
    mainWindow?.webContents.send('schedule:changed', { id, state });
    return { ok: true, id, describe: describeSchedule(spec), nextRunAt: nextRunAt(state) };
  },
  listSchedules: (sessionId) => scheduleStore.listSchedules(os.homedir(), store.isAdvancedOnlySession)
    .filter((job) => job.state.sessionId === sessionId)
    .map((job) => ({
      id: job.id, describe: describeSchedule(job.state.spec), prompt: job.state.spec.prompt, runs: job.state.runs,
      maxRuns: job.state.spec.maxRuns, paused: job.state.paused, terminal: job.state.terminal, nextRunAt: nextRunAt(job.state),
      createdBy: job.state.createdBy, expiresAt: job.state.expiresAt ?? null,
      until: job.state.spec.until, checkCommand: job.state.spec.checkCommand,
    })),
  deleteSchedule: (sessionId, id) => {
    const job = scheduleStore.readSchedule(id, os.homedir());
    if (!job || job.state.sessionId !== sessionId) return { ok: false, error: tr('This scheduled task was not found') };
    scheduleStore.removeSchedule(id, os.homedir(), store.isAdvancedOnlySession);
    wakeDispatcher.dropRef(id, 'removed');
    logger.info('schedule', `removed by model id=${id}`);
    mainWindow?.webContents.send('schedule:changed', { id, state: null });
    return { ok: true };
  },
  bg: bgJobs,
  /* 同 `local_bash`：跑在本机、cwd 是这条会话的**本地**工作目录（远程会话的 entry.cwd 是远端草稿目录，不能用） */
  cwdFor: (sessionId, fallback) => sessionClients.get(sessionId)?.localDir || store.readRecord(sessionId)?.localDir || fallback,
  markOutputSeen: (sessionId) => markBgOutputSeen(sessionId),
};

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
/** 按会话 + messageId 正在跑的发送 —— 同一次提交又来一次就合并到这一次（`promptDedupe.ts`）。 */
const promptsInFlight = new InFlightPrompts<any>();

/**
 * `sendPromptOnce` 开头那一问：**同一个 messageId 只落盘一次、只发一次**（判据在 `promptDedupe.ts`）。
 * 已经答过的同一次提交直接拒（抛 `DUPLICATE_MESSAGE`）；在盘上但没答的（上一次没发成）照发，但不再追加一条。
 */
/**
 * **模型开始做这一条了**（第一次出字、第一次调工具）：记下这条用户消息的 id（`store.markMessageStarted`，跟着会话记录落盘）。
 * 之后同一个 messageId 又来（排队重试、侧栏再提交、重连后重发、窗口重载后）就拒绝自动再发 —— 它可能已经写过文件、跑过命令。
 * 重建历史那一轮（priming）不算：它不是在做这条消息。
 */
function noteTurnStarted(sessionId: string, entry: SessionEntry): void {
  const id = entry.currentUserMessageId;
  if (!id || entry.priming || entry.startedNoted === id) return;
  entry.startedNoted = id;
  try { store.markMessageStarted(sessionId, id); } catch { /* 记不下就只少一层保险，不影响这一轮 */ }
}

/**
 * 侧栏改写**问过模型之后**失败了：这次提交还能不能按同一个 messageId 接着来（`retrySame`）——
 * 只有模型对这一问还**什么都没做**（没出字、没跑工具）时可以；已经开始做了的，再按同一次来就是再做一遍，
 * 渲染层就不留这张 ticket（再提交是新的一次 —— 等于你明确要求重跑）。重复被拒的那两种也不留。
 */
function retrySameIf(sessionId: string, messageId: string | undefined, err?: any): { retrySame?: true } {
  if (err?.code === DUPLICATE_MESSAGE || err?.code === DUPLICATE_STARTED) return {};
  if (!messageId) return {};
  return canRetrySame(store.messageIdStatusOnDisk(sessionId, messageId)) ? { retrySame: true } : {};
}

function promptDedupeFor(sessionId: string, messageId: string | undefined, attempt: number): { persist: boolean } {
  /*
    自动重发（attempt > 0）也要看：这一轮（上一次那个用户消息 id，没给 id 时就是 `currentUserMessageId`）模型已经开始做了，
    就不再发（`noteTurnStarted` 记的那份，跟着会话记录落盘）。
  */
  const checkId = messageId ?? (attempt > 0 ? sessionClients.get(sessionId)?.currentUserMessageId : undefined);
  const dedupe = decidePromptDedupe({
    explicitId: !!messageId,
    attempt,
    status: checkId ? store.messageIdStatusOnDisk(sessionId, checkId) : 'absent',
  });
  if (dedupe.action === 'reject' && dedupe.reason === 'started') {
    logger.warn('prompt', `refused re-send sessionId=${sessionId} messageId=${checkId} attempt=${attempt}: 这一条上次已经开始执行（出过字 / 跑过工具）后中断了 —— 不自动再发`);
    /* 在会话里说清楚为什么没再发、要怎么重来（同一条只说一次） */
    noteInSession(sessionId, tr('⚠️ This message already started running last time (it produced output or ran tools) and was cut off, so KiroLex did not send it again automatically, to avoid doing it twice. To redo it, press Rerun on that message.'), undefined, `started-not-resent:${checkId}`);
    throw Object.assign(new Error(tr('This message already started running last time and was cut off, so it was not sent again automatically. To redo it, press Rerun on that message.')), { code: DUPLICATE_STARTED });
  }
  if (dedupe.action === 'reject') {
    logger.warn('prompt', `refused duplicate sessionId=${sessionId} messageId=${messageId}: 这一条已经在盘上、也有回复了 —— 不再追加、不再发`);
    throw Object.assign(new Error(tr('This message was already sent and answered, so it was not sent again. To redo it, press Rerun on that message.')), { code: DUPLICATE_MESSAGE });
  }
  if (attempt === 0 && !dedupe.persist) {
    logger.info('prompt', `messageId=${messageId} 已经在盘上、还没有回复 —— 重发这一条，不再追加 sessionId=${sessionId}`);
  }
  return dedupe;
}

/**
 * 侧栏改写重试时，这一问（`messageId`）在盘上**已经有完整回复**了：直接拿它当这一问的回复（`askOnce`）——
 * 同一次提交只发给模型一次。没有（没答过、或者只有被停掉 / 截断的半截）就返回 null，照常发。
 */
function storedReplyFor(sessionId: string, messageId: string | undefined): Promise<{ text: string; stopReason: string; wedged: boolean }> | null {
  if (!messageId) return null;
  const text = store.completedReplyOnDisk(sessionId, messageId);
  if (text === null) return null;
  logger.info('revise', `messageId=${messageId} 盘上已经有完整回复 —— 用它，不再发给模型 sessionId=${sessionId}`);
  return Promise.resolve({ text, stopReason: 'end_turn', wedged: false });
}

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

/** 已经说过「已排队」的那些提交（ticket）—— 同一次提交只说一次。 */
const reviseQueuedNoticed = new Set<string>();

/** 正在排 / 正在跑的改写，按「ticket | 档」—— 同一次提交又来一次就合并到这一次（见 `review:revise-in-session`）。 */
const revisesInFlight = new Map<string, Promise<any>>();

/**
 * 改写结束了却没写完盘的那些，按 ticket 记下**怎么结束的**（`review:tickets-status`）：`retry` = 那一问没拿到完整回复
 * （网络断了、超时、被停掉 / 截断）或者"改不了"还没升级，`final` = 模型答了却没做成（格式不对、冲突……）。
 * 那时窗口可能不在（reload 中），收不到这个结果 —— 窗口回来再问。只留最近的一些。
 */
const reviseOutcomes = new Map<string, 'retry' | 'final'>();
function recordReviseOutcome(ticket: string | undefined, res: any): void {
  if (!ticket || !res || res.ok || res.cancelled) return;
  reviseOutcomes.set(ticket, res.error && !res.retrySame ? 'final' : 'retry');
  if (reviseOutcomes.size > 500) for (const k of [...reviseOutcomes.keys()].slice(0, 100)) reviseOutcomes.delete(k);
}

/**
 * 排到这条会话的队尾，轮到了再跑。失败不断链（否则一次失败会把后面几条全带走）。
 *
 * **真的要等的时候说一声**：队列只活在主进程里，等待期间会话里一个字都没有 —— 而"什么都没发生"和
 * "排上队了"在屏幕上长得一模一样。不等的那些（绝大多数）什么都不说：一条"已排队"紧接着一条"已改完"
 * 只是噪音。
 */
function enqueueRevise<T>(sessionId: string, job: () => Promise<T>, label?: string, noticeKey?: string, trackScope?: string): Promise<T> {
  const ahead = revisePending.get(sessionId) || 0;
  /* 同一次提交（同一张 ticket，含 block → patch 升级那一问）只说一次「已排队」 */
  const noticedBefore = !!noticeKey && reviseQueuedNoticed.has(noticeKey);
  if (label && !noticedBefore) {
    const busy = busyReasonFor(sessionId);
    /*
      「已排队」只需知道、不用操作 → 状态行（不进对话记录）；两种原因合成一句带参数的（docs/notices-glossary.md）
    */
    if (ahead > 0 || busy) {
      if (noticeKey) {
        reviseQueuedNoticed.add(noticeKey);
        if (reviseQueuedNoticed.size > 500) for (const k of [...reviseQueuedNoticed].slice(0, 100)) reviseQueuedNoticed.delete(k);
      }
    }
    if (ahead > 0) {
      sessionNotice(sessionId, tr('⏳ Queued: {label} ({why}); it will be sent automatically.', { label, why: tr('{n} earlier revision(s) still running', { n: ahead }) }), { group: `revise-queued:${noticeKey || label}` });
    } else if (busy) {
      sessionNotice(sessionId, tr('⏳ Queued: {label} ({why}); it will be sent automatically.', { label, why: tr('session busy: {busy}', { busy }) }), { group: `revise-queued:${noticeKey || label}` });
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
  /*
    `trackScope`：按「ticket | 档」登记进 `revisesInFlight`（在跑期间同一张 ticket 再来就合并）、结束时记结局（`recordReviseOutcome`，
    窗口 reload 回来按它决定沿用还是新起）—— deck 一页版面文字那条用；`review:revise-in-session` 在自己的 handler 里做同样的事。
  */
  if (noticeKey && trackScope) {
    const key = `${noticeKey}|${trackScope}`;
    revisesInFlight.set(key, next);
    next.then((res) => recordReviseOutcome(noticeKey, res), () => {});
    next.finally(() => { if (revisesInFlight.get(key) === next) revisesInFlight.delete(key); }).catch(() => {});
  }
  return next;
}

/**
 * 改写等空闲等了 20 分钟、放弃了：**在对话记录里说**，带上原文（`reviseGaveUp.ts`）。意见本身照旧交回文件预览、
 * 放回那一处（`retrySame`），再点 ✓ 按同一次重发。写不进记录（advanced 会话等）就在状态行说。
 */
function noteReviseGaveUp(sessionId: string, label: string, original: string, busy: string): void {
  const text = reviseGaveUpNote(label, original, busy);
  const group = reviseGaveUpGroup(label);
  if (!noteInSession(sessionId, text, undefined, group)) sessionNotice(sessionId, text, { group });
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
 * 键 `''` = 没带会话读的（工作区面板、没有当前会话时）。进程重启就清空 —— 重启之后你没看过任何东西
 * （恢复出来的标签页第一次提交前，渲染层会重新读一次）。远端文件按 `remoteReviewKey(机器, 路径)` 记（见 `reviewAccess.ts`）。
 */
const reviewedPaths = new ReviewedPaths();
function markReviewed(sessionId: string | null | undefined, resolvedPath: string): void {
  reviewedPaths.mark(sessionId, resolvedPath);
}
function wasReviewed(sessionId: string | null | undefined, resolvedPath: string): boolean {
  return reviewedPaths.has(sessionId, resolvedPath);
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
    throw new Error(tr('No encrypted storage (keychain / keyring) is available on this machine, so KiroLex refuses to write the secret into the config in plain text.'));
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
/** 组合文件上次同步完两边的内容摘要（`mcpCombosSync.ts` 的 `ComboSyncMark`） */
const S3_COMBOS_MARK_PATH = path.join(KIROLEX_HOME, 's3-combos-sync.json');
/** agent-profiles 每个文件上次同步完两边的内容摘要（`agentProfileSync.ts` 的 `ProfileMarks`） */
const S3_PROFILES_MARK_PATH = path.join(KIROLEX_HOME, 's3-agent-profiles-sync.json');
/**
 * 本机删过哪些会话、什么时候删的（`cloudTrash.ts` 的删除记录）—— 云端自动清理靠它区分「删掉了」和「没见过」。
 * 不能用 `deleted-sessions.json`：那份在会话目录真的移走之后就清掉了。
 */
const S3_DELETED_AT_PATH = path.join(KIROLEX_HOME, 's3-deleted-at.json');
/** 本机数据目录的设备 ID（清单按它存；主机名只用来显示）—— 同名电脑不会互相覆盖清单，见 `cloudTrash.loadOrCreateDeviceId`。 */
const DEVICE_ID_PATH = path.join(KIROLEX_HOME, 'device-id.json');
function thisDeviceId(): string {
  return loadOrCreateDeviceId(DEVICE_ID_PATH, machineTag(os.hostname()), () => crypto.randomUUID().replace(/-/g, '').slice(0, 16));
}

/** 云端清理用的 S3 操作（`cloudTrash.ts` 的 `BucketOps`）。 */
function bucketOps(creds: S3Creds): BucketOps {
  return {
    list: (p) => listObjects(creds, p),
    get: (k) => getObjectIfExists(creds, k),
    put: (k, body, type) => putObject(creds, k, body, type),
    del: (k) => deleteObject(creds, k),
    getWithEtag: (k) => getObjectWithEtag(creds, k),
    putIf: (k, body, type, cond) => putObjectIf(creds, k, body, type, cond),
    delIf: (k, etag) => deleteObjectIf(creds, k, etag),
    delVersion: (k, versionId) => deleteObjectVersion(creds, k, versionId),
    listVersions: (k) => listObjectVersions(creds, k),
    listVersionKeys: (p) => listVersionedKeys(creds, p),
  };
}

/**
 * 这台机器的「本机现存会话清单」：项目里的、未分组的、已归档的、设成不同步的、KiroLex Advanced 的都算"有"——
 * 再加上 sessions/ 下所有目录（记录读不出来的也算有：宁可多报"有"，不可少报）。
 * 删除记录：本机那张表 + 本机回收站里 `<id>__<时间>` 的目录名（补上这张表出现之前删的）。
 */
function thisDeviceManifest(deviceId: string, host: string, now: number) {
  const recs = store.listSessions();
  const sessions: Array<{ id: string; project?: string; archived?: boolean }> = recs.map((r) => ({ id: r.id, project: projectOf(r) || undefined, archived: !!r.archived }));
  for (const id of store.listAdvancedOnlyIds()) sessions.push({ id });
  for (const id of walkDirs(path.join(KIROLEX_HOME, 'sessions'))) if (/^[\w.-]{1,120}$/.test(id)) sessions.push({ id });
  const marks = pruneDeletionMarks(readDeletionMarks(S3_DELETED_AT_PATH), now);
  writeDeletionMarks(S3_DELETED_AT_PATH, marks);
  let trashNames: string[] = [];
  try { trashNames = fs.readdirSync(SESSION_TRASH_DIR); } catch { /* 没有回收站 */ }
  const fromTrash = deletionsFromTrashNames(trashNames);
  const deletions = { ...fromTrash };
  for (const [id, at] of Object.entries(marks)) deletions[id] = Math.max(deletions[id] || 0, at);
  return buildDeviceManifest(deviceId, now, sessions, deletions, host);
}

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
  if (missing.length) return { problem: tr('S3 backup is not fully set up: missing {fields} (Settings → ☁️ Backup).', { fields: trList(missing) }) };
  const secretAccessKey = decryptSecret(cfg.secretCipher);
  if (!secretAccessKey) {
    return { problem: tr('The S3 secret can\'t be decrypted any more: the key in the keychain has changed (new machine or reinstall?). Enter it again.') };
  }
  return {
    creds: {
      accessKeyId: cfg.accessKeyId!, secretAccessKey,
      region: cfg.region!, bucket: cfg.bucket!, endpoint: cfg.endpoint,
    },
  };
}

let syncRunning = false;

/**
 * **本机对 catalog.json 的操作排成一队**（删除 / 同步写 catalog / 恢复时清目录 / 以本机为准 / 从目录里移除）——
 * 连点几次删除、或删除和定时同步交错时，各自读到的快照互相覆盖，删掉的条目又复活了（见 `catalogStore.ts`）。
 * 每次写还会重读最新的再条件写（防别的机器），这个队列防的是同一台机器自己打自己。**别在队列里再进队列**。
 */
const catalogQueue = serialQueue();

/** 本机删过哪些会话的备份、什么时候 —— 正在跑的那一轮同步写状态表时要把它们去掉（见 runS3Sync）。 */
const backupDeletedAt = new Map<string, number>();

/** 有的 S3 兼容存储不认条件写（回 501）—— 认出来之后这个进程里就直接写（仍有队列 + 写前重读）。 */
let catalogCondUnsupported = false;

/** catalogStore 要的桶操作，接到真 S3 上。 */
function catalogBucket(creds: S3Creds, prefix: string | undefined): CatalogBucket {
  return {
    get: (key) => getObjectWithEtag(creds, key),
    put: async (key, body, cond) => {
      if (!cond || catalogCondUnsupported) { await putObject(creds, key, body, 'application/json'); return 'ok'; }
      try { return await putObjectIf(creds, key, body, 'application/json', cond); }
      catch (err: any) {
        if (!(err instanceof S3Error) || err.status !== 501) throw err;
        catalogCondUnsupported = true;
        logger.warn('s3', '这个存储不认条件写（If-Match），catalog 改成本机排队 + 写前重读');
        await putObject(creds, key, body, 'application/json');
        return 'ok';
      }
    },
    list: async (pfx) => (await listObjects(creds, pfx)).map((o) => o.key),
    del: (key) => deleteObject(creds, key),
    sessionIds: async () => sessionIdsFromPrefixes(prefix, await listCommonPrefixes(creds, `${keyFor(prefix, 'sessions')}/`)),
    deletedAt: (id) => prefixDeletedAt(creds, sessionKeyPrefix(prefix, id)),
  };
}
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
let lastSyncSummary: { at: number; uploaded: number; skipped: number; bytes: number; error?: string; cloudTrashed?: number; cloudPurged?: number } | null = null;

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

/**
 * **advanced 的会话（flow / skill），标准版按 id 也不碰** ——「防止两版串」。
 *
 * 枚举那一侧 `store.listSessions()` 已经把它们藏了；这里挡的是按 id 直接打进来的（UI 缓存里残留的 id、
 * 老的分屏布局、控制入口）。返回 null = 放行；否则是要回给调用方的拒绝原因。判据只有一份（`advancedOnly.ts`）。
 */
function refuseAdvancedOnly(sessionId: string, what: string): string | null {
  if (!sessionId || !store.isAdvancedOnlySession(sessionId)) return null;
  logger.warn('session', `refused ${what}: sessionId=${sessionId} 是 KiroLex Advanced 的会话（flow / skill），标准版不碰`);
  return tr('This session belongs to KiroLex Advanced; the standard edition does not modify it.');
}

/**
 * **只在云上的那些备份是不是 advanced 的** —— 本机没有记录（`listAdvancedOnlyIds` 认不出）时，
 * 读桶里那份 `record.json` 用同一个判据判。读失败的进 `unreadable`：删除备份时一律不删。
 */
function cloudAdvancedBackups(creds: S3Creds, prefix: string | undefined, ids: Iterable<string>) {
  return findAdvancedBackups(ids, (id) => getObjectIfExists(creds, keyFor(prefix, path.join('sessions', id, 'record.json'))));
}

/**
 * **云端自动清理不动的那些** —— KiroLex Advanced 的会话（本机藏着的、云上 record.json 是 advanced 的、
 * 归在 advanced 专属项目里的），以及 record.json 读不出来的（确认不了用途 = 不清）。只对候选查，不是每条都读。
 */
async function cloudCleanupSpare(creds: S3Creds, prefix: string | undefined, ids: string[]): Promise<Set<string>> {
  const hidden = store.listAdvancedOnlyIds();
  /* 和 cloudAdvancedBackups 同一个判据，但桶里**没有** record.json 也算读不出来（拿不准 = 不清） */
  const cloud = await findAdvancedBackups(ids.filter((id) => !hidden.has(id)), async (id) => {
    const b = await getObjectIfExists(creds, keyFor(prefix, path.join('sessions', id, 'record.json')));
    if (!b) throw new Error('no record.json');
    return b;
  });
  let inAdvancedProject = new Set<string>();
  try {
    const raw = await getObjectIfExists(creds, catalogKey(prefix));
    const catalog = raw ? JSON.parse(raw.toString('utf-8')) as Catalog : null;
    const want = new Set(ids);
    const mine = (catalog?.entries || []).filter((e) => want.has(e.id));
    const advanced = store.advancedOnlyProjectsAmong(mine.map((e) => e.project || ''));
    inAdvancedProject = new Set(mine.filter((e) => advanced.has(e.project || '')).map((e) => e.id));
  } catch { return new Set(ids); }   // 读不懂 catalog：这一轮全都不动
  return new Set(ids.filter((id) => hidden.has(id) || cloud.advanced.has(id) || cloud.unreadable.has(id) || inAdvancedProject.has(id)));
}

/**
 * **恢复页要藏起来的那些备份** —— advanced 的会话（flow / skill）：本机藏着的（`listAdvancedOnlyIds`），
 * 加上只在云上、桶里 record.json 是 advanced 的。不认出来就会显示成「本地没有」：既像可恢复，又像该清理的。
 * 读不出来的照常列（恢复时 `refuseAdvancedBackup` 还会再判；删除备份时不删）。
 *
 * 还有**归到本机 KiroLex Advanced 专属项目（flow 项目）的那些**：恢复页按项目分组，不藏的话就会冒出一个
 * 「周报」分组，而点恢复只会被拒（见 `vetBackupRecord` 的 refuseProject）。归属的算法和恢复页显示的一样（`catalogProject`）。
 */
async function advancedBackupIds(creds: S3Creds, prefix: string | undefined, catalog: Catalog, local: Set<string>): Promise<Set<string>> {
  const hidden = store.listAdvancedOnlyIds();
  const cloudOnly = (catalog.entries || []).map((e) => e.id).filter((id) => !local.has(id) && !hidden.has(id));
  const cloud = await cloudAdvancedBackups(creds, prefix, cloudOnly);
  const projectById = new Map(store.listSessions().map((r) => [r.id, projectOf(r)]));
  const groupOf = (e: CatalogEntry) => catalogProject(e, projectById.get(e.id)) || '';
  const advancedProjects = store.advancedOnlyProjectsAmong((catalog.entries || []).map(groupOf));
  const inAdvancedProject = (catalog.entries || []).filter((e) => advancedProjects.has(groupOf(e))).map((e) => e.id);
  return new Set([...hidden, ...cloud.advanced, ...inAdvancedProject]);
}

/**
 * 桶里这份备份是不是 advanced 的会话（flow / skill）—— `s3:restore` 动任何本地文件之前问。
 * 本机没有这条时 `refuseAdvancedOnly` 挡不住，而 catalog 里不带 purpose，只能看备份里的 record.json。
 * 判据在 `vetBackupRecord`：**读不出来 = 不恢复**（确认不了用途就不写）。放行时带回一个 `get`：
 * 恢复循环用它下载，record.json 直接给已校验的那份字节，不再 GET 一次（两次读到的可能不一样）。
 */
async function refuseAdvancedBackup(creds: S3Creds, prefix: string, objects: Array<{ key: string }>, sessionId: string): Promise<{ refused: string } | { get: (key: string) => Promise<Buffer> }> {
  const recordKey = objects.some((o) => o.key === `${prefix}record.json`) ? `${prefix}record.json` : null;
  const v = await vetBackupRecord(recordKey, (key) => getObject(creds, key), store.isAdvancedOnlyProjectName);
  if (v.ok) {
    const vetted = v.record;
    return { get: async (key) => (vetted && key === recordKey ? vetted : getObject(creds, key)) };
  }
  logger.warn('s3', `refused s3:restore: sessionId=${sessionId} ${v.reason === 'advanced' ? '桶里那份是 KiroLex Advanced 的会话'
    : v.reason === 'advanced-project' ? '桶里那份属于本机 KiroLex Advanced 专属的 flow 项目' : '桶里那份 record.json 读不出来、确认不了用途'}，标准版不恢复`);
  return { refused: v.reason === 'advanced'
    ? tr('This session belongs to KiroLex Advanced; the standard edition does not modify it.')
    : v.reason === 'advanced-project'
      ? tr('This project belongs to KiroLex Advanced; the standard edition does not modify it.')
      : tr("Could not read this backup's record.json, so it is not restored (it might be a KiroLex Advanced session). Try again later.") };
}

/**
 * **KiroLex Advanced 专属的项目（flow 项目），标准版不显示也不碰** —— 判据在 `advancedOnly.isAdvancedOnlyProject`
 * （有 flow 痕迹，并且项目下没有普通会话）。不改它的 project.json / runs / 记忆，也不许把会话放进去。
 * 返回 null = 放行；否则是拒绝原因。
 */
function refuseAdvancedProject(projectId: string | null | undefined, what: string): string | null {
  const p = String(projectId || '').trim();
  if (!p || !store.isAdvancedOnlyProjectName(p)) return null;
  logger.warn('project', `refused ${what}: project=${JSON.stringify(p)} 是 KiroLex Advanced 的 flow 项目，标准版不碰`);
  return tr('This project belongs to KiroLex Advanced; the standard edition does not modify it.');
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
    /* 不跟进 KiroLex Advanced 专属的 flow 项目：保持本机的位置（见 placementToFollow） */
    if (!placementToFollow(r, theirs, store.isAdvancedOnlyProjectName)) continue;
    /* 写之前按磁盘再读一遍 —— 列表那份可能已经旧了，拿它写回去会丢掉这期间别的改动 */
    const cur = store.readRecord(r.id);
    const p = placementToFollow(cur, theirs, store.isAdvancedOnlyProjectName);
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
      if (live?.busy || live?.autonomous) pendingProjectReset.add(r.id);
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
    /* 云上那份的位置要是 KiroLex Advanced 专属的 flow 项目，保留本机的位置（followBucketPlacements 同一条规则） */
    const merged = guardMergedPlacement(mergeRecords(mine, theirs), mine, store.isAdvancedOnlyProjectName);
    /* 合并之后这一份就是"最新"的：updatedAt 取两边的较大者，不然下一轮又被判成冲突 */
    merged.updatedAt = Math.max(Number(mine?.updatedAt) || 0, Number(theirs?.updatedAt) || 0, Date.now());
    store.writeRecordKeepUpdatedAt({ ...merged, id: sessionId });   // 走写盘那道关（不进 advanced 专属项目），updatedAt 按上面算的
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
  /** 最后一个文件真传完的时刻 —— catalog 条目和 marks 的 uploadedAt（和删除记录比谁新） */
  let lastPutAt = 0;
  for (const rel of rels) {
    const abs = path.join(KIROLEX_HOME, rel);
    const st = fs.statSync(abs);
    if (st.size > MAX_FILE_BYTES) continue;
    await putObject(creds, keyFor(prefix, rel), fs.readFileSync(abs), contentTypeFor(rel));
    lastPutAt = Date.now();
    state[rel] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    uploaded += 1;
  }
  writeState(S3_STATE_PATH, state);
  /* catalog：这一条换成本机的 —— 不换的话下一轮还是"别的机器传的、更新"，又判冲突。排队 + 写前重读，坏了就当空的 */
  const rec = store.readRecord(sessionId);
  const fresh = rec ? catalogEntriesFor([rec], thisMachine).map((e) => (lastPutAt ? { ...e, uploadedAt: lastPutAt } : e)) : [];
  await catalogQueue(() => updateCatalog(catalogIO(catalogBucket(creds, prefix), prefix),
    (c) => ({ ...c, entries: [...(c.entries || []).filter((e) => e.id !== sessionId), ...fresh] }), { onCorrupt: 'empty' }));
  const marks = readSessionMarks(S3_MARKS_PATH);
  marks[sessionId] = syncMark(Date.now(), rec?.updatedAt || 0, lastPutAt || undefined);
  writeSessionMarks(S3_MARKS_PATH, marks);
  return { deleted, uploaded };
}

/**
 * **恢复列表核对桶里真的有这条的文件** ——「点恢复报『桶里没有 <id> 的文件』」。一次 list（CommonPrefixes）就知道哪些会话还有文件；
 * 没有的返回 id → 删除时刻（有 delete marker 才知道，否则 0）。界面上不给勾、显示「备份文件已删除」+「从目录里移除」。
 * 列不出来就当都有，照旧列（不挡恢复）。
 */
async function listMissing(bucket: CatalogBucket, catalog: Catalog): Promise<Map<string, number>> {
  try { return await missingEntries(bucket, catalog, await bucket.sessionIds()); }
  catch (err: any) { logger.warn('s3', `恢复列表：核对桶里有没有文件没成功（照旧列出）：${err?.message || err}`); return new Map(); }
}

/**
 * **点恢复时桶里没有这条的文件** —— catalog 里有、文件没了（老版本删除时 catalog 没写对留下的）。
 * 说人话（什么时候删的，有 delete marker 才知道），并顺手把这条从 catalog 移掉（排队 + 只移确实没文件的），
 * 恢复页刷新之后就不再列它。
 */
async function backupGoneReply(creds: S3Creds, prefix: string | undefined, sessionId: string): Promise<{ ok: false; gone: true; error: string }> {
  const bucket = catalogBucket(creds, prefix);
  let at: number | 'live' | null = null;
  try { at = await bucket.deletedAt(sessionId); } catch { at = null; }
  try { await catalogQueue(() => forgetMissingEntries(bucket, prefix, [sessionId])); }
  catch (err: any) { logger.warn('s3', `恢复 ${sessionId}：桶里没文件，想从 catalog 移掉也没成功：${err?.message || err}`); }
  logger.warn('s3', `恢复 ${sessionId}：桶里已经没有它的文件（${typeof at === 'number' ? new Date(at).toISOString() : '删除时间不详'}），从 catalog 移除`);
  const when = typeof at === 'number' ? new Date(at).toLocaleString() : tr('time unknown');
  return { ok: false, gone: true, error: tr('This backup has already been deleted ({when}); the catalog had not been cleaned up. It has now been removed from the list.', { when }) };
}

/**
 * 删掉桶里若干条会话的备份（对象 + catalog 条目），并清掉本地"传过什么"的记录。
 * `s3:delete-project` 和 `s3:delete-sessions` 共用 —— 顺序和理由见下面每一步。
 */
async function deleteBackupsOf(
  creds: S3Creds, prefix: string | undefined, goneIds: Set<string>,
): Promise<{ deleted: number; failed: string[] }> {
  /*
    对象先删、catalog 最后写（写删除记录，重读最新的再条件写 —— 见 catalogStore.ts）：
    不再拿开头读到的快照整份写回，连点几次删除不会把前一次删掉的条目复活。
    调用方已经在 catalogQueue 里。
  */
  const { deleted, failed, at } = await deleteSessionBackups(catalogBucket(creds, prefix), prefix, goneIds);
  for (const id of goneIds) backupDeletedAt.set(id, at);
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

/**
 * **`mcp-combos.json` 和桶里那份对一下**（判据、校验、合并和"条件上传 + 冲突重试"都在 `mcpCombosSync.ts` 的 `syncComboFile`）——
 * 多台电脑共用同一份组合。文件很小，每轮整份拉下来按**内容摘要**判断谁变过；上传带 ETag 条件，
 * 下载之后别的电脑又传过 → 不覆盖，重新下载合并再试。
 * 拉 / 合并会改本机文件：改之前把本机那份挪进 trash，改完通知下拉刷新。出错：这一轮不传，摘要不更新。返回传了几个文件（0 / 1）。
 */
async function syncMcpCombosWithBucket(creds: S3Creds, prefix: string | undefined): Promise<number> {
  const rel = MCP_COMBOS_REL;
  const key = keyFor(prefix, rel);
  const abs = path.join(KIROLEX_HOME, rel);
  try {
    const r = await syncComboFile({
      get: async () => { const g = await getObjectWithEtag(creds, key); return g ? { text: g.body.toString('utf-8'), etag: g.etag } : null; },
      put: (text, cond) => putObjectIf(creds, key, Buffer.from(text, 'utf-8'), contentTypeFor(rel), cond),
      readLocal: () => { try { return fs.readFileSync(abs, 'utf-8'); } catch { return undefined; } },
      writeLocal: (text, plan) => {
        /* 被换掉的那份先挪进 trash —— 拉 / 合并都是改写，改写之前留一份 */
        if (fs.existsSync(abs)) {
          const bak = path.join(KIROLEX_HOME, 'trash', `mcp-combos-sync-${Date.now()}`, rel);
          fs.mkdirSync(path.dirname(bak), { recursive: true });
          fs.copyFileSync(abs, bak);
        }
        writeMcpCombosText(os.homedir(), text);
        mainWindow?.webContents.send('acp:mcp-combos-changed');
        logger.info('s3', `组合文件：${plan.action === 'pull' ? '从桶里拉回（别的电脑改的 / 本机第一次同步）' : `按合并结果改写（从桶里并进 ${plan.added.length} 个组合）`}`);
      },
      readMark: () => readComboMark(S3_COMBOS_MARK_PATH),
      writeMark: (m) => writeComboMark(S3_COMBOS_MARK_PATH, m),
    });
    for (const plan of r.plans) {
      if (plan.action === 'skip') logger.warn('s3', `组合文件这一轮不同步，两边都不动：${plan.error}`);
      if (plan.conflicts.length) {
        logger.warn('s3', `组合文件两边改了同一个组合（${plan.conflicts.map((c) => `${c.id} → 桶里那份留成 ${c.keptAs}`).join('、')}），两份都留着，没有覆盖`);
      }
    }
    if (r.plans.length > 1) logger.info('s3', `组合文件：上传时发现别的电脑刚传过，重新下载合并了 ${r.plans.length - 1} 次`);
    if (r.gaveUp) logger.warn('s3', '组合文件：连着几次上传前都被别的电脑抢先改了，这一轮不传（没有覆盖对方），下一轮再合并');
    return r.uploaded ? 1 : 0;
  } catch (err: any) {
    logger.warn('s3', `组合文件同步没成功（这一轮不传）：${err?.message || err}`);
    return 0;
  }
}

/**
 * **`~/.kirolex/agent-profiles/` 和桶里那份对一下**（判据在 `agentProfileSync.ts` 的 `syncProfileFiles`）——
 * 远程机器的 AI 工具配置跨电脑共用，和组合文件一样。两边都改过 → 不覆盖：桶里那份存成 `.conflicts/<时间>/…`。
 * 拉会改本机文件：改之前把本机那份挪进 trash。出错：这一轮不传。返回传了几个文件。
 */
async function syncAgentProfilesWithBucket(creds: S3Creds, prefix: string | undefined): Promise<number> {
  const root = path.join(KIROLEX_HOME, AGENT_PROFILES_REL);
  const keyOf = (rel: string) => keyFor(prefix, path.join(AGENT_PROFILES_REL, ...rel.split('/')));
  const absOf = (rel: string) => containedPath(root, path.join(...rel.split('/')));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    const r = await syncProfileFiles({
      listRemote: async () => {
        const out: string[] = [];
        for (const o of await listObjects(creds, `${keyFor(prefix, AGENT_PROFILES_REL)}/`)) {
          const rel = relFor(prefix, o.key);
          if (rel) out.push(path.relative(AGENT_PROFILES_REL, rel).split(path.sep).join('/'));
        }
        return out;
      },
      get: async (rel) => getObjectWithEtag(creds, keyOf(rel)),
      put: (rel, body, cond) => putObjectIf(creds, keyOf(rel), body, contentTypeFor(rel), cond),
      listLocal: () => listLocalProfileFiles(root),
      readLocal: (rel) => { const abs = absOf(rel); try { return abs ? fs.readFileSync(abs) : undefined; } catch { return undefined; } },
      writeLocal: (rel, body) => {
        const abs = absOf(rel);
        if (!abs) return;
        if (fs.existsSync(abs)) {
          const bak = path.join(KIROLEX_HOME, 'trash', `agent-profiles-sync-${Date.now()}`, ...rel.split('/'));
          fs.mkdirSync(path.dirname(bak), { recursive: true });
          fs.copyFileSync(abs, bak);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = `${abs}.kirolex-${process.pid}.tmp`;
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, abs);
      },
      writeConflictCopy: (rel, body) => {
        const abs = path.join(root, PROFILE_CONFLICTS_DIR, stamp, ...rel.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
        return abs;
      },
      readMarks: () => readProfileMarks(S3_PROFILES_MARK_PATH),
      writeMarks: (m) => writeProfileMarks(S3_PROFILES_MARK_PATH, m),
    });
    if (r.pulled.length) logger.info('s3', `AI 工具配置：从桶里拉回 ${r.pulled.join('、')}（别的电脑改的 / 本机第一次同步）`);
    if (r.uploaded.length) logger.info('s3', `AI 工具配置：传了 ${r.uploaded.join('、')}`);
    for (const c of r.conflicts) logger.warn('s3', `AI 工具配置 ${c.rel} 两边都改过，没有覆盖任何一边：本机这份留着，桶里那份存到 ${c.copy}`);
    if (r.raced.length) logger.warn('s3', `AI 工具配置 ${r.raced.join('、')} 同步途中有一边又变了（别的电脑抢先传了，或本机刚保存），这一轮没动它，下一轮再比`);
    if (r.pulled.length || r.conflicts.length) mainWindow?.webContents.send('agent-profile:changed');
    return r.uploaded.length;
  } catch (err: any) {
    logger.warn('s3', `AI 工具配置同步没成功（这一轮不传）：${err?.message || err}`);
    return 0;
  }
}

function walkDirs(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}

async function runS3Sync(reason: string): Promise<{ ok: boolean; uploaded: number; skipped: number; error?: string; cloudTrashed?: number; cloudPurged?: number }> {
  if (syncRunning) return { ok: false, uploaded: 0, skipped: 0, error: tr('The previous sync is still running') };
  if (reason === '定时' && Date.now() < syncNextAllowedAt) {
    logger.info('s3', `跳过这一次定时同步（连续失败 ${syncFailures} 次，退避到 ${new Date(syncNextAllowedAt).toLocaleTimeString()}）`);
    return { ok: false, uploaded: 0, skipped: 0, error: tr('Backing off') };
  }
  const { creds, problem } = syncCredsOrProblem();
  if (problem) return { ok: false, uploaded: 0, skipped: 0, error: problem };
  syncRunning = true;
  const cfg = loadSyncConfig();
  const state = readState(S3_STATE_PATH);
  const marks = readSessionMarks(S3_MARKS_PATH);
  /** 这一轮真的传了文件的那些会话 —— 只给它们更新"最后同步时间"。 */
  const touchedSessions = new Set<string>();
  /** 这一轮每条会话最后一个文件真的传上去的时刻 —— catalog 条目的 `uploadedAt`（和删除记录比谁新）。 */
  const uploadedAtBySession = new Map<string, number>();
  const syncStartedAt = Date.now();
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
    const syncable = allSessions.filter((r) => !projectExcluded(cfg, projectOf(r)) && !sessionExcluded(cfg, r.id));
    /*
      **删掉的云端备份不再被重新传上去**（判据见 catalogStore.deletedSessionPlan）—— 所有电脑一样：
      有删除记录、而会话的最后修改时间不晚于删除时刻 → 这一轮不传、不进 catalog（恢复页不显示）；
      删除之后又有了新改动 → 整条重传（先清掉它在状态表里的记录，桶里那份已经没了）。
    */
    /** 每条会话的对话最后一次变的时刻 —— 开头按它筛，写 catalog 时再按最新的删除记录核对一遍（writeSyncCatalog） */
    const changedAtById = new Map(syncable.map((r) => [r.id, sessionChangedAt(KIROLEX_HOME, r.id)]));
    const deletedPlan = deletedSessionPlan(syncable.map((r) => ({ id: r.id, changedAt: changedAtById.get(r.id) })), oldCatalog);
    dropSessionState(state, deletedPlan.reupload);
    const sessions = syncable.filter((r) => !deletedPlan.skip.has(r.id));
    if (deletedPlan.skip.size) logger.info('s3', `${deletedPlan.skip.size} 条会话的云端备份删掉之后没有新改动，不重新上传：${[...deletedPlan.skip].join('、')}`);
    if (deletedPlan.reupload.size) logger.info('s3', `${deletedPlan.reupload.size} 条会话的云端备份删掉之后又有了新改动，整条重新上传：${[...deletedPlan.reupload].join('、')}`);
    const excludedCount = allSessions.length - syncable.length;
    if (excludedCount) {
      logger.info('s3', `跳过 ${excludedCount} 条会话（项目设成了不同步：`
        + `${(cfg.excludeProjects || []).map((p) => p || '未分组').join('、') || '无'}；单独设成不同步的会话 ${(cfg.excludeSessions || []).length} 条）`);
    }
    const ids = sessions.map((r) => r.id);
    /*
      **记忆按同一个口径筛** ——「会话和 project 备份时把 project 和 session 的记忆也备份进去」。
      项目：本地所有有记忆的项目里，没被设成不同步的那些（一个项目底下暂时没有会话，它的记忆也该在）。
    */
    const memoryProjectDirs = walkDirs(path.join(KIROLEX_HOME, 'memory', 'projects'));
    /* advanced 专属的项目（flow 项目）的记忆：不传、也不从桶里拉回来写 —— 由 advanced 自己同步 */
    const advancedProjects = store.advancedOnlyProjectsAmong(memoryProjectDirs);
    const memoryProjects = memoryProjectDirs.filter((p) => !advancedProjects.has(p))
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
      if (parts[1] === 'projects') return !projectExcluded(cfg, parts[2]) && !store.isAdvancedOnlyProjectName(parts[2]);   // 别的机器建的项目也拉
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
    /* 组合文件（mcp-combos.json）：多台电脑共用一份，两边都改过时合并、不静默覆盖 */
    uploaded += await syncMcpCombosWithBucket(creds!, cfg.prefix);
    /* 远程机器的 AI 工具配置（agent-profiles/）：同样跨电脑共用，两边都改过时留冲突副本、不静默覆盖 */
    uploaded += await syncAgentProfilesWithBucket(creds!, cfg.prefix);
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
      /* 这一轮开始之后本机删掉了它的备份：剩下的文件不再传（传上去也是没人认的旧文件，见 deletedSessionPlan） */
      if (owner && (backupDeletedAt.get(owner) ?? 0) >= syncStartedAt) continue;
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
      if (sid) { touchedSessions.add(sid); uploadedAtBySession.set(sid, Date.now()); }
      /* 项目记忆也记一笔「什么时候真的传上去的」—— 备份/恢复界面的项目行要显示它 */
      const pm = /^memory[\\/]projects[\\/]([^\\/]+)[\\/]memory\.md$/.exec(rel);
      if (pm) touchedProjectMemory.set(pm[1], Math.floor(st.mtimeMs));
    }
    /*
      catalog 最后传：它是"有哪些备份可恢复"的唯一入口，先传会指向还没上传完的东西。
      **冲突的那几条不进 catalog** —— 它们传到了 conflicts/ 下，让 catalog 指向它们
      等于把"可恢复"这件事说错了。
    */
    /*
      **写之前重读最新的再合并**（排队 + 条件写，见 catalogStore.ts）：开头读到的 oldCatalog 只用来做冲突检测 /
      位置跟随，不再拿它整份写回 —— 那会把这一轮期间的删除、别的机器写的都盖掉。
      `uploadedAt`：这一轮真传了文件的用这一轮的时刻，没传的用本机上次真传它的时刻（marks）——
      这样删除记录之后没有重新上传的条目不会被这一轮复活。
    */
    const fresh = freshEntries.filter((e) => !conflictIds.has(e.id)).map((e) => {
      const at = entryUploadedAt(e.id, uploadedAtBySession, marks);
      return at ? { ...e, uploadedAt: at } : e;
    });
    /* 本机现存会话清单跟着同一次条件写一起写（云端自动清理的判据，见 cloudTrash.ts）—— 并进的是桶里现在那份 */
    const manifest = thisDeviceManifest(thisDeviceId(), thisMachine, Date.now());
    const wrote = await catalogQueue(() => writeSyncCatalog(catalogBucket(creds!, cfg.prefix), cfg.prefix, fresh, Date.now(),
      (c) => withDeviceManifest(c, manifest), changedAtById));
    if (wrote.blocked.length) {
      logger.info('s3', `${wrote.blocked.length} 条会话的云端备份在这一轮同步期间被删掉了、之后没有新改动，不写回目录：${wrote.blocked.join('、')}`);
    }
    for (const r of wrote.removed) {
      logger.warn('s3', `catalog 里「${r.title}」(${r.id}) 在桶里已经没有文件（${new Date(r.deletedAt).toLocaleString()} 删掉的），从目录里移除`);
    }
    if (wrote.attempts > 1) logger.info('s3', `catalog 写之前别处刚改过，重读合并了 ${wrote.attempts - 1} 次`);
    /*
      这一轮期间本机删掉的备份：开头读的状态表里还记着它们"传过了"，原样写回去就把删除那边清掉的记录盖回来了 ——
      之后有了新改动时就少传文件。去掉它们，和不交错时一样：删除之后没改动就不传（deletedSessionPlan），有改动就整条重传。
    */
    for (const [id, at] of backupDeletedAt) {
      if (at < syncStartedAt) continue;
      for (const rel of Object.keys(state)) if (sessionIdOfRel(rel) === id) delete state[rel];
      delete marks[id];
      touchedSessions.delete(id);
    }
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
        marks[id] = syncMark(now, byId.get(id)?.updatedAt || 0, uploadedAtBySession.get(id));
      }
      writeSessionMarks(S3_MARKS_PATH, marks);
    }
    /*
      **云端自动清理** —— 所有活跃设备上都没有了的会话移进云端回收站，到期的彻底删除（`cloudTrash.ts`）。
      放在 catalog 写完之后：判定要用到本机这一轮的清单。出错不算同步失败，只写日志。
    */
    const clean = cleanupSettings(cfg);
    let cleanup: CleanupResult | null = null;
    if (clean.enabled) {
      try {
        cleanup = await runCloudCleanup(bucketOps(creds!), {
          prefix: cfg.prefix, now: Date.now(), settings: clean, thisMachine, deviceId: thisDeviceId(),
          spare: (cand) => cloudCleanupSpare(creds!, cfg.prefix, cand),
          log: (level, msg) => logger[level]('s3', msg),
        });
        if (cleanup.blocked) logger.info('s3', `云端清理这一轮不移任何会话：${cleanup.blocked}`);
      } catch (err: any) {
        logger.warn('s3', `云端清理没跑成（不影响备份）：${err?.message || err}`);
      }
    }
    syncFailures = 0;
    syncNextAllowedAt = 0;
    lastSyncSummary = {
      at: Date.now(), uploaded, skipped: plan.skippedUnchanged, bytes,
      ...(conflictIds.size ? { conflicts: Array.from(conflictIds) } : null),
      ...(cleanup ? { cloudTrashed: cleanup.trashed.length, cloudPurged: cleanup.purged.length } : null),
    };
    logger.info('s3', `同步完成：传了 ${uploaded} 个文件 / ${(bytes / 1024).toFixed(0)} KB`
      + `${memoryPulled ? `，从桶里拉回 ${memoryPulled} 份记忆（别的机器更新的 / 本机第一次同步）` : ''}`
      + `${cleanup ? `；这次有 ${cleanup.trashed.length} 条移进云端回收站、${cleanup.purged.length} 条到期清空` : ''}`);
    mainWindow?.webContents.send('s3:sync-done', lastSyncSummary);
    return {
      ok: true, uploaded, skipped: plan.skippedUnchanged,
      ...(cleanup ? { cloudTrashed: cleanup.trashed.length, cloudPurged: cleanup.purged.length } : null),
    };
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
    /* 忙时普通 Enter 交给谁（按 initialize 的能力声明，`busyEnterCaps.ts`）—— 渲染端的路由和输入框文案按它走 */
    busyEnter: entry.client.busyEnter,
    /* Codex 的协作模式（default / plan）：输入框旁的「Plan」开关。Plan 模式下它才会用 request_user_input 向你提问（提问卡片） */
    plan: entry.client.selectOptions('collaboration_mode'),
  };
}

/**
 * **没选过权限模式时用哪个** ——「默认是 bypass 就好」。只给 Claude Code 定：它的适配器起来时报什么取决于
 * 那台机器的 settings（`permissions.defaultMode`），而 KiroLex 里 kiro 会话默认就是自动批准，两边该一致。
 * Codex 的那几档同时管着沙箱（read-only / workspace-write …），不替人选，用它自己的默认。
 */
const DEFAULT_ENGINE_MODE: Partial<Record<'claude' | 'codex', string>> = { claude: 'bypassPermissions' };

/** 这条会话记着的那几个值（模型 / effort / 模式），按"先模型后 effort"的顺序 —— 换模型可能会换掉 effort 的可选值。 */
function wantedEngineOptions(profile: AgentProfile, comboEffort?: string): Array<[EngineOptionCategory, string]> {
  const engine = engineOf(profile);
  if (engine === 'kiro') return [];
  const saved = profile.engineOptions?.[engine] || {};
  const out: Array<[EngineOptionCategory, string]> = [];
  const model = profile.engineModels?.[engine];
  if (model) out.push(['model', model]);
  /* 所选「组合」设了 effort 就用它；没设才沿用会话记住的（再没有就是引擎默认） */
  const effort = comboEffort || saved.thought_level;
  if (effort) out.push(['thought_level', effort]);
  const mode = saved.mode || DEFAULT_ENGINE_MODE[engine];
  if (mode) out.push(['mode', mode]);
  /* Codex 的 Plan 开关（没有这一项的引擎在 applyEngineModel 里自然跳过） */
  const collab = (saved as { collaboration_mode?: string }).collaboration_mode;
  if (collab) out.push(['collaboration_mode', collab]);
  return out;
}

/** 适配器接受了这条会话记住的模型：记成「上次成功用的」（`engineModelsUsed`），没变就不写盘 */
function rememberEngineModelUsed(sessionId: string, entry: SessionEntry, engine: 'claude' | 'codex', value: string): void {
  const next = withEngineModelUsed(entry.profile, engine, value);
  if (next === entry.profile) return;
  entry.profile = next;
  try {
    const rec = store.readRecord(sessionId);
    if (rec && engineOf(rec.profile) === engine) {
      rec.profile = { ...rec.profile, engineModelsUsed: entry.profile.engineModelsUsed };
      store.writeRecord(rec);
    }
  } catch (err) { logger.warn('engine-model', `记不住上次成功用的模型 sessionId=${sessionId}`, err); }
}

async function applyEngineModel(sessionId: string, entry: SessionEntry): Promise<void> {
  const engine = engineOf(entry.profile);
  if (engine === 'kiro') return;
  const combo = pickCombo(readMcpCombos(os.homedir()).combos, entry.profile.mcpCombo);
  for (const [cat, want] of wantedEngineOptions(entry.profile, combo.effort)) {
    const opts = entry.client.selectOptions(cat);
    /*
      组合要的 effort：设不上（不支持 / 适配器拒绝）就**主动退回默认档位**并说一句，不报错 ——
      重连加载的会话可能带着旧档位回来，光跳过等于沿用它（见 `applyComboEffort`）。
    */
    if (cat === 'thought_level' && combo.effort) {
      /* 当前模型根本不给 effort（实测 haiku）：不设、不在会话里报，界面在组合旁边说（审计 1b，`comboEffortNote`） */
      if (!modelOffersEffort(opts)) {
        logger.info('mcp-combo', `组合「${combo.name}」effort=${combo.effort}：当前模型不支持 effort，暂不生效 sessionId=${sessionId}`);
        continue;
      }
      const r = await applyComboEffort(combo.effort, combo.name, {
        options: () => entry.client.selectOptions('thought_level'),
        set: (v) => entry.client.setSelectOption(entry.cliSessionId, 'thought_level', v),
      });
      logger.info('mcp-combo', `组合「${combo.name}」effort -> ${r.value || '(未变)'} sessionId=${sessionId}`);
      if (r.notice) sessionNotice(sessionId, r.notice);
      continue;
    }
    /*
      **记住的模型这台机器的适配器没有** —— 原来静默跳过（审计 1b）。现在只在**本引擎清单**里兜底
      （上次成功用的 → 适配器的 default / 当前值，`pickEngineModel`），并照 kiro 那句说一句；绝不拿 kiro 的兜底链来填。
    */
    if (cat === 'model') {
      const pick = pickEngineModel(engine, want, entry.profile.engineModelsUsed?.[engine], opts);
      if (!pick) continue;
      try {
        if (opts!.current !== pick.value) await entry.client.setSelectOption(entry.cliSessionId, 'model', pick.value);
      } catch (err) {
        logger.warn('engine-model', `重设 ${ENGINE_LABEL[engine]} model=${pick.value} 失败 sessionId=${sessionId}`, err);
        continue;
      }
      if (pick.fallbackFrom) {
        logger.info('engine-model', `${ENGINE_LABEL[engine]} 清单里没有记住的 ${want}（清单：${opts!.options.map((o) => o.value).join(', ')}）-> ${pick.value} sessionId=${sessionId}`);
        modelFallback.note(sessionId, want, pick.value, trConcat(
          tr('⚠️ {engine} here has no model "{wanted}", so this session uses "{model}" instead.', { engine: ENGINE_LABEL[engine], wanted: want, model: pick.value }),
          NOTE_DETAIL_SEP,
          tr('{engine} can use here: {list}{more}', { engine: ENGINE_LABEL[engine], list: trList(opts!.options.slice(0, 8).map((o) => o.value)), more: opts!.options.length > 8 ? '…' : '' })));
        modelFallback.commit(sessionId);
      } else {
        modelFallback.wantedInUse(sessionId);   // 又用上你选的那个了：下次再换要重新说
      }
      /* 适配器接受了（或本来就是）这个 = 「上次成功用的」—— 兜底挑的也记，下次换到有它的机器先退回它；engineModels 里你选的不动 */
      rememberEngineModelUsed(sessionId, entry, engine, pick.value);
      continue;
    }
    if (!opts || opts.current === want || !opts.options.some((o) => o.value === want)) continue;
    try {
      await entry.client.setSelectOption(entry.cliSessionId, cat, want);
    } catch (err) {
      logger.warn('engine-model', `重设 ${ENGINE_LABEL[engine]} ${cat}=${want} 失败 sessionId=${sessionId}`, err);
    }
  }
  if (sessionClients.get(sessionId) === entry) mainWindow?.webContents.send('session:engine-models', engineModelsPayload(sessionId, entry));
}

/**
 * **被换下来的执行器** —— 换机器 / 换引擎 / 换组合 / 换 agent 时，旧的那个 client 在这里登记后再断开。
 *
 * 那几条路有的是「先 await 旧的 disconnect，再 set 新的」：旧进程 close → 'disconnected' 发生时 map 里还是
 * 旧 entry，身份守卫放行，于是删掉 entry、记录写成 detached、给渲染层发 acp:disconnected，远程会话还会对着
 * **旧那台机器**起断线恢复。迟到的 update 也会被当成这条会话的流式输出发出去。登记过的 client 的事件一律丢掉。
 */
const retiringClients = new WeakSet<AcpClient>();
async function retireExecutor(client: AcpClient): Promise<void> {
  retiringClients.add(client);
  await client.disconnect();
}

function wireSession(sessionId: string, entry: SessionEntry) {
  const { client } = entry;
  entry.engineOptionsReady = applyEngineModel(sessionId, entry).catch(() => { /* 恢复失败只记日志（applyEngineModel 里） */ });
  /** 这个 client 已经不是这条会话的执行器了（被换下来 / 已摘掉）：它的事件不再属于这条会话的任何一轮 */
  const superseded = () => retiringClients.has(client) || sessionClients.get(sessionId)?.client !== client;
  /*
    **远程会话：用户要的文件落在本机，远端只放缓存**（`remoteWriteGuard.ts`）。
    远端自带的写文件工具写到缓存以外 → 权限那一层拒掉（`AcpClient.remoteWriteGuard`）；
    漏过去的（不来问的模式）在下面 tool_call 那段事后认出来，给「复制到本机」。
    `entry.cwd` 每次现取：换模型 / 换机器之后它可能变。
  */
  const remoteHost = entry.profile.remote?.sshHost;
  if (remoteHost) {
    client.remoteWriteGuard = (toolCall) => remoteWriteVerdict(toolCall, { cwd: entry.cwd, home: remoteHomeDir(remoteHost) });
    client.on('remote-write-blocked', (d: { paths?: string[]; title?: string }) => {
      const paths = Array.isArray(d?.paths) ? d.paths : [];
      logger.info('permission', `remote write blocked sessionId=${sessionId} ${String(d?.title || '').slice(0, 80)} paths=${paths.join(',').slice(0, 200)}`);
      sessionNotice(sessionId, blockedWriteNotice(labelForHost(KIROLEX_CONFIG_PATH, remoteHost) || remoteHost, paths, sessionFilesDir(sessionId)));
    });
  }
  /** 一轮之外收到、已丢掉的回放块数（见下面 isReplayOutsideTurn）—— 只为每一段记一行日志 */
  let replayDropped = 0;
  /* 回放窗口从挂上执行器开始，到 KiroLex 发起的第一轮为止（`replayGuard.outsideTurnVerdict`） */
  entry.replayWindow = true;
  /* Claude Code / Codex 自己改了模型 / 模式（`config_option_update` / `current_mode_update`）：下拉跟着变 */
  client.on('config-options', () => {
    if (superseded()) return;
    mainWindow?.webContents.send('session:engine-models', engineModelsPayload(sessionId, entry));
  });
  /*
    **模型向用户提问**（`elicitation/create`，见 openQuestion）。被换下来的执行器、后台重建历史的那一轮里来的
    没人能看见 —— 直接回 cancel，别让它挂着。
  */
  client.on('elicitation', (d: { requestId: string | number; params: unknown }) => {
    if (superseded() || entry.priming) {
      client.respondToElicitation(d.requestId, elicitationResult('cancel'));
      return;
    }
    entry.lastStreamAt = Date.now();
    openQuestion(sessionId, entry, client, d.requestId, d.params);
  });
  /* 停止 / 断开（代理那边已经回过 cancel 或进程没了）/ 代理撤回：关卡片，不再回包。不看 superseded：被换下来时也要落盘 */
  client.on('elicitation-closed', (d: { requestId: string | number; reason: 'cancelled' | 'withdrawn' }) => {
    for (const [id, q] of openQuestions) {
      if (q.client === client && q.card.requestId === d.requestId) closeQuestion(id, d.reason === 'withdrawn' ? 'withdrawn' : 'cancelled');
    }
  });
  let onUpdate: (data: any, replayed?: boolean) => void;
  /*
    **属于排在后面那一轮的输出先攒着**（`followUpTurns.holdTarget`）：前一轮的响应到了以后、接手的那一轮清零计数之前流过来的，
    不能算进前一轮（会被它的 flush 写成它的回复），也不能在 busy 的空档里被当成一轮之外的回放丢掉。
    `replayed`：攒着的输出交给接手的那一轮（`entry.replayUpdates`），不再问一遍。
  */
  client.on('update', onUpdate = (data: any, replayed?: boolean) => {
    if (superseded()) return;
    if (!replayed) {
      const hold = holdTarget(entry, data, client.promptInFlight);
      if (hold) { hold.held.push(data); return; }
    }
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
    /* 编辑重发 fork 之后 session/load 回放的旧内容（含工具调用 —— 下面的 isReplayOutsideTurn 只认正文）：下一轮开始前都不要 */
    if (entry.dropReplayUntilTurn) {
      if (!entry.busy) return;
      entry.dropReplayUntilTurn = false;
    }
    /*
      适配器自己起的那一轮（detached）的结束信号（busyEnterCaps.detachedTurnEnded）—— 它没有 session/prompt 响应。
      只认这一轮自己有过动静（threadStatus active / 任何输出）之后的那个 idle：实测 Codex 先回 startedNewTurn、再发 active。
    */
    if (entry.detachedEnd) {
      if (detachedTurnEnded(data?.update)) { if (entry.detachedSeen) entry.detachedEnd(); }
      else entry.detachedSeen = true;
    }
    /*
      **一轮之外的对话正文是后端回放的旧对话，丢掉**（判据和理由见 `replayGuard.ts`）——
      「远程新建会话界面仍出现历史会话内容」。不丢的话它进了渲染层这条会话的缓存，切到它时就画出来。
      每一段只记一行：哪条会话、多少块、后端那边的会话 id（来源）。
      **例外：回放窗口之外的、Claude Code / Codex 自己起的一轮**（cron 到点 / 后台任务跟进，`outsideTurnVerdict`）——
      按正常的一轮走（`beginAutonomous`）：显示、进 assistantBuf、结束时落盘。
    */
    if (isReplayOutsideTurn(data?.update, !!entry.busy)) {
      const verdict = outsideTurnVerdict(data?.update, { inTurn: !!entry.busy || !!entry.autonomous, replayWindow: !!entry.replayWindow, engine: engineOf(entry.profile) });
      if (verdict === 'replay') {
        if (!replayDropped++) {
          const origin = typeof data?.sessionId === 'string' ? data.sessionId : '?';
          logger.warn('acp', `dropped replayed ${data?.update?.sessionUpdate} outside a turn sessionId=${sessionId} backend=${origin} (current backend=${entry.cliSessionId}) —— 不显示、不落盘`);
        }
        return;
      }
      if (verdict === 'autonomous') beginAutonomous(sessionId, entry);
    }
    if (replayDropped) {
      logger.info('acp', `replay outside a turn ended sessionId=${sessionId} dropped=${replayDropped}`);
      replayDropped = 0;
    }
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
        if (u?.content?.text) { entry.textThisTurn = true; noteTurnStarted(sessionId, entry); }
        if (!entry.assistantMsgId) entry.assistantMsgId = u?.messageId || `a_${Date.now()}`;
        /* 远程会话：它可能在这几行里要求"在用户机器上打开某个页面"—— 边流边认，别等到一轮结束
           （一轮可能还要跑几分钟，而"让我看看进度"的价值就在于**现在**看） */
        if (entry.profile.remote?.sshHost) runLocalActions(sessionId, entry, u?.content?.text || '');
      }
      /* 编辑重发的分叉锚点：主线助手消息（正文 / 思考）最后一个 messageId（只记 Claude Code / Codex） */
      { const mid = engineOf(entry.profile) !== 'kiro' ? mainlineAcpMessageId(u) : undefined; if (mid) entry.lastAcpMessageId = mid; }
      if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') {
        const toolCallId = u?.toolCallId || `tool_${Date.now()}`;
        /* Claude 自己定的 cron（CronCreate / CronDelete）：它只活在这个后端进程里，LRU 驱逐时要提示（`claudeCron.ts`） */
        entry.claudeCrons = noteClaudeCronTool(entry.claudeCrons, u);
        /* 只数新开的调用（不数 update）—— 这是"这一轮动过东西没有"的依据，见 `toolsThisTurn`。 */
        if (u?.sessionUpdate === 'tool_call') entry.toolsThisTurn = (entry.toolsThisTurn || 0) + 1;
        /* 跑了工具 = 模型已经开始做这一条了：同一个 messageId 不能再被自动发一遍（`noteTurnStarted`） */
        if (u?.sessionUpdate === 'tool_call') noteTurnStarted(sessionId, entry);
        /* 这之前的文字就算带着调用标记，后面也真调了工具 —— 判「写成文字没执行」只看这之后（见 textToolCall.ts） */
        if (u?.sessionUpdate === 'tool_call') entry.bufAtLastTool = entry.assistantBuf.length;
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
          title: u?.title || previous?.title || tr('Tool call'),
          status,
          kind: u?.kind || previous?.kind,
          locations: locations.length > 0 ? locations : previous?.locations,
          diffs: diffs.length > 0 ? diffs : previous?.diffs,
          content: output ? clampToolOutput(output) : previous?.content,
          /* Claude Code / Codex：工具名、入参摘要、父调用（子代理）、起止时间（`toolTrace.ts`）；kiro 的记录形状不变 */
          ...(engineOf(entry.profile) !== 'kiro'
            ? { ...mergeToolTrace(previous, toolTraceFields(u)), ...toolTimes(previous, status, Date.now()) }
            : {}),
        };
        /* 远程会话：这次写已经落在远端缓存以外（没经过权限闸）—— 说出来，给「复制到本机」。每个调用只说一次。 */
        if (remoteHost && status === 'completed') {
          const stray = strayRemoteDeliverables({ ...u, kind: next.kind, title: next.title, locations: next.locations, diffs: next.diffs, status },
            { cwd: entry.cwd, home: remoteHomeDir(remoteHost) });
          const said = (entry.strayRemoteNoticed ??= new Set<string>());
          if (stray.length && !said.has(toolCallId)) {
            said.add(toolCallId);
            logger.warn('tool', `deliverable written on remote sessionId=${sessionId} paths=${stray.join(',').slice(0, 200)}`);
            sessionNotice(sessionId, strayWriteNotice(labelForHost(KIROLEX_CONFIG_PATH, remoteHost) || remoteHost, stray), { copyRemote: stray });
          }
        }
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
        /* `browser` = local_browser 的操作记录（`noteBrowserAction`），进回合面板也要落盘 */
        /* Claude Code / Codex 每条都记：只读的调用要在对话里留痕、子代理的调用要能归到 Task 下（审计 3a / 12）。kiro 判据不变 */
        if (shouldRecordToolCall(engineOf(entry.profile), next)) {
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
        title: String(pending?.toolCall?.title || pending?.title || pending?.toolName || tr('Tool call awaiting approval')).slice(0, 120),
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
    /*
      Claude Code / Codex 的命令表走 ACP 标准的 `available_commands_update`：换成 kiro 那份表的形状
      （`acpAvailableCommands`），下面的缓存和渲染层的斜杠菜单就都认得 —— 原来没人接，打 `/` 什么都不弹。
    */
    if (engineOf(entry.profile) !== 'kiro' && data?.update?.sessionUpdate === 'available_commands_update') {
      data = { ...data, update: { sessionUpdate: '_kiro_internal', method: '_kiro.dev/commands/available', commands: acpAvailableCommands(data.update.availableCommands) } };
    }
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
    /* 后端自己起的那一轮：见到结束信号（带 cost 的 usage_update / Codex idle）就收尾落盘，否则重新计时（`autonomousTurn.ts`） */
    if (entry.autonomous) autonomousFrame(entry, data?.update, autonomousDeps(sessionId, entry));
    mainWindow?.webContents.send('acp:update', { ...data, sessionId, ...(childSessionId ? { childSessionId } : null) });
  });
  entry.replayUpdates = (list) => { for (const d of list) onUpdate(d, true); };
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
    if (superseded()) return;
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
    if (sessionClients.get(sessionId) !== entry || retiringClients.has(client)) return;
    sessionClients.delete(sessionId);
    const rec = store.readRecord(sessionId);
    if (rec) { rec.executorState = 'detached'; store.writeRecord(rec); }
    mainWindow?.webContents.send('acp:disconnected', { sessionId });
    /*
      **远程会话的执行器意外没了**（多半是连接断了）：交给 `remoteRecovery` 一直试到接上 ——
      渲染层那次自动重连只试一次，网络没回来就放弃了。主动 detach 的不走这里（上面那道身份守卫）。
    */
    if (entry.profile.remote?.sshHost && !isQuitting) startRemoteRecovery(sessionId);
  });
  /*
    执行器没了（意外断开，或者被换下来）：适配器自己起的那一轮（detached）没有响应会被拒，要在这里让它收场；
    还没轮到的那几条放弃（渲染端放回 KiroLex 队列）。排在上面那个之后：它的身份守卫只管会话记录，这里两种都要收。
  */
  client.on('disconnected', () => {
    if (entry.autonomous) endAutonomousTurn(entry, autonomousDeps(sessionId, entry), 'disconnected');
    for (const f of [...(entry.followUps || [])]) {
      if (f.started) f.failDetached?.(new Error(tr('Session not connected')));
      else f.abort(new Error(tr('Session not connected')));
    }
  });
}

/** Flush the accumulated assistant message to the durable transcript (called on
 *  turn completion). No-op if nothing accumulated. */
/*  `autonomous`：后端自己起的那一轮（`autonomousTurn.ts`）—— 带来源标记 `origin: 'autonomous'`。
 *  `entry`：执行器已经摘下来（断开时收尾）也要落到它身上攒的那份。 */
function flushAssistant(sessionId: string, opts?: { autonomous?: boolean; entry?: SessionEntry }) {
  const entry = opts?.entry ?? sessionClients.get(sessionId);
  /* 只管这一次 flush：先取出来清掉（下面提前 return 时也不能留给下一次的半截） */
  const completedFor = entry?.completedReplyTo;
  if (entry) entry.completedReplyTo = undefined;
  const replyTo = entry?.currentUserMessageId;
  // A wedge note alone is enough to persist: a turn cut before it produced
  // anything still owes the user an explanation for why it stopped.
  if (!entry || (!entry.assistantBuf && entry.fileChanges.length === 0 && !entry.wedgeNote)) {
    if (entry) entry.lastAcpMessageId = undefined;   // 这一轮没落盘的东西：锚点也别留给下一轮
    return;
  }
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
    /* 最后一次真实工具调用的位置：界面 / 历史判「写成文字没执行」只看这之后（和一轮结束时的判定同一个口径，见 textToolCall.ts） */
    ...(entry.bufAtLastTool ? { toolTailFrom: entry.bufAtLastTool } : {}),
    /* 回的是哪一条用户消息；只有正常收尾的那一份带 `replyComplete`（出错 / 取消 flush 的半截不算"答过了"，同一条还可以重试） */
    ...(replyTo ? { replyTo } : {}),
    ...(replyTo && completedFor === replyTo ? { replyComplete: true as const } : {}),
    /* 分叉锚点（编辑重发用，`editFork.ts`）：这一轮主线最后一个 ACP messageId + 当时的后端会话 */
    ...(entry.lastAcpMessageId ? { acpMessageId: entry.lastAcpMessageId, acpSessionId: entry.cliSessionId } : {}),
    /* 后端自己起的那一轮：来源标记（这一轮没有用户消息，`currentUserMessageId` 在 autonomousDeps 里摘掉了，上面两项不会有） */
    ...(opts?.autonomous ? { origin: 'autonomous' as const } : {}),
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
      /* 界面也要知道最后一次真实工具调用在正文的哪里（判「写成文字没执行」，和上面落盘的同一个值） */
      ...(entry.bufAtLastTool ? { toolTailFrom: entry.bufAtLastTool } : {}),
      /* 去重标记也给界面一份：之后整份重写 transcript（编辑后重跑）时它原样写回去（主进程那边也会按盘上的补） */
      ...(replyTo ? { replyTo } : {}),
      ...(replyTo && completedFor === replyTo ? { replyComplete: true as const } : {}),
    });
  }
  entry.assistantBuf = '';
  entry.assistantMsgId = null;
  entry.lastAcpMessageId = undefined;
  entry.fileChanges = [];
  entry.wedgeNote = undefined;
}

/* ───────────── 模型向用户提问（ACP elicitation，见 elicitation.ts） ─────────────
 *
 * 主进程是卡片的权威：收到 `elicitation/create` 建卡片、推给界面（`acp:update` 的 `question`），
 * 答了 / 跳过 / 停止 / 断开 / 超时 / 代理撤回都在 `closeQuestion` 收口：回包（只回一次）、落盘、再推一次。
 * 界面只按卡片 id 覆盖显示，不自己改状态。 */

function pushQuestion(card: QuestionCard) {
  mainWindow?.webContents.send('acp:update', { sessionId: card.sessionId, update: { sessionUpdate: 'question', card } });
}

function openQuestion(sessionId: string, entry: SessionEntry, client: AcpClient, requestId: string | number, params: unknown) {
  const now = Date.now();
  const card = newQuestionCard({
    id: `q_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId, requestId, params, now, engine: engineOf(entry.profile),
  });
  /* 超时兜底：没人回答就按 cancel 回给代理，卡片上写明是超时 —— 这一轮不能一直挂着 */
  const timer = setTimeout(() => closeQuestion(card.id, 'timeout', { action: 'cancel' }), Math.max(0, card.expiresAt - now));
  openQuestions.set(card.id, { card, client, timer });
  logger.info('question', `asked sessionId=${sessionId} id=${card.id} engine=${card.engine} fields=${card.fields.length} timeout=${Math.round((card.expiresAt - now) / 1000)}s`);
  pushQuestion(card);
}

/** 关一张挂着的卡片。`respond` 不传 = 代理那边已经不等了（撤回 / 进程没了），不再回包。 */
function closeQuestion(
  cardId: string,
  status: Exclude<QuestionStatus, 'pending'>,
  respond?: { action: 'accept'; content: Record<string, QuestionValue> } | { action: 'decline' } | { action: 'cancel' },
  content?: Record<string, QuestionValue>,
  cancelledBy?: 'switch',
): QuestionCard | null {
  const open = openQuestions.get(cardId);
  if (!open) return null;
  openQuestions.delete(cardId);
  clearTimeout(open.timer);
  if (respond) open.client.respondToElicitation(open.card.requestId, respond);
  const card = closeQuestionCard(open.card, status, Date.now(), content, cancelledBy);
  /* 关掉的卡片才完整：这时落盘（重启后看得到「问了什么、选了什么」）。会话已经删了就不写（别把目录建回来）。 */
  try {
    if (store.readRecord(card.sessionId)) {
      store.appendMessage(card.sessionId, { id: card.id, role: 'assistant', content: '', ts: card.askedAt, question: card });
    }
  } catch (err: any) {
    logger.warn('question', `persist failed sessionId=${card.sessionId} id=${card.id}: ${err?.message || err}`);
  }
  logger.info('question', `closed sessionId=${card.sessionId} id=${card.id} status=${status} waited=${(((card.closedAt || Date.now()) - card.askedAt) / 1000).toFixed(1)}s`);
  pushQuestion(card);
  return card;
}

/** 用户（界面或控制入口）回答 / 跳过一张卡片。 */
function answerQuestion(sessionId: string, cardId: string, action: 'accept' | 'decline', values?: Record<string, unknown>):
  { ok: true; card: QuestionCard } | { ok: false; error: 'not-pending' | 'invalid'; missing?: string[]; invalid?: string[] } {
  const open = openQuestions.get(cardId);
  if (!open || open.card.sessionId !== sessionId) return { ok: false, error: 'not-pending' };
  if (action === 'decline') {
    const card = closeQuestion(cardId, 'declined', elicitationResult('decline'));
    return card ? { ok: true, card } : { ok: false, error: 'not-pending' };
  }
  const check = buildAcceptContent(open.card.fields, values || {});
  if (!check.ok) return { ok: false, error: 'invalid', missing: check.missing, invalid: check.invalid };
  const card = closeQuestion(cardId, 'answered', elicitationResult('accept', check.content), check.content);
  return card ? { ok: true, card } : { ok: false, error: 'not-pending' };
}

/** 你切走了这条会话（界面上看不到它了）：它挂着的提问一律回 cancel、关卡片、落盘 —— 不让旧执行器一直等到你回来或超时。 */
function cancelQuestionsFor(sessionId: string): number {
  let n = 0;
  for (const card of pendingQuestionsFor(sessionId)) {
    if (closeQuestion(card.id, 'cancelled', elicitationResult('cancel'), undefined, 'switch')) n++;
  }
  return n;
}

function pendingQuestionsFor(sessionId?: string): QuestionCard[] {
  return [...openQuestions.values()].map((q) => q.card).filter((c) => !sessionId || c.sessionId === sessionId);
}

/**
 * **后端自己起的那一轮**（判据 `replayGuard.outsideTurnVerdict`，生命周期 `autonomousTurn.ts`）——
 * 「Claude Code 自发的一轮（CronCreate 到点 / 后台任务跟进）被当回放丢掉」。
 *
 * 开始：会话里落一条来源标记（KiroLex 提示「⏰ 后台触发」—— 不是伪造的用户消息，也不发给模型），`acp:main-turn` 让界面像接管
 * 定时提示那一轮一样接管它的流，busy 报 turn（`busyReasonFor`）。输出照常进 assistantBuf / 渲染层。
 * 这一轮没有用户消息：`currentUserMessageId` 先摘掉（回复不带 replyTo、工具事件不记在上一轮名下），收尾时还回去。
 * 结束：`flushAssistant(…, { autonomous: true })` 落盘一条带 `origin: 'autonomous'` 的助手消息，busy 不再报 turn（界面收流）。
 */
const autonomousPrevUser = new WeakMap<SessionEntry, string | undefined>();
function beginAutonomous(sessionId: string, entry: SessionEntry): void {
  if (entry.autonomous) return;
  beginAutonomousTurn(entry, autonomousDeps(sessionId, entry));
}
function autonomousDeps(sessionId: string, entry: SessionEntry): AutonomousDeps {
  return {
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    hasOpenTools: () => (entry.openToolCalls?.size || 0) > 0,
    announce: (turn) => {
      logger.info('acp', `autonomous turn BEGIN sessionId=${sessionId} backend=${entry.cliSessionId} —— 后端自己起了一轮（cron 到点 / 后台任务跟进），按正常的一轮显示、落盘`);
      autonomousPrevUser.set(entry, entry.currentUserMessageId);
      entry.currentUserMessageId = undefined;
      if (!entry.assistantBuf) { entry.assistantMsgId = null; entry.bufAtLastTool = 0; }
      const text = tr('⏰ Background trigger: {engine} started this turn on its own (a scheduled task it set itself, or a background-task follow-up)', { engine: ENGINE_LABEL[engineOf(entry.profile)] });
      const v = textVariants(text);
      const ts = Date.now();
      /* 会话已经删了就不写（appendMessage 会先建目录，删掉的会话会重新长出来） */
      if (!deletedSessionIds.has(sessionId) && store.readRecord(sessionId)) {
        try {
          store.appendMessage(sessionId, { id: turn.noteId, role: 'user', content: text, ts, kirolex: true, ...(v ? { variants: v } : {}) });
        } catch (err: any) { logger.warn('acp', `autonomous note not saved sessionId=${sessionId}: ${err?.message || err}`); }
      }
      mainWindow?.webContents.send('acp:main-turn', { sessionId, messageId: turn.noteId, content: text, ts, kirolex: true });
      emitSessionBusy(sessionId);
    },
    finish: (turn, why) => {
      flushAssistant(sessionId, { autonomous: true, entry });
      if (entry.currentUserMessageId === undefined) entry.currentUserMessageId = autonomousPrevUser.get(entry);
      autonomousPrevUser.delete(entry);
      logger.info('acp', `autonomous turn END sessionId=${sessionId} why=${why} after=${((Date.now() - turn.startedAt) / 1000).toFixed(1)}s`);
      emitSessionBusy(sessionId);
      /* 这一轮期间换了项目 / 归档（`acp:move-session` 推迟的执行器重置）：回复已经落盘，现在断开 */
      /* 只对还挂着的这个执行器做（断开时收尾的话，这个会话可能已经挂上了新的执行器，别把新的断掉） */
      if (sessionClients.get(sessionId) === entry) consumePendingProjectReset(sessionId, '后端自己起的一轮结束，执行下推的执行器重置');
      /* 这一轮期间记下的切换（模型 / agent / 运行位置…）现在应用 —— 回复已经完整落盘 */
      void pendingSwitchRunner.kick(sessionId);
    },
  };
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
      if (id === excludeId || e.busy || e.autonomous) continue;
      const candidate = { cost: evictionCost(id), used: e.lastUsedAt ?? 0 };
      if (!best || candidate.cost < best.cost || (candidate.cost === best.cost && candidate.used < best.used)) {
        best = candidate;
        victim = id;
      }
    }
    if (!victim) return false; // all remaining executors are busy — cannot evict
    // 记下代价:一条对话「为什么突然要重建」必须查得出来
    logger.info('executor', `evicting ${victim} for ${excludeId || 'a new session'} (cost=${best?.cost}, idle since ${best?.used})`);
    /* Claude 自己定的 cron 只活在这个后端进程里（`claudeCron.ts`）：回收了就没了 —— 在那条会话里说一句，不阻止回收 */
    if (hasPendingClaudeCron(sessionClients.get(victim)?.claudeCrons)) {
      logger.info('executor', `evicting ${victim} with pending Claude cron(s) —— 随后端一起消失`);
      noteInSession(victim, tr("⚠️ This chat's backend was recycled to make room for another chat. Scheduled tasks Claude set up itself in this chat (CronCreate) went away with it. For timers that must survive, have it use KiroLex's schedule_create."));
    }
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
  refreshTrayMenu();

  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

/** 托盘菜单按当前界面语言建；切换语言时重建一次。 */
function refreshTrayMenu(): void {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: tr('Show KiroLex'),
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: tr('Quit'),
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

/** 启动窗口是一段内联 HTML：插进去的文案先转义。 */
function escapeSplashHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
        <div id="splash-status" style="font-size:12px; color:#a0a0a0; margin-bottom:12px;">${escapeSplashHtml(tr('Starting…'))}</div>
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
  try { syncUiLangFromSettings(); } catch {}
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
      /* advanced 的会话（flow / skill）在里面跳过：不删、不压住，墓碑留给 advanced 自己 */
      const { suppress, keep: stillThere, skippedAdvanced } = store.retryPendingDeletions(pending);
      for (const id of suppress) deletedSessionIds.add(id);
      saveSessionTombstones(stillThere);
      logger.info('delete-session', `retried ${pending.length} pending deletion(s); ${stillThere.length - skippedAdvanced.length} still locked`
        + `${skippedAdvanced.length ? `; skipped ${skippedAdvanced.length} KiroLex Advanced session(s)` : ''}`);
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
        if (store.isAdvancedOnlySession(id)) continue;   // advanced 的会话目录不碰
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
      /* advanced 的会话（flow / skill）不在 listSessions() 里，但它们引用的粘贴也是活的 —— 只读，一起算上 */
      const advanced = [...store.listAdvancedOnlyIds()].map((id) => ({ id }));
      for (const rec of [...store.listSessions(), ...advanced]) {
        for (const m of store.readTranscript(rec.id, { raw: true }) as any[]) {
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
      /* 云端自动清理（cloudTrash.ts）：开关默认开、活跃设备 90 天、回收站保留 30 天 */
      autoCleanCloud: cleanupSettings(cfg).enabled,
      activeDeviceDays: cleanupSettings(cfg).activeDays,
      cloudTrashDays: cleanupSettings(cfg).trashDays,
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
    /* 云端自动清理的三项，同样"键在 input 里才动它"；天数按 cleanupSettings 的规矩收（1–3650，乱填回默认） */
    if (input?.autoCleanCloud !== undefined) next.autoCleanCloud = !!input.autoCleanCloud;
    if (input?.activeDeviceDays !== undefined) next.activeDeviceDays = cleanupSettings({ activeDeviceDays: input.activeDeviceDays }).activeDays;
    if (input?.cloudTrashDays !== undefined) next.cloudTrashDays = cleanupSettings({ cloudTrashDays: input.cloudTrashDays }).trashDays;
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
      if (back.toString('utf-8') !== stamp) return { ok: false, error: tr('What was read back doesn\'t match what was written. The bucket may have a policy that rewrites content.') };
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
        leftover = tr(' (the test object could not be deleted: {error}. {key} was left in the bucket; this key may lack s3:DeleteObject)', { error: String(delErr?.message || delErr), key });
      }
      return { ok: true, message: tr('Read and write OK ({bucket} / {region}){leftover}', { bucket: String(cfg.bucket), region: String(cfg.region), leftover }) };
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
        /* 本机归档的 —— 同步页把它放进「已归档」组（同步与否仍按它这个项目 / 它自己的设置） */
        archived: !!rec.archived,
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
      /* 先按删除记录收拾一遍（删掉的不列），再核对桶里真有文件（见 listMissing） */
      const bucket = catalogBucket(creds!, cfg.prefix);
      const catalog = await readCatalog(catalogIO(bucket, cfg.prefix));
      if (!catalog) return { entries: [], error: tr('There are no backups in this bucket yet (sync once first).') };
      const missing = await listMissing(bucket, catalog);
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
        for (const p of store.advancedOnlyProjectsAmong(Object.keys(memoryByProject))) delete memoryByProject[p];
      } catch { /* 列不出来就不显示，不挡恢复 */ }
      const recById = new Map(localRecs.map((r) => [r.id, r]));
      const hidden = await advancedBackupIds(creds!, cfg.prefix, catalog, local);   // advanced 的会话不进恢复页
      return {
        memoryByProject,
        /* 分组 / 归档按 catalog 自己的（恢复页显示的是云上那份），本机归档了没有不管 */
        entries: markMissing((catalog.entries || []).filter((e) => !hidden.has(e.id)), missing).map((e) => ({
          ...e,
          project: catalogProject(e, projectById.get(e.id)),
          existsLocally: local.has(e.id),
          /* 新旧对比用（本机较新 / 云上较新 / 两边一样） */
          localUpdatedAt: recById.get(e.id)?.updatedAt || 0,
          /* 恢复后位置会不会按云上的改（谁后挪用谁，见 `s3:restore`）—— 确认框里要说出来 */
          placementWillChange: !!restorePlacement(recById.get(e.id), e, store.isAdvancedOnlyProjectName)?.changed,
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
    if (typeof project !== 'string') return { ok: false, error: tr('Invalid project name.') };
    if (confirm !== project) return { ok: false, error: tr('Not confirmed: the project to delete must be passed back exactly.') };
    { const advRefused = refuseAdvancedProject(project, 's3:delete-project'); if (advRefused) return { ok: false, error: advRefused }; }
    const cfg = loadSyncConfig();
    /* 整个删除排进 catalog 队列：catalog 在队列里现读，不拿排队之前的快照 */
    return catalogQueue(async () => { try {
      /*
        **桶里有哪些会话属于这个项目**：catalog 是权威的（它记的是"备份时属于哪个项目"）。
        本地记录只用来补 catalog 里缺 project 的老条目 —— 和恢复列表同一条规则。
      */
      let catalog: Catalog | null;
      try { catalog = await readCatalog(catalogIO(catalogBucket(creds!, cfg.prefix), cfg.prefix)); }
      catch (err: any) { if (err instanceof S3Error) throw err; return { ok: false, error: tr('The catalog could not be read.') }; }
      if (!catalog) return { ok: false, error: tr('The bucket has no catalog yet (never synced).') };
      const projectById = new Map(store.listSessions().map((r) => [r.id, projectOf(r)]));
      /* 本机藏起来的 advanced 会话（flow / skill）不算这个项目的、不删 —— 它们由 advanced 自己同步 */
      const hidden = store.listAdvancedOnlyIds();
      const candidates = (catalog.entries || []).filter((e) => !hidden.has(e.id) && (e.project || projectById.get(e.id) || '') === project);
      /* 本机没有的：看桶里的 record.json —— advanced 的、读不出来的都不删 */
      const cloud = await cloudAdvancedBackups(creds!, cfg.prefix, candidates.map((e) => e.id).filter((id) => !projectById.has(id)));
      const mine = candidates.filter((e) => !cloud.advanced.has(e.id) && !cloud.unreadable.has(e.id));
      if (!mine.length) return { ok: false, error: tr('The bucket has no backups belonging to "{project}".', { project: project || tr('Unassigned') }) };

      const { deleted, failed } = await deleteBackupsOf(creds!, cfg.prefix, new Set(mine.map((e) => e.id)));
      logger.warn('s3', `删掉了「${project || '未分组'}」在桶里的备份：${mine.length} 条会话 / ${deleted} 个对象`
        + `${failed.length ? `，${failed.length} 个没删掉` : ''}（本地一个字都没动）`);
      return { ok: true, sessions: mine.length, deleted, failed };
    } catch (err: any) {
      const hint = err instanceof S3Error ? err.hint : '';
      return { ok: false, error: `${err?.message || err}${hint ? `\n${hint}` : ''}` };
    } });
  });

  /**
   * **删掉某几条会话在桶里的备份** ——「远程会话恢复中需要有一个删除按钮，现在这里面有好多
   * New Chat 之类没用的会话」。
   *
   * 那些没用的大多是**本地早就删了、桶里还留着**的：同步只往上传，从不删桶里的东西，
   * 所以本地删过的会话会一直挂在恢复列表里。
   *
   * 只删备份，本地一个字不动。本地还在的那几条，删除之后有了新改动才会再传上去（所有电脑一样，见 catalogStore.deletedSessionPlan）——
   * 那是诚实的结果：要它彻底消失，得在侧栏把本地那条也删掉。界面上会把这几条单独说出来。
   */
  /**
   * **以本机为准** —— 删掉桶里这几条会话的全部对象（含 conflicts/），把本机这份整条传上去
   * （见 `keepLocalSession`）。「先删掉 windows 那里上传的版本重新弄 mac 版上去」。
   */
  ipcMain.handle('s3:keep-local', async (_event, ids: string[]) => {
    const { creds, problem } = syncCredsOrProblem();
    if (problem) return { ok: false, error: problem };
    const want = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && /^[\w.-]+$/.test(id) && store.readRecord(id)
      && !refuseAdvancedOnly(id, 's3:keep-local'));   // advanced 的会话由 advanced 自己同步
    if (!want.length) return { ok: false, error: tr('No sessions selected, or none of them exist on this machine.') };
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
    if (!want.length) return { ok: false, error: tr('No sessions selected.') };
    const cfg = loadSyncConfig();
    /*
      整个删除排进 catalog 队列，catalog 在队列里现读 ——「连点 8 次删除」时后一次不再拿着前一次之前的快照，
      写回时把前一次刚删的复活（见 catalogStore.ts）。
    */
    return catalogQueue(async () => { try {
      let catalog: Catalog | null;
      try { catalog = await readCatalog(catalogIO(catalogBucket(creds!, cfg.prefix), cfg.prefix)); }
      catch (err: any) { if (err instanceof S3Error) throw err; return { ok: false, error: tr('The catalog could not be read.') }; }
      if (!catalog) return { ok: false, error: tr('The bucket has no catalog yet (never synced).') };
      const inBucket = new Set((catalog.entries || []).map((e) => e.id));
      /* 本机藏起来的 advanced 会话（flow / skill）：恢复页不列它们，这里也绝不删它们在桶里的备份 */
      const hidden = store.listAdvancedOnlyIds();
      const local = new Set(store.listSessions().map((r) => r.id));
      /* 本机没有的：看桶里的 record.json —— advanced 的、读不出来的都不删 */
      const cloud = await cloudAdvancedBackups(creds!, cfg.prefix, want.filter((id) => inBucket.has(id) && !local.has(id) && !hidden.has(id)));
      const gone = new Set(want.filter((id) => inBucket.has(id) && !hidden.has(id) && !cloud.advanced.has(id) && !cloud.unreadable.has(id)));
      if (!gone.size) return { ok: false, error: tr('None of the selected sessions are in the bucket any more.') };
      const willReturn = [...gone].filter((id) => local.has(id));
      const { deleted, failed } = await deleteBackupsOf(creds!, cfg.prefix, gone);
      logger.warn('s3', `删掉了 ${gone.size} 条会话的备份 / ${deleted} 个对象`
        + `${failed.length ? `，${failed.length} 个没删掉` : ''}（本地没动；其中 ${willReturn.length} 条本地还在，之后有新改动才会重传）`);
      return { ok: true, sessions: gone.size, deleted, failed, willReturn };
    } catch (err: any) {
      const hint = err instanceof S3Error ? err.hint : '';
      return { ok: false, error: `${err?.message || err}${hint ? `\n${hint}` : ''}` };
    } });
  });

  /**
   * **从目录里移除** —— 恢复页里「备份文件已删除」那几条的按钮：catalog 里有、桶里已经没有文件的条目
   * （老版本删除时 catalog 写回出了并发问题留下的）。只移确实没文件的；还有文件的不动（见 `forgetMissingEntries`）。
   */
  ipcMain.handle('s3:forget-backups', async (_event, ids: string[]) => {
    const { creds, problem } = syncCredsOrProblem();
    if (problem) return { ok: false, error: problem };
    const want = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && /^[\w.-]+$/.test(id));
    if (!want.length) return { ok: false, error: tr('No sessions selected.') };
    const cfg = loadSyncConfig();
    return catalogQueue(async () => { try {
      const r = await forgetMissingEntries(catalogBucket(creds!, cfg.prefix), cfg.prefix, want);
      if (r.removed.length) logger.info('s3', `从 catalog 移除了 ${r.removed.length} 条已经没有备份文件的条目：${r.removed.join('、')}`);
      return { ok: true, ...r };
    } catch (err: any) {
      const hint = err instanceof S3Error ? err.hint : '';
      return { ok: false, error: `${err?.message || err}${hint ? `\n${hint}` : ''}` };
    } });
  });

  /**
   * **参与云端清理判定的设备 / 已忽略的设备** —— 设置页列出来（catalog 里每台机器的清单，见 cloudTrash.ts）。
   */
  ipcMain.handle('s3:cloud-devices', async () => {
    const { creds, problem } = syncCredsOrProblem();
    if (problem) return { devices: [], unknown: [], error: problem };
    const cfg = loadSyncConfig();
    try {
      const raw = await getObjectIfExists(creds!, catalogKey(cfg.prefix));
      const catalog = raw ? JSON.parse(raw.toString('utf-8')) as Catalog : null;
      const r = describeDevices(catalog, Date.now(), cleanupSettings(cfg).activeDays);
      return { ...r, thisDevice: thisDeviceId() };
    } catch (err: any) {
      const hint = err instanceof S3Error ? err.hint : '';
      return { devices: [], unknown: [], error: `${err?.message || err}${hint ? `
${hint}` : ''}` };
    }
  });

  /** 云端回收站里有什么、进回收站的时间、还剩几天。 */
  ipcMain.handle('s3:list-cloud-trash', async () => {
    const { creds, problem } = syncCredsOrProblem();
    if (problem) return { items: [], error: problem };
    const cfg = loadSyncConfig();
    const clean = cleanupSettings(cfg);
    try {
      const items = await listCloudTrash(bucketOps(creds!), cfg.prefix, Date.now(), clean.trashDays);
      return { items: items.map(({ keys: _keys, meta: _meta, ...x }) => x), trashDays: clean.trashDays, enabled: clean.enabled };
    } catch (err: any) {
      const hint = err instanceof S3Error ? err.hint : '';
      return { items: [], error: `${err?.message || err}${hint ? `
${hint}` : ''}` };
    }
  });

  /** 云端回收站 → 恢复到云端备份（移回原位置）。只动桶里的东西，本地不动。 */
  ipcMain.handle('s3:restore-cloud-trash', async (_event, dir: string) => {
    const { creds, problem } = syncCredsOrProblem();
    if (problem) return { ok: false, error: problem };
    if (typeof dir !== 'string' || !dir) return { ok: false, error: tr('Invalid session id.') };
    const cfg = loadSyncConfig();
    try {
      const r = await restoreFromCloudTrash(bucketOps(creds!), cfg.prefix, dir, Date.now(), (level, msg) => logger[level]('s3', msg));
      return { ok: true, ...r };
    } catch (err: any) {
      const hint = err instanceof S3Error ? err.hint : '';
      return { ok: false, error: `${err?.message || err}${hint ? `
${hint}` : ''}` };
    }
  });

  /** 云端回收站 → 立即彻底删除。界面确认过一次，这一层再要求把目录名原样传回来（同 s3:delete-project）。 */
  ipcMain.handle('s3:purge-cloud-trash', async (_event, dir: string, confirm?: string) => {
    const { creds, problem } = syncCredsOrProblem();
    if (problem) return { ok: false, error: problem };
    if (typeof dir !== 'string' || !dir || confirm !== dir) return { ok: false, error: tr('Not confirmed.') };
    const cfg = loadSyncConfig();
    try {
      const r = await purgeCloudTrashItem(bucketOps(creds!), cfg.prefix, dir, (level, msg) => logger[level]('s3', msg));
      return { ok: true, ...r };
    } catch (err: any) {
      const hint = err instanceof S3Error ? err.hint : '';
      return { ok: false, error: `${err?.message || err}${hint ? `
${hint}` : ''}` };
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
    if (!sessionId || !/^[\w.-]+$/.test(sessionId)) return { ok: false, error: tr('Invalid session id.') };
    { const r = refuseAdvancedOnly(sessionId, 's3:restore'); if (r) return { ok: false, error: r }; }
    /*
      **连着的先断开，不再让人手动去断** —— 恢复现在是合并（同 id 去重、按时间排），
      断开之后执行器手上那份不会再写盘，合并完下次打开按记录重新接上。
      只有**正在跑一轮**的才拒：那一轮的产出还没落盘，这时候断开会把它弄丢。
    */
    const live = sessionClients.get(sessionId);
    if (live?.busy) {
      return { ok: false, error: tr('This session is in the middle of a turn. Wait for it to finish before restoring, or the unsaved part of this turn will be lost.') };
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
      if (!objects.length) return backupGoneReply(creds!, cfg.prefix, sessionId);
      const vetted = await refuseAdvancedBackup(creds!, prefix, objects, sessionId); if ('refused' in vetted) return { ok: false, error: vetted.refused };

      const localDir = path.join(KIROLEX_HOME, 'sessions', sessionId);
      const existed = fs.existsSync(localDir);
      /* 合并**之前**本机这条的位置（项目 / 归档）—— 合并完按「谁后挪用谁」定恢复后放在哪儿 */
      const localBefore = existed ? store.readRecord(sessionId) : null;
      /* catalog 里这条（它的 placementChangedAt 是判据）。读不到就当没有 → 保持本机的位置 */
      let catalogEntry: CatalogEntry | undefined;
      if (localBefore) {
        try {
          const raw = await getObjectIfExists(creds!, catalogKey(cfg.prefix));
          if (raw) catalogEntry = ((JSON.parse(raw.toString('utf-8')) as Catalog).entries || []).find((e) => e.id === sessionId);
        } catch (err: any) {
          logger.warn('s3', `恢复 ${sessionId}：读不到 catalog（${err?.message || err}），位置保持本机的`);
        }
      }
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
        const body = await vetted.get(obj.key);
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
        /* 会话记录一律走 sessionStore 写（写盘那道关：不进 advanced 专属项目），不在这里直接写文件 */
        const isRecord = abs === path.join(localDir, 'record.json');
        if (existed && base === 'record.json') {
          let mine: any;
          try { mine = JSON.parse(fs.readFileSync(abs, 'utf-8')); } catch { mine = undefined; }
          let theirs: any;
          try { theirs = JSON.parse(body.toString('utf-8')); } catch { theirs = undefined; }
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          if (isRecord) store.writeRecordKeepUpdatedAt({ ...mergeRecords(mine, theirs), id: sessionId });
          else fs.writeFileSync(abs, JSON.stringify(mergeRecords(mine, theirs), null, 2));
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
        let rec: any;
        if (isRecord) { try { rec = JSON.parse(body.toString('utf-8')); } catch { rec = undefined; } }
        if (rec && typeof rec === 'object') store.writeRecordKeepUpdatedAt({ ...rec, id: sessionId });
        else fs.writeFileSync(abs, body);   // 读不出来的记录带不了项目（vetBackupRecord 也已拒掉这种备份）
        restored += 1;
      }
      /* 合并之后重建 history.md —— 它是渲染产物，不是数据 */
      if (merged) refreshHistoryFile(sessionId);

      const recordPath = path.join(localDir, 'record.json');
      let recAfter: any;
      try { recAfter = JSON.parse(fs.readFileSync(recordPath, 'utf-8')); } catch { recAfter = undefined; }

      /*
        **恢复后放在哪儿：谁后挪用谁** —— catalog 里这条的 placementChangedAt 比本机（合并前）新，
        就用云上的项目和归档；否则保持本机原来的（本机归档的继续归档）。合并完的记录里位置可能是
        备份那份 record.json 的，要按这里算出来的写回去。本机原来没有这条的不管（直接用备份里的）。
        放在记忆前面：项目记忆要按恢复后的项目拉。
      */
      const describePlacement = (projectId: string | undefined, archived: boolean) => `「${projectId || '未分组'}」${archived ? '·已归档' : ''}`;
      let placement: { projectId?: string; archived: boolean; fromProjectId?: string; fromArchived: boolean } | undefined;
      const rp = restorePlacement(localBefore, catalogEntry, store.isAdvancedOnlyProjectName);   // 不跟进 advanced 专属项目
      if (rp && recAfter) {
        const cur = placementOf(recAfter);
        const want = rp.placement;
        if (cur.projectId !== want.projectId || cur.archived !== want.archived || cur.placementChangedAt !== want.placementChangedAt) {
          const next = applyPlacement(recAfter, want);
          store.writeRecordKeepUpdatedAt({ ...next, id: sessionId });   // 写盘那道关兜底：不进 advanced 专属项目
          recAfter = store.readRecord(sessionId) || next;
        }
        if (rp.changed) {
          placement = {
            projectId: want.projectId || undefined, archived: want.archived,
            fromProjectId: rp.before.projectId || undefined, fromArchived: rp.before.archived,
          };
          /* 换了项目要换 memory scope、归档要把执行器让出来 —— 和 followBucketPlacements 一样 */
          if (rp.before.projectId !== want.projectId || want.archived) {
            const cl = sessionClients.get(sessionId);
            if (cl?.busy || cl?.autonomous) pendingProjectReset.add(sessionId);
            else if (cl) void detachExecutor(sessionId);
          }
          mainWindow?.webContents.send('session:placement-changed', { sessionId, projectId: want.projectId || null, archived: want.archived });
        }
      }

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
        ...(project && !/[\\/]|\.\./.test(project) && !store.isAdvancedOnlyProjectName(project) ? [`${keyFor(cfg.prefix, path.join('memory', 'projects', project))}/`] : []),
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
        store.writeRecordKeepUpdatedAt({ ...recAfter, id: sessionId });
        madeLocal = true;
      }
      /* 以前在这台机器上删过它的话，墓碑会让它在水化时继续隐身 —— 恢复就是要它回来 */
      clearSessionTombstone(sessionId);
      deletedSessionIds.delete(sessionId);
      forgetDeletion(S3_DELETED_AT_PATH, sessionId);   // 本机又有它了，之前的删除记录作废（云端清理的判据）

      logger.info('s3', `${merged ? '合并' : '恢复'} ${sessionId}：${restored} 个文件`
        + `${merged ? `（并进 ${merged.added} 条${merged.clashed ? `，${merged.clashed} 条同 id 冲突保留本地` : ''}）` : ''}`
        + `${memoryFiles ? `，记忆 ${memoryFiles} 个文件` : ''}${madeLocal ? '，改成在本机跑' : ''}`
        + `${placement ? `，位置按云上改成${describePlacement(placement.projectId, placement.archived)}`
          + `（原来${describePlacement(placement.fromProjectId, placement.fromArchived)}）` : ''}`
        + `${backedUp ? `（本地那份已挪到 ${backedUp}）` : ''}`);
      return { ok: true, restored, backedUp, merged, memoryFiles, madeLocal, projectId: project || undefined, placement };
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
  /* 整段登记成「正在新建」（`creations`）：阶段推给界面、忙闲报 creating、attach 等它建完 */
  ) => creations.run(kiroLexId, { engine: engineOf({ engine: engineArg }), remote: !!remoteId }, async () => {
    const engine = engineOf({ engine: engineArg });
    /*
      **渲染层到底传了没有** ——「新会话就没有远程 tag」查了两轮都没抓到：`kirolex-new-chat-remote`
      明明是 `tokyo`，而 `[model] new-session` 报的机器却是 `local`。两种可能（渲染层没传 / 传了但
      这边没认）要查的地方完全不同，而这一行就把它们分开。留着不删：这条路以后还会被改。
    */
    logger.info('remote', `new-session ${kiroLexId}: remoteId=${remoteId ?? '(没传)'} project=${projectId || '(无)'} model=${model}`);
    /* 先记下选了什么：下面任何一步失败，这条会话都没有记录，右键切换时靠它补（`coldRecordFor`） */
    newSessionIntents.set(kiroLexId, { engine, remoteId: remoteId || undefined, projectId: projectId ?? null });
    newSessionArgs.set(kiroLexId, { cwd, model, projectId: projectId || undefined, kiroAgent: kiroAgent || undefined, remoteId: remoteId || undefined, engine });
    { const advRefused = refuseAdvancedProject(projectId, 'new-session'); if (advRefused) throw new Error(advRefused); }
    if (!ensureExecutorCapacity()) {
      throw new Error(tr('All live sessions are busy; cannot start another right now.'));
    }
    const sessionDir = getSessionDir(kiroLexId);
    let resolvedCwd = cwd === '~' ? os.homedir() : cwd;
    const derived = derivedProjectFor(kiroLexId, resolvedCwd);
    /*
      老配置里的 `agents[].remote`（全局开关）不再自动生效：它只会作为一个**可选目标**
      出现在列表里（`remoteTargets`），选不选由这一次新建决定。
    */
    const remote = findRemoteTarget(KIROLEX_CONFIG_PATH, remoteId);
    if (remote) newSessionIntents.set(kiroLexId, { engine, remote, remoteId, projectId: projectId ?? derived ?? null });
    if (remoteId && !remote) {
      throw new Error(tr('Remote target {id} not found (did the remotes in your config change?). KiroLex did not guess a machine, so this session was not created.', { id: String(remoteId) }));
    }
    /* kiro 的模型 id 对另外两家没有意义：它们用自己 CLI 配的默认模型，记录里写个占位 */
    const engineModel = engine === 'kiro' ? (model || DEFAULT_MODEL) : 'default';
    /* 新会话默认组合（全局 / 项目覆盖，`defaultCombo.ts`）—— 只在建 profile 这一刻填，已有会话不动 */
    const newCombo = defaultComboForNewSession({ home: os.homedir(), configPath: KIROLEX_CONFIG_PATH, engine, projectId: projectId ?? derived });
    if (newCombo.missing) logger.warn('mcp-combo', `new-session ${kiroLexId}: 默认组合 ${newCombo.missing}（${newCombo.source}）本机没有 -> 按通用`);
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
      /* 引擎**写明**（kiro 也写）：记录里没有 engine 原来等于「按 kiro 算」，看日志时分不清是选了 kiro 还是丢了 */
      engine,
      ...(newCombo.mcpCombo ? { mcpCombo: newCombo.mcpCombo } : {}),
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
    /*
      **记录在起执行器之前就落盘**（引擎、机器、工作目录都在里面）—— 原来要等执行器起来、session/new 回来
      （远程实测 34 秒后）才写：这期间重启 / 窗口刷新，这条会话就没了，之后靠渲染层的兜底重建又会按默认值建成本机 kiro。
      先写一份还没有 `cliSessionId` 的：重启后 attach 照它在对的机器上、用对的引擎新起；建成后下面再补上 cliSessionId。
      已经有 cliSessionId 的（不该出现）不碰。
    */
    {
      const early = store.readRecord(kiroLexId);
      if (!early) {
        const pre = store.createSession(kiroLexId, profile);
        pre.localDir = profile.remote?.sshHost ? localDirOrSessionDir(kiroLexId, resolvedCwd) : resolvedCwd;
        store.writeRecord(pre);
      } else if (!early.cliSessionId) {
        /* 失败后重试 / 改成本机再建：机器和引擎按这一次的 */
        early.profile = { ...profile };
        early.localDir = profile.remote?.sshHost ? localDirOrSessionDir(kiroLexId, resolvedCwd) : resolvedCwd;
        store.writeRecord(early);
      }
    }
    /* 远端那台的模型清单 —— 交给 `connectWithModelFallback`，候选只留它有的 */
    let remoteModels: string[] | undefined;
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
        await remoteAdapterCheck(profile.remote, engineOf(profile) as 'claude' | 'codex', kiroLexId);
      } else {
        remoteModels = await remotePreflight(profile.remote);
        profile.model = pickRemoteModel(kiroLexId, firstWantedModel(profile, machineKeyOf(profile), MODEL_FALLBACK_ORDER), remoteModels, profile.remote.sshHost || '');
      }
    }
    creations.stage(kiroLexId, 'check');
    const startLocalTools = profile.remote?.sshHost
      ? await ensureLocalTools(kiroLexId, profile, resolvedCwd)
      /* 本地：新会话也可能一建出来就带组合（新会话默认组合），组合里的 MCP 要在 session/new 时就交出去 —— 和重连那条路（`ensureLocalTools`）一样 */
      : await withLocalBrowser(kiroLexId, localComboTools(kiroLexId, profile));
    /*
      **远端 cwd 要在 `resolvedCwd` 定下来之后再算** —— 实测：它原来算在上面那段"没有项目目录 → 用会话目录"
      **之前**，于是 session/new 拿到的是按家目录算的 `scratch/C__Users_…-<hash>`，而 `ensureLocalTools`
      建出来的是按会话目录算的那个。kiro-cli 不在乎 cwd 在不在，Claude Code 的适配器在 validate-cwd 就拒了 ——
      表现是新建的远程 Claude Code 会话一直"连接中"。
    */
    const cliCwd = profile.remote?.sshHost
      ? sessionCwd(profile, resolvedCwd)
      : resolvedCwd;
    creations.stage(kiroLexId, 'start');
    const started = await connectWithModelFallback(profile, 'new-session', startLocalTools, kiroLexId, remoteModels);
    const client = started.client;
    profile.model = started.model;
    let cliSessionId: string;
    try {
      cliSessionId = (await client.newSession(cliCwd)).sessionId;
    } catch (err) {
      /* 起来了的执行器要收掉 —— 不收的话它在那台机器上一直空跑着 */
      try { await client.disconnect(); } catch { /* 已经没了 */ }
      modelFallback.discard(kiroLexId);   // 没建成：连上时记下的「改用了备用模型」作废
      logger.warn('session', `new-session 失败 sessionId=${kiroLexId} engine=${ENGINE_LABEL[engine]} cwd=${cliCwd}`, err);
      throw err;
    }
    const entry: SessionEntry = { client, cliSessionId, profile, cwd: cliCwd, localDir: resolvedCwd, assistantBuf: '', assistantMsgId: null, fileChanges: [], lastUsedAt: Date.now() };
    sessionClients.set(kiroLexId, entry);
    /* 远程会话：两份镜像（项目目录 + 会话目录）登记进同步编排 */
    wireSession(kiroLexId, entry);
    // Durable record (design §4), keyed by the KiroLex id; store the cli mapping.
    /* 上面已经先写过一份（没有 cliSessionId 的）：在它上面补，期间到的标题 / 标记不丢 */
    const rec = store.readRecord(kiroLexId) || store.createSession(kiroLexId, profile);
    rec.profile = profile;
    rec.cliSessionId = cliSessionId;
    rec.executorState = 'attached';
    /* **本地工作目录进记录** —— 渲染层 attach 时传的是 `'~'`（三处硬写），
       以它为准的话每次重连都会把家目录当项目（远程会话就是把整个家目录推上远端）。见 `localDir`。 */
    rec.localDir = resolvedCwd;
    store.writeRecord(rec);
    newSessionIntents.delete(kiroLexId);
    newSessionArgs.delete(kiroLexId);
    /* 会话建成、记录落盘了：连接时记下的那句「改用了备用模型」现在写进对话记录 */
    modelFallback.commit(kiroLexId);
    /* 远端适配器探测攒下的那几句（登录 shell 看不到适配器 / 那家 CLI 没登录）同理 */
    adapterNotes.commit(kiroLexId);
    mainWindow?.webContents.send('session:ready-for-first-prompt', { sessionId: kiroLexId, projectId: profile.projectId });
    return { sessionId: kiroLexId };
  }));

  /** 正在新建的那些会话走到哪一步了 —— 窗口刷新后渲染层拿一次快照（之后靠 `acp:create-stage` 推送） */
  ipcMain.handle('acp:get-create-stages', async () => creations.snapshot());
  /** 没建成的那条新会话当初是怎么建的（窗口刷新后「重试 / 改成本机运行」用）；建成了 / 不认识的给 null */
  ipcMain.handle('acp:get-create-args', async (_event, sessionId: string) => newSessionArgs.get(String(sessionId || '')) || null);

  ipcMain.handle('acp:prompt', async (_event, sessionId: string, prompt: any[], model?: string, projectId?: string, display?: { messageId?: string; displayText?: string; mergeIntoMessageId?: string; attachments?: any[]; pastes?: any[]; fromHandoff?: string[] }) => {
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'prompt'); if (advRefused) throw new Error(advRefused); }
    if (deletedSessionIds.has(sessionId)) {
      logger.warn('prompt', `refused: sessionId=${sessionId} was deleted —— 不再复活它`);
      throw new Error(tr('This session has been deleted. Nothing more will be sent to it.'));
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
      throw new Error(tr('This session is archived. Unarchive it to keep chatting.'));
    }
    try {
      /* 同一个 messageId 正在跑 → 合并到那一次，不另起一轮（`promptDedupe.ts`） */
      if (promptsInFlight.has(sessionId, display?.messageId)) {
        logger.warn('prompt', `duplicate in flight sessionId=${sessionId} messageId=${display?.messageId} —— 合并到正在跑的那一次`);
      }
      return await promptsInFlight.run(sessionId, display?.messageId, () => sendPromptOnce(sessionId, prompt, projectId, display, model));
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

  /** `followUpTurns.enlistFollowUp` / `handOverTurn` 要的那几样副作用（这条会话的） */
  const followUpDeps = (sessionId: string, entry: SessionEntry): FollowUpDeps => ({
    isCurrent: () => sessionClients.get(sessionId) === entry,
    emitBusy: () => emitSessionBusy(sessionId),
    afterRelease: () => { void pendingSwitchRunner.kick(sessionId); },
    log: (line) => logger.info('prompt', `${line} sessionId=${sessionId}`),
    notConnected: () => new Error(tr('Session not connected')),
  });
  const enlistFollowUp = (sessionId: string, entry: SessionEntry, spec: HandoffSpec, prompt: any[], messageId: string, onBegin: () => void) =>
    enlistFollowUpTurn(entry, spec, prompt, messageId, onBegin, followUpDeps(sessionId, entry));
  const handOverTurn = (sessionId: string, entry: SessionEntry) => handOverFollowUp(entry, followUpDeps(sessionId, entry));

  /** One send attempt. Kept as a named function (rather than an inline handler) so
   *  the failure classification below stays readable. */
  type PromptDisplay = { messageId?: string; displayText?: string; mergeIntoMessageId?: string; attachments?: any[]; pastes?: any[]; announce?: boolean; bgOutput?: boolean; stillWanted?: () => string | null; kirolexNote?: boolean; handoff?: HandoffSpec; fromHandoff?: string[] };
  async function sendPromptOnce(sessionId: string, prompt: any[], projectId?: string, display?: PromptDisplay, _model?: string, attempt = 0): Promise<any> {
    /* 同一次提交只发一次（`promptDedupeFor`） */
    const dedupe = promptDedupeFor(sessionId, display?.messageId, attempt);
    /*
      **忙时记下的切换先应用，再发这一条** —— 新消息要用新的 agent / 模型；不先切的话一轮接一轮
      （排队消息、定时任务）会一直抢在前面，切换永远排不上。自动重发（attempt > 0）是同一轮，不切。
    */
    /* 有切换欠着 / 正在切（这一轮刚结束）：这条要等它 —— 说一声，别让人以为消息卡住了 */
    if (attempt === 0 && !sessionClients.get(sessionId)?.busy && (pendingSwitches.has(sessionId) || pendingSwitchRunner.isApplying(sessionId))) {
      sessionNotice(sessionId, tr('⏳ This message will be sent once the switch finishes.'));
    }
    if (attempt === 0) await pendingSwitchRunner.settle(sessionId);
    /* 开过几轮（纠正那一轮不算）—— 排着的「写成文字」纠正据此判过时，见 `textToolNudgeStale` */
    if (attempt === 0 && !isTextToolNudgeId(display?.messageId)) turnStarts.set(sessionId, (turnStarts.get(sessionId) || 0) + 1);
    if (attempt === 0 && isUserTurnMessageId(display?.messageId)) userTurnStarts.set(sessionId, (userTurnStarts.get(sessionId) || 0) + 1);
    /*
      两轮之间（循环 / 排队）会话不忙，那时候选的切换是立即做的；下一轮恰好在换执行器途中发出来的话，
      entry 还不在 —— 等这次切换落定再发，别报「Session not connected」把循环打断。
    */
    if (attempt === 0 && reconfiguringSessions.has(sessionId)) {
      try { await awaitReconfigureIdle(sessionId); } catch { /* 等不到就照常往下走，下面会说清楚 */ }
    }
    // `let`, not `const`: a mid-flight model swap (retired model) replaces this
    // session's executor, and the rest of the turn must continue on the new one.
    let entry = sessionClients.get(sessionId);
    if (!entry) throw new Error(tr('Session not connected'));
    /*
      **交给适配器、排在当前这一轮后面的那一轮**（`followUpTurns.ts`）：不拒绝「正忙」，而是登记成下一轮，
      等前一轮收尾时同步交棒，再像普通的一轮那样跑完（落盘、看门狗、自动重发、收尾都归这一条）。只在第一次发送时生效。
    */
    const handoff = attempt === 0 ? display?.handoff : undefined;
    /* 不许借一次发送把会话放进 KiroLex Advanced 专属的 flow 项目 —— 在任何副作用（拷附件、写记录）之前 */
    if (refusesProjectChange(projectId, entry.profile.projectId, store.isAdvancedOnlyProjectName)) {
      throw new Error(refuseAdvancedProject(projectId, 'prompt') || tr('This project belongs to KiroLex Advanced; the standard edition does not modify it.'));
    }
    logger.info('prompt', `received sessionId=${sessionId} cli=${entry.cliSessionId} busy=${entry.busy}`);
    /* 你自己发的一条（输入框 / 排队 / 控制入口）：「写成文字」到了上限停下的状态解除（textToolRecovery.ts） */
    if (attempt === 0 && isUserTurnMessageId(display?.messageId) && textToolRecovery.has(sessionId)) {
      textToolRecovery.set(sessionId, afterUserMessage(textToolRecovery.get(sessionId)));
    }
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
    if (!afterSwitch) throw new Error(tr('Session not connected'));
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
      && store.transcriptFileSize(sessionId) > 0
      /* handoff 不带历史快照：它排在一轮正在跑的会话后面，前一轮要么已经带过、要么不需要 —— 再带一份就重复了 */
      && !handoff;
    /*
      **Claude Code / Codex：这一轮开始时后端已经握着这条会话的全部历史**（之前建立过，或者这是第一轮、盘上还什么都没有）
      → 这一轮成功结束就把「上下文已建立」记到这个后端会话 id 上。不记的话只聊过一轮就重启，
      `session/load` 明明接回了那段对话，attach / 发送前的判据（`contextMarkerHolds`）仍找不到标记，下一条照样带一份历史快照。
      kiro 不走这条：它的标记绑进程，规则不变。
    */
    const heldBackendAtStart = backendHeldAtTurnStart(engineOf(entry.profile),
      contextEstablished(sessionId, entry), store.transcriptFileSize(sessionId) === 0)
      ? entry.cliSessionId : undefined;
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
    if (handoff && (entry.priming || entry.needsHistoryPrime)) throw new HandoffRefused('priming');
    if (entry.priming || entry.needsHistoryPrime) {
      const primed = await primeHistoryNow(sessionId);
      /*
        **重建期间选的切换先落定，再发这一条** —— 开头那次 settle 因为重建占着（busy）什么都没做；
        重建一结束它的收尾就开始应用这批。等它，然后执行器换了（新 agent / 模型 / 机器……）就**从头重走**：
        到这里为止什么都还没落盘（用户消息在下面才写），ride-along 也只在不走重建时才标，所以重走是干净的，
        新执行器该重建的上下文也按它自己的状态重新判断。
      */
      if (attempt === 0 && (pendingSwitchRunner.isApplying(sessionId) || pendingSwitches.has(sessionId))) {
        const beforeSwitch = sessionClients.get(sessionId);
        await pendingSwitchRunner.settle(sessionId);
        if (sessionClients.get(sessionId) !== beforeSwitch) {
          logger.info('pending-switch', `重建期间选的切换已应用，按新执行器重走这一条 sessionId=${sessionId}`);
          return sendPromptOnce(sessionId, prompt, projectId, display, _model, attempt);
        }
      }
      entry = sessionClients.get(sessionId) || entry;
      // The user opted out (Stop). Respect it: send WITHOUT the history rather
      // than blocking the message -- they were told the context is incomplete.
      if (entry.primeAbandoned) {
        logger.info('prime', `proceeding WITHOUT history sessionId=${sessionId} (user abandoned the rebuild)`);
      } else if (!primed.ok && !primed.skipped) {
        // Do NOT silently continue on an empty backend. Surfacing this is the
        // whole point: the flag stays set, so the next send retries the rebuild.
        /* 两种情形合成一句带参数的：只差"重建还在不在自己重试"（docs/notices-audit.md） */
        /* 主句只放原因的主句（primeGiveUpNote 那种长诊断的分块 / 字数 / 原文在它的详情里），后面接到这条的详情 */
        const { main: whyMain, detail: whyDetail } = splitNoteDetail(primed.error || tr('unknown reason'));
        throw new Error(trConcat(
          tr('History was not rebuilt ({why}), so this message was not sent. {next}', {
            why: whyMain,
            next: entry.primeGaveUp ? tr('Send again to retry.') : tr('Rebuilding is still retrying.'),
          }),
          NOTE_DETAIL_SEP,
          tr('Press Stop to give up rebuilding; later messages then go out without history.'),
          whyDetail ? `\n${whyDetail}` : ''));
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
    if (handoff?.kind === 'queued') {
      /* 在跑的是后端自己起的那一轮：没有 session/prompt 可排在后面，退回 KiroLex 队列（它收尾后发） */
      if (entry.autonomous) throw new HandoffRefused('unsupported');
      /* 这一轮已经结束了：没有可排在后面的那一轮，按普通消息发（渲染端改走 sendNowOrNext） */
      if (!entry.busy) throw new HandoffRefused('idle');
      /* 占着 busy 的不是一轮普通对话（没有人会来交棒）、或者适配器没声明 promptQueueing：退回 KiroLex 队列 */
      if (!entry.turnRunning || !entry.client.supportsPromptQueueing) throw new HandoffRefused('unsupported');
      /*
        **有切换欠着（忙时选的 agent / 模型 / 运行位置……）就别交给适配器** —— 交过去它会在**旧执行器、旧设置**上
        紧接着这一轮跑，抢在切换前面；会话里那张提示卡还说「排队的消息会在切换完成后发出」。
        退回 KiroLex 队列（和没声明 promptQueueing 同一条退路）：这一轮结束 → 切换 → 再发。没有切换欠着时照旧交给适配器。
      */
      if (pendingSwitches.has(sessionId) || pendingSwitchRunner.isApplying(sessionId)) {
        logger.info('pending-switch', `有切换欠着，这条不交给适配器排、退回 KiroLex 队列（切换完再发）sessionId=${sessionId}`);
        throw new HandoffRefused('unsupported');
      }
    }
    if (entry.busy && entry.wedgedAt && Date.now() - entry.wedgedAt < 30000) {
      const waitUntil = Date.now() + 20000;
      /* handoff 不等：它本来就是要排在正在跑的那一轮后面 */
      while (!handoff && entry.busy && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 200));
      logger.info('prompt', `waited for wedged turn to release sessionId=${sessionId} busy=${entry.busy}`);
    }
    if (entry.busy && !handoff) {
      /* 带错误码：后台唤醒据此判「撞上忙、空了再发」，不靠这句随界面语言变的文字 */
      throw Object.assign(new Error(tr('Wait for the active turn (including context compaction) to finish before sending the queued message.')), { code: SESSION_BUSY });
    }
    /* 后端自己起的那一轮（autonomousTurn.ts）还没收尾：一样算忙 —— 定时提示 / 后台唤醒等它收完再发，两轮的输出不串在一起 */
    if (entry.autonomous && !handoff) {
      throw Object.assign(new Error(tr('Wait for the active turn (including context compaction) to finish before sending the queued message.')), { code: SESSION_BUSY });
    }
    /*
      **提交之前最后再问一次还该不该发**（定时提示：挂执行器 / 等切换 / 重建历史的这段时间里，任务可能刚被暂停或删除）。
      在用户消息落盘之前：不发就什么都不留。
    */
    if (attempt === 0 && display?.stillWanted) {
      const blocked = display.stillWanted();
      if (blocked) throw new WakeSkipped(blocked);
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
    /* handoff：前一轮还在跑，它的 steer 还要并进它自己的用户消息 —— 交棒时再换 */
    if (!handoff) entry.currentUserMessageId = userMessageId;
    const fromHandoffIds = Array.isArray(display?.fromHandoff) ? display!.fromHandoff.filter((x) => typeof x === 'string' && x) : [];
    /* handoff 推迟到交棒那一刻（前一轮的回复先落盘，对话记录的顺序才对）；其余照旧马上落盘 */
    /* 返回「这条用户消息在盘上了」：已经在盘上（重发 / 去重）也算；追加失败返回 false（handoff 据此保留恢复记录） */
    const persistUserMessage = (): boolean => {
    /**
     * **自动重发的那几次不能再落一遍盘** —— `appendMessage` 是无条件追加（见 sessionStore），
     * 所以重发一次 transcript 里就多一条同样的用户消息；而 ride-along 快照正是从 transcript 建的，
     * 于是"重试了 3 次"会变成"同一个问题在历史里问了 4 遍"。`attempt > 0` 时这条已经在盘上了。
     */
    if (attempt > 0) {
      /* 这一条早就在盘上了（见上面）—— 什么都不做 */
      return true;
    } else if (!dedupe.persist) {
      /* 同一个 messageId 上一次没发成：它也已经在盘上了（`promptDedupe.ts`）—— 不再追加一条 */
      return true;
    }
    let persisted = false;
    /* handoff 推迟到交棒时才落盘，那时 prompt 前面已经拼上了记忆等注入块 —— 所以 handoff 一律带 displayText（渲染端 / acp:steer 都给），不走这个兜底 */
    const promptText = Array.isArray(prompt)
      ? prompt.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('')
      : String(prompt ?? '');
    try {
      store.appendMessage(sessionId, {
        id: userMessageId,
        role: 'user',
        content: display?.displayText ?? promptText,
        ts: Date.now(),
        /* KiroLex 自己补发的（「写成文字」的纠正）：显示成 KiroLex 提示，不算你的消息，也不进喂给模型的历史 */
        ...(display?.kirolexNote ? { kirolex: true as const } : {}),
        ...(display?.mergeIntoMessageId ? { mergeIntoMessageId: display.mergeIntoMessageId } : {}),
        // 经控制入口发出的（id 带标记，见 controlSessions.isControlMessageId）：对话记录里显式记一笔
        ...(isControlMessageId(userMessageId) ? { via: 'control' as const } : {}),
        ...(isSessionMessageId(userMessageId) ? { via: 'session' as const } : {}),
        /* 放回 KiroLex 队列的那几条 handoff 原来的 id：重启恢复据此认出已经发过了（pendingHandoffs） */
        ...(fromHandoffIds.length ? { fromHandoff: fromHandoffIds } : {}),
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
      persisted = true;
    } catch (err: any) {
      logger.warn('prompt', `user message NOT persisted sessionId=${sessionId} messageId=${userMessageId}: ${err?.message || err}`);
    }
    /* 落进 transcript 了：那几条 handoff 的恢复记录现在可以摘（摘之前崩了也不怕：transcript 里的 fromHandoff 认得出它们）。没落上就留着 */
    if (persisted && fromHandoffIds.length) {
      for (const hid of fromHandoffIds) { try { removePendingHandoff(store.sessionDirPath(sessionId), hid); } catch { /* 重启时按 fromHandoff 判 */ } }
    }
    /*
      **主进程自己发起的这一轮**（定时到点 / 后台命令退出 / 监视事件 / 交给适配器排着的那一轮）—— 界面原来不知道有这一轮：
      用户消息只在盘上、回复不流式，切走再回来才看得见。告诉渲染端：插进这条消息，并接管这一轮的流。
      落盘失败也照样说：这一轮已经在跑了，界面上不能没有它（恢复记录留着，重启时还能放回）。
    */
    if (display?.announce) {
      mainWindow?.webContents.send('acp:main-turn', { sessionId, messageId: userMessageId, content: display?.displayText ?? promptText, ts: Date.now(), ...(display?.kirolexNote ? { kirolex: true } : {}), ...(handoff ? { handoff: true } : {}), ...(display?.attachments?.length ? { attachments: display.attachments } : {}) });
    }
    return persisted;
    };
    if (!handoff) persistUserMessage();
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
      /* Claude Code / Codex：定时用 schedule_create，别用后端自带的 CronCreate / ScheduleWakeup（它们只活在后端进程里，见 wakeTools.ts） */
      const sched = adapterScheduleNote(engineOf(entry.profile));
      if (sched) prompt = [{ type: 'text', text: sched }, ...prompt];
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
    /*
      **handoff：登记成排在后面的那一轮，等前一轮交棒**（`enlistFollowUp`）。交棒那一刻同步：接 busy、换
      currentUserMessageId（这之后的 steer 并进这一条）、落盘用户消息、告诉界面（`acp:main-turn`，渲染端接管这一轮的流）。
    */
    let preResponse: Promise<any> | undefined;
    let followUp: FollowUp | undefined;
    const enlistedAt = Date.now();
    if (handoff) {
      /*
        **发之前先记在盘上**（`pendingHandoffs.ts`）：交出去之后、交棒落盘之前这段时间退出 / 崩溃，适配器跟着没了、那条也没跑，
        重启时从这里放回 KiroLex 队列。交棒时先落盘 transcript 再摘（中间崩了，transcript 里有它，重启不会再放回）；没轮到就失败也摘。
      */
      const dir = store.sessionDirPath(sessionId);
      if (handoff.kind === 'queued') {
        try {
          addPendingHandoff(dir, {
            id: userMessageId,
            content: display?.displayText ?? '',
            ...(display?.attachments?.length ? { attachments: display.attachments } : {}),
            ...(display?.pastes?.length ? { pastes: display.pastes } : {}),
            ts: Date.now(),
          });
        } catch (err: any) {
          logger.warn('prompt', `pending handoff not recorded sessionId=${sessionId}: ${err?.message || err} —— 退回 KiroLex 队列`);
          throw new HandoffRefused('unsupported');
        }
      }
      try {
        const enlisted = await enlistFollowUp(sessionId, entry, handoff, prompt, userMessageId, () => {
          entry!.currentUserMessageId = userMessageId;
          /* 先记一笔「已经交给适配器在跑了」：下面落盘要是失败，重启时它只补写进对话记录、不自动重发（不会重复执行） */
          try { markHandoffStarted(dir, userMessageId); } catch { /* 记不上：重启时还按 transcript 里的 replyTo 认 */ }
          /* 确认用户消息落上了 transcript 才摘恢复记录（`pendingHandoffs.persistThenRelease`）；没落上就留着、明说出来 */
          const released = persistThenRelease(dir, userMessageId, persistUserMessage);
          if (!released && handoff.kind === 'queued') {
            sessionNotice(sessionId, tr('This message could not be saved to the conversation record; it is kept for recovery after a restart.'));
          }
        });
        followUp = enlisted.followUp;
        preResponse = enlisted.response;
      } catch (err: any) {
        /*
          没轮到它就失败了（`handoffNotStarted`）：盘上的记录**先留着**，等渲染端把它放回 KiroLex 队列、队列写了盘
          再摘（`acp:ack-handoff-failed`）—— 中间窗口没了 / 崩了，重启时照样从这里放回，不丢。别的失败（压根没发出去）渲染端当场处理，直接摘。
        */
        if (!err?.handoffNotStarted) { try { removePendingHandoff(dir, userMessageId); } catch { /* 重启时按 transcript 判 */ } }
        throw err;
      }
    }
    /* 这一轮收尾时 busy 留给了排在后面的那一轮 —— 最外层 finally 里交棒 */
    let ownsHandOver = false;
    let myTurnSeq = -1;
    try {
      entry.busy = true; // in-flight turn — exempt from LRU eviction
      /* KiroLex 发起的第一轮开始了：回放窗口关（`replayGuard.outsideTurnVerdict`）—— 之后一轮之外的正文是后端自己起的一轮 */
      entry.replayWindow = false;
      entry.turnRunning = true;
      entry.turnStartedAt = Date.now();   // 控制入口 `GET /sessions/:id/status` 的 turnStartedAt
      emitSessionBusy(sessionId);
      // Tag this turn so a *rejected duplicate* invocation can never clear the
      // busy flag belonging to the turn that is actually running.
      const myTurn = (entry.turnSeq = (entry.turnSeq || 0) + 1);
      myTurnSeq = myTurn;
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
          entry.bufAtLastTool = 0;
          entry.textThisTurn = false;    // 同 toolsThisTurn：这一轮还没出过字（planRetry 的 producedText 看它）
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
            /*
              **等人批准不是卡死**：Claude Code / Codex 在 KiroLex 里永远是 ask（`AcpClient` 构造函数），
              一个没人点的权限请求原来会被静默上限当成卡死、取消、再自动续一轮（又来问一次）。等着的时候把计时往后推。
            */
            if (engineOf(e.profile) !== 'kiro' && e.client.awaitingPermission) {
              e.lastStreamAt = Date.now();
              return;
            }
            /* 等人回答提问（三家都可能问）同理：超时由提问自己的兜底管（`openQuestion`），不归看门狗 */
            if (e.client.awaitingQuestion) {
              e.lastStreamAt = Date.now();
              return;
            }
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
            const dur = (ms: number) => (ms < 90000 ? tr('{n} s', { n: Math.round(ms / 1000) }) : tr('{n} min', { n: Math.round(ms / 60000) }));
            /* 主句只说被中断了、为什么（一句）；时长、上限、设置项折进「详情」（回复气泡认 NOTE_DETAIL_SEP，见 ChatArea） */
            e.wedgeNote = staleToolCount
              ? trConcat(tr('⚠️ This turn was interrupted: a tool made no progress for too long.'), NOTE_DETAIL_SEP,
                tr('{count} tool call(s) had no progress for {idle} (limit {limit} min); the tool may still be running in the background. To wait longer, raise "Tool stall threshold" in Settings.', { count: staleToolCount, idle: dur(toolIdleFor), limit: Math.round(TOOL_STALL_MS / 60000) }))
              : trConcat(tr('⚠️ This turn was interrupted: no output for too long.'), NOTE_DETAIL_SEP,
                tr('No output for {quiet} (limit {limit} min). To wait longer, raise "Silence before a turn counts as wedged" in Settings.', { quiet: dur(quietFor), limit: Math.round(WEDGE_CONFIRM_MS / 60000) }));
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
            /*
              handoff 的第一次：字节早就发出去了（queued 的 session/prompt / detached 的 steering），等它自己的结束；
              这一轮的计数刚清零，现在把攒着的输出按原顺序交出去，之后的直接处理（`live`）。
            */
            const adoptPreResponse = async (pending: Promise<any>): Promise<any> => {
              const ent = entry!;
              if (followUp?.kind === 'detached') {
                const fu = followUp;
                ent.detachedSeen = false;
                ent.detachedEnd = () => { ent.detachedEnd = undefined; fu.endDetached?.({ stopReason: 'end_turn' }); };
              }
              /* 你点了停止之后才轮到它：一接手就停（Claude Code 本来就会把排着的一起取消，这是兜底） */
              if (ent.cancelRequestedAt && ent.cancelRequestedAt >= enlistedAt) {
                try { await ent.client.cancelPrompt(ent.cliSessionId); } catch { /* 进程已经没了 */ }
                ent.detachedEnd?.();
              }
              if (followUp) {
                followUp.live = true;
                const held = followUp.held.splice(0);
                if (held.length) ent.replayUpdates?.(held);
              }
              return pending;
            };
            const pre = preResponse;
            preResponse = undefined;
            const result = pre ? await adoptPreResponse(pre) : await entry.client.sendPrompt(entry.cliSessionId, prompt);
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
            /* Claude / Codex 被停掉的这一轮：被打断的工具不会再有最终状态，落盘前收成 failed、界面同步（`cancelSettle.ts`；kiro 不走） */
            {
              const settled = settleCancelledToolCalls(engineOf(entry.profile), result?.stopReason, entry.fileChanges);
              entry.fileChanges = settled.calls;
              for (const id of settled.settled) {
                mainWindow?.webContents.send('acp:update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' } });
              }
            }
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
            /*
              **把工具调用写成了文字就结束了**（`textToolCall.ts`）—— 在 flush 清空缓冲之前判，只看最后一次真实工具调用之后的正文。
              侧栏改写那一轮（有人在等完整回复，正文要拿去写盘）和 /clear 那一下不管。
            */
            const textTool = entry.priming ? null : textToolCallVerdict({
              stopReason: String(result?.stopReason ?? ''),
              text: entry.assistantBuf,
              tailFrom: entry.bufAtLastTool || 0,
              correctionTurn: isTextToolNudgeId(userMessageId),
              skip: askWaiters.has(sessionId) || userMessageId.startsWith('flow_clear_'),
            });
            /* 标记块的下标是相对这份缓冲的 —— flush 会清空它，先留一份给「这一步是干什么的」用 */
            const textToolBuf = textTool && textTool.action !== 'none' ? entry.assistantBuf : '';
            /* 只有正常、完整结束的这一轮才算"答过了"：被停掉 / 截断 / 卡死的半截同一条还能重试（`turnCompletedNormally`） */
            if (turnCompletedNormally({ stopReason: result?.stopReason, wedged: !!entry.wedgeNote })) entry.completedReplyTo = userMessageId;
            flushAssistant(sessionId); // turn complete -> persist the full assistant msg
            if (askReply) settleAsk(sessionId, askReply);
            if (textTool && textTool.action !== 'none') handleTextToolCall(sessionId, textTool, textToolBuf);
            // The request was accepted and answered, so the snapshot it carried IS
            // in this backend now: the claim written before the send is confirmed.
            // Re-marked against the CURRENT entry rather than just clearing the
            // flag, because a mid-turn model swap replaced the executor (new pid,
            // and the catch below dropped the marker) -- the resend carried the same
            // snapshot, so the new backend is the one that must be recorded.
            if (rideAlong && entry.rideAlongUnconfirmed) {
              markContextEstablished(sessionId, entry);
              entry.rideAlongUnconfirmed = false;
            } else if (heldBackendAtStart && heldBackendAtStart === entry.cliSessionId && !contextEstablished(sessionId, entry)) {
              markContextEstablished(sessionId, entry);
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
            if (engineOf(entry.profile) === 'kiro' && isBareInternalError(text) && bareStreak >= POISONED_AFTER && !producedThisTurn
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
                  /* 换了模型 → 进对话记录；为什么换（笼统 Internal error、换后端会话没用）折进详情 */
                  noteInSession(sessionId, trConcat(
                    tr('🔀 Got no reply {n} times in a row, so the model was switched from {from} to {to} and your message resent.', { n: bareStreak + 1, from: failedModel, to: swapped }),
                    NOTE_DETAIL_SEP,
                    tr('Each attempt ended with a bare "Internal error", and switching backend sessions had not helped. The conversation is unchanged.')),
                    undefined, `model-swap:${failedModel}→${swapped}`);
                  entry = next;
                  entry.busy = true;
                  entry.turnSeq = myTurn;
                  entry.assistantBuf = '';
                  entry.assistantMsgId = null;
                  entry.fileChanges = [];
                  entry.toolsThisTurn = 0;
                  entry.textThisTurn = false;
                  mainWindow?.webContents.send('acp:turn-restart', { sessionId });
                  continue;
                }
              }
            }
            if (engineOf(entry.profile) === 'kiro' && isModelUnavailableError(text) && modelSwaps < MAX_MODEL_SWAPS) {
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
        if (followUp) { dropFollowUp(entry, followUp); if (entry.detachedEnd) entry.detachedEnd = undefined; }
        if (e && e.turnSeq === myTurn) {
          /* 有人排在后面（或者还在等 steering 的结果）：busy 留着，下面最外层收尾时交棒（`handOverTurn`） */
          if (keepsBusy(e)) ownsHandOver = true;
          else { e.busy = false; e.lastUsedAt = Date.now(); }
        }
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
      /* 这一轮带着后台输出，或者这条会话早先收到过（之后每一轮的历史里都有它）：都不抄会话内容 */
      const omitSessionContent = bundleOmitsSessionContent({ bgOutputThisTurn: !!display?.bgOutput, sessionSawBgOutput: !!store.readRecord(sessionId)?.bgOutputSeen });
      const bundle = await writeFailureBundle({
        sessionId,
        cliSessionId: entry.cliSessionId,
        /* 后台命令 / 监视的输出只回到会话、不额外落盘（可能有凭证）—— 诊断包里只留占位，也不抄后端那份会话历史 */
        promptText: diagnosticPromptText(prompt, omitSessionContent),
        omitConversation: omitSessionContent,
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
        throw new Error(tr('The previous turn is still running (active turn, maybe compacting context). Wait for it, or press Stop, then send again.'));
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
      /*
        **有一轮排在后面（适配器那边已经收下了）时不自己重发、不换后端会话**：重发的这一条会排到它后面去、或者落到一个它不在的新会话上，
        两轮就对不上了。照实报这个错；排着的那一轮照常接手。
      */
      if (ownsHandOver) throw err;
      const verdict = staleVerdict({
        error: `${err?.message || ''}${detail}`,
        contextPid: store.readRecord(sessionId)?.contextEstablishedPid,
        clientPid: entry.client.pid,
        /* Claude Code / Codex 的会话存在适配器那边：pid 变了不等于上下文没了 */
        persistentBackend: backendPersistsSessions(engineOf(entry.profile)),
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
      /*
        **"这一轮出过字没有"不能看 `assistantBuf`** —— catch 开头那句 flushAssistant 已经把它清空了，原来读到的永远是"没出过字"：
        已经输出了文字、随后断网的那一轮被当成"还没开始"自动重发。`textThisTurn` 在流式时记、每次发送开头清零，flush 不动它。
      */
      const plan = planRetry({
        error: errText,
        attempt,
        producedText: !!(entry.textThisTurn || entry.assistantBuf),   // flush 已清空 buf —— 看流式时记下的 textThisTurn
        toolsRan: entry.toolsThisTurn || 0,
        /* 远程多给两次 —— 它多了 ssh / 隧道 / 那台机器这一整段会抖的东西 */
        remote: !!entry.profile.remote?.sshHost,
      });
      if (verdict === 'recreate') {
        let made: { sessionId: string } | null = null;
        try {
          /* 换新的后端会话：和「写成文字」反复发作、控制入口 new-backend 同一套（`recreateBackendSession`），上下文跟着这一次重发带过去 */
          const swapped = await recreateBackendSession(sessionId, entry, 'stale-session-recreate');
          const oldId = swapped.oldId;
          made = { sessionId: swapped.newId };
          cliRecreatedAt.set(sessionId, Date.now());
          const poisoned = streak >= POISONED_AFTER;
          /* 主句：发生了什么（简短原因）；pid / 新的后端会话 id / 推理折进详情（docs/notices-glossary.md） */
          const note = poisoned
            ? trConcat(
              tr('🔀 This conversation failed {n} times in a row ({err}), so it moved to a new backend session with the context carried over.', { n: streak, err: String(err?.message || '').slice(0, 60) }),
              NOTE_DETAIL_SEP,
              tr('The process (pid) did not change, so the session had not expired: most likely the history itself is what fails (often a tool result). New backend session: {id}…. The conversation is unchanged.', { id: made.sessionId.slice(0, 8) }))
            : staleRecoveryNote(oldId, made.sessionId,
              store.readRecord(sessionId)?.contextEstablishedPid ?? 0, entry.client.pid ?? 0);
          logger.warn('prompt', `${poisoned ? 'poisoned' : 'stale'} cli session recreated sessionId=${sessionId}: ${note}`);
          /*
            **在会话里说一句** —— 不说的话你看到的是"前几条都失败、这一条突然成了"，
            而中间换过后端会话这件事解释了为什么。只在"毒了"这条路上说：pid 不一致那条是常规现象
            （kiro-cli 不持久化 ACP 会话），每次都播报只会变成噪音。
          */
          if (poisoned) {
            noteInSession(sessionId, note, undefined, 'backend-session-swap');
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
          throw new Error(trConcat(`${errText}\n\n`,
            tr('(This turn had already run {n} tool call(s){hint}, so it was not resent automatically, to avoid running them twice. Press Rerun or send a new message.)', { n: entry.toolsThisTurn || 0, hint: bigOutputHint(entry.maxToolOutputThisTurn), id: made.sessionId.slice(0, 8) }),
            cliWhy ? `\n\n${cliWhy}` : ''));
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
        throw new Error(trConcat(isTransientTransportError(errText)
          ? tr('Can\'t reach the model service ({err}); {n} automatic resends all failed. Check your network/VPN, then send again.', { err: errText.slice(0, 120), n: attempt })
          : retriesExhaustedNote(errText, attempt), why));
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
      /* busy 留给了排在后面的那一轮：现在交棒（前一轮的回复 / 半截回复都已经落盘了） */
      if (entry.turnSeq === myTurnSeq) entry.turnRunning = false;
      if (ownsHandOver) handOverTurn(sessionId, entry);
      else if (entry.limbo && !entry.turnRunning && !(entry.steeringInFlight || 0) && !entry.followUps?.length) {
        /* limbo 里还攒着输出（steering 在这一轮收尾前就有了结果、不是「自己起了一轮」）：原样交还给处理函数，busy 不动 */
        const held = entry.limbo.held;
        entry.limbo = undefined;
        if (held.length) entry.replayUpdates?.(held);
      }
      if (!sessionClients.get(sessionId)?.busy) consumePendingProjectReset(sessionId, '本轮报错结束，执行下推的执行器重置');
      /* 这一轮（正常结束 / 报错 / 被 Stop）收场：忙时记下的切换现在应用（还有别的一轮在跑就等它收尾） */
      void pendingSwitchRunner.kick(sessionId);
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
    /* 后端自己起的那一轮（autonomousTurn.ts）：重载后的窗口没收到它的 acp:main-turn，靠这里接管它的流（结束信号同样是 busy 不再报 turn） */
    if (entry?.autonomous && !entry.busy && !entry.priming) {
      return { live: true, messageId: entry.assistantMsgId, text: entry.assistantBuf || '', startedAt: entry.autonomous.startedAt };
    }
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
      /* 排在后面、已经交给适配器的那几轮也一起停：它们接手时再补一个 cancel（见 sendPromptOnce 的 handoff 那段） */
      entry.cancelRequestedAt = Date.now();
      await entry.client.cancelPrompt(entry.cliSessionId);
      /* 适配器自己起的那一轮（detached）没有响应可等：停了就算这一轮结束 */
      entry.detachedEnd?.();
      /* 后端自己起的那一轮（autonomousTurn.ts）也没有响应可等：停了就收尾，已经出来的落盘 */
      if (entry.autonomous) endAutonomousTurn(entry, autonomousDeps(sessionId, entry), 'cancelled');

      // session/cancel is a notification, so wait for the in-flight prompt RPC to
      // settle before allowing an interrupt-and-steer prompt onto the same client.
      const deadline = Date.now() + 10000;
      while (entry.busy && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (entry.busy) throw new Error(tr('Timed out waiting for the active turn to stop.'));
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
  /** 渲染端在登记一条 steer 之前先问「真正会写出去的是什么」：acp:steer 会把大图路径换成缩小后的副本，
   *  kiro 回报「吃掉了」时带的是换过的正文。渲染端拿它登记、按它精确对账 —— 图片的身份（哪张图）保留着。
   *  同一个函数、按路径+mtime+大小缓存，所以 acp:steer 再处理一遍得到的是同一份文字。 */
  ipcMain.handle('acp:cap-steer-text', async (_event, message: string) => capImageRefsInText(String(message || '')));

  /**
   * **忙时 Enter 交给适配器排队**（适配器声明了 `agentCapabilities._meta.claudeCode.promptQueueing`，见 busyEnterCaps.ts）：
   * 现在就把这条的 session/prompt 发出去，由 CLI 自己排在正在跑的那一轮后面；KiroLex 把它登记成下一轮（`followUpTurns.ts`），
   * 前一轮收尾时交棒 —— 用户消息那时落盘、界面那时插进这条消息并接管它的流（`acp:main-turn`）。
   * 一发出去就回话（`accepted`）；没发成回 `{accepted:false, reason}`，渲染端按 reason 改走普通发送 / KiroLex 队列。
   * 发出去了、却没轮到它就失败了（执行器没了…）→ `acp:handoff-failed`（`notStarted`），渲染端把它放回 KiroLex 队列。
   */
  ipcMain.handle('acp:handoff-prompt', async (_event, sessionId: string, prompt: any[], model?: string, projectId?: string, display?: { messageId?: string; displayText?: string; attachments?: any[]; pastes?: any[] }) => {
    { const advRefused = refuseAdvancedOnly(sessionId, 'prompt'); if (advRefused) return { accepted: false, reason: 'refused', error: advRefused }; }
    if (deletedSessionIds.has(sessionId) || store.readRecord(sessionId)?.archived) return { accepted: false, reason: 'refused' };
    return await new Promise<{ accepted: boolean; reason?: string; error?: string }>((resolve) => {
      let answered = false;
      const answer = (r: { accepted: boolean; reason?: string; error?: string }) => { if (!answered) { answered = true; resolve(r); } };
      sendPromptOnce(sessionId, prompt, projectId, {
        ...(display || {}),
        announce: true,
        handoff: { kind: 'queued', onAccepted: answer },
      }, model).catch((err: any) => {
        if (err instanceof HandoffRefused) { answer({ accepted: false, reason: err.reason }); return; }
        if (!answered) { answer({ accepted: false, reason: 'error', error: String(err?.message || err) }); return; }
        const notStarted = !!err?.handoffNotStarted;
        logger.warn('prompt', `handoff turn failed sessionId=${sessionId} messageId=${display?.messageId} notStarted=${notStarted}: ${err?.message || err}`);
        /* 整条消息跟着走：窗口刷新过的话它手里已经没有那张卡片了，靠这份放回 KiroLex 队列 */
        mainWindow?.webContents.send('acp:handoff-failed', {
          sessionId, messageId: display?.messageId, notStarted, error: String(err?.message || err),
          content: display?.displayText ?? '',
          ...(display?.attachments?.length ? { attachments: display.attachments } : {}),
          ...(display?.pastes?.length ? { pastes: display.pastes } : {}),
        });
        if (!notStarted) sessionNotice(sessionId, String(err?.message || err));
      });
    });
  });

  /**
   * 窗口启动时取上一次运行留下的、交给了适配器却没轮到的那几条（`pendingHandoffs.recoverableHandoffs`，只读不摘：
   * 窗口放进队列、队列写盘之后逐条 `acp:ack-handoff-failed`，那时才摘），
   * 渲染端放回 KiroLex 队列。transcript 里已经有的（交棒时落过盘）不给；主进程内存里还排着的（只是窗口刷新了）不动。
   */
  /** 渲染端把没轮到的那条放回 KiroLex 队列了：先把 ui-state（队列就在里面）写盘，再摘掉盘上的记录 */
  ipcMain.handle('acp:ack-handoff-failed', (_event, sessionId: string, messageId: string) => {
    if (!sessionId || !messageId) return { ok: false };
    /* 只有 ui-state 真的写上了盘、写上去的队列里也有它，才摘（`pendingHandoffs.ackRequeued`）；否则留着，下次启动照样放回 */
    try {
      const ok = ackRequeued(store.sessionDirPath(sessionId), sessionId, messageId, {
        flush: flushUiStateNow,
        queuesRaw: () => uiState()['kirolex-queues'],
      });
      if (!ok) logger.warn('prompt', `handoff requeue NOT confirmed sessionId=${sessionId} messageId=${messageId} —— 记录留着，下次启动再放回`);
      return { ok };
    } catch { return { ok: false }; }
  });

  ipcMain.handle('acp:take-pending-handoffs', () => {
    const out: Record<string, PendingHandoff[]> = {};
    /* 主进程还排着的（只是窗口刷新了）：交回去让窗口把「已交给 …」卡片画回来 */
    const liveCards: Record<string, PendingHandoff[]> = {};
    const live = new Set<string>();
    for (const e of sessionClients.values()) for (const f of e.followUps || []) live.add(f.messageId);
    let ids: string[] = [];
    try { ids = fs.readdirSync(path.dirname(store.sessionDirPath('x'))); } catch { return out; }
    for (const id of ids) {
      let dir: string;
      try { dir = store.sessionDirPath(id); } catch { continue; }
      if (!fs.existsSync(path.join(dir, 'pending-handoffs.json'))) continue;
      try {
        /* 已经发过的：transcript 里的消息 id，加上放回队列后发出去的那条带着的原 handoff id（`fromHandoff`，合并发送可以有几条） */
        /* 分开判：用户消息在盘上了（可以摘） / 执行过了（不能重发）—— 有回复却没有用户消息的，补写原文 */
        const known = handoffFacts(store.readTranscript(id, { raw: true }) || []);
        /* 交棒过、用户消息没写上的：补写进对话记录（原来的 id），不自动重发 —— 要不要重跑你来定 */
        /* 和 persistUserMessage 同一个形状（原文、附件、粘贴块），见 pendingHandoffs.restoredUserMessage */
        const restored = restoreStartedHandoffs(dir, known, live, (h) => store.appendMessage(id, {
          ...restoredUserMessage(h),
          ...(isControlMessageId(h.id) ? { via: 'control' as const } : {}),
        }));
        if (restored.length) logger.info('prompt', `started handoffs restored into transcript sessionId=${id} count=${restored.length} —— 已经执行过，不自动重发`);
        const back = recoverableHandoffs(dir, known, live);
        const still = readPendingHandoffs(dir).filter((h) => live.has(h.id));
        if (still.length) liveCards[id] = still;
        if (back.length) {
          out[id] = back;
          logger.info('prompt', `pending handoffs recovered sessionId=${id} count=${back.length} —— 放回 KiroLex 队列`);
        }
      } catch (err: any) {
        logger.warn('prompt', `pending handoffs unreadable sessionId=${id}: ${err?.message || err}`);
      }
    }
    return { recover: out, live: liveCards };
  });

  ipcMain.handle('acp:steer', async (_event, sessionId: string, message: string, steerMsgId?: string) => {
    const entry = sessionClients.get(sessionId);
    /*
      在跑的是后端自己起的那一轮（autonomousTurn.ts）：busy 为假（下面会判成 idle、当新消息立刻发），可它还没收尾，
      也没有用户消息可并进去 —— 排进 KiroLex 队列（`unsupported` → 渲染端 queue），它收尾后发。
    */
    if (entry?.autonomous) return { steered: false, reason: 'unsupported' };
    // Order matters (see steerGate.ts): a history rebuild is a LOCKED task, not a
    // conversational turn -- steering into it would inject the user's text into a
    // hidden priming turn, so the renderer parks it until the rebuild finishes.
    // "The turn already ended" is checked BEFORE "engine cannot steer": a claude /
    // codex turn that just finished must send the message as a new one ('idle'),
    // not mark it red as unsupported.
    const refused = steerRefusal({
      connected: !!entry,
      reconfiguring: reconfiguringSessions.has(sessionId),
      priming: !!entry?.priming,
      busy: !!entry?.busy,
      supportsSteer: !!entry?.client.supportsSteer,
    });
    if (refused === 'priming') logger.info('prime', `steer REFUSED during rebuild sessionId=${sessionId} -> renderer should wait for it`);
    if (refused || !entry) return { steered: false, reason: refused || 'not-connected' };
    entry.lastUsedAt = Date.now();
    /*
      **适配器声明了 `_meta.steering.supported`**（Claude Code / Codex，`busyEnterCaps.ts`）：`_session/steering` 请求，
      插进当前这一轮。没有在跑的一轮 → `idle`（渲染端改普通发送）；报错 → `unsupported`（渲染端排队，不标红）。
    */
    if (entry.client.busyEnter === 'steering') {
      const capped = capImageRefsInText(message);
      /* 结果可能是「适配器自己起了一轮」：这一轮要是在等结果的时候收尾了，busy 先别放（`followUpTurns.keepsBusy`） */
      entry.steeringInFlight = (entry.steeringInFlight || 0) + 1;
      /* 「在途」一直算到那一轮登记好为止（handed-off 时）：中间前一轮收尾了也不会把 busy 放掉、把攒着的输出当回放丢掉 */
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        entry.steeringInFlight = Math.max(0, (entry.steeringInFlight || 1) - 1);
      };
      let res: { steered: boolean; reason?: string; detail?: string };
      try {
        res = await entry.client.steering(entry.cliSessionId, capped);
      } catch (err: any) {
        res = { steered: false, reason: 'unsupported', detail: String(err?.message || err) };
      }
      if (res.reason !== 'handed-off') settle();
      if (!res.steered || res.detail) logger.info('prompt', `_session/steering sessionId=${sessionId} steered=${res.steered} reason=${res.reason || '-'} ${res.detail || ''}`);
      if (res.reason === 'handed-off') {
        /*
          **这一轮刚好结束，适配器自己起了一轮**（Codex 的 `startedNewTurn`）：把那一轮认成这条消息的正常一轮 ——
          用户消息作为一条新消息落盘（不并进上一轮），输出 / 结束 / 落盘都归它。从现在起没标 prompt 的输出先攒着（limbo），
          登记好之后交给它。消息已经在适配器手里了，绝不再发一遍。
        */
        entry.limbo ||= { held: [] };
        /* 由渲染端那条 steer 的 id 推出来（`steer_ctl_…` → `user_ctl_…_turn`）：控制入口发的照样带标记、落盘成 via:'control' */
        const turnMessageId = detachedTurnMessageId(typeof steerMsgId === 'string' && /^steer_[A-Za-z0-9_-]+$/.test(steerMsgId) ? steerMsgId : `steer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        /* 显示 / 落盘：渲染端拼的 steer 文字里带着附件引用块（steerRoute.steerPayload），拆回正文 + 附件，和普通消息一样 */
        const shown = steerDisplay(message);
        void sendPromptOnce(sessionId, steeringPromptBlocks(capped), entry.profile.projectId, {
          messageId: turnMessageId,
          displayText: shown.text,
          ...(shown.files.length ? { attachments: shown.files } : {}),
          announce: true,
          handoff: { kind: 'detached', held: [], onEnlisted: settle },
        }).catch((err: any) => {
          /* 没登记上就失败了：别让 busy 一直留着 */
          if (!settled) {
            settle();
            if (entry.limbo && !entry.turnRunning && !(entry.steeringInFlight || 0)) handOverTurn(sessionId, entry);
          }
          logger.warn('prompt', `detached turn failed sessionId=${sessionId} messageId=${turnMessageId}: ${err?.message || err}`);
          sessionNotice(sessionId, String(err?.message || err));
        });
        return { steered: false, reason: 'handed-off', messageId: turnMessageId };
      }
      /* 前一轮在等这个结果才肯交棒：不是「自己起了一轮」，那就放开（或者交给排着的下一个） */
      if (entry.limbo && !entry.turnRunning && !(entry.steeringInFlight || 0)) handOverTurn(sessionId, entry);
      return { steered: res.steered, reason: res.reason };
    }
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
  ipcMain.handle('acp:persist-steer', async (_event, sessionId: string, text: string, messageId?: string, attachments?: { id?: string; name: string; path: string; isImage?: boolean }[]) => {
    /* 带附件的 steer 可以没有文字（只发了一张图） */
    const files = Array.isArray(attachments)
      ? attachments.filter((a) => a && typeof a.path === 'string' && a.path)
        .map((a) => ({ ...(a.id ? { id: String(a.id) } : {}), name: String(a.name || ''), path: a.path, ...(a.isImage ? { isImage: true } : {}) }))
      : [];
    if (!sessionId || (!text && !files.length)) return { ok: false, error: 'no text' };
    { const advRefused = refuseAdvancedOnly(sessionId, 'persist-steer'); if (advRefused) return { ok: false, error: advRefused }; }
    const entry = sessionClients.get(sessionId);
    // The turn's own user message is the merge target. If it is unknown (a steer
    // into a turn this process did not start — e.g. after a hot restart), fall back
    // to a standalone user message: out of order is still better than lost.
    const mergeInto = entry?.currentUserMessageId;
    try {
      store.appendMessage(sessionId, {
        id: messageId || `steer_${Date.now()}`,
        ...(isControlMessageId(messageId) ? { via: 'control' as const } : {}),
        ...(isSessionMessageId(messageId) ? { via: 'session' as const } : {}),
        role: 'user',
        content: text || '',
        ts: Date.now(),
        ...(files.length ? { attachments: files } : {}),
        ...(mergeInto ? { mergeIntoMessageId: mergeInto } : {}),
      });
      logger.info('prompt', `steer persisted sessionId=${sessionId} chars=${(text || '').length} files=${files.length} mergeInto=${mergeInto || '<none, standalone>'}`);
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
  ipcMain.handle('acp:persist-note', async (_event, sessionId: string, text: string, variants?: unknown) => {
    if (!sessionId || !text || !text.trim()) return { ok: false, error: 'no text' };
    { const advRefused = refuseAdvancedOnly(sessionId, 'persist-note'); if (advRefused) return { ok: false, error: advRefused }; }
    if (!store.readRecord(sessionId)) return { ok: false, error: 'unknown session' };
    const content = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
    try {
      store.appendMessage(sessionId, {
        id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        content,
        ts: Date.now(),
        /* 循环结束那句是 KiroLex 写的：两版都存，显示时按界面语言挑 */
        ...(asVariants(variants) && content === text ? { variants: asVariants(variants) } : {}),
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'loop:register-verifier'); if (advRefused) return { ok: false, error: advRefused }; }
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'loop:verify'); if (advRefused) return { ran: false, exitCode: null, output: '', host: 'local', durationMs: 0, timedOut: false, error: advRefused }; }
    const approved = registeredVerifiers.get(sessionId);
    if (!approved || approved.command !== command) {
      // Not an error the user caused: it means something asked to run a command
      // this session's loop never declared.
      logger.warn('loop', `verify REFUSED sessionId=${sessionId} — command not registered by a loop start`);
      return { ran: false, exitCode: null, output: '', host: 'local', durationMs: 0, timedOut: false, error: tr('Refused: this check command was not registered by the loop settings') };
    }
    const rejected = loopVerify.rejectRequest(command, timeoutSec);
    if (rejected) return { ran: false, exitCode: null, output: '', host: 'local', durationMs: 0, timedOut: false, error: rejected };
    if (verifiersInFlight.has(sessionId)) {
      return { ran: false, exitCode: null, output: '', host: 'local', durationMs: 0, timedOut: false, error: tr('The previous check has not finished yet') };
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
    const { id } = job;
    let state = job.state;
    if (schedulesInFlight.has(id)) return;
    schedulesInFlight.set(id, state.sessionId);
    try {
      const at = nextRunAt(state) ?? Date.now();
      /* 目标型任务的 `checkCommand`：先在本机跑一次检查，没变化就到此为止（不花模型）；要叫醒的话把检查结果附在消息里 */
      let check = '';
      if (state.spec.checkCommand) {
        const checked = await runScheduleCheck(id, state);
        if (!checked) return;
        state = checked.state;
        check = checked.text;
      }
      // CHARGE THE RUN FIRST, and flush it. Recording only on completion means a process
      // killed mid-run forgets it paid -- the shape of a job that bills a turn per restart.
      const charged = recordRun(state, Date.now());
      scheduleStore.writeSchedule(id, charged, os.homedir(), store.isAdvancedOnlySession);

      /*
        **经 `wakeDispatcher` 发**：会话正忙就等这一轮结束再发（原来直接 `sendPromptOnce`，撞上忙就报错、
        白白记掉一次），作为新的一条，不进排队卡片；同一会话里几个同时到期的按到点时间逐条发。
      */
      const delivered = await wakeDispatcher.enqueue({
        sessionId: state.sessionId, text: state.spec.prompt + scheduleGoalSuffix(state, id, check), at, source: 'schedule', ref: id,
      });
      // Re-read: the user may have paused or removed the job during the turn.
      const latest = scheduleStore.readSchedule(id, os.homedir());
      if (delivered.skipped) {
        /* 排着等会话空下来的时候被删 / 暂停 / 过期了：这一次没发，记的账退回去（删掉的就什么都不用写） */
        logger.info('schedule', `run skipped id=${id} session=${state.sessionId}: ${delivered.error}`);
        if (latest) {
          /* 带检查结果的那一次没发出去：检查的结论也退回去（不然同样的输出下次会被当成「没变化」跳过，「已达成」也不会再报） */
          const back = check
            ? { ...refundRun(latest.state, state), lastCheckHash: job.state.lastCheckHash ?? null, terminal: job.state.terminal }
            : refundRun(latest.state, state);
          scheduleStore.writeSchedule(id, back, os.homedir(), store.isAdvancedOnlySession);
          mainWindow?.webContents.send('schedule:changed', { id, state: back });
        }
        return;
      }
      const failure: string | undefined = delivered.ok ? undefined : (delivered.error || tr('Send failed'));
      if (!latest) return;
      const settled = { ...latest.state, lastError: failure ?? null };
      const terminal = scheduleTerminal(settled, Date.now());
      const final = terminal ? { ...settled, terminal } : settled;
      scheduleStore.writeSchedule(id, final, os.homedir(), store.isAdvancedOnlySession);
      logger.info('schedule', `run id=${id} session=${state.sessionId} runs=${final.runs}/${final.spec.maxRuns ?? 'goal'}`
        + ` error=${failure ? JSON.stringify(failure) : 'none'} terminal=${terminal ?? 'none'}`);

      if (terminal) {
        /*
          **KiroLex 提示（`noteInSession` → `kirolex: true`），不是助手的话**：原来以 `role: 'assistant'` 落盘，
          快照 / history.md / 逐段重建都把它当成模型说过的话带过去。旧记录里那几条按开头认（`isKirolexNote`）。
          中英两版一起落盘（`scheduleEndedText` 走的是 `trIn`，`tr()` 的记账认不出来）。
        */
        noteInSession(state.sessionId, scheduleEndedText(final, terminal), {
          zh: scheduleEndedText(final, terminal, 'zh'), en: scheduleEndedText(final, terminal, 'en'),
        });
      }
      mainWindow?.webContents.send('schedule:changed', { id, state: final });
    } finally {
      schedulesInFlight.delete(id);
    }
  }

  /**
   * 目标型任务的 `checkCommand`：在**本机**跑（同 `bg_run`：同一套起进程 / 超时，cwd = 会话的本地工作目录，远程会话也不例外）。
   * 流程在 `scheduleCheckRun.ts`（有测试）：跳过的那次也广播；连续出错自动暂停时提示用户、同时照样把错误汇报交回来叫醒模型。
   */
  function runScheduleCheck(id: string, state: ScheduleState): Promise<{ state: ScheduleState; text: string } | null> {
    return runScheduleCheckWith(id, state, {
      now: () => Date.now(),
      read: (jobId) => scheduleStore.readSchedule(jobId, os.homedir())?.state ?? null,
      write: (jobId, s) => scheduleStore.writeSchedule(jobId, s, os.homedir(), store.isAdvancedOnlySession),
      runCheck: (s) => bgJobs.runCheck({
        sessionId: s.sessionId,
        command: String(s.spec.checkCommand),
        cwd: wakeHost.cwdFor(s.sessionId, os.homedir()),
        timeoutMs: BG_DEFAULT_TIMEOUT_SEC * 1000,
      }),
      changed: (jobId, s) => mainWindow?.webContents.send('schedule:changed', { id: jobId, state: s }),
      noteUser: (sid, text) => { noteInSession(sid, text); sessionNotice(sid, text); },
      log: (m) => logger.info('schedule', m),
    });
  }

  const scheduleTicker = setInterval(() => {
    // 等待退出期间不开新一轮；到期的任务留着，取消等待或重启后下一跳照样触发
    if (quitPending) return;
    const now = Date.now();
    /* advanced 会话（flow / skill）的定时任务不跑、不记账 —— 它们归 advanced 自己 */
    for (const job of scheduleStore.listSchedules(os.homedir(), store.isAdvancedOnlySession)) {
      if (expireSchedule(job, now)) continue;
      if (isDue(job.state, now)) void runScheduledJob(job);
    }
  }, SCHEDULE_TICK_MS);
  app.on('before-quit', () => clearInterval(scheduleTicker));

  /** 模型建的循环任务过了 `expiresAt`（默认 7 天）：记成 `expired`、在会话里说一声。返回是否刚过期。 */
  function expireSchedule(job: scheduleStore.StoredSchedule, now: number): boolean {
    if (job.state.terminal || schedulesInFlight.has(job.id) || scheduleTerminal(job.state, now) !== 'expired') return false;
    const final = { ...job.state, terminal: 'expired' as const };
    try { scheduleStore.writeSchedule(job.id, final, os.homedir(), store.isAdvancedOnlySession); } catch { return false; }
    logger.info('schedule', `expired id=${job.id} session=${job.state.sessionId} runs=${final.runs}/${final.spec.maxRuns ?? 'goal'}`);
    /* 目标型任务到期时明说「目标还没达成」（`scheduleEndedText`），不悄悄消失 */
    noteInSession(job.state.sessionId, scheduleEndedText(final, 'expired'));
    mainWindow?.webContents.send('schedule:changed', { id: job.id, state: final });
    return true;
  }

  /*
    唤醒真正发出去的那一下：挂回执行器（被回收了也照样发）→ `sendPromptOnce`，`announce` 让界面插进这条消息、接管这一轮的流。
    删掉 / 归档的会话不发（同 `acp:prompt` 的守卫）。
  */
  attachForControl = (sid) => ensureAttached(sid);
  wakeDeliver = async (item) => {
    const sid = item.sessionId;
    if (deletedSessionIds.has(sid)) throw new Error(tr('This session has been deleted. Nothing more will be sent to it.'));
    if (refuseAdvancedOnly(sid, 'wake')) throw new Error(tr('This session belongs to KiroLex Advanced; the standard edition does not modify it.'));
    if (store.readRecord(sid)?.archived) throw new Error(tr('This session is archived. Unarchive it to keep chatting.'));
    await ensureAttached(sid);
    if (!sessionClients.get(sid)) throw new Error(tr('Session not connected'));
    /* 挂执行器那段时间里任务可能已经被暂停 / 删除：再看一次（sendPromptOnce 里提交之前还会再看一次） */
    const stillWanted = () => (item.source === 'schedule' && item.ref
      ? scheduleDeliveryBlocker(scheduleStore.readSchedule(item.ref, os.homedir())?.state ?? null, Date.now())
      : item.source === 'nudge' ? textToolNudgeStale(item) : null);
    { const blocked = stillWanted(); if (blocked) throw new WakeSkipped(blocked); }
    /* 后台输出要进会话了：先记下来，之后这条会话的故障诊断包都不抄会话内容 */
    const nudge = item.source === 'nudge';   // 「写成文字」的纠正（handleTextToolCall）：不是后台输出，显示成 KiroLex 提示
    /* 会话间的（`source: 'session'`，别的会话的回复）也算：别人的会话内容进来了，之后的诊断包同样不抄会话内容 */
    if (item.source !== 'schedule' && !nudge) markBgOutputSeen(sid);
    /*
      **反复写成文字 → 先换新的后端会话，再续发那一步**（textToolRecovery.ts）—— 和 EmptyResponse 同一套换法，
      上下文跟着下面这条带过去（历史里那段已折叠）。后台任务 / 定时任务按 KiroLex 会话 id 投递，不受影响。
    */
    if (nudge && item.swap && !textToolSwapDone.has(item.id)) {
      await swapBackendSessionWhenIdle(sid, 'text-tool-call');
      /* 真的换成了才记一次（30 分钟上限按实际换成的算） */
      textToolRecovery.set(sid, recordAutoSwap(textToolRecovery.get(sid), Date.now()));
      /* 换完、发的那一下撞上忙被放回队头：下次只续发，不再换一次 */
      textToolSwapDone.add(item.id);
    }
    const prefix = item.source === 'schedule' ? `sched_${item.ref}` : nudge ? (item.swap ? TEXT_TOOL_SWAP_ID_PREFIX : TEXT_TOOL_NUDGE_ID_PREFIX).slice(0, -1) : `wake_${item.ref || item.source}`;
    await sendPromptOnce(sid, [{ type: 'text', text: item.text }], undefined, {
      /* 会话间的（对方的回复 / 等回复超时 / 界面没就绪时转发的那条）：id 带 `xs` 标记，落盘时记 via:'session' */
      messageId: item.source === 'session' ? controlMessageId('user', Date.now(), 'xs') : `${prefix}_${Date.now()}`,
      /* 换后端那一条在会话里带 🔀（只给你看；发给模型的是原话） */
      displayText: nudge && item.swap ? `🔀 ${item.text}` : item.text,
      announce: true,
      bgOutput: item.source !== 'schedule' && !nudge,
      ...(nudge ? { kirolexNote: true } : {}),
      stillWanted,
    }).then(() => { textToolSwapDone.delete(item.id); }, (err) => {
      if (!isWakeBusyError(err, quitPending || !!busyReasonFor(sid))) textToolSwapDone.delete(item.id);
      /* 同 acp:prompt 那层兜底：没发出去就把随行快照的标记收回，下一条照常带上历史 */
      const e = sessionClients.get(sid);
      if (e?.rideAlongUnconfirmed) { e.rideAlongUnconfirmed = false; clearContextEstablished(sid); }
      throw err;
    });
  };

  /*
    会话间 `session_send` 的 `waitReply`：重启前还在等的接着等（期限照旧）；每 2 秒看一遍对方结束了没有
    （没有登记时什么都不做）。看到了就经 wakeDispatcher 唤醒发起方。
  */
  try {
    const saved = JSON.parse(fs.readFileSync(SESSION_CALLS_FILE, 'utf-8'));
    if (Array.isArray(saved?.watches)) replyWatcher.restore(saved.watches as ReplyWatch[]);
  } catch { /* 没有文件 = 没有在等的 */ }
  const replyTicker = setInterval(() => {
    try { replyWatcher.tick(); } catch (err: any) { logger.warn('sessions', `reply watcher tick failed: ${err?.message || err}`); }
  }, 2000);
  replyTicker.unref?.();
  app.on('before-quit', () => clearInterval(replyTicker));

  /* 上次退出（或崩溃）时还在跑的后台命令 / 监视：不静默消失，在各自的会话里补一句「已中断」 */
  for (const job of takeInterruptedJobs(os.homedir())) {
    logger.info('bg', `interrupted by restart ${job.jobId} session=${job.sessionId} cmd=${job.command}`);
    noteInSession(job.sessionId, interruptedNotice(job));
  }
  /* 后台命令 / 监视随 KiroLex 退出结束（同步杀：before-quit 不会等 Promise）；登记留着，下次启动据此补「已中断」 */
  app.on('before-quit', () => bgJobs.stopAllSync());
  /* Windows：启动后稍等一下（别和窗口抢）就把作业对象辅助进程起好，第一个 bg_run / watch 不再白等 PowerShell 启动 + 编译 */
  setTimeout(() => { try { bgJobs.warmUp(); } catch (err: any) { logger.warn('bg', `job helper warm-up failed: ${err?.message || err}`); } }, 3000).unref?.();

  ipcMain.handle('bg:list', () => bgJobs.list());
  ipcMain.handle('bg:stop', (_event, jobId: string) => bgJobs.stop(String(jobId || ''), 'user'));
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
  /* local_browser：每个浏览器那一条连接 `session.end` / detach 再关（不给浏览器留 session，见 localBrowser.ts 头注释） */
  /* `createQuitGuard`：挡住第一次退出、等收尾（有上限）再真的退 —— `void` 掉的 Promise Electron 不会等 */
  app.on('before-quit', createQuitGuard({
    needed: () => !!localBrowserHost?.manager.hasConnections(),
    cleanup: () => localBrowserHost?.shutdown() ?? Promise.resolve(),
    quit: () => { isQuitting = true; app.quit(); },
    log: (m) => logger.info('browser', m),
  }));

  ipcMain.handle('schedule:create', (_event, sessionId: string, spec: ScheduleSpec) => {
    if (!sessionId || sessionId.startsWith('pending_')) return { ok: false, error: tr('Select a session that has already been created first') };
    { const advRefused = refuseAdvancedOnly(sessionId, 'schedule:create'); if (advRefused) return { ok: false, error: advRefused }; }
    const problems = validateSchedule(spec);
    if (problems.length) return { ok: false, error: problems.join(tr('; ')) };
    const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const state = newSchedule(sessionId, spec, Date.now());
    scheduleStore.writeSchedule(id, state, os.homedir(), store.isAdvancedOnlySession);
    logger.info('schedule', `created id=${id} session=${sessionId} ${describeSchedule(spec)} maxRuns=${spec.maxRuns}`);
    // Announced like every other mutation: the window that created the job learns of it the
    // same way as any other, so its banner appears without a reload. The end of a RUN used to
    // be the only broadcast, which left create/pause/remove invisible until the next reload.
    mainWindow?.webContents.send('schedule:changed', { id, state });
    return { ok: true, id, nextRunAt: nextRunAt(state), describe: describeSchedule(spec) };
  });

  ipcMain.handle('schedule:list', () => scheduleStore.listSchedules(os.homedir(), store.isAdvancedOnlySession).map((job) => ({
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
    createdBy: job.state.createdBy ?? null,
    expiresAt: job.state.expiresAt ?? null,
    until: job.state.spec.until ?? null,
    checkCommand: job.state.spec.checkCommand ?? null,
  })));

  ipcMain.handle('schedule:pause', (_event, id: string, paused: boolean) => {
    const job = scheduleStore.readSchedule(id, os.homedir());
    if (!job) return { ok: false, error: tr('This scheduled task was not found') };
    { const advRefused = refuseAdvancedOnly(job.state.sessionId, 'schedule:pause'); if (advRefused) return { ok: false, error: advRefused }; }
    /* 用户按的暂停 / 继续：清掉「检查出错自动暂停」的标记（那种暂停下排着的错误汇报才照发） */
    const state = { ...job.state, paused, pausedBy: null };
    scheduleStore.writeSchedule(id, state, os.homedir(), store.isAdvancedOnlySession);
    /* 正排着等会话空下来的那一次也撤掉 */
    if (paused) wakeDispatcher.dropRef(id, 'paused');
    logger.info('schedule', `${paused ? 'paused' : 'resumed'} id=${id}`);
    mainWindow?.webContents.send('schedule:changed', { id, state });
    return { ok: true };
  });

  /**
   * 聊天顶部那条定时任务上的「⏳ 延长…」弹层：延长多久由用户定 —— `{ mode:'extend', ms }` / `{ mode:'until', at }` / `{ mode:'never' }`。
   * 只有**用户**能设成不过期、也没有 30 天上限（那只约束模型的 `expiresInDays`）。计算和校验在 `computeScheduleExpiry`。
   */
  ipcMain.handle('schedule:set-expiry', (_event, id: string, change: unknown) => {
    const job = scheduleStore.readSchedule(id, os.homedir());
    if (!job) return { ok: false, error: tr('This scheduled task was not found') };
    { const advRefused = refuseAdvancedOnly(job.state.sessionId, 'schedule:set-expiry'); if (advRefused) return { ok: false, error: advRefused }; }
    const computed = computeScheduleExpiry(job.state, change, Date.now());
    if ('error' in computed) return { ok: false, error: computed.error };
    const { expiresAt } = computed;
    const state = { ...job.state, expiresAt };
    scheduleStore.writeSchedule(id, state, os.homedir(), store.isAdvancedOnlySession);
    logger.info('schedule', `expiry ${String((change as any)?.mode)} id=${id} expiresAt=${expiresAt ?? 'never'}`);
    mainWindow?.webContents.send('schedule:changed', { id, state });
    return { ok: true, expiresAt };
  });

  ipcMain.handle('schedule:remove', (_event, id: string) => {
    { const owner = scheduleStore.readSchedule(id, os.homedir())?.state.sessionId;
      const advRefused = owner ? refuseAdvancedOnly(owner, 'schedule:remove') : null; if (advRefused) return { ok: false, error: advRefused }; }
    scheduleStore.removeSchedule(id, os.homedir(), store.isAdvancedOnlySession);
    wakeDispatcher.dropRef(id, 'removed');
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'loop:persist'); if (advRefused) return { ok: false, error: advRefused }; }
    try {
      loopStore.writeLoop(sessionId, run, os.homedir(), store.isAdvancedOnlySession);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'persist failed' };
    }
  });

  /** Charge a round against the DURABLE counter and checkpoint it before it is sent.
   *  The renderer must call this instead of counting locally, or the count goes back to
   *  being per-window. */
  ipcMain.handle('loop:begin-round', (_event, sessionId: string) => {
    { const advRefused = refuseAdvancedOnly(sessionId, 'loop:begin-round'); if (advRefused) return { run: null, terminal: null, error: advRefused }; }
    const result = loopStore.beginRound(sessionId, os.homedir(), Date.now(), store.isAdvancedOnlySession);
    if (result.run) {
      logger.info('loop', `round sessionId=${sessionId} iteration=${result.run.iteration}`
        + `/${result.run.spec.stop.maxIterations} terminal=${result.terminal ?? 'none'}`);
    }
    return result;
  });

  ipcMain.handle('loop:read', (_event, sessionId: string) => loopStore.readLoop(sessionId, os.homedir()));
  /* advanced 会话的循环不交给标准版去续跑（它们的会话标准版本来就看不见、也发不进去） */
  ipcMain.handle('loop:list-live', () => loopStore.listLiveLoops(os.homedir()).filter((r) => !store.isAdvancedOnlySession(r.sessionId)));
  ipcMain.handle('loop:clear', (_event, sessionId: string) => {
    { const advRefused = refuseAdvancedOnly(sessionId, 'loop:clear'); if (advRefused) return { ok: false, error: advRefused }; }
    loopStore.clearLoop(sessionId, os.homedir(), store.isAdvancedOnlySession);
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
      return { ran: false, exitCode: null, output: '', error: tr('Refused: this check command is not declared in the flow') };
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
  /**
   * `/clear` 的水位线落盘 —— 这个时刻之前的消息不再算这条会话的历史（判据见 `SessionRecord.clearedAt`）。
   * 输入框里打的 `/clear` 走这里；复用会话前自动清的那一下见下面的 `acp:clear-context`。
   * transcript 一个字节都不删。
   */
  ipcMain.handle('acp:mark-cleared', async (_event, sessionId: string) => {
    if (!sessionId?.trim()) return { ok: false, error: tr('No session specified') };
    { const advRefused = refuseAdvancedOnly(sessionId, 'mark-cleared'); if (advRefused) return { ok: false, error: advRefused }; }
    const rec = store.readRecord(sessionId);
    if (!rec) return { ok: false, error: tr('No such session') };
    const at = Date.now();
    store.writeRecord({ ...rec, clearedAt: at });
    // 水位线之后历史变短了：下一次该按新的历史重建，而不是继续认为后端里装着那份旧的
    clearContextEstablished(sessionId);
    logger.info('session', `clear watermark set sessionId=${sessionId} at=${at}`);
    return { ok: true, clearedAt: at };
  });

  ipcMain.handle('acp:clear-context', async (_event, sessionId: string) => {
    if (!sessionId?.trim()) return { ok: false, error: tr('No session specified') };
    { const advRefused = refuseAdvancedOnly(sessionId, 'clear-context'); if (advRefused) return { ok: false, error: advRefused }; }
    try {
      await sendPromptOnce(sessionId, [{ type: 'text', text: '/clear' }], undefined, {
        messageId: `flow_clear_${Date.now()}`,
      });
      // 后端清掉了，KiroLex 这侧的历史水位线也要跟上 —— 否则下一次重建又把它喂回去
      const rec = store.readRecord(sessionId);
      if (rec) store.writeRecord({ ...rec, clearedAt: Date.now() });
      clearContextEstablished(sessionId);
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
  /**
   * 渲染层的项目名里，哪些是 **KiroLex Advanced 专属的项目**（flow 项目）—— 侧栏、项目菜单、「移到项目」、
   * 新建会话选项目、设置里的项目列表都按它过滤。只回答，不改任何东西：共享的 `kirolex-projects` 列表原样留着。
   */
  ipcMain.handle('app:advanced-only-projects', async (_event, names: unknown) =>
    [...store.advancedOnlyProjectsAmong(Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [])]);

  ipcMain.handle('project:get-workspace', async (_event, project: string) => ({
    workspace: projectStore.readProject(os.homedir(), project).workspace || '',
  }));

  ipcMain.handle('project:set-workspace', async (_event, project: string, workspace: string) => {
    { const advRefused = refuseAdvancedProject(project, 'set-workspace'); if (advRefused) return { ok: false, error: advRefused }; }
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
    if (!sessionId?.trim()) return { ok: false, error: tr('No session id') };
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: tr('The main window is not open') };
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
      title: tr('Run · {id}', { id }),
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'delete'); if (advRefused) return { ok: false, error: advRefused }; }
    /* 没建成就删了：失败记录和创建参数一起作废 */
    creations.clearFailed(sessionId);
    newSessionArgs.delete(sessionId);
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
    pendingSwitches.cancel(sessionId); // 删掉的会话不再应用欠着的切换
    /* 它的后台命令 / 监视一起停掉，排着没发的唤醒作废 */
    void bgJobs.stopSession(sessionId);
    wakeDispatcher.drop(sessionId, 'session deleted');
    /* 它发出去、还在等回复的那几条不再等（对方那边由 ReplyWatcher 自己发现「对方被删了」） */
    replyWatcher.dropFrom(sessionId);
    // Durable tombstone FIRST: `deletedSessionIds` is in-memory only, so if the
    // directory cannot be removed right now (kiro-cli may still hold the
    // transcript open — disconnect is asynchronous) the chat used to come back on
    // the next boot. The tombstone hides it and gets the removal retried.
    addSessionTombstone(sessionId);
    // 带时间的删除记录（不随墓碑清掉）：别的机器同步时据此认出「这条是被删掉的」，见 cloudTrash.ts
    noteDeletion(S3_DELETED_AT_PATH, sessionId, Date.now());
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'delete'); if (advRefused) return { ok: false, error: advRefused, cascaded: [] }; }
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
        if (!target?.sshHost) throw new Error(tr('Machine not found ({machine}). Was it removed in Settings?', { machine }));
        const bin = remoteKiroBin(target);
        if (!bin) throw new Error(tr('No kiro launch command is set for {host} yet (Settings → 🖥 Machines).', { host: target.sshHost }));
        const out = await runRemoteCapture(target, `${shellQuote(bin)} agent list 2>&1`)
          .catch((err) => { throw new Error(tr('Could not get the agent list from {host}: {err}', { host: target.sshHost, err: String(err?.message || err) })); });
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
      return { error: tr('Invalid Agent name.') };
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
      : { error: source === 'global' ? tr('No global configuration file was found for {name}.', { name: agentName })
        : source === 'local' ? tr('No local configuration file was found for {name}.', { name: agentName })
        : tr('No local or global configuration file was found for {name}.', { name: agentName }) };
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
    (t ? (labelForHost(KIROLEX_CONFIG_PATH, t.sshHost) || t.sshHost) : tr('This computer'));

  ipcMain.handle('kiro:config-categories', (_event, engine?: string) =>
    /* RegExp 过不了 IPC，渲染层也用不到它。按会话的引擎给 tab（不传 = kiro，和原来一样） */
    kiroCategoriesFor(engineOf({ engine })).map(({ match: _m, ...rest }) => rest));

  ipcMain.handle('kiro:config-list', async (_event, sessionId: string | undefined, category: string) => {
    const spec = categorySpec(category);
    if (!spec) return { ok: false, error: tr('Unknown category {category}', { category }) };
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
    if (!spec) return { ok: false, error: tr('Unknown category {category}', { category }) };
    const target = kiroConfigTargetFor(sessionId);
    try {
      if (!target) {
        const r = new LocalKiroConfig(os.homedir()).read(spec, name);
        return 'error' in r ? { ok: false, error: r.error } : { ok: true, ...r, where: kiroConfigWhere() };
      }
      const rel = relPath(spec, name);
      if (!rel) return { ok: false, error: tr('Invalid name.') };
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
    if (!spec) return { ok: false, error: tr('Unknown category {category}', { category }) };
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
      if (!rel) return { ok: false, error: tr('Invalid name.') };
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
      if (!/^[A-Za-z0-9_.-]+$/.test(agentName)) return { opened: false, error: tr('Invalid Agent name.') };
      if (source === 'built-in') return { opened: false, error: tr('{name} is built in and cannot be edited.', { name: agentName }) };
      try {
        const got = await runRemoteCapture(remoteT, remoteAgentFindScript(agentName), 30_000);
        const m = /^PATH (.+)$/m.exec(got);
        if (!m) return { opened: false, error: tr('{where} has no config file for {name} (~/.kiro/agents).', { where: kiroConfigWhere(remoteT), name: agentName }) };
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
      return { saved: false, error: tr('Invalid JSON: {err}', { err: error?.message || String(error) }) };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { saved: false, error: tr('Agent configuration must be a JSON object.') };
    }

    const remoteT = kiroConfigTargetFor(sessionId);
    if (remoteT) {
      if (!/^[A-Za-z0-9_.-]+$/.test(agentName) || source === 'built-in') return { saved: false, error: tr('This agent cannot be edited.') };
      try {
        const got = await runRemoteCapture(remoteT, remoteAgentFindScript(agentName), 30_000);
        const m = /^PATH (\.kiro\/agents\/[^\n/]+\.json)$/m.exec(got);
        if (!m) return { saved: false, error: tr('Could not find the config file for {name} on {where}.', { where: kiroConfigWhere(remoteT), name: agentName }) };
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
  /*
    **新建时选的引擎和机器也要进这份记录** —— 原来只带 projectId，一条「远程 Codex」的新会话
    （远端没装适配器、没建成）右键换个目录就悄悄成了本机 kiro（s_1792637464721_r0sfi7）。
    先用主进程自己记下的（`newSessionIntents`），再用渲染层 hint 带的；都没有就明说（`coldProfileBits`）。
  */
  const coldRecordFor = (sessionId: string, hint?: ColdRecordHint): store.SessionRecord | null => {
    const existing = store.readRecord(sessionId);
    if (existing) return existing;
    if (!/^s_[\w-]+$/.test(sessionId)) return null;
    if (deletedSessionIds.has(sessionId) || loadSessionTombstones().includes(sessionId)) return null;
    const bits = coldProfileBits(newSessionIntents.get(sessionId), hint, (id) => findRemoteTarget(KIROLEX_CONFIG_PATH, id));
    const engine = bits.engine;
    const profile: AgentProfile = {
      model: engine === 'kiro' ? DEFAULT_MODEL : 'default',
      preferredModel: engine === 'kiro' ? DEFAULT_MODEL : 'default',
      permissionMode: 'auto-approve',
      /* KiroLex Advanced 专属的 flow 项目不放进去：建成未分组 */
      ...(bits.projectId && !refuseAdvancedProject(bits.projectId, 'cold-record') ? { projectId: bits.projectId } : {}),
      ...(engine !== 'kiro' ? { engine } : {}),
      ...(bits.remote ? { remote: { ...bits.remote } } : {}),
    };
    logger.info('session', `新会话还没有记录（没连上过），切换前先建一份 sessionId=${sessionId} project=${bits.projectId || '(无)'} engine=${engine} remote=${bits.remote?.sshHost || 'local'} 来源=${bits.source}${bits.lost ? '（补不全）' : ''}`);
    const rec = store.createSession(sessionId, profile);
    if (bits.remoteMissing) {
      sessionNotice(sessionId, tr('⚠ This new chat was created for remote target {id}, which is no longer in your settings. It was saved as a local session.', { id: bits.remoteMissing }));
    } else if (bits.lost) {
      sessionNotice(sessionId, tr('⚠ KiroLex could not tell which engine / machine this new chat was created with, so it was saved as {engine} on {where}. Switch it in the right-click menu if that is wrong.', {
        engine: ENGINE_LABEL[engine],
        where: bits.remote ? String(labelForHost(KIROLEX_CONFIG_PATH, bits.remote.sshHost) || bits.remote.sshHost) : tr('the local machine'),
      }));
    }
    return rec;
  };

  /* 机器的 id 也随 `session:targets-changed` 发过去（审计 10b）：渲染层的会话行要它，分叉时才知道在哪台机器上建 */
  const remoteIdOf = (t?: RemoteTarget): string | null => ((t as { id?: string } | undefined)?.id || null);

  const applySessionTarget = async (
    sessionId: string,
    target: RemoteTarget | undefined,
    localDir?: string,
    hint?: ColdRecordHint,
  ): Promise<{ ok: boolean; unchanged?: boolean; remoteHost?: string | null; cold?: boolean }> => {
    /* 先等在飞的 attach 落定：它按旧记录在本机起，不等的话徽标是远端、执行器是本机（见 attachGate.ts） */
    await settleInFlightAttach(attachInFlight, sessionId);
    const oldEntry = sessionClients.get(sessionId);
    /*
      **右键菜单优先于正在跑的任务** ——「这些右键菜单应该优先级大于正在跑的任务」。

      换机器必然换执行器，所以那一轮确实会断。上一版为此直接拒绝，结果一条长回合跑着的时候
      什么都做不了 —— 而那正是你想改设置的时候。现在照做，只是**明确告诉你那一轮被打断了**：
      对话内容一条不丢（transcript 已经落盘），断掉的只是这一轮还没产出的部分。
    */
    const interrupted = !!oldEntry?.busy;
    if (reconfiguringSessions.has(sessionId)) throw new Error(tr('The previous switch has not finished yet. Give it a moment.'));

    const rec0 = oldEntry ? store.readRecord(sessionId) : coldRecordFor(sessionId, hint);
    if (!oldEntry && !rec0) throw new Error(tr('Could not find the record for this session.'));
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
      adapterNotes.forgetPinned(sessionId);   // 旧机器的钉住提示
      const where = target ? tr('remote machine {host}', { host: String(hostLabelOf(target)) }) : tr('the local machine');
      sessionNotice(sessionId, trConcat(
        tr('🔀 This session now runs on **{where}** (working directory `{dir}`); it connects there next time.', { where, dir: nextLocalDir }),
        NOTE_DETAIL_SEP,
        tr('The conversation is unchanged.')));
      logger.info('remote', `切换目标（未连接）sessionId=${sessionId} -> ${target?.sshHost || '本地'}`);
      /* 渲染层收到后发现它没连着，会按新记录立刻 attach（见 useAcp 的 reconnectAfterRetarget） */
      mainWindow?.webContents.send('session:targets-changed', { sessionId, remoteHost: hostLabelOf(target), remoteId: remoteIdOf(target), localDir: nextLocalDir });
      return { ok: true, remoteHost: hostLabelOf(target), cold: true };
    }

    await awaitAttachIdle(sessionId);
    reconfiguringSessions.add(sessionId);
    emitSessionBusy(sessionId);
    const profile: AgentProfile = { ...oldEntry.profile, remote: target ? { ...target } : undefined };
    adapterNotes.forgetPinned(sessionId);   // 旧机器的起法说明不再是现状；新机器要的话下面的探测重新钉上
    try {
      if (target) {
        if (engineOf(profile) !== 'kiro') {
          await remoteAdapterCheck(profile.remote!, engineOf(profile) as 'claude' | 'codex', sessionId);
        } else {
          const models = await remotePreflight(profile.remote!);
          profile.model = pickRemoteModel(sessionId, firstWantedModel(profile, machineKeyOf(profile), MODEL_FALLBACK_ORDER), models, profile.remote!.sshHost || '');
        }
      }
      /* 换机器 = 换进程 = 后端是空的：起一条**新的**后端会话，上下文按既有那条路重建 */
      const cliCwd = sessionCwd(profile, nextLocalDir);
      const localTools = await ensureLocalTools(sessionId, profile, nextLocalDir);
      const client = new AcpClient(profile.model, shellEnv, profile.kiroAgent, profile.permissionMode, profile.remote, localTools, engineOf(profile));
      try {
        await client.connect();
        /* 远端没有你选的模型（pickRemoteModel 挑了备用的）：连上了才说，说的是实际起来的那个 */
        /* 先记下（真正写要等下面换上执行器、写好记录之后 —— session/new 失败就作废） */
        if (target && engineOf(profile) === 'kiro') modelFallback.remoteStarted(sessionId, profile.model);
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
        try { await retireExecutor(oldEntry.client); } catch { /* 旧的已经没用了 */ }
        sessionClients.set(sessionId, nextEntry);
        wireSession(sessionId, nextEntry);
        /*
          **远程 → 本地：旧的转发通道收掉** —— 本地那条路不走 setProxies，不收的话上一台机器那批中转代理
          和本机起的进程（playwright 的浏览器）要一直留到会话结束。放在 set 之后：关复用连接看的是"还有没有会话在那台机器上"。
        */
        if (!target && oldEntry.profile.remote?.sshHost) releaseLocalTools(sessionId, oldEntry.profile.remote, { keepToken: true });

        const rec = store.readRecord(sessionId) || store.createSession(sessionId, profile);
        rec.profile = profile;
        rec.cliSessionId = made.sessionId;
        rec.localDir = nextLocalDir;
        rec.executorState = 'attached';
        store.writeRecord(rec);
        clearContextEstablished(sessionId);
        markContextOwedIfUnverified(sessionId, 'switch-remote-target');
        restoreContextAfterExecutorSwap(sessionId, 'switch-remote-target');
        modelFallback.commit(sessionId);   // 换成了：记下的「改用了备用模型」现在写

        const where = target ? tr('remote machine {host}', { host: String(hostLabelOf(target)) }) : tr('the local machine');
        const carryOver = wakeCarryOverFor(sessionId);
        /* 主句：换到哪（被打断的那一轮也在主句里 —— 它影响结果）；后端会话是新的、对话记录不变 → 详情 */
        sessionNotice(sessionId, trConcat(
          tr('🔀 This session now runs on **{where}** (working directory `{dir}`).', { where, dir: nextLocalDir }),
          interrupted ? `\n${tr('(The switch interrupted the running turn; its output so far is kept. Resend if you need the rest.)')}` : '',
          carryOver ? `\n${carryOver}` : '',
          NOTE_DETAIL_SEP,
          tr('The backend session is new; the context goes along with your next message. The conversation is unchanged.')));
        logger.info('remote', `切换目标 sessionId=${sessionId} -> ${target?.sshHost || '本地'} dir=${nextLocalDir}`);
        mainWindow?.webContents.send('session:targets-changed', { sessionId, remoteHost: hostLabelOf(target), remoteId: remoteIdOf(target), localDir: nextLocalDir });
        return { ok: true, remoteHost: hostLabelOf(target) };
      } catch (err) {
        try { await client.disconnect(); } catch {}
        modelFallback.discard(sessionId);   // 没换成（session/new 等失败）：连上时记下的那句作废
        /*
          **新执行器没起来，旧的工具 token 也已经换掉了**（`ensureLocalTools` 登记新 token 时旧的作废）——
          留着旧执行器就是一条 bg_run / local_* 全部不可用的会话（同切换组合失败那条路）。没在跑一轮就收掉它：
          记录里还是原来的位置，下一条消息按原位置重新接上，工具通道跟着重建。
        */
        if (sessionClients.get(sessionId) === oldEntry && !oldEntry.busy) {
          logger.warn('remote', `切换目标失败，旧执行器的工具连接已作废，收掉它 sessionId=${sessionId}`);
          void detachExecutor(sessionId);
        }
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
    hint?: ColdRecordHint,
  ) => {
    { const advRefused = refuseAdvancedOnly(sessionId, 'set-remote-target'); if (advRefused) throw new Error(advRefused); }
    const target = remoteId ? findRemoteTarget(KIROLEX_CONFIG_PATH, remoteId) : undefined;
    if (remoteId && !target) throw new Error(tr('Remote target {id} not found (was it removed in Settings?). KiroLex did not guess a machine.', { id: remoteId }));
    /*
      这一轮还在跑：记下来，跑完再换机器 / 目录。原来是照做并打断那一轮（「右键菜单优先于正在跑的任务」），
      现在不打断也不拒绝 —— 那一轮跑完立刻切过去。
    */
    {
      const where = target ? (labelForHost(KIROLEX_CONFIG_PATH, target.sshHost) || target.sshHost || remoteId || '') : tr('This computer');
      const queued = queueSwitchWhileBusy(sessionId, 'remote', { remoteId: remoteId || null, localDir, hint }, localDir ? `${where} · ${localDir}` : where);
      if (queued) return queued;
    }
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
  const engineKindFor = (category: EngineOptionCategory): PendingKind =>
    (category === 'model' ? 'engineModel' : category === 'thought_level' ? 'engineEffort' : category === 'collaboration_mode' ? 'engineCollab' : 'engineMode');
  const setEngineOption = async (sessionId: string, category: EngineOptionCategory, value: string, fromPending?: boolean): Promise<any> => {
    { const advRefused = refuseAdvancedOnly(sessionId, 'set-engine-option'); if (advRefused) throw new Error(advRefused); }
    /* 这一轮还在跑、或者上一批 pending 正在应用（执行器可能刚被拿掉）：记下来，落定后再设（同一类只留最后一次） */
    const queued = queueSwitchWhileBusy(sessionId, engineKindFor(category), { category, value }, value, fromPending);
    if (queued) return queued;
    const entry = sessionClients.get(sessionId);
    if (!entry) throw new Error(tr('This session is not connected right now. Switch after it connects (click it or send a message to reconnect).'));
    const engine = engineOf(entry.profile);
    if (engine === 'kiro') throw new Error(tr('kiro sessions do not go through this path'));
    await entry.client.setSelectOption(entry.cliSessionId, category, value);
    /*
      **换了模型，组合里的 effort 跟着重新对一遍**（审计 1b）—— 换到不支持 effort 的模型（haiku）时不硬塞、不报错；
      换回支持的模型时把组合要的档位设回去（适配器换模型会带回它自己的默认档位）。失败只记日志，不挡这次换模型。
    */
    if (category === 'model') {
      const combo = pickCombo(readMcpCombos(os.homedir()).combos, entry.profile.mcpCombo);
      if (combo.effort && modelOffersEffort(entry.client.selectOptions('thought_level'))) {
        try {
          const r = await applyComboEffort(combo.effort, combo.name, {
            options: () => entry.client.selectOptions('thought_level'),
            set: (v) => entry.client.setSelectOption(entry.cliSessionId, 'thought_level', v),
          });
          logger.info('mcp-combo', `换到 ${value}：组合「${combo.name}」effort -> ${r.value || '(未变)'} sessionId=${sessionId}`);
          if (r.notice) sessionNotice(sessionId, r.notice);
        } catch (err) {
          logger.warn('mcp-combo', `换模型后重设组合 effort 失败 sessionId=${sessionId}`, err);
        }
      } else if (combo.effort) {
        logger.info('mcp-combo', `换到 ${value}：当前模型不支持 effort，组合「${combo.name}」的 effort=${combo.effort} 暂不生效 sessionId=${sessionId}`);
      }
    }
    entry.profile = category === 'model'
      /* 适配器刚接受了它 = 「上次成功用的」（记住的那个以后在别处没有时先退回它，`pickEngineModel`） */
      ? { ...entry.profile, engineModels: { ...entry.profile.engineModels, [engine]: value }, engineModelsUsed: { ...entry.profile.engineModelsUsed, [engine]: value } }
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
    /* Codex 的「Plan」开关（协作模式 default / plan）：Plan 模式下它才能用 request_user_input 向你提问 */
    if (category === 'collaboration_mode') return setEngineOption(sessionId, category, value);
    if (category !== 'thought_level' && category !== 'mode') throw new Error(tr('Unknown option {category}', { category }));
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
    sessionId: string, patch: Partial<AgentProfile>, what: string, onlyKiro?: string, notKiro?: string,
  ): { ok: true; dormant: true } => {
    const rec = store.readRecord(sessionId);
    if (!rec) throw new Error(tr('This session does not exist on disk (it may have been deleted).'));
    if (onlyKiro && engineOf(rec.profile) !== 'kiro') throw new Error(onlyKiro);
    /* 反过来：「组合」只对 Claude Code / Codex 会话有用 */
    if (notKiro && engineOf(rec.profile) === 'kiro') throw new Error(notKiro);
    rec.profile = { ...rec.profile, ...patch };
    store.writeRecord(rec);
    logger.info('acp', `${what} on dormant session ${sessionId} —— 下次挂起时生效`);
    return { ok: true, dormant: true };
  };

  const switchModelImpl = async (sessionId: string, model: string, fromPending?: boolean): Promise<any> => {
    { const advRefused = refuseAdvancedOnly(sessionId, 'switch-model'); if (advRefused) throw new Error(advRefused); }
    const oldEntry = sessionClients.get(sessionId);
    /* 模型下拉是 kiro 的清单；Claude Code / Codex 用它们自己 CLI 配的模型（界面上也不显示这个下拉） */
    const notKiroModel = (p: AgentProfile) => tr('The model of a {engine} session is configured in its own CLI; it cannot be switched here yet.', { engine: ENGINE_LABEL[engineOf(p)] });
    if (oldEntry && engineOf(oldEntry.profile) !== 'kiro') throw new Error(notKiroModel(oldEntry.profile));
    const normalizedModel = model.trim() || DEFAULT_MODEL;
    /* 忙、或者上一批 pending 正在应用（那次重连会先把执行器拿掉）：先登记，别掉进下面"没连着只写记录"那条路 ——
       那样写下的记录会被正在进行的那次重连用旧 profile 盖掉。登记的这一次在那一批落定后接着应用。 */
    { const queued = queueSwitchWhileBusy(sessionId, 'model', { model: normalizedModel }, normalizedModel, fromPending); if (queued) return { ...queued, model: normalizedModel }; }
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
    if (reconfiguringSessions.has(sessionId)) throw new Error(tr('Another model, Agent, or permission change is still in progress.'));

    if (oldEntry.profile.model === normalizedModel) return { ok: true, model: normalizedModel, unchanged: true };

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
        sessionNotice(sessionId, tr('⚠️ The model switch failed and so did the rollback; this session is disconnected. Click it to reconnect.'));
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
    try { await retireExecutor(oldEntry.client); } catch {}

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
  };
  ipcMain.handle('acp:switch-model', (_event, sessionId: string, model: string) => switchModelImpl(sessionId, model));


  // Auto/Ask is handled at the ACP permission-request boundary, so it can be
  // changed instantly without replacing the executor or reloading the session.
  const switchPermissionModeImpl = async (
    sessionId: string,
    permissionMode: 'auto-approve' | 'ask',
    fromPending?: boolean,
  ): Promise<any> => {
    { const advRefused = refuseAdvancedOnly(sessionId, 'switch-permission-mode'); if (advRefused) throw new Error(advRefused); }
    const entry = sessionClients.get(sessionId);
    const normalizedMode = permissionMode === 'ask' ? 'ask' : 'auto-approve';
    /* 忙、或者上一批 pending 正在应用（那次重连会先把执行器拿掉）：先登记，别掉进下面"没连着只写记录"那条路 ——
       那样写下的记录会被正在进行的那次重连用旧 profile 盖掉。登记的这一次在那一批落定后接着应用。 */
    { const queued = queueSwitchWhileBusy(sessionId, 'permission', { permissionMode: normalizedMode }, normalizedMode, fromPending); if (queued) return { ...queued, permissionMode: normalizedMode }; }
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
  };
  ipcMain.handle('acp:switch-permission-mode', (_event, sessionId: string, permissionMode: 'auto-approve' | 'ask') =>
    switchPermissionModeImpl(sessionId, permissionMode));

  // kiro-cli binds --agent at process launch, so changing agents requires a
  // fresh executor. Start the replacement first; only swap it into the live
  // map after it is ready, then disconnect the old executor. This avoids a
  // failed switch taking down an otherwise healthy session. The visible chat
  // and durable transcript remain; the selected agent starts fresh context and
  // receives the normal layered-memory injection on its next prompt.
  const switchKiroAgentImpl = async (sessionId: string, agentName: string, fromPending?: boolean): Promise<any> => {
    { const advRefused = refuseAdvancedOnly(sessionId, 'switch-agent'); if (advRefused) throw new Error(advRefused); }
    const oldEntry = sessionClients.get(sessionId);
    const normalizedAgent = agentName.trim() || undefined;
    /* 忙、或者上一批 pending 正在应用（那次重连会先把执行器拿掉）：先登记，别掉进下面"没连着只写记录"那条路 ——
       那样写下的记录会被正在进行的那次重连用旧 profile 盖掉。登记的这一次在那一批落定后接着应用。 */
    { const queued = queueSwitchWhileBusy(sessionId, 'agent', { agentName: normalizedAgent || '' }, normalizedAgent || 'kiro_default', fromPending); if (queued) return { ...queued, kiroAgent: normalizedAgent || '' }; }
    /* 休眠：`--agent` 是启动执行器时才绑的，所以现在只需要记下"下次用哪个"（见 `setDormantProfile`） */
    if (!oldEntry) {
      return {
        ...setDormantProfile(sessionId, { kiroAgent: normalizedAgent }, `agent -> ${normalizedAgent || '(default)'}`, tr('A kiro agent only applies to Kiro sessions.')),
        kiroAgent: normalizedAgent || '',
      };
    }
    if (engineOf(oldEntry.profile) !== 'kiro') throw new Error(tr('A kiro agent only applies to Kiro sessions.'));
    if (reconfiguringSessions.has(sessionId)) throw new Error(tr('Another model, Agent, or permission change is still in progress.'));

    if (oldEntry.profile.kiroAgent === normalizedAgent) {
      return { ok: true, kiroAgent: normalizedAgent || '', unchanged: true };
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
      try { await retireExecutor(oldEntry.client); } catch {}

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
  };
  ipcMain.handle('acp:switch-kiro-agent', (_event, sessionId: string, agentName: string) => switchKiroAgentImpl(sessionId, agentName));

  /**
   * **给已有的会话换引擎** ——「我还需要现有会话也能切换 agent 运行类型」。
   *
   * 和换机器 / 换 kiro agent 同一套机械：先起新的、再断旧的，后端会话是新的，上下文从 KiroLex
   * 自己的记录重建（随下一条消息带过去）。对话一条都不动。没连着的会话只改记录 —— 下次打开时
   * 按新引擎起（和「运行位置」那条路一样，「没连上也应该能切」）。
   */
  /* kiro 的模型 id / agent 对另外两家没意义；切回 kiro 时用你选过的偏好模型；各引擎记住的模型互不覆盖（engineModelPick.ts） */
  const reshapeForEngine = (p: AgentProfile, engine: Engine): AgentProfile => reshapeProfileForEngine(p, engine, DEFAULT_MODEL);
  const switchEngineImpl = async (sessionId: string, engineArg: string, hint?: ColdRecordHint, fromPending?: boolean): Promise<any> => {
    { const advRefused = refuseAdvancedOnly(sessionId, 'switch-engine'); if (advRefused) throw new Error(advRefused); }
    const engine = engineOf({ engine: engineArg });
    const label = ENGINE_LABEL[engine];
    const oldEntry = sessionClients.get(sessionId);
    /* 这一轮还在跑：记下来，跑完再换（选回原来的引擎也照记 —— 它会顶掉之前记下的那一次） */
    { const queued = queueSwitchWhileBusy(sessionId, 'engine', { engine, hint }, label, fromPending); if (queued) return { ...queued, engine }; }
    /* 没连着、也还没有记录的新会话：先建一份（见 coldRecordFor） */
    const rec0 = oldEntry ? store.readRecord(sessionId) : coldRecordFor(sessionId, hint);
    const before = engineOf(oldEntry?.profile || rec0?.profile);
    if (before === engine) return { ok: true, unchanged: true, engine };
    const reshape = (p: AgentProfile): AgentProfile => reshapeForEngine(p, engine);

    if (!oldEntry) {
      if (!rec0) throw new Error(tr('Could not find the record for this session.'));
      rec0.profile = reshape(rec0.profile);
      store.writeRecord(rec0);
      /* 旧引擎那句钉住的起法说明不再是现状（同换机器） */
      adapterNotes.forgetPinned(sessionId);
      sessionNotice(sessionId, tr('🔀 This session will run on **{engine}** the next time it opens.', { engine: label }));
      mainWindow?.webContents.send('session:engine-changed', { sessionId, engine });
      logger.info('engine', `切换引擎（未连接）sessionId=${sessionId} ${ENGINE_LABEL[before]} -> ${label}`);
      return { ok: true, engine, cold: true };
    }
    if (reconfiguringSessions.has(sessionId)) throw new Error(tr('Another switch (model / agent / machine) has not finished yet.'));

    await awaitAttachIdle(sessionId);
    reconfiguringSessions.add(sessionId);
    emitSessionBusy(sessionId);
    const profile = reshape(oldEntry.profile);
    let client: AcpClient | undefined;
    let remoteModels: string[] | undefined;
    /* 旧引擎那句钉住的起法说明撤掉；新引擎要的话下面的探测重新钉上 */
    adapterNotes.forgetPinned(sessionId);
    try {
      if (profile.remote?.sshHost) {
        if (engine !== 'kiro') await remoteAdapterCheck(profile.remote, engine, sessionId);
        else {
          remoteModels = await remotePreflight(profile.remote);
          profile.model = pickRemoteModel(sessionId, firstWantedModel(profile, machineKeyOf(profile), MODEL_FALLBACK_ORDER), remoteModels, profile.remote.sshHost || '');
        }
      }
      const localTools = await ensureLocalTools(sessionId, profile, localProjectDirOf(sessionId, oldEntry));
      const started = await connectWithModelFallback(profile, 'switch-engine', localTools, sessionId, remoteModels);
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
      try { await retireExecutor(oldEntry.client); } catch { /* 旧的已经没用了 */ }
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
      modelFallback.commit(sessionId);   // 换成了：记下的「改用了备用模型」现在写
      sessionNotice(sessionId, tr('🔀 This session now runs on **{engine}**; the context goes along with your next message.', { engine: label }));
      mainWindow?.webContents.send('session:engine-changed', { sessionId, engine });
      logger.info('engine', `切换引擎 sessionId=${sessionId} ${ENGINE_LABEL[before]} -> ${label}`);
      return { ok: true, engine };
    } catch (err) {
      if (client) { try { await client.disconnect(); } catch {} }
      modelFallback.discard(sessionId);   // 没换成：连上时记下的那句作废
      logger.warn('engine', `切换引擎失败 sessionId=${sessionId} ${ENGINE_LABEL[before]} -> ${label}`, err);
      throw err;
    } finally {
      reconfiguringSessions.delete(sessionId);
      emitSessionBusy(sessionId);
    }
  };
  ipcMain.handle('acp:switch-engine', (_event, sessionId: string, engineArg: string, hint?: ColdRecordHint) =>
    switchEngineImpl(sessionId, engineArg, hint));

  /**
   * **「组合」**（`mcpCombos.ts`）—— Claude Code / Codex 左下角的下拉 + 配置面板里那一页。
   * 文件是本机全局的（`~/.kirolex/mcp-combos.json`），所有会话共用；每条会话只记自己选了哪个（`profile.mcpCombo`）。
   */
  ipcMain.handle('acp:mcp-combos', (_event, sessionId?: string) => {
    const { combos, error } = readMcpCombos(os.homedir());
    const live = sessionId ? sessionClients.get(sessionId) : undefined;
    const picked = (live?.profile || (sessionId ? store.readRecord(sessionId)?.profile : undefined))?.mcpCombo;
    return {
      combos: combos.map((c) => ({ id: c.id, name: comboDisplayName(c), ...(c.effort ? { effort: c.effort } : {}) })),
      current: pickCombo(combos, picked).id,
      ...(picked && !findCombo(combos, picked) ? { missing: picked } : {}),
      ...(error ? { error } : {}),
    };
  });
  /* 文件不存在时 text 是空的、样板单独给（`template`）：编辑器不能把样板当成已经配好的内容显示 */
  ipcMain.handle('acp:mcp-combos-file', () => {
    const r = readMcpCombos(os.homedir());
    return { path: mcpCombosPath(os.homedir()), exists: r.exists, text: r.exists ? r.text : '', template: MCP_COMBOS_TEMPLATE, error: r.error };
  });
  /**
   * **新会话默认组合**（`defaultCombo.ts`）：全局一个（config.json），项目可覆盖（project.json）。
   * 只影响之后新建的 Claude Code / Codex 会话（`acp:new-session`），已有会话不动。
   * 返回本机的组合清单 + 两层各自设的值；设的那个本机没有时界面要说出来（`missing`）。
   */
  ipcMain.handle('acp:default-combo', (_event, project?: string) => {
    const { combos, error } = readMcpCombos(os.homedir());
    const global = readGlobalDefaultCombo(KIROLEX_CONFIG_PATH);
    const name = String(project || '').trim();
    const projectValue = name ? (projectStore.readProject(os.homedir(), name).defaultMcpCombo || '') : undefined;
    return {
      combos: combos.map((c) => ({ id: c.id, name: comboDisplayName(c) })),
      /* 记的是自建通用的原 id（如 general）时，下拉里那条现在是 default：按它显示，别显示成「本机没有」 */
      global: findCombo(combos, global)?.id ?? global,
      ...(projectValue !== undefined ? { project: findCombo(combos, projectValue)?.id ?? projectValue } : {}),
      effective: resolveDefaultCombo(combos, global, projectValue),
      ...(error ? { error } : {}),
    };
  });
  ipcMain.handle('acp:set-default-combo', (_event, comboId: string, project?: string) => {
    const id = String(comboId ?? '').trim();
    const name = String(project || '').trim();
    try {
      if (name) {
        { const advRefused = refuseAdvancedProject(name, 'set-default-combo'); if (advRefused) return { ok: false, error: advRefused }; }
        if (id && !normalizeComboId(id)) throw new Error(`invalid combo id: ${id}`);
        projectStore.writeProject(os.homedir(), name, { defaultMcpCombo: id });
      } else {
        writeGlobalDefaultCombo(KIROLEX_CONFIG_PATH, id);
      }
    } catch (err: any) {
      logger.warn('mcp-combo', `设新会话默认组合没成功（${name || '全局'} -> ${id || '(清空)'}）`, err);
      return { ok: false, error: String(err?.message || err) };
    }
    logger.info('mcp-combo', `新会话默认组合：${name ? `项目 ${name}` : '全局'} -> ${id || '(跟随 / 通用)'}`);
    return { ok: true };
  });
  ipcMain.handle('acp:save-mcp-combos', (_event, text: string) => {
    const r = saveMcpCombos(os.homedir(), String(text ?? ''));
    /* 原因里不带配置原文（见 parseMcpCombos / jsonSyntaxError），可以进日志 */
    if (!r.ok) { logger.warn('mcp-combo', `保存组合没成功：${r.error}`); return { ok: false, error: r.error }; }
    logger.info('mcp-combo', `保存了 ${r.combos.length - 1} 个组合（不含内置「通用」）`);
    mainWindow?.webContents.send('acp:mcp-combos-changed');
    return { ok: true };
  });

  /**
   * **换组合** —— MCP 是 session/new / load 时交给适配器的，所以要重启这条会话的执行器。
   * 和换引擎 / 换 kiro agent 同一套：先起新的、再断旧的，后端会话是新的，上下文从 KiroLex 自己的记录重建
   * （随下一条消息带过去）。没连着的会话只改记录（见 `setDormantProfile`）。这一轮还在跑时拒绝。
   */
  const switchMcpComboImpl = async (sessionId: string, comboId: string, fromPending?: boolean): Promise<any> => {
    { const advRefused = refuseAdvancedOnly(sessionId, 'switch-mcp-combo'); if (advRefused) throw new Error(advRefused); }
    const { combos } = readMcpCombos(os.homedir());
    const combo = findCombo(combos, comboId);
    if (!combo) throw new Error(tr('Combo "{id}" not found (did the combo file change? Reopen the dropdown and check).', { id: comboId }));
    const nextCombo = combo.id === BUILTIN_COMBO_ID ? undefined : combo.id;
    const onlyEngines = tr('Combos only apply to Claude Code / Codex sessions.');
    const oldEntry = sessionClients.get(sessionId);
    /* 忙、或者上一批 pending 正在应用（那次重连会先把执行器拿掉）：先登记，别掉进下面"没连着只写记录"那条路 ——
       那样写下的记录会被正在进行的那次重连用旧 profile 盖掉。登记的这一次在那一批落定后接着应用。
       记的是组合 **id**：界面的下拉按 id 对上选项；显示名随语言变（内置的「通用」英文是 General），只在提示里现取 */
    { const queued = queueSwitchWhileBusy(sessionId, 'combo', { comboId: combo.id }, combo.id, fromPending); if (queued) return { ...queued, current: combo.id }; }
    if (!oldEntry) {
      return { ...setDormantProfile(sessionId, { mcpCombo: nextCombo }, `mcp-combo -> ${combo.id}`, undefined, onlyEngines), current: combo.id };
    }
    if (engineOf(oldEntry.profile) === 'kiro') throw new Error(onlyEngines);
    if (reconfiguringSessions.has(sessionId)) throw new Error(tr('Another switch (model / agent / machine) has not finished yet.'));
    if (findCombo(combos, oldEntry.profile.mcpCombo || BUILTIN_COMBO_ID)?.id === combo.id) return { ok: true, current: combo.id, unchanged: true };

    await awaitAttachIdle(sessionId);
    reconfiguringSessions.add(sessionId);
    emitSessionBusy(sessionId);
    const profile: AgentProfile = { ...oldEntry.profile, mcpCombo: nextCombo };
    let client: AcpClient | undefined;
    /* 远程会话：ensureLocalTools 会换掉这条会话的 token、停掉旧的中转 —— 旧执行器手里那个隧道地址从这一刻起就失效了 */
    let toolsSwapped = false;
    try {
      if (profile.remote?.sshHost) await remoteAdapterCheck(profile.remote, engineOf(profile) as 'claude' | 'codex', sessionId);
      toolsSwapped = !!profile.remote?.sshHost;
      const localTools = await ensureLocalTools(sessionId, profile, localProjectDirOf(sessionId, oldEntry));
      const started = await connectWithModelFallback(profile, 'switch-mcp-combo', localTools, sessionId);
      client = started.client;
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
      try { await retireExecutor(oldEntry.client); } catch { /* 旧的已经没用了 */ }
      sessionClients.set(sessionId, nextEntry);
      wireSession(sessionId, nextEntry);

      const rec = store.readRecord(sessionId) || store.createSession(sessionId, profile);
      rec.profile = profile;
      rec.cliSessionId = created.sessionId;
      rec.executorState = 'attached';
      store.writeRecord(rec);
      clearContextEstablished(sessionId);
      markContextOwedIfUnverified(sessionId, 'switch-mcp-combo');
      restoreContextAfterExecutorSwap(sessionId, 'switch-mcp-combo');
      modelFallback.commit(sessionId);   // 换成了：记下的「改用了备用模型」现在写
      sessionNotice(sessionId, tr('🔀 Switched to the combo "{name}"; the context goes along with your next message.', { name: comboDisplayName(combo) }));
      logger.info('mcp-combo', `切换组合 sessionId=${sessionId} -> ${combo.id}`);
      return { ok: true, current: combo.id };
    } catch (err) {
      if (client) { try { await client.disconnect(); } catch {} }
      modelFallback.discard(sessionId);   // 没换成：连上时记下的那句作废
      logger.warn('mcp-combo', `切换组合失败 sessionId=${sessionId} -> ${combo.id}`, err);
      /*
        **新执行器没起来，旧的也已经没有工具通道了**（token 换了、旧中转停了）—— 留着它就是一条
        local_* 和转发 MCP 全部 404 的会话。所以把旧执行器也收掉（顺带收掉刚建的通道和本机进程）：
        记录里还是原来的组合，下一次打开 / 发消息按原组合重新接上，工具通道跟着一起重建。
      */
      if (toolsSwapped && sessionClients.get(sessionId) === oldEntry) {
        void detachExecutor(sessionId);
        /* 同一次失败只说一处：把"仍用原组合、下一条消息重新连接"放进抛出去的错误里（界面显示在组合下拉旁），不再另发状态行 */
        throw new Error(tr('Switching to the combo "{name}" failed ({err}); the previous combo is kept and your next message reconnects with it.', { name: comboDisplayName(combo), err: String((err as any)?.message || err) }));
      }
      throw err;
    } finally {
      reconfiguringSessions.delete(sessionId);
      emitSessionBusy(sessionId);
    }
  };
  ipcMain.handle('acp:switch-mcp-combo', (_event, sessionId: string, comboId: string) => switchMcpComboImpl(sessionId, comboId));

  /**
   * **应用忙时记下的切换**（`pendingSwitch.ts`）—— 这一轮结束（正常 / 出错 / Stop）、或者发新消息之前。
   *
   * 每一类都走它不忙时那条现成的路（`switch*Impl` / `applySessionTarget`），行为和立即切换一样；
   * 多个要换执行器的一起来时，只让最"强"的那一类重连一次，比它弱的几类先写进执行器的配置里，
   * 跟着那次重连一起生效（例如 换 agent + 换模型 = 一次 `--agent X --model Y`）。
   * 会话这时候没连着（休眠 / 断开）：各条路本来就会只写记录，下次挂起时按记录起。
   */
  /** 把比 head 弱的几类先写进 profile（跟着这次重连一起生效）；最终引擎上没意义的字段不带。 */
  const carryIntoProfile = (p: AgentProfile, head: PendingSwitch, carry: PendingSwitch[]): AgentProfile => {
    const engineSw = head.kind === 'engine' ? head : carry.find((c) => c.kind === 'engine');
    let next: AgentProfile = { ...p };
    if (engineSw && head.kind !== 'engine') next = reshapeForEngine(next, engineOf({ engine: engineSw.value.engine }));
    const finalEngine = engineSw ? engineOf({ engine: engineSw.value.engine }) : engineOf(p);
    for (const c of carry) {
      if (c.kind === 'agent' && finalEngine === 'kiro') next.kiroAgent = String(c.value.agentName || '').trim() || undefined;
      else if (c.kind === 'model' && finalEngine === 'kiro') {
        next.model = c.value.model; next.preferredModel = c.value.model; next.modelEarnedOn = machineKeyOf(p);
      } else if (c.kind === 'combo' && finalEngine !== 'kiro') next.mcpCombo = c.value.comboId === BUILTIN_COMBO_ID ? undefined : c.value.comboId;
    }
    return next;
  };
  const runReconnectSwitch = (sessionId: string, sw: PendingSwitch): Promise<any> => {
    const v = sw.value || {};
    switch (sw.kind) {
      case 'remote': {
        const target = v.remoteId ? findRemoteTarget(KIROLEX_CONFIG_PATH, v.remoteId) : undefined;
        if (v.remoteId && !target) throw new Error(tr('Remote target {id} not found (was it removed in Settings?). KiroLex did not guess a machine.', { id: v.remoteId }));
        return applySessionTarget(sessionId, target, v.localDir, v.hint);
      }
      case 'engine': return switchEngineImpl(sessionId, v.engine, v.hint, true);
      case 'combo': return switchMcpComboImpl(sessionId, v.comboId, true);
      case 'agent': return switchKiroAgentImpl(sessionId, v.agentName, true);
      default: return switchModelImpl(sessionId, v.model, true);
    }
  };
  /** 「正在启动本机 Claude Code 适配器…」—— 这一批要换执行器时的第一句；只有即时项（权限等）时没有这一步。 */
  const startingNoteFor = (sessionId: string, entries: PendingSwitch[]): string | null => {
    const recon = entries.filter((e) => isReconnectKind(e.kind));
    if (!recon.length) return null;
    const p = sessionClients.get(sessionId)?.profile || store.readRecord(sessionId)?.profile;
    const remoteSw = entries.find((e) => e.kind === 'remote');
    const engineSw = entries.find((e) => e.kind === 'engine');
    if (!remoteSw && !engineSw) return tr('Restarting the executor for {target}…', { target: pendingTargetForPeople(sessionId, recon) });
    const engine = engineSw ? engineOf({ engine: engineSw.value?.engine }) : engineOf(p);
    const engineName = engine === 'kiro' ? ENGINE_LABEL[engine] : tr('{engine} adapter', { engine: ENGINE_LABEL[engine] });
    const local = remoteSw ? !remoteSw.value?.remoteId : !p?.remote?.sshHost;
    if (local) return tr('Starting {engine} on this computer…', { engine: engineName });
    const host = remoteSw ? remoteSw.label.split(' · ')[0] : (labelForHost(KIROLEX_CONFIG_PATH, p!.remote!.sshHost) || p!.remote!.sshHost);
    return tr('Starting {engine} on {host}…', { engine: engineName, host: String(host) });
  };
  /** 失败时说"还在原来的 ___ 上"：这一类现在实际的值 */
  const currentValueForPeople = (kind: PendingKind, p: AgentProfile | undefined): string => {
    if (!p) return tr('its current setting');
    const engine = engineOf(p);
    switch (kind) {
      case 'remote': return p.remote?.sshHost ? String(labelForHost(KIROLEX_CONFIG_PATH, p.remote.sshHost) || p.remote.sshHost) : tr('This computer');
      case 'engine': return ENGINE_LABEL[engine];
      case 'agent': return p.kiroAgent || 'kiro_default';
      case 'model': return p.model;
      case 'combo': return comboDisplayName(pickCombo(readMcpCombos(os.homedir()).combos, p.mcpCombo));
      case 'permission': return p.permissionMode || 'auto-approve';
      case 'engineModel': return (engine !== 'kiro' && p.engineModels?.[engine]) || tr('its current setting');
      case 'engineEffort': return (engine !== 'kiro' && p.engineOptions?.[engine]?.thought_level) || tr('its current setting');
      case 'engineMode': return (engine !== 'kiro' && p.engineOptions?.[engine]?.mode) || tr('its current setting');
      case 'engineCollab': return (engine !== 'kiro' && (p.engineOptions?.[engine] as { collaboration_mode?: string } | undefined)?.collaboration_mode) || tr('its current setting');
    }
  };
  applyPendingSwitchBatch = async (sessionId: string, entries: PendingSwitch[]) => {
    if (!entries.length) return;
    /* 删掉的会话不再动它（否则写记录会把目录复活） */
    if (deletedSessionIds.has(sessionId)) { emitPendingSwitches(sessionId); return; }
    /* 用户刚点的一次立即切换可能还没落定 —— 等它，别撞上「另一个切换还没完成」 */
    try { await awaitReconfigureIdle(sessionId); } catch { /* 等不到就照试，失败会报出来 */ }
    logger.info('pending-switch', `本轮结束，应用忙时记下的切换 sessionId=${sessionId} ${entries.map((e) => `${e.kind}->${e.label}`).join(', ')}`);
    /*
      **切换真正执行时的几个阶段也要看得见**：「正在启动本机 Claude Code…」→「正在把对话历史交给新后端…」→「✅ 已切到本机」。
      实测那次从这一轮结束到能发下一条之间有 8 秒，会话里一句话都没有。只换权限这类即时项没有"启动"这一步，直接说结果。
    */
    const startNote = startingNoteFor(sessionId, entries);
    if (startNote) sessionNotice(sessionId, startNote); // 过程：状态行（一句接一句地换），结果才进对话记录
    let engineChangedBy: string | undefined;
    const report = await runPendingSwitches(entries, {
      /*
        **重连后的配置恢复先落定，再设即时项** —— 新执行器的 wireSession 会异步按 profile 恢复模型 / effort / 权限，
        不等它的话：这边先把新权限设上，它随后又按旧值设回去，界面却说切换成功了。
      */
      beforeInstants: async () => { await sessionClients.get(sessionId)?.engineOptionsReady; },
      /* 落定一类销一类：重连挂着的时候退出，还没落定的那几类要能被 persistPendingSwitchesOnQuit 写进记录 */
      onDone: (kinds) => pendingSwitches.doneApplying(sessionId, kinds),
      reconnect: async (head, carry) => {
        const entry = sessionClients.get(sessionId);
        const carrying = !!entry && carry.length > 0;
        const saved = entry?.profile;
        if (carrying) entry!.profile = carryIntoProfile(entry!.profile, head, carry);
        const restore = () => { if (carrying && sessionClients.get(sessionId) === entry) entry!.profile = saved!; };
        let r: any;
        try { r = await runReconnectSwitch(sessionId, head); } catch (err) { restore(); throw err; }
        if (r?.unchanged) { restore(); return { unchanged: true }; }
        if (carrying && head.kind === 'remote') engineChangedBy = carry.find((c) => c.kind === 'engine')?.value.engine;
        return { carried: carrying };
      },
      instant: async (sw) => {
        const v = sw.value || {};
        if (sw.kind === 'permission') { await switchPermissionModeImpl(sessionId, v.permissionMode, true); return; }
        /*
          **这一轮结束前会话断开 / 休眠了**：没有执行器可设，pending 也已经取走 —— 写进记录，
          下次接上时 applyEngineModel 按记录设回去（权限那条 switchPermissionModeImpl 自己就会这样做）。
        */
        if (!sessionClients.get(sessionId)) {
          const rec = store.readRecord(sessionId);
          if (!rec) throw new Error(tr('This session does not exist on disk (it may have been deleted).'));
          const engine = engineOf(rec.profile);
          if (engine === 'kiro') throw new Error(tr('kiro sessions do not go through this path'));
          rec.profile = withEngineOption(rec.profile, engine, v.category, v.value);
          store.writeRecord(rec);
          logger.info('pending-switch', `会话没连着，${v.category} -> ${v.value} 写进记录（下次挂起时设回去）sessionId=${sessionId}`);
          return;
        }
        await setEngineOption(sessionId, v.category, v.value, true);
      },
    });
    /* 只有重连、没有即时项时也等配置恢复落定：settle 等的是这一整批，下一条消息不能抢在恢复前面发 */
    try { await sessionClients.get(sessionId)?.engineOptionsReady; } catch { /* 已在 applyEngineModel 里记日志 */ }
    /*
      换了执行器 = 新后端是空的：对话历史要交过去。逐段重放（primeMode full）在这里等它做完，失败要说出来；
      快照模式（默认）随下一条消息带过去 —— ✅ 那句里说清。
    */
    let historyRidesAlong = false;
    if (report.reconnects > 0 && sessionClients.get(sessionId)) {
      const fresh = sessionClients.get(sessionId)!;
      if (fresh.priming || fresh.needsHistoryPrime || fresh.primePromise) {
        /* 只在这一刻真的在交接时说（逐段重放）；快照模式这一刻什么都没发生，说了反而挂在状态行上误导 */
        sessionNotice(sessionId, tr('Handing the conversation history to the new backend…'));
        const primed = await primeHistoryNow(sessionId).catch((err: any) => ({ ok: false, error: String(err?.message || err) } as any));
        if (!primed.ok && !primed.skipped) {
          noteInSession(sessionId, tr('⚠️ The switch is done, but handing the conversation history to the new backend did not finish ({why}). The next message will retry it.', { why: primed.error || tr('unknown reason') }),
            undefined, 'pending-switch-history-failed');
        }
      } else historyRidesAlong = true;
    }
    /* 引擎是跟着换机器那次一起换的：界面上的引擎徽标要跟着变（单独换引擎那条路自己会发） */
    if (engineChangedBy) mainWindow?.webContents.send('session:engine-changed', { sessionId, engine: engineOf({ engine: engineChangedBy }) });
    const p = sessionClients.get(sessionId)?.profile || store.readRecord(sessionId)?.profile;
    const appliedEntries = entries.filter((e) => report.applied.includes(e.kind));
    if (appliedEntries.length) {
      const target = pendingTargetForPeople(sessionId, appliedEntries);
      const doneText = historyRidesAlong
        ? tr('✅ Switched to {target}. The conversation history goes along with your next message.', { target })
        : tr('✅ Switched to {target}.', { target });
      noteInSession(sessionId, doneText, undefined, 'pending-switch-done');
      /* 状态行最后一句换成结果：把「正在启动…」顶掉，别让过程那句在切完之后还挂着 */
      if (!report.failed.length) sessionNotice(sessionId, doneText);
    }
    if (report.failed.length) {
      /*
        **哪一步、为什么、现在还能不能用** —— 不只写日志。失败的那几类没动（各条路失败时都保留 / 恢复原来的执行器），
        所以说清"还在原来的 ___ 上，可以继续用"。
      */
      const list = report.failed.map((f) => `${pendingKindName(f.kind)} → ${pendingLabelForPeople(f.kind, f.label)}（${f.error}）`).join(tr(', '));
      const current = report.failed.map((f) => `${pendingKindName(f.kind)} ${currentValueForPeople(f.kind, p)}`).join(tr(', '));
      const failText = tr('⚠️ Could not switch: {list}. This session stays on {current}, and you can keep using it.', { list, current });
      noteInSession(sessionId, failText, undefined,
        `pending-switch-failed:${report.failed.map((f) => `${f.kind}→${f.label}`).join(',')}`);
      sessionNotice(sessionId, failText); // 状态行同样以结果收尾（失败优先）
      logger.warn('pending-switch', `应用失败 sessionId=${sessionId} ${list}`);
    }
    mainWindow?.webContents.send('acp:pending-switch-result', {
      sessionId,
      applied: report.applied,
      failed: report.failed,
      /* 实际生效的值：界面按它回填（失败的那几类就回到原来的值） */
      profile: p ? {
        kiroAgent: p.kiroAgent || '', model: p.model, permissionMode: p.permissionMode || 'auto-approve',
        engine: engineOf(p), mcpCombo: p.mcpCombo || BUILTIN_COMBO_ID,
      } : null,
      pending: pendingSwitches.view(sessionId),
      since: pendingSwitches.sinceOf(sessionId) ?? null,
    });
    if (report.applied.includes('combo')) mainWindow?.webContents.send('acp:mcp-combos-changed');
  };
  ipcMain.handle('acp:get-pending-switches', (_event, sessionId?: string) => {
    if (sessionId) return { [sessionId]: pendingSwitches.view(sessionId) };
    const all: Record<string, Partial<Record<PendingKind, string>>> = {};
    for (const id of pendingSwitches.sessions()) all[id] = pendingSwitches.view(id);
    return all;
  });
  /** 窗口重载后补拿「这段等待从什么时候开始」（卡片的计时接着走，不从 0 重来） */
  ipcMain.handle('acp:get-pending-switch-since', () => {
    const all: Record<string, number> = {};
    for (const id of pendingSwitches.sessions()) { const t = pendingSwitches.sinceOf(id); if (t !== undefined) all[id] = t; }
    return all;
  });
  ipcMain.handle('acp:cancel-pending-switch', (_event, sessionId: string, kind?: PendingKind) => {
    const cancelled = pendingSwitches.cancel(sessionId, kind);
    if (cancelled) logger.info('pending-switch', `取消 sessionId=${sessionId} ${kind || '(全部)'}`);
    emitPendingSwitches(sessionId);
    /* 这一段等待整个取消了：卡片退回成普通提示，下面接一句结果 */
    if (cancelled && !pendingSwitches.has(sessionId)) {
      noteInSession(sessionId, tr('Switch cancelled; this session keeps its current setting.'), undefined, 'pending-switch-cancelled');
    }
    return { ok: true, cancelled, pending: pendingSwitches.view(sessionId) };
  });
  /**
   * **退出应用时还欠着的切换：写进记录，不偷偷丢** —— 下次启动挂起这条会话时按记录起
   * （和休眠时切换是同一个效果）。同步：before-quit 不能等。
   */
  const persistPendingSwitchesOnQuit = () => {
    /* 包括正在应用、还没落定的那一批（重连挂着时退出）—— 见 PendingSwitchBook.takeForQuit */
    for (const sessionId of pendingSwitches.sessionsForQuit()) {
      const entries = pendingSwitches.takeForQuit(sessionId);
      try {
        if (deletedSessionIds.has(sessionId)) continue;
        const rec = store.readRecord(sessionId);
        if (!rec) continue;
        let p: AgentProfile = { ...rec.profile };
        for (const sw of entries) {
          const v = sw.value || {};
          if (sw.kind === 'remote') {
            const target = v.remoteId ? findRemoteTarget(KIROLEX_CONFIG_PATH, v.remoteId) : undefined;
            if (v.remoteId && !target) continue;
            p = { ...p, remote: target ? { ...target } : undefined } as AgentProfile;
            if (v.localDir) rec.localDir = localDirOrSessionDir(sessionId, v.localDir);
          } else if (sw.kind === 'engine') {
            if (engineOf(p) !== engineOf({ engine: v.engine })) p = reshapeForEngine(p, engineOf({ engine: v.engine }));
          } else if (sw.kind === 'agent') {
            if (engineOf(p) === 'kiro') p.kiroAgent = String(v.agentName || '').trim() || undefined;
          } else if (sw.kind === 'model') {
            if (engineOf(p) === 'kiro') { p.model = v.model; p.preferredModel = v.model; p.modelEarnedOn = machineKeyOf(p); }
          } else if (sw.kind === 'combo') {
            if (engineOf(p) !== 'kiro') p.mcpCombo = v.comboId === BUILTIN_COMBO_ID ? undefined : v.comboId;
          } else if (sw.kind === 'permission') {
            p.permissionMode = v.permissionMode === 'ask' ? 'ask' : 'auto-approve';
          } else {
            const engine = engineOf(p);
            if (engine === 'kiro') continue;
            p = withEngineOption(p, engine, v.category, v.value);
          }
        }
        rec.profile = p;
        store.writeRecord(rec);
        logger.info('pending-switch', `退出时还欠着的切换写进记录 sessionId=${sessionId} ${entries.map((e) => `${e.kind}->${e.label}`).join(', ')}（下次挂起按记录起）`);
      } catch (err) {
        logger.warn('pending-switch', `退出时写记录失败 sessionId=${sessionId}`, err);
      }
    }
  };
  app.on('before-quit', () => persistPendingSwitchesOnQuit());

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
      if (!r) throw new Error(tr('This session runs on this computer. The Claude Code / Codex login here is something you set up yourself, and KiroLex leaves it alone. To log in on a remote machine, first right-click the session, choose "Run location", and move it to that machine.'));
      return r;
    }
    const t = findRemoteTarget(KIROLEX_CONFIG_PATH, machine);
    if (!t?.sshHost) throw new Error(tr('Machine not found ({machine}). Was it removed in Settings?', { machine }));
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
        claude: cb && claude.installed ? { ...claude, loggedIn: true, detail: tr('Via Amazon Bedrock (global, {region})', { region: cb.region || '?' }), gateway: undefined } : claude,
        codex: xb && codex.installed ? { ...codex, loggedIn: true, detail: tr('Via Amazon Bedrock ({model} @ {region})', { model: xb.model || '?', region: xb.region || '?' }), gateway: undefined } : codex,
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
    if (!child?.stdin) return { ok: false, error: tr('This login session has already ended.') };
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
    if (!target) return { ok: false, error: tr('No path') };
    try {
      const p = resolveUserPath(target, sessionId);
      if (!fs.existsSync(p)) return { ok: false, error: tr('File not found.') };
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
   * 读成功就按「会话 + 机器 + 路径」进 `reviewedPaths`（`remoteReviewKey`）—— 侧栏 review 写回时经 ssh 写回同一个路径
   * （`writeRemoteReviewFile`）；别的会话没读过，照样拒写。
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

  /** 用 ssh 取远端一个文件的前 `max` 字节和它的总大小（base64 回来，和配置面板那条路一样）。 */
  async function remoteFileBytes(target: RemoteTarget, remotePath: string, max = WORKSPACE_PREVIEW_MAX_BYTES, timeoutMs = 30_000):
    Promise<{ kind: 'dir' | 'missing' } | { kind: 'file'; size: number; buffer: Buffer }> {
    const script = `f=${shellQuote(remotePath)}; if [ -d "$f" ]; then echo KXDIR; elif [ -f "$f" ]; then printf 'KXSIZE %s\\n' "$(wc -c <"$f" | tr -d ' ')"; head -c ${max} "$f" | base64 -w0; else echo KXMISSING; fi`;
    const out = String(await runRemoteCapture(target, script, timeoutMs, captureBufferFor(max)) || '');
    if (out.startsWith('KXDIR')) return { kind: 'dir' };
    if (!out.startsWith('KXSIZE ')) return { kind: 'missing' };
    const nl = out.indexOf('\n');
    const size = Number(out.slice(7, nl)) || 0;
    const buffer = Buffer.from(out.slice(nl + 1).trim(), 'base64');
    /*
      `runRemoteCapture` 在 ssh 报错但已经有输出时照样返回 —— 读回来的可能只是前半截。字节数对不上就当读失败：
      预览不显示残缺正文，备份 / 写回不拿它当原文（写回那边 `writeTextVia` 另有一道同样的核对）。
    */
    if (buffer.length !== Math.min(size, max)) {
      throw new Error(tr('The file came back incomplete ({got} / {want} bytes); the connection may have dropped midway', { got: buffer.length, want: Math.min(size, max) }));
    }
    return { kind: 'file', size, buffer };
  }
  const remoteHostLabel = (target: RemoteTarget): string => labelForHost(KIROLEX_CONFIG_PATH, target.sshHost) || target.sshHost;

  /** 用 ssh 读远端一个文件，形状和本地读的结果一致。 */
  async function readRemoteFile(target: RemoteTarget, remotePath: string) {
    const MAX = WORKSPACE_PREVIEW_MAX_BYTES;
    const got = await remoteFileBytes(target, remotePath, MAX);
    const host = remoteHostLabel(target);
    if (got.kind === 'dir') throw new Error(tr('{path} on {host} is a directory, not a file.', { host, path: remotePath }));
    if (got.kind !== 'file') throw new Error(tr('No such file on {host}: {path}', { host, path: remotePath }));
    const { size, buffer } = got;
    const base = { path: remotePath, remote: true, remoteHost: host };
    const ext = path.posix.extname(remotePath).toLowerCase();
    if (IMAGE_MIME_BY_EXT[ext]) {
      if (size > MAX) return { ...base, content: tr('Image too large ({mb} MB); view it on {host}.', { mb: (size / 1048576).toFixed(1), host }), binary: true, truncated: false };
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
    /* 本机没有、而它是远端那台机器上的路径 → 从那台机器读，读成功就记在这条会话名下（写回经 ssh，见 remoteFileFor） */
    if (!fs.existsSync(filePath)) {
      const remote = remoteFileFor(sessionId, rawPath);
      if (remote) {
        const out = await readRemoteFile(remote.target, remote.path);
        markReviewed(sessionId, remoteReviewKey(remote.target.sshHost, remote.path));
        return out;
      }
    }
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) throw new Error(tr('Path is a directory, not a file.'));
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
          content: tr('Image too large ({mb} MB); download it to view.', { mb: (stats.size / 1048576).toFixed(1) }),
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

  /**
   * **「⇩ 复制到本机」** —— 远程会话把交付文件写在了远端（`remoteWriteGuard.strayRemoteDeliverables`），
   * 用户不该自己去 ssh：经已有的 ssh 连接（`remoteFileBytes`）读出来，写进这条会话的本机文件夹
   * （`sessions/<id>/files/`）。本机已有同名的别的文件时不覆盖（`localCopyPath`）；内容一样就复用那一份。
   * 回本机路径，渲染端接着用它打开预览 —— 之后 comment 写回的就是本机这一份。
   */
  ipcMain.handle('workspace:copy-remote-to-local', async (_event, sessionId: string, remotePath: string) => {
    try {
      if (!sessionId || !/^[\w.-]+$/.test(sessionId)) return { ok: false, error: tr('No session') };
      { const advRefused = refuseAdvancedOnly(sessionId, 'copy-remote-to-local'); if (advRefused) return { ok: false, error: advRefused }; }
      const remote = remoteFileFor(sessionId, String(remotePath || ''));
      if (!remote) return { ok: false, error: tr('This is not a path on the machine this remote session runs on') };
      const MAX = 64 * 1024 * 1024;
      /* 最多 64 MB：stdout 上限按它算（`captureBufferFor`），超时也放宽到 5 分钟 */
      const got = await remoteFileBytes(remote.target, remote.path, MAX, 5 * 60_000);
      const host = remoteHostLabel(remote.target);
      if (got.kind === 'dir') return { ok: false, error: tr('{path} on {host} is a directory, not a file', { host, path: remote.path }) };
      if (got.kind !== 'file') return { ok: false, error: tr('No such file on {host}: {path}', { host, path: remote.path }) };
      if (got.size > MAX) return { ok: false, error: tr('File too large ({mb} MB). Files over 64 MB are not copied this way', { mb: (got.size / 1048576).toFixed(1) }) };
      const dest = saveRemoteCopy(sessionFilesDir(sessionId), remote.path, got.buffer);
      logger.info('workspace', `copied remote file to local sessionId=${sessionId} ${host}:${remote.path} -> ${dest} (${got.size} bytes)`);
      return { ok: true, path: dest, bytes: got.size };
    } catch (err: any) {
      logger.warn('workspace', `copy remote file failed sessionId=${sessionId} ${remotePath}: ${err?.message || err}`);
      return { ok: false, error: String(err?.message || err) };
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
  /** Fallback poll: `fs.watch` does not fire on every filesystem (network mounts, some
   *  container bind mounts). Every `VIEWER_POLL_MS` the open files are `stat`ed -- at
   *  most 32 (the tab cap), no content read -- and a changed fingerprint sends the same
   *  event the watcher would. */
  const viewerSeen = new Map<string, string>();             // full path -> `mtimeMs|size`
  let viewerPoll: NodeJS.Timeout | null = null;
  const VIEWER_POLL_MS = 2000;

  function stopViewerWatch(): void {
    for (const w of viewerWatchers.values()) { try { w.close(); } catch { /* already closed */ } }
    viewerWatchers.clear();
    viewerFiles.clear();
    for (const t of viewerDebounce.values()) clearTimeout(t);
    viewerDebounce.clear();
    viewerSeen.clear();
    if (viewerPoll) { clearInterval(viewerPoll); viewerPoll = null; }
  }

  /** A file's fingerprint, `mtimeMs|size`; `gone` when it no longer exists. */
  function viewerStamp(full: string): string {
    try { const st = fs.statSync(full); return `${st.mtimeMs}|${st.size}`; } catch { return 'gone'; }
  }

  /** Report a change -- shared by `fs.watch` and the poll, so one save is reported once
   *  and a deletion is reported (as `exists: false`) rather than dropped. */
  function viewerChanged(full: string): void {
    const stamp = viewerStamp(full);
    if (viewerSeen.get(full) === stamp) return;   // unchanged, or already reported by the other path
    viewerSeen.set(full, stamp);
    mainWindow?.webContents.send('workspace:file-changed', {
      path: full,
      exists: stamp !== 'gone',
      mtimeMs: stamp === 'gone' ? 0 : Number(stamp.split('|')[0]),
    });
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
      // Seed the fingerprint, or the first poll would report every open file as changed.
      viewerSeen.set(full, viewerStamp(full));
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
            viewerChanged(full2);
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
    if (viewerSeen.size) {
      viewerPoll = setInterval(() => {
        for (const full of [...viewerSeen.keys()]) viewerChanged(full);
      }, VIEWER_POLL_MS);
    }
    return { ok: true, watching: wanted.length, dirs: viewerWatchers.size };
  });

  ipcMain.handle('workspace:download', async (_event, sessionId: string | null | undefined, filePath: string) => {
    filePath = resolveUserPath(filePath, sessionId);
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) throw new Error(tr('Path is not a file.'));
    const options = {
      title: tr('Save workspace file'),
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
      return { ok: false, error: copyError?.message || tr('Download failed.') };
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

  const listModelsRemote = async (machine: string): Promise<any> => {
    /*
      **模型列表按机器分** ——「确认下右侧界面远程会话显示的是远程的 agent 和模型」。

      以前只有一份：跑本机 kiro-cli，所有会话共用。而两台机器的 kiro-cli 版本不一样
      （实测本机 2.23.1、东京 1.27.0），于是下拉里完全可能有远端没有的模型 ——
      启动那一刻 `pickRemoteModel` 会替换成可用的并在会话里说一句，也就是不会静默跑错，
      但下拉在骗你。远程会话就去问**那台机器**。

      远端那边用的是同一个探测（`preflightScript` 里那段：故意传一个不存在的模型，
      kiro-cli 在参数校验就会把可用列表打出来 —— 不真调模型、不花额度）。
    */
    const target = findRemoteTarget(KIROLEX_CONFIG_PATH, machine);
    if (!target?.sshHost) throw new Error(tr('Machine not found ({machine}). Was it removed in Settings?', { machine }));
    const bin = remoteKiroBin(target);
    if (!bin) throw new Error(tr('No kiro launch command is set for {host} yet (Settings → 🖥 Machines).', { host: target.sshHost }));
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
      .catch((err) => { throw new Error(tr('Could not get the model list from {host}: {err}', { host: target.sshHost, err: String(err?.message || err) })); });
    const ids = parseModels(out);
    if (!ids.length) throw new Error(tr('{host} did not report a model list (does its kiro-cli version not support this probe?)', { host: target.sshHost }));
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
  };
  /* 辅助模型的多机清单（`helperRemoteIds`）也走这一条 —— 同一套"先问完整清单、问不到再探"。 */
  remoteModelLister = (m) => listModelsRemote(m).then((r) => (r?.models || []).map((x: any) => String(x?.model_id || '')).filter(Boolean));

  ipcMain.handle('acp:list-models', async (_event, machine?: string) => {
    if (machine && machine !== 'local') return listModelsRemote(machine);
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

  /*
    **设置里「辅助模型」下拉的清单** = 本机 + 设置里每台远程机器（`helperModels.ts`）。
    `cachedOnly`：马上回 —— 已经问过的机器给缓存、没问过的标 `pending`，渲染端先用 `cachedIds`
    （`model-meta.json` 里的 id）占位；随后不带它再调一次拿实时清单。整个调用 single-flight：
    设置窗口反复开、连点刷新，都只会有一轮在跑。
  */
  ipcMain.handle('acp:list-helper-models', async (_event, opts?: { cachedOnly?: boolean }) => {
    const cachedIds = Object.keys(readMetaCache(MODEL_META_PATH));
    const localLabel = HELPER_LOCAL_MACHINE; // 显示名由渲染端按语言给（「本机」）
    if (opts?.cachedOnly) {
      const lists: MachineModelList[] = [
        localModelIdsCache?.length
          ? { machine: HELPER_LOCAL_MACHINE, label: localLabel, status: 'ok', ids: localModelIdsCache }
          : { machine: HELPER_LOCAL_MACHINE, label: localLabel, status: 'pending', ids: [] },
        ...listRemoteTargets(KIROLEX_CONFIG_PATH).map((t): MachineModelList => {
          const hit = helperRemoteCache.get(t.id);
          return hit
            ? { machine: t.id, label: t.label || t.sshHost, status: 'ok', ids: hit.ids }
            : { machine: t.id, label: t.label || t.sshHost, status: 'pending', ids: [] };
        }),
      ];
      return { lists, cachedIds, fallbackOrder: MODEL_FALLBACK_ORDER };
    }
    if (!helperListsInFlight) {
      helperListsInFlight = (async () => {
        localModelIdsCache = null; // 刷新 = 本机也重问一遍
        const [local, remotes] = await Promise.all([localModelIds(), helperRemoteModelLists(true)]);
        const localList: MachineModelList = local.length
          ? { machine: HELPER_LOCAL_MACHINE, label: localLabel, status: 'ok', ids: local }
          : { machine: HELPER_LOCAL_MACHINE, label: localLabel, status: 'failed', ids: [] };
        for (const l of remotes) if (l.status === 'failed') logger.warn('helper-models', `${l.label}: 模型清单拉不到（${l.error}）`);
        return [localList, ...remotes];
      })().finally(() => { helperListsInFlight = null; });
    }
    return { lists: await helperListsInFlight, cachedIds, fallbackOrder: MODEL_FALLBACK_ORDER };
  });

  ipcMain.handle('acp:get-usage', async () => {
    try {
      const result = await runKiroCli('chat --no-interactive "/usage" 2>&1', 20000);
      const clean = result.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g, '').trim();
      return { text: clean };
    } catch (err: any) {
      const output = (err.stdout || '') + (err.stderr || '');
      const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g, '').trim();
      return { text: clean || tr('Failed to get usage') };
    }
  });

  // Generate a concise chat title from the first message via a one-shot kiro-cli
  // call. execFile (args array) — user text is never shell-interpolated.
  ipcMain.handle('app:generate-title', async (_event, firstUser: string, firstAssistant?: string, sessionId?: string) => {
    /* Claude Code / Codex 会话不交给 kiro 起标题：渲染层看到 `skipped: 'engine'` 直接用第一条消息 */
    if (skipLiteHelperFor(sessionId, 'title')) return { ok: false, skipped: 'engine' };
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
  ipcMain.handle('app:generate-suggestions', async (_event, recentConvo: string, meta?: { sessionId?: string | null; messages?: number; paneFocused?: boolean }) => {
    /*
      **发起时记一行：哪条会话、几条消息** ——「新建会话 10:40:36，10:40:45 `[suggestions] generated 3`」被当成过
      「新会话那时 messages 已经非空」的证据，但「generated」是**完成**时记的，一次要排队 + 起 kiro-cli + 跑模型，
      实测（10-21 本机）渲染层 00:47:12.8 触发，00:47:40 才真正起 kiro-cli，00:47:55 才有结果。只看完成那行分不出是哪条会话触发的。
    */
    logger.info('suggestions', `requested sessionId=${meta?.sessionId || '?'} messages=${meta?.messages ?? '?'} paneFocused=${meta?.paneFocused ?? '?'}`);
    /*
      **在发出去的这一处再挡一次** —— 实测泄漏就是从这条路出去的：
      `[suggestions] … Based on the conversation below … User: ⚠️ 这条会话现在跑在 gpt-5.6-sol 上…`。
      上游（渲染进程）也会过滤，但这里不能依赖它：再多一个调用点，漏的就是那一个。
    */
    const convo = stripKirolexNotes(String(recentConvo || '')).slice(0, 4000);
    if (!convo.trim()) return { suggestions: [] };
    /* Claude Code / Codex 会话不交给 kiro 生成追问建议（输入框上面照常是那几条固定的） */
    if (skipLiteHelperFor(meta?.sessionId, 'suggestions')) return { suggestions: [], skipped: 'engine' };
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'attach'); if (advRefused) throw new Error(advRefused); }
    if (!firstAttachMarked) { firstAttachMarked = true; startupMark('attach: first loadSession', `sessionId=${sessionId}`); }
    /*
      **还在新建的会话不 attach，等它建完** —— 实测（s_1792726606826_e2mprs）：新建远程会话的第 10 秒，
      渲染层切会话 / 预热就来 attach 它，记录还没写完 → 按默认值（本机 kiro）去连 → 「该会话在磁盘上不存在」。
      新建本身就会把执行器起好，建成了这里直接返回；建失败就说新建失败了（原因由新建那条路报），不另起一个。
    */
    if (creations.creating(sessionId)) {
      logger.info('attach', `sessionId=${sessionId} 还在新建中 —— 不按默认值 attach，等新建结束`);
      const created = await creations.settle(sessionId);
      if (sessionClients.get(sessionId)) return { ok: true, freshBackend: false };
      if (created && !created.ok) throw new Error(tr('This chat could not be started: {error}', { error: created.error || '' }));
    }
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
      throw new Error(tr('Session was deleted; not re-attaching.'));
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
      throw new Error(tr('Session was deleted; not re-attaching.'));
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
        throw new Error(tr('All live sessions are busy; cannot attach another right now.'));
      }
      const existing = store.readRecord(sessionId);
      // ATTACH MUST NOT CREATE. `createSession` below used to run for any unknown
      // id, so attaching a stale entry (a chat deleted on disk, or deleted while the
      // renderer index still listed it) RE-CREATED its record — and the chat came
      // back at the next start, "deleted" but alive. Creation belongs to
      // acp:new-session only; resuming an id with no record on disk is an error.
      if (!existing) {
        throw new Error(tr('This session does not exist on disk (it may have been deleted), so it will not be rebuilt.'));
      }
      const derived = derivedProjectFor(sessionId, resolvedCwd);
      /* 你亲手移出项目的，不按目录再反推回去（见 `AgentProfile.unassigned`） */
      const projectId = existing?.profile.projectId ?? (existing?.profile.unassigned ? undefined : derived);
      /*
        **Claude Code / Codex 会话不采信渲染层带来的模型名** —— 渲染层 attach 带的是 kiro 的（没记过就是 DEFAULT_MODEL），
        原来它会被当成"实际起来的模型"写进这条会话的记录（连 `modelEarnedOn` 一起）。它们的模型由 `engineModels` +
        适配器清单定（`applyEngineModel`）；记录里的旧值（老记录可能是个 kiro id）只是读着忽略，不改写 ——
        这里用记录里的值，下面「persist effective model」那段比对相等，就什么都不写。
      */
      const nonKiroAttach = engineOf(existing.profile) !== 'kiro';
      const profile: AgentProfile = {
        model: nonKiroAttach ? (existing.profile.model || 'default') : (model || existing?.profile.model || DEFAULT_MODEL),
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
        ...(existing?.profile.engineModelsUsed ? { engineModelsUsed: existing.profile.engineModelsUsed } : {}),
        ...(existing?.profile.engineOptions ? { engineOptions: existing.profile.engineOptions } : {}),
        /* 同一张白名单：所选「组合」（漏了的话一重启就回到「通用」） */
        ...(existing?.profile.mcpCombo ? { mcpCombo: existing.profile.mcpCombo } : {}),
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
      let remoteModels: string[] | undefined;
      if (profile.remote?.sshHost) {
        /* 没有项目目录（记录里没记、渲染层又只给了 `'~'`）→ 用会话目录，和本地那条路一致 */
        resolvedCwd = localDirOrSessionDir(sessionId, resolvedCwd);
        /*
          家目录那道闸连同镜像一起去掉了：没有任何东西会被推到远端，
          所以"这个目录能不能当镜像根"这个问题不存在了。它原来还有一条**退回本地**的分支
          （那是为了不让一条已存在的远程会话变成死结），现在也不需要了。
        */
        if (engineOf(profile) !== 'kiro') {
          await remoteAdapterCheck(profile.remote, engineOf(profile) as 'claude' | 'codex', sessionId);
        } else {
          remoteModels = await remotePreflight(profile.remote);
          profile.model = pickRemoteModel(sessionId, firstWantedModel(profile, machineKeyOf(profile), MODEL_FALLBACK_ORDER), remoteModels, profile.remote.sshHost || '');
        }
        localTools = await ensureLocalTools(sessionId, profile, resolvedCwd);
      } else {
        /* 本地 Claude Code / Codex：所选「组合」里的 MCP（kiro 会话返回 undefined，见 `localComboTools`） */
        localTools = await ensureLocalTools(sessionId, profile, resolvedCwd);
      }
      const started = await connectWithModelFallback(profile, `attach ${sessionId}`, localTools, sessionId, remoteModels);
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
        if (establishedFor !== undefined && !contextMarkerHolds(engineOf(profile), { for: establishedFor, pid: establishedPid }, { cliSessionId, pid: client.pid })) {
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
        throw new Error(tr('Session was deleted during attach; aborted.'));
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
    /* 连上了：之前没建成留下的失败记录作废（窗口刷新后的快照里不能再有那条失败横幅） */
    creations.clearFailed(sessionId);
    newSessionArgs.delete(sessionId);
    /* 连上、resume / 新起后端会话、记录都成了：连接时记下的「改用了备用模型」现在写 */
    modelFallback.commit(sessionId);
    return { ok: true, freshBackend: freshBackendResult };
    } catch (err) {
      /*
        **失败要进日志** —— 原来一行都没有：本机 Claude Code 适配器没装（adapterMissingMessage）时，
        日志停在「本地会话挂上 kirolex-local」就没下文了，看着像卡住。只在这一份 attach 里记一次（跟进来的不重复记）。
      */
      logger.warn('attach', attachFailureLine(sessionId, store.readRecord(sessionId)?.profile, err));
      throw err;
    } finally {
      /* 没走到上面那一步（中途失败 / 被删）：记下的那句作废 */
      modelFallback.discard(sessionId);
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
   * **会话里「没连上：没有 … 的 ACP 适配器」那条提示上的「安装」** —— 原来只叫人去设置里找。
   *
   * 本机：`npm install -g <包>`，cwd 是家目录（`runLocalAdapterInstall`）—— 绝不在 KiroLex 自己的目录里装
   * （重装官方 Electron 会被 Falcon 当 malware 杀掉）。装完重新找入口（含 fnm / nvm / Volta / asdf 的全局目录）。
   * 远端：「安装 AI 工具」那个脚本只装缺的那一个（`installRemoteAdapter`）。
   * 机器和引擎以记录为准；新建失败的会话还没有记录，用渲染层带来的 engine / remoteId。
   * 输出边跑边推给界面（`acp:adapter-install-output`）；装不上把原因写进会话（有记录时）和日志。重连由渲染层做。
   */
  /* 同一机器、同一引擎只装一次；后点的会话订阅那一次，进度（含已经出来的）和结果都广播给它（`runEngineInstall` → `createSharedInstalls`） */
  ipcMain.handle('acp:install-adapter', async (event, sessionId: string, engineArg?: string, remoteId?: string) => {
    const sid = String(sessionId || '').trim();
    const rec = sid ? store.readRecord(sid) : null;
    const engine = rec ? engineOf(rec.profile) : engineOf({ engine: engineArg });
    const remote = rec ? rec.profile.remote : (remoteId ? findRemoteTarget(KIROLEX_CONFIG_PATH, remoteId) : undefined);
    /* kiro：只有本机的「没装 kiro-cli」走这里（`installLocalKiro`）；远端的 kiro-cli 照旧在设置里「安装 AI 工具」 */
    if (engine === 'kiro' && remote?.sshHost) return { ok: false, error: tr('This session does not use Claude Code or Codex.') };
    if (!rec && remoteId && !remote) {
      return { ok: false, error: tr('Remote target {id} not found (did the remotes in your config change?). KiroLex did not guess a machine, so this session was not created.', { id: String(remoteId) }) };
    }
    const host = remote?.sshHost || undefined;
    const send = (chunk: string) => { try { event.sender.send('acp:adapter-install-output', { sessionId: sid, chunk }); } catch { /* 窗口没了 */ } };
    logger.info('engine', `install-adapter ${sid}: ${ENGINE_LABEL[engine]} @ ${host || '本机'}${engineInstalls.has(engineInstallKey(remote, engine)) ? '（已经在装了，等那一次）' : ''}`);
    const r = await runEngineInstall(remote, engine, send);
    if (r.ok) {
      logger.info('engine', `install-adapter ${sid}: ${ENGINE_LABEL[engine]} @ ${host || '本机'} 装好了${(r as any).entry ? `（${(r as any).entry}）` : ''}`);
      return { ok: true };
    }
    const error = r.error || (engine === 'kiro' ? kiroInstallFailedMessage('?') : adapterInstallFailedMessage(engine, host, '?'));
    logger.warn('engine', `install-adapter ${sid}: ${ENGINE_LABEL[engine]} @ ${host || '本机'} 没装上：${error}`);
    const noted = rec ? noteInSession(sid, error, undefined, `adapter-install:${host || 'local'}:${engine}`) : false;
    return { ok: false, error, noted };
  });

  /**
   * **三个引擎在一台机器上的状态**（`'local'` = 本机，否则远端 id）—— 新建会话选引擎处、设置 → 机器 → 本机那页用。
   * 5 分钟缓存（`force` 跳过）；回 `{ ok, statuses: EngineStatus[] }`。
   */
  ipcMain.handle('engines:status', async (_event, machine?: string, opts?: { force?: boolean }) => {
    try {
      return { ok: true, statuses: await engineStatusesFor(String(machine || 'local'), !!opts?.force) };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  /** 状态里的 ❌：直接装（和会话里「安装」同一份，`runEngineInstall`）。进度推 `engines:install-output`。 */
  ipcMain.handle('engines:install', async (event, machine: string, engineArg: string) => {
    const engine = engineArg === 'claude' || engineArg === 'codex' || engineArg === 'kiro' ? engineArg : null;
    if (!engine) return { ok: false, error: tr('Unknown engine') };
    const key = String(machine || 'local');
    const remote = key === 'local' ? undefined : findRemoteTarget(KIROLEX_CONFIG_PATH, key);
    if (key !== 'local' && !remote) return { ok: false, error: tr('Machine not found') };
    const send = (chunk: string) => { try { event.sender.send('engines:install-output', { machine: key, engine, chunk }); } catch { /* 窗口没了 */ } };
    logger.info('engines', `install ${engine} @ ${remote?.sshHost || '本机'}`);
    const r = await runEngineInstall(remote, engine, send);
    if (!r.ok) logger.warn('engines', `install ${engine} @ ${remote?.sshHost || '本机'} 没装上：${r.error}`);
    return r;
  });

  /**
   * 状态里的 ⚠️ / 会话里「没登录」的「登录」。
   * 本机：开一个终端窗口跑那家的登录命令（登录要问的几句人自己答），回 `{ ok, opened: true }` —— 渲染层随后轮询状态，登上了自动重试。
   * 远端：回 `{ ok, how }` —— 远端的登录在 KiroLex 里另有入口（🔑 登录 / 安装 AI 工具），这里给出去哪登。
   */
  ipcMain.handle('engines:login', async (_event, machine: string, engineArg: string) => {
    const engine = engineArg === 'claude' || engineArg === 'codex' || engineArg === 'kiro' ? engineArg : null;
    if (!engine) return { ok: false, error: tr('Unknown engine') };
    const key = String(machine || 'local');
    if (key !== 'local') {
      const remote = findRemoteTarget(KIROLEX_CONFIG_PATH, key);
      if (!remote) return { ok: false, error: tr('Machine not found') };
      return { ok: true, how: remoteLoginHow(engine, remote.label || remote.sshHost || key) };
    }
    const cmd = localLoginArgv(engine);
    if ('error' in cmd) return { ok: false, error: cmd.error };
    const opened = await openLoginTerminal(cmd.argv, cmd.env);
    logger.info('engines', `本机登录 ${engine}：${opened ? '开了终端' : '没能开终端'}（${cmd.argv.join(' ')}）`);
    engineStatusCache.invalidate('local');
    return opened
      ? { ok: true, opened: true }
      : { ok: false, error: tr('Could not open a terminal. Run this in a terminal yourself: {cmd}', { cmd: cmd.argv.join(' ') }) };
  });

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
  /* 断线恢复（`remoteRecovery`）在模块级，它要用的就是这一份挂载实现 */
  reattachSession = ensureAttached;

  /**
   * **编辑重发：让 Claude Code / Codex 的后端真正忘掉被编辑之后的内容**（审计 10，判据在 `editFork.ts`）。
   * 渲染层在截短 transcript **之前**调它，`keepIds` 是编辑后保留下来的那些消息。
   *   fork  → `session/fork`（带分叉点）+ `session/load` 新的那个，后端会话 id 换成它，记录跟着写；
   *   fresh → 编辑的是第一条：直接换一个新的后端会话；
   *   snapshot → 分不了，但当前后端本来就没被确认握着历史：下一条带的快照是按截短后的记录建的，不说什么；
   *   其余 / 失败 → 照原来的做法（同一个后端会话里重发），会话里说一句「后端仍记得旧内容」。
   * kiro 不走这里（渲染层也不调）。永远不抛：这一步失败不能挡住重发本身。
   */
  ipcMain.handle('acp:fork-backend-for-edit', async (_event, sessionId: string, keepIds: string[]) => {
    const sid = String(sessionId || '').trim();
    const rec = sid ? store.readRecord(sid) : null;
    const engine = engineOf(rec?.profile);
    if (!sid || !rec || engine === 'kiro') return { mode: 'none' };
    const label = ENGINE_LABEL[engine];
    const fallback = (why: string, reason: string) => {
      logger.info('edit-fork', `fallback sessionId=${sid} reason=${reason}`);
      sessionNotice(sid, tr('ℹ️ Edit & resend: {why}, so it was resent the old way — the {engine} backend still remembers the part you edited away.', { why, engine: label }));
      return { mode: 'fallback', reason };
    };
    if (!(await ensureAttached(sid))) return fallback(tr('the session could not be connected'), 'not-connected');
    const entry = sessionClients.get(sid)!;
    /* 欠着重建（prime-pending）不算忙：那正是「后端没握着历史」，交给下面的判据（和 swapBackendSessionWhenIdle 同一个口径） */
    { const busy = busyReasonFor(sid); if (busy && busy !== 'prime-pending') return fallback(tr('the session was still busy'), 'busy'); }
    const plan = planEditFork({
      engine,
      forkPoint: supportsForkPoint(engine, entry.client.agentCapabilities),
      cliSessionId: entry.cliSessionId,
      transcript: store.readTranscript(sid) as any,
      keepIds: Array.isArray(keepIds) ? keepIds.map(String) : [],
      contextHeld: contextEstablished(sid, entry),
    });
    if (plan.mode === 'none') return plan;
    if (plan.mode === 'snapshot') {
      logger.info('edit-fork', `snapshot sessionId=${sid} reason=${plan.reason} —— 当前后端没握着历史，下一条按截短后的记录带快照，不用提示`);
      return plan;
    }
    if (plan.mode === 'fallback') {
      return fallback(
        plan.reason === 'unsupported' ? tr('this adapter cannot fork from a given message')
          : plan.reason === 'no-anchor' ? tr('the earlier replies were saved before KiroLex recorded fork points')
            : tr('the earlier replies belong to a different backend session (engine / machine / backend was switched since)'),
        plan.reason,
      );
    }
    if (plan.mode === 'fresh') {
      try {
        const r = await swapBackendSessionWhenIdle(sid, 'edit-rerun');
        logger.info('edit-fork', `fresh backend sessionId=${sid} ${r.oldId} -> ${r.newId}`);
        return { mode: 'fresh' };
      } catch (err: any) {
        return fallback(tr('starting a new backend session failed ({err})', { err: String(err?.message || err) }), 'fresh-failed');
      }
    }
    reconfiguringSessions.add(sid);
    emitSessionBusy(sid);
    try {
      const oldId = entry.cliSessionId;
      const forked = await entry.client.forkSession(oldId, entry.cwd, forkPointMeta(plan.messageId));
      /* load 会把分出来的那段历史回放一遍：下一轮开始前一律丢掉（工具调用也是，见 wireSession） */
      entry.dropReplayUntilTurn = true;
      await withLoadTimeout(entry.client.loadSession(forked.sessionId, entry.cwd), loadTimeoutFor(entry.profile.remote));
      entry.cliSessionId = forked.sessionId;
      const rec2 = store.readRecord(sid);
      if (rec2) { rec2.cliSessionId = forked.sessionId; store.writeRecord(rec2); }
      /* 保留下来的回复在新后端里也在（messageId 原样拷过去）：锚点改到新后端，否则连着第二次编辑同一条会判成 other-backend */
      const remapped = store.remapBackendAnchors(sid, Array.isArray(keepIds) ? keepIds.map(String) : [], oldId, forked.sessionId);
      /* 分出来的后端握着保留下来的那段历史：不用再随下一条带快照 */
      markContextEstablished(sid, entry);
      /* load 回来是适配器默认的模型 / 模式（实测：opus / default）—— 设回这条会话记着的 */
      entry.engineOptionsReady = applyEngineModel(sid, entry).catch(() => {});
      await entry.engineOptionsReady;
      cliFailStreak.delete(oldId);
      logger.info('edit-fork', `forked sessionId=${sid} ${oldId} -> ${forked.sessionId} at ${plan.messageId} anchors-remapped=${remapped}`);
      return { mode: 'fork', newId: forked.sessionId };
    } catch (err: any) {
      entry.dropReplayUntilTurn = false;
      logger.warn('edit-fork', `fork failed sessionId=${sid}`, err);
      return fallback(tr('forking from before that message failed ({err})', { err: String(err?.message || err) }), 'fork-failed');
    } finally {
      reconfiguringSessions.delete(sid);
      emitSessionBusy(sid);
    }
  });

  /** 改写前的整份副本**每份文件**留多少份。要回滚也只会回到最近几版。 */
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
      /* 按文件留、按文件清（`backupsToPrune`）—— 改别的文件不会把这个文件的备份挤掉 */
      const at = path.join(backupDir, `${reviewBackupPrefix(want)}${stamp}`);
      fs.writeFileSync(at, bytes as any);
      try {
        const entries = fs.readdirSync(backupDir)
          .map((name) => { try { return { name, t: fs.statSync(path.join(backupDir, name)).mtimeMs }; } catch { return null; } })
          .filter((e): e is { name: string; t: number } => !!e);
        for (const name of reviewBackupsToPrune(entries, want, REVIEW_BACKUPS_KEPT)) {
          try { fs.rmSync(path.join(backupDir, name), { force: true }); } catch { /* 下次再说 */ }
        }
      } catch { /* 清理是 best-effort，不能拦住主流程 */ }
      return at;
    } catch { return null; }
  };

  /**
   * 渲染层给的 (会话, 路径) → 要写的那个绝对路径 + 能不能写 —— 两个 review 写盘通道共用这一道闸。
   *
   * 解析走**和读的时候同一个** `resolveUserPath(filePath, sessionId)`：相对路径落到这条会话自己的
   * `sessions/<id>/files/`。闸是"**这条会话**的标签页读过这一份"（`wasReviewed`）—— 不凭渲染进程说它想写哪儿。
   * 本机没有、而它是远程会话那台机器上的路径（`remoteFileFor`）并且这条会话读过它 → 带回 `remote`，写回经 ssh。
   * 判据在 `pickReviewTarget`（reviewAccess.ts，纯的、有测试）。
   */
  const reviewTarget = (sessionId: string | null | undefined, filePath: string): ReviewTarget<RemoteTarget> => {
    const t = pickReviewTarget<RemoteTarget>({
      raw: String(filePath || ''),
      resolveLocal: (raw) => resolveUserPath(raw, sessionId),
      localExists: (p) => fs.existsSync(p),
      remoteFor: (raw) => remoteFileFor(sessionId, raw),
      reviewed: (key) => wasReviewed(sessionId, key),
      /* advanced 会话（flow / skill）的文件不改 —— 审阅 / 演示稿的每一条写盘路都经过这里（备份、写回、改写、幻灯片文字 / 备注） */
      refuse: () => (sessionId ? refuseAdvancedOnly(sessionId, 'review-target') : null),
    });
    if (!t.ok && t.notPreviewed) {
      logger.warn('review', `refused: not previewed by session=${sessionId || '(none)'} (${String(filePath || '')})`);
    }
    return t;
  };

  /** 远端出错时给界面的那句话 —— 说清楚是连不上那台机器，不是"不成功"。 */
  const remoteWhy = (target: RemoteTarget, err: any): string =>
    tr('Cannot reach {host}, so nothing was written back this time ({err}). Submit again once it is reachable', { host: remoteHostLabel(target), err: String(err?.message || err).slice(0, 200) });

  /**
   * 远端文件写回：经 ssh 读那台机器上这一份 → 比 → **先备份到本机** `~/.kirolex/backups/review-files/` → 用
   * `remoteWriteScript` 写回同一个路径（先写临时文件再 mv）。判据和本地那份一样（`writeTextVia`）。
   */
  const writeRemoteReviewFile = async (
    sessionId: string | null | undefined, target: RemoteTarget, want: string, text: string, expectBase?: string,
  ): Promise<any> => {
    let failed: any = null;
    const r = await writeTextVia({
      max: WORKSPACE_PREVIEW_MAX_BYTES,
      read: async () => {
        try {
          const got = await remoteFileBytes(target, want);
          return got.kind === 'file' ? { size: got.size, bytes: got.buffer.length, text: got.buffer.toString('utf-8') } : null;
        } catch (err) { failed = err; throw err; }
      },
      backup: (prev) => !!saveReviewBackup(want, prev),
      write: async (body) => {
        try {
          await writeRemoteFile(target, remoteWriteScript(want, shellQuote), Buffer.from(body, 'utf-8').toString('base64'));
        } catch (err) { failed = err; throw err; }
      },
    }, text, expectBase);
    if (!r.ok) {
      if (failed) {
        logger.warn('review', `remote write failed ${target.sshHost}:${want}: ${failed?.message || failed}`);
        return { ok: false, error: remoteWhy(target, failed) };
      }
      return r;
    }
    if (!r.unchanged) logger.info('review', `wrote ${target.sshHost}:${want} (${text.length} chars, was ${r.was}) session=${sessionId || '(none)'}`);
    return { ...r, path: want };
  };

  /**
   * **拷一份，什么都不改** —— 侧栏 review 的「提交给这份文件的会话」那条路要用。
   *
   * 那条路是**会话自己写这个文件**（意见拼成一条普通消息发过去），走不到 `review:write-file` 里那段
   * "写前拷一份"。备在**发之前**：文件在它落笔前一个字节都没变，这时拷的就是"改之前"。
   */
  ipcMain.handle('review:backup-file', async (_event, sessionId: string | null | undefined, filePath: string) => {
    { const advRefused = sessionId ? refuseAdvancedOnly(sessionId, 'review:backup-file') : null; if (advRefused) return { ok: false, error: advRefused }; }
    const t = reviewTarget(sessionId, filePath);
    if (!t.ok) return t;
    /* 远端文件：从那台机器读出来，存本机 —— 只备份读得全的（ssh 回来的是前 512KB），读不全就说清楚 */
    if (t.remote) {
      try {
        const got = await remoteFileBytes(t.remote, t.want);
        if (got.kind !== 'file') return { ok: false, error: tr('No such file on {host}: {path}', { host: remoteHostLabel(t.remote), path: t.want }) };
        if (got.size > got.buffer.length) return { ok: false, error: tr('This file is larger than the preview limit (512KB), so it was not backed up') };
        const at = saveReviewBackup(t.want, got.buffer);
        if (!at) return { ok: false, error: tr('Backup could not be written') };
        logger.info('review', `backed up ${t.remote.sshHost}:${t.want} -> ${at} (${got.buffer.length} bytes)`);
        return { ok: true, at, bytes: got.buffer.length };
      } catch (error: any) {
        return { ok: false, error: remoteWhy(t.remote, error) };
      }
    }
    try {
      const bytes = fs.readFileSync(t.want);
      const at = saveReviewBackup(t.want, bytes);
      if (!at) return { ok: false, error: tr('Backup could not be written') };
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
   * 远端文件（远程会话那台机器上的）经 ssh 写回同一个路径（`writeRemoteReviewFile`）。
   */
  const writeReviewFile = async (sessionId: string | null | undefined, filePath: string, text: string, expectBase?: string): Promise<any> => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: tr('The content is empty, so nothing was written') };
    { const advRefused = sessionId ? refuseAdvancedOnly(sessionId, 'review:write-file') : null; if (advRefused) return { ok: false, error: advRefused }; }
    const t = reviewTarget(sessionId, filePath);
    if (!t.ok) return t;
    if (t.remote) return writeRemoteReviewFile(sessionId, t.remote, t.want, text, expectBase);
    const want = t.want;
    try {
      let previous = '';
      try {
        if (fs.statSync(want).size > WORKSPACE_PREVIEW_MAX_BYTES) {
          return { ok: false, error: tr('This file is larger than the preview limit (512KB). The preview only holds the first part, and writing it back would cut off the rest, so nothing was written') };
        }
        previous = fs.readFileSync(want, 'utf-8');
      } catch {
        return { ok: false, error: tr('This file cannot be read right now. KiroLex will not create it; check that the path is right first') };
      }
      if (typeof expectBase === 'string' && previous !== expectBase) {
        return { ok: false, mismatch: true, error: tr('This file was changed by something else during the revision, so this result was not written. Look at the new text and submit again') };
      }
      if (previous === text) return { ok: true, path: want, unchanged: true };
      if (!saveReviewBackup(want, previous)) {
        return { ok: false, error: tr('Backup before writing failed: there is no copy to roll back to, so nothing was changed. Check that ~/.kirolex/backups is writable.') };
      }
      fs.writeFileSync(want, text, 'utf-8');
      logger.info('review', `wrote ${want} (${text.length} chars, was ${previous.length}) session=${sessionId || '(none)'}`);
      return { ok: true, path: want, bytes: text.length, was: previous.length };
    } catch (error: any) {
      return { ok: false, error: String(error?.message || error) };
    }
  };
  /** 只读：按和 `writeReviewFile` 同样的规则解析路径，读出盘上此刻的正文；读不到给 `null`。 */
  const readReviewFile = async (sessionId: string | null | undefined, filePath: string): Promise<string | null> => {
    const t = reviewTarget(sessionId, filePath);
    if (!t.ok) return null;
    if (t.remote) {
      try {
        const got = await remoteFileBytes(t.remote, t.want);
        return got.kind === 'file' ? got.buffer.toString('utf-8') : null;
      } catch { return null; }
    }
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
  /**
   * 同一张 ticket 的这一档**正在排 / 在跑**（`revisesInFlight`）→ 返回那一次，调用方合并过去；**已经写完了** → 返回"取消"
   * （渲染层不把意见放回去，也不再做一遍）；都不是 → null，照常做。deck 一页版面文字那条用它；
   * `review:revise-in-session` 自己内联着同一套判断。
   */
  const reviseAlready = (ticket: unknown, scope: string): Promise<any> | { ok: false; cancelled: true; alreadyDone: true } | null => {
    const t = typeof ticket === 'string' && ticket ? ticket : undefined;
    if (!t) return null;
    const running = revisesInFlight.get(`${t}|${scope}`);
    if (running) { logger.warn('revise', `duplicate request ticket=${t} scope=${scope} —— 合并到正在排 / 正在跑的那一次`); return running; }
    if (doneTickets.has(t)) { logger.info('revise', `ticket=${t} 已经写完 —— 不再做一遍`); return { ok: false, cancelled: true, alreadyDone: true }; }
    return null;
  };
  ipcMain.handle('review:tickets-done', async (_event, tickets: string[]) =>
    (Array.isArray(tickets) ? tickets : []).filter((t) => doneTickets.has(String(t))));
  /**
   * 这几张 ticket **后来怎样了**（见 `renderer/reviewResume.ts` 的 `TicketStatus`）：还在排 / 跑（`revisesInFlight`）、
   * 写完了（`doneTickets`）、怎么结束的（`reviseOutcomes`）、不记得（主进程重启过）。窗口 reload 回来，渲染层据此决定
   * 你再提交同一条意见时是沿用这张 ticket（合并到那一次 / 按同一个 messageId 重试）还是新起一次。
   */
  ipcMain.handle('review:tickets-status', async (_event, tickets: string[]) => {
    const live = new Set([...revisesInFlight.keys()].map((k) => k.slice(0, k.lastIndexOf('|'))));
    const out: Record<string, 'live' | 'done' | 'retry' | 'final' | 'unknown'> = {};
    for (const raw of Array.isArray(tickets) ? tickets : []) {
      const t = String(raw);
      out[t] = live.has(t) ? 'live' : doneTickets.has(t) ? 'done' : reviseOutcomes.get(t) ?? 'unknown';
    }
    return out;
  });

  /** 在某条会话里留一行 **KiroLex 自己说的话**（改写落盘之后报一句"写进去了"）—— 不发给模型，见 `noteInSession`。 */
  ipcMain.handle('session:note', async (_event, sessionId: string, text: string, variants?: unknown) => {
    return noteInSession(sessionId, text, asVariants(variants)) ? { ok: true } : { ok: false };
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
  const askOnce = (sessionId: string, prompt: string, displayText: string, messageId?: string): Promise<{ text: string; stopReason: string; wedged: boolean }> =>
    /* 同一问早就完整答过了（同一次改写的重试）：用盘上那份，不再发给模型第二遍 —— 见 `storedReplyFor` */
    storedReplyFor(sessionId, messageId) ?? new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        askWaiters.delete(sessionId);
        reject(new Error(tr('No reply after waiting 8 minutes')));
      }, 8 * 60 * 1000);
      askWaiters.set(sessionId, { resolve, timer });
      /** 还挂着的是**这一次**的等待者就摘掉 —— 返回摘没摘 */
      const drop = (): boolean => {
        const w = askWaiters.get(sessionId);
        if (w && w.timer === timer) { askWaiters.delete(sessionId); clearTimeout(w.timer); return true; }
        return false;
      };
      /* `messageId`：侧栏改写按 ticket 给的（`reviseMessageId`）—— 同一次提交只落盘一次、只发一次 */
      promptsInFlight.run(sessionId, messageId, () => sendPromptOnce(sessionId, [{ type: 'text', text: prompt }], undefined, { displayText, ...(messageId ? { messageId } : {}) })).then(() => {
        if (drop()) reject(new Error(tr('This turn did not finish normally (it was cancelled or got no reply)')));
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
    /*
      **同一张 ticket 的同一档又来一次 → 合并到正在排 / 正在跑的那一次** —— 不再排第二次、不再出第二条「已排队」、
      不再往会话里发第二遍（「改写提交重复 11 次」）。要在 `openTicket` 之前判：它会把这张 ticket 的取消标记重置掉。
    */
    const ticketIn = typeof input?.ticket === 'string' && input.ticket ? input.ticket : undefined;
    const scopeKey = input?.scope === 'patch' ? 'patch' : input?.scope === 'insert' ? 'insert' : 'block';
    const dupKey = ticketIn ? `${ticketIn}|${scopeKey}` : '';
    const already = dupKey ? revisesInFlight.get(dupKey) : undefined;
    if (already) {
      logger.warn('revise', `duplicate request ticket=${ticketIn} scope=${scopeKey} —— 合并到正在排 / 正在跑的那一次`);
      return already;
    }
    /* 这张 ticket 已经写完盘了（窗口 reload 期间做完的那种）：不再做一遍 —— 渲染层按取消收尾，不把意见放回去 */
    if (ticketIn && doneTickets.has(ticketIn)) {
      logger.info('revise', `ticket=${ticketIn} 已经写完盘 —— 不再做一遍`);
      return { ok: false, cancelled: true, alreadyDone: true };
    }
    const sessionId = String(input?.sessionId || '').trim();
    const note = String(input?.note ?? '').trim();
    const where = String(input?.where ?? '');
    const tk = openTicket(typeof input?.ticket === 'string' ? input.ticket : undefined, sessionId);
    if (!sessionId) return { ok: false, error: tr('This tab does not belong to a session, so there is nowhere to ask') };
    if (!note) return { ok: false, error: tr('No comment given') };
    if (deletedSessionIds.has(sessionId)) return { ok: false, error: tr('This session has been deleted') };
    if (store.readRecord(sessionId)?.archived) return { ok: false, error: tr('This session is archived. Unarchive it before revising in it') };
    /*
      **正忙就排队，不是报错**：排到这条会话的队尾（`enqueueRevise`），轮到了再等它空下来（`waitIdle`）——
      插进一轮正在跑的对话里，改写会和它正在做的事混在一起。
    */
    /** 这次提交最近问过模型的那一问的 messageId —— 失败时据它判还能不能按同一次接着来（`retrySameIf`）。 */
    let askedId: string | undefined;
    const job = enqueueRevise(sessionId, async () => {
      try { return await reviseOnce(); } finally { tk.close(); }
    }, input?.label || tr('Revision'), ticketIn);
    /* 怎么结束的记下来 —— 窗口 reload 期间结束的，回来时按它决定沿用还是新起（`review:tickets-status`） */
    job.then((res) => recordReviseOutcome(ticketIn, res), () => {});
    if (dupKey) {
      revisesInFlight.set(dupKey, job);
      job.finally(() => { if (revisesInFlight.get(dupKey) === job) revisesInFlight.delete(dupKey); }).catch(() => {});
    }
    return job;

    async function reviseOnce() {
      /* 排队期间被取消了 —— 一个字都不发 */
      if (tk.cancelled()) return { ok: false, cancelled: true };
      await ensureAttached(sessionId);
      /*
        **还没问到模型就停下的那些都带 `retrySame`**（挂不上 —— 远端还连不上、等空闲超时、别的改写在等回复、闸没过……）：
        这一问没拿到完整回复，渲染层把这张 ticket 留着，下次提交还是同一次（同一个 messageId，盘上那条不再追加）。
        不带的话主进程记成 `final`、渲染层也不留 ticket —— 连续断网时第三次提交就换了编号，同一条又落一次。
      */
      if (!sessionClients.get(sessionId)) return { ok: false, error: tr('Cannot connect to this session. Click it to connect, then try again'), retrySame: true };
      const stillBusy = await waitIdle(sessionId, 20 * 60 * 1000);
      if (stillBusy) { noteReviseGaveUp(sessionId, input?.label || tr('Revision'), note, stillBusy); return { ok: false, error: tr('This session is still busy after waiting 20 minutes ({busy})', { busy: stillBusy }), retrySame: true }; }
      if (askWaiters.has(sessionId)) return { ok: false, error: tr('A revision is already waiting for a reply in this session'), retrySame: true };
      /* 等它空下来的那段时间里被取消了 —— 同样不发 */
      if (tk.cancelled()) return { ok: false, cancelled: true };
      /* 白名单而不是透传：这个值来自渲染进程，越界的写法落回默认那一档 */
      const wantScope = input?.scope === 'patch' ? 'patch' : input?.scope === 'insert' ? 'insert' : 'block';
      /* patch 的行号按哪一份编，拼回去就得按同一份拼 —— 有 apply 就用它的 base */
      const patchBase = typeof input?.apply?.base === 'string' ? input.apply.base
        : typeof input?.full === 'string' ? input.full : undefined;
      if (wantScope === 'patch' && patchBase === undefined) return { ok: false, error: tr('The text was not included, so it cannot be edited by line number'), retrySame: true };
      /* 要由主进程写回的，**先看闸** —— 不然模型白改一遍，最后才发现写不回去（"改好了却写不回去"） */
      const gate = input?.apply && typeof input.apply.path === 'string' ? reviewTarget(sessionId, input.apply.path) : null;
      if (gate && !gate.ok) return { ok: false, error: gate.error, retrySame: true };
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
          input?.label ? tr('[Revision · {label}] {note}', { label: input.label, note }) : tr('[Revision] {note}', { note }),
          /* id 跟着 ticket 走：同一次提交只落盘一次、只发一次（`reviseMessageId`）；记下来，失败时据它判能不能接着来 */
          (askedId = reviseMessageId(input?.ticket, wantScope, prompt)),
        ).finally(() => tk.asking(false));
        if (tk.cancelled()) return { ok: false, cancelled: true };
        const usable = replyUsable({ stopReason: reply.stopReason, wedged: reply.wedged });
        if (!usable.ok) {
          logger.warn('revise', `in-session ${sessionId}: ${usable.why}`);
          /* 没得到完整回复：模型还什么都没做才算"还是同一次"（`retrySameIf`）—— 已经出过字 / 跑过工具的不再按同一次来 */
          return { ok: false, error: usable.why, ...retrySameIf(sessionId, askedId) };
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
        out.text = keepHeading(where, out.text, wantScope);
        logger.info('revise', `in-session ${sessionId} scope=${wantScope}: ${out.text.length} chars in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        const apply = input?.apply;
        if (apply && typeof apply.base === 'string' && typeof apply.path === 'string') {
          const fullText = applyRevision(apply, out.text);
          if (fullText === null) return { ok: false, error: tr('Could not splice it back in (the position does not match), so nothing was written') };
          const wrote = await writeReviewFile(sessionId, apply.path, fullText, apply.base);
          /*
            盘上和渲染层手里那一份对不上（换行符、别的改动……）：主进程不写，把结果照老样子交回去，由渲染层按它手里那份拼、写 ——
            和以前一样，只是少了"窗口不在也不丢"那层保险。不能因为这一层就让改写整个失败。
          */
          if (!wrote?.ok && wrote?.mismatch) return { ok: true, text: out.text, scope: wantScope };
          if (!wrote?.ok) return { ok: false, error: wrote?.error || tr('Could not write to this file') };
          markTicketDone(input?.ticket);
          /* 窗口可能不在 —— 落盘这件事由主进程自己在会话里说一句 */
          noteInSession(sessionId, tr('✅ Revised {what} as commented (now {chars} characters)\nFile: {path}\nBacked up to ~/.kirolex/backups/review-files/ before writing.', { what: input?.label || tr('this file'), chars: fullText.length, path: wrote.path || apply.path }));
          return { ok: true, text: out.text, scope: wantScope, written: true, fullText };
        }
        /* 回报实际走的那一档 —— 渲染端的「＋」靠它确认主进程认得 insert（旧主进程会把它当 block，回来的是改过的原文） */
        return { ok: true, text: out.text, scope: wantScope };
      } catch (err: any) {
        /* 我们自己停的那一轮：askOnce 会以"没有正常结束"拒掉 —— 那不是失败，是取消 */
        if (tk.cancelled()) return { ok: false, cancelled: true };
        logger.warn('revise', `in-session ${sessionId} failed: ${err?.message || err}`);
        /*
          **在会话里说清楚没做成** —— 那条【改写 · …】已经落在会话里了，后面什么都没有的话，看着像"发出去了没人理"，
          于是再点一次（实测同一条在会话里出现了 11 次）。重复提交被拒的那种不说：那一次本来就有结果。
        */
        if (err?.code !== DUPLICATE_MESSAGE && err?.code !== DUPLICATE_STARTED) {   // 后一种主进程已经在会话里说过了
          const why = String(err?.message || err).split('\n')[0].slice(0, 200);
          noteInSession(sessionId, tr('❌ The revision of {what} did not go through: {err}\nYour comment is back in the side panel. Press ✓ to submit it again when ready.', { what: input?.label || tr('this file'), err: why }));
        }
        /* 没拿到完整回复（网络断了、超时、没正常收尾）：再提交同一条意见时用回这张 ticket —— 重复被拒的那种不用 */
        return { ok: false, error: String(err?.message || err), ...retrySameIf(sessionId, askedId, err) };
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
      /* 写盘（远端文件走 ssh）是异步的：先拼，拼成了再写，写的结果按同一套判据收（`patchWritten`） */
      const onDisk = canWrite ? await readReviewFile(sessionId, apply!.path) : undefined;
      const settled = settlePatchRevision({
        replyText, base, followedUp,
        /* 要追问之前先看一眼盘上那一份 —— 已经被改过就不追问，直接报冲突 */
        onDisk: canWrite ? () => onDisk : undefined,
      });
      const res = settled.ok && canWrite
        ? patchWritten(settled, await writeReviewFile(sessionId, apply!.path, settled.fullText, base))
        : settled;
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
        noteInSession(sessionId, tr('✅ Revised {what} as commented ({n} change(s), now {chars} characters)\nFile: {path}\nBacked up to ~/.kirolex/backups/review-files/ before writing.', { what: input?.label || tr('this file'), n: res.changes.length, chars: res.fullText.length, path: res.path || apply!.path }));
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
      /* 追问那一问还没发出去就停下：同上，带 `retrySame`（第一问答过了，重试时用盘上那份，追问照常再问） */
      if (stillBusy) { noteReviseGaveUp(sessionId, input?.label || tr('Revision'), note, stillBusy); return { ok: false, error: tr('The reply was in the wrong format. KiroLex wanted to ask once more, but the session is still busy after 20 minutes ({busy})', { busy: stillBusy }), retrySame: true }; }
      if (tk.cancelled()) return { ok: false, cancelled: true };
      if (askWaiters.has(sessionId)) return { ok: false, error: tr('The reply was in the wrong format. KiroLex wanted to ask once more, but another revision is already waiting for a reply in this session'), retrySame: true };
      tk.asking(true);
      const again = await askOnce(
        sessionId, followUp,
        input?.label
          ? tr('[Revision · {label}] The previous reply was in the wrong format, resubmitting', { label: input.label })
          : tr('[Revision] The previous reply was in the wrong format, resubmitting'),
        (askedId = reviseMessageId(input?.ticket, 'patch', followUp, true)),
      ).finally(() => tk.asking(false));
      if (tk.cancelled()) return { ok: false, cancelled: true };
      const usable = replyUsable({ stopReason: again.stopReason, wedged: again.wedged });
      if (!usable.ok) {
        logger.warn('revise', `in-session ${sessionId} follow-up: ${usable.why}`);
        return { ok: false, error: usable.why, ...retrySameIf(sessionId, askedId) };
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
      looked.push(tr('{name} on PATH ({cmd})', { name, cmd: process.platform === 'win32' ? 'where' : 'command -v' }));
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
    if (!String(rawPath || '').trim()) return { ok: false, why: tr('No file specified') };
    let file: string;
    try { file = resolveUserPath(String(rawPath), sessionId); } catch (e: any) { return { ok: false, why: String(e?.message || e) }; }
    if (!isPreviewable(file)) return { ok: false, why: tr('This kind of file does not use this preview: {name}', { name: path.basename(file) }) };
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return { ok: false, why: tr('Cannot read this file: {file}', { file }) }; }
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
        notesWhy = err instanceof NoPythonPptx ? err.message : tr('Could not read the speaker notes: {err}', { err: pyError(err) });
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
        if (!made) throw new Error(tr('{bin} finished but produced no PDF', { bin: soffice }));
        fs.renameSync(path.join(stage, made), path.join(stage, 'deck.pdf'));
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.renameSync(stage, outDir);
        logger.info('preview', `converted ${file} via ${soffice} key=${key}`);
        keepNewestIn(previewsRoot, PREVIEW_CACHE_KEPT, '预览缓存');
        return { ok: true, pdf: cached };
      } catch (err: any) {
        fs.rmSync(stage, { recursive: true, force: true });
        const why = err?.killed || /timed? ?out/i.test(String(err?.message || ''))
          ? tr('Converting to PDF timed out ({sec}s). You can use "↗ Open file" in the top bar to hand it to the system app', { sec: PREVIEW_TIMEOUT_MS / 1000 })
          : tr('Converting to PDF failed: {err}', { err: String(err?.message || err).slice(0, 200) });
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
    try { file = resolveUserPath(String(rawPath || ''), sessionId); } catch { return { ok: false, why: tr('Invalid path') }; }
    if (!/\.pdf$/i.test(file)) return { ok: false, why: tr('Only .pdf paths are accepted') };
    const rel = path.relative(previewsRoot, file);
    const inCache = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (!inCache && !wasReviewed(sessionId, file)) {
      logger.warn('preview', `refused pdf bytes: ${file} (session=${sessionId || '(none)'})`);
      return { ok: false, why: tr('This PDF was not opened by a tab of this session') };
    }
    try {
      const buf = fs.readFileSync(file);
      return { ok: true, base64: buf.toString('base64'), bytes: buf.length };
    } catch (err: any) {
      return { ok: false, why: tr('Cannot read this PDF: {err}', { err: String(err?.message || err).slice(0, 160) }) };
    }
  });

  /** deck 写盘那几条共用的闸：会话 + 路径 → 要写的那个 `.pptx`（解析、读过、只认 `.pptx`、页码）。 */
  const deckTarget = (sessionId: string | null | undefined, filePath: string, page: number):
    { ok: true; want: string; at: number } | { ok: false; error: string } => {
    const t = reviewTarget(sessionId, filePath);
    if (!t.ok) return t;
    if (t.remote) return { ok: false, error: tr('This deck is on {host}. It can only be previewed, not edited page by page here', { host: remoteHostLabel(t.remote) }) };
    if (!canEditDeck(t.want)) return { ok: false, error: tr('Only .pptx can be edited this way (.ppt / .odp / documents can only be previewed and submitted as a whole)') };
    const at = Number(page);
    if (!Number.isInteger(at) || at < 1) return { ok: false, error: tr('Invalid page number') };
    return { ok: true, want: t.want, at };
  };
  /** 这份 deck 在盘上此刻的样子（mtime + 大小）—— 等回复的那几十秒里它被别的改动动过没有，靠比这个。 */
  const deckStamp = (want: string): string => {
    try { const st = fs.statSync(want); return `${st.mtimeMs}:${st.size}`; } catch { return ''; }
  };
  /**
   * 等回复期间 pptx 被别的改动动过（会话自己改了它、你在 PowerPoint 里存了一下）时的返回值 —— **不写**：
   * 改一页文字用的地址（`形状.段.run`）、讲稿那一页的原文都是按改之前那一份来的，照写就是改错了框、盖掉了那次改动。
   */
  const deckChanged = (want: string, page: number) => {
    logger.warn('deck', `${path.basename(want)} changed while waiting for the reply; page ${page} not written`);
    return { ok: false, conflict: true, error: tr('This file was changed by something else while waiting for the reply; this result was not written. Refresh, check the new text, and submit again') };
  };
  /** 写前二进制备份；拷不成返回那句错误（调用方据此**不写**）。 */
  const backupDeck = (want: string): string | null => {
    try {
      if (!saveReviewBackup(want, fs.readFileSync(want))) {
        return tr('Backup before writing failed: there is no copy to roll back to, so nothing was changed. Check that ~/.kirolex/backups is writable.');
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
  /*
    `expect`（可选）：这条讲稿意见是对着哪一份讲稿提的（渲染层提交那一刻看到的那一页）。等回复的那十几秒里
    这一页的讲稿被别的改动改过（会话自己动了 pptx、你在 PowerPoint 里改了），照写就是把那次改动整页盖掉 —— 那时不写。
  */
  ipcMain.handle('deck:write-note', async (_event, sessionId: string | null | undefined, filePath: string, page: number, text: string, expect?: unknown) => {
    { const advRefused = sessionId ? refuseAdvancedOnly(sessionId, 'deck:write-note') : null; if (advRefused) return { ok: false, error: advRefused }; }
    const g = deckTarget(sessionId, filePath, page);
    if (!g.ok) return g;
    const { want, at } = g;
    try {
      const beforeStat = fs.statSync(want);
      if (typeof expect === 'string') {
        let now: string[] | null = null;
        try { now = parseNotesResult(await runPy(NOTES_SCRIPT, [want]))?.notes ?? null; } catch { now = null; }
        if (noteChanged(now, at, expect)) return deckChanged(want, at);
      }
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
    if (!rows.length) return { ok: false, error: tr('No changes to write (addresses must look like `2.0.0`)') };
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
    if (!rows.length) return { ok: false, error: tr('No layout instructions to run') };
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
    { const dup = reviseAlready(input?.ticket, 'slide'); if (dup) return dup; }
    const sid = String(input?.sessionId || '').trim();
    const note = String(input?.note || '').trim();
    if (!sid) return { ok: false, error: tr('This file does not belong to a session, so there is nowhere to ask') };
    { const advRefused = refuseAdvancedOnly(sid, 'deck:revise-slide-text'); if (advRefused) return { ok: false, error: advRefused }; }
    if (!note) return { ok: false, error: tr('No comment given') };
    const g = deckTarget(sid, String(input?.filePath || ''), Number(input?.page));
    if (!g.ok) return g;
    const { want, at: page } = g;
    if (!(await findPythonPptx())) return { ok: false, error: noPythonPptxWhy(process.platform) };
    const tk = openTicket(typeof input?.ticket === 'string' ? input.ticket : undefined, sid);
    let slideAsk: string | undefined;
    return enqueueRevise(sid, async () => {
      if (tk.cancelled()) { tk.close(); return { ok: false, cancelled: true }; }
      await ensureAttached(sid);
      if (!sessionClients.get(sid)) { tk.close(); return { ok: false, error: tr('Cannot connect to this session. Click it to connect, then try again'), retrySame: true }; }
      const stillBusy = await waitIdle(sid, 20 * 60 * 1000);
      if (stillBusy) { tk.close(); noteReviseGaveUp(sid, tr('{file} slide {page} text', { file: path.basename(want), page }), note, stillBusy); return { ok: false, error: tr('This session is still busy after waiting 20 minutes ({busy})', { busy: stillBusy }), retrySame: true }; }
      if (askWaiters.has(sid)) { tk.close(); return { ok: false, error: tr('A revision is already waiting for a reply in this session'), retrySame: true }; }
      if (tk.cancelled()) { tk.close(); return { ok: false, cancelled: true }; }
      try {
        /* 地址是按**这一份**编的 —— 等回复期间被改过就不按旧地址写（见 `deckChanged`） */
        const stampBefore = deckStamp(want);
        /* 先把这一页现有的文字读出来 —— 模型要按地址回，就得先看见地址 */
        const cur = parseSlideRuns(await runPy(SLIDE_TEXT_SCRIPT, [want, String(page)]));
        if (!cur.ok) return { ok: false, error: cur.error, retrySame: true };
        if (!cur.runs.length && !cur.shapes?.length) return { ok: false, error: tr('This slide has no editable text (it may only have images)') };
        const prompt = reviseSlideTextPrompt({
          runs: cur.runs, note, page, path: want,
          ...(cur.shapes?.length ? { shapes: cur.shapes } : null),
          ...(cur.page ? { pageW: cur.page.w, pageH: cur.page.h } : null),
        });
        const started = Date.now();
        tk.asking(true);
        const reply = await askOnce(sid, prompt, tr('[Revision · {file} page {page} slide text] {note}', { file: path.basename(want), page, note }), (slideAsk = reviseMessageId(input?.ticket, 'slide', prompt)))
          .finally(() => tk.asking(false));
        /* 我们自己停的那一轮 —— 回复不用，也不写 */
        if (tk.cancelled()) return { ok: false, cancelled: true };
        const usable = replyUsable({ stopReason: reply.stopReason, wedged: reply.wedged });
        if (!usable.ok) return { ok: false, error: usable.why, ...retrySameIf(sid, slideAsk) };
        const got = parseSlideEdits(reply.text);
        if (!got.edits.length && !got.ops.length) {
          /* 一条都没解析出来时把它回的原话记下来 —— 否则这个失败查不了 */
          if (!got.cannot) logger.warn('deck', `slide text: 一条都没解析出来 (page ${page})，它回的是：\n${String(reply.text).slice(0, 600)}`);
          return { ok: false, ...(got.cannot ? { cannot: got.cannot } : { error: tr('The reply contained no usable change lines') }) };
        }
        logger.info('deck', `slide: ${got.edits.length} 处文字 + ${got.ops.length} 条版面指令 for page ${page}`
          + ` in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        if (deckStamp(want) !== stampBefore) return deckChanged(want, page);
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
              ? { ok: true, changed, partial: tr('The layout changes did not go through: {err}', { err: String(wroteOps.error) }) }
              : wroteOps;
          }
          changed += Number(wroteOps.changed) || 0;
        }
        markTicketDone(input?.ticket);
        return { ok: true, changed };
      } catch (err: any) {
        if (tk.cancelled()) return { ok: false, cancelled: true };
        logger.warn('deck', `slide text revise failed: ${err?.message || err}`);
        /* 没拿到完整回复 / 还没问到模型：同一次提交可以接着来（retrySame）；重复被拒的那种不算 */
        return { ok: false, error: err instanceof NoPythonPptx ? err.message : String(err?.message || err), ...(slideAsk ? retrySameIf(sid, slideAsk, err) : { retrySame: true as const }) };
      } finally {
        tk.close();
      }
      /* 同一张 ticket 的排队提示只说一次；在跑期间登记（再来就合并）、结束时记结局 —— `enqueueRevise` 的 track */
    }, tr('{file} slide {page} text', { file: path.basename(want), page }), input?.ticket, 'slide');
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'prime-history'); if (advRefused) return { ok: false, error: advRefused }; }
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'ensure-context'); if (advRefused) return { ok: false, error: advRefused }; }
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'set-prime-mode'); if (advRefused) return { ok: false, error: advRefused }; }
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
      ...creations.ids(),
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
    if (!entry) throw new Error(tr('Session not connected'));
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

  /** 回答 / 跳过一张提问卡片（`answerQuestion`）。 */
  ipcMain.handle('acp:answer-question', (_event, sessionId: string, cardId: string, action: 'accept' | 'decline', values?: Record<string, unknown>) =>
    answerQuestion(String(sessionId || ''), String(cardId || ''), action === 'decline' ? 'decline' : 'accept', values && typeof values === 'object' ? values : {}));
  /** 切走一条会话时：取消它挂着的提问（`cancelQuestionsFor`）。 */
  ipcMain.handle('acp:cancel-questions', (_event, sessionId: string) => cancelQuestionsFor(String(sessionId || '')));
  /** 还挂着的提问卡片（窗口重载后补回来）。 */
  ipcMain.handle('acp:pending-questions', () => pendingQuestionsFor());

  /** Read this session's run event log (timeline + event stream views). */
  ipcMain.handle('acp:read-events', (_event, sessionId: string, limit?: number) => {
    if (!sessionId) return { events: [], path: '', truncated: false };
    return eventLog.readEvents(sessionId, Math.min(Math.max(1, Number(limit) || 4000), 20000));
  });

  // Write-once project assignment (design §6.4). Allowed only for the
  // null/undefined -> concrete transition; project->project or un-set is
  // rejected. Persists to the durable record and syncs any live executor.
  ipcMain.handle('acp:assign-project', async (_event, sessionId: string, projectId: string) => {
    { const advRefused = refuseAdvancedProject(projectId, 'assign-project'); if (advRefused) throw new Error(advRefused); }
    { const advRefused = refuseAdvancedOnly(sessionId, 'assign-project'); if (advRefused) throw new Error(advRefused); }
    const rec = store.readRecord(sessionId);
    if (!rec) throw new Error(tr('No such session'));
    if (!canAssignProjectId(rec.profile.projectId, projectId)) {
      throw new Error(tr('projectId is write-once; it cannot be changed once set.'));
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
    /* 改名 / 删项目时成批调：advanced 的那条跳过，不报错（它本来就不在标准版的列表里） */
    if (refuseAdvancedOnly(sessionId, 'set-project')) return { sessionId, projectId, skipped: true };
    { const advRefused = refuseAdvancedProject(projectId, 'set-project'); if (advRefused) throw new Error(advRefused); }
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
    { const advRefused = refuseAdvancedProject(projectId, 'move-session'); if (advRefused) throw new Error(advRefused); }
    { const advRefused = refuseAdvancedOnly(sessionId, 'move'); if (advRefused) throw new Error(advRefused); }
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
    /* 后端自己起的那一轮（autonomousTurn.ts）在输出：一样推迟 —— 现在 detach 会截断它；由它的收尾（autonomousDeps.finish）先落盘再消化 */
    if (!busy && sessionClients.get(sessionId)?.autonomous) {
      pendingProjectReset.add(sessionId);
      sessionNotice(sessionId, tr('Project changed to **{project}**; the memory scope switches after this turn ends.', { project: projectId || tr('Unassigned') }));
      logger.info('session', `移动项目 sessionId=${sessionId} -> ${projectId || '(未分组)'}（后端自己起的一轮在输出，执行器重置推迟到它结束）`);
      return { sessionId, projectId: projectId ?? null, deferredReset: true };
    }
    if (busy) {
      /* 这一轮结束再重置：`pendingProjectReset` 由 prompt 的收尾去消化 */
      pendingProjectReset.add(sessionId);
      sessionNotice(sessionId, tr('Project changed to **{project}**; the memory scope switches after this turn ends.', { project: projectId || tr('Unassigned') }));
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

  /* local_browser 的设置 / 状态 / 确认框（`localBrowserHost.ts`） */
  ipcMain.handle('browser:get-status', async () => localBrowser().status());
  ipcMain.handle('browser:set-config', async (_event, patch: any) => {
    const clean: Record<string, any> = {};
    if (typeof patch?.enabled === 'boolean') clean.enabled = patch.enabled;
    if (patch?.browser === 'auto' || isBrowserKind(patch?.browser)) clean.browser = patch.browser;
    if (patch?.firefoxPort !== undefined) clean.firefoxPort = Number(patch.firefoxPort);
    return localBrowser().setConfig(clean);
  });
  ipcMain.handle('browser:connect', async (_event, kind: unknown) => {
    if (!isBrowserKind(kind)) return { ok: false, error: 'unknown browser' };
    return localBrowser().connect(kind);
  });
  ipcMain.handle('browser:restart-firefox', async () => localBrowser().restartFirefox());
  ipcMain.handle('browser:domain-reply', async (_event, id: string, decision: string) => ({ ok: localBrowser().answer(id, decision) }));
  ipcMain.handle('browser:pending-asks', async () => (localBrowserHost ? localBrowserHost.pendingAsks() : []));

  /* 「远程会话从本机转发的 MCP」名单：对下一条远程会话生效（准备时现读） */
  ipcMain.handle('app:get-forward-mcp', async () => loadForwardMcpList());
  ipcMain.handle('app:set-forward-mcp', async (_event, list: unknown) => {
    const saved = saveForwardMcpList(list);
    logger.info('localmcp', `远程会话从本机转发的 MCP 名单 = ${saved.map((it) => `${it.name}(${it.timeoutSec}s)`).join(', ') || '（空）'}`);
    return { ok: true, list: saved };
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'archive'); if (advRefused) throw new Error(advRefused); }
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
    if (refuseAdvancedProject(projectId, 'delete-project-memory')) return { projectId, skipped: true };
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
    if (refuseAdvancedOnly(sessionId, 'set-auto-resent')) return { ok: false };
    const map = loadAutoResent();
    if (key) map[sessionId] = String(key); else delete map[sessionId];
    saveAutoResent(map);
    return { ok: true };
  });

  ipcMain.handle('app:get-draft-pastes', () => loadDraftPastes());
  ipcMain.handle('app:set-draft-pastes', (_event, sessionId: string, blocks: any[]) => {
    if (!sessionId) return { ok: false };
    if (refuseAdvancedOnly(sessionId, 'set-draft-pastes')) return { ok: false };
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
  ) => {
    { const advRefused = refuseAdvancedOnly(sessionId, 'truncate-transcript'); if (advRefused) throw new Error(advRefused); }
    return store.truncateTranscriptBefore(sessionId, messageId);
  });

  // Rewrite the transcript to exactly the given messages (edit-and-rerun). Robust
  // against renderer messages that were never persisted under that id (steers).
  ipcMain.handle('acp:rewrite-transcript', async (
    _event,
    sessionId: string,
    messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: store.StoredToolCall[] }>,
  ) => {
    { const advRefused = refuseAdvancedOnly(sessionId, 'rewrite-transcript'); if (advRefused) throw new Error(advRefused); }
    // 经控制入口发的（id 带标记）：渲染层漏带了显式来源 via 也补回去
    const next = (Array.isArray(messages) ? messages : [])
      .map((m) => ({ ...m, ...(isControlMessageId(m?.id) ? { via: 'control' as const } : {}), ...(isSessionMessageId(m?.id) ? { via: 'session' as const } : {}) }));
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
        return { ok: false, error: tr('The messages to keep do not belong to this session, so nothing was rewritten (to avoid writing another session’s content into it).') };
      }
    }
    store.rewriteTranscript(sessionId, next);
    return { ok: true };
  });

  /**
   * 「会话信息」—— 排查时一次拿全：会话 id、后端会话 id、运行位置、引擎、会话目录（`renderer/sessionInfo.ts`）。
   * 后端 id 先看活着的执行器（换过后端的话记录里那份可能还没写回），没连着再看记录。只读，不碰执行器。
   */
  ipcMain.handle('acp:session-info', async (_event, sessionId: string) => {
    try {
      const dir = store.sessionDirPath(sessionId);
      const rec = store.readRecord(sessionId);
      if (!rec) return { ok: false, error: tr('Session not found') };
      const sshHost = rec.profile?.remote?.sshHost;
      return {
        ok: true,
        info: {
          id: rec.id || sessionId,
          cliSessionId: sessionClients.get(sessionId)?.cliSessionId || rec.cliSessionId || undefined,
          engine: rec.profile?.engine || 'kiro',
          remote: sshHost ? { label: labelForHost(KIROLEX_CONFIG_PATH, sshHost), sshHost } : null,
          dir,
          /*
            远程会话这一回实际拿到的本机工具 ——「会话里能看到这条会话实际拿到了哪些本机工具」。
            看的是 `ensureLocalTools` 最近一次准备的结果；还没连过 / 通道没起来时分开说。本地会话没有这一项。
          */
          localTools: !sshHost ? null : (() => {
            const lt = localToolsBySession.get(sessionId);
            if (!lt) return { state: toollessSessions.has(sessionId) ? 'failed' : 'not-ready', forwarded: [], skipped: [] };
            return { state: 'ready', forwarded: [...(lt.forwarded || []), ...(lt.forwardedHttp || [])], skipped: lt.skipped || [], unavailable: lt.unavailable || [] };
          })(),
        },
      };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
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
    /* 设置里现有的机器 —— 只读一次，下面每条远程会话按它认回 remote id */
    const remoteTargetsNow = listRemoteTargets(KIROLEX_CONFIG_PATH);
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
       * **以及那台机器的 id**（审计 10b）—— 显示名不能拿来建会话；分叉 / 复制一条远程会话时渲染层靠它
       * 在同一台机器上建，而不是退回「新会话默认机器」。机器在设置里删掉了就标 `remoteMissing`（见 `durableRemoteId`）。
       */
      ...durableRemoteId(rec.profile?.remote as any, remoteTargetsNow, (id) => findRemoteTarget(KIROLEX_CONFIG_PATH, id)),
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'mark-purpose'); if (advRefused) return { ok: false, error: advRefused }; }
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'rename'); if (advRefused) return { ok: false, error: advRefused }; }
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
    if (rec && !refuseAdvancedOnly(sessionId, 'pin')) {
      rec.pinned = !!pinned;
      try {
        store.writeRecordKeepUpdatedAt({ ...rec, id: sessionId });
      } catch { /* best-effort */ }
    }
    return { sessionId, pinned: !!pinned };
  });

  /** User-selectable features. Reading is cheap and uncached on purpose, so the
   *  Settings panel and every call site always agree on the live value. */
  /**
   * **可选的远端有哪些**（`docs/DESIGN_remote_sessions.md`）。
   *
   * 远程会话没有开关了，`enabled` 永远是 true（字段留着，调用方不用跟着改）。
   */
  ipcMain.handle('app:remote-targets', () => {
    /*
      **已配的机器一律发出去** —— 原来开关关着时这里直接回空列表，而「存」照样能存：于是设置页
      永远看不到你刚加的那台，每次回来都是一张空表，再加一次 —— 实测 config.json 里攒了
      aws-tokyo、aws-tokyo-2、-3、-4 四条同一个 IP。
    */
    return {
      enabled: true,
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
    if (!command?.trim()) return { ok: false, error: tr('No command given') };
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
          : { ok: false, error: r.first.slice(0, 160) || tr('It would not start') };
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
      return { ok: false, error: err?.message || tr('Save failed') };
    }
  });

  ipcMain.handle('local:save-bins', (_event, bins: ExecutorBins) => {
    try {
      const saved = saveLocalBins(KIROLEX_CONFIG_PATH, bins || {});
      setLocalKiroBin(saved?.kiro);
      /* 启动命令变了：本机引擎状态重新问 */
      engineStatusCache.invalidate('local');
      logger.info('app', `本机启动命令：kiro=${saved?.kiro || '(默认)'} claude=${saved?.claude || '(默认)'} codex=${saved?.codex || '(默认)'}`);
      return { ok: true, bins: saved };
    } catch (err: any) {
      return { ok: false, error: err?.message || tr('Save failed') };
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
      return { ok: false, error: err?.message || tr('Save failed') };
    }
  });

  ipcMain.handle('remote:delete', (_event, id: string) => {
    /* 正在用这台机器的会话不受影响：它们的 remote 存在自己的 profile 里（按会话固定），
       删掉只是让它不再出现在"新建会话"的列表里。 */
    const gone = deleteRemoteTarget(KIROLEX_CONFIG_PATH, id);
    logger.info('remote', `删除远端 ${id} -> ${gone ? 'ok' : '不在列表里（可能是老 agents[].remote）'}`);
    return { ok: gone, error: gone ? undefined : tr('This entry is not in the editable list (it comes from the old agents[].remote config; remove it by hand)') };
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
    if (!scriptPath) return { ok: false, error: tr('remote-bootstrap.sh not found (it should be under the app’s scripts/)') };
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
        resolve({ ok: false, code: null, error: err?.message || tr('ssh would not start') });
      });
      child.on('close', async (code) => {
        clearTimeout(killer);
        logger.info('remote', `bootstrap 结束 ${target.sshHost} code=${code}`);
        /*
          **装完按会话的启动方式真起一次** ——「装完用和启动时完全一样的方式（bash -lc）验证能起」。
          脚本里的自检只问 `command -v`，而 fnm / nvm 的机器上"找得到"和"起得来"是两回事。
          两家都验：脚本两家都装了，哪家起不来都要说出原因。
        */
        const failed: string[] = [];
        /* 255 = ssh 自己没连上：脚本根本没跑，再连两次只是多等 */
        if (code !== 255) for (const engine of ['claude', 'codex'] as const) {
          const v = await verifyRemoteAdapter(target, engine);
          const line = adapterVerifyMessage(target.sshHost, engine, v);
          logger.info('remote', `bootstrap 验证 ${target.sshHost} ${engine}: ${v.ok ? 'ok' : line}`);
          send(`\n${line}\n`);
          if (!v.ok) failed.push(line);
        }
        const scriptError = code === 0 ? '' : (tail.trim().split('\n').slice(-6).join('\n') || tr('Exit code {code}', { code: String(code) }));
        resolve({
          ok: code === 0 && !failed.length,
          code,
          /* 失败时把最后一段输出带回去：自检那几行就在里面，比一句 exit 1 有用得多 */
          error: code === 0 && !failed.length ? undefined : [scriptError, ...failed].filter(Boolean).join('\n'),
        });
      });
    });
  });

  /**
   * **远程机器的 AI 工具配置**（设置 → 🖥 机器 →「AI 工具配置」；纯逻辑在 `agentProfile.ts`）——
   * 「统一定义远程机器上 Claude Code 的配置并同步过去；本机专用的 MCP 不同步」。
   *
   *   · `agent-profile:read` / `save`：读写 `~/.kirolex/agent-profiles/<claude|codex>/profile.json`（坏 JSON 不保存）；
   *   · `agent-profile:diff`：ssh 跑一次只读探测，算「与配置的差异」（凭证类 env 只回键名）；
   *   · `agent-profile:plan`：同上，再列出同步会做什么（确认框里给人看）；
   *   · `agent-profile:sync`：备份 → 装/升级版本 → 写入 → 重新比较，输出边跑边推 `agent-profile:sync-output`，全程写日志。
   * 这是在别人的机器上改东西，所以只在你按下按钮、确认之后发生。**不碰本机的 ~/.claude**（只读本机 known_marketplaces.json 查市场来源）。
   */
  const profileHome = os.homedir();
  const loadAgentProfiles = (): { claude: ClaudeProfile | null; codex: CodexProfile | null; errors: string[] } => {
    const errors: string[] = [];
    const c = readProfileFile(profileHome, 'claude');
    const x = readProfileFile(profileHome, 'codex');
    const cp = c.exists ? parseClaudeProfile(c.text) : null;
    const xp = x.exists ? parseCodexProfile(x.text) : null;
    if (cp && !cp.ok) errors.push(`claude/profile.json: ${cp.error}`);
    if (xp && !xp.ok) errors.push(`codex/profile.json: ${xp.error}`);
    return { claude: cp?.ok ? cp.profile : null, codex: xp?.ok ? xp.profile : null, errors };
  };
  const profileRemote = (id: string): RemoteTarget | null => {
    const found = findRemoteTarget(KIROLEX_CONFIG_PATH, String(id || ''));
    return found?.sshHost ? found : null;
  };
  const probeAgentProfile = async (remote: RemoteTarget): Promise<ProbeResult> => {
    const out = await runRemoteCapture(remote, probeScript(), 90_000, 8 * 1024 * 1024);
    const p = parseProbeOutput(out);
    if (!p) throw new Error(tr('The remote probe did not return a result: {tail}', { tail: out.trim().split('\n').slice(-3).join(' | ').slice(0, 300) || '?' }));
    return p;
  };
  const diffFor = (loaded: ReturnType<typeof loadAgentProfiles>, probe: ProbeResult): DiffItem[] => computeDiff({
    claude: loaded.claude, codex: loaded.codex, localRules: readLocalRules(profileHome), probe, localHome: profileHome,
  });
  const localKnownMarketplaces = (): Record<string, any> | null => {
    try { return JSON.parse(fs.readFileSync(path.join(profileHome, '.claude', 'plugins', 'known_marketplaces.json'), 'utf-8')); } catch { return null; }
  };
  const planFor = (loaded: ReturnType<typeof loadAgentProfiles>, probe: ProbeResult, items: DiffItem[]): SyncPlan => buildSyncPlan({
    claude: loaded.claude, codex: loaded.codex, localRules: readLocalRules(profileHome), localRulesFull: readLocalRules(profileHome),
    probe, items, now: new Date(), localHome: profileHome, localKnownMarketplaces: localKnownMarketplaces(),
  });
  const planSummary = (plan: SyncPlan) => ({
    backupDir: plan.backupDir,
    items: plan.items,
    pins: plan.pins.map((p) => ({ bin: p.bin, pkg: p.pkg, version: p.version })),
    rules: plan.rules.map((r) => r.name),
    plugins: plan.plugins,
    marketplaces: plan.marketplaces.map((m) => ({ name: m.name, copy: !!m.copy })),
    codexEntries: plan.codexEntries.map((e) => e.key),
    warnings: plan.warnings,
    hasWork: planHasWork(plan),
  });
  const profileSyncsInFlight = new Set<string>();

  ipcMain.handle('agent-profile:read', () => {
    const root = agentProfilesRoot(profileHome);
    const one = (engine: ProfileEngine) => ({ ...readProfileFile(profileHome, engine), template: engine === 'claude' ? CLAUDE_PROFILE_TEMPLATE : CODEX_PROFILE_TEMPLATE });
    return {
      root,
      claude: one('claude'),
      codex: one('codex'),
      rules: readLocalRules(profileHome).map((r) => ({ name: r.name, bytes: Buffer.byteLength(r.content) })),
      conflicts: listConflictCopies(root),
    };
  });

  ipcMain.handle('agent-profile:save', (_event, engine: string, text: string, expected?: string | null) => {
    if (!PROFILE_ENGINES.includes(engine as ProfileEngine)) return { ok: false, error: `unknown engine ${engine}` };
    const r = saveProfileText(profileHome, engine as ProfileEngine, String(text ?? ''), expected === undefined ? {} : { expected: expected === null ? null : String(expected) });
    logger.info('agent-profile', `保存 ${engine}/profile.json：${r.ok ? 'ok' : `没存（${r.error}）`}`);
    return r;
  });

  ipcMain.handle('agent-profile:open-dir', async () => {
    const root = agentProfilesRoot(profileHome);
    try { fs.mkdirSync(path.join(root, 'claude', 'rules'), { recursive: true }); } catch { /* 打开时再报 */ }
    const err = await shell.openPath(root);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('agent-profile:diff', async (_event, remoteId: string) => {
    const remote = profileRemote(remoteId);
    if (!remote) return { ok: false, error: tr('Can\'t find this machine ({machine}). Was it removed in Settings?', { machine: String(remoteId) }) };
    const loaded = loadAgentProfiles();
    if (!loaded.claude && !loaded.codex) return { ok: false, error: loaded.errors.join('\n') || tr('There is no AI tool config yet: save one above first.') };
    try {
      const probe = await probeAgentProfile(remote);
      const items = diffFor(loaded, probe);
      logger.info('agent-profile', `差异 ${remote.sshHost}：${items.length} 处${probe.secretEnvKeys.length ? `（远端凭证类 env：${probe.secretEnvKeys.join('、')}，只看了键名）` : ''}`);
      return { ok: true, items, home: probe.home, region: probe.region, secretEnvKeys: probe.secretEnvKeys, errors: loaded.errors, at: Date.now() };
    } catch (err: any) {
      logger.warn('agent-profile', `差异 ${remote.sshHost} 没拿到：${err?.message || err}`);
      return { ok: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('agent-profile:plan', async (_event, remoteId: string) => {
    const remote = profileRemote(remoteId);
    if (!remote) return { ok: false, error: tr('Can\'t find this machine ({machine}). Was it removed in Settings?', { machine: String(remoteId) }) };
    const loaded = loadAgentProfiles();
    if (!loaded.claude && !loaded.codex) return { ok: false, error: loaded.errors.join('\n') || tr('There is no AI tool config yet: save one above first.') };
    try {
      const probe = await probeAgentProfile(remote);
      const items = diffFor(loaded, probe);
      return { ok: true, plan: planSummary(planFor(loaded, probe, items)) };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('agent-profile:sync', async (event, remoteId: string) => {
    const remote = profileRemote(remoteId);
    if (!remote) return { ok: false, error: tr('Can\'t find this machine ({machine}). Was it removed in Settings?', { machine: String(remoteId) }) };
    const host = remote.sshHost || '';
    if (profileSyncsInFlight.has(host)) return { ok: false, error: tr('A sync to {host} is already running', { host }) };
    const loaded = loadAgentProfiles();
    if (!loaded.claude && !loaded.codex) return { ok: false, error: loaded.errors.join('\n') || tr('There is no AI tool config yet: save one above first.') };
    profileSyncsInFlight.add(host);
    const send = (chunk: string) => { try { event.sender.send('agent-profile:sync-output', { remoteId, chunk }); } catch { /* 窗口没了不影响同步 */ } };
    const log = (line: string) => { logger.info('agent-profile', `${host} ${line}`); send(`${line}\n`); };
    /* 远端脚本走 stdin 落到临时文件再跑（理由同 remote:bootstrap）；输出边跑边推 */
    const sshStdin = (cmd: string, stdin: string, timeoutMs: number) => new Promise<{ code: number | null; output: string; error?: string }>((resolve) => {
      const child = spawn('ssh', buildSshArgs(remote, cmd), { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnv(remote) });
      let output = '';
      const onData = (b: Buffer) => {
        const s = b.toString('utf-8');
        output = (output + s).slice(-200_000);
        /* 结构化的结果行不刷给人看（下面按步骤说人话） */
        const shown = s.split('\n').filter((l) => !/^KX_APPLY/.test(l)).join('\n');
        if (shown.trim()) send(shown);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } }, timeoutMs);
      child.on('error', (err) => { clearTimeout(killer); resolve({ code: null, output, error: err?.message || tr('ssh would not start') }); });
      child.on('close', (code) => { clearTimeout(killer); resolve({ code, output }); });
      try { child.stdin.end(stdin); } catch { /* close 会报 */ }
    });
    try {
      log(`开始同步 AI 工具配置到 ${host}`);
      const probe = await probeAgentProfile(remote);
      const items = diffFor(loaded, probe);
      const plan = planFor(loaded, probe, items);
      for (const w of plan.warnings) log(`⚠️ ${w}`);
      if (!planHasWork(plan)) {
        log('和配置一致，没有要改的');
        return { ok: true, steps: [], applied: [], after: items };
      }
      const outcome = await runProfileSync(plan, {
        log,
        backup: async (script) => {
          log(`备份到 ${plan.backupDir}`);
          try {
            const out = await runRemoteCapture(remote, script, 5 * 60_000);
            return { ok: /KX_BACKUP_OK/.test(out), output: out };
          } catch (err: any) { return { ok: false, output: '', error: String(err?.message || err) }; }
        },
        installVersions: async (pins) => {
          const script = readBootstrapScript();
          if (!script) return { ok: false, error: tr('remote-bootstrap.sh not found (it should be under the app’s scripts/)') };
          const r = await sshStdin(remotePinCommand(`/tmp/kirolex-pins-${Date.now()}.sh`, pins), script, 15 * 60_000);
          if (r.error) return { ok: false, error: r.error };
          return r.code === 0 ? { ok: true } : { ok: false, error: remoteInstallReason(r.output, r.code) };
        },
        payloadExtras: async () => {
          const files: Array<{ rel: string; b64: string }> = [];
          const errors: string[] = [];
          for (const m of plan.marketplaces) {
            if (!m.copy) continue;
            const c = collectMarketplaceFiles(m.copy.localDir, m.copy.remoteDir, profileHome, probe.home);
            if (c.ok) { files.push(...c.files); log(`从本机拷市场 ${m.name}：${m.copy.localDir} → ~/${m.copy.remoteDir}（${c.files.length} 个文件，本机家目录换成 ${probe.home}）`); }
            else errors.push(`${m.name}: ${c.error}`);
          }
          return { files, errors };
        },
        apply: async (js) => {
          const r = await sshStdin(remoteApplyCommand(`/tmp/kirolex-profile-${Date.now()}.js`), js, 20 * 60_000);
          return { ok: !r.error && r.code === 0, output: r.output, error: r.error };
        },
        reprobe: async () => {
          try { return diffFor(loadAgentProfiles(), await probeAgentProfile(remote)); } catch (err: any) { log(`重新探测失败：${err?.message || err}`); return null; }
        },
      });
      logger.info('agent-profile', `同步 ${host} 结束：${outcome.ok ? 'ok' : outcome.steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.detail}`).join(' / ')}`);
      return { ok: outcome.ok, steps: outcome.steps, applied: outcome.applied, after: outcome.after };
    } catch (err: any) {
      log(`同步没做成：${err?.message || err}`);
      return { ok: false, error: String(err?.message || err) };
    } finally {
      profileSyncsInFlight.delete(host);
    }
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
      title: tr('Choose the project folder to mirror on the remote'),
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
      title: tr('Choose an SSH private key'),
      defaultPath: fs.existsSync(sshDir) ? sshDir : os.homedir(),
      properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'] as Array<'openFile' | 'showHiddenFiles' | 'dontAddToRecent'>,
      /* `.pem` 单列一项（EC2 给的就是它），但保留"所有文件"—— `id_rsa` 这类根本没有后缀 */
      filters: [
        { name: tr('Private key'), extensions: ['pem', 'key', 'cer'] },
        { name: tr('All files'), extensions: ['*'] },
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
    if (!target?.sshHost) return { ok: false, error: tr('Machine not found ({machine})', { machine }) };
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
      if (!target?.sshHost) return { ok: false, error: tr('Machine not found ({machine})', { machine }) };
      bin = remoteKiroBin(target) || '';
      if (!bin) return { ok: false, error: tr('No kiro launch command is set for {host} yet.', { host: target.sshHost }) };
    }
    const remoteInUse = target
      ? [...sessionClients.values()].filter((e) => e.profile.remote?.sshHost === target!.sshHost).length
      : 0;
    const busy = local ? inUse : remoteInUse;
    if (busy && !force) {
      return {
        ok: false, needsConfirm: true, inUse: busy,
        error: tr('{where} still has {n} session(s) connected. Updating replaces the binary they are using: a turn that is running will not die on the spot, but the next reconnect or model switch will use the new version, which may behave differently. Click again to continue.', { where: local ? tr('This computer') : target!.sshHost, n: busy }),
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
      return { ok: false, error: tr('Update failed: {err}', { err: String(err?.message || err) }) };
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
    /* kiro 的预检之后顺带探两家适配器（同一次 ssh）：只为 Claude Code / Codex 配的机器也要能测通 */
    const args = buildSshArgs(target, `bash -lc ${shellQuote(testConnectionScript(preflightScript(undefined, { models: false })))}`);
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile('ssh', args, { timeout: 30_000, encoding: 'utf8', env: sshEnv(target) }, (err: any, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      }));
    });
    const sections = splitTestOutput(out.stdout);
    const verdict = judgeTestConnection(target.sshHost || 'remote', judgePreflight(out.code, sections.kiro, out.stderr, target), sections);
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'write-context-override'); if (advRefused) return { ok: false, error: advRefused }; }
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
    { const advRefused = refuseAdvancedOnly(sessionId, 'clear-context-override'); if (advRefused) return { ok: false, error: advRefused }; }
    const existed = store.clearContextOverride(sessionId);
    logger.info('prime', `context override removed sessionId=${sessionId} existed=${existed} -> generated snapshot again`);
    return { ok: true, existed };
  });

  /*
    **advanced 的会话（flow / skill）的会话层记忆不碰** —— 读 / 写 / 备份 / 看体积都会顺手给 sessionId
    建 `memory/sessions/<id>/`。会话层直接拒；全局 / 项目层照常，但不带这个 sessionId 往下传。
  */
  const memorySessionId = (sessionId: string | undefined, what: string): string | undefined =>
    (sessionId && refuseAdvancedOnly(sessionId, what) ? undefined : sessionId);
  ipcMain.handle('acp:read-memory', async (_event, projectId?: string, sessionId?: string) => {
    return readMemory(projectId, memorySessionId(sessionId, 'read-memory'));
  });  ipcMain.handle('acp:write-memory', async (_event, scope: 'global' | 'project' | 'session', projectId: string | undefined, sessionId: string | undefined, content: string) => {
    const sid = memorySessionId(sessionId, 'write-memory');
    if (scope === 'session' && sessionId && !sid) {
      return { ok: false, error: tr('This session belongs to KiroLex Advanced; the standard edition does not modify it.') };
    }
    if (scope === 'project') {
      const advRefused = refuseAdvancedProject(projectId, 'write-memory');
      if (advRefused) return { ok: false, error: advRefused };
    }
    writeMemory(scope, projectId, sid, content);
    return { ok: true };
  });

  /** 三层体积，按需取一次。给两个时机用：会话切换/启动（打开就能看到横幅），以及
   *  MemoryDialog 保存之后（你手动清理完立刻消失，不用等下一轮对话）。 */
  ipcMain.handle('acp:memory-bytes', async (_event, projectId?: string, sessionId?: string) => {
    return memoryLayerBytes(projectId, memorySessionId(sessionId, 'memory-bytes'));
  });

  /** 压缩前备份某一层记忆。时间戳由主进程生成，渲染进程不需要关心命名规则。 */
  ipcMain.handle('acp:backup-memory', async (
    _event, scope: MemoryScope, projectId?: string, sessionId?: string,
  ) => {
    const sid = memorySessionId(sessionId, 'backup-memory');
    if (scope === 'session' && sessionId && !sid) {
      return { ok: false, at: null, error: tr('This session belongs to KiroLex Advanced; the standard edition does not modify it.') };
    }
    if (scope === 'project') {
      const advRefused = refuseAdvancedProject(projectId, 'backup-memory');
      if (advRefused) return { ok: false, at: null, error: advRefused };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const at = backupMemoryLayer(scope, projectId, sid, stamp);
    if (at) logger.info('memory', `backed up ${scope} -> ${at}`);
    else logger.warn('memory', `nothing to back up for scope=${scope}`);
    return { ok: !!at, at };
  });
});

/**
 * **渲染层的会话视图诊断进日志** ——「新建会话界面出现别的会话的历史」两次都只能靠推断：盘上、tail 都干净，
 * 而渲染层的 console 不进这份日志。缓存和 store 对不上被重载、删除后的自动切换这类「界面上这条会话
 * 的内容从哪来」的事，从这里记一行（只记 id 和条数，不记正文）。
 */
ipcMain.on('diag:session-view', (_event, what: string, detail: Record<string, unknown>) => {
  let text = '';
  try { text = JSON.stringify(detail ?? {}).slice(0, 1500); } catch { text = '(unserializable)'; }
  logger.warn('view', `${String(what).slice(0, 60)} ${text}`);
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
  /* 断线恢复也停掉：退出时被收掉的执行器不该再被拉回来 */
  try { remoteRecovery.stopAll(); } catch { /* 退出路径不抛 */ }
  try { sshMux.closeAll(); } catch { /* 退出路径不抛 */ }
});
/*
  **兜底**：没走 before-quit 的退出（`process.exit`、SIGTERM 那条 5 秒的后备）也要把自己的反向隧道
  明确关掉 —— 不然 ssh 子进程被收养、还连着远端，远端那个端口和那条 sshd-session 就一直被它占着。
  `kill` 是同步发信号，可以放在 `exit` 里。
*/
process.on('exit', () => { try { sshMux.closeAll(); } catch { /* 退出路径不抛 */ } });

/** 本机控制入口（agent-board「拉取并重启」）：`POST /quit` 走的就是托盘「Quit」那条路径。 */
let controlServer: ControlServer | null = null;
/** 现在忙的会话（带标题）—— 判据见 busySessions.ts */
function getBusySessions(): BusySession[] {
  const turns = new Set<string>([...attachingSessions, ...reconfiguringSessions]);
  /* 后端自己起的那一轮（autonomousTurn.ts）也是在跑的一轮：等待退出要等它收尾落盘 */
  for (const [id, e] of sessionClients) if (e.busy || e.autonomous) turns.add(id);
  return collectBusySessions({
    turns,
    scheduleRuns: schedulesInFlight.values(),
    revisePending: revisePending.entries(),
    queues: queueCounts(uiState()['kirolex-queues']),
    titleOf: (id) => store.readRecord(id)?.title,
  });
}
ipcMain.handle('control:pending-quit', () => quitPending);

/*
  **控制入口的「读会话 / 发消息」**（controlServer.ts 的 `/sessions…`，纯逻辑在 controlSessions.ts）。

  `send` 必须先交给界面：界面里有和 Enter 同一套的路由（空闲发 / 追加指令 / 排队、失败标红），
  主进程不绕过它直接 prompt。界面没开、正在刷新、还没说过 `control:ready` → 503 `ui-not-ready`。
  删掉的（墓碑）和 KiroLex Advanced 的会话一律当不存在（404）。
*/
let controlUiContents: WebContents | null = null;
const controlSendWaiters = new Map<string, (reply: any) => void>();
const CONTROL_SEND_TIMEOUT_MS = 15_000;
ipcMain.handle('control:ready', (event) => { controlUiContents = event.sender; });
ipcMain.handle('control:send-result', (_event, reqId: string, reply: any) => {
  const waiter = controlSendWaiters.get(reqId);
  if (waiter) { controlSendWaiters.delete(reqId); waiter(reply); }
});
function controlVisibleRecord(id: string): store.SessionRecord | null {
  if (!id || deletedSessionIds.has(id) || loadSessionTombstones().includes(id)) return null;
  const rec = store.readRecord(id);
  return rec && !isAdvancedOnly(rec) ? rec : null;
}
function controlBusyIds(): Set<string> {
  return new Set(getBusySessions().filter(blocksQuit).map((b) => b.id));
}
const controlSessionAccess: ControlSessionAccess = {
  enabled: () => isFeatureEnabled('controlSessionAccess'),
  list: () => {
    const busy = controlBusyIds();
    const tombstoned = new Set([...loadSessionTombstones(), ...deletedSessionIds]);
    return store.listSessions().filter((rec) => !tombstoned.has(rec.id)).map((rec) => ({
      id: rec.id,
      title: rec.title,
      projectId: rec.profile?.projectId ?? null,
      busy: busy.has(rec.id),
      remote: rec.profile?.remote?.sshHost ? (labelForHost(KIROLEX_CONFIG_PATH, rec.profile.remote.sshHost) || rec.profile.remote.sshHost) : null,
      archived: !!rec.archived,
      updatedAt: rec.updatedAt,
    }));
  },
  exists: (id) => !!controlVisibleRecord(id),
  /* 还挂着的提问接在最后（落盘的只有关掉的）—— 外部能看到「它在等我回答什么」 */
  tail: (id, n) => tailEntries([
    ...store.readTranscript(id),
    ...pendingQuestionsFor(id).map((c) => ({ id: c.id, role: 'assistant', content: '', ts: c.askedAt, question: c })),
  ], n),
  answer: (id, body) => {
    const pending = pendingQuestionsFor(id);
    const target = body.questionId ? pending.find((c) => c.id === body.questionId) : pending.length === 1 ? pending[0] : undefined;
    if (!target) {
      return pending.length > 1 && !body.questionId
        ? { ok: false, status: 409, error: 'ambiguous' }
        : { ok: false, status: 404, error: 'no-question' };
    }
    const r = answerQuestion(id, target.id, body.action, body.answers);
    if (!r.ok) return r.error === 'invalid'
      ? { ok: false, status: 400, error: 'invalid', missing: r.missing, invalid: r.invalid }
      : { ok: false, status: 404, error: 'no-question' };
    logger.info('question', `answered via control sessionId=${id} id=${target.id} status=${r.card.status}`);
    return { ok: true, questionId: target.id, status: r.card.status };
  },
  status: (id) => {
    const entry = sessionClients.get(id);
    const last = store.readTranscript(id).slice(-1)[0];
    const queued = queueCounts(uiState()['kirolex-queues']).find(([sid]) => sid === id)?.[1] ?? 0;
    return {
      busy: controlBusyIds().has(id),
      turnStartedAt: entry?.busy && entry.turnStartedAt ? entry.turnStartedAt : null,
      queued,
      lastMessageAt: last ? Number(last.ts) || null : null,
    };
  },
  send: (id, text, mode) => {
    const rec = controlVisibleRecord(id);
    if (!rec) return Promise.resolve({ ok: false, status: 404, error: 'not-found' });
    if (rec.archived) return Promise.resolve({ ok: false, status: 409, error: 'archived' });
    return forwardToUi(id, text, mode, 'ctl');
  },
  /*
    **经控制入口换新的后端会话** —— 本机工具发现会话卡住（比如反复把工具调用写成文字）时不用叫你去点。
    和 EmptyResponse / 「写成文字」反复发作同一套（`recreateBackendSession`），上下文跟着下一条带过去；
    这一轮还在跑就不换（409），没挂执行器先挂上。会话里说一句「经控制入口换了后端会话」。
  */
  newBackend: async (id) => {
    const rec = controlVisibleRecord(id);
    if (!rec) return { ok: false, status: 404, error: 'not-found' };
    if (rec.archived) return { ok: false, status: 409, error: 'archived' };
    const busy = busyReasonFor(id);
    if (busy && busy !== 'prime-pending') return { ok: false, status: 409, error: 'busy' };
    if (!sessionClients.get(id)) {
      if (!attachForControl) return { ok: false, status: 503, error: 'not-ready' };
      try { await attachForControl(id); } catch { /* 下面按「没连上」回 */ }
      if (!sessionClients.get(id)) return { ok: false, status: 502, error: 'not-connected' };
    }
    try {
      const r = await swapBackendSessionWhenIdle(id, 'control-new-backend');
      noteInSession(id, trConcat(
        tr('🔀 Switched to a new backend session via the control entry; the context goes along with the next message.'),
        NOTE_DETAIL_SEP,
        tr('New backend session: {id}…. The conversation is unchanged.', { id: r.newId.slice(0, 8) })),
      undefined, 'backend-session-swap:control');
      return { ok: true, backendSessionId: r.newId };
    } catch (err: any) {
      if (err?.code === SESSION_BUSY) return { ok: false, status: 409, error: 'busy' };
      logger.warn('control', `new-backend failed session=${id}: ${err?.message || err}`);
      return { ok: false, status: 502, error: 'swap-failed' };
    }
  },
};
/**
 * **交给界面按 Enter 的同一套路由发**（`App.tsx` 的 `handleControlSend`）—— 控制入口的 `send` 和会话间的 `session_send` 共用。
 * `origin` 决定消息 id 带哪种来源标记（`ctl` = 经控制入口，`xs` = 来自别的会话，见 controlSessions.markOrigin）。
 * 界面没开、正在刷新、还没说过 `control:ready` → 503 `ui-not-ready`；界面 15 秒没回 → 504。
 */
function forwardToUi(id: string, text: string, mode: 'auto' | 'next', origin: MarkOrigin): Promise<ControlSendResult> {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!wc || wc !== controlUiContents || wc.isLoading() || wc.isCrashed()) {
    return Promise.resolve({ ok: false, status: 503, error: 'ui-not-ready' });
  }
  const reqId = `ctl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      controlSendWaiters.delete(reqId);
      resolve({ ok: false, status: 504, error: 'ui-timeout' });
    }, CONTROL_SEND_TIMEOUT_MS);
    controlSendWaiters.set(reqId, (reply) => {
      clearTimeout(timer);
      if (reply?.ok && typeof reply.messageId === 'string' && ['sent', 'steer', 'queued'].includes(reply.routed)) {
        resolve({ ok: true, messageId: reply.messageId, routed: reply.routed, ...(reply.steerFailed ? { steerFailed: String(reply.steerFailed) } : {}) });
      } else {
        resolve({ ok: false, status: Number(reply?.status) || 500, error: String(reply?.error || 'renderer-error') });
      }
    });
    wc.send('control:send', { reqId, sessionId: id, text, mode, origin });
  });
}
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
      sessions: controlSessionAccess,
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
