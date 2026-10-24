import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  setBusy, setErr, statusFor, dismissErr, clearErrOnReady, switchFailureNotice, runSessionRequest,
  type RequestStatusMap,
} from '../src/renderer/sessionRequestStatus.ts';

/*
  Claude Code / Codex 模型 / 组合下拉旁那个 ✗（切换失败的标记）。
  用户看到的是一个孤零零的红 ✗：原因只在悬停提示里、关不掉、连接恢复后也一直挂着。
  守的是：能手动关、这条会话之后连上 / 切换成功时自动清、失败时在会话状态行说一句人话。
*/

const failed = (sid = 'A'): RequestStatusMap => setErr({}, sid, 'Session open refused by peer');

test('手动关掉：只清这条会话的错误，别的会话和忙状态不动', () => {
  let m = setErr(failed('A'), 'B', 'B 的错误');
  m = setBusy(m, 'A', 'combo', true);
  m = dismissErr(m, 'A');
  assert.equal(statusFor(m, 'A').err, '');
  assert.equal(statusFor(m, 'A').comboBusy, true, '关掉 ✗ 不能把还在进行的请求也清掉');
  assert.equal(statusFor(m, 'B').err, 'B 的错误');
  /* 没有错误时原样返回（不触发无谓的重渲染） */
  assert.equal(dismissErr(m, 'C'), m);
});

test('连上之后自动清：这条会话从「没连上」变成「连上且后端已挂好」', () => {
  const m = failed('A');
  const cleared = clearErrOnReady(m, [], ['A']);
  assert.equal(statusFor(cleared, 'A').err, '');
});

test('连接状态没走到「连上」不清：掉线、仍在连、一直连着都留着 ✗', () => {
  const m = failed('A');
  assert.equal(clearErrOnReady(m, ['A'], []), m, '掉线不算恢复');
  assert.equal(clearErrOnReady(m, [], []), m, '还在连');
  assert.equal(clearErrOnReady(m, ['A'], ['A']), m, '一直连着（切换失败但旧执行器还在）');
});

test('别的会话连上不算：A 的 ✗ 留着', () => {
  const m = failed('A');
  assert.equal(clearErrOnReady(m, ['A'], ['A', 'B']), m);
  assert.equal(statusFor(m, 'A').err, 'Session open refused by peer');
});

test('后台恢复：A 切换失败 → 切到 B → A 在后台断线又恢复 → 切回 A，✗ 已经清掉', () => {
  /* 按会话跟踪：不看这一格此刻显示的是谁，只看 A 自己有没有从没连上变成连上 */
  let m = failed('A');
  let ready: string[] = ['A', 'B'];
  const step = (next: string[]) => { m = clearErrOnReady(m, ready, next); ready = next; };
  step(['B']);          // A 在后台掉线（这时这一格显示的是 B）
  assert.equal(statusFor(m, 'A').err, 'Session open refused by peer', '掉线时还不清');
  step(['A', 'B']);     // A 在后台重连成功
  assert.equal(statusFor(m, 'A').err, '', 'A 恢复后清掉，切回 A 时看不到旧的 ✗');
});

test('切换成功：上次的 ✗ 被清掉', async () => {
  let map: RequestStatusMap = failed('A');
  const update = (fn: (m: RequestStatusMap) => RequestStatusMap) => { map = fn(map); };
  await runSessionRequest('A', 'combo', update, async () => ({ current: 'x' }), () => {}, String);
  assert.equal(statusFor(map, 'A').err, '');
});

test('失败提示：带上原因（去掉 Electron 那层前缀），中英两版都有', () => {
  const n = switchFailureNotice('combo', "Error invoking remote method 'acp:switch-mcp-combo': Error: Session open refused by peer", 'zh');
  assert.equal(n.text, '⚠️ 切换 MCP 配置失败：Session open refused by peer');
  assert.equal(n.variants.en, '⚠️ Switching the MCP profile failed: Session open refused by peer');
  assert.equal(switchFailureNotice('model', 'boom', 'en').text, '⚠️ Switching the model failed: boom');
  assert.match(switchFailureNotice('effort', 'boom', 'zh').text, /^⚠️ 切换 effort 失败：boom$/);
  assert.match(switchFailureNotice('mode', 'boom', 'zh').text, /^⚠️ 切换权限模式失败：boom$/);
});

test('失败提示：主进程的报错本身已经说了「换组合失败」时不再套一层', () => {
  const raw = 'Switching to the MCP profile "web" failed (ssh died); the previous MCP profile is kept and your next message reconnects with it.';
  const n = switchFailureNotice('combo', raw, 'zh');
  assert.equal(n.variants.en, `⚠️ ${raw}`);
  assert.match(n.variants.zh, /^⚠️ 换 MCP 配置「web」失败（ssh died），仍用原来的 MCP 配置/);
  assert.equal(n.text, n.variants.zh);
});

test('ChatArea 接线：✗ 旁有「切换失败」短文字、点它关掉；失败时发状态行提示；连上时调 clearErrOnReady', () => {
  const C = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf8');
  const mark = C.slice(C.indexOf('className="composer-engine-err"') - 200, C.indexOf('className="composer-engine-err"') + 600);
  assert.match(mark, /dismissErr\(m, sid\)/, '点 ✗ 要能关掉');
  assert.match(mark, /t\('Switch failed'\)/, '✗ 旁要有短文字');
  assert.match(C, /noteSessionLocally\(sid, n\.text, n\.variants\)/, '失败时在会话状态行说一句');
  assert.match(C, /kiroApi\.switchMcpCombo\(sid, comboId\),[\s\S]{0,400}describeSwitchFailure\(sid, 'combo'\)\);/);
  assert.match(C, /clearErrOnReady\(m, prev, next\)/);
  /* 每条会话自己的「连上且挂好」从 App 传进来，不是只看这一格当前那条 */
  const A = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
  assert.match(A, /readySessionIds=\{/);
});
