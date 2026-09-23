/**
 * **agent 配置也得同步到远端** ——「还有什么 agent 配置之类的是不是得同步给远程 kiro？要不然切不过去？」
 *
 * 会切不过去，而且**是静默的**。实测：远端用一个它没有的 agent 起 ACP
 * （`kiro-cli acp --agent weekly-report`），它照样启动、照样正常答 `initialize`，
 * 唯一的区别是 `mcpCapabilities.http` 从 `true` 变成 `false` —— 它悄悄退回了默认 agent。
 * 于是这条会话跑起来是"好的"，但 system prompt、工具白名单、MCP 全没了，
 * 产出看起来正常、其实是另一个 agent 干的。界面上一个字都不会说。
 *
 * 所以远程会话在起执行器之前把本机的 agent 配置推过去，并且**推完要验一遍**：
 * 那个 agent 在远端存在才继续，不存在就明确拒绝 —— 宁可不跑，也不要拿错的 agent 跑。
 *
 * ## 一个不能假装解决的问题：MCP
 *
 * agent 的 JSON 里写着 MCP 服务器的**命令**（`builder-mcp`、`/Users/…/mcp-proxy-for-aws`）。
 * 配置搬过去了，命令不一定在那台机器上。kiro-cli 对这种情况的处理是"记一行日志然后继续" ——
 * 又是静默降级。所以这里把命令名挑出来，让调用方去远端 `command -v` 一遍，缺哪个就说哪个。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** 本机 kiro agent 配置目录。 */
export function agentsDir(home = os.homedir()): string {
  return path.join(home, '.kiro', 'agents');
}

/** 远端那一份（同一个相对位置 —— kiro-cli 在那台机器上也按 `$HOME/.kiro/agents` 找）。 */
export const REMOTE_AGENTS_DIR = '~/.kiro/agents';

/** 本机有哪些 agent（文件名去掉 `.json`）。 */
export function localAgents(home = os.homedir()): string[] {
  try {
    return fs.readdirSync(agentsDir(home))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 一个 agent 的原始 JSON。
 *
 * 给"那条会话专用的 agent"当底子用（`remoteLocalTools.buildSessionAgent`）——
 * 必须是**原样**的一份：kiro-cli 对这个文件严格校验，而它的 prompt / 工具白名单 / 别的 MCP
 * 少掉任何一样，产出就是另一个 agent 干的。
 */
export function localAgentJson(agent: string, home = os.homedir()): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(agentsDir(home), `${agent}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 从一份 agent 配置里挑出它依赖的 MCP **命令名**。
 *
 * 只要命令本身（`builder-mcp`、`npx`、绝对路径的那种取 basename 之外还保留原样），
 * 因为要拿去远端 `command -v`。
 */
export function mcpCommands(agentJson: unknown): string[] {
  const out = new Set<string>();
  const servers = (agentJson as any)?.mcpServers;
  if (servers && typeof servers === 'object') {
    for (const v of Object.values(servers as Record<string, any>)) {
      const cmd = typeof v?.command === 'string' ? v.command.trim() : '';
      if (cmd) out.add(cmd);
    }
  }
  return [...out];
}

/** 读一个 agent 的 MCP 命令（读不到就当没有 —— 这一步不该让启动失败）。 */
export function mcpCommandsOf(agent: string, home = os.homedir()): string[] {
  try {
    return mcpCommands(JSON.parse(fs.readFileSync(path.join(agentsDir(home), `${agent}.json`), 'utf-8')));
  } catch {
    return [];
  }
}

/**
 * 推 agent 配置用的 rsync 参数。
 *
 * **没有 `--delete`**：远端可能有它自己的 agent（实测那台机器上就有四个 `kirolex-*`），
 * 同步不该把别人的东西清掉。只推 `*.json`。
 */
export function agentSyncArgs(sshHost: string, sshCommand: string, home = os.homedir()): string[] {
  return [
    '-a',
    '-e', sshCommand,
    '--include', '*.json',
    '--exclude', '*',
    `${agentsDir(home)}/`,
    `${sshHost}:${REMOTE_AGENTS_DIR}/`,
  ];
}

/** 远端检查：这个 agent 在不在 + 它要的命令哪些不在。一条 ssh 问完。 */
export function agentCheckScript(agent: string, commands: string[]): string {
  const tests = commands.map((c) => `command -v ${JSON.stringify(c)} >/dev/null 2>&1 || echo "MISSING ${c}"`);
  return [
    `test -f ~/.kiro/agents/${JSON.stringify(agent).replace(/"/g, '')}.json && echo AGENT_OK || echo AGENT_MISSING`,
    ...tests,
  ].join('; ');
}

export interface AgentCheck {
  present: boolean;
  /** agent 依赖、但远端没有的 MCP 命令。 */
  missingCommands: string[];
}

export function parseAgentCheck(stdout: string): AgentCheck {
  const s = String(stdout || '');
  return {
    present: /AGENT_OK/.test(s),
    missingCommands: [...s.matchAll(/^MISSING (.+)$/gm)].map((m) => m[1].trim()),
  };
}
