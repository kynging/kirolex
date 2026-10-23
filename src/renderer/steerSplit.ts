/**
 * 追加指令（steer）怎么显示成**和原消息相邻、但各自独立**的气泡 —— PURE。
 *
 * 记账不动：内存里每条 steer 是带 `steer` 标记的独立用户消息，同属这一轮；盘上它是一条
 * `mergeIntoMessageId` 事件，`readTranscript` 把它折叠进原消息的 `content`（用 `\n` 接上），
 * 同时在 `steerParts` 里记下每一段（见 sessionStore `readTranscriptRaw`）。这里只做两件事：
 *   · 显示时按内存里的 steer、或盘上记下的边界拆回几条；边界和内容对不上（旧数据、被改写过）
 *     就整条当一条显示，不猜、不报错 —— 不能拿 `\n` 去切，原消息自己就可能有很多行；
 *   · 渲染层整份重写 transcript 时，把记下的边界原样写回成 `mergeIntoMessageId` 事件，
 *     盘上格式和 persist-steer 写的一模一样，下一次读回来还能分开。
 */

import { viaFor } from '../main/controlSessions.ts';

export interface SteerPart { id: string; content: string; ts: number }

interface AttachmentLike { id: string; name: string; path: string; isImage?: boolean }

interface TurnMsg<A extends AttachmentLike = AttachmentLike> {
  id: string;
  content: string;
  timestamp: number;
  attachments?: A[];
  steerParts?: SteerPart[];
}

export interface UserBubble<A extends AttachmentLike = AttachmentLike> {
  id: string;
  text: string;
  timestamp: number;
  isSteer: boolean;
  attachments?: A[];
}

/** 盘上 / IPC 来的 `steerParts`，形状不对就当没有。 */
export function asSteerParts(v: unknown): SteerPart[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const ok = v.every((p) => p && typeof p.id === 'string' && typeof p.content === 'string' && Number.isFinite(Number(p.ts)));
  return ok ? v.map((p) => ({ id: p.id, content: p.content, ts: Number(p.ts) })) : undefined;
}

/** 折叠后的 content 拆回「原消息 + 各段 steer」；对不上就 null（整条显示）。 */
export function splitFoldedSteers(content: string, parts: SteerPart[] | undefined): { base: string; parts: SteerPart[] } | null {
  const list = asSteerParts(parts);
  if (!list) return null;
  const suffix = list.map((p) => `\n${p.content}`).join('');
  if (!content.endsWith(suffix)) return null;
  return { base: content.slice(0, content.length - suffix.length), parts: list };
}

/** 这一轮的用户侧气泡：原消息一条，之后每条 steer 各一条（先盘上折叠进来的，再内存里的）。 */
export function userTurnBubbles<A extends AttachmentLike>(base: TurnMsg<A>, steers: TurnMsg<A>[]): UserBubble<A>[] {
  const folded = splitFoldedSteers(base.content, base.steerParts);
  const out: UserBubble<A>[] = [{
    id: base.id,
    text: (folded ? folded.base : base.content).trim(),
    timestamp: base.timestamp,
    isSteer: false,
    attachments: base.attachments,
  }];
  for (const p of folded?.parts || []) {
    const text = p.content.trim();
    if (text) out.push({ id: p.id, text, timestamp: p.ts, isSteer: true });
  }
  for (const s of steers) {
    const text = s.content.trim();
    // 只发了附件、没写字的追加指令也是一条：留着它，气泡里显示它的附件（否则发出去之后界面上什么都看不到）
    if (text || s.attachments?.length) out.push({ id: s.id, text, timestamp: s.timestamp, isSteer: true, attachments: s.attachments });
  }
  return out;
}

/** 一条要写盘的消息：带着可信边界的，拆回「原消息 + mergeIntoMessageId 事件」；其余原样。 */
export function toStoredUserLines<T extends { id: string; role: string; content: string; ts: number; steerParts?: SteerPart[] }>(
  m: T,
): Array<Omit<T, 'steerParts'> | { id: string; role: 'user'; content: string; ts: number; mergeIntoMessageId: string; via?: 'control' | 'session' }> {
  const { steerParts, ...rest } = m;
  const folded = m.role === 'user' ? splitFoldedSteers(m.content, steerParts) : null;
  if (!folded) return [rest];
  return [
    { ...rest, content: folded.base },
    // 经控制入口追加的那段（id 带标记）拆回事件时照样记 via:'control'，和 persist-steer 写的一样
    ...folded.parts.map((p) => ({ id: p.id, role: 'user' as const, content: p.content, ts: p.ts, mergeIntoMessageId: m.id, ...viaFor(p.id) })),
  ];
}
