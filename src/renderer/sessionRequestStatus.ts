/**
 * **按会话记的「请求进行中 / 失败原因」**（ChatArea 里 Claude Code / Codex 的模型、组合下拉用）。
 *
 * 原来是一格一份的 `busy` / `err`：在 A 发起切换、等待期间这一格换成了 B，A 的请求随后失败，
 * A 的错误就显示在 B 的模型栏上，忙状态也一直挂在 B 上。现在每条会话一份，请求完成时写回
 * **发起它的那条**；界面只读当前会话那一份，切回 A 时 A 的状态原样回来。
 */
import { t, messageVariants, type Lang } from './i18n.ts';

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

/** 点 ✗ 关掉：只清这条会话的错误，进行中的请求（忙）不动；本来就没有错误时原样返回 */
export function dismissErr(map: RequestStatusMap, sid: string): RequestStatusMap {
  return map[sid]?.err ? setErr(map, sid, '') : map;
}

/**
 * **之后成功连上了就清掉 ✗** —— 按会话看：`prev` / `next` 是「连上且后端已挂好」的会话 id
 * （App：执行器挂着、不在连接中，且全局状态是 connected）。从没连上变成连上的那几条，清掉它们的错误。
 * 掉线、还在连、一直连着（切换失败但旧执行器还在）都不清。不看这一格此刻显示的是谁 ——
 * A 失败后切到 B、A 在后台断线又恢复，切回 A 时 ✗ 已经没了。
 */
export function clearErrOnReady(map: RequestStatusMap, prev: readonly string[], next: readonly string[]): RequestStatusMap {
  let out = map;
  for (const sid of next) {
    if (!prev.includes(sid)) out = dismissErr(out, sid);
  }
  return out;
}

export type SwitchWhat = 'model' | 'effort' | 'mode' | 'combo';

/** 主进程的报错本身已经是「换 MCP 配置「x」失败（…）」那一整句时，不再套「切换 MCP 配置失败：」 */
const SAYS_COMBO_FAILED = /^Switching to the MCP profile "[^"]*" failed /;

/**
 * 切换失败时**在会话状态行说的那一句**（✗ 只是个标记，原因要说出来）。
 * 原因 = `cleanIpcError` 去掉 Electron 那层 + `messageVariants` 换成当前语言（主进程 tr() 出来的报错才换，系统原文原样）。
 */
export function switchFailureNotice(what: SwitchWhat, err: unknown, lang: Lang): { text: string; variants: { zh: string; en: string } } {
  const why = cleanIpcError(err);
  const reason = messageVariants(why);
  const say = (l: Lang): string => {
    const r = reason?.[l] ?? why;
    if (SAYS_COMBO_FAILED.test(why) || /^换 MCP 配置「/.test(why)) return `⚠️ ${r}`;
    if (what === 'combo') return t(l, '⚠️ Switching the MCP profile failed: {why}', { why: r });
    if (what === 'effort') return t(l, '⚠️ Switching the effort failed: {why}', { why: r });
    if (what === 'mode') return t(l, '⚠️ Switching the permission mode failed: {why}', { why: r });
    return t(l, '⚠️ Switching the model failed: {why}', { why: r });
  };
  const variants = { zh: say('zh'), en: say('en') };
  return { text: variants[lang], variants };
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
