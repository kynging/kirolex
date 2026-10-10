/**
 * 重建上下文的那份历史该带多少 —— PURE。
 *
 * ## 实测撞上的那次
 *
 * 「⚠️ Error invoking remote method 'acp:prompt': Error: Internal error — Kiro failed to generate a response」
 *
 * 现场（2026-09-01 00:40，`Aurora to S3 Iceberg`）：连续三次 `Internal error`，每次 5–7 秒就失败。
 * 不是模型退役（日志里没有 `unavailable at prompt time`，也没换模型）。真正的数字是
 *
 *   transcript.jsonl   939 KB / 497 条
 *   history.md         696 KB      ← 这份是喂给后端重建上下文的
 *
 * 696 KB 中文正文远超任何模型的窗口，于是后端只回一句笼统的 `Internal error`。而 `renderHistoryFile`
 * **一个上限都没有**：它把整份 transcript 全渲出来，会话越长越必然撞墙 —— 而撞墙的那一天，
 * 报错里一个字都不提"太大了"。
 *
 * ## 判据：留最近的，丢最早的，并且**说出丢了多少**
 *
 * 从后往前收，收到预算用完为止。丢掉的不是静默消失 —— 顶部留一行说明，因为
 * 「你看到的和模型知道的不是同一份」比两个极端都糟（`/clear` 那条也是这么定的）。
 *
 * 留**最近的**而不是最早的：最近那几轮是你正在谈的东西；开头那几轮通常已经被后来的结论取代。
 *
 * `keepAtLeast` 是硬底：预算再小也要留住最后几条，否则一条超长的消息就能把历史清空 ——
 * 那时模型完全不知道你刚说了什么，而它看起来只是"答得莫名其妙"。
 */

export interface HistoryEntry {
  /** 这条渲染出来的文本（`historyLine` 的产物）。 */
  line: string;
}

export interface HistoryBudgetResult<T extends HistoryEntry> {
  /** 要写进历史文件的那些，按原顺序（早 → 晚）。 */
  kept: T[];
  /** 丢掉了多少条。0 表示全带上了。 */
  dropped: number;
  /** 保留部分的字节数（按 UTF-8 估）。 */
  bytes: number;
}

/** UTF-8 字节数。中文一个字 3 字节，用 `length` 估会差三倍 —— 而这个判据的全部意义就是别估错。 */
export const utf8Bytes = (text: string): number => Buffer.byteLength(text || '', 'utf8');

/**
 * 默认预算 **256 KB**。
 *
 * 不是随手写的：实测 696 KB 直接失败，而这条会话之前几百 KB 时是能跑的。256 KB 中文约 8 万字，
 * 对"接着刚才那个话题"足够，同时给提示词里别的东西（memory 注入实测 13 KB、ride-along 快照 17 KB、
 * 以及这一轮你真正要说的话）留出余量。
 *
 * 宁小勿大：带少了模型会问你"刚才说到哪"，带多了这一轮**根本跑不起来**，而后者的报错完全不指向原因。
 */
export const HISTORY_BUDGET_BYTES = 256 * 1024;

/** 预算再小也要留住的条数 —— 见上面 `keepAtLeast` 那段。 */
export const HISTORY_KEEP_AT_LEAST = 6;

export function fitHistory<T extends HistoryEntry>(
  entries: T[] | null | undefined,
  opts?: { budgetBytes?: number; keepAtLeast?: number },
): HistoryBudgetResult<T> {
  const all = Array.isArray(entries) ? entries : [];
  const budget = opts?.budgetBytes ?? HISTORY_BUDGET_BYTES;
  const floor = Math.max(0, opts?.keepAtLeast ?? HISTORY_KEEP_AT_LEAST);

  let bytes = 0;
  let take = 0;
  // 从后往前：最近的先进
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const size = utf8Bytes(all[i].line) + 8;      // +8 ≈ 条目之间那个分隔符
    if (bytes + size > budget && take >= floor) break;
    bytes += size;
    take += 1;
  }
  const kept = take ? all.slice(all.length - take) : [];
  return { kept, dropped: all.length - kept.length, bytes };
}

/**
 * 丢掉了就要在历史文件顶部说一句 —— PURE。
 *
 * 「你看到的和模型知道的不是同一份」是这套机器最该避免的状态。界面上那 497 条还在（transcript 不动），
 * 而模型只拿到最近的一批 —— 这个差别必须写在模型看得见的地方，否则它会以为自己拿到的是全部，
 * 从而对"我们之前说过 X"这种问题给出自信的错答案。
 */
export function historyTrimNote(dropped: number, total: number): string {
  if (dropped <= 0) return '';
  return `# ⚠️ 这份历史**不完整**：共 ${total} 条，这里只有最近 ${total - dropped} 条，`
    + `更早的 ${dropped} 条因为超出上下文预算被省略。\n`
    + '# 需要更早的内容时**问用户**，不要凭这半份历史推断"我们之前说过什么"。\n';
}
