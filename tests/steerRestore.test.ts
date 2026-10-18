import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFailedSteers, turnBaseId, withFailedSteers, type FailedSteerRecord } from '../src/renderer/steerPending.ts';
import { withAfterRebuild } from '../src/renderer/steerRoute.ts';
import { steerInsertIndex } from '../src/renderer/turnRecovery.ts';

/**
 * 重启 / 刷新之后不能替用户改主意。
 *   1. 没能追加、用户还没选的 steer → 仍是标红的失败消息（原因、附件、两个按钮），**不**进队列
 *      （进了队列，打开那条会话就会自动发出 = 替用户点了「作为下一条发送」）；
 *   2. 「重建历史中，结束后发送」那条 → 恢复后仍带 afterRebuild：单独标出、单独发送，不和后面的排队合并。
 */

type Msg = { id: string; role: string; content: string; steer?: string; steerError?: string; attachments?: unknown[]; timestamp: number };
const make = (f: FailedSteerRecord<{ path: string }>): Msg => ({
  id: f.msgId, role: 'user', content: f.content, steer: 'failed', steerError: f.reason || 'unknown',
  timestamp: f.ts || 0, ...(f.attachments.length ? { attachments: f.attachments } : {}),
});

const transcript: Msg[] = [
  { id: 'u1', role: 'user', content: '第一问', timestamp: 1 },
  { id: 'a1', role: 'assistant', content: '答一', timestamp: 2 },
  { id: 'u2', role: 'user', content: '第二问', timestamp: 3 },
  { id: 'a2', role: 'assistant', content: '答二', timestamp: 4 },
];

describe('失败的 steer：重启后还是失败消息，不是排队', () => {
  const record: FailedSteerRecord<{ path: string }> = {
    msgId: 'steer_failed_1', content: '再看下日志', attachments: [{ path: '/tmp/build.log' }],
    reason: 'write-failed', ts: 99, baseId: 'u1',
  };

  test('落盘 → 读回：原因、附件、所属那一轮都在', () => {
    const back = parseFailedSteers<{ path: string }>(JSON.stringify({ s1: [record] }));
    assert.deepEqual(back.s1, [record]);
  });

  test('读回来的会话记录里，它作为标红消息挂回它那一轮（紧跟那条用户消息）', () => {
    const back = parseFailedSteers<{ path: string }>(JSON.stringify({ s1: [record] }));
    const out = withFailedSteers(transcript, back.s1, make, steerInsertIndex);
    assert.deepEqual(out.map((m) => m.id), ['u1', 'steer_failed_1', 'a1', 'u2', 'a2']);
    const msg = out[1];
    assert.equal(msg.steer, 'failed');
    assert.equal(msg.steerError, 'write-failed');
    assert.deepEqual(msg.attachments, [{ path: '/tmp/build.log' }]);
  });

  test('找不到那一轮（被截掉了）→ 挂到最后一轮', () => {
    const out = withFailedSteers(transcript, [{ ...record, baseId: 'gone' }], make, steerInsertIndex);
    assert.deepEqual(out.map((m) => m.id), ['u1', 'a1', 'u2', 'steer_failed_1', 'a2']);
  });

  test('已经在界面上的不重复插', () => {
    const once = withFailedSteers(transcript, [record], make, steerInsertIndex);
    assert.deepEqual(withFailedSteers(once, [record], make, steerInsertIndex), once);
  });

  test('坏数据不炸', () => {
    assert.deepEqual(parseFailedSteers('not json'), {});
    assert.deepEqual(parseFailedSteers(JSON.stringify({ s1: [{ nope: 1 }] })), {});
  });

  describe('接线（useAcp）', () => {
    const ACP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
    test('启动时不再把失败记录并进「要放回队列」的那份、也不删它', () => {
      assert.doesNotMatch(ACP, /\n    uiRemove\(FAILED_STEERS_KEY\);\n  \}/);
      assert.doesNotMatch(ACP, /Object\.entries\(failed as Record<string, FailedSteer\[\]>\)/);
      assert.match(ACP, /parseFailedSteers<AttachedFile>\(uiGet\(FAILED_STEERS_KEY\)\)/);
    });
    test('每个从盘上读会话记录的地方都把失败 steer 挂回去', () => {
      assert.match(ACP, /const restoredWithFailed = withFailed\(lastSid, restored\);/);
      assert.match(ACP, /const msgsWithFailed = withFailed\(sid, msgs\);/);
      assert.match(ACP, /const merged = withFailed\(id, \[/);
      assert.match(ACP, /const merged = withFailed\(sessionId, \[/);
    });
    test('所属那一轮在落盘之前同步算好，不在状态更新回调里改 record', () => {
      const fn = ACP.slice(ACP.indexOf('const addFailedSteer = useCallback'), ACP.indexOf('const takeFailedSteer = useCallback'));
      const baseAt = fn.indexOf('const baseId = turnBaseId(messagesCacheRef.current.get(sid) || [], steerInsertIndex);');
      assert.ok(baseAt > 0, '要从缓存同步算 baseId');
      assert.ok(baseAt < fn.indexOf('mutateSessionMessages(sid,'), '要在状态更新之前');
      assert.ok(fn.indexOf('saveFailedSteers()') > baseAt);
      assert.match(fn, /const record: FailedSteer = \{ msgId, content, attachments, reason, ts: Date\.now\(\), \.\.\.\(baseId \? \{ baseId \} : \{\}\) \};/);
      assert.doesNotMatch(fn, /record\.baseId =/);
    });
  });
});

describe('回归：状态更新回调晚于落盘执行 → 继续下一轮 → 重启', () => {
  test('失败消息仍挂在失败发生的那一轮，不是最后一轮', () => {
    // 失败发生时：第二轮在跑（u2 是这一轮的用户消息）
    const atFailure = transcript.slice(0, 3);
    const record: FailedSteerRecord<{ path: string }> = {
      msgId: 'steer_failed_x', content: '另外跑下 lint', attachments: [], reason: 'unsupported', ts: 10,
      baseId: turnBaseId(atFailure, steerInsertIndex),
    };
    // 模拟 React 推迟执行状态更新：落盘这一刻界面还没插入那条消息 —— 存下去的必须已经有 baseId
    const saved = JSON.stringify({ s1: [record] });
    assert.equal(JSON.parse(saved).s1[0].baseId, 'u2');
    // 之后又聊了一轮
    const later: Msg[] = [...transcript, { id: 'u3', role: 'user', content: '第三问', timestamp: 5 }, { id: 'a3', role: 'assistant', content: '答三', timestamp: 6 }];
    // 重启：读回来挂回 u2 那一轮
    const out = withFailedSteers(later, parseFailedSteers<{ path: string }>(saved).s1, make, steerInsertIndex);
    assert.deepEqual(out.map((m) => m.id), ['u1', 'a1', 'u2', 'steer_failed_x', 'a2', 'u3', 'a3']);
  });

  test('turnBaseId 跳过这一轮已有的追加指令，找到这一轮的用户消息；没有用户消息时为空', () => {
    const msgs: Msg[] = [...transcript.slice(0, 3), { id: 's1', role: 'user', content: '追加', steer: 'consumed', timestamp: 3.5 }];
    assert.equal(turnBaseId(msgs, steerInsertIndex), 'u2');
    assert.equal(turnBaseId([], steerInsertIndex), undefined);
  });
});

describe('「重建后发送」：恢复后标记还在', () => {
  // App.tsx 不能 import（.tsx），把 useState 初始化里那段恢复逻辑原样截出来跑一遍。
  const APP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
  const at = APP.indexOf('const kept = items.filter(');
  const body = APP.slice(at + 'const kept = '.length, APP.indexOf(' as QueuedMessage[];', at)).replace(/\(item: any\)/g, '(item)');
  const restore = new Function('items', `return ${body};`) as (items: unknown[]) => any[];

  test('afterRebuild 跟着回来；普通的不会被标上；两者都带 restored', () => {
    const back = restore(JSON.parse(JSON.stringify([
      { id: 'r1', content: '重建时发的', attachments: [], createdAt: 1, afterRebuild: true },
      { id: 'q1', content: '普通排队', attachments: [], createdAt: 2 },
    ])));
    assert.equal(back[0].afterRebuild, true);
    assert.equal(back[0].restored, true);
    assert.equal('afterRebuild' in back[1], false);
    assert.equal(back[1].restored, true);
  });

  test('恢复后仍排在普通排队之前，后来的「重建后发送」排在它后面', () => {
    const back = restore([
      { id: 'r1', content: 'a', createdAt: 1, afterRebuild: true },
      { id: 'q1', content: 'b', createdAt: 2 },
    ]);
    assert.deepEqual(withAfterRebuild(back, { ...back[0], id: 'r2' }).map((i: any) => i.id), ['r1', 'r2', 'q1']);
  });

  test('排空时它单独发（不和后面的合并）、界面上单独标出来 —— 两条规则都只看 afterRebuild，恢复后照旧生效', () => {
    assert.match(APP, /settings\.mergeQueuedMessages && !queue\[0\]\.afterRebuild/);
    const CHAT = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf8');
    assert.match(CHAT, /queuedMessages\.filter\(\(item\) => item\.afterRebuild\)/);
  });
});
