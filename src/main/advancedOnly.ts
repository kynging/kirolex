/**
 * **这条会话属于 kirolex-advanced，标准版不显示也不碰** ——「防止两版串」。
 *
 * 两版共用 `~/.kirolex`。advanced 会在 `record.json` 里写 `purpose`：`flow-main`（flow 自己的主会话）、
 * `flow-worker`（flow 的步骤）、`skill`（画布带的临时会话）。标准版自己**从不**写这三种，所以带了其中之一
 * 就等于"这条是 advanced 的"：标准版对它聊天、移动、归档、删除、同步，都会和 advanced 那边打架。
 *
 * 判据只有这一份 —— `listSessions()` 用它把这类记录藏起来，按 id 的入口用它拒绝。纯函数，不 import 任何东西。
 */
export const ADVANCED_ONLY_PURPOSES: readonly string[] = ['flow-main', 'flow-worker', 'skill'];

export function isAdvancedOnly(rec: { purpose?: unknown } | null | undefined): boolean {
  const p = rec?.purpose;
  return typeof p === 'string' && ADVANCED_ONLY_PURPOSES.includes(p.trim());
}

/**
 * **云上的备份是不是 advanced 的会话** —— 本机没有这条记录时，只能看桶里那份 `record.json`
 * （catalog 里不带 purpose）。`fetchRecord` 由调用方注入：找不到返回 null，读失败就抛。
 *
 * 结果分两类，给恢复页和删除备份用：
 *   · `advanced`   —— 读到了、是 advanced 的：恢复页不列，删除备份时跳过；
 *   · `unreadable` —— 读失败 / 内容坏了 / id 形状不对：**不知道是谁的就不删**（列表照常显示，恢复时还会再判）。
 * 桶里根本没有 record.json 的（null）两类都不算 —— 那不是一条能认出主人的会话。
 */
export async function findAdvancedBackups(
  ids: Iterable<string>,
  fetchRecord: (id: string) => Promise<Buffer | string | null>,
  concurrency = 8,
): Promise<{ advanced: Set<string>; unreadable: Set<string> }> {
  const advanced = new Set<string>();
  const unreadable = new Set<string>();
  const queue = [...new Set(ids)];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) { unreadable.add(id); continue; }
      let raw: Buffer | string | null;
      try { raw = await fetchRecord(id); } catch { unreadable.add(id); continue; }
      if (raw === null || raw === undefined) continue;
      let rec: unknown;
      try { rec = JSON.parse(raw.toString()); } catch { unreadable.add(id); continue; }
      if (isAdvancedOnly(rec as { purpose?: unknown })) advanced.add(id);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return { advanced, unreadable };
}

/**
 * **恢复一份备份之前，确认它不是 advanced 的会话** —— `s3:restore` 用。
 *
 * `recordKey` 是备份里 record.json 的 key（备份里没有就是 null：认不出主人，照旧放行）。
 * 读失败 / 内容坏了 = `unreadable`：**确认不了用途就不恢复**，而不是当成"不是 advanced"放过去 ——
 * 否则第一次读失败、恢复循环里再读一次成功，advanced 的记录就被写进本机了。
 * 放行时带回读到的那份字节，调用方写盘就用它，不再读第二次。
 */
export async function vetBackupRecord(
  recordKey: string | null,
  get: (key: string) => Promise<Buffer>,
): Promise<{ ok: true; record: Buffer | null } | { ok: false; reason: 'unreadable' | 'advanced' }> {
  if (!recordKey) return { ok: true, record: null };
  let body: Buffer;
  try { body = await get(recordKey); } catch { return { ok: false, reason: 'unreadable' }; }
  let rec: unknown;
  try { rec = JSON.parse(body.toString('utf-8')); } catch { return { ok: false, reason: 'unreadable' }; }
  if (isAdvancedOnly(rec as { purpose?: unknown })) return { ok: false, reason: 'advanced' };
  return { ok: true, record: body };
}
