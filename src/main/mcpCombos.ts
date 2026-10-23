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
 * 文件里写了 `id: "default"` 的条目就用它**取代**内置那条（同样排第一）；没写 default、但恰好有一条照「插入示例」
 * 建的自建通用（`findGeneralLikeCombo`）时，也让它顶替内置那条 —— 下拉里只留一条通用（见 `parseMcpCombos`）。
 * 这个模块不碰 electron，路径作为参数传入（测试用临时目录）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { tr } from './uiText.ts';

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
  /**
   * 顶替内置「通用」的那条自建通用在文件里原来的 id（如 `general`）。它在清单里的 id 是 `default`，
   * 记着原 id 的会话 / 设置也解析到它（`findCombo`）。
   */
  aliases?: string[];
}

export const BUILTIN_COMBO: McpCombo = Object.freeze({ id: BUILTIN_COMBO_ID, name: '通用', mcpServers: Object.freeze({}) as Record<string, McpComboServer> });

/**
 * 下拉 / 提示里显示的名字。内置那个的 `name`（「通用」）**不改** —— 它参与「名字重复」校验，
 * 跟着界面语言变会让同一份文件在两种语言下一个过、一个不过；只在显示时换成当前语言。
 */
export function comboDisplayName(combo: Pick<McpCombo, 'id' | 'name'>): string {
  /* 覆盖内置的那条（文件里的 default / 自建通用）有自己的名字就显示它；没写名字时名字就是「通用」 */
  return combo.id === BUILTIN_COMBO_ID && combo.name === BUILTIN_COMBO.name ? tr('General') : combo.name;
}

export function mcpCombosPath(home: string): string {
  return path.join(home, '.kirolex', 'mcp-combos.json');
}

/**
 * 面板里「插入示例」插进去的样板（文件不存在时**不**直接显示成内容 —— 看着像「投研」已经配好了）。
 * 第一条写 `id: "default"`，直接替换内置的「通用」（让通用带上本机工具）：`forwardFromLocal: true` 的 MCP 在远程会话里经本机转发（本机起、远端用），
 * 本地会话里照常直接用；http 型（如 context7）不需要转发。
 */
export const MCP_COMBOS_TEMPLATE = `[
  {
    "id": "default",
    "name": "通用",
    "mcpServers": {
      "builder-mcp": { "command": "builder-mcp", "forwardFromLocal": true },
      "context7": { "url": "https://mcp.context7.com/mcp" }
    }
  },
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
  if (!isObj(v)) return tr('{what} must be an object (name → value)', { what });
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') return tr('{what}: the value of "{k}" must be a string', { what, k });
    for (const m of val.matchAll(ENV_REF)) {
      /* 不回显 `${env:…}` 里写的东西：写错的地方可能正是一段密钥（这句话会进日志） */
      if (!ENV_NAME.test(m[1])) return tr('{what}: the ${env:...} reference in "{k}" is not a valid environment variable name (letters, digits and underscores only, not starting with a digit)', { what, k });
    }
  }
  return null;
}

function checkServer(name: string, s: unknown): string | null {
  const where = tr('MCP "{name}"', { name });
  if (!name.trim()) return tr('The MCP name cannot be empty');
  if (!isObj(s)) return tr('{where} must be an object', { where });
  const hasUrl = s.url !== undefined;
  const hasCmd = s.command !== undefined;
  if (hasUrl && hasCmd) return tr('{where} cannot have both url and command (url for http, command for stdio)', { where });
  if (!hasUrl && !hasCmd) return tr('{where} needs either url (http) or command (stdio)', { where });
  if (s.type !== undefined && s.type !== 'http' && s.type !== 'stdio') return tr('{where}: type must be "http" or "stdio"', { where });
  if (s.type === 'http' && !hasUrl) return tr('{where}: type is http but there is no url', { where });
  if (s.type === 'stdio' && !hasCmd) return tr('{where}: type is stdio but there is no command', { where });
  for (const flag of ['forwardFromLocal', 'disabled'] as const) {
    if (s[flag] !== undefined && typeof s[flag] !== 'boolean') return tr('{where}: {flag} must be true / false', { where, flag });
  }
  if (hasUrl) {
    if (typeof s.url !== 'string' || !/^https?:\/\/\S+$/i.test(s.url)) return tr('{where}: url must start with http:// or https://', { where });
    const h = checkStringMap(s.headers, tr('{where} headers', { where }));
    if (h) return h;
    if (s.timeoutSec !== undefined && (typeof s.timeoutSec !== 'number' || !Number.isFinite(s.timeoutSec) || s.timeoutSec <= 0)) {
      return tr('{where}: timeoutSec must be a positive number (seconds)', { where });
    }
    for (const k of ['command', 'args', 'env']) if (s[k] !== undefined) return tr('{where} is an http server and cannot have {k}', { where, k });
  } else {
    if (typeof s.command !== 'string' || !s.command.trim()) return tr('{where}: command cannot be empty', { where });
    if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== 'string'))) return tr('{where}: args must be a list of strings', { where });
    const e = checkStringMap(s.env, tr('{where} env', { where }));
    if (e) return e;
    for (const k of ['headers', 'timeoutSec']) if (s[k] !== undefined) return tr('{where} is a stdio server and cannot have {k}', { where, k });
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
  if (lo >= text.length) return tr('Invalid JSON: the file ends too early (missing a closing bracket or quote?)');
  const before = text.slice(0, lo).split(/\r\n|\r|\n/);
  return tr('Invalid JSON: syntax error near line {line}, column {col} (a missing quote or comma?)', { line: before.length, col: before[before.length - 1].length + 1 });
}

/**
 * **照「插入示例」建的自建通用**是哪一条：`id` 为 `general`，或名字以「通用」/ General 开头。
 * 恰好一条才算（返回下标）；没有或不止一条 → -1（不迁移，维持现状）。纯函数，`raw` 是文件里的列表原样。
 */
export function findGeneralLikeCombo(raw: unknown[]): number {
  const hits: number[] = [];
  raw.forEach((c, i) => {
    if (!isObj(c)) return;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (c.id === 'general' || name.startsWith('通用') || /^general/i.test(name)) hits.push(i);
  });
  return hits.length === 1 ? hits[0] : -1;
}

export type ParseResult = { ok: true; combos: McpCombo[] } | { ok: false; error: string };

/**
 * 解析 + 校验。成功时返回的清单第一个永远是 id `default` 的「通用」：文件里写了 `id: "default"` 就是那条；
 * 没写但有一条自建通用（`findGeneralLikeCombo`）就是它（id 换成 `default`，原 id 记进 `aliases`）；都没有是内置那条。
 * 只影响返回的清单，文件本身不改（它跟着 S3 同步，别的电脑可能是旧版本）。
 */
export function parseMcpCombos(text: string): ParseResult {
  let raw: unknown;
  try { raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch {
    return { ok: false, error: jsonSyntaxError(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
  }
  if (!Array.isArray(raw)) return { ok: false, error: tr('The file must contain a list of combos ([ ... ])') };
  const hasOverride = raw.some((c) => isObj(c) && c.id === BUILTIN_COMBO_ID);
  const generalAt = hasOverride ? -1 : findGeneralLikeCombo(raw);
  const replaced = hasOverride || generalAt >= 0;
  const combos: McpCombo[] = replaced ? [] : [BUILTIN_COMBO];
  const ids = new Set<string>(replaced ? [] : [BUILTIN_COMBO_ID]);
  const names = new Set<string>(replaced ? [] : [BUILTIN_COMBO.name]);
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    const at = tr('Combo #{n}', { n: i + 1 });
    if (!isObj(c)) return { ok: false, error: tr('{at} must be an object', { at }) };
    if (typeof c.id !== 'string' || !COMBO_ID.test(c.id)) return { ok: false, error: tr('{at}: id must be 1-64 letters, digits, - or _', { at }) };
    if (ids.has(c.id)) return { ok: false, error: tr('{at}: id "{id}" is a duplicate', { at, id: c.id }) };
    const isDefault = c.id === BUILTIN_COMBO_ID;
    /* 覆盖内置的那条可以不写名字 —— 显示「通用」 */
    const rawName = isDefault && c.name === undefined ? BUILTIN_COMBO.name : c.name;
    if (typeof rawName !== 'string' || !rawName.trim()) return { ok: false, error: tr('{at} ({id}) has no name (the name shown in the dropdown)', { at, id: c.id }) };
    const name = rawName.trim();
    if (names.has(name)) return { ok: false, error: tr('{at}: name "{name}" is a duplicate (the dropdown could not tell them apart)', { at, name }) };
    if (c.effort !== undefined && (typeof c.effort !== 'string' || !c.effort.trim())) return { ok: false, error: tr('{at} ({name}): effort must be a non-empty string, or omitted', { at, name }) };
    if (c.mcpServers !== undefined && !isObj(c.mcpServers)) return { ok: false, error: tr('{at} ({name}): mcpServers must be an object (name → config)', { at, name }) };
    const servers = (c.mcpServers || {}) as Record<string, unknown>;
    for (const [sn, s] of Object.entries(servers)) {
      const e = checkServer(sn, s);
      if (e) return { ok: false, error: tr('{at} ({name}): {e}', { at, name, e }) };
    }
    ids.add(c.id);
    names.add(name);
    const asGeneral = isDefault || i === generalAt;
    const combo: McpCombo = {
      id: asGeneral ? BUILTIN_COMBO_ID : c.id, name,
      ...(typeof c.effort === 'string' ? { effort: c.effort.trim() } : {}),
      mcpServers: servers as Record<string, McpComboServer>,
      ...(i === generalAt ? { aliases: [c.id] } : {}),
    };
    if (asGeneral) combos.unshift(combo); else combos.push(combo);
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

/**
 * 写盘：tmp + rename（崩溃不留半个文件）。写不进去时把 tmp 删掉再抛 —— 调用方决定怎么报。
 * S3 同步拉下来 / 合并出来的那份也走这里。
 */
export function writeMcpCombosText(home: string, text: string): void {
  const file = mcpCombosPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 本来就没写出来 */ }
    throw err;
  }
}

/**
 * 保存前校验；校验不过不写盘。**写盘失败也回 `{ ok: false, error }`、不抛** ——
 * 「组合那里明明写的投研，为什么显示是通用」：以前写盘失败是一个抛出去的 IPC 异常，日志里什么都没有。
 * 写完再从盘上读一遍，读回来的和刚存的不一样（或读回来解析不过）也算没存上。
 */
export function saveMcpCombos(home: string, text: string): ParseResult {
  const r = parseMcpCombos(text);
  if (!r.ok) return r;
  const file = mcpCombosPath(home);
  try { writeMcpCombosText(home, text); } catch (err: any) {
    return { ok: false, error: tr('Could not write {file}: {err}', { file, err: String(err?.code || err?.message || err) }) };
  }
  const back = readMcpCombos(home);
  if (!back.exists || back.text !== text || back.error) {
    return { ok: false, error: tr('{file} was written, but reading it back did not give the same content; it may not have been saved', { file }) };
  }
  return { ok: true, combos: back.combos };
}

/** 按 id 找（顶替内置通用的那条，记着它原 id 的也算）；找不到 → undefined */
export function findCombo<T extends Pick<McpCombo, 'id' | 'aliases'>>(combos: T[], id: string | undefined): T | undefined {
  if (!id) return undefined;
  return combos.find((c) => c.id === id) || combos.find((c) => c.aliases?.includes(id));
}

/** 按 id 找；没选 / 找不到（被删了）→ 通用 */
export function pickCombo(combos: McpCombo[], id: string | undefined): McpCombo {
  return findCombo(combos, id) || combos.find((c) => c.id === BUILTIN_COMBO_ID) || BUILTIN_COMBO;
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
  const who = comboName ? tr('Combo "{name}"', { name: comboName }) : tr('The combo');
  const avail = opts?.options.length
    ? tr(' (options: {list})', { list: opts.options.map((o) => o.value).join(' / ') })
    : tr(' (this engine offers no effort options)');
  return { apply: false, notice: tr('⚠️ {who} wants effort "{want}", which the current engine / model does not support{avail}', { who, want, avail }) };
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
      base = tr('⚠️ Could not set effort "{want}" for combo "{name}" ({err})', { want, name: comboName, err: String(err?.message || err) });
    }
  }
  const now = io.options();
  const fb = defaultEffort(now);
  const cur = now?.current || '';
  if (!fb) {
    return { notice: cur
      ? tr('{base}; this engine has no default level to fall back to, keeping the current level "{cur}".', { base, cur })
      : tr('{base}; this engine has no default level to fall back to, keeping the current level.', { base }) };
  }
  if (now?.current === fb) return { value: fb, notice: tr('{base}; using the default level "{fb}".', { base, fb }) };
  try {
    await io.set(fb);
    return { value: fb, notice: tr('{base}; fell back to the default level "{fb}".', { base, fb }) };
  } catch (err: any) {
    const e = String(err?.message || err);
    return { notice: cur
      ? tr('{base}; falling back to the default level "{fb}" also failed ({err}), keeping the current level "{cur}".', { base, fb, err: e, cur })
      : tr('{base}; falling back to the default level "{fb}" also failed ({err}), keeping the current level.', { base, fb, err: e }) };
  }
}

/**
 * **当前模型给不给 effort**（审计 1b）—— 实测 Claude Code 切到 haiku 后 configOptions 里根本没有 effort 那一项，
 * 硬设会回 `Internal error`。组合里的 effort 这时**不设、不报错**，界面在组合旁边说一声（`renderer/comboPick.comboEffortNote`）。
 */
export function modelOffersEffort(opts: EffortSelect): boolean {
  return !!opts && opts.options.length > 0;
}
