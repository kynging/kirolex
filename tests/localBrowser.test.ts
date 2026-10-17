import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BIDI_METHODS, CDP_METHODS, LocalBrowserManager, LocalBrowserTools, browserToolDefs, clipChars,
  discoverBrowsers, firefoxRestartPlan, parseBidiServerJson, parseDevToolsActivePort, parseProfilesIni,
  scrubHtml, urlHost, isLoopbackWsUrl, redactUrl, redactUrlsInText, PAGE_EXPR,
  type BrowserAction, type BrowserKind, type DiscoveredBrowser, type DomainDecision,
} from '../src/main/localBrowser.ts';
import { FakeBidi, FakeCdp, SECRET_COOKIE, SECRET_STORAGE } from './helpers/fakeBrowsers.ts';

/* 等"某事发生"用轮询（AGENTS.md §5.2），不用固定 sleep */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

type Fake = FakeCdp | FakeBidi;

interface Rig {
  fake: Fake;
  kind: BrowserKind;
  manager: LocalBrowserManager;
  tools: LocalBrowserTools;
  asks: Array<{ sessionId: string; host: string }>;
  /** 确认框里显示给用户的网址。 */
  askedUrls: string[];
  actions: Array<{ sessionId: string; a: BrowserAction }>;
  filesDir: string;
  answer: { next: DomainDecision; byHost: Record<string, DomainDecision> };
  /** 总开关（工具层每次异步等待后都会重新看它）。 */
  switch: { on: boolean };
  /** 设了它：确认框挂着不答，直到测试调用 release。 */
  gate: { hold: boolean; waiting: number; release?: () => void };
}

async function rig(which: 'cdp' | 'bidi', opts: { connectTimeoutMs?: number } = {}): Promise<Rig> {
  const fake: Fake = which === 'cdp' ? new FakeCdp() : new FakeBidi();
  await fake.listen();
  const kind: BrowserKind = which === 'cdp' ? 'chrome' : 'firefox';
  const discover = (): DiscoveredBrowser[] => [{
    kind, label: kind, installed: true,
    endpoint: which === 'cdp'
      ? { kind, protocol: 'cdp', wsUrl: `ws://127.0.0.1:${fake.port}${(fake as FakeCdp).browserPath}`, source: 'test' }
      : { kind, protocol: 'bidi', wsUrl: `ws://127.0.0.1:${fake.port}/session`, source: 'test' },
  }];
  const manager = new LocalBrowserManager({ discover, connectTimeoutMs: opts.connectTimeoutMs ?? 5000 });
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-browser-'));
  tmpDirs.push(filesDir);
  const asks: Rig['asks'] = [];
  const askedUrls: string[] = [];
  const actions: Rig['actions'] = [];
  const answer = { next: 'session' as DomainDecision, byHost: {} as Record<string, DomainDecision> };
  const sw = { on: true };
  const gate: Rig['gate'] = { hold: false, waiting: 0 };
  const tools = new LocalBrowserTools({
    manager,
    preferred: () => kind,
    discover,
    enabled: () => sw.on,
    confirmDomain: async (sessionId, host, url) => {
      asks.push({ sessionId, host });
      askedUrls.push(url);
      if (gate.hold) { gate.waiting += 1; await new Promise<void>((r) => { gate.release = r; }); }
      return answer.byHost[host] ?? answer.next;
    },
    filesDir: () => filesDir,
    onAction: (sessionId, a) => actions.push({ sessionId, a }),
    pollMs: 5,
  });
  return { fake, kind, manager, tools, asks, askedUrls, actions, filesDir, answer, switch: sw, gate };
}

/* 带凭据的网址：userinfo、查询参数、fragment（OAuth 隐式流程）、单页应用的 hash 路由 */
const SECRET_URL = 'https://alice:PW-IN-URL@w.example.com/p?id=1&code=QUERY-CODE&X-Amz-Signature=SIG-TOK#access_token=FRAG-TOK&view=2';
const URL_SECRETS = ['PW-IN-URL', 'alice:', 'QUERY-CODE', 'SIG-TOK', 'FRAG-TOK'];

const tabOf = (text: string): string => /tab: (\S+)/.exec(text)?.[1] || '';

for (const which of ['cdp', 'bidi'] as const) {
  describe(`local_browser（${which === 'cdp' ? 'Chromium / CDP' : 'Firefox / BiDi'} 后端）`, () => {
    test('连接单例：多次工具调用只建一条连接、一个 session', async () => {
      const r = await rig(which);
      try {
        const opened = await r.tools.call('local_browser_open', { url: 'https://w.example.com/a' }, 's1');
        assert.ok(!opened.isError, opened.text);
        const tab = tabOf(opened.text);
        for (let i = 0; i < 3; i += 1) {
          assert.ok(!(await r.tools.call('local_browser_read', { tab }, 's1')).isError);
          assert.ok(!(await r.tools.call('local_browser_tabs', {}, 's1')).isError);
        }
        assert.equal(r.fake.handshakes, 1, '只握手一次');
        if (r.fake instanceof FakeBidi) assert.equal(r.fake.sessionNews, 1, '只 session.new 一次');
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('并发的第一批调用也只连一次', async () => {
      const r = await rig(which);
      try {
        const results = await Promise.all([1, 2, 3, 4].map(() => r.tools.call('local_browser_tabs', {}, 's1')));
        for (const x of results) assert.ok(!x.isError, x.text);
        assert.equal(r.fake.handshakes, 1);
        if (r.fake instanceof FakeBidi) assert.equal(r.fake.sessionNews, 1);
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('断开之后下一次调用自动重连', async () => {
      const r = await rig(which);
      try {
        assert.ok(!(await r.tools.call('local_browser_tabs', {}, 's1')).isError);
        assert.equal(r.manager.stateOf(r.kind).state, 'connected');
        r.fake.dropAll();
        await waitFor(() => !r.manager.isConnected(r.kind), '连接被发现断了');
        const again = await r.tools.call('local_browser_tabs', {}, 's1');
        assert.ok(!again.isError, again.text);
        assert.equal(r.fake.handshakes, 2, '重连了一次');
        assert.equal(r.manager.stateOf(r.kind).state, 'connected');
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('退出时收尾：BiDi 发 session.end，连接关掉', async () => {
      const r = await rig(which);
      try {
        await r.tools.call('local_browser_tabs', {}, 's1');
        await r.manager.shutdown();
        await waitFor(() => r.fake.conns.length === 0, '服务端看到连接关了');
        if (r.fake instanceof FakeBidi) {
          assert.equal(r.fake.sessionEnds, 1);
          assert.ok(r.fake.methods.includes('session.end'));
        }
        /* 退出之后不再连 */
        const after = await r.tools.call('local_browser_tabs', {}, 's1');
        assert.ok(after.isError);
        assert.equal(r.fake.handshakes, 1);
      } finally { await r.fake.close(); }
    });

    test('新域名第一次要确认；拒绝后不打开任何标签', async () => {
      const r = await rig(which);
      try {
        r.answer.next = 'deny';
        const before = r.fake.pages.size;
        const denied = await r.tools.call('local_browser_open', { url: 'https://intranet.example.com/x' }, 's1');
        assert.ok(denied.isError);
        assert.match(denied.text, /拒绝/);
        assert.deepEqual(r.asks, [{ sessionId: 's1', host: 'intranet.example.com' }]);
        assert.equal(r.fake.pages.size, before, '没有新标签');
        assert.ok(!r.fake.methods.some((m) => m === 'Target.createTarget' || m === 'browsingContext.create'), '没发开标签的命令');
        assert.equal(r.actions.at(-1)?.a.ok, false);
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('允许一次 = 下次还问；本会话内允许 = 本会话不再问、别的会话照问', async () => {
      const r = await rig(which);
      try {
        r.answer.next = 'once';
        await r.tools.call('local_browser_open', { url: 'https://a.example.com/1' }, 's1');
        await r.tools.call('local_browser_open', { url: 'https://a.example.com/2' }, 's1');
        assert.equal(r.asks.length, 2, '允许一次不记住');
        r.answer.next = 'session';
        await r.tools.call('local_browser_open', { url: 'https://b.example.com/1' }, 's1');
        await r.tools.call('local_browser_open', { url: 'https://b.example.com/2' }, 's1');
        assert.equal(r.asks.length, 3, '本会话允许之后不再问');
        assert.deepEqual(r.tools.allowedHosts('s1'), ['b.example.com']);
        await r.tools.call('local_browser_open', { url: 'https://b.example.com/3' }, 's2');
        assert.equal(r.asks.length, 4, '别的会话要重新问（按会话存，不全局）');
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('打开后跳到没授权过的域名：按跳转后的域名再确认，拒绝就关掉标签、不返回内容', async () => {
      const r = await rig(which);
      try {
        r.fake.redirects.set('https://approved.example/start', 'https://unapproved.example/landing');
        r.answer.byHost = { 'approved.example': 'session', 'unapproved.example': 'deny' };
        const x = await r.tools.call('local_browser_open', { url: 'https://approved.example/start' }, 's1');
        assert.ok(x.isError, x.text);
        assert.deepEqual(r.asks.map((a) => a.host), ['approved.example', 'unapproved.example']);
        assert.ok(!x.text.includes('Body of'), '不返回正文');
        assert.ok(![...r.fake.pages.values()].some((pg) => pg.url === 'https://unapproved.example/landing'), '跳转后的标签被关掉');
        /* 允许之后同样的跳转能打开、能读 */
        r.answer.byHost['unapproved.example'] = 'once';
        const ok = await r.tools.call('local_browser_open', { url: 'https://approved.example/start' }, 's1');
        assert.ok(!ok.isError, ok.text);
        const read = await r.tools.call('local_browser_read', { tab: tabOf(ok.text) }, 's1');
        assert.ok(!read.isError, read.text);
        assert.ok(read.text.includes('Body of https://unapproved.example/landing'), read.text);
        assert.equal(r.asks.length, 3, '这个标签上允许过一次的域名，读的时候不再问');
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('打开之后页面自己导航到别的域名：读 / 截图前按当前域名确认，拒绝就不给内容', async () => {
      const r = await rig(which);
      try {
        const tab = tabOf((await r.tools.call('local_browser_open', { url: 'https://ok.example/a' }, 's1')).text);
        r.fake.navigateTab(tab, 'https://evil.example/x');
        r.answer.byHost = { 'evil.example': 'deny' };
        const read = await r.tools.call('local_browser_read', { tab }, 's1');
        assert.ok(read.isError);
        assert.ok(!read.text.includes('Body of https://evil.example/x'), '拒绝后不返回正文');
        const html = await r.tools.call('local_browser_read', { tab, format: 'html' }, 's1');
        assert.ok(html.isError && !html.text.includes('evil.example/x</p>'));
        const shot = await r.tools.call('local_browser_screenshot', { tab }, 's1');
        assert.ok(shot.isError);
        assert.equal(fs.readdirSync(r.filesDir).filter((f) => f.endsWith('.png')).length, 0, '拒绝后不落截图');
        assert.ok(!r.fake.methods.includes(which === 'cdp' ? 'Page.captureScreenshot' : 'browsingContext.captureScreenshot'), '连截图命令都没发');
        r.answer.byHost = { 'evil.example': 'session' };
        const again = await r.tools.call('local_browser_read', { tab }, 's1');
        assert.ok(!again.isError, again.text);
        assert.ok(again.text.includes('Body of https://evil.example/x'), again.text);
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('网址里的凭据不出现在任何返回、回合面板记录和确认框里；真正导航用的仍是原网址', async () => {
      const r = await rig(which);
      try {
        const opened = await r.tools.call('local_browser_open', { url: SECRET_URL }, 's1');
        assert.ok(!opened.isError, opened.text);
        const tab = tabOf(opened.text);
        assert.ok([...r.fake.pages.values()].some((pg) => pg.url === new URL(SECRET_URL).toString()), '浏览器拿到的是原网址');
        const outs = [
          opened,
          await r.tools.call('local_browser_tabs', {}, 's1'),
          await r.tools.call('local_browser_read', { tab }, 's1'),
          await r.tools.call('local_browser_read', { tab, format: 'html' }, 's1'),
          await r.tools.call('local_browser_screenshot', { tab }, 's1'),
          await r.tools.call('local_browser_close', { tab }, 's1'),
        ];
        const recorded = JSON.stringify(r.actions) + JSON.stringify(r.askedUrls);
        for (const secret of URL_SECRETS) {
          for (const o of outs) assert.ok(!o.text.includes(secret), `返回里出现了 ${secret}：${o.text}`);
          assert.ok(!recorded.includes(secret), `记录 / 确认框里出现了 ${secret}：${recorded}`);
        }
        assert.ok(outs[0].text.includes('https://w.example.com/p?id=1'), '无害的部分留着');
        assert.ok(r.actions.every((x) => !x.a.url || x.a.url.includes('w.example.com/p?id=1')));
        /* 失败的那条路也一样：错误信息里的网址同样脱敏 */
        r.answer.next = 'deny';
        const denied = await r.tools.call('local_browser_open', { url: SECRET_URL.replace('w.example.com', 'other.example') }, 's1');
        assert.ok(denied.isError);
        for (const secret of URL_SECRETS) assert.ok(!JSON.stringify(r.actions).includes(secret) && !denied.text.includes(secret));
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('正在连接时退出：等连接落定再收尾，不留 session', async () => {
      const r = await rig(which);
      r.fake.holdMs = 150;
      try {
        const pending = r.tools.call('local_browser_tabs', {}, 's1');
        await waitFor(() => r.manager.stateOf(r.kind).state === 'waiting', '连接中');
        assert.ok(r.manager.hasConnections());
        await r.manager.shutdown();
        /* shutdown 返回时：连接已经关掉；Firefox 那边建起来的 session 已经 end 掉 */
        if (r.fake instanceof FakeBidi) {
          assert.equal(r.fake.sessionNews, 1);
          assert.equal(r.fake.sessionEnds, 1, '连接途中退出也 session.end 了');
          assert.equal(r.fake.activeSession, null);
        }
        assert.ok((await pending).isError, '那次调用因为退出而失败');
        assert.ok(!r.manager.hasConnections());
        await waitFor(() => r.fake.conns.length === 0, '浏览器那头看到连接关了');
      } finally { await r.fake.close(); }
    });

    test('握手途中关掉总开关：连上也不算数（session 收掉），再打开能重新连', async () => {
      const r = await rig(which);
      r.fake.holdMs = 150;
      try {
        const pending = r.manager.get(r.kind);
        await waitFor(() => r.manager.stateOf(r.kind).state === 'waiting', '握手中');
        await r.manager.disconnectAll();
        await assert.rejects(pending);
        assert.equal(r.manager.isConnected(r.kind), false, '握手完成后也不是已连接');
        assert.notEqual(r.manager.stateOf(r.kind).state, 'connected');
        assert.ok(!r.manager.hasConnections());
        await waitFor(() => r.fake.conns.length === 0, '那条连接被关掉');
        if (r.fake instanceof FakeBidi) {
          assert.equal(r.fake.sessionEnds, r.fake.sessionNews, '握手途中建起来的 session 也 end 了');
          assert.equal(r.fake.activeSession, null);
        }
        r.fake.holdMs = 0;
        await r.manager.get(r.kind);
        assert.equal(r.manager.isConnected(r.kind), true, '重新打开之后照常连');
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('等域名确认的途中关掉总开关：用户再点允许也不连、不开标签', async () => {
      const r = await rig(which);
      try {
        r.gate.hold = true;
        const pending = r.tools.call('local_browser_open', { url: 'https://slow.example/x' }, 's1');
        await waitFor(() => r.gate.waiting === 1, '确认框挂着');
        r.switch.on = false;
        r.gate.release?.();
        const x = await pending;
        assert.ok(x.isError);
        assert.match(x.text, /已被用户关掉/);
        assert.equal(r.fake.handshakes, 0, '没有去连浏览器');
        assert.ok(!r.fake.methods.some((m) => m === 'Target.createTarget' || m === 'browsingContext.create'), '没有开标签');
        assert.ok((await r.tools.call('local_browser_tabs', {}, 's1')).isError, '关着时什么都不做');
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('读页面的途中关掉总开关：内容不交出去', async () => {
      const r = await rig(which);
      try {
        const tab = tabOf((await r.tools.call('local_browser_open', { url: 'https://p.example/x' }, 's1')).text);
        r.fake.navigateTab(tab, 'https://q.example/y');
        r.gate.hold = true;
        const pending = r.tools.call('local_browser_read', { tab }, 's1');
        await waitFor(() => r.gate.waiting === 1, '新域名的确认挂着');
        r.switch.on = false;
        r.gate.release?.();
        const x = await pending;
        assert.ok(x.isError);
        assert.ok(!x.text.includes('Body of https://q.example/y'));
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('读页面的那一下关掉总开关：不弹新域名确认、不返回内容（已批准的域名也一样）', async () => {
      const r = await rig(which);
      try {
        const tab = tabOf((await r.tools.call('local_browser_open', { url: 'https://ok2.example/a' }, 's1')).text);
        const evalMethod = which === 'cdp' ? 'Runtime.evaluate' : 'script.evaluate';
        r.fake.onMethod = (m, params) => { if (m === evalMethod && params?.expression === PAGE_EXPR.text) r.switch.on = false; };
        /* ① 已批准的域名 */
        const same = await r.tools.call('local_browser_read', { tab }, 's1');
        assert.ok(same.isError, same.text);
        assert.ok(!same.text.includes('Body of'), same.text);
        /* ② 页面跳到了没批准过的域名 */
        r.switch.on = true;
        r.fake.navigateTab(tab, 'https://never-approved.example/z');
        const asksBefore = r.asks.length;
        const moved = await r.tools.call('local_browser_read', { tab }, 's1');
        assert.ok(moved.isError);
        assert.ok(!moved.text.includes('Body of'));
        assert.equal(r.asks.length, asksBefore, '开关关掉之后不再弹确认框');
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('截图的那一下关掉总开关：不落盘、不弹确认', async () => {
      const r = await rig(which);
      try {
        const tab = tabOf((await r.tools.call('local_browser_open', { url: 'https://ok3.example/a' }, 's1')).text);
        const shotMethod = which === 'cdp' ? 'Page.captureScreenshot' : 'browsingContext.captureScreenshot';
        r.fake.onMethod = (m) => { if (m === shotMethod) r.switch.on = false; };
        const asksBefore = r.asks.length;
        const x = await r.tools.call('local_browser_screenshot', { tab }, 's1');
        assert.ok(x.isError, x.text);
        assert.ok(r.fake.methods.includes(shotMethod), '确实走到了截图那一步');
        assert.equal(fs.readdirSync(r.filesDir).length, 0, '没有写任何文件');
        assert.equal(r.asks.length, asksBefore);
        /* 截图途中页面还跳到了新域名：同样不弹确认 */
        r.switch.on = true;
        r.fake.onMethod = (m) => { if (m === shotMethod) { r.switch.on = false; r.fake.navigateTab(tab, 'https://moved.example/q'); } };
        const y = await r.tools.call('local_browser_screenshot', { tab }, 's1');
        assert.ok(y.isError);
        assert.equal(fs.readdirSync(r.filesDir).length, 0);
        assert.equal(r.asks.length, asksBefore, '没有为跳转后的域名弹确认');
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('只能关 / 读 / 截图自己开的标签；用户的标签和别的会话的标签都不行', async () => {
      const r = await rig(which);
      try {
        const userTab = which === 'cdp' ? 'USER1' : 'USERCTX';
        for (const name of ['local_browser_close', 'local_browser_read', 'local_browser_screenshot']) {
          const x = await r.tools.call(name, { tab: userTab }, 's1');
          assert.ok(x.isError, `${name} 不该碰用户的标签`);
        }
        assert.ok(r.fake.pages.has(userTab), '用户的标签还在');
        assert.ok(!r.fake.methods.some((m) => m === 'Target.closeTarget' || m === 'browsingContext.close'));
        const mine = tabOf((await r.tools.call('local_browser_open', { url: 'https://c.example.com/' }, 's1')).text);
        assert.ok((await r.tools.call('local_browser_close', { tab: mine }, 's2')).isError, '别的会话关不了');
        const closed = await r.tools.call('local_browser_close', { tab: mine }, 's1');
        assert.ok(!closed.isError, closed.text);
        assert.ok(!r.fake.pages.has(mine));
        assert.ok((await r.tools.call('local_browser_close', { tab: mine }, 's1')).isError, '关过的不再算自己的');
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('返回结果里没有 cookie / localStorage / 密码；只发白名单里的方法', async () => {
      const r = await rig(which);
      try {
        const tab = tabOf((await r.tools.call('local_browser_open', { url: 'https://d.example.com/' }, 's1')).text);
        const outs = [
          await r.tools.call('local_browser_read', { tab }, 's1'),
          await r.tools.call('local_browser_read', { tab, format: 'html' }, 's1'),
          await r.tools.call('local_browser_tabs', {}, 's1'),
          await r.tools.call('local_browser_screenshot', { tab }, 's1'),
        ];
        for (const o of outs) {
          assert.ok(!o.isError, o.text);
          assert.ok(!o.text.includes(SECRET_COOKIE), 'cookie 不出现');
          assert.ok(!o.text.includes(SECRET_STORAGE), 'localStorage / 隐藏字段不出现');
          assert.ok(!o.text.includes('hunter2'), '密码不出现');
        }
        assert.match(outs[0].text, /Body of https:\/\/d\.example\.com\//);
        const allowed = which === 'cdp' ? CDP_METHODS : BIDI_METHODS;
        for (const m of r.fake.methods) assert.ok(allowed.has(m), `发了不在白名单里的方法 ${m}`);
        assert.ok(!r.fake.methods.some((m) => /cookie|storage|network/i.test(m)));
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('截图落在会话 files/ 下；每次操作都报给回合面板', async () => {
      const r = await rig(which);
      try {
        const tab = tabOf((await r.tools.call('local_browser_open', { url: 'https://e.example.com/p' }, 's1')).text);
        await r.tools.call('local_browser_read', { tab }, 's1');
        const shot = await r.tools.call('local_browser_screenshot', { tab }, 's1');
        const file = /保存（在用户机器上）：(.+\.png)/.exec(shot.text)?.[1] || '';
        assert.ok(file.startsWith(r.filesDir), shot.text);
        assert.equal(fs.readFileSync(file, 'utf8'), which === 'cdp' ? 'PNGDATA-cdp' : 'PNGDATA-bidi');
        const kinds = r.actions.map((x) => x.a.action);
        assert.deepEqual(kinds, ['open', 'read', 'screenshot']);
        assert.equal(r.actions[0].a.url, 'https://e.example.com/p');
        assert.equal(r.actions[1].a.chars, 'Body of https://e.example.com/p'.length);
        assert.equal(r.actions[2].a.path, file);
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('握手挂着的时候状态是"等待浏览器确认"', async () => {
      const r = await rig(which);
      r.fake.holdMs = 200;
      try {
        const p = r.tools.call('local_browser_tabs', {}, 's1');
        await waitFor(() => r.manager.stateOf(r.kind).state === 'waiting', 'waiting 状态');
        assert.ok(!(await p).isError);
        assert.equal(r.manager.stateOf(r.kind).state, 'connected');
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });

    test('浏览器拒绝握手（没开调试）→ 状态未开启，给出怎么开的说明', async () => {
      const r = await rig(which);
      r.fake.refuse = true;
      try {
        const x = await r.tools.call('local_browser_tabs', {}, 's1');
        assert.ok(x.isError);
        assert.match(x.text, which === 'cdp' ? /chrome:\/\/inspect\/#remote-debugging/ : /调试模式重启 Firefox/);
        assert.equal(r.manager.stateOf(r.kind).state, 'not-enabled');
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    });
  });
}

describe('两个后端的接口一致', () => {
  test('同一串调用，两边返回的形状一样', async () => {
    const shapes: string[][] = [];
    for (const which of ['cdp', 'bidi'] as const) {
      const r = await rig(which);
      try {
        const norm = (t: string) => t
          .replace(/Google Chrome|Firefox|chrome|firefox/g, 'B')
          .replace(/tab: \S+/g, 'tab: X').replace(/tab \S+（/g, 'tab X（')
          .replace(/browser-shot-[\d-]+\.png/g, 'shot.png').replace(r.filesDir, 'DIR')
          .replace(/\n\d+\. [\s\S]*$/, '');
        const opened = await r.tools.call('local_browser_open', { url: 'https://same.example.com/x' }, 's1');
        const tab = tabOf(opened.text);
        const seq = [
          opened,
          await r.tools.call('local_browser_read', { tab, maxChars: 5 }, 's1'),
          await r.tools.call('local_browser_screenshot', { tab }, 's1'),
          await r.tools.call('local_browser_close', { tab }, 's1'),
        ];
        shapes.push(seq.map((x) => `${x.isError ? 'ERR' : 'OK'} ${norm(x.text)}`));
      } finally { await r.manager.shutdown(); await r.fake.close(); }
    }
    assert.deepEqual(shapes[0], shapes[1]);
  });
});

describe('local_browser 纯逻辑', () => {
  test('读到的正文超过 maxChars 截断，说明在开头', async () => {
    const r = await rig('cdp');
    try {
      const tab = tabOf((await r.tools.call('local_browser_open', { url: 'https://long.example.com/' }, 's1')).text);
      const x = await r.tools.call('local_browser_read', { tab, maxChars: 4 }, 's1');
      assert.match(x.text.split('\n')[0], /只返回了前 4 字，全文 \d+ 字，截掉 \d+ 字/);
      assert.equal(clipChars('一二三四五', 3).text, '一二三');
    } finally { await r.manager.shutdown(); await r.fake.close(); }
  });

  test('网址脱敏：userinfo、查询参数、fragment、hash 路由、像令牌的 fragment', () => {
    assert.equal(redactUrl('https://example.com/#access_token=SECRET'), 'https://example.com/');
    assert.equal(redactUrl('https://example.com/cb#access_token=SECRET&token_type=bearer&view=2'), 'https://example.com/cb#view=2');
    assert.equal(redactUrl('https://u:p@example.com/a?b=1&api_key=K&c=3#frag'), 'https://example.com/a?b=1&c=3#frag');
    assert.equal(redactUrl('https://example.com/app#/route?id=5&session=S'), 'https://example.com/app#/route?id=5');
    assert.equal(redactUrl('https://example.com/x#eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlc2ln'), 'https://example.com/x');
    assert.equal(redactUrl('https://example.com/docs#section-2'), 'https://example.com/docs#section-2');
    assert.equal(redactUrl('/rel/path?code=C&page=2'), '/rel/path?page=2');
    assert.equal(redactUrlsInText('见 https://a.example/x?token=T 和 https://b.example/y#id_token=I。'), '见 https://a.example/x 和 https://b.example/y。');
    const html = scrubHtml('<a href="https://example.com/#access_token=SECRET">link</a>');
    assert.ok(!html.includes('SECRET'), html);
  });

  test('只收 http(s) 网址', async () => {
    assert.equal(urlHost('file:///etc/passwd'), null);
    assert.equal(urlHost('javascript:alert(1)'), null);
    assert.equal(urlHost('chrome://settings'), null);
    assert.deepEqual(urlHost('https://W.Example.com/x')?.host, 'w.example.com');
    const r = await rig('cdp');
    try {
      const x = await r.tools.call('local_browser_open', { url: 'file:///etc/passwd' }, 's1');
      assert.ok(x.isError);
      assert.equal(r.asks.length, 0);
      assert.equal(r.fake.handshakes, 0);
    } finally { await r.manager.shutdown(); await r.fake.close(); }
  });

  test('只连 loopback', () => {
    assert.ok(isLoopbackWsUrl('ws://127.0.0.1:9222/session'));
    assert.ok(!isLoopbackWsUrl('ws://10.0.0.5:9222/session'));
    assert.ok(!isLoopbackWsUrl('wss://127.0.0.1:9222/session'));
  });

  test('HTML 只留正文结构：脚本、meta、输入框、data-* 属性、链接里的令牌参数都不出现', () => {
    const out = scrubHtml('<html><head><meta name="csrf-token" content="META-CSRF-1"><title>t</title></head><body>'
      + '<script>var t="SCRIPT-TOK"</script><!-- COMMENT-TOK -->'
      + '<div id="root" class="c" data-access-token="DATA-TOK" onclick="steal()"><h1>Heading</h1>'
      + '<input type="hidden" value="HIDDEN-TOK"><input type=password value=PW-TOK><input type="text" value="TYPED">'
      + '<textarea>TEXTAREA-TOK</textarea><my-widget data-session="SESS-TOK">widget text</my-widget>'
      + '<a href="https://x.example/p?id=7&access_token=URL-TOK&page=2#frag" data-csrf="A-TOK">link</a>'
      + '<a href="javascript:alert(1)">js</a><img src="/i.png?sig=IMG-TOK" alt="pic"></div>'
      + '<meta name="x-auth" content="BODY-META-TOK"><form><input name="csrf" value="FORM-TOK"></form></body></html>');
    for (const secret of ['META-CSRF-1', 'SCRIPT-TOK', 'COMMENT-TOK', 'DATA-TOK', 'HIDDEN-TOK', 'PW-TOK', 'TYPED',
      'TEXTAREA-TOK', 'SESS-TOK', 'URL-TOK', 'A-TOK', 'IMG-TOK', 'BODY-META-TOK', 'FORM-TOK', 'steal', 'javascript:']) {
      assert.ok(!out.includes(secret), `不该出现 ${secret}：${out}`);
    }
    assert.ok(out.includes('<h1>Heading</h1>'), out);
    assert.ok(out.includes('widget text'), '自定义组件里的文字照留');
    assert.ok(out.includes('<a href="https://x.example/p?id=7&amp;page=2#frag">link</a>'), `无害的参数留着：${out}`);
    assert.ok(out.includes('<img src="/i.png" alt="pic">'), out);
    assert.ok(!/<(input|meta|form|textarea|my-widget|script|head)\b/.test(out), `白名单外的标签不留：${out}`);
  });

  test('DevToolsActivePort / profiles.ini / WebDriverBiDiServer.json 的解析', () => {
    assert.deepEqual(parseDevToolsActivePort('9333\r\n/devtools/browser/abc-123\r\n'), { port: 9333, path: '/devtools/browser/abc-123' });
    assert.equal(parseDevToolsActivePort('nope'), null);
    assert.equal(parseDevToolsActivePort('9333\n/evil/path'), null);
    const ini = '[Profile1]\nName=default\nIsRelative=1\nPath=Profiles/old.default\nDefault=1\n\n'
      + '[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n\n'
      + '[Install308046B0AF4A39CB]\nDefault=Profiles/abc.default-release\nLocked=1\n';
    assert.deepEqual(parseProfilesIni(ini), { path: 'Profiles/abc.default-release', relative: true });
    assert.deepEqual(parseProfilesIni('[Profile0]\nPath=/abs/p\nIsRelative=0\nDefault=1\n'), { path: '/abs/p', relative: false });
    assert.equal(parseBidiServerJson('{"ws_host":"127.0.0.1","ws_port":9555}'), 9555);
    assert.equal(parseBidiServerJson('{"ws_host":"0.0.0.0","ws_port":9555}'), null);
  });

  test('发现：读 DevToolsActivePort 和 Firefox profile 里的端点', () => {
    const files: Record<string, string> = {};
    const home = '/Users/u';
    const sup = path.join(home, 'Library', 'Application Support');
    files[path.join(sup, 'Google', 'Chrome')] = '';
    files[path.join(sup, 'Google', 'Chrome', 'DevToolsActivePort')] = '9444\n/devtools/browser/xyz\n';
    files[path.join(sup, 'Microsoft Edge')] = '';
    files['/Applications/Firefox.app'] = '';
    files[path.join(sup, 'Firefox', 'profiles.ini')] = '[Install1]\nDefault=Profiles/p.default\n[Profile0]\nPath=Profiles/p.default\nIsRelative=1\n';
    files[path.join(sup, 'Firefox', 'Profiles', 'p.default', 'WebDriverBiDiServer.json')] = '{"ws_host":"127.0.0.1","ws_port":9666}';
    const io = { exists: (p: string) => p in files, readFile: (p: string) => (p in files ? files[p] : null) };
    const found = discoverBrowsers({ platform: 'darwin', home, env: {} }, io);
    const by = Object.fromEntries(found.map((b) => [b.kind, b]));
    assert.equal(by.chrome.endpoint?.wsUrl, 'ws://127.0.0.1:9444/devtools/browser/xyz');
    assert.ok(by.edge.installed);
    assert.equal(by.edge.endpoint, undefined, 'Edge 没开调试');
    assert.equal(by.firefox.endpoint?.wsUrl, 'ws://127.0.0.1:9666/session');
    assert.ok(!by.firefox.endpoint?.assumed);
    /* 没有 WebDriverBiDiServer.json：退回设置里的端口，并标明是"假定的" */
    delete files[path.join(sup, 'Firefox', 'Profiles', 'p.default', 'WebDriverBiDiServer.json')];
    const again = discoverBrowsers({ platform: 'darwin', home, env: {} }, io, { firefoxPort: 9230 });
    const ff = again.find((b) => b.kind === 'firefox');
    assert.equal(ff?.endpoint?.wsUrl, 'ws://127.0.0.1:9230/session');
    assert.ok(ff?.endpoint?.assumed);
  });

  test('发现：Windows 的安装路径和 user data dir', () => {
    const local = 'C:\\Users\\u\\AppData\\Local';
    const files: Record<string, string> = {
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe': '',
      [`${local}\\Microsoft\\Edge\\User Data\\DevToolsActivePort`]: '9555\n/devtools/browser/e1\n',
    };
    const io = { exists: (p: string) => p in files, readFile: (p: string) => (p in files ? files[p] : null) };
    const found = discoverBrowsers({ platform: 'win32', home: 'C:\\Users\\u', env: { LOCALAPPDATA: local } }, io);
    const edge = found.find((b) => b.kind === 'edge');
    assert.equal(edge?.endpoint?.wsUrl, 'ws://127.0.0.1:9555/devtools/browser/e1');
    assert.ok(!found.some((b) => b.kind === 'chrome'), '没装 Chrome 就不列');
  });

  test('以调试模式重启 Firefox 的命令：正常退出（不强杀），带上端口', () => {
    const win = firefoxRestartPlan('win32', 9333, 'C:\\Program Files\\Mozilla Firefox\\firefox.exe');
    assert.ok(!win.quit.args.includes('/F'));
    assert.deepEqual(win.launch.args, ['--remote-debugging-port', '9333']);
    const mac = firefoxRestartPlan('darwin', 9222);
    assert.equal(mac.launch.cmd, 'open');
    assert.ok(mac.launch.args.includes('--remote-debugging-port'));
  });

  test('工具说明写清楚和 playwright 的分工，并且没有点击 / 输入类工具', () => {
    const defs = browserToolDefs();
    assert.deepEqual(defs.map((d) => d.name), ['local_browser_tabs', 'local_browser_open', 'local_browser_read', 'local_browser_screenshot', 'local_browser_close']);
    const open = defs.find((d) => d.name === 'local_browser_open')!;
    assert.match(open.description, /登录态/);
    assert.match(open.description, /playwright/);
  });
});
