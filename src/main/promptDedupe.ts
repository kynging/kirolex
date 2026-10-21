/**
 * **同一次提交只落盘一次、只发给模型一次** ——「网络不好重试的时候，会话里会一直重复发同一条消息」。
 *
 * 实测那条会话（远端 tokyo-graviton）：同一条【改写 · …第 10 行】在 40 分钟里进了 transcript 11 次，
 * 每次都换来一份几乎一样的回复。那些 id 都是 `u_<时间戳>` —— 调用方没给 messageId，主进程每次现生成一个，
 * 于是"又来了一次同样的提交"和"一条新消息"在主进程眼里没有区别，`appendMessage` 无条件追加，照发不误。
 *
 * 规则（`decidePromptDedupe`，判据只在这里）：
 *   · 调用方给了 messageId 的，按它认"是不是同一次提交"；没给的（主进程自己生成）照旧；
 *   · 同一个 id **正在跑** → 合并到那一次（`InFlightPrompts`），不另起一轮；
 *   · 同一个 id **已经在盘上、也答过了** → 拒绝：不追加、不发；
 *   · 同一个 id 已经在盘上、**还没有回复**（上一次没发成：网络断了、执行器死了）→ 再发，但不再追加一条 ——
 *     会话里还是只有那一条用户消息；
 *   · 自动重发（`attempt > 0`）是同一轮，本来就不落盘（见 `sendPromptOnce`）。
 *
 * 纯的（不 import electron），读盘那一步只收文本，测试见 `tests/promptDedupe.test.ts`。
 */

import { createHash } from 'node:crypto';

/**
 * `absent` 不在盘上；`unanswered` 在盘上、模型还**什么都没做**（没出过字、没跑过工具 —— 上一次是还没交给模型、或者交过去之前就断了）；
 * `started` 在盘上、模型**已经开始做了**（出过字或者跑过工具）但没有完整收尾；`answered` 完整答过了。
 */
export type MessageIdStatus = 'absent' | 'unanswered' | 'started' | 'answered';

interface IdMsg { id?: string; role?: string; replyTo?: string; replyComplete?: boolean; kirolex?: boolean; mergeIntoMessageId?: string }

/**
 * 这个 id 在这份记录里：不在 / 在但还没有回它的完整回复 / 在而且答过了。
 *
 * **"答过了"按 `replyTo` + `replyComplete` 认**（助手消息记下它回的是哪一条、是不是正常收尾的完整回复，见 `flushAssistant`）——
 * 不能看"后面有没有助手消息"：A 网络失败没回复、你另发 B 得到了回复，那条回复回的是 B，A 还该能重试。
 * 出错 / 取消时 flush 的半截有 `replyTo` 但没有 `replyComplete`，不算答过。
 *
 * 老记录（这一项出现之前写的）没有 `replyTo`：只认**紧跟着它**的那条（跳过 KiroLex 提示和并进来的追加指令）
 * 是不带 `replyTo` 的助手消息 —— 那就是当年回它的那一条。
 */
export function messageIdStatus(messages: readonly IdMsg[], messageId: string, started?: ReadonlySet<string>): MessageIdStatus {
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.id === messageId) { at = i; break; }
  /* 不在盘上、但记着它开始做过（自动重发那几次的 id 不落盘）—— 照样算 started */
  if (at < 0) return started?.has(messageId) ? 'started' : 'absent';
  for (let i = at + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === 'assistant' && m.replyTo === messageId && m.replyComplete) return 'answered';
  }
  for (let i = at + 1; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.kirolex || m.mergeIntoMessageId) continue;
    if (m.role === 'assistant' && m.replyTo === undefined) return 'answered';
    break;
  }
  /*
    **已经开始做了**：主进程记着这一条出过字 / 跑过工具（`started`，见 index.ts 的 `noteTurnStarted`，跟着会话记录落盘），
    或者盘上有回它的半截（出错 / 取消时 flush 的、带 `replyTo` 没有 `replyComplete`）。
  */
  if (started?.has(messageId)) return 'started';
  for (let i = at + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === 'assistant' && m.replyTo === messageId) return 'started';
  }
  return 'unanswered';
}

/**
 * 同上，直接对 transcript.jsonl 的文本判。**每次发送都要问一次**，所以先做一次子串查找：
 * 绝大多数发送是新 id，连 JSON 都不用解析。坏掉的最后一行（写到一半）跳过。
 */
export function messageIdStatusInText(raw: string, messageId: string, started?: ReadonlySet<string>): MessageIdStatus {
  if (!raw || !raw.includes(JSON.stringify(messageId))) return started?.has(messageId) ? 'started' : 'absent';
  const msgs: IdMsg[] = [];
  for (const l of raw.split('\n')) {
    const t = l.trim();
    if (!t) continue;
    try {
      const m = JSON.parse(t);
      if (m && typeof m === 'object') {
        msgs.push({
          id: typeof m.id === 'string' ? m.id : undefined,
          role: m.role,
          ...(typeof m.replyTo === 'string' ? { replyTo: m.replyTo } : {}),
          ...(m.replyComplete ? { replyComplete: true } : {}),
          ...(m.kirolex ? { kirolex: true } : {}),
          ...(typeof m.mergeIntoMessageId === 'string' ? { mergeIntoMessageId: m.mergeIntoMessageId } : {}),
        });
      }
    } catch { /* 写到一半的最后一行 */ }
  }
  return messageIdStatus(msgs, messageId, started);
}

export type DedupeDecision =
  | { action: 'send'; persist: boolean }
  | { action: 'reject'; reason: 'answered' | 'started' };

/** 这一发要不要落盘、要不要发。`explicitId`：messageId 是不是调用方给的。 */
export function decidePromptDedupe(input: { explicitId: boolean; attempt: number; status: MessageIdStatus }): DedupeDecision {
  /*
    自动重发（attempt > 0）是同一轮、本来就不落盘 —— 但**模型这一轮已经开始做了**（出过字 / 跑过工具）就不能再发：
    `planRetry` 本该在这时停下，这里再兜一层（它看的那份"出过字"曾经在 flush 之后才读，读到的永远是空）。
  */
  if (input.attempt > 0) return input.status === 'started' ? { action: 'reject', reason: 'started' } : { action: 'send', persist: false };
  if (!input.explicitId) return { action: 'send', persist: true };
  if (input.status === 'answered') return { action: 'reject', reason: 'answered' };
  /*
    **模型已经开始做了、又断了**：不自动再发 —— 它可能已经跑过工具（写了文件、执行了命令），再发一遍就是再做一遍。
    `sendPromptOnce` 自己的自动重发（`planRetry`）同样在"已经出过字 / 跑过工具"时停下；这里堵的是外层
    （排队重试、侧栏再提交、重连后重发）拿同一个 messageId 以 attempt=0 绕过去的那条路。要重来就点「重跑」（换新的一条）。
  */
  if (input.status === 'started') return { action: 'reject', reason: 'started' };
  return { action: 'send', persist: input.status === 'absent' };
}

/** 被拒绝的重复提交带的错误码 —— 调用方据此认出"这是重复"，不靠随界面语言变的文字。 */
export const DUPLICATE_MESSAGE = 'KIROLEX_DUPLICATE_MESSAGE';
/** 同一个 messageId 上一次**已经开始执行**（出过字 / 跑过工具）后断了 —— 拒绝自动再发（见 `decidePromptDedupe`）。 */
export const DUPLICATE_STARTED = 'KIROLEX_DUPLICATE_STARTED';

/** 同一次提交还能不能**按同一个 messageId 接着来**：只有模型还什么都没做（或者根本还没落盘）时可以。 */
export function canRetrySame(status: MessageIdStatus): boolean {
  return status === 'absent' || status === 'unanswered';
}

/**
 * 正在跑的那些（按会话 + messageId）。同一个 id 又来一次 → 拿到同一个 Promise，不另起一轮。
 * 跑完（成功或失败）就摘掉：失败之后的重试是合法的，交给 `decidePromptDedupe` 按盘上状态判。
 * 没有 id 的不合并。
 */
export class InFlightPrompts<T> {
  private running = new Map<string, Promise<T>>();

  private key(sessionId: string, messageId: string): string { return `${sessionId}\n${messageId}`; }

  has(sessionId: string, messageId: string | undefined): boolean {
    return !!messageId && this.running.has(this.key(sessionId, messageId));
  }

  run(sessionId: string, messageId: string | undefined, job: () => Promise<T>): Promise<T> {
    if (!messageId) return job();
    const k = this.key(sessionId, messageId);
    const cur = this.running.get(k);
    if (cur) return cur;
    let started: Promise<T>;
    try { started = job(); } catch (err) { started = Promise.reject(err); }
    const p: Promise<T> = started.finally(() => {
      if (this.running.get(k) === p) this.running.delete(k);
    });
    this.running.set(k, p);
    return p;
  }
}

/**
 * 侧栏改写那一问的用户消息 id —— **跟着 ticket 走**（一次提交一张 ticket，见 ReviewPane 的 `enqueue`）。
 * 同一张 ticket 升级到 `patch`、格式不对再追问一次，是另外的问题，id 也不同。没有 ticket 的老调用方返回
 * undefined，主进程照旧现生成。ticket 里带路径，取哈希只为让 id 干净。
 *
 * **id 里还带着这一问的提示词指纹**（`prompt`）：失败之后用同一张 ticket 再提交时（ReviewPane 复用它），
 * 要改的那一段 / 基准正文没变 → 同一个 id，主进程认得出是同一问（不再落盘、答过的直接用盘上那份回复）；
 * 那一段在这期间被改过 → 问的已经是另一件事了，id 也不同，照常落盘、发出去。
 */
export function reviseMessageId(ticket: string | undefined, scope: string, prompt = '', followUp = false): string | undefined {
  if (!ticket) return undefined;
  const h = createHash('sha1').update(ticket).digest('hex').slice(0, 16);
  const p = createHash('sha1').update(prompt).digest('hex').slice(0, 8);
  return `u_rv_${h}_${p}_${scope.replace(/[^a-z]/gi, '')}${followUp ? '_f' : ''}`;
}

/**
 * 盘上回 `messageId` 的那份**完整**回复（`replyTo` + `replyComplete`）—— 没有就 null。
 * 同一次改写重试时，前面已经答完的那一问（例如 block 档回了「改不了」、升级 patch 那一步才断网）直接用它，
 * 不再发给模型第二遍。先做一次子串查找，绝大多数情况不用解析。
 */
export function completedReplyInText(raw: string, messageId: string): string | null {
  if (!raw || !raw.includes(JSON.stringify(messageId))) return null;
  let hit: string | null = null;
  for (const l of raw.split('\n')) {
    const t = l.trim();
    if (!t) continue;
    try {
      const m = JSON.parse(t);
      if (m?.role === 'assistant' && m.replyTo === messageId && m.replyComplete && typeof m.content === 'string') hit = m.content;
    } catch { /* 写到一半的最后一行 */ }
  }
  return hit;
}

/**
 * 这一轮是不是**正常、完整地**结束了 —— 只有这样的回复才记 `replyComplete`（才算"答过了"）。
 * 被停掉（`cancelled`）、截断（`max_tokens` 等）、卡死被打断（`wedged`）的都是半截：同一条还可以重试。
 * 后端没报 stopReason 的也不算 —— 拿不准就让它能重试，而不是把一条没答完的拒掉。
 */
export function turnCompletedNormally(meta: { stopReason?: string | null; wedged?: boolean }): boolean {
  return !meta.wedged && String(meta.stopReason ?? '').trim() === 'end_turn';
}

/**
 * **重写 transcript 时把回复的去重标记保住**（`replyTo` / `replyComplete`，见 `messageIdStatus`）——
 * 编辑后重跑会拿渲染层手里那一份整份重写（`sessionStore.rewriteTranscript`），而渲染层不是这两项的权威
 * （刚流式出来的那条它根本不知道回的是谁）。丢了的话：网络失败留下的半截会被老记录兼容逻辑当成"答过了"，
 * 原来那次提交续不上；答完的那一问也没法再复用正文（`storedReplyFor`）。
 * 按 id 从盘上原来那一份补回去 —— 传进来的已经带着的不动。纯的：只收原文本。
 */
export function carryReplyMarks<T extends { id?: string; role?: string; replyTo?: string; replyComplete?: true }>(raw: string, messages: readonly T[]): T[] {
  if (!raw || !raw.includes('"replyTo"')) return [...messages];
  const marks = new Map<string, { replyTo: string; replyComplete?: true }>();
  for (const l of raw.split('\n')) {
    const t = l.trim();
    if (!t) continue;
    try {
      const m = JSON.parse(t);
      if (m?.role === 'assistant' && typeof m.id === 'string' && typeof m.replyTo === 'string') {
        marks.set(m.id, { replyTo: m.replyTo, ...(m.replyComplete ? { replyComplete: true as const } : {}) });
      }
    } catch { /* 写到一半的最后一行 */ }
  }
  return messages.map((m) => {
    if (m.role !== 'assistant' || !m.id || m.replyTo !== undefined) return m;
    const k = marks.get(m.id);
    return k ? { ...m, ...k } : m;
  });
}
