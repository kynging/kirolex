/**
 * **「AI 刚改过」的那几处** —— PURE，有测试（`tests/aiChanges.test.ts`）。
 *
 * 侧栏改写落盘之后，把这一次实际动了的每一处记下来：在新文件里占哪几行、原来是什么。预览里据此给那几段
 * 挂底色和「AI 刚改过」，旁边一个「撤销」只把**这一段**换回原文。
 *
 * 改动列表优先用主进程回的那份（`review:revise-in-session` 的 `changes`）；没有、或者对不上手里这两版正文的，
 * 就在这里按行比一遍（`diffChanges`）—— 主进程是旧版本时照样能标。
 *
 * 行号都是文件里的真实行号（从 1 起，含空行），和 `reviewBlocks` 同一套。
 */
import { t, type Lang } from './i18n.ts';
/** 撤销拒绝那句的默认语言（和 `planUndo` 的 `lang` 默认值一致）。 */
const DEFAULT_LANG: Lang = 'zh';

export interface AiChange {
  /** 在**新文件**里占的行（闭区间）。纯删除时是空区间：`to === from - 1`，`from` 是原文该插回去的那一行。 */
  from: number;
  to: number;
  /** 改之前那几行原文（`\n` 连起来）。纯新增时是空串、`origTo === origFrom - 1`。 */
  original: string;
  /** 原文在**改之前那一版**里占的行（闭区间）—— 给人看的，撤销不靠它。 */
  origFrom: number;
  origTo: number;
  /** AI 写进去的那几行 —— 撤销前拿它和此刻的正文比，不一样就是之后又改过了。 */
  text: string;
  /**
   * 之后的改动碰到了它，或者对不准它现在在哪（重复的段落，两种对法给出不同位置）—— 标记还挂着，但**不许撤销**：
   * 那几行哪怕字面上还一样，也可能已经是另一段了。一旦标上就一直是。
   */
  stale?: true;
}

const splitLines = (s: string | null | undefined): string[] => String(s ?? '').split('\n');
const linesOf = (s: string, count: number): string[] => (count > 0 ? s.split('\n') : []);

/** 中间那一段超过这么多格（行数相乘）就不做 LCS，整段当一处改动 —— 几千行的文件不能卡住界面。 */
const MAX_CELLS = 4_000_000;

/**
 * 两版正文按行比，返回每一处改动（连着的增删合成一处）。完全一样返回 `[]`。
 *
 * 先剥掉首尾相同的行，中间那一段做 LCS。`late`：同样长的几种对法里取**尽量靠后**对上的那一种（倒过来比）——
 * 重复的行有不止一种对法，`remapChanges` 拿前后两种对照，对法不同的那些位置就是对不准的。
 */
export function diffChanges(before: string | null | undefined, after: string | null | undefined, late = false): AiChange[] {
  if (!late) return diffLines(splitLines(before), splitLines(after));
  const a = splitLines(before).reverse();
  const b = splitLines(after).reverse();
  const rev = (s: string, count: number) => linesOf(s, count).reverse().join('\n');
  return diffLines(a, b).reverse().map((c) => ({
    from: b.length - c.to + 1, to: b.length - c.from + 1,
    origFrom: a.length - c.origTo + 1, origTo: a.length - c.origFrom + 1,
    original: rev(c.original, c.origTo - c.origFrom + 1),
    text: rev(c.text, c.to - c.from + 1),
  }));
}

function diffLines(a: string[], b: string[]): AiChange[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (!am.length && !bm.length) return [];

  /* 配对：same[i] = am[i] 对上的 bm 下标，-1 是没对上 */
  const pairs: Array<[number, number]> = [];
  if (am.length && bm.length && am.length * bm.length <= MAX_CELLS) {
    const n = am.length;
    const m = bm.length;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { pairs.push([i, j]); i += 1; j += 1; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i += 1;
      else j += 1;
    }
  }
  pairs.push([am.length, bm.length]);

  const out: AiChange[] = [];
  let ai = 0;
  let bi = 0;
  for (const [pa, pb] of pairs) {
    if (pa > ai || pb > bi) {
      const original = am.slice(ai, pa).join('\n');
      const text = bm.slice(bi, pb).join('\n');
      out.push({
        from: pre + bi + 1, to: pre + pb,
        original, origFrom: pre + ai + 1, origTo: pre + pa,
        text,
      });
    }
    ai = pa + 1;
    bi = pb + 1;
  }
  return out;
}

/**
 * 主进程回的 `changes` 能不能直接用 —— 每一处都得和手里这两版正文对得上（原文在旧版那几行、新字在新版那几行）。
 * 对不上（字段名不同、换行符不同、主进程算的是别的基准）就返回 null，调用方自己 `diffChanges`。
 *
 * 认两种写法：这里的 `origFrom/origTo/original`，和主进程 `patch` 档的 `PatchChange`（`oldFrom/oldTo/oldText`）。
 * 前后一字不差的那几处（模型交回了没改的段落）不算改动，不标。
 */
export function trustedChanges(raw: unknown, before: string, after: string): AiChange[] | null {
  if (!Array.isArray(raw)) return null;
  const a = splitLines(before);
  const b = splitLines(after);
  const out: AiChange[] = [];
  for (const c of raw as any[]) {
    const from = Number(c?.from);
    const to = Number(c?.to);
    const origFrom = Number(c?.origFrom ?? c?.oldFrom);
    const origTo = Number(c?.origTo ?? c?.oldTo);
    if (![from, to, origFrom, origTo].every(Number.isInteger)) return null;
    if (from < 1 || to < from - 1 || to > b.length || origFrom < 1 || origTo < origFrom - 1 || origTo > a.length) return null;
    const given = c?.original ?? c?.oldText;
    const original = typeof given === 'string' ? given : null;
    if (original === null || a.slice(origFrom - 1, origTo).join('\n') !== original) return null;
    const text = b.slice(from - 1, to).join('\n');
    if (text === original && to - from === origTo - origFrom) continue;
    out.push({ from, to, original, origFrom, origTo, text });
  }
  return out.sort((x, y) => x.from - y.from);
}

/** 这一处此刻还是不是 AI 写进去的那样。 */
export function changeIntact(current: string | null | undefined, c: AiChange): boolean {
  const lines = splitLines(current);
  const count = c.to - c.from + 1;
  if (c.from < 1 || c.to > lines.length) return false;
  if (count <= 0) return true;
  return lines.slice(c.from - 1, c.to).join('\n') === c.text;
}

/**
 * **只把这一处换回原文**之后的整份正文 —— 别的行逐字照抄。这一处之后又被改过（此刻那几行不是 AI 写的那样）
 * 返回 null，调用方不写、说一句。
 */
export function revertChange(current: string | null | undefined, c: AiChange): string | null {
  if (!changeIntact(current, c)) return null;
  const lines = splitLines(current);
  const orig = linesOf(c.original, c.origTo - c.origFrom + 1);
  return [...lines.slice(0, c.from - 1), ...orig, ...lines.slice(Math.max(c.from - 1, c.to))].join('\n');
}

/**
 * 文件从 `before` 变成 `after` 之后，已有的那些标记跟着挪 —— 落在没动过的那几行里的照行数平移；
 * 和这次改动沾边的（它那几行被改了，或者改动就贴在一处纯删除的位置上）丢掉：那一段已经不是 AI 当时写的样子了。
 *
 * `keepTouched`：沾边的**不丢**，留在原处（按它前面那些改动平移）—— 文件是在 KiroLex 外面被改的，标记要留着，
 * 点撤销时才能说清「这一段之后又改过了」，而不是让它悄悄不见。
 */
export function remapChanges<T extends AiChange>(marks: T[], before: string, after: string, keepTouched = false): T[] {
  if (!marks.length || before === after) return marks;
  /*
    **两种对法都得说它没被碰、挪到同一个位置**才算跟上了。重复的段落（AI 把 A 改成了和后面一样的 B，之后你删掉了
    AI 那一段）只按一种对法比，会把剩下那一段原本没动过的 B 当成 AI 那段 —— 撤销就改错了地方。
  */
  const early = diffChanges(before, after);
  const late = diffChanges(before, after, true);
  const out: T[] = [];
  for (const m of marks) {
    const a = follow(m, early);
    const b = follow(m, late);
    const ok = !m.stale && !a.hit && !b.hit && a.shift === b.shift;
    if (ok) out.push(a.shift ? { ...m, from: m.from + a.shift, to: m.to + a.shift } : m);
    else if (keepTouched) out.push({ ...m, from: m.from + a.shift, to: m.to + a.shift, stale: true });
  }
  return out;
}

/** 一处标记在一组改动之后：有没有被碰到、往下挪了几行（被碰到时是碰到之前累计的那些）。 */
function follow(m: AiChange, edits: AiChange[]): { hit: boolean; shift: number } {
  let shift = 0;
  let hit = false;
  for (const e of edits) {
    /* 旧版里这次改动占的行（`origFrom..origTo`）；空区间就是插在 origFrom 之前 */
    const eEmpty = e.origTo < e.origFrom;
    const mEmpty = m.to < m.from;
    if (eEmpty && mEmpty) { if (e.origFrom === m.from) { hit = true; break; } }
    else if (eEmpty) { if (e.origFrom > m.from && e.origFrom <= m.to) { hit = true; break; } }
    else if (mEmpty) { if (m.from > e.origFrom && m.from <= e.origTo) { hit = true; break; } }
    else if (e.origFrom <= m.to && e.origTo >= m.from) { hit = true; break; }
    const before_ = eEmpty ? e.origFrom <= m.from : e.origTo < m.from;
    if (before_) shift += (e.to - e.from + 1) - (e.origTo - e.origFrom + 1);
  }
  return { hit, shift };
}

/**
 * 预览里哪些块要挂底色、标记那一行（「AI 刚改过」+ 撤销）摆在哪一块下面。
 *
 * `groups`：显示用的块（`displayGroups`），各自占的行。空行不成块，所以一处改动只动了空行、或者是纯删除时，
 * 标记挂在它前面那一块上（前面没有就挂第一块）。
 * 返回：`lit` 要挂底色的块的锚点；`rowAt` 锚点 → 摆在它下面的那几处（`marks` 的下标）。
 */
export function markLayout(
  marks: AiChange[],
  groups: Array<{ anchor: number; span: number[] }>,
): { lit: Set<number>; rowAt: Map<number, number[]> } {
  const lit = new Set<number>();
  const rowAt = new Map<number, number[]>();
  if (!groups.length) return { lit, rowAt };
  marks.forEach((m, idx) => {
    const hits = m.to >= m.from
      ? groups.filter((g) => g.span.some((l) => l >= m.from && l <= m.to))
      : [];
    let host: number;
    if (hits.length) {
      for (const g of hits) lit.add(g.anchor);
      host = hits[hits.length - 1].anchor;
    } else {
      const prev = groups.filter((g) => Math.max(...g.span) < m.from);
      host = (prev.length ? prev[prev.length - 1] : groups[0]).anchor;
    }
    rowAt.set(host, [...(rowAt.get(host) || []), idx]);
  });
  return { lit, rowAt };
}

/** 一处标记：改动本身 + 给撤销认它的 `id` + 撤销没成的原因 + 这次改写删掉了字段时的那句提示（`warn`）。 */
export type AiMark = AiChange & { id: number; note?: string; warn?: string };
/** 标记连同它们的行号所对的那一版正文 —— 正文变了据此挪（`remapChanges`）。 */
export type AiMarkState = { base: string; marks: AiMark[] };

/** 撤销拒绝时给人看的那句。 */
export const UNDO_REFUSED = t(DEFAULT_LANG, 'This passage was changed again afterward, so it wasn\'t undone');

/**
 * **撤销那一处，基于盘上此刻的正文** —— 不信预览缓存：文件可能已经在外面被改了、预览还没刷。
 *
 * 先把标记从它记着的那一版（`state.base`）挪到 `disk` 上（被改到的照样留着，见 `keepTouched`），
 * 再核对那几行还是 AI 写进去的样子。对得上：返回撤销后的整份（别的行逐字照抄盘上那份，外面的改动都在）；
 * 对不上 / 找不到这条：返回拒绝。
 */
export function planUndo(
  state: AiMarkState, id: number, disk: string, lang: Lang = 'zh',
): { ok: true; text: string; mark: AiMark } | { ok: false; why: string } {
  const own = state.marks.find((m) => m.id === id);
  if (!own) return { ok: false, why: t(lang, 'This mark no longer exists') };
  /* 跟不上的（被碰过、对不准位置）一律不撤 —— 字面上对得上也不行，那几行可能已经是另一段了 */
  const [mark] = state.base === disk ? [own] : remapChanges([own], state.base, disk, true);
  const text = mark && !mark.stale ? revertChange(disk, mark) : null;
  if (!mark || text === null) return { ok: false, why: t(lang, 'This passage was changed again afterward, so it wasn\'t undone') };
  return { ok: true, text, mark };
}
