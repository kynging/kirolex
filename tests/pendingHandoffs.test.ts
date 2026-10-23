import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addPendingHandoff, readPendingHandoffs, removePendingHandoff, recoverableHandoffs } from '../src/main/pendingHandoffs.ts';
import { recoverPendingHandoffs as recoverIntoQueue } from '../src/renderer/handoffRequeue.ts';
import { enlistFollowUp, type FollowUpDeps } from '../src/main/followUpTurns.ts';
import { AcpClient } from '../src/main/acp-client.ts';
import { detachedTurnMessageId } from '../src/main/followUpTurns.ts';
import { isControlMessageId } from '../src/main/controlSessions.ts';

/**
 * 交给了适配器、还没轮到的那几条在盘上的记账（`pendingHandoffs.ts`）——
 * 交棒之前退出 / 崩溃：重启后放回 KiroLex 队列，不丢；已经交棒落过盘的不再放回，不重复。
 */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kl-handoff-'));
const item = (id: string) => ({ id, content: `msg ${id}`, ts: 1 });

describe('记账本身', () => {
  test('记 / 读 / 摘；最后一条摘掉文件就删', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_1'));
    addPendingHandoff(dir, item('user_2'));
    addPendingHandoff(dir, item('user_1'));
    assert.deepEqual(readPendingHandoffs(dir).map((h) => h.id), ['user_2', 'user_1'], '同一个 id 只记一次');
    removePendingHandoff(dir, 'user_2');
    removePendingHandoff(dir, 'user_1');
    assert.equal(fs.existsSync(path.join(dir, 'pending-handoffs.json')), false);
  });
  test('坏文件 / 没有文件：当没有', () => {
    const dir = tmp();
    assert.deepEqual(readPendingHandoffs(dir), []);
    fs.writeFileSync(path.join(dir, 'pending-handoffs.json'), '{not json');
    assert.deepEqual(readPendingHandoffs(dir), []);
  });
});

/** index.ts sendPromptOnce 的 queued 那段：发之前记，交棒时先落盘 transcript 再摘 */
function sessionHarness() {
  const dir = tmp();
  const transcript: string[] = [];
  const c: any = new AcpClient('m', {}, undefined, 'ask', undefined, undefined, 'claude');
  const sent: any[] = [];
  c.send = (m: any) => { sent.push(m); };
  c.process = { stdin: { writable: true } };
  c.initializeResult = { agentCapabilities: { _meta: { claudeCode: { promptQueueing: true } } } };
  const entry: any = { cliSessionId: 'cli', client: c, busy: true, turnRunning: true };
  const deps: FollowUpDeps = { isCurrent: () => true, emitBusy() {}, notConnected: () => new Error('nc') };
  const handOff = (id: string) => {
    addPendingHandoff(dir, item(id));
    return enlistFollowUp(entry, { kind: 'queued', onAccepted() {} }, [{ type: 'text', text: id }], id, () => {
      transcript.push(id);
      removePendingHandoff(dir, id);
    }, deps);
  };
  return { dir, transcript, entry, sent, handOff };
}

describe('交棒之前退出 / 重启：不丢、不重复', () => {
  test('交出去了、前一轮还没收尾就退出 → 重启时放回 KiroLex 队列；确认之后才摘，之后不再放回', () => {
    const h = sessionHarness();
    void h.handOff('user_2');
    assert.equal(h.sent.length, 1, '已经交给适配器了');
    assert.deepEqual(h.transcript, [], '还没轮到它：transcript 里没有');
    // —— 这里进程没了。重启：transcript 里没有它，主进程内存里也没有排着的 ——
    const back = recoverableHandoffs(h.dir, new Set(h.transcript));
    assert.deepEqual(back.map((x) => x.id), ['user_2'], '放回 KiroLex 队列，不丢');
    assert.deepEqual(readPendingHandoffs(h.dir).map((x) => x.id), ['user_2'], '只读不摘：窗口确认之前记录还在');
    const queue = recoverIntoQueue([], back, () => 'queue_2');
    // 窗口：队列写盘 → 确认（acp:ack-handoff-failed）→ 摘
    removePendingHandoff(h.dir, 'user_2');
    assert.deepEqual(recoverableHandoffs(h.dir, new Set()), [], '确认之后再启动不再放回');
    assert.equal(queue.length, 1);
  });

  test('取到恢复结果之后、队列写盘之前又刷新 / 退出 → 下次启动照样能恢复，而且只放回一次', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_11'));
    // 第一次启动：取到了，但窗口在放进队列、写盘之前就没了（磁盘上的队列还是空的）
    const first = recoverableHandoffs(dir, new Set());
    assert.deepEqual(first.map((x) => x.id), ['user_11']);
    const diskQueueAfterCrash: any[] = [];
    // 第二次启动：记录还在 → 照样放回
    const second = recoverableHandoffs(dir, new Set());
    assert.deepEqual(second.map((x) => x.id), ['user_11'], '不丢');
    const queue = recoverIntoQueue(diskQueueAfterCrash, second, () => 'queue_11');
    assert.equal(queue.length, 1);
    // 这一次队列写了盘、确认却没到就又退出了：第三次启动记录还在，但队列里已经有它（fromHandoff）→ 不放第二遍
    const third = recoverableHandoffs(dir, new Set());
    assert.deepEqual(third.map((x) => x.id), ['user_11']);
    assert.equal(recoverIntoQueue(queue, third, () => 'queue_dup'), queue, '只放回一次（只会发一次）');
    // 确认到了：摘
    removePendingHandoff(dir, 'user_11');
    assert.deepEqual(recoverableHandoffs(dir, new Set()), []);
  });

  test('交棒落盘了、还没来得及摘就退出 → transcript 里有它，重启不再放回（不重复发）', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_3'));
    // 交棒：transcript 先落盘（这里模拟崩在摘之前）
    const transcriptIds = new Set(['user_1', 'user_3']);
    assert.deepEqual(recoverableHandoffs(dir, transcriptIds), []);
    assert.equal(fs.existsSync(path.join(dir, 'pending-handoffs.json')), false);
  });

  test('正常交棒：落盘 transcript 的同时摘掉，盘上不留', async () => {
    const h = sessionHarness();
    const p = h.handOff('user_4');
    h.entry.turnRunning = false;
    const { handOverTurn } = await import('../src/main/followUpTurns.ts');
    handOverTurn(h.entry, { isCurrent: () => true, emitBusy() {}, notConnected: () => new Error('nc') });
    await p;
    assert.deepEqual(h.transcript, ['user_4']);
    assert.deepEqual(readPendingHandoffs(h.dir), []);
  });

  test('只是窗口刷新了（主进程还排着它）→ 不交出去，照常会轮到；盘上的都留着', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_5'));
    addPendingHandoff(dir, item('user_6'));
    const back = recoverableHandoffs(dir, new Set(), new Set(['user_5']));
    assert.deepEqual(back.map((x) => x.id), ['user_6']);
    assert.deepEqual(readPendingHandoffs(dir).map((x) => x.id), ['user_5', 'user_6']);
  });
});

describe('接线', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const APP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
  test('sendPromptOnce：记账在 enlistFollowUp（发出去）之前；交棒时先 persistUserMessage 再摘；没发出去的失败当场摘', () => {
    const at = M.indexOf('async function sendPromptOnce(');
    const body = M.slice(at, at + 120000);
    const add = body.indexOf('addPendingHandoff(dir, {');
    const enlist = body.indexOf('const enlisted = await enlistFollowUp(');
    assert.ok(add > 0 && add < enlist);
    const begin = body.slice(enlist, enlist + 600);
    /* 交棒：确认写上了才摘（persistThenRelease，下面「transcript 写失败」那组用真的写盘失败验它） */
    assert.ok(begin.includes('const released = persistThenRelease(dir, userMessageId, persistUserMessage);'));
    assert.ok(body.slice(enlist, enlist + 1500).includes('if (!err?.handoffNotStarted) { try { removePendingHandoff(dir, userMessageId); }'));
  });
  test('窗口启动时取一次，放回各自会话的 KiroLex 队列头', () => {
    assert.match(M, /ipcMain\.handle\('acp:take-pending-handoffs'/);
    assert.ok(APP.includes('void window.kiroApi.takePendingHandoffs?.().then((res) => {'));
    assert.ok(APP.includes('next[sid] = recoverPendingHandoffs(current[sid] || [], recover[sid],'));
  });
});

describe('控制入口发的 steer 碰上 Codex 自己起一轮：标记跟着走', () => {
  test('steer_ctl_… → user_ctl_…_turn，仍是控制入口发的（落盘成 via:control）', () => {
    const id = detachedTurnMessageId('steer_ctl_1792660000000_abc123');
    assert.equal(id, 'user_ctl_1792660000000_abc123_turn');
    assert.equal(isControlMessageId(id), true);
  });
  test('渲染端把那条 steer 的 id 交给 acp:steer，主进程用它推出这一轮的用户消息 id', () => {
    const ACP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
    assert.ok(ACP.includes('res = await window.kiroApi.steer(sid, sent, msgId);'));
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    assert.ok(M.includes("ipcMain.handle('acp:steer', async (_event, sessionId: string, message: string, steerMsgId?: string) => {"));
    assert.ok(M.includes('const turnMessageId = detachedTurnMessageId(typeof steerMsgId === '));
    /* 控制入口那边报的就是这个 id */
    const APP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
    assert.ok(APP.includes("if (route === 'handed-off') { if (ctl && res.messageId) ctl.report({ routed: 'sent', messageId: res.messageId }); return; }"));
    assert.ok(M.includes("return { steered: false, reason: 'handed-off', messageId: turnMessageId };"));
  });
});

describe('窗口刷新过、排着的那条接手前失败了：不丢、不重复', async () => {
  const { requeueFailedHandoff, recoverPendingHandoffs } = await import('../src/renderer/handoffRequeue.ts');
  test('窗口里已经没有卡片：用主进程随事件带来的整条消息放回队头；记录留到确认之后才摘', async () => {
    const h = sessionHarness();
    const p = h.handOff('user_8');
    // 执行器没了：还没轮到它
    h.entry.followUps[0].abort(new Error('Session not connected'));
    await assert.rejects(p, (err: any) => err.handoffNotStarted === true);
    // index.ts：notStarted 时盘上的记录先留着
    assert.deepEqual(readPendingHandoffs(h.dir).map((x) => x.id), ['user_8']);
    // 渲染端（刷新过，没卡片）：按事件带来的内容放回队列
    const queue = requeueFailedHandoff([], { messageId: 'user_8', content: 'msg user_8', attachments: [{ path: '/a.md', name: 'a.md' }] }, undefined, () => 'queue_x');
    assert.equal(queue.length, 1);
    assert.equal(queue[0].content, 'msg user_8');
    assert.equal(queue[0].fromHandoff, 'user_8');
    assert.deepEqual(queue[0].attachments, [{ path: '/a.md', name: 'a.md' }]);
    // 同一条再来一次（重复事件）：不放第二遍
    assert.equal(requeueFailedHandoff(queue, { messageId: 'user_8', content: 'x' }, undefined, () => 'queue_y'), queue);
    // 确认（acp:ack-handoff-failed）：ui-state 写盘之后才摘
    removePendingHandoff(h.dir, 'user_8');
    assert.deepEqual(readPendingHandoffs(h.dir), []);
  });

  test('放回了队列、确认还没到就退出：重启时记录还在，但队列里已经有它 → 不再放第二遍', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_9'));
    const queue = requeueFailedHandoff([], { messageId: 'user_9', content: 'msg user_9' }, undefined, () => 'queue_9');
    const back = recoverableHandoffs(dir, new Set());
    assert.deepEqual(back.map((x) => x.id), ['user_9']);
    const after = recoverPendingHandoffs(queue, back, () => 'queue_dup');
    assert.equal(after, queue, '按 fromHandoff 认出来了');
  });

  test('卡片还在：优先用卡片（带占位符的原文 + 粘贴块）', () => {
    const q = requeueFailedHandoff([], { messageId: 'user_10', content: 'expanded' }, { content: '[ 粘贴 #1 ]', attachments: [], pastes: [{ seq: 1 }] }, () => 'queue_10');
    assert.equal(q[0].content, '[ 粘贴 #1 ]');
    assert.deepEqual(q[0].pastes, [{ seq: 1 }]);
  });
});

describe('接线：失败回退', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const APP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
  test('没轮到就失败：记录先留着；事件带整条消息；确认时先把 ui-state 写盘再摘', () => {
    assert.ok(M.includes('if (!err?.handoffNotStarted) { try { removePendingHandoff(dir, userMessageId); }'));
    assert.match(M, /mainWindow\?\.webContents\.send\('acp:handoff-failed', \{\n\s*sessionId, messageId: display\?\.messageId, notStarted, error: String\(err\?\.message \|\| err\),\n\s*content: display\?\.displayText \?\? '',/);
    const ack = M.slice(M.indexOf("ipcMain.handle('acp:ack-handoff-failed'"));
    /* 先写盘、确认写上了而且队列里有它，才摘（ackRequeued 的判据见下面那组） */
    assert.ok(ack.includes('flush: flushUiStateNow,') && ack.includes('ackRequeued('));
  });
  test('渲染端：不靠卡片放回队列；先写 ui-state 再确认；刷新后把还排着的卡片画回来', () => {
    const fn = APP.slice(APP.indexOf('window.kiroApi.onHandoffFailed?.((d) => {'), APP.indexOf('}), [dropHandoff]);', APP.indexOf('window.kiroApi.onHandoffFailed?.((d) => {')));
    assert.ok(!fn.includes('d.notStarted && card'), '不能要求卡片还在');
    assert.ok(fn.indexOf('uiSet(QUEUES_KEY') < fn.indexOf('window.kiroApi.ackHandoffFailed?.(sid, handoffId)'));
    assert.ok(APP.includes('const live = res?.live || {};'));
    assert.ok(APP.includes('setHandoffsBySession((prev) => {'));
  });
  test('队列落盘 / 恢复时 fromHandoff 跟着走', () => {
    assert.ok(APP.includes("...(typeof item.fromHandoff === 'string' ? { fromHandoff: item.fromHandoff } : null),"));
  });
});

describe('接线：重启恢复只读不摘，窗口写盘后确认', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const APP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
  test('acp:take-pending-handoffs 用 recoverableHandoffs（不摘）', () => {
    const fn = M.slice(M.indexOf("ipcMain.handle('acp:take-pending-handoffs'"), M.indexOf("ipcMain.handle('acp:steer'"));
    assert.ok(fn.includes('const back = recoverableHandoffs(dir, known, live);'));
    assert.ok(!fn.includes('removePendingHandoff'));
  });
  test('窗口：放进队列 → 直接写 ui-state → 逐条确认', () => {
    const fn = APP.slice(APP.indexOf('void window.kiroApi.takePendingHandoffs?.().then((res) => {'), APP.indexOf('const handleSteerMessage = useCallback'));
    const put = fn.indexOf('next[sid] = recoverPendingHandoffs(current[sid] || [], recover[sid],');
    const write = fn.indexOf('uiSet(QUEUES_KEY');
    const ack = fn.indexOf('void window.kiroApi.ackHandoffFailed?.(sid, h.id);');
    assert.ok(put > 0 && put < write && write < ack);
  });
});

describe('确认放回队列：ui-state 真的写上了盘、队列里也有它，才摘记录', async () => {
  const { ackRequeued, queuesHoldHandoff } = await import('../src/main/pendingHandoffs.ts');
  const queuesWith = (sid: string, fromHandoff: string) => JSON.stringify({ [sid]: [{ id: 'queue_1', content: 'x', attachments: [], createdAt: 1, fromHandoff }] });

  test('写盘失败 → 不摘、回 false；下次启动照样能放回（只放一次）', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_12'));
    const ok = ackRequeued(dir, 's1', 'user_12', { flush: () => false, queuesRaw: () => queuesWith('s1', 'user_12') });
    assert.equal(ok, false);
    assert.deepEqual(readPendingHandoffs(dir).map((x) => x.id), ['user_12'], '记录留着');
    // 退出后：磁盘上的队列没写上（写盘失败）→ 重启照样放回
    const back = recoverableHandoffs(dir, new Set());
    assert.deepEqual(back.map((x) => x.id), ['user_12']);
    const queue = recoverIntoQueue([], back, () => 'queue_12');
    assert.equal(queue.length, 1);
    assert.equal(recoverIntoQueue(queue, back, () => 'dup'), queue, '只放一次');
  });

  test('写上了盘，但队列里没有它（窗口那份没写进来）→ 不摘', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_13'));
    assert.equal(ackRequeued(dir, 's1', 'user_13', { flush: () => true, queuesRaw: () => '{}' }), false);
    assert.equal(ackRequeued(dir, 's1', 'user_13', { flush: () => true, queuesRaw: () => queuesWith('s2', 'user_13') }), false, '别的会话的队列不算');
    assert.deepEqual(readPendingHandoffs(dir).map((x) => x.id), ['user_13']);
  });

  test('写上了盘、队列里有它 → 摘', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_14'));
    assert.equal(ackRequeued(dir, 's1', 'user_14', { flush: () => true, queuesRaw: () => queuesWith('s1', 'user_14') }), true);
    assert.deepEqual(readPendingHandoffs(dir), []);
  });

  test('队列 JSON 坏了 / 没有：当作没有', () => {
    assert.equal(queuesHoldHandoff('{oops', 's1', 'x'), false);
    assert.equal(queuesHoldHandoff(undefined, 's1', 'x'), false);
  });

  test('接线：acp:ack-handoff-failed 走 ackRequeued，写盘函数报告成败', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const fn = M.slice(M.indexOf("ipcMain.handle('acp:ack-handoff-failed'"), M.indexOf("ipcMain.handle('acp:take-pending-handoffs'"));
    assert.ok(fn.includes('const ok = ackRequeued(store.sessionDirPath(sessionId), sessionId, messageId, {'));
    assert.ok(fn.includes('flush: flushUiStateNow,'));
    assert.ok(fn.includes("queuesRaw: () => uiState()['kirolex-queues'],"));
    assert.ok(!fn.includes('removePendingHandoff('), '不再无条件摘');
    assert.ok(M.includes('function flushUiStateNow(): boolean {'));
  });
});

describe('确认失败 → 放回的那条从队列发出去了 → 重启不再恢复', async () => {
  const { sentHandoffIds, ackRequeued } = await import('../src/main/pendingHandoffs.ts');
  test('发出去的那条换了新 id，但带着原 handoff id（fromHandoff）：重启认得出来，不再放回', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_20'));
    // 放回队列后确认失败（写盘失败）：记录留着
    assert.equal(ackRequeued(dir, 's1', 'user_20', { flush: () => false, queuesRaw: () => '{}' }), false);
    // 队列排空：用新的 id 发出去、落盘，带着 fromHandoff
    const transcript = [
      { id: 'user_1', role: 'user' },
      { id: 'queue_77', role: 'user', fromHandoff: ['user_20'] },
      { id: 'a_1', role: 'assistant' },
    ];
    // 主进程落盘时本来就会摘；这里模拟「落盘了、还没来得及摘就崩了」——记录还在
    assert.deepEqual(readPendingHandoffs(dir).map((x) => x.id), ['user_20']);
    // 重启：队列已经排空了，按 transcript（含 fromHandoff）判 —— 不再放回
    assert.deepEqual(recoverableHandoffs(dir, sentHandoffIds(transcript)), []);
    assert.deepEqual(readPendingHandoffs(dir), [], '顺手摘掉了');
  });

  test('排队合并发送：一条消息带着几条原 handoff id，全都认得出来', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_21'));
    addPendingHandoff(dir, item('user_22'));
    addPendingHandoff(dir, item('user_23'));
    const transcript = [{ id: 'queue_88', role: 'user', fromHandoff: ['user_21', 'user_22'] }];
    assert.deepEqual(recoverableHandoffs(dir, sentHandoffIds(transcript)).map((x) => x.id), ['user_23'], '没发的那条照样放回');
  });

  test('接线：排空时收集 fromHandoff → sendQueuedMessage → acp:prompt 的 display → 落盘带上、同时摘记录；恢复按 handoffFacts 判', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const APP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
    const ACP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
    assert.ok(APP.includes('const fromHandoff = consumed.map((item) => item.fromHandoff).filter((x): x is string => !!x);'));
    assert.ok(APP.includes('...(fromHandoff.length ? { fromHandoff } : null),'));
    assert.ok(ACP.includes('...(options?.fromHandoff?.length ? { fromHandoff: options.fromHandoff } : {}),'));
    assert.ok(M.includes('...(fromHandoffIds.length ? { fromHandoff: fromHandoffIds } : {}),'));
    const persist = M.indexOf('...(fromHandoffIds.length ? { fromHandoff: fromHandoffIds } : {}),');
    const drop = M.indexOf('for (const hid of fromHandoffIds) { try { removePendingHandoff(store.sessionDirPath(sessionId), hid); }', persist);
    assert.ok(persist > 0 && drop > persist, '先落盘 transcript，再摘记录');
    assert.ok(M.includes('const known = handoffFacts(store.readTranscript(id, { raw: true }) || []);'));
  });
});

describe('交棒时 transcript 写失败：恢复记录不摘（删记录本身是能成功的）', async () => {
  const { persistThenRelease } = await import('../src/main/pendingHandoffs.ts');
  const { enlistFollowUp, handOverTurn } = await import('../src/main/followUpTurns.ts');

  /** 真的写一份 transcript：路径是个目录时 appendFileSync 会抛 EISDIR —— 模拟「文件暂时被占用」那类写盘失败 */
  const realPersist = (transcriptPath: string, line: string) => () => {
    fs.appendFileSync(transcriptPath, `${line}\n`);
    return true;
  };

  test('写失败（真的抛错）→ 记录留着、返回 false；重启照样放回', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_30'));
    const blocked = path.join(dir, 'transcript.jsonl');
    fs.mkdirSync(blocked);                                   // 写不进去
    assert.equal(persistThenRelease(dir, 'user_30', realPersist(blocked, '{"id":"user_30"}')), false);
    assert.deepEqual(readPendingHandoffs(dir).map((x) => x.id), ['user_30'], '删记录本身能成功，但不该删');
    assert.deepEqual(recoverableHandoffs(dir, new Set()).map((x) => x.id), ['user_30'], '重启照样放回');
  });

  test('写成了 → 才摘', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_31'));
    const file = path.join(dir, 'transcript.jsonl');
    assert.equal(persistThenRelease(dir, 'user_31', realPersist(file, '{"id":"user_31"}')), true);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), '{"id":"user_31"}');
    assert.deepEqual(readPendingHandoffs(dir), []);
  });

  test('persist 返回 false（主进程 persistUserMessage 吞掉错误时就是这样）→ 不摘', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_32'));
    assert.equal(persistThenRelease(dir, 'user_32', () => false), false);
    assert.deepEqual(readPendingHandoffs(dir).map((x) => x.id), ['user_32']);
  });

  test('走一遍真的交棒（enlistFollowUp → handOverTurn），交棒回调里 transcript 写失败 → 记录还在', async () => {
    const dir = tmp();
    const c: any = new AcpClient('m', {}, undefined, 'ask', undefined, undefined, 'claude');
    c.send = () => {};
    c.process = { stdin: { writable: true } };
    c.initializeResult = { agentCapabilities: { _meta: { claudeCode: { promptQueueing: true } } } };
    const entry: any = { cliSessionId: 'cli', client: c, busy: true, turnRunning: true };
    const deps = { isCurrent: () => true, emitBusy() {}, notConnected: () => new Error('nc') };
    const blocked = path.join(dir, 'transcript.jsonl');
    fs.mkdirSync(blocked);
    addPendingHandoff(dir, item('user_33'));
    let released: boolean | undefined;
    const p = enlistFollowUp(entry, { kind: 'queued', onAccepted() {} }, [], 'user_33', () => {
      released = persistThenRelease(dir, 'user_33', realPersist(blocked, '{"id":"user_33"}'));
    }, deps);
    entry.turnRunning = false;
    handOverTurn(entry, deps);
    await p;
    assert.equal(released, false);
    assert.deepEqual(readPendingHandoffs(dir).map((x) => x.id), ['user_33']);
  });

  test('接线：persistUserMessage 报告写没写上；交棒走 persistThenRelease；没写上明说', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    assert.ok(M.includes('const persistUserMessage = (): boolean => {'));
    assert.ok(M.includes('      persisted = true;\n    } catch (err: any) {'));
    assert.ok(M.includes('    return persisted;\n    };'));
    assert.ok(M.includes('const released = persistThenRelease(dir, userMessageId, persistUserMessage);'));
    assert.ok(M.includes("if (persisted && fromHandoffIds.length) {"), '放回队列发出去的那条：落上了才摘');
    assert.ok(M.includes("sessionNotice(sessionId, tr('This message could not be saved to the conversation record; it is kept for recovery after a restart.'));"));
  });
});

describe('交棒过（已经交给适配器在跑了）但用户消息没写上：重启不自动重发', async () => {
  const { markHandoffStarted, handoffsToRestore, restoreStartedHandoffs, sentHandoffIds, persistThenRelease } = await import('../src/main/pendingHandoffs.ts');

  /** 交棒：先记「已经在跑了」，再落盘用户消息 —— 这里落盘失败 */
  const beginWithFailingWrite = (dir: string, id: string) => {
    markHandoffStarted(dir, id);
    return persistThenRelease(dir, id, () => { throw new Error('EBUSY: transcript locked'); });
  };

  test('暂时写盘失败、这一轮实际执行完成（回复 replyTo 指着它）→ 重启：不放回队列、不重发；原文按原 id 补写回对话记录，写上了才摘', async () => {
    const { handoffFacts } = await import('../src/main/pendingHandoffs.ts');
    const dir = tmp();
    addPendingHandoff(dir, { ...item('user_40'), attachments: [{ name: 'a.md', path: '/a.md' }] });
    assert.equal(beginWithFailingWrite(dir, 'user_40'), false);
    assert.ok(readPendingHandoffs(dir)[0].startedAt, '记下了它已经在跑');
    // 这一轮跑完，回复落盘了（用户消息那一行没写上）
    const transcript = [{ id: 'user_1', role: 'user' }, { id: 'a_9', role: 'assistant', replyTo: 'user_40', replyComplete: true }];
    const facts = handoffFacts(transcript);
    assert.ok(facts.executed.has('user_40'), '回复指着它 = 执行过了');
    assert.ok(!facts.saved.has('user_40'), '但用户消息本身不在盘上');
    // 重启：先补写，再看要不要放回队列
    assert.deepEqual(recoverableHandoffs(dir, facts), [], '不放回 KiroLex 队列（不会自动执行第二遍）');
    assert.deepEqual(readPendingHandoffs(dir).map((h) => h.id), ['user_40'], '原文还没补写上：记录不能摘');
    const appended: any[] = [];
    const restored = restoreStartedHandoffs(dir, facts, new Set(), (h) => { appended.push(h); });
    assert.deepEqual(restored.map((h) => h.id), ['user_40']);
    assert.equal(appended[0].id, 'user_40', '按原 id 补写');
    assert.equal(appended[0].content, 'msg user_40', '原文不丢');
    assert.deepEqual(appended[0].attachments, [{ name: 'a.md', path: '/a.md' }], '附件信息不丢');
    assert.deepEqual(readPendingHandoffs(dir), [], '补写上了才摘');
    assert.deepEqual(recoverIntoQueue([], recoverableHandoffs(dir, facts), () => 'q'), []);
  });

  test('有回复、用户消息没写上、补写也失败 → 记录留着、不放回队列（下次再补）', async () => {
    const { handoffFacts } = await import('../src/main/pendingHandoffs.ts');
    const dir = tmp();
    addPendingHandoff(dir, item('user_44'));
    beginWithFailingWrite(dir, 'user_44');
    const facts = handoffFacts([{ id: 'a_1', role: 'assistant', replyTo: 'user_44' }]);
    assert.deepEqual(restoreStartedHandoffs(dir, facts, new Set(), () => { throw new Error('locked'); }), []);
    assert.deepEqual(recoverableHandoffs(dir, facts), []);
    assert.deepEqual(readPendingHandoffs(dir).map((h) => h.id), ['user_44']);
  });

  test('写盘失败、执行到一半就退出了（还没有回复）→ 重启：不放回队列，只把用户消息补写进对话记录（你自己决定重不重跑）', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_41'));
    assert.equal(beginWithFailingWrite(dir, 'user_41'), false);
    const known = sentHandoffIds([{ id: 'user_1', role: 'user' }]);
    assert.deepEqual(recoverableHandoffs(dir, known), [], '不自动重发');
    const appended: string[] = [];
    const restored = restoreStartedHandoffs(dir, known, new Set(), (h) => { appended.push(h.id); });
    assert.deepEqual(restored.map((h) => h.id), ['user_41']);
    assert.deepEqual(appended, ['user_41'], '用原来的 id 补写进对话记录');
    assert.deepEqual(readPendingHandoffs(dir), [], '补写上了才摘');
  });

  test('补写也写不上 → 记录留着（下次再试），照样不放回队列', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_42'));
    beginWithFailingWrite(dir, 'user_42');
    const restored = restoreStartedHandoffs(dir, new Set(), new Set(), () => { throw new Error('still locked'); });
    assert.deepEqual(restored, []);
    assert.deepEqual(readPendingHandoffs(dir).map((h) => h.id), ['user_42']);
    assert.deepEqual(recoverableHandoffs(dir, new Set()), []);
  });

  test('从没交棒过（真的没跑）→ 照旧放回 KiroLex 队列', () => {
    const dir = tmp();
    addPendingHandoff(dir, item('user_43'));
    assert.deepEqual(recoverableHandoffs(dir, new Set()).map((h) => h.id), ['user_43']);
    assert.deepEqual(handoffsToRestore(dir, new Set()), []);
  });

  test('接线：交棒先 markHandoffStarted 再落盘；重启先补写交棒过的，再放回没跑过的', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const mark = M.indexOf('try { markHandoffStarted(dir, userMessageId); }');
    const persist = M.indexOf('const released = persistThenRelease(dir, userMessageId, persistUserMessage);');
    assert.ok(mark > 0 && mark < persist);
    const take = M.slice(M.indexOf("ipcMain.handle('acp:take-pending-handoffs'"), M.indexOf("ipcMain.handle('acp:steer'"));
    assert.ok(take.indexOf('restoreStartedHandoffs(dir, known, live,') < take.indexOf('const back = recoverableHandoffs(dir, known, live);'));
    assert.ok(take.includes('store.appendMessage(id, {'));
  });
});

describe('补写交棒过的消息：粘贴块一起写进 transcript（恢复后能展开，清理时认得出还在用）', async () => {
  const { restoredUserMessage, markHandoffStarted, persistThenRelease, handoffFacts, restoreStartedHandoffs } = await import('../src/main/pendingHandoffs.ts');

  test('补写出的那一行带 seq / lines / chars / path；按 path 读得到粘贴原文；之后不放回队列、不重发', () => {
    const dir = tmp();
    // 粘贴原文（~/.kirolex/pastes 下的那份）
    const pasteFile = path.join(dir, 'paste-1.txt');
    fs.writeFileSync(pasteFile, 'line one\nline two\nline three');
    addPendingHandoff(dir, {
      id: 'user_50',
      content: '看这段 [ 粘贴 #1 · 3 行 ]',
      attachments: [{ name: 'a.png', path: '/tmp/a.png', isImage: true }],
      pastes: [{ seq: 1, lines: 3, chars: 28, path: pasteFile }, { seq: 2, lines: 1, chars: 3, path: '' }],
      ts: 1792700000000,
    });
    // 交棒了，用户消息没写上（写盘失败）
    markHandoffStarted(dir, 'user_50');
    assert.equal(persistThenRelease(dir, 'user_50', () => false), false);
    // 重启：补写 —— 和 index.ts 一样用 restoredUserMessage，按 JSONL 追加进 transcript
    const transcriptFile = path.join(dir, 'transcript.jsonl');
    const facts = handoffFacts([]);
    const restored = restoreStartedHandoffs(dir, facts, new Set(), (h) => {
      fs.appendFileSync(transcriptFile, `${JSON.stringify(restoredUserMessage(h))}\n`);
    });
    assert.deepEqual(restored.map((h) => h.id), ['user_50']);
    const written = fs.readFileSync(transcriptFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(written.length, 1);
    const m = written[0];
    assert.equal(m.id, 'user_50', '原 id');
    assert.equal(m.content, '看这段 [ 粘贴 #1 · 3 行 ]', '原文（带占位符）');
    assert.deepEqual(m.attachments, [{ name: 'a.png', path: '/tmp/a.png', isImage: true }]);
    assert.deepEqual(m.pastes, [{ seq: 1, lines: 3, chars: 28, path: pasteFile }], '粘贴块写进去了（没有 path 的那条丢掉，和 persistUserMessage 一样）');
    assert.equal(fs.readFileSync(m.pastes[0].path, 'utf8'), 'line one\nline two\nline three', '按 path 能展开粘贴原文');
    // 不重发：记录已摘，再启动既不放回队列也不再补写
    assert.deepEqual(readPendingHandoffs(dir), []);
    const after = handoffFacts(written);
    assert.deepEqual(recoverableHandoffs(dir, after), []);
    assert.deepEqual(restoreStartedHandoffs(dir, after, new Set(), () => { throw new Error('不该再补写'); }), []);
  });

  test('接线：index.ts 补写时用 restoredUserMessage（和 persistUserMessage 同一个形状）', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const take = M.slice(M.indexOf("ipcMain.handle('acp:take-pending-handoffs'"), M.indexOf("ipcMain.handle('acp:steer'"));
    assert.ok(take.includes('...restoredUserMessage(h),'));
  });
});
