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
import os from 'os';
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

/**
 * **永远不同步的东西（凭据）** —— 实测真的发生过：一条 cwd 是 `~` 的远程会话把整个家目录推了上去，
 * 2.6 GB / 49064 个文件，里面有 `.aws/credentials`、`.aws/sso/cache`，以及**连那台机器用的私钥本身**
 * （`kyn-key-tokyo.pem`）。
 *
 * 这一层和"项目目录不该是家目录"（`mirrorRefusal`）是两道闸，都要有：
 * 判断错了目录时凭据不该跟着走，而项目里偶然放了一把 key 时也不该被搬到另一台机器上。
 *
 * 注意**不包括** `.env`：那是项目自己的配置，agent 经常真的需要它，而它本来就在这个项目里。
 * 这里挡的是"不属于这个项目、但恰好在同一棵树下"的凭据。
 */
export const SENSITIVE_EXCLUDES = [
  '.ssh/',
  '.aws/',
  '.gnupg/',
  '.kube/',
  '.docker/',
  '.config/gcloud/',
  '.kirolex/',
  '.netrc',
  '.git-credentials',
  '*.pem',
  'id_rsa*',
  'id_ecdsa*',
  'id_ed25519*',
];

/**
 * **会话目录只推模型真的要读的那部分**。
 *
 * 会话目录（`~/.kirolex/sessions/<id>/`）里除了 `history.md` 和附件，还有 KiroLex 自己的状态：
 * `transcript.jsonl`、`record.json`、`events.jsonl`、`last-injection.md`。实测这些都被推到了远端 ——
 * 模型一个都用不上（它读的是 `history.md` 和 `file:` 引用的附件），而 `record.json` 里还带着这台
 * 远端的配置（sshHost、私钥路径）。不需要的东西不该出现在另一台机器上。
 */
export const SESSION_DIR_EXCLUDES = [
  'transcript.jsonl',
  'record.json',
  'events.jsonl',
  'last-injection.md',
  'loop.json',
  'memory.md',
];

/** 一棵树大到这个程度就不是"一个项目"了 —— 实测家目录是 49064 个文件 / 2.6 GB。 */
export const MAX_MIRROR_FILES = 20000;
export const MAX_MIRROR_BYTES = 1024 * 1024 * 1024;

/**
 * **这个目录能不能当镜像根** —— 返回一句拒绝的理由，或者 `null` = 可以。
 *
 * 为什么要这道闸：同步的目录来自会话的 cwd，而 `~` 起的会话的 cwd 就是家目录。推上去的不只是
 * "很多文件"，而是**凭据 + 十年攒下来的东西**，而且 `--delete` 还会按本地的样子去清远端。
 */
export function mirrorRefusal(
  localDir: string,
  home: string,
  stats?: { files: number; bytes: number },
): string | null {
  /* 根目录不能去尾斜杠 —— `path.resolve('/')` 就是 `/`，一去就变成空串，然后"根目录"这条判据永远不触发 */
  const norm = (p: string): string => {
    const r = path.resolve(p || '');
    return r === '/' ? '/' : r.replace(/\/+$/, '');
  };
  const dir = localDir ? norm(localDir) : '';
  const h = norm(home || '');
  if (!dir) return '没有给出要同步的目录。';
  if (dir === '/') return '不能把根目录当项目同步。';
  if (dir === h) {
    return '远程会话不能把**家目录**当项目 —— 那会把 `~/.aws`、私钥这类东西一起推到远端机器上。'
      + '请在一个具体的项目目录里开远程会话。';
  }
  if (h.startsWith(`${dir}/`)) {
    return `要同步的目录（${dir}）包含你的家目录 —— 太大而且带凭据。请选一个具体的项目目录。`;
  }
  if (stats && stats.files > MAX_MIRROR_FILES) {
    return `这个目录有 ${stats.files} 个文件（上限 ${MAX_MIRROR_FILES}）—— 不像一个项目。`
      + '要么换个更小的目录，要么在排除列表里加上占大头的那些。';
  }
  if (stats && stats.bytes > MAX_MIRROR_BYTES) {
    return `这个目录有 ${(stats.bytes / 2 ** 30).toFixed(1)} GB（上限 ${(MAX_MIRROR_BYTES / 2 ** 30).toFixed(0)} GB）——`
      + '同步一次要很久，而且每一轮都要扫一遍。请换个更小的目录或者补排除项。';
  }
  return null;
}

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

/**
 * **rsync 自己的 I/O 超时** —— 实测的事故：KiroLex 被杀掉之后，正在跑的 rsync **没死**
 * （父进程一走它就被 launchd 收养，`ppid=1`），继续把 6.1 GB 推了上去，
 * 而且没有任何人会读它的结果。它还顺手把上行带宽吃光，于是别的会话看起来"也挂了"。
 *
 * `--timeout` 是最后一道兜底：没人喂它数据/它推不动的时候自己退出，而不是永远跑下去。
 * 主动那一道在 `app.before-quit` 里（退出前掐掉所有在跑的同步）。
 */
export const RSYNC_IO_TIMEOUT_SEC = 300;

function commonArgs(spec: SyncSpec): string[] {
  /* 敏感项**永远**并进去：调用方给了自定义排除列表也不能把它们去掉 */
  const ex = [...new Set([...(spec.excludes ?? DEFAULT_EXCLUDES), ...SENSITIVE_EXCLUDES])];
  return [
    '-e', spec.sshCommand,
    `--timeout=${RSYNC_IO_TIMEOUT_SEC}`,
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

/** 快照里有多少文件、多少字节（闸门用）。 */
export function snapshotStats(snap: Snapshot): { files: number; bytes: number } {
  let bytes = 0;
  const keys = Object.keys(snap || {});
  for (const k of keys) bytes += Number(String(snap[k]).split(':')[0]) || 0;
  return { files: keys.length, bytes };
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
  /** `signal`：给"停止"用 —— 一次同步可能跑几分钟，人按 Stop 时它必须真的停下来。 */
  run(file: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<RunResult>;
}

/** 真跑 rsync 的那一层（注入进来是为了能不碰网络做测试）。 */
export const realIo: MirrorIo = {
  run(file, args, timeoutMs, signal) {
    return new Promise((resolve) => {
      execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', signal },
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
  /** 正在跑的那次同步 —— 「停止」要能真的把 rsync 掐掉，而不只是让界面显示已停止。 */
  private inFlight?: AbortController;

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

  /** 掐掉正在跑的那次同步（没有在跑时什么都不做）。 */
  cancel(): void {
    try { this.inFlight?.abort(); } catch { /* 已经结束了 */ }
    this.inFlight = undefined;
  }

  /** 跑一条命令，并把它登记成"正在跑的那一个"，这样 `cancel()` 掐得到。 */
  private async runCancellable(file: string, args: string[], timeoutMs: number): Promise<RunResult> {
    const ac = new AbortController();
    this.inFlight = ac;
    try {
      return await this.io.run(file, args, timeoutMs, ac.signal);
    } finally {
      if (this.inFlight === ac) this.inFlight = undefined;
    }
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
    /*
      **两步过闸，顺序有讲究**：
        ① 先看路径（家目录 / 根目录）—— 这一步不碰磁盘。放在扫快照之前，因为扫家目录本身就要几十秒
           （实测 49064 个文件扫了 52 秒），而结论早就定了：不传。
        ② 再扫快照，然后看大小。
      实测过一次把整个家目录推上去的事故（`.aws/credentials` 和私钥都在里面），所以这两道闸
      都在 rsync **之前**。
    */
    const pathRefusal = mirrorRefusal(this.localDir, os.homedir());
    if (pathRefusal) return { ok: false, error: pathRefusal, snapshot: {}, ms: Date.now() - t0 };
    const snapshot = snapshotDir(this.localDir, this.excludes);
    const refusal = mirrorRefusal(this.localDir, os.homedir(), snapshotStats(snapshot));
    if (refusal) return { ok: false, error: refusal, snapshot, ms: Date.now() - t0 };
    /* 目标目录可能还不存在：rsync 会自己建最后一级，但父目录要在 */
    await this.io.run('ssh', [...this.sshOptsForPlainSsh(), this.remote.sshHost || '',
      `mkdir -p ${shq(this.remoteDir)}`], 60_000);
    const r = await this.runCancellable('rsync', pushArgs(this.spec()), SYNC_TIMEOUT_MS);
    this.lastPush = snapshot;
    return {
      ok: r.code === 0,
      error: r.code === 0 ? undefined : rsyncError(r.stderr, r.code),
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
    /*
      **本地没改过 → 不可能有冲突 → 省掉那趟 dry-run。**
      冲突的定义是"两边都改了同一个文件"，所以本地这半边只要没动过，结论就已经定了。
      一趟 rsync 就是一次 SSH 握手（实测拉一次 5–7 秒，两趟就是双倍），而"这一轮什么都没改"
      恰恰是最常见的情况 —— 纯生成的任务一个文件都不动。
    */
    const changedBefore = this.lastPush
      ? locallyChanged(this.lastPush, snapshotDir(this.localDir, this.excludes))
      : [];
    if (!changedBefore.length) {
      const only = await this.runCancellable('rsync', pullArgs(this.spec()), SYNC_TIMEOUT_MS);
      if (only.code !== 0) {
        return { ok: false, error: rsyncError(only.stderr, only.code), changed: [], conflicts: [], ms: Date.now() - t0 };
      }
      this.lastPush = snapshotDir(this.localDir, this.excludes);
      /* 没有 dry-run 就不知道**具体**哪些文件被写了 —— 这个信息只用来写日志，不值一趟往返 */
      return { ok: true, changed: [], conflicts: [], ms: Date.now() - t0 };
    }
    const dry = await this.runCancellable('rsync', pullArgs(this.spec({ dryRun: true })), SYNC_TIMEOUT_MS);
    if (dry.code !== 0) {
      return { ok: false, error: rsyncError(dry.stderr, dry.code), changed: [], conflicts: [], ms: Date.now() - t0 };
    }
    const incoming = parseIncoming(dry.stdout);
    const conflicts = conflictsBetween(incoming, changedBefore);

    const real = await this.runCancellable('rsync', pullArgs(this.spec({ skip: conflicts })), SYNC_TIMEOUT_MS);
    if (real.code !== 0) {
      return { ok: false, error: rsyncError(real.stderr, real.code), changed: [], conflicts, ms: Date.now() - t0 };
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

/**
 * rsync 失败时那句给人看的话。
 *
 * **必须挡掉 SSH 的后量子告警**：它每次都在、而且是 stderr 的**第一行**，所以原来那句
 * "取第一行"报出来的是
 *   `项目镜像没同步上去（** WARNING: connection is not using a post-quantum key exchange algorithm.）`
 * —— 一句和失败毫无关系的话，而真正的原因被丢掉了（实测踩到，查了一圈才发现）。
 * 同一个坑在 `remotePreflight` 里已经挡过一次，这里漏了。
 */
export function rsyncError(stderr: string, code: number | null): string {
  const noise = /post-quantum|store now, decrypt later|openssh\.com|^\*\*/;
  const real = String(stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !noise.test(l))[0];
  /* 退出码**永远**带上：rsync 的退出码是可查的（23 = 部分文件传不了，255 = ssh 断了），
     而"只有一句话、没有码"在事后根本没法定位。 */
  return real ? `${real}（rsync exit ${code}）` : `rsync exit ${code}`;
}

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
