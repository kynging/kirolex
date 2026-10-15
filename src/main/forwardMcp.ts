/**
 * **本机哪些 MCP 该转发给远端会话** ——「那操作本地的 playwright 和 compute use 呢」。
 *
 * 判据是**实测出来的那条**：一个 MCP 的命令指向**本机路径**时，它在远端根本起不来 ——
 * 而 kiro-cli 对这种情况不报错，只是静默少掉那些工具（日志里那句
 * 「agent aws-agent 缺 MCP 命令：/opt/homebrew/bin/node, /Users/keyinan/.local/bin/…」就是它）。
 * 所以这类 MCP **只有两种正确处理**：转发到本机来跑，或者干脆别给它。
 *
 * 还有一类命令名看着是通用的（`npx` / `uvx` / `python3`），远端**也有**同名可执行文件 ——
 * 但那不代表它能用：`npx @playwright/mcp` 在远端会拉起**远端**那台机器的浏览器，
 * 而你要的是点你自己屏幕上那个。这一类靠名字白名单挑（`FORWARD_BY_NAME`），
 * 因为"它该在哪台机器上跑"是语义问题，命令行里看不出来。
 *
 * **第三条判据：KiroLex 设置里那份「远程会话从本机转发的 MCP」名单**（`config.json` 的
 * `remoteForwardMcp`）。名单里的名字（和 agent 文件 `mcpServers` 的键一致）：
 *   · HTTP 型（有 `url`、没有 `command`）—— 产出 http 规格，由 `localMcp.ts` 的 `HttpProxy`
 *     在**本机**代发到上游。为的是妙想这类：上游按来源 IP / 本机密钥鉴权，远端直连要么被拒、
 *     要么得把密钥抄到那台机器上。头里的 `${env:…}` 原样交出去，展开发生在 HttpProxy 里；
 *   · stdio 型 —— 不看命令长什么样，一律转发（"它该在哪台机器上跑"由你说了算）。
 * 不在名单里的照旧：本机路径命令或 `FORWARD_BY_NAME` 才转发，HTTP 型跳过。名单为空 = 和以前一样。
 *
 * 标记**只存在 KiroLex 自己的设置里**，绝不写进 Kiro 的 agent 文件 —— kiro-cli 严格校验 agent JSON，
 * 多一个它不认识的字段就整份拒绝、静默退回默认 agent（见 `remoteLocalTools.ts` 文件头）。
 * 远端会话 agent 里也只写隧道地址，上游 url / 头 / 密钥一个字都不出本机（见 `remoteForwardPlan`）。
 *
 * 这个模块只做**纯**判断（挑哪些、用什么名字），起进程和转发在 `localMcp.ts`。
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expandEnvRefs as expandComboEnv, type McpComboServer } from './mcpCombos.ts';
import { tr } from './uiText.ts';

/**
 * 按名字就该转发的那些 —— 它们的意义就是"操作我这台机器"。
 *
 * `playwright`：驱动浏览器。远端那台没有显示器，而且就算有，你也看不见它点了什么。
 * 剩下两个是同一类（画布 / 设计工具都在本机 app 里），先放进来是因为它们的命令本来就是
 * 本机绝对路径 —— 列在这里只是让意图显式，判据不靠它们也成立。
 */
export const FORWARD_BY_NAME = ['playwright', 'drawio', 'pencil'];

export interface McpEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** 名单里那条 HTTP 型产出的规格（形状同 `localMcp.ts` 的 `HttpProxySpec`）。 */
export interface HttpMcpEntry {
  type: 'http';
  name: string;
  /** 上游地址 —— 只在本机用，绝不写到远端。 */
  url: string;
  /** 原样保留 `${env:…}` 引用，HttpProxy 转发时才展开。 */
  headers: Record<string, string>;
  timeoutMs: number;
}

export type ForwardEntry = McpEntry | HttpMcpEntry;

export function isHttpForward(e: ForwardEntry): e is HttpMcpEntry {
  return (e as HttpMcpEntry).type === 'http';
}

/** 「远程会话从本机转发的 MCP」名单里的一项。 */
export interface ForwardListItem {
  /** 和 Kiro agent 文件 `mcpServers` 里的键一致。 */
  name: string;
  /** 只对 HTTP 型生效（HttpProxy 另有 120 秒下限）。 */
  timeoutSec: number;
}

export const FORWARD_TIMEOUT_SEC_DEFAULT = 180;
export const FORWARD_TIMEOUT_SEC_MAX = 3600;

/** 名单规范化：去空名、同名只留第一条，超时不是正数就退回默认。设置读写两头都过它。 */
export function normalizeForwardList(raw: unknown): ForwardListItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ForwardListItem[] = [];
  const seen = new Set<string>();
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const name = String((it as any).name ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const t = Number((it as any).timeoutSec);
    const timeoutSec = Number.isFinite(t) && t > 0
      ? Math.min(FORWARD_TIMEOUT_SEC_MAX, Math.floor(t))
      : FORWARD_TIMEOUT_SEC_DEFAULT;
    out.push({ name, timeoutSec });
  }
  return out;
}

/** 本机那份 agent 定义（读不到返回 null —— 那时不转发任何东西，而不是猜）。 */
export function localAgentJson(agent: string, home = os.homedir()): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.kiro', 'agents', `${agent}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 命令是不是一个**本机路径**（绝对路径 / `~` 开头）。这种在远端必然不存在，所以要转发。
 *
 * **Windows 的绝对路径也算** ——「看一下有没有 windows 上不能跑的东西」。
 * 原来只认 `/` 和 `~`，于是 `C:\Users\k\node.exe` 被判成"不是本机路径"、
 * 于是**不转发** —— 而这正是这个模块头警告的那种失败：静默少工具。
 * 远端那台 Linux 上当然没有 `C:\…`，所以漏判的代价是那个 MCP 根本起不来，
 * 而模型只会说"我没有这个工具"。
 *
 * 认三种形状：POSIX 绝对路径、`~`、Windows 的 `C:\` / `C:/` / UNC（`\\server\share`）。
 */
export function isLocalPathCommand(command: string): boolean {
  const c = String(command || '').trim();
  if (!c) return false;
  if (c.startsWith('/') || c.startsWith('~')) return true;
  if (/^[A-Za-z]:[\\/]/.test(c)) return true;          // C:\… 或 C:/…
  if (c.startsWith('\\\\')) return true;                   // UNC：\\server\share\…
  return false;
}

/**
 * 从一份 agent 定义里挑出该转发的 MCP。
 *
 * `disabled: true` 的跳过（那是你自己关掉的）。`list` 是设置里那份名单（见文件头）：
 * 名单里的 HTTP 型产出 http 规格、名单里的 stdio 一律转发；不在名单里的 `type: 'http'` 照旧跳过 ——
 * 那种本来就是"某个地址上的服务"，远端自己也能敲同一个地址。
 */
export function forwardableFrom(agentJson: any, list: ForwardListItem[] = []): ForwardEntry[] {
  const servers = (agentJson && typeof agentJson === 'object' && agentJson.mcpServers) || {};
  const listed = new Map(list.map((it) => [it.name, it]));
  const out: ForwardEntry[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, any>)) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.disabled) continue;
    const item = listed.get(name);
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) {
      const url = typeof raw.url === 'string' ? raw.url.trim() : '';
      if (!item || !url) continue;                           // http/url 型：不在名单里就让远端自己连
      const headers: Record<string, string> = {};
      if (raw.headers && typeof raw.headers === 'object') {
        for (const [k, v] of Object.entries(raw.headers)) if (typeof v === 'string') headers[k] = v;
      }
      out.push({ type: 'http', name, url, headers, timeoutMs: item.timeoutSec * 1000 });
      continue;
    }
    if (!item && !FORWARD_BY_NAME.includes(name) && !isLocalPathCommand(command)) continue;
    out.push({
      name,
      command,
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      env: (raw.env && typeof raw.env === 'object') ? raw.env : undefined,
    });
  }
  return out;
}

/**
 * 上游地址的指纹（sha256），给远端"同 url 剔除"用 —— 比的是指纹，于是上游 url 本身不必出本机
 * （有人把 key 放在 `?key=` 里）。去掉首尾空白和末尾 `/` 再算；远端那段 python 用同一个规则。
 */
export function upstreamUrlKey(url: string): string {
  return crypto.createHash('sha256').update(String(url ?? '').trim().replace(/\/+$/, ''), 'utf8').digest('hex');
}

/**
 * 交给远端的那一半：每个转发项只给隧道地址 `<base>/<名字>`，http 项另给上游 url 的指纹
 * （远端底子 agent 里别名、同上游的直连条目要从会话 agent 里剔掉，见 `remoteAgentScript`）。
 */
export function remoteForwardPlan(entries: ForwardEntry[], tunnelBase: string): {
  forwarded: Array<{ name: string; url: string }>;
  dropUpstream: string[];
  httpNames: string[];
  stdioNames: string[];
} {
  const http = entries.filter(isHttpForward);
  return {
    forwarded: entries.map((e) => ({ name: e.name, url: `${tunnelBase}/${e.name}` })),
    dropUpstream: [...new Set(http.map((e) => upstreamUrlKey(e.url)))],
    httpNames: http.map((e) => e.name),
    stdioNames: entries.filter((e) => !isHttpForward(e)).map((e) => e.name),
  };
}

/** 会话准备时探测失败的那句提示（和「本地工具通道没起来」同一种：说出来，不阻断）。 */
export function httpProbeNotice(name: string, error: string): string {
  const why = String(error || tr('Unknown error'));
  /* 老的中文前缀照认（localMcp 那边给的错误），英文界面下再认英文那个 */
  const msg = why.startsWith('本机→上游') || why.startsWith('Local→upstream') ? why : tr('Local→upstream ({name}) {why}', { name, why });
  return tr('⚠️ The MCP "{name}" forwarded from this machine is unavailable right now: {msg}. This session still works, but calling its tools will fail with the same error. Fix the local config and reopen the session.', { name, msg });
}

/**
 * 注入里那一句。
 *
 * 不说的话它会以为这些工具作用在自己那台机器上 —— 而"我以为我在自己机器上点浏览器"
 * 恰恰是最难看出来的一类错（截图回来的是另一台机器的屏幕）。
 */
export function forwardHelp(names: string[]): string {
  if (!names.length) return '';
  return `· 这些 MCP 的工具**作用在用户那台机器上**（KiroLex 把它们从用户机器转发过来）：`
    + `${names.map((n) => `\`${n}\``).join('、')}。`
    + `所以 \`browser_*\` 之类点的是**他屏幕上**那个浏览器 —— 这也正是他要看的；`
    + `这台机器上没有图形界面，别在这里另起一个。`;
}

/**
 * 名单里 HTTP 型那些的一句（`forwardHelp` 说的是"作用在用户机器上"，这里说的是"从用户机器发出"）。
 *
 * 不说的话它看到工具报错会"好心"在这台机器上另配一个同名 MCP 直连 —— 那里没有密钥，
 * 出口 IP 也不是用户的，上游要么拒绝要么记到别人头上。
 */
export function forwardHttpHelp(names: string[]): string {
  if (!names.length) return '';
  return `· 这些 MCP 由 KiroLex 从用户机器中转：${names.map((n) => `\`${n}\``).join('、')}。`
    + `它们的请求**从用户那台机器发出**（用他本机的网络出口和密钥），在这里直接调就行；`
    + `**不要**在这台机器上另配同名或指向同一地址的 MCP 去直连 —— 这里没有密钥，出口 IP 也不对。`
    + `报「本机→上游 …」的错是用户本机那头的问题（密钥 / 网络），原样告诉他，别在这里绕。`;
}

/* ---------------------------------------------- Claude Code / Codex 的「组合」 */

/** 隧道上 `/mcp/<token>/<名字>` 那一段能认的名字（同 `localMcp.ts` 的路由正则）。 */
const TUNNEL_NAME = /^[\w.-]{1,40}$/;

/**
 * **Claude Code / Codex 远程会话：组合里哪些 MCP 经本机中转**（组合见 `mcpCombos.ts`）。
 *
 *   · http 型、标了 `forwardFromLocal` —— 产出 http 规格，由 `HttpProxy` 在本机代发（超时 `timeoutSec`，默认 180 秒）；
 *   · http 型没标 —— 不出现（远程会话里没有它；要它就标上）；
 *   · stdio 型标了、或命令符合上面那两条老规则（本机路径 / `FORWARD_BY_NAME`）—— 本机起进程转发；
 *   · 其余 stdio —— 不出现。
 *
 * 头和 env 里的 `${env:…}` 在这里按传进来的环境（登录 shell 的）展开，和本地会话挂组合同一个口径；
 * 缺变量的那条跳过。名字要能放进隧道 URL、不能和 `kirolex-local` 撞，不然也跳过。
 * 跳过的都记进 `skipped`，由调用方在会话里说一句。
 */
export function forwardableFromCombo(
  servers: Record<string, McpComboServer>, env: Record<string, string | undefined>,
): { entries: ForwardEntry[]; skipped: Array<{ name: string; missing?: string[]; reason?: string }> } {
  const entries: ForwardEntry[] = [];
  const skipped: Array<{ name: string; missing?: string[]; reason?: string }> = [];
  const expand = (m: Record<string, string> | undefined, missing: string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m || {})) {
      const r = expandComboEnv(v, env);
      for (const n of r.missing) if (!missing.includes(n)) missing.push(n);
      out[k] = r.value;
    }
    return out;
  };
  for (const [name, s] of Object.entries(servers || {})) {
    if (!s || typeof s !== 'object' || s.disabled) continue;
    const isHttp = s.url !== undefined;
    const command = typeof s.command === 'string' ? s.command.trim() : '';
    const pick = isHttp
      ? !!s.forwardFromLocal
      : !!command && (!!s.forwardFromLocal || FORWARD_BY_NAME.includes(name) || isLocalPathCommand(command));
    if (!pick) continue;
    if (!TUNNEL_NAME.test(name)) {
      skipped.push({ name, reason: tr('Names may only use letters, digits, _ . - (at most 40), otherwise they cannot go into the forwarding URL') });
      continue;
    }
    if (name === 'kirolex-local') {
      skipped.push({ name, reason: tr('Clashes with the local tool channel kirolex-local') });
      continue;
    }
    const missing: string[] = [];
    if (isHttp) {
      const headers = expand(s.headers, missing);
      const sec = typeof s.timeoutSec === 'number' && s.timeoutSec > 0
        ? Math.min(FORWARD_TIMEOUT_SEC_MAX, Math.floor(s.timeoutSec))
        : FORWARD_TIMEOUT_SEC_DEFAULT;
      if (missing.length) { skipped.push({ name, missing }); continue; }
      entries.push({ type: 'http', name, url: String(s.url).trim(), headers, timeoutMs: sec * 1000 });
    } else {
      const childEnv = s.env ? expand(s.env, missing) : undefined;
      if (missing.length) { skipped.push({ name, missing }); continue; }
      entries.push({ name, command, args: Array.isArray(s.args) ? s.args.map(String) : [], ...(childEnv ? { env: childEnv } : {}) });
    }
  }
  return { entries, skipped };
}

/**
 * 交给远端适配器的 `mcpServers` 里追加的那几条：**只有隧道地址** `<base>/<名字>`，头是空的 ——
 * 上游 url、头、env、密钥、命令都只留在本机那份 `entries` 里（`server.setProxies` 用）。
 */
export function remoteComboMcpServers(
  entries: ForwardEntry[], tunnelBase: string,
): Array<{ type: 'http'; name: string; url: string; headers: never[] }> {
  return entries.map((e) => ({ type: 'http' as const, name: e.name, url: `${tunnelBase}/${e.name}`, headers: [] }));
}
