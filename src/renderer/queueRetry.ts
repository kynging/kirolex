/**
 * **排队消息发失败之后：用同一个 id 再发，而且等一等再发** —— 纯的，`App.tsx` 的排空 effect 用。
 *
 * 1. 原来每次发都现生成 `user_<时间戳>`。发到一半失败（网络断了、自动重发用光）时主进程**已经落过盘**，
 *    条目放回队头、再发一次就又落一条 —— 会话里同一条消息一遍遍出现。现在 messageId 跟着排队条目走，
 *    主进程按它认出"这是同一次提交"（`main/promptDedupe.ts`）：在盘上没答的不再追加，答过的拒绝。
 * 2. 原来失败了放回队头，**下一次渲染**就再发：远端连不上时 attach → preflight 立刻失败（熔断），
 *    队列一变、忙状态一变 effect 就又跑 —— 实测 4 分钟里每 ~100ms 一次，日志刷了 488 行。现在按会话退避。
 *    退避**按会话**记：一条远端会话发不出去，不影响本机会话的队列。
 */

/** 失败第 1、2、3… 次之后等多久再试（封顶 1 分钟，和远端断线重连 `HEAL_BACKOFF_MS` 同一个量级）。 */
export const QUEUE_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];

export function queueRetryDelay(failures: number): number {
  const i = Math.max(0, Math.min(QUEUE_RETRY_MS.length - 1, failures - 1));
  return QUEUE_RETRY_MS[i];
}

const CONTROL_PREFIX = /^(user|steer|queue)_ctl_/;

/**
 * 这一批排队条目发出去时用的 messageId。单条就是它自己的 id；合并的一批由各条 id 拼出来
 * （同一批 → 同一个 id）。以 `queue_` 开头：主进程把它当"你自己发的一条"（`isUserTurnMessageId`）；
 * 里面有经控制入口来的条目时带 `_ctl_` 标记（`isControlMessageId`）。
 */
export function queuedBatchMessageId(items: readonly { id: string }[]): string {
  if (items.length === 1) return items[0].id;
  const viaControl = items.some((it) => CONTROL_PREFIX.test(it.id));
  let h = 0;
  for (const it of items) for (let i = 0; i < it.id.length; i++) h = (Math.imul(h, 31) + it.id.charCodeAt(i)) | 0;
  return `queue_${viaControl ? 'ctl_' : ''}batch_${items.length}_${(h >>> 0).toString(36)}`;
}

/** 每条会话：连着失败了几次、什么时候之前别再试。成功一次就清零。 */
export class QueueBackoff {
  private state = new Map<string, { failures: number; retryAt: number }>();

  /** 记一次失败，返回下一次最早什么时候可以试。 */
  fail(sessionId: string, now: number): number {
    const failures = (this.state.get(sessionId)?.failures || 0) + 1;
    const retryAt = now + queueRetryDelay(failures);
    this.state.set(sessionId, { failures, retryAt });
    return retryAt;
  }

  ok(sessionId: string): void { this.state.delete(sessionId); }

  blocked(sessionId: string, now: number): boolean {
    const s = this.state.get(sessionId);
    return !!s && now < s.retryAt;
  }
}

/**
 * 主进程拒绝的是"这一条已经发过、也答过了"（`DUPLICATE_MESSAGE`）或者"上次已经开始执行（出过字 / 跑过工具）后断了"
 * （`DUPLICATE_STARTED`）—— 错误码过不了 IPC，只能认文字，中英两版都认（主进程按设置的语言出）。
 * 这两种都不该放回队列再发：前一种再发多少次都是同一个结论；后一种再发就是让模型把做过的事再做一遍（要重来点「重跑」）。
 */
export function isDuplicateMessageError(message: string): boolean {
  return /already sent and answered|已经发过、也有回复了|already started running last time|上次已经开始执行/.test(String(message || ''));
}

/**
 * 发失败、放回队头的那一批 —— **重试完成前保持原样**：同一批条目、同一个 messageId。
 *
 * 不保留的话：合并模式下 A 已经落盘、发送失败，退避期间你又排了 B，重试就把 A+B 合成一批、换了个 id，
 * 主进程认不出这是同一次提交，A 又落一次、又发一次；中途切换「合并排队消息」也会换批次、换 id。
 * 所以放回去的每一条都带上 `retryBatch`（落盘在 `kirolex-queues` 里，重启后还在），排空时照它取。
 */
export interface RetryBatch { id: string; size: number }

/**
 * 这一次要发哪几条、用哪个 messageId。队首是一批没发成的（`retryBatch`）且这批还完整（连续、条数对得上）
 * → 原样取它、用原来的 id，不看合并开关、不并进后来排的；否则照常分批（`batch`，即 `queuedBatch`）。
 * 这批被你动过（取消了一张、挪开了）就不再完整 —— 那已经是另一次提交了，按新的一批发。
 */
export function pickQueuedBatch<T extends { id: string; retryBatch?: RetryBatch }>(
  queue: readonly T[],
  merge: boolean,
  batch: (queue: T[], merge: boolean) => T[],
): { items: T[]; messageId: string } {
  const seal = queue[0]?.retryBatch;
  if (seal) {
    let n = 0;
    while (n < queue.length && queue[n].retryBatch?.id === seal.id) n++;
    if (n === seal.size) return { items: queue.slice(0, n), messageId: seal.id };
  }
  let items = batch([...queue], merge);
  /* 后面排着一批没发成的（前面插进来了一条「作为下一条发送」之类）：别把它并进这一批 —— 它要按自己的 id 发 */
  const cut = items.findIndex((item, i) => i > 0 && item.retryBatch);
  if (cut > 0) items = items.slice(0, cut);
  return { items, messageId: queuedBatchMessageId(items) };
}

/** 放回队头时给这一批盖上 `retryBatch`。 */
export function sealRetryBatch<T extends { retryBatch?: RetryBatch }>(items: readonly T[], messageId: string): T[] {
  return items.map((item) => ({ ...item, retryBatch: { id: messageId, size: items.length } }));
}

/** 改了这一批里某一张的文字：那就是另一次提交了，整批去掉 `retryBatch`（不然新文字会顶着旧 id 发出去，记录里还是旧文字）。 */
export function unsealEdited<T extends { id: string; retryBatch?: RetryBatch }>(queue: readonly T[], editedId: string): T[] {
  const seal = queue.find((item) => item.id === editedId)?.retryBatch;
  if (!seal) return [...queue];
  return queue.map((item) => {
    if (item.retryBatch?.id !== seal.id) return item;
    const { retryBatch: _drop, ...rest } = item;
    return rest as T;
  });
}

/**
 * 改一张排队卡片的文字。这张**已经试着发过**（带 `retryBatch`：没发成、放回来的）时，改过的就是**另一次提交**：
 *   · 这一张换一个新 id（`freshId(旧 id)`，调用方负责保留控制入口的标记）—— 用旧 id 发的话，主进程会认成同一次：
 *     盘上留着旧文字、发出去的是新文字；旧的那次要是已经答完了，新文字还会被当成重复直接丢掉；
 *   · 整批去掉 `retryBatch`（`unsealEdited`）—— 这一批已经不是原来那一批了。
 * 没发过的卡片只改文字，id 不动。
 */
export function editQueuedItem<T extends { id: string; content: string; retryBatch?: RetryBatch }>(
  queue: readonly T[],
  editedId: string,
  content: string,
  freshId: (oldId: string) => string,
): T[] {
  const attempted = !!queue.find((item) => item.id === editedId)?.retryBatch;
  return unsealEdited(queue, editedId).map((item) => (
    item.id === editedId ? { ...item, content, ...(attempted ? { id: freshId(item.id) } : {}) } : item
  ));
}

/**
 * **排队那条发出去时插进会话的气泡** —— 按 id 复用：失败的那一批重试时用的是原来的 messageId，而那条用户消息
 * 可能已经在会话里了（上一次已经落盘，窗口重载 / 重新打开会话后从磁盘读回来了）。再插一个就是两个同 id 的气泡。
 * 这一次真插了的那个带 `sendToken`（只活在界面里，不落盘），发送失败时只撤它（`removeOptimistic`），
 * 不动原来就在的那条历史。
 */
export function insertOptimistic<M extends { id: string }>(list: readonly M[], msg: M): M[] {
  return list.some((m) => m.id === msg.id) ? [...list] : [...list, msg];
}

export function removeOptimistic<M extends { id: string; sendToken?: string }>(list: readonly M[], id: string, token: string): M[] {
  return list.filter((m) => !(m.id === id && m.sendToken === token));
}
