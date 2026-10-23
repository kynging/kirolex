/**
 * **编辑重发时让 Claude Code 后端真正「忘掉」被编辑之后的内容** —— 审计 10（`docs/claude-code-feature-audit.md`）。
 *
 * 原来编辑重发只截短 KiroLex 自己的 transcript，在**同一个**后端会话里重发；Claude Code 的会话是持久的，
 * 被编辑掉的那几轮一直留在它的上下文里（重启后 session/load 回来也还在）。
 *
 * 适配器（claude-agent-acp 0.88）的 `session/fork` 可以带一个分叉点：`_meta.jetbrains.air.fork = { version: 1, messageId }`，
 * `messageId` 是某条**助手消息**的 ACP messageId（流式 chunk 上带的那个），分出来的新会话只到那条为止
 * （`forkClaudeSession(..., { upToMessageId })`）。所以每条助手消息落盘时记下它最后一个 messageId 和当时的后端会话 id，
 * 编辑时拿「保留下来的最后一条回复」的那个 id 去分叉。
 *
 * 四条路：
 *   · `fork`：适配器支持带分叉点的 fork、保留部分最后一条回复有锚点、而且锚点就是当前这个后端会话里的；
 *   · `fresh`：保留部分里一条回复都没有（编辑的是第一条）—— 换一个新的后端会话就行，哪家都适用；
 *   · `snapshot`：分不了，但当前后端本来就没被确认握着历史 —— 下一条带的快照是按截短后的记录建的，不用说什么；
 *   · `fallback`：其余情况，照原来的做法重发，并在会话里说「后端仍记得旧内容」。
 * ACP 标准的 fork 请求没有分叉点字段（Codex 的适配器路由了 `session/fork`，但不带点的 fork 等于整份复制），
 * 所以带点的 fork 只对 Claude Code 开。纯函数，不 import electron。
 */
import type { Engine } from './engines.ts';

export interface AnchorMessage {
  id: string;
  role: string;
  kirolex?: boolean;
  /** 这条助手消息最后一个 ACP messageId（主线的，不含子代理） */
  acpMessageId?: string;
  /** 写这条消息时的后端会话 id */
  acpSessionId?: string;
}

export type EditForkReason = 'unsupported' | 'no-anchor' | 'other-backend';
export type EditForkPlan =
  | { mode: 'none' }
  | { mode: 'fork'; messageId: string }
  | { mode: 'fresh' }
  /* 分不了，但这个后端本来就没被确认握着历史（上下文欠着）：下一条会带一份按**截短后**的记录重建的快照，模型看不到被编辑掉的那段 —— 不用说「仍记得」 */
  | { mode: 'snapshot'; reason: EditForkReason }
  | { mode: 'fallback'; reason: EditForkReason };

/** 适配器能不能从某条消息分叉：声明了 `sessionCapabilities.fork`，而且是认得分叉点的那家（Claude Code） */
export function supportsForkPoint(engine: Engine, agentCapabilities: any): boolean {
  return engine === 'claude' && !!agentCapabilities?.sessionCapabilities?.fork;
}

export function planEditFork(input: {
  engine: Engine;
  forkPoint: boolean;
  cliSessionId: string;
  transcript: AnchorMessage[];
  /** 编辑之后保留下来的消息 id（渲染层给的，就是要写回 transcript 的那些） */
  keepIds: Iterable<string>;
  /**
   * 当前这个后端会话有没有被确认握着这条会话的历史（index.ts `contextEstablished`）。不传 = 握着（保守：照样提示）。
   * 实测：重启后 resume 失败、换了新的后端会话 —— 它只会拿到随下一条带过去的快照（截短之后的），根本不记得被编辑掉的那段。
   */
  contextHeld?: boolean;
}): EditForkPlan {
  if (input.engine === 'kiro') return { mode: 'none' };
  const keep = new Set(input.keepIds);
  const replies = input.transcript.filter((m) => keep.has(m.id) && m.role === 'assistant' && !m.kirolex);
  if (!replies.length) return { mode: 'fresh' };
  const cannot = (reason: EditForkReason): EditForkPlan => (input.contextHeld === false ? { mode: 'snapshot', reason } : { mode: 'fallback', reason });
  if (!input.forkPoint) return cannot('unsupported');
  const last = replies[replies.length - 1];
  if (!last.acpMessageId) return cannot('no-anchor');
  if (last.acpSessionId && last.acpSessionId !== input.cliSessionId) return cannot('other-backend');
  return { mode: 'fork', messageId: last.acpMessageId };
}

/** `session/fork` 的 `_meta`：claude-agent-acp 认的分叉点写法（`fork-session.js` 的 `forkPoint`） */
export function forkPointMeta(messageId: string): Record<string, unknown> {
  return { jetbrains: { air: { fork: { version: 1, messageId } } } };
}

/**
 * 整份重写 transcript（编辑后重跑）时把盘上的锚点补回去 —— 渲染层那份消息不带这两个字段，
 * 不补的话第二次编辑就找不到分叉点了（和 `carryReplyMarks` 同一个做法）。
 */
export function carryBackendAnchors<T extends { id?: string; role?: string; acpMessageId?: string; acpSessionId?: string }>(raw: string, messages: readonly T[]): T[] {
  if (!raw || !raw.includes('"acpMessageId"')) return [...messages];
  const anchors = new Map<string, { acpMessageId: string; acpSessionId?: string }>();
  for (const l of raw.split('\n')) {
    const t = l.trim();
    if (!t) continue;
    try {
      const m = JSON.parse(t);
      if (m?.role === 'assistant' && typeof m.id === 'string' && typeof m.acpMessageId === 'string') {
        anchors.set(m.id, { acpMessageId: m.acpMessageId, ...(typeof m.acpSessionId === 'string' ? { acpSessionId: m.acpSessionId } : {}) });
      }
    } catch { /* 写到一半的最后一行 */ }
  }
  return messages.map((m) => {
    if (m.role !== 'assistant' || !m.id || m.acpMessageId !== undefined) return m;
    const a = anchors.get(m.id);
    return a ? { ...m, ...a } : m;
  });
}

/** 这一块是不是主线助手消息的（带 messageId、不是子代理里的）—— 记锚点用 */
export function mainlineAcpMessageId(u: any): string | undefined {
  if (u?.sessionUpdate !== 'agent_message_chunk' && u?.sessionUpdate !== 'agent_thought_chunk') return undefined;
  if (u?._meta?.claudeCode?.parentToolUseId) return undefined;
  return typeof u?.messageId === 'string' && u.messageId ? u.messageId : undefined;
}

/** 渲染层：这条会话编辑重发时要不要先请主进程分叉后端（Claude Code / Codex 才要；kiro、不知道引擎都不要） */
export function wantsEditFork(engine: string | undefined): boolean {
  return engine === 'claude' || engine === 'codex';
}

/**
 * **分叉成功之后，把保留下来的那些回复的锚点改到新的后端会话上** —— 审查意见：原来只换了记录里的 cliSessionId，
 * 盘上那几条回复的 `acpSessionId` 还是旧的后端；整份重写时 `carryBackendAnchors` 又把旧的带回来，于是**连着第二次编辑
 * 同一条消息**必然判成 other-backend、退回普通重发，模型照样记得第一次被换掉的内容。
 *
 * 分出来的会话是旧会话那段历史的拷贝，助手消息的 messageId（API 的 message.id）原样带过去，所以只要把后端 id 换成新的。
 * 只改：保留下来的（`keepIds`）、助手消息、锚点属于被分叉的那个后端（`oldId`）。别的后端来的不动 —— 新会话里没有它们。
 * 输入输出都是 transcript.jsonl 的原文（一行一条）；解析不了的行原样留着。纯函数。
 */
export function remapAnchorsToFork(raw: string, keepIds: Iterable<string>, oldId: string, newId: string): { text: string; changed: number } {
  if (!raw || !oldId || !newId || oldId === newId) return { text: raw, changed: 0 };
  const keep = new Set(keepIds);
  let changed = 0;
  const lines = raw.split('\n').map((line) => {
    if (!line.trim() || !line.includes('"acpSessionId"')) return line;
    let m: any;
    try { m = JSON.parse(line); } catch { return line; }
    if (m?.role !== 'assistant' || !keep.has(m.id) || m.acpSessionId !== oldId) return line;
    changed++;
    return JSON.stringify({ ...m, acpSessionId: newId });
  });
  return { text: lines.join('\n'), changed };
}
