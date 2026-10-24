/**
 * **准备时没就绪的转发 MCP 后来好了：等这条会话空闲再重连把它挂上**（接线在 index.ts 的 `reconnectForForward`）。
 *
 * 原来最多看 12 次（3 分钟）：一轮跑得比这久，最后一次看完就不再排，之后会话空闲了工具也不会自己挂上。
 * 现在**一直等到能做或该放弃**：`check` 回 `go` 就做、回 `wait` 过 `intervalMs` 再看、回 `cancel` 就停 ——
 * 只有会话删了 / 退出中 / 这条会话又准备过一遍（那一遍自己等过它）这类情况才 cancel，忙多久都不算。
 *
 * 纯逻辑，计时器可注入（测试用假的）。
 */

export type ReconnectCheck = 'go' | 'wait' | 'cancel';

export const FORWARD_RECONNECT_POLL_MS = 15_000;

/**
 * 这一刻该不该重连：spec 被换掉 / 删了、会话删了、在退出、名字已不在等着的名单里 → `cancel`；
 * 没连着（刚准备完正在连）、这一轮在跑、正在换执行器 → `wait`；否则 `go`。
 */
export function forwardReconnectVerdict(s: {
  specCurrent: boolean; awaiting: boolean; deleted: boolean; quitting: boolean;
  attached: boolean; busy: boolean; reconfiguring: boolean;
}): ReconnectCheck {
  if (!s.specCurrent || !s.awaiting || s.deleted || s.quitting) return 'cancel';
  if (!s.attached || s.busy || s.reconfiguring) return 'wait';
  return 'go';
}

export function retryUntilIdle(
  check: () => ReconnectCheck,
  run: () => void,
  opts: { intervalMs?: number; setTimer?: (fn: () => void, ms: number) => void } = {},
): void {
  const interval = opts.intervalMs ?? FORWARD_RECONNECT_POLL_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const step = (): void => {
    const v = check();
    if (v === 'go') { run(); return; }
    if (v === 'wait') setTimer(step, interval);
  };
  step();
}

/* ------------------------------------------- HTTP 型转发：没探测通过前不交出去，后台按退避一直探 */

/**
 * HTTP 型转发 MCP 探测失败后的重试间隔（负责人 2026-10-24 定）：2s / 5s / 15s / 30s / 60s，之后每 2 分钟。
 * 探测本身不挡会话启动；没通过前它不进 mcpServers / 远端 agent，通过后等会话空闲重连挂上。
 */
export const HTTP_PROBE_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
export const HTTP_PROBE_STEADY_MS = 120_000;

/** 第 `failures` 次失败（从 1 数）之后等多久再探。 */
export function httpProbeDelay(failures: number): number {
  const i = Math.max(1, Math.floor(failures)) - 1;
  return i < HTTP_PROBE_BACKOFF_MS.length ? HTTP_PROBE_BACKOFF_MS[i] : HTTP_PROBE_STEADY_MS;
}

/**
 * 一直探到通过为止：每次结果交给 `onResult`（`failures` = 到这次为止连续失败几次，通过时是之前失败的次数）；
 * 通过就停。每次探之前、拿到结果之后都看 `alive`（spec 换了 / 会话删了 / 在退出 = 不再关心），不活就悄悄停。
 */
export function probeUntilOk<R extends { ok: boolean }>(opts: {
  probe: () => Promise<R>;
  alive: () => boolean;
  onResult: (r: R, failures: number) => void;
  setTimer?: (fn: () => void, ms: number) => void;
}): void {
  const setTimer = opts.setTimer ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  let failures = 0;
  const step = (): void => {
    if (!opts.alive()) return;
    opts.probe().then((r) => r, (e: any) => ({ ok: false, error: String(e?.message || e) }) as unknown as R).then((r) => {
      if (!opts.alive()) return;
      if (!r.ok) failures += 1;
      opts.onResult(r, failures);
      if (!r.ok) setTimer(step, httpProbeDelay(failures));
    });
  };
  step();
}

/**
 * **「探测通过过」只信这么久**：HTTP 上游最近一次被证实是好的（探测通过 / 远端经它转发成功）在这段时间内，
 * 这次准备才直接把它交给执行器。原来是「历史上通过过就交」—— 同一上游后来停了、再开一条会话或重连时，
 * 不可用的地址照样交给适配器，又是 CONNECT_TIMEOUT。过期的按「这次还没探过」处理：先不交，后台探，通过后等空闲重连。
 */
export const HTTP_FRESH_MS = 60_000;

/** 这次准备交不交出去：最近一次证实是好的时刻（没有 = 从没 / 已失效）离现在不超过 `HTTP_FRESH_MS`。 */
export function httpHandedNow(lastOkAt: number | undefined, now: number, freshMs = HTTP_FRESH_MS): boolean {
  return typeof lastOkAt === 'number' && now - lastOkAt >= 0 && now - lastOkAt <= freshMs;
}

/**
 * **一个 HTTP 型转发的后台看护**（接线在 index.ts 的 `watchHttpForwards` / `httpForwardFailed`）。
 * 一直探到通过为止（`probeUntilOk`，退避见上）。起点有两种：会话准备时（`mounted` = 这次交出去了没有），
 * 和**已挂上的上游中途掉线**（远端经它转发失败，`mounted: true`）。
 *
 *   · 没通过：作废「最近证实是好的」（下次准备不再直接交）、登记成等着挂上（`addAwaiting`）、记成当前不可用；
 *     第一次失败说一句（`noticeFailed` 拿到 `mounted`，挂着的和没挂上的说法不同）；
 *   · 通过：记成刚证实是好的；挂着、而且一次都没失败过的，什么都不用做；
 *     其余（没挂上 / 中间失败过）说「已恢复可用」，等会话空闲重连挂上（`reconnect`；远端在这期间又调通了的，
 *     调用方已经把它移出等着的名单，重连自然取消 —— 那就是「按需」）。
 */
export function watchHttpForward<R extends { ok: boolean }>(d: {
  probe: () => Promise<R>;
  alive: () => boolean;
  mounted: boolean;
  markFresh: (ok: boolean) => void;
  addAwaiting: () => void;
  /** 结果记到 spec 上（失败 = 当前不可用，成功 = 清掉）。返回 true = 失败已记下，可以说一句。 */
  noteResult: (r: R) => boolean;
  noticeFailed: (r: R, mounted: boolean) => void;
  noticeBack: () => void;
  reconnect: () => void;
  /** 看护结束（通过了 / 不再关心）。调用方据此允许下一次掉线再起一个看护。 */
  done?: () => void;
  log?: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => void;
}): void {
  probeUntilOk({
    probe: d.probe,
    alive: () => { const a = d.alive(); if (!a) d.done?.(); return a; },
    setTimer: d.setTimer,
    onResult: (r, failures) => {
      if (!r.ok) {
        d.markFresh(false);
        d.addAwaiting();
        if (d.noteResult(r) && failures === 1) d.noticeFailed(r, d.mounted);
        d.log?.(`第 ${failures} 次探测没通过，${httpProbeDelay(failures)}ms 后再探`);
        return;
      }
      d.markFresh(true);
      d.noteResult(r);
      d.done?.();
      if (d.mounted && failures === 0) return;
      d.noticeBack();
      d.reconnect();
    },
  });
}

/**
 * 这条会话的忙碌原因（index.ts `busyReasonFor` 的返回值）挡不挡重连。
 *
 * 判据跟着 `busyReasonFor` 走，而不是只看 `entry.busy` —— 后端自己起的那一轮（Claude Code 的 cron / 后台任务跟进，
 * `autonomousTurn.ts`）跑的时候 `entry.busy` 是 false、`busyReasonFor` 报 `turn`：只看 busy 会在那一轮中间断开执行器、截断它。
 * 只有 `prime-pending`（欠着重建历史、等下一条消息）不挡：重连本来就会接着欠，等它可能要等到用户下次开口。
 */
export function reconnectBlockedBy(reason: string | null | undefined): boolean {
  return !!reason && reason !== 'prime-pending';
}
