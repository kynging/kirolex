/**
 * 逐块反馈的块模型和**提交契约** —— PURE。
 *
 * 「你觉得我们可以像门一样增加一个评论然后提交修改的功能吗？」—— 从 feature/flow 搬过来，文本（逐行）和 PDF/deck（逐页）
 * 两侧共用这一份。
 *
 * 从会话里点开的文件没有 flow 的节点，所以出口不是 `rerun:<节点>`，而是两条：
 *   · 逐块「✓ 确认」—— 当场让**打开这份文件的那条会话**改那一块，KiroLex 写回文件（见 `ReviewPane.applyOne`）；
 *   · 「提交给这份文件的会话」—— 把攒下的意见拼成**一条普通用户消息**（`reviewPrompt`）发过去。
 *
 * 发成普通消息而不是隐藏指令，三个理由：它进 transcript（事后查得到你提过什么）、模型有这条会话的全部
 * 上下文（文件往往是它刚做出来的）、以及你自己看得见发出去的是什么。
 */

export type ReviewBlock =
  /**
   * 一页。**不带图** —— 页面由 Chromium 的 PDF 查看器显示（见 `deckPreview`），这里只是个锚点。
   * 原来带 `image`（每页一张 PNG），改成 PDF 之后那半个依赖就不需要了。
   */
  | { kind: 'page'; index: number }
  /**
   * 一**行**正文。`index` 是**文件里真实的行号**（从 1 开始，含空行在内）。
   *
   * 原来是"一段"（空行分段）。改成按行 ——「你最好按行来加这些」，而且它顺带解决了另一条：
   * 「title 和 subtitle 这些要和段落分开」—— 标题本来就自己占一行，按行切就自然分开了，
   * 不需要再去认"这一行是不是标题"。
   */
  | {
      kind: 'line'; index: number; text: string;
      /**
       * 这一行在**代码围栏里**（``` 或 ~~~ 之间）。
       *
       * 必须记：围栏里一句 `# 安装依赖` 长得和一级标题一模一样，而 ✕ 一个"一级标题"会连整份文档一起删
       * （见 `dropSpan`）。判据只看单行文本是分不出来的 —— 得知道扫到这一行时围栏开着没有，
       * 所以在切块那一趟顺便记下来。
       */
      fenced?: true;
    };

/**
 * 每页一块，页码**从 1 开始** —— 提示词里写的是给人看的页码，不是数组下标。
 *
 * PDF 方案里"块"不再带图（页面由 Chromium 的 PDF 查看器显示），它只是一个**锚点** ——
 * 你在 PDF 里看到第 5 页有问题，就在下面第 5 页那格写意见。`reviewPrompt` 一个字都不用改。
 */
export function pageBlocks(count: number | null | undefined): ReviewBlock[] {
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0) return [];
  return Array.from({ length: n }, (_, i) => ({ kind: 'page' as const, index: i + 1 }));
}

/**
 * 每**行**一块 —— PURE。
 *
 * 两条讲究：
 *
 *   · **行号是文件里真实的行号**，不是"第几个非空行"。空行不成块（没什么可评论的），但它们**占号** ——
 *     否则你说"第 12 行"而模型在文件里数到的是另一行，那比不给行号更糟。
 *   · **空白行整行滤掉**，只留 trim 之后还有内容的。一份 Markdown 里空行能占三分之一，
 *     每个空行挂一个 💬 是纯噪音。
 */
export function lineBlocks(text: string | null | undefined): ReviewBlock[] {
  const out: ReviewBlock[] = [];
  /** 当前开着的围栏用什么符号、几个 —— 收尾要求**同种且不短于**开头（CommonMark 的规矩） */
  let fence: { char: string; len: number } | null = null;
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const wasFenced = !!fence;
    if (m) {
      const char = m[1][0];
      const len = m[1].length;
      if (!fence) fence = { char, len };
      else if (char === fence.char && len >= fence.len) fence = null;
    }
    if (!line.trim()) continue;                       // 空行不成块，但上面已经占了号
    /* 围栏那两行自己也算"在围栏里" —— ✕ 它们不该被当成标题 */
    out.push({
      kind: 'line', index: i + 1, text: line,
      ...(wasFenced || fence || m ? { fenced: true as const } : null),
    });
  }
  return out;
}

/**
 * 显示用的分组 —— **围栏里的行合成一块**，PURE。
 *
 * ## 为什么必须合
 *
 * 「现在 md 渲染出来总有一些黑色空行是什么鬼」：每一行都被单独送进 Markdown 渲染器，于是
 *
 *   · 一个代码围栏被撕成 N 个独立的代码块（实测一份文档里 27 个 `<pre>`，每个还各带一个「复制」按钮）
 *   · ``` 那两行自己也各渲染一次 —— 结果是**空的** `<pre><code></code></pre>`，那就是黑色空行
 *
 * 而且撕开之后语法高亮也没了（每一行单独看都不是合法代码），缩进的相对关系还会被各自 trim 掉。
 *
 * ## 锚点仍然是行号
 *
 * 合的只是**显示**。一组的锚点是它第一行的行号，`span` 是它覆盖的所有行号 —— 于是
 *
 *   · ✕ 一个代码块 = 那几行一起删（`reviewPrompt` 会收成「第 A–B 行」）
 *   · 💬 一个代码块 = 一条意见挂在整段上，而不是硬挂在某一行
 *
 * 非围栏的行还是一行一组（`span` 长度 1），行为和以前完全一样。
 */
export interface DisplayGroup {
  /** 这一组的锚点行号（第一行）。评论和删除都记在这个号上。 */
  anchor: number;
  /** 覆盖的行号，升序。非围栏行就一个。 */
  span: number[];
  /** 要显示的文本。围栏组是原始的多行原文（**保留缩进**，代码靠它）。 */
  text: string;
  /** 这一组是不是代码围栏。 */
  fenced: boolean;
}

export function displayGroups(blocks: ReviewBlock[]): DisplayGroup[] {
  const out: DisplayGroup[] = [];
  let run: ReviewBlock[] = [];
  const flush = () => {
    if (!run.length) return;
    out.push({
      anchor: (run[0] as any).index,
      span: run.map((b) => (b as any).index),
      /*
        用 `\n` 拼原文，不是 trim 之后再拼：代码的缩进是内容的一部分。
        中间被滤掉的空行（`lineBlocks` 不给空行成块）在代码块里也该留着，所以按**行号差**补回来。
      */
      text: run.map((b, i) => {
        const gap = i === 0 ? 0 : (b as any).index - (run[i - 1] as any).index - 1;
        return '\n'.repeat(gap) + (b as any).text;
      }).join('\n'),
      fenced: true,
    });
    run = [];
  };
  for (const b of blocks) {
    if (b.kind !== 'line') { flush(); continue; }
    if (b.fenced) { run.push(b); continue; }
    flush();
    out.push({ anchor: b.index, span: [b.index], text: b.text, fenced: false });
  }
  flush();
  return out;
}

/**
 * 行号 → 包含它的那个显示组的锚点。渲染只按每组的 `anchor` 出一个 `<li>`，
 * 围栏里除首行以外的行没有自己的 `<li>` —— 框 / 提交行 / 状态行要挂在「覆盖范围的末行」下面时，
 * 得先把末行换成它所在那一组的锚点，否则末行落在围栏里就哪儿都不画。
 */
export function groupAnchorOf(groups: DisplayGroup[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const g of groups) for (const line of g.span) out.set(line, g.anchor);
  return out;
}

export interface ReviewSubmission {
  /** 文件路径，原样写进提示词 —— 模型要靠它知道改哪个文件。 */
  path: string;
  blocks: ReviewBlock[];
  /** index → 你写的意见。空白的当没写。 */
  comments?: Record<number, string>;
  /** index → 这一块不要了。 */
  dropped?: Record<number, true>;
  /**
   * **不挂在任何一行上的意见** —— 「最下面不应该再是加一段了，那里是添加其他 comment 的」。
   *
   * 上一版把最下面那块做成了门上的「＋ 加一段」（往产出里补一段正文）。那是抄错了对象：门上你在**造**
   * 一份产出，所以要能加内容；这里你在**评审**一个已经存在的文件，要加的是**意见**，而且往往是整体性的
   * ——「整体太长」「口径和上周不一致」，这些落不到某一行上。
   *
   * 挂不到行上的意见没有别处可去：逼你硬挂到某一行，模型就会以为那句话只跟那一行有关。
   */
  extra?: string[];
  /**
   * 这份 deck 的**演讲者备注已经定稿**（我逐页改过，盘上那份就是最新的）。
   *
   * 「我希望提交的时候让会话页根据 note 的变化生成新的 slide，因为 note 可能会大改，
   * 提交 slide 的时候会话就不要再修改 note 内容了」。
   *
   * 两件事都要说，而且都是"不说就会错"的：
   *   · **让幻灯片跟着 notes 改** —— 讲稿常常是大改（换了叙事、换了结论），而幻灯片上那几个词还是旧的；
   *     模型看不到"我已经把讲稿改了"这件事，只会照着页面上的字微调。
   *   · **不许它再动 notes** —— 那些是已经定稿的，它一改就把你逐页确认过的东西覆盖掉，
   *     而你不会立刻发现（讲稿不在 PDF 里，屏幕上看不出来）。
   */
  notesFinal?: boolean;
  /**
   * 这一份**允许动结构**（加页、删页、并页、调序、挪图换图）——「让这个提交按钮可以对 ppt 做一些大改」。
   *
   * 只对 deck 打开：md 那侧本来就没有"结构不能改"这回事（模型改的是文本，加一段删一段都是自然的），
   * 而 pptx 上"改字"和"改结构"是两条完全不同的路 —— 当场那条（`deck:revise-slide-text`）只会改字，
   * 加框挪图它一律回 `CANNOT-REVISE-LOCALLY`。那些意见全落到提交这条路上，所以这条路必须明说它可以，
   * 否则你提了大改的意见、它照旧只改字，结果看起来像没生效。
   *
   * 同时这一节要钉住"保住什么"：母版、主题配色、版式、现有图片 —— 是**手术**，不是重做一份。
   */
  deckRework?: boolean;
  /**
   * 锚点 → 它其实覆盖了哪几行（`displayGroups` 给的 `span`）。
   *
   * 代码围栏合成一块显示之后，挂在它上面的意见其实是对**那几行**说的。不给这个的话提示词只会写
   * 「第 12 行」，而第 12 行是那句 ```，模型照着改会去动围栏本身。
   */
  spans?: Record<number, number[]>;
  /**
   * **演讲者备注**上的意见，页码 → 意见 —— 和 `comments`（版面本身）**分开两条通道**。
   *
   * 「comment 应该分 ppt 本身的还是 note 的，不能都放一起」。理由不是整洁：这两种意见要改的是
   * **两个不同的东西**。「这页图太密」改的是幻灯片版面，「这段话术别提竞品」改的是备注文本 ——
   * 混在一条「第 3 页：…」里，模型只能猜你说的是哪一个，而猜错的代价是它去改了另一个。
   *
   * 只有 deck 有这一路（`.md` 没有备注这回事）。
   */
  noteComments?: Record<number, string>;
}

/**
 * 发给会话的那条提示词 —— PURE，整个功能的契约。
 *
 * 规则，每条都有代价换来的理由：
 *
 *   · **只列有意见或被删的块。** 14 页逐页写"无意见"是噪音，而模型会把噪音当成要处理的东西。
 *   · **但要收一句「其余各页无意见」。** 完全不提的话，模型（和三天后的你）会以为你只看了两页 ——
 *     "没提"和"看过没问题"必须分得开。
 *   · **一条都没有时返回空串。** 调用方据此禁用提交按钮，而不是发一条空消息出去。
 *   · **被删的块写「删掉」**，不再另发一句 —— ✕ 本身就是完整的意见。
 *   · **锚点措辞跟着块的类型**（页 / 段），其余一字不变：两种文件用同一套话术，模型不必学两遍。
 *
 * 顺序按 `index`，不按你写意见的顺序：模型是照着文件从头改到尾的。
 */
export function reviewPrompt(opts: ReviewSubmission): string {
  const blocks = [...(opts.blocks || [])].sort((a, b) => a.index - b.index);
  const comments = opts.comments || {};
  const dropped = opts.dropped || {};
  const spans = opts.spans || {};
  /* 锚点措辞跟着块的类型 —— 页 / 行，其余一字不变：两种文件用同一套话术，模型不必学两遍 */
  const unit = blocks.some((b) => b.kind === 'page') ? '页' : '行';

  const lines: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (dropped[block.index]) {
      /*
        **连续被删的收成一个区间** —— ✕ 一个标题会连它整节一起删（见 `dropSpan`），那可能是十几行；
        逐行写十几条「删掉」既是噪音，也让模型以为那是十几个独立决定。
      */
      let last = block.index;
      while (i + 1 < blocks.length && dropped[blocks[i + 1].index]) { i += 1; last = blocks[i].index; }
      lines.push(last === block.index
        ? `- 第 ${block.index} ${unit}：删掉`
        : `- 第 ${block.index}–${last} ${unit}：删掉（连同其间所有内容）`);
      continue;
    }
    const said = String(comments[block.index] || '').trim();
    if (said) {
      /*
        代码围栏合成一块显示之后，挂在它上面的意见是对**那几行**说的 —— 只写第一行的号，
        而第一行是那句 ```，模型照着改会去动围栏本身。所以有 span 就写成范围。
      */
      const sp = spans[block.index];
      const where = sp && sp.length > 1 ? `第 ${sp[0]}–${sp[sp.length - 1]} ${unit}` : `第 ${block.index} ${unit}`;
      lines.push(`- ${where}：${said}`);
    }
  }
  /*
    备注的意见**单独一节** —— 见 `noteComments`：它们要改的是 notes 文本，不是幻灯片版面。
    同一页可以两边都有意见，那时两节里各出现一条，各自说清改哪个。
  */
  const noteComments = opts.noteComments || {};
  const noteLines: string[] = [];
  for (const block of blocks) {
    if (dropped[block.index]) continue;      // 整页都不要了，备注意见跟着没意义
    const said = String(noteComments[block.index] || '').trim();
    if (said) noteLines.push(`- 第 ${block.index} ${unit}备注：${said}`);
  }
  const extra = (opts.extra || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!lines.length && !noteLines.length && !extra.length) return '';

  const total = blocks.length;
  const rest = total - lines.length;
  const parts: string[] = [];
  if (lines.length) {
    const tail = rest > 0 ? `\n（其余 ${rest} ${unit}无意见）` : '';
    /* deck 有两条通道时点明这一节说的是**版面**，免得和下面那节的备注意见混起来 */
    const what = noteLines.length ? `逐${unit}意见（幻灯片本身）` : `逐${unit}意见`;
    parts.push(`${opts.path} ${what}（共 ${total} ${unit}）：\n${lines.join('\n')}${tail}`);
  }
  if (noteLines.length) {
    /* 标题里点明"演讲者备注"，因为那是 PDF 里**看不到**的东西 —— 不点明模型会以为你在说页面上的字 */
    parts.push(`演讲者备注的意见（notes，不是幻灯片上的字）：\n${noteLines.join('\n')}`);
  }
  /*
    整体性的意见**单独一节**，不混进逐行那张单子：混进去就得给它编一个假的行号，
    而模型会照着那个行号去改那一行。
  */
  if (extra.length) {
    const head = lines.length ? '其他意见：' : `${opts.path} 的意见：`;
    parts.push(`${head}\n${extra.map((t) => `- ${t}`).join('\n')}`);
  }
  /*
    **说清"改这一份，别另存"** ——「变成已提交之后会更新现有文件还是新文件？」

    不说的话这件事由模型自己决定，而实测它常常"另存一版"（`…_v3.pptx`、`…-revised.md`）—— 那对它是
    体贴，对你是灾难：你正看着的这个标签页、这条预览、你后面要发出去的那个链接，全都还指着旧那份，
    而改动躺在一个你不知道名字的新文件里。
    路径已经写在上面每一节的开头了，这一句只是把"就地改"这个默认值钉住。
  */
  if (opts.notesFinal) {
    /*
      放在最后、紧挨着"就地改"那一句 —— 它们是同一类东西：**关于这次动手本身的约束**，
      而不是某一页的意见。
    */
    parts.push([
      '这份 deck 的**演讲者备注（notes）已经是最新的** —— 我在预览里逐页改过，盘上那份就是定稿。',
      '· 改幻灯片时**读文件里的 notes**，让页面跟着讲稿走：讲稿常常是大改（换了叙事、换了结论），',
      '  而页面上那几个词还是旧的；',
      '· **不要修改 notes 的内容** —— 你一改就把我逐页确认过的东西覆盖掉，而讲稿不在 PDF 里，',
      '  我在屏幕上看不出来。',
    ].join('\n'));
  }
  parts.push(`请**就地改这一份文件**（${opts.path}），不要另存成新文件、不要改名 —— 我正对着它看。`);
  /*
    **这条路允许动结构** ——「我想要的是让这个提交按钮可以对 ppt 做一些大改，然后整个重新生成」。

    不写这一节的话它只会替换现有那些框里的字：预览里那条当场生效的通道（`deck:revise-slide-text`）
    正是这么限定的（只回 `地址<TAB>新文本`，加框挪图一律回 `CANNOT-REVISE-LOCALLY`），
    而它顶不住的那些意见 —— 加一页、把两页并成一页、换掉那张架构图、整体调序 —— 全都落到这条路上。
    所以这里必须**明说它可以**，否则你在这儿提了大改的意见，它照旧只改字，结果看起来像没生效。

    同时钉住"保住什么"：**不重做，是手术**。母版、主题配色、版式和现有图片都留着 ——
    整份重排看着像换了个模板，而那份 deck 的样子往往是已经认可、甚至别人定下来的。
  */
  if (opts.deckRework) {
    parts.push([
      '这一份的**结构可以改** —— 不只是替换现有文本框里的字：',
      '· 可以加页、删页、把两页并成一页、拆成两页、调整页序；',
      '· 可以挪动/缩放文本框和图片，可以换掉一张图（用盘上已有的图片文件；',
      '  没有来源就别硬造一张，宁可在这一页留个说明告诉我缺什么）；',
      '· **母版、主题配色、版式和现有图片保留** —— 新页请沿用这份 deck 里已有的版式，',
      '  不要换模板、不要重新配色：这份的样子是定过的，我要改的是内容和结构；',
      '· 页数或页序变了，在回复里列一下**新的目录**（第几页讲什么），',
      '  我按那个再看一遍 —— 预览会自动重转，但哪页变成了哪页只有你知道。',
    ].join('\n'));
  }
  /*
    **一次跑完，别一处一个命令** ——「现在感觉 subagent 改 ppt 有点慢，有什么办法优化一下吗」。

    量过今天的全部数据：工具本身 498 次合计 1513 秒（中位 0.3 秒），而**工具之间等模型** 10143 秒 ——
    工具占 13%，等模型占 87%。改 PPT 那一段更直白：九次 `python3` 每次跑 0.3–1.1 秒，而相邻两次之间
    隔 20–45 秒，四分多钟里工具只占 6 秒。

    所以唯一有效的方向是**减少往返**，而这件事只有它自己能做（把 N 处改动合成一个脚本）。
    起 crew 更亏：单次 `Spawning agent crew` 实测 121–173 秒，而且每个成员都要重跑一遍同样的摸底
    （日志里前三次 `ls` 就是在找这个文件）—— 一份文件的编辑没有可分工的东西。
  */
  parts.push([
    '**改动请一次做完**：把所有要改的地方合成**一个脚本跑一次**，不要一处一个命令。',
    '· 每来回一次我这边要等 20–45 秒（实测中位 30 秒），而每个命令本身只跑 0.3–1 秒 ——',
    '  九处改动分九次做，四分钟里有三分五十秒是在等你想下一步；',
    '· 这一份文件的路径上面已经写了，不用再 `ls` 找；',
    '· **不要为这件事起 subagent / crew** —— 一份文件的编辑没有可分工的东西，',
    '  而起一次实测要多花 2–3 分钟，每个成员还会把同样的摸底重做一遍。',
  ].join('\n'));
  return parts.join('\n\n');
}

/** 有没有东西可提交 —— 按钮的禁用判据，和 `reviewPrompt` 同一条规则，不各算一套。 */
export function hasFeedback(opts: ReviewSubmission): boolean {
  return reviewPrompt(opts).length > 0;
}

/**
 * 这一行是几级标题 —— PURE。不是标题就 `null`。
 *
 * 只认 ATX（`# ` / `## `…）：Setext（下面一行 `===`）在按行切之后本来就是两块，认它得往下看一行，
 * 而那会把"这一行是什么"变成"这一行和下一行合起来是什么" —— 判据一复杂就会在别处错。
 * 实际文档里 ATX 是压倒性的写法。
 */
export function headingLevel(line: string | null | undefined): number | null {
  const m = /^(#{1,6})\s/.exec(String(line || ''));
  return m ? m[1].length : null;
}

/**
 * ✕ 一行时，实际要删掉哪些行 —— PURE。
 *
 * 「如果要删标题的话改成属于标题下面的整段内容都删」。
 *
 * 普通行只删自己。**标题**删它自己 + 它下面那一整节 —— 直到遇到**同级或更高级**的标题为止
 * （`## A` 的节到下一个 `##` 或 `#` 结束，中间的 `###` 属于它）。
 *
 * 理由：一个标题在文档结构里代表的是"这一节"，而不是那一行字。只删标题会留下一段没有归属的正文 ——
 * 那比不删更糟，因为模型拿到的是"删掉第 3 行"，它照做之后文档结构就坏了。
 *
 * ## 分隔线也是节的边界
 *
 * `---` / `***` / `___` 不是标题，但它是**排版**：周报模板每个模块之间都有一条。不当边界的话，
 * 删一个客户条目会顺手带走它后面那条线（实测过，那是明确要过的行为：「删一个模块不会带走它后面那条线」），
 * 而留下的文档要么少一条线、要么多一条孤零零的横线。它也因此能被单独 ✕ 掉 ——
 * 那正是"这里多了一条横线"时你要做的动作。
 */
/**
 * 这份文本**值不值得当 Markdown 渲染** —— PURE。
 *
 * 「画布里的门审核显示的是未渲染的 md 文件，这个对吗」/「review 里面 md 的字体好像就完全不一样」。
 *
 * 门里一直是 `<pre>` 里的源码（`## 标题`、`- **TAG**:` 原样露着），而文件预览那侧渲染成真的 Markdown。
 * 同一份周报在两个地方长得完全不同，而门才是你**决定要不要发出去**的地方 —— 那里更该看到成品的样子。
 *
 * 判据看**结构**而不是猜：有标题、列表、粗体、围栏、引用或表格才算。一段纯散文两种渲染看起来一样，
 * 而"猜错了把普通文本当 Markdown"是有代价的：正文里一个 `#` 或 `_` 会被吃掉或变成格式。
 */
export function looksMarkdown(text: string | null | undefined): boolean {
  const t = String(text || '');
  if (!t.trim()) return false;
  return /^\s{0,3}#{1,6}\s+\S/m.test(t)          // 标题
    || /^\s{0,3}([-*+]|\d+\.)\s+\S/m.test(t)      // 列表
    || /\*\*[^*\n]+\*\*/.test(t)                 // 粗体
    || /^\s{0,3}(`{3,}|~{3,})/m.test(t)           // 代码围栏
    || /^\s{0,3}>\s/m.test(t)                     // 引用
    || /^\s{0,3}\|.*\|\s*$/m.test(t);             // 表格
}

/**
 * 一"行"要交给 Markdown 渲染时，先把缩进摘出来 —— PURE。
 *
 * **不摘的话缩进 4 格以上的行会被当成代码块**（CommonMark 的 indented code block），于是一条
 * `    - 三级列表项` 渲染成等宽字体的代码 —— 和它旁边的行完全不是一种样子。逐行渲染必然踩到这个，
 * 因为单独看那一行，它确实"以四个空格开头"。
 *
 * 摘出来的缩进由调用方用 padding 还原，所以看起来还是嵌套的，只是不再被误读成代码。
 */
export function mdLine(text: string | null | undefined): { md: string; indent: number } {
  const raw = String(text ?? '');
  const m = /^[ \t]+/.exec(raw);
  if (!m) return { md: raw, indent: 0 };
  /* tab 按 4 格算 —— 和 CommonMark 一致 */
  const indent = m[0].replace(/\t/g, '    ').length;
  return { md: raw.slice(m[0].length), indent };
}

/** 只有分隔线的一行（`---` / `***` / `___`）—— 节的边界，见 `dropSpan`。 */
export function isRuleLine(line: string | null | undefined): boolean {
  return /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(String(line || ''));
}
/**
 * 一个**列表项**拥有哪些行 —— PURE：它自己 + 紧随其后缩进更深的那些行。
 *
 * 「这个 UI 也没有识别下面 [observation] 的段落」。判据只看缩进，不看内容 ——
 * `[Observation]` / `[Challenge]` 这些词是这份周报的约定，写进判据就成了给一份产出特调的规则；
 * 而"子项比父项缩进深"是 markdown 本身的规则，对任何嵌套列表都成立。
 *
 * 不是列表项、或者下面没有更深的行 → 返回它自己一行（调用方据此退回原来的行为）。
 */
function listSpan(all: ReviewBlock[], at: number): number[] {
  const here = all[at];
  if (here.kind !== 'line' || here.fenced) return [here.index];
  const mine = listIndent(here.text);
  if (mine === null) return [here.index];
  const out = [here.index];
  for (let i = at + 1; i < all.length; i += 1) {
    const next = all[i];
    if (next.kind !== 'line' || next.fenced) break;
    /* 标题和分隔线是硬边界 —— 缩进再深也不属于这一条 */
    if (headingLevel(next.text) !== null || isRuleLine(next.text)) break;
    const w = leadingSpaces(next.text);
    if (w <= mine.width) break;                 // 兄弟或上一层 → 这一条结束
    out.push(next.index);
  }
  return out;
}

/** 这一行是不是列表项，以及它的缩进宽度。`- ` / `* ` / `1. ` 都算。 */
function listIndent(text: string): { width: number } | null {
  const m = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(String(text ?? ''));
  return m ? { width: m[1].replace(/\t/g, '    ').length } : null;
}

/** 行首空白宽度（tab 当四个空格）—— 判"更深"用的就是它。 */
function leadingSpaces(text: string): number {
  const m = /^(\s*)/.exec(String(text ?? ''));
  return (m?.[1] || '').replace(/\t/g, '    ').length;
}

export function dropSpan(blocks: ReviewBlock[] | null | undefined, index: number): number[] {
  const all = [...(blocks || [])].sort((a, b) => a.index - b.index);
  const at = all.findIndex((b) => b.index === index);
  if (at < 0) return [index];
  const here = all[at];
  /* 围栏里的 `#` 不是标题 —— 一句 `# 安装依赖` 长得一模一样，而认错的代价是"删掉整份" */
  const level = here.kind === 'line' && !here.fenced ? headingLevel(here.text) : null;
  /*
    **列表项也带整段** —— 「这个 UI 也没有识别下面 [observation] 的段落」。

    实测那份「信号」长这样（这是合法 markdown，也是这份产出该有的样子）：

        - **[Observation] 数据合规正推动多 Region 独立部署成为常态**
          - 客户/场景: …
          - 现象: …
          - 影响/建议: …

    `[Observation]` 那一行是这一条信号的题目，下面三条是它的内容 —— 对它提一条意见管的当然是整条。
    可 `dropSpan` 原来只认 `#` 标题和围栏，于是它的范围只有自己那一行：改它改不到内容，删它留下三条
    没有归属的子项。

    判据是通用的 markdown 规则（不是给这份周报特调的）：**一个列表项拥有紧随其后、缩进更深的那些行**。
    缩进相同或更浅 = 兄弟或上一层，到此为止；标题和分隔线照旧是硬边界。
  */
  if (level === null) {
    const own = listSpan(all, at);
    return own.length > 1 ? own : [index];
  }
  const out = [here.index];
  for (let i = at + 1; i < all.length; i += 1) {
    const next = all[i];
    if (next.kind !== 'line') break;
    const nextLevel = next.fenced ? null : headingLevel(next.text);
    if (nextLevel !== null && nextLevel <= level) break;   // 同级或更高级 → 这一节结束
    /* 分隔线也是边界（见上面那段）—— 它是排版，不属于这一节 */
    if (!next.fenced && isRuleLine(next.text)) break;
    out.push(next.index);
  }
  return out;
}

/**
 * 「✓ 确认」只改一块时，那一块在文件里**实际占哪一段** —— PURE。
 *
 * `span` 里只有**非空**的行号（`lineBlocks` 不给空行成块），可一节 markdown 的段落之间本来就有空行。
 * 原来把 span 里那几行拼起来当"原文"发给模型、再只替换 span 里那几行 —— 于是：
 *   · 模型看到的原文里段落之间没有空行，照着回来的也没有；
 *   · 原来那些空行没被替换，全挤到新内容**后面**去了。
 * 两件事叠起来，一节里的几段在渲染后**并成一段**。
 *
 * 所以按**闭区间**取：从 span 第一行到最后一行，中间的空行原样带上，替换时也整段换掉。
 * span 在块序里本来就是连续的（标题带整节、列表项带子项、围栏带整段），所以闭区间不会多吞别的内容。
 */
export function spanRange(span: number[]): { from: number; to: number } {
  const sorted = [...span].sort((a, b) => a - b);
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}

/*
  sliceLines / spliceLines / insertAfterLines / deleteLines 搬到了主进程那边（`src/main/reviewApply.ts`）——
  改写的回复由主进程拼回去、写盘，窗口在不在都一样；这里转出同一份，两边永远是同一套规则。
*/
export { sliceLines, spliceLines, insertAfterLines, deleteLines, patchReplyOutcome } from '../main/reviewApply.ts';
