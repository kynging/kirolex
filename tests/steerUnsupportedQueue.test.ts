import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Claude Code / Codex 会话忙时按 Enter 提示「不支持追加」—— 接线测试（判据本身在 tests/steerRoute.test.ts）。
 *
 * `_session/steer` 是 kiro-cli 的扩展，那两家的适配器没有（主进程 `supportsSteer` 只对 kiro 为真）。以前渲染端
 * 不看引擎一律先 steer，主进程回 'unsupported'，消息标红让用户选。现在：引擎能力传进路由函数，不能 steer 就直接排队；
 * 万一还是回了 'unsupported'（引擎状态没同步），也排队。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
const APP = read('renderer', 'App.tsx');
const CHAT = read('renderer', 'components', 'ChatArea.tsx');

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const between = (src: string, from: string, to: string) => {
  const at = src.indexOf(from);
  assert.ok(at > 0, `找不到 ${from}`);
  return src.slice(at, src.indexOf(to, at));
};
const steer = stripComments(between(APP, 'const handleSteerMessage = useCallback', 'const handleQueueMessage = useCallback'));
const control = stripComments(between(APP, 'const handleControlSend = useCallback', 'const controlSendRef = useRef'));

describe('输入框按 Enter（handleSteerMessage）', () => {
  test('引擎能力从会话的 engine 算，传进 busyEnterRoute', () => {
    assert.match(steer, /const canSteer = engineCanSteer\(sessions\.find\(\(s\) => s\.id === sessionId\)\?\.engine\);/);
    assert.match(steer, /busyEnterRoute\(\{ busy: busyBySessionRef\.current\[sessionId\], canSteer \}\)/);
  });

  test("'queue' → 排队，不先发 acp:steer", () => {
    const routeAt = steer.indexOf("if (busyRoute === 'queue') { queueAsNext(); return; }");
    assert.ok(routeAt > 0);
    assert.ok(routeAt < steer.indexOf('await steerMessage('), '排队判断必须在 steerMessage 之前');
  });

  test("steer 回 'unsupported' 的兜底 → 同一个排队，不标红", () => {
    assert.match(steer, /if \(route === 'queue'\) \{ queueAsNext\(\); return; \}/);
  });

  test('排队那张卡和 ⌘/Ctrl+Enter 一样：进队尾，带占位符原文和粘贴块，不带 afterRebuild', () => {
    const fn = between(steer, 'const queueAsNext = () =>', '\n    };');
    assert.match(fn, /\[\.\.\.\(prev\[sessionId\] \|\| \[\]\), \{/);
    assert.match(fn, /content: pastes\?\.length \? shown : content,/);
    assert.doesNotMatch(fn, /afterRebuild/);
  });

  test('sessions 在依赖里（引擎是从它读的）', () => {
    assert.match(APP, /\}, \[currentSessionId, sessions, attachedFor, clearAttachments, focusSession, steerMessage,/);
  });

  test('不在 App 里散写 engine === kiro', () => {
    assert.doesNotMatch(steer, /engine === 'kiro'/);
    assert.doesNotMatch(control, /engine === 'kiro'/);
  });
});

describe('控制入口 send（handleControlSend）', () => {
  test('同一个 enterRoute，带上 canSteer', () => {
    assert.match(control, /enterRoute\(\{[\s\S]*canSteer: engineCanSteer\(session\.engine\),[\s\S]*\}\)/);
  });
});

describe('输入框文案：Claude Code / Codex 忙时说排队', () => {
  test('ChatArea 把引擎能力交给输入框', () => {
    assert.match(CHAT, /canSteer=\{engineCanSteer\(engine\)\}/);
  });

  test('占位提示 / 快捷键提示 / 按钮提示都有不能 steer 的分支，kiro 原文案不变', () => {
    assert.match(CHAT, /isStreaming && !canSteer\s*\n\s*\? t\('Agent is working — Enter queues it to send after this turn'\)/);
    assert.match(CHAT, /isStreaming && !canSteer\s*\n\s*\? t\('Enter queue \(sends after this turn\) · Shift\+Enter newline'\)/);
    assert.match(CHAT, /isStreaming && !canSteer\s*\n\s*\? t\('Queue to send after this turn \(Enter\)'\)/);
    assert.match(CHAT, /t\('Agent is working — Enter steers the running turn · \{key\}\+Enter queues', \{ key: MOD_KEY \}\)/);
    assert.match(CHAT, /t\('Steer the running turn \(Enter\)'\)/);
  });
});
