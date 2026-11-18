/**
 * **一轮结束 / 停止 / 断线时收掉还挂着的权限卡片**（审计 2.1，`docs/engine-audit-claude-codex.md`）。
 *
 * 卡片原来只在点了之后才清：这一轮结束、被停止、执行器断了，卡片还留在屏幕上，`awaitingPermission`（空闲提醒看它）
 * 一直为真，点它答的是一个已经作废的请求 id。纯函数，测试 `tests/engineAuditFixes4.test.ts`。
 */

/** 去掉这条会话的那张卡片；本来就没有就原样返回（不触发重渲染）。 */
export function withoutPermissionCard<T>(cards: Record<string, T>, sid: string): Record<string, T> {
  if (!sid || !Object.prototype.hasOwnProperty.call(cards, sid)) return cards;
  const next = { ...cards };
  delete next[sid];
  return next;
}

/*
 * **每个会话一个待批准队列**（按 requestId）。原来按会话只存一个槽位：模型一次并行两个工具调用（实测两个
 * web_search），第二个请求把第一个盖掉，被盖掉的那个在主进程 `pendingPermissions` 里一直挂着，kiro-cli 等它的
 * 回答，会话卡死。界面一次显示队首那个，答完接着显示下一个。纯函数，测试 `tests/permissionQueue.test.ts`。
 */

interface QueuedOption { optionId: string; kind?: string }
export interface QueuedPermission {
  requestId: number | string;
  sessionId: string;
  /** 「同一工具」的判据（`permissionToolKey`）：「始终」选项据此连带答复 */
  toolKey?: string;
  options: QueuedOption[];
}
export interface PermissionAnswer { requestId: number | string; optionId: string }

/** 同一工具的判据：请求带了工具名就用工具名，否则用标题（kiro 的请求只有 `{ toolCallId, title }`）。宁可少连带，不错连。 */
export function permissionToolKey(update: any, toolTitle: string): string {
  const name = update?.tool?.name || update?.toolName;
  return name ? `name:${name}` : `title:${toolTitle}`;
}

/** 排到这条会话队尾；同一个 requestId 再来一次就原地替换。 */
export function enqueuePermission<T extends QueuedPermission>(queues: Record<string, T[]>, request: T): Record<string, T[]> {
  const sid = request.sessionId;
  const list = queues[sid] || [];
  const at = list.findIndex((r) => r.requestId === request.requestId);
  const next = at >= 0 ? list.map((r, i) => (i === at ? request : r)) : [...list, request];
  return { ...queues, [sid]: next };
}

/** 每条会话当前显示的那一个（队首），带上后面还排着几个。 */
export function currentPermissions<T extends QueuedPermission>(queues: Record<string, T[]>): Record<string, T & { queuedBehind: number }> {
  const out: Record<string, T & { queuedBehind: number }> = {};
  for (const [sid, list] of Object.entries(queues)) {
    if (list.length) out[sid] = { ...list[0], queuedBehind: list.length - 1 };
  }
  return out;
}

function withQueue<T>(queues: Record<string, T[]>, sid: string, list: T[]): Record<string, T[]> {
  if (list.length) return { ...queues, [sid]: list };
  const next = { ...queues };
  delete next[sid];
  return next;
}

const ALWAYS_KINDS = new Set(['allow_always', 'reject_always']);

/**
 * 答了一个：从队列里去掉。选的是「始终」（allow_always / reject_always）时，同一会话里同一工具的其它请求
 * 按同一种选项一并答复（`alsoAnswer`，由调用方发给主进程）；对方没有这种选项的留着让人答。
 */
export function settlePermission<T extends QueuedPermission>(
  queues: Record<string, T[]>, sid: string, requestId: number | string, optionId: string,
): { queues: Record<string, T[]>; alsoAnswer: PermissionAnswer[] } {
  const list = queues[sid] || [];
  const answered = list.find((r) => r.requestId === requestId);
  if (!answered) return { queues, alsoAnswer: [] };
  const kind = answered.options.find((o) => o.optionId === optionId)?.kind;
  const alsoAnswer: PermissionAnswer[] = [];
  const rest = list.filter((r) => {
    if (r.requestId === requestId) return false;
    if (!kind || !ALWAYS_KINDS.has(kind) || !answered.toolKey || r.toolKey !== answered.toolKey) return true;
    const same = r.options.find((o) => o.kind === kind && o.optionId === optionId)
      || r.options.find((o) => o.kind === kind);
    if (!same) return true;
    alsoAnswer.push({ requestId: r.requestId, optionId: same.optionId });
    return false;
  });
  return { queues: withQueue(queues, sid, rest), alsoAnswer };
}

/** 允许选项（和主进程 auto-approve 的 `pickPermissionOption(options, true)` 同一顺序，但不拿别的选项凑数）。 */
function allowOption(options: QueuedOption[]): QueuedOption | undefined {
  return options.find((o) => o.kind === 'allow_once')
    || options.find((o) => o.kind === 'allow_always')
    || options.find((o) => o.kind?.startsWith('allow'));
}

/** 会话切到「自动」：这条会话挂着的请求全部按允许答复；没有允许选项的不替人拒，留着。 */
export function allowAllPermissions<T extends QueuedPermission>(
  queues: Record<string, T[]>, sid: string,
): { queues: Record<string, T[]>; answers: PermissionAnswer[] } {
  const list = queues[sid] || [];
  const answers: PermissionAnswer[] = [];
  const rest = list.filter((r) => {
    const allow = allowOption(r.options);
    if (!allow) return true;
    answers.push({ requestId: r.requestId, optionId: allow.optionId });
    return false;
  });
  if (!answers.length) return { queues, answers };
  return { queues: withQueue(queues, sid, rest), answers };
}
