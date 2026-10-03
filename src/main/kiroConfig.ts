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

export type KiroConfigCategory = 'mcp' | 'steering' | 'prompts' | 'skills' | 'powers' | 'settings';

export interface CategorySpec {
  id: KiroConfigCategory;
  /** tab 上显示的字 */
  label: string;
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
}

export const CATEGORIES: CategorySpec[] = [
  {
    id: 'mcp', label: 'MCP', root: 'settings', kind: 'single', file: 'mcp.json', json: true,
    hint: '全局 MCP server（所有 agent 共用）。某个 agent 自己的 mcpServers 在 Agents 里改。',
  },
  {
    id: 'steering', label: 'Steering', root: 'steering', kind: 'list', match: /\.md$/i, depth: 3,
    creatable: true, ext: '.md',
    hint: '常驻规则：每一轮都会带给模型。',
  },
  {
    id: 'prompts', label: 'Prompts', root: 'prompts', kind: 'list', match: /\.md$/i, depth: 2,
    creatable: true, ext: '.md',
    hint: '存下来的提示词，在会话里用 @名字 调出来。',
  },
  {
    id: 'skills', label: 'Skills', root: 'skills', kind: 'list', match: /^[^/]+\/SKILL\.md$/, depth: 2,
    hint: '每个 skill 的 SKILL.md（同目录下的脚本/参考文件不在这里改）。',
  },
  {
    id: 'powers', label: 'Powers', root: 'powers', kind: 'single', file: 'installed.json', json: true,
    readOnly: true,
    hint: '已安装的 Powers —— 由 kiro-cli 管理，这里只看不改（手改会和它的安装记录打架）。',
  },
  {
    id: 'settings', label: 'Settings', root: 'settings', kind: 'single', file: 'cli.json', json: true,
    hint: 'kiro-cli settings（默认模型、autoApprove、MCP 超时…）。和 `kiro-cli settings <键> <值>` 是同一个文件。',
  },
];

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
  const root = `${home.replace(/\/+$/, '')}/.kiro/${spec.root}`;
  if (spec.kind === 'single') return `${root}/${spec.file}`;
  const clean = cleanName(name || '');
  if (!clean || !spec.match?.test(clean)) return null;
  const full = `${root}/${clean}`;
  return within(root, full) ? full : null;
}

/** 保存前的内容校验。返回一句给人看的错误，或 `null`。 */
export function validateContent(spec: CategorySpec, content: string): string | null {
  if (spec.readOnly) return `${spec.label} 由 kiro-cli 管理，这里不能改。`;
  if (content.length > 1024 * 1024) return '超过 1 MB —— 这么大的配置多半是贴错了东西。';
  if (spec.json) {
    try {
      const v = JSON.parse(content);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return '必须是一个 JSON 对象。';
    } catch (e: any) {
      return `JSON 有错：${e?.message || e}`;
    }
  }
  return null;
}

export interface ConfigEntry { name: string; size: number }

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
    const root = path.join(this.home, '.kiro', spec.root);
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
    return pickEntries(spec, lines);
  }

  read(spec: CategorySpec, name?: string): { path: string; content: string; exists: boolean } | { error: string } {
    const p = entryPath(this.home, spec, name);
    if (!p) return { error: '名字不合规。' };
    try { return { path: p, content: fs.readFileSync(p, 'utf-8'), exists: true }; } catch (e: any) {
      if (e?.code === 'ENOENT') return { path: p, content: spec.json ? '{}\n' : '', exists: false };
      return { error: e?.message || String(e) };
    }
  }

  write(spec: CategorySpec, name: string | undefined, content: string): { path: string } | { error: string } {
    const why = validateContent(spec, content);
    if (why) return { error: why };
    const p = entryPath(this.home, spec, name);
    if (!p) return { error: '名字不合规。' };
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
    const rel = `.kiro/${spec.root}/${spec.file}`;
    return `f="$HOME"/${q(rel)}; if [ -f "$f" ]; then printf '%s\\t%s\\n' ${q(spec.file!)} "$(wc -c < "$f" | tr -d ' ')"; else printf '%s\\t-1\\n' ${q(spec.file!)}; fi`;
  }
  return `d="$HOME"/${q(`.kiro/${spec.root}`)}; [ -d "$d" ] && cd "$d" && find . -maxdepth ${spec.depth || 1} -type f -not -name '.*' -printf '%P\\t%s\\n' 2>/dev/null; true`;
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
    `f="$HOME"/${q(rel)}`,
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
