/**
 * 每轮回复后面的「这一轮真实消耗」：主进程的按轮累加（`main/turnUsage.ts`）+ 界面的显示格式化（`renderer/turnUsageView.ts`），
 * 以及接线（记账在一轮结束落盘那一处、主进程自己起的轮也走它、message-actions 渲染它）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { foldTurnFrame, finishTurnUsage, type TurnUsageAcc } from '../src/main/turnUsage.ts';
import { foldSessionCost } from '../src/main/sessionCost.ts';
import {
  asTurnUsage, combineTurnUsage, formatCredits, formatMoney, formatTokensShort, signedTokens,
  turnUsageLabel, sessionTurnTotals, sessionTurnStats, attachTurnUsage,
} from '../src/renderer/turnUsageView.ts';

/* 测试用的 t：按英文 key 原样填占位符 */
const t = (key: string, vars?: Record<string, string | number>) =>
  key.replace(/\{(\w+)\}/g, (_, k) => (vars && k in vars ? String(vars[k]) : `{${k}}`));

const kiroMeta = (value: number, pct = 10) => ({
  sessionUpdate: '_kiro_internal', method: '_kiro.dev/metadata',
  meteringUsage: [{ value, unit: 'credit' }], contextUsagePercentage: pct, turnDurationMs: 1000,
});

describe('按轮累加（main/turnUsage.ts）', () => {
  test('kiro：一轮里多帧 meteringUsage 求和，不是只取最后一帧', () => {
    let acc: TurnUsageAcc | undefined;
    acc = foldTurnFrame(acc, kiroMeta(0.12, 5));
    acc = foldTurnFrame(acc, kiroMeta(0.30, 8));
    const u = finishTurnUsage(acc, { engine: 'kiro', model: 'claude-sonnet-4.5' });
    assert.ok(u);
    assert.equal(Math.round(u!.credits! * 1000) / 1000, 0.42);
    assert.equal(u!.contextPercent, 8);
    assert.equal(u!.model, 'claude-sonnet-4.5');
    assert.equal(u!.engine, 'kiro');
  });

  test('和本轮无关的帧不改累加器；什么真实值都没有 → null（界面回退到估算）', () => {
    const acc = foldTurnFrame(undefined, { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } });
    assert.equal(acc, undefined);
    assert.equal(finishTurnUsage(acc, { engine: 'kiro' }), null);
    /* meteringUsage 不是数字：不当 0 记 */
    const bad = foldTurnFrame(undefined, { sessionUpdate: '_kiro_internal', method: '_kiro.dev/metadata', meteringUsage: [{ value: 'x' }] });
    assert.equal(finishTurnUsage(bad, { engine: 'kiro' }), null);
  });

  test('Claude：同一个进程里本轮 = sessionCost 算出的 turn；跨进程第一帧整笔算这一轮', () => {
    /* 旧进程累计到 0.0309，这一轮读数 0.0521 → 本轮 0.0212 */
    const prev = { total: 0.0309, turn: 0.0309, reading: 0.0309, currency: 'USD', at: 1 };
    const same = foldSessionCost(prev, { amount: 0.0521, currency: 'USD' }, 2, false);
    let acc = foldTurnFrame(undefined, { sessionUpdate: 'usage_update', used: 20000, size: 200000, cost: { amount: 0.0521, currency: 'USD' } }, same);
    let u = finishTurnUsage(acc, { engine: 'claude', model: 'opus' })!;
    assert.equal(Math.round(u.cost! * 1e4) / 1e4, 0.0212);
    assert.equal(Math.round(u.sessionCost! * 1e4) / 1e4, 0.0521);
    assert.equal(u.contextUsed, 20000);
    assert.equal(u.contextSize, 200000);

    /* 新进程第一帧 0.0214（比上次读数小也好、大也好）：整笔算这一轮 */
    const fresh = foldSessionCost(same, { amount: 0.0614, currency: 'USD' }, 3, true);
    acc = foldTurnFrame(undefined, { sessionUpdate: 'usage_update', cost: { amount: 0.0614, currency: 'USD' } }, fresh);
    u = finishTurnUsage(acc, { engine: 'claude' })!;
    assert.equal(u.cost, 0.0614);
    assert.equal(Math.round(u.sessionCost! * 1e4) / 1e4, 0.1135);
  });

  test('Claude：一轮里有两帧 cost（各自的 turn）→ 相加', () => {
    let acc = foldTurnFrame(undefined, { sessionUpdate: 'usage_update', cost: { amount: 0.01 } }, { turn: 0.01, total: 0.5, currency: 'USD' });
    acc = foldTurnFrame(acc, { sessionUpdate: 'usage_update', cost: { amount: 0.03 } }, { turn: 0.02, total: 0.52, currency: 'USD' });
    const u = finishTurnUsage(acc, { engine: 'claude' })!;
    assert.equal(Math.round(u.cost! * 1000) / 1000, 0.03);
    assert.equal(u.sessionCost, 0.52);
  });

  test('Codex：没有 cost，记这一轮结束时的上下文 used，以及相对上一轮的增量', () => {
    let acc = foldTurnFrame(undefined, { sessionUpdate: 'usage_update', used: 30000, size: 258000 });
    acc = foldTurnFrame(acc, { sessionUpdate: 'usage_update', used: 42300, size: 258000 });
    const u = finishTurnUsage(acc, { engine: 'codex', prevContextUsed: 30000 })!;
    assert.equal(u.contextUsed, 42300);
    assert.equal(u.contextDelta, 12300);
    assert.equal(u.cost, undefined);
    /* 上一轮不知道 → 没有增量（不把整段当成这一轮的） */
    const first = finishTurnUsage(acc, { engine: 'codex' })!;
    assert.equal(first.contextDelta, undefined);
    /* 压缩之后上下文变小：增量是负的，照实记 */
    const shrunk = finishTurnUsage(acc, { engine: 'codex', prevContextUsed: 50000 })!;
    assert.equal(shrunk.contextDelta, -7700);
  });
});

describe('显示格式化（renderer/turnUsageView.ts）', () => {
  test('credits 两位小数、美元小额、k / M', () => {
    assert.equal(formatCredits(0.4199), '0.42');
    assert.equal(formatCredits(3), '3.00');
    assert.equal(formatMoney(0.031), '$0.031');
    assert.equal(formatMoney(0.0004), '<$0.001');
    assert.equal(formatMoney(0), '$0.000');
    assert.equal(formatMoney(1.23456, 'USD', 4), '$1.2346');
    assert.equal(formatMoney(0.5, 'EUR'), '0.500 EUR');
    assert.equal(formatMoney(0.0004, 'EUR'), '<0.001 EUR');
    assert.equal(formatTokensShort(950), '950');
    assert.equal(formatTokensShort(12300), '12.3k');
    assert.equal(formatTokensShort(1_250_000), '1.3M');
    assert.equal(signedTokens(12300), '+12.3k');
    assert.equal(signedTokens(-7700), '−7.7k');
    assert.equal(signedTokens(0), '+0');
  });

  test('kiro 的本轮：「0.42 credits」，悬停给本轮、本会话累计、模型、上下文', () => {
    const l = turnUsageLabel({ engine: 'kiro', credits: 0.42, contextPercent: 8.25, model: 'claude-sonnet-4.5' }, 120, t, { credits: 1.5 })!;
    assert.equal(l.estimated, false);
    assert.equal(l.text, '0.42 credits');
    assert.match(l.title, /This turn: 0\.42 credits/);
    assert.match(l.title, /This session so far: 1\.50 credits/);
    assert.match(l.title, /Model: claude-sonnet-4\.5/);
    assert.match(l.title, /Context 8\.3% used/);
    assert.doesNotMatch(l.text, /≈/);
  });

  test('Claude 的本轮：「$0.031」/「<$0.001」，悬停里有本会话累计', () => {
    const l = turnUsageLabel({ engine: 'claude', cost: 0.031, currency: 'USD', sessionCost: 0.42, contextUsed: 20000, contextSize: 200000 }, 50, t)!;
    assert.equal(l.text, '$0.031');
    assert.match(l.title, /This session so far: \$0\.4200/);
    assert.match(l.title, /Context 20,000 \/ 200,000 tokens/);
    assert.equal(turnUsageLabel({ engine: 'claude', cost: 0.0002 }, null, t)!.text, '<$0.001');
  });

  test('Codex 的本轮：「上下文 +12.3k tokens」；不知道上一轮时给绝对值', () => {
    const l = turnUsageLabel({ engine: 'codex', contextUsed: 42300, contextSize: 258000, contextDelta: 12300 }, 80, t)!;
    assert.equal(l.text, 'Context +12.3k tokens');
    assert.match(l.title, /Context 42,300 \/ 258,000 tokens/);
    const abs = turnUsageLabel({ engine: 'codex', contextUsed: 42300 }, 80, t)!;
    assert.equal(abs.text, 'Context 42.3k tokens');
  });

  test('没有真实值（老消息 / 引擎没报）才回退到估算，并标明是估算', () => {
    const l = turnUsageLabel(undefined, 1234, t)!;
    assert.equal(l.estimated, true);
    assert.match(l.text, /≈ 1,234 tokens \(estimated\)/);
    assert.match(l.title, /Estimated/);
    assert.equal(turnUsageLabel(undefined, null, t), null);
    /* 有记录但没有可显示的值 → 也回退 */
    assert.equal(turnUsageLabel({ engine: 'kiro', contextPercent: 5 }, 10, t)!.estimated, true);
  });

  test('asTurnUsage：从 transcript 读回来的形状校验；乱的丢掉', () => {
    assert.deepEqual(asTurnUsage({ engine: 'kiro', credits: 0.4, junk: 1 }), { engine: 'kiro', credits: 0.4 });
    assert.equal(asTurnUsage(null), undefined);
    assert.equal(asTurnUsage({ engine: 'kiro', credits: 'x' }), undefined);
    assert.equal(asTurnUsage({ credits: 1 }), undefined);
  });

  test('一个气泡里有几条带记账的消息：本轮值相加，累计 / 上下文取最后一条', () => {
    const c = combineTurnUsage([
      { engine: 'kiro', credits: 0.1, contextPercent: 3 },
      undefined,
      { engine: 'kiro', credits: 0.2, contextPercent: 4 },
    ])!;
    assert.equal(Math.round(c.credits! * 100) / 100, 0.3);
    assert.equal(c.contextPercent, 4);
    assert.equal(combineTurnUsage([undefined]), undefined);
  });

  test('会话级：本会话共 N 轮，平均每轮 X；累计按消息顺序', () => {
    const msgs = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant', turnUsage: { engine: 'kiro' as const, credits: 0.2 } },
      { id: 'a2', role: 'assistant' },
      { id: 'a3', role: 'assistant', turnUsage: { engine: 'kiro' as const, credits: 0.4 } },
    ];
    const totals = sessionTurnTotals(msgs);
    assert.equal(Math.round(totals.get('a1')!.credits * 100) / 100, 0.2);
    assert.equal(Math.round(totals.get('a3')!.credits * 100) / 100, 0.6);
    assert.equal(sessionTurnStats(msgs, 'kiro', t), 'Turns this session: 2, average 0.30 credits per turn');
    const claude = [{ id: 'a', role: 'assistant', turnUsage: { engine: 'claude' as const, cost: 0.02 } }, { id: 'b', role: 'assistant', turnUsage: { engine: 'claude' as const, cost: 0.04 } }];
    assert.equal(sessionTurnStats(claude, 'claude', t), 'Turns this session: 2, average $0.030 per turn');
    const codex = [{ id: 'a', role: 'assistant', turnUsage: { engine: 'codex' as const, contextUsed: 1, contextDelta: 1000 } }, { id: 'b', role: 'assistant', turnUsage: { engine: 'codex' as const, contextUsed: 1, contextDelta: 3000 } }];
    assert.equal(sessionTurnStats(codex, 'codex', t), 'Turns this session: 2, average context +2.0k tokens per turn');
    assert.equal(sessionTurnStats([{ id: 'x', role: 'assistant' }], 'kiro', t), null);
  });

  test('会话级：Codex 第一轮只有 used（没有上一轮作基准）也算一轮；平均增量说清楚按几轮算', () => {
    const codex = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant', turnUsage: { engine: 'codex' as const, contextUsed: 30000, contextSize: 258000 } },
      { id: 'u2', role: 'user' },
      { id: 'a2', role: 'assistant', turnUsage: { engine: 'codex' as const, contextUsed: 42300, contextSize: 258000, contextDelta: 12300 } },
    ];
    assert.equal(sessionTurnStats(codex, 'codex', t), 'Turns this session: 2, average context +12.3k tokens per turn (over the 1 turns that have it)');
    /* 只有第一轮：照样报轮数，没有平均 */
    assert.equal(sessionTurnStats(codex.slice(0, 2), 'codex', t), 'Turns this session: 1');
  });

  test('本轮消耗挂到哪条回复：按 id；没有这个 id（只调了工具的轮）挂到这一轮最后一条助手消息；不越过你的消息', () => {
    const usage = { engine: 'kiro' as const, credits: 0.3 };
    const list = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'u2', role: 'user' },
      { id: 'tool1', role: 'assistant' },
      { id: 'n1', role: 'user', kirolex: true as const },
    ];
    assert.equal(attachTurnUsage(list, 'a1', usage)[1].turnUsage, usage);
    /* 知道这一轮从 u2 开始：中途夹着的 KiroLex 提示（n1）跳过，挂到这一轮的 tool1 */
    const byFallback = attachTurnUsage(list, 'a_unknown', usage, undefined, 'u2');
    assert.equal(byFallback[3].turnUsage, usage);
    assert.equal(byFallback[1].turnUsage, undefined);
    /* 不知道这一轮从哪开始：任何一条 user 消息（含 KiroLex 提示）都算边界，不往回挂 */
    assert.equal(attachTurnUsage(list, 'a_unknown', usage), list);
    /* 这一轮还没有助手消息：不挂到上一轮去 */
    const none = [{ id: 'a0', role: 'assistant' }, { id: 'u9', role: 'user' }];
    assert.equal(attachTurnUsage(none, 'x', usage), none);
    assert.equal(attachTurnUsage(none, 'x', usage, undefined, 'u9'), none);
  });

  test('回归：后台纠正（KiroLex 提示开头的一轮）只跑了不记录的 search、没有正文 —— 上一轮的值保留、新一轮单独显示、算两轮，和重载一致', () => {
    const a1Usage = { engine: 'kiro' as const, credits: 0.42 };
    const a2Usage = { engine: 'kiro' as const, credits: 0.25 };
    const live = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant', turnUsage: a1Usage },
      /* 主进程发起的纠正轮：以 kirolex:true 的提示开始（turnStart 就是它） */
      { id: 'nudge1', role: 'user', kirolex: true as const },
    ];
    const make = () => ({ id: 'a2', role: 'assistant' });
    const shown = attachTurnUsage(live, 'a2', a2Usage, make, 'nudge1');
    assert.equal(shown[1].turnUsage, a1Usage, '上一轮的值不能被改掉');
    assert.equal(shown.length, 4);
    assert.equal(shown[3].id, 'a2');
    assert.equal(shown[3].turnUsage, a2Usage);
    assert.equal(sessionTurnStats(shown, 'kiro', t), 'Turns this session: 2, average 0.33 credits per turn');
    /* 界面上没有那条提示（例如没推到这个窗口）：也不往回找，补一条 */
    const noNote = attachTurnUsage(live.slice(0, 2), 'a2', a2Usage, make, 'nudge1');
    assert.equal(noNote[1].turnUsage, a1Usage);
    assert.equal(noNote[2].turnUsage, a2Usage);
    /* 重载：盘上是 u1 / a1(0.42) / nudge1 / a2(0.25,空正文) —— 和即时显示一致 */
    const disk = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant', turnUsage: asTurnUsage(a1Usage) },
      { id: 'nudge1', role: 'user', kirolex: true as const },
      { id: 'a2', role: 'assistant', turnUsage: asTurnUsage(a2Usage) },
    ];
    assert.deepEqual(disk.map((m) => m.turnUsage?.credits), shown.map((m) => m.turnUsage?.credits));
    assert.equal(sessionTurnStats(disk, 'kiro', t), sessionTurnStats(shown, 'kiro', t));
  });

  test('没有正文、没有被记录的工具、但有真实消耗的一轮：即时补一条显示、重载回看、轮数统计都对', async () => {
    const { modelFacing } = await import('../src/main/kirolexNote.ts');
    /* 主进程这一轮收尾：kiro 只跑了 search（不记录），没有正文，但报了 credits */
    const acc = foldTurnFrame(undefined, kiroMeta(0.25, 6));
    const usage = finishTurnUsage(acc, { engine: 'kiro', model: 'm' })!;
    assert.ok(usage, '有真实消耗 → flushAssistant 不提前 return');
    /* 落盘的那一条：空正文 + turnUsage —— 发给模型的历史跳过它（不多一行空的 Assistant:） */
    const stored = { id: 'a_9', role: 'assistant', content: '', ts: 5, turnUsage: usage };
    assert.equal(modelFacing(stored), false);
    /* 有工具记录 / 提问卡片 / 正文的回复照旧发 */
    assert.equal(modelFacing({ role: 'assistant', content: '', toolCalls: [{}] }), true);
    assert.equal(modelFacing({ role: 'assistant', content: '', question: {} }), true);
    assert.equal(modelFacing({ role: 'assistant', content: 'ok' }), true);
    /* 即时：界面这一轮一条助手消息都没有 → 补上主进程那条（同一个 id） */
    const live: { id: string; role: string; turnUsage?: typeof usage }[] = [{ id: 'u1', role: 'user' }];
    const shown = attachTurnUsage(live, 'a_9', usage, () => ({ id: 'a_9', role: 'assistant' }));
    assert.equal(shown.length, 2);
    assert.equal(shown[1].id, 'a_9');
    assert.equal(turnUsageLabel(combineTurnUsage([shown[1].turnUsage]), 1, t)!.text, '0.25 credits');
    /* 重载：读回来的形状校验通过，显示同一个值；轮数统计算上这一轮 */
    const back = asTurnUsage(JSON.parse(JSON.stringify(stored)).turnUsage);
    const reloaded = [{ id: 'u1', role: 'user' }, { id: 'a_9', role: 'assistant', turnUsage: back }];
    assert.equal(turnUsageLabel(back, 1, t)!.text, '0.25 credits');
    assert.equal(sessionTurnStats(reloaded, 'kiro', t), 'Turns this session: 1, average 0.25 credits per turn');
  });
});

describe('接线（源码扫描）', () => {
  const SRC = path.join(import.meta.dirname, '..', 'src');
  const M = fs.readFileSync(path.join(SRC, 'main', 'index.ts'), 'utf8');
  const CHAT = fs.readFileSync(path.join(SRC, 'renderer', 'components', 'ChatArea.tsx'), 'utf8');
  const ACP = fs.readFileSync(path.join(SRC, 'renderer', 'hooks', 'useAcp.ts'), 'utf8');

  test('记账在一轮结束落盘那一处（flushAssistant）：写进助手消息、推给界面、清掉累加器', () => {
    const start = M.indexOf('function flushAssistant(');
    const end = M.indexOf('\n}\n', start);
    const body = M.slice(start, end);
    assert.ok(start > 0);
    assert.match(body, /const turnUsage = entry \? settleTurnUsage\(sessionId, entry, turnUsageAcc\) : null;/);
    /* 没有正文、没有被记录的工具，但引擎报了真实消耗：不提前 return，照样落一条（消耗挂在它上面） */
    assert.match(body, /if \(!entry \|\| \(!entry\.assistantBuf && entry\.fileChanges\.length === 0 && !entry\.wedgeNote && !turnUsage\)\) \{/);
    assert.ok(body.indexOf('const turnUsage = entry ? settleTurnUsage(') < body.indexOf('!entry.wedgeNote && !turnUsage'), '先收尾消耗，再判要不要提前 return');
    const settle = M.slice(M.indexOf('function settleTurnUsage('), start);
    assert.match(settle, /finishTurnUsage\(acc, \{/);
    assert.match(settle, /store\.patchRecord\(sessionId, \{ lastTurnContextUsed/);
    const append = body.slice(body.indexOf('store.appendMessage('));
    assert.match(append.slice(0, append.indexOf('});')), /turnUsage/);
    /* 推给界面的是单独的事件，不在「有正文才发 assistant-final」那个条件里 —— 只调了工具、没有正文的轮也到界面 */
    const push = body.indexOf("mainWindow?.webContents.send('acp:turn-usage', { sessionId, messageId: finalId, turnUsage, ...(turnStart ? { turnStart } : {}) });");
    assert.ok(push > 0, 'flushAssistant 没有推 acp:turn-usage（带这一轮的边界 turnStart）');
    /* 边界：回的那条消息（含后台纠正那条 KiroLex 提示）；自发轮用来源标记 */
    assert.match(body, /const turnStart = replyTo \?\? \(opts\?\.autonomous \? entry\.autonomousNoteId : undefined\);/);
    assert.match(M, /entry\.currentUserMessageId = undefined;\n\s*entry\.autonomousNoteId = turn\.noteId;/);
    const guard = body.lastIndexOf('if (', push);
    assert.equal(body.slice(guard, body.indexOf('{', guard)).trim(), 'if (turnUsage && !entry.priming)');
    assert.ok(body.indexOf('if (finalText && !entry.priming)') < guard);
    assert.match(body.slice(body.indexOf('if (finalText && !entry.priming)'), guard), /\n {2}\}\n/, 'acp:turn-usage 不能嵌在 finalText 分支里');
    /* 早退（这一轮什么都没留下）也要清掉，不能漏到下一轮 */
    const early = body.slice(0, body.indexOf('const finalId'));
    assert.match(early, /turnUsageAcc = undefined/);
  });

  test('每一帧都喂给累加器，且在主进程自己起的一轮（autonomous）判结束之前', () => {
    const at = M.indexOf('foldTurnFrame(');
    assert.ok(at > 0);
    const auto = M.indexOf('if (entry.autonomous) autonomousFrame(');
    assert.ok(auto > at, '累加要在 autonomousFrame 之前，否则带 cost 的那帧先把这一轮收了');
    /* 主进程自己起的轮（定时 / 后台命令 / 监视 / 自发轮）都经 flushAssistant 落盘 —— 同一处 */
    assert.match(M, /flushAssistant\(sessionId, \{ autonomous: true, entry \}\)/);
  });

  test('message-actions 渲染本轮消耗（拿不到才回退估算）', () => {
    const at = CHAT.indexOf('<div className="message-actions">');
    const seg = CHAT.slice(at, at + 1500);
    assert.match(seg, /turnUsageLabel|turnCost/);
    assert.match(CHAT, /turnUsageLabel\(/);
    assert.match(CHAT, /sessionTurnStats\(/);
  });

  test('界面读盘 / 收尾 / 整份重写都带着 turnUsage', () => {
    assert.match(ACP, /turnUsageOf\(m\)/);
    const at = ACP.indexOf('const removeTurnUsage = window.kiroApi.onTurnUsage?.(');
    assert.ok(at > 0);
    const fin = ACP.slice(at, at + 700);
    assert.match(fin, /attachTurnUsage\(prev, messageId, usage, make, turnStart\)/);
    assert.match(fin, /attachTurnUsage\(cached, messageId, usage, make, turnStart\)/);
    assert.match(fin, /const make = \(\): Message => \(\{ id: messageId, role: 'assistant', content: ''/);
    assert.doesNotMatch(fin, /!text/, '没有正文的轮也要挂上');
    assert.match(ACP, /removeTurnUsage\?\.\(\);/);
    const PRE = fs.readFileSync(path.join(SRC, 'main', 'preload.ts'), 'utf8');
    assert.match(PRE, /ipcRenderer\.on\('acp:turn-usage', handler\)/);
    const stored = ACP.slice(ACP.indexOf('function toStoredTranscript('));
    assert.match(stored.slice(0, 2000), /turnUsage/);
  });
});
