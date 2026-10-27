/**
 * 「本机 Claude Code / kiro / Codex 跑不起来时有没有提示」的缺口（渲染层那一半）：
 *   · 本机 kiro-cli 没装 / 没配的那两句提示带「安装 kiro-cli」；本机「没登录」那句带「登录」；
 *   · 登录：开终端 → 轮询到登上 → 自动重连；等不到就说；
 *   · 新建会话框 / 设置 → 机器 → 本机：状态面板（❌ 点了装、⚠️ 点了登录、远端给去哪登）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { adapterInstallOffer, engineLoginOffer } from '../src/renderer/adapterInstallOffer.ts';
import { createAdapterInstallStore, runEngineLogin, waitUntil } from '../src/renderer/adapterInstallState.ts';
import { createEngineStatusStore, stateIcon, type EngineStatusLite } from '../src/renderer/engineStatusView.ts';
import { connectFailureNotice, adapterInstalledNotice } from '../src/renderer/connectFailure.ts';
import { kiroBinProblem, setLocalKiroBin } from '../src/main/acp-client.ts';
import { adapterAuthMessage } from '../src/main/engines.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');
const noSleep = async () => {};

describe('本机 kiro-cli 没装 / 没配：提示上带「安装 kiro-cli」', () => {
  test('「还没有设置本机的 kiro 启动命令」中英都认（用主进程真说的那句）', () => {
    setLocalKiroBin(undefined);
    const msg = kiroBinProblem()!;
    assert.deepEqual(adapterInstallOffer(connectFailureNotice(msg, 1, 'zh').content), { engine: 'kiro' });
    assert.deepEqual(adapterInstallOffer('还没有设置**本机**的 kiro 启动命令。打开 设置 → 🖥 机器 → 💻 本机'), { engine: 'kiro' });
  });
  test('「kiro-cli not found. Tried these」中英都认', () => {
    assert.deepEqual(adapterInstallOffer('kiro-cli not found. Tried these:\nC:\\x\\kiro-cli.exe'), { engine: 'kiro' });
    assert.deepEqual(adapterInstallOffer('kiro-cli 找不到。试过这些：\n/usr/local/bin/kiro-cli'), { engine: 'kiro' });
  });
  test('远端的 kiro 那句（说的是 {host}）不给本机安装按钮', () => {
    assert.equal(adapterInstallOffer('还没有设置 graviton 上的 kiro 启动命令（设置 → 🖥 机器）。'), null);
    assert.equal(adapterInstallOffer('No kiro launch command is set for graviton yet (Settings → 🖥 Machines).'), null);
  });
  test('原来那几种（Claude Code / Codex 适配器）照旧', () => {
    assert.deepEqual(adapterInstallOffer('没找到 Codex 的 ACP 适配器。装一下：`npm i -g @agentclientprotocol/codex-acp`'), { engine: 'codex' });
  });
  test('装好重连上的提示：kiro-cli / 登录 各有各的说法', () => {
    assert.match(adapterInstalledNotice('kiro', 1, 'zh').content, /kiro-cli 装好了/);
    assert.match(adapterInstalledNotice('claude', 1, 'zh', 'login').content, /Claude Code 登录好了/);
    assert.match(adapterInstalledNotice('codex', 1, 'zh').content, /ACP 适配器装好了/);
  });
});

describe('本机没登录：提示上带「登录」', () => {
  test('主进程那句（adapterAuthMessage）中英都认，按名字判哪一家', () => {
    assert.deepEqual(engineLoginOffer(adapterAuthMessage('claude')), { engine: 'claude' });
    assert.deepEqual(engineLoginOffer(adapterAuthMessage('codex')), { engine: 'codex' });
    assert.deepEqual(engineLoginOffer('Codex is not logged in on the machine running this session. Run `codex login`'), { engine: 'codex' });
    assert.deepEqual(engineLoginOffer('跑这条会话的那台机器上 Claude Code 还没登录。'), { engine: 'claude' });
    assert.equal(engineLoginOffer('ECONNREFUSED'), null);
  });

  test('开终端 → 轮询到登上 → 重连；状态 logging-in → reconnecting → connected', async () => {
    const store = createAdapterInstallStore();
    const phases: string[] = [];
    store.subscribe(() => { const s = store.get('s1'); if (s && phases[phases.length - 1] !== s.phase) phases.push(s.phase); });
    let checks = 0;
    const reconnected: string[] = [];
    const ok = await runEngineLogin(store, 's1', 'claude', {
      login: async (engine) => { assert.equal(engine, 'claude'); return { ok: true, opened: true }; },
      loggedIn: async () => { checks += 1; return checks >= 3; },
      reconnect: async (sid) => { reconnected.push(sid); return { ok: true }; },
      intervalMs: 1, timeoutMs: 60_000, sleep: noSleep,
    });
    assert.equal(ok, true);
    assert.equal(checks, 3);
    assert.deepEqual(reconnected, ['s1']);
    assert.deepEqual(phases, ['logging-in', 'reconnecting', 'connected']);
    assert.equal(store.get('s1')!.via, 'login');
  });

  test('终端开不了：login-failed 带原因，不重连', async () => {
    const store = createAdapterInstallStore();
    let reconnects = 0;
    const ok = await runEngineLogin(store, 's2', 'codex', {
      login: async () => ({ ok: false, error: '登录 Codex 要有 codex 命令' }),
      loggedIn: async () => true,
      reconnect: async () => { reconnects += 1; return { ok: true }; },
      sleep: noSleep,
    });
    assert.equal(ok, false);
    assert.equal(reconnects, 0);
    assert.equal(store.get('s2')!.phase, 'login-failed');
    assert.match(store.get('s2')!.error!, /codex 命令/);
  });

  test('一直没登上：到时间就停，login-failed，不重连', async () => {
    const store = createAdapterInstallStore();
    let t = 0;
    const ok = await runEngineLogin(store, 's3', 'claude', {
      login: async () => ({ ok: true, opened: true }),
      loggedIn: async () => false,
      reconnect: async () => { throw new Error('不该重连'); },
      intervalMs: 1000, timeoutMs: 5000, sleep: async (ms) => { t += ms; }, now: () => t,
    });
    assert.equal(ok, false);
    assert.equal(store.get('s3')!.phase, 'login-failed');
  });

  test('waitUntil：check 抛错当作还没好；取消就停', async () => {
    let n = 0;
    assert.equal(await waitUntil(async () => { n += 1; if (n < 2) throw new Error('x'); return true; }, { intervalMs: 1, timeoutMs: 1000, sleep: noSleep }), true);
    assert.equal(await waitUntil(async () => false, { intervalMs: 1, timeoutMs: 1000, sleep: noSleep, cancelled: () => true }), false);
  });
});

describe('状态面板的 store：❌ 装 / ⚠️ 登录 / 远端给去哪登', () => {
  const st = (engine: 'kiro' | 'claude' | 'codex', state: EngineStatusLite['state']): EngineStatusLite => ({ engine, state });

  test('图标', () => {
    assert.deepEqual(['ok', 'not-logged-in', 'missing', 'unknown'].map((s) => stateIcon(s as any)), ['✅', '⚠️', '❌', '⚪']);
  });

  test('取一次状态；同一台机器同时只问一次；force 交给主进程', async () => {
    const calls: Array<[string, boolean]> = [];
    const store = createEngineStatusStore({
      fetch: async (m, force) => { calls.push([m, force]); return { ok: true, statuses: [st('kiro', 'missing'), st('claude', 'ok'), st('codex', 'not-logged-in')] }; },
      install: async () => ({ ok: true }), login: async () => ({ ok: true }),
    });
    await Promise.all([store.load('local'), store.load('local')]);
    assert.deepEqual(calls, [['local', false]]);
    assert.equal(store.status('local', 'kiro')!.state, 'missing');
    await store.load('local', true);
    assert.deepEqual(calls[1], ['local', true]);
  });

  test('❌ 装：装完重新检测（跳过缓存）；失败留着原因', async () => {
    let installed = false;
    const fetches: boolean[] = [];
    const store = createEngineStatusStore({
      fetch: async (_m, force) => { fetches.push(force); return { ok: true, statuses: [st('kiro', installed ? 'not-logged-in' : 'missing')] }; },
      install: async (m, e) => { assert.equal(m, 'local'); assert.equal(e, 'kiro'); installed = true; return { ok: true }; },
      login: async () => ({ ok: true }),
    });
    await store.load('local');
    assert.equal(await store.install('local', 'kiro'), true);
    assert.equal(store.status('local', 'kiro')!.state, 'not-logged-in');
    assert.equal(fetches[fetches.length - 1], true);
    const bad = createEngineStatusStore({
      fetch: async () => ({ ok: true, statuses: [st('kiro', 'missing')] }),
      install: async () => ({ ok: false, error: '❌ 在本机安装 kiro-cli 没成功：exit 1603\n可以到官方页面自己下载安装：https://kiro.dev/docs/cli/installation/' }),
      login: async () => ({ ok: true }),
    });
    assert.equal(await bad.install('local', 'kiro'), false);
    const a = bad.get('local')!.actions.kiro!;
    assert.equal(a.phase, 'install-failed');
    assert.match(a.error!, /kiro\.dev/);
  });

  test('⚠️ 本机登录：开终端后轮询到 ok 为止；远端：给去哪登，不轮询', async () => {
    let polls = 0;
    const store = createEngineStatusStore({
      fetch: async (_m, force) => { if (force) polls += 1; return { ok: true, statuses: [st('codex', polls >= 2 ? 'ok' : 'not-logged-in')] }; },
      install: async () => ({ ok: true }),
      login: async (m) => (m === 'local' ? { ok: true, opened: true } : { ok: true, how: '用会话左下角的 🔑 登录' }),
      loginPollMs: 1, loginTimeoutMs: 60_000, sleep: noSleep,
    });
    assert.equal(await store.login('local', 'codex'), true);
    assert.equal(store.status('local', 'codex')!.state, 'ok');
    assert.equal(store.get('local')!.actions.codex, undefined);
    const before = polls;
    assert.equal(await store.login('tokyo', 'codex'), false);
    assert.equal(store.get('tokyo')!.actions.codex!.phase, 'login-how');
    assert.match(store.get('tokyo')!.actions.codex!.how!, /🔑/);
    assert.equal(polls, before);
  });
});

describe('接线', () => {
  const M = read('src', 'main', 'index.ts');
  const P = read('src', 'main', 'preload.ts');
  const A = read('src', 'renderer', 'App.tsx');
  const R = read('src', 'renderer', 'components', 'RemoteSettings.tsx');
  const C = read('src', 'renderer', 'components', 'ChatArea.tsx');
  const U = read('src', 'renderer', 'hooks', 'useAcp.ts');

  test('主进程：engines:status（5 分钟缓存）/ engines:install / engines:login 都注册了', () => {
    assert.match(M, /ipcMain\.handle\('engines:status'/);
    assert.match(M, /ipcMain\.handle\('engines:install'/);
    assert.match(M, /ipcMain\.handle\('engines:login'/);
    const fn = M.slice(M.indexOf('async function engineStatusesFor('), M.indexOf('async function engineStatusesFor(') + 1200);
    assert.match(fn, /engineStatusCache\.get\(key\)/);
    assert.match(fn, /engineStatusCache\.set\(key, statuses\)/);
  });

  test('本机 kiro-cli：先找已有的、没有再跑官方安装器（家目录），找到就存成本机启动命令；会话里的「安装」也能装 kiro', () => {
    const fn = M.slice(M.indexOf('async function installLocalKiro('), M.indexOf('async function installLocalKiro(') + 3000);
    assert.match(fn, /detectLocalBins\(\)/);
    assert.match(fn, /kiroInstallCommand\(process\.platform, os\.homedir\(\), shellEnv\)/);
    assert.match(fn, /saveLocalBins\(KIROLEX_CONFIG_PATH/);
    assert.match(fn, /kiroInstallFailedMessage\(/);
    const h = M.slice(M.indexOf("ipcMain.handle('acp:install-adapter'"), M.indexOf("ipcMain.handle('acp:install-adapter'") + 2500);
    assert.match(h, /if \(engine === 'kiro' && remote\?\.sshHost\)/);
    assert.match(h, /runEngineInstall\(remote, engine, send\)/);
  });

  test('本机登录：开终端跑登录命令', () => {
    const h = M.slice(M.indexOf("ipcMain.handle('engines:login'"), M.indexOf("ipcMain.handle('engines:login'") + 1800);
    assert.match(h, /localLoginArgv\(engine\)/);
    assert.match(h, /openLoginTerminal\(/);
  });

  test('preload 暴露四个包装', () => {
    for (const k of ['enginesStatus', 'enginesInstall', 'onEnginesInstallOutput', 'enginesLogin']) assert.match(P, new RegExp(`${k}: \\(`));
  });

  test('新建会话框：按将要运行的那台机器（本机 / 选中的远端）显示状态面板，高亮选中的引擎', () => {
    assert.match(A, /const target = newChatRemoteId \? remoteTargets\.targets\.find\(\(r\) => r\.id === newChatRemoteId\) : undefined;/);
    assert.match(A, /<EngineStatusPanel\s+compact\s+machine=\{target \? target\.id : 'local'\}\s+selected=\{newChatEngine\}/);
  });

  test('设置 → 机器 → 本机：列出三个引擎的状态', () => {
    const at = R.indexOf('{localOnly && (');
    assert.match(R.slice(at, at + 600), /<EngineStatusPanel machine="local"/);
  });

  test('新建会话框：点状态面板的一行直接选中那家（onSelect=setNewChatEngine）；设置页不传、不可点', () => {
    assert.match(A, /<EngineStatusPanel\s+compact\s+machine=\{target \? target\.id : 'local'\}\s+selected=\{newChatEngine\}\s+onSelect=\{setNewChatEngine\}/);
    const at = R.indexOf('<EngineStatusPanel');
    assert.doesNotMatch(R.slice(at, R.indexOf('/>', at)), /onSelect/);
    const S = read('src', 'renderer', 'components', 'EngineStatusPanel.tsx');
    assert.match(S, /onSelect\?: \(e: EngineId\) => void;/);
    // 传了 onSelect 才是 radiogroup / radio、可聚焦、Enter / 空格选中
    assert.match(S, /role=\{onSelect \? 'radiogroup' : undefined\}/);
    assert.match(S, /role: 'radio', 'aria-checked': selected === e, tabIndex: 0,\s*onClick: \(\) => onSelect\(e\),/);
    assert.match(S, /if \(ev\.key === 'Enter' \|\| ev\.key === ' '\) \{ ev\.preventDefault\(\); onSelect\(e\); \}/);
    assert.match(S, /engine-status-row\$\{selected === e \? ' selected' : ''\}\$\{onSelect \? ' selectable' : ''\}/);
    // 行里的安装 / 登录 / 官方下载按钮不能顺带切换引擎
    assert.match(S, /onClick=\{\(ev\) => \{ ev\.stopPropagation\(\); void store\.install\(machine, e\); \}\}/);
    assert.match(S, /onClick=\{\(ev\) => \{ ev\.stopPropagation\(\); void store\.login\(machine, e\); \}\}/);
    assert.match(S, /onClick=\{\(ev\) => \{ ev\.stopPropagation\(\); void \(window as any\)\.kiroApi\?\.openExternal\?\.\(KIRO_DOWNLOAD_URL\); \}\}/);
    // 按钮上按 Enter / 空格是按按钮本身，不冒泡到行上去选引擎
    assert.match(S, /onKeyDown: \(ev: React\.KeyboardEvent\) => \{\s*if \(ev\.target !== ev\.currentTarget\) return;/);
    const css = read('src', 'renderer', 'styles', 'global.css');
    assert.match(css, /\.engine-status-row\.selectable \{ cursor: pointer; \}/);
    assert.match(css, /\.engine-status-row\.selectable:hover/);
  });

  test('会话里：本机会话的「没登录」给登录按钮；useAcp 登记登录 runner（轮询本机状态）', () => {
    assert.match(C, /remote=\{!!remoteHostLabel\}/);
    assert.match(C, /startEngineLogin\(sessionId, login\.engine\)/);
    assert.match(U, /setEngineLoginRunner\(\{/);
    assert.match(U, /enginesStatus\?\.\('local', \{ force: true \}\)/);
  });
});
