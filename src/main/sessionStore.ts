import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentProfile } from './config';
import { tr } from './uiText.ts';
import { isAdvancedOnly, isAdvancedOnlyProject } from './advancedOnly.ts';
import { projectDirName } from './projectStore.ts';
import { logger } from './logger.ts';
import { isKirolexNote } from './kirolexNote.ts';
import { carryReplyMarks, completedReplyInText, messageIdStatusInText, type MessageIdStatus } from './promptDedupe.ts';
import { carryBackendAnchors, remapAnchorsToFork } from './editFork.ts';
import type { QuestionCard } from './elicitation.ts';

/**
 * Durable session store (design §4, §7). Foundation contract — DO NOT break:
 *  1. transcript.jsonl is append-only during normal chat, one JSON object per
 *     complete message. Explicit edit-and-rerun is the sole operation that
 *     atomically truncates it before an earlier user message.
 *     Readers ignore unknown fields, so new per-message fields are additive.
 *  2. record.json is VERSIONED metadata (schemaVersion) — the only thing that
 *     migrates. Small, rewritable.
 *  3. Memory lives in a SEPARATE store (~/.kirolex/memory/), never here.
 *
 * Asymmetric durability: user messages persist the instant they are sent;
 * assistant messages persist ONLY when fully complete; in-flight assistant
 * output is discarded, never written.
 */

export const SESSION_SCHEMA_VERSION = 1;

export type MessageRole = 'user' | 'assistant';

export interface StoredFileDiff {
  path: string;
  oldText?: string;
  newText: string;
}

export interface StoredToolCall {
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content?: string;
  kind?: string;
  locations?: string[];
  diffs?: StoredFileDiff[];
  /* 下面几个只有 Claude Code / Codex 会话的调用才带（`toolTrace.ts`；kiro 的记录形状不变） */
  /** 工具真名（`Read` / `Grep` / `Agent` …） */
  toolName?: string;
  /** 入参摘要（一行） */
  input?: string;
  /** 子代理里的调用：派它出去的那条 Task 的 toolCallId */
  parentToolCallId?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
  ts: number;
  /** Append-only event: materialize this text into an earlier user message. */
  mergeIntoMessageId?: string;
  /** 这条用户消息发出去的是哪几条「交给了适配器却没轮到、放回 KiroLex 队列」的消息（原来的 id，合并发送时可以有几条）——
   *  重启恢复（pendingHandoffs）据此认出它们已经发过了，不再放回第二遍。 */
  fromHandoff?: string[];
  /** Read-side only: the merge events `readTranscript` folded into this user message, in order,
   *  so the view can show each steer as its own bubble again. `content` already includes them. */
  steerParts?: { id: string; content: string; ts: number }[];
  /** File-changing tool calls produced during this assistant turn. */
  toolCalls?: StoredToolCall[];
  /** 助手消息：这一轮最后一次**真实**工具调用开始时正文的长度。判「把工具调用写成了文字」只看这之后（`textToolCall.ts`），
   *  一轮结束时的判定、界面折叠、历史折叠用同一个口径。没调过工具就没有。 */
  toolTailFrom?: number;
  /** 助手消息（Claude Code / Codex）：这一轮主线最后一个 ACP messageId 和当时的后端会话 id —— 编辑重发时从这里分叉（`editFork.ts`） */
  acpMessageId?: string;
  acpSessionId?: string;
  /** 助手消息：`'autonomous'` = 后端自己起的那一轮（Claude Code 的 cron 到点 / 后台任务跟进，`autonomousTurn.ts`），不是在回哪条用户消息。 */
  origin?: 'autonomous';
  /** Files/images the user attached to THIS message. Persisted so the chips
   *  survive a restart AND so history priming can re-point a fresh backend at
   *  them (otherwise an image sent earlier is forgotten entirely). */
  attachments?: { id?: string; name: string; path: string; isImage?: boolean }[];
  /** Pasted text blobs shown as `[ 粘贴 #N · M 行 ]` placeholders in `content`.
   *  The bytes live in ~/.kirolex/pastes; this is the ONLY record of where. */
  pastes?: { seq: number; lines: number; chars: number; path: string }[];
  /**
   * **这条是 KiroLex 自己说的话，不是对话** ——「这他妈什么玩意，为什么按照会话发出去了」。
   *
   * 「⚠️ 这条会话现在跑在 gpt-5.6-sol 上」「♻️ 已经换成新的后端会话」「⏳ 已排队」这些都是
   * KiroLex 对**你**说的，原来却以 `role: 'user'` 落进 transcript —— 于是：
   *   · 看起来像你自己说的话；
   *   · 而且**真的会发给模型**：ride-along 快照和 history.md 都是从 transcript 建的，
   *     模型下一轮就读到"我现在跑在 gpt-5.6-sol 上"当成你的指令。
   *
   * 标上这个之后，界面照旧显示（那是你要的可见性），但每一条**发给模型**的路径都跳过它
   * （`historyLine` 那侧的过滤，见 `readTranscript` 的调用点）。
   */
  kirolex?: true;
  /** KiroLex 自己写的那句话的中英两版（`uiText.textVariants`）—— 显示时按当前界面语言挑；你和 agent 的消息没有这一项。 */
  variants?: { zh: string; en: string };
  /**
   * KiroLex 提示的「类型:对象[→结果]」（例如 `local-tools-reconnect`、`model-fallback:a→b`）——
   * 界面把相邻、同 group 的几条并成一条「×N」，内容取最新的（`renderer/noticeMerge.ts`）。只有 KiroLex 提示有。
   */
  noteGroup?: string;
  /** 这条是本机工具经控制入口发的（controlServer `POST /sessions/:id/send`），界面上标「经控制入口发送」。
   *  id 里也带着标记（`controlSessions.isControlMessageId`），界面认的是 id。
   *  `'session'`：另一条会话经 `session_send` 发来的（sessionCalls.ts），界面显示「📨 来自会话」。 */
  via?: 'control' | 'session';
  /** 助手消息：它回的是哪一条用户消息（id）。 */
  replyTo?: string;
  /** 助手消息：这是那一轮**正常收尾**的完整回复（出错 / 取消时 flush 的半截没有这一项）。
   *  发送去重按 `replyTo` + 它认"这一条答过了"（`promptDedupe.ts`），而不是看后面有没有随便哪条助手消息。 */
  replyComplete?: true;
  /** 模型向用户的一次提问（`elicitation.ts` 的卡片，含状态和答案）。这种消息正文是空的，卡片关掉（答了 / 跳过 /
   *  取消 / 超时 / 撤回）时由主进程追加 —— 那时它才是完整的（§7 的 durability）。 */
  question?: QuestionCard;
  // additive: future fields (model, etc.) may be appended safely
}

export type ExecutorState =
  | 'detached'
  | 'attaching'
  | 'attached'
  | 'disconnected' // remote link lost, process may still be alive (later PRs)
  | 'error';

export interface SessionRecord {
  schemaVersion: number;
  id: string;
  /**
   * 最近几条**模型已经开始做了**（出过字 / 跑过工具）的用户消息 id —— 发送去重据此拒绝同一条再被自动发一遍
   * （见 `promptDedupe.decidePromptDedupe` 的 `started`）。只留最近的一些；跟着记录落盘，主进程重启后也还认得。
   */
  startedMessageIds?: string[];
  createdAt: number;
  updatedAt: number;
  title: string;
  profile: AgentProfile;
  /** The kiro-cli-assigned session id for this KiroLex session's executor.
   *  KiroLex owns `id` (dir key); this maps to the backend session for resume.
   *  Absent on legacy records where id WAS the kiro-cli id (treat id as fallback). */
  cliSessionId?: string;
  /** 这条会话收到过模型起的后台命令 / 监视的输出（可能带凭证）：之后的故障诊断包不再抄会话内容（见 failureBundle.ts）。 */
  bgOutputSeen?: boolean;
  /**
   * **这条会话的本地工作目录**。
   *
   * 记录里原来**没有**这个字段，而渲染层 attach 时三处都硬写 `'~'`
   * （`loadSession(id, '~', model)`）—— 于是每次重新连接，主进程看到的目录都是家目录。
   * 本地会话无所谓（它的 cwd 本来就是每会话的临时目录），但远程会话是致命的：
   * 镜像目录按这个算，结果每次 re-attach 都把**整个家目录**当项目推上远端
   * （实测两次，5.1 GB / 6.1 GB，凭据在内），而"家目录不能做镜像"那道闸又会把它降级成本地会话。
   *
   * 所以目录必须**存在记录里**、以记录为准 —— 渲染层传什么都不该决定一条已存在会话的工作目录。
   */
  localDir?: string;
  /**
   * 这条会话的 files/ **用过的所有绝对路径** ——「如果 chat 被恢复到了另一个机器路径变了怎么办」。
   * 路径本身每次按这台机器现算（不会错），但对话历史和 memory 里写死的是**当时那台机器**的路径；
   * 记下来，路径一变就在每一轮的说明里告诉模型"历史里那个旧路径就是现在这个文件夹"。
   */
  filesDirs?: string[];
  /** Memory injection bookkeeping (design §6.4). */
  lastMemoryInjection?: { charCount: number; at: number };
  /** Runtime lifecycle; on load, live states are treated as detached. */
  executorState: ExecutorState;
  lastExecutorError?: string;
  /** User-archived: hidden from the main list, never eager-attached. Not deleted. */
  archived?: boolean;
  /**
   * 项目（`profile.projectId`）或归档状态最后一次被**用户**改动的时刻 ——
   * 「同步时让会话的项目和归档状态在多台机器间自动跟随」。多台机器之间位置按它谁新用谁
   * （`placementToFollow` / `mergeRecords`），不跟着每条消息都会动的 `updatedAt` 走。老记录没有 → 当 0。
   */
  placementChangedAt?: number;
  /** User-pinned: sorts to the top of its group. Renderer mirror of session.pinned;
   *  persisted here so it survives restart AND renderer-origin (localStorage) changes. */
  pinned?: boolean;
  /**
   * WHAT THIS CHAT IS FOR — `flow-main` is a flow's own thread, `skill` a transient canvas session.
   *
   * PERSISTED, unlike its predecessor. `Session.purpose` lived only in renderer memory, so after a restart the
   * old project main session was no longer marked: the code that 「never touches the main session」 could not
   * find it, and a second one was created next time. A protection that evaporates on restart is not one.
   */
  purpose?: string;
  /**
   * 上一次压缩会话记忆时，这个会话有多少条消息 —— 门槛就靠它算（`sessionMemory.shouldConsolidate`）。
   * 存条数而不是时间戳：贵的是消息量，一个开着三天没说话的会话不该被时间推着去压缩。
   */
  memoryConsolidatedAt?: number;
  /** Which flow a `flow-main` chat belongs to. A title is display; this is identity. */
  flow?: string;
  /** Which kiro-cli backend id KiroLex has actually fed this chat's history into.
   *  A successful `session/load` does NOT imply the resumed backend holds any
   *  conversation -- it can resume an id that was itself created empty in an
   *  earlier run -- so this is the only reliable "context is present" signal.
   *  Absent = unknown (chats predating this field); those are never auto-replayed
   *  because some transcripts here are 3MB / 5000+ messages. */
  contextEstablishedFor?: string;
  /** OS pid of the kiro-cli process that holds that context. Verified: kiro-cli
   *  does NOT persist ACP sessions -- none of this chat's five backend ids exist
   *  in ~/Library/Application Support/kiro-cli/data.sqlite3, while its own
   *  `--no-interactive` conversations do. An ACP session lives only in that
   *  child process's memory, and `session/load` accepts a known id by simply
   *  starting an EMPTY session for it. So the id alone is not proof of context:
   *  after a restart the same id resolves to a blank backend. Pairing it with
   *  the pid makes the marker expire exactly when the process does. */
  contextEstablishedPid?: number;
  /**
   * `/clear` 的水位线（epoch ms）—— 这个时刻**之前**的消息不再算这条会话的历史。
   *
   * 必须落盘：渲染端 `switchSession` 判"要不要从磁盘重读"的条件是 `!cached || cached.length === 0`，
   * "故意清空"和"还没装载过"是同一个 `[]`，切走再切回来就把整份 transcript 读了回来；快照
   * （`renderHistoryFile`、ride-along）也读 transcript，下一次重建上下文又把历史喂回模型。
   *
   * 过滤放在 `readTranscript` 这一处，视图和快照都走它。**transcript 本身不删** —— `/clear`
   * 是给后端的指令，不是删除。
   */
  clearedAt?: number;
  /** How this chat's context is restored onto a fresh backend.
   *  'snapshot' (default): ONE prompt carrying the artifact manifest, the most
   *  recent turns verbatim, and the path of the fully rendered history file, which
   *  the model reads on demand. Nothing is discarded -- the complete text is on
   *  disk and the prompt says so and where -- and a 78-chunk chat becomes one turn.
   *  'full': replay every chunk verbatim. Exact, but costs one model turn per
   *  chunk on every restart, because kiro-cli cannot restore an ACP session. */
  primeMode?: 'snapshot' | 'full';
}

const baseDir = path.join(os.homedir(), '.kirolex', 'sessions');

/**
 * 会话 id 只能是这个形状 —— `s_<毫秒>_<随机>`，外加历史上几种前缀。
 *
 * 原来 `dirFor` 是裸的 `path.join(baseDir, id)`：id 里带 `/` 就会把目录建到布局之外，带 `../` 就能
 * 写出 sessions 目录。实测撞出来一个 —— 一次调用把 cwd 传成了 id（参数顺序错了一位），于是磁盘上多了
 * `sessions/Users/keyinan/work/record.json` 这么一棵树：一条 app 永远看不见、清扫也永远碰不到的会话。
 *
 * 参数顺序错一位这种事一定会再发生，而它的代价不该是"往任意路径写文件"。所以判据放在**落盘的唯一入口**。
 */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,120}$/;

function safeId(id: string): string {
  const s = String(id ?? '');
  if (!ID_SHAPE.test(s)) {
    throw new Error(tr('Invalid session id: {id}. Only letters, digits, underscores and hyphens are allowed', { id: JSON.stringify(s.slice(0, 80)) }));
  }
  return s;
}

function dirFor(id: string): string {
  return path.join(baseDir, safeId(id));
}
/** 这条会话的目录（`~/.kirolex/sessions/<id>`）—— 「会话信息」里给人看 / 点开用。id 不合规照样抛。 */
export function sessionDirPath(id: string): string {
  return dirFor(id);
}
function recordPath(id: string): string {
  return path.join(dirFor(id), 'record.json');
}
function transcriptPath(id: string): string {
  return path.join(dirFor(id), 'transcript.jsonl');
}
/** Exposed so the attach path can size its session/load budget by how much
 *  history kiro-cli actually has to read back. */
export function transcriptFileSize(id: string): number {
  try { return fs.statSync(transcriptPath(id)).size; } catch { return 0; }
}

/** The chat's whole history rendered as one readable document. It exists so a
 *  rebuilt backend can be handed a PATH instead of 78 replayed turns: the model
 *  reads whichever part it needs. Regenerated from the transcript at rebuild
 *  time, so it can never drift from the source of truth. */
export function historyFilePath(id: string): string {
  return path.join(dirFor(id), 'history.md');
}

/** Does the rendered history exist? Used to refresh it only for chats whose
 *  backend was actually handed that path, instead of creating it for every chat. */
export function hasHistoryFile(id: string): boolean {
  try { return fs.existsSync(historyFilePath(id)); } catch { return false; }
}
export function writeHistoryFile(id: string, text: string): string {
  refuseAdvancedOnlyWrite(id);
  const target = historyFilePath(id);
  ensureDir(id);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, target);
  return target;
}

/** The CONTEXT SNAPSHOT the last send actually carried.
 *
 *  Diagnostics, not protocol. The snapshot is derived from the transcript AT SEND TIME,
 *  so once the conversation moves on it cannot be reconstructed — it has to be captured
 *  as it goes out. Overwritten on every send (one file per chat), so it stays bounded
 *  however long the chat runs.
 *
 *  Memory layers are excluded on purpose: they are editable in their own tabs, and
 *  duplicating them here only buried the part that cannot be seen anywhere else. */
export function lastInjectionPath(id: string): string {
  return path.join(dirFor(id), 'last-injection.md');
}

export function writeLastInjection(id: string, snapshot: string): void {
  refuseAdvancedOnlyWrite(id);
  /*
    **收到过后台命令 / 监视输出的会话不另存快照**：快照是从会话记录拼的，里面会带着那段输出（可能有凭证），
    而那段输出只该留在会话记录里、不额外落盘。旧的那份一起删掉 —— 不然快照视图里挂着的是过时的东西。
  */
  if (readRecord(id)?.bgOutputSeen) {
    try { fs.rmSync(lastInjectionPath(id), { force: true }); } catch { /* 没有就算了 */ }
    return;
  }
  ensureDir(id);
  const target = lastInjectionPath(id);
  const header = '# 上一次发送实际带给模型的上下文快照\n'
    + `# 会话 ${id}\n`
    + `# 发送时间 ${new Date().toISOString()}\n`
    + `# ${snapshot.length} 字符（不含 global / project 记忆，那些在各自的标签页里看）\n`
    + `${'='.repeat(70)}\n\n`;
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, header + snapshot, 'utf-8');
  fs.renameSync(tmp, target);
}

export function readLastInjection(id: string): { text: string; at: number } | null {
  try {
    const p = lastInjectionPath(id);
    const { mtimeMs } = fs.statSync(p);
    /*
      `/clear` 之前发出去的那份装着清空前的历史 —— 快照页不再读回它（文件留着）。否则它出现在可编辑的
      快照页里，一保存就成了清空之后的 override，把旧历史又发给模型。
    */
    const cleared = Number(readRecord(id)?.clearedAt);
    if (Number.isFinite(cleared) && cleared > 0 && mtimeMs <= cleared) return null;
    return { text: fs.readFileSync(p, 'utf-8'), at: mtimeMs };
  } catch {
    return null;   // nothing has been injected for this chat yet
  }
}

/** A HAND-EDITED context block that replaces the generated one for this chat.
 *
 *  Separate file from `last-injection.md` on purpose: that one is an ARCHIVE of what
 *  already went out (rewritten by every send, and editing it would change nothing —
 *  those bytes are in the backend's conversation already). This one is an INPUT, so
 *  it must survive the next send instead of being overwritten by it.
 *
 *  It is sticky until removed, which is the risk: a curated block does not grow with
 *  the conversation, so it goes stale exactly the way a frozen `history.md` did. The
 *  dialog therefore states which of the two is in effect and offers one click back to
 *  the generated one. */
export function contextOverridePath(id: string): string {
  return path.join(dirFor(id), 'context-override.md');
}

export function readContextOverride(id: string): { text: string; at: number } | null {
  try {
    const p = contextOverridePath(id);
    const text = fs.readFileSync(p, 'utf-8');
    if (!text.trim()) return null;      // an empty file is not an override
    const { mtimeMs } = fs.statSync(p);
    /*
      `/clear` 之前手改保存的快照装着清空前的历史 —— 它不再生效（文件留着，不删），
      否则 ride-along 会绕过 `readTranscript` 的水位线把旧历史再喂给模型。清空之后新保存的照旧生效。
    */
    const cleared = Number(readRecord(id)?.clearedAt);
    if (Number.isFinite(cleared) && cleared > 0 && mtimeMs <= cleared) return null;
    return { text, at: mtimeMs };
  } catch {
    return null;
  }
}

export function writeContextOverride(id: string, text: string): void {
  refuseAdvancedOnlyWrite(id);
  ensureDir(id);
  const target = contextOverridePath(id);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, target);
}

/** Back to the generated snapshot. Returns false when there was nothing to remove. */
export function clearContextOverride(id: string): boolean {
  if (isAdvancedOnlySession(id)) return false;   // advanced 的上下文不动
  try {
    fs.unlinkSync(contextOverridePath(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * 磁盘上这条是不是 kirolex-advanced 的会话（判据见 `advancedOnly.ts`）—— 是的话标准版**不改它的任何文件**。
 * 下面每个会改 record / transcript / 目录的函数都先问它：入口那层（index.ts）挡住的是正常路径，
 * 这里挡住的是以后新加、忘了挡的那条。
 */
export function isAdvancedOnlySession(id: string): boolean {
  try { return isAdvancedOnly(readRecord(id)); } catch { return false; }
}

function refuseAdvancedOnlyWrite(id: string): void {
  if (isAdvancedOnlySession(id)) {
    throw new Error(tr('This session belongs to KiroLex Advanced; the standard edition does not modify it.'));
  }
}

function ensureDir(id: string): string {
  const d = dirFor(id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 记录还不存在时先记下来，等它出现再写进去 —— 「flow 会话又被加进分屏」的最后一环。
 *
 * 时序事实（实测日志）：`newSession` 一返回，renderer 就标记 purpose，但**记录是第一次 prompt 时才创建的**：
 *   03:53:52 会话创建 → 03:53:54 `purpose LOST … 等了 2s 记录还没出现` → 03:53:59 `prompt received`（此时才有记录）
 * 所以「读记录 → 改 → 写」这条路在会话最年轻的那几秒必然失败，而那几秒恰恰是身份最需要被记下的时候
 * （分屏的自动播种/领养就在这中间跑）。上一版让 handler 等 2 秒，方向就错了：等多久都是赌落盘时刻。
 *
 * 改成异步补写：记录在就直接改，不在就挂起，`createSession` 一建记录立刻应用。挂起项只活在内存里 ——
 * 它代表「这一次运行里刚发生的一个意图」，落盘反而会在下次启动时把陈旧意图写到别的会话上。
 */
const pendingPatches = new Map<string, Partial<SessionRecord>>();

/** 合并一份挂起补丁 —— PURE，便于测试：只覆盖补丁里出现过的键。 */
export function mergePending(rec: SessionRecord, patch: Partial<SessionRecord> | undefined): SessionRecord {
  if (!patch) return rec;
  return { ...rec, ...patch };
}

/**
 * 写一个字段，不管记录现在有没有。返回它是立刻写进去了，还是挂起等记录。
 */
export function patchRecord(id: string, patch: Partial<SessionRecord>): 'written' | 'pending' | 'refused' {
  const rec = readRecord(id);
  if (isAdvancedOnly(rec)) return 'refused';   // advanced 的记录不改
  if (rec) {
    writeRecord(mergePending(rec, patch));
    pendingPatches.delete(id);
    return 'written';
  }
  pendingPatches.set(id, { ...(pendingPatches.get(id) || {}), ...patch });
  return 'pending';
}

/** 有没有挂起的补丁 —— 只给日志和测试用。 */
export function pendingPatchFor(id: string): Partial<SessionRecord> | undefined {
  return pendingPatches.get(id);
}

/** Create + persist a new session record. */
export function createSession(id: string, profile: AgentProfile, title = 'New Chat'): SessionRecord {
  ensureDir(id);
  const now = Date.now();
  const base: SessionRecord = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    createdAt: now,
    updatedAt: now,
    title,
    profile,
    executorState: 'detached',
  };
  // 会话创建之前就到达的那些标记（purpose / flow / primeMode）在这里落地
  const rec = mergePending(base, pendingPatches.get(id));
  pendingPatches.delete(id);
  writeRecord(rec);
  // touch transcript so the file exists
  if (!fs.existsSync(transcriptPath(id))) fs.writeFileSync(transcriptPath(id), '');
  return rec;
}

/**
 * **写盘这一道关：会话不进 KiroLex Advanced 专属的项目** —— 发消息、新建、移动、S3 恢复、跟随云端归属、
 * 冲突合并……各入口都有前置拒绝（给用户的提示更早），这里是兜底：以后新加、忘了挡的那条路也到不了盘上。
 *
 * 写入后的 `profile.projectId` 和磁盘上的不同、并且是 advanced 专属项目 → 换回磁盘上原来的项目
 * （原来未分组就还是未分组），记一条日志，其余字段照常写。不抛错：上层流程不被打断。
 * 换的是 `rec.profile`（新对象，不动调用方可能共享的那份 profile），调用方手里的记录和盘上一致。
 */
function keepOutOfAdvancedProject(rec: SessionRecord, via: string): void {
  const next = String(rec.profile?.projectId ?? '').trim();
  if (!next) return;
  const prev = readRecord(rec.id)?.profile;
  const prevId = String(prev?.projectId ?? '').trim();
  if (next === prevId || !isAdvancedOnlyProjectName(next)) return;
  const profile: AgentProfile = { ...rec.profile };
  if (prevId) profile.projectId = prev!.projectId; else delete profile.projectId;
  if (prev?.unassigned) profile.unassigned = true; else delete profile.unassigned;
  rec.profile = profile;
  logger.warn('session', `${via}: refused to put ${rec.id} into KiroLex Advanced project ${JSON.stringify(next)}; kept ${prevId ? JSON.stringify(prevId) : 'ungrouped'}`);
}

/** Overwrite record.json (metadata is small + rewritable). */
export function writeRecord(rec: SessionRecord): void {
  if (isAdvancedOnlySession(rec.id)) return;   // advanced 的记录：跳过，不改
  keepOutOfAdvancedProject(rec, 'writeRecord');
  ensureDir(rec.id);
  rec.updatedAt = Date.now();
  const tmp = recordPath(rec.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, recordPath(rec.id)); // atomic replace
}

/** Overwrite record.json WITHOUT bumping updatedAt (sync-side bookkeeping that is
 *  not a user edit, e.g. following another machine's project/archive move). */
export function writeRecordKeepUpdatedAt(rec: SessionRecord): void {
  if (isAdvancedOnlySession(rec.id)) return;
  keepOutOfAdvancedProject(rec, 'writeRecordKeepUpdatedAt');
  ensureDir(rec.id);
  const tmp = recordPath(rec.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, recordPath(rec.id)); // atomic replace
}

export function readRecord(id: string): SessionRecord | null {
  try {
    const raw = fs.readFileSync(recordPath(id), 'utf-8');
    // Return the RAW persisted record. executorState is write-only metadata that
    // main keeps accurate via attach/detach writes; it is NOT normalized here,
    // because callers do read-modify-write (memory injection, projectId) and a
    // read-time mutation would silently persist 'detached' onto a live executor.
    // Stale 'attached' left by a crash is reset once at startup (see
    // markAllExecutorsDetached) — nothing branches on it at runtime.
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}

/** One-time startup sweep: after a restart no executor is alive, so any record
 *  left in a live state (attached/attaching) is stale — reset it to detached.
 *  Writes the file directly to PRESERVE updatedAt (so session ordering, which
 *  sorts by updatedAt, is not scrambled). */
export function markAllExecutorsDetached(): void {
  if (!fs.existsSync(baseDir)) return;
  for (const id of fs.readdirSync(baseDir)) {
    const rec = readRecord(id);
    if (isAdvancedOnly(rec)) continue;   // advanced 自己管它的执行器状态
    if (rec && (rec.executorState === 'attached' || rec.executorState === 'attaching')) {
      rec.executorState = 'detached';
      try {
        writeRecordKeepUpdatedAt({ ...rec, id }); // no updatedAt bump; 按目录名写，不跟记录里的 id 走
      } catch { /* best-effort */ }
    }
  }
}

/**
 * 会话记录上的 flow 引用跟着重命名走 —— 返回改了几条。
 *
 * `record.flow` 是身份（主会话删除保护、画布装载、复用判据全靠它），标题只是显示 —— 但 `titleFlow` 会用标题
 * 兜底认人，所以两样都得迁。`retitle` 由调用方注入，这个模块不该反向依赖调用方。
 */
export function renameFlowInRecords(from: string, to: string, retitle: (title: string) => string): number {
  if (!fs.existsSync(baseDir)) return 0;
  const want = (from || '').trim();
  const next = (to || '').trim();
  if (!want || !next || want === next) return 0;
  let changed = 0;
  for (const id of fs.readdirSync(baseDir)) {
    const rec = readRecord(id);
    if (!rec || (rec.flow || '').trim() !== want) continue;
    writeRecord({ ...rec, flow: next, title: retitle(rec.title) });
    changed += 1;
  }
  return changed;
}

export function listSessions(): SessionRecord[] {
  if (!fs.existsSync(baseDir)) return [];
  const out: SessionRecord[] = [];
  for (const id of fs.readdirSync(baseDir)) {
    const rec = readRecord(id);
    // advanced 的会话（flow / skill）不进标准版的任何枚举：侧栏、分屏、搜索、预热、S3、项目归位、级联都走这里
    if (rec && !isAdvancedOnly(rec)) out.push(rec);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

const kirolexDir = path.join(os.homedir(), '.kirolex');

/** 项目在磁盘上有没有 advanced 的 flow 痕迹（`runs/` 非空 / `detached-flows.json` / 同名 flow 定义）—— 只 stat，不读内容。 */
function advancedProjectMarks(project: string): { hasRuns: boolean; hasDetachedFlows: boolean; hasFlowDefinition: boolean } {
  const dir = path.join(kirolexDir, 'projects', projectDirName(project));
  let hasRuns = false;
  try { hasRuns = fs.readdirSync(path.join(dir, 'runs')).length > 0; } catch { /* 没有 runs/ */ }
  const hasDetachedFlows = fs.existsSync(path.join(dir, 'detached-flows.json'));
  /* flow 定义按项目名逐字落在 flows/ 下；带路径分隔符的名字不可能是一个文件名 */
  const name = (project || '').trim();
  const hasFlowDefinition = !!name && !/[\\/]|\.\./.test(name) && fs.existsSync(path.join(kirolexDir, 'flows', `${name}.json`));
  return { hasRuns, hasDetachedFlows, hasFlowDefinition };
}

/**
 * 这些项目名里哪些是 **KiroLex Advanced 专属的项目**（判据在 `advancedOnly.isAdvancedOnlyProject`）：
 * 有 flow 痕迹，并且项目下没有任何普通会话（purpose 为空）。标准版所有列出项目的地方都按它过滤，
 * 会改项目文件 / 往项目里放会话的入口按它拒绝。
 */
export function advancedOnlyProjectsAmong(names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const candidates = [...new Set([...names].map((n) => String(n || '').trim()).filter(Boolean))]
    .map((name) => ({ name, marks: advancedProjectMarks(name) }))
    .filter((c) => c.marks.hasRuns || c.marks.hasDetachedFlows || c.marks.hasFlowDefinition);
  if (!candidates.length) return out;   // 绝大多数项目在这里就结束了：不用去读所有会话记录
  const standard = new Map<string, number>();
  for (const rec of listSessions()) {
    if ((rec.purpose || '').trim()) continue;
    const p = String((rec.profile as any)?.projectId || '').trim();
    if (p) standard.set(p, (standard.get(p) || 0) + 1);
  }
  for (const c of candidates) {
    if (isAdvancedOnlyProject({ ...c.marks, standardSessions: standard.get(c.name) || 0 })) out.add(c.name);
  }
  return out;
}

export function isAdvancedOnlyProjectName(project: string | null | undefined): boolean {
  const p = String(project || '').trim();
  return !!p && advancedOnlyProjectsAmong([p]).has(p);
}

/** `listSessions()` 藏起来的那些（advanced 的会话）的 id —— S3 页要靠它认出「本机有、只是不显示」。 */
export function listAdvancedOnlyIds(): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(baseDir)) return out;
  for (const id of fs.readdirSync(baseDir)) {
    if (isAdvancedOnly(readRecord(id))) out.add(id);
  }
  return out;
}

/**
 * Append ONE complete message to the durable transcript. Append-only, atomic
 * line write. Callers MUST only call this for complete messages (a user message
 * the instant it is sent; an assistant message only once fully received).
 */
export function appendMessage(id: string, msg: StoredMessage): void {
  if (isAdvancedOnlySession(id)) return;   // advanced 的 transcript 不追加
  ensureDir(id);
  fs.appendFileSync(transcriptPath(id), JSON.stringify(msg) + '\n');
  const rec = readRecord(id);
  if (rec) writeRecord(rec); // bump updatedAt
}

/**
 * 这个 messageId 在盘上的状态（不在 / 在但还没回复 / 答过了）—— 发送前按它去重，见 `promptDedupe.ts`。
 * 读的是全量（不看 `/clear` 水位线）：问的是"这一条有没有落过盘"，不是"历史里还算不算它"。
 */
export function messageIdStatusOnDisk(id: string, messageId: string): MessageIdStatus {
  let raw = '';
  try { raw = fs.readFileSync(transcriptPath(id), 'utf-8'); } catch { return 'absent'; }
  const started = readRecord(id)?.startedMessageIds;
  return messageIdStatusInText(raw, messageId, Array.isArray(started) ? new Set(started) : undefined);
}

/** 记下"模型已经开始做这一条了"（`startedMessageIds`，最多留 `STARTED_KEPT` 条）。 */
export const STARTED_KEPT = 50;
export function markMessageStarted(id: string, messageId: string): void {
  const prev = readRecord(id)?.startedMessageIds;
  const list = (Array.isArray(prev) ? prev : []).filter((m) => m !== messageId);
  list.push(messageId);
  patchRecord(id, { startedMessageIds: list.slice(-STARTED_KEPT) });
}

/** 盘上回 `messageId` 的那份完整回复的正文（见 `promptDedupe.completedReplyInText`）；没有就 null。 */
export function completedReplyOnDisk(id: string, messageId: string): string | null {
  let raw = '';
  try { raw = fs.readFileSync(transcriptPath(id), 'utf-8'); } catch { return null; }
  return completedReplyInText(raw, messageId);
}

/**
 * 这条会话的历史 —— **`/clear` 的水位线（`SessionRecord.clearedAt`）之前的不算**。
 *
 * 视图（`acp:read-transcript`）、历史文件、ride-along 快照都从这里拿历史，所以只在这一处过滤。
 * 没有 `ts` 的行留着（不确定就不隐藏你的记录）。`opts.raw` 给真要全量的调用方（例如粘贴文件的引用清扫）。
 */
export function readTranscript(id: string, opts?: { raw?: boolean }): StoredMessage[] {
  const all = readTranscriptRaw(id);
  if (opts?.raw) return all;
  const at = Number(readRecord(id)?.clearedAt);
  if (!Number.isFinite(at) || at <= 0) return all;
  return all.filter((m) => !Number.isFinite(Number((m as any).ts)) || Number((m as any).ts) > at);
}

/** Read the full transcript (tolerant of unknown fields + partial last line). */
function readTranscriptRaw(id: string): StoredMessage[] {
  try {
    const raw = fs.readFileSync(transcriptPath(id), 'utf-8');
    const out: StoredMessage[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const message = JSON.parse(t) as StoredMessage;
        if (message.mergeIntoMessageId) {
          const target = out.find((candidate) => candidate.id === message.mergeIntoMessageId);
          /* 目标是 KiroLex 的提示（也是 role:'user'）就不并：追加指令单独留一条，文字不丢 */
          if (target?.role === 'user' && !isKirolexNote(target)) {
            if (message.content) target.content = `${target.content}
${message.content}`;
            // 带附件的 steer：附件并到这一轮那条用户消息上（气泡里本来就是这么显示的）
            if (message.attachments?.length) target.attachments = [...(target.attachments || []), ...message.attachments];
            /* 记下这一段从哪开始 —— 界面按它把追加指令拆回独立的几条显示（content 照旧是合并后的）。
               只有附件、没有文字的那段没有接进 content，也就不记边界（否则拆分对不上） */
            if (message.content) (target.steerParts ||= []).push({ id: message.id, content: message.content, ts: message.ts });
            continue;
          }
        }
        out.push(message);
      } catch { /* skip a torn final line */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Atomically keep only raw transcript events before `messageId`. */
export function truncateTranscriptBefore(id: string, messageId: string): StoredMessage[] {
  refuseAdvancedOnlyWrite(id);
  const file = transcriptPath(id);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const targetIndex = lines.findIndex((line) => {
    try { return (JSON.parse(line) as StoredMessage).id === messageId; }
    catch { return false; }
  });
  if (targetIndex < 0) throw new Error(tr('Message {id} was not found in the saved transcript.', { id: messageId }));

  ensureDir(id);
  const tmp = `${file}.tmp`;
  const kept = lines.slice(0, targetIndex);
  fs.writeFileSync(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '');
  fs.renameSync(tmp, file);
  const rec = readRecord(id);
  if (rec) writeRecord(rec);
  return readTranscript(id);
}

/**
 * 启动时重试上一次没删完的会话（`deleted-sessions.json` 的墓碑，见 index.ts）。
 *
 * - `suppress`：这一次要压住、不许复活的 id（调用方放进 `deletedSessionIds`）；
 * - `keep`：还要留在墓碑里的 id（没删掉的、以及跳过的 advanced 会话）。
 *
 * **advanced 的会话（flow / skill）跳过** —— 不删目录、不压住，墓碑原样留着给 advanced 自己处理。
 * 两版共用这份文件，残留的 id 可能就是它的。
 */
export function retryPendingDeletions(pending: string[]): { suppress: string[]; keep: string[]; skippedAdvanced: string[] } {
  const suppress: string[] = [];
  const keep: string[] = [];
  const skippedAdvanced: string[] = [];
  for (const id of pending) {
    if (isAdvancedOnlySession(id)) { skippedAdvanced.push(id); keep.push(id); continue; }
    suppress.push(id);
    const dir = path.join(baseDir, id);
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
      if (fs.existsSync(dir)) keep.push(id);
    } catch { keep.push(id); }
  }
  return { suppress, keep, skippedAdvanced };
}

export function deleteSession(id: string): void {
  const d = dirFor(id);
  if (isAdvancedOnlySession(id)) return;
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
}

/**
 * 编辑重发分叉成功后：保留下来的回复的锚点改到新的后端会话（`editFork.remapAnchorsToFork`）。tmp + rename；返回改了几条。
 */
export function remapBackendAnchors(id: string, keepIds: Iterable<string>, oldId: string, newId: string): number {
  refuseAdvancedOnlyWrite(id);
  const file = transcriptPath(id);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return 0; }
  const r = remapAnchorsToFork(raw, keepIds, oldId, newId);
  if (!r.changed) return 0;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, r.text);
  fs.renameSync(tmp, file);
  return r.changed;
}

/** Atomically overwrite the transcript with exactly the given messages. Robust
 *  alternative to truncateTranscriptBefore for edit-and-rerun: the renderer knows
 *  precisely which messages to retain, so no id lookup (which fails for un-persisted
 *  messages like mid-turn steers) is needed. */
export function rewriteTranscript(id: string, messages: StoredMessage[]): void {
  refuseAdvancedOnlyWrite(id);
  ensureDir(id);
  const file = transcriptPath(id);
  const tmp = `${file}.tmp`;
  /*
    调用方给的是界面上能看到的那些（水位线之后的）—— 水位线之前的原样行保住，
    否则编辑后重跑会把 `/clear` 之前的记录真删掉。
  */
  const at = Number(readRecord(id)?.clearedAt);
  const before: string[] = [];
  if (Number.isFinite(at) && at > 0 && fs.existsSync(file)) {
    // 渲染端缓存若还装着水位线之前的消息（例如自动清理时界面没清屏），它们已经在 messages 里，别写两遍
    const given = new Set(messages.map((m) => m.id));
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as StoredMessage;
        const ts = Number(m.ts);
        if (Number.isFinite(ts) && ts <= at && !given.has(m.id)) before.push(line);
      } catch { /* torn line */ }
    }
  }
  /* 回复的去重标记（replyTo / replyComplete）以盘上为准补回去 —— 渲染层那一份可能没带（`carryReplyMarks`） */
  let onDisk = '';
  try { onDisk = fs.readFileSync(file, 'utf-8'); } catch { /* 还没有这份文件 */ }
  /* 分叉锚点同样以盘上为准补回去（`editFork.carryBackendAnchors`） */
  const kept = carryBackendAnchors(onDisk, carryReplyMarks(onDisk, messages));
  const body = [...before, ...kept.map((m) => JSON.stringify(m))].join('\n');
  fs.writeFileSync(tmp, body ? `${body}\n` : '');
  fs.renameSync(tmp, file);
  const rec = readRecord(id);
  if (rec) writeRecord(rec);
}
