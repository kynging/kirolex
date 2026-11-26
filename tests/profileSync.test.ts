import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  alignSessions, alignUiStateSessions, applyProfileEntry, diffSessionProfile, engineFromSwitchResult,
  profileSyncEntryFromDiskRow, profileSyncFieldsOf, profileSyncLogLine, type ProfileSyncEntry,
} from '../src/main/profileSync.ts';
import { noteEngineSwitchResult, onEngineSwitchResult } from '../src/renderer/engineSwitch.ts';
import { busyEnterKind, resolveBusyEnter } from '../src/renderer/steerRoute.ts';

/**
 * 「界面显示是 Claude Code，记录是 kiro」（s_1792550941538_1eubnn）：ui-state 里那份会话列表是 Mac 时代的旧快照
 * （engine: claude、localDir: /Users/...），从没按 record.json 校正过；切到同一个引擎主进程直接 unchanged、不广播；
 * 忙时 Enter 按列表里的 claude 路由进了 KiroLex 队列（应该走 kiro 的 _session/steer）。
 * 这里守：记录为准的对齐 + 日志行、unchanged 也更新界面、忙时 Enter 按主进程的引擎走、各处接线。
 */

const SID = 's_1792550941538_1eubnn';
const kiroRecord = { id: SID, localDir: 'C:\\Users\\kyn\\work', profile: { engine: 'kiro', model: 'claude-opus-5', permissionMode: 'ask' } };
const staleUi = { id: SID, title: 'x', model: 'claude-opus-5', engine: 'claude', localDir: '/Users/keyinan/work', timestamp: 1 };

describe('字段对齐（纯）', () => {
  test('ui-state engine=claude、记录 engine=kiro → 对齐后是 kiro，并产生日志项', () => {
    const entry = profileSyncFieldsOf(kiroRecord);
    const r = alignSessions([staleUi], [entry]);
    assert.equal(r.changed, true);
    assert.equal(r.sessions[0].engine, undefined, 'kiro 在列表里写成 undefined（和 session:engine-changed 同一个口径）');
    assert.equal(r.sessions[0].localDir, 'C:\\Users\\kyn\\work', 'Mac 时代的 localDir 换成记录里的');
    assert.equal(r.sessions[0].title, 'x', '别的字段原样');
    const engineFix = r.fixes.find((f) => f.field === 'engine')!;
    assert.deepEqual(engineFix, { sessionId: SID, field: 'engine', ui: 'claude', record: 'kiro' });
    assert.equal(profileSyncLogLine(engineFix), `fixed sessionId=${SID} field=engine ui=claude record=kiro`);
    assert.ok(r.fixes.some((f) => f.field === 'localDir'));
  });

  test('记录里"没有"也算数：本机会话清掉快照里的远端、未分组清掉项目、默认 agent 清掉 agent', () => {
    const ui = { id: 'a', model: 'm', engine: 'codex', remoteHost: 'tokyo', remoteId: 'r1', remoteMissing: true, projectId: 'Dev', kiroAgent: 'x', permissionMode: 'auto-approve', timestamp: 1 };
    const r = alignSessions([ui], [profileSyncFieldsOf({ id: 'a', profile: { model: 'm' } })]);
    const s = r.sessions[0] as any;
    assert.equal(s.engine, undefined);
    assert.equal(s.remoteHost, undefined);
    assert.equal(s.remoteId, undefined);
    assert.equal(s.remoteMissing, undefined);
    assert.equal(s.projectId, undefined);
    assert.equal(s.kiroAgent, undefined);
    assert.equal(s.permissionMode, 'ask', '记录没写权限 = 先问');
  });

  test('一样就不动：同一个数组、changed=false、没有日志项；kiro 写成 undefined 和 "kiro" 算一样', () => {
    const ui = [{ id: 'a', model: 'm', permissionMode: 'ask' as const, timestamp: 1 }, { id: 'b', model: 'm', engine: 'kiro', timestamp: 1 }];
    const r = alignSessions(ui, [profileSyncFieldsOf({ id: 'a', profile: { model: 'm' } }), profileSyncFieldsOf({ id: 'b', profile: { model: 'm', engine: 'kiro' } })]);
    assert.equal(r.changed, false);
    assert.equal(r.sessions, ui);
    assert.deepEqual(r.fixes, []);
  });

  test('记录里没有模型：不拿空值盖界面上的模型', () => {
    const entry = profileSyncFieldsOf({ id: 'a', profile: {} });
    assert.equal(entry.model, undefined);
    assert.ok(!diffSessionProfile({ id: 'a', model: 'claude-opus-5' }, entry).some((f) => f.field === 'model'));
    assert.equal(applyProfileEntry({ id: 'a', model: 'claude-opus-5' }, entry).model, 'claude-opus-5');
  });

  test('列表里没有记录的（还没落盘的新会话）原样留着', () => {
    const pending = { id: 'pending_1', model: 'm', engine: 'claude', timestamp: 1 };
    const r = alignSessions([pending], [profileSyncFieldsOf(kiroRecord)]);
    assert.equal(r.sessions[0], pending);
    assert.equal(r.changed, false);
  });

  test('连着的执行器：引擎 / 模型用它实际在跑的；远端按主进程给的显示名 / id', () => {
    const e = profileSyncFieldsOf({ id: 'a', profile: { engine: 'claude', model: 'deepseek-3.2' } }, { remoteHost: 'tokyo', remoteId: 'r1' }, { engine: 'kiro', model: 'claude-opus-5' });
    assert.equal(e.engine, 'kiro');
    assert.equal(e.model, 'claude-opus-5');
    assert.equal(e.remoteHost, 'tokyo');
    assert.equal(e.remoteId, 'r1');
    assert.equal(e.remoteMissing, undefined);
  });

  test('水化那一行（list-durable-sessions）→ 同一套字段', () => {
    const e = profileSyncEntryFromDiskRow({ id: SID, model: 'claude-opus-5', localDir: 'C:\\w', permissionMode: 'auto-approve' });
    assert.deepEqual(e, { id: SID, engine: 'kiro', model: 'claude-opus-5', permissionMode: 'auto-approve', localDir: 'C:\\w' });
    const fixed = applyProfileEntry(staleUi, e);
    assert.equal(fixed.engine, undefined, '记录没写 engine（kiro 老记录）也纠正：以前是 rec.engine ?? 快照');
    assert.equal(fixed.permissionMode, 'auto-approve');
  });
});

describe('一次性迁移：ui-state 原文按记录改', () => {
  test('不一致 → 改好的原文 + 日志项；坏条目原样留在原位', () => {
    const raw = JSON.stringify([staleUi, null, { id: 'other', model: 'm', timestamp: 2 }]);
    const r = alignUiStateSessions(raw, [profileSyncFieldsOf(kiroRecord)]);
    assert.ok(r.raw);
    const list = JSON.parse(r.raw!);
    assert.equal(list.length, 3);
    assert.equal(list[0].engine, undefined);
    assert.equal(list[0].localDir, 'C:\\Users\\kyn\\work');
    assert.equal(list[1], null);
    assert.deepEqual(list[2], { id: 'other', model: 'm', timestamp: 2 });
    assert.ok(r.fixes.some((f) => profileSyncLogLine(f) === `fixed sessionId=${SID} field=engine ui=claude record=kiro`));
  });
  test('一致 / 读不出来 / 没有 → 不写', () => {
    const okRaw = JSON.stringify([{ id: SID, model: 'claude-opus-5', localDir: 'C:\\Users\\kyn\\work', timestamp: 1 }]);
    assert.deepEqual(alignUiStateSessions(okRaw, [profileSyncFieldsOf(kiroRecord)]), { fixes: [] });
    assert.deepEqual(alignUiStateSessions('{bad', [profileSyncFieldsOf(kiroRecord)]), { fixes: [] });
    assert.deepEqual(alignUiStateSessions(undefined, [profileSyncFieldsOf(kiroRecord)]), { fixes: [] });
    assert.deepEqual(alignUiStateSessions('{"a":1}', [profileSyncFieldsOf(kiroRecord)]), { fixes: [] });
  });
});

describe('switch-engine 到同一引擎：unchanged 也更新界面', () => {
  test('返回 unchanged + engine → 渲染层状态更新为该引擎；pending / 失败不更新', () => {
    assert.equal(engineFromSwitchResult({ ok: true, unchanged: true, engine: 'kiro' }), 'kiro');
    assert.equal(engineFromSwitchResult({ ok: true, engine: 'codex', cold: true }), 'codex');
    assert.equal(engineFromSwitchResult({ ok: true, pending: true, engine: 'kiro' }), undefined, 'pending 时那个 engine 还没生效');
    assert.equal(engineFromSwitchResult({ ok: false, error: 'x' }), undefined);
    assert.equal(engineFromSwitchResult(undefined), undefined);

    /* 和 useAcp 里一样：订阅者把列表里的 engine 改掉 */
    let sessions: any[] = [{ ...staleUi }];
    const off = onEngineSwitchResult((sid, engine) => {
      sessions = sessions.map((s) => (s.id === sid ? { ...s, engine: engine === 'kiro' ? undefined : engine } : s));
    });
    try {
      assert.equal(noteEngineSwitchResult(SID, { ok: true, pending: true, engine: 'kiro' }), undefined);
      assert.equal(sessions[0].engine, 'claude');
      assert.equal(noteEngineSwitchResult(SID, { ok: true, unchanged: true, engine: 'kiro' }), 'kiro');
      assert.equal(sessions[0].engine, undefined, '显示跟着变成 kiro');
    } finally { off(); }
  });
});

describe('忙时 Enter：按主进程的引擎路由', () => {
  test('列表 engine 过期（claude）、主进程说 kiro → 走 steer，且调用方拿列表的 engine 去 busyEnterKind 也是 steer', async () => {
    let asked = 0;
    const r = await resolveBusyEnter({ listEngine: 'claude', ask: async () => { asked++; return { engine: 'kiro', busyEnter: 'steer' }; } });
    assert.equal(asked, 1, '不知道主进程的引擎：现问');
    assert.equal(r.engine, 'kiro');
    assert.equal(r.kind, 'steer');
    assert.equal(busyEnterKind('claude', r.busyEnter), 'steer');
  });
  test('主进程说 kiro 但没给能力（没连着 / 老主进程）→ 仍按 kiro 补成 steer', async () => {
    const r = await resolveBusyEnter({ listEngine: 'claude', ask: async () => ({ engine: 'kiro' }) });
    assert.equal(r.kind, 'steer');
    assert.equal(busyEnterKind('claude', r.busyEnter), 'steer');
  });
  test('主进程的引擎已知（推过来的）是 kiro → 不问', async () => {
    let asked = 0;
    const r = await resolveBusyEnter({ listEngine: 'claude', mainEngine: 'kiro', ask: async () => { asked++; return null; } });
    assert.equal(asked, 0);
    assert.equal(r.kind, 'steer');
  });
  test('反过来：列表说 kiro、主进程说 claude 且只声明 promptQueueing → handoff；没能力声明 → 排队', async () => {
    const a = await resolveBusyEnter({ listEngine: 'kiro', mainEngine: 'claude', ask: async () => ({ engine: 'claude', busyEnter: 'prompt-queue' }) });
    assert.equal(a.kind, 'handoff');
    assert.equal(busyEnterKind('kiro', a.busyEnter), 'handoff');
    const b = await resolveBusyEnter({ listEngine: 'kiro', ask: async () => ({ engine: 'claude' }) });
    assert.equal(b.kind, 'queue');
    assert.equal(busyEnterKind('kiro', b.busyEnter), 'queue');
  });
  test('问不到（抛错 / null）→ 退回列表里的引擎', async () => {
    const a = await resolveBusyEnter({ listEngine: 'claude', ask: async () => { throw new Error('x'); } });
    assert.equal(a.engine, 'claude');
    assert.equal(a.kind, 'queue');
    assert.equal(a.fromMain, false);
    const b = await resolveBusyEnter({ listEngine: undefined, ask: async () => null });
    assert.equal(b.kind, 'steer', '没有 engine 的老会话就是 kiro');
  });
  test('缓存着明确能力 → 不问', async () => {
    let asked = 0;
    const r = await resolveBusyEnter({ listEngine: 'claude', mainEngine: 'claude', cached: 'steering', ask: async () => { asked++; return null; } });
    assert.equal(asked, 0);
    assert.equal(r.kind, 'steer');
  });
});

describe('接线（源码）', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf-8');
  const INDEX = read('main', 'index.ts');
  const PRELOAD = read('main', 'preload.ts');
  const APP = read('renderer', 'App.tsx');
  const ACP = read('renderer', 'hooks', 'useAcp.ts');
  const between = (src: string, from: string, to: string) => {
    const at = src.indexOf(from);
    assert.ok(at >= 0, `找不到 ${from}`);
    const end = src.indexOf(to, at + from.length);
    assert.ok(end > at, `找不到 ${to}`);
    return src.slice(at, end);
  };

  test('did-finish-load（启动 / 窗口刷新 / 控制入口 /reload）推全部会话', () => {
    assert.match(INDEX, /mainWindow\.webContents\.on\('did-finish-load', \(\) => pushProfileSync\('all', 'did-finish-load'\)\);/);
    /* /reload 就是 reloadIgnoringCache —— 走的是同一个 did-finish-load */
    assert.match(between(INDEX, 'onReload: () => {', '\n      },'), /reloadIgnoringCache\(\)/);
  });
  test('attach 成功后推这一条', () => {
    const attach = between(INDEX, 'const attachPromise = (async () => {', 'attachInFlight.set(sessionId, attachPromise);');
    const ran = attach.indexOf('await lagPhases.run(`attach ${sessionId}`, attachOnce);');
    const pushed = attach.indexOf("pushProfileSync([sessionId], 'attach');");
    assert.ok(ran > 0 && pushed > ran, 'attachOnce 成功之后推');
  });
  test('S3 合并 / 恢复改了记录之后推', () => {
    const merge = between(INDEX, 'const r = await mergeBucketSession(creds!, cfg.prefix, c.id, round);', '} catch (err: any) {');
    assert.match(merge, /pushProfileSync\(\[c\.id\], 's3-merge'\);/);
    const restore = between(INDEX, "ipcMain.handle('s3:restore'", "ipcMain.handle('offload:list'");
    assert.match(restore, /pushProfileSync\(\[sessionId\], 's3-restore'\);/);
    assert.ok(restore.indexOf("pushProfileSync([sessionId], 's3-restore');") < restore.indexOf('return {\n        ok: true, restored'), '成功返回之前推');
  });
  test('推送：先对齐 ui-state（记日志），再发 session:profile-sync', () => {
    const push = between(INDEX, 'function pushProfileSync(', '\nfunction pushEngineModels(');
    assert.match(push, /reconcileUiStateProfiles\(sessions, why\);/);
    assert.match(push, /webContents\.send\('session:profile-sync', \{ sessions, why \}\)/);
    const rec = between(INDEX, 'function reconcileUiStateProfiles(', '\nfunction pushProfileSync(');
    assert.match(rec, /logger\.info\('profile-sync', `\$\{profileSyncLogLine\(fix\)\}/);
    assert.match(rec, /setUiStateKey\('kirolex-sessions', r\.raw\);/);
  });
  test('一次性迁移：水化列会话时对着记录改 ui-state', () => {
    const hydrate = between(INDEX, "ipcMain.handle('acp:list-durable-sessions'", "ipcMain.handle('acp:mark-session-purpose'");
    assert.match(hydrate, /reconcileUiStateProfiles\(recs\.map\(\(rec\) => profileSyncEntryOf\(rec, remoteTargetsNow\)\), 'hydrate'\);/);
    assert.match(hydrate, /permissionMode: rec\.profile\.permissionMode/);
  });
  test('switchEngineImpl 的 unchanged 分支也发 engine-changed（带当前引擎），并说一句「已经在用」', () => {
    const impl = between(INDEX, 'const switchEngineImpl = async (', "ipcMain.handle('acp:switch-engine'");
    const branch = between(impl, 'if (before === engine) {', 'return { ok: true, unchanged: true, engine };');
    assert.match(branch, /mainWindow\?\.webContents\.send\('session:engine-changed', \{ sessionId, engine \}\);/);
    assert.match(branch, /tr\('ℹ️ This session is already on \{engine\}\.', \{ engine: label \}\)/);
  });
  test('忙时 Enter：主进程另给引擎（acp:session-engine，kiro 也回），渲染端按它路由', () => {
    const h = between(INDEX, "ipcMain.handle('acp:session-engine'", '\n  });');
    assert.match(h, /engine: engineOf\(entry\.profile\), busyEnter: entry\.client\.busyEnter/);
    assert.match(h, /engine: engineOf\(rec\.profile\)/);
    assert.match(PRELOAD, /sessionEngine: \(sessionId: string\) => ipcRenderer\.invoke\('acp:session-engine', sessionId\)/);
    assert.match(PRELOAD, /ipcRenderer\.on\('session:profile-sync', handler\)/);
    const fn = between(APP, 'const busyEnterFor = useCallback', '}, []);');
    assert.match(fn, /resolveBusyEnter\(\{/);
    assert.match(fn, /mainEngine: mainEngineRef\.current\[sid\]/);
    assert.match(fn, /window\.kiroApi\.sessionEngine\?\.\(sid\)/);
    const refs = between(APP, 'const mainEngineRef = useRef', 'const busyEnterFor = useCallback');
    assert.match(refs, /onEngineChanged\?\.\(/);
    assert.match(refs, /onProfileSync\?\.\(/);
  });
  test('渲染层：收到 profile-sync 按记录对齐；水化时记录决定的字段以记录为准；换引擎的返回也写回列表', () => {
    assert.match(ACP, /onProfileSync\?\.\([\s\S]{0,600}alignSessions\(prev, entries\)/);
    assert.match(ACP, /byId\.set\(rec\.id, applyProfileEntry\(cur, profileSyncEntryFromDiskRow\(rec\)\)\)/);
    assert.match(ACP, /const offResult = onEngineSwitchResult\(setEngine\);/);
    assert.match(read('renderer', 'components', 'Sidebar.tsx'), /api\.switchEngine\(sessionId, engine, coldHintFor\(sessionId\)\)[^\n]*\n[^\n]*\n\s*noteEngineSwitchResult\(sessionId, r\);/);
    assert.match(read('renderer', 'components', 'ChatArea.tsx'), /switchEngine\?\.\(sessionId, targetEngine\);\s*noteEngineSwitchResult\(sessionId, r\);/);
  });
});

/* 类型留着用：ProfileSyncEntry 是推送的形状 */
const _shape: ProfileSyncEntry = { id: 'x', engine: 'kiro', permissionMode: 'ask' };
void _shape;
