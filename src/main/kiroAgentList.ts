/**
 * **`kiro-cli agent list` 的输出怎么解析** —— 抽出来是因为现在有**两个**调用者：本机那份，
 * 和远程会话去问**那台机器**的那份（「对远程会话，那个机器人按钮显示的还是本地的 agent 列表，
 * 不是远程的」）。
 *
 * 为什么要按机器分：kiro-cli 只认**它自己机器上** `~/.kiro/agents/` 里的 agent。拿本机的列表
 * 给远程会话选，选中的名字在远端不存在 —— 而那条路有兜底（`remoteAgentScript` 会退回默认 agent
 * 并在会话里说一句），于是表现是"下拉里明明有，选了却静默换成了别的 agent"。
 *
 * 这个命令**没有 JSON 模式**，所以只能解析它那张表；有的版本把表写到 stderr，所以调用方都带
 * `2>&1`。解析保持宽松：认不出来的行直接跳过，宁可少几个也不要塞进一行标题。
 */

export interface KiroAgentInfo {
  name: string;
  isDefault: boolean;
  source: 'built-in' | 'global' | 'local';
}

/** 内建的那几个排最前（它们在任何机器上都有，当"总能选"的兜底）。 */
const BUILT_IN_ORDER = ['kiro_default', 'kiro_help', 'kiro_planner'];

export function parseAgentList(output: string): KiroAgentInfo[] {
  const agents: KiroAgentInfo[] = [];
  for (const raw of String(output || '').split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const match = line.match(/^(\*)?\s+([A-Za-z0-9_.\-]+)\s{2,}(\(Built-in\)|Global|Local)(?:\s|$)/);
    if (!match) continue;
    const source = match[3] === '(Built-in)'
      ? 'built-in'
      : match[3].toLowerCase() as 'global' | 'local';
    agents.push({ name: match[2], isDefault: !!match[1], source });
  }
  agents.sort((left, right) => {
    const leftRank = BUILT_IN_ORDER.indexOf(left.name);
    const rightRank = BUILT_IN_ORDER.indexOf(right.name);
    if (leftRank >= 0 && rightRank >= 0) return leftRank - rightRank;
    if (leftRank >= 0) return -1;
    if (rightRank >= 0) return 1;
    return 0;
  });
  return agents;
}
