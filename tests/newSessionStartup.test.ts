/**
 * 新建会话：引擎起来之前显示「正在启动」、第一条消息排队、不对还没建完的会话发错的本机 attach。
 *
 * 用户反馈（2026-10-23，s_1792726606826_e2mprs，远程 aws-tokyo-4）：新建远程会话到能发消息隔了 34 秒，
 * 界面上什么都没有，先打的那条消息看着像已经发出却没反应；第 10 秒还有一路按本机 kiro 去 attach 这条
 * 还没写盘的会话（「attach 失败 engine=kiro remote=local：该会话在磁盘上不存在」）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCreationGate, type CreationInfo } from '../src/main/creationGate.ts';
import { applyCreateStage, clearCreateStage, retryCreateArgs, settleStageOnAttach, startupBlocksSend, startupElapsedSeconds, startupSteps, type CreateArgs, type CreateStageInfo } from '../src/renderer/createStages.ts';
import { enterRoute } from '../src/renderer/steerRoute.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
const MAIN = read('main', 'index.ts');
const ACP = read('renderer', 'hooks', 'useAcp.ts');
const APP = read('renderer', 'App.tsx');
const CHAT = read('renderer', 'components', 'ChatArea.tsx');

describe('creationGate：主进程记下正在新建的会话', () => {
  test('建的时候算「正在建」，阶段按顺序推；建成推 ready、摘掉', async () => {
    const seen: CreationInfo[] = [];
    let t = 1000;
    const gate = createCreationGate({ onChange: (i) => seen.push(i), now: () => t });
    let release!: () => void;
    const p = gate.run('s1', { engine: 'claude', remote: true }, () => new Promise<string>((r) => { release = () => r('ok'); }));
    assert.equal(gate.creating('s1'), true);
    assert.deepEqual(gate.ids(), ['s1']);
    gate.stage('s1', 'check');
    gate.stage('s1', 'start');
    assert.equal(gate.snapshot()[0].stage, 'start');
    t = 5000;
    release();
    assert.equal(await p, 'ok');
    assert.equal(gate.creating('s1'), false);
    assert.deepEqual(seen.map((i) => i.stage), ['connect', 'check', 'start', 'ready']);
    assert.ok(seen.every((i) => i.engine === 'claude' && i.remote && i.startedAt === 1000));
  });

  test('本地会话从「检查环境」开始（没有连接远端那一步）', async () => {
    const seen: CreationInfo[] = [];
    const gate = createCreationGate({ onChange: (i) => seen.push(i) });
    await gate.run('s2', { engine: 'kiro', remote: false }, async () => 1);
    assert.deepEqual(seen.map((i) => i.stage), ['check', 'ready']);
  });

  test('建失败：推 failed（带原因和卡在哪一步），原样抛；settle 告诉等它的人失败了', async () => {
    const seen: CreationInfo[] = [];
    const gate = createCreationGate({ onChange: (i) => seen.push(i) });
    const p = gate.run('s3', { engine: 'kiro', remote: true }, async () => { throw new Error('连不上 aws-tokyo-4'); });
    const waiting = gate.settle('s3');
    await assert.rejects(p, /连不上/);
    assert.deepEqual(await waiting, { ok: false, error: '连不上 aws-tokyo-4' });
    const last = seen[seen.length - 1];
    assert.equal(last.stage, 'failed');
    assert.equal(last.failedAt, 'connect');
    assert.equal(last.error, '连不上 aws-tokyo-4');
    assert.equal(gate.creating('s3'), false);
  });

  test('创建失败后刷新窗口：快照里还有这条失败（原因、卡在哪一步、是不是远程），重试开始 / 连上后才清掉', async () => {
    let t = 100;
    const gate = createCreationGate({ now: () => t });
    await assert.rejects(gate.run('s4', { engine: 'claude', remote: true }, async () => { gate.stage('s4', 'check'); throw new Error('连不上'); }));
    /* 刷新后的渲染层：拿快照重建阶段表 */
    const snap = gate.snapshot();
    assert.equal(snap.length, 1);
    let m: Record<string, CreateStageInfo> = {};
    for (const info of snap) m = applyCreateStage(m, info as CreateStageInfo);
    assert.equal(m.s4.stage, 'failed');
    assert.equal(m.s4.error, '连不上');
    assert.equal(m.s4.remote, true, '远程：横幅上「重试」和「改成本机运行」两个按钮都在');
    assert.deepEqual(startupSteps(m.s4).map((s) => s.state), ['done', 'failed', 'todo', 'todo']);
    assert.equal(startupBlocksSend(m.s4), true, '排队的先不发');
    assert.equal(gate.creating('s4'), false, '失败了不算「正在建」：attach 不再等它');
    /* 重试开始：失败记录换成新的这一次 */
    t = 200;
    let release!: () => void;
    const again = gate.run('s4', { engine: 'claude', remote: true }, () => new Promise<void>((r) => { release = r; }));
    assert.deepEqual(gate.snapshot().map((i) => i.stage), ['connect']);
    release();
    await again;
    assert.deepEqual(gate.snapshot(), []);
    /* 普通 attach 连上了：clearFailed */
    await assert.rejects(gate.run('s5', { engine: 'kiro', remote: false }, async () => { throw new Error('x'); }));
    gate.clearFailed('s5');
    assert.deepEqual(gate.snapshot(), []);
  });

  test('主进程：attach 连上 / 删掉会话时把失败记录作废；渲染层拿快照时失败的也收进来', () => {
    const fn = MAIN.slice(MAIN.indexOf('const loadSessionImpl = async ('), MAIN.indexOf("ipcMain.handle('acp:load-session'"));
    assert.match(fn, /creations\.clearFailed\(sessionId\);\n\s*newSessionArgs\.delete\(sessionId\);\n[\s\S]{0,200}modelFallback\.commit\(sessionId\);\n\s*return \{ ok: true, freshBackend: freshBackendResult \};/);
    const purge = MAIN.slice(MAIN.indexOf('const purgeSession = async ('));
    assert.match(purge.slice(0, 600), /creations\.clearFailed\(sessionId\);/);
    assert.match(ACP, /window\.kiroApi\.getCreateStages\?\.\(\)\.then\(\(list\) => \{ for \(const info of list \|\| \[\]\) take\(info\); \}\)/);
  });

  test('刷新后：快照到之前排空不动（恢复出来的排队消息不能抢在「启动失败」之前发出去）', () => {
    assert.match(ACP, /\.finally\(\(\) => setCreateStagesLoaded\(true\)\);/);
    const drain = APP.slice(APP.indexOf('// Drain every session independently when it becomes idle.'));
    const guard = drain.indexOf('if (!createStagesLoaded) return;');
    assert.ok(guard > 0 && guard < drain.indexOf('for (const [sessionId, queue] of Object.entries(queuesBySession))'));
  });

  test('没在建的会话：settle 立即给 null（attach 照常走），stage 忽略', async () => {
    const gate = createCreationGate();
    assert.equal(await gate.settle('nope'), null);
    gate.stage('nope', 'start');
    assert.deepEqual(gate.snapshot(), []);
  });
});

describe('创建中的会话不触发默认 attach', () => {
  test('主进程 loadSessionImpl：正在建 → 等它建完，建成直接返回；在读记录 / 起执行器之前判', () => {
    const fn = MAIN.slice(MAIN.indexOf('const loadSessionImpl = async ('), MAIN.indexOf("ipcMain.handle('acp:load-session'"));
    const gate = fn.indexOf('if (creations.creating(sessionId)) {');
    assert.ok(gate > 0, 'attach 要先看是不是正在建');
    assert.ok(gate < fn.indexOf('store.readRecord(sessionId)'), '在读记录之前');
    assert.ok(gate < fn.indexOf('attachInFlight.get(sessionId)'), '在起执行器之前');
    const body = fn.slice(gate, gate + 600);
    assert.match(body, /await creations\.settle\(sessionId\)/);
    assert.match(body, /if \(sessionClients\.get\(sessionId\)\) return \{ ok: true/);
  });

  test('acp:new-session 整段登记成「正在新建」', () => {
    assert.match(MAIN, /ipcMain\.handle\('acp:new-session', async \([\s\S]{0,1500}\) => creations\.run\(kiroLexId, \{ engine: engineOf\(\{ engine: engineArg \}\), remote: !!remoteId \}, async \(\) => \{/);
  });

  test('渲染层切会话 / 预热：还在新建的不去 loadSession', () => {
    const sw = ACP.slice(ACP.indexOf('const needsLoad = !attachedIdsRef.current.has(sessionId)'));
    assert.match(sw.slice(0, 900), /if \(!isArchived && needsLoad && !creatingRef\.current\.has\(sessionId\)\) \{/);
    const warm = ACP.slice(ACP.indexOf('const warmSession = useCallback('));
    const guard = warm.indexOf('if (creatingRef.current.has(sessionId)) return;');
    assert.ok(guard > 0 && guard < warm.indexOf('window.kiroApi.loadSession('), '预热要在 loadSession 之前判');
  });
});

describe('就绪前发送 → 排队，就绪后自动发出，可撤回', () => {
  const starting: CreateStageInfo = { sessionId: 's', stage: 'connect', engine: 'claude', remote: true, startedAt: 0 };

  test('在建 / 失败都挡住发送；就绪放行；没有阶段也放行', () => {
    for (const stage of ['connect', 'check', 'start', 'failed'] as const) assert.equal(startupBlocksSend({ ...starting, stage }), true, stage);
    assert.equal(startupBlocksSend({ ...starting, stage: 'ready' }), false);
    assert.equal(startupBlocksSend(undefined), false);
  });

  test('主进程报 creating = 占用：Enter 走排队（和重建历史、换模型一样）', () => {
    assert.match(ACP, /OCCUPYING_BUSY_REASONS = new Set\(\[[^\]]*'creating'/);
    assert.equal(enterRoute({ streaming: false, busy: 'creating', occupied: true, looping: false, canSteer: true }), 'queue');
    const busy = MAIN.slice(MAIN.indexOf('function busyReasonFor('));
    assert.match(busy.slice(0, 300), /if \(creations\.creating\(sessionId\)\) return 'creating';/);
    assert.match(MAIN, /\.\.\.creations\.ids\(\),/);   // 窗口刷新后的忙闲快照里也有
  });

  test('handleSendMessage 引擎没就绪就进排队；排空 effect 等它就绪', () => {
    const send = APP.slice(APP.indexOf('const handleSendMessage = useCallback('));
    assert.match(send.slice(0, 3500), /\|\| startupBlocksSend\(createStages\[sid\]\)\)\) \{[\s\S]{0,400}queueMessageRef\.current\?\.\(text, pastes, sid\);/);
    const drain = APP.slice(APP.indexOf('// Drain every session independently when it becomes idle.'));
    assert.match(drain.slice(0, 2500), /startupBlocksSend\(createStages\[sessionId\]\) \|\|/);
  });

  test('排队卡片：引擎没就绪时标题是「排队中，<引擎> 就绪后自动发出」，卡片照旧能编辑 / 撤回', () => {
    assert.match(CHAT, /waitingForEngine \? t\('Queued — sends automatically once \{engine\} is ready', \{ engine: waitingForEngine \}\)/);
    assert.match(CHAT, /waitingForEngine=\{startup && startup\.stage !== 'ready' \? engineDisplayName\(startup\.engine\) : undefined\}/);
    const stack = CHAT.slice(CHAT.indexOf('const QueueStack = memo<{'));
    assert.match(stack, /onCancelQueuedMessage\(item\.id\)/);
    assert.match(stack, /onEditQueuedMessage\(item\.id, editingQueueText\)/);
  });
});

describe('启动阶段条', () => {
  const base: CreateStageInfo = { sessionId: 's', stage: 'check', engine: 'kiro', remote: true, startedAt: 10_000 };

  test('远程四步：连接远端 → 检查环境 → 启动引擎 → 就绪；本地少「连接远端」', () => {
    assert.deepEqual(startupSteps(base).map((s) => `${s.key}:${s.state}`), ['connect:done', 'check:active', 'start:todo', 'ready:todo']);
    assert.deepEqual(startupSteps({ ...base, remote: false, stage: 'start' }).map((s) => `${s.key}:${s.state}`), ['check:done', 'start:active', 'ready:todo']);
    assert.ok(startupSteps({ ...base, stage: 'ready' }).every((s) => s.state === 'done'));
  });

  test('失败：标在卡住的那一步', () => {
    assert.deepEqual(startupSteps({ ...base, stage: 'failed', failedAt: 'start', error: 'x' }).map((s) => s.state), ['done', 'done', 'failed', 'todo']);
  });

  test('已用秒数', () => {
    assert.equal(startupElapsedSeconds(base, 44_900), 34);
    assert.equal(startupElapsedSeconds(base, 0), 0);
  });

  test('推送合并：重试之前那次的失败晚到了不覆盖新的；就绪到点摘掉，没就绪的不摘', () => {
    let m = applyCreateStage({}, { ...base, startedAt: 2 });
    m = applyCreateStage(m, { ...base, stage: 'failed', startedAt: 1 });
    assert.equal(m.s.stage, 'check');
    assert.equal(clearCreateStage(m, 's', true), m);
    m = applyCreateStage(m, { ...base, stage: 'ready', startedAt: 2 });
    assert.deepEqual(clearCreateStage(m, 's', true), {});
  });
});

describe('创建失败 → 提示 + 重试 / 改成本机运行', () => {
  test('阶段条失败时显示原因和「重试」，远程会话再给「改成本机运行」', () => {
    const banner = CHAT.slice(CHAT.indexOf('function StartupBanner('), CHAT.indexOf('const QueueStack = memo<{'));
    assert.match(banner, /info\.stage === 'failed' && \(/);
    assert.match(banner, /onClick=\{\(\) => onRetry\(false\)\}>\{t\('Retry'\)\}/);
    assert.match(banner, /\{info\.remote && \([\s\S]{0,200}onClick=\{\(\) => onRetry\(true\)\}/);
    assert.match(CHAT, /\{startup && <StartupBanner info=\{startup\} onRetry=\{onRetryStartup\} \/>\}/);
    assert.match(APP, /onRetryStartup=\{\(local\) => \{ if \(sid\) void retryCreateSession\(sid, \{ local \}\); \}\}/);
  });

  test('重试参数：本窗口记的优先，窗口刷新过就用主进程留的那份；改成本机去掉机器；都没有就不建', () => {
    const a: CreateArgs = { cwd: '~', model: 'default', remoteId: 'tokyo', engine: 'claude', projectId: 'p' };
    const b: CreateArgs = { cwd: '/x', model: 'm2', remoteId: 'osaka', engine: 'kiro' };
    assert.deepEqual(retryCreateArgs(a, b, false), a);
    assert.deepEqual(retryCreateArgs(undefined, a, false), a, '刷新后：主进程那份');
    assert.deepEqual(retryCreateArgs(undefined, a, true), { ...a, remoteId: undefined }, '改成本机：只去掉机器');
    assert.equal(retryCreateArgs(undefined, null, false), null);
    retryCreateArgs(a, null, true);
    assert.equal(a.remoteId, 'tokyo', '不改调用方手里那份');
  });

  test('主进程留着没建成的新会话的参数（建成就删），渲染层拿不到自己那份时去取', () => {
    const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('acp:new-session'"), MAIN.indexOf("ipcMain.handle('acp:get-create-stages'"));
    const set = h.indexOf('newSessionArgs.set(kiroLexId, { cwd, model,');
    assert.ok(set > 0 && set < h.indexOf('connectWithModelFallback('), '起执行器（可能失败）之前就记');
    assert.ok(h.indexOf('newSessionArgs.delete(kiroLexId)') > h.indexOf('rec.cliSessionId = cliSessionId;'), '建成之后才删');
    assert.match(MAIN, /ipcMain\.handle\('acp:get-create-args', async \(_event, sessionId: string\) => newSessionArgs\.get\(/);
    const fn = ACP.slice(ACP.indexOf('const retryCreateSession = useCallback('), ACP.indexOf('function startCreate('));
    assert.match(fn, /if \(!mine\) \{ try \{ fromMain = \(await window\.kiroApi\.getCreateArgs\?\.\(sid\)\) \|\| null;/);
    assert.match(fn, /const next = retryCreateArgs\(mine, fromMain, !!opts\?\.local\);/);
  });

  test('连上了（任何一条路）就收掉失败的阶段条，排队的才能发；本窗口正在新建的那条不动', () => {
    const failed: CreateStageInfo = { sessionId: 's', stage: 'failed', engine: 'claude', remote: true, startedAt: 1, error: 'x', failedAt: 'connect' };
    const m = { s: failed };
    assert.equal(startupBlocksSend(m.s), true);
    const after = settleStageOnAttach(m, 's', false);
    assert.equal(after.s, undefined);
    assert.equal(startupBlocksSend(after.s), false, '收掉之后排空 effect 不再被挡');
    assert.equal(settleStageOnAttach(m, 's', true), m, '正在新建的不动');
    assert.equal(settleStageOnAttach(m, 'other', false), m);
    const add = ACP.slice(ACP.indexOf('const addAttached = (sid: string) => {'));
    assert.match(add.slice(0, 400), /setCreateStages\(\(prev\) => settleStageOnAttach\(prev, sid, creatingRef\.current\.has\(sid\)\)\);/);
  });

  test('retryCreateSession 照原参数再建；改成本机时去掉机器（侧栏徽标、intendedRemote 一起）', () => {
    const fn = ACP.slice(ACP.indexOf('const retryCreateSession = useCallback('), ACP.indexOf('function startCreate('));
    assert.match(fn, /if \(!next \|\| creatingRef\.current\.has\(sid\)\) return;/);
    assert.match(fn, /intendedRemoteRef\.current\.delete\(sid\)/);
    assert.match(fn, /remoteHost: undefined, remoteId: undefined/);
    assert.match(fn, /await startCreate\(sid, next\)/);
  });

  test('新建失败：阶段条换成失败 + 原因（IPC 本身失败时也有）', () => {
    const fn = ACP.slice(ACP.indexOf('function startCreate('));
    assert.match(fn.slice(0, 4000), /stage: 'failed', error: why/);
  });
});

describe('record.profile.engine 写明，记录在起执行器之前落盘', () => {
  const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('acp:new-session'"), MAIN.indexOf("ipcMain.handle('acp:get-create-stages'"));

  test('profile 里 engine 总是写（kiro 也写），来自创建参数', () => {
    const profile = h.slice(h.indexOf('const profile: AgentProfile = {'), h.indexOf('};', h.indexOf('const profile: AgentProfile = {')));
    assert.match(profile, /\n\s*engine,\n/);
    assert.doesNotMatch(profile, /engine !== 'kiro' \? \{ engine \}/);
    assert.match(h, /const engine = engineOf\(\{ engine: engineArg \}\);/);
  });

  test('先写一份记录（没有 cliSessionId），在预检 / 起执行器之前；建成后在它上面补', () => {
    const early = h.indexOf('const early = store.readRecord(kiroLexId);');
    assert.ok(early > 0);
    assert.ok(early < h.indexOf('await remotePreflight(profile.remote)'), '在远端预检之前');
    assert.ok(early < h.indexOf('connectWithModelFallback('), '在起执行器之前');
    assert.ok(early > h.indexOf("throw new Error(tr('Remote target {id} not found"), '机器找不到的不写');
    assert.match(h, /const rec = store\.readRecord\(kiroLexId\) \|\| store\.createSession\(kiroLexId, profile\);\n\s*rec\.profile = profile;\n\s*rec\.cliSessionId = cliSessionId;/);
    /* 重试 / 改成本机：没建成过的记录按这一次的机器和引擎改 */
    assert.match(h, /else if \(!early\.cliSessionId\) \{[\s\S]{0,200}early\.profile = \{ \.\.\.profile \};/);
  });
});
