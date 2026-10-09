/**
 * **「AI 刚改过」的标记按文件存** —— 不放在 `ReviewPane` 自己的 state 里。
 *
 * 切换文件、退出批注模式、切到原文视图都会把 pane 卸掉；标记要留到**下一次提交**（或者撤销了那一处），
 * 所以和排队的改动（`reviewQueue.ts`）一样跟着文件路径走：pane 挂回来时原样拿回来，pane 不在时后台那条
 * 写完也照样记得上。PURE（不依赖 React），订阅由 pane 用 `useSyncExternalStore` 接。
 */
import { remapChanges, type AiMark, type AiMarkState } from './aiChanges.ts';

const byPath = new Map<string, AiMarkState>();
/**
 * 每份文件的**提交轮次** —— 每提交一次 +1（`beginAiRound`）。任务入队时记下当时的轮次，写完时只有仍是当前这一轮
 * 才挂新标记（`recordAiWrite`）：连续提交两次、第一轮还在跑的话，第一轮写完时它那几处不该再冒出来（上一轮的标记
 * 在第二次提交时就已经清掉了）。旧轮次的内容照常写回，只是不再标。
 */
const rounds = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

/** 这份文件此刻的标记 —— 没有返回 undefined。同一份内容返回同一个对象（`useSyncExternalStore` 要稳定快照）。 */
export function getAiMarks(path: string): AiMarkState | undefined {
  return byPath.get(path);
}

/** 改这份文件的标记。`fn` 返回同一个对象就算没变，不通知。标记清空了就把这一项删掉。 */
export function updateAiMarks(path: string, fn: (cur: AiMarkState | undefined) => AiMarkState | undefined): void {
  const cur = byPath.get(path);
  const next = fn(cur);
  if (next === cur) return;
  if (!next || !next.marks.length) {
    if (!cur) return;
    byPath.delete(path);
  } else {
    byPath.set(path, next);
  }
  for (const l of listeners.get(path) || []) l();
}

/** 这份文件此刻是第几轮（还没提交过是 0）。入队时记下它。 */
export function aiRoundOf(path: string): number {
  return rounds.get(path) ?? 0;
}

/** 提交了新一轮：上一轮的标记全部清掉，返回新一轮的轮次。 */
export function beginAiRound(path: string): number {
  const next = aiRoundOf(path) + 1;
  rounds.set(path, next);
  updateAiMarks(path, () => undefined);
  return next;
}

/**
 * 一次写回落盘之后：已有的标记跟着挪（`remapChanges`），**只摘掉 `undid` 那一处**；
 * `fresh` 只有 `round` 仍是当前这一轮才挂上 —— 旧轮次的任务、撤销、直接改都不带新标记。
 *
 * 被这次改动碰到、或者之前就已经对不准（`stale`）的那些**留着**、照样是 stale：标记要留到下一次提交，
 * 点撤销时说清「这一段之后又改过了」—— 撤销另一段不能把它顺手清掉。唯一的例外是被这次新挂的标记盖住的那些
 * （同一轮里后一条又改了同一段），留着就是同一段上两个标记。
 */
export function recordAiWrite(path: string, w: {
  base: string; fullText: string; fresh?: AiMark[]; round?: number; undid?: number;
}): void {
  const fresh = w.fresh?.length && w.round !== undefined && w.round === aiRoundOf(path) ? w.fresh : [];
  updateAiMarks(path, (cur) => {
    if (!cur && !fresh.length) return cur;
    const kept = (cur?.marks || []).filter((m) => m.id !== w.undid);
    const atBase = !cur || cur.base === w.base ? kept : remapChanges(kept, cur.base, w.base, true);
    const moved = remapChanges(atBase, w.base, w.fullText, true)
      .filter((m) => !(m.stale && fresh.some((f) => overlaps(m, f))));
    return { base: w.fullText, marks: [...moved, ...fresh] };
  });
}

/** 两处在新文件里占的行有没有交叠（空区间按它那个插入点算）。 */
function overlaps(a: AiMark, b: AiMark): boolean {
  const lo = (m: AiMark) => m.from;
  const hi = (m: AiMark) => Math.max(m.from, m.to);
  return lo(a) <= hi(b) && lo(b) <= hi(a);
}

export function subscribeAiMarks(path: string, cb: () => void): () => void {
  let set = listeners.get(path);
  if (!set) { set = new Set(); listeners.set(path, set); }
  set.add(cb);
  return () => { set!.delete(cb); if (!set!.size) listeners.delete(path); };
}
