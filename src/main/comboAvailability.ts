/**
 * **「🧩 MCP 配置」面板里哪条 MCP「这台电脑不可用」** —— 文件跟着 S3 同步，另一台电脑上的命令路径在这台上没有。
 *
 * 对每个组合里没关掉的 stdio MCP：套上这台电脑的 `perMachine` 覆盖（`localizeServer`）之后，命令在这台电脑上找不找得到
 * （`resolveCommand`）。找不到的列出来，面板据此标「这台电脑不可用」，并给「为这台电脑设置命令 / 在这台电脑上禁用」
 * （写进 `perMachine["<主机名>"]`，见 `setMachineOverride`）。纯函数；文件判断可注入（测试用）。
 */
import { localizeServer, perMachineKey, parseMcpCombos, type MachineIdentity } from './mcpCombos.ts';
import { resolveCommand, commandMissingReason, type ResolveOpts } from './commandResolve.ts';
import { placeEligible, normalizeRunOn, type McpRunOn } from './remoteMcpPlace.ts';

export interface ComboUnavailable {
  comboId: string;
  /** 文件里那条组合的原 id（顶替内置通用的自建通用在清单里叫 default，写回文件要用原 id） */
  fileId: string;
  comboName: string;
  server: string;
  command: string;
  reason: string;
  /** 现在生效的 `perMachine` 键（有的话：说明是覆盖之后的命令也找不到） */
  overrideKey?: string;
}

export function comboLocalAvailability(text: string, machine: MachineIdentity, opts: ResolveOpts = {}): ComboUnavailable[] {
  const r = parseMcpCombos(text);
  if (!r.ok) return [];
  const out: ComboUnavailable[] = [];
  for (const c of r.combos) {
    for (const [name, raw] of Object.entries(c.mcpServers || {})) {
      const s = localizeServer(raw, machine);
      if (!s || s.disabled || s.url !== undefined || typeof s.command !== 'string' || !s.command.trim()) continue;
      const env = { ...(opts.env ?? process.env), ...(s.env || {}) };
      if (resolveCommand(s.command, { ...opts, env })) continue;
      const key = perMachineKey(raw, machine);
      out.push({
        comboId: c.id, fileId: c.aliases?.[0] ?? c.id, comboName: c.name, server: name, command: s.command.trim(),
        reason: commandMissingReason(s.command), ...(key ? { overrideKey: key } : {}),
      });
    }
  }
  return out;
}

/**
 * 在文件文本里给某个组合的某个 MCP 写上这台电脑的覆盖：`perMachine["<主机名>"] = override`（主机名那一键已有就合并）。
 * 返回新的文本（2 空格缩进）；找不到那条 → null（不改）。别的电脑的覆盖、其余内容原样留着。
 */
export function setMachineOverride(
  text: string, fileId: string, server: string, hostname: string,
  override: { command?: string; args?: string[]; disabled?: boolean; runOn?: McpRunOn },
): string | null {
  let raw: unknown;
  try { raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { return null; }
  if (!Array.isArray(raw)) return null;
  const combo = raw.find((c) => c && typeof c === 'object' && (c as any).id === fileId) as any;
  const s = combo?.mcpServers?.[server];
  if (!s || typeof s !== 'object') return null;
  const pm = s.perMachine && typeof s.perMachine === 'object' && !Array.isArray(s.perMachine) ? s.perMachine : {};
  const key = Object.keys(pm).find((k) => k.toLowerCase() === hostname.toLowerCase()) ?? hostname;
  const next: Record<string, unknown> = { ...(pm[key] || {}) };
  if (override.command !== undefined) next.command = override.command;
  if (override.args !== undefined) next.args = override.args;
  if (override.disabled !== undefined) { if (override.disabled) next.disabled = true; else delete next.disabled; }
  /* 「自动」= 不写 runOn（不留一个空壳的主机名键） */
  if (override.runOn !== undefined) { if (override.runOn === 'auto') delete next.runOn; else next.runOn = override.runOn; }
  if (!Object.keys(next).length) {
    const rest = { ...pm };
    delete rest[key];
    if (Object.keys(rest).length) s.perMachine = rest; else delete s.perMachine;
  } else {
    s.perMachine = { ...pm, [key]: next };
  }
  return `${JSON.stringify(raw, null, 2)}\n`;
}

export interface ForwardStdioRow {
  comboId: string;
  fileId: string;
  comboName: string;
  server: string;
  /** 这台电脑上的设置（`perMachine` 的 runOn；不写 = auto） */
  runOn: McpRunOn;
}

/**
 * 面板里「远程会话里在哪跑」那几条：每个组合里会走「从本机转发」回退的 stdio MCP（`placeEligible`，已套上本机覆盖）
 * 和它在这台电脑上的设置（自动 / 总是在远端运行 / 总是本机转发）。
 */
export function comboForwardStdio(text: string, machine: MachineIdentity): ForwardStdioRow[] {
  const r = parseMcpCombos(text);
  if (!r.ok) return [];
  const out: ForwardStdioRow[] = [];
  for (const c of r.combos) {
    for (const [name, raw] of Object.entries(c.mcpServers || {})) {
      const s = localizeServer(raw, machine);
      if (!placeEligible(name, s)) continue;
      out.push({ comboId: c.id, fileId: c.aliases?.[0] ?? c.id, comboName: c.name, server: name, runOn: normalizeRunOn(s.runOn) });
    }
  }
  return out;
}
