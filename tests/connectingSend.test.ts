import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { waitsForConnection, queueUntilConnected, draftAfterSessionSwap, queueableMessage, type ConnectingFacts } from '../src/renderer/connectingSend.ts';

/**
 * 「远程会话连接的前半段输入框没法输入」：连接中必须能打字、能回车（先排着，连上就发）。
 * 这里守：
 *   - 连接中按 Enter 进这条会话的队列；连上之后排空队列那一段不再被挡、会发出；
 *   - 斜杠命令和「这一轮在跑」不在这里截（不改 steer / queue 判定）；
 *   - 新会话 sessionId 由空变有值时草稿保留；
 *   - 接线（读源码）：附件 / 排队按钮连接中不再 disabled，App 的 Enter 和排空都用同一个判据，队列上方有「已排队，连上后发送」。
 */
const CONNECTED: ConnectingFacts = { appStatus: 'connected', sessionConnecting: false, startupPending: false };

describe('连接中按 Enter：先排队，连上后发出', () => {
  test('三种「还在连」都算：应用在连后端 / 这条会话在挂执行器 / 新会话还在建', () => {
    assert.equal(waitsForConnection(CONNECTED), false);
    assert.equal(waitsForConnection({ ...CONNECTED, appStatus: 'connecting' }), true);
    assert.equal(waitsForConnection({ ...CONNECTED, sessionConnecting: true }), true);
    assert.equal(waitsForConnection({ ...CONNECTED, startupPending: true }), true);
    /* 断开（没在连）不算 —— 那时发消息照旧按需挂执行器，不会被一直排着 */
    assert.equal(waitsForConnection({ ...CONNECTED, appStatus: 'disconnected' }), false);
  });

  test('连接中 Enter → 进队列；连上（同一条消息、同一个判据）→ 不再挡，排空时发出', () => {
    const connecting = { ...CONNECTED, sessionConnecting: true };
    assert.equal(queueUntilConnected({ ...connecting, text: '先打的这句' }), true, '连接中：进队列');
    /* 排空那一段的判据就是 waitsForConnection：连接中挡住，连上就放行 */
    assert.equal(waitsForConnection(connecting), true, '还在连：排着的不发');
    assert.equal(waitsForConnection(CONNECTED), false, '连上：排着的发出');
    assert.equal(queueUntilConnected({ ...CONNECTED, text: '连上之后打的' }), false, '连上后 Enter 直接发');
  });

  test('斜杠命令不排（/stop 正是连不上时强制重连的出路）；这一轮在跑时交给 steer 那条路', () => {
    const connecting = { ...CONNECTED, appStatus: 'connecting' as const };
    assert.equal(queueUntilConnected({ ...connecting, text: '/stop' }), false);
    assert.equal(queueUntilConnected({ ...connecting, text: '  /clear' }), false);
    assert.equal(queueUntilConnected({ ...connecting, text: 'hi', busy: 'turn' }), false);
    assert.equal(queueUntilConnected({ ...connecting, text: 'hi', busy: 'attaching' }), true);
  });
});

describe('换会话 id 时的草稿', () => {
  test('sessionId 由空变有值：已输入的草稿保留（原来直接被清空）', () => {
    assert.equal(draftAfterSessionSwap(null, 's_new', '连上之前先打的字', undefined), '连上之前先打的字');
    assert.equal(draftAfterSessionSwap(null, 's_new', '连上之前先打的字', ''), '连上之前先打的字');
  });

  test('新 id 自己也有草稿：两份都留，不丢任何一份', () => {
    assert.equal(draftAfterSessionSwap(null, 's_old', '新打的', '以前存的'), '以前存的\n\n新打的');
    assert.equal(draftAfterSessionSwap(null, 's_old', '一样的', '一样的'), '一样的');
  });

  test('其余照旧：会话之间切换各用各的草稿；换到空就清空；没打字就用新 id 的', () => {
    assert.equal(draftAfterSessionSwap('s_a', 's_b', 'A 的草稿', 'B 的草稿'), 'B 的草稿');
    assert.equal(draftAfterSessionSwap('s_a', 's_b', 'A 的草稿', undefined), '');
    assert.equal(draftAfterSessionSwap('s_a', null, 'A 的草稿', undefined), '');
    assert.equal(draftAfterSessionSwap(null, 's_b', '   ', 'B 的草稿'), 'B 的草稿');
  });
});

describe('接线（读源码）', () => {
  const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '..', p), 'utf8');
  const CHAT = read('src/renderer/components/ChatArea.tsx');
  const APP = read('src/renderer/App.tsx');
  const composer = CHAT.slice(CHAT.indexOf('className="composer-input"'), CHAT.indexOf('composer-send stop" onClick={onStopLoop}'));

  test('输入框只在循环中禁用；附件 / 排队按钮连接中不再 disabled', () => {
    assert.match(composer, /value=\{input\}\s*disabled=\{isLooping\}/);
    const attach = composer.slice(composer.indexOf('onClick={handleFilePick}'), composer.indexOf('<IconPaperclip'));
    assert.match(attach, /disabled=\{isLooping\}/);
    assert.doesNotMatch(attach, /status !== 'connected'/);
    const queue = composer.slice(composer.indexOf('onClick={handleQueue}'), composer.indexOf('<IconQueue />'));
    assert.match(queue, /disabled=\{isLooping\}/);
    assert.doesNotMatch(queue, /status !== 'connected'/);
  });

  test('换 sessionId 时走 draftAfterSessionSwap（previous 为空时把当前文本带到新 id）', () => {
    const swap = CHAT.slice(CHAT.indexOf('const previous = draftSessionRef.current;'));
    assert.match(swap.slice(0, 600), /draftAfterSessionSwap\(previous, sessionId, inputRef\.current, sessionId \? composerDrafts\[sessionId\] : undefined\)/);
  });

  test('App：Enter 连接中进队列、排空连接中等着，用的是同一组事实', () => {
    const send = APP.slice(APP.indexOf('const handleSendMessage = useCallback('));
    assert.match(send.slice(0, 4000), /queueUntilConnected\(\{ \.\.\.connectingFactsFor\(sid\), text, busy: busyBySession\[sid\] \}\)/);
    const drain = APP.slice(APP.indexOf('// Drain every session independently when it becomes idle.'));
    assert.match(drain.slice(0, 3000), /waitsForConnection\(connectingFactsFor\(sessionId\)\)/);
  });

  test('队列上方显示「已排队，连上后发送」（卡片上能取消）', () => {
    assert.match(CHAT, /t\('Queued — sends once connected'\)/);
    assert.match(read('src/renderer/i18nZh/chat.ts'), /'Queued — sends once connected': '已排队，连上后发送'/);
    assert.match(APP, /waitingForConnection=\{!!sid && waitsForConnection\(connectingFactsFor\(sid\)\)\}/);
  });
});

describe('连接中只加了附件、没打字就按 Enter：照样排队，连上后发出（审查意见 3）', () => {
  const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '..', p), 'utf8');
  const APP = read('src/renderer/App.tsx');

  test('只有附件也能进排队；文字和附件都没有才不排', () => {
    assert.equal(queueableMessage('', 1), true);
    assert.equal(queueableMessage('  ', 2), true);
    assert.equal(queueableMessage('hi', 0), true);
    assert.equal(queueableMessage('', 0), false);
    assert.equal(queueableMessage('   ', 0), false);
    /* Enter 那条路：没文字也走连接中排队（斜杠命令才不排） */
    assert.equal(queueUntilConnected({ ...CONNECTED, sessionConnecting: true, text: '' }), true);
  });

  test('接线：handleQueueMessage 按「有文字或带附件」判，附件跟着排队条目走；控制入口发来的不带输入框附件', () => {
    const fn = APP.slice(APP.indexOf('const handleQueueMessage = useCallback('));
    const body = fn.slice(0, fn.indexOf('\n  }, ['));
    assert.match(body, /if \(!queueableMessage\(content, ctl \? 0 : attachedFor\(sessionId\)\.length\)\) return;/);
    assert.doesNotMatch(body, /if \(!content \|\| !sessionId\) return;/, '原来没文字直接 return，附件那条被丢掉');
    assert.match(body, /attachments: ctl \? \[\] : \[\.\.\.attachedFor\(sessionId\)\]/);
    assert.match(body, /if \(!ctl\) clearAttachments\(sessionId\);/);
  });

  test('接线：排空时附件跟着发（没文字时只发附件那一段，不发空文字块）；卡片上显示 📎 数量、能取消', () => {
    const drain = APP.slice(APP.indexOf('// Drain every session independently when it becomes idle.'));
    assert.match(drain.slice(0, 6000), /\.flatMap\(\(item\) => item\.attachments\)/);
    assert.match(drain.slice(0, 8000), /sendQueuedMessage\(sessionId, deliveredContent, attachments, sendOpts\)/);
    const ACP = read('src/renderer/hooks/useAcp.ts');
    const sq = ACP.slice(ACP.indexOf('const sendQueuedMessage = useCallback('));
    assert.match(sq.slice(0, 4000), /if \(text\.trim\(\) \|\| attachments\.length === 0\) prompt\.push\(\{ type: 'text', text \}\);/);
    const CHAT = read('src/renderer/components/ChatArea.tsx');
    assert.match(CHAT, /item\.attachments\.length > 0 && \(\s*<span className="queue-card-attachments">📎 \{item\.attachments\.length\}<\/span>/);
  });
});
