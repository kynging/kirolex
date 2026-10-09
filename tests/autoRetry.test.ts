import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decideTurnRecovery } from '../src/renderer/turnRecovery.ts';

/**
 * 「因为非人工原因中断的会话你应该加自动重试发送，重试次数默认是 10 可以在 setting 中调整。另外我发现
 *  一个很严重的 bug 那就是 steer 的内容和 queue 似乎不会被重试、rerun 或者恢复」。
 *
 * 这个 hook 依赖 React 和 window，跑不进 node:test，所以纯逻辑测到 `decideTurnRecovery`，
 * 接线按源码钉住：每一条对应一处实测会丢东西的地方。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf-8');
const HK = read('src', 'renderer', 'hooks', 'useAcp.ts');
const APP = read('src', 'renderer', 'App.tsx');
const SD = read('src', 'renderer', 'components', 'SettingsDialog.tsx');

describe('重试次数：默认 10，设置里可调，0 = 不重发', () => {
  test('默认值和读法', () => {
    assert.match(HK, /const AUTO_RESEND_MAX_ATTEMPTS = 10;/);
    assert.match(HK, /JSON\.parse\(raw\)\?\.autoRetryMax/);
    assert.match(HK, /maxAttempts: autoRetryMax\(\),/);
    assert.match(HK, /resendDisabled: resendDisabled \|\| autoRetryMax\(\) === 0,/);
    assert.match(APP, /autoRetryMax: 10,/);
    assert.match(SD, /自动重试次数（非人为中断）/);
  });

  test('预算用完就停（第 10 次之后不再发）', () => {
    const base = { peek: null, busyReason: null, streaming: false, cancelled: false, resendDisabled: false, maxAttempts: 10 };
    assert.equal(decideTurnRecovery({ ...base, attempts: 9 } as any).action, 'resend');
    assert.equal(decideTurnRecovery({ ...base, attempts: 10 } as any).action, 'stand-down');
    assert.equal(decideTurnRecovery({ ...base, attempts: 0, cancelled: true } as any).action, 'stand-down', '你按了停止就不重发');
  });

  test('次数按基础那条的第一行记（重发会换 id、重启会把 steer 并进全文 —— 按这两样算次数会清零）', () => {
    assert.match(HK, /const key = autoResendKey\(target\.content\.split\('\\n'\)\[0\]\);/);
  });
});

describe('非人为中断会自动重发', () => {
  test('执行器中途死了：不是你停的就等重连后重发这一轮（哪怕吐了半截）', () => {
    assert.match(HK, /const autoRecover = wasStreaming && !recoveryCancelledRef\.current\.has\(sid\)/);
    assert.match(HK, /recoverInterruptedTurn\(sid, messagesCacheRef\.current\.get\(sid\) \|\| \[\], \{ assumeCurrent: true, interrupted: true \}\);/);
    assert.match(HK, /if \(opts\?\.interrupted\) while \(i >= 0 && msgs\[i\]\.role === 'assistant'\) i--;/);
    /* 重连都没成才退回老路（标成被打断、问题放回输入框） */
    assert.match(HK, /if \(autoRecover\) markTurnInterrupted\(sid\);/);
  });

  test('你按的停止（Stop 按钮和 /stop）不重发；你再发一条之后才重新允许', () => {
    assert.match(APP, /for \(const id of new Set\(\[\.\.\.streamingIds, \.\.\.\(currentSessionId \? \[currentSessionId\] : \[\]\)\]\)\) cancelAutoResend\(id\);/);
    assert.match(HK, /recoveryCancelledRef\.current\.delete\(sid!\);/);
    assert.match(HK, /if \(recoveryCancelledRef\.current\.has\(sid!\)\) throw err;/, '重连重发那条路也认停止');
  });
});

describe('steer 和队列不再丢', () => {
  test('重发 / 塞回输入框都带上这一轮已经吃进去的 steer', () => {
    assert.match(HK, /export function withConsumedSteers\(msgs: Message\[\], baseIndex: number\): string/);
    assert.match(HK, /const resendText = withConsumedSteers\(msgs, base\);/);
    assert.match(HK, /await rerunFromMessageRef\.current\?\.\(target\.id, resendText, undefined, sid\);/);
    assert.match(HK, /const text = withConsumedSteers\(msgs, idx\);/);
  });

  test('重发期间队列不发（否则排着的那条会把没答的问题顶掉），结束后再发', () => {
    assert.match(APP, /recoveringIds\.includes\(sessionId\) \|\|/);
    assert.match(APP, /\s+recoveringIds,\n  \]\);/, 'drain 的依赖里要有它，否则重发完队列不会动');
    assert.match(HK, /markRecovering\(sid, true\);/);
  });

  test('重跑不再扔掉还没被吃的 steer（轮末会把它们放回队列）', () => {
    const at = HK.indexOf('const rerunFromMessage = useCallback');
    const body = HK.slice(at, at + 4500);
    assert.doesNotMatch(body, /pendingSteersRef\.current\.delete\(sid\);/);
  });

  test('没被吃的 steer 落盘，重启后作为排队消息回到各自会话', () => {
    assert.match(HK, /class PersistedSteerMap extends Map/);
    assert.match(HK, /new PersistedSteerMap\(\)/);
    assert.match(HK, /uiGet\(PENDING_STEERS_KEY\)/);
    assert.match(APP, /const orphans = takeOrphanSteers\(\);/);
  });
});

describe('静默太久被中断、但已有产出的那一轮：自动续写', () => {
  const H = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');
  test('发"接着做"，不重发原问题；次数受「自动重试次数」管', () => {
    assert.match(H, /export const WEDGE_CONTINUE_PROMPT = /);
    assert.match(H, /if \(!resendOff && max > 0 && done < max\) \{/);
    assert.match(H, /await sendMessageRef\.current\(\[\{ type: 'text', text: WEDGE_CONTINUE_PROMPT \}\], undefined, undefined, undefined, undefined, sid\);/);
  });
  test('续写不走 markTurnInterrupted（否则下一次发送会把已有产出覆盖掉）；用完次数才退回老路', () => {
    const at = H.indexOf('if (!resendOff && max > 0 && done < max) {');
    const block = H.slice(at, at + 900);
    assert.match(block, /return;\n {10}\}\n {10}markTurnInterrupted\(sid\);/);
  });
  test('人自己发一条就清零；自动续写那条不清零', () => {
    assert.match(H, /if \(autoContinueInFlightRef\.current\.has\(sid\)\) autoContinueInFlightRef\.current\.delete\(sid\); else wedgeContinuesRef\.current\.delete\(sid\);/);
  });
});

describe('Claude Code 的工具调用：标题在后面的 tool_call_update 里', () => {
  const H = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');
  test('update 带了标题就换上；不带 status 时不把 status 抹成空；第一条就是 update 也建一条', () => {
    const at = H.indexOf("case 'tool_call_update': {");
    const body = H.slice(at, at + 2600);
    assert.ok(body.includes("if (typeof update.title === 'string' && update.title.trim()) existing.title = update.title;"));
    assert.ok(body.includes('if (update.status) existing.status = update.status;'));
    assert.ok(!body.includes('            existing.status = update.status;\n            if (update.kind)'), '不再无条件覆盖 status');
    assert.ok(body.includes("?? (update.toolCallId ? { toolCallId: update.toolCallId, title: update.title || 'Tool call'"));
  });
});
