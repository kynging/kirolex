import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { PrepHolds, canEvict, prepOnExecutor, queuedHandoffRefusal } from '../src/main/sendPrep.ts';

/**
 * 审查意见：发送前异步读记忆 / 历史快照的那段时间里 `entry.busy` 还是 false —— 换模型 / 换机器、空闲回收都能把执行器换掉或断开，
 * 读完却还拿着旧的那个落盘、发给旧 client（甚至在旧机器上开跑一轮）。这里用**可以手动放行的读取**模拟「读到一半」：
 *   - 读的时候空闲回收不收它（`canEvict` —— index.ts 的 ensureExecutorCapacity 用的就是它），读完才能收；
 *   - 读的时候换了机器（sessionClients 换成新的）/ 正换到一半 / 被拆掉 → 告诉调用方「执行器动过」，不交给旧的那个；
 *   - 没动过 → 照常拿到读的结果。
 * 接线（读源码）：两处异步准备都经 prepOnExecutor，动过就等切换落定、按当前执行器从头重走（return sendPromptOnce(...)）。
 */
type Entry = { name: string; busy?: boolean; autonomous?: unknown };

function world() {
  const clients = new Map<string, Entry>();
  const switching = new Set<string>();
  const holds = new PrepHolds();
  const deps = { current: (id: string) => clients.get(id), switching: (id: string) => switching.has(id), holds };
  /** 一次可控的读：调 release(value) 才读完 */
  const pausedRead = <T>() => {
    let release!: (v: T) => void;
    const p = new Promise<T>((r) => { release = r; });
    return { work: () => p, release: (v: T) => release(v) };
  };
  /** 照 ensureExecutorCapacity 的样子回收一个（满了、要给别人腾位置） */
  const evictOne = (excludeId?: string): string | null => {
    for (const [id, e] of clients) {
      if (!canEvict(id, e, excludeId, holds)) continue;
      clients.delete(id);
      return id;
    }
    return null;
  };
  return { clients, switching, holds, deps, pausedRead, evictOne };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('发送前异步准备期间执行器被换 / 被回收', () => {
  test('没动过：拿到读的结果', async () => {
    const w = world();
    const a = { name: 'tokyo' };
    w.clients.set('s1', a);
    const r = w.pausedRead<string>();
    const done = prepOnExecutor('s1', a, w.deps, r.work);
    r.release('memory block');
    assert.deepEqual(await done, { moved: false, value: 'memory block' });
    assert.equal(w.holds.has('s1'), false, '读完就放开');
  });

  test('读记忆读到一半，切换了机器（执行器换成新的）→ 作废，不交给旧的那个', async () => {
    const w = world();
    const tokyo = { name: 'tokyo' };
    w.clients.set('s1', tokyo);
    const r = w.pausedRead<string>();
    const done = prepOnExecutor('s1', tokyo, w.deps, r.work);
    await tick();
    /* 换机器：先标「正在换」，新执行器起好后替换 */
    w.switching.add('s1');
    w.clients.set('s1', { name: 'local' });
    w.switching.delete('s1');
    r.release('old memory');
    assert.deepEqual(await done, { moved: true, why: 'replaced' });
  });

  test('读到一半，正在换执行器（新的还没起好，sessionClients 里还是旧的）→ 作废（不在旧机器上开跑一轮）', async () => {
    const w = world();
    const tokyo = { name: 'tokyo' };
    w.clients.set('s1', tokyo);
    const r = w.pausedRead<string>();
    const done = prepOnExecutor('s1', tokyo, w.deps, r.work);
    await tick();
    w.switching.add('s1');
    r.release('x');
    assert.deepEqual(await done, { moved: true, why: 'switching' });
  });

  test('读到一半，空闲回收要腾位置：正在准备发送的这条不收（收别的）；读完之后才收得到', async () => {
    const w = world();
    const mine = { name: 'mine' };
    const other = { name: 'other' };
    w.clients.set('s1', mine);
    w.clients.set('s2', other);
    const r = w.pausedRead<string>();
    const done = prepOnExecutor('s1', mine, w.deps, r.work);
    await tick();
    assert.equal(w.holds.has('s1'), true);
    assert.equal(w.evictOne('s_new'), 's2', '收的是别的空闲会话');
    assert.equal(w.evictOne('s_new'), null, '只剩正在准备的这条：不收（宁可报满）');
    assert.equal(w.clients.get('s1'), mine);
    r.release('block');
    assert.deepEqual(await done, { moved: false, value: 'block' });
    assert.equal(w.evictOne('s_new'), 's1', '准备完了（一轮开始前）才回到可回收的状态');
  });

  test('读到一半，执行器被拆掉（删会话 / 断开）→ 作废', async () => {
    const w = world();
    const a = { name: 'a' };
    w.clients.set('s1', a);
    const r = w.pausedRead<string>();
    const done = prepOnExecutor('s1', a, w.deps, r.work);
    await tick();
    w.clients.delete('s1');
    r.release('x');
    assert.deepEqual(await done, { moved: true, why: 'gone' });
  });

  test('读失败也放开占位；同一条两次并发的准备按次数占，全放完才放开', async () => {
    const w = world();
    const a = { name: 'a' };
    w.clients.set('s1', a);
    await assert.rejects(prepOnExecutor('s1', a, w.deps, async () => { throw new Error('EIO'); }), /EIO/);
    assert.equal(w.holds.has('s1'), false);
    const r1 = w.pausedRead<number>(); const r2 = w.pausedRead<number>();
    const d1 = prepOnExecutor('s1', a, w.deps, r1.work);
    const d2 = prepOnExecutor('s1', a, w.deps, r2.work);
    r1.release(1); await d1;
    assert.equal(w.holds.has('s1'), true, '另一次还在读');
    r2.release(2); await d2;
    assert.equal(w.holds.has('s1'), false);
  });

  test('canEvict：正在跑的 / 后端自己起的一轮 / 正给别人腾位置的那条本身 都不收', () => {
    const holds = new PrepHolds();
    assert.equal(canEvict('s', { busy: true }, undefined, holds), false);
    assert.equal(canEvict('s', { autonomous: {} }, undefined, holds), false);
    assert.equal(canEvict('s', {}, 's', holds), false);
    assert.equal(canEvict('s', {}, undefined, holds), true);
  });
});

describe('接线（读源码）', () => {
  const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

  test('空闲回收用 canEvict（正在准备发送的不收）', () => {
    const fn = MAIN.slice(MAIN.indexOf('function ensureExecutorCapacity('));
    assert.match(fn.slice(0, fn.indexOf('\n}\n')), /if \(!canEvict\(id, e, excludeId, sendPrepHolds\)\) continue;/);
  });

  test('读历史快照、读记忆都经 prepOnExecutor；动过就等切换落定、按当前执行器从头重走', () => {
    assert.match(MAIN, /const read = await prepOnExecutor\(sessionId, entry, prepDeps, \(\) => buildHistoryRideAlong\(sessionId\)\);\s*if \(read\.moved\) return rerunOnCurrentExecutor\('读历史快照', read\.why\);/);
    assert.match(MAIN, /const read = await prepOnExecutor\(sessionId, entry, prepDeps, \(\) => heavyLane\(\(\) => buildMemoryInjectionAsync\(target\.projectId, sessionId, \{ remote: target\.remote \}\)\)\);\s*if \(read\.moved\) return rerunOnCurrentExecutor\('读记忆', read\.why\);/);
    /* sendPromptOnce 里那一句把「整条重走」交给 rerunOnSwitchedExecutor，带上这次标过的 ride-along */
    assert.match(MAIN, /const rerunOnCurrentExecutor = \(where: string, why: 'replaced' \| 'gone' \| 'switching'\): Promise<any> => rerunOnSwitchedExecutor\(\s*sessionId, rideAlongMarkedOn, where, why, \(\) => sendPromptOnce\(sessionId, prompt, projectId, display, _model, attempt\)\);/);
    assert.match(MAIN, /rideAlongMarkedOn = entry;/);
    const at = MAIN.indexOf('async function rerunOnSwitchedExecutor(');
    const fn = MAIN.slice(at, MAIN.indexOf('\n  }\n', at));
    /* 先收回这次标的「已带上下文」，等切换、还没换完就照开头那道闸报错（不在这里打转），然后整条重走 */
    assert.match(fn, /markedOn\?\.rideAlongUnconfirmed[\s\S]*clearContextEstablished\(sessionId\)/);
    assert.match(fn, /await awaitReconfigureIdle\(sessionId\)/);
    assert.match(fn, /await pendingSwitchRunner\.settle\(sessionId\)/);
    assert.match(fn, /if \(reconfiguringSessions\.has\(sessionId\)\) throw new Error\(tr\('Another switch \(model \/ agent \/ machine\) has not finished yet\.'\)\);/);
    assert.match(fn, /return again\(\);/);
    /* 「正在切换」= 正在换执行器 / 正在应用待切换（忙时记下的待切换不算：交棒那条路上它是正常的，算进去会一直重走） */
    assert.match(MAIN, /switching: \(id: string\) => reconfiguringSessions\.has\(id\) \|\| pendingSwitchRunner\.isApplying\(id\),/);
  });

  test('重走发生在落盘之前：两处准备都在「这一轮在跑吗」的闸之前，用户消息写盘在闸之后', () => {
    const memRead = MAIN.indexOf("if (read.moved) return rerunOnCurrentExecutor('读记忆', read.why);");
    const gate = MAIN.indexOf('if (entry.busy && !handoff) {', memRead);
    const persist = MAIN.indexOf('// Persist the user message the instant it is sent', gate);
    assert.ok(memRead > 0 && gate > memRead && persist > gate);
    const rideRead = MAIN.indexOf("if (read.moved) return rerunOnCurrentExecutor('读历史快照', read.why);");
    assert.ok(rideRead > 0 && rideRead < memRead);
  });
});

describe('交给适配器排（queued handoff）：读记忆期间新登记了待切换 / 这一轮结束了（审查意见）', () => {
  /** 一条正在跑一轮、适配器能排的会话；待切换（忙时选的）只记账，不进入 applying / reconfiguring */
  function runningSession() {
    const w = world();
    const entry = { name: 'tokyo', busy: true, turnRunning: true, supportsPromptQueueing: true };
    w.clients.set('s1', entry);
    const pendingSwitches = new Set<string>();
    const facts = () => ({ autonomous: false, busy: entry.busy, turnRunning: entry.turnRunning,
      supportsPromptQueueing: entry.supportsPromptQueueing, switchOwed: pendingSwitches.has('s1') });
    /** 照 sendPromptOnce 的顺序：开头过闸 → 占住执行器读记忆 → 读完再过一遍闸 → 交给适配器（这里记下交给了谁） */
    const submitted: string[] = [];
    const send = async (read: { work: () => Promise<string> }) => {
      const first = queuedHandoffRefusal(facts());
      if (first) return { refused: first };
      const r = await prepOnExecutor('s1', entry, w.deps, read.work);
      if (r.moved) return { rerun: r.why };
      const again = queuedHandoffRefusal(facts());
      if (again) return { refused: again };
      submitted.push(entry.name);
      return { submitted: entry.name };
    };
    return { w, entry, pendingSwitches, send, submitted };
  }

  test('读到一半用户选了切换机器（只记成待切换）→ 不交给旧执行器，退回 KiroLex 队列', async () => {
    const h = runningSession();
    const read = h.w.pausedRead<string>();
    const done = h.send(read);
    await tick();
    h.pendingSwitches.add('s1');          // 忙时选的切换：只记账，执行器没换、也不算「正在切换」
    read.release('memory');
    assert.deepEqual(await done, { refused: 'switch-owed' });
    assert.deepEqual(h.submitted, [], '没有提交给旧执行器');
  });

  test('读到一半这一轮跑完了 → 按普通消息发（idle），不排到一个已经没有的那一轮后面', async () => {
    const h = runningSession();
    const read = h.w.pausedRead<string>();
    const done = h.send(read);
    await tick();
    h.entry.busy = false;
    h.entry.turnRunning = false;
    read.release('memory');
    assert.deepEqual(await done, { refused: 'idle' });
    assert.deepEqual(h.submitted, []);
  });

  test('读的时候什么都没变 → 照旧交给适配器排', async () => {
    const h = runningSession();
    const read = h.w.pausedRead<string>();
    const done = h.send(read);
    read.release('memory');
    assert.deepEqual(await done, { submitted: 'tokyo' });
  });

  test('queuedHandoffRefusal 和开头那道闸同一个顺序', () => {
    const ok = { autonomous: false, busy: true, turnRunning: true, supportsPromptQueueing: true, switchOwed: false };
    assert.equal(queuedHandoffRefusal(ok), null);
    assert.equal(queuedHandoffRefusal({ ...ok, autonomous: true }), 'unsupported');
    assert.equal(queuedHandoffRefusal({ ...ok, busy: false }), 'idle');
    assert.equal(queuedHandoffRefusal({ ...ok, busy: false, autonomous: true }), 'unsupported', '先看后端自己起的那一轮');
    assert.equal(queuedHandoffRefusal({ ...ok, turnRunning: false }), 'unsupported');
    assert.equal(queuedHandoffRefusal({ ...ok, supportsPromptQueueing: false }), 'unsupported');
    assert.equal(queuedHandoffRefusal({ ...ok, switchOwed: true }), 'switch-owed');
  });

  test('接线：读记忆之后、交给适配器之前再过一遍闸（中间没有 await）；事实和开头那道闸一样；待切换照原逻辑退回 unsupported', () => {
    const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const memRead = MAIN.indexOf("if (read.moved) return rerunOnCurrentExecutor('读记忆', read.why);");
    const regate = MAIN.indexOf("if (handoff?.kind === 'queued') regateQueuedHandoff(sessionId, entry);", memRead);
    const enlist = MAIN.indexOf('const enlisted = await enlistFollowUp(sessionId, entry, handoff, prompt, userMessageId', regate);
    assert.ok(memRead > 0 && regate > memRead && enlist > regate);
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(strip(MAIN.slice(regate, enlist)), /\bawait\b/, '再过闸到交出去之间没有 await');
    const fn = MAIN.slice(MAIN.indexOf('function regateQueuedHandoff('));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    assert.match(body, /autonomous: !!entry\.autonomous, busy: !!entry\.busy, turnRunning: !!entry\.turnRunning,\s*supportsPromptQueueing: !!entry\.client\.supportsPromptQueueing, switchOwed: pendingSwitches\.has\(sessionId\) \|\| pendingSwitchRunner\.isApplying\(sessionId\)/);
    assert.match(body, /throw new HandoffRefused\(why === 'switch-owed' \? 'unsupported' : why\);/);
    /* 开头那道闸原样还在（第一次过闸） */
    const first = MAIN.slice(MAIN.indexOf("if (handoff?.kind === 'queued') {"));
    assert.match(first.slice(0, 2000), /if \(pendingSwitches\.has\(sessionId\) \|\| pendingSwitchRunner\.isApplying\(sessionId\)\) \{[\s\S]{0,200}throw new HandoffRefused\('unsupported'\);/);
  });
});
