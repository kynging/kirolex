/**
 * 工具 / 思考段「运行中也能折叠」（src/renderer/segmentFold.ts）。
 * running × fold 开关 × 用户点过没有 的组合。
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { segmentFoldState, showsRunningIndicator, toggleSegmentFold } from '../src/renderer/segmentFold.ts';

const base = { kind: 'tool' as const, collapsible: true, fold: true, streamThis: false, running: false };

describe('segmentFoldState', () => {
  test('非工具/思考段：永远展开，不画折叠按钮', () => {
    assert.deepEqual(segmentFoldState({ ...base, collapsible: false }), { open: true, live: false });
    assert.deepEqual(segmentFoldState({ ...base, collapsible: false, running: true, streamThis: true }), { open: true, live: true });
  });
  test('自动折叠开 + 正在流式的这一段：默认折叠，但标记为运行中', () => {
    assert.deepEqual(segmentFoldState({ ...base, running: true, streamThis: true }), { open: false, live: true });
  });
  test('自动折叠开 + 运行中这一轮里已跑完的前面段：折叠，不算运行中', () => {
    assert.deepEqual(segmentFoldState({ ...base, running: true, streamThis: false }), { open: false, live: false });
  });
  test('自动折叠关 + 运行中：默认展开（旧行为）', () => {
    assert.deepEqual(segmentFoldState({ ...base, fold: false, running: true, streamThis: true }), { open: true, live: true });
    assert.deepEqual(segmentFoldState({ ...base, fold: false, running: true, streamThis: false }), { open: true, live: true });
  });
  test('跑完（不论开关）：默认折叠', () => {
    assert.deepEqual(segmentFoldState({ ...base, fold: true }), { open: false, live: false });
    assert.deepEqual(segmentFoldState({ ...base, fold: false }), { open: false, live: false });
  });
  test('运行中点开 → 展开；跑完后这次点击失效，又折回去（跑完即折）', () => {
    const s = { ...base, running: true, streamThis: true };
    const ov = toggleSegmentFold(segmentFoldState(s));
    assert.deepEqual(ov, { open: true, live: true });
    assert.equal(segmentFoldState(s, ov).open, true);
    assert.equal(segmentFoldState({ ...base }, ov).open, false);
  });
  test('自动折叠关 + 运行中点收起 → 折叠；跑完后照旧折叠', () => {
    const s = { ...base, fold: false, running: true, streamThis: true };
    const ov = toggleSegmentFold(segmentFoldState(s));
    assert.equal(segmentFoldState(s, ov).open, false);
    assert.equal(segmentFoldState({ ...base, fold: false }, ov).open, false);
  });
  test('跑完后点开的：一直展开，再点收起', () => {
    const ov = toggleSegmentFold(segmentFoldState(base));
    assert.equal(segmentFoldState(base, ov).open, true);
    const ov2 = toggleSegmentFold(segmentFoldState(base, ov));
    assert.equal(segmentFoldState(base, ov2).open, false);
  });
});

// 2026-11-20 新口径：思考段（💭）不跟工具段走 —— 默认一直展开、不显示运行中、用户的点击一直有效
const think = { kind: 'thinking' as const, collapsible: true, fold: false, streamThis: false, running: false };

describe('segmentFoldState · 思考段', () => {
  test('自动折叠思考关（默认）：运行中 / 正在流式时展开', () => {
    assert.equal(segmentFoldState({ ...think, running: true, streamThis: true }).open, true);
    assert.equal(segmentFoldState({ ...think, running: true }).open, true);
  });
  test('自动折叠思考关：跑完也保持展开', () => {
    assert.equal(segmentFoldState(think).open, true);
  });
  test('运行中被用户折叠 → 跑完仍折叠；再点开 → 展开', () => {
    const s = { ...think, running: true, streamThis: true };
    const ov = toggleSegmentFold(segmentFoldState(s));
    assert.equal(segmentFoldState(s, ov).open, false);
    assert.equal(segmentFoldState(think, ov).open, false);
    const ov2 = toggleSegmentFold(segmentFoldState(think, ov));
    assert.equal(segmentFoldState(think, ov2).open, true);
  });
  test('用户手动打开自动折叠思考：运行中展开，跑完折叠', () => {
    const on = { ...think, fold: true };
    assert.equal(segmentFoldState({ ...on, running: true, streamThis: true }).open, true);
    assert.equal(segmentFoldState({ ...on, running: true }).open, false);
    assert.equal(segmentFoldState(on).open, false);
  });
  test('自动折叠思考开：运行中被用户折叠 → 跑完仍折叠（点击不作废）', () => {
    const on = { ...think, fold: true, running: true, streamThis: true };
    const ov = toggleSegmentFold(segmentFoldState(on));
    assert.equal(segmentFoldState(on, ov).open, false);
    assert.equal(segmentFoldState({ ...think, fold: true }, ov).open, false);
  });
});

describe('showsRunningIndicator', () => {
  test('思考段永远不显示运行中', () => {
    assert.equal(showsRunningIndicator({ ...think, running: true, streamThis: true }), false);
    assert.equal(showsRunningIndicator({ ...think, fold: true, running: true, streamThis: true }), false);
  });
  test('工具段：只在正在流式的那段显示', () => {
    assert.equal(showsRunningIndicator({ ...base, running: true, streamThis: true }), true);
    assert.equal(showsRunningIndicator({ ...base, fold: false, running: true, streamThis: true }), true);
    assert.equal(showsRunningIndicator({ ...base, running: true }), false);
    assert.equal(showsRunningIndicator(base), false);
  });
});
