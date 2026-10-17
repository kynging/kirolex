/**
 * **界面上能看到的项目** —— KiroLex Advanced 专属的 flow 项目（「周报」「SFDC Activity」那种）不显示。
 *
 * 哪些要藏由主进程判（`app:advanced-only-projects`：看磁盘上的 runs / flows 和项目下有没有普通会话），
 * 这里只做过滤。**只过滤给界面的那一份**：`kirolex-projects` 是两版共用的列表，藏起来的名字照样留在里面，
 * 否则标准版就等于删了 advanced 的项目。
 */
export function visibleProjects(all: readonly string[], hidden: Iterable<string>): string[] {
  const h = new Set(hidden);
  if (!h.size) return [...all];
  return all.filter((p) => !h.has(p));
}

/**
 * **哪条会话在哪个项目里** 的签名 —— 隐藏名单要跟着它重新问。
 *
 * 只看会话条数不够：把一个 flow 项目里最后一条普通会话移到别的项目 / 未分组，条数和项目名单都没变，
 * 可那个项目此刻已经成了 advanced 专属，该藏了。消息、标题这些变化不进签名，不会让它白白重问。
 */
export function projectMembershipKey(sessions: ReadonlyArray<{ id: string; projectId?: string | null }>): string {
  return sessions.map((s) => `${s.id}\u0001${s.projectId || ''}`).sort().join('\u0002');
}
