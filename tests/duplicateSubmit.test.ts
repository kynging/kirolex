import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canRetrySame, decidePromptDedupe, InFlightPrompts, messageIdStatus, reviseMessageId, turnCompletedNormally } from '../src/main/promptDedupe.ts';
import { QueueBackoff, queuedBatchMessageId, pickQueuedBatch, sealRetryBatch, isDuplicateMessageError } from '../src/renderer/queueRetry.ts';
import { planRetry, maxRetriesFor } from '../src/main/promptRetry.ts';

/*
  「网络不稳时同一条消息被反复发进会话（改写提交重复 11 次）+ 远端连不上时预检刷屏」。

  第一部分是**模拟**：按 index.ts 的同一套规则（`InFlightPrompts` + `decidePromptDedupe`）搭一个最小的
  "主进程发送"，在里面造会话忙、网络失败、窗口重载，数落盘几条、发给模型几次。
  第二部分是**接线**（源码扫描）：index.ts / App.tsx / useAcp.ts 真的接上了这些规则。
*/

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf-8');
const M = read('main', 'index.ts');
const APP = read('renderer', 'App.tsx');
const HK = read('renderer', 'hooks', 'useAcp.ts');

/**
 * 一个最小的"主进程"：transcript、发给模型的次数、工具跑了几次、网络坏几次。规则照 index.ts：
 *   · 发之前 `decidePromptDedupe`（盘上 + `started`，后者照 noteTurnStarted / record.startedMessageIds 落盘）；
 *   · `failAt: 'before-output'`：模型还什么都没做就断了（没出字、没跑工具）；
 *   · `failAt: 'after-tools'`：模型跑了一个工具、出了半句之后断了 —— noteTurnStarted 记下，出错时 flush 半截（带 replyTo）。
 * `state` 可以传进来：模拟窗口重载 / 主进程重启后接着用盘上那份。
 */
type FakeState = { transcript: { id: string; role: string; content: string; replyTo?: string; replyComplete?: boolean }[]; started: string[] };
function fakeMain(opts: { failFirst?: number; failAt?: 'before-output' | 'after-tools'; state?: FakeState } = {}) {
  const state: FakeState = opts.state ?? { transcript: [], started: [] };
  const transcript = state.transcript;
  let modelCalls = 0;
  let toolRuns = 0;
  let failuresLeft = opts.failFirst || 0;
  const inflight = new InFlightPrompts<string>();
  const sendPromptOnce = async (sid: string, text: string, messageId?: string) => {
    const status = messageId ? messageIdStatus(transcript, messageId, new Set(state.started)) : 'absent';
    const d = decidePromptDedupe({ explicitId: !!messageId, attempt: 0, status });
    if (d.action === 'reject') {
      throw d.reason === 'started'
        ? Object.assign(new Error('This message already started running last time and was cut off'), { code: 'started' })
        : Object.assign(new Error('already sent and answered'), { code: 'dup' });
    }
    const uid = messageId || `u_${transcript.length}`;
    if (d.persist) transcript.push({ id: uid, role: 'user', content: text });
    await new Promise((r) => setTimeout(r, 5));               // 这一轮在跑
    modelCalls += 1;
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      if (opts.failAt === 'after-tools') {
        toolRuns += 1;
        state.started.push(uid);                                // noteTurnStarted
        /* 和 flushAssistant 一样：出错时 flush 的半截只带 replyTo，正常收尾的那份才带 replyComplete */
        transcript.push({ id: `p_${transcript.length}`, role: 'assistant', content: '半截', replyTo: uid });
      }
      throw new Error('dispatch failure');
    }
    transcript.push({ id: `a_${transcript.length}`, role: 'assistant', content: 'ok', replyTo: uid, replyComplete: true });
    return 'ok';
  };
  const prompt = (sid: string, text: string, messageId?: string) => inflight.run(sid, messageId, () => sendPromptOnce(sid, text, messageId));
  return { state, transcript, prompt, get modelCalls() { return modelCalls; }, get toolRuns() { return toolRuns; } };
}

describe('模拟：同一条改写提交最多落盘一次、发给模型一次', () => {
  const ticket = 'rv:promo.md#3:1:abcd';
  const id = reviseMessageId(ticket, 'block');
  const userLines = (t: { role: string }[]) => t.filter((m) => m.role === 'user').length;

  test('会话忙（reconfiguring）时同一次提交被请求了好几次 → 合并成一次', async () => {
    const main = fakeMain();
    const all = await Promise.all([1, 2, 3].map(() => main.prompt('s', '【改写 · promo.md 第 10 行】210k', id)));
    assert.deepEqual(all, ['ok', 'ok', 'ok']);
    assert.equal(userLines(main.transcript), 1);
    assert.equal(main.modelCalls, 1);
  });

  test('网络失败之后用同一个 id 重试 → 会话里还是只有一条用户消息', async () => {
    const main = fakeMain({ failFirst: 1 });
    await assert.rejects(main.prompt('s', '【改写】x', id), /dispatch failure/);
    assert.equal(await main.prompt('s', '【改写】x', id), 'ok');
    assert.equal(userLines(main.transcript), 1);
    assert.equal(main.transcript.filter((m) => m.role === 'assistant' && m.replyComplete).length, 1, '完整回复只有一份（失败那次留下的半截不算）');
  });

  test('A 网络失败、你另发 B 成功了、再重试 A → A 照样发出去（不被 B 的回复误判成答过了），也不多存一条', async () => {
    const main = fakeMain({ failFirst: 1 });
    await assert.rejects(main.prompt('s', 'A', 'queue_A'), /dispatch failure/);
    assert.equal(await main.prompt('s', 'B', 'queue_B'), 'ok');
    assert.equal(await main.prompt('s', 'A', 'queue_A'), 'ok');
    assert.equal(main.transcript.filter((m) => m.id === 'queue_A').length, 1);
    assert.equal(main.modelCalls, 3);
    await assert.rejects(main.prompt('s', 'A', 'queue_A'), /already sent and answered/, 'A 答过了之后再来就拒');
  });

  test('窗口重载后同一次提交又来一次（已经答过了）→ 拒绝：不追加、不再发给模型', async () => {
    const main = fakeMain();
    await main.prompt('s', '【改写】x', id);
    await assert.rejects(main.prompt('s', '【改写】x', id), /already sent and answered/);
    assert.equal(userLines(main.transcript), 1);
    assert.equal(main.modelCalls, 1);
  });

  test('对照：没有 messageId 的老路（u_<时间戳>）重试三次就是三条 —— 这就是那 11 条的来历', async () => {
    const main = fakeMain({ failFirst: 2 });
    for (let i = 0; i < 3; i++) await main.prompt('s', '【改写】x').catch(() => {});
    assert.equal(userLines(main.transcript), 3);
  });

  test('排队消息发失败、放回队头再发：同一批条目 → 同一个 id → 只落盘一次', async () => {
    const main = fakeMain({ failFirst: 2 });
    const items = [{ id: 'queue_1_ab' }];
    for (let i = 0; i < 3; i++) await main.prompt('s', 'hello', queuedBatchMessageId(items)).catch(() => {});
    assert.equal(userLines(main.transcript), 1);
    assert.equal(main.modelCalls, 3, '前两次网络失败，第三次才成 —— 每次都真的发了，但只有一条消息');
  });
});

describe('模拟：被停掉 / 截断 / 卡死的那一轮之后，用同一个 id 重试', () => {
  /* 和 flushAssistant 一样：回复都带 replyTo，只有 turnCompletedNormally 的才带 replyComplete */
  const after = (stopReason: string, wedged = false) => [
    { id: 'queue_A', role: 'user' },
    { id: 'a1', role: 'assistant', replyTo: 'queue_A', ...(turnCompletedNormally({ stopReason, wedged }) ? { replyComplete: true } : {}) },
  ];
  for (const [name, stopReason, wedged] of [['被停掉（cancelled）', 'cancelled', false], ['截断（max_tokens）', 'max_tokens', false], ['卡死被打断', 'end_turn', true]] as const) {
    test(`${name}（已经出过字）→ 不算答过，但模型已经开始做了：同一个 id 不自动再发（要重来点重跑）`, () => {
      const status = messageIdStatus(after(stopReason, wedged), 'queue_A');
      assert.equal(status, 'started');
      assert.deepEqual(decidePromptDedupe({ explicitId: true, attempt: 0, status }), { action: 'reject', reason: 'started' });
    });
  }
  test('正常结束（end_turn）→ 答过了：同一个 id 再来就拒', () => {
    const status = messageIdStatus(after('end_turn'), 'queue_A');
    assert.deepEqual(decidePromptDedupe({ explicitId: true, attempt: 0, status }), { action: 'reject', reason: 'answered' });
  });
});

describe('模拟：远端预检失败期间调用方不会紧循环；本机会话不等它', () => {
  test('排空 effect 每 100ms 跑一次、远端每次都立刻失败：4 分钟里只去试十来次；本机会话照常每次都能发', () => {
    const backoff = new QueueBackoff();
    let remoteTries = 0;
    let localSends = 0;
    for (let now = 0; now < 4 * 60_000; now += 100) {
      if (!backoff.blocked('remote', now)) { remoteTries += 1; backoff.fail('remote', now); }
      if (!backoff.blocked('local', now)) { localSends += 1; backoff.ok('local'); }
    }
    assert.ok(remoteTries <= 12, `远端试了 ${remoteTries} 次（原来是 ~2400 次）`);
    assert.equal(localSends, 2400, '本机会话一次都没被挡');
  });
});

describe('接线：主进程', () => {
  test('sendPromptOnce 一进来先去重（在应用切换 / 取 entry / 落盘之前），在盘上没答的不再追加', () => {
    const at = M.indexOf('async function sendPromptOnce(');
    const head = M.slice(at, at + 1500);
    assert.ok(head.indexOf('promptDedupeFor(sessionId, display?.messageId, attempt)') > 0);
    assert.ok(head.indexOf('promptDedupeFor(') < head.indexOf('pendingSwitchRunner.settle'));
    assert.match(M, /\} else if \(!dedupe\.persist\) \{\s*\n\s*\/\* 同一个 messageId 上一次没发成/);
    const fn = M.slice(M.indexOf('function promptDedupeFor('), M.indexOf('const askWaiters = new Map'));
    /* 查的是 checkId：调用方给的 messageId，自动重发（attempt > 0）没给时是这一轮的 currentUserMessageId */
    assert.match(fn, /store\.messageIdStatusOnDisk\(sessionId, checkId\)/);
    assert.match(fn, /code: DUPLICATE_MESSAGE/);
    /* 已经开始执行过的：拒绝自动再发、在会话里说清楚（同一条只说一次） */
    assert.match(fn, /if \(dedupe\.action === 'reject' && dedupe\.reason === 'started'\) \{/);
    assert.match(fn, /noteInSession\(sessionId, tr\('⚠️ This message already started running last time[^']*'\), undefined, `started-not-resent:\$\{checkId\}`\);/);
    assert.match(fn, /code: DUPLICATE_STARTED/);
  });

  test('"答过了"按回复记下的 replyTo + replyComplete 认：只有正常收尾那一处标完成', () => {
    const fl = M.slice(M.indexOf('function flushAssistant('), M.indexOf('function flushAssistant(') + 2200);
    assert.match(fl, /const replyTo = entry\?\.currentUserMessageId;/);
    assert.match(fl, /\.\.\.\(replyTo && completedFor === replyTo \? \{ replyComplete: true as const \} : \{\}\),/);
    /* 只在正常收尾那一处、而且只有 end_turn 且没卡死时才标完成（被停掉 / 截断 / 卡死的不算） */
    assert.match(M, /if \(turnCompletedNormally\(\{ stopReason: result\?\.stopReason, wedged: !!entry\.wedgeNote \}\)\) entry\.completedReplyTo = userMessageId;\n\s*flushAssistant\(sessionId\); \/\/ turn complete/);
    assert.equal((M.match(/entry\.completedReplyTo = userMessageId;/g) || []).length, 1, '出错 / 取消那两处 flush 不标完成');
  });

  test('acp:prompt 和 askOnce 都走 promptsInFlight：同一个 id 正在跑就合并', () => {
    const h = M.slice(M.indexOf("ipcMain.handle('acp:prompt'"), M.indexOf('async function sendPromptOnce('));
    assert.match(h, /promptsInFlight\.run\(sessionId, display\?\.messageId, \(\) => sendPromptOnce\(/);
    const ask = M.slice(M.indexOf('const askOnce = '), M.indexOf('const askOnce = ') + 1500);
    assert.match(ask, /promptsInFlight\.run\(sessionId, messageId, \(\) => sendPromptOnce\(sessionId, \[\{ type: 'text', text: prompt \}\], undefined, \{ displayText, \.\.\.\(messageId \? \{ messageId \} : \{\}\) \}\)\)/);
  });

  test('改写：id 跟着 ticket 走（三次 askOnce 里改写那两次都带），失败在会话里说清楚', () => {
    const at = M.indexOf("ipcMain.handle('review:revise-in-session'");
    const body = M.slice(at, at + 16000);
    assert.match(body, /\(askedId = reviseMessageId\(input\?\.ticket, wantScope, prompt\)\),/);
    assert.match(body, /\(askedId = reviseMessageId\(input\?\.ticket, 'patch', followUp, true\)\),/);
    /* 问过模型之后失败：只有模型对这一问还什么都没做时才带 retrySame（retrySameIf）—— 已经开始做了的不再按同一次来 */
    assert.equal((body.match(/return \{ ok: false, error: usable\.why, \.\.\.retrySameIf\(sessionId, askedId\) \};/g) || []).length, 2);
    assert.match(body, /\.\.\.retrySameIf\(sessionId, askedId, err\)/);
    const rs = M.slice(M.indexOf('function retrySameIf('), M.indexOf('function retrySameIf(') + 500);
    assert.match(rs, /if \(err\?\.code === DUPLICATE_MESSAGE \|\| err\?\.code === DUPLICATE_STARTED\) return \{\};/);
    assert.match(rs, /return canRetrySame\(store\.messageIdStatusOnDisk\(sessionId, messageId\)\) \? \{ retrySame: true \} : \{\};/);
    /* 同一问早就完整答过了：用盘上那份，不再发 */
    assert.match(M, /storedReplyFor\(sessionId, messageId\) \?\? new Promise\(\(resolve, reject\) => \{/);
    assert.match(M.slice(M.indexOf('function storedReplyFor('), M.indexOf('function storedReplyFor(') + 600), /store\.completedReplyOnDisk\(sessionId, messageId\)/);
    assert.match(body, /if \(err\?\.code !== DUPLICATE_MESSAGE && err\?\.code !== DUPLICATE_STARTED\) \{[\s\S]{0,300}noteInSession\(sessionId, tr\('❌ The revision of \{what\} did not go through/);
  });

  test('「已排队」同一次提交只说一次', () => {
    const fn = M.slice(M.indexOf('function enqueueRevise<T>('), M.indexOf('function enqueueRevise<T>(') + 2000);
    assert.match(fn, /const noticedBefore = !!noticeKey && reviseQueuedNoticed\.has\(noticeKey\);/);
    assert.match(fn, /if \(label && !noticedBefore\) \{/);
  });

  test('熔断期间的「跳过」日志每个窗口只记一行', () => {
    const fn = M.slice(M.indexOf('async function runPreflight('), M.indexOf('async function runPreflight(') + 1500);
    assert.match(fn, /if \(!last \|\| now - last\.at >= BREAKER_MS\) \{\s*\n\s*logger\.info\('remote', `preflight \$\{host\}: 跳过/);
    assert.match(fn, /last\.skipped \+= 1;/);
  });

  test('本机会话的创建 / 挂载不等远端预检：remotePreflight 只在 remote 分支里调，在路上的那次按机器分', () => {
    assert.match(M, /const running = preflightInFlight\.get\(host\);/);
    for (const anchor of ["ipcMain.handle('acp:new-session'", 'const loadSessionImpl = async (']) {
      const at = M.indexOf(anchor);
      assert.ok(at > 0, anchor);
      const body = M.slice(at, at + 16000);
      const call = body.indexOf('await remotePreflight(profile.remote)');
      assert.ok(call > 0, `${anchor} 里有 remotePreflight`);
      const guard = body.lastIndexOf('if (profile.remote?.sshHost) {', call);
      assert.ok(guard > 0 && call - guard < 1500, `${anchor}：remotePreflight 要在 remote 分支里`);
    }
  });
});

describe('接线：渲染端', () => {
  test('排空 effect：退避期内跳过；messageId 跟着条目走；失败按会话退避、到点叫醒；答过的不放回去', () => {
    const at = APP.indexOf('// Drain every session independently when it becomes idle.');
    const body = APP.slice(at, at + 7000);
    assert.match(body, /queueBackoffRef\.current\.blocked\(sessionId, Date\.now\(\)\) \|\|/);
    assert.match(body, /const picked = pickQueuedBatch\(queue, settings\.mergeQueuedMessages && !queue\[0\]\.afterRebuild, queuedBatch\);/);
    assert.match(body, /messageId: picked\.messageId,/);
    /* 没发成的那一批放回去时盖上 id 和边界，重试完成前不重新分批 */
    assert.match(body, /const restored = sealRetryBatch\(consumed\.filter\(\(item\) => !existingIds\.has\(item\.id\)\), picked\.messageId\);/);
    assert.match(body, /\.then\(\(\) => \{ queueBackoffRef\.current\.ok\(sessionId\); \}\)/);
    assert.match(body, /const retryAt = queueBackoffRef\.current\.fail\(sessionId, now\);/);
    assert.match(body, /window\.setTimeout\(\(\) => setQueueRetryTick\(\(n\) => n \+ 1\)/);
    assert.match(body, /if \(isDuplicateMessageError\(String\(error\?\.message \|\| error\)\)\) \{/);
    assert.match(body, /\s+queueRetryTick,\n/);
  });

  test('sendQueuedMessage：挂载失败也把乐观插入的气泡收回去（不然每重试一次多一个）', () => {
    const at = HK.indexOf('const sendQueuedMessage = useCallback(');
    const body = HK.slice(at, at + 9000);
    assert.match(body, /\} catch \(attachError\) \{[\s\S]{0,200}undoOptimistic\(\);\s*\n\s*throw attachError;/);
    /* 主进程说这一条已经在盘上（答过了 / 上次已经开始执行）时气泡留着 —— 它就是盘上那条 */
    assert.match(body, /if \(deliveryError\) \{[\s\S]{0,200}?if \(!isDuplicateMessageError\(String\(deliveryError\?\.message \|\| deliveryError\)\)\) undoOptimistic\(\);/);
  });
});

describe('接线：回复的去重标记贯通渲染层的读、写和整份重写', () => {
  const ST = read('main', 'sessionStore.ts');
  test('读回来的五处映射、写回去的 toStoredTranscript 都带 replyMarksOf', () => {
    assert.equal((HK.match(/\.\.\.replyMarksOf\(m\),/g) || []).length, 6);
    const ts = HK.slice(HK.indexOf('function toStoredTranscript('), HK.indexOf('function toStoredTranscript(') + 1800);
    assert.match(ts, /\.\.\.replyMarksOf\(m\),/);
    const fn = HK.slice(HK.indexOf('function replyMarksOf('), HK.indexOf('function replyMarksOf(') + 300);
    assert.match(fn, /return \{ replyTo: m\.replyTo, \.\.\.\(m\.replyComplete \? \{ replyComplete: true as const \} : \{\}\) \};/);
  });
  test('刚流式出来的那条：assistant-final 带着标记、界面记到那条消息上', () => {
    const fl = M.slice(M.indexOf("mainWindow?.webContents.send('acp:assistant-final'"), M.indexOf("mainWindow?.webContents.send('acp:assistant-final'") + 700);
    assert.match(fl, /\.\.\.\(replyTo \? \{ replyTo \} : \{\}\),/);
    assert.match(fl, /\.\.\.\(replyTo && completedFor === replyTo \? \{ replyComplete: true as const \} : \{\}\),/);
    assert.match(HK, /next\[idx\] = \{ \.\.\.next\[idx\], \.\.\.\(merged \|\| \{\}\), \.\.\.marks \};/);
  });
  test('主进程整份重写时按盘上的补回去（渲染层那份没带也不丢）', () => {
    const rw = ST.slice(ST.indexOf('export function rewriteTranscript('), ST.indexOf('export function rewriteTranscript(') + 2000);
    assert.match(rw, /const kept = carryBackendAnchors\(onDisk, carryReplyMarks\(onDisk, messages\)\);/);
    assert.match(rw, /\.\.\.kept\.map\(\(m\) => JSON\.stringify\(m\)\)/);
  });
});

describe('模型已经跑过工具后断网：外层队列重试、窗口重载后，模型和工具都不会再跑一遍', () => {
  type Q = { id: string; content: string; retryBatch?: { id: string; size: number } };
  const batch = (q: Q[], merge: boolean) => (merge ? q.slice(0, 10) : q.slice(0, 1));

  test('排队那条：工具跑过 → 断网 → 排空按退避重试同一个 id → 主进程拒绝（不发），渲染层不再放回队列', async () => {
    const main = fakeMain({ failFirst: 1, failAt: 'after-tools' });
    let queue: Q[] = [{ id: 'queue_A', content: '把 build 目录删掉再重建' }];
    /* 第一次：发出去、模型跑了一个工具、断网 —— 排空把它盖上 retryBatch 放回队头（App.tsx） */
    let picked = pickQueuedBatch(queue, false, batch);
    await assert.rejects(main.prompt('s', picked.items[0].content, picked.messageId), /dispatch failure/);
    queue = sealRetryBatch(picked.items, picked.messageId);
    assert.equal(main.modelCalls, 1);
    assert.equal(main.toolRuns, 1);
    /* 退避到点再试：同一个 id → 主进程判 started，拒绝；渲染层认出"重复"，不再放回去 */
    picked = pickQueuedBatch(queue, false, batch);
    assert.equal(picked.messageId, 'queue_A');
    const err = await main.prompt('s', picked.items[0].content, picked.messageId).then(() => null, (e) => e);
    assert.ok(err, '第二次被拒了');
    assert.equal(isDuplicateMessageError(String(err.message)), true, '渲染层按"重复"处理：不放回队列');
    assert.equal(main.modelCalls, 1, '模型没有再被调用');
    assert.equal(main.toolRuns, 1, '工具没有再跑');
    assert.equal(main.transcript.filter((m) => m.role === 'user').length, 1);
  });

  test('窗口重载 / 主进程重启后：started 跟着会话记录落盘，同一个 id 再来还是拒绝', async () => {
    const first = fakeMain({ failFirst: 1, failAt: 'after-tools' });
    await assert.rejects(first.prompt('s', 'x', 'queue_A'), /dispatch failure/);
    const persisted: FakeState = JSON.parse(JSON.stringify(first.state));      // transcript.jsonl + record.json
    const again = fakeMain({ state: persisted });
    await assert.rejects(again.prompt('s', 'x', 'queue_A'), /already started running/);
    assert.equal(again.modelCalls, 0);
    assert.equal(again.toolRuns, 0);
  });

  test('对照：模型还什么都没做就断网 → 同一个 id 照样重发（不多存一条）', async () => {
    const main = fakeMain({ failFirst: 1, failAt: 'before-output' });
    await assert.rejects(main.prompt('s', 'x', 'queue_A'), /dispatch failure/);
    assert.equal(await main.prompt('s', 'x', 'queue_A'), 'ok');
    assert.equal(main.transcript.filter((m) => m.role === 'user').length, 1);
  });

  test('侧栏改写：工具跑过后断网 → retrySameIf 不给 retrySame（再提交是新的一次 = 明确重跑），不按同一次再发', () => {
    const transcript = [{ id: 'u_rv_x', role: 'user' }, { id: 'p', role: 'assistant', replyTo: 'u_rv_x' }];
    assert.equal(canRetrySame(messageIdStatus(transcript, 'u_rv_x', new Set(['u_rv_x']))), false);
    assert.equal(canRetrySame(messageIdStatus([{ id: 'u_rv_y', role: 'user' }], 'u_rv_y')), true);
  });

  test('接线：第一次出字、第一次调工具时记 started（priming 不算），记进会话记录，判状态时读它', () => {
    assert.match(M, /entry\.assistantBuf \+= u\?\.content\?\.text \|\| '';\s*\n\s*if \(u\?\.content\?\.text\) \{ entry\.textThisTurn = true; noteTurnStarted\(sessionId, entry\); \}/);
    assert.match(M, /if \(u\?\.sessionUpdate === 'tool_call'\) noteTurnStarted\(sessionId, entry\);/);
    const nt = M.slice(M.indexOf('function noteTurnStarted('), M.indexOf('function noteTurnStarted(') + 500);
    assert.match(nt, /if \(!id \|\| entry\.priming \|\| entry\.startedNoted === id\) return;/);
    assert.match(nt, /store\.markMessageStarted\(sessionId, id\);/);
    const ST = read('main', 'sessionStore.ts');
    assert.match(ST, /const started = readRecord\(id\)\?\.startedMessageIds;\s*\n\s*return messageIdStatusInText\(raw, messageId, Array\.isArray\(started\) \? new Set\(started\) : undefined\);/);
    assert.match(ST, /patchRecord\(id, \{ startedMessageIds: list\.slice\(-STARTED_KEPT\) \}\);/);
  });
});

describe('sendPromptOnce 自己的自动重发：按真实的 flush → planRetry 顺序，出过字就不再发', () => {
  /*
    照 index.ts sendPromptOnce：每次发送开头 toolsThisTurn = 0、textThisTurn = false；流式时出字就 textThisTurn = true
    （同时 noteTurnStarted 记 started）；断网进 catch 先 flushAssistant（清空 assistantBuf）、再 planRetry
    （producedText 看 textThisTurn || assistantBuf）；每次重发（attempt > 0）一进来先过 decidePromptDedupe（started 那份）。
    `oldProduced: true` 是改之前的写法：producedText 只看 flush 之后的 assistantBuf —— 读到的永远是空。
  */
  function runTurn(opts: { text: boolean; tools?: number; oldProduced?: boolean; useStarted?: boolean }) {
    const started = new Set<string>();
    const entry = { assistantBuf: '', toolsThisTurn: 0, textThisTurn: false, currentUserMessageId: 'u_1' };
    let modelCalls = 0;
    for (let attempt = 0; ; attempt++) {
      const status = (opts.useStarted ?? true) ? messageIdStatus([], entry.currentUserMessageId, started) : 'absent';
      if (decidePromptDedupe({ explicitId: false, attempt, status }).action === 'reject') break;
      modelCalls += 1;
      entry.toolsThisTurn = 0;
      entry.textThisTurn = false;
      /* 流式 */
      if (opts.text) { entry.assistantBuf += '我先把这段读一遍，'; entry.textThisTurn = true; started.add(entry.currentUserMessageId); }
      if (opts.tools) { entry.toolsThisTurn = opts.tools; started.add(entry.currentUserMessageId); }
      /* —— 断网（dispatch failure），进 catch：先 flush 再 planRetry —— */
      entry.assistantBuf = '';                                                    // flushAssistant
      const plan = planRetry({
        error: 'response stream: An unknown error occurred: dispatch failure',
        attempt,
        producedText: opts.oldProduced ? !!entry.assistantBuf : !!(entry.textThisTurn || entry.assistantBuf),
        toolsRan: entry.toolsThisTurn,
        remote: false,
      });
      if (!plan.retry) break;
    }
    return modelCalls;
  }

  test('输出了文字、没跑工具、随后断网 → 模型调用次数保持 1（不自动重发）', () => {
    assert.equal(runTurn({ text: true }), 1);
  });
  test('跑过工具后断网 → 模型调用次数保持 1', () => {
    assert.equal(runTurn({ text: false, tools: 1 }), 1);
  });
  test('没输出也没跑工具就断网 → 仍会自动重试（直到预算用完）', () => {
    assert.equal(runTurn({ text: false }), 1 + maxRetriesFor(false));
  });
  test('两道闸各自都管用：只看 textThisTurn（不看 started）也停；老的 producedText 写法时 started 那道兜住', () => {
    assert.equal(runTurn({ text: true, useStarted: false }), 1, 'producedText 看 flush 不动的 textThisTurn');
    assert.equal(runTurn({ text: true, oldProduced: true }), 1, 'attempt > 0 也过 started 检查');
    assert.equal(runTurn({ text: true, oldProduced: true, useStarted: false }), 1 + maxRetriesFor(false), '对照：两道都没有就是原来的 bug');
  });

  test('接线：出字时记 textThisTurn、每次发送开头清零；catch 里 flush 在前、planRetry 用 textThisTurn；attempt > 0 时也按这一轮的 id 查 started', () => {
    assert.match(M, /if \(u\?\.content\?\.text\) \{ entry\.textThisTurn = true; noteTurnStarted\(sessionId, entry\); \}/);
    assert.match(M, /entry\.toolsThisTurn = 0;       \/\/ 这一轮的工具计数从零开始（自动重试的安全闸）\s*\n\s*entry\.bufAtLastTool = 0;\s*\n\s*entry\.textThisTurn = false;/);
    const flush = M.indexOf('flushAssistant(sessionId); // persist whatever completed before the error');
    const plan = M.indexOf('const plan = planRetry({', flush);
    assert.ok(flush > 0 && plan > flush, 'planRetry 在 flush 之后 —— 所以不能读 assistantBuf');
    const body = M.slice(plan, plan + 700);
    assert.match(body, /producedText: !!\(entry\.textThisTurn \|\| entry\.assistantBuf\),/);
    assert.doesNotMatch(body, /producedText: !!entry\.assistantBuf,/);
    const fn = M.slice(M.indexOf('function promptDedupeFor('), M.indexOf('const askWaiters = new Map'));
    assert.match(fn, /const checkId = messageId \?\? \(attempt > 0 \? sessionClients\.get\(sessionId\)\?\.currentUserMessageId : undefined\);/);
    assert.match(fn, /status: checkId \? store\.messageIdStatusOnDisk\(sessionId, checkId\) : 'absent',/);
  });
});
