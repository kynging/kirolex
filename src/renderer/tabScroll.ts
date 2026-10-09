/**
 * 右侧预览标签的**滚动位置** —— 刷新窗口 / 重启之后标签开回来，还停在上次看到的那一段。
 *
 * 存的是像素（`scrollTop`），按文件路径记（标签 id 每次开回来都是新的）。
 * PDF / PPT 不在外层面板里滚，而是在 `PdfView` 自己的 `.rv-pdf-pages` 里滚 —— 见 `scrollHostOf`。
 */

/** 存档里读出来的位置 —— 旧存档没有这一项、或者是乱的，都当作在顶部。 */
export function savedScrollOf(entry: unknown): number {
  const v = Number((entry as { scroll?: unknown } | null | undefined)?.scroll);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/**
 * 往 `target` 滚的这一步：能滚到就滚到（`reached`），内容还不够高就先滚到底（等它长上来）。
 * 文件变短了、位置超出末尾，最后停在底部就是这一步给的。
 */
export function scrollStep(target: number, scrollHeight: number, clientHeight: number): { top: number; reached: boolean } {
  const want = Math.max(0, Number.isFinite(target) ? target : 0);
  const max = Math.max(0, (Number(scrollHeight) || 0) - (Number(clientHeight) || 0));
  if (max >= want) return { top: want, reached: true };
  return { top: max, reached: false };
}

/** 真正在滚的那个元素：deck 是里面那一列页，其余是面板本身。 */
export function scrollHostOf(body: HTMLElement): HTMLElement {
  return (body.querySelector('.rv-pdf-pages') as HTMLElement | null) || body;
}

/**
 * 把 `body` 里的内容滚回 `target` —— **内容是慢慢出来的**（Markdown 渲染、代码高亮、PDF 逐页画），
 * 第一帧设一次 `scrollTop` 时高度往往还不够。所以每隔一会儿再试，滚到位或超时就停；
 * 用户自己动了（滚轮、按键、点滚动条、触摸）立刻停，不再把人拉回去。
 *
 * 返回取消函数。`onStop()` 在停下时调 —— 不管是滚到了、超时、被用户打断还是被取消。
 */
export function restoreScroll(
  body: HTMLElement,
  target: number,
  onStop?: () => void,
  timeoutMs = 10000,
): () => void {
  let stopped = false;
  const started = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const userEvents = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearInterval(timer);
    for (const ev of userEvents) body.removeEventListener(ev, onUser, true);
    onStop?.();
  };
  function onUser() { stop(); }
  const tick = () => {
    if (stopped) return;
    const host = scrollHostOf(body);
    const step = scrollStep(target, host.scrollHeight, host.clientHeight);
    try { if (Math.abs(host.scrollTop - step.top) > 1) host.scrollTop = step.top; } catch {}
    if (step.reached || Date.now() - started >= timeoutMs) {
      stop();
    }
  };
  for (const ev of userEvents) body.addEventListener(ev, onUser, true);
  requestAnimationFrame(tick);
  /* 回顶部不用等内容 —— 一次就够 */
  if (target > 0) timer = setInterval(tick, 120);
  return stop;
}
