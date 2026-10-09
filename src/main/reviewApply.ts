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
  /** `splice`：回复换掉 `from..to`；`insert`：回复插在 `to` 后面；`whole`：回复就是整份。 */
  mode: 'splice' | 'insert' | 'whole';
  from?: number;
  to?: number;
  /** 提交那一刻的整份正文 —— 盘上此刻不是它就**不写**（中间被别的改动改过了，拼上去就是错位）。 */
  base: string;
}

/** 回复 + `apply` → 写盘的整份正文。坏的输入返回 null，调用方据此不写。 */
export function applyRevision(apply: ReviewApply, reply: string): string | null {
  const text = String(reply ?? '');
  if (apply.mode === 'whole') return text.trim() ? text : null;
  const from = Number(apply.from);
  const to = Number(apply.to);
  if (!Number.isInteger(to) || to < 0) return null;
  if (apply.mode === 'insert') return insertAfterLines(apply.base, to, text);
  if (!Number.isInteger(from) || from < 1 || from > to) return null;
  return spliceLines(apply.base, from, to, text);
}
