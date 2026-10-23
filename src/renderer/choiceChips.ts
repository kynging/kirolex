/**
 * **模型把选项写成文字时，给几个可点的片** ——「有一些问题会给用户提问并提供多个选项，
 * 这个怎么处理的」。
 *
 * ## 为什么只能靠认文本
 *
 * kiro-cli 的 ACP 里**没有**"问用户一个带选项的问题"这种方法。翻过那个二进制里所有的
 * 方法名：会向客户端要答案的只有 `session/request_permission`（工具授权），
 * `session/request_user_input` / `ask` / `choice` 这类一个都没有。
 * 所以模型想让你选，它只能把选项**写进回复文字**里。
 *
 * 2026-10-23 用 kiro-cli 2.13.0 重新核实：二进制里多了 ACP 的 elicitation 类型定义（sacp 11），但没有任何
 * "问用户"的工具，它自己的终端界面也没实现 `elicitation/create` —— 还是只能靠认文本。这一排片现在**只给 kiro**：
 * Claude Code / Codex 走真的提问表单（`components/QuestionCard.tsx`，`main/elicitation.ts`），不再从正文里猜第二套。
 *
 * 也就是说：这里没有任何结构化信息可用，只能从 markdown 里认。而"认"必然会误判，
 * 所以判据要保守 —— 下面每一条都在挡一种具体的误判。
 *
 * ## 判据（全部要满足）
 *
 * 1. **一段连续的编号/字母列表，至少 2 项**。一项不叫选项。
 * 2. **不在代码块里**。代码里的编号列表（枚举、步骤注释）最容易被误认。
 * 3. **列表前面要有"这是在问你"的信号**：问号（`?` / `？`），或者紧邻的上一行以
 *    冒号结尾（`：` / `:`）。没有这个信号的编号列表通常是**说明**（"我做了三件事：…"），
 *    把它变成按钮等于让人以为要选一个。
 * 4. **每项都短**（默认 ≤ 80 字符）。长段落的编号列表是文档，不是菜单。
 * 5. **最多 6 项**。更多的话它几乎肯定是一份清单而不是一次选择。
 *
 * ## 点了之后**不自动发**
 *
 * 只把那一项填进输入框。自动发会让人失去"再补一句"的机会（"2，但用 TypeScript"），
 * 而那恰恰是这类选择最常见的回答形状。而且误判时填进去还能删掉，发出去就收不回了。
 */

/** 一个可点的选项。 */
export interface ChoiceChip {
  /** 显示在片上的字（编号 + 内容，截断过的）。 */
  label: string;
  /** 点下去要填进输入框的文字（原样，不截断）。 */
  value: string;
}

/** 每项最长多少字符还算"选项"而不是段落。 */
export const MAX_ITEM_CHARS = 80;
/** 最多认几项。 */
export const MAX_CHIPS = 6;

/** `1. x` / `2) x` / `3、x` / `- 4. x` / `A. x` —— 认这几种写法。 */
const ITEM = /^\s*(?:[-*]\s+)?([0-9]{1,2}|[A-Za-z])\s*[.)、]\s+(\S.*)$/;

/**
 * 从一条助手消息里认出"带编号的选项"。认不出返回空数组。
 *
 * `text` 是 markdown 原文。
 */
export function extractChoiceChips(text: string): ChoiceChip[] {
  const raw = String(text || '');
  if (!raw.trim()) return [];

  /*
    **先把代码块整段抹掉** —— 代码里的编号列表是最容易误判的一类
    （枚举值、步骤注释）。抹成空行而不是删掉，这样行号关系不变，
    下面"紧邻的上一行"那个判断才不会串位。
  */
  const lines = raw.split('\n');
  let inFence = false;
  const usable: (string | null)[] = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return null; }
    return inFence ? null : line;
  });

  /* 找最后一段连续的列表 —— 一条消息里可能先讲一堆、最后才问你 */
  let best: { start: number; items: Array<{ tag: string; body: string; line: string }> } | null = null;
  let cur: { start: number; items: Array<{ tag: string; body: string; line: string }> } | null = null;
  for (let i = 0; i < usable.length; i += 1) {
    const line = usable[i];
    const m = line == null ? null : ITEM.exec(line);
    if (m) {
      const item = { tag: m[1], body: m[2].trim(), line: line as string };
      if (cur) cur.items.push(item);
      else cur = { start: i, items: [item] };
      continue;
    }
    /* 空行不打断列表（`1.\n\n2.` 是常见写法），别的行打断 */
    if (line != null && !line.trim()) continue;
    if (cur) { if (cur.items.length >= 2) best = cur; cur = null; }
  }
  if (cur && cur.items.length >= 2) best = cur;
  if (!best) return [];

  const { items } = best;
  if (items.length > MAX_CHIPS) return [];            // 清单，不是选择
  if (items.some((it) => it.body.length > MAX_ITEM_CHARS)) return [];

  /*
    **"这是在问你"的信号**：列表之前有问号，或者紧邻的上一行以冒号结尾。
    没有信号就不显示 —— "我做了三件事：…"那种说明变成按钮会让人以为要选一个。
    （注意冒号结尾本身就算信号，所以"我做了三件事："也会命中 —— 这是刻意的取舍：
    多显示一次可点的片，代价只是你不点它；而漏掉一次真的提问，代价是这个功能白做。）
  */
  const before = usable.slice(0, best.start).filter((l): l is string => l != null).join('\n');
  const prevLine = [...usable.slice(0, best.start)].reverse().find((l) => l != null && l.trim()) || '';
  const asked = /[?？]/.test(before) || /[：:]\s*$/.test(prevLine);
  if (!asked) return [];

  /* 去重（同一项写两遍的话片也会重复），并保持原顺序 */
  const seen = new Set<string>();
  const chips: ChoiceChip[] = [];
  for (const it of items) {
    const value = it.body;
    if (seen.has(value)) continue;
    seen.add(value);
    chips.push({ label: `${it.tag}. ${value}`, value });
  }
  return chips;
}
