/**
 * `local_browser` 在主进程里的那一份：设置（`config.json` 的 `localBrowser`）、连接单例、
 * 新域名确认的往返、设置页要的状态、"以调试模式重启 Firefox"。
 *
 * 不 import electron：`index.ts` 把要用 electron 的几件事（发给界面、压截图、会话的 files/ 目录、
 * 回合面板留痕）以函数传进来。逻辑在 `localBrowser.ts`，这里只是接线和持久化。
 */

import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BROWSER_KINDS, BROWSER_LABEL, DEFAULT_FIREFOX_PORT, LocalBrowserManager, LocalBrowserTools, WIN_APP_PATHS,
  discoverBrowsers, firefoxRestartPlan, isBrowserKind, realIo,
  type BrowserAction, type BrowserKind, type BrowserPref, type ConnState, type DiscoveredBrowser, type DomainDecision,
} from './localBrowser.ts';
import { tr } from './uiText.ts';

export interface LocalBrowserConfig {
  /** 总开关，默认关。 */
  enabled: boolean;
  browser: BrowserPref;
  firefoxPort: number;
}

export const DEFAULT_LOCAL_BROWSER_CONFIG: LocalBrowserConfig = { enabled: false, browser: 'auto', firefoxPort: DEFAULT_FIREFOX_PORT };

export function normalizeLocalBrowserConfig(raw: any): LocalBrowserConfig {
  const port = Number(raw?.firefoxPort);
  return {
    enabled: raw?.enabled === true,
    browser: isBrowserKind(raw?.browser) ? raw.browser : 'auto',
    firefoxPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_FIREFOX_PORT,
  };
}

export function readLocalBrowserConfig(configPath: string): LocalBrowserConfig {
  try { return normalizeLocalBrowserConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))?.localBrowser); } catch { return { ...DEFAULT_LOCAL_BROWSER_CONFIG }; }
}

/** 只改 `localBrowser` 这一个键；tmp + rename（AGENTS.md §4.3）。 */
export function writeLocalBrowserConfig(configPath: string, patch: Partial<LocalBrowserConfig>): LocalBrowserConfig {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* 没有就新建 */ }
  const next = normalizeLocalBrowserConfig({ ...normalizeLocalBrowserConfig(cfg.localBrowser), ...patch });
  cfg.localBrowser = next;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, configPath);
  return next;
}

/**
 * 设置页上一个浏览器的那一行。`state` 在 `ConnState` 之外多一个 `idle`：
 * 端点在（用户开了调试）但 KiroLex 还没连 —— 第一次用的时候才连，因为每连一次浏览器都要弹确认。
 */
export interface BrowserStatusRow {
  kind: BrowserKind;
  label: string;
  installed: boolean;
  state: ConnState | 'idle';
  error?: string;
  endpoint?: string;
  /** Firefox：端点是设置里的端口（浏览器没说），能不能连上要试了才知道。 */
  assumed?: boolean;
}

export interface LocalBrowserStatus extends LocalBrowserConfig {
  browsers: BrowserStatusRow[];
  /** 'auto' 时实际会用哪个。 */
  effective?: BrowserKind;
}

export interface DomainAsk { id: string; sessionId: string; host: string; url: string }

export interface HostDeps {
  configPath: string;
  log(level: 'info' | 'warn', message: string): void;
  /** 发给界面一个确认框；没有窗口就返回 false（= 拒绝）。 */
  sendAsk(ask: DomainAsk): boolean;
  /** 这些确认不用再问了（总开关被关掉）：界面上把对应的确认框收掉。 */
  onAsksCancelled?(ids: string[]): void;
  /** 状态变了（设置页实时刷新）。 */
  onStatus?(): void;
  filesDir(sessionId: string): string;
  onAction(sessionId: string, action: BrowserAction): void;
  capPng?(png: Buffer): Buffer;
}

/** 回合面板（「🌐 浏览器操作」）里那一行：打开了什么 URL、读了多少字、截图在哪。 */
export function browserActionTitle(a: BrowserAction): string {
  const url = a.url || '';
  if (!a.ok) {
    const what = { tabs: tr('List tabs'), open: tr('Open'), read: tr('Read'), screenshot: tr('Screenshot'), close: tr('Close tab') }[a.action];
    return tr('⚠️ {what} failed {url}: {error}', { what, url, error: String(a.error || '').slice(0, 160) });
  }
  switch (a.action) {
    case 'tabs': return tr('🗂 Listed {n} browser tabs', { n: a.count ?? 0 });
    case 'open': return tr('🌐 Opened {url}', { url });
    case 'read':
      return a.total !== undefined && a.chars !== undefined && a.total > a.chars
        ? tr('📖 Read {n} of {total} chars from {url}', { n: a.chars, total: a.total, url })
        : tr('📖 Read {n} chars from {url}', { n: a.chars ?? 0, url });
    case 'screenshot': return tr('📸 Screenshot of {url} → {path}', { url, path: a.path || '' });
    case 'close': return tr('✖ Closed tab {url}', { url });
    default: return String(a.action);
  }
}

/** 退出时最多等浏览器收尾多久（`session.end` / detach 都是一两个往返，卡住了也不能挡住退出）。 */
export const QUIT_CLEANUP_TIMEOUT_MS = 3000;

/**
 * **退出时真的等浏览器收尾** —— `before-quit` 是同步回调，里面 `void shutdown()` 的话 Electron 不等它，
 * Firefox 的 `session.end` 可能还没发出去进程就没了（那个 session 就留在 Firefox 里，正是 CDE 那次的坑）。
 *
 * 做法：第一次 `before-quit` 时 `preventDefault()` 挡住退出，跑一次有上限的清理，完了再 `quit()`；
 * 清理期间再来的 `before-quit`（用户又点了一次退出）继续挡、但不重跑；清理完之后的那次放行。
 * 没有要收尾的东西（`needed()` 为假）就直接放行，不让退出多等一拍。
 */
export function createQuitGuard(opts: {
  needed(): boolean;
  cleanup(): Promise<void>;
  quit(): void;
  timeoutMs?: number;
  log?(message: string): void;
}): (event: { preventDefault(): void }) => void {
  let state: 'idle' | 'running' | 'done' = 'idle';
  return (event) => {
    if (state === 'done') return;
    if (state === 'idle' && !opts.needed()) { state = 'done'; return; }
    event.preventDefault();
    if (state === 'running') return;
    state = 'running';
    const limit = opts.timeoutMs ?? QUIT_CLEANUP_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), limit); });
    void Promise.race([opts.cleanup().then(() => 'ok' as const, () => 'error' as const), timeout]).then((r) => {
      if (timer) clearTimeout(timer);
      if (r !== 'ok') opts.log?.(`退出前的浏览器收尾${r === 'timeout' ? `超过 ${limit}ms` : '出错'}，不再等`);
      state = 'done';
      opts.quit();
    });
  };
}

/** 用户多久没回确认框就当拒绝。 */
export const DOMAIN_ASK_TIMEOUT_MS = 5 * 60_000;

function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err: any, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '') });
    });
  });
}

/** Windows：注册表 App Paths 里登记的浏览器 exe（装在非常规位置时靠它）。 */
async function winRegistryBrowsers(): Promise<Partial<Record<BrowserKind, string>>> {
  const out: Partial<Record<BrowserKind, string>> = {};
  for (const { kind, exe } of WIN_APP_PATHS) {
    for (const hive of ['HKLM', 'HKCU']) {
      const r = await run('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'], 5000);
      const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(r.out);
      const p = m?.[1]?.trim().replace(/^"|"$/g, '');
      if (r.code === 0 && p && realIo.exists(p)) { out[kind] = p; break; }
    }
  }
  return out;
}

export class LocalBrowserHost {
  readonly manager: LocalBrowserManager;
  readonly tools: LocalBrowserTools;
  private deps: HostDeps;
  private cfg: LocalBrowserConfig;
  private registry: Partial<Record<BrowserKind, string>> = {};
  private asks = new Map<string, { resolve: (d: DomainDecision) => void; timer: NodeJS.Timeout; ask: DomainAsk }>();
  private askSeq = 0;

  constructor(deps: HostDeps) {
    this.deps = deps;
    this.cfg = readLocalBrowserConfig(deps.configPath);
    if (process.platform === 'win32') {
      void winRegistryBrowsers().then((r) => { this.registry = r; deps.onStatus?.(); }).catch(() => {});
    }
    this.manager = new LocalBrowserManager({
      discover: () => this.discover(),
      log: (level, m) => deps.log(level, m),
    });
    this.manager.on('state', () => deps.onStatus?.());
    this.tools = new LocalBrowserTools({
      manager: this.manager,
      preferred: () => this.cfg.browser,
      discover: () => this.discover(),
      confirmDomain: (sessionId, host, url) => this.askDomain(sessionId, host, url),
      filesDir: deps.filesDir,
      onAction: deps.onAction,
      capPng: deps.capPng,
      enabled: () => this.cfg.enabled,
    });
  }

  config(): LocalBrowserConfig { return { ...this.cfg }; }
  enabled(): boolean { return this.cfg.enabled; }

  discover(): DiscoveredBrowser[] {
    return discoverBrowsers({ platform: process.platform, home: os.homedir(), env: process.env }, realIo,
      { firefoxPort: this.cfg.firefoxPort, extraInstalled: this.registry });
  }

  async setConfig(patch: Partial<LocalBrowserConfig>): Promise<LocalBrowserConfig> {
    const wasOn = this.cfg.enabled;
    this.cfg = writeLocalBrowserConfig(this.deps.configPath, patch);
    this.deps.log('info', `本地浏览器设置 = ${JSON.stringify(this.cfg)}`);
    /* 关掉总开关 = 放开浏览器：连接断开、session 结束（之后再开还能连） */
    if (wasOn && !this.cfg.enabled) {
      /* 还在等用户点的确认一律按拒绝（等着它的那次打开随之作废），再断开连接（含正在握手的） */
      this.denyPendingAsks();
      await this.manager.disconnectAll();
    }
    this.deps.onStatus?.();
    return this.config();
  }

  async status(): Promise<LocalBrowserStatus> {
    const found = this.discover();
    const rows: BrowserStatusRow[] = [];
    for (const kind of BROWSER_KINDS) {
      const b = found.find((x) => x.kind === kind);
      if (!b) continue;
      let state: BrowserStatusRow['state'];
      let error: string | undefined;
      if (!this.cfg.enabled) state = 'off';
      else if (this.manager.isConnected(kind)) state = 'connected';
      else {
        const s = this.manager.stateOf(kind);
        if (s.state === 'waiting' || s.state === 'error') { state = s.state; error = s.error; }
        else state = b.endpoint && !b.endpoint.assumed ? 'idle' : 'not-enabled';
      }
      rows.push({ kind, label: BROWSER_LABEL[kind], installed: b.installed, state, error, endpoint: b.endpoint?.wsUrl, assumed: b.endpoint?.assumed });
    }
    let effective: BrowserKind | undefined;
    try { effective = this.cfg.enabled ? await this.tools.pickBrowser() : undefined; } catch { effective = undefined; }
    return { ...this.config(), browsers: rows, effective };
  }

  /** 设置页的"连接"按钮：现在就连一次（浏览器会弹确认）。 */
  async connect(kind: BrowserKind): Promise<{ ok: boolean; error?: string }> {
    if (!this.cfg.enabled) return { ok: false, error: 'disabled' };
    try { await this.manager.get(kind); return { ok: true }; } catch (err: any) { return { ok: false, error: String(err?.message || err) }; }
  }

  private askDomain(sessionId: string, host: string, url: string): Promise<DomainDecision> {
    this.askSeq += 1;
    const ask: DomainAsk = { id: `ask_${Date.now()}_${this.askSeq}`, sessionId, host, url };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.asks.delete(ask.id)) return;
        this.deps.log('warn', `域名确认超时，按拒绝处理 host=${host} sessionId=${sessionId}`);
        resolve('deny');
      }, DOMAIN_ASK_TIMEOUT_MS);
      this.asks.set(ask.id, { resolve, timer, ask });
      if (!this.deps.sendAsk(ask)) {
        clearTimeout(timer);
        this.asks.delete(ask.id);
        resolve('deny');
      }
    });
  }

  /** 界面上点了哪个按钮。未知 id（超时之后才点的）忽略。 */
  answer(id: string, decision: unknown): boolean {
    const p = this.asks.get(String(id));
    if (!p) return false;
    this.asks.delete(String(id));
    clearTimeout(p.timer);
    const d: DomainDecision = decision === 'once' || decision === 'session' ? decision : 'deny';
    this.deps.log('info', `域名确认 host=${p.ask.host} → ${d} sessionId=${p.ask.sessionId}`);
    p.resolve(d);
    return true;
  }

  private denyPendingAsks(): void {
    const ids = [...this.asks.keys()];
    for (const [, p] of this.asks) { clearTimeout(p.timer); p.resolve('deny'); }
    this.asks.clear();
    if (ids.length) {
      this.deps.log('info', `总开关关掉了：${ids.length} 个没答复的域名确认按拒绝处理`);
      this.deps.onAsksCancelled?.(ids);
    }
  }

  /** 还没答复的确认（界面重载后重新弹出来）。 */
  pendingAsks(): DomainAsk[] { return [...this.asks.values()].map((p) => p.ask); }

  /**
   * 以调试模式重启 Firefox：请它正常退出 → 等进程没了 → 带 `--remote-debugging-port` 重新起。
   * 退不掉（例如有"确定要关闭多个标签吗"的框）就不硬杀，报给用户。
   */
  async restartFirefox(): Promise<{ ok: boolean; error?: string }> {
    const ff = this.discover().find((b) => b.kind === 'firefox');
    if (!ff) return { ok: false, error: 'Firefox not found' };
    const plan = firefoxRestartPlan(process.platform, this.cfg.firefoxPort, ff.exe);
    this.deps.log('info', `以调试模式重启 Firefox（端口 ${this.cfg.firefoxPort}）`);
    await run(plan.quit.cmd, plan.quit.args);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const r = await run(plan.probe.cmd, plan.probe.args, 5000);
      if (!plan.probe.running(r.out, r.code)) break;
      if (Date.now() > deadline) return { ok: false, error: 'Firefox did not quit within 20 seconds (it may be showing a dialog). Close it yourself, then click the button again.' };
      await new Promise((res) => setTimeout(res, 500));
    }
    try {
      const child = spawn(plan.launch.cmd, plan.launch.args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (err) => this.deps.log('warn', `Firefox 起不来：${err.message}`));
      child.unref();
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
    this.deps.onStatus?.();
    return { ok: true };
  }

  async shutdown(): Promise<void> {
    for (const [, p] of this.asks) { clearTimeout(p.timer); p.resolve('deny'); }
    this.asks.clear();
    await this.manager.shutdown();
  }
}
