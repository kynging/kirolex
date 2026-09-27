/**
 * **模型的倍率/上下文窗口从哪儿来** ——「这个远程会话为什么又看不到模型乘数了」。
 *
 * ## 为什么会看不到
 *
 * 远程会话的模型清单来自**那台机器**，但 kiro-cli 1.27.0 只给得出一串 id（它没有
 * `--list-models`，探测法只能从参数校验的报错里抠出名字）。名字之外的元数据一直是**按 id 从本机
 * 那份补上**的 —— 机器决定"有哪些模型"，而"倍率 2.2"是模型自己的属性。
 *
 * 这个补齐在本机清单里有 Claude 的时候一直成立。现在不成立了：本机出口 IP 被地域过滤，
 * `--list-models` 里一个 Claude 都没有（见 `modelAvailability.ts`），于是 `claude-opus-5`
 * 补不到任何东西，界面上那个 `· 2.2x` 就消失了。
 *
 * ## 怎么修
 *
 * 两层，**实时的永远赢**：
 *
 * 1. 一份**持久缓存**（`~/.kirolex/model-meta.json`）：任何一次拿到真实元数据就并进去。
 *    这样"某台机器暂时不报某个模型"不再等于"这个模型的属性丢了"。
 * 2. 一份**内置快照**（下面那张表）：缓存里也没有时兜底。
 *
 * 那张表里的数字**不是编的** —— 是这台机器还能列 Claude 时抓到的一份真实清单
 * （`ui-state.json.bak-opus5` 里存着的 19 条），2026-09 抓的。倍率会变，所以它只是兜底：
 * 任何实时数据都会盖掉它，并写进缓存。
 */

import fs from 'fs';
import path from 'path';

export interface ModelMeta {
  model_name?: string;
  rate_multiplier?: number;
  context_window_tokens?: number;
  description?: string;
}

/**
 * 兜底快照 —— 2026-09 在这台机器上实测到的那一份（本机当时还能列 Claude）。
 *
 * 只放"实时拿不到"的那些（Claude 系列 + auto）。gpt / deepseek / minimax / glm / qwen
 * 本机现在还在报，不需要兜底 —— 写死它们只会多一份将来会过期的副本。
 */
export const FALLBACK_META: Record<string, ModelMeta> = {
  auto: { rate_multiplier: 1, context_window_tokens: 1_000_000 },
  /* 2026-09-27 从**远端**更新到 2.24.1 之后那份真实清单里抄的（它报 2.00x）——
     这个 id 出现得比上面那份快照晚，所以之前一直是"没有乘数"（`metaFrom: 'none'`）。 */
  'claude-opus-5.5': { rate_multiplier: 2, context_window_tokens: 1_000_000 },
  'claude-opus-5': { rate_multiplier: 2.2, context_window_tokens: 1_000_000 },
  'claude-sonnet-5': { rate_multiplier: 1.3, context_window_tokens: 1_000_000 },
  'claude-opus-4.8': { rate_multiplier: 2.2, context_window_tokens: 1_000_000 },
  'claude-opus-4.7': { rate_multiplier: 2.2, context_window_tokens: 1_000_000 },
  'claude-opus-4.6': { rate_multiplier: 2.2, context_window_tokens: 1_000_000 },
  'claude-sonnet-4.6': { rate_multiplier: 1.3, context_window_tokens: 1_000_000 },
  'claude-opus-4.5': { rate_multiplier: 2.2, context_window_tokens: 200_000 },
  'claude-sonnet-4.5': { rate_multiplier: 1.3, context_window_tokens: 200_000 },
  'claude-sonnet-4': { rate_multiplier: 1.3, context_window_tokens: 200_000 },
  'claude-haiku-4.5': { rate_multiplier: 0.4, context_window_tokens: 200_000 },
};

/** 缓存里一条 —— 带上"什么时候见到的"，便于以后判断要不要当它过期。 */
export interface CachedMeta extends ModelMeta { seenAt: number }

export function readMetaCache(file: string): Record<string, CachedMeta> {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return (d && typeof d === 'object') ? d : {};
  } catch { return {}; }
}

export function writeMetaCache(file: string, cache: Record<string, CachedMeta>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2));
  } catch { /* 缓存写不进去只是下次少一点信息，不值得报错 */ }
}

/**
 * 把一份真实清单并进缓存。返回**有没有变化**（没变就不必写盘）。
 *
 * 只收带了实际数字的条目：把一条 `{model_id}` 记进缓存等于把"没信息"固化成"信息是空的"，
 * 之后连兜底表都会被它盖掉。
 */
export function mergeMeta(
  cache: Record<string, CachedMeta>,
  models: Array<{ model_id?: string; model_name?: string; rate_multiplier?: number; context_window_tokens?: number; description?: string }>,
  now = Date.now(),
): boolean {
  let changed = false;
  for (const m of models || []) {
    const id = String(m?.model_id || '').trim();
    if (!id) continue;
    if (typeof m.rate_multiplier !== 'number' && typeof m.context_window_tokens !== 'number') continue;
    const prev = cache[id];
    if (prev && prev.rate_multiplier === m.rate_multiplier
      && prev.context_window_tokens === m.context_window_tokens
      && prev.model_name === m.model_name) continue;
    cache[id] = {
      model_name: m.model_name,
      rate_multiplier: m.rate_multiplier,
      context_window_tokens: m.context_window_tokens,
      description: m.description,
      seenAt: now,
    };
    changed = true;
  }
  return changed;
}

/**
 * 给一串 id 配上元数据。优先级：**实时清单 → 缓存 → 内置快照 → 只有 id**。
 *
 * `metaFrom` 说清这一条的数字是哪来的 —— 界面可以据此标注。不说的话"2.2x"看起来永远是
 * 权威数字，而它可能是几个月前的快照。
 */
export function enrichModels(
  ids: string[],
  live: Record<string, ModelMeta>,
  cache: Record<string, CachedMeta>,
): Array<ModelMeta & { model_id: string; model_name: string; metaFrom: 'live' | 'cache' | 'fallback' | 'none' }> {
  return ids.map((id) => {
    const pick = live[id]
      ? { meta: live[id] as ModelMeta, from: 'live' as const }
      : cache[id]
        ? { meta: cache[id] as ModelMeta, from: 'cache' as const }
        : FALLBACK_META[id]
          ? { meta: FALLBACK_META[id], from: 'fallback' as const }
          : { meta: {} as ModelMeta, from: 'none' as const };
    return {
      ...pick.meta,
      model_id: id,
      model_name: pick.meta.model_name || id,
      metaFrom: pick.from,
    };
  });
}
