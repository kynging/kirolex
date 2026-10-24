/**
 * 用量栏：Claude Code / Codex 会话显示本会话花费（美元），替代「0.00 credits」（审计 F3，负责人 2026-10-24 定：显示）。
 *
 * 协议语义（核实过）：ACP `UsageUpdate.cost` 是 **Cumulative session cost**；claude-agent-acp 0.88.0 填的是
 * SDK result 的 `total_cost_usd` —— 这个适配器**进程**里累计的，进程重启（换后端 / 重开会话）就从 0 重新数。
 * codex-acp 只发 `{ used, size }`，不带 cost。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { costOfUpdate, foldSessionCost } from '../src/main/sessionCost.ts';
import { usageChip as chip, type UsageView } from '../src/renderer/usageChip.ts';
import { t } from '../src/renderer/i18n.ts';

const usageChip = (engine: string | undefined, u: UsageView | null) => chip(engine, u, (k, v) => t('en', k, v));
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');

/* ------------------------------------------------ 主进程：累计 */

test('costOfUpdate：只认带 cost.amount 的 usage_update', () => {
  assert.deepEqual(costOfUpdate({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 0.035, currency: 'USD' } }), { amount: 0.035, currency: 'USD' });
  assert.equal(costOfUpdate({ sessionUpdate: 'usage_update', used: 1, size: 2 }), null, 'Codex 不带 cost');
  assert.equal(costOfUpdate({ sessionUpdate: 'usage_update', cost: null }), null);
  assert.equal(costOfUpdate({ sessionUpdate: 'usage_update', cost: { amount: 'x' } }), null);
  assert.equal(costOfUpdate({ sessionUpdate: 'usage_update', cost: { amount: -1 } }), null);
  assert.equal(costOfUpdate({ sessionUpdate: 'agent_message_chunk', cost: { amount: 1 } }), null);
  assert.deepEqual(costOfUpdate({ sessionUpdate: 'usage_update', cost: { amount: 0.5 } }), { amount: 0.5, currency: 'USD' }, '没写币种按 USD');
});

test('cost 累计：同一个进程里读数是累计值，本轮 = 和上次读数的差', () => {
  let c = foldSessionCost(undefined, { amount: 0.035, currency: 'USD' }, 1);
  assert.deepEqual(c, { total: 0.035, turn: 0.035, reading: 0.035, currency: 'USD', at: 1 });
  c = foldSessionCost(c, { amount: 0.05, currency: 'USD' }, 2);
  assert.ok(Math.abs(c.total - 0.05) < 1e-12);
  assert.ok(Math.abs(c.turn - 0.015) < 1e-12);
  assert.equal(c.reading, 0.05);
  /* 同一帧重复 / 这一轮没花钱：不重复累加 */
  c = foldSessionCost(c, { amount: 0.05, currency: 'USD' }, 3);
  assert.ok(Math.abs(c.total - 0.05) < 1e-12);
  assert.equal(c.turn, 0);
});

test('换后端 / 重开会话：适配器从 0 重新数，累计值接着往上加、不清零', () => {
  let c = foldSessionCost(undefined, { amount: 0.4, currency: 'USD' }, 1);
  /* 新进程的第一轮只花了 0.02 —— 读数变小，说明计数器重来了 */
  c = foldSessionCost(c, { amount: 0.02, currency: 'USD' }, 2);
  assert.ok(Math.abs(c.total - 0.42) < 1e-12);
  assert.ok(Math.abs(c.turn - 0.02) < 1e-12);
  assert.equal(c.reading, 0.02);
  c = foldSessionCost(c, { amount: 0.03, currency: 'USD' }, 3);
  assert.ok(Math.abs(c.total - 0.43) < 1e-12);
  /* 记录里存的是 JSON：落盘再读回来照样能接着算 */
  const back = JSON.parse(JSON.stringify(c));
  const d = foldSessionCost(back, { amount: 0.01, currency: 'USD' }, 4);
  assert.ok(Math.abs(d.total - 0.44) < 1e-12);
});

/*
  审查意见：只凭「读数变小」认不出计数器重来 —— 旧进程攒到 $0.02，重开后新进程第一次就报 $0.05，
  原来算成 total $0.05 / turn $0.03（漏了 $0.02）。2026-10-24 真机核实（claude-agent-acp 0.88.0）：
  旧进程 0.0309 → 0.0521，新进程 session/load、session/resume 之后第一次分别报 0.0214 / 0.0216 —— 只是那一轮，
  **不带**之前的花费。所以新执行器 / 新后端会话的第一帧，基线明确是 0（`freshCounter`）。
*/
test('新计数器（新执行器 / 新后端会话）的第一帧：整笔算这一轮，读数大于、等于、小于旧读数都一样', () => {
  const old = foldSessionCost(undefined, { amount: 0.02, currency: 'USD' }, 1);
  const bigger = foldSessionCost(old, { amount: 0.05, currency: 'USD' }, 2, true);
  assert.ok(Math.abs(bigger.total - 0.07) < 1e-12, '审查复现的那一例');
  assert.ok(Math.abs(bigger.turn - 0.05) < 1e-12);
  assert.equal(bigger.reading, 0.05);
  const equal = foldSessionCost(old, { amount: 0.02, currency: 'USD' }, 2, true);
  assert.ok(Math.abs(equal.total - 0.04) < 1e-12);
  assert.ok(Math.abs(equal.turn - 0.02) < 1e-12);
  const smaller = foldSessionCost(old, { amount: 0.01, currency: 'USD' }, 2, true);
  assert.ok(Math.abs(smaller.total - 0.03) < 1e-12);
  /* 之后同一个计数器里照常按差算 */
  const next = foldSessionCost(bigger, { amount: 0.08, currency: 'USD' }, 3);
  assert.ok(Math.abs(next.total - 0.1) < 1e-12);
  assert.ok(Math.abs(next.turn - 0.03) < 1e-12);
  /* 落盘再读回来（重开窗口）：新进程第一帧一样整笔加上 */
  const back = foldSessionCost(JSON.parse(JSON.stringify(next)), { amount: 0.5, currency: 'USD' }, 4, true);
  assert.ok(Math.abs(back.total - 0.6) < 1e-12);
});

test('记录里的旧值坏了（不是数）就当没有', () => {
  const c = foldSessionCost({ total: 'x', reading: null } as any, { amount: 0.1, currency: 'USD' }, 1);
  assert.equal(c.total, 0.1);
});

test('主进程接线：非 kiro 会话带 cost 的帧累计进会话记录，并把结果带给渲染层', () => {
  const M = read('main', 'index.ts');
  const i = M.indexOf('const sessionCostNow = costOfUpdate(data?.update)');
  assert.ok(i > 0);
  const seg = M.slice(i, i + 1200);
  assert.match(seg, /engineOf\(entry\.profile\) !== 'kiro'/);
  assert.match(seg, /foldSessionCost\(entry\.sessionCost \?\? store\.readRecord\(sessionId\)\?\.sessionCost, sessionCostNow, Date\.now\(\), freshCounter\)/);
  /* 计数器的边界：这个执行器（entry 一个进程一份）里第一次见到、或者后端会话换了（新建 / fork） */
  /* 后端会话 id 还没有时也算新的（undefined !== ''） */
  assert.match(seg, /const counterKey = entry\.cliSessionId \?\? '';\s+const freshCounter = entry\.costCounterFor !== counterKey;/);
  assert.match(seg, /entry\.costCounterFor = counterKey;/);
  assert.match(M, /const entry: SessionEntry = \{ client, cliSessionId, profile,/, '每起一个执行器就是一份新 entry（costCounterFor 为空）');
  assert.match(seg, /store\.patchRecord\(sessionId, \{ sessionCost/);
  assert.match(seg, /kirolexCost:/);
  /* 在转发给渲染层之前 */
  assert.ok(i < M.indexOf("mainWindow?.webContents.send('acp:update', { ...data, sessionId", i));
  const S = read('main', 'sessionStore.ts');
  assert.match(S, /sessionCost\?: SessionCost;/);
  /* 重开窗口 / 换设备：列表把记录里的值带过去 */
  const h = M.slice(M.indexOf("ipcMain.handle('acp:list-durable-sessions'"), M.indexOf("ipcMain.handle('acp:mark-session-purpose'"));
  assert.match(h, /rec\.sessionCost \? \{ sessionCost: rec\.sessionCost \} : null/);
});

/* ------------------------------------------------ 渲染层：显示什么 */

test('kiro 会话保持原样：credits', () => {
  assert.deepEqual(usageChip('kiro', { contextPercent: 10, credits: 1.234 }), { kind: 'credits', text: '1.23' });
  assert.deepEqual(usageChip(undefined, { contextPercent: 10, credits: 0 }), { kind: 'credits', text: '0.00' }, '老会话没有 engine = kiro');
  /* kiro 会话就算有 cost 字段也不显示美元 */
  assert.equal(usageChip('kiro', { contextPercent: 10, credits: 0, cost: 1 } as any)!.kind, 'credits');
});

test('非 kiro + 有 cost：显示累计美元，悬停给本轮和 token', () => {
  const c = usageChip('claude', { contextPercent: 12, credits: 0, cost: 0.4213, turnCost: 0.035, currency: 'USD', usedTokens: 24881, sizeTokens: 200000 })!;
  assert.equal(c.kind, 'cost');
  assert.equal(c.text, '$0.42');
  assert.match(c.title, /\$0\.4213/);
  assert.match(c.title, /\$0\.0350/);
  assert.match(c.title, /24,881 \/ 200,000/);
  assert.doesNotMatch(c.text + c.title, /credits/i);
  /* 没 token 就不提 token */
  const d = usageChip('claude', { contextPercent: 0, credits: 0, cost: 0.004, currency: 'USD' })!;
  assert.equal(d.text, '<$0.01');
  assert.doesNotMatch(d.title, /tokens/);
  assert.equal(usageChip('claude', { contextPercent: 0, credits: 0, cost: 0, currency: 'USD' })!.text, '$0.00');
  assert.equal(usageChip('claude', { contextPercent: 0, credits: 0, cost: 2, currency: 'EUR' })!.text, '2.00 EUR');
});

test('非 kiro + 无 cost：显示 token；token 也没有就整块不显示', () => {
  const c = usageChip('codex', { contextPercent: 12, credits: 0, usedTokens: 24881, sizeTokens: 200000 })!;
  assert.equal(c.kind, 'tokens');
  assert.equal(c.text, '24.9k tokens');
  assert.match(c.title, /24,881 \/ 200,000/);
  assert.doesNotMatch(c.text + c.title, /credits/i);
  assert.equal(usageChip('codex', { contextPercent: 12, credits: 0 }), null, '旧的、只有占比的记录：不显示 0.00 credits');
  assert.equal(usageChip('codex', { contextPercent: 12, credits: 0, usedTokens: 512 })!.text, '512 tokens');
  assert.equal(usageChip('codex', null), null);
});

test('渲染层：非 kiro 的那一格不再出现 credits 文案；usage_update 接住 kirolexCost / token', () => {
  const C = read('renderer', 'components', 'ChatArea.tsx');
  const i = C.indexOf('{nonKiro && usageChipNow && (');
  assert.ok(i > 0);
  const seg = C.slice(i, C.indexOf(')}', i) + 2);
  assert.doesNotMatch(seg, /credits/i);
  assert.match(seg, /usageChipNow\.text/);
  assert.match(seg, /title=\{usageChipNow\.title\}/);
  /* kiro 的 credits 按钮原样还在 */
  assert.match(C, /\{!nonKiro && \(\s*<button\s+type="button"\s+className="composer-credits composer-usage-action"/);
  const A = read('renderer', 'hooks', 'useAcp.ts');
  const u = A.slice(A.indexOf("case 'usage_update': {"), A.indexOf("case '_kiro_internal': {"));
  assert.match(u, /update\.kirolexCost/);
  assert.match(u, /usedTokens: update\.used, sizeTokens: update\.size/);
  /* 重开窗口：记录里的累计值进用量表 */
  assert.match(A, /seedSessionCost\(/);
});
