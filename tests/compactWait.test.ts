import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  startCompactWait, noteCompactTurnEnd, noteCompactUsage, expireCompactWait, compactHolds, isCompactDrop,
  compactWaitRemainingMs, compactOnExecutorGone, routeCompactFrame, compactionStatusOf, compactFinishedLine, compactStartedLine, compactUsagePatch, settleCompactWait, armCompactTimeout, autoCompactNoteKind, COMPACT_WAIT_MAX_MS,
} from '../src/main/compactWait.ts';
import { finishTurnUsage, foldTurnFrame } from '../src/main/turnUsage.ts';
import { parseTranscriptText } from '../src/main/transcriptParse.ts';

/** kiro 的用量帧（和主进程喂给 foldTurnFrame 的形状一样） */
const meta = (pct: number, credits?: number) => ({
  sessionUpdate: '_kiro_internal', method: '_kiro.dev/metadata', contextUsagePercentage: pct,
  ...(credits !== undefined ? { meteringUsage: [{ value: credits }] } : {}),
});

describe('kiro 的 /compact：回了 end_turn 之后仍是压缩中（2026-11-28 卡死 15 分钟那次）', () => {
  test('① /compact 回 end_turn 后仍在压缩中：挡新消息', () => {
    let w = startCompactWait(0, 90);
    assert.equal(compactHolds(w), true);
    w = noteCompactTurnEnd(w, { engine: 'kiro', ok: true, now: 130, messageId: 'a_compact', replyTo: 'u_compact' });
    assert.equal(w.turnEnded, true);
    assert.equal(compactHolds(w), true, 'end_turn 不算压缩完成');
    // 压缩完成前的普通读数（89.9）也不算
    w = noteCompactUsage(w, meta(89.9, 11.5), 89.9, 1_000);
    assert.equal(compactHolds(w), true);
  });

  test('② 收到占用骤降的用量帧（带着压缩的花费）：压缩完成、放行', () => {
    let w = startCompactWait(0, 90);
    w = noteCompactTurnEnd(w, { engine: 'kiro', ok: true, now: 130, messageId: 'a_compact' });
    w = noteCompactUsage(w, meta(4, 11.5), 4, 46_800);
    assert.equal(compactHolds(w), false);
    assert.equal(w.finished?.by, 'drop');
    assert.equal(compactFinishedLine('s1', w), 'compacting sessionId=s1 finished pct=90->4 after 47s');
  });

  test('③ 3 分钟没等到完成信号：超时放行，日志说清楚', () => {
    let w = startCompactWait(0, 90);
    w = noteCompactTurnEnd(w, { engine: 'kiro', ok: true, now: 130 });
    assert.equal(expireCompactWait(w, COMPACT_WAIT_MAX_MS - 1).finished, undefined);
    assert.equal(compactWaitRemainingMs(w, 60_000), COMPACT_WAIT_MAX_MS - 60_000);
    w = expireCompactWait(w, COMPACT_WAIT_MAX_MS);
    assert.equal(compactHolds(w), false);
    assert.equal(w.finished?.by, 'timeout');
    assert.match(compactFinishedLine('s1', w), /^compacting sessionId=s1 timed out after 180s/);
    assert.equal(COMPACT_WAIT_MAX_MS, 180_000);
  });

  test('④ 压缩的花费归到压缩那一条：end_turn 之后到完成之间的帧攒在压缩这边', () => {
    let w = startCompactWait(0, 90);
    w = noteCompactTurnEnd(w, { engine: 'kiro', ok: true, now: 130, messageId: 'a_compact' });
    w = noteCompactUsage(w, meta(89.9, 11.5), 89.9, 1_000);
    w = noteCompactUsage(w, meta(4), 4, 46_800);
    assert.equal(compactHolds(w), false);
    // 骤降之后、收尾之前到的带花费的帧也算压缩的
    w = noteCompactUsage(w, meta(4, 0.5), 4, 46_900);
    const settled = settleCompactWait(w);
    const usage = finishTurnUsage(settled.acc, { engine: 'kiro' });
    assert.equal(usage?.credits, 12);
    assert.equal(usage?.contextPercent, 4);
    // 收尾之后的帧不再算压缩的（那是下一轮的）
    const after = noteCompactUsage(settled.wait, meta(6, 0.9), 6, 60_000);
    assert.equal(after.acc?.credits, 12, '没再往压缩那条上加');
    assert.equal(settleCompactWait(after).acc, undefined, '只收尾一次');
  });

  test('④ 补记行：读 transcript 时并进压缩那条助手消息，本身不成一条', () => {
    const lines = [
      { id: 'u_compact', role: 'user', content: '/compact', ts: 1 },
      { id: 'a_compact', role: 'assistant', content: 'Compacting conversation...', ts: 2, replyTo: 'u_compact' },
      compactUsagePatch('a_compact', { engine: 'kiro', credits: 11.5, contextPercent: 4 }, 3),
      { id: 'u_next', role: 'user', content: '下一条', ts: 4 },
      { id: 'a_next', role: 'assistant', content: '回答', ts: 5, turnUsage: { engine: 'kiro', credits: 0.9 } },
    ];
    const out = parseTranscriptText(lines.map((l) => JSON.stringify(l)).join('\n'));
    assert.deepEqual(out.map((m) => m.id), ['u_compact', 'a_compact', 'u_next', 'a_next']);
    assert.equal((out[1] as any).turnUsage.credits, 11.5);
    assert.equal((out[3] as any).turnUsage.credits, 0.9, '下一条用户消息那一轮只记它自己的');
  });

  test('压缩那一轮里就看到骤降（同步压完）：一轮结束即完成', () => {
    let w = startCompactWait(0, 80);
    w = noteCompactUsage(w, meta(5), 5, 50);
    assert.equal(compactHolds(w), true, '这一轮还在跑');
    w = noteCompactTurnEnd(w, { engine: 'kiro', ok: true, now: 100 });
    assert.equal(w.finished?.by, 'drop');
  });

  test('/compact 那一轮出错 / 被停：不再等', () => {
    const w = noteCompactTurnEnd(startCompactWait(0, 90), { engine: 'kiro', ok: false, now: 100 });
    assert.equal(compactHolds(w), false);
    assert.equal(w.finished?.by, 'error');
  });
});

describe('Claude Code / Codex：/compact 同步完成，不受影响', () => {
  for (const engine of ['claude', 'codex'] as const) {
    test(`${engine}：一轮结束就算压完`, () => {
      const w = noteCompactTurnEnd(startCompactWait(0, 90), { engine, ok: true, now: 5_000 });
      assert.equal(compactHolds(w), false);
      assert.equal(w.finished?.by, 'sync');
      assert.match(compactFinishedLine('s1', w), /finished pct=90->\? after 5s \(sync\)/);
    });
  }
});

describe('骤降判据', () => {
  test('掉 10 个点或掉到 70% 以下', () => {
    assert.equal(isCompactDrop(90, 89.9), false);
    assert.equal(isCompactDrop(90, 80), true);
    assert.equal(isCompactDrop(15, 10), true);
    assert.equal(isCompactDrop(15, 12), false);
    assert.equal(isCompactDrop(null, 4), false, '不知道之前多少：只能等超时');
  });
  test('日志：started', () => {
    assert.equal(compactStartedLine('s1'), 'compacting sessionId=s1 started');
  });
});

describe('3 分钟超时的定时器（审查回归：认批次号，不认对象 —— end_turn / 用量帧之后状态都换成了新对象）', () => {
  /** 和主进程 `beginCompactWait` 同样的接法：entry 上放当前状态，get/set 读写它；定时器换成手动拨的假钟 */
  function harness() {
    let clock = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const entry: { compactWait?: ReturnType<typeof startCompactWait> } = {};
    const released: string[] = [];
    const arm = () => armCompactTimeout({
      batch: entry.compactWait!.batch,
      startedAt: entry.compactWait!.startedAt,
      get: () => entry.compactWait,
      set: (w) => { entry.compactWait = w; },
      onExpired: () => { released.push(entry.compactWait!.finished!.by); },
      now: () => clock,
      setTimer: (fn, ms) => { timers.push({ at: clock + ms, fn }); return timers.length; },
    });
    const advance = (to: number) => { clock = to; for (const t of timers.splice(0)) { if (t.at <= to) t.fn(); else timers.push(t); } };
    return { entry, released, arm, advance, setClock: (v: number) => { clock = v; } };
  }

  test('end_turn、普通用量帧之后没有骤降：180 秒后仍放行（等着的消息照常发出）', () => {
    const h = harness();
    h.entry.compactWait = startCompactWait(0, 90);
    h.arm();
    h.setClock(130);
    h.entry.compactWait = noteCompactTurnEnd(h.entry.compactWait, { engine: 'kiro', ok: true, now: 130, messageId: 'a_compact' });
    h.setClock(1_000);
    h.entry.compactWait = noteCompactUsage(h.entry.compactWait, meta(89.9, 11.5), 89.9, 1_000);
    h.advance(COMPACT_WAIT_MAX_MS - 1);
    assert.deepEqual(h.released, [], '还没到点');
    assert.equal(compactHolds(h.entry.compactWait), true);
    h.advance(COMPACT_WAIT_MAX_MS + 100);
    assert.deepEqual(h.released, ['timeout']);
    assert.equal(compactHolds(h.entry.compactWait), false);
    assert.equal(h.entry.compactWait!.messageId, 'a_compact', '超时处理的是当前状态，前面记下的都还在');
  });

  test('骤降已经放行了：到点什么都不做', () => {
    const h = harness();
    h.entry.compactWait = startCompactWait(0, 90);
    h.arm();
    h.entry.compactWait = noteCompactTurnEnd(h.entry.compactWait, { engine: 'kiro', ok: true, now: 130 });
    h.entry.compactWait = noteCompactUsage(h.entry.compactWait, meta(4, 11.5), 4, 40_000);
    h.advance(COMPACT_WAIT_MAX_MS + 100);
    assert.deepEqual(h.released, []);
    assert.equal(h.entry.compactWait!.finished?.by, 'drop');
  });

  test('又发了一次 /compact（新批次）：上一批的定时器不碰新的这批', () => {
    const h = harness();
    h.entry.compactWait = startCompactWait(0, 90);
    h.arm();
    h.setClock(60_000);
    h.entry.compactWait = startCompactWait(60_000, 90);
    h.arm();
    h.advance(COMPACT_WAIT_MAX_MS + 100);
    assert.deepEqual(h.released, [], '旧定时器到点：批次号对不上，不动');
    assert.equal(compactHolds(h.entry.compactWait), true);
    h.advance(60_000 + COMPACT_WAIT_MAX_MS + 100);
    assert.deepEqual(h.released, ['timeout']);
  });

  test('批次号每次都不同', () => {
    assert.notEqual(startCompactWait(0, 1).batch, startCompactWait(0, 1).batch);
  });
});

describe('自动压缩做完留的那一句：只有主进程确认压完了才说「已压缩」（审查回归）', () => {
  test('骤降 / 同步引擎一轮结束 → 已压缩', () => {
    assert.equal(autoCompactNoteKind('drop', true), 'done');
    assert.equal(autoCompactNoteKind('sync', true), 'done');
  });
  test('3 分钟没等到完成信号 → 不说已完成', () => {
    assert.equal(autoCompactNoteKind('timeout', true), 'unconfirmed');
  });
  test('那一轮出错 / 一直没收到结果 → 没成功', () => {
    assert.equal(autoCompactNoteKind('drop', false), 'failed');
    assert.equal(autoCompactNoteKind('error', true), 'failed');
    assert.equal(autoCompactNoteKind(null, true), 'failed');
  });
});

describe('发 /compact 时还不知道占用：第一次读数当基准（真机截图日志 pct=?->90 那次）', () => {
  test('压缩那一轮报 90 → 基准 90；之后骤降到 4 → 放行', () => {
    let w = startCompactWait(0, null);
    w = noteCompactUsage(w, meta(90, 0.01), 90, 100);
    assert.equal(w.pctBefore, 90);
    assert.equal(compactHolds(w), true, '基准那一帧本身不算完成');
    w = noteCompactTurnEnd(w, { engine: 'kiro', ok: true, now: 130 });
    assert.equal(compactHolds(w), true);
    w = noteCompactUsage(w, meta(4, 11.5), 4, 40_000);
    assert.equal(w.finished?.by, 'drop');
    assert.equal(compactFinishedLine('s1', w), 'compacting sessionId=s1 finished pct=90->4 after 40s');
  });
  test('end_turn 之后才来第一帧：同样当基准，不当完成', () => {
    let w = noteCompactTurnEnd(startCompactWait(0, null), { engine: 'kiro', ok: true, now: 130 });
    w = noteCompactUsage(w, meta(89.9, 11.5), 89.9, 1_000);
    assert.equal(compactHolds(w), true);
    assert.equal(w.acc?.credits, 11.5, '花费照样记在压缩这边');
  });
});

describe('界面：压缩的花费晚到（你的下一条已经在界面上了）也挂到压缩那一条上（真机截图回归）', () => {
  test('界面上的 id 和主进程落盘的不同：按 turnStart 在那一轮之内找，不挂到最后', async () => {
    const { attachTurnUsage } = await import('../src/renderer/turnUsageView.ts');
    const list = [
      { id: 'u_compact', role: 'user' },
      { id: 'ui_assist_1', role: 'assistant' },   // "Compacting conversation..."（界面自己的 id）
      { id: 'u_next', role: 'user' },             // 压完后放行的那一条已经在界面上
    ];
    const out = attachTurnUsage(list as any[], 'a_main_id', { engine: 'kiro', credits: 11.5 } as any, () => ({ id: 'a_main_id', role: 'assistant' }) as any, 'u_compact');
    assert.equal(out.length, 3, '不补一条空回复');
    assert.equal((out[1] as any).turnUsage.credits, 11.5);
    assert.equal((out[2] as any).turnUsage, undefined);
  });
});

describe('压缩的花费归属按协议关：下一轮出输出之前到的计量都算压缩的（审查回归：不靠 3 秒窗口）', () => {
  /** 和主进程 wireSession 同样的走法：每一帧 routeCompactFrame；close → 关上归属（这一帧算新一轮）；toCompact 的不进正在跑的那一轮 */
  function sim(pctBefore: number | null = 90) {
    const st = { w: startCompactWait(0, pctBefore) as ReturnType<typeof startCompactWait> | undefined, turnAcc: undefined as any, inTurn: true, released: 0 };
    const feed = (update: any, now: number) => {
      const pct = typeof update?.contextUsagePercentage === 'number' ? update.contextUsagePercentage : null;
      const r = routeCompactFrame(st.w, { inTurn: st.inTurn, update, pct, now });
      if (r.close) st.w = settleCompactWait(st.w!).wait;
      if (r.wait) { st.w = r.wait; if (r.released) st.released++; }
      if (r.settleAfter) st.w = settleCompactWait(st.w!).wait;
      if (st.inTurn && !r.toCompact) st.turnAcc = foldTurnFrame(st.turnAcc, update, null);
    };
    /* /compact 那一轮结束：主进程把这一轮攒的挪到压缩那边（没压完时） */
    const compactTurnEnd = (now: number) => {
      st.w = noteCompactTurnEnd(st.w!, { engine: 'kiro', ok: true, now, messageId: 'a_compact' });
      if (!st.w.finished) { st.w = { ...st.w, acc: st.turnAcc }; }
      st.turnAcc = undefined;
      st.inTurn = false;
    };
    const nextTurnStarts = () => { st.inTurn = true; st.turnAcc = undefined; };
    const compactCredits = () => finishTurnUsage(st.w!.acc, { engine: 'kiro' })?.credits;
    const turnCredits = () => finishTurnUsage(st.turnAcc, { engine: 'kiro' })?.credits;
    return { st, feed, compactTurnEnd, nextTurnStarts, compactCredits, turnCredits };
  }
  const chunk = (t: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });

  test('骤降 → 马上放行 → 队列那条开始发送 → 4 秒后压缩的 11.5 才到：仍记在压缩那条，下一轮只记它自己的', () => {
    const s = sim();
    s.feed(chunk('Compacting conversation...'), 100);
    s.feed(meta(90, 0.01), 110);                       // /compact 那一轮自己的计量
    s.compactTurnEnd(130);
    s.feed(meta(4, 0), 40_000);                         // 骤降
    assert.equal(compactHolds(s.st.w), false, '骤降就放行，不再等');
    assert.equal(s.st.released, 1);
    s.nextTurnStarts();                                  // 排着的那条发出去了
    s.feed(meta(4, 11.5), 44_000);                       // 4 秒后（超过原来的 3 秒窗口）才到的压缩花费
    assert.equal(s.compactCredits(), 11.51, '压缩那条：0.01 + 11.5');
    assert.equal(s.turnCredits(), undefined, '下一轮一分没记');
    s.feed(chunk('好的，'), 45_000);                     // 下一轮出输出：归属关上
    assert.equal(s.st.w!.settled, true);
    s.feed(meta(5, 0.9), 46_000);                        // 下一轮自己的计量
    assert.equal(s.turnCredits(), 0.9);
    assert.equal(s.compactCredits(), 11.51, '关上之后不再往压缩那条上加');
  });

  test('花费先到、骤降后到（真机假 kiro 的顺序）：照样都算压缩的', () => {
    const s = sim();
    s.feed(meta(90, 0.01), 110);
    s.compactTurnEnd(130);
    s.feed(meta(89.9, 11.5), 8_000);
    assert.equal(compactHolds(s.st.w), true);
    s.feed(meta(4, 0), 8_200);
    assert.equal(s.st.w!.finished?.by, 'drop');
    assert.equal(s.compactCredits(), 11.51);
  });

  test('压缩之后的下一轮一直不出输出（被吞那种）：它结束前到的计量都算压缩的；之后主进程在那一轮结束时关上', () => {
    const s = sim();
    s.compactTurnEnd(130);
    s.feed(meta(4, 0), 40_000);
    s.nextTurnStarts();
    s.feed(meta(4, 11.5), 60_000);
    assert.equal(s.compactCredits(), 11.5);
    assert.equal(s.turnCredits(), undefined);
  });

  test('压缩的 11.5 记上之后，下一轮一个字没出就结束、报了它自己的 0.9：两轮分别记 11.5 和 0.9（审查回归）', () => {
    const s = sim();
    s.feed(meta(90, 0.01), 110);
    s.compactTurnEnd(130);
    s.feed(meta(4, 0), 40_000);                          // 骤降，放行
    s.nextTurnStarts();
    s.feed(meta(4, 11.5), 41_000);                        // 压缩那一笔
    assert.equal(s.st.w!.settled, true, '压缩那一笔到了：归属关上');
    s.feed(meta(5, 0.9), 42_000);                         // 下一轮结束时报自己的（没有任何输出）
    assert.equal(s.compactCredits(), 11.51, '压缩那条：0.01 + 11.5，没有 0.9');
    assert.equal(s.turnCredits(), 0.9, '下一轮记它自己的 0.9');
  });

  test('花费先到、骤降后到：花费那一帧就关上归属，之后的骤降照样让压缩完成', () => {
    const s = sim();
    s.compactTurnEnd(130);
    s.feed(meta(89.9, 11.5), 8_000);
    assert.equal(s.st.w!.settled, true);
    assert.equal(compactHolds(s.st.w), true, '还在压缩中');
    s.feed(meta(4, 0), 8_200);
    assert.equal(s.st.w!.finished?.by, 'drop');
    assert.equal(s.compactCredits(), 11.5);
  });

  test('kiro 自己报的 _kiro.dev/compaction/status：完成就放行（不必等骤降）；开始 / 认不出不动', () => {
    const st = (status: string) => ({ sessionUpdate: '_kiro_internal', method: '_kiro.dev/compaction/status', status });
    assert.equal(compactionStatusOf(st('started')), 'started');
    assert.equal(compactionStatusOf(st('completed')), 'completed');
    assert.equal(compactionStatusOf({ sessionUpdate: '_kiro_internal', method: '_kiro.dev/compaction/status', state: 'Failed' }), 'failed');
    assert.equal(compactionStatusOf({ sessionUpdate: '_kiro_internal', method: '_kiro.dev/compaction/status' }), null);
    assert.equal(compactionStatusOf(meta(4, 0)), null);
    const s = sim();
    s.compactTurnEnd(130);
    s.feed(st('started'), 1_000);
    assert.equal(compactHolds(s.st.w), true);
    s.feed(st('completed'), 30_000);
    assert.equal(s.st.w!.finished?.by, 'notice');
    assert.equal(autoCompactNoteKind('notice', true), 'done');
  });

  test('/compact 那一轮还没结束就报了完成：不提前放行，一轮结束时算完成', () => {
    const s = sim();
    s.feed({ sessionUpdate: '_kiro_internal', method: '_kiro.dev/compaction/status', status: 'completed' }, 100);
    assert.equal(compactHolds(s.st.w), true);
    s.compactTurnEnd(130);
    assert.equal(s.st.w!.finished?.by, 'drop');
  });
});

describe('压缩中换模型（审查回归：换模型失败回滚时 entry 被整份复制，定时器改的是旧对象，新执行器永远报 compacting）', () => {
  test('执行器被换成 { ...旧entry } 的复制品：3 分钟定时器按会话读此刻挂着的那个，到点照样放行', () => {
    let clock = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const sessionClients = new Map<string, { compactWait?: ReturnType<typeof startCompactWait> }>();
    const released: string[] = [];
    const old = { compactWait: startCompactWait(0, 90) };
    sessionClients.set('s1', old);
    /* 和主进程 beginCompactWait 同样的接法：get / set / onExpired 都按会话 id 去 sessionClients 里取 */
    armCompactTimeout({
      batch: old.compactWait.batch,
      startedAt: 0,
      get: () => sessionClients.get('s1')?.compactWait,
      set: (w) => { const live = sessionClients.get('s1'); if (live) live.compactWait = w; },
      onExpired: () => { released.push(sessionClients.get('s1')!.compactWait!.finished!.by); },
      now: () => clock,
      setTimer: (fn, ms) => { timers.push({ at: clock + ms, fn }); return timers.length; },
    });
    old.compactWait = noteCompactTurnEnd(old.compactWait, { engine: 'kiro', ok: true, now: 130 });
    /* 换模型失败、回滚：新对象，复制了还没完成的压缩状态 */
    const restored = { ...old };
    sessionClients.set('s1', restored);
    clock = COMPACT_WAIT_MAX_MS + 100;
    for (const t of timers.splice(0)) if (t.at <= clock) t.fn();
    assert.deepEqual(released, ['timeout'], '到点放行');
    assert.equal(compactHolds(sessionClients.get('s1')!.compactWait), false, '现在挂着的那个不再报压缩中，消息能发');
  });

  test('压缩中请求换模型：切换先记下，压缩完成之前不应用；完成后 kick 才应用', async () => {
    const { PendingSwitchBook, PendingSwitchRunner } = await import('../src/main/pendingSwitch.ts');
    const book = new PendingSwitchBook();
    const entry: { busy: boolean; compactWait?: ReturnType<typeof startCompactWait> } = { busy: false };
    entry.compactWait = noteCompactTurnEnd(startCompactWait(0, 90), { engine: 'kiro', ok: true, now: 130 });
    const applied: string[] = [];
    /* 和主进程同样的 isBusy：一轮在跑 / 压缩中都算 */
    const runner = new PendingSwitchRunner(book, {
      /* 和主进程同样的接法：isBusy 看一轮在跑，isHeld 看压缩中 */
      isBusy: () => entry.busy,
      isHeld: () => compactHolds(entry.compactWait),
      apply: async (_sid, entries) => { applied.push(...entries.map((e) => e.label)); },
    });
    book.set('s1', { kind: 'model', value: { model: 'claude-sonnet-5' }, label: 'claude-sonnet-5' });
    assert.equal(runner.kick('s1'), undefined, 'end_turn 之后还在压缩：不切');
    await runner.settle('s1');
    assert.deepEqual(applied, [], '发送前 settle 也不切');
    entry.compactWait = noteCompactUsage(entry.compactWait!, meta(4, 11.5), 4, 40_000);
    await runner.kick('s1');
    assert.deepEqual(applied, ['claude-sonnet-5'], '压完了才切');
  });
});

describe('压缩中执行器断线 / 摘掉（审查回归：删了 sessionClients 却没收压缩，界面一直压缩中、在等的发送永远挂着）', () => {
  /** 和主进程同样的接法：sessionClients / compactWaiters / 定时器按会话读此刻挂着的执行器；断线、detach 先 endCompactWaitForExecutor */
  function world() {
    let clock = 0;
    const timers: { at: number; fn: () => void; handle: { dead?: boolean } }[] = [];
    const sessionClients = new Map<string, { compactWait?: ReturnType<typeof startCompactWait>; timer?: { dead?: boolean } }>();
    const waiters: Array<() => void> = [];
    const events: string[] = [];
    const abandon = (why: string) => { events.push('abandon:' + why); for (const go of waiters.splice(0)) go(); events.push('compacting:false'); };
    const endForExecutor = (why: string) => {
      const e = sessionClients.get('s1');
      const plan = compactOnExecutorGone(e?.compactWait, waiters.length > 0);
      if (plan.clear && e) { if (e.timer) e.timer.dead = true; e.compactWait = undefined; }
      if (plan.abandon) abandon(why);
    };
    const begin = () => {
      const e = sessionClients.get('s1')!;
      e.compactWait = startCompactWait(clock, 90);
      const handle = { dead: false };
      e.timer = handle;
      armCompactTimeout({
        batch: e.compactWait.batch, startedAt: clock,
        get: () => sessionClients.get('s1')?.compactWait,
        set: (w) => { const l = sessionClients.get('s1'); if (l) l.compactWait = w; },
        onExpired: () => { events.push('timeout'); for (const go of waiters.splice(0)) go(); },
        onGone: () => { if (waiters.length) abandon('timer found no executor'); },
        now: () => clock,
        setTimer: (fn, ms) => { timers.push({ at: clock + ms, fn, handle }); return handle; },
      });
    };
    /* 主进程 endCompactWaitForExecutor 里 clearTimeout 掉的定时器（handle.dead）不再跑 */
    const advance = (to: number) => { clock = to; for (const t of timers.splice(0)) { if (t.handle.dead) continue; if (t.at <= to) t.fn(); else timers.push(t); } };
    /* awaitCompactRelease：还在压缩中就登记等着 */
    const send = () => new Promise<string>((resolve) => {
      const e = sessionClients.get('s1');
      if (!e || !compactHolds(e.compactWait)) { resolve(e ? 'sent' : 'not-connected'); return; }
      /* 和主进程一样：放行之后 sendPromptOnce 是在下一个微任务里接着走的（那时 sessionClients.delete 已经做完） */
      waiters.push(() => queueMicrotask(() => resolve(sessionClients.get('s1') ? 'sent' : 'not-connected')));
    });
    return { sessionClients, events, begin, advance, send, endForExecutor, setClock: (v: number) => { clock = v; } };
  }

  test('压缩中断线：立刻放行在等的发送（走「没连着」那条恢复路）、告诉界面不再压缩中', async () => {
    const w = world();
    w.sessionClients.set('s1', {});
    w.begin();
    const e = w.sessionClients.get('s1')!;
    e.compactWait = noteCompactTurnEnd(e.compactWait!, { engine: 'kiro', ok: true, now: 130 });
    const pending = w.send();
    w.endForExecutor('executor disconnected');   // 断线：主进程在 sessionClients.delete 之前调
    w.sessionClients.delete('s1');
    assert.equal(await pending, 'not-connected', '在等的那条放行了，接着走断线恢复');
    assert.deepEqual(w.events, ['abandon:executor disconnected', 'compacting:false']);
  });

  test('断线后过了 3 分钟：定时器已经停了，不会再动什么；重连后新执行器不在压缩中，消息照常发', async () => {
    const w = world();
    w.sessionClients.set('s1', {});
    w.begin();
    void w.send();
    w.endForExecutor('executor disconnected');
    w.sessionClients.delete('s1');
    w.advance(COMPACT_WAIT_MAX_MS + 100);
    assert.deepEqual(w.events, ['abandon:executor disconnected', 'compacting:false'], '没有第二次放行 / 超时');
    w.sessionClients.set('s1', {});   // 重连（loadSessionImpl 直接 set 一个新的 entry）
    assert.equal(await w.send(), 'sent');
  });

  test('兜底：执行器没经过收尾就没了（状态丢了）—— 3 分钟定时器到点照样放行', async () => {
    const w = world();
    w.sessionClients.set('s1', {});
    w.begin();
    const pending = w.send();
    w.sessionClients.set('s1', {});   // 换成一个没有压缩状态的执行器，且没走 endForExecutor
    w.advance(COMPACT_WAIT_MAX_MS + 100);
    assert.equal(await pending, 'sent');
    assert.deepEqual(w.events, ['abandon:timer found no executor', 'compacting:false']);
  });

  test('判据：压完了的只清状态；还在压缩中 / 有在等的才作废放行；什么都没有不动', () => {
    const holding = noteCompactTurnEnd(startCompactWait(0, 90), { engine: 'kiro', ok: true, now: 1 });
    const done = noteCompactUsage(holding, meta(4, 11.5), 4, 2);
    assert.deepEqual(compactOnExecutorGone(holding, false), { clear: true, abandon: true });
    assert.deepEqual(compactOnExecutorGone(done, false), { clear: true, abandon: false });
    assert.deepEqual(compactOnExecutorGone(undefined, true), { clear: false, abandon: true });
    assert.deepEqual(compactOnExecutorGone(undefined, false), { clear: false, abandon: false });
  });
});
