/**
 * **会话卡住 / 被拦 → 「恢复」选择器** —— PURE 判据（主进程和渲染层都直接 import）。
 *
 * 一张卡（ChatArea 的 SafeguardCard）聚合四个出口：换模型 / 换引擎 / 回滚到某条消息 / 换后端会话；
 * 安全过滤那一类再加 Cyber Verification Program 申请链接。
 *
 * 自动弹的条件要**窄**：只在「再试也没用」的死局 ——
 *   · 模型安全过滤的会话级拦截（`safeguardError.isSafeguardBlock`）；
 *   · 压缩失败、这一轮什么都没出（`safeguardError.turnFailureCard` 的 compact-failed）；
 *   · 笼统 `Internal error` 连着到了 `POISONED_AFTER`、自愈（自动重发 / 换后端会话）也试过了还不行（`isStuckDeadEnd`）。
 * 普通一次性报错、网络抖动（本来就自动重发）不弹。用户随时也能从侧栏会话菜单主动调出（不落盘，`renderer/recoveryRequest.ts`）。
 */
import { isBareInternalError, POISONED_AFTER } from './staleSession.ts';
import { isSafeguardBlock, isSafeguardNoteGroup, isCompactNoteGroup, turnFailureCard } from './safeguardError.ts';

/** 「自愈上限之后还是不行」那张卡的 `noteGroup`。 */
export const STUCK_NOTE_GROUP = 'session-stuck';

export function isStuckNoteGroup(group: unknown): boolean {
  return String(group ?? '') === STUCK_NOTE_GROUP;
}

/** 会话里这条 KiroLex 提示画成恢复卡（安全过滤 / 压缩失败 / 卡住）。 */
export function isRecoveryNoteGroup(group: unknown): boolean {
  return isSafeguardNoteGroup(group) || isCompactNoteGroup(group) || isStuckNoteGroup(group);
}

export interface StuckInput {
  /** 这一次的报错原文 */
  error: unknown;
  /** 这条 KiroLex 会话连着几次笼统 Internal error（跨换后端会话累计，成功一轮清零） */
  consecutiveFailures: number;
  /** 自愈已经试过：自动重发预算用光了，或者刚换过后端会话（冷却期内）又是同一个错 */
  selfHealTried: boolean;
  /** 传输层瞬时错误（网络抖动）—— 自动重发管它，不弹卡 */
  transient: boolean;
}

/** 连续失败已经过了自愈的门槛、自愈也试过了还不行 —— 「继续发也没用」。 */
export function isStuckDeadEnd(input: StuckInput): boolean {
  const text = String(input.error ?? '');
  if (!text || input.transient) return false;
  if (isSafeguardBlock(text)) return false;      // 它有自己那一种（safeguard）
  if (!isBareInternalError(text)) return false;
  if ((input.consecutiveFailures || 0) < POISONED_AFTER) return false;
  return !!input.selfHealTried;
}

export type AutoRecoveryCard = 'safeguard' | 'compact-failed' | 'stuck' | null;

/** 一轮报错、**不再自动重发**的那个出口上：要不要自动弹恢复卡、弹哪一种。 */
export function autoRecoveryCard(input: StuckInput & { compactTurn: boolean; produced: boolean }): AutoRecoveryCard {
  const card = turnFailureCard({ error: input.error, compactTurn: input.compactTurn, produced: input.produced });
  if (card) return card;
  return isStuckDeadEnd(input) ? 'stuck' : null;
}

export interface RollbackSource { id: string; role: string; content?: string; kirolex?: boolean; steer?: unknown; pending?: unknown }
export interface RollbackChoice { id: string; role: 'user' | 'assistant'; preview: string; /** 回到这里会去掉后面几条 */ after: number }

const PREVIEW_MAX = 80;

/**
 * 回滚选择器能选的点：真实的用户 / 助手消息（KiroLex 提示、steer、还没落盘的乐观气泡不算 —— 它们不在盘上的记录里
 * 或不是对话本身），最新的在前。`after` = 回到这一条时会从这条会话里去掉的后面几条（只数同样能选的那些）。
 */
export function rollbackChoices(messages: readonly RollbackSource[]): RollbackChoice[] {
  const real = (messages || []).filter((m) => m && m.id && (m.role === 'user' || m.role === 'assistant')
    && !m.kirolex && !m.steer && !m.pending && !String(m.id).startsWith('pending_'));
  const out: RollbackChoice[] = [];
  for (let i = real.length - 1; i >= 0; i--) {
    const m = real[i];
    const flat = String(m.content || '').replace(/\s+/g, ' ').trim();
    out.push({
      id: m.id,
      role: m.role as 'user' | 'assistant',
      preview: flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat,
      after: real.length - 1 - i,
    });
  }
  return out;
}

/**
 * 回滚前整份记录的备份放进回收站（`~/.kirolex/trash/`，30 天后自动清）：`trash/rollback-<时间>/<id>/`。
 * 和卸到云端的 `offload-<时间>/<id>` 一个形状 —— 故意不是删除会话用的 `<id>__<时间戳>`：
 * 那个形状会被认成「这条会话删过」（`cloudTrash.deletionsFromTrashNames`、`sessionStore.findResurrectedShells`）。
 */
export function rollbackBackupDir(sessionId: string, at: Date = new Date()): [string, string] {
  const iso = at.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${iso.slice(20, 23)}`;
  return [`rollback-${stamp}`, sessionId];
}
