/**
 * 一次**范围更大的重写** → 逐行补丁 —— PURE。
 *
 * 从 feature/flow 搬过来。那边门上按补丁的 `edits` / `inserts` / `drops` 落产出；这边（侧栏 review）
 * 只用其中的 `keep`：改写落盘之后，**剩下那些还没处理的意见跟着它们那一行走**（旧行号 → 新行号）。
 * 下面那段说的"门上"的毛病，在侧栏一模一样 —— 意见按行号记，行数一变就指到别的句子上。
 *
 * 「而且这个为什么是 pin 的状态啊，我不是说了不需要这个吗，所有的 comment 都立刻给我改啊」。
 *
 * ## 为什么需要它
 *
 * 一条意见改不了单独一段时（`CANNOT-REVISE-LOCALLY`），之前的做法是把它记成待办（📌）—— 用户明确
 * 不要这个：每条 comment 都得当场生效。而"当场生效"对跨块的意见（「把这个移到上面变成第四条」、
 * 「下一步里不要写 SFDC」）意味着必须让模型改一个**更大的范围**：这一节，或者整份产出。
 *
 * 麻烦在于门上的一切都按**原文的行号**记账：`edits` / `drops` / `applied` 都以行号为键。
 * 把一份重写按位置摊回去（`spreadSpanEdit`）在"行数不变"时是对的，可一旦有增删，
 * 后面每一行的身份都整体挪位 —— 产出还是对的，但**记录会指到别的句子上**，
 * 而"comment 跑到错的行上"正是这一路修了一整天的东西。
 *
 * 所以这里不按位置摊，而是**先对齐再落差异**（最长公共子序列）：
 *   · 两边都有的行 → 什么都不做，**锚点原样保留**（记录、意见都还指着它）
 *   · 只在旧文里的行 → `drops`（真的从产出里去掉）
 *   · 只在新文里的行 → 接在**前一个保留下来的行**的 `edits` 上（多行 edit，`applyBlockChanges` 支持）
 *
 * 于是一次"把这一条搬到上面去"落下来就是：源行标删、目标位置前一行多带几行 —— 别处一个字节不动。
 */

/** 一行块：只需要行号和正文（和 `tableEdits.TextBlock` 兼容）。 */
export interface PatchBlock { index: number; text: string }

export interface RewritePatch {
  /** 行号 → 新正文（**一行**：多出来的行走 `inserts`，见下面那段）。 */
  edits: Record<number, string>;
  /**
   * **行号 → 接在它后面的那些新行，一行一条** ——「非项目事项 / [AI 实践] Security Agent 代码评审闭环 /
   * [9/18] 本地开发环境维护 这几个很明显是黏在一起了」+「讯兔和 dyna 那两条应该是两段」。
   *
   * 原来一个 hunk 里新增的行**全接在同一个 edit 上**（`edits[x] = added.join('\n')`），于是改写一次之后
   * 一整节、甚至两个客户的八个字段挤成一块：共用一个 💬/✕，逐行提意见的入口没了。产出的文字是对的，
   * 坏掉的是颗粒度。块按原文行号索引（没有"第 13.5 行"），所以多出来的行走门上已有的 `inserts`
   * （「＋ 加一条」那套）：各自一块、各自有按钮，落盘和放行都已经支持。
   */
  inserts: Record<number, string[]>;
  /** 被删掉的行。 */
  drops: Record<number, true>;
  /** 新文开头多出来的行没有"前一行"可挂 —— 只能接在第一个保留行之前，这里记下来给调用方提示。 */
  prefix?: string;
  /**
   * **旧行号 → 新行号**（只含两边都有的那些行）—— 给"按行号记账的东西"重新对位用。
   *
   * 侧栏 review 把意见按**文件的行号**记（`comments[12]`）。改完之后行数一变，那些行号就指到别的
   * 句子上了 —— 和门上"记录跑到错的行上"是同一个毛病。有了这张表，剩下那些意见能跟着它们那一行走；
   * 表里没有的（那一行被改掉或删掉了）说明它评的东西已经不在了，调用方据此决定是丢掉还是保留。
   */
  keep: Record<number, number>;
}

/** 比对用的规范形式 —— 只吃掉首尾空白：行内的差别（哪怕一个标点）都算改过。 */
function norm(s: string): string {
  return String(s ?? '').trim();
}

/**
 * 最长公共子序列的对齐位置 —— 返回 `[旧下标, 新下标]` 的配对。
 *
 * 走标准 DP。门上的产出实测 60–80 行，`O(n·m)` 完全够；换成 Myers 的收益还不如它带来的读不懂。
 */
function align(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i += 1; j += 1; continue; }
    if (dp[i + 1][j] >= dp[i][j + 1]) i += 1; else j += 1;
  }
  return out;
}

/**
 * 旧块 + 新正文 → 补丁 —— PURE。
 *
 * `blocks` 必须是**当前**这一份（逐行取「改过的那份 ?? 原文」），否则算出来的差异是对着原文说的，
 * 会把上一轮的改动当成"新增"再来一遍。
 */
export function rewritePatch(blocks: PatchBlock[], newText: string): RewritePatch {
  const old = blocks.map((b) => norm(b.text));
  /*
    比对只看非空行（空行不成块），但 `keep` 要给的是**新文里真实的行号** —— 侧栏 review 按 `lineBlocks`
    的行号记意见，而那个行号是含空行在内数的。原来这里给的是"第几个非空行"：文件里只要有空行
    （markdown 几乎必有），改写一次之后剩下那些意见就挂到了别的句子上。
  */
  const next: string[] = [];
  const nextLine: number[] = [];
  String(newText ?? '').split('\n').forEach((raw, at) => {
    const l = norm(raw);
    if (l !== '') { next.push(l); nextLine.push(at + 1); }
  });
  const pairs = align(old, next);
  const edits: Record<number, string> = {};
  const inserts: Record<number, string[]> = {};
  const drops: Record<number, true> = {};
  const keep: Record<number, number> = {};
  let prefix: string | undefined;
  /**
   * 一行照旧留在原位，**多出来的各自成一块** —— 见 `RewritePatch.inserts`。
   *
   * 顺带把**没变的那一行不写成 edit**：「后面还有一个素材覆盖：是怎么回事，我没有 comment 过这个」——
   * 模型把某一行原样抄回来时，原来照旧记成一次"编辑"，于是那一块显示成改过的、还挂上一句
   * 「这一段已按你写的替换」，而它一个字都没动、你也没对它说过任何话。
   */
  const put = (index: number, lines: string[], original: string) => {
    const rows = lines.map(norm).filter(Boolean);
    if (!rows.length) return;
    if (rows[0] !== norm(original)) edits[index] = rows[0];
    const rest = rows.slice(1);
    if (rest.length) inserts[index] = [...(inserts[index] || []), ...rest];
  };
  /*
    对齐点之间那一段就是一个 hunk：旧文里删掉的那几行 + 新文里多出来的那几行。
    **优先配成"替换"**：第一条被删的行领走全部新增内容（多行 edit），其余被删的行才真的标删。
    这么配的理由是**锚点**：一行改了几个字，如果记成"删掉这一行 + 在上一行后面补一行"，
    它的行号就没了，挂在它上面的 comment 记录跟着无处可去 —— 而"记录跑到别的句子上"是这一路的老毛病。
    一边空着时才退回另一种：只有新增就接在前一个保留行后面，只有删除就单纯标删。
  */
  const hunk = (oldFrom: number, oldTo: number, addFrom: number, addTo: number, prevKept: number) => {
    const removed: number[] = [];
    for (let i = oldFrom; i < oldTo; i += 1) removed.push(i);
    const added = next.slice(addFrom, addTo);
    if (removed.length && added.length) {
      /**
       * **整段换掉的那种：旧行全标删，新内容整段算"新加的"** ——
       * 「放屁，Dyna 那个和下面的那些一样是 comment 后新加的」。
       *
       * 实测那一处：原文第 9 行是占位的「无。本周没有…客户项目进展。」，一条意见让模型写出两个
       * 完整的客户小节（18 行）。原来的配法是"第一行替换第 9 行、其余算新增"——于是**同一段新内容
       * 被切成两种身份**：标题成了"改过的原文块"（还挂一句没人负责的"正文已改过"），
       * 它下面八个字段成了"新加的内容"。而它们明明是一起来的。
       *
       * 所以只有**一行换一行**（改个措辞）才保留原位替换 —— 那时保住行号是有意义的：挂在这一行上的
       * comment 记录还认得它。换成多行时这一行的身份本来就没了，标删 + 整段插在前一个保留行之后，
       * 界面上就是一整段"新加的内容"，和它实际的来历一致。
       */
      if (added.length === 1) {
        put(blocks[removed[0]].index, added, blocks[removed[0]].text);
        for (const i of removed.slice(1)) drops[blocks[i].index] = true;
        return;
      }
      for (const i of removed) drops[blocks[i].index] = true;
      const rows = added.map(norm).filter(Boolean);
      if (prevKept >= 0) {
        const at = blocks[prevKept].index;
        inserts[at] = [...(inserts[at] || []), ...rows];
      } else {
        prefix = [...(prefix ? [prefix] : []), ...rows].join('\n');
      }
      return;
    }
    if (removed.length) {
      for (const i of removed) drops[blocks[i].index] = true;
      return;
    }
    if (!added.length) return;
    if (prevKept >= 0) {
      /* 纯新增：那一行本身不动（不写 edit），新增的各自成一块跟在它后面 */
      const at = blocks[prevKept].index;
      inserts[at] = [...(inserts[at] || []), ...added.map(norm).filter(Boolean)];
    } else {
      /* 开头新增的行没有"前一行"可挂 —— 单独交出来，不要静默丢掉 */
      prefix = [...(prefix ? [prefix] : []), ...added].join('\n');
    }
  };
  let oi = 0;
  let nj = 0;
  let prevKept = -1;
  for (const [i, j] of pairs) {
    hunk(oi, i, nj, j, prevKept);
    /* 两边都有的这一行：记下它搬到了新文的第几行（**真实行号**，含空行、从 1 起 —— 和 `lineBlocks` 一致） */
    keep[blocks[i].index] = nextLine[j];
    prevKept = i;
    oi = i + 1;
    nj = j + 1;
  }
  hunk(oi, blocks.length, nj, next.length, prevKept);
  return prefix ? { edits, inserts, drops, keep, prefix } : { edits, inserts, drops, keep };
}
