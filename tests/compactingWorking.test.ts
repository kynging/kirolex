import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  startCompactWait, noteCompactTurnEnd, routeCompactFrame, compactHolds, stopCompactWait, compactFinishedLine, autoCompactNoteKind,
} from '../src/main/compactWait.ts';
import { sessionDotStatus } from '../src/renderer/sessionDot.ts';
import { compactingElapsedSeconds } from '../src/renderer/compactingIndicator.ts';

/*
  「压缩中」期间按「在工作」显示（2026-11-28 第 5 轮补充）：kiro 的 /compact 回 end_turn 之后压缩还要在后台跑 ~45 秒，
  原来侧栏和聊天区都显示空闲，用户接着发消息。渲染层显示运行指示用的是 `busyBySession[sid]`（主进程 `busyReasonFor`）。
*/

const src = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
const between = (s: string, a: string, b: string) => { const i = s.indexOf(a); assert.ok(i >= 0, `找不到 ${a}`); const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };
const meta = (pct: number) => ({ sessionUpdate: '_kiro_internal', method: '_kiro.dev/metadata', contextUsagePercentage: pct });
const dot = (busy: string | null) => sessionDotStatus({ id: 's1', currentSessionId: 's1', busy, streaming: false, connecting: false, failed: false, unread: false, attached: true });

describe('/compact 回 end_turn 后、占用骤降之前：会话算在工作', () => {
  test('忙碌状态为真：主进程报 compacting，侧栏圆点按「在工作」显示；骤降之后恢复空闲', () => {
    let w = startCompactWait(0, 90);
    w = noteCompactTurnEnd(w, { engine: 'kiro', ok: true, now: 130 });          // "Compacting conversation..." 130ms 就 end_turn
    w = routeCompactFrame(w, { inTurn: false, update: meta(90), pct: 90, now: 20_000 }).wait!;   // 还没骤降的读数
    assert.equal(compactHolds(w), true);
    /* busyReasonFor：那一轮结束了（不是 turn），compactHolds → 'compacting' */
    const M = src('main', 'index.ts');
    const b = between(M, 'function busyReasonFor(', 'function emitSessionBusy(');
    assert.match(b, /if \(compactHolds\(entry\?\.compactWait\)\) return 'compacting';/);
    /* 一轮结束时主进程广播 busy（acp:session-busy），渲染层据此更新 busyBySession */
    assert.match(between(M, 'const compactTurnEnd = entry.compactWait && !entry.compactWait.turnEnded', 'emitSessionBusy(sessionId);'), /noteCompactTurnEnd/);
    const busy = compactHolds(w) ? 'compacting' : null;
    assert.equal(dot(busy), 'streaming', '侧栏会话行显示运行指示');

    const done = routeCompactFrame(w, { inTurn: false, update: meta(4), pct: 4, now: 47_000 });
    assert.equal(done.released, true);
    assert.equal(compactHolds(done.wait), false);
    assert.equal(dot(compactHolds(done.wait) ? 'compacting' : null), 'idle', '压完恢复空闲');
  });

  test('已用时间：从发出 /compact 算起，按秒取整、不出负数', () => {
    assert.equal(compactingElapsedSeconds(1_000, 46_900), 45);
    assert.equal(compactingElapsedSeconds(5_000, 4_000), 0);
    assert.equal(compactingElapsedSeconds(undefined, 4_000), 0);
  });
});

describe('压缩中按停止 = 放弃等待，照常放行排队的消息', () => {
  test('stopCompactWait：end_turn 之后还在压缩中 → 结束（stopped）；那一轮还在跑 / 已经压完的不动', () => {
    let w = noteCompactTurnEnd(startCompactWait(0, 90), { engine: 'kiro', ok: true, now: 130 });
    const stopped = stopCompactWait(w, 12_000);
    assert.equal(compactHolds(stopped), false);
    assert.equal(stopped.finished?.by, 'stopped');
    assert.match(compactFinishedLine('s1', stopped), /^compacting sessionId=s1 stopped by user after 12s \(pct=90->\?\) — releasing queued prompts$/);
    const running = startCompactWait(0, 90);
    assert.equal(stopCompactWait(running, 1_000), running, '/compact 那一轮还在跑：交给普通的停止');
    w = routeCompactFrame(w, { inTurn: false, update: meta(4), pct: 4, now: 2_000 }).wait!;
    assert.equal(stopCompactWait(w, 3_000), w);
    assert.equal(autoCompactNoteKind('stopped', true), 'stopped', '自动压缩被你停了：不说已压缩、也不说失败');
  });

  test('主进程 acp:cancel：这一轮已结束、还在压缩中 → 放弃等待（finishCompactWait 放行），不当成打断了一轮', () => {
    const M = src('main', 'index.ts');
    const c = between(M, "ipcMain.handle('acp:cancel', async (", 'if (entry.priming) {');
    assert.match(c, /if \(!entry\.busy && !entry\.autonomous && entry\.compactWait\?\.turnEnded && compactHolds\(entry\.compactWait\)\) \{/);
    assert.match(c, /entry\.compactWait = stopCompactWait\(entry\.compactWait, Date\.now\(\)\);\s*finishCompactWait\(sessionId, entry\);\s*return \{ idle: true, stoppedCompact: true \};/);
    const U = src('renderer', 'hooks', 'useAcp.ts');
    const s = between(U, 'const cancelStream = useCallback(', 'const forceStop = useCallback(');
    const stoppedAt = s.indexOf('if (res?.stoppedCompact)');
    assert.ok(stoppedAt > 0 && stoppedAt < s.indexOf('markTurnInterrupted(sessionForCancel);'), '放弃等压缩不把 /compact 那一轮标成被打断');
  });

  test('聊天区：压缩中底部显示「正在压缩上下文…」+ 已用时间，停止按钮可用', () => {
    const C = src('renderer', 'components', 'ChatArea.tsx');
    assert.match(C, /\) : compacting && !isStreaming \? \(\s*<div className="message assistant compacting-indicator" role="status">/);
    assert.match(C, /t\('Compacting the context… {n}s', \{ n: compactingElapsedSeconds\(compactingFrom, compactingNow\) \}\)/);
    assert.match(C, /\) : \(isStreaming \|\| compacting\) && !canSend \? \(\s*(\/\*[^*]*\*\/\s*)?<button className="composer-send stop" onClick=\{onCancel\}/);
    const A = src('renderer', 'App.tsx');
    assert.match(A, /compactingSince=\{sid \? compactingSince\[sid\] : undefined\}/);
    /* 已用时间从收到 acp:compacting（主进程发出 /compact 时同步发）那一刻算 */
    assert.match(A, /if \(compacting\) next\[sessionId\] = Date\.now\(\); else delete next\[sessionId\];/);
  });
});
