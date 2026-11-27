/**
 * SCHEDULED TASKS ON DISK, one JSON file per job.
 *
 * A schedule that dies with the window is a timer, not a schedule. "Every Monday 9am"
 * has to survive closing the app, restarting it, and crashing — which is exactly what the
 * old loop could not do (its state lived in the renderer's `loopsRef`, so a reload reset
 * it).
 *
 * `home` is a PARAMETER, as in flowStore/loopStore: a module that reads `os.homedir()`
 * internally can only be tested by writing into the user's real data.
 */

import fs from 'fs';
import path from 'path';
import type { ScheduleState } from './schedule.ts';
import { definitionHash, stampLocalWrite, type ScheduleMachine, type ScheduleTombstones } from './scheduleSync.ts';

export interface StoredSchedule {
  id: string;
  state: ScheduleState;
  updatedAt: number;
}

/**
 * 这条会话的定时任务**不归调用方管**（标准版里 = KiroLex Advanced 的会话，判据在 `advancedOnly.ts`，
 * 由 index.ts 传 `store.isAdvancedOnlySession` 进来）。是的话：列表不列、写入抛错、删除跳过 ——
 * 已有的任务文件字节不变，没有的也不新建。不传就是老行为。
 */
export type Protected = (sessionId: string) => boolean;

export function scheduleDir(home: string): string {
  return path.join(home, '.kirolex', 'schedules');
}

function scheduleFile(id: string, home: string): string {
  return path.join(scheduleDir(home), `${encodeURIComponent(id)}.json`);
}

/**
 * 本机是哪台（跨电脑同步，见 `scheduleSync.ts`）。index.ts 启动时设；不设（单测）= 老行为：写盘不盖戳。
 * 设了之后本机的每次写都经 `stampLocalWrite`：新建的 runner = 本机并记成「本机确认过」；控制操作 / 运行状态记下时刻。
 */
let localMachine: ScheduleMachine | null = null;
export function setLocalScheduleMachine(m: ScheduleMachine | null): void { localMachine = m; }

/** Atomic: temp + rename. A partially written job could otherwise read back with a lower
 *  run count and hand itself budget it had already spent. */
export function writeSchedule(id: string, state: ScheduleState, home: string, isProtected?: Protected): void {
  const prev = readSchedule(id, home);
  if (isProtected && (isProtected(state.sessionId) || isProtected(prev?.state.sessionId ?? ''))) {
    throw new Error('This session belongs to KiroLex Advanced; the standard edition does not modify it.');
  }
  if (!localMachine) { writeScheduleRaw(id, state, home); return; }
  /* 删过的不再写回来（删除期间还在跑的那一次最后会写一下）—— 删除标记永远胜 */
  if (readScheduleTombstones(home)[id]) return;
  const stamped = stampLocalWrite(prev?.state ?? null, state, localMachine, Date.now());
  /* 本机建的（或老文件第一次补上 runner）：定义记成本机确认过 —— 调度器只跑确认过的（`canRunHere`） */
  if (!prev?.state.runner && !state.runner && stamped.runner === localMachine.id) approveSchedule(id, definitionHash(stamped), home);
  writeScheduleRaw(id, stamped, home);
}

/** 原样写（不盖戳、不看删除标记）：同步合并的结果 / 从桶里拉下来的用它。 */
export function writeScheduleRaw(id: string, state: ScheduleState, home: string): void {
  const dir = scheduleDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = scheduleFile(id, home);
  const tmp = `${file}.tmp`;
  const payload: StoredSchedule = { id, state, updatedAt: Date.now() };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/** Null when absent or unparseable. A truncated file must NOT read as a fresh job at run
 *  0, which would restart something that had already spent its budget. */
export function readSchedule(id: string, home: string): StoredSchedule | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(scheduleFile(id, home), 'utf-8')) as StoredSchedule;
    if (!parsed?.state?.spec || typeof parsed.state.runs !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Every job on disk. This is how the app finds its schedules after a restart — nothing
 *  survives in memory, so enumeration is the only entry point. */
export function listSchedules(home: string, isProtected?: Protected): StoredSchedule[] {
  let names: string[];
  try { names = fs.readdirSync(scheduleDir(home)); } catch { return []; }
  const out: StoredSchedule[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const job = readSchedule(decodeURIComponent(name.slice(0, -'.json'.length)), home);
    if (job && !isProtected?.(job.state.sessionId)) out.push(job);
  }
  return out.sort((a, b) => a.state.createdAt - b.state.createdAt);
}

export function removeSchedule(id: string, home: string, isProtected?: Protected): void {
  const existing = readSchedule(id, home);
  if (isProtected?.(existing?.state.sessionId ?? '')) return;
  /* 删除标记（跨电脑同步）：别的电脑拉到后删掉它们那份，本机也不会再被补回来 */
  if (existing && localMachine) addScheduleTombstone(id, existing.state.sessionId, Date.now(), home);
  try { fs.rmSync(scheduleFile(id, home), { force: true }); } catch { /* already gone */ }
  forgetApproval(id, home);
}

/**
 * **只删本机副本**（结束满 7 天自动清理、而执行者那台失联时）：本地账上记一笔 `localOnly` 删除 ——
 * 不往桶里传删除标记（执行者回来后自己清），但同步也不会再把它拉回来。
 */
export function removeScheduleLocalOnly(id: string, home: string, isProtected?: Protected): void {
  const existing = readSchedule(id, home);
  if (!existing || isProtected?.(existing.state.sessionId)) return;
  const map = readScheduleTombstones(home);
  if (!map[id]) {
    map[id] = { at: Date.now(), sessionId: existing.state.sessionId, localOnly: true };
    writeJsonMap(tombstonesFile(home), map);
  }
  try { fs.rmSync(scheduleFile(id, home), { force: true }); } catch { /* already gone */ }
  forgetApproval(id, home);
}

/* ── 跨电脑同步的两本本地账（都不同步）：删除标记、本机确认过的定义 ── */

function tombstonesFile(home: string): string { return path.join(home, '.kirolex', 'schedule-tombstones.json'); }
function approvalsFile(home: string): string { return path.join(home, '.kirolex', 'schedule-approved.json'); }

function readJsonMap(file: string): Record<string, any> {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

function writeJsonMap(file: string, map: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/** 本机删过的任务：id → 删除时刻 + 会话；`pushed` = 桶里那份已经是删除标记了（以后不用再去看）。 */
export function readScheduleTombstones(home: string): ScheduleTombstones {
  const out: ScheduleTombstones = {};
  for (const [id, v] of Object.entries(readJsonMap(tombstonesFile(home)))) {
    if (v && typeof v.at === 'number' && typeof v.sessionId === 'string') out[id] = { at: v.at, sessionId: v.sessionId, ...(v.pushed ? { pushed: true } : {}), ...(v.localOnly ? { localOnly: true } : {}) };
  }
  return out;
}

export function addScheduleTombstone(id: string, sessionId: string, at: number, home: string, pushed = false): void {
  const map = readScheduleTombstones(home);
  if (map[id] && (map[id].pushed || !pushed)) return;
  map[id] = { at: map[id]?.at ?? at, sessionId: map[id]?.sessionId ?? sessionId, ...(pushed ? { pushed: true } : {}) };
  writeJsonMap(tombstonesFile(home), map);
}

/** 本机确认过的定义摘要（`definitionHash`）。 */
export function readApprovedHash(id: string, home: string): string | undefined {
  const v = readJsonMap(approvalsFile(home))[id];
  return typeof v === 'string' ? v : undefined;
}

export function approveSchedule(id: string, hash: string, home: string): void {
  const map = readJsonMap(approvalsFile(home));
  if (map[id] === hash) return;
  map[id] = hash;
  writeJsonMap(approvalsFile(home), map);
}

function forgetApproval(id: string, home: string): void {
  const map = readJsonMap(approvalsFile(home));
  if (!(id in map)) return;
  delete map[id];
  try { writeJsonMap(approvalsFile(home), map); } catch { /* 下次再清 */ }
}

/**
 * 删会话时把它的定时任务一起删掉（同 `bgJobs.stopSession`）：不然任务文件留着，定时器照样到点跑它的
 * `checkCommand`（本机 shell），会话没了界面上也看不见。返回删掉的那几条；受保护的（advanced）不碰。
 */
export function removeSessionSchedules(sessionId: string, home: string, isProtected?: Protected): StoredSchedule[] {
  if (!sessionId) return [];
  const doomed = listSchedules(home, isProtected).filter((job) => job.state.sessionId === sessionId);
  for (const job of doomed) removeSchedule(job.id, home, isProtected);
  return doomed;
}
