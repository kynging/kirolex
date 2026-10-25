import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { baseName } from './pathBits.ts';
import { type SubagentRow } from '../main/subagents.ts';
import { uiGet, uiSet, uiRemove } from './uiStore';
import { restoreGet, restoreSet, restoreGetJson } from './uiRestore';
import { displayTitle, normalizeLang, t as translate, type Lang } from './i18n';
import { normalizeUiZoom, stepUiZoom, UI_ZOOM_DEFAULT } from './uiZoom';
import { LangProvider } from './hooks/useLang';
import { useRemoteTargets } from './hooks/useRemoteTargets';
import { activeSplitSizes, computePaneFlex, putSplitSizes, resetSplitSizes, SplitSizeStore } from './splitLayout';
import { autoFoldPanels, filePanelMax } from './panelFit';
// A scheduled chat must SAY it is scheduled, in the transcript header and on its sidebar row.
// Both lines come from this one pure module so they cannot word the same job differently.
import { schedulesBySession, sessionScheduleSummary, type ScheduleSummary } from './scheduleView';
import { runningBgJobs, type BgJobRow } from './bgJobsView';
import { startupBlocksSend } from './createStages';
// 给主会话的交底 —— 它原本对流程一无所知，连执行会话都不知道
import { consumeHandoff } from './handoffDraft';
// 哪几步共用一条会话 —— 和画布同源（草稿声明的泳道），驱动器不再各算一套
// 复用来的会话该不该清掉累积的往返
import { extractJson } from './jsonFromReply';

import { Sidebar } from './components/Sidebar';
import { ChatArea, MarkdownView, expandPastes } from './components/ChatArea';
import type { PastedBlock } from './components/ChatArea';
import hljs from 'highlight.js';
import { SettingsDialog } from './components/SettingsDialog';
import { BackupDialog } from './components/BackupDialog.tsx';
import { MemoryDialog } from './components/MemoryDialog';
import { compactMemoryPrompt, memoryWarnings, type MemoryScope } from '../main/memoryPolicy';
import { MODEL_LIST_WARMUP_DELAY_MS, AGENTS_CACHE_KEY, shouldReplaceModelCache } from './modelList';
import { SkillDialog } from './components/SkillDialog';
import { WorkspacePanel } from './components/WorkspacePanel';
import { ReviewPane, isDeckPath } from './components/ReviewPane';
import { PreviewFind } from './components/PreviewFind';
import { findOwner, isInPreview, previewSearchable } from './previewFind';
import { savedScrollOf, scrollHostOf, restoreScroll } from './tabScroll';
import { IconClose, IconLogs, IconRobot, IconClaudeSpark, IconCodex } from './components/Icons';
import { Toasts, showToast } from './components/Toasts';
import { useAcp, isBackendOccupied, APP_ERROR_KEY } from './hooks/useAcp';
import { idleNoticeBody, stepIdle, type IdleTrack } from './idleNotify';
import { recoverPendingHandoffs, requeueFailedHandoff } from './handoffRequeue';
import { busyEnterKind, busyEnterRoute, composerRunning, engineCanSteer, enterRoute, steerFailureRoute, steerPayload, withAfterRebuild } from './steerRoute';
import { carryControlMark, controlMessageId, isControlMessageId, type MarkOrigin } from '../main/controlSessions';
import { isKirolexNote } from '../main/kirolexNote.ts';
import { newChatModel } from '../main/engineModelPick.ts';
import { queuedBatch, joinQueuedBatch } from './queueBatch';
import { pickQueuedBatch, sealRetryBatch, editQueuedItem, QueueBackoff, isDuplicateMessageError, type RetryBatch } from './queueRetry';
import { noteSessionLocally } from './hooks/useSessionNotice';
import { useFeatureFlags } from './hooks/useFeatureFlags';
import type { BrowserDomainAsk, LocalBrowserStatusView } from './localBrowserView';
import { BrowserDomainPrompt } from './components/BrowserDomainPrompt';
import { engineLabel, engineCliName } from './engineLabel';
import { accentEngine, engineAccentCss } from './engineTheme.ts';
import type { QuestionCard } from '../main/elicitation.ts';
import { EngineStatusPanel } from './components/EngineStatusPanel';

/** 已经推过收尾卡的运行（`project\u0000runId`）。落盘去重 —— ref 只管到下次刷新。 */
const RUN_DONE_CARD_KEY = 'kirolex-run-done-card';

declare global {
  interface Window {
    kiroApi: {
      connect: (options: { model?: string }) => Promise<any>;
      disconnect: () => Promise<void>;
      newSession: (
        kiroLexId: string,
        cwd: string,
        model: string,
        projectId?: string,
        kiroAgent?: string,
        permissionMode?: 'auto-approve' | 'ask',
        /** 这条会话跑在哪台机器上（不传 = 本地）。见 docs/DESIGN_remote_sessions.md。 */
        remoteId?: string,
        /** 哪个引擎：kiro（默认）/ claude / codex。 */
        engine?: string,
      ) => Promise<{ sessionId: string }>;
      /** 可选的远端列表；`enabled: false` 时界面完全不显示目标选择。 */
      remoteTargets?: () => Promise<{ enabled: boolean; targets: { id: string; label: string; sshHost: string; remoteWorkdir?: string }[] }>;
      /** 把一条已有会话切到另一台机器（`remoteId` 传 null = 本地）。 */
      setRemoteTarget?: (sessionId: string, remoteId: string | null, localDir?: string) =>
        Promise<{ ok: boolean; remoteHost?: string | null; unchanged?: boolean; cold?: boolean; error?: string }>;
      /** 某条会话的运行位置/工作目录变了 —— 徽标、菜单那句话、会话里那个 📂 都靠它更新。 */
      onTargetsChanged?: (cb: (d: { sessionId: string; remoteHost: string | null; remoteId?: string | null; localDir?: string }) => void) => () => void;
      loadSession: (sessionId: string, cwd: string, model: string) => Promise<any>;
      installAdapter?: (sessionId: string, engine: string, remoteId?: string) => Promise<{ ok: boolean; error?: string; noted?: boolean }>;
      onAdapterInstallOutput?: (cb: (d: { sessionId: string; chunk: string }) => void) => () => void;
      enginesStatus?: (machine: string, opts?: { force?: boolean }) => Promise<{ ok: boolean; statuses?: import('./engineStatusView').EngineStatusLite[]; error?: string }>;
      enginesInstall?: (machine: string, engine: string) => Promise<{ ok: boolean; error?: string }>;
      onEnginesInstallOutput?: (cb: (d: { machine: string; engine: string; chunk: string }) => void) => () => void;
      enginesLogin?: (machine: string, engine: string) => Promise<{ ok: boolean; opened?: boolean; how?: string; error?: string }>;
      primeHistory: (sessionId: string, force?: boolean) => Promise<any>;
      persistNote?: (sessionId: string, text: string, variants?: { zh: string; en: string }) => Promise<{ ok: boolean; error?: string }>;
      readEvents?: (sessionId: string, limit?: number) => Promise<{ events: any[]; path: string; truncated: boolean }>;
      loopRegisterVerifier?: (sessionId: string, command: string, timeoutSec: number) => Promise<{ ok: boolean; registered?: boolean; error?: string }>;
      loopVerify?: (sessionId: string, command: string, timeoutSec: number) => Promise<{
        ran: boolean; exitCode: number | null; output: string;
        host: 'local' | 'remote'; durationMs: number; timedOut: boolean; error?: string;
      }>;
      /** DURABLE LOOP COUNTER, owned by main. The count used to live in this window, so
       *  a reload reset it and a declared round cap became a fresh budget every time. */
      loopPersist?: (sessionId: string, run: any) => Promise<{ ok: boolean; error?: string }>;
      loopBeginRound?: (sessionId: string) => Promise<{ run: any | null; terminal: string | null; error?: string }>;
      loopRead?: (sessionId: string) => Promise<any | null>;
      loopListLive?: () => Promise<any[]>;
      loopClear?: (sessionId: string) => Promise<{ ok: boolean }>;
      /** THE LOOP DRIVER is in main too (loopDriver.ts): this window only starts, stops and mirrors. */
      loopStart?: (sessionId: string, spec: any) => Promise<{ ok: boolean; error?: string }>;
      loopStop?: (sessionId: string) => Promise<{ ok: boolean }>;
      onLoopChanged?: (cb: (payload: { sessionId: string; run: any | null }) => void) => () => void;
      /** SCHEDULED TASKS. The ticker is in main, so a job fires with no window open. */
      scheduleCreate?: (sessionId: string, spec: any) => Promise<{ ok: boolean; id?: string; error?: string; nextRunAt?: number | null; describe?: string }>;
      scheduleList?: () => Promise<Array<{ id: string; sessionId: string; prompt: string; describe: string; runs: number; maxRuns: number | null; paused: boolean; terminal?: string | null; lastRunAt: number | null; lastError: string | null; nextRunAt: number | null; createdBy?: string | null; expiresAt?: number | null; until?: string | null; checkCommand?: string | null }>>;
      schedulePause?: (id: string, paused: boolean) => Promise<{ ok: boolean; error?: string }>;
      scheduleRemove?: (id: string) => Promise<{ ok: boolean }>;
      scheduleSetExpiry?: (id: string, change: { mode: 'extend'; ms: number } | { mode: 'until'; at: number } | { mode: 'never' }) => Promise<{ ok: boolean; error?: string; expiresAt?: number | null }>;
      onScheduleChanged?: (cb: (payload: any) => void) => () => void;
      /** 模型起的后台命令 / 监视（进程在 main 里）。 */
      bgList?: () => Promise<BgJobRow[]>;
      bgStop?: (jobId: string) => Promise<{ ok: boolean; error?: string }>;
      onBgChanged?: (cb: () => void) => () => void;
      /** 主进程自己发起的一轮（定时到点 / 后台命令退出 / 监视事件）。 */
      onMainTurn?: (cb: (data: { sessionId: string; messageId: string; content: string; ts: number; kirolex?: true; handoff?: true; attachments?: any[] }) => void) => () => void;
      getPendingQuit?: () => Promise<boolean>;
      onPendingQuit?: (cb: (pending: boolean) => void) => () => void;
      /** 控制入口（controlServer `POST /sessions/:id/send`）：主进程转来一条，界面按 Enter 的同一套路由处理后回话 */
      onControlSend?: (cb: (req: { reqId: string; sessionId: string; text: string; mode: 'auto' | 'next'; origin?: MarkOrigin }) => void) => () => void;
      controlSendResult?: (reqId: string, reply: ControlSendReply) => Promise<void>;
      /** 界面就绪、能接控制入口的 send 了 */
      controlReady?: () => Promise<void>;
      /** The skills kiro actually has, parsed from ~/.kiro/skills. Read-only. */
      skillList?: () => Promise<{ dir: string; skills: Array<{ folder: string; path: string; ok: boolean; doc?: any; summary?: string; error?: string }> }>;
      skillRead?: (filePath: string) => Promise<{ ok: boolean; path?: string; raw?: string; doc?: any; error?: string }>;
      skillWrite?: (filePath: string, text: string) => Promise<{ ok: boolean; path?: string; doc?: any; error?: string }>;
      /* ── RUNS：project 拥有的那些「正在跑的 skill」 ── */
      /** `name` 是你给这次运行起的名字（可省）—— 见 `StoredRun.name`。 */
      runCreate?: (project: string, skillName: string, name?: string) => Promise<{ ok: boolean; run?: any; error?: string }>;
      /** 给一次运行改名。空字符串 = 清掉名字，回到显示 `#N`。 */
      runRename?: (project: string, id: string, name: string) => Promise<{ ok: boolean; name?: string; error?: string }>;
      runList?: (project: string) => Promise<any[]>;
      runGet?: (project: string, id: string) => Promise<any | null>;
      /** `prompt`/`output` 是这一步的留档（实际发出去的原文、产出的正文）—— 「从每个节点重跑，
       *  不依赖会话和会话历史」靠的就是它们，见 `rerunReadiness.ts`。主进程 `patchRunNode` 是合并写入。 */
      runSetNode?: (project: string, id: string, nodeId: string, patch: {
        status?: string; sessionId?: string; error?: string; prompt?: string; output?: string;
        /* 这一步的账 —— 见 `flowRun.RunNode` 上 `credits` / `carryChars` / `attempts` 那几段 */
        contextPct?: number; credits?: number; carryChars?: number; attempts?: number;
      }) => Promise<{ ok: boolean; run?: any; error?: string }>;
      runRemove?: (project: string, id: string) => Promise<{ ok: boolean }>;
      /** 移出一个 flow（配置动作，历史不动）/ 名单 / 删某个 flow 的全部历史（进回收站） */
      runSetFlowDetached?: (project: string, flow: string, detached: boolean) => Promise<{ ok: boolean; detached: string[] }>;
      runDetachedFlows?: (project: string) => Promise<string[]>;
      /** 这些项目名里哪些是 KiroLex Advanced 专属的 flow 项目（标准版不显示，见 useAcp 的 visibleProjects）。 */
      advancedOnlyProjects?: (names: string[]) => Promise<string[]>;
      /** project 的工作目录 —— 它的会话都在这儿干活（空 = 家目录） */
      projectGetWorkspace?: (project: string) => Promise<{ workspace: string }>;
      projectSetWorkspace?: (project: string, workspace: string) => Promise<{ ok: boolean; error?: string }>;
      /** 新会话默认组合（Claude Code / Codex）：不传 project = 全局；传了 = 那个项目的覆盖（'' = 跟随全局） */
      defaultCombo?: (project?: string) => Promise<import('./comboPick').DefaultComboInfo>;
      setDefaultCombo?: (comboId: string, project?: string) => Promise<{ ok: boolean; error?: string }>;
      /** `sessions` 是级联删掉的会话数，`cascaded` 是它们的 id（渲染层要按 id 从侧栏摘掉）。
       *  声明按主进程 `run:remove-flow-runs` 的实际返回值写 —— 它早就返回这四个字段了，只有这里没跟上。 */
      runRemoveFlowRuns?: (project: string, flow: string) => Promise<{ ok: boolean; removed: number; sessions?: number; cascaded?: string[] }>;
      runAttachSession?: (project: string, id: string, nodeId: string, sessionId: string) => Promise<{ ok: boolean; run?: any; error?: string }>;
      runRenameProject?: (from: string, to: string) => Promise<{ ok: boolean; moved?: number }>;
      /** 第 4 个参数是「这次退回由哪道门引起」—— 次数记在那道门上（main 在重置之后加） */
      runReset?: (project: string, id: string, nodeIds: string[], rewindGate?: string, opts?: { cascade?: boolean }) => Promise<{ ok: boolean; reset?: string[]; closeSessions?: string[]; error?: string }>;
      runReconcile?: (project: string, id: string) => Promise<{ ok: boolean; changed?: number; error?: string }>;
      clearContext?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
      markCleared?: (sessionId: string) => Promise<{ ok: boolean; clearedAt?: number; error?: string }>;
      /**
       * 一个 `file:` 产出的正文 —— 门上要能逐段 comment 它（`file:` 的产出不进 run values）。
       * 路径的算法和 `fileOutputs` 那条检查同一套：占位符按起跑输入替换、相对路径相对 run 冻结的工作目录。
       */
      runReadFile?: (project: string, id: string, ref: string) => Promise<{
        ok: boolean; path?: string; text?: string; truncated?: boolean; bytes?: number; error?: string;
      }>;
      runSetValue?: (project: string, id: string, ref: string, value: string) => Promise<{ ok: boolean }>;
      runSpillCarry?: (project: string, id: string, ref: string, value: string)
        => Promise<{ ok: boolean; path?: string; error?: string }>;
      runSetInput?: (project: string, id: string, key: string, value: string) => Promise<{ ok: boolean }>;
      runAddNode?: (project: string, id: string, node: unknown) => Promise<{ ok: boolean; error?: string; nodeId?: string }>;
      markSessionPurpose?: (sessionId: string, purpose: string, flow?: string) => Promise<{ ok: boolean; error?: string }>;
      /** 会话标题落盘 —— 不落盘的话一刷新就退回 `New Chat`（flow 起的会话全靠现取的名字） */
      renameSessionOnDisk?: (sessionId: string, title: string) => Promise<{ ok: boolean; deferred?: boolean; error?: string }>;
      openRunWindow?: (project: string, id: string) => Promise<{ ok: boolean; focused?: boolean }>;
      onRunChanged?: (handler: (payload: { project: string; id: string }) => void) => (() => void);
      focusSession?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
      notifySessionIdle?: (payload: { sessionId: string; title: string; body: string }) => Promise<{ shown: boolean; reason?: string }>;
      onFocusSessionRequest?: (handler: (payload: { sessionId: string }) => void) => (() => void);
      /** SKILL FLOWS. The run lives in main and on disk: an approval gate has to
       *  survive this window closing, which a renderer-owned run cannot do. */
      legacyFlowLoad?: (filePath: string) => Promise<{ ok: boolean; flow?: any; path?: string; errors?: Array<{ path: string; message: string }> }>;
      legacyFlowStart?: (sessionId: string, filePath: string, inputs: Record<string, unknown>) =>
        Promise<{ ok: boolean; runId?: string; status?: string; question?: string; reason?: string; error?: string; errors?: Array<{ path: string; message: string }> }>;
      legacyFlowApprove?: (runId: string, approved: boolean, note?: string) =>
        Promise<{ ok: boolean; runId?: string; status?: string; question?: string; reason?: string; error?: string }>;
      legacyFlowList?: () => Promise<Array<{
        runId: string; sessionId: string; flowName: string; flowVersion: number;
        startedAt: number; updatedAt: number; terminal?: string; summary: string;
        awaitingApproval: boolean; question?: string;
      }>>;
      legacyFlowGet?: (runId: string) => Promise<{ state: any; sessionId: string; flowPath?: string; updatedAt: number } | null>;
      legacyFlowDiscard?: (runId: string) => Promise<{ ok: boolean }>;
      onFlowUpdate?: (cb: (payload: any) => void) => () => void;
      onFlowNote?: (cb: (payload: any) => void) => () => void;
      ensureContext?: (sessionId: string) => Promise<{ ok: boolean; skipped?: boolean; rebuilding?: boolean; error?: string }>;
      setPrimeMode?: (sessionId: string, primeMode: 'snapshot' | 'full') => Promise<{ ok: boolean; primeMode?: 'snapshot' | 'full'; error?: string }>;
      readTranscript: (sessionId: string) => Promise<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: ToolCall[] }[]>;
      truncateTranscriptBefore: (sessionId: string, messageId: string) => Promise<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: ToolCall[] }[]>;
      forkBackendForEdit?: (sessionId: string, keepIds: string[]) => Promise<{ mode: 'none' | 'fork' | 'fresh' | 'snapshot' | 'fallback'; reason?: string; newId?: string }>;
      rewriteTranscript: (sessionId: string, messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: ToolCall[] }>) => Promise<{ ok: boolean }>;
      listDurableSessions: () => Promise<{ id: string; title: string; projectId?: string; model?: string; createdAt: number; updatedAt: number; archived: boolean; pinned?: boolean; remoteHost?: string; remoteId?: string; remoteMissing?: boolean }[]>;
      listSessions: () => Promise<any>;
      listKiroAgents: (machine?: string) => Promise<{ agents: Array<{ name: string; isDefault: boolean; source: 'built-in' | 'global' | 'local' }>; error?: string }>;
      openKiroAgentConfig: (sessionId: string, agentName: string, source?: 'built-in' | 'global' | 'local') => Promise<{ opened: boolean; path?: string; content?: string; error?: string }>;
      saveKiroAgentConfig: (sessionId: string, agentName: string, source: 'built-in' | 'global' | 'local' | undefined, content: string) => Promise<{ saved: boolean; path?: string; error?: string }>;
      /* `pending: true` = 这一轮还在跑，主进程记下来了，跑完再切（见 main/pendingSwitch.ts） */
      switchKiroAgent: (sessionId: string, agentName: string) => Promise<{ ok: boolean; kiroAgent: string; dormant?: boolean; pending?: boolean }>;
      switchModel: (sessionId: string, model: string) => Promise<{ ok: boolean; model: string; dormant?: boolean; pending?: boolean }>;
      switchPermissionMode: (sessionId: string, permissionMode: 'auto-approve' | 'ask') => Promise<{ ok: boolean; permissionMode: 'auto-approve' | 'ask'; dormant?: boolean; pending?: boolean }>;
      getPendingSwitches?: (sessionId?: string) => Promise<Record<string, Record<string, string>>>;
      getPendingSwitchSince?: () => Promise<Record<string, number>>;
      cancelPendingSwitch?: (sessionId: string, kind?: string) => Promise<{ ok: boolean; cancelled: boolean; pending: Record<string, string> }>;
      onPendingSwitches?: (cb: (d: { sessionId: string; pending: Record<string, string>; since?: number | null }) => void) => () => void;
      onPendingSwitchResult?: (cb: (d: { sessionId: string; applied: string[]; failed: Array<{ kind: string; label: string; error: string }>; profile: any; pending: Record<string, string>; since?: number | null }) => void) => () => void;
      deleteSession: (sessionId: string) => Promise<{ ok: boolean; tombstoned?: boolean; error?: string }>;
      assignProject: (sessionId: string, projectId: string) => Promise<{ sessionId: string; projectId: string }>;
      setProject: (sessionId: string, projectId: string | null) => Promise<{ sessionId: string; projectId: string | null }>;
      moveSession: (sessionId: string, projectId: string | null) => Promise<{ sessionId: string; projectId: string | null }>;
      archiveSession: (sessionId: string, archived: boolean) => Promise<{ sessionId: string; archived: boolean }>;
      sessionInfo: (sessionId: string) => Promise<{ ok: boolean; error?: string; info?: import('./sessionInfo').SessionInfo }>;
      getExecutorCap: () => Promise<number>;
      getExecutorCapInfo: () => Promise<{ cap: number; auto: number; overridden: boolean }>;
      prepareImageAttachment?: (filePath: string) => Promise<{ path: string; downscaled?: boolean; from?: string; to?: string }>;
      getFeatures?: () => Promise<{ flags: Record<string, boolean>; defaults: Record<string, boolean> }>;
      setFeature?: (key: string, enabled: boolean) => Promise<{ ok: boolean; flags?: Record<string, boolean>; error?: string }>;
      setExecutorCap: (n: number) => Promise<{ ok: boolean; cap: number }>;
      getWedgeTimeout: () => Promise<{ seconds: number; default: number; min: number; max: number }>;
      setWedgeTimeout: (n: number) => Promise<{ ok: boolean; seconds: number }>;
      getForwardMcp?: () => Promise<Array<{ name: string; timeoutSec: number }>>;
      browserStatus?: () => Promise<LocalBrowserStatusView>;
      browserSetConfig?: (patch: { enabled?: boolean; browser?: string; firefoxPort?: number }) => Promise<unknown>;
      browserConnect?: (kind: string) => Promise<{ ok: boolean; error?: string }>;
      browserRestartFirefox?: () => Promise<{ ok: boolean; error?: string }>;
      browserDomainReply?: (id: string, decision: 'once' | 'session' | 'deny') => Promise<{ ok: boolean }>;
      browserPendingAsks?: () => Promise<BrowserDomainAsk[]>;
      onBrowserDomainAsk?: (callback: (ask: BrowserDomainAsk) => void) => () => void;
      onBrowserStatusChanged?: (callback: () => void) => () => void;
      onBrowserDomainAskCancelled?: (callback: (ids: string[]) => void) => () => void;
      setForwardMcp?: (list: Array<{ name: string; timeoutSec?: number }>) => Promise<{ ok: boolean; list: Array<{ name: string; timeoutSec: number }> }>;
      getToolStallTimeout: () => Promise<{ seconds: number; default: number; min: number; max: number }>;
      setToolStallTimeout: (n: number) => Promise<{ ok: boolean; seconds: number }>;
      getWorkspaceDir: () => Promise<string | null>;
      setWorkspaceDir: (dir: string) => Promise<{ ok: boolean; error?: string }>;
      getHelperModels: () => Promise<{ model: string; fallback: string; defaults: { model: string; fallback: string } }>;
      setHelperModels: (model: string, fallback: string) => Promise<{ model: string; fallback: string }>;
      reveal: () => Promise<{ revealed: boolean }>;
      splashStatus: (text: string) => Promise<{ ok: boolean }>;
      deleteProjectMemory: (projectId: string) => Promise<{ projectId: string }>;
      readMemory: (projectId?: string, sessionId?: string) => Promise<{ global: string; project: string; session: string; projectId: string | null; sessionId: string | null; globalPath: string; projectPath: string | null; sessionPath: string | null }>;
      readLastInjection: (sessionId?: string) => Promise<{
        text: string; at: number | null; path: string | null;
        /** A hand-edited block is pinned: `text` is that block, not the archive. */
        override?: boolean; overrideAt?: number | null; overridePath?: string | null;
        /** The archive, regardless of the override, so the UI can show what reverting goes back to. */
        sentText?: string;
      }>;
      writeContextOverride?: (sessionId: string, text: string) => Promise<{ ok: boolean; override?: boolean; path?: string; error?: string }>;
      clearContextOverride?: (sessionId: string) => Promise<{ ok: boolean; existed?: boolean; error?: string }>;
      writeMemory: (scope: 'global' | 'project' | 'session', projectId: string | undefined, sessionId: string | undefined, content: string) => Promise<{ ok: boolean }>;
      onSessionsPurged?: (callback: (data: { sessionIds: string[] }) => void) => () => void;
      /** 主进程记完账之后推一把 —— run 可能有新的一波能跑了（见 `run:advance`） */
      onRunAdvance?: (callback: (data: { project: string; id: string }) => void) => () => void;
      memoryBytes: (projectId?: string, sessionId?: string) => Promise<{ global: number; project: number; session: number }>;
      backupMemory: (scope: 'global' | 'project' | 'session', projectId?: string, sessionId?: string) => Promise<{ ok: boolean; at: string | null }>;
      onMemoryBytes: (callback: (data: { sessionId: string; projectId: string | null; global: number; project: number; session: number }) => void) => () => void;
      prompt: (sessionId: string, prompt: any[], model: string, projectId?: string, display?: { messageId?: string; displayText?: string; mergeIntoMessageId?: string; attachments?: any[]; pastes?: any[]; fromHandoff?: string[] }) => Promise<any>;
      cancel: (sessionId: string, model: string, suppressInterruptionNotice?: boolean) => Promise<void>;
      steer: (sessionId: string, message: string, msgId?: string) => Promise<{ steered: boolean; reason?: string; messageId?: string }>;
      /** 忙时 Enter 交给适配器排队（promptQueueing，主进程 acp:handoff-prompt） */
      handoffPrompt?: (sessionId: string, prompt: any[], model?: string, projectId?: string, display?: { messageId?: string; displayText?: string; attachments?: any[]; pastes?: any[] }) => Promise<{ accepted: boolean; reason?: string; error?: string }>;
      takePendingHandoffs?: () => Promise<{ recover: Record<string, Array<{ id: string; content: string; attachments?: any[]; pastes?: any[]; ts: number }>>; live: Record<string, Array<{ id: string; content: string; attachments?: any[]; pastes?: any[]; ts: number }>> }>;
      ackHandoffFailed?: (sessionId: string, messageId: string) => Promise<{ ok: boolean }>;
      onHandoffFailed?: (cb: (d: { sessionId: string; messageId?: string; notStarted: boolean; error: string; content?: string; attachments?: any[]; pastes?: any[] }) => void) => () => void;
      capSteerText?: (message: string) => Promise<string>;
      /** Claude Code / Codex 的下拉清单 + 忙时 Enter 交给谁（`busyEnter`，main/busyEnterCaps.ts）；kiro 会话回 null */
      engineModels?: (sessionId: string) => Promise<{ sessionId: string; busyEnter?: string } | null>;
      onEngineModels?: (cb: (d: { sessionId: string; busyEnter?: string }) => void) => () => void;
      /** Persist a CONSUMED steer into the durable transcript (its only writer:
       *  steers never go through `prompt`). Merges into the turn's base user
       *  message, which is also how it is rendered. */
      persistSteer?: (sessionId: string, text: string, messageId?: string, attachments?: { id?: string; name: string; path: string; isImage?: boolean }[]) => Promise<{ ok: boolean; merged?: boolean; error?: string }>;
      respondPermission: (requestId: number | string, optionId: string, sessionId: string) => Promise<void>;
      answerQuestion?: (sessionId: string, cardId: string, action: 'accept' | 'decline', values?: Record<string, unknown>) =>
        Promise<{ ok: true; card: QuestionCard } | { ok: false; error: string; missing?: string[]; invalid?: string[] }>;
      pendingQuestions?: () => Promise<QuestionCard[]>;
      cancelQuestions?: (sessionId: string) => Promise<number>;
      listModels: (machine?: string) => Promise<any>;
      listHelperModels?: (opts?: { cachedOnly?: boolean }) => Promise<{ lists: import('../main/helperModels').MachineModelList[]; cachedIds: string[]; fallbackOrder: string[] }>;
      getUsage: () => Promise<{ text: string }>;
      generateTitle: (firstUser: string, firstAssistant?: string, sessionId?: string) => Promise<{ title?: string; error?: string; skipped?: boolean | 'engine' }>;
      generateSuggestions: (recentConvo: string, meta?: { sessionId?: string | null; messages?: number; paneFocused?: boolean }) => Promise<{ suggestions: string[]; error?: string }>;
      setSessionPinned: (id: string, pinned: boolean) => Promise<{ sessionId: string; pinned: boolean }>;
      getHomeDir: () => Promise<string>;
      getLogs: (maxLines?: number) => Promise<{ text: string; path: string }>;
      openLogs: () => Promise<{ ok: boolean; error?: string }>;
      diagSessionView?: (event: string, detail: Record<string, unknown>) => void;
      openExternal: (target: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
      savePasteText: (text: string) => Promise<{ path: string; lines: number; chars: number; preview: string } | null>;
      readPaste: (filePath: string) => Promise<string | null>;
      getAutoResent: () => Promise<Record<string, string>>;
      setAutoResent: (sessionId: string, key: string) => Promise<{ ok: boolean }>;
      getDraftPastes: () => Promise<Record<string, any[]>>;
      setDraftPastes: (sessionId: string, blocks: any[]) => Promise<{ ok: boolean }>;
      pickFiles: () => Promise<Array<{ path: string; name: string; isImage: boolean }>>;
      saveClipboardImage: () => Promise<{ path: string; name: string; thumbnail: string } | null>;
      /** Registered flows (KiroLex's own registry, ~/.kirolex/flows). A project may only pick a
       *  CONFIRMED one — a draft nobody checked must not be drawn as if it were the skill. */
      flowRegList?: () => Promise<any[]>;
      flowRegGet?: (name: string) => Promise<any | null>;
      flowRegSetAgent?: (name: string, agent: string) => Promise<{ ok: boolean; error?: string }>;
      flowRegSetModel?: (name: string, model: string) => Promise<{ ok: boolean; error?: string }>;
      onFlowRegChanged?: (callback: (data: { name: string }) => void) => () => void;
      flowRegSave?: (entry: any) => Promise<{ ok: boolean; error?: string }>;
      flowRegConfirm?: (name: string, fingerprint: string) => Promise<{ ok: boolean; error?: string }>;
      flowRegRename?: (from: string, to: string) => Promise<{ ok: boolean; error?: string; runs?: number; sessions?: number }>;
      flowRegRemove?: (name: string) => Promise<{ ok: boolean }>;
      /** sessionId is optional everywhere below: it only picks the default
       *  directory / relative base. These are local disk reads and must never
       *  require a connected chat. */
      workspaceList: (sessionId?: string | null, directory?: string) => Promise<{
        path: string;
        parent: string;
        entries: Array<{ name: string; isDir: boolean }>;
      }>;
      workspaceRead: (sessionId: string | null | undefined, filePath: string) => Promise<{
        path: string;
        content: string;
        truncated?: boolean;
        binary?: boolean;
        /** Images come back as a base64 data URL for inline display. */
        image?: boolean;
        dataUrl?: string;
        /** 远程会话那台机器上的文件（本机没有，经 ssh 读的） */
        remote?: boolean;
        remoteHost?: string;
      }>;
      /** 远程会话落在远端的文件 → 复制进这条会话的本机文件夹，回本机路径 */
      copyRemoteToLocal?: (sessionId: string, remotePath: string) => Promise<{ ok: boolean; path?: string; bytes?: number; error?: string }>;
      /**
       * 侧栏 review 的「✓ 确认」—— 在**打开这份文件的那条会话**里改一块（正忙就在主进程里排队）。
       *   `block`（默认）只回改完的这一块；`patch` 跨段 —— block 那次回了 `cannot`、或者整篇的意见时才问，
       *   模型只交回要换的那几处（带行号），主进程拼回去。
       * `full` 是 patch 的基准正文（盘上此刻那一份，行号按它编）；`fromLine..toLine` 是意见指的那几行。
       */
      reviseInSession?: (input: {
        sessionId: string; where: string; note: string; about?: string;
        scope?: 'block' | 'patch' | 'insert'; label?: string; full?: string; fromLine?: number; toLine?: number; ticket?: string;
        /** 回复由主进程拼回去、写盘（窗口 reload 了也不丢）—— 见 main/reviewApply.ts */
        apply?: { path: string; mode: 'splice' | 'insert' | 'patch'; from?: number; to?: number; base: string };
      }) => Promise<{
        ok: boolean; text?: string; cannot?: string; error?: string; cancelled?: boolean;
        /** `patch` 档：文件在等回复期间被别的改动动过了，这次没写（界面保留意见，刷新后重试）。 */
        conflict?: boolean;
        scope?: 'block' | 'patch' | 'insert'; written?: boolean; fullText?: string;
        /**
         * `patch` 档实际改了的每一处（见 main/reviewApply.ts 的 `PatchChange`）：
         * `from..to` 新文件里的行范围（删掉的那处 `to = from - 1`）、`oldText` 原来的文本、
         * `oldFrom..oldTo` 原文件里的行范围、`newText` 新文件里那几行。给高亮和逐段撤销用。
         */
        changes?: Array<{ from: number; to: number; oldFrom: number; oldTo: number; oldText: string; newText: string }>;
      }>;
      /**
       * 把改完的正文写回那个文件 —— 路径按 `sessionId` 解析（和 workspaceRead 同一个 resolveUserPath），
       * 只许写**这条会话的标签页读过**的，写前备份到 `~/.kirolex/backups/review-files/`。
       */
      reviewWriteFile?: (sessionId: string | null | undefined, filePath: string, text: string, expectBase?: string)
        => Promise<{ ok: boolean; path?: string; bytes?: number; was?: number; unchanged?: boolean; mismatch?: boolean; error?: string }>;
      /** 提交前拷一份 —— 提交那条路是会话自己写文件，走不到上面那道写前备份。 */
      reviewBackupFile?: (sessionId: string | null | undefined, filePath: string)
        => Promise<{ ok: boolean; at?: string; bytes?: number; error?: string }>;
      /**
       * `.pptx`/`.docx`… → 一个 PDF（`.pdf` 直通，不需要 LibreOffice）+ 每页讲稿。路径按 `sessionId` 解析。
       * 没有 LibreOffice 时 `ok: false` + `why`（找过哪里、怎么装）+ `install`（那条命令，界面配复制按钮）。
       */
      previewDeck?: (sessionId: string | null | undefined, filePath: string, force?: boolean) => Promise<{
        ok: boolean; pdf?: string; pages?: number | null; notes?: string[] | null; pdfHash?: string | null;
        editable?: boolean; notesWhy?: string; why?: string; install?: string; noConverter?: boolean;
      }>;
      /** PDF 的字节（base64）—— 渲染层取不到 `file://`。 */
      previewPdfBytes?: (sessionId: string | null | undefined, pdfPath: string)
        => Promise<{ ok: boolean; base64?: string; bytes?: number; why?: string }>;
      /** 改**一页**的演讲者备注（只动那一页的 XML part）—— 写前备份，返回重抽的全部备注。 */
      /** `expect`：这条意见是对着哪一份讲稿提的 —— 盘上这一页已经不是它就不写（`conflict`） */
      deckWriteNote?: (sessionId: string | null | undefined, filePath: string, page: number, text: string, expect?: string)
        => Promise<{ ok: boolean; notes?: string[]; error?: string; conflict?: boolean }>;
      /** 问打开这份 deck 的会话这一页的字/版面该怎么改，KiroLex 按 run 地址写（正忙就排队）。 */
      /** 取消侧栏 comment 提交的那一次改写（按 ticket）。 */
      reviewCancel?: (ticket: string) => Promise<{ ok: boolean }>;
      reviewTicketsDone?: (tickets: string[]) => Promise<string[]>;
      /** 这几张 ticket 后来怎样了（live / retry / unknown / done / final，见 reviewResume.TicketStatus）—— 窗口重载后决定再提交时沿用还是新起 */
      reviewTicketsStatus?: (tickets: string[]) => Promise<Record<string, string>>;
      deckReviseSlideText?: (input: { sessionId: string; filePath: string; page: number; note: string; ticket?: string })
        => Promise<{ ok: boolean; changed?: number; partial?: string; cannot?: string; error?: string }>;
      deckReadSlideText?: (sessionId: string | null | undefined, filePath: string, page: number)
        => Promise<{ ok: boolean; runs?: Array<{ at: string; text: string }>; error?: string }>;
      deckWriteSlideText?: (sessionId: string | null | undefined, filePath: string, page: number, edits: Array<{ at: string; text: string }>)
        => Promise<{ ok: boolean; changed?: number; error?: string }>;
      /** 在某条会话里留一行 KiroLex 自己说的话（显示，但不发给模型）—— 改写落盘之后报一句。 */
      sessionNote?: (sessionId: string, text: string, variants?: { zh: string; en: string }) => Promise<{ ok: boolean; error?: string }>;
      /** Watch exactly these files for on-disk edits, replacing the previous set. */
      workspaceWatchFiles?: (sessionId: string | null | undefined, paths: string[]) => Promise<{ ok: boolean; watching: number; dirs: number }>;
      onWorkspaceFileChanged?: (callback: (data: { path: string; exists: boolean; mtimeMs: number }) => void) => () => void;
      pathExists: (filePath: string, sessionId?: string) => Promise<boolean>;
      /** Session-independent image read for attachment thumbnails; null when the
       *  path is missing, unreadable, oversized, or not an image. */
      readImageDataUrl?: (filePath: string) => Promise<{ path: string; dataUrl: string } | null>;
      showItemInFolder?: (filePath: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
      workspaceDownload: (sessionId: string | null | undefined, filePath: string) => Promise<{
        ok: boolean;
        path?: string;
        canceled?: boolean;
        error?: string;
      }>;
      onUpdate: (callback: (data: any) => void) => () => void;
      onError: (callback: (error: any) => void) => () => void;
      onNotice?: (callback: (n: { sessionId: string; level: string; kind: string; label: string; text: string }) => void) => () => void;
      onAssistantFinal: (callback: (data: { sessionId: string; messageId: string; text: string; toolTailFrom?: number; replyTo?: string; replyComplete?: true }) => void) => () => void;
      onSessionBusy: (callback: (data: { sessionId: string; reason: string | null; detail?: string; detailVariants?: { zh: string; en: string } }) => void) => () => void;
      /** kiro 原生子代理名单（整份替换）—— 左栏那面 tag 靠它，直到全部 terminated */
      onSubagents?: (callback: (data: { sessionId: string; subagents: SubagentRow[] }) => void) => () => void;
      onUserMessage?: (callback: (data: { sessionId: string; messageId: string; content: string; ts: number; kirolex?: true; variants?: { zh: string; en: string }; noteGroup?: string }) => void) => () => void;
      onSessionModel: (callback: (data: { sessionId: string; model: string }) => void) => () => void;
      onTurnRestart: (callback: (data: { sessionId: string }) => void) => () => void;
      onTurnQuiet: (callback: (data: { sessionId: string; quietSeconds: number; openTools?: number; toolIdleSeconds?: number; interruptInSeconds?: number | null; boundBy?: 'tool' | 'quiet'; boundSeconds?: number }) => void) => () => void;
      onTurnWedged: (callback: (data: { sessionId: string; produced: boolean }) => void) => () => void;
      getBusyMap: () => Promise<Record<string, string>>;
      getCreateStages?: () => Promise<import('./createStages').CreateStageInfo[]>;
      getCreateArgs?: (sessionId: string) => Promise<import('./createStages').CreateArgs | null>;
      onCreateStage?: (callback: (data: import('./createStages').CreateStageInfo) => void) => () => void;
      /** Is a turn running for this chat right now, and what has it produced? Lets a reloaded
       *  window adopt a turn that never stopped instead of resending the question. */
      peekTurn?: (sessionId: string) => Promise<{ live: boolean; messageId: string | null; text: string; startedAt: number | null }>;
      /** 这条会话的斜杠命令表（后端推过的原样那份），窗口重载后靠它补回来。 */
      sessionCommands?: (sessionId: string) => Promise<{ commands: any[] }>;
      onDisconnected: (callback: (data?: any) => void) => () => void;
      onSessionReady: (callback: (data: { sessionId: string; projectId?: string }) => void) => () => void;
    };
  }
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: AttachedFile[];
  toolCalls?: ToolCall[];
  /** Present on a user message injected mid-turn via _session/steer:
   *  'pending' = written, awaiting the agent's next tool boundary;
   *  'consumed' = the agent folded it into the running turn;
   *  'failed' = `acp:steer` refused it — shown in red with "send next / back to input"
   *  (`steerError` is the reason), never silently queued. */
  steer?: 'pending' | 'consumed' | 'failed';
  steerError?: string;
  timestamp: number;
  /** Pasted blobs referenced by `[ 粘贴 #N · M 行 ]` placeholders in content. */
  pastes?: { seq: number; lines: number; chars: number; path: string }[];
  /** KiroLex 自己对你说的话（主进程 noteInSession 落盘时带的标记），不是你的提问 —— 见 `main/kirolexNote`。 */
  kirolex?: true;
  /** 这句 KiroLex 提示的中英两版 —— 显示时按界面语言挑（`pickVariant`）；没有就显示 `content`。 */
  variants?: { zh: string; en: string };
  /** 这句 KiroLex 提示的「类型:对象[→结果]」—— 相邻同类的几条并成一条「×N」（`noticeMerge`）。 */
  noteGroup?: string;
  /** 从盘上读回来时，折叠进这条用户消息的追加指令各段（`content` 已含它们）—— 只用来拆开显示，见 `steerSplit`。 */
  steerParts?: { id: string; content: string; ts: number }[];
  /** 助手消息：这一轮最后一次真实工具调用开始时正文的长度（主进程落盘时记的）—— 判「把工具调用写成了文字」只看这之后（`main/textToolCall.ts`）。 */
  toolTailFrom?: number;
  /** 助手消息：回的是哪一条用户消息 / 是不是正常收尾的完整回复（主进程落盘时记的，发送去重按它认"答过了"，见 `main/promptDedupe.ts`）。
   *  只是原样带着 —— 读回来、整份重写时都不能丢。 */
  replyTo?: string;
  replyComplete?: true;
  /** 模型向用户的一次提问（提问卡片，`main/elicitation.ts`）。这种消息正文是空的，在这一轮的回复气泡里画成卡片。 */
  question?: QuestionCard;
  /** 只活在界面里：排队那条发出去时这一次插进来的气泡的记号 —— 发送失败只撤它，不撤原来就在的同 id 历史（`queueRetry.removeOptimistic`）。 */
  sendToken?: string;
}

export interface ToolCall {
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content?: string;
  /** ACP tool kind (read/edit/execute/search/...) — drives the icon. */
  kind?: string;
  /** Absolute file paths this tool touched (ACP tool_call.locations[].path). */
  locations?: string[];
  /** File diffs carried by the tool call (ACP content blocks of type 'diff'). */
  diffs?: FileDiff[];
  /* 只有 Claude Code / Codex 的调用带（`main/toolTrace.ts`，和落盘的 StoredToolCall 同名） */
  toolName?: string;
  input?: string;
  parentToolCallId?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface FileDiff {
  path: string;
  oldText?: string;
  newText: string;
}

/** A single entry of the agent's execution plan (ACP `plan` update). */
export interface PlanEntry {
  content: string;
  priority?: 'high' | 'medium' | 'low';
  status?: 'pending' | 'in_progress' | 'completed';
  /** Current task in the persisted checklist; normally the in_progress entry. */
  current?: boolean;
}

export interface AttachedFile {
  id: string;
  name: string;
  path: string;
  isImage?: boolean;
  preview?: string; // thumbnail data URL for image attachments
}

/** 控制入口发来的一条：`report` 在决定走哪条路的那一刻告诉主进程（`sent` / `steer` / `queued` + 消息 id）。 */
interface ControlSendCtx {
  report: (r: { routed: 'sent' | 'steer' | 'queued'; messageId: string; steerFailed?: string }) => void;
  /** 消息 id 带哪种来源标记：`ctl` = 经控制入口（标「经控制入口发送」），`xs` = 别的会话经 session_send（显示「📨 来自会话」） */
  origin: MarkOrigin;
}
export type ControlSendReply =
  | { ok: true; routed: 'sent' | 'steer' | 'queued'; messageId: string; steerFailed?: string }
  | { ok: false; status: number; error: string };

export interface QueuedMessage {
  id: string;
  /** DISPLAY text: keeps `[ 粘贴 #N · M 行 ]` placeholders so the queue card stays
   *  readable. `pastes` carries the real content for delivery. */
  content: string;
  attachments: AttachedFile[];
  pastes?: PastedBlock[];
  createdAt: number;
  /**
   * 这一条是**从磁盘恢复**的（上一次窗口关掉/刷新时它还在排队）。
   *
   * 标记的用处是不让它抢跑:重启之后所有会话都是空闲的,而排空规则「空闲就发」原本假设你正坐在这儿 ——
   * 那会变成一次无人看着的发送。带标记的条目只在两种情况下发:那个会话的回合还在跑(队列本来就在等它),
   * 或者你把那个会话打开了(你在看着)。发出去或者被你编辑过之后,这个标记就没有意义了。
   */
  restored?: boolean;
  /**
   * 会话正在**后台重建历史**时按的普通 Enter（不能 steer 进那个隐藏的 priming 轮）。
   * 它不显示成普通排队卡片，而是标「重建历史中，结束后发送」；排在普通排队之前（`steerRoute.withAfterRebuild`），
   * 重建一结束就作为下一条单独发出。放进队列结构里是为了复用落盘和排空，不是"排队"。
   */
  afterRebuild?: boolean;
  /** 这一批发失败、放回了队头：重试时原样（同一批、同一个 messageId）再发，见 `queueRetry.pickQueuedBatch`。 */
  retryBatch?: RetryBatch;
  /** 交给适配器却没轮到、放回来的那条原来的消息 id（主进程 pendingHandoffs）—— 重启恢复时据此不再放回第二遍 */
  fromHandoff?: string;
}

/** 远程会话的同步状态（`docs/DESIGN_remote_sessions.md`）。 */
export interface Session {
  id: string;
  title: string;
  model: string;
  /** Named kiro-cli agent for this session. Undefined = kiro_default. */
  kiroAgent?: string;
  /** 哪个引擎跑这条会话。Undefined = kiro（所有老会话）。 */
  engine?: 'kiro' | 'claude' | 'codex';
  /** Tool approvals for this session. Undefined legacy sessions default to Bypass. */
  permissionMode?: 'auto-approve' | 'ask';
  /** Write-once memory-scoping label (design §4/§6.4). Undefined = unassigned. */
  projectId?: string;
  /** Pinned sessions sort to the top of their group. */
  pinned?: boolean;
  /**
   * WHAT THIS CHAT IS FOR, when it is not a conversation the user started.
   *
   * `'skill'` marks the transient sessions a skill canvas brings with it (注册 / 改结构): they exist to argue
   * about one structure and are closed when it is registered or the canvas is shut. The marker is what makes
   * that closing safe — without it the rule would reap whichever chat happened to be underneath.
   * Persisted with the rest of the index in `ui-state.json`, so no new file.
   */
  /**
   * 这个会话是干什么的 —— **持久化在记录里**(`SessionRecord.purpose`),不再只活在内存。
   *
   * `skill`      注册/修改 flow 时那个临时画布会话
   * `flow-main`  某个 flow 的主会话:删不掉、不回收、不干业务
   * `main`       旧的 project 级主会话,只为识别并降级它而保留
   */
  purpose?: 'skill' | 'main' | 'flow-main' | 'flow-worker';
  /** `flow-main` 属于哪个 flow。标题是给人看的,这个才是身份 */
  flow?: string;
  /**
   * **这条会话跑在哪台机器上**（`undefined` = 本地）。给人看的短名字，不是整串 `user@host`。
   *
   * 侧栏常驻一个徽标：任何时候都不该去猜"这一轮是在哪台机器上跑的"
   * （`docs/DESIGN_remote_sessions.md`）。
   */
  remoteHost?: string;
  /**
   * 同一台机器在设置里的 **id**（`listDurableSessions` 带出来的；本地 = undefined）—— 审计 10b：
   * 分叉 / 复制一条远程会话要在同一台机器上建，显示名不能拿来建会话。
   */
  remoteId?: string;
  /** 记录里的那台机器在设置里已经找不到了（删掉了）—— 分叉时据此明说，不换机器。 */
  remoteMissing?: boolean;
  /**
   * 还没发过消息的分叉会话（`pending_*`）首条消息要用的机器：`''` = 明确是本机，没有这个字段 = 没记过。
   * 记在行上是因为行整份落盘 —— 分叉后没发消息就重启，靠它找回机器，而不是退回新会话默认机器（审计 10b）。
   */
  forkRemoteId?: string;
  /**
   * **这条会话在哪棵树上干活**（记录为准；没归项目的会话是它自己的会话目录）。
   *
   * 会话界面上常驻显示它 ——「工作目录这个东西放到右侧会话」。远程会话尤其需要：远端只看得见
   * 被镜像的那一个目录，所以"它读哪棵树"不该是要靠猜的事。
   */
  localDir?: string;
  /** User-archived: hidden from the main list into a collapsible Archived group. */
  archived?: boolean;
  folderId?: string | null; // legacy — retained for back-compat, no longer surfaced
  lastMessage?: string;
  timestamp: number;
}

export interface SessionFolder {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface Settings {
  /** 聊天字号（px）：只管聊天内容区的字。整窗放大缩小是 `uiZoom`。 */
  fontSize: number;
  /** 界面缩放，整数百分比（80～200，一档 10，默认 100），整窗按比例缩放，见 `uiZoom.ts`。 */
  uiZoom: number;
  /** Font stack for all UI/chat text. Empty = system default. */
  fontFamily: string;
  /** Font stack for code blocks and file paths. Empty = built-in mono stack. */
  monoFontFamily: string;
  mergeQueuedMessages: boolean;
  /** After a restart, automatically RESEND an unanswered prompt when its chat is opened. */
  recoverInterruptedTurns: boolean;
  /** 被非人为原因打断（执行器死了、重启、看门狗）的那一轮最多自动重发几次。0 = 不重发。默认 10。 */
  autoRetryMax?: number;
  /**
   * 重启后恢复界面状态 —— 左侧会话栏收没收起、各组折叠、comment 模式和每份文件里的 comment 标记。
   * 关了只活过窗口 reload（见 `uiRestore`）。默认开。
   */
  restoreUiState?: boolean;
  /** 按引擎区分强调色（Kiro 紫 / Claude Code 橙 / Codex 青绿，只用在几个小元素上，见 `engineTheme.ts`）。默认开；关 = 统一强调色。 */
  engineAccents?: boolean;
  /** Auto-fold 💭 thinking segments once thinking finishes (default on). */
  autoFoldThinking: boolean;
  /** Auto-fold 🔧 tool segments once the tool call finishes (default on). */
  autoFoldTools: boolean;
  /** Split-view grid, "<rows>x<cols>". Caps how many chats can be shown at once. */
  splitGrid: SplitGrid;
  /**
   * 界面语言。放在 `Settings` 里而不是单独一个 ui-state 键：持久化和「改了立刻生效」都是
   * 现成的（settings 是 React state，一变整棵树重渲染），而语言正是渲染输入。
   */
  language: Lang;
}

export type SplitGrid = '1x1' | '1x2' | '2x1' | '2x2';

export const SPLIT_GRIDS: Record<SplitGrid, { rows: number; cols: number; capacity: number }> = {
  '1x1': { rows: 1, cols: 1, capacity: 1 },
  '1x2': { rows: 1, cols: 2, capacity: 2 },
  // Two stacked full-width chats: better than 1x2 for long transcripts and wide
  // diffs, where horizontal room matters more than vertical.
  '2x1': { rows: 2, cols: 1, capacity: 2 },
  '2x2': { rows: 2, cols: 2, capacity: 4 },
  // 1x3 / 2x3 removed: three columns leave each pane too narrow to be usable at
  // this window size, so 2x2 is the real maximum. Saved values of the retired
  // grids fall back to 2x2 (see loadSettings).
};

const DEFAULT_SETTINGS: Settings = { fontSize: 12, uiZoom: UI_ZOOM_DEFAULT, fontFamily: '', monoFontFamily: '', mergeQueuedMessages: false, autoFoldThinking: true, autoFoldTools: true, recoverInterruptedTurns: true, autoRetryMax: 10, restoreUiState: true, engineAccents: true, splitGrid: '1x2', language: 'zh' };

/** One open file in the viewer. Content and view state live PER TAB so switching
 *  back restores exactly what you were looking at. */
export interface FileTab {
  id: string;
  path: string;
  /** 当初点开时给的路径（可能是相对的）—— `path` 读完会换成解析后的绝对路径，判重要两个都比 */
  requestedPath?: string;
  content: string;
  truncated?: boolean;
  binary?: boolean;
  image?: boolean;
  dataUrl?: string;
  /** Show raw source instead of rendered markdown / highlighted code. */
  raw?: boolean;
  /** The file changed on disk while this tab was in the BACKGROUND. Re-read when it
   *  is next activated, rather than re-reading every open tab on every save: a build
   *  can rewrite a dozen files a second, and only the visible one is being looked at. */
  stale?: boolean;
  /** The file is no longer on disk (deleted or renamed away). Kept as a tab so the
   *  content stays readable, but labelled -- silently showing a stale copy of a file
   *  that no longer exists is worse than saying so. */
  gone?: boolean;
  /**
   * **哪条会话该负责改这份文件** —— 打开这个标签页时那条会话，钉在标签页上。
   *
   * 「确认一下侧栏的每个 tab 知道应该由哪个会话改写，而不是随意飘移到其他没有上下文的会话」。
   * 审阅的「✓ 确认」是在会话里改的，而 `currentSessionId` 是**此刻选中的**那条 —— 你在 A 里做出这份文件、
   * 打开它、去 B 看了一眼，回来提一条意见，那条意见就发给了 B。B 没见过这份文件。
   * 所以钉住：从哪条会话打开，就由那条会话改、以它的名义写回（相对路径也按它解析）。
   * 空的（没有会话时打开的）就不给「✓ 确认」和「提交」。
   */
  ownerSessionId?: string;
  /** 这份是远程会话那台机器上的文件（本机没有）—— 预览顶上给「⇩ 复制到本机」 */
  remote?: boolean;
  remoteHost?: string;
  /** 「⇩ 复制到本机」失败的原因（显示在那颗按钮旁边） */
  copyError?: string;
  /**
   * 这份文件在盘上最后一次变化（或者被手动刷新）的时间 —— **deck 的预览靠它重取**。文本那侧一直会自动更新
   * （正文就是 `content`）；deck 的 PDF 和讲稿是 `ReviewPane` 自己取的，不推这一下屏幕上还是旧那十四页。
   */
  changedAt?: number;
}
/** Cap: an image tab holds a base64 data URL (up to 25 MB each), so unbounded tabs
 *  would balloon renderer memory. Oldest non-active tab is evicted first. */
const MAX_FILE_TABS = 12;
const OPEN_TABS_KEY = 'kirolex-open-file-tabs';
/** 右侧文件 / comment 栏最窄多宽。 */
const FILE_PANEL_MIN = 320;
/** 拖宽右侧栏时**会话区至少留多宽** —— 再窄输入框和消息就没法用了（见 `fileViewerMax`）。
 *  取 240：Mac 笔记本 1440～1512 宽的屏上 review 栏要能拉得更宽（原来 420 时只能拉到 780～850 左右）。 */
const CHAT_MIN_WIDTH = 240;
const SPLIT_SESSION_KEY = 'kirolex-split-session';
/** 每个会话排着的后续消息 —— 落盘，因为它们是你已经按过回车的东西（见 `queuesBySession`） */
const QUEUES_KEY = 'kirolex-queues';
/** Dragged split-pane proportions. Shape-keyed inside the value, see `splitShape`. */
const SPLIT_SIZES_KEY = 'kirolex-split-sizes';
/** Stable empty collections: a pane with none of these keeps referential
 *  identity across renders, so React can skip re-rendering it. */
const EMPTY_FILES: AttachedFile[] = [];
const EMPTY_QUEUE: QueuedMessage[] = [];
/** Shared, so a pane with nothing to show does not get a NEW array every render --
 *  which would look like new content to every memo below it. */
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_PLAN: any[] = [];
const EMPTY_COMMANDS: any[] = [];
const EMPTY_LINKS: any[] = [];
/** Stable no-op for the monitor pane's inert handlers (a fresh arrow function
 *  per render would defeat any memoisation of the pane). */
const NOOP: any = () => {};

/** File types the in-app viewer can never render usefully — hand these straight
 *  to the OS default application instead of opening a dead "cannot preview" tab.
 *  Images are deliberately absent: the viewer shows them inline. */
const SYSTEM_APP_EXTS = new Set([
  // documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'epub', 'mobi',
  // archives / disk images
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'dmg', 'pkg', 'iso',
  // audio / video
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus',
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv',
  // design / binary assets
  'psd', 'ai', 'sketch', 'fig', 'xd', 'blend', 'heic', 'tiff', 'tif', 'raw',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // executables / stores
  'app', 'exe', 'msi', 'deb', 'rpm', 'so', 'dylib', 'dll', 'class', 'jar',
  'sqlite', 'sqlite3', 'db', 'parquet', 'xlsb', 'pyc', 'wasm',
]);

function needsSystemApp(p: string): boolean {
  const name = baseName(p);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return SYSTEM_APP_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * 能在侧栏逐行写意见的文件 —— Markdown 和纯文本。
 * 代码文件不在内：它们按行渲染会丢掉语法高亮，而且"让会话改一行代码"该走正常对话，不是批注。
 */
/**
 * 路径本身就说明了主人的那种 —— 会话自己的目录 `~/.kirolex/sessions/<id>/…`。
 * 给没存主人的旧标签兜底（存主人是后来才加的，见 `OPEN_TABS_KEY` 那段）。
 */
export function ownerFromPath(p: string): string | undefined {
  const m = /[\\/]\.kirolex[\\/]sessions[\\/](s_[\w-]+)[\\/]/.exec(String(p || ''));
  return m ? m[1] : undefined;
}

function isReviewableText(p: string): boolean {
  return /.(md|markdown|mdown|mkd|mdx|txt|text)$/i.test(String(p || '').trim());
}

/** Files whose preview should be RENDERED markdown rather than raw source. */
function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdown|mkd|mdx)$/i.test(String(p || '').trim());
}

// Syntax highlighting for the file/report viewer. Extension -> highlight.js
// language. Anything not listed falls back to plain text (never a wrong grammar,
// which mangles the output worse than no highlighting).
const VIEWER_LANGS: Record<string, string> = {
  json: 'json', jsonc: 'json', json5: 'json', map: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'ini',
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', swift: 'swift',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml', plist: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  diff: 'diff', patch: 'diff',
  dockerfile: 'dockerfile', tf: 'hcl', hcl: 'hcl',
  csv: 'plaintext', tsv: 'plaintext', log: 'plaintext', txt: 'plaintext',
};

function viewerLangFor(p: string): string | null {
  /* 用 `baseName`：Windows 路径上 `split('/')` 回的是整条路径，
     于是 `^dockerfile$` / `^makefile$` 永远匹配不上（那两种文件丢高亮） */
  const name = baseName(String(p || '').trim());
  if (/^dockerfile$/i.test(name)) return 'dockerfile';
  if (/^(makefile)$/i.test(name)) return 'makefile';
  const ext = (name.includes('.') ? name.split('.').pop() || '' : '').toLowerCase();
  const lang = VIEWER_LANGS[ext];
  return lang && lang !== 'plaintext' ? lang : null;
}

/** Pretty-print JSON so a minified config/report is actually readable. Returns
 *  null when the text isn't valid JSON (partial preview, JSONL, trailing commas),
 *  in which case the original text is shown untouched. */
function prettyJson(text: string): string | null {
  const t = (text || '').trim();
  if (!t || !/^[[{]/.test(t)) return null;
  try {
    const formatted = JSON.stringify(JSON.parse(t), null, 2);
    return formatted && formatted !== t ? formatted : null;
  } catch {
    return null;
  }
}

/** Highlighted HTML for a file preview, or null to fall back to plain text. */
function highlightForViewer(path: string, text: string): { html: string; lang: string; prettified: boolean } | null {
  const lang = viewerLangFor(path);
  if (!lang) return null;
  // 512 KB previews would make highlight.js chew for seconds; keep the UI snappy.
  if (text.length > 200_000) return null;
  const pretty = lang === 'json' ? prettyJson(text) : null;
  const source = pretty ?? text;
  try {
    const { value } = hljs.highlight(source, { language: lang, ignoreIllegals: true });
    return { html: value, lang, prettified: !!pretty };
  } catch {
    return null;
  }
}

function loadSettings(): Settings {
  try {
    const saved = uiGet('kirolex-settings');
    if (saved) {
      const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } as Settings;
      // A previously-saved grid that no longer exists (e.g. 3x3) must not leave
      // the app with an undefined capacity.
      // A saved 1x3 / 2x3 (both retired) lands here and becomes 2x2, the new maximum.
      if (!SPLIT_GRIDS[merged.splitGrid]) merged.splitGrid = '2x2';
      // 存量 settings 里没有 language；坏值也一律退回中文（见 normalizeLang）
      merged.language = normalizeLang(merged.language);
      // 存量 settings 里没有 uiZoom → 100%；坏值 / 越界的也规整回范围（见 normalizeUiZoom）
      merged.uiZoom = normalizeUiZoom(merged.uiZoom);
      return merged;
    }
  } catch {}
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: Settings) {
  try {
    uiSet('kirolex-settings', JSON.stringify(settings));
  } catch {}
}

const isMac =
  typeof navigator !== 'undefined' &&
  navigator.platform.toUpperCase().includes('MAC');
/** Windows / Linux：系统白标题栏去掉了（见主进程 createWindow），这里自己画一条深色的、可拖动的。 */
const isWinFrame = typeof navigator !== 'undefined' && !isMac;

/** 分屏标题旁引擎徽标的图标：和会话左下角那颗同一套（机器人是 kiro 的） */
const EngineBadgeIcon: React.FC<{ engine?: string }> = ({ engine }) =>
  engine === 'claude' ? <IconClaudeSpark size={11} /> : engine === 'codex' ? <IconCodex size={11} /> : <IconRobot size={11} />;

const App: React.FC = () => {
  /*
    **标题条：最大化时自动隐藏** ——「能让上面这个程序框自动隐藏吗」。窗口是无边框的（主进程 frame: false），
    最大化 / 全屏时标题条收起、不占高度；鼠标碰到屏幕顶边（那条 4px 的感应带）它滑下来，离开 600ms 后收回。
    还原成普通窗口时一直显示（要靠它拖动窗口）。
  */
  const [winMaxed, setWinMaxed] = useState(false);
  const [titlebarShown, setTitlebarShown] = useState(false);
  const titlebarHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isWinFrame) return;
    const off = (window as any).kiroApi?.onWindowMaximized?.((d: { maximized: boolean; height: number }) => {
      if (d?.height) document.documentElement.style.setProperty('--win-titlebar-height', `${d.height}px`);
      setWinMaxed(!!d?.maximized);
      setTitlebarShown(false);
    });
    return () => { try { off?.(); } catch { /* 卸载 */ } };
  }, []);
  const revealTitlebar = useCallback(() => {
    if (titlebarHideTimer.current) { clearTimeout(titlebarHideTimer.current); titlebarHideTimer.current = null; }
    setTitlebarShown(true);
  }, []);
  const scheduleHideTitlebar = useCallback(() => {
    if (titlebarHideTimer.current) clearTimeout(titlebarHideTimer.current);
    titlebarHideTimer.current = setTimeout(() => setTitlebarShown(false), 600);
  }, []);
  const windowControl = (action: 'minimize' | 'toggle-maximize' | 'close') => {
    void (window as any).kiroApi?.windowControl?.(action).then((r: any) => { if (r && typeof r.maximized === 'boolean') setWinMaxed(r.maximized); });
  };
  const {
    status,
    errorBySession,
    clearSessionError,
    sessions,
    currentSessionId,
    messages,
    isStreaming,
    streamingIds,
    attachedSessionIds,
    busyBySession,
    createStages,
    createStagesLoaded,
    retryCreateSession,
    usageBySession,
    usageOf,
    rebuildContext,
    cancelAutoResend,
    takeOrphanSteers,
    recoveringIds,
    turnOutcomeOf,
    interruptedSessionIds,
    connectingSessionIds,
    failedSessionIds,
    historyLoadingIds,
    paneViews,
    paneFallback,
    setPaneSessions,
    activeToolCall,
    subagents,
    activityStatus,
    turnStall,
    usage,
    plan,
    commands,
    permissionRequest,
    permissionRequests,
    connect,
    disconnect,
    forceStop,
    newSession,
    duplicateSession,
    retargetPendingSession,
    rerunFromMessage,
    switchSession,
    taskListFor,
    taskListTick,
    warmSession,
    unfocusSession,
    deleteSession,
    forgetSessions,
    renameSession,
    markSessionPurpose,
    changeSessionModel,
    changeSessionAgent,
    changeSessionPermissionMode,
    pendingSwitches,
    pendingSwitchSince,
    cancelPendingSwitch,
    assignProject,
    moveSession,
    reorderSessions,
    archiveSession,
    projects,
    createProject,
    reorderProjects,
    renameProject,
    deleteProject,
    togglePin,
    clearConversation,
    resetSessionCredits,
    sendMessage,
    sendQueuedMessage,
    steerMessage,
    handOffMessage,
    addFailedSteer,
    takeFailedSteer,
    takeUnconsumedSteers,
    discardUnconsumedSteers,
    cancelStream,
    respondPermission,
    contextLinks,
    toggleContextSource,
    loopingIds,
    createSchedule,
    schedules,
    scheduleNow,
    pauseSchedule,
    cancelSchedule,
    setScheduleExpiry,
    bgJobs,
    stopBgJob,
    stopLoop,
    restoredInputDraft,
    consumeRestoredInputDraft,
  } = useAcp();

  // Attachments are PER SESSION: with several composers on screen at once, one
  // shared list would let a file dropped on pane A be sent from pane B.
  const [attachedBySession, setAttachedBySession] = useState<Record<string, AttachedFile[]>>({});
  const attachedFor = useCallback(
    (sid: string | null) => (sid ? attachedBySession[sid] || EMPTY_FILES : EMPTY_FILES),
    [attachedBySession],
  );
  const addAttachments = useCallback((sid: string | null, files: AttachedFile[]) => {
    if (!sid) return;
    setAttachedBySession((prev) => ({ ...prev, [sid]: [...(prev[sid] || []), ...files] }));
  }, []);
  const clearAttachments = useCallback((sid: string | null) => {
    if (!sid) return;
    setAttachedBySession((prev) => (prev[sid]?.length ? { ...prev, [sid]: [] } : prev));
  }, []);
  const attachedFiles = attachedFor(currentSessionId);
  // The user's last explicitly-chosen model, persisted so it survives restart
  // and is the fallback for new chats and 'auto'/legacy sessions -- instead of
  // always snapping back to the hardcoded default.
  // The literal must equal main's DEFAULT_MODEL (pinned by
  // tests/modelFallback.test.ts); it used to say 'claude-opus-4.6' while main
  // created sessions on 'claude-opus-5'.
  const [selectedModel, setSelectedModel] = useState(() => {
    try { return uiGet('kirolex-last-model') || 'claude-opus-5'; }
    catch { return 'claude-opus-5'; }
  });
  const [models, setModels] = useState<any[]>([]);
  /**
   * 每台机器一份模型清单（`kirolex-models:<机器>`）—— 详见下面 `refreshModels` 上面那段。
   * 声明放在这里是因为 `modelForNewChat`（新会话选模型）在那之前就要读它。
   */
  const [modelsByMachine, setModelsByMachine] = useState<Record<string, any[]>>({});
  const askedModels = useRef(new Set<string>());
  /** 型号清单（字符串）—— 注册对话框、Flow 面板、画布的节点详情共用同一份，都是下拉 */
  const modelNames = useMemo(
    () => models.map((model: any) => String(model.model_id || model.id || model)).filter(Boolean),
    [models],
  );
  const [kiroAgents, setKiroAgents] = useState<Array<{ name: string; isDefault: boolean; source: 'built-in' | 'global' | 'local' }>>(() => {
    try {
      const cached = JSON.parse(uiGet(AGENTS_CACHE_KEY) || '[]');
      return Array.isArray(cached) ? cached : [];
    } catch { return []; }
  });
  /**
   * **agent 列表按机器分** ——「对远程会话，那个机器人按钮显示的还是本地的 agent 列表，不是远程的」。
   *
   * kiro-cli 只认**它自己机器上** `~/.kiro/agents/` 里的 agent。拿本机那份给远程会话选，
   * 选中的名字在远端不存在 —— 而那条路有兜底（会退回默认 agent 并在会话里说一句），
   * 于是表现是"下拉里明明有，选了却静默换成了别的"。和模型清单同一个形状（`modelsByMachine`）。
   */
  const [agentsByMachine, setAgentsByMachine] = useState<Record<string, Array<{ name: string; isDefault: boolean; source: 'built-in' | 'global' | 'local' }>>>({});
  const askedAgents = useRef(new Set<string>());

  const refreshAgents = useCallback(async (machine = 'local') => {
    const key = `${AGENTS_CACHE_KEY}${machine === 'local' ? '' : `:${machine}`}`;
    try {
      const data = await window.kiroApi.listKiroAgents(machine === 'local' ? undefined : machine);
      if (!data?.agents?.length) return;
      setAgentsByMachine((prev) => ({ ...prev, [machine]: data.agents }));
      if (machine === 'local') setKiroAgents(data.agents);
      try { uiSet(key, JSON.stringify(data.agents)); } catch {}
    } catch { /* 保留现有那份（内存里的或缓存里的） */ }
  }, []);



  /**
   * **空了就自己再去拉** —— 那次超时之后原来没有任何东西会重试。
   *
   * 只在**列表是空的**时候拉：那正是坏掉的那个状态（缓存也没有 = 第一次启动就撞上超时）。
   * 不无条件跟着 focus 拉是因为每次都要 spawn 一个 kiro-cli，而模型列表已经占了那一次 ——
   * 两个都跟着 focus 走，等于把启动风暴搬到每次切窗口。
   */
  useEffect(() => {
    if (kiroAgents.length) return;
    const again = () => { void refreshAgents(); };
    window.addEventListener('focus', again);
    window.addEventListener('online', again);
    return () => {
      window.removeEventListener('focus', again);
      window.removeEventListener('online', again);
    };
  }, [kiroAgents.length, refreshAgents]);
  // Per-session, NOT global: switching the model/Agent on one chat must never
  // grey out the selectors of another chat you switch to.
  const [switchingAgentIds, setSwitchingAgentIds] = useState<string[]>([]);
  const [switchingModelIds, setSwitchingModelIds] = useState<string[]>([]);
  const switchingAgent = !!currentSessionId && switchingAgentIds.includes(currentSessionId);
  const switchingModel = !!currentSessionId && switchingModelIds.includes(currentSessionId);
  const [showSettings, setShowSettings] = useState(false);
  /* ☁️ 备份自己一个弹窗（侧栏那颗 ☁️ 直接开它）—— 它是有状态、要回来看的东西，不是设置 */
  const [showBackup, setShowBackup] = useState(false);
  /** 打开设置时停在哪一页（侧栏那个 ☁️ 直接落到备份页）。 */
  const [settingsTab, setSettingsTab] = useState<'machines' | 'backup' | undefined>(undefined);
  /** 打开设置时机器页直接进入「添加一台机器」（侧栏右键「运行位置 → ＋ 添加机器…」）。 */
  const [settingsNewMachine, setSettingsNewMachine] = useState(false);
  /**
   * 上一次备份的结果 —— 侧栏那个 ☁️ 用它上色和写 title。
   *
   * 主进程每跑完一轮就推一次（`s3:sync-done`），启动时再问一次 —— 否则刚打开的那段时间
   * 按钮是灰的，看起来像"没配过"，而实际上只是这一次运行还没同步过。
   */
  const [backupState, setBackupState] = useState<{ at: number; uploaded: number; error?: string } | null>(null);
  useEffect(() => {
    const api = (window as any).kiroApi;
    let alive = true;
    void api?.getS3Config?.().then((c: any) => { if (alive && c?.last) setBackupState(c.last); }).catch(() => {});
    const off = api?.onS3SyncDone?.((d: any) => setBackupState(d || null));
    return () => { alive = false; try { off?.(); } catch {} };
  }, []);
  const [executorCap, setExecutorCap] = useState<number>(0);
  useEffect(() => {
    window.kiroApi.getExecutorCap?.().then((n) => { if (n) setExecutorCap(n); }).catch(() => {});
  }, []);
  // Settings changes the cap live; reflect the new value in the sidebar N/cap
  // display without an app reload.
  useEffect(() => {
    const h = (e: Event) => {
      const c = (e as CustomEvent).detail?.cap;
      if (typeof c === 'number' && c > 0) setExecutorCap(c);
    };
    window.addEventListener('kirolex:executor-cap-changed', h as EventListener);
    return () => window.removeEventListener('kirolex:executor-cap-changed', h as EventListener);
  }, []);
  // Keep the Settings "confirm before delete" toggle in lockstep with the value
  // delete actually uses (persisted flag). handleDeleteSession reads the flag live
  // from localStorage, so re-hydrate the state whenever Settings opens to avoid the
  // toggle showing a stale value that disagrees with the real delete behavior.
  useEffect(() => {
    if (!showSettings) return;
    try { setSkipDeleteConfirm(uiGet('kirolex-skip-delete-confirm') === 'true'); } catch {}
  }, [showSettings]);
  const [showWorkspace, setShowWorkspace] = useState(false);

  const [showMemory, setShowMemory] = useState(false);
  /** 记忆编辑器开给哪条会话、落在哪一层 —— 横幅的「编辑」从某个窗格打开（分屏时不一定是当前会话） */
  const [memoryTarget, setMemoryTarget] = useState<{ sessionId?: string; projectId?: string; scope?: 'global' | 'project' | 'session' } | null>(null);
  /**
   * 会话内搜索（Cmd+F）**已经搬到每一格自己身上** —— 「哪个分屏的搜索应该显示在那个分屏中」。
   * 状态、命中计数、高亮都在 `ChatArea` 里（见那里的 `findOpen` 那一段），App 不再持有全局搜索状态：
   * 一个属于整个窗口的搜索条在分屏时说不清它在搜哪一格，而 `findInPage` 也确实在搜全部。
   */
  /**
   * 三层记忆的体积（字节），横幅的唯一依据。
   *
   * 全局层只有一份，所以按 `''` 这个空 key 存；项目层按 projectId（同项目下每条会话付的是同一笔
   * 钱，压一次全都受益）；会话层按 sessionId。三个写入时机 —— 每轮注入后主进程推送、切会话时按需
   * 取一次、MemoryDialog 关闭后重取 —— 合起来保证「你自己清理完横幅就消失」，不用等下一轮对话。
   */
  const [memoryBytes, setMemoryBytes] = useState<{
    global: number;
    project: Record<string, number>;
    session: Record<string, number>;
  }>({ global: 0, project: {}, session: {} });
  /** 正在压缩的层（`scope:id`），避免连点发出两条一样的提示词。 */
  const [compactingMemory, setCompactingMemory] = useState<string | null>(null);
  /**
   * A FIX ROUND IN FLIGHT: which session to watch for the corrected structure.
   *
   * Only watched after asking, never continuously — a canvas opened from the browser must not silently
   * adopt whatever JSON happens to be further up that conversation. `seen` is the reply text already
   * consumed, so one answer is applied once.
   */
  const fixWatch = useRef<{ sessionId: string; seen: string } | null>(null);
  const [fixNote, setFixNote] = useState<string | null>(null);

  /**
   * THE RUN WINDOW ASKS FOR A CHAT — 「执行状态要在普通对话 UI 里看得见」.
   *
   * A run has no conversation of its own; each step runs in one. Clicking a step over there brings this
   * window forward on that chat, which is where what it actually said can be read.
   */
  useEffect(() => {
    const off = window.kiroApi.onFocusSessionRequest?.((payload: { sessionId: string }) => {
      if (!payload?.sessionId) return;
      void switchSession(payload.sessionId);
    });
    return () => { if (typeof off === 'function') off(); };
  }, [switchSession]);

  /**
   * 两件事一次算完：每个 project 有多少次运行（拖拽规则用），以及**哪个会话在为哪个 flow 的哪一步干活**。
   *
   * 后者是 tag 的新位置 —— project 不拥有 flow，worker 会话才真的属于某个 flow（「flow的tag就应该落在会话上」）。
   */
  /* 各 project 的工作目录：菜单要显示当前值，起会话要用它当 cwd（`cwdFor` 另有缓存） */
  useEffect(() => {
    void (async () => {
      const names = Array.from(new Set(sessions.map((s) => (s.projectId || '').trim()).filter(Boolean)));
      const out: Record<string, string> = {};
      for (const name of names) {
        const res = await window.kiroApi.projectGetWorkspace?.(name);
        const dir = String(res?.workspace || '').trim();
        if (dir) out[name] = dir;
      }
      setProjectWorkspaces(out);
    })();
  }, [sessions]);
  /**
   * 每条 flow 会话自己那块画布 —— 「两个 flow 会话当然是两个不同的画布」/「这俩不应该是分开的画布吗」。
   *
   * 状态本身仍然只有一份（`studioDraft`/`studioStandalone`），这张表补的是「各自记着自己那份」：切到哪条会话
   * 就同步把它那份放回状态里，切走时它留在表里不受影响。写入点 = 所有装载入口 + 画布上的手改 + 会话吐出新
   * 结构；读取点 = 「聚焦即装载」那条 effect。
   */

  /**
   * 焦点指着一个已经不存在的会话时,回到新会话那一页 —— 而不是渲染一个空壳。
   *
   * 「没有任何页面被选中的情况下到了一个不知道是啥会话」的另一半:画布那条会话在关闭时会自己被回收
   * (`closeSkillSession`),而焦点还指着它 —— 于是聊天区拿一个已经没有记录的 id 去渲染,标题、模型、历史
   * 全是空的,看着就像「一个不知道是啥的会话」。pending_ 不算不存在:那是刚建、记录还没落地的一瞬间。
   */
  useEffect(() => {
    const id = currentSessionId;
    if (!id || String(id).startsWith('pending_')) return;
    if (sessions.some((s) => s.id === id)) return;
    setLastActiveSessionId(null);
    unfocusSession();
  }, [currentSessionId, sessions, unfocusSession]);
  /**
   * AUTO-PARSE the rewrite into the studio.
   *
   * There used to be a 360px rail beside the transcript whose only job was a 「解析最新回复」 button.
   * The canvas is the review surface, so the parse happens on its own the moment the turn produces
   * something parseable, and the studio opens — one fewer panel, and no step whose only purpose is to
   * ask permission to look at what just arrived.
   */
  const parsedRegRef = useRef<string>('');
  /**
   * Via a ref, like `focusSessionRef` and `queueMessageRef` above it: `handleSendMessage` is declared
   * several hundred lines below, and naming it here evaluates a const in TDZ during render — which has
   * blanked this renderer once already.
   */
  const sendMessageRef = useRef<((text: string, pastes?: PastedBlock[], sid?: string) => Promise<void>) | null>(null);
  /** The verdict of the 「导入的东西是否包含了原版全部信息」 turn, keyed by the fingerprint it judged. */
  /**
   * THE AUDIT VERDICT SURVIVES A RELOAD, and that is not a nicety.
   *
   * Both the verdict and the 「已经问过了」 guard lived in memory only, so every reload re-sent the comparison:
   * observed in one registration session — the same 30,093-character prompt four times, four model turns spent
   * re-deriving an answer already given. Keyed by fingerprint, so editing the structure still re-asks.
   */
  /*
    画布上那套「对比原文」已整体撤掉 —— 「为什么画布上面还有对比原文的字样，都说了放到提示词」。
    它原来是第二条对照实现（`flowAudit`）：结构校验一通过就**自动再往那条注册会话发一条核对提示词**，
    把回复里的 verdict 解析出来显示成「对过原文 / 对原文丢了 N 处」。现在这件事由改写那一轮的提示词
    自己负责（`buildRewritePrompt` 里的 CHECKING AGAINST THE PROSE IS YOUR JOB 段），所以这里不再
    发那一轮、不再解析、也不在画布上显示。`flowAudit.ts` 模块与它的测试保留，画布不再使用。
  */
  /** 上一次把校验报错发给会话时,结构是哪一版 —— 同一版只说一次(`shouldSendFix`) */
  const fixSentRef = useRef<string>('');
  /**
   * Why nothing appeared. A reply whose JSON is cut off (the real from-scratch reply came back at 38k
   * characters with a string left unterminated) used to be swallowed by a bare `catch` — the studio simply
   * never opened and there was nothing to read. Silence is the one unacceptable outcome.
   */
  const [regNote, setRegNote] = useState<string | null>(null);
  /** Phase 2 of from-scratch: extract the structure from the prose just written. Sent once per prose. */
  const extractSentRef = useRef<string>('');

  /** 这次运行里刚发出、可能还没落盘的那一条 —— 只防并发重发（判据在历史里，见 `shouldBrief`） */
  const briefingRef = useRef(new Map<string, string>());
  /**
   * 交底 —— 一个「改 flow」的会话在收到任何别的东西之前，先知道自己在改哪个 flow、当前结构长什么样、
   * 以及不要干别的。
   *
   * 三个入口共用一个:注册对话框现起的那个、从 Flow 面板打开已注册的、以及重启后恢复画布时复用/新起的。
   * 「这个应该和 flow 是不是创建了没关系」—— 所以这里不看注册状态,只看「这条对话是不是在服务某个 flow」。
   *
   * **只发一次,靠历史带回来** —— 「你直接嵌入到它的会话历史在第一个消息的时候发送不行吗」。这条消息就是这个
   * 会话的第一条,所以判据是它自己的 transcript(`shouldBrief`),不是内存记账:重启之后历史里已经有了,就不再发。
   * 为了让那份历史真的回到上下文里,这类会话显式走 `primeMode: 'full'` —— 默认的 snapshot 恢复只逐字带回
   * 最近 18000 字(`main/index.ts` 的 `SNAPSHOT_RECENT_CHARS`),第一条消息在长对话里会掉出去,那样「只发一次」
   * 就变成了「静默失效」。flow 编辑会话本来短,全量重放的代价可以接受。
   *
   * 走 `sendMessageRef`(即 `handleSendMessage`)而不是裸 IPC:新起的会话此刻可能还没 attach,那条路会排队并在
   * 接上时排空 —— 注册那一处的注释里已经因为这个踩过一次。
   *
   * **`mode: 'text'` 是给注册路径的**,它必须把交底和改写提示词**合成一条**发出去 —— 「我新注册的一个 flow
   * 附加了一个 pdf,但 flow 会话里却找不到这个 pdf」。分两条发的实测后果(会话 `s_1786944564517_j0xa91`):
   *   05:29:31.804 `prompt received busy=undefined`  ← 交底
   *   05:29:31.813 `prompt received busy=true`       ← 改写提示词,9ms 后到,会话已占用
   *   05:29:35.194 `prompt done`（**只有一次**）
   * 第二条被当成 steer 吞掉,模型只看到交底,回的是「等你把原文发给我后再提取」—— 而附件路径就写在那条改写
   * 提示词里。所以注册路径拿文本自己拼,一条消息只产生一次 prompt。
   */

  /**
   * 启动清扫收掉的无主 worker 会话 —— 从侧栏摘掉。
   *
   * 不接这个事件的话，磁盘上已经进回收站的会话还会留在列表里，点进去是空的，要到下次启动才消失。
   * 复用 `forgetSessions`（删 flow run 的级联也是用它）。
   */
  useEffect(() => {
    const off = window.kiroApi.onSessionsPurged?.(({ sessionIds }) => {
      if (Array.isArray(sessionIds) && sessionIds.length) forgetSessions(sessionIds);
    });
    return () => { off?.(); };
  }, [forgetSessions]);

  /** 主进程每轮注入后播报的体积。压缩那一轮结束，下一轮就带回新数字，横幅随之消失。 */
  useEffect(() => {
    const off = window.kiroApi.onMemoryBytes?.((b) => {
      setMemoryBytes((prev) => ({
        global: b.global,
        project: b.projectId && prev.project[b.projectId] !== b.project
          ? { ...prev.project, [b.projectId]: b.project }
          : prev.project,
        session: b.sessionId && prev.session[b.sessionId] !== b.session
          ? { ...prev.session, [b.sessionId]: b.session }
          : prev.session,
      }));
    });
    return () => { off?.(); };
  }, []);

  /**
   * 打开就能看到 —— 只靠上面那条推送的话，横幅要等你先发一轮对话才出现，而那一轮已经付过钱了。
   *
   * 依赖的是**当前会话所属的 project**：切到别的项目就取那个项目的数。MemoryDialog 关闭时也重取
   * 一次，这样你在里面手动删完内容，回来横幅立刻就没了，不用等下一轮。
   */
  const currentProjectId = sessions.find((s) => s.id === currentSessionId)?.projectId;
  useEffect(() => {
    let alive = true;
    void window.kiroApi.memoryBytes?.(currentProjectId || undefined, currentSessionId || undefined)
      .then((b) => {
        if (!alive || !b) return;
        setMemoryBytes((prev) => ({
          global: b.global,
          project: currentProjectId ? { ...prev.project, [currentProjectId]: b.project } : prev.project,
          session: currentSessionId ? { ...prev.session, [currentSessionId]: b.session } : prev.session,
        }));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [currentProjectId, currentSessionId, showMemory]);

  /**
   * 点【压缩】：先备份，再把那句固定提示词当成**可见的用户消息**发出去。
   *
   * 可见而不是隐藏注入 —— 压缩是破坏性操作，你得能看到它在做什么、能中途打断、transcript 里有痕迹。
   * 走 `sendMessageRef` 而不是裸 IPC，理由和上面那几处一样：会话此刻可能还没 attach，那条路会排队。
   */
  const compactMemory = useCallback(async (
    scope: MemoryScope, sid: string, projectId?: string,
  ) => {
    const key = `${scope}:${scope === 'project' ? projectId : scope === 'session' ? sid : ''}`;
    if (!sid || compactingMemory) return;
    setCompactingMemory(key);
    try {
      // 备份失败就不发提示词：宁可什么都不做，也不要在没有退路的情况下让模型重写这个文件。
      const backup = await window.kiroApi.backupMemory?.(scope, projectId, sid);
      if (!backup?.ok) { console.warn(`[kirolex] ${scope} 记忆备份失败，压缩已取消`); return; }
      const mem = await window.kiroApi.readMemory?.(projectId, sid);
      const filePath = scope === 'global' ? mem?.globalPath
        : scope === 'project' ? mem?.projectPath
        : mem?.sessionPath;
      if (!filePath) return;
      // 字节数从 `memoryBytes` 取，不用字符串 `.length` —— 那是**字符**数，中文会低估三倍，而提示词
      // 里报的体积和横幅上显示的必须是同一个数。
      const b = await window.kiroApi.memoryBytes?.(projectId, sid);
      await sendMessageRef.current?.(
        compactMemoryPrompt({ scope, filePath, bytes: b ? b[scope] : 0 }),
        undefined,
        sid,
      );
    } finally {
      setCompactingMemory(null);
    }
  }, [compactingMemory]);
  const [showSkill, setShowSkill] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logsText, setLogsText] = useState('');
  // Log viewer opens at the newest tail; older lines load on scroll-up.
  const [logsLimit, setLogsLimit] = useState(500);
  const [logsLoadingOlder, setLogsLoadingOlder] = useState(false);
  const logsPreRef = useRef<HTMLPreElement>(null);
  const logsHasMoreRef = useRef(true);
  const LOGS_CHUNK = 500;
  // In-app file viewer (internal "browser"): file links/paths open here, not the OS.
  // File viewer TABS. Was a single object, so every click replaced the open file —
  // losing scroll position, the rendered/raw choice, and any way back without
  // re-finding the link in chat. Each tab now owns its own content and view state.
  const [fileTabs, setFileTabs] = useState<FileTab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const fileScrollRef = useRef<Record<string, number>>({});   // tabId -> scrollTop
  /** 正在把某个标签滚回原处（见 `restoreScroll`）—— 那期间程序自己滚出来的位置不算数，别记进 `fileScrollRef`。 */
  const scrollRestoreStopRef = useRef<(() => void) | null>(null);
  /** 开回上次的标签之后推一下：当前标签可能没变（id 一样），但它的位置刚从存档里填进来，得再滚一次。 */
  const [scrollRestoreTick, setScrollRestoreTick] = useState(0);
  /** 滚动停下几百毫秒才写盘（见 `persistOpenTabs`）—— 每滚一下都写 ui-state 是白花的磁盘。 */
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Mirrors of the tab state, so the disk-change listener does not have to be torn
   *  down and re-registered on every tab edit (which would drop events mid-save). */
  const fileTabsRef = useRef<FileTab[]>([]);
  fileTabsRef.current = fileTabs;
  const activeFileTabIdRef = useRef<string | null>(null);
  activeFileTabIdRef.current = activeFileTabId;
  const fileBodyRef = useRef<HTMLDivElement | null>(null);
  /**
   * 滚动容器**此刻挂着的那个节点** —— 进 state 是为了让"滚回原处"在它重新挂上时再跑一次。
   * 预览栏藏着时它根本不在（见 `fileViewerHidden`）：藏着重启、开回标签那一下没地方滚，展开时标签 / 内容都没变，
   * 只靠 ref 的话就再也不会滚回去了。
   */
  const [fileBodyNode, setFileBodyNode] = useState<HTMLDivElement | null>(null);
  const setFileBody = useCallback((node: HTMLDivElement | null) => {
    fileBodyRef.current = node;
    setFileBodyNode(node);
  }, []);
  const fileViewer = fileTabs.find((t) => t.id === activeFileTabId) || null;
  const [fileViewerLoading, setFileViewerLoading] = useState(false);
  /**
   * 文本文件在不在 comment 模式 —— 默认**关**。关着的时候一个按钮都不渲染，纯粹读文档；开着才出现每行
   * 右边那个 💬 / ✕ 和最下面那块。默认关是因为大多数时候你只是想看一眼。
   */
  /*
    **按文件记，不是全局一个开关** ——「comment 模式会改变所有现在打开的文件，这个按钮应该只影响当前文件」。
    原来是一个布尔：在 A 打开 comment，切到 B、C 也全是 comment 模式。现在是"哪些路径开着"，按钮只拨当前这份；
    跟着「重启后恢复界面状态」一起记（见 `uiRestore`）。
  */
  const [commentingPaths, setCommentingPaths] = useState<string[]>(() => {
    const saved = restoreGetJson<unknown>('kirolex-commenting-paths');
    return Array.isArray(saved) ? saved.map(String) : [];
  });
  useEffect(() => {
    restoreSet('kirolex-commenting-paths', commentingPaths.length ? JSON.stringify(commentingPaths) : null);
  }, [commentingPaths]);
  const commenting = !!fileViewer && commentingPaths.includes(fileViewer.path);
  const toggleCommenting = () => {
    const at = fileViewer?.path;
    if (!at) return;
    setCommentingPaths((cur) => (cur.includes(at) ? cur.filter((p) => p !== at) : [...cur, at]));
  };
  // Markdown files render formatted by default; the toggle shows the raw source.
  const fileViewerRaw = !!fileViewer?.raw;
  /**
   * 焦点在不在右侧预览栏里（点过它，或者焦点落在它里面的元素上）—— 在的话 Ctrl/Cmd+F 归预览栏自己的搜索条，
   * 聊天格让出（`findSuspended`）。点回聊天区、侧栏等任何别处就还给聊天格。判据见 `previewFind.ts`。
   */
  const [focusInPreview, setFocusInPreview] = useState(false);
  useEffect(() => {
    const onFocusTarget = (event: Event) => setFocusInPreview(isInPreview(event.target));
    window.addEventListener('pointerdown', onFocusTarget, true);
    window.addEventListener('focusin', onFocusTarget, true);
    return () => {
      window.removeEventListener('pointerdown', onFocusTarget, true);
      window.removeEventListener('focusin', onFocusTarget, true);
    };
  }, []);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  // App 自己在 <LangProvider> 外面（它就是那个 Provider 的父组件），useT() 在这里只会拿到默认的中文 ——
  // 所以 App 里的文案直接按 settings.language 取。身份随语言变，进了 useMemo/useCallback 依赖也会跟着重算。
  const t = useMemo(
    () => (key: string, vars?: Record<string, string | number>) => translate(settings.language, key, vars),
    [settings.language],
  );
  /** 给不该因换语言而重跑的 effect 用（例如排队消息的发送）：读到的永远是当前语言的 t。 */
  const tRef = useRef(t);
  tRef.current = t;

  /**
   * ONE summary per chat, computed HERE and handed to both surfaces.
   *
   * The banner above a transcript and the next-run time on a sidebar row are the same fact seen
   * from two places, so they must not each format it: two formatters is how a row and a banner
   * end up naming different times for one job. `sessionScheduleSummary` also decides what counts
   * as live (finished and cancelled jobs are not pending), so neither component filters jobs.
   *
   * Memoised on the job list plus the coarse clock (and the UI language) -- the countdown text
   * only changes when one of those does. Declared after `settings` because it reads the language.
   */
  const scheduleSummaryFor = useMemo(() => {
    const byId = schedulesBySession(schedules);
    const cache = new Map<string, ScheduleSummary | null>();
    return (sid: string | null): ScheduleSummary | null => {
      if (!sid) return null;
      if (!cache.has(sid)) cache.set(sid, sessionScheduleSummary(byId.get(sid) || [], scheduleNow, settings.language));
      return cache.get(sid) ?? null;
    };
  }, [schedules, scheduleNow, settings.language]);

  /** 每条会话还在跑的后台命令 / 监视（按会话缓存：没变就是同一个数组，ChatArea 的 memo 不白算）。 */
  const bgJobsFor = useMemo(() => {
    const cache = new Map<string, BgJobRow[]>();
    return (sid: string | null): BgJobRow[] => {
      const key = sid || '';
      if (!cache.has(key)) cache.set(key, runningBgJobs(bgJobs, sid));
      return cache.get(key)!;
    };
  }, [bgJobs]);

  // --- Split view (1x1 … 3x3) -----------------------------------------------
  // The user CHECKS sessions in the sidebar; every checked session gets its own
  // fully interactive pane (own composer, queue, attachments, model). The
  // focused session is always shown, so unchecking everything returns to the
  // exact single-chat layout. Each pane stays live because useAcp mirrors those
  // sessions' streams into pane state.
  // focusSession is defined much further down; a dep on it here would be
  // evaluated during render and hit TDZ. Route through a ref instead.
  const focusSessionRef = useRef<(sid: string | null) => Promise<void>>(async () => {});
  /** Forward reference to handleQueueMessage, which is declared further down. Used
   *  so handleSendMessage can divert into the queue while a history rebuild owns
   *  the backend, without putting a later-declared const in a dependency array. */
  const queueMessageRef = useRef<((text: string, pastes?: PastedBlock[], paneSid?: string) => void) | null>(null);
  /** Same forward-reference pattern as queueMessageRef: handleSteerMessage is
   *  declared further down, and naming it in a dependency array up here would be
   *  evaluated during render and hit TDZ. */
  const handleSteerMessageRef = useRef<((text: string, pastes?: PastedBlock[], paneSid?: string) => Promise<void> | void) | null>(null);
  // The layout (which chat sits in which slot) IS remembered across restarts, so
  // reopening the app puts you back where you were. What must NOT happen is
  // re-filling slots when you merely switch the grid size on -- that is why the
  // grid-change effect below seeds only the current chat and leaves the rest
  // empty, while a restart restores the saved list verbatim.
  const [splitSessionIds, setSplitSessionIds] = useState<string[]>(() => {
    try {
      // Shared store, not origin-scoped localStorage: which chats sit in which pane
      // is layout state and was being lost on every dev/prod origin switch. The key
      // already existed in ui-state.json as a migration leftover that nothing read.
      const saved = JSON.parse(uiGet(SPLIT_SESSION_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [];
    } catch { return []; }
  });
  /** 每个 project 挂着哪些 flow（从它的 run 推出来的）—— project 菜单里那一节 */
  const [projectFlowsMap, setProjectFlowsMap] = useState<Record<string, Array<{ flow: string; status: string; runId?: string }>>>({});
  /** 每个 project 已经移出的 flow —— 「不再使用」写在这里，它决定主会话能不能删 */
  const [detachedFlowsMap, setDetachedFlowsMap] = useState<Record<string, string[]>>({});
  /** 会话 → 它在为哪个 flow 的哪一步干活。左栏那面 flow tag 就是它 */
  /*
    聚焦一个 flow 的**主会话**就把这个 flow 的运行页摆出来 —— 「这个 run 的功能和修改或创建 flow 是不一样的，
    我需要有一些 run 的按钮」。主会话的职责是「这个 flow 在这个 project 的运行现场」，所以它下面该是运行页
    那套动作（开始运行 / 加 flow / 按新定义重开一次 / 打回 / 删这个 flow 的运行），而不是定义画布那套
    （指纹 / 校验通过 / 保存）。上面那条装载 effect 已经不再给它装画布，这条负责把该显示的东西摆上。

    **每次聚焦只摆一次，之后不再管这一页看的是哪个 run** —— 「切换不同的 flow 有问题哦，切换不过去」。
    第一版把 `runView` 放进依赖、又要求「这一页必须在看这个 flow 的运行」，于是它变成一条持续纠正的规则：
    你在带状上点另一个 flow（`onSwitchRun` → `setRunView`），焦点还在这条主会话上，它立刻判定「看错了」
    并拽回来 —— 表现就是切不过去。运行页看哪个 run 是**人的选择**，这条 effect 只负责「刚点进主会话时
    别让它空着」。

    不新建任何东西：这个 flow 在这个 project 一次运行都没有时什么都不做，那条会话走 `flowChatAlone`，
    把对话本身显示出来。
  */
  const mainRunOpenedRef = useRef<string>('');

  /**
   * 这条会话有没有**它自己那块**画布。判据是归属（`draftOwner`），不是「状态里有没有结构」——
   * 状态里那份可能是别的会话的。
   */
  const { rows: splitRows, cols: splitCols, capacity: splitCapacity } = SPLIT_GRIDS[settings.splitGrid] || SPLIT_GRIDS['1x2'];
  // The highlighted set IS the grid, in selection order. Empty set = classic
  // single-chat layout. Deriving panes from the focused chat instead was wrong:
  // focusing a highlighted chat then collapsed the grid back to one pane.
  const panes = useMemo(() => {
    const known = new Set(sessions.map((s) => s.id));
    const list = splitSessionIds.filter((id) => known.has(id)).slice(0, Math.max(1, splitCapacity));
    if (list.length) return list;
    return currentSessionId ? [currentSessionId] : [];
  }, [splitSessionIds, sessions, splitCapacity, currentSessionId]);
  /** The chat that was on screen when the split was emptied.
   *
   *  Closing the last pane drops the FOCUS (see toggleSplitSession: keeping it would
   *  refill the grid and render that chat full screen again), but the sidebar should
   *  still show where you were -- so the highlight is driven by this instead. It is
   *  only ever set by that one action and cleared the moment any chat is focused. */
  const [lastActiveSessionId, setLastActiveSessionId] = useState<string | null>(null);
  /** What the sidebar highlights: the focused chat, or the one we just left. Passed
   *  in place of `currentSessionId` so no new prop has to be threaded through the
   *  three sidebar components -- the row is genuinely "where you are", it just is not
   *  rendered in a pane right now. */
  const highlightSessionId = currentSessionId || lastActiveSessionId;
  useEffect(() => {
    if (currentSessionId && lastActiveSessionId) setLastActiveSessionId(null);
  }, [currentSessionId, lastActiveSessionId]);

  /** Split layout is driven by the setting, so a single chosen chat still renders
   *  as a grid (with the "add" strip) rather than silently collapsing to one chat.
   *
   *  With NOTHING assigned there is no grid to draw: closing the last pane lands on
   *  the ordinary opening screen (see the `panes[0] || currentSessionId` fallback in
   *  the render, which resolves to null once the focus is dropped too). The grid
   *  SETTING survives, so putting any chat back re-splits immediately -- that is the
   *  part that used to be destroyed, by rewriting splitGrid to '1x1'. */
  const splitActive = splitCapacity > 1 && splitSessionIds.length > 0;
  // Assigned chats share the space; unused capacity is just the slim strip.
  const paneCols = Math.max(1, Math.min(splitCols, panes.length));
  const paneRows = Math.max(1, Math.ceil(panes.length / paneCols));
  // Where the free slots actually are decides the strip's orientation: a partly
  // filled row means "to the right", a full row with rows to spare means "below".
  const hasRoom = panes.length < splitCapacity;
  const rowComplete = panes.length % splitCols === 0;
  const stripBelow = hasRoom && rowComplete && paneRows < splitRows;
  const stripRight = hasRoom && !stripBelow;
  /** Panes grouped into rows. The layout is nested flex (rows of panes), not one
   *  CSS grid: a grid forces every row to share the same column tracks, so the
   *  "add" strip had to become a full-height column down the whole right edge
   *  even when the only free cell was the bottom-right one. Rows own their own
   *  splits, which also makes each divider independently draggable. */
  const paneRowsOfPanes = useMemo(() => {
    const out: (string | null)[][] = [];
    for (let i = 0; i < panes.length; i += paneCols) out.push(panes.slice(i, i + paneCols));
    return out.length ? out : [[null]];
  }, [panes, paneCols]);
  /** Dragged sizes are stored per layout shape (one bucket each, see splitLayout.ts):
   *  a drag in one layout must not replace what you dragged in another. */
  const splitShape = `${paneRowsOfPanes.length}x${paneCols}:${panes.length}:${stripBelow ? 'b' : stripRight ? 'r' : '-'}`;
  const [splitSizes, setSplitSizes] = useState<SplitSizeStore | null>(() => {
    try {
      // Shared store, NOT localStorage. localStorage is origin-scoped and this app
      // has two renderer origins (file:// for a normal start, http://localhost:5173
      // in dev), so dragged pane proportions silently reset every time you switched
      // between `npm start` and `npm run dev:hot` -- the same class of loss that
      // already cost project groups, pins and archive flags.
      const saved = uiGet(SPLIT_SIZES_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  // Live feature switches (main owns them; a Settings toggle re-renders here).
  const featureFlags = useFeatureFlags();
  const dragSplits = featureFlags.splitDragResize !== false;
  // This shape's own bucket, else carried from the latest drag: adding a pane must
  // not move the dividers that still describe the same structure. See activeSplitSizes.
  const activeSizes = useMemo(
    () => activeSplitSizes(splitSizes, splitShape, paneRowsOfPanes),
    [splitSizes, splitShape, paneRowsOfPanes],
  );
  const rowFlex = (r: number) => activeSizes?.rows?.[r] ?? 1;
  /** Flex per pane, per row. Panes divide their row between them: free capacity to the
   *  RIGHT of a row is a slim strip, while a fully free ROW reserves a real row's
   *  height. Both rules and their consequences live in splitLayout.ts, which is pure
   *  and covered by tests. */
  const paneFlexByRow = useMemo(() => computePaneFlex(paneRowsOfPanes, activeSizes), [paneRowsOfPanes, activeSizes]);
  const colFlex = (r: number, c: number) => paneFlexByRow[r]?.[c] ?? 1;
  /** Drag a divider: the two neighbours trade space, everything else holds still.
   *  Sizes are read from the DOM rather than from state so a fresh (all-equal)
   *  layout and an already-dragged one behave identically. */
  const handlePaneResizeStart = useCallback((
    e: React.MouseEvent,
    axis: 'col' | 'row',
    rowIndex: number,
    dividerIndex: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const prev = handle.previousElementSibling as HTMLElement | null;
    const next = handle.nextElementSibling as HTMLElement | null;
    if (!prev || !next) return;
    const horizontal = axis === 'col';
    const startPos = horizontal ? e.clientX : e.clientY;
    const prevBox = prev.getBoundingClientRect();
    const nextBox = next.getBoundingClientRect();
    const prevSize = horizontal ? prevBox.width : prevBox.height;
    const nextSize = horizontal ? nextBox.width : nextBox.height;
    const total = prevSize + nextSize;
    // A pane narrower than this cannot show its composer controls.
    const MIN = horizontal ? 320 : 180;
    if (total < MIN * 2) return;
    let dragging = true;
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) return;
      const delta = (horizontal ? ev.clientX : ev.clientY) - startPos;
      const newPrev = Math.max(MIN, Math.min(total - MIN, prevSize + delta));
      setSplitSizes((cur) => {
        // Build on the CARRIED sizes, not on an exact shape match: otherwise the
        // first drag after adding a pane would discard the proportions that were
        // just carried over and snap everything back to equal.
        const carried = activeSplitSizes(cur, splitShape, paneRowsOfPanes);
        const base = carried
          ? { shape: splitShape, rows: [...carried.rows], cols: carried.cols.map((row) => [...row]) }
          : {
            shape: splitShape,
            rows: paneRowsOfPanes.map(() => 1),
            cols: paneRowsOfPanes.map((row) => row.map(() => 1)),
          };
        while (base.rows.length < paneRowsOfPanes.length) base.rows.push(1);
        paneRowsOfPanes.forEach((row, r) => {
          if (!base.cols[r]) base.cols[r] = row.map(() => 1);
          while (base.cols[r].length < row.length) base.cols[r].push(1);
        });
        // Preserve the pair's combined share so untouched neighbours never move.
        const target = horizontal ? base.cols[rowIndex] : base.rows;
        const pairSum = (target[dividerIndex] ?? 1) + (target[dividerIndex + 1] ?? 1);
        const share = pairSum * (newPrev / total);
        target[dividerIndex] = share;
        target[dividerIndex + 1] = pairSum - share;
        return putSplitSizes(cur, base);
      });
    };
    const onMouseUp = () => {
      dragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [splitShape, paneRowsOfPanes]);
  useEffect(() => {
    try {
      // An empty store must also clear storage, otherwise a reload restores
      // proportions that are no longer there.
      if (splitSizes && Object.keys(splitSizes).length) uiSet(SPLIT_SIZES_KEY, JSON.stringify(splitSizes));
      else uiRemove(SPLIT_SIZES_KEY);
    } catch {}
  }, [splitSizes]);


  /**
   * 哪些会话**不该占分屏格子** —— 判据只有一处，因为下面那条清理 effect 是按它摘人的。
   *
   * 入口有四个（手动切换、网格播种、领养、启动重建），每加一条路径就得记着再拦一遍；而「格子里不该有它」
   * 是个随时能检查的状态。所以这里不问它是怎么进来的：包括从 ui-state 恢复出来的存量，一律剔除。
   */
  const notForSplit = useCallback((id: string) => {
    if (!id) return true;
    const session = sessions.find((s) => s.id === id);
    /*
      归档的会话不进分屏 —— 「本来它应该在 archive 的时候被关掉，不知道为什么它又回到分屏了」。
      归档只是把 `archived: true` 写进记录，会话仍然留在 `sessions` 里，而 `panes` 只过滤「这条会话
      还存在吗」（known），所以归档过的那一格照旧渲染。加在这里而不是改 `panes`：下面那个清理 effect
      已经在按 `notForSplit` 摘人了，归档属于同一类「不该占格子」的会话，判据放在一处才不会再漏。
    */
    if (session?.archived) return true;
    /*
      **列表里没有这条会话 → 它不该占格子** —— 「为什么现在分屏选不了第二个会话了」。

      实测那次：`splitSessionIds` 里有一条 `s_…s1xgc0`，磁盘上有 record、`projectId` 是「周报」，
      但 transcript 是 **0 字节**（在 project 里点了 New Chat 没发过消息），所以它不进侧栏列表。
      于是那一格渲染不出任何东西、却照样占着容量：看起来只有一格，再点别的会话就把可见那一格顶掉。

      判据放在这里而不是 `panes`：`panes` 只管"渲染谁"，而容量是 `splitSessionIds` 算的 ——
      只改渲染的话那一格永远是空的。下面那条清理 effect 会按这个判据把存量剔掉。

      判据前面那个 `sessions.length` 是必须的：hydrate 完成之前 `sessions` 是空的，那时候"不在列表里"
      对**每一条**都成立，会把从 ui-state 恢复出来的分屏整个清空。
    */
    if (sessions.length > 0 && !session) return true;
    return false;
  }, [sessions]);

  /** 不该占格子的一律剔掉 —— 包括从 ui-state 恢复出来的存量（判据见 `notForSplit`）。 */
  useEffect(() => {
    if (!splitSessionIds.length) return;
    const keep = splitSessionIds.filter((id) => !notForSplit(id));
    if (keep.length !== splitSessionIds.length) setSplitSessionIds(keep);
  }, [splitSessionIds, notForSplit]);

  const toggleSplitSession = useCallback((id: string) => {
    if (notForSplit(id)) return;
    // Everything here runs in an event handler and reads state directly. Do NOT
    // move the setSettings call into a setSplitSessionIds updater: React can
    // replay updaters, and scheduling another update from inside one froze the
    // renderer and lost the selection.
    if (splitSessionIds.includes(id)) {
      const next = splitSessionIds.filter((x) => x !== id);
      if (next.length === 0) {
        // Closing the LAST pane empties the grid; it does not turn split off.
        // It used to set splitGrid '1x1', i.e. one action ("remove this pane")
        // silently changed the layout setting as well -- and getting back meant
        // re-picking the grid AND re-picking chats.
        //
        // The focus has to go with it: a chat that stays focused while no longer
        // assigned is immediately adopted back into a slot by the layout effects
        // below, AND the single-pane fallback would render it full screen -- which is
        // the collapse this was reported as. Remembering it separately keeps its
        // sidebar row highlighted (see `highlightSessionId`) without either effect.
        setSplitSessionIds([]);
        setLastActiveSessionId(currentSessionId);
        unfocusSession();
        return;
      }
      setSplitSessionIds(next);
      // Removing the chat you were in: move focus to the first survivor.
      if (id === currentSessionId) void focusSessionRef.current(next[0]);
      return;
    }
    // First selection seeds the grid with the chat you are already in, so one
    // ⌘-click gives a side-by-side instead of a single unrelated pane.
    const seeded = splitSessionIds.length === 0 && currentSessionId && currentSessionId !== id
      ? [currentSessionId, id]
      : [...splitSessionIds, id];
    let cap = Math.max(1, splitCapacity);
    // A 1x1 grid means "no split". Explicitly picking a second chat is a clear
    // intent to split, so raise the grid rather than ignore the click.
    if (cap < 2 && seeded.length > 1) {
      setSettings((cur) => (SPLIT_GRIDS[cur.splitGrid].capacity < 2 ? { ...cur, splitGrid: '1x2' } : cur));
      cap = 2;
    }
    setSplitSessionIds(seeded.length > cap ? seeded.slice(seeded.length - cap) : seeded);
  }, [splitSessionIds, currentSessionId, splitCapacity, unfocusSession]);

  // The grid setting IS the on/off switch.
  //   * 1x1            -> leave split mode (assignments dropped)
  //   * turned ON empty -> seed with ONLY the chat you are in; other slots stay
  //                        empty (never pre-filled with recent chats)
  //   * made SMALLER   -> discard the assignments that no longer fit
  //   * made BIGGER    -> keep everything, new slots are empty
  const appliedGridRef = useRef<SplitGrid | null>(null);
  useEffect(() => {
    const cap = SPLIT_GRIDS[settings.splitGrid]?.capacity ?? 1;
    const gridChanged = appliedGridRef.current !== null && appliedGridRef.current !== settings.splitGrid;
    appliedGridRef.current = settings.splitGrid;
    if (cap <= 1) {
      if (splitSessionIds.length) setSplitSessionIds([]);
      return;
    }
    if (splitSessionIds.length > cap) {
      // Shrunk: keep the first `cap` slots, drop the rest.
      setSplitSessionIds(splitSessionIds.slice(0, cap));
      return;
    }
    // flow 的会话不播种（见 `notForSplit`）—— 否则一进画布，分屏第一格就被它占了
    if (splitSessionIds.length === 0 && currentSessionId && !currentSessionId.startsWith('pending_')
      ) {
      setSplitSessionIds([currentSessionId]);
    }
    void gridChanged;
  }, [settings.splitGrid, currentSessionId, splitSessionIds]);

  /**
   * 点开一个不在格子里的对话:它进**你刚在看的那一格**,别的格不动 —— 「第二个分屏经常被顶掉，看看是谁干的」。
   *
   * 就是这个效果干的。它原来是「追加到末尾,再 slice 掉最旧的一格」:格子满了的时候,你每点一个侧栏里的
   * 对话,都会顶掉一格 —— 而顶掉哪一格取决于它们的**加入顺序**,和你正在看哪一格无关。于是「我特意摆在
   * 第二格的那个」时不时就没了,而你什么都没动过它。
   *
   * 现在替换的是你最后停留过的那一格(`lastPaneRef`):意思变成「在我这一格里打开它」—— 另一格是你摆在那儿
   * 对着看的东西,不该因为你点了别的而消失。格子没满时照旧是补一格,不动任何人。
   */
  const lastPaneRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentSessionId && splitSessionIds.includes(currentSessionId)) lastPaneRef.current = currentSessionId;
  }, [currentSessionId, splitSessionIds]);
  useEffect(() => {
    if (!currentSessionId || splitSessionIds.length === 0) return;
    if (splitSessionIds.includes(currentSessionId)) return;
    /**
     * 晚一拍再领养,而且再判一次 —— 「我创建注册会话的时候还是会扰乱分屏」。
     *
     * `newSession` 在**返回 id 之前**就把焦点切过去了,所以「这是一条 flow 会话」这件事(登记进
     * `flowSessionIds`、markSkillSession、setRegistration)全都发生在焦点变化**之后**的那几行。
     * 立即领养就正好挤在那个窗口期里:格子被新会话抢走,随后身份才姗姗来迟 —— 而领养是不可逆的,
     * 你摆好的布局已经变了。
     *
     * 60ms 之后再看:那时身份已经落地,`notForSplit` 会拦住它。对真正需要领养的普通对话,这点延迟看不出来
     * (它本来就是「你点了一个不在格子里的对话」之后的一次布局调整)。
     */
    const timer = setTimeout(() => {
      if (splitSessionIds.includes(currentSessionId)) return;
      setSplitSessionIds((prev) => {
      if (prev.includes(currentSessionId)) return prev;
      const cap = Math.max(1, splitCapacity);
      if (prev.length < cap) return [...prev, currentSessionId];
      // 满了：换掉「我刚在看的那一格」，位置不变；不知道是哪一格时才退回换最后一格
      const at = lastPaneRef.current ? prev.indexOf(lastPaneRef.current) : -1;
      const slot = at >= 0 ? at : prev.length - 1;
      const next = [...prev];
      next[slot] = currentSessionId;
      return next;
      });
    }, 60);
    return () => clearTimeout(timer);
  }, [currentSessionId, splitSessionIds, splitCapacity]);

  // Every pane except the focused one needs its stream mirrored into state.
  useEffect(() => {
    void setPaneSessions(panes.filter((id) => id !== currentSessionId));
  }, [panes, currentSessionId, setPaneSessions]);

  useEffect(() => {
    /* 分屏布局照常持久化 —— 全页视图不再改它，所以这里不需要再为它设防（见 `fullPageVisible` 那段注释） */
    try {
      if (splitSessionIds.length) uiSet(SPLIT_SESSION_KEY, JSON.stringify(splitSessionIds));
      else uiRemove(SPLIT_SESSION_KEY);
    } catch {}
  }, [splitSessionIds]);

  /** 启动时的布局恢复只做一次 —— 之后「领养当前会话」那条规则才不会把刚恢复的布局改写掉。 */
  const layoutRestoredRef = useRef(false);

  // Startup reconciliation, once the session list exists: drop chats that no
  // longer exist, and focus a restored pane instead of letting the "adopt the
  // focused chat" rule below rewrite the layout we just restored.
  useEffect(() => {
    if (layoutRestoredRef.current || sessions.length === 0) return;
    layoutRestoredRef.current = true;
    if (splitSessionIds.length === 0) return;
    const known = new Set(sessions.map((x) => x.id));
    // 存量里可能就有一条 flow 会话（上一版把它写进了 ui-state）：恢复的时候一起剔掉
    const alive = splitSessionIds.filter((id) => known.has(id));
    if (alive.length !== splitSessionIds.length) setSplitSessionIds(alive);
    if (alive.length && currentSessionId && !alive.includes(currentSessionId)) {
      void focusSessionRef.current(alive[0]);
    }
  }, [sessions, splitSessionIds, currentSessionId]);
  const [homeDir, setHomeDir] = useState('~');

  /**
   * 这个 project 的会话该在哪儿起 —— 「加到 project 里面不就好了」。
   *
   * 所有会话原来一律 `newSession(homeDir, …)`:不只是 flow 的 worker,你在 project「kirolex」里开的普通对话
   * cwd 也是家目录,于是每次都得跟它说一遍源码在哪。目录是 project 的属性,所以这里按 project 取一次。
   * 取不到就回家目录 —— 没配过的 project 行为完全不变。
   */
  const projectCwdCache = useRef<Map<string, string>>(new Map());
  /** 各 project 的工作目录（显示用；权威值在磁盘上的 project.json） */
  const [projectWorkspaces, setProjectWorkspaces] = useState<Record<string, string>>({});
  const cwdFor = useCallback(async (project?: string | null): Promise<string> => {
    const name = (project || '').trim();
    if (!name) return homeDir || '~';
    const cached = projectCwdCache.current.get(name);
    if (cached) return cached;
    const res = await window.kiroApi.projectGetWorkspace?.(name);
    const dir = String(res?.workspace || '').trim() || homeDir || '~';
    projectCwdCache.current.set(name, dir);
    return dir;
  }, [homeDir]);


  /**
   * ADVANCE A RUN BY ONE WAVE — the loop, and it is deliberately one wave per press.
   *
   * `planNext` says what may start; each step goes into a chat of its OWN (created in this project, under the
   * skill's agent — its tools live in that agent's MCP servers). Statuses are written through main, so the graph
   * and any other window follow by broadcast. Gates are NOT passed here: they are the point at which a person
   * looks, so the loop stops and the left column says 「等你过门」.
   *
   * Every tool call still goes through the gate in main: outside a step's declared tools, or a write from a step
   * that declared none, is refused before it reaches you.
   */
  /**
   * 一次运行结束就把它起的执行会话归档 —— 「生出来的新会话不会被回收」。
   *
   * 每一步都是一条新会话（会话之间什么都不共享，run 才是携带者），所以跑一遍二十几步的 flow 就往侧栏里
   * 塞二十几条，而它们在运行结束之后已经没有人会再对它们说话。原来唯一会关掉 worker 会话的地方是
   * 「打回 / 重跑」（`run:reset` 回的 `closeSessions`），也就是只有出错那条路会收拾。
   *
   * **归档而不是删**：那条会话的 transcript 就是这一步真正做了什么的记录，run 里只有状态和产出值。
   * 归档把它从侧栏拿走、随时能翻回来，属于可逆动作。正在被你看着的那条不动（否则界面当场被抽走），
   * 下次到达这里再收。
   */

  /**
   * @param only 只允许这些节点起跑。不给 = 所有就绪的都跑（一直以来的行为）。
   *
   *   给了，是因为节点上那两个按钮问的是**这一个**分支：「只跑这个分支和它之前的所有依赖节点」。
   *   没有它，点任何一个节点都会把当时所有 ready 的节点一起带跑 —— 包括你没点的那条平行支线。
   *   名单要一路传进递归：分支里的后续节点是在上游跑完之后才 ready 的，下一波仍然只能在名单里挑。
   */
  /**
   * 驱动锁多久算卡住。一波的**派发**（起会话 + attach + 发送）实测十几秒够了，60 秒只可能是卡死。
   */
  const DRIVE_LOCK_STALE_MS = 60_000;

  /** 正在被驱动的 run（`project\0runId`）→ 拿到锁的时刻。见 `advanceRun` 里那把会过期的锁。 */
  const drivingRef = useRef<Map<string, number>>(new Map());
  const doneCardSent = useCallback((mark: string): boolean => {
    try { return (JSON.parse(uiGet(RUN_DONE_CARD_KEY) || '[]') as string[]).includes(mark); }
    catch { return false; }
  }, []);
  const markDoneCardSent = useCallback((mark: string) => {
    try {
      const seen = JSON.parse(uiGet(RUN_DONE_CARD_KEY) || '[]') as string[];
      /** 只留最近 200 条 —— 这是个去重集合，不是历史记录；无界增长会把 ui-state 撑大。 */
      uiSet(RUN_DONE_CARD_KEY, JSON.stringify([...seen.filter((x) => x !== mark), mark].slice(-200)));
    } catch { /* 记不上就可能重发一张，比不发好 */ }
  }, []);

  /**
   * 用量读数走 `usageOf`（一个稳定的 getter），**不读 `usageBySession` 这个 state**。
   *
   * 两条理由，都是实测逼出来的：
   *
   *   ① **不能慢一轮。** 原来这里镜像了一个 ref（`usageBySessionRef.current = usageBySession`，渲染期赋值），
   *      而驱动器在 `sendMessage().then(...)` 里读它 —— 那一刻 React 往往还没为这一轮的 metadata 重渲染。
   *      于是 credits 的前后两次读到同一个数、算出来的花费是 **0**；`contextPct` 也一直慢一轮
   *      （实测钉下 8.179，而权威表里当时已经是 8.3）。`usageOf` 读的是收到 metadata 时就同步写好的那份 Map。
   *   ② **不能进 `advanceRun` 的依赖。** `usageBySession` 每一轮都会变（那正是它的用途），进了依赖就会
   *      每跑完一步重建一次驱动器和它下面那条递归链，而链上还挂着在飞的 `.then(...)`。
   *      `usageOf` 是 `useCallback(…, [])`，身份永不变，所以读它不付这个代价 ——
   *      和 `sendMessageRef` / `driveRunRef` 同一条理由，只是这次不需要 ref 了。
   */

  /**
   * 主进程记完一步的账之后推一把 —— **接住它，把 run 继续往下跑**。
   *
   * 「既然没有门为什么中间总是停下来」：驱动器活在渲染层，靠 `sendMessage(...).then(...)` 一波接一波
   * 递归。渲染层每重载一次（`Cmd+R`、dev-hot、崩一次），那条链连同整个 JS 堆消失 —— 对账会把在跑的
   * 那步补记成 `done`，但**没有任何东西再调 `advanceRun`**，run 就停在"该跑的都就绪、没人跑"。
   * 实测那个日志窗口里渲染层重载了 15 次。
   *
   * 只在**当前打开的那个 run** 上接：别的 run 不该被一条后台事件悄悄推着跑起来（它可能是你故意停下的）。
   * `advanceRun` 自己带锁，所以这一推和渲染层还活着的那条链不会打架。
   */
  const [deleteConfirm, setDeleteConfirm] = useState<{ sessionId: string; title: string } | null>(null);
  /** 被拒绝的删除请求的理由。必须说出来 —— 一个点了没反应的按钮会让人以为程序坏了，然后再点五次。 */
  const [deleteRefusal, setDeleteRefusal] = useState<string | null>(null);
  const [rerunConfirm, setRerunConfirm] = useState<{
    messageId: string;
    editedText: string;
    deleteCount: number;
    /** The chat the rerun belongs to — a split pane is not necessarily focused. */
    sessionId?: string;
  } | null>(null);
  const [deleteProjectConfirm, setDeleteProjectConfirm] = useState<{ name: string; memberCount: number } | null>(null);
  const [usageActionConfirm, setUsageActionConfirm] = useState<
    'contextMenu' | 'compact' | 'clear' | 'resetCredits' | null
  >(null);
  const [unreadSessionIds, setUnreadSessionIds] = useState<string[]>([]);
  // "Don't ask again" for delete confirmation (persisted).
  const [skipDeleteConfirm, setSkipDeleteConfirm] = useState<boolean>(() => {
    try { return uiGet('kirolex-skip-delete-confirm') === 'true'; } catch { return false; }
  });
  const [dontAskDelete, setDontAskDelete] = useState(false);
  // New Chat dialog: choose project at creation.
  const [showNewChat, setShowNewChat] = useState(false);
  /**
   * **新建会话时选哪台机器**（空 = 本地）。远程会话见 `docs/DESIGN_remote_sessions.md`：
   * 粒度在会话这一层，所以这个选择只在新建时做一次；`remoteTargets.enabled` 为假时整块不显示。
   */
  /**
   * **新会话默认跑在哪台机器上** ——「新建的会话应该刚开始就有远程 tag」
   * 「为什么新会话又变成本地了」。
   *
   * 这个值原来每次启动都是 `''`（= 本地），而两个创建入口（New Chat 对话框、项目里的 ＋）都读它 ——
   * 于是**每次重启之后建的第一批会话都是本地的**，哪怕你上一次明确选了东京。你看到的
   * "又变成本地了"就是这个：不是它被改回去了，是它从来没被记住。
   *
   * 记在 ui-state 里（`kirolex-new-chat-remote`）：跟着**你上一次明确的选择**走。
   * 那台机器连不上时新会话会明确失败 —— 那是对的，远程会话不许悄悄变本地（见 `intendedRemoteRef`）。
   */
  const [newChatRemoteId, setNewChatRemoteId] = useState(() => {
    try { return uiGet('kirolex-new-chat-remote') || ''; } catch { return ''; }
  });
  useEffect(() => {
    try { uiSet('kirolex-new-chat-remote', newChatRemoteId); } catch {}
  }, [newChatRemoteId]);
  /**
   * **用哪个 AI 跑新会话** ——「加 claude code 和 codex 支持，模式参考现有的 kirolex 会话模式」。
   * 和机器一样记住上一次的选择。Claude Code / Codex 先只在本机跑（远程那条路是按 kiro 写的）。
   */
  const [newChatEngine, setNewChatEngine] = useState<'kiro' | 'claude' | 'codex'>(() => {
    try {
      const v = uiGet('kirolex-new-chat-engine');
      return v === 'claude' || v === 'codex' ? v : 'kiro';
    } catch { return 'kiro'; }
  });
  useEffect(() => {
    try { uiSet('kirolex-new-chat-engine', newChatEngine); } catch {}
  }, [newChatEngine]);
  const remoteTargets = useRemoteTargets();
  const [newChatProject, setNewChatProject] = useState<string>(''); // '' = none, '__new__' = create
  const [newChatNewProjectName, setNewChatNewProjectName] = useState('');

  // Mark sessions as unread when they finish streaming and the user isn't viewing them
  const prevStreamingIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevStreamingIdsRef.current;
    // Sessions that were streaming before but aren't now = just finished
    const finished = prev.filter((id) => !streamingIds.includes(id));
    for (const fid of finished) {
      if (fid !== currentSessionId && !loopingIds.includes(fid)) {
        setUnreadSessionIds((u) => (u.includes(fid) ? u : [...u, fid]));
      }
    }
    prevStreamingIdsRef.current = streamingIds;
  }, [streamingIds, currentSessionId, loopingIds]);

  // Clear unread when user switches to a session
  const handleSwitchSession = useCallback((sessionId: string) => {
    setUnreadSessionIds((prev) => prev.filter((id) => id !== sessionId));
    switchSession(sessionId);
  }, [switchSession]);

  /**
   * EXPLICITLY OPEN A PROJECT RUN — the user's navigation wins over the chat that happened to be focused.
   *
   * `runViewVisible` correctly hides P's graph after the user switches to a chat in Q. But the project menu can
   * be opened while Q is focused too. Merely setting `runView` there creates the run and then immediately hides
   * it behind Q, which makes 「启用 / 加 flow」 look like a no-op. Enter one chat of P so the normal visibility
   * rule admits the page; if P has no chat yet, clear the unrelated focus and show the project page by itself.
   */
  /**
   * 这个 project 里这个 flow 的主会话，没有就建一个 —— 返回它的 id。
   *
   * 「我都添加了两个flow为什么一个主会话也没建出来？」：`flowMainSessionFor` 原来**只有一个调用点**
   * （`onOpenProjectWorkspace` 里那段循环），而那个 handler 在界面上没有任何触发点 —— 实测 `flow-main`
   * 会话在整个历史里一次都没被创建过。而「加 flow」这两条真正会被点的路径只调 `runCreate`。
   *
   * 主会话是这个 flow 在这个 project 里的**状态锚**：`flowMainDeletion` 用它决定历史能不能删，侧栏用它显示
   * 「🧩 X · 主」。所以它必须跟着「开始用这个 flow」诞生，而不是等谁恰好点到某个入口。
   */
  /**
   * 把一条结果卡写进这个 flow 的主会话。
   *
   * **只查，不建**：只为写一条进度而创建一条会话是不对的（主会话该由"开始用这个 flow"创建）。
   * 查不到就静默跳过 —— 回报是锦上添花，不能因为它失败而影响这次运行。
   *
   * 用 `mainSessionFlow` 而不是再调一次 `flowMainSessionFor`：后者全仓库只该有一个调用点
   * （就在 `ensureFlowMainSession` 里），那条不变量的用意是"只有一处决定谁是主会话"，有测试钉着。
   * 这里要的只是"查出来"，`mainSessionFlow` 正是现成的那个判据（它也在上面那个自动开 run 的
   * effect 里用着）。
   *
   * 走 `persistNote` 落盘（渲染层产生的 assistant 消息，已有的通道），不是只塞进内存：主会话下一轮
   * 要把它当上下文发出去，只在内存里的话刷新一次就没了。
   */

  /** 已经应用过的计划文本，按主会话记 —— 同一段回复不许被应用两次（流式过程中它会反复到达）。 */
  const planSeenRef = useRef<{ sessionId: string; seen: string }>({ sessionId: '', seen: '' });

  /**
   * 主会话（规划者）→ run：把它回复里的计划块落成 run draft 上的步骤。
   *
   * **和画布是同一份东西**：`run:add-node` 写进这个 run 的 draft 副本，而画布渲染的就是 run draft，
   * 所以加完立刻显示出来（主进程那边 `broadcastRun` 会推 `run:changed`）。冻结的定义和它的指纹不动 ——
   * `run:add-node` 只接受 `origin: 'added'`。
   *
   * 手法和画布那条一样（`applyCanvasStructure` 从 assistant 回复里抽 JSON），只是目标不同。
   * 落盘之前先用 `planRejection` 整体判一次：`run:add-node` 是**逐个**返回错误的，一次加五步而第三步
   * 依赖写错的话，前两步已经落盘了。
   */

  /**
   * 盯主会话的最新回复，抽出计划块应用到 run（→ 画布）。
   *
   * 吃的是**实时消息流**（`messages` / `paneViews`），和画布那条 effect 同一个来源、同一个理由：
   * 等落盘再读会晚一拍，而且依赖数组不再变化就不会重试。JSON 没闭合时 `extractFlowPlan` 返回 null，
   * 所以流式过程中它自然什么都不做，闭合的那一刻才应用。
   */

  /**
   * 泳道 → 它现在挂在哪条会话上。`run` 为空时只讲结构（还没起跑）。
   *
   * 泳道成员取自 `sessionLanes`（和画布同源），会话取自 run 里那些节点实际 attach 到的 id ——
   * 一条泳道理论上只有一条会话，取第一个非空的就够；不一致的话说明有一步被单独重跑过，那也是事实。
   */
  /** 上一次推给主会话的那份交底，按 `project\0flow` 记 —— 一样就不再推（见 `openProjectRun`）。 */
  const briefSentRef = useRef<Map<string, string>>(new Map());



  /**
   * 建一次运行并进入它 —— 三条创建路径（侧栏「开始用它」/ 运行页「加 flow」/「重开一次」）共用。
   *
   * 收敛成一个函数是因为它有三步且顺序有讲究：建 run → 补主会话 → 进运行页。原来这三步在两处各写一遍，
   * 而「只 setRunView 会被当前其它 project 的会话挡住」这个坑只在其中一处有注释。
   */

  /**
   * 重开上次开着的那块画布 —— 「重启之后这个画布怎么就没了」。
   *
   * 结构本来就在注册表里，会话本来就是现起的（「不必持久化」是对的）；真正丢掉的只是「你正在看哪一个」。
   * 所以恢复的也只有这一件事：读回名字，从注册表拿结构和原文，会话按需新建。跑一次就够，之后由你操作决定。
   */
  const studioRestored = useRef(false);


  const handleOpenLogs = useCallback(async () => {
    const result = await window.kiroApi.getLogs(LOGS_CHUNK).catch(() => ({
      text: '(failed to read logs)',
      path: '',
    }));
    logsHasMoreRef.current = result.text.split('\n').length >= LOGS_CHUNK;
    setLogsLimit(LOGS_CHUNK);
    setLogsText(result.text);
    setShowLogs(true);
  }, []);

  // Older logs load when the user scrolls to the top; scroll position is
  // preserved so the view doesn't jump.
  const loadOlderLogs = useCallback(async () => {
    if (!logsHasMoreRef.current || logsLoadingOlder) return;
    const el = logsPreRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    setLogsLoadingOlder(true);
    const nextLimit = logsLimit + LOGS_CHUNK;
    const result = await window.kiroApi.getLogs(nextLimit).catch(() => ({ text: logsText, path: '' }));
    const newCount = result.text.split('\n').length;
    if (newCount <= logsText.split('\n').length) {
      logsHasMoreRef.current = false; // reached the top of the file
    } else {
      setLogsText(result.text);
      setLogsLimit(nextLimit);
      requestAnimationFrame(() => {
        if (logsPreRef.current) logsPreRef.current.scrollTop += logsPreRef.current.scrollHeight - prevHeight;
      });
    }
    setLogsLoadingOlder(false);
  }, [logsLimit, logsLoadingOlder, logsText]);

  // On open, jump to the newest entries (bottom).
  useEffect(() => {
    if (showLogs && logsPreRef.current) {
      logsPreRef.current.scrollTop = logsPreRef.current.scrollHeight;
    }
  }, [showLogs]);

  /** Close one tab; activate a sensible neighbour so the panel never goes blank
   *  while other files are still open.
   *  NOTE: declared BEFORE openFileInApp on purpose — it appears in that
   *  callback's dependency array, which is evaluated during render (a const
   *  declared later would hit TDZ and crash the whole tree). */
  const closeFileTab = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx < 0) return prev;
      const next = prev.filter((t) => t.id !== tabId);
      setActiveFileTabId((current) => {
        if (current !== tabId) return current;
        const neighbour = next[idx] || next[idx - 1] || null;
        return neighbour ? neighbour.id : null;
      });
      return next;
    });
    delete fileScrollRef.current[tabId];
  }, []);

  // Open a file inside KiroLex's own viewer (internal "browser") rather than the
  // OS default app. Reads via the connected session's workspace:read.
  // Exception: file types the viewer cannot render (PDF/Office/media/archives…)
  // are handed to the OS default application instead of opening a dead tab.
  const openFileInApp = useCallback(async (rawPath: string, forSessionId?: string) => {
    const sessionForPath = forSessionId || currentSessionId;
    const p = rawPath.replace(/^file:\/\//, '');
    /* 你点开了一个文件 = 要看它：藏着的预览栏放出来（启动时把上次的标签开回来那一遍不算） */
    if (!tabsRestoringRef.current) setFileViewerHidden(false);
    // Already open -> just focus that tab. Re-reading would throw away the scroll
    // position and the rendered/raw choice the user had set.
    /*
      **同一个文件只开一个标签** —— 实测点同一个 `files/blog-draft-v1.md` 两次开出两个标签：读完之后
      标签的 `path` 被结果里解析好的绝对路径覆盖（`{ ...t, ...result }`），再点那个相对路径就对不上了。
      所以也按"当初点的是什么"（requestedPath）比，并且读 ref 里最新的标签表（两次点击之间可能还没重渲染）。
    */
    const existing = fileTabsRef.current.find((t) => t.path === p || t.requestedPath === p);
    if (existing) { setActiveFileTabId(existing.id); return; }

    // Known non-previewable type: go straight to the system app, no tab flash.
    /*
      **PDF / deck 例外** —— 它们由 KiroLex 自己生成预览（`isDeckPath` 是唯一判据）：`.pdf` 直接画，
      `.pptx` / `.docx`… 由主进程用 LibreOffice 转成 PDF。转不出来（没装 LibreOffice）也不甩出去：标签页里
      说清楚缺什么、怎么装，顶栏「↗ 打开文件」照样能交给系统应用。
    */
    if (needsSystemApp(p) && !isDeckPath(p)) {
      const res = await window.kiroApi.openExternal?.(p, sessionForPath || undefined);
      if (res?.ok !== false) return;
      // Fall through to the in-app tab so the failure is visible (and the tab
      // still offers 📂 打开位置).
    }

    const id = `ft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setFileTabs((prev) => {
      /* `ownerSessionId`：这份文件从哪条会话打开 —— 审阅的「✓ 确认」就由它改（见 `FileTab.ownerSessionId`） */
      const next = [...prev, { id, path: p, requestedPath: p, content: '', ownerSessionId: sessionForPath || undefined }];
      // Evict the oldest tab that is not the one we just opened.
      return next.length > MAX_FILE_TABS ? next.slice(next.length - MAX_FILE_TABS) : next;
    });
    setActiveFileTabId(id);
    setFileViewerLoading(true);
    try {
      // No connected chat required: the file viewer reads local disk, and gating it
      // on a session made the viewer (and the Workspace panel that feeds it) fail
      // with "打开一个已连接的会话后才能..." for any dormant chat. currentSessionId is
      // passed only so a RELATIVE path resolves against that chat's cwd.
      const result = await window.kiroApi.workspaceRead(sessionForPath, p);
      // Detected binary (NUL bytes / oversized image) with no useful preview:
      // hand it to the system app and drop the tab we just opened.
      /* **deck 例外**（第二道门）：`.pptx` 本质是个 zip，必然被判成 binary —— 它不需要 content，`ReviewPane` 自己取 */
      if (result.binary && !result.image && !isDeckPath(p)) {
        const res = await window.kiroApi.openExternal?.(p, sessionForPath || undefined);
        if (res?.ok !== false) { closeFileTab(id); return; }
      }
      setFileTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...result } : t)));
    } catch (err: any) {
      const message = `⚠️ ${err?.message || t('Could not read the file.')}`;
      setFileTabs((prev) => prev.map((t) => (t.id === id ? { ...t, content: message } : t)));
    } finally {
      setFileViewerLoading(false);
    }
  }, [currentSessionId, fileTabs, closeFileTab]);

  const setActiveTabRaw = useCallback((raw: boolean) => {
    setFileTabs((prev) => prev.map((t) => (t.id === activeFileTabId ? { ...t, raw } : t)));
  }, [activeFileTabId]);

  /** Re-read one open tab from disk, keeping everything the user chose about it.
   *
   *  The viewer used to be a one-shot snapshot: `openFileInApp` read the file once and
   *  re-opening an already-open path only focused its tab, so a file edited afterwards
   *  (by the agent, or in an editor) kept showing the old text with nothing to say it
   *  was out of date. `raw` and the scroll position are preserved deliberately -- a
   *  refresh must not throw away the rendered/source choice or jump to the top. */
  const refreshFileTab = useCallback(async (tabId: string, filePath: string) => {
    try {
      /* 以这个标签页的主人会话去读 —— 和打开时同一个身份（review 写回的白名单按它记，见 `ownerSessionId`） */
      const owner = fileTabsRef.current.find((t) => t.id === tabId)?.ownerSessionId;
      const result = await window.kiroApi.workspaceRead(owner || currentSessionId, filePath);
      setFileTabs((prev) => prev.map((t) => (t.id === tabId
        ? { ...t, ...result, raw: t.raw, stale: false, gone: false }
        : t)));
      /* 再推一下 `changedAt`：deck 的预览靠它重取 PDF 和讲稿（文本那侧用的是 content，这一项对它无害） */
      setFileTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, changedAt: Date.now() } : t)));
    } catch (err: any) {
      // Do NOT wipe the content: an unreadable file (mid-write, permissions) is a
      // reason to flag the tab, not to lose what the user was reading.
      setFileTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, stale: false, gone: true } : t)));
    }
  }, [currentSessionId]);

  // Tell main which files to watch. Runs whenever the open set changes, and clears the
  // watchers when the panel is closed (an empty list stops everything).
  useEffect(() => {
    const paths = fileTabs.map((t) => t.path);
    void window.kiroApi.workspaceWatchFiles?.(currentSessionId, paths).catch(() => {});
  }, [fileTabs.map((t) => t.path).join('\n'), currentSessionId]);

  // Apply a disk change: refresh the visible tab immediately, mark the others stale.
  useEffect(() => {
    const off = window.kiroApi.onWorkspaceFileChanged?.(({ path: changed, exists }) => {
      const tabs = fileTabsRef.current;
      const hit = tabs.find((t) => t.path === changed);
      if (!hit) return;
      if (!exists) {
        setFileTabs((prev) => prev.map((t) => (t.id === hit.id ? { ...t, gone: true } : t)));
        return;
      }
      if (hit.id === activeFileTabIdRef.current) void refreshFileTab(hit.id, hit.path);
      else setFileTabs((prev) => prev.map((t) => (t.id === hit.id ? { ...t, stale: true } : t)));
    });
    return () => { off?.(); };
  }, [refreshFileTab]);

  // A tab that changed while hidden is re-read the moment it becomes visible.
  useEffect(() => {
    if (!activeFileTabId) return;
    const tab = fileTabsRef.current.find((t) => t.id === activeFileTabId);
    if (tab?.stale) void refreshFileTab(tab.id, tab.path);
  }, [activeFileTabId, refreshFileTab]);

  // Restore this tab's scroll position after it becomes active (and after its
  // content lands, which is why `fileViewer?.content` is a dependency).
  /*
    不是第一帧设一次就完：Markdown 渲染、代码高亮、PDF 逐页画都是慢慢出来的，高度不够时设了也白设。
    `restoreScroll` 隔一会儿再试，到位 / 超时 / 用户自己动手滚了就停。
  */
  useEffect(() => {
    if (!activeFileTabId) return;
    const node = fileBodyRef.current;
    if (!node) return;
    const target = fileScrollRef.current[activeFileTabId] ?? 0;
    const stop = restoreScroll(node, target, () => { scrollRestoreStopRef.current = null; }, 15000);
    scrollRestoreStopRef.current = stop;
    return () => {
      stop();
      if (scrollRestoreStopRef.current === stop) scrollRestoreStopRef.current = null;
    };
  }, [activeFileTabId, fileViewer?.content, scrollRestoreTick, fileBodyNode]);

  // Persist WHICH files are open (paths only, plus the raw/rendered choice) so the
  // set survives a restart; content is re-read lazily on first activation.
  /** 正在把上次的标签一个个开回来 —— 那期间别存：存进去的是开了一半的那几个，reload 一次就少几个标签。 */
  const tabsRestoringRef = useRef(false);
  /** 把此刻开着的标签（连同各自的滚动位置）写进 `OPEN_TABS_KEY`。读的是 ref，所以滚动的防抖和关窗前都能直接调。 */
  const persistOpenTabs = useCallback(() => {
    if (!tabsRestoredRef.current || tabsRestoringRef.current) return;
    try {
      const tabs = fileTabsRef.current;
      // Shared store, not origin-scoped localStorage -- same reason as the drafts and
      // split sizes: the set of open files was reset on every dev/prod origin switch.
      if (tabs.length === 0) { uiRemove(OPEN_TABS_KEY); return; }
      const active = tabs.find((t) => t.id === activeFileTabIdRef.current);
      uiSet(OPEN_TABS_KEY, JSON.stringify({
        /*
          **连同主人会话一起存** ——「你重新加载了之后我之前打开的 comment 侧栏还是会丢」。原来只存路径，
          开回来时主人就成了"此刻选中的那条"（启动那一刻往往还没有）—— 没有主人，comment 那一侧就只能看，
          💬 / ✕ 和那些标记全都不见了。
          **滚动位置也存**（按路径 —— 开回来标签 id 就变了），开回来停在上次看到的那一段。
        */
        tabs: tabs.map((t) => {
          const scroll = Math.round(fileScrollRef.current[t.id] || 0);
          return {
            path: t.path, raw: !!t.raw,
            ...(t.ownerSessionId ? { owner: t.ownerSessionId } : {}),
            ...(scroll > 0 ? { scroll } : {}),
          };
        }),
        activePath: active?.path || null,
      }));
    } catch {}
  }, []);
  /* 关窗口 / 刷新前补写一次 —— 滚动的防抖那一下可能还没到点 */
  useEffect(() => {
    const flush = () => {
      if (scrollSaveTimerRef.current) { clearTimeout(scrollSaveTimerRef.current); scrollSaveTimerRef.current = null; }
      persistOpenTabs();
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [persistOpenTabs]);
  useEffect(() => {
    /*
      **开回来之前一律不存** ——「我明明跟你说刷新之后仍然要记录已经打开的 review 侧栏并重新打开，为什么这个功能没实现」。
      这个 effect 声明在"开回来"那个前面，同一次挂载里**先跑**：那一刻一个标签都还没开（`fileTabs` 是空的），
      于是走到下面 `uiRemove` —— 把存着的那份标签单子删了，紧接着"开回来"去读，读到的是空。每次刷新都是这样。
      所以等"开回来"那一遍跑过（`tabsRestoredRef`）、并且开完（`tabsRestoringRef`）再存。
    */
    persistOpenTabs();
  }, [fileTabs, fileViewer?.path, persistOpenTabs]);

  // Re-open last session's tabs on mount. This used to wait for `currentSessionId`
  // because workspaceRead demanded a connected chat; it no longer does, so the tabs
  // come back immediately instead of only after a backend happens to attach.
  const tabsRestoredRef = useRef(false);
  useEffect(() => {
    if (tabsRestoredRef.current) return;
    tabsRestoredRef.current = true;
    let saved: { tabs?: { path: string; raw?: boolean; owner?: string; scroll?: number }[]; activePath?: string | null } | null = null;
    try { saved = JSON.parse(uiGet(OPEN_TABS_KEY) || 'null'); } catch {}
    const list = (saved?.tabs || []).filter((t) => t && t.path);
    if (!list.length) return;
    tabsRestoringRef.current = true;
    (async () => {
      try {
        for (const t of list.slice(0, MAX_FILE_TABS)) await openFileInApp(t.path, t.owner || ownerFromPath(t.path));
      } finally {
        tabsRestoringRef.current = false;
      }
      /*
        存下的滚动位置挂回**新的**标签 id 上（旧存档没有这一项 = 顶部）。当前标签靠下面那一推马上滚，
        其余的切过去时由"切标签滚回原处"那个 effect 滚。用 `setFileTabs` 拿最新的标签表 —— ref 要等重渲染才更新。
      */
      setFileTabs((prev) => {
        for (const tab of prev) {
          const savedTab = list.find((x) => x.path === tab.path || x.path === tab.requestedPath);
          const scroll = savedScrollOf(savedTab);
          if (scroll > 0 && !fileScrollRef.current[tab.id]) fileScrollRef.current[tab.id] = scroll;
        }
        return prev;
      });
      setScrollRestoreTick((n) => n + 1);
      const active = saved?.activePath;
      if (active) {
        setFileTabs((prev) => {
          const hit = prev.find((t) => t.path === active);
          if (hit) setActiveFileTabId(hit.id);
          return prev.map((t) => {
            const savedTab = (saved?.tabs || []).find((x) => x.path === t.path);
            return savedTab?.raw ? { ...t, raw: true } : t;
          });
        });
      }
    })();
  }, [currentSessionId, openFileInApp]);

  // ⌘/Ctrl+W closes the active file tab, ⌘/Ctrl+1..9 jumps to the Nth. Only while
  // the panel is open, so these never steal the shortcut from the rest of the app.
  useEffect(() => {
    if (fileTabs.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'w') {
        event.preventDefault();
        if (activeFileTabId) closeFileTab(activeFileTabId);
        return;
      }
      const n = Number(event.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9 && fileTabs[n - 1]) {
        event.preventDefault();
        setActiveFileTabId(fileTabs[n - 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fileTabs, activeFileTabId, closeFileTab]);

  // File links/paths rendered in chat dispatch this event; open them in-app.
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent).detail?.path;
      /* 带着点击所在那条会话的 id：相对路径按它解析（分屏时不一定是"当前"会话） */
      const sid = (e as CustomEvent).detail?.sessionId;
      if (typeof path === 'string' && path) void openFileInApp(path, typeof sid === 'string' && sid ? sid : undefined);
    };
    window.addEventListener('kirolex:open-file', handler as EventListener);
    return () => window.removeEventListener('kirolex:open-file', handler as EventListener);
  }, [openFileInApp]);

  // 「📨 来自会话「…」」上的跳转（ChatArea 的 SessionFromChip）：打开那条会话
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail?.sessionId;
      if (typeof id !== 'string' || !id) return;
      if (!sessions.some((s) => s.id === id)) { showToast(tRef.current('That session no longer exists.')); return; }
      handleSwitchSession(id);
    };
    window.addEventListener('kirolex:open-session', handler as EventListener);
    return () => window.removeEventListener('kirolex:open-session', handler as EventListener);
  }, [sessions, handleSwitchSession]);

  const handleForkMessage = useCallback((messageId: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (!sid) return;
    if (loopingIds.includes(sid)) return;   // loop owns the session
    const forkedSessionId = duplicateSession(sid, messageId);
    if (forkedSessionId) handleSwitchSession(forkedSessionId);
  }, [currentSessionId, duplicateSession, handleSwitchSession, loopingIds]);

  // Rerun must resolve the turn inside the SESSION THE MESSAGE BELONGS TO. It
  // used to scan the focused chat's `messages`, so a rerun issued from a split
  // pane looked up the id in the wrong conversation (and could truncate it).
  const handleRerunMessage = useCallback((messageId: string, editedText: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (sid && loopingIds.includes(sid)) return;   // loop owns the session
    const list = (sid && sid !== currentSessionId ? paneViews[sid]?.messages : messages) || [];
    const baseIndex = list.findIndex((message) => message.id === messageId);
    if (baseIndex < 0) return;
    let turnEnd = baseIndex;
    while (
      turnEnd + 1 < list.length
      && list[turnEnd + 1].role === 'user'
      && !!list[turnEnd + 1].steer
    ) {
      turnEnd++;
    }
    const laterRecords = list.slice(turnEnd + 1);
    const hasLaterUserTurn = laterRecords.some((message) => message.role === 'user' && !isKirolexNote(message));
    if (hasLaterUserTurn) {
      setRerunConfirm({ messageId, editedText, deleteCount: laterRecords.length, sessionId: sid || undefined });
      return;
    }
    void rerunFromMessage(messageId, editedText, undefined, sid || undefined);
  }, [messages, paneViews, currentSessionId, rerunFromMessage, loopingIds]);

  const confirmRerun = useCallback(() => {
    if (!rerunConfirm) return;
    const pending = rerunConfirm;
    setRerunConfirm(null);
    void rerunFromMessage(pending.messageId, pending.editedText, undefined, pending.sessionId);
  }, [rerunConfirm, rerunFromMessage]);

  /**
   * 这个 project 还在用这个 flow 吗 —— 提成一个具名回调，因为现在有两个消费者：侧栏那个属性，
   * 以及下面 `handleDeleteSession` 里的删除守卫。原来它只是 Sidebar 的一个内联箭头函数，
   * 删除守卫拿不到它，也就无从判断主会话是否已经「不再被使用」。
   */

  const handleDeleteSession = useCallback((sessionId: string) => {
    // Drop it from the split layout too, otherwise the saved list keeps growing
    // with ids of chats that no longer exist (rendering already filters them,
    // but the persisted layout should stay clean).
    setSplitSessionIds((prev) => (prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : prev));
    // Read the persisted flag live (single source of truth, written by both the
    // Settings toggle and the dialog's "Don't ask again") to avoid any stale
    // closure of skipDeleteConfirm.
    let skip = skipDeleteConfirm;
    try { skip = uiGet('kirolex-skip-delete-confirm') === 'true'; } catch {}
    if (skip) { deleteSession(sessionId); return; }
    const session = sessions.find((s) => s.id === sessionId);
    setDeleteConfirm({ sessionId, title: displayTitle(settings.language, session?.title) || t('this session') });
  }, [sessions, skipDeleteConfirm, deleteSession, settings.language, t]);

  /**
   * Create a new chat directly inside a project (created already assigned).
   *
   * **这条路也要带上远端目标** ——「为什么新的那个远程 session 没有 tag、似乎是本地 session」：
   * 创建入口有两个，而上一版只给「New Chat 对话框」接了目标，项目里的「＋ 在此项目中新建会话」
   * 一个字都没传 —— 于是从那儿建出来的永远是本地会话，界面上也就没有徽标。
   *
   * 沿用对话框里选的那台机器：那是"你上一次明确选的目标"，比默默退回本地更符合预期；
   * 没选过（`newChatRemoteId` 为空）时它就是本地，行为和以前一样。
   */
  /**
   * **新会话用哪个模型** ——「为什么新远程的默认模型是 gpt？第一顺位应该是 claude opus 5」。
   *
   * 原来直接把 `selectedModel` 传下去。而 `selectedModel` 跟着**你正在看的那条会话**走
   * （下面那个 effect 会把它设成当条会话的模型）—— 所以只要你刚才看的那条会话被降级成
   * gpt-5.6-sol（本机出口 IP 被地域过滤，本机清单里一个 Claude 都没有，历史上好几条会话
   * 就是这么降下来的），点「新建」出来的就是 gpt，哪怕这条新会话去的是一台**有** Claude 的远端。
   *
   * 所以新会话的模型按两件事定：
   *   ① 你**明确选过**的那个（`kirolex-last-model` 只在手动切换时写，见 handleModelChange）；
   *      没有就用 opus 5（= 主进程的 DEFAULT_MODEL）；
   *   ② 拿**目标机器**的清单去验 —— 不是本机的。远端那台的清单里有 Claude，本机的没有，
   *      用错一份的表现正是这个 bug。
   *
   * 清单问不到（还没探过那台机器）时就直接用候选第一个：那时候没有依据说它不可用，
   * 而主进程起会话时还会再验一遍（`pickRemoteModel`），不会静默跑错。
   */
  /* 只对 kiro 挑（`engineModelPick.ts` newChatModel）：Claude Code / Codex 不塞 kiro 的模型 id，由 engineModels + 适配器清单定 */
  const modelForNewChat = useCallback((targetId?: string): string => {
    let wanted: string | undefined;
    try { wanted = uiGet('kirolex-last-model') || undefined; } catch {}
    const list = targetId ? (modelsByMachine[targetId] || []) : models;
    return newChatModel(newChatEngine, wanted, list.map((m: any) => m?.model_id).filter(Boolean));
  }, [models, modelsByMachine, newChatEngine]);

  const handleNewSessionInProject = useCallback((project: string) => {
    const target = remoteTargets.targets.find((t) => t.id === newChatRemoteId);
    void cwdFor(project).then((cwd) => newSession(cwd, modelForNewChat(target?.id), project, undefined, {
      remoteId: target?.id, remoteLabel: target?.label, engine: newChatEngine,
    }));
  }, [newSession, homeDir, modelForNewChat, remoteTargets.targets, newChatRemoteId, newChatEngine]);

  // Create a chat from the New Chat dialog, assigning the chosen project (if any)
  // at creation.
  const handleCreateChat = useCallback(() => {
    const proj = newChatProject === '__new__'
      ? (newChatNewProjectName.trim() || undefined)
      : (newChatProject || undefined);
    const target = remoteTargets.targets.find((t) => t.id === newChatRemoteId);
    void cwdFor(proj).then((cwd) => newSession(cwd, modelForNewChat(target?.id), proj, undefined, {
      remoteId: target?.id, remoteLabel: target?.label, engine: newChatEngine,
    }));
    setShowNewChat(false);
    setNewChatProject('');
    setNewChatNewProjectName('');
  }, [newChatProject, newChatNewProjectName, newSession, homeDir, modelForNewChat, remoteTargets.targets, newChatRemoteId, newChatEngine]);

  const confirmDelete = useCallback(() => {
    if (deleteConfirm) {
      if (dontAskDelete) {
        setSkipDeleteConfirm(true);
        try { uiSet('kirolex-skip-delete-confirm', 'true'); } catch {}
      }
      deleteSession(deleteConfirm.sessionId);
      setDeleteConfirm(null);
      setDontAskDelete(false);
    }
  }, [deleteConfirm, deleteSession, dontAskDelete]);

  // Project deletion is destructive (removes every member chat + the project's
  // memory) and ALWAYS confirms — deliberately independent of the chat-delete
  // "Don't ask again" / Settings toggle.
  const handleDeleteProject = useCallback((name: string) => {
    const memberCount = sessions.filter((s) => s.projectId === name).length;
    setDeleteProjectConfirm({ name, memberCount });
  }, [sessions]);

  const confirmDeleteProject = useCallback(() => {
    if (deleteProjectConfirm) {
      deleteProject(deleteProjectConfirm.name);
      setDeleteProjectConfirm(null);
    }
  }, [deleteProjectConfirm, deleteProject]);

  /**
   * 拉取模型列表。两条规则，都是那次「网恢复了还是显示模型都不可用」逼出来的：
   *
   *   ① 拿不到就用缓存显示，但**绝不**用更差的结果覆盖缓存（`shouldReplaceModelCache`）。
   *      原来是无条件 `uiSet`，一次退化结果（只剩 `auto`）就把唯一的回退来源写坏了。
   *   ② 失败不是终点。原来这段只在挂载时跑一次，所以「网恢复」应用根本不知道，只能等下次刷新。
   *      下面的 effect 会在 `online` 和窗口重新聚焦时再调一次。
   */
  /**
   * **模型列表按机器分** ——「确认下右侧界面远程会话显示的是远程的 agent 和模型」。
   *
   * 以前只有一份（本机那台的），所有会话的下拉共用它。而两台机器的 kiro-cli 版本不一样
   * （实测本机 2.23.1、东京 1.27.0），于是远程会话的下拉里会有那台机器**没有**的模型 ——
   * 启动那一刻 `pickRemoteModel` 会替换成可用的并在会话里说一句（不会静默跑错），
   * 但下拉本身在骗你。
   *
   * 缓存 key 带机器（`kirolex-models:<机器>`）：这是"哪台机器上有什么"，混在一起就是错的。
   */
  /* 声明挪到了 `models` 旁边 —— `modelForNewChat` 在这之前就要读它 */

  const refreshModels = useCallback(async (machine = 'local') => {
    const key = `kirolex-models${machine === 'local' ? '' : `:${machine}`}`;
    let cached: any[] = [];
    try { cached = JSON.parse(uiGet(key) || '[]'); } catch {}
    const apply = (list: any[]): void => {
      setModelsByMachine((prev) => ({ ...prev, [machine]: list }));
      if (machine === 'local') setModels(list);
    };
    try {
      const data = await window.kiroApi.listModels(machine === 'local' ? undefined : machine);
      const next = data?.models || [];
      if (shouldReplaceModelCache(next, cached)) {
        apply(next);
        try { uiSet(key, JSON.stringify(next)); } catch {}
      } else if (cached.length) {
        // 新结果不可信：继续显示缓存，并且把缓存留在盘上等下一次重试。
        apply(cached);
      }
    } catch {
      if (cached.length) apply(cached);
    }
  }, []);

  /**
   * 这条会话该显示哪台机器的模型。远端那台**问一次就够**（列表不会一分钟变一次）。
   *
   * **问到之前绝不拿本机那份顶上** ——「这个远程会话怎么中间又提示 claude unavailable 了，这个模型不可能不能用啊」。
   * 本机 kiro-cli 的清单里根本没有 Claude（只有 gpt-5.6-* / deepseek / glm…），远端那台有 21 个。原来远端清单
   * 还没回来（窗口一 reload、一重连就是这样）时退回本机那份 —— 于是远端会话正在用的 Claude 在下拉里被标成
   * 「· unavailable」，直到远端清单回来才消失。那个模型从来没有不能用过，是下拉在拿别的机器的清单比。
   * 现在：先用上次缓存的那份远端清单；连缓存都没有就给空 —— 空清单时下拉只显示当前模型本身，不下结论。
   */
  const modelsFor = useCallback((session: Session | null): any[] => {
    const host = session?.remoteHost;
    if (!host) return models;
    /* Claude Code / Codex 的模型清单来自它们自己的适配器（engine-models）：别为它们去远端问 kiro 的清单 */
    if (session?.engine === 'claude' || session?.engine === 'codex') return [];
    const machine = remoteTargets.targets.find((t) => t.label === host)?.id;
    /* 机器表还没加载出来：同样不能拿本机的比 */
    if (!machine) return [];
    if (!askedModels.current.has(machine)) {
      askedModels.current.add(machine);
      void refreshModels(machine);
    }
    if (modelsByMachine[machine]?.length) return modelsByMachine[machine];
    try {
      const cached = JSON.parse(uiGet(`kirolex-models:${machine}`) || '[]');
      if (Array.isArray(cached) && cached.length) return cached;
    } catch { /* 坏缓存当没有 */ }
    return [];
  }, [models, modelsByMachine, refreshModels, remoteTargets.targets]);

  /**
   * 这条会话该显示哪台机器的 agent。远端那台**问一次就够**；问不到时退回本机那份 ——
   * 空下拉比"可能多几个"更糟（那时你连当前 agent 都看不见）。
   */
  const agentsFor = useCallback((session: Session | null): Array<{ name: string; isDefault: boolean; source: 'built-in' | 'global' | 'local' }> => {
    const host = session?.remoteHost;
    if (!host) return kiroAgents;
    const machine = remoteTargets.targets.find((t) => t.label === host)?.id;
    if (!machine) return kiroAgents;
    if (!askedAgents.current.has(machine)) {
      askedAgents.current.add(machine);
      try {
        const cached = JSON.parse(uiGet(`${AGENTS_CACHE_KEY}:${machine}`) || '[]');
        if (Array.isArray(cached) && cached.length) setAgentsByMachine((prev) => ({ ...prev, [machine]: cached }));
      } catch {}
      void refreshAgents(machine);
    }
    return agentsByMachine[machine] || kiroAgents;
  }, [kiroAgents, agentsByMachine, refreshAgents, remoteTargets.targets]);

  /*
    Cmd+F、命中计数、高亮、以及「搜索时把渲染窗口整开」这一整套都搬进 `ChatArea` 了 ——
    一格一份。App 这里原来那几个 effect（发 `findInPage`、收 `found-in-page`、全局 Esc）
    全部删掉:留着它们就等于两套搜索同时在跑,而窗口级那一套在分屏时必然说谎。
  */

  /** 网络/窗口恢复后重新校验 —— 没有这个，一次超时会一直显示到下次刷新为止。 */
  useEffect(() => {
    const again = () => { void refreshModels(); };
    window.addEventListener('online', again);
    window.addEventListener('focus', again);
    return () => {
      window.removeEventListener('online', again);
      window.removeEventListener('focus', again);
    };
  }, [refreshModels]);

  /**
   * **网络回来之后把看得见的那几条会话接回来** ——「我看到现在远程会话断了，为什么没有自动刷新」。
   *
   * ## 为什么原来不会自己回来
   *
   * `disconnected` 事件上**有**自动恢复（`useAcp` 里那段 `AUTO-RECOVERY`），但它只试**一次**
   * （600ms 后，8s 节流），失败就按注释说的 `stay dormant`，等用户下一次发消息。
   * 实测那次：笔记本的 VPN 掉线 → `ssh: connect to host … Network is unreachable`
   * → 那一次重试也连不上 → 然后 2.5 小时里**没有任何东西再试**，界面一直是断开的灰点。
   *
   * 上面那个 effect 已经在 `online`/`focus` 上重新拉模型列表了 —— 缺的正是同一个时机下
   * 把执行器也接回来。网络恢复是**事件**，不是需要轮询的状态，所以这里不加定时器。
   *
   * ## 为什么只接 `panes`（看得见的那几条），不接全部
   *
   * 现在有 31 条远程会话。全部拉起来 = 31 次 ssh 握手砸向 sshd 的 `MaxStartups`（10:30:100）,
   * 而那个队列被撑满正是"连不上"的成因之一（已经为此加过 `preflightInFlight` 和连接复用）。
   * 看不见的那些保持冷的没有代价：点开它们本来就会 `warmSession`。
   *
   * `warmSession` 自己就是幂等的（已 attach / 归档 / `pending_` 一律跳过），所以这里不需要
   * 再判一遍"该不该接"—— 判两遍就是两份会不一致的真相。
   */
  /* 监听器要读"触发那一刻看得见哪几条"，所以用 ref 而不是把 `panes` 放进依赖 */
  const panesRef = useRef<string[]>([]);
  panesRef.current = panes;
  const lastRewarmRef = useRef(0);
  useEffect(() => {
    const rewarm = () => {
      /*
        **节流 5 秒** —— `focus` 在切窗口时很密（点一下 Dock、切回来、再点一下），
        每次都去 attach 等于把启动风暴搬到每次切窗口上。`online` 也会连着来好几次。
      */
      if (Date.now() - lastRewarmRef.current < 5_000) return;
      lastRewarmRef.current = Date.now();
      for (const id of panesRef.current) void warmSession(id);
    };
    window.addEventListener('online', rewarm);
    window.addEventListener('focus', rewarm);
    return () => {
      window.removeEventListener('online', rewarm);
      window.removeEventListener('focus', rewarm);
    };
    /*
      依赖里**不放 `panes`** —— 它每次分屏变化都是新数组，放进来会让监听器反复摘挂。
      用一个 ref 读当前值：监听器要的是"触发那一刻看得见哪几条"，不是挂载时的那一份。
    */
  }, [warmSession]);

  useEffect(() => {
    if (window.kiroApi) {
      window.kiroApi.getHomeDir().then(setHomeDir).catch(() => {});

      /**
       * 模型和 agent 列表**推迟到启动风暴之后**再拉。
       *
       * 这两条命令各要 spawn 一个新的 kiro-cli，而 kiro-cli 冷启动要加载全部 MCP server —— 实测空闲时
       * 一次 `--list-models` 稳定 3.4 秒。启动瞬间 eager-attach 正在同时拉起多条会话的执行器，这时候
       * 再插两个冷启动就双双超时：日志里 13 次 `timed out after 10000ms`，把超时提到 30s 之后照样超
       * （06:34:48 两条）。所以这不是超时不够，是**时机不对**。
       *
       * 界面在这段时间里不是空的：`refreshModels` 拿不到就显示 `kirolex-models` 缓存（而缓存现在
       * 受 `shouldReplaceModelCache` 保护，不会再被退化结果写坏）；agent 列表同理保留上一次的。
       * 最坏情况从「显示模型都不可用」变成「晚几秒刷新」。
       *
       * 4 秒是给 eager-attach 让路，不是魔法数字：日志里 `reveal: window shown` 通常落在 +2～4s。
       */
      const warmupDelay = setTimeout(() => {
        void refreshModels();
        /* agent 列表走同一条路（`refreshAgents`：空列表不收 + 落盘）—— 不再各写一遍 */
        void refreshAgents();
      }, MODEL_LIST_WARMUP_DELAY_MS);

      // Auto-connect
      const autoConnect = setTimeout(() => {
        connect(selectedModel);
      }, 300);
      return () => { clearTimeout(warmupDelay); clearTimeout(autoConnect); };
    }
  }, []);

  // Apply font size to document
  useEffect(() => {
    document.documentElement.style.setProperty('--chat-font-size', `${settings.fontSize}px`);
  }, [settings.fontSize]);

  // 界面缩放：整窗按比例缩放（webFrame.setZoomFactor，和浏览器整页缩放一样，
  // 拖分栏 / 菜单定位用的 clientX、getBoundingClientRect 都在同一套 CSS px 里，不会错位）
  useEffect(() => {
    (window as any).kiroApi?.setUiZoom?.(normalizeUiZoom(settings.uiZoom) / 100);
  }, [settings.uiZoom]);

  // Ctrl(⌘) + 加号 / 减号 / 0：主进程拦下后转过来，改的就是设置里这个值（设置对话框的数字跟着变）
  useEffect(() => {
    const off = (window as any).kiroApi?.onUiZoomKey?.((action: 'in' | 'out' | 'reset') => {
      setSettings((cur) => {
        const next = stepUiZoom(cur.uiZoom, action);
        return next === cur.uiZoom ? cur : { ...cur, uiZoom: next };
      });
    });
    return () => { try { off?.(); } catch { /* 卸载 */ } };
  }, []);

  // Font families are applied as CSS variables so every surface (chat, sidebar,
  // dialogs, code blocks) follows the setting without per-component overrides.
  useEffect(() => {
    const root = document.documentElement.style;
    if (settings.fontFamily.trim()) root.setProperty('--app-font', settings.fontFamily);
    else root.removeProperty('--app-font');
    if (settings.monoFontFamily.trim()) root.setProperty('--mono-font', settings.monoFontFamily);
    else root.removeProperty('--mono-font');
  }, [settings.fontFamily, settings.monoFontFamily]);

  // Persist from EVERY path, not just the dialog. Split view raises/clears
  // splitGrid internally (entering and leaving split mode), and those changes
  // were silently lost because only the dialog handler called saveSettings.
  useEffect(() => { saveSettings(settings); }, [settings]);

  const handleSettingsChange = useCallback((newSettings: Settings) => {
    setSettings(newSettings);
  }, []);

  const handleModelChange = useCallback(async (model: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    /* 这一轮还在跑（包括循环里的一轮）也能选 —— 主进程记成 pending，这一轮跑完、下一轮开始前切（见 main/pendingSwitch.ts） */
    if (
      !sid ||
      switchingModelIds.includes(sid)
    ) return;
    const pendingModel = pendingSwitches[sid]?.model;
    if (pendingModel !== undefined) {
      if (model === pendingModel) return;
      /* 选回现在实际在用的那个 = 不切了：取消 pending */
      const actual = sessions.find((x) => x.id === sid)?.model;
      if (model === actual) { await cancelPendingSwitch(sid, 'model'); return; }
    }

    setSwitchingModelIds((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
    try {
      const confirmed = await changeSessionModel(sid, model);
      // Reflect what the BACKEND confirmed. Setting the requested model here
      // unconditionally is what let the selector drift away from the executor.
      // 记成 pending 时没有"确认的值"（undefined）：下拉显示 pending 那个，实际值不动。
      if (confirmed) {
        setSelectedModel(confirmed);
        try { uiSet('kirolex-last-model', confirmed); } catch {}
      }
    } finally {
      setSwitchingModelIds((prev) => prev.filter((id) => id !== sid));
    }
  }, [currentSessionId, sessions, switchingModelIds, changeSessionModel, pendingSwitches, cancelPendingSwitch]);

  // Keep the model dropdown in sync with the current session's model.
  // A session with its own explicit model shows it; 'auto'/legacy sessions fall
  // back to the user's last-chosen model (persisted) rather than a hardcoded one.
  useEffect(() => {
    if (!currentSessionId) return;
    const s = sessions.find((x) => x.id === currentSessionId);
    let lastModel = 'claude-opus-5';   // must equal main's DEFAULT_MODEL
    try { lastModel = uiGet('kirolex-last-model') || lastModel; } catch {}
    const effective = (s?.model && s.model !== 'auto') ? s.model : lastModel;
    setSelectedModel(effective);
  }, [currentSessionId, sessions]);

  const currentSession = sessions.find((session) => session.id === currentSessionId) || null;
  /** 「管理上下文」确认框里说谁去压缩 / 清空：kiro 会话仍说 Kiro CLI，Claude Code / Codex 说自己 */
  const usageEngineName = currentSession?.engine && currentSession.engine !== 'kiro' ? engineLabel(currentSession.engine) : 'Kiro CLI';
  /** 每条会话的「连上且挂好」（和下面 sessionConnected 同一个判据）—— 后台恢复的会话也要清掉它的切换失败 ✗ */
  const readySessionIds = useMemo(
    () => attachedSessionIds.filter((id) => !connectingSessionIds.includes(id)),
    [attachedSessionIds, connectingSessionIds],
  );
  const selectedKiroAgent = currentSession?.kiroAgent
    || kiroAgents.find((agent) => agent.isDefault)?.name
    || 'kiro_default';

  const handleKiroAgentChange = useCallback(async (agentName: string, paneSid?: string) => {
    // `paneSid` was accepted and then ignored, so changing the Agent in a split
    // pane reconfigured the FOCUSED pane's session instead — a wrong-target write,
    // not just a display glitch. Every guard below is likewise per-session; the
    // focused-pane values (isStreaming / switchingAgent / selectedKiroAgent) let a
    // switch through while the target pane was busy and compared against the wrong
    // Agent. Mirrors handleModelChange.
    const sid = paneSid || currentSessionId;
    const currentAgent = sessions.find((session) => session.id === sid)?.kiroAgent
      || kiroAgents.find((agent) => agent.isDefault)?.name
      || 'kiro_default';
    /* 这一轮还在跑（包括循环里的一轮）也能选 —— 主进程记成 pending，这一轮跑完、下一轮开始前切（见 main/pendingSwitch.ts） */
    if (
      !sid ||
      switchingAgentIds.includes(sid)
    ) return;
    const pendingAgent = pendingSwitches[sid]?.agent;
    if (pendingAgent !== undefined) {
      if (agentName === pendingAgent) return;
      /* 选回现在实际在用的那个 = 不切了：取消 pending */
      if (agentName === currentAgent) { await cancelPendingSwitch(sid, 'agent'); return; }
    } else if (agentName === currentAgent) return;

    setSwitchingAgentIds((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
    try {
      await changeSessionAgent(sid, agentName);
    } finally {
      setSwitchingAgentIds((prev) => prev.filter((id) => id !== sid));
    }
  }, [currentSessionId, sessions, kiroAgents, switchingAgentIds, changeSessionAgent, pendingSwitches, cancelPendingSwitch]);


  const permissionMode = currentSession?.permissionMode || 'auto-approve';
  const handlePermissionModeChange = useCallback(async (
    mode: 'auto-approve' | 'ask',
    paneSid?: string,
  ) => {
    const sid = paneSid || currentSessionId;
    const sessionForMode = sid ? sessions.find((s) => s.id === sid) : null;
    /* 这一轮还在跑（包括循环里的一轮）也能点 —— 主进程记成 pending，跑完再换（见 main/pendingSwitch.ts） */
    if (!sid) return;
    const pendingMode = pendingSwitches[sid]?.permission;
    const actualMode = sessionForMode?.permissionMode || 'auto-approve';
    if (pendingMode !== undefined) {
      if (mode === pendingMode) return;
      if (mode === actualMode) { await cancelPendingSwitch(sid, 'permission'); return; }
    } else if (mode === actualMode) return;
    await changeSessionPermissionMode(sid, mode);
  }, [
    currentSessionId,
    sessions,
    changeSessionPermissionMode,
    pendingSwitches,
    cancelPendingSwitch,
  ]);

  const handleDropFiles = useCallback((files: AttachedFile[], sid?: string) => {
    addAttachments(sid || currentSessionId, files);
  }, [addAttachments, currentSessionId]);

  const handleRemoveFile = useCallback((id: string, sid?: string) => {
    const target = sid || currentSessionId;
    if (!target) return;
    setAttachedBySession((prev) => ({ ...prev, [target]: (prev[target] || []).filter((f) => f.id !== id) }));
  }, [currentSessionId]);

  /** Make `sid` the focused session before acting on it. switchSession sets the
   *  hook's currentSessionRef SYNCHRONOUSLY, so a send issued right after this
   *  lands in `sid` even before React re-renders. This is what lets every split
   *  pane have a working composer without duplicating the send pipeline. */
  const focusSession = useCallback(async (sid: string | null) => {
    if (!sid || sid === currentSessionId) return;
    await handleSwitchSession(sid);
  }, [currentSessionId, handleSwitchSession]);

  focusSessionRef.current = focusSession;

  const handleSendMessage = useCallback(async (text: string, pastes?: PastedBlock[], paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    // A loop OWNS its session: it is already resending on a timer, so anything else
    // sent into it interleaves with those turns. Stop is the only way out, and it
    // clears the loop (see cancelStream). Disabling the buttons was not enough —
    // Enter and Ctrl+Enter reach these handlers directly.
    if (sid && loopingIds.includes(sid)) return;
    await focusSession(sid);
    // Clear unread status when user interacts
    if (sid) {
      setUnreadSessionIds((prev) => prev.filter((id) => id !== sid));
    }

    // History rebuild in progress / owed: the backend cannot answer this yet, so
    // QUEUE it rather than firing it into a context-less session. The queue drains
    // automatically once the rebuild finishes, preserving order. Slash commands are
    // handled locally below and are exempt.
    //
    //
    // This used to list only the two rebuild states, so 'reconfiguring' (a model /
    // Agent switch) and 'attaching' fell through -- and because sending attaches on
    // demand, the message hit `acp:load-session` mid-switch and came back as a raw
    // `Error invoking remote method 'acp:load-session'` on the user's own message.
    // A switch takes seconds and ends with the chat ready, so the message simply
    // waits: the drain effect below already waits on `isBackendOccupied`, so it
    // leaves on its own the moment the switch completes.
    /* 新建的会话引擎还没就绪（或启动失败、还没重试）：同样进排队，界面上显示「排队中，引擎就绪后自动发出」 */
    if (sid && !text.trim().startsWith('/') && ((isBackendOccupied(busyBySession[sid])
        && busyBySession[sid] !== 'turn') || startupBlocksSend(createStages[sid]))) {
      // Via ref: handleQueueMessage is declared BELOW this callback, and a
      // later-declared const in a dependency array is evaluated during render and
      // would hit TDZ, crashing the whole tree.
      queueMessageRef.current?.(text, pastes, sid);
      return;
    }

    // A TURN is still running on this chat. Reaching here means the composer thought
    // otherwise -- e.g. this window reloaded mid-turn and lost `streamingIds`, so
    // Enter sent instead of steering. Main would reject it ("wait for the active
    // turn") AFTER the bubble is already on screen, i.e. the message silently never
    // arrives. Steer it into the running turn instead, which is what Enter during a
    // turn means anyway.
    if (sid && !text.trim().startsWith('/') && busyBySession[sid] === 'turn') {
      void handleSteerMessageRef.current?.(text, pastes, sid);
      return;
    }

    // Handle /stop locally - force interrupt and reconnect
    if (text.trim() === '/stop') {
      // Hard stop is an explicit user cancel: clear every session's un-consumed
      // pending steers so the turn-end reconcile can't re-queue a phantom
      // follow-up after the reconnect. Ordinary queues are preserved (KiroLex
      // "Stop keeps the queue" rule) — we only drop un-consumed steers.
      discardUnconsumedSteers();
      /* 这是**你**停的：它会断开所有执行器，正在跑的那几条都不许被"中断自动重发"拉回去 */
      for (const id of new Set([...streamingIds, ...(currentSessionId ? [currentSessionId] : [])])) cancelAutoResend(id);
      await forceStop(selectedModel);
      // 回显给敲命令的那一格：await forceStop 期间焦点可能已经换了（同下面 /clear 那段）
      sendMessage([{ type: 'text', text: '/stop' }], '🔄 Force interrupted and reconnected.', undefined, undefined, undefined, sid || undefined);
      return;
    }

    // Handle /clear: wipe the visible history + cache, then forward /clear so
    // the backend also resets its context. KiroLex's own stored transcript is
    // deliberately left alone -- see the note on clearConversation.
    if (text.trim() === '/clear') {
      /*
        水位线**先落盘再清屏**：`switchSession` 见到空缓存会从磁盘重读，没有水位线的话切走再切回来
        整份历史就回来了，快照也会把它重新喂给模型。transcript 本身不删。见 `SessionRecord.clearedAt`。
      */
      if (sid) await window.kiroApi.markCleared?.(sid);
      clearConversation(sid);
      // 显式发给 sid：上面 await 期间可能已经切到别的会话，落回"当前焦点"就会清错那一条
      await sendMessage([{ type: 'text', text: '/clear' }], undefined, undefined, undefined, undefined, sid || undefined);
      return;
    }

    // Handle /usage locally
    if (text.trim() === '/usage') {
      try {
        const result = await window.kiroApi.getUsage();
        // Add as a fake assistant message — 发给 sid：await 期间焦点可能已经换了
        sendMessage([{ type: 'text', text: '/usage' }], result.text, undefined, undefined, undefined, sid || undefined);
      } catch (err) {
        sendMessage([{ type: 'text', text: '/usage' }], tRef.current('Failed to fetch usage info'), undefined, undefined, undefined, sid || undefined);
      }
      return;
    }

    const prompt: any[] = [];
    const currentAttachments = [...attachedFor(sid)];

    if (currentAttachments.length > 0) {
      const fileRefs = currentAttachments
        .map((f) => `file:${f.path}`)
        .join('\n');
      prompt.push({
        type: 'text',
        text: `<hidden>${fileRefs}\n请读取这些文件内容</hidden>`,
      });
    }

    // With attachments and no typed text, the hidden file-ref block already
    // carries the instruction -- don't append an empty text part.
    // The MODEL must see the real pasted content; the bubble and the transcript
    // keep the short `[ 粘贴 #N · M 行 ]` placeholders. KiroLex already separates
    // prompt from displayText, so this needs no extra storage.
    const expanded = pastes?.length ? expandPastes(text, pastes) : text;
    if (text.trim() || currentAttachments.length === 0) prompt.push({ type: 'text', text: expanded });
    clearAttachments(sid);
    await sendMessage(
      prompt,
      undefined,
      currentAttachments.length > 0 ? currentAttachments : undefined,
      // selectedModel 是焦点会话的（还是 await focusSession 之前的闭包值）：别的格子发的让 sendMessage 按 sid 自己的模型来
      sid && sid !== currentSessionId ? undefined : selectedModel,
      pastes?.length
        ? { text, pastes: pastes.map(({ seq, lines, chars, path }) => ({ seq, lines, chars, path })) }
        : undefined,
      // TARGET-ADDRESSED. This was the one caller that computed `sid` (from paneSid)
      // and then dropped it, leaving sendMessage to fall back to whatever chat was
      // focused -- see its own comment on why that is wrong in split view.
      sid || undefined,
    );
  }, [attachedFor, clearAttachments, focusSession, sendMessage, currentSessionId, forceStop, selectedModel, discardUnconsumedSteers, clearConversation, busyBySession, createStages, loopingIds, streamingIds, cancelAutoResend]);

  // Explicit user Stop (composer stop button). Discard this session's un-consumed
  // steers FIRST so the turn-end reconcile finds nothing to re-queue (no phantom
  // follow-up turn), THEN cancel the running prompt. Already-consumed steers are
  // not pending, so they remain in the message group; only the current turn ends.
  const handleStopStream = useCallback(async (paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    // Stop must ALWAYS do something. Previously it returned early during a history
    // rebuild, which left no way to call off even a pending auto-resend.
    if (sid) {
      cancelAutoResend(sid);          // stop a queued/pending auto-resend first
      discardUnconsumedSteers(sid);
    }
    await cancelStream(sid);          // main turns this into "abandon rebuild" when priming
  }, [currentSessionId, discardUnconsumedSteers, cancelStream, cancelAutoResend]);

  const handleConfirmUsageAction = useCallback(async () => {
    const action = usageActionConfirm;
    setUsageActionConfirm(null);
    if (
      !action
      || action === 'contextMenu'
      || !currentSessionId
      || isStreaming
    ) return;
    if (action === 'compact') {
      await handleSendMessage('/compact');
    } else if (action === 'clear') {
      await handleSendMessage('/clear');
    } else {
      resetSessionCredits(currentSessionId);
    }
  }, [usageActionConfirm, currentSessionId, isStreaming, handleSendMessage, resetSessionCredits]);

  /**
   * MeshClaw-style per-session follow-up queues. A message submitted while its session is busy is queued;
   * idle submissions bypass the queue and run now. Each queue is FIFO, drains independently in the
   * background, and supports edit/cancel/reorder before execution.
   *
   * **落盘** —— 「会话被重新渲染了 queue 就会丢失」。
   *
   * 它原来是「故意只活在运行时」的。可这里的运行时是**渲染进程**,而排队的东西是你已经打完字、按过回车的
   * 内容:一次刷新、一次热替换、开发时改一行代码,它们就没了,而你以为它们在等着发。执行器活在主进程里,
   * 那一轮根本没停 —— 只有队列跟着窗口一起消失,这是最容易让人白等的一种不一致。
   *
   * 恢复之后照旧由那条排空逻辑接管:它本来就只在会话空闲时才发,和刷新前是同一条规则,所以不会因为
   * 「重启了」而抢跑。
   */
  const [queuesBySession, setQueuesBySession] = useState<Record<string, QueuedMessage[]>>(() => {
    try {
      const raw = JSON.parse(uiGet(QUEUES_KEY) || '{}');
      if (!raw || typeof raw !== 'object') return {};
      const out: Record<string, QueuedMessage[]> = {};
      for (const [sid, items] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(items)) continue;
        const kept = items.filter((item: any) => item && typeof item.id === 'string' && typeof item.content === 'string')
          .map((item: any) => ({
            id: item.id,
            content: item.content,
            attachments: Array.isArray(item.attachments) ? item.attachments : [],
            ...(Array.isArray(item.pastes) ? { pastes: item.pastes } : null),
            createdAt: Number(item.createdAt) || Date.now(),
            restored: true,
            // 「重建历史中，结束后发送」的标记必须跟着回来：否则刷新 / 重启后它变成普通排队卡片，
            // 合并排队开着时还会和后面的排队一起发出去
            ...(item.afterRebuild === true ? { afterRebuild: true } : null),
            // 没发成的那一批的 id 和边界也跟着回来：重启后重试照样是同一次提交（`queueRetry.pickQueuedBatch`）
            ...(item.retryBatch && typeof item.retryBatch.id === 'string' && Number(item.retryBatch.size) > 0
              ? { retryBatch: { id: item.retryBatch.id, size: Number(item.retryBatch.size) } } : null),
            ...(typeof item.fromHandoff === 'string' ? { fromHandoff: item.fromHandoff } : null),
          })) as QueuedMessage[];
        if (kept.length) out[sid] = kept;
      }
      return out;
    } catch { return {}; }
  });
  // Mirror so a pane's queue action can read ITS queue without depending on the
  // focused session's snapshot.
  const queuesBySessionRef = useRef<Record<string, QueuedMessage[]>>({});
  queuesBySessionRef.current = queuesBySession;
  /* 队列一变就落盘。空队列删掉键，免得 ui-state 里留一堆 `sid: []` */
  useEffect(() => {
    try {
      const alive = Object.fromEntries(Object.entries(queuesBySession).filter(([, items]) => items.length));
      if (Object.keys(alive).length) uiSet(QUEUES_KEY, JSON.stringify(alive));
      else uiRemove(QUEUES_KEY);
    } catch {}
  }, [queuesBySession]);
  const queueSendingRef = useRef<Set<string>>(new Set());
  /* 排队那条发失败之后按会话退避（`queueRetry.ts`）—— 退避到点时靠 `queueRetryTick` 叫醒排空 effect */
  const queueBackoffRef = useRef(new QueueBackoff());
  const [queueRetryTick, setQueueRetryTick] = useState(0);
  const [restoredQueueDraft, setRestoredQueueDraft] = useState<{ id: number; text: string; sessionId?: string } | null>(null);

  /*
    `currentQueue` 已删 —— 它按**焦点会话**算队列，而唯一的消费者 `handleSteerMessage` 操作的是
    **格子的会话**（`paneSid || currentSessionId`）。分屏时两者常常不同，那次不一致会让消息静默消失
    （详见 handleSteerMessage 里 (4) 那段）。现在那里读 `queuesBySessionRef.current[sessionId]`，
    这个变量就没有正确的用处了：任何按焦点会话算的队列都会重新引入同一个 bug。
  */

  // Reconcile un-consumed mid-turn steers into the queue head (order preserved)
  // once a turn finishes, so a steer written too late to be consumed is never
  // lost — it becomes a normal queued item that drains next on the idle session.
  // Kept separate from the unread effect so it can reference the queue state
  // declared just above (no forward reference), and uses its own transition ref.
  /* 上一次运行没被吃掉的 steer：作为排队消息放回各自会话的队列头（标成 restored，和恢复的队列一样） */
  const orphanSteersTakenRef = useRef(false);
  useEffect(() => {
    if (orphanSteersTakenRef.current) return;
    orphanSteersTakenRef.current = true;
    const orphans = takeOrphanSteers();
    const sids = Object.keys(orphans).filter((sid) => orphans[sid]?.length);
    if (!sids.length) return;
    setQueuesBySession((current) => {
      const next = { ...current };
      for (const sid of sids) {
        next[sid] = [
          ...orphans[sid].map((s) => ({
            // 经控制入口追加的那条照样带标记（`carryControlMark`）
            id: carryControlMark(s.msgId, 'queue') ?? `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            content: s.content,
            attachments: s.attachments || [],
            createdAt: Date.now(),
            restored: true,
          })),
          ...(current[sid] || []),
        ];
      }
      return next;
    });
  }, [takeOrphanSteers]);

  const prevSteerStreamingRef = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevSteerStreamingRef.current;
    const finished = prev.filter((id) => !streamingIds.includes(id));
    for (const fid of finished) {
      const leftover = takeUnconsumedSteers(fid);
      if (leftover.length === 0) continue;
      setQueuesBySession((current) => ({
        ...current,
        [fid]: [
          ...leftover.map((s) => ({
            // 经控制入口追加的那条放回队头时照样带标记（发出去时气泡上标「经控制入口发送」）
            id: carryControlMark(s.msgId, 'queue') ?? `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            content: s.content,
            attachments: s.attachments,
            createdAt: Date.now(),
          })),
          ...(current[fid] || []),
        ],
      }));
    }
    prevSteerStreamingRef.current = streamingIds;
  }, [streamingIds, takeUnconsumedSteers]);

  /**
   * 普通 Enter，会话忙时：**永远 steer 当前这一轮**（路由判据在 `steerRoute.ts`，有测试）。
   *
   * 以前有四条路会把它悄悄变成排队（队列非空 → 并进队尾 / 带附件 → 排队 / 重建历史中 → 排队 /
   * steer 失败 → 放队头）。实测一次：会话在跑 120 秒的 `local_bash`，前面三次 steer 都成功了，第四次 Enter
   * 却进了队列，而且卡片里还是粘贴占位符 —— 输入框交给 `onSteerMessage` 的时候把粘贴块丢了。现在：
   *   · 队列非空也照样 steer（想排队用 ⌘/Ctrl+Enter，`handleQueueMessage`，不变）；
   *   · 带附件：附件按本机路径写进 steer 文字（和普通消息一样的引用块），气泡上照常显示附件；
   *   · 粘贴：先展开再 steer（所有入口都把 `pastes` 带过来）；
   *   · 重建历史中：不能 steer 进隐藏的 priming 轮 → 标「重建历史中，结束后发送」，重建一结束就作为下一条发出；
   *   · steer 失败：消息标红，用户自己选「作为下一条发送」/「放回输入框」。只有「这一轮已经结束」直接作为新消息发出，
   *     并在状态行说一声。
   *
   * 操作的永远是**这一格的会话**（`paneSid || currentSessionId`），不是焦点会话（见 tests/queuePaneScope.test.ts）。
   */
  /* 读最新的忙碌状态：回调里先 await 了 focusSession，闭包里的那份那时可能已经过期 */
  const busyBySessionRef = useRef(busyBySession);
  busyBySessionRef.current = busyBySession;
  /**
   * 「现在就作为新消息发」—— 已经有一条排队的正在发出去，就排在它后面（队头）。
   * steer 时这一轮已经结束，和控制入口在会话空闲时发，走的都是这一条（按 sessionId 发，不依赖焦点）。
   */
  const sendNowOrNext = useCallback(async (
    sessionId: string, content: string, attachments: AttachedFile[],
    display?: { displayText?: string; pastes?: PastedBlock[] }, ctl?: ControlSendCtx,
  ) => {
    if (queueSendingRef.current.has(sessionId)) {
      const id = ctl ? controlMessageId('queue', undefined, ctl.origin) : `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      ctl?.report({ routed: 'queued', messageId: id });
      setQueuesBySession((prev) => ({
        ...prev,
        [sessionId]: [
          { id, content, attachments, createdAt: Date.now() },
          ...(prev[sessionId] || []),
        ],
      }));
      return;
    }
    const messageId = ctl ? controlMessageId('user', undefined, ctl.origin) : undefined;
    if (ctl) ctl.report({ routed: 'sent', messageId: messageId! });
    queueSendingRef.current.add(sessionId);
    try {
      await sendQueuedMessage(sessionId, content, attachments, display || messageId ? { ...display, ...(messageId ? { messageId } : {}) } : undefined);
    } catch (error: any) {
      // 经控制入口发的那条没发出去：标红那条照样带标记，之后「作为下一条发送」也认得出来
      addFailedSteer(sessionId, content, attachments, String(error?.message || error || ''), carryControlMark(messageId, 'steer'));
    } finally {
      queueSendingRef.current.delete(sessionId);
    }
  }, [sendQueuedMessage, addFailedSteer]);

  /*
    **忙时 Enter 交给谁** —— 主进程按执行器 initialize 的能力声明算好（`main/busyEnterCaps.ts`），随 `session:engine-models`
    推过来（`busyEnter`）。kiro 不用问；Claude Code / Codex 还没收到时现问一次（`acp:engine-models`），问不到就按引擎名兜底。
  */
  const busyEnterRef = useRef<Record<string, string>>({});
  useEffect(() => window.kiroApi.onEngineModels?.((d) => {
    if (d?.sessionId && d.busyEnter) busyEnterRef.current[d.sessionId] = d.busyEnter;
  }), []);
  const busyEnterFor = useCallback(async (sid: string, engine?: string): Promise<string | undefined> => {
    const known = busyEnterRef.current[sid];
    if (known || engineCanSteer(engine)) return known;
    try {
      const d = await window.kiroApi.engineModels?.(sid);
      if (d?.busyEnter) busyEnterRef.current[sid] = d.busyEnter;
      return d?.busyEnter;
    } catch { return undefined; }
  }, []);

  /*
    **已经交给适配器、排在这一轮后面的那几条**（`acp:handoff-prompt`，适配器声明了 promptQueueing）。显示成排队卡片
    「已交给 … ，这一轮结束后执行」，不能编辑 / 撤回（字节已经在 CLI 那边了）。轮到它的时候主进程发 `acp:main-turn`，
    这条消息进对话、卡片撤掉；没轮到它就失败了（`acp:handoff-failed` 带 notStarted）→ 放回 KiroLex 队列队头，不丢。
  */
  const [handoffsBySession, setHandoffsBySession] = useState<Record<string, QueuedMessage[]>>({});
  const handoffsRef = useRef(handoffsBySession);
  handoffsRef.current = handoffsBySession;
  const dropHandoff = useCallback((sid: string, id?: string) => {
    if (!sid || !id) return;
    setHandoffsBySession((prev) => {
      const list = prev[sid];
      if (!list?.some((i) => i.id === id)) return prev;
      const rest = list.filter((i) => i.id !== id);
      const next = { ...prev };
      if (rest.length) next[sid] = rest; else delete next[sid];
      return next;
    });
  }, []);
  useEffect(() => window.kiroApi.onMainTurn?.((d) => {
    if (d?.handoff) dropHandoff(d.sessionId, d.messageId);
  }), [dropHandoff]);
  useEffect(() => window.kiroApi.onHandoffFailed?.((d) => {
    if (!d?.sessionId || !d.messageId) return;
    const sid = d.sessionId;
    const handoffId = d.messageId;
    const card = handoffsRef.current[sid]?.find((i) => i.id === handoffId);
    dropHandoff(sid, handoffId);
    if (!d.notStarted) return;
    /*
      **没轮到它就失败了：放回 KiroLex 队列队头，不丢。** 整条消息主进程随事件带来了（窗口刷新过的话这里已经没有那张卡片）；
      先把队列直接写进 ui-state，再告诉主进程（它把 ui-state 写盘之后才摘掉盘上的记录）。同一条已经放回过就不再放。
    */
    const current = queuesBySessionRef.current;
    const newId = () => carryControlMark(handoffId, 'queue') ?? `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const list = requeueFailedHandoff(current[sid] || [], { ...d, messageId: handoffId }, card, newId);
    if (list !== (current[sid] || [])) {
      const next = { ...current, [sid]: list };
      queuesBySessionRef.current = next;
      try { uiSet(QUEUES_KEY, JSON.stringify(Object.fromEntries(Object.entries(next).filter(([, items]) => items.length)))); } catch { /* 下面的 effect 还会再写 */ }
      const item = list[0];
      setQueuesBySession((prev) => ((prev[sid] || []).some((i) => i.fromHandoff === handoffId) ? prev : { ...prev, [sid]: [item, ...(prev[sid] || [])] }));
    }
    void window.kiroApi.ackHandoffFailed?.(sid, handoffId);
  }), [dropHandoff]);

  /* 上一次运行交给了适配器、却没轮到就退出 / 崩溃了的那几条（主进程 pendingHandoffs.ts）：放回各自会话的 KiroLex 队列头 */
  const pendingHandoffsTakenRef = useRef(false);
  useEffect(() => {
    if (pendingHandoffsTakenRef.current) return;
    pendingHandoffsTakenRef.current = true;
    void window.kiroApi.takePendingHandoffs?.().then((res) => {
      const recover = res?.recover || {};
      const live = res?.live || {};
      /* 主进程还排着的（只是窗口刷新了）：把「已交给 …」卡片画回来 —— 轮到它时照常撤掉，没轮到就失败时照常放回队列 */
      const liveSids = Object.keys(live).filter((sid) => live[sid]?.length);
      if (liveSids.length) {
        setHandoffsBySession((prev) => {
          const next = { ...prev };
          for (const sid of liveSids) {
            const have = new Set((next[sid] || []).map((i) => i.id));
            next[sid] = [...(next[sid] || []), ...live[sid].filter((h) => !have.has(h.id)).map((h) => ({
              id: h.id,
              content: h.content,
              attachments: Array.isArray(h.attachments) ? h.attachments : [],
              ...(Array.isArray(h.pastes) && h.pastes.length ? { pastes: h.pastes } : {}),
              createdAt: Number(h.ts) || Date.now(),
            }))];
          }
          return next;
        });
      }
      const sids = Object.keys(recover).filter((sid) => recover[sid]?.length);
      if (!sids.length) return;
      /*
        放回队列 → 队列直接写进 ui-state → 逐条确认（主进程把 ui-state 写盘之后才摘盘上的记录）。
        确认之前窗口刷新 / 崩溃 / 应用退出：记录还在，下次启动照样放回；已经写进队列的按 fromHandoff 认出来，不放第二遍。
      */
      const current = queuesBySessionRef.current;
      const next = { ...current };
      for (const sid of sids) {
        next[sid] = recoverPendingHandoffs(current[sid] || [], recover[sid],
          (fromId) => carryControlMark(fromId, 'queue') ?? `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      }
      queuesBySessionRef.current = next;
      try { uiSet(QUEUES_KEY, JSON.stringify(Object.fromEntries(Object.entries(next).filter(([, items]) => items.length)))); } catch { /* 下面的 effect 还会再写 */ }
      setQueuesBySession((prev) => {
        const merged = { ...prev };
        for (const sid of sids) {
          const ids = new Set(recover[sid].map((h) => h.id));
          const add = next[sid].filter((i) => i.fromHandoff && ids.has(i.fromHandoff)
            && !(prev[sid] || []).some((p) => p.fromHandoff === i.fromHandoff));
          if (add.length) merged[sid] = [...add, ...(prev[sid] || [])];
        }
        return merged;
      });
      for (const sid of sids) for (const h of recover[sid]) void window.kiroApi.ackHandoffFailed?.(sid, h.id);
    }).catch(() => {});
  }, []);

  const handleSteerMessage = useCallback(async (text: string, pastes?: PastedBlock[], paneSid?: string, ctl?: ControlSendCtx) => {
    const steerSid = paneSid || currentSessionId;
    if (steerSid && loopingIds.includes(steerSid)) return;   // loop owns the session
    // 控制入口发来的：不抢你的焦点（下面全是按 sessionId 发的），也不带走你输入框里的附件
    if (!ctl) await focusSession(steerSid);
    // 带占位符的原文：「重建后发送」那条和「这一轮已结束」直接发出的那条按普通消息的方式显示（占位符 + 粘贴块）。
    const shown = text.trim();
    // Steering carries text only, so a paste must be expanded before it goes out —
    // the placeholder would otherwise reach the model as literal noise.
    if (pastes?.length) text = expandPastes(text, pastes);
    const content = text.trim();
    const sessionId = paneSid || currentSessionId;
    const attachments = ctl ? [] : [...attachedFor(sessionId)];
    if ((!content && attachments.length === 0) || !sessionId) return;
    if (!ctl) clearAttachments(sessionId);

    // A history rebuild is a LOCKED task: it is a hidden turn whose whole purpose
    // is to restore the context, so steering into it would be answered without
    // that context and would never be visible. Park it as "send after rebuild".
    const parkUntilRebuilt = () => {
      const parkedId = ctl ? controlMessageId('queue', undefined, ctl.origin) : `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      ctl?.report({ routed: 'queued', messageId: parkedId });
      setQueuesBySession((prev) => ({
        ...prev,
        [sessionId]: withAfterRebuild(prev[sessionId] || [], {
          id: parkedId,
          content: pastes?.length ? shown : content,
          attachments,
          ...(pastes?.length ? { pastes } : {}),
          createdAt: Date.now(),
          afterRebuild: true,
        }),
      }));
    };
    // 执行器没法把消息插进正在跑的一轮（能力声明里没有 steering，见 main/busyEnterCaps.ts）：忙时 Enter 就是排队 ——
    // 和 ⌘/Ctrl+Enter 同一种卡片，排在队尾，这一轮结束后自动作为下一条发出。不先试 steer、不标红。
    const queueAsNext = () => {
      const queuedId = ctl ? controlMessageId('queue', undefined, ctl.origin) : `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      ctl?.report({ routed: 'queued', messageId: queuedId });
      setQueuesBySession((prev) => ({
        ...prev,
        [sessionId]: [...(prev[sessionId] || []), {
          id: queuedId,
          content: pastes?.length ? shown : content,
          attachments,
          ...(pastes?.length ? { pastes } : {}),
          createdAt: Date.now(),
        }],
      }));
    };
    /*
      交给适配器排在这一轮后面（`busyEnterKind` = handoff：只声明了 promptQueueing，或 steering 出错降级）：
      先放一张「已交给 …」的卡片，再发；没交出去就按原因改走普通发送（这一轮已经结束）或 KiroLex 队列。
    */
    const handOff = async () => {
      const handoffId = ctl ? controlMessageId('user', undefined, ctl.origin) : `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setHandoffsBySession((prev) => ({
        ...prev,
        [sessionId]: [...(prev[sessionId] || []), {
          id: handoffId,
          content: pastes?.length ? shown : content,
          attachments,
          ...(pastes?.length ? { pastes } : {}),
          createdAt: Date.now(),
        }],
      }));
      const r = await handOffMessage(sessionId, content, { attachments, msgId: handoffId, ...(pastes?.length ? { displayText: shown, pastes } : {}) });
      if (r.accepted) { ctl?.report({ routed: 'queued', messageId: handoffId }); return; }
      dropHandoff(sessionId, handoffId);
      if (r.reason === 'idle') {
        noteSessionLocally(sessionId, tRef.current('This turn had already ended, so your message was sent as a new one.'));
        await sendNowOrNext(sessionId, content, attachments, pastes?.length ? { displayText: shown, pastes } : undefined, ctl);
        return;
      }
      queueAsNext();
    };
    const steerEngine = sessions.find((s) => s.id === sessionId)?.engine;
    const enterKind = busyEnterKind(steerEngine, await busyEnterFor(sessionId, steerEngine));
    const canSteer = enterKind !== 'queue';
    const busyRoute = busyEnterRoute({ busy: busyBySessionRef.current[sessionId], canSteer });
    if (busyRoute === 'after-rebuild') { parkUntilRebuilt(); return; }
    if (busyRoute === 'queue') { queueAsNext(); return; }
    if (enterKind === 'handoff') { await handOff(); return; }

    const steerId = ctl ? controlMessageId('steer', undefined, ctl.origin) : undefined;
    const res = await steerMessage(content, sessionId, { attachments, sendText: steerPayload(content, attachments), msgId: steerId });
    if (res.steered) { if (ctl) ctl.report({ routed: 'steer', messageId: steerId! }); return; }
    const route = steerFailureRoute(res.reason);
    if (route === 'after-rebuild') { parkUntilRebuilt(); return; }
    if (route === 'queue') { queueAsNext(); return; }
    if (route === 'handoff') { await handOff(); return; }
    // 这一轮刚好结束、适配器自己起了一轮（Codex）：主进程把那一轮认成这条消息的（acp:main-turn 会把它插进对话）
    if (route === 'handed-off') { if (ctl && res.messageId) ctl.report({ routed: 'sent', messageId: res.messageId }); return; }
    if (route === 'send-now') {
      // The turn already ended: there is no "current turn" to add to, so this IS
      // the next message. Sent straight away unless a queued item is already on
      // its way out — then it goes right behind that one (head of the queue).
      noteSessionLocally(sessionId, tRef.current('This turn had already ended, so your message was sent as a new one.'));
      await sendNowOrNext(sessionId, content, attachments, pastes?.length ? { displayText: shown, pastes } : undefined, ctl);
      return;
    }
    // Anything else: never silently queue. Mark it red on the turn and let the user choose.
    const failedId = addFailedSteer(sessionId, content, attachments, res.reason, ctl ? controlMessageId('steer', undefined, ctl.origin) : undefined);
    ctl?.report({ routed: 'steer', messageId: failedId, steerFailed: res.reason || 'unknown' });
  }, [currentSessionId, sessions, busyEnterFor, attachedFor, clearAttachments, focusSession, steerMessage, handOffMessage, dropHandoff, loopingIds, sendNowOrNext, addFailedSteer]);

  const handleQueueMessage = useCallback((text: string, pastes?: PastedBlock[], paneSid?: string, ctl?: ControlSendCtx) => {
    const content = text.trim();
    const sessionId = paneSid || currentSessionId;
    if (!content || !sessionId) return;
    if (loopingIds.includes(sessionId)) return;   // loop owns the session
    const item: QueuedMessage = {
      id: ctl ? controlMessageId('queue', undefined, ctl.origin) : `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content,
      // 控制入口发来的不带走你输入框里的附件
      attachments: ctl ? [] : [...attachedFor(sessionId)],
      ...(pastes?.length ? { pastes } : {}),
      createdAt: Date.now(),
    };
    ctl?.report({ routed: 'queued', messageId: item.id });
    if (!ctl) clearAttachments(sessionId);
    setQueuesBySession((prev) => ({
      ...prev,
      [sessionId]: [...(prev[sessionId] || []), item],
    }));
  }, [currentSessionId, attachedFor, clearAttachments, loopingIds]);
  // Publish it for handleSendMessage's rebuild diversion (declared above).
  queueMessageRef.current = handleQueueMessage;
  sendMessageRef.current = handleSendMessage;
  handleSteerMessageRef.current = handleSteerMessage;

  /**
   * **控制入口发来的一条**（主进程 `control:send`，见 controlServer.ts 的 `POST /sessions/:id/send`）。
   *
   * 和你在输入框按 Enter **走同一套路由**（`steerRoute.enterRoute`）：空闲就发；这一轮在跑就追加指令
   * （失败照样标红等你选；引擎不支持追加的 Claude Code / Codex 就排队）；重建历史中就「重建后发送」；`mode:'next'` 等于 ⌘/Ctrl+Enter（排队卡片）。
   * 不同的只有：不切你的焦点、不带走你输入框里的附件、消息 id 带标记（气泡上显示「经控制入口发送」）。
   * 一决定走哪条路就回话（`report`），不等这一轮跑完。
   */
  const handleControlSend = useCallback((req: { sessionId: string; text: string; mode: 'auto' | 'next'; origin?: MarkOrigin }): Promise<ControlSendReply> => {
    const sid = req.sessionId;
    const session = sessions.find((s) => s.id === sid);
    // 界面里还没有这条（还在 hydrate）—— 不在主进程里绕过界面直接发
    if (!session) return Promise.resolve({ ok: false, status: 503, error: 'ui-not-ready' });
    if (session.archived) return Promise.resolve({ ok: false, status: 409, error: 'archived' });
    return busyEnterFor(sid, session.engine).then((busyEnter) => {
      const busy = busyBySessionRef.current[sid];
      const route = enterRoute({
        streaming: streamingIds.includes(sid), busy, occupied: isBackendOccupied(busy),
        /* 「能不能不进 KiroLex 队列」：插进当前轮（steer）和交给适配器排（handoff）都走 handleSteerMessage，和输入框一样 */
        looping: loopingIds.includes(sid), next: req.mode === 'next', canSteer: busyEnterKind(session.engine, busyEnter) !== 'queue',
      });
      if (route === 'blocked') return { ok: false, status: 409, error: 'loop-running' } as ControlSendReply;
      return new Promise<ControlSendReply>((resolve) => {
        let done = false;
        // 别的会话发来的（session_send）和经控制入口的走同一套，只是 id 标记不同
        const ctl: ControlSendCtx = { origin: req.origin === 'xs' ? 'xs' : 'ctl', report: (r) => { if (!done) { done = true; resolve({ ok: true, ...r }); } } };
        const run = route === 'steer' ? handleSteerMessage(req.text, undefined, sid, ctl)
          : route === 'queue' ? handleQueueMessage(req.text, undefined, sid, ctl)
          : sendNowOrNext(sid, req.text, [], undefined, ctl);
        Promise.resolve(run).catch(() => {}).finally(() => {
          if (!done) { done = true; resolve({ ok: false, status: 500, error: 'not-routed' }); }
        });
      });
    });
  }, [sessions, busyEnterFor, streamingIds, loopingIds, handleSteerMessage, handleQueueMessage, sendNowOrNext]);
  const controlSendRef = useRef(handleControlSend);
  controlSendRef.current = handleControlSend;
  useEffect(() => {
    const off = window.kiroApi.onControlSend?.((req) => {
      void Promise.resolve()
        .then(() => controlSendRef.current(req))
        .catch((): ControlSendReply => ({ ok: false, status: 500, error: 'renderer-error' }))
        .then((reply) => window.kiroApi.controlSendResult?.(req.reqId, reply));
    });
    void window.kiroApi.controlReady?.();
    return off;
  }, []);

  // Queue actions carry their own session: in split view the pane you clicked in
  // is NOT necessarily the focused chat, and using currentSessionId moved queue
  // items (and their text) into a different conversation.
  const handleCancelQueuedMessage = useCallback((queueId: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (!sid) return;
    const item = (queuesBySessionRef.current[sid] || []).find((candidate) => candidate.id === queueId);
    if (item) {
      addAttachments(sid, item.attachments);
      setRestoredQueueDraft({ id: Date.now(), text: item.content, sessionId: sid });
    }
    setQueuesBySession((prev) => ({
      ...prev,
      [sid]: (prev[sid] || []).filter((candidate) => candidate.id !== queueId),
    }));
  }, [currentSessionId, addAttachments]);

  /**
   * 一条没能追加到这一轮的 steer（标红那条），用户点了两个按钮之一：
   *   'send-next' → 作为**下一条**发送：放到排队最前面（「重建后发送」那几条之后），这一轮一结束就发；
   *   'restore'   → 放回输入框：文字回到这一格的输入框，附件回到附件栏。
   */
  const handleFailedSteer = useCallback((msgId: string, action: 'send-next' | 'restore', paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (!sid) return;
    const hit = takeFailedSteer(sid, msgId);
    if (!hit) return;
    if (action === 'restore') {
      addAttachments(sid, hit.attachments);
      setRestoredQueueDraft({ id: Date.now(), text: hit.content, sessionId: sid });
      return;
    }
    setQueuesBySession((prev) => {
      const queue = prev[sid] || [];
      let at = 0;
      while (at < queue.length && queue[at].afterRebuild) at++;
      const item: QueuedMessage = {
        // 经控制入口发、没能追加进去的那条：作为下一条发送时照样带标记
        id: carryControlMark(msgId, 'queue') ?? `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        content: hit.content,
        attachments: hit.attachments,
        createdAt: Date.now(),
      };
      return { ...prev, [sid]: [...queue.slice(0, at), item, ...queue.slice(at)] };
    });
  }, [currentSessionId, takeFailedSteer, addAttachments]);

  const handleEditQueuedMessage = useCallback((queueId: string, content: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (!sid || !content.trim()) return;
    setQueuesBySession((prev) => ({
      ...prev,
      /* 改的是一张已经试着发过的卡片：那是另一次提交 —— 换新 id（保留控制入口标记）、整批去掉 retryBatch（`editQueuedItem`） */
      [sid]: editQueuedItem(prev[sid] || [], queueId, content.trim(), (oldId) => (
        carryControlMark(oldId, 'queue') ?? `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      )),
    }));
  }, [currentSessionId]);

  const handleMoveQueuedMessage = useCallback((queueId: string, direction: -1 | 1, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (!sid) return;
    setQueuesBySession((prev) => {
      const queue = [...(prev[sid] || [])];
      const from = queue.findIndex((item) => item.id === queueId);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= queue.length) return prev;
      // 「重建后发送」那几条不在排队卡片里，普通卡片不能和它们换位置
      if (queue[from].afterRebuild || queue[to].afterRebuild) return prev;
      const [item] = queue.splice(from, 1);
      queue.splice(to, 0, item);
      return { ...prev, [sid]: queue };
    });
  }, [currentSessionId]);

  /*
    **等待退出期间不排空队列** —— agent-board「拉取并重启」请 KiroLex 退出时，正在跑的那几轮跑完就退；
    排着的消息不再开新一轮（它们落盘在 ui-state 里，重启后原样恢复）。取消等待就照常排空。
  */
  const [quitPending, setQuitPending] = useState(false);
  useEffect(() => {
    void window.kiroApi.getPendingQuit?.().then((p) => setQuitPending(!!p)).catch(() => {});
    return window.kiroApi.onPendingQuit?.(setQuitPending);
  }, []);

  // Drain every session independently when it becomes idle. This continues in
  // the background after the user switches chats, matching MeshClaw slots.
  useEffect(() => {
    if (quitPending) return;
    /* 刷新后先等新建阶段的快照：不然恢复出来的排队消息会抢在「这条会话启动失败了」之前发出去 */
    if (!createStagesLoaded) return;
    for (const [sessionId, queue] of Object.entries(queuesBySession)) {
      if (
        queue.length === 0 ||
        streamingIds.includes(sessionId) ||
        // Backend occupied (turn / attaching / model swap / HISTORY REBUILD).
        // Draining into a rebuild would be rejected by main as "active turn";
        // the queue simply waits until the backend is free.
        isBackendOccupied(busyBySession[sessionId]) ||
        /* 新建的会话还没就绪（或启动失败）：就绪后自动发；失败了等你点「重试 / 改成本机运行」 */
        startupBlocksSend(createStages[sessionId]) ||
        // A loop owns its session, and it is idle BETWEEN iterations — exactly when
        // this drain would fire and slip a queued message between two loop turns.
        loopingIds.includes(sessionId) ||
        queueSendingRef.current.has(sessionId) ||
        /* 上一次没发出去，还在退避期内（远端连不上时不再每次渲染都去捅 attach → preflight） */
        queueBackoffRef.current.blocked(sessionId, Date.now()) ||
        /* 正在自动重发被打断的那一轮：等它发出去，排队的跟在后面（否则会把没答的问题顶掉） */
        recoveringIds.includes(sessionId) ||
        (sessionId === currentSessionId && (
          switchingModel || switchingAgent
        )) ||
        /*
          从磁盘恢复的条目不抢跑（见 `QueuedMessage.restored`）：只有「那一轮还在跑」或者「你正打开着它」
          的时候才发。否则一个几天前排下的队列会在你刚打开应用的那一刻自己发出去。
        */
        (queue[0]?.restored
          && sessionId !== currentSessionId
          && !streamingIds.includes(sessionId)
          && !isBackendOccupied(busyBySession[sessionId]))
      ) continue;

      // 「合并排队消息」只在这里（发送时）生效：关着一张一张发，开着把队首最多 10 张合并成一条（`queueBatch.ts`）。
      // 「重建历史中，结束后发送」的那条单独作为下一条发出，不和后面的排队合并。
      /* 队首是一批没发成的：原样重发（同一批、同一个 id，不看合并开关、不并进后来排的）—— 见 `pickQueuedBatch` */
      const picked = pickQueuedBatch(queue, settings.mergeQueuedMessages && !queue[0].afterRebuild, queuedBatch);
      const consumed = picked.items;
      const consumedIds = new Set(consumed.map((item) => item.id));
      const content = joinQueuedBatch(consumed, (n) => tRef.current('[{n} queued messages merged]', { n }));
      // Placeholders stay in `content` (display/transcript); the delivered prompt
      // gets the expanded text.
      const queuedPastes = consumed.flatMap((item) => item.pastes || []);
      const deliveredContent = queuedPastes.length ? expandPastes(content, queuedPastes) : content;
      // Same file queued twice must not be referenced twice in the file-ref block.
      const attachments = consumed
        .flatMap((item) => item.attachments)
        .filter((file, i, arr) => arr.findIndex((other) => other?.path === file?.path) === i);

      queueSendingRef.current.add(sessionId);
      setQueuesBySession((prev) => ({
        ...prev,
        [sessionId]: (prev[sessionId] || []).filter((item) => !consumedIds.has(item.id)),
      }));
      /*
        **messageId 跟着排队条目走**（`pickQueuedBatch`）：发到一半失败、放回队头再发时还是同一个 id，
        主进程认得出这是同一次提交 —— 已经落过盘的不再追加一条（原来每次现生成，同一条消息在会话里一遍遍出现）。
        经控制入口排进来的那张 id 带标记，发出去时气泡上照样标「经控制入口发送」。
      */
      /* 这一批里有从「交给适配器却没轮到」放回来的：它们原来的 id 跟着发出去、落进 transcript（重启恢复据此不再放回第二遍） */
      const fromHandoff = consumed.map((item) => item.fromHandoff).filter((x): x is string => !!x);
      const sendOpts = {
        ...(queuedPastes.length ? { displayText: content, pastes: queuedPastes } : null),
        messageId: picked.messageId,
        ...(fromHandoff.length ? { fromHandoff } : null),
      };
      Promise.resolve(sendQueuedMessage(sessionId, deliveredContent, attachments, sendOpts))
        .then(() => { queueBackoffRef.current.ok(sessionId); })
        .catch((error) => {
          /* 主进程说这一条已经发过、也答过了：再放回去发多少次都是这个结论 —— 不放回 */
          if (isDuplicateMessageError(String(error?.message || error))) {
            console.warn('Queued message already answered; not re-queued:', error);
            queueBackoffRef.current.ok(sessionId);
            return;
          }
          /* 等一等再试：退避到点叫醒这个 effect（不到点它会跳过这条会话） */
          const now = Date.now();
          const retryAt = queueBackoffRef.current.fail(sessionId, now);
          window.setTimeout(() => setQueueRetryTick((n) => n + 1), Math.max(0, retryAt - now) + 50);
          // The backend remains authoritative. If the original turn (including
          // compaction) was still busy or delivery otherwise failed, restore the
          // exact items at the head and preserve FIFO order.
          console.error('Queued message delivery deferred:', error);
          setQueuesBySession((prev) => {
            const existing = prev[sessionId] || [];
            const existingIds = new Set(existing.map((item) => item.id));
            /* 盖上这一批的 id 和边界（`sealRetryBatch`，跟着队列落盘）：重试完成前不重新分批 */
            const restored = sealRetryBatch(consumed.filter((item) => !existingIds.has(item.id)), picked.messageId);
            return { ...prev, [sessionId]: [...restored, ...existing] };
          });
        })
        .finally(() => {
          queueSendingRef.current.delete(sessionId);
        });
    }
  }, [
    queuesBySession,
    streamingIds,
    busyBySession,
    createStages,
    createStagesLoaded,
    settings.mergeQueuedMessages,
    sendQueuedMessage,
    currentSessionId,
    switchingModel,
    switchingAgent,
    quitPending,
    queueRetryTick,
    recoveringIds,
  ]);

  /*
    **钉住的会话真正闲下来 → 系统通知**（判定见 `idleNotify.ts`）。

    "闲"要把排队算进去：队列非空、或者排队那条正在发（`queueSendingRef`，那条还没开始流式时
    其他状态看起来全是闲的）都算忙。`stepIdle` 要求闲置持续 `IDLE_SETTLE_MS` 才算数，所以这里
    除了状态变化时查一次，还要在它说"再等 N ms"的时候定时再查 —— 那时 ref 里的发送标记可能已经
    清掉了，而清掉它不会触发重渲染。窗口在不在前台由主进程判断。
  */
  const idleTracksRef = useRef<Map<string, IdleTrack>>(new Map());
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const evaluateIdleRef = useRef<() => void>(() => {});
  evaluateIdleRef.current = () => {
    const now = Date.now();
    let recheck: number | null = null;
    const seen = new Set<string>();
    for (const session of sessions) {
      if (!session.id || session.id.startsWith('pending_')) continue;
      seen.add(session.id);
      const sid = session.id;
      const decision = stepIdle(idleTracksRef.current.get(sid), {
        pinned: !!session.pinned && !session.archived,
        busy: streamingIds.includes(sid)
          || (queuesBySessionRef.current[sid]?.length ?? 0) > 0
          || queueSendingRef.current.has(sid)
          || isBackendOccupied(busyBySession[sid])
          || recoveringIds.includes(sid)
          || loopingIds.includes(sid),
        awaitingPermission: !!permissionRequests[sid],
        outcome: turnOutcomeOf(sid),
      }, now);
      idleTracksRef.current.set(sid, decision.track);
      if (decision.recheckInMs !== null) recheck = Math.min(recheck ?? Infinity, decision.recheckInMs);
      if (decision.notify) {
        void window.kiroApi.notifySessionIdle?.({
          sessionId: sid,
          title: displayTitle(settings.language, (session.title || '').trim()) || 'KiroLex',
          body: idleNoticeBody(settings.language, decision.notify),
        }).catch(() => {});
      }
    }
    for (const sid of Array.from(idleTracksRef.current.keys())) {
      if (!seen.has(sid)) idleTracksRef.current.delete(sid);
    }
    if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
    if (recheck !== null) {
      idleTimerRef.current = setTimeout(() => { idleTimerRef.current = null; evaluateIdleRef.current(); }, recheck + 50);
    }
  };
  useEffect(() => {
    evaluateIdleRef.current();
  }, [sessions, streamingIds, queuesBySession, busyBySession, recoveringIds, loopingIds, permissionRequests]);
  useEffect(() => () => { if (idleTimerRef.current) clearTimeout(idleTimerRef.current); }, []);

  // Drop queues whose sessions were deleted or archived.
  useEffect(() => {
    const liveIds = new Set(sessions.filter((session) => !session.archived).map((session) => session.id));
    setQueuesBySession((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([sessionId]) => liveIds.has(sessionId)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [sessions]);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = uiGet('kirolex-sidebar-width');
      if (saved) return parseInt(saved, 10);
    } catch {}
    return 240;
  });
  /* 左侧会话栏收没收起 —— 「重启后恢复界面状态」开着时活过重启（见 `uiRestore`） */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => restoreGet('kirolex-sidebar-hidden') === '1');
  useEffect(() => { restoreSet('kirolex-sidebar-hidden', sidebarCollapsed ? '1' : null); }, [sidebarCollapsed]);
  const isResizingRef = useRef(false);
  // Resizable width for the right-side file panel (drag its left edge).
  const [fileViewerWidth, setFileViewerWidth] = useState(() => {
    try {
      const saved = uiGet('kirolex-fileviewer-width');
      if (saved) return parseInt(saved, 10);
    } catch {}
    return 520;
  });
  /*
    **右侧文件 / comment 栏最宽能到多少** ——「windows 版本的 comment 栏似乎可以无限往左拉压缩左侧会话和侧栏的空间」。
    原来只有一个固定上限 1100px：窗口一宽（Windows 上常见的 1920 逻辑像素），1100 就挤得动左边 ——
    会话区被压到几十像素、侧栏也跟着被压窄。上限改成**跟着窗口走**：窗口宽 − 侧栏（开着时）− 会话区至少留的那么宽，
    不再另外封顶 1100（大窗口里它先卡住，会话区留着 500 多 px 也拉不动，见 panelFit.ts 的 filePanelMax）。
    拖的时候按它夹，窗口变窄 / 侧栏打开时显示也按它夹（存的宽度不动，窗口再变宽就回到你拖的那个宽度）。
  */
  /*
    **右侧预览栏可以藏起来** ——「预览侧栏现在没有隐藏按钮，这个就很不方便」。原来只有一个 ✕，而它关掉的是
    **所有标签**（连同每份文件的 comment 状态入口）。藏起来只是不占地方：标签都留着，右边缘那条点一下就回来；
    从会话里再点开一个文件也会把它放出来。跟着「重启后恢复界面状态」一起记。
  */
  const [fileViewerHidden, setFileViewerHidden] = useState(() => restoreGet('kirolex-fileviewer-hidden') === '1');
  useEffect(() => { restoreSet('kirolex-fileviewer-hidden', fileViewerHidden ? '1' : null); }, [fileViewerHidden]);
  const [winWidth, setWinWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  /*
    **窗口放不下时两边的栏临时让位** —— 界面缩放调大以后（1024 宽的窗口开 200% 只剩 512 CSS px），
    侧栏 + 预览栏的最低宽度会把聊天区挤没。这里只算「这一刻要不要临时收起」，不改、不存用户自己的开关；
    用户在当前宽度下亲手点开的那一栏（panelPins，记的是点开时的窗口宽度）不收。规则见 panelFit.ts。
  */
  const [panelPins, setPanelPins] = useState<{ sidebarAt: number | null; previewAt: number | null }>({ sidebarAt: null, previewAt: null });
  const autoFold = autoFoldPanels({
    winWidth,
    sidebarWidth,
    sidebarCollapsed,
    previewOpen: !!(fileViewerLoading || fileViewer) && !fileViewerHidden,
    previewWidth: FILE_PANEL_MIN,
    pinnedSidebar: panelPins.sidebarAt === winWidth,
    pinnedPreview: panelPins.previewAt === winWidth,
  });
  const sidebarHidden = sidebarCollapsed || autoFold.sidebar;
  const previewHidden = fileViewerHidden || autoFold.preview;
  const previewOwnsFind = findOwner({ previewShown: !!fileViewer && !previewHidden, focusInPreview }) === 'preview';
  const fileViewerMax = filePanelMax({ winWidth, sidebarShownWidth: sidebarHidden ? 0 : sidebarWidth, chatMin: CHAT_MIN_WIDTH, panelMin: FILE_PANEL_MIN });
  const fileViewerShown = Math.min(fileViewerWidth, fileViewerMax);
  const handleFileResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = Math.min(fileViewerWidth, fileViewerMax);
    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      // Panel sits on the RIGHT: dragging the left edge leftwards widens it.
      const newWidth = Math.max(FILE_PANEL_MIN, Math.min(fileViewerMax, startWidth + startX - ev.clientX));
      setFileViewerWidth(newWidth);
    };
    const onMouseUp = () => {
      isResizingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [fileViewerWidth, fileViewerMax]);
  useEffect(() => {
    try { uiSet('kirolex-fileviewer-width', String(fileViewerWidth)); } catch {}
  }, [fileViewerWidth]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = Math.max(160, Math.min(500, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        uiSet('kirolex-sidebar-width', String(sidebarWidth));
      } catch {}
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  // Save sidebar width when it changes
  useEffect(() => {
    try {
      uiSet('kirolex-sidebar-width', String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);

  /** One split pane = one fully interactive chat. Every prop is scoped to `sid`
   *  (messages, model, queue, attachments, permission request), and the write
   *  handlers focus that session first so the send pipeline stays single-path. */
  /** Per-pane fork/rerun callbacks with a STABLE identity.
   *
   *  These two are the only App callbacks handed to the MEMOISED message items, and as
   *  inline arrows (`onForkMessage={(id) => handleForkMessage(id, sid)}`) they were new
   *  on every App render -- so `memo` bailed out and all rendered groups re-rendered,
   *  markdown and syntax highlighting included. That happened on every focus switch and
   *  on every chunk arriving in ANY pane, which is the re-render Yinan kept seeing.
   *
   *  Created once per session id and never replaced; the current implementations are
   *  read through a ref, so a stable wrapper can never call a stale closure. */
  const paneCallbacksRef = useRef(new Map<string, { onFork: (messageId: string) => void; onRerun: (messageId: string, editedText: string) => void }>());
  const latestMessageApiRef = useRef({ handleForkMessage, handleRerunMessage });
  // No dep array: refresh after EVERY render, which is still before any user event can
  // fire one of the wrappers.

  /**
   * 校验一有问题就告诉那个会话 —— 「你需要让会话也知道报错」。
   *
   * 报错原来只画给人看:模型不知道「S7 产出的 ext:采集覆盖报告没人读」,你在那条对话里说「修一下」它只能猜,
   * 除非你手动按画布上那个「让它修」—— 最需要说话的时候会话恰好全聋。这里补上:有问题就发,一版结构只发一次。
   *
   * 等 1.2 秒再发:你在面板里改一个字就是一版新指纹,不缓一下就变成边打字边发提示词。
   */


  useEffect(() => { latestMessageApiRef.current = { handleForkMessage, handleRerunMessage }; });
  const paneMessageCallbacks = useCallback((sid: string | null) => {
    const key = sid ?? '__none__';
    const cache = paneCallbacksRef.current;
    let entry = cache.get(key);
    if (!entry) {
      entry = {
        onFork: (messageId: string) => latestMessageApiRef.current.handleForkMessage(messageId, sid || undefined),
        onRerun: (messageId: string, editedText: string) => latestMessageApiRef.current.handleRerunMessage(messageId, editedText, sid || undefined),
      };
      cache.set(key, entry);
    }
    return entry;
  }, []);


  const renderPane = (sid: string | null, wantFocused: boolean, withHeader: boolean, paneStyle?: React.CSSProperties) => {
    /**
     * 「聚焦」这件事只能由 `currentSessionId` 说了算 —— 「这个会话里为什么会出现 flow 会话的内容」。
     *
     * `focused=true` 的含义是「这一格渲染的是 hook 里那份**当前焦点会话**的 messages」(它是活的流)。
     * 而几个调用点是硬写 `true` 的:`renderPane(panes[0] || currentSessionId, true, …)`。一旦这两者不是同一条
     * 会话 —— 比如画布/注册刚把焦点切到 flow 会话,而这一格画的还是 `panes[0]` —— 那一格就会顶着**你这条会话
     * 的标题**,肚子里装着**flow 会话的消息**。这就是内容串台。
     *
     * 所以这里把它校正:声称聚焦但 id 不对,就按后台格渲染(读它自己的 paneViews/缓存)。调用点写错不再能
     * 造成串台,最多是这一格少一点实时性。
     */
    const focused = wantFocused && !!sid && sid === currentSessionId;
    const session = sid ? sessions.find((s) => s.id === sid) || null : null;
    // Stable identities, so the memoised message items can actually skip a re-render.
    const messageCallbacks = paneMessageCallbacks(sid);
    // `paneFallback` is not a nicety: on the render where focus LEAVES this chat its
    // PaneView does not exist yet (setPaneSessions runs in an effect), and the old
    // `paneViews[sid]` alone made the pane render as an EMPTY conversation for one
    // commit -- tearing down and re-creating every transcript row. See paneFallback.
    const view = sid && !focused ? (paneViews[sid] || paneFallback(sid)) : undefined;
    // `?? EMPTY_MESSAGES`, never `|| []`: a fresh [] each render is a new identity, and
    // identity is exactly what keeps the transcript from re-rendering. See paneFallback.
    const paneMessages = focused ? messages : (view?.messages ?? EMPTY_MESSAGES);
    const paneModel = focused
      ? selectedModel
      : ((session?.model && session.model !== 'auto') ? session.model : selectedModel);
    const inner = (
      <ChatArea
        paneFocused={focused}
        findSuspended={previewOwnsFind}
        messages={paneMessages}
        // A history rebuild is a real, cancellable operation even though its turn is
        // hidden: without counting it here the composer showed no Stop button at
        // all, so the rebuild (and any pending auto-resend) could not be called off.
        //
        // `busyBySession[sid] === 'turn'` is the AUTHORITATIVE half. `streamingIds`
        // is renderer state, so it is wiped by any reload of this window -- an HMR
        // update during a live turn was enough. The composer then believed the turn
        // had ended: Enter stopped steering and sent a NEW message instead, which
        // main rejected ("wait for the active turn") after the bubble was already on
        // screen. Main always knows whether a turn is running; ask it too.
        // 判据在 steerRoute.composerRunning —— 控制入口的 send 用同一个（`enterRoute`）
        isStreaming={!!sid && composerRunning(streamingIds.includes(sid), busyBySession[sid])}
        status={status}
        sessionConnected={!!sid && attachedSessionIds.includes(sid) && !connectingSessionIds.includes(sid)}
        readySessionIds={readySessionIds}
        // Per CHAT, not per focus. Previously this was one app-wide string shown only
        // in the focused pane, so a failure in chat A appeared over chat B once focus
        // moved, and every focus switch mounted the banner in one pane and unmounted it
        // in another -- both transcripts changed height in the same frame, which is the
        // flash seen when clicking between panes. A pane with no chat yet shows the
        // app-level bucket (a backend connect can fail before any session exists).
        connectionError={(sid ? errorBySession[sid] : errorBySession[APP_ERROR_KEY]) || null}
        onDismissError={() => clearSessionError(sid)}
        turnInterrupted={!!sid && interruptedSessionIds.includes(sid)}
        attachedFiles={attachedFor(sid)}
        models={modelsFor(session)}
        selectedModel={paneModel}
        activeToolCall={focused ? activeToolCall : (view?.activeTool || null)}
        activityStatus={focused ? activityStatus : (view?.activity || null)}
        stall={focused ? turnStall : (view?.stall || null)}
        permissionRequest={sid ? permissionRequests[sid] || null : null}
        onRespondPermission={respondPermission}
        usage={focused ? usage : (view?.usage || null)}
        // Mirrored per pane like `usage`/`stall`: a plan belongs to a chat, not to
        // whichever pane has focus. Reading it from the focused chat only meant the
        // panel appeared in one pane and vanished from another on every focus switch.
        plan={focused ? plan : (view?.plan || EMPTY_PLAN)}
        autoFoldThinking={settings.autoFoldThinking}
        autoFoldTools={settings.autoFoldTools}
        onManageContext={() => setUsageActionConfirm('contextMenu')}
        onResetCredits={() => setUsageActionConfirm('resetCredits')}
        commands={focused ? commands : EMPTY_COMMANDS}
        onModelChange={(model) => { void handleModelChange(model, sid || undefined); }}
        /* 跑在哪台机器上 —— 命令/文件面板上那个 🌐 用的就是它（和侧栏徽标同一份事实：
           跟着会话状态走。跟着同步状态走的那一版，切回本地之后 🌐 还挂着）。 */
        remoteHost={session?.remoteHost}
        /* 这条会话在哪棵树上干活 —— 常驻显示在输入框下面那一排，点它换目录 */
        kiroAgent={session?.kiroAgent || selectedKiroAgent}
        engine={session?.engine}
        kiroAgents={agentsFor(session)}
        switchingAgent={focused && switchingAgent}
        switchingModel={focused && switchingModel}
        permissionMode={session?.permissionMode || 'auto-approve'}
        onPermissionModeChange={(mode) => { void handlePermissionModeChange(mode, sid || undefined); }}
        /* 忙时选的、这一轮跑完再切的那些（agent / 模型 / 权限 / 引擎 / 组合 / 运行位置） */
        pendingSwitch={sid ? pendingSwitches[sid] : undefined}
        pendingSwitchSince={sid ? pendingSwitchSince[sid] : undefined}
        onCancelPendingSwitch={(kind) => { if (sid) void cancelPendingSwitch(sid, kind); }}
        /* 这条会话当前还在跑的子代理 —— 侧栏那个 `🤖 N` 用的是同一份数据，只是它只有 tooltip。
           会话里原来只能看到子代理**说过的话**，看不到"现在有几个在跑、各自卡在哪"。 */
        subagents={sid ? (subagents[sid] || []) : []}
        memoryWarnings={memoryWarnings({
          projectId: session?.projectId,
          sessionId: sid || undefined,
          bytes: {
            global: memoryBytes.global,
            project: session?.projectId ? (memoryBytes.project[session.projectId] ?? 0) : 0,
            session: sid ? (memoryBytes.session[sid] ?? 0) : 0,
          },
          lang: settings.language,
        })}
        compactingMemoryScope={compactingMemory}
        onCompactMemory={(scope) => {
          if (sid) void compactMemory(scope, sid, session?.projectId);
        }}
        onOpenMemory={(scope) => {
          setMemoryTarget(scope ? { sessionId: sid || undefined, projectId: session?.projectId, scope } : null);
          setShowMemory(true);
        }}
        onKiroAgentChange={(agentName) => { void handleKiroAgentChange(agentName, sid || undefined); }}
        onForkMessage={messageCallbacks.onFork}
        onRerunMessage={messageCallbacks.onRerun}
        onSend={(text, pastes) => { void handleSendMessage(text, pastes, sid || undefined); }}
        onSteerMessage={(text, pastes) => { void handleSteerMessage(text, pastes, sid || undefined); }}
        onCancel={() => { void handleStopStream(sid || undefined); }}
        onDropFiles={(files) => handleDropFiles(files, sid || undefined)}
        onRemoveFile={(id) => handleRemoveFile(id, sid || undefined)}
        currentSessionId={sid}
        isArchived={!!session?.archived}
        onUnarchive={() => { if (sid) archiveSession(sid, false); }}
        queuedMessages={sid ? queuesBySession[sid] || EMPTY_QUEUE : EMPTY_QUEUE}
        handedOffMessages={sid ? handoffsBySession[sid] || EMPTY_QUEUE : EMPTY_QUEUE}
        mergeQueuedMessages={settings.mergeQueuedMessages}
        /**
         * 「还没读出来」和「真的没有内容」要分开 —— 「这个会话为什么在分屏显示是空的」。
         *
         * 后台格的内容来自 `paneViews[sid]`,而它由 `setPaneSessions` 在**效果里**去读磁盘:比这一次渲染晚
         * 一个提交。于是这一格会先空一帧,而 `historyLoading` 那时还是 false —— 看着就是「空的」。
         * (在我把「借用焦点会话的 messages」堵掉之前,这一帧是用**别人的**内容填的,所以看不见。)
         *
         * 判据是「这一格这一轮还没有 view」:读完之后 view 就存在了(哪怕是空对话),提示自然消失,
         * 所以一条真的没有消息的会话不会一直转圈。
         */
        historyLoading={!!sid && (historyLoadingIds.includes(sid) || (!focused && !paneViews[sid]))}
        restoredQueueDraft={restoredQueueDraft}
            /* 交接是一次性的：接走就清（按 id 认）—— 不清就会每次输入框挂载重放一遍 */
            onConsumeRestoredDraft={(id) => setRestoredQueueDraft((cur) => consumeHandoff(cur, id))}
            onConsumeRestoredInputDraft={consumeRestoredInputDraft}
        restoredInputDraft={restoredInputDraft}
        onQueueMessage={(text, pastes) => handleQueueMessage(text, pastes, sid || undefined)}
        onCancelQueuedMessage={(queueId) => handleCancelQueuedMessage(queueId, sid || undefined)}
        onFailedSteer={(msgId, action) => handleFailedSteer(msgId, action, sid || undefined)}
        onEditQueuedMessage={(queueId, content) => handleEditQueuedMessage(queueId, content, sid || undefined)}
        onMoveQueuedMessage={(queueId, direction) => handleMoveQueuedMessage(queueId, direction, sid || undefined)}
        importableSessions={sessions
          .filter((s) => s.id !== sid && !s.id.startsWith('pending_') && !s.archived)
          .map((s) => ({ id: s.id, title: s.title }))}
        contextLinks={focused ? contextLinks : (view?.contextLinks || EMPTY_LINKS)}
        onToggleContextSource={(sourceId) => toggleContextSource(sourceId, sid || undefined)}
        isLooping={!!sid && loopingIds.includes(sid)}
        onStartSchedule={(spec) => { if (sid) void createSchedule(sid, spec); }}
        scheduleSummary={scheduleSummaryFor(sid)}
        onPauseSchedule={(id, paused) => void pauseSchedule(id, paused)}
        onCancelSchedule={(id) => void cancelSchedule(id)}
        onSetScheduleExpiry={(id, change) => setScheduleExpiry(id, change)}
        bgJobs={bgJobsFor(sid)}
        startup={sid ? createStages[sid] || null : null}
        onRetryStartup={(local) => { if (sid) void retryCreateSession(sid, { local }); }}
        onStopBgJob={(jobId) => void stopBgJob(jobId)}
        onStopLoop={() => { if (sid) void stopLoop(sid); }}
      />
    );
    if (!withHeader) return inner;
  return (
      <div
        key={sid || 'empty'}
        className={`chat-pane${focused ? ' focused' : ''}`}
        data-accent-engine={accentEngine(session?.engine)}
        style={paneStyle}
        // Clicking anywhere in a pane (including its composer) focuses that
        // session, so Enter always sends to the pane you are looking at.
        onMouseDownCapture={(e) => {
          // Header buttons (✕) must not trigger a session switch: switching
          // re-renders this subtree and the follow-up click was getting lost,
          // which is why a pane sometimes could not be closed.
          if ((e.target as HTMLElement).closest('.chat-pane-header')) return;
          void focusSession(sid);
        }}
      >
        <div className="chat-pane-header">
          {/* 引擎徽标：颜色之外同时有图标和引擎名（色弱也分得清） */}
          {session && (
            <span className="engine-badge" title={engineLabel(session.engine)}>
              <EngineBadgeIcon engine={session.engine} />
              <span className="engine-badge-name">{engineLabel(session.engine)}</span>
            </span>
          )}
          <span className="chat-pane-title" title={displayTitle(settings.language, session?.title)}>{displayTitle(settings.language, session?.title) || t('Untitled')}</span>
          <button
            className="chat-pane-btn"
            title={t('Remove from split view')}
            // pointerdown, not click: acting before any re-render means the
            // close can never be swallowed by a concurrent focus switch.
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); if (sid) toggleSplitSession(sid); }}
            onClick={(e) => { e.stopPropagation(); }}
          >✕</button>
        </div>
        {inner}
      </div>
    );
  };

  /** The empty-cell strip that advertises free split capacity.
   *
   *  It used to read just "＋ 加入分屏", which says what the cell IS but not what to
   *  DO -- the action (click a chat in the sidebar) happens somewhere else entirely,
   *  so the strip has to name it. Also states how many slots are left, since that
   *  is the one fact the strip is uniquely placed to report. */
  const renderAddStrip = (horizontal: boolean, style?: React.CSSProperties) => {
    const remaining = Math.max(0, splitCapacity - panes.length);
    const tip = [
      t('This pane is empty.'),
      t('Put a chat here: click any chat in the list on the left, or right-click it and pick “⇆ Add to split”.'),
      // Deliberately does NOT restate the layout: it reported the CONFIGURED grid
      // (e.g. 2x2) while the panes on screen were arranged 1x2, so it contradicted
      // what the user could see. The remaining-slots count below is the honest part.
      t('Room for {n} more chats.', { n: remaining }),
      t('Remove a pane: click the ✕ at its top-right, or right-click the chat and pick “⇆ Remove from split”.'),
      t('Resize: drag the divider between panes; double-click a divider to even them out.'),
      t('Change the layout: Settings → Split layout.'),
      t('Every pane is a full chat, each with its own composer, queue and attachments.'),
    ].join('\n');
    return (
      <div
        className={`chat-pane-add${horizontal ? ' horizontal' : ''}${style ? ' cell' : ''}`}
        title={tip}
        style={style}
      >
        <span className="chat-pane-add-plus">＋</span>
        <span className="chat-pane-add-label">
          {horizontal ? t('Click any chat in the list on the left to put it in this pane') : t('Click a chat on the left to fill this pane')}
        </span>
        <span className="chat-pane-add-hint">{t('{n} more can go here', { n: remaining })}</span>
      </div>
    );
  };

  return (
    <LangProvider lang={settings.language}>
      {/* 按引擎区分的强调色（设置「按引擎区分颜色」，见 engineTheme.ts）：给挂了 data-accent-engine 的元素定义 --engine-accent* */}
      <style>{engineAccentCss(settings.engineAccents !== false)}</style>
      {/* One line, because 「什么都没出现」 is the one thing a registration must never do silently. */}
      <div className={`app-layout no-toolbar${isMac ? ' mac' : ''}${isWinFrame ? ' win' : ''}${isWinFrame && winMaxed ? ' maxed' : ''}`}>
        {isMac && <div className="mac-titlebar" />}
        {/* 拖它移动窗口、双击最大化 / 还原（系统行为）；右边留给系统画的最小化 / 最大化 / 关闭 */}
        {isWinFrame && winMaxed && !titlebarShown && <div className="win-titlebar-hotzone" onMouseEnter={revealTitlebar} />}
        {isWinFrame && (
          <div
            className={`win-titlebar${winMaxed ? ' auto-hide' : ''}${winMaxed && titlebarShown ? ' shown' : ''}`}
            onMouseEnter={winMaxed ? revealTitlebar : undefined}
            onMouseLeave={winMaxed ? scheduleHideTitlebar : undefined}
          >
            <span className="win-titlebar-title">KiroLex</span>
            <div className="win-titlebar-controls">
              <button className="win-ctl" onClick={() => windowControl('minimize')} title={t('Minimize')} aria-label={t('Minimize')}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
              </button>
              <button className="win-ctl" onClick={() => windowControl('toggle-maximize')} title={winMaxed ? t('Restore') : t('Maximize')} aria-label={winMaxed ? t('Restore') : t('Maximize')}>
                {winMaxed
                  ? <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 0.5h7v7M0.5 2.5h7v7h-7z" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
                  : <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>}
              </button>
              <button className="win-ctl win-ctl-close" onClick={() => windowControl('close')} title={t('Close')} aria-label={t('Close')}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" /></svg>
              </button>
            </div>
          </div>
        )}
        <Toasts />
        {/* local_browser：新域名第一次打开前问用户（允许一次 / 本会话内允许 / 拒绝） */}
        <BrowserDomainPrompt sessionTitle={(sid) => displayTitle(settings.language, sessions.find((s) => s.id === sid)?.title)} />
        {!sidebarHidden && (
          <div style={{ width: sidebarWidth, flexShrink: 0 }}>
            <Sidebar
              sessions={sessions}
              projects={projects}
              // `highlightSessionId`, not `currentSessionId`: after the last pane is
              // closed nothing is focused (on purpose), and the row you were on must
              // stay highlighted so you can click straight back into it.
              currentSessionId={highlightSessionId}
              status={status}
              streamingSessionIds={streamingIds}
              attachedSessionIds={attachedSessionIds}
              busyBySession={busyBySession}
              connectingSessionIds={connectingSessionIds}
              failedSessionIds={failedSessionIds}
              unreadSessionIds={unreadSessionIds}
              subagentsBySession={subagents}
              /* 先问名字再建 —— 建完才问就得再改一次，而"这次跑的是什么"通常在你点它之前就知道了 */
              executorCap={executorCap}
              onNewSession={() => { setNewChatProject(''); setNewChatNewProjectName(''); setShowNewChat(true); }}
              onCreateProject={createProject}
              onReorderProjects={reorderProjects}
              onNewSessionInProject={handleNewSessionInProject}
              onRenameProject={renameProject}
              onDeleteProject={handleDeleteProject}
              onSwitchSession={handleSwitchSession}
              onDeleteSession={handleDeleteSession}
              onRebuildContext={(id, mode) => { void rebuildContext(id, mode); }}
              onRenameSession={renameSession}
              onTogglePin={togglePin}
              // Only the EXPLICIT selection highlights rows. In single-chat mode
              // `panes` falls back to the focused chat, which must not look selected.
              /**
               * 只有**真的在分屏**时才有序号 —— 「为什么不分屏也有序号？」
               *
               * `panes` 在没分屏时会回落成 `[当前会话]`(单格模式下要渲染的就是它),所以直接拿 panes 编号,
               * 会给那个唯一的会话编上 ①:一个只有一格的「分屏」序号,毫无意义。判据是 splitSessionIds ——
               * 那才是「你挑了哪几个摆在一起」。全页视图不再清空它,所以进 flow 期间序号照样显示。
               */
              splitOrder={(id) => {
                if (splitSessionIds.length === 0) return 0;
                const i = panes.indexOf(id);
                return i < 0 ? 0 : i + 1;
              }}
              onToggleSplit={(id) => toggleSplitSession(id)}
              scheduleFor={scheduleSummaryFor}
              onAssignProject={assignProject}
              onMoveSession={moveSession}
              onReorderSessions={reorderSessions}
              onArchiveSession={archiveSession}
              onSettings={() => { setSettingsTab(undefined); setSettingsNewMachine(false); setShowSettings(true); }}
              onAddMachine={() => { setSettingsTab('machines'); setSettingsNewMachine(true); setShowSettings(true); }}
              onRetargetPending={retargetPendingSession}
              /*
                ☁️ 只管**恢复** ——「这个云按钮只保留恢复，这个界面应该展示所有已经备份的会话，
                然后留一个多选/恢复按钮即可」。配置回到 设置 → ☁️ 备份。
              */
              onOpenBackup={() => setShowBackup(true)}
              backupState={backupState}
              workspaceOpen={showWorkspace}
              onOpenWorkspace={() => setShowWorkspace((visible) => !visible)}
              onOpenLogs={() => void handleOpenLogs()}
              onOpenMemory={() => setShowMemory(true)}
              // Flow 面板只列注册的 flow，所以这里不再去读 ~/.kiro/skills（那一块已从面板上撤掉）
              /**
               * OPENING AN IDLE PROJECT IS WHAT CONNECTS IT.
               *
               * Startup no longer warms projects untouched for a week (`projectActivity`), so this is
               * where their executors come from: 「等用户点开project再创建连接」. Best-effort and bounded by
               * the backend cap — a failure leaves the chat dormant, which is what clicking it fixes.
               */
              /**
               * 这个 project 现在有哪些 flow,以及哪些的定义已经被删了 —— 「为啥 flow 都删了 project 里面还是这些配置？」
               * 带状和这里都是从 run 推出来的,而删 flow 删的是注册表:不比一下,删掉的 flow 会一直以配置的身份挂着。
               */
              /* 这个 project 在哪儿干活 —— 菜单里显示当前值 */
              projectWorkspace={(project: string) => projectWorkspaces[project] || ''}
              /**
               * 改工作目录 —— 主进程校验（不存在 / 不是目录 / 不是绝对路径都当场说）。
               *
               * 用 prompt 而不是一个新对话框:这是一行绝对路径,而且改它的频率是「一个 project 一次」。
               * 改完清掉 cwd 缓存,否则下一条会话还起在旧目录里。
               */
              onSetProjectWorkspace={(project: string) => {
                void (async () => {
                  const now = projectWorkspaces[project] || '';
                  const next = window.prompt(
                    t('Which folder should chats in "{project}" work in?\n\nLeave empty = your home folder. An absolute path = every chat in this project (including each flow step) runs there.', { project }),
                    now,
                  );
                  if (next === null) return;
                  const res = await window.kiroApi.projectSetWorkspace?.(project, next.trim());
                  if (!res?.ok) { showToast(t('Could not set it: {reason}', { reason: res?.error || t('unknown reason') })); return; }
                  projectCwdCache.current.delete(project);
                  setProjectWorkspaces((cur) => ({ ...cur, [project]: next.trim() }));
                })();
              }}
              /**
               * 移出一个 flow —— 两种情况,两种后果,都当场说清。
               *
               * 定义还在:只是**移出**(写名单)。历史一条不动,而它的主会话从此可删 —— 删主会话才是
               * 「一并删历史」那个决定(`flowMainDeletion`)。
               * 定义已经没了:这个 project 里没有主会话可作锚(SFDC 那三条就是),所以这里直接删历史,
               * 进回收站、报条数。
               */
              /**
               * 主会话删不删得动,由「这个 project 还在用这个 flow 吗」决定 —— 不再使用 = 移出了,或者定义已经没了。
               * 删得动的时候,删它就一并把这个 flow 在这个 project 里的运行历史带走(主进程那边级联,进回收站)。
               */
              /**
               * 展开一个 project = 预热它的会话 —— 「为什么我点开一个之前的项目没有自动预热」。
               *
               * 这里原来只 `loadSession` 了一下:后端可能连上了,但没有登记 attach、也没有 ensureContext,
               * 所以界面上那个点一直不变、历史也没被核对 —— 看着就是没预热。`warmSession` 走的是
               * `switchSession` 里那一整套(连接中 → load → attach → 核对历史)。
               */
              onWarmProject={(project) => {
                for (const s of sessions) {
                  if ((s.projectId || '') !== project || s.archived) continue;
                  void warmSession(s.id);
                }
              }}
              /**
               * ▸ 打开这个 project：有正在跑的就直接进运行视图，没有才落回工作台。
               * 「只把在运行中的skill归属到project」—— project 里最该先看见的就是它在跑什么。
               */
              // Agent config is global: one trigger in the sidebar, handled by the
              // focused pane so a split view never opens several editors.
            />
          </div>
        )}
        <div className="sidebar-resize-area">
          {!sidebarHidden && (
            <div className="sidebar-resize-handle" onMouseDown={handleResizeStart} />
          )}
          <button
            className="side-collapse-btn sidebar-collapse-btn"
            onClick={() => {
              // 点开时记下当前宽度：窗口放不下时这一栏也不被自动收回去（panelPins）
              if (sidebarHidden) { setSidebarCollapsed(false); setPanelPins((p) => ({ ...p, sidebarAt: winWidth })); }
              else setSidebarCollapsed(true);
            }}
            title={sidebarHidden ? t('Show sidebar') : t('Hide sidebar')}
          >
            {sidebarHidden ? '▶' : '◀'}
          </button>
        </div>
        {/*
          THE CANVAS IS THE SKILL SESSION'S VIEW, so it is shown only while that session is in front.
          Rendered from 「有草稿」 alone it kept the whole main area after switching chats — 「切到别的会话
          之后为什么这个界面还会显示」.
        */}
        {!splitActive ? (
          // With nothing assigned AND nothing focused this resolves to null, i.e. the
          // ordinary opening screen -- which is where closing the last pane lands.
          renderPane(panes[0] || currentSessionId, true, false)
        ) : (
          // Nested flex: a column of rows, each row its own set of panes. Dividers
          // are real elements between them, so every split is draggable and the
          // "add" strip can sit in just the free corner instead of claiming the
          // whole right edge (a CSS grid forced every row to share columns).
          <div className="chat-grid">
            {paneRowsOfPanes.map((rowPanes, r) => (
              <React.Fragment key={`split-row-${r}`}>
                {r > 0 && (
                  // Always rendered: it also draws the hairline between rows. The
                  // switch only decides whether it is DRAGGABLE.
                  <div
                    className={`pane-resize-handle horizontal${dragSplits ? '' : ' locked'}`}
                    title={dragSplits ? t('Drag to resize (double-click to even out)') : t('Pane dragging is turned off in Settings')}
                    onMouseDown={dragSplits ? (e) => handlePaneResizeStart(e, 'row', 0, r - 1) : undefined}
                    onDoubleClick={dragSplits ? () => setSplitSizes((cur) => resetSplitSizes(cur, splitShape)) : undefined}
                  />
                )}
                <div className="chat-row" style={{ flexGrow: rowFlex(r), flexBasis: 0 }}>
                  {rowPanes.map((sid, c) => (
                    <React.Fragment key={sid || `split-pane-${r}-${c}`}>
                      {c > 0 && (
                        <div
                          className={`pane-resize-handle vertical${dragSplits ? '' : ' locked'}`}
                          title={dragSplits ? t('Drag to resize width (double-click to even out)') : t('Pane dragging is turned off in Settings')}
                          onMouseDown={dragSplits ? (e) => handlePaneResizeStart(e, 'col', r, c - 1) : undefined}
                          onDoubleClick={dragSplits ? () => setSplitSizes((cur) => resetSplitSizes(cur, splitShape)) : undefined}
                        />
                      )}
                      {renderPane(sid, sid === currentSessionId, true, {
                        flexGrow: colFlex(r, c),
                        flexBasis: 0,
                      })}
                    </React.Fragment>
                  ))}
                  {/* Free capacity to the RIGHT of a row is a slim strip, so the chat
                      in this row uses the full width. The cost is accepted knowingly:
                      filling this cell later halves that pane, and its right edge does
                      not line up with the divider above until then. A fully empty ROW
                      is the opposite case -- see the placeholder row below. */}
                  {stripRight && r === paneRowsOfPanes.length - 1 && renderAddStrip(false)}
                </div>
              </React.Fragment>
            ))}
            {/* Free capacity is ALWAYS a slim strip, below just as much as to the right:
                the panes on screen keep their full size and nothing moves when one is
                added. An earlier version had a fully empty row reserve a real row's
                height so a third chat would land exactly on it -- correct in theory,
                but with two chats it turned the bottom half of the window into an empty
                box, which is not worth the alignment it bought. */}
            {stripBelow && renderAddStrip(true)}
          </div>
        )}
        {showWorkspace && (
          <WorkspacePanel
            sessionId={currentSessionId}
            onClose={() => setShowWorkspace(false)}
            onOpenFile={(p) => void openFileInApp(p)}
          />
        )}
        {/*
          **右侧也是一个和左侧一样的折叠按钮** ——「你这个右侧都变成侧栏了，我要的是和左侧一样的可隐藏按钮，弄大一些就好了」。
          一个零宽的条，按钮贴着预览栏的左边缘（藏起来时贴着窗口右边缘），开着时 ▶ 收起、收着时 ◀ 放出来。
        */}
        {(fileViewerLoading || fileViewer) && (
          <div className="file-collapse-area">
            <button
              type="button"
              className="side-collapse-btn file-collapse-btn"
              onClick={() => {
                if (previewHidden) { setFileViewerHidden(false); setPanelPins((p) => ({ ...p, previewAt: winWidth })); }
                else setFileViewerHidden(true);
              }}
              title={previewHidden ? t('Show preview panel ({n} tabs)', { n: fileTabs.length }) : t('Hide preview panel (tabs are kept)')}
            >{previewHidden ? '◀' : '▶'}</button>
          </div>
        )}
        {(fileViewerLoading || fileViewer) && !previewHidden && (
          <div className="workspace-file-panel" role="complementary" aria-label={t('File preview')} style={{ width: fileViewerShown }}>
            <div className="file-resize-handle" onMouseDown={handleFileResizeStart} title={t('Drag to resize width')} />
            {/*
              顶上一行：左边标签页（多了横向滚动），右边固定三个按钮 ⟳ 刷新 / 📂 打开位置 / ✕。
              没有文件名标题了 —— 只开一个文件也显示标签，靠它看出当前是哪份；已删除的标签带 ⚠。
            */}
            <div className="file-panel-top">
              <div className="file-tabs" role="tablist" aria-label={t('Open files')}>
                {fileTabs.length === 0 && fileViewerLoading && (
                  <div className="file-tab active"><span className="file-tab-name">{t('Loading…')}</span></div>
                )}
                {fileTabs.map((tab) => (
                  <div
                    key={tab.id}
                    role="tab"
                    aria-selected={tab.id === activeFileTabId}
                    className={`file-tab ${tab.id === activeFileTabId ? 'active' : ''}${tab.gone ? ' gone' : ''}`}
                    title={tab.gone
                      ? `${tab.path}\n${t('This file is no longer on disk (deleted or renamed). What is shown below is the last content read.')}`
                      : tab.path}
                    onClick={() => setActiveFileTabId(tab.id)}
                    onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeFileTab(tab.id); } }}
                  >
                    <span className="file-tab-name">
                      {tab.gone ? '⚠ ' : tab.stale ? '• ' : ''}{baseName(tab.path) || tab.path}
                    </span>
                    <button
                      type="button"
                      className="file-tab-close"
                      title={t('Close tab')}
                      onClick={(e) => { e.stopPropagation(); closeFileTab(tab.id); }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <div className="workspace-file-actions">
                {/* Manual refresh as well as the watcher: fs.watch does not fire for
                    every writer on every filesystem (network mounts, some containers),
                    and a button costs nothing when it does not. */}
                {fileViewer && !fileViewer.gone && (
                  <button
                    className="text-btn"
                    title={t('Re-read this file from disk (keeps scroll position and current view)')}
                    onClick={() => void refreshFileTab(fileViewer.id, fileViewer.path)}
                  >
                    ⟳ {t('Refresh')}
                  </button>
                )}
                {fileViewer && (
                  <button
                    className="text-btn"
                    disabled={!!fileViewer.gone}
                    title={fileViewer.gone
                      ? t('This file is no longer on disk (deleted or renamed). What is shown below is the last content read.')
                      : isMac ? t('Show in Finder') : t('Show in Explorer')}
                    onClick={() => void window.kiroApi.showItemInFolder?.(fileViewer.path, fileViewer.ownerSessionId)}
                  >
                    📂 {t('Open location')}
                  </button>
                )}
                <button className="settings-close" onClick={() => { setFileTabs([]); setActiveFileTabId(null); setFileViewerLoading(false); }} title={t('Close panel')}>
                  <IconClose size={16} />
                </button>
              </div>
            </div>
            {/* 预览栏自己的搜索条（Ctrl/Cmd+F，焦点在预览栏里时）：挂在一个零高的定位层上，浮在正文右上角 */}
            <div className="preview-find-anchor">
              <PreviewFind
                body={fileBodyNode}
                owns={previewOwnsFind}
                searchable={!!fileViewer && !fileViewerLoading && previewSearchable({
                  deck: isDeckPath(fileViewer.path), image: !!fileViewer.image, binary: !!fileViewer.binary,
                })}
                tabId={activeFileTabId}
                raw={fileViewerRaw}
                commenting={commenting}
                content={fileViewer?.content || ''}
              />
            </div>
            <div
              className="workspace-file-modal-body"
              ref={setFileBody}
              /* capture：deck 是在里面那一列页（`.rv-pdf-pages`）里滚的，scroll 事件不冒泡 */
              onScrollCapture={(e) => {
                // Remember where this tab was scrolled to; restored on switch back.
                const body = fileBodyRef.current;
                /* 正在滚回原处时那些位置是程序滚出来的（内容还没长够），不记 */
                if (!activeFileTabId || !body || scrollRestoreStopRef.current) return;
                if (e.target !== scrollHostOf(body)) return;   // 代码块横向滚、输入框里滚都不算
                fileScrollRef.current[activeFileTabId] = (e.target as HTMLElement).scrollTop;
                if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
                scrollSaveTimerRef.current = setTimeout(() => { scrollSaveTimerRef.current = null; persistOpenTabs(); }, 500);
              }}
            >
              {fileViewerLoading && <div className="workspace-hint">{t('Loading file…')}</div>}
              {!fileViewerLoading && fileViewer && (
                <>
                  {!isDeckPath(fileViewer.path) && !fileViewer.image && !fileViewer.binary && (() => {
                    /* 💬 comment 和 ◎ 原文 同一行（钉在预览栏顶上，见 `.rv-toggle-bar`）—— 它占的那一行不让正文从旁边透出来。
                       代码 / JSON 能切原文但不能批注：这行只剩原文按钮；两个都不适用就不出这一行。
                       切到原文时批注按钮收起，原文按钮还在，好切回去。 */
                    const canComment = isReviewableText(fileViewer.path) && !fileViewerRaw && !fileViewer.truncated;
                    const canRaw = isMarkdownPath(fileViewer.path) || !!viewerLangFor(fileViewer.path);
                    if (!canComment && !canRaw) return null;
                    return (
                      <div className="rv-toggle-bar">
                        {canComment && (
                          <button
                            type="button"
                            className={`rv-review-toggle${commenting ? ' on' : ''}`}
                            title={commenting
                              ? t('Stop commenting and just read')
                              : fileViewer.ownerSessionId
                                ? t('Comment block by block: 💬 “✓ Confirm” has the chat that opened this file revise that block and write it back right away; + adds new content after the block; ✕ deletes it')
                                : t('Comment line by line. This tab has no owning chat, so comments can be viewed but not sent (open the file from a link in a chat to get one)')}
                            onClick={toggleCommenting}
                          >{commenting ? t('✓ comment') : t('💬 comment')}</button>
                        )}
                        {canRaw && (
                          <button
                            type="button"
                            className={`rv-review-toggle${fileViewerRaw ? ' on' : ''}`}
                            title={fileViewerRaw ? t('Show the rendered view (Markdown / syntax highlighting / formatted JSON)') : t('Show the raw file')}
                            onClick={() => setActiveTabRaw(!fileViewerRaw)}
                          >{fileViewerRaw ? t('◉ Rendered') : t('◎ Raw')}</button>
                        )}
                      </div>
                    );
                  })()}
                  <div className="workspace-viewer-path" title={fileViewer.path}>{fileViewer.path}</div>
                  {/*
                    **远端的文件不是交付位置** ——「远程会话里，用户需要的文件一律落在本机」。
                    这份是经 ssh 从那台机器上读的；点一下复制进这条会话的本机文件夹并打开本机那一份，
                    之后 comment 写回的就是本机文件，不用自己去 ssh。
                  */}
                  {fileViewer.remote && fileViewer.ownerSessionId && (
                    <div className="workspace-hint remote-file-hint">
                      <span>{t('🌐 This file is on {host}, not on your machine.', { host: fileViewer.remoteHost || t('the remote machine') })}</span>
                      <button
                        type="button"
                        className="rv-review-toggle"
                        onClick={async () => {
                          const tab = fileViewer;
                          const res = await window.kiroApi.copyRemoteToLocal?.(tab.ownerSessionId!, tab.path)
                            .catch((err: any) => ({ ok: false, path: undefined as string | undefined, error: String(err?.message || err) }));
                          if (res?.ok && res.path) {
                            closeFileTab(tab.id);
                            void openFileInApp(res.path, tab.ownerSessionId);
                          } else {
                            setFileTabs((prev) => prev.map((x) => (x.id === tab.id ? { ...x, copyError: res?.error || t('Copy failed') } : x)));
                          }
                        }}
                      >{t('⇩ Copy to this machine')}</button>
                      {fileViewer.copyError && <span className="remote-file-hint-error">⚠️ {fileViewer.copyError}</span>}
                    </div>
                  )}
                  {/*
                    **PDF / deck 走逐页预览** —— 排在 binary 那一支**前面**：.pptx 会被 workspaceRead 判成
                    binary（它就是个 zip），落到下面就是一句「无法预览」。转换、缓存、讲稿都在主进程
                    （preview:deck）；没有 LibreOffice 时 ReviewPane 自己把缺什么、怎么装摆出来。

                    「✓ 确认」和提交都走 ownerSessionId —— **打开这份文件的那条会话**，不是此刻选中的那条。
                    key 带路径：换标签页时意见和草稿都是那一份文件自己的，不串。
                  */}
                  {isDeckPath(fileViewer.path) ? (
                    <ReviewPane
                      key={fileViewer.path}
                      path={fileViewer.path}
                      sessionId={fileViewer.ownerSessionId}
                      /* 文件在盘上变了（会话改完 pptx、或者你点了 ⟳ 刷新）就重取预览 */
                      changedAt={fileViewer.changedAt}
                      onSubmit={fileViewer.ownerSessionId
                        ? (prompt: string) => { void handleSendMessage(prompt, undefined, fileViewer.ownerSessionId); }
                        : undefined}
                    />
                  ) : fileViewer.image && fileViewer.dataUrl ? (
                    <div className="workspace-image-wrap">
                      <img className="workspace-image" src={fileViewer.dataUrl} alt={baseName(fileViewer.path) || t('image')} />
                    </div>
                  ) : fileViewer.binary ? (
                    <div className="workspace-binary-hint">
                      <span>{fileViewer.content || t('This file type cannot be previewed. Use “📂 Open location” to open it locally.')}</span>
                    </div>
                  ) : (
                    <>
                      {fileViewer.truncated && (
                        <div className="workspace-hint">{t('⚠️ Preview truncated at 512 KB. Use “📂 Open location” to open the complete file.')}</div>
                      )}
                      {/*
                        **逐行批注** —— 一个开关按钮，开着才有 💬 / ✕（默认纯读）。
                        截断的预览不给：拼回整份写盘会把后面那截删掉（主进程那侧也挡着）。
                      */}
                      {isReviewableText(fileViewer.path) && !fileViewerRaw && !fileViewer.truncated && commenting ? (
                        <ReviewPane
                          /* key 带路径：换标签页时意见、草稿都是那一份文件自己的，不串 */
                          key={fileViewer.path}
                          path={fileViewer.path}
                          text={fileViewer.content}
                          markdown={isMarkdownPath(fileViewer.path)}
                          commenting={commenting}
                          /* **由打开这份文件的那条会话改**，不是此刻选中的那条（见 `FileTab.ownerSessionId`） */
                          sessionId={fileViewer.ownerSessionId}
                          onRewritten={(next: string) => {
                            const at = fileViewer.path;
                            setFileTabs((prev) => prev.map((t) => (t.path === at ? { ...t, content: next } : t)));
                          }}
                          /*
                            **改不了单块的那几条直接发给这个 tab 的主人**（「就从这个会话提交更改」）。
                            不再退出 comment 模式：没有"一批"了 —— 每条都是当场处理的，发完你接着评下一处。
                          */
                          onSubmit={fileViewer.ownerSessionId ? (prompt: string) => {
                            void handleSendMessage(prompt, undefined, fileViewer.ownerSessionId);
                          } : undefined}
                        />
                      ) : isMarkdownPath(fileViewer.path) && !fileViewerRaw ? (
                        <div className="workspace-viewer-md">
                          <MarkdownView content={fileViewer.content} />
                        </div>
                      ) : (() => {
                        const hl = fileViewerRaw ? null : highlightForViewer(fileViewer.path, fileViewer.content);
                        if (!hl) return <pre className="workspace-viewer-content">{fileViewer.content}</pre>;
                        return (
                          <>
                            {hl.prettified && (
                              <div className="workspace-hint">{t('Formatted for display (the file itself is minified JSON). Click “Raw” to see it unformatted.')}</div>
                            )}
                            <pre className="workspace-viewer-content hljs">
                              <code
                                className={`language-${hl.lang}`}
                                dangerouslySetInnerHTML={{ __html: hl.html }}
                              />
                            </pre>
                          </>
                        );
                      })()}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {showBackup && <BackupDialog onClose={() => setShowBackup(false)} />}
      {showSettings && (
        <SettingsDialog
          initialTab={settingsTab}
          startNewMachine={settingsNewMachine}
          settings={settings}
          onChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
          confirmDeletes={!skipDeleteConfirm}
          onConfirmDeletesChange={(value) => {
            const skip = !value;
            setSkipDeleteConfirm(skip);
            try { uiSet('kirolex-skip-delete-confirm', String(skip)); } catch {}
          }}
        />
      )}
      {showNewChat && (
        <>
          <div className="overlay" onClick={() => setShowNewChat(false)} />
          <div className="permission-dialog">
            <h3>{t('💬 New Chat')}</h3>
            <p style={{ marginBottom: 10 }}>{t('Assign this chat to a project (optional). A project gives the chat its own memory.')}</p>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('Project')}</label>
            <select
              className="rename-popup-input"
              value={newChatProject}
              onChange={(e) => setNewChatProject(e.target.value)}
              style={{ marginBottom: 12 }}
            >
              <option value="">{t('No project (unassigned)')}</option>
              {projects.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
              <option value="__new__">{t('+ New project…')}</option>
            </select>
            {newChatProject === '__new__' && (
              <input
                autoFocus
                className="rename-popup-input"
                placeholder={t('New project name…')}
                value={newChatNewProjectName}
                onChange={(e) => setNewChatNewProjectName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateChat(); }}
                style={{ marginBottom: 12 }}
              />
            )}
            {/*
              **在哪台机器上跑**（远程会话，`docs/DESIGN_remote_sessions.md`）。
              只有配了远端且 feature flag 开着才出现 —— 显示一个选了会报错的选项比不显示糟。
              默认本地：远程是个明确的选择，不该因为配置里有一台机器就悄悄改变默认行为。
            */}
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
              {t('Which AI')}
            </label>
            <select
              className="rename-popup-input"
              value={newChatEngine}
              onChange={(e) => setNewChatEngine(e.target.value as 'kiro' | 'claude' | 'codex')}
              style={{ marginBottom: 12 }}
            >
              <option value="kiro">Kiro</option>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
            {newChatEngine !== 'kiro' && (
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: -6, marginBottom: 12, lineHeight: 1.5 }}>
                {t('Uses {engine}’s own login and default model. To run it on a remote machine, that machine needs its ACP adapter installed (Settings → Machines → “Install AI tools”) and signed in.', { engine: newChatEngine === 'claude' ? 'Claude Code' : 'Codex' })}
              </p>
            )}
            {remoteTargets.enabled && remoteTargets.targets.length > 0 && (
              <>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                  {t('Which machine to run on')}
                </label>
                <select
                  className="rename-popup-input"
                  value={newChatRemoteId}
                  onChange={(e) => setNewChatRemoteId(e.target.value)}
                  style={{ marginBottom: 6 }}
                >
                  <option value="">{t('Local')}</option>
                  {remoteTargets.targets.map((t) => (
                    <option key={t.id} value={t.id}>{`🌐 ${t.label}`}</option>
                  ))}
                </select>
                {newChatRemoteId && (
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
                    {t('Files stay local. The remote {engine} reads and writes the files on this machine through a tunnel (nothing is copied).', { engine: engineCliName(newChatEngine) })}
                  </p>
                )}
              </>
            )}
            {/*
              **提前标出能不能用** —— 原来都是建了会话、发了消息失败了才知道。按「将要运行的那台机器」（本机 / 选中的远端）问，
              主进程缓存 5 分钟；❌ 点了直接装、⚠️ 点了登录（见 EngineStatusPanel）。
            */}
            {(() => {
              const target = newChatRemoteId ? remoteTargets.targets.find((r) => r.id === newChatRemoteId) : undefined;
              return (
                <EngineStatusPanel
                  compact
                  machine={target ? target.id : 'local'}
                  selected={newChatEngine}
                  title={target ? t('Status on {machine}', { machine: target.label }) : t('Status on this computer')}
                />
              );
            })()}
            <div className="actions">
              <button className="btn deny" onClick={() => setShowNewChat(false)}>{t('Cancel')}</button>
              <button className="btn allow" onClick={handleCreateChat}>{t('Create')}</button>
            </div>
          </div>
        </>
      )}
      {/*
        窗口级那条搜索条删了 —— 它长在这里（`position: fixed`，右上角）就注定说不清在搜哪一格,
        而且实测被 `.chat-grid`（z-index 1001）整个盖住、点不到。现在每一格自己有一条,
        见 `ChatArea` 里 `.pane-find` 那一段。
      */}
      {showSkill && <SkillDialog onClose={() => setShowSkill(false)} />}

      {showMemory && (
        <MemoryDialog
          projectId={memoryTarget ? memoryTarget.projectId : sessions.find((s) => s.id === currentSessionId)?.projectId}
          sessionId={memoryTarget ? memoryTarget.sessionId : (currentSessionId && !currentSessionId.startsWith('pending_') ? currentSessionId : undefined)}
          initialTab={memoryTarget?.scope}
          onClose={() => { setShowMemory(false); setMemoryTarget(null); }}
        />
      )}
      {showLogs && (
        <>
          <div className="overlay" onClick={() => setShowLogs(false)} />
          <div className="settings-dialog" style={{ width: 720, maxWidth: '90vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div className="settings-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <IconLogs size={17} /> {t('Logs')}
              </h3>
              <button className="settings-close" onClick={() => setShowLogs(false)} title={t('Close logs')}>
                <IconClose size={16} />
              </button>
            </div>
            <div className="settings-body" style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' }}>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  className="btn deny"
                  style={{ padding: '6px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                  onClick={async () => {
                    const result = await window.kiroApi.getLogs(logsLimit).catch(() => ({
                      text: '(failed to read logs)',
                      path: '',
                    }));
                    logsHasMoreRef.current = result.text.split('\n').length >= logsLimit;
                    setLogsText(result.text);
                    requestAnimationFrame(() => {
                      if (logsPreRef.current) logsPreRef.current.scrollTop = logsPreRef.current.scrollHeight;
                    });
                  }}
                >
                  {t('Refresh')}
                </button>
                <button
                  className="btn deny"
                  style={{ padding: '6px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                  onClick={() => void window.kiroApi.openLogs()}
                >
                  {t('Open log file')}
                </button>
              </div>
              <pre style={{
                flex: 1,
                overflow: 'auto',
                margin: 0,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: 11,
                lineHeight: 1.5,
                background: 'var(--bg-tertiary)',
                padding: 12,
                borderRadius: 6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '60vh',
              }}
                ref={logsPreRef}
                onScroll={(e) => {
                  if (e.currentTarget.scrollTop <= 40) void loadOlderLogs();
                }}
              >
                {logsHasMoreRef.current && (logsLoadingOlder ? t('⋯ Loading older logs…') + '\n' : t('↑ Scroll up to load older logs') + '\n')}
                {logsText || t('(no logs yet)')}
              </pre>
            </div>
          </div>
        </>
      )}
      {usageActionConfirm && (
        <>
          <div className="overlay" onClick={() => setUsageActionConfirm(null)} />
          <div className="permission-dialog">
            {usageActionConfirm === 'contextMenu' ? (
              <>
                <h3>{t('Manage context')}</h3>
                <p>
                  {t('Choose whether to summarize older context or clear the active conversation context completely.')}
                </p>
                <div className="actions">
                  <button className="btn deny" onClick={() => setUsageActionConfirm(null)}>
                    {t('Cancel')}
                  </button>
                  <button
                    className="btn deny"
                    onClick={() => setUsageActionConfirm('clear')}
                    style={{ color: 'var(--error)' }}
                  >
                    {t('Clear')}
                  </button>
                  <button
                    className="btn allow"
                    onClick={() => setUsageActionConfirm('compact')}
                  >
                    {t('Compact')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>
                  {usageActionConfirm === 'compact'
                    ? t('Compact context?')
                    : usageActionConfirm === 'clear'
                    ? t('Clear context?')
                    : t('Reset Credits counter?')}
                </h3>
                <p>
                  {usageActionConfirm === 'compact'
                    ? t('{engine} will summarize older conversation context to free context-window capacity. The original full context cannot be restored inside this active {engine} session.', { engine: usageEngineName })
                    : usageActionConfirm === 'clear'
                    ? t('{engine} will discard the active conversation context, and KiroLex will clear the currently displayed history. This cannot be undone inside this active chat.', { engine: usageEngineName })
                    : t('This resets the Credits counter for the current KiroLex session to 0. It does not change actual account usage, billing, or Kiro credit records.')}
                </p>
                <div className="actions">
                  <button className="btn deny" onClick={() => setUsageActionConfirm(null)}>
                    {t('Cancel')}
                  </button>
                  <button
                    className="btn allow"
                    onClick={() => void handleConfirmUsageAction()}
                    style={usageActionConfirm === 'clear' ? { background: 'var(--error)' } : undefined}
                  >
                    {usageActionConfirm === 'compact'
                      ? t('Compact')
                      : usageActionConfirm === 'clear'
                      ? t('Clear')
                      : t('Reset')}
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
      {rerunConfirm && (
        <>
          <div className="overlay" onClick={() => setRerunConfirm(null)} />
          <div className="permission-dialog">
            <h3>{t('Edit and rerun')}</h3>
            <p>
              {(() => {
                const [before, after] = t('This deletes the {n} messages after this one and reruns from the edited message.', { n: '\u0000' }).split('\u0000');
                return <>{before}<strong>{rerunConfirm.deleteCount}</strong>{after}</>;
              })()}
            </p>
            <div className="actions">
              <button className="btn deny" onClick={() => setRerunConfirm(null)}>{t('Cancel')}</button>
              <button className="btn allow" onClick={confirmRerun}>{t('Confirm and rerun')}</button>
            </div>
          </div>
        </>
      )}
      {/*
        给运行起名字 / 改名。一个对话框管两件事：`runId` 为空是新建，有值是改名。
        空名字是**合法**的：新建时表示"懒得起名，用 #N"；改名时表示"清掉名字，回到 #N"。
      */}
      {/* 删除被拒绝：只说明理由，没有「仍然删除」这个选项 —— 这条约束不是建议。 */}
      {deleteRefusal && (
        <>
          <div className="overlay" onClick={() => setDeleteRefusal(null)} />
          <div className="permission-dialog">
            <h3>{t('🔒 This chat cannot be deleted from here')}</h3>
            <p>{deleteRefusal}</p>
            <div className="permission-actions">
              <button className="btn allow" onClick={() => setDeleteRefusal(null)}>{t('Got it')}</button>
            </div>
          </div>
        </>
      )}
      {deleteConfirm && (
        <>
          <div className="overlay" onClick={() => setDeleteConfirm(null)} />
          <div className="permission-dialog">
            <h3>{t('🗑️ Delete Session')}</h3>
            <p>
              {t('Are you sure you want to delete "{title}"? This will permanently remove the session and its history.', { title: '\u0000' })
                .split(/(\u0000)/)
                .map((part, i) => (part === '\u0000' ? <strong key={i}>{deleteConfirm.title}</strong> : part))}
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 14px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={dontAskDelete}
                onChange={(e) => setDontAskDelete(e.target.checked)}
              />
              {t("Don't ask again")}
            </label>
            <div className="actions">
              <button className="btn deny" onClick={() => { setDeleteConfirm(null); setDontAskDelete(false); }}>
                {t('Cancel')}
              </button>
              <button className="btn allow" onClick={confirmDelete} style={{ background: '#ef5350' }}>
                {t('Delete')}
              </button>
            </div>
          </div>
        </>
      )}
      {deleteProjectConfirm && (
        <>
          <div className="overlay" onClick={() => setDeleteProjectConfirm(null)} />
          <div className="permission-dialog">
            <h3>{t('🗑️ Delete Project')}</h3>
            <p>
              {(deleteProjectConfirm.memberCount > 0
                ? t('Are you sure you want to delete the project "{name}"? This permanently removes its memory and {chats} inside it (with their history). This cannot be undone.', { name: '\u0000', chats: '\u0001' })
                : t('Are you sure you want to delete the project "{name}"? This permanently removes its memory. This cannot be undone.', { name: '\u0000' }))
                .split(/(\u0000|\u0001)/)
                .map((part, i) => (part === '\u0000'
                  ? <strong key={i}>{deleteProjectConfirm.name}</strong>
                  : part === '\u0001'
                    ? <strong key={i}>{deleteProjectConfirm.memberCount === 1 ? t('1 chat') : t('{n} chats', { n: deleteProjectConfirm.memberCount })}</strong>
                    : part))}
            </p>
            <div className="actions">
              <button className="btn deny" onClick={() => setDeleteProjectConfirm(null)}>
                {t('Cancel')}
              </button>
              <button className="btn allow" onClick={confirmDeleteProject} style={{ background: '#ef5350' }}>
                {t('Delete project')}
              </button>
            </div>
          </div>
        </>
      )}
    </LangProvider>
  );
};

export default App;
