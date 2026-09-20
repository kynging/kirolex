/**
 * **文件在本地，执行在远端** —— 远程会话的镜像与同步（`docs/DESIGN_remote_sessions.md`）。
 *
 * 为什么必须搬文件：实测 kiro-cli **不用** ACP 的客户端 fs 能力（客户端声明了
 * `fs.readTextFile/writeTextFile` 之后让它读文件，它自己读，回调客户端 **0 次**，
 * `initialize` 回的 agentCapabilities 里也没有 fs）。也就是说远端的执行器只能看见远端的文件系统，
 * 「让远端进程读本地文件」这条路不存在。于是：**本地是唯一真相，远端是一份随时可弃的镜像。**
 *
 * ## 同步点（跟着一轮对话走，不是常驻监听）
 *
 *   ① 发 prompt 之前      本地 → 远端（`--delete`）   推不上去就**不发这一轮**
 *   ② 一轮结束            远端 → 本地
 *   ③ 工具写了文件（防抖） 远端 → 本地                让 review/gate 看起来是活的
 *   ④ review 渲染之前     远端 → 本地（按需）        拿旧文件做 review 比不做更糟
 *
 * ## 两个方向的规则**不对称**，这是故意的
 *
 * · 推：带 `--delete`。本地是真相，镜像必须和它一模一样，多出来的东西要清掉（清的是镜像，安全）。
 * · 拉：**不带 `--delete`**。你在这一轮进行中新建的本地文件，不该因为远端没有就被删掉 ——
 *   那是真实的数据丢失。代价是远端的删除/改名会在本地留下旧文件；镜像里 `.git` 是同步的，
 *   所以 `git status` 会把它显出来，这个取舍比"可能删掉你刚写的东西"好得多。
 *
 * ## 冲突：只有一种，实测确认过判法
 *
 * 唯一的冲突窗口是"一轮正在远端跑的时候你改了同一个文件"。判法是 `rsync --dry-run --itemize-changes`
 * 列出**这次拉会写哪些文件**，和"自推送以来本地变过的文件"求交集。实测（openrsync 2.6.9 兼容
 * ↔ 远端 rsync 3.4.0）输出就是这个形状：
 *
 * ```
 * >f.st....  a.txt    ← 远端改的，本地没动 → 直接覆盖，安全
 * >f.st....  c.txt    ← 本地也改过       → 冲突：远端那份落成 c.txt.remote，不动你的
 * >f+++++++  d.txt    ← 远端新建
 * .d..t....  ./       ← 目录，不算
 * ```
 *
 * 不做三方合并：单人单机，把两份都留住、让人自己看，比自动合并出一个谁都没写过的版本可靠。
 */

import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { RemoteTarget } from './config';

/**
 * 默认不同步什么。
 *
 * `node_modules/` 不是"太大"的问题，是**错的**：本地 617MB 里有 darwin 的原生二进制，拷到 Linux
 * 上不能用。所以远程会话不做构建/测试（设计文档「明确不做的事」）。
 * `.git/` 反过来**要**同步（只有 9.9MB）—— 没有它，agent 的 `git status/diff/log` 全废，
 * 它会当场开始瞎猜。
 */
export const DEFAULT_EXCLUDES = [
  'node_modules/',
  'build/',
  'dist/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.next/',
  'target/',
  '*.log',
  '.DS_Store',
];

/** 一次全量同步的上限。第一次推一个大仓库可能真的要几分钟，不能拿秒级超时去卡它。 */
export const SYNC_TIMEOUT_MS = 10 * 60 * 1000;

/* --------------------------------------------------------------- 路径推导 */

/**
 * 本地目录在远端镜像成哪个目录。
 *
 * 名字里带一段本地**绝对路径的哈希**：`~/code/blog` 和 `~/work/blog` 的 basename 一样，
 * 只用 basename 会把两个项目叠到同一个镜像里，而那种错误的表现是"文件莫名其妙变成了另一个项目的"。
 */
export function mirrorDirFor(remoteWorkdir: string, localDir: string): string {
  const base = path.basename(localDir).replace(/[^\w.@-]+/g, '_') || 'project';
  const h = crypto.createHash('sha1').update(localDir).digest('hex').slice(0, 8);
  return posixJoin(remoteWorkdir, `${base}-${h}`);
}

/**
 * 会话目录（`history.md`、附件）在远端的镜像位置。
 *
 * 它在**项目目录之外**（本地是 `~/.kirolex/sessions/<id>/`），所以必须单独推一份 ——
 * 否则远端的模型拿到的 `file:` 引用会指向一个不存在的路径，而那种失败看起来像"模型无视了附件"。
 */
export function sessionMirrorDir(remoteWorkdir: string, sessionId: string): string {
  return posixJoin(remoteWorkdir, '.kirolex-sessions', sessionId);
}

/** 远端一律 POSIX 路径（设计文档：不支持 Windows 远端）。 */
export function posixJoin(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter((p) => p !== '')
    .join('/');
}

/**
 * 本地路径 → 远端镜像路径。落在 `localRoot` 之外的原样返回（调用方要能看出没映射成功）。
 */
export function mapIntoMirror(localRoot: string, mirrorRoot: string, p: string): string {
  const rel = path.relative(localRoot, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return p;
  return posixJoin(mirrorRoot, rel.split(path.sep).join('/'));
}

/* ------------------------------------------------------------- rsync 拼参 */

/** `rsync -e` 那一串：和执行器、`loopVerify` 用的是同一套 SSH 选项。 */
export function sshCommandFor(remote: RemoteTarget, buildSshArgs: (r: RemoteTarget, cmd: string) => string[]): string {
  /* 借 buildSshArgs 拿到选项，再把末尾的 host 和远端命令去掉 —— rsync 自己会接上 host。
     这样 SSH 选项只有一个来源：三处各写一遍，迟早分叉，而分叉的那处就是"连不上又说不清为什么"。 */
  const args = buildSshArgs(remote, '\u0000CMD\u0000');
  const cut = args.findIndex((a) => a === '\u0000CMD\u0000');
  const opts = (cut >= 0 ? args.slice(0, cut) : args).filter((a) => a !== remote.sshHost);
  return ['ssh', ...opts].join(' ');
}

export interface SyncSpec {
  remote: RemoteTarget;
  localDir: string;
  remoteDir: string;
  excludes?: string[];
  /** 推的时候要（镜像必须和本地一模一样）；拉的时候**绝不要**（见文件头那段）。 */
  deleteExtra?: boolean;
  dryRun?: boolean;
  /** 这一次额外排除的相对路径（冲突文件：不能让它覆盖你的本地版本）。 */
  skip?: string[];
  sshCommand: string;
}

/** 推：本地 → 远端。 */
export function pushArgs(spec: SyncSpec): string[] {
  return [
    '-a',
    ...(spec.deleteExtra === false ? [] : ['--delete']),
    ...commonArgs(spec),
    `${trailSlash(spec.localDir)}`,
    `${spec.remote.sshHost}:${trailSlash(spec.remoteDir)}`,
  ];
}

/** 拉：远端 → 本地。**没有** `--delete`。 */
export function pullArgs(spec: SyncSpec): string[] {
  return [
    '-a',
    ...(spec.dryRun ? ['--dry-run', '--itemize-changes', '--out-format=%i %n'] : []),
    ...commonArgs(spec),
    `${spec.remote.sshHost}:${trailSlash(spec.remoteDir)}`,
    `${trailSlash(spec.localDir)}`,
  ];
}

function commonArgs(spec: SyncSpec): string[] {
  const ex = spec.excludes ?? DEFAULT_EXCLUDES;
  return [
    '-e', spec.sshCommand,
    ...ex.flatMap((p) => ['--exclude', p]),
    /* 冲突文件这一次不许被覆盖；`/` 开头 = 只匹配同步根下的这一条，不是"任何同名文件" */
    ...(spec.skip || []).flatMap((p) => ['--exclude', `/${p}`]),
  ];
}

function trailSlash(p: string): string {
  return p.endsWith('/') ? p : `${p}/`;
}

/**
 * 解析 `--itemize-changes` 的输出，只要**这次会写进来的文件**。
 *
 * `>f...` 是"收到一个文件"（`>` 收、`f` 普通文件）。目录（`.d`/`cd`）和纯属性变更要排除掉：
 * 把目录算成冲突会让"你改了任何一个文件"都变成一屏噪音。
 */
export function parseIncoming(out: string): string[] {
  const rows: string[] = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^([<>ch.][fdLDS][^\s]*)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1][0] !== '>' || m[1][1] !== 'f') continue;
    rows.push(m[2].trim());
  }
  return rows;
}

/* ------------------------------------------------------- 快照 / 冲突判定 */

/** 相对路径 → `size:mtimeMs`。只用来回答"这个文件自推送以来变过没有"。 */
export type Snapshot = Record<string, string>;

/** 排除判据：支持 `dir/`、`*.ext`、以及原样的名字。和 rsync 的规则对齐到够用为止。 */
export function isExcluded(rel: string, excludes: string[] = DEFAULT_EXCLUDES): boolean {
  const parts = rel.split('/');
  for (const raw of excludes) {
    const p = raw.replace(/^\/+/, '');
    if (p.endsWith('/')) {
      const dir = p.slice(0, -1);
      if (parts.slice(0, -1).includes(dir)) return true;
      continue;
    }
    if (p.startsWith('*.')) {
      if (rel.endsWith(p.slice(1))) return true;
      continue;
    }
    if (parts.includes(p)) return true;
  }
  return false;
}

/** 走一遍本地目录。符号链接不跟（跟进去可能走出这个项目，也可能绕圈）。 */
export function snapshotDir(dir: string, excludes: string[] = DEFAULT_EXCLUDES): Snapshot {
  const out: Snapshot = {};
  const walk = (abs: string, rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (isExcluded(e.isDirectory() ? `${childRel}/x` : childRel, excludes)) continue;
      const childAbs = path.join(abs, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(childAbs, childRel); continue; }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(childAbs);
        out[childRel] = `${st.size}:${Math.round(st.mtimeMs)}`;
      } catch {}
    }
  };
  walk(dir, '');
  return out;
}

/** 自推送以来本地变过（或新增）的文件。删掉的不算 —— 拉不会把它变回来（没有 `--delete`）。 */
export function locallyChanged(before: Snapshot, after: Snapshot): string[] {
  return Object.keys(after).filter((k) => before[k] !== after[k]).sort();
}

/**
 * 冲突 = 这次拉会写的 ∩ 自推送以来本地变过的。
 *
 * 两边都得满足：只有远端改（常态，直接覆盖）不是冲突，只有本地改（远端没碰）也不是 ——
 * 判宽了会把每一轮正常的编辑都报成冲突，然后人就不看这个提示了。
 */
export function conflictsBetween(incoming: string[], changed: string[]): string[] {
  const set = new Set(changed);
  return incoming.filter((p) => set.has(p)).sort();
}

/** 冲突时远端那份落在哪 —— 不动你的文件，把另一份放在旁边。 */
export function conflictCopyPath(localDir: string, rel: string): string {
  return path.join(localDir, `${rel}.remote`);
}

/* ------------------------------------------------------------------- 执行 */

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface MirrorIo {
  run(file: string, args: string[], timeoutMs: number): Promise<RunResult>;
}

/** 真跑 rsync 的那一层（注入进来是为了能不碰网络做测试）。 */
export const realIo: MirrorIo = {
  run(file, args, timeoutMs) {
    return new Promise((resolve) => {
      execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
        (err: any, stdout, stderr) => resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        }));
    });
  },
};

export interface PushResult {
  ok: boolean;
  error?: string;
  snapshot: Snapshot;
  ms: number;
}

export interface PullResult {
  ok: boolean;
  error?: string;
  /** 这次从远端写下来的文件（相对路径）。 */
  changed: string[];
  /** 冲突：你的版本留着，远端那份落在 `<file>.remote`。 */
  conflicts: string[];
  ms: number;
}

/**
 * 一个项目目录的镜像。一条远程会话一个实例（会话目录那一份也用它，只是 dir 不同）。
 */
export class RemoteMirror {
  readonly localDir: string;
  readonly remoteDir: string;
  private remote: RemoteTarget;
  private io: MirrorIo;
  private excludes: string[];
  private sshCommand: string;
  /** 最近一次推送时的本地快照 —— 冲突判定的另一半。 */
  private lastPush?: Snapshot;

  constructor(opts: {
    remote: RemoteTarget;
    localDir: string;
    remoteDir: string;
    sshCommand: string;
    io?: MirrorIo;
    excludes?: string[];
  }) {
    this.remote = opts.remote;
    this.localDir = opts.localDir;
    this.remoteDir = opts.remoteDir;
    this.sshCommand = opts.sshCommand;
    this.io = opts.io || realIo;
    this.excludes = opts.excludes || DEFAULT_EXCLUDES;
  }

  private spec(extra: Partial<SyncSpec> = {}): SyncSpec {
    return {
      remote: this.remote,
      localDir: this.localDir,
      remoteDir: this.remoteDir,
      excludes: this.excludes,
      sshCommand: this.sshCommand,
      ...extra,
    };
  }

  /**
   * 本地 → 远端。**失败必须让调用方不发这一轮** —— 让模型读着旧文件干活，
   * 产出的东西看起来是对的、其实是对着上一版写的，那种错最难发现。
   */
  async push(): Promise<PushResult> {
    const t0 = Date.now();
    const snapshot = snapshotDir(this.localDir, this.excludes);
    /* 目标目录可能还不存在：rsync 会自己建最后一级，但父目录要在 */
    await this.io.run('ssh', [...this.sshOptsForPlainSsh(), this.remote.sshHost || '',
      `mkdir -p ${shq(this.remoteDir)}`], 60_000);
    const r = await this.io.run('rsync', pushArgs(this.spec()), SYNC_TIMEOUT_MS);
    this.lastPush = snapshot;
    return {
      ok: r.code === 0,
      error: r.code === 0 ? undefined : firstLine(r.stderr) || `rsync exit ${r.code}`,
      snapshot,
      ms: Date.now() - t0,
    };
  }

  /**
   * 远端 → 本地。先 dry-run 看会动哪些，和"本地变过的"求交集分流冲突，
   * 然后正式拉（冲突文件排除），最后把远端那几份单独取成 `<file>.remote`。
   */
  async pull(): Promise<PullResult> {
    const t0 = Date.now();
    const dry = await this.io.run('rsync', pullArgs(this.spec({ dryRun: true })), SYNC_TIMEOUT_MS);
    if (dry.code !== 0) {
      return { ok: false, error: firstLine(dry.stderr) || `rsync --dry-run exit ${dry.code}`, changed: [], conflicts: [], ms: Date.now() - t0 };
    }
    const incoming = parseIncoming(dry.stdout);
    const changed = this.lastPush ? locallyChanged(this.lastPush, snapshotDir(this.localDir, this.excludes)) : [];
    const conflicts = conflictsBetween(incoming, changed);

    const real = await this.io.run('rsync', pullArgs(this.spec({ skip: conflicts })), SYNC_TIMEOUT_MS);
    if (real.code !== 0) {
      return { ok: false, error: firstLine(real.stderr) || `rsync exit ${real.code}`, changed: [], conflicts, ms: Date.now() - t0 };
    }
    for (const rel of conflicts) {
      /* 一个文件一条命令：冲突本来就少（单人单机），换来的是路径完全明确、不需要临时目录 */
      await this.io.run('rsync', [
        '-a', '-e', this.sshCommand,
        `${this.remote.sshHost}:${posixJoin(this.remoteDir, rel)}`,
        conflictCopyPath(this.localDir, rel),
      ], SYNC_TIMEOUT_MS);
    }
    /* 拉完之后重新记一次快照：下一轮的"本地变过没有"要从**这个**状态起算，
       否则刚拉下来的那些文件会在下一轮被当成"你改的"，然后每个都报成冲突。 */
    this.lastPush = snapshotDir(this.localDir, this.excludes);
    return {
      ok: true,
      changed: incoming.filter((p) => !conflicts.includes(p)),
      conflicts,
      ms: Date.now() - t0,
    };
  }

  /** `ssh` 直接调用时的选项（`sshCommand` 是给 rsync 的一整串）。 */
  private sshOptsForPlainSsh(): string[] {
    return this.sshCommand.split(' ').slice(1).filter(Boolean);
  }
}

function firstLine(s: string): string {
  return String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
}

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
