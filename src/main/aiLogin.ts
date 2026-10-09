/**
 * **Claude Code / Codex 的登录** ——「或者你只管安装不管登录？是不是可以把左下角那个配置按钮中加一个登录的选项」。
 *
 * 安装脚本只管装；登录在设置的「🔑 登录」页里做，三种方式：
 *   · **用本机的配置**：把这台电脑上已经能用的网关配置写到那台机器上（Claude Code 只动 settings.json 的 `env`；
 *     Codex 只动 config.toml 里 `model` / `model_provider` 两行和那一个 `[model_providers.<id>]` 段，外加 auth.json）。
 *   · **手填**网关地址和 key。
 *   · **官方账号登录**（`claude auth login`、`codex login --device-auth`）—— 那一条在 index.ts 里跑，这里不管。
 *
 * 这个文件只做**纯文本变换**（读进来的文件内容 → 要写回去的内容），所以在 node:test 里能直接测，
 * 也不需要一个 TOML 解析器：config.toml 里我们只认、只改顶层那两行和一个段，其余逐字保留。
 */

/** Claude Code 用网关跑需要的那几个变量（settings.json 的 `env` 里）。 */
export const CLAUDE_ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'] as const;

/** 从本机的 settings.json 里取出要搬过去的那几项（只这几项，别的设置是这台电脑自己的）。 */
export function pickClaudeEnv(settingsText: string): Record<string, string> {
  let cfg: any = {};
  try { cfg = JSON.parse(settingsText || '{}') || {}; } catch { cfg = {}; }
  const env = cfg.env && typeof cfg.env === 'object' ? cfg.env : {};
  const out: Record<string, string> = {};
  for (const k of CLAUDE_ENV_KEYS) if (typeof env[k] === 'string' && env[k]) out[k] = env[k];
  return out;
}

/** 把 `env` 合并进那台机器的 settings.json：只覆盖给出的键，别的设置（权限、插件…）原样保留。 */
export function mergeClaudeSettings(existingText: string, env: Record<string, string>): string {
  let cfg: any = {};
  try { cfg = JSON.parse(existingText || '{}') || {}; } catch { cfg = {}; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  cfg.env = { ...(cfg.env && typeof cfg.env === 'object' ? cfg.env : {}), ...env };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

/** `[a.b]` / `[[a]]` 这种表头行。 */
const TABLE_HEADER = /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/;
const unquote = (v: string): string => v.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

/** 顶层（第一个表头之前）某个键的值。 */
export function topLevelValue(toml: string, key: string): string | undefined {
  for (const line of String(toml || '').split(/\r?\n/)) {
    if (TABLE_HEADER.test(line)) break;
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(#.*)?$`));
    if (m) return unquote(m[1]);
  }
  return undefined;
}

/** `[model_providers.<id>]` 那一段（含表头，到下一个表头为止）；没有就是空串。 */
export function providerSection(toml: string, id: string): string {
  const lines = String(toml || '').split(/\r?\n/);
  const head = new RegExp(`^\\s*\\[model_providers\\.("?)${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\]\\s*(#.*)?$`);
  const at = lines.findIndex((l) => head.test(l));
  if (at < 0) return '';
  let end = at + 1;
  while (end < lines.length && !TABLE_HEADER.test(lines[end])) end++;
  while (end > at + 1 && !lines[end - 1].trim()) end--;
  return lines.slice(at, end).join('\n');
}

export interface CodexProvider {
  /** provider id（`model_provider = "<id>"`）。 */
  id: string;
  /** 顶层 `model`；空 = 不动那台机器原来的。 */
  model?: string;
  /** 完整的 `[model_providers.<id>]` 段（TOML 原文）。 */
  section: string;
}

/** 从本机的 config.toml 里取出当前在用的那个 provider（只有它是自定义网关时才有意义）。 */
export function pickCodexProvider(toml: string): CodexProvider | undefined {
  const id = topLevelValue(toml, 'model_provider');
  if (!id) return undefined;
  const section = providerSection(toml, id);
  if (!section) return undefined;            // 内置 provider（openai）没有段 —— 那种走官方登录
  return { id, model: topLevelValue(toml, 'model'), section };
}

/** 手填的网关 → 一个 provider 段。key 走 `Authorization: Bearer`，和本机那份 workshop 一个形状。 */
export function buildCodexProvider(input: { baseUrl: string; token: string; model?: string; id?: string; name?: string }): CodexProvider {
  const id = input.id || 'kirolex';
  const q = (v: string): string => JSON.stringify(String(v));
  return {
    id,
    model: input.model?.trim() || undefined,
    section: [
      `[model_providers.${id}]`,
      `name = ${q(input.name || 'KiroLex gateway')}`,
      `base_url = ${q(input.baseUrl.trim())}`,
      'wire_api = "responses"',
      `http_headers = { Authorization = ${q(`Bearer ${input.token.trim()}`)} }`,
    ].join('\n'),
  };
}

/**
 * 把一个 provider 写进那台机器的 config.toml：
 *   · 顶层的 `model_provider`（和给了的话 `model`）换成新的，放在最前面（TOML 的顶层键必须在任何表头之前）；
 *   · 同 id 的旧段删掉、新段追加到最后；
 *   · 其余每一行逐字保留（别的 provider、项目信任、MCP…都是那台机器自己的）。
 */
export function applyCodexProvider(existing: string, p: CodexProvider): string {
  const lines = String(existing || '').split(/\r?\n/);
  const old = providerSection(existing, p.id);
  let body = lines;
  if (old) {
    const start = lines.findIndex((l) => l === old.split('\n')[0]);
    body = [...lines.slice(0, start), ...lines.slice(start + old.split('\n').length)];
  }
  /* 顶层（第一个表头之前）去掉我们要接管的那两个键 */
  const firstTable = body.findIndex((l) => TABLE_HEADER.test(l));
  const top = (firstTable < 0 ? body : body.slice(0, firstTable))
    .filter((l) => !/^\s*model_provider\s*=/.test(l) && !(p.model && /^\s*model\s*=/.test(l)));
  const rest = firstTable < 0 ? [] : body.slice(firstTable);
  const head = [
    ...(p.model ? [`model = ${JSON.stringify(p.model)}`] : []),
    `model_provider = ${JSON.stringify(p.id)}`,
  ];
  const out = [...head, ...top, ...rest].join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '');
  return `${out}\n\n${p.section}\n`;
}

/** 状态里能给人看的那一点（不含任何密钥）。 */
export interface ToolLoginStatus {
  installed: boolean;
  loggedIn: boolean;
  /** 一句话：怎么登录的 / 为什么没登录。 */
  detail: string;
  /** 走自定义网关时的地址（只显示主机名，不显示 key）。 */
  gateway?: string;
}

/** `claude auth status --json` 的输出 → 状态。 */
export function parseClaudeStatus(out: string, gatewayUrl?: string): ToolLoginStatus {
  const text = String(out || '');
  if (/command not found|not recognized|KX_NO_CLAUDE/i.test(text)) return { installed: false, loggedIn: false, detail: '没装 Claude Code' };
  let j: any;
  try { j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { j = undefined; }
  if (!j) return { installed: true, loggedIn: false, detail: '问不到登录状态' };
  const how = j.authMethod === 'api_key' ? `API key（${j.apiKeySource || '?'}）` : j.authMethod === 'oauth' || j.authMethod === 'claudeai' ? 'Claude 账号' : String(j.authMethod || '');
  return {
    installed: true,
    loggedIn: !!j.loggedIn,
    detail: j.loggedIn ? `已登录：${how}` : '没登录',
    ...(gatewayUrl ? { gateway: hostOf(gatewayUrl) } : {}),
  };
}

/** `codex login status` 的输出 + 有没有自定义 provider → 状态。自定义网关不需要 `codex login`，有 provider 就算能用。 */
export function parseCodexStatus(out: string, provider?: { id: string; baseUrl?: string }): ToolLoginStatus {
  const text = String(out || '').trim();
  if (/command not found|not recognized|KX_NO_CODEX/i.test(text)) return { installed: false, loggedIn: false, detail: '没装 Codex' };
  if (provider?.baseUrl) {
    return { installed: true, loggedIn: true, detail: `走自定义网关「${provider.id}」`, gateway: hostOf(provider.baseUrl) };
  }
  const logged = /^Logged in/i.test(text);
  /* 把 key 的那一截遮掉：`Logged in using an API key - sk-***` 后面那段不出主进程 */
  const said = text.split('\n')[0].replace(/ - .*$/, '');
  return { installed: true, loggedIn: logged, detail: logged ? `已登录：${said.replace(/^Logged in using /i, '')}` : '没登录' };
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, '').split('/')[0]; }
}

/** config.toml 里当前 provider 的 base_url（显示用）。 */
export function codexGateway(toml: string): { id: string; baseUrl?: string } | undefined {
  const p = pickCodexProvider(toml);
  if (!p) return undefined;
  const m = p.section.match(/^\s*base_url\s*=\s*(.+?)\s*$/m);
  return { id: p.id, baseUrl: m ? unquote(m[1]) : undefined };
}

/*
 * **手动填写 = 一个编辑器** ——「本机配置这个方法先不要了，你就提供一个按钮把本机配置直接拷过来，放到手动填写这个
 * json 编辑器中」。所以：「拷入本机配置」把这台电脑上的那份变成编辑器里的文本，你看一眼、改一改，再写到那台机器上。
 * Claude Code 的是 JSON（settings.json 的 env），Codex 的是 TOML 片段（它的配置本来就是 TOML）。
 */

/** Claude Code 编辑器里的初始文本：本机 env 里那几项（没有就是一个带键名的空模板）。 */
export function claudeEditorText(localSettings: string): string {
  const env = pickClaudeEnv(localSettings);
  const shown = Object.keys(env).length ? env : { ANTHROPIC_BASE_URL: '', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' };
  return `${JSON.stringify(shown, null, 2)}\n`;
}

/** 编辑器里的 JSON → 要合并进 env 的键值。只收字符串；空值的键不写（"留空"不该把那台机器原来的值改成空串）。 */
export function parseClaudeEditor(text: string): Record<string, string> {
  let j: any;
  try { j = JSON.parse(text); } catch (e: any) { throw new Error(`不是合法的 JSON：${e?.message || e}`); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('要是一个 JSON 对象（键是变量名，值是字符串）。');
  /* 整份 settings.json 贴进来也认：取它的 env */
  const src = j.env && typeof j.env === 'object' && !Array.isArray(j.env) ? j.env : j;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v !== 'string') throw new Error(`「${k}」的值要是字符串。`);
    if (v.trim()) out[k] = v.trim();
  }
  if (!out.ANTHROPIC_API_KEY && !out.ANTHROPIC_AUTH_TOKEN) throw new Error('至少要有 ANTHROPIC_API_KEY（或 ANTHROPIC_AUTH_TOKEN）。');
  return out;
}

/** Codex 编辑器里的初始文本：本机当前在用的那个 provider（顶层两行 + 那一段）；没有就是一个空模板。 */
export function codexEditorText(localToml: string): string {
  const p = pickCodexProvider(localToml);
  if (!p) {
    return [
      'model = ""',
      'model_provider = "kirolex"',
      '',
      '[model_providers.kirolex]',
      'name = "KiroLex gateway"',
      'base_url = ""',
      'wire_api = "responses"',
      'http_headers = { Authorization = "Bearer " }',
      '',
    ].join('\n');
  }
  return [...(p.model ? [`model = ${JSON.stringify(p.model)}`] : []), `model_provider = ${JSON.stringify(p.id)}`, '', p.section, ''].join('\n');
}

/** 编辑器里的 TOML 片段 → provider。必须有顶层 `model_provider` 和同名的 `[model_providers.<id>]` 段。 */
export function parseCodexEditor(text: string): CodexProvider {
  const id = topLevelValue(text, 'model_provider');
  if (!id) throw new Error('缺顶层的 model_provider = "<名字>"（要写在所有 [段] 之前）。');
  const section = providerSection(text, id);
  if (!section) throw new Error(`缺 [model_providers.${id}] 这一段。`);
  if (!/^\s*base_url\s*=\s*"[^"]+"/m.test(section)) throw new Error(`[model_providers.${id}] 里的 base_url 不能为空。`);
  const model = topLevelValue(text, 'model');
  return { id, model: model || undefined, section };
}

/*
 * **默认走 Amazon Bedrock** ——「脚本应该默认将模型设置为 bedrock 的 global endpoint。保留让客户自己配置域名和 key
 * 或者用官方订阅登录的选项」。凭证不写进任何文件：两边都走 AWS SDK 的凭证链（EC2 实例角色 / ~/.aws / SSO）。
 *
 * 实测（10-07，东京 ap-northeast-1 那台，实例角色 ec2-admin）：
 *   · Claude Code：global 推理配置文件可用（`global.anthropic.claude-opus-5-5` 回了 BEDROCK_OK）；
 *     region 用那台机器自己的，ANTHROPIC_BEDROCK_REGION_PREFIX=global（Claude Code ≥ 2.1.224）。
 *   · Codex：走的是 Bedrock 的 Responses 端点（bedrock-mantle），**东京那个端点上没有 OpenAI 模型**（404），
 *     `global.` 前缀它也不认；us-east-1 + `openai.gpt-6.1-sol` 才通。所以 Codex 的 region 固定 us-east-1。
 */
export const BEDROCK_DEFAULTS = {
  claude: {
    opus: 'global.anthropic.claude-opus-5-5',
    sonnet: 'global.anthropic.claude-sonnet-5-5',
    haiku: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  },
  codex: { model: 'openai.gpt-6.1-sol', region: 'us-east-1' },
} as const;

/** 写 Bedrock 时要拿掉的网关项 —— 留着的话 Claude Code 会继续打那个网关 */
const CLAUDE_GATEWAY_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_SMALL_FAST_MODEL'];

/** settings.json 合并进 Bedrock 的 env（只动 env 里这几项，别的设置原样保留）。`region` 是那台机器自己的。 */
export function claudeBedrockSettings(existingText: string, region: string): string {
  let j: any;
  try { j = JSON.parse(existingText || '{}'); } catch { j = {}; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) j = {};
  const env: Record<string, string> = { ...(j.env && typeof j.env === 'object' ? j.env : {}) };
  for (const k of CLAUDE_GATEWAY_KEYS) delete env[k];
  Object.assign(env, {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: region,
    ANTHROPIC_BEDROCK_REGION_PREFIX: 'global',
    ANTHROPIC_MODEL: BEDROCK_DEFAULTS.claude.opus,
    ANTHROPIC_DEFAULT_OPUS_MODEL: BEDROCK_DEFAULTS.claude.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_DEFAULTS.claude.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: BEDROCK_DEFAULTS.claude.haiku,
  });
  return `${JSON.stringify({ ...j, env }, null, 2)}\n`;
}

/** 这份 settings.json 是不是走 Bedrock；是就给出 region（显示用）。 */
export function claudeBedrockOf(settingsText: string): { region?: string } | undefined {
  try {
    const env = JSON.parse(settingsText || '{}')?.env || {};
    return env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_BEDROCK === 1 ? { region: env.AWS_REGION } : undefined;
  } catch { return undefined; }
}

/** 删掉 `[model_providers.<id>]` 以及它的所有子表（`[model_providers.<id>.aws]`）。 */
function dropProviderTables(lines: string[], id: string): string[] {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = new RegExp(`^\\s*\\[model_providers\\.("?)${esc}\\1(\\.[^\\]]+)?\\]\\s*(#.*)?$`);
  const out: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (TABLE_HEADER.test(l)) skipping = own.test(l);
    if (!skipping) out.push(l);
  }
  return out;
}

/**
 * config.toml 合并进 Bedrock：顶层 `model` / `model_provider` 换掉，`amazon-bedrock` 的旧段（含子表）删掉再写新的；
 * 别的 provider（比如原来那个网关）、项目信任、MCP 原样保留 —— 想切回去改一行 `model_provider` 就行。
 */
export function codexBedrockToml(existing: string, opts?: { model?: string; region?: string }): string {
  const model = opts?.model || BEDROCK_DEFAULTS.codex.model;
  const region = opts?.region || BEDROCK_DEFAULTS.codex.region;
  const body = dropProviderTables(String(existing || '').split(/\r?\n/), 'amazon-bedrock');
  const firstTable = body.findIndex((l) => TABLE_HEADER.test(l));
  const top = (firstTable < 0 ? body : body.slice(0, firstTable))
    .filter((l) => !/^\s*model_provider\s*=/.test(l) && !/^\s*model\s*=/.test(l));
  const rest = firstTable < 0 ? [] : body.slice(firstTable);
  const out = [`model = ${JSON.stringify(model)}`, 'model_provider = "amazon-bedrock"', ...top, ...rest]
    .join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '');
  return `${out}\n\n[model_providers.amazon-bedrock.aws]\nregion = ${JSON.stringify(region)}\n`;
}

/** 这份 config.toml 是不是走 Bedrock（显示用）。 */
export function codexBedrockOf(toml: string): { region?: string; model?: string } | undefined {
  if (topLevelValue(toml, 'model_provider') !== 'amazon-bedrock') return undefined;
  const lines = String(toml || '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*\[model_providers\.amazon-bedrock\.aws\]/.test(l));
  let region: string | undefined;
  for (let i = at + 1; at >= 0 && i < lines.length && !TABLE_HEADER.test(lines[i]); i++) {
    const m = lines[i].match(/^\s*region\s*=\s*(.+?)\s*$/);
    if (m) region = unquote(m[1]);
  }
  return { region, model: topLevelValue(toml, 'model') };
}
