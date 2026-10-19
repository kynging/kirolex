import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  pickAnchor, snapshotPosition, planRestore, anchorScrollTop, ScrollMemory, PaneScroll, restoreGate,
} from '../src/renderer/scrollMemory.ts';

describe('切会话回到上次位置：锚点计算', () => {
  test('取视口顶部第一条可见的组，偏移是它顶边相对视口顶部（部分滚出上方为负）', () => {
    const items = [
      { id: 'a', top: -500, bottom: -100 }, // 完全在上方
      { id: 'b', top: -40, bottom: 200 },   // 跨视口顶部
      { id: 'c', top: 200, bottom: 400 },
    ];
    assert.deepEqual(pickAnchor(items), { anchorId: 'b', offset: -40 });
  });

  test('贴底只记贴底，不记锚点', () => {
    assert.deepEqual(snapshotPosition(true, [{ id: 'a', top: 0, bottom: 10 }], 240), { stick: true });
  });

  test('不贴底记锚点 + 已加载的组数', () => {
    assert.deepEqual(
      snapshotPosition(false, [{ id: 'a', top: -5, bottom: 80 }], 240),
      { stick: false, anchorId: 'a', offset: -5, loadedGroups: 240 },
    );
  });

  test('量不到锚点（空会话）按贴底记', () => {
    assert.deepEqual(snapshotPosition(false, [], 120), { stick: true });
  });
});

describe('切会话回到上次位置：恢复', () => {
  const ids = Array.from({ length: 300 }, (_, i) => `m${i}`);

  test('没记过 / 贴底 → 到底部', () => {
    assert.deepEqual(planRestore(undefined, ids, 120), { kind: 'bottom' });
    assert.deepEqual(planRestore({ stick: true }, ids, 120), { kind: 'bottom' });
  });

  test('锚点消息找不到（被删 / 记录重写）→ 退回到底部', () => {
    assert.deepEqual(
      planRestore({ stick: false, anchorId: 'gone', offset: 0, loadedGroups: 240 }, ids, 120),
      { kind: 'bottom' },
    );
  });

  test('记录还在加载 → 等；加载完是空记录 → 不再等，退回到底部', () => {
    const memo = { stick: false as const, anchorId: 'm100', offset: 12, loadedGroups: 240 };
    assert.equal(restoreGate(true), 'wait');
    assert.equal(restoreGate(false), 'go');
    assert.deepEqual(planRestore(memo, [], 120), { kind: 'bottom' });
  });

  test('先恢复已加载的组数', () => {
    const p = planRestore({ stick: false, anchorId: 'm100', offset: 12, loadedGroups: 240 }, ids, 120);
    assert.deepEqual(p, { kind: 'anchor', anchorId: 'm100', offset: 12, renderLimit: 240 });
  });

  test('期间来了新消息：窗口至少挂到锚点那一组', () => {
    // 锚点在第 10 组，共 300 组 → 至少挂 290 组，原来记的 240 不够
    const p = planRestore({ stick: false, anchorId: 'm10', offset: 0, loadedGroups: 240 }, ids, 120);
    assert.equal(p.kind === 'anchor' && p.renderLimit, 290);
  });

  test('scrollTop 让锚点回到原偏移；不小于 0', () => {
    // 锚点现在在视口顶部下方 300px，原来在 -40 → 要再往下滚 340
    assert.equal(anchorScrollTop(1000, 300, -40), 1340);
    assert.equal(anchorScrollTop(0, 10, 50), 0);
  });
});

describe('切会话回到上次位置：按会话存', () => {
  test('超过上限丢最久没更新的', () => {
    const m = new ScrollMemory(2);
    m.set('a', { stick: true });
    m.set('b', { stick: true });
    m.set('a', { stick: true }); // a 变成最新
    m.set('c', { stick: true });
    assert.equal(m.get('b'), undefined);
    assert.ok(m.get('a') && m.get('c'));
  });

  test('序列化往返只含位置；坏数据丢掉不报错', () => {
    const m = new ScrollMemory();
    m.set('s1', { stick: false, anchorId: 'x', offset: -3, loadedGroups: 240 });
    m.set('s2', { stick: true });
    const back = ScrollMemory.fromJSON(JSON.stringify(m.toJSON()));
    assert.deepEqual(back.get('s1'), { stick: false, anchorId: 'x', offset: -3, loadedGroups: 240 });
    assert.deepEqual(back.get('s2'), { stick: true });
    assert.equal(ScrollMemory.fromJSON('{not json').get('s1'), undefined);
    const junk = ScrollMemory.fromJSON(JSON.stringify({ a: 1, b: { stick: false, anchorId: 5 } }));
    assert.equal(junk.get('a'), undefined);
    assert.equal(junk.get('b'), undefined);
  });
});

describe('切会话回到上次位置：分屏同一会话开在两格', () => {
  test('以最后离开的那一格为准，不是最后滚动的那一格', () => {
    const mem = new ScrollMemory();
    const right = new PaneScroll();
    const left = new PaneScroll();
    const at = (anchorId: string) => ({ stick: false as const, anchorId, offset: 0, loadedGroups: 240 });
    right.record('A', at('q7'));   // 右格先滚到第 7 问
    left.record('A', at('q20'));   // 左格后滚到第 20 问
    assert.equal(mem.get('A'), undefined, '滚动时不写共享记录');
    left.commit(mem);              // 先切走左格
    right.commit(mem);             // 再切走右格
    assert.deepEqual(mem.get('A'), at('q7'));
  });

  test('提交一次就清空；作废的快照不提交', () => {
    const mem = new ScrollMemory();
    const p = new PaneScroll();
    p.record('A', { stick: true });
    p.commit(mem);
    mem.delete('A');
    p.commit(mem);
    assert.equal(mem.get('A'), undefined);
    p.record('A', { stick: true });
    assert.deepEqual(p.peek(), { sid: 'A', memo: { stick: true } }, '落盘时能叠上还没提交的快照');
    p.clear();
    assert.equal(p.peek(), null);
    p.commit(mem);
    assert.equal(mem.get('A'), undefined);
  });
});

describe('ChatArea 接线', () => {
  test('滚动时只记在这一格；离开 / 卸载 / 刷新前才提交', () => {
    const scroll = src.slice(src.indexOf('onScroll={(e) => {'), src.indexOf('onScroll={(e) => {') + 1200);
    assert.ok(!scroll.includes('rememberScroll('), 'onScroll 里不能直接写共享记录');
    assert.ok(src.includes('paneScrollRef.current.commit(scrollMemory)'));
    assert.ok(src.includes('livePanes'));
  });

  test('空记录不会让恢复一直等下去（只在加载中等待）', () => {
    assert.ok(!src.includes('historyLoading || renderGroups.length === 0'));
    assert.ok(src.includes("restoreGate(historyLoading) === 'wait'"));
  });
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf8');
  test('切会话不再一律到底，而是按记下的位置恢复', () => {
    assert.ok(!src.includes('Switching chats always starts at the bottom'));
    assert.ok(src.includes('planRestore('));
    assert.ok(src.includes('data-anchor-id'));
  });
});
