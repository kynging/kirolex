/**
 * 提问卡片在界面消息列表里的位置 / 更新（`renderer/questionCards.ts`）+ 各处接线（源码扫描）。
 *
 * 守的是：卡片放在这一轮开头（和盘上「卡片 → 回复」的顺序一致，也不把流式正文切成两段）、按 id 覆盖；
 * 流式追加 / 一轮结束的权威正文 / 工具调用都不会落到卡片上；读盘 / 整份重写都带着它；
 * 主进程关卡片时落盘、超时 / 停止 / 断开都会关；Claude Code / Codex 不再套 choiceChips。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { upsertQuestionCard, isQuestionMessage, turnHasQuestion, shouldCancelOnLeave, leftScreen } from '../src/renderer/questionCards.ts';
import { closeQuestionCard, newQuestionCard } from '../src/main/elicitation.ts';
import { storeMismatch } from '../src/renderer/messageReconcile.ts';
import { chatHistoryBody } from '../src/renderer/historyBlock.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
const SCHEMA = { type: 'object', properties: { q: { type: 'string', oneOf: [{ const: 'a', title: 'A' }] } } };
const card = (id: string, now = 100) => newQuestionCard({ id, sessionId: 's', requestId: 1, now, params: { message: 'Pick', requestedSchema: SCHEMA } });
const msg = (id: string, role: 'user' | 'assistant', content: string, extra: any = {}) => ({ id, role, content, timestamp: 1, ...extra });

describe('upsertQuestionCard', () => {
  test('放在这一轮开头：最后一条用户消息（和它的追加指令、KiroLex 提示）之后、回复正文之前', () => {
    const list = [
      msg('u0', 'user', 'old'), msg('a0', 'assistant', 'old reply'),
      msg('u1', 'user', 'now'), msg('s1', 'user', 'steer', { steer: 'consumed' }), msg('n1', 'user', 'note', { kirolex: true }),
      msg('a1', 'assistant', 'Let me ask'),
    ];
    const out = upsertQuestionCard(list as any, card('q1'));
    assert.deepEqual(out.map((m) => m.id), ['u0', 'a0', 'u1', 's1', 'n1', 'q1', 'a1']);
    assert.equal(out[5].role, 'assistant');
    assert.equal(out[5].content, '');
    assert.ok(isQuestionMessage(out[5]));
  });

  test('第二张排在第一张后面；没有回复正文时就接在最后', () => {
    let out = upsertQuestionCard([msg('u1', 'user', 'now')] as any, card('q1'));
    out = upsertQuestionCard(out, card('q2', 200));
    assert.deepEqual(out.map((m) => m.id), ['u1', 'q1', 'q2']);
  });

  test('同 id 再来一份（主进程推来关掉的卡片）：原地覆盖，不新增', () => {
    const first = upsertQuestionCard([msg('u1', 'user', 'x'), msg('a1', 'assistant', 'y')] as any, card('q1'));
    const closed = closeQuestionCard(card('q1'), 'answered', 300, { q: 'a' });
    const out = upsertQuestionCard(first, closed);
    assert.deepEqual(out.map((m) => m.id), ['u1', 'q1', 'a1']);
    assert.equal(out[1].question?.status, 'answered');
  });

  test('turnHasQuestion：只看这一轮（到最后一条你发的消息为止），追加指令 / KiroLex 提示不算边界', () => {
    const q = closeQuestionCard(card('q1'), 'answered', 300, { q: 'a' });
    const list = [
      msg('u0', 'user', 'old'), msg('q0', 'assistant', '', { question: q }), msg('a0', 'assistant', 'old'),
      msg('u1', 'user', 'now'), msg('n1', 'user', 'note', { kirolex: true }), msg('a1', 'assistant', '1. A\n2. B'),
    ];
    assert.equal(turnHasQuestion(list as any, 5), false, '上一轮问过不算这一轮');
    assert.equal(turnHasQuestion(list as any, 2), true);
    const withCard = upsertQuestionCard(list as any, { ...q, id: 'q0' });
    assert.equal(turnHasQuestion(withCard, withCard.length - 1), false, '同 id 覆盖的是上一轮那张，位置不动');
    const fresh = upsertQuestionCard(list as any, card('q2'));
    assert.equal(turnHasQuestion(fresh, fresh.length - 1), true);
  });

  test('拼进历史块（复制会话 / 编辑重跑）：卡片写成「问了什么、答了什么」，不是一行空的 Assistant:', () => {
    const closed = closeQuestionCard(card('q1'), 'answered', 300, { q: 'a' });
    const body = chatHistoryBody([{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', question: closed }, { role: 'assistant', content: 'ok' }]);
    assert.equal(body, 'User: hi\n\nAssistant: [question answered] Pick\n- q [q] (single): a (A)\n→ q = A\n\nAssistant: ok');
  });

  test('和盘上对账：卡片正文是空的，不会让「界面 vs 盘上」判成不一致', () => {
    const closed = closeQuestionCard(card('q1'), 'answered', 300, { q: 'a' });
    const cached = [msg('u1', 'user', 'x'), msg('q1', 'assistant', '', { question: closed }), msg('a1', 'assistant', 'done')];
    const stored = [msg('u1', 'user', 'x'), msg('q1', 'assistant', '', { question: closed }), msg('a_final', 'assistant', 'done')];
    assert.equal(storeMismatch(cached as any, stored as any), false);
  });
});

describe('切走会话 = 取消它挂着的提问', () => {
  test('shouldCancelOnLeave：换了会话、且它不在分屏里继续显示才取消', () => {
    assert.equal(shouldCancelOnLeave('a', 'b', new Set()), true);
    assert.equal(shouldCancelOnLeave('a', 'b', new Set(['a', 'b'])), false, '分屏里还看得见的那格：卡片照样能答');
    assert.equal(shouldCancelOnLeave('a', 'a', new Set()), false, '点的还是同一条');
    assert.equal(shouldCancelOnLeave(null, 'b', new Set()), false);
  });
  test('leftScreen：分屏里换掉的那一格（不是焦点）也算离开屏幕', () => {
    assert.deepEqual(leftScreen(new Set(['a', 'b']), new Set(['b', 'c'])), ['a']);
    assert.deepEqual(leftScreen(new Set(['a', 'b']), new Set(['b', 'a'])), []);
  });
  test('取消掉的卡片记成 cancelled + cancelledBy:switch（卡片上说「你切到了别的会话」），落盘读回来还在', () => {
    const closed = closeQuestionCard(card('q1'), 'cancelled', 300, undefined, 'switch');
    assert.equal(closed.status, 'cancelled');
    assert.equal(JSON.parse(JSON.stringify(closed)).cancelledBy, 'switch');
    assert.equal(closeQuestionCard(card('q2'), 'cancelled', 300).cancelledBy, undefined, '停止 / 断开的不带');
    assert.equal(closeQuestionCard(card('q3'), 'answered', 300, { q: 'a' }, 'switch').cancelledBy, undefined);
  });
});

describe('接线（源码）', () => {
  const ACP = read('renderer', 'hooks', 'useAcp.ts');
  const CHAT = read('renderer', 'components', 'ChatArea.tsx');
  const MAIN = read('main', 'index.ts');

  test('useAcp：question 更新按 id 插入 / 覆盖；读盘、整份重写都带着 question；重载补回挂着的', () => {
    assert.match(ACP, /case 'question': \{[\s\S]{0,400}upsertQuestionCard\(list, card\)/);
    assert.match(ACP, /function questionOf\(m: any\)[\s\S]{0,200}\{ question: m\.question \}/);
    /* 读盘转成界面消息的每一处（启动时的上次会话、分屏、切会话、复制会话…）都要带上 —— 漏一处，重启后卡片就不见了 */
    const mappers = (ACP.match(/timestamp: m\.ts,/g) || []).length;
    assert.ok(mappers >= 5);
    assert.equal((ACP.match(/\.\.\.questionOf\(m\),/g) || []).length, mappers);
    assert.match(ACP, /function toStoredTranscript[\s\S]{0,2000}m\.question \? \{ question: m\.question \}/);
    assert.match(ACP, /\.filter\(\(m\) => m\.question\?\.status !== 'pending'\)/);
    assert.match(ACP, /pendingQuestions\?\.\(\)\.then/);
  });

  test('流式追加、一轮结束的权威正文、工具调用、重发丢半截：都跳过卡片', () => {
    assert.equal((ACP.match(/!last\.content\.startsWith\('💭 '\) && !isQuestionMessage\(last\)/g) || []).length, 2);
    assert.match(ACP, /list\[i\]\.role === 'assistant' && !list\[i\]\.content\.startsWith\('💭 '\) && !isQuestionMessage\(list\[i\]\)/);
    assert.match(ACP, /current\[index\]\.role === 'assistant' && !isQuestionMessage\(current\[index\]\)/);
    assert.match(ACP, /list\[i\]\.role === 'assistant' && !isQuestionMessage\(list\[i\]\)\) \{ idx = i; break; \}/);
  });

  test('ChatArea：回复气泡里带 question 的一段画成 QuestionCardView；Claude Code / Codex 不套 choiceChips', () => {
    assert.match(CHAT, /const asked = segments\[idx\]\?\.question;[\s\S]{0,300}<QuestionCardView card=\{asked\} \/>/);
    const chips = CHAT.slice(CHAT.indexOf('const choiceChips = React.useMemo'), CHAT.indexOf('const choiceChips = React.useMemo') + 900);
    assert.match(chips, /if \(engine && engine !== 'kiro'\) return \[\];/);
    assert.match(chips, /if \(msg\.question\) return \[\];/);
    assert.match(chips, /if \(turnHasQuestion\(messages, i\)\) return \[\];/);
  });

  test('主进程：关卡片时回包一次、落盘、推给界面；超时按 cancel；停止 / 断开 / 撤回都关', () => {
    const close = MAIN.slice(MAIN.indexOf('function closeQuestion('), MAIN.indexOf('function closeQuestion(') + 1600);
    assert.match(close, /if \(respond\) open\.client\.respondToElicitation\(open\.card\.requestId, respond\)/);
    assert.match(close, /store\.appendMessage\(card\.sessionId, \{ id: card\.id, role: 'assistant', content: '', ts: card\.askedAt, question: card \}\)/);
    assert.match(close, /pushQuestion\(card\)/);
    assert.match(MAIN, /setTimeout\(\(\) => closeQuestion\(card\.id, 'timeout', \{ action: 'cancel' \}\)/);
    assert.match(MAIN, /client\.on\('elicitation-closed'[\s\S]{0,300}closeQuestion\(id, d\.reason === 'withdrawn' \? 'withdrawn' : 'cancelled'\)/);
    assert.match(MAIN, /ipcMain\.handle\('acp:answer-question'/);
    /* 切走：主进程对这条会话每张挂着的卡片回 cancel、关掉、落盘 */
    const cancel = MAIN.slice(MAIN.indexOf('function cancelQuestionsFor('), MAIN.indexOf('function cancelQuestionsFor(') + 400);
    assert.match(cancel, /closeQuestion\(card\.id, 'cancelled', elicitationResult\('cancel'\), undefined, 'switch'\)/);
    assert.match(MAIN, /ipcMain\.handle\('acp:cancel-questions', \(_event, sessionId: string\) => cancelQuestionsFor\(/);
    const sw = ACP.slice(ACP.indexOf('const switchSession = useCallback'), ACP.indexOf('const switchSession = useCallback') + 4000);
    assert.match(sw, /if \(shouldCancelOnLeave\(outgoing, sessionId, onScreenPaneIdsRef\.current\)\) cancelQuestionsIfGone\(\[outgoing!\]\);/);
    /* 分屏换掉一格：屏幕集合变了就查一遍离开的那些 */
    const panes = ACP.slice(ACP.indexOf('const setPaneSessions = useCallback'), ACP.indexOf('const setPaneSessions = useCallback') + 900);
    assert.match(panes, /cancelQuestionsIfGone\(leftScreen\(wasOnScreen, onScreenPaneIdsRef\.current\)\);/);
    /* 真取消之前再确认一次：不是焦点、也不在任何一格里 */
    const gone = ACP.slice(ACP.indexOf('const cancelQuestionsIfGone = '), ACP.indexOf('const cancelQuestionsIfGone = ') + 600);
    assert.match(gone, /if \(!id \|\| id === currentSessionRef\.current \|\| onScreenPaneIdsRef\.current\.has\(id\)\) continue;/);
    assert.match(gone, /window\.kiroApi\.cancelQuestions\?\.\(id\)/);
    assert.ok(sw.indexOf('shouldCancelOnLeave(') < sw.indexOf('currentSessionRef.current = sessionId;'), '在焦点换过去之前判（outgoing 还是旧的）');
    assert.match(MAIN, /if \(e\.client\.awaitingQuestion\) \{\s*e\.lastStreamAt = Date\.now\(\);\s*return;/);
  });
});
