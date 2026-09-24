/**
 * **本机那些 agent 的定义** —— 远程会话要用它做底子。
 *
 * ## 这个文件为什么只剩下两个读函数
 *
 * 它原来干的是"把 `~/.kiro/agents/*.json` **同步**到远端，再去远端验一遍那个 agent 在不在、
 * 它要的 MCP 命令缺哪些"。那一套整个去掉了（「你把远程 kiro 的那些 agent 啥的清理一下，
 * 包括 mcp 啥的应该都不需要了」），原因是实测出来的三件事：
 *
 *   · 远端那些被推过去的 JSON **没人读**：KiroLex 每次起远程执行器时会**生成**一份
 *     `kirolex-local-<会话>.json` 写到远端，内容从本机这份内联进去，然后用 `--agent` 指定它。
 *   · 拷 `mcpServers` 过去是**有害**的：那些命令是本机路径（`/opt/homebrew/bin/node`、
 *     `~/.local/bin/mcp-proxy-for-aws`…），远端没有 —— kiro-cli 不报错，只是静默少掉这些工具。
 *   · `resources: file:///Users/...` 同理，远端每次启动都打 `File URI not found`。
 *
 * 所以现在只需要"读出本机那份定义"，剩下的交给 `remoteLocalTools.buildSessionAgent`
 * （它按白名单挑字段，见那里的注释）。远端要配和本地不一样的东西时，那应该是**显式的一份
 * 远端配置**，而不是靠拷本机的 —— 拷出来的东西没人说得清它为什么在那儿。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** 本机 agent 定义所在的目录。 */
export function agentsDir(home = os.homedir()): string {
  return path.join(home, '.kiro', 'agents');
}

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
 * 给"那条会话专用的 agent"当底子用（`remoteLocalTools.buildSessionAgent`）。
 * 读不到返回 `null` —— 那时生成的是一份只有本地工具的 agent，而不是猜一个。
 */
export function localAgentJson(agent: string, home = os.homedir()): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(agentsDir(home), `${agent}.json`), 'utf-8'));
  } catch {
    return null;
  }
}
