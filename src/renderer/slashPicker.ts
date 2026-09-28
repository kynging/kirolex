/**
 * **`/model` 和 `/agent` 在 KiroLex 里该走自己的下拉** ——「你建一个会话测试一下呢？
 * cli 里面是会有选项的」。
 *
 * ## 实测出来的事实
 *
 * 终端里 `/model` 是一个上下键选的 picker。但**那是 TUI 的东西，ACP 不带它** ——
 * 直接驱动 `kiro-cli acp` 发 `/model`，回来的是一堆纯文本：
 *
 * ```
 *   auto (auto)
 *   gpt-5.6-sol (gpt-5.6-sol)
 * → gpt-5.6-luna (gpt-5.6-luna)     ← 当前那个用箭头标
 *   qwen3-coder-next (qwen3-coder-next)
 * ```
 *
 * 没有任何结构化选项（零个 REQUEST，只有 `agent_message_chunk`）。`/agent` 同理，
 * 而且它会把每个 agent 的整段 description 都刷出来。
 *
 * 也就是说这两条命令在 KiroLex 里得到的是**最差的那个版本**：一堆读不动的文字，
 * 还占掉一轮。而 KiroLex 本来就有真正的模型下拉（带倍率、按机器过滤过）和 agent 下拉。
 *
 * ## 为什么带参数的也要拦
 *
 * `/model gpt-5.6-sol` 在终端里是能用的，但在 KiroLex 里它更糟：kiro-cli 会**内部**
 * 换掉模型，而 KiroLex 不知道 —— 下拉里显示的还是旧的那个。而 KiroLex 换模型走的是
 * "重起执行器 + 改 agent JSON"那条路（`acp:switch-model`），两边状态才对得上。
 * 所以带参数的也接过来，走自己的那条路。
 */

export type PickerKind = 'model' | 'agent';

export interface SlashIntent {
  kind: PickerKind;
  /** 用户给的参数（`/model gpt-5.6-sol` → `gpt-5.6-sol`）。没给就是空串 = 开下拉。 */
  arg: string;
}

/**
 * 这条输入是不是该被接下来的 `/model` / `/agent`。不是就返回 `null`（原样发给 kiro-cli）。
 *
 * 只认**整条输入就是这个命令**的情况：`/model` 出现在一句话中间时那是在讨论它，不是在用它。
 */
export function slashIntent(text: string): SlashIntent | null {
  const t = String(text || '').trim();
  const m = /^\/(model|agent)(?:\s+(.*))?$/i.exec(t);
  if (!m) return null;
  return { kind: m[1].toLowerCase() as PickerKind, arg: (m[2] || '').trim() };
}

/**
 * 参数对到哪个候选。大小写不敏感，也允许**前缀**唯一匹配
 * （`/model opus` → `claude-opus-5`，只要前缀只命中一个）。
 *
 * 命中多个就返回 `null` 并把候选交给调用方去说 —— 猜一个是最糟的:
 * 换错模型这件事要等到账单或者输出风格变了才会被发现。
 */
export function resolveChoice(arg: string, options: string[]): { exact?: string; matches: string[] } {
  const a = arg.trim().toLowerCase();
  if (!a) return { matches: [] };
  const exact = options.find((o) => o.toLowerCase() === a);
  if (exact) return { exact, matches: [exact] };
  const matches = options.filter((o) => o.toLowerCase().startsWith(a));
  return matches.length === 1 ? { exact: matches[0], matches } : { matches };
}
