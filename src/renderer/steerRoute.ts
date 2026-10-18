/**
 * 忙时普通 Enter 的路由 —— PURE（`tests/steerRoute.test.ts`）。
 *
 * 规则：**普通 Enter 在会话忙时永远 steer 当前这一轮**。以前有四条路会把它悄悄变成排队
 * （队列非空并进队尾 / 带附件 / 重建历史中 / steer 失败放队头），用户按的是 Enter、看到的却是一张排队卡片。
 * 现在：
 *   · 队列非空、带附件、带粘贴 → 照样 steer（附件按本机路径写进 steer 文字，和普通消息一样）；
 *   · 重建历史中 → 标「重建历史中，结束后发送」，重建一结束就作为下一条发出；
 *   · steer 失败 → 消息标红，用户自己选「作为下一条发送」或「放回输入框」；
 *     只有「这一轮已经结束」（idle）没有可追加的那一轮了，直接作为新消息发出。
 * 想排队的用 ⌘/Ctrl+Enter（不变）。
 */

export interface SteerAttachmentRef { path: string; name?: string; isImage?: boolean }

/** steer 实际写给模型的文字：附件引用块和普通消息（`handleSendMessage` / `sendQueuedMessage`）一模一样。
 *  图片也走路径 —— 主进程 `acp:steer` 会对文字里的图片路径做 1500px 截边（`capImageRefsInText`）。 */
export function steerPayload(content: string, attachments: SteerAttachmentRef[]): string {
  const text = (content || '').trim();
  if (!attachments.length) return text;
  const refs = `<hidden>${attachments.map((f) => `file:${f.path}`).join('\n')}\n请读取这些文件内容</hidden>`;
  return text ? `${refs}\n\n${text}` : refs;
}

export type SteerFailureRoute = 'send-now' | 'after-rebuild' | 'ask';

/** `acp:steer` 拒绝之后怎么办。 */
export function steerFailureRoute(reason?: string): SteerFailureRoute {
  // 这一轮已经结束：没有「当前这一轮」可追加了，作为新消息发出就是用户要的。
  if (reason === 'idle') return 'send-now';
  // 渲染端还不知道、主进程已经在重建历史：和渲染端自己看到重建时同一条路。
  if (reason === 'priming') return 'after-rebuild';
  return 'ask';
}

/** 失败原因的人话（`t()` 的 key，中文在 `i18nZh/chat.ts`）。 */
export function steerFailureReasonKey(reason?: string): string {
  switch (reason) {
    case 'unsupported': return 'this engine cannot add to a running turn';
    case 'write-failed': return 'could not write to the agent process';
    case 'not-connected': return 'the chat is not connected';
    case 'reconfiguring': return 'the agent is being switched';
    case 'ipc-error': return 'KiroLex could not reach the agent';
    default: return 'unknown reason';
  }
}

/** 忙时普通 Enter 先走哪条路。只看「是不是在重建历史」：队列里有没有东西、带不带附件、有没有粘贴
 *  **都不在判据里** —— 那几样以前各自把 Enter 变成了排队。 */
export function busyEnterRoute(s: { busy?: string | null }): 'steer' | 'after-rebuild' {
  return isRebuildingHistory(s.busy) ? 'after-rebuild' : 'steer';
}

/** 输入框眼里「这一轮在跑」—— 这时普通 Enter 走 steer（`ChatInputBox` 的 `isStreaming`）。
 *  `busy === 'turn'` 是主进程说的，`streaming` 是渲染端的（窗口刷新会丢），两边都问；重建历史也算（steer 那边再停到重建之后）。 */
export function composerRunning(streaming: boolean, busy?: string | null): boolean {
  return streaming || busy === 'turn' || isRebuildingHistory(busy);
}

export type EnterRoute = 'blocked' | 'steer' | 'queue' | 'send';

/**
 * **普通 Enter 最终走哪条路** —— 输入框（`composerRunning` → steer）和 `handleSendMessage`
 * （循环占着 → 不发；后端被占着但不是在跑一轮 → 排队；在跑一轮 → steer）合起来的那一套。
 * 控制入口的 `send` 用的就是它，和你在输入框按 Enter 一模一样；`mode:'next'` 等于 ⌘/Ctrl+Enter（排队）。
 * `occupied` = `isBackendOccupied(busy)`（在 useAcp 里，测试 import 不了，所以由调用方算好传进来）。
 */
export function enterRoute(s: { streaming: boolean; busy?: string | null; occupied: boolean; looping: boolean; next?: boolean }): EnterRoute {
  if (s.looping) return 'blocked';
  if (s.next) return 'queue';
  if (composerRunning(s.streaming, s.busy)) return 'steer';
  if (s.occupied) return 'queue';
  return 'send';
}

/** 正在后台重建历史（隐藏的 priming 轮）—— 这时不能 steer：那一轮是为了恢复上下文，往里塞话会在没有上下文的情况下被回答。 */
export function isRebuildingHistory(busy?: string | null): boolean {
  return busy === 'priming' || busy === 'prime-pending';
}

/** 「重建后发送」的那条放在已有的同类之后、普通排队之前：重建一结束它就是下一条。不改原数组。 */
export function withAfterRebuild<T extends { afterRebuild?: boolean }>(queue: T[], item: T): T[] {
  let at = 0;
  while (at < queue.length && queue[at].afterRebuild) at++;
  return [...queue.slice(0, at), item, ...queue.slice(at)];
}
