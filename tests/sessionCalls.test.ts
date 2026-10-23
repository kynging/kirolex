import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHAIN_MAX_DEPTH, IDLE_CONFIRM_TICKS, PAIR_RATE, REPLY_DEFAULT_TIMEOUT_SEC, REPLY_MAX_TIMEOUT_SEC,
  PairRateLimiter, ReplyWatcher, callSessionTool, chainDepth, checkSendArgs, findReply, fromHeader, maxHeaderDepth, parseHeader,
  readCount, replyHeader, sessionSegments, sessionToolDefs, splitSessionHeader,
  type ReplyWatch, type SessionCallsHost, type SessionInfo,
} from '../src/main/sessionCalls.ts';
import { CONTROL_SEND_MAX, CONTROL_TEXT_MAX, carryControlMark, controlMessageId, isControlMessageId, isSessionMessageId, markOrigin, viaFor } from '../src/main/controlSessions.ts';
import { callTool, toolDefs, type LocalMcpDeps } from '../src/main/localMcp.ts';
import { enterRoute, engineCanSteer } from '../src/renderer/steerRoute.ts';
import { queuedBatchMessageId } from '../src/renderer/queueRetry.ts';
import { joinQueuedBatch } from '../src/renderer/queueBatch.ts';

/*
 * 会话之间互相调用（kirolex-local 的 sessions_list / session_read / session_send）。
 * 守的是：参数校验、设置关掉时的错误、不许给自己 / 已删除 / 已归档的发、防循环（链深度 ≤ 3）、
 * 同一对会话 1 分钟 ≤ 10 次、waitReply 回复唤醒发起方和超时唤醒、路由交给和 Enter 同一套、标记跟着消息走。
 */

const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const SECRET = 'TOOL-OUTPUT-SECRET-123';

type Tx = Array<{ id: string; role: string; content: string; ts: number; kirolex?: boolean; steerParts?: Array<{ id: string; content: string; ts: number }>; toolCalls?: any[] }>;

function fakeHost(over: Partial<SessionCallsHost> = {}) {
  let now = 1_000_000;
  let enabled = true;
  const sessions: SessionInfo[] = [
    { id: 's_a', title: '发起方 A', projectId: 'proj', engine: 'kiro', location: null, busy: false, archived: false },
    { id: 's_board', title: 'agent board', projectId: 'agent-board', engine: 'kiro', location: 'cde-box', busy: true, archived: false },
    { id: 's_claude', title: 'Claude 会话', engine: 'claude', location: null, busy: false, archived: false },
    { id: 's_old', title: '归档了的', engine: 'kiro', location: null, busy: false, archived: true },
  ];
  const transcripts: Record<string, Tx> = { s_a: [], s_board: [], s_claude: [], s_old: [] };
  const sends: Array<{ from: string; to: string; text: string; mode: string }> = [];
  const notes: Array<{ sid: string; text: string }> = [];
  const watches: ReplyWatch[] = [];
  let routed: 'sent' | 'steer' | 'queued' = 'sent';
  const host: SessionCallsHost = {
    now: () => now,
    enabled: () => enabled,
    list: () => sessions,
    get: (id) => sessions.find((s) => s.id === id) || null,
    transcript: (id) => transcripts[id] || [],
    send: async (input) => { sends.push(input); return { ok: true, routed, messageId: 'user_xs_1' }; },
    note: (sid, text) => { notes.push({ sid, text }); },
    watchReply: (w) => { watches.push(w); },
    ...over,
  };
  return {
    host, sends, notes, watches, transcripts, sessions,
    limiter: new PairRateLimiter(),
    advance: (ms: number) => { now += ms; },
    setEnabled: (v: boolean) => { enabled = v; },
    setRouted: (r: typeof routed) => { routed = r; },
  };
}

const call = (f: ReturnType<typeof fakeHost>, name: string, args: any, from = 's_a') => callSessionTool(name, args, from, f.host, f.limiter);

describe('参数校验', () => {
  test('session_send：缺 id / 空文字 / 超长 / 斜杠命令 / 坏 mode / waitReply 不是布尔 → 错误，不发', async () => {
    const f = fakeHost();
    for (const [args, re] of [
      [{ text: 'hi' }, /需要 id/],
      [{ id: 's_board' }, /需要 text/],
      [{ id: 's_board', text: '   ' }, /需要 text/],
      [{ id: 's_board', text: 'x'.repeat(CONTROL_SEND_MAX + 1) }, /太长/],
      [{ id: 's_board', text: '/clear' }, /斜杠命令/],
      [{ id: 's_board', text: 'hi', mode: 'now' }, /mode 只能是/],
      [{ id: 's_board', text: 'hi', waitReply: 'yes' }, /waitReply/],
    ] as const) {
      const r = await call(f, 'session_send', args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, re);
    }
    assert.equal(f.sends.length, 0);
  });

  test('timeoutSec：默认 30 分钟、上限 2 小时、最少 60 秒；n：默认 10、上限 50', () => {
    const v = (t: unknown) => (checkSendArgs({ id: 'x', text: 'y', timeoutSec: t }) as any).value.timeoutSec;
    assert.equal(v(undefined), REPLY_DEFAULT_TIMEOUT_SEC);
    assert.equal(REPLY_DEFAULT_TIMEOUT_SEC, 1800);
    assert.equal(v(99999), REPLY_MAX_TIMEOUT_SEC);
    assert.equal(REPLY_MAX_TIMEOUT_SEC, 7200);
    assert.equal(v(5), 60);
    assert.equal(v('abc'), REPLY_DEFAULT_TIMEOUT_SEC);
    assert.equal(readCount(undefined), 10);
    assert.equal(readCount(999), 50);
    assert.equal(readCount(0), 1);
  });

  test('session_read：缺 id → 错误；不存在 → 错误', async () => {
    const f = fakeHost();
    assert.match((await call(f, 'session_read', {})).text, /需要 id/);
    const r = await call(f, 'session_read', { id: 's_nope' });
    assert.equal(r.isError, true);
    assert.match(r.text, /不存在或已删除/);
  });
});

describe('设置关掉时', () => {
  test('三个工具都回一句清楚的错误（说是用户关的、去哪开、请用户自己转），不发', async () => {
    const f = fakeHost();
    f.setEnabled(false);
    for (const name of ['sessions_list', 'session_read', 'session_send']) {
      const r = await call(f, name, { id: 's_board', text: 'hi' });
      assert.equal(r.isError, true, name);
      assert.match(r.text, /允许会话之间互相调用/);
      assert.match(r.text, /用户/);
    }
    assert.equal(f.sends.length, 0);
  });
});

describe('sessions_list', () => {
  test('按标题 / 项目 / id 找（sessionSearch），不列自己；给 id、标题、项目、引擎、运行位置、忙不忙', async () => {
    const f = fakeHost();
    const all = (await call(f, 'sessions_list', {})).text;
    assert.ok(!all.includes('s_a ·'), '不列自己');
    assert.match(all, /s_board · 「agent board」 · 项目 agent-board · kiro · 远程 cde-box · 正忙/);
    assert.match(all, /s_claude · 「Claude 会话」 · 项目 （未分组） · claude · 本机 · 空闲/);
    assert.match(all, /s_old .*已归档（发不了）/);
    assert.match((await call(f, 'sessions_list', { query: 'board' })).text, /^s_board/);
    assert.match((await call(f, 'sessions_list', { query: 'agent-board' })).text, /^s_board/);
    assert.match((await call(f, 'sessions_list', { query: 's_claude' })).text, /^s_claude/);
    assert.match((await call(f, 'sessions_list', { query: 'zzz' })).text, /没有/);
  });
});

describe('session_read', () => {
  test('最近 n 条；太长的截断并注明；工具调用只给标题，不给输出原文', async () => {
    const f = fakeHost();
    f.transcripts.s_board = [
      { id: 'u1', role: 'user', content: '问题', ts: 1 },
      { id: 'a1', role: 'assistant', content: 'x'.repeat(CONTROL_TEXT_MAX + 100), ts: 2, toolCalls: [{ title: '读配置', content: SECRET }] },
      { id: 'u2', role: 'user', content: '再问', ts: 3 },
    ];
    const r = await call(f, 'session_read', { id: 's_board', n: 2 });
    assert.equal(r.isError, undefined);
    assert.match(r.text, /最近 2 条/);
    assert.match(r.text, /\[已截断：这条太长，只给了前 8000 字\]/);
    assert.match(r.text, /\[tool\] 读配置/);
    assert.ok(!r.text.includes(SECRET));
    assert.ok(!r.text.includes('问题'), 'n=2 只给最后两条');
  });
});

describe('session_send：路由、记录行、不许发的情况', () => {
  test('发出去的是「第一行来源标记 + 原文」，mode 原样交给 Enter 那套路由；发起方留一行记录', async () => {
    const f = fakeHost();
    const r = await call(f, 'session_send', { id: 's_claude', text: '帮我查一下 X', mode: 'next' });
    assert.equal(r.isError, undefined);
    assert.equal(f.sends.length, 1);
    const sent = f.sends[0];
    assert.equal(sent.from, 's_a');
    assert.equal(sent.to, 's_claude');
    assert.equal(sent.mode, 'next');
    const head = parseHeader(sent.text);
    const { callId, ...rest } = head!;
    assert.deepEqual(rest, { sessionId: 's_a', depth: 1, reply: false });
    assert.match(String(callId), /^[A-Za-z0-9]{6,}$/, '每次调用带一个编号');
    assert.ok(sent.text.endsWith('\n帮我查一下 X'));
    assert.equal(f.notes.length, 1);
    assert.equal(f.notes[0].sid, 's_a');
    assert.match(f.notes[0].text, /claude|Claude 会话/i);
    assert.match(f.notes[0].text, /帮我查一下 X/);
  });

  test('路由结果如实告诉模型：空闲直接发 / 追加进这一轮 / 排队', async () => {
    const f = fakeHost();
    for (const [routed, re] of [['sent', /空闲，已直接发出/], ['steer', /追加进它这一轮/], ['queued', /排进对方的队列/]] as const) {
      f.setRouted(routed);
      assert.match((await call(f, 'session_send', { id: 's_board', text: `t-${routed}` })).text, re);
    }
  });

  test('Enter 那套路由：空闲发；忙时 kiro 追加、claude / codex 排队；mode next 排队', () => {
    const r = (engine: string, busy: string | null, next = false) => enterRoute({
      streaming: false, busy, occupied: !!busy, looping: false, next, canSteer: engineCanSteer(engine),
    });
    assert.equal(r('kiro', null), 'send');
    assert.equal(r('kiro', 'turn'), 'steer');
    assert.equal(r('claude', 'turn'), 'queue');
    assert.equal(r('codex', 'turn'), 'queue');
    assert.equal(r('kiro', null, true), 'queue');
  });

  test('不许给自己发；不存在 / 已删除、已归档的不发', async () => {
    const f = fakeHost();
    assert.match((await call(f, 'session_send', { id: 's_a', text: 'hi' })).text, /不能给自己发/);
    const gone = await call(f, 'session_send', { id: 's_deleted', text: 'hi' });
    assert.equal(gone.isError, true);
    assert.match(gone.text, /不存在或已删除/);
    const arch = await call(f, 'session_send', { id: 's_old', text: 'hi' });
    assert.equal(arch.isError, true);
    assert.match(arch.text, /已归档/);
    assert.equal(f.sends.length, 0);
  });

  test('对方发不出去（例如正被循环占着）：错误原样告诉模型，不留记录行、不登记等回复', async () => {
    const f = fakeHost({ send: async () => ({ ok: false, error: '对方正被一个循环占着' }) });
    const r = await call(f, 'session_send', { id: 's_board', text: 'hi', waitReply: true });
    assert.equal(r.isError, true);
    assert.match(r.text, /循环/);
    assert.equal(f.notes.length, 0);
    assert.equal(f.watches.length, 0);
  });
});

describe('防循环：链深度上限 3', () => {
  test('这一轮是别的会话转来的第 n 层 → 再发出去是 n+1；超过 3 层拒绝', async () => {
    for (const d of [0, 1, 2]) {
      const f = fakeHost();
      if (d) f.transcripts.s_a = [{ id: 'u', role: 'user', content: `${fromHeader('B', 's_board', d, true)}\n问你个事`, ts: 1 }];
      const r = await call(f, 'session_send', { id: 's_claude', text: 'hi' });
      assert.equal(r.isError, undefined, `depth ${d}`);
      assert.equal(parseHeader(f.sends[0].text)?.depth, d + 1);
    }
    const f = fakeHost();
    f.transcripts.s_a = [{ id: 'u', role: 'user', content: `${replyHeader('B', 's_board', CHAIN_MAX_DEPTH)}\n回复`, ts: 1 }];
    const r = await call(f, 'session_send', { id: 's_board', text: 'hi' });
    assert.equal(r.isError, true);
    assert.match(r.text, /第 4 层/);
    assert.match(r.text, /最多 3 层/);
    assert.equal(f.sends.length, 0);
  });

  test('chainDepth：看最近那条非 KiroLex 提示的用户消息，连同折叠进去的追加指令；普通消息是 0', () => {
    assert.equal(chainDepth([]), 0);
    assert.equal(chainDepth([{ id: 'u', role: 'user', content: '普通的话', ts: 1 }]), 0);
    assert.equal(chainDepth([
      { id: 'u1', role: 'user', content: `${fromHeader('B', 's_b', 2, false)}\nx`, ts: 1 },
      { id: 'a1', role: 'assistant', content: '好', ts: 2 },
      { id: 'n', role: 'user', content: '📤 已发给…', ts: 3, kirolex: true },
    ] as Tx), 2);
    assert.equal(chainDepth([
      { id: 'u1', role: 'user', content: '你自己的话\n追加', ts: 1, steerParts: [{ id: 'steer_xs_1', content: `${fromHeader('C', 's_c', 3, false)}\n追加`, ts: 2 }] },
    ] as Tx), 3);
    // 用户之后自己发了一条：链断了，从 0 开始
    assert.equal(chainDepth([
      { id: 'u1', role: 'user', content: `${fromHeader('B', 's_b', 3, false)}\nx`, ts: 1 },
      { id: 'u2', role: 'user', content: '用户自己的', ts: 2 },
    ]), 0);
  });

  test('「合并排队消息」把第 3 层的那条合进一条（第一行变成合并说明）：层数照样是 3，再转出去（第 4 层）被拒绝', async () => {
    const merged = joinQueuedBatch(
      [{ content: '用户自己排的一条' }, { content: `${fromHeader('B', 's_board', CHAIN_MAX_DEPTH, false)}\n转过来的事` }, { content: '又一条' }],
      (n) => `[已合并 ${n} 条排队消息]`,
    );
    assert.equal(parseHeader(merged), null, '第一行是合并说明（parseHeader 只认第一行）');
    // 界面照样给合并进来的那张显示来源标签和跳转（sessionSegments 每一行都认）
    const segs = sessionSegments(merged);
    assert.ok(segs);
    assert.deepEqual(segs!.filter((s) => s.kind === 'from').map((s) => (s as any).sessionId), ['s_board']);
    const tx: Tx = [{ id: 'queue_xs_batch_3_x', role: 'user', content: merged, ts: 1 }];
    assert.equal(chainDepth(tx), CHAIN_MAX_DEPTH, '合并后层数不能掉回 0');
    const f = fakeHost();
    f.transcripts.s_a = tx;
    const r = await call(f, 'session_send', { id: 's_claude', text: '再转一次' });
    assert.equal(r.isError, true);
    assert.match(r.text, /第 4 层/);
    assert.equal(f.sends.length, 0);
    // 合并进来的有好几层：按最高的算
    assert.equal(maxHeaderDepth(`${fromHeader('B', 's_b', 1, false)}\nx\n\n${fromHeader('C', 's_c', 2, false)}\ny`), 2);
    assert.equal(maxHeaderDepth('普通的话'), 0);
  });

  test('第一行之外出现的来源标记不算（不让正文里的一段字冒充）', () => {
    assert.equal(parseHeader(`前言\n${fromHeader('B', 's_b', 3, false)}`), null);
    assert.equal(parseHeader('📨 随便一句话'), null);
  });
});

describe('频率限制：同一对会话 1 分钟内最多 10 次', () => {
  test('第 11 次拒绝并说明；别的一对不受影响；过了窗口又可以', async () => {
    const f = fakeHost();
    for (let i = 0; i < PAIR_RATE.max; i++) {
      assert.equal((await call(f, 'session_send', { id: 's_board', text: `m${i}` })).isError, undefined);
      f.advance(1000);
    }
    const over = await call(f, 'session_send', { id: 's_board', text: 'again' });
    assert.equal(over.isError, true);
    assert.match(over.text, /60 秒内已经给会话「agent board」发了 10 次/);
    assert.match(over.text, /\d+ 秒后再试/);
    assert.equal((await call(f, 'session_send', { id: 's_claude', text: 'other pair' })).isError, undefined);
    f.advance(PAIR_RATE.windowMs);
    assert.equal((await call(f, 'session_send', { id: 's_board', text: 'later' })).isError, undefined);
  });
});

describe('waitReply：对方这一轮结束后把回复唤醒发起方；超时也唤醒', () => {
  function watcherFixture() {
    let now = 5_000_000;
    const tx: Record<string, Tx> = { s_a: [], s_b: [] };
    const busy = new Set<string>();
    const alive = new Set(['s_a', 's_b']);
    const delivered: Array<{ sid: string; text: string }> = [];
    let saved: ReplyWatch[] = [];
    const watcher = new ReplyWatcher({
      now: () => now,
      transcript: (id) => tx[id] || [],
      isBusy: (id) => busy.has(id),
      exists: (id) => alive.has(id),
      title: (id) => (id === 's_b' ? 'B 会话' : 'A 会话'),
      deliver: (sid, text) => { delivered.push({ sid, text }); },
      changed: (list) => { saved = list; },
    });
    const payload = `${fromHeader('A 会话', 's_a', 1, true)}\n问：版本号是多少？`;
    const w: ReplyWatch = { id: 'w1', from: 's_a', to: 's_b', toTitle: 'B 会话', payload, since: now, deadline: now + 1800_000, timeoutSec: 1800, depth: 1 };
    return { watcher, tx, busy, alive, delivered, saved: () => saved, payload, w, advance: (ms: number) => { now += ms; } };
  }

  test('session_send(waitReply) 不阻塞：立即返回、登记等待（期限 = 现在 + timeoutSec）、告诉模型结束这一轮', async () => {
    const f = fakeHost();
    const r = await call(f, 'session_send', { id: 's_board', text: '版本号？', waitReply: true, timeoutSec: 600 });
    assert.match(r.text, /回复会作为一条新消息发回这条会话/);
    assert.match(r.text, /不要等/);
    assert.equal(f.watches.length, 1);
    const w = f.watches[0];
    assert.equal(w.from, 's_a');
    assert.equal(w.to, 's_board');
    assert.equal(w.deadline - w.since, 600_000);
    assert.equal(w.payload, f.sends[0].text);
    assert.equal(parseHeader(w.payload)?.depth, 1);
  });

  test('对方还没处理 / 还在忙：不唤醒；这一轮结束（连续空着几拍）→ 把回复作为新消息唤醒发起方，带「📨 会话「B」的回复」', () => {
    const x = watcherFixture();
    x.watcher.add(x.w);
    assert.equal(x.saved().length, 1, '登记落盘');
    x.watcher.tick();
    assert.equal(x.delivered.length, 0, '对方记录里还没有那条');
    x.tx.s_b.push({ id: 'user_xs_1', role: 'user', content: x.payload, ts: x.w.since + 10 });
    x.tx.s_b.push({ id: 'a_1', role: 'assistant', content: '半截', ts: x.w.since + 20 });
    x.busy.add('s_b');
    x.watcher.tick();
    assert.equal(x.delivered.length, 0, '对方还在跑这一轮');
    x.busy.delete('s_b');
    x.tx.s_b[1].content = '版本号是 1.2.3';
    for (let i = 0; i < IDLE_CONFIRM_TICKS - 1; i++) { x.watcher.tick(); assert.equal(x.delivered.length, 0, '刚空下来还要再确认'); }
    x.watcher.tick();
    assert.equal(x.delivered.length, 1);
    assert.equal(x.delivered[0].sid, 's_a');
    const head = parseHeader(x.delivered[0].text);
    assert.deepEqual(head, { sessionId: 's_b', depth: 2, reply: true });
    assert.match(x.delivered[0].text, /版本号是 1\.2\.3/);
    assert.equal(x.saved().length, 0, '交出去就不再等');
    x.watcher.tick();
    assert.equal(x.delivered.length, 1, '只唤醒一次');
  });

  test('追加进对方那一轮的（折叠在 steerParts 里）也认得', () => {
    const x = watcherFixture();
    x.watcher.add(x.w);
    x.tx.s_b.push({ id: 'u0', role: 'user', content: `原来的问题\n${x.payload}`, ts: x.w.since - 60_000, steerParts: [{ id: 'steer_xs_1', content: x.payload, ts: x.w.since + 5 }] });
    x.tx.s_b.push({ id: 'a0', role: 'assistant', content: '两件事都答了', ts: x.w.since + 30 });
    for (let i = 0; i < IDLE_CONFIRM_TICKS; i++) x.watcher.tick();
    assert.equal(x.delivered.length, 1);
    assert.match(x.delivered[0].text, /两件事都答了/);
  });

  test('对方后面又来了一条用户消息：那一轮肯定结束了，不用等空', () => {
    const x = watcherFixture();
    x.watcher.add(x.w);
    x.busy.add('s_b');
    x.tx.s_b.push({ id: 'u', role: 'user', content: x.payload, ts: x.w.since + 1 });
    x.tx.s_b.push({ id: 'a', role: 'assistant', content: '答', ts: x.w.since + 2 });
    x.tx.s_b.push({ id: 'u2', role: 'user', content: '下一条', ts: x.w.since + 3 });
    x.watcher.tick();
    assert.equal(x.delivered.length, 1);
    assert.match(x.delivered[0].text, /\n答$/);
  });

  test('超时：唤醒发起方说明没等到（多久、可以 session_read）', () => {
    const x = watcherFixture();
    x.watcher.add(x.w);
    x.advance(1800_000 - 1);
    x.watcher.tick();
    assert.equal(x.delivered.length, 0);
    x.advance(1);
    x.watcher.tick();
    assert.equal(x.delivered.length, 1);
    assert.equal(parseHeader(x.delivered[0].text)?.reply, true);
    assert.match(x.delivered[0].text, /No reply|没有回复/);
    assert.match(x.delivered[0].text, /session_read/);
  });

  test('对方被删了 → 唤醒发起方说一声；发起方被删了 → 不再等、不唤醒', () => {
    const x = watcherFixture();
    x.watcher.add(x.w);
    x.alive.delete('s_b');
    x.watcher.tick();
    assert.equal(x.delivered.length, 1);
    assert.match(x.delivered[0].text, /deleted|删除/);
    const y = watcherFixture();
    y.watcher.add(y.w);
    y.alive.delete('s_a');
    y.watcher.tick();
    assert.equal(y.delivered.length, 0);
    assert.equal(y.watcher.list().length, 0);
  });

  test('重启后接着等（restore 盘上的）；回复太长截断并注明', () => {
    const x = watcherFixture();
    x.watcher.restore([x.w]);
    x.tx.s_b.push({ id: 'u', role: 'user', content: x.payload, ts: x.w.since + 1 });
    x.tx.s_b.push({ id: 'a', role: 'assistant', content: 'y'.repeat(CONTROL_TEXT_MAX + 50), ts: x.w.since + 2 });
    for (let i = 0; i < IDLE_CONFIRM_TICKS; i++) x.watcher.tick();
    assert.equal(x.delivered.length, 1);
    assert.match(x.delivered[0].text, /cut|已截断/);
  });

  test('findReply：KiroLex 提示不算回复，也不算「下一条用户消息」', () => {
    const p = 'PAYLOAD';
    const r = findReply([
      { id: 'u', role: 'user', content: p, ts: 10 },
      { id: 'n', role: 'user', content: '⚠️ 换了模型', ts: 11, kirolex: true } as any,
      { id: 'a', role: 'assistant', content: '真回复', ts: 12 },
    ], p, 10);
    assert.deepEqual(r, { found: true, reply: '真回复', followedByUser: false });
    assert.equal(findReply([{ id: 'u', role: 'user', content: p, ts: 1 }], p, 1_000_000).found, false, '发出去之前的同样文字不算');
  });
});

describe('界面上的来源', () => {
  test('第一行拆成「📨 来自会话「A」」+ 正文；给对方模型看的那半句不显示', () => {
    const s = splitSessionHeader(`${fromHeader('A 会话', 's_a', 1, true)}\n正文第一行\n第二行`);
    assert.ok(s);
    assert.equal(s!.sessionId, 's_a');
    assert.equal(s!.reply, false);
    assert.match(s!.label, /^📨 .*A 会话/);
    assert.ok(!s!.label.includes('⟨'));
    assert.equal(s!.rest, '正文第一行\n第二行');
    assert.equal(splitSessionHeader('普通消息'), null);
  });

  test('id 标记：xs = 来自别的会话，ctl = 经控制入口；换 id 也带着；落盘 via 分别是 session / control', () => {
    const xs = controlMessageId('user', 1, 'xs');
    assert.ok(isSessionMessageId(xs));
    assert.ok(!isControlMessageId(xs));
    assert.equal(markOrigin(xs), 'xs');
    assert.ok(isSessionMessageId(carryControlMark(xs, 'queue')));
    assert.deepEqual(viaFor(xs), { via: 'session' });
    assert.deepEqual(viaFor(controlMessageId('user')), { via: 'control' });
    assert.equal(queuedBatchMessageId([{ id: controlMessageId('queue', 1, 'xs') }, { id: 'queue_2_x' }]).startsWith('queue_xs_batch_'), true);
    assert.equal(queuedBatchMessageId([{ id: controlMessageId('queue') }, { id: controlMessageId('queue', 1, 'xs') }]).startsWith('queue_ctl_batch_'), true);
  });
});

describe('kirolex-local：本地、远程会话都挂这三个工具', () => {
  const names = (defs: Array<{ name: string }>) => defs.map((d) => d.name);
  test('工具清单：远程（全套）和本地（browserOnly）都有；说明里写清用途和限制', () => {
    assert.ok(names(toolDefs({ sessions: true })).includes('session_send'));
    assert.ok(names(toolDefs({ browserOnly: true, sessions: true })).includes('sessions_list'));
    assert.ok(!names(toolDefs({})).includes('session_send'));
    const send = sessionToolDefs().find((d) => d.name === 'session_send')!;
    assert.match(send.description, /转交给专管它的会话/);
    assert.match(send.description, /问另一个会话要它掌握的事实/);
    assert.match(send.description, /最多 3 层/);
    assert.match(send.description, /不能发给自己/);
    assert.match(send.description, /不会在这一轮里等/);
  });

  test('callTool 把这三个交给 deps.sessions（本地会话的 browserOnly 也是）', async () => {
    const calls: string[] = [];
    const deps: LocalMcpDeps = {
      log: () => {}, notice: () => {},
      sessions: { call: async (name, _args, sid) => { calls.push(`${name}@${sid}`); return { text: 'ok' }; } },
    };
    const r = await callTool('session_read', { id: 'x' }, { sessionId: 's_a', workdir: '.', browserOnly: true } as any, deps);
    assert.equal(r.content[0].text, 'ok');
    assert.deepEqual(calls, ['session_read@s_a']);
    const none = await callTool('session_read', { id: 'x' }, { sessionId: 's_a', workdir: '.' } as any, { log: () => {}, notice: () => {} });
    assert.equal(none.isError, true);
  });
});

describe('接线（主进程 / 界面）', () => {
  const main = read('main', 'index.ts');
  test('走主进程、不经控制入口的 HTTP：交给界面同一套 Enter 路由（forwardToUi，xs 标记），界面没就绪进唤醒队列', () => {
    const at = main.indexOf('const sessionCallsHost: SessionCallsHost = {');
    assert.ok(at > 0);
    const body = main.slice(at, at + 3000);
    assert.match(body, /enabled: \(\) => isFeatureEnabled\('sessionCalls'\)/);
    assert.match(body, /await forwardToUi\(to, text, mode, 'xs'\)/);
    assert.match(body, /r\.error === 'ui-not-ready'/);
    assert.match(body, /wakeDispatcher\.enqueue\(\{ sessionId: to, text, at: Date\.now\(\), source: 'session', ref \}\)/);
    assert.match(body, /note: \(sid, text\) => \{ noteInSession\(sid, text\); \}/);
    // 不碰控制入口的开关
    assert.ok(!body.includes("isFeatureEnabled('controlSessionAccess')"));
    // 设置默认开
    assert.match(main, /sessionCalls: true,/);
    // 控制入口的开关仍然默认关
    assert.match(main, /controlSessionAccess: false,/);
  });

  test('回复经 wakeDispatcher 唤醒发起方；登记落盘、启动时读回、每 2 秒看一遍；删会话时不再等', () => {
    assert.match(main, /deliver: \(sid, text, w\) => \{\s*void wakeDispatcher\.enqueue\(\{ sessionId: sid, text, at: Date\.now\(\), source: 'session', ref: w\.id \}\)/);
    assert.match(main, /replyWatcher\.restore\(saved\.watches as ReplyWatch\[\]\)/);
    assert.match(main, /setInterval\(\(\) => \{\s*try \{ replyWatcher\.tick\(\); \}/);
    assert.match(main, /replyWatcher\.dropFrom\(sessionId\);/);
    // 唤醒的那条带 xs 标记（落盘 via:'session'）
    assert.match(main, /messageId: item\.source === 'session' \? controlMessageId\('user', Date\.now\(\), 'xs'\)/);
  });

  test('界面：control:send 带 origin；xs 的消息显示「📨 来自会话」+ 跳回去的按钮', () => {
    const app = read('renderer', 'App.tsx');
    assert.match(app, /const ctl: ControlSendCtx = \{ origin: req\.origin === 'xs' \? 'xs' : 'ctl'/);
    assert.match(app, /window\.addEventListener\('kirolex:open-session'/);
    const chat = read('renderer', 'components', 'ChatArea.tsx');
    // 每一行 📨 来源都拆成一段（合并排队消息时一条气泡里可能有好几个），每段一个标签 + 跳转
    assert.match(chat, /const segs = sessionFromSegments\(bubble\.text\);/);
    assert.match(chat, /seg\.kind === 'from'\s*\n\s*\? <SessionFromChip key=\{`\$\{bubble\.id\}:from\$\{i\}`\} label=\{seg\.label\} sessionId=\{seg\.sessionId\} \/>/);
    assert.match(chat, /new CustomEvent\('kirolex:open-session', \{ detail: \{ sessionId \} \}\)/);
    const settings = read('renderer', 'components', 'SettingsDialog.tsx');
    assert.match(settings, /\{ key: 'sessionCalls', store: 'feature'/);
  });
});

describe('同样的话发两次、都要回复：两次等待各认各的回复', () => {
  test('每次 session_send 的原文都带一个新的调用编号，所以两次的原文不一样', async () => {
    const f = fakeHost();
    await call(f, 'session_send', { id: 's_board', text: '同一句话', waitReply: true });
    await call(f, 'session_send', { id: 's_board', text: '同一句话', waitReply: true });
    assert.equal(f.watches.length, 2);
    assert.notEqual(f.watches[0].payload, f.watches[1].payload);
    const h1 = parseHeader(f.watches[0].payload)!;
    const h2 = parseHeader(f.watches[1].payload)!;
    assert.ok(h1.callId && h2.callId && h1.callId !== h2.callId);
    assert.equal(h1.depth, h2.depth);
  });

  test('对方先后答了两条：第一次等待拿到 first answer，第二次拿到 second answer（不会都拿到最后那条）', async () => {
    const f = fakeHost();
    await call(f, 'session_send', { id: 's_board', text: '同一句话', waitReply: true });
    await call(f, 'session_send', { id: 's_board', text: '同一句话', waitReply: true });
    const [w1, w2] = f.watches;
    const tx: Tx = [
      { id: 'u1', role: 'user', content: w1.payload, ts: w1.since + 1 },
      { id: 'a1', role: 'assistant', content: 'first answer', ts: w1.since + 2 },
      { id: 'u2', role: 'user', content: w2.payload, ts: w2.since + 3 },
      { id: 'a2', role: 'assistant', content: 'second answer', ts: w2.since + 4 },
    ];
    const delivered: Record<string, string> = {};
    const watcher = new ReplyWatcher({
      now: () => w2.since + 10, transcript: () => tx, isBusy: () => false, exists: () => true,
      title: () => 'agent board', deliver: (_sid, text, w) => { delivered[w.id] = text; },
    });
    watcher.add(w1);
    watcher.add(w2);
    for (let i = 0; i < IDLE_CONFIRM_TICKS; i++) watcher.tick();
    assert.match(delivered[w1.id], /first answer/);
    assert.ok(!delivered[w1.id].includes('second answer'));
    assert.match(delivered[w2.id], /second answer/);
    assert.ok(!delivered[w2.id].includes('first answer'));
    // 编号原样留在正文里：两条排队后合并成一条也各自认得出来
    const merged = joinQueuedBatch([{ content: w1.payload }, { content: w2.payload }], (n) => `[已合并 ${n} 条]`);
    assert.equal(findReply([{ id: 'm', role: 'user', content: merged, ts: w2.since + 5 }], w1.payload, w1.since).found, true);
    assert.equal(findReply([{ id: 'm', role: 'user', content: merged, ts: w2.since + 5 }], w2.payload, w2.since).found, true);
  });
});

describe('界面：合并后的一条气泡里，每条别的会话发来的消息都有自己的来源标签和跳转', () => {
  test('sessionSegments：合并说明、两张来自不同会话的卡片、一张普通卡片 → 正文 / 来源 / 正文 / 来源 / 正文 …', () => {
    const merged = joinQueuedBatch([
      { content: `${fromHeader('A 会话', 's_a', 1, true, 'c1')}\n问题一` },
      { content: '你自己排的一句' },
      { content: `${fromHeader('C 会话', 's_c', 2, false, 'c2')}\n问题二` },
    ], (n) => `[已合并 ${n} 条排队消息]`);
    const segs = sessionSegments(merged)!;
    const froms = segs.filter((s) => s.kind === 'from') as Array<{ sessionId: string; label: string }>;
    assert.deepEqual(froms.map((s) => s.sessionId), ['s_a', 's_c']);
    for (const s of froms) assert.ok(s.label.startsWith('📨') && !s.label.includes('⟨'), s.label);
    const texts = segs.filter((s) => s.kind === 'text').map((s) => (s as any).text);
    assert.deepEqual(texts, ['[已合并 3 条排队消息]', '问题一\n\n你自己排的一句', '问题二']);
    // 普通消息不拆；只在行首以 📨 开头的才算（正文中间提到的不算）
    assert.equal(sessionSegments('普通的话'), null);
    assert.equal(sessionSegments(`前言 ${fromHeader('A', 's_a', 1, false)}`), null);
  });
});

describe('等回复的起点、追加失败', () => {
  test('发送确认比消息落盘晚了 6 秒：起点取在发送之前，照样认出那条、拿到回复', async () => {
    let now = 100_000;
    let savedPayload = '';
    const f = fakeHost({
      now: () => now,
      send: async (input) => {
        savedPayload = input.text;   // 对方会话里这一刻已经落盘（ts = 100000）
        now += 6000;                 // 界面的确认 6 秒后才回来
        return { ok: true, routed: 'sent', messageId: 'user_xs_1' };
      },
    });
    await call(f, 'session_send', { id: 's_board', text: '版本号？', waitReply: true });
    const w = f.watches[0];
    assert.equal(w.since, 100_000, '起点是发出去之前');
    const tx: Tx = [
      { id: 'u', role: 'user', content: savedPayload, ts: 100_000 },
      { id: 'a', role: 'assistant', content: '1.2.3', ts: 101_000 },
    ];
    assert.equal(findReply(tx, w.payload, w.since).found, true);
    const delivered: string[] = [];
    const watcher = new ReplyWatcher({
      now: () => now, transcript: () => tx, isBusy: () => false, exists: () => true, title: () => 'agent board',
      deliver: (_sid, text) => { delivered.push(text); },
    });
    watcher.add(w);
    for (let i = 0; i < IDLE_CONFIRM_TICKS; i++) watcher.tick();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0], /1\.2\.3/);
  });

  test('要追加进对方那一轮但没追加进去：告诉发起方没送到（对方模型没收到、在那边标红等用户），记录行如实写，不登记等回复', async () => {
    const f = fakeHost({ send: async () => ({ ok: true, routed: 'steer', messageId: 'steer_xs_1', steerFailed: 'unsupported' }) });
    const r = await call(f, 'session_send', { id: 's_board', text: '加一句', waitReply: true });
    assert.equal(r.isError, true);
    assert.match(r.text, /没送到/);
    assert.match(r.text, /unsupported/);
    assert.match(r.text, /标红/);
    assert.ok(!/已追加进它这一轮/.test(r.text));
    assert.equal(f.watches.length, 0, '对方没收到，不等回复');
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0].text, /Could not add|没能把消息追加进/);
    assert.ok(!/Sent to session|已发给会话/.test(f.notes[0].text), '记录行不写成发成功');
  });

  test('接线：主进程把界面回报的 steerFailed 交给 session_send（控制入口的 HTTP 那条照旧，见 controlServer）', () => {
    const main = read('main', 'index.ts');
    const at = main.indexOf('const sessionCallsHost: SessionCallsHost = {');
    const body = main.slice(at, at + 3000);
    assert.match(body, /if \(r\.ok\) return \{ ok: true, routed: r\.routed, messageId: r\.messageId, \.\.\.\(r\.steerFailed \? \{ steerFailed: r\.steerFailed \} : \{\}\) \};/);
  });
});
