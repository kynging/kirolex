/**
 * **工具调用带的 diff 怎么显示** —— 审计 3b（PURE，有测试 `tests/diffView.test.ts`）。
 *
 * 实测：Claude Code 的 Edit 给的 diff 只是被替换的那一段（`oldText: "alpha"`, `newText: "beta"`），
 * Write 给的 `oldText` 是 null（新文件）。原来「改动的文件」只显示 `newText`、`+/-` 是行数差，
 * 于是 `alpha → beta` 显示成一行 `beta`、没有加减。
 *
 * 这里按行比（`aiChanges.diffChanges`，大文件自动退化成整段一处），给出 `-` / `+` / 上下文行和正确的增删行数。
 * 只给非 kiro 会话用：kiro 那边的面板显示不变（ChatArea 里按引擎分开）。
 */
import { diffChanges } from './aiChanges.ts';

export interface DiffLine { op: ' ' | '-' | '+' | '…'; text: string }
export interface DiffViewModel {
  /** 新文件（oldText 为 null / undefined） */
  isNew: boolean;
  added: number;
  removed: number;
  lines: DiffLine[];
}

/** 改动前后各留几行上下文；中间更长的一段折成「…」 */
const CONTEXT = 3;

export function diffView(oldText: string | null | undefined, newText: string): DiffViewModel {
  const next = String(newText ?? '');
  if (oldText === null || oldText === undefined) {
    /* 文件末尾的换行不算一行（否则 Write 'a\nb\n' 会多出一行空的 +，增行数也多算一行） */
    const body = next.endsWith('\n') ? next.slice(0, -1) : next;
    const lines = body === '' ? [] : body.split('\n');
    return { isNew: true, added: lines.length, removed: 0, lines: lines.map((text) => ({ op: '+', text })) };
  }
  const before = String(oldText);
  const a = before.split('\n');
  const b = next.split('\n');
  const changes = diffChanges(before, next);
  let added = 0;
  let removed = 0;
  const out: DiffLine[] = [];
  /* 新文件里走到第几行了（1 起） */
  let cursor = 1;
  const pushContext = (from: number, to: number, isTail: boolean, isHead: boolean) => {
    /* [from, to] 是新文件里不变的那几行 */
    if (to < from) return;
    const span = b.slice(from - 1, to);
    const keepHead = isHead ? 0 : CONTEXT;
    const keepTail = isTail ? 0 : CONTEXT;
    if (span.length <= keepHead + keepTail + 1) {
      for (const text of span) out.push({ op: ' ', text });
      return;
    }
    for (const text of span.slice(0, keepHead)) out.push({ op: ' ', text });
    out.push({ op: '…', text: '' });
    for (const text of span.slice(span.length - keepTail)) out.push({ op: ' ', text });
  };
  changes.forEach((c, i) => {
    pushContext(cursor, c.from - 1, false, i === 0);
    const orig = c.origTo >= c.origFrom ? a.slice(c.origFrom - 1, c.origTo) : [];
    const ins = c.to >= c.from ? b.slice(c.from - 1, c.to) : [];
    for (const text of orig) out.push({ op: '-', text });
    for (const text of ins) out.push({ op: '+', text });
    removed += orig.length;
    added += ins.length;
    cursor = c.to >= c.from ? c.to + 1 : c.from;
  });
  if (changes.length) pushContext(cursor, b.length, true, false);
  return { isNew: false, added, removed, lines: out };
}

/** 一个文件这一轮被改了好几次（Claude 每次 Edit 一段）：合起来的增删行数 */
export function sumDiffStats(diffs: Array<{ oldText?: string | null; newText: string }>): { added: number; removed: number; isNew: boolean } {
  let added = 0, removed = 0, isNew = false;
  for (const d of diffs) {
    const v = diffView(d.oldText, d.newText);
    added += v.added;
    removed += v.removed;
    isNew = isNew || v.isNew;
  }
  return { added, removed, isNew };
}
