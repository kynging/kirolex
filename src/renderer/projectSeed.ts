/**
 * **启动时从 ui-state 恢复项目列表 / 会话归属** —— 纯逻辑，`useAcp` 用。
 *
 * 现场：旧的 `kirolex-sessions` 里那条会话 `projectId === "s_1790502638964_in82ze"`（它自己的 id）。
 * 启动时「从会话补项目列表」把它当项目加进 `kirolex-projects` 并写回，之后磁盘水化虽然把会话纠正成未分组，
 * 这个假项目却留在列表里 —— 而主进程判断"是不是真项目"认的正是这份列表（`projectSanity.ts`）。
 *
 * 所以：
 *   · 列表本身：`s_` 开头的名字去掉（`initialProjects`）；
 *   · 会话缓存：`s_` 开头的归属当未分组（`initialSessions`），磁盘水化前侧栏就不画假项目；
 *   · 从会话补列表（`seedProjectsFromSessions`）**只在列表读不到时**补 —— 那是它原本要救的情况
 *     （列表丢了、会话还记着项目）。列表在的时候它就是权威，旧缓存里的归属不能自动注册成项目。
 */
import { looksLikeSessionId } from '../main/projectSanity.ts';

/** 读 `kirolex-projects`：读不到 / 坏了 → `null`；读到了 → 去掉 `s_` 开头和空的名字。 */
export function initialProjects(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const n of list) {
    const v = typeof n === 'string' ? n.trim() : '';
    if (v && !looksLikeSessionId(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 旧的会话缓存：`s_` 开头的 projectId 当未分组（其余字段原样）。 */
export function initialSessions<S extends { projectId?: string }>(list: S[]): S[] {
  return list.map((s) => (s && s.projectId && looksLikeSessionId(s.projectId) ? { ...s, projectId: undefined } : s));
}

/**
 * 从会话补项目列表：`saved` 是 `initialProjects` 的结果。读到了列表（哪怕是空的）→ 原样返回，不补；
 * 读不到 → 用会话里记着的项目（`s_` 开头的不要）重建。
 */
export function seedProjectsFromSessions(saved: string[] | null, sessions: { projectId?: string }[]): string[] {
  if (saved) return saved;
  const out: string[] = [];
  for (const s of sessions) {
    const p = String(s?.projectId || '').trim();
    if (p && !looksLikeSessionId(p) && !out.includes(p)) out.push(p);
  }
  return out;
}
