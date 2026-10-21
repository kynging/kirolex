/**
 * ACP 标准的命令表（`available_commands_update` 的 `availableCommands`）→ KiroLex 的命令表形状 —— PURE。
 *
 * 斜杠菜单原来只认 kiro 自己的 `_kiro.dev/commands/available`（`{ name: '/clear', meta: { hint } }`），
 * Claude Code / Codex 的适配器发的是标准通知（`{ name: 'compact', description, input: { hint } }`，名字不带 `/`），
 * 没人接，于是这两家打 `/` 什么都不弹。换成同一个形状，主进程缓存（`acp:session-commands`）和渲染层
 * `toSlashCommands` 都不用分两套。
 */
export interface KiroCommandRow { name: string; description?: string; meta?: { hint?: string } }

export function acpAvailableCommands(raw: unknown): KiroCommandRow[] {
  if (!Array.isArray(raw)) return [];
  const out: KiroCommandRow[] = [];
  for (const c of raw as any[]) {
    const name = typeof c?.name === 'string' ? c.name.trim() : '';
    if (!name) continue;
    const hint = typeof c?.input?.hint === 'string' && c.input.hint ? c.input.hint : undefined;
    out.push({
      name: name.startsWith('/') ? name : `/${name}`,
      ...(typeof c?.description === 'string' ? { description: c.description } : {}),
      ...(hint ? { meta: { hint } } : {}),
    });
  }
  return out;
}
