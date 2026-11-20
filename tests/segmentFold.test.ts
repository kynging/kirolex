/**
 * 工具 / 思考段「运行中也能折叠」（src/renderer/segmentFold.ts）。
 * running × fold 开关 × 用户点过没有 的组合。
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { panelFoldState, pickCurrent, previewLines, segmentFoldState, showsRunningIndicator, toggleSegmentFold } from '../src/renderer/segmentFold.ts';

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

// 2026-11-20 第 3 轮：回复下面的「⚡ 执行的命令」面板跟随 autoFoldTools；折叠态显示「正在运行的那一个」
describe('panelFoldState（CommandsPanel / ToolsPanel）', () => {
  test('autoFoldTools 开：运行中 / 结束都折叠', () => {
    assert.equal(panelFoldState(true, true).open, false);
    assert.equal(panelFoldState(true, false).open, false);
  });
  test('autoFoldTools 关：运行中展开（旧行为），结束折叠', () => {
    assert.equal(panelFoldState(false, true).open, true);
    assert.equal(panelFoldState(false, false).open, false);
  });
  test('开 + 运行中点开 → 展开；这一轮结束后点击作废 → 折叠', () => {
    const pin = toggleSegmentFold(panelFoldState(true, true));
    assert.equal(panelFoldState(true, true, pin).open, true);
    assert.equal(panelFoldState(true, false, pin).open, false);
  });
  test('关 + 运行中点收起 → 折叠；结束后照旧折叠', () => {
    const pin = toggleSegmentFold(panelFoldState(false, true));
    assert.equal(panelFoldState(false, true, pin).open, false);
    assert.equal(panelFoldState(false, false, pin).open, false);
  });
  test('结束后点开 → 一直展开（开 / 关都一样）', () => {
    for (const fold of [true, false]) {
      const pin = toggleSegmentFold(panelFoldState(fold, false));
      assert.equal(panelFoldState(fold, false, pin).open, true);
    }
  });
});

describe('pickCurrent', () => {
  const run = (s: string) => s.startsWith('run');
  test('多条里选最后一个运行中的；已完成数 = 不在运行的条数', () => {
    assert.deepEqual(pickCurrent(['done1', 'run1', 'done2', 'run2', 'done3'], run), { current: 'run2', running: true, done: 3 });
  });
  test('3 条命令，第 3 条在跑 → 第 3 条，已完成 2 条', () => {
    assert.deepEqual(pickCurrent(['a', 'b', 'run-c'], run), { current: 'run-c', running: true, done: 2 });
  });
  test('没有运行中的 → 最后一个', () => {
    assert.deepEqual(pickCurrent(['a', 'b', 'c'], run), { current: 'c', running: false, done: 3 });
  });
  test('空列表', () => {
    assert.deepEqual(pickCurrent([], run), { current: undefined, running: false, done: 0 });
  });
});

describe('previewLines', () => {
  test('不超过 5 行：全显示，没有 +N', () => {
    assert.deepEqual(previewLines('a\nb\nc'), { lines: ['a', 'b', 'c'], more: 0 });
    assert.deepEqual(previewLines('1\n2\n3\n4\n5'), { lines: ['1', '2', '3', '4', '5'], more: 0 });
  });
  test('超过 5 行：前 5 行 + 剩下的行数', () => {
    assert.deepEqual(previewLines('1\n2\n3\n4\n5\n6\n7\n8'), { lines: ['1', '2', '3', '4', '5'], more: 3 });
  });
  test('首尾空行不算，\r\n 也认', () => {
    assert.deepEqual(previewLines('\n\n  cmd one\r\ncmd two\n\n'), { lines: ['  cmd one', 'cmd two'], more: 0 });
  });
  test('空文本', () => {
    assert.deepEqual(previewLines(''), { lines: [], more: 0 });
  });
  test('上限可调', () => {
    assert.deepEqual(previewLines('1\n2\n3', 2), { lines: ['1', '2'], more: 1 });
  });
});
