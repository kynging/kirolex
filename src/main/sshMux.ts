/**
 * **一台机器一条 ssh 连接、一个反向隧道** ——「你应该加的是垃圾清理和重复利用」的后半截。
 *
 * ## 原来是什么样
 *
 * 一条会话 = 一次 `ssh -R <自己的端口>:127.0.0.1:<本地 MCP 端口> host kiro-cli acp`。
 * 也就是 N 条会话 = **N 次 TCP 握手 + N 个反向隧道**，而它们通向的是**同一个**本地 MCP server。
 *
 * ## 为什么 N 个端口从一开始就是多余的
 *
 * 那个远端端口唯一的工作是"能连到你 Mac 上那个 MCP server"。而"你是哪条会话"不是靠端口区分的 ——
 * 是靠 URL 里那个 token（`mcp add` 没有 `--headers`，token 只能放路径，见 `localMcp.ts`）。
 * 一个端口 + N 个 token 就够：
 *
 * ```
 * 远端 39100  ──一条隧道──▶  你 Mac 的 127.0.0.1:<MCP 端口>
 *   会话 A 的 agent JSON： http://127.0.0.1:39100/mcp/<tokenA>
 *   会话 B 的 agent JSON： http://127.0.0.1:39100/mcp/<tokenB>
 * ```
 *
 * ## 这不是省资源，是那次宕机的直接成因
 *
 * 那台 EC2 卡死时的症状是 `Connection timed out during banner exchange` —— banner 交换在密钥交换
 * **之前**，也就是 sshd 连握手都排不上。而 sshd 的 `MaxStartups` 默认 `10:30:100`：**同时**处于
 * "已连上还没认证完"的连接超过 10 个就开始随机丢。开机时 20 条会话一起 attach，每条最多还重试
 * 3 次（`reachability.ts`）—— 那是 60 次并发握手打在一个已经被 85 个孤儿进程占满 CPU 的 sshd 上。
 *
 * 复用之后：**第一条**会话建立唯一那次握手，后面的会话是这条连接上的一个 **channel**
 * （ssh 协议原生支持多路复用），既不占 `MaxStartups` 的槽，也不用重新做密钥交换。
 *
 * ## 为什么是显式的 `-N` master，而不是 `ControlMaster=auto`
 *
 * `auto` 的话，**先连上的那条会话**顺带当 master，隧道挂在它身上。那条会话结束时它的 ssh 退出，
 * 于是**别的会话的工具通道跟着一起断** —— 而它们自己完全不知道，表现是"突然读不到文件了"。
 * 专门起一个不带命令的 `-N` master：没有会话挂在它身上，也就没有哪条会话的生命周期能带走它。
 *
 * ## 隧道没起来就不要起执行器
 *
 * `ExitOnForwardFailure=yes` 留在 master 上：端口占用时宁可 master 起不来、把错误说出去，
 * 也不要起一个"连上了但没有本地工具"的执行器 —— 那种降级是静默的，而模型会把"工具调不通"
 * 解释成"这个文件不存在"。
 */

import { spawn, type ChildProcess } from 'child_process';
import { proxyArgs } from './sshProxy.ts';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

/**
 * **Windows 上没有这条路** ——「看一下有没有 windows 上不能跑的东西」。
 *
 * Win32-OpenSSH **根本没有实现连接多路复用**：`ControlMaster` / `ControlPath` 它不认。
 * 而这个模块的探活是 unix domain socket 形状的（`statSync().isSocket()` +
 * `net.connect(<文件路径>)`，后者在 Windows 上要的是 `\\.\pipe\…` 命名管道），
 * 所以那两个判断在 Windows 上**永远是 false**。
 *
 * 连起来的后果是致命的：`ensureLocalTools` 会 `await sshMux.ensure()`，于是它等满 12 秒、
 * 抛「复用连接没建起来」——**每一条远程会话都起不来**。这是我加复用时引入的回归
 * （复用之前每条会话自己一条 ssh、自己一个 `-R` 端口，在 Windows 上是好的）。
 *
 * 所以这里明确地"不支持"而不是"试试看"：Windows 上 `supported()` 返回 false，
 * 调用方走回**每条会话自己一条连接**那条老路。那条路在 Windows 上一直能用，
 * 只是没有复用带来的好处（sshd 握手次数、端口数）——而那是性能，不是功能。
 *
 * 判据用 `process.platform`，不是"试一次看看行不行"：试的代价是每条会话 12 秒,
 * 而答案是平台决定的、不会变。
 */
export function muxSupported(platform: string = process.platform): boolean {
  return platform !== 'win32';
}

/** 一台机器的标识 —— host + 端口（同一台机器的不同端口是不同的 sshd）。 */
export function muxKey(sshHost: string, sshPort?: number): string {
  return `${String(sshHost || '').trim()}:${sshPort || 22}`;
}

/**
 * 控制 socket 放哪儿。
 *
 * **必须短**：`ControlPath` 最终进的是 `sockaddr_un.sun_path`，macOS 上只有 104 字节
 * （超了 ssh 报 `ControlPath too long`，而那条报错出现在"连接失败"里，看起来像网络问题）。
 * 所以用 host 的 hash 而不是 host 本身 —— `ec2-user@ec2-13-231-…ap-northeast-1.compute.amazonaws.com`
 * 一个就 60 多字节。
 *
 * 目录 0700：socket 谁能连谁就能用这条已认证的连接，等于拿到那台机器的 shell。
 */
/**
 * 控制 socket 所在的目录名。单独拿出来是因为**开机扫垃圾要认它**：
 * master 的命令行里没有 `kirolex-local-`（它不带 `--agent`，见 `masterArgs`），
 * 能认出它的只有 `ControlPath` 这一段。
 */
export const MUX_DIR = 'kirolex-mux';

/**
 * 一条**自己那台**的 master 在 `ps` 里长什么样。
 *
 * 带 owner：一台 Mac 上可能同时跑着 KiroLex 的两份（standard 和 flow），而"只管自己创建的"
 * 这条规矩对 master 一样成立 —— 杀掉别人那份的 master 会把它所有远程会话的工具通道一起带走。
 */
export function muxMarker(owner: string): string {
  return `${MUX_DIR}/${owner}-`;
}

export function controlPath(key: string, owner: string, dir = path.join(os.tmpdir(), MUX_DIR)): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return path.join(dir, `${owner}-${h.toString(16).padStart(8, '0')}`);
}

/**
 * master 的参数：不带命令（`-N`）、后台不要（我们自己拿着这个进程，它退出我们就知道）。
 *
 * `-o ControlPersist=no`：进程活着连接就活着，进程没了连接就没了 —— 我们要的正是这种
 * "一眼能看出它还在不在"的关系。`ControlPersist` 会让 ssh 自己 fork 一个活下去的后台进程，
 * 那之后 KiroLex 手上的 pid 和真正持有隧道的那个就不是同一个了。
 */
export function masterArgs(opts: {
  sshHost: string;
  sshPort?: number;
  identityFile?: string;
  proxyJump?: string;
  socket: string;
  remotePort: number;
  localPort: number;
}): string[] {
  const args = [
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ControlMaster=yes',
    '-o', 'ControlPersist=no',
    '-o', `ControlPath=${opts.socket}`,
    '-R', `127.0.0.1:${opts.remotePort}:127.0.0.1:${opts.localPort}`,
  ];
  if (opts.identityFile) args.push('-i', opts.identityFile);
  if (opts.sshPort && opts.sshPort !== 22) args.push('-p', String(opts.sshPort));
  /* master 是**唯一**真正建连接的那条，跳板必须在它身上 */
  args.push(...proxyArgs({ proxyJump: opts.proxyJump, identityFile: opts.identityFile }));
  args.push(opts.sshHost);
  return args;
}

/**
 * 顺着已有连接跑一条命令的参数。
 *
 * `ControlMaster=no` 是**关键**：不加的话这条 ssh 在 master 不在时会自己变成 master，
 * 而它是带命令的 —— 命令结束连接就没了，于是隧道被一条会话的退出带走。
 * 我们宁可它**直接失败**（`ControlPath` 连不上就报错），因为那时候正确的动作是把 master 拉起来。
 */
export function clientArgs(opts: { sshHost: string; socket: string; remoteCommand: string }): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ControlMaster=no',
    '-o', `ControlPath=${opts.socket}`,
    /*
      走已有连接时**不要**再带这些：`-i` / `-p` / `ConnectTimeout` / `-R` 都是建连接时才有意义的。
      尤其 `-R` —— 隧道已经在 master 上了，再要一遍就是端口冲突。
    */
    opts.sshHost,
    opts.remoteCommand,
  ];
}

/** socket 在不在（`ControlPath` 是个 unix socket 文件）。 */
export function socketExists(socket: string): boolean {
  try { return fs.statSync(socket).isSocket(); } catch { return false; }
}

/**
 * socket 文件在、但对面那条连接已经死了 —— 这种"僵尸 socket"必须能识别。
 *
 * ssh 自己的 `-O check` 要 fork 一个进程；直接去 connect 那个 socket 更快，而且判据一样硬：
 * 连得上说明有人在 listen（master 活着），`ECONNREFUSED` 说明那是个没人管的文件。
 */
export function probeSocket(socket: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!socketExists(socket)) { resolve(false); return; }
    const c = net.connect(socket);
    const done = (ok: boolean): void => { try { c.destroy(); } catch { /* 已经关了 */ } resolve(ok); };
    c.setTimeout(timeoutMs, () => done(false));
    c.on('connect', () => done(true));
    c.on('error', () => done(false));
  });
}

/** 僵尸 socket 要删掉 —— 留着的话下一次 master 会因为"文件已存在"起不来。 */
export function clearStaleSocket(socket: string): void {
  try { fs.unlinkSync(socket); } catch { /* 本来就没有 */ }
}

export interface MuxEntry {
  key: string;
  socket: string;
  remotePort: number;
  localPort: number;
  proc: ChildProcess;
  /** 最后一次 stderr —— master 起不来时原因在这里面。 */
  stderr: string;
}

export interface MuxDeps {
  log(level: 'info' | 'warn', message: string): void;
  /** 本地 MCP server 的端口（懒启动，所以现取）。 */
  localPort(): number;
  /** 这台机器上已经占掉的远端端口（给 `allocateRemotePort`）。 */
  usedRemotePorts(): number[];
  allocateRemotePort(used: Iterable<number>): number;
  owner: string;
  spawnSsh?(args: string[]): ChildProcess;
}

/**
 * **每台机器一条**：拿到那台机器的复用连接（没有就建，僵尸就重建）。
 *
 * 返回的 `remotePort` 是**这台机器共用的**那一个 —— 所有会话的 agent JSON 都写它，
 * 靠各自的 token 区分。这也是为什么"换 agent / 换模型要换端口"那条绕路可以消失了：
 * 端口不再属于任何一条会话，也就不会跟自己抢。
 */
export class SshMux {
  private entries = new Map<string, MuxEntry>();
  private starting = new Map<string, Promise<MuxEntry>>();
  private deps: MuxDeps;
  private dir: string;

  constructor(deps: MuxDeps, dir = path.join(os.tmpdir(), MUX_DIR)) {
    this.deps = deps;
    this.dir = dir;
  }

  /** 这台机器当前那个共用端口（没建连接就没有）。 */
  remotePortFor(key: string): number | undefined {
    return this.entries.get(key)?.remotePort;
  }

  /**
   * **同步**判断这台机器有没有一条可用的连接 —— `buildSshArgs` 是同步的，喂给它的就是这个。
   *
   * 判据只看我们手上那个 master 进程还活着，**不做 socket 探活**（那需要 await）。
   * master 退出时 `exit` 回调会立刻把 entry 删掉，所以这个判断的滞后窗口只有"进程刚死、
   * 事件还没派发"那一瞬 —— 那一瞬里发出去的 ssh 会以"连不上 ControlPath"失败，
   * 而那是一条**明确的错误**，不是静默降级。所以这里宁可快也不要"可能是活的"。
   */
  liveSocketFor(target: { sshHost: string; sshPort?: number }): string | undefined {
    const e = this.entries.get(muxKey(target.sshHost, target.sshPort));
    if (!e) return undefined;
    if (e.proc.killed || e.proc.exitCode !== null) return undefined;
    return e.socket;
  }

  socketFor(key: string): string {
    return controlPath(key, this.deps.owner, this.dir);
  }

  /**
   * 确保这台机器的复用连接在。
   *
   * 并发保护：`starting` 那张表挡的是"开机时 20 条会话同时 attach"—— 没有它的话 20 条
   * 会话会各起一个 master，而第 2 个开始全部因为 socket 已存在而失败，
   * 表现是"只有第一条会话有工具"。
   */
  async ensure(target: { sshHost: string; sshPort?: number; identityFile?: string; proxyJump?: string }): Promise<MuxEntry> {
    /*
      **Windows 上直接说"没有"** —— 见 `muxSupported`。抛出去而不是返回 undefined:
      调用方要据此走"每条会话自己一条连接"那条路，而一个 undefined 很容易被当成
      "还没建好、等一下再看"。
    */
    if (!muxSupported()) throw new Error('MUX_UNSUPPORTED');
    const key = muxKey(target.sshHost, target.sshPort);
    const live = this.entries.get(key);
    if (live && !live.proc.killed && live.proc.exitCode === null && await probeSocket(live.socket)) return live;
    const pending = this.starting.get(key);
    if (pending) return pending;
    const p = this.start(key, target).finally(() => { this.starting.delete(key); });
    this.starting.set(key, p);
    return p;
  }

  private async start(key: string, target: { sshHost: string; sshPort?: number; identityFile?: string; proxyJump?: string }): Promise<MuxEntry> {
    /* 上一次留下的：进程记录先清掉，僵尸 socket 也删 —— 否则 master 会因为"文件已存在"直接退 */
    const old = this.entries.get(key);
    if (old) { try { old.proc.kill(); } catch { /* 已经没了 */ } this.entries.delete(key); }
    const socket = this.socketFor(key);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!(await probeSocket(socket))) clearStaleSocket(socket);

    /*
      端口在这台机器上唯一，而且**跨会话复用**。沿用 `allocateRemotePort` 是为了跟别的
      KiroLex 实例（另一台笔记本连同一台机器）不撞 —— 它只保证"我自己不撞自己"，
      真正的冲突检测还是 `ExitOnForwardFailure`：撞了就起不来，而起不来会被说出来。
    */
    const remotePort = this.deps.allocateRemotePort(this.deps.usedRemotePorts());
    const localPort = this.deps.localPort();
    const args = masterArgs({ ...target, socket, remotePort, localPort });
    const proc = (this.deps.spawnSsh || ((a: string[]) => spawn('ssh', a, { stdio: ['ignore', 'pipe', 'pipe'] })))(args);
    const entry: MuxEntry = { key, socket, remotePort, localPort, proc, stderr: '' };
    proc.stderr?.on('data', (d: Buffer) => {
      const s = d.toString('utf-8').trim();
      if (s) entry.stderr = `${entry.stderr}\n${s}`.slice(-2000);
    });
    proc.on('exit', (code) => {
      /*
        master 没了 = 这台机器上所有会话的工具通道都没了。**必须说出来**：
        静默的话表现是"模型说文件不存在"，而那是这条路上最贵的误导。
      */
      if (this.entries.get(key) === entry) this.entries.delete(key);
      this.deps.log('warn', `${key} 的复用连接退出了（code=${code}）——`
        + `这台机器上的会话会在下一次调用工具时重连。${entry.stderr.trim() ? ` 最后的输出：${entry.stderr.trim()}` : ''}`);
      clearStaleSocket(socket);
    });

    /* 等 socket 真的出现 —— 进程起来了不等于连接建好了，而 client 要的是**连接** */
    const ok = await waitFor(() => probeSocket(socket), 12_000);
    if (!ok) {
      try { proc.kill(); } catch { /* 已经没了 */ }
      throw new Error(`${key} 的复用连接没建起来。${entry.stderr.trim() || '（ssh 没有输出）'}`);
    }
    this.entries.set(key, entry);
    this.deps.log('info', `${key} 复用连接已建立：远端 ${remotePort} → 本地 ${localPort}`
      + `（这台机器上的会话共用这一条，各自用自己的 token）`);
    return entry;
  }

  /** 关掉某台机器的复用连接（那台机器上已经没有会话了）。 */
  close(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    try { e.proc.kill(); } catch { /* 已经没了 */ }
    clearStaleSocket(e.socket);
  }

  /** 退出时全关 —— 留着的话就是下一次启动要扫的垃圾。 */
  closeAll(): void {
    for (const key of [...this.entries.keys()]) this.close(key);
  }

  keys(): string[] { return [...this.entries.keys()]; }
}

/** 轮着等一个条件成立。`probeSocket` 本身就有超时，所以这里间隔可以短。 */
export async function waitFor(check: () => Promise<boolean>, timeoutMs: number, stepMs = 150): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
