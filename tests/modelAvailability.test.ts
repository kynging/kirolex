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
 * 1. 这台 Mac 的 `chat --list-models` 里**一个 Claude 都没有**
 *    （`gpt-5.6-sol/terra/luna`、`deepseek-3.2`、`minimax-*`、`glm-5`、`qwen3-coder-next`，
 *    连 `auto` 都没有），而**同一个账号**在东京那台 EC2 上 19 个全在、`claude-opus-5` 正常出话。
 *
 *    我第一版归因成"客户端版本"，**那是错的**（用户：「opus5 没退役啊」）。真正的原因是
 *    **出口 IP 的地域过滤**：这台 Mac 出口是 CN / AS4837（联通），那台 EC2 在 JP；
 *    缺的正好是 10 个 Claude + `auto`（19 − 11 = 8），一个不多一个不少。
 *    版本无关有两条证据：远端 2.24.0（比本机 2.23.1 **新**）照样 19 个全在；
 *    并且有人直接探 `ListAvailableModels`、伪装 appVersion 2.12.0→2.23.0，每次都是 19 个。
 *    官方也把 Claude 标成 Active、没有任何退役记录。
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

  /*
   * 「opus5 没退役啊」→ 对，是我说错了。查到底是**出口 IP 的地域过滤**：
   *   · 同一个账号：东京那台 EC2（出口 JP）19 个模型全在、claude-opus-5 正常出话；
   *     这台 Mac（出口 CN / AS4837 联通）只有 8 个 —— 缺的正好是 10 个 Claude + `auto`。
   *   · 和版本无关：有人直接探 `ListAvailableModels`，伪装 appVersion 2.12.0→2.23.0 每次都是 19 个；
   *     我也实测过远端 2.24.0（比本机 2.23.1 还新）照样 19 个全在。
   *   · Kiro 官方把 Claude 标成 Active、没有任何退役记录；已知 issue 里唯一确认过根因的那条
   *     就是"企业网络出口落在不支持的地区，Auto 和 Claude 一起消失"。
   *
   * 所以这在这台机器上是**长期状态**，那就必须在会话里说出来：界面写着 claude-opus-5、
   * 实际跑 gpt-5.6-sol，而唯一的痕迹在日志里 —— 那是最难发现的一类错。
   */
  test('本机换了模型要在会话里说一句，并且给出那个签名成立时的原因', () => {
    assert.match(M, /const wanted = profile\.preferredModel \|\| profile\.model;/);
    assert.match(M, /if \(sessionId && wanted && !available\.includes\(wanted\)\)/);
    /* 判据是那个签名：一个 Claude 都没有、`auto` 也没有 */
    assert.match(M, /const geoFiltered = !available\.some\(\(m\) => m\.startsWith\('claude-'\)\) && !available\.includes\('auto'\)/);
    assert.match(M, /出口 IP 的地域过滤/);
    assert.match(M, /换 kiro-cli 版本没用/);
    /* 签名不成立时不许乱归因 —— 归错因比不归因贵，人会照着错方向查 */
    assert.match(M, /不乱归因/);
  });

  test('两个调用点都把 sessionId 传进去了（不传就只进日志）', () => {
    assert.match(M, /connectWithModelFallback\(profile, 'new-session', startLocalTools, kiroLexId\)/);
    assert.match(M, /connectWithModelFallback\(profile, `attach \$\{sessionId\}`, localTools, sessionId\)/);
  });

  test('清单探测失败不缓存空值 —— 空是"这次没依据"', () => {
    assert.match(M, /if \(ids\.length\) localModelIdsCache = ids;/);
    assert.match(M, /这次不做可用性判断/);
  });
});
