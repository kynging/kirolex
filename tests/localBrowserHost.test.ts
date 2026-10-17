import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LocalBrowserHost, normalizeLocalBrowserConfig, readLocalBrowserConfig, writeLocalBrowserConfig, type DomainAsk,
} from '../src/main/localBrowserHost.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function cfgPath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-lbhost-'));
  dirs.push(d);
  return path.join(d, 'config.json');
}

test('设置：默认关；坏值退回默认；只改 localBrowser 这一个键', () => {
  assert.deepEqual(normalizeLocalBrowserConfig(undefined), { enabled: false, browser: 'auto', firefoxPort: 9222 });
  assert.deepEqual(normalizeLocalBrowserConfig({ enabled: 'yes', browser: 'netscape', firefoxPort: 80 }), { enabled: false, browser: 'auto', firefoxPort: 9222 });
  const p = cfgPath();
  fs.writeFileSync(p, JSON.stringify({ executorCap: 7 }));
  writeLocalBrowserConfig(p, { enabled: true, browser: 'edge' });
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(raw.executorCap, 7, '别的设置不动');
  assert.deepEqual(readLocalBrowserConfig(p), { enabled: true, browser: 'edge', firefoxPort: 9222 });
});

test('新域名确认：界面答复决定结果；没有窗口 = 拒绝；超时之后的答复被忽略', async () => {
  const asks: DomainAsk[] = [];
  let window = true;
  const host = new LocalBrowserHost({
    configPath: cfgPath(),
    log: () => {},
    sendAsk: (a) => { if (!window) return false; asks.push(a); return true; },
    filesDir: () => os.tmpdir(),
    onAction: () => {},
  });
  const ask = (host as any).askDomain('s1', 'w.example.com', 'https://w.example.com/') as Promise<string>;
  assert.equal(asks.length, 1);
  assert.deepEqual(host.pendingAsks().map((a) => a.host), ['w.example.com']);
  assert.ok(host.answer(asks[0].id, 'session'));
  assert.equal(await ask, 'session');
  assert.equal(host.answer(asks[0].id, 'once'), false, '答过的不能再答');
  window = false;
  assert.equal(await (host as any).askDomain('s1', 'x.example.com', 'https://x.example.com/'), 'deny');
  await host.shutdown();
});

test('总开关关着：设置页里每个浏览器都显示"未开启"（off），关掉开关会断开连接', async () => {
  const host = new LocalBrowserHost({ configPath: cfgPath(), log: () => {}, sendAsk: () => true, filesDir: () => os.tmpdir(), onAction: () => {} });
  const st = await host.status();
  assert.equal(st.enabled, false);
  for (const b of st.browsers) assert.equal(b.state, 'off');
  let disconnected = 0;
  (host.manager as any).disconnectAll = async () => { disconnected += 1; };
  await host.setConfig({ enabled: true });
  assert.equal(host.enabled(), true);
  await host.setConfig({ enabled: false });
  assert.equal(disconnected, 1);
  await host.shutdown();
});

test('退出守卫：挡住第一次退出、等浏览器收尾完再退；清理期间再点退出不重跑；收尾后放行', async () => {
  const { createQuitGuard } = await import('../src/main/localBrowserHost.ts');
  let cleanups = 0;
  let quits = 0;
  let finish: () => void = () => {};
  const guard = createQuitGuard({
    needed: () => true,
    cleanup: () => { cleanups += 1; return new Promise<void>((r) => { finish = r; }); },
    quit: () => { quits += 1; },
    timeoutMs: 10_000,
  });
  const ev = () => { const e = { prevented: false, preventDefault() { e.prevented = true; } }; return e; };
  const first = ev();
  guard(first);
  assert.equal(first.prevented, true, '第一次退出被挡住');
  const second = ev();
  guard(second);
  assert.equal(second.prevented, true, '清理期间仍然挡住');
  assert.equal(cleanups, 1, '不重跑清理');
  assert.equal(quits, 0, '清理完之前不退');
  finish();
  const end = Date.now() + 5000;
  while (quits === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.equal(quits, 1, '清理完才真的退');
  const third = ev();
  guard(third);
  assert.equal(third.prevented, false, '收尾之后的那次放行');
});

test('退出守卫：清理卡住时按上限放行；没有连接时不挡', async () => {
  const { createQuitGuard } = await import('../src/main/localBrowserHost.ts');
  let quits = 0;
  const hung = createQuitGuard({ needed: () => true, cleanup: () => new Promise<void>(() => {}), quit: () => { quits += 1; }, timeoutMs: 30 });
  hung({ preventDefault() {} });
  const end = Date.now() + 5000;
  while (quits === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.equal(quits, 1);
  let prevented = false;
  let cleaned = false;
  const idle = createQuitGuard({ needed: () => false, cleanup: async () => { cleaned = true; }, quit: () => {} });
  idle({ preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(cleaned, false);
});

test('退出守卫 + 真的连接：放行退出之前 Firefox 已经收到 session.end', async () => {
  const { createQuitGuard } = await import('../src/main/localBrowserHost.ts');
  const { LocalBrowserManager } = await import('../src/main/localBrowser.ts');
  const { FakeBidi } = await import('./helpers/fakeBrowsers.ts');
  const fake = new FakeBidi();
  await fake.listen();
  try {
    const manager = new LocalBrowserManager({
      discover: () => [{ kind: 'firefox', label: 'Firefox', installed: true, endpoint: { kind: 'firefox', protocol: 'bidi', wsUrl: `ws://127.0.0.1:${fake.port}/session`, source: 'test' } }],
    });
    await manager.get('firefox');
    let endsAtQuit = -1;
    const guard = createQuitGuard({ needed: () => manager.hasConnections(), cleanup: () => manager.shutdown(), quit: () => { endsAtQuit = fake.sessionEnds; } });
    const e = { prevented: false, preventDefault() { e.prevented = true; } };
    guard(e);
    assert.equal(e.prevented, true);
    const end = Date.now() + 5000;
    while (endsAtQuit < 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    assert.equal(endsAtQuit, 1, 'quit() 被调的时候 session.end 已经发完');
  } finally { await fake.close(); }
});

test('关掉总开关：没答复的域名确认一律按拒绝，界面上的确认框收掉', async () => {
  const asks: DomainAsk[] = [];
  const cancelled: string[][] = [];
  const p = cfgPath();
  writeLocalBrowserConfig(p, { enabled: true });
  const host = new LocalBrowserHost({
    configPath: p, log: () => {}, sendAsk: (a) => { asks.push(a); return true; },
    onAsksCancelled: (ids) => cancelled.push(ids), filesDir: () => os.tmpdir(), onAction: () => {},
  });
  const pending = (host as any).askDomain('s1', 'w.example.com', 'https://w.example.com/') as Promise<string>;
  assert.equal(asks.length, 1);
  await host.setConfig({ enabled: false });
  assert.equal(await pending, 'deny');
  assert.deepEqual(cancelled, [[asks[0].id]]);
  assert.deepEqual(host.pendingAsks(), []);
  assert.equal(host.answer(asks[0].id, 'session'), false, '之后再点允许也不算数');
  await host.shutdown();
});
