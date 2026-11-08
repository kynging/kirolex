/**
 * **会话的项目归属是不是一个真项目** —— 纯逻辑，主进程（水化 / attach / 每轮注入记忆）和渲染层都用。
 *
 * 现场（KYN-DESKTOP，s_1790502638964_in82ze）：从云端恢复的会话 `projectId` 被写成了**它自己的会话 id**，
 * 侧栏冒出一个叫 `s_1790502638964_in82ze` 的项目，记忆也按这个不存在的项目注入。来路是 attach 时
 * 「记录里没项目 → 拿工作目录的最后一段当项目名」：恢复回来的记录 `localDir` 是**别的电脑上**的
 * `…/.kirolex/sessions/<id>`，本机那条「`~/.kirolex` 下的不算」只认得本机的家目录，于是推出了会话 id。
 *
 * 所以两层：
 *   · `derivableProjectDir`：从目录推项目之前先问 —— 任何一台机器的 `.kirolex` 目录、会话 id 形状的目录名、
 *     本机不存在的目录（别的电脑的路径）都不推。
 *   · `bogusProjectReason`：已经写进去的也要认出来（读取时纠正成未分组并写回）。
 */
/* 不 import node 模块：渲染层也用这个文件 */

/** 会话 id 的前缀：`s_` 开头的一律不当项目（需求 B：「形如会话 id（s_ 开头）时一律当未分组」）。 */
const SESSION_ID_PREFIX = /^s_/;

export function looksLikeSessionId(name: string | null | undefined): boolean {
  return SESSION_ID_PREFIX.test(String(name || '').trim());
}

/**
 * 本机的项目有哪些 —— **只认侧栏的项目列表**（ui-state 的 `kirolex-projects`）。
 *
 * 空列表 = 本机一个项目都没有，所有项目归属都是"不在列表里"，照样纠正成未分组。
 * `null` 只表示**读不出来**（键不存在 / 不是 JSON 数组）：那时没法判断，只按 `s_` 前缀判 —— 和空列表不是一回事。
 * `s_` 开头的名字就算在列表里也不收。
 */
export function knownProjects(listJson: string | null | undefined): Set<string> | null {
  if (listJson === null || listJson === undefined || listJson === '') return null;
  let list: unknown;
  try { list = JSON.parse(String(listJson)); } catch { return null; }
  if (!Array.isArray(list)) return null;
  const out = new Set<string>();
  for (const n of list) {
    const v = typeof n === 'string' ? n.trim() : '';
    if (v && !looksLikeSessionId(v)) out.add(v);
  }
  return out;
}

export type BogusProjectReason = 'session-id' | 'unknown';

/**
 * 这个 projectId 该不该当成未分组：形如会话 id（含等于这条会话自己的 id）→ `session-id`；
 * 本机认的项目列表里没有 → `unknown`；没项目 / 是真项目 → `null`。
 */
export function bogusProjectReason(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
  known: ReadonlySet<string> | null,
): BogusProjectReason | null {
  const p = String(projectId || '').trim();
  if (!p) return null;
  if (looksLikeSessionId(p) || (!!sessionId && p === String(sessionId).trim())) return 'session-id';
  if (known && !known.has(p)) return 'unknown';
  return null;
}

/** 当成未分组就给 `undefined`，否则原样（去掉首尾空白）。 */
export function sanitizeProjectId(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
  known: ReadonlySet<string> | null,
): string | undefined {
  const p = String(projectId || '').trim();
  if (!p || bogusProjectReason(p, sessionId, known)) return undefined;
  return p;
}

/**
 * 这个目录能不能拿来推项目名（`deriveProjectId` = 目录的最后一段）。
 *
 * 不能的：任何一台机器上的 `.kirolex` 目录（按路径段认，`/` 和 `\` 都认 —— 别的电脑的家目录本机不知道），
 * 最后一段形如会话 id 的，以及本机上不存在的目录（`exists` 由调用方注入，测试里不碰盘）。
 */
export function derivableProjectDir(dir: string | null | undefined, exists: (p: string) => boolean): boolean {
  const d = String(dir || '').trim();
  if (!d) return false;
  const parts = d.split(/[\\/]+/).filter(Boolean);
  if (parts.some((s) => s.toLowerCase() === '.kirolex')) return false;
  const base = parts[parts.length - 1] || '';
  if (!base || looksLikeSessionId(base)) return false;
  return exists(d);
}
