/**
 * **定时任务跨电脑同步** ——「任务和运行状态都同步，但同一时刻只有一台电脑跑」。纯逻辑（不碰网络 / 磁盘），index.ts 接线。
 *
 * ## 谁跑：执行者（runner）
 * 每条任务记一个 `runner`（设备 ID，`thisDeviceId()`）和 `runnerChangedAt`。建任务的那台是初始 runner；
 * **只有 runner 那台**排定时器、跑 `checkCommand`、叫醒会话，别的电脑一律不跑（哪怕 runner 那台关机了）——
 * 要换到本机跑只能在本机界面上「接管」（先弹窗把 prompt / checkCommand / 目标 / 周期全文给人看，确认了才改）。
 *
 * ## S3 里的东西不可信
 * `checkCommand` 是本机 shell。桶里的内容谁都可能改过，所以：
 *   · 远端版本**不能把 runner 改成本机**（`mergeSchedule` 拒掉，`refusedAssign`）—— 只有本机的接管能；
 *   · runner 本机**不接受远端改定义**（prompt / checkCommand / until / 周期）—— 只有本机界面 / 本机会话的 schedule 工具能改；
 *   · 本机另记一份「确认过的定义」（`definitionHash` → `schedule-approved.json`，不同步）：本机建的、接管时确认过的才记。
 *     调度器跑之前要 runner 是本机**并且**定义的摘要对得上（`canRunHere`）—— 恢复会话时桶里那份说「runner 是你」也不算数，
 *     要么摘要和本机确认过的一样，要么用户点接管再确认一次。
 *
 * ## 合并（`mergeSchedule`）
 *   · 运行状态（runs / lastRunAt / lastError / 检查结果 / terminal / 连续出错次数）只认 runner 写的那份；
 *   · 控制操作（暂停 / 继续、改过期时间、接管）任何一台都能发，按各自最后一次操作的时刻，后者胜；删除是删除标记，永远胜；
 *   · 定义字段：runner 本机留本机的，其他电脑跟桶里的（只是显示；真要跑得先接管、确认）。
 */

import crypto from 'crypto';
import { CHECK_OUTPUT_KEEP, validateSchedule, type ScheduleSpec, type ScheduleState } from './schedule.ts';

/**
 * 桶里放定时任务的目录（相对布局根）：`schedules/<sessionId>/<id>.json` —— 按会话分，恢复一条会话时按前缀列出它的任务。
 * 删除标记是**另一个对象** `schedules/<sessionId>/<id>.deleted.json`：活任务的上传永远写不到它，所以一台电脑拿着删除前读到的
 * 旧任务再传一次，也盖不掉删除；列表里只要有它，这条就是删了（`collectBucketSchedules`）。
 */
export const SCHEDULES_REL = 'schedules';
const DELETED_SUFFIX = '.deleted.json';

/** 桶里的相对路径（`/` 分隔）：活任务 / 删除标记。 */
export function scheduleObjectRel(sessionId: string, id: string, deleted = false): string {
  return `${SCHEDULES_REL}/${sessionId}/${encodeURIComponent(id)}${deleted ? DELETED_SUFFIX : '.json'}`;
}

/** `scheduleObjectRel` 的逆；不是这个布局的返回 null。 */
export function parseScheduleObjectRel(rel: string): { sessionId: string; id: string; deleted: boolean } | null {
  const parts = rel.split('/');
  if (parts.length !== 3 || parts[0] !== SCHEDULES_REL || !parts[1] || !parts[2].endsWith('.json')) return null;
  const deleted = parts[2].endsWith(DELETED_SUFFIX);
  const raw = parts[2].slice(0, -(deleted ? DELETED_SUFFIX : '.json').length);
  let id: string;
  try { id = decodeURIComponent(raw); } catch { return null; }
  if (!id) return null;
  return { sessionId: parts[1], id, deleted };
}

/**
 * 列表 → 每个 id 要怎么看：有删除标记 = 删了（不用再下载活的那份，删除永远胜）；只有活的 = 要下载解析。
 * 同一个 id 挂在两条会话下的，以先见到的为准（另一条在 `planScheduleSync` 里按会话对不上跳过）。
 */
export function collectBucketSchedules(rels: string[]): {
  deleted: Map<string, { sessionId: string }>;
  live: Map<string, { sessionId: string; rel: string }>;
} {
  const deleted = new Map<string, { sessionId: string }>();
  const live = new Map<string, { sessionId: string; rel: string }>();
  for (const rel of rels) {
    const k = parseScheduleObjectRel(rel);
    if (!k) continue;
    if (k.deleted) { if (!deleted.has(k.id)) deleted.set(k.id, { sessionId: k.sessionId }); }
    else if (!live.has(k.id)) live.set(k.id, { sessionId: k.sessionId, rel });
  }
  for (const id of deleted.keys()) live.delete(id);
  return { deleted, live };
}

/** 本机这台：设备 ID（runner 的值）+ 主机名（只用来显示）。 */
export interface ScheduleMachine { id: string; name: string }

/** 运行状态：只有 runner 写。 */
export const RUN_KEYS = ['runs', 'lastRunAt', 'lastError', 'lastCheckHash', 'lastCheck', 'checkErrors', 'terminal', 'statusBy', 'statusAt'] as const;
/** 执行者：按 `runnerChangedAt` 后者胜（远端不能改成本机）。 */
export const RUNNER_KEYS = ['runner', 'runnerName', 'runnerChangedAt', 'takenOverAt'] as const;
const PAUSE_KEYS = ['paused', 'pausedBy', 'pausedChangedAt'] as const;
const EXPIRY_KEYS = ['expiresAt', 'expiryChangedAt'] as const;

function copyKeys(into: any, from: any, keys: readonly string[]): void {
  for (const k of keys) {
    if (from[k] === undefined) delete into[k];
    else into[k] = from[k];
  }
}

function sameKeys(a: any, b: any, keys: readonly string[]): boolean {
  return keys.every((k) => JSON.stringify(a?.[k] ?? null) === JSON.stringify(b?.[k] ?? null));
}

/** 键排好序的 JSON —— 比较「两份是不是一样」用，不受字段顺序影响。 */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** 定义（会发什么、跑什么命令、目标、周期、属于哪条会话）的摘要。本机确认过的就是这个值。 */
export function definitionHash(state: Pick<ScheduleState, 'spec' | 'sessionId'>): string {
  return crypto.createHash('sha256').update(stableStringify({ sessionId: state.sessionId, spec: state.spec })).digest('hex');
}

/** runner 是本机吗（只看字段，不看确认过没有）。老文件没有 runner = 本机建的。 */
export function isRunnerHere(state: ScheduleState, me: string): boolean {
  return !state.runner || state.runner === me;
}

/** 本机能不能跑它：runner 是本机，而且定义是本机确认过的（本机建的 / 接管时确认的）。 */
export function canRunHere(state: ScheduleState, me: string, approvedHash: string | undefined): boolean {
  return state.runner === me && !!approvedHash && approvedHash === definitionHash(state);
}

/**
 * 算「下一次什么时候」用的那份：接管过的，锚点是接管那一刻 —— 接管后的第一次从现在算，不补跑错过的
 * （`once` 不受影响：它只看 `atEpoch`）。只用来判断到没到点 / 显示，**不写盘**。
 */
export function timingState(state: ScheduleState): ScheduleState {
  const at = state.takenOverAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) return state;
  if (state.lastRunAt !== null && state.lastRunAt >= at) return state;
  return { ...state, lastRunAt: at };
}

/**
 * **本机写盘前盖戳**（`scheduleStore.writeSchedule` 调）：
 *   · 新建的、老文件没有 runner 的 → runner = 本机（建任务的电脑是初始 runner）；
 *   · 盘上的 runner / 暂停 / 过期比这次要写的新（这次的 state 是更早读的，期间同步或接管改过）→ 保留盘上的，不倒回去；
 *   · 暂停 / 过期真的变了 → 记下这次操作的时刻（控制操作按时间后者胜）；
 *   · 运行状态变了 → 记下是本机、什么时候写的。
 */
export function stampLocalWrite(prev: ScheduleState | null, next: ScheduleState, me: ScheduleMachine, now: number): ScheduleState {
  const out: any = { ...next };
  if (!out.runner) {
    out.runner = prev?.runner || me.id;
    out.runnerName = prev?.runner ? prev.runnerName : me.name;
    out.runnerChangedAt = prev?.runner ? prev.runnerChangedAt : (out.createdAt || now);
  }
  if (!prev) {
    if (out.statusAt === undefined) { out.statusBy = me.id; out.statusAt = now; }
    return out;
  }
  if ((prev.runnerChangedAt ?? 0) > (out.runnerChangedAt ?? 0)) copyKeys(out, prev, RUNNER_KEYS);
  if ((prev.pausedChangedAt ?? 0) > (out.pausedChangedAt ?? 0)) copyKeys(out, prev, PAUSE_KEYS);
  else if (!sameKeys(prev, out, ['paused', 'pausedBy'])) out.pausedChangedAt = now;
  if ((prev.expiryChangedAt ?? 0) > (out.expiryChangedAt ?? 0)) copyKeys(out, prev, EXPIRY_KEYS);
  else if (!sameKeys(prev, out, ['expiresAt'])) out.expiryChangedAt = now;
  if (!sameKeys(prev, out, RUN_KEYS.filter((k) => k !== 'statusBy' && k !== 'statusAt'))) {
    out.statusBy = me.id;
    out.statusAt = now;
  }
  return out;
}

/**
 * 接管到本机：runner 改成本机、`runnerChangedAt` = `takenOverAt` = now。第一次运行从 now 算（`timingState`）。
 * **运行状态的基准也在这一刻立起来**：接管那一刻本机看到的运行状态记成「新执行者写的」（statusBy = 本机、statusAt = now）——
 * 之后合并只认它和新执行者后来写的，旧执行者在接管之后、拉到之前多跑的那次，哪台电脑都不收（`mergeSchedule`）。
 */
export function takeOver(state: ScheduleState, me: ScheduleMachine, now: number): ScheduleState {
  return { ...state, runner: me.id, runnerName: me.name, runnerChangedAt: now, takenOverAt: now, statusBy: me.id, statusAt: now };
}

export interface MergeNotes {
  /** 远端想把 runner 改成本机（只有本机的接管能改）：没收。 */
  refusedAssign?: boolean;
  /** 本机是 runner，远端改了定义：没收（本机这份不变）。 */
  defRejected?: boolean;
  /** 本机原来是 runner，被别的电脑接管了（`runnerChangedAt` 后者胜）：本机停掉它的定时器。值 = 新 runner。 */
  lostTo?: string;
  /** 交出执行权之前（接管时刻之后）本机又跑过一次 —— 同步延迟期间可以接受，记一行日志。 */
  ranAfterHandover?: boolean;
  /** 本机是 runner，远端那份是旧 runner 在接管之后又写的运行状态：不认（只认本机的）。值 = 那台的设备 ID。 */
  ignoredRunBy?: string;
}

/**
 * **两份合成一份**（本机那份 + 桶里那份）。`me` = 本机设备 ID。规则见文件头。sessionId 永远用本机的。
 */
export function mergeSchedule(local: ScheduleState, remote: ScheduleState, me: string): { state: ScheduleState; notes: MergeNotes } {
  const out: any = { ...local };
  const notes: MergeNotes = {};
  const localRunner = local.runner || me;
  if (!local.runner) { out.runner = me; }
  /* 1. 执行者：runnerChangedAt 后者胜；远端不能把它改成本机 */
  const lt = local.runnerChangedAt ?? 0;
  const rt = remote.runnerChangedAt ?? 0;
  /*
    后者胜；**同一毫秒**（两台几乎同时接管）按设备 ID 定一个唯一的胜者（字符串大的那个）——
    两边各自合并都得到同一个 runner，不会两台都认为是自己、一直各跑各的
  */
  const remoteWinsTie = rt === lt && !!remote.runner && remote.runner !== localRunner && remote.runner > localRunner;
  const remoteNewer = rt > lt || remoteWinsTie;
  if (remoteNewer && remote.runner && remote.runner !== localRunner) {
    if (remote.runner === me) notes.refusedAssign = true;
    else {
      copyKeys(out, remote, RUNNER_KEYS);
      if (localRunner === me) notes.lostTo = remote.runner;
    }
  } else if (remoteNewer && remote.runner === localRunner && localRunner !== me) {
    copyKeys(out, remote, RUNNER_KEYS);   // 同一个 runner，名字 / 接管时刻跟它自己写的
  }
  const runnerNow: string = out.runner;
  /* 2. 定义：本机是（原来的）runner → 留本机的；否则跟桶里的（只是显示，要跑得先接管确认） */
  if (localRunner === me) {
    if (stableStringify(remote.spec) !== stableStringify(local.spec)) notes.defRejected = true;
  } else {
    out.spec = remote.spec;
    out.createdAt = remote.createdAt;
    if (remote.createdBy === undefined) delete out.createdBy; else out.createdBy = remote.createdBy;
  }
  /* 3. 运行状态：只认 runner 写的 */
  if (runnerNow === me) {
    const since = local.takenOverAt ?? 0;
    if (since && remote.statusBy && remote.statusBy !== me && (remote.statusAt ?? 0) > since
      && !sameKeys(local, remote, RUN_KEYS)) notes.ignoredRunBy = remote.statusBy;
  } else {
    /*
      只认现在的执行者写的；两份都不是它写的（比如老数据），只收**执行权交接之前**写的那份 ——
      交接之后别的电脑写的运行状态（旧执行者没拉到接管又跑了一次）一律不收，两份都是那样就保留本机原来的
    */
    const handoverAt = out.runnerChangedAt ?? 0;
    const byRunner = [local, remote].filter((s) => s.statusBy === runnerNow);
    const beforeHandover = [local, remote].filter((s) => (s.statusAt ?? 0) <= handoverAt);
    const pool = byRunner.length ? byRunner : beforeHandover;
    if (pool.length) {
      const pick = pool.reduce((a, b) => ((b.statusAt ?? 0) > (a.statusAt ?? 0) ? b : a));
      copyKeys(out, pick, RUN_KEYS);
    }
    if (notes.lostTo && local.statusBy === me && (local.statusAt ?? 0) > (out.runnerChangedAt ?? 0)) notes.ranAfterHandover = true;
  }
  /* 4. 控制操作：各按各的时刻，后者胜 */
  /*
    暂停 / 继续：按时刻后者胜 —— 但「检查命令连续出错自动暂停」（pausedBy: 'check-errors'）是**运行结果**，不是用户操作：
    只认现在的执行者写的，或者是交接之前就有的；旧执行者在交接之后（还没拉到接管时）自动暂停的不算数。
    两份都不算数 → 不暂停（新执行者自己检查，出错它自己会停）。用户在任何一台上按的暂停 / 继续照旧都认。
  */
  const pauseHandoverAt = out.runnerChangedAt ?? 0;
  const pauseCounts = (x: ScheduleState) => x.pausedBy !== 'check-errors' || x.statusBy === runnerNow || (x.pausedChangedAt ?? 0) <= pauseHandoverAt;
  const pauses = [local, remote].filter(pauseCounts);
  if (!pauses.length) { out.paused = false; out.pausedBy = null; }
  else {
    const pick = pauses.reduce((a, b) => ((b.pausedChangedAt ?? 0) > (a.pausedChangedAt ?? 0) ? b : a));
    copyKeys(out, pick, PAUSE_KEYS);
  }
  if ((remote.expiryChangedAt ?? 0) > (local.expiryChangedAt ?? 0)) copyKeys(out, remote, EXPIRY_KEYS);
  out.sessionId = local.sessionId;
  return { state: out, notes };
}

/** 桶里一个对象的内容：活的任务，或者删除标记。 */
export type RemoteSchedule =
  | { kind: 'live'; state: ScheduleState }
  | { kind: 'deleted'; at: number };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): number | null | undefined => (v === null ? null : num(v) ? v : undefined);
const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);

/** spec 只挑认得的字段、类型都对、过得了 `validateSchedule` 才收。 */
function cleanSpec(raw: any): ScheduleSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!['interval', 'daily', 'weekly', 'once'].includes(raw.kind)) return null;
  if (typeof raw.prompt !== 'string' || raw.prompt.length > 200_000) return null;
  const spec: ScheduleSpec = {
    prompt: raw.prompt,
    kind: raw.kind,
    everySec: num(raw.everySec) ? raw.everySec : 0,
    maxRuns: raw.maxRuns === null ? null : num(raw.maxRuns) ? raw.maxRuns : NaN,
  };
  if (raw.atTime !== undefined) { if (typeof raw.atTime !== 'string') return null; spec.atTime = raw.atTime; }
  if (raw.weekday !== undefined) { if (!num(raw.weekday)) return null; spec.weekday = raw.weekday; }
  if (raw.atEpoch !== undefined) { if (!num(raw.atEpoch)) return null; spec.atEpoch = raw.atEpoch; }
  if (raw.until !== undefined) { if (typeof raw.until !== 'string' || raw.until.length > 20_000) return null; spec.until = raw.until; }
  if (raw.checkCommand !== undefined) { if (typeof raw.checkCommand !== 'string' || raw.checkCommand.length > 20_000) return null; spec.checkCommand = raw.checkCommand; }
  if (validateSchedule(spec, 'en').length) return null;
  return spec;
}

const TERMINALS = ['completed', 'exhausted', 'cancelled', 'achieved', 'expired'];

/**
 * **桶里来的对象 → 一份干净的任务（或删除标记）**，认不出就 null（这一条不动）。只挑认得的字段，
 * id / 会话必须和 key 里的一样，必须带 runner。不做任何「执行」相关的判断 —— 那在 `canRunHere`。
 */
export function parseRemoteSchedule(text: string, id: string, sessionId: string): RemoteSchedule | null {
  let o: any;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || o.id !== id || o.sessionId !== sessionId) return null;
  if (o.deleted) return num(o.deleted.at) ? { kind: 'deleted', at: o.deleted.at } : null;
  const s = o.state;
  if (!s || typeof s !== 'object' || s.sessionId !== sessionId) return null;
  const spec = cleanSpec(s.spec);
  if (!spec) return null;
  const runner = str(s.runner);
  if (!runner || !num(s.runnerChangedAt)) return null;
  if (!num(s.runs) || s.runs < 0 || !Number.isInteger(s.runs) || !num(s.createdAt)) return null;
  const lastRunAt = numOrNull(s.lastRunAt);
  if (lastRunAt === undefined) return null;
  const state: ScheduleState = {
    spec, sessionId, runs: s.runs, createdAt: s.createdAt, lastRunAt,
    lastError: typeof s.lastError === 'string' ? s.lastError.slice(0, 4000) : null,
    paused: s.paused === true,
    terminal: TERMINALS.includes(s.terminal) ? s.terminal : null,
    runner, runnerChangedAt: s.runnerChangedAt,
  };
  const name = str(s.runnerName); if (name) state.runnerName = name;
  if (s.createdBy === 'model') state.createdBy = 'model';
  const exp = numOrNull(s.expiresAt); if (exp !== undefined) state.expiresAt = exp;
  if (typeof s.lastCheckHash === 'string' && s.lastCheckHash.length <= 200) state.lastCheckHash = s.lastCheckHash;
  if (num(s.checkErrors) && s.checkErrors >= 0) state.checkErrors = s.checkErrors;
  const lc = s.lastCheck;
  if (lc && typeof lc === 'object' && num(lc.at) && ['achieved', 'unchanged', 'changed', 'error'].includes(lc.result)
    && (lc.code === null || num(lc.code)) && typeof lc.output === 'string') {
    state.lastCheck = { at: lc.at, result: lc.result, code: lc.code, output: lc.output.slice(-(CHECK_OUTPUT_KEEP + 1)) };
  }
  if (s.pausedBy === 'check-errors') state.pausedBy = 'check-errors';
  const took = numOrNull(s.takenOverAt); if (took !== undefined) state.takenOverAt = took;
  const by = str(s.statusBy); if (by) state.statusBy = by;
  for (const k of ['statusAt', 'pausedChangedAt', 'expiryChangedAt'] as const) if (num(s[k])) (state as any)[k] = s[k];
  return { kind: 'live', state };
}

/** 传到桶里的那份（活的）。 */
export function remoteBody(id: string, state: ScheduleState, now: number): string {
  return JSON.stringify({ v: 1, id, sessionId: state.sessionId, state, updatedAt: now }, null, 2);
}

/** 传到桶里的删除标记。 */
export function tombstoneBody(id: string, sessionId: string, at: number, by: string): string {
  return JSON.stringify({ v: 1, id, sessionId, deleted: { at, by } }, null, 2);
}

/** 本机删过的任务（删除标记，不同步的本地账）。 */
export type ScheduleTombstones = Record<string, { at: number; sessionId: string; pushed?: boolean }>;

export type SyncAction =
  /** 本机这份改成合并结果 / 新拉下来的（不盖戳的原样写）。 */
  | { op: 'write'; id: string; state: ScheduleState; adopted: boolean; notes: MergeNotes }
  /** 桶里是删除标记（或本机有删除标记）：删掉本机这份。 */
  | { op: 'delete'; id: string; sessionId: string }
  /** 桶里是删除标记、本机没有这份：本机也记一笔删除，以后不再拉 / 传。 */
  | { op: 'remember-deleted'; id: string; sessionId: string; at: number }
  | { op: 'put'; id: string; sessionId: string; state: ScheduleState }
  | { op: 'put-tombstone'; id: string; sessionId: string; at: number };

export interface SyncPlanInput {
  me: string;
  /** 本机的任务（已经去掉 advanced 的）。 */
  local: Array<{ id: string; state: ScheduleState }>;
  tombstones: ScheduleTombstones;
  /** 桶里的：id → 会话 + 解析结果（null = 认不出，这一条不动）。 */
  remote: Map<string, { sessionId: string; parsed: RemoteSchedule | null }>;
  /** 这条会话在同步范围里吗（本机有这条、跟随备份开关 / 跨电脑同步规则）。 */
  inScope: (sessionId: string) => boolean;
  /** false = 只拉不传（恢复会话时）。 */
  upload: boolean;
}

/**
 * **这一轮对每条任务做什么**。不在同步范围里的会话的任务：不传、不拉。删除标记永远胜，不会被补回。
 */
export function planScheduleSync(input: SyncPlanInput): SyncAction[] {
  const out: SyncAction[] = [];
  const localById = new Map(input.local.map((j) => [j.id, j]));
  const ids = new Set<string>([...localById.keys(), ...input.remote.keys(), ...Object.keys(input.tombstones)]);
  for (const id of [...ids].sort()) {
    const local = localById.get(id);
    const tomb = input.tombstones[id];
    const r = input.remote.get(id);
    const remote = r?.parsed ?? null;
    if (r && !r.parsed) continue;   // 桶里那份认不出：两边都不动
    const sessionId = local?.state.sessionId ?? tomb?.sessionId ?? r?.sessionId ?? '';
    /* 会话对不上（桶里那份挂在别的会话下）：不动 */
    if (r && r.sessionId !== sessionId) continue;
    if (tomb) {
      if (local) out.push({ op: 'delete', id, sessionId });
      /*
        桶里还没有删除标记就传（桶里这一轮没列到活任务也传）：另一台电脑可能正要上传它读到的旧任务，
        标记是单独的对象，先到后到都盖不掉它。只有 id / 会话 / 时刻，不带任务内容。
      */
      if (remote?.kind !== 'deleted' && input.upload) out.push({ op: 'put-tombstone', id, sessionId, at: tomb.at });
      continue;
    }
    if (remote?.kind === 'deleted') {
      if (local) out.push({ op: 'delete', id, sessionId });
      else out.push({ op: 'remember-deleted', id, sessionId, at: remote.at });
      continue;
    }
    if (!input.inScope(sessionId)) continue;
    if (!local) {
      if (remote?.kind === 'live') out.push({ op: 'write', id, state: remote.state, adopted: true, notes: {} });
      continue;
    }
    if (!remote) {
      if (input.upload) out.push({ op: 'put', id, sessionId, state: local.state });
      continue;
    }
    const { state, notes } = mergeSchedule(local.state, remote.state, input.me);
    if (stableStringify(state) !== stableStringify(local.state) || Object.keys(notes).length) {
      out.push({ op: 'write', id, state, adopted: false, notes });
    }
    if (input.upload && stableStringify(state) !== stableStringify(remote.state)) out.push({ op: 'put', id, sessionId, state });
  }
  return out;
}

