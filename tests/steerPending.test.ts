import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { settleAtTurnEnd, settleIpcResult, type PendingSteer } from '../src/renderer/steerPending.ts';
import { steerFailureRoute } from '../src/renderer/steerRoute.ts';
import { steerRefusal } from '../src/main/steerGate.ts';

/**
 * steer 的 IPC 结果**晚到**、中间这一轮结束了 —— 不能因此静默排队。
 *
 * 审查发现的漏洞：轮末对账（takeUnconsumedSteers）把「结果还没回来」的 steer 也当成「写进去了没被吃」挪进了队列；
 * 随后 IPC 回来说 unsupported / write-failed，`steerMessage` 看它已经不在待确认里，就直接回 steered:true ——
 * 标红和两个按钮都被绕过了。下面用纯函数把这条时间线模拟一遍。
 */

type A = { path: string };
const steer = (id: string, extra: Partial<PendingSteer<A>> = {}): PendingSteer<A> => ({ msgId: id, content: id, attachments: [], ...extra });

/** 模拟：登记（inFlight）→ 轮末对账 → IPC 结果回来。返回进队列的和 App 拿到的结论。 */
function timeline(ipc: { steered: boolean; reason?: string }, turnEndsFirst: boolean) {
  let list: PendingSteer<A>[] = [steer('s1', { inFlight: true })];
  let requeued: PendingSteer<A>[] = [];
  if (turnEndsFirst) {
    const r = settleAtTurnEnd(list);
    requeued = r.requeue;
    list = r.keep;
  }
  const settled = settleIpcResult(list, 's1', ipc);
  list = settled.list;
  // 结果先到、轮末后到的那种顺序
  if (!turnEndsFirst) {
    const r = settleAtTurnEnd(list);
    requeued = r.requeue;
    list = r.keep;
  }
  return { requeued, outcome: settled.outcome, left: list };
}

describe('IPC 结果晚到、期间这一轮结束', () => {
  for (const reason of ['write-failed', 'not-connected', 'ipc-error']) {
    test(`失败（${reason}）→ 不进队列，交给 App 标红让用户选`, () => {
      const r = timeline({ steered: false, reason }, true);
      assert.deepEqual(r.requeued, [], '轮末不许把结果还没回来的挪进队列');
      assert.deepEqual(r.outcome, { kind: 'failed', reason });
      assert.equal(steerFailureRoute(reason), 'ask');
      assert.deepEqual(r.left, []);
    });
  }

  test('写成功了，但这一轮已经结束 → 当作「这一轮已结束」，作为新消息发出（不进队列）', () => {
    const r = timeline({ steered: true }, true);
    assert.deepEqual(r.requeued, []);
    assert.deepEqual(r.outcome, { kind: 'failed', reason: 'idle' });
    assert.equal(steerFailureRoute('idle'), 'send-now');
    assert.deepEqual(r.left, []);
  });
});

describe('原来的规则不变', () => {
  test('写成功了、这一轮之后才结束、没被吃 → 轮末放回队头（沿用轮末回队规则）', () => {
    const r = timeline({ steered: true }, false);
    assert.deepEqual(r.outcome, { kind: 'steered' });
    assert.deepEqual(r.requeued.map((s) => s.msgId), ['s1']);
    assert.equal(r.requeued[0].inFlight, undefined, '确认之后不再是 inFlight');
  });

  test('失败、轮还在跑 → 交给 App，不进队列', () => {
    const r = timeline({ steered: false, reason: 'write-failed' }, false);
    assert.deepEqual(r.requeued, []);
    assert.deepEqual(r.outcome, { kind: 'failed', reason: 'write-failed' });
  });

  test('结果回来之前已经被吃掉（或者用户点了停止丢掉了）→ 什么都不做', () => {
    assert.deepEqual(settleIpcResult([], 's1', { steered: false, reason: 'write-failed' }).outcome, { kind: 'gone' });
    assert.deepEqual(settleIpcResult([], 's1', { steered: true }).outcome, { kind: 'gone' });
  });

  test('轮末只把已确认的放回去、顺序不变；没回来的留下并标 turnEnded', () => {
    const r = settleAtTurnEnd([steer('a'), steer('b', { inFlight: true }), steer('c')]);
    assert.deepEqual(r.requeue.map((s) => s.msgId), ['a', 'c']);
    assert.deepEqual(r.keep.map((s) => [s.msgId, s.turnEnded]), [['b', true]]);
  });
});

describe('主进程 acp:steer 的检查顺序', () => {
  const base = { connected: true, reconfiguring: false, priming: false, busy: true, supportsSteer: true };

  test('不支持 steer 的引擎（claude / codex）这一轮刚结束 → idle（作为新消息发），不是 unsupported', () => {
    assert.equal(steerRefusal({ ...base, busy: false, supportsSteer: false }), 'idle');
    assert.equal(steerFailureRoute(steerRefusal({ ...base, busy: false, supportsSteer: false })!), 'send-now');
  });

  test('不支持 steer 的引擎、这一轮还在跑 → unsupported（渲染端兜底：排队作为下一条，不标红）', () => {
    assert.equal(steerRefusal({ ...base, supportsSteer: false }), 'unsupported');
    assert.equal(steerFailureRoute('unsupported'), 'queue');
  });

  test('重建历史 / 换执行器 / 没连上 排在「这一轮已结束」前面', () => {
    assert.equal(steerRefusal({ ...base, busy: false, priming: true }), 'priming');
    assert.equal(steerRefusal({ ...base, busy: false, reconfiguring: true }), 'reconfiguring');
    assert.equal(steerRefusal({ ...base, connected: false, busy: false }), 'not-connected');
  });

  test('正在跑且支持 → 放行', () => {
    assert.equal(steerRefusal(base), null);
  });
});

describe('接线', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
  const MAIN = read('main', 'index.ts');
  const ACP = read('renderer', 'hooks', 'useAcp.ts');

  test('acp:steer 用 steerRefusal 决定拒绝理由', () => {
    const at = MAIN.indexOf("ipcMain.handle('acp:steer'");
    const h = MAIN.slice(at, MAIN.indexOf('\n  });', at));
    assert.match(h, /const refused = steerRefusal\(\{/);
    assert.doesNotMatch(h, /if \(!entry\.client\.supportsSteer\) return/);
  });

  test('useAcp：登记时标 inFlight，结果和轮末都走 steerPending', () => {
    assert.match(ACP, /inFlight: true \}/);
    assert.match(ACP, /const settled = settleIpcResult\(pendingSteersRef\.current\.get\(sid\) \|\| \[\], msgId, res\);/);
    assert.match(ACP, /const \{ requeue: list, keep \} = settleAtTurnEnd\(all\);/);
    assert.doesNotMatch(ACP, /if \(!stillPending\) return \{ steered: true \};/);
  });
});
