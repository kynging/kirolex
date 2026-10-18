/**
 * `CommentBox` 里「✓ 确认」那一步 —— 搬成纯函数是为了能连着上层的提交一起测（`.tsx` 在 node 测试里加载不了）。
 *
 * `onApply` 返回真（或兑现为真）就清掉框里的草稿：那条指令已经执行完了，留在框里下一次会被再发一遍。
 * 返回假 = 保留草稿（失败 / 改不了，或者上层自己管清不清 —— 见 `reviewBlocks.submitFromBox`）。
 */
export function applyDraft(
  draft: string,
  onApply: ((text: string) => Promise<boolean> | boolean | void) | undefined,
  setDraft: (next: string) => void,
  applyWhenEmpty?: boolean,
): Promise<void> | void {
  const next = draft.trim();
  if ((!next && !applyWhenEmpty) || !onApply) return;
  return Promise.resolve(onApply(next)).then((ok) => { if (ok) setDraft(''); });
}
