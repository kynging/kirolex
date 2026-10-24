/**
 * 把这一格里**指定的那张**还挂着的提问卡片（`data-pending-ask="<id>"`）滚到眼前 —— ChatArea 用（测试 `tests/askAtBottom.test.ts`）。
 *
 * 挂着的卡片画在这一轮最下面，所以先滚到底；目标卡片的顶上还在可视区上面（卡片比可视区高、或者它后面还有别的卡片）
 * 时改为对齐它的顶上（先看到问的是什么）。同一会话可以同时挂好几张，必须按 id 找：取第一张会把最新那张留在视野外。
 * 只写这一个容器的 scrollTop，不用 scrollIntoView（会连带滚动分屏共用的外层，见 `tests/scrollIsolation.test.ts`）。
 */
interface Box { getBoundingClientRect(): { top: number } }
interface AskNode extends Box { dataset: { pendingAsk?: string } }
export interface AskContainer extends Box {
  scrollTop: number;
  scrollHeight: number;
  querySelectorAll(selector: string): ArrayLike<AskNode>;
}

export function revealPendingAsk(container: AskContainer | null, id: string | null): void {
  if (!container) return;
  container.scrollTop = container.scrollHeight;
  if (!id) return;
  const cards = Array.from(container.querySelectorAll('[data-pending-ask]'));
  const card = cards.find((c) => c.dataset.pendingAsk === id);
  if (!card) return;
  const top = card.getBoundingClientRect().top - container.getBoundingClientRect().top;
  if (top < 0) container.scrollTop += top;
}
