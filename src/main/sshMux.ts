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
 *
 * ## 远端端口让 sshd 分，不写死
 *
 * 原来是 39100 起按机器递增的固定端口。实测：远端 39100–39102 都被别的、还 ESTAB 的
 * sshd-session 占着（同一用户另一台电脑上的 KiroLex，或者本机上一次留在远端没被回收的旧连接），
 * 于是 `remote port forwarding failed for listen port 39101`，而重建时还要同一个端口 ——
 * **必然再失败**。现在用 `-R 127.0.0.1:0:…`，从 ssh 的 `Allocated port N for remote forward`
 * 里拿到分到的端口；每次重建都是 sshd 现分的空闲端口，也就不会跟谁撞。
 * 别人占着的端口我们不碰 —— 那可能是用户另一台电脑正在用的。
 */

import { spawn, type ChildProcess } from 'child_process';
import { proxyArgs, assertSafeSshHost } from './sshProxy.ts';
import { batchModeFor, sshEnv } from './sshAuth.ts';
import { tr } from './uiText.ts';
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
  /** 远端监听端口；默认 0 = 让 sshd 分（见文件头「远端端口让 sshd 分」）。 */
  remotePort?: number;
  localPort: number;
  /**
   * 要不要带反向隧道（默认要）。**备用主连接**（`openSpare`）不带：隧道在第一条上，
   * 远端那个端口对这台机器上所有进程都通，走哪条连接起的执行器都能用它。
   */
  forward?: boolean;
}): string[] {
  assertSafeSshHost(opts.sshHost);
  const args = [
    '-N',
    '-o', batchModeFor(opts),
    '-o', 'ConnectTimeout=10',
    /*
      15 秒 × 3 次：死连接 45 秒内认出来、master 退出、排重建 ——「断网再恢复后一分钟内回来」
      靠的就是这一档。正常退出时 ssh 会给对端发断开，远端那条 sshd-session 当场就走。
    */
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    /* `Allocated port N` 是 INFO 级的 —— 用户 ~/.ssh/config 里写了 LogLevel QUIET/ERROR 就看不到它 */
    '-o', 'LogLevel=INFO',
    '-o', 'StrictHostKeyChecking=accept-new',
    ...(opts.forward === false ? [] : ['-o', 'ExitOnForwardFailure=yes']),
    '-o', 'ControlMaster=yes',
    '-o', 'ControlPersist=no',
    '-o', `ControlPath=${opts.socket}`,
    ...(opts.forward === false ? [] : ['-R', `127.0.0.1:${opts.remotePort ?? 0}:127.0.0.1:${opts.localPort}`]),
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

/**
 * 从 master 的 stderr 里拿 sshd 分到的远端端口（`-R …:0:…` 时 ssh 打的那句）：
 * `Allocated port 41235 for remote forward to 127.0.0.1:58660`。取最后一句 —— 那是这一次的。
 */
export function parseAllocatedPort(stderr: string): number | undefined {
  let port: number | undefined;
  for (const m of String(stderr || '').matchAll(/Allocated port (\d+) for remote forward/g)) {
    const n = Number(m[1]);
    if (n > 0 && n <= 65535) port = n;
  }
  return port;
}

/**
 * **ssh 报错 → 种类**（纯函数）——「Session open refused by peer」。
 *
 * 一台机器的所有执行器共用一条复用连接，每个执行器占它上面一个 session；sshd 默认 `MaxSessions 10`。
 * 满了之后再开，mux 客户端报 `mux_client_request_session: session request failed: Session open refused by peer`，
 * 有的版本 / 路径上是 channel 的 `administratively prohibited: open failed`。2026-10-22 实测（tokyo-arm）：
 * 正好 10 个执行器时切换组合、远端清理全报这句，界面上只看到一句英文。
 */
export type SshErrorKind = 'sessions-full' | 'other';
export function sshErrorKind(stderr: string): SshErrorKind {
  const s = String(stderr || '');
  if (/Session open refused by peer|administratively prohibited: open failed/i.test(s)) return 'sessions-full';
  return 'other';
}

/** 会话数满了、而且再开一条主连接也没救时给人看的那句话。 */
export function sessionsFullMessage(host: string): string {
  return tr('{host} has run out of SSH sessions (sshd MaxSessions, default 10). Running "Install AI tools" for this machine in Settings raises the limit to 64; or close a few remote sessions you are not using.', { host });
}

/** 备用主连接的 ControlPath：原路径后加序号（第一条备用是 `-2`）。短 —— 见 `controlPath` 那段长度限制。 */
export function spareControlPath(base: string, n: number): string {
  return `${base}-${n}`;
}

/** 一台机器最多再开几条备用主连接。sshd 默认一条 10 个 session，三条备用 = 再多 30 个执行器。 */
export const MAX_SPARES = 3;

/**
 * 一条连接被判"满了"之后多久再回去试它 —— 那上面的执行器会退，空位会回来。
 * 判错的代价只是一次被拒、马上换一条重试，所以不必精确数 session。
 */
export const FULL_COOLDOWN_MS = 60_000;

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

/** 第 n 次重建（从 0 数）要等多久：按退避表走，到顶之后一直用最后一档。 */
export function healDelay(n: number, table: readonly number[] = HEAL_BACKOFF_MS): number {
  return table[Math.min(Math.max(0, n), table.length - 1)];
}

/**
 * 连上之后活够这么久才算"真的好了"、退避从头算。
 * 不这样的话"连上就掉"会让退避永远停在第一档 —— 每 2 秒敲一次门。
 */
export const HEAL_STABLE_MS = 60_000;

export interface MuxDeps {
  log(level: 'info' | 'warn', message: string): void;
  /** 本地 MCP server 的端口（懒启动，所以现取）。 */
  localPort(): number;
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
   * 连接断了、排上了第 `attempt` 次重建 —— 调用方据此在那台机器的会话上说
   * 「本机工具连接中断，正在重连（第 N 次）」。连上之后是 `onReady`。
   */
  onHealing?(key: string, attempt: number): void;
  /** 退避表（毫秒）。可注入**只为测试** —— 真机上用 `HEAL_BACKOFF_MS`。 */
  healBackoffMs?: readonly number[];
  /** 探 socket（默认 `probeSocket`）。可注入只为测试：Windows 上没有 unix socket。 */
  probeSocket?(socket: string): Promise<boolean>;
  /** 平台（默认 `process.platform`）。可注入只为测试。 */
  platform?: string;
  /**
   * 等 socket 出现的上限（毫秒，默认 12 秒）。
   *
   * 做成可注入的**只为测试**：真机上这个值要够大（跨洋 ssh 握手 + 跳板两跳），
   * 而测试里没有真 socket，照 12 秒等就是让整个测试套慢 12 秒。
   */
  socketWaitMs?: number;
  /** 现在几点（默认 `Date.now`）。可注入只为测试：「满了」的冷却按它算。 */
  now?(): number;
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
  /**
   * 正在 `start` 里、还没登记进 `entries` 的那个 ssh 进程。`close` 要能杀到它 ——
   * 不然退出时一条正在握手的 master 会被漏掉，之后还把自己登记成有效连接。
   */
  private startingProcs = new Map<string, ChildProcess>();
  /** 希望活着的那些机器 —— `close()` 把它摘掉，自愈只对这里面的生效。 */
  private wanted = new Set<string>();
  /** 正在排的自愈定时器 + 已经试了几次（退避用）。 */
  private healTimers = new Map<string, NodeJS.Timeout>();
  private healAttempts = new Map<string, number>();
  /** 最后一次用过的目标（自愈时要用同一把钥匙、同一个跳板）。 */
  private lastTarget = new Map<string, { sshHost: string; sshPort?: number; identityFile?: string; proxyJump?: string }>();
  private deps: MuxDeps;
  private dir: string;
  /**
   * **备用主连接**（每台机器 0..MAX_SPARES 条）—— 第一条的 session 满了才开（`openSpare`）。
   * 不带隧道、不自愈：它们只是"多几个 session 的位置"，死了就不用，下次满了再开。
   */
  private spares = new Map<string, MuxEntry[]>();
  private sparesStarting = new Map<string, Promise<string | undefined>>();
  /** socket → 什么时候被 sshd 拒过（`markFull`）。冷却期内新执行器绕开它。 */
  private fullAt = new Map<string, number>();

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
    const key = muxKey(target.sshHost, target.sshPort);
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.proc.killed || e.proc.exitCode !== null) return undefined;
    /*
      **优先用有空位的那条** —— 第一条最近被 sshd 拒过（session 满了）就先走备用的；
      全都满着就还给第一条（被拒之后调用方会 `openSpare` 再开一条，或者把报错说成人话）。
    */
    if (!this.isFull(e.socket)) return e.socket;
    const spare = (this.spares.get(key) || []).find((s) => alive(s) && !this.isFull(s.socket));
    return spare ? spare.socket : e.socket;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private isFull(socket: string): boolean {
    const at = this.fullAt.get(socket);
    if (at === undefined) return false;
    if (this.now() - at >= FULL_COOLDOWN_MS) { this.fullAt.delete(socket); return false; }
    return true;
  }

  /** 这条连接刚被 sshd 拒开 session（`sshErrorKind` = sessions-full）：冷却期内新执行器绕开它。 */
  markFull(socket: string): void {
    if (socket) this.fullAt.set(socket, this.now());
  }

  /**
   * **第一条满了，再开一条主连接** —— 换一个 ControlPath（原路径加序号），不带隧道。
   *
   * 返回能用的那条 socket；开不了（第一条都不在、备用到顶、建不起来）返回 undefined，
   * 调用方据此把报错说成人话（`sessionsFullMessage`）。几条会话同时撞上满时共用同一次建立。
   */
  async openSpare(target: { sshHost: string; sshPort?: number; identityFile?: string; proxyJump?: string; passwordCipher?: string }): Promise<string | undefined> {
    if (!muxSupported(this.deps.platform)) return undefined;
    const key = muxKey(target.sshHost, target.sshPort);
    const main = this.entries.get(key);
    if (!main || !alive(main)) return undefined;
    const free = (this.spares.get(key) || []).find((s) => alive(s) && !this.isFull(s.socket));
    if (free) return free.socket;
    const pending = this.sparesStarting.get(key);
    if (pending) return pending;
    const p = this.startSpare(key, main.socket, target).finally(() => { this.sparesStarting.delete(key); });
    this.sparesStarting.set(key, p);
    return p;
  }

  private async startSpare(key: string, base: string, target: { sshHost: string; sshPort?: number; identityFile?: string; proxyJump?: string; passwordCipher?: string }): Promise<string | undefined> {
    const list = (this.spares.get(key) || []).filter(alive);
    this.spares.set(key, list);
    if (list.length >= MAX_SPARES) {
      this.deps.log('warn', `${key} 的备用复用连接已经开到 ${MAX_SPARES} 条，都满了 —— 不再开`);
      return undefined;
    }
    const used = new Set(list.map((x) => x.socket));
    let n = 2;
    while (used.has(spareControlPath(base, n))) n += 1;
    const socket = spareControlPath(base, n);
    if (!(await this.probe(socket))) clearStaleSocket(socket);
    const localPort = this.deps.localPort();
    const args = masterArgs({ ...target, socket, localPort, forward: false });
    const proc = (this.deps.spawnSsh || ((a: string[]) => spawn('ssh', a, { stdio: ['ignore', 'pipe', 'pipe'], env: sshEnv(target) })))(args);
    const entry: MuxEntry = { key, socket, remotePort: 0, localPort, proc, stderr: '' };
    let exited = false;
    proc.stderr?.on('data', (d: Buffer) => {
      const t = d.toString('utf-8').trim();
      if (t) entry.stderr = `${entry.stderr}\n${t}`.slice(-2000);
    });
    proc.on('exit', (code) => {
      exited = true;
      const cur = this.spares.get(key);
      if (cur) this.spares.set(key, cur.filter((x) => x !== entry));
      this.fullAt.delete(socket);
      clearStaleSocket(socket);
      this.deps.log('info', `${key} 的备用复用连接 ${socket} 退出了（code=${code}）`);
    });
    const ok = await waitFor(async () => exited || await this.probe(socket), this.deps.socketWaitMs ?? 12_000);
    /* 等的时候这台机器被 close 了（第一条也没了）：不登记 */
    if (!this.entries.has(key)) {
      try { proc.kill(); } catch { /* 已经没了 */ }
      clearStaleSocket(socket);
      return undefined;
    }
    if (!ok || exited) {
      try { proc.kill(); } catch { /* 已经没了 */ }
      this.deps.log('warn', `${key} 备用复用连接没建起来：${entry.stderr.trim() || '(ssh 没输出)'}`);
      return undefined;
    }
    const now = this.spares.get(key) || [];
    now.push(entry);
    this.spares.set(key, now);
    this.deps.log('info', `${key} 第一条复用连接的 session 满了（sshd MaxSessions）—— 另开了一条 ${socket}`
      + `（现在共 ${1 + now.length} 条；新执行器优先走有空位的那条）`);
    return socket;
  }

  private probe(socket: string): Promise<boolean> {
    return (this.deps.probeSocket || probeSocket)(socket);
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
    if (!muxSupported(this.deps.platform)) throw new Error('MUX_UNSUPPORTED');
    const key = muxKey(target.sshHost, target.sshPort);
    const live = this.entries.get(key);
    if (live && !live.proc.killed && live.proc.exitCode === null && await this.probe(live.socket)) return live;
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
    const delay = healDelay(n, this.deps.healBackoffMs);
    this.healAttempts.set(key, n + 1);
    try { this.deps.onHealing?.(key, n + 1); } catch { /* 提示失败不该影响重建 */ }
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
    /* 重建的是一条新连接，上一条"满了"的记号不算它的 */
    this.fullAt.delete(socket);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!(await this.probe(socket))) clearStaleSocket(socket);

    /*
      **远端端口让 sshd 分**（`-R 127.0.0.1:0:…`，见文件头）。分到几号要等 ssh 在 stderr 里
      说 `Allocated port N`；在那之前 entry.remotePort 是 0，不许交出去。
      每次重建都重新分 —— 上一次那个端口可能正被一条还没被回收的旧连接占着。
    */
    const localPort = this.deps.localPort();
    const args = masterArgs({ ...target, socket, remotePort: 0, localPort });
    const proc = (this.deps.spawnSsh || ((a: string[]) => spawn('ssh', a, { stdio: ['ignore', 'pipe', 'pipe'], env: sshEnv(target) })))(args);
    const entry: MuxEntry = { key, socket, remotePort: 0, localPort, proc, stderr: '' };
    this.startingProcs.set(key, proc);
    let exited = false;
    let readyAt = 0;
    /*
      **原样**攒着的 stderr：管道可以在任意字节处把一句话切成两段，`Allocated port 412` + `35 for …`
      分开到达时，只看单段就永远认不出来。所以端口从这份连续缓冲里解析，不 trim、不插换行。
    */
    let raw = '';
    proc.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString('utf-8');
      raw = `${raw}${chunk}`.slice(-8000);
      const s = chunk.trim();
      if (s) entry.stderr = `${entry.stderr}\n${s}`.slice(-2000);
      if (!entry.remotePort) entry.remotePort = parseAllocatedPort(raw) || 0;
    });
    proc.on('exit', (code) => {
      exited = true;
      /*
        master 没了 = 这台机器上所有会话的工具通道都没了。**必须说出来**：
        静默的话表现是"模型说文件不存在"，而那是这条路上最贵的误导。
      */
      if (this.entries.get(key) === entry) this.entries.delete(key);
      /* 活够了才把退避从头算 —— 连上就掉的那种不算"好了"（见 `HEAL_STABLE_MS`） */
      if (readyAt && Date.now() - readyAt >= HEAL_STABLE_MS) this.healAttempts.delete(key);
      /*
        原来这里写的是"会话会在下一次调用工具时重连"，那句话**不是实话**：重连只发生在
        新的 attach 上，已经连着的会话不会再调 `ensure()`。实测后果是 7 条会话一直挂在
        "执行器活着、本地工具是死的"状态上。所以现在自己排重建。
      */
      this.deps.log('warn', `${key} 的复用连接退出了（code=${code}）——`
        + `这台机器上的会话暂时读不到你机器上的文件，正在排重建。`
        + `${entry.stderr.trim() ? ` 最后的输出：${entry.stderr.trim()}` : ''}`);
      clearStaleSocket(socket);
      /* 还没就绪就退了的那次由下面的失败分支排重建（它还要把错误抛给调用方） */
      if (readyAt) this.scheduleHeal(key);
    });

    /*
      等 **socket 出现、而且隧道真的建好**（`Allocated port` 来了）。只看 socket 是实测那次的坑：
      socket 先出来、`-R` 的结果晚一点才回，于是日志说"已建立"，0.06 秒后就因为端口被占退了 ——
      而调用方已经拿着那个端口去起会话了。进程退了就别再等满 12 秒。
    */
    const ok = await waitFor(
      async () => exited || (entry.remotePort > 0 && await this.probe(socket)),
      this.deps.socketWaitMs ?? 12_000,
    );
    /* 等的这段时间里被 `close` 了（退出、这台机器不要了）：不许再登记、不许 onReady */
    const cancelled = this.startingProcs.get(key) !== proc;
    if (!cancelled) this.startingProcs.delete(key);
    if (cancelled) {
      try { proc.kill(); } catch { /* 已经没了 */ }
      clearStaleSocket(socket);
      throw new Error(tr('The shared connection to {host} was closed while it was being set up', { host: key }));
    }
    if (!ok || exited) {
      try { proc.kill(); } catch { /* 已经没了 */ }
      /*
        **建不起来也要排重建** —— 这正是实测撞到的那个口子：14:19 那次 12 秒等超时之后
        没有任何东西再试（当时网络还在抖），于是会话永久没有工具。
      */
      this.scheduleHeal(key);
      throw new Error(tr('The shared connection to {host} could not be set up. {detail}', { host: key, detail: entry.stderr.trim() || tr('(ssh printed nothing)') }));
    }
    readyAt = Date.now();
    this.entries.set(key, entry);
    this.deps.log('info', `${key} 复用连接已建立：远端 ${entry.remotePort}（sshd 分的）→ 本地 ${localPort}`
      + `（这台机器上的会话共用这一条，各自用自己的 token）`);
    /*
      **光把 master 拉回来不够**：执行器是在 `localTools` 为 undefined 时起的，
      它那条 kiro-cli 没被配上本地 MCP —— 而且重建之后端口多半变了，
      原来那些会话 agent 里写的还是旧端口。所以要通知调用方把那台机器上的会话重新备一次。
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
    /* 备用的一起关 —— 它们没有自愈，留着就是孤儿连接 */
    for (const x of this.spares.get(key) || []) {
      try { x.proc.kill(); } catch { /* 已经没了 */ }
      this.fullAt.delete(x.socket);
      clearStaleSocket(x.socket);
    }
    this.spares.delete(key);
    /* 正在建的那条也要杀 —— 它还不在 entries 里 */
    const pending = this.startingProcs.get(key);
    if (pending) {
      this.startingProcs.delete(key);
      try { pending.kill(); } catch { /* 已经没了 */ }
    }
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.fullAt.delete(e.socket);
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
    for (const key of new Set([...this.entries.keys(), ...this.wanted, ...this.startingProcs.keys(), ...this.spares.keys()])) this.close(key);
  }

  keys(): string[] { return [...this.entries.keys()]; }
}

function alive(e: MuxEntry): boolean {
  return !e.proc.killed && e.proc.exitCode === null;
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
