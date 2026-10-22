import { t, type Lang } from './i18n.ts';

/**
 * **分叉 / 复制出来的会话跑在哪台机器上**（审计 10b）—— 跟着源会话，不退回「新会话默认机器」。
 *
 * 原来 `duplicateSession` 只记引擎（F2），不记机器：`pending_dup_*` 首条消息建后端时机器取的是
 * `kirolex-new-chat-remote`，于是一条跑在 tokyo-arm 上的会话分叉出来悄悄跑到了本机 / 另一台机器上，
 * 工作目录、文件、装好的工具全对不上。
 */

/** 侧栏会话行上和机器有关的那几个字段（`listDurableSessions` 带出来的）。 */
export interface ForkSourceTarget {
  remoteId?: string;
  remoteHost?: string;
  remoteMissing?: boolean;
}

/**
 * 分叉时记进 `intendedRemoteRef` 的值。`remoteId: ''` = **明确是本机**（和"没记过"不同：没记过才退回默认机器）。
 *
 * 源会话的机器在设置里已经找不到（或行上只有显示名、认不出是哪台）：照样记原来的那个 id ——
 * 建后端时主进程会报「找不到这台机器、没有替你猜」，而不是换一台跑；`missingHost` 给提示用。
 */
export function forkRemoteIntent(src: ForkSourceTarget): { remoteId: string; missingHost?: string } {
  if (!src.remoteHost && !src.remoteId) return { remoteId: '' };
  if (src.remoteId && !src.remoteMissing) return { remoteId: src.remoteId };
  const remoteId = src.remoteId || src.remoteHost || '';
  return { remoteId, missingHost: src.remoteHost || remoteId };
}

/**
 * 首条消息建后端时用哪台机器：这条 pending 会话记过的优先（记的是本机也算记过），
 * 没记过（侧栏直接开出来、没经过 newSession 的）才用新会话默认机器。
 */
export function firstSendRemoteId(
  intended: ReadonlyMap<string, string>,
  pendingId: string | null | undefined,
  fallback: () => string | undefined,
): string | undefined {
  if (pendingId && intended.has(pendingId)) return intended.get(pendingId) || undefined;
  return fallback();
}

/** 状态行上那句提示的 group：右键改好机器后按它撤掉。 */
export const FORK_MACHINE_MISSING_GROUP = 'fork-machine-missing';

/** 机器已删时在会话里说的那句 —— 说法同主进程 coldRecord 那条（「设置里已经没有这台机器了」），外加怎么改。 */
export function forkMachineMissingText(lang: Lang, host: string): string {
  return t(lang, '⚠ The source chat ran on remote target {host}, which is no longer in your settings. KiroLex did not move this copy to another machine: right-click it → Runs on to pick one before sending.', { host });
}

/** 侧栏会话行上和「分叉记下的机器」有关的字段（行整份存进 `kirolex-sessions`，重启后还在）。 */
export interface ForkRow extends ForkSourceTarget {
  id: string;
  /** 分叉 / 右键记下的首条消息机器：`''` = 明确是本机；没有这个字段 = 没记过。 */
  forkRemoteId?: string;
}

/**
 * **重启后把分叉记下的机器找回来**（审计 10b 复审）—— `intendedRemoteRef` 只活在内存里，
 * 分叉后没发消息就重启，首条消息原来只能退回新会话默认机器：远程分叉跑到别的机器上、本机分叉可能变成远程，
 * 机器已删的那种也绕过了「找不到就拒绝」。会话行本来就整份落盘，所以意图记在行上（`forkRemoteId`），启动时灌回去。
 *
 * 只认还没建后端的 `pending_*` 行、而且真的记过（字段在）的；机器已删的（`remoteMissing`）带上要再提示一次的机器名。
 */
export function restoredForkIntents(rows: ReadonlyArray<ForkRow>): Array<{ id: string; remoteId: string; missingHost?: string }> {
  const out: Array<{ id: string; remoteId: string; missingHost?: string }> = [];
  for (const r of rows) {
    if (!r || !String(r.id).startsWith('pending_') || typeof r.forkRemoteId !== 'string') continue;
    out.push({
      id: r.id,
      remoteId: r.forkRemoteId,
      ...(r.remoteMissing && r.forkRemoteId ? { missingHost: r.remoteHost || r.forkRemoteId } : {}),
    });
  }
  return out;
}
