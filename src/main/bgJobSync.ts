/**
 * **后台任务（bg_run / watch）跨电脑同步** ——「状态都同步、只读显示，只在跑它的那台执行」。纯逻辑 + 一本本地账（`bg-sync.json`），
 * 不碰网络；index.ts 接线（`syncBgJobsWithBucket`）。同步通道、机器标识、同步范围判定、删除标记的做法都同定时任务（`scheduleSync.ts`）。
 *
 * ## 谁跑
 * 后台任务是某台电脑上的一个进程，搬不走。跑它的那台（`runner` = 设备 ID）把状态传上去；别的电脑只把它记进**另一本账**
 * （`foreign`），绝不进本机的进程表（`BgJobManager`）、绝不在本机起进程、绝不叫醒会话 —— 结束的唤醒消息只由 runner 发一次，
 * 写进会话记录（记录本身会同步）。
 *
 * ## S3 里的东西不可信
 *   · 状态只认 runner 写的：本机已经记着的那条，runner 变了的版本一律不收；说「runner 是本机」的也不收（本机的只来自本机进程表）。
 *   · 停止请求是单独的对象，解析只留 jobId / 会话 / 时刻 —— 只能停，带什么命令 / 参数都扔掉；runner 只对**自己表里在跑的**那条调 stop。
 *   · 「在本机重新运行」只在本机界面上、先把命令全文和 cwd 给人看、确认之后才起（新 jobId），绝不自动重跑。
 *
 * ## 保留
 * 本机的规则：结束的任务留在内存里，KiroLex 重启就没了。同步跟它一致 —— 本机进程表里没了的（重启过）、或者会话离开了同步范围 /
 * 被删了，就写删除标记（单独的对象，永远胜，不会被补回）。
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { stableStringify } from './scheduleSync.ts';

/** 桶里放后台任务的目录（相对布局根）：`bg-jobs/<sessionId>/<jobId>.json`（+ `.stop.json` / `.rerun.json` / `.deleted.json`）。 */
export const BG_JOBS_REL = 'bg-jobs';

export type BgObjectKind = 'state' | 'stop' | 'rerun' | 'deleted';
const SUFFIX: Record<BgObjectKind, string> = { state: '.json', stop: '.stop.json', rerun: '.rerun.json', deleted: '.deleted.json' };
/** 长的后缀先比（`.stop.json` 也以 `.json` 结尾）。 */
const SUFFIX_ORDER: BgObjectKind[] = ['stop', 'rerun', 'deleted', 'state'];

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export function bgObjectRel(sessionId: string, jobId: string, kind: BgObjectKind): string {
  return `${BG_JOBS_REL}/${sessionId}/${jobId}${SUFFIX[kind]}`;
}

export function parseBgObjectRel(rel: string): { sessionId: string; jobId: string; kind: BgObjectKind } | null {
  const parts = rel.split('/');
  if (parts.length !== 3 || parts[0] !== BG_JOBS_REL || !parts[1]) return null;
  for (const kind of SUFFIX_ORDER) {
    if (!parts[2].endsWith(SUFFIX[kind])) continue;
    const jobId = parts[2].slice(0, -SUFFIX[kind].length);
    return JOB_ID_RE.test(jobId) ? { sessionId: parts[1], jobId, kind } : null;
  }
  return null;
}

/** 桶里一个 job 的几个对象（key 相对路径 + ETag）。有删除标记 = 删了，别的都不用再看。 */
export interface BucketBgJob {
  sessionId: string;
  deleted: boolean;
  state?: { rel: string; etag?: string };
  stop?: { rel: string; etag?: string };
  rerun?: { rel: string; etag?: string };
}

/** 列表 → 每个 jobId 的对象。同一个 jobId 挂在两条会话下的，以先见到的为准。 */
export function collectBucketBgJobs(entries: Array<{ rel: string; etag?: string }>): Map<string, BucketBgJob> {
  const out = new Map<string, BucketBgJob>();
  for (const e of entries) {
    const k = parseBgObjectRel(e.rel);
    if (!k) continue;
    let j = out.get(k.jobId);
    if (!j) { j = { sessionId: k.sessionId, deleted: false }; out.set(k.jobId, j); }
    if (j.sessionId !== k.sessionId) continue;
    if (k.kind === 'deleted') j.deleted = true;
    else j[k.kind] = { rel: e.rel, ...(e.etag ? { etag: e.etag } : {}) };
  }
  return out;
}

/* ------------------------------------------------------------------ 状态 */

export type BgSyncStatus = 'running' | 'exited' | 'failed' | 'timeout' | 'stopped' | 'rate-limited';
const STATUSES: BgSyncStatus[] = ['running', 'exited', 'failed', 'timeout', 'stopped', 'rate-limited'];

/** 传上去的那份：runner 写，别的电脑只显示。 */
export interface BgSyncState {
  jobId: string;
  sessionId: string;
  kind: 'run' | 'watch';
  label: string;
  /** 完整命令（显示 + 「在本机重新运行」要给人看全文）。超过 `BG_COMMAND_MAX` 的只传开头，并标 `commandTruncated`。 */
  command: string;
  /** 命令太长没能完整同步：别的电脑只显示开头并说明，**不准在本机重跑**（不能执行一个截断了的命令）。 */
  commandTruncated?: boolean;
  /** runner 那台上的工作目录（只显示）。 */
  cwd: string;
  timeoutMs: number;
  runner: string;
  runnerName: string;
  state: BgSyncStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  events: number;
  /** 结束后的输出末尾（同唤醒消息的截断：`outputTail(…, BG_TAIL_BYTES)`）；还在跑 = null。 */
  tail: string | null;
  /** runner 最后一次写它的时刻（心跳）—— 太久没更新 = runner 失联（`bgRunnerLost`）。 */
  updatedAt: number;
}

export const BG_COMMAND_MAX = 200_000;
export const BG_CWD_MAX = 4096;
const TAIL_MAX = 16_384;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** 桶里来的状态 → 干净的一份，认不出就 null。只挑认得的字段，jobId / 会话必须和 key 里的一样，必须带 runner。 */
export function parseRemoteBgState(text: string, jobId: string, sessionId: string): BgSyncState | null {
  let o: any;
  try { o = JSON.parse(text); } catch { return null; }
  const s = o?.state;
  if (!o || typeof o !== 'object' || o.jobId !== jobId || o.sessionId !== sessionId || !s || typeof s !== 'object') return null;
  if (s.jobId !== jobId || s.sessionId !== sessionId) return null;
  if (s.kind !== 'run' && s.kind !== 'watch') return null;
  if (!STATUSES.includes(s.state)) return null;
  if (!str(s.label, 200) || !str(s.command, BG_COMMAND_MAX) || !s.command.trim() || !str(s.cwd, BG_CWD_MAX)) return null;
  if (!str(s.runner, 200) || !s.runner || !str(s.runnerName, 200)) return null;
  if (!num(s.startedAt) || !num(s.updatedAt) || !num(s.timeoutMs) || s.timeoutMs <= 0) return null;
  if (!(s.endedAt === null || num(s.endedAt)) || !(s.exitCode === null || num(s.exitCode))) return null;
  if (!(s.tail === null || typeof s.tail === 'string')) return null;
  return {
    jobId, sessionId, kind: s.kind, label: s.label, command: s.command, cwd: s.cwd, timeoutMs: s.timeoutMs,
    runner: s.runner, runnerName: s.runnerName || s.runner, state: s.state,
    startedAt: s.startedAt, endedAt: s.endedAt, exitCode: s.exitCode,
    events: num(s.events) && s.events >= 0 ? Math.floor(s.events) : 0,
    tail: s.tail === null ? null : s.tail.slice(-TAIL_MAX),
    updatedAt: s.updatedAt,
    ...(s.commandTruncated === true ? { commandTruncated: true } : {}),
  };
}

export function bgStateBody(state: BgSyncState): string {
  return JSON.stringify({ v: 1, jobId: state.jobId, sessionId: state.sessionId, state }, null, 2);
}

/**
 * **状态合并：只认跑它那台写的**。返回要记进本机 `foreign` 账的那份，null = 不收（留本机原来的 / 不记）：
 *   · 说 runner 是本机的 —— 本机的任务只来自本机进程表，桶里这么写的不收；
 *   · 本机已经记着、runner 却变了的 —— 不收（runner 不会变，变了就是别人写的）；
 *   · 比本机记着的旧的 —— 不收。
 */
export function mergeBgState(local: BgSyncState | undefined, remote: BgSyncState, me: string): BgSyncState | null {
  if (remote.runner === me) return null;
  if (!local) return remote;
  if (remote.runner !== local.runner || remote.sessionId !== local.sessionId) return null;
  if (remote.updatedAt < local.updatedAt) return null;
  return stableStringify(remote) === stableStringify(local) ? null : remote;
}

/** runner 失联：还在「运行中」，状态却超过 `staleAfterMs`（约 2 个同步周期）没更新。结束了的状态是终态，不算。 */
export function bgRunnerLost(state: Pick<BgSyncState, 'state' | 'updatedAt'>, now: number, staleAfterMs: number): boolean {
  return state.state === 'running' && staleAfterMs > 0 && now - state.updatedAt > staleAfterMs;
}

/* ------------------------------------------------------------ 停止请求 / 重跑标记 */

export interface BgStopRequest { jobId: string; sessionId: string; at: number; by: string }

export function stopRequestBody(req: BgStopRequest): string {
  return JSON.stringify({ v: 1, op: 'stop', jobId: req.jobId, sessionId: req.sessionId, at: req.at, by: req.by }, null, 2);
}

/** 停止请求：**只能停** —— 只认 `op: 'stop'`，只留 jobId / 会话 / 时刻 / 谁发的，别的字段（命令、参数……）一律扔掉。 */
export function parseStopRequest(text: string, jobId: string, sessionId: string): BgStopRequest | null {
  let o: any;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || o.op !== 'stop' || o.jobId !== jobId || o.sessionId !== sessionId) return null;
  if (!num(o.at) || !str(o.by, 200)) return null;
  return { jobId, sessionId, at: o.at, by: o.by };
}

/**
 * runner 这台要停哪些：请求指向**本机表里**这条会话自己的、还在跑的任务才停。返回的只有 jobId + 会话 ——
 * 调用方拿它调 `BgJobManager.stop`（只结束它自己起的进程），没有别的可做。
 */
export function planStopRequests(
  requests: BgStopRequest[],
  own: Array<{ jobId: string; sessionId: string; state: string; kind: string }>,
): Array<{ jobId: string; sessionId: string }> {
  const out: Array<{ jobId: string; sessionId: string }> = [];
  for (const r of requests) {
    const job = own.find((j) => j.jobId === r.jobId);
    if (!job || job.sessionId !== r.sessionId || job.state !== 'running' || (job.kind !== 'run' && job.kind !== 'watch')) continue;
    if (!out.some((x) => x.jobId === r.jobId)) out.push({ jobId: r.jobId, sessionId: r.sessionId });
  }
  return out;
}

/** 「已在别处重跑」标记：哪台、什么时候、新的 jobId。 */
export interface BgRerunMark { at: number; by: string; byName: string; newJobId: string }

export function rerunBody(jobId: string, sessionId: string, mark: BgRerunMark): string {
  return JSON.stringify({ v: 1, jobId, sessionId, rerun: mark }, null, 2);
}

export function parseRerunMark(text: string, jobId: string, sessionId: string): BgRerunMark | null {
  let o: any;
  try { o = JSON.parse(text); } catch { return null; }
  const m = o?.rerun;
  if (!o || typeof o !== 'object' || o.jobId !== jobId || o.sessionId !== sessionId || !m || typeof m !== 'object') return null;
  if (!num(m.at) || !str(m.by, 200) || !str(m.byName, 200) || !str(m.newJobId, 120) || !JOB_ID_RE.test(m.newJobId)) return null;
  return { at: m.at, by: m.by, byName: m.byName, newJobId: m.newJobId };
}

/** 「在本机重新运行」确认框给人看的那份（命令全文 + 本机 cwd + 种类 + 超时）的摘要：确认之后定义变了就拒。 */
export function rerunHash(state: Pick<BgSyncState, 'command' | 'kind' | 'timeoutMs' | 'label'>, localCwd: string): string {
  return crypto.createHash('sha256').update(stableStringify({ command: state.command, kind: state.kind, timeoutMs: state.timeoutMs, label: state.label, cwd: localCwd })).digest('hex');
}

/* ------------------------------------------------------------------ 本地账 */

/** 别的电脑上的任务（只显示）+ 本机这边对它做过的事。 */
export interface ForeignBgJob {
  state: BgSyncState;
  /** 桶里那份状态对象的 ETag：没变就不再下载。 */
  etag?: string;
  /** 本机点过停止：请求的时刻；`stopPushed` = 已经传上去了。 */
  stopRequestedAt?: number;
  stopPushed?: boolean;
  /** 已在别处重跑（本机的或者桶里看到的）；`rerunPushed` = 本机这份已经传上去了。 */
  rerun?: BgRerunMark;
  rerunPushed?: boolean;
}

export interface BgSyncLedger {
  /** 本机传上去过的（本机的任务）：jobId → 会话 + 内容摘要 + 上次传的时刻。 */
  published: Record<string, { sessionId: string; hash: string; putAt: number }>;
  foreign: Record<string, ForeignBgJob>;
  /** 删除标记：jobId → 会话 + 时刻；`pushed` = 桶里已经有了。 */
  tombstones: Record<string, { sessionId: string; at: number; pushed?: boolean }>;
  /** 本机的任务被别的电脑「在那边重跑」了（桶里的重跑标记）：只显示，本机的进程照旧跑（要停就点停止）。 */
  ownReruns: Record<string, BgRerunMark>;
}

export function emptyLedger(): BgSyncLedger { return { published: {}, foreign: {}, tombstones: {}, ownReruns: {} }; }

function ledgerFile(home: string): string { return path.join(home, '.kirolex', 'bg-sync.json'); }

export function readBgLedger(home: string): BgSyncLedger {
  try {
    const o = JSON.parse(fs.readFileSync(ledgerFile(home), 'utf-8'));
    const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});
    return { published: obj(o?.published), foreign: obj(o?.foreign), tombstones: obj(o?.tombstones), ownReruns: obj(o?.ownReruns) } as BgSyncLedger;
  } catch { return emptyLedger(); }
}

export function writeBgLedger(home: string, ledger: BgSyncLedger): void {
  const file = ledgerFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/** 删会话：这条会话的（本机传过的 + 别的电脑的）都记删除标记，别的电脑拉到后删掉它们那份，不会再被补回。 */
export function forgetBgSession(ledger: BgSyncLedger, sessionId: string, now: number): BgSyncLedger {
  const out: BgSyncLedger = { ...ledger, published: { ...ledger.published }, foreign: { ...ledger.foreign }, tombstones: { ...ledger.tombstones } };
  for (const [id, p] of Object.entries(ledger.published)) if (p.sessionId === sessionId && !out.tombstones[id]) out.tombstones[id] = { sessionId, at: now };
  for (const [id, f] of Object.entries(ledger.foreign)) {
    if (f.state.sessionId !== sessionId) continue;
    if (!out.tombstones[id]) out.tombstones[id] = { sessionId, at: now };
    delete out.foreign[id];
  }
  return out;
}

/* ------------------------------------------------------------------ 这一轮做什么 */

/** 本机进程表里的一条（index.ts 从 `BgJobManager.listForSync` 拿，已经去掉 check）。 */
export type OwnBgJob = Omit<BgSyncState, 'runner' | 'runnerName' | 'updatedAt'>;

export type BgSyncAction =
  /** 传本机这条的状态（变了 / 该心跳了）。 */
  | { op: 'put'; jobId: string; sessionId: string; state: BgSyncState; hash: string }
  /** 写删除标记（本机清理掉了 / 会话不同步了 / 删了），顺手删掉桶里它的其他对象。 */
  | { op: 'put-tombstone'; jobId: string; sessionId: string; at: number; extra: string[] }
  /** 下载桶里别的电脑的状态（ETag 变了）。 */
  | { op: 'fetch-state'; jobId: string; sessionId: string; rel: string; etag?: string }
  /** 下载桶里给本机任务的停止请求。 */
  | { op: 'fetch-stop'; jobId: string; sessionId: string; rel: string }
  /** 下载重跑标记（别的电脑的任务被谁在别处重跑了）。 */
  | { op: 'fetch-rerun'; jobId: string; sessionId: string; rel: string }
  /** 传本机发的停止请求 / 重跑标记。 */
  | { op: 'put-stop'; jobId: string; sessionId: string; at: number }
  | { op: 'put-rerun'; jobId: string; sessionId: string; mark: BgRerunMark }
  /** 本机账里拿掉这条（别的电脑的：桶里删了 / 没了 / 会话不在同步范围；本机传过的：桶里已是删除标记）；`tombstone` = 桶里是删除标记，本机也记一笔。 */
  | { op: 'forget'; jobId: string; sessionId: string; tombstone: boolean };

export interface BgSyncPlanInput {
  me: { id: string; name: string };
  now: number;
  /** 心跳间隔：还在跑的，至少这么久重传一次（让别的电脑知道 runner 还活着）。 */
  heartbeatMs: number;
  own: OwnBgJob[];
  ledger: BgSyncLedger;
  bucket: Map<string, BucketBgJob>;
  /** 这条会话在同步范围里吗（本机有这条、跟随备份开关 / 跨电脑同步规则、不是 advanced、没删）。 */
  inScope: (sessionId: string) => boolean;
}

export function ownToSync(job: OwnBgJob, me: { id: string; name: string }, now: number): BgSyncState {
  /* 命令不静默截断：太长的只传开头并明说（别的电脑据此不给重跑） */
  const truncated = job.command.length > BG_COMMAND_MAX;
  return {
    ...job, label: job.label.slice(0, 200), command: truncated ? job.command.slice(0, BG_COMMAND_MAX) : job.command, cwd: job.cwd.slice(0, BG_CWD_MAX),
    runner: me.id, runnerName: me.name, updatedAt: now, ...(truncated ? { commandTruncated: true } : {}),
  };
}

function contentHash(state: BgSyncState): string {
  const { updatedAt: _u, ...rest } = state;
  return crypto.createHash('sha256').update(stableStringify(rest)).digest('hex');
}

/**
 * **这一轮对每个后台任务做什么**。
 *   · 本机的：在同步范围里就传（内容变了，或者还在跑、到了心跳时间）；本机进程表里已经没了（重启过）/ 会话不同步了 → 删除标记；
 *   · 别的电脑的：只下载、只记进 `foreign` 账（绝不进本机进程表）；桶里删了 / 没了 / 会话不在同步范围 → 拿掉；
 *   · 删除标记永远胜，不会被补回；不在同步范围的会话一个字节都不传。
 */
export function planBgSync(input: BgSyncPlanInput): BgSyncAction[] {
  const out: BgSyncAction[] = [];
  const { ledger, bucket, me, now } = input;
  const ownById = new Map(input.own.map((j) => [j.jobId, j]));
  const extraRels = (b: BucketBgJob | undefined) => (b ? [b.state?.rel, b.stop?.rel, b.rerun?.rel].filter((r): r is string => !!r) : []);

  /* 1. 删除标记：还没传的就传；桶里有删除标记的，本机也记上 */
  for (const [jobId, t] of Object.entries(ledger.tombstones)) {
    const b = bucket.get(jobId);
    if (!t.pushed && !b?.deleted) out.push({ op: 'put-tombstone', jobId, sessionId: t.sessionId, at: t.at, extra: extraRels(b) });
  }

  /* 2. 本机的 */
  for (const job of input.own) {
    if (ledger.tombstones[job.jobId] || bucket.get(job.jobId)?.deleted) continue;
    if (!input.inScope(job.sessionId)) continue;
    const state = ownToSync(job, me, now);
    const hash = contentHash(state);
    const pub = ledger.published[job.jobId];
    const changed = !pub || pub.hash !== hash;
    const heartbeat = job.state === 'running' && (!pub || now - pub.putAt >= input.heartbeatMs);
    if (changed || heartbeat) out.push({ op: 'put', jobId: job.jobId, sessionId: job.sessionId, state, hash });
    const b = bucket.get(job.jobId);
    if (b?.stop && job.state === 'running') out.push({ op: 'fetch-stop', jobId: job.jobId, sessionId: job.sessionId, rel: b.stop.rel });
    /* 本机失联期间被别的电脑「在那边重跑」了：本机也要显示出来（进程照旧，不自动停） */
    if (b?.rerun && !ledger.ownReruns?.[job.jobId]) out.push({ op: 'fetch-rerun', jobId: job.jobId, sessionId: job.sessionId, rel: b.rerun.rel });
  }
  /* 本机传过、现在进程表里没了（KiroLex 重启过 —— 本机就是这时候清理的）/ 会话不同步了：删除标记 */
  for (const [jobId, pub] of Object.entries(ledger.published)) {
    if (ledger.tombstones[jobId]) continue;
    const job = ownById.get(jobId);
    if (job && input.inScope(job.sessionId) && !bucket.get(jobId)?.deleted) continue;
    if (bucket.get(jobId)?.deleted) continue;   // 已经是删除标记了（别的电脑删的会话）：下面 drop 掉账
    out.push({ op: 'put-tombstone', jobId, sessionId: pub.sessionId, at: now, extra: extraRels(bucket.get(jobId)) });
  }
  /*
    桶里有、本机两本账都没记过的：下载看看 —— 别的电脑的新任务就记进 foreign 账（只显示）；
    说 runner 是本机、本机表里却没有的（上一次运行留下的 / 伪造的）：补删除标记，不当成本机的（）
  */
  for (const [jobId, b] of bucket) {
    if (b.deleted || ownById.has(jobId) || ledger.published[jobId] || ledger.foreign[jobId] || ledger.tombstones[jobId] || !b.state) continue;
    if (!input.inScope(b.sessionId)) continue;
    out.push({ op: 'fetch-state', jobId, sessionId: b.sessionId, rel: b.state.rel, ...(b.state.etag ? { etag: b.state.etag } : {}) });
  }

  /* 3. 别的电脑的（本机账里已经有的） */
  for (const [jobId, f] of Object.entries(ledger.foreign)) {
    if (ownById.has(jobId)) continue;
    const sid = f.state.sessionId;
    const b = bucket.get(jobId);
    if (ledger.tombstones[jobId]) { out.push({ op: 'forget', jobId, sessionId: sid, tombstone: false }); continue; }
    if (b?.deleted) { out.push({ op: 'forget', jobId, sessionId: sid, tombstone: true }); continue; }
    if (!input.inScope(sid) || !b || !b.state || b.sessionId !== sid) { out.push({ op: 'forget', jobId, sessionId: sid, tombstone: false }); continue; }
    if (!f.etag || f.etag !== b.state.etag) out.push({ op: 'fetch-state', jobId, sessionId: sid, rel: b.state.rel, ...(b.state.etag ? { etag: b.state.etag } : {}) });
    if (f.stopRequestedAt !== undefined && !f.stopPushed && f.state.state === 'running') out.push({ op: 'put-stop', jobId, sessionId: sid, at: f.stopRequestedAt });
    if (f.rerun && !f.rerunPushed && f.rerun.by === me.id) out.push({ op: 'put-rerun', jobId, sessionId: sid, mark: f.rerun });
    else if (!f.rerun && b.rerun) out.push({ op: 'fetch-rerun', jobId, sessionId: sid, rel: b.rerun.rel });
  }
  /* 桶里删了、本机没记过的：记一笔删除，以后不再看 */
  for (const [jobId, b] of bucket) {
    if (b.deleted && !ledger.tombstones[jobId] && !ledger.foreign[jobId] && (ledger.published[jobId] || ownById.has(jobId))) {
      out.push({ op: 'forget', jobId, sessionId: b.sessionId, tombstone: true });
    }
  }
  return out;
}

/**
 * 下载下来的状态怎么落账：`mergeBgState` 收了 → 记进 `foreign`；说 runner 是本机、本机表里却没有的 → 删除标记（本机清理过的，
 * 或者伪造的 —— 两种都不能显示成「本机在跑」，更不能起进程）。返回新账和要不要补一个删除标记。
 */
export function applyFetchedState(
  ledger: BgSyncLedger, jobId: string, parsed: BgSyncState | null, etag: string | undefined, me: string, ownIds: Set<string>,
): { ledger: BgSyncLedger; tombstone: boolean } {
  const prev = ledger.foreign[jobId];
  /* 认不出 / 不收的版本也记下 ETag：同一份不用每轮再下载一次 */
  const seen = (): BgSyncLedger => (prev && etag ? { ...ledger, foreign: { ...ledger.foreign, [jobId]: { ...prev, etag } } } : ledger);
  if (!parsed) return { ledger: seen(), tombstone: false };
  if (parsed.runner === me) return { ledger: seen(), tombstone: !prev && !ownIds.has(jobId) && !ledger.published[jobId] };
  const merged = mergeBgState(prev?.state, parsed, me);
  if (!merged) return { ledger: seen(), tombstone: false };
  const foreign = { ...ledger.foreign, [jobId]: { ...(prev || {}), state: merged, ...(etag ? { etag } : {}) } };
  return { ledger: { ...ledger, foreign }, tombstone: false };
}

/** 删除标记（单独的对象 `<jobId>.deleted.json`）：只有 id / 会话 / 时刻 / 谁删的，不带任务内容。 */
export function bgTombstoneBody(jobId: string, sessionId: string, at: number, by: string): string {
  return JSON.stringify({ v: 1, jobId, sessionId, deleted: { at, by } }, null, 2);
}
