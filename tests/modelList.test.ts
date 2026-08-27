import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { concreteModels, shouldReplaceModelCache } from '../src/renderer/modelList.ts';

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
