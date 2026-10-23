/**
 * 交给适配器排着的那一轮接手时，渲染端的流怎么接 —— PURE（`tests/handoffAdoption.test.ts`）。
 *
 * 主进程交棒时发 `acp:main-turn`（handoff），这时这个窗口自己发的上一轮可能还没收尾（它的 acp:prompt 结果还在路上）。
 * 两件事的先后不定：
 *   · 通常：main-turn → 上一轮收尾（removeStreaming）→ … → busy 不再是 'turn'（接手那一轮结束）；
 *   · 接手那一轮很快就结束：main-turn → busy 不再是 'turn' → 上一轮收尾。
 * 规则：
 *   · main-turn（handoff）到的时候，窗口自己那一轮还在流、也还没在接管 → 记成 pending；
 *   · 上一轮收尾时 pending 还在 → 转成接管，流不断（`keep-streaming`）；
 *   · busy 不再是 'turn' → 接管中的结束；**pending 的也作废**（接手那一轮已经结束了，上一轮收尾时不能再去接管它，
 *     否则流永远收不掉、排队也一直不发）。
 */
export interface AdoptionState {
  /** main-turn（handoff）到了、窗口自己那一轮还没收尾 */
  pending: Set<string>;
  /** 正在接管的（结束信号是 busy 不再是 'turn'） */
  adopted: Set<string>;
}

/** acp:main-turn 带 handoff */
export function onHandoffMainTurn(s: AdoptionState, sid: string, streaming: boolean): 'adopt-now' | 'pending' | 'nothing' {
  if (!streaming) { s.adopted.add(sid); return 'adopt-now'; }
  if (s.adopted.has(sid)) return 'nothing';
  s.pending.add(sid);
  return 'pending';
}

/** busy 变了：不再是 'turn' 时，接管中的那一轮结束（返回要不要收掉流）；pending 的作废 */
export function onBusyChange(s: AdoptionState, sid: string, reason: string | null | undefined): { endAdopted: boolean } {
  if (reason === 'turn') return { endAdopted: false };
  s.pending.delete(sid);
  return { endAdopted: s.adopted.delete(sid) };
}

/** 窗口自己的那一轮收尾（removeStreaming）：pending 的转成接管、流不断；否则照常收掉 */
export function onOwnTurnEnd(s: AdoptionState, sid: string, streaming: boolean): 'keep-streaming' | 'end' {
  if (s.pending.delete(sid) && streaming) {
    s.adopted.add(sid);
    return 'keep-streaming';
  }
  return 'end';
}
