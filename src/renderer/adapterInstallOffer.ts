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
export type AdapterEngine = 'claude' | 'codex';

const MISSING = [
  /Could not find the ACP adapter for /,
  /没找到 .{1,40}? 的 ACP 适配器/,
  /has no ACP adapter for /,
  /上没有 .{1,40}? 的 ACP 适配器/,
];

export function adapterInstallOffer(text: string | null | undefined): { engine: AdapterEngine } | null {
  const s = String(text || '');
  if (!MISSING.some((re) => re.test(s))) return null;
  if (/codex-acp/.test(s)) return { engine: 'codex' };
  if (/claude-agent-acp/.test(s)) return { engine: 'claude' };
  return null;
}
