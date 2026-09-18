import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { concreteModels, shouldReplaceModelCache, lostModels, forcedModelReplace } from '../src/renderer/modelList.ts';
import fsSync from 'node:fs';
import pathSync from 'node:path';

/** 实测抓到的两份 payload：一份是断网期间的退化结果，一份是正常结果。 */
const DEGRADED = [{ model_name: 'auto', model_id: 'auto', context_window_tokens: 200_000 }];
const GOOD = [
  { model_name: 'auto', model_id: 'auto', context_window_tokens: 1_000_000 },
  { model_name: 'claude-opus-5', model_id: 'claude-opus-5', context_window_tokens: 1_000_000 },
  { model_name: 'claude-sonnet-5', model_id: 'claude-sonnet-5', context_window_tokens: 1_000_000 },
];

describe('哪些是"具体模型"', () => {
  test('auto 不算 —— 它是路由器而不是一个可选的模型', () => {
    assert.deepEqual(concreteModels(DEGRADED), []);
    assert.deepEqual(concreteModels(GOOD).map((m) => m.model_id), ['claude-opus-5', 'claude-sonnet-5']);
  });

  test('缺字段或空列表不会炸', () => {
    assert.deepEqual(concreteModels([]), []);
    assert.deepEqual(concreteModels([{}, { model_id: '' }] as any), []);
  });
});

describe('好缓存不许被更差的结果覆盖', () => {
  test('退化结果（只剩 auto）遇上有具体模型的缓存 —— 拒绝覆盖', () => {
    // 这就是那次真实故障：缓存被写成只有 auto，之后网恢复也回不来，因为缓存是唯一回退来源。
    assert.equal(shouldReplaceModelCache(DEGRADED, GOOD), false);
  });

  test('空列表永远不许覆盖 —— 宁可显示旧的，也不要显示"没有模型"', () => {
    assert.equal(shouldReplaceModelCache([], GOOD), false);
    assert.equal(shouldReplaceModelCache([], DEGRADED), false);
    assert.equal(shouldReplaceModelCache([], []), false);
  });

  test('正常结果覆盖退化缓存 —— 这是自愈的那一步', () => {
    assert.equal(shouldReplaceModelCache(GOOD, DEGRADED), true);
  });

  test('缓存本来是空的，任何非空结果都收下 —— 首次启动不能因为这条规则而没有模型', () => {
    assert.equal(shouldReplaceModelCache(DEGRADED, []), true);
    assert.equal(shouldReplaceModelCache(GOOD, []), true);
  });

  test('两份都有具体模型时收下新的 —— 模型上下线是常事，不能永远钉住旧列表', () => {
    const fewer = [{ model_id: 'claude-opus-5', model_name: 'claude-opus-5' }];
    assert.equal(shouldReplaceModelCache(fewer, GOOD), true);
  });
});

/**
 * 「有的时候 kiro 选不了 claude 模型」—— 少掉的模型要有个交代，而且要能手动重拉。
 *
 * `shouldReplaceModelCache` 只问"新的有没有具体模型"，所以一份有 3 个模型但缺了 claude 全家的结果
 * 会被当成可信而收下，claude 就无声无息地从选择器里消失。
 */
describe('少了哪些模型 / 强制重拉', () => {
  const m = (id: string) => ({ model_id: id, model_name: id });

  test('说出比缓存少了哪些具体模型', () => {
    assert.deepEqual(
      lostModels([m('auto'), m('gpt-5.6-sol')], [m('auto'), m('gpt-5.6-sol'), m('claude-opus-5')]),
      ['claude-opus-5'],
    );
  });

  test('auto 不算 —— 它任何时候都有，说明不了任何事', () => {
    assert.deepEqual(lostModels([m('auto')], [m('auto')]), []);
  });

  test('新的更全就没有丢的', () => {
    assert.deepEqual(lostModels([m('a'), m('b')], [m('a')]), []);
  });

  test('缺参数不炸', () => {
    assert.deepEqual(lostModels(null, null), []);
    assert.deepEqual(lostModels(undefined, [m('a')]), ['a']);
  });

  test('强制重拉只拒空列表 —— 手点的时候你要的是真实答案，包括"只剩 auto"', () => {
    assert.equal(forcedModelReplace([m('auto')]), true);
    assert.equal(forcedModelReplace([m('auto'), m('claude-opus-5')]), true);
    assert.equal(forcedModelReplace([]), false);
    assert.equal(forcedModelReplace(null), false);
  });

  test('自动重拉仍然保守 —— 这条规则不许被强制重拉带跑', () => {
    // 退化结果（只剩 auto）不该覆盖一份有具体模型的缓存，那是当初那次污染
    assert.equal(shouldReplaceModelCache([m('auto')], [m('auto'), m('claude-opus-5')]), false);
  });
});

/**
 * 接线：选不到模型时有两条出路，而且换没换成要说出来。
 *
 * 「有的时候 kiro 选不了 claude 模型，这种时候如果客户选 claude 是不会有效的」——
 * 在此之前这条路完全静默：选择器跳回另一个值，一个字都没有，看着像点了没反应。
 */
describe('接线：模型选不到时的两条出路', () => {
  const readSrc = (p: string) => fsSync.readFileSync(pathSync.join(process.cwd(), p), 'utf8');
  const APP = readSrc('src/renderer/App.tsx');
  const CHAT = readSrc('src/renderer/components/ChatArea.tsx');

  test('手点重拉走 forcedModelReplace，自动重拉仍走保守那条', () => {
    const fn = APP.slice(APP.indexOf('const refreshModels = useCallback'));
    const body = fn.slice(0, fn.indexOf('}, []);'));
    assert.match(body, /opts\?\.force \? forcedModelReplace\(next\) : shouldReplaceModelCache\(next, cached\)/);
    assert.match(body, /lostModels\(next, cached\)/, '少掉哪些模型要有个交代');
  });

  test('**那个手动 ↻ 删掉了** —— 打开下拉就自动重拉', () => {
    /*
      「模型选项右边那个刷新按钮怎么还在」/「这个应该让 kirolex 自动做，不能让用户手动」。

      它当初答的是一件真事（自动重拉走保守规则，一次真实的"claude 没了/回来了"会被挡掉），
      但那个洞该由重拉自己补 —— 而你恰恰判断不了要不要点它：你看到的正是那份可能过时的列表。
    */
    assert.doesNotMatch(CHAT, /composer-model-refresh/);
    assert.doesNotMatch(CHAT, />↻<\/button>/);
    /* 打开那个下拉就是重拉的时机：鼠标走 `onMouseDown`（`onClick` 在关掉之后才来，太晚），键盘走 `onFocus` */
    assert.match(CHAT, /onMouseDown=\{\(\) => onRefreshModels\?\.\(\)\}/);
    assert.match(CHAT, /onFocus=\{\(\) => onRefreshModels\?\.\(\)\}/);
    assert.match(APP, /onRefreshModels=\{forceModelsSoon\}/);
  });

  test('**节流** —— 一次 `--list-models` 要 spawn 一个 kiro-cli（实测 3.4 秒）', () => {
    /* `onFocus` 选完之后还会再来一次，鼠标党每次开合也是一次 —— 不节流就是几秒一个新进程 */
    const fn = APP.slice(APP.indexOf('const forceModelsSoon = useCallback'));
    const body = fn.slice(0, fn.indexOf('}, [refreshModels]);'));
    assert.match(body, /now - lastForceModelsRef\.current < 30_000/);
    assert.match(body, /refreshModels\(\{ force: true \}\)/);
  });

  test('**当前模型不在列表里就自己去问一次** —— 那是 ↻ 最典型的用途', () => {
    /* 原因有两种：真退役了，或者这份列表是旧的 —— 后者靠重拉就能修，不该等你发现有个按钮可点 */
    assert.match(APP, /if \(models\.some\(\(m: any\) => m\.model_id === selectedModel\)\) return;/);
    /* 按 id 记一次，不循环：真的没了的话重拉之后它照旧不在列表里 */
    assert.match(APP, /if \(askedForRef\.current === selectedModel\) return;/);
  });

  test('后端给的和你点的不一样时：说出来 + 顺手重拉', () => {
    const fn = APP.slice(APP.indexOf('const handleModelChange = useCallback'));
    const body = fn.slice(0, fn.indexOf('}, [currentSessionId'));
    assert.match(body, /if \(effective !== model\)/);
    assert.match(body, /noteSessionError\(sid,/, '不能静默 —— 那正是"点了没反应"');
    assert.match(body, /refreshModels\(\{ force: true \}\)/);
  });
});

/*
 * 「为什么现在新会话只能选 default agent 了」。
 *
 * 查下来是个不对称：模型列表拿不到时退回落盘缓存（`kirolex-models`），而 agent 列表只有一句
 * "保留上一次的（内存里那份）"—— 可**新挂载时没有"上一次"**（启动、窗口重载、开发时一次 HMR 都算）。
 * 于是那一次 `agent list` 超时（日志里 `timed out after 30000ms (killed)`；同一条命令在空闲 shell 里
 * 1.6 秒）就把下拉**永久**留在"只有 kiro_default"上 —— 永久，因为除了启动那次 warmup 没有东西会再拉。
 */
describe('agent 列表也要落盘，而且拉不到会重试', () => {
  const read = (p: string) => fsSync.readFileSync(pathSync.join(process.cwd(), p), 'utf8');
  const APP2 = read('src/renderer/App.tsx');
  const ML = read('src/renderer/modelList.ts');

  test('键和模型那份对称，摆在一起', () => {
    assert.match(ML, /export const AGENTS_CACHE_KEY = 'kirolex-agents';/);
    assert.match(APP2, /AGENTS_CACHE_KEY/);
  });

  test('**初值从缓存来** —— 那正是"新挂载没有上一次"这个洞', () => {
    assert.match(APP2, /const cached = JSON\.parse\(uiGet\(AGENTS_CACHE_KEY\) \|\| '\[\]'\);/);
    assert.match(APP2, /return Array\.isArray\(cached\) \? cached : \[\];/);
  });

  test('拿到就落盘；空列表一律不收（那是"拿不到"，不是"没有"）', () => {
    const fn = APP2.slice(APP2.indexOf('const refreshAgents = useCallback'));
    const body = fn.slice(0, fn.indexOf('}, []);'));
    assert.match(body, /if \(!data\?\.agents\?\.length\) return;/);
    assert.match(body, /uiSet\(AGENTS_CACHE_KEY, JSON\.stringify\(data\.agents\)\)/);
  });

  test('**空了才重试** —— 不无条件跟着 focus 拉（每次都要 spawn 一个 kiro-cli）', () => {
    const at = APP2.indexOf('if (kiroAgents.length) return;');
    assert.ok(at > 0, '有这道早退才叫"只在空的时候拉"');
    const body = APP2.slice(at, at + 500);
    assert.match(body, /window\.addEventListener\('focus', again\)/);
    assert.match(body, /void refreshAgents\(\)/);
  });

  test('warmup 那一处也走同一条路 —— 不再各写一遍', () => {
    assert.match(APP2, /void refreshAgents\(\);/);
    assert.doesNotMatch(APP2, /listKiroAgents\(\)\.then/);
  });
});

/*
 * 「现在还是不能切换到 claude，怎么回事」。
 *
 * 查下来是两件事叠在一起（日志实证）：
 *   ① 02:33 那一轮后端自己报了 `The model 'claude-opus-5' is not available`，KiroLex 换到
 *      `gpt-5.6-terra`、把 claude 记进 `modelsKnownDead`、清掉偏好 —— 三步都对；
 *   ② 之后手点回 claude，写进记录了，但下一次 attach 里 claude 因为在那份名单里被**排到最后**，
 *      而 `connect()` 对任何模型都会成功（kiro-cli 只在真跑一轮时才报退役）—— 于是第一个候选
 *      `gpt-5.6-terra` 直接赢：`persisting effective model 'gpt-5.6-terra' (was 'claude-opus-5',
 *      preferred 'claude-opus-5')`。
 *
 * 而后端此刻是有 claude-opus-5 的（查过，19 个模型全在）。那份名单是进程级的，只有重启才忘。
 */
describe('手点选一个模型 = 让它再试一次', () => {
  const read2 = (p: string) => fsSync.readFileSync(pathSync.join(process.cwd(), p), 'utf8');
  const MAIN3 = read2('src/main/index.ts');

  test('**手点就把它从"已证实跑不了"里划掉**', () => {
    /* 和"手点重拉模型列表走另一条规则"同一个判断：你手点的那一下就是"我知道它刚才不行，再试一次" */
    assert.match(MAIN3, /if \(modelsKnownDead\.delete\(wantModel\)\) \{/);
    /* 划掉这一步要在两条分支之前 —— 休眠的那条也算一次明确选择 */
    const at = MAIN3.indexOf('modelsKnownDead.delete(wantModel)');
    assert.ok(at > 0 && at < MAIN3.indexOf('if (!oldEntry) {', at));
  });

  test('降级要**说出原因**，而不是让选择器自己跳回去', () => {
    assert.match(MAIN3, /你选的 \$\{profile\.preferredModel\} 这次起不来/);
    /* 选择器照旧要跟着实际那个走 —— 两件事都要，少一件就会有一个在说谎 */
    assert.match(MAIN3, /emitSessionModel\(sessionId, profile\.model\);/);
  });

  test('同一个降级组合一次运行只说一遍 —— 模型真下线时每次 attach 都会走到这儿', () => {
    assert.match(MAIN3, /const downgradeSaid = new Set<string>\(\);/);
    assert.match(MAIN3, /!downgradeSaid\.has\(saidKey\)/);
    assert.match(MAIN3, /downgradeSaid\.add\(saidKey\);/);
  });
});

/*
 * 「现在连接 session 总会跳出 kiro 登录界面」→「我现在点到 new chat，没有自动重连」→
 * 「⚠️ …'acp:load-session': 该会话在磁盘上不存在（可能已被删除），不再重建。」
 *
 * 一条链：`kiro-cli whoami` 回 `Not logged in`（凭证过期）⇒ 新建会话时**每个候选模型都起不来**，
 * 而日志把它写成三行「model 'X' failed to start」—— 那会把人指向模型选择器，那儿什么都修不了。
 * 更糟的是渲染进程照旧把这条会话留在列表里并落盘（实测 `s_1789306053712_reob4h` 还成了 last-session），
 * 而主进程那侧记录从没写成 —— 于是之后每次 attach 都抛"磁盘上不存在"，那一条永远不走。
 */
describe('起不来的时候要说对原因，并且别留下幻影会话', () => {
  const read3 = (p: string) => fsSync.readFileSync(pathSync.join(process.cwd(), p), 'utf8');
  const MAIN4 = read3('src/main/index.ts');
  const ACP4 = read3('src/renderer/hooks/useAcp.ts');

  test('**每个候选都失败 = 不是模型的问题**，报错要这么说', () => {
    const at = MAIN4.indexOf('const looksAuth =');
    assert.ok(at > 0);
    const body = MAIN4.slice(at - 400, at + 900);
    assert.match(body, /not logged in\|no credentials\|login\|sso\|unauthor/i);
    assert.match(body, /kiro-cli 没有登录 —— 先在终端跑/);
    assert.match(body, /所以不是模型的问题/);
    /* 原始错误也带上 —— 认不出是认证问题时它是唯一线索 */
    assert.match(body, /原始错误：/);
  });

  test('幻影会话：主进程发现记录不存在时**反过来通知界面**摘掉它', () => {
    const at = MAIN4.indexOf("throw new Error('该会话在磁盘上不存在（可能已被删除），不再重建。');");
    assert.ok(at > 0);
    const before = MAIN4.slice(at - 700, at);
    assert.match(before, /send\('acp:sessions-purged', \{ sessionIds: \[sessionId\] \}\)/);
  });

  test('建不成的新对话当场从列表摘掉，并且**把错说出来**', () => {
    const at = ACP4.indexOf('const createPromise = (async ()');
    const body = ACP4.slice(at, at + 2200);
    assert.match(body, /forgetSessions\(\[id\]\);/);
    assert.match(body, /noteError\(null, err\?\.message \|\| '这条新对话没建起来'\);/);
    /* 原来这个 catch 只清了那个闪烁 —— 会话照旧留着并落盘 */
    assert.doesNotMatch(body, /\} catch \{\s*\n\s*clearConnecting\(id\);\s*\n\s*\} finally/);
  });
});

/*
 * 「在模型列表里面把价格乘数也加进去」。
 *
 * 后端本来就给（`rate_multiplier` + `rate_unit`，实测 opus-5 = 2.2、sonnet-5 = 1.3、auto = 1.0），
 * 只是选择器里一直没显示 —— 于是"换个模型"这件事的**代价**在做决定的地方看不见，而这是这一格里
 * 唯一会花钱的选择。
 */
describe('模型列表要显示价格乘数', () => {
  const read4 = (p: string) => fsSync.readFileSync(pathSync.join(process.cwd(), p), 'utf8');
  const CHAT5 = read4('src/renderer/components/ChatArea.tsx');

  test('option 上三样都有：名字 · 上下文 · 乘数', () => {
    const at = CHAT5.indexOf('{models.map((model) => (');
    const body = CHAT5.slice(at, at + 700);
    assert.match(body, /fmtContextWindow\(model\.context_window_tokens\)/);
    assert.match(body, /fmtRate\(\(model as any\)\.rate_multiplier\)/);
  });

  test('`1.0` 也要显示 —— 不显示分不出"一倍"和"没数据"', () => {
    const at = CHAT5.indexOf('function fmtRate(');
    const body = CHAT5.slice(at, at + 400);
    /* 只有拿不到（非数字/≤0）才留空 */
    assert.match(body, /if \(!Number\.isFinite\(n\) \|\| n <= 0\) return '';/);
    /* 整数不写小数点：那一行本来就窄 */
    assert.match(body, /Number\.isInteger\(n\) \? n : n\.toFixed\(1\)/);
  });
});
