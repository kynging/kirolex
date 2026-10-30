/**
 * **久未使用的会话「移到云端」**（offload）——「超过 30 天不用的会话要不要直接删掉丢远程」。
 *
 * 不是删除：确认云端那份是最新的之后，把本机的 `sessions/<id>/` 挪进本机回收站，侧栏留一个占位（☁），
 * 点开时从云端恢复（`s3:restore`）。所以这里有三条铁律：
 *
 *   1. **拿不准就不移**。判定（`decideOffload`）的每一项输入都可以是 `null`（判断不了）—— 任何一项是 null 就不移；
 *      动手之前再把云端对象和本机文件逐个核对一遍（`verifyCloudCopy`：数量 + 摘要），对不上也不移。
 *   2. **绝不写删除记录**（`deleted-sessions.json` / `s3-deleted-at.json` / 设备清单里的 deleted）。否则 cloudTrash
 *      会把它判成「所有设备都删了」移进云端回收站。本机目录挪进回收站时用 `offload-<时间>/<id>` 这种名字 ——
 *      `deletionsFromTrashNames` 只认 `<id>__<ISO 时间>`，认不出这种；同步时清单把占位的 id 当成「本机仍持有」上报
 *      （`manifestSessionsWithOffloaded`）。
 *   3. **占位只在本机**（`~/.kirolex/sessions-offloaded.json`，不在同步白名单里）。别的电脑上的同一条会话不受影响。
 *
 * 纯逻辑 + 文件 I/O（路径都由参数传入），不 import electron —— 测试用临时目录和内存假桶。
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { keyFor, relFor, sessionPrefix, SESSION_FILES, SESSION_FILES_DIR, walkSessionFiles, type SessionSyncMark, type SyncConfig } from './s3Sync.ts';

const DAY_MS = 86_400_000;

/** 一轮同步之后最多移几条 —— 一次腾太多，万一判据有错，影响面也大。 */
export const MAX_OFFLOAD_PER_ROUND = 20;
export const DEFAULT_OFFLOAD_DAYS = 30;
/** 设置里的天数选项。 */
export const OFFLOAD_DAY_CHOICES = [14, 30, 60, 90, 180];
/** 占位记录文件（相对 `~/.kirolex`）。 */
export const OFFLOAD_STATE_FILE = 'sessions-offloaded.json';

/**
 * 会话目录里**只在本机、丢了也无妨**的那几个文件：运行事件时间戳（`eventLog.ts`）、上一次注入的调试快照。
 * 它们不进备份，所以云上没有；挪进本机回收站等它按 30 天规则清掉就是了。
 * 除此之外，本机有、云上没有的文件一律让这条**不移**（例如 `context-override.md`、`pending-handoffs.json`、
 * files/ 里不进备份的依赖目录 / 压缩包）—— 移了它们就只剩回收站里那一份，30 天后就没了。
 */
const LOCAL_ONLY_FILES = new Set(['events.jsonl', 'last-injection.md']);

/* ------------------------------------------------------------------ 设置 */

export interface OffloadSettings { enabled: boolean; days: number }

/** `s3Sync.autoOffload`（缺省开）+ `s3Sync.offloadIdleDays`（缺省 30；0 = 不移；乱填回默认）。 */
export function offloadSettings(cfg: { autoOffload?: unknown; offloadIdleDays?: unknown } | null | undefined): OffloadSettings {
  const raw = cfg?.offloadIdleDays;
  let days = DEFAULT_OFFLOAD_DAYS;
  if (raw !== undefined && raw !== null) {
    const n = Math.floor(Number(raw));
    if (n === 0) days = 0;
    else if (Number.isFinite(n) && n > 0) days = Math.min(3650, n);
  }
  return { enabled: cfg?.autoOffload !== false && days > 0, days };
}

/**
 * 这一轮整个不跑的原因（null = 可以跑）：S3 备份没开、没配好（凭据 / 桶有问题）、或者设置里关掉了。
 * 只给日志用；界面自己按配置说原因。
 */
export function offloadBlocked(cfg: SyncConfig & { autoOffload?: unknown; offloadIdleDays?: unknown }, credsProblem: string | null | undefined): string | null {
  if (!cfg?.enabled) return 'S3 backup is not enabled';
  if (credsProblem) return `S3 backup is not configured: ${credsProblem}`;
  if (!offloadSettings(cfg).enabled) return 'auto offload is turned off';
  return null;
}

/* ------------------------------------------------------------------ 判定 */

/**
 * 判定一条会话要用到的全部事实。**每一项都可以是 null = 判断不了**，那就不移。
 * 由 index.ts 收集（它知道执行器、排队、定时、循环、后台命令、分屏这些运行时状态）。
 */
export interface OffloadFacts {
  id: string;
  /** record.updatedAt */
  updatedAt: number | null;
  /** transcript 最后一条消息的 ts（`lastMessageTs`；没有消息 = 0） */
  lastMessageAt: number | null;
  /** catalog 里有这条 */
  inCatalog: boolean | null;
  /** 这条最后一次真的上传（`s3-session-sync.json`）；没传过 = undefined；读不了 = null */
  mark: Pick<SessionSyncMark, 'at' | 'updatedAt'> | undefined | null;
  /** 要备份的那些文件和同步状态表（size + mtime）全都一致 —— 最后一次上传之后没改过（`filesMatchSyncState`） */
  filesClean: boolean | null;
  /** 当前打开的 / 分屏里显示的 / 连着执行器的 */
  open: boolean | null;
  /** 正在跑一轮（或 attach / 换执行器中） */
  busy: boolean | null;
  /** 有排队消息 */
  queued: boolean | null;
  /** 挂着定时任务 */
  scheduled: boolean | null;
  /** 挂着循环 */
  looping: boolean | null;
  /** 有在跑的后台命令 */
  bgJobs: boolean | null;
  /** 有没消费 / 失败待处理的追加指令（steer） */
  pendingSteers: boolean | null;
  /** 置顶 */
  pinned: boolean | null;
  /** advanced 专属（flow / skill）—— 一律不移 */
  advancedOnly: boolean | null;
  /** 所在项目设成了不备份 */
  excludedProject: boolean | null;
  /** 这条会话单独设成了不备份 */
  excludedSession: boolean | null;
  /** 用户选了「保留在本机，不再自动移走」 */
  keepLocal: boolean | null;
  /** 已经移到云端了 */
  offloaded: boolean | null;
}

export type OffloadSkipReason =
  | 'unknown' | 'disabled' | 'offloaded' | 'advanced' | 'excluded' | 'keep-local' | 'pinned' | 'open' | 'busy'
  | 'queued' | 'pending-steers' | 'scheduled' | 'looping' | 'bg-jobs' | 'recent' | 'not-in-catalog' | 'unsynced';

export type OffloadVerdict = { offload: true; lastActiveAt: number } | { offload: false; reason: OffloadSkipReason };

const validTime = (t: unknown, now: number): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= now + 60_000;

/** 最后活动时间：record.updatedAt 和 transcript 最后一条消息时间取较晚的。任一判断不了 → null。 */
export function lastActivityAt(updatedAt: number | null, lastMessageAt: number | null): number | null {
  if (updatedAt === null || lastMessageAt === null) return null;
  return Math.max(updatedAt, lastMessageAt);
}

/** **这条会话现在能不能移到云端**。纯函数；顺序：判断不了 → 关着 → 各种排除 → 不够久 → 云端不是最新。 */
export function decideOffload(f: OffloadFacts, opts: { now: number; idleDays: number }): OffloadVerdict {
  const no = (reason: OffloadSkipReason): OffloadVerdict => ({ offload: false, reason });
  const flags = [f.inCatalog, f.filesClean, f.open, f.busy, f.queued, f.scheduled, f.looping, f.bgJobs, f.pendingSteers,
    f.pinned, f.advancedOnly, f.excludedProject, f.excludedSession, f.keepLocal, f.offloaded];
  if (flags.some((x) => typeof x !== 'boolean')) return no('unknown');
  if (!validTime(f.updatedAt, opts.now) || !validTime(f.lastMessageAt, opts.now)) return no('unknown');
  if (f.mark === null) return no('unknown');
  if (!(opts.idleDays > 0)) return no('disabled');
  if (f.offloaded) return no('offloaded');
  if (f.advancedOnly) return no('advanced');
  if (f.excludedProject || f.excludedSession) return no('excluded');
  if (f.keepLocal) return no('keep-local');
  if (f.pinned) return no('pinned');
  if (f.open) return no('open');
  if (f.busy) return no('busy');
  if (f.queued) return no('queued');
  if (f.pendingSteers) return no('pending-steers');
  if (f.scheduled) return no('scheduled');
  if (f.looping) return no('looping');
  if (f.bgJobs) return no('bg-jobs');
  const last = lastActivityAt(f.updatedAt, f.lastMessageAt)!;
  if (last > opts.now - opts.idleDays * DAY_MS) return no('recent');
  if (!f.inCatalog) return no('not-in-catalog');
  /* 云端那份确定是最新的：传过（at > 0）、上传时记下的 updatedAt 不早于本机的、文件和状态表一致 */
  const mark = f.mark;
  if (!mark || !(Number(mark.at) > 0) || !(Number(mark.updatedAt) >= f.updatedAt!) || !f.filesClean) return no('unsynced');
  return { offload: true, lastActiveAt: last };
}

/** 这一轮移哪几条：满足条件的按最后活动从旧到新，最多 `MAX_OFFLOAD_PER_ROUND` 条。 */
export function planOffloadRound(facts: OffloadFacts[], opts: { now: number; idleDays: number; max?: number }): {
  picked: Array<{ id: string; lastActiveAt: number }>;
  skipped: Array<{ id: string; reason: OffloadSkipReason }>;
} {
  const ok: Array<{ id: string; lastActiveAt: number }> = [];
  const skipped: Array<{ id: string; reason: OffloadSkipReason }> = [];
  for (const f of facts) {
    const v = decideOffload(f, opts);
    if (v.offload) ok.push({ id: f.id, lastActiveAt: v.lastActiveAt });
    else skipped.push({ id: f.id, reason: v.reason });
  }
  ok.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  return { picked: ok.slice(0, opts.max ?? MAX_OFFLOAD_PER_ROUND), skipped };
}

/* ------------------------------------------------------------------ 事实的辅助 */

/**
 * transcript 最后一条消息的 ts。没有文件 = 0（没有消息）；最后一行读不懂 / 太长 = null（判断不了）。
 * 只从文件尾往前读，不读整份（有的 transcript 几十 MB）。
 */
export function lastMessageTs(file: string): number | null {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch (err: any) { return err?.code === 'ENOENT' ? 0 : null; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return 0;
    const MAX = 16 * 1024 * 1024;
    let chunk = 64 * 1024;
    for (;;) {
      const len = Math.min(size, chunk);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const text = buf.toString('utf-8').replace(/\s+$/, '');
      if (!text) { if (len === size) return 0; }
      else {
        const nl = text.lastIndexOf('\n');
        if (nl >= 0 || len === size) {
          try {
            const ts = JSON.parse(text.slice(nl + 1).trim())?.ts;
            return typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
          } catch { return null; }
        }
      }
      if (len === size || chunk >= MAX) return null;
      chunk *= 4;
    }
  } catch { return null; } finally { try { fs.closeSync(fd); } catch { /* 已关 */ } }
}

/**
 * ui-state 里 `{ 会话 id: [条目…] }` 形状的那几份（排队 `kirolex-queues`、未消费 steer `kirolex-pending-steers`、
 * 失败待处理 steer `kirolex-failed-steers`）里**有条目**的会话 id。没有这一项 = 空集；读不懂 = null（判断不了）。
 */
export function idsWithItems(raw: string | null | undefined): Set<string> | null {
  if (raw === undefined || raw === null || raw === '') return new Set();
  let d: unknown;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const out = new Set<string>();
  for (const [id, items] of Object.entries(d as Record<string, unknown>)) {
    if (!Array.isArray(items)) return null;
    if (items.length) out.add(id);
  }
  return out;
}

/** 这条会话**要备份的**那些文件（相对 home）：和 `planUpload` 同一个口径。 */
function syncedRels(home: string, id: string): string[] {
  const out: string[] = [];
  for (const f of SESSION_FILES) {
    const rel = path.join('sessions', id, f);
    if (fs.existsSync(path.join(home, rel))) out.push(rel);
  }
  out.push(...walkSessionFiles(home, path.join('sessions', id, SESSION_FILES_DIR)));
  return out;
}

/**
 * 要备份的文件是不是全都和同步状态表（`s3-sync-state.json`：size + mtime）一致 —— 也就是最后一次上传之后没改过。
 * 会话目录不在 → null（判断不了）。
 */
export function filesMatchSyncState(home: string, id: string, state: Record<string, { size: number; mtimeMs: number }>): boolean | null {
  if (!fs.existsSync(path.join(home, 'sessions', id))) return null;
  try {
    const rels = syncedRels(home, id);
    if (!rels.length) return false;
    for (const rel of rels) {
      const prev = state[rel];
      if (!prev) return false;
      const st = fs.statSync(path.join(home, rel));
      if (prev.size !== st.size || prev.mtimeMs !== Math.floor(st.mtimeMs)) return false;
    }
    return true;
  } catch { return null; }
}

/** 本机这一轮的设备清单：本机有的照旧，已移到云端的补上 —— 它们在本机「仍持有」，不能被当成删掉了。 */
export function manifestSessionsWithOffloaded<T extends { id: string }>(sessions: T[], st: OffloadState): Array<T | { id: string; project?: string }> {
  const seen = new Set(sessions.map((s) => s.id));
  const out: Array<T | { id: string; project?: string }> = [...sessions];
  for (const p of Object.values(st.offloaded)) {
    if (!p?.id || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ id: p.id, ...(p.project ? { project: p.project } : null) });
  }
  return out;
}

/* ------------------------------------------------------------------ 占位记录 */

export interface OffloadPlaceholder {
  id: string;
  title: string;
  project?: string;
  engine?: string;
  /** 远程会话跑在哪台机器上（显示用）；本机会话没有 */
  remoteHost?: string;
  /** 移走时是归档的（侧栏照旧放在「已归档」里） */
  archived?: boolean;
  /** 移走时算的最后活动时间 */
  lastActiveAt: number;
  offloadedAt: number;
  /** 云端那份的 key 前缀 */
  cloudKey: string;
  /** 本机腾出的字节数 / 文件数 */
  bytes: number;
  files: number;
  /** 本机回收站里那份在哪儿（恢复失败时还能从这里手动拿回来） */
  trashDir?: string;
  /**
   * 这条会话的 transcript 引用的**会话目录之外**的文件（粘贴的图片 `pasted/`、粘贴的长文本 `pastes/`、附件）。
   * 启动时的粘贴垃圾清理只扫 sessions/ 下的 transcript —— 移走之后它们会被当成孤儿删掉，而 `pastes/` 根本不在备份里，
   * 恢复回来就成了点不开的卡片。所以移走时把它们记在占位里，清理时当成仍在用（`offloadedPasteRefs`）。
   */
  externalRefs?: string[];
}

/**
 * transcript 里每条消息的 `attachments[].path` / `pastes[].path`（绝对路径）。文件不在 = 空；
 * 有一行读不懂 = null（判断不了它引用了什么 → 不移）。
 */
export function transcriptExternalRefs(file: string): string[] | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf-8'); } catch (err: any) { return err?.code === 'ENOENT' ? [] : null; }
  const out = new Set<string>();
  for (const line of text.split(String.fromCharCode(10))) {   // CRLF 行尾多出来的回车是空白，JSON.parse 认
    if (!line.trim()) continue;
    let m: any;
    try { m = JSON.parse(line); } catch { return null; }
    for (const a of (Array.isArray(m?.attachments) ? m.attachments : [])) if (typeof a?.path === 'string' && a.path) out.add(path.resolve(a.path));
    for (const x of (Array.isArray(m?.pastes) ? m.pastes : [])) if (typeof x?.path === 'string' && x.path) out.add(path.resolve(x.path));
  }
  return [...out];
}

/**
 * 启动时的粘贴垃圾清理要「当成仍在用」的那些文件：所有占位记下的 `externalRefs`。
 * 占位文件读不了 / 坏了 = null —— 调用方这一次一个都不删（判断不了谁还在用）。
 */
export function offloadedPasteRefs(stateFile: string): Set<string> | null {
  const st = readOffloadStateStrict(stateFile);
  if (!st) return null;
  const out = new Set<string>();
  for (const p of Object.values(st.offloaded)) for (const r of p.externalRefs || []) out.add(path.resolve(r));
  return out;
}

export interface OffloadState {
  version: 1;
  offloaded: Record<string, OffloadPlaceholder>;
  /** 「保留在本机，不再自动移走」 */
  keepLocal: string[];
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;

/** 只给显示用：读不了 / 坏了当空。**判定和写入一律用 `readOffloadStateStrict`**。 */
export function readOffloadState(file: string): OffloadState {
  return readOffloadStateStrict(file) ?? { version: 1, offloaded: {}, keepLocal: [] };
}

/**
 * 严格读：文件不存在 = 空（从没移过）；读不了 / 不是 JSON / 形状不对 = **null（判断不了）**。
 * 坏了的文件里可能有「保留在本机」名单和占位 —— 当成空去判定会移走该保留的，当成空写回会把它们盖掉。
 */
export function readOffloadStateStrict(file: string): OffloadState | null {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch (err: any) { return err?.code === 'ENOENT' ? { version: 1, offloaded: {}, keepLocal: [] } : null; }
  let d: any;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (d.offloaded !== undefined && (typeof d.offloaded !== 'object' || d.offloaded === null || Array.isArray(d.offloaded))) return null;
  if (d.keepLocal !== undefined && !Array.isArray(d.keepLocal)) return null;
  /* 每一条都要认得出来：有一条坏了就整份当「判断不了」—— 静默丢掉它，下次写回就把它覆盖没了 */
  const offloaded: Record<string, OffloadPlaceholder> = {};
  for (const [id, p] of Object.entries(d.offloaded || {})) {
    if (!SAFE_ID.test(id) || !validPlaceholder(p)) return null;
    offloaded[id] = { ...(p as OffloadPlaceholder), id };
  }
  const keepRaw: unknown[] = Array.isArray(d.keepLocal) ? d.keepLocal : [];
  if (keepRaw.some((x) => typeof x !== 'string' || !SAFE_ID.test(x))) return null;
  return { version: 1, offloaded, keepLocal: [...new Set(keepRaw as string[])] };
}

/** 一条占位的形状：对象，云端位置是字符串，时间是数字。 */
function validPlaceholder(p: any): boolean {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (typeof p.cloudKey !== 'string' || !p.cloudKey) return false;
  if (p.title !== undefined && typeof p.title !== 'string') return false;
  if (p.archived !== undefined && typeof p.archived !== 'boolean') return false;
  if (p.externalRefs !== undefined && (!Array.isArray(p.externalRefs) || p.externalRefs.some((r: unknown) => typeof r !== 'string'))) return false;
  for (const k of ['lastActiveAt', 'offloadedAt']) if (typeof p[k] !== 'number' || !Number.isFinite(p[k])) return false;
  return true;
}

/**
 * 占位记下的云端位置（`<前缀>/v1/sessions/<id>/`）→ 当时的 Key 前缀。移走之后改了设置里的前缀，旧占位仍按原位置恢复。
 * 形状不对 → null（不猜，不退回现在的前缀）。
 */
export function prefixFromCloudKey(cloudKey: string, id: string): string | null {
  const tail = sessionPrefix('', id);
  if (typeof cloudKey !== 'string' || !cloudKey.endsWith(tail)) return null;
  const head = cloudKey.slice(0, -tail.length);
  if (head && !head.endsWith('/')) return null;
  const prefix = head.replace(/[/]+$/, '');
  return sessionPrefix(prefix, id) === cloudKey ? prefix : null;
}

export function writeOffloadState(file: string, st: OffloadState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, file);
}

/** 打上 / 去掉「保留在本机」。占位文件坏了 → 不写（写回会盖掉里面的名单和占位），返回 false。 */
export function setKeepLocal(file: string, id: string, keep: boolean): boolean {
  if (!SAFE_ID.test(id)) return false;
  const st = readOffloadStateStrict(file);
  if (!st) return false;
  const has = st.keepLocal.includes(id);
  if (keep === has) return true;
  st.keepLocal = keep ? [...st.keepLocal, id] : st.keepLocal.filter((x) => x !== id);
  writeOffloadState(file, st);
  return true;
}

/**
 * 严格地列出一个目录里每份 `*.json` 记录挂在哪些会话上（定时任务 `schedules/`、循环 `loop-runs/`）。
 * 目录不存在 = 空；目录读不了、任何一份读不了 / 不是 JSON / `pick` 认不出形状（返回 null）= **null（判断不了）**。
 * 不用 scheduleStore / loopStore 的列举：它们为了运行时稳妥，会把读不了的跳过、把目录读不了当空 —— 对「能不能移走」来说那就是「不知道」。
 */
export function strictSessionRefs(dir: string, pick: (record: any) => string[] | null): Set<string> | null {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch (err: any) { return err?.code === 'ENOENT' ? new Set() : null; }
  const out = new Set<string>();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let rec: any;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')); } catch { return null; }
    const ids = pick(rec);
    if (!ids) return null;
    for (const id of ids) out.add(id);
  }
  return out;
}

/** 定时任务文件（`scheduleStore` 的 `{ id, state }`）挂在哪条会话上：结束了的不算。 */
export const scheduleRefs = (rec: any): string[] | null =>
  rec && typeof rec.state?.sessionId === 'string' ? (rec.state.terminal ? [] : [rec.state.sessionId]) : null;

/** 循环文件（`loopStore` 的 `{ run }`）挂在哪些会话上：自己 + 「某会话一轮结束」触发的那条；结束了的不算。 */
export const loopRefs = (rec: any): string[] | null => {
  const run = rec?.run;
  if (!run || typeof run.sessionId !== 'string') return null;
  if (run.terminal) return [];
  const trig = run.spec?.trigger?.sessionId;
  return typeof trig === 'string' ? [run.sessionId, trig] : [run.sessionId];
};

/** 本机回收站里 `offload-<时间>/<id>` 的那些 id —— 占位文件读不了时，清单至少还能把它们报成「本机仍持有」。 */
export function offloadedIdsInTrash(trashDir: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(trashDir); } catch { return out; }
  for (const n of names) {
    if (!/^offload-[0-9]{8}-[0-9]{6}$/.test(n)) continue;
    try { for (const id of fs.readdirSync(path.join(trashDir, n))) if (SAFE_ID.test(id)) out.push(id); } catch { /* 读不了就算了 */ }
  }
  return out;
}

/** 本机目录挪进回收站的位置：`trash/offload-<时间>/<id>` —— 和 `trashDirFor` 的 `restore-…` 一样不会被认成删除记录。 */
export function offloadTrashDirFor(home: string, id: string, now: number): string {
  const iso = new Date(now).toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
  return path.join(home, 'trash', `offload-${stamp}`, id);
}

/* ------------------------------------------------------------------ 核对 + 移动 */

/** 只用到桶的列举和读取。 */
export interface OffloadBucket {
  list(prefix: string): Promise<Array<{ key: string; size?: number; etag?: string }>>;
  get(key: string): Promise<Buffer | null>;
}

function walkAll(root: string, rel: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const childRel = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walkAll(root, childRel));
    else out.push(childRel);
  }
  return out;
}

async function md5OfFile(abs: string): Promise<string> {
  const h = crypto.createHash('md5');
  await new Promise<void>((resolve, reject) => {
    /* 等 'close'（不是 'end'）：Windows 上句柄没关时紧接着挪目录会 EPERM */
    fs.createReadStream(abs).on('data', (c) => h.update(c)).on('close', () => resolve()).on('error', reject);
  });
  return h.digest('hex');
}

/**
 * **动手之前把云端对象和本机文件逐个对一遍**：本机会话目录里的每个文件（只在本机、丢了也无妨的那两个除外）
 * 云上都要有，大小一样、内容摘要一样。ETag 是内容 MD5 时直接比；不是（KMS 加密 / 分段上传）或对不上时下载下来比。
 * 任何一处对不上 / 读不了 → 不 ok（并说出哪一处）。
 */
export async function verifyCloudCopy(bucket: OffloadBucket, prefix: string | undefined, home: string, id: string): Promise<
  { ok: true; files: number; bytes: number } | { ok: false; why: string }
> {
  try {
    const dirRel = path.join('sessions', id);
    if (!fs.existsSync(path.join(home, dirRel, 'record.json'))) return { ok: false, why: 'record.json is missing locally' };
    const local = walkAll(home, dirRel);
    const remote = new Map((await bucket.list(sessionPrefix(prefix || '', id))).map((o) => [o.key, o]));
    let files = 0;
    let bytes = 0;
    const matched = new Set<string>();
    for (const rel of local) {
      const abs = path.join(home, rel);
      const st = fs.statSync(abs);
      bytes += st.size;
      const inner = path.relative(path.join(home, dirRel), abs);
      if (LOCAL_ONLY_FILES.has(inner)) continue;
      const key = keyFor(prefix, rel);
      const obj = remote.get(key);
      if (!obj) return { ok: false, why: `${inner} is not in the cloud copy` };
      if (Number(obj.size) !== st.size) return { ok: false, why: `${inner}: cloud size ${obj.size} ≠ local ${st.size}` };
      const mine = await md5OfFile(abs);
      const etag = String(obj.etag || '').replace(/"/g, '').toLowerCase();
      if (etag !== mine) {
        const body = await bucket.get(key);
        if (!body) return { ok: false, why: `${inner} could not be read from the cloud` };
        if (crypto.createHash('md5').update(body).digest('hex') !== mine) return { ok: false, why: `${inner}: cloud content differs from local` };
      }
      files += 1;
      matched.add(key);
    }
    if (!files) return { ok: false, why: 'no files to compare' };
    /*
      **两边的文件集合要一样**：云上多出来的（本机后来删掉的旧文件、别的电脑传的）恢复时会被一起带回来，
      和移走之前的本机不是同一份 —— 不移。
    */
    const extra = [...remote.keys()].filter((k) => !matched.has(k));
    if (extra.length) return { ok: false, why: `the cloud copy has ${extra.length} file(s) that are not on this computer (e.g. ${extra[0]})` };
    return { ok: true, files, bytes };
  } catch (err: any) {
    return { ok: false, why: String(err?.message || err) };
  }
}

/** 目录里每个文件的「相对路径 + 大小 + 修改时间」拼成的一串（读不了 = null）。 */
function snapshotFiles(dir: string): string | null {
  try {
    return walkAll(dir, '').map((rel) => { const st = fs.statSync(path.join(dir, rel)); return `${rel}|${st.size}|${st.mtimeMs}`; }).sort().join('|');
  } catch { return null; }
}

/**
 * **把一条会话移到云端**：核对 → 动手前最后再问一次（`recheck`：被打开了 / 开始跑了就返回原因）→
 * 本机目录挪进本机回收站 → 写占位。占位写不进去就把目录挪回来。**不写任何删除记录。**
 */
export async function offloadSession(bucket: OffloadBucket, opts: {
  prefix: string | undefined; home: string; id: string; stateFile: string; now: number; lastActiveAt: number;
  remoteHost?: string;
  /** 挪目录之前最后再问一次的运行时状态（被打开了 / 开始跑了）：返回原因 = 不移 */
  recheck: () => string | null;
  /**
   * 挪目录之前把这条的判定事实**整份重算一遍**（核对要读文件、走网络，这段时间里可能被置顶、打上「保留在本机」、
   * 挂上定时任务…）：重算后 `decideOffload` 不再说可以移、或者算不出来（null）→ 不移。
   */
  refacts?: () => OffloadFacts | null;
  /** 重判用的天数门槛 —— 给函数就在挪目录那一刻现读（核对期间用户可能把 30 天改成 180 天，或者关掉了） */
  idleDays?: number | (() => number);
}): Promise<{ ok: true; placeholder: OffloadPlaceholder } | { ok: false; why: string }> {
  const { home, id } = opts;
  if (!SAFE_ID.test(id)) return { ok: false, why: 'invalid session id' };
  const dir = path.join(home, 'sessions', id);
  /* 核对之前记下每个文件的大小和修改时间 —— 核对完再比一次，期间有任何改动就不移（核对的已经不是现在的文件了） */
  const before = snapshotFiles(dir);
  if (!before) return { ok: false, why: 'the local folder could not be listed' };
  const v = await verifyCloudCopy(bucket, opts.prefix, home, id);
  if (!v.ok) return { ok: false, why: `cloud copy check failed: ${v.why}` };
  const late = opts.recheck();
  if (late) return { ok: false, why: late };
  if (opts.refacts) {
    const f = opts.refacts();
    if (!f) return { ok: false, why: 'could not re-check it before moving' };
    const days = typeof opts.idleDays === 'function' ? opts.idleDays() : (opts.idleDays ?? 0);
    const again = decideOffload(f, { now: opts.now, idleDays: days });
    if (!again.offload) return { ok: false, why: `no longer eligible (${again.reason})` };
  }
  if (snapshotFiles(dir) !== before) return { ok: false, why: 'local files changed during the check' };
  /* 会话目录之外被它引用的粘贴 / 附件：记进占位，免得启动清理把它们当孤儿删了 */
  const externalRefs = transcriptExternalRefs(path.join(dir, 'transcript.jsonl'));
  if (!externalRefs) return { ok: false, why: 'transcript.jsonl has an unreadable line; cannot tell which pasted files it uses' };
  let rec: any;
  try { rec = JSON.parse(fs.readFileSync(path.join(dir, 'record.json'), 'utf-8')); } catch { return { ok: false, why: 'record.json is unreadable' }; }
  const project = typeof rec?.profile?.projectId === 'string' ? rec.profile.projectId.trim() : '';
  const placeholder: OffloadPlaceholder = {
    id,
    title: typeof rec?.title === 'string' && rec.title ? rec.title : 'New Chat',
    ...(project ? { project } : null),
    ...(typeof rec?.profile?.engine === 'string' ? { engine: rec.profile.engine } : null),
    ...(opts.remoteHost ? { remoteHost: opts.remoteHost } : null),
    ...(rec?.archived ? { archived: true } : null),
    ...(externalRefs.length ? { externalRefs } : null),
    lastActiveAt: opts.lastActiveAt,
    offloadedAt: opts.now,
    cloudKey: sessionPrefix(opts.prefix || '', id),
    bytes: v.bytes,
    files: v.files,
  };
  const trash = offloadTrashDirFor(home, id, opts.now);
  try {
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    fs.renameSync(dir, trash);
  } catch (err: any) {
    return { ok: false, why: `could not move the local folder to the trash: ${err?.message || err}` };
  }
  placeholder.trashDir = trash;
  try {
    const st = readOffloadStateStrict(opts.stateFile);
    if (!st) throw new Error('the placeholder file is unreadable; not overwriting it');
    st.offloaded[id] = placeholder;
    writeOffloadState(opts.stateFile, st);
  } catch (err: any) {
    /* 占位写不进去：侧栏就看不见它了 —— 挪回来，当这一条没移 */
    try { fs.renameSync(trash, dir); } catch { /* 挪不回来：它还在回收站里，日志里会说出路径 */ }
    return { ok: false, why: `could not write the placeholder (${err?.message || err}); local folder put back` };
  }
  return { ok: true, placeholder };
}

/**
 * **从云端恢复之后收尾**：本机目录真的回来了（record.json 读得懂）才删占位，并把 updatedAt 刷成现在 ——
 * 最后活动重新计时，不会下一轮又被移走。目录没回来 → 不删占位，什么都不动。
 */
export function finishOffloadRestore(stateFile: string, home: string, id: string, now: number): { ok: true } | { ok: false; why: string } {
  if (!SAFE_ID.test(id)) return { ok: false, why: 'invalid session id' };
  const recPath = path.join(home, 'sessions', id, 'record.json');
  let rec: any;
  try { rec = JSON.parse(fs.readFileSync(recPath, 'utf-8')); } catch { return { ok: false, why: 'the local copy is not back yet' }; }
  if (!rec || typeof rec !== 'object') return { ok: false, why: 'the local copy is not back yet' };
  const st = readOffloadStateStrict(stateFile);
  if (!st) return { ok: false, why: 'the placeholder file is unreadable; not overwriting it' };
  try {
    const tmp = `${recPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...rec, updatedAt: now }, null, 2));
    fs.renameSync(tmp, recPath);
  } catch (err: any) {
    return { ok: false, why: String(err?.message || err) };
  }
  if (st.offloaded[id]) {
    delete st.offloaded[id];
    writeOffloadState(stateFile, st);
  }
  return { ok: true };
}

/** 下载回本机时先落在这里（不在 sessions/ 下：不会被会话枚举、挂载、同步看见），全部下完才整个挪进 sessions/<id>。每次一个独立目录。 */
export function offloadStagingRoot(home: string): string {
  return path.join(home, 'offload-staging');
}

/**
 * 「这份是整份下载完的」凭据：暂存目录里全部下完才写，跟着目录一起 rename 进 sessions/<id>，收尾时删掉。
 * 正式目录已经在、却没有它（或者它列的文件对不上）= 不能证明完整（例如旧版本下载到一半留下的）。
 */
export const RESTORE_COMPLETE_MARK = '.offload-restore-complete.json';

/** 目录里的文件和凭据列的一一对上（大小一样）才算完整。 */
function completeByMark(dir: string): boolean {
  let mark: any;
  try { mark = JSON.parse(fs.readFileSync(path.join(dir, RESTORE_COMPLETE_MARK), 'utf-8')); } catch { return false; }
  if (!mark || !Array.isArray(mark.files) || !mark.files.length) return false;
  try {
    for (const f of mark.files) {
      if (typeof f?.rel !== 'string' || f.rel.includes('..')) return false;
      if (fs.statSync(path.join(dir, f.rel)).size !== Number(f.size)) return false;
    }
    JSON.parse(fs.readFileSync(path.join(dir, 'record.json'), 'utf-8'));
    return true;
  } catch { return false; }
}

/** 同一条会话同时只跑一次下载：侧栏点开、右键、备份页恢复同时来，拿到的是同一个结果（按 home + id）。 */
const restoresInFlight = new Map<string, Promise<RestoreResult>>();
type RestoreResult = { ok: true; files: number; bytes: number; alreadyLocal?: boolean; setAside?: string } | { ok: false; why: string; gone?: boolean };

/**
 * **把一条已移到云端的会话下载回本机** —— 先整份下载到一个独立的暂存目录，一个文件都不少、大小对得上、
 * record.json 读得懂，写下完整凭据，才一次 rename 发布成 `sessions/<id>/`，然后收尾（删凭据、删占位、最后活动重新计时）。
 * 中途任何一步失败：删掉暂存目录，`sessions/<id>/` 不出现，占位原样保留（可以再点一次重试）。
 *
 * 正式目录已经在：有完整凭据且对得上 → 上次发布完、收尾前中断了，只补收尾；证明不了完整 → 不认它，
 * 整个挪进本机回收站（不删），照常从云端重新下载。
 *
 * `vet`：动任何本地文件之前审一遍桶里那份（标准版 = `refuseAdvancedBackup`：advanced 的不恢复），返回的 `get` 用来下载。
 *
 * 云端位置一律用**占位记下的** `cloudKey`（移走那一刻的前缀），不用现在设置里的前缀 —— 移走之后改了前缀，旧占位照样找得到。
 */
export function restoreOffloadedSession(bucket: OffloadBucket, opts: {
  home: string; id: string; stateFile: string; now: number;
  vet?: (objects: Array<{ key: string; size?: number }>, cloudKey: string) => Promise<{ refused: string } | { get: (key: string) => Promise<Buffer | null> }>;
}): Promise<RestoreResult> {
  const key = `${path.resolve(opts.home)}|${opts.id}`;
  const running = restoresInFlight.get(key);
  if (running) return running;
  const p = restoreOnce(bucket, opts).finally(() => { restoresInFlight.delete(key); });
  restoresInFlight.set(key, p);
  return p;
}

async function restoreOnce(bucket: OffloadBucket, opts: Parameters<typeof restoreOffloadedSession>[1]): Promise<RestoreResult> {
  const { home, id } = opts;
  if (!SAFE_ID.test(id)) return { ok: false, why: 'invalid session id' };
  const st0 = readOffloadStateStrict(opts.stateFile);
  if (!st0) return { ok: false, why: 'the placeholder file is unreadable' };
  if (!st0.offloaded[id]) return { ok: false, why: 'not offloaded' };
  const cloudKey = st0.offloaded[id].cloudKey;
  const cloudPrefix = prefixFromCloudKey(cloudKey, id);
  if (cloudPrefix === null) return { ok: false, why: `the placeholder's cloud location is not recognised (${cloudKey})` };
  const finalDir = path.join(home, 'sessions', id);
  const finish = (r: RestoreResult & { ok: true }): RestoreResult => {
    try { fs.rmSync(path.join(finalDir, RESTORE_COMPLETE_MARK), { force: true }); } catch { /* 留着也只是多一个文件 */ }
    const fin = finishOffloadRestore(opts.stateFile, home, id, opts.now);
    return fin.ok ? r : fin;
  };
  let setAside: string | undefined;
  if (fs.existsSync(finalDir)) {
    if (completeByMark(finalDir)) return finish({ ok: true, files: 0, bytes: 0, alreadyLocal: true });
    /* 证明不了完整：不当成已恢复。先确认云上还有，再把它整个挪进回收站（不删），下面照常重新下载 */
    let listed: unknown[] = [];
    try { listed = await bucket.list(cloudKey); } catch (err: any) { return { ok: false, why: String(err?.message || err) }; }
    if (!listed.length) return { ok: false, why: 'the cloud copy no longer exists', gone: true };
    const iso = new Date(opts.now).toISOString().replace(/[:.]/g, '-');
    setAside = path.join(home, 'trash', `offload-incomplete-${iso}`, id);
    try {
      fs.mkdirSync(path.dirname(setAside), { recursive: true });
      fs.renameSync(finalDir, setAside);
    } catch (err: any) {
      return { ok: false, why: `an incomplete local copy is in the way and could not be moved aside: ${err?.message || err}` };
    }
  }
  const root = offloadStagingRoot(home);
  const staging = path.join(root, `${id}-${opts.now}-${crypto.randomBytes(4).toString('hex')}`);
  const cleanup = (): void => { try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* 下次开始前还会再清 */ } };
  try {
    /* 同一条以前中断留下的暂存目录（这时没有别的下载在跑 —— restoresInFlight 保证）*/
    try { for (const n of fs.readdirSync(root)) if (n.startsWith(`${id}-`)) fs.rmSync(path.join(root, n), { recursive: true, force: true }); } catch { /* 没有 */ }
    const objects = await bucket.list(cloudKey);
    if (!objects.length) return { ok: false, why: 'the cloud copy no longer exists', gone: true };
    let get: (key: string) => Promise<Buffer | null> = (k) => bucket.get(k);
    if (opts.vet) {
      const v = await opts.vet(objects, cloudKey);
      if ('refused' in v) return { ok: false, why: v.refused };
      get = v.get;
    }
    fs.mkdirSync(staging, { recursive: true });
    const sessRel = path.join('sessions', id) + path.sep;
    const done: Array<{ rel: string; size: number }> = [];
    let bytes = 0;
    for (const o of objects) {
      const rel = relFor(cloudPrefix, o.key);
      if (!rel || !rel.startsWith(sessRel)) continue;          // 不属于这条会话 / 含 `..`
      const inner = rel.slice(sessRel.length);
      const abs = path.join(staging, inner);
      if (!abs.startsWith(staging + path.sep) || inner === RESTORE_COMPLETE_MARK) continue;
      const body = await get(o.key);
      if (!body) throw new Error(`${inner} could not be downloaded`);
      if (o.size !== undefined && Number(o.size) !== body.length) throw new Error(`${inner}: downloaded ${body.length} bytes, expected ${o.size}`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
      done.push({ rel: inner, size: body.length });
      bytes += body.length;
    }
    try { JSON.parse(fs.readFileSync(path.join(staging, 'record.json'), 'utf-8')); }
    catch { throw new Error('record.json is missing or unreadable in the cloud copy'); }
    fs.writeFileSync(path.join(staging, RESTORE_COMPLETE_MARK), JSON.stringify({ at: opts.now, files: done }));
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    fs.renameSync(staging, finalDir);
    return finish({ ok: true, files: done.length, bytes, ...(setAside ? { setAside } : null) });
  } catch (err: any) {
    cleanup();
    return { ok: false, why: String(err?.message || err) };
  }
}
