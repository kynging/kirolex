import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enrichModels, mergeMeta, readMetaCache, writeMetaCache, FALLBACK_META } from '../src/main/modelMeta.ts';

/*
 * 「这个远程会话为什么又看不到模型乘数了」。
 *
 * 远程会话的模型清单来自**那台机器**，而 kiro-cli 1.27.0 只给得出一串 id（它没有 `--list-models`，
 * 探测法只能从参数校验的报错里抠名字）。名字/倍率/上下文窗口一直是**按 id 从本机那份补的** ——
 * 机器决定"有哪些模型"，而"倍率 2.2"是模型自己的属性。
 *
 * 这个补齐在本机清单里有 Claude 时一直成立。地域过滤之后不成立了：本机 `--list-models` 里一个
 * Claude 都没有，`claude-opus-5` 补不到任何东西，`· 2.2x` 就消失了。
 *
 * 修法是三层、**实时的永远赢**：实时清单 → 持久缓存 → 内置快照。
 * 快照里的数字不是编的 —— 是这台机器还能列 Claude 时抓到的真实清单（2026-09）。
 */
describe('模型元数据的三层兜底', () => {
  test('实时 > 缓存 > 内置快照 > 只有 id', () => {
    const live = { 'gpt-5.6-sol': { rate_multiplier: 4.4, model_name: 'Sol' } };
    const cache = { 'claude-sonnet-5': { rate_multiplier: 9.9, seenAt: 1 } };
    const out = enrichModels(['gpt-5.6-sol', 'claude-sonnet-5', 'claude-opus-5', 'brand-new'], live, cache);
    assert.deepEqual(out.map((m) => m.metaFrom), ['live', 'cache', 'fallback', 'none']);
    assert.equal(out[0].rate_multiplier, 4.4);
    /* 缓存赢过内置快照：它更可能是这个账号/这台机器上真见过的 */
    assert.equal(out[1].rate_multiplier, 9.9);
    assert.equal(out[2].rate_multiplier, FALLBACK_META['claude-opus-5'].rate_multiplier);
    /* 补不到就只有 id —— 不编一个数字出来 */
    assert.equal(out[3].rate_multiplier, undefined);
    assert.equal(out[3].model_name, 'brand-new');
  });

  test('内置快照覆盖的正是"实时拿不到"的那些', () => {
    /* Claude 系列 + auto。gpt/deepseek/minimax 本机现在还在报，写死它们只会多一份会过期的副本 */
    assert.ok(FALLBACK_META['claude-opus-5']);
    assert.ok(FALLBACK_META['auto']);
    assert.equal(FALLBACK_META['gpt-5.6-sol'], undefined);
    assert.equal(FALLBACK_META['deepseek-3.2'], undefined);
  });

  test('倍率是实测过的那一份，不是我编的', () => {
    /* 来源：本机还能列 Claude 时抓到的清单（`ui-state.json.bak-opus5` 里存着的 19 条） */
    assert.equal(FALLBACK_META['claude-opus-5'].rate_multiplier, 2.2);
    assert.equal(FALLBACK_META['claude-sonnet-5'].rate_multiplier, 1.3);
    assert.equal(FALLBACK_META['claude-haiku-4.5'].rate_multiplier, 0.4);
    assert.equal(FALLBACK_META['auto'].rate_multiplier, 1);
    /* 上下文窗口也一起：4.5 那一代是 200k，5 那一代是 1M */
    assert.equal(FALLBACK_META['claude-opus-5'].context_window_tokens, 1_000_000);
    assert.equal(FALLBACK_META['claude-sonnet-4.5'].context_window_tokens, 200_000);
  });

  test('只收带真实数字的条目进缓存', () => {
    const cache: any = {};
    /* 把 `{model_id}` 记进缓存 = 把"没信息"固化成"信息是空的"，之后连兜底表都会被它盖掉 */
    assert.equal(mergeMeta(cache, [{ model_id: 'claude-opus-5' }]), false);
    assert.deepEqual(cache, {});
    assert.equal(mergeMeta(cache, [{ model_id: 'x', rate_multiplier: 1.5 }]), true);
    assert.equal(cache.x.rate_multiplier, 1.5);
    /* 没变化就不该报 changed（省掉一次写盘） */
    assert.equal(mergeMeta(cache, [{ model_id: 'x', rate_multiplier: 1.5 }]), false);
    /* 变了要更新 */
    assert.equal(mergeMeta(cache, [{ model_id: 'x', rate_multiplier: 2 }]), true);
    assert.equal(cache.x.rate_multiplier, 2);
  });

  test('缓存文件坏了当空 —— 元数据缺失不该拦住列模型', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kx-meta-')), 'model-meta.json');
    assert.deepEqual(readMetaCache(f), {});
    fs.writeFileSync(f, '{ broken');
    assert.deepEqual(readMetaCache(f), {});
    writeMetaCache(f, { a: { rate_multiplier: 1, seenAt: 2 } });
    assert.equal(readMetaCache(f).a.rate_multiplier, 1);
  });

  test('接线：远程那条路用三层，并顺手把实时数据记进缓存', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /return \{ models: enrichModels\(ids, live, cache\) \};/);
    assert.match(M, /if \(mergeMeta\(cache, localList\)\) writeMetaCache\(MODEL_META_PATH, cache\);/);
  });

  test('界面要说清非实时的数字是哪来的（快照会过期）', () => {
    const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
    assert.match(CA, /metaFrom/);
    assert.match(CA, /不是这台机器这一刻报的/);
  });
});

/*
 * 「为什么远程会话又退回到 deepseek 了」——**记录里那个模型是在另一台机器上挣来的**。
 *
 * 那条会话的记录是 `deepseek-3.2`（在本机被降级挣来的），切到远端之后执行器真的跑在
 * `claude-opus-5` 上，但 attach 那一支拒绝写记录（"连上了什么都不证明"）——
 * 于是记录永远和现实不一致，而每一次从磁盘 hydrate 都会把界面和"下次 attach 用哪个模型"
 * 重新拉回 deepseek（`useAcp` 里 `sessionModelRef.current.set(rec.id, rec.model)`）。
 *
 * 原来那条守卫保护的是**这台机器上真跑成一轮挣来的**模型 —— 那是对的。而另一台机器挣来的
 * 对这台机器没有证明力，替换它不叫"盖掉事实"。
 */
describe('别让另一台机器挣来的模型一直复活', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('记录里那个不是本机挣的 → 照样写进去', () => {
    assert.match(M, /const earnedOnThisMachine = \(rec\.profile as any\)\.modelEarnedOn === machineKeyOf\(profile\);/);
    assert.match(M, /if \(rec\.profile\.model !== profile\.model && \(!preferenceWonAhead \|\| !earnedOnThisMachine\)\)/);
  });

  test('日志要说清为什么这次写了（否则下次有人会把这条守卫改回去）', () => {
    assert.match(M, /旧值不是在 \$\{machineKeyOf\(profile\)\} 上挣来的/);
    assert.match(M, /每次 hydrate 都会把界面拉回去/);
  });
});
