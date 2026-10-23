import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { composerRunning, enterRoute } from '../src/renderer/steerRoute.ts';

/*
 * 控制入口的 send 必须和你在输入框按 Enter **走同一套路由** —— 不另写一套。
 * 这里钉两件事：判据本身（`enterRoute` / `composerRunning`），以及接线：
 * 输入框的 isStreaming 和控制入口用的是同一个判据、控制入口最后调的是 Enter 那几个 handler。
 */

const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const occupied = (busy?: string | null) => !!busy && ['turn', 'reconfiguring', 'attaching', 'priming', 'prime-pending'].includes(busy);
const route = (s: { streaming?: boolean; busy?: string | null; looping?: boolean; next?: boolean }) =>
  enterRoute({ streaming: !!s.streaming, busy: s.busy, occupied: occupied(s.busy), looping: !!s.looping, next: s.next });

describe('Enter 路由（控制入口复用）', () => {
  test('空闲 → 发', () => {
    assert.equal(route({}), 'send');
  });

  test('这一轮在跑（渲染端知道，或者只有主进程知道）→ 追加指令', () => {
    assert.equal(route({ streaming: true }), 'steer');
    assert.equal(route({ busy: 'turn' }), 'steer');
  });

  test('重建历史中 → 也走 steer 那条（steer 里再停到「重建后发送」，和输入框一样）', () => {
    assert.equal(route({ busy: 'priming' }), 'steer');
    assert.equal(route({ busy: 'prime-pending' }), 'steer');
  });

  test('后端被占着但不是在跑一轮（换模型 / 正在连接）→ 排队（handleSendMessage 的那条分流）', () => {
    assert.equal(route({ busy: 'reconfiguring' }), 'queue');
    assert.equal(route({ busy: 'attaching' }), 'queue');
  });

  test("mode:'next' = ⌘/Ctrl+Enter：不管忙不忙都进排队", () => {
    assert.equal(route({ next: true }), 'queue');
    assert.equal(route({ streaming: true, next: true }), 'queue');
  });

  test('循环占着会话 → 不发（Enter 在循环里也什么都不做）', () => {
    assert.equal(route({ looping: true }), 'blocked');
    assert.equal(route({ looping: true, next: true }), 'blocked');
  });

  test('composerRunning：streaming / turn / 重建历史', () => {
    assert.equal(composerRunning(false, null), false);
    assert.equal(composerRunning(false, 'attaching'), false);
    assert.equal(composerRunning(true, null), true);
    assert.equal(composerRunning(false, 'turn'), true);
    assert.equal(composerRunning(false, 'priming'), true);
  });
});

describe('接线：控制入口走 Enter 的同一套 handler', () => {
  const app = read('renderer', 'App.tsx');

  test('输入框的 isStreaming 用的就是 composerRunning', () => {
    assert.match(app, /isStreaming=\{!!sid && composerRunning\(streamingIds\.includes\(sid\), busyBySession\[sid\]\)\}/);
  });

  test('handleControlSend：enterRoute 决定，再调 handleSteerMessage / handleQueueMessage / sendNowOrNext', () => {
    const at = app.indexOf('const handleControlSend = useCallback(');
    assert.ok(at > 0);
    const body = app.slice(at, at + 2500);
    assert.match(body, /enterRoute\(\{/);
    assert.match(body, /handleSteerMessage\(req\.text, undefined, sid, ctl\)/);
    assert.match(body, /handleQueueMessage\(req\.text, undefined, sid, ctl\)/);
    assert.match(body, /sendNowOrNext\(sid, req\.text, \[\], undefined, ctl\)/);
    // 界面里还没有这条 → ui-not-ready，不绕过界面
    assert.match(body, /error: 'ui-not-ready'/);
  });

  test('steer 「这一轮已结束」那条和控制入口空闲发送共用 sendNowOrNext', () => {
    const at = app.indexOf('const handleSteerMessage = useCallback(');
    const body = app.slice(at, app.indexOf('const handleQueueMessage = useCallback('));
    assert.match(body, /await sendNowOrNext\(sessionId, content, attachments/);
    // 控制入口来的不抢焦点、不带走输入框附件
    assert.match(body, /if \(!ctl\) await focusSession\(steerSid\)/);
    assert.match(body, /const attachments = ctl \? \[\] : \[\.\.\.attachedFor\(sessionId\)\]/);
    // 失败照样标红等你选（addFailedSteer），不转排队
    assert.match(body, /addFailedSteer\(sessionId, content, attachments, res\.reason/);
  });

  test('排队卡片发出时，控制入口排进来的那张照样带标记', () => {
    /* messageId 跟着排队条目走（`pickQueuedBatch` → `queuedBatchMessageId`）：条目带标记，发出去的 id 也带（queueRetry.test.ts 守着） */
    assert.match(app, /messageId: picked\.messageId,/);
  });

  test('换 id 的路径都带着标记：轮末没被吃的追加指令、启动时恢复的追加指令、失败后「作为下一条发送」、自动重发', () => {
    const at = (anchor: string) => { const i = app.indexOf(anchor); assert.ok(i > 0, anchor); return app.slice(i, i + 1500); };
    // 轮末放回队头 + 启动时恢复：两处都是 orphans / leftover 的 map
    assert.equal((app.match(/id: carryControlMark\(s\.msgId, 'queue'\) \?\? `queue_/g) || []).length, 2);
    assert.match(at('const orphanSteersTakenRef = useRef(false);'), /carryControlMark\(s\.msgId, 'queue'\)/);
    assert.match(at('const leftover = takeUnconsumedSteers(fid);'), /carryControlMark\(s\.msgId, 'queue'\)/);
    assert.match(at('const handleFailedSteer = useCallback('), /id: carryControlMark\(msgId, 'queue'\) \?\? `queue_/);
    const acp = read('renderer', 'hooks', 'useAcp.ts');
    // 落盘的待确认 steer 带着 id（启动时才认得出来）
    assert.match(acp, /attachments: s\.attachments \|\| \[\], msgId: s\.msgId \}\)\);/);
    // 自动重发：要求带标记，重跑那边按被重发的那条算新 id，交给 sendMessage
    assert.match(acp, /await rerunFromMessageRef\.current\?\.\(target\.id, resendText, \{ carryMark: true \}, sid\);/);
    assert.match(acp, /const carried = override\?\.carryMark \? carryControlMark\(target\.id, 'user'\) : undefined;/);
    assert.match(acp, /\.\.\.\(carried \? \{ messageId: carried \} : \{\}\)/);
    assert.match(acp, /const userMessageId = display\?\.messageId \|\| `user_/);
  });

  test('整份重写 transcript 时显式来源 via 不丢（渲染层 + 主进程兜底）', () => {
    const acp = read('renderer', 'hooks', 'useAcp.ts');
    const fn = acp.slice(acp.indexOf('function toStoredTranscript'), acp.indexOf('function noticeForStopReason'));
    assert.match(fn, /\.\.\.viaFor\(m\.id\),/);
    const main = read('main', 'index.ts');
    const rw = main.slice(main.indexOf("ipcMain.handle('acp:rewrite-transcript'"), main.indexOf("ipcMain.handle('acp:rewrite-transcript'") + 2500);
    assert.match(rw, /isControlMessageId\(m\?\.id\) \? \{ via: 'control' as const \}/);
  });

  test('气泡上的「经控制入口发送」标签', () => {
    const chat = read('renderer', 'components', 'ChatArea.tsx');
    assert.match(chat, /isControlMessageId\(bubble\.id\) && controlTag/);
    assert.match(chat, /t\('Sent via control entry'\)/);
  });

  test('主进程：落盘时记 via:control；send 先交给界面（control:send），界面没就绪 503', () => {
    const main = read('main', 'index.ts');
    assert.match(main, /isControlMessageId\(userMessageId\) \? \{ via: 'control' as const \}/);
    assert.match(main, /isControlMessageId\(messageId\) \? \{ via: 'control' as const \}/);
    const at = main.indexOf('const controlSessionAccess: ControlSessionAccess = {');
    const body = main.slice(at, at + 4000);
    assert.match(body, /enabled: \(\) => isFeatureEnabled\('controlSessionAccess'\)/);
    // 交给界面的那一段抽成了 forwardToUi（会话间的 session_send 也用它）：控制入口按 'ctl' 标记交过去
    assert.match(body, /return forwardToUi\(id, text, mode, 'ctl'\);/);
    const fwd = main.slice(main.indexOf('function forwardToUi('), main.indexOf('function forwardToUi(') + 1500);
    assert.match(fwd, /error: 'ui-not-ready'/);
    assert.match(fwd, /wc\.send\('control:send', \{ reqId, sessionId: id, text, mode, origin \}\)/);
    // advanced 的会话不碰
    assert.match(main, /return rec && !isAdvancedOnly\(rec\) \? rec : null;/);
    // 开关默认关
    assert.match(main, /controlSessionAccess: false,/);
  });
});

describe('来源标记跟着消息走（纯函数）', () => {
  test('carryControlMark：原来带标记 → 新 id 也带；普通 id → undefined', async () => {
    const { carryControlMark, isControlMessageId, controlMessageId } = await import('../src/main/controlSessions.ts');
    const fromCtl = carryControlMark(controlMessageId('steer'), 'queue');
    assert.ok(fromCtl && fromCtl.startsWith('queue_ctl_') && isControlMessageId(fromCtl));
    assert.ok(carryControlMark(controlMessageId('queue'), 'user')!.startsWith('user_ctl_'));
    assert.equal(carryControlMark('steer_1792_abc', 'queue'), undefined);
    assert.equal(carryControlMark(undefined, 'user'), undefined);
  });

  test('toStoredUserLines：拆回追加指令事件时，经控制入口的那段带 via:control；普通的不带；读回来再写一遍不变', async () => {
    const { toStoredUserLines } = await import('../src/renderer/steerSplit.ts');
    const { controlMessageId, viaFor } = await import('../src/main/controlSessions.ts');
    const baseId = controlMessageId('user');
    const ctlSteer = controlMessageId('steer');
    const msg = {
      id: baseId, role: 'user', content: '原话\n人追加\n工具追加', ts: 1, ...viaFor(baseId),
      steerParts: [{ id: 'steer_1_x', content: '人追加', ts: 2 }, { id: ctlSteer, content: '工具追加', ts: 3 }],
    };
    const lines = toStoredUserLines(msg) as any[];
    assert.equal(lines.length, 3);
    assert.equal(lines[0].via, 'control');
    assert.equal(lines[0].content, '原话');
    assert.equal(lines[1].via, undefined);
    assert.equal(lines[2].via, 'control');
    assert.equal(lines[2].mergeIntoMessageId, baseId);
    // 普通消息完全不受影响
    const plain = toStoredUserLines({ id: 'user_1_y', role: 'user', content: 'hi', ts: 1 }) as any[];
    assert.deepEqual(plain, [{ id: 'user_1_y', role: 'user', content: 'hi', ts: 1 }]);
  });
});

describe('空闲时发送失败 → 标红 → 「作为下一条发送」：一路都带着来源', () => {
  test('接线：sendNowOrNext 失败时 addFailedSteer 拿到带标记的 id', () => {
    const app = read('renderer', 'App.tsx');
    const at = app.indexOf('const sendNowOrNext = useCallback(');
    const body = app.slice(at, app.indexOf('const handleSteerMessage = useCallback('));
    // 来源标记跟着 ctl.origin 走（控制入口 = ctl，别的会话 = xs）
    assert.match(body, /const messageId = ctl \? controlMessageId\('user', undefined, ctl\.origin\) : undefined;/);
    assert.match(body, /addFailedSteer\(sessionId, content, attachments, String\(error\?\.message \|\| error \|\| ''\), carryControlMark\(messageId, 'steer'\)\);/);
    // 「作为下一条发送」按失败那条的 id 带过去，排空时按卡片 id 给出带标记的用户消息 id，主进程据此写 via
    assert.match(app, /id: carryControlMark\(msgId, 'queue'\) \?\? `queue_/);
    assert.match(app, /messageId: picked\.messageId,/);
  });

  test('标记一路传下去：用户消息 → 失败的追加指令 → 排队卡片 → 再发出的用户消息；普通发送一路都不带', async () => {
    const { carryControlMark, controlMessageId, isControlMessageId, viaFor } = await import('../src/main/controlSessions.ts');
    const sent = controlMessageId('user');
    const failed = carryControlMark(sent, 'steer');
    assert.ok(failed?.startsWith('steer_ctl_'));
    const card = carryControlMark(failed, 'queue');
    assert.ok(card?.startsWith('queue_ctl_'));
    const resent = isControlMessageId(card) ? controlMessageId('user') : 'user_plain';
    assert.deepEqual(viaFor(resent), { via: 'control' });
    // 普通（不是控制入口）的发送：没有 messageId → 失败那条用普通 id → 卡片普通 → 不带 via
    assert.equal(carryControlMark(undefined, 'steer'), undefined);
    assert.equal(carryControlMark('steer_failed_1_x', 'queue'), undefined);
    assert.deepEqual(viaFor('user_1_x'), {});
  });
});
