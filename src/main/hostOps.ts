/**
 * **"这个文件在哪台机器上"** —— 远程会话（`docs/DESIGN_remote_sessions.md`）的地基。
 *
 * 远程会话把 kiro-cli 跑在另一台机器上。这件事本身 ACP 是透明的（stdio 上的 JSON-RPC，SSH 原样转发），
 * 但 KiroLex 这一年攒下来的**取证能力全是按"kiro-cli 在本机"写的**：
 *
 *   · `cliErrorContext()` 读 `$TMPDIR/kiro-log/kiro-chat.log` —— 那句 `err=EmptyResponse` 的唯一来源
 *   · `trimHugeCliLogs()` 截断同一个目录 —— 那 21.72GB 就是它拦的
 *   · `writeFailureBundle()` 抄 `~/.kiro/sessions/cli/<id>.json{,l}` —— 唯一能看到"后端手里是什么"的东西
 *
 * 这些路径在远程会话里指向的是**本机**，于是三样东西全部读到空 —— 界面上又只剩一句 `Internal error`，
 * 等于把刚建好的诊断能力在远程会话上全部退回原点。所以在它们和文件系统之间插一层：
 * 谁来读、读哪台机器，由 `HostOps` 决定，判据和措辞一个字不动。
 *
 * ## 为什么读写是**异步**的（本地也是）
 *
 * SSH 那一侧必然要起一个子进程，没法同步。而如果本地保留一套同步实现、远端另写一套异步的，
 * 截断循环和尾部读取就会有两份 —— 这类"两份几乎一样的实现"在这个项目里已经咬过一次
 * （`spreadSpanEdit` 和 gate 那边）。所以统一成 async，本地实现内部照旧用同步 `fs`。
 *
 * ## 边界
 *
 * 只有**读诊断**和**截断日志**走这一层。落盘（failure bundle、KiroLex 自己的日志）永远在本地 ——
 * 本地是唯一真相，任何只存在于远端的状态都是 bug。
 */

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RemoteTarget } from './config';
import { sshEnv } from './sshAuth.ts';

export interface FileSize {
  name: string;
  bytes: number;
}

/**
 * 一台机器上"读诊断 + 截断日志"需要的全部能力。
 *
 * 所有方法都**不许抛**：诊断永远不能让发送失败（这条规则在 `failureBundle` / `kiroCliLog` 里
 * 已经写过，这一层继承它）。读不到就返回空，让上层照旧走"没有额外信息"那条路。
 */
export interface HostOps {
  readonly kind: 'local' | 'ssh';
  /** 给人看的名字（`本地` 或 `ec2-user@1.2.3.4`），进错误消息用。 */
  readonly label: string;
  /** 文件尾部最多 `bytes` 字节；读不到返回 `''`。 */
  readTail(file: string, bytes: number): Promise<string>;
  /** 整个文件（上限 `maxBytes`）；读不到返回 `null` —— 和"文件是空的"要分得开。 */
  readAll(file: string, maxBytes: number): Promise<string | null>;
  /** 目录下以 `suffix` 结尾的文件名 + 字节数；目录不在返回 `[]`。 */
  listSizes(dir: string, suffix: string): Promise<FileSize[]>;
  /** **就地截断**（不是删除，见 `kiroCliLog` 里那段 21.72GB 的账）。 */
  truncate(file: string): Promise<void>;
  /** 这台机器的 TMPDIR 和 HOME —— kiro-cli 的日志和会话分别挂在它们下面。 */
  tmpdir(): Promise<string>;
  home(): Promise<string>;
}

/* ------------------------------------------------------------------ 本地 */

export class LocalHost implements HostOps {
  readonly kind = 'local' as const;
  readonly label = '本地';
  /* 显式字段而不是构造器参数属性：测试跑在 node 的 strip-only 模式下，那儿不支持参数属性 */
  private env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  async readTail(file: string, bytes: number): Promise<string> {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - bytes);
        const len = size - start;
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, start);
        return b.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  async readAll(file: string, maxBytes: number): Promise<string | null> {
    try {
      const b = fs.readFileSync(file);
      return b.subarray(0, maxBytes).toString('utf8');
    } catch {
      return null;
    }
  }

  async listSizes(dir: string, suffix: string): Promise<FileSize[]> {
    try {
      return fs.readdirSync(dir)
        .filter((n) => n.endsWith(suffix))
        .map((name) => {
          let bytes = 0;
          try { bytes = fs.statSync(path.join(dir, name)).size; } catch {}
          return { name, bytes };
        });
    } catch {
      return [];
    }
  }

  async truncate(file: string): Promise<void> {
    /* 截断，不是删除 —— 删掉的话持着写 fd 的进程会把空间攥到退出为止 */
    try { fs.truncateSync(file, 0); } catch {}
  }

  async tmpdir(): Promise<string> {
    return this.env.TMPDIR || os.tmpdir();
  }

  async home(): Promise<string> {
    /* `HOME` 优先于 `os.homedir()`：测试要能把"kiro-cli 的会话目录在哪"指到临时目录去，
       而这两个值在真实运行里本来就是同一个。 */
    return this.env.HOME || os.homedir();
  }
}

/* -------------------------------------------------------------------- SSH */

/** SSH 参数的拼法从 `acp-client` 注入 —— 和 `connect()`、`loopVerify` 必须是同一个决策。 */
export interface SshDeps {
  buildSshArgs(remote: RemoteTarget, remoteCommand: string): string[];
  shellQuote(s: string): string;
}

/** 一次诊断 SSH 的上限。取证宁可拿不到，也不能让失败路径挂在这儿。 */
export const SSH_OP_TIMEOUT_MS = 15_000;

export class SshHost implements HostOps {
  readonly kind = 'ssh' as const;
  readonly label: string;
  /** TMPDIR / HOME 一次问清就不会变，缓存掉 —— 每次多一个往返没有意义。 */
  private dirs?: { tmpdir: string; home: string };
  private remote: RemoteTarget;
  private deps: SshDeps;
  private timeoutMs: number;

  constructor(remote: RemoteTarget, deps: SshDeps, timeoutMs: number = SSH_OP_TIMEOUT_MS) {
    this.remote = remote;
    this.deps = deps;
    this.timeoutMs = timeoutMs;
    this.label = remote.sshHost || 'remote';
  }

  /** 跑一条远端命令，拿 stdout；任何失败（连不上、非零退出、超时）都返回 `''`。 */
  private run(script: string): Promise<string> {
    const args = this.deps.buildSshArgs(this.remote, `bash -lc ${this.deps.shellQuote(script)}`);
    return new Promise((resolve) => {
      try {
        execFile('ssh', args, {
          env: sshEnv(this.remote),
          timeout: this.timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          encoding: 'utf8',
        }, (_err, stdout) => resolve(typeof stdout === 'string' ? stdout : ''));
      } catch {
        resolve('');
      }
    });
  }

  async readTail(file: string, bytes: number): Promise<string> {
    const q = this.deps.shellQuote(file);
    return this.run(`tail -c ${Math.max(1, Math.floor(bytes))} ${q} 2>/dev/null || true`);
  }

  async readAll(file: string, maxBytes: number): Promise<string | null> {
    const q = this.deps.shellQuote(file);
    /* `test -f` 先问一句：这样"文件不在"（null）和"文件是空的"（''）分得开 —— failureBundle 靠
       这个区别决定要不要写那一份，否则远端没有的东西会变成一个空文件，看起来像"抄到了但是空的"。 */
    const out = await this.run(`test -f ${q} && head -c ${Math.max(1, Math.floor(maxBytes))} ${q} && printf '\\n__OK__' || printf '__NO__'`);
    if (out.endsWith('__NO__')) return null;
    const at = out.lastIndexOf('\n__OK__');
    return at >= 0 ? out.slice(0, at) : out;
  }

  async listSizes(dir: string, suffix: string): Promise<FileSize[]> {
    const q = this.deps.shellQuote(dir);
    const pat = this.deps.shellQuote(`*${suffix}`);
    /* GNU stat（远端是 Amazon Linux 2023，见设计文档里那张实测表）。一行 `<字节数> <文件名>`。 */
    const out = await this.run(`cd ${q} 2>/dev/null && stat -c '%s %n' ${pat} 2>/dev/null || true`);
    const rows: FileSize[] = [];
    for (const line of out.split('\n')) {
      const m = /^(\d+)\s+(.+)$/.exec(line.trim());
      if (!m) continue;
      rows.push({ name: path.basename(m[2]), bytes: Number(m[1]) });
    }
    return rows;
  }

  async truncate(file: string): Promise<void> {
    /* `truncate -s 0`，**不是 rm** —— 远端同样有"删了但 fd 还在，空间不回来"的问题 */
    await this.run(`truncate -s 0 ${this.deps.shellQuote(file)} 2>/dev/null || true`);
  }

  private async resolveDirs(): Promise<{ tmpdir: string; home: string }> {
    if (this.dirs) return this.dirs;
    const out = await this.run('printf "%s\\n%s\\n" "${TMPDIR:-/tmp}" "$HOME"');
    const [tmp, home] = out.split('\n');
    /* 问不到就给 Linux 的常规值 —— 有个能试的路径强过直接放弃取证 */
    this.dirs = {
      tmpdir: (tmp || '').trim() || '/tmp',
      home: (home || '').trim() || '/home/ec2-user',
    };
    return this.dirs;
  }

  async tmpdir(): Promise<string> {
    return (await this.resolveDirs()).tmpdir;
  }

  async home(): Promise<string> {
    return (await this.resolveDirs()).home;
  }
}

/** 一条会话该用哪台机器读诊断 —— 没有 `remote` 就是本地。 */
export function hostFor(remote: RemoteTarget | undefined, deps: SshDeps, env?: NodeJS.ProcessEnv): HostOps {
  return remote?.sshHost ? new SshHost(remote, deps) : new LocalHost(env);
}

/* ------------------------------------------------- 起执行器的超时按机器分 */

/**
 * `session/load` 的等待上限。
 *
 * 本地 45s 是按"spawn 一个本机进程"估的（一个退役模型会让 kiro-cli 永远不答 initialize，
 * 当时就是这条超时把启动从两分钟拉回来的）。远端还要加上 SSH 握手 + 远端进程冷启动，
 * 用同一个数字会把"只是慢一点"判成"起不来"，然后去做完全没必要的重建。
 */
export const LOAD_TIMEOUT_LOCAL_MS = 45_000;
export const LOAD_TIMEOUT_REMOTE_MS = 90_000;

export function loadTimeoutFor(remote?: RemoteTarget): number {
  return remote?.sshHost ? LOAD_TIMEOUT_REMOTE_MS : LOAD_TIMEOUT_LOCAL_MS;
}
