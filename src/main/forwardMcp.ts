/**
 * **本机哪些 MCP 该转发给远端会话** ——「那操作本地的 playwright 和 compute use 呢」。
 *
 * 判据是**实测出来的那条**：一个 MCP 的命令指向**本机路径**时，它在远端根本起不来 ——
 * 而 kiro-cli 对这种情况不报错，只是静默少掉那些工具（日志里那句
 * 「agent aws-agent 缺 MCP 命令：/opt/homebrew/bin/node, /Users/keyinan/.local/bin/…」就是它）。
 * 所以这类 MCP **只有两种正确处理**：转发到本机来跑，或者干脆别给它。
 *
 * 还有一类命令名看着是通用的（`npx` / `uvx` / `python3`），远端**也有**同名可执行文件 ——
 * 但那不代表它能用：`npx @playwright/mcp` 在远端会拉起**远端**那台机器的浏览器，
 * 而你要的是点你自己屏幕上那个。这一类靠名字白名单挑（`FORWARD_BY_NAME`），
 * 因为"它该在哪台机器上跑"是语义问题，命令行里看不出来。
 *
 * 这个模块只做**纯**判断（挑哪些、用什么名字），起进程和转发在 `localMcp.ts`。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * 按名字就该转发的那些 —— 它们的意义就是"操作我这台机器"。
 *
 * `playwright`：驱动浏览器。远端那台没有显示器，而且就算有，你也看不见它点了什么。
 * 剩下两个是同一类（画布 / 设计工具都在本机 app 里），先放进来是因为它们的命令本来就是
 * 本机绝对路径 —— 列在这里只是让意图显式，判据不靠它们也成立。
 */
export const FORWARD_BY_NAME = ['playwright', 'drawio', 'pencil'];

export interface McpEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** 本机那份 agent 定义（读不到返回 null —— 那时不转发任何东西，而不是猜）。 */
export function localAgentJson(agent: string, home = os.homedir()): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.kiro', 'agents', `${agent}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

/** 命令是不是一个**本机路径**（绝对路径 / `~` 开头）。这种在远端必然不存在。 */
export function isLocalPathCommand(command: string): boolean {
  const c = String(command || '').trim();
  return c.startsWith('/') || c.startsWith('~');
}

/**
 * 从一份 agent 定义里挑出该转发的 MCP。
 *
 * `disabled: true` 的跳过（那是你自己关掉的）；`type: 'http'` 的也跳过 ——
 * 那种本来就是"某个地址上的服务"，远端自己也能敲同一个地址，没有转发的理由。
 */
export function forwardableFrom(agentJson: any): McpEntry[] {
  const servers = (agentJson && typeof agentJson === 'object' && agentJson.mcpServers) || {};
  const out: McpEntry[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, any>)) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.disabled) continue;
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) continue;                                  // http/url 型：远端自己能连
    if (!FORWARD_BY_NAME.includes(name) && !isLocalPathCommand(command)) continue;
    out.push({
      name,
      command,
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      env: (raw.env && typeof raw.env === 'object') ? raw.env : undefined,
    });
  }
  return out;
}

/**
 * 注入里那一句。
 *
 * 不说的话它会以为这些工具作用在自己那台机器上 —— 而"我以为我在自己机器上点浏览器"
 * 恰恰是最难看出来的一类错（截图回来的是另一台机器的屏幕）。
 */
export function forwardHelp(names: string[]): string {
  if (!names.length) return '';
  return `· 这些 MCP 的工具**作用在用户那台机器上**（KiroLex 把它们从用户机器转发过来）：`
    + `${names.map((n) => `\`${n}\``).join('、')}。`
    + `所以 \`browser_*\` 之类点的是**他屏幕上**那个浏览器 —— 这也正是他要看的；`
    + `这台机器上没有图形界面，别在这里另起一个。`;
}
