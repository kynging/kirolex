import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 忙时普通 Enter **永远 steer 当前这一轮**，不悄悄变成排队 —— 接线测试（判据本身在 tests/steerRoute.test.ts）。
 *
 * 实测（`s_1789629414597_kqrsee`）：会话在跑一个 120 秒的 `local_bash`，同一轮前面三次 steer 都成功，第四次 Enter
 * 却进了 `kirolex-queues`，卡片里两段粘贴还是 `[ 粘贴 #1 · 81 行 ]` 占位符。
 *
 * 根因：
 *   1. 输入框是把粘贴块交出来了的（`onSteer(text, pastes)`），但 ChatArea 的 `onSteerMessage` 只收 `text`，
 *      App 那头写死 `handleSteerMessage(text, undefined, sid)` —— **粘贴块在这里被丢了**。于是 steer 出去的、
 *      或者被转进队列的，都是占位符原文（模型看到的也是占位符）。
 *   2. `handleSteerMessage` 有四条路把 Enter 静默转成排队：队列非空 → 并进队尾、带附件 → 排队、重建历史中 → 排队、
 *      steer 失败 → 放队头。第 3 条读的 `busyBySession` 还是 useCallback 闭包里的旧值（依赖里没有它，中间又 await 过）。
 * 现在：四条路都没了；粘贴块一路带到 steer；忙碌状态从 ref 读。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
const APP = read('renderer', 'App.tsx');
const CHAT = read('renderer', 'components', 'ChatArea.tsx');
const ACP = read('renderer', 'hooks', 'useAcp.ts');

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const slice = (src: string, anchor: string, endMark = '\n  }, [') => {
  const at = src.indexOf(anchor);
  assert.ok(at > 0, `找不到 ${anchor}`);
  const rest = src.slice(at);
  return rest.slice(0, rest.indexOf(endMark));
};
const steer = stripComments(slice(APP, 'const handleSteerMessage = useCallback'));

describe('用户这次的根因：粘贴块在 ChatArea → App 这一跳被丢了', () => {
  test('输入框忙时 Enter 把粘贴块交给 onSteer', () => {
    assert.match(CHAT, /if \(isStreaming\) onSteer\(text, pastes\);/);
  });

  test('ChatArea 的 onSteerMessage 接收粘贴块', () => {
    assert.match(CHAT, /onSteerMessage: \(text: string, pastes\?: PastedBlock\[\]\) => void;/);
    assert.doesNotMatch(CHAT, /onSteerMessage: \(text: string\) => void;/);
  });

  test('App 把粘贴块原样传给 handleSteerMessage（不再写死 undefined）', () => {
    assert.match(APP, /onSteerMessage=\{\(text, pastes\) => \{ void handleSteerMessage\(text, pastes, sid \|\| undefined\); \}\}/);
    assert.doesNotMatch(APP, /handleSteerMessage\(text, undefined,/);
  });

  test('handleSteerMessage 先展开粘贴再 steer', () => {
    assert.match(steer, /if \(pastes\?\.length\) text = expandPastes\(text, pastes\);/);
  });

  test('另一个入口（输入框以为空闲、但主进程说在跑一轮）也带着粘贴块走 steer', () => {
    assert.match(APP, /busyBySession\[sid\] === 'turn'\) \{\s*\n\s*void handleSteerMessageRef\.current\?\.\(text, pastes, sid\);/);
  });

  test('忙碌状态从 ref 读：回调里 await 过 focusSession，闭包里的值会过期', () => {
    assert.match(steer, /busyEnterRoute\(\{ busy: busyBySessionRef\.current\[sessionId\] \}\)/);
    assert.doesNotMatch(steer, /busyBySession\[sessionId\]/);
  });
});

describe('队列非空也 steer 当前这一轮', () => {
  test('不再读队列、不再并进队尾', () => {
    assert.doesNotMatch(steer, /queuesBySessionRef/);
    assert.doesNotMatch(steer, /tailId/);
    assert.doesNotMatch(steer, /\.map\(\(item\) =>/);
  });

  test('输入框的发送按钮在「忙 + 队列非空」时也是 steer，不是「追加到最后一条排队」', () => {
    assert.doesNotMatch(CHAT, /isStreaming && queuedMessages\.length > 0\s*\n\s*\? t\('Append to the last queued message/);
    assert.doesNotMatch(CHAT, /IconAppendMessage/);
    assert.doesNotMatch(CHAT, /queueModifierHeld \|\| \(isStreaming && queuedMessages\.length > 0\)/);
  });

  test('⌘/Ctrl+Enter 仍然排队（不变）', () => {
    assert.match(CHAT, /if \(e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*handleQueue\(\);/);
  });
});

describe('带附件也 steer：附件按本机路径写进 steer 文字', () => {
  test('steer 带着附件和 steerPayload 生成的文字', () => {
    assert.match(steer, /steerMessage\(content, sessionId, \{ attachments, sendText: steerPayload\(content, attachments\) \}\)/);
  });

  test('没有「带附件就排队」那条路了', () => {
    assert.doesNotMatch(steer, /if \(attachments\.length > 0\) \{/);
  });

  test('useAcp 写给模型的是 sendText，气泡里显示的是原文 + 附件', () => {
    const fn = slice(ACP, 'const steerMessage = useCallback');
    // let：随后换成主进程会真正写出去的那份（大图路径换成缩小副本，见 tests/steerConsumeMatch.test.ts）
    assert.match(fn, /let sent = \(opts\?\.sendText \?\? text\)\.trim\(\);/);
    assert.match(fn, /window\.kiroApi\.steer\(sid, sent\)/);
    assert.match(fn, /\.\.\.\(attachments\.length \? \{ attachments \} : \{\}\)/);
  });

  test('被吃掉的确认按真正写出去的文字对账（带附件时它和显示的不一样）', () => {
    // 对账挪进了 steerPending.matchConsumedSteers（行为测试在 tests/steerConsumeMatch.test.ts）
    assert.match(ACP, /const consumedIds = matchConsumedSteers\(list, snapshot\);/);
    const PENDING = read('renderer', 'steerPending.ts');
    assert.match(PENDING, /steerMatchKey\(item\.sent \?\? item\.content\) === block/);
  });
});

describe('带附件的 steer 被吃掉后，附件跟着落盘', () => {
  // sessionStore.ts 在 node --test 下不能直接加载（见 clearWatermark.test.ts），所以读源码。
  const STORE = read('main', 'sessionStore.ts');
  const MAIN = read('main', 'index.ts');
  const PRELOAD = read('main', 'preload.ts');

  test('persistSteer 带附件过桥', () => {
    assert.match(PRELOAD, /ipcRenderer\.invoke\('acp:persist-steer', sessionId, text, messageId, attachments\)/);
    assert.match(ACP, /persistSteer\?\.\(targetSid, item\.content, item\.msgId, item\.attachments\?\.length \? item\.attachments : undefined\)/);
  });

  test('主进程把附件写进那条合并事件；只有附件、没有文字也接受', () => {
    const h = slice(MAIN, "ipcMain.handle('acp:persist-steer'", '\n  });');
    assert.match(h, /if \(!sessionId \|\| \(!text && !files\.length\)\) return/);
    assert.match(h, /\.\.\.\(files\.length \? \{ attachments: files \} : \{\}\)/);
  });

  test('读记录时合并事件的附件并到这一轮的用户消息上（以前只并文字）', () => {
    const raw = slice(STORE, 'function readTranscriptRaw', '\n}');
    assert.match(raw, /if \(message\.attachments\?\.length\) target\.attachments = \[\.\.\.\(target\.attachments \|\| \[\]\), \.\.\.message\.attachments\];/);
  });
});

describe('steer 失败：标红 + 两个按钮，不进队列', () => {
  test('按 steerFailureRoute 分流；其余原因交给 addFailedSteer', () => {
    assert.match(steer, /const route = steerFailureRoute\(res\.reason\);/);
    assert.match(steer, /addFailedSteer\(sessionId, content, attachments, res\.reason\);/);
  });

  test('失败那条路不碰队列（只有「这一轮已结束、另一条正在发」时排到它后面）', () => {
    const afterSteer = steer.slice(steer.indexOf('const res = await steerMessage'));
    const ask = afterSteer.slice(afterSteer.lastIndexOf('addFailedSteer(sessionId, content, attachments, res.reason)') - 200);
    assert.doesNotMatch(ask, /setQueuesBySession/);
  });

  test('useAcp 把失败的 steer 标成 failed、带原因，并落盘（用户选之前重启也不丢）', () => {
    const fn = slice(ACP, 'const addFailedSteer = useCallback');
    assert.match(fn, /const record: FailedSteer = \{ msgId, content, attachments, reason, ts: Date\.now\(\), \.\.\.\(baseId \? \{ baseId \} : \{\}\) \};/);
    assert.match(fn, /const msg = failedSteerMessage\(record\);/);
    const make = ACP.slice(ACP.indexOf('function failedSteerMessage'));
    assert.match(make, /steer: 'failed', steerError: f\.reason \|\| 'unknown'/);
    assert.match(fn, /saveFailedSteers\(\)/);
  });

  test('气泡上标红「没能追加到这一轮：<原因>」+「作为下一条发送」「放回输入框」', () => {
    assert.match(CHAT, /t\('Could not add this to the current turn: \{reason\}'/);
    assert.match(CHAT, /onFailedSteer\?\.\(steer\.id, 'send-next'\)/);
    assert.match(CHAT, /onFailedSteer\?\.\(steer\.id, 'restore'\)/);
    assert.match(APP, /onFailedSteer=\{\(msgId, action\) => handleFailedSteer\(msgId, action, sid \|\| undefined\)\}/);
  });

  test('两个按钮：放回输入框 = 文字和附件回到这一格；作为下一条 = 队列最前面', () => {
    const fn = stripComments(slice(APP, 'const handleFailedSteer = useCallback'));
    assert.match(fn, /const sid = paneSid \|\| currentSessionId;/);
    assert.match(fn, /addAttachments\(sid, hit\.attachments\);\s*\n\s*setRestoredQueueDraft\(\{ id: Date\.now\(\), text: hit\.content, sessionId: sid \}\);/);
    assert.match(fn, /\[sid\]: \[\.\.\.queue\.slice\(0, at\), item, \.\.\.queue\.slice\(at\)\]/);
  });

  test('没能追加的 steer 模型没见过，不写进记录', () => {
    assert.match(ACP, /\.filter\(\(m\) => m\.steer !== 'failed'\)/);
  });
});

describe('这一轮已经结束：直接作为新消息发出，并在状态行说一声', () => {
  test('send-now → sendQueuedMessage + noteSessionLocally', () => {
    const block = steer.slice(steer.indexOf("if (route === 'send-now')"));
    assert.match(block, /noteSessionLocally\(sessionId, tRef\.current\('This turn had already ended/);
    assert.match(block, /await sendQueuedMessage\(sessionId, content, attachments, pastes\?\.length \? \{ displayText: shown, pastes \} : undefined\);/);
    // 和排空互斥：同一会话不能同时发两条
    assert.match(block, /queueSendingRef\.current\.add\(sessionId\);/);
    assert.match(block, /queueSendingRef\.current\.delete\(sessionId\);/);
  });
});

describe('重建历史期间：标「重建历史中，结束后发送」，结束后立刻作为下一条发出', () => {
  test('进的是 afterRebuild 条目，排在普通排队之前', () => {
    assert.match(steer, /withAfterRebuild\(prev\[sessionId\] \|\| \[\], \{[\s\S]*?afterRebuild: true,/);
    assert.match(steer, /if \(route === 'after-rebuild'\) \{ parkUntilRebuilt\(\); return; \}/);
  });

  test('排空：照样等重建结束（isBackendOccupied 含 priming），而且这条单独发、不和后面的合并', () => {
    assert.match(APP, /settings\.mergeQueuedMessages && !queue\[0\]\.afterRebuild/);
  });

  test('界面上不显示成普通排队卡片，而是单独一条带标记', () => {
    assert.match(CHAT, /queuedMessages\.filter\(\(item\) => !item\.afterRebuild\)/);
    assert.match(CHAT, /<QueueStack\s*\n\s*queuedMessages=\{plainQueue\}/);
    assert.match(CHAT, /t\('Rebuilding history — sends when it finishes'\)/);
  });

  test('普通卡片不能和它们换位置', () => {
    assert.match(APP, /if \(queue\[from\]\.afterRebuild \|\| queue\[to\]\.afterRebuild\) return prev;/);
  });
});

describe('不变的规则', () => {
  test('loop 会话仍然不接受 steer', () => {
    assert.match(steer, /if \(steerSid && loopingIds\.includes\(steerSid\)\) return;/);
  });

  test('轮末没被吃的 steer 仍然回队头（原文 + 附件，不是带引用块的那份）', () => {
    const fn = slice(ACP, 'const takeUnconsumedSteers = useCallback');
    assert.match(fn, /return list\.map\(\(s\) => \(\{ content: s\.content, attachments: s\.attachments \}\)\);/);
  });

  test('停止时丢弃未消费 steer 的逻辑没动', () => {
    assert.match(APP, /discardUnconsumedSteers\(\);/);
  });
});
