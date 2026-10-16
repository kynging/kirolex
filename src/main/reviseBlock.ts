/**
 * 侧栏文件预览里「✓ 确认」那一条意见 —— **在打开这份文件的那条会话里改**，PURE 判据。
 *
 * 「提交一条直接让 AI 改这一句或这一段，改完更新」+「你应该把修改放到执行会话中完成，而不是新开 cli，
 * 否则新的 session 缺少必要的上下文」。
 *
 * 这一份是从 feature/flow 那边（门上的逐段改写）搬过来的，**只搬了文件预览用得到的那一半**：
 *
 *   · `reviseInSessionPrompt`  发给那条会话的提示词（`block` 只回这一段 / `patch` 只回要换的那几处 / `insert`）
 *   · `parseRevised`           回复 → 能直接拼回文件的正文，以及"改不了"的记号
 *   · `parsePatchReply`        `patch` 档的回复 → 若干处 `{from, to, text}`，拼回见 `reviewApply.applyPatch`
 *   · `reviseSlideTextPrompt` / `parseSlideEdits`  deck 预览里「✓ 确认」改一页幻灯片（按 run 地址改字 +
 *                           几条动版面的指令），落盘由 `deckPreview` 那几段 python 做
 *
 * 门那侧另外两条（一次性 helper 子进程的 `revisePrompt`、「＋ 加一条」的 `insert` 档）没搬 —— 它们属于
 * flow 的门，这边没有调用者。
 *
 * 发送、排队、等回复、写盘在 `index.ts`（`review:revise-in-session` / `review:write-file` / `deck:*`），
 * 这里只放"说什么"和"收到的怎么认"，所以全部可测。
 */

import { applyPatch, type PatchChange } from './reviewApply.ts';
import { tr } from './uiText.ts';

export interface RevisedBlock {
  /** 改写后的正文；`cannot` 为真时它等于原文。 */
  text: string;
  /** 模型说这条意见改不了这一段 —— 调用方据此升级到整份，或者把原因摆给你看。 */
  cannot?: string;
}

/**
 * 模型的回复 → 能直接拼回文件的正文 —— PURE。
 *
 * 清掉三样实测会混进来的东西：外层围栏、`CANNOT-REVISE-LOCALLY` 那一行、以及首尾空白。
 * **不做别的清洗** —— 尤其不去掉开场白：那种句子没法可靠识别（"本周项目进展如下"可能就是正文），
 * 而误删正文比留一句废话糟得多。提示词负责不让它出现，这里只负责我们自己约定的那两个记号。
 */
export function parseRevised(stdout: string, original: string): RevisedBlock {
  let body = String(stdout ?? '').trim();
  let cannot: string | undefined;
  const m = /^\s*CANNOT-REVISE-LOCALLY:\s*(.*)$/m.exec(body);
  if (m) {
    cannot = m[1].trim() || tr("This comment can't be applied to a single section");
    body = body.replace(m[0], '').trim();
  }
  /*
    去掉**最外层**围栏（模型即使被告知也常加一层）。只去最外层：原文里本来就可能有代码块，
    把里面的也剥掉会毁掉内容。
  */
  const fence = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(body);
  if (fence) body = fence[2].trim();
  if (cannot) return { text: String(original ?? ''), cannot };
  /* 空回复不能当成"改成空的" —— 那会静默删掉一段（整份那一档就是删掉整个文件） */
  if (!body) return { text: String(original ?? ''), cannot: tr('The model returned nothing') };
  return { text: body };
}

/** ATX 标题（`# ` … `###### `，前面最多 3 个空格）—— 和 CommonMark 一样，`#hashtag` 不算。 */
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;

/** 原文片段第一个非空行是 Markdown 标题的话，给出那一行、它的级别和它后面跟着几个空行。 */
function leadingHeading(where: string): { line: string; level: number; blanks: number; eol: string } | null {
  const src = String(where ?? '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const m = i < lines.length ? HEADING.exec(lines[i]) : null;
  if (!m) return null;
  let j = i + 1;
  while (j < lines.length && !lines[j].trim()) j++;
  /* 片段只有这一行标题：按最常见的写法空一行 */
  const blanks = j < lines.length ? j - i - 1 : 1;
  return { line: lines[i], level: m[1].length, blanks, eol };
}

/**
 * block 档的兜底：**评论标题后改写，不能把标题弄丢** —— PURE。
 *
 * 对标题点 💬 时发过去的原文片段是「标题 + 下面整节」，回复会整节替换回去；模型漏掉标题行时，
 * 标题就从文件里消失了（实测：「客户待确认 - RDS for Db2 数据迁移与跨库复制方案」改写后没了）。
 *
 * 原文第一行是标题、回复第一个非空行不是标题 → 把原来那一行补在最前面，中间的空行照原文。
 * 回复第一行是标题（哪怕文字或级别变了）就照用 —— 那是按意见改过的标题，再补一个就成了两个。
 * 只管 `block`：`insert` 的回复是新加的内容，本来就不带标题；`patch` 按行号换，没有"整节"这回事。
 */
export function keepHeading(where: string, revised: string, scope: 'block' | 'patch' | 'insert' = 'block'): string {
  const text = String(revised ?? '');
  if (scope !== 'block') return text;
  const head = leadingHeading(where);
  if (!head) return text;
  const first = text.split(/\r?\n/).find((l) => l.trim());
  if (first === undefined || HEADING.test(first)) return text;
  return head.line + head.eol.repeat(head.blanks + 1) + text;
}

/**
 * 发给**打开这份文件那条会话**的提示词 —— PURE。
 *
 * ## 为什么在会话里改，而不是一次性子进程
 *
 * 一次性子进程什么都不知道 —— 不知道这是一份周报、不知道字段约定、不知道上游材料里那个客户叫什么；
 * 而这份文件往往正是那条会话刚做出来的，这些全在它的上下文里。代价是这一轮进它的 transcript —— 接受。
 *
 * ## 几档
 *
 *   `block`  只回改完的这一段（默认）。绝大多数意见是"这句话口径不对"，让它把整份四千字重写一遍
 *            纯属白等 —— 实测一次改写 35 秒，其中生成那部分和回复长度直接相关。
 *   `patch`  跨段的意见（`block` 回了 `CANNOT-REVISE-LOCALLY`，或者整篇的意见）。给它带行号的全文，
 *            它**只交回要换掉的那几处**（每处：换掉第几到第几行 + 新内容）。
 *            以前这里是 `whole`（整份重写）—— 长文件一写就是几分钟，常常撞上 8 分钟超时
 *            （「把这段和下一段合并」就报了「等了 8 分钟没等到回复」）。合并两段只需要一处替换。
 *   `insert` 在一段后面加东西，只回新加的部分。
 *
 * **落盘由 KiroLex 做**，提示词里明确禁止它自己动文件：两个写者对同一个文件要么改两遍要么互相覆盖。
 */
export function reviseInSessionPrompt(input: {
  /** 意见指的那一处（原文片段）—— 给它一个落点，别让它猜。 */
  where: string;
  /** 用户写的那条意见。 */
  note: string;
  /** 这份东西是什么（文件路径 / 文件名），可空。 */
  about?: string;
  /**
   * `block`：只回这一段；`insert`：在 `where` 那一段**后面**新加内容 —— 只回新加的那部分；
   * `patch`：跨段的意见 —— 看带行号的全文，只交回要换掉的那几处（见 `parsePatchReply`）。
   */
  scope?: 'block' | 'patch' | 'insert';
  /**
   * **现在的完整正文**（只有 `patch` 档用）——「有一些我删掉的内容怎么变成我增加的内容了？」
   *
   * 要把盘上此刻那一份当基准发过去：它会话里记得的那一版可能是改过之前的。`patch` 档还要靠它编行号 ——
   * 模型交回来的每一处都按这一份的行号说"换掉第几到第几行"。
   */
  full?: string;
  /** 意见指的那一处在 `full` 里的行范围（闭区间，从 1 起）—— `patch` 档用；整篇的意见不传。 */
  fromLine?: number;
  toLine?: number;
}): string {
  const about = String(input.about || '').trim();
  if (input.scope === 'patch') return revisePatchPrompt(input, about);
  /*
    **在一段后面加东西** ——「我要能在段落后加新的」。和改一段分开一档：让它"改这一段、顺便在后面加"
    的话，它回来的是原文 + 新内容，而原文那部分它常常顺手润色 —— 你没评的那段被改了。只要新内容，
    由 KiroLex 插到那一段后面，原文就一个字节都不经过模型。
  */
  if (input.scope === 'insert') {
    return [
      `在${about ? `「${about}」` : '那份文件'}里下面这一段的**后面**新加内容。只输出要新加的部分。`,
      '',
      '新内容要接在这一段后面（原文片段，只是给你看位置，不要改它、也不要把它重复输出）：',
      '---',
      String(input.where ?? '').trim(),
      '---',
      '',
      '要加什么：',
      String(input.note ?? '').trim(),
      '',
      '要求：',
      '· **只输出新加的那部分** —— 上面那段原文不要再写一遍，我会把你的输出插在它后面；',
      '· 不要用 ``` 围栏包起来，也不要写"好的""以下是新增内容"这类开场（那些话会被原样写进文件）；',
      '· 和上下文用同样的标记形式（前面是 markdown 列表就接着写列表项，是正文段落就写段落）；',
      '· **不要用工具去改文件**（`fs_write` 之类）—— 落盘由 KiroLex 统一做；',
      '· 如果这条要求需要你没有的信息（要查外部系统、要问人），不要编：什么都不输出，',
      '  只单独一行写 `CANNOT-REVISE-LOCALLY: <一句话说缺什么>`。',
    ].join('\n');
  }
  const heading = leadingHeading(input.where);
  const head = `下面这条意见是对${about ? `「${about}」` : '那份文件'}里某一处提的。按它改，然后**只输出改完的这一段**。`;
  return [
    head,
    '',
    '意见指的位置（原文片段）：',
    '---',
    String(input.where ?? '').trim(),
    '---',
    '',
    '意见：',
    String(input.note ?? '').trim(),
    '',
    '要求：',
    '· **只输出这一段改完的样子** —— 不要把整份重写一遍（那样我要多等好几十秒），'
      + '\n  也不要只给"改动说明"；',
    '· 不要用 ``` 围栏包起来，也不要写"好的""已修改如下"这类开场（那些话会被原样写进文件）；',
    '· 保持原来的标记形式（原文是 markdown 列表就还是列表，是标题就还是同级标题，段落之间的空行照留）；',
    '· **意见没提到的地方一个字都不要动**；',
    /* 片段以标题开头时整节会被你的回复替换 —— 漏了标题行，标题就从文件里没了（`keepHeading` 是兜底） */
    ...(heading ? [
      `· 原文片段第一行是标题「${heading.line.trim()}」：**你输出的第一行必须是这个标题**，级别不变（还是 ${heading.level} 个 \`#\`）；`
        + '\n  意见要求改标题就交回改过的标题，没要求就原样保留这一行 —— 漏掉它，标题就从文件里没了；',
    ] : []),
    '· 如果这条意见**没法只改这一段**（要和别处合并、要新增段落、要把它挪到别的小节），'
      + '\n  就原样返回这一段，并在最后单独一行写 `CANNOT-REVISE-LOCALLY: 需要跨段改`；',
    '· **不要用工具去改文件**（`fs_write` 之类）—— 落盘由 KiroLex 统一做。',
    '  你也动一遍的话就是两个写者对同一个文件：要么改两遍，要么互相覆盖；',
    '· 如果这条意见需要你没有的信息（要查外部系统、要问人），不要编：照原样返回，',
    '  并在最后单独一行写 `CANNOT-REVISE-LOCALLY: <一句话说缺什么>`。',
  ].join('\n');
}

/**
 * `patch` 档的提示词 —— 带行号的全文 + 意见指的位置，要它**只交回要换掉的那几处**。
 *
 * 格式（一处一块，`parsePatchReply` 认）：
 *
 *     @@ 12-15 | 原文开头几个字
 *     新内容……
 *     @@ END
 *
 * 行号让 KiroLex 知道换哪儿，开头几个字用来核对它没数错行 —— 数错了宁可整轮不写，也不能换错地方。
 * 不用 JSON：正文里的引号、反斜杠、换行全要转义，一段 markdown 转义错一个字符整份就作废了。
 */
function revisePatchPrompt(
  input: { where: string; note: string; full?: string; fromLine?: number; toLine?: number },
  about: string,
): string {
  const full = String(input.full ?? '');
  const numbered = full.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
  const from = Number(input.fromLine);
  const to = Number(input.toLine);
  const span = Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from
    ? (from === to ? `第 ${from} 行` : `第 ${from}-${to} 行`)
    : '';
  const where = String(input.where ?? '').trim();
  return [
    `下面这条意见是对${about ? `「${about}」` : '那份文件'}提的，可能要跨段改（合并、拆分、加段、删段、挪位置）。`,
    '**只交回要换掉的那几处**，不要把整份重写一遍。',
    '',
    '**现在的完整正文**（每行开头是行号和一个制表符，行号不是正文的一部分；以这一份为基准 ——',
    '它就是盘上此刻的样子，你自己记得的那一版可能是旧的。这里没有的东西就是已经删掉的，不要写回来）：',
    '---',
    numbered,
    '---',
    '',
    span ? `意见指的位置：${span}` : '意见指的位置：',
    '---',
    where,
    '---',
    '',
    '意见：',
    String(input.note ?? '').trim(),
    '',
    '输出格式 —— 每一处改动写成一块：',
    '@@ <起始行>-<结束行> | <这几行原文开头的几个字>',
    '<换上去的新内容，可以多行>',
    '@@ END',
    '',
    '要求：',
    '· 一块就是"把第起始行到结束行（含）整体换成新内容"。行号按上面那份正文的编号写；',
    '  `|` 后面照抄**起始行**原文开头的五到十个字（不带行号），我用它核对你没数错行；',
    '· **不需要动的段落一个字都不要交回**；没提到的行我原样保留；',
    '· 合并两段：用一块新内容换掉这两段的整个行范围（例：`@@ 12-17 | …` 换成合并后的一段）；',
    '· 在某处后面加一段：把那一段的行范围连同新加的内容一起交回；',
    '· 删掉一段：新内容只写一行 `<DELETE>`；块下面不能留空 —— 空块我认不出你是要删还是漏写了，整轮都不会写；',
    '· 几块之间的行范围不能重叠；改好几处不相邻的地方就写好几块；',
    '· 新内容保持原来的标记形式（列表还是列表，标题还是同级标题），新内容里不要带行号；',
    '· 不要用 ``` 围栏包起来，块外面不要写解释或"好的"之类的话；',
    '· **不要用工具去改文件**（`fs_write` 之类）—— 落盘由 KiroLex 统一做；',
    '· 如果这条意见需要你没有的信息（要查外部系统、要问人），不要编：什么块都不写，',
    '  只单独一行写 `CANNOT-REVISE-LOCALLY: <一句话说缺什么>`。',
  ].join('\n');
}

/** `patch` 档里的一处：把 `from..to`（闭区间，从 1 起，按发过去那份正文的行号）换成 `text`。 */
export interface PatchEdit {
  from: number;
  to: number;
  /** 新内容；`''` = 删掉这几行（模型写的是 `<DELETE>`）。首尾空行已去掉，拼回时按原文补。 */
  text: string;
  /** 模型照抄的起始行原文开头 —— 拼回前拿它核对行号（见 `applyPatch`）；没写就不核对。 */
  hint?: string;
}

/**
 * `patch` 档的回复 → 若干处 `{from, to, text}` —— PURE。
 *
 * 宽松到什么程度（理由和 `parseSlideEdits` 放宽分隔符一样：一次改写几十秒，为一个符号作废不值得）：
 *   · 块头 `@@` 可以是两个以上、前后可以有空白或项目符号；`REPLACE` / `替换` / `L` / `第…行` 这些修饰都认；
 *   · 行号之间 `-`、`–`、`—`、`~`、`到`、`至`、`..` 都认；只写一个行号就是那一行；
 *   · 开头几个字前面的分隔符 `|`、`｜`、`:`、`：` 都认，外面套的「」或引号、结尾的省略号去掉；
 *   · `@@ END` 可以写成 `@@END`、`@@ 结束`；漏了也行 —— 下一个块头或者回复结束就是这一块的结尾。
 *
 * 不宽松的：
 *   · 行首是 `@@` 却认不出行号的块头，整轮报错 —— 静默丢掉它，就成了"只改了一部分"还报成功；
 *   · 行号带负号的（`@@ -1-2`）照样收下，交给 `applyPatch` 的范围校验整轮拒掉；
 *   · 块里一个字都没有（又没写 `<DELETE>`）就报错 —— 那和"格式没对上"长得一样，当成删掉是不可逆的；
 *   · 一块都没有又没说改不了，同样报错。
 */
export function parsePatchReply(stdout: string): { edits: PatchEdit[]; cannot?: string; error?: string; fix?: string } {
  let body = String(stdout ?? '').replace(/\r\n/g, '\n').trim();
  const m = /^\s*CANNOT-REVISE-LOCALLY:\s*(.*)$/m.exec(body);
  if (m) return { edits: [], cannot: m[1].trim() || tr("This comment can't be applied") };
  const fence = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(body);
  if (fence) body = fence[2];
  const HEAD = /^\s*(?:[-*•]\s*)?@{2,}\s*(?:replace|替换)?\s*[:：]?\s*(?:L|第)?\s*([-−－]?\d+)\s*行?\s*(?:(?:-|–|—|~|～|到|至|\.\.)\s*(?:L|第)?\s*([-−－]?\d+)\s*行?)?\s*@*\s*(?:[|｜:：]\s*)?(.*?)\s*$/i;
  const END = /^\s*@{2,}\s*(?:end|结束)\s*@*\s*$/i;
  /* 长得像块头（行首 `@@`）却认不出来的 —— 整轮报错，不能当成上一块的正文或者块外的废话丢掉 */
  const HEADISH = /^\s*(?:[-*•]\s*)?@{2,}/;
  /* 行号可能带负号（`@@ -1-2`）—— 照样收下，交给 `applyPatch` 的范围校验整轮拒掉 */
  const int = (t: string) => Number(String(t).replace(/^[−－]/, '-'));
  const edits: PatchEdit[] = [];
  let cur: { from: number; to: number; hint?: string; lines: string[] } | null = null;
  /** 格式错误：`error` 给你看，`fix` 是追问时告诉模型哪里不对、怎么改（见 `patchFollowUp`） */
  const bad = (error: string, fix: string) => ({ edits: [] as PatchEdit[], error, fix });
  let closeFix = '';
  const close = (): string | undefined => {
    if (!cur) return undefined;
    const lines = cur.lines;
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const range = `${cur.from}-${cur.to}`;
    const c = cur;
    cur = null;
    if (!lines.length) {
      closeFix = `第 ${range} 行那一处是空的：要删这几行就只写一行 \`<DELETE>\`；不是要删就补上新内容`;
      return tr('Lines {range}: no new content was given (write <DELETE> to remove them)', { range });
    }
    const text = lines.length === 1 && /^<\s*delete\s*>$/i.test(lines[0].trim()) ? '' : lines.join('\n');
    edits.push({ from: c.from, to: c.to, text, ...(c.hint ? { hint: c.hint } : null) });
    return undefined;
  };
  for (const line of body.split('\n')) {
    if (END.test(line)) { const e = close(); if (e) return bad(e, closeFix); continue; }
    const h = HEAD.exec(line);
    if (h) {
      const e = close();
      if (e) return bad(e, closeFix);
      const from = int(h[1]);
      const to = h[2] !== undefined ? int(h[2]) : from;
      const hint = String(h[3] ?? '').trim()
        .replace(/^[「『“"'`]+|[」』”"'`]+$/g, '')
        .replace(/(?:…+|\.{3,})$/, '')
        .trim();
      cur = { from, to, ...(hint ? { hint } : null), lines: [] };
      continue;
    }
    if (HEADISH.test(line)) {
      const head = line.trim().slice(0, 40);
      return bad(tr('One block header could not be understood ("{head}"); nothing from this round was written', { head }),
        `有一处块头看不懂（「${head}」）：块头要写成 \`@@ <起始行>-<结束行> | <起始行原文开头几个字>\`，行号是数字`);
    }
    if (cur) cur.lines.push(line);
  }
  const e = close();
  if (e) return bad(e, closeFix);
  if (!edits.length) {
    return bad(tr('It gave no usable edits (no blocks like `@@ start-end`)'), '一块改动都没找到：每一处改动都要按下面的格式写成一块');
  }
  return { edits };
}

/**
 * `patch` 档回复**格式不对**时，在同一条会话里追问的那段话 —— PURE；不该追问就返回 `null`。
 *
 * 只有 `parsePatchReply` 报的格式错误（空块、看不懂的块头、一块都没有，带 `fix` 的那几种）才追问 ——
 * 那是"写法没对上"，再问一次多半就对了，不值得让整轮作废、让你重新提。说改不了（`cannot`）、行号越界 /
 * 重叠这些不追问：前者是它的判断，后者是它数错了行。**空块绝不自动当成删除** —— 删除不可逆，只能让它自己说。
 *
 * 要它把**这一轮的全部改动**重交（不是只补那一块）：拼回是整轮一次做的，只补一块的话前面那几块就没了。
 */
export function patchFollowUp(parsed: { cannot?: string; error?: string; fix?: string }): string | null {
  if (parsed.cannot || !parsed.error || !parsed.fix) return null;
  return [
    '你上一条回复的格式不对，我没法用 —— 整轮都还没写进文件：',
    `· ${parsed.fix}`,
    '',
    '请按原来的格式把**这一轮的全部改动**重新交一遍（不是只补这一处 —— 上一条里写对的那几块也要原样再写一遍）。',
    '行号还是按我最开始发给你的那份正文编，不要按你改完的样子重新数。',
    '',
    '格式 —— 每一处改动写成一块：',
    '@@ <起始行>-<结束行> | <这几行原文开头的几个字>',
    '<换上去的新内容，可以多行>',
    '@@ END',
    '',
    '· 删掉一段：新内容只写一行 `<DELETE>`；块下面不能留空；',
    '· 块外面不要写解释或"好的"之类的话，不要用 ``` 围栏包起来；',
    '· **不要用工具去改文件** —— 落盘由 KiroLex 统一做；',
    '· 如果这条意见需要你没有的信息，什么块都不写，只单独一行写 `CANNOT-REVISE-LOCALLY: <一句话说缺什么>`。',
  ].join('\n');
}

/**
 * 这一轮的回复**能不能当成改写结果** —— PURE。
 *
 * 写回文件是这条路上唯一不可逆的一步（有备份，但你不一定会去翻），所以只收**正常结束**的那一轮：
 *
 *   · `stopReason` 不是 `end_turn`（`max_tokens`、`refusal`…）—— 回复是被截断的。拿一段截断的
 *     正文去写盘，等于把那一段后半截删掉；
 *   · 这一轮被看门狗判成卡死（`wedged`）—— 它的"回复"末尾挂着 KiroLex 自己的说明，不是模型写的正文。
 *
 * 取消 / 出错的那一轮根本不会走到这里（调用方只在一轮**成功收尾**时兑付等待者）。
 */
export function replyUsable(meta: { stopReason?: string | null; wedged?: boolean }): { ok: true } | { ok: false; why: string } {
  if (meta.wedged) return { ok: false, why: tr('This turn got stuck and was interrupted; the reply is incomplete, so nothing was written') };
  const r = String(meta.stopReason ?? '').trim();
  if (r && r !== 'end_turn' && r !== 'n/a') return { ok: false, why: tr('The reply did not finish normally ({reason}); it may be truncated, so nothing was written', { reason: r }) };
  return { ok: true };
}

/**
 * 改**一页幻灯片上的文字**那条提示词 —— PURE。
 *
 * 「现在就做一个工具吧」：这条路让模型**只出文本、不写代码** —— 编辑那一步由 KiroLex 按 run 地址
 * 直接写（`WRITE_SLIDE_TEXT_SCRIPT`）。量过为什么值得：它自己写 python 时，九次调用每次跑 0.3–1.1 秒，
 * 而相邻两次之间等模型 20–45 秒 —— 四分多钟里工具只占 6 秒。往返才是成本。
 *
 * 输出格式定成**一行一条 `地址<TAB>新文本`**，而不是 JSON：
 *   · 文字里带引号、逗号、书名号都不用转义（JSON 会在这上面翻车，而这是一份中文 deck）；
 *   · **只回改动的那几行** —— 没提到的 run 我一个字节都不动，所以它不必把整页抄一遍；
 *   · 半截输出也能用：解析出几条就应用几条，而不是整个作废。
 */
export function reviseSlideTextPrompt(input: {
  /**
   * 这一页现在有哪些可改的文字（地址 + 原文），**外加各自的格式**。
   *
   * 格式那几项（字号/字体/缩进层级/项目符号）是「统一下格式」这类意见的唯一依据 ——
   * 少了它们模型看不出哪一行大哪一行小，只能猜（见下面单独那一节）。
   */
  runs: Array<{ at: string; text: string; pt?: number; font?: string; lvl?: number; bullet?: string }>;
  /** 用户写的那条意见。 */
  note: string;
  /** 第几页。 */
  page: number;
  /** 这份 deck 的路径 —— 一条会话里可能同时开着几份。 */
  path?: string;
  /**
   * 这一页的**形状表** —— 加/删/挪框都要靠它（编号、当前位置大小、里面的字）。
   *
   * 「所以我甚至不能让 comment 添加或者修改页面上的文本框吗」：只给 run 的话，模型能动的就只有
   * 已经存在的那几个字 —— 加一个框没有落点，删一个框没有编号。
   */
  shapes?: Array<{ i: number; kind: string; name: string; text?: string; l?: number; t?: number; w?: number; h?: number }>;
  /** 页面尺寸（厘米）—— 放框的时候要知道边界在哪。 */
  pageW?: number;
  pageH?: number;
}): string {
  const list = (input.runs || []).map((r) => `${r.at}\t${r.text}`).join('\n');
  /*
    **形状表也摆出来** ——「所以我甚至不能让 comment 添加或者修改页面上的文本框吗，WTF」。
    只给 run 的话，能改的就只有"已经存在的那几个字"：加一个框要有落点、删一个框要有编号、
    挪一个框要知道它现在在哪。位置一律**厘米**（EMU 是 914400 分之一英寸，拿那种数字排版排不准）。
  */
  /* 有格式信息的那些才列 —— 全靠继承（什么都没设）的行列出来只是一堆 `-` */
  const fmt = (input.runs || [])
    .filter((r: any) => r.pt || r.font || r.lvl || (r.bullet && r.bullet !== '-'))
    .map((r: any) => `${r.at}\t${r.pt ? `${r.pt}pt` : '-'}\t${r.font || '-'}\t${r.lvl ?? 0}\t${r.bullet || '-'}`)
    .join('\n');
  const shapes = (input.shapes || []).map((sh) => {
    const geo = [sh.l, sh.t, sh.w, sh.h].every((v) => typeof v === 'number')
      ? `位置 ${sh.l},${sh.t} 大小 ${sh.w}×${sh.h}cm`
      : '（位置读不到）';
    return `${sh.i}\t${sh.kind}\t${geo}\t${sh.name}${sh.text ? `\t「${sh.text}」` : ''}`;
  }).join('\n');
  return [
    `按下面这条意见改**第 ${input.page} 页幻灯片**。${input.path ? `文件：${input.path}` : ''}`,
    '',
    '这一页可改的文字（`地址<TAB>原文`，地址是"形状.段.run"）：',
    '---',
    list || '（这一页没有可改的文字）',
    '---',
    ...(fmt ? [
      '',
      /*
        **格式单独一节，不塞进上面那张表** ——「怎么有大 bullet 有小 bullet，统一下格式」。
        塞进去的话那张表就有三列，而回复用的是**两列**（`地址<TAB>新文本`）——
        模型很容易照着三列回，于是新文本里混进一段格式说明。输入和输出保持同构，这类错就不会有。
      */
      '这一页的格式（`地址<TAB>字号<TAB>字体<TAB>缩进层级<TAB>项目符号`；项目符号 `-` = 没设、跟版式走）：',
      '---',
      fmt,
      '---',
    ] : []),
    ...(shapes ? [
      '',
      `这一页的形状（\`编号<TAB>类型<TAB>位置大小<TAB>名字[<TAB>里面的字]\`，页面 ${input.pageW ?? 25.4}×${input.pageH ?? 14.29}cm）：`,
      '---',
      shapes,
      '---',
    ] : []),
    '',
    '意见：',
    String(input.note ?? '').trim(),
    '',
    '要求：',
    '· **只回你要改的那几行**，一行一条，格式和上面一样：`地址<TAB>新文本`。',
    '  没回的地址我一个字节都不动 —— 所以不必把整页抄一遍；',
    '· 不要写解释、不要用 ``` 围栏、不要加序号或者项目符号；',
    '· **一条文字要放在一行里** —— 换行会被当成下一条；',
    /*
      **删掉一段字要有说法** ——「我让他把 subtitle 删掉，不行吗」。

      这条路原来只能"替换"：解析器故意丢掉空文本（空文本和"格式没对上"长得一模一样），
      于是"把副标题删掉"这个意见在这里**没有表达方式** —— 模型回一行空的，被丢掉，
      你看到的是"它没有给出可用的改动行"，像是它没听懂。

      所以给一个明确的标记。用 `<DELETE>` 而不是"回一行空的"：一个写错格式的回复不该被当成
      "清空这一行字"—— 那是不可逆的（原文只在备份里）。
      顺带说清它只清文字、不删框：真要去掉那个框是结构改动，走 `CANNOT-REVISE-LOCALLY` 那条。
    */
    '· **要清掉某段文字**就把新文本写成 `<DELETE>`（例：`2.0.0\t<DELETE>`）——',
    '  它只清字，框还留着（空框在导出的 PDF 上看不见，但它还占着位置）；',
    '',
    /*
      **三条动版面的指令** —— 之前"加一个框 / 删掉这个空框 / 把它挪下去"全都只能回
      `CANNOT-REVISE-LOCALLY`，然后走提交那条路（会话自己写 python，实测 2–4 分钟）。
      而这三件事 python-pptx 各自只有一两行，判据全在 `SLIDE_OPS_SCRIPT` 里，实测都过了。

      语法用 `指令 参数…` 这种一行一条的形状，和上面 `地址<TAB>文本` 同一个风格 —— 让它输出 JSON
      的话，一个逗号写错整条就没了，而这里每一行都是独立的，坏一行不影响别的。
    */
    '· **删掉整个框/图**（连底板一起消失）：`DELETE-SHAPE <编号>`，编号取上面形状表里的；',
    '· **加一个文本框**：`ADD-TEXT <左> <上> <宽> <高> <参考地址> <TAB> 文字`',
    '  —— 前四个是厘米（照着形状表里那些数挑位置，别压到别的框上）；',
    '  `<参考地址>` 是上面文字表里的一个地址，新框的字号/加粗/字体/颜色照抄它 ——',
    '  写 `-` 表示不抄（那会是默认的黑色小字，在定过样式的页上一眼就是补丁）；',
    '· **挪动或缩放**：`MOVE <编号> <左> <上> [<宽> <高>]`，不写宽高就保持原样；',
    /*
      **格式那三条** ——「怎么有大 bullet 有小 bullet，统一下格式，kirolex 处理不了？」
      改字号是 run 上的事，项目符号和缩进是**段落**上的事，所以地址粒度不一样 —— 这必须说清，
      否则它会拿 run 地址去设项目符号（那一段里三个 run 就会互相打三次）。
    */
    '· **改字号**：`SET-SIZE <地址> <磅值>`（地址是 `形状.段.run`，一行里可以只改半句）；',
    '· **改项目符号**：`SET-BULLET <形状.段> <字符>` —— 写 `none` 就是不要符号；',
    '  它设的是**真正的项目符号**（PowerPoint 自己画的那个），和"把 `●` 打进正文"是两回事：',
    '  如果原文里的圆点是手打的字符（格式表里那一列是 `-`），统一它就直接改文字，别用这条；',
    '· **改缩进层级**：`SET-LEVEL <形状.段> <0-8>` —— 层级决定缩进和符号大小；',
    '· 这三条和 `地址<TAB>新文本` 可以混在一份回复里，一行一条；',
    '· 只改这条意见说的地方。**要换图、要改配色/字号本身、要动别的页**做不到，那时只回一行',
    '  `CANNOT-REVISE-LOCALLY: <一句话说为什么>`；',
    '· **不要自己去动这个文件**（`fs_write`、python 都不要）—— 落盘由 KiroLex 做，',
    '  你也动一遍就是两个写者对同一个文件。',
  ].join('\n');
}

/**
 * 模型那几行 → 可以直接写的改动 —— PURE。
 *
 * 只收**形如 `数字.数字.数字<TAB>文本`** 的行，别的一概丢掉（它偶尔会加一句"好的"或者用 `-` 起头）。
 * 一条都没解析出来时要和"它说改不了"分开：前者是格式没对上（该重试或退回让它自己改），
 * 后者是它明确说这条意见做不到。
 */
/** 动版面的一条指令 —— 判据见 `parseSlideEdits`，落盘见 `SLIDE_OPS_SCRIPT`。 */
export type SlideOp =
  | { op: 'delete-shape'; i: number }
  | { op: 'move'; i: number; l?: number; t?: number; w?: number; h?: number }
  | { op: 'add-text'; l: number; t: number; w: number; h: number; text: string; like?: string }
  /* 字号是逐 run 的（`形状.段.run`）—— 一行里可以半句大半句小 */
  | { op: 'set-size'; at: string; pt: number }
  /* 项目符号和缩进是**整段**的（`形状.段`）—— 用 run 地址会让一段里的几个 run 互相打几次 */
  | { op: 'set-bullet'; at: string; char: string }
  | { op: 'set-level'; at: string; lvl: number };

export function parseSlideEdits(
  stdout: string,
): { edits: Array<{ at: string; text: string }>; ops: SlideOp[]; cannot?: string } {
  const raw = String(stdout ?? '');
  const m = /^\s*CANNOT-REVISE-LOCALLY:\s*(.*)$/m.exec(raw);
  const cannot = m ? (m[1].trim() || tr("This comment can't be applied to the text on this slide")) : undefined;
  const edits: Array<{ at: string; text: string }> = [];
  /*
    **动版面的那三条** ——「所以我甚至不能让 comment 添加或者修改页面上的文本框吗，WTF」。

    和 `地址<TAB>新文本` 混在同一份回复里，一行一条。数字一律厘米。
    宽松到什么程度：指令名不分大小写、`-` 可以写成空格或没有（`DELETE SHAPE` / `deleteshape` 都认）、
    参数之间任意空白 —— 理由和分隔符那次一样：一次改写 5–25 秒，为一个连字符作废不值得。
  */
  const num = (t: string) => { const v = Number(String(t).replace(/[，,]/g, '')); return Number.isFinite(v) ? v : undefined; };
  const ops: SlideOp[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim().replace(/^[-*•]\s*/, '');
    /* DELETE-SHAPE <编号> */
    let m = /^delete[\s-]*shape[\s:：]+(\d+)\b/i.exec(t);
    if (m) { ops.push({ op: 'delete-shape', i: Number(m[1]) }); continue; }
    /* MOVE <编号> <左> <上> [<宽> <高>] */
    m = /^move[\s:：]+(\d+)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+([\d.]+)\s+([\d.]+))?/i.exec(t);
    if (m) {
      const row: SlideOp = { op: 'move', i: Number(m[1]), l: num(m[2]), t: num(m[3]) };
      if (m[4] !== undefined) { (row as any).w = num(m[4]); (row as any).h = num(m[5]); }
      ops.push(row);
      continue;
    }
    /* SET-SIZE <形状.段.run> <磅值> */
    m = /^set[\s-]*size[\s:：]+(\d+\.\d+\.\d+)\s+([\d.]+)/i.exec(t);
    if (m) { const pt = num(m[2]); if (pt) ops.push({ op: 'set-size', at: m[1], pt }); continue; }
    /* SET-BULLET <形状.段> <字符|none> —— 段地址两段；给了三段就取前两段（它常顺手写 run 地址） */
    m = /^set[\s-]*bullet[\s:：]+(\d+\.\d+)(?:\.\d+)?\s+(\S+)/i.exec(t);
    if (m) { ops.push({ op: 'set-bullet', at: m[1], char: /^none$/i.test(m[2]) ? 'none' : m[2][0] }); continue; }
    /* SET-LEVEL <形状.段> <0-8> */
    m = /^set[\s-]*level[\s:：]+(\d+\.\d+)(?:\.\d+)?\s+(\d)/i.exec(t);
    if (m) { ops.push({ op: 'set-level', at: m[1], lvl: Number(m[2]) }); continue; }
    /* ADD-TEXT <左> <上> <宽> <高> <参考地址|-> <TAB 或空白> 文字 */
    m = /^add[\s-]*text[\s:：]+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)[\t ]+(.*)$/i.exec(t);
    if (m) {
      const text = m[6].trim();
      const like = m[5];
      if (text) {
        ops.push({
          op: 'add-text', l: num(m[1])!, t: num(m[2])!, w: num(m[3])!, h: num(m[4])!, text,
          ...(/^\d+\.\d+\.\d+$/.test(like) ? { like } : null),
        });
      }
      continue;
    }
  }
  for (const line of raw.split('\n')) {
    /*
      **分隔符放宽到"地址后面那一下"** ——「改写失败：它没有给出可用的改动行」。
      
      约定是 `地址<TAB>新文本`，而原来只认制表符和"两个以上空格"。实测失败过：模型很容易把那个
      制表符写成**一个空格**（或者顺手加个冒号、箭头、项目符号）—— 那时整份回复一条都不匹配，
      结果是"它没有给出可用的改动行"，而它其实给了，格式差一个字符。
      
      放宽的风险是把散文里以 `1.2.3 ` 开头的句子当成改动。但地址那个形状（三段数字带点）在中文
      幻灯片文案里几乎不会出现在行首，而现在这条路的代价是**整次改写作废**（一次 5–25 秒，
      还要你重新措辞再试一遍）。两边一比，宽一点明显划算。
    */
    /* 有分隔符时空格可有可无（`1.0.0：新标题` 是实际写法）；没有分隔符就必须至少一个空格 */
    const hit = /^\s*(?:[-*•]\s*)?(\d+\.\d+\.\d+)(?:\s*(?:\t|:|：|->|→|\|)\s*|\s+)(.*)$/.exec(line);
    if (!hit) continue;
    const text = hit[2].trim();
    /*
      **`<DELETE>` 才算"清掉这段字"** ——「我让他把 subtitle 删掉，不行吗」。
      回一行空的照旧丢掉：那和"格式没对上"长得一模一样，而清空是不可逆的（原文只在备份里）。
      标记是提示词里教给它的，见 `reviseSlideTextPrompt`。
    */
    if (/^<\s*delete\s*>$/i.test(text)) { edits.push({ at: hit[1], text: '' }); continue; }
    if (!text) continue;                                  // 空文本不当"清空"——那多半是格式没对上
    edits.push({ at: hit[1], text });
  }
  return cannot ? { edits, ops, cannot } : { edits, ops };
}

/** 每次用时现取 —— 界面语言可能在启动后改过。 */
const patchConflict = (): string => tr('This file was changed by something else while waiting for the reply; this result was not written. Refresh, check the new text, and submit again');

/** `settlePatchRevision` 的结果 —— 就是 `review:revise-in-session` 在 `patch` 档的返回值（见那里的注释）。 */
export type PatchSettled =
  | { ok: false; cannot: string }
  | { ok: false; error: string; conflict?: true; badFormat?: true; followUp?: string }
  | { ok: true; text: string; fullText: string; scope: 'patch'; changes: PatchChange[]; written?: true; path?: string };

/**
 * `patch` 档收到回复之后的那一整段 —— 解析 → 拼回 → 写盘，PURE（写盘由调用方注入，主进程传 `writeReviewFile`）。
 *
 * **盘上那一份和 base 对不上（`mismatch`）就失败，不交回正文** —— block 档那里会把结果交回渲染层自己写，
 * 而渲染层那次写**不带 expectBase**：等回复的那几分钟里文件被别的改动动过的话，拿旧 base 拼出来的整份
 * 会把那次改动整个盖掉。所以这里返回 `conflict`，界面保留意见、让你看一眼新的正文再提一次。
 */
export function settlePatchRevision(input: {
  replyText: string;
  /** 发给模型的那一份正文（行号按它编）。 */
  base: string;
  /** 不传 = 只拼不写（没有 `apply` 的老调用方）。`expectBase` 照传给 `writeReviewFile`。 */
  write?: (fullText: string, expectBase: string) => { ok?: boolean; mismatch?: boolean; error?: string; path?: string } | null | undefined;
  /** 这已经是追问之后的那份回复 —— 还是格式错误就报失败，不再追问（只追问一次）。 */
  followedUp?: boolean;
  /**
   * 只读：盘上此刻的正文（读不到给 `null`）。要追问之前拿它和 `base` 核对 —— 格式错误那一轮走不到 `write`，
   * 等回复期间文件被改过的话，不核对就会白追问一轮（最后写盘那次还会再核对一遍）。
   */
  onDisk?: () => string | null | undefined;
}): PatchSettled {
  const parsed = parsePatchReply(input.replyText);
  if (parsed.cannot) return { ok: false, cannot: parsed.cannot };
  if (parsed.error) {
    /* 格式错误（`badFormat`）：第一次带上 `followUp`，由调用方在同一条会话里追问一次；补过了还不对就照常报失败 */
    const followUp = input.followedUp ? null : patchFollowUp(parsed);
    if (followUp) {
      const now = input.onDisk?.();
      if (typeof now === 'string' && now !== input.base) return { ok: false, conflict: true, badFormat: true, error: patchConflict() };
      return { ok: false, error: parsed.error, badFormat: true, followUp };
    }
    return {
      ok: false,
      error: input.followedUp ? tr('{error} (it was already asked to fix this once and it is still wrong)', { error: parsed.error }) : parsed.error,
      ...(parsed.fix ? { badFormat: true as const } : null),
    };
  }
  const res = applyPatch(input.base, parsed.edits);
  if (!res.ok) return { ok: false, error: res.why };
  const done = { ok: true as const, text: res.text, fullText: res.text, scope: 'patch' as const, changes: res.changes };
  if (!input.write) return done;
  return patchWritten(done, input.write(res.text, input.base));
}

/**
 * 拼好的那一份交给写盘之后怎么收 —— `settlePatchRevision` 自己写时用它；写盘是异步的调用方（远端文件走 ssh）
 * 先不带 `write` 拼，再自己写、拿结果来这里收，判据是同一套。
 */
export function patchWritten(
  done: Extract<PatchSettled, { ok: true }>,
  wrote: { ok?: boolean; mismatch?: boolean; error?: string; path?: string } | null | undefined,
): PatchSettled {
  if (!wrote?.ok && wrote?.mismatch) {
    return { ok: false, conflict: true, error: patchConflict() };
  }
  if (!wrote?.ok) return { ok: false, error: wrote?.error || tr("Couldn't write to this file") };
  return { ...done, written: true, ...(wrote.path ? { path: wrote.path } : null) };
}
