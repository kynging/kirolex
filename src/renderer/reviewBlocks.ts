/**
 * 逐块反馈的块模型和**提交契约** —— PURE。
 *
 * 「你觉得我们可以像门一样增加一个评论然后提交修改的功能吗？」—— 从 feature/flow 搬过来，只留文本那一侧
 * （那边还有 PPT/PDF 逐页那一侧，依赖 pdf.js + LibreOffice，没有跟着搬）。
 *
 * 从会话里点开的文件没有 flow 的节点，所以出口不是 `rerun:<节点>`，而是两条：
 *   · 逐块「✓ 确认」—— 当场让**打开这份文件的那条会话**改那一块，KiroLex 写回文件（见 `ReviewPane.applyOne`）；
 *   · 「提交给这份文件的会话」—— 把攒下的意见拼成**一条普通用户消息**（`reviewPrompt`）发过去。
 *
 * 发成普通消息而不是隐藏指令，三个理由：它进 transcript（事后查得到你提过什么）、模型有这条会话的全部
 * 上下文（文件往往是它刚做出来的）、以及你自己看得见发出去的是什么。
 */

export type ReviewBlock = {
  /**
   * 一**行**正文。`index` 是**文件里真实的行号**（从 1 开始，含空行在内）。
   *
   * 原来是"一段"（空行分段）。改成按行 ——「你最好按行来加这些」，而且它顺带解决了另一条：
   * 「title 和 subtitle 这些要和段落分开」—— 标题本来就自己占一行，按行切就自然分开了，
   * 不需要再去认"这一行是不是标题"。
   */
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
      anchor: run[0].index,
      span: run.map((b) => b.index),
      /*
        用 `\n` 拼原文，不是 trim 之后再拼：代码的缩进是内容的一部分。
        中间被滤掉的空行（`lineBlocks` 不给空行成块）在代码块里也该留着，所以按**行号差**补回来。
      */
      text: run.map((b, i) => {
        const gap = i === 0 ? 0 : b.index - run[i - 1].index - 1;
        return '\n'.repeat(gap) + b.text;
      }).join('\n'),
      fenced: true,
    });
    run = [];
  };
  for (const b of blocks) {
    if (b.fenced) { run.push(b); continue; }
    flush();
    out.push({ anchor: b.index, span: [b.index], text: b.text, fenced: false });
  }
  flush();
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
   * 这里你在**评审**一个已经存在的文件，要加的是**意见**，而且往往是整体性的
   * ——「整体太长」「口径和上周不一致」，这些落不到某一行上。
   * 挂不到行上的意见没有别处可去：逼你硬挂到某一行，模型就会以为那句话只跟那一行有关。
   */
  extra?: string[];
  /**
   * 锚点 → 它其实覆盖了哪几行（`displayGroups` 给的 `span`，或者标题/列表项带的整节）。
   *
   * 代码围栏合成一块显示之后，挂在它上面的意见其实是对**那几行**说的。不给这个的话提示词只会写
   * 「第 12 行」，而第 12 行是那句 ```，模型照着改会去动围栏本身。
   */
  spans?: Record<number, number[]>;
}

/**
 * 发给会话的那条提示词 —— PURE，「提交」那条路的契约。
 *
 * 规则，每条都有代价换来的理由：
 *
 *   · **只列有意见或被删的块。** 逐行写"无意见"是噪音，而模型会把噪音当成要处理的东西。
 *   · **但要收一句「其余 N 行无意见」。** 完全不提的话，模型（和三天后的你）会以为你只看了两行 ——
 *     "没提"和"看过没问题"必须分得开。
 *   · **一条都没有时返回空串。** 调用方据此禁用提交按钮，而不是发一条空消息出去。
 *   · **被删的块写「删掉」**，不再另发一句 —— ✕ 本身就是完整的意见。
 *
 * 顺序按 `index`，不按你写意见的顺序：模型是照着文件从头改到尾的。
 */
export function reviewPrompt(opts: ReviewSubmission): string {
  const blocks = [...(opts.blocks || [])].sort((a, b) => a.index - b.index);
  const comments = opts.comments || {};
  const dropped = opts.dropped || {};
  const spans = opts.spans || {};
  const unit = '行';

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
  const extra = (opts.extra || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!lines.length && !extra.length) return '';

  const total = blocks.length;
  const rest = total - lines.length;
  const parts: string[] = [];
  if (lines.length) {
    const tail = rest > 0 ? `\n（其余 ${rest} ${unit}无意见）` : '';
    parts.push(`${opts.path} 逐${unit}意见（共 ${total} ${unit}）：\n${lines.join('\n')}${tail}`);
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

    不说的话这件事由模型自己决定，而实测它常常"另存一版"（`…-revised.md`）—— 那对它是体贴，对你是
    灾难：你正看着的这个标签页、你后面要发出去的那个链接，全都还指着旧那份，而改动躺在一个你不知道
    名字的新文件里。路径已经写在上面每一节的开头了，这一句只是把"就地改"这个默认值钉住。
  */
  parts.push(`请**就地改这一份文件**（${opts.path}），不要另存成新文件、不要改名 —— 我正对着它看。`);
  /*
    **一次跑完，别一处一个命令** ——「现在感觉 subagent 改 ppt 有点慢，有什么办法优化一下吗」。

    量过：工具本身中位 0.3 秒，而**工具之间等模型**占了 87%（相邻两次之间隔 20–45 秒）。
    所以唯一有效的方向是**减少往返**，而这件事只有它自己能做（把 N 处改动合成一次）。
    起 crew 更亏：单次实测 121–173 秒，每个成员还要重跑一遍同样的摸底 —— 一份文件的编辑没有可分工的东西。
  */
  parts.push([
    '**改动请一次做完**：把所有要改的地方合成**一次编辑 / 一个脚本**，不要一处一个命令。',
    '· 每来回一次我这边要等 20–45 秒（实测中位 30 秒），而每个命令本身只跑 0.3–1 秒；',
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
 * `[Observation]` / `[Challenge]` 这些词是某一份周报的约定，写进判据就成了给一份产出特调的规则；
 * 而"子项比父项缩进深"是 markdown 本身的规则，对任何嵌套列表都成立。
 *
 * 不是列表项、或者下面没有更深的行 → 返回它自己一行（调用方据此退回原来的行为）。
 */
function listSpan(all: ReviewBlock[], at: number): number[] {
  const here = all[at];
  if (here.fenced) return [here.index];
  const mine = listIndent(here.text);
  if (mine === null) return [here.index];
  const out = [here.index];
  for (let i = at + 1; i < all.length; i += 1) {
    const next = all[i];
    if (next.fenced) break;
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

/**
 * ✕ / 💬 一行时，实际覆盖哪些行 —— PURE。
 *
 * 「如果要删标题的话改成属于标题下面的整段内容都删」。
 *
 * 普通行只管自己。**标题**管它自己 + 它下面那一整节 —— 直到遇到**同级或更高级**的标题为止
 * （`## A` 的节到下一个 `##` 或 `#` 结束，中间的 `###` 属于它）。
 *
 * 理由：一个标题在文档结构里代表的是"这一节"，而不是那一行字。只删标题会留下一段没有归属的正文 ——
 * 那比不删更糟，因为模型拿到的是"删掉第 3 行"，它照做之后文档结构就坏了。
 *
 * ## 分隔线也是节的边界
 *
 * `---` / `***` / `___` 不是标题，但它是**排版**：周报模板每个模块之间都有一条。不当边界的话，
 * 删一个模块会顺手带走它后面那条线，留下的文档要么少一条线、要么多一条孤零零的横线。
 * 它也因此能被单独 ✕ 掉 —— 那正是"这里多了一条横线"时你要做的动作。
 *
 * ## 列表项也带整段
 *
 * 一个列表项拥有紧随其后、缩进更深的那些行（`listSpan`）—— 对它提一条意见管的当然是整条。
 */
export function dropSpan(blocks: ReviewBlock[] | null | undefined, index: number): number[] {
  const all = [...(blocks || [])].sort((a, b) => a.index - b.index);
  const at = all.findIndex((b) => b.index === index);
  if (at < 0) return [index];
  const here = all[at];
  /* 围栏里的 `#` 不是标题 —— 一句 `# 安装依赖` 长得一模一样，而认错的代价是"删掉整份" */
  const level = !here.fenced ? headingLevel(here.text) : null;
  if (level === null) {
    const own = listSpan(all, at);
    return own.length > 1 ? own : [index];
  }
  const out = [here.index];
  for (let i = at + 1; i < all.length; i += 1) {
    const next = all[i];
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

/** 文件里 `from..to`（行号，闭区间，从 1 起）那一段原文 —— 空行照带。 */
export function sliceLines(text: string | null | undefined, from: number, to: number): string {
  return String(text ?? '').split('\n').slice(from - 1, to).join('\n');
}

/**
 * 把文件里 `from..to` 那一段**整体换成** `replacement` —— PURE。其余每一行逐字照抄（包括末尾换行）。
 */
export function spliceLines(text: string | null | undefined, from: number, to: number, replacement: string): string {
  const lines = String(text ?? '').split('\n');
  return [...lines.slice(0, from - 1), String(replacement ?? ''), ...lines.slice(to)].join('\n');
}
