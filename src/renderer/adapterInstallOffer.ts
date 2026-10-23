/**
 * **这条「没连上」提示是不是"缺 Claude Code / Codex 的 ACP 适配器"** —— 是的话提示上带一个「安装」按钮
 * （`ChatArea.tsx` 的 `AdapterInstallAction`）。
 *
 * 认的是主进程那两句（中英两版都认，界面语言随时会换）：
 *   · 本机：`engines.ts` 的 `adapterMissingMessage` —— 「没找到 X 的 ACP 适配器」/「Could not find the ACP adapter for X」；
 *   · 远端：`remoteAdapterProbe.ts` 的 `adapterProblemMessage`（missing）—— 「<host> 上没有 X 的 ACP 适配器」/「<host> has no ACP adapter for X」。
 * 「装了但没有 node 能跑它」那句不认：重装治不了，提示里已经说了怎么修。
 * 哪一家看提示里的命令名 / 包名（`claude-agent-acp` / `codex-acp`）。
 */
export type AdapterEngine = 'claude' | 'codex' | 'kiro';

const MISSING = [
  /Could not find the ACP adapter for /,
  /没找到 .{1,40}? 的 ACP 适配器/,
  /has no ACP adapter for /,
  /上没有 .{1,40}? 的 ACP 适配器/,
];

/**
 * **本机 kiro-cli 没装 / 没配**（`acp-client.ts` 的 `kiroBinProblem` 和「kiro-cli not found」那两句，中英都认）——
 * 原来只叫人去设置里填路径。点「安装」先找本机已有的，没有再跑官方安装器（主进程 `installLocalKiro`）。
 * 只认**本机**那两句：远端的 kiro-cli 说的是 `{host}`，照旧在设置里「安装 AI 工具」。
 */
const KIRO_MISSING = [
  /No kiro launch command is set for \*\*this machine\*\*/,
  /还没有设置\*\*本机\*\*的 kiro 启动命令/,
  /kiro-cli not found\. Tried these/,
  /kiro-cli 找不到。试过这些/,
];

export function adapterInstallOffer(text: string | null | undefined): { engine: AdapterEngine } | null {
  const s = String(text || '');
  if (KIRO_MISSING.some((re) => re.test(s))) return { engine: 'kiro' };
  if (!MISSING.some((re) => re.test(s))) return null;
  if (/codex-acp/.test(s)) return { engine: 'codex' };
  if (/claude-agent-acp/.test(s)) return { engine: 'claude' };
  return null;
}

/**
 * **「那台机器上 X 还没登录」**（`engines.ts` 的 `adapterAuthMessage`，中英都认）→ 哪一家。
 * 本机会话的提示上给「登录」按钮（开终端跑登录命令，登上了自动重连）；远端会话照旧用会话面板里的 🔑 登录。
 */
const NOT_LOGGED_IN = [
  /is not logged in on the machine running this session/,
  /跑这条会话的那台机器上 .{1,40}? 还没登录/,
];

export function engineLoginOffer(text: string | null | undefined): { engine: 'claude' | 'codex' } | null {
  const s = String(text || '');
  if (!NOT_LOGGED_IN.some((re) => re.test(s))) return null;
  if (/Codex/.test(s)) return { engine: 'codex' };
  if (/Claude Code/.test(s)) return { engine: 'claude' };
  return null;
}
