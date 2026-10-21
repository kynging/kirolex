/**
 * **远端的 Claude Code / Codex 适配器在哪、怎么起** ——「远程机器的 Node 由 fnm/nvm 管时，已装的
 * claude-agent-acp 被判成没装（登录 shell 看不到）」。
 *
 * KiroLex 在远端起适配器走的是 `ssh … bash -lc '…'`：一个**非交互的登录 shell**。fnm / nvm 这类
 * Node 管理器通常只在 `~/.bashrc`（交互 shell）里加 PATH，于是登录 shell 里**连 node 都没有**：
 * `command -v claude-agent-acp` 找不到，就算找到了它的 `#!/usr/bin/env node` 也跑不起来。
 * 实测 graviton（AL2023 arm64，fnm 装的 node 22）就是这样：适配器明明 `npm i -g` 装好了，
 * KiroLex 报「那台机器上没有适配器」，照提示点「安装 AI 工具」又装到同一个看不见的地方。
 *
 * 所以探测不只问登录 shell，还去 fnm / nvm / volta / asdf 的目录里找 node 和全局 node_modules；
 * 找到了就用「node 绝对路径 + 适配器入口」起，并在状态行说一声是哪个管理器、怎么让登录 shell 看得到。
 * 只有真找不到才说「没装」；装了却哪儿都没有 node 能跑它的，说的是另一句（不再引导去重装）。
 *
 * 纯模块（不 import electron）：探测脚本、解析、判定、文案都在这里，`index.ts` 只负责跑 ssh。
 * 本机会话的适配器解析（`engines.ts` 的 `resolveAdapter`）不走这里。
 */
import type { RemoteTarget } from './config';
import { ADAPTER_PACKAGE, ENGINE_LABEL, REMOTE_ADAPTER_BIN } from './engines.ts';
import { NOTE_DETAIL_SEP } from './kirolexNote.ts';
import { tr, trConcat } from './uiText.ts';

type AdapterEngine = 'claude' | 'codex';
export type NodeManager = 'fnm' | 'nvm' | 'volta' | 'asdf' | 'npm-prefix' | 'system';
const MANAGERS: NodeManager[] = ['fnm', 'nvm', 'volta', 'asdf', 'npm-prefix', 'system'];

export interface AdapterProbe {
  /** 登录 shell 里 `command -v <bin>` 的结果（`readlink -f` 之后）和它的第一行（看是不是 node 脚本）。 */
  pathBin?: { path: string; firstLine: string };
  /** 登录 shell 里 `command -v node`。 */
  loginNode?: string;
  /** 各管理器目录下找到的 node。 */
  nodes: Array<{ manager: NodeManager; path: string }>;
  /** 各管理器目录下找到的适配器入口（`…/lib/node_modules/<pkg>/dist/index.js`）。 */
  entries: Array<{ manager: NodeManager; path: string }>;
  /** 找到的登录文件（`credentials` / `auth-json` / `provider`），非空才算。 */
  auth: string[];
  /** 配置项：来源（`settings` / `claudejson` / `env`）、键、值（key 只有 `set` / `empty`，开关是值本身）。 */
  cfg: Array<{ src: string; key: string; val: string }>;
}

export type AdapterVerdict =
  /** 登录 shell 里直接能起：照旧 `exec <bin>`。 */
  | { kind: 'path' }
  /** 登录 shell 看不到（或看得到但没有 node）：用找到的 node 绝对路径跑入口。 */
  | { kind: 'absolute'; manager: NodeManager; node: string; entry: string }
  /** 哪儿都没有。 */
  | { kind: 'missing' }
  /** 适配器在，但登录 shell 和各管理器下都没有能跑它的 node。 */
  | { kind: 'no-node'; manager: NodeManager; entry: string };

function q(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * 在远端（`bash -lc` 里）跑的探测脚本。每一项打一行 `KX_<类>\t…`，profile 打印的杂音不影响解析。
 * 没匹配上的 glob 保持字面值，`[ -x … ]` 自然是假 —— 不用 `nullglob`（改 shell 选项会影响 profile 之后的行为）。
 */
export function adapterProbeScript(engine: AdapterEngine): string {
  const bin = REMOTE_ADAPTER_BIN[engine];
  const pkg = ADAPTER_PACKAGE[engine];
  /*
    登录 / 配置痕迹**看值，不只看名字**：空的 key、`CLAUDE_CODE_USE_BEDROCK: "0"`、只配了网关地址都不算配过。
    key 只回报「有 / 空」（`set` / `empty`），值不出那台机器；开关（Bedrock / Vertex）回报值本身，由 `remoteAuthConfigured` 判真假。
    `kx_jv` 取 JSON 里某个键的值（字符串 / true / false / 数字）；没有这个键时什么都不打。
  */
  const jsonHelpers = [
    'kx_jv() { grep -oE "\\"$2\\"[[:space:]]*:[[:space:]]*(\\"[^\\"]*\\"|true|false|[0-9]+)" "$1" 2>/dev/null | head -n 1 | sed -E \'s/^"[^"]*"[[:space:]]*:[[:space:]]*//; s/^"(.*)"$/\\1/\'; }',
    'kx_has() { grep -qsE "\\"$2\\"[[:space:]]*:" "$1"; }',
    'kx_emit() { if [ "$4" = secret ]; then if [ -n "$3" ]; then kx_v=set; else kx_v=empty; fi; else kx_v=$(printf \'%s\' "$3" | tr -cd \'A-Za-z0-9._-\' | head -c 20); fi; printf \'KX_CFG\\t%s\\t%s\\t%s\\n\' "$1" "$2" "$kx_v"; }',
    /* 配置文件里的键 + 登录 shell 的同名环境变量（适配器就是在这个 shell 里起的） */
    'kx_secret() { kx_has "$2" "$1" && kx_emit "$3" "$1" "$(kx_jv "$2" "$1")" secret; kx_e="${!1:-}"; [ -n "$kx_e" ] && kx_emit env "$1" "$kx_e" secret; return 0; }',
    'kx_flag() { kx_has "$2" "$1" && kx_emit "$3" "$1" "$(kx_jv "$2" "$1")" flag; kx_e="${!1:-}"; [ -n "$kx_e" ] && kx_emit env "$1" "$kx_e" flag; return 0; }',
  ];
  const auth = engine === 'claude'
    ? [
      ...jsonHelpers,
      '[ -s "$HOME/.claude/.credentials.json" ] && printf \'KX_AUTH\\tcredentials\\n\'',
      'kx_s="$HOME/.claude/settings.json"',
      'kx_flag CLAUDE_CODE_USE_BEDROCK "$kx_s" settings',
      'kx_flag CLAUDE_CODE_USE_VERTEX "$kx_s" settings',
      'kx_secret ANTHROPIC_API_KEY "$kx_s" settings',
      'kx_secret ANTHROPIC_AUTH_TOKEN "$kx_s" settings',
      'kx_secret apiKeyHelper "$kx_s" settings',
      'kx_secret primaryApiKey "$HOME/.claude.json" claudejson',
    ]
    : [
      ...jsonHelpers,
      '[ -s "$HOME/.codex/auth.json" ] && printf \'KX_AUTH\\tauth-json\\n\'',
      'grep -qsE \'^[[:space:]]*model_provider[[:space:]]*=[[:space:]]*"[^"]+"\' "$HOME/.codex/config.toml" && printf \'KX_AUTH\\tprovider\\n\'',
      'kx_secret OPENAI_API_KEY /dev/null env',
      'kx_secret CODEX_API_KEY /dev/null env',
    ];
  return [
    `kx_pkg=${q(pkg)}`,
    `if kx_p=$(command -v ${q(bin)} 2>/dev/null); then`,
    '  kx_r=$(readlink -f "$kx_p" 2>/dev/null || printf \'%s\' "$kx_p")',
    '  printf \'KX_PATHBIN\\t%s\\t%s\\n\' "$kx_r" "$(head -n 1 "$kx_r" 2>/dev/null | head -c 200 | tr -d \'\\r\\t\\000\')"',
    'fi',
    'kx_n=$(command -v node 2>/dev/null) && printf \'KX_LOGINNODE\\t%s\\n\' "$kx_n"',
    'kx_scan() {',
    '  kx_m=$1; shift',
    '  for kx_d in "$@"; do',
    '    [ -x "$kx_d/bin/node" ] && printf \'KX_NODE\\t%s\\t%s\\n\' "$kx_m" "$kx_d/bin/node"',
    '    [ -f "$kx_d/lib/node_modules/$kx_pkg/dist/index.js" ] && printf \'KX_ENTRY\\t%s\\t%s\\n\' "$kx_m" "$kx_d/lib/node_modules/$kx_pkg/dist/index.js"',
    '  done',
    '  return 0',
    '}',
    'kx_scan fnm "${FNM_DIR:-$HOME/.local/share/fnm}"/node-versions/*/installation "$HOME/.fnm"/node-versions/*/installation "$HOME/Library/Application Support/fnm"/node-versions/*/installation',
    'kx_scan nvm "${NVM_DIR:-$HOME/.nvm}"/versions/node/*',
    'kx_scan volta "${VOLTA_HOME:-$HOME/.volta}"/tools/image/node/*',
    'kx_scan volta "${VOLTA_HOME:-$HOME/.volta}"/tools/image/packages/"$kx_pkg"',
    'kx_scan asdf "${ASDF_DATA_DIR:-$HOME/.asdf}"/installs/nodejs/*',
    'kx_scan npm-prefix "$HOME/.local" "$HOME/.npm-global"',
    'kx_scan system /usr/local /usr /opt/homebrew',
    ...auth,
    'true',
  ].join('\n');
}

export function parseAdapterProbe(out: string): AdapterProbe {
  const p: AdapterProbe = { nodes: [], entries: [], auth: [], cfg: [] };
  for (const raw of String(out || '').split(/\r?\n/)) {
    const f = raw.split('\t');
    const manager = MANAGERS.includes(f[1] as NodeManager) ? (f[1] as NodeManager) : undefined;
    if (f[0] === 'KX_PATHBIN' && f[1]) p.pathBin = { path: f[1], firstLine: f[2] || '' };
    else if (f[0] === 'KX_LOGINNODE' && f[1]) p.loginNode = f[1];
    else if (f[0] === 'KX_NODE' && manager && f[2] && !p.nodes.some((n) => n.path === f[2])) p.nodes.push({ manager, path: f[2] });
    else if (f[0] === 'KX_ENTRY' && manager && f[2] && !p.entries.some((n) => n.path === f[2])) p.entries.push({ manager, path: f[2] });
    else if (f[0] === 'KX_AUTH' && f[1] && !p.auth.includes(f[1])) p.auth.push(f[1]);
    else if (f[0] === 'KX_CFG' && f[1] && f[2]) p.cfg.push({ src: f[1], key: f[2], val: f[3] || '' });
  }
  return p;
}

/** 路径看起来属于哪个管理器（登录 PATH 上找到的那个没有 scan 时的标签）。 */
function managerOfPath(p: string): NodeManager {
  if (/\/fnm\/node-versions\//.test(p)) return 'fnm';
  if (/\/\.nvm\/|\/nvm\/versions\/node\//.test(p)) return 'nvm';
  if (/\/\.volta\//.test(p)) return 'volta';
  if (/\/\.asdf\/|\/installs\/nodejs\//.test(p)) return 'asdf';
  if (/\/\.local\/|\/\.npm-global\//.test(p)) return 'npm-prefix';
  return 'system';
}

/** `…/<root>/lib/node_modules/…` 或 `…/<root>/bin/node` 的 `<root>`。 */
function rootOf(p: string): string {
  const i = p.indexOf('/lib/node_modules/');
  if (i >= 0) return p.slice(0, i);
  return p.replace(/\/bin\/node$/, '');
}

/** 路径里的版本号（`v22.23.3` / `22.1.0`），挑"最新"的 node 用。认不出的排最后。 */
function versionOf(p: string): number[] {
  const m = /\/v?(\d+)\.(\d+)\.(\d+)(?:\/|$)/.exec(p);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
}
function newerFirst(a: string, b: string): number {
  const va = versionOf(a), vb = versionOf(b);
  for (let i = 0; i < 3; i += 1) if (va[i] !== vb[i]) return vb[i] - va[i];
  return 0;
}

function isNodeScript(bin: { path: string; firstLine: string }): boolean {
  return /\.(c|m)?js$/i.test(bin.path) || /^#!.*\bnode\b/.test(bin.firstLine);
}

/**
 * 探测结果 → 怎么起。
 *
 * 顺序：登录 shell 直接能起的照旧（不改原来那条路）；否则找一个入口 + 一个 node：
 * 入口优先登录 PATH 上那个（它就是 `npm i -g` 装出来的那份），其次各管理器下的；
 * node 优先和入口同一个版本目录的（fnm / nvm 每个版本各有自己的全局 node_modules），
 * 其次登录 shell 的，最后各管理器下最新的。
 */
export function judgeAdapterProbe(p: AdapterProbe): AdapterVerdict {
  if (p.pathBin && (!isNodeScript(p.pathBin) || p.loginNode)) return { kind: 'path' };
  const nodes = [...p.nodes].sort((a, b) => newerFirst(a.path, b.path));
  const nodeFor = (entry: string): { manager: NodeManager; path: string } | undefined => {
    const same = nodes.find((n) => rootOf(n.path) === rootOf(entry));
    if (same) return same;
    if (p.loginNode) return { manager: managerOfPath(p.loginNode), path: p.loginNode };
    return nodes[0];
  };
  const candidates: Array<{ manager: NodeManager; path: string }> = [];
  if (p.pathBin) {
    const scanned = p.entries.find((e) => e.path === p.pathBin!.path);
    candidates.push({ manager: scanned?.manager || managerOfPath(p.pathBin.path), path: p.pathBin.path });
  }
  /* 有同版本 node 的入口排前面，同类里新的排前面 */
  const rest = p.entries.filter((e) => !candidates.some((c) => c.path === e.path))
    .sort((a, b) => {
      const sa = nodes.some((n) => rootOf(n.path) === rootOf(a.path)) ? 0 : 1;
      const sb = nodes.some((n) => rootOf(n.path) === rootOf(b.path)) ? 0 : 1;
      return sa - sb || newerFirst(a.path, b.path);
    });
  candidates.push(...rest);
  if (!candidates.length) return { kind: 'missing' };
  for (const c of candidates) {
    const node = nodeFor(c.path);
    if (node) {
      /* 管理器标签说的是"node 归谁管"——那正是登录 shell 缺的那一截 */
      return { kind: 'absolute', manager: node.manager, node: node.path, entry: c.path };
    }
  }
  return { kind: 'no-node', manager: candidates[0].manager, entry: candidates[0].path };
}

/** 远端 `bash -lc` 里 `exec` 的那一截（PID 那行由 `buildRemoteAdapterCommand` 加）。 */
export function adapterExecLine(bin: string, launch?: AdapterVerdict): string {
  if (launch?.kind === 'absolute') {
    /* node 的目录也放进 PATH：适配器（Agent SDK）自己再起 node 子进程时按名字找 */
    const dir = launch.node.replace(/\/[^/]*$/, '') || '/';
    return `export PATH=${q(dir)}:"$PATH"; exec ${q(launch.node)} ${q(launch.entry)}`;
  }
  return `exec ${q(bin)}`;
}

/** 让登录 shell 也看得到这个管理器的 node：加进 `~/.bash_profile`（没有就 `~/.profile`）的那一行。 */
export function managerFix(manager: NodeManager, entry?: string): string {
  switch (manager) {
    case 'fnm': return 'export PATH="$HOME/.local/share/fnm:$PATH"; eval "$(fnm env --shell bash)"';
    case 'nvm': return '. "$HOME/.nvm/nvm.sh"';
    case 'volta': return 'export VOLTA_HOME="$HOME/.volta"; export PATH="$VOLTA_HOME/bin:$PATH"';
    case 'asdf': return 'export PATH="${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$PATH"';
    default: {
      const root = entry && entry.includes('/lib/node_modules/') ? rootOf(entry) : '$HOME/.local';
      return `export PATH="${root}/bin:$PATH"`;
    }
  }
}

const MANAGER_LABEL: Record<NodeManager, string> = {
  fnm: 'fnm', nvm: 'nvm', volta: 'Volta', asdf: 'asdf', 'npm-prefix': 'npm prefix', system: 'system Node',
};

/** 起不来的两种：没装 / 装了但没有 node 能跑它。能起的返回 undefined。 */
export function adapterProblemMessage(host: string, engine: AdapterEngine, v: AdapterVerdict): string | undefined {
  const bin = REMOTE_ADAPTER_BIN[engine];
  if (v.kind === 'missing') {
    return tr('{host} has no ACP adapter for {engine} ({bin}). Settings → 🖥 Machines → select this machine → "Install AI tools" will install it ({pkg}). You also need to have signed in to {engine} on that machine.', {
      host, engine: ENGINE_LABEL[engine], bin, pkg: ADAPTER_PACKAGE[engine],
    });
  }
  if (v.kind === 'no-node') {
    return tr('{host} has the ACP adapter for {engine} installed ({entry}), but no node to run it: the login shell (bash -lc) has no node, and none was found under fnm / nvm / Volta / asdf either. The adapter belongs to {manager}; add this line to ~/.bash_profile (or ~/.profile) on that machine so the login shell sees it: {fix}', {
      host, engine: ENGINE_LABEL[engine], entry: v.entry, manager: MANAGER_LABEL[v.manager], fix: managerFix(v.manager, v.entry),
    });
  }
  return undefined;
}

/** 装了但登录 shell 看不到、这次用绝对路径起了：状态行上说一声（主句 + 折叠的详情）。 */
export function adapterHiddenNotice(host: string, engine: AdapterEngine, v: AdapterVerdict): string | undefined {
  if (v.kind !== 'absolute') return undefined;
  const main = tr('The login shell on {host} can\'t find the {engine} adapter; started it with {manager}\'s node directly.', {
    host, engine: ENGINE_LABEL[engine], manager: MANAGER_LABEL[v.manager],
  });
  const detail = tr('The node on that machine is managed by {manager}, which only adds itself to PATH in interactive shells, so `bash -lc` can\'t see it. To make the login shell see it, add this line to ~/.bash_profile (or ~/.profile) there: {fix}\nnode: {node}\nadapter: {entry}', {
    manager: MANAGER_LABEL[v.manager], fix: managerFix(v.manager, v.entry), node: v.node, entry: v.entry,
  });
  return trConcat(main, NOTE_DETAIL_SEP, detail);
}

/** 远端那家 CLI 登录过 / 配过 Bedrock、API key、网关没有。 */
export function remoteAuthConfigured(engine: AdapterEngine, p: AdapterProbe): boolean {
  if (p.auth.length) return true;
  /* 只配了网关地址（ANTHROPIC_BASE_URL）不算：没有 key 照样要登录 */
  const secrets = engine === 'claude'
    ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'apiKeyHelper', 'primaryApiKey']
    : ['OPENAI_API_KEY', 'CODEX_API_KEY'];
  const flags = engine === 'claude' ? ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'] : [];
  return p.cfg.some((c) => (secrets.includes(c.key) && c.val === 'set')
    || (flags.includes(c.key) && /^(1|true|yes|on)$/i.test(c.val)));
}

export function remoteLoginHint(host: string, engine: AdapterEngine): string {
  return engine === 'claude'
    ? tr('⚠️ Claude Code on {host} is not signed in and has no Bedrock / API key configured, so messages will fail. Set it up under 🔑 Login at the bottom left of this session.', { host })
    : tr('⚠️ Codex on {host} is not signed in and has no provider / API key configured, so messages will fail. Set it up under 🔑 Login at the bottom left of this session.', { host });
}

/* ─────────── 探测结果按机器 + 引擎记住，起执行器时（acp-client.ts）取 ─────────── */

const launches = new Map<string, AdapterVerdict>();
function keyOf(remote: Pick<RemoteTarget, 'sshHost' | 'sshPort'>, engine: AdapterEngine): string {
  return `${remote.sshHost || ''}:${Number(remote.sshPort) > 0 ? Number(remote.sshPort) : 22}|${engine}`;
}
export function rememberRemoteAdapterLaunch(remote: Pick<RemoteTarget, 'sshHost' | 'sshPort'>, engine: AdapterEngine, v: AdapterVerdict): void {
  if (v.kind === 'path' || v.kind === 'absolute') launches.set(keyOf(remote, engine), v);
  else launches.delete(keyOf(remote, engine));
}
export function remoteAdapterLaunchFor(remote: Pick<RemoteTarget, 'sshHost' | 'sshPort'> | undefined, engine: string): AdapterVerdict | undefined {
  if (!remote?.sshHost || (engine !== 'claude' && engine !== 'codex')) return undefined;
  return launches.get(keyOf(remote, engine));
}

/* ─────────── 安装后的验证：按会话的启动方式起一次，等它回 initialize ─────────── */

export type AdapterVerifyResult = { ok: true } | { ok: false; problem?: string; exitCode?: number | null; timedOut?: boolean; stderrTail?: string };

/** ssh 每次都打的告警、PID 那一行都不是原因 —— 认它们会让每次失败都指错。 */
function meaningfulStderr(stderr: string): string {
  return String(stderr || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !/post-quantum|store now, decrypt later|openssh\.com|^\*\*|KIROLEX_REMOTE_PID/.test(l))
    .slice(-3).join('\n');
}

export function judgeAdapterVerify(r: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }): AdapterVerifyResult {
  if (/"id"\s*:\s*1\b[\s\S]*"result"|"result"[\s\S]*"protocolVersion"/.test(String(r.stdout || ''))) return { ok: true };
  return { ok: false, exitCode: r.exitCode, timedOut: r.timedOut, stderrTail: meaningfulStderr(r.stderr) };
}

export function adapterVerifyMessage(host: string, engine: AdapterEngine, v: AdapterVerifyResult): string {
  if (v.ok) return tr('✅ {engine} adapter on {host} starts the way sessions start it (bash -lc).', { host, engine: ENGINE_LABEL[engine] });
  if (v.problem) return v.problem;
  const why = v.timedOut
    ? tr('it did not answer initialize within the time limit')
    : tr('it exited with code {code}', { code: v.exitCode == null ? '?' : String(v.exitCode) });
  return tr('⚠️ After installing, tried to start the {engine} adapter on {host} the way sessions do (bash -lc), and it did not start: {why}.{stderr}', {
    host, engine: ENGINE_LABEL[engine], why, stderr: v.stderrTail ? `\n${v.stderrTail}` : '',
  });
}

/** ACP 的第一句话：验证只看它回不回。 */
export const ACP_INITIALIZE_LINE = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`;

/* ─────────── 「测试连接」：kiro 之外也报 Claude Code / Codex 能不能用 ─────────── */

const ENGINE_SPLIT = 'KX_ENGINE_SPLIT';

/**
 * 「测试连接」那一次 ssh 跑的整段：kiro 的预检原样在前，后面接两家适配器的探测（同一个 `adapterProbeScript`，
 * fnm / nvm 管的 node 也认）。原来只查 kiro-cli：只为 Claude / Codex 配的机器报「缺 kiro-cli」，
 * 装了 kiro、没装适配器的机器反而报「通了」。
 */
export function testConnectionScript(kiroPreflight: string): string {
  return [
    kiroPreflight,
    `echo ${ENGINE_SPLIT} claude`, adapterProbeScript('claude'),
    `echo ${ENGINE_SPLIT} codex`, adapterProbeScript('codex'),
  ].join('\n');
}

/** 把输出切回三段（kiro 那段就是 `judgePreflight` 原来看的那份）。 */
export function splitTestOutput(out: string): { kiro: string; claude: string; codex: string } {
  const parts: Record<string, string> = { kiro: '', claude: '', codex: '' };
  let cur = 'kiro';
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = new RegExp(`^${ENGINE_SPLIT} (claude|codex)\\s*$`).exec(line);
    if (m) { cur = m[1]; continue; }
    parts[cur] += `${line}\n`;
  }
  return parts as { kiro: string; claude: string; codex: string };
}

/** 一家适配器在那台机器上：能起（`ready`，带不带登录）/ 没 node / 没装。 */
export function adapterTestLine(engine: AdapterEngine, probeOut: string): { ready: boolean; text: string } {
  const p = parseAdapterProbe(probeOut);
  const v = judgeAdapterProbe(p);
  const label = ENGINE_LABEL[engine];
  if (v.kind === 'missing') return { ready: false, text: tr('{engine}: adapter not installed ({bin}).', { engine: label, bin: REMOTE_ADAPTER_BIN[engine] }) };
  if (v.kind === 'no-node') return { ready: false, text: tr('{engine}: adapter found, but there is no node to run it.', { engine: label }) };
  return remoteAuthConfigured(engine, p)
    ? { ready: true, text: tr('{engine}: ready.', { engine: label }) }
    : { ready: true, text: tr('{engine}: installed, but not signed in (no Bedrock / API key configured either).', { engine: label }) };
}

/**
 * kiro 的结论 + 两家适配器 → 「测试连接」的结果。
 *   · 连不上：kiro 那句原样（连不上谈不到哪个工具）。
 *   · kiro 通了：照旧算通，后面补两行适配器的情况。
 *   · kiro 不行、但有一家适配器能起：这台机器能跑那家的会话，算通（不然只为 Claude / Codex 配的机器永远过不了测试）。
 *   · 都不行：kiro 那个结论，后面补两行。
 */
export function judgeTestConnection(
  host: string,
  kiro: { code: string; message: string; missing?: string[] },
  sections: { claude: string; codex: string },
): { ok: boolean; code: string; message: string; missing?: string[] } {
  if (kiro.code === 'unreachable') return { ok: false, code: kiro.code, message: kiro.message, missing: kiro.missing };
  const lines = [adapterTestLine('claude', sections.claude), adapterTestLine('codex', sections.codex)];
  const tail = lines.map((l) => l.text).join('\n');
  if (kiro.code === 'ok') return { ok: true, code: 'ok', message: `${kiro.message}\n${tail}`, missing: kiro.missing };
  if (lines.some((l) => l.ready)) {
    return { ok: true, code: 'ok', message: `${tr('{host} is reachable.', { host })}\n${tail}\n${tr('Kiro: {why}', { why: kiro.message })}` };
  }
  return { ok: false, code: kiro.code, message: `${kiro.message}\n${tail}`, missing: kiro.missing };
}
