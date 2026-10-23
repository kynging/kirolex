import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { isReplayOutsideTurn, outsideTurnVerdict } from '../src/main/replayGuard.ts';
import {
  AUTONOMOUS_MAX_MS, AUTONOMOUS_QUIET_MS, autonomousFrame, autonomousTurnEnded, beginAutonomousTurn, endAutonomousTurn,
  type AutonomousDeps, type AutonomousHost, type AutonomousTurn,
} from '../src/main/autonomousTurn.ts';
import { hasPendingClaudeCron, noteClaudeCronTool } from '../src/main/claudeCron.ts';
import { ADAPTER_SCHEDULE_NOTE, adapterScheduleNote } from '../src/main/wakeTools.ts';

/*
  「Claude Code 自发的一轮（CronCreate 到点 / 后台任务跟进）被当回放丢掉」。
  2026-10-22 远端实测（claude-agent-acp 0.88.0 + Claude Code 2.1.284）：CronCreate 定的一次性提示到点时，
  **没有任何在途的 session/prompt**，适配器自己推了 usage_update → agent_message_chunk "PONG" → usage_update（带 cost）。
  原来 `isReplayOutsideTurn` 把一轮之外的正文一律当回放丢，用户看不到、也不落盘。
  这里守的是：回放窗口（attach / load 之后、首个用户轮之前）里照旧丢；窗口外、不在一轮里的正文按「后端自己起了一轮」处理；
  轮内照旧；kiro 会话不变（kiro-cli 不这样推）。
*/

const chunk = (kind: string, text = 'x') => ({ sessionUpdate: kind, content: { type: 'text', text } });
const PONG_FRAMES = [
  { sessionUpdate: 'usage_update', used: 31493, size: 1000000 },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' }, messageId: 'msg_bdrk_1' },
  { sessionUpdate: 'usage_update', used: 31493, size: 1000000, cost: { amount: 0.00562701, currency: 'USD' } },
];

// ---------------------------------------------------------------------------
// 1. 判据
// ---------------------------------------------------------------------------

test('回放窗口内：一轮之外的正文（用户 / 助手 / 思考块）照旧当回放丢 —— 所有引擎', () => {
  for (const engine of ['kiro', 'claude', 'codex', undefined]) {
    for (const kind of ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'agent_reasoning_chunk']) {
      assert.equal(outsideTurnVerdict(chunk(kind), { inTurn: false, replayWindow: true, engine }), 'replay', `${engine} ${kind}`);
    }
  }
});

test('回放窗口外、不在一轮里：Claude Code / Codex 的助手正文和思考块 = 后端自己起了一轮', () => {
  for (const engine of ['claude', 'codex']) {
    for (const kind of ['agent_message_chunk', 'agent_thought_chunk', 'agent_reasoning_chunk']) {
      assert.equal(outsideTurnVerdict(chunk(kind), { inTurn: false, replayWindow: false, engine }), 'autonomous', `${engine} ${kind}`);
    }
  }
});

test('回放窗口外的 user_message_chunk 不起自发轮（不伪造用户消息），照旧丢', () => {
  assert.equal(outsideTurnVerdict(chunk('user_message_chunk'), { inTurn: false, replayWindow: false, engine: 'claude' }), 'replay');
});

test('kiro 会话行为不变：窗口外、一轮之外的正文照旧当回放丢（kiro-cli 不会自己起一轮）', () => {
  for (const kind of ['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk']) {
    assert.equal(outsideTurnVerdict(chunk(kind), { inTurn: false, replayWindow: false, engine: 'kiro' }), 'replay');
    assert.equal(outsideTurnVerdict(chunk(kind), { inTurn: false, replayWindow: false }), 'replay', '没有引擎信息按 kiro');
  }
});

test('一轮之内照旧（不管窗口），不是正文的更新一轮之外照常转发', () => {
  for (const replayWindow of [true, false]) {
    assert.equal(outsideTurnVerdict(chunk('agent_message_chunk'), { inTurn: true, replayWindow, engine: 'claude' }), null);
  }
  for (const u of [{ sessionUpdate: 'usage_update' }, { sessionUpdate: 'tool_call' }, { sessionUpdate: 'plan' }, {}, null, undefined]) {
    assert.equal(outsideTurnVerdict(u as any, { inTurn: false, replayWindow: false, engine: 'claude' }), null, JSON.stringify(u));
  }
  /* 原来的判据原样还在（acpReplayTiming / newSessionReplay 用它） */
  assert.equal(isReplayOutsideTurn(chunk('agent_message_chunk'), false), true);
});

test('自发轮的结束信号：usage_update 带 cost（适配器的 result）/ Codex 的 threadStatus idle；不带 cost 的不算', () => {
  assert.equal(autonomousTurnEnded(PONG_FRAMES[2]), true);
  assert.equal(autonomousTurnEnded(PONG_FRAMES[0]), false);
  assert.equal(autonomousTurnEnded(PONG_FRAMES[1]), false);
  assert.equal(autonomousTurnEnded({ sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'idle' } } } }), true);
  assert.equal(autonomousTurnEnded({ sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'active' } } } }), false);
});

// ---------------------------------------------------------------------------
// 2. 一轮的生命周期：照 wireSession 的接法驱动实测那三帧
// ---------------------------------------------------------------------------

function harness(engine = 'claude') {
  let now = 1000;
  const timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
  const transcript: any[] = [];
  const shown: string[] = [];
  const entry: AutonomousHost & { busy: boolean; replayWindow: boolean; assistantBuf: string; assistantMsgId: string | null; currentUserMessageId?: string; openTools: number } = {
    busy: false, replayWindow: true, assistantBuf: '', assistantMsgId: null, currentUserMessageId: 'u_prev', openTools: 0,
  };
  let prevUser: string | undefined;
  const deps: AutonomousDeps = {
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, live: true }; timers.push(t); return t; },
    clearTimer: (h: any) => { if (h) h.live = false; },
    hasOpenTools: () => entry.openTools > 0,
    announce: (turn: AutonomousTurn) => {
      /* index.ts：来源标记落盘成一条 KiroLex 提示 + acp:main-turn 让界面接管这一轮的流 */
      transcript.push({ id: turn.noteId, role: 'user', content: '⏰ 后台触发', kirolex: true });
      shown.push('note');
      /* index.ts autonomousDeps.announce：这一轮没有用户消息 —— currentUserMessageId 先摘掉 */
      prevUser = entry.currentUserMessageId;
      entry.currentUserMessageId = undefined;
    },
    finish: () => {
      /* index.ts：flushAssistant(sessionId, { autonomous: true, entry }) 落盘的那条（同样的字段规则：replyTo 取 currentUserMessageId） */
      const replyTo = entry.currentUserMessageId;
      if (entry.assistantBuf) {
        transcript.push({ id: entry.assistantMsgId || 'a_x', role: 'assistant', content: entry.assistantBuf, ts: now, ...(replyTo ? { replyTo } : {}), origin: 'autonomous' });
      }
      if (entry.currentUserMessageId === undefined) entry.currentUserMessageId = prevUser;
      entry.assistantBuf = '';
      entry.assistantMsgId = null;
      shown.push('end');
    },
  };
  /** wireSession 的顺序：守卫判 → 自发轮开始 → 累加 / 转发 → 自发轮看帧 */
  const frame = (u: any) => {
    const verdict = outsideTurnVerdict(u, { inTurn: entry.busy || !!entry.autonomous, replayWindow: entry.replayWindow, engine });
    if (verdict === 'replay') { shown.push(`dropped:${u.sessionUpdate}`); return; }
    if (verdict === 'autonomous') beginAutonomousTurn(entry, deps);
    if (u?.sessionUpdate === 'agent_message_chunk') {
      entry.assistantBuf += u.content.text;
      entry.assistantMsgId ||= u.messageId || 'a_1';
      shown.push(`text:${u.content.text}`);
    }
    if (entry.autonomous) autonomousFrame(entry, u, deps);
  };
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers]) if (t.live && t.at <= now) { t.live = false; t.fn(); }
  };
  return { entry, deps, frame, advance, transcript, shown };
}

test('实测那三帧（Cron 到点的 PONG）：窗口已关 → 当成自发轮，显示、带来源标记，见到带 cost 的 usage_update 就结束并落盘一条助手消息', () => {
  const h = harness();
  h.entry.replayWindow = false;   // 这条会话已经跑过一轮（CronCreate 就是那一轮里定的）
  for (const f of PONG_FRAMES) h.frame(f);
  assert.deepEqual(h.shown, ['note', 'text:PONG', 'end']);
  assert.equal(h.entry.autonomous, undefined, '这一轮结束了');
  assert.equal(h.transcript.length, 2);
  const [note, reply] = h.transcript;
  assert.equal(note.kirolex, true, '来源标记是 KiroLex 提示，不是伪造的用户消息');
  assert.equal(reply.role, 'assistant');
  assert.equal(reply.content, 'PONG');
  assert.equal(reply.id, 'msg_bdrk_1');
  assert.equal(reply.origin, 'autonomous', '落盘的助手消息带来源标记');
  assert.equal(reply.replyTo, undefined, '自发轮不是在回哪条用户消息（不能把上一条用户消息标成「答过了」）');
  assert.equal(reply.replyComplete, undefined);
  assert.equal(h.entry.currentUserMessageId, 'u_prev', '收尾后还回去（之后的 steer 落盘照旧并进上一条）');
});

test('同样三帧落在回放窗口里（attach 后、首个用户轮之前）：照旧丢，不起自发轮、不落盘', () => {
  const h = harness();
  for (const f of PONG_FRAMES) h.frame(f);
  assert.deepEqual(h.shown, ['dropped:agent_message_chunk']);
  assert.equal(h.entry.autonomous, undefined);
  assert.deepEqual(h.transcript, []);
});

test('kiro 会话：窗口外也照旧丢', () => {
  const h = harness('kiro');
  h.entry.replayWindow = false;
  for (const f of PONG_FRAMES) h.frame(f);
  assert.deepEqual(h.shown, ['dropped:agent_message_chunk']);
  assert.deepEqual(h.transcript, []);
});

test('一轮之内（busy）照旧：不起自发轮', () => {
  const h = harness();
  h.entry.replayWindow = false;
  h.entry.busy = true;
  for (const f of PONG_FRAMES) h.frame(f);
  assert.deepEqual(h.shown, ['text:PONG']);
  assert.equal(h.entry.autonomous, undefined);
});

test('自发轮里连着来的几块正文是同一轮（来源标记只打一次）', () => {
  const h = harness();
  h.entry.replayWindow = false;
  h.frame({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PO' }, messageId: 'm1' });
  h.frame({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NG' }, messageId: 'm1' });
  h.frame(PONG_FRAMES[2]);
  assert.deepEqual(h.shown, ['note', 'text:PO', 'text:NG', 'end']);
  assert.equal(h.transcript.filter((m) => m.role === 'assistant').length, 1);
  assert.equal(h.transcript[1].content, 'PONG');
});

test('没有结束信号：一段时间没有新帧就收尾落盘；每来一帧重新计时', () => {
  const h = harness();
  h.entry.replayWindow = false;
  h.frame(chunk('agent_message_chunk', 'a'));
  h.advance(AUTONOMOUS_QUIET_MS - 1000);
  h.frame(chunk('agent_message_chunk', 'b'));
  h.advance(AUTONOMOUS_QUIET_MS - 1000);
  assert.ok(h.entry.autonomous, '一直有帧来，没到安静时限');
  h.advance(2000);
  assert.equal(h.entry.autonomous, undefined);
  assert.equal(h.transcript[1].content, 'ab');
});

test('安静时限到了但还有工具在跑：接着等（有上限），工具跑完再安静才收尾', () => {
  const h = harness();
  h.entry.replayWindow = false;
  h.frame(chunk('agent_message_chunk', 'a'));
  h.entry.openTools = 1;
  h.advance(AUTONOMOUS_QUIET_MS + 1);
  assert.ok(h.entry.autonomous, '工具还开着，不收');
  h.entry.openTools = 0;
  h.advance(AUTONOMOUS_QUIET_MS + 1);
  assert.equal(h.entry.autonomous, undefined);
  /* 工具一直不结束：到总时限也收 */
  const g = harness();
  g.entry.replayWindow = false;
  g.frame(chunk('agent_message_chunk', 'a'));
  g.entry.openTools = 1;
  for (let i = 0; i < Math.ceil(AUTONOMOUS_MAX_MS / AUTONOMOUS_QUIET_MS) + 2 && g.entry.autonomous; i++) g.advance(AUTONOMOUS_QUIET_MS + 1);
  assert.equal(g.entry.autonomous, undefined);
});

test('endAutonomousTurn 只收一次（用户发了新的一轮 / 停止 / 执行器没了，和结束信号撞在一起也不重复落盘）', () => {
  const h = harness();
  h.entry.replayWindow = false;
  h.frame(chunk('agent_message_chunk', 'a'));
  assert.equal(endAutonomousTurn(h.entry, h.deps, 'user turn'), true);
  assert.equal(endAutonomousTurn(h.entry, h.deps, 'again'), false);
  h.advance(AUTONOMOUS_QUIET_MS * 3);
  assert.equal(h.shown.filter((s) => s === 'end').length, 1);
  assert.equal(h.transcript.filter((m) => m.role === 'assistant').length, 1);
});

// ---------------------------------------------------------------------------
// 3. Claude 自己定的 cron：LRU 驱逐时提示
// ---------------------------------------------------------------------------

const cronCall = (toolCallId: string, name: string, extra: any = {}) => ({
  sessionUpdate: 'tool_call', toolCallId, title: name, kind: 'other', status: 'pending', _meta: { claudeCode: { toolName: name } }, ...extra,
});

test('CronCreate 之后没有对应的 CronDelete → 有待触发的；删掉（按 id 对上）就没有了', () => {
  let t = noteClaudeCronTool(undefined, cronCall('c1', 'CronCreate', { rawInput: { cron: '*/5 * * * *', prompt: 'p', recurring: true } }));
  t = noteClaudeCronTool(t, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Scheduled job 7f3a9c (every 5 minutes)' } }] });
  assert.equal(hasPendingClaudeCron(t), true);
  t = noteClaudeCronTool(t, cronCall('d1', 'CronDelete', { rawInput: { id: '7f3a9c' } }));
  t = noteClaudeCronTool(t, { sessionUpdate: 'tool_call_update', toolCallId: 'd1', status: 'completed' });
  assert.equal(hasPendingClaudeCron(t), false);
});

test('实测形状（0.88.0，2026-10-23）：rawInput 在后面的 update 里才到，job id 在 _meta.claudeCode.toolResponse.id', () => {
  let t = noteClaudeCronTool(undefined, cronCall('c1', 'CronCreate', { rawInput: {} }));
  t = noteClaudeCronTool(t, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', rawInput: { cron: '01 14 23 10 *', prompt: 'Reply with exactly: PONG', recurring: false } });
  t = noteClaudeCronTool(t, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', _meta: { claudeCode: { toolResponse: { id: '7fd20cad', humanSchedule: '01 14 23 10 *', recurring: false, durable: false }, toolName: 'CronCreate' } } });
  t = noteClaudeCronTool(t, cronCall('c2', 'CronCreate', { status: 'completed', _meta: { claudeCode: { toolName: 'CronCreate', toolResponse: { id: 'aaaa1111' } } } }));
  assert.equal(hasPendingClaudeCron(t), true);
  /* 删的是第二个（按 id 对上，不是摘最早的） */
  t = noteClaudeCronTool(t, cronCall('d1', 'CronDelete', { rawInput: { id: 'aaaa1111' }, status: 'completed' }));
  assert.deepEqual(t!.creates.map((c) => c.jobId), ['7fd20cad']);
});

test('CronCreate 失败的不算；只认标题 / _meta 里的工具名；CronDelete 对不上 id 时摘最早的一个', () => {
  let t = noteClaudeCronTool(undefined, cronCall('c1', 'CronCreate'));
  t = noteClaudeCronTool(t, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed' });
  assert.equal(hasPendingClaudeCron(t), false);
  t = noteClaudeCronTool(t, { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'CronCreate', status: 'pending' });
  t = noteClaudeCronTool(t, { sessionUpdate: 'tool_call', toolCallId: 'c3', title: 'x', status: 'pending', _meta: { claudeCode: { toolName: 'CronCreate' } } });
  assert.equal(hasPendingClaudeCron(t), true);
  t = noteClaudeCronTool(t, cronCall('d1', 'CronDelete', { rawInput: { id: 'nope' }, status: 'completed' }));
  assert.equal(hasPendingClaudeCron(t), true, '还剩一个');
  t = noteClaudeCronTool(t, cronCall('d2', 'CronDelete', { status: 'completed' }));
  assert.equal(hasPendingClaudeCron(t), false);
  /* 别的工具不碰 */
  assert.equal(noteClaudeCronTool(undefined, cronCall('b', 'Bash')), undefined);
  assert.equal(hasPendingClaudeCron(undefined), false);
});

// ---------------------------------------------------------------------------
// 4. 引导模型用 schedule_create
// ---------------------------------------------------------------------------

test('Claude Code / Codex 会话的说明：要定时 / 稍后再看用 schedule_create，不用 CronCreate / ScheduleWakeup；kiro 不说', () => {
  assert.match(ADAPTER_SCHEDULE_NOTE, /schedule_create/);
  assert.match(ADAPTER_SCHEDULE_NOTE, /CronCreate/);
  assert.match(ADAPTER_SCHEDULE_NOTE, /ScheduleWakeup/);
  assert.match(ADAPTER_SCHEDULE_NOTE, /换后端/);
  assert.equal(adapterScheduleNote('claude'), ADAPTER_SCHEDULE_NOTE);
  assert.equal(adapterScheduleNote('codex'), ADAPTER_SCHEDULE_NOTE);
  assert.equal(adapterScheduleNote('kiro'), '');
  assert.equal(adapterScheduleNote(undefined), '');
});

// ---------------------------------------------------------------------------
// 5. 接线（index.ts 不能 import，源码扫描）
// ---------------------------------------------------------------------------

const MAIN = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
const wire = MAIN.slice(MAIN.indexOf('function wireSession(sessionId: string, entry: SessionEntry) {'), MAIN.indexOf('/** Flush the accumulated assistant message to the durable transcript'));

test('接线：wireSession 开回放窗口，按 outsideTurnVerdict 分流：replay 丢、autonomous 起一轮，在累加 assistantBuf 之前', () => {
  assert.match(wire, /entry\.replayWindow = true;/);
  const v = wire.indexOf('const verdict = outsideTurnVerdict(data?.update, {');
  assert.ok(v > 0, '没有分流');
  assert.ok(v > wire.indexOf('if (entry.priming) return;'));
  const acc = wire.indexOf("entry.assistantBuf += u?.content?.text || '';");
  assert.ok(v < acc);
  const seg = wire.slice(v, acc);
  assert.match(seg, /inTurn: !!entry\.busy \|\| !!entry\.autonomous/);
  assert.match(seg, /engine: engineOf\(entry\.profile\)/);
  assert.match(seg, /if \(verdict === 'replay'\) \{[\s\S]*?logger\.warn\('acp', `dropped replayed[\s\S]*?return;/);
  assert.match(seg, /if \(verdict === 'autonomous'\) beginAutonomous\(sessionId, entry\);/);
  /* 自发轮看每一帧（结束信号 / 安静计时），在转发之前 */
  const f = wire.indexOf('if (entry.autonomous) autonomousFrame(entry, data?.update, autonomousDeps(sessionId, entry));');
  assert.ok(f > acc && f < wire.indexOf("mainWindow?.webContents.send('acp:update'"));
  /* Claude 自己定的 cron：从 tool_call 认 */
  assert.match(wire, /entry\.claudeCrons = noteClaudeCronTool\(entry\.claudeCrons, u\);/);
  /* 执行器没了：自发轮也收尾 */
  assert.match(wire, /client\.on\('disconnected', \(\) => \{\s*if \(entry\.autonomous\) endAutonomousTurn\(entry, autonomousDeps\(sessionId, entry\), 'disconnected'\);/);
});

test('接线：回放窗口在 KiroLex 发起的第一轮开始时关；换后端会话（session/new）重新打开', () => {
  const at = MAIN.indexOf('entry.busy = true; // in-flight turn — exempt from LRU eviction');
  assert.ok(at > 0);
  assert.match(MAIN.slice(at, at + 400), /entry\.replayWindow = false;/);
  const rb = MAIN.slice(MAIN.indexOf('async function recreateBackendSession('), MAIN.indexOf('async function recreateBackendSession(') + 600);
  assert.match(rb, /entry\.replayWindow = true;/);
});

test('接线：自发轮没收尾时，新的一轮（定时提示 / 后台唤醒 / 队列）算撞上忙，忙时 Enter 排进 KiroLex 队列 —— 两轮的输出不串在一起', () => {
  const sp = MAIN.slice(MAIN.indexOf('async function sendPromptOnce('), MAIN.indexOf('entry.busy = true; // in-flight turn — exempt from LRU eviction'));
  assert.match(sp, /if \(entry\.autonomous && !handoff\) \{\s*throw Object\.assign\([\s\S]*?\{ code: SESSION_BUSY \}\);/);
  assert.match(sp, /if \(handoff\?\.kind === 'queued'\) \{[\s\S]*?if \(entry\.autonomous\) throw new HandoffRefused\('unsupported'\);/);
  const steer = MAIN.slice(MAIN.indexOf("ipcMain.handle('acp:steer'"), MAIN.indexOf("ipcMain.handle('acp:steer'") + 1200);
  const a = steer.indexOf("if (entry?.autonomous) return { steered: false, reason: 'unsupported' };");
  assert.ok(a > 0 && a < steer.indexOf('const refused = steerRefusal('), '要在「已空闲」判定之前');
});

test('接线：自发轮 = 界面上的「一轮」（busy 报 turn、不被 LRU 回收），停止也收它；结束时 flushAssistant 带来源标记', () => {
  const br = MAIN.slice(MAIN.indexOf('function busyReasonFor(sessionId: string): BusyReason {'), MAIN.indexOf('function emitSessionBusy(sessionId: string) {'));
  assert.match(br, /if \(entry\?\.busy \|\| entry\?\.autonomous\) return 'turn';/);
  const cap = MAIN.slice(MAIN.indexOf('function ensureExecutorCapacity('), MAIN.indexOf('const gotSingleInstanceLock'));
  assert.match(cap, /if \(id === excludeId \|\| e\.busy \|\| e\.autonomous\) continue;/);
  const cancel = MAIN.slice(MAIN.indexOf("ipcMain.handle('acp:cancel'"), MAIN.indexOf("ipcMain.handle('acp:cap-steer-text'"));
  assert.match(cancel, /if \(entry\.autonomous\) endAutonomousTurn\(entry, autonomousDeps\(sessionId, entry\), 'cancelled'\);/);
  const deps = MAIN.slice(MAIN.indexOf('function autonomousDeps('), MAIN.indexOf('function autonomousDeps(') + 2500);
  assert.match(deps, /flushAssistant\(sessionId, \{ autonomous: true, entry \}\)/);
  assert.match(deps, /emitSessionBusy\(sessionId\)/);
  assert.match(deps, /store\.appendMessage\(sessionId, \{ id: turn\.noteId, role: 'user', content: text, ts, kirolex: true/);
  assert.match(deps, /webContents\.send\('acp:main-turn', \{ sessionId, messageId: turn\.noteId, content: text, ts, kirolex: true \}\)/);
  /* 这一轮没有用户消息：回复不带 replyTo，收尾后还回去 */
  assert.match(deps, /entry\.currentUserMessageId = undefined;/);
  assert.match(deps, /entry\.currentUserMessageId = autonomousPrevUser\.get\(entry\);/);
  const flush = MAIN.slice(MAIN.indexOf('function flushAssistant('), MAIN.indexOf('function beginAutonomous('));
  assert.match(flush, /const entry = opts\?\.entry \?\? sessionClients\.get\(sessionId\);/);
  assert.match(flush, /const replyTo = entry\?\.currentUserMessageId;/);
  assert.match(flush, /\.\.\.\(opts\?\.autonomous \? \{ origin: 'autonomous' as const \} : \{\}\),\s*\}\);/);
});

test('接线：LRU 驱逐有待触发 Claude cron 的执行器时，在那条会话里提示一句（不阻止驱逐）', () => {
  const cap = MAIN.slice(MAIN.indexOf('function ensureExecutorCapacity('), MAIN.indexOf('const gotSingleInstanceLock'));
  const ev = cap.indexOf('detachExecutor(victim);');
  const before = cap.slice(0, ev);
  assert.match(before, /if \(hasPendingClaudeCron\(sessionClients\.get\(victim\)\?\.claudeCrons\)\) \{[\s\S]*?noteInSession\(victim, tr\(/);
});

test('接线：Claude Code / Codex 会话每轮注入 schedule_create 优先的那句', () => {
  const at = MAIN.indexOf('const note = workdirNoteFor(sessionId, entry);');
  assert.ok(at > 0);
  const seg = MAIN.slice(at, at + 1200);
  assert.match(seg, /const sched = adapterScheduleNote\(engineOf\(entry\.profile\)\);\s*if \(sched\) prompt = \[\{ type: 'text', text: sched \}, \.\.\.prompt\];/);
});

// ---------------------------------------------------------------------------
// 6. 自发轮在跑时：等待退出 / 忙时切换 / 窗口重载后接管（审查跟进）
// ---------------------------------------------------------------------------

import { blocksQuit, collectBusySessions } from '../src/main/busySessions.ts';

test('等待退出：自发轮算在跑的一轮（busy 为假也挡退出），收尾之后才放行', () => {
  const gb = MAIN.slice(MAIN.indexOf('function getBusySessions(): BusySession[] {'), MAIN.indexOf("ipcMain.handle('control:pending-quit'"));
  assert.match(gb, /for \(const \[id, e\] of sessionClients\) if \(e\.busy \|\| e\.autonomous\) turns\.add\(id\);/);
  /* 照 getBusySessions 的收集方式：自发轮进行中 → 挡退出；收尾（autonomous 摘掉）→ 不挡 */
  const entries = new Map<string, { busy?: boolean; autonomous?: object }>([['s1', { busy: false, autonomous: { startedAt: 1 } }]]);
  const turnsOf = () => { const t = new Set<string>(); for (const [id, e] of entries) if (e.busy || e.autonomous) t.add(id); return t; };
  assert.equal(collectBusySessions({ turns: turnsOf() }).some(blocksQuit), true, '自发轮还没收尾：等');
  entries.get('s1')!.autonomous = undefined;
  assert.equal(collectBusySessions({ turns: turnsOf() }).some(blocksQuit), false, '收尾落盘之后：可以退');
});

test('忙时切换（模型 / agent / 运行位置…）：自发轮在跑也先记下，收尾时 kick 应用 —— 不截断正在输出的回复', () => {
  const runner = MAIN.slice(MAIN.indexOf('const pendingSwitchRunner = new PendingSwitchRunner('), MAIN.indexOf('function emitPendingSwitches('));
  assert.match(runner, /isBusy: \(sessionId\) => \{ const e = sessionClients\.get\(sessionId\); return !!e\?\.busy \|\| !!e\?\.autonomous; \}/);
  const q = MAIN.slice(MAIN.indexOf('function queueSwitchWhileBusy('), MAIN.indexOf('function consumePendingProjectReset('));
  assert.match(q, /const autonomousRunning = !!sessionClients\.get\(sessionId\)\?\.autonomous && !fromPending;/);
  assert.match(q, /fromPending \}\) && !autonomousRunning\) return null;/);
  const deps = MAIN.slice(MAIN.indexOf('function autonomousDeps('), MAIN.indexOf('function autonomousDeps(') + 3500);
  const fin = deps.slice(deps.indexOf('finish: (turn, why) => {'));
  const flush = fin.indexOf('flushAssistant(sessionId, { autonomous: true, entry });');
  const kick = fin.indexOf('void pendingSwitchRunner.kick(sessionId);');
  assert.ok(flush >= 0 && kick > flush, '先落盘回复、再应用切换');
});

test('窗口重载后：acp:peek-turn 认自发轮（live、当前消息 id、已累计正文、开始时间），渲染端照常接管', () => {
  const pk = MAIN.slice(MAIN.indexOf("ipcMain.handle('acp:peek-turn'"), MAIN.indexOf("ipcMain.handle('acp:session-commands'"));
  assert.match(pk, /if \(entry\?\.autonomous && !entry\.busy && !entry\.priming\) \{\s*return \{ live: true, messageId: entry\.assistantMsgId, text: entry\.assistantBuf \|\| '', startedAt: entry\.autonomous\.startedAt \};/);
  /* 渲染端：最后一条是 KiroLex 提示（来源标记）时往回跳过它、看到上一条回复 → 问 peek → live 就接管 */
  const H = fs.readFileSync(new URL('../src/renderer/hooks/useAcp.ts', import.meta.url), 'utf8');
  assert.match(H, /if \(peek\?\.live && !streamingIdsRef\.current\.has\(sid\)\) \{ adoptTurn\(sid, peek\); return; \}/);
});

test('移动项目 / 归档：后端自己起的一轮在输出时不当场断开执行器，推迟到它收尾 —— 先落盘回复，再断开', () => {
  const mv = MAIN.slice(MAIN.indexOf("ipcMain.handle('acp:move-session'"), MAIN.indexOf("ipcMain.handle('acp:get-executor-cap'"));
  const auto = mv.indexOf('if (!busy && sessionClients.get(sessionId)?.autonomous) {');
  assert.ok(auto > 0, '没有自发轮的推迟');
  assert.ok(auto < mv.indexOf('detachExecutor(sessionId); // executor reset'), '要在当场断开之前');
  assert.match(mv.slice(auto, auto + 700), /pendingProjectReset\.add\(sessionId\);[\s\S]*?return \{ sessionId, projectId: projectId \?\? null, deferredReset: true \};/);
  /* 多台机器之间位置跟随（同一件事从别的机器来）也一样 */
  assert.match(MAIN, /if \(live\?\.busy \|\| live\?\.autonomous\) pendingProjectReset\.add\(r\.id\);/);
  assert.match(MAIN, /if \(cl\?\.busy \|\| cl\?\.autonomous\) pendingProjectReset\.add\(sessionId\);/);
  /* 收尾：先 flush（落盘），再消化推迟的重置；只断开还挂着的这个执行器 */
  const deps = MAIN.slice(MAIN.indexOf('function autonomousDeps('), MAIN.indexOf('function autonomousDeps(') + 4000);
  const fin = deps.slice(deps.indexOf('finish: (turn, why) => {'));
  const flush = fin.indexOf('flushAssistant(sessionId, { autonomous: true, entry });');
  const reset = fin.indexOf("if (sessionClients.get(sessionId) === entry) consumePendingProjectReset(sessionId, '后端自己起的一轮结束，执行下推的执行器重置');");
  assert.ok(flush >= 0 && reset > flush, '先落盘回复、再断开执行器');
});

test('移动项目的时序（照 move-session + autonomousDeps.finish 的接法）：输出中移动 → 执行器还在、回复照常累加 → 收尾落盘之后才断开', () => {
  const h = harness();
  h.entry.replayWindow = false;
  const pendingProjectReset = new Set<string>();
  let detached = false;
  const finish = h.deps.finish;
  h.deps.finish = (turn, why) => {
    finish(turn, why);                                   // flushAssistant：先落盘
    if (pendingProjectReset.delete('s1')) detached = true; // consumePendingProjectReset → detachExecutor
  };
  /* move-session：自发轮在输出 → 记下推迟，不断开 */
  const move = () => { if (!h.entry.busy && h.entry.autonomous) { pendingProjectReset.add('s1'); return 'deferred'; } detached = true; return 'now'; };
  h.frame({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PO' }, messageId: 'm1' });
  assert.equal(move(), 'deferred');
  assert.equal(detached, false, '回复还在输出，执行器不断开');
  h.frame({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NG' }, messageId: 'm1' });
  h.frame(PONG_FRAMES[2]);
  assert.equal(h.transcript.find((m) => m.role === 'assistant')?.content, 'PONG', '完整的回复落了盘');
  assert.equal(detached, true, '收尾之后才断开');
  /* 不在自发轮里：照旧当场断开 */
  const g = harness();
  detached = false;
  assert.equal(((): string => { if (!g.entry.busy && g.entry.autonomous) return 'deferred'; detached = true; return 'now'; })(), 'now');
});
