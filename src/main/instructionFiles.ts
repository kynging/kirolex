/**
 * **这条会话的引擎实际会读的全部指令文件** —— 机器人面板的「CLAUDE.md」「AGENTS.md」tab。
 *
 * 原来那两个 tab 只编辑家目录下的一份（`~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md`），而引擎实际还会读
 * 工作目录、上层目录、子目录里的、以及被 `@路径` 引用的文件 —— 用户看不到全貌，就不知道「写了哪个生效」。
 * 这里按**引擎自己的查找规则**把它们列全（按会话所在的机器和工作目录；远程会话列远端的）。
 *
 * ## 规则（核实过：claude-agent-acp 0.95 带的 Claude Code / Agent SDK 0.3.309 的 claude.exe；codex 0.164 实跑）
 *
 * Claude Code（适配器起 CLI 时 `settingSources: ["user","project","local"]`，三类都读）：
 *   · 用户级：`~/.claude/CLAUDE.md`（设了 `CLAUDE_CONFIG_DIR` 就是 `$CLAUDE_CONFIG_DIR/CLAUDE.md`）
 *   · 项目级：从工作目录往上**每一层**（到文件系统根为止、不含根）的 `CLAUDE.md`、`.claude/CLAUDE.md`
 *     —— 二进制里就是 `for (d = cwd; d !== parse(d).root; d = dirname(d))`，不在仓库根停
 *   · 本地：同样每一层的 `CLAUDE.local.md`
 *   · 子目录：工作目录下面的 `CLAUDE.md` 等是读到那个子目录里的文件时才按需加载的；这里列深度 ≤ 3 的，跳过
 *     `node_modules` / `.git`（别的隐藏目录照列，比如 `.github/CLAUDE.md`）
 *   · 引用：上面这些文件里的 `@路径`（正则 `(?:^|\s)@((?:[^\s\\]|\\ )+)`，去掉 `#…`，`\ ` 是空格；
 *     相对**引用它的文件所在目录**，`~/` 是家目录；代码块、行内代码、HTML 注释里的不算），最多 5 层
 *   · 同一路径只读一次（引用成环不会死循环）
 *   · Claude Code **不读** AGENTS.md（二进制里只为统计看了一眼它在不在）
 *
 * Codex（`thread/start` 返回的 `instructionSources` 实测）：
 *   · Codex 的家目录是 `CODEX_HOME`（执行器环境里设了的话），否则 `~/.codex`
 *   · 用户级：家目录里 `AGENTS.override.md`、`AGENTS.md` 中**第一个内容非空**的（空的 override 回退到 AGENTS.md）
 *   · 项目级：从**仓库根**（往上最近一个有 `.git` 的目录；没有就只看工作目录）往下到工作目录，每层一份：
 *     按 `AGENTS.override.md` → `AGENTS.md` → `config.toml` 顶层 `project_doc_fallback_filenames` 的顺序，
 *     **第一个存在的**占住这一层（它是空的就这一层什么都不读 —— 实测空 override 也挡住同目录的 AGENTS.md）。
 *     备用文件名只用于项目级、只认单纯的文件名。仓库根之上、工作目录之下的都不读；没有 @引用
 *   · 两家都一样：内容只有空白的文件不进上下文（标「空文件」）
 *
 * 纯模块（不碰 electron）：本机 / 远端各给一个 `InstructionFs`，规则只写一遍。
 */
import fs from 'fs';
import path from 'path';

export type InstructionEngine = 'claude' | 'codex';
export type InstructionKind = 'user' | 'project' | 'local' | 'subdir' | 'import';

export interface InstructionEntry {
  /** 那台机器上的绝对路径 */
  path: string;
  kind: InstructionKind;
  exists: boolean;
  /** 字节数；不存在 = -1 */
  size: number;
  /** 不存在、但这是引擎的标准位置 —— 界面上「未创建」+ 一键新建 */
  creatable?: boolean;
  /** 引用：被哪个文件引用 */
  importedBy?: string;
  /** 工作目录之上那几层的（项目级 / 本地） */
  ancestor?: boolean;
  /** 这一份不读：同一层被它先占了（Codex：override / 前面的名字） */
  shadowedBy?: string;
  /** 存在但只有空白：引擎不把它放进上下文 */
  empty?: boolean;
  /** Codex 的 `project_doc_fallback_filenames` 里配的名字（不是标准位置，没有就不列） */
  fallback?: boolean;
}

export interface ProbeResult { exists: boolean; isDir?: boolean; size: number; content?: string }

/** 一台机器上的文件系统 —— 只要这几样。 */
export interface InstructionFs {
  pm: path.PlatformPath;
  home: string;
  /** 执行器环境里会改位置的那几个变量（`CODEX_HOME` / `CLAUDE_CONFIG_DIR`），没设就是空的 */
  env: { CODEX_HOME?: string; CLAUDE_CONFIG_DIR?: string };
  /** 一批路径的存在 / 大小 / 内容（≤ 1 MB 的文件才带内容）。远端一次 ssh 问完一批。 */
  probe(paths: string[]): Promise<Map<string, ProbeResult>>;
  /** 工作目录下名字在 `names` 里的文件（相对 cwd，`/` 分隔），跳过 node_modules / .git。 */
  findBelow(cwd: string, names: string[]): Promise<string[]>;
}

const CLAUDE_SUB_NAMES = ['CLAUDE.md', 'CLAUDE.local.md'];
/** Claude Code 的引用深度上限（二进制里 `vOr=5`：被引用的第 5 层不再读）。 */
export const IMPORT_MAX_DEPTH = 5;
const MAX_CONTENT = 1024 * 1024;

/** 从工作目录往上每一层（含 cwd，不含文件系统根），由近到远。 */
function ancestorsOf(cwd: string, pm: path.PlatformPath): string[] {
  const out: string[] = [];
  let d = pm.resolve(cwd);
  while (d && d !== pm.parse(d).root) {
    out.push(d);
    const up = pm.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

/** 子目录里的那几个名字：所在目录深度 1..3，路径上没有 node_modules / .git（别的隐藏目录照列）。 */
export function subdirInstructionRel(rel: string): boolean {
  const parts = rel.split('/').filter(Boolean);
  const name = parts[parts.length - 1];
  let dirs: string[];
  if (parts.length >= 3 && name === 'CLAUDE.md' && parts[parts.length - 2] === '.claude') dirs = parts.slice(0, -2);
  else if (CLAUDE_SUB_NAMES.includes(name)) dirs = parts.slice(0, -1);
  else return false;
  if (dirs.length < 1 || dirs.length > 3) return false;
  /* 工作目录自己的 `.claude/CLAUDE.md` 是项目级那份，不是子目录 */
  if (dirs.length === 1 && dirs[0] === '.claude' && name === 'CLAUDE.md') return false;
  return dirs.every((d) => d !== 'node_modules' && d !== '.git');
}

/** 一个文件里的 `@路径`（原样，还没解析成绝对路径）。取舍和 Claude Code 的 `T2o` 一致。 */
export function parseImports(content: string): string[] {
  const text = String(content || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split(/\r?\n/);
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null; continue; }
    if (m) { fence = m[1]; continue; }
    kept.push(line.replace(/(`+)[\s\S]*?\1/g, ' '));
  }
  const out: string[] = [];
  const re = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
  let m: RegExpExecArray | null;
  const body = kept.join('\n');
  while ((m = re.exec(body)) !== null) {
    let p = m[1];
    const hash = p.indexOf('#');
    if (hash !== -1) p = p.slice(0, hash);
    p = p.replace(/\\ /g, ' ');
    if (!p) continue;
    const ok = p.startsWith('./') || p.startsWith('~/') || (p.startsWith('/') && p !== '/')
      || (!p.startsWith('@') && !/^[#%^&*()]+/.test(p) && /^[a-zA-Z0-9._-]/.test(p));
    if (ok && !out.includes(p)) out.push(p);
  }
  return out;
}

/** `@路径` → 绝对路径：`~/` 是家目录，其余相对引用它的文件所在目录。 */
export function resolveImport(raw: string, fromFile: string, home: string, pm: path.PlatformPath): string {
  if (raw.startsWith('~/')) return pm.join(home, raw.slice(2));
  return pm.resolve(pm.dirname(fromFile), raw);
}

/** 列出来。`cwd` 没有（没开会话）就只列用户级。 */
export async function listInstructionFiles(engine: InstructionEngine, cwd: string | undefined, fsx: InstructionFs): Promise<InstructionEntry[]> {
  return engine === 'codex' ? listCodex(cwd, fsx) : listClaude(cwd, fsx);
}

/** 存在、读到了内容、内容只有空白 —— 大到没带内容的当作非空 */
const isBlank = (r: ProbeResult | undefined) => !!r?.exists && !r.isDir && r.content !== undefined && !r.content.trim();

const entryOf = (p: string, kind: InstructionKind, r: ProbeResult | undefined, extra: Partial<InstructionEntry> = {}): InstructionEntry => ({
  path: p, kind, exists: !!r?.exists && !r.isDir, size: r?.exists && !r.isDir ? r.size : -1, ...(isBlank(r) ? { empty: true } : {}), ...extra,
});

/** 变量里的目录：`~/` 开头按家目录展开，相对的按家目录算（GUI 起的进程没有有意义的 cwd） */
const dirFromEnv = (v: string | undefined, home: string, pm: path.PlatformPath): string | undefined => {
  const t = String(v || '').trim();
  if (!t) return undefined;
  return t === '~' ? home : t.startsWith('~/') ? pm.join(home, t.slice(2)) : pm.resolve(home, t);
};

/**
 * `config.toml` 顶层的 `project_doc_fallback_filenames = [...]`（表头 `[x]` 之后的不算 —— 那是某个 profile 的）。
 * 只认单纯的文件名（codex 对带路径的会说 "ignoring project_doc_fallback_filenames entry that is not a filename"）。
 */
export function parseFallbackFilenames(toml: string): string[] {
  const top: string[] = [];
  for (const line of String(toml || '').split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    top.push(line.replace(/(^|\s)#.*$/, '$1'));
  }
  const m = /(?:^|\n)\s*project_doc_fallback_filenames\s*=\s*\[([\s\S]*?)\]/.exec(top.join('\n'));
  if (!m) return [];
  const out: string[] = [];
  for (const x of m[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
    const n = (x[1] ?? x[2] ?? '').trim();
    if (!n || n === '.' || n === '..' || /[\\/]/.test(n) || out.includes(n)) continue;
    out.push(n);
  }
  return out;
}

async function listClaude(cwd: string | undefined, fsx: InstructionFs): Promise<InstructionEntry[]> {
  const { pm, home } = fsx;
  const key = (p: string) => (pm === path.win32 ? p.toLowerCase() : p);
  /* Claude Code 的配置目录：`CLAUDE_CONFIG_DIR`，没设是 `~/.claude` */
  const userFile = pm.join(dirFromEnv(fsx.env.CLAUDE_CONFIG_DIR, home, pm) || pm.join(home, '.claude'), 'CLAUDE.md');
  const ups = cwd ? ancestorsOf(cwd, pm) : [];
  const sub = cwd ? (await fsx.findBelow(cwd, CLAUDE_SUB_NAMES)).filter(subdirInstructionRel).sort() : [];
  const subPaths = sub.map((rel) => pm.join(cwd!, ...rel.split('/')));
  /* 由远到近（和 Claude Code 拼进上下文的顺序一样：外层在前、工作目录最后） */
  const layers = [...ups].reverse();
  const want = [userFile, ...layers.flatMap((d) => [pm.join(d, 'CLAUDE.md'), pm.join(d, '.claude', 'CLAUDE.md'), pm.join(d, 'CLAUDE.local.md'), pm.join(d, '.git')]), ...subPaths];
  const got = await fsx.probe(want);
  /*
    「未创建」列到哪一层：Claude Code 实际往上找到文件系统根，但每一层都列三个没建的会是一长串
    （`D:\CLAUDE.md` 这种）。按需求说的「到仓库根 / 家目录」：工作目录往上到最近一个有 `.git` 的目录；
    没有仓库就到家目录（工作目录在家目录下时）；都不是就每一层都列。已存在的不受这个限制，照样每层都列。
  */
  const missUpTo = (() => {
    const git = ups.findIndex((d) => got.get(pm.join(d, '.git'))?.exists);
    if (git >= 0) return git;
    const h = ups.findIndex((d) => key(d) === key(pm.resolve(home)));
    return h >= 0 ? h : ups.length - 1;
  })();

  const seen = new Set<string>();
  const base: InstructionEntry[] = [];
  const add = (e: InstructionEntry) => { if (seen.has(key(e.path))) return; seen.add(key(e.path)); base.push(e); };

  add(entryOf(userFile, 'user', got.get(userFile), got.get(userFile)?.exists ? {} : { creatable: true }));
  for (const d of layers) {
    const at = ups.indexOf(d);
    const extra = at === 0 ? {} : { ancestor: true };
    for (const [p, kind] of [[pm.join(d, 'CLAUDE.md'), 'project'], [pm.join(d, '.claude', 'CLAUDE.md'), 'project'], [pm.join(d, 'CLAUDE.local.md'), 'local']] as const) {
      const r = got.get(p);
      if (r?.exists && !r.isDir) add(entryOf(p, kind, r, extra));
      else if (at <= missUpTo) add(entryOf(p, kind, r, { ...extra, creatable: true }));
    }
  }
  for (const p of subPaths) { const r = got.get(p); if (r?.exists && !r.isDir) add(entryOf(p, 'subdir', r)); }

  /* 引用：按层往下探（远端一层一次 ssh），结果挂在引用者后面 */
  const children = new Map<string, InstructionEntry[]>();
  const contents = new Map<string, string>();
  for (const e of base) { const c = got.get(e.path)?.content; if (e.exists && c) contents.set(e.path, c); }
  let frontier = base.filter((e) => e.exists).map((e) => e.path);
  for (let depth = 1; depth < IMPORT_MAX_DEPTH && frontier.length; depth += 1) {
    const pending: Array<{ p: string; by: string }> = [];
    for (const from of frontier) {
      for (const raw of parseImports(contents.get(from) || '')) {
        const p = resolveImport(raw, from, home, pm);
        if (seen.has(key(p))) continue;
        seen.add(key(p));
        pending.push({ p, by: from });
      }
    }
    if (!pending.length) break;
    const r = await fsx.probe(pending.map((x) => x.p));
    const next: string[] = [];
    for (const { p, by } of pending) {
      const pr = r.get(p);
      if (pr?.isDir) continue;   // 目录不是指令文件
      const e = entryOf(p, 'import', pr, { importedBy: by });
      children.set(by, [...(children.get(by) || []), e]);
      if (e.exists) { next.push(p); if (pr?.content) contents.set(p, pr.content); }
    }
    frontier = next;
  }
  const out: InstructionEntry[] = [];
  const walk = (e: InstructionEntry) => { out.push(e); for (const c of children.get(e.path) || []) walk(c); };
  base.forEach(walk);
  return out;
}

async function listCodex(cwd: string | undefined, fsx: InstructionFs): Promise<InstructionEntry[]> {
  const { pm, home } = fsx;
  const codexHome = dirFromEnv(fsx.env.CODEX_HOME, home, pm) || pm.join(home, '.codex');
  const uo = pm.join(codexHome, 'AGENTS.override.md');
  const ua = pm.join(codexHome, 'AGENTS.md');
  const cfg = pm.join(codexHome, 'config.toml');
  const ups = cwd ? ancestorsOf(cwd, pm) : [];
  const got = await fsx.probe([uo, ua, cfg, ...ups.flatMap((d) => [pm.join(d, '.git'), pm.join(d, 'AGENTS.override.md'), pm.join(d, 'AGENTS.md')])]);
  const isFile = (p: string) => !!got.get(p)?.exists && !got.get(p)?.isDir;
  const out: InstructionEntry[] = [];

  /* 用户级：第一个内容非空的生效（空的 override 回退到 AGENTS.md）；两个都是标准位置 */
  const uoLive = isFile(uo) && !isBlank(got.get(uo));
  out.push(entryOf(uo, 'user', got.get(uo), isFile(uo) ? {} : { creatable: true }));
  out.push(entryOf(ua, 'user', got.get(ua), isFile(ua) ? (uoLive ? { shadowedBy: uo } : {}) : { creatable: true }));
  if (!ups.length) return out;

  /* 仓库根：往上最近一个有 `.git`（目录或文件 —— worktree 里是文件）的；没有就只看工作目录 */
  const rootAt = ups.findIndex((d) => got.get(pm.join(d, '.git'))?.exists);
  const dirs = (rootAt >= 0 ? ups.slice(0, rootAt + 1) : ups.slice(0, 1)).reverse();
  const fallbacks = parseFallbackFilenames(got.get(cfg)?.content || '').filter((n) => n !== 'AGENTS.md' && n !== 'AGENTS.override.md');
  const more = fallbacks.length ? await fsx.probe(dirs.flatMap((d) => fallbacks.map((n) => pm.join(d, n)))) : new Map<string, ProbeResult>();
  const res = (p: string) => got.get(p) ?? more.get(p);
  const exists = (p: string) => !!res(p)?.exists && !res(p)?.isDir;

  /* 每层：override → AGENTS.md → 备用文件名，第一个存在的占住这一层（空的也占住） */
  for (const d of dirs) {
    const extra: Partial<InstructionEntry> = d === ups[0] ? {} : { ancestor: true };
    const names = ['AGENTS.override.md', 'AGENTS.md', ...fallbacks];
    const winner = names.map((n) => pm.join(d, n)).find(exists);
    for (const n of names) {
      const p = pm.join(d, n);
      const fb = n !== 'AGENTS.override.md' && n !== 'AGENTS.md';
      if (!exists(p)) { if (!fb) out.push(entryOf(p, 'project', res(p), { ...extra, creatable: true })); continue; }
      out.push(entryOf(p, 'project', res(p), { ...extra, ...(fb ? { fallback: true } : {}), ...(winner && winner !== p ? { shadowedBy: winner } : {}) }));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 本机 */

export function localInstructionFs(home: string, pm: path.PlatformPath = path, env: InstructionFs['env'] = {}): InstructionFs {
  return {
    pm,
    home,
    env,
    async probe(paths) {
      const m = new Map<string, ProbeResult>();
      for (const p of paths) {
        try {
          const st = fs.statSync(p);
          if (st.isDirectory()) { m.set(p, { exists: true, isDir: true, size: 0 }); continue; }
          let content: string | undefined;
          if (st.size <= MAX_CONTENT) { try { content = fs.readFileSync(p, 'utf-8'); } catch { /* 读不了就不解析引用 */ } }
          m.set(p, { exists: true, size: st.size, ...(content !== undefined ? { content } : {}) });
        } catch { m.set(p, { exists: false, size: -1 }); }
      }
      return m;
    },
    async findBelow(cwd, names) {
      const out: string[] = [];
      let budget = 20_000;   // 巨大的目录树不至于把主进程卡住
      const walk = (dir: string, rel: string, depth: number) => {
        if (depth > 4 || budget <= 0) return;
        let ents: fs.Dirent[];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (--budget <= 0) return;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            walk(path.join(dir, e.name), r, depth + 1);
          } else if (e.isFile() && names.includes(e.name)) out.push(r);
        }
      };
      walk(cwd, '', 0);
      return out;
    },
  };
}

/** 写回原文件：同目录临时文件 + rename；目录不存在就建（「未创建」一键新建也走这里）。 */
export function writeInstructionFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.kirolex-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 没写出来 */ }
    throw e;
  }
}

/* ------------------------------------------------------------------ 远程 */

/*
  远端只产出脚本，执行交给调用方（index.ts 的 runRemoteCapture：复用连接、超时）。
  内容走 base64；路径由 `q`（index.ts 的 shellQuote）包单引号。路径里有换行 / 制表符的不问（解析是按行的）。
*/
const safePath = (p: string) => !/[\n\r\t]/.test(p);

/** 会改位置的那几个变量 —— 执行器是 `bash -lc` 起的（`buildRemoteAdapterCommand`），所以从登录 shell 里取 */
const REMOTE_ENV_KEYS = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const;

/** 第一次：报 `$HOME` 和登录 shell 里那几个变量，再在 cwd 下按名字找（剪掉 node_modules / .git，深度和本机那份一样）。 */
export function remoteInitScript(cwd: string, names: string[], q: (s: string) => string): string {
  const byName = names.map((n) => `-name ${q(n)}`).join(' -o ');
  const envs = q(REMOTE_ENV_KEYS.map((k) => `printf 'ENV\\t${k}\\t%s\\n' "$${k}"`).join('; '));
  return `printf 'HOME\\t%s\\n' "$HOME"; bash -lc ${envs} </dev/null 2>/dev/null; cd ${q(cwd)} 2>/dev/null && find . -maxdepth 5 \\( -name node_modules -o -name .git \\) -prune -o -type f \\( ${byName} \\) -printf 'FOUND\\t%P\\n' 2>/dev/null; true`;
}

export function parseRemoteInit(out: string): { home: string; found: string[]; env: InstructionFs['env'] } {
  let home = '';
  const found: string[] = [];
  const env: InstructionFs['env'] = {};
  for (const line of String(out || '').split(/\r?\n/)) {
    const [tag, ...rest] = line.split('\t');
    if (tag === 'HOME') home = rest.join('\t');
    else if (tag === 'FOUND' && rest.length) found.push(rest.join('\t'));
    else if (tag === 'ENV' && (REMOTE_ENV_KEYS as readonly string[]).includes(rest[0]) && rest.slice(1).join('\t').trim()) {
      env[rest[0] as (typeof REMOTE_ENV_KEYS)[number]] = rest.slice(1).join('\t').trim();
    }
  }
  return { home, found, env };
}

/** 一批路径：目录 `D\t路径`、文件 `F\t大小\t路径` + 下一行 base64（≤ 1 MB 才带）、没有 `N\t路径`。 */
export function remoteProbeScript(paths: string[], q: (s: string) => string): string {
  return paths.filter(safePath).map((p) => `p=${q(p)}; if [ -d "$p" ]; then printf 'D\\t%s\\n' "$p"; elif [ -f "$p" ]; then s=$(wc -c < "$p" | tr -d ' '); printf 'F\\t%s\\t%s\\n' "$s" "$p"; if [ "$s" -le ${MAX_CONTENT} ]; then base64 -w0 < "$p"; fi; echo; else printf 'N\\t%s\\n' "$p"; fi`).join('; ');
}

export function parseRemoteProbe(out: string): Map<string, ProbeResult> {
  const lines = String(out || '').split(/\r?\n/);
  const m = new Map<string, ProbeResult>();
  for (let i = 0; i < lines.length; i += 1) {
    const parts = lines[i].split('\t');
    if (parts[0] === 'D' && parts.length >= 2) m.set(parts.slice(1).join('\t'), { exists: true, isDir: true, size: 0 });
    else if (parts[0] === 'N' && parts.length >= 2) m.set(parts.slice(1).join('\t'), { exists: false, size: -1 });
    else if (parts[0] === 'F' && parts.length >= 3) {
      const size = Number(parts[1]) || 0;
      const p = parts.slice(2).join('\t');
      const b64 = (lines[i + 1] || '').trim();
      i += 1;   // 内容那一行（空的也占一行）
      /* 不超过上限的脚本都会发内容 —— 零字节文件那一行就是空的，内容是 ''（不是「没读」，否则空文件会被当成有内容） */
      m.set(p, { exists: true, size, ...(size <= MAX_CONTENT ? { content: b64 ? Buffer.from(b64, 'base64').toString('utf-8') : '' } : {}) });
    }
  }
  return m;
}

/** 远端那台机器的 `InstructionFs`：一次 ssh 拿家目录 + 子目录里的文件，之后每批路径一次 ssh。 */
export async function createRemoteInstructionFs(
  cwd: string | undefined,
  run: (script: string) => Promise<string>,
  q: (s: string) => string,
): Promise<InstructionFs> {
  const init = parseRemoteInit(await run(remoteInitScript(cwd || '/nonexistent', CLAUDE_SUB_NAMES, q)));
  if (!init.home) throw new Error('could not read $HOME on the remote machine');
  return {
    pm: path.posix,
    home: init.home,
    env: init.env,
    async probe(paths) {
      const asked = paths.filter(safePath);
      if (!asked.length) return new Map();
      const m = parseRemoteProbe(await run(remoteProbeScript(asked, q)));
      for (const p of asked) if (!m.has(p)) m.set(p, { exists: false, size: -1 });
      return m;
    },
    async findBelow(_cwd, names) {
      return init.found.filter((rel) => names.includes(rel.split('/').pop() || ''));
    },
  };
}
