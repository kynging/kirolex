import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { contextLogLine } from '../src/main/contextReminder.ts';

const src = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
const M = src('main', 'index.ts');
const between = (s: string, a: string, b: string) => { const i = s.indexOf(a); assert.ok(i >= 0, `找不到 ${a}`); const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };

test('压缩中是占用：busyReasonFor 报 compacting（在 turn 之后、prime 之前），渲染端把它当占用', () => {
  const b = between(M, 'function busyReasonFor(', 'function emitSessionBusy(');
  const turn = b.indexOf("return 'turn'");
  const comp = b.indexOf("if (compactHolds(entry?.compactWait)) return 'compacting';");
  assert.ok(turn > 0 && comp > turn);
  assert.ok(comp < b.indexOf('needsHistoryPrime'));
  const U = src('renderer', 'hooks', 'useAcp.ts');
  assert.match(U, /OCCUPYING_BUSY_REASONS = new Set\(\[[^\]]*'compacting'[^\]]*\]\)/);
});

test('① 压缩中输入框发的消息进 KiroLex 排队（不下发），记一行 queued prompt while compacting', () => {
  const A = src('renderer', 'App.tsx');
  const h = between(A, 'const handleSendMessage = useCallback(', 'queueUntilConnected(');
  /* 占用且不是 'turn' → 排队；compacting 在占用集合里，所以走这一支 */
  assert.match(h, /isBackendOccupied\(busyBySession\[sid\]\)\s*&& busyBySession\[sid\] !== 'turn'/);
  const q = h.indexOf("if (busyBySession[sid] === 'compacting' || compactingRef.current.has(sid)) window.kiroApi.logContext?.({ kind: 'queued', sessionId: sid });");
  const enq = h.lastIndexOf('queueMessageRef.current?.(text, pastes, sid);', q);
  assert.ok(q > 0 && enq > 0, '进了排队之后记日志');
  assert.ok(!h.slice(enq, q).includes('return'), '和排队是同一支');
  assert.equal(contextLogLine({ kind: 'queued', sessionId: 's1' }), 'queued prompt while compacting sessionId=s1');
});

test('主进程兜底：sendPromptOnce 发之前等压缩完成（定时任务 / 唤醒 / 斜杠命令也挡住）', () => {
  const s = between(M, 'async function sendPromptOnce(', 'const { plan: injectPlan');
  const wait = s.indexOf('if (attempt === 0 && await awaitCompactRelease(sessionId)) await pendingSwitchRunner.settle(sessionId);');
  assert.ok(wait > 0);
  assert.ok(wait < s.indexOf('let entry = sessionClients.get(sessionId);'), '在取执行器、开始这一轮之前');
  const a = between(M, 'async function awaitCompactRelease(', '\n}\n');
  assert.match(a, /logger\.info\('context', `queued prompt while compacting sessionId=\$\{sessionId\}`\)/);
});

test('发出 /compact 就进压缩中；新一轮开始时**不**关压缩的花费归属（下一轮出输出之前到的计量还是压缩的）', () => {
  const s = between(M, 'entry.injectCadence = injectNext;', '**远程会话：先告诉它自己在哪台机器上**');
  assert.match(s, /if \(isCompactCommand\(display\?\.displayText \?\? promptTextOf\(prompt\)\)\) markContextReset\(entry\.injectCadence\);/);
  assert.match(s, /if \(isCompactCommand\(display\?\.displayText \?\? promptTextOf\(prompt\)\)\) beginCompactWait\(sessionId, entry\);/);
  assert.ok(!s.includes('settleCompactUsage(sessionId, entry)'), '新一轮开始时不收尾（原来这里收尾，之后才到的压缩花费就串进新一轮）');
  const b = between(M, 'function beginCompactWait(', '\n}\n');
  assert.match(b, /settleCompactUsage\(sessionId, entry\)/, '又发了一次 /compact：上一次的归属先关上');
  assert.match(b, /compactStartedLine\(sessionId\)/);
  assert.match(b, /entry\.compactWaitTimer = armCompactTimeout\(\{/, '排 3 分钟超时（armCompactTimeout，有假钟测试）');
  assert.match(b, /batch: entry\.compactWait\.batch,/, '认批次号');
  assert.match(b, /get: \(\) => sessionClients\.get\(sessionId\)\?\.compactWait,/, '到点时读当前状态（此刻挂着的执行器）');
  assert.match(b, /onExpired: \(\) => \{ const live = sessionClients\.get\(sessionId\); if \(live\) finishCompactWait\(sessionId, live\); \},/, '超时 = 放行在等的消息');
  assert.match(b, /setTimer: \(fn, ms\) => setTimeout\(fn, ms\),/);
  assert.ok(!b.includes('entry.compactWait !== armed'), '不再按对象比');
});

test('/compact 那一轮结束：在落盘之前判（kiro 继续压缩中、花费挪到压缩那边），落盘后记下那条消息的 id', () => {
  const t = between(M, 'const compactTurnEnd = entry.compactWait && !entry.compactWait.turnEnded', 'still compacting, holding new prompts');
  assert.match(t, /noteCompactTurnEnd\(compactTurnEnd, \{/);
  assert.match(t, /\{ \.\.\.ended, acc: entry\.turnUsageAcc \}/, '没压完：这一轮的花费挪到压缩那边');
  assert.match(t, /if \(!ended\.finished\) entry\.turnUsageAcc = undefined;/);
  const flush = t.indexOf('flushAssistant(sessionId); // turn complete');
  assert.ok(t.indexOf('noteCompactTurnEnd(') < flush, '在落盘之前判');
  assert.ok(t.indexOf('entry.lastFlushedAssistantId = undefined;') < flush, '落盘前清掉：什么都没落就不会拿到上一轮那条的 id');
  assert.ok(flush < t.indexOf('messageId: entry.lastFlushedAssistantId'), '落盘之后记下那条的 id');
  const f = between(M, 'function flushAssistant(', '/* ───────────── 模型向用户提问');
  assert.match(f, /entry\.lastFlushedAssistantId = finalId;/);
  assert.match(t, /finishCompactWait\(sessionId, entry\)/);
});

test('② 用量帧：每一帧走 routeCompactFrame（有按真实顺序喂帧的测试）；完成放行；记在压缩那边的帧不进正在跑的那一轮', () => {
  const w = between(M, 'const compactRoute = childSessionId ? null : routeCompactFrame(entry.compactWait, {', 'autonomousFrame(entry, data?.update');
  assert.match(w, /inTurn: !!entry\.busy \|\| !!entry\.autonomous,/);
  assert.match(w, /if \(compactRoute\?\.close\) settleCompactUsage\(sessionId, entry\);/, '下一轮出输出：关上归属');
  assert.match(w, /if \(compactRoute\.released\) finishCompactWait\(sessionId, entry\);/);
  assert.match(w, /else if \(compactRoute\.costGrew\) writeCompactUsage\(sessionId, entry\);/, '放行之后又到压缩的花费：更新补记');
  assert.match(w, /if \(\(entry\.busy \|\| entry\.autonomous\) && !compactRoute\?\.toCompact\) \{\s*entry\.turnUsageAcc = foldTurnFrame/);
  const f = between(M, 'function finishCompactWait(', '\n}\n');
  assert.match(f, /compactWaiters\.get\(sessionId\)/, '放行主进程里在等的发送');
  assert.match(f, /emitSessionBusy\(sessionId\)/, '告诉界面不忙了，排队的消息据此发出');
  assert.match(f, /compactFinishedLine\(sessionId, w\)/);
});

test('④ 花费补记到压缩那一条：只追加一行补记（读时取最后一行），并推给界面换掉那一格；没变就不再写', () => {
  const s = between(M, 'function writeCompactUsage(', '\n}\n');
  assert.match(s, /store\.appendMessage\(sessionId, compactUsagePatch\(w\.messageId, turnUsage, Date\.now\(\)\)/);
  assert.match(s, /'acp:turn-usage', \{ sessionId, messageId: w\.messageId, turnUsage/);
  assert.match(s, /if \(w\.writtenCost !== undefined && w\.writtenCost === cost\) return;/);
  const c = between(M, 'function settleCompactUsage(', '\n}\n');
  assert.ok(c.indexOf('writeCompactUsage(sessionId, entry);') < c.indexOf('settleCompactWait('), '关上之前最后写一次');
});

test('/compact 那一轮出错：不再等', () => {
  const c = between(M, '/* /compact 那一轮出错了：不再等它压完', '// Surface WHY: kiro-cli returns a bare JSON-RPC');
  assert.match(c, /noteCompactTurnEnd\(entry\.compactWait, \{ engine: engineOf\(entry\.profile\), ok: false/);
  assert.match(c, /finishCompactWait\(sessionId, entry\)/);
});

test('界面：压缩中输入框上方一行「正在压缩上下文，完成后自动发送」，排队卡片标题同一句', () => {
  const C = src('renderer', 'components', 'ChatArea.tsx');
  const MSG = "t('Compacting the context — messages send automatically when it finishes')";
  const notice = C.indexOf('{compacting && (');
  assert.ok(notice > 0);
  assert.ok(C.slice(notice, notice + 300).includes(MSG));
  assert.ok(notice < C.indexOf('<ChatInputBox', notice), '在输入框上方');
  assert.ok(C.includes(`compacting ? ${MSG} : t('Queued follow-ups')`));
  const A = src('renderer', 'App.tsx');
  assert.match(A, /compacting=\{!!sid && \(busyBySession\[sid\] === 'compacting' \|\| compactingIds\.includes\(sid\)\)\}/);
  assert.match(src('renderer', 'i18nZh', 'chat.ts'), /'Compacting the context — messages send automatically when it finishes': '正在压缩上下文，完成后自动发送'/);
});

test('自动压缩：发之前登记等完成，等主进程 acp:compact-finished 再决定会话里那句怎么说', () => {
  const f = between(M, 'function finishCompactWait(', '\n}\n');
  assert.match(f, /'acp:compact-finished', \{ sessionId, by: w\.finished\.by/);
  assert.match(src('main', 'preload.ts'), /onCompactFinished: [\s\S]{0,300}ipcRenderer\.on\('acp:compact-finished', handler\)/);
  const A = src('renderer', 'App.tsx');
  const e = between(A, 'const finished = waitCompactFinished(sid);', 'sessionNote?.(sid, text');
  const send = e.indexOf('await sendQueuedMessage(sid, command');
  assert.ok(send > 0, '登记在发送之前');
  const kind = e.indexOf('autoCompactNoteKind(ok ? await finished : null, ok)');
  assert.ok(kind > send, '那一轮结束后还等主进程确认');
  assert.ok(e.indexOf("kind === 'done'") > kind, '只有 done 才说已压缩');
  assert.match(A, /window\.kiroApi\.onCompactFinished\?\.\(/);
});

test('放行前先把到此为止的压缩花费补记上；不再靠「骤降后等 3 秒」；下一轮结束 / 出错时关上归属', () => {
  const f = between(M, 'function finishCompactWait(', '\n}\n');
  const write = f.indexOf('writeCompactUsage(sessionId, entry);');
  assert.ok(write > 0);
  assert.ok(write < f.indexOf('for (const go of waiters) go();'), '先补记再放行主进程里等着的');
  assert.ok(write < f.indexOf('emitSessionBusy(sessionId);'), '先补记再让界面排空队列');
  assert.ok(!/COMPACT_COST_GRACE|compactCostGraceExpired|compactSettleTimer/.test(M), '没有时间窗口了');
  const end = between(M, "const compactTurnEnd = entry.compactWait && !entry.compactWait.turnEnded", 'flushAssistant(sessionId); // turn complete');
  assert.match(end, /\} else if \(entry\.compactWait && !entry\.compactWait\.settled && entry\.compactWait\.turnEnded\) \{\s*\/\*[^*]*\*\/\s*settleCompactUsage\(sessionId, entry\);/, '压缩之后的下一轮结束：关上');
  const err = between(M, '/* 压缩之后的下一轮出错了：压缩的花费归属到此关上 */', 'flushAssistant(sessionId); // persist whatever completed before the error');
  assert.match(err, /settleCompactUsage\(sessionId, entry\)/);
});

test('回收执行器：end_turn 之后还在压缩的不收，压完 / 超时之后才可以收', async () => {
  const { canEvict, PrepHolds } = await import('../src/main/sendPrep.ts');
  const { startCompactWait, noteCompactTurnEnd, noteCompactUsage, expireCompactWait, COMPACT_WAIT_MAX_MS } = await import('../src/main/compactWait.ts');
  const holds = new PrepHolds();
  const meta = (pct: number, credits: number) => ({ sessionUpdate: '_kiro_internal', method: '_kiro.dev/metadata', contextUsagePercentage: pct, meteringUsage: [{ value: credits }] });
  let w = noteCompactTurnEnd(startCompactWait(0, 90), { engine: 'kiro', ok: true, now: 130 });
  assert.equal(canEvict('s1', { busy: false, compactWait: w }, undefined, holds), false, 'busy 已经清了，但还在压缩：不收');
  const done = noteCompactUsage(w, meta(4, 11.5), 4, 40_000);
  assert.equal(canEvict('s1', { busy: false, compactWait: done }, undefined, holds), true, '压完了：可以收');
  const expired = expireCompactWait(w, COMPACT_WAIT_MAX_MS);
  assert.equal(canEvict('s1', { busy: false, compactWait: expired }, undefined, holds), true, '超时放行了：可以收');
  assert.equal(canEvict('s1', { busy: false }, undefined, holds), true, '没压过缩：照旧');
  /* index.ts 的回收循环用的就是它（传整个 entry，带着 compactWait） */
  assert.match(M, /for \(const \[id, e\] of sessionClients\) \{[\s\S]{0,200}if \(!canEvict\(id, e, excludeId, sendPrepHolds\)\) continue;/);
});

test('/compact 还没回 end_turn 时（busy 仍报 turn）发的消息也不下发：从发出起就算压缩中，Enter / 插话 / 交给适配器都进 KiroLex 队列', () => {
  /* 主进程：发出 /compact 就推 compacting:true，压完 / 超时推 false */
  const b = between(M, 'function beginCompactWait(', '\n}\n');
  assert.match(b, /'acp:compacting', \{ sessionId, compacting: true \}/);
  const f = between(M, 'function finishCompactWait(', '\n}\n');
  assert.match(f, /'acp:compacting', \{ sessionId, compacting: false \}/);
  /* 主进程兜底：acp:steer / acp:handoff-prompt 压缩中一律不交给引擎（busy 检查之前） */
  const st = between(M, "ipcMain.handle('acp:steer'", 'const refused = steerRefusal(');
  assert.match(st, /if \(compactHolds\(entry\?\.compactWait\)\) \{[\s\S]{0,200}return \{ steered: false, reason: 'unsupported' \};/);
  const ho = between(M, "ipcMain.handle('acp:handoff-prompt'", 'sendPromptOnce(sessionId, prompt, projectId, {');
  assert.match(ho, /if \(compactHolds\(sessionClients\.get\(sessionId\)\?\.compactWait\)\) \{[\s\S]{0,200}return \{ accepted: false, reason: 'compacting' \};/);
  /* 渲染端：插话那条路先看压缩中，排队，不试 steer / handoff */
  const A = src('renderer', 'App.tsx');
  const steer = between(A, 'const handleSteerMessage = useCallback(', 'const steerId = ctl ?');
  const guard = steer.indexOf("if (compactingRef.current.has(sessionId) || busyBySessionRef.current[sessionId] === 'compacting') {");
  assert.ok(guard > 0);
  assert.ok(guard < steer.indexOf('const enterKind = busyEnterKind('), '在判能不能 steer 之前');
  assert.ok(steer.slice(guard, guard + 300).includes('queueAsNext();'));
  /* 渲染端：普通发送那条路，压缩中也排队（slash 命令除外，主进程 awaitCompactRelease 兜） */
  const send = between(A, 'const handleSendMessage = useCallback(', 'queueUntilConnected(');
  assert.match(send, /\|\| compactingRef\.current\.has\(sid\) \|\| startupBlocksSend\(createStages\[sid\]\)\)\) \{/);
  /* 界面：这期间也显示「正在压缩上下文，完成后自动发送」 */
  assert.match(A, /compacting=\{!!sid && \(busyBySession\[sid\] === 'compacting' \|\| compactingIds\.includes\(sid\)\)\}/);
  assert.match(A, /window\.kiroApi\.onCompacting\?\.\(/);
});

test('压缩中输入框的占位文字 / 快捷键提示 / 发送按钮都写「排队，压完后发送」，不说「追加到这一轮」', () => {
  const C = src('renderer', 'components', 'ChatArea.tsx');
  const box = between(C, 'const ChatInputBox = ', 'export ');
  const ph = between(box, 'placeholder={', 'value={input}');
  assert.ok(ph.indexOf('compacting') < ph.indexOf("t('Agent is working — Enter steers the running turn"), '压缩中的提示排在「追加到这一轮」前面');
  assert.ok(ph.includes("t('Compacting the context — Enter queues the message; it sends once compaction finishes')"));
  assert.ok(box.includes("? t('Enter queue (sends after compaction) · Shift+Enter newline')"));
  assert.ok(box.includes("? t('Queue to send after compaction (Enter)')"));
  assert.ok(box.includes('queueModifierHeld || compacting || (isStreaming && !canSteer) ? ('), '按钮图标是排队');
  assert.ok(C.includes('canSteer={engineCanSteer(engine, engineModels?.busyEnter)}\n                compacting={compacting}'), 'ChatArea 把压缩中传给输入框');
  const zh = src('renderer', 'i18nZh', 'chat.ts');
  assert.ok(zh.includes("'正在压缩上下文 —— Enter 排队，压完后自动发送'"));
});

test('压缩那一笔花费到了就关上归属（routeCompactFrame.settleAfter），之后的计量是下一轮自己的', () => {
  const w = between(M, 'const compactRoute = childSessionId ? null : routeCompactFrame(entry.compactWait, {', 'autonomousFrame(entry, data?.update');
  assert.match(w, /if \(compactRoute\.settleAfter\) settleCompactUsage\(sessionId, entry\);/);
});

test('压缩中换模型：切换等压缩完成（finishCompactWait 里 kick）；换了执行器压缩作废、放行；放行后先落定切换再发', () => {
  const runner = between(M, 'const pendingSwitchRunner = new PendingSwitchRunner(pendingSwitches, {', '});');
  assert.match(runner, /isHeld: \(sessionId\) => compactHolds\(sessionClients\.get\(sessionId\)\?\.compactWait\),/);
  const q = between(M, 'function queueSwitchWhileBusy(', 'const firstOfThisWait');
  const cb = q.indexOf("if (!settling && !fromPending) { const held = queueSwitchWhileCompacting(sessionId, kind, value, label); if (held) return held; }");
  assert.ok(cb > 0, '压缩中先记下，不走「立即切换」');
  assert.ok(cb < q.indexOf('if (!settling && !shouldQueueSwitch('), '在「不忙就立即切」之前');
  const qc = between(M, 'function queueSwitchWhileCompacting(', '\n}\n');
  assert.match(qc, /if \(!e \|\| e\.busy \|\| !compactHolds\(e\.compactWait\)\) return null;/);
  assert.match(qc, /pendingSwitches\.set\(sessionId, \{ kind, value, label \}\);/);
  assert.match(qc, /return \{ ok: true, pending: true \};/);
  const f = between(M, 'function finishCompactWait(', '\n}\n');
  assert.match(f, /void pendingSwitchRunner\.kick\(sessionId\);/);
  const ad = between(M, 'function adoptExecutor(', '\n}\n');
  assert.match(ad, /entry\.compactWait = undefined;/, '新执行器不继承压缩状态');
  assert.match(ad, /if \(compactHolds\(carried\) \|\| compactWaiters\.has\(sessionId\)\) abandonCompactWait\(sessionId, what\);/);
  const ab = between(M, 'function abandonCompactWait(', '\n}\n');
  assert.match(ab, /for \(const go of waiters\) go\(\);/);
  assert.match(ab, /'acp:compacting', \{ sessionId, compacting: false \}/);
  const b = between(M, 'function beginCompactWait(', '\n}\n');
  assert.match(b, /get: \(\) => sessionClients\.get\(sessionId\)\?\.compactWait,/, '定时器按会话读此刻挂着的执行器');
  assert.match(b, /onExpired: \(\) => \{ const live = sessionClients\.get\(sessionId\); if \(live\) finishCompactWait\(sessionId, live\); \},/);
  assert.match(M, /if \(attempt === 0 && await awaitCompactRelease\(sessionId\)\) await pendingSwitchRunner\.settle\(sessionId\);/);
});

test('会话里那张「等着切换」的卡片：在等的是压缩时说「正在压缩上下文，压完后切到…」，不给「停止这一轮」', () => {
  const C = src('renderer', 'components', 'ChatArea.tsx');
  const card = between(C, 'function PendingSwitchCard(', '\n}\n');
  assert.ok(card.includes("t('⏳ Compacting the context; will switch to {target} once it finishes (waited {n}s).'"));
  assert.ok(card.includes('{onStopNow && !compacting && <button'));
  const pc = between(C, 'const pendingCard = hasPendingSwitch ? {', '} : null;');
  assert.ok(pc.includes('compacting,'));
  assert.ok(src('renderer', 'i18nZh', 'chat.ts').includes("'⏳ 正在压缩上下文，压完后切到 {target}（已等 {n} 秒）'"));
});

test('压缩中断线 / detach / 重连 / 换模型：四处摘执行器之前都先 endCompactWaitForExecutor；定时器查不到执行器也放行', () => {
  const anchors: Array<[string, string]> = [
    ["  reconfiguringSessions.add(sessionId);\n  endCompactWaitForExecutor(sessionId, entry, 'reconnect');\n  sessionClients.delete(sessionId);", 'reconnect'],
    ["    endCompactWaitForExecutor(sessionId, entry, 'executor disconnected');\n    sessionClients.delete(sessionId);", 'disconnected'],
    ["  endCompactWaitForExecutor(sessionId, entry, 'executor detached');\n  sessionClients.delete(sessionId); // free the slot synchronously", 'detach'],
    ["    endCompactWaitForExecutor(sessionId, oldEntry, 'model switch');\n    sessionClients.delete(sessionId); // release the slot + ownership claim", 'model switch'],
  ];
  for (const [a, what] of anchors) assert.ok(M.includes(a), what);
  const fn = between(M, 'function endCompactWaitForExecutor(', '\n}\n');
  assert.match(fn, /compactOnExecutorGone\(entry\?\.compactWait, compactWaiters\.has\(sessionId\)\)/);
  assert.match(fn, /clearTimeout\(entry\.compactWaitTimer\)/);
  assert.match(fn, /if \(plan\.abandon\) abandonCompactWait\(sessionId, why\);/);
  const b = between(M, 'function beginCompactWait(', '\n}\n');
  assert.match(b, /onGone: \(\) => \{ if \(compactWaiters\.has\(sessionId\)\) abandonCompactWait\(sessionId, 'timer found no executor'\); \},/);
});
