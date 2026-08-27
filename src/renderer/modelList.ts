/**
 * 模型列表缓存的取舍 —— PURE。
 *
 * 存在的理由是一次真实故障：断网期间 `kiro-cli chat --list-models` 返回了一份**格式正确但内容
 * 退化**的结果（只有 `auto`，而且 `context_window_tokens` 是 200k 而非真实的 1M）。App.tsx 里那句
 *
 *     uiSet('kirolex-models', JSON.stringify(data.models || []));
 *
 * 是**无条件**覆盖：好结果和坏结果一视同仁。于是唯一的回退来源被写坏，网恢复之后界面照旧显示
 * 「模型都不可用」—— 因为拉取一直超时走 `.catch()`，而 `.catch()` 读的就是那份坏缓存。
 *
 * 所以覆盖必须有条件。规则只有一条能概括：**不要用信息更少的答案替换信息更多的答案。**
 */

/**
 * 启动后等多久才去拉模型/agent 列表。
 *
 * 不是随手写的数字：这两条命令各要 spawn 一个 kiro-cli，冷启动要加载全部 MCP server（空闲实测 3.4s）。
 * 启动瞬间 eager-attach 正在同时拉起多条会话的执行器，插进去就双双超时 —— 日志里 13 次
 * `timed out after 10000ms`，提到 30s 之后照样超。日志里 `reveal: window shown` 通常落在 +2～4s，
 * 所以 4 秒是「等窗口就绪、执行器也铺开之后」的位置。
 *
 * 这段时间界面显示的是受保护的缓存，不是空列表。
 */
export const MODEL_LIST_WARMUP_DELAY_MS = 4000;

export interface ModelEntry {
  model_id?: string;
  model_name?: string;
  [key: string]: unknown;
}

/**
 * 「具体模型」= 除 `auto` 之外真正能选的那些。
 *
 * `auto` 不算：它是一个路由器（"Models chosen by task"），任何账号任何时候都有它，所以一份
 * 只剩 `auto` 的列表和「什么都没拿到」的信息量是一样的 —— 这正是退化结果的特征。
 */
export function concreteModels(list: ModelEntry[] | null | undefined): ModelEntry[] {
  if (!Array.isArray(list)) return [];
  return list.filter((m) => {
    const id = String(m?.model_id || m?.model_name || '').trim();
    return !!id && id !== 'auto';
  });
}

/**
 * 新拉到的列表值不值得写进缓存。
 *
 * 三条，按优先级：
 *   1. 空列表永远不收 —— 宁可显示旧的，也不要显示「没有模型」
 *   2. 新的有具体模型 → 收（模型会上下线，不能永远钉住旧列表）
 *   3. 新的没有具体模型，但缓存里有 → 拒绝（这就是那次污染）；缓存也没有 → 收（首次启动）
 */
export function shouldReplaceModelCache(
  next: ModelEntry[] | null | undefined,
  cached: ModelEntry[] | null | undefined,
): boolean {
  const incoming = Array.isArray(next) ? next : [];
  if (incoming.length === 0) return false;
  if (concreteModels(incoming).length > 0) return true;
  return concreteModels(cached).length === 0;
}
