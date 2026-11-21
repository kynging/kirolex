/**
 * **单条会话要不要备份** ——「项目不开备份时，会话也能单独打开」。纯逻辑，主进程和备份窗口共用。
 *
 * 规则「单条优先于项目」：
 * · `includeSessions` 里有它 → 同步（项目关着也传）；
 * · `excludeSessions` 里有它 → 不同步（项目开着也不传）；
 * · 都没有 → 看它所在的项目有没有被 `excludeProjects` 排除（空串 = 未分组，也能排除）。
 * advanced 专属的会话（flow / skill）一律不传，单独打开也不行。
 *
 * 老 config 没有 `includeSessions`（或者是 null）时，结果和以前「项目关就不传、单条关就不传」一样。
 */

export interface SessionSyncLists {
  excludeProjects?: string[] | null;
  excludeSessions?: string[] | null;
  includeSessions?: string[] | null;
}

const list = (x: unknown): string[] => (Array.isArray(x) ? x : []);

export function shouldSyncSession(
  cfg: SessionSyncLists,
  sessionId: string,
  project: string,
  opts: { advancedOnly?: boolean } = {},
): boolean {
  if (opts.advancedOnly) return false;
  if (list(cfg.includeSessions).includes(sessionId)) return true;
  if (list(cfg.excludeSessions).includes(sessionId)) return false;
  return !list(cfg.excludeProjects).includes(project);
}

/**
 * 单条开关点了一下之后的两张表 —— 以最后一次操作为准：开 = 从 excludeSessions 删、加进 includeSessions；关反之。
 * 这样同一条会话不会同时留在两张表里。
 */
export function setSessionSync(
  cfg: SessionSyncLists,
  sessionId: string,
  sync: boolean,
): { excludeSessions: string[]; includeSessions: string[] } {
  const ex = list(cfg.excludeSessions).filter((x) => x !== sessionId);
  const inc = list(cfg.includeSessions).filter((x) => x !== sessionId);
  return sync
    ? { excludeSessions: ex, includeSessions: [...inc, sessionId] }
    : { excludeSessions: [...ex, sessionId], includeSessions: inc };
}
