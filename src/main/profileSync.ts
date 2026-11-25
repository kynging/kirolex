/**
 * **会话列表里由记录决定的那几个字段，以主进程记录为准** —— 「界面显示是 Claude Code，记录是 kiro」。
 *
 * 渲染层的会话列表（ui-state 的 `kirolex-sessions`）是一份快照：引擎、模型、权限、运行位置、工作目录、项目、agent
 * 这些字段真正的主人是 `sessions/<id>/record.json`（和连着的执行器）。以前只在水化时按白名单抄、而且多半是
 * `记录 ?? 快照`：记录里"没有这个字段"（kiro 老记录没有 `engine`、本机会话没有 `remote`）就退回快照里那个旧值，
 * 于是一份 Mac 时代的快照（`engine: claude`、`localDir: /Users/...`）永远纠正不过来，忙时 Enter 也按错的引擎路由。
 *
 * 这里是纯逻辑（主进程和渲染层共用，不 import electron）：
 *   · `profileSyncFieldsOf`：从一份记录算出这几个字段（主进程推 `session:profile-sync` 时用）；
 *   · `diffSessionProfile` / `alignSessions`：快照和记录哪里不一样、按记录改过来（渲染层收到推送 / 主进程启动迁移时用）；
 *   · `profileSyncLogLine`：`[profile-sync] fixed sessionId=… field=engine ui=claude record=kiro` 那一行。
 */

export type SyncEngine = 'kiro' | 'claude' | 'codex';
export type SyncPermission = 'auto-approve' | 'ask';

/** 推给渲染层的一条：缺省（undefined）的字段就是「记录里没有」—— 例如本机会话没有 remoteHost、未分组没有 projectId。 */
export interface ProfileSyncEntry {
  id: string;
  engine: SyncEngine;
  /** 记录里没有模型时不带（不拿空值去盖界面上的模型） */
  model?: string;
  permissionMode: SyncPermission;
  projectId?: string;
  kiroAgent?: string;
  remoteHost?: string;
  remoteId?: string;
  remoteMissing?: boolean;
  localDir?: string;
}

/** 对齐的字段（顺序就是日志里的顺序） */
export const PROFILE_SYNC_FIELDS = ['engine', 'model', 'permissionMode', 'projectId', 'kiroAgent', 'remoteHost', 'remoteId', 'remoteMissing', 'localDir'] as const;
export type ProfileSyncField = typeof PROFILE_SYNC_FIELDS[number];

export interface ProfileFix {
  sessionId: string;
  field: ProfileSyncField;
  ui: string;
  record: string;
}

export function normEngine(e: unknown): SyncEngine {
  return e === 'claude' || e === 'codex' ? e : 'kiro';
}

export function normPermission(p: unknown): SyncPermission {
  return p === 'auto-approve' ? 'auto-approve' : 'ask';
}

/**
 * 一份记录 → 这几个字段。`remoteView` 是主进程按设置算好的给人看的机器名 / id（`labelForHost`、`durableRemoteId`），
 * 本机会话传 `{}`。`live`：执行器连着时它实际在跑的引擎和模型（那才是忙时 Enter 该用的、下拉该显示的 —— 连上时降级到备用模型
 * 不写记录，只告诉界面，见 index.ts 的 `emitSessionModel`），没连着不传。
 */
export function profileSyncFieldsOf(
  rec: { id: string; localDir?: string; profile?: { engine?: string; model?: string; permissionMode?: string; projectId?: string; kiroAgent?: string } | null },
  remoteView: { remoteHost?: string; remoteId?: string; remoteMissing?: boolean } = {},
  live?: { engine?: string; model?: string },
): ProfileSyncEntry {
  const p = rec.profile || {};
  const out: ProfileSyncEntry = {
    id: rec.id,
    engine: normEngine(live ? live.engine : p.engine),
    permissionMode: normPermission(p.permissionMode),
  };
  const model = (live?.model) || p.model;
  if (typeof model === 'string' && model) out.model = model;
  if (typeof p.projectId === 'string' && p.projectId) out.projectId = p.projectId;
  if (typeof p.kiroAgent === 'string' && p.kiroAgent) out.kiroAgent = p.kiroAgent;
  if (remoteView.remoteHost) {
    out.remoteHost = remoteView.remoteHost;
    if (remoteView.remoteId) out.remoteId = remoteView.remoteId;
    if (remoteView.remoteMissing) out.remoteMissing = true;
  }
  if (typeof rec.localDir === 'string' && rec.localDir) out.localDir = rec.localDir;
  return out;
}

/** 界面上一个字段的「值」，和记录一样的口径（kiro = 没写 engine，ask = 没写权限，空串 = 没有） */
function uiValue(s: Record<string, any>, field: ProfileSyncField): string {
  const v = s[field];
  if (field === 'engine') return normEngine(v);
  if (field === 'permissionMode') return normPermission(v);
  if (field === 'remoteMissing') return v ? 'true' : '';
  return typeof v === 'string' ? v : '';
}

function recordValue(e: ProfileSyncEntry, field: ProfileSyncField): string {
  const v = (e as any)[field];
  if (field === 'remoteMissing') return v ? 'true' : '';
  return typeof v === 'string' ? v : '';
}

/** 界面这一条和记录哪里不一样。模型：记录里没有就不比（不拿空值去盖）。 */
export function diffSessionProfile(ui: Record<string, any>, entry: ProfileSyncEntry): ProfileFix[] {
  const fixes: ProfileFix[] = [];
  for (const field of PROFILE_SYNC_FIELDS) {
    if (field === 'model' && !entry.model) continue;
    const a = uiValue(ui, field);
    const b = recordValue(entry, field);
    if (a !== b) fixes.push({ sessionId: entry.id, field, ui: a, record: b });
  }
  return fixes;
}

/** 按记录改写一条（只动这几个字段，别的原样）。kiro 写成 `engine: undefined`，和 `session:engine-changed` 那边同一个口径。 */
export function applyProfileEntry<T extends Record<string, any>>(s: T, entry: ProfileSyncEntry): T {
  const next: Record<string, any> = { ...s };
  next.engine = entry.engine === 'kiro' ? undefined : entry.engine;
  if (entry.model) next.model = entry.model;
  next.permissionMode = entry.permissionMode;
  next.projectId = entry.projectId;
  next.kiroAgent = entry.kiroAgent;
  next.remoteHost = entry.remoteHost;
  next.remoteId = entry.remoteId;
  next.remoteMissing = entry.remoteMissing || undefined;
  next.localDir = entry.localDir;
  return next as T;
}

/**
 * 整份列表按记录对齐：只改有差异的那几条（没差异的保持同一个对象，`changed=false` 时可以不触发重渲染 / 不写盘）。
 * 列表里没有对应记录的（还没落盘的新会话、`pending_`）原样留着。
 */
export function alignSessions<T extends { id: string }>(sessions: T[], entries: ReadonlyArray<ProfileSyncEntry>): { sessions: T[]; fixes: ProfileFix[]; changed: boolean } {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const fixes: ProfileFix[] = [];
  let changed = false;
  const out = sessions.map((s) => {
    const e = s && byId.get(s.id);
    if (!e) return s;
    const d = diffSessionProfile(s as any, e);
    if (!d.length) return s;
    fixes.push(...d);
    changed = true;
    return applyProfileEntry(s as any, e) as T;
  });
  return { sessions: changed ? out : sessions, fixes, changed };
}

/**
 * **一次性迁移**（主进程，启动水化时）：ui-state 里的 `kirolex-sessions` 原文对着记录改。
 * 读不出来 / 不是数组 → 不动（`raw: undefined`）；没有差异 → 也不动。
 */
export function alignUiStateSessions(raw: string | undefined | null, entries: ReadonlyArray<ProfileSyncEntry>): { raw?: string; fixes: ProfileFix[] } {
  if (!raw) return { fixes: [] };
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return { fixes: [] }; }
  if (!Array.isArray(list)) return { fixes: [] };
  const r = alignSessions(list.filter((s) => s && typeof s === 'object' && typeof (s as any).id === 'string') as { id: string }[], entries);
  if (!r.changed) return { fixes: [] };
  /* 坏条目（没有 id 的）原样留在原位置：只替换改过的那几条 */
  const fixedById = new Map(r.sessions.map((s) => [s.id, s]));
  const merged = list.map((s: any) => (s && typeof s === 'object' && typeof s.id === 'string' ? fixedById.get(s.id) ?? s : s));
  return { raw: JSON.stringify(merged), fixes: r.fixes };
}

/** 日志正文（scope 是 `profile-sync`，整行就是 `[profile-sync] fixed sessionId=… field=engine ui=claude record=kiro`） */
export function profileSyncLogLine(fix: ProfileFix): string {
  const show = (v: string) => (v === '' ? '(none)' : /\s/.test(v) ? JSON.stringify(v) : v);
  return `fixed sessionId=${fix.sessionId} field=${fix.field} ui=${show(fix.ui)} record=${show(fix.record)}`;
}

/** 换引擎 / 换模型这类 IPC 的返回里有没有「现在实际是哪个引擎」：成功、不是 pending（pending 时那个 engine 是你选的、还没生效） */
export function engineFromSwitchResult(r: unknown): SyncEngine | undefined {
  const x = r as { ok?: boolean; pending?: boolean; engine?: unknown } | null | undefined;
  if (!x || !x.ok || x.pending || typeof x.engine !== 'string') return undefined;
  return normEngine(x.engine);
}

/** `acp:list-durable-sessions` 的一行（渲染层水化用的形状）→ 同一套字段，水化时以它为准（不再 `记录 ?? 快照`）。 */
export function profileSyncEntryFromDiskRow(row: {
  id: string; engine?: string; model?: string; permissionMode?: string; projectId?: string; kiroAgent?: string;
  remoteHost?: string; remoteId?: string; remoteMissing?: boolean; localDir?: string;
}): ProfileSyncEntry {
  return profileSyncFieldsOf(
    { id: row.id, localDir: row.localDir, profile: { engine: row.engine, model: row.model, permissionMode: row.permissionMode, projectId: row.projectId, kiroAgent: row.kiroAgent } },
    { remoteHost: row.remoteHost, remoteId: row.remoteId, remoteMissing: row.remoteMissing },
  );
}
