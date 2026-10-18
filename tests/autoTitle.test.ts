import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Auto-naming has now regressed twice, both times the same way: the logic itself was
 * fine, but it was attached to ONE of the three ways a message reaches the backend.
 *
 * Source-structure assertions: this runner has no DOM and no Electron, so these pin
 * WHERE the naming hangs rather than simulating a turn.
 */
const root = path.join(import.meta.dirname, '..');
const acp = fs.readFileSync(path.join(root, 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'App.tsx'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');

describe('a chat names itself no matter how the message was delivered', () => {

  test('naming hangs off the shared turn-end choke point', () => {
    // `finishStreamingTurn` is the one function every delivery path calls in its
    // `finally` -- plain send, queue drain, and the turn a steer merged into -- and its
    // token guard means it fires once per turn.
    const fn = acp.slice(acp.indexOf('const finishStreamingTurn = ('));
    const body = fn.slice(0, fn.indexOf('\n  };'));
    assert.match(body, /maybeAutoTitle\(sid\)/,
      'naming must run at turn end, not inside one particular send function');
  });

  test('exactly one place asks the model for a title', () => {
    // Two call sites is how the paths drifted apart before: one got the retry policy
    // and the other kept a crude truncation.
    const calls = acp.match(/generateTitle\?\.\(/g) || [];
    assert.equal(calls.length, 1, 'title generation must have a single caller');
  });

  test('the queue path does not name the chat itself', () => {
    // It used to set `title: text.slice(0, 40)` the moment a queued message was
    // delivered. That is not a title, and worse: it made the chat stop being called
    // "New Chat", which is the ONLY trigger for real naming -- so any chat whose first
    // message went through the queue was permanently stuck with the truncation.
    assert.doesNotMatch(acp, /title: text\.slice\(0, 40\)/);
    const fn = acp.slice(acp.indexOf('const sendQueuedMessage = useCallback('));
    const body = fn.slice(0, fn.indexOf('\n  }, ['));
    assert.doesNotMatch(body, /setSessions\([^)]*title:/,
      'the queue drain must leave naming to maybeAutoTitle');
  });

  test('the trigger stays "still called New Chat", and truncation is only a last resort', () => {
    const fn = acp.slice(acp.indexOf('const maybeAutoTitle = ('));
    const body = fn.slice(0, fn.indexOf('\n  };'));
    assert.match(body, /\/\^New Chat\\b\/\.test/, 'one trigger: the name is still New Chat');
    // A generation failure must leave the name alone so the next turn can retry.
    assert.match(body, /if \(tries \+ 1 < MAX_TITLE_TRIES\) return;/);
    assert.match(body, /const tries = titleTriesRef\.current\.get\(sid\) \|\| 0;/);
    // A name the user typed themselves must never be overwritten by an in-flight call.
    assert.match(body, /if \(!stillNew\(\)\) return;/);
  });

  test('flow-owned chats keep their structural names', () => {
    const fn = acp.slice(acp.indexOf('const maybeAutoTitle = ('));
    const body = fn.slice(0, fn.indexOf('\n  };'));
    for (const purpose of ['skill', 'flow-main', 'flow-worker']) {
      assert.match(body, new RegExp(`'${purpose}'`),
        `${purpose} sessions are named by KiroLex, not by the model`);
    }
  });

  test('a send is target-addressed, so a background pane names its OWN chat', () => {
    // handleSendMessage computes `sid` from paneSid and must forward it; without it
    // sendMessage falls back to whatever chat is focused.
    const fn = app.slice(app.indexOf('const handleSendMessage = useCallback('));
    const body = fn.slice(0, fn.indexOf('\n  }, ['));
    const call = body.slice(body.indexOf('await sendMessage('));
    assert.match(call, /sid \|\| undefined,/, 'the pane session id must reach sendMessage');
  });

  test('the title handler leaves a trace on every branch', () => {
    // It logged NOTHING before -- including the silent `{ error: 'empty' }` branch --
    // which is why "chats stopped naming themselves" was undiagnosable twice.
    const fn = main.slice(main.indexOf("ipcMain.handle('app:generate-title'"));
    const body = fn.slice(0, fn.indexOf('\n  });'));
    assert.match(body, /logger\.info\('title', `generated/);
    assert.match(body, /logger\.warn\('title'/);
    assert.match(body, /logger\.info\('title', 'skipped/);
  });
});

/**
 * 自动起的标题**也要落盘** —— 手改的名字走 `renameSession`（带 `renameSessionOnDisk`），
 * 而自动命名原来直接 `setSessions`：侧栏显示得好好的，磁盘记录里 `title` 仍是 `New Chat`，
 * 重启 / 按记录搜标题时就认不出这条会话。绝大多数会话的名字恰恰是自动起的。
 */
describe('自动标题要落盘', () => {
  const MAYBE = acp.slice(acp.indexOf('const maybeAutoTitle = ('));
  const BODY = MAYBE.slice(0, MAYBE.indexOf('\n  };'));

  test('两条写入口（模型给的名字、截断兜底）走同一个 applyTitle，而它落盘', () => {
    const at = BODY.indexOf('const applyTitle =');
    assert.ok(at > 0, '两处不该各写一遍 —— 写两遍必有一遍忘了落盘');
    const fn = BODY.slice(at, at + 400);
    assert.match(fn, /setSessions\(/);
    assert.match(fn, /renameSessionOnDisk\?\.\(sid, title\)/);
    assert.match(BODY, /applyTitle\(truncated\)/, '截断兜底走 applyTitle');
    assert.match(BODY, /applyTitle\(r\.title\)/, '模型给的名字走 applyTitle');
  });

  test('不再有绕过它的裸 setSessions 改标题', () => {
    // applyTitle 自己那一句 setSessions 是正路；它之后到函数结尾不该再有
    const at = BODY.indexOf('const applyTitle =');
    const rest = BODY.slice(BODY.indexOf('\n    };', at));
    assert.doesNotMatch(rest, /setSessions\(/, '改标题一律经 applyTitle，否则又会漏掉落盘');
    assert.equal((BODY.match(/setSessions\(/g) || []).length, 1);
  });
});

describe('自动命名不拿 KiroLex 自己的提示当话题', () => {
  test('新建会话先出现备用模型提示、再发真实问题：命名材料是那条真实问题', async () => {
    const { firstUserText } = await import('../src/renderer/titleSource.ts');
    const msgs = [
      { role: 'user', kirolex: true as const, content: '⚠️ 本机没有模型「claude-opus-5」，这条会话改用「gpt-5.6-sol」。\n\n⁣本机可用：gpt-5.6-sol' },
      { role: 'user', content: '帮我把这个接口的错误处理补全' },
      { role: 'assistant', content: '好的' },
    ];
    assert.equal(firstUserText(msgs), '帮我把这个接口的错误处理补全');
    /* 截断兜底用的也是同一个值 —— 只有 KiroLex 提示、还没有你的话时，不起名 */
    assert.equal(firstUserText([msgs[0]]), '');
  });

  test('接线：maybeAutoTitle 用 firstUserText（标题模型和截断兜底共用这一个值）', () => {
    assert.match(acp, /const firstUser = firstUserText\(cached\);/);
    assert.doesNotMatch(acp, /cached\.find\(\(m\) => m\.role === 'user' && \(m\.content \|\| ''\)\.trim\(\)\)/);
  });
});
