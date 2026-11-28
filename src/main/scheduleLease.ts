/**
 * **定时任务：哪台在线就由哪台跑**（用户 2026-11-28，推翻「只有固定的 runner 跑、别的电脑手动接管」）。纯逻辑，桶操作经注入。
 *
 * ## 租约
 * 每个任务在桶里有一个租约对象 `schedules/<sessionId>/<id>.lease.json`：`{ holder, name, expiresAt, run }`。
 * 到点时，有资格的电脑去抢**这一次**：租约不存在 → `If-None-Match: *` 创建；已过期 → `If-Match: <读到的 ETag>` 覆盖。
 * 写成功才跑；412 = 别人抢到了，本机这一次不跑。跑的过程中每 60 秒续约（If-Match），租约 5 分钟；跑完释放。
 *
 * ## 同一个计划时刻只跑一次
 * 运行状态里记 `lastRunFor`（这一次的计划时刻）。抢到租约后先把桶里最新的状态并进来：已经有人跑过这一次（或已经不到点了）
 * → 释放、不跑。跑的那台**先记账、先把状态传上去**，再叫醒会话 —— 它中途死了，下一台看得到「这一次已经跑过」。
 *
 * ## 拿不到 S3（离线 / 凭证失败 / 会话没开跨电脑同步）
 * 只有建任务的那台（`creator`，老任务的 `runner` 当它用）照旧在本机跑，别的电脑一律不跑 —— 免得断网时两台各跑一次。
 *
 * ## 安全
 * 资格（`eligible`）由调用方判：会话在本机、开了跨电脑同步（或本机就是建它的那台），**并且本机确认过这份定义**
 * （`schedule-approved.json` 按 `definitionHash`）。桶里来的、或被改过定义的任务，确认之前不参与抢租约。
 */

import { MIN_INTERVAL_SEC, dueAt, isDue, scheduleTerminal, type ScheduleState } from './schedule.ts';
import { SCHEDULES_REL, definitionHash, type ScheduleMachine } from './scheduleSync.ts';

/** 租约时长：跑的那台失联后，最多这么久别的电脑就能接手。 */
export const LEASE_MS = 5 * 60_000;
/** 跑的过程中多久续一次约。 */
export const LEASE_RENEW_MS = 60_000;
/**
 * 离租约到期还剩这么点时间就当已经不持有了：续约一直失败（网络断了）时，最后一次成功拿到的租约一过期，别的电脑就能接手 ——
 * 本机不能再记账、传状态、叫醒会话。留一点余量，免得卡在到期那一刻两边都以为是自己的。
 */
export const LEASE_SAFETY_MS = 15_000;

export interface Lease {
  /** 抢到的那台的设备 ID。 */
  holder: string;
  /** 它的主机名（只显示）。 */
  name: string;
  expiresAt: number;
  /** 这一次的计划时刻（「立即运行一次」= 点的那一刻）。 */
  run: number;
}

/** 桶里的租约对象（相对布局根，`/` 分隔）。 */
export function leaseRel(sessionId: string, id: string): string {
  return `${SCHEDULES_REL}/${sessionId}/${encodeURIComponent(id)}.lease.json`;
}

/** `leaseRel` 的逆；不是租约对象 = null。 */
export function parseLeaseRel(rel: string): { sessionId: string; id: string } | null {
  const parts = rel.split('/');
  if (parts.length !== 3 || parts[0] !== SCHEDULES_REL || !parts[1] || !parts[2].endsWith('.lease.json')) return null;
  try {
    const id = decodeURIComponent(parts[2].slice(0, -'.lease.json'.length));
    return id ? { sessionId: parts[1], id } : null;
  } catch { return null; }
}

export function parseLease(text: string): Lease | null {
  let o: any;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (typeof o.holder !== 'string' || !o.holder || o.holder.length > 200 || !n(o.expiresAt) || !n(o.run)) return null;
  return { holder: o.holder, name: typeof o.name === 'string' ? o.name.slice(0, 200) : '', expiresAt: o.expiresAt, run: o.run };
}

/** 租约还有效（没过期）吗。 */
export function leaseActive(lease: Lease | null | undefined, now: number): lease is Lease {
  return !!lease && lease.expiresAt > now;
}

/** 桶的条件写入（S3：PUT 带 If-Match / If-None-Match，412 = 条件不满足）。 */
export interface LeaseBucket {
  get(key: string): Promise<{ body: string; etag: string } | null>;
  /** 条件不满足（412）→ `{ ok: false }`；网络 / 权限错误照常抛。 */
  putIf(key: string, body: string, cond: { ifMatch: string } | { ifNoneMatch: '*' }): Promise<{ ok: true; etag: string } | { ok: false }>;
  /** 只在 ETag 还是这个时删（释放租约）。 */
  del(key: string, etag: string): Promise<void>;
}

export type Acquired = { ok: true; etag: string; lease: Lease } | { ok: false; heldBy: Lease | null };

/**
 * **抢这一次的租约**：没有 → If-None-Match 创建；有但过期了（或就是本机自己的）→ If-Match 覆盖；别人的、还有效 → 抢不到。
 * 条件写入失败（别人同时抢到了）→ 抢不到。网络错误照常抛（调用方按离线处理）。
 */
export async function acquireLease(b: LeaseBucket, key: string, me: ScheduleMachine, run: number, now: number): Promise<Acquired> {
  const lease: Lease = { holder: me.id, name: me.name, expiresAt: now + LEASE_MS, run };
  const body = JSON.stringify(lease);
  const cur = await b.get(key);
  if (!cur) {
    const r = await b.putIf(key, body, { ifNoneMatch: '*' });
    return r.ok ? { ok: true, etag: r.etag, lease } : { ok: false, heldBy: await currentHolder(b, key) };
  }
  const held = parseLease(cur.body);
  if (leaseActive(held, now) && held.holder !== me.id) return { ok: false, heldBy: held };
  const r = await b.putIf(key, body, { ifMatch: cur.etag });
  return r.ok ? { ok: true, etag: r.etag, lease } : { ok: false, heldBy: await currentHolder(b, key) };
}

async function currentHolder(b: LeaseBucket, key: string): Promise<Lease | null> {
  try { const cur = await b.get(key); return cur ? parseLease(cur.body) : null; } catch { return null; }
}

/** 续约：If-Match 上一次的 ETag，成功给新的 ETag；条件不满足（被别人覆盖了）= 失去租约。 */
export async function renewLease(b: LeaseBucket, key: string, etag: string, lease: Lease, now: number): Promise<{ ok: true; etag: string; lease: Lease } | { ok: false }> {
  const next = { ...lease, expiresAt: now + LEASE_MS };
  const r = await b.putIf(key, JSON.stringify(next), { ifMatch: etag });
  return r.ok ? { ok: true, etag: r.etag, lease: next } : { ok: false };
}

/**
 * **这一次的计划时刻**：按原来的锚点（上次运行 / 建任务时）数到现在、最近一个 ≤ now 的应跑时刻 —— 错过好几次也只认最近这一次
 * （开机补跑只补一次）。几台电脑拿着同一份状态算出同一个时刻；`once` 就是 `atEpoch`。没到点的 = 下一次应跑的时刻。
 */
export function plannedRunFor(state: ScheduleState, now: number): number {
  const spec = state.spec;
  const first = dueAt(spec, state.lastRunAt, state.createdAt);
  if (spec.kind === 'once') return Number(spec.atEpoch ?? 0);
  if (spec.kind === 'interval') {
    const period = Math.max(MIN_INTERVAL_SEC, spec.everySec) * 1000;
    const start = state.lastRunAt === null ? state.createdAt : first;
    if (start > now) return start;
    return start + Math.floor((now - start) / period) * period;
  }
  if (first > now) return first;
  let t = first;
  for (let i = 0; i < 10_000; i += 1) {
    const next = dueAt(spec, t, state.createdAt);
    if (next > now) break;
    t = next;
  }
  return t;
}

/** 建任务的那台（离线时只有它跑）：`creator`，老任务没有就用原来的 `runner`。 */
export function creatorOf(state: ScheduleState): string | undefined {
  return state.creator || state.runner || undefined;
}

/**
 * 交给 `run` 的这一次：`lost()` = 已经不持有了（记账 / 传状态 / 叫醒之前看）；`offline` = 断网兜底（只有建它的那台在跑）——
 * 这时用本机记账，**不要求**把「这一次跑过了」传到桶里（桶本来就连不上），见 `commitCharge`。
 */
export interface RunLease { lost(): boolean; offline: boolean }

export interface AttemptDeps {
  me: ScheduleMachine;
  now(): number;
  /** 这个任务能不能用桶抢租约：null = 不能（S3 没开 / 取不到凭证 / 会话没开跨电脑同步）→ 只有建它的那台在本机跑。 */
  bucket: LeaseBucket | null;
  leaseKey: string;
  /** 本机有资格跑它吗（会话在本机、开了跨电脑同步或本机建的、**定义本机确认过**）。 */
  eligible(state: ScheduleState): boolean;
  readLocal(): ScheduleState | null;
  /** 桶里最新的那份（看这一次是不是已经有人跑过）。没有 = null。 */
  fetchRemote(): Promise<ScheduleState | null>;
  /** 把桶里那份并进本机，返回合并结果。 */
  adopt(remote: ScheduleState): ScheduleState;
  /** 把撤销了「没确认送达」那次记账的状态写回本机（`restorePending` 的结果）。 */
  persist?(state: ScheduleState): void;
  /**
   * 真的跑（检查命令 → 记账带 `lastRunFor` → 先传状态 → 叫醒会话；检查命令「输出没变、不叫醒」的那次也要记上 `lastRunFor` 并传上去）。
   * `lease.lost()`：已经不持有这一次了（被覆盖，或续约一直失败、租约过期）—— 记账 / 传状态 / 叫醒之前都要看一眼。
   * 返回之前该传的都要传完：之后租约就放开了。
   */
  run(state: ScheduleState, runFor: number, lease: RunLease): Promise<void>;
  /** 定时器（续约）：返回取消函数。 */
  every(ms: number, fn: () => void): () => void;
  log(message: string): void;
  /** 「▶ 立即运行一次」：不看到没到点、不看这一次跑没跑过（暂停 / 结束 / 过期 / 次数用完由调用方先挡）。 */
  manual?: boolean;
}

/**
 * 记账时带上「还没确认送达」（叫醒会话之前传上去的就是这份）：这一次的计划时刻、谁记的、记之前的次数和时刻（`restorePending` 撤销用）。
 */
export function markPendingRun(state: ScheduleState, before: ScheduleState, runFor: number, me: ScheduleMachine, now: number, preCheck: ScheduleState = before): ScheduleState {
  /* 次数 / 计划时刻按记账之前；检查的结论按检查命令跑之前（preCheck）—— 没有检查命令的两者一样 */
  return {
    ...state,
    pendingRun: {
      runFor, by: me.id, at: now,
      prev: {
        runs: before.runs, lastRunAt: preCheck.lastRunAt, lastRunFor: before.lastRunFor ?? null,
        lastCheckHash: preCheck.lastCheckHash ?? null, lastCheck: preCheck.lastCheck ?? null, checkErrors: preCheck.checkErrors ?? 0,
        terminal: preCheck.terminal ?? null, autoPaused: state.pausedBy === 'check-errors' && !preCheck.paused,
      },
    },
  };
}

/**
 * 「已经交给会话了」（真的发出去之前先传上去的那一步）：标记 `sent`，并记成本机**这一刻**写的新状态（`statusAt`）——
 * 别的电脑先缓存了「还没交出去」的那一版，合并时也认得出这一版更新（`mergeSchedule` 另外保证同一个计划时刻 sent 不会被合并回未发送）。
 */
export function markSent(state: ScheduleState, me: ScheduleMachine, now: number): ScheduleState {
  if (!state.pendingRun) return state;
  return { ...state, pendingRun: { ...state.pendingRun, sent: true }, statusBy: me.id, statusAt: now };
}

/**
 * 撤销一次「记了账、没确认送达」的记账：次数、时刻、计划时刻、**这一次检查的结论**（指纹、最后一次检查、出错次数、达成目标的终态）
 * 回到那一次之前，标记清掉 —— 这一次又「到点」了，接手的电脑会重新检查、重新汇报。用户期间按的暂停 / 改的过期时间不动；
 * 只有这一次检查自己触发的自动暂停（还是 `check-errors` 那个）才一起解除。
 */
export function restorePending(state: ScheduleState): ScheduleState {
  const p = state.pendingRun;
  if (!p) return state;
  const out: ScheduleState = { ...state, runs: p.prev.runs, lastRunAt: p.prev.lastRunAt, lastRunFor: p.prev.lastRunFor, pendingRun: null };
  if ('lastCheckHash' in p.prev) out.lastCheckHash = p.prev.lastCheckHash ?? null;
  if ('lastCheck' in p.prev) out.lastCheck = p.prev.lastCheck ?? null;
  if ('checkErrors' in p.prev) out.checkErrors = p.prev.checkErrors ?? 0;
  if ('terminal' in p.prev) out.terminal = p.prev.terminal ?? null;
  if (p.prev.autoPaused && out.pausedBy === 'check-errors') { out.paused = false; out.pausedBy = null; }
  return out;
}

/**
 * 「记了账、没确认送达」挂了超过一个租约时长：记它的那台要么还在跑（一直续约，别人抢不到）、要么已经失去这一次 ——
 * 本机这份虽然不「到点」，也该去试着抢一次租约（抢到了就撤销那次记账、自己跑）。
 */
export function pendingStale(state: ScheduleState, now: number): boolean {
  return !!state.pendingRun && now - state.pendingRun.at > LEASE_MS;
}

export type AttemptResult = 'ran' | 'offline-ran' | 'not-eligible' | 'not-due' | 'held' | 'already-ran' | 'offline-not-creator' | 'blocked' | 'deleted';

/** 暂停了 / 结束了 / 过期了 / 次数用完了：这些时候谁都不该跑它（「立即运行一次」也不行）。不挡 = null。 */
export function runBlocker(state: ScheduleState, now: number): string | null {
  if (state.paused) return '已暂停';
  const terminal = scheduleTerminal(state, now);
  return terminal ? `已结束（${terminal}）` : null;
}

/**
 * **到点了，本机试着跑这一次**（调度器每一跳 / 开机 / 唤醒 / 「立即运行一次」都走这里）。返回结果（给日志和测试看）。
 */
export async function attemptScheduleRun(id: string, deps: AttemptDeps): Promise<AttemptResult> {
  const now = deps.now();
  const local = deps.readLocal();
  if (!local) return 'not-due';
  if (!deps.eligible(local)) return 'not-eligible';
  if (!deps.manual && !isDue(local, now) && !pendingStale(local, now)) return 'not-due';
  let runFor = deps.manual ? now : plannedRunFor(restorePending(local), now);
  const offline = async (why: string): Promise<AttemptResult> => {
    /*
      **按盘上最新的那份重新判**（等网络的这段时间里，同步可能删了它、换了定义）：删了就不跑（不拿开头那份旧的顶上）；
      离线只有建它的那台跑；最新的定义本机得确认过 —— 不然一个没确认的 checkCommand 会在本机 shell 里跑起来
    */
    const disk = deps.readLocal();
    if (!disk) { deps.log(`skip id=${id} run=${runFor}: ${why}；任务已经删了，不跑`); return 'deleted'; }
    if (creatorOf(disk) !== deps.me.id) {
      deps.log(`skip id=${id} run=${runFor}: ${why}，本机不是建它的那台，不跑（离线时只有建任务的电脑跑）`);
      return 'offline-not-creator';
    }
    if (!deps.eligible(disk)) {
      deps.log(`skip id=${id} run=${runFor}: ${why}；最新的定义本机还没确认（或本机已没资格），不跑`);
      return 'not-eligible';
    }
    /*
      本机这份带着「记了账、没确认送达」（上次跑到一半 / 同步来的）：已经交给会话了的只清标记；还没交出去的撤销那次记账 ——
      然后照常判一遍：暂停了 / 结束了 / 过期了 / 次数用完了 / 不到点的不跑（检查命令也不跑）
    */
    let st = disk;
    if (st.pendingRun) {
      st = st.pendingRun.sent ? { ...st, pendingRun: null } : restorePending(st);
      deps.persist?.(st);
    }
    const blocked = runBlocker(st, deps.now());
    if (blocked) { deps.log(`skip id=${id} run=${runFor}: ${why}；任务${blocked}，不跑`); return 'blocked'; }
    if (!deps.manual && !isDue(st, deps.now())) return 'not-due';
    const offlineRunFor = deps.manual ? runFor : plannedRunFor(st, deps.now());
    deps.log(`offline id=${id} run=${offlineRunFor}: ${why}，本机是建它的那台，照旧在本机跑`);
    await deps.run(st, offlineRunFor, { lost: () => false, offline: true });
    return 'offline-ran';
  };
  if (!deps.bucket) return offline('拿不到 S3 / 会话没开跨电脑同步');
  const bucket = deps.bucket;
  let got: Acquired;
  try { got = await acquireLease(bucket, deps.leaseKey, deps.me, runFor, now); } catch (err: any) {
    return offline(`抢租约时连不上 S3（${err?.message || err}）`);
  }
  if (!got.ok) {
    deps.log(`lease lost id=${id} run=${runFor}: 已由 ${got.heldBy?.name || got.heldBy?.holder || '别的电脑'} 抢到，本机这一次不跑`);
    return 'held';
  }
  deps.log(`lease acquired id=${id} run=${runFor}`);
  let etag = got.etag;
  let lease = got.lease;
  let lost = false;
  /* 还持有这一次吗：没被覆盖，而且最后一次成功拿到的租约还没到期（续约一直失败也会过期） */
  const holds = (): boolean => {
    if (lost) return false;
    if (deps.now() >= lease.expiresAt - LEASE_SAFETY_MS) {
      lost = true;
      deps.log(`lease lost id=${id} run=${runFor}: 续约一直没成功，租约已到期，别的电脑可以接手`);
      return false;
    }
    return true;
  };
  const stop = deps.every(LEASE_RENEW_MS, () => {
    if (!holds()) return;
    void renewLease(bucket, deps.leaseKey, etag, lease, deps.now()).then((r) => {
      if (r.ok) { etag = r.etag; lease = r.lease; deps.log(`lease renewed id=${id} run=${runFor}`); }
      else { lost = true; deps.log(`lease lost id=${id} run=${runFor}: 续约时发现被别的电脑覆盖了`); }
    }, (err) => deps.log(`lease renew failed id=${id} run=${runFor}: ${err?.message || err}（下一次再续）`));
  });
  try {
    /* 抢到之后先看桶里最新的：这一次已经有人跑过了（或者已经不到点了）→ 不跑 */
    /* 读不到桶里的状态、本机是建它的那台：按离线兜底跑（本机记账，不要求传上去） */
    let offlineFallback = false;
    let remote: ScheduleState | null = null;
    let fetchError: any = null;
    try { remote = await deps.fetchRemote(); } catch (err: any) { fetchError = err; }
    /*
      **等网络回来之后、写回任何东西之前**，按盘上最新的那份重新判：等的这段时间里同步删了它 → 直接停（不拿开头那份旧的写回去、
      把删掉的任务又建出来）；最新的定义本机没确认 → 停。之后一律从这份最新的往下走
    */
    const fresh = deps.readLocal();
    if (!fresh) { deps.log(`skip id=${id} run=${runFor}: 等网络期间任务已经删了，不跑`); return 'deleted'; }
    if (!deps.eligible(fresh)) { deps.log(`skip id=${id} run=${runFor}: 等网络期间定义变了，本机还没确认最新的定义，不跑`); return 'not-eligible'; }
    let state = fresh;
    if (fetchError) {
      /*
        确认不了桶里最新的状态（别的电脑可能刚跑完这一次、或者暂停 / 删了它）：按离线的规矩 —— 只有建它的那台跑，别的电脑这一次不跑
      */
      if (creatorOf(fresh) !== deps.me.id) {
        deps.log(`skip id=${id} run=${runFor}: 读不到桶里的状态（${fetchError?.message || fetchError}），确认不了这一次有没有人跑过；本机不是建它的那台，不跑`);
        return 'offline-not-creator';
      }
      deps.log(`lease id=${id} run=${runFor}: 读不到桶里的状态（${fetchError?.message || fetchError}），本机是建它的那台，按离线规则照旧跑`);
      offlineFallback = true;
    } else if (remote) state = deps.adopt(remote);
    /*
      上一次记了账、却没确认送达（记它的那台租约已经过期 —— 本机现在持有租约）：那次没发出去（或者没法确认），撤销那次记账，这一次由本机跑。
      离线兜底时不碰（确认不了桶里的情况）。
    */
    if (state.pendingRun?.sent && !offlineFallback) {
      /* 已经交给会话了（只是最后那次确认没传上去 / 那台崩了）：这一次算跑过，不重发，只清掉标记 */
      deps.log(`lease id=${id} run=${state.pendingRun.runFor}: ${state.pendingRun.by} 已经把这一次交给会话了（只是没确认完），不重发，只清掉标记`);
      state = { ...state, pendingRun: null };
      deps.persist?.(state);
    } else if (state.pendingRun && !offlineFallback) {
      deps.log(`lease id=${id} run=${state.pendingRun.runFor}: ${state.pendingRun.by} 记了账但没确认送达（它已不持有租约），撤销那次记账，由本机接手`);
      state = restorePending(state);
      deps.persist?.(state);
      if (!deps.manual) runFor = plannedRunFor(state, deps.now());
    }
    /* 「立即运行一次」只豁免「到没到点」和「这一次跑没跑过」；合并来的状态暂停了 / 结束了 / 过期了 / 次数用完了照样不跑 */
    const blocked = runBlocker(state, deps.now());
    if (blocked) {
      deps.log(`skip id=${id} run=${runFor}: 桶里最新的状态是${blocked}，不跑`);
      return 'blocked';
    }
    if (!deps.manual && ((state.lastRunFor ?? Number.NEGATIVE_INFINITY) >= runFor || !isDue(state, deps.now()))) {
      deps.log(`skip id=${id} run=${runFor}: 已由 ${state.runnerName || state.runner || '别的电脑'} 运行`);
      return 'already-ran';
    }
    if (!deps.eligible(state)) {
      deps.log(`skip id=${id} run=${runFor}: 桶里的定义变了，本机还没确认，不跑`);
      return 'not-eligible';
    }
    if (!holds()) return 'held';
    /*
      **执行之前按盘上最新的那份再判一次**（抢租约、读桶的这段时间里，同步可能删了它、换了定义）：删了不跑；最新的定义本机没确认、
      或者和要跑的这份不一样，不跑；离线兜底（读不到桶）时还得是建它的那台
    */
    const disk = deps.readLocal();
    if (!disk) { deps.log(`skip id=${id} run=${runFor}: 任务已经删了，不跑`); return 'deleted'; }
    if (!deps.eligible(disk) || definitionHash(disk) !== definitionHash(state)) {
      deps.log(`skip id=${id} run=${runFor}: 等待期间定义变了 / 本机还没确认最新的定义，不跑`);
      return 'not-eligible';
    }
    if (offlineFallback && creatorOf(disk) !== deps.me.id) {
      deps.log(`skip id=${id} run=${runFor}: 读不到桶里的状态，本机不是建它的那台，不跑`);
      return 'offline-not-creator';
    }
    await deps.run(state, runFor, { lost: () => !holds(), offline: offlineFallback });
    return 'ran';
  } finally {
    stop();
    if (holds()) {
      try { await bucket.del(deps.leaseKey, etag); deps.log(`lease released id=${id} run=${runFor}`); }
      catch (err: any) { deps.log(`lease release failed id=${id} run=${runFor}: ${err?.message || err}（5 分钟后自己过期）`); }
    }
  }
}

/** 一次运行记账改的字段（次数、时刻、计划时刻、上次由谁跑、上次错误）—— 撤销记账时只退这些。 */
export const CHARGE_KEYS = ['runs', 'lastRunAt', 'lastRunFor', 'pendingRun', 'lastError', 'runner', 'runnerName', 'runnerChangedAt'] as const;
/** 「检查过了、输出没变」那次只记的字段（计划时刻 + 上次由谁跑）。 */
export const MARK_KEYS = ['lastRunFor', 'runner', 'runnerName', 'runnerChangedAt'] as const;

/**
 * **只撤销这一次的记账**：在**现在**盘上那份的基础上，把记账改过的那几个字段退回记账之前的值 ——
 * 期间用户按的暂停、改的过期时间、同步进来的定义都留着（整份写回记账之前那份会把它们盖掉）。
 */
export function undoCharge(current: ScheduleState, before: ScheduleState, keys: readonly string[] = CHARGE_KEYS): ScheduleState {
  const out: any = { ...current };
  for (const k of keys) {
    if ((before as any)[k] === undefined) delete out[k];
    else out[k] = (before as any)[k];
  }
  return out;
}

export interface CommitDeps {
  /** 断网兜底（只有建它的那台在跑）：本机记账就算数，不要求传上去。 */
  offline: boolean;
  /** 已经不持有这一次了吗。 */
  lost(): boolean;
  /** 把「这一次跑过了」传到桶里；成功 = true。 */
  publish(): Promise<boolean>;
  /** 现在盘上那份（传的这段时间里可能被暂停 / 改过 / 删了）。 */
  readCurrent(): ScheduleState | null;
  /** 这条任务删了吗（删除标记）—— 删了的不写回。 */
  deleted(): boolean;
  writeRaw(state: ScheduleState): void;
  log(message: string): void;
}

/**
 * **记账之后、叫醒会话之前**：「这一次跑过了」传到桶里才算数（别的电脑抢到租约后靠它知道不用再跑）。
 * 断网兜底：本机记账就算数。传不上去 / 租约丢了 → 只撤销这一次的记账（`undoCharge`，保留期间的暂停 / 过期 / 定义；
 * 删掉了的不写回），返回 false —— 调用方不叫醒会话，这一次留给下一次尝试。
 */
export async function commitCharge(before: ScheduleState, deps: CommitDeps, keys: readonly string[] = CHARGE_KEYS): Promise<boolean> {
  if (deps.offline) return !deps.lost();
  const ok = await deps.publish();
  if (ok && !deps.lost()) return true;
  const cur = deps.readCurrent();
  /*
    带着「没确认送达」（检查之前的快照）的：和接手的电脑同一个撤销 —— 连这一次检查的结论（检查时刻、指纹、达成目标的终态…）一起退回，
    不然「已达成」留着、这一次又不再「到点」，最终汇报就永远发不出去。期间用户的暂停留着；删掉了的不写回
  */
  if (cur && !deps.deleted()) deps.writeRaw(cur.pendingRun ? restorePending(cur) : undoCharge(cur, before, keys));
  deps.log(`「这一次跑过了」${ok ? '传上去了，但租约已经丢了' : '没能传到桶里'}，只撤销这一次的记账${cur && !deps.deleted() ? '' : '（任务已删，不写回）'}，不叫醒会话，留给下一次尝试`);
  return false;
}
