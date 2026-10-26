/**
 * **Claude Code / Codex 的 effort（推理强度）** —— 输入区模型下拉左边那个独立下拉（用户 2026-10-26：「不再放到 MCP 配置里面」）。
 *
 * 实测 effort 跟着模型走（docs/claude-code-feature-audit.md 1b）：Claude sonnet 的 configOptions 里有一项
 * `id: 'effort', category: 'thought_level'`（default/low/medium/high/xhigh/max），**换到 haiku 后这一项整个没了**，
 * 硬设回 `Internal error`；Codex 的那一项 id 是 `thought_level`（老版本 `reasoning_effort`），low/medium/high/xhigh/max。
 *
 * 纯逻辑（不 import electron）：认出那一项、换模型后记住的档位怎么办、MCP 配置里老的 effort 怎么一次性迁进会话。
 * 会话记住的档位在 `profile.engineOptions[engine].thought_level`（按引擎分开），重连 / 换后端后 `applyEngineModel` 照旧设回去。
 */
export type EffortSelect = { current: string; options: Array<{ value: string; name: string }> } | null;

/**
 * 「默认档位」是哪个：Claude Code 的清单里有一项 `default`；Codex 没有这一项，它自己的默认是 `medium`。
 * 两个都没有就是 undefined（不猜）。
 */
export function defaultEffort(opts: EffortSelect): string | undefined {
  if (!opts) return undefined;
  return ['default', 'medium'].find((v) => opts.options.some((o) => o.value === v));
}

/** 不写 category 的适配器靠 id 认（Claude 叫 effort，Codex 叫 thought_level / 老版本 reasoning_effort） */
const EFFORT_IDS = ['thought_level', 'effort', 'reasoning_effort'];

/** configOptions 里 effort 那一项：先按 ACP 的 category（`thought_level`），没有再按 id 认。没有 = undefined。 */
export function findEffortOption(configOptions: unknown[]): any {
  if (!Array.isArray(configOptions)) return undefined;
  const xs = configOptions as any[];
  return xs.find((x) => x?.category === 'thought_level')
    || xs.find((x) => !x?.category && EFFORT_IDS.includes(x?.id))
    || xs.find((x) => EFFORT_IDS.includes(x?.id) && x?.category !== 'model' && x?.category !== 'mode');
}

/** 下拉用的形状（和 `AcpClient.selectOptions` 一样）；当前模型没有 effort = null。 */
export function effortSelectFrom(configOptions: unknown[]): EffortSelect {
  const o = findEffortOption(configOptions);
  if (!o || !Array.isArray(o.options)) return null;
  return {
    current: String(o.currentValue ?? ''),
    options: o.options.map((x: any) => ({ value: String(x.value ?? x.id ?? ''), name: String(x.name ?? x.value ?? '') }))
      .filter((x: { value: string }) => x.value),
  };
}

export type EffortPlan =
  /** 没记过，或者适配器现在就是记住的那一档 */
  | { kind: 'keep' }
  /** 新模型支持记住的那一档，适配器现在不是它（换模型会带回它自己的默认档位）→ 设回去 */
  | { kind: 'set'; value: string }
  /** 新模型不支持记住的那一档 → 退到新模型的默认值（`setNeeded`：适配器现在不是它，要设一下） */
  | { kind: 'fallback'; wanted: string; value: string; setNeeded: boolean }
  /** 新模型根本不给 effort（haiku）→ 不设（硬设回 Internal error） */
  | { kind: 'unsupported'; wanted: string };

/**
 * **换模型（或重连）之后，会话记住的 effort 怎么办**。`opts` 是新模型的 effort 清单（`effortSelectFrom`）。
 * 默认值：清单里的 `default`（Claude）/ `medium`（Codex，`defaultEffort`）；都没有就用适配器换完模型报的当前值。
 */
export function planEffortForModel(remembered: string | undefined, opts: EffortSelect): EffortPlan {
  if (!remembered) return { kind: 'keep' };
  if (!opts || !opts.options.length) return { kind: 'unsupported', wanted: remembered };
  if (opts.options.some((o) => o.value === remembered)) {
    return opts.current === remembered ? { kind: 'keep' } : { kind: 'set', value: remembered };
  }
  const value = defaultEffort(opts) || (opts.options.some((o) => o.value === opts.current) ? opts.current : opts.options[0].value);
  return { kind: 'fallback', wanted: remembered, value, setNeeded: opts.current !== value };
}

interface EffortProfile {
  engineOptions?: Partial<Record<string, Partial<Record<string, string>>>>;
  /** MCP 配置（组合）里老的 effort 已经迁进过这条会话了：之后不再从组合读 */
  comboEffortMigrated?: boolean;
}

/**
 * **MCP 配置里老的 `effort` 一次性迁进会话**：老文件里组合带着 effort 的，当作这条会话的初始 effort
 * 写进 `engineOptions[engine].thought_level`（会话自己记过的不动），并打上 `comboEffortMigrated`。
 * 迁过的会话原样返回同一个对象（调用方据此判断要不要写盘）—— 之后换组合、改组合文件都不再影响 effort。kiro 不动。
 */
export function migrateComboEffort<P extends EffortProfile>(profile: P, engine: string, comboEffort: string | undefined): P {
  if (engine === 'kiro' || profile.comboEffortMigrated) return profile;
  const saved = profile.engineOptions?.[engine];
  if (!comboEffort || saved?.thought_level) return { ...profile, comboEffortMigrated: true };
  return {
    ...profile,
    comboEffortMigrated: true,
    engineOptions: { ...profile.engineOptions, [engine]: { ...saved, thought_level: comboEffort } },
  };
}
