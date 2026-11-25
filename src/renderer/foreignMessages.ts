/**
 * **别的会话 / 唤醒发来的消息在界面上的几处处理** —— PURE。
 *
 * 用户 2026-11-25：别的会话发来的消息在停止 / 重跑 / 排队时被当成「你自己打的字」处理，体验很差：
 *   · 排队卡片上露着原始来源标记 `⟨session:… · call:…⟩`；撤回它时原文被塞回你的输入框；
 *   · 重跑它时换成了普通 id，之后再中断就被当成你的消息放回输入框。
 * 规则：
 *   · 卡片上显示「📨 来自会话「X」」+ 正文；编辑只改正文，来源那一行（带 call 编号）原样接回去 —— 发起方按编号认回复；
 *   · 带来源标记的文字一律不当草稿（不存、不放回、不接交接）；
 *   · 原样重跑保留来源标记（`rerunIdFor`），改了来源那一行 / 整条换掉就是你自己的消息。
 */

import { hasSessionHeader, parseHeader, splitSessionHeader } from '../main/sessionCalls.ts';
import { rerunIdFor } from './stopSwitchFollowUp.ts';

/** 这段文字带着别的会话的来源标记（任何一行）—— 不能进输入框草稿 */
export function foreignDraftText(text: unknown): boolean {
  return hasSessionHeader(text);
}

/** 排队卡片显示什么：别的会话发来的 → 来源标签 + 正文；否则原样 */
export function queueCardView(content: string): { from: { label: string; sessionId: string } | null; body: string } {
  const split = splitSessionHeader(content);
  if (!split || split.reply) return { from: null, body: content };
  return { from: { label: split.label, sessionId: split.sessionId }, body: split.rest };
}

function firstLine(text: string): string {
  const s = String(text ?? '');
  const nl = s.indexOf('\n');
  return nl >= 0 ? s.slice(0, nl) : s;
}

/** 卡片里编辑的是正文：保存时把原来的来源那一行接回去（call 编号不变） */
export function rejoinQueueEdit(original: string, editedBody: string): string {
  const split = splitSessionHeader(original);
  if (!split || split.reply) return editedBody;
  return `${firstLine(original)}\n${editedBody.trim()}`;
}

/**
 * 消息上的「重跑」用什么 id：别的会话 / 控制入口发来的，来源那一行还在（或原文没动）→ 保留来源标记；
 * 定时 / 后台唤醒 / nudge 的，原文没动 → 保留；否则（你自己的、改成了你自己写的）→ undefined，用普通 id。
 */
export function rerunKeepId(targetId: string, targetContent: string, newText: string, now = Date.now()): string | undefined {
  const same = String(newText ?? '').trim() === String(targetContent ?? '').trim();
  if (/^(user|steer|queue)_(xs|ctl)_/.test(targetId)) {
    const headerKept = !!parseHeader(targetContent) && firstLine(newText) === firstLine(targetContent);
    return same || headerKept ? rerunIdFor(targetId, now) : undefined;
  }
  if (/^(sched_|wake_|nudge_)/.test(targetId)) return same ? rerunIdFor(targetId, now) : undefined;
  return undefined;
}
