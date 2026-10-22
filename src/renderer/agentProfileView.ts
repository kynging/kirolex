/**
 * 「AI 工具配置」那一块的纯展示逻辑（`components/AgentProfileSettings.tsx` 用）：差异一行怎么说、确认框列什么。
 * 差异项的形状和主进程 `agentProfile.ts` 的 `DiffItem` 一致。
 */

export interface DiffItemView { area: string; key: string; status: string; want?: string; have?: string }

export interface PlanView {
  backupDir: string;
  items: DiffItemView[];
  pins: Array<{ bin: string; pkg: string; version: string }>;
  rules: string[];
  plugins: string[];
  marketplaces: Array<{ name: string; copy: boolean }>;
  codexEntries: string[];
  warnings: string[];
  hasWork: boolean;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

export function areaLabel(area: string, t: T): string {
  switch (area) {
    case 'version': return t('Version');
    case 'adapter': return t('Adapter');
    case 'settings': return 'settings.json';
    case 'plugin': return t('Plugin');
    case 'marketplace': return t('Marketplace');
    case 'rule': return t('Rule');
    case 'codex': return 'config.toml';
    default: return t('Note');
  }
}

/** 一条差异的说明（不含分类标签）。 */
export function diffText(item: DiffItemView, t: T): string {
  if (item.area === 'warning' && item.key === 'node') return t('No node on that machine: only versions can be compared; syncing installs node first');
  if (item.status === 'manual') return `${t('Needs manual setup: {key}', { key: item.key })}${item.want ? ` = ${item.want}` : ''}${item.have ? ` (${t('there: {have}', { have: item.have })})` : ''}`;
  if (item.status === 'unresolved') return t('{key}: placeholder {name} cannot be filled on this machine, so this key is not sent', { key: item.key, name: item.want || '' });
  if (item.status === 'error') return t('{key} on that machine cannot be parsed; it will not be changed', { key: item.key });
  if (item.area === 'adapter') return t('{key} is not installed', { key: item.key }) + (item.want ? ` → ${item.want}` : '');
  if (item.area === 'plugin' && item.status === 'missing') return t('{key} is not installed', { key: item.key });
  if (item.area === 'plugin' && item.want === 'disabled') return t('{key} is enabled there but turned off in the config', { key: item.key });
  if (item.area === 'plugin') return t('{key} is installed but not enabled', { key: item.key });
  if (item.area === 'marketplace') return t('{key} is not added', { key: item.key });
  if (item.area === 'rule') return item.status === 'missing' ? t('{key} is missing', { key: item.key }) : t('{key} differs', { key: item.key });
  if (item.status === 'missing') return `${item.key}: ${t('(none)')} → ${item.want ?? ''}`;
  return `${item.key}: ${item.have ?? '?'} → ${item.want ?? ''}`;
}

/** 确认框正文：先说会备份到哪，再逐条列要改的，最后说不碰什么。 */
export function confirmText(plan: PlanView, host: string, t: T): string {
  const lines: string[] = [];
  lines.push(t('First back up ~/.claude/settings.json, rules/ and plugins/ on {host} to {dir}', { host, dir: plan.backupDir }));
  if (plan.pins.length) lines.push(`${t('Install / upgrade (global npm)')}: ${plan.pins.map((p) => `${p.bin}@${p.version}`).join(', ')}`);
  const settings = plan.items.filter((i) => i.area === 'settings' && i.status !== 'error');
  if (settings.length) lines.push(`${t('Merge into settings.json')}: ${settings.map((i) => i.key).join(', ')}`);
  if (plan.rules.length) lines.push(`${t('Write rules (same name overwritten, extra ones kept)')}: ${plan.rules.join(', ')}`);
  if (plan.marketplaces.length) lines.push(`${t('Add marketplaces')}: ${plan.marketplaces.map((m) => (m.copy ? `${m.name} (${t('copied from this computer')})` : m.name)).join(', ')}`);
  if (plan.plugins.length) lines.push(`${t('Install plugins')}: ${plan.plugins.join(', ')}`);
  const on = plan.items.filter((i) => i.area === 'plugin' && i.status === 'different' && i.want === 'enabled');
  if (on.length) lines.push(`${t('Turn on installed plugins (enabledPlugins set to true)')}: ${on.map((i) => i.key).join(', ')}`);
  const off = plan.items.filter((i) => i.area === 'plugin' && i.want === 'disabled');
  if (off.length) lines.push(`${t('Turn off plugins (enabledPlugins set to false)')}: ${off.map((i) => i.key).join(', ')}`);
  /* Codex 只改 config.toml 顶层的 model / model_provider 两行；其余的列出来让人手动配 */
  if (plan.codexEntries.length) lines.push(`${t('Set at the top of ~/.codex/config.toml (only these lines change)')}: ${plan.codexEntries.join(', ')}`);
  const manual = plan.items.filter((i) => i.area === 'codex' && i.status === 'manual');
  if (manual.length) lines.push(`⚠️ ${t('Not changed automatically, set up by hand on that machine')}: ${manual.map((i) => i.key).join(', ')}`);
  for (const w of plan.warnings) lines.push(`⚠️ ${w}`);
  for (const i of plan.items.filter((x) => x.area === 'warning' || x.status === 'error')) lines.push(`⚠️ ${diffText(i, t)}`);
  lines.push('');
  lines.push(t('Never sent: local-only MCP servers and anything in excludeLocalOnly, and any credentials. Keys that exist only on that machine (including its credential env) are kept as they are.'));
  return lines.join('\n');
}
