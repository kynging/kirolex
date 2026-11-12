/**
 * **Windows 上每台 SSM 机器只开一条 SSM 隧道** ——「SSM 就一条，SSH 多个没关系」（2026-11-12 kyn-desktop 实测）。
 *
 * Win32-OpenSSH 没有 ControlMaster（`sshMux.ts` 的 `muxSupported()` 在 win32 是 false），于是每条远程会话
 * 各起一个 ssh，每个 ssh 的 ProxyCommand 都完整走一遍 `aws ssm start-session` + session-manager-plugin：
 * 4 条会话 = 4 条 SSM 会话、4 组 cmd/aws/plugin 进程，每开一条都慢好几秒。
 *
 * 现在：每台机器（按 实例 ID + 区域 + profile 归一）开**一条**本机端口转发
 * `aws ssm start-session --document-name AWS-StartPortForwardingSession --parameters portNumber=<sshd 端口>,localPortNumber=<空闲端口>`，
 * 这台机器所有会话的 ssh 都直连 `127.0.0.1:<端口>`（不带 ProxyCommand；`HostKeyAlias=<实例 ID>`，
 * 不然所有机器在 known_hosts 里都叫 127.0.0.1）。`-R` 反向端口、ACP、远端命令全部照旧 —— 换的只是 TCP 从哪来。
 *
 *   · **临时公钥**：每个 ssh 认证前公钥都得是 60 秒内推过的。合并成「隧道就绪 + 推一次 → 之后 45 秒内起的 ssh
 *     共用这次推送」，过期由下一次 `ensure` 再推；`ssmUseOwnKey` 的不推。
 *   · **懒建 + 引用计数**：第一条要连时建；`acquire/release` 按会话计数，最后一条走了空闲 `idleMs`（5 分钟）再关。
 *   · **自愈**：隧道进程退出 / 端口连不上 → 有人在用就按退避重建，重建期间 `ensure` 等它；
 *     已经连着的 ssh 断了走现有的断线恢复（`remoteRecovery`），这里不管。
 *   · **AccessDenied**（角色的 StartSession 只放了 AWS-StartSSHSession 文档）：说人话，这台机器这次运行里
 *     回退到「每会话一条 ProxyCommand」（`liveFor` 返回 undefined，`buildSshArgs` 照旧走老路）。
 *
 * `buildSshArgs` 是同步的：它只问 `liveFor`（隧道就绪 + 推送还新鲜才给端口），否则照旧走 ProxyCommand ——
 * 所以任何一条没先 `ensure` 的 ssh 都还能连，只是慢。
 */

import { spawn } from 'child_process';
import net from 'net';
import type { RemoteTarget } from './config';
import { taskkillTree } from './procTree.ts';
import { findLocalTool, localToolSpawn, pluginDirIfOffPath, runLocalTool, sendKeyArgs, ensureSsmKey, usesSsmTempKey, ssmOsUser } from './sshProxy.ts';

export type TunnelTarget = Pick<RemoteTarget, 'sshHost' | 'sshPort' | 'connectVia' | 'ssmInstanceId' | 'ssmRegion' | 'ssmProfile' | 'ssmUseOwnKey'> & { id?: string };

/** 隧道进程（`ChildProcess` 的一小部分，测试里给假的）。 */
export interface TunnelProc {
  pid?: number;
  exitCode: number | null;
  killed?: boolean;
  kill(): void;
  stdout?: { on(ev: 'data', fn: (d: Buffer | string) => void): void } | null;
  stderr?: { on(ev: 'data', fn: (d: Buffer | string) => void): void } | null;
  on(ev: 'exit', fn: (code: number | null) => void): void;
  on(ev: 'error', fn: (err: Error) => void): void;
}

export interface TunnelDeps {
  /** 起 `aws ssm start-session …AWS-StartPortForwardingSession…`（参数见 `tunnelArgs`）。 */
  spawnTunnel: (target: TunnelTarget, localPort: number) => TunnelProc;
  /** 本机一个空闲端口（只在 127.0.0.1 上找）。 */
  freePort: () => Promise<number>;
  /** 这个端口现在连得上吗（host 是 127.0.0.1 或 ::1）。 */
  probe: (host: string, port: number) => Promise<boolean>;
  /** 推一次临时公钥（`aws ec2-instance-connect send-ssh-public-key`）；失败就抛。 */
  pushKey: (target: TunnelTarget) => Promise<void>;
  /** 这台机器要不要推公钥（= sshProxy `usesSsmTempKey`）。 */
  needsPush: (target: TunnelTarget) => boolean;
  /** 推送记在哪把钥匙 + 哪个登录用户上（同一台机器，不同 id 的快照用的是不同的临时私钥）。 */
  pushKeyId: (target: TunnelTarget) => string;
  log: (level: 'info' | 'warn', message: string) => void;
  now?: () => number;
  /** 最后一条会话走后多久关（默认 5 分钟）。 */
  idleMs?: number;
  /** 等隧道就绪多久（默认 30 秒 —— 和 SSM 的 ConnectTimeout 一样）。 */
  readyWaitMs?: number;
  /** 重建退避（毫秒），按第几次取，最后一个封顶。 */
  healBackoffMs?: number[];
  /** 推送当作新鲜的时长（默认 45 秒：推送管 60 秒，留 15 秒给 ssh 握手）。 */
  pushFreshMs?: number;
  /** 端口探活的最小间隔（`ensure` 很频繁，没必要每次都敲一下）。 */
  probeEveryMs?: number;
  /** 收掉隧道进程整棵树（Windows：`taskkill /T /F`；默认只 `proc.kill()`）。 */
  killTree?: (proc: TunnelProc) => void;
}

interface Tunnel {
  key: string;
  port: number;
  host: string;
  proc: TunnelProc;
  ready: boolean;
  startedAt: number;
  lastProbe: number;
  stderr: string;
  target: TunnelTarget;
  reuseLogged?: boolean;
  /** 已经交给过一次 ensure 的调用方（之后再交出去就是「复用」）。 */
  handedOut?: boolean;
}

/** 归一：同一台机器（实例 + 区域 + profile + sshd 端口）只一条隧道。 */
export function tunnelKey(t: TunnelTarget): string {
  return [t.ssmInstanceId || '', t.ssmRegion || '', t.ssmProfile || '', t.sshPort && t.sshPort > 0 ? t.sshPort : 22].join('|');
}

/** `ssm start-session` 端口转发的参数（不含 aws 本身）。三个 SSM 值已经过了 `validateTarget` 的白名单。 */
export function tunnelArgs(t: TunnelTarget, localPort: number): string[] {
  const port = t.sshPort && t.sshPort > 0 ? t.sshPort : 22;
  return [
    'ssm', 'start-session',
    '--target', String(t.ssmInstanceId),
    '--document-name', 'AWS-StartPortForwardingSession',
    '--parameters', `portNumber=${port},localPortNumber=${localPort}`,
    '--region', String(t.ssmRegion),
    ...(t.ssmProfile ? ['--profile', String(t.ssmProfile)] : []),
  ];
}

/** 角色不让用 AWS-StartPortForwardingSession 文档（只放了 AWS-StartSSHSession 的那种最小权限）。 */
export function tunnelDenied(stderr: string): boolean {
  return /AccessDenied|not authorized to perform/i.test(String(stderr || ''));
}

export class SsmTunnels {
  private tunnels = new Map<string, Tunnel>();
  private starting = new Map<string, Promise<Tunnel>>();
  private pushes = new Map<string, number>();
  private pushing = new Map<string, Promise<void>>();
  /** 会话 → 它用的那条隧道（引用计数）。 */
  private holders = new Map<string, string>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private healAttempts = new Map<string, number>();
  /** 退避到什么时候（真实时间 ms）：重建任务先等到这个点再建，期间的 ensure 都等同一个任务。 */
  private retryAt = new Map<string, number>();
  /** 这次运行里不许用端口转发的机器（AccessDenied）。 */
  private denied = new Set<string>();
  private closed = false;

  private deps: TunnelDeps;

  constructor(deps: TunnelDeps) {
    this.deps = deps;
  }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private backoff(attempt: number): number {
    const list = this.deps.healBackoffMs || [2_000, 5_000, 15_000, 30_000, 60_000];
    return list[Math.min(Math.max(attempt - 1, 0), list.length - 1)];
  }

  /** 这台机器在这次运行里被拒用端口转发了吗。 */
  isDenied(t: TunnelTarget): boolean {
    return this.denied.has(tunnelKey(t));
  }

  /** 现在有几条隧道（测试 / 日志用）。 */
  count(): number {
    return [...this.tunnels.values()].filter((x) => alive(x.proc)).length;
  }

  /**
   * **同步**：这台机器现在能直连的那个本机端口 —— 隧道就绪、进程活着、（要推公钥的）推送还新鲜。
   * 任何一条不满足就 undefined，`buildSshArgs` 照旧走每会话 ProxyCommand。
   */
  liveFor(t: TunnelTarget): { host: string; port: number } | undefined {
    const tun = this.tunnels.get(tunnelKey(t));
    if (!tun || !tun.ready || !alive(tun.proc)) return undefined;
    if (this.deps.needsPush(t)) {
      const at = this.pushes.get(this.pushId(t));
      if (at === undefined || this.now() - at >= (this.deps.pushFreshMs ?? 45_000)) return undefined;
    }
    return { host: tun.host, port: tun.port };
  }

  private pushId(t: TunnelTarget): string {
    return `${tunnelKey(t)}#${this.deps.pushKeyId(t)}`;
  }

  /**
   * **要连之前调**：隧道没有就建（并发只建一次）、建好了再推一次公钥（推送过期才推）。
   * 正在退避 / 重建时**等它**（同一台机器的调用共用同一个重建任务），不各自另起 ProxyCommand。
   * 返回 undefined 只有三种：这台机器被拒用端口转发（AccessDenied）、等到的这次重建也失败了、推公钥失败 ——
   * 那时调用方这一次走每会话 ProxyCommand。
   */
  async ensure(t: TunnelTarget): Promise<{ host: string; port: number } | undefined> {
    if (this.closed) return undefined;
    const key = tunnelKey(t);
    if (this.denied.has(key)) return undefined;
    this.lastTargets.set(key, { ...t });
    this.cancelIdle(key);
    let tun = this.tunnels.get(key);
    /* 现成、就绪、这会儿不用探活、也没有别人正在探活 / 重建：直接用；否则等同一个「拿隧道」任务 */
    const healthy = !!tun && alive(tun.proc) && tun.ready && !this.probeDue(tun) && !this.acquiring.has(key);
    if (!healthy) {
      try {
        tun = await this.acquire1(key, t);
      } catch {
        return undefined;
      }
    }
    /* 第二次起交出去就是「复用」。每条隧道只说一次 —— ensure 在每次 ssh 前都调，句句都记就是噪音 */
    if (tun!.handedOut && !tun!.reuseLogged) {
      tun!.reuseLogged = true;
      this.deps.log('info', `复用 SSM 隧道 ${key}（${tun!.host}:${tun!.port}）`);
    }
    tun!.handedOut = true;
    if (this.deps.needsPush(t)) {
      try {
        await this.push(t);
      } catch (err: any) {
        this.deps.log('warn', `SSM 隧道 ${key}：推临时公钥失败（${String(err?.message || err).slice(0, 200)}）—— 这次走每会话 ProxyCommand`);
        /* 失败返回也要排空闲关闭：上面已经取消了空闲计时器，没人引用的隧道（比如只是预检建的）不排就会一直留着 */
        if (!this.hasHolders(key)) this.scheduleIdle(key);
        return undefined;
      }
    }
    if (!this.hasHolders(key)) this.scheduleIdle(key);
    return { host: tun!.host, port: tun!.port };
  }

  private probeDue(tun: Tunnel): boolean {
    return this.now() - tun.lastProbe >= (this.deps.probeEveryMs ?? 30_000);
  }

  /**
   * **按 tunnelKey 合并的「拿一条能用的隧道」任务**：该探活就探活，探活失败 / 没有 / 死了就重建（含退避等待）。
   * 并发的 ensure 都等这同一个任务 —— 不然第一条在等探活时，第二条会拿着旧端口走掉，
   * 探活失败、旧隧道被删之后它就连了个坏端口（或者 liveFor 落空另起 ProxyCommand）。
   */
  private acquiring = new Map<string, Promise<Tunnel>>();
  private acquire1(key: string, t: TunnelTarget): Promise<Tunnel> {
    const pending = this.acquiring.get(key);
    if (pending) return pending;
    const p: Promise<Tunnel> = (async () => {
      let tun = this.tunnels.get(key);
      if (tun && alive(tun.proc) && tun.ready && this.probeDue(tun)) {
        tun.lastProbe = this.now();
        if (!(await this.deps.probe(tun.host, tun.port))) {
          this.deps.log('warn', `SSM 隧道 ${key}（127.0.0.1:${tun.port}）连不上了 —— 关掉重建`);
          this.drop(key, tun);
          tun = undefined;
        }
      }
      if (tun && alive(tun.proc) && tun.ready) return tun;
      return this.starting.get(key) || this.start(key, t);
    })().finally(() => { if (this.acquiring.get(key) === p) this.acquiring.delete(key); });
    this.acquiring.set(key, p);
    return p;
  }

  private async push(t: TunnelTarget): Promise<void> {
    const id = this.pushId(t);
    const at = this.pushes.get(id);
    if (at !== undefined && this.now() - at < (this.deps.pushFreshMs ?? 45_000)) return;
    const pending = this.pushing.get(id);
    if (pending) return pending;
    const p = this.deps.pushKey(t).then(() => { this.pushes.set(id, this.now()); }).finally(() => { this.pushing.delete(id); });
    this.pushing.set(id, p);
    return p;
  }

  /**
   * 建一条（并发共用同一个任务）。上一次失败 / 刚断还在退避期内：**先等到退避结束再建** —— 等的这段时间里
   * 进来的 `ensure` 也拿到这同一个任务，一起等。
   */
  private start(key: string, t: TunnelTarget): Promise<Tunnel> {
    const p = (async () => {
      const wait = (this.retryAt.get(key) || 0) - Date.now();
      if (wait > 0) {
        this.deps.log('info', `SSM 隧道 ${key}：${Math.round(wait / 1000)} 秒后重建（第 ${(this.healAttempts.get(key) || 0) + 1} 次），这期间要连这台机器的 ssh 都等它`);
        await sleep(wait);
      }
      if (this.closed) throw new Error('closed');
      return this.startOnce(key, t);
    })().finally(() => { if (this.starting.get(key) === p) this.starting.delete(key); });
    this.starting.set(key, p);
    /*
      **没建成就按退避排下一次** —— 必须在上面的 finally 删掉 starting **之后**排：之前在 failed() 里用 microtask 排，
      那时 starting 还在，kick() 当成「已经在建」直接返回，于是有会话引用也不再自动重试。
      p 被拒之后才跑这里（finally 已经跑过）；AccessDenied / 关闭不重试。
    */
    /* setTimeout 0：等合并的「拿隧道」任务（acquiring）也收尾了再排，不然 kick 进来又拿到那个正要失败的任务 */
    p.catch((err) => { if (err?.message === 'tunnel not ready') setTimeout(() => this.kick(key, t), 0); });
    return p;
  }

  private async startOnce(key: string, t: TunnelTarget): Promise<Tunnel> {
    const old = this.tunnels.get(key);
    if (old) this.drop(key, old);
    const port = await this.deps.freePort();
    const tun: Tunnel = { key, port, host: '127.0.0.1', proc: undefined as unknown as TunnelProc, ready: false, startedAt: this.now(), lastProbe: this.now(), stderr: '', target: { ...t } };
    let exited = false;
    let sawWaiting = false;
    /* 进程没了（exit，或者根本没起来的 error —— 比如 aws 不在了）：两条路同一个处理，只处理一次 */
    let gone = false;
    const onGone = (why: string): void => {
      exited = true;
      if (gone) return;
      gone = true;
      if (this.tunnels.get(key) !== tun) return;   // 已经被换掉 / 关掉的那条
      this.tunnels.delete(key);
      if (!tun.ready) return;   // 还没就绪就没了：由下面的等待分支报错
      this.deps.log('warn', `SSM 隧道 ${key}（127.0.0.1:${port}）${why}${tun.stderr.trim() ? `：${lastLine(tun.stderr)}` : ''}`);
      this.heal(key, tun.target);
    };
    let proc: TunnelProc;
    try {
      proc = this.deps.spawnTunnel(t, port);
    } catch (err: any) {
      /* 同步就抛（参数不合法之类）：和异步的 error 一样算这次没建成 */
      return this.failed(key, t, tun, true, String(err?.message || err));
    }
    tun.proc = proc;
    this.tunnels.set(key, tun);
    proc.stdout?.on('data', (d) => { if (/Waiting for connections/i.test(String(d))) sawWaiting = true; });
    proc.stderr?.on('data', (d) => { tun.stderr = `${tun.stderr}${String(d)}`.slice(-4000); });
    proc.on('error', (err) => {
      /* spawn 失败是**异步**发 error 的：不接的话进 uncaughtException，而且这里会一直等到就绪超时 */
      tun.stderr = `${tun.stderr}\n${String(err?.message || err)}`.slice(-4000);
      onGone('起不来 / 出错了');
    });
    proc.on('exit', (code) => onGone(`退出了（code=${code}）`));
    this.deps.log('info', `建 SSM 隧道 ${key}：AWS-StartPortForwardingSession → 127.0.0.1:${port}`);
    /* 就绪 = 本机端口连得上（plugin 打出 Waiting for connections 之后才开始听）。先试 127.0.0.1，不行再试 ::1 */
    /* 就绪等待按真实时间算（注入的时钟只管推送新鲜度） */
    const deadline = Date.now() + (this.deps.readyWaitMs ?? 30_000);
    while (!exited && Date.now() < deadline && !this.closed) {
      if (await this.deps.probe('127.0.0.1', port)) { tun.host = '127.0.0.1'; tun.ready = true; break; }
      if (sawWaiting && await this.deps.probe('::1', port)) { tun.host = '::1'; tun.ready = true; break; }
      if (exited) break;
      await sleep(150);
    }
    if (!tun.ready || exited) {
      tun.ready = false;
      return this.failed(key, t, tun, exited, '');
    }
    this.retryAt.delete(key);
    this.healAttempts.delete(key);
    this.deps.log('info', `SSM 隧道 ${key} 就绪：${tun.host}:${port}（这台机器的 ssh 都直连它）`);
    return tun;
  }

  /** 这次没建成：收掉进程树、认 AccessDenied（回退）、否则记退避，有会话在用就排下一次。总是抛。 */
  private failed(key: string, t: TunnelTarget, tun: Tunnel, exited: boolean, spawnError: string): never {
    if (tun.proc) this.kill(tun.proc);
    if (this.tunnels.get(key) === tun) this.tunnels.delete(key);
    if (spawnError) tun.stderr = `${tun.stderr}\n${spawnError}`;
    if (tunnelDenied(tun.stderr)) {
      this.denied.add(key);
      this.deps.log('warn', `SSM 隧道 ${key}：你的 AWS 身份不允许用 AWS-StartPortForwardingSession 文档开端口转发`
        + `（最小权限里 ssm:StartSession 只放了 AWS-StartSSHSession？）。这台机器在这次运行里回退到「每条会话一条 SSM ProxyCommand」。`
        + `想用共享隧道就给 ssm:StartSession 的 Resource 再加上 arn:aws:ssm:*:*:document/AWS-StartPortForwardingSession。`
        + ` 原文：${lastLine(tun.stderr)}`);
      throw new Error('denied');
    }
    const attempt = (this.healAttempts.get(key) || 0) + 1;
    this.healAttempts.set(key, attempt);
    this.retryAt.set(key, Date.now() + this.backoff(attempt));
    const why = exited ? `进程没了${tun.stderr.trim() ? `：${lastLine(tun.stderr)}` : ''}` : `${Math.round((this.deps.readyWaitMs ?? 30_000) / 1000)} 秒内没就绪`;
    this.deps.log('warn', `SSM 隧道 ${key} 建不起来（${why}）—— 等着的这几条 ssh 这次走每会话 ProxyCommand，${Math.round(this.backoff(attempt) / 1000)} 秒后再试`);
    throw new Error('tunnel not ready');
  }

  /** 就绪过的隧道没了：有会话在用就记一次退避、马上排重建（重建任务自己等退避；这期间的 ensure 都等它）。 */
  private heal(key: string, t: TunnelTarget): void {
    if (this.closed || this.denied.has(key) || !this.hasHolders(key)) return;
    const attempt = (this.healAttempts.get(key) || 0) + 1;
    this.healAttempts.set(key, attempt);
    this.retryAt.set(key, Date.now() + this.backoff(attempt));
    this.kick(key, t);
  }

  private kick(key: string, t: TunnelTarget): void {
    if (this.closed || this.denied.has(key) || !this.hasHolders(key) || this.starting.has(key)) return;
    void this.ensure(this.lastTargets.get(key) || t).catch(() => {});
  }

  /** 收掉隧道进程**整棵树**（aws → session-manager-plugin；aws.cmd 时是 cmd → aws → plugin）。 */
  private kill(proc: TunnelProc): void {
    try {
      if (this.deps.killTree) this.deps.killTree(proc);
      else proc.kill();
    } catch { /* 已经没了 */ }
  }

  /** 会话的最后一次目标（自愈时用同一组参数）。 */
  private lastTargets = new Map<string, TunnelTarget>();

  /** 这条会话开始用这台机器的隧道（引用计数 +1）。 */
  acquire(sessionId: string, t: TunnelTarget): void {
    const key = tunnelKey(t);
    const prev = this.holders.get(sessionId);
    this.holders.set(sessionId, key);
    this.lastTargets.set(key, { ...t });
    this.cancelIdle(key);
    if (prev && prev !== key && !this.hasHolders(prev)) this.scheduleIdle(prev);
  }

  /** 这条会话不用了（引用计数 -1）；最后一条走了就排空闲关闭。 */
  release(sessionId: string): void {
    const key = this.holders.get(sessionId);
    if (!key) return;
    this.holders.delete(sessionId);
    if (!this.hasHolders(key)) this.scheduleIdle(key);
  }

  private hasHolders(key: string): boolean {
    for (const k of this.holders.values()) if (k === key) return true;
    return false;
  }

  private cancelIdle(key: string): void {
    const t = this.idleTimers.get(key);
    if (t) { clearTimeout(t); this.idleTimers.delete(key); }
  }

  private scheduleIdle(key: string): void {
    this.cancelIdle(key);
    if (!this.tunnels.has(key) && !this.starting.has(key)) return;
    const idle = this.deps.idleMs ?? 5 * 60_000;
    const timer = setTimeout(() => {
      this.idleTimers.delete(key);
      if (this.hasHolders(key)) return;
      const tun = this.tunnels.get(key);
      if (!tun) return;
      this.deps.log('info', `SSM 隧道 ${key} 空闲 ${Math.round(idle / 60_000)} 分钟没有会话了 —— 关掉`);
      this.drop(key, tun);
    }, idle);
    timer.unref?.();
    this.idleTimers.set(key, timer);
  }

  private drop(key: string, tun: Tunnel): void {
    if (this.tunnels.get(key) === tun) this.tunnels.delete(key);
    this.kill(tun.proc);
  }

  /** 退出时全关。 */
  closeAll(): void {
    this.closed = true;
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    for (const [key, tun] of this.tunnels) {
      this.deps.log('info', `关闭 SSM 隧道 ${key}（127.0.0.1:${tun.port}）`);
      this.kill(tun.proc);
    }
    this.tunnels.clear();
  }
}

function alive(p: TunnelProc): boolean {
  return !p.killed && p.exitCode === null;
}

function lastLine(s: string): string {
  return String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 300) || '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 这条 ssh 该不该走共享隧道：只在**没有 ControlMaster 的平台**（Windows）、SSM 机器、开关开着时。
 * Mac / Linux 有 sshMux 的复用（一台机器本来就一条 ssh、一次 SSM 握手），直连机器没有 SSM —— 都不走这里。
 */
export function tunnelApplies(remote: Pick<RemoteTarget, 'connectVia'> | undefined, env: { muxSupported: boolean; enabled: boolean }): boolean {
  return !env.muxSupported && env.enabled && remote?.connectVia === 'ssm';
}

/**
 * 开关：`config.json` 里 `"ssmSharedTunnel": false`（或环境变量 `KIROLEX_SSM_SHARED_TUNNEL=0`）→ 回到每会话一条 ProxyCommand。缺省开。
 */
export function sharedTunnelEnabled(config: any, env: NodeJS.ProcessEnv = process.env): boolean {
  if (/^(0|false|off|no)$/i.test(String(env.KIROLEX_SSM_SHARED_TUNNEL || ''))) return false;
  return config?.ssmSharedTunnel !== false;
}

/**
 * 真的那一套依赖：aws 用绝对路径（`aws.cmd` 经 cmd.exe，见 sshProxy `localToolSpawn`），
 * session-manager-plugin 不在 PATH 上时给隧道进程的 PATH 补上它的目录；推公钥和「测试连接」用同一份参数（`sendKeyArgs`）。
 */
export function defaultTunnelDeps(log: TunnelDeps['log']): TunnelDeps {
  const awsPath = (): string => findLocalTool('aws') || 'aws';
  return {
    spawnTunnel: (t, localPort) => {
      const spec = localToolSpawn(awsPath(), tunnelArgs(t, localPort));
      const pluginDir = pluginDirIfOffPath(process.env, 'win32');
      const env = pluginDir ? { ...process.env, PATH: `${pluginDir};${process.env.PATH || process.env.Path || ''}` } : process.env;
      return spawn(spec.file, spec.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments, env }) as unknown as TunnelProc;
    },
    freePort: () => new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(port));
      });
    }),
    probe: (host, port) => new Promise((resolve) => {
      const sock = net.connect({ host, port });
      const done = (ok: boolean): void => { sock.destroy(); resolve(ok); };
      sock.setTimeout(1_500, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    }),
    pushKey: async (t) => {
      const r = await runLocalTool(awsPath(), sendKeyArgs(t, ensureSsmKey(t).publicKey), 30_000);
      /* 只看退出码：Roles Anywhere 的 credential_process 会在 stderr 打「could not parse PEM data」之类的噪音 */
      if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    },
    /*
      **整棵树一起收**：Windows 上 `proc.kill()` 只结束 aws.exe（aws.cmd 时只结束 cmd.exe），真正听端口的
      session-manager-plugin 会活下来变成孤儿隧道。根进程还活着时 `taskkill /PID <根> /T /F` 按父子关系整棵结束。
    */
    killTree: (proc) => killTunnelTree(proc),
    needsPush: (t) => usesSsmTempKey(t),
    pushKeyId: (t) => `${ensureSsmKey(t).privateKey}|${ssmOsUser(t)}`,
    log,
  };
}

/** 收掉隧道进程整棵树：Windows 上根进程还活着就 `taskkill /T /F`（不等它做完，退出路径上也能用），否则 `kill()`。 */
export function killTunnelTree(proc: TunnelProc, platform: NodeJS.Platform = process.platform, taskkill: (pid: number) => Promise<void> = taskkillTree): void {
  if (platform === 'win32' && proc.pid && proc.exitCode === null && !proc.killed) {
    void taskkill(proc.pid);
    return;
  }
  try { proc.kill(); } catch { /* 已经没了 */ }
}
