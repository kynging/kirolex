/**
 * 启动预连接的两条规矩（「为什么 agent board 会话现在显示的是红的」，2026-11-20 实测）：
 * 同一台 EC2 的几条会话同时连，每条都去推一次临时公钥（SendSSHPublicKey），撞上 ThrottlingException 就标红。
 *  - 同一台机器的预连接**一条接一条**（第一条建好的 ssh 主连接后面的直接复用，不再推公钥）；
 *  - 撞上限流按退避再试一两次，还不行才算失败。
 * 预连接**哪些**会话不归这里管（`sessionsToWarm` / `remoteWarmCut`）。
 */

/** AWS 限流（EC2 Instance Connect 的 SendSSHPublicKey 最常见）。别的错误（连不上、到上限、没装适配器）不算。 */
export function isThrottleError(err: unknown): boolean {
  const s = String((err as any)?.message ?? err ?? '');
  return /ThrottlingException|TooManyRequests|Rate exceeded/i.test(s);
}

/** 限流后的等待（毫秒）：重试两次。 */
export const THROTTLE_RETRY_DELAYS_MS = [3000, 8000];

export async function withThrottleRetry<T>(
  attempt: () => Promise<T>,
  opts: { delays?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const delays = opts.delays ?? THROTTLE_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= delays.length || !isThrottleError(err)) throw err;
      await sleep(delays[i]);
    }
  }
}

/**
 * 按机器分组跑：同一个非空 key（同一台远程机器）的串行，不同机器之间、以及 key 为空的（本机会话）并行。
 * 单条抛错不挡同组的下一条（调用方自己在 `fn` 里处理失败）。
 */
export async function runPerMachine<T>(items: T[], keyOf: (item: T) => string | undefined, fn: (item: T) => Promise<void>): Promise<void> {
  const groups = new Map<string, T[]>();
  const solo: T[] = [];
  for (const it of items) {
    const k = keyOf(it);
    if (!k) { solo.push(it); continue; }
    const g = groups.get(k);
    if (g) g.push(it); else groups.set(k, [it]);
  }
  const safe = (it: T) => fn(it).catch(() => {});
  await Promise.all([
    ...solo.map(safe),
    ...[...groups.values()].map(async (g) => { for (const it of g) await safe(it); }),
  ]);
}

/** 这条会话流出了模型输出 / 工具调用 —— 执行器显然连着。 */
export function outputProvesAttached(kind: unknown): boolean {
  return kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'agent_reasoning_chunk'
    || kind === 'tool_call' || kind === 'tool_call_update';
}
