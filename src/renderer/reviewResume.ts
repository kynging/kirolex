/**
 * **窗口 reload 之后，再提交同一条意见 = 同一次提交** —— 纯的，`ReviewPane` 用（测试 `tests/reviewResume.test.ts`）。
 *
 * reload 时排着 / 在跑的那些会作为"上次没做完"的标记放回来（`loadMarks` 的 `interrupted` / `interruptedTickets`）。
 * 而主进程那一次**没断**：它还在排队、还在等回复。原来你再按一次 ✓，`enqueue` 现生成一张新 ticket，
 * 主进程认不出是同一次，于是同一条意见排了两次、往会话里发了两遍。
 *
 * 现在：打开时先把这些都记成"标记 → ticket + 当时的意见"（跟着标记落盘），再问主进程每张后来怎样了
 * （`review:tickets-status`，见 `TicketStatus`），写完的、模型答了却没做成的摘掉；
 * 再提交**同一个标记、意见一字没改**时用回那张 ticket：还在跑就合并到原来那一次，已经结束（例如 reload 期间断网）
 * 就按同一个 messageId 重试 —— 盘上那条不再追加。
 * 意见改过了就是另一次提交（新 ticket）。已经做完的那些另有 `review:tickets-done` 摘掉，不在这里。
 */

export type Resumable = Record<string, { ticket: string; text: string }>;

/** 从"上次没做完"的那些里挑出主进程那边还活着的。`textOf(key)` 是这个标记放回来时的意见（删除标记是空串）。 */
export function resumableFrom(
  interruptedTickets: Record<string, string>,
  live: ReadonlySet<string>,
  textOf: (key: string) => string | undefined,
): Resumable {
  const out: Resumable = {};
  for (const [key, ticket] of Object.entries(interruptedTickets)) {
    if (!live.has(ticket)) continue;
    const text = textOf(key);
    if (typeof text === 'string') out[key] = { ticket, text };
  }
  return out;
}

/** 这一次提交（标记 `key`、意见 `text`）该用回哪张 ticket；没有就是新的一次。 */
export function resumableTicket(resumable: Resumable, key: string, text: string): string | undefined {
  const hit = resumable[key];
  return hit && hit.text === text ? hit.ticket : undefined;
}

/**
 * **没做成的那一次也还是同一次提交** —— 主进程回 `retrySame`（那一问没拿到完整回复：网络断了、超时、被停掉 / 截断），
 * 意见放回标记 `key` 时记下"这条意见 → 这张 ticket"；你一字不改再点 ✓（含 reload 之后）就用回它（`resumableTicket`）：
 * 同一个 messageId，会话里不再多一条，前面已经答完的那一问也不再问第二遍。改过意见就是新的一次。不改原对象。
 */
export function rememberRetryTicket(map: Resumable, key: string, text: string, ticket: string): Resumable {
  return { ...map, [key]: { ticket, text } };
}

/**
 * 主进程报的一张 ticket 的下落（`review:tickets-status`）：
 *   · `live`    还在排 / 在跑 —— 再提交就合并到那一次；
 *   · `retry`   结束了，但那一问没拿到完整回复（网络断了、超时、被停掉 / 截断），或者回复到了却没人接（窗口不在）；
 *   · `unknown` 主进程不记得（重启过）—— 盘上可能已经有那条用户消息；
 *   · `done`    已经写完盘；
 *   · `final`   模型答了却没做成（格式不对、文件冲突……）—— 再按同一次来只会得到同一个结果。
 * 前三种**沿用原来那张 ticket**：主进程按 messageId 去重，盘上有的不再追加、答完的那一问用盘上的回复，不会再发一遍。
 * 后两种不沿用（`done` 的标记另有 `review:tickets-done` 摘掉；`final` 再提交就是新的一次）。
 */
export type TicketStatus = 'live' | 'retry' | 'unknown' | 'done' | 'final';

export function reusableAfterReload(status: string | undefined): boolean {
  return status !== 'done' && status !== 'final';
}

/**
 * 这张 ticket 不再沿用了：那一次**做成了**，或者模型答了却没做成（`final`，再按同一次来只会得到同一个结果）——
 * 把指向它的那些都摘掉。**只在这两种时候摘**：取走去重试时不摘（`resumableTicket` 只看不动）——
 * 重试途中又没做成（远端还连不上、渲染层读文件失败、你点了取消……）时，这张 ticket 必须还在，
 * 不然下一次提交就换了编号，盘上那条又落一次。不改原对象。
 */
export function forgetRetryTicket(map: Resumable, ticket: string): Resumable {
  const out: Resumable = {};
  for (const [k, v] of Object.entries(map)) if (v.ticket !== ticket) out[k] = v;
  return out;
}

/**
 * 前面的改动落盘、行号挪了（`patch.keep`：旧行号 → 新行号）：可沿用的那些也要**跟着它那一行走** ——
 * 和标记本身（`draftLive`）同一套挪法。不挪的话：第 10 行的意见没做成、放回去了，接着在它前面插了两行，
 * 意见挪到第 12 行；再提交时按第 12 行找不到原来那张 ticket，就换了编号，同一条又落一次、又发一次。
 * `note:页`、`whole` 不随正文挪；那一行没了的就丢掉（标记也丢了）。不改原对象。
 */
export function remapResumable(map: Resumable, keep: Record<number, number>): Resumable {
  const out: Resumable = {};
  for (const [k, v] of Object.entries(map)) {
    const m = /^(\+|=|drop:)?(\d+)$/.exec(k);
    if (!m) { out[k] = v; continue; }
    const to = keep[Number(m[2])];
    if (to) out[`${m[1] || ''}${to}`] = v;
  }
  return out;
}
