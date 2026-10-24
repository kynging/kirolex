/**
 * 「需要你选的东西永远在最下面」（2026-10-24 反馈：🔧 用过的工具展开后把选项挤出视野）。
 *
 * 守三件事：
 *   1. 一条助手消息里的顺序：正文 < 工具块（turn panels）< 还挂着的提问卡片；
 *   2. 「🔧 用过的工具」默认折叠成一行摘要（跑着的这一轮也一样，只在摘要里带最近一条在跑的工具），点开过的按消息记住；
 *   3. 出现挂着的提问时：停在底部就滚过去；正在往上翻历史就不抢滚动，改为底部浮标「有待你选择 ↓」。
 * 选项按钮（choiceChips）和权限 / 批准计划卡片（PermissionBar）画在消息列表外面的输入区里，本来就在最下面 —— 也断言一下不被挪进消息列表。
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pendingQuestionId, splitTurnAsks } from '../src/renderer/questionCards.ts';
import { toolsSummaryOf, toolRowsOf } from '../src/renderer/toolRows.ts';
import { revealPendingAsk } from '../src/renderer/askReveal.ts';

const CHAT = fs.readFileSync(path.join(import.meta.dirname, '../src/renderer/components/ChatArea.tsx'), 'utf8');
const CARD = fs.readFileSync(path.join(import.meta.dirname, '../src/renderer/components/QuestionCard.tsx'), 'utf8');

const q = (id: string, status: string) => ({ id, status }) as any;

describe('提问卡片排到这一轮的最下面', () => {
  test('挂着的提问卡片排在其他段后面；答完的留在原位置（读历史时顺序和发生的顺序一致）', () => {
    const segs = [{ question: q('q1', 'pending') }, {}, { question: q('q0', 'answered') }, {}];
    assert.deepEqual(splitTurnAsks(segs), { flow: [1, 2, 3], asks: [0] });
  });
  test('没有提问：全在正文流里', () => {
    assert.deepEqual(splitTurnAsks([{}, {}]), { flow: [0, 1], asks: [] });
  });
  test('pendingQuestionId：取最后一张还挂着的卡片；没有就是 null', () => {
    assert.equal(pendingQuestionId([{ question: q('a', 'pending') }, {}, { question: q('b', 'pending') }]), 'b');
    assert.equal(pendingQuestionId([{ question: q('a', 'answered') }, {}]), null);
    assert.equal(pendingQuestionId([]), null);
  });
});

/** 模拟一格消息列表：可视区高 `view`、内容总高 `total`，卡片按内容里的偏移排；scrollTop 像浏览器一样被夹在 [0, total - view]。 */
function fakePane(view: number, total: number, cards: { id: string; offset: number }[]) {
  let st = 0;
  const pane = {
    get scrollTop() { return st; },
    set scrollTop(v: number) { st = Math.max(0, Math.min(total - view, v)); },
    scrollHeight: total,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => cards.map((c) => ({ dataset: { pendingAsk: c.id }, getBoundingClientRect: () => ({ top: 100 + c.offset - st }) })),
  };
  return pane;
}

describe('滚到挂着的提问（同时挂好几张时按 id 找）', () => {
  test('两张加起来比可视区高：滚到的是第二张（最新那张）的顶上，不是第一张', () => {
    // 可视区 400；第一张从 1000 开始、第二张从 1600 开始，内容一共 2200 高
    const pane = fakePane(400, 2200, [{ id: 'q1', offset: 1000 }, { id: 'q2', offset: 1600 }]);
    revealPendingAsk(pane, 'q2');
    assert.equal(pane.scrollTop, 1600, '第二张的顶上对齐可视区顶上');
    revealPendingAsk(pane, 'q1');
    assert.equal(pane.scrollTop, 1000);
  });
  test('目标卡片在底部就看得见：只滚到底', () => {
    const pane = fakePane(400, 2000, [{ id: 'q1', offset: 1700 }]);
    revealPendingAsk(pane, 'q1');
    assert.equal(pane.scrollTop, 1600);
  });
  test('找不到那张卡片 / 没有 id：只滚到底，不去对齐别的卡片', () => {
    const pane = fakePane(400, 2200, [{ id: 'q1', offset: 1000 }]);
    revealPendingAsk(pane, 'qX');
    assert.equal(pane.scrollTop, 1800);
    revealPendingAsk(pane, null);
    assert.equal(pane.scrollTop, 1800);
    revealPendingAsk(null, 'q1');   // 没有容器：什么也不做
  });
});

describe('工具块摘要', () => {
  const calls = [
    { toolCallId: 't1', title: 'Read a.ts', toolName: 'Read', status: 'completed' },
    { toolCallId: 'ag', title: 'Agent: look', toolName: 'Agent', status: 'pending' },
    { toolCallId: 'c1', title: 'Grep foo', toolName: 'Grep', status: 'completed', parentToolCallId: 'ag' },
    { toolCallId: 'c2', title: 'Glob *.md', toolName: 'Glob', status: 'in_progress', parentToolCallId: 'ag' },
    { toolCallId: 't2', title: 'WebFetch x', toolName: 'WebFetch', status: 'completed' },
  ];
  test('数工具（含子代理派出去的）和子代理，带出最近一条在跑的', () => {
    const s = toolsSummaryOf(toolRowsOf(calls));
    assert.equal(s.tools, 5);
    assert.equal(s.subagents, 1);
    assert.equal(s.running?.toolCallId, 'c2');
  });
  test('都跑完了：running 为 null', () => {
    const s = toolsSummaryOf(toolRowsOf([{ toolCallId: 't1', title: 'Read', toolName: 'Read', status: 'completed' }]));
    assert.deepEqual({ tools: s.tools, subagents: s.subagents, running: s.running }, { tools: 1, subagents: 0, running: null });
  });
});

describe('ChatArea 接线', () => {
  const item = CHAT.slice(CHAT.indexOf('const MessageItem = memo<'), CHAT.indexOf('// A pasted blob inside a user message'));
  test('MessageItem：正文段 < 工具块 < 提问卡片', () => {
    const flow = item.indexOf('flow.map(');
    const panels = item.indexOf('<ToolsPanel');
    const asks = item.indexOf('asks.map(');
    const card = item.lastIndexOf('<QuestionCardView');   // 答完的只读摘要留在正文流里，挂着的那张在最后
    assert.ok(flow > 0 && panels > flow, '工具块要在正文后面');
    assert.ok(asks > panels && card > asks, '提问卡片要在工具块后面');
  });
  test('ToolsPanel 默认折叠，跑着的这一轮也不自动展开；展开过的按消息记', () => {
    const panel = CHAT.slice(CHAT.indexOf('const ToolsPanel = memo<'), CHAT.indexOf('const FileChangesPanel = memo<'));
    assert.match(panel, /const collapsed = !\(pinned \?\? false\)/);
    assert.doesNotMatch(panel, /pinned \?\? !live/);
    assert.match(panel, /toolsPanelOpen\.(get|set)\(/, '展开 / 收起记在模块级的表里，消息重新挂载也还在');
    assert.match(panel, /toolsSummaryOf\(/);
    assert.match(panel, /summary\.running/, '跑着的这一轮在摘要里带最近一条在跑的工具');
  });
  test('出现挂着的提问：在底部就滚过去，往上翻着就显示浮标', () => {
    const effect = CHAT.slice(CHAT.indexOf('const pendingAsk = '), CHAT.indexOf('const pendingAsk = ') + 1600);
    assert.match(effect, /pendingQuestionId\(messages\)/);
    assert.match(effect, /stickToBottomRef\.current/);
    assert.match(effect, /revealPendingAsk\(chatMessagesRef\.current, pendingAsk\)/, '滚到的是 pendingAsk 那一张（最新的），不是第一张');
    assert.match(effect, /revealPendingAsk\(chatMessagesRef\.current, pendingAskRef\.current\)/, '点浮标跳到的也是最新那张');
    assert.match(effect, /setAskBelow\(true\)/);
    assert.match(CHAT, /className="jump-to-bottom-btn ask-below-btn"/);
    assert.match(CHAT, /t\('Waiting for your choice ↓'\)/);
    // 滚回底部就收起浮标
    const onScroll = CHAT.slice(CHAT.indexOf('className="chat-messages"'), CHAT.indexOf('className="chat-messages"') + 1500);
    assert.match(onScroll, /if \(atBottom\) setAskBelow\(false\)/);
  });
  test('提问卡片自己不再滚动（滚不滚由 ChatArea 按你在不在底部决定）', () => {
    assert.doesNotMatch(CARD, /revealInPane\(/);
  });
  test('选项按钮和权限 / 批准计划卡片仍在消息列表外面的输入区（天然在最下面）', () => {
    const list = CHAT.indexOf('className="chat-messages"');
    const area = CHAT.indexOf('className="chat-input-area"');
    assert.ok(area > list);
    assert.ok(CHAT.indexOf('<PermissionBar', area) > area);
    assert.ok(CHAT.indexOf('choiceChips={choiceChips}', area) > area);
  });
});
