/**
 * **侧栏的 ☁ 占位**（已移到云端的会话，主进程 `sessionOffload.ts`）—— 纯展示逻辑，单独一个 `.ts` 好测。
 *
 * 占位不进 useAcp 的 `sessions`：那份列表会被预热、分屏、自动打开上次的会话这些逻辑拿去用，而占位在本机没有记录，
 * 拿去 attach 只会出错。所以它们只在侧栏里和真会话**并排画**（同一个项目分组、同一个搜索框），点开先下载回来。
 */

import { t, type Lang } from './i18n.ts';

const DAY_MS = 86_400_000;

/** 主进程 `offload:list` 回来的一条（`OffloadPlaceholder`）。 */
export interface OffloadPlaceholderRow {
  id: string;
  title: string;
  project?: string;
  engine?: string;
  remoteHost?: string;
  /** 移走时是归档的 */
  archived?: boolean;
  lastActiveAt: number;
  offloadedAt: number;
  bytes: number;
  files?: number;
}

/** 侧栏行上挂的那一块：有它 = 这是一个占位。 */
export interface OffloadedMark {
  lastActiveAt: number;
  offloadedAt: number;
  bytes: number;
  /** 正在下载回本机 */
  restoring?: boolean;
}

export interface PlaceholderRow { id: string; title: string; model: string; projectId?: string; engine?: 'kiro' | 'claude' | 'codex'; remoteHost?: string; archived?: boolean; timestamp: number; offloaded: OffloadedMark }

/** 占位 → 侧栏行（和 `Session` 同形状的那几个字段）。本机已经有这条会话的不再画占位。 */
export function placeholderRows<S extends { id: string }>(
  rows: OffloadPlaceholderRow[] | null | undefined,
  sessions: S[],
  restoring: ReadonlySet<string> = new Set(),
): PlaceholderRow[] {
  const have = new Set(sessions.map((s) => s.id));
  const out: PlaceholderRow[] = [];
  for (const r of rows || []) {
    if (!r?.id || have.has(r.id)) continue;
    have.add(r.id);
    const engine: PlaceholderRow['engine'] = r.engine === 'claude' || r.engine === 'codex' || r.engine === 'kiro' ? r.engine : undefined;
    out.push({
      id: r.id,
      title: r.title || 'New Chat',
      model: '',
      ...(r.project ? { projectId: r.project } : null),
      ...(engine ? { engine } : null),
      ...(r.remoteHost ? { remoteHost: r.remoteHost } : null),
      /* 归档的照旧进「已归档」那一组（侧栏按 archived 分组） */
      ...(r.archived ? { archived: true } : null),
      timestamp: Number(r.lastActiveAt) || 0,
      offloaded: { lastActiveAt: Number(r.lastActiveAt) || 0, offloadedAt: Number(r.offloadedAt) || 0, bytes: Number(r.bytes) || 0, ...(restoring.has(r.id) ? { restoring: true } : null) },
    });
  }
  return out;
}

/** 多少天没用了（按现在算，至少 1）。 */
export function idleDays(lastActiveAt: number, now: number): number {
  return Math.max(1, Math.floor((now - (Number(lastActiveAt) || 0)) / DAY_MS));
}

/** 字节 → `1.5 GB` / `320 MB`。 */
export function sizeLabel(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** 占位行的悬停提示。 */
export function offloadTooltip(m: OffloadedMark, now: number, lang: Lang): string {
  if (m.restoring) return t(lang, 'Downloading it back from the cloud…');
  return t(lang, 'Moved to the cloud (unused for {n} days). Click to download it automatically.', { n: idleDays(m.lastActiveAt, now) });
}

/** 同步完的那句汇总：「已把 N 条 30 天未使用的会话移到云端，腾出 X GB」。 */
export function offloadSummary(n: number, bytes: number, days: number, lang: Lang): string {
  return t(lang, 'Moved {n} sessions unused for {days} days to the cloud, freeing {size}.', { n, days, size: sizeLabel(bytes) });
}

export type OffloadFailureKind = 'network' | 'credentials' | 'gone' | 'busy' | 'other';

/** 下载回本机失败的原因分一下类：网络 / 凭证 / 云端已没有 / 其他。 */
export function offloadFailureKind(r: { gone?: boolean; error?: string } | null | undefined): OffloadFailureKind {
  if (r?.gone) return 'gone';
  const e = String(r?.error || '');
  if (/middle of a turn|一轮/.test(e)) return 'busy';
  if (/NoSuchKey|NoSuchBucket|already been deleted|已经删|已没有/i.test(e)) return 'gone';
  if (/\b403\b|InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|ExpiredToken|not fully set up|decrypt|没配|凭据|密钥/i.test(e)) return 'credentials';
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket|timed? ?out|network|网络/i.test(e)) return 'network';
  return 'other';
}

/** 失败时给人看的那句（占位保留，什么都没删）。 */
export function offloadFailureText(title: string, r: { gone?: boolean; error?: string } | null | undefined, lang: Lang): string {
  const kind = offloadFailureKind(r);
  const why = kind === 'network' ? t(lang, 'network problem')
    : kind === 'credentials' ? t(lang, 'S3 credentials problem')
    : kind === 'gone' ? t(lang, 'the cloud copy no longer exists')
    : kind === 'busy' ? t(lang, 'it is busy')
    : t(lang, 'unknown reason');
  const detail = String(r?.error || '').split('\n')[0];
  return t(lang, 'Could not download "{title}" ({why}). The placeholder is kept and nothing was deleted.', { title, why })
    + (detail ? `\n${detail}` : '');
}
