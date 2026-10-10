/**
 * 输入框里那份**斜杠命令表** —— 判据在这里，PURE。
 *
 * 「原先增加过一个 kiro 命令比如 clear agent model 的自动识别怎么没有了」。
 *
 * 表由后端在 `_kiro.dev/commands/available` 里推来（`/clear`、`/agent`、`/model`… 这条会话真正
 * 支持的那些）。功能一直都在，坏掉的是那份表的**寿命**：后端一条会话只推**一次**（连上之后），
 * 而渲染进程原来只把它放在一个内存 Map 里 —— 窗口一重载（开发时一次 HMR 也算）就空了，
 * 后端不会再推，于是打 `/` 什么都不弹，直到你新建会话或者重连。
 *
 * 修法和 agent 列表那次同一个形状：**放到活得更久的那一层**（主进程 `SessionEntry.commands`），
 * 渲染进程发现自己空了就去取（`acp:session-commands`）。于是这段解析有了两个入口，所以它搬到
 * 这个自己的文件里 —— 两条路走同一段代码，语义才一定一致；各写一遍的话，某天只改了一处，
 * 同一条会话就会因为"表从哪来"而表现不同，而那种差别没人会想到去查。
 */

export interface SlashCommand {
  name: string;
  description?: string;
  hint?: string;
  subcommands?: string[];
}

/**
 * 后端那份原始表 → 输入框用的形状 —— PURE。
 *
 * 不是数组、或者某一条没有 `name`，一律丢掉：一份读不懂的表不该把输入框弄崩，而"少弹几条"
 * 比"打字时崩一下"好得多。
 */
export function toSlashCommands(raw: unknown): SlashCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((command: any) => typeof command?.name === 'string')
    .map((command: any) => ({
      name: command.name,
      description: command.description,
      hint: command.meta?.hint || undefined,
      subcommands: command.meta?.subcommands || undefined,
    }));
}
