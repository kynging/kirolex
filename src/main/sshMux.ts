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
import { proxyArgs, assertSafeSshHost } from './sshProxy.ts';
import { batchModeFor, sshEnv } from './sshAuth.ts';
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
  passwordCipher?: string;
  socket: string;
  remotePort: number;
  localPort: number;
}): string[] {
  assertSafeSshHost(opts.sshHost);
  const args = [
    '-N',
    '-o', batchModeFor(opts),
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
  /* 和 buildSshArgs 同一条：密码错了就失败，别让 askpass 用同一个答案被问三次 */
  if (opts.passwordCipher) args.push('-o', 'NumberOfPasswordPrompts=1');
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

/**
 * 自愈的退避表（毫秒）。前密后疏：网络抖一下几秒就好，机器真没了不该每 2 秒敲门。
 * 到顶之后保持 60 秒一次，**不放弃** —— 见 `scheduleHeal`。
 */
export const HEAL_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

export interface MuxDeps {
  log(level: 'info' | 'warn', message: string): void;
  /** 本地 MCP server 的端口（懒启动，所以现取）。 */
  localPort(): number;
  /** 这台机器上已经占掉的远端端口（给 `allocateRemotePort`）。 */
  usedRemotePorts(): number[];
  allocateRemotePort(used: Iterable<number>): number;
  owner: string;
  spawnSsh?(args: string[]): ChildProcess;
  /**
   * 这台机器上还有会话吗 —— 自愈的**唯一**判据（见 `scheduleHeal`）。
   *
   * 没有它的话只有两个选择：永远重连（机器关了也在那敲门），或者永不重连
   * （就是实测撞到的那个：master 以 255 退出之后没有东西再试，7 条会话一直挂在
   * "没有本地工具"的状态上）。
   */
  hasSessions(key: string): boolean;
  /**
   * master 重新建好了。调用方据此把那台机器上"连着但没有工具"的会话重新备一次 ——
   * 光把 master 拉回来**不够**：执行器是在 `localTools` 为 undefined 时起的，
   * 它那条 kiro-cli 根本没被配上本地 MCP，端口回来了也用不上。
   */
  onReady?(key: string): void;
  /**
   * 等 socket 出现的上限（毫秒，默认 12 秒）。
   *
   * 做成可注入的**只为测试**：真机上这个值要够大（跨洋 ssh 握手 + 跳板两跳），
   * 而测试里没有真 socket，照 12 秒等就是让整个测试套慢 12 秒。
   */
  socketWaitMs?: number;
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
  /** 希望活着的那些机器 —— `close()` 把它摘掉，自愈只对这里面的生效。 */
  private wanted = new Set<string>();
  /** 正在排的自愈定时器 + 已经试了几次（退避用）。 */
  private healTimers = new Map<string, NodeJS.Timeout>();
  private healAttempts = new Map<string, number>();
  /** 最后一次用过的目标（自愈时要用同一把钥匙、同一个跳板）。 */
  private lastTarget = new Map<string, { sshHost: string; sshPort?: number; identityFile?: string; proxyJump?: string }>();
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
  async ensure(target: { sshHost: string; sshPort?: number; identityFile?: string; proxyJump?: string; passwordCipher?: string }): Promise<MuxEntry> {
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
    /* 记下"这台机器该有一条连接"——自愈只对 wanted 的生效 */
    this.wanted.add(key);
    this.lastTarget.set(key, { ...target });
    const p = this.start(key, target).finally(() => { this.starting.delete(key); });
    this.starting.set(key, p);
    return p;
  }

  /**
   * **master 死了要自己回来** ——「远程会话现在碰不到你机器上的文件」。
   *
   * 实测那次：3 小时里 master 以 `code=255` 退了 7 次（触发源是笔记本的 VPN 在抖），
   * 最后一次之后**没有任何东西再试** —— 原来那句日志写的是"会话会在下一次调用工具时重连"，
   * 可是那条路只在**新的 attach** 上走，已经连着的会话不会再调 `ensure()`。
   * 于是 7 条会话一直挂在"执行器活着、本地工具是死的"状态上。
   *
   * 退避表是刻意前密后疏：网络抖一下通常几秒就好，而机器真没了就不该每 2 秒敲一次门。
   * 到顶之后保持 60 秒一次 —— **不放弃**，因为"机器还有会话"这个判据本身就意味着
   * 用户还要用它；放弃等于把那几条会话永久留在没有工具的状态。
   */
  private scheduleHeal(key: string): void {
    if (!this.wanted.has(key)) return;              // 已经 close 过了
    if (this.healTimers.has(key)) return;           // 已经排了
    if (!this.deps.hasSessions(key)) {
      /* 没有会话就不敲门。等下一次 attach 自然会 `ensure()` */
      this.wanted.delete(key);
      this.healAttempts.delete(key);
      return;
    }
    const n = this.healAttempts.get(key) || 0;
    const delay = HEAL_BACKOFF_MS[Math.min(n, HEAL_BACKOFF_MS.length - 1)];
    this.healAttempts.set(key, n + 1);
    const t = setTimeout(() => {
      this.healTimers.delete(key);
      if (!this.wanted.has(key) || !this.deps.hasSessions(key)) return;
      const target = this.lastTarget.get(key);
      if (!target) return;
      this.deps.log('info', `${key} 尝试重建复用连接（第 ${n + 1} 次）`);
      void this.ensure(target).then(
        () => { /* ensure 成功时会清掉退避计数并通知调用方 */ },
        (err: any) => {
          this.deps.log('warn', `${key} 重建失败：${err?.message || err}`);
          this.scheduleHeal(key);
        },
      );
    }, delay);
    /* `unref` 是必须的：否则这个定时器会让 Electron 的退出挂住 */
    t.unref?.();
    this.healTimers.set(key, t);
  }

  private async start(key: string, target: { sshHost: string; sshPort?: number; identityFile?: string; proxyJump?: string; passwordCipher?: string }): Promise<MuxEntry> {
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
    const proc = (this.deps.spawnSsh || ((a: string[]) => spawn('ssh', a, { stdio: ['ignore', 'pipe', 'pipe'], env: sshEnv(target) })))(args);
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
      /*
        原来这里写的是"会话会在下一次调用工具时重连"，那句话**不是实话**：重连只发生在
        新的 attach 上，已经连着的会话不会再调 `ensure()`。实测后果是 7 条会话一直挂在
        "执行器活着、本地工具是死的"状态上。所以现在自己排重建。
      */
      this.deps.log('warn', `${key} 的复用连接退出了（code=${code}）——`
        + `这台机器上的会话暂时读不到你机器上的文件，正在排重建。`
        + `${entry.stderr.trim() ? ` 最后的输出：${entry.stderr.trim()}` : ''}`);
      clearStaleSocket(socket);
      this.scheduleHeal(key);
    });

    /* 等 socket 真的出现 —— 进程起来了不等于连接建好了，而 client 要的是**连接** */
    const ok = await waitFor(() => probeSocket(socket), this.deps.socketWaitMs ?? 12_000);
    if (!ok) {
      try { proc.kill(); } catch { /* 已经没了 */ }
      /*
        **建不起来也要排重建** —— 这正是实测撞到的那个口子：14:19 那次 12 秒等超时之后
        没有任何东西再试（当时网络还在抖），于是会话永久没有工具。
      */
      this.scheduleHeal(key);
      throw new Error(`${key} 的复用连接没建起来。${entry.stderr.trim() || '（ssh 没有输出）'}`);
    }
    this.entries.set(key, entry);
    this.healAttempts.delete(key);          // 建好了，退避从头算
    this.deps.log('info', `${key} 复用连接已建立：远端 ${remotePort} → 本地 ${localPort}`
      + `（这台机器上的会话共用这一条，各自用自己的 token）`);
    /*
      **光把 master 拉回来不够**：执行器是在 `localTools` 为 undefined 时起的，
      它那条 kiro-cli 没被配上本地 MCP，端口回来了也用不上。所以要通知调用方
      去把"连着但没有工具"的会话重新备一次。
    */
    try { this.deps.onReady?.(key); } catch { /* 通知失败不该影响连接本身 */ }
    return entry;
  }

  /** 关掉某台机器的复用连接（那台机器上已经没有会话了）。 */
  close(key: string): void {
    /* 先摘 wanted 再杀进程：顺序反了的话 exit 处理会给一台已经不要的机器排重建 */
    this.wanted.delete(key);
    this.healAttempts.delete(key);
    this.lastTarget.delete(key);
    const t = this.healTimers.get(key);
    if (t) { clearTimeout(t); this.healTimers.delete(key); }
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    try { e.proc.kill(); } catch { /* 已经没了 */ }
    clearStaleSocket(e.socket);
  }

  /** 退出时全关 —— 留着的话就是下一次启动要扫的垃圾。 */
  closeAll(): void {
    /*
      **要并上 `wanted`**：一台正在排重建、但还没有 entry 的机器不在 `entries` 里，
      只遍历 entries 会把它的定时器留下来 —— 退出时那个 `unref` 过的定时器不挡退出，
      但在"关掉所有连接"之后又把一条连接拉起来，那是个说不通的状态。
    */
    for (const key of new Set([...this.entries.keys(), ...this.wanted])) this.close(key);
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
