import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');

test('提醒组件接在 ChatArea 的输入框上方，按这一格的会话 / 读数 / 引擎', () => {
  const C = src('renderer', 'components', 'ChatArea.tsx');
  assert.match(C, /import \{ ContextReminder \} from '\.\/ContextReminder\.tsx'/);
  const at = C.indexOf('<ContextReminder');
  assert.ok(at > 0, 'ChatArea 里渲染了 <ContextReminder');
  const block = C.slice(at, at + 400);
  assert.match(block, /sessionId=\{currentSessionId \|\| null\}/);
  assert.match(block, /pct=\{usage\?\.contextPercent\}/);
  assert.match(block, /engine=\{engine\}/);
  assert.ok(block.includes('isStreaming={isStreaming || compacting}'), '跑着一轮或压缩还在后台跑：按钮都置灰');
  assert.ok(at < C.indexOf('<ChatInputBox', at), '在输入框前面（上方）');
});

test('App 把两颗按钮按格子的 sid 接上：压缩走 compactCommandFor，换后端会话走 newBackendSession', () => {
  const A = src('renderer', 'App.tsx');
  assert.match(A, /onCompactContext=\{\(pct\) => handleContextCompact\(sid, pct\)\}/);
  assert.match(A, /onNewBackendContext=\{\(pct\) => handleContextNewBackend\(sid, pct\)\}/);
  const c = A.slice(A.indexOf('const handleContextCompact'), A.indexOf('useEffect(', A.indexOf('const handleContextCompact')));
  assert.match(c, /compactCommandFor\(session\?\.engine\)/);
  assert.match(c, /composerRunning\(/, '正在跑一轮时不发');
  assert.match(c, /disarmAutoCompact\(sid\)/, '手动压缩后自动压缩不跟着再压');
  assert.match(c, /newBackendSession\?\.\(sid\)/);
  assert.match(c, /logContext\?\.\(\{ kind: 'compact'/);
});

test('自动压缩：走 stepAutoCompact、按目标会话发（不抢焦点）、做完留 KiroLex 提示', () => {
  const A = src('renderer', 'App.tsx');
  const e = A.slice(A.indexOf('const autoCompactTracksRef'), A.indexOf('// Drop queues whose sessions were deleted or archived.'));
  assert.match(e, /stepAutoCompact\(/);
  assert.match(e, /sendQueuedMessage\(sid, command, \[\], \{ maintenance: true \}\)/);
  assert.match(e, /sessionNote\?\.\(sid, text/);
  assert.match(e, /via: 'auto'/);
});

test('设置项默认关、默认阈值 75，读旧设置时规整', () => {
  const A = src('renderer', 'App.tsx');
  const d = A.slice(A.indexOf('const DEFAULT_SETTINGS'), A.indexOf('\n', A.indexOf('const DEFAULT_SETTINGS')));
  assert.match(d, /autoCompactContext: false/);
  assert.match(d, /autoCompactPct: AUTO_COMPACT_DEFAULT_PCT/);
  assert.match(A, /merged\.autoCompactContext = merged\.autoCompactContext === true;/);
  const S = src('renderer', 'components', 'SettingsDialog.tsx');
  const sess = S.slice(S.indexOf("{tab === 'session' && ("));
  assert.match(sess.slice(0, sess.indexOf("{tab === '", 10)), /Auto-compact when context reaches X%/, '在「会话」页');
});

test('日志通道：acp:context-log → [context] 行', () => {
  const M = src('main', 'index.ts');
  const at = M.indexOf("ipcMain.on('acp:context-log'");
  assert.ok(at > 0);
  assert.match(M.slice(at, at + 200), /logger\.info\('context', contextLogLine\(/);
  assert.match(src('main', 'preload.ts'), /logContext: \(d[^)]*\) => ipcRenderer\.send\('acp:context-log', d\)/);
});

test('自动压缩不碰等待重发的中断会话：判中断用 interruptedSessionIds + 轮次结果；发送用 maintenance，先于覆盖 / 截记录就返回', () => {
  const A = src('renderer', 'App.tsx');
  const e = A.slice(A.indexOf('const autoCompactTracksRef'), A.indexOf('// Drop queues whose sessions were deleted or archived.'));
  assert.match(e, /const interrupted = interruptedSessionIds\.includes\(sid\) \|\| turnOutcomeOf\(sid\)\.kind !== 'ok';/);
  assert.match(e, /stepAutoCompact\([^;]*interrupted \}\)/);
  assert.match(e, /sendQueuedMessage\(sid, command, \[\], \{ maintenance: true \}\) === 'skipped'/);
  const U = src('renderer', 'hooks', 'useAcp.ts');
  const body = U.slice(U.indexOf('const sendQueuedMessage = useCallback'));
  const guard = body.indexOf("if (options?.maintenance && overwriteTargetRef.current.has(sessionId)) return 'skipped';");
  assert.ok(guard > 0, 'maintenance 发送有中断守卫');
  assert.ok(guard < body.indexOf('const overwriteId = overwriteTargetRef.current.get(sessionId)'), '守卫在读覆盖标记之前');
  assert.ok(guard < body.indexOf('rewriteTranscript('), '守卫在截记录之前');
  assert.ok(guard < body.indexOf('clearInterrupted(sessionId)'), '守卫在清中断标记之前');
});

test('停止一轮后点提醒条的「压缩上下文」：不走覆盖重发 —— 按钮置灰并说明，App 的处理函数也不发', () => {
  const C = src('renderer', 'components', 'ChatArea.tsx');
  const at = C.indexOf('<ContextReminder');
  assert.match(C.slice(at, at + 500), /turnInterrupted=\{!!turnInterrupted\}/, '把这一格的中断状态传进提醒条');
  const R = src('renderer', 'components', 'ContextReminder.tsx');
  assert.match(R, /const blockedByInterrupt = !isStreaming && !!turnInterrupted;/);
  const btnEnd = R.indexOf("t('Compact context')");
  const btn = R.slice(R.lastIndexOf('<button', btnEnd), btnEnd);
  assert.match(btn, /disabled=\{isStreaming \|\| working \|\| blockedByInterrupt\}/, '压缩按钮在等重发时置灰');
  assert.match(R, /canCompact && blockedByInterrupt && <span className="context-reminder-wait">\{interruptedTitle\}<\/span>/, '写明为什么不能压');
  const A = src('renderer', 'App.tsx');
  const c = A.slice(A.indexOf('const handleContextCompact'), A.indexOf('const handleContextNewBackend'));
  const guard = c.indexOf('if (interruptedSessionIds.includes(sid)) return');
  assert.ok(guard > 0, '处理函数在等重发时直接返回');
  const send = c.indexOf('sendQueuedMessage(sid, command, [], { maintenance: true })');
  assert.ok(send > 0, '压缩用 maintenance 发送（会话在等重发时它也不发）');
  assert.ok(guard < send, '返回在发 /compact 之前');
  assert.ok(guard < c.indexOf('disarmAutoCompact(sid)'), '也不记成「压过一次」');
});

test('有待发送附件时点提醒条的「压缩上下文」：不经输入框那条发送，不读也不清草稿附件，只发 /compact', () => {
  const A = src('renderer', 'App.tsx');
  const c = A.slice(A.indexOf('const handleContextCompact'), A.indexOf('const handleContextNewBackend'));
  assert.ok(c.length > 0);
  assert.doesNotMatch(c, /handleSendMessage\(/, '不走 handleSendMessage（它会带上并清空输入框附件）');
  assert.doesNotMatch(c, /attachedFor\(/, '不读草稿附件');
  assert.doesNotMatch(c, /clearAttachments\(/, '不清草稿附件');
  assert.match(c, /sendQueuedMessage\(sid, command, \[\], \{ maintenance: true \}\)/, '附件参数是空数组');
  /* sendQueuedMessage 自己也不碰附件草稿：只用传进来的 attachments */
  const U = src('renderer', 'hooks', 'useAcp.ts');
  const body = U.slice(U.indexOf('const sendQueuedMessage = useCallback'));
  const end = body.indexOf('\n  }, [');
  assert.ok(end > 0);
  assert.doesNotMatch(body.slice(0, end), /clearAttachments|attachedFor/);
});
