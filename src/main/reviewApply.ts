/**
 * **把一次改写的回复拼回整份正文** —— PURE，主进程和渲染层共用。
 *
 * 搬到主进程这边，是因为「我要把一段和上面的段落合并好像没生效」：那一次按整份重改要三分钟，中间窗口 reload 了一次，
 * 回复到了主进程、却已经没有渲染层去接它写盘 —— 改好的那一份就这么丢了。所以拼和写都在主进程做（见
 * `review:revise-in-session` 的 `apply`），渲染层在不在都一样；渲染层在的话只是跟着刷新一下界面。
 * 渲染层的 `reviewBlocks.ts` 从这里转出这几个函数，两边永远是同一套规则。
 */

/** 文件里 `from..to`（行号，闭区间，从 1 起）那一段原文 —— 空行照带。 */
export function sliceLines(text: string | null | undefined, from: number, to: number): string {
  return String(text ?? '').split('\n').slice(from - 1, to).join('\n');
}

/** 把文件里 `from..to` 那一段**整体换成** `replacement`。其余每一行逐字照抄（包括末尾换行）。 */
export function spliceLines(text: string | null | undefined, from: number, to: number, replacement: string): string {
  const lines = String(text ?? '').split('\n');
  return [...lines.slice(0, from - 1), String(replacement ?? ''), ...lines.slice(to)].join('\n');
}

/** 这一行是不是一个列表项（`-`、`*`、`+`、`1.`、`1)`）。 */
function isListItem(text: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s+/.test(String(text ?? ''));
}

/**
 * 在第 `to` 行**后面**插进一段新内容。「我要能在段落后加新的」。
 *
 * 前后的空行按 markdown 的规矩补：列表项后面接列表项不空行（空一行就成了"松散列表"，渲染出来行距变大），
 * 其余情况新内容和上下文之间各留一个空行 —— 不留的话它会和下一段粘成同一段。已经有空行的那一侧不再多加。
 */
export function insertAfterLines(text: string | null | undefined, to: number, addition: string): string {
  const lines = String(text ?? '').split('\n');
  const add = String(addition ?? '').replace(/^\n+|\n+$/g, '');
  if (!add.trim()) return lines.join('\n');
  const at = Math.max(0, Math.min(to, lines.length));
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  const blank = (s: string | undefined) => s === undefined || !s.trim();
  const tight = isListItem(before[before.length - 1] || '') && isListItem(add.split('\n')[0]);
  const head = tight || blank(before[before.length - 1]) ? [] : [''];
  const tail = tight || blank(after[0]) ? [] : [''];
  return [...before, ...head, ...add.split('\n'), ...tail, ...after].join('\n');
}

/**
 * 删掉 `from..to` 那几行。删完如果接缝处剩下两个连着的空行，收成一个 —— 不收的话每删一段文档里就多一道空行。
 */
export function deleteLines(text: string | null | undefined, from: number, to: number): string {
  const lines = String(text ?? '').split('\n');
  const before = lines.slice(0, from - 1);
  const after = lines.slice(to);
  while (before.length && after.length && !before[before.length - 1].trim() && !after[0].trim()) after.shift();
  /* 删的是开头那一段：别让文件以空行开头 */
  if (!before.length) while (after.length > 1 && !after[0].trim()) after.shift();
  return [...before, ...after].join('\n');
}

/** 一次改写落盘要的东西：它基于哪一版正文（`base`）、回复怎么拼回去。 */
export interface ReviewApply {
  /** 打开这份文件的那个标签页里的路径 —— 主进程照 `review:write-file` 那套规则解析、查白名单。 */
  path: string;
  /**
   * `splice`：回复换掉 `from..to`；`insert`：回复插在 `to` 后面；
   * `patch`：回复是若干处 `@@ 起-止` 的替换（`parsePatchReply`），一次拼进 `base`（`applyPatch`）。
   */
  mode: 'splice' | 'insert' | 'patch';
  from?: number;
  to?: number;
  /** 提交那一刻的整份正文 —— 盘上此刻不是它就**不写**（中间被别的改动改过了，拼上去就是错位）。 */
  base: string;
}

/** `applyPatch` 要的一处替换（和 `reviseBlock.PatchEdit` 同形）：`from..to` 闭区间、从 1 起，按 `base` 的行号。 */
export interface PatchEditInput {
  from: number;
  to: number;
  /** 新内容；`''` = 删掉这几行。 */
  text: string;
  /** 起始行原文的开头几个字 —— 核对行号用，没有就不核对。 */
  hint?: string;
}

/**
 * `patch` 那一档**实际改了的一处** —— `review:revise-in-session` 原样交给渲染层，给界面做高亮和逐段撤销。
 *
 *   · `from..to`        在**新文件**里的行范围（闭区间，从 1 起）。删掉的那一处 `to = from - 1`（空范围，
 *                       `from` 是删完之后接上来的那一行）；
 *   · `oldFrom..oldTo`  在**原文件**（`base`）里的行范围；
 *   · `oldText`         原文件里那几行的原文 —— 逐段撤销就是在新文件里把 `from..to` 换回它；
 *   · `newText`         新文件里那几行（`sliceLines(新文件, from, to)`）。
 *
 * 按行号从小到大排；几处互不重叠，所以按任意顺序撤销某一处时，后面各处的新行号要减去它的行数差。
 */
export interface PatchChange {
  from: number;
  to: number;
  oldFrom: number;
  oldTo: number;
  oldText: string;
  newText: string;
}

/** 核对用：去掉空白、markdown 记号（行首的 `#`、`-`、`1.`、`>`，行内的 `*`、`_`、`` ` ``），只比字。 */
function normalizeForHint(text: string): string {
  return String(text ?? '').split('\n')
    .map((l) => l.replace(/^\s*(?:(?:#{1,6}|[-*+>]|\d+[.)])\s*)*/, ''))
    .join('')
    .replace(/[\s*_`]/g, '');
}

const isBlank = (s: string | undefined) => s !== undefined && !s.trim();

/**
 * **把几处替换一次拼进 `base`** —— PURE。任何一处不对就**整轮不写**，返回一句大白话的原因：
 *
 *   · 行号越界（`from < 1`、`to` 超过最后一行、`from > to`）；
 *   · 几处的行范围互相重叠（两处都想换同一行，谁说了算都不对）；
 *   · 核对对不上：起始行的原文不是以它抄的那几个字开头 —— 它数错了行，照行号换就换错了地方。
 *
 * 只拼一部分是最糟的结果：文件变成"改了一半"，你还看不出来。
 *
 * 空行：新内容的首尾空行去掉，按原来那几行首尾的空行补回去 —— 模型给的行范围常常连着段后那一行空行，
 * 交回来的新内容却不带，不补的话它就和下一段粘成一段。删掉一处后接缝两边都是空行时多收掉一行。
 */
export function applyPatch(
  base: string | null | undefined,
  edits: PatchEditInput[],
): { ok: true; text: string; changes: PatchChange[] } | { ok: false; why: string } {
  const lines = String(base ?? '').split('\n');
  const n = lines.length;
  if (!Array.isArray(edits) || !edits.length) return { ok: false, why: '没有要改的地方' };
  const sorted = edits.map((e) => ({ ...e, from: Number(e.from), to: Number(e.to) })).sort((a, b) => a.from - b.from || a.to - b.to);
  for (const e of sorted) {
    if (!Number.isInteger(e.from) || !Number.isInteger(e.to) || e.from < 1 || e.to < e.from) {
      return { ok: false, why: `第 ${e.from}-${e.to} 行这个范围不成立 —— 没写` };
    }
    if (e.to > n) return { ok: false, why: `第 ${e.from}-${e.to} 行超出了文件（一共只有 ${n} 行）—— 没写` };
  }
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (b.from <= a.to) return { ok: false, why: `第 ${a.from}-${a.to} 行和第 ${b.from}-${b.to} 行两处改动重叠了 —— 没写` };
  }
  for (const e of sorted) {
    const want = normalizeForHint(e.hint || '');
    if (!want) continue;
    const got = normalizeForHint(lines.slice(e.from - 1, e.to).join('\n'));
    if (!got.startsWith(want)) {
      const actual = lines.slice(e.from - 1, e.to).find((l) => l.trim()) || '';
      return {
        ok: false,
        why: `第 ${e.from} 行对不上：它说那里是「${e.hint}」，实际是「${actual.trim().slice(0, 20)}」—— 多半数错了行，没写`,
      };
    }
  }
  const out: string[] = [];
  const changes: PatchChange[] = [];
  let at = 1;   // 下一行要从 base 的第几行抄
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const next = sorted[i + 1];
    let to = e.to;
    out.push(...lines.slice(at - 1, e.from - 1));
    const orig = lines.slice(e.from - 1, to);
    const body = String(e.text ?? '').split('\n');
    while (body.length && !body[0].trim()) body.shift();
    while (body.length && !body[body.length - 1].trim()) body.pop();
    let repl: string[];
    if (!body.length) {
      repl = [];
      /* 删完接缝两边都是空行（或前面就是文件开头）：多收一行空行，别让文档里多出一道空 */
      const before = e.from >= 2 ? lines[e.from - 2] : undefined;
      if ((e.from === 1 || isBlank(before)) && isBlank(lines[to]) && (!next || next.from > to + 1)) to += 1;
    } else {
      let lead = 0;
      while (lead < orig.length && !orig[lead].trim()) lead++;
      let trail = 0;
      if (lead < orig.length) while (trail < orig.length && !orig[orig.length - 1 - trail].trim()) trail++;
      repl = [...Array(lead).fill(''), ...body, ...Array(trail).fill('')];
    }
    const newFrom = out.length + 1;
    out.push(...repl);
    changes.push({
      from: newFrom,
      to: newFrom + repl.length - 1,
      oldFrom: e.from,
      oldTo: to,
      oldText: lines.slice(e.from - 1, to).join('\n'),
      newText: repl.join('\n'),
    });
    at = to + 1;
  }
  out.push(...lines.slice(at - 1));
  return { ok: true, text: out.join('\n'), changes };
}

/** 回复 + `apply` → 写盘的整份正文。坏的输入返回 null，调用方据此不写。`patch` 走 `applyPatch`（要拿改动列表）。 */
export function applyRevision(apply: ReviewApply, reply: string): string | null {
  const text = String(reply ?? '');
  if (apply.mode === 'patch') return null;
  const from = Number(apply.from);
  const to = Number(apply.to);
  if (!Number.isInteger(to) || to < 0) return null;
  if (apply.mode === 'insert') return insertAfterLines(apply.base, to, text);
  if (!Number.isInteger(from) || from < 1 || from > to) return null;
  return spliceLines(apply.base, from, to, text);
}

/**
 * 渲染层拿到 `patch` 档的返回值之后**该做什么** —— PURE，`ReviewPane` 两处（逐段升级、整篇意见）共用。
 *
 * `patch` 的写盘**只在主进程做**（带 expectBase）：只有 `written` 的结果才算做成，界面只刷新、不再写。
 * 没写的成功结果（老主进程、或者以后谁改了主进程）一律当失败 —— 渲染层自己那次写不带 expectBase，
 * 文件在等回复期间被动过的话，拿旧 base 拼的整份会把那次改动盖掉。
 */
export function patchReplyOutcome(res: any): { kind: 'done'; fullText: string } | { kind: 'cancelled' } | { kind: 'fail'; why: string } {
  if (res?.cancelled) return { kind: 'cancelled' };
  if (!res?.ok) {
    return { kind: 'fail', why: res?.cannot ? `改不了：${res.cannot} —— 换个说法再试` : `改写失败：${res?.error || '没有返回'}` };
  }
  if (res.scope !== 'patch' || typeof res.fullText !== 'string') {
    return { kind: 'fail', why: '主进程还是旧版本，不认跨段改写 —— 重启 KiroLex 之后再试（这次什么都没写）' };
  }
  if (!res.written) return { kind: 'fail', why: '这次的结果没有写进文件 —— 刷新看一眼正文再提一次' };
  return { kind: 'done', fullText: res.fullText };
}
