import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { consumeHandoff } from '../handoffDraft';
import { type SubagentRow } from '../../main/subagents.ts';
import { uiGet, uiSet, uiRemove } from '../uiStore';
import { TASK_LISTS_KEY, normalizeTaskList, parseTaskLists, serializeTaskLists, updateTaskLists, type TaskLists } from '../taskList';
import { remoteWarmCut, sessionsToWarm } from '../projectActivity';
import type { TurnOutcome } from '../idleNotify';
import { classifyDeleteResult } from '../deleteOutcome';
import { messageVariants, normalizeLang, pinShown, t as translate, type Lang } from '../i18n';
import { toSlashCommands, type SlashCommand } from '../slashCommands';
import { showToast } from '../components/Toasts';
import type { Message, ToolCall, Session, SessionFolder, AttachedFile, FileDiff, PlanEntry } from '../App';
import { onBusyChange, onHandoffMainTurn, onOwnTurnEnd, type AdoptionState } from '../handoffAdoption';
// The loop's spec / terminals. The driver itself is in main (loopDriver.ts); this hook only mirrors it.
import { foldVerdicts, isLoopRoundMessageId, loopVerdictsId, type LoopRun, type LoopSpec, type LoopTerminal, type VerdictRound } from '../loopMachine';
// Scheduling replaced loop mode. Pure module, shared with main (which owns the ticker)
// rather than duplicated here, so the rules cannot drift between the two.
import type { ScheduleSpec } from '../../main/schedule';
import type { ScheduleView } from '../scheduleView';
import type { BgJobRow } from '../bgJobsView';
// "The previous turn is still wrapping up" -- decided in a pure module, because every wrong
// branch either bills a duplicate turn or leaves a question permanently unanswered.
import { asSteerParts, toStoredUserLines } from '../steerSplit';
import { carryControlMark, viaFor } from '../../main/controlSessions';
import type { UsageView } from '../usageChip.ts';
import { matchConsumedSteers, parseFailedSteers, settleAtTurnEnd, settleIpcResult, turnBaseId, withFailedSteers, type FailedSteerRecord, type PendingSteer } from '../steerPending';
import { decideTurnRecovery, adoptedMessages, isReviseRequest, findRecoveryTarget, consumedSteersText, steerInsertIndex, type TurnPeek } from '../turnRecovery';
import { insertOptimistic, isDuplicateMessageError, removeOptimistic } from '../queueRetry';
import { isKirolexNote, normalizeLegacyNote } from '../../main/kirolexNote.ts';
import { asVariants } from '../../main/uiText.ts';
import { withLiveNote, notesAfterReload } from '../noticeMerge.ts';
import { cleanIpcError } from '../sessionRequestStatus.ts';
import { firstUserText } from '../titleSource.ts';
import { splitNoteDetail } from '../../main/kirolexNote.ts';
import { chatHistoryBody } from '../historyBlock.ts';
import { mergeAssistantFinal } from '../assistantFinal.ts';
import { connectFailureNotice, adapterInstalledNotice, historyBeforeNotice, replaceConnectFailureNotices } from '../connectFailure';
import { adapterInstallOffer, engineLoginOffer } from '../adapterInstallOffer';
import { forkRemoteIntent, firstSendRemoteId, forkMachineMissingText, restoredForkIntents, FORK_MACHINE_MISSING_GROUP } from '../forkTarget';
import { noteSessionLocally, unpinSessionLocally } from './useSessionNotice';
import { adapterInstallStore, setAdapterInstallRunner, setEngineLoginRunner } from '../adapterInstallState';
import { visibleProjects, projectMembershipKey } from '../projectVisibility';
import { reconcileWithStore } from '../messageReconcile';
import { engineLabel } from '../engineLabel';
import { wantsEditFork } from '../../main/editFork.ts';
import { planTextOf } from '../permissionButtons.ts';
import { mergeToolTrace, shouldRecordToolCall, toolTimes, toolTraceFields } from '../../main/toolTrace.ts';
import { isQuestionMessage, leftScreen, LEAVE_CONFIRM_MS, shouldCancelOnLeave, upsertQuestionCard } from '../questionCards';
import { applyCreateStage, clearCreateStage, retryCreateArgs, settleStageOnAttach, type CreateArgs, type CreateStageInfo } from '../createStages';
import { withoutPermissionCard } from '../permissionCards';

export type { LoopSpec } from '../loopMachine';
export type { ScheduleSpec } from '../../main/schedule';

/** Tool kinds that RUN something rather than touch a file. Mirrors RUN_KINDS in the
 *  main process: a command carries neither locations nor diffs, so without this it is
 *  dropped and the turn shows a script being created but never run. */
const RUN_KINDS = new Set(['execute', 'run', 'bash', 'shell', 'command', 'terminal']);

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export type { SlashCommand } from '../slashCommands';

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface PermissionRequest {
  requestId: number | string;
  sessionId: string;
  toolTitle: string;
  description?: string;
  options: PermissionOption[];
  /** 批准计划（Claude Code 的 ExitPlanMode）时的计划正文，Markdown（审计 2b，`permissionButtons.planTextOf`） */
  plan?: string;
}

/** A running turn that has gone quiet, re-sent by main on every watchdog tick.
 *  `interruptInSeconds` is null when the timeout interrupt is switched off, so the
 *  UI can say "nothing will happen" instead of implying a countdown. */
export interface TurnStall {
  quietSeconds: number;
  openTools: number;
  toolIdleSeconds: number;
  interruptInSeconds: number | null;
  /** Which threshold the countdown is measured against: the tool no-progress limit
   *  (`'tool'`, the one that governs whenever a tool call is open) or the silence
   *  threshold (`'quiet'`). Kept so the notice can name the setting it comes from --
   *  showing only "23 more minutes" next to a Settings page displaying 600 read as a
   *  contradiction, when in fact both bounds must be passed and the later one wins. */
  boundBy: 'tool' | 'quiet';
  /** The value of that threshold, in seconds. */
  boundSeconds: number;
}

/** Live view of a session rendered in a split pane (i.e. visible but NOT the
 *  focused session). Mirrors what the focused session keeps in plain state. */
export interface PaneView {
  messages: Message[];
  activity: string | null;
  activeTool: string | null;
  /** Per-session context/credits meter — the focused chat keeps this in plain
   *  state, a pane needs its own copy or the widget disappears in split view. */
  usage: UsageView | null;
  /** Per-session context-sync links (Context Engineering). */
  contextLinks: { sourceId: string; sourceTitle: string }[];
  /** Live "this turn has stopped producing" state; drives the stall warning. */
  stall: TurnStall | null;
  /** The agent's plan/todo panel for THIS chat.
   *
   *  Mirrored per pane for the same reason as `usage` and `stall`, and here it also
   *  fixes a visible defect: the panel used to be read from the focused chat's state
   *  only, so every focus switch MOUNTED it in one pane and UNMOUNTED it in another.
   *  Both transcripts changed height in the same frame -- the flash seen when clicking
   *  between panes. A plan belongs to a chat, not to whichever pane has focus. */
  plan: PlanEntry[];
}

/** Shared empty plan, so a pane without one keeps a stable identity across renders. */
const EMPTY_PANE_PLAN: PlanEntry[] = [];
/** Same, for a chat with no messages cached yet: a fresh [] on every render would make
 *  the transcript look like new content each time. */
const EMPTY_PANE_MESSAGES: Message[] = [];

/** Bucket for errors that belong to no chat -- today only the initial backend connect,
 *  which can fail before any session exists (and therefore before any pane has an id). */
export const APP_ERROR_KEY = '__app__';

// Extract absolute file paths an ACP tool_call touched (update.locations[].path).
/** Busy reasons that mean the backend must NOT be given a new message yet.
 *  'prime-pending' is included deliberately: a chat whose backend lost its history
 *  would otherwise answer from nothing, so new messages QUEUE behind the rebuild.
 *  The rebuild has no attempt limit, so the ONLY releases are the user pressing
 *  Stop (abandon) or clearing the history. */
export const OCCUPYING_BUSY_REASONS = new Set(['turn', 'reconfiguring', 'attaching', 'priming', 'prime-pending', 'creating']);
export function isBackendOccupied(reason: string | null | undefined): boolean {
  return !!reason && OCCUPYING_BUSY_REASONS.has(reason);
}

function extractLocations(update: any): string[] {  const raw = Array.isArray(update?.locations) ? update.locations : [];
  const paths = raw
    .map((loc: any) => (typeof loc === 'string' ? loc : loc?.path))
    .filter((p: any): p is string => typeof p === 'string' && p.length > 0);
  return Array.from(new Set(paths));
}

// Extract file diffs carried in an ACP tool_call's content blocks
// (`{ type: 'diff', path, oldText, newText }`).
function extractDiffs(update: any): FileDiff[] {
  const blocks = Array.isArray(update?.content) ? update.content : [];
  const diffs: FileDiff[] = [];
  for (const block of blocks) {
    if (block?.type === 'diff' && typeof block.path === 'string' && typeof block.newText === 'string') {
      diffs.push({ path: block.path, oldText: block.oldText ?? undefined, newText: block.newText });
    }
  }
  return diffs;
}

/** Text a tool reported, across ALL of its content blocks. This used to read only
 *  block [0]; main persists every block, so reading one here would make a reopened
 *  chat show MORE than the live one did for the same tool call. */
function extractToolOutput(update: any): string {
  return (Array.isArray(update?.content) ? update.content : [])
    .map((block: any) => (typeof block?.content?.text === 'string' ? block.content.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Why did the turn stop? A non-end_turn reason is the "reply cut off
 *  mid-sentence with no error" case and MUST be surfaced -- kiro-cli returns it
 *  on session/prompt and KiroLex used to throw it away. Returns null for a
 *  normal completion (and for cancels, which already have their own banner). */
/** Map live messages to durable transcript records for a truncating rewrite
 *  (edit-rerun / cancel-overwrite). Thinking (💭) segments are live-only, but
 *  attachments and paste refs MUST survive: dropping them used to strip every
 *  earlier message's image/paste metadata on each rerun, which killed the
 *  attachment chips, broke history re-injection (`file:` refs), and made the
 *  boot GC treat those blobs as orphans and delete them. */
/** Supplied by the cancel-overwrite path: it has ALREADY built the prompt from the
 *  composer (new attachments, expanded pastes), so the rerun must use those rather
 *  than resurrecting the interrupted message's own attachments. */
type RerunOverride = {
  prompt?: any[]; attachments?: any[]; pastes?: any[]; displayText?: string;
  /** 被重发的那条是经控制入口发的，新的那条也带标记（`carryControlMark`）。自动重发用；你手动「编辑重跑」不带 */
  carryMark?: boolean;
};

/** How many times an interrupted prompt may be auto-resent before KiroLex stops
 *  trying. More than one, because the resend's OWN turn can be interrupted too;
 *  bounded, because every attempt costs credits. */
const AUTO_RESEND_MAX_ATTEMPTS = 10;
/**
 * 「因为非人工原因中断的会话你应该加自动重试发送，重试次数默认是 10，可以在 setting 中调整」。
 * 设置里的 `autoRetryMax`（会话那一页）；读持久化的 settings，因为这个 hook 拿不到 App 的 settings 状态。
 * 0 = 不自动重发（等同于关掉「中断后自动重发」）。
 */
function autoRetryMax(): number {
  try {
    const raw = uiGet('kirolex-settings');
    const n = raw ? Number(JSON.parse(raw)?.autoRetryMax) : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.min(50, Math.floor(n)) : AUTO_RESEND_MAX_ATTEMPTS;
  } catch { return AUTO_RESEND_MAX_ATTEMPTS; }
}

/** 当前界面语言 —— useAcp 在 <LangProvider> 外面，useLang() 在这里只会拿到默认值，所以直接读设置（同删除会话那处）。 */
function uiLangNow(): Lang {
  try { return normalizeLang(JSON.parse(uiGet('kirolex-settings') || '{}')?.language); } catch { return normalizeLang(undefined); }
}
/** 按当前界面语言取文案（KiroLex 自己对人说的话；发给模型的提示词不走这里）。 */
const t = (key: string, vars?: Record<string, string | number>): string => translate(uiLangNow(), key, vars);

/**
 * 一轮已经有产出、却被"静默太久"判定卡死时自动发的那句（见 onTurnWedged）。
 * 只叫它接着做，不重复原问题；并点名最常见的成因 —— 一口气憋一大段长输出，期间没有任何工具调用。
 */
export const WEDGE_CONTINUE_PROMPT = '上一轮被 KiroLex 判定"静默太久"自动中断了（很可能是一次性构思了很长的输出，期间没有任何工具调用）。'
  + '已经做完的不用重做，从中断的地方接着做完。长内容请分段写、每写完一段就保存一次（例如每节一次 local_write / 文件写入），'
  + '不要把整篇憋在一次输出里。';

const PENDING_STEERS_KEY = 'kirolex-pending-steers';
/** 没能追加到这一轮、还在等用户选的 steer（见 `addFailedSteer`）。重启后**仍是标红的失败消息**（带原因、附件和两个按钮），
 *  不变成排队 —— 只有用户点「作为下一条发送」才进队列（见 steerPending.withFailedSteers）。 */
const FAILED_STEERS_KEY = 'kirolex-failed-steers';
export type FailedSteer = FailedSteerRecord<AttachedFile>;
/** 一条失败记录 → 界面上那条标红的消息 */
function failedSteerMessage(f: FailedSteer): Message {
  return {
    id: f.msgId, role: 'user', content: f.content, steer: 'failed', steerError: f.reason || 'unknown',
    timestamp: f.ts || Date.now(),
    ...(f.attachments.length ? { attachments: f.attachments } : {}),
  };
}
/** 每次改动都把自己写进 ui-state 的 Map（只存会被放回队列的：文字、附件，和 id —— id 用来认出经控制入口发的那条，放回队列时保留标记）。 */
class PersistedSteerMap extends Map<string, PendingSteer<AttachedFile>[]> {
  set(key: string, value: PendingSteer<AttachedFile>[]): this {
    super.set(key, value); this.save(); return this;
  }
  delete(key: string): boolean { const r = super.delete(key); this.save(); return r; }
  clear(): void { super.clear(); this.save(); }
  private save(): void {
    try {
      const out: Record<string, { content: string; attachments: AttachedFile[]; msgId?: string }[]> = {};
      for (const [k, list] of this) out[k] = list.map((s) => ({ content: s.content, attachments: s.attachments || [], msgId: s.msgId }));
      uiSet(PENDING_STEERS_KEY, JSON.stringify(out));
    } catch { /* 写不进去就只在内存里，和以前一样 */ }
  }
}

/** 一轮里**已经被模型吃进去的** steer —— 重发、重跑、塞回输入框时都要跟着基础那条一起走，
 *  否则「steer 的内容不会被重试、rerun 或者恢复」。还没被吃的那些不在这里：它们在轮末回到队列。 */
export function withConsumedSteers(msgs: Message[], baseIndex: number): string {
  /* KiroLex 自己的提示不拼进去 —— 见 `consumedSteersText` */
  return consumedSteersText(msgs, baseIndex);
}

/** Per-session usage, persisted so the context gauge is not blank until the next
 *  turn. Stored as entries (not an object) to keep session ids opaque. */
const USAGE_MAP_KEY = 'kirolex-usage-by-session';
type UsageEntry = UsageView;
function readUsageMap(): [string, UsageEntry][] {
  try {
    const raw = uiGet(USAGE_MAP_KEY);
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows)
      ? rows.filter((r: any) => Array.isArray(r) && typeof r[0] === 'string' && r[1] && typeof r[1].contextPercent === 'number')
      : [];
  } catch { return []; }
}
function writeUsageMap(map: Map<string, UsageEntry>): void {
  try { uiSet(USAGE_MAP_KEY, JSON.stringify([...map.entries()])); } catch {}
}
/** 会话记录里的累计花费（主进程 `sessionCost.ts` 写的，比 ui-state 这份新）进用量表 —— 重开窗口 / 换设备不从 0 数起。变了才返回 true */
function seedSessionCost(map: Map<string, UsageEntry>, id: string, sc: any): boolean {
  if (!sc || typeof sc.total !== 'number' || !Number.isFinite(sc.total)) return false;
  const prev = map.get(id);
  if (prev?.cost === sc.total) return false;
  map.set(id, {
    ...prev, contextPercent: prev?.contextPercent ?? 0, credits: prev?.credits ?? 0,
    cost: sc.total, turnCost: typeof sc.turn === 'number' ? sc.turn : undefined, currency: typeof sc.currency === 'string' ? sc.currency : 'USD',
  });
  return true;
}

/** The durable-session listing, fetched at most ONCE per window.
 *
 *  React.StrictMode double-invokes mount effects in dev: effect -> cleanup ->
 *  effect. The hydrate effect's cleanup sets `cancelled`, so the FIRST run's result
 *  is discarded and the SECOND run is the one that counts -- meaning the whole
 *  listing (17 chats: record.json + transcript sizing) was paid for twice and used
 *  once. Measured on a real boot: two `list-durable-sessions` requests 5.2s apart,
 *  i.e. ~5s of the 13.6s to a visible window spent recomputing a discarded answer.
 *  Sharing the promise keeps the cancel semantics exactly as they were and only
 *  removes the duplicated disk work.
 *
 *  ...but only for a few seconds, NOT for the life of the window. Under dev:hot a
 *  code edit re-mounts this hook without reloading the page, and the hydrate merge
 *  ADDS every disk record the sidebar lacks -- so a listing cached at boot brought
 *  back a chat deleted after boot (a red, unconnectable "New Chat" whose directory
 *  was already in trash/). The StrictMode double mount is milliseconds apart; a
 *  remount after an edit is seconds to minutes later and must see the disk as it is. */
const DURABLE_LIST_SHARE_MS = 3000;
let durableSessionsOnce: Promise<any[]> | null = null;
function listDurableSessionsOnce(): Promise<any[]> {
  if (!durableSessionsOnce) {
    const p = Promise.resolve(window.kiroApi?.listDurableSessions?.() ?? [])
      .then((rows) => (Array.isArray(rows) ? rows : []))
      .catch(() => []);
    durableSessionsOnce = p;
    void p.finally(() => setTimeout(() => {
      if (durableSessionsOnce === p) durableSessionsOnce = null;
    }, DURABLE_LIST_SHARE_MS));
  }
  return durableSessionsOnce;
}

/** Stable short key for an interrupted prompt, so the SAME text is not
 *  auto-resent without limit across restarts (each resend costs credits). */
function autoResendKey(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; }
  return `${text.length}:${h}`;
}

/** transcript 里的一条 → 界面的 Message（switchSession 读盘、对账共用）。 */
function messageFromStored(raw: any): Message {
  /* 旧记录里冒充助手的 KiroLex 提示（定时任务结束那句）读回来就是 KiroLex 提示 */
  const m = normalizeLegacyNote(raw);
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls,
    // Attachment chips must survive a restart (persisted per message).
    attachments: (m as any).attachments,
    pastes: (m as any).pastes,
    ...((m as any).kirolex ? { kirolex: true as const } : {}),
    ...(typeof (m as any).noteGroup === 'string' ? { noteGroup: (m as any).noteGroup } : {}),
    ...(typeof (m as any).toolTailFrom === 'number' ? { toolTailFrom: (m as any).toolTailFrom } : {}),
    ...replyMarksOf(m),
    ...(asVariants((m as any).variants) ? { variants: asVariants((m as any).variants) } : {}),
    ...(asSteerParts((m as any).steerParts) ? { steerParts: asSteerParts((m as any).steerParts) } : {}),
    ...questionOf(m),
    timestamp: m.ts,
  };
}

/** 提问卡片（问了什么、答了什么）—— 读盘的每一处都要带上，重启后显示成只读摘要。 */
function questionOf(m: any): { question?: Message['question'] } {
  return m?.question && typeof m.question === 'object' ? { question: m.question } : {};
}

/** 助手消息的去重标记（`replyTo` / `replyComplete`，见 `main/promptDedupe.ts`）—— 读回来、写回去都原样带着。 */
function replyMarksOf(m: any): { replyTo?: string; replyComplete?: true } {
  if (m?.role !== 'assistant' || typeof m.replyTo !== 'string') return {};
  return { replyTo: m.replyTo, ...(m.replyComplete ? { replyComplete: true as const } : {}) };
}

function toStoredTranscript(messages: Message[]) {
  return messages
    .filter((m) => !(m.role === 'assistant' && m.content.startsWith('💭 ')))
    /* 没能追加进去的 steer 模型从没见过，不进记录（它在等用户选「作为下一条发送 / 放回输入框」） */
    .filter((m) => m.steer !== 'failed')
    /* 还挂着的提问卡片不写：它关掉时主进程会追加那一条（写了就成了同 id 两条） */
    .filter((m) => m.question?.status !== 'pending')
    /* 从盘上读回来、折叠着追加指令的那条拆回「原消息 + mergeIntoMessageId 事件」写回去，下次读回来还能分开显示 */
    .flatMap((m) => toStoredUserLines({
      id: m.id,
      role: m.role,
      content: m.content,
      ts: m.timestamp,
      toolCalls: m.toolCalls,
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ...((m as any).pastes?.length ? { pastes: (m as any).pastes } : {}),
      ...(m.kirolex ? { kirolex: true as const } : {}),
      ...(m.noteGroup ? { noteGroup: m.noteGroup } : {}),
      ...(typeof m.toolTailFrom === 'number' ? { toolTailFrom: m.toolTailFrom } : {}),
      /* 回复的去重标记原样写回去（主进程那边也会按盘上的补，见 sessionStore.rewriteTranscript） */
      ...replyMarksOf(m),
      ...(m.variants ? { variants: m.variants } : {}),
      ...(m.steerParts ? { steerParts: m.steerParts } : {}),
      /* 提问卡片：整份重写时原样写回去 */
      ...(m.question ? { question: m.question } : {}),
      // 经控制入口发的（id 带标记）：整份重写时显式来源照样写回去
      ...viaFor(m.id),
    }));
}

function noticeForStopReason(reason: unknown, result?: any): string | null {
  const r = String(reason ?? '').trim();
  if (!r) return null;
  const norm = r.toLowerCase().replace(/[\s-]+/g, '_');
  if (norm === 'end_turn' || norm === 'endturn') return null;
  if (norm === 'cancelled' || norm === 'canceled') return null; // cancel path shows its own notice
  if (norm === 'max_tokens' || norm === 'maxtokens' || norm === 'max_token') {
    return t('⚠️ The reply hit the output limit and was cut off. Send "continue" to have it keep writing.');
  }
  if (norm === 'max_turn_requests' || norm === 'max_turn_request') {
    return t('⚠️ This turn hit the tool-call limit and stopped. Send "continue" to have it carry on.');
  }
  if (norm === 'refusal') {
    return t('⚠️ The model refused this request. Try rephrasing it or splitting it into smaller questions.');
  }
  return t('⚠️ This turn ended abnormally ({reason}).', { reason: r });
}

/** A turn that resolved with NO output and NO stated reason is abnormal too --
 *  never let it pass as a silent normal completion. */
function noticeForEmptyTurn(result: any): string | null {
  const produced = result?.__kirolex?.produced;
  if (produced !== false) return null;
  const r = String(result?.stopReason ?? '').trim().toLowerCase();
  if (r === 'cancelled' || r === 'canceled') return null; // cancel has its own banner
  return r
    ? t('⚠️ This turn produced no output ({reason}). Resend, or press Rerun.', { reason: r })
    : t('⚠️ This turn produced no output. Resend, or press Rerun.');
}

export function useAcp() {  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  /** Error banner text PER CHAT.
   *
   *  This used to be one app-wide string. Two things went wrong with that, both seen:
   *  a failure in chat A was displayed on top of chat B once focus moved (the banner
   *  followed the focus, not the chat that failed), and because it was rendered only
   *  for the focused pane, every focus switch mounted the banner in one pane and
   *  unmounted it in another -- changing both transcripts' heights in the same frame,
   *  which is the flash seen when clicking between split panes.
   *
   *  `APP_ERROR_KEY` covers the failures that belong to no chat at all (the initial
   *  backend connect, when there is not even a session yet). Anything that happens
   *  while a chat is focused is attributed to THAT chat instead, so it stays put. */
  const [errorBySession, setErrorBySession] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<Session[]>(() => {
    // Load persisted sessions
    try {
      const saved = uiGet('kirolex-sessions');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [folders, setFolders] = useState<SessionFolder[]>(() => {
    try {
      const saved = uiGet('kirolex-folders');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  // Projects: explicit, user-created grouping (write-once memory scope §6.4).
  // A project is just a name; membership is a session's projectId.
  const [projects, setProjects] = useState<string[]>(() => {
    try {
      const saved = uiGet('kirolex-projects');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => {
    try {
      return uiGet('kirolex-last-session') || null;
    } catch {}
    return null;
  });
  const [messages, setMessagesState] = useState<Message[]>([]);
  /**
   * **`messages` 属于哪条会话** ——「有的会话似乎内容混了」。
   *
   * 切会话时 `currentSessionId` 先变成 B，而 `messages` 还是 A 的（B 的历史是异步读进来的，晚一拍）。
   * 下面那个"把当前视图存进缓存"的 effect 在这一拍里跑一次，就把 **A 的消息存进了 B 的缓存格子**；
   * 之后 B 上任何按缓存整份重写 transcript 的动作（重跑、自动重发、打断后覆盖 → `rewriteTranscript`）
   * 都会把 B 的磁盘历史整份换成 A 的。实测一次：「AWS Resilience 博客素材评估」的 transcript
   * 被换成了「FSx ONTAP」那条的 28 条消息，触发点是模型切换后的自动重发。
   *
   * 所有调用点在调 setMessages 时都已经保证"这批消息属于 currentSessionRef.current"（要么先判过
   * `currentSessionRef.current === sid`，要么就在 switchSession 里刚把它设成新会话之后），
   * 所以在这里一起记下归属，effect 只在归属等于当前会话时才写缓存。
   */
  const [messagesOwner, setMessagesOwner] = useState<string | null>(null);
  const setMessages = useCallback((next: Message[] | ((prev: Message[]) => Message[])) => {
    setMessagesOwner(currentSessionRef.current);
    setMessagesState(next as any);
  }, []);
  // Session IDs currently streaming (supports parallel streaming across models)
  const [streamingIds, setStreamingIds] = useState<string[]>([]);
  // Session IDs whose per-session executor is ATTACHED this run (design §3).
  // Drives the live/dormant sidebar dot; a persisted session is dormant until
  // it is opened and its executor attaches.
  const [attachedSessionIds, setAttachedSessionIds] = useState<string[]>([]);
  // Session IDs whose executor is currently ATTACHING (spawn/connect in flight).
  // Drives the "connecting" flash dot.
  const [connectingSessionIds, setConnectingSessionIds] = useState<string[]>([]);
  /**
   * **连过、而且连不上的那些** ——「如果连不上不应该是红色吗」。
   *
   * 侧栏原来只有"绿（连着）"和"灰（还没连）"两种，而 `statusFor` 里明写着"还没 attach 是正常的，
   * 不该显示成 alert"。那条规则本身对：一条没打开过的会话理应是灰的。
   *
   * 缺的是第三种：**试过、失败了**。那台 EC2 连不上的时候（`Connection timed out during banner
   * exchange`），每条远程会话都是灰的 —— 和"还没打开"一模一样，于是你只能靠翻日志才知道它坏了。
   * 所以只有**真的失败过**才进这个集合；attach 成功、或者开始跑一轮，就从里面摘掉。
   */
  const failedRef = useRef<Set<string>>(new Set());
  const [failedSessionIds, setFailedSessionIds] = useState<string[]>([]);
  const markFailed = (sid: string | null) => {
    if (!sid) return;
    if (!failedRef.current.has(sid)) {
      failedRef.current.add(sid);
      setFailedSessionIds(Array.from(failedRef.current));
    }
  };
  const clearFailed = (sid: string | null) => {
    if (!sid) return;
    if (failedRef.current.delete(sid)) setFailedSessionIds(Array.from(failedRef.current));
  };
  // Sessions whose history is being read from disk. Rendered as a loading state so
  // a cold chat never flashes an empty/"no messages" view before the transcript
  // lands (message bodies are not mirrored into localStorage any more).
  const [historyLoadingIds, setHistoryLoadingIds] = useState<string[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<Record<string, PermissionRequest>>({});

  // --- Split view: panes shown side-by-side with the focused session --------
  // Background sessions stream into `messagesCacheRef` ONLY. That is a ref, so
  // it never re-renders — deliberate, because ~12 warm sessions streaming at
  // once would otherwise re-render the whole app on every chunk. A pane must be
  // LIVE though, so for the handful of sessions currently on screen we mirror
  // the same data into state. Non-visible sessions keep the cheap ref-only path.
  const paneSessionIdsRef = useRef<Set<string>>(new Set());
  /** EVERY chat on screen, focused one included. `paneSessionIdsRef` deliberately holds
   *  only the non-focused panes, but handing a chat its pane view as focus LEAVES it
   *  requires knowing it is on screen at all. */
  const onScreenPaneIdsRef = useRef<Set<string>>(new Set());
  /** The exact `messages` array the focused pane is currently rendering.
   *
   *  Identity, not content, is the point: handing the outgoing pane an equal-but-
   *  different array is what made every memo bail out and every code block get
   *  re-highlighted (measured: 554 `code` + 60 `pre` attribute mutations on one focus
   *  switch, with the message ids identical before and after). */
  /** 焦点会话正在渲染的那个数组，**连它属于谁一起记** —— 见下面那个 effect 里的理由。 */
  const focusedMessagesRef = useRef<{ sessionId: string | null; messages: Message[] }>({
    sessionId: null,
    messages: EMPTY_PANE_MESSAGES,
  });
  const [paneViews, setPaneViews] = useState<Record<string, PaneView>>({});
  /** Update one pane's live view. No-op for sessions that are not on screen. */
  const patchPane = useCallback((sid: string | null, patch: Partial<PaneView>) => {
    if (!sid || !paneSessionIdsRef.current.has(sid)) return;
    setPaneViews((prev) => {
      const cur = prev[sid];
      if (!cur) return prev;
      const keys = Object.keys(patch) as (keyof PaneView)[];
      if (!keys.some((k) => cur[k] !== patch[k])) return prev;   // no-op keeps memo stable
      return { ...prev, [sid]: { ...cur, ...patch } };
    });
  }, []);
  /** Single seam for "this session is not the focused one": always the ref,
   *  plus pane state when it happens to be visible in a split pane. */
  const commitBackgroundMessages = useCallback((sid: string, next: Message[]) => {
    messagesCacheRef.current.set(sid, next);
    patchPane(sid, { messages: next });
  }, [patchPane]);
  const permissionRequest = currentSessionId
    ? permissionRequests[currentSessionId] || null
    : null;
  const [activeToolCall, setActiveToolCall] = useState<string | null>(null);
  /**
   * KIRO'S NATIVE SUBAGENTS, PER CHAT — the roster kiro sends, kept so the left rail can carry a tag
   * 「直到subagent被关掉」. Not derived from the transcript: subagent activity arrives under the child's
   * own ACP session id and used to be indistinguishable from the parent's own output.
   */
  const [subagents, setSubagents] = useState<Record<string, SubagentRow[]>>({});
  // Human-readable in-flight phase for the VIEWED session (send, backend
  // rebuild, executor attach, awaiting reply). Rendered in the chat so a slow
  // phase is never a silent UI freeze.
  const [activityStatus, setActivityStatus] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  // Agent execution plan (ACP `plan` update) for the viewed session. Replaced
  // wholesale on each plan update (ACP resends the full plan each time).
  const [plan, setPlan] = useState<PlanEntry[]>(() => (
    currentSessionId ? (parseTaskLists(uiGet(TASK_LISTS_KEY))[currentSessionId] || []) : []
  ));
  // Files the agent touched this turn (ACP tool_call locations + diff content),
  // for the viewed session. Ordered, deduped by path (latest diff wins).
  const [fileChanges, setFileChanges] = useState<ToolCall[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  /** 每个会话试过几次自动命名。标题由模型写；连着失败三次才退回「首条消息截断」 */
  const titleTriesRef = useRef<Map<string, number>>(new Map());
  // Cross-session context sync: the current session's linked sources (0..n).
  // Persistent per-session; each send injects only each source's NEW messages.
  const [contextLinks, setContextLinks] = useState<{ sourceId: string; sourceTitle: string }[]>([]);
  /* Chats a loop is running on -- a MIRROR of main (`loop:list-live` + `loop:changed`). The driver is in
     main (loopDriver.ts), so a reload does not stop it; this list is re-read rather than kept here. */
  const [loopingIds, setLoopingIds] = useState<string[]>([]);
  const loopingIdsRef = useRef<Set<string>>(new Set());

  const currentMessageRef = useRef<string>('');
  const toolCallsRef = useRef<Map<string, ToolCall>>(new Map());
  const currentSessionRef = useRef<string | null>(null);
  /**
   * 每条会话**最后一轮**怎么结束的 —— 给「钉住的会话闲下来发系统通知」用（见 `idleNotify.ts`）。
   * 新的一轮开始（`beginStreamingTurn`）时清掉；报错（`noteError` / 发送失败气泡）记成 error；
   * 用户自己点停止记成 cancelled（那种停下不发通知）。没有记录 = 正常结束。
   */
  const turnOutcomeRef = useRef<Map<string, TurnOutcome>>(new Map());
  /** Attribute an error banner to a chat, or clear it.
   *
   *  Falls back to the focused chat when the caller has no id, and only to
   *  `APP_ERROR_KEY` when there is no chat at all -- so a banner is bound to the chat
   *  it belongs to and never moves between panes when focus changes. Declared next to
   *  `currentSessionRef` because it reads it, and before every callback that lists it
   *  in a dependency array (those arrays are evaluated during render). */
  const noteError = useCallback((sid: string | null | undefined, raw: string | null) => {
    const key = sid || currentSessionRef.current || APP_ERROR_KEY;
    /* 去掉 Electron 包的那层「Error invoking remote method '…': Error: 」—— 横幅上只显示我们自己的那句 */
    const message = raw ? cleanIpcError(raw) : raw;
    /* 钉住这句的中英两版（主进程给的原因也认，见 messageVariants；系统原文认不出就原样）——
       切了语言，错误横幅按新语言显示（ChatArea 里 `shownIn`） */
    if (message) pinShown(message, messageVariants(message));
    if (message) turnOutcomeRef.current.set(key, { kind: 'error', message });
    setErrorBySession((prev) => {
      if (!message) {
        if (!(key in prev)) return prev;              // no-op keeps the object stable
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (prev[key] === message) return prev;
      return { ...prev, [key]: message };
    });
  }, []);
  const messagesCacheRef = useRef<Map<string, Message[]>>(new Map());
  const streamingIdsRef = useRef<Set<string>>(new Set());
  // Identifies the newest prompt for each session. A cancelled older prompt may
  // settle after its replacement starts; its cleanup must not clear the new
  // prompt's streaming state.
  const activePromptTokenRef = useRef<Map<string, symbol>>(new Map());
  // Attached-executor set (mirrors attachedSessionIds state).
  const attachedIdsRef = useRef<Set<string>>(new Set());
  /** last auto-recovery attempt per session (throttles reconnect-on-death). */
  const autoRecoverAtRef = useRef<Map<string, number>>(new Map());
  /** sessions currently switching model/Agent -- auto-recovery must skip them. */
  const reconfiguringRef = useRef<Set<string>>(new Set());
  /** Per-session backend occupancy pushed by main: 'turn' | 'reconfiguring' |
   *  'attaching' | 'priming'. Rendered on the sidebar dot + composer so an
   *  occupied session is visible BEFORE the user tries to act on it. */
  const [busyBySession, setBusyBySession] = useState<Record<string, string>>({});
  /**
   * **新建会话的启动阶段**（`createStages.ts` / main 的 `creationGate.ts`）：会话顶部那条「连接远端 → 检查环境 →
   * 启动引擎 → 就绪」、以及这时候发的消息进排队、就绪后自动发。点「新建」当场先填一份（主进程第一次推送前也看得见），
   * 之后以主进程推来的为准；窗口刷新后拿一次快照。「就绪」留一小会儿再摘掉。
   */
  const [createStages, setCreateStages] = useState<Record<string, CreateStageInfo>>({});
  /**
   * 刷新后的那份快照到了没有 —— 没到之前排空不能动：窗口刷新时恢复出来的排队消息会抢在快照前面发出去，
   * 而那条会话可能正失败着（实测：失败后刷新，横幅回来之前那条排队消息已经去连了一次）。
   */
  const [createStagesLoaded, setCreateStagesLoaded] = useState(!window.kiroApi?.getCreateStages);
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const take = (info: CreateStageInfo) => {
      setCreateStages((prev) => applyCreateStage(prev, info));
      if (info?.stage === 'ready') {
        const timer = setTimeout(() => { timers.delete(timer); setCreateStages((prev) => clearCreateStage(prev, info.sessionId, true)); }, 2500);
        timers.add(timer);
      }
    };
    const off = window.kiroApi.onCreateStage?.(take);
    void window.kiroApi.getCreateStages?.().then((list) => { for (const info of list || []) take(info); }).catch(() => {})
      .finally(() => setCreateStagesLoaded(true));
    return () => { off?.(); for (const timer of timers) clearTimeout(timer); };
  }, []);
  // Connecting (attaching) set (mirrors connectingSessionIds state).
  const connectingRef = useRef<Set<string>>(new Set());
  // When sessionId is missing from an update, use the last session we prompted
  // (not the currently viewed session). This prevents stale chunks from a
  // previous session bleeding into a newly created session.
  const lastPromptedSessionRef = useRef<string | null>(null);
  // Per-session usage (credits/context), keyed by sessionId.
  //
  // DURABLE. It used to live only in memory, so the composer's context gauge was
  // blank for every chat until that chat ran a fresh turn -- after a restart (or an
  // HMR reload of this hook) the model line showed just "claude-opus-5 · 1M" with no
  // percentage, even for a chat with a large history. The percentage is a property
  // of the conversation, not of the current window, so it is read back from disk.
  // Note the old on-disk copy was keyed by kiro-cli's UUID, which no longer maps to
  // anything the UI knows; this one is keyed by the stable KiroLex session id.
  const usageMapRef = useRef<Map<string, UsageView>>(new Map(readUsageMap()));
  /**
   * 上面那个 ref 的**反应式镜像** —— 流程图上每个节点要显示它那条会话的上下文占用
   * （「再加一个节点记录会话上下文占用情况的功能」），而 ref 变了不会触发重渲染。
   *
   * 只在**每一轮结束**时更新一次（`_kiro.dev/metadata` 一轮一条），不是逐 token，所以这份 state
   * 不会成为渲染负担。ref 保留：发消息那条路上要同步读它，不能等下一次渲染。
   */
  const [usageBySession, setUsageBySession] = useState<Record<string, { contextPercent: number; credits: number }>>(
    () => Object.fromEntries(readUsageMap()),
  );
  // Per-session native Task checklist (ACP `plan`), restored from shared on-disk ui-state.
  const taskListsRef = useRef<TaskLists>(parseTaskLists(uiGet(TASK_LISTS_KEY)));
  /**
   * 任务清单变了就 +1 —— 画布上那些节点不是焦点会话，没有别的办法知道它变了。
   *
   * 清单本身存在 ref 和 ui-state 里(它按会话存,而且要活过刷新);state 里只放一个计数,所以一次清单更新
   * 不会把整棵树的 props 换一遍。
   */
  const [taskListTick, setTaskListTick] = useState(0);
  /** 任一会话的任务清单 —— kiro 自己报的那份（ACP `plan`），一步跑了多久、勾到第几条，只有它说得清 */
  const taskListFor = useCallback(
    (sessionId?: string | null): PlanEntry[] => (sessionId ? (taskListsRef.current[sessionId] || []) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taskListTick],
  );
  const planMapRef = useRef<Map<string, PlanEntry[]>>(
    new Map(Object.entries(taskListsRef.current).map(([sessionId, tasks]) => [sessionId, tasks])),
  );
  // Per-session file-change tool calls this turn, keyed by sessionId.
  const fileChangesMapRef = useRef<Map<string, ToolCall[]>>(new Map());
  // Helper commands are advertised by each Kiro CLI agent process, not by the model.
  const commandsMapRef = useRef<Map<string, SlashCommand[]>>(new Map());
  // Maps sessionId -> model, so every call can route to the right kiro-cli process
  const sessionModelRef = useRef<Map<string, string>>(new Map());
  // Per-target-session context links: targetId -> array of { sourceId, sourceTitle, syncedCount }.
  // Each source keeps its own high-water mark so every send only forwards that
  // source's delta (new messages). A target can sync from multiple sources.
  const contextLinksRef = useRef<Map<string, { sourceId: string; sourceTitle: string; syncedCount: number }[]>>(new Map());
  // Duplicated sessions awaiting backend context injection on their first send.
  // Keyed by the duplicate's pending id -> the source session's message history.
  // On the first real send, this history is injected as a <hidden> priming block
  // so the freshly-created kiro-cli session inherits the full conversation context.
  const duplicateHistoryRef = useRef<Map<string, Message[]>>(new Map());
  /**
   * 每条会话里**本来就只在界面上**的消息 id（`/usage` 这类本地回显、复制会话带过来的历史）——
   * 切会话时和 store 对账（`messageReconcile`）不能把它们当成别的会话的丢掉。
   */
  const localOnlyIdsRef = useRef<Map<string, Set<string>>>(new Map());
  const markLocalOnly = (sid: string, ids: string[]) => {
    const set = localOnlyIdsRef.current.get(sid) || new Set<string>();
    for (const id of ids) set.add(id);
    localOnlyIdsRef.current.set(sid, set);
  };
  const moveLocalOnly = (from: string, to: string) => {
    const set = localOnlyIdsRef.current.get(from);
    if (!set) return;
    localOnlyIdsRef.current.delete(from);
    markLocalOnly(to, Array.from(set));
  };
  // Pending duplicate id -> source project. Keep this separate from React state so
  // an immediate first send cannot race the pending session render and lose the
  // source chat's project while materializing the backend session.
  const duplicateProjectRef = useRef<Map<string, string | undefined>>(new Map());
  // In-flight session creations, keyed by the pending tempId -> Promise<realId>.
  // Lets a send that happens before connection completes await the SAME creation
  // instead of racing a duplicate (which lost the message).
  const creatingRef = useRef<Map<string, Promise<string>>>(new Map());
  /** 新建没成的会话（主进程那边还没有记录）：怎么再建一次 —— 会话里点「安装」装好适配器之后用它重连（`reconnectAfterInstall`）。 */
  const failedCreateRef = useRef<Map<string, () => Promise<unknown>>>(new Map());
  /** 新建时传给主进程的那几样 —— 阶段条上「重试 / 改成本机运行」照它再建一次（`retryCreateSession`） */
  const createArgsRef = useRef<Map<string, CreateArgs>>(new Map());
  // Mid-turn steers written into a running turn but NOT yet consumed by the
  // agent, keyed by sessionId. Each entry keeps its optimistic user-message id
  // so `steer_consumed` can flip the badge to 'consumed', and turn-end can
  // reconcile any still-un-consumed steers back into the queue (never dropped).
  /*
    **没被吃的 steer 落盘** ——「steer 的内容和 queue 似乎不会被重试、rerun 或者恢复」。原来只在内存里：
    渲染层一重载或 app 一重启，还没被模型吃进去的 steer 就没了（既不在记录里，也没回到队列）。
    现在每次变动都写进 ui-state；启动时上一次留下的那些作为排队消息放回各自会话（见 takeOrphanSteers）。
    先读后写：上一次的那份要在第一次保存之前取走。
  */
  const orphanSteersRef = useRef<Record<string, { content: string; attachments: AttachedFile[]; msgId?: string }[]> | null>(null);
  if (orphanSteersRef.current === null) {
    try { orphanSteersRef.current = JSON.parse(uiGet(PENDING_STEERS_KEY) || '{}') || {}; } catch { orphanSteersRef.current = {}; }
  }
  /* 上一次没能追加、用户也还没选的 steer：原样读回来，读到会话记录时作为标红消息挂回那一轮（`withFailed`），不进队列 */
  const failedSteersRef = useRef<Map<string, FailedSteer[]> | null>(null);
  if (failedSteersRef.current === null) {
    failedSteersRef.current = new Map(Object.entries(parseFailedSteers<AttachedFile>(uiGet(FAILED_STEERS_KEY))));
  }
  const saveFailedSteers = () => {
    try {
      const out: Record<string, FailedSteer[]> = {};
      for (const [k, list] of failedSteersRef.current!) if (list.length) out[k] = list;
      if (Object.keys(out).length) uiSet(FAILED_STEERS_KEY, JSON.stringify(out));
      else uiRemove(FAILED_STEERS_KEY);
    } catch { /* 写不进去就只在内存里 */ }
  };
  /** 从盘上读回来的会话记录：把这条会话还没处理的失败 steer 作为标红消息挂回去（重启 / 刷新后仍由用户选） */
  /** 循环正在跑时那张折叠的校验卡片（每会话一张，见 `showVerdict`）：只在界面上，读盘时也要接回去。 */
  const liveLoopCardsRef = useRef<Map<string, Message>>(new Map());
  const withFailed = (sid: string, msgs: Message[]): Message[] => {
    const out = withFailedSteers(msgs, failedSteersRef.current!.get(sid), failedSteerMessage, steerInsertIndex);
    /* 循环的校验卡片不落盘（落盘的是结束那条提示）：从盘上读回这条会话时把它接在最后，不然一打开会话它就没了 */
    const card = liveLoopCardsRef.current.get(sid);
    return card && !out.some((m) => m.id === card.id) ? [...out, card] : out;
  };
  const pendingSteersRef = useRef<Map<string, PendingSteer<AttachedFile>[]>>(new PersistedSteerMap());
  /** 上一次运行留下、没被吃的 steer（每个会话一组）。只给一次：App 启动时把它们放进队列。 */
  const takeOrphanSteers = useCallback((): Record<string, { content: string; attachments: AttachedFile[]; msgId?: string }[]> => {
    const out = orphanSteersRef.current || {};
    orphanSteersRef.current = {};
    return out;
  }, []);
  /** Must equal `DEFAULT_MODEL` in src/main/config.ts.
   *
   *  It cannot be imported: main's tsconfig pins `rootDir: ./src/main`, so a shared
   *  module would move the whole emit layout. It is therefore duplicated and pinned
   *  by a test (tests/modelFallback.test.ts) instead — because it HAD already
   *  drifted: this said 'claude-opus-4.6' while main created every session on
   *  'claude-opus-5', so the selector could show a model no executor was running. */
  const DEFAULT_MODEL = 'claude-opus-5';

  // Always-fresh mirror of sessions for reads inside async callbacks (closures
  // otherwise capture a stale sessions array). Used to resolve a session's
  // authoritative projectId at prompt time.
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;
  const projectForSession = (sid: string | null): string | undefined =>
    sid ? sessionsRef.current.find((s) => s.id === sid)?.projectId : undefined;
  const permissionModeForSession = (sid: string | null): 'auto-approve' | 'ask' =>
    sid ? (sessionsRef.current.find((s) => s.id === sid)?.permissionMode || 'auto-approve') : 'auto-approve';
  /**
   * **attach 时报这条会话真正的工作目录**，不知道才退回 `'~'`。
   *
   * 这里原来**每一处**都硬写 `'~'`（十几处），而那不是一个选择，是"我不知道"。代价实测过一次：
   * 一条远程会话据此把整个家目录当项目推上了远端 —— 2.6→6.1 GB，里面有 `.aws/credentials`
   * 和 17 把私钥。主进程后来以记录里的 `localDir` 为准（`SessionRecord.localDir`）把这条路堵住了，
   * 但渲染层继续声称"家目录"仍然是个随时会被谁再信一次的谎。现在会话状态里有 `localDir`
   * （侧栏、会话界面那个 📂 都在用），所以照实说。
   */
  const attachCwdFor = (sid: string): string =>
    sessionsRef.current.find((s) => s.id === sid)?.localDir || '~';

  // Record/merge a file-touching tool call into a session's file-change list.
  // Deduped by toolCallId (a tool_call then its tool_call_update refer to the
  // same entry). Surfaces to the visible `fileChanges` state for the viewed session.
  const upsertFileChange = useCallback((sid: string, tc: ToolCall, isActive: boolean) => {
    const list = fileChangesMapRef.current.get(sid) || [];
    const idx = list.findIndex((t) => t.toolCallId === tc.toolCallId);
    const next = idx >= 0 ? [...list.slice(0, idx), tc, ...list.slice(idx + 1)] : [...list, tc];
    fileChangesMapRef.current.set(sid, next);
    if (isActive) setFileChanges(next);
  }, []);

  /** Rebuild a session's file-change list from its stored history.
   *
   *  Live turns fill this through upsertFileChange and NOTHING ever refilled it from
   *  disk, so after a restart the changed-files panel was empty for every existing
   *  chat — while the data was there the whole time (measured on one chat: 73 stored
   *  tool calls carrying 20 diffs and 36 location lists, none of it reachable).
   *  Same dedupe key as the live path so a chat reopened from disk and one watched
   *  live cannot disagree; anything already in the map is newer and wins. */
  const rebuildFileChanges = useCallback((sid: string, history: Message[], isActive: boolean) => {
    const byId = new Map<string, ToolCall>();
    for (const message of history) {
      for (const tc of message.toolCalls || []) {
        // File-touching calls only: `execute` with neither diffs nor locations is a
        // command, and the panel lists files, not commands.
        if (!tc?.toolCallId || !(tc.diffs?.length || tc.locations?.length)) continue;
        byId.set(tc.toolCallId, tc);
      }
    }
    if (byId.size === 0) return;   // never clobber a live list with an empty one
    for (const live of fileChangesMapRef.current.get(sid) || []) byId.set(live.toolCallId, live);
    const list = Array.from(byId.values());
    fileChangesMapRef.current.set(sid, list);
    if (isActive) setFileChanges(list);
  }, []);

  const persistContextLinks = () => {
    try {
      uiSet(
        'kirolex-context-links',
        JSON.stringify(Array.from(contextLinksRef.current.entries()))
      );
    } catch {}
  };

  const refreshContextLinks = (sid: string | null) => {
    const arr = contextLinksRef.current.get(sid || '') || [];
    const view = arr.map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle }));
    if (!sid || currentSessionRef.current === sid) setContextLinks(view);
    patchPane(sid, { contextLinks: view });
  };

  const addStreaming = (sid: string) => {
    if (!sid) return;
    if (!streamingIdsRef.current.has(sid)) {
      streamingIdsRef.current.add(sid);
      setStreamingIds(Array.from(streamingIdsRef.current));
    }
  };
  const removeStreaming = (sid: string | null) => {
    if (!sid) return;
    /*
      排在后面的那一轮已经接手了（onMainTurn 的 handoff 那段）、而且还没结束：这一轮收尾，流转给它，不放掉。
      它要是已经结束了（busy 先一步不再是 'turn'），pending 在那时就作废了，这里照常收掉（`handoffAdoption.ts`）。
    */
    if (onOwnTurnEnd(adoptionRef.current, sid, streamingIdsRef.current.has(sid)) === 'keep-streaming') {
      setSessionActiveTool(sid, null);
      setSessionStall(sid, null);
      return;
    }
    // A turn cannot have a tool in flight once it is over. Clearing here is the
    // authoritative fix for a stale "Running: ..." label that outlived its turn
    // (kiro-cli does not always send a terminal tool_call_update).
    setSessionActiveTool(sid, null);
    // Same reasoning for the stall warning: it describes a RUNNING turn, so it must
    // not survive the turn it describes.
    setSessionStall(sid, null);
    if (streamingIdsRef.current.delete(sid)) {
      setStreamingIds(Array.from(streamingIdsRef.current));
    }
    /* 这一轮期间攒着的 KiroLex 提示（见 onUserMessage）现在插进去 */
    const held = heldNotesRef.current.get(sid);
    if (held?.length) {
      heldNotesRef.current.delete(sid);
      showLiveNotes(sid, held);
    }
  };
  /**
   * 这一轮结束 / 被停止：还挂着的权限卡片收掉（审计 2.1）—— 它答的那个请求已经没人等了。
   * 只在这一轮真的结束了才收（`removeStreaming` 把流转给了接手的那一轮时不收：卡片可能是那一轮的）。
   * 不放进 `removeStreaming` 本身：「上一轮还在收尾、这条没发出去」那条也调它，那时上一轮可能正等你批准。
   */
  const dropPermissionCardIfEnded = (sid: string | null) => {
    if (!sid || streamingIdsRef.current.has(sid)) return;
    setPermissionRequests((current) => withoutPermissionCard(current, sid));
  };
  /** 流式输出期间到达的 KiroLex 提示，按会话攒着，这一轮结束再插（`removeStreaming`） */
  const heldNotesRef = useRef<Map<string, Message[]>>(new Map());
  /** 把几条 KiroLex 提示插进那条会话的消息列表（判据在 `noticeMerge.withLiveNote`：重复的、没读过历史的不插） */
  const showLiveNotes = (sid: string, notes: Message[]) => {
    /* 正看着的这条会话历史还没进列表（启动时那条、空记录）：下面插不进去 —— 读回盘上的历史，提示已经落盘、就在里面 */
    const unloaded = currentSessionRef.current === sid && !creatingRef.current.has(sid)
      && !(messagesCacheRef.current.get(sid) || []).length;
    for (const note of notes) {
      /* 主进程推给这条会话的提示：切会话对账时认它（没落盘的也不当成别人的） */
      markLocalOnly(sid, [note.id]);
      mutateSessionMessagesRef.current?.(sid, (cur) => withLiveNote(cur, note, creatingRef.current.has(sid)) ?? cur);
    }
    if (!unloaded) return;
    void (async () => {
      let transcript: any;
      try { transcript = await window.kiroApi.readTranscript(sid); } catch { return; }
      if (!Array.isArray(transcript) || !transcript.length) return;
      const stored = withFailed(sid, transcript.map(messageFromStored));
      const wasEmpty = !(messagesCacheRef.current.get(sid) || []).length;
      mutateSessionMessagesRef.current?.(sid, (cur) => notesAfterReload(cur, stored, notes) ?? cur);
      if (wasEmpty) rebuildFileChanges(sid, stored, currentSessionRef.current === sid);
    })();
  };
  const beginStreamingTurn = (sid: string) => {
    const token = Symbol(sid);
    activePromptTokenRef.current.set(sid, token);
    // Single seam for "a turn is starting", so a stall notice from the previous
    // attempt is retired here rather than lingering over a healthy turn.
    setSessionStall(sid, null);
    // Same reasoning for the "interrupted, awaiting an overwrite" state, and it is
    // not just cosmetic. That state means "the next composer submit will truncate
    // back to that user message and rerun it". Once a new turn is under way that
    // promise is both untrue and unsafe: untrue because while a turn streams the
    // composer STEERS (or queues) instead of overwriting, and unsafe because
    // honouring it later would truncate away the turn that ran in between.
    //
    // Without this the state had only one exit -- an overwriting submit -- which
    // cannot happen while a turn is running, so after an auto-resend or an
    // auto-recovery the banner sat there permanently contradicting the composer's
    // own hint line.
    clearInterrupted(sid);
    turnOutcomeRef.current.delete(sid);
    addStreaming(sid);
    return token;
  };
  /**
   * 自动命名。触发条件只有一条:**名字还是 New Chat**。
   *
   * 挂在 `finishStreamingTurn` 上,因为它是**所有**投递路径在 finally 里都会经过的唯一汇合点,
   * 而且 token 守卫保证一轮只过一次。上一版把这段写在 `sendMessage` 尾部 —— 于是三条投递路径里
   * 只有「直接发送」那一条会命名:
   *   第一条消息发进正在 attaching 的新会话 → `handleSendMessage` 转进队列 → 走 `sendQueuedMessage`
   *   后续消息在turn运行中发出 → 走 `handleSteerMessage`
   * 这两条都不经过那个尾部,会话就一直顶着 New Chat。实测 s_1787035165637 两轮都干净结束
   * (`stopReason: end_turn`)却仍未命名,就是这个原因;主进程那半边是好的(同一条 lite 通道的
   * suggestions 一直在成功,单独复现 title 调用也能拿到正常标题)。
   *
   * 生成成功才改名。失败就继续叫 New Chat —— 下一轮还会再试;连 MAX_TITLE_TRIES 次都失败,才退回
   * 截断首条消息(那时它已经不叫 New Chat,规则自洽)。截断从来不是标题:遇到「帮我看一下这个」
   * 就等于没有名字,所以它只能是最后手段。
   */
  const MAX_TITLE_TRIES = 3;
  const maybeAutoTitle = (sid: string | null) => {
    if (!sid) return;
    const record = sessionsRef.current.find((s) => s.id === sid);
    if (!record) return;
    /* flow 自己的会话不参与:它的名字是**结构性**的(「流程主会话 · 周报」/「周报 · 收集素材」),
       由 KiroLex 给;让模型按第一条提示词起名,只会把它改成一句无意义的摘要,而那第一条恰好是
       几千字的生成提示词。 */
    if (record.purpose === 'skill' || record.purpose === 'flow-main' || record.purpose === 'flow-worker') return;
    if (!/^New Chat\b/.test((record.title || '').trim())) return;
    const cached = messagesCacheRef.current.get(sid) || [];
    // 材料用**第一条用户消息**:话题在那儿,不是这一轮说的什么。
    /* KiroLex 自己的提示（也是 role:user，例如新建时插进来的换模型那句）不算 —— 见 `titleSource` */
    const firstUser = firstUserText(cached);
    if (!firstUser) return;
    const tries = titleTriesRef.current.get(sid) || 0;
    if (tries >= MAX_TITLE_TRIES) return;
    titleTriesRef.current.set(sid, tries + 1);
    const firstAssistant = cached
      .filter((m) => m.role === 'assistant' && !m.content.startsWith('💭 ') && !m.content.startsWith('🔧 '))
      .map((m) => m.content).pop();
    // 只在它仍然叫 New Chat 时写:这中间你可能已经自己改过名字。
    const stillNew = () => /^New Chat\b/.test((sessionsRef.current.find((s) => s.id === sid)?.title || '').trim());
    /* 两条写入口(模型给的名字、截断兜底)都走这里,而它**落盘** —— 原来直接 setSessions,
       侧栏显示得好好的,磁盘记录里却还是 New Chat,重启后就认不出这条会话。 */
    const applyTitle = (title: string) => {
      setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, title } : s)));
      void window.kiroApi.renameSessionOnDisk?.(sid, title);
    };
    const fallBackToTruncation = () => {
      if (tries + 1 < MAX_TITLE_TRIES) return;
      const truncated = firstUser.slice(0, 40);
      if (truncated) applyTitle(truncated);
    };
    window.kiroApi.generateTitle?.(firstUser, firstAssistant, sid).then((r) => {
      if (!stillNew()) return;
      /* 这条会话的引擎不跑辅助小任务（Claude Code / Codex，见主进程 `skipLiteHelperFor`）：不用再试，直接取第一条消息 */
      if (r?.skipped === 'engine') {
        titleTriesRef.current.delete(sid);
        const truncated = firstUser.slice(0, 40);
        if (truncated) applyTitle(truncated);
        return;
      }
      if (r?.title) {
        applyTitle(r.title);
        titleTriesRef.current.delete(sid);
        return;
      }
      fallBackToTruncation();
    }).catch(() => {
      if (stillNew()) fallBackToTruncation();
    });
  };

  const finishStreamingTurn = (sid: string | null, token: symbol) => {
    if (!sid || activePromptTokenRef.current.get(sid) !== token) return;
    activePromptTokenRef.current.delete(sid);
    removeStreaming(sid);
    dropPermissionCardIfEnded(sid);
    maybeAutoTitle(sid);
  };

  const addAttached = (sid: string) => {
    if (!sid) return;
    /* 连上了（不管经哪条路）：启动失败的横幅收掉，排队的才能发（`settleStageOnAttach`） */
    setCreateStages((prev) => settleStageOnAttach(prev, sid, creatingRef.current.has(sid)));
    if (!attachedIdsRef.current.has(sid)) {
      attachedIdsRef.current.add(sid);
      setAttachedSessionIds(Array.from(attachedIdsRef.current));
    }
  };
  const removeAttached = (sid: string | null) => {
    if (!sid) return;
    if (attachedIdsRef.current.delete(sid)) {
      setAttachedSessionIds(Array.from(attachedIdsRef.current));
    }
  };

  const markHistoryLoading = (sid: string) =>
    setHistoryLoadingIds((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
  const clearHistoryLoading = (sid: string) =>
    setHistoryLoadingIds((prev) => (prev.includes(sid) ? prev.filter((id) => id !== sid) : prev));

  const markConnecting = (sid: string | null) => {
    if (!sid) return;
    if (!connectingRef.current.has(sid)) {
      connectingRef.current.add(sid);
      setConnectingSessionIds(Array.from(connectingRef.current));
    }
  };
  const clearConnecting = (sid: string | null) => {
    if (!sid) return;
    if (connectingRef.current.delete(sid)) {
      setConnectingSessionIds(Array.from(connectingRef.current));
    }
  };

  const modelForSession = (sid: string | null): string => {
    if (!sid) return DEFAULT_MODEL;
    return sessionModelRef.current.get(sid) || DEFAULT_MODEL;
  };

  // Record which phase a session is in. Only surfaced for the viewed session;
  // background sessions keep their phase in the map for when you switch to them.
  const activityMapRef = useRef<Map<string, string>>(new Map());
  const setSessionActivity = (sid: string | null, text: string | null, variants?: { zh: string; en: string }) => {
    if (!sid) return;
    /* 钉住这句的中英两版：界面切了语言，还挂着的这句（当前会话和分屏后台会话）显示时按新语言取（`shownIn`） */
    if (text) pinShown(text, variants);
    if (text) activityMapRef.current.set(sid, text);
    else activityMapRef.current.delete(sid);
    if (currentSessionRef.current === sid) setActivityStatus(text);
    patchPane(sid, { activity: text });
  };

  // Live stall state PER SESSION, same shape as the activity line above: a map so a
  // background session keeps it for when you switch to it, plus plain state for the
  // focused one. REPLACED on every watchdog tick, so the elapsed time and the
  // countdown on screen stay truthful for as long as the turn stays quiet.
  const stallMapRef = useRef<Map<string, TurnStall>>(new Map());
  const [turnStall, setTurnStall] = useState<TurnStall | null>(null);
  const setSessionStall = (sid: string | null, info: TurnStall | null) => {
    if (!sid) return;
    if (info) stallMapRef.current.set(sid, info);
    else if (!stallMapRef.current.delete(sid)) return;   // nothing to clear
    if (currentSessionRef.current === sid) setTurnStall(info);
    patchPane(sid, { stall: info });
  };

  // In-flight tool title PER SESSION. Kept in a map (not just the viewed
  // session's state) so a tool that finishes while you are looking at another
  // session still gets cleared -- otherwise its title stuck on the composer
  // forever and hid the usage/credits widgets.
  const activeToolMapRef = useRef<Map<string, string>>(new Map());
  const setSessionActiveTool = (sid: string | null, title: string | null) => {
    if (!sid) return;
    if (title) activeToolMapRef.current.set(sid, title);
    else activeToolMapRef.current.delete(sid);
    if (currentSessionRef.current === sid) setActiveToolCall(title);
    patchPane(sid, { activeTool: title });
  };

  // Cancel-restore: when a turn is cancelled, the interrupted user prompt (incl.
  // same-turn steers, which are merged into the one user bubble) is pushed back
  // into the composer via this draft, and overwriteTargetRef remembers the
  // interrupted user message so the NEXT submit overwrites (reruns) that turn.
  const [restoredInputDraft, setRestoredInputDraft] = useState<{ id: number; text: string; sessionId?: string } | null>(null);
  const overwriteTargetRef = useRef<Map<string, string>>(new Map());
  /** Sessions whose last turn was INTERRUPTED and is awaiting an overwrite by the
   *  next composer submit. Rendered so per-message Rerun can be blocked: the
   *  documented recovery for an interrupted turn is "resubmit in the composer",
   *  not a per-message rerun. */
  const [interruptedSessionIds, setInterruptedSessionIds] = useState<string[]>([]);
  const markInterrupted = (sid: string, msgId: string) => {
    overwriteTargetRef.current.set(sid, msgId);
    setInterruptedSessionIds((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
  };
  const clearInterrupted = (sid: string) => {
    overwriteTargetRef.current.delete(sid);
    setInterruptedSessionIds((prev) => (prev.includes(sid) ? prev.filter((id) => id !== sid) : prev));
  };

  /** Record that this chat's last turn was CUT SHORT, and offer its prompt back.
   *
   *  One implementation for all three ways a turn can be cut: the user pressing Stop, the
   *  executor dying mid-turn, and the watchdog interrupting a silent turn. The third one
   *  used to do NOTHING here -- `onTurnWedged` returned early whenever the turn had
   *  produced something -- so a turn KiroLex had just killed was indistinguishable from a
   *  completed one: no banner, nothing back in the composer, and per-message Rerun still
   *  offered even though resubmitting in the composer is the documented recovery. The
   *  wedge note inside the message was the only trace.
   *
   *  Anchored to the turn's BASE user message, never a steer: steers are optimistic-only
   *  in the view and get stripped when un-consumed ones are re-queued, so an overwrite
   *  target pointing at one fails to resolve.
   *
   *  @param prefill Put the prompt back in the composer. False for the auto-resend path,
   *    where the question is already being retried and text sitting in the box would
   *    invite sending it twice.
   */
  const markTurnInterrupted = (sid: string, opts?: { prefill?: boolean }) => {
    const msgs = messagesCacheRef.current.get(sid) || [];
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user' && !msgs[i].steer && !isKirolexNote(msgs[i])) { idx = i; break; }
    }
    if (idx < 0) return;
    markInterrupted(sid, msgs[idx].id);
    if (opts?.prefill === false) return;
    /* 连同这一轮已经吃进去的 steer 一起放回去（原来只放基础那条，steer 跟着被覆盖掉了） */
    const text = withConsumedSteers(msgs, idx);
    if (text.trim()) {
      setRestoredInputDraft({ id: Date.now(), text, sessionId: sid });
    }
  };

  // Sessions already examined for an interrupted turn this run, so recovery runs at
  // most once per chat.
  const recoveryCheckedRef = useRef<Set<string>>(new Set());
  /** 每条会话因"静默太久"被自动续写了几次（用户自己发一条就清零）；上限是 autoRetryMax()。 */
  const wedgeContinuesRef = useRef<Map<string, number>>(new Map());
  /** 正在由自动续写发出的那一条 —— sendMessage 见到它就不清零上面那个计数。 */
  const autoContinueInFlightRef = useRef<Set<string>>(new Set());
  /** A turn that never got a reply — the app quit (or crashed) while it was running.
   *  Recovery RESENDS it automatically: the transcript is truncated back to before
   *  that user message and the same prompt (with its attachments and paste refs) is
   *  sent again on the live executor, so the chat continues by itself instead of
   *  leaving a dangling question. Only ever for the chat that is currently open, and
   *  only once per run. */
  /** Sessions whose pending auto-resend should stop waiting (e.g. user took over). */
  const recoveryCancelledRef = useRef<Set<string>>(new Set());
  /**
   * 正在自动重发（或等重连之后重发）的会话。App 的队列在这期间**不发** —— 否则排着的那条会
   * 抢在重发前面落进记录，没答的问题从此被它顶掉（「queue 似乎不会被重试、rerun 或者恢复」）。
   * 是 state 不是只有 ref：结束时要让队列那个 effect 重新跑一次。
   */
  const recoveringRef = useRef<Set<string>>(new Set());
  const [recoveringIds, setRecoveringIds] = useState<string[]>([]);
  const markRecovering = (sid: string, on: boolean): void => {
    if (on) recoveringRef.current.add(sid); else recoveringRef.current.delete(sid);
    setRecoveringIds(Array.from(recoveringRef.current));
  };
  /** Sessions we already asked main to rebuild, so the backstop fires once. */
  const primeKickedRef = useRef<Set<string>>(new Set());
  /** Live mirror of which sessions are in a history-rebuild state. Background
   *  flows (auto-resend) consult this so they never overwrite the rebuild's
   *  status line -- that clobbering is why the rebuild looked invisible. */
  const primeStateRef = useRef<Map<string, string>>(new Map());
  const isRebuilding = useCallback((sid: string) => {
    const s = primeStateRef.current.get(sid);
    return s === 'priming' || s === 'prime-pending';
  }, []);
  /** Is this chat ON SCREEN right now -- focused, or one of the split panes?
   *
   *  The old test was `sid === currentSessionRef.current`, which failed twice over.
   *  A split pane is fully visible and fully usable, yet never qualified: an
   *  unanswered question sat there forever because the FOCUSED chat happened to be a
   *  different one. And `currentSessionRef` is synced in an effect, so during
   *  switchSession it still holds the PREVIOUS id -- the check ran against the chat
   *  the user just left. Callers that know which chat is being opened pass
   *  `assumeCurrent`. */
  const isVisibleSession = (sid: string): boolean => {
    if (sid === currentSessionRef.current) return true;
    try {
      const raw = uiGet('kirolex-split-session');
      if (raw) {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids) && ids.includes(sid)) return true;
      }
    } catch {}
    return false;
  };
  /**
   * Chats whose CURRENT stream was adopted rather than started here.
   *
   * A turn this window sent clears its own `streamingIds` entry when its `acp:prompt` invoke
   * resolves. An adopted turn was sent by a window that no longer exists, so there is no
   * promise to await: main's busy event is the only end-of-turn signal, and without honouring
   * it the chat would stream forever with its composer locked.
   */
  const adoptedTurnsRef = useRef<Set<string>>(new Set());
  /** 交给适配器排着的那一轮已经接手、而这个窗口自己的上一轮还没收尾 —— 收尾时转成接管（`removeStreaming`） */
  const handoffAdoptRef = useRef<Set<string>>(new Set());
  /** 上面两样合起来交给 `handoffAdoption.ts` 的判据（同一对 Set，不是拷贝） */
  const adoptionRef = useRef<AdoptionState>({ pending: handoffAdoptRef.current, adopted: adoptedTurnsRef.current });

  /** Take over an in-flight turn: show what it has produced, and let its chunks through. */
  const adoptTurn = (sid: string, peek: TurnPeek) => {
    adoptedTurnsRef.current.add(sid);
    addStreaming(sid);
    // Order matters: streaming FIRST, then paint. The chunk handler drops anything arriving
    // while the chat is not marked streaming, and a chunk dropped before the seed would leave
    // a hole that only `acp:assistant-final` could heal.
    if (peek.text) mutateSessionMessagesRef.current?.(sid, (current) => adoptedMessages(current, peek));
    setSessionActivity(sid, t('⏳ The previous turn is still running; reattached to its reply (not resent)'));
  };

  /**
   * 读盘，和这条会话的消息缓存对账；对不上就换成 store 的（判据见 messageReconcile）。
   * 返回对过账的列表和 store 里的 id；读不到、读盘期间缓存动过、或这时在跑一轮 → `null`（没法确认，调用方别动）。
   */
  const reconcileCacheFromStore = async (sid: string): Promise<{ messages: Message[]; storedIds: Set<string> } | null> => {
    const before = messagesCacheRef.current.get(sid);
    let transcript: any;
    try { transcript = await window.kiroApi.readTranscript(sid); } catch { return null; }
    /* 读到空数组也对账：新会话还没落盘时缓存里全是别人的，也要清回空的 */
    if (!Array.isArray(transcript)) return null;
    /* 读盘期间这条会话动过（来了消息、开始一轮）就不碰 —— 对账只针对读盘前那一份 */
    if (messagesCacheRef.current.get(sid) !== before || streamingIdsRef.current.has(sid)) return null;
    const storedIds = new Set<string>(transcript.map((m: any) => m?.id));
    const cached = before || [];
    const reconciled = reconcileWithStore(cached, transcript.map(messageFromStored), localOnlyIdsRef.current.get(sid));
    if (!reconciled) return { messages: cached, storedIds };
    const healed = withFailed(sid, reconciled);
    console.warn('[kirolex] message cache did not match the store; reloaded from the transcript', {
      sessionId: sid, cached: cached.length, stored: transcript.length,
    });
    /* 进主进程日志，而且说出**外来的消息是谁的**：在别的会话的缓存里找同 id 的（只记 id 和条数） */
    try {
      const keptIds = new Set(healed.map((m) => m.id));
      const foreign = cached.filter((m) => !keptIds.has(m.id));
      const owners: Record<string, number> = {};
      for (const m of foreign) {
        let owner = '(没有别的会话缓存里有它)';
        for (const [other, list] of messagesCacheRef.current) {
          if (other !== sid && list.some((x) => x.id === m.id)) { owner = other; break; }
        }
        owners[owner] = (owners[owner] || 0) + 1;
      }
      window.kiroApi.diagSessionView?.('cache reloaded from store', {
        sessionId: sid, creating: creatingRef.current.has(sid), focused: currentSessionRef.current === sid,
        cached: cached.length, stored: transcript.length, dropped: foreign.length,
        droppedIds: foreign.slice(0, 6).map((m) => `${m.role}:${m.id}`), droppedOwners: owners,
      });
    } catch { /* 诊断不能影响对账 */ }
    messagesCacheRef.current.set(sid, healed);
    patchPane(sid, { messages: healed });
    rebuildFileChanges(sid, healed, currentSessionRef.current === sid);
    if (currentSessionRef.current === sid) setMessages(healed);
    return { messages: healed, storedIds };
  };
  /**
   * **自动重发前确认这条问题是这条会话的** —— 恢复是在某一刻的缓存上捕获的（断线恢复、切会话），那份缓存
   * 可能被别的会话的消息污染过：照发就是把别人的问题当成这条会话的重发，`rerunFromMessage` 还会把
   * 截短后的污染历史写进这条会话的 transcript。所以先和 store 对账（顺带把缓存修好），只有那条用户消息
   * 在这条会话的 store 里（或是这条会话自己登记的、没落盘的那条）才重发；没法确认就这次不发、下次再查。
   */
  const recoveryTargetIsOwn = async (sid: string, targetId: string): Promise<boolean> => {
    const verified = await reconcileCacheFromStore(sid);
    return !!verified
      && verified.messages.some((m) => m.id === targetId)
      && (verified.storedIds.has(targetId) || !!localOnlyIdsRef.current.get(sid)?.has(targetId));
  };

  const recoverInterruptedTurn = (sid: string, msgs: Message[], opts?: {
    assumeCurrent?: boolean;
    /** 已知这一轮被**非人为**打断（执行器死了）：哪怕已经吐出半截回复也重跑这一轮。 */
    interrupted?: boolean;
  }) => {
    if (!sid || sid.startsWith('pending_')) return;
    // Only ever for chats the user can SEE. Doing it for every hydrated session at
    // startup would fire a dozen billable turns at once. Not marking it checked here
    // means the check runs again when the user actually opens that chat.
    if (!opts?.assumeCurrent && !isVisibleSession(sid)) return;
    if (recoveryCheckedRef.current.has(sid)) return;
    recoveryCheckedRef.current.add(sid);
    // Opt-out lives in Settings ("重启后自动重发未完成的提问"). Read from the persisted
    // settings object: this hook runs outside App's settings state.
    // Read, but NOT acted on here: returning early made the peek below unreachable, so a live
    // turn could never be adopted in a window with auto-resend switched off -- and the answer
    // that window was already paying for stayed invisible. The decision gates the SEND on it.
    let resendDisabled = false;
    try {
      const raw = uiGet('kirolex-settings');
      resendDisabled = !!raw && JSON.parse(raw)?.recoverInterruptedTurns === false;
    } catch { /* default: enabled */ }
    if (streamingIdsRef.current.has(sid)) return;      // still running — not interrupted
    if (overwriteTargetRef.current.has(sid)) return;   // already flagged
    // A loop owns this chat (main drives its rounds): never re-send here -- see below.
    const loopOwned = loopingIdsRef.current.has(sid);
    if (sessionsRef.current.find((s) => s.id === sid)?.archived) return; // archived chats are inert
    // Walk back over live-only thinking segments AND KiroLex's own notes (「✅ 已按意见改了…」
    // is not a question); a real assistant reply means the turn completed. With `interrupted`
    // a half-written reply is skipped too (rerun overwrites it). See `findRecoveryTarget`.
    const found = findRecoveryTarget(msgs, { interrupted: opts?.interrupted });
    if (found.kind === 'none') return;
    if (found.kind === 'answered') {
      /*
        **最后一条是助手消息 ≠ 这一轮答完了** —— 实测 ONTAP 那条：一轮跑到一半（已经
        local_write 了两个文件、落盘了半截回复）时窗口 reload，这里只看"最后一条是谁"就当成
        答完了直接 return，根本没去 peek —— 后端那一轮其实还在跑，窗口却不认领它：不显示在跑、
        Stop 不可用，后来超时中断后的自动续写也因为"窗口以为没在跑"而抢在 cancel 收尾前发出、
        被拒。所以先问一句 main：还在跑就认领（不重发、不计次数），不在跑才算答完。
      */
      void (async () => {
        let peek: TurnPeek | null = null;
        try { peek = (await window.kiroApi.peekTurn?.(sid)) ?? null; } catch { peek = null; }
        if (peek?.live && !streamingIdsRef.current.has(sid)) { adoptTurn(sid, peek); return; }
        // Answered. Clear this chat's resend ledger entry: it exists only to stop a
        // resend from firing twice, and once a reply is in there is nothing to guard.
        // Leaving it behind is what made the guard permanent -- see below.
        void window.kiroApi.setAutoResent?.(sid, '');
      })();
      return;
    }
    // Anchored to the turn's BASE user message (steers are merged into it on disk, separate in memory).
    const base = found.base;
    const target = msgs[base];
    /*
      **循环的一轮（id `loop_…`）、或者被循环占着的会话：不重发，只认领还在跑的那一轮**。
      循环的轮次归主进程的幂等账本（loopDriver.ts）：重启后「已落地 / 没开始 / in-doubt」由它按 transcript 判；
      这里重发会换一个新 id，正好绕过账本，把一轮可能已经做过的事再做一遍。窗口刷新时那一轮多半还在主进程里跑 —— 照样认领显示。
    */
    if (loopOwned || isLoopRoundMessageId(target?.id)) {
      void (async () => {
        let peek: TurnPeek | null = null;
        try { peek = (await window.kiroApi.peekTurn?.(sid)) ?? null; } catch { peek = null; }
        if (peek?.live && !streamingIdsRef.current.has(sid)) adoptTurn(sid, peek);
      })();
      return;
    }
    /* 侧栏 review 的改写中断了不回填 —— 见 `isReviseRequest`。要改就回侧栏再按一次「✓ 确认」 */
    if (isReviseRequest(target.content)) return;
    /* 重发的是**基础那条 + 这一轮已经吃进去的 steer**（原来只发基础那条，steer 就丢了）；KiroLex 的提示不拼进去 */
    const resendText = withConsumedSteers(msgs, base);
    /* 这期间队列不许抢着发 —— 否则排队那条会落在没答的问题后面，把它永远顶掉 */
    markRecovering(sid, true);
    // Fire-and-forget. Progress shows as the session's activity line, NOT an error
    // banner — nothing failed here.
    void (async () => {
     try {
      /*
        计数按**基础那条的第一行**算：重发会建一条新的用户消息（id 变了），而重启后 steer 又会并进
        content（全文变了）—— 按这两样算，次数每次都清零，10 次的上限就永远到不了。第一行两种情况下都不变。
      */
      const key = autoResendKey(target.content.split('\n')[0]);
      let attempts = 0;
      try {
        // Durable de-dup, but COUNTED. It used to store the bare key and refuse
        // forever after: one resend whose own turn got interrupted (a crash, or the
        // dev supervisor restarting the app) permanently disabled recovery for that
        // prompt -- the chat went idle and green and still never retried, with no
        // way to tell why. So: allow a bounded number of automatic attempts, and
        // clear the entry once the prompt is finally answered (above).
        const seen = await window.kiroApi.getAutoResent?.();
        const record = seen?.[sid];
        if (record) {
          const [seenKey, seenCount] = String(record).split('#');
          if (seenKey === key) {
            attempts = Number(seenCount) || 1;
            // NOT an early return any more: a spent budget must still be able to ADOPT a live
            // turn (that costs nothing). `decideTurnRecovery` stands down on it instead.
          }
        }
      } catch { /* if the guard is unavailable, still only once per run */ }

      // The BACKEND may still be finishing the previous turn (or compacting) right
      // after a restart. Prompting then is rejected with "Wait for the active turn
      // ... to finish", which surfaced as a raw IPC error inside the chat. Wait for
      // it to go idle instead, and give up quietly rather than firing a doomed send.
      const waitForIdle = async (): Promise<boolean> => {
        for (let attempt = 0; attempt < 20; attempt++) {           // ~60s
          if (recoveryCancelledRef.current.has(sid)) return false;
          let busy = false;
          try {
            const map = await window.kiroApi.getBusyMap?.();
            const reason = map?.[sid];
            // A history rebuild is NOT a reason to wait here: main serialises it
            // (acp:prompt awaits the rebuild, then sends). Counting it as busy made
            // this poll burn its 60s and then give up QUIETLY, so the interrupted
            // question was never resent and nothing said why.
            busy = isBackendOccupied(reason) && reason !== 'priming' && reason !== 'prime-pending';
          } catch { /* treat as idle if unknown */ }
          if (!busy && !streamingIdsRef.current.has(sid)) return true;
          // Never overwrite the rebuild's own progress line.
          // NOT "上一轮仍在收尾" any more: a live turn is adopted before this branch can be
          // reached, so what is being waited on here is an attach, a history rebuild or a
          // model/agent switch — never the previous turn.
          if (!isRebuilding(sid)) setSessionActivity(sid, t('⏳ Session busy (connecting or rebuilding history); will resend shortly…'));
          await new Promise((r) => setTimeout(r, 3000));
        }
        return false;
      };
      /**
       * ADOPT, WAIT, OR RESEND -- asked of main rather than guessed at.
       *
       * The old code went straight to `waitForIdle` and then resent. But "the previous turn is
       * still wrapping up" does not mean the answer was lost: main is still receiving it and
       * will flush it to the transcript. Resending then buys a second copy of an answer already
       * being paid for, and can land two replies under one question.
       *
       * Two rounds: the first decides on the state as it is now; if that state is a non-turn
       * occupation (attach, history rebuild) we wait it out and decide ONCE more -- a turn may
       * have started in the meantime, and it must be adopted rather than raced.
       */
      let adopted = false;
      for (let round = 0; round < 2 && !adopted; round++) {
        let peek: TurnPeek | null = null;
        try { peek = (await window.kiroApi.peekTurn?.(sid)) ?? null; } catch { peek = null; }
        let busyReason: string | null = null;
        try { busyReason = (await window.kiroApi.getBusyMap?.())?.[sid] ?? null; } catch {}

        const decision = decideTurnRecovery({
          peek,
          busyReason,
          streaming: streamingIdsRef.current.has(sid),
          cancelled: recoveryCancelledRef.current.has(sid),
          resendDisabled: resendDisabled || autoRetryMax() === 0,
          attempts,
          maxAttempts: autoRetryMax(),
        });

        if (decision.action === 'adopt' && peek) {
          // Take ownership of the running stream: mark the chat streaming so the chunk handler
          // stops dropping its chunks, and paint what has been produced so far. No resend, and
          // no attempt charged -- nothing was sent.
          adoptTurn(sid, peek);
          adopted = true;
          break;
        }
        if (decision.action === 'stand-down') {
          if (!isRebuilding(sid)) setSessionActivity(sid, null);
          recoveryCheckedRef.current.delete(sid);
          return;
        }
        if (decision.action === 'wait') {
          if (!(await waitForIdle())) {
            if (!isRebuilding(sid)) setSessionActivity(sid, null);
            recoveryCheckedRef.current.delete(sid);   // allow another attempt later
            return;
          }
          continue;   // re-decide: the wait may have ended in a turn worth adopting
        }
        break;        // 'resend'
      }
      if (adopted) return;

      try { await window.kiroApi.setAutoResent?.(sid, `${key}#${attempts + 1}`); } catch {}
      if (!isRebuilding(sid)) setSessionActivity(sid, t('⏳ Resending the unfinished turn… (attempt {n}/{max})', { n: attempts + 1, max: autoRetryMax() }));
      /* 重试之间退避一下：执行器刚死就立刻重发，多半撞上同一个原因 */
      if (attempts > 0) await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * attempts)));
      if (recoveryCancelledRef.current.has(sid)) { setSessionActivity(sid, null); return; }
      /* 重发前确认这条问题是这条会话的（见 recoveryTargetIsOwn） */
      if (!(await recoveryTargetIsOwn(sid, target.id))) {
        if (!isRebuilding(sid)) setSessionActivity(sid, null);
        recoveryCheckedRef.current.delete(sid);
        return;
      }
      try {
        // 原来那条是经控制入口发的：重发的新消息照样带标记
        await rerunFromMessageRef.current?.(target.id, resendText, { carryMark: true }, sid);
      } catch (error: any) {
        // A real failure IS worth a banner: the question would otherwise sit
        // unanswered with no explanation.
        setSessionActivity(sid, null);
        noteError(sid, t('⚠️ Automatic resend failed: {error}. Press Rerun on that message.', { error: String(error?.message || error) }));
      }
     } finally {
      markRecovering(sid, false);
     }
    })();
  };
  // Ref to rerunFromMessage (defined later) so the send path can invoke the
  // overwrite without a circular useCallback dependency.
  /** NOTE the 4th parameter. It exists on `rerunFromMessage` but was MISSING from
   *  this ref's type, so every caller silently fell back to
   *  `currentSessionRef.current` -- and the auto-resend, which runs during startup
   *  hydrate for a chat that is NOT necessarily focused, therefore fired one chat's
   *  prompt INTO ANOTHER CHAT. Observed live: a resend for the PPT chat landed in a
   *  different session's transcript. Always pass the session explicitly. */
  const rerunFromMessageRef = useRef<((messageId: string, editedText: string, override?: RerunOverride, targetSid?: string) => Promise<void>) | null>(null);
  /** Same reason as the ref above: `mutateSessionMessages` is defined below this point. */
  const mutateSessionMessagesRef = useRef<((sid: string, updater: (msgs: Message[]) => Message[]) => void) | null>(null);

  // Mutate a session's messages whether it is the active view (setMessages) or a
  // background session (its localStorage-backed cache). Mirrors the updateSession
  // helper inside sendQueuedMessage so steer display stays consistent with it.
  const mutateSessionMessages = useCallback((sid: string, updater: (msgs: Message[]) => Message[]) => {
    if (currentSessionRef.current === sid) {
      setMessages((current) => {
        const next = updater(current);
        // Update the session cache in the same tick. An async transcript read
        // must never replace a newly-sent optimistic message with an older snapshot.
        messagesCacheRef.current.set(sid, next);
        return next;
      });
    } else {
      const cached = messagesCacheRef.current.get(sid) || [];
      commitBackgroundMessages(sid, updater(cached));
    }
  }, [commitBackgroundMessages]);

  mutateSessionMessagesRef.current = mutateSessionMessages;

  /*
    The live-loop MIRROR. Main owns the loops (loopDriver.ts): it decides, sends and verifies
    every round, and writes the reason a loop ended into the chat itself, durably (with every
    round's verdict in that note's 详情). This side only DRAWS: the list of chats a loop owns,
    and the run's folded verdict card. After a reload it re-reads both from main -- the loop
    kept running while the window was gone.
  */
  /** The run's verdicts as ONE KiroLex card, replaced in place (loop-engineering-notes §11 #6:
   *  twenty rounds used to be twenty messages). Drawn from the rounds main recorded on the run
   *  (`verdictRounds`, both languages), so a reload re-draws the same card. Screen-only on
   *  purpose: the durable copy is main's terminal note, which folds every round into 详情. */
  const showVerdict = useCallback((sessionId: string, run: LoopRun & { verdictRounds?: Array<{ zh: VerdictRound; en: VerdictRound }> }) => {
    const id = loopVerdictsId(run);
    const lang = uiLangNow();
    const rounds = (Array.isArray(run.verdictRounds) ? run.verdictRounds : []).map((r) => r[lang] ?? r.zh).filter(Boolean);
    if (!rounds.length) return;      // level 0, or nothing measured yet: there is nothing to show
    const content = foldVerdicts(rounds, uiLangNow());
    const now = Date.now();
    const prev = liveLoopCardsRef.current.get(sessionId);
    liveLoopCardsRef.current.set(sessionId, { id, role: 'user', kirolex: true, content, timestamp: prev?.id === id ? prev.timestamp : now });
    mutateSessionMessages(sessionId, (current) => {
      /* 还没读过历史（列表是空的）就不插：会让历史看起来像没了 —— 读盘时 `withFailed` 会把它接上（同 `withLiveNote`） */
      if (!current.length) return current;
      const at = current.findIndex((m) => m.id === id);
      if (at < 0) return [...current, { id, role: 'user', kirolex: true, content, timestamp: now }];
      const next = current.slice();
      next[at] = { ...next[at], content };
      return next;
    });
  }, [mutateSessionMessages]);
  /** The loop ended: its live card goes (main's terminal note carries the same rounds, durably). */
  const dropVerdictCard = useCallback((sessionId: string) => {
    const id = liveLoopCardsRef.current.get(sessionId)?.id;
    if (!id) return;
    liveLoopCardsRef.current.delete(sessionId);
    mutateSessionMessages(sessionId, (current) => current.filter((m) => m.id !== id));
  }, [mutateSessionMessages]);

  useEffect(() => {
    const refresh = () => {
      void window.kiroApi.loopListLive?.()
        .then((list) => {
          const runs = Array.isArray(list) ? list : [];
          const ids = Array.from(new Set(runs.map((r: any) => String(r?.sessionId || '')).filter(Boolean)));
          for (const sid of [...liveLoopCardsRef.current.keys()]) if (!ids.includes(sid)) dropVerdictCard(sid);
          for (const r of runs) if (r?.sessionId) showVerdict(String(r.sessionId), r);
          loopingIdsRef.current = new Set(ids);
          setLoopingIds(ids);
        })
        .catch(() => {});
    };
    refresh();
    const off = window.kiroApi.onLoopChanged?.(refresh);
    return () => { off?.(); };
  }, [showVerdict, dropVerdictCard]);

  /**
   * End a loop because the USER said so -- and only then.
   *
   *  The driver is in main, so most endings are no longer decided here: a send failure, an
   *  executor dying under a round, a spent budget are all seen (and reported) by main. What
   *  only this side knows is a person's Stop -- the loop's own button, /stop, a background
   *  pane, force-stop -- and that is relayed as `aborted`. Any other terminal a caller passes
   *  is deliberately NOT relayed: `torn-down` on a renderer disconnect, or `blocked` when an
   *  idle executor is recycled, would end a loop main can still continue (it re-attaches on
   *  the next round). Deletion is handled by main's `acp:delete-session` (`discarded`).
   *
   *  `terminal` stays a required argument so every call site still states what happened.
   *  No session = every loop (only meaningful for force-stop). Returns whether a loop was
   *  running on the target.
   */
  const endLoop = useCallback((sessionId: string | undefined, terminal: LoopTerminal): boolean => {
    const targets = sessionId ? [sessionId] : Array.from(loopingIdsRef.current);
    let ended = false;
    for (const sid of targets) {
      if (!loopingIdsRef.current.has(sid)) continue;
      ended = true;
      if (terminal !== 'aborted') continue;
      loopingIdsRef.current.delete(sid);
      void window.kiroApi.loopStop?.(sid).catch(() => {});
    }
    if (ended && terminal === 'aborted') setLoopingIds(Array.from(loopingIdsRef.current));
    return ended;
  }, []);

  const attachFileChangeToLatestTurn = useCallback((sid: string, tc: ToolCall, isActive: boolean) => {
    upsertFileChange(sid, tc, isActive);
    mutateSessionMessages(sid, (current) => {
      // Manual scan instead of findLastIndex: that method needs lib ES2023, which
      // this project does not target, so it was a standing TS2550 + implicit-any.
      let lastUserIndex = -1;
      for (let index = current.length - 1; index >= 0; index--) {
        if (current[index].role === 'user' && !isKirolexNote(current[index])) { lastUserIndex = index; break; }
      }
      let assistantIndex = -1;
      for (let index = current.length - 1; index > lastUserIndex; index--) {
        if (current[index].role === 'assistant' && !isQuestionMessage(current[index])) {
          assistantIndex = index;
          break;
        }
      }
      const mergeToolCall = (toolCalls: ToolCall[] = []) => {
        const index = toolCalls.findIndex((item) => item.toolCallId === tc.toolCallId);
        return index >= 0
          ? [...toolCalls.slice(0, index), tc, ...toolCalls.slice(index + 1)]
          : [...toolCalls, tc];
      };
      if (assistantIndex >= 0) {
        return current.map((message, index) => index === assistantIndex
          ? { ...message, toolCalls: mergeToolCall(message.toolCalls) }
          : message);
      }
      return [...current, {
        id: `tool_turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant' as const,
        content: '',
        toolCalls: [tc],
        timestamp: Date.now(),
      }];
    });
  }, [mutateSessionMessages, upsertFileChange]);

  // Inject a mid-turn steer into the running turn via _session/steer. Shows the
  // message optimistically with a 'pending' badge, fires the (text-only) steer,
  // and returns { steered }. On a false result the optimistic message is rolled
  // back and the caller (App) decides what happens to the SAME text (see
  // `steerRoute.steerFailureRoute`) — it is never dropped. The ext-method is
  // text-only, so attachments travel as local-path refs inside `sendText`
  // (built by `steerRoute.steerPayload`, same refs a normal message carries);
  // `attachments` is what the bubble shows and what is persisted.
  const steerMessage = useCallback(async (
    content: string,
    targetSid?: string,
    opts?: { attachments?: AttachedFile[]; sendText?: string; /** 调用方指定的 id（控制入口发的带标记，见 controlSessions.isControlMessageId） */ msgId?: string },
  ): Promise<{ steered: boolean; reason?: string; /** reason 是 handed-off 时：适配器自己起的那一轮的用户消息 id（主进程 acp:steer） */ messageId?: string }> => {
    // Explicit target: a split pane can steer its own running turn without
    // depending on which chat happens to be focused.
    const sid = targetSid || currentSessionRef.current;
    const text = content.trim();
    const attachments = opts?.attachments || [];
    let sent = (opts?.sendText ?? text).trim();
    if (!sid || !sent) return { steered: false, reason: 'no-session' };
    // 先拿到真正会写出去的文字（大图路径换成缩小副本，见主进程 acp:cap-steer-text），登记和对账都用它：
    // kiro 回报「吃掉了」时带的就是这份，精确比较才能分清「同样的话、不同的图」。拿不到就用原文。
    if (sent.includes('/') || sent.includes('\\')) {
      try { sent = ((await window.kiroApi.capSteerText?.(sent)) || sent).trim(); } catch { /* 用原文 */ }
    }

    const msgId = opts?.msgId || `steer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    mutateSessionMessages(sid, (prev) => {
      const steerMsg: Message = {
        id: msgId, role: 'user', content: text, steer: 'pending', timestamp: Date.now(),
        ...(attachments.length ? { attachments } : {}),
      };
      // Place the steer directly AFTER this turn's base user message (and after
      // any earlier steers of the same turn), i.e. BEFORE every assistant/tool
      // segment of the turn. Anchoring to the base -- instead of only stepping
      // over the single last assistant message -- keeps the steer adjacent to it
      // no matter how much the turn already streamed (thinking block, tool
      // messages, partial reply). ChatArea groups adjacent steers into the same
      // bubble; a steer stranded after an assistant message renders as a lone
      // orphan bubble with no Steer label.
      // KiroLex's own notes are skipped when finding the base -- see `steerInsertIndex`.
      const insertAt = steerInsertIndex(prev);
      if (insertAt < 0) return [...prev, steerMsg];
      return [...prev.slice(0, insertAt), steerMsg, ...prev.slice(insertAt)];
    });

    // Register BEFORE writing to ACP. Kiro can emit steering_consumed as soon
    // as stdin is drained; registering afterwards creates a race where that
    // notification is missed and an already-consumed steer is queued again at
    // turn-end. This ordering matches MeshClaw's pending-steer invariant.
    const pending = pendingSteersRef.current.get(sid) || [];
    pendingSteersRef.current.set(sid, [
      ...pending,
      // inFlight：结果还没回来。轮末对账不会把它当「没被吃」放回队列（见 steerPending.settleAtTurnEnd）。
      { msgId, content: text, attachments, ...(sent !== text ? { sent } : {}), inFlight: true },
    ]);

    let res: { steered: boolean; reason?: string; messageId?: string };
    try {
      /* msgId 跟着走：适配器把它变成单独一轮时（Codex 的 startedNewTurn）那条用户消息的 id 由它推出来，控制入口的标记不丢 */
      res = await window.kiroApi.steer(sid, sent, msgId);
    } catch {
      res = { steered: false, reason: 'ipc-error' };
    }

    /*
      结果回来了（判据在 steerPending.settleIpcResult）：
        · 已经不在待确认里 → 被吃掉了，或者用户点了停止把它丢了；都不用再管；
        · 没写进去 → 拿掉乐观显示，交给 App 按原因处理（标红让用户选 / 这一轮已结束就作为新消息发）；
        · 写进去了，但结果回来之前这一轮已经结束（轮末对账只给它打了 turnEnded 记号）→ 等于这一轮已结束。
      以前这里在「轮末已经把它挪进队列」时直接回 steered:true，失败也绕过了标红 —— 那就是静默排队。
    */
    const settled = settleIpcResult(pendingSteersRef.current.get(sid) || [], msgId, res);
    if (settled.outcome.kind === 'gone') return { steered: true };
    if (settled.list.length > 0) pendingSteersRef.current.set(sid, settled.list);
    else pendingSteersRef.current.delete(sid);
    if (settled.outcome.kind === 'failed') {
      mutateSessionMessages(sid, (prev) => prev.filter((m) => m.id !== msgId));
      return { steered: false, reason: settled.outcome.reason, ...(res.messageId ? { messageId: res.messageId } : {}) };
    }
    return { steered: true };
  }, [mutateSessionMessages]);

  /**
   * **忙时 Enter 交给适配器排队**（执行器声明了 promptQueueing，`busyEnter === 'prompt-queue'`，或者 steering 出错降级）：
   * 现在就把这条交给 CLI，排在正在跑的那一轮后面（主进程 `acp:handoff-prompt`）。prompt 的组装和普通发送一样
   * （附件引用块 + 正文）。界面上这时不插消息：前一轮还在流，插进去会把它后面的输出接到这条消息底下；
   * 轮到它的时候主进程发 `acp:main-turn`，那时才插进来并接管它的流（见下面 onMainTurn 的 handoff 那段）。
   * 返回 `accepted`；没交出去时按 `reason` 由调用方改走普通发送（`idle`）或 KiroLex 队列（其余）。
   */
  const handOffMessage = useCallback(async (
    sid: string,
    content: string,
    opts: { attachments?: AttachedFile[]; displayText?: string; pastes?: any[]; msgId: string },
  ): Promise<{ accepted: boolean; reason?: string }> => {
    const text = content.trim();
    const attachments = opts.attachments || [];
    if (!sid || (!text && !attachments.length)) return { accepted: false, reason: 'empty' };
    const prompt: any[] = [];
    if (attachments.length > 0) {
      prompt.push({ type: 'text', text: `<hidden>${attachments.map((f) => `file:${f.path}`).join('\n')}\n请读取这些文件内容</hidden>` });
    }
    if (text || attachments.length === 0) prompt.push({ type: 'text', text });
    try {
      const res = await window.kiroApi.handoffPrompt?.(sid, prompt, modelForSession(sid), projectForSession(sid), {
        messageId: opts.msgId,
        displayText: opts.displayText ?? text,
        ...(attachments.length ? { attachments: attachments.map((a) => ({ id: a.id, name: a.name, path: a.path, isImage: a.isImage })) } : {}),
        ...(opts.pastes?.length ? { pastes: opts.pastes } : {}),
      });
      return res ? { accepted: !!res.accepted, reason: res.reason } : { accepted: false, reason: 'unsupported' };
    } catch {
      return { accepted: false, reason: 'ipc-error' };
    }
  }, []);

  // Remove and return a session's un-consumed steers (the turn ended before the
  // agent consumed them). Strips their optimistic messages so the caller (App)
  // can re-queue the exact text at the queue head — reappearing as a normal
  // queued item, order preserved, never dropped. Called by App when a session
  // leaves the streaming set.
  const takeUnconsumedSteers = useCallback((sid: string): { content: string; attachments: AttachedFile[]; msgId: string }[] => {
    const all = pendingSteersRef.current.get(sid);
    if (!all || all.length === 0) return [];
    // 结果还没回来的那些留下（标 turnEnded），等 IPC 结果再定 —— 见 steerPending.settleAtTurnEnd
    const { requeue: list, keep } = settleAtTurnEnd(all);
    if (keep.length > 0) pendingSteersRef.current.set(sid, keep);
    else pendingSteersRef.current.delete(sid);
    if (list.length === 0) return [];
    const ids = new Set(list.map((s) => s.msgId));
    mutateSessionMessages(sid, (prev) => prev.filter((m) => !ids.has(m.id)));
    return list.map((s) => ({ content: s.content, attachments: s.attachments, msgId: s.msgId }));
  }, [mutateSessionMessages]);

  // Explicitly drop a session's (or every session's, when sid is omitted)
  // UN-consumed pending steers on an explicit user cancel / hard stop. Unlike
  // takeUnconsumedSteers this does NOT return them for re-queue: the user
  // cancelled, so the un-consumed steers must simply disappear (their optimistic
  // messages removed too) and never auto-start a follow-up turn. Consumed steers
  // are not in the pending set, so they stay in the rendered message group.
  const discardUnconsumedSteers = useCallback((sid?: string | null) => {
    const targets = sid ? [sid] : Array.from(pendingSteersRef.current.keys());
    for (const target of targets) {
      const list = pendingSteersRef.current.get(target);
      if (!list || list.length === 0) continue;
      pendingSteersRef.current.delete(target);
      const ids = new Set(list.map((s) => s.msgId));
      mutateSessionMessages(target, (prev) => prev.filter((m) => !ids.has(m.id)));
    }
  }, [mutateSessionMessages]);

  /**
   * steer 没能追加到这一轮（不支持 / 写失败 / 没连上…）：**不再静默转排队**。
   * 消息留在这一轮的气泡里、标红「没能追加到这一轮：<原因>」，由用户选「作为下一条发送」或「放回输入框」
   * （`takeFailedSteer` 取走）。在用户选之前它落盘在 `kirolex-failed-steers`，重启也不丢。
   */
  const addFailedSteer = useCallback((sid: string, content: string, attachments: AttachedFile[], reason?: string, idOverride?: string) => {
    const msgId = idOverride || `steer_failed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // 属于哪一轮：落盘之前就从缓存同步算好（不能放进下面的状态更新回调 —— 它可能晚于 saveFailedSteers 执行）
    const baseId = turnBaseId(messagesCacheRef.current.get(sid) || [], steerInsertIndex);
    const record: FailedSteer = { msgId, content, attachments, reason, ts: Date.now(), ...(baseId ? { baseId } : {}) };
    const msg = failedSteerMessage(record);
    mutateSessionMessages(sid, (prev) => {
      const insertAt = steerInsertIndex(prev);
      if (insertAt < 0) return [...prev, msg];
      return [...prev.slice(0, insertAt), msg, ...prev.slice(insertAt)];
    });
    failedSteersRef.current!.set(sid, [...(failedSteersRef.current!.get(sid) || []), record]);
    saveFailedSteers();
    return msgId;
  }, [mutateSessionMessages]);

  /** 用户对一条失败的 steer 做了选择：把它从气泡和落盘里拿掉，返回原文和附件。找不到返回 null。 */
  const takeFailedSteer = useCallback((sid: string, msgId: string): { content: string; attachments: AttachedFile[] } | null => {
    const list = failedSteersRef.current!.get(sid) || [];
    const hit = list.find((f) => f.msgId === msgId);
    mutateSessionMessages(sid, (prev) => prev.filter((m) => m.id !== msgId));
    if (!hit) return null;
    const rest = list.filter((f) => f.msgId !== msgId);
    if (rest.length) failedSteersRef.current!.set(sid, rest); else failedSteersRef.current!.delete(sid);
    saveFailedSteers();
    return { content: hit.content, attachments: hit.attachments };
  }, [mutateSessionMessages]);

  // Populate sessionModelRef from persisted sessions on init
  useEffect(() => {
    for (const s of sessions) {
      if (s.model && s.model !== 'auto') sessionModelRef.current.set(s.id, s.model);
    }
  }, []);

  /**
   * **换机器之后把这条会话的位置改过来** ——「切了之后会话也没有远程 tag」+
   * 「切了之后那个右键菜单里为什么不变」。
   *
   * 两处看的是**同一份**会话状态（侧栏徽标 `session.remoteHost`、右键菜单里那句「运行位置：…」），
   * 而主进程那边虽然发了 `session:targets-changed`，渲染层从来没人听 —— 于是切完了，
   * 界面停在旧值上，直到下一次整页水化。
   */
  /* switchSession 定义在下面，这个监听要在挂载时就装上 —— 用 ref 拿它的最新版本 */
  const switchSessionRef = useRef<((id: string) => Promise<void>) | null>(null);
  /*
    **同步时自动合并了别的机器的消息** —— 磁盘上的 transcript 变了，界面缓存那份是旧的。
    扔掉缓存；正在看的那条立刻按磁盘重读（switchSession 在没缓存时就是从 transcript 读）。
  */
  useEffect(() => {
    const off = (window as any).kiroApi?.onSessionHistoryChanged?.((d: { sessionId: string }) => {
      if (!d?.sessionId) return;
      messagesCacheRef.current.delete(d.sessionId);
      removeAttached(d.sessionId);
      if (currentSessionRef.current === d.sessionId) void switchSessionRef.current?.(d.sessionId);
    });
    return () => { try { off?.(); } catch { /* 卸载时 preload 可能已经没了 */ } };
  }, []);

  /* 同步时跟随了别的机器挪过的项目 / 归档（主进程已经改了记录）—— 侧栏按新位置分组 */
  useEffect(() => {
    const off = (window as any).kiroApi?.onSessionPlacementChanged?.((d: { sessionId: string; projectId: string | null; archived: boolean }) => {
      if (!d?.sessionId) return;
      const pid = d.projectId || undefined;
      setSessions((prev) => prev.map((s) => (s.id === d.sessionId ? { ...s, projectId: pid, archived: !!d.archived } : s)));
      if (pid) setProjects((prev) => (prev.includes(pid) ? prev : [...prev, pid]));
    });
    return () => { try { off?.(); } catch { /* 卸载时 preload 可能已经没了 */ } };
  }, []);

  const reconnectAfterRetargetRef = useRef<((sid: string) => Promise<void>) | null>(null);
  useEffect(() => {
    const off = (window as any).kiroApi?.onTargetsChanged?.((d: { sessionId: string; remoteHost: string | null; remoteId?: string | null; localDir?: string }) => {
      if (!d?.sessionId) return;
      setSessions((prev) => prev.map((s) => (s.id === d.sessionId
        /* 工作目录也在这个事件里 —— 会话界面上那个 📂 显示的就是它，换完必须当场变 */
        ? { ...s, remoteHost: d.remoteHost || undefined, remoteId: d.remoteId || undefined, remoteMissing: undefined, localDir: d.localDir || s.localDir }
        : s)));
      /* 没连着的那条：换完立刻在新机器上连（已连着的主进程已经换好执行器了，函数里会跳过） */
      void reconnectAfterRetargetRef.current?.(d.sessionId);
    });
    return () => { try { off?.(); } catch { /* 卸载时 preload 可能已经没了 */ } };
  }, []);

  /* 换了引擎（「现有会话也能切换 agent 运行类型」）：侧栏 tag、模型/agent 下拉都看 `session.engine`，当场改 */
  useEffect(() => {
    const off = (window as any).kiroApi?.onEngineChanged?.((d: { sessionId: string; engine: 'kiro' | 'claude' | 'codex' }) => {
      if (!d?.sessionId) return;
      setSessions((prev) => prev.map((s) => (s.id === d.sessionId
        ? { ...s, engine: d.engine === 'kiro' ? undefined : d.engine }
        : s)));
    });
    return () => { try { off?.(); } catch { /* 卸载时 preload 可能已经没了 */ } };
  }, []);

  // Load messages cache from localStorage on init and restore last session messages
  useEffect(() => {
    // Message bodies are NO LONGER mirrored into localStorage. That cache had
    // grown to ~12.7 MB for 20 sessions — a duplicate of data the durable
    // transcript on disk already owns, written through a silent try/catch so a
    // quota failure would have been invisible. The in-memory Map still gives
    // instant switching within a run; a cache miss reads the transcript from
    // disk (see switchSession), which is the source of truth anyway.
    try { uiRemove('kirolex-messages-cache'); } catch {}
    // Restore the last session's messages from DISK so reopening the app still
    // lands on a populated chat instead of a blank one.
    (async () => {
      // Declared out here so the split-pane sweep below can skip it -- and so an
      // empty/unreadable last session no longer returns early and skips the sweep
      // entirely, which is what left panes unchecked.
      const lastSid = uiGet('kirolex-last-session');
      try {
        if (!lastSid) throw new Error('no last session');
        const transcript = await window.kiroApi.readTranscript?.(lastSid);
        if (!Array.isArray(transcript) || transcript.length === 0) throw new Error('empty transcript');
        const restored: Message[] = transcript.map(normalizeLegacyNote).map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls,
          attachments: m.attachments,
          pastes: (m as any).pastes,
          ...((m as any).kirolex ? { kirolex: true as const } : {}),
            ...(typeof (m as any).noteGroup === 'string' ? { noteGroup: (m as any).noteGroup } : {}),
            ...(typeof (m as any).toolTailFrom === 'number' ? { toolTailFrom: (m as any).toolTailFrom } : {}),
            ...replyMarksOf(m),
            ...(asVariants((m as any).variants) ? { variants: asVariants((m as any).variants) } : {}),
          ...(asSteerParts(m.steerParts) ? { steerParts: asSteerParts(m.steerParts) } : {}),
          ...questionOf(m),
          timestamp: m.ts,
        }));
        // 还没处理的失败 steer 挂回这一轮（标红 + 两个按钮），不进队列
        const restoredWithFailed = withFailed(lastSid, restored);
        messagesCacheRef.current.set(lastSid, restoredWithFailed);
        rebuildFileChanges(lastSid, restoredWithFailed, currentSessionRef.current === lastSid || !currentSessionRef.current);
        // Only paint it if the user is still on that session (hydrate is async).
        if (currentSessionRef.current === lastSid || !currentSessionRef.current) setMessages(restoredWithFailed);
        recoverInterruptedTurn(lastSid, restoredWithFailed, { assumeCurrent: true });
      } catch {}
      // Split panes are on screen too, and nothing ever ran the check for them: an
      // unanswered question in a pane just sat there because the FOCUSED chat was a
      // different one. Sweep them once at startup, after the focused chat, so the
      // restored session still goes first.
      try {
        const raw = uiGet('kirolex-split-session');
        const ids: string[] = raw ? JSON.parse(raw) : [];
        for (const sid of Array.isArray(ids) ? ids : []) {
          if (!sid || sid === lastSid || sid.startsWith('pending_')) continue;
          const transcript = await window.kiroApi.readTranscript?.(sid);
          if (!transcript?.length) continue;
          const msgs: Message[] = transcript.map(normalizeLegacyNote).map((m: any) => ({
            id: m.id, role: m.role, content: m.content,
            toolCalls: m.toolCalls, attachments: m.attachments,
            pastes: (m as any).pastes, timestamp: m.ts,
            ...(asSteerParts(m.steerParts) ? { steerParts: asSteerParts(m.steerParts) } : {}),
            ...((m as any).kirolex ? { kirolex: true as const } : {}),
            ...(typeof (m as any).noteGroup === 'string' ? { noteGroup: (m as any).noteGroup } : {}),
            ...(typeof (m as any).toolTailFrom === 'number' ? { toolTailFrom: (m as any).toolTailFrom } : {}),
            ...replyMarksOf(m),
            ...(asVariants((m as any).variants) ? { variants: asVariants((m as any).variants) } : {}),
            ...questionOf(m),
          }));
          const msgsWithFailed = withFailed(sid, msgs);
          messagesCacheRef.current.set(sid, msgsWithFailed);
          rebuildFileChanges(sid, msgsWithFailed, currentSessionRef.current === sid);
          recoverInterruptedTurn(sid, msgsWithFailed);
        }
      } catch {}
    })();
    // Load persisted context links and reflect the current session's links
    try {
      const savedLinks = uiGet('kirolex-context-links');
      if (savedLinks) {
        const entries: [string, any][] = JSON.parse(savedLinks);
        // Normalize: earlier versions stored a single object per target
        const normalized: [string, { sourceId: string; sourceTitle: string; syncedCount: number }[]][] =
          entries.map(([k, v]) => [k, Array.isArray(v) ? v : [v]]);
        contextLinksRef.current = new Map(normalized);
        const lastSid = uiGet('kirolex-last-session');
        const arr = lastSid ? contextLinksRef.current.get(lastSid) : undefined;
        if (arr) setContextLinks(arr.map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle })));
      }
    } catch {}
  }, []);

  // Eager-attach existing sessions at startup so switching is instant — no
  // click-then-wait-to-connect. Spawning an executor per chat is bounded by the
  // backend cap (MAX_CONCURRENT_SESSIONS = 8) with no LRU eviction, so we attach
  // the MOST RECENT sessions first and reserve one slot for a brand-new chat.
  // Runs once, concurrent + best-effort (skips failures), and never changes the
  // current view. Attached-but-unselected chats stay dormant (dot rule), so this
  // does not light everything green.
  // Declared here (above the eager-attach effect) because that effect reads
  // `hydrated` both in its body and its dependency array, which are evaluated
  // during render -- declaring it later caused a TDZ crash
  // ("Cannot access 'hydrated' before initialization").
  const hydratedRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  const eagerAttachedRef = useRef(false);
  useEffect(() => {
    if (eagerAttachedRef.current) return;
    // Wait until disk hydration has finished. `hydrated` and `sessions` are
    // separate state updates, so `hydrated` can flip true on a render where
    // `sessions` is still empty. We must NOT burn the one-shot guard then, or the
    // attach loop runs with zero sessions and never fires again -- leaving every
    // background chat unconnected. So: wait for hydration, and if sessions haven't
    // populated yet, just reveal the window and RETURN WITHOUT setting the guard,
    // so this effect re-runs once sessions arrive and actually warms them.
    if (!hydrated) return;
    eagerAttachedRef.current = true; // claim the one-shot immediately
    const EXECUTOR_CAP_FALLBACK = 8; // used only if the cap fetch fails
    let cancelled = false;
    // Declared outside the try: chosen inside it (before reveal) and consumed
    // after it, once the window is already visible.
    let cap = EXECUTOR_CAP_FALLBACK;
    let toAttach: Array<{ id: string }> = [];
    (async () => {
      // REVEAL FIRST, CONNECT AFTER. The splash only covers reading session
      // history from disk; no executor start is allowed to hold the window back.
      // Backends then attach with the main UI already usable, and each session's
      // progress is visible on its own sidebar dot (yellow connecting -> green).
      try {
        // `hydrated` can flip true a render BEFORE setSessions commits (they are
        // separate state updates), so an empty snapshot right now does NOT mean
        // "no sessions". Wait briefly for sessions to populate, otherwise we would
        // reveal an EMPTY window. Genuinely-empty installs fall through after the
        // short wait.
        for (let i = 0; i < 40 && sessionsRef.current.length === 0 && !cancelled; i++) {
          await new Promise((r) => setTimeout(r, 50)); // up to ~2s
        }
        if (cancelled) return;
        await window.kiroApi.splashStatus?.(t('Loading session history…'));
        // Decide the warm set and mark it connecting BEFORE the window shows,
        // otherwise the first painted frame has every dot grey ("not connected")
        // and the UI looks broken for a moment. getExecutorCap is a cheap
        // computed value, not a process spawn, so this does not delay reveal.
        try { cap = (await window.kiroApi.getExecutorCap()) || EXECUTOR_CAP_FALLBACK; } catch {}
        const limit = Math.max(1, cap - 1); // reserve one slot so "New chat" can attach
        const lastSid = uiGet('kirolex-last-session');
        /**
         * ONLY THE LAST ACTIVE PROJECT (plus Unassigned, plus the chat being landed on) —
         * 「默认只预热上一个活跃的project和unassigned中的会话」.
         *
         * Each executor is a ~0.4GB kiro-cli process. This loop first warmed everything under the cap, then
         * everything outside an idle project — which still means one process per LIVE project while you are
         * reading exactly one of them. Everything else stays visible but cold and attaches on the click
         * (`warmSession` for a chat, `onWarmProject` for a group), which is 「等用户点开project再创建连接」.
         */
        /**
         * REMOTE SESSIONS: ONLY THE VISIBLE ONES AND THE MOST RECENTLY USED — 「启动时不要一口气自动 attach 一大批远程会话」.
         * All remote sessions on one machine share one ssh connection whose session count sshd caps (MaxSessions,
         * default 10); 8 kiro-cli started together at launch filled it (`remoteWarmCut`). The rest attach on the click.
         */
        let splitIds: string[] = [];
        try { const raw = uiGet('kirolex-split-session'); const v = raw ? JSON.parse(raw) : []; if (Array.isArray(v)) splitIds = v; } catch {}
        const warmIds = new Set(remoteWarmCut(
          sessionsToWarm(sessionsRef.current, { now: Date.now(), limit, keepId: lastSid }),
          sessionsRef.current,
          { visible: [lastSid, ...splitIds] },
        ));
        toAttach = sessionsRef.current.filter((s) => warmIds.has(s.id));
        toAttach.forEach((s) => { if (!attachedIdsRef.current.has(s.id)) markConnecting(s.id); });
        // Let React paint the hydrated sidebar/transcript before the window shows.
        await new Promise((r) => setTimeout(r, 120));
      } finally {
        if (!cancelled) {
          try { await window.kiroApi.reveal?.(); } catch {}
        }
      }
      if (cancelled) return;

      // Now spawn the executors, ALL AT ONCE. Every candidate was already marked
      // connecting above so the whole sidebar flashes together rather than lighting
      // up in waves. Bounded only by the backend executor cap. The landed-on chat
      // starts in the same wave (not ahead of the others) -- it is already
      // interactive, and sending a message attaches on demand anyway.
      if (toAttach.length === 0) return;
      await Promise.all(
        toAttach.map(async (s) => {
          if (cancelled || attachedIdsRef.current.has(s.id)) { clearConnecting(s.id); return; }
          try {
            await window.kiroApi.loadSession(s.id, attachCwdFor(s.id), modelForSession(s.id));
            addAttached(s.id);
            clearFailed(s.id);
          } catch {
            /*
              **失败要看得出来** ——「如果连不上不应该是红色吗」。原来这里什么都不做，
              会话留在灰色（和"还没打开"一模一样），于是那台机器连不上时你只能翻日志才知道。
              注意"到上限了"也会走到这里 —— 那不算坏，但表现一样是"这条现在用不了"，
              标出来比装作正常好；attach 成功会立刻摘掉。
            */
            markFailed(s.id);
          } finally {
            clearConnecting(s.id);
          }
        })
      );
    })();
    return () => { cancelled = true; };
  }, [hydrated]);

  /**
   * **空了就去主进程要一份** —— 命令表由后端在 `_kiro.dev/commands/available` 里推来，
   * **一条会话只推一次**（连上之后）。`commandsMapRef` 只在内存里：窗口一重载（一次 HMR 也算）
   * 就空了，后端不会再推，于是输入 `/` 什么都不弹。主进程留着那一份（`SessionEntry.commands`），
   * 这里发现自己没有就去取。
   *
   * 解析走**同一段**代码（`toSlashCommands`）—— 推来的和取来的形状一样，语义才一定一致。
   */
  const fetchCommands = useCallback(async (sid: string) => {
    if (!sid || commandsMapRef.current.get(sid)?.length) return;
    try {
      const got = await window.kiroApi.sessionCommands?.(sid);
      const rows = toSlashCommands(got?.commands);
      if (!rows.length) return;
      /* 等回来的这段时间里后端可能已经推了新的一份 —— 那份更新，别覆盖它 */
      if (commandsMapRef.current.get(sid)?.length) return;
      commandsMapRef.current.set(sid, rows);
      if (currentSessionRef.current === sid) setCommands(rows);
    } catch { /* 取不到就照旧空着 —— 不弹菜单，和以前一样 */ }
  }, []);

  // Keep ref in sync with state, persist last session.
  useEffect(() => {
    currentSessionRef.current = currentSessionId;
    setCommands(currentSessionId ? (commandsMapRef.current.get(currentSessionId) || []) : []);
    /* 选中一条会话时补一次 —— 判据在 `fetchCommands` 里（已经有就直接返回） */
    if (currentSessionId) void fetchCommands(currentSessionId);
    if (currentSessionId) {
      try {
        uiSet('kirolex-last-session', currentSessionId);
      } catch {}
    }
  }, [currentSessionId, fetchCommands]);

  // Keep the IN-MEMORY cache for the current session so switching back is
  // instant. Nothing is written to localStorage any more: the durable transcript
  // on disk is the source of truth and switchSession reads it on a cache miss.
  useEffect(() => {
    /* 归属对不上就是切会话那一拍 —— 写进去就是把别的会话的消息存成这条的（见 messagesOwner） */
    if (currentSessionId && messagesOwner === currentSessionId && messages.length > 0) {
      messagesCacheRef.current.set(currentSessionId, messages);
    }
  }, [messages, currentSessionId, messagesOwner]);
  /**
   * Same array object, reachable synchronously from switchSession —— 但**必须连它属于哪条会话一起记**。
   *
   * 这个 ref 在 effect 里更新（提交之后），而 `currentSessionRef.current` 是同步更新的。于是存在一个
   * 窗口：焦点已经指向 B，这个 ref 里还装着 A 的消息。`switchSession` 在这个窗口里跑的话，会把
   * A 的消息当成 B 的寄存进 `paneViews[B]` —— 而那处只写一次（`prev[outgoing] ? prev : …`），
   * 写错就永久钉住。
   *
   * 症状是「修改画布下面那个 session 变成了别的会话内容」：画布下面那格是
   * `renderPane(studioSid, …)`，它不是焦点会话时读的正是 `paneViews[studioSid]`。
   */
  /* 记的是 messages 的**真实归属**，不是 currentSessionId —— 那一拍里两者正好对不上 */
  useEffect(() => { focusedMessagesRef.current = { sessionId: messagesOwner, messages }; });


  // Persist sessions whenever they change
  // Hydrate the sidebar from the on-disk durable store (source of truth).
  // localStorage['kirolex-sessions'] is origin-scoped and can be emptied by a
  // dev-port/origin change or a bad blank load; the transcripts on disk are not.
  // On mount we merge any disk record that the local index is missing, so
  // sessions can never silently "disappear". localStorage keeps ownership of the
  // richer, renderer-only fields (projectId/folderId/pinned/model/permissionMode).
  /**
   * 从磁盘把侧栏对一遍（见下面那段水化的说明）。挂载时跑一次；**恢复备份之后再跑一次** ——
   * 「我尝试恢复但没有生效」：恢复只写了磁盘，侧栏要重启才看得见那几条（连同它们的项目）。
   */
  const hydrateFromDisk = useCallback(async (isCancelled: () => boolean = () => false): Promise<void> => {
      try {
        const disk = await listDurableSessionsOnce();
        if (isCancelled() || !Array.isArray(disk)) return;
        const diskIds = new Set(disk.map((r: any) => r?.id).filter(Boolean));
        // sessionModelRef is what gets SENT as the attach model. It is seeded once
        // on mount from the (possibly stale) localStorage list, so refresh it from
        // disk here -- otherwise startup keeps requesting the old model forever.
        for (const rec of disk) {
          if (rec?.id && rec.model && rec.model !== 'auto') {
            sessionModelRef.current.set(rec.id, rec.model);
          }
        }
        /* 记录里的本会话花费（Claude Code）—— 见 `seedSessionCost` */
        let costSeeded = false;
        for (const rec of disk) {
          if (rec?.id && seedSessionCost(usageMapRef.current, rec.id, rec.sessionCost)) {
            costSeeded = true;
            if (rec.id === currentSessionRef.current) setUsage(usageMapRef.current.get(rec.id) || null);
          }
        }
        if (costSeeded) writeUsageMap(usageMapRef.current);
        setSessions((prev) => {
          const byId = new Map(prev.map((s) => [s.id, s]));
          for (const rec of disk) {
            const existing = byId.get(rec.id);
            if (existing) {
              // Keep local fields; backfill missing title/timestamp/projectId.
              byId.set(rec.id, {
                ...existing,
                title: existing.title || rec.title || 'New Chat',
                timestamp: existing.timestamp || rec.updatedAt,
                /*
                  **磁盘说了算** ——「为什么还是移动不了」的最后一环：这里原来是
                  `existing.projectId ?? rec.projectId`，也就是渲染层里的旧值优先。于是换项目之后
                  （主进程已经把 `Dev` 写进记录）水化时又被内存里的旧值盖回去 —— 实测侧栏一直把它
                  放在那个以会话 id 命名的假项目里，看起来就是"怎么移都移不动"。
                  换项目这个动作本来就是先写盘再更新界面，所以磁盘永远是较新的那一份。
                */
                /*
                  **磁盘完全说了算，连"未分组"也是** ——「放屁，渲染里面还在 dev 呢」。

                  上一版写成 `rec.projectId ?? existing.projectId`，只在记录里**有值**时生效；
                  而"未分组"在记录里是**字段不存在**，于是又退回渲染层那个旧值（实测：磁盘已经是
                  未分组了，侧栏还把它放在 Dev 里）。`??` 表达不了"磁盘说它没有项目"这件事。

                  换项目本来就是先写盘再更新界面，所以这里直接用磁盘那一份 —— 包括 undefined。
                */
                projectId: rec.projectId,
                // The durable record OWNS the model, like archive/pin state below.
                // Preferring the localStorage copy meant a stale, origin-scoped
                // value kept being sent as the attach model long after the record
                // had changed -- e.g. still requesting a retired 'claude-opus-4.8'
                // when every record on disk said 'claude-opus-5'.
                model: rec.model || existing.model || DEFAULT_MODEL,
                // The durable record owns archive state: localStorage is
                // origin-scoped and can silently lose it, which made archived
                // chats reappear in the normal list instead of the Archived group.
                archived: rec.archived ?? existing.archived,
                pinned: existing.pinned ?? rec.pinned, // durable pin survives origin/localStorage change
                /**
                 * 角色标记也归记录所有 —— 「重启之后 flow 注册的那个 tag 就没有了」。
                 *
                 * `purpose` 现在写进记录了(`acp:mark-session-purpose`),但水化时没被读回来:于是重启后
                 * 那个 🧩 消失、`flow-main` 的删除保护在 renderer 侧也失效。记录说什么就是什么。
                 */
                purpose: rec.purpose ?? existing.purpose,
                flow: rec.flow ?? (existing as any).flow,
                // agent 也归记录所有：它决定这条会话有哪些工具，而泳道复用要按它判断能不能复用
                kiroAgent: rec.kiroAgent ?? existing.kiroAgent,
                /* 引擎归记录所有（白名单 —— 不列就被丢掉，Claude/Codex 会话一重启就显示成 kiro） */
                engine: rec.engine ?? (existing as any).engine,
                /**
                 * **这条会话跑在哪台机器上**也归记录所有 —— 和上面 `purpose`/`kiroAgent` 是同一个坑。
                 *
                 * 这个合并是按**白名单**抄字段的，没列进来的一律丢掉。实测：主进程确实发了
                 * `remoteHost`，而侧栏那个 🌐 徽标从来没出现过 —— 因为它在这一步被丢了。
                 */
                remoteHost: rec.remoteHost ?? (existing as any).remoteHost,
                /* 机器的 id 跟着显示名从同一处来（审计 10b：分叉靠它在同一台机器上建） */
                ...(rec.remoteHost
                  ? { remoteId: rec.remoteId, remoteMissing: rec.remoteMissing }
                  : { remoteId: (existing as any).remoteId, remoteMissing: (existing as any).remoteMissing }),
                /* 工作目录同理：白名单里不列就会被丢掉，而会话界面上那个 📂 显示的就是它 */
                localDir: rec.localDir ?? (existing as any).localDir,
              });
            } else {
              byId.set(rec.id, {
                id: rec.id,
                title: rec.title || 'New Chat',
                model: rec.model || DEFAULT_MODEL,
                projectId: rec.projectId,
                archived: rec.archived,
                pinned: rec.pinned,
                purpose: rec.purpose,
                flow: rec.flow,
                kiroAgent: rec.kiroAgent,
                engine: rec.engine,
                remoteHost: rec.remoteHost,
                localDir: rec.localDir,
                remoteId: rec.remoteId,
                remoteMissing: rec.remoteMissing,
                timestamp: rec.updatedAt,
              });
            }
          }
          // DISK IS AUTHORITATIVE. This merge used to be a pure union, so a chat
          // that localStorage still listed but the disk no longer had (deleted,
          // then the removal or the index write did not land) was resurrected on
          // every start. Keep only what disk knows about, plus not-yet-persisted
          // pending/new chats.
          const kept = Array.from(byId.values())
            .filter((s) => diskIds.has(s.id) || String(s.id).startsWith('pending_'));
          /*
            **保留你拖出来的顺序** ——「拖拽会话不能调整其前后顺序」。这里原来对整份列表按时间排序，
            于是拖好的顺序一重启就没了。现在：已经在列表里的保持原来的先后（那就是你排的），
            只有磁盘上新冒出来、列表里还没有的，按时间放在最前面。
          */
          const known = new Set(prev.map((s) => s.id));
          return [
            ...kept.filter((s) => !known.has(s.id)).sort((a, b) => b.timestamp - a.timestamp),
            ...kept.filter((s) => known.has(s.id)),
          ];
        });
        // Rebuild the projects list from disk projectIds so restored projects
        // (e.g. test/test2) reappear as groups instead of collapsing to Unassigned.
        const diskProjects = Array.from(
          new Set(disk.map((r) => r.projectId).filter(Boolean) as string[])
        );
        if (diskProjects.length) {
          setProjects((prev) => Array.from(new Set([...prev, ...diskProjects])));
        }
      } catch {
        /* disk hydrate is best-effort; local index still works */
      } finally {
        hydratedRef.current = true;
        setHydrated(true);
      }
  }, []);
  const hydrateFromDiskRef = useRef(hydrateFromDisk);
  hydrateFromDiskRef.current = hydrateFromDisk;

  useEffect(() => {
    let cancelled = false;
    void hydrateFromDisk(() => cancelled);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    try {
      // Guardrail: never overwrite the persisted index with an empty array
      // before disk hydration has completed. This is exactly the case that
      // wiped the sidebar — a blank/error load persisting [] over a good index.
      if (!hydratedRef.current && sessions.length === 0) return;
      uiSet('kirolex-sessions', JSON.stringify(sessions));
    } catch {}
  }, [sessions]);

  // Auto-load a session on startup. currentSessionId is restored from
  // localStorage['kirolex-last-session'] but nothing calls switchSession for it,
  // so the chat stays blank until the user manually clicks a session. Once disk
  // hydration has populated the sidebar, switch into the restored session (or the
  // most-recent non-archived one) exactly once so its transcript loads on open.
  const initialSwitchDoneRef = useRef(false);
  useEffect(() => {
    if (initialSwitchDoneRef.current) return;
    if (sessions.length === 0) return;
    const isSelectable = (s: Session) => !String(s.id).startsWith('pending_') && !s.archived;
    const restored = currentSessionRef.current
      ? sessions.find((s) => s.id === currentSessionRef.current)
      : undefined;
    const target = restored && isSelectable(restored)
      ? restored
      : sessions.filter(isSelectable).sort((a, b) => b.timestamp - a.timestamp)[0];
    if (!target) return;
    initialSwitchDoneRef.current = true;
    void switchSession(target.id);
  }, [sessions]);

  // Persist folders whenever they change
  useEffect(() => {
    try {
      uiSet('kirolex-folders', JSON.stringify(folders));
    } catch {}
  }, [folders]);

  // Persist projects whenever they change
  useEffect(() => {
    try {
      uiSet('kirolex-projects', JSON.stringify(projects));
    } catch {}
  }, [projects]);

  /*
    **KiroLex Advanced 专属的 flow 项目不显示** ——「标准版里仍然能看到『周报』和『SFDC Activity』」。
    哪些要藏由主进程判（看磁盘），这里只拿结果；`projects` 本身（两版共用的 `kirolex-projects`）不删它们。
    会话的项目归属一变就再问一次（`projectMembershipKey`）：项目下有了普通会话它就该重新出现，最后一条普通会话移走了它就该藏起来。
  */
  const [hiddenProjects, setHiddenProjects] = useState<string[]>([]);
  const membership = useMemo(() => projectMembershipKey(sessions), [sessions]);
  useEffect(() => {
    let alive = true;
    const ask = window.kiroApi.advancedOnlyProjects;
    if (!ask || !projects.length) { setHiddenProjects([]); return; }
    ask(projects).then((h) => { if (alive) setHiddenProjects(Array.isArray(h) ? h : []); }).catch(() => {});
    return () => { alive = false; };
  }, [projects, membership]);
  const shownProjects = useMemo(() => visibleProjects(projects, hiddenProjects), [projects, hiddenProjects]);

  // Seed the projects list from any projectIds already present on sessions.
  useEffect(() => {
    const fromSessions = Array.from(
      new Set(sessions.map((s) => s.projectId).filter(Boolean) as string[])
    );
    if (fromSessions.length) {
      setProjects((prev) => Array.from(new Set([...prev, ...fromSessions])));
    }
  }, []);

  useEffect(() => {
    if (!window.kiroApi) return;

    const removeUpdate = window.kiroApi.onUpdate((data: any) => {
      if (!data?.update) return;
      const { update, sessionId } = data;

      // Route updates strictly by sessionId. If the backend fails to supply one,
      // fall back to the last session we prompted (NOT the currently viewed one).
      // With split view several chats can be busy at once, and "last prompted"
      // is a single value -- guessing would drop A's reply into B. So only use
      // the fallback when EXACTLY ONE session is streaming (then it is
      // unambiguous); otherwise discard the orphan chunk rather than misroute it.
      let targetSid = sessionId;
      if (!targetSid) {
        const busy = Array.from(streamingIdsRef.current);
        if (busy.length === 1) targetSid = busy[0];
        else if (busy.length === 0) targetSid = lastPromptedSessionRef.current;
        else {
          console.warn('[kirolex] update without sessionId while', busy.length, 'chats are streaming — discarded');
          return;
        }
      }
      if (!targetSid) return; // No session context at all, discard
      const isActiveSession = targetSid === currentSessionRef.current;

      // The first update of any kind means the agent has started responding, so
      // the phase text ("已发送，等待 Kiro 响应…") is stale: from here the live
      // stream and the tool-activity bar describe what is happening.
      if (activityMapRef.current.has(targetSid)) setSessionActivity(targetSid, null);
      // Output resumed, so the turn is demonstrably alive again and the stall
      // warning (with its countdown) must go with it.
      setSessionStall(targetSid, null);

      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const text = update.content?.text || '';

          // kiro-cli signals context compaction as a plain message chunk (there
          // is no structured ACP event for it — verified via probe). Surface it
          // as a transient status so the user knows what the quiet turn is doing.
          if (/compacting|compact(ing)? (the )?conversation|compact(ing)? context|正在压缩|压缩上下文|压缩对话/i.test(text)) {
            setSessionActivity(targetSid, t('⏳ Compacting context…'));
          }

          // Safety: only write to active session if it's actually streaming.
          // This prevents stale chunks from leaking into a freshly created session.
          if (isActiveSession && streamingIdsRef.current.has(targetSid)) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              // Append to the last assistant message during streaming, UNLESS it is
              // a 💭 thinking segment — reply text must start a fresh message.
              if (last?.role === 'assistant' && !last.content.startsWith('💭 ') && !isQuestionMessage(last)) {
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: last.content + text },
                ];
              } else {
                // Create new assistant message
                return [
                  ...prev,
                  {
                    id: update.messageId || `msg_${Date.now()}`,
                    role: 'assistant',
                    content: text,
                    toolCalls: [],
                    timestamp: Date.now(),
                  },
                ];
              }
            });
          } else if (targetSid) {
            // Buffer message for background session (or active session that isn't streaming).
            // commitBackgroundMessages also keeps a split pane live if this
            // session happens to be on screen.
            const cached = messagesCacheRef.current.get(targetSid) || [];
            const last = cached[cached.length - 1];
            if (last?.role === 'assistant' && !last.content.startsWith('💭 ') && !isQuestionMessage(last)) {
              const updated = [...cached.slice(0, -1), { ...last, content: last.content + text }];
              commitBackgroundMessages(targetSid, updated);
            } else {
              commitBackgroundMessages(targetSid, [
                ...cached,
                { id: update.messageId || `msg_${Date.now()}`, role: 'assistant' as const, content: text, timestamp: Date.now() },
              ]);
            }
          }
          break;
        }

        case 'agent_thought_chunk':
        case 'agent_reasoning_chunk': {
          // Reasoning/thinking stream. Rendered as a 💭 thinking segment (kept
          // separate from the reply; live-only, not persisted to the transcript).
          const text = update.content?.text || '';
          if (!text) break;
          const applyThink = (arr: Message[]): Message[] => {
            const lastM = arr[arr.length - 1];
            if (lastM?.role === 'assistant' && lastM.content.startsWith('💭 ')) {
              return [...arr.slice(0, -1), { ...lastM, content: lastM.content + text }];
            }
            return [...arr, {
              id: update.messageId || `think_${Date.now()}`,
              role: 'assistant' as const,
              content: '💭 ' + text,
              timestamp: Date.now(),
            }];
          };
          if (isActiveSession && streamingIdsRef.current.has(targetSid)) {
            setMessages(applyThink);
          } else if (targetSid) {
            commitBackgroundMessages(targetSid, applyThink(messagesCacheRef.current.get(targetSid) || []));
          }
          break;
        }

        case 'tool_call': {
          const locations = extractLocations(update);
          const diffs = extractDiffs(update);
          /* Claude Code / Codex：工具名 / 入参摘要 / 父调用 / 起止时间，每条都挂到这一轮上（审计 3a / 12，和主进程落盘同一个判据） */
          const traceEngine = sessionsRef.current.find((s) => s.id === targetSid)?.engine;
          const traced = !!traceEngine && traceEngine !== 'kiro';
          const tc: ToolCall = {
            toolCallId: update.toolCallId,
            title: update.title || t('Tool call'),
            status: update.status || 'pending',
            kind: update.kind,
            locations,
            diffs,
            content: extractToolOutput(update) || undefined,
            ...(traced ? { ...toolTraceFields(update), ...toolTimes(undefined, update.status, Date.now()) } : {}),
          };
          toolCallsRef.current.set(update.toolCallId, tc);
          // Track per session so it is cleared even if you switch away mid-tool
          setSessionActiveTool(targetSid, tc.title);
          /* `browser` = local_browser 的操作记录（主进程 `noteBrowserAction`）—— 进「🌐 浏览器操作」回合面板 */
          if (shouldRecordToolCall(traceEngine, tc)) attachFileChangeToLatestTurn(targetSid, tc, isActiveSession);
          break;
        }

        case 'tool_call_update': {
          /*
            **Claude Code 的工具调用显示是空的** —— claude-agent-acp 的第一条 `tool_call` 在工具入参到之前就发了，
            标题是占位（"Terminal" / "Read File" / "Preparing file…"），真正的标题（命令、文件路径）在后面的
            `tool_call_update` 里；而且 update 只带变了的字段，经常**不带 status**。原来这里不更新标题、还无条件
            `existing.status = update.status`，于是每条命令都显示成 "Terminal"、运行中的标记中途消失。
            kiro-cli 第一条就给全了标题，所以 kiro 会话一直是好的。落盘那边（主进程）本来就是合并的，只有实时界面错。
            第一条就是 update 的（没见过 tool_call）也建一条，和主进程一致。
          */
          const existing = toolCallsRef.current.get(update.toolCallId)
            ?? (update.toolCallId ? { toolCallId: update.toolCallId, title: update.title || t('Tool call'), status: update.status || 'in_progress', kind: update.kind } as any : undefined);
          if (existing) {
            if (update.status) existing.status = update.status;
            if (typeof update.title === 'string' && update.title.trim()) existing.title = update.title;
            if (update.kind) existing.kind = update.kind;
            const newLocations = extractLocations(update);
            const newDiffs = extractDiffs(update);
            if (newLocations.length) existing.locations = newLocations;
            if (newDiffs.length) existing.diffs = newDiffs;
            const output = extractToolOutput(update);
            if (output) existing.content = output;
            const traceEngine = sessionsRef.current.find((s) => s.id === targetSid)?.engine;
            if (traceEngine && traceEngine !== 'kiro') {
              Object.assign(existing, mergeToolTrace(existing, toolTraceFields(update)), toolTimes(existing, existing.status, Date.now()));
            }
            toolCallsRef.current.set(update.toolCallId, existing);
            /* kiro：原来的判据（动过文件 / 跑过东西）；Claude Code / Codex：每条都挂（审计 3a） */
            if (traceEngine && traceEngine !== 'kiro' ? true : (existing.locations?.length || existing.diffs?.length
                || RUN_KINDS.has((existing.kind || '').toLowerCase()))) {
              attachFileChangeToLatestTurn(targetSid, existing, isActiveSession);
            }

            if (update.status === 'completed' || update.status === 'failed') {
              // Clear after a brief moment (only if no newer tool took over)
              const finished = existing.title;
              setTimeout(() => {
                if (activeToolMapRef.current.get(targetSid) === finished) {
                  setSessionActiveTool(targetSid, null);
                }
              }, 800);
            } else {
              setSessionActiveTool(targetSid, existing.title);
            }
          }
          break;
        }

        case 'plan': {
          // ACP execution plan. kiro-cli resends the full plan on each update,
          // so we replace wholesale. Rendered as a collapsible Plan/Todo panel.
          const entries: PlanEntry[] = normalizeTaskList(Array.isArray(update.entries) ? update.entries : []);
          planMapRef.current.set(targetSid, entries);
          taskListsRef.current = updateTaskLists(taskListsRef.current, targetSid, entries);
          uiSet(TASK_LISTS_KEY, serializeTaskLists(taskListsRef.current));
          /* 让「不是当前焦点」的界面（画布上的节点）也能跟着重画：清单是每一步进度的唯一实时来源 */
          setTaskListTick((tick) => tick + 1);
          if (isActiveSession) setPlan(entries);
          // A pane that is not the focused chat gets it too, so the panel no longer
          // appears/disappears (and reflows the transcript) on a focus switch.
          patchPane(targetSid, { plan: entries });
          break;
        }

        case 'question': {
          /* 模型向用户的提问（主进程 `openQuestion` / `closeQuestion` 推的整张卡片）：按 id 插入或覆盖 */
          const card = update.card;
          if (!card?.id) break;
          markLocalOnly(targetSid, [card.id]);
          mutateSessionMessagesRef.current?.(targetSid, (list) => upsertQuestionCard(list, card));
          break;
        }

        case 'permission_request': {
          const requestSessionId = targetSid;
          const toolTitle = update.toolCall?.title
            || update.tool?.name
            || update.toolName
            || t('Tool permission required');
          const trustDisplay = update._meta?.trustOptions?.[0]?.display;
          const description = update.description
            || update.tool?.description
            || trustDisplay;
          const options: PermissionOption[] = Array.isArray(update.options)
            ? update.options.map((option: any) => ({
                optionId: option.optionId,
                name: option.name,
                kind: option.kind,
              })).filter((option: PermissionOption) => !!option.optionId)
            : [];
          const plan = planTextOf(update.toolCall);
          setPermissionRequests((current) => ({
            ...current,
            [requestSessionId]: {
              requestId: update.requestId,
              sessionId: requestSessionId,
              toolTitle,
              /* 计划正文单独显示：同一份不要再塞进 description 那一行 code 里 */
              description: plan && description === plan ? undefined : description,
              options,
              ...(plan ? { plan } : {}),
            },
          }));
          break;
        }

        case 'user_message_chunk': {
          // During session replay — only write to live messages if this is the
          // active session AND we initiated a load for it. The gate used to
          // compare against lastPromptedSessionRef (a single value), which is
          // wrong once two panes can prompt: it either dropped A's replay or
          // attributed it to B. Compare against the session's own streaming
          // state instead.
          const text = update.content?.text || '';
          if (isActiveSession && streamingIdsRef.current.has(targetSid)) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'user' && last.id === update.messageId) {
                return [...prev.slice(0, -1), { ...last, content: last.content + text }];
              }
              return [...prev, {
                id: update.messageId || `user_${Date.now()}`,
                role: 'user',
                content: text,
                timestamp: Date.now(),
              }];
            });
          } else if (targetSid) {
            // Buffer into the correct session's cache (and its pane, if visible)
            const cached = messagesCacheRef.current.get(targetSid) || [];
            const last = cached[cached.length - 1];
            if (last?.role === 'user' && last.id === update.messageId) {
              commitBackgroundMessages(targetSid, [...cached.slice(0, -1), { ...last, content: last.content + text }]);
            } else {
              commitBackgroundMessages(targetSid, [...cached, {
                id: update.messageId || `user_${Date.now()}`,
                role: 'user' as const,
                content: text,
                timestamp: Date.now(),
              }]);
            }
          }
          break;
        }

        case 'usage_update': {
          /*
            标准 ACP 的用量（kiro-cli 不发，它走 `_kiro.dev/metadata`）。Claude Code / Codex 的适配器
            每轮都发 `{ used, size }`（上下文已用 token / 窗口大小）—— 正好喂给同一个上下文百分比。
            它们没有 kiro 的 credits，所以 credits 原样保留（一直是 0）。
            花费：主进程把跨适配器进程累计好的值挂在 `kirolexCost` 上（`main/sessionCost.ts`）；token 留着给用量栏显示（`usageChip`）。
          */
          const ctx = typeof update.used === 'number' && typeof update.size === 'number' && update.size > 0
            ? { contextPercent: (update.used / update.size) * 100, usedTokens: update.used, sizeTokens: update.size }
            : null;
          const sessionCost = update.kirolexCost && typeof update.kirolexCost.total === 'number' ? update.kirolexCost : null;
          if (sessionId && (ctx || sessionCost)) {
            const prev = usageMapRef.current.get(sessionId);
            const next: UsageEntry = {
              ...prev,
              contextPercent: prev?.contextPercent || 0,
              credits: prev?.credits || 0,
              turnMs: prev?.turnMs,
              ...ctx,
              ...(sessionCost ? { cost: sessionCost.total, turnCost: sessionCost.turn, currency: sessionCost.currency } : null),
            };
            usageMapRef.current.set(sessionId, next);
            writeUsageMap(usageMapRef.current);
            setUsageBySession((cur) => ({ ...cur, [sessionId]: { contextPercent: next.contextPercent, credits: next.credits } }));
            if (isActiveSession) setUsage(next);
            patchPane(sessionId, { usage: next });
          }
          break;
        }

        case '_kiro_internal': {
          // Handle kiro-specific metadata (per-session usage)
          if (update.method === '_kiro.dev/metadata' && sessionId) {
            const turnCredits = update.meteringUsage?.[0]?.value || 0;
            const prev = usageMapRef.current.get(sessionId);
            const next = {
              contextPercent: update.contextUsagePercentage || 0,
              credits: (prev?.credits || 0) + turnCredits,
              turnMs: update.turnDurationMs,
            };
            usageMapRef.current.set(sessionId, next);
            writeUsageMap(usageMapRef.current); // durable: see USAGE_MAP_KEY
            // 图上那些节点靠这份反应式镜像重画（见 usageBySession）
            setUsageBySession((cur) => ({ ...cur, [sessionId]: { contextPercent: next.contextPercent, credits: next.credits } }));
            // Only update the visible usage if this is the session being viewed
            if (isActiveSession) setUsage(next);
            patchPane(sessionId, { usage: next });
          } else if (update.method === '_kiro.dev/commands/available' && Array.isArray(update.commands)) {
            /* 解析和"从主进程补一份"那条路共用（`toSlashCommands`）—— 两条路进来的形状必须一致 */
            const nextCommands = toSlashCommands(update.commands);
            commandsMapRef.current.set(targetSid, nextCommands);
            if (isActiveSession) setCommands(nextCommands);
          } else if (typeof update.method === 'string' && update.method.startsWith('_kiro.dev/')) {
            // Unhandled kiro-specific event (e.g. context compaction). Log it so
            // we can wire a precise status (like "正在压缩上下文") once we know
            // the exact method/shape kiro-cli emits during compaction.
            console.warn('[kirolex] unhandled kiro event', update.method, update);
          }
          break;
        }

        case 'steer_queued': {
          // kiro-cli acknowledged the steer will be applied at its next tool
          // boundary. The optimistic 'pending' badge already reflects this;
          // explicit case (not a fall-through) so intent is clear.
          break;
        }

        case 'steer_consumed': {
          // The agent folded a steer into the running turn. Correlate to the
          // optimistic message(s): prefer substring-matching the concatenated
          // snapshot (robust when several steers consume at one boundary), and
          // fall back to the oldest pending when the snapshot is empty. Flip the
          // matched message(s) to the 'consumed' badge and drop them from the
          // pending set so turn-end never re-queues an already-delivered steer.
          const snapshot: string = update.text || '';
          const list = pendingSteersRef.current.get(targetSid) || [];
          if (list.length === 0) break;

          // 对账判据在 steerPending.matchConsumedSteers：按「除图片路径外一模一样」比 —— 主进程会把大图路径换成
          // 缩小后的副本再写出去，精确比较会让一次吃掉的两条大图 steer 只认出最老那一条，另一条轮末再被排队重发。
          const consumedIds = matchConsumedSteers(list, snapshot);

          const remaining = list.filter((item) => !consumedIds.has(item.msgId));
          if (remaining.length > 0) pendingSteersRef.current.set(targetSid, remaining);
          else pendingSteersRef.current.delete(targetSid);
          // Persist what was actually delivered. Steers never go through
          // acp:prompt, so NOTHING else writes them to the durable transcript: on
          // disk the turn kept the reply that answered the steer but not the steer
          // itself, and since the ride-along context snapshot is rebuilt from that
          // transcript, a restored chat showed the model answering a question
          // nobody had asked. Written only on CONSUMED, because an un-consumed
          // steer is reconciled back into the queue and re-sent through acp:prompt
          // — which persists it there, so writing it here as well would double it.
          for (const item of list) {
            if (!consumedIds.has(item.msgId)) continue;
            // 带附件的 steer 连附件一起落盘（和普通消息一样）：重开会话时气泡上的附件、快照里的文件引用都还在。
            void window.kiroApi.persistSteer?.(targetSid, item.content, item.msgId, item.attachments?.length ? item.attachments : undefined).catch(() => {});
          }
          mutateSessionMessages(targetSid, (prev) =>
            prev.map((m) => (consumedIds.has(m.id) ? { ...m, steer: 'consumed' as const } : m))
          );
          break;
        }

        case 'steer_cleared': {
          // kiro-cli dropped all queued steers for this turn without consuming
          // them. Leave them pending — the turn-end reconcile (App) converts any
          // un-consumed steers into the queue head so they are never lost.
          break;
        }

        default:
          break;
      }
    });

    const removeError = window.kiroApi.onError((error: any) => {
      /* 原始 stderr 留在控制台 —— 值得给人看的那几行走下面 `onNotice` 那一路（已筛过、带类别） */
      console.error('ACP error:', error);
    });
    /** 挂到**那条会话**的错误横幅上：MCP 是按会话起的，要看得出是哪条会话的工具坏了 */
    const removeNotice = window.kiroApi.onNotice?.((n) => {
      if (!n?.text) return;
      noteError(n.sessionId || null, t('{label}: {text}', { label: n.label, text: n.text }));
    });

    // Turn end: adopt main's authoritative full assistant text. The streaming
    // append can miss trailing chunks (it is gated on the session still being
    // marked streaming), which showed up as a reply cut off mid-sentence while
    // the persisted transcript was complete. Healing here makes the on-screen
    // message match what was actually produced.
    /** kiro 报的子代理名单：整份替换，最后一份说全都 terminated 了 —— 那一刻 tag 就该消失 */
    const removeSubagents = window.kiroApi.onSubagents?.(({ sessionId: sid, subagents: rows }) => {
      if (!sid) return;
      setSubagents((cur) => ({ ...cur, [sid]: Array.isArray(rows) ? rows : [] }));
    });
    /**
     * **主进程写进对话记录的 KiroLex 提示，当场显示** —— 原来没人听 `acp:user-message`，
     * 这些提示（换了模型、换了后端会话、切换没生效……）只有重新打开会话、从盘上读回来才看得见。
     * 这一轮正在流式输出时先攒着（插在流中间会把回复拆成两段），这一轮结束（`removeStreaming`）再插。
     */
    const removeUserMessage = window.kiroApi.onUserMessage?.((d) => {
      if (!d?.sessionId || !d.kirolex || !d.content || !d.messageId) return;
      const v = asVariants(d.variants);
      const note: Message = {
        id: d.messageId, role: 'user', content: d.content, timestamp: d.ts || Date.now(), kirolex: true,
        ...(v ? { variants: v } : {}), ...(typeof d.noteGroup === 'string' ? { noteGroup: d.noteGroup } : {}),
      };
      if (streamingIdsRef.current.has(d.sessionId)) {
        const held = heldNotesRef.current.get(d.sessionId) || [];
        heldNotesRef.current.set(d.sessionId, [...held, note]);
        return;
      }
      showLiveNotes(d.sessionId, [note]);
    });
    const removeSessionBusy = window.kiroApi.onSessionBusy?.(({ sessionId: sid, reason, detail, detailVariants }) => {
      if (!sid) return;
      // Mirror the rebuild state so background flows (auto-resend) can avoid
      // overwriting its status line -- that clobbering is why the rebuild looked
      // invisible even when it was the session's actual state.
      if (reason === 'priming' || reason === 'prime-pending') primeStateRef.current.set(sid, reason);
      else primeStateRef.current.delete(sid);
      // Rebuild progress ("重建历史上下文 2/5") must be visible: a large chat can
      // spend a minute here, and a silent wait is indistinguishable from a hang.
      if (reason === 'priming') {
        const dv = asVariants(detailVariants);
        setSessionActivity(sid, `⏳ ${detail || t('Rebuilding history')}…`,
          detail
            ? (dv ? { zh: `⏳ ${dv.zh}…`, en: `⏳ ${dv.en}…` } : undefined)
            : { zh: `⏳ ${translate('zh', 'Rebuilding history')}…`, en: `⏳ ${translate('en', 'Rebuilding history')}…` });
      }
      else if (reason === 'prime-pending') {
        setSessionActivity(sid, t('⏳ Rebuilding history; new messages go out when it finishes. Press Stop to give up.'));
        // Marking the chat busy is only safe if the rebuild actually STARTS. Main
        // kicks every one of them at attach, so this is only a backstop for a
        // missed trigger -- and it is limited to the chat the user is LOOKING at.
        // Firing it for every background chat would defeat main's startup stagger
        // (~17 chats attach at once) and put them all on the model simultaneously.
        if (sid === currentSessionRef.current && !primeKickedRef.current.has(sid)) {
          primeKickedRef.current.add(sid);
          window.kiroApi.primeHistory?.(sid)
            .then((res: any) => {
              // Main retries internally without limit, so a non-ok result here
              // means the run ENDED early (executor replaced, model swapped, user
              // abandoned). Re-arm the backstop so the next busy event starts a
              // fresh run; otherwise the chat could sit 'prime-pending' (occupied,
              // queue blocked) with nothing running.
              if (res && !res.ok && !res.queued) {
                setTimeout(() => primeKickedRef.current.delete(sid), 5000);
              }
            })
            .catch(() => { setTimeout(() => primeKickedRef.current.delete(sid), 5000); });
        }
      } else {        primeKickedRef.current.delete(sid);
        if (activityMapRef.current.get(sid)?.includes('重建')
            || activityMapRef.current.get(sid)?.includes('历史上下文')
            || /rebuil|history context/i.test(activityMapRef.current.get(sid) || '')) {   // 英文界面下的同一行
          setSessionActivity(sid, null);
        }
      }
      // AN ADOPTED TURN ENDS HERE, and nowhere else. This window never held its promise, so
      // main's "no longer a turn" is the only signal that can release the stream.
      if (onBusyChange({ pending: handoffAdoptRef.current, adopted: adoptedTurnsRef.current }, sid, reason).endAdopted) {
        removeStreaming(sid);
        dropPermissionCardIfEnded(sid);
        if (activityMapRef.current.get(sid)?.includes('已接回') || activityMapRef.current.get(sid)?.includes('reattached')) setSessionActivity(sid, null);
      }
      setBusyBySession((prev) => {
        const current = prev[sid] || null;
        if (current === (reason || null)) return prev;
        const next = { ...prev };
        if (reason) next[sid] = reason; else delete next[sid];
        return next;
      });
    });
    // Paint the initial snapshot (sessions already busy before this mount).
    window.kiroApi.getBusyMap?.().then((map) => { if (map) setBusyBySession(map); }).catch(() => {});

    /**
     * **主进程自己发起的一轮**（定时到点 / 后台命令退出 / 监视事件，见主进程 `wakeDispatcher`）。
     *
     * 这一轮不是这个窗口发的：没有乐观插入的用户消息，也没有 `beginStreamingTurn`，于是原来那条消息只在盘上、
     * 回复的流被挡在门外（只进缓存），切走再回来才看得见。所以：按 id 去重插进这条消息，再像「接回」那样
     * 接管这一轮的流 —— 结束信号是主进程的 busy 不再是 'turn'（见上面 `adoptedTurnsRef` 那段）。
     */
    const removeMainTurn = window.kiroApi.onMainTurn?.(({ sessionId: sid, messageId, content, ts, kirolex, handoff, attachments }) => {
      if (!sid || !messageId) return;
      const add = (list: Message[]): Message[] => (
        list.some((m) => m.id === messageId)
          ? list
          /* `kirolex`：KiroLex 自己补发的（「写成文字」的纠正）—— 画成 KiroLex 提示，不画成你的气泡 */
          : [...list, { id: messageId, role: 'user' as const, content: String(content || ''), timestamp: Number(ts) || Date.now(), ...(kirolex ? { kirolex: true as const } : {}), ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}) }]
      );
      if (sid === currentSessionRef.current) setMessages((prev) => add(prev));
      const cached = messagesCacheRef.current.get(sid);
      if (cached) commitBackgroundMessages(sid, add(cached));
      if (!streamingIdsRef.current.has(sid)) {
        adoptedTurnsRef.current.add(sid);
        addStreaming(sid);
      } else if (handoff && !adoptedTurnsRef.current.has(sid)) {
        onHandoffMainTurn(adoptionRef.current, sid, true);
        /*
          **交给适配器排着的那一轮接手了**（`acp:handoff-prompt` / Codex 自己起的那一轮），而这个窗口自己发的上一轮
          还没收尾（它的 acp:prompt 结果还在路上）。那一轮收尾时别把流放掉，直接转成「接管」：中间不留空档，
          排队消息不会趁空档抢着发出去；这一轮的结束信号是主进程的 busy 不再是 'turn'。
        */
      }
    });

    const removeAssistantFinal = window.kiroApi.onAssistantFinal?.(({ sessionId: sid, messageId, text, toolTailFrom, replyTo, replyComplete }) => {
      if (!sid || !text) return;
      const patch = (list: Message[]): Message[] => {
        // Prefer the id main used; fall back to the last assistant message.
        let idx = list.findIndex((m) => m.id === messageId);
        if (idx < 0) {
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].role === 'assistant' && !list[i].content.startsWith('💭 ') && !isQuestionMessage(list[i])) { idx = i; break; }
          }
        }
        if (idx < 0) return list;
        /* 正文只增不减（never shrink）；toolTailFrom 正文一样也要更新（见 assistantFinal.ts） */
        const merged = mergeAssistantFinal(list[idx], text, toolTailFrom);
        /* 去重标记（回的是哪一条、是不是完整回复）跟着这条走 —— 整份重写时原样写回去（`replyMarksOf`） */
        const marks = replyMarksOf({ role: 'assistant', replyTo, replyComplete });
        const marksNew = !!marks.replyTo && (list[idx].replyTo !== marks.replyTo || list[idx].replyComplete !== marks.replyComplete);
        if (!merged && !marksNew) return list;
        if (merged && merged.content !== list[idx].content) {
          console.warn('[kirolex] healed truncated assistant message', {
            sid, rendered: list[idx].content.length, authoritative: text.length,
          });
        }
        const next = [...list];
        next[idx] = { ...next[idx], ...(merged || {}), ...marks };
        return next;
      };
      const cached = messagesCacheRef.current.get(sid);
      if (cached) messagesCacheRef.current.set(sid, patch(cached));
      if (sid === currentSessionRef.current) setMessages((prev) => patch(prev));
    });

    // The session's REAL model, pushed by main after a connect-time or
    // prompt-time fallback. Keeps the composer selector honest: before this, the
    // selector could show a model the executor was not running at all.
    const removeSessionModel = window.kiroApi.onSessionModel?.(({ sessionId: sid, model }) => {
      if (!sid || !model) return;
      sessionModelRef.current.set(sid, model);
      setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, model } : s)));
    });

    // The turn is being resent (stall retry / mid-flight model swap). Drop the
    // aborted attempt's partial assistant output, otherwise the retry's answer is
    // appended after it and the same paragraphs appear twice.
    const removeTurnRestart = window.kiroApi.onTurnRestart?.(({ sessionId: sid }) => {
      if (!sid) return;
      const dropPartial = (list: Message[]): Message[] => {
        let idx = -1;
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].role === 'user' && !isKirolexNote(list[i])) break;   // reached this turn's prompt
          if (list[i].role === 'assistant' && !isQuestionMessage(list[i])) { idx = i; break; }
        }
        if (idx < 0) return list;
        /* KiroLex 的提示不是半截回复，留着 */
        return list.filter((m, i) => i < idx || (i > idx && isKirolexNote(m)));
      };
      const cached = messagesCacheRef.current.get(sid);
      if (cached) messagesCacheRef.current.set(sid, dropPartial(cached));
      if (sid === currentSessionRef.current) setMessages((prev) => dropPartial(prev));
      setSessionActivity(sid, t('The last attempt got no response; retrying…'));
    });

    // Long silence on a running turn. Purely informational: shown as the session's
    // activity line (NOT an error banner), and nothing is cancelled — a long tool
    // call or a big context compaction is normal, and Stop remains the user's call.
    const removeTurnQuiet = window.kiroApi.onTurnQuiet?.((data) => {
      const sid = data?.sessionId;
      if (!sid) return;
      setSessionStall(sid, {
        quietSeconds: data.quietSeconds || 0,
        openTools: data.openTools || 0,
        toolIdleSeconds: data.toolIdleSeconds || 0,
        interruptInSeconds: data.interruptInSeconds ?? null,
        boundBy: data.boundBy === 'tool' ? 'tool' : 'quiet',
        boundSeconds: data.boundSeconds || 0,
      });
    });

    // Main has decided this turn is not coming back and is interrupting it. Unlike
    // onTurnQuiet this one ACTS. Nothing is rendered from here: main writes the reason
    // into the turn's own message, which is permanent and in the right place, whereas
    // anything set here would be a floating notice outliving the turn it describes.
    const removeTurnWedged = window.kiroApi.onTurnWedged?.(({ sessionId: sid, produced }) => {
      if (!sid) return;
      /* 卡死的是侧栏 review 的改写那一轮：不自动续写、不自动重发（见 `isReviseRequest`） */
      const lastUser = [...(messagesCacheRef.current.get(sid) || [])].reverse().find((m) => m.role === 'user' && !isKirolexNote(m));
      if (lastUser && isReviseRequest(lastUser.content)) return;
      /*
        **循环的一轮卡死了：这里不续写、不重发**。轮次归主进程的 driver（loopDriver.ts）：被看门狗打断的那一轮没有完整回复，
        driver 按盘上状态判成 in-doubt、停下并在会话里说清楚。这里再发一句「接着做」会换一个新 id，不经账本、不扣轮数，
        还会和 driver 的校验 / 下一轮抢这条会话 —— 而且窗口开着和刷新后行为不一样。
      */
      if (loopingIdsRef.current.has(sid) || isLoopRoundMessageId(lastUser?.id)) return;
      if (produced) {
        // A partial reply exists, so resending would duplicate it -- but the turn was
        // still CUT SHORT by us, and it used to be left looking completed: no banner, an
        // empty composer, and per-message Rerun still offered. Mark it and hand the
        // prompt back so the documented recovery (resubmit, which overwrites the turn)
        // is available and obvious. Deferred until the turn actually settles: this event
        // fires the moment main DECIDES, while the stream is still open.
        void (async () => {
          const deadline = Date.now() + 60000;
          while (streamingIdsRef.current.has(sid) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 300));
          }
          if (streamingIdsRef.current.has(sid)) return;   // never settled; leave it alone
          /*
            **自动续写** ——「像这样的中断有没有什么办法能让会话自动重试数次」。
            已经有产出的那一轮不能重发原问题（会把做过的事再做一遍、答两遍），但可以发一句
            "接着做"：实测那次是模型一口气构思整篇长文、15 分钟没有任何工具调用而被判卡死，
            接着做、并且分段写，就能写完。次数和自动重发共用「自动重试次数」那个设置；
            用户自己发一条消息就清零（见 sendMessage 开头）。
            **不能**走 markTurnInterrupted：它会让下一次发送"覆盖"这一轮 —— 续写那条一发出去，
            前面那段已有的产出就被截掉了。
          */
          let resendOff = false;
          try { resendOff = JSON.parse(uiGet('kirolex-settings') || '{}')?.recoverInterruptedTurns === false; } catch { /* 默认开 */ }
          const max = autoRetryMax();
          const done = wedgeContinuesRef.current.get(sid) || 0;
          if (!resendOff && max > 0 && done < max) {
            wedgeContinuesRef.current.set(sid, done + 1);
            autoContinueInFlightRef.current.add(sid);
            setSessionActivity(sid, t('⏳ This turn was silent too long and was interrupted; continuing automatically (attempt {n}/{max})…', { n: done + 1, max }));
            try {
              await sendMessageRef.current([{ type: 'text', text: WEDGE_CONTINUE_PROMPT }], undefined, undefined, undefined, undefined, sid);
            } catch {
              autoContinueInFlightRef.current.delete(sid);
              markTurnInterrupted(sid);
            } finally {
              setSessionActivity(sid, null);
            }
            return;
          }
          markTurnInterrupted(sid);
        })();
        return;
      }
      // The auto-resend, by contrast, IS live, so it gets a status line.
      setSessionActivity(sid, t('⏳ No response this turn; interrupted and resending…'));

      void (async () => {
        // The event is emitted the moment main DECIDES, before the interrupt lands,
        // so the turn is still streaming here. recoverInterruptedTurn bails on a
        // streaming session, hence waiting for it to actually settle first.
        const deadline = Date.now() + 60000;
        while (streamingIdsRef.current.has(sid) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 300));
        }
        if (streamingIdsRef.current.has(sid)) return;   // never settled; leave it to the user
        // recoveryCheckedRef dedupes the once-per-run STARTUP sweep; a wedge is a
        // fresh event, so clear the mark. The durable counted ledger in
        // auto-resent.json is what actually bounds retries.
        recoveryCheckedRef.current.delete(sid);
        recoverInterruptedTurn(sid, messagesCacheRef.current.get(sid) || [], { assumeCurrent: true });
      })();
    });

    const removeDisconnected = window.kiroApi.onDisconnected((data?: any) => {
      // A per-session executor process disconnected. Clear that session's
      // streaming/loop state (design §3: one process per session).
      const sid = data?.sessionId;
      if (sid) {
        const wasStreaming = streamingIdsRef.current.has(sid);
        streamingIdsRef.current.delete(sid);
        /* 执行器没了：它问的那个权限再也答不了，卡片收掉（审计 2.1） */
        setPermissionRequests((current) => withoutPermissionCard(current, sid));
        removeAttached(sid); // executor gone -> dormant
        clearConnecting(sid);
        // BLOCKED, not aborted: the executor died under the loop. Recording this as
        // a user stop is exactly the "an error read as a success" shape the terminal
        // exists to prevent -- the chat auto-recovers below, but the loop does not.
        endLoop(sid, 'blocked');
        // Mid-turn death is an interruption: mark the last user turn so the next
        // submit OVERWRITES it, and (if this is the viewed session) surface an
        // error + restore its prompt to the composer.
        /*
          **不是你停的就自动重发** ——「因为非人工原因中断的会话你应该加自动重试发送」。
          原来执行器死在一轮中间只做 `markTurnInterrupted`：既不重发，还把这一轮标成"下一条覆盖它"，
          于是排在队列里的那条一发出去就把没答完的问题连同它的 steer 一起从记录里抹掉了。
          现在：你按过停止（`recoveryCancelledRef`）才走老路；否则等下面重连上就按重试预算重发这一轮，
          这期间队列先别发。
        */
        const autoRecover = wasStreaming && !recoveryCancelledRef.current.has(sid)
          && autoRetryMax() > 0 && !loopingIdsRef.current.has(sid);
        if (wasStreaming && !autoRecover) {
          // Deliberately NOT also reported through the error banner. One state, one
          // place: the interrupted bar is derived from the same flag that disables the
          // per-message Rerun, so the notice and the restriction cannot disagree and
          // both retire together. Reporting it twice is how a red copy of this message
          // used to stay on screen after the state itself was gone -- the banner had
          // its own, longer lifetime.
          markTurnInterrupted(sid);
        }
        if (autoRecover) {
          markRecovering(sid, true);
          setSessionActivity(sid, t('⏳ The connection dropped mid-turn; reconnecting and resending this turn…'));
        }
        // AUTO-RECOVERY: the executor process is genuinely gone, so bring the
        // session back by itself instead of leaving a dead grey chat that only
        // heals on the user's next send. Throttled per session (>=8s apart) so a
        // crash-looping backend can't spin here.
        const lastTry = autoRecoverAtRef.current.get(sid) || 0;
        if (!reconfiguringRef.current.has(sid) && Date.now() - lastTry > 8000) {          autoRecoverAtRef.current.set(sid, Date.now());
          setTimeout(() => {
            (async () => {
              if (attachedIdsRef.current.has(sid)) return; // already back
              /**
               * 归档的会话不救 —— 归档的语义就是「让它彻底停下来」。
               *
               * 这条守卫少了会有一个很具体的后果：`archiveSession` 里的 `removeAttached` 刚把它摘掉，
               * 紧接着执行器的 disconnected 事件到达，这里就把它 `loadSession` + `addAttached` 拉回来。
               * 表现是**归档后侧栏那条还是绿的**（注释里写着 attached 才会绿），而且它的 kiro-cli
               * 进程被重新拉起 —— 归档等于什么都没关掉。
               */
              if (sessionsRef.current.find((s) => s.id === sid)?.archived) return;
              try {
                markConnecting(sid);
                await window.kiroApi.loadSession(sid, attachCwdFor(sid), modelForSession(sid));
                addAttached(sid);
                if (sid === currentSessionRef.current) setSessionActivity(sid, null);
                if (autoRecover) {
                  recoveryCheckedRef.current.delete(sid);
                  recoverInterruptedTurn(sid, messagesCacheRef.current.get(sid) || [], { assumeCurrent: true, interrupted: true });
                }
              } catch {
                // Still down -- stay dormant; the next send retries as before.
                /* 重连都没成：退回老路（标成被打断、把问题放回输入框），别让它悄悄卡着 */
                if (autoRecover) markTurnInterrupted(sid);
              } finally {
                clearConnecting(sid);
                if (autoRecover) markRecovering(sid, false);
              }
            })();
          }, 600);
        }
      } else {
        streamingIdsRef.current.clear();
        // Everything went down at once (the whole ACP layer, not one chat). Neither
        // 'aborted' nor 'blocked' is honest here, which is why 'torn-down' exists.
        endLoop(undefined, 'torn-down');
        attachedIdsRef.current.clear();
        setAttachedSessionIds([]);
        connectingRef.current.clear();
        setConnectingSessionIds([]);
      }
      setStreamingIds(Array.from(streamingIdsRef.current));
    });

    // Seam hook A (design §11): a session's executor attached and is ready for
    // its first prompt. Mark it live and reflect its (write-once) projectId.
    const removeSessionReady = window.kiroApi.onSessionReady((data) => {
      const sid = data?.sessionId;
      if (!sid) return;
      clearConnecting(sid);
      if (data.projectId) {
        setSessions((prev) =>
          prev.map((s) => (s.id === sid && !s.projectId ? { ...s, projectId: data.projectId } : s))
        );
      }
    });

    /* 断了的远程会话被主进程自己接回来了（它一直按退避重试，渲染层那次只试一次）：标成连着 */
    const removeReattached = (window as any).kiroApi.onReattached?.((data?: { sessionId?: string }) => {
      const sid = data?.sessionId;
      if (!sid) return;
      clearConnecting(sid);
      addAttached(sid);
      setSessionActivity(sid, null);
    });

    /* 窗口重载时还挂着的提问（主进程那边还在等回答）：补回来 */
    window.kiroApi.pendingQuestions?.().then((cards) => {
      for (const card of Array.isArray(cards) ? cards : []) {
        if (!card?.id || !card.sessionId) continue;
        markLocalOnly(card.sessionId, [card.id]);
        mutateSessionMessagesRef.current?.(card.sessionId, (list) => upsertQuestionCard(list, card));
      }
    }).catch(() => {});

    return () => {
      removeReattached?.();
      removeUpdate();
      removeError();
      removeNotice?.();
      removeAssistantFinal?.();
      removeMainTurn?.();
      removeSessionModel?.();
      removeTurnRestart?.();
      removeTurnQuiet?.();
      removeTurnWedged?.();
      removeSessionBusy?.();
      removeSubagents?.();
      removeUserMessage?.();
      removeDisconnected();
      removeSessionReady();
    };
  }, []);

  const connect = useCallback(async (model: string) => {
    setStatus('connecting');
    noteError(null, null);
    try {
      await window.kiroApi.connect({ model });
      setStatus('connected');
    } catch (err: any) {
      setStatus('disconnected');
      noteError(null, err?.message || t('Failed to connect'));
    }
  }, []);

  /** No chat is focused any more, without closing or deleting anything.
   *
   *  Needed because "focused chat" and "chat on screen" are the same thing in a
   *  single-pane layout but NOT in a split: closing the last pane leaves a grid with
   *  nothing in it, and a chat that is still focused while invisible immediately gets
   *  adopted back into a slot by the layout effects -- which is exactly why closing
   *  the last pane used to collapse the split instead of emptying it.
   *
   *  Deliberately NOT `switchSession(null)`: that path attaches executors, primes
   *  context and rewrites the transcript view. Nothing here touches the backend --
   *  the chats keep running, they are just not on screen. Messages are dropped
   *  because the focused-pane transcript is not rendered without a focused chat, and
   *  refocusing re-seeds it from the cache. */
  const unfocusSession = useCallback(() => {
    currentSessionRef.current = null;
    setCurrentSessionId(null);
    setMessages(EMPTY_PANE_MESSAGES);
  }, []);

  const disconnect = useCallback(async () => {
    // The app is disconnecting on purpose; the loops did not fail and were not
    // stopped on their own merits.
    endLoop(undefined, 'torn-down');
    await window.kiroApi.disconnect();
    setStatus('disconnected');
    setCurrentSessionId(null);
  }, [endLoop]);

  /**
   * `kiroAgent` is a parameter because a run's steps must execute under the skill's agent — 「skill必须搭配agent
   * 配置」. Its tools live in that agent's MCP servers; created under the default agent the step has none.
   */
  /**
   * **这条会话本来要跑在哪台机器上** ——「这个新会话怎么还变成了本地的了，WTF」。
   *
   * 建会话失败之后（比如远端连不上），发消息那条路会**再建一次**，而它原来不带 `remoteId` ——
   * 于是一条你明确建成远程的会话静默变成本地的，接着本地没有 Claude，你看到的是
   * 「claude-opus-5 不可用」。两个症状，一个原因。
   *
   * 记在这里而不是从 `sessions` 里读 `remoteHost`：那个字段是**给人看的 label**，
   * 而 IPC 要的是配置里的 id，按 label 反查一旦查不到就会传 `undefined` —— 那又是"变成本地"。
   */
  const intendedRemoteRef = useRef<Map<string, string>>(new Map());
  /** 同上，引擎：兜底重建那条路也不许把 Claude/Codex 会话悄悄建成 kiro。 */
  const intendedEngineRef = useRef<Map<string, string>>(new Map());
  /**
   * **重启后找回分叉记下的机器**（审计 10b）—— 上面那张表只活在内存里；分叉后没发消息就重启的话，
   * 首条消息原来退回新会话默认机器。会话行（带 `forkRemoteId`）整份落盘，启动时从这里灌回去；
   * 源会话机器已删的那种，那句「设置里已经没有这台机器了」也再钉一次。
   */
  useEffect(() => {
    for (const r of restoredForkIntents(sessions)) {
      if (!intendedRemoteRef.current.has(r.id)) intendedRemoteRef.current.set(r.id, r.remoteId);
      if (r.missingHost) {
        const host = r.missingHost;
        noteSessionLocally(r.id, forkMachineMissingText(uiLangNow(), host),
          { zh: forkMachineMissingText('zh', host), en: forkMachineMissingText('en', host) },
          { sticky: true, pinned: true, group: FORK_MACHINE_MISSING_GROUP });
      }
    }
    // 只在启动时跑一次：之后的分叉 / 右键都直接写这张表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newSession = useCallback(async (
    cwd: string,
    model: string = DEFAULT_MODEL,
    projectId?: string,
    kiroAgent?: string,
    /**
     * 建好之后要不要把焦点切过去。默认切（你点「新对话」就是想立刻用它），但 flow 建子会话时必须
     * 传 `false` —— 「flow 创建子会话的时候停在主会话这里，不要自动切过去」。
     *
     * 为什么这是个参数而不是在调用点切回来：切过去再切回来会经过一次 `setMessages([])`，主会话的
     * 消息被清空又重新加载，画面闪一下；而且 `currentSessionRef` 中途指向过 worker，任何在这一瞬间
     * 到达的流式更新都会被记到错的会话上。不切，就没有这一段中间状态。
     */
    opts?: {
      focus?: boolean;
      /**
       * **这条会话跑在哪台机器上**（不传 = 本地）。按会话选，不是全局开关 ——
       * 会话 A 本地、会话 B 远程要能同时跑（`docs/DESIGN_remote_sessions.md`）。
       */
      remoteId?: string;
      /** 徽标上显示的短名字（`remoteTargets` 给的 label）。 */
      remoteLabel?: string;
      /** 哪个引擎（Claude Code / Codex）；不传 = kiro。 */
      engine?: 'kiro' | 'claude' | 'codex';
    },
  ) => {
    await connect(model);
    const focus = opts?.focus !== false;

    // KiroLex-owned session id, stable from creation (never a pending swap).
    // Main maps kiro-cli's backend session id to this id internally.
    const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessionModelRef.current.set(id, model);
    if (focus) {
      currentSessionRef.current = id;
      setCurrentSessionId(id);
      // 下面这些都是「当前会话」的视图状态，不切焦点就一个都不能动 —— 它们属于你正看着的那条会话。
      setMessages([]);
      currentMessageRef.current = '';
      toolCallsRef.current.clear();
      setUsage(null);
      setPlan([]);
      setFileChanges([]);
      setActiveToolCall(null);
      /* 状态行 / 卡住提示也是上一条会话的：不清的话它那句「正在连接会话…」会一直挂在新会话的欢迎页下面 */
      setActivityStatus(null);
      setTurnStall(null);
      setContextLinks([]);
    }

    if (projectId) setProjects((prev) => (prev.includes(projectId) ? prev : [...prev, projectId]));

    setSessions((prev) => [
      /**
       * `kiroAgent` 要一起记 —— 它原来只传给主进程，没写进渲染层自己的状态。
       *
       * 两个后果：界面上这条会话显示的是**默认 agent**（磁盘上其实是对的）；而 flow 的泳道复用要
       * 比 agent 才敢复用（会话的 agent 创建时就定了、换不了），比到 `undefined` 就一律不复用 ——
       * 于是一个配了 agent 的 flow **每步都另起一条会话**，复用被静默禁掉。
       *
       * 这是同一个字段的第二处漏填：另一处是 `listDurableSessions` 没把 `profile.kiroAgent` 发出来
       * （已修）。新建这条路是"从来没写过"，那条是"重启后才丢"——两处都补上才算全。
       */
      {
        id, title: 'New Chat', model, permissionMode: 'auto-approve', projectId, kiroAgent, timestamp: Date.now(),
        /* 徽标当场就要有：等下一次 hydrate 才出现的话，你刚建的远程会话看起来像本地的 */
        ...(opts?.remoteId ? { remoteHost: opts.remoteLabel || opts.remoteId, remoteId: opts.remoteId } : null),
        ...(opts?.engine && opts.engine !== 'kiro' ? { engine: opts.engine } : null),
      },
      ...prev,
    ]);

    // Register the in-flight creation so a send before connect finishes awaits
    // this same attach (id is already stable, so no swap — just gate readiness).
    if (opts?.remoteId) intendedRemoteRef.current.set(id, opts.remoteId);
    if (opts?.engine && opts.engine !== 'kiro') intendedEngineRef.current.set(id, opts.engine);
    const args: CreateArgs = { cwd, model, projectId, kiroAgent, remoteId: opts?.remoteId, engine: opts?.engine };
    createArgsRef.current.set(id, args);
    void startCreate(id, args).catch(() => { /* 失败已经在会话里说了（阶段条 + 提示） */ });
    return id;
  }, [connect]);

  /**
   * **再建一次没建成的新会话**（阶段条上的「重试」/「改成本机运行」）。改成本机：侧栏那一行的机器徽标摘掉，
   * 按本机再建（主进程那份先写的记录跟着改成本机，见 acp:new-session）。正在建的不重复建。
   */
  const retryCreateSession = useCallback(async (sid: string, opts?: { local?: boolean }) => {
    if (creatingRef.current.has(sid)) return;
    /* 窗口刷新过的话本窗口没记这份参数：用主进程留的那份（建成之前一直在） */
    const mine = createArgsRef.current.get(sid);
    let fromMain: CreateArgs | null = null;
    if (!mine) { try { fromMain = (await window.kiroApi.getCreateArgs?.(sid)) || null; } catch { /* 拿不到就当没有 */ } }
    const next = retryCreateArgs(mine, fromMain, !!opts?.local);
    if (!next || creatingRef.current.has(sid)) return;
    if (opts?.local) {
      intendedRemoteRef.current.delete(sid);
      setSessions((list) => list.map((s) => (s.id === sid ? { ...s, remoteHost: undefined, remoteId: undefined } : s)));
    }
    createArgsRef.current.set(sid, next);
    failedCreateRef.current.delete(sid);
    clearFailed(sid);
    mutateSessionMessages(sid, (cur) => replaceConnectFailureNotices(cur));
    try { await startCreate(sid, next); } catch { /* 同上：失败已经说了 */ }
  }, []);

  /**
   * 跑一次新建（`acp:new-session`）：阶段条当场先亮（主进程第一次推送前也看得见），登记进 `creatingRef`
   * （发送 / 切会话 / 预热据此等它，不去 attach 一条还没建完的会话）。
   */
  function startCreate(id: string, a: CreateArgs): Promise<string> {
    const { cwd, model, projectId, kiroAgent } = a;
    const opts = { remoteId: a.remoteId, engine: a.engine };
    setCreateStages((prev) => applyCreateStage(prev, { sessionId: id, stage: a.remoteId ? 'connect' : 'check', engine: a.engine || 'kiro', remote: !!a.remoteId, startedAt: Date.now() }));
    markConnecting(id); // flash while the executor spawns
    const createPromise = (async (): Promise<string> => {
      try {
        await window.kiroApi.newSession(id, cwd, model, projectId, kiroAgent, 'auto-approve', opts?.remoteId, opts?.engine);
        clearConnecting(id);
        // Per design: a newly created chat auto-connects. The executor is
        // spawned, so mark it attached immediately -> the sidebar dot goes green
        // right away (no lazy "dormant until first message" state).
        addAttached(id);
      } catch (err: any) {
        clearConnecting(id);
        /*
          **失败要说出来** —— 原来这里只 `clearConnecting`，异常被吞掉、promise 照样 resolve，
          于是界面上那条会话看着像建好了（徽标还挂着远端的名字），而执行器根本不存在。
          接着你一发消息，另一条路会**再建一次**，那条路不带 remote —— 于是它变成本地会话。
          「这个新会话怎么还变成了本地的了」就是这么来的，而屏幕上从头到尾没有一个字提示出错。
        */
        markFailed(id);
        const why = String(err?.message || err);
        /* 缺适配器的那种：提示上有「安装」，装好后照原样再建一次 */
        failedCreateRef.current.set(id, () => window.kiroApi.newSession(id, cwd, model, projectId, kiroAgent, 'auto-approve', opts?.remoteId, opts?.engine));
        /* 阶段条换成「失败」+ 原因（主进程一般已经推过；IPC 本身失败时只有这里知道） */
        setCreateStages((prev) => {
          const cur = prev[id];
          if (!cur || cur.stage === 'failed') return prev;
          return applyCreateStage(prev, { ...cur, stage: 'failed', error: why, failedAt: cur.stage === 'ready' ? undefined : cur.stage });
        });
        /* 和换机器重连失败那条同一个构造：整句（含 KiroLex 自己给的原因）都带中英两版 */
        mutateSessionMessages(id, (cur) => [...cur, connectFailureNotice(why, Date.now(), uiLangNow())]);
        throw err;                       // 让 await 这个 promise 的那一侧知道它失败了
      } finally {
        creatingRef.current.delete(id);
      }
      return id;
    })();
    creatingRef.current.set(id, createPromise);
    return createPromise;
  }

  // Duplicate a session: create a full copy at the same folder level, preserving
  // all messages and context. The backend kiro-cli session is NOT created yet;
  // the copied history is injected as a <hidden> priming block on the first send
  // (reusing the same context-rebuild pattern used for stale sessions), so the
  // model treats the duplicate as a seamless continuation with full context.
  /**
   * **还没发过消息的会话，右键换机器** —— pending 会话在主进程那边还没有记录（`acp:set-remote-target` 会报
   * 「找不到这条会话的记录」），它的机器只活在 `intendedRemoteRef` 里，首条消息建后端时才用。所以这里只改那张表
   * 和侧栏那一行。分叉出来、源会话的机器已经删掉的那种（审计 10b）就靠这个改好，「机器找不到」那句跟着撤掉。
   * 不是 pending 会话返回 false（照旧走主进程）。
   */
  const retargetPendingSession = useCallback((sessionId: string, remoteId: string | null, label?: string): boolean => {
    if (!String(sessionId).startsWith('pending_')) return false;
    intendedRemoteRef.current.set(sessionId, remoteId || '');
    setSessions((prev) => prev.map((s) => (s.id === sessionId
      ? { ...s, remoteHost: remoteId ? (label || remoteId) : undefined, remoteId: remoteId || undefined, remoteMissing: undefined, forkRemoteId: remoteId || '' }
      : s)));
    unpinSessionLocally(sessionId, FORK_MACHINE_MISSING_GROUP);
    return true;
  }, []);

  const duplicateSession = useCallback((
    sessionId: string,
    throughMessageId?: string,
  ): string | undefined => {
    const src = sessions.find((s) => s.id === sessionId);
    if (!src) return undefined;

    const srcMsgs = messagesCacheRef.current.get(sessionId) || [];
    const throughIndex = throughMessageId
      ? srcMsgs.findIndex((message) => message.id === throughMessageId)
      : -1;
    const selectedMessages = throughIndex >= 0
      ? srcMsgs.slice(0, throughIndex + 1)
      : srcMsgs;
    const newId = `pending_dup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const copied = selectedMessages.map((m) => ({
      ...m,
      attachments: m.attachments?.map((attachment) => ({ ...attachment })),
    }));

    // Copy messages into the duplicate's display cache and persist
    messagesCacheRef.current.set(newId, copied);
    /* 复制来的历史只在界面上（新会话的 transcript 里没有，首条消息时作为隐藏块注入） */
    markLocalOnly(newId, copied.map((m) => m.id));

    // Cold cache (a session hydrated from disk but never opened this run) used to
    // fork an EMPTY chat: message bodies are no longer mirrored into localStorage,
    // so the in-memory cache only fills when a session is opened. Backfill from the
    // durable transcript — the source of truth — as soon as it can be read.
    if (copied.length === 0 && !throughMessageId) {
      void (async () => {
        try {
          const t = await window.kiroApi.readTranscript?.(sessionId);
          if (!Array.isArray(t) || t.length === 0) return;
          const restored: Message[] = t.map((m: any) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls,
            attachments: m.attachments,
            pastes: m.pastes,
            ...((m as any).kirolex ? { kirolex: true as const } : {}),
            ...(typeof (m as any).noteGroup === 'string' ? { noteGroup: (m as any).noteGroup } : {}),
            ...(typeof (m as any).toolTailFrom === 'number' ? { toolTailFrom: (m as any).toolTailFrom } : {}),
            ...replyMarksOf(m),
            ...(asVariants((m as any).variants) ? { variants: asVariants((m as any).variants) } : {}),
            ...(asSteerParts(m.steerParts) ? { steerParts: asSteerParts(m.steerParts) } : {}),
            ...questionOf(m),
            timestamp: m.ts,
          }));
          // Only fill if nothing has been written to the fork meanwhile.
          if ((messagesCacheRef.current.get(newId) || []).length === 0) {
            messagesCacheRef.current.set(newId, restored);
            markLocalOnly(newId, restored.map((m) => m.id));
            duplicateHistoryRef.current.set(newId, restored);
            rebuildFileChanges(newId, restored, currentSessionRef.current === newId);
            if (currentSessionRef.current === newId) setMessages(restored);
          }
        } catch { /* fork just starts empty */ }
      })();
    }

    // Stash the history and project for backend context injection/materialization
    // on the first send. The explicit project ref avoids a React state timing race.
    if (copied.length > 0) {
      duplicateHistoryRef.current.set(newId, copied);
    }
    duplicateProjectRef.current.set(newId, src.projectId);
    /*
      **引擎跟着源会话** —— 分叉 / 复制一条 Claude Code（或 Codex）会话，首条消息建后端时读的是 intendedEngineRef，
      原来这里不记，主进程按「没传 = kiro」建，于是分叉出来的悄悄成了 Kiro 会话。
    */
    if (src.engine && src.engine !== 'kiro') intendedEngineRef.current.set(newId, src.engine);
    /*
      **机器也跟着源会话**（审计 10b）—— 原来这里不记，首条消息建后端时退回「新会话默认机器」
      （`kirolex-new-chat-remote`），跑在 tokyo-arm 上的会话分叉出来悄悄跑到了本机 / 别的机器上。
      本机也明确记（空串），这样才不会被默认机器顶掉。源会话的机器在设置里已经删了：照样记原来的 id
      （建后端时主进程报找不到、不替你猜），并在会话里说一句，让人右键改。
    */
    const forkRemote = forkRemoteIntent(src);
    intendedRemoteRef.current.set(newId, forkRemote.remoteId);
    if (forkRemote.missingHost) {
      const host = forkRemote.missingHost;
      noteSessionLocally(newId, forkMachineMissingText(uiLangNow(), host),
        { zh: forkMachineMissingText('zh', host), en: forkMachineMissingText('en', host) },
        { sticky: true, pinned: true, group: FORK_MACHINE_MISSING_GROUP });
    }

    // Copy the per-session model routing
    const model = sessionModelRef.current.get(sessionId) || DEFAULT_MODEL;
    sessionModelRef.current.set(newId, model);

    // Copy this session's own usage snapshot for display continuity
    const srcUsage = usageMapRef.current.get(sessionId);
    if (srcUsage) { usageMapRef.current.set(newId, { ...srcUsage }); writeUsageMap(usageMapRef.current); }

    // Copy context-sync links (each restarts its high-water mark at 0 so the
    // duplicate re-forwards the linked sources' history on its first send)
    const links = contextLinksRef.current.get(sessionId);
    if (links && links.length > 0) {
      contextLinksRef.current.set(newId, links.map((l) => ({ ...l, syncedCount: 0 })));
      persistContextLinks();
    }

    // Insert the duplicate right after the source, in the same folder
    setSessions((prev) => {
      const dup: Session = {
        id: newId,
        title: throughMessageId ? `fork:${src.title}` : `dup:${src.title}`,
        model,
        permissionMode: src.permissionMode || 'auto-approve',
        projectId: src.projectId,
        folderId: src.folderId ?? null,
        timestamp: Date.now(),
        ...(src.engine && src.engine !== 'kiro' ? { engine: src.engine } : null),
        /* 侧栏那一行当场显示机器名（同上，10b） */
        ...(src.remoteHost ? { remoteHost: src.remoteHost } : null),
        ...(forkRemote.remoteId ? { remoteId: forkRemote.remoteId } : null),
        ...(forkRemote.missingHost ? { remoteMissing: true } : null),
        /* 记在行上（行整份落盘）：没发消息就重启时靠它找回机器，见上面 restoredForkIntents */
        forkRemoteId: forkRemote.remoteId,
      };
      const idx = prev.findIndex((s) => s.id === sessionId);
      if (idx === -1) return [dup, ...prev];
      const next = [...prev];
      next.splice(idx + 1, 0, dup);
      return next;
    });

    return newId;
  }, [sessions]);

  /** The live view for a chat that is on screen but has no PaneView entry YET.
   *
   *  This closes a one-frame hole that was measured, not guessed. `setPaneSessions` runs
   *  in an EFFECT, so on the render where focus moves away from a chat that chat is
   *  already `!focused` while `paneViews[sid]` does not exist yet. The pane therefore
   *  rendered `view?.messages || []` -- an EMPTY conversation -- for one commit: every
   *  transcript row unmounted, the empty-state block mounted, and the next commit
   *  re-created all of it as NEW nodes. Measured on the live window: clicking one pane
   *  produced 0 mutations in the pane clicked and 24 (12 added / 12 removed, 0 surviving
   *  node objects) in the pane that LOST focus, with nothing at all in a no-click
   *  control. That teardown/rebuild of every markdown block is the flash.
   *
   *  Reading the same refs `setPaneSessions` seeds from also preserves array IDENTITY,
   *  so the rows are not merely rebuilt cheaply -- they are not re-rendered at all. */
  const paneFallback = useCallback((sid: string): PaneView => ({
    messages: messagesCacheRef.current.get(sid) || EMPTY_PANE_MESSAGES,
    activity: activityMapRef.current.get(sid) || null,
    activeTool: activeToolMapRef.current.get(sid) || null,
    usage: usageMapRef.current.get(sid) || null,
    contextLinks: (contextLinksRef.current.get(sid) || [])
      .map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle })),
    stall: stallMapRef.current.get(sid) || null,
    plan: planMapRef.current.get(sid) || EMPTY_PANE_PLAN,
  }), []);

  /** Declare which sessions are visible in split panes (never the focused one).
   *  Seeds each pane's live view from the message cache, and reads the
   *  transcript from disk for a pane that was never opened this run — the same
   *  cold path switchSession uses, so a pane is never blank-but-loaded. */
  /**
   * **切走的会话：它挂着的提问回 cancel**（需求：「这一轮被 Stop / 会话切走 → cancel」）。等 `LEAVE_CONFIRM_MS` 再确认一次
   * 它确实不在屏幕上（不是焦点、也不在任何一格里）才取消 —— 屏幕集合在启动 / 换布局时会短暂抖动，切走马上切回来也不该丢掉问题。
   * 回包、关卡片、落盘都在主进程 `cancelQuestionsFor`（没有挂着的提问就什么都不做）。
   */
  const cancelQuestionsIfGone = (ids: string[]) => {
    if (!ids.length) return;
    setTimeout(() => {
      for (const id of ids) {
        if (!id || id === currentSessionRef.current || onScreenPaneIdsRef.current.has(id)) continue;
        void window.kiroApi.cancelQuestions?.(id).catch(() => {});
      }
    }, LEAVE_CONFIRM_MS);
  };

  const setPaneSessions = useCallback(async (ids: string[]) => {
    const wanted = ids.filter((id) => !!id && !id.startsWith('pending_'));
    paneSessionIdsRef.current = new Set(wanted);
    const wasOnScreen = onScreenPaneIdsRef.current;
    onScreenPaneIdsRef.current = new Set([...wanted, currentSessionRef.current].filter(Boolean) as string[]);
    /* 分屏里被换掉的那一格（不是焦点）：它挂着的提问同样取消（见 switchSession 那段） */
    cancelQuestionsIfGone(leftScreen(wasOnScreen, onScreenPaneIdsRef.current));
    setPaneViews((prev) => {
      const next: Record<string, PaneView> = {};
      for (const id of wanted) {
        next[id] = prev[id] || {
          messages: messagesCacheRef.current.get(id) || [],
          activity: activityMapRef.current.get(id) || null,
          activeTool: activeToolMapRef.current.get(id) || null,
          usage: usageMapRef.current.get(id) || null,
          contextLinks: (contextLinksRef.current.get(id) || [])
            .map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle })),
          stall: stallMapRef.current.get(id) || null,
          plan: planMapRef.current.get(id) || EMPTY_PANE_PLAN,
        };
      }
      return next;   // panes that went away are dropped, freeing their copy
    });
    for (const id of wanted) {
      if ((messagesCacheRef.current.get(id) || []).length > 0) continue;
      markHistoryLoading(id);
      try {
        const transcript = await window.kiroApi.readTranscript(id);
        if (Array.isArray(transcript) && transcript.length > 0) {
          const restored: Message[] = transcript.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls,
            attachments: (m as any).attachments,
            pastes: (m as any).pastes,
            ...((m as any).kirolex ? { kirolex: true as const } : {}),
            ...(typeof (m as any).noteGroup === 'string' ? { noteGroup: (m as any).noteGroup } : {}),
            ...(typeof (m as any).toolTailFrom === 'number' ? { toolTailFrom: (m as any).toolTailFrom } : {}),
            ...replyMarksOf(m),
            ...(asVariants((m as any).variants) ? { variants: asVariants((m as any).variants) } : {}),
            ...(asSteerParts((m as any).steerParts) ? { steerParts: asSteerParts((m as any).steerParts) } : {}),
            ...questionOf(m),
            timestamp: m.ts,
          }));
          const live = messagesCacheRef.current.get(id) || [];
          const liveById = new Map(live.map((message) => [message.id, message]));
          const restoredIds = new Set(restored.map((message) => message.id));
          // 还没处理的失败 steer 挂回这一轮（已经在 live 里的不重复）
          const merged = withFailed(id, [
            ...restored.map((message) => liveById.get(message.id) || message),
            ...live.filter((message) => !restoredIds.has(message.id)),
          ]);
          commitBackgroundMessages(id, merged);
          rebuildFileChanges(id, merged, currentSessionRef.current === id);
        }
      } catch { /* a pane that cannot be read just stays empty */ }
      finally { clearHistoryLoading(id); }
    }
  }, [commitBackgroundMessages]);

  const switchSession = useCallback(async (sessionId: string) => {
    // Hand the OUTGOING chat its own pane view BEFORE focus moves, carrying the very
    // array it is already rendering.
    //
    // Two measured problems, one cause -- `setPaneSessions` seeds pane views from an
    // EFFECT, i.e. a commit too late:
    //   1. for one commit the outgoing pane had no view at all, so it rendered as an
    //      EMPTY conversation: every row unmounted and was then re-created as a new
    //      node (24 mutations, 0 surviving node objects, on a 10-row chat);
    //   2. once seeded from the cache it got an equal-but-DIFFERENT array, so every
    //      memo bailed out and highlight.js re-ran over the whole transcript (554
    //      `code` + 60 `pre` attribute mutations on an 82-row chat), even though the
    //      message ids before and after were identical.
    // Seeding here, batched with the focus change, keeps the identity and therefore
    // costs nothing: the pane simply keeps rendering what it already had.
    const outgoing = currentSessionRef.current;
    if (outgoing && outgoing !== sessionId && onScreenPaneIdsRef.current.has(outgoing)) {
      /**
       * 只有当这个 ref 里的数组**确实属于 outgoing** 时才寄存它。
       *
       * ref 在 effect 里更新（提交之后），`currentSessionRef` 是同步更新的，所以两者会短暂不一致：
       * 焦点已经是 B，ref 里还是 A 的消息。不检查就会把 A 的对话寄存成 B 的，而下面这个 setPaneViews
       * **只写一次**（`prev[outgoing] ? prev : …`），一旦写错就永久钉住 —— 那正是「修改画布下面那个
       * session 变成了别的会话内容」的成因。
       *
       * 不匹配时退回 `paneFallback(outgoing)` 自己那份（它按 id 从消息缓存取，天然不会错人）。这样
       * 最坏情况只是失去「保持数组同一性」这个优化（可能闪一下），而不是显示错误的对话。
       */
      const snapshot = focusedMessagesRef.current;
      const carried = snapshot.sessionId === outgoing ? snapshot.messages : null;
      paneSessionIdsRef.current.add(outgoing);   // patchPane only writes for known panes
      setPaneViews((prev) => (prev[outgoing]
        ? prev
        : {
            ...prev,
            [outgoing]: carried
              ? { ...paneFallback(outgoing), messages: carried }
              : paneFallback(outgoing),
          }));
    }
    /*
      **切走一条会话 = 取消它挂着的提问**（需求：「这一轮被 Stop / 会话切走 → cancel」）。还在分屏里看得见的那格不算切走
      （它的卡片照样能答）。判据在 `questionCards.shouldCancelOnLeave`，实际的回包 / 关卡片 / 落盘在主进程 `cancelQuestionsFor`。
    */
    if (shouldCancelOnLeave(outgoing, sessionId, onScreenPaneIdsRef.current)) cancelQuestionsIfGone([outgoing!]);
    currentSessionRef.current = sessionId; // sync immediately to avoid leaked updates
    setCurrentSessionId(sessionId);
    currentMessageRef.current = '';
    toolCallsRef.current.clear();
    // Reflect this session's persistent context-sync links (if any)
    refreshContextLinks(sessionId);
    // Restore this session's own usage; clear the tool indicator
    setUsage(usageMapRef.current.get(sessionId) || null);
    // EMPTY_PANE_PLAN, not a fresh []: the pane mirror uses the same shared value, so a
    // chat without a plan keeps one identity and the switch costs no extra render.
    setPlan(planMapRef.current.get(sessionId) || EMPTY_PANE_PLAN);
    setFileChanges(fileChangesMapRef.current.get(sessionId) || []);
    setActiveToolCall(activeToolMapRef.current.get(sessionId) || null);
    setActivityStatus(activityMapRef.current.get(sessionId) || null);
    setTurnStall(stallMapRef.current.get(sessionId) || null);

    // Restore from local cache instantly
    const cached = messagesCacheRef.current.get(sessionId);
    setMessages(cached || []);
    /* 静止的会话先和 store 对账再查恢复（见下面 reconcileFirst 那段）；正在跑 / 有没吃完的追加指令时照旧当场查 */
    /*
      **正在建的会话也对账，但不查恢复** ——「远程新建会话界面仍出现历史会话内容」。原来正在建（远程要等
      preflight + 连 ssh + session/new，好几秒）就整段跳过：缓存里有什么就画什么，还拿这份没核对过的缓存
      去查自动重发。一条还没建好的会话没有被打断的一轮可以重发；它缓存里本会话的东西（你先发出的那条、
      KiroLex 提示）都登记过 localOnly，对账会留着，别的一律清掉（store 是空的也照样对，见 messageReconcile）。
    */
    const creating = creatingRef.current.has(sessionId);
    const reconcileFirst = !!cached && cached.length > 0
      && !sessionId.startsWith('pending_')
      && !streamingIdsRef.current.has(sessionId)
      && !(pendingSteersRef.current.get(sessionId)?.length);
    if (cached && cached.length > 0 && !reconcileFirst && !creating) recoverInterruptedTurn(sessionId, cached, { assumeCurrent: true });

    // Pending new/forked chats intentionally have no backend executor until
    // their first message materializes the real session and injects history.
    if (sessionId.startsWith('pending_')) return;

    // Cache miss (a session hydrated from disk but not yet opened this run):
    // load its transcript from disk. Message bodies are no longer mirrored into
    // localStorage, so this is the normal path after a restart. Mark the session
    // as LOADING while the read runs: painting `[]` first made a cold chat flash
    // an empty/"no messages" state that filled in a moment later, which reads as
    // "the history is gone". loadSession below resumes the backend without
    // re-streaming, so this is the only path that repopulates old chats.
    const fromStored = messageFromStored;
    if (!cached || cached.length === 0) {
      const known = sessionsRef.current.find((s) => s.id === sessionId);
      const hasTranscript = !!known && !sessionId.startsWith('pending_');
      if (hasTranscript) markHistoryLoading(sessionId);
      try {
        const transcript = await window.kiroApi.readTranscript(sessionId);
        if (Array.isArray(transcript) && transcript.length > 0) {
          const restored: Message[] = transcript.map(fromStored);
          const live = messagesCacheRef.current.get(sessionId) || [];
          const liveById = new Map(live.map((message) => [message.id, message]));
          const restoredIds = new Set(restored.map((message) => message.id));
          // 还没处理的失败 steer 挂回这一轮（已经在 live 里的不重复）
          const merged = withFailed(sessionId, [
            ...restored.map((message) => liveById.get(message.id) || message),
            ...live.filter((message) => !restoredIds.has(message.id)),
          ]);
          messagesCacheRef.current.set(sessionId, merged);
          rebuildFileChanges(sessionId, merged, currentSessionRef.current === sessionId);
          // Only apply if the user hasn't switched away while we were reading.
          if (currentSessionRef.current === sessionId) setMessages(merged);
          recoverInterruptedTurn(sessionId, merged, { assumeCurrent: true });
        }
      } catch {
        /* transcript unreadable; fall through to executor attach */
      } finally {
        clearHistoryLoading(sessionId);
      }
    } else if (reconcileFirst) {
      /*
        **有缓存也和 store 对账** ——「新会话里出现大量别的会话的历史，切走切回还在」。
        缓存一旦被写进别的会话的消息（那次是后台会话断线重跑时的 `setMessages(retained)`），上面那条路
        看到非空就直接用，盘上明明是干净的，界面却一直错下去。对不上就以 store 为准（判据见 messageReconcile）。
        **对完账才检查要不要自动重发**，而且只拿对过账的那份去查：污染缓存末尾那条外来的「没答的提问」
        要是先被恢复流程捕获，就会被当成这条会话的问题重发、截短后的污染历史还会被写进这条会话的 transcript。
        读不到 / 读盘期间这条会话动过：这次不查（没记成查过，下次打开再查）。
      */
      const verified = await reconcileCacheFromStore(sessionId);
      if (verified && !creating) recoverInterruptedTurn(sessionId, verified.messages, { assumeCurrent: true });
    }

    // Attach the executor on switch so the SELECTED chat becomes live (green dot)
    // and is ready to prompt — regardless of whether messages are cached. (Archived
    // chats stay inert.) loadSession resumes the backend session WITHOUT re-streaming
    // history, so cached messages are never duplicated.
    const isArchived = !!sessions.find((s) => s.id === sessionId)?.archived;
    const needsLoad = !attachedIdsRef.current.has(sessionId) || !cached || cached.length === 0;
    /*
      **还在新建的不 attach** —— 实测（s_1792726606826_e2mprs）：新建远程会话的第 10 秒这里就去 loadSession，
      主进程那边记录还没写完，于是按默认值（本机 kiro）去连、报「该会话在磁盘上不存在」。新建自己会把执行器起好。
    */
    if (!isArchived && needsLoad && !creatingRef.current.has(sessionId)) {
      try {
        lastPromptedSessionRef.current = sessionId;
        markConnecting(sessionId); // flash while the executor attaches
        setSessionActivity(sessionId, t('Connecting to chat…'));
        const res = await window.kiroApi.loadSession(sessionId, attachCwdFor(sessionId), modelForSession(sessionId));
        addAttached(sessionId);
        // Deliberately NOT rebuilding here on res.freshBackend. This path runs for
        // EVERY warmed chat at boot, so it burned a model turn per chat the user
        // never opened -- and the cost grew over time, since a chat qualifies once
        // it has been primed even once. The rebuild is owned by the two "actually
        // being used" gates in main: acp:ensure-context (opened) and acp:prompt
        // (sent), which verify the same evidence (backend id + pid).
        void res;
      } catch {
        // Session might not be loadable
      } finally {
        clearConnecting(sessionId);
        // Do not clobber a rebuild status: ensureContext (below) can mark this chat
        // as owing a rebuild while the attach is still finishing, and its status is
        // the only thing telling the user why the chat is locked.
        if (!isRebuilding(sessionId)) {
          setSessionActivity(sessionId, null);
        }
      }
    }
    // Opening a chat is the point at which we know it is about to be used, so ask
    // main to verify the backend really holds this chat's history and rebuild it
    // if not. Unconditional, and outside the attach branch: an already-attached
    // chat skips loadSession entirely, and a `session/load` that "succeeded" is no
    // evidence either (kiro-cli does not persist ACP sessions). Without this the
    // rebuild only started once the user had typed and sent a message.
    if (!isArchived) {
      void window.kiroApi.ensureContext?.(sessionId).catch(() => {});
    }
  }, [sessions]);
  switchSessionRef.current = switchSession;

  /**
   * 预热一个会话 —— 「为什么我点开一个之前的项目没有自动预热」。
   *
   * 侧栏那条规则(展开=热、折叠=冷)一直在跑,坏的是它调用的动作:App 那边只 `loadSession` 了一下,而
   * `switchSession` 里真正让一个会话变成「活的」需要四件事 —— 标记连接中(点变黄)、loadSession、
   * **登记 attach**(点变绿,后面的发送才知道它已经连上)、以及 `ensureContext`(让 main 核对后端是不是
   * 真的还持有这段历史,不持有就重建)。少了后两件,后端可能连上了,而界面上那个点永远不变 —— 看着就是
   * 「没预热」,而且第一次发消息时才补上那一整套。
   *
   * 已经 attach 过的直接跳过,所以它可以被反复调用(侧栏每次展开都会调)。
   */
  const warmSession = useCallback(async (sessionId: string) => {
    const record = sessions.find((s) => s.id === sessionId);
    if (!record || record.archived || String(sessionId).startsWith('pending_')) return;
    /* 还在新建：新建自己会起执行器，这里再 attach 就是按默认值去连一条还没写完的会话（见 switchSession 那段） */
    if (creatingRef.current.has(sessionId)) return;
    if (!attachedIdsRef.current.has(sessionId)) {
      markConnecting(sessionId);
      try {
        await window.kiroApi.loadSession(sessionId, attachCwdFor(sessionId), modelForSession(sessionId));
        addAttached(sessionId);
      } catch {
        /* 连不上就让它保持冷的：点开它会再试一次 */
      } finally {
        clearConnecting(sessionId);
      }
    }
    void window.kiroApi.ensureContext?.(sessionId).catch(() => {});
  }, [sessions]);
  const warmSessionRef = useRef(warmSession);
  warmSessionRef.current = warmSession;

  /**
   * **没连上的会话换了机器，立刻在新机器上连** —— 原来只改记录，于是本机没配 kiro 时留下的
   * 「⚠️ 这条会话没连上：…本机…」和失败状态一直挂着，看着像切到远程还在报本机的错。
   *
   * 走的是普通 attach（load-session 按**记录**起执行器，记录里的 remote 刚被改好），所以远程不会变本地。
   * 连上：摘掉失败状态和旧的那条提示；连不上：换成新机器的那一条（只留一条），保持失败。
   * 已经连着的不碰 —— 主进程那条路已经换好执行器了。
   */
  const reconnectAfterRetarget = async (sessionId: string) => {
    const record = sessionsRef.current.find((s) => s.id === sessionId);
    if (!record || record.archived || String(sessionId).startsWith('pending_')) return;
    if (creatingRef.current.has(sessionId) || attachedIdsRef.current.has(sessionId)) return;
    markConnecting(sessionId);
    try {
      await window.kiroApi.loadSession(sessionId, attachCwdFor(sessionId), modelForSession(sessionId));
      addAttached(sessionId);
      clearFailed(sessionId);
      /* 没缓存过的后台会话不往缓存里写空数组 —— 那会让点开时以为已经有内容、不去读盘 */
      if (currentSessionRef.current === sessionId || messagesCacheRef.current.has(sessionId)) mutateSessionMessages(sessionId, (cur) => replaceConnectFailureNotices(cur));
      void window.kiroApi.ensureContext?.(sessionId).catch(() => {});
    } catch (err: any) {
      const why = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      markFailed(sessionId);
      /* 没缓存的后台会话先把历史读进来：只塞一条提示的话缓存就"非空"了，点开时会跳过读盘、历史看不见 */
      if (currentSessionRef.current !== sessionId) {
        const seeded = await historyBeforeNotice(messagesCacheRef.current.get(sessionId), () => window.kiroApi.readTranscript(sessionId));
        /* 读盘期间别处（点开 / 分屏）可能已经填好了缓存，那就不覆盖 */
        if (seeded && !(messagesCacheRef.current.get(sessionId) || []).length) {
          messagesCacheRef.current.set(sessionId, seeded);
          rebuildFileChanges(sessionId, seeded, false);
        }
      }
      mutateSessionMessages(sessionId, (cur) => replaceConnectFailureNotices(cur, connectFailureNotice(why, undefined, uiLangNow())));
    } finally {
      clearConnecting(sessionId);
    }
  };
  reconnectAfterRetargetRef.current = reconnectAfterRetarget;

  /**
   * **会话里点「安装」装好适配器之后，重连这条会话** —— 新建没成的（主进程还没有记录）照原样再建一次，
   * 其余的普通 attach。不看 attachedIds：发消息那条路会先 `addAttached` 再发，失败了它也还在集合里。
   * 连上：「没连上」那条（带安装按钮的）换成「装好了、已连上」；连不上：换成新的那条原因。
   */
  const reconnectAfterInstall = async (sessionId: string, engine: 'claude' | 'codex' | 'kiro', via: 'install' | 'login' = 'install'): Promise<{ ok: boolean; error?: string }> => {
    const retryCreate = failedCreateRef.current.get(sessionId);
    markConnecting(sessionId);
    try {
      if (retryCreate) {
        await retryCreate();
        failedCreateRef.current.delete(sessionId);
      } else {
        await window.kiroApi.loadSession(sessionId, attachCwdFor(sessionId), modelForSession(sessionId));
      }
      addAttached(sessionId);
      clearFailed(sessionId);
      mutateSessionMessages(sessionId, (cur) => replaceConnectFailureNotices(cur, adapterInstalledNotice(engine, Date.now(), uiLangNow(), via)));
      void window.kiroApi.ensureContext?.(sessionId).catch(() => {});
      return { ok: true };
    } catch (err: any) {
      const why = cleanIpcError(err);
      markFailed(sessionId);
      mutateSessionMessages(sessionId, (cur) => replaceConnectFailureNotices(cur, connectFailureNotice(why, undefined, uiLangNow())));
      return { ok: false, error: why };
    } finally {
      clearConnecting(sessionId);
    }
  };
  const reconnectAfterInstallRef = useRef(reconnectAfterInstall);
  reconnectAfterInstallRef.current = reconnectAfterInstall;
  useEffect(() => {
    setAdapterInstallRunner({
      install: (sid, engine) => window.kiroApi.installAdapter
        ? window.kiroApi.installAdapter(sid, engine, intendedRemoteRef.current.get(sid) || undefined)
          /* 主进程已经写进会话了就不在按钮旁再说一遍 */
          .then((r) => (r.ok || !r.noted ? r : { ok: false, error: '' }))
        : Promise.resolve({ ok: false, error: 'installAdapter unavailable' }),
      reconnect: (sid) => reconnectAfterInstallRef.current(sid, adapterInstallStore.get(sid)?.engine || 'claude', adapterInstallStore.get(sid)?.via || 'install'),
    });
    /* 本机没登录的「登录」：开终端跑登录命令，然后轮询本机状态（跳过 5 分钟缓存）到这一家登上 */
    setEngineLoginRunner({
      login: (engine) => window.kiroApi.enginesLogin ? window.kiroApi.enginesLogin('local', engine) : Promise.resolve({ ok: false, error: 'enginesLogin unavailable' }),
      loggedIn: async (engine) => {
        const r = await window.kiroApi.enginesStatus?.('local', { force: true });
        return !!r?.ok && r.statuses?.find((s) => s.engine === engine)?.state === 'ok';
      },
    });
    const off = window.kiroApi.onAdapterInstallOutput?.((d) => { if (d?.sessionId) adapterInstallStore.append(d.sessionId, String(d.chunk || '')); });
    return () => { setAdapterInstallRunner(null); setEngineLoginRunner(null); try { off?.(); } catch { /* 卸载时 preload 可能已经没了 */ } };
  }, []);

  /**
   * **恢复之后立刻出现、立刻连上** ——「恢复了之后的会话应该被立刻连接，为什么没有连接」。
   * 备份页恢复完发 `kirolex:sessions-restored`：先从磁盘把侧栏对一遍（新冒出来的会话和它的项目
   * 就出现了），等这一轮状态落定，再逐条预热（和侧栏展开一个项目时走的是同一个动作）。
   */
  useEffect(() => {
    const onRestored = (e: Event): void => {
      const ids: string[] = Array.isArray((e as CustomEvent).detail?.ids) ? (e as CustomEvent).detail.ids : [];
      /* 恢复时顺手取消归档的那几条：水化会把 archived 改成 false，也要等它落定，不然 warmSession 看到的还是归档、直接跳过 */
      const unarchived: string[] = Array.isArray((e as CustomEvent).detail?.unarchived) ? (e as CustomEvent).detail.unarchived : [];
      void (async () => {
        await hydrateFromDiskRef.current();
        /* setSessions 是异步落定的：warmSession 读的是 sessions，等它看得见新条目 */
        const settled = (): boolean =>
          ids.every((id) => sessionsRef.current.some((x) => x.id === id))
          && unarchived.every((id) => !sessionsRef.current.find((x) => x.id === id)?.archived);
        for (let i = 0; i < 20 && !settled(); i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        for (const id of ids) void warmSessionRef.current(id);
      })();
    };
    window.addEventListener('kirolex:sessions-restored', onRestored);
    return () => window.removeEventListener('kirolex:sessions-restored', onRestored);
  }, []);

  const sendMessage = useCallback(async (prompt: any[], localResponse?: string, attachments?: any[], model?: string, display?: { text?: string; pastes?: any[]; /** 调用方指定的用户消息 id（自动重发经控制入口发的那条时带标记） */ messageId?: string }, targetSid?: string) => {
    // `targetSid` makes this send TARGET-ADDRESSED. Without it this function always
    // sent to whatever chat was focused, which is wrong for every caller that acts
    // on a specific chat: rerunFromMessage truncated the transcript of chat A (it
    // did receive the session id) and then sent the prompt through here, i.e. into
    // chat B. Observed live: an auto-resend for one chat truncated that chat --
    // making the user's two screenshots vanish from it -- and delivered the very
    // same message, screenshots included, into the unrelated chat that happened to
    // be open, which then answered it.
    let sid = targetSid || currentSessionRef.current || currentSessionId;
    /** 发起时的那个 id —— 只有 pending → 真会话时 sid 才会变 */
    const originSid = sid;
    const activeModel = model || modelForSession(sid);
    /* 自动续写发的那条不算；人发的一条 = 这条会话的续写次数从头算 */
    if (sid) { if (autoContinueInFlightRef.current.has(sid)) autoContinueInFlightRef.current.delete(sid); else wedgeContinuesRef.current.delete(sid); }

    // Cancel-overwrite: if this session had a turn cancelled, the next submit
    // OVERWRITES the interrupted turn — truncate from that user message and
    // rerun with the new text (reuses the live session, no rebuild). Only for a
    // plain text submit (not localResponse-only echoes).
    if (sid && !localResponse && overwriteTargetRef.current.has(sid)) {
      const targetId = overwriteTargetRef.current.get(sid)!;
      clearInterrupted(sid);
      const textForOverwrite = prompt.find((p) => p.type === 'text' && !String(p.text).startsWith('<hidden>'))?.text || '';
      if (textForOverwrite.trim() && rerunFromMessageRef.current) {
        noteError(sid, null); // clear this chat's banner on resubmit
        await rerunFromMessageRef.current(targetId, textForOverwrite, {
          prompt,
          attachments,
          pastes: display?.pastes,
          displayText: display?.text ?? textForOverwrite,
        }, sid);
        return;
      }
    }

    // Archived chats are inert: never attach an executor or prompt. They become
    // chattable only after being moved out of the archive (unarchived). The
    // composer is also disabled in the UI; this is the hard safety net.
    if (sid) {
      const curSess = sessions.find((s) => s.id === sid);
      if (curSess?.archived) return;
    }

    // The bubble/transcript show the DISPLAY text (paste placeholders kept short);
    // the prompt itself carries the fully expanded content for the model.
    const textContent = display?.text
      ?? (prompt.find(p => p.type === 'text' && !p.text.startsWith('<hidden>'))?.text || '');
    const pastes = display?.pastes?.length ? display.pastes : undefined;

    // Use one stable id in the renderer and append-only durable transcript so
    // later busy-Enter steering can target and materialize into this user turn.
    const userMessageId = display?.messageId || `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimisticUserMessage: Message = {
      id: userMessageId,
      role: 'user',
      content: textContent,
      attachments,
      pastes,
      timestamp: Date.now(),
    };
    /* 这条是为这条会话写的：发送失败没落盘时，切会话对账也认它（见 messageReconcile） */
    if (sid) markLocalOnly(sid, [userMessageId]);
    if (sid) mutateSessionMessages(sid, (current) => [...current, optimisticUserMessage]);
    else setMessages((current) => [...current, optimisticUserMessage]);

    if (localResponse) {
      const response: Message = {
        id: `msg_${Date.now()}`,
        role: 'assistant',
        content: localResponse,
        timestamp: Date.now(),
      };
      /* 本地回显不落盘：切会话对账时别当成别的会话的丢掉 */
      if (sid) markLocalOnly(sid, [userMessageId, response.id]);
      if (sid) mutateSessionMessages(sid, (current) => [...current, response]);
      else setMessages((current) => [...current, response]);
      return;
    }

    // If no session or session is pending, create a real one
    if (!sid || sid.startsWith('pending_')) {
      // Capture the pending id first: a duplicated session stashes its source
      // history under this id and needs it injected once the real session exists.
      const pendingId = sid;
      const pendingProjectId = pendingId && duplicateProjectRef.current.has(pendingId)
        ? duplicateProjectRef.current.get(pendingId)
        : projectForSession(pendingId);
      // If a creation is already in flight for this pending session (e.g. the
      // New Chat dialog just created it), await THAT creation instead of racing
      // a duplicate — otherwise the message lands on an orphaned session.
      if (pendingId && creatingRef.current.has(pendingId)) {
        try {
          sid = await creatingRef.current.get(pendingId)!;
          sessionModelRef.current.set(sid, activeModel);
          /* 等的这段时间你切走了就不抢焦点（同下面 newSession 那段） */
          if (currentSessionRef.current === pendingId) {
            currentSessionRef.current = sid;
            setCurrentSessionId(sid);
          }
        } catch { /* fall through to create below */ }
      }
      if (!sid || sid.startsWith('pending_')) {
        const newId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
          await window.kiroApi.newSession(
            newId,
            '~',
            activeModel,
            pendingProjectId,
            undefined,
            permissionModeForSession(pendingId),
            /*
              **本来要跑在哪台机器上就还是那台** ——「这个新会话怎么还变成了本地的了，WTF」。
              这个参数原来压根没传：于是上一次远程建失败之后，这条兜底路把它建成了本地会话。
              远程会话**不许悄悄变本地** —— 连不上就该失败，而不是换一台机器把活干了。
            */
            /*
              没记过就用**新会话的默认机器**（`kirolex-new-chat-remote`，见 App 里那段）——
              「为什么新会话又变成本地了」：这条路原来只看 `intendedRemoteRef`，而一个从侧栏
              直接开出来的 pending 会话从没经过 `createSession`，那张表里自然没有它 → 建成本地。
            */
            /*
              **记过的优先，记的是本机也算记过**（审计 10b）：分叉出来的会话记的是源会话的机器（本机 = 空串），
              原来写成 `get(pendingId) || 默认机器`，本机那种就被默认机器顶掉了。
            */
            firstSendRemoteId(intendedRemoteRef.current, pendingId,
              () => { try { return uiGet('kirolex-new-chat-remote') || undefined; } catch { return undefined; } }),
            (pendingId && intendedEngineRef.current.get(pendingId)) || undefined,
          );
          const prevId = sid;
          sid = newId;
          /*
            **你已经切走了就不抢焦点** —— newSession 要等几秒（远程更久）。期间切到 C 的话，原来这里照样把焦点
            拉回新会话，而 messages 还是 C 的：第一个 chunk 一到，C 的消息加 chunk 就被记成新会话的（见 messagesOwner）。
            没切走（包括从欢迎页发、期间也没点开别的会话）照旧聚焦新会话。
          */
          const stillViewing = (currentSessionRef.current || null) === (prevId || null);
          if (stillViewing) {
            currentSessionRef.current = sid;
            setCurrentSessionId(sid);
          }
          sessionModelRef.current.set(sid, activeModel);
          addAttached(sid);
          if (prevId && prevId.startsWith('pending_')) {
            const pendingMessages = messagesCacheRef.current.get(prevId);
            if (pendingMessages) {
              messagesCacheRef.current.set(sid, pendingMessages);
              messagesCacheRef.current.delete(prevId);
            }
            moveLocalOnly(prevId, sid);
            setSessions((prev) => prev.map((s) => (
              s.id === prevId ? { ...s, id: sid!, projectId: pendingProjectId } : s
            )));
            duplicateProjectRef.current.delete(prevId);
          } else {
            setSessions((prev) => [
              { id: sid!, title: 'New Chat', model: activeModel, timestamp: Date.now() },
              ...prev,
            ]);
          }
        } catch (err: any) {
          noteError(sid, err?.message || t('Failed to create session'));
          return;
        }
      }

      // Duplicated session: inject the copied conversation history into the new
      // backend session as a single <hidden> priming block so the model has the
      // full prior context on this very first message.
      const dupHistory = pendingId ? duplicateHistoryRef.current.get(pendingId) : undefined;
      if (dupHistory) {
        duplicateHistoryRef.current.delete(pendingId!);
        if (dupHistory.length > 0) {
          const body = chatHistoryBody(dupHistory);
          prompt = [
            {
              type: 'text',
              text: `<hidden>这是一个复制出来的会话，下面是它此前的完整对话历史。请把这些内容当作我们当前对话的已有上下文，在此基础上无缝继续，不要重复或复述这些历史：\n\n${body}</hidden>`,
            },
            ...prompt,
          ];
        }
      }
    }

    // A stable session rebuilt for edit-and-rerun also carries retained
    // history in duplicateHistoryRef. Unlike a fork, its key is already real.
    const rebuiltHistory = sid ? duplicateHistoryRef.current.get(sid) : undefined;
    if (rebuiltHistory) {
      duplicateHistoryRef.current.delete(sid!);
      if (rebuiltHistory.length > 0) {
        const body = chatHistoryBody(rebuiltHistory);
        prompt = [
          {
            type: 'text',
            text: `<hidden>下面是当前会话在编辑重跑点之前保留的完整历史。请把这些内容当作已有上下文，在此基础上回答新的用户消息，不要复述这些历史：\n\n${body}</hidden>`,
          },
          ...prompt,
        ];
      }
    }

    // Cross-session context sync: if this session is linked to one or more
    // sources, inject each source's NEW messages (delta since last sync) as a
    // single <hidden> block. Migrate link key if the id changed (pending -> real).
    /*
      搬的是**这条消息自己的** pending id，不是焦点会话：原来比的是 `currentSessionId`，分屏里给另一格
      （或后台排队 / 控制入口）发消息时 sid ≠ 焦点，焦点会话的上下文链接就被整份搬到了那一条上。
    */
    if (originSid && originSid !== sid && contextLinksRef.current.has(originSid)) {
      const moved = contextLinksRef.current.get(originSid)!;
      contextLinksRef.current.delete(originSid);
      contextLinksRef.current.set(sid!, moved);
      persistContextLinks();
    }
    const links = sid ? (contextLinksRef.current.get(sid) || []) : [];
    if (links.length > 0) {
      const sections: string[] = [];
      let changed = false;
      const updated: { sourceId: string; sourceTitle: string; syncedCount: number }[] = [];
      for (const link of links) {
        // Authoritative source: the durable transcript (uncapped, survives
        // restart, keyed by the stable KiroLex id). Fall back to the renderer
        // cache only if the transcript is empty/unreadable (e.g. a brand-new
        // source with nothing persisted yet).
        let srcMsgs: { role: string; content: string }[] = [];
        try {
          const t = await window.kiroApi.readTranscript(link.sourceId);
          srcMsgs = Array.isArray(t) && t.length > 0
            ? t
            : (messagesCacheRef.current.get(link.sourceId) || []);
        } catch {
          srcMsgs = messagesCacheRef.current.get(link.sourceId) || [];
        }
        const delta = srcMsgs.slice(link.syncedCount);
        if (delta.length > 0) {
          const body = chatHistoryBody(delta);
          /* 新增的只有 KiroLex 的提示 → 没什么可同步的，只把进度记上 */
          if (body) sections.push(`【${link.sourceTitle}】\n${body}`);
          changed = true;
          updated.push({ ...link, syncedCount: srcMsgs.length });
        } else {
          updated.push(link);
        }
      }
      if (sections.length > 0) {
        prompt = [
          {
            type: 'text',
            text: `<hidden>下面是我提供给你参考的背景对话记录（来自我之前的几段对话），请把它们当作我们当前对话的已知信息，在回答我接下来的问题时加以利用：\n\n${sections.join('\n\n')}</hidden>`,
          },
          ...prompt,
        ];
      }
      if (changed) {
        contextLinksRef.current.set(sid!, updated);
        persistContextLinks();
      }
    }

    // Ensure the executor is attached before prompting: a just-created chat's
    // spawn may still be in flight (creatingRef). id is stable, so just wait.
    if (sid && creatingRef.current.has(sid)) {
      try { await creatingRef.current.get(sid); } catch {}
    }

    const turnToken = beginStreamingTurn(sid!);
    /* 你又发了一条：之前按过的「停止」不再代表"别替我重试"（原来那个标记一直留到重建上下文为止） */
    recoveryCancelledRef.current.delete(sid!);
    addAttached(sid!); // first use -> live
    lastPromptedSessionRef.current = sid;
    setSessionActivity(sid, t('Sent, waiting for {engine} to respond…', { engine: engineLabel(sessionsRef.current.find((s) => s.id === sid)?.engine) }));

    try {
      const res = await window.kiroApi.prompt(sid, prompt, activeModel, projectForSession(sid), { messageId: userMessageId, displayText: textContent, attachments, pastes });
      const notice = noticeForStopReason((res as any)?.stopReason, res) || noticeForEmptyTurn(res);
      // No focus condition any more: the notice is stored against the chat it
      // describes, so it shows in that chat's pane whether or not it has focus.
      if (notice) noteError(sid, notice);
    } catch (err: any) {
      const msg = String(err?.message || '');
      // Session is busy with a long turn / context compaction — NOT a dropped
      // connection. Do not reconnect or show a raw remote-method error; show a
      // soft, clear status so it doesn't look broken. The message text stays put.
      if (msg.includes('active turn') || msg.includes('context compaction') || msg.includes('already in progress') || msg.includes('仍在后端运行') || msg.includes('change to finish')) {
        // The backend turn is genuinely still running (its stream notifications
        // keep arriving) -- ADOPT it: show the session as busy again instead of
        // leaving a dead-looking chat. Its turn-end event clears this normally.
        if (!msg.includes('change to finish')) addStreaming(sid);
        setSessionActivity(sid, t('⏳ The current turn is still running (maybe compacting context); send after it finishes.'));
      } else {
        // Not attached (dormant/reopened this run) -> attach the SAME session
        // (main resumes its kiro-cli session; the KiroLex id stays stable) and retry once.
        /*
          **执行器死在这一轮中间**（"Process exited" / "Disconnected"）：交给断线那条恢复（onDisconnected →
          recoverInterruptedTurn）去重发 —— 它走 rerun，先把记录截回去再发。这里再顺手重发一次的话，
          两条路叠在一起：实测记录里那个问题出现了两遍（这条路不重写记录）。
          这条内联重试只留给它本来的用途：给一条还没连上的会话发消息。
        */
        if (/Process exited|Disconnected/i.test(msg) && autoRetryMax() > 0 && !recoveryCancelledRef.current.has(sid!)) {
          setSessionActivity(sid, t('⏳ The connection dropped mid-turn; reconnecting and resending this turn…'));
          return;
        }
        try {
          /* 你刚按了停止就别替你重连重发 */
          if (recoveryCancelledRef.current.has(sid!)) throw err;
          setSessionActivity(sid, t('Reconnecting to chat…'));
          await window.kiroApi.loadSession(sid, attachCwdFor(sid), activeModel);
          setSessionActivity(sid, t('Reconnected, resending…'));
          await window.kiroApi.prompt(sid, prompt, activeModel, projectForSession(sid), { messageId: userMessageId, displayText: textContent, attachments, pastes });
        } catch (retryErr: any) {
          const msg = String(retryErr?.message || retryErr || '');
          // The backend's own busy guard is contention, not a conversation turn.
          // Writing it in as an assistant bubble put a raw IPC error string into
          // the user's chat (observed live). Surface it as a session activity
          // line; the un-answered user message is already marked for overwrite,
          // so re-submitting reruns that turn.
          if (/active turn|context compaction|still (busy|running)|当前这一轮|上下文压缩/i.test(msg)) {
            setSessionActivity(sid, t('⏳ The previous turn is still wrapping up, so this was not sent; resend it shortly'));
            removeStreaming(sid);
            return;
          }
          turnOutcomeRef.current.set(sid!, { kind: 'error', message: retryErr?.message || t('Failed to send message.') });
          /* 连不上是因为缺 Claude Code / Codex 的适配器：给「没连上」那条（带「安装」按钮），不给一个答不了的助手气泡 */
          /* 「没登录」同理（本机会话那条上有「登录」按钮） */
          if (adapterInstallOffer(cleanIpcError(retryErr)) || engineLoginOffer(cleanIpcError(retryErr))) {
            markFailed(sid!);
            mutateSessionMessages(sid!, (prev) => replaceConnectFailureNotices(prev, connectFailureNotice(String(retryErr?.message || retryErr), undefined, uiLangNow())));
            return;
          }
          /* 写进**这条**会话：await 期间焦点可能已经换了，分屏里发的也常常不是焦点那一格 */
          const errTs = Date.now();
          /* 只留我们自己的那句：Electron 包的「Error invoking remote method 'acp:load-session': Error: 」不给人看 */
          markLocalOnly(sid!, [`err_${errTs}`]);
          mutateSessionMessages(sid!, (prev) => [
            ...prev,
            { id: `err_${errTs}`, role: 'assistant', content: `⚠️ ${(retryErr?.message && cleanIpcError(retryErr)) || t('Failed to send message.')}`, timestamp: Date.now() },
          ]);
        }
      }
    } finally {
      setSessionActivity(sid, null);
      // Clear streaming only if no replacement prompt started after this turn.
      finishStreamingTurn(sid, turnToken);
    }
  }, [currentSessionId, mutateSessionMessages]);

  // Keep background callbacks on the latest send implementation rather than a
  // render-time closure captured when a loop starts.
  /** 每个会话试过几次自动命名 —— 连着失败三次才退回截断（见 sendMessage 末尾那段） */
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  /**
   * THE JOBS MAIN IS HOLDING, mirrored here only so the UI can state them.
   *
   * This is a read-only mirror and nothing more: main owns the records and the ticker, and it
   * announces every change (created / ran / paused / finished) on `schedule:changed`. The
   * renderer re-asks rather than patching its copy, because a patch would have to re-implement
   * main's `nextRunAt` arithmetic and would drift the moment either side changed.
   */
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  /**
   * The clock the COUNTDOWN is measured against, advanced on a coarse tick.
   *
   * Not a per-second tick: past 60s `countdownText` is minute-grained, so a 1s interval would
   * re-render every sidebar row (they are memoised precisely to avoid that) to produce the
   * identical string. 20s matches main's own ticker, so "即将运行" appears within one period of
   * the run actually starting. This drives DISPLAY only -- it fires nothing.
   */
  const [scheduleNow, setScheduleNow] = useState(() => Date.now());

  useEffect(() => {
    const refresh = () => {
      void window.kiroApi.scheduleList?.()
        .then((list) => setSchedules(Array.isArray(list) ? list : []))
        .catch(() => {});   // no jobs yet, or an older main: an empty banner is the right answer
    };
    refresh();
    const off = window.kiroApi.onScheduleChanged?.(refresh);
    const tick = setInterval(() => setScheduleNow(Date.now()), 20000);
    return () => { off?.(); clearInterval(tick); };
  }, []);

  /**
   * 模型起的后台命令 / 监视（`bg_run` / `watch`）—— 同样只是主进程那份的只读镜像：主进程每次起 / 停 / 结束都发
   * `bg:changed`，这里重新问一遍。会话顶部据此列出标签、运行时长和一个停止按钮。
   */
  const [bgJobs, setBgJobs] = useState<BgJobRow[]>([]);
  useEffect(() => {
    const refresh = () => {
      void window.kiroApi.bgList?.()
        .then((list) => setBgJobs(Array.isArray(list) ? list : []))
        .catch(() => {});
    };
    refresh();
    const off = window.kiroApi.onBgChanged?.(refresh);
    return () => { off?.(); };
  }, []);
  const stopBgJob = useCallback(async (jobId: string) => {
    if (!jobId) return;
    try { await window.kiroApi.bgStop?.(jobId); } catch {}
  }, []);

  /**
   * Create a TIME-TRIGGERED TASK. Replaces `startLoop`.
   *
   * The renderer no longer drives anything: it hands the spec to main, which owns the
   * ticker and the on-disk record. That move is the point rather than a tidy-up -- the old
   * loop's `setTimeout` lived here, so "every Monday 9am" stopped existing the moment the
   * window closed.
   *
   * There is no goal and no verifier. Checked against the real scenarios (weekly report,
   * SFDC logging, oncall), the previous run's result does not change the next run's action,
   * which is the only test of whether something is a loop rather than a scheduled task.
   */
  const createSchedule = useCallback(async (sessionId: string, spec: ScheduleSpec) => {
    if (!sessionId || sessionId.startsWith('pending_')) return;
    const result = await window.kiroApi.scheduleCreate?.(sessionId, spec);
    if (!result?.ok) {
      // Surfaced rather than swallowed: a mis-set job used to look like a created one.
      noteError(sessionId, t('Scheduled task not created: {reason}', { reason: result?.error || t('unknown reason') }));
      return;
    }
    // NOTHING is written to the transcript. Main broadcasts the new job, the banner above this
    // chat states it (trigger, countdown, run budget) and keeps stating it -- whereas this used
    // to push a bubble that LOOKED like conversation, was screen-only (so it disappeared on the
    // next reload) and duplicated what the banner now says permanently.
  }, []);

  /**
   * PAUSE / RESUME a job, and CANCEL one. Both are just relays -- main owns the record.
   *
   * There was no way to reach either from the UI: a job's only exits were exhausting its run
   * budget and editing the store by hand, which for a daily job means it keeps spending turns
   * until someone finds the file. No optimistic local edit, because main broadcasts the change
   * and the mirror is re-read from it; patching here as well would be two sources of truth.
   */
  const pauseSchedule = useCallback(async (id: string, paused: boolean) => {
    if (!id) return;
    try { await window.kiroApi.schedulePause?.(id, paused); } catch {}
  }, []);

  /** 「⏳ 延长…」弹层：同样只是转给 main（延长多久 / 到期时间 / 不过期），改完 main 广播、这里重读；错误交回弹层就地显示。 */
  const setScheduleExpiry = useCallback(async (
    id: string,
    change: { mode: 'extend'; ms: number } | { mode: 'until'; at: number } | { mode: 'never' },
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!id) return { ok: false };
    try { return (await window.kiroApi.scheduleSetExpiry?.(id, change)) ?? { ok: false }; } catch (err: any) { return { ok: false, error: String(err?.message || err) }; }
  }, []);

  const cancelSchedule = useCallback(async (id: string) => {
    if (!id) return;
    try { await window.kiroApi.scheduleRemove?.(id); } catch {}
    // The banner disappearing IS the confirmation. A bubble here would be the same mistake the
    // create note was: UI state dressed as conversation, and screen-only at that.
  }, []);

  const stopLoop = useCallback(async (sessionId: string) => {
    if (!endLoop(sessionId, 'aborted')) return;
    turnOutcomeRef.current.set(sessionId, { kind: 'cancelled' });
    activePromptTokenRef.current.delete(sessionId);
    try {
      await window.kiroApi.cancel(sessionId, modelForSession(sessionId), true);
    } catch {}
    removeStreaming(sessionId);
    dropPermissionCardIfEnded(sessionId);
  }, [endLoop]);

  const rerunFromMessage = useCallback(async (messageId: string, editedText: string, override?: RerunOverride, targetSid?: string) => {
    const sid = targetSid || currentSessionRef.current;
    const text = editedText.trim();
    if (!sid || sid.startsWith('pending_') || !text) {
      noteError(sid, t('Rerun not done: {reason}', { reason: !sid ? t('no current chat') : sid.startsWith('pending_') ? t('the chat has not been created yet (send a message first)') : t('the edited text is empty') }));
      return;
    }
    // Editing does not touch the running turn. On Rerun submit, if a turn is
    // still streaming, abort it first (its partial output is discarded by the
    // truncation below), then reuse the live session to resend the edited text.
    if (streamingIdsRef.current.has(sid)) {
      try {
        await window.kiroApi.cancel(sid, modelForSession(sid), true);
      } catch { /* best-effort; truncation + resend still discards it */ }
      removeStreaming(sid);
      dropPermissionCardIfEnded(sid);
    }

    const current = messagesCacheRef.current.get(sid) || [];
    let targetIndex = current.findIndex((message) => message.id === messageId);
    if (targetIndex < 0) {
      // The recorded id can legitimately disappear: steer messages are never
      // persisted and are stripped on turn-end reconcile, and a hydrate rebuilds
      // ids from the transcript. Fall back to the latest base user message so an
      // interrupted turn can still be rerun / overwritten.
      for (let i = current.length - 1; i >= 0; i--) {
        if (current[i].role === 'user' && !current[i].steer && !isKirolexNote(current[i])) { targetIndex = i; break; }
      }
    }
    if (targetIndex < 0) {
      noteError(sid, t('Could not find the message to rerun (this chat has no user message that can be rerun).'));
      return;
    }
    while (targetIndex > 0 && current[targetIndex].steer) targetIndex--;
    const target = current[targetIndex];
    if (target.role !== 'user') {
      noteError(sid, t('Rerun not done: the located target is not a user message.'));
      return;
    }
    const retained = current.slice(0, targetIndex).map((message) => ({
      ...message,
      attachments: message.attachments?.map((attachment) => ({ ...attachment })),
    }));

    noteError(sid, null);
    // A-mode rerun: REUSE the live backend session — never detach + rebuild.
    // Rewrite KiroLex's durable transcript + view to drop the superseded tail,
    // then send the edited message to the SAME live kiro-cli session. If the
    // executor is dormant, sendMessage resumes it via loadSession (stable id).
    // The backend keeps its own internal history (accepted A tradeoff), so the
    // rerun is instant and never shows "正在重建后端会话".
    try {
      // Rewrite the durable transcript to exactly the retained messages. Robust:
      // does NOT look up target.id in the transcript (which fails for messages
      // never persisted there, e.g. mid-turn steers). Thinking (💭) segments are
      // live-only and never belong in the transcript.
      const storedRetained = toStoredTranscript(retained);
      /*
        **Claude Code / Codex：后端也要忘掉被编辑之后的那段**（审计 10）—— 它们的后端会话是持久的，只截 KiroLex 的记录
        的话模型照样记得。主进程按盘上**还没截短**的记录找分叉点，所以在 rewriteTranscript 之前调。自动重发（carryMark）
        不分叉：那一轮通常什么都没产出。分不了时主进程会在会话里说一句，这里照常重发。kiro 不走。
      */
      if (!override?.carryMark && wantsEditFork(sessionsRef.current.find((s) => s.id === sid)?.engine)) {
        try { await window.kiroApi.forkBackendForEdit?.(sid, storedRetained.map((m) => m.id)); } catch { /* 主进程不抛；IPC 本身失败也照常重发 */ }
      }
      await window.kiroApi.rewriteTranscript(sid, storedRetained);

      /*
        **还没被吃的 steer 不扔** —— 原来这里直接 `delete`，于是重跑（包括自动重发）把它们丢了。
        留着它们：这一轮结束时 App 的轮末对账（takeUnconsumedSteers）会把它们原样放回队列头。
      */
      /* 这两个是全局的（跟着焦点会话的流式走）：后台那条会话重跑时不能清掉正在流式的焦点会话的工具卡片 */
      if (sid === currentSessionRef.current) {
        currentMessageRef.current = '';
        toolCallsRef.current.clear();
      }

      // Truncate the view to retained; sendMessage appends the edited user
      // message and streams the new reply in the same flow (no rebuild step,
      // no priming — the live backend already holds the full context).
      /*
        **按 sid 写，不按焦点写** —— 自动重发（recoverInterruptedTurn）对的常常是后台那条会话。
        原来是 `setMessages(retained)`：焦点那条的界面被换成了这条的历史，归属还记成焦点会话（见 messagesOwner），
        缓存 effect 再把它存成焦点会话的。
      */
      mutateSessionMessages(sid, () => retained);
      // CARRY THE ORIGINAL ATTACHMENTS. A rerun edits the TEXT; the images/files
      // that came with that message are still part of it. Dropping them meant the
      // model lost the picture you were asking about, the chips disappeared, and
      // the boot GC then deleted the now-unreferenced blobs.
      if (override?.prompt?.length) {
        // Overwrite path: send exactly what the composer produced. Display keeps the
        // placeholders (the expanded blob must not be dumped into the bubble) and the
        // attachments are the NEW ones the user just picked.
        await sendMessage(
          override.prompt,
          undefined,
          override.attachments?.length ? override.attachments : undefined,
          modelForSession(sid),
          (override.pastes?.length || override.displayText)
            ? { text: override.displayText ?? text, pastes: override.pastes }
            : undefined,
          sid, // the chat whose transcript was just truncated -- never the focused one
        );
        return;
      }
      const keptAttachments = target.attachments?.length
        ? target.attachments.map((a) => ({ ...a }))
        : undefined;
      const keptPastes = (target as any).pastes?.length ? (target as any).pastes : undefined;
      // 自动重发经控制入口发的那条：新消息的 id 照样带标记（气泡标签、记录里的 via 都跟着它）
      const carried = override?.carryMark ? carryControlMark(target.id, 'user') : undefined;
      const rerunPrompt: any[] = [];
      if (keptAttachments?.length) {
        // Same hidden file-ref block the normal send path uses, so the backend can
        // re-read each file instead of being told about names it cannot open.
        const fileRefs = keptAttachments.map((f: any) => `file:${f.path}`).join('\n');
        rerunPrompt.push({ type: 'text', text: `<hidden>${fileRefs}\n请读取这些文件内容</hidden>` });
      }
      if (keptPastes?.length) {
        // Placeholders left in the edited text must reach the model as real content.
        // Matched by SEQ only: the line count in the label is cosmetic and the user
        // may well have edited the surrounding text.
        const bySeq = new Map<number, string>();
        await Promise.all(keptPastes.map(async (blk: any) => {
          const body = await window.kiroApi.readPaste?.(blk.path);
          if (typeof body === 'string') bySeq.set(Number(blk.seq), body);
        }));
        const filled = text.replace(
          /\[ 粘贴 #(\d+) · \d+ 行 \]/g,
          (whole, seq) => bySeq.get(Number(seq)) ?? whole,
        );
        rerunPrompt.push({ type: 'text', text: filled });
      } else {
        rerunPrompt.push({ type: 'text', text });
      }
      await sendMessage(
        rerunPrompt,
        undefined,
        keptAttachments,
        modelForSession(sid),
        (keptPastes || carried)
          ? { text, ...(keptPastes ? { pastes: keptPastes } : {}), ...(carried ? { messageId: carried } : {}) }
          : undefined,
        sid, // same chat that was truncated above; see sendMessage's targetSid
      );
    } catch (error: any) {
      mutateSessionMessages(sid, () => current);
      noteError(sid, error?.message || t('Edit and rerun failed.'));
    }
  }, [sendMessage, mutateSessionMessages]);
  // Expose rerunFromMessage to the send path (cancel-overwrite) without a
  // circular useCallback dependency.
  rerunFromMessageRef.current = rerunFromMessage;

  // Send one queued follow-up to a specific existing session. Unlike the normal
  // composer path, this is target-addressed so queues keep draining even when
  // the user switches to another chat. The main process owns durable transcript
  // persistence; the renderer mirrors the user/error messages into the correct
  // session cache for immediate UI consistency.
  const sendQueuedMessage = useCallback(async (
    sessionId: string,
    text: string,
    attachments: any[] = [],
    options?: { mergeIntoMessageId?: string; onStarted?: () => void; displayText?: string; pastes?: any[]; /** 调用方指定的用户消息 id（控制入口发的带标记） */ messageId?: string;
      /** 这一批里放回队列的 handoff 原来的 id（App 排空时从排队条目的 fromHandoff 收的）—— 落盘时记上，重启恢复据此不再放回 */
      fromHandoff?: string[] },
  ) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    if (!session || session.archived || sessionId.startsWith('pending_')) return;

    // Cancel/interrupt overwrite: if this session was interrupted (cancel or
    // mid-turn death set overwriteTargetRef), the NEXT queued item OVERWRITES
    // the interrupted turn — truncate the transcript to before that user message
    // first, so the queued message replaces it instead of appending after a
    // half-finished turn ("停当前、开始下一个、覆盖已输入").
    const overwriteId = overwriteTargetRef.current.get(sessionId);
    if (overwriteId) {
      clearInterrupted(sessionId);
      const cur = messagesCacheRef.current.get(sessionId) || [];
      const ti = cur.findIndex((m) => m.id === overwriteId);
      if (ti >= 0) {
        const retained = cur.slice(0, ti);
        const storedRetained = toStoredTranscript(retained);
        try { await window.kiroApi.rewriteTranscript(sessionId, storedRetained); } catch {}
        messagesCacheRef.current.set(sessionId, retained);
        // The banner clear is unconditional (it belongs to this chat); only the
        // VIEW state is focus-gated, since `messages` is the focused chat's.
        noteError(sessionId, null);
        if (sessionId === currentSessionRef.current) setMessages(retained);
      }
    }

    const activeModel = modelForSession(sessionId);
    const prompt: any[] = [];
    if (attachments.length > 0) {
      const fileRefs = attachments.map((file) => `file:${file.path}`).join('\n');
      prompt.push({
        type: 'text',
        text: `<hidden>${fileRefs}\n请读取这些文件内容</hidden>`,
      });
    }
    // Same rule as the normal send path: when there are attachments but no typed
    // text, the hidden file-ref block IS the instruction, so appending an empty
    // text part would send a meaningless blank message part to the backend.
    if (text.trim() || attachments.length === 0) prompt.push({ type: 'text', text });

    const updateSession = (updater: (messages: Message[]) => Message[]) => {
      if (currentSessionRef.current === sessionId) {
        setMessages(updater);
      } else {
        const cached = messagesCacheRef.current.get(sessionId) || [];
        messagesCacheRef.current.set(sessionId, updater(cached));
      }
    };

    const userMessageId = options?.messageId || `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sendToken = `send_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    /* 这条是为这条会话写的：发送失败没落盘时，切会话对账也认它（见 messageReconcile） */
    if (!options?.mergeIntoMessageId) markLocalOnly(sessionId, [userMessageId]);
    // `text` is what the MODEL gets (pastes expanded); the bubble/transcript keep
    // the short placeholder form when the caller supplies one.
    const shownText = options?.displayText ?? text;
    const userMessage: Message = {
      id: userMessageId,
      role: 'user',
      content: shownText,
      attachments,
      ...(options?.pastes?.length ? { pastes: options.pastes } : {}),
      timestamp: Date.now(),
      /* 这一次插进来的那个气泡的记号 —— 失败时只撤它（`removeOptimistic`） */
      sendToken,
    };

    if (options?.mergeIntoMessageId) {
      updateSession((current) => {
        let merged = false;
        const next = current.map((message) => {
          if (message.id !== options.mergeIntoMessageId || message.role !== 'user') return message;
          merged = true;
          return {
            ...message,
            content: `${message.content}
${text}`,
            attachments: [...(message.attachments || []), ...attachments],
          };
        });
        return merged ? next : [...current, userMessage];
      });
    } else {
      /*
        **按 id 复用**：没发成的那一批重试时还是原来的 messageId，那条用户消息可能已经在会话里了（上次已经落盘、
        窗口重载 / 重新打开会话后从磁盘读回来了）—— 再插一个就是两个同 id 的气泡（`insertOptimistic`）。
      */
      updateSession((current) => insertOptimistic(current, userMessage));
    }

    if (creatingRef.current.has(sessionId)) {
      try { await creatingRef.current.get(sessionId); } catch {}
    }
    // Undo the optimistic user-message materialization. The caller can put a
    // failed queued item back at the head without duplicating its chat bubble.
    const undoOptimistic = () => updateSession((current) => {
      if (!options?.mergeIntoMessageId) {
        /* 只撤这一次插进来的那个；原来就在的同 id 历史（上次已经落盘的那条）不动 */
        return removeOptimistic(current, userMessageId, sendToken);
      }
      return current.map((message) => {
        if (message.id !== options.mergeIntoMessageId || message.role !== 'user') return message;
        const suffix = `\n${text}`;
        return {
          ...message,
          content: message.content.endsWith(suffix)
            ? message.content.slice(0, -suffix.length)
            : message.content,
          attachments: attachments.length > 0
            ? (message.attachments || []).slice(0, -attachments.length)
            : message.attachments,
        };
      });
    });

    if (!attachedIdsRef.current.has(sessionId)) {
      markConnecting(sessionId);
      try {
        await window.kiroApi.loadSession(sessionId, attachCwdFor(sessionId), activeModel);
        addAttached(sessionId);
      } catch (attachError) {
        /* 连不上（远端预检失败之类）：气泡也收回去 —— 原来只有发送失败那条路收，排空每重试一次就多留一个 */
        undoOptimistic();
        throw attachError;
      } finally {
        clearConnecting(sessionId);
      }
    }

    const turnToken = beginStreamingTurn(sessionId);
    options?.onStarted?.();
    addAttached(sessionId);
    lastPromptedSessionRef.current = sessionId;
    const display = {
      messageId: userMessageId,
      displayText: shownText,
      ...(options?.pastes?.length ? { pastes: options.pastes } : {}),
      ...(options?.mergeIntoMessageId ? { mergeIntoMessageId: options.mergeIntoMessageId } : {}),
      ...(options?.fromHandoff?.length ? { fromHandoff: options.fromHandoff } : {}),
    };
    let deliveryError: any = null;
    try {
      const res = await window.kiroApi.prompt(sessionId, prompt, activeModel, projectForSession(sessionId), { ...display, attachments });
      const notice = noticeForStopReason((res as any)?.stopReason, res) || noticeForEmptyTurn(res);
      if (notice) noteError(sessionId, notice);
    } catch (firstError: any) {
      // A busy/reconfiguring rejection is authoritative: never disturb the
      // executor that is still handling the original turn or compaction.
      const message = String(firstError?.message || '');
      if (
        message.includes('active turn')
        || message.includes('already in progress')
        || message.includes('仍在后端运行')
        || message.includes('change to finish')
      ) {
        deliveryError = firstError;
      } else {
        try {
          await window.kiroApi.loadSession(sessionId, attachCwdFor(sessionId), activeModel);
          addAttached(sessionId);
          await window.kiroApi.prompt(sessionId, prompt, activeModel, projectForSession(sessionId), { ...display, attachments });
        } catch (retryError: any) {
          deliveryError = retryError;
        }
      }
    } finally {
      finishStreamingTurn(sessionId, turnToken);
    }

    if (deliveryError) {
      /* 主进程说这一条已经在盘上（答过了 / 上次已经开始执行）：气泡留着 —— 它就是盘上那条，不是这一次多插的 */
      if (!isDuplicateMessageError(String(deliveryError?.message || deliveryError))) undoOptimistic();
      throw deliveryError;
    }

    // 这里原来立刻把标题改成 `text.slice(0, 40)`。那一句是**有害**的:它让会话不再叫 New Chat,
    // 于是智能命名的触发条件永远不成立 —— 凡是第一条消息走了队列的会话,都被永久钉在这段截断上
    // (侧栏里那条「这个是需要kirolex连接到另一个写好的agent作为管理者」就是它的产物)。
    // 命名统一由 `finishStreamingTurn` → `maybeAutoTitle` 负责,截断只作为连试三次失败后的兜底。
  }, []);

  // Stop a turn. `targetSid` is REQUIRED for correctness in split view: this used
  // to read the `currentSessionId` state captured in the closure, so pressing Stop
  // in a pane cancelled whichever chat happened to be focused when the callback
  // was created — and back-filled THAT chat's prompt into the composer. That is
  // the prompt-crossing users saw. Falls back to the ref (always current), never
  // the stale state value.
  const cancelStream = useCallback(async (
    targetSid?: string | null,
    options?: { suppressInterruptionNotice?: boolean },
  ) => {
    const sessionForCancel = targetSid || currentSessionRef.current;
    if (sessionForCancel) {
      // Stop is the ONE escape from a loop, from every entry point — not just the
      // composer's loop-specific Stop button. Without this, stopping from anywhere
      // else (/stop, a background pane) cancelled the current iteration and the loop
      // immediately scheduled the next one, so the loop looked unstoppable.
      endLoop(sessionForCancel, 'aborted');
      turnOutcomeRef.current.set(sessionForCancel, { kind: 'cancelled' });
      await window.kiroApi.cancel(
        sessionForCancel,
        modelForSession(sessionForCancel),
        options?.suppressInterruptionNotice,
      );
      removeStreaming(sessionForCancel);
      dropPermissionCardIfEnded(sessionForCancel);
      // Put the interrupted turn's prompt back in the composer (including any
      // same-turn steers, which are merged into the one user bubble), and mark
      // that user message so the next submit OVERWRITES (reruns) this turn.
      // The interrupted bar explains this one, from the same flag that disables Rerun --
      // see the note in the disconnect handler for why not the error banner.
      markTurnInterrupted(sessionForCancel);
    }
  }, []);

  // Force-interrupt everything and reconnect, preserving the current view
  const forceStop = useCallback(async (model: string) => {
    // User-initiated, from the force-stop control: an abort, not a teardown.
    endLoop(undefined, 'aborted');
    for (const id of streamingIdsRef.current) turnOutcomeRef.current.set(id, { kind: 'cancelled' });
    // Clear all streaming state immediately
    activePromptTokenRef.current.clear();
    streamingIdsRef.current.clear();
    setStreamingIds([]);
    // Try to cancel current turn
    if (currentSessionId) {
      try { await window.kiroApi.cancel(currentSessionId, modelForSession(currentSessionId)); } catch {}
    }
    // Kill all kiro-cli processes (interrupts all in-flight output)
    setStatus('connecting');
    try { await window.kiroApi.disconnect(); } catch {}
    // Reconnect (keeps currentSessionId; it becomes stale and will be
    // transparently recreated with context on the next message)
    try {
      await window.kiroApi.connect({ model });
      setStatus('connected');
    } catch (err: any) {
      setStatus('disconnected');
      noteError(null, err?.message || t('Failed to reconnect'));
    }
  }, [currentSessionId, endLoop]);

  const deleteSession = useCallback(async (sessionId: string) => {
    // Abort/clear this session's live state up front so a deleted chat never
    // looks like it is still running (main also disconnects its kiro-cli
    // process via detachExecutor on acp:delete-session).
    // 'discarded' is the one terminal that is not reported anywhere -- the
    // transcript it would be written into is being deleted in this same call.
    endLoop(sessionId, 'discarded');
    removeStreaming(sessionId);
    pendingSteersRef.current.delete(sessionId);
    activePromptTokenRef.current.delete(sessionId);
    attachedIdsRef.current.delete(sessionId);
    connectingRef.current.delete(sessionId);
    /**
     * 先记下它在列表里的样子和位置 —— 主进程**可能拒**（flow 的 worker 会话就有一道守卫），
     * 而拒了之后必须原样放回去。实测的后果：门上「按这个改」重置一步时会去关它的会话，那条会话
     * 是同泳道共用的，删除被守卫拒了，但界面上它已经消失了 —— 于是下一步复用会话时判定它"不在了"，
     * 退而用了上一个泳道成员的会话，**拿到的是错的上下文**。
     */
    const doomedIndex = sessions.findIndex((s) => s.id === sessionId);
    const doomedRecord = doomedIndex >= 0 ? sessions[doomedIndex] : null;
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    // Drop any pending duplicate-history/project inheritance awaiting
    // materialization for this session.
    duplicateHistoryRef.current.delete(sessionId);
    duplicateProjectRef.current.delete(sessionId);
    localOnlyIdsRef.current.delete(sessionId);
    // Clear local message cache
    messagesCacheRef.current.delete(sessionId);
    // ...and this chat's error banner: it is keyed by session id, so without this the
    // map keeps an entry for a chat that can never be shown again.
    noteError(sessionId, null);
    // Clean up context links: drop this session's own links and remove it as a
    // source from any other session (its message cache is now gone).
    let linksChanged = contextLinksRef.current.delete(sessionId);
    for (const [target, arr] of contextLinksRef.current) {
      const filtered = arr.filter((l) => l.sourceId !== sessionId);
      if (filtered.length !== arr.length) {
        if (filtered.length > 0) contextLinksRef.current.set(target, filtered);
        else contextLinksRef.current.delete(target);
        linksChanged = true;
      }
    }
    if (linksChanged) persistContextLinks();
    // Refresh the current session's link indicator (a source may have been removed)
    refreshContextLinks(currentSessionRef.current);
    // Delete session files from disk
    try {
      const res: any = await window.kiroApi.deleteSession(sessionId);
      /**
       * 级联删掉的子会话也要从列表里摘掉 —— 主进程删掉 flow 锚（主会话/skill）时会把属于它的
       * worker 一起删（见 `acp:delete-session` 里那段），但那是**磁盘上**的事：不摘的话界面上
       * 还留着一排点进去就空的会话，要到下次启动才消失。
       */
      const cascaded: string[] = Array.isArray(res?.cascaded) ? res.cascaded : [];
      if (cascaded.length) {
        const gone = new Set(cascaded);
        setSessions((prev) => prev.filter((s) => !gone.has(s.id)));
        for (const id of cascaded) {
          removeStreaming(id);
          attachedIdsRef.current.delete(id);
          connectingRef.current.delete(id);
          messagesCacheRef.current.delete(id);
        }
      }
      // Never swallow this: a failed disk delete used to leave the chat on disk and
      // it came back at the next start.
      // 界面语言：这个 hook 在 LangProvider 外面（App 里先调它），所以删的那一刻直接读已保存的设置
      let lang = normalizeLang(undefined);
      try { lang = normalizeLang(JSON.parse(uiGet('kirolex-settings') || '{}')?.language); } catch { /* 坏值退回默认 */ }
      const outcome = classifyDeleteResult(res, lang);
      if (outcome.kind === 'tombstoned') {
        /**
         * `ok: false, tombstoned: true` = **已经删了**，只是有些文件暂时被占用（Windows 上常见：刚断开的
         * kiro-cli 或它起的子进程还没放手 files/）。主进程已经立了墓碑、广播了 `acp:sessions-purged`，
         * 本次运行期间会隔一段时间在后台再删，下次启动也会再试 —— 所以会话**不放回**列表，也不说
         * 「没有删除」，只给一句不吓人的提示。
         */
        showToast(outcome.notice);
      } else if (outcome.kind === 'refused') {
        /**
         * `ok: false` 且没有 `tombstoned` 才是**拒绝**：会话根本没被删，没立墓碑，也不会重试。
         *
         * 所以要把它**放回原位**。不放回去它就成了一条"界面上不存在、磁盘上活着"的幽灵会话，
         * 而这个状态会静默地影响别的判断（实测：让 flow 的会话复用挑错了会话）。
         */
        if (doomedRecord) {
          setSessions((prev) => (prev.some((s) => s.id === sessionId)
            ? prev
            : [...prev.slice(0, doomedIndex), doomedRecord, ...prev.slice(doomedIndex)]));
        }
        noteError(null, outcome.error);
      }
    } catch (error: any) {
      noteError(null, t('Failed to delete the chat: {error}. It may reappear on the next launch.', { error: String(error?.message || error) }));
    }
    /*
      **看的是删完这一刻的焦点，不是点删除那一刻的** —— 远程会话的删除要等执行器退出（最多 8 s）再挪目录，
      这段时间里你可能已经点了「新对话」。闭包里的 `currentSessionId` 还是被删的那条，照它判断就会
      把焦点从你刚建的会话拽走（拽到列表里最新的那条 —— 常常就是这条新会话自己，正在建、缓存没对过账）。
      被删的那条一从列表里摘掉，App 那边就 `unfocusSession()`（焦点指着不存在的会话），所以「还停在原处」
      是焦点仍是它、或者已经是空的；换成了别的会话就是你自己选的，不动。
    */
    const focusNow = currentSessionRef.current;
    if (currentSessionId === sessionId && focusNow !== sessionId && focusNow !== null) {
      window.kiroApi.diagSessionView?.('delete: focus moved during the delete, not auto-switching', { deleted: sessionId, focusNow });
    }
    if (currentSessionId === sessionId && (focusNow === sessionId || focusNow === null)) {
      // Auto-switch to the most recent remaining chat instead of dumping the
      // user onto the empty welcome screen. Fall back to empty only if none.
      const next = sessionsRef.current
        .filter((s) => s.id !== sessionId && !String(s.id).startsWith('pending_') && !s.archived)
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      if (next) {
        void switchSession(next.id);
      } else {
        setCurrentSessionId(null);
        setMessages([]);
      }
    }
    // `sessions` 进依赖：被拒时要把那条记录原样放回原位，需要读到删之前的列表
  }, [currentSessionId, switchSession, endLoop, sessions]);

  /**
   * 把主进程已经收掉的会话从列表里摘掉 —— 磁盘上删了，界面上也得当场没。
   *
   * 删运行（`run:remove` / `run:remove-flow-runs`）会级联 purge 那次运行的 worker 与失去锚点的主会话，
   * 但那是**磁盘上**的事：不摘的话侧栏还留着一排点进去就空的会话，要到下次启动才消失 —— 而「运行都删了
   * 会话还在」正是这次要修掉的那个症状。和 `deleteSession` 里处理 `cascaded` 的那段同一套清理。
   */
  const forgetSessions = useCallback((ids: string[]) => {
    const gone = new Set((ids || []).filter(Boolean));
    if (!gone.size) return;
    setSessions((prev) => prev.filter((s) => !gone.has(s.id)));
    for (const id of gone) {
      removeStreaming(id);
      attachedIdsRef.current.delete(id);
      connectingRef.current.delete(id);
      messagesCacheRef.current.delete(id);
    }
  }, [removeStreaming]);

  /**
   * Mark what a chat is FOR (`Session.purpose`) — used for the transient sessions a skill canvas creates.
   *
   * In the hook, like `renameSession`: the sessions index lives here and is persisted from here, so a
   * field set anywhere else would be overwritten by the next state update from this file.
   */
  const markSessionPurpose = useCallback((sessionId: string, purpose: Session['purpose'], flow?: string) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, purpose, ...(flow ? { flow } : null) } : s)));
    // 也写进记录：这个标记撑着「flow 主会话删不掉」和「回收时别碰它」，只活在内存里等于重启就没了
    void window.kiroApi.markSessionPurpose?.(sessionId, String(purpose || ''), flow);
  }, []);

  const renameSession = useCallback((sessionId: string, title: string) => {
    setSessions((prev) =>
      prev.map((s) => s.id === sessionId ? { ...s, title } : s)
    );
    /**
     * **也落盘** —— 原来这里只改内存，于是标题一刷新就退回磁盘上的 `New Chat`。
     *
     * 实测 SFDC 那个 project 下四条会话在磁盘上全都叫 `New Chat`，而侧栏上它们显示着步骤名 ——
     * 两者不一致，重启后你看到的就是一排分不清谁是谁的「New Chat」。flow 起的会话尤其吃亏：
     * 它们的名字是驱动器现取的（`flow · 步骤名`），不落盘就等于没有名字。
     *
     * 不 await：改名失败不该阻塞界面（最坏结果是标题下次重启退回去，和现在一样），
     * 而主进程那边有日志。
     */
    void window.kiroApi.renameSessionOnDisk?.(sessionId, title);
  }, []);

  const reorderSessions = useCallback((newSessions: Session[]) => {
    setSessions(newSessions);
  }, []);

  const createFolder = useCallback((name: string) => {
    const folder: SessionFolder = {
      id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      collapsed: false,
    };
    setFolders((prev) => [...prev, folder]);
    return folder.id;
  }, []);

  const deleteFolder = useCallback((folderId: string) => {
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    // Move sessions in this folder back to root
    setSessions((prev) =>
      prev.map((s) => s.folderId === folderId ? { ...s, folderId: null } : s)
    );
  }, []);

  const renameFolder = useCallback((folderId: string, name: string) => {
    setFolders((prev) =>
      prev.map((f) => f.id === folderId ? { ...f, name } : f)
    );
  }, []);

  const toggleFolder = useCallback((folderId: string) => {
    setFolders((prev) =>
      prev.map((f) => f.id === folderId ? { ...f, collapsed: !f.collapsed } : f)
    );
  }, []);

  const moveSessionToFolder = useCallback((sessionId: string, folderId: string | null) => {
    setSessions((prev) =>
      prev.map((s) => s.id === sessionId ? { ...s, folderId } : s)
    );
  }, []);

  /**
   * **忙时记下、这一轮跑完再切的切换**（主进程 `pendingSwitch.ts`）：`{ [sessionId]: { kind: 新值 } }`。
   * 下拉框显示新值并标「⏳ 这一轮跑完后切换」；应用完（或失败）由 `acp:pending-switch-result` 带回实际值回填。
   * 内存态在主进程，窗口重载后从 `getPendingSwitches` 补。
   */
  const [pendingSwitches, setPendingSwitches] = useState<Record<string, Record<string, string>>>({});
  /** 每条会话这段等待从什么时候开始（主进程记的）—— 会话里那张卡片的「已等 N 秒」 */
  const [pendingSwitchSince, setPendingSwitchSince] = useState<Record<string, number>>({});
  useEffect(() => {
    const api = window.kiroApi as any;
    void api?.getPendingSwitches?.().then((all: any) => { if (all && typeof all === 'object') setPendingSwitches(all); }).catch(() => {});
    void api?.getPendingSwitchSince?.().then((all: any) => { if (all && typeof all === 'object') setPendingSwitchSince(all); }).catch(() => {});
    const noteSince = (sid: string, since: number | null | undefined) => setPendingSwitchSince((prev) => {
      if (typeof since === 'number') return prev[sid] === since ? prev : { ...prev, [sid]: since };
      if (!(sid in prev)) return prev;
      const next = { ...prev }; delete next[sid]; return next;
    });
    const offPending = api?.onPendingSwitches?.((d: { sessionId: string; pending: Record<string, string>; since?: number | null }) => {
      setPendingSwitches((prev) => ({ ...prev, [d.sessionId]: d.pending || {} }));
      noteSince(d.sessionId, d.since);
    });
    const offResult = api?.onPendingSwitchResult?.((d: { sessionId: string; profile: any; pending: Record<string, string>; since?: number | null }) => {
      setPendingSwitches((prev) => ({ ...prev, [d.sessionId]: d.pending || {} }));
      noteSince(d.sessionId, d.since);
      const prof = d.profile;
      if (!prof) return;
      /* 实际生效的值回填（失败的那几类就是原来的值，界面跟着回退） */
      if (prof.engine === 'kiro' && prof.model) sessionModelRef.current.set(d.sessionId, prof.model);
      setSessions((prev) => prev.map((session) => (session.id === d.sessionId
        ? {
          ...session,
          kiroAgent: prof.kiroAgent || undefined,
          permissionMode: prof.permissionMode,
          ...(prof.engine === 'kiro' && prof.model ? { model: prof.model } : {}),
        }
        : session)));
    });
    return () => { try { offPending?.(); offResult?.(); } catch { /* 卸载 */ } };
  }, []);
  const cancelPendingSwitch = useCallback(async (sessionId: string, kind?: string) => {
    try {
      const r = await (window.kiroApi as any).cancelPendingSwitch(sessionId, kind);
      setPendingSwitches((prev) => ({ ...prev, [sessionId]: r?.pending || {} }));
    } catch (err: any) {
      noteError(sessionId, err?.message || String(err));
    }
  }, []);

  // Switch the named kiro-cli agent for one session. The main process starts a
  // replacement executor before retiring the old one, while the renderer shows
  // the normal connecting state and persists the selected agent per session.
  const changeSessionAgent = useCallback(async (sessionId: string, kiroAgent: string) => {
    if (!sessionId || sessionId.startsWith('pending_')) return;
    /* 这一轮还在跑：主进程只是记下来（pending），跑完再切 —— 别把界面标成"连接中"、也别清命令表 */
    if (streamingIdsRef.current.has(sessionId)) {
      try {
        const r = await window.kiroApi.switchKiroAgent(sessionId, kiroAgent);
        /* 主进程那一轮其实刚结束：当场就切了（不是 pending）—— 按确认的值回填 */
        if (r?.ok && !r.pending) setSessions((prev) => prev.map((session) => (session.id === sessionId ? { ...session, kiroAgent: r.kiroAgent || undefined } : session)));
      }
      catch (err: any) { noteError(sessionId, err?.message || t('Failed to switch agent')); }
      return;
    }
    commandsMapRef.current.delete(sessionId);
    if (sessionId === currentSessionRef.current) setCommands([]);
    markConnecting(sessionId);
    // Mark the session as reconfiguring: the switch intentionally releases and
    // reloads the backend, and the disconnect auto-recovery must NOT race it
    // (both would session/load the same id -> kiro-cli "Internal error").
    reconfiguringRef.current.add(sessionId);
    try {
      // Wait for the backend to be connected before switching (don't error with
      // "Session not connected"): if this session isn't attached yet, attach it
      // first, then perform the agent switch.
      if (!attachedIdsRef.current.has(sessionId)) {
        /*
          **挂不上不是死路** —— 主进程允许在休眠状态下改（只写记录，下次挂起时生效），
          所以这里挂不上也照旧往下走；但**把真实原因打出来**：原来这个 `catch {}` 是空的，
          真实原因被吞掉，接着 switch 抛一句和原因无关的 "Session not connected"。
        */
        try { await window.kiroApi.loadSession(sessionId, attachCwdFor(sessionId), modelForSession(sessionId)); addAttached(sessionId); }
        catch (e: any) { console.warn('[kirolex] 换 agent 前挂起失败（改动会记在下次挂起时生效）:', e?.message || e); }
      }
      const result = await window.kiroApi.switchKiroAgent(sessionId, kiroAgent);
      /* 主进程那边其实还忙（界面还没收到 streaming）：记成了 pending，实际值等 acp:pending-switch-result */
      if (result?.ok && !result.pending) {
        setSessions((prev) => prev.map((session) => (
          session.id === sessionId
            ? { ...session, kiroAgent: result.kiroAgent || undefined }
            : session
        )));
        /* 休眠那条路只写了记录，执行器仍然没起来 —— 标成 attached 会让界面说谎（点亮那个绿点） */
        if (!result.dormant) addAttached(sessionId);
      }
    } catch (err: any) {
      noteError(sessionId, err?.message || t('Failed to switch agent'));
    } finally {
      reconfiguringRef.current.delete(sessionId);
      clearConnecting(sessionId);
    }
  }, []);

  // Replace an idle session's executor with the selected model. Main loads the
  // same ACP session into the replacement, so context survives and the change
  // applies atomically to the next message.
  const changeSessionModel = useCallback(async (sessionId: string, model: string) => {
    if (!sessionId || sessionId.startsWith('pending_')) return;
    /* 这一轮还在跑：主进程只是记下来（pending），跑完再切；实际值等 acp:pending-switch-result 回填 */
    if (streamingIdsRef.current.has(sessionId)) {
      let r: Awaited<ReturnType<typeof window.kiroApi.switchModel>>;
      try { r = await window.kiroApi.switchModel(sessionId, model); }
      catch (err: any) { noteError(sessionId, err?.message || t('Failed to switch model')); throw err; }
      /* 主进程那一轮其实刚结束：当场就切了（不是 pending）—— 按确认的值回填 */
      if (r?.ok && !r.pending && r.model) {
        sessionModelRef.current.set(sessionId, r.model);
        setSessions((prev) => prev.map((session) => (session.id === sessionId ? { ...session, model: r.model } : session)));
        return r.model as string;
      }
      return undefined;
    }
    markConnecting(sessionId);
    reconfiguringRef.current.add(sessionId); // block disconnect auto-recovery
    try {
      // Wait for the backend to be connected before switching the model: attach
      // the session first if it isn't live yet, then switch.
      if (!attachedIdsRef.current.has(sessionId)) {
        /* 挂不上照旧往下走（主进程允许休眠时改，只写记录）—— 但把真实原因打出来，见换 agent 那段 */
        try { await window.kiroApi.loadSession(sessionId, attachCwdFor(sessionId), modelForSession(sessionId)); addAttached(sessionId); }
        catch (e: any) { console.warn('[kirolex] 换模型前挂起失败（改动会记在下次挂起时生效）:', e?.message || e); }
      }
      const result = await window.kiroApi.switchModel(sessionId, model);
      // Only the BACKEND decides what is in effect. A non-ok result used to leave
      // the selector showing the requested model while the executor kept running
      // the old (often retired) one -- the "selector says gpt-5.6-sol but every
      // send fails on claude-opus-5" drift.
      if (!result?.ok) {
        throw new Error(t('⚠️ The model switch did not take effect (still using {model}). Retry or pick another model.', { model: String(modelForSession(sessionId)) }));
      }
      if (result.pending) return undefined;
      sessionModelRef.current.set(sessionId, result.model);
      setSessions((prev) => prev.map((session) => (
        session.id === sessionId ? { ...session, model: result.model } : session
      )));
      /* 休眠那条路只写了记录 —— 标 attached 会让那个绿点说谎 */
      if (!result.dormant) addAttached(sessionId);
      return result.model as string;
    } catch (err: any) {
      noteError(sessionId, err?.message || t('Failed to switch model'));
      throw err;
    } finally {
      reconfiguringRef.current.delete(sessionId);
      clearConnecting(sessionId);
    }
  }, []);


  // Auto/Ask changes are applied at the live ACP permission boundary. No
  // executor replacement is needed, so the session stays connected throughout.
  const changeSessionPermissionMode = useCallback(async (
    sessionId: string,
    permissionMode: 'auto-approve' | 'ask',
  ) => {
    if (!sessionId || sessionId.startsWith('pending_')) return;
    try {
      const result = await window.kiroApi.switchPermissionMode(sessionId, permissionMode);
      if (result?.ok && !result.pending) {
        setSessions((prev) => prev.map((session) => (
          session.id === sessionId
            ? { ...session, permissionMode: result.permissionMode }
            : session
        )));
      }
    } catch (err: any) {
      noteError(sessionId, err?.message || t('Failed to change tool permission mode'));
      throw err;
    }
  }, []);

  // Assign a session to a project — WRITE-ONCE (design §6.4). Allowed only for
  // an unassigned (null/undefined) session; a pending session has no durable
  // record yet, so it is rejected until its real id exists.
  const assignProject = useCallback(async (sessionId: string, projectId: string) => {
    const pid = projectId.trim();
    if (!pid || sessionId.startsWith('pending_')) return;
    const target = sessions.find((s) => s.id === sessionId);
    if (target?.projectId) return; // already assigned — write-once
    try {
      await window.kiroApi.assignProject(sessionId, pid);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, projectId: pid } : s))
      );
      setProjects((prev) => (prev.includes(pid) ? prev : [...prev, pid]));
    } catch (err) {
      console.error('assignProject failed:', err);
    }
  }, [sessions]);

  // Move a session to another project (or unassign with null). Not write-once —
  // an explicit user move. Backend resets the executor so the new project's
  // memory scope is used (no stale mixing); here we just update the sidebar's
  // grouping. No-op when the target equals the current project.
  const moveSession = useCallback(async (sessionId: string, projectId: string | null) => {
    if (sessionId.startsWith('pending_')) return;
    const pid = projectId && projectId.trim() ? projectId.trim() : null;
    const target = sessions.find((s) => s.id === sessionId);
    const current = target?.projectId ?? null;
    if (current === pid) return; // no change -> no executor reset
    try {
      await window.kiroApi.moveSession(sessionId, pid);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, projectId: pid ?? undefined, archived: false } : s))
      );
      if (pid) setProjects((prev) => (prev.includes(pid) ? prev : [...prev, pid]));
      // UI polish: the backend reset (detached) this chat's executor. Reconnect
      // it now with a connecting flash so it comes back live under the NEW
      // project's memory scope, instead of silently going dormant until the next
      // send. Best-effort — if reconnect fails, the next send re-attaches.
      markConnecting(sessionId);
      try {
        await window.kiroApi.loadSession(sessionId, attachCwdFor(sessionId), modelForSession(sessionId));
        addAttached(sessionId);
      } catch {
        /* stays dormant; next send will attach */
      } finally {
        clearConnecting(sessionId);
      }
      // The move RESET the executor, so this backend is definitively empty -- and it
      // may also have just been unarchived (archived:false above). Verify/rebuild
      // here; attach no longer does it, so otherwise the chat would answer the next
      // message with no history at all.
      void window.kiroApi.ensureContext?.(sessionId).catch(() => {});
    } catch (err) {
      console.error('moveSession failed:', err);
    }
  }, [sessions]);

  // Archive / unarchive a session. Archiving hides it from the main list, frees
  // its executor slot (backend detaches), and switches away if it was current.
  // Unarchiving just restores it to the list (attaches lazily on next open).
  const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
    if (sessionId.startsWith('pending_')) return;
    try {
      await window.kiroApi.archiveSession(sessionId, archived);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId
          ? { ...s, archived, ...(archived ? { projectId: undefined } : {}) }
          : s))
      );
      if (archived) {
        removeAttached(sessionId);
        clearConnecting(sessionId);
        // If we archived the chat we're viewing, jump to the most recent
        // non-archived session and WARM it (so it isn't left showing red).
        if (currentSessionRef.current === sessionId) {
          const next = sessions.find((s) => s.id !== sessionId && !s.archived);
          if (next) {
            /**
             * 走 `switchSession`，不要自己 `setCurrentSessionId` —— 这是内容串台的根因。
             *
             * 实测症状：把 firehose 那条会话归档之后，它的历史出现在了「Run flow validation button
             * visibility issue」下面。原因是直接设 id 会跳过 `switchSession` 开头那一步 ——
             * **在焦点移走之前**把旧会话正在渲染的消息数组存进它自己的 paneView。跳过之后，
             * `currentSessionId` 已经指向新会话，而 hook 里那份 `messages` 还装着被归档会话的消息；
             * `renderPane` 判定 `sid === currentSessionId` → `focused = true` → 于是把旧消息画在了
             * 新会话的标题下面。
             *
             * 顺带补回来的还有：读磁盘 transcript、`setMessages`、`recoverInterruptedTurn`、以及
             * 附着执行器 —— 原来那段手写的 loadSession/addAttached/ensureContext 就是在重复
             * `switchSession` 已经做对的事，而且漏了最关键的第一步。
             */
            await switchSession(next.id);
          } else {
            setCurrentSessionId(null);
          }
        }
      } else {
        // Unarchive: warm it up now so it doesn't sit in the 'alert' (not-
        // connected) state — attach the executor (connecting -> warm/idle).
        if (!attachedIdsRef.current.has(sessionId)) {
          markConnecting(sessionId);
          try {
            await window.kiroApi.loadSession(sessionId, attachCwdFor(sessionId), modelForSession(sessionId));
            addAttached(sessionId);
          } catch {
            /* next select/send will attach */
          } finally {
            clearConnecting(sessionId);
          }
        }
        // An unarchived chat is a chat about to be used again, so verify its backend
        // really holds its history -- the same gate as opening one. Nothing else
        // covers this path: switchSession deliberately skips archived chats, and
        // attach no longer rebuilds on its own (it fired for every warmed chat at
        // boot). Without this the chat sits GREEN and connected on an empty backend
        // until the first send, which is exactly the "it only rebuilt after I
        // typed" behaviour ensure-context exists to remove.
        void window.kiroApi.ensureContext?.(sessionId).catch(() => {});
      }
    } catch (err) {
      console.error('archiveSession failed:', err);
    }
  }, [sessions, switchSession]);

  // Create an (initially empty) project. Sessions join by drag-assign (§6.4).
  const createProject = useCallback((name: string) => {
    const n = name.trim();
    if (!n || hiddenProjects.includes(n)) return;   // 和 advanced 的 flow 项目同名：不往里放
    setProjects((prev) => (prev.includes(n) ? prev : [...prev, n]));
  }, [hiddenProjects]);

  // Reorder PROJECTS. The `projects` array order IS the sidebar display order, so
  // moving an element here is the whole feature. A NEW project is appended (see
  // createProject), which puts it at the end of the project list — directly above
  // the Unassigned bucket, never below it: the Unassigned/Archived groups are
  // rendered outside this list and always come last.
  const reorderProjects = useCallback((name: string, target: string) => {
    if (!name || !target || name === target) return;
    setProjects((prev) => {
      const from = prev.indexOf(name);
      const to = prev.indexOf(target);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      next.splice(from, 1);
      next.splice(to, 0, name);
      return next;
    });
  }, []);

  // Rename a PROJECT (explicit admin op): relabel the project and bulk-update
  // every member session's projectId (durable via setProject).
  const renameProject = useCallback((oldName: string, newName: string) => {
    const n = newName.trim();
    if (!n || n === oldName) return;
    if (hiddenProjects.includes(n) || hiddenProjects.includes(oldName)) return;   // advanced 的 flow 项目不改、不并进去
    sessions.forEach((s) => {
      if (s.projectId === oldName) window.kiroApi.setProject(s.id, n).catch(() => {});
    });
    setProjects((prev) => Array.from(new Set(prev.map((p) => (p === oldName ? n : p)))));
    setSessions((prev) => prev.map((s) => (s.projectId === oldName ? { ...s, projectId: n } : s)));
    /**
     * The RUNS live under the project's name on disk, so this is a migration, not just a relabel. Without it
     * the sessions follow the new name while the runs stay behind the old one — the project loses its skill
     * tag and its flow.
     */
    void window.kiroApi.runRenameProject?.(oldName, n).catch(() => {});
  }, [sessions, hiddenProjects]);

  // Delete a PROJECT: fully clear it — delete every member chat, delete the
  // project's memory directory, and remove the label. (A later same-name project
  // therefore starts fresh with no inherited memory or chats.)
  const deleteProject = useCallback((name: string) => {
    if (hiddenProjects.includes(name)) return;   // advanced 的 flow 项目不删
    const members = sessions.filter((s) => s.projectId === name);
    members.forEach((s) => { deleteSession(s.id); });
    window.kiroApi.deleteProjectMemory(name).catch(() => {});
    setProjects((prev) => prev.filter((p) => p !== name));
  }, [sessions, deleteSession, hiddenProjects]);

  // Pin/unpin a session (pinned sessions sort to the top of their group).
  const togglePin = useCallback((sessionId: string) => {
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === sessionId ? { ...s, pinned: !s.pinned } : s));
      const nowPinned = !!next.find((s) => s.id === sessionId)?.pinned;
      // Persist to the durable record so the pin survives restart / origin change.
      window.kiroApi.setSessionPinned?.(sessionId, nowPinned).catch(() => {});
      return next;
    });
  }, []);

  // Clear a conversation's VISIBLE history (messages + local cache). Used by
  // /clear so the KiroLex view empties in step with the backend context reset.
  //
  // The durable transcript on disk is NOT touched, and that is intentional: KiroLex
  // does not delete the user's records on the strength of a slash command aimed at
  // the backend. The consequence is worth knowing: `/clear` resets kiro-cli's
  // context for this run, but KiroLex still holds the conversation, so after a
  // restart the context snapshot restores it. If the record itself should go, that
  // is a delete of the chat, not a clear of its context.
  const clearConversation = useCallback((sessionId?: string | null) => {
    const sid = sessionId || currentSessionRef.current;
    if (!sid) { setMessages([]); return; }
    messagesCacheRef.current.set(sid, []);
    if (sid === currentSessionRef.current) setMessages([]);
    planMapRef.current.delete(sid);
    fileChangesMapRef.current.delete(sid);
    if (sid === currentSessionRef.current) { setPlan([]); setFileChanges([]); }
    // The pane mirror is a separate copy: without this a split pane kept showing the
    // cleared chat's messages and plan panel.
    patchPane(sid, { messages: [], plan: EMPTY_PANE_PLAN });
    noteError(sid, null);
  }, [patchPane, noteError]);

  const resetSessionCredits = useCallback((sessionId?: string | null) => {
    const sid = sessionId || currentSessionRef.current;
    if (!sid) return;
    const previous = usageMapRef.current.get(sid);
    if (!previous) return;
    const next = { ...previous, credits: 0 };
    usageMapRef.current.set(sid, next);
    writeUsageMap(usageMapRef.current); // durable: see USAGE_MAP_KEY
    if (sid === currentSessionRef.current) setUsage(next);
  }, []);

  // Toggle a source session in the current session's context-sync set. Adding a
  // source starts it at syncedCount 0 (first send includes its existing history);
  // toggling it off removes it. Links are persistent and per-session.
  const toggleContextSource = useCallback((sourceSessionId: string, targetSessionId?: string) => {
    const target = targetSessionId || currentSessionRef.current;
    if (!target || !sourceSessionId || sourceSessionId === target) return;

    const arr = contextLinksRef.current.get(target) || [];
    const exists = arr.some((l) => l.sourceId === sourceSessionId);
    let next: { sourceId: string; sourceTitle: string; syncedCount: number }[];
    if (exists) {
      next = arr.filter((l) => l.sourceId !== sourceSessionId);
    } else {
      const sourceTitle =
        sessions.find((s) => s.id === sourceSessionId)?.title || 'another session';
      next = [...arr, { sourceId: sourceSessionId, sourceTitle, syncedCount: 0 }];
    }
    if (next.length > 0) contextLinksRef.current.set(target, next);
    else contextLinksRef.current.delete(target);
    persistContextLinks();
    const view = next.map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle }));
    if (currentSessionRef.current === target) setContextLinks(view);
    patchPane(target, { contextLinks: view });
  }, [sessions, patchPane]);


  const respondPermission = useCallback(async (optionId: string) => {
    const request = permissionRequest;
    if (!request) return;
    await window.kiroApi.respondPermission(
      request.requestId,
      optionId,
      request.sessionId,
    );
    setPermissionRequests((current) => {
      if (current[request.sessionId]?.requestId !== request.requestId) return current;
      const next = { ...current };
      delete next[request.sessionId];
      return next;
    });
  }, [permissionRequest]);

  // Derived: current view is streaming if the current session is in the streaming set
  const isStreaming = currentSessionId !== null && streamingIds.includes(currentSessionId);

  return {
    status,
    errorBySession,
    pendingSwitches,
    pendingSwitchSince,
    cancelPendingSwitch,
    /** Dismiss ONE chat's banner. Takes the id because the banner is per chat now. */
    clearSessionError: (sid?: string | null) => noteError(sid ?? null, null),
    sessions,
    currentSessionId,
    messages,
    isStreaming,
    streamingIds,
    attachedSessionIds,
    busyBySession,
    /** 新建会话的启动阶段（阶段条 + 就绪前的消息进排队），见 createStages.ts */
    createStages,
    createStagesLoaded,
    retryCreateSession,
    usageBySession,
    /**
     * 某条会话**此刻**的用量读数 —— 读的是权威那份（`usageMapRef`），不是反应式镜像。
     *
     * 为什么必须有这个：`usageBySession` 是 state，而镜像它的 ref 是**在渲染期**赋值的
     * （`usageBySessionRef.current = usageBySession`）。驱动器在 `sendMessage().then(...)` 里读那个镜像，
     * 而那一刻 React 往往还没为这一轮的 metadata 重渲染 —— 读到的是**上一轮**的值。
     *
     * 实测：一步跑完后钉下的 `contextPct` 是 8.179，而权威表里当时已经是 8.3；credits 的增量更直接地
     * 暴露了这件事 —— 前后两次读到同一个数，算出来的花费是 **0**。
     *
     * `usageMapRef` 在收到 metadata 的那一刻就 `.set()` 了（同步，不经过 state），所以从它读永远是最新的。
     */
    usageOf: useCallback(
      (sessionId: string) => usageMapRef.current.get(sessionId),
      [],
    ),
    /** 上一次运行没被吃掉的 steer（只给一次）。 */
    takeOrphanSteers,
    /** 正在自动重发的会话 —— App 的队列在这期间不发。 */
    recoveringIds,
    /** 这条会话最后一轮怎么结束的（读的是 ref，永远是此刻的值）。没记录 = 正常结束。 */
    turnOutcomeOf: useCallback(
      (sessionId: string): TurnOutcome => turnOutcomeRef.current.get(sessionId) || { kind: 'ok' },
      [],
    ),
    /** Call off a pending/in-flight auto-resend for this chat. `recoveryCancelledRef`
     *  existed but was NEVER written, so an auto-resend could not be stopped at all
     *  -- Stop now routes here. */
    cancelAutoResend: (sid: string) => {
      if (!sid) return;
      recoveryCancelledRef.current.add(sid);
      recoveryCheckedRef.current.delete(sid);
      primeKickedRef.current.delete(sid);
      if (!isRebuilding(sid)) setSessionActivity(sid, null);
    },
    /** Force-rebuild a chat's backend context from KiroLex's own transcript.
     *  Needed when session/load "succeeded" onto a backend that was itself empty
     *  -- only the user can tell, so this is a manual entry point. */
    rebuildContext: async (sid: string, mode?: 'snapshot' | 'full') => {
      recoveryCancelledRef.current.delete(sid);   // an explicit rebuild re-arms recovery
      if (!sid) return { ok: false, error: 'no session' };
      // Whichever menu item was used IS the choice, so persist it before rebuilding.
      // That keeps the mode visible through the action instead of being hidden state.
      if (mode) { try { await window.kiroApi.setPrimeMode?.(sid, mode); } catch {} }
      if (!attachedIdsRef.current.has(sid)) {
        try {
          await window.kiroApi.loadSession(sid, attachCwdFor(sid), modelForSession(sid));
          addAttached(sid);
        } catch (err: any) {
          return { ok: false, error: err?.message || 'attach failed' };
        }
      }
      const res = await window.kiroApi.primeHistory?.(sid, true);
      if (res && !res.ok) setSessionActivity(sid, t('⚠️ Rebuilding history failed: {reason}', { reason: splitNoteDetail(res.error || '').main || t('unknown reason') }));
      return res || { ok: false, error: 'no ipc' };
    },
    interruptedSessionIds,
    connectingSessionIds,
    failedSessionIds,
    historyLoadingIds,
    paneViews,
    paneFallback,
    setPaneSessions,
    activeToolCall,
    subagents,
    usage,
    plan,
    taskListFor,
    taskListTick,
    fileChanges,
    activityStatus,
    turnStall,
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
    warmSession,
    unfocusSession,
    deleteSession,
    forgetSessions,
    renameSession,
    markSessionPurpose,
    reorderSessions,
    folders,
    createFolder,
    deleteFolder,
    renameFolder,
    toggleFolder,
    moveSessionToFolder,
    changeSessionModel,
    changeSessionAgent,
    changeSessionPermissionMode,
    assignProject,
    moveSession,
    archiveSession,
    projects: shownProjects,
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
    /** Main's jobs, and the coarse clock the countdown is measured against. Read-only. */
    schedules,
    scheduleNow,
    pauseSchedule,
    cancelSchedule,
    setScheduleExpiry,
    bgJobs,
    stopBgJob,
    stopLoop,
    restoredInputDraft,
    /**
     * 输入框接走那份交接之后清掉它 —— **按 id 认**（见 `handoffDraft.consumeHandoff`）。
     *
     * 不清的后果实测过：这个状态设置一次、永不清空，于是输入框每次挂载都重放一遍
     * （切回这条会话、进出分屏），早已处理完的中断还会一直回来，还会盖掉你刚打的字。
     * 按 id 认是为了分屏：同一条会话两个框都接同一份，第二个"清掉"到得晚，不能抹掉更新的那份。
     */
    consumeRestoredInputDraft: useCallback(
      (id: number) => setRestoredInputDraft((cur) => consumeHandoff(cur, id)),
      [],
    ),
  };
}
