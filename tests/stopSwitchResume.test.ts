/**
 * 「停止这一轮并立即切换」之后接着做这一轮 —— 两处实际流程（审查意见 2026-11-25）：
 *   · 会话间 session_send 等回复（ReplyWatcher）：续写那条不算「又来了一条用户消息」，
 *     停下到续写做完之间（hold）也不算空着 —— 回传的是续写做完后的完整回复，不是半截；
 *   · 循环 driver：停的是循环的一轮时，切换成功后在账本里接着做（没产出同一 id 重发、不另扣轮数；
 *     有产出记下续写 id 再发续写，按它答完才提交，重启后也按它判）；切换没成照原规则停下。
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplyWatcher, IDLE_CONFIRM_TICKS, findReply, fromHeader, type ReplyWatch } from '../src/main/sessionCalls.ts';
import { autoContinueMessageId, isAutoContinueMessageId, SWITCH_CONTINUE_PROMPT } from '../src/main/controlSessions.ts';
import { LoopDriver, loopRoundBlocker, type LoopDriverDeps, type DriverRun } from '../src/main/loopDriver.ts';
import * as loopStore from '../src/main/loopStore.ts';
import { type LoopSpec } from '../src/main/loopMachine.ts';
import { type MessageIdStatus } from '../src/main/promptDedupe.ts';

const ROOT = path.join(import.meta.dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
const hook = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
const stopFn = (): string => {
  const at = hook.indexOf('const stopAndSwitchNow = useCallback');
  return hook.slice(at, hook.indexOf('const rerunInterruptedTurn', at));
};

describe('会话间等回复：停止并切换后的续写算同一次任务', () => {
  const since = 5_000_000;
  const payload = `${fromHeader('A 会话', 's_a', 1, true, 'c7')}\n查一下部署日志`;
  const base = { id: 'user_xs_5000001_ab', role: 'user', content: payload, ts: since + 1 };
  const partial = { id: 'a1', role: 'assistant', content: '先看了 deploy.log 的前半段', ts: since + 2 };
  const note = { id: 'n1', role: 'user', kirolex: true, content: '✅ 已切到 模型 X', ts: since + 3 };
  const cont = { id: autoContinueMessageId(since + 4), role: 'user', content: SWITCH_CONTINUE_PROMPT, ts: since + 4 };
  const rest = { id: 'a2', role: 'assistant', content: '后半段也看完了：没有报错', ts: since + 5 };

  test('续写 id 认得出；findReply 跳过它、把前后两段都收进回复，不算 followedByUser', () => {
    assert.equal(isAutoContinueMessageId(cont.id), true);
    assert.equal(isAutoContinueMessageId('user_1_a'), false);
    const r = findReply([base, partial, note, cont, rest] as any, payload, since);
    assert.equal(r.found, true);
    assert.equal(r.followedByUser, false);
    assert.match(r.reply, /前半段/);
    assert.match(r.reply, /没有报错/);
    /* 你自己另发的一条照旧算这一轮结束 */
    assert.equal(findReply([base, partial, { id: 'user_9_x', role: 'user', content: '别的事', ts: since + 9 }] as any, payload, since).followedByUser, true);
  });

  test('ReplyWatcher：停下 → 挂着（hold）→ 续写跑完才回传完整回复', () => {
    let now = since + 10;
    const tx: any[] = [base, partial];
    let busy = true;
    const delivered: string[] = [];
    const w: ReplyWatch = { id: 'w1', from: 's_a', to: 's_b', toTitle: 'B', payload, since, deadline: since + 1800_000, timeoutSec: 1800, depth: 1 };
    const watcher = new ReplyWatcher({
      now: () => now, transcript: () => tx, isBusy: () => busy, exists: () => true, title: () => 'B',
      deliver: (_sid, text) => { delivered.push(text); },
      lastTurn: () => ({ state: 'completed', at: since + 3 }),   // 停下也是「正常收场」
    });
    watcher.add(w);
    /* 停下之后：这一轮结束了，但「停止并切换」挂着（main 的 isBusy 含 heldForTurnRecovery）—— 不回传 */
    for (let i = 0; i < IDLE_CONFIRM_TICKS + 2; i++) { watcher.tick(); now += 2000; }
    assert.equal(delivered.length, 0, '挂着的时候不能回传半截');
    /* 切换做完、续写发出并在跑 */
    tx.push(note, cont);
    for (let i = 0; i < IDLE_CONFIRM_TICKS + 2; i++) { watcher.tick(); now += 2000; }
    assert.equal(delivered.length, 0, '续写那条不算「又来了一条用户消息」');
    /* 续写做完、hold 摘掉 */
    tx.push(rest);
    busy = false;
    for (let i = 0; i < IDLE_CONFIRM_TICKS; i++) watcher.tick();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0], /前半段/);
    assert.match(delivered[0], /没有报错/, '回传的是续写做完后的完整回复');
  });

  test('接线：主进程等回复的 isBusy 含 hold；渲染端整段挂 hold、续写用 user_kcont_ id', () => {
    assert.match(main, /isBusy: \(id\) => .*heldForTurnRecovery\(id\)/);
    assert.match(main, /ipcMain\.handle\('acp:hold-turn-recovery'/);
    const body = stopFn();
    assert.match(body, /holdTurnRecovery\?\.\(sid, true\)/);
    assert.match(body, /holdTurnRecovery\?\.\(sid, false\)/);
    assert.match(body, /messageId: autoContinueMessageId\(\)/);
  });
});

/* ───────────────────────── 循环 ───────────────────────── */

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-loopswitch-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
const SID = 'sess_loop';

function spec(): LoopSpec {
  return {
    prompt: '修好它', goal: '检查通过',
    verifier: { level: 1, kind: 'command', command: 'check', timeoutSec: 30 },
    everySec: 0,
    stop: { maxIterations: 5, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 3 },
  };
}

function harness(switched: boolean | undefined) {
  const h = {
    now: 1_000_000,
    sends: [] as Array<{ text: string; messageId: string }>,
    status: new Map<string, MessageIdStatus>(),
    pending: [] as Array<(r: { ok: boolean }) => void>,
    notes: [] as string[],
    verifies: 0,
    awaited: [] as number[],
  };
  const deps: LoopDriverDeps = {
    home,
    now: () => h.now,
    canStart: () => true,
    send: (_sid, text, messageId) => {
      h.sends.push({ text, messageId });
      if (h.status.get(messageId) === undefined) h.status.set(messageId, 'unanswered');
      return new Promise((resolve) => { h.pending.push(resolve); });
    },
    verify: async () => { h.verifies += 1; return { ran: true, exitCode: 0, output: 'ok' }; },
    messageStatus: (_sid, id) => h.status.get(id) ?? 'absent',
    lastCompletedReply: () => null,
    sessionExists: () => true,
    note: (_sid, text) => { h.notes.push(text); },
    changed: () => {},
    lang: () => 'zh',
    ...(switched === undefined ? {} : { awaitSwitch: async (_sid: string, since: number) => { h.awaited.push(since); return switched; } }),
  };
  return { h, deps, d: new LoopDriver(deps) };
}
const stored = (): DriverRun => loopStore.readLoop(SID, home) as unknown as DriverRun;
async function waitFor(cond: () => boolean, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 5000) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('循环：停止并立即切换后由 driver 在账本里接着做', () => {
  test('这一轮还没产出：切换成功 → 同一个 id 重发，不另扣轮数；答完照常提交、校验', async () => {
    const { h, d } = harness(true);
    d.start(SID, spec());
    const step = d.tick();
    await waitFor(() => h.pending.length === 1, 'round 1 sent');
    const roundId = h.sends[0].messageId;
    assert.equal(d.holdForSwitch(SID), true);
    h.pending[0]({ ok: true });                           // 被停：没出字（unanswered）
    await waitFor(() => h.pending.length === 2, 'resent');
    assert.equal(h.sends[1].messageId, roundId, '同一个 id');
    assert.equal(h.sends[1].text, '修好它', '原样重发这一轮');
    assert.equal(stored().iteration, 1, '不另扣轮数');
    assert.ok(h.notes.some((n) => /还没开始做就被停下来切换了/.test(n)));
    h.status.set(roundId, 'answered');
    h.pending[1]({ ok: true });
    await step;
    assert.equal(h.verifies, 1);
    assert.equal(stored().terminal, 'no-op');   // 第一轮就通过 = no-op：这一轮提交、校验过了（没有被判 blocked）
  });

  test('这一轮已有产出：切换成功 → 记下续写 id（落盘）再发续写；按续写那条答完才提交', async () => {
    const { h, d } = harness(true);
    d.start(SID, spec());
    const step = d.tick();
    await waitFor(() => h.pending.length === 1, 'round 1 sent');
    const roundId = h.sends[0].messageId;
    d.holdForSwitch(SID);
    h.status.set(roundId, 'started');                     // 被停时已经出过字 / 跑过工具
    h.pending[0]({ ok: true });
    await waitFor(() => h.pending.length === 2, 'continuation sent');
    const cont = h.sends[1];
    assert.equal(cont.text, SWITCH_CONTINUE_PROMPT);
    assert.match(cont.messageId, new RegExp(`^${roundId}_c\\d+$`));
    assert.equal(stored().inFlight?.continueId, cont.messageId, '续写 id 和这一轮一起落盘');
    assert.equal(stored().inFlight?.messageId, roundId);
    assert.equal(loopRoundBlocker(home, SID, cont.messageId), null, '发送队列认得续写那条');
    assert.equal(stored().terminal ?? null, null, '没有停掉循环');
    assert.ok(h.notes.some((n) => /接着做这一轮/.test(n)));
    h.status.set(cont.messageId, 'answered');
    h.pending[1]({ ok: true });
    await step;
    assert.equal(h.verifies, 1, '答完才提交、校验');
    assert.equal(stored().terminal, 'no-op');   // 第一轮就通过 = no-op：这一轮提交、校验过了（没有被判 blocked）
    assert.equal(stored().iteration, 1);
  });

  test('续写途中重启：新 driver 按续写那条判（没开始 → 再发续写，不另扣轮数；答完 → 提交）', async () => {
    const a = harness(true);
    a.d.start(SID, spec());
    void a.d.tick();
    await waitFor(() => a.h.pending.length === 1);
    a.d.holdForSwitch(SID);
    a.h.status.set(a.h.sends[0].messageId, 'started');
    a.h.pending[0]({ ok: true });
    await waitFor(() => a.h.pending.length === 2);
    const contId = a.h.sends[1].messageId;
    /* 「重启」：换一个 driver，盘上 inFlight 带着 continueId */
    const b = harness(true);
    b.h.status.set(contId, 'unanswered');
    const step = b.d.tick();
    await waitFor(() => b.h.pending.length === 1, 'continuation resent after restart');
    assert.equal(b.h.sends[0].messageId, contId);
    assert.equal(b.h.sends[0].text, SWITCH_CONTINUE_PROMPT);
    b.h.status.set(contId, 'answered');
    b.h.pending[0]({ ok: true });
    await step;
    assert.equal(stored().terminal, 'no-op');   // 第一轮就通过 = no-op：这一轮提交、校验过了（没有被判 blocked）
    assert.equal(stored().iteration, 1);
  });

  for (const status of ['started', 'unanswered'] as const) {
    test(`切换没成（${status}）：照原来的规则停下，不重发、不续写`, async () => {
      const { h, d } = harness(false);
      d.start(SID, spec());
      const step = d.tick();
      await waitFor(() => h.pending.length === 1);
      d.holdForSwitch(SID);
      h.status.set(h.sends[0].messageId, status);
      h.pending[0]({ ok: true });
      await step;
      assert.equal(h.sends.length, 1, '不重发、不续写');
      assert.equal(stored().terminal, 'blocked');
      assert.equal(h.awaited.length, 1, '等过切换结果');
    });
  }

  test('没有挂 hold（普通停止）：行为不变，不等切换', async () => {
    const { h, d } = harness(true);
    d.start(SID, spec());
    const step = d.tick();
    await waitFor(() => h.pending.length === 1);
    h.status.set(h.sends[0].messageId, 'started');
    h.pending[0]({ ok: true });
    await step;
    assert.equal(h.awaited.length, 0);
    assert.equal(stored().terminal, 'blocked');
  });

  test('没有在跑的轮次就不挂', () => {
    const { d } = harness(true);
    assert.equal(d.holdForSwitch(SID), false);
  });

  test('接线：主进程把切换结果交给 driver；渲染端循环那条路先挂 hold、不停循环', () => {
    assert.match(main, /awaitSwitch: \(sid, since\) => awaitPendingSwitchResult\(sid, since\)/);
    assert.match(main, /notePendingSwitchOutcome\(sessionId, report\.failed\.length === 0\)/);
    assert.match(main, /ipcMain\.handle\('loop:hold-for-switch'/);
    const body = stopFn();
    assert.match(body, /loopHoldForSwitch\?\.\(sid\)/);
    assert.match(body, /if \(!looping\) endLoop\(sid, 'aborted'\)/);
  });
});
