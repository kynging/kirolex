import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { shouldBumpMark } from '../src/renderer/reviewBlocks.ts';

/**
 * 提交行跟着「最新标的那一条」走（`markOrder`）。去重只为了同一个框里连续打字不每个字重渲染一轮 ——
 * 提交（`markOrder` 清空）或落盘挪行号（键换了）之后，同一个键再标一次必须重新记下来，
 * 不然「删掉第 282 行，下一段顶上来也是 282，再点 ✕」那一段下面就没有「✓ 确认」。
 */
describe('shouldBumpMark', () => {
  test('同一个键已经是最新的那条：不再动（连续打字不重渲染）', () => {
    assert.equal(shouldBumpMark({ '12': 3, 'drop:5': 2 }, '12', '12'), false);
  });

  test('第一次标：要记', () => {
    assert.equal(shouldBumpMark({}, '12', null), true);
  });

  test('换了一条：要记', () => {
    assert.equal(shouldBumpMark({ '12': 3 }, 'drop:5', '12'), true);
  });

  test('提交清空之后，同一个键再标：要重新记', () => {
    assert.equal(shouldBumpMark({}, 'drop:282', 'drop:282'), true);
    assert.equal(shouldBumpMark({}, '282', '282'), true);
    assert.equal(shouldBumpMark({}, '+282', '+282'), true);
  });

  test('键还在但已经不是最新（别处 bump 过、或挪行号后撞上）：要重新记', () => {
    assert.equal(shouldBumpMark({ '282': 1, 'drop:3': 4 }, '282', '282'), true);
  });
});
