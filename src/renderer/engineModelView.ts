/**
 * **Claude Code / Codex 模型下拉：清单没到时显示什么、要不要再问一次**（ChatArea 的模型下拉）。
 *
 * 「远程 Claude Code 会话：模型下拉连上后显示『默认模型』」（s_1792550354705_bq53af，2026-11-10）：重连 / 切换期间
 * 渲染层清掉了清单（`setEngineModels(null)`），连上后问早了拿到 null、推送又没来，就一直停在「默认模型」——
 * 看起来像模型被设成了默认，其实那一轮用的是 Opus。现在：
 *   · 清单还没到（`null`）一律显示「连接中…」，不管连接状态；
 *   · 只有主进程真回了一份、而适配器就是没给模型选项（`options` 为空）时才显示「默认模型」；
 *   · 连着但清单没到就按 `ENGINE_MODELS_REASK_MS` 再问，直到拿到。
 */
export type EngineModelList = { options: unknown[] } | null | undefined;

/** 没有可选项时那一行的文案键（交给 `t`）。 */
export function engineModelPlaceholder(list: EngineModelList, connected: boolean): 'Default model' | 'Connecting…' {
  return connected && list ? 'Default model' : 'Connecting…';
}

/** 连着但还没拿到清单：第 n 次（从 0 数）重问前等多久。前几次快，之后每 5 秒一次，一直问到拿到 / 断开 / 换会话。 */
export const ENGINE_MODELS_REASK_MS = [500, 1_000, 2_000, 3_000];
export const ENGINE_MODELS_REASK_STEADY_MS = 5_000;
export function engineModelsReaskDelay(n: number): number {
  return n < ENGINE_MODELS_REASK_MS.length ? ENGINE_MODELS_REASK_MS[Math.max(0, n)] : ENGINE_MODELS_REASK_STEADY_MS;
}

/** 要不要再问：连着、还没拿到（主进程回 null = 这一刻 sessionClients 里还没有它）。 */
export function shouldReaskEngineModels(got: EngineModelList, connected: boolean): boolean {
  return connected && !got;
}
