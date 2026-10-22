/**
 * **远程机器上 Claude Code（及 Codex）的统一配置** ——「统一定义远程机器上 Claude Code 的配置并同步过去；
 * 本机专用的 MCP 不同步；这份配置也要进备份」。
 *
 * 配置在本机 `~/.kirolex/agent-profiles/`：
 *
 *   · `claude/profile.json` —— `versions`（claude-code / claude-agent-acp / codex / codex-acp 的版本）、
 *     `settings`（要下发到远端 `~/.claude/settings.json` 的键，`{{AWS_REGION}}` 之类的占位按机器填）、
 *     `marketplaces`（插件市场：从本机拷的目录型，或 github / git）、`excludeLocalOnly`（永远不下发的键）；
 *   · `claude/rules/*.md` —— 下发到远端 `~/.claude/rules/`（同名覆盖，远端多出来的不删）；
 *   · `codex/profile.json` —— `versions`（codex / codex-acp）+ `config`。自动同步**只改远端 `~/.codex/config.toml`
 *     最顶层的 `model` / `model_provider` 两行**，任何表都不加不改；嵌套项（provider 的 region 等）远端缺的时候
 *     显示「需手动配置」（见 `mergeCodexTopKeys`）。
 *
 * 同步的规矩（和测试一一对应）：
 *   · **先备份**远端 `~/.claude/{settings.json,rules,plugins}`（和 `~/.codex/config.toml`）到
 *     `~/.claude/.kirolex-backup-<时间>/`，备份不成功什么都不改；写入脚本自己也再查一遍备份目录在不在；
 *   · settings.json **合并**：配置里有的键覆盖，远端独有的保留；**凭证类 env 一律不碰**（不删、不改、不读值 ——
 *     探测只报键名）；`mcpServers` 等本机专用 / 凭证类的键永远不下发（`ALWAYS_EXCLUDED` + `excludeLocalOnly`）；
 *   · 只读比较（`computeDiff`）和真正写入用**同一个合并函数**（`mergeSettings`），差异列表就是将要改的内容。
 *
 * 纯模块（不 import electron）：远端跑的探测 / 写入脚本在这里生成（JS 部分是本文件里的函数 `toString()`
 * 拼进去的 —— 所以那几个函数必须**自包含**，不能引用模块里别的东西），`index.ts` 只负责跑 ssh。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ADAPTER_PACKAGE } from './engines.ts';
import { tr } from './uiText.ts';

export type ProfileEngine = 'claude' | 'codex';
export const PROFILE_ENGINES: ProfileEngine[] = ['claude', 'codex'];

/** 相对 `~/.kirolex` 的目录（也是 S3 key 里 `v1/` 之后那段的开头）。 */
export const AGENT_PROFILES_REL = 'agent-profiles';
/** 冲突副本放这里（不下发、不上传）。 */
export const PROFILE_CONFLICTS_DIR = '.conflicts';

export function agentProfilesRoot(home: string): string {
  return path.join(home, '.kirolex', AGENT_PROFILES_REL);
}
export function profileFile(home: string, engine: ProfileEngine): string {
  return path.join(agentProfilesRoot(home), engine, 'profile.json');
}
export function rulesDir(home: string): string {
  return path.join(agentProfilesRoot(home), 'claude', 'rules');
}

// ---------------------------------------------------------------- 工具与版本

export type ToolId = 'claude-code' | 'claude-agent-acp' | 'codex' | 'codex-acp';
export const TOOL_IDS: ToolId[] = ['claude-code', 'claude-agent-acp', 'codex', 'codex-acp'];
export interface ToolSpec { id: ToolId; pkg: string; bin: string; engine: ProfileEngine; adapter: boolean }
export const TOOL_SPECS: Record<ToolId, ToolSpec> = {
  'claude-code': { id: 'claude-code', pkg: '@anthropic-ai/claude-code', bin: 'claude', engine: 'claude', adapter: false },
  'claude-agent-acp': { id: 'claude-agent-acp', pkg: ADAPTER_PACKAGE.claude, bin: 'claude-agent-acp', engine: 'claude', adapter: true },
  codex: { id: 'codex', pkg: '@openai/codex', bin: 'codex', engine: 'codex', adapter: false },
  'codex-acp': { id: 'codex-acp', pkg: ADAPTER_PACKAGE.codex, bin: 'codex-acp', engine: 'codex', adapter: true },
};

/** 版本号只认这种样子（拼进远端命令行的东西必须先过这一关）。 */
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

/** `versions` 的键可以写工具名（`claude-code`）、命令名（`claude`）或 npm 包名（`@anthropic-ai/claude-code`）。 */
export function normalizeVersions(raw: unknown): Partial<Record<ToolId, string>> {
  const out: Partial<Record<ToolId, string>> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const spec = Object.values(TOOL_SPECS).find((s) => s.id === k || s.pkg === k || s.bin === k);
    const ver = String(v ?? '').trim().replace(/^v/, '');
    if (spec && VERSION_RE.test(ver)) out[spec.id] = ver;
  }
  return out;
}

// ---------------------------------------------------------------- 配置文件

export interface MarketplaceSpec {
  name: string;
  /** Claude Code `known_marketplaces.json` 里那种 `{ source: 'github', repo }` / `{ source: 'directory', path }` / `{ source: 'git', url }` */
  source?: Record<string, unknown>;
  /** 从本机哪个目录拷过去（目录型市场，例如 aim 的 `~/.aim/cc-plugins`）。 */
  copyFrom?: string;
}

export interface ClaudeProfile {
  versions: Partial<Record<ToolId, string>>;
  settings: Record<string, unknown>;
  marketplaces: MarketplaceSpec[];
  excludeLocalOnly: string[];
}

export interface CodexProfile {
  versions: Partial<Record<ToolId, string>>;
  config: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseJsonObject(text: string): { ok: true; value: Record<string, any> } | { ok: false; error: string } {
  const body = String(text ?? '');
  let v: unknown;
  try { v = JSON.parse(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body); } catch (err: any) {
    return { ok: false, error: tr('Not valid JSON: {error}', { error: String(err?.message || err) }) };
  }
  if (!isObj(v)) return { ok: false, error: tr('The top level must be a JSON object { … }') };
  return { ok: true, value: v };
}

/** 一条 `excludeLocalOnly`：字符串取开头那个键（后面可以跟说明），对象取 key / path / pattern / name。 */
function exclusionToken(item: unknown, prefix = ''): string | null {
  let raw = '';
  if (typeof item === 'string') raw = item;
  else if (isObj(item)) raw = String(item.key ?? item.path ?? item.pattern ?? item.name ?? '');
  const tok = /^[^\s（(：:,，]+/.exec(raw.trim())?.[0] || '';
  if (!tok) return null;
  return prefix && !tok.startsWith(prefix) ? `${prefix}${tok}` : tok;
}

/** 种子里 `excludeLocalOnly` 可能是列表，也可能是按类分组的对象（`{ env: [...], settings: [...] }`）。 */
function parseExclusions(raw: unknown): string[] {
  const out: string[] = [];
  const push = (t: string | null) => { if (t && !out.includes(t)) out.push(t); };
  if (Array.isArray(raw)) for (const it of raw) push(exclusionToken(it));
  else if (isObj(raw)) {
    for (const [group, items] of Object.entries(raw)) {
      const prefix = /env/i.test(group) ? 'env.' : '';
      if (Array.isArray(items)) for (const it of items) push(exclusionToken(it, prefix));
      else if (typeof items === 'string') push(exclusionToken(items, prefix));
    }
  }
  return out;
}

/** `marketplaces` 可以是 `{ 名字: 说明 }`，也可以是 `[{ name, … }]` 或名字列表。 */
function parseMarketplaces(raw: unknown): MarketplaceSpec[] {
  const out: MarketplaceSpec[] = [];
  const one = (name: string, v: unknown) => {
    name = String(name || '').trim();
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || out.some((m) => m.name === name)) return;
    const spec: MarketplaceSpec = { name };
    if (isObj(v)) {
      const src = isObj(v.source) ? v.source : (typeof v.source === 'string' ? sourceFromString(v.source) : undefined);
      if (src) spec.source = src;
      else if (typeof v.repo === 'string') spec.source = { source: 'github', repo: v.repo };
      else if (typeof v.url === 'string') spec.source = { source: 'git', url: v.url };
      const copy = v.copyFrom ?? v.copyFromLocal ?? v.localPath ?? v.from ?? v.localDir;
      if (typeof copy === 'string' && copy.trim()) spec.copyFrom = copy.trim();
      if (!spec.copyFrom && spec.source?.source === 'directory' && typeof spec.source.path === 'string') spec.copyFrom = spec.source.path;
    } else if (typeof v === 'string' && v.trim()) {
      spec.source = sourceFromString(v.trim());
      if (spec.source?.source === 'directory') spec.copyFrom = String(spec.source.path);
    }
    out.push(spec);
  };
  if (Array.isArray(raw)) {
    for (const it of raw) {
      if (typeof it === 'string') one(it, undefined);
      else if (isObj(it)) one(String(it.name ?? ''), it);
    }
  } else if (isObj(raw)) {
    for (const [name, v] of Object.entries(raw)) one(name, v);
  }
  return out;
}

function sourceFromString(s: string): Record<string, unknown> {
  if (/^(\/|~|[A-Za-z]:[\\/])/.test(s)) return { source: 'directory', path: s };
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return { source: 'github', repo: s };
  return { source: 'git', url: s };
}

export type ParseResult<T> = { ok: true; profile: T } | { ok: false; error: string };

/**
 * 读 `claude/profile.json`。**向后兼容地读种子**：认不出的顶层键原样留在文件里（编辑器显示的是原文），
 * 这里只取认得的；`versions` 的键几种写法都认。
 */
export function parseClaudeProfile(text: string): ParseResult<ClaudeProfile> {
  const j = parseJsonObject(text);
  if (!j.ok) return j;
  const v = j.value;
  if (v.versions !== undefined && !isObj(v.versions)) return { ok: false, error: tr('"{key}" must be an object', { key: 'versions' }) };
  if (v.settings !== undefined && !isObj(v.settings)) return { ok: false, error: tr('"{key}" must be an object', { key: 'settings' }) };
  /* env 必须是对象：null / 字符串 / 数组会在合并时整份换掉远端的 env（连同它的凭证） */
  if (isObj(v.settings) && v.settings.env !== undefined && !isObj(v.settings.env)) return { ok: false, error: tr('"{key}" must be an object', { key: 'settings.env' }) };
  return {
    ok: true,
    profile: {
      versions: normalizeVersions(v.versions),
      settings: isObj(v.settings) ? v.settings : {},
      marketplaces: parseMarketplaces(v.marketplaces),
      excludeLocalOnly: parseExclusions(v.excludeLocalOnly ?? v.excludeLocal ?? v.localOnly),
    },
  };
}

export function parseCodexProfile(text: string): ParseResult<CodexProfile> {
  const j = parseJsonObject(text);
  if (!j.ok) return j;
  const v = j.value;
  if (v.versions !== undefined && !isObj(v.versions)) return { ok: false, error: tr('"{key}" must be an object', { key: 'versions' }) };
  const config = v.config ?? v.configToml ?? v['config.toml'];
  if (config !== undefined && !isObj(config)) return { ok: false, error: tr('"{key}" must be an object', { key: 'config' }) };
  return { ok: true, profile: { versions: normalizeVersions(v.versions), config: isObj(config) ? config : {} } };
}

export function parseProfile(engine: ProfileEngine, text: string): ParseResult<ClaudeProfile | CodexProfile> {
  return engine === 'claude' ? parseClaudeProfile(text) : parseCodexProfile(text);
}

export interface ProfileFileState { path: string; exists: boolean; text: string; error?: string }

export function readProfileFile(home: string, engine: ProfileEngine): ProfileFileState {
  const file = profileFile(home, engine);
  let text: string;
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return { path: file, exists: false, text: '' }; }
  const r = parseProfile(engine, text);
  return { path: file, exists: true, text, ...(r.ok ? {} : { error: r.error }) };
}

/**
 * 保存：解析 / 校验不过就**不写盘**（坏 JSON 不保存）；写是 tmp + rename。
 * `expected`：编辑器打开时磁盘上的原文（`null` = 当时文件不存在）。给了而磁盘上已经不是它了
 * （S3 同步从别的电脑拉回了新的）→ 不写，免得用旧底子改出来的内容盖掉新文件。
 */
export function saveProfileText(home: string, engine: ProfileEngine, text: string, opts: { expected?: string | null } = {}): { ok: true } | { ok: false; error: string; changedOnDisk?: true } {
  const r = parseProfile(engine, String(text ?? ''));
  if (!r.ok) return r;
  const file = profileFile(home, engine);
  if (opts.expected !== undefined) {
    let cur: string | null = null;
    try { cur = fs.readFileSync(file, 'utf-8'); } catch { cur = null; }
    if (cur !== opts.expected) {
      return { ok: false, changedOnDisk: true, error: tr('{file} was changed on disk after you opened it (for example pulled in by S3 sync from another computer). Not saved, so the newer file is not overwritten.', { file }) };
    }
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err: any) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 本来就没写出来 */ }
    return { ok: false, error: tr('Could not write {file}: {err}', { file, err: String(err?.code || err?.message || err) }) };
  }
  return { ok: true };
}

export function sha256(text: string | Buffer): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 规则文件名：只许一层、`.md` 结尾（远端写入脚本会再检一次）。 */
export const RULE_NAME_RE = /^[^/\\\0]{1,120}\.md$/;

export interface LocalRule { name: string; content: string; hash: string }

export function readLocalRules(home: string): LocalRule[] {
  const dir = rulesDir(home);
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => RULE_NAME_RE.test(n) && !n.startsWith('.')).sort(); } catch { return []; }
  const out: LocalRule[] = [];
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      const content = fs.readFileSync(path.join(dir, name), 'utf-8');
      out.push({ name, content, hash: sha256(content) });
    } catch { /* 读不了的跳过 */ }
  }
  return out;
}

/** 编辑器里「插入模板」用的（文件不存在时）。和种子同一个形状；插件 / 规则 / permissions 留给你自己填。 */
export const CLAUDE_PROFILE_TEMPLATE = `${JSON.stringify({
  versions: { 'claude-code': '2.1.308', 'claude-agent-acp': '0.94.0', codex: '0.163.0', 'codex-acp': '2.2.2' },
  settings: {
    env: {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: '{{AWS_REGION}}',
      ANTHROPIC_BEDROCK_REGION_PREFIX: 'global',
      ANTHROPIC_MODEL: 'global.anthropic.claude-opus-5-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'global.anthropic.claude-opus-5-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'global.anthropic.claude-sonnet-5-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'global.anthropic.claude-haiku-5-5',
    },
    model: 'opus',
    permissions: { deny: [] },
    includeCoAuthoredBy: true,
    skipDangerousModePermissionPrompt: true,
    theme: 'dark',
    enabledPlugins: {},
  },
  marketplaces: {
    'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } },
  },
  excludeLocalOnly: ['mcpServers', 'statusLine', '_meshclaw_managed*', 'env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_API_KEY', 'env.ANTHROPIC_AUTH_TOKEN'],
}, null, 2)}\n`;

export const CODEX_PROFILE_TEMPLATE = `${JSON.stringify({
  versions: { codex: '0.163.0', 'codex-acp': '2.2.2' },
  config: {
    model: 'openai.gpt-6.1-sol',
    model_provider: 'amazon-bedrock',
    model_providers: { 'amazon-bedrock': { aws: { region: 'us-east-1' } } },
  },
}, null, 2)}\n`;

// ---------------------------------------------------------------- 排除 / 凭证 / 占位

/**
 * **永远不下发**的键，不管 `excludeLocalOnly` 写没写：本机专用的 MCP（远程会话靠 KiroLex 的本机转发，
 * 见 `forwardMcp.ts`），以及拿凭证的脚本（本机路径，下发过去也是错的）。
 */
export const ALWAYS_EXCLUDED = ['mcpServers', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];

/** 凭证类键名（env 的键 / config.toml 的键）。按词边界认：`ANTHROPIC_API_KEY` 是，`MAX_THINKING_TOKENS` 不是。 */
export const CRED_KEY_RE_SRC = '(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|ACCESS_KEY|PRIVATE_KEY|BEARER|COOKIE|AUTHORIZATION|HEADERS)(_|$)';
const CRED_KEY_RE = new RegExp(CRED_KEY_RE_SRC, 'i');
export function isCredentialKey(name: string): boolean {
  return CRED_KEY_RE.test(String(name || ''));
}

export function excludedPatterns(profile: Pick<ClaudeProfile, 'excludeLocalOnly'> | null | undefined): string[] {
  return [...ALWAYS_EXCLUDED, ...(profile?.excludeLocalOnly || []).filter((p) => !ALWAYS_EXCLUDED.includes(p))];
}

/**
 * 这个键路径（`env.X` / `permissions.deny` / `statusLine`）被排除了吗。`*` 是通配；
 * 不带点的模式同时认顶层键和 env 的键（种子里网关地址可能直接写成 `ANTHROPIC_BASE_URL`）。
 * 和 `mergeSettings` 里那份同一条规则（那份是自包含的，要拼进远端脚本）。
 */
export function matchesExcluded(keyPath: string, patterns: string[]): boolean {
  const res = patterns.map((p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));
  const parts = keyPath.split('.');
  for (let i = 1; i <= parts.length; i += 1) {
    const pre = parts.slice(0, i).join('.');
    if (res.some((r) => r.test(pre))) return true;
  }
  if (parts[0] === 'env' && parts.length > 1) {
    const bare = patterns.filter((p) => !p.includes('.'));
    return bare.some((p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(parts[1]));
  }
  return false;
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** 把字符串里的 `{{NAME}}` 换成这台机器的值；没有的记进 `unresolved`。 */
export function fillPlaceholders(value: string, vars: Record<string, string | undefined>): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const out = String(value).replace(PLACEHOLDER_RE, (m, name: string) => {
    const v = vars[name];
    if (v === undefined || v === '') { if (!unresolved.includes(name)) unresolved.push(name); return m; }
    return v;
  });
  return { value: out, unresolved };
}

export interface SkippedKey { key: string; why: 'excluded' | 'credential' | 'placeholder'; names?: string[] }

/**
 * 配置里的 `settings` → 要下发的那一份（patch）：去掉排除的键、去掉凭证类 env（**不同步任何凭证**），
 * 占位按这台机器填（填不上的那个键这次不下发，记进 `skipped`），本机家目录换成远端的。
 */
export function desiredSettings(
  profile: ClaudeProfile,
  vars: Record<string, string | undefined>,
  opts: { localHome?: string; remoteHome?: string } = {},
): { patch: Record<string, unknown>; skipped: SkippedKey[] } {
  const patterns = excludedPatterns(profile);
  const skipped: SkippedKey[] = [];
  const rehome = (s: string): string => replaceHome(s, opts.localHome, opts.remoteHome);
  const fill = (v: unknown, keyPath: string): { ok: boolean; value: unknown; names: string[] } => {
    if (typeof v === 'string') {
      const r = fillPlaceholders(rehome(v), vars);
      return { ok: !r.unresolved.length, value: r.value, names: r.unresolved };
    }
    if (Array.isArray(v)) {
      const names: string[] = [];
      const arr = v.map((x, i) => { const r = fill(x, `${keyPath}[${i}]`); names.push(...r.names); return r.value; });
      return { ok: !names.length, value: arr, names };
    }
    if (isObj(v)) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const p = `${keyPath}.${k}`;
        if (matchesExcluded(p, patterns)) { skipped.push({ key: p, why: 'excluded' }); continue; }
        if (keyPath === 'env' && isCredentialKey(k)) { skipped.push({ key: p, why: 'credential' }); continue; }
        const r = fill(x, p);
        if (!r.ok) { skipped.push({ key: p, why: 'placeholder', names: r.names }); continue; }
        o[k] = r.value;
      }
      return { ok: true, value: o, names: [] };
    }
    return { ok: true, value: v, names: [] };
  };
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(profile.settings || {})) {
    if (matchesExcluded(k, patterns)) { skipped.push({ key: k, why: 'excluded' }); continue; }
    if (isCredentialKey(k)) { skipped.push({ key: k, why: 'credential' }); continue; }
    const r = fill(v, k);
    if (!r.ok) { skipped.push({ key: k, why: 'placeholder', names: r.names }); continue; }
    patch[k] = r.value;
  }
  return { patch, skipped };
}

/**
 * 把文本里的本机家目录换成远端家目录。认几种写法（原样 / 正斜杠 / JSON 转义过的 Windows 路径）；
 * JSON 转义过的那种，换进去的远端路径也照样转义（不然改出一份坏 JSON）。长的先换。
 */
export function replaceHome(text: string, localHome: string | undefined, remoteHome: string | undefined): string {
  if (!localHome || !remoteHome || localHome.length <= 3) return text;
  const pairs: Array<[string, string]> = [[localHome, remoteHome]];
  if (localHome.includes('\\')) {
    pairs.push([localHome.split('\\').join('/'), remoteHome]);
    pairs.push([localHome.split('\\').join('\\\\'), remoteHome.split('\\').join('\\\\')]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}

/**
 * **合并 settings.json**：`patch` 里有的键覆盖，远端独有的保留；对象逐层合并（`env`、`permissions`、`enabledPlugins`），
 * 数组和标量整体替换。被排除的键、`env` 里的凭证类键**不碰**（哪怕 patch 里有 —— 双保险）。
 *
 * **自包含**：会被 `toString()` 拼进远端写入脚本（`applyScript`），只读的差异计算也用它（`computeDiff`）——
 * 差异列表和真正写进去的是同一套规则。
 */
export function mergeSettings(
  remote: unknown,
  patch: unknown,
  opts: { excluded: string[]; credRe: string },
): { merged: Record<string, any>; changed: Array<{ key: string; want: unknown; have: unknown }> } {
  const credRe = new RegExp(opts.credRe, 'i');
  const isO = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
  const glob = (p: string) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const pats = (opts.excluded || []).map(glob);
  const bare = (opts.excluded || []).filter((p) => p.indexOf('.') < 0).map(glob);
  const excluded = (keyPath: string): boolean => {
    const parts = keyPath.split('.');
    for (let i = 1; i <= parts.length; i += 1) {
      const pre = parts.slice(0, i).join('.');
      if (pats.some((r) => r.test(pre))) return true;
    }
    return parts[0] === 'env' && parts.length > 1 && bare.some((r) => r.test(parts[1]));
  };
  const clone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const same = (a: unknown, b: unknown): boolean => {
    const canon = (v: any): string => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
      : isO(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
    return canon(a) === canon(b);
  };
  const merged: Record<string, any> = isO(remote) ? clone(remote) : {};
  const changed: Array<{ key: string; want: unknown; have: unknown }> = [];
  const walk = (dst: Record<string, any>, src: Record<string, any>, prefix: string) => {
    for (const k of Object.keys(src)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (excluded(p)) continue;
      if (prefix === 'env' && credRe.test(k)) continue;
      const sv = src[k];
      /* env 只逐键合并，**绝不整份替换**（null / 字符串 / 数组都会连远端的凭证一起抹掉）——保存时也会拒 */
      if (p === 'env' && !isO(sv)) continue;
      if (isO(sv) && isO(dst[k])) { walk(dst[k], sv, p); continue; }
      if (isO(sv) && dst[k] === undefined) {
        /* 远端整个没有这个对象：逐个子键报差异（界面上一行一个 env），写的时候整份放进去 */
        dst[k] = {};
        walk(dst[k], sv, p);
        continue;
      }
      if (!same(dst[k], sv)) {
        changed.push({ key: p, want: clone(sv), have: clone(dst[k]) });
        dst[k] = clone(sv);
      }
    }
  };
  walk(merged, isO(patch) ? patch : {}, '');
  return { merged, changed };
}

// ---------------------------------------------------------------- config.toml（Codex）

/**
 * **Codex 只自动同步两项**：config.toml **最顶层**（第一个表头之前）的 `model` 和 `model_provider`。
 * 其余（provider 的 region 等嵌套项）一律不自动改 —— 远端缺的在差异里显示「需手动配置：<路径>」。
 * （手写的 TOML 合并在多行字符串、点号键、内联表、数组表、转义引号上连续写坏过文件，所以收窄到这两行。）
 */
export const CODEX_TOP_KEYS = ['model', 'model_provider'];

/** 嵌套对象 → 「路径 + 值」（只给「需手动配置」那一栏显示用）。 */
function flattenPaths(config: Record<string, unknown>, prefix = ''): Array<{ path: string; value: unknown }> {
  const out: Array<{ path: string; value: unknown }> = [];
  for (const [k, v] of Object.entries(config || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) out.push(...flattenPaths(v, p));
    else if (v !== null && v !== undefined) out.push({ path: p, value: v });
  }
  return out;
}

/**
 * config.toml 的这一项能不能出现在同步 / 差异里：只认 model / model_provider 和 `model_providers.*`；
 * **本机 MCP（`mcp_servers`）永远不碰**；路径里任何一段像凭证 / 认证头（`http_headers`、`Authorization`、
 * `experimental_bearer_token`…）的一律不要。
 */
export function codexEntryAllowed(table: string, key: string): boolean {
  const segs = table ? table.split('.') : [];
  if (segs[0] === 'mcp_servers') return false;
  const inScope = segs.length === 0 ? CODEX_TOP_KEYS.includes(key) : segs[0] === 'model_providers' && segs.length >= 2;
  return inScope && ![...segs, key].some((p) => isCredentialKey(p));
}

/** codex 配置 → 自动同步的两项（只要字符串值）+ 只能手动配置的嵌套项。 */
export function codexPlan(codex: CodexProfile | null): { top: Array<{ key: string; value: string }>; manual: Array<{ path: string; value: string }> } {
  const top: Array<{ key: string; value: string }> = [];
  const manual: Array<{ path: string; value: string }> = [];
  if (!codex) return { top, manual };
  for (const { path: p, value } of flattenPaths(codex.config)) {
    const segs = p.split('.');
    const key = segs[segs.length - 1];
    const table = segs.slice(0, -1).join('.');
    if (!codexEntryAllowed(table, key)) continue;
    if (!table && typeof value === 'string' && !/[\r\n]/.test(value)) top.push({ key, value });
    else manual.push({ path: p, value: Array.isArray(value) ? JSON.stringify(value) : String(value) });
  }
  return { top, manual };
}

/**
 * **逐字符扫一遍 TOML，标出每一行是不是在一个跨行的值里面**（多行字符串 / 跨行数组）。**自包含**。
 * 只用来认「第一个表头在哪」「哪一行是顶层的键行」：多行字符串里像 `[表]` 或 `model = …` 的行不能当真。
 *   · `inside[i]`：第 i 行开头还在一个没结束的值里；
 *   · `multi[i]`：第 i 行是键行，而它的值到行尾还没结束。
 * 认的东西：`"…"`（带 `\` 转义）、`'…'`、`"""…"""`（带转义；结尾允许多出 1–2 个引号）、`'''…'''`、`#` 注释、
 * 值里的 `[` `{` 嵌套。
 */
export function tomlLineStates(lines: string[]): { inside: boolean[]; multi: boolean[] } {
  const inside: boolean[] = [];
  const multi: boolean[] = [];
  /* n = 普通；b = "…"；l = '…'；B = """…"""；L = '''…''' */
  let mode = 'n';
  let depth = 0;
  const run = (l: string, j: number, ch: string) => { let k = 0; while (l[j + k] === ch) k += 1; return k; };
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const n = l.length;
    const startedInside = mode === 'B' || mode === 'L' || depth > 0;
    inside.push(startedInside);
    if (!startedInside && /^\s*\[/.test(l)) { multi.push(false); continue; }   // 表头
    let inValue = startedInside;
    let j = 0;
    while (j < n) {
      const c = l[j];
      if (mode === 'B') {
        if (c === '\\') { j += 2; continue; }
        if (c === '"') { const k = run(l, j, '"'); if (k >= 3) { mode = 'n'; j += Math.min(k, 5); continue; } j += k; continue; }
        j += 1; continue;
      }
      if (mode === 'L') {
        if (c === "'") { const k = run(l, j, "'"); if (k >= 3) { mode = 'n'; j += Math.min(k, 5); continue; } j += k; continue; }
        j += 1; continue;
      }
      if (mode === 'b') { if (c === '\\') { j += 2; continue; } if (c === '"') mode = 'n'; j += 1; continue; }
      if (mode === 'l') { if (c === "'") mode = 'n'; j += 1; continue; }
      if (c === '#') break;
      if (c === '"') { if (run(l, j, '"') >= 3) { mode = 'B'; j += 3; } else { mode = 'b'; j += 1; } continue; }
      if (c === "'") { if (run(l, j, "'") >= 3) { mode = 'L'; j += 3; } else { mode = 'l'; j += 1; } continue; }
      if (c === '=') inValue = true;
      else if (inValue && (c === '[' || c === '{')) depth += 1;
      else if (inValue && (c === ']' || c === '}')) depth = Math.max(0, depth - 1);
      j += 1;
    }
    /* 单行字符串不能跨行（那是坏 TOML）：行尾收掉，不让它影响后面 */
    if (mode === 'b' || mode === 'l') mode = 'n';
    multi.push(!startedInside && (mode === 'B' || mode === 'L' || depth > 0));
  }
  return { inside, multi };
}

/**
 * **严格的最小校验**（和合并逻辑互相独立，**自包含**）：`result` 和 `original` 比，只允许
 *   · 文件开头多出至多两行 `model = "…"` / `model_provider = "…"`；
 *   · 原有的某一行 `model = "…"` / `model_provider = "…"`（单行普通字符串）换了值，而且它前面没有任何像表头的行。
 * 其余任何一行（包括换行符）和原文不同 → false。每个键最多改一处。
 */
export function onlyTopKeyLinesChanged(original: string, result: string): boolean {
  const O = String(original).split('\n');
  const R = String(result).split('\n');
  const k = R.length - O.length;
  if (k < 0 || k > 2) return false;
  const seen: string[] = [];
  const inserted = /^(model|model_provider) = "(?:[^"\\\r\n]|\\.)*"\r?$/;
  const keyLine = /^\s*("?)(model|model_provider)\1\s*=\s*"(?:[^"\\\r\n]|\\.)*"\s*(?:#.*)?\r?$/;
  /*
    原文顶层（第一个像表头的行之前）有带转义的引号键：解不出来，或者解出来就是 model / model_provider
    （`"model"`）→ 任何改动都不认（插一行就会和它重复）。
  */
  const escaped: string[] = [];
  if (result !== original) {
    for (const a of O) {
      if (/^\s*\[/.test(a)) break;
      const q = /^\s*("(?:[^"\\\r\n]|\\.)*")/.exec(a);
      if (!q || q[1].indexOf('\\') < 0) continue;
      let dk: unknown;
      try { dk = JSON.parse(q[1]); } catch { dk = undefined; }
      if (typeof dk !== 'string') return false;
      escaped.push(dk);
    }
  }
  for (let i = 0; i < k; i += 1) {
    const m = inserted.exec(R[i]);
    if (!m || seen.indexOf(m[1]) >= 0) return false;
    seen.push(m[1]);
  }
  let headerSeen = false;
  for (let i = 0; i < O.length; i += 1) {
    const a = O[i];
    const b = R[i + k];
    if (a !== b) {
      const ma = keyLine.exec(a);
      const mb = keyLine.exec(b);
      if (headerSeen || !ma || !mb || ma[2] !== mb[2] || seen.indexOf(ma[2]) >= 0) return false;
      if (a.endsWith('\r') !== b.endsWith('\r')) return false;
      seen.push(ma[2]);
    }
    if (/^\s*\[/.test(a)) headerSeen = true;
  }
  /* 改了 / 插了的键，原文顶层已经用带转义的引号键写过 → 会重复 */
  return !seen.some((s) => escaped.indexOf(s) >= 0);
}

/**
 * **只改顶层的 model / model_provider**（**自包含**，会被拼进远端写入脚本）：
 *   · 第一个表头之前已经有这一行、而且值是单行普通字符串（`"…"`）→ 只换值，缩进 / 等号两边的空白 / 行尾注释原样；
 *   · 那里有这个键但不是这种写法（`'…'`、多行字符串、点号键、写了两次…）→ 不动，记进 skipped；
 *   · 没有 → 插到文件最开头（一定在第一个表头之前）。文件以 BOM 开头时不插（插在 BOM 前面会坏），记进 skipped；
 *   · 永远不加、不改任何表或表头。
 * 写回之前过一遍 `onlyTopKeyLinesChanged`：除了这两行还有任何不同 → 整份不改，全部记成跳过。CRLF 文件逐字节保留。
 */
export function mergeCodexTopKeys(
  text: string,
  entries: Array<{ key: string; value: unknown }>,
  /* 远端写入脚本里显式传进来（toString 之后引用不到模块里的函数） */
  lexer: (lines: string[]) => { inside: boolean[]; multi: boolean[] } = tomlLineStates,
  check: (original: string, result: string) => boolean = onlyTopKeyLinesChanged,
): { text: string; changed: string[]; skipped: string[] } {
  const src = String(text || '');
  const lines = src.split('\n');
  const bare = lines.map((l) => l.replace(/\r$/, ''));
  const crlf = /\r\n/.test(src);
  const st = lexer(bare);
  let first = bare.length;
  for (let i = 0; i < bare.length; i += 1) if (!st.inside[i] && /^\s*\[/.test(bare[i])) { first = i; break; }
  const out = lines.slice();
  const inserts: string[] = [];
  const changed: string[] = [];
  const skipped: string[] = [];
  /*
    顶层带转义的引号键（`"model" = "old"` 解出来就是 model）：按 JSON 规则解一下（TOML 的基本字符串转义是它的子集，
    `\U…` / `\e` 除外）。解出来是 model / model_provider → 那一项不改不插；解不出来 → 说不准是哪个键，两项都不动、
    原文不动。跳过的在差异里显示「需手动配置」。
  */
  const escapedKeys: string[] = [];
  for (let i = 0; i < first; i += 1) {
    if (st.inside[i]) continue;
    const q = /^\s*("(?:[^"\\\r\n]|\\.)*")/.exec(bare[i]);
    if (!q || q[1].indexOf('\\') < 0) continue;
    let k: unknown;
    try { k = JSON.parse(q[1]); } catch { k = undefined; }
    /* 解不出来（\U…、\e 等 JSON 没有的转义）→ 说不准是哪个键：两项都不动 */
    if (typeof k !== 'string') return { text: src, changed: [], skipped: entries.map((x) => x.key) };
    escapedKeys.push(k);
  }
  for (const e of entries) {
    /* 顶层已经用带转义的引号键写了这个键（`"model"` 就是 model）→ 这一项不改不插 */
    if (escapedKeys.indexOf(e.key) >= 0) { skipped.push(e.key); continue; }
    if (['model', 'model_provider'].indexOf(e.key) < 0 || typeof e.value !== 'string' || /[\r\n]/.test(e.value)) { skipped.push(e.key); continue; }
    const plain = new RegExp(`^(\\s*)(${e.key}|"${e.key}")(\\s*=\\s*)"((?:[^"\\\\]|\\\\.)*)"(\\s*(?:#.*)?)$`);
    const mention = new RegExp(`^\\s*(${e.key}|"${e.key}"|'${e.key}')\\s*[.=]`);
    let found = -1;
    let odd = false;
    for (let i = 0; i < first; i += 1) {
      if (st.inside[i]) continue;
      if (plain.test(bare[i]) && !st.multi[i]) { if (found >= 0) odd = true; found = i; } else if (mention.test(bare[i])) odd = true;
    }
    if (odd) { skipped.push(e.key); continue; }
    const want = JSON.stringify(e.value);
    if (found >= 0) {
      const m = plain.exec(bare[found]) as RegExpExecArray;
      let cur: unknown;
      try { cur = JSON.parse(`"${m[4]}"`); } catch { cur = undefined; }
      if (cur === e.value) continue;
      out[found] = `${m[1]}${m[2]}${m[3]}${want}${m[5]}${lines[found].endsWith('\r') ? '\r' : ''}`;
      changed.push(e.key);
    } else {
      if (src.charCodeAt(0) === 0xfeff) { skipped.push(e.key); continue; }
      inserts.push(`${e.key} = ${want}${crlf ? '\r' : ''}`);
      changed.push(e.key);
    }
  }
  if (!changed.length) return { text: src, changed, skipped };
  /* 空文件：split 出来是 ['']，插进去的行后面要留一个换行 */
  const result = [...inserts, ...out].join('\n');
  if (!check(src, result)) return { text: src, changed: [], skipped: entries.map((x) => x.key) };
  return { text: result, changed, skipped };
}

// ---------------------------------------------------------------- 远端探测（只读）

export interface ProbeTool { path: string | null; version: string | null }
export interface ProbeResult {
  /** 远端没有 node：只拿到了家目录，其余都不知道。 */
  noNode?: boolean;
  home: string;
  user?: string;
  tools: Partial<Record<ToolId, ProbeTool>>;
  settingsExists?: boolean;
  /** 远端 settings.json（凭证类 env 和本机专用键的**值**已在远端去掉）。 */
  settings: Record<string, any> | null;
  settingsError?: string | null;
  /** 远端 settings.json 的 env 里有哪些凭证类键（只有键名）。 */
  secretEnvKeys: string[];
  plugins: string[];
  marketplaces: string[];
  rules: Array<{ name: string; hash: string }>;
  codexTomlExists?: boolean;
  /**
   * 远端 config.toml **顶层**（第一个表头之前）的 model / model_provider。`plain` = 是单行普通字符串
   * （只有这种会被自动同步改）；不是这种写法时 `value` 是原文片段。没有 config.toml = null。
   */
  codexTop: Array<{ key: string; value: string; plain: boolean }> | null;
  /** 远端有哪些 `[model_providers.<名字>]` 表（只看有没有，不读内容）。 */
  codexProviders: string[];
  region: string | null;
}

/**
 * 远端跑的探测（`node` 执行）。**自包含**。只读：版本、settings.json（凭证类 env 只回键名）、
 * 已装插件、已知市场、rules 的摘要、config.toml 的标量、这台机器的区域（IMDS → aws 配置 → 环境变量）。
 */
export function remoteProbeMain(o: { credRe: string; dropKeys: string[]; tools: Array<{ id: string; pkg: string; bin: string; cli: boolean }>; imds: boolean }, tomlLexer: typeof tomlLineStates): void {
  const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), crypto = require('crypto');
  const home = os.homedir();
  const credRe = new RegExp(o.credRe, 'i');
  const isO = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
  const run = (cmd: string, args: string[], timeout = 20000): string | null => {
    try {
      const r = cp.spawnSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      return r.status === 0 ? String(r.stdout || '') : null;
    } catch { return null; }
  };
  const which = (bin: string): string | null => {
    const r = run('sh', ['-c', 'command -v "$1"', 'sh', bin]);
    const p = r ? r.trim().split('\n')[0] : '';
    return p || null;
  };
  const semver = (s: string | null): string | null => { const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(s || ''); return m ? m[1] : null; };
  const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
  const pkgUp = (start: string, pkg: string): string | null => {
    let d = start;
    for (let i = 0; i < 8 && d && d !== path.dirname(d); i += 1) {
      const j = readJson(path.join(d, 'package.json'));
      if (j && j.name === pkg) return j.version || null;
      d = path.dirname(d);
    }
    return null;
  };
  const npmRootRaw = run('npm', ['root', '-g']);
  const npmRoot = npmRootRaw ? npmRootRaw.trim() : '';
  const out: any = {
    home, user: (() => { try { return os.userInfo().username; } catch { return ''; } })(),
    tools: {}, settings: null, settingsExists: false, settingsError: null, secretEnvKeys: [],
    plugins: [], marketplaces: [], rules: [], codexTop: null, codexProviders: [], codexTomlExists: false, region: null,
  };
  for (const tl of o.tools) {
    const p = which(tl.bin);
    let version: string | null = null;
    if (tl.cli && p) version = semver(run(tl.bin, ['--version']));
    if (!version && p) {
      try {
        const real = fs.realpathSync(p);
        version = pkgUp(path.dirname(real), tl.pkg);
        if (!version) {
          /* remote-bootstrap.sh 放的包装脚本：exec '<node>' '<…/dist/index.js>' */
          const head = String(fs.readFileSync(real, 'utf8')).slice(0, 4000);
          const m = /'([^']*\/dist\/index\.js)'/.exec(head);
          if (m) version = pkgUp(path.dirname(m[1]), tl.pkg);
        }
      } catch { /* 读不了 */ }
    }
    if (!version && p && npmRoot) { const j = readJson(path.join(npmRoot, tl.pkg, 'package.json')); version = (j && j.version) || null; }
    out.tools[tl.id] = { path: p, version };
  }
  const sf = path.join(home, '.claude', 'settings.json');
  if (fs.existsSync(sf)) {
    out.settingsExists = true;
    const j = readJson(sf);
    if (!isO(j)) out.settingsError = 'unparsable';
    else {
      for (const k of Object.keys(j)) {
        if (o.dropKeys.indexOf(k) >= 0 || credRe.test(k)) j[k] = '<redacted>';
      }
      if (isO(j.env)) {
        for (const k of Object.keys(j.env)) if (credRe.test(k)) { out.secretEnvKeys.push(k); delete j.env[k]; }
      }
      out.settings = j;
    }
  }
  const ip = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  if (isO(ip)) out.plugins = Object.keys(isO(ip.plugins) ? ip.plugins : ip).filter((k) => k.indexOf('@') > 0);
  const km = readJson(path.join(home, '.claude', 'plugins', 'known_marketplaces.json'));
  if (isO(km)) out.marketplaces = Object.keys(km);
  try {
    const rd = path.join(home, '.claude', 'rules');
    for (const n of fs.readdirSync(rd)) {
      if (!/\.md$/.test(n)) continue;
      try { out.rules.push({ name: n, hash: crypto.createHash('sha256').update(fs.readFileSync(path.join(rd, n))).digest('hex') }); } catch { /* 读不了 */ }
    }
  } catch { /* 没有 rules 目录 */ }
  const ct = path.join(home, '.codex', 'config.toml');
  if (fs.existsSync(ct)) {
    out.codexTomlExists = true;
    out.codexTop = [];
    /*
      只读两样：顶层（第一个表头之前）的 model / model_provider，和有哪些 [model_providers.<名字>] 表（只看有没有）。
      多行字符串里像表头 / 键的行不当真（和 mergeCodexTopKeys 同一个扫描器）。
    */
    const rawLines = String(fs.readFileSync(ct, 'utf8')).split(/\r?\n/);
    const st = tomlLexer(rawLines);
    let headerSeen = false;
    for (let li = 0; li < rawLines.length; li += 1) {
      const raw = rawLines[li];
      if (st.inside[li]) continue;
      if (/^\s*\[/.test(raw)) {
        headerSeen = true;
        const pm = /^\s*\[\s*model_providers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/.exec(raw);
        const name = pm ? (pm[1] || pm[2] || pm[3]) : '';
        if (name && out.codexProviders.indexOf(name) < 0) out.codexProviders.push(name);
        continue;
      }
      if (headerSeen) continue;
      /* 带转义的引号键（`"model"`）：解出来是这两个键之一 → 记成「不是普通写法」；解不出来 → 两个都记（同 mergeCodexTopKeys） */
      const q = /^\s*("(?:[^"\\]|\\.)*")/.exec(raw);
      if (q && q[1].indexOf('\\') >= 0) {
        let dk: unknown;
        try { dk = JSON.parse(q[1]); } catch { dk = undefined; }
        for (const key of ['model', 'model_provider']) {
          if (typeof dk !== 'string' || dk === key) out.codexTop.push({ key, value: raw.trim().slice(0, 80), plain: false });
        }
        continue;
      }
      for (const key of ['model', 'model_provider']) {
        const plain = new RegExp(`^\\s*("?)${key}\\1\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*(?:#.*)?$`).exec(raw);
        if (plain && !st.multi[li]) {
          let v = plain[2];
          try { v = JSON.parse(`"${plain[2]}"`); } catch { /* 原样 */ }
          out.codexTop.push({ key, value: v, plain: true });
        } else if (new RegExp(`^\\s*(${key}|"${key}"|'${key}')\\s*[.=]`).test(raw)) {
          out.codexTop.push({ key, value: raw.trim().slice(0, 80), plain: false });
        }
      }
    }
  }
  if (o.imds) {
    const tok = run('curl', ['-s', '-m', '2', '-X', 'PUT', 'http://169.254.169.254/latest/api/token', '-H', 'X-aws-ec2-metadata-token-ttl-seconds: 60'], 5000);
    if (tok) {
      const r = run('curl', ['-s', '-m', '2', '-H', `X-aws-ec2-metadata-token: ${tok.trim()}`, 'http://169.254.169.254/latest/meta-data/placement/region'], 5000);
      if (r && /^[a-z]{2}(-[a-z]+)+-\d+$/.test(r.trim())) out.region = r.trim();
    }
  }
  if (!out.region && out.settings && isO(out.settings.env) && typeof out.settings.env.AWS_REGION === 'string' && !/\{\{/.test(out.settings.env.AWS_REGION)) out.region = out.settings.env.AWS_REGION;
  if (!out.region) { const r = run('aws', ['configure', 'get', 'region'], 8000); if (r && r.trim()) out.region = r.trim(); }
  if (!out.region) out.region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || null;
  process.stdout.write(`KX_PROFILE_PROBE ${JSON.stringify(out)}\n`);
}

export function probeArgs(opts: { imds?: boolean } = {}) {
  return {
    credRe: CRED_KEY_RE_SRC,
    dropKeys: ALWAYS_EXCLUDED,
    tools: TOOL_IDS.map((id) => ({ id, pkg: TOOL_SPECS[id].pkg, bin: TOOL_SPECS[id].bin, cli: !TOOL_SPECS[id].adapter })),
    imds: opts.imds !== false,
  };
}

/** 探测用的 JS（`node` 直接跑）。 */
export function probeJs(opts: { imds?: boolean } = {}): string {
  return `(${remoteProbeMain.toString()})(${JSON.stringify(probeArgs(opts))}, (${tomlLineStates.toString()}));\n`;
}

/** 远端 `bash -lc` 里跑的探测：没有 node 也给一行（家目录 + noNode）。 */
export function probeScript(): string {
  return [
    'set +e',
    'if ! command -v node >/dev/null 2>&1; then',
    '  printf \'KX_PROFILE_PROBE {"noNode":true,"home":"%s","user":"%s"}\\n\' "$HOME" "$(id -un 2>/dev/null)"',
    '  exit 0',
    'fi',
    'node - <<\'KX_PROBE_EOF\'',
    probeJs(),
    'KX_PROBE_EOF',
  ].join('\n');
}

export function parseProbeOutput(output: string): ProbeResult | null {
  const line = String(output || '').split(/\r?\n/).reverse().find((l) => l.startsWith('KX_PROFILE_PROBE '));
  if (!line) return null;
  let j: any;
  try { j = JSON.parse(line.slice('KX_PROFILE_PROBE '.length)); } catch { return null; }
  if (!isObj(j) || typeof j.home !== 'string') return null;
  return {
    noNode: !!j.noNode,
    home: j.home,
    user: typeof j.user === 'string' ? j.user : undefined,
    tools: isObj(j.tools) ? j.tools : {},
    settingsExists: !!j.settingsExists,
    settings: isObj(j.settings) ? j.settings : null,
    settingsError: j.settingsError || null,
    secretEnvKeys: Array.isArray(j.secretEnvKeys) ? j.secretEnvKeys.map(String) : [],
    plugins: Array.isArray(j.plugins) ? j.plugins.map(String) : [],
    marketplaces: Array.isArray(j.marketplaces) ? j.marketplaces.map(String) : [],
    rules: Array.isArray(j.rules) ? j.rules.filter((r: any) => isObj(r) && typeof r.name === 'string').map((r: any) => ({ name: r.name, hash: String(r.hash || '') })) : [],
    codexTomlExists: !!j.codexTomlExists,
    codexTop: Array.isArray(j.codexTop) ? j.codexTop.filter((x: any) => isObj(x) && typeof x.key === 'string').map((x: any) => ({ key: x.key, value: String(x.value ?? ''), plain: !!x.plain })) : null,
    codexProviders: Array.isArray(j.codexProviders) ? j.codexProviders.map(String) : [],
    region: typeof j.region === 'string' && j.region ? j.region : null,
  };
}

/** 占位能用的变量：`AWS_REGION`（这台机器的区域）、`HOME`、`USER`。 */
export function machineVars(probe: Pick<ProbeResult, 'home' | 'user' | 'region'>): Record<string, string | undefined> {
  return { AWS_REGION: probe.region || undefined, HOME: probe.home || undefined, USER: probe.user || undefined };
}

// ---------------------------------------------------------------- 差异

export type DiffArea = 'version' | 'adapter' | 'settings' | 'plugin' | 'marketplace' | 'rule' | 'codex' | 'warning';
/** `manual` = 不会自动同步、要你到那台机器上手动配置（Codex 的嵌套项、顶层那两项不是普通写法时）。 */
export type DiffStatus = 'missing' | 'different' | 'unresolved' | 'error' | 'skipped' | 'manual';
export interface DiffItem { area: DiffArea; key: string; status: DiffStatus; want?: string; have?: string }

export interface DiffInput {
  claude: ClaudeProfile | null;
  codex: CodexProfile | null;
  localRules: Array<{ name: string; hash: string }>;
  probe: ProbeResult;
  localHome?: string;
}

/** 两份配置合起来的版本：codex 那份的 codex / codex-acp 优先，其余用 claude 那份。 */
export function effectiveVersions(claude: ClaudeProfile | null, codex: CodexProfile | null): Partial<Record<ToolId, string>> {
  return { ...(claude?.versions || {}), ...(codex?.versions || {}) };
}

const show = (v: unknown): string => {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
};

/** 要用到的插件（`enabledPlugins` 里值为 true 的、没被排除的）。 */
export function wantedPlugins(profile: ClaudeProfile | null): string[] {
  const ep = profile?.settings?.enabledPlugins;
  if (!isObj(ep)) return [];
  const patterns = excludedPatterns(profile);
  return Object.keys(ep).filter((id) => ep[id] === true && /^[^@\s]+@[A-Za-z0-9._-]+$/.test(id) && !matchesExcluded(`enabledPlugins.${id}`, patterns));
}

export function wantedMarketplaces(profile: ClaudeProfile | null): string[] {
  const names = new Set<string>((profile?.marketplaces || []).map((m) => m.name));
  for (const id of wantedPlugins(profile)) names.add(id.slice(id.lastIndexOf('@') + 1));
  return [...names];
}

/**
 * **与配置的差异**（只读）。每一项就是「同步到这台机器」会改的那一处；空列表 = 和配置一致。
 * 凭证类 env 根本不在比较范围里（探测只拿到了键名）。
 */
export function computeDiff(input: DiffInput): DiffItem[] {
  const { claude, codex, probe } = input;
  const items: DiffItem[] = [];
  if (probe.noNode) items.push({ area: 'warning', key: 'node', status: 'missing' });
  const versions = effectiveVersions(claude, codex);
  for (const id of TOOL_IDS) {
    const spec = TOOL_SPECS[id];
    const want = versions[id];
    const have = probe.tools[id];
    const engineWanted = spec.engine === 'claude' ? !!claude : (!!codex || !!want);
    if (spec.adapter && engineWanted && !have?.path) {
      items.push({ area: 'adapter', key: spec.bin, status: 'missing', ...(want ? { want } : {}) });
      continue;
    }
    if (!want) continue;
    if (!have?.path && !have?.version) items.push({ area: 'version', key: id, status: 'missing', want });
    else if (have.version !== want) items.push({ area: 'version', key: id, status: 'different', want, have: have.version || '?' });
  }
  if (claude && !probe.noNode) {
    const vars = machineVars(probe);
    const { patch, skipped } = desiredSettings(claude, vars, { localHome: input.localHome, remoteHome: probe.home });
    for (const s of skipped) if (s.why === 'placeholder') items.push({ area: 'warning', key: s.key, status: 'unresolved', want: (s.names || []).map((n) => `{{${n}}}`).join(' ') });
    if (probe.settingsError) items.push({ area: 'settings', key: 'settings.json', status: 'error', have: probe.settingsError });
    else {
      const { changed } = mergeSettings(probe.settings || {}, patch, { excluded: excludedPatterns(claude), credRe: CRED_KEY_RE_SRC });
      for (const c of changed) {
        if (c.key.startsWith('enabledPlugins.')) {
          /* 插件单独一类：要开的（true）在下面按「装没装 / 开没开」报；配置里关掉的（false）而远端还开着 →
             在这里报，同步时由 settings 合并写成 false */
          if (c.want !== true) items.push({ area: 'plugin', key: c.key.slice('enabledPlugins.'.length), status: 'different', want: 'disabled', have: c.have === true ? 'enabled' : show(c.have) });
          continue;
        }
        items.push({ area: 'settings', key: c.key, status: c.have === undefined ? 'missing' : 'different', want: show(c.want), ...(c.have === undefined ? {} : { have: show(c.have) }) });
      }
      const remoteEp = isObj(probe.settings?.enabledPlugins) ? probe.settings!.enabledPlugins : {};
      for (const id of wantedPlugins(claude)) {
        if (!probe.plugins.includes(id)) items.push({ area: 'plugin', key: id, status: 'missing' });
        else if (remoteEp[id] !== true) items.push({ area: 'plugin', key: id, status: 'different', want: 'enabled', have: remoteEp[id] === false ? 'disabled' : 'not enabled' });
      }
      for (const name of wantedMarketplaces(claude)) {
        if (!probe.marketplaces.includes(name)) items.push({ area: 'marketplace', key: name, status: 'missing' });
      }
    }
    const remoteRules = new Map(probe.rules.map((r) => [r.name, r.hash]));
    for (const r of input.localRules) {
      const h = remoteRules.get(r.name);
      if (h === undefined) items.push({ area: 'rule', key: r.name, status: 'missing' });
      else if (h !== r.hash) items.push({ area: 'rule', key: r.name, status: 'different' });
    }
  }
  if (codex && !probe.noNode) {
    /*
      自动同步只管顶层的 model / model_provider；远端那一行不是单行普通字符串（或写了不止一次）→「需手动配置」。
      嵌套项（provider 的 region 等）不自动改：远端连那个 [model_providers.<名字>] 表都没有时报「需手动配置」，
      有那个表就不读它的内容、不比较。
    */
    const { top, manual } = codexPlan(codex);
    for (const e of top) {
      const hs = (probe.codexTop || []).filter((x) => x.key === e.key);
      if (!hs.length) items.push({ area: 'codex', key: e.key, status: 'missing', want: e.value });
      else if (hs.length > 1 || !hs[0].plain) items.push({ area: 'codex', key: e.key, status: 'manual', want: e.value, have: hs.map((x) => x.value).join(' | ') });
      else if (hs[0].value !== e.value) items.push({ area: 'codex', key: e.key, status: 'different', want: e.value, have: hs[0].value });
    }
    for (const m of manual) {
      const provider = m.path.split('.')[1];
      if (!probe.codexProviders.includes(provider)) items.push({ area: 'codex', key: m.path, status: 'manual', want: m.value });
    }
  }
  return items;
}

// ---------------------------------------------------------------- 同步计划

export interface MarketplaceAction {
  name: string;
  /** `claude plugin marketplace add <arg>` 的参数（github 的 owner/repo、git url、远端目录）。 */
  arg: string;
  /** 目录型：从本机这个目录拷到远端这个目录（相对远端家目录，或绝对路径）。 */
  copy?: { localDir: string; remoteDir: string };
}

export interface SyncPlan {
  stamp: string;
  backupDir: string;
  pins: Array<{ id: ToolId; pkg: string; bin: string; version: string }>;
  settingsPatch: Record<string, unknown>;
  excluded: string[];
  rules: Array<{ name: string; content: string }>;
  plugins: string[];
  marketplaces: MarketplaceAction[];
  /** 要写进远端 config.toml 顶层的 model / model_provider（只有和远端不一样、而且能安全改的那几项）。 */
  codexEntries: Array<{ key: string; value: string }>;
  /** 列在确认框里的那几条（= 差异）。 */
  items: DiffItem[];
  /** 这次做不了的（例如市场来源不明），也列给人看。 */
  warnings: string[];
}

/** 备份目录名里的时间（本机时间，`YYYYMMDD-HHMMSS`）。 */
export function backupStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * 市场怎么装：配置里写了来源的按配置；只写了名字的去本机 `~/.claude/plugins/known_marketplaces.json` 里查（只读）。
 * 目录型（aim 的 `~/.aim/cc-plugins`）从本机拷：在本机家目录下的，落到远端家目录下同一个相对位置。
 */
export function resolveMarketplace(
  name: string,
  profile: ClaudeProfile | null,
  localKnown: Record<string, any> | null,
  localHome: string,
): MarketplaceAction | null {
  const spec = profile?.marketplaces.find((m) => m.name === name);
  let source: Record<string, any> | undefined = spec?.source as Record<string, any> | undefined;
  let copyFrom = spec?.copyFrom;
  if (!source && !copyFrom && localKnown && isObj(localKnown[name]) && isObj(localKnown[name].source)) {
    source = localKnown[name].source;
    if (source?.source === 'directory' && typeof source.path === 'string') copyFrom = source.path;
  }
  if (!source && !copyFrom && name === 'claude-plugins-official') source = { source: 'github', repo: 'anthropics/claude-plugins-official' };
  if (copyFrom) {
    const abs = /^~(?=$|[\\/])/.test(copyFrom) ? path.join(localHome, copyFrom.slice(2)) : copyFrom;
    const rel = path.relative(localHome, abs);
    const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    const remoteDir = inside ? rel.split(path.sep).join('/') : `.kirolex-marketplaces/${name}`;
    return { name, arg: remoteDir, copy: { localDir: abs, remoteDir } };
  }
  if (source?.source === 'github' && typeof source.repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repo)) return { name, arg: source.repo };
  if ((source?.source === 'git' || source?.source === 'url') && typeof source.url === 'string' && /^(https?|ssh|git):\/\/\S+$|^git@\S+$/.test(source.url)) return { name, arg: source.url };
  return null;
}

export function buildSyncPlan(input: DiffInput & {
  items: DiffItem[];
  now: Date;
  localKnownMarketplaces?: Record<string, any> | null;
  localRulesFull: LocalRule[];
}): SyncPlan {
  const { claude, codex, probe } = input;
  const stamp = backupStamp(input.now);
  const versions = effectiveVersions(claude, codex);
  const pins: SyncPlan['pins'] = [];
  for (const id of TOOL_IDS) {
    const want = versions[id];
    if (!want || probe.tools[id]?.version === want) continue;
    if (TOOL_SPECS[id].engine === 'codex' && !codex && !versions[id]) continue;
    pins.push({ id, pkg: TOOL_SPECS[id].pkg, bin: TOOL_SPECS[id].bin, version: want });
  }
  const warnings: string[] = [];
  let settingsPatch: Record<string, unknown> = {};
  let rules: SyncPlan['rules'] = [];
  let plugins: string[] = [];
  const marketplaces: MarketplaceAction[] = [];
  if (claude) {
    settingsPatch = desiredSettings(claude, machineVars(probe), { localHome: input.localHome, remoteHome: probe.home }).patch;
    const differing = new Set(input.items.filter((i) => i.area === 'rule').map((i) => i.key));
    rules = input.localRulesFull.filter((r) => differing.has(r.name)).map((r) => ({ name: r.name, content: r.content }));
    plugins = input.items.filter((i) => i.area === 'plugin' && i.status === 'missing').map((i) => i.key);
    const needMarkets = new Set(input.items.filter((i) => i.area === 'marketplace').map((i) => i.key));
    for (const name of needMarkets) {
      const m = resolveMarketplace(name, claude, input.localKnownMarketplaces ?? null, input.localHome || '');
      if (m) marketplaces.push(m);
      else {
        warnings.push(tr('Do not know where to install marketplace {name} from (add its source under "marketplaces"); plugins from it are skipped.', { name }));
        plugins = plugins.filter((p) => !p.endsWith(`@${name}`));
      }
    }
  }
  return {
    stamp,
    backupDir: `~/.claude/.kirolex-backup-${stamp}`,
    pins,
    settingsPatch,
    excluded: excludedPatterns(claude),
    rules,
    plugins,
    marketplaces,
    codexEntries: codexPlan(codex).top.filter((e) => input.items.some((i) => i.area === 'codex' && i.key === e.key && (i.status === 'missing' || i.status === 'different'))),
    items: input.items,
    warnings,
  };
}

/** 有没有要做的（没有就不用连那几趟 ssh）。 */
export function planHasWork(plan: SyncPlan): boolean {
  /* 「需手动配置」的不算：同步不会去改它们 */
  return plan.items.some((i) => i.area !== 'warning' && i.status !== 'manual') || plan.pins.length > 0;
}

// ---------------------------------------------------------------- 远端脚本

/**
 * 第一步：**备份**。`mkdir` 失败或任何一项拷不过去 → 非零退出，后面什么都不做。
 * 没有的项（远端还没有 rules / plugins）跳过。
 */
export function backupScript(stamp: string): string {
  if (!/^[0-9]{8}-[0-9]{6}$/.test(stamp)) throw new Error(`bad stamp ${stamp}`);
  return [
    'set -u',
    `B="$HOME/.claude/.kirolex-backup-${stamp}"`,
    'mkdir -p "$B" || { echo "KX_BACKUP_FAIL mkdir $B"; exit 3; }',
    'for x in settings.json rules plugins; do',
    '  if [ -e "$HOME/.claude/$x" ]; then cp -a "$HOME/.claude/$x" "$B/" || { echo "KX_BACKUP_FAIL $x"; exit 3; }; echo "KX_BACKUP_ITEM $x"; fi',
    'done',
    'if [ -f "$HOME/.codex/config.toml" ]; then mkdir -p "$B/codex" && cp -a "$HOME/.codex/config.toml" "$B/codex/" || { echo "KX_BACKUP_FAIL codex/config.toml"; exit 3; }; echo "KX_BACKUP_ITEM codex/config.toml"; fi',
    'echo "KX_BACKUP_OK $B"',
  ].join('\n');
}

/** 第二步：给 `remote-bootstrap.sh` 的 `PINS`（`包@版本=命令名`，空格分隔）。版本号已经过 `VERSION_RE`。 */
export function pinsEnv(pins: SyncPlan['pins']): string {
  return pins.filter((p) => VERSION_RE.test(p.version)).map((p) => `${p.pkg}@${p.version}=${p.bin}`).join(' ');
}

export function remotePinCommand(remoteTmp: string, pins: SyncPlan['pins']): string {
  return `cat > ${remoteTmp} && PINS='${pinsEnv(pins)}' bash ${remoteTmp}; rc=$?; rm -f ${remoteTmp}; exit $rc`;
}

export interface ApplyPayload {
  stamp: string;
  settingsPatch: Record<string, unknown> | null;
  excluded: string[];
  credRe: string;
  rules: Array<{ name: string; content: string }>;
  files: Array<{ rel: string; b64: string }>;
  marketplaces: Array<{ name: string; arg: string; dir: boolean }>;
  plugins: string[];
  /** 只有顶层的 model / model_provider（见 mergeCodexTopKeys）。 */
  codexEntries: Array<{ key: string; value: string }> | null;
}

/**
 * 第三步：远端写入（`node` 执行，**自包含**）。顺序：查备份目录在不在 → rules → 拷市场目录 → 加市场 → 装插件 →
 * 合并 settings.json → 合并 config.toml。每一步结果打一行 `KX_APPLY {json}`，最后 `KX_APPLY_DONE`。
 * settings.json 解析不了时**不写**（宁可不改，也不把它盖成一份只有配置里那几个键的新文件）。
 */
export function remoteApplyMain(
  p: ApplyPayload,
  mergeSettingsFn: typeof mergeSettings,
  mergeCodexFn: typeof mergeCodexTopKeys,
  tomlLexer: typeof tomlLineStates,
  codexCheck: typeof onlyTopKeyLinesChanged,
): void {
  const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
  const home = os.homedir();
  const say = (step: string, ok: boolean, detail?: string) => process.stdout.write(`KX_APPLY ${JSON.stringify({ step, ok, detail: detail || '' })}\n`);
  const writeAtomic = (file: string, text: string, mode?: number) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.kirolex-${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
    fs.renameSync(tmp, file);
  };
  const tail = (s: string) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-6).join(' | ');
  const backup = path.join(home, '.claude', `.kirolex-backup-${p.stamp}`);
  if (!/^[0-9]{8}-[0-9]{6}$/.test(p.stamp) || !fs.existsSync(backup)) {
    say('backup-check', false, `no backup at ${backup}`);
    process.stdout.write('KX_APPLY_DONE\n');
    process.exitCode = 4;
    return;
  }
  say('backup-check', true, backup);
  const rd = path.join(home, '.claude', 'rules');
  for (const r of p.rules) {
    if (!/^[^/\\\0]{1,120}\.md$/.test(r.name) || r.name.startsWith('.')) { say(`rule:${r.name}`, false, 'bad name'); continue; }
    try { writeAtomic(path.join(rd, r.name), r.content); say(`rule:${r.name}`, true); } catch (err: any) { say(`rule:${r.name}`, false, String(err && err.message || err)); }
  }
  let copied = 0;
  for (const f of p.files) {
    const abs = path.resolve(home, f.rel);
    const relCheck = path.relative(home, abs);
    if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) { say(`file:${f.rel}`, false, 'outside home'); continue; }
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, Buffer.from(f.b64, 'base64')); copied += 1; } catch (err: any) { say(`file:${f.rel}`, false, String(err && err.message || err)); }
  }
  if (p.files.length) say('marketplace-files', copied === p.files.length, `${copied}/${p.files.length}`);
  const claude = (args: string[]) => {
    const r = cp.spawnSync('claude', args, { encoding: 'utf8', timeout: 5 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: r.status === 0, out: `${r.stdout || ''}\n${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}` };
  };
  for (const m of p.marketplaces) {
    const arg = m.dir && !m.arg.startsWith('/') ? path.join(home, m.arg) : m.arg;
    const r = claude(['plugin', 'marketplace', 'add', arg]);
    say(`marketplace:${m.name}`, r.ok || /already/i.test(r.out), r.ok ? arg : tail(r.out));
  }
  for (const id of p.plugins) {
    const r = claude(['plugin', 'install', id]);
    say(`plugin:${id}`, r.ok || /already installed/i.test(r.out), r.ok ? '' : tail(r.out));
  }
  if (p.settingsPatch) {
    const sf = path.join(home, '.claude', 'settings.json');
    let cur: any = {};
    let okToWrite = true;
    if (fs.existsSync(sf)) {
      try { cur = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch (err: any) { okToWrite = false; say('settings', false, `settings.json unparsable, not changed: ${String(err && err.message || err)}`); }
    }
    if (okToWrite) {
      try {
        const m = mergeSettingsFn(cur, p.settingsPatch, { excluded: p.excluded, credRe: p.credRe });
        if (m.changed.length || !fs.existsSync(sf)) writeAtomic(sf, `${JSON.stringify(m.merged, null, 2)}\n`, 0o600);
        say('settings', true, m.changed.map((c) => c.key).join(', '));
      } catch (err: any) { say('settings', false, String(err && err.message || err)); }
    }
  }
  if (p.codexEntries && p.codexEntries.length) {
    const cf = path.join(home, '.codex', 'config.toml');
    try {
      const cur = fs.existsSync(cf) ? fs.readFileSync(cf, 'utf8') : '';
      const m = mergeCodexFn(cur, p.codexEntries, tomlLexer, codexCheck);
      /* 写之前再核对一遍：除了那两行，和原文逐字节一样（合并函数里已经核过，这里是第二道） */
      if (m.changed.length && codexCheck(cur, m.text)) writeAtomic(cf, m.text, 0o600);
      say('codex-config', !m.skipped.length, [m.changed.join(', '), m.skipped.length ? `skipped: ${m.skipped.join(', ')}` : ''].filter(Boolean).join('; '));
    } catch (err: any) { say('codex-config', false, String(err && err.message || err)); }
  }
  process.stdout.write('KX_APPLY_DONE\n');
}

export function applyJs(payload: ApplyPayload): string {
  return `(${remoteApplyMain.toString()})(${JSON.stringify(payload)}, (${mergeSettings.toString()}), (${mergeCodexTopKeys.toString()}), `
    + `(${tomlLineStates.toString()}), (${onlyTopKeyLinesChanged.toString()}));\n`;
}

/**
 * 写入脚本走 stdin 落到临时文件再跑（理由同 `remote:bootstrap`）。`node` 要在**登录 shell** 里找：
 * fnm / nvm 管的 node（graviton 就是）在 ssh 的默认 shell 里看不到（见 `remoteAdapterProbe.ts`）。
 */
export function remoteApplyCommand(remoteTmp: string): string {
  if (!/^\/tmp\/[A-Za-z0-9._-]+$/.test(remoteTmp)) throw new Error(`bad tmp ${remoteTmp}`);
  return `cat > ${remoteTmp} && bash -lc 'node ${remoteTmp}'; rc=$?; rm -f ${remoteTmp}; exit $rc`;
}

export interface ApplyStep { step: string; ok: boolean; detail: string }
export function parseApplyOutput(output: string): { steps: ApplyStep[]; done: boolean } {
  const steps: ApplyStep[] = [];
  let done = false;
  for (const l of String(output || '').split(/\r?\n/)) {
    if (l.startsWith('KX_APPLY_DONE')) { done = true; continue; }
    if (!l.startsWith('KX_APPLY ')) continue;
    try { const j = JSON.parse(l.slice('KX_APPLY '.length)); steps.push({ step: String(j.step), ok: !!j.ok, detail: String(j.detail || '') }); } catch { /* 半行 */ }
  }
  return { steps, done };
}

/**
 * 目录型市场：本机目录 → 要写到远端的文件（相对远端家目录）。文本文件里本机家目录换成远端家目录
 * （graviton 那次手工拷就是这么做的）；跳过 `.git`；总量超过上限就不拷（报错）。
 */
export function collectMarketplaceFiles(
  localDir: string,
  remoteDir: string,
  localHome: string,
  remoteHome: string,
  limitBytes = 64 * 1024 * 1024,
): { ok: true; files: Array<{ rel: string; b64: string }> } | { ok: false; error: string } {
  const files: Array<{ rel: string; b64: string }> = [];
  let total = 0;
  const walk = (dir: string, rel: string): string | null => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (err: any) { return String(err?.message || err); }
    for (const e of ents) {
      if (e.name === '.git' || e.name === '.DS_Store') continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { const err = walk(abs, r); if (err) return err; continue; }
      if (!e.isFile()) continue;
      let buf = fs.readFileSync(abs);
      total += buf.length;
      if (total > limitBytes) return tr('{dir} is larger than {mb} MB; not copied', { dir: localDir, mb: String(Math.round(limitBytes / 1024 / 1024)) });
      if (!buf.includes(0)) {
        const s = buf.toString('utf-8');
        const r2 = replaceHome(s, localHome, remoteHome);
        if (r2 !== s) buf = Buffer.from(r2, 'utf-8');
      }
      files.push({ rel: `${remoteDir}/${r}`, b64: buf.toString('base64') });
    }
    return null;
  };
  if (!fs.existsSync(localDir)) return { ok: false, error: tr('{dir} does not exist on this computer', { dir: localDir }) };
  const err = walk(localDir, '');
  return err ? { ok: false, error: err } : { ok: true, files };
}

// ---------------------------------------------------------------- 编排

export interface SyncStepResult { step: 'backup' | 'versions' | 'apply' | 'reprobe'; ok: boolean; detail: string }
export interface SyncOutcome { ok: boolean; steps: SyncStepResult[]; applied: ApplyStep[]; after: DiffItem[] | null }

/**
 * **同步一台机器**：备份 → 装/升级版本 → 写入 → 重新探测出差异。**备份不成功就停**（什么都不改）；
 * 装版本失败不挡配置写入（配置和版本互不依赖），但整体算失败、原因带回去。全程经 `log` 写日志。
 */
export async function runProfileSync(plan: SyncPlan, deps: {
  log: (line: string) => void;
  backup: (script: string) => Promise<{ ok: boolean; output: string; error?: string }>;
  installVersions: (pins: SyncPlan['pins']) => Promise<{ ok: boolean; error?: string }>;
  apply: (js: string) => Promise<{ ok: boolean; output: string; error?: string }>;
  reprobe: () => Promise<DiffItem[] | null>;
  payloadExtras: () => Promise<{ files: ApplyPayload['files']; errors: string[] }>;
}): Promise<SyncOutcome> {
  const steps: SyncStepResult[] = [];
  const b = await deps.backup(backupScript(plan.stamp));
  const okLine = /KX_BACKUP_OK (.*)/.exec(b.output || '');
  if (!b.ok || !okLine) {
    const why = b.error || (/KX_BACKUP_FAIL (.*)/.exec(b.output || '')?.[1]) || 'backup failed';
    deps.log(`备份失败，什么都没改：${why}`);
    steps.push({ step: 'backup', ok: false, detail: why });
    return { ok: false, steps, applied: [], after: null };
  }
  deps.log(`已备份到 ${okLine[1].trim()}`);
  steps.push({ step: 'backup', ok: true, detail: okLine[1].trim() });
  if (plan.pins.length) {
    deps.log(`装/升级：${plan.pins.map((p) => `${p.pkg}@${p.version}`).join('、')}`);
    const v = await deps.installVersions(plan.pins);
    deps.log(v.ok ? '版本装好了' : `版本没装好：${v.error || '?'}`);
    steps.push({ step: 'versions', ok: v.ok, detail: v.ok ? plan.pins.map((p) => `${p.bin}@${p.version}`).join(', ') : (v.error || '') });
  }
  const extras = await deps.payloadExtras();
  for (const e of extras.errors) deps.log(`跳过：${e}`);
  const payload: ApplyPayload = {
    stamp: plan.stamp,
    settingsPatch: Object.keys(plan.settingsPatch).length ? plan.settingsPatch : null,
    excluded: plan.excluded,
    credRe: CRED_KEY_RE_SRC,
    rules: plan.rules,
    files: extras.files,
    marketplaces: plan.marketplaces.map((m) => ({ name: m.name, arg: m.arg, dir: !!m.copy })),
    plugins: plan.plugins,
    codexEntries: plan.codexEntries.length ? plan.codexEntries : null,
  };
  const a = await deps.apply(applyJs(payload));
  const parsed = parseApplyOutput(a.output || '');
  for (const s of parsed.steps) deps.log(`${s.ok ? '✓' : '✗'} ${s.step}${s.detail ? `：${s.detail}` : ''}`);
  const applyOk = a.ok && parsed.done && parsed.steps.every((s) => s.ok) && !extras.errors.length;
  steps.push({ step: 'apply', ok: applyOk, detail: a.error || [...extras.errors, ...parsed.steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.detail}`)].join('\n') });
  const after = await deps.reprobe();
  steps.push({ step: 'reprobe', ok: !!after, detail: after ? String(after.length) : 'probe failed' });
  deps.log(after ? `同步完重新比较：还有 ${after.length} 处差异` : '同步完重新探测失败');
  return { ok: steps.every((s) => s.ok), steps, applied: parsed.steps, after };
}
