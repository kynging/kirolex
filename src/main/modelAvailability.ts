/**
 * **这台机器的 kiro-cli 到底有哪些模型，以及怎么让它真的用你选的那个。**
 *
 * 起因是日志里一串 `[suggestions] model 'X' failed`：标题、建议、会话记忆压缩全都不工作。
 * 一路测下来是**两件独立的事**叠在一起，而且都是静默的：
 *
 * ## 1. 本机这一版根本没有 Claude 模型
 *
 * 实测 `kiro-cli 2.23.1 chat --list-models`（不花额度）：
 *
 * ```
 * * gpt-5.6-sol  gpt-5.6-terra  gpt-5.6-luna  deepseek-3.2
 *   minimax-m2.5  minimax-m2.1  glm-5  qwen3-coder-next
 * ```
 *
 * 一个 Claude 都没有 —— 连 `auto` 都没有。而**同一个账号**（同一个 IdC、同一个
 * `profile/YD3ARYRUKXQP`）在远端那台 1.27.0 上有 19 个，`claude-opus-5` 正常出话。
 * 所以这不是额度、不是权限，是**客户端版本**决定的清单。
 *
 * 结果：任何 Claude 模型都回 `The model 'claude-opus-5' is not available`，而这句话
 * **只在真跑一轮时**才出现（`connect()` 一定成功）—— 也就是每个新进程都要先付一轮失败。
 *
 * ## 2. `--model` 在 `chat --no-interactive` 上是个空操作
 *
 * 实测：`chat --no-interactive --model X` 一律先打一行
 * `[warn] failed to set model 'X': Method not found`，然后用**别的**模型去跑。
 * 传什么都一样（连不存在的名字都不报错），所以 KiroLex 设置里那个"辅助模型"从来没生效过。
 *
 * 真正说话的是 **agent JSON 里的 `model` 字段**：把 `kirolex-lite.json` 的 `model`
 * 换成 `gpt-5.6-terra` 之后，同一条命令（`--model claude-opus-5` 照旧传着、照旧警告）
 * 正常出话。而那份文件当时钉着 `claude-haiku-4.5` —— 于是助手类调用**全军覆没**，
 * 而且怎么改设置都没用。
 *
 * 这个模块只做纯逻辑：解析清单、判断该不该换、把模型钉进 agent 文件。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** `chat --list-models --format json` 里那些 id。解析不了就返回空数组 —— 空 = 没依据，别乱判。 */
export function parseModelList(raw: string): string[] {
  try {
    const data = JSON.parse(raw);
    const models = Array.isArray(data?.models) ? data.models : [];
    return models
      .map((m: any) => String(m?.model_id || '').trim())
      .filter((id: string) => !!id);
  } catch {
    return [];
  }
}

/**
 * 从清单里挑一个能用的。
 *
 * `wanted` 在清单里就用它；不在就按 `order` 挑第一个在的；都不在就用清单第一个。
 * **清单为空时原样返回** —— 没探到清单的时候"换一个"是没有依据的猜测，
 * 而既有的那套（真跑一轮失败再降级）还在，最坏只是慢。
 */
export function pickAvailableModel(wanted: string, available: string[], order: string[]): string {
  if (!available.length) return wanted;
  if (available.includes(wanted)) return wanted;
  return order.find((m) => available.includes(m)) || available[0];
}

/**
 * 把模型**钉进 agent JSON** —— 因为 `--model` 不管用（见文件头第 2 条）。
 *
 * 只在真的不一样时写盘：这个函数在每次标题/建议调用前都会跑一遍，而那是几秒一次的频率。
 * 文件不存在时**什么都不做并说清原因**：那份 agent 在用户的 `~/.kiro` 里，不在这个仓库里，
 * 凭空造一个出来会把"助手 agent 没装"这件事藏起来（它还关系到 MCP 冷启动那 26 秒）。
 *
 * @returns `changed` 有没有写盘；`reason` 没写盘的原因（给日志用）。
 */
export function pinAgentModel(
  agentName: string,
  model: string,
  home = os.homedir(),
): { changed: boolean; reason?: string } {
  const file = path.join(home, '.kiro', 'agents', `${agentName}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { changed: false, reason: `没有 ${file}` };
  }
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch (err: any) {
    /* 不许把一份读不懂的配置覆盖掉 —— 那是用户的文件 */
    return { changed: false, reason: `${file} 不是合法 JSON（${err?.message || err}）` };
  }
  if (json?.model === model) return { changed: false };
  json.model = model;
  try {
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  } catch (err: any) {
    return { changed: false, reason: `写不进 ${file}（${err?.message || err}）` };
  }
  return { changed: true };
}
