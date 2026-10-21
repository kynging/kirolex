import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { queuedBatchMessageId, queueRetryDelay, QueueBackoff, isDuplicateMessageError, QUEUE_RETRY_MS, pickQueuedBatch, sealRetryBatch, unsealEdited, editQueuedItem, insertOptimistic, removeOptimistic } from '../src/renderer/queueRetry.ts';
import { isControlMessageId } from '../src/main/controlSessions.ts';
import { isUserTurnMessageId } from '../src/main/textToolRecovery.ts';

/*
  守的是两件事：
  1. 排队消息发失败、放回队头再发时**用同一个 messageId** —— 原来每次现生成 `user_<时间戳>`，
     主进程已经落过盘的那条认不出来，于是同一条消息在会话里一遍遍出现；
  2. 发失败之后**退避**，不是下一次渲染就立刻再发 —— 远端连不上的 4 分钟里，这个排空 effect 每 ~100ms
     捅一次 attach → preflight，日志刷了 488 行「跳过（20s 内刚判定连不上）」。
*/

describe('queuedBatchMessageId：排队那一批的 messageId 跟着条目走', () => {
  test('单条：就是那一条的 id（失败放回去再发还是它）', () => {
    assert.equal(queuedBatchMessageId([{ id: 'queue_1_ab' }]), 'queue_1_ab');
  });
  test('合并的一批：同一批条目 → 同一个 id；它还是"你自己发的一条"', () => {
    const a = queuedBatchMessageId([{ id: 'queue_1_ab' }, { id: 'queue_2_cd' }]);
    assert.equal(a, queuedBatchMessageId([{ id: 'queue_1_ab' }, { id: 'queue_2_cd' }]));
    assert.notEqual(a, 'queue_1_ab');
    assert.equal(isUserTurnMessageId(a), true);
  });
  test('经控制入口的条目：id 照样带标记（气泡上标「经控制入口发送」）', () => {
    assert.equal(isControlMessageId(queuedBatchMessageId([{ id: 'queue_ctl_1_ab' }])), true);
    assert.equal(isControlMessageId(queuedBatchMessageId([{ id: 'queue_1_ab' }, { id: 'queue_ctl_2_cd' }])), true);
    assert.equal(isControlMessageId(queuedBatchMessageId([{ id: 'queue_1_ab' }, { id: 'queue_2_cd' }])), false);
  });
});

describe('QueueBackoff：发失败之后等一等再试', () => {
  test('退避表递增、封顶', () => {
    assert.equal(queueRetryDelay(1), QUEUE_RETRY_MS[0]);
    assert.ok(queueRetryDelay(2) > queueRetryDelay(1));
    assert.equal(queueRetryDelay(99), QUEUE_RETRY_MS[QUEUE_RETRY_MS.length - 1]);
    assert.ok(QUEUE_RETRY_MS[0] >= 1000, '第一次也至少等一秒 —— 不能是"下一次渲染"');
  });
  test('失败后在退避期内不放行；过了就放行；成功清零', () => {
    const b = new QueueBackoff();
    assert.equal(b.blocked('s1', 0), false);
    const at = b.fail('s1', 1000);
    assert.equal(at, 1000 + QUEUE_RETRY_MS[0]);
    assert.equal(b.blocked('s1', 1100), true);
    assert.equal(b.blocked('s2', 1100), false, '别的会话不受影响（本机会话不等远端那条）');
    assert.equal(b.blocked('s1', at), false);
    const at2 = b.fail('s1', at);
    assert.equal(at2 - at, QUEUE_RETRY_MS[1]);
    b.ok('s1');
    assert.equal(b.blocked('s1', at), false);
    assert.equal(b.fail('s1', 0), QUEUE_RETRY_MS[0]);
  });
  test('模拟远端连不上 4 分钟：排空最多试十来次，不是两千多次', () => {
    const b = new QueueBackoff();
    let tries = 0;
    for (let now = 0; now < 4 * 60_000; now += 100) {          // 每 100ms 渲染一次
      if (b.blocked('remote', now)) continue;
      tries += 1;
      b.fail('remote', now);                                     // attach → preflight 立刻失败
    }
    assert.ok(tries <= 12, `试了 ${tries} 次`);
  });
});

describe('isDuplicateMessageError：主进程说"这一条已经答过了"', () => {
  test('中英文都认（错误经 IPC 过来只剩文字）', () => {
    assert.equal(isDuplicateMessageError("Error invoking remote method 'acp:prompt': Error: This message was already sent and answered, so it was not sent again. To redo it, press Rerun on that message."), true);
    assert.equal(isDuplicateMessageError('这条消息已经发过、也有回复了，不再重复发送。要重来，在那条消息上点「重跑」。'), true);
    assert.equal(isDuplicateMessageError('Session not connected'), false);
  });
  test('认的就是主进程那句话（中文表里对得上）', () => {
    const zh = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'uiTextZh', 'indexB.ts'), 'utf-8');
    const m = /'This message was already sent and answered, so it was not sent again\. To redo it, press Rerun on that message\.': '([^']+)'/.exec(zh);
    assert.ok(m, '主进程那句要进中文表');
    assert.equal(isDuplicateMessageError(m![1]), true);
  });
});

describe('pickQueuedBatch：没发成的那一批，重试完成前原样重发', () => {
  type Q = { id: string; content: string; retryBatch?: { id: string; size: number } };
  const batch = (q: Q[], merge: boolean) => (merge ? q.slice(0, 10) : q.slice(0, 1));
  /** 照 App.tsx 的排空走一遍：取一批 → 发失败 → 盖章放回队头 */
  const failOnce = (queue: Q[], merge: boolean) => {
    const picked = pickQueuedBatch(queue, merge, batch);
    const ids = new Set(picked.items.map((i) => i.id));
    return { picked, queue: [...sealRetryBatch(picked.items, picked.messageId), ...queue.filter((i) => !ids.has(i.id))] };
  };

  test('合并模式：A 落盘后发送失败，退避期间又排了 B → 重试只发 A、还是 A 的 id；B 下一轮单独发', () => {
    const first = failOnce([{ id: 'queue_A', content: 'A' }], true);
    assert.equal(first.picked.messageId, 'queue_A');
    const withB = [...first.queue, { id: 'queue_B', content: 'B' }];
    const retry = pickQueuedBatch(withB, true, batch);
    assert.deepEqual(retry.items.map((i) => i.id), ['queue_A']);
    assert.equal(retry.messageId, 'queue_A');
    const next = pickQueuedBatch(withB.slice(1), true, batch);
    assert.deepEqual(next.items.map((i) => i.id), ['queue_B']);
  });

  test('合并的 A+B 失败后：再排 C、或者把合并关掉，重试都还是 A+B、同一个 id', () => {
    const first = failOnce([{ id: 'queue_A', content: 'A' }, { id: 'queue_B', content: 'B' }], true);
    const id = first.picked.messageId;
    const withC = [...first.queue, { id: 'queue_C', content: 'C' }];
    for (const merge of [true, false]) {
      const retry = pickQueuedBatch(withC, merge, batch);
      assert.deepEqual(retry.items.map((i) => i.id), ['queue_A', 'queue_B'], `merge=${merge}`);
      assert.equal(retry.messageId, id);
    }
  });

  test('不合并时 A 失败，之后打开合并、又排了 B → 重试只发 A', () => {
    const first = failOnce([{ id: 'queue_A', content: 'A' }, { id: 'queue_B', content: 'B' }], false);
    const retry = pickQueuedBatch(first.queue, true, batch);
    assert.deepEqual(retry.items.map((i) => i.id), ['queue_A']);
    assert.equal(retry.messageId, 'queue_A');
  });

  test('前面插进来一条（「作为下一条发送」）：它单独发，不把后面那批没发成的并进来', () => {
    const first = failOnce([{ id: 'queue_A', content: 'A' }, { id: 'queue_B', content: 'B' }], true);
    const q = [{ id: 'queue_S', content: 'S' }, ...first.queue];
    const now = pickQueuedBatch(q, true, batch);
    assert.deepEqual(now.items.map((i) => i.id), ['queue_S']);
    const after = pickQueuedBatch(q.slice(1), true, batch);
    assert.deepEqual(after.items.map((i) => i.id), ['queue_A', 'queue_B']);
    assert.equal(after.messageId, first.picked.messageId);
  });

  test('盖的章跟着队列落盘：JSON 来回一趟（重启）后重试还是同一批、同一个 id', () => {
    const first = failOnce([{ id: 'queue_A', content: 'A' }, { id: 'queue_B', content: 'B' }], true);
    const back = JSON.parse(JSON.stringify(first.queue)) as Q[];
    const retry = pickQueuedBatch(back, false, batch);
    assert.equal(retry.messageId, first.picked.messageId);
    assert.equal(retry.items.length, 2);
  });

  test('你动过这一批（改了文字 / 取消了一张）→ 那是另一次提交，按新的一批发', () => {
    const first = failOnce([{ id: 'queue_A', content: 'A' }, { id: 'queue_B', content: 'B' }], true);
    const edited = unsealEdited(first.queue, 'queue_B');
    assert.equal(edited.some((i) => i.retryBatch), false);
    const cancelled = first.queue.slice(1);
    const retry = pickQueuedBatch(cancelled, true, batch);
    assert.notEqual(retry.messageId, first.picked.messageId);
  });
});

describe('editQueuedItem：改了一张已经试着发过的卡片 = 另一次提交', () => {
  type Q = { id: string; content: string; retryBatch?: { id: string; size: number } };
  const batch = (q: Q[], merge: boolean) => (merge ? q.slice(0, 10) : q.slice(0, 1));
  const fresh = (oldId: string) => (isControlMessageId(oldId) ? 'queue_ctl_new_1' : 'queue_new_1');

  test('单条 queue_A 发失败后改了文字 → 换新 id 再发（不顶着 queue_A：盘上是旧文字 / 旧的答过了会被当重复丢掉）', () => {
    const failed = sealRetryBatch([{ id: 'queue_A', content: '旧' }], 'queue_A');
    const edited = editQueuedItem(failed, 'queue_A', '新', fresh);
    assert.equal(edited[0].id, 'queue_new_1');
    assert.equal(edited[0].content, '新');
    assert.equal(edited[0].retryBatch, undefined);
    const next = pickQueuedBatch(edited, false, batch);
    assert.equal(next.messageId, 'queue_new_1');
  });

  test('合并的 A+B 发失败后改了 B → B 换新 id，这一批的 id 也跟着变', () => {
    const picked = pickQueuedBatch([{ id: 'queue_A', content: 'A' }, { id: 'queue_B', content: 'B' }], true, batch);
    const failed = sealRetryBatch(picked.items, picked.messageId);
    const edited = editQueuedItem(failed, 'queue_B', 'B2', fresh);
    assert.deepEqual(edited.map((i) => i.id), ['queue_A', 'queue_new_1']);
    assert.equal(edited.some((i) => i.retryBatch), false);
    assert.notEqual(pickQueuedBatch(edited, true, batch).messageId, picked.messageId);
  });

  test('经控制入口排进来的那张：换的新 id 照样带标记', () => {
    const failed = sealRetryBatch([{ id: 'queue_ctl_1_ab', content: '旧' }], 'queue_ctl_1_ab');
    assert.equal(isControlMessageId(editQueuedItem(failed, 'queue_ctl_1_ab', '新', fresh)[0].id), true);
  });

  test('还没发过的卡片：只改文字，id 不动', () => {
    const edited = editQueuedItem([{ id: 'queue_A', content: '旧' }], 'queue_A', '新', fresh);
    assert.deepEqual(edited, [{ id: 'queue_A', content: '新' }]);
  });

  test('接线：App 的编辑走 editQueuedItem，新 id 用 carryControlMark 保留标记', () => {
    const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf-8');
    const at = app.indexOf('const handleEditQueuedMessage = useCallback(');
    const body = app.slice(at, at + 1000);
    assert.match(body, /editQueuedItem\(prev\[sid\] \|\| \[\], queueId, content\.trim\(\), \(oldId\) => \(\s*\n\s*carryControlMark\(oldId, 'queue'\) \?\?/);
  });
});

describe('从磁盘恢复历史和 retryBatch 后再发送：同 id 的气泡只有一个，失败不删原有历史', () => {
  type M = { id: string; role: string; content: string; sendToken?: string };
  type Q = { id: string; content: string; retryBatch?: { id: string; size: number } };
  const batch = (q: Q[], merge: boolean) => (merge ? q.slice(0, 10) : q.slice(0, 1));

  test('上次已落盘的 queue_A（重载后从磁盘读回来）+ 恢复的 retryBatch → 重发时复用那个气泡，不再插第二个', () => {
    /* 重载：历史从磁盘读回来（含上次已落盘、没答的 queue_A），队列从 kirolex-queues 读回来（带 retryBatch） */
    const history: M[] = JSON.parse(JSON.stringify([{ id: 'u0', role: 'user', content: '早先的' }, { id: 'queue_A', role: 'user', content: 'A' }]));
    const queue: Q[] = JSON.parse(JSON.stringify(sealRetryBatch([{ id: 'queue_A', content: 'A' }], 'queue_A')));
    const picked = pickQueuedBatch(queue, true, batch);
    assert.equal(picked.messageId, 'queue_A');
    const sent = insertOptimistic(history, { id: picked.messageId, role: 'user', content: 'A', sendToken: 't1' });
    assert.equal(sent.filter((m) => m.id === 'queue_A').length, 1, '只有一个 queue_A 气泡');
    /* 这一次又没发成：撤销只撤这一次插的 —— 这次没插，所以原来那条历史还在 */
    const undone = removeOptimistic(sent, 'queue_A', 't1');
    assert.deepEqual(undone.map((m) => m.id), ['u0', 'queue_A']);
  });

  test('新的一条：插进来；失败时撤掉的正是这一次插的那个', () => {
    const history: M[] = [{ id: 'u0', role: 'user', content: '早先的' }];
    const sent = insertOptimistic(history, { id: 'queue_B', role: 'user', content: 'B', sendToken: 't2' });
    assert.deepEqual(sent.map((m) => m.id), ['u0', 'queue_B']);
    assert.deepEqual(removeOptimistic(sent, 'queue_B', 't2').map((m) => m.id), ['u0']);
    assert.deepEqual(removeOptimistic(sent, 'queue_B', 'other').map((m) => m.id), ['u0', 'queue_B'], '别的那一次的记号撤不动它');
  });

  test('接线：sendQueuedMessage 按 id 复用、失败只撤这一次插的', () => {
    const hk = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf-8');
    const at = hk.indexOf('const sendQueuedMessage = useCallback(');
    const body = hk.slice(at, at + 9000);
    assert.match(body, /const sendToken = `send_/);
    assert.match(body, /updateSession\(\(current\) => insertOptimistic\(current, userMessage\)\);/);
    assert.match(body, /return removeOptimistic\(current, userMessageId, sendToken\);/);
    assert.doesNotMatch(body, /updateSession\(\(current\) => \[\.\.\.current, userMessage\]\);/);
  });
});
