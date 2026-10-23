/**
 * **已经交给适配器、还没轮到的那几条**（`followUpTurns.ts` 的 queued）在盘上的记账 ——
 * `sessions/<id>/pending-handoffs.json`。
 *
 * 为什么要有：一条 handoff 的 session/prompt 一发出去，界面上它就从输入框里拿走了；而它的用户消息要等前一轮
 * 收尾、交棒那一刻才进 transcript（顺序才对）。这中间 KiroLex 退出 / 崩溃，适配器（子进程）跟着没了，
 * 那条 prompt 也就没跑 —— 只在内存里的话，这条消息就丢了。所以：**发之前**先同步写进这里，交棒落盘 transcript 的同时
 * 摘掉，没轮到就失败（放回 KiroLex 队列）也摘掉。重启后（`takeRecoverable`）还在这里、transcript 里又没有的，
 * 就是没跑成的，交给渲染端放回 KiroLex 队列；transcript 里已经有的（交棒落盘了、只是没来得及摘）不再放回，免得重复。
 *
 * 只用 fs，函数都收会话目录（测试传临时目录）。写法和 sessionStore 的 record 一样：tmp + rename。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface PendingHandoff {
  /** 那条用户消息的 id（交棒时落盘用的就是它） */
  id: string;
  /** 气泡里显示的原文（带粘贴占位符的那份） */
  content: string;
  attachments?: Array<{ id?: string; name?: string; path: string; isImage?: boolean }>;
  pastes?: any[];
  ts: number;
  /**
   * 交棒了（这一轮已经交给适配器在跑了）的时间。有它就说明这条**已经执行过 / 正在执行**，只是用户消息没写上 transcript：
   * 重启时**不能自动重发**（会把做过的事再做一遍），而是把这条用户消息补写进对话记录（`handoffsToRestore`），要不要重跑由你决定。
   */
  startedAt?: number;
}

const FILE = 'pending-handoffs.json';

export function readPendingHandoffs(sessionDir: string): PendingHandoff[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(sessionDir, FILE), 'utf8'));
    return Array.isArray(raw)
      ? raw.filter((h: any) => h && typeof h.id === 'string' && typeof h.content === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeAll(sessionDir: string, list: PendingHandoff[]): void {
  const file = path.join(sessionDir, FILE);
  if (!list.length) {
    try { fs.unlinkSync(file); } catch { /* 本来就没有 */ }
    return;
  }
  fs.mkdirSync(sessionDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
}

/** 发之前记一笔（同步写盘）。同一个 id 只记一次。 */
export function addPendingHandoff(sessionDir: string, item: PendingHandoff): void {
  const list = readPendingHandoffs(sessionDir).filter((h) => h.id !== item.id);
  writeAll(sessionDir, [...list, item]);
}

/** 交棒落盘了 / 放弃了：摘掉 */
export function removePendingHandoff(sessionDir: string, id: string): void {
  const list = readPendingHandoffs(sessionDir);
  if (!list.some((h) => h.id === id)) return;
  writeAll(sessionDir, list.filter((h) => h.id !== id));
}

/**
 * 窗口启动时要放回 KiroLex 队列的那些：transcript 里还没有的 —— 没跑成。**只读不摘**：窗口把它们放进队列、
 * 队列写了盘、再确认（`acp:ack-handoff-failed`）之后才摘；中间窗口刷新 / 崩溃 / 应用退出，下次启动照样还在这里
 * （窗口按队列里的 `fromHandoff` 认出已经放回过的，不放第二遍）。
 * transcript 里已经有的（交棒时落过盘、只是没来得及摘）不再给，顺手摘掉 —— 它们在对话里了，不会丢。
 * `liveIds`：主进程内存里还排着的（只是窗口刷新了，主进程和适配器都还在）—— 不交出去，它们照常会轮到。
 */
/**
 * 对话记录里关于这些 handoff 的两件事，**分开判**：
 *   · `saved`：用户消息本身在盘上了（它自己的 id，或放回队列后发出去的那条带着的 `fromHandoff`）—— 记录可以摘；
 *   · `executed`：执行过了（上面那些，再加上有回复 `replyTo` 指着它）—— 不能再自动重发。
 * 有回复、却没有用户消息（写盘失败过）：executed 但没 saved —— 不重发，但要把原文补写回去（`handoffsToRestore`）。
 * 直接传一个 Set 时两样当成一样（老的调用 / 测试）。
 */
export interface HandoffFacts { saved: Set<string>; executed: Set<string> }
const factsOf = (f: HandoffFacts | Set<string>): HandoffFacts => (f instanceof Set ? { saved: f, executed: f } : f);

export function recoverableHandoffs(sessionDir: string, facts: HandoffFacts | Set<string>, liveIds: Set<string> = new Set()): PendingHandoff[] {
  const { saved, executed } = factsOf(facts);
  const list = readPendingHandoffs(sessionDir);
  if (!list.length) return [];
  /* 只摘「用户消息在盘上了」的；只是执行过、原文没写上的留着，等 handoffsToRestore 补写 */
  if (list.some((h) => saved.has(h.id))) writeAll(sessionDir, list.filter((h) => !saved.has(h.id)));
  /* 交棒过的（startedAt）、或者有回复指着的：执行过了，自动重发会重复执行 —— 见 handoffsToRestore */
  return list.filter((h) => !h.startedAt && !executed.has(h.id) && !saved.has(h.id) && !liveIds.has(h.id));
}

/**
 * 交棒过、但用户消息没写上 transcript 的那些（`startedAt`）：已经执行过 / 执行到一半，**不自动重发**。
 * 重启时把用户消息补写进对话记录（index.ts），你能看到它、自己决定要不要重跑；补写成功后再摘记录。
 */
export function handoffsToRestore(sessionDir: string, facts: HandoffFacts | Set<string>, liveIds: Set<string> = new Set()): PendingHandoff[] {
  const { saved, executed } = factsOf(facts);
  return readPendingHandoffs(sessionDir).filter((h) => (!!h.startedAt || executed.has(h.id)) && !saved.has(h.id) && !liveIds.has(h.id));
}

/** 交棒那一刻记一笔「已经交给适配器在跑了」（写在落盘用户消息之前：那一步失败了，重启也知道它跑过） */
export function markHandoffStarted(sessionDir: string, id: string, at = Date.now()): void {
  const list = readPendingHandoffs(sessionDir);
  if (!list.some((h) => h.id === id && !h.startedAt)) return;
  writeAll(sessionDir, list.map((h) => (h.id === id ? { ...h, startedAt: at } : h)));
}

/** ui-state 里的 KiroLex 队列（`kirolex-queues`）有没有那条放回来的（按 `fromHandoff` 认） */
export function queuesHoldHandoff(queuesRaw: string | null | undefined, sessionId: string, messageId: string): boolean {
  try {
    const queues = JSON.parse(queuesRaw || '{}');
    const list = queues && typeof queues === 'object' ? queues[sessionId] : null;
    return Array.isArray(list) && list.some((i: any) => i && i.fromHandoff === messageId);
  } catch {
    return false;
  }
}

/**
 * 窗口说「放回队列了」（`acp:ack-handoff-failed`）：**ui-state 真的写上了盘、而且写上去的队列里有它**，才摘记录。
 * 写盘失败 / 队列里找不到（比如窗口那份没写进来）→ 记录留着、回 false，下次启动照样能放回（按 fromHandoff 不重复）。
 */
export function ackRequeued(sessionDir: string, sessionId: string, messageId: string, deps: { flush: () => boolean; queuesRaw: () => string | null | undefined }): boolean {
  if (!deps.flush()) return false;
  if (!queuesHoldHandoff(deps.queuesRaw(), sessionId, messageId)) return false;
  removePendingHandoff(sessionDir, messageId);
  return true;
}

/**
 * transcript 里「已经发过了」的那些 id：每条消息自己的 id、回复指着的那条（`replyTo`），加上放回 KiroLex 队列后发出去的那条带着的原 handoff id
 * （`fromHandoff`，排队合并发送时一条消息可以带几条）。重启恢复（`recoverableHandoffs`）拿它判哪些不能再放回。
 */
export function sentHandoffIds(transcript: Array<{ id?: unknown; fromHandoff?: unknown; replyTo?: unknown }>): Set<string> {
  const known = new Set<string>();
  for (const m of transcript || []) {
    if (typeof m?.id === 'string' && m.id) known.add(m.id);
    /* 有回复指着它（replyTo）：它执行过了 —— 哪怕它自己的用户消息没写上 */
    if (typeof m?.replyTo === 'string' && m.replyTo) known.add(m.replyTo);
    if (Array.isArray(m?.fromHandoff)) for (const hid of m.fromHandoff) if (typeof hid === 'string' && hid) known.add(hid);
  }
  return known;
}

/**
 * 交棒那一刻：先把用户消息写进 transcript（`persist`，返回写上了没有；抛错也算没写上），**写上了才摘**这条的恢复记录。
 * 没写上（文件被占用之类）→ 记录留着、返回 false：重启时它还能放回 KiroLex 队列，不会悄悄丢掉。
 */
export function persistThenRelease(sessionDir: string, id: string, persist: () => boolean): boolean {
  let ok = false;
  try { ok = persist() === true; } catch { ok = false; }
  if (!ok) return false;
  try { removePendingHandoff(sessionDir, id); } catch { /* 摘不掉：重启时按 transcript 认出它已经落过盘 */ }
  return true;
}

/**
 * 重启时处理交棒过、用户消息没写上的那些（`handoffsToRestore`）：把用户消息补写进对话记录（`append`，用原来的 id），
 * 写上了才摘记录；写不上就留着下次再试。**一条都不自动重发**。返回补写上的那些。
 */
export function restoreStartedHandoffs(sessionDir: string, facts: HandoffFacts | Set<string>, liveIds: Set<string>, append: (h: PendingHandoff) => void): PendingHandoff[] {
  const done: PendingHandoff[] = [];
  for (const h of handoffsToRestore(sessionDir, facts, liveIds)) {
    try { append(h); } catch { continue; }
    removePendingHandoff(sessionDir, h.id);
    done.push(h);
  }
  return done;
}

/** `sentHandoffIds`（执行过了）和「用户消息在盘上了」分开给（见 `HandoffFacts`） */
export function handoffFacts(transcript: Array<{ id?: unknown; fromHandoff?: unknown; replyTo?: unknown }>): HandoffFacts {
  const saved = new Set<string>();
  for (const m of transcript || []) {
    if (typeof m?.id === 'string' && m.id) saved.add(m.id);
    if (Array.isArray(m?.fromHandoff)) for (const hid of m.fromHandoff) if (typeof hid === 'string' && hid) saved.add(hid);
  }
  return { saved, executed: sentHandoffIds(transcript) };
}

/**
 * 补写回 transcript 的那条用户消息（`restoreStartedHandoffs` 的 append 用）：和交棒时 `persistUserMessage` 写的同一个形状 ——
 * 原 id、原文、附件，**还有粘贴块**（seq / lines / chars / path）。不带粘贴块的话，恢复后 `[ 粘贴 #N · M 行 ]` 展不开，
 * 清理粘贴原文时也认不出它还被引用。`via` 由调用方按 id 加（控制入口发的）。
 */
export function restoredUserMessage(h: PendingHandoff): {
  id: string; role: 'user'; content: string; ts: number;
  attachments?: Array<{ id?: string; name: string; path: string; isImage?: boolean }>;
  pastes?: Array<{ seq: number; lines: number; chars: number; path: string }>;
} {
  const pastes = Array.isArray(h.pastes)
    ? h.pastes.map((p: any) => ({
        seq: Number(p?.seq) || 0,
        lines: Number(p?.lines) || 0,
        chars: Number(p?.chars) || 0,
        path: String(p?.path || ''),
      })).filter((p) => p.path)
    : [];
  return {
    id: h.id,
    role: 'user',
    content: h.content,
    ts: h.ts,
    ...(h.attachments?.length ? { attachments: h.attachments.map((a) => ({ ...(a.id ? { id: a.id } : {}), name: String(a.name || ''), path: a.path, ...(a.isImage ? { isImage: true } : {}) })) } : {}),
    ...(pastes.length ? { pastes } : {}),
  };
}
