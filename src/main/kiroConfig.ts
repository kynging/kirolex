/**
 * **机器人按钮里 Agent 之外的那几类 kiro-cli 配置** ——「这个按钮除了配置 agent 之外，
 * 还有什么其他 kiro-cli 的配置可以加进来的？可以弄成几个不同的 tab」。
 *
 * 每一类都是 `~/.kiro` 下的一棵树或一个文件，所以这里统一成"列表 + 读 + 写"三个动作，
 * 界面那边每个 tab 都是同一个"文件列表 + 编辑器"。
 *
 * ## 按机器
 *
 * 这些配置是**那台机器上的 kiro-cli** 读的：远程会话的执行器读的是 EC2 上那份 `~/.kiro`，
 * 不是这台 Mac 上的。所以调用方按会话所在的机器选实现（`LocalKiroConfig` / 远程那份在
 * index.ts 里用 ssh 拼），而这个模块只管"哪些路径、怎么校验"。
 *
 * ## 路径安全
 *
 * 名字是渲染层传来的，而远程那条路会把它拼进 shell。所以：
 *   · 只认相对路径，每一段过白名单（`SEGMENT`），不许 `..`、不许绝对路径；
 *   · 拼好之后再确认它还在这一类的根目录下（`within`）；
 *   · 远程那边还会再包一层单引号（index.ts 的 `shellQuote`）。
 */

import fs from 'fs';
import path from 'path';
import { tr } from './uiText.ts';

/** kiro 的六类 + Claude Code / Codex 各自的那几类（id 带引擎前缀，三家放在一张表里不撞名）。 */
export type KiroConfigCategory = 'mcp' | 'steering' | 'prompts' | 'skills' | 'powers' | 'settings' | string;

export interface CategorySpec {
  id: KiroConfigCategory;
  /** tab 上显示的字 */
  label: string;
  /**
   * 哪个引擎的配置 —— 「claude code 和 codex 左下角也得有一个类似的图标」：机器人面板按会话的引擎给 tab。
   * 不写 = kiro。
   */
  engine?: 'kiro' | 'claude' | 'codex';
  /** 家目录下的哪个目录（`.kiro` / `.claude` / `.codex`）；不写 = `.kiro`。 */
  base?: string;
  /** 相对 `~/.kiro` 的根 */
  root: string;
  /**
   * `single`：就一个文件（`file` 是它相对 root 的名字）；
   * `list`：一棵树里的一批文件（按 `match` 认）。
   */
  kind: 'single' | 'list';
  file?: string;
  /** list 类：哪些相对路径算这一类的文件 */
  match?: RegExp;
  /** list 类：最多往下几层（steering 有一层子目录，skills 是 `<名字>/SKILL.md`） */
  depth?: number;
  /** 内容必须是 JSON（保存前校验） */
  json?: boolean;
  /** 只读：kiro-cli 自己管理的，手改会和它打架 */
  readOnly?: boolean;
  /** list 类：能不能新建 */
  creatable?: boolean;
  /** 新建时的默认扩展名 */
  ext?: string;
  /** 一句话说明，显示在 tab 里 */
  hint: string;
  /**
   * Claude Code：插件里带的那一类（`~/.claude/plugins/cache/<市场>/<插件>/<版本>/<这个目录>/…`）也列进来，只读。
   * 「claude code 的配置什么都拿不到」—— 两台机器的 `~/.claude/{agents,commands,skills}` 都是空的，
   * 你在用的 skill / 命令 / 子代理全是插件带的（superpowers 那些）。
   */
  pluginDir?: 'skills' | 'commands' | 'agents';
}

export const CATEGORIES: CategorySpec[] = [
  {
    id: 'mcp', label: 'MCP', root: 'settings', kind: 'single', file: 'mcp.json', json: true,
    hint: "Global MCP servers (shared by every agent). An agent's own mcpServers are edited under Agents.",
  },
  {
    id: 'steering', label: 'Steering', root: 'steering', kind: 'list', match: /\.md$/i, depth: 3,
    creatable: true, ext: '.md',
    hint: "Standing rules: sent to the model on every turn.",
  },
  {
    id: 'prompts', label: 'Prompts', root: 'prompts', kind: 'list', match: /\.md$/i, depth: 2,
    creatable: true, ext: '.md',
    hint: "Saved prompts. Call one up in a session with @name.",
  },
  {
    id: 'skills', label: 'Skills', root: 'skills', kind: 'list', match: /^[^/]+\/SKILL\.md$/, depth: 2,
    hint: "Each skill's SKILL.md (scripts/reference files in the same folder are not edited here).",
  },
  {
    id: 'powers', label: 'Powers', root: 'powers', kind: 'single', file: 'installed.json', json: true,
    readOnly: true,
    hint: "Installed Powers, managed by kiro-cli. View only here (editing by hand would conflict with its install records).",
  },
  {
    id: 'settings', label: 'Settings', root: 'settings', kind: 'single', file: 'cli.json', json: true,
    hint: "kiro-cli settings (default model, autoApprove, MCP timeouts...). Same file as `kiro-cli settings <key> <value>`.",
  },
];

/*
 * Claude Code / Codex 的配置 —— 和 kiro 那六类同一套"列表 + 读 + 写"，只是根在 `~/.claude` / `~/.codex`。
 * 只列"改了就生效、改错了也只坏这一项"的文件。Claude 的 MCP 在 `~/.claude.json` 里，那份同时存着每个项目的
 * 状态、很大，手改容易把别的弄坏，所以先不放进来（用 `claude mcp add` 改）。
 */
CATEGORIES.push(
  {
    id: 'claude-settings', engine: 'claude', base: '.claude', label: 'Settings', root: '', kind: 'single', file: 'settings.json', json: true,
    hint: "Claude Code user settings (env holds the gateway URL and key; also permissions, model...). For remote sessions this edits the copy on that machine.",
  },
  {
    id: 'claude-memory', engine: 'claude', base: '.claude', label: 'CLAUDE.md', root: '', kind: 'single', file: 'CLAUDE.md',
    hint: "User-level standing instructions: every session reads it (same purpose as kiro's Steering).",
  },
  {
    id: 'claude-agents', engine: 'claude', base: '.claude', label: 'Agents', root: 'agents', kind: 'list', match: /\.md$/i, depth: 1,
    creatable: true, ext: '.md', pluginDir: 'agents',
    hint: "Subagent definitions (one .md each, starting with YAML front matter). Entries tagged with a plugin name come from plugins and are read-only.",
  },
  {
    id: 'claude-commands', engine: 'claude', base: '.claude', label: 'Commands', root: 'commands', kind: 'list', match: /\.md$/i, depth: 2,
    creatable: true, ext: '.md', pluginDir: 'commands',
    hint: "Custom slash commands: the file name is the command name (/name). Entries tagged with a plugin name come from plugins (/plugin:name) and are read-only.",
  },
  {
    id: 'claude-skills', engine: 'claude', base: '.claude', label: 'Skills', root: 'skills', kind: 'list', match: /^[^/]+\/SKILL\.md$/, depth: 2,
    pluginDir: 'skills',
    hint: "Each skill's SKILL.md (scripts/reference files in the same folder are not edited here). Entries tagged with a plugin name come from plugins and are read-only.",
  },
  {
    id: 'claude-plugins', engine: 'claude', base: '.claude', label: 'Plugins', root: 'plugins', kind: 'single', file: 'installed_plugins.json',
    json: true, readOnly: true,
    hint: "Installed plugins (managed by Claude Code, view only here). Install / uninstall with `claude plugin install|uninstall`; toggle them via enabledPlugins in Settings.",
  },
  {
    id: 'codex-config', engine: 'codex', base: '.codex', label: 'config.toml', root: '', kind: 'single', file: 'config.toml',
    hint: "Codex config (model, model_provider, [model_providers.*], MCP, sandbox...). It is TOML, not JSON.",
  },
  {
    id: 'codex-agents', engine: 'codex', base: '.codex', label: 'AGENTS.md', root: '', kind: 'single', file: 'AGENTS.md',
    hint: "User-level standing instructions: every session reads it.",
  },
  {
    id: 'codex-prompts', engine: 'codex', base: '.codex', label: 'Prompts', root: 'prompts', kind: 'list', match: /\.md$/i, depth: 1,
    creatable: true, ext: '.md',
    hint: "Custom prompts: the file name is the command name (/prompts:name).",
  },
  {
    id: 'codex-skills', engine: 'codex', base: '.codex', label: 'Skills', root: 'skills', kind: 'list', match: /^[^/]+\/SKILL\.md$/, depth: 2,
    hint: "Each skill's SKILL.md.",
  },
);

/** 某个引擎的那几类（机器人面板的 tab）。 */
export function categoriesFor(engine: 'kiro' | 'claude' | 'codex' = 'kiro'): CategorySpec[] {
  /* hint 是给人看的：表里存英文 key，这里按当前界面语言翻（词条在 uiTextZh/modulesB.ts） */
  return CATEGORIES.filter((c) => (c.engine || 'kiro') === engine).map((c) => ({ ...c, hint: tr(c.hint) }));
}

/** 相对家目录的根：`.kiro/steering`、`.claude`（单文件直接放在 base 下时 root 是空的）。 */
export function rootRel(spec: CategorySpec): string {
  return [spec.base || '.kiro', spec.root].filter(Boolean).join('/');
}

export function categorySpec(id: string): CategorySpec | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

/** 一段路径名。中文名字（steering 里常见）也要放行，所以不是 `\w`。 */
const SEGMENT = /^(?!\.{1,2}$)[^/\\\0<>:"|?*\x00-\x1f]{1,120}$/;

/**
 * 校验并规范化一个相对名字。不合格返回 `null`。
 *
 * 这一步决定了"能不能碰到 `~/.kiro/<root>` 之外的东西"，所以宁严勿宽：
 * 反斜杠一律当分隔符拆开再逐段查（Windows 那边传来的路径）。
 */
export function cleanName(name: string): string | null {
  const raw = String(name || '').trim().replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts.length > 4) return null;
  for (const p of parts) if (!SEGMENT.test(p) || p.startsWith('.')) return null;
  return parts.join('/');
}

/** `child` 在 `root` 里面（含等于）。两个都按 POSIX 看 —— 远程那边是 Linux。 */
export function within(root: string, child: string): boolean {
  const r = root.replace(/\/+$/, '');
  return child === r || child.startsWith(`${r}/`);
}

/**
 * 某一类里某个条目的完整路径（`home` 是那台机器的家目录）。
 * single 类忽略 `name`；list 类的名字必须符合 `match`。
 */
export function entryPath(home: string, spec: CategorySpec, name?: string): string | null {
  if (spec.pluginDir && isPluginName(name)) {
    const rel = cleanPluginRel(spec, String(name).slice(PLUGIN_PREFIX.length));
    return rel ? `${home.replace(/\/+$/, '')}/${PLUGIN_CACHE_REL}/${rel}` : null;
  }
  const root = `${home.replace(/\/+$/, '')}/${rootRel(spec)}`;
  if (spec.kind === 'single') return `${root}/${spec.file}`;
  const clean = cleanName(name || '');
  if (!clean || !spec.match?.test(clean)) return null;
  const full = `${root}/${clean}`;
  return within(root, full) ? full : null;
}

/** 保存前的内容校验。返回一句给人看的错误，或 `null`。 */
export function validateContent(spec: CategorySpec, content: string): string | null {
  if (spec.readOnly) return tr('{label} is managed by kiro-cli and cannot be edited here.', { label: spec.label });
  if (content.length > 1024 * 1024) return tr('Larger than 1 MB. A config this big is most likely something pasted by mistake.');
  if (spec.json) {
    try {
      const v = JSON.parse(content);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return tr('Must be a JSON object.');
    } catch (e: any) {
      return tr('JSON error: {err}', { err: e?.message || e });
    }
  }
  return null;
}

export interface ConfigEntry {
  name: string;
  size: number;
  /** 列表里显示的字（插件条目是「插件 · 名字」）；不给就由界面按路径算 */
  label?: string;
  /** 这一条只读（插件带的） */
  readOnly?: boolean;
}

/* ------------------------------------------------------------------ 插件带的条目（Claude Code） */

/** 插件条目的名字：`@plugin/<市场>/<插件>/<版本>/<子路径>`（相对 `~/.claude/plugins/cache`）。 */
export const PLUGIN_PREFIX = '@plugin/';
export const PLUGIN_CACHE_REL = '.claude/plugins/cache';
const PLUGIN_MATCH: Record<NonNullable<CategorySpec['pluginDir']>, RegExp> = {
  skills: /^[^/]+\/[^/]+\/[^/]+\/skills\/[^/]+\/SKILL\.md$/,
  commands: /^[^/]+\/[^/]+\/[^/]+\/commands\/(?:[^/]+\/)?[^/]+\.md$/,
  agents: /^[^/]+\/[^/]+\/[^/]+\/agents\/[^/]+\.md$/,
};

export function isPluginName(name?: string): boolean {
  return String(name || '').startsWith(PLUGIN_PREFIX);
}

/** 插件 cache 下的一个相对路径是否合规（逐段过白名单、不许 `..`），并且是这一类的文件。 */
function cleanPluginRel(spec: CategorySpec, rel: string): string | null {
  if (!spec.pluginDir) return null;
  const parts = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length < 5 || parts.length > 7) return null;
  for (const p of parts) if (!SEGMENT.test(p) || p.startsWith('.')) return null;
  const clean = parts.join('/');
  return PLUGIN_MATCH[spec.pluginDir].test(clean) ? clean : null;
}

/**
 * 从 cache 里的"相对路径\t大小\tmtime"挑出这一类的插件条目。
 * **一个插件只取一个版本** —— cache 里旧版本不会被清掉（同一个插件可以并排放着几个版本），
 * 全列出来就是一排重名的。取文件最新的那个版本：更新插件就是往里放一个新版本目录。
 */
export function pickPluginEntries(spec: CategorySpec, lines: string[]): ConfigEntry[] {
  const rows: Array<{ rel: string; size: number; mtime: number; plugin: string; version: string }> = [];
  for (const line of lines) {
    const [rel, size, mtime] = line.split('\t');
    const clean = cleanPluginRel(spec, rel || '');
    if (!clean) continue;
    const [market, plugin, version] = clean.split('/');
    rows.push({ rel: clean, size: Number(size) || 0, mtime: Number(mtime) || 0, plugin: `${market}/${plugin}`, version });
  }
  const newest = new Map<string, { version: string; mtime: number }>();
  for (const r of rows) {
    const cur = newest.get(r.plugin);
    if (!cur || r.mtime > cur.mtime) newest.set(r.plugin, { version: r.version, mtime: r.mtime });
  }
  return rows
    .filter((r) => newest.get(r.plugin)?.version === r.version)
    .map((r) => {
      const parts = r.rel.split('/');
      const tail = parts.slice(4);            // `<skills|commands|agents>/` 之后那一截
      const shown = spec.pluginDir === 'skills' ? tail[0] : tail.join('/').replace(/\.md$/i, '');
      return { name: PLUGIN_PREFIX + r.rel, size: r.size, label: `${parts[1]} · ${shown}`, readOnly: true };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * 从一份"相对路径\t大小"的列表里挑出这一类的文件 —— 本地和远程共用这一段，
 * 这样两边认出来的条目一定一样（远程那边用 `find -printf` 产出同样的格式）。
 */
export function pickEntries(spec: CategorySpec, lines: string[]): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  for (const line of lines) {
    const [rel, size] = line.split('\t');
    const clean = cleanName(rel || '');
    if (!clean || !spec.match?.test(clean)) continue;
    if (clean.split('/').length > (spec.depth || 1)) continue;
    out.push({ name: clean, size: Number(size) || 0 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 插件带的条目不许写 —— 插件一更新就会被它自己的版本盖回去，改了也白改。 */
export function pluginWriteError(name?: string): string | null {
  return isPluginName(name) ? tr('This comes from a plugin and is read-only (edits would be overwritten when the plugin updates). To change it, create your own file with the same name under Skills / Commands / Agents.') : null;
}

/* ------------------------------------------------------------------ 本机 */

/** 本机那一份：直接 fs。 */
export class LocalKiroConfig {
  /* 不用 `constructor(private home)`：测试跑在 node 的 strip-only 模式下，它不认参数属性 */
  private home: string;
  constructor(home: string) { this.home = home; }

  list(spec: CategorySpec): ConfigEntry[] {
    if (spec.kind === 'single') {
      const p = entryPath(this.home, spec)!;
      try { return [{ name: spec.file!, size: fs.statSync(p).size }]; } catch { return [{ name: spec.file!, size: -1 }]; }
    }
    const root = path.join(this.home, ...rootRel(spec).split('/'));
    const lines: string[] = [];
    const walk = (dir: string, rel: string, depth: number) => {
      if (depth > (spec.depth || 1)) return;
      let ents: fs.Dirent[];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs, r, depth + 1);
        else if (e.isFile()) { try { lines.push(`${r}\t${fs.statSync(abs).size}`); } catch { /* 刚被删 */ } }
      }
    };
    walk(root, '', 1);
    return [...pickEntries(spec, lines), ...this.pluginEntries(spec)];
  }

  /** 插件 cache 里这一类的文件（`<市场>/<插件>/<版本>/<类>/…`，最多 7 层）。 */
  private pluginEntries(spec: CategorySpec): ConfigEntry[] {
    if (!spec.pluginDir) return [];
    const root = path.join(this.home, ...PLUGIN_CACHE_REL.split('/'));
    const lines: string[] = [];
    const walk = (dir: string, rel: string, depth: number) => {
      if (depth > 7) return;
      let ents: fs.Dirent[];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        /* 第 4 层必须就是这一类的目录 —— 不然会把整个插件（脚本、测试、文档）都走一遍 */
        if (depth === 4 && e.name !== spec.pluginDir) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs, r, depth + 1);
        else if (e.isFile() && depth >= 5) {
          try { const st = fs.statSync(abs); lines.push(`${r}\t${st.size}\t${Math.floor(st.mtimeMs / 1000)}`); } catch { /* 刚被删 */ }
        }
      }
    };
    walk(root, '', 1);
    return pickPluginEntries(spec, lines);
  }

  read(spec: CategorySpec, name?: string): { path: string; content: string; exists: boolean } | { error: string } {
    const p = entryPath(this.home, spec, name);
    if (!p) return { error: tr('Invalid name.') };
    try { return { path: p, content: fs.readFileSync(p, 'utf-8'), exists: true }; } catch (e: any) {
      if (e?.code === 'ENOENT') return { path: p, content: spec.json ? '{}\n' : '', exists: false };
      return { error: e?.message || String(e) };
    }
  }

  write(spec: CategorySpec, name: string | undefined, content: string): { path: string } | { error: string } {
    const why = validateContent(spec, content) || pluginWriteError(name);
    if (why) return { error: why };
    const p = entryPath(this.home, spec, name);
    if (!p) return { error: tr('Invalid name.') };
    /* 原子写：kiro-cli 随时可能在读它，写一半被读到就是一份坏配置 */
    const tmp = `${p}.kirolex-${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      let mode: number | undefined;
      try { mode = fs.statSync(p).mode; } catch { /* 新文件 */ }
      fs.writeFileSync(tmp, content, { encoding: 'utf-8', ...(mode ? { mode } : {}) });
      fs.renameSync(tmp, p);
      return { path: p };
    } catch (e: any) {
      try { fs.unlinkSync(tmp); } catch { /* 没写出来 */ }
      return { error: e?.message || String(e) };
    }
  }
}

/* ------------------------------------------------------------------ 远程 */

/*
  远程那一份只产出**脚本**，执行交给 index.ts（它有 ssh、复用连接、超时）。
  内容一律走 base64：配置里什么字符都可能有，直接拼进 shell 迟早出事。
  `q` 是 index.ts 的 shellQuote（单引号包裹），由调用方传进来，避免这里重复实现一份。
*/

export function remoteListScript(spec: CategorySpec, q: (s: string) => string): string {
  if (spec.kind === 'single') {
    const rel = `${rootRel(spec)}/${spec.file}`;
    return `f="$HOME"/${q(rel)}; if [ -f "$f" ]; then printf '%s\\t%s\\n' ${q(spec.file!)} "$(wc -c < "$f" | tr -d ' ')"; else printf '%s\\t-1\\n' ${q(spec.file!)}; fi`;
  }
  const own = `( d="$HOME"/${q(rootRel(spec))}; [ -d "$d" ] && cd "$d" && find . -maxdepth ${spec.depth || 1} -type f -not -name '.*' -printf '%P\\t%s\\n' 2>/dev/null; true )`;
  if (!spec.pluginDir) return own;
  /* 插件那一段和自己的在**同一次** ssh 里列出来（这台机器上一次 ssh 就是几秒），中间用一行分隔 */
  return `${own}; echo ${q(PLUGIN_SPLIT)}; ( c="$HOME"/${q(PLUGIN_CACHE_REL)}; [ -d "$c" ] && cd "$c" && find . -mindepth 5 -maxdepth 7 -path ${q(`./*/*/*/${spec.pluginDir}/*`)} -type f -name '*.md' -printf '%P\\t%s\\t%T@\\n' 2>/dev/null; true )`;
}

/** 远程列表输出里"自己的"和"插件的"之间那一行。 */
export const PLUGIN_SPLIT = '--KIROLEX-PLUGINS--';

/** 拆 `remoteListScript` 的输出：前一段是自己的（`pickEntries`），后一段是插件的。 */
export function parseRemoteList(spec: CategorySpec, out: string): ConfigEntry[] {
  const lines = String(out || '').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
  const at = lines.indexOf(PLUGIN_SPLIT);
  const own = at >= 0 ? lines.slice(0, at) : lines;
  const plug = at >= 0 ? lines.slice(at + 1) : [];
  return [...pickEntries(spec, own), ...pickPluginEntries(spec, plug)];
}

/** 远程读：先打一行 `EXISTS 0|1`，再是 base64 的内容。 */
export function remoteReadScript(rel: string, q: (s: string) => string): string {
  return `f="$HOME"/${q(rel)}; if [ -f "$f" ]; then echo "EXISTS 1"; base64 -w0 < "$f"; else echo "EXISTS 0"; fi`;
}

/** 解析 `remoteReadScript` 的输出。 */
export function parseRemoteRead(out: string): { exists: boolean; content: string } {
  const s = String(out || '');
  const nl = s.indexOf('\n');
  const head = nl >= 0 ? s.slice(0, nl) : s;
  const body = nl >= 0 ? s.slice(nl + 1).trim() : '';
  const exists = /EXISTS 1/.test(head);
  return { exists, content: exists && body ? Buffer.from(body, 'base64').toString('utf-8') : '' };
}

/** 远程写：内容从 stdin 进来（base64），落到同目录的临时文件再 mv —— 和本机一样原子。 */
export function remoteWriteScript(rel: string, q: (s: string) => string): string {
  return [
    /* 以 `/` 开头的是那台机器上的绝对路径（侧栏 review 写回远端文件），原样用；其余相对家目录 */
    rel.startsWith('/') ? `f=${q(rel)}` : `f="$HOME"/${q(rel)}`,
    'mkdir -p "$(dirname "$f")"',
    't="$f.kirolex-$$.tmp"',
    'base64 -d > "$t" && mv -f "$t" "$f" || { rm -f "$t"; exit 1; }',
  ].join(' && ');
}

/** 相对家目录的路径（远程那边用 `$HOME` 拼，不需要知道家目录在哪）。 */
export function relPath(spec: CategorySpec, name?: string): string | null {
  const full = entryPath('/H', spec, name);
  return full ? full.slice('/H/'.length) : null;
}
