import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { queuedBatch, joinQueuedBatch, QUEUE_MERGE_MAX_ITEMS } from '../src/renderer/queueBatch.ts';

/**
 * 「合并排队消息」（`settings.mergeQueuedMessages`）**只在发送时**生效。
 *
 * 实测：设置关着，排队消息还是「都合并到第一条 queue 中了」—— 忙时 Enter 有条规则「队列非空 → 并进最后一张卡片」，
 * 它不看这个设置。现在：入队永远新建一张卡片；关着时一张一张发，开着时才把队首若干张合并成一条发。
 */

type Item = { id: string; content: string; afterRebuild?: boolean };
const card = (n: number): Item => ({ id: `q${n}`, content: `第 ${n} 条` });

/** 模拟排空：每次发出一批，直到队列空 —— 返回每次发出去的那几张卡片的 id。 */
function drainAll(queue: Item[], merge: boolean): string[][] {
  const sent: string[][] = [];
  let rest = queue;
  while (rest.length) {
    const batch = queuedBatch(rest, merge && !rest[0].afterRebuild);
    sent.push(batch.map((i) => i.id));
    const ids = new Set(batch.map((i) => i.id));
    rest = rest.filter((i) => !ids.has(i.id));
  }
  return sent;
}

describe('发送时：设置决定合不合并', () => {
  const three = [card(1), card(2), card(3)];

  test('关着：3 张卡片 → 逐条发出，3 次', () => {
    assert.deepEqual(drainAll(three, false), [['q1'], ['q2'], ['q3']]);
  });

  test('开着：3 张卡片 → 合并成一条，1 次', () => {
    assert.deepEqual(drainAll(three, true), [['q1', 'q2', 'q3']]);
    const text = joinQueuedBatch(three, (n) => `[合并 ${n} 条]`);
    assert.equal(text, '[合并 3 条]\n\n第 1 条\n\n第 2 条\n\n第 3 条');
  });

  test('开着也有上限：一批最多 QUEUE_MERGE_MAX_ITEMS 张，剩下的下一轮再发', () => {
    const many = Array.from({ length: QUEUE_MERGE_MAX_ITEMS + 2 }, (_, i) => card(i + 1));
    const sent = drainAll(many, true);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].length, QUEUE_MERGE_MAX_ITEMS);
    assert.equal(sent[1].length, 2);
  });

  test('单条不加合并标题；空内容不产生空段落', () => {
    assert.equal(joinQueuedBatch([card(1)], () => 'X'), '第 1 条');
    assert.equal(joinQueuedBatch([card(1), { id: 'e', content: '  ' }], () => 'X'), '第 1 条');
    assert.equal(joinQueuedBatch([], () => 'X'), '');
  });

  test('不改原数组', () => {
    const q = [card(1), card(2)];
    queuedBatch(q, true);
    assert.equal(q.length, 2);
  });
});

/* ── 接线：App.tsx 的排空用这个纯函数；所有入队入口都是「新建一张卡片」 ── */
const APP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
const CODE = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function fnBody(name: string): string {
  const at = CODE.indexOf(`const ${name} = useCallback`);
  assert.ok(at > 0, `${name} 必须存在`);
  const rest = CODE.slice(at);
  return rest.slice(0, rest.indexOf('\n  }, ['));
}

describe('接线', () => {
  test('排空按设置取批次，设置只在这里被读', () => {
    assert.match(CODE, /const consumed = queuedBatch\(queue, settings\.mergeQueuedMessages && !queue\[0\]\.afterRebuild\);/);
    assert.match(CODE, /joinQueuedBatch\(consumed,/);
    // 入队那几处都不看这个设置：设置只用于发送
    const reads = CODE.match(/settings\.mergeQueuedMessages/g) || [];
    for (const name of ['handleQueueMessage', 'handleSteerMessage', 'handleFailedSteer', 'handleSendMessage']) {
      assert.doesNotMatch(fnBody(name), /mergeQueuedMessages/, `${name} 入队时不能看合并设置`);
    }
    assert.ok(reads.length >= 1);
  });

  test('⌘/Ctrl+Enter：追加一张新卡片', () => {
    assert.match(fnBody('handleQueueMessage'), /\[sessionId\]: \[\.\.\.\(prev\[sessionId\] \|\| \[\]\), item\]/);
  });

  test('steer 失败选「作为下一条发送」：插入一张新卡片', () => {
    assert.match(fnBody('handleFailedSteer'), /\[sid\]: \[\.\.\.queue\.slice\(0, at\), item, \.\.\.queue\.slice\(at\)\]/);
  });

  test('重建历史期间（Enter / 普通发送）：新建 afterRebuild 卡片 / 走 handleQueueMessage', () => {
    assert.match(fnBody('handleSteerMessage'), /withAfterRebuild\(prev\[sessionId\] \|\| \[\], \{\s*id: parkedId,/);
    // 新建的卡片（控制入口来的 id 带标记）
    assert.match(fnBody('handleSteerMessage'), /const parkedId = ctl \? controlMessageId\('queue'\) : `queue_/);
    assert.match(fnBody('handleSendMessage'), /queueMessageRef\.current\?\.\(text, pastes, sid\)/);
  });

  test('任何入队入口都不改已有卡片的内容（只有「编辑卡片」可以）', () => {
    // 已有卡片被改内容的写法只有 `{ ...item, content: ... }` 一种；它只能出现在编辑卡片里。
    const edits = CODE.match(/\{ \.\.\.(item|last|tail|candidate|q), content:/g) || [];
    assert.equal(edits.length, 1, '只有 handleEditQueuedMessage 能改已有卡片的内容');
    assert.match(fnBody('handleEditQueuedMessage'), /\{ \.\.\.item, content: content\.trim\(\) \}/);
  });
});
