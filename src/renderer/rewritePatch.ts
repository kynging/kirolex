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
/**
 * 侧栏 review 每次落盘都拿**整份文件**来对（`writeBack`），一份接近 512KB 的文件有上万行 —— 整张 DP 表就是
 * 上亿格、几个 GB，界面直接卡死。所以先剥掉首尾相同的行（一次改写通常只动中间一小段），只对中间那段做 DP。
 *
 * 中间那段还是太大（首尾各改了一行这种）：**不能放弃对齐** —— 那一段里没改的行就都没有 `keep`，挂在上面的意见
 * 和删除标记全被清掉。这时先用"两边都只出现一次的行"当锚点（按先后取最长的一串，patience 的做法），
 * 锚点之间的每一小段再递归对齐；一个锚点都找不到、又大到 DP 不起时才放弃那一小段。
 */
const ALIGN_MAX_CELLS = 4_000_000;

function align(a: string[], b: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  alignRange(a, b, 0, a.length, 0, b.length, out);
  return out;
}

/** 对齐 `a[a0..a1)` 和 `b[b0..b1)`，配对按先后追加进 `out`。 */
function alignRange(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number, out: Array<[number, number]>): void {
  let pre = 0;
  while (a0 + pre < a1 && b0 + pre < b1 && a[a0 + pre] === b[b0 + pre]) pre += 1;
  let suf = 0;
  while (suf < a1 - a0 - pre && suf < b1 - b0 - pre && a[a1 - 1 - suf] === b[b1 - 1 - suf]) suf += 1;
  for (let k = 0; k < pre; k += 1) out.push([a0 + k, b0 + k]);
  const s0 = a0 + pre;
  const t0 = b0 + pre;
  const n = a1 - suf - s0;
  const m = b1 - suf - t0;
  if (n > 0 && m > 0) {
    if (n * m <= ALIGN_MAX_CELLS) {
      lcs(a, b, s0, n, t0, m, out);
    } else {
      const anchors = uniqueAnchors(a, b, s0, s0 + n, t0, t0 + m);
      let pa = s0;
      let pb = t0;
      for (const [i, j] of anchors) {
        alignRange(a, b, pa, i, pb, j, out);
        out.push([i, j]);
        pa = i + 1;
        pb = j + 1;
      }
      if (anchors.length) alignRange(a, b, pa, s0 + n, pb, t0 + m, out);
      else {
        /*
          一个只出现一次的行都没有（满屏一样的 `- TODO`）：再递归就是原地打转。退一步，**同一个偏移上字面一样的行**
          配成对 —— 两边行数没变时（首尾各改一行这种）中间那些行照样跟着走；配对按先后递增，不会交叉。
        */
        for (let k = 0; k < Math.min(n, m); k += 1) if (a[s0 + k] === b[t0 + k]) out.push([s0 + k, t0 + k]);
      }
    }
  }
  for (let k = suf; k > 0; k -= 1) out.push([a1 - k, b1 - k]);
}

/** 标准 LCS（DP），`a[s0..s0+n)` 对 `b[t0..t0+m)`。 */
function lcs(a: string[], b: string[], s0: number, n: number, t0: number, m: number, out: Array<[number, number]>): void {
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[s0 + i] === b[t0 + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[s0 + i] === b[t0 + j]) { out.push([s0 + i, t0 + j]); i += 1; j += 1; continue; }
    if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i += 1; else j += 1;
  }
}

/** 两边各只出现一次的行配成对，取按两边先后都递增的最长一串（最长递增子序列，O(k log k)）。 */
function uniqueAnchors(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number): Array<[number, number]> {
  const count = (arr: string[], lo: number, hi: number) => {
    const c = new Map<string, { n: number; at: number }>();
    for (let k = lo; k < hi; k += 1) { const e = c.get(arr[k]); if (e) e.n += 1; else c.set(arr[k], { n: 1, at: k }); }
    return c;
  };
  const ca = count(a, a0, a1);
  const cb = count(b, b0, b1);
  const pairs: Array<[number, number]> = [];
  for (let k = a0; k < a1; k += 1) {
    const ea = ca.get(a[k])!;
    const eb = cb.get(a[k]);
    if (ea.n === 1 && eb && eb.n === 1) pairs.push([k, eb.at]);
  }
  /* pairs 已按 a 递增；在 b 下标上取最长递增子序列 */
  const tails: number[] = [];
  const prev: number[] = new Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const seq: Array<[number, number]> = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) seq.push(pairs[k]);
  return seq.reverse();
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

/** 一次落盘**实际改了的一段**：原文 `oldFrom..oldTo` 换成了新文件里的 `newFrom..newTo`（闭区间，从 1 起；空范围 = 纯插入 / 纯删除）。 */
export interface EditRange { oldFrom: number; oldTo: number; newFrom: number; newTo: number }

/**
 * 只改了**一段**（`oldFrom..oldTo` 整段换掉；纯插入给 `oldFrom = 插入点后一行、oldTo = oldFrom - 1`）时那一段在新文件里的范围 ——
 * 按两版的行数差算。删一段时 `deleteLines` 可能顺手收掉接缝后的空行：差出来的那几行算进被删的范围。
 */
export function singleRange(base: string, next: string, oldFrom: number, oldTo: number): EditRange {
  const delta = String(next ?? '').split('\n').length - String(base ?? '').split('\n').length;
  let to = oldTo;
  let newTo = oldTo + delta;
  if (newTo < oldFrom - 1) { to += (oldFrom - 1) - newTo; newTo = oldFrom - 1; }
  return { oldFrom, oldTo: to, newFrom: oldFrom, newTo };
}

/**
 * **按实际改了的那几段**给旧行号找新行号 —— PURE。认不出来的返回 null（那一行要改的东西已经不在了）。
 *
 * 「重复文字的排队保护仍不完整」：只拿两版全文按文字对齐（`rewritePatch.keep`）的话，`- TODO\n\n- TODO` 删掉第一处之后，
 * 留下的那一处会被认成"第一处还在"，排在后面对第一处的删除就删到了第二处。所以身份按改动范围定：
 *   · 改动范围**之外**的行：按前面那几段的行数差平移，再核对一遍那一行字面没变（对不上就当认不出来）；
 *   · 改动范围**之内**的行：只有它的字在这一段的原文里只出现一次、在新内容里也只出现一次，才算"还在"（整节改写只动了一行，
 *     节里别的行照样跟着走）；否则一律认不出来 —— 宁可让排着的那条报冲突，也不能改到另一处。
 */
export function exactLineMap(base: string, next: string, ranges: EditRange[]): (line: number) => number | null {
  const a = String(base ?? '').split('\n');
  const b = String(next ?? '').split('\n');
  const rs = [...ranges].sort((x, y) => x.oldFrom - y.oldFrom || x.oldTo - y.oldTo);
  /* 每一段之前累计的行数差 —— 查一行时二分找到它落在哪一段之后，不逐段累加 */
  const before: number[] = [];
  let acc = 0;
  for (const r of rs) { before.push(acc); acc += (r.newTo - r.newFrom + 1) - (r.oldTo - r.oldFrom + 1); }
  /*
    每一段**只建一次**索引：原文那几行里每种字出现几次、新内容里每种字出现在哪些行。大文件整节 / 跨段改写时，
    逐行去扫整段就是 O(段长²) —— 一万多行卡十几秒。索引用到才建（大多数行落在改动范围外）。
  */
  const index = new Map<number, { inOld: Map<string, number>; inNew: Map<string, number[]> }>();
  const indexOf = (i: number) => {
    let ix = index.get(i);
    if (ix) return ix;
    const r = rs[i];
    const inOld = new Map<string, number>();
    for (let k = r.oldFrom; k <= r.oldTo; k += 1) { const w = norm(a[k - 1]); inOld.set(w, (inOld.get(w) || 0) + 1); }
    const inNew = new Map<string, number[]>();
    for (let k = r.newFrom; k <= r.newTo; k += 1) { const w = norm(b[k - 1]); const l = inNew.get(w); if (l) l.push(k); else inNew.set(w, [k]); }
    ix = { inOld, inNew };
    index.set(i, ix);
    return ix;
  };
  return (line: number) => {
    /* 最后一段 `oldFrom <= line` 的 */
    let lo = 0;
    let hi = rs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rs[mid].oldFrom <= line) lo = mid + 1; else hi = mid; }
    const i = lo - 1;
    let shift = 0;
    if (i >= 0) {
      const r = rs[i];
      if (line <= r.oldTo) {
        const want = norm(a[line - 1]);
        if (!want) return null;
        const ix = indexOf(i);
        const hits = ix.inNew.get(want) || [];
        return ix.inOld.get(want) === 1 && hits.length === 1 ? hits[0] : null;
      }
      shift = before[i] + (r.newTo - r.newFrom + 1) - (r.oldTo - r.oldFrom + 1);
    }
    const to = line + shift;
    if (to < 1 || to > b.length || norm(b[to - 1]) !== norm(a[line - 1])) return null;
    return to;
  };
}

/** `exactLineMap` 摊成 `旧行号 → 新行号` 的表（和 `RewritePatch.keep` 同形，认不出来的行不在表里）。 */
export function exactKeep(base: string, next: string, ranges: EditRange[]): Record<number, number> {
  const map = exactLineMap(base, next, ranges);
  const out: Record<number, number> = {};
  const n = String(base ?? '').split('\n').length;
  for (let line = 1; line <= n; line += 1) { const to = map(line); if (to) out[line] = to; }
  return out;
}
