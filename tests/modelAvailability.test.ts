import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseModelList, pickAvailableModel, pinAgentModel } from '../src/main/modelAvailability.ts';

/*
 * 「claude-opus-5 is not available 这条你要不要查」→ 查了，是**两件独立的事**叠在一起，
 * 而且都是静默的。两条都是实测出来的，不是读代码读出来的：
 *
 * 1. `kiro-cli 2.23.1 chat --list-models` 的清单里**一个 Claude 都没有**
 *    （`gpt-5.6-sol/terra/luna`、`deepseek-3.2`、`minimax-*`、`glm-5`、`qwen3-coder-next`，
 *    连 `auto` 都没有），而同一个账号在远端 1.27.0 上有 19 个、`claude-opus-5` 正常出话。
 *    所以不是额度、不是权限，是客户端版本决定的清单。
 *
 * 2. `chat --no-interactive --model X` 是**空操作**：一律先打
 *    `[warn] failed to set model 'X': Method not found` 再用别的模型跑。
 *    真正说话的是 agent JSON 里的 `model` 字段 —— 把 `kirolex-lite.json` 的 model
 *    换成 `gpt-5.6-terra` 之后，同一条命令（`--model claude-opus-5` 照旧传着、照旧警告）正常出话。
 *
 * 两条叠起来的后果：`kirolex-lite.json` 钉着 `claude-haiku-4.5`，于是标题、建议、
 * 会话记忆压缩**全都**失败，而且改 KiroLex 设置里的"辅助模型"完全没用。
 */
describe('模型可用性：清单、挑选、钉进 agent', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('解析 `--list-models --format json` 的 id', () => {
    const raw = JSON.stringify({
      models: [
        { model_id: 'gpt-5.6-sol', model_name: 'GPT 5.6 Sol' },
        { model_id: 'deepseek-3.2' },
        { model_id: '' },
        { nope: 1 },
      ],
    });
    assert.deepEqual(parseModelList(raw), ['gpt-5.6-sol', 'deepseek-3.2']);
  });

  test('解析不了返回空数组 —— 空的含义是"这次没依据"，不是"没有模型"', () => {
    assert.deepEqual(parseModelList('not json'), []);
    assert.deepEqual(parseModelList('{}'), []);
  });

  test('挑一个清单里真有的；清单为空时原样返回', () => {
    const avail = ['gpt-5.6-sol', 'deepseek-3.2'];
    assert.equal(pickAvailableModel('gpt-5.6-sol', avail, ['deepseek-3.2']), 'gpt-5.6-sol');
    /* 想要的没有 → 按 fallback 顺序挑 */
    assert.equal(pickAvailableModel('claude-opus-5', avail, ['deepseek-3.2', 'gpt-5.6-sol']), 'deepseek-3.2');
    /* fallback 也都没有 → 清单第一个（总比什么都不给好） */
    assert.equal(pickAvailableModel('claude-opus-5', avail, ['claude-haiku-4.5']), 'gpt-5.6-sol');
    /* 清单为空 = 没探到 → 不动它，照旧让既有的"跑一轮失败再降级"兜着 */
    assert.equal(pickAvailableModel('claude-opus-5', [], ['gpt-5.6-sol']), 'claude-opus-5');
  });

  test('把模型钉进 agent JSON（因为 --model 不生效）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-agent-'));
    const dir = path.join(home, '.kiro', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'kirolex-lite.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'kirolex-lite', model: 'claude-haiku-4.5', tools: [] }));

    const first = pinAgentModel('kirolex-lite', 'gpt-5.6-terra', home);
    assert.equal(first.changed, true);
    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(after.model, 'gpt-5.6-terra');
    assert.deepEqual(after.tools, [], '别的字段一个都不许动 —— 那是用户的文件');

    /* 每次标题/建议调用前都会跑一遍（几秒一次），一样就别写盘 */
    assert.equal(pinAgentModel('kirolex-lite', 'gpt-5.6-terra', home).changed, false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('文件不存在 / 不是 JSON：什么都不做，并说清原因', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-agent2-'));
    const missing = pinAgentModel('kirolex-lite', 'gpt-5.6-sol', home);
    assert.equal(missing.changed, false);
    assert.match(String(missing.reason), /没有/);

    const dir = path.join(home, '.kiro', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kirolex-lite.json'), '{ broken');
    const broken = pinAgentModel('kirolex-lite', 'gpt-5.6-sol', home);
    /* 读不懂就别覆盖：凭空造一份会把"助手 agent 没装/坏了"这件事藏起来 */
    assert.equal(broken.changed, false);
    assert.match(String(broken.reason), /JSON/);
    assert.equal(fs.readFileSync(path.join(dir, 'kirolex-lite.json'), 'utf-8'), '{ broken');
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('助手调用真的去钉 agent，而不是只传那个被忽略的 --model', () => {
    assert.match(M, /pinAgentModel\(LITE_AGENT, m\)/);
    /* --model 仍然传着：别的版本上它管用，多传一个被忽略的参数不花代价 */
    assert.match(M, /'--agent', LITE_AGENT, '--model', m, prompt/);
    assert.match(M, /--model` 在 `chat --no-interactive` 上是空操作/);
  });

  test('助手模型先按本机清单筛 —— 否则那个循环把同一个失败付两遍', () => {
    assert.match(M, /const usable = models\.filter\(\(m\) => available\.includes\(m\)\)/);
    /* 两个都退役时要说清是谁替了谁（悄悄换掉才是那个查了很久的病） */
    assert.match(M, /在本机 kiro-cli 上都没有 -> 用/);
  });

  test('本机会话不必用"跑一轮失败"去发现模型退役', () => {
    /* 那一轮实测 30 秒，而 `--list-models` 几秒、不花额度，回答的正是同一件事 */
    assert.match(M, /if \(!profile\.remote\?\.sshHost\) \{\s*\n\s*const available = await localModelIds\(\);/);
    assert.match(M, /modelsKnownDead\.add\(m\);/);
    /* 远程走 pickRemoteModel（那台机器的清单来自 preflight），不混在一起 */
    assert.match(M, /远程会话不走这儿/);
  });

  test('清单探测失败不缓存空值 —— 空是"这次没依据"', () => {
    assert.match(M, /if \(ids\.length\) localModelIdsCache = ids;/);
    assert.match(M, /这次不做可用性判断/);
  });
});
