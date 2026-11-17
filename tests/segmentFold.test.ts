/**
 * 工具 / 思考段「运行中也能折叠」（src/renderer/segmentFold.ts）。
 * running × fold 开关 × 用户点过没有 的组合。
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { segmentFoldState, toggleSegmentFold } from '../src/renderer/segmentFold.ts';

const base = { collapsible: true, fold: true, streamThis: false, running: false };

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
