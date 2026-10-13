/**
 * **等这条会话正在进行的 attach 落定** —— 切换运行位置之前用。
 *
 * attach 一开头就读了记录，之后几秒到几十秒都在按那份记录起执行器。这期间把记录改成远端，
 * 那次 attach 照样按旧记录在本机起（本机清单里没有 Claude → 提示 + 换成 GPT），而渲染层随后的重连
 * 又被 `attachInFlight` 并进它 —— 记录写着远端，执行器却是本机的。先等它落定，再看有没有执行器。
 *
 * attach 失败不往外抛（那是 attach 自己的事，切换照常按"没连着"处理）。落定之后又冒出一个
 * （渲染层重试）也一起等，但只等几轮，免得卡死在一条一直连不上的会话上。
 */
export async function settleInFlightAttach(
  inFlight: Map<string, Promise<unknown>>,
  sessionId: string,
  maxRounds = 3,
): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const pending = inFlight.get(sessionId);
    if (!pending) return;
    try { await pending; } catch { /* attach 失败由它自己报 */ }
  }
}
