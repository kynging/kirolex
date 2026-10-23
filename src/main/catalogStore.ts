/**
 * **catalog.json 的并发写** ——「恢复页里点恢复报『桶里没有 <id> 的文件』」。
 *
 * 实测（2026-10-23，桶 kyn-files）：catalog 33 条，`v1/sessions/` 下只有 15 条有文件；多出的 18 条
 * 全是用户自己点「删除备份」删掉的，文件已删（delete marker），catalog 条目却还在。原因是 catalog 的
 * 「读 — 改 — 整份写回」没有并发保护（lost update）：
 *
 *   · 删除用的是开头读到的快照，写回「快照 − 这次的 id」—— 连点几次删除，后一次的快照里还有前一次
 *     刚删的条目，写回就把它们复活了；
 *   · 定时同步开头读、最后整份写，期间别的删除 / 别的机器写的都被覆盖。
 *
 * 这里的做法：
 *
 *   1. **每次写之前重新读最新的再改**（`updateCatalog`）：改动是一个函数，作用在刚读到的那份上；
 *      写带 S3 条件（If-Match 刚读到的 ETag / 桶里还没有时 If-None-Match: *），别人抢先写过 → 重读、重改、再写；
 *   2. **删除进 catalog 成为删除记录**（`Tombstone`，带时间）。合并时删除记录比条目新就不许条目复活 ——
 *      别的机器拿着旧条目来写也一样；只有之后**真的又上传过**（`uploadedAt > at`）才算回来；
 *   3. 同一台机器上对 catalog 的操作走一个队列（`serialQueue`）串行 —— 不支持条件写的 S3 兼容存储上也不互相覆盖；
 *   4. 桶里没文件的条目：恢复页标出来；同步时有删除记录或 delete marker 的自动从 catalog 移除（`dropDeadEntries`）。
 *
 * 不 import electron、S3 操作经 `CatalogBucket` 注入 —— 测试用内存里的假桶跑端到端。
 */

import type { Catalog, CatalogEntry, Tombstone } from './s3Sync.ts';
import { catalogKey, joinPrefix, LAYOUT, mergeCatalog } from './s3Sync.ts';

/** 删除记录留多久。过了这么久，还拿着那条旧条目来写的机器也早该同步过了。 */
export const TOMBSTONE_KEEP_MS = 365 * 86_400_000;
/** 条件写连着冲突这么多次就放弃这一次（没有覆盖对方）。 */
export const MAX_CATALOG_TRIES = 6;

/* 只有点的（`.` / `..`）不算 id —— 拼进 key 会跳出这条会话的前缀 */
const SAFE_ID = /^(?!\.+$)[\w.-]{1,120}$/;

export const emptyCatalog = (): Catalog => ({ version: 1, entries: [] });

/** 解析 catalog 文本；坏了 / 格式不对就抛（写之前读不懂，不能当空的整份盖掉）。 */
export function parseCatalog(text: string): Catalog {
  const c = JSON.parse(text);
  if (!c || typeof c !== 'object' || !Array.isArray(c.entries)) throw new Error('catalog 的格式不对');
  return c as Catalog;
}

/** 这条条目的文件最后一次真的上传的时刻（老条目没有 → 0）。 */
export const uploadedAtOf = (e: CatalogEntry): number => Number(e.uploadedAt) || 0;

/**
 * 按删除记录收拾一遍：删除记录比条目新（`at >= uploadedAt`）→ 条目去掉；条目之后又真的上传过 → 记录作废。
 * 同一个 id 的多条记录留最新的；太老的记录丢掉。别的字段原样带着。
 */
export function normalizeCatalog(c: Catalog, now = Date.now()): Catalog {
  const tomb = new Map<string, number>();
  for (const t of c.deleted || []) {
    if (!t || typeof t.id !== 'string' || !SAFE_ID.test(t.id)) continue;
    const at = Number(t.at) || 0;
    if (at <= 0 || now - at > TOMBSTONE_KEEP_MS) continue;
    tomb.set(t.id, Math.max(tomb.get(t.id) || 0, at));
  }
  const entries: CatalogEntry[] = [];
  for (const e of c.entries || []) {
    const at = tomb.get(e.id);
    if (at === undefined) { entries.push(e); continue; }
    if (uploadedAtOf(e) > at) { entries.push(e); tomb.delete(e.id); }   // 删除之后真的又传过 → 回来
  }
  entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const deleted: Tombstone[] = [...tomb].map(([id, at]) => ({ id, at }));
  const out: Catalog = { ...c, version: 1, entries };
  if (deleted.length) out.deleted = deleted; else delete out.deleted;
  return out;
}

/**
 * 给这几条写删除记录（`at` = 删除时刻）并去掉它们的条目。
 * 同一个 id 已经有更晚的删除记录就留那条 —— 两台机器交错删除时，较早开始、较晚写入的那次
 * 不能把删除时间改小（改小了，夹在两次删除之间上传的旧条目就会复活）。
 */
export function withTombstones(c: Catalog, ids: Iterable<string>, at: number): Catalog {
  const gone = new Set(ids);
  const prev = new Map<string, number>();
  for (const t of c.deleted || []) if (gone.has(t.id)) prev.set(t.id, Math.max(prev.get(t.id) || 0, Number(t.at) || 0));
  const deleted = [...(c.deleted || []).filter((t) => !gone.has(t.id)), ...[...gone].map((id) => ({ id, at: Math.max(at, prev.get(id) || 0) }))];
  return { ...c, entries: (c.entries || []).filter((e) => !gone.has(e.id)), deleted };
}

/** 读写 catalog 那一个对象。`cond === null`：桶不认条件写（或没给 ETag），只能直接写。 */
export interface CatalogIO {
  get(): Promise<{ text: string; etag: string } | null>;
  put(text: string, cond: { ifMatch: string } | { ifNoneMatch: '*' } | null): Promise<'ok' | 'conflict'>;
}

export interface UpdateResult { catalog: Catalog; before: Catalog; attempts: number }

/**
 * **读最新的 → 改 → 条件写，冲突就重来**。`mutate` 每次都作用在**刚读到的**那份上（可能被调好几次，别在里面做不可重复的事）。
 * 读不懂的 catalog：默认抛（`onCorrupt: 'throw'`）；同步那一路沿用原来的做法当空的（`'empty'`）。
 */
export async function updateCatalog(
  io: CatalogIO,
  mutate: (c: Catalog) => Catalog | Promise<Catalog>,
  opts: { onCorrupt?: 'throw' | 'empty'; now?: () => number; tries?: number } = {},
): Promise<UpdateResult> {
  const now = opts.now || Date.now;
  const tries = opts.tries || MAX_CATALOG_TRIES;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const got = await io.get();
    let before = emptyCatalog();
    if (got) {
      try { before = parseCatalog(got.text); }
      catch (err) {
        if (opts.onCorrupt !== 'empty') throw err;
        /* 读不懂、当空的重建：记下重建的时刻 —— 重建前的设备清单丢了，云端自动清理要据此停一阵（见 cloudTrash.ts 的 rebuiltAt） */
        before = { ...emptyCatalog(), rebuiltAt: now() };
      }
    }
    before = normalizeCatalog(before, now());
    const next = normalizeCatalog(await mutate(before), now());
    const cond = got ? (got.etag ? { ifMatch: got.etag } : null) : { ifNoneMatch: '*' as const };
    if (await io.put(JSON.stringify(next, null, 2), cond) === 'ok') return { catalog: next, before, attempts: attempt };
  }
  throw new Error(`catalog 连着 ${tries} 次写之前都被别处抢先改了，这一次没写（没有覆盖对方），稍后再试`);
}

/** 只读：拿最新的 catalog（已按删除记录收拾过）。桶里还没有 → null；读不懂 → 抛。 */
export async function readCatalog(io: CatalogIO, now = Date.now()): Promise<Catalog | null> {
  const got = await io.get();
  return got ? normalizeCatalog(parseCatalog(got.text), now) : null;
}

/**
 * 一个串行队列：`run(fn)` 等前面的都跑完再跑 fn。前面的失败不影响后面的。
 * **不要在 fn 里再 run 同一个队列** —— 会自己等自己。
 */
export function serialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn, fn);
    tail = p.then(() => undefined, () => undefined);
    return p;
  };
}

/**
 * 本机这一轮要写进 catalog 的条目用哪个 `uploadedAt`：这一轮真传过的用这一轮的时刻；没传的用上次**真传完**的时刻
 * （marks 的 `uploadedAt`）。marks 的 `at` 是整轮结束的时刻，不可信 —— 老的 marks 只有它，就不给（有删除记录时按删除更新算）。
 */
export function entryUploadedAt(
  id: string, thisRound: ReadonlyMap<string, number>, marks: Record<string, { uploadedAt?: number } | undefined>,
): number | undefined {
  return thisRound.get(id) ?? (Number(marks[id]?.uploadedAt) || undefined);
}

/** 存进 marks 的一条：`at` = 这一轮的时刻（界面上的"最后同步"），`uploadedAt` = 真传完的时刻。 */
export function syncMark(at: number, updatedAt: number, uploadedAt?: number): { at: number; updatedAt: number; uploadedAt?: number } {
  return uploadedAt ? { at, updatedAt, uploadedAt } : { at, updatedAt };
}

/* ------------------------------------------------------------------ 桶操作 */

/** catalog 用到的桶操作（index.ts 用真 S3 接，测试用内存里的假桶）。 */
export interface CatalogBucket {
  get(key: string): Promise<{ body: Buffer; etag: string } | null>;
  /** 条件写；桶不认条件写时调用方自己退回普通写。 */
  put(key: string, body: Buffer, cond: { ifMatch: string } | { ifNoneMatch: '*' } | null): Promise<'ok' | 'conflict'>;
  /** 一个前缀下所有对象的 key。 */
  list(prefix: string): Promise<string[]>;
  del(key: string): Promise<void>;
  /** `<prefix>v1/sessions/` 下有文件的会话 id（一次 list 的 CommonPrefixes）。 */
  sessionIds(): Promise<Set<string>>;
  /**
   * 这条会话的文件是什么时候被删掉的：桶开了版本控制、最新版本是 delete marker → 那个时刻；
   * 还有活的对象 → `'live'`；看不出来（没开版本控制 / 没权限）→ null。
   */
  deletedAt(sessionId: string): Promise<number | 'live' | null>;
}

export function catalogIO(bucket: CatalogBucket, prefix: string | undefined): CatalogIO {
  const key = catalogKey(prefix);
  return {
    get: async () => { const g = await bucket.get(key); return g ? { text: g.body.toString('utf-8'), etag: g.etag } : null; },
    put: (text, cond) => bucket.put(key, Buffer.from(text, 'utf-8'), cond),
  };
}

/** 某条会话在桶里的前缀（和 `sessionPrefix` 一样）。 */
export const sessionKeyPrefix = (prefix: string | undefined, id: string): string => `${joinPrefix(prefix)}${LAYOUT}/sessions/${id}/`;

/** CommonPrefixes（`…/v1/sessions/<id>/`）→ 会话 id。 */
export function sessionIdsFromPrefixes(prefix: string | undefined, commonPrefixes: string[]): Set<string> {
  const head = `${joinPrefix(prefix)}${LAYOUT}/sessions/`;
  const out = new Set<string>();
  for (const p of commonPrefixes) {
    if (!p.startsWith(head)) continue;
    const id = p.slice(head.length).replace(/\/+$/, '');
    if (id && SAFE_ID.test(id)) out.add(id);
  }
  return out;
}

/**
 * **删掉几条会话的备份**：先删对象，最后 catalog 写删除记录（重读最新的再写）。
 * 先写 catalog 的话中途失败会留下"指向已删对象"的目录 —— 但现在就算那样，下一轮同步也会按 delete marker 清掉。
 */
export async function deleteSessionBackups(
  bucket: CatalogBucket, prefix: string | undefined, ids: Iterable<string>, now?: number,
): Promise<{ deleted: number; failed: string[]; catalog: Catalog; at: number }> {
  const gone = [...new Set(ids)].filter((id) => SAFE_ID.test(id));
  let deleted = 0;
  const failed: string[] = [];
  for (const id of gone) {
    for (const key of await bucket.list(sessionKeyPrefix(prefix, id))) {
      try { await bucket.del(key); deleted += 1; }
      catch (err: any) { failed.push(`${key}: ${err?.message || err}`); }
    }
  }
  /*
    删除记录的时刻 = 文件**真删完**的时刻，不是开始删的时刻：同步的上传不在 catalogQueue 里，
    「开始删 → 同步传完 → 这边把刚传的也删了」时，用开始时刻会让那次上传显得比删除新，条目复活、文件却没了。
    （测试可以传固定的 now。）
  */
  const at = now ?? Date.now();
  const { catalog } = await updateCatalog(catalogIO(bucket, prefix), (c) => withTombstones(c, gone, at), { now: () => Math.max(at, Date.now()) });
  return { deleted, failed, catalog, at };
}

/**
 * 桶里没有文件的那些条目：有删除记录的已经被 `normalizeCatalog` 收掉了，剩下的问一下 delete marker。
 * 返回 id → 删除时刻（看不出来是 0）。`present`：有文件的会话 id。
 */
export async function missingEntries(
  bucket: CatalogBucket, catalog: Catalog, present: Set<string>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const missing = (catalog.entries || []).filter((e) => !present.has(e.id));
  await Promise.all(missing.map(async (e) => {
    let at: number | 'live' | null = null;
    try { at = await bucket.deletedAt(e.id); } catch { at = null; }
    if (at === 'live') return;                         // list 之后刚传上来的
    out.set(e.id, typeof at === 'number' ? at : 0);
  }));
  return out;
}

/**
 * **同步那一轮写 catalog**：重读最新的，并进本机这一轮的条目，顺手把「桶里没文件、而且有 delete marker」的
 * 条目移掉（一次性清理老版本留下的那些，`removed` 里带回来写日志）。本机这一轮刚传的条目不动。
 */
export async function writeSyncCatalog(
  bucket: CatalogBucket, prefix: string | undefined, fresh: CatalogEntry[], now = Date.now(),
  /** 同一次写里再改一点（云端自动清理：并进本机的现存会话清单，见 cloudTrash.ts）。作用在合并之后的那份上，每次重试都重做。 */
  decorate?: (c: Catalog) => Catalog,
): Promise<UpdateResult & { removed: Array<{ id: string; title: string; deletedAt: number }> }> {
  let present: Set<string> | null = null;
  try { present = await bucket.sessionIds(); } catch { present = null; }   // 列不出来就不清理，照常写
  let candidates: Array<{ id: string; title: string; deletedAt: number }> = [];
  const r = await updateCatalog(catalogIO(bucket, prefix), async (latest) => {
    /*
      **catalog 不见了、桶里却已经有备份 / 云端回收站** → 当成重建处理，记 rebuiltAt（和读不懂时一样）：
      各设备的清单都没了，云端自动清理要停一阵（见 cloudTrash.ts）。全新的桶（什么都没有）不算。
    */
    if (latest.rebuiltAt === undefined && !(latest.entries || []).length && !latest.devices && !(latest.deleted || []).length) {
      let hasData = !!present?.size;
      if (!hasData) { try { hasData = (await bucket.list(`${joinPrefix(prefix)}${LAYOUT}/trash/`)).length > 0; } catch { hasData = true; } }
      if (hasData) latest = { ...latest, rebuiltAt: now };
    }
    let next = mergeCatalog(latest, fresh);
    if (decorate) next = decorate(next);
    candidates = [];
    if (present) {
      /*
        没文件、有 delete marker 的写删除记录（时刻 = marker 的时刻）。本机这一轮的条目也一样对待 ——
        本机还留着本地副本、却没重新上传的那条（uploadedAt 早于 marker）也该清；这一轮真的重传过的，
        uploadedAt 晚于 marker，normalizeCatalog 会留下它。
      */
      const byId = new Map(next.entries.map((e) => [e.id, e]));
      const dead = await missingEntries(bucket, next, present);
      for (const [id, at] of dead) {
        if (at > 0) candidates.push({ id, title: byId.get(id)?.title || id, deletedAt: at });
      }
      /* 只加记录、不直接去掉条目 —— 去不去由 normalizeCatalog 按「谁新」判 */
      if (candidates.length) next = { ...next, deleted: [...(next.deleted || []), ...candidates.map((c) => ({ id: c.id, at: c.deletedAt }))] };
      /*
        **桶里没有文件、又有删除记录的，不凭上传时间复活**：uploadedAt 晚于删除记录说明"删完之后传过"，
        但文件此刻不在（比如传完又被那次删除删掉了），而桶没开版本控制 / 没权限时上面的 marker 也看不到。
        这时去掉条目、留着删除记录；之后真的重新传上来，文件在了，下一轮照常回来。
      */
      const tombs = new Map((next.deleted || []).map((t) => [t.id, t.at]));
      const stale = [...dead.keys()].filter((id) => tombs.has(id) && byId.has(id));
      if (stale.length) {
        const s = new Set(stale);
        for (const id of stale) if (!candidates.some((c) => c.id === id)) candidates.push({ id, title: byId.get(id)?.title || id, deletedAt: tombs.get(id) || 0 });
        next = { ...next, entries: next.entries.filter((e) => !s.has(e.id)) };
      }
    }
    return next;
  }, { onCorrupt: 'empty', now: () => now });
  const kept = new Set(r.catalog.entries.map((e) => e.id));
  return { ...r, removed: candidates.filter((c) => !kept.has(c.id)) };
}

/**
 * **从目录里移除**（恢复页那颗按钮 / 点恢复时发现没文件）：只移桶里确实**没有文件**的条目，写删除记录（时刻 = 现在）。
 * 还有文件的不动 —— 那是一份真的备份，不能因为界面上点了一下就从目录里藏起来。
 */
export async function forgetMissingEntries(
  bucket: CatalogBucket, prefix: string | undefined, ids: string[], now = Date.now(),
): Promise<{ removed: string[]; kept: string[] }> {
  const want = [...new Set(ids)].filter((id) => SAFE_ID.test(id));
  const removed: string[] = [];
  const kept: string[] = [];
  for (const id of want) ((await bucket.list(sessionKeyPrefix(prefix, id))).length ? kept : removed).push(id);
  if (removed.length) await updateCatalog(catalogIO(bucket, prefix), (c) => withTombstones(c, removed, now), { now: () => now });
  return { removed, kept };
}

/** 恢复页：给每条标上「桶里还有没有文件」（没有 → `missing: true`，带删除时刻；看不出来是 0 → 不带）。 */
export function markMissing<T extends { id: string }>(entries: T[], missing: Map<string, number>): Array<T & { missing: boolean; deletedAt?: number }> {
  return entries.map((e) => {
    const at = missing.get(e.id);
    return at === undefined ? { ...e, missing: false } : { ...e, missing: true, ...(at > 0 ? { deletedAt: at } : null) };
  });
}
