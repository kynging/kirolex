import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseModelList, pickAvailableModel, pinAgentModel, firstWantedModel, remoteFallbackModel, remoteStartCandidates } from '../src/main/modelAvailability.ts';

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
    assert.match(M, /connectWithModelFallback\(profile, 'new-session', startLocalTools, kiroLexId, remoteModels\)/);
    assert.match(M, /connectWithModelFallback\(profile, `attach \$\{sessionId\}`, localTools, sessionId, remoteModels\)/);
  });

  test('清单探测失败不缓存空值 —— 空是"这次没依据"', () => {
    assert.match(M, /if \(ids\.length\) localModelIdsCache = ids;/);
    assert.match(M, /这次不做可用性判断/);
  });
});

/*
 * 「为什么切到远程 default 到 deepseek 了，搞毛啊」——**模型的可用性是按机器的，而代码当时不分机器**。
 *
 * 两处都踩了同一件事：
 *
 * 1. `record.profile.model` 是"上一次真跑成一轮挣来的有效模型"，持久化它是为了开机不再付一次
 *    死模型的超时。但没记是**哪台机器**挣的 —— 于是一条在本机被降级成 `deepseek-3.2` 的会话
 *    切到远端之后还在跑 deepseek，而那台机器上 `claude-opus-5` 是好的。
 *    更糟的是降级那一步会**清掉 `preferredModel`**（留着它每次重启都要再付 30 秒），
 *    于是换机器之后连"你原本想用什么"都没了：一次本机的临时不可用变成跨机器的永久降级。
 *
 * 2. `modelsKnownDead` 是一个**全进程共用**的 Set。一条本地会话把 `claude-opus-5` 标成死的，
 *    所有远程会话都会把它排到最后 —— 而"远端能跑 Claude"恰恰是远程会话存在的理由。
 *
 * 这两条都不是理论问题：本机出口 IP 被地域过滤（Claude 全系不可用），远端同一个账号全都好，
 * 所以"按机器分"在这台机器上是每天都在发生的事。
 */
describe('模型可用性按机器分', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const C = fs.readFileSync(path.join(process.cwd(), 'src/main/config.ts'), 'utf8');

  test('已知跑不了的模型按机器记，不是一个全局 Set', () => {
    assert.match(M, /const modelsKnownDeadBy = new Map<string, Set<string>>\(\)/);
    assert.match(M, /function deadModelsFor\(machine: string\): Set<string>/);
    assert.match(M, /const modelsKnownDead = deadModelsFor\(machine\)/);
    /* 降级成功那一处也要记到**那台**机器名下 */
    assert.match(M, /deadModelsFor\(machineKeyOf\(entry\.profile\)\)\.add\(failedModel\)/);
    /* 不许再有全局的那个 */
    assert.equal(/const modelsKnownDead = new Set<string>\(\)/.test(M), false);
  });

  test('机器 key：本地是 `local`，远程是 sshHost', () => {
    assert.match(M, /function machineKeyOf\(profile: \{ remote\?: \{ sshHost\?: string \} \}\): string \{\s*\n\s*return profile\.remote\?\.sshHost \|\| 'local';/);
  });

  test('"挣来的模型"记机器；机器不对就不采信，回到偏好', () => {
    assert.match(C, /modelEarnedOn\?: string;/);
    assert.match(M, /const earnedHere = !!profile\.modelEarnedOn && profile\.modelEarnedOn === machine;/);
    assert.match(M, /const earned = earnedHere \? profile\.model : undefined;/);
    assert.match(M, /\[profile\.preferredModel, earned, \.\.\.MODEL_FALLBACK_ORDER\]/);
  });

  test('老记录（没有这个字段）也不采信 —— 否则 bug 在既有会话上继续活着', () => {
    /* 这次批量切的 26 条全是这种：在本机被降级过，而字段是这一版才加的 */
    assert.match(M, /没有这个字段的老记录也不采信/);
    assert.match(M, /不采信它，回到偏好模型/);
  });

  test('不写记录也要把真实模型告诉界面 —— 被看见的就是那一格', () => {
    /* 执行器跑 claude-opus-5、下拉显示记录里的 deepseek-3.2 —— 人会照着下拉判断，
       然后基于错的前提做决定（"原来远端也没有 Claude"）。 */
    const at = M.indexOf('跑在偏好模型');
    assert.ok(at > 0);
    assert.match(M.slice(at, at + 700), /emitSessionModel\(sessionId, profile\.model\);/);
  });

  test('三个写入点都盖上机器：降级、attach 持久化、手动切换', () => {
    assert.match(M, /preferredModel: undefined, modelEarnedOn: machineKeyOf\(entry\.profile\)/);
    assert.match(M, /rec\.profile\.modelEarnedOn = machineKeyOf\(profile\);/);
    assert.match(M, /modelEarnedOn: machineKeyOf\(oldEntry\.profile\)/);
    /* attach 构造 profile 时要带着走，否则每次 attach 都当成"没记" */
    assert.match(M, /modelEarnedOn: existing\?\.profile\.modelEarnedOn,/);
  });
});

/*
 * **远程会话的启动候选要按那台机器的清单来** —— 审查意见：远程启动仍用 preferredModel、earned 和
 * 本机 MODEL_FALLBACK_ORDER 拼候选；`pickRemoteModel` 挑出来的 `profile.model` 没有 `modelEarnedOn`
 * 就被丢掉，而远端清单里没有的偏好模型排第一。`connect()` 对它照样成功，kiro-cli 随后静默退回默认模型，
 * 会话里那句"改用 X"成了假话。
 */
describe('远程会话的模型回退按那台机器的清单', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const ORDER = ['gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-3.2'];
  const TOKYO = 'ec2-user@tokyo';

  test('第一个该试的：偏好 > 在这台机器上挣来的 > 兜底链第一个；别的机器挣来的不算', () => {
    assert.equal(firstWantedModel({ model: 'deepseek-3.2', preferredModel: 'claude-opus-5', modelEarnedOn: TOKYO }, TOKYO, ORDER), 'claude-opus-5');
    assert.equal(firstWantedModel({ model: 'deepseek-3.2', modelEarnedOn: TOKYO }, TOKYO, ORDER), 'deepseek-3.2');
    /* 本机降级挣来的 deepseek 到了东京不算数 —— 这正是 26 条会话那次的 bug */
    assert.equal(firstWantedModel({ model: 'deepseek-3.2', modelEarnedOn: 'local' }, TOKYO, ORDER), 'gpt-5.6-sol');
    assert.equal(firstWantedModel({ model: 'deepseek-3.2' }, TOKYO, ORDER), 'gpt-5.6-sol');
  });

  test('远端挑不到想要的：兜底链里远端有的 > 清单里第一个非 auto > auto', () => {
    assert.equal(remoteFallbackModel(['auto', 'deepseek-3.2', 'gpt-5.6-terra'], ORDER), 'gpt-5.6-terra');
    assert.equal(remoteFallbackModel(['auto', 'glm-5'], ORDER), 'glm-5');
    assert.equal(remoteFallbackModel(['auto'], ORDER), 'auto');
  });

  test('候选只留远端有的，顺序不变；挑出来的那个排第一', () => {
    const remote = ['auto', 'claude-opus-5.5', 'gpt-5.6-terra', 'deepseek-3.2'];
    /* 偏好 claude-opus-5 远端没有 → pickRemoteModel 挑了 gpt-5.6-terra；它必须排第一，opus-5 和 sol 不许出现 */
    assert.deepEqual(
      remoteStartCandidates(['gpt-5.6-terra', 'claude-opus-5', ...ORDER], remote, ORDER),
      ['gpt-5.6-terra', 'deepseek-3.2'],
    );
    /* 偏好远端有 → 它第一 */
    assert.deepEqual(
      remoteStartCandidates(['claude-opus-5.5', 'claude-opus-5.5', ...ORDER], remote, ORDER),
      ['claude-opus-5.5', 'gpt-5.6-terra', 'deepseek-3.2'],
    );
  });

  test('过滤完一个不剩：补上远端真有的那个，绝不交出远端没有的模型', () => {
    const remote = ['auto', 'glm-5'];
    const out = remoteStartCandidates(['claude-opus-5', ...ORDER], remote, ORDER);
    assert.deepEqual(out, ['glm-5']);
    for (const m of out) assert.ok(remote.includes(m), `${m} 不在远端清单里`);
  });

  test('清单为空（没探到）= 没依据：原样（去重）返回，不删任何东西', () => {
    assert.deepEqual(
      remoteStartCandidates(['claude-opus-5', 'claude-opus-5', ...ORDER, ''], [], ORDER),
      ['claude-opus-5', ...ORDER],
    );
  });

  test('接线：connectWithModelFallback 远程时把挑出来的排第一并按远端清单过滤', () => {
    assert.match(M, /remoteStartCandidates\(\[profile\.model, \.\.\.base\], remoteModels \|\| \[\], MODEL_FALLBACK_ORDER\)/);
    assert.match(M, /const remotePicked = !!profile\.remote\?\.sshHost && !!remoteModels;/);
  });

  test('接线：每条经 connectWithModelFallback 起远程 kiro 的路都把远端清单传进去', () => {
    /* 换「组合」那一条只给 Claude Code / Codex（不走 kiro 的模型清单）：单独核对它前面拦了 kiro */
    const all = M.match(/await connectWithModelFallback\([^;]*\);/g) || [];
    const calls = all.filter((c) => !c.includes("'switch-mcp-combo'"));
    assert.equal(all.length - calls.length, 1);
    const combo = M.slice(M.indexOf("ipcMain.handle('acp:switch-mcp-combo'"), M.indexOf("'switch-mcp-combo', localTools"));
    assert.match(combo, /if \(engineOf\(oldEntry\.profile\) === 'kiro'\) throw/);
    assert.equal(calls.length, 3, '新建 / 换引擎 / attach');
    for (const c of calls) assert.match(c, /, remoteModels\);$/, `没传远端清单：${c}`);
  });

  test('接线：pickRemoteModel 验的是"第一个该试的"，不是记录里可能是别的机器挣来的 model', () => {
    const picks = M.match(/= pickRemoteModel\([^;]*\);/g) || [];
    assert.equal(picks.length, 4, '新建 / 换机器 / 换引擎 / attach');
    for (const p of picks) assert.match(p, /firstWantedModel\(profile, machineKeyOf\(profile\), MODEL_FALLBACK_ORDER\)/);
  });
});
