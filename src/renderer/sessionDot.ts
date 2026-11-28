export type SessionStatus = 'idle' | 'streaming' | 'unread' | 'dormant' | 'connecting' | 'warm' | 'alert' | 'rebuilding';

export interface DotInputs {
  id: string;
  currentSessionId: string | null;
  /** 主进程报的占用原因（`busyBySession[id]`） */
  busy: string | null | undefined;
  streaming: boolean;
  connecting: boolean;
  failed: boolean;
  unread: boolean;
  attached: boolean;
}

/**
 * 侧栏一条会话的圆点（Sidebar `statusFor`）。
 *
 * Per-session dot priority: streaming (working, any session) > connecting >
 * unread (finished in background) > live (ONLY the current session, and only
 * once its executor is attached) > dormant. Solid green never lingers on an
 * unselected chat — background activity shows as streaming/unread instead.
 */
export function sessionDotStatus(d: DotInputs): SessionStatus {
  const { id, busy } = d;
  // Rebuild states are checked FIRST and get their own light. Two reasons:
  // 'prime-pending' used to fall through to idle/warm, i.e. a STATIC GREEN dot
  // on a chat that is actually locked and owes a rebuild -- the one state that
  // must never look "connected and idle". And 'priming' previously borrowed the
  // normal turn animation, so a rebuild was indistinguishable from a reply.
  if (busy === 'priming' || busy === 'prime-pending') return 'rebuilding';
  if (d.streaming) return 'streaming';
  // Backend occupancy reported by main: the dot must show it even when this
  // renderer has no local streaming/connecting state for that session.
  if (busy === 'turn') return 'streaming';
  /* 压缩还在后台跑（/compact 那一轮已经结束）：照样是在干活 */
  if (busy === 'compacting') return 'streaming';
  if (busy === 'reconfiguring' || busy === 'attaching' || busy === 'creating') return 'connecting';
  if (d.connecting) return 'connecting';
  const attached = d.attached;
  /*
    **连不上 → 红**（在 unread/dormant 之前判）。下面那段注释说的"还没 attach 不该报警"仍然成立 ——
    这里判的不是"没连"，是"连过、失败了"（`failedSessionIds` 只在真的抛错时才加，成功就摘）。
    **已连上 > 失败**：失败之后又连上了（经哪条路都算）就不再红 ——「为什么 agent board 会话现在显示的是红的」。
  */
  if (d.failed && !attached) return 'alert';
  if (d.unread) return 'unread';
  if (id === d.currentSessionId && attached) return 'idle';   // focused + live
  if (attached) return 'warm';                              // background, live/ready
  // Not attached: an archived chat is deliberately inert (neutral). A pending
  // fork/new chat has no backend executor until its first message — that is
  // expected, not an error, so show it neutral (dormant) rather than red alert.
  if (String(id).startsWith('pending_')) return 'dormant';
  // Any other not-yet-attached chat is a NORMAL idle state: it attaches on open
  // (or via background eager-warm), so it must not look broken. Show it neutral
  // (dormant/grey), never the alarming orange 'alert' — attached chats are the
  // only ones that go green (warm/idle).
  return 'dormant';
}
