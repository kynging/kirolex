/**
 * **按会话记的「请求进行中 / 失败原因」**（ChatArea 里 Claude Code / Codex 的模型、组合下拉用）。
 *
 * 原来是一格一份的 `busy` / `err`：在 A 发起切换、等待期间这一格换成了 B，A 的请求随后失败，
 * A 的错误就显示在 B 的模型栏上，忙状态也一直挂在 B 上。现在每条会话一份，请求完成时写回
 * **发起它的那条**；界面只读当前会话那一份，切回 A 时 A 的状态原样回来。
 */
export type RequestKind = 'engine' | 'combo';
export type SessionRequestStatus = { busy?: Partial<Record<RequestKind, boolean>>; err?: string };
export type RequestStatusMap = Readonly<Record<string, SessionRequestStatus>>;

export function statusFor(map: RequestStatusMap, sid: string | null | undefined): { engineBusy: boolean; comboBusy: boolean; err: string } {
  const s = sid ? map[sid] : undefined;
  return { engineBusy: !!s?.busy?.engine, comboBusy: !!s?.busy?.combo, err: s?.err || '' };
}

function patch(map: RequestStatusMap, sid: string, next: SessionRequestStatus): RequestStatusMap {
  const out: Record<string, SessionRequestStatus> = { ...map };
  const anyBusy = !!(next.busy && Object.values(next.busy).some(Boolean));
  if (!anyBusy && !next.err) delete out[sid];
  else out[sid] = next;
  return out;
}

export function setBusy(map: RequestStatusMap, sid: string, kind: RequestKind, busy: boolean): RequestStatusMap {
  const cur = map[sid] || {};
  return patch(map, sid, { ...cur, busy: { ...cur.busy, [kind]: busy } });
}

export function setErr(map: RequestStatusMap, sid: string, err: string): RequestStatusMap {
  return patch(map, sid, { ...(map[sid] || {}), err });
}

/** 给下拉旁 ✗ 用的说明：去掉 Electron 包的那层「Error invoking remote method …」 */
export function cleanIpcError(err: unknown): string {
  return String((err as any)?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/**
 * 跑一次属于 `sid` 的请求：开始时这条会话记「忙」、清掉它上次的错误；结束（成功 / 失败）都写回 **sid**，
 * 不看此刻这一格是哪条会话。成功的结果要不要上屏由 `onOk` 自己核对（清单只给当前会话看）。
 */
export async function runSessionRequest<R>(
  sid: string,
  kind: RequestKind,
  update: (fn: (map: RequestStatusMap) => RequestStatusMap) => void,
  run: () => Promise<R>,
  onOk: (result: R) => void,
  describeError: (err: unknown) => string,
): Promise<void> {
  update((m) => setErr(setBusy(m, sid, kind, true), sid, ''));
  try {
    onOk(await run());
  } catch (err) {
    update((m) => setErr(m, sid, describeError(err)));
  } finally {
    update((m) => setBusy(m, sid, kind, false));
  }
}
