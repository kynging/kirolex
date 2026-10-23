/**
 * **会话之间互相调用** —— kirolex-local 上的 `sessions_list` / `session_read` / `session_send`（本地会话、远程会话都挂）。
 *
 * 为什么要有：一条会话想把某件事「转交给专管它的会话」，或者「问另一个会话要它掌握的事实」，原来只能走控制入口的 HTTP
 * （给外部工具用、默认关、要模型自己去读 control.json 里的 token），发了也拿不到对方的回复。这里走主进程，不经控制入口、不要 token。
 *
 *   · `session_send` 的路由和你在输入框按 Enter 一样（界面里的 `steerRoute.enterRoute`：空闲直接发、忙时按对方引擎能力追加 / 排队）；
 *     界面没就绪就进主进程的唤醒队列，对方空了再发。
 *   · `waitReply`：不阻塞这一轮。对方那一轮结束后，把它的回复作为一条新消息唤醒**发起方**（`wakeDispatcher`，同 bg_run）；
 *     超时（默认 30 分钟、上限 2 小时）也唤醒并说明。等待登记落盘，重启后接着等。
 *   · 防循环：消息第一行带 `⟨session:<id> · depth:<n>⟩`。一条会话这一轮是被别的会话叫起来的，它再发出去就是 n+1 层，超过 3 层拒绝；
 *     不许给自己发；同一对会话 1 分钟内最多 10 次。
 *
 * 这里只有参数解释、上限、给模型和给人看的文字；会话从哪来、怎么发、怎么唤醒都由 index.ts 经 `SessionCallsHost` 注入。
 * 纯逻辑，不 import electron。
 */

import { searchSessions } from './sessionSearch.ts';
import { CONTROL_SEND_MAX, CONTROL_TAIL_DEFAULT, CONTROL_TAIL_MAX, CONTROL_TEXT_MAX, tailEntries, type ControlRouted, type ControlSendMode, type TranscriptLike } from './controlSessions.ts';
import { tr } from './uiText.ts';

/** A→B→A… 的链最多几层 */
export const CHAIN_MAX_DEPTH = 3;
/** 同一对会话（发起方 → 对方）在窗口里最多几次 */
export const PAIR_RATE = { max: 10, windowMs: 60_000 };
export const REPLY_DEFAULT_TIMEOUT_SEC = 30 * 60;
export const REPLY_MAX_TIMEOUT_SEC = 2 * 60 * 60;
/** `sessions_list` 最多列几条 */
export const LIST_MAX = 50;
/** 唤醒发起方的那条回复最多带多少字 */
export const REPLY_TEXT_MAX = CONTROL_TEXT_MAX;
/** 看到对方空下来以后，再确认几次（每次一拍）才算这一轮真的结束了 —— 别在排队消息接上之前的空档里抢跑 */
export const IDLE_CONFIRM_TICKS = 2;

export interface SessionInfo {
  id: string;
  title: string;
  /** 没归到项目就是 undefined */
  projectId?: string;
  /** `kiro` / `claude` / `codex` */
  engine: string;
  /** 运行位置：`null` = 本机，否则是远程机器的显示名 */
  location: string | null;
  busy: boolean;
  archived: boolean;
}

export type SendRouted = ControlRouted;

export interface SessionCallsHost {
  now(): number;
  /** 设置「允许会话之间互相调用」（默认开） */
  enabled(): boolean;
  /** 能看见的会话（没删、不是 KiroLex Advanced 的） */
  list(): SessionInfo[];
  /** 同上，单条；删了 / 不存在 / advanced 的是 null */
  get(id: string): SessionInfo | null;
  transcript(id: string): TranscriptLike[];
  /** 按 Enter 的路由发给对方 */
  /** `steerFailed`：要追加进对方正在跑的那一轮，没追加进去 —— 消息在对方会话里标红、等用户选（对方模型**没收到**） */
  send(input: { from: string; to: string; text: string; mode: ControlSendMode }): Promise<{ ok: true; routed: SendRouted; messageId: string; steerFailed?: string } | { ok: false; error: string }>;
  /** 在发起方会话里留一行记录（落盘） */
  note(sessionId: string, text: string): void;
  /** 登记「等对方回复」 */
  watchReply(w: ReplyWatch): void;
}

/* ───────────────────────── 第一行的来源标记 ───────────────────────── */

/**
 * `⟨session:<发起方 id> · depth:<层数>[ · call:<这一次调用的编号>][ · reply]⟩`。
 * `call`：每次 session_send 一个新编号 —— 同一条会话连着发两条一模一样的话（同一层、都要回复）时，
 * 两次等待各认各的那条（`findReply` 按发出去的原文找，原文里带着编号就不会撞）。编号写在正文里，
 * 追加进对方那一轮、排队合并成一条都原样带着。
 */
const TOKEN_RE = /⟨session:([A-Za-z0-9_-]{1,120}) · depth:(\d{1,3})(?: · call:([A-Za-z0-9]{1,40}))?( · reply)?⟩/;

export interface SessionHeader { sessionId: string; depth: number; reply: boolean; /** 这一次调用的编号（老消息没有） */ callId?: string }

function oneLine(s: string, max = 80): string {
  const line = String(s || '').replace(/\s+/g, ' ').trim() || 'New Chat';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function token(id: string, depth: number, reply = false, callId?: string): string {
  return `⟨session:${id} · depth:${depth}${callId ? ` · call:${callId}` : ''}${reply ? ' · reply' : ''}⟩`;
}

/** 一次 session_send 的编号（只用字母数字，放进来源标记里） */
export function newCallId(now = Date.now()): string {
  return `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 对方收到的那条消息的第一行：从哪条会话来、第几层、要不要回；`callId` 让每次调用的原文各不相同 */
export function fromHeader(title: string, id: string, depth: number, waitReply: boolean, callId?: string): string {
  return `${tr('📨 From session "{title}"', { title: oneLine(title) })} ${token(id, depth, false, callId)} ${waitReply
    ? tr('— it is waiting for your reply: answer in this turn and the reply goes back to it automatically.')
    : tr('— it is not waiting for a reply; if you need to answer, use session_send.')}`;
}

/** 回复 / 超时唤醒发起方的那条消息的第一行 */
export function replyHeader(title: string, id: string, depth: number): string {
  return `${tr('📨 Reply from session "{title}"', { title: oneLine(title) })} ${token(id, depth, true)}`;
}

/** 只认第一行、以 📨 开头的；别处出现的同样字样不算 */
export function parseHeader(text: unknown): SessionHeader | null {
  const first = String(text ?? '').split('\n', 1)[0];
  if (!first.startsWith('📨')) return null;
  const m = TOKEN_RE.exec(first);
  if (!m) return null;
  return { sessionId: m[1], depth: Number(m[2]) || 0, reply: !!m[4], ...(m[3] ? { callId: m[3] } : {}) };
}

/**
 * 界面用：把第一行拆成「给人看的那半句」（`📨 来自会话「A」`，发送时已按当时的界面语言写好）和正文。
 * 第一行里 `⟨…⟩` 之后那句是写给对方模型的（要不要回），界面不显示。不是这种消息就是 null。
 */
export function splitSessionHeader(text: unknown): { label: string; sessionId: string; reply: boolean; rest: string } | null {
  const h = parseHeader(text);
  if (!h) return null;
  const s = String(text ?? '');
  const nl = s.indexOf('\n');
  const first = nl >= 0 ? s.slice(0, nl) : s;
  const cut = first.indexOf(' ⟨');
  return { label: (cut >= 0 ? first.slice(0, cut) : first).trim(), sessionId: h.sessionId, reply: h.reply, rest: nl >= 0 ? s.slice(nl + 1).trim() : '' };
}

export type SessionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'from'; label: string; sessionId: string; reply: boolean };

/**
 * 界面用：把一条气泡的文字拆成「正文段」和「📨 来源」段，**每一行**以 📨 开头、带来源标记的都算一个来源 ——
 * 「合并排队消息」开着时几张卡片合成一条，第一行是合并说明，别的会话发来的那几张落在中间，每张都要有自己的标签和跳转。
 * 一个来源都没有就是 null（照原样显示）。
 */
export function sessionSegments(text: unknown): SessionSegment[] | null {
  const out: SessionSegment[] = [];
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) out.push({ kind: 'text', text: t });
    buf = [];
  };
  let found = false;
  for (const line of String(text ?? '').split('\n')) {
    const m = line.startsWith('📨') ? TOKEN_RE.exec(line) : null;
    if (!m) { buf.push(line); continue; }
    found = true;
    flush();
    const cut = line.indexOf(' ⟨');
    out.push({ kind: 'from', label: (cut >= 0 ? line.slice(0, cut) : line).trim(), sessionId: m[1], reply: !!m[4] });
  }
  flush();
  return found ? out : null;
}

/**
 * 一段文字里**任何一行**带的来源标记的最大层数（没有就是 0）。
 *
 * 算层数不能只看第一行：「合并排队消息」开着时，几张排队卡片合成一条，第一行是「[N 条排队消息已合并]」，
 * 别的会话发来的那张（`📨 … ⟨session:… · depth:3⟩`）落在中间 —— 只认第一行就会把第 3 层读成 0，
 * 下一次转发又从第 1 层算起，绕过层数上限。每一行都认是安全的：正文里伪造一个标记只会让层数**更高**（更严），不会更低。
 * （界面上的「📨 来自会话」标签仍只认第一行，见 `parseHeader`。）
 */
export function maxHeaderDepth(text: unknown): number {
  let max = 0;
  for (const line of String(text ?? '').split('\n')) {
    const m = TOKEN_RE.exec(line);
    if (m) max = Math.max(max, Number(m[2]) || 0);
  }
  return max;
}

/**
 * 这条会话**这一轮**是被别的会话叫起来的第几层：看最近那条（不是 KiroLex 提示的）用户消息，
 * 连同折叠进它的追加指令、合并进它的排队消息，取其中最大的层数；不是别的会话来的就是 0。
 */
export function chainDepth(transcript: TranscriptLike[]): number {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i] as TranscriptLike & { kirolex?: boolean; steerParts?: Array<{ content: string }> };
    if (m.role !== 'user' || m.kirolex) continue;
    const parts = [m.content, ...(Array.isArray(m.steerParts) ? m.steerParts.map((p) => p.content) : [])];
    return Math.max(0, ...parts.map((p) => maxHeaderDepth(p)));
  }
  return 0;
}

/* ───────────────────────── 频率 ───────────────────────── */

export class PairRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max = PAIR_RATE.max, windowMs = PAIR_RATE.windowMs) {
    this.max = max;
    this.windowMs = windowMs;
  }
  /** 记一次；超了返回还要等几秒（这一次不记） */
  hit(from: string, to: string, now: number): { ok: true } | { ok: false; retryInSec: number } {
    const key = `${from}→${to}`;
    const kept = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (kept.length >= this.max) {
      this.hits.set(key, kept);
      return { ok: false, retryInSec: Math.max(1, Math.ceil((kept[0] + this.windowMs - now) / 1000)) };
    }
    kept.push(now);
    this.hits.set(key, kept);
    return { ok: true };
  }
}

/* ───────────────────────── 参数 ───────────────────────── */

export type SendArgs = { id: string; text: string; mode: ControlSendMode; waitReply: boolean; timeoutSec: number };

export function checkSendArgs(args: any): { ok: true; value: SendArgs } | { ok: false; error: string } {
  const id = typeof args?.id === 'string' ? args.id.trim() : '';
  if (!id) return { ok: false, error: 'session_send 需要 id（对方会话的 id，用 sessions_list 找）' };
  if (typeof args?.text !== 'string' || !args.text.trim()) return { ok: false, error: 'session_send 需要 text（要发的话），不能是空的' };
  const text = args.text.trim();
  if (text.length > CONTROL_SEND_MAX) return { ok: false, error: `text 太长：${text.length} 字，单条最多 ${CONTROL_SEND_MAX} 字。拆成几条，或者写进文件再让对方去读` };
  if (text.startsWith('/')) return { ok: false, error: '不能发斜杠命令（/clear、/stop、/model …）：它们是界面自己的操作，不是消息' };
  const mode = args?.mode === undefined || args?.mode === null || args?.mode === '' ? 'auto' : args.mode;
  if (mode !== 'auto' && mode !== 'next') return { ok: false, error: `mode 只能是 auto 或 next，收到 ${JSON.stringify(args.mode)}` };
  if (args?.waitReply !== undefined && typeof args.waitReply !== 'boolean') return { ok: false, error: 'waitReply 要是 true / false' };
  const t = Number(args?.timeoutSec);
  const timeoutSec = args?.timeoutSec === undefined || args?.timeoutSec === null || !Number.isFinite(t) || t <= 0
    ? REPLY_DEFAULT_TIMEOUT_SEC
    : Math.min(REPLY_MAX_TIMEOUT_SEC, Math.max(60, Math.round(t)));
  return { ok: true, value: { id, text, mode, waitReply: args?.waitReply === true, timeoutSec } };
}

export function readCount(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) return CONTROL_TAIL_DEFAULT;
  return Math.min(CONTROL_TAIL_MAX, Math.max(1, n));
}

/* ───────────────────────── 对方的回复 ───────────────────────── */

type Msg = TranscriptLike & { kirolex?: boolean; steerParts?: Array<{ content: string; ts: number }> };

/** 往前多少毫秒也算（发出去和落盘之间的时钟差） */
const SINCE_SLACK_MS = 5000;

/**
 * 对方记录里那条消息在哪、之后的回复是什么。认的是**发出去的原文**（第一行的来源标记让它独一无二），
 * 发出去之后的 —— 直接发的、追加进那一轮的（折叠在 `steerParts` 里）、排队合并进一条的都认得。
 * `reply`：那条之后、下一条用户消息之前的助手消息正文；KiroLex 提示不算。
 */
export function findReply(transcript: TranscriptLike[], payload: string, since: number): { found: boolean; reply: string; followedByUser: boolean } {
  const list = transcript as Msg[];
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role !== 'user' || m.kirolex) continue;
    const viaSteer = Array.isArray(m.steerParts) && m.steerParts.some((p) => p.content === payload && Number(p.ts) >= since - SINCE_SLACK_MS);
    if (viaSteer || (String(m.content || '').includes(payload) && Number(m.ts) >= since - SINCE_SLACK_MS)) { idx = i; break; }
  }
  if (idx < 0) return { found: false, reply: '', followedByUser: false };
  const out: string[] = [];
  let followedByUser = false;
  for (let i = idx + 1; i < list.length; i++) {
    const m = list[i];
    if (m.kirolex) continue;
    if (m.role === 'user') { followedByUser = true; break; }
    const body = String(m.content || '').replace(/<hidden>[\s\S]*?<\/hidden>/g, '').trim();
    if (body) out.push(body);
  }
  return { found: true, reply: out.join('\n\n'), followedByUser };
}

function clipReply(text: string): string {
  if (text.length <= REPLY_TEXT_MAX) return text;
  return `${text.slice(0, REPLY_TEXT_MAX)}\n${tr('…[cut: the reply is {n} characters, only the first {max} are here — use session_read to see the rest]', { n: text.length, max: REPLY_TEXT_MAX })}`;
}

export function formatDuration(sec: number): string {
  if (sec % 3600 === 0) return tr('{n} h', { n: sec / 3600 });
  if (sec >= 60) return tr('{n} min', { n: Math.round(sec / 60) });
  return tr('{n} s', { n: sec });
}

export interface ReplyWatch {
  id: string;
  /** 发起方 —— 回复唤醒它 */
  from: string;
  to: string;
  toTitle: string;
  /** 发给对方的原文（含第一行） */
  payload: string;
  since: number;
  deadline: number;
  timeoutSec: number;
  /** 发出去的那条在第几层；回复唤醒发起方时是 depth+1 */
  depth: number;
  /** 看到对方空着的连续拍数（不落盘） */
  idleTicks?: number;
}

export interface ReplyWatcherDeps {
  now(): number;
  transcript(id: string): TranscriptLike[];
  /** 对方正在跑一轮 / 换执行器 / 重建历史 / 还有排着的消息 */
  isBusy(id: string): boolean;
  /** 删了 / 不存在 */
  exists(id: string): boolean;
  title(id: string): string | null;
  /** 唤醒发起方 */
  deliver(sessionId: string, text: string, watch: ReplyWatch): void;
  /** 登记变了（落盘） */
  changed?(list: ReplyWatch[]): void;
  log?(message: string): void;
}

/**
 * 等对方回复的那几条登记。每拍（index.ts 里一个计时器）看一遍：
 *   · 对方记录里出现了那条、而且对方**连续空着**几拍 → 这一轮结束了，把回复唤醒发起方；
 *   · 过了期限 → 唤醒发起方说「没等到」；
 *   · 对方被删了 → 唤醒发起方说一声；发起方被删了 → 不再等。
 */
export class ReplyWatcher {
  private readonly watches = new Map<string, ReplyWatch>();
  private readonly deps: ReplyWatcherDeps;
  constructor(deps: ReplyWatcherDeps) {
    this.deps = deps;
  }

  add(w: ReplyWatch): void {
    this.watches.set(w.id, { ...w, idleTicks: 0 });
    this.save();
  }

  /** 重启后接着等（盘上读回来的） */
  restore(list: ReplyWatch[]): void {
    for (const w of list) if (w && w.id && w.from && w.to) this.watches.set(w.id, { ...w, idleTicks: 0 });
  }

  list(): ReplyWatch[] {
    return [...this.watches.values()].map(({ idleTicks: _i, ...rest }) => rest);
  }

  /** 这条会话删了：它发出的等待不再等 */
  dropFrom(sessionId: string): void {
    let changed = false;
    for (const [id, w] of this.watches) if (w.from === sessionId) { this.watches.delete(id); changed = true; }
    if (changed) this.save();
  }

  tick(): void {
    const now = this.deps.now();
    let changed = false;
    for (const [id, w] of this.watches) {
      const done = (text: string, why: string) => {
        this.watches.delete(id);
        changed = true;
        this.deps.log?.(`reply watch ${id} ${w.from} ← ${w.to}: ${why}`);
        this.deps.deliver(w.from, text, w);
      };
      if (!this.deps.exists(w.from)) { this.watches.delete(id); changed = true; continue; }
      const title = this.deps.title(w.to) || w.toTitle;
      const head = replyHeader(title, w.to, w.depth + 1);
      if (!this.deps.exists(w.to)) {
        done(`${head}\n${tr('⚠️ Session "{title}" was deleted before it replied.', { title: oneLine(title) })}`, 'target deleted');
        continue;
      }
      const r = findReply(this.deps.transcript(w.to), w.payload, w.since);
      const idle = !this.deps.isBusy(w.to);
      w.idleTicks = r.found && idle ? (w.idleTicks || 0) + 1 : 0;
      if (r.found && (r.followedByUser || w.idleTicks >= IDLE_CONFIRM_TICKS)) {
        done(`${head}\n${r.reply ? clipReply(r.reply) : tr('(That turn ended without any reply text.)')}`, 'replied');
        continue;
      }
      if (now >= w.deadline) {
        done(`${head}\n${tr('⏰ No reply from session "{title}" within {dur} (it may still be busy or the message may still be queued). Use session_read to check on it.', { title: oneLine(title), dur: formatDuration(w.timeoutSec) })}`, 'timeout');
      }
    }
    if (changed) this.save();
  }

  private save(): void {
    try { this.deps.changed?.(this.list()); } catch { /* 落盘失败不挡唤醒 */ }
  }
}

/* ───────────────────────── 工具 ───────────────────────── */

const PURPOSE = '用途：把某件事**转交给专管它的会话**（例如「agent board 的修复交给 agent board 会话」），'
  + '或者**问另一个会话要它掌握的事实**（它读过的文件、跑过的结论）。不是用来分活并行跑的：对方一次只处理一条，忙的时候排队。';
const LIMITS = `限制：不能发给自己；会话之间来回转发最多 ${CHAIN_MAX_DEPTH} 层（A→B→A… 超过就拒绝）；同一对会话 ${PAIR_RATE.windowMs / 1000} 秒内最多 ${PAIR_RATE.max} 次；`
  + '已删除 / 已归档的会话发不了；不能发斜杠命令。用户可以在设置里关掉「允许会话之间互相调用」。';

export function sessionToolDefs(): Array<{ name: string; description: string; inputSchema: any }> {
  return [
    {
      name: 'sessions_list',
      description: `列出用户的其他 KiroLex 会话（按标题 / 项目 / id 找），给 session_read / session_send 用。${PURPOSE}\n`
        + `返回每条的 id、标题、项目、引擎、运行位置（本机 / 哪台远程机器）、是否正忙、是否已归档；最多 ${LIST_MAX} 条，不含消息内容。`,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: '标题 / 项目名的一部分，或者会话 id（整串或至少 4 位前缀）。不给 = 全部' } },
      },
    },
    {
      name: 'session_read',
      description: `读另一条会话最近的几条消息（默认 ${CONTROL_TAIL_DEFAULT} 条，最多 ${CONTROL_TAIL_MAX} 条）。`
        + `每条正文最多 ${CONTROL_TEXT_MAX} 字，超出的截断并注明；工具调用只给一行标题，不给工具输出原文。${PURPOSE}`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '对方会话的 id（用 sessions_list 找）' },
          n: { type: 'number', description: `读最近几条，默认 ${CONTROL_TAIL_DEFAULT}，最多 ${CONTROL_TAIL_MAX}` },
        },
        required: ['id'],
      },
    },
    {
      name: 'session_send',
      description: `给另一条会话发一条消息，和用户在它的输入框里按 Enter 一样：对方空闲就直接发；正在回答就按它的引擎能力追加进这一轮或排队；`
        + '`mode: "next"` = 等它这一轮结束再作为下一条发（进排队卡片）。对方看到的是「📨 来自会话「<这条会话的标题>」」，能点回来。\n'
        + `\`waitReply: true\`：**不会在这一轮里等** —— 立即返回；对方那一轮结束后，它的回复会作为一条新消息发回这条会话（同 bg_run），`
        + `超时（\`timeoutSec\`，默认 ${REPLY_DEFAULT_TIMEOUT_SEC / 60} 分钟、上限 ${REPLY_MAX_TIMEOUT_SEC / 3600} 小时）也会发一条说明。所以发完就结束这一轮，不要轮询。\n`
        + `单条最多 ${CONTROL_SEND_MAX} 字，写清楚背景 —— 对方看不到你这边的对话。${PURPOSE}\n${LIMITS}`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '对方会话的 id（用 sessions_list 找）' },
          text: { type: 'string', description: '要发的话（对方看不到你这边的上下文，写完整）' },
          mode: { type: 'string', enum: ['auto', 'next'], description: 'auto（默认）= 同 Enter；next = 等对方这一轮结束再发' },
          waitReply: { type: 'boolean', description: 'true = 对方这一轮结束后把它的回复作为新消息发回这条会话' },
          timeoutSec: { type: 'number', description: `waitReply 最长等多少秒，默认 ${REPLY_DEFAULT_TIMEOUT_SEC}，上限 ${REPLY_MAX_TIMEOUT_SEC}（最少 60）` },
        },
        required: ['id', 'text'],
      },
    },
  ];
}

const NAMES = new Set(['sessions_list', 'session_read', 'session_send']);
export function isSessionTool(name: string): boolean {
  return NAMES.has(name);
}

const DISABLED = '会话之间互相调用被用户关掉了（设置 → 开关 →「允许会话之间互相调用」）。要转交的话，告诉用户你想发给哪条会话、发什么，请用户自己转。';

function where(s: SessionInfo): string {
  return s.location ? `远程 ${s.location}` : '本机';
}

const ROUTED_TEXT: Record<SendRouted, string> = {
  sent: '对方空闲，已直接发出',
  steer: '对方正在回答，已追加进它这一轮',
  queued: '已排进对方的队列，它这一轮结束后发',
};

export async function callSessionTool(
  name: string,
  args: any,
  sessionId: string,
  host: SessionCallsHost,
  limiter: PairRateLimiter,
): Promise<{ text: string; isError?: boolean }> {
  const err = (text: string) => ({ text, isError: true });
  if (!NAMES.has(name)) return err(`没有这个工具：${name}`);
  if (!host.enabled()) return err(DISABLED);
  switch (name) {
    case 'sessions_list': {
      const query = typeof args?.query === 'string' ? args.query : '';
      const all = host.list().filter((s) => s.id !== sessionId);
      const hits = searchSessions(all, query).hits;
      if (!hits.length) return { text: query.trim() ? `没有标题 / 项目 / id 能对上「${query.trim()}」的会话。` : '没有别的会话。' };
      const shown = hits.slice(0, LIST_MAX);
      return {
        text: shown.map((s) => `${s.id} · 「${oneLine(s.title, 120)}」 · 项目 ${s.projectId || '（未分组）'} · ${s.engine} · ${where(s)}`
          + `${s.busy ? ' · 正忙' : ' · 空闲'}${s.archived ? ' · 已归档（发不了）' : ''}`).join('\n')
          + (hits.length > shown.length ? `\n…还有 ${hits.length - shown.length} 条没列，给 query 缩小范围。` : ''),
      };
    }
    case 'session_read': {
      const id = typeof args?.id === 'string' ? args.id.trim() : '';
      if (!id) return err('session_read 需要 id（对方会话的 id，用 sessions_list 找）');
      const target = host.get(id);
      if (!target) return err(`没有这条会话：${id}（不存在或已删除）。用 sessions_list 找。`);
      const n = readCount(args?.n);
      const rows = tailEntries(host.transcript(id), n);
      if (!rows.length) return { text: `会话「${oneLine(target.title)}」还没有消息。` };
      return {
        text: `会话「${oneLine(target.title)}」（${target.busy ? '正忙' : '空闲'}）最近 ${rows.length} 条：\n`
          + rows.map((r) => {
            const cut = r.text.length > CONTROL_TEXT_MAX && r.text.endsWith('…');
            const body = cut ? `${r.text.slice(0, CONTROL_TEXT_MAX)}\n[已截断：这条太长，只给了前 ${CONTROL_TEXT_MAX} 字]` : r.text;
            return `── ${r.role === 'user' ? '用户' : '助手'} · ${new Date(r.ts).toLocaleString()} · ${r.id}\n${body || '（空）'}`;
          }).join('\n'),
      };
    }
    case 'session_send': {
      const checked = checkSendArgs(args);
      if (!checked.ok) return err(checked.error);
      const a = checked.value;
      if (a.id === sessionId) return err('不能给自己发（这就是当前这条会话）。');
      const target = host.get(a.id);
      if (!target) return err(`没有这条会话：${a.id}（不存在或已删除），没发。用 sessions_list 找。`);
      if (target.archived) return err(`会话「${oneLine(target.title)}」已归档，没发。请用户先把它移出归档。`);
      const depth = chainDepth(host.transcript(sessionId)) + 1;
      if (depth > CHAIN_MAX_DEPTH) {
        return err(`没发：这一轮本身就是别的会话转过来的，再转出去就是第 ${depth} 层（会话之间来回转最多 ${CHAIN_MAX_DEPTH} 层，防止互相无限调用）。请直接在这条会话里回答，或者告诉用户。`);
      }
      const rate = limiter.hit(sessionId, a.id, host.now());
      if (!rate.ok) return err(`没发：${PAIR_RATE.windowMs / 1000} 秒内已经给会话「${oneLine(target.title)}」发了 ${PAIR_RATE.max} 次（上限），${rate.retryInSec} 秒后再试。是不是在循环？`);
      const self = host.get(sessionId);
      /* 每次一个编号：同样的话发两次，两次等待各认各的（见 TOKEN_RE） */
      const payload = `${fromHeader(self?.title || sessionId, sessionId, depth, a.waitReply, newCallId(host.now()))}\n${a.text}`;
      /* 等回复的起点取在发出去**之前**：发送确认可能晚于消息落盘好几秒，起点取晚了就认不出那条（见 findReply 的时间窗） */
      const sentAt = host.now();
      const r = await host.send({ from: sessionId, to: a.id, text: payload, mode: a.mode });
      if (!r.ok) return err(`没发出去：${r.error}`);
      const excerpt = oneLine(a.text, 200);
      if (r.steerFailed) {
        /* 没追加进对方那一轮：对方模型没收到，消息在对方会话里标红等用户选「作为下一条发送 / 放回输入框」。不算发成功、不等回复 */
        host.note(sessionId, tr('⚠️ Could not add the message to the running turn of session "{title}" ({reason}); it is marked red there and waits for the user: {text}', {
          title: oneLine(target.title), reason: r.steerFailed, text: excerpt,
        }));
        return err(`没送到：会话「${oneLine(target.title)}」正在回答，但没能追加进它这一轮（${r.steerFailed}）。对方模型没有收到这条；`
          + '它在对方会话里标红，等用户选「作为下一条发送」或「放回输入框」。'
          + (a.waitReply ? '没有登记等回复。' : '')
          + '可以告诉用户去那条会话处理，或者稍后用 mode: "next" 重发（等它这一轮结束再发）。');
      }
      host.note(sessionId, tr('📤 Sent to session "{title}" ({route}): {text}', {
        title: oneLine(target.title), route: routedNote(r.routed), text: excerpt,
      }));
      if (a.waitReply) {
        const now = host.now();
        host.watchReply({
          id: `reply_${now}_${Math.random().toString(36).slice(2, 8)}`,
          from: sessionId, to: a.id, toTitle: target.title, payload,
          since: sentAt, deadline: sentAt + a.timeoutSec * 1000, timeoutSec: a.timeoutSec, depth,
        });
      }
      return {
        text: `已发给会话「${oneLine(target.title)}」（${a.id}）：${ROUTED_TEXT[r.routed]}。`
          + (a.waitReply
            ? `它这一轮结束后，回复会作为一条新消息发回这条会话（最长等 ${formatDuration(a.timeoutSec)}）。现在结束这一轮，不要等、不要轮询。`
            : '没有要求回复；要看它的进展用 session_read。'),
      };
    }
    default:
      return err(`没有这个工具：${name}`);
  }
}

/** 发起方记录行里的「怎么发的」（中文在 uiTextZh/sessionCalls.ts） */
function routedNote(r: SendRouted): string {
  if (r === 'steer') return tr('added to its running turn');
  if (r === 'queued') return tr('queued until its turn ends');
  return tr('sent right away');
}
