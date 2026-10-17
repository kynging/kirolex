/**
 * **`local_browser`：接管用户已经登录的 Chrome / Edge / Firefox 读页面（只读）**
 *
 * 为什么要它：会话里经常要读**用户已登录**的内部页面（Midway / SSO 后面）。curl / web_fetch 过不了认证，
 * 或者拿到的是 "You need to enable JavaScript"；playwright 起的是干净浏览器，没有登录态。
 * 用户自己那个浏览器里什么都有 —— 所以借它的调试端口读。
 *
 * 两个后端，同一组接口（`BrowserBackend`）：
 *   · **Chromium（Chrome / Edge / …）走 CDP**：用户在 `chrome://inspect/#remote-debugging` 里开一次远程调试，
 *     浏览器把端点写进 user data dir 里的 `DevToolsActivePort`（第一行端口、第二行 `/devtools/browser/<id>`）。
 *     Chrome 136+ 不再允许 `--remote-debugging-port` 配默认 profile，这条是复用登录态的正路。
 *     每来一个外部连接浏览器会弹一次"允许吗" —— 所以**一条连接用到底**，握手可以等很久（用户在点）。
 *   · **Firefox 走 WebDriver BiDi**：用户用 `--remote-debugging-port=<port>` 起 Firefox，
 *     它在 profile 目录写 `WebDriverBiDiServer.json`；连 `ws://127.0.0.1:<port>/session`，`session.new` 一次。
 *
 * **连接单例**（CDE 那次的教训：每个临时脚本都 `session.new` 不关，几次之后 Firefox 报
 * "Maximum number of active sessions" 只能重启浏览器）：`LocalBrowserManager` 每个浏览器只持有一条连接 +
 * 一个 session，所有会话共用；断了下次调用时重连；退出时 `session.end` 再关连接。工具调用绝不新建 session。
 *
 * **只读**：只能列标签、开新标签、读 / 截图 / 关**自己开的**标签。不碰用户已有的标签（只在 tabs 里看得到），
 * 每个新域名第一次打开要用户点头，永远不读 cookie / localStorage / 密码（发出去的协议方法有白名单，
 * 页面里跑的表达式只有下面那几条常量）。
 *
 * 模块不 import electron，测试用假的 CDP / BiDi 服务端直接测。
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { connectWs, type WsConnection } from './wsLite.ts';

/* ------------------------------------------------------------------ 浏览器 */

export type BrowserKind = 'chrome' | 'chrome-canary' | 'edge' | 'brave' | 'chromium' | 'firefox';
export type BrowserPref = BrowserKind | 'auto';

export const BROWSER_KINDS: BrowserKind[] = ['chrome', 'edge', 'chrome-canary', 'brave', 'chromium', 'firefox'];

export const BROWSER_LABEL: Record<BrowserKind, string> = {
  chrome: 'Google Chrome',
  'chrome-canary': 'Chrome Canary',
  edge: 'Microsoft Edge',
  brave: 'Brave',
  chromium: 'Chromium',
  firefox: 'Firefox',
};

export function isBrowserKind(v: unknown): v is BrowserKind {
  return typeof v === 'string' && (BROWSER_KINDS as string[]).includes(v);
}

export function protocolOf(kind: BrowserKind): 'cdp' | 'bidi' {
  return kind === 'firefox' ? 'bidi' : 'cdp';
}

/** Firefox 没有调试端口说明时用的端口（设置里可改）。 */
export const DEFAULT_FIREFOX_PORT = 9222;

/* ----------------------------------------------------------------- 发现 */

export interface DiscoverEnv {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
}

/** 各 Chromium 浏览器的 user data dir（`DevToolsActivePort` 就在它根下）。 */
export function chromiumUserDataDirs(e: DiscoverEnv): Array<{ kind: BrowserKind; dir: string }> {
  const { platform, home, env } = e;
  if (platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return [
      { kind: 'chrome', dir: path.join(base, 'Google', 'Chrome') },
      { kind: 'chrome-canary', dir: path.join(base, 'Google', 'Chrome Canary') },
      { kind: 'edge', dir: path.join(base, 'Microsoft Edge') },
      { kind: 'brave', dir: path.join(base, 'BraveSoftware', 'Brave-Browser') },
      { kind: 'chromium', dir: path.join(base, 'Chromium') },
    ];
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      { kind: 'chrome', dir: path.win32.join(local, 'Google', 'Chrome', 'User Data') },
      { kind: 'chrome-canary', dir: path.win32.join(local, 'Google', 'Chrome SxS', 'User Data') },
      { kind: 'edge', dir: path.win32.join(local, 'Microsoft', 'Edge', 'User Data') },
      { kind: 'brave', dir: path.win32.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { kind: 'chromium', dir: path.win32.join(local, 'Chromium', 'User Data') },
    ];
  }
  const cfg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    { kind: 'chrome', dir: path.join(cfg, 'google-chrome') },
    { kind: 'edge', dir: path.join(cfg, 'microsoft-edge') },
    { kind: 'brave', dir: path.join(cfg, 'BraveSoftware', 'Brave-Browser') },
    { kind: 'chromium', dir: path.join(cfg, 'chromium') },
  ];
}

/** 各浏览器常见的安装位置（找到任何一个就算"装了"）。Windows 另外会查注册表 App Paths（见 index.ts）。 */
export function browserInstallPaths(e: DiscoverEnv): Array<{ kind: BrowserKind; path: string }> {
  const { platform, home, env } = e;
  if (platform === 'darwin') {
    const apps: Array<[BrowserKind, string]> = [
      ['chrome', 'Google Chrome.app'], ['chrome-canary', 'Google Chrome Canary.app'],
      ['edge', 'Microsoft Edge.app'], ['brave', 'Brave Browser.app'], ['chromium', 'Chromium.app'],
      ['firefox', 'Firefox.app'],
    ];
    return apps.flatMap(([kind, app]) => [
      { kind, path: path.join('/Applications', app) },
      { kind, path: path.join(home, 'Applications', app) },
    ]);
  }
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    const j = path.win32.join;
    return [
      { kind: 'chrome', path: j(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { kind: 'chrome', path: j(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { kind: 'chrome', path: j(local, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { kind: 'chrome-canary', path: j(local, 'Google', 'Chrome SxS', 'Application', 'chrome.exe') },
      { kind: 'edge', path: j(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { kind: 'edge', path: j(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { kind: 'brave', path: j(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
      { kind: 'brave', path: j(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
      { kind: 'firefox', path: j(pf, 'Mozilla Firefox', 'firefox.exe') },
      { kind: 'firefox', path: j(pf86, 'Mozilla Firefox', 'firefox.exe') },
      { kind: 'firefox', path: j(local, 'Mozilla Firefox', 'firefox.exe') },
    ];
  }
  const bins: Array<[BrowserKind, string]> = [
    ['chrome', 'google-chrome'], ['chrome', 'google-chrome-stable'], ['edge', 'microsoft-edge'],
    ['brave', 'brave-browser'], ['chromium', 'chromium'], ['chromium', 'chromium-browser'], ['firefox', 'firefox'],
  ];
  return bins.flatMap(([kind, b]) => ['/usr/bin', '/usr/local/bin', '/snap/bin'].map((d) => ({ kind, path: path.join(d, b) })));
}

/** Windows 注册表 App Paths 里各浏览器 exe 的名字。 */
export const WIN_APP_PATHS: Array<{ kind: BrowserKind; exe: string }> = [
  { kind: 'chrome', exe: 'chrome.exe' },
  { kind: 'edge', exe: 'msedge.exe' },
  { kind: 'brave', exe: 'brave.exe' },
  { kind: 'firefox', exe: 'firefox.exe' },
];

/** `DevToolsActivePort`：第一行端口，第二行 `/devtools/browser/<id>`。坏的一律 null（不猜）。 */
export function parseDevToolsActivePort(text: string): { port: number; path: string } | null {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!/^\/devtools\/browser\/[\w-]+$/.test(lines[1])) return null;
  return { port, path: lines[1] };
}

/** Firefox 的 profiles 根目录（`profiles.ini` 所在）。 */
export function firefoxProfileRoot(e: DiscoverEnv): string {
  if (e.platform === 'darwin') return path.join(e.home, 'Library', 'Application Support', 'Firefox');
  if (e.platform === 'win32') return path.win32.join(e.env.APPDATA || path.win32.join(e.home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox');
  return path.join(e.home, '.mozilla', 'firefox');
}

/**
 * `profiles.ini` 里的**默认 profile**（相对 root 的或绝对的路径）。
 * 新版 Firefox 用 `[Install…] Default=`，老的用 `[Profile…] Default=1` —— 前者优先。
 */
export function parseProfilesIni(text: string): { path: string; relative: boolean } | null {
  const sections: Array<{ name: string; kv: Record<string, string> }> = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) { sections.push({ name: m[1], kv: {} }); continue; }
    const eq = line.indexOf('=');
    if (eq > 0 && sections.length) sections[sections.length - 1].kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const install = sections.find((s) => s.name.startsWith('Install') && s.kv.Default);
  if (install) {
    const prof = sections.find((s) => s.name.startsWith('Profile') && s.kv.Path === install.kv.Default);
    return { path: install.kv.Default, relative: prof ? prof.kv.IsRelative !== '0' : true };
  }
  const profiles = sections.filter((s) => s.name.startsWith('Profile') && s.kv.Path);
  const def = profiles.find((s) => s.kv.Default === '1') || (profiles.length === 1 ? profiles[0] : undefined);
  if (!def) return null;
  return { path: def.kv.Path, relative: def.kv.IsRelative !== '0' };
}

/** Firefox 在 profile 目录写的 `WebDriverBiDiServer.json` → 端口。只认 loopback。 */
export function parseBidiServerJson(text: string): number | null {
  try {
    const j = JSON.parse(text);
    const host = String(j?.ws_host ?? '127.0.0.1');
    if (!/^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(host)) return null;
    const port = Number(j?.ws_port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch { return null; }
}

export interface Endpoint {
  kind: BrowserKind;
  protocol: 'cdp' | 'bidi';
  /** 永远是 `ws://127.0.0.1:<port>/…`。 */
  wsUrl: string;
  /** 端点是从哪儿读来的（给状态行 / 日志）。 */
  source: string;
  /** 不是浏览器自己说的，而是退回设置里的端口（Firefox 没写 WebDriverBiDiServer.json 时）。 */
  assumed?: boolean;
}

export interface DiscoveredBrowser {
  kind: BrowserKind;
  label: string;
  installed: boolean;
  /** 读到的调试端点；没有 = 用户还没开调试。 */
  endpoint?: Endpoint;
  /** Firefox：默认 profile 的目录（"以调试模式重启"要用）。 */
  profileDir?: string;
  /** 找到的可执行文件（Windows / Linux 上重启 Firefox 要用）。 */
  exe?: string;
}

export interface DiscoverIo {
  exists(p: string): boolean;
  readFile(p: string): string | null;
}

export const realIo: DiscoverIo = {
  exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
};

/**
 * 找本机装了哪些浏览器、各自的调试端点。
 *
 * Firefox 的端点：优先 profile 里的 `WebDriverBiDiServer.json`（浏览器自己说的端口），
 * 没有就用设置里的端口（用户照着按钮那条命令起的就是它）——这时 `source` 说清楚是"设置里的端口"。
 */
export function discoverBrowsers(e: DiscoverEnv, io: DiscoverIo, opts: { firefoxPort?: number; extraInstalled?: Partial<Record<BrowserKind, string>> } = {}): DiscoveredBrowser[] {
  const exeOf = new Map<BrowserKind, string>();
  for (const c of browserInstallPaths(e)) if (!exeOf.has(c.kind) && io.exists(c.path)) exeOf.set(c.kind, c.path);
  for (const [k, p] of Object.entries(opts.extraInstalled || {})) if (p && !exeOf.has(k as BrowserKind)) exeOf.set(k as BrowserKind, p);
  const out: DiscoveredBrowser[] = [];
  const dirs = chromiumUserDataDirs(e);
  for (const kind of BROWSER_KINDS) {
    if (kind === 'firefox') continue;
    const d = dirs.find((x) => x.kind === kind);
    const hasDir = !!d && io.exists(d.dir);
    const exe = exeOf.get(kind);
    if (!exe && !hasDir) continue;
    const b: DiscoveredBrowser = { kind, label: BROWSER_LABEL[kind], installed: true, exe };
    if (d) {
      const file = path.join(d.dir, 'DevToolsActivePort');
      const parsed = parseDevToolsActivePort(io.readFile(file) || '');
      if (parsed) b.endpoint = { kind, protocol: 'cdp', wsUrl: `ws://127.0.0.1:${parsed.port}${parsed.path}`, source: file };
    }
    out.push(b);
  }
  const ffRoot = firefoxProfileRoot(e);
  const ini = io.readFile(path.join(ffRoot, 'profiles.ini'));
  const ffExe = exeOf.get('firefox');
  if (ffExe || ini) {
    const b: DiscoveredBrowser = { kind: 'firefox', label: BROWSER_LABEL.firefox, installed: true, exe: ffExe };
    const prof = ini ? parseProfilesIni(ini) : null;
    if (prof) b.profileDir = prof.relative ? path.join(ffRoot, prof.path) : prof.path;
    const file = b.profileDir ? path.join(b.profileDir, 'WebDriverBiDiServer.json') : '';
    const port = file ? parseBidiServerJson(io.readFile(file) || '') : null;
    if (port) b.endpoint = { kind: 'firefox', protocol: 'bidi', wsUrl: `ws://127.0.0.1:${port}/session`, source: file };
    else {
      const p = Number(opts.firefoxPort) || DEFAULT_FIREFOX_PORT;
      b.endpoint = { kind: 'firefox', protocol: 'bidi', wsUrl: `ws://127.0.0.1:${p}/session`, source: `settings port ${p}`, assumed: true };
    }
    out.push(b);
  }
  return out;
}

/** 只连 loopback —— 端点是从文件里读的，文件被改成别的主机也不跟。 */
export function isLoopbackWsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'ws:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
  } catch { return false; }
}

/* --------------------------------------------- 在页面里跑的东西：只有这几条常量 */

/**
 * **页面里能跑的表达式只有这几条**（后端只收 `EvalKind`，不收字符串）——
 * 模型给不了任何 JS，所以它也没法顺手 `document.cookie` / `localStorage`。
 */
export const PAGE_EXPR = {
  state: 'JSON.stringify({ready:document.readyState,url:location.href,title:document.title,len:((document.body&&document.body.innerText)||"").length})',
  text: 'JSON.stringify({url:location.href,title:document.title,body:document.body?document.body.innerText:""})',
  /* 只取 body：head 里是 meta / 脚本配置（csrf-token 之类），不是正文 */
  html: 'JSON.stringify({url:location.href,title:document.title,body:document.body?document.body.outerHTML:""})',
} as const;
export type EvalKind = keyof typeof PAGE_EXPR;

/** CDP 能发的方法。没有 Network.* / Storage.* / DOMStorage.* —— 凭据相关的一律不在表里。 */
export const CDP_METHODS = new Set([
  'Target.getTargets', 'Target.createTarget', 'Target.attachToTarget', 'Target.detachFromTarget',
  'Target.closeTarget', 'Runtime.evaluate', 'Page.captureScreenshot',
]);
/** BiDi 能发的方法。没有 storage.* / network.*。 */
export const BIDI_METHODS = new Set([
  'session.new', 'session.end', 'browsingContext.getTree', 'browsingContext.create',
  'browsingContext.navigate', 'browsingContext.close', 'browsingContext.captureScreenshot', 'script.evaluate',
]);

/**
 * **HTML 只留正文结构**（`format=html`）—— 白名单，而不是"见到一种令牌删一种"的黑名单：
 * 令牌能藏的地方太多（`<meta name="csrf-token">`、`data-access-token`、隐藏输入框、内联脚本、
 * 链接的 `?token=`……），黑名单总有漏的。所以：
 *   · 整段丢掉（连里面的文字）：head / script / style / noscript / template / iframe / object / svg / textarea / select / 注释；
 *   · 只保留下面这张表里的标签，其它标签去掉标签本身、保留里面的文字（自定义组件里也是正文）；
 *     input / meta / link / form 控件一律不留（值、令牌都在它们的属性上）；
 *   · 属性只留 href（a）、src / alt（img）、title、colspan / rowspan；data-* / id / class / 事件一律不留；
 *     链接里名字像凭据的查询参数（token / key / sig / auth / session / code / secret / password …）整条去掉，
 *     javascript: / data: 链接不留。
 */
const HTML_DROP_WITH_CONTENT = new Set(['head', 'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'textarea', 'select', 'canvas']);
const HTML_KEEP = new Set([
  'p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'pre', 'code', 'blockquote',
  'b', 'strong', 'i', 'em', 'u', 's', 'small', 'mark', 'sub', 'sup', 'br', 'hr', 'img',
  'section', 'article', 'main', 'nav', 'header', 'footer', 'aside', 'figure', 'figcaption',
  'details', 'summary', 'label', 'time', 'abbr', 'cite', 'q', 'kbd',
]);
const HTML_VOID = new Set(['br', 'hr', 'img']);
const SECRET_PARAM = /token|key|sig|auth|session|sess|code|secret|passw|pwd|credential|ticket|saml|jwt|nonce|state/i;

/** `a=1&b=2` 里名字像凭据的那几条去掉。 */
function keepSafeParams(query: string): string {
  return query.split('&').filter((kv) => kv && !SECRET_PARAM.test(decodeURIComponentSafe(kv.split('=')[0]))).join('&');
}

/**
 * **网址脱敏**：给模型看的、写进回合面板 / 日志的网址都过这一道（真正导航用的仍是原网址）。
 *   · `user:password@` 去掉；
 *   · 查询参数里名字像凭据的（token / key / code / state / session …）整条去掉；
 *   · fragment 也一样 —— OAuth 隐式流程把 `access_token` 放在 `#` 后面；单页应用的 `#/route?x=` 按查询参数处理；
 *     没有键名、但长得像令牌的整段 fragment（JWT 之类的长串）也去掉。
 * 相对网址（HTML 里的 href）同样适用。
 */
export function redactUrl(raw: string): string {
  const v = String(raw ?? '').trim();
  const hashAt = v.indexOf('#');
  const main = hashAt < 0 ? v : v.slice(0, hashAt);
  let frag = hashAt < 0 ? '' : v.slice(hashAt + 1);
  const q = main.indexOf('?');
  let base = q < 0 ? main : main.slice(0, q);
  const query = q < 0 ? '' : keepSafeParams(main.slice(q + 1));
  base = base.replace(/^([a-z][\w+.-]*:\/\/)[^/?#@]*@/i, '$1');
  if (frag) {
    const fq = frag.indexOf('?');
    if (fq >= 0) {
      const kept = keepSafeParams(frag.slice(fq + 1));
      frag = frag.slice(0, fq) + (kept ? `?${kept}` : '');
    } else if (frag.includes('=')) {
      frag = keepSafeParams(frag);
    } else if (/^[A-Za-z0-9._~+/-]{32,}=*$/.test(frag)) {
      frag = '';
    }
  }
  return base + (query ? `?${query}` : '') + (frag ? `#${frag}` : '');
}

/** 一段文字里出现的绝对网址（http / https / ws）逐个脱敏。 */
export function redactUrlsInText(text: string): string {
  return String(text ?? '').replace(/\b(?:https?|wss?):\/\/[^\s"'<>`)\]　-〿＀-￯]+/gi, (u) => redactUrl(u));
}

function cleanUrl(raw: string): string | null {
  const v = raw.trim();
  if (/^(javascript|data|vbscript|blob):/i.test(v)) return null;
  return redactUrl(v);
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function escAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function keptAttrs(tag: string, rawAttrs: string): string {
  const out: string[] = [];
  const re = /([^\s=/"'>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawAttrs))) {
    const name = m[1].toLowerCase();
    const value = (m[3] ?? m[4] ?? m[5] ?? '');
    const ok = name === 'title' || ((name === 'colspan' || name === 'rowspan') && (tag === 'td' || tag === 'th'))
      || (name === 'href' && tag === 'a') || ((name === 'src' || name === 'alt') && tag === 'img');
    if (!ok) continue;
    if (name === 'href' || name === 'src') {
      const u = cleanUrl(value);
      if (u === null) continue;
      out.push(` ${name}="${escAttr(u)}"`);
    } else out.push(` ${name}="${escAttr(value)}"`);
  }
  return out.join('');
}

export function scrubHtml(html: string): string {
  const src = String(html || '');
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += src.slice(last, m.index);
    last = re.lastIndex;
    if (!m[2]) continue;                                   // 注释 / doctype / 处理指令
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (!closing && HTML_DROP_WITH_CONTENT.has(tag)) {
      /* 连内容一起跳过：找到对应的结束标签（找不到就丢到文末 —— 宁可少给，不可漏给） */
      const endRe = new RegExp(`</${tag}\\s*>`, 'gi');
      endRe.lastIndex = re.lastIndex;
      const e = endRe.exec(src);
      last = e ? endRe.lastIndex : src.length;
      re.lastIndex = last;
      continue;
    }
    if (!HTML_KEEP.has(tag)) continue;                     // 去掉标签本身，里面的文字照留
    if (closing) { if (!HTML_VOID.has(tag)) out += `</${tag}>`; continue; }
    out += `<${tag}${keptAttrs(tag, m[3] || '')}>`;
  }
  out += src.slice(last);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/* -------------------------------------------------------------- 协议通道 */

/** 一次 RPC 的上限（截图 / 导航除外，它们自己给）。 */
export const RPC_TIMEOUT_MS = 30_000;

class RpcChannel extends EventEmitter {
  private ws: WsConnection;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private allowed: Set<string>;

  constructor(ws: WsConnection, allowed: Set<string>) {
    super();
    this.ws = ws;
    this.allowed = allowed;
    ws.on('message', (raw: string) => {
      let msg: any;
      try { msg = JSON.parse(raw); } catch { return; }
      if (typeof msg?.id !== 'number') { this.emit('event', msg); return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error || msg.type === 'error') {
        const m = typeof msg.error === 'object' ? (msg.error?.message || JSON.stringify(msg.error)) : `${msg.error}${msg.message ? `: ${msg.message}` : ''}`;
        p.reject(new Error(m));
      } else p.resolve(msg.result ?? {});
    });
    ws.on('close', () => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('browser connection closed')); }
      this.pending.clear();
      this.emit('close');
    });
  }

  get open(): boolean { return this.ws.isOpen; }

  call(method: string, params: any = {}, extra: Record<string, unknown> = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<any> {
    /* 白名单在发送这一层：上面不管怎么写错，凭据相关的方法都发不出去 */
    if (!this.allowed.has(method)) return Promise.reject(new Error(`method not allowed: ${method}`));
    if (!this.ws.isOpen) return Promise.reject(new Error('browser connection closed'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params, ...extra })); } catch (err: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void { this.ws.close(); }
}

/* -------------------------------------------------------------- 后端接口 */

export interface TabInfo { id: string; title: string; url: string }
export interface PageSnapshot { url: string; title: string; body: string }

export interface BrowserBackend extends EventEmitter {
  readonly kind: BrowserKind;
  readonly protocol: 'cdp' | 'bidi';
  connect(timeoutMs: number): Promise<void>;
  isConnected(): boolean;
  listTabs(): Promise<TabInfo[]>;
  /** 新开一个标签（不等加载）。 */
  createTab(url: string): Promise<string>;
  evaluate(tabId: string, kind: EvalKind): Promise<string>;
  screenshot(tabId: string): Promise<Buffer>;
  closeTab(tabId: string): Promise<void>;
  /** 收尾：BiDi 先 `session.end`，然后关连接。 */
  shutdown(): Promise<void>;
}

function unwrapEval(r: any): string {
  /* CDP: { result: { type, value } } ；BiDi: { type:'success', result: { type, value } } */
  if (r?.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails?.text || 'exception'}`);
  if (r?.type === 'exception') throw new Error(`page script failed: ${r?.exceptionDetails?.text || 'exception'}`);
  const v = r?.result?.value;
  return typeof v === 'string' ? v : '';
}

/** Chromium：CDP，浏览器级连接 + 每个自己开的标签一个 flatten 会话。 */
export class CdpBackend extends EventEmitter implements BrowserBackend {
  readonly kind: BrowserKind;
  readonly protocol = 'cdp' as const;
  private wsUrl: string;
  private ch?: RpcChannel;
  private sessions = new Map<string, string>();   // targetId -> CDP sessionId

  constructor(kind: BrowserKind, wsUrl: string) {
    super();
    this.kind = kind;
    this.wsUrl = wsUrl;
  }

  async connect(timeoutMs: number): Promise<void> {
    if (!isLoopbackWsUrl(this.wsUrl)) throw new Error(`refusing non-loopback endpoint ${this.wsUrl}`);
    const ws = await connectWs(this.wsUrl, timeoutMs);
    this.ch = new RpcChannel(ws, CDP_METHODS);
    this.ch.on('event', (m: any) => {
      if (m?.method === 'Target.detachedFromTarget' && m.params?.sessionId) {
        for (const [t, s] of this.sessions) if (s === m.params.sessionId) this.sessions.delete(t);
      }
    });
    this.ch.on('close', () => { this.sessions.clear(); this.emit('close'); });
  }

  isConnected(): boolean { return !!this.ch?.open; }

  private rpc(): RpcChannel {
    if (!this.ch?.open) throw new Error('browser connection closed');
    return this.ch;
  }

  async listTabs(): Promise<TabInfo[]> {
    const r = await this.rpc().call('Target.getTargets');
    return (Array.isArray(r?.targetInfos) ? r.targetInfos : [])
      .filter((t: any) => t?.type === 'page')
      .map((t: any) => ({ id: String(t.targetId), title: String(t.title || ''), url: String(t.url || '') }));
  }

  async createTab(url: string): Promise<string> {
    const r = await this.rpc().call('Target.createTarget', { url, newWindow: false, background: false });
    if (!r?.targetId) throw new Error('browser did not return a tab id');
    return String(r.targetId);
  }

  private async session(tabId: string): Promise<string> {
    const have = this.sessions.get(tabId);
    if (have) return have;
    const r = await this.rpc().call('Target.attachToTarget', { targetId: tabId, flatten: true });
    if (!r?.sessionId) throw new Error('could not attach to tab');
    this.sessions.set(tabId, String(r.sessionId));
    return String(r.sessionId);
  }

  async evaluate(tabId: string, kind: EvalKind): Promise<string> {
    const sessionId = await this.session(tabId);
    const r = await this.rpc().call('Runtime.evaluate', { expression: PAGE_EXPR[kind], returnByValue: true }, { sessionId });
    return unwrapEval(r);
  }

  async screenshot(tabId: string): Promise<Buffer> {
    const sessionId = await this.session(tabId);
    const r = await this.rpc().call('Page.captureScreenshot', { format: 'png' }, { sessionId }, 60_000);
    if (!r?.data) throw new Error('browser returned no screenshot');
    return Buffer.from(String(r.data), 'base64');
  }

  async closeTab(tabId: string): Promise<void> {
    this.sessions.delete(tabId);
    await this.rpc().call('Target.closeTarget', { targetId: tabId });
  }

  async shutdown(): Promise<void> {
    const ch = this.ch;
    if (!ch?.open) return;
    for (const [, s] of this.sessions) { try { await ch.call('Target.detachFromTarget', { sessionId: s }, {}, 3000); } catch { /* 收尾不抛 */ } }
    this.sessions.clear();
    ch.close();
  }
}

/** Firefox：WebDriver BiDi，一条连接 + 一个 `session.new`。 */
export class BidiBackend extends EventEmitter implements BrowserBackend {
  readonly kind: BrowserKind = 'firefox';
  readonly protocol = 'bidi' as const;
  private wsUrl: string;
  private ch?: RpcChannel;
  private sessionId?: string;

  constructor(wsUrl: string) {
    super();
    this.wsUrl = wsUrl;
  }

  async connect(timeoutMs: number): Promise<void> {
    if (!isLoopbackWsUrl(this.wsUrl)) throw new Error(`refusing non-loopback endpoint ${this.wsUrl}`);
    const ws = await connectWs(this.wsUrl, timeoutMs);
    const ch = new RpcChannel(ws, BIDI_METHODS);
    this.ch = ch;
    ch.on('close', () => { this.sessionId = undefined; this.emit('close'); });
    try {
      const r = await ch.call('session.new', { capabilities: {} });
      this.sessionId = String(r?.sessionId || '');
    } catch (err: any) {
      ch.close();
      const m = String(err?.message || err);
      if (/maximum number of active sessions/i.test(m)) {
        throw new Error('Firefox already has an active automation session (probably left by an earlier script). Restart Firefox in debug mode and try again.');
      }
      throw err;
    }
  }

  isConnected(): boolean { return !!this.ch?.open && !!this.sessionId; }

  private rpc(): RpcChannel {
    if (!this.ch?.open) throw new Error('browser connection closed');
    return this.ch;
  }

  async listTabs(): Promise<TabInfo[]> {
    const r = await this.rpc().call('browsingContext.getTree', { maxDepth: 0 });
    const ctxs: any[] = Array.isArray(r?.contexts) ? r.contexts : [];
    const out: TabInfo[] = [];
    for (const c of ctxs) {
      /* 标题 BiDi 的树里没有：在**隔离的沙箱**里读 document.title（页面脚本看不见、也改不了它），读不到就空着 */
      let title = '';
      try {
        const raw = unwrapEval(await this.rpc().call('script.evaluate', {
          expression: PAGE_EXPR.state, target: { context: c.context, sandbox: 'kirolex' }, awaitPromise: false,
        }, {}, 3000));
        title = String(JSON.parse(raw || '{}')?.title || '');
      } catch { /* 读不到标题不影响列表 */ }
      out.push({ id: String(c.context), title, url: String(c.url || '') });
    }
    return out;
  }

  async createTab(url: string): Promise<string> {
    const r = await this.rpc().call('browsingContext.create', { type: 'tab', background: false });
    const ctx = String(r?.context || '');
    if (!ctx) throw new Error('browser did not return a tab id');
    /* `wait: 'none'`：加载由上层统一轮询（和 CDP 一条逻辑），这里只发出去 */
    try {
      await this.rpc().call('browsingContext.navigate', { context: ctx, url, wait: 'none' });
    } catch (err) {
      /* 导航都发不出去：刚开的空标签别留在用户浏览器里 */
      try { await this.rpc().call('browsingContext.close', { context: ctx }); } catch { /* 尽力 */ }
      throw err;
    }
    return ctx;
  }

  async evaluate(tabId: string, kind: EvalKind): Promise<string> {
    const r = await this.rpc().call('script.evaluate', {
      expression: PAGE_EXPR[kind], target: { context: tabId, sandbox: 'kirolex' }, awaitPromise: false,
    });
    return unwrapEval(r);
  }

  async screenshot(tabId: string): Promise<Buffer> {
    const r = await this.rpc().call('browsingContext.captureScreenshot', { context: tabId }, {}, 60_000);
    if (!r?.data) throw new Error('browser returned no screenshot');
    return Buffer.from(String(r.data), 'base64');
  }

  async closeTab(tabId: string): Promise<void> {
    await this.rpc().call('browsingContext.close', { context: tabId });
  }

  async shutdown(): Promise<void> {
    const ch = this.ch;
    if (!ch?.open) return;
    if (this.sessionId) { try { await ch.call('session.end', {}, {}, 3000); } catch { /* 收尾不抛 */ } }
    this.sessionId = undefined;
    ch.close();
  }
}

export function createBackend(ep: Endpoint): BrowserBackend {
  return ep.protocol === 'bidi' ? new BidiBackend(ep.wsUrl) : new CdpBackend(ep.kind, ep.wsUrl);
}

/* ---------------------------------------------------------- 连接单例管理 */

/**
 * 连接状态（设置页显示）：
 *   · `off`         —— 总开关没开
 *   · `not-enabled` —— 浏览器没开调试（没有端点 / 连不上）
 *   · `waiting`     —— 握手挂着：浏览器在弹"允许远程调试吗"，等用户点
 *   · `connected`   —— 已连接
 *   · `error`       —— 别的错（带原因）
 */
export type ConnState = 'off' | 'not-enabled' | 'waiting' | 'connected' | 'error';

export interface ManagerDeps {
  /** 每次（重）连之前现找端点 —— 浏览器重启后端口会变。 */
  discover(): DiscoveredBrowser[] | Promise<DiscoveredBrowser[]>;
  createBackend?(ep: Endpoint): BrowserBackend;
  log?(level: 'info' | 'warn', message: string): void;
  /** 握手最多等多久（用户要去浏览器里点"允许"）。 */
  connectTimeoutMs?: number;
}

export const CONNECT_TIMEOUT_MS = 90_000;

export class LocalBrowserManager extends EventEmitter {
  private deps: ManagerDeps;
  private backends = new Map<BrowserKind, BrowserBackend>();
  private connecting = new Map<BrowserKind, { p: Promise<BrowserBackend>; gen: number }>();
  /** 每关一次总开关加一：在那之前开始的握手连完也不算数。 */
  private generation = 0;
  private states = new Map<BrowserKind, { state: ConnState; error?: string }>();
  private closing = false;

  constructor(deps: ManagerDeps) {
    super();
    this.deps = deps;
  }

  stateOf(kind: BrowserKind): { state: ConnState; error?: string } {
    return this.states.get(kind) || { state: 'not-enabled' };
  }

  private setState(kind: BrowserKind, state: ConnState, error?: string): void {
    const prev = this.states.get(kind);
    if (prev?.state === state && prev?.error === error) return;
    this.states.set(kind, { state, error });
    this.emit('state', kind, state, error);
  }

  isConnected(kind: BrowserKind): boolean {
    return !!this.backends.get(kind)?.isConnected();
  }

  /** 有没有要收尾的东西（连着的，或者正在连的）—— 没有的话退出时不用等。 */
  hasConnections(): boolean {
    return this.connecting.size > 0 || [...this.backends.values()].some((b) => b.isConnected());
  }

  /**
   * 拿到这个浏览器的那**一条**连接；没有就连（同一时刻只连一次，并发的调用等同一个 Promise）。
   * 断了的不复用 —— 下一次调用重新发现端点、重新连（"断开自动重连"）。
   */
  async get(kind: BrowserKind): Promise<BrowserBackend> {
    if (this.closing) throw new Error('KiroLex is quitting');
    const have = this.backends.get(kind);
    if (have?.isConnected()) return have;
    const inflight = this.connecting.get(kind);
    /* 关过总开关的那一代连接作废了（见 disconnectAll）：不等它，重新连 */
    if (inflight && inflight.gen === this.generation) return inflight.p;
    const gen = this.generation;
    const p = this.open(kind, gen).finally(() => { if (this.connecting.get(kind)?.p === p) this.connecting.delete(kind); });
    this.connecting.set(kind, { p, gen });
    return p;
  }

  private async open(kind: BrowserKind, gen: number): Promise<BrowserBackend> {
    const found = (await this.deps.discover()).find((b) => b.kind === kind);
    if (!found?.endpoint) {
      this.setState(kind, 'not-enabled');
      throw new BrowserNotReady(kind, found ? 'not-enabled' : 'not-installed');
    }
    const backend = (this.deps.createBackend || createBackend)(found.endpoint);
    this.setState(kind, 'waiting');
    this.deps.log?.('info', `连接 ${BROWSER_LABEL[kind]}：${found.endpoint.wsUrl}（端点来自 ${found.endpoint.source}）`);
    try {
      await backend.connect(this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    } catch (err: any) {
      const code = err?.code;
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHANDSHAKE') {
        this.setState(kind, 'not-enabled');
        throw new BrowserNotReady(kind, 'not-enabled');
      }
      if (code === 'ETIMEDOUT') {
        this.setState(kind, 'error', 'timed out waiting for the browser to allow the connection');
        throw new BrowserNotReady(kind, 'not-allowed');
      }
      this.setState(kind, 'error', String(err?.message || err));
      throw err;
    }
    /* 连的途中开始退出了：先把刚建好的 session 结束掉（`shutdown()` 在等这一步），再报错 */
    if (this.closing) { await backend.shutdown().catch(() => {}); throw new Error('KiroLex is quitting'); }
    /* 握手途中总开关被关掉了：这条连接不要了（Firefox 刚建的 session 也 end 掉） */
    if (gen !== this.generation) {
      await backend.shutdown().catch(() => {});
      this.setState(kind, 'not-enabled');
      throw new Error('local_browser was turned off while connecting');
    }
    backend.on('close', () => {
      if (this.backends.get(kind) === backend) this.backends.delete(kind);
      this.deps.log?.('warn', `${BROWSER_LABEL[kind]} 的连接断了 —— 下一次调用会重连`);
      if (!this.closing) this.setState(kind, 'not-enabled');
    });
    this.backends.set(kind, backend);
    this.setState(kind, 'connected');
    this.deps.log?.('info', `${BROWSER_LABEL[kind]} 已连接`);
    return backend;
  }

  /** 退出 KiroLex：每条连接 `session.end`（BiDi）/ detach（CDP），然后关掉。 */
  async shutdown(): Promise<void> {
    this.closing = true;
    /*
      **正在连的也要等**：Firefox 可能正在 `session.new`，这时退出不等它，session 就留在 Firefox 里。
      `open()` 连完看到 `closing` 会自己 `session.end` 再关（见那里），这里等它落定。
      上限由调用方给（退出守卫 3 秒）——握手卡在浏览器的"允许"框上时还没有 session，放弃也不留东西。
    */
    const pending = [...this.connecting.values()].map((c) => c.p);
    const all = [...this.backends.values()];
    this.backends.clear();
    await Promise.all([
      ...all.map((b) => b.shutdown().catch(() => {})),
      ...pending.map((p) => p.then(() => {}, () => {})),
    ]);
  }

  /** 关掉总开关：断开但之后还能再开（和退出不同）。 */
  async disconnectAll(): Promise<void> {
    /*
      正在握手的不在 backends 里：换一代，让它们连完时看到自己已经作废、自己收掉（见 open）。
      不在这里等它们 —— 握手可能挂在浏览器的"允许"框上几十秒，关开关不能跟着卡住。
    */
    this.generation += 1;
    const all = [...this.backends.values()];
    this.backends.clear();
    await Promise.all(all.map((b) => b.shutdown().catch(() => {})));
    for (const k of [...this.states.keys()]) this.setState(k, 'not-enabled');
  }
}

export class BrowserNotReady extends Error {
  kind: BrowserKind;
  reason: 'not-installed' | 'not-enabled' | 'not-allowed';
  constructor(kind: BrowserKind, reason: 'not-installed' | 'not-enabled' | 'not-allowed') {
    super(notReadyText(kind, reason));
    this.kind = kind;
    this.reason = reason;
  }
}

/** 给模型看的"为什么连不上、用户要做什么"。 */
export function notReadyText(kind: BrowserKind, reason: 'not-installed' | 'not-enabled' | 'not-allowed'): string {
  const name = BROWSER_LABEL[kind];
  if (reason === 'not-installed') return `用户机器上没找到 ${name}。`;
  if (reason === 'not-allowed') return `${name} 一直没有允许这次连接（浏览器里会弹"允许远程调试"的确认，用户需要点允许）。请用户去浏览器里点一下，然后再试。`;
  if (kind === 'firefox') {
    return `${name} 没有开调试端口。请用户在 KiroLex 设置 → 开关 → 本地浏览器 里点"以调试模式重启 Firefox"`
      + '（或自己用 --remote-debugging-port 启动 Firefox），然后再试。';
  }
  const scheme = kind === 'edge' ? 'edge' : kind === 'brave' ? 'brave' : 'chrome';
  return `${name} 没有开远程调试。请用户在 ${name} 里打开 ${scheme}://inspect/#remote-debugging 打开远程调试开关，然后再试。`;
}

/* ------------------------------------------------------------- 工具层 */

export type DomainDecision = 'once' | 'session' | 'deny';

export interface BrowserAction {
  action: 'tabs' | 'open' | 'read' | 'screenshot' | 'close';
  browser: BrowserKind;
  url?: string;
  /** read：返回了多少字 / 全文多少字。 */
  chars?: number;
  total?: number;
  /** screenshot：落盘路径。 */
  path?: string;
  /** tabs：几个。 */
  count?: number;
  ok: boolean;
  error?: string;
}

export interface BrowserToolDeps {
  manager: LocalBrowserManager;
  /** 默认用哪个浏览器（设置里选的；'auto' = 第一个已连接 / 有端点的）。 */
  preferred(): BrowserPref;
  discover(): DiscoveredBrowser[] | Promise<DiscoveredBrowser[]>;
  /** 新域名第一次访问：问用户。 */
  confirmDomain(sessionId: string, host: string, url: string): Promise<DomainDecision>;
  /** 截图放哪儿（会话的 files/）。 */
  filesDir(sessionId: string): string;
  /** 每一次操作（成功或失败）都报一次 —— 进回合面板。 */
  onAction(sessionId: string, action: BrowserAction): void;
  /** 截图落盘前把长边压到上限（index.ts 用 nativeImage 做；测试里不传）。 */
  capPng?(png: Buffer): Buffer;
  /**
   * 总开关现在还开着吗。每一个异步等待（连接、用户确认、读页面）之后都要重新问一次：
   * 等的途中用户关掉了开关，之后的事就不能再做（不连、不开标签、不返回内容）。
   */
  enabled?(): boolean;
  now?(): number;
  /** 等页面加载的轮询间隔（测试里调小）。 */
  pollMs?: number;
}

export interface BrowserToolResult { text: string; isError?: boolean }

export const LOCAL_BROWSER_OFF = 'local_browser 已被用户关掉（设置 → 开关 → 本地浏览器）；这次操作没有执行，也没有返回任何页面内容。';

export const READ_DEFAULT_CHARS = 20_000;
/** 上限要让 CJK（3 字节 / 字）也落在 localMcp 的 128 KB 总输出以内，截断说明才不会被再截一次。 */
export const READ_MAX_CHARS = 40_000;
export const OPEN_TIMEOUT_MS = 30_000;
export const OPEN_MAX_TIMEOUT_MS = 120_000;

/** 只收 http(s)，返回小写主机名；别的协议（file:、javascript:、chrome:）一律拒。 */
export function urlHost(raw: string): { url: string; host: string } | null {
  let u: URL;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return { url: u.toString(), host: u.hostname.toLowerCase() };
}

/** 截到 `max` 字；说明放在**开头**（放结尾会被总输出的截断切掉，见 localMcp 的 MAX_READ_BYTES）。 */
export function clipChars(body: string, max: number): { text: string; shown: number; total: number } {
  const chars = Array.from(body);
  if (chars.length <= max) return { text: body, shown: chars.length, total: chars.length };
  return { text: chars.slice(0, max).join(''), shown: max, total: chars.length };
}

const BROWSER_TOOL_NAMES = ['local_browser_tabs', 'local_browser_open', 'local_browser_read', 'local_browser_screenshot', 'local_browser_close'];
export function isBrowserTool(name: string): boolean {
  return BROWSER_TOOL_NAMES.includes(name);
}

/** 工具说明里写清楚和 playwright 的分工 —— 让模型选对。 */
const DIVISION = '**什么时候用它**：页面需要**用户的登录态**（Midway / SSO 后面的内部页面，例如 w.amazon.com、SharePoint、'
  + 'AtoZ、QuickSight）。**其它情况用 playwright**（公开页面、点击 / 填表 / UI 测试、本地开发页面截图）——'
  + 'playwright 是隔离的干净浏览器，不碰用户账号。这组工具**只读**：不能点击、输入、提交表单。';

export function browserToolDefs(): Array<{ name: string; description: string; inputSchema: any }> {
  return [
    {
      name: 'local_browser_tabs',
      description: `列出用户本机浏览器（他已经登录的 Chrome / Edge / Firefox）当前打开的标签：标题 + URL + tab id。只读。${DIVISION}`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'local_browser_open',
      description: '在用户本机浏览器里**新开一个标签**打开 URL（复用他的登录态），等页面加载完（含 JS 渲染，带超时），返回 tab id。'
        + `每个新域名第一次打开会弹窗请用户确认，被拒就不打开。只收 http / https。${DIVISION}`,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          timeoutMs: { type: 'number', description: `等页面加载的上限，默认 ${OPEN_TIMEOUT_MS}，最多 ${OPEN_MAX_TIMEOUT_MS}` },
        },
        required: ['url'],
      },
    },
    {
      name: 'local_browser_read',
      description: '读 local_browser_open 打开的那个标签的正文（默认纯文本；format=html 给 HTML，脚本和隐藏字段已去掉）。'
        + `超过 maxChars 会截断并说明截了多少。只能读**自己打开的**标签。${DIVISION}`,
      inputSchema: {
        type: 'object',
        properties: {
          tab: { type: 'string', description: 'local_browser_open 返回的 tab id' },
          format: { type: 'string', enum: ['text', 'html'] },
          maxChars: { type: 'number', description: `默认 ${READ_DEFAULT_CHARS}，最多 ${READ_MAX_CHARS}` },
        },
        required: ['tab'],
      },
    },
    {
      name: 'local_browser_screenshot',
      description: `给 local_browser_open 打开的那个标签截图，PNG 存进这条会话的 files/ 文件夹，返回路径（在用户机器上）。只能截**自己打开的**标签。${DIVISION}`,
      inputSchema: { type: 'object', properties: { tab: { type: 'string' } }, required: ['tab'] },
    },
    {
      name: 'local_browser_close',
      description: '关掉 local_browser_open 打开的那个标签。只能关**自己打开的**，用户自己的标签关不了。',
      inputSchema: { type: 'object', properties: { tab: { type: 'string' } }, required: ['tab'] },
    },
  ];
}

interface OwnedTab {
  sessionId: string;
  kind: BrowserKind;
  url: string;
  /** 这个标签上「允许一次」放行过的域名（「本会话内允许」的在 `allowed` 里）。 */
  hosts: Set<string>;
}

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LocalBrowserTools {
  private deps: BrowserToolDeps;
  /** KiroLex 自己开的标签（tab id → 哪条会话开的）。读 / 截图 / 关只认这里面的。 */
  private owned = new Map<string, OwnedTab>();
  /** 「本会话内允许」的域名 —— 按会话存，不全局。 */
  private allowed = new Map<string, Set<string>>();
  /** 同一会话同一域名同时来两次：只弹一次框。 */
  private asking = new Map<string, Promise<DomainDecision>>();
  private shotSeq = 0;

  constructor(deps: BrowserToolDeps) {
    this.deps = deps;
  }

  /** 这条会话记住的允许（测试 / 设置页用）。 */
  allowedHosts(sessionId: string): string[] {
    return [...(this.allowed.get(sessionId) || [])];
  }

  ownsTab(sessionId: string, tab: string): boolean {
    return this.owned.get(tab)?.sessionId === sessionId;
  }

  /** 选浏览器：设置里指定了就用它；auto = 已连接的 → 有端点的（Chromium 优先）→ 装了的。 */
  async pickBrowser(): Promise<BrowserKind> {
    const pref = this.deps.preferred();
    if (pref !== 'auto' && isBrowserKind(pref)) return pref;
    for (const k of BROWSER_KINDS) if (this.deps.manager.isConnected(k)) return k;
    const found = await this.deps.discover();
    const order = (b: DiscoveredBrowser) => BROWSER_KINDS.indexOf(b.kind);
    const sorted = [...found].sort((a, b) => order(a) - order(b));
    /* 浏览器自己说出来的端点优先（Firefox 退回设置端口的那个不算 —— 它总是"有"） */
    const real = sorted.find((b) => b.endpoint && !b.endpoint.assumed);
    if (real) return real.kind;
    /* 都没开调试：报 Chromium 的（它那条开法是复用登录态的正路），没有 Chromium 才是 Firefox */
    if (sorted[0]) return sorted[0].kind;
    throw new Error('用户机器上没找到 Chrome / Edge / Firefox。');
  }

  /** 留痕（回合面板 / 日志）里的网址和错误一律脱敏。 */
  private report(sessionId: string, a: BrowserAction): void {
    const safe: BrowserAction = {
      ...a,
      ...(a.url !== undefined ? { url: redactUrl(a.url) } : null),
      ...(a.error !== undefined ? { error: redactUrlsInText(a.error) } : null),
    };
    try { this.deps.onAction(sessionId, safe); } catch { /* 留痕不能让工具失败 */ }
  }

  private isOff(): boolean {
    return !!this.deps.enabled && !this.deps.enabled();
  }

  /** 拿连接：前后各查一次开关（握手可能等很久，等的途中开关可能被关掉）。 */
  private async backend(kind: BrowserKind): Promise<BrowserBackend> {
    if (this.isOff()) throw new Error(LOCAL_BROWSER_OFF);
    const b = await this.deps.manager.get(kind);
    if (this.isOff()) throw new Error(LOCAL_BROWSER_OFF);
    return b;
  }

  private async decide(sessionId: string, host: string, url: string): Promise<DomainDecision> {
    if (this.allowed.get(sessionId)?.has(host)) return 'session';
    const key = `${sessionId}\u0000${host}`;
    let p = this.asking.get(key);
    if (!p) {
      p = this.deps.confirmDomain(sessionId, host, redactUrl(url)).catch(() => 'deny' as DomainDecision)
        .finally(() => { this.asking.delete(key); });
      this.asking.set(key, p);
    }
    const d = await p;
    if (d === 'session') {
      let set = this.allowed.get(sessionId);
      if (!set) { set = new Set(); this.allowed.set(sessionId, set); }
      set.add(host);
    }
    return d;
  }

  /**
   * **页面现在在哪个域名，就按哪个域名把关** —— 只查最初打开的网址不够：页面会跳转（SSO、重定向、
   * 页面里的链接 / 脚本导航），跳到一个用户没点过头的域名后照样能把正文读走。所以打开后、每次读取 / 截图前后
   * 都按**当前**网址问一遍：本会话允许过或这个标签上允许过一次的直接过，否则弹确认，拒绝就不给内容。
   * 返回 null = 放行；字符串 = 拒绝的原因。
   */
  private async approveCurrent(sessionId: string, info: OwnedTab, url: string): Promise<string | null> {
    /* 入口先看开关：关掉之后既不放行（已批准的域名也一样），也不再弹确认框 */
    if (this.isOff()) return LOCAL_BROWSER_OFF;
    if (!url || url === 'about:blank') return null;
    const h = urlHost(url);
    if (!h) return `标签当前的页面（${url}）不是 http(s) 网址，不读它。`;
    if (this.allowed.get(sessionId)?.has(h.host) || info.hosts.has(h.host)) return null;
    const d = await this.decide(sessionId, h.host, h.url);
    if (this.isOff()) return LOCAL_BROWSER_OFF;
    if (d === 'deny') return `页面跳到了 ${h.host}，用户拒绝了这个域名；没有返回它的任何内容。别换个办法绕过去，需要的话问用户。`;
    if (d === 'once') info.hosts.add(h.host);
    return null;
  }

  private async currentUrl(b: BrowserBackend, tab: string): Promise<string> {
    return String(JSON.parse(await b.evaluate(tab, 'state') || '{}').url || '');
  }

  private ownedOr(sessionId: string, tab: unknown): { tab: string; info: OwnedTab } | string {
    const id = String(tab ?? '').trim();
    if (!id) return '需要 tab（local_browser_open 返回的 tab id）';
    const info = this.owned.get(id);
    if (!info || info.sessionId !== sessionId) {
      return `tab ${id} 不是这条会话用 local_browser_open 打开的。用户自己的标签只能在 local_browser_tabs 里看到，`
        + '不能读、截图或关闭 —— 要看它的内容，用 local_browser_open 在新标签里打开同一个 URL。';
    }
    return { tab: id, info };
  }

  private async waitLoaded(b: BrowserBackend, tab: string, timeoutMs: number): Promise<{ loaded: boolean; url: string; title: string }> {
    const deadline = Date.now() + timeoutMs;
    const poll = this.deps.pollMs ?? 400;
    let lastLen = -1;
    let stable = 0;
    let last = { url: '', title: '' };
    while (Date.now() < deadline) {
      try {
        const s = JSON.parse(await b.evaluate(tab, 'state') || '{}');
        last = { url: String(s.url || ''), title: String(s.title || '') };
        const ready = s.ready === 'complete' && last.url && last.url !== 'about:blank';
        const len = Number(s.len) || 0;
        /* "加载完"= readyState complete，而且正文长度连着两次不变（JS 渲染的页面 load 之后还在长） */
        if (ready && len === lastLen) { stable += 1; if (stable >= 2) return { loaded: true, ...last }; } else stable = 0;
        lastLen = len;
      } catch { /* 导航中途执行上下文会被换掉，下一次再问 */ }
      await sleep(poll);
    }
    return { loaded: false, ...last };
  }

  /**
   * 对外的唯一入口：返回给模型的文字里所有网址都脱敏（标签列表、打开 / 读取 / 截图的说明、错误）。
   * 真正导航用的是原网址（`callRaw` 里），脱敏只发生在出口。
   */
  async call(name: string, args: any, sessionId: string): Promise<BrowserToolResult> {
    if (this.isOff()) return { text: LOCAL_BROWSER_OFF, isError: true };
    const r = await this.callRaw(name, args, sessionId);
    /* 整个调用途中开关被关掉：已经拿到的内容也不交出去 */
    if (!r.isError && this.isOff()) return { text: LOCAL_BROWSER_OFF, isError: true };
    const text = redactUrlsInText(r.text);
    /* 说清楚是"显示时隐去了"，不然模型会以为浏览器真的丢了那些参数 */
    return { ...r, text: text === r.text ? text : `${text}\n（上面的网址里像凭据的参数已隐去；浏览器实际打开的是完整网址。）` };
  }

  private async callRaw(name: string, args: any, sessionId: string): Promise<BrowserToolResult> {
    let kind: BrowserKind;
    try {
      /* 已经开过的标签：用开它的那个浏览器，不看当前默认 */
      const t = String(args?.tab ?? '');
      kind = (t && this.owned.get(t)?.kind) || await this.pickBrowser();
    } catch (err: any) {
      return { text: String(err?.message || err), isError: true };
    }
    const fail = (a: Omit<BrowserAction, 'ok' | 'browser'>, err: any): BrowserToolResult => {
      const msg = String(err?.message || err);
      this.report(sessionId, { ...a, browser: kind, ok: false, error: msg });
      return { text: msg, isError: true };
    };
    switch (name) {
      case 'local_browser_tabs': {
        try {
          const b = await this.backend(kind);
          const tabs = await b.listTabs();
          this.report(sessionId, { action: 'tabs', browser: kind, count: tabs.length, ok: true });
          const lines = tabs.map((t, i) => {
            const mine = this.owned.get(t.id)?.sessionId === sessionId ? '［本会话打开的］' : '';
            return `${i + 1}. ${mine}${t.title || '（无标题）'}\n   ${t.url}\n   tab: ${t.id}`;
          });
          return {
            text: `${BROWSER_LABEL[kind]} 当前 ${tabs.length} 个标签（用户自己的标签只能看，不能读 / 截图 / 关；`
              + `要读内容用 local_browser_open 新开一个）：\n${lines.join('\n') || '（没有）'}`,
          };
        } catch (err) { return fail({ action: 'tabs' }, err); }
      }
      case 'local_browser_open': {
        const target = urlHost(args?.url);
        if (!target) return fail({ action: 'open', url: String(args?.url || '') }, new Error('只能打开 http:// 或 https:// 的网址'));
        const decision = await this.decide(sessionId, target.host, target.url);
        /* 用户在确认框前犹豫的时候，总开关可能已经被关掉了 */
        if (this.isOff()) return fail({ action: 'open', url: target.url }, new Error(LOCAL_BROWSER_OFF));
        if (decision === 'deny') {
          return fail({ action: 'open', url: target.url }, new Error(`用户拒绝了在浏览器里打开 ${target.host} 的页面。没有打开任何标签；别换个办法绕过去，需要的话问用户。`));
        }
        const t = Number(args?.timeoutMs);
        const timeoutMs = Math.min(OPEN_MAX_TIMEOUT_MS, Number.isFinite(t) && t > 0 ? t : OPEN_TIMEOUT_MS);
        try {
          const b = await this.backend(kind);
          const tab = await b.createTab(target.url);
          const info: OwnedTab = { sessionId, kind, url: target.url, hosts: new Set(decision === 'once' ? [target.host] : []) };
          this.owned.set(tab, info);
          const st = await this.waitLoaded(b, tab, timeoutMs);
          /* 跳到了别的域名：按跳转后的域名再把关一次；拒绝 = 关掉这个标签，什么都不返回 */
          const refused = await this.approveCurrent(sessionId, info, st.url);
          if (refused) {
            try { await b.closeTab(tab); } catch { /* 尽力 */ }
            this.owned.delete(tab);
            return fail({ action: 'open', url: st.url }, new Error(refused));
          }
          this.report(sessionId, { action: 'open', browser: kind, url: st.url || target.url, ok: true });
          return {
            text: `已在 ${BROWSER_LABEL[kind]} 新标签打开：${st.url || target.url}\n标题：${st.title || '（无）'}\ntab: ${tab}\n`
              + (st.loaded ? '页面已加载完。' : `页面在 ${Math.round(timeoutMs / 1000)} 秒内没加载完（可能还在渲染或在等登录），可以稍后直接 local_browser_read。`)
              + (st.url && urlHost(st.url)?.host !== target.host ? `\n注意：页面跳到了 ${urlHost(st.url)?.host || st.url}（常见于登录跳转）。` : ''),
          };
        } catch (err) { return fail({ action: 'open', url: target.url }, err); }
      }
      case 'local_browser_read': {
        const o = this.ownedOr(sessionId, args?.tab);
        if (typeof o === 'string') return fail({ action: 'read' }, new Error(o));
        const format: EvalKind = args?.format === 'html' ? 'html' : 'text';
        const m = Number(args?.maxChars);
        const max = Math.min(READ_MAX_CHARS, Number.isFinite(m) && m > 0 ? Math.floor(m) : READ_DEFAULT_CHARS);
        try {
          const b = await this.backend(kind);
          const snap = JSON.parse(await b.evaluate(o.tab, format) || '{}') as PageSnapshot;
          /* 快照里带着读的那一刻的网址：按它把关，没过就把正文整个丢掉 */
          const refused = await this.approveCurrent(sessionId, o.info, String(snap.url || ''));
          if (refused) return fail({ action: 'read', url: String(snap.url || '') }, new Error(refused));
          const body = format === 'html' ? scrubHtml(String(snap.body || '')) : String(snap.body || '');
          const c = clipChars(body, max);
          this.report(sessionId, { action: 'read', browser: kind, url: snap.url, chars: c.shown, total: c.total, ok: true });
          const head = c.total > c.shown
            ? `=== ${snap.url} ===（**只返回了前 ${c.shown} 字，全文 ${c.total} 字，截掉 ${c.total - c.shown} 字** —— 需要更多就调大 maxChars，最多 ${READ_MAX_CHARS}）`
            : `=== ${snap.url} ===（全文 ${c.total} 字）`;
          return { text: `${head}\n标题：${snap.title || '（无）'}\n\n${c.text}` };
        } catch (err) { return fail({ action: 'read', url: o.info.url }, err); }
      }
      case 'local_browser_screenshot': {
        const o = this.ownedOr(sessionId, args?.tab);
        if (typeof o === 'string') return fail({ action: 'screenshot' }, new Error(o));
        try {
          const b = await this.backend(kind);
          const before = await this.currentUrl(b, o.tab);
          const refusedBefore = await this.approveCurrent(sessionId, o.info, before);
          if (refusedBefore) return fail({ action: 'screenshot', url: before }, new Error(refusedBefore));
          let png = await b.screenshot(o.tab);
          /* 截图途中页面跳走了：按新域名再问一次，拒绝就不落盘 */
          const after = await this.currentUrl(b, o.tab).catch(() => before);
          if (after !== before) {
            const refusedAfter = await this.approveCurrent(sessionId, o.info, after);
            if (refusedAfter) return fail({ action: 'screenshot', url: after }, new Error(refusedAfter));
          }
          /* 截图（和问页面网址）都要等：等的途中开关被关掉，就不落盘 */
          if (this.isOff()) return fail({ action: 'screenshot', url: after }, new Error(LOCAL_BROWSER_OFF));
          if (this.deps.capPng) { try { png = this.deps.capPng(png); } catch { /* 压不了就原样存 */ } }
          const dir = this.deps.filesDir(sessionId);
          if (this.isOff()) return fail({ action: 'screenshot', url: after }, new Error(LOCAL_BROWSER_OFF));
          fs.mkdirSync(dir, { recursive: true });
          this.shotSeq += 1;
          const file = path.join(dir, `browser-shot-${stamp((this.deps.now || Date.now)())}-${this.shotSeq}.png`);
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, png);
          fs.renameSync(tmp, file);
          const url = after || before || o.info.url;
          this.report(sessionId, { action: 'screenshot', browser: kind, url, path: file, ok: true });
          return { text: `截图已保存（在用户机器上）：${file}\n页面：${url}` };
        } catch (err) { return fail({ action: 'screenshot', url: o.info.url }, err); }
      }
      case 'local_browser_close': {
        const o = this.ownedOr(sessionId, args?.tab);
        if (typeof o === 'string') return fail({ action: 'close' }, new Error(o));
        try {
          const b = await this.backend(kind);
          await b.closeTab(o.tab);
          this.owned.delete(o.tab);
          this.report(sessionId, { action: 'close', browser: kind, url: o.info.url, ok: true });
          return { text: `已关闭 tab ${o.tab}（${o.info.url}）` };
        } catch (err) { return fail({ action: 'close', url: o.info.url }, err); }
      }
      default:
        return { text: `没有这个工具：${name}`, isError: true };
    }
  }
}

/* --------------------------------------------------- 以调试模式重启 Firefox */

export interface RestartPlan {
  /** 请 Firefox 正常退出（不是强杀 —— 强杀会让它下次弹"恢复会话"）。 */
  quit: { cmd: string; args: string[] };
  /** 还在不在：退出码 0 + 输出非空 = 还在。 */
  probe: { cmd: string; args: string[]; running(out: string, code: number): boolean };
  launch: { cmd: string; args: string[] };
}

export function firefoxRestartPlan(platform: NodeJS.Platform, port: number, exe?: string): RestartPlan {
  const flag = ['--remote-debugging-port', String(port)];
  if (platform === 'darwin') {
    return {
      quit: { cmd: 'osascript', args: ['-e', 'tell application "Firefox" to quit'] },
      probe: { cmd: 'pgrep', args: ['-x', 'firefox'], running: (out, code) => code === 0 && !!out.trim() },
      launch: { cmd: 'open', args: ['-a', 'Firefox', '--args', ...flag] },
    };
  }
  if (platform === 'win32') {
    return {
      /* 不带 /F：发 WM_CLOSE，Firefox 走正常退出、存好会话 */
      quit: { cmd: 'taskkill', args: ['/IM', 'firefox.exe'] },
      probe: { cmd: 'tasklist', args: ['/FI', 'IMAGENAME eq firefox.exe', '/NH'], running: (out) => /firefox\.exe/i.test(out) },
      launch: { cmd: exe || 'firefox.exe', args: flag },
    };
  }
  return {
    quit: { cmd: 'pkill', args: ['-TERM', '-x', 'firefox'] },
    probe: { cmd: 'pgrep', args: ['-x', 'firefox'], running: (out, code) => code === 0 && !!out.trim() },
    launch: { cmd: exe || 'firefox', args: flag },
  };
}
