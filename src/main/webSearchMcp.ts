/**
 * **把 kiro-cli 默认 agent 的 web search MCP 也给远端的 claude code 用** ——
 * 「你先看一下 kiro-cli 默认 agent 的 web search mcp，把这个 mcp 也装到这个 claude code 上面」。
 *
 * kiro-cli 的内置 agent `kiro_default` 挂着一个 `agentcore-websearch`：
 *
 * ```
 * mcp-proxy-for-aws https://websearch-…gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp \
 *   --service bedrock-agentcore --region us-east-1 --profile default
 * ```
 *
 * ## 为什么从**进程**里读，而不是写死在脚本里
 *
 * 那个网关地址是这个账号自己的（`websearch-gw-<id>`），写进仓库既是泄漏、也会在换账号之后变成
 * 一个悄悄失效的配置。而 `kiro_default` 是编译进 kiro-cli 的内置 agent，磁盘上**没有**对应的
 * 配置文件可读（实测：`~/.kiro/agents` 里只有自建的那些，二进制里也 grep 不到这个 URL）。
 *
 * 能拿到它的地方只剩一个：KiroLex 本来就在本机跑着 kiro-cli，而 kiro-cli 起 MCP 时把完整命令行
 * 摆在进程表里。所以这里做的事就是"看一眼本机实际在用什么"，然后把同一套配置装到远端去。
 * 拿不到就明确跳过（并说清为什么），绝不猜一个地址。
 */

export interface WebSearchMcp {
  /** SigV4 的 MCP 端点。 */
  url: string;
  /** 签名用的服务名（`--service`）。 */
  service?: string;
  region?: string;
}

/**
 * 从 `ps` 的一行命令行里认出 mcp-proxy-for-aws 的调用。
 *
 * **不带 `--profile`**：本机用的是 `--profile default`，而远端（EC2）走的是实例角色 ——
 * 那台机器上大概没有名叫 default 的 profile，照抄过去只会让它启动就失败。
 */
export function parseProxyCommand(line: string): WebSearchMcp | null {
  const s = String(line || '');
  if (!/mcp-proxy-for-aws/.test(s)) return null;
  const url = /(https:\/\/[^\s'"]+)/.exec(s)?.[1];
  if (!url) return null;
  return {
    url,
    service: /--service\s+([^\s]+)/.exec(s)?.[1],
    region: /--region\s+([^\s]+)/.exec(s)?.[1],
  };
}

/** 从一堆进程命令行里挑出 web search 那一个（同一个代理可能被用在别的端点上）。 */
export function pickWebSearch(lines: string[]): WebSearchMcp | null {
  const all = (lines || []).map(parseProxyCommand).filter((x): x is WebSearchMcp => !!x);
  return all.find((m) => /websearch/i.test(m.url)) || all[0] || null;
}

/** 装到 claude code 里的那条命令（幂等由脚本负责）。 */
export function claudeMcpAddArgs(name: string, mcp: WebSearchMcp): string[] {
  return [
    'mcp', 'add', '--scope', 'user', name, '--',
    'mcp-proxy-for-aws', mcp.url,
    ...(mcp.service ? ['--service', mcp.service] : []),
    ...(mcp.region ? ['--region', mcp.region] : []),
  ];
}
