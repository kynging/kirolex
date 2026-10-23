/**
 * **交给适配器、排在当前这一轮后面的那一轮** —— 忙时 Enter 的两种情形（判据和来历见 `busyEnterCaps.ts`）：
 *
 *   · `queued`   适配器声明了 promptQueueing：一轮在跑时就把下一条的 `session/prompt` 发出去，由 CLI 自己排。
 *                CLI 一条一条跑，前一个 `session/prompt` 的响应就是前一轮的结束，之后流过来的输出属于这一条
 *                （`AcpClient` 给每条输出标上当时最老的在途 prompt id —— `promptId`）。
 *   · `detached` `_session/steering` 发出去的时候这一轮刚好结束了，适配器自己起了一轮（Codex 回 `startedNewTurn`）。
 *                那一轮没有 `session/prompt` 可等，结束信号是 `busyEnterCaps.detachedTurnEnded`。
 *
 * 主进程（index.ts `sendPromptOnce` 的 handoff 模式）把它当成**正常的一轮**跑：用户消息在前一轮落盘之后才落盘、
 * 输出 / 结束 / 看门狗 / 自动重发 / 落盘都归这一条。还没轮到它的时候，属于它的输出先攒着（`held`），
 * 轮到它、这一轮的计数清零之后再按原顺序交给同一个处理函数 —— 一条都不丢、不串到前一轮里。
 *
 * PURE（`tests/followUpTurns.test.ts`）：只管「这条输出归谁」「下一个该谁」，不碰进程和磁盘。
 */
export interface FollowUp {
  kind: 'queued' | 'detached';
  /** 这一轮的用户消息 id */
  messageId: string;
  /** `queued`：那个在途的 session/prompt 的 id（`AcpClient.lastPromptId`） */
  promptId?: number;
  /** 轮到它之前收到的、属于它的输出（按收到的顺序） */
  held: any[];
  /** 已经接手（前一轮交棒了） */
  started: boolean;
  /** 这一轮的计数已经清零、攒着的输出已经交出去：之后的输出直接处理。接手到这一刻之间还要接着攒，否则顺序会乱 */
  live: boolean;
  /** 前一轮收尾时**同步**调用：接手 busy、落盘用户消息、告诉界面 */
  begin: () => void;
  /** 等不到接手了（执行器没了 / 前一轮没法交棒）：让那一轮的 sendPromptOnce 报错收场 */
  abort: (err: Error) => void;
  /** `detached`：收到结束信号 / 执行器没了 */
  endDetached?: (result: any) => void;
  failDetached?: (err: Error) => void;
}

/** sendPromptOnce 的 handoff 模式要的东西 */
export type HandoffSpec =
  /** 一轮在跑时再发一个 session/prompt（发出去之后 `onAccepted` 回话；没发成也回话，渲染端据此退回 KiroLex 队列） */
  | { kind: 'queued'; onAccepted: (r: { accepted: boolean; reason?: string }) => void }
  /** 适配器自己起的那一轮：字节已经发过了；`held` 是在它登记之前就到了的输出 */
  | { kind: 'detached'; held: any[]; onEnlisted?: () => void };

/** handoff 不成立（这一轮已经结束 / 正在重建历史 / 适配器不支持）：调用方按 `reason` 改走别的路，消息不丢 */
export class HandoffRefused extends Error {
  readonly reason: 'idle' | 'priming' | 'unsupported';
  constructor(reason: 'idle' | 'priming' | 'unsupported') {
    super(`handoff refused: ${reason}`);
    this.reason = reason;
  }
}

export interface FollowUpHost {
  followUps?: FollowUp[];
  /** `_session/steering` 请求还在途的条数（结果可能是 `startedNewTurn` —— 那就要有一个 detached 接手） */
  steeringInFlight?: number;
  /** 没标 prompt 的输出的暂存处：前一轮已经收尾、还在等 steering 的结果，或者 steering 刚回了「适配器自己起了一轮」、
   *  那一轮还没登记好。这段时间流过来的不可能属于前一轮（它的响应已经到了） */
  limbo?: { held: any[] };
}

/** 还没轮到、排在最前面的那一个 */
export function nextFollowUp(host: FollowUpHost): FollowUp | undefined {
  return host.followUps?.find((f) => !f.started);
}

/** 前一轮收尾时要不要把 busy 留着（有人要接手，或者还在等 steering 的结果） */
export function keepsBusy(host: FollowUpHost): boolean {
  return !!nextFollowUp(host) || (host.steeringInFlight || 0) > 0;
}

/**
 * 这条输出要不要先攒着、攒给谁。
 *   · 带 `promptId`、而那个 prompt 是一个还没接手完（`live`）的 `queued` → 攒给它；
 *   · 没带 `promptId`（没有在途的 session/prompt —— 前一轮的响应已经到了）、而有一个还没轮到的 `detached`，
 *     或者前一轮收完了在等 steering 结果（`limbo`）→ 攒给它 / limbo。那时这条输出不可能属于前一轮。
 * 其余照常处理（返回 null）。
 */
export function holdTarget(host: FollowUpHost, data: { promptId?: number } | null | undefined, promptInFlight: boolean): FollowUp | { held: any[] } | null {
  const waiting = host.followUps?.filter((f) => !f.live) || [];
  if (data && data.promptId !== undefined) {
    return waiting.find((f) => f.kind === 'queued' && f.promptId === data.promptId) || null;
  }
  if (promptInFlight) return null;
  const detached = waiting.find((f) => f.kind === 'detached');
  if (detached) return detached;
  if (host.limbo) return host.limbo;
  /*
    前一个 session/prompt 的响应已经到了（这个判断是同步的：AcpClient 收到响应就摘掉它），而 steering 还在途 ——
    这时流过来的只可能是适配器自己起的那一轮（Codex 的 startedNewTurn）。主进程那一轮的收尾是异步的、还没来得及
    建 limbo，所以在这里就建：同一次管道读取里紧跟着响应来的输出也不会算进前一轮的缓冲。
  */
  if ((host.steeringInFlight || 0) > 0) return (host.limbo = { held: [] });
  return null;
}

/** 摘掉一个（接手的那一轮结束了，或者放弃了） */
export function dropFollowUp(host: FollowUpHost, f: FollowUp): void {
  if (!host.followUps) return;
  host.followUps = host.followUps.filter((x) => x !== f);
  if (!host.followUps.length) host.followUps = undefined;
}

/** 适配器自己起的那一轮（detached）的用户消息 id：由那条 steer 的 id 推出来（`steer_…` → `user_…_turn`），
 *  主进程落盘、渲染端报给控制入口都用它。控制入口发的保留 `_ctl_` 标记（controlSessions.isControlMessageId 只看前缀）。 */
export function detachedTurnMessageId(steerId: string): string {
  return `${steerId.replace(/^steer_/, 'user_')}_turn`;
}

/** 交棒要用到的那部分会话状态（index.ts 的 SessionEntry 满足它） */
export interface FollowUpEntry extends FollowUpHost {
  busy?: boolean;
  /** sendPromptOnce 的那一轮还没走到最外层收尾：它收尾时会交棒 */
  turnRunning?: boolean;
  lastUsedAt?: number;
  cliSessionId: string;
  client: { sendPrompt(sessionId: string, prompt: any[]): Promise<any>; lastPromptId?: number };
  replayUpdates?: (list: any[]) => void;
}

/** 交棒时要做的副作用（index.ts 按会话给） */
export interface FollowUpDeps {
  /** 这个 entry 还是不是这条会话当前的执行器 */
  isCurrent: () => boolean;
  /** busy 变了，告诉界面 */
  emitBusy: () => void;
  /** busy 放开之后（应用忙时记下的切换） */
  afterRelease?: () => void;
  log?: (line: string) => void;
  notConnected: () => Error;
}

/**
 * 登记一轮排在当前这一轮后面的，返回时它已经接手（前一轮交棒了）。
 *   · `queued`：现在就把 session/prompt 发出去（CLI 自己排），记下它的 id —— 属于它的输出按这个 id 先攒着；
 *   · `detached`：字节早就由 `_session/steering` 发出去了，它没有响应，结束信号是 `busyEnterCaps.detachedTurnEnded`
 *     （调用方收到时调 `endDetached`）。
 * `onBegin` 在前一轮收尾时**同步**执行（落盘用户消息、告诉界面）：那一刻前一轮的回复已经落盘，顺序就对了。
 * 没轮到它就失败了（执行器没了 / 适配器拒了）→ 拒绝，错误上带 `handoffNotStarted`：这条消息还没落盘、也没上界面，
 * 调用方把它放回 KiroLex 队列。
 */
export function enlistFollowUp(entry: FollowUpEntry, spec: HandoffSpec, prompt: any[], messageId: string, onBegin: () => void, deps: FollowUpDeps): Promise<{ followUp: FollowUp; response: Promise<any> }> {
  return new Promise((resolveStart, rejectStart) => {
    let response!: Promise<any>;
    let endDetached: ((r: any) => void) | undefined;
    let failDetached: ((err: Error) => void) | undefined;
    const f: FollowUp = {
      kind: spec.kind,
      messageId,
      held: spec.kind === 'detached' ? spec.held.splice(0) : [],
      started: false,
      live: false,
      begin: () => {
        if (f.started) return;
        f.started = true;
        entry.busy = true;
        try { onBegin(); } catch (err: any) { deps.log?.(`handoff begin side effect failed: ${err?.message || err}`); }
        deps.log?.(`handoff BEGIN kind=${f.kind} messageId=${messageId} held=${f.held.length}`);
        resolveStart({ followUp: f, response });
      },
      abort: (err: Error) => {
        dropFollowUp(entry, f);
        if (!f.started) { rejectStart(Object.assign(err, { handoffNotStarted: true })); return; }
        failDetached?.(err);
      },
    };
    if (spec.kind === 'queued') {
      try {
        response = entry.client.sendPrompt(entry.cliSessionId, prompt);
      } catch (err: any) {
        spec.onAccepted({ accepted: false, reason: 'write-failed' });
        rejectStart(err);
        return;
      }
      f.promptId = entry.client.lastPromptId;
      response.catch((err) => { if (!f.started) f.abort(err instanceof Error ? err : new Error(String(err))); });
    } else {
      response = new Promise((res, rej) => { endDetached = res; failDetached = rej; });
      f.endDetached = (r: any) => endDetached?.(r);
      f.failDetached = (err: Error) => failDetached?.(err);
    }
    (entry.followUps ||= []).push(f);
    if (spec.kind === 'detached') spec.onEnlisted?.();
    deps.log?.(`handoff ENLISTED kind=${f.kind} messageId=${messageId} promptId=${f.promptId ?? '-'} busy=${!!entry.busy}`);
    if (spec.kind === 'queued') spec.onAccepted({ accepted: true });
    /* 前一轮已经收完（在等 steering 结果的 limbo 里，或者干脆已经空闲）：没人会来交棒，自己接手 */
    if (!entry.turnRunning && nextFollowUp(entry) === f) handOverTurn(entry, deps);
  });
}

/**
 * 一轮收尾（busy 还留着）：下一个排着的接手；还在等 steering 结果就先进 limbo；都没有就放开 busy。
 * 攒在 limbo 里的输出：有 detached 接手就归它（排在它登记之后攒的前面），否则按原样交给处理函数
 * （这时 busy 已经放开，一轮之外的照旧由 replayGuard 判）。
 */
export function handOverTurn(entry: FollowUpEntry, deps: FollowUpDeps): void {
  if (!deps.isCurrent()) {
    /* 执行器换掉了：排着的那几条接不上了，放弃（渲染端把它们放回 KiroLex 队列） */
    for (const f of [...(entry.followUps || [])]) f.abort(deps.notConnected());
    entry.limbo = undefined;
    return;
  }
  const next = nextFollowUp(entry);
  if (next) {
    if (next.kind === 'detached' && entry.limbo) {
      next.held = [...entry.limbo.held, ...next.held];
      entry.limbo = undefined;
    }
    next.begin();
    return;
  }
  if ((entry.steeringInFlight || 0) > 0) {
    entry.limbo ||= { held: [] };
    return;
  }
  const held = entry.limbo?.held || [];
  entry.limbo = undefined;
  entry.busy = false;
  entry.lastUsedAt = Date.now();
  deps.emitBusy();
  if (held.length) entry.replayUpdates?.(held);
  deps.afterRelease?.();
}
