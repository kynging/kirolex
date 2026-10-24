/**
 * loop 的 driver 在主进程（loopDriver.ts）——守的是 docs/loop-engineering-notes.md §13 的几条性质：
 *   · 状态机整个在主进程里跑：决定下一轮、发送、等结果、校验、停止，不需要任何窗口；
 *   · 窗口刷新 / 不在（`changed` 发不出去）不打断正在跑的 loop；
 *   · KiroLex 重启（同一份 loop-runs 文件上换一个新的 driver）后接着跑，已扣的轮次不重复扣；
 *   · 幂等账本：进行中的那一轮按 transcript 判 —— 已落地不重发，in-doubt 停下报出来，没交给模型的原样重发；
 *   · 定时触发（复用 schedule.ts 的 dueAt）和「某会话一轮结束」事件触发。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoopDriver, type LoopDriverDeps, type DriverRun } from '../src/main/loopDriver.ts';
import * as loopStore from '../src/main/loopStore.ts';
import { type LoopSpec } from '../src/main/loopMachine.ts';
import { type MessageIdStatus } from '../src/main/promptDedupe.ts';
import { splitNoteDetail } from '../src/main/kirolexNote.ts';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-loopdriver-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const SID = 'sess_a';

function spec(over: Partial<LoopSpec> = {}): LoopSpec {
  return {
    prompt: '修好它',
    goal: '检查通过',
    verifier: { level: 1, kind: 'command', command: 'check', timeoutSec: 30 },
    everySec: 0,
    stop: { maxIterations: 5, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 3 },
    ...over,
  };
}

/** 一个假的主进程：时钟、发送、校验、transcript 都在这里，可以在任意一刻"重启"（换一个新 driver）。 */
function harness(opts: { autoAnswer?: boolean } = {}) {
  const h = {
    now: 1_000_000,
    sends: [] as Array<{ sid: string; text: string; messageId: string }>,
    status: new Map<string, MessageIdStatus>(),
    verdicts: [] as Array<{ ran: boolean; exitCode: number | null; output: string }>,
    verifies: 0,
    notes: [] as Array<{ sid: string; text: string }>,
    dropped: [] as string[],
    lastReply: new Map<string, string | null>(),
    canStart: true,
    /** 发送挂起（模拟一轮还在跑）：由测试手动 resolve */
    pending: [] as Array<(r: { ok: boolean; error?: string }) => void>,
    changedThrows: false,
    changes: 0,
  };
  const deps: LoopDriverDeps = {
    home,
    now: () => h.now,
    canStart: () => h.canStart,
    send: (sid, text, messageId) => {
      h.sends.push({ sid, text, messageId });
      if (h.status.get(messageId) === undefined) h.status.set(messageId, 'unanswered');
      if (opts.autoAnswer === false) return new Promise((resolve) => { h.pending.push(resolve); });
      h.status.set(messageId, 'answered');
      return Promise.resolve({ ok: true });
    },
    verify: async () => { h.verifies += 1; return h.verdicts.shift() ?? { ran: true, exitCode: 1, output: 'still failing' }; },
    messageStatus: (_sid, id) => h.status.get(id) ?? 'absent',
    lastCompletedReply: (sid) => h.lastReply.get(sid) ?? null,
    sessionExists: (sid) => sid !== 'ghost',
    note: (sid, text) => { h.notes.push({ sid, text }); },
    changed: () => { h.changes += 1; if (h.changedThrows) throw new Error('window is reloading'); },
    dropPending: (id) => { h.dropped.push(id); },
    lang: () => 'zh',
  };
  return { h, deps, driver: () => new LoopDriver(deps) };
}

const stored = (): DriverRun => loopStore.readLoop(SID, home) as unknown as DriverRun;

describe('driver 状态机在主进程里跑', () => {
  test('失败一轮 → 回灌校验输出 → 第二轮通过 = success；轮次 id 确定、计数落盘', async () => {
    const { h, driver } = harness();
    const d = driver();
    h.verdicts.push({ ran: true, exitCode: 1, output: '3 failing: a,b,c' }, { ran: true, exitCode: 0, output: 'ok' });
    const r = d.start(SID, spec());
    assert.equal(r.ok, true);
    await d.tick();                       // 第 1 轮：发 + 校验（失败）
    await d.tick();                       // 第 2 轮：发 + 校验（通过）
    assert.equal(h.sends.length, 2);
    const run = stored();
    assert.equal(run.terminal, 'success');
    assert.equal(run.iteration, 2);
    assert.equal(h.sends[0].messageId, loopStore.roundMessageId(run, 1));
    assert.equal(h.sends[1].messageId, loopStore.roundMessageId(run, 2));
    assert.equal(h.sends[0].text, '修好它');
    assert.match(h.sends[1].text, /3 failing: a,b,c/, '上一轮的校验输出必须回灌进下一轮');
    assert.ok(h.notes.some((n) => /第 1 轮校验未通过/.test(n.text)), '每轮校验结果留在会话里（结束那条提示的详情）');
    assert.ok(h.notes.some((n) => /循环结束：目标达成/.test(n.text)), '终止原因写进会话');
    assert.equal(d.list().length, 0);
    await d.tick();
    assert.equal(h.sends.length, 2, '结束之后不再发');
  });

  test('每轮校验结果折进同一张卡片（记在 run 上，不每轮写一条进会话）；结束那条提示的详情里带上每一轮', async () => {
    const { h, driver } = harness();
    const d = driver();
    h.verdicts.push({ ran: true, exitCode: 1, output: '3 failing: a,b,c' }, { ran: true, exitCode: 1, output: '1 failing: c' }, { ran: true, exitCode: 0, output: 'ok' });
    d.start(SID, spec());
    await d.tick();
    await d.tick();
    assert.equal(h.notes.length, 0, '跑的期间不往会话里一轮一条地写');
    const mid = stored();
    assert.equal(mid.verdictRounds?.length, 2);
    assert.match(mid.verdictRounds![0].zh.line, /第 1 轮校验未通过/);
    assert.match(mid.verdictRounds![0].en.line, /Round 1 check failed/);
    assert.equal(mid.verdictRounds![1].zh.output, '1 failing: c');
    await d.tick();
    assert.equal(h.notes.length, 1, '结束时只写一条');
    const { main, detail } = splitNoteDetail(h.notes[0].text);
    assert.match(main, /✅ 循环结束：目标达成/);
    assert.match(detail, /第 1 轮校验未通过[\s\S]*3 failing: a,b,c[\s\S]*第 2 轮[\s\S]*第 3 轮校验通过/);
    assert.doesNotMatch(h.notes[0].text, /[❌⛔⏰🔁♻]/u, 'emoji 只用 notices-glossary 的四个');
  });

  test('窗口在刷新（changed 抛错 / 没人听）不打断 loop', async () => {
    const { h, driver } = harness();
    h.changedThrows = true;
    const d = driver();
    h.verdicts.push({ ran: true, exitCode: 1, output: 'x' }, { ran: true, exitCode: 1, output: 'y' }, { ran: true, exitCode: 0, output: 'ok' });
    d.start(SID, spec());
    for (let i = 0; i < 3; i++) await d.tick();
    assert.equal(h.sends.length, 3);
    assert.equal(stored().terminal, 'success');
    assert.ok(h.changes > 0, '照样尝试通知窗口');
  });

  test('一轮还在跑的时候窗口刷新：driver 照样等它结束、接着校验（不重发、不另起一轮）', async () => {
    const { h, driver } = harness({ autoAnswer: false });
    const d = driver();
    h.verdicts.push({ ran: true, exitCode: 0, output: 'ok' });
    d.start(SID, spec());
    const first = d.tick();
    await waitFor(() => h.pending.length === 1);
    h.changedThrows = true;               // 窗口刷新了
    await d.tick();                       // 刷新期间的 tick：这一轮是自己的，不碰
    assert.equal(h.sends.length, 1);
    h.status.set(h.sends[0].messageId, 'answered');
    h.pending[0]({ ok: true });
    await first;
    assert.equal(stored().terminal, 'no-op');
    assert.equal(h.sends.length, 1);
  });

  test('立即触发 + everySec：两轮之间按落盘的 nextAt 等', async () => {
    const { h, driver } = harness();
    const d = driver();
    d.start(SID, spec({ everySec: 120 }));
    await d.tick();
    assert.equal(h.sends.length, 1);
    h.now += 60_000;
    await d.tick();
    assert.equal(h.sends.length, 1, '还没到 120 秒');
    h.now += 61_000;
    await d.tick();
    assert.equal(h.sends.length, 2);
  });

  test('用户停止：aborted、撤掉还排着的那条、迟到的发送结果不复活它', async () => {
    const { h, driver } = harness({ autoAnswer: false });
    const d = driver();
    d.start(SID, spec());
    const first = d.tick();
    await waitFor(() => h.pending.length === 1);
    assert.equal(d.stop(SID, 'aborted'), true);
    assert.deepEqual(h.dropped, [h.sends[0].messageId]);
    h.pending[0]({ ok: true });
    await first;
    assert.equal(stored().terminal, 'aborted');
    assert.equal(h.verifies, 0, '停掉之后不再校验');
    await d.tick();
    assert.equal(h.sends.length, 1);
    assert.ok(h.notes.some((n) => /用户手动停止/.test(n.text)));
    assert.equal(d.stop(SID, 'aborted'), false, '已经停了');
  });

  test('删会话 = discarded：记录删掉、不往会话里写', async () => {
    const { h, driver } = harness();
    const d = driver();
    d.start(SID, spec({ everySec: 999 }));
    await d.tick();
    const before = h.notes.length;
    assert.equal(d.stop(SID, 'discarded'), true);
    assert.equal(loopStore.readLoop(SID, home), null);
    assert.equal(h.notes.length, before);
  });

  test('同一会话再启动一个：旧的 superseded，新的从第 1 轮开始', async () => {
    const { h, driver } = harness();
    const d = driver();
    d.start(SID, spec({ everySec: 999 }));
    await d.tick();
    d.start(SID, spec({ prompt: '新的', everySec: 999 }));
    assert.ok(h.notes.some((n) => /被新启动的循环替换/.test(n.text)));
    await d.tick();
    assert.equal(h.sends.length, 2);
    assert.equal(h.sends[1].text, '新的');
    assert.equal(stored().iteration, 1);
    assert.notEqual(h.sends[0].messageId, h.sends[1].messageId, '两个 loop 的轮次 id 不能撞');
  });

  test('等待退出（canStart 为假）期间不开新一轮', async () => {
    const { h, driver } = harness();
    h.canStart = false;
    const d = driver();
    d.start(SID, spec());
    await d.tick();
    assert.equal(h.sends.length, 0);
    h.canStart = true;
    await d.tick();
    assert.equal(h.sends.length, 1);
  });

  test('旧版本（renderer 驱动）留下的记录不被续跑', async () => {
    const { h, driver } = harness();
    loopStore.writeLoop(SID, { spec: spec() as any, sessionId: SID, iteration: 1, startedAt: 1, terminal: null }, home);
    const d = driver();
    assert.equal(d.list().length, 0);
    await d.tick();
    assert.equal(h.sends.length, 0);
  });

  test('启动时校验：不能由自己的一轮结束触发、不能定时只跑一次', () => {
    const { driver } = harness();
    const d = driver();
    const self = d.start(SID, spec({ trigger: { kind: 'turn-end', sessionId: SID } }));
    assert.equal(self.ok, false);
    const ghost = d.start(SID, spec({ trigger: { kind: 'turn-end', sessionId: 'ghost' } }));
    assert.equal(ghost.ok, false);
    const once = d.start(SID, spec({ trigger: { kind: 'schedule', schedule: { kind: 'once' as any, everySec: 0 } } }));
    assert.equal(once.ok, false);
    const tooFast = d.start(SID, spec({ trigger: { kind: 'schedule', schedule: { kind: 'interval', everySec: 5 } } }));
    assert.equal(tooFast.ok, false, '间隔下限和定时任务同一条（60 秒）');
    assert.equal(loopStore.readLoop(SID, home), null);
  });
});

describe('重启后接着跑（新 driver，同一份文件）', () => {
  test('两轮之间重启：已扣的轮次不重复扣，下一轮是第 2 轮', async () => {
    const a = harness();
    const d1 = a.driver();
    d1.start(SID, spec({ everySec: 60 }));
    await d1.tick();
    assert.equal(stored().iteration, 1);
    // ——重启——：新进程里的 driver 什么都不记得，只有盘上的记录
    const d2 = new LoopDriver(a.deps);
    a.h.now += 61_000;
    await d2.tick();
    assert.equal(a.h.sends.length, 2);
    assert.equal(stored().iteration, 2);
    assert.equal(a.h.sends[1].messageId, loopStore.roundMessageId(stored(), 2));
  });

  test('校验阶段重启：只重跑校验，不重发', async () => {
    const a = harness();
    const d1 = a.driver();
    a.h.verdicts.push({ ran: false, exitCode: null, output: 'ssh: connect timed out' }, { ran: true, exitCode: 0, output: 'ok' });
    d1.start(SID, spec());
    await d1.tick();                        // 发 + 校验跑不起来 → 等重试校验
    assert.equal(stored().phase, 'verify');
    const d2 = new LoopDriver(a.deps);
    a.h.now += 16_000;
    await d2.tick();
    assert.equal(a.h.sends.length, 1, '校验重试不花一个 model turn');
    assert.equal(stored().terminal, 'no-op');
  });
});

describe('幂等账本：进行中的那一轮', () => {
  /** 第 1 轮已经扣费、标了 in-flight、交给后端了，然后进程死了。 */
  async function crashMidRound(): Promise<{ a: ReturnType<typeof harness>; messageId: string }> {
    const a = harness({ autoAnswer: false });
    const d1 = a.driver();
    d1.start(SID, spec());
    void d1.tick();
    await waitFor(() => a.h.pending.length === 1);
    const run = stored();
    assert.equal(run.iteration, 1);
    assert.equal(run.inFlight?.messageId, a.h.sends[0].messageId, '发送前 in-flight 已经落盘');
    return { a, messageId: a.h.sends[0].messageId };
  }

  test('in-doubt（模型已经出过字 / 跑过工具、没跑完）：不重发，停下并报出来', async () => {
    const { a, messageId } = await crashMidRound();
    a.h.status.set(messageId, 'started');
    const d2 = new LoopDriver(a.deps);
    await d2.tick();
    await d2.tick();
    assert.equal(a.h.sends.length, 1, 'in-doubt 绝不重发');
    const run = stored();
    assert.equal(run.terminal, 'blocked');
    assert.deepEqual(run.inDoubt, { iteration: 1, messageId });
    assert.equal(run.iteration, 1);
    assert.ok(a.h.notes.some((n) => /第 1 轮已经开始执行.*没有重发/.test(n.text)), '会话里说清楚为什么停');
    assert.equal(a.h.verifies, 0);
  });

  test('已落地（完整回复在盘上）：不重发，直接校验；不再扣轮次', async () => {
    const { a, messageId } = await crashMidRound();
    a.h.status.set(messageId, 'answered');
    a.h.verdicts.push({ ran: true, exitCode: 0, output: 'ok' });
    const d2 = new LoopDriver(a.deps);
    await d2.tick();
    assert.equal(a.h.sends.length, 1);
    assert.equal(a.h.verifies, 1);
    const run = stored();
    assert.equal(run.iteration, 1);
    assert.equal(run.terminal, 'no-op');
    assert.ok(a.h.notes.some((n) => /重启前已经跑完，不再重发/.test(n.text)));
  });

  test('没交给模型（absent / unanswered）：原样重发同一轮、同一个 id，不再扣轮次', async () => {
    for (const status of ['absent', 'unanswered'] as const) {
      const { a, messageId } = await crashMidRound();
      if (status === 'absent') a.h.status.delete(messageId); else a.h.status.set(messageId, 'unanswered');
      const d2 = new LoopDriver({ ...a.deps, send: (sid, text, id) => { a.h.sends.push({ sid, text, messageId: id }); a.h.status.set(id, 'answered'); return Promise.resolve({ ok: true }); } });
      a.h.verdicts.push({ ran: true, exitCode: 0, output: 'ok' });
      await d2.tick();
      assert.equal(a.h.sends.length, 2, status);
      assert.equal(a.h.sends[1].messageId, messageId, `${status}：同一个 id 重发（promptDedupe 不会再追加一条用户消息）`);
      assert.equal(stored().iteration, 1, `${status}：不再扣轮次`);
      assert.equal(stored().terminal, 'no-op');
      fs.rmSync(path.join(home, '.kirolex'), { recursive: true, force: true });
    }
  });

  test('发送报错时也看账本：已经开始做了 = in-doubt，没开始 = 发送失败；都是 blocked、不自动重发', async () => {
    const { a, messageId } = await crashMidRound();
    a.h.status.set(messageId, 'started');
    a.h.pending[0]({ ok: false, error: 'executor died' });
    await waitFor(() => stored().terminal === 'blocked');
    assert.equal(stored().inDoubt?.messageId, messageId);

    fs.rmSync(path.join(home, '.kirolex'), { recursive: true, force: true });
    const b = await crashMidRound();
    b.a.h.pending[0]({ ok: false, error: 'Session not connected' });
    await waitFor(() => stored().terminal === 'blocked');
    assert.equal(stored().inDoubt ?? null, null);
    assert.ok(b.a.h.notes.some((n) => /没能发出去：Session not connected/.test(n.text)));
  });

  /*
    审查意见 1：唤醒队列的 ok 只表示 sendPromptOnce 没抛 —— 一轮被 max_tokens 截断、被取消、被看门狗打断时它也正常返回。
    这时盘上没有完整回复（replyComplete 只在正常结束时打），不能提交、不能校验、更不能开下一轮。
  */
  for (const [why, status] of [['输出被截断（max_tokens）', 'started'], ['看门狗判卡死打断', 'started']] as const) {
    test(`发送"成功"返回但这一轮没完整结束（${why}）：不提交、不校验，按 in-doubt 停下`, async () => {
      const { a, messageId } = await crashMidRound();
      a.h.status.set(messageId, status);           // 出过字 / 跑过工具，但没有 replyComplete
      a.h.pending[0]({ ok: true });
      await waitFor(() => stored().terminal === 'blocked', 'blocked');
      const run = stored();
      assert.deepEqual(run.inDoubt, { iteration: 1, messageId });
      assert.equal(run.phase, 'wait', '没有进入校验阶段');
      assert.equal(a.h.verifies, 0, '没完整结束的一轮不校验');
      assert.ok(a.h.notes.some((n) => /第 1 轮已经开始执行.*没有重发/.test(n.text)));
      // 重启后也还是这个结论，不会被当成已落地
      await new LoopDriver(a.deps).tick();
      assert.equal(a.h.sends.length, 1);
      assert.equal(a.h.verifies, 0);
    });
  }

  test('发送"成功"返回但模型什么都没做（没有回复、没开始）：停下并说清楚，不当成完成', async () => {
    const { a } = await crashMidRound();
    a.h.pending[0]({ ok: true });                  // 状态仍是 unanswered
    await waitFor(() => stored().terminal === 'blocked', 'blocked');
    assert.equal(a.h.verifies, 0);
    assert.equal(stored().inDoubt ?? null, null);
    assert.ok(a.h.notes.some((n) => /第 1 轮没有完整回复就结束了/.test(n.text)));
  });

  test('tryStartRound：扣轮次和 in-flight 在同一次写里；已有 in-flight 时不再扣', () => {
    const { driver } = harness();
    driver().start(SID, spec());
    const first = loopStore.tryStartRound(SID, home, 5);
    assert.equal(first.run?.iteration, 1);
    const onDisk = stored();
    assert.equal(onDisk.iteration, 1);
    assert.equal(onDisk.inFlight?.messageId, first.inFlight?.messageId);
    const again = loopStore.tryStartRound(SID, home, 6);
    assert.equal(again.run?.iteration, 1, '同一轮不扣两次');
    assert.equal(again.inFlight?.messageId, first.inFlight?.messageId);
    const committed = loopStore.commitRound(SID, home, 'not-this-one', 7);
    assert.ok(committed?.inFlight, '对不上 id 的提交不关这一轮');
    loopStore.commitRound(SID, home, first.inFlight!.messageId, 8);
    assert.equal(stored().inFlight, null);
  });
});

describe('定时触发（schedule.ts 的 dueAt）', () => {
  test('间隔：首轮立即，之后按上一轮开始时间 + 间隔', async () => {
    const { h, driver } = harness();
    const d = driver();
    d.start(SID, spec({ trigger: { kind: 'schedule', schedule: { kind: 'interval', everySec: 3600 } } }));
    await d.tick();
    assert.equal(h.sends.length, 1, '间隔任务首轮立即跑（同定时任务）');
    h.now += 3599_000;
    await d.tick();
    assert.equal(h.sends.length, 1);
    h.now += 1_000;
    await d.tick();
    assert.equal(h.sends.length, 2);
  });

  test('每天 09:00：晚上建的不会立刻跑，第二天 09:00 才跑；重启后照样按点', async () => {
    const a = harness();
    const evening = new Date(2026, 9, 24, 20, 0, 0).getTime();
    a.h.now = evening;
    const d1 = a.driver();
    d1.start(SID, spec({ trigger: { kind: 'schedule', schedule: { kind: 'daily', everySec: 0, atTime: '09:00' } } }));
    await d1.tick();
    assert.equal(a.h.sends.length, 0, '已经过了今天 09:00 的那个点，不立刻跑');
    const nextMorning = new Date(2026, 9, 25, 9, 0, 0).getTime();
    assert.equal(stored().nextAt, nextMorning);
    const d2 = new LoopDriver(a.deps);          // 中间重启了一次
    a.h.now = nextMorning - 1000;
    await d2.tick();
    assert.equal(a.h.sends.length, 0);
    a.h.now = nextMorning + 5000;
    await d2.tick();
    assert.equal(a.h.sends.length, 1);
    assert.equal(stored().nextAt, new Date(2026, 9, 26, 9, 0, 0).getTime(), '下一个点按 dueAt 算，不随这一轮的耗时漂移');
  });
});

describe('事件触发：某会话一轮结束', () => {
  test('启动前已有的回复不算；对方每结束一轮开一轮；跑的期间来的多次合并成一次', async () => {
    const { h, driver } = harness({ autoAnswer: false });
    h.lastReply.set('sess_src', 'reply_old');
    const d = driver();
    d.start(SID, spec({ verifier: { level: 0, kind: 'none' }, trigger: { kind: 'turn-end', sessionId: 'sess_src' } }));
    await d.tick();
    assert.equal(h.sends.length, 0, '启动前那条回复不触发');
    h.lastReply.set('sess_src', 'reply_1');
    const first = d.tick();
    await waitFor(() => h.sends.length === 1);
    h.lastReply.set('sess_src', 'reply_2');     // 这一轮还在跑，对方又结束了两轮
    h.lastReply.set('sess_src', 'reply_3');
    await d.tick();
    assert.equal(h.sends.length, 1, '自己这一轮没结束不开下一轮');
    h.status.set(h.sends[0].messageId, 'answered');   // 这一轮正常收尾（完整回复落盘）
    h.pending[0]({ ok: true });
    await first;
    const second = d.tick();
    await waitFor(() => h.sends.length === 2);
    h.status.set(h.sends[1].messageId, 'answered');
    h.pending[1]({ ok: true });
    await second;
    await d.tick();
    assert.equal(h.sends.length, 2, '跑的期间来的几次合并成一次');
    assert.equal(stored().lastTriggerSeen, 'reply_3');
  });

  test('等事件的期间时长上限照样生效', async () => {
    const { h, driver } = harness();
    const d = driver();
    d.start(SID, spec({ trigger: { kind: 'turn-end', sessionId: 'sess_src' }, stop: { maxIterations: 5, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 3, maxWallClockSec: 60 } }));
    h.now += 61_000;
    await d.tick();
    assert.equal(stored().terminal, 'exhausted');
    assert.equal(h.sends.length, 0);
  });
});

async function waitFor(cond: () => boolean, what = 'condition', timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
