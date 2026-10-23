/**
 * **模型兜底按引擎分开** —— 说明和全表见 `docs/model-fallback-by-engine.md`。
 *
 * 三家的模型互不相通：Claude Code 只有 Claude（default / sonnet / opus / haiku …），Codex 只有 OpenAI 的，
 * kiro 的 id（claude-opus-5、gpt-5.6-sol …）对它们都不是合法值。所以：
 *   · kiro：原来那套（降级链 / `--list-models` 清单 / 死模型表 / `modelEarnedOn`）不动，不经过这里；
 *   · Claude Code / Codex：候选只来自**这个适配器自己报的** configOptions（`category: 'model'`），
 *     记住的不在清单里 → 「上次成功用的 → 适配器的 default / 当前值」，并在会话里说一句。
 *
 * 纯逻辑（渲染层也 import），不碰 node / electron。
 */
import type { AgentProfile } from './config.ts';
import type { Engine } from './engines.ts';

/** 适配器报的一组可选值（`AcpClient.selectOptions('model')` 的形状） */
export interface EngineModelOptions {
  current: string;
  options: Array<{ value: string; name?: string }>;
}

/**
 * Claude Code / Codex 连上之后模型设成哪个。`fallbackFrom` 有值 = 记住的那个这里没有，改用了 `value`（要说一句）。
 * kiro / 没记过 / 适配器没报清单 → null（什么都不做：没依据不乱设）。返回的 `value` 一定是 `opts.options` 里的一个。
 */
export function pickEngineModel(
  engine: Engine,
  wanted: string | undefined,
  lastGood: string | undefined,
  opts: EngineModelOptions | null | undefined,
): { value: string; fallbackFrom?: string } | null {
  if (engine === 'kiro' || !wanted || !opts?.options.length) return null;
  const has = (v: string | undefined): v is string => !!v && opts.options.some((o) => o.value === v);
  if (has(wanted)) return { value: wanted };
  const value = [lastGood, 'default', opts.current].find(has) || opts.options[0].value;
  return { value, fallbackFrom: wanted };
}

/** kiro 新会话的兜底链 —— 等于主进程的 `[DEFAULT_MODEL, ...MODEL_FALLBACK_ORDER]`（config.ts 带 fs，渲染层 import 不了） */
export const KIRO_NEW_CHAT_ORDER = ['claude-opus-5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-3.2'];

/**
 * 新会话的 `model`（渲染层 `modelForNewChat`）。只对 kiro 挑：你手选过的（`lastModel`）→ 兜底链，拿目标机器的清单
 * （`listIds`，问不到 = 没依据，用候选第一个）去验。Claude Code / Codex 留空：模型由 `engineModels` + 适配器清单决定，
 * 主进程给它们记 `'default'` 占位。
 */
export function newChatModel(engine: Engine, lastModel: string | undefined, listIds: string[] | undefined): string {
  if (engine !== 'kiro') return '';
  const candidates = [lastModel || KIRO_NEW_CHAT_ORDER[0], ...KIRO_NEW_CHAT_ORDER].filter((m, i, a) => m && a.indexOf(m) === i);
  if (!listIds?.length) return candidates[0];
  return candidates.find((m) => listIds.includes(m)) || candidates[0];
}

/**
 * 换引擎时 profile 怎么变（index.ts `reshapeForEngine`）。kiro 的模型 id / agent 对另外两家没意义；
 * 切回 kiro 时用你选过的偏好模型。`engineModels` / `engineOptions` 原样带着 —— 各引擎记住的互不覆盖。
 */
export function reshapeProfileForEngine(p: AgentProfile, engine: Engine, defaultModel: string): AgentProfile {
  const next: AgentProfile = { ...p };
  if (engine === 'kiro') {
    delete (next as any).engine;
    const pref = p.preferredModel && p.preferredModel !== 'default' ? p.preferredModel : defaultModel;
    next.model = pref;
    next.preferredModel = pref;
    next.modelEarnedOn = undefined;
  } else {
    (next as any).engine = engine;
    next.model = 'default';
    next.kiroAgent = undefined;
  }
  return next;
}

/**
 * 连上后适配器接受了 `value`（记住的那个，或兜底挑的那个）：记成「上次成功用的」。只改 `engineModelsUsed`，
 * `engineModels`（你选的）和 kiro 的字段都不动。没变就返回原对象（调用方据此不写盘）。
 */
export function withEngineModelUsed(p: AgentProfile, engine: 'claude' | 'codex', value: string): AgentProfile {
  if (p.engineModelsUsed?.[engine] === value) return p;
  return { ...p, engineModelsUsed: { ...p.engineModelsUsed, [engine]: value } };
}
