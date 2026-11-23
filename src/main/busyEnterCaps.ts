/**
 * **忙时普通 Enter 交给谁** —— 按执行器 initialize 响应里的能力声明定，不按引擎名写死。PURE（`tests/busyEnterCaps.test.ts`）。
 *
 *   · `steer`        kiro：`_session/steer`（fire-and-forget，靠 `steering_consumed` 通知确认，`AcpClient.steer`）
 *   · `steering`     声明了 `_meta.steering.supported`：请求 `_session/steering`，插进正在跑的那一轮（`AcpClient.steering`）
 *   · `prompt-queue` 只声明了 `agentCapabilities._meta.claudeCode.promptQueueing`：一轮在跑时可以再发 `session/prompt`，由 CLI 自己排
 *   · `queue`        都没有：进 KiroLex 自己的队列（这一轮结束后才发）
 *   · `unknown`      claude / codex 的 initialize 结果还没到：**能力未知 ≠ 不支持**。渲染端不缓存它（`steerRoute.cacheableBusyEnter`），
 *                    忙时 Enter 遇到它现问主进程一次；主进程每次挂上执行器（`wireSession`）都推一次 `session:engine-models`。
 *                    以前这里回 `queue`，渲染端把它当成「不支持」缓存住，之后 Claude Code 忙时 Enter 一直进 KiroLex 队列。
 *
 * steering 的声明位置：实测 claude-agent-acp 0.88.0 和 codex-acp 2.1.1 都放在 initialize 响应**顶层**的 `_meta`
 * （和 `agentCapabilities` 同级）；也认 `agentCapabilities._meta.steering`（任务描述里写的位置），两处任一为 true 都算。
 *
 * KiroLex 发 steering 的那一刻这一轮可能刚好结束了：
 *   · 认 `idleBehavior:"promptRequired"` 的（claude-agent-acp 0.88.0）把内容原样退回，KiroLex 当普通消息发；
 *   · 不认的（codex-acp 2.1.1：`dist/index.js` 的 `performSteeringRequest` → `startNewTurnFromExternalPrompt`，不读 `_meta`）
 *     自己起一轮、回 `startedNewTurn`。KiroLex 把那一轮认成这条消息的一轮（主进程 `adoptDetachedTurn`）：
 *     输出、结束、落盘都归它；结束信号是 Codex 的 `session_info_update._meta.codex.threadStatus.type === 'idle'`
 *     （`detachedTurnEnded`）。
 */
export type BusyEnterMode = 'steer' | 'steering' | 'prompt-queue' | 'queue' | 'unknown';

export function busyEnterMode(engine: string | undefined, init: any): BusyEnterMode {
  if (!engine || engine === 'kiro') return 'steer';
  if (!init || typeof init !== 'object') return 'unknown';
  const capsMeta = init?.agentCapabilities?._meta;
  if (init?._meta?.steering?.supported === true || capsMeta?.steering?.supported === true) return 'steering';
  if (capsMeta?.claudeCode?.promptQueueing === true) return 'prompt-queue';
  return 'queue';
}

/** `steering` 不可用了（适配器回了 -32601）往下退一档：还有 promptQueueing 就是它，否则 KiroLex 队列。 */
export function withoutSteering(engine: string | undefined, init: any): BusyEnterMode {
  const m = busyEnterMode(engine, init);
  if (m !== 'steering') return m;
  return init?.agentCapabilities?._meta?.claudeCode?.promptQueueing === true ? 'prompt-queue' : 'queue';
}

/**
 * `_session/steering` 的 prompt：和普通发送（useAcp `sendMessage`）一样的 ContentBlock 组装 ——
 * 带附件时第一块是 `<hidden>file:…</hidden>` 引用块，第二块是正文；只有附件时就只有引用块。
 * 渲染端交过来的是 `steerRoute.steerPayload` 拼好的一段文字（引用块 + 空行 + 正文），这里按同一个格式拆回去。
 */
export function steeringPromptBlocks(message: string): Array<{ type: 'text'; text: string }> {
  const text = (message || '').trim();
  const m = /^(<hidden>[\s\S]*?<\/hidden>)(?:\n\n([\s\S]*))?$/.exec(text);
  if (m && m[1].includes('file:')) {
    const rest = (m[2] || '').trim();
    return rest ? [{ type: 'text', text: m[1] }, { type: 'text', text: rest }] : [{ type: 'text', text: m[1] }];
  }
  return [{ type: 'text', text }];
}

/**
 * 一条 steer 文字（`steerRoute.steerPayload` 拼的：附件引用块 + 空行 + 正文）拆回「气泡里显示的正文 + 附件」——
 * 适配器把它变成单独一轮时（Codex 的 `startedNewTurn`），主进程把它当成一条普通用户消息落盘、显示。
 */
export function steerDisplay(message: string): { text: string; files: Array<{ name: string; path: string; isImage?: boolean }> } {
  const blocks = steeringPromptBlocks(message);
  const head = blocks[0]?.text || '';
  if (!/^<hidden>[\s\S]*<\/hidden>$/.test(head) || !head.includes('file:')) return { text: (message || '').trim(), files: [] };
  const files = Array.from(head.matchAll(/^(?:<hidden>)?file:(.+)$/gm), (m) => m[1].trim()).filter(Boolean).map((p) => ({
    name: p.split(/[\\/]/).pop() || p,
    path: p,
    ...(/\.(png|jpe?g|gif|webp|bmp)$/i.test(p) ? { isImage: true } : {}),
  }));
  return { text: blocks[1]?.text || '', files };
}

/** `_session/steering` 请求的 params。`idleBehavior` 固定 `promptRequired`：没有在跑的一轮时别让适配器自己起一轮
 *  （那一轮的生命周期 KiroLex 拿不到），而是原样退回、由 KiroLex 当普通消息发。 */
export function steeringParams(sessionId: string, message: string) {
  return {
    sessionId,
    prompt: steeringPromptBlocks(message),
    _meta: { steering: { idleBehavior: 'promptRequired' as const } },
  };
}

export type SteeringVerdict =
  /** 插进了当前这一轮 */
  | 'injected'
  /** 适配器没理 promptRequired、自己起了一轮（`startedNewTurn`）：消息已经在它手里（再发一遍就重复），
   *  KiroLex 把那一轮认成这条消息的一轮（主进程 `adoptDetachedTurn`） */
  | 'detached'
  /** 没有在跑的一轮，内容原样退回：改成普通发送 */
  | 'prompt-required'
  /** 请求报错 / 适配器说 failed：退到下一档，不标红、不丢消息 */
  | 'failed';

export function steeringVerdict(result: any, error?: unknown): SteeringVerdict {
  if (error) return 'failed';
  const outcome = result?.outcome;
  if (outcome === 'promptRequired') return 'prompt-required';
  if (outcome === 'injected') return 'injected';
  if (outcome === 'startedNewTurn') return 'detached';
  return 'failed';
}

/** 错误是不是「这个方法根本不存在」—— 那就别再试了，这个执行器以后直接走下一档。
 *  **只认明确的 JSON-RPC -32601**：超时、断线、内部错误（消息里碰巧写着 "method not found" 的也一样）都只是这一次没成，不降级。 */
export function isMethodNotFound(error: any): boolean {
  return error?.code === -32601;
}

/** 日志里的一个值：空白和换行换成 `_`（有的是渲染端报上来的，别让它拼出假日志行），截短 */
function logValue(v: unknown, fallback = '-'): string {
  const s = String(v ?? '').replace(/\s+/g, '_').slice(0, 80);
  return s || fallback;
}

/** 忙时 Enter 最后去了哪：`steered` 插进了这一轮；`handoff` 交给适配器（promptQueueing 排在这一轮后面 / Codex 自己起了一轮）；
 *  `kirolex-queue` KiroLex 自己的队列；另外三种不常见：重建历史后再发、这一轮已结束直接发、steer 失败标红。 */
export type BusyEnterLogRoute = 'steered' | 'handoff' | 'kirolex-queue' | 'after-rebuild' | 'sent-as-new' | 'failed';

/** 每次忙时 Enter 记的那一行（`[prompt] busy-enter …`）：渲染端走完路由后经 `acp:busy-enter-log` 报上来，主进程记。 */
export function busyEnterLogLine(d: { sessionId?: unknown; engine?: unknown; mode?: unknown; route?: unknown; reason?: unknown }): string {
  return `busy-enter sessionId=${logValue(d?.sessionId)} engine=${logValue(d?.engine, 'kiro')} mode=${logValue(d?.mode, 'unknown')}`
    + ` route=${logValue(d?.route)} reason=${logValue(d?.reason)}`;
}

/** `_session/steering` 没插进去的那一行：错误码 / outcome / 退到哪一档（`fallback` 是交回渲染端的 reason）。 */
export function steeringFailureLogLine(sessionId: string, res: { reason?: string; code?: unknown; outcome?: unknown; detail?: string }): string {
  return `steering failed sessionId=${logValue(sessionId)} code=${logValue(res?.code)} outcome=${logValue(res?.outcome)} fallback=${logValue(res?.reason)}`
    + (res?.detail ? ` detail=${String(res.detail).replace(/\s+/g, ' ').slice(0, 200)}` : '');
}

/** 这个执行器的 steering 降级了（`steeringUnavailable` 置位 —— 只在 -32601 时）那一行。 */
export function steeringDegradedLogLine(sessionId: string, engine: string | undefined, code: unknown, now: BusyEnterMode): string {
  return `steering degraded sessionId=${logValue(sessionId)} engine=${logValue(engine, 'kiro')} code=${logValue(code)} busyEnter=${now}`
    + ' —— 这个执行器以后不再试 _session/steering（换后端会话 / 重连后重新按能力声明判断）';
}

/**
 * 适配器自己起的那一轮（`startedNewTurn`）结束了没有 —— 它没有 `session/prompt`，没有响应可等。
 * codex-acp 2.1.1 每一轮开始 / 结束都发 `session_info_update`，`_meta.codex.threadStatus` 是 `{type:'active'}` / `{type:'idle'}`
 * （`dist/index.js` 里 `thread/status/changed` → `createCodexSessionInfoUpdate`），见到 idle 就是这一轮完了。
 */
export function detachedTurnEnded(update: any): boolean {
  return update?.sessionUpdate === 'session_info_update' && update?._meta?.codex?.threadStatus?.type === 'idle';
}
