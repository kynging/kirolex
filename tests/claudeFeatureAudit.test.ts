/**
 * Claude Code 功能逐项实测审计（docs/claude-code-feature-audit.md）里直接修的两条渲染层问题：
 *   F3 分叉 / 复制一条 Claude Code 会话，新会话悄悄建成了 Kiro 会话；
 *   F4 Claude Code / Codex 会话的用量栏永远显示「0.00 credits」（那是 kiro 的计费口径）。
 * 两处都在 .tsx / 大 hook 里，没法直接 import，用源码扫描钉住接线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');

test('F3 分叉 / 复制：引擎跟着源会话（首条消息建后端时读 intendedEngineRef）', () => {
  const A = read('renderer', 'hooks', 'useAcp.ts');
  const d = A.slice(A.indexOf('const duplicateSession = useCallback('), A.indexOf('/** The live view for a chat that is on screen but has no PaneView entry YET.'));
  assert.ok(d.length > 0);
  assert.match(d, /if \(src\.engine && src\.engine !== 'kiro'\) intendedEngineRef\.current\.set\(newId, src\.engine\);/);
  assert.match(d, /\.\.\.\(src\.engine && src\.engine !== 'kiro' \? \{ engine: src\.engine \} : null\)/, '侧栏行上的引擎徽标也要当场对');
  /* 首条消息那条路确实读的是这张表 */
  assert.match(A, /\(pendingId && intendedEngineRef\.current\.get\(pendingId\)\) \|\| undefined,/);
});

test('F4 Credits 计数只给 kiro 会话显示', () => {
  const C = read('renderer', 'components', 'ChatArea.tsx');
  const i = C.indexOf('className="composer-credits composer-usage-action"');
  assert.ok(i > 0);
  const before = C.slice(Math.max(0, i - 400), i);
  assert.match(before, /\{!nonKiro && \(/);
  assert.match(C, /const nonKiro = !!engine && engine !== 'kiro';/);
});

/* ------------------------------------------------ 10b 分叉 / 复制带上源会话的机器 */

test('10b listDurableSessions 带出 remote id（机器已删时标 remoteMissing）', () => {
  const M = read('main', 'index.ts');
  const h = M.slice(M.indexOf("ipcMain.handle('acp:list-durable-sessions'"), M.indexOf("ipcMain.handle('acp:mark-session-purpose'"));
  assert.ok(h.length > 0);
  assert.match(h, /const remoteTargetsNow = listRemoteTargets\(KIROLEX_CONFIG_PATH\);/);
  assert.match(h, /\.\.\.durableRemoteId\(rec\.profile\?\.remote as any, remoteTargetsNow, \(id\) => findRemoteTarget\(KIROLEX_CONFIG_PATH, id\)\),/);
  /* 右键换了机器之后行上的 id 也要跟着变，否则再分叉就落回旧机器 */
  assert.equal((M.match(/'session:targets-changed', \{ sessionId, remoteHost: hostLabelOf\(target\), remoteId: remoteIdOf\(target\),/g) || []).length, 2);
  /* 渲染层的会话行类型和水化白名单里都有它 */
  const App = read('renderer', 'App.tsx');
  assert.match(App, /remoteId\?: string;\n  \/\*\* 记录里的那台机器在设置里已经找不到了/);
  const A = read('renderer', 'hooks', 'useAcp.ts');
  assert.match(A, /\? \{ remoteId: rec\.remoteId, remoteMissing: rec\.remoteMissing \}/);
  assert.match(A, /remoteId: rec\.remoteId,\n\s+remoteMissing: rec\.remoteMissing,/);
  assert.match(A, /remoteId: d\.remoteId \|\| undefined, remoteMissing: undefined/);
});

test('10b duplicateSession 把源会话的机器记进 intendedRemoteRef，侧栏行当场显示机器名（kiro / Claude Code / Codex 都走这条）', () => {
  const A = read('renderer', 'hooks', 'useAcp.ts');
  const d = A.slice(A.indexOf('const duplicateSession = useCallback('), A.indexOf('/** The live view for a chat that is on screen but has no PaneView entry YET.'));
  assert.ok(d.length > 0);
  const i = d.indexOf('const forkRemote = forkRemoteIntent(src);');
  assert.ok(i > 0);
  /* 和 F2 记引擎在同一处，而且**不在**引擎判断里：kiro 会话的分叉也要带机器 */
  const engineLine = "if (src.engine && src.engine !== 'kiro') intendedEngineRef.current.set(newId, src.engine);";
  assert.ok(d.indexOf(engineLine) > 0 && d.indexOf(engineLine) < i);
  assert.match(d, /\n    const forkRemote = forkRemoteIntent\(src\);\n    intendedRemoteRef\.current\.set\(newId, forkRemote\.remoteId\);/);
  assert.match(d, /\.\.\.\(src\.remoteHost \? \{ remoteHost: src\.remoteHost \} : null\),/);
  assert.match(d, /\.\.\.\(forkRemote\.remoteId \? \{ remoteId: forkRemote\.remoteId \} : null\),/);
});

test('10b 首条消息建后端：先用记下的机器（本机也算），引擎同样读记下的', () => {
  const A = read('renderer', 'hooks', 'useAcp.ts');
  const i = A.indexOf('firstSendRemoteId(intendedRemoteRef.current, pendingId,');
  assert.ok(i > 0);
  const call = A.slice(A.lastIndexOf('await window.kiroApi.newSession(', i), i + 400);
  assert.match(call, /uiGet\('kirolex-new-chat-remote'\)/, '默认机器只是没记过时的兜底');
  assert.match(call, /\(pendingId && intendedEngineRef\.current\.get\(pendingId\)\) \|\| undefined,/);
  /* 老的「get || 默认机器」写法不许回来：本机（空串）会被默认机器顶掉 */
  assert.doesNotMatch(A, /\(pendingId && intendedRemoteRef\.current\.get\(pendingId\)\)\s*\n\s*\|\|/);
});

test('10b 源会话的机器已删：会话里明说一句（钉住），不换机器；右键「运行位置」能改 pending 会话', () => {
  const A = read('renderer', 'hooks', 'useAcp.ts');
  const d = A.slice(A.indexOf('const duplicateSession = useCallback('), A.indexOf('/** The live view for a chat that is on screen but has no PaneView entry YET.'));
  assert.match(d, /if \(forkRemote\.missingHost\) \{[\s\S]*?noteSessionLocally\(newId, forkMachineMissingText\(uiLangNow\(\), host\),\n\s+\{ zh: forkMachineMissingText\('zh', host\), en: forkMachineMissingText\('en', host\) \},\n\s+\{ sticky: true, pinned: true, group: FORK_MACHINE_MISSING_GROUP \}\);/);
  /* 主进程那边：记的 id 在设置里找不到就拒绝建，不猜机器（这次没改它，钉住它不被改成换机器） */
  const M = read('main', 'index.ts');
  assert.match(M, /if \(remoteId && !remote\) \{\n\s+throw new Error\(tr\('Remote target \{id\} not found/);
  /* 右键：pending 会话改的是记下的机器，不走主进程（主进程那边还没有它的记录） */
  const r = A.slice(A.indexOf('const retargetPendingSession = useCallback('), A.indexOf('const duplicateSession = useCallback('));
  assert.match(r, /if \(!String\(sessionId\)\.startsWith\('pending_'\)\) return false;/);
  assert.match(r, /intendedRemoteRef\.current\.set\(sessionId, remoteId \|\| ''\);/);
  assert.match(r, /unpinSessionLocally\(sessionId, FORK_MACHINE_MISSING_GROUP\);/);
  const S = read('renderer', 'components', 'Sidebar.tsx');
  const t = S.slice(S.indexOf('const onSetTarget = async'), S.indexOf('const handleContextMenu ='));
  assert.ok(t.indexOf('onRetargetPending?.(sessionId, remoteId,') > 0);
  assert.ok(t.indexOf('onRetargetPending?.(sessionId, remoteId,') < t.indexOf('api.setRemoteTarget('));
  assert.match(read('renderer', 'App.tsx'), /onRetargetPending=\{retargetPendingSession\}/);
  /* pending 会话的右键菜单里真的有「运行位置」（原来整块都只给已落盘的会话） */
  const gate = S.indexOf("{(!ctxSession.id.startsWith('pending_') || !!onRetargetPending) && (");
  assert.ok(gate > 0);
  const runsOn = S.indexOf("t('{icon} Runs on: {where}'", gate);
  assert.ok(runsOn > gate, '「运行位置」子菜单在这道门里面');
  assert.ok(runsOn < S.indexOf("{!ctxSession.id.startsWith('pending_') && (", gate));
});

test('10b 工作目录沿用源会话：项目随分叉带过去，首条消息按它建（cwd 是这条会话自己的文件夹，项目目录按项目给）', () => {
  const A = read('renderer', 'hooks', 'useAcp.ts');
  const d = A.slice(A.indexOf('const duplicateSession = useCallback('), A.indexOf('/** The live view for a chat that is on screen but has no PaneView entry YET.'));
  assert.match(d, /duplicateProjectRef\.current\.set\(newId, src\.projectId\);/);
  assert.match(d, /projectId: src\.projectId,/);
  assert.match(A, /const pendingProjectId = pendingId && duplicateProjectRef\.current\.has\(pendingId\)\n\s+\? duplicateProjectRef\.current\.get\(pendingId\)/);
  const i = A.indexOf('firstSendRemoteId(intendedRemoteRef.current, pendingId,');
  const call = A.slice(A.lastIndexOf('await window.kiroApi.newSession(', i), i);
  assert.match(call, /activeModel,\n\s+pendingProjectId,/);
  /* 主进程：本地 cwd 是会话自己的文件夹（每条会话一个，换项目 / 机器都不变），项目目录由 projectId 给 */
  const M = read('main', 'index.ts');
  assert.match(M, /if \(!profile\.remote\?\.sshHost\) resolvedCwd = localCwdFor\(kiroLexId, resolvedCwd\);/);
  assert.match(M, /projectId: projectId \?\? derived,/);
});

test('10b 分叉后没发消息就重启：机器意图记在落盘的会话行上，启动时灌回 intendedRemoteRef（机器已删的再提示一次）', () => {
  const A = read('renderer', 'hooks', 'useAcp.ts');
  const d = A.slice(A.indexOf('const duplicateSession = useCallback('), A.indexOf('/** The live view for a chat that is on screen but has no PaneView entry YET.'));
  assert.match(d, /forkRemoteId: forkRemote\.remoteId,/);
  const r = A.slice(A.indexOf('const retargetPendingSession = useCallback('), A.indexOf('const duplicateSession = useCallback('));
  assert.match(r, /forkRemoteId: remoteId \|\| ''/);
  /* 行整份落盘 */
  assert.match(A, /uiSet\('kirolex-sessions', JSON\.stringify\(sessions\)\);/);
  /* 启动时灌回去，而且在首条消息那条路之前就声明好 */
  const i = A.indexOf('for (const r of restoredForkIntents(sessions)) {');
  assert.ok(i > 0 && i > A.indexOf('const intendedRemoteRef = useRef'));
  const e = A.slice(i, i + 700);
  assert.match(e, /if \(!intendedRemoteRef\.current\.has\(r\.id\)\) intendedRemoteRef\.current\.set\(r\.id, r\.remoteId\);/);
  assert.match(e, /if \(r\.missingHost\) \{[\s\S]*?group: FORK_MACHINE_MISSING_GROUP/);
  assert.match(read('renderer', 'App.tsx'), /forkRemoteId\?: string;/);
});
