import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  muteKeyOf, muteScope, isNoticeHidden, dismissNotice, muteNotice, noticeHideStore,
} from '../src/renderer/noticeDismiss.ts';

/*
 * 「报错没有关闭按钮就很烦」（2026-10-25）：所有 KiroLex 提示都要能关；关掉只影响显示（不删记录，给模型的内容不变）；
 * 同一类提供「不再提醒（这台电脑 / 这个 MCP 配置）」。之后的新会话里同样的 MCP 问题只挂一个小徽标。
 */

const ROOT = path.join(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('关掉 / 不再提醒：只改显示状态', () => {
  test('「不再提醒」的键：没带上的 MCP 按 MCP 配置记，其余按类型；没有 group 的只能关', () => {
    assert.equal(muteKeyOf('mcp-unavailable:default'), 'mcp-unavailable:default');
    assert.equal(muteScope('mcp-unavailable:default'), 'profile');
    assert.equal(muteKeyOf('forward-mcp-failed:builder-mcp'), 'forward-mcp-failed');
    assert.equal(muteScope('forward-mcp-failed:builder-mcp'), 'kind');
    assert.equal(muteKeyOf('local-tools-reconnect'), 'local-tools-reconnect');
    assert.equal(muteKeyOf(undefined), null);
    assert.equal(muteScope(''), null);
  });

  test('关掉的按 id 隐藏，新来的同类照样显示；不再提醒后同类都隐藏、别的 MCP 配置不受影响', () => {
    const a = { id: 'u_1_note', noteGroup: 'forward-mcp-failed:x' };
    const b = { id: 'u_2_note', noteGroup: 'forward-mcp-failed:y' };
    const c = { id: 'u_3_note', noteGroup: 'mcp-unavailable:research' };
    assert.equal(isNoticeHidden(a, noticeHideStore.get()), false);
    dismissNotice(a.id);
    assert.equal(isNoticeHidden(a, noticeHideStore.get()), true);
    assert.equal(isNoticeHidden(b, noticeHideStore.get()), false, '关掉一条不影响新来的那条');
    muteNotice('mcp-unavailable:default');
    assert.equal(isNoticeHidden(c, noticeHideStore.get()), false, '别的 MCP 配置照样提醒');
    muteNotice(b.noteGroup);
    assert.equal(isNoticeHidden(b, noticeHideStore.get()), true);
    assert.equal(isNoticeHidden({ id: 'u_9', noteGroup: 'forward-mcp-failed:z' }, noticeHideStore.get()), true);
  });

  test('源码：noticeDismiss 只碰 ui-state（不删对话记录、不发 IPC 改内容）', () => {
    const src = read('src/renderer/noticeDismiss.ts');
    assert.ok(!/kiroApi/.test(src), '不调主进程');
    assert.ok(!/transcript|appendMessage|rewrite/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), '不碰对话记录');
    assert.match(src, /uiSet\(DISMISSED_NOTES_KEY/);
    assert.match(src, /uiSet\(MUTED_NOTICES_KEY/);
  });
});

describe('渲染源码：KiroLex 提示卡片有关闭按钮，关掉只改显示', () => {
  const chat = read('src/renderer/components/ChatArea.tsx');
  const item = chat.slice(chat.indexOf('const KirolexMessageItem = memo'), chat.indexOf('function McpUnavailableBadge'));

  test('卡片右上角 ×：dismissNotice(message.id)；有类型的给「不再提醒」', () => {
    assert.ok(item.length > 100, '找得到 KirolexMessageItem');
    assert.match(item, /className="kirolex-message-close"[\s\S]*?onClick=\{\(\) => dismissNotice\(message\.id\)\}/);
    assert.match(item, /const group = message\.noteGroup \?\? \(isConnectFailureNotice\(message\) \? CONNECT_FAILURE_GROUP : undefined\);/);
    assert.match(item, /className="kirolex-message-mute"[\s\S]*?muteNotice\(group\)/);
    assert.match(item, /isNoticeHidden\(\{ id: message\.id, noteGroup: group \}, hide\)\) return null/);
  });

  test('关掉不改消息、不调主进程（只读显示状态）', () => {
    assert.ok(!/kiroApi|onDelete|setMessages|rewriteTranscript/.test(item));
  });

  test('hooks 在提前 return 之前', () => {
    assert.ok(item.indexOf('useSyncExternalStore(') < item.indexOf('return null'));
    const badge = chat.slice(chat.indexOf('function McpUnavailableBadge'), chat.indexOf('定时到点发进会话的那条'));
    const firstReturn = badge.indexOf('return null');
    for (const h of ['useState(', 'useEffect(', 'useSyncExternalStore(']) {
      const i = badge.lastIndexOf(h);
      assert.ok(i >= 0 && i < firstReturn, `${h} 在提前 return 之前`);
    }
  });

  test('错误横幅和状态行本来就有 ×（不动它们）', () => {
    assert.match(chat, /className="chat-error-banner-close"/);
    assert.match(chat, /className="session-notice-close"/);
  });

  test('空会话中央的连接错误卡片也有 ×：同一个 onDismissError（只清显示状态）', () => {
    const empty = chat.slice(chat.indexOf('{messages.length === 0 && !historyLoading && ('), chat.indexOf('{hiddenGroupCount > 0 && ('));
    assert.ok(empty.includes('connectionError && !errorNoticeMuted ?'), '找得到空会话那张错误卡片（「不再提醒」过就不画）');
    assert.match(empty, /className="chat-error-banner-close chat-empty-error-close"\s*onClick=\{onDismissError\}/);
    const app = read('src/renderer/App.tsx');
    assert.match(app, /onDismissError=\{\(\) => clearSessionError\(sid\)\}/);
    assert.match(read('src/renderer/hooks/useAcp.ts'), /clearSessionError: \(sid\?: string \| null\) => noteError\(sid \?\? null, null\)/);
  });

  test('「这条会话没能启动」横幅失败时有 ×：只改显示（本地状态），按这次启动记，hooks 在提前 return 之前', () => {
    const fn = chat.slice(chat.indexOf('function StartupBanner'), chat.indexOf('function StartupBanner') + 3500);
    assert.match(fn, /className="startup-banner-close" onClick=\{\(\) => setClosedAt\(info\.startedAt\)\}/);
    assert.match(fn, /if \(info\.stage === 'failed' && closedAt === info\.startedAt\) return null;/);
    assert.ok(fn.indexOf('useEffect(') < fn.indexOf('return null'));
    assert.ok(!/kiroApi|onRetry\(/.test(fn.slice(fn.indexOf('startup-banner-close'), fn.indexOf('startup-banner-close') + 200)), '关掉不重试、不调主进程');
  });

  test('只在界面上的 role:kirolex 提示（连接失败）进 KiroLex 组、用带 × 的卡片画，安装入口挂在卡片下面', async () => {
    assert.match(chat, /if \(\(m\.role === 'user' && isKirolexNote\(m\)\) \|\| \(m\.role as string\) === 'kirolex'\) \{\s*groups\.push\(\{ kind: 'kirolex', message: m \}\);/);
    assert.match(chat, /<KirolexMessageItem[\s\S]{0,200}after=\{isConnectFailureNotice\(group\.message\)\s*\? <AdapterInstallAction sessionId=\{currentSessionId\} message=\{group\.message\}/);
    assert.match(item, /\{after\}/, '安装入口在卡片里一起显示 / 一起隐藏');
    assert.match(item, /\(message\.role as string\) === 'kirolex'\s*\? <NoticeBody text=\{message\.content\} count=\{count\} render=\{\(s\) => boldWithPathLinks\(s, message\.id\)\} \/>/, '原因里的 **加粗** 照旧画成粗体');
    const bold = chat.slice(chat.indexOf('function boldWithPathLinks'), chat.indexOf('const KirolexMessageItem = memo'));
    assert.ok((bold.match(/withPathLinks\(/g) || []).length >= 2, '加粗之外的部分照旧认路径');
    assert.match(chat, /const parts = text\.split\(\/\\\*\\\*\(\[\^\*\\n\]\+\?\)\\\*\\\*\/\);/);
    const { connectFailureNotice, isConnectFailureNotice } = await import('../src/renderer/connectFailure.ts');
    const n = connectFailureNotice('还没有设置本机的 kiro 启动命令');
    assert.equal(n.role as string, 'kirolex', '连接失败提示就是 role: kirolex —— 正是上面那条分组要收的');
    assert.ok(isConnectFailureNotice(n));
  });

  test('定时结束卡片（ScheduleEndCard）也能关 / 不再提醒，hooks 在提前 return 之前', () => {
    const end = chat.slice(chat.indexOf('const ScheduleEndCard = memo'), chat.indexOf('const ScheduleEndCard = memo') + 3000);
    assert.match(end, /if \(isNoticeHidden\(\{ id: message\.id, noteGroup: message\.noteGroup \}, hide\)\) return null;/);
    assert.match(end, /className="kirolex-message-close"\s*onClick=\{\(\) => dismissNotice\(message\.id\)\}/);
    assert.match(end, /muteNotice\(message\.noteGroup\)/);
    assert.ok(end.indexOf('useSyncExternalStore(') < end.indexOf('return null'));
  });

  test('启动 / 连接失败这几类没有 noteGroup 的提示：稳定的类型键 + 这台电脑「不再提醒」，只改显示', async () => {
    const nd = await import('../src/renderer/noticeDismiss.ts');
    assert.equal(nd.muteKeyOf(nd.CONNECT_FAILURE_GROUP), 'connect-failure');
    assert.equal(nd.muteKeyOf(nd.STARTUP_FAILED_GROUP), 'startup-failed');
    assert.equal(nd.muteKeyOf(nd.SESSION_ERROR_GROUP), 'session-error');
    assert.equal(nd.isMuted(nd.STARTUP_FAILED_GROUP, nd.noticeHideStore.get()), false);
    nd.muteNotice(nd.STARTUP_FAILED_GROUP);
    assert.equal(nd.isMuted(nd.STARTUP_FAILED_GROUP, nd.noticeHideStore.get()), true);
    assert.equal(nd.isMuted(nd.SESSION_ERROR_GROUP, nd.noticeHideStore.get()), false, '各类各管各的');
    /* 「没连上」卡片：上面的 group 回退到 connect-failure，静音后同类新的一条也不画 */
    nd.muteNotice(nd.CONNECT_FAILURE_GROUP);
    assert.equal(nd.isNoticeHidden({ id: 'msg_123', noteGroup: nd.CONNECT_FAILURE_GROUP }, nd.noticeHideStore.get()), true);

    /* 启动失败横幅：hooks 在 return 前；静音只挡失败那张；按钮只调 muteNotice（不重试、不调主进程） */
    const fn = chat.slice(chat.indexOf('function StartupBanner'), chat.indexOf('function StartupBanner') + 4000);
    assert.ok(fn.indexOf('useSyncExternalStore(noticeHideStore.subscribe') < fn.indexOf('return null'));
    assert.match(fn, /if \(info\.stage === 'failed' && isMuted\(STARTUP_FAILED_GROUP, hide\)\) return null;/);
    assert.match(fn, /className="startup-banner-mute" onClick=\{\(\) => muteNotice\(STARTUP_FAILED_GROUP\)\}/);
    assert.match(fn, /onClick=\{\(\) => onRetry\(false\)\}/, '重试照旧');

    /* 错误横幅 + 空会话错误卡片：同一个类型键，静音后都不画；关闭照旧 onDismissError */
    assert.match(chat, /const errorNoticeMuted = isMuted\(SESSION_ERROR_GROUP, useSyncExternalStore\(noticeHideStore\.subscribe, noticeHideStore\.get\)\);/);
    assert.match(chat, /\{connectionError && !errorNoticeMuted && messages\.length > 0 && \(/);
    assert.equal((chat.match(/onClick=\{\(\) => muteNotice\(SESSION_ERROR_GROUP\)\}/g) || []).length, 2, '横幅和空会话卡片各一个');
    assert.ok(chat.indexOf('const errorNoticeMuted') < chat.indexOf('{connectionError && !errorNoticeMuted'));
  });

  test('徽标详情里也能「不再提醒（这台电脑 / 这个 MCP 配置）」：muteNotice(view.group)', () => {
    const badge = chat.slice(chat.indexOf('function McpUnavailableBadge'), chat.indexOf('定时到点发进会话的那条'));
    assert.match(badge, /className="kirolex-message-mute mcp-unavailable-mute"\s*onClick=\{\(\) => \{ muteNotice\(view\.group\); setOpen\(false\); \}\}/);
    assert.match(badge, /t\("Don't remind me \(this computer, this MCP profile\)"\)/);
    assert.match(badge, /if \(k && hide\.muted\.has\(k\)\) return null/, '静音后徽标不再挂');
  });

  test('输入框上方挂「⚠ N 个 MCP 不可用」徽标：对话记录里说过的不挂，点开看详情，× 只关显示', () => {
    const badge = chat.slice(chat.indexOf('function McpUnavailableBadge'), chat.indexOf('定时到点发进会话的那条'));
    assert.match(badge, /view\.noted\) return null/);
    assert.match(badge, /t\('⚠ \{n\} MCP\(s\) unavailable', \{ n: view\.items\.length \}\)/);
    assert.match(badge, /mcp-unavailable-pop/);
    assert.match(badge, /window\.kiroApi\.onMcpUnavailable/);
    assert.ok(chat.indexOf('<McpUnavailableBadge') >= 0 && chat.indexOf('<McpUnavailableBadge') < chat.indexOf('<ChatInputBox'), '在输入框上方');
  });
});

describe('主进程接线：合并 + 只说一次 + 本机覆盖', () => {
  const idx = read('src/main/index.ts');
  const preload = read('src/main/preload.ts');

  test('远程 Claude Code / Codex、Kiro 远程、本地组合会话都走 announceMcpUnavailable', () => {
    const calls = idx.match(/announceMcpUnavailable\(sessionId,/g) || [];
    assert.equal(calls.length, 3);
    assert.ok(!/notForwardedNotice\(/.test(idx), '不再一条一条说「没带上」');
    assert.ok(!/notForwardedNoticed/.test(idx));
  });

  test('没就绪的：还在起的单独说，找不到 / 起不来的并进合并提示', () => {
    const fn = idx.slice(idx.indexOf('function noteForwardNotReady'), idx.indexOf('function noteForwardNotReady') + 900);
    assert.match(fn, /if \(n\.starting\) noteInSession\(sessionId, forwardNotReadyNotice/);
    assert.match(idx, /n\.missing\s*\?\s*missingCommandItem\(n\.name, n\.missing, n\.reason\)\s*:\s*failedItem\(n\.name, n\.reason\)/);
  });

  test('只说一次：说过的不进对话记录，只发给界面挂徽标；没说成不记', () => {
    const fn = idx.slice(idx.indexOf('function announceMcpUnavailable'), idx.indexOf('function announceMcpUnavailable') + 2200);
    assert.match(fn, /planMcpNotice\(loud, seen, mcpNoticeScope\(os\.hostname\(\), scopeId\), okNames\)/);
    assert.match(fn, /if \(plan\.say\) \{\s*noted = noteInSession\(sessionId, mcpUnavailableNotice\(loud\), undefined, group\)/);
    assert.match(fn, /if \(\(!plan\.say \|\| noted\) && .*writeMcpNoticeSeen/);
    assert.match(fn, /webContents\.send\('acp:mcp-unavailable'/);
    assert.match(preload, /mcpUnavailable: \(sessionId: string\) => ipcRenderer\.invoke\('acp:mcp-unavailable'/);
    assert.match(preload, /ipcRenderer\.on\('acp:mcp-unavailable'/);
  });

  test('组合按这台电脑套 perMachine；本地会话找不到命令的不交给适配器', () => {
    assert.match(idx, /return localizeCombo\(combo, thisMachine\(\)\);/);
    const local = idx.slice(idx.indexOf('function localComboTools'), idx.indexOf('async function ensureLocalTools'));
    assert.match(local, /if \(resolveCommand\(s\.command, \{ env \}\)\) return true;/);
    assert.match(local, /missingCommandItem\(s\.name, s\.command, commandMissingReason\(s\.command\)\)/);
  });

  test('面板：查这台电脑不可用 + 写本机覆盖的 IPC 三处都接上', () => {
    assert.match(idx, /ipcMain\.handle\('acp:mcp-combos-local-check'/);
    assert.match(idx, /ipcMain\.handle\('acp:mcp-combos-machine-override'/);
    assert.match(preload, /mcpCombosLocalCheck:/);
    assert.match(preload, /mcpCombosMachineOverride:/);
    const pane = read('src/renderer/components/McpCombosPane.tsx');
    assert.match(pane, /mcpCombosLocalCheck/);
    assert.match(pane, /t\('Not available on this computer'\)/);
    assert.match(pane, /applyMachineOverride\(u, \{ disabled: true \}\)/);
    assert.match(pane, /t\('Set a command for this computer'\)/);
  });
});
