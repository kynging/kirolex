/**
 * **Claude Code / Codex 的「组合」** ——「不同对话挂不同的 MCP：普通对话不挂，专门对话（比如投研）才挂妙想」。
 *
 * Claude Code / Codex 没有 kiro 的 agent 文件，MCP 只能通过 ACP 的 `session/new` / `session/load` 的
 * `mcpServers` 交给适配器。所以 KiroLex 自己维护一份**本机全局**的组合清单
 * `~/.kirolex/mcp-combos.json`，每条会话记住选了哪个（`AgentProfile.mcpCombo`），起执行器时按它生成 `mcpServers`。
 *
 * 文件是一个列表：
 *
 * ```json
 * [
 *   { "id": "research", "name": "投研", "effort": "high",
 *     "mcpServers": {
 *       "miaoxiang": { "url": "https://…", "headers": { "Authorization": "Bearer ${env:MX_KEY}" } },
 *       "local": { "command": "node", "args": ["srv.js"], "env": { "TOKEN": "${env:TOKEN}" } }
 *     } }
 * ]
 * ```
 *
 * 内置一个「通用」（id `default`，没有 MCP、不设 effort）永远排第一；文件不存在时就只有它。
 * 这个模块不碰 electron，路径作为参数传入（测试用临时目录）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const BUILTIN_COMBO_ID = 'default';

export interface McpComboServer {
  /** 不写就按有 url / command 推断 */
  type?: 'http' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  timeoutSec?: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** 从本机转发（给远程会话用；本地会话里不起作用） */
  forwardFromLocal?: boolean;
  disabled?: boolean;
}

export interface McpCombo {
  id: string;
  name: string;
  /** 对应 ACP `thought_level` 的值；不写 = 沿用会话记住的 / 引擎默认 */
  effort?: string;
  mcpServers: Record<string, McpComboServer>;
}

export const BUILTIN_COMBO: McpCombo = Object.freeze({ id: BUILTIN_COMBO_ID, name: '通用', mcpServers: Object.freeze({}) as Record<string, McpComboServer> });

export function mcpCombosPath(home: string): string {
  return path.join(home, '.kirolex', 'mcp-combos.json');
}

/** 面板里文件还不存在时给的样板 */
export const MCP_COMBOS_TEMPLATE = `[
  {
    "id": "research",
    "name": "投研",
    "effort": "high",
    "mcpServers": {
      "miaoxiang": {
        "url": "https://example.com/mcp",
        "headers": { "Authorization": "Bearer \${env:MX_API_KEY}" }
      }
    }
  }
]
`;

const ENV_REF = /\$\{env:([^}]*)\}/g;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMBO_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function checkStringMap(v: unknown, what: string): string | null {
  if (v === undefined) return null;
  if (!isObj(v)) return `${what} 要是一个对象（名字 → 值）`;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') return `${what} 里「${k}」的值要是字符串`;
    for (const m of val.matchAll(ENV_REF)) {
      /* 不回显 `${env:…}` 里写的东西：写错的地方可能正是一段密钥（这句话会进日志） */
      if (!ENV_NAME.test(m[1])) return `${what} 里「${k}」的 \${env:…} 引用不是合法的环境变量名（只能是字母、数字、下划线，不能以数字开头）`;
    }
  }
  return null;
}

function checkServer(name: string, s: unknown): string | null {
  const where = `MCP「${name}」`;
  if (!name.trim()) return 'MCP 名字不能是空的';
  if (!isObj(s)) return `${where} 要是一个对象`;
  const hasUrl = s.url !== undefined;
  const hasCmd = s.command !== undefined;
  if (hasUrl && hasCmd) return `${where} 不能同时有 url 和 command（http 型写 url，stdio 型写 command）`;
  if (!hasUrl && !hasCmd) return `${where} 要么写 url（http 型），要么写 command（stdio 型）`;
  if (s.type !== undefined && s.type !== 'http' && s.type !== 'stdio') return `${where} 的 type 只能是 "http" 或 "stdio"`;
  if (s.type === 'http' && !hasUrl) return `${where} 的 type 是 http，但没有 url`;
  if (s.type === 'stdio' && !hasCmd) return `${where} 的 type 是 stdio，但没有 command`;
  for (const flag of ['forwardFromLocal', 'disabled'] as const) {
    if (s[flag] !== undefined && typeof s[flag] !== 'boolean') return `${where} 的 ${flag} 要是 true / false`;
  }
  if (hasUrl) {
    if (typeof s.url !== 'string' || !/^https?:\/\/\S+$/i.test(s.url)) return `${where} 的 url 要以 http:// 或 https:// 开头`;
    const h = checkStringMap(s.headers, `${where} 的 headers`);
    if (h) return h;
    if (s.timeoutSec !== undefined && (typeof s.timeoutSec !== 'number' || !Number.isFinite(s.timeoutSec) || s.timeoutSec <= 0)) {
      return `${where} 的 timeoutSec 要是正数（秒）`;
    }
    for (const k of ['command', 'args', 'env']) if (s[k] !== undefined) return `${where} 是 http 型，不能写 ${k}`;
  } else {
    if (typeof s.command !== 'string' || !s.command.trim()) return `${where} 的 command 不能是空的`;
    if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== 'string'))) return `${where} 的 args 要是字符串列表`;
    const e = checkStringMap(s.env, `${where} 的 env`);
    if (e) return e;
    for (const k of ['headers', 'timeoutSec']) if (s[k] !== undefined) return `${where} 是 stdio 型，不能写 ${k}`;
  }
  return null;
}

/**
 * **JSON 语法错误的可读原因 —— 只给行列，不带原文**。V8 的 `JSON.parse` 报错会把出错附近的原文整段带出来
 * （`Unexpected token 'S', "{"Authorization":S3CRET}" is not valid JSON`），而这句话会进日志 —— headers / env 的值
 * 正好就在里面。有的报错又不带位置，所以位置自己找：前缀在出错点之前只会报"没写完"（或者位置 ≥ 前缀长度），
 * 包含出错的那个字符之后才报别的 —— 二分找到第一个"别的"。
 */
function jsonSyntaxError(text: string): string {
  const incompleteOnly = (k: number): boolean => {
    try { JSON.parse(text.slice(0, k)); return true; } catch (e: any) {
      const msg = String(e?.message || '');
      if (/end of JSON input/i.test(msg)) return true;
      const pos = /position (\d+)/.exec(msg);
      return !!pos && Number(pos[1]) >= k;
    }
  };
  let lo = 0; let hi = text.length;   // 找最小的 k 使前缀 [0,k) 不再只是"没写完"
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (incompleteOnly(mid + 1)) lo = mid + 1; else hi = mid;
  }
  if (lo >= text.length) return '不是合法的 JSON：文件没写完（缺了右括号或引号？）';
  const before = text.slice(0, lo).split(/\r\n|\r|\n/);
  return `不是合法的 JSON：第 ${before.length} 行第 ${before[before.length - 1].length + 1} 列附近有语法错误（比如漏了引号或逗号）`;
}

export type ParseResult = { ok: true; combos: McpCombo[] } | { ok: false; error: string };

/** 解析 + 校验。成功时返回的清单第一个永远是内置「通用」。 */
export function parseMcpCombos(text: string): ParseResult {
  let raw: unknown;
  try { raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch {
    return { ok: false, error: jsonSyntaxError(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
  }
  if (!Array.isArray(raw)) return { ok: false, error: '文件内容要是一个组合列表（[ … ]）' };
  const combos: McpCombo[] = [BUILTIN_COMBO];
  const ids = new Set<string>([BUILTIN_COMBO_ID]);
  const names = new Set<string>([BUILTIN_COMBO.name]);
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    const at = `第 ${i + 1} 个组合`;
    if (!isObj(c)) return { ok: false, error: `${at}要是一个对象` };
    if (typeof c.id !== 'string' || !COMBO_ID.test(c.id)) return { ok: false, error: `${at}的 id 要是 1–64 位字母、数字、- 或 _` };
    if (c.id === BUILTIN_COMBO_ID) return { ok: false, error: `${at}：id「${BUILTIN_COMBO_ID}」是内置「通用」组合保留的，换一个` };
    if (ids.has(c.id)) return { ok: false, error: `${at}的 id「${c.id}」重复了` };
    if (typeof c.name !== 'string' || !c.name.trim()) return { ok: false, error: `${at}（${c.id}）缺少 name（下拉里显示的名字）` };
    const name = c.name.trim();
    if (names.has(name)) return { ok: false, error: `${at}的名字「${name}」重复了（下拉里会分不清）` };
    if (c.effort !== undefined && (typeof c.effort !== 'string' || !c.effort.trim())) return { ok: false, error: `${at}（${name}）的 effort 要是非空字符串，或者干脆不写` };
    if (c.mcpServers !== undefined && !isObj(c.mcpServers)) return { ok: false, error: `${at}（${name}）的 mcpServers 要是一个对象（名字 → 配置）` };
    const servers = (c.mcpServers || {}) as Record<string, unknown>;
    for (const [sn, s] of Object.entries(servers)) {
      const e = checkServer(sn, s);
      if (e) return { ok: false, error: `${at}（${name}）：${e}` };
    }
    ids.add(c.id);
    names.add(name);
    combos.push({
      id: c.id, name,
      ...(typeof c.effort === 'string' ? { effort: c.effort.trim() } : {}),
      mcpServers: servers as Record<string, McpComboServer>,
    });
  }
  return { ok: true, combos };
}

/** 读盘上的组合。文件不存在 = 只有「通用」；文件坏了也退回只有「通用」，并带上原因。 */
export function readMcpCombos(home: string): { combos: McpCombo[]; error?: string; exists: boolean; text: string } {
  let text: string;
  try { text = fs.readFileSync(mcpCombosPath(home), 'utf-8'); } catch {
    return { combos: [BUILTIN_COMBO], exists: false, text: '' };
  }
  const r = parseMcpCombos(text);
  return r.ok ? { combos: r.combos, exists: true, text } : { combos: [BUILTIN_COMBO], error: r.error, exists: true, text };
}

/** 保存前校验；校验不过不写盘。写法是 tmp + rename（崩溃不留半个文件）。 */
export function saveMcpCombos(home: string, text: string): ParseResult {
  const r = parseMcpCombos(text);
  if (!r.ok) return r;
  const file = mcpCombosPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return r;
}

/** 按 id 找；没选 / 找不到（被删了）→ 通用 */
export function pickCombo(combos: McpCombo[], id: string | undefined): McpCombo {
  return (id && combos.find((c) => c.id === id)) || combos.find((c) => c.id === BUILTIN_COMBO_ID) || BUILTIN_COMBO;
}

/** 展开 `${env:NAME}`。缺的变量记进 `missing`（空字符串算"有"）。 */
export function expandEnvRefs(value: string, env: Record<string, string | undefined>): { value: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(ENV_REF, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) { if (!missing.includes(name)) missing.push(name); return ''; }
    return v;
  });
  return { value: out, missing };
}

export type AcpHttpMcp = { type: 'http'; name: string; url: string; headers: Array<{ name: string; value: string }> };
export type AcpStdioMcp = { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };
export type AcpMcpServer = AcpHttpMcp | AcpStdioMcp;

/**
 * 本地会话：把组合里没 disabled 的 MCP 按 ACP 的格式交出去（环境变量在这里展开）。
 * `forwardFromLocal` 在本地会话里不起作用 —— 全都直接用。环境变量缺了的那一条跳过，记进 `skipped`。
 */
export function buildAcpMcpServers(
  combo: McpCombo, env: Record<string, string | undefined>,
): { servers: AcpMcpServer[]; skipped: Array<{ name: string; missing: string[] }> } {
  const servers: AcpMcpServer[] = [];
  const skipped: Array<{ name: string; missing: string[] }> = [];
  const pairs = (m: Record<string, string> | undefined, missing: string[]) => Object.entries(m || {}).map(([k, v]) => {
    const r = expandEnvRefs(v, env);
    for (const n of r.missing) if (!missing.includes(n)) missing.push(n);
    return { name: k, value: r.value };
  });
  for (const [name, s] of Object.entries(combo.mcpServers)) {
    if (s.disabled) continue;
    const missing: string[] = [];
    const entry: AcpMcpServer = s.url !== undefined
      ? { type: 'http', name, url: s.url, headers: pairs(s.headers, missing) }
      : { name, command: s.command || '', args: [...(s.args || [])], env: pairs(s.env, missing) };
    if (missing.length) { skipped.push({ name, missing }); continue; }
    servers.push(entry);
  }
  return { servers, skipped };
}

/** 给日志用的副本：headers / env 的值一律打码（原对象不动）。 */
export function maskAcpServers(servers: AcpMcpServer[]): unknown[] {
  const mask = (xs: Array<{ name: string; value: string }>) => xs.map((x) => ({ name: x.name, value: '***' }));
  return servers.map((s) => ('headers' in s ? { ...s, headers: mask(s.headers) } : { ...s, env: mask(s.env) }));
}

/**
 * 组合要的 effort 能不能设：当前引擎 / 模型的 `thought_level` 清单里有它就设；
 * 没有（或者引擎根本不给 effort 选项）就**不设**（退回默认档位），给一句提示 —— 不报错、不阻断。
 */
export function planComboEffort(
  want: string,
  opts: { current: string; options: Array<{ value: string; name: string }> } | null,
  comboName = '',
): { apply: boolean; notice?: string } {
  if (opts && opts.options.some((o) => o.value === want)) return { apply: true };
  const who = comboName ? `组合「${comboName}」` : '组合';
  const avail = opts?.options.length ? `（可选：${opts.options.map((o) => o.value).join(' / ')}）` : '（这个引擎没给 effort 选项）';
  return { apply: false, notice: `ℹ️ ${who}要的 effort「${want}」当前引擎 / 模型不支持${avail}` };
}

type EffortSelect = { current: string; options: Array<{ value: string; name: string }> } | null;

/**
 * 「默认档位」是哪个：Claude Code 的清单里有一项 `default`；Codex 没有这一项，它自己的默认是 `medium`。
 * 两个都没有就是 undefined（不猜，保持当前档位并说出来）。
 */
export function defaultEffort(opts: EffortSelect): string | undefined {
  if (!opts) return undefined;
  return ['default', 'medium'].find((v) => opts.options.some((o) => o.value === v));
}

/**
 * **把组合要的 effort 设上；设不上就主动退回默认档位** —— 光"跳过不设"不够：重连加载已有会话（session/load）时
 * 适配器可能带着上一次的档位回来（比如上个组合的 high），跳过就等于沿用了它。
 *
 * 两种设不上：清单里没有这个值（不支持）、适配器拒绝了 set。两种都退回 `defaultEffort`，并返回一句给会话的提示。
 * 不抛错 —— 这一步永远不该阻断会话。`io.options()` 每次重读：set 之后可选值可能变。
 */
export async function applyComboEffort(
  want: string,
  comboName: string,
  io: { options: () => EffortSelect; set: (value: string) => Promise<void> },
): Promise<{ value?: string; notice?: string }> {
  const plan = planComboEffort(want, io.options(), comboName);
  let base = plan.notice || '';
  if (plan.apply) {
    if (io.options()?.current === want) return { value: want };
    try { await io.set(want); return { value: want }; } catch (err: any) {
      base = `⚠️ 组合「${comboName}」要的 effort「${want}」没设上（${err?.message || err}）`;
    }
  }
  const now = io.options();
  const fb = defaultEffort(now);
  const keep = now?.current ? `「${now.current}」` : '';
  if (!fb) return { notice: `${base}，这个引擎没有可以退回的默认档位，保持当前档位${keep}。` };
  if (now?.current === fb) return { value: fb, notice: `${base}，用默认档位「${fb}」。` };
  try {
    await io.set(fb);
    return { value: fb, notice: `${base}，已退回默认档位「${fb}」。` };
  } catch (err: any) {
    return { notice: `${base}，退回默认档位「${fb}」也没成功（${err?.message || err}），保持当前档位${keep}。` };
  }
}
