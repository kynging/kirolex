import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

/*
  「有的会话似乎内容混了」—— 切会话那一拍 currentSessionId 已经是 B、messages 还是 A，
  缓存 effect 把 A 的消息存成 B 的；之后 B 自动重发 → rewriteTranscript(B, A 的消息)，B 的历史被整份换掉。
  实测：「AWS Resilience 博客素材评估」被换成「FSx ONTAP」的 28 条，两条会话在 09-19 19:54 同时被自动重发。
*/
const H = fs.readFileSync(new URL('../src/renderer/hooks/useAcp.ts', import.meta.url), 'utf8');
const M = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');

test('setMessages 一起记下归属；缓存只在归属等于当前会话时才写', () => {
  assert.match(H, /const \[messagesOwner, setMessagesOwner\] = useState<string \| null>\(null\);/);
  assert.match(H, /setMessagesOwner\(currentSessionRef\.current\);\s*setMessagesState\(/);
  assert.match(H, /currentSessionId && messagesOwner === currentSessionId && messages\.length > 0/);
  /* 只有这一个原始 setter：其余地方都得走带归属的那个 */
  assert.equal((H.match(/setMessagesState\(/g) || []).length, 1);
});

test('focusedMessagesRef 记真实归属，不是 currentSessionId', () => {
  assert.match(H, /focusedMessagesRef\.current = \{ sessionId: messagesOwner, messages \}/);
});

test('主进程：要保留的消息一条都不属于这条会话就拒绝重写', () => {
  const at = M.indexOf("ipcMain.handle('acp:rewrite-transcript'");
  const body = M.slice(at, at + 2000);
  assert.match(body, /if \(known === 0\)/);
  assert.ok(body.indexOf('if (known === 0)') < body.indexOf('store.rewriteTranscript(sessionId, next)'));
});
