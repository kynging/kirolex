import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  IDLE_CONFIRM_TICKS, ReplyWatcher, findReply, fromHeader, parseHeader, replyWaitBadges,
  type ReplyWatch, type TurnOutcome,
} from '../src/main/sessionCalls.ts';
import { foreignDraftText, queueCardView, rejoinQueueEdit, rerunKeepId } from '../src/renderer/foreignMessages.ts';
import { joinQueuedBatch } from '../src/renderer/queueBatch.ts';

/*
 * 别的会话发来的消息（📨 session_send waitReply）在「停止 / 中断 / 重跑 / 排队 / 插话」时的体验：
 *   · 用户停止 → 告诉发起方「对方的用户停止了这一轮」+ 已产出的部分，等待结束；
 *   · 切换模型中断 → 告诉发起方「已在新模型上继续」，等待保留，之后的回复照常发回；
 *   · 断线中断 → 原来那条说明，等待保留；
 *   · 重跑 / 编辑正文后仍按 call 编号认得那条；
 *   · 用户插话（steer / 排队）→ 回复里注明，只取这一轮；
 *   · 排队卡片里删掉 → 告诉发起方「取消了、没有处理」，等待结束；
 *   · 发起方的「⏳ 等回复」标记：数据来自 watch 列表，restore 之后一致；
 *   · 来自别的会话的内容不进输入框草稿。
 */

type Tx = Array<{ id: string; role: string; content: string; ts: number; kirolex?: boolean; steerParts?: Array<{ id: string; content: string; ts: number }> }>;

function fixture() {
  let now = 9_000_000;
  const tx: Record<string, Tx> = { s_a: [], s_b: [] };
  const busy = new Set<string>();
  let lastTurn: TurnOutcome | null = null;
  const delivered: Array<{ sid: string; text: string }> = [];
  let saved: ReplyWatch[] = [];
  const watcher = new ReplyWatcher({
    now: () => now,
    transcript: (id) => tx[id] || [],
    isBusy: (id) => busy.has(id),
    exists: () => true,
    title: (id) => (id === 's_b' ? 'B 会话' : 'A 会话'),
    deliver: (sid, text) => { delivered.push({ sid, text }); },
    changed: (list) => { saved = list; },
    lastTurn: () => lastTurn,
  });
  const payload = `${fromHeader('A 会话', 's_a', 1, true, 'call7x')}\n问：版本号是多少？`;
  const w: ReplyWatch = { id: 'w1', from: 's_a', to: 's_b', toTitle: 'B 会话', payload, since: now, deadline: now + 1800_000, timeoutSec: 1800, depth: 1 };
  const ticks = (n: number) => { for (let i = 0; i < n; i++) watcher.tick(); };
  return {
    watcher, tx, busy, delivered, saved: () => saved, payload, w, ticks,
    setLastTurn: (t: TurnOutcome | null) => { lastTurn = t; }, advance: (ms: number) => { now += ms; }, now: () => now,
  };
}

describe('停止 / 中断时告诉发起方：三种结局', () => {
  test('用户停止：说「对方的用户停止了这一轮」+ 已产出的部分，等待结束、之后不再唤醒', () => {
    const x = fixture();
    x.watcher.add(x.w);
    x.tx.s_b.push({ id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10 });
    x.tx.s_b.push({ id: 'a1', role: 'assistant', content: '先查了 package.json', ts: x.w.since + 20 });
    x.busy.add('s_b');
    x.busy.delete('s_b');
    x.watcher.turnStopped('s_b', 'user');
    assert.equal(x.delivered.length, 1);
    assert.equal(x.delivered[0].sid, 's_a');
    assert.equal(parseHeader(x.delivered[0].text)?.reply, true);
    assert.match(x.delivered[0].text, /user of session "B 会话" stopped this turn|对方的用户停止了这一轮/);
    assert.match(x.delivered[0].text, /先查了 package\.json/);
    assert.doesNotMatch(x.delivered[0].text, /new model|新模型/);
    assert.equal(x.watcher.list().length, 0, '等待登记结束');
    assert.equal(x.saved().length, 0, '落盘的也清掉');
    x.ticks(IDLE_CONFIRM_TICKS + 3);
    assert.equal(x.delivered.length, 1, '之后不再唤醒（不会再发一条「回复」）');
  });

  test('用户停止但还没产出：已产出的部分写「没有」', () => {
    const x = fixture();
    x.watcher.add(x.w);
    x.tx.s_b.push({ id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10 });
    x.watcher.turnStopped('s_b', 'user');
    assert.equal(x.delivered.length, 1);
    assert.match(x.delivered[0].text, /Output so far: \(nothing yet\)|已产出的部分：没有/);
  });

  test('对方停的不是这一轮（那条还在排队、没进记录 / 那一轮早就结束、后面另起了一轮）：什么都不说，等待照旧', () => {
    const x = fixture();
    x.watcher.add(x.w);
    x.watcher.turnStopped('s_b', 'user');
    assert.equal(x.delivered.length, 0, '还没进记录（还在对方的排队卡片里）');
    assert.equal(x.watcher.list().length, 1);
    x.tx.s_b.push({ id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10 });
    x.tx.s_b.push({ id: 'a1', role: 'assistant', content: '版本 1.2.3', ts: x.w.since + 20 });
    x.tx.s_b.push({ id: 'u2', role: 'user', content: '用户自己的下一条', ts: x.w.since + 30 });
    x.watcher.turnStopped('s_b', 'user');
    assert.ok(!x.delivered.some((d) => /stopped this turn|停止了这一轮/.test(d.text)), '停的是用户自己另起的那一轮');
  });

  test('切换模型中断：说「已在新模型上继续，之后的回复会再发给你」，等待保留；新模型上做完了再发回复（含切换前已产出的）', () => {
    const x = fixture();
    x.watcher.add(x.w);
    x.tx.s_b.push({ id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10 });
    x.tx.s_b.push({ id: 'a1', role: 'assistant', content: '前半段', ts: x.w.since + 20 });
    /* 停的那一下后端给了结束响应（completed），可这一轮其实没做完 —— 主进程在切换时把这条收场记录清掉 */
    x.setLastTurn(null);
    x.watcher.turnStopped('s_b', 'switch');
    assert.equal(x.delivered.length, 1);
    assert.match(x.delivered[0].text, /switch(ing)? model|切换模型/);
    assert.match(x.delivered[0].text, /new model|新模型上继续/);
    assert.match(x.delivered[0].text, /前半段/);
    assert.equal(x.watcher.list().length, 1, '等待保留');
    assert.equal(typeof x.saved()[0]?.interruptedAt, 'number', '说过这件事落盘');
    assert.equal(x.saved()[0]?.deadline, x.w.deadline, '期限照旧');
    x.ticks(IDLE_CONFIRM_TICKS + 3);
    assert.equal(x.delivered.length, 1, '空着、没有「做完了」的记录：不算回复');
    // 续写那条（user_kcont_）在新模型上跑完
    x.advance(1000);
    x.tx.s_b.push({ id: 'user_kcont_1_ab', role: 'user', content: '接着做', ts: x.now() });
    x.tx.s_b.push({ id: 'a2', role: 'assistant', content: '后半段：版本 1.2.3', ts: x.now() + 10 });
    x.setLastTurn({ state: 'completed', at: x.now() + 20 });
    x.ticks(IDLE_CONFIRM_TICKS);
    assert.equal(x.delivered.length, 2);
    assert.match(x.delivered[1].text, /前半段/);
    assert.match(x.delivered[1].text, /后半段：版本 1\.2\.3/);
    assert.equal(x.watcher.list().length, 0);
  });

  test('切换模型后续写完、紧接着跑用户排队的新问题：只取原调用这一轮（含续写），不拼进用户那一轮，并注明', () => {
    for (const sameTick of [true, false]) {
      const x = fixture();
      x.watcher.add(x.w);
      x.tx.s_b.push({ id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10 });
      x.tx.s_b.push({ id: 'a1', role: 'assistant', content: '前半段', ts: x.w.since + 20 });
      x.setLastTurn(null);
      x.watcher.turnStopped('s_b', 'switch');
      assert.equal(x.delivered.length, 1);
      x.advance(1000);
      x.busy.add('s_b');
      x.tx.s_b.push({ id: 'user_kcont_1_ab', role: 'user', content: '接着做', ts: x.now() });
      x.tx.s_b.push({ id: 'a2', role: 'assistant', content: '后半段：版本 1.2.3', ts: x.now() + 10 });
      if (!sameTick) { x.setLastTurn({ state: 'completed', at: x.now() + 20 }); x.ticks(1); }
      // 用户排队的新问题接着就跑（新的一轮开始时主进程清掉收场记录）
      x.tx.s_b.push({ id: 'queue_9', role: 'user', content: '用户排的：再看看日志', ts: x.now() + 30 });
      x.tx.s_b.push({ id: 'a3', role: 'assistant', content: '日志里没有错误', ts: x.now() + 40 });
      x.setLastTurn(null);
      x.ticks(1);
      x.busy.delete('s_b');
      x.setLastTurn({ state: 'completed', at: x.now() + 50 });
      x.ticks(IDLE_CONFIRM_TICKS + 1);
      assert.equal(x.delivered.length, 2, `sameTick=${sameTick}`);
      assert.match(x.delivered[1].text, /前半段/);
      assert.match(x.delivered[1].text, /后半段：版本 1\.2\.3/);
      assert.doesNotMatch(x.delivered[1].text, /日志里没有错误/, '用户另起的那一轮不算进来');
      assert.match(x.delivered[1].text, /next turn .*not included|另起的那一轮没有算进来/);
      assert.equal(x.watcher.list().length, 0);
    }
  });

  test('切换模型后续写期间用户按 Enter 插话（落在续写那条的 steerParts）：回复里注明「这一轮用户插入了消息」', () => {
    const x = fixture();
    x.watcher.add(x.w);
    x.tx.s_b.push({ id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10 });
    x.tx.s_b.push({ id: 'a1', role: 'assistant', content: '前半段', ts: x.w.since + 20 });
    x.watcher.turnStopped('s_b', 'switch');
    x.advance(1000);
    x.tx.s_b.push({ id: 'user_kcont_1_ab', role: 'user', content: '接着做', ts: x.now(), steerParts: [{ id: 'st1', content: '顺便把 README 也改了', ts: x.now() + 5 }] });
    x.tx.s_b.push({ id: 'a2', role: 'assistant', content: '后半段；README 已改', ts: x.now() + 10 });
    assert.equal(findReply(x.tx.s_b, x.payload, x.w.since).interjected, true);
    x.setLastTurn({ state: 'completed', at: x.now() + 20 });
    x.ticks(IDLE_CONFIRM_TICKS);
    assert.equal(x.delivered.length, 2);
    assert.match(x.delivered[1].text, /user of session "B 会话" also added message|这一轮对方的用户插入了消息/);
    assert.match(x.delivered[1].text, /后半段；README 已改/);
  });

  test('续写那条本身（KiroLex 的续写提示）不算用户插话', () => {
    const x = fixture();
    const tx: Tx = [
      { id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10 },
      { id: 'user_kcont_1_ab', role: 'user', content: '接着做', ts: x.w.since + 20 },
      { id: 'a2', role: 'assistant', content: '答', ts: x.w.since + 30 },
    ];
    assert.ok(!findReply(tx, x.payload, x.w.since).interjected);
  });

  test('切换模型后续写之后用户排队的那一轮一开始：不用等它跑完，原调用这一轮就算结束', () => {
    const x = fixture();
    x.watcher.add(x.w);
    x.tx.s_b.push({ id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10 });
    x.watcher.turnStopped('s_b', 'switch');
    x.advance(1000);
    x.busy.add('s_b');
    x.tx.s_b.push({ id: 'user_kcont_1_ab', role: 'user', content: '接着做', ts: x.now() });
    x.tx.s_b.push({ id: 'a2', role: 'assistant', content: '答案', ts: x.now() + 10 });
    x.tx.s_b.push({ id: 'queue_9', role: 'user', content: '用户排的', ts: x.now() + 30 });
    x.ticks(1);
    assert.equal(x.delivered.length, 2);
    assert.match(x.delivered[1].text, /答案/);
  });

  test('断线中断：仍是「因连接断开中断」那条说明，等待保留到原期限', () => {
    const x = fixture();
    x.watcher.add(x.w);
    x.tx.s_b.push({ id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10 });
    x.setLastTurn({ state: 'interrupted', at: x.w.since + 30 });
    x.ticks(2);
    assert.equal(x.delivered.length, 1);
    assert.match(x.delivered[0].text, /connection dropped|连接断开/);
    assert.doesNotMatch(x.delivered[0].text, /stopped this turn|停止了这一轮|new model|新模型/);
    assert.equal(x.watcher.list().length, 1);
    x.advance(1800_000);
    x.ticks(1);
    assert.equal(x.delivered.length, 2);
    assert.match(x.delivered[1].text, /No reply|没有回复/);
  });
});

describe('重跑 / 编辑：按 call 编号认那条', () => {
  test('原样重跑（记录截掉旧的、追加一条新 id 的同样原文）：仍能 findReply，回复给发起方', () => {
    const x = fixture();
    x.watcher.add(x.w);
    x.tx.s_b.push({ id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10 });
    x.tx.s_b.length = 0;
    x.tx.s_b.push({ id: 'user_xs_2', role: 'user', content: x.payload, ts: x.w.since + 500 });
    x.tx.s_b.push({ id: 'a1', role: 'assistant', content: '重跑后的回答', ts: x.w.since + 600 });
    const r = findReply(x.tx.s_b, x.payload, x.w.since);
    assert.equal(r.found, true);
    assert.equal(r.reply, '重跑后的回答');
    x.ticks(IDLE_CONFIRM_TICKS);
    assert.equal(x.delivered.length, 1);
    assert.match(x.delivered[0].text, /重跑后的回答/);
  });

  test('正文被改过（排队卡片里编辑过 / 编辑后重跑），来源那一行（带 call 编号）还在：照样认得', () => {
    const x = fixture();
    const first = x.payload.split('\n')[0];
    const edited = `${first}\n问：版本号和发布日期？`;
    const tx: Tx = [
      { id: 'user_xs_1', role: 'user', content: edited, ts: x.w.since + 10 },
      { id: 'a1', role: 'assistant', content: '1.2.3，11 月发布', ts: x.w.since + 20 },
    ];
    const r = findReply(tx, x.payload, x.w.since);
    assert.equal(r.found, true);
    assert.equal(r.reply, '1.2.3，11 月发布');
  });

  test('别的 call 编号（同一会话发的另一条）不算这一条', () => {
    const x = fixture();
    const other = `${fromHeader('A 会话', 's_a', 1, true, 'callOTHER')}\n问：版本号是多少？`;
    const tx: Tx = [
      { id: 'user_xs_1', role: 'user', content: other, ts: x.w.since + 10 },
      { id: 'a1', role: 'assistant', content: '别的那条的回答', ts: x.w.since + 20 },
    ];
    assert.equal(findReply(tx, x.payload, x.w.since).found, false);
  });

  test('rerunKeepId：📨 / 唤醒消息原样重跑保留来源标记；改了来源那一行或你自己的消息 → 普通 id', () => {
    const x = fixture();
    const id = rerunKeepId('user_xs_1700000000000_ab', x.payload, x.payload, 1800000000000);
    assert.match(String(id), /^user_xs_1800000000000_/);
    const first = x.payload.split('\n')[0];
    assert.match(String(rerunKeepId('user_xs_1700000000000_ab', x.payload, `${first}\n改过的正文`, 1800000000000)), /^user_xs_/, '来源那一行还在：保留');
    assert.equal(rerunKeepId('user_xs_1700000000000_ab', x.payload, '整条换成我自己写的', 1800000000000), undefined);
    assert.match(String(rerunKeepId('sched_job1_r3_1700000000000', '⏰ 定时：跑一下', '⏰ 定时：跑一下', 1800000000000)), /^sched_job1_r3_1800000000000$/);
    assert.equal(rerunKeepId('sched_job1_r3_1700000000000', '⏰ 定时：跑一下', '我改了', 1800000000000), undefined);
    assert.equal(rerunKeepId('user_1700000000000_ab', '你好', '你好', 1800000000000), undefined, '你自己的消息照旧');
  });
});

describe('用户插话：注明、只取这一轮', () => {
  test('用户 Enter 追加进这一轮（steerParts）：回复里注明「这一轮用户插入了消息」', () => {
    const x = fixture();
    x.watcher.add(x.w);
    x.tx.s_b.push({ id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10, steerParts: [{ id: 'st1', content: '顺便把 README 也改了', ts: x.w.since + 15 }] });
    x.tx.s_b.push({ id: 'a1', role: 'assistant', content: '版本 1.2.3；README 已改', ts: x.w.since + 20 });
    const r = findReply(x.tx.s_b, x.payload, x.w.since);
    assert.equal(r.interjected, true);
    x.ticks(IDLE_CONFIRM_TICKS);
    assert.equal(x.delivered.length, 1);
    assert.match(x.delivered[0].text, /user of session "B 会话" also added message|这一轮对方的用户插入了消息/);
    assert.match(x.delivered[0].text, /版本 1\.2\.3/);
  });

  test('只有别的会话追加进来的（📨）不算用户插话', () => {
    const x = fixture();
    const other = `${fromHeader('C 会话', 's_c', 1, false, 'callC')}\n补充一句`;
    const tx: Tx = [
      { id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10, steerParts: [{ id: 'st1', content: other, ts: x.w.since + 15 }] },
      { id: 'a1', role: 'assistant', content: '好', ts: x.w.since + 20 },
    ];
    assert.ok(!findReply(tx, x.payload, x.w.since).interjected);
  });

  test('「合并排队消息」把这条和用户自己排的合成一条（真实 joinQueuedBatch，中英两种合并说明）：标记用户插话、回复里注明', () => {
    for (const header of [(n: number) => `【已合并 ${n} 条排队消息】`, (n: number) => `[${n} queued messages merged]`]) {
      const x = fixture();
      x.watcher.add(x.w);
      const merged = joinQueuedBatch([{ content: x.payload }, { content: '顺便更新 CHANGELOG' }], header);
      x.tx.s_b.push({ id: 'queue_xs_batch_2_abc', role: 'user', content: merged, ts: x.w.since + 10 });
      x.tx.s_b.push({ id: 'a1', role: 'assistant', content: '版本 1.2.3；CHANGELOG 已更新', ts: x.w.since + 20 });
      assert.equal(findReply(x.tx.s_b, x.payload, x.w.since).interjected, true);
      x.ticks(IDLE_CONFIRM_TICKS);
      assert.equal(x.delivered.length, 1);
      assert.match(x.delivered[0].text, /user of session "B 会话" also added message|这一轮对方的用户插入了消息/);
    }
  });

  test('合并说明的两种写法和界面实际用的一致（App 的 key + 中文表），改了这里要跟着改', () => {
    const SRC = path.join(import.meta.dirname, '..', 'src');
    assert.ok(fs.readFileSync(path.join(SRC, 'renderer', 'App.tsx'), 'utf8').includes(`joinQueuedBatch(consumed, (n) => tRef.current('[{n} queued messages merged]', { n }))`));
    assert.ok(fs.readFileSync(path.join(SRC, 'renderer', 'i18nZh', 'shell.ts'), 'utf8').includes(`'[{n} queued messages merged]': '【已合并 {n} 条排队消息】'`));
  });

  test('合并的一批全是别的会话发来的（正文里有空行分段也一样）：不算用户插话', () => {
    const x = fixture();
    const other = `${fromHeader('C 会话', 's_c', 1, false, 'callC')}\n第一段\n\n第二段`;
    const merged = joinQueuedBatch([{ content: x.payload }, { content: other }, { content: '' }], (n) => `【已合并 ${n} 条排队消息】`);
    const tx: Tx = [
      { id: 'queue_xs_batch_3_abc', role: 'user', content: merged, ts: x.w.since + 10 },
      { id: 'a1', role: 'assistant', content: '都答了', ts: x.w.since + 20 },
    ];
    const r = findReply(tx, x.payload, x.w.since);
    assert.equal(r.found, true);
    assert.ok(!r.interjected);
  });

  test('用户排队的下一条另起一轮：只取这一轮的回复，并注明后面那一轮没算进来', () => {
    const x = fixture();
    x.watcher.add(x.w);
    x.tx.s_b.push({ id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10 });
    x.tx.s_b.push({ id: 'a1', role: 'assistant', content: '版本 1.2.3', ts: x.w.since + 20 });
    x.tx.s_b.push({ id: 'queue_1', role: 'user', content: '用户排的：再帮我看看日志', ts: x.w.since + 30 });
    x.tx.s_b.push({ id: 'a2', role: 'assistant', content: '日志里没有错误', ts: x.w.since + 40 });
    x.busy.add('s_b');
    x.ticks(1);
    assert.equal(x.delivered.length, 1, '后面来了用户消息：那一轮结束了，不用等空');
    assert.match(x.delivered[0].text, /版本 1\.2\.3/);
    assert.doesNotMatch(x.delivered[0].text, /日志里没有错误/);
    assert.match(x.delivered[0].text, /next turn .*not included|另起的那一轮没有算进来/);
  });
});

describe('排队卡片：删除 → 通知发起方并结束等待', () => {
  test('withdrawn：按 call 编号找到那条等待，告诉发起方「对方的用户取消了这条消息，没有处理」，等待结束', () => {
    const x = fixture();
    x.watcher.add(x.w);
    const other: ReplyWatch = { ...x.w, id: 'w2', payload: `${fromHeader('A 会话', 's_a', 1, true, 'callZZ')}\n另一条` };
    x.watcher.add(other);
    const n = x.watcher.withdrawn('s_b', x.payload);
    assert.equal(n, 1);
    assert.equal(x.delivered.length, 1);
    assert.equal(x.delivered[0].sid, 's_a');
    assert.match(x.delivered[0].text, /cancelled this message|取消了这条消息，没有处理/);
    assert.deepEqual(x.watcher.list().map((w) => w.id), ['w2'], '只结束那一条');
    assert.deepEqual(x.saved().map((w) => w.id), ['w2']);
    assert.equal(x.watcher.withdrawn('s_a', other.payload), 0, '要对得上「发给谁」');
  });

  test('卡片里编辑过正文再删：来源那一行还在，照样找得到', () => {
    const x = fixture();
    x.watcher.add(x.w);
    const edited = rejoinQueueEdit(x.payload, '问：改过的问题');
    assert.equal(x.watcher.withdrawn('s_b', edited), 1);
  });
});

describe('发起方的「⏳ 等回复」标记', () => {
  test('replyWaitBadges：只列这条会话发出的，带对方、已等几分钟', () => {
    const x = fixture();
    const list: ReplyWatch[] = [
      x.w,
      { ...x.w, id: 'w2', from: 's_other', to: 's_b' },
    ];
    const b = replyWaitBadges(list, 's_a', x.w.since + 5 * 60_000 + 1000);
    assert.deepEqual(b, [{ id: 'w1', to: 's_b', toTitle: 'B 会话', minutes: 5, deadline: x.w.deadline }]);
    assert.deepEqual(replyWaitBadges(list, 's_nobody', x.w.since), []);
  });

  test('数据来源（watch 列表）在 restore 后一致：重启后标记照旧', () => {
    const x = fixture();
    x.watcher.add(x.w);
    x.watcher.turnStopped('s_b', 'switch'); // 记录里还没有那条：不改
    const onDisk = JSON.parse(JSON.stringify({ watches: x.saved() }));
    const y = fixture();
    y.watcher.restore(onDisk.watches);
    assert.deepEqual(y.watcher.list(), x.watcher.list());
    assert.deepEqual(replyWaitBadges(y.watcher.list(), 's_a', x.w.since + 60_000), replyWaitBadges(x.watcher.list(), 's_a', x.w.since + 60_000));
  });

  test('「不等了」：cancel 结束等待、落盘，之后不再唤醒；不存在的 id 返回 false', () => {
    const x = fixture();
    x.watcher.add(x.w);
    assert.equal(x.watcher.cancel('nope'), null);
    const gone = x.watcher.cancel('w1');
    assert.equal(gone?.to, 's_b');
    assert.equal(x.watcher.list().length, 0);
    assert.equal(x.saved().length, 0);
    x.tx.s_b.push({ id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10 });
    x.tx.s_b.push({ id: 'a1', role: 'assistant', content: '答了', ts: x.w.since + 20 });
    x.ticks(IDLE_CONFIRM_TICKS + 1);
    assert.equal(x.delivered.length, 0, '不再唤醒发起方');
  });

  test('等待一结束（回复 / 超时）列表就空了 —— 标记跟着消失', () => {
    const x = fixture();
    x.watcher.add(x.w);
    x.advance(1800_000);
    x.ticks(1);
    assert.equal(replyWaitBadges(x.watcher.list(), 's_a', x.now()).length, 0);
  });
});

describe('排队卡片的显示 / 编辑（纯函数）', () => {
  test('queueCardView：📨 的卡片显示「📨 来自会话「A」」+ 正文，不显示原始来源标记；普通卡片原样', () => {
    const x = fixture();
    const v = queueCardView(x.payload);
    assert.equal(v.from?.sessionId, 's_a');
    assert.match(String(v.from?.label), /A 会话/);
    assert.equal(v.body, '问：版本号是多少？');
    assert.doesNotMatch(v.body, /⟨session:/);
    assert.deepEqual(queueCardView('普通消息'), { from: null, body: '普通消息' });
  });

  test('rejoinQueueEdit：编辑的只是正文，保存时来源那一行原样接回去（call 编号不变）', () => {
    const x = fixture();
    const joined = rejoinQueueEdit(x.payload, '问：改过的问题');
    assert.equal(joined.split('\n')[0], x.payload.split('\n')[0]);
    assert.equal(parseHeader(joined)?.callId, 'call7x');
    assert.ok(joined.endsWith('问：改过的问题'));
    assert.equal(rejoinQueueEdit('普通', '改了'), '改了');
  });
});

describe('不抢用户输入框', () => {
  test('foreignDraftText：带 📨 来源标记的文字不能当草稿', () => {
    const x = fixture();
    assert.equal(foreignDraftText(x.payload), true);
    assert.equal(foreignDraftText(`[2 条排队消息已合并]\n${x.payload}`), true, '合并在中间的也算');
    assert.equal(foreignDraftText('我自己写的草稿'), false);
    assert.equal(foreignDraftText(''), false);
  });

  const SRC = path.join(import.meta.dirname, '..', 'src');
  const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

  test('接线：撤回排队里的 📨 不放回输入框、改为通知发起方；草稿的存 / 读 / 交接都过 foreignDraftText', () => {
    const app = read('renderer', 'App.tsx');
    const cancelAt = app.indexOf('const handleCancelQueuedMessage = useCallback(');
    assert.ok(cancelAt > 0);
    const cancelBody = app.slice(cancelAt, cancelAt + 1500);
    assert.match(cancelBody, /foreignDraftText\(item\.content\)/);
    assert.match(cancelBody, /replyWithdrawn/);
    const chat = read('renderer', 'components', 'ChatArea.tsx');
    assert.match(chat, /function stashComposerDraft[\s\S]{0,300}foreignDraftText/);
    assert.match(chat, /if \(foreignDraftText\(restoredDraft!\.text\)\) \{ onConsumeRestoredDraft/);
    assert.match(chat, /if \(foreignDraftText\(restoredInputDraft!\.text\)\) \{ onConsumeRestoredInputDraft/);
  });

  test('接线：Stop 带 user、停止并切换报切换结果、主进程据此告诉发起方；等回复的标记有 IPC 和推送', () => {
    const acp = read('renderer', 'hooks', 'useAcp.ts');
    assert.match(acp, /options\?\.suppressInterruptionNotice,\s*'user',/);
    assert.match(acp, /replyTurnSwitched\?\.\(sid, plan\.action !== 'none'\)/);
    const main = read('main', 'index.ts');
    assert.match(main, /if \(reason === 'user'\) replyWatcher\.turnStopped\(sessionId, 'user'\)/);
    assert.match(main, /ipcMain\.handle\('acp:reply-turn-switched'/);
    assert.match(main, /ipcMain\.handle\('acp:reply-withdrawn'/);
    assert.match(main, /ipcMain\.handle\('acp:reply-watches'/);
    assert.match(main, /ipcMain\.handle\('acp:reply-watch-cancel'/);
    assert.match(main, /webContents\.send\('acp:reply-watches-changed'/);
    const preload = read('main', 'preload.ts');
    for (const ch of ['acp:reply-turn-switched', 'acp:reply-withdrawn', 'acp:reply-watches', 'acp:reply-watch-cancel', 'acp:reply-watches-changed']) assert.ok(preload.includes(`'${ch}'`), ch);
  });
});
