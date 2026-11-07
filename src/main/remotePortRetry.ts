/**
 * **远端反向端口被占：换端口重试同一个模型，别去换模型候选** —— 2026-11-07 实测：
 * 一次 attach 里 gpt-5.6-sol / gpt-5.6-terra / deepseek-3.2 三个候选都撞同一个 39100
 * （ssh exit 255 + `remote port forwarding failed for listen port 39100`），白等 ~30 秒后整体失败，
 * 而提示还写着"会换端口重试"。端口被占和模型无关：换模型只是换一个模型去撞同一个端口。
 *
 * `connectWithModelFallback` 的候选循环里，每次启动失败先问 `retryOnNewPort`：
 *   · 不是端口被占 → false，照旧换下一个模型候选；
 *   · 端口被占、还能换 → `rearm`（清理远端残留 + 避开撞过的端口重分 + 重写远端配置），true，用新端口再试**同一个**模型；
 *   · 试满 `REMOTE_PORT_TRIES` 个端口（或换不出新端口）→ 抛 `RemotePortsBusyError`，整次启动停下（别的模型也一样撞）。
 *
 * 单独一个文件：`index.ts` 里有 electron，判据要能在测试里直接 import。
 */
import { tr } from './uiText.ts';

/** 一次启动最多试几个远端端口（含第一个）。 */
export const REMOTE_PORT_TRIES = 5;

/** `AcpClient` 在 ssh 因端口转发失败退出时给错误挂上的那个端口（见 `acp-client.ts` 的 close 处理）。 */
export function remotePortBusyOf(err: unknown): number | null {
  const p = (err as any)?.remotePortBusy;
  return typeof p === 'number' && p > 0 ? p : null;
}

/** 端口都试过了还是被占：说清是端口问题、试过哪些，别说成模型起不来。 */
export class RemotePortsBusyError extends Error {
  readonly ports: number[];
  constructor(ports: number[]) {
    super(tr('Could not set up the local tools connection: the remote ports were all in use on that machine (tried {ports}). This is a port problem on the remote machine, not the AI. Close leftover KiroLex / kiro-cli processes there (or wait a minute), then reconnect.', { ports: ports.join(', ') }));
    this.name = 'RemotePortsBusyError';
    this.ports = ports;
  }
}

export function isRemotePortsBusy(err: unknown): err is RemotePortsBusyError {
  return err instanceof RemotePortsBusyError;
}

type Tools = { remotePort: number; localPort: number; agentOverride: string };

export class RemotePortRetry<LT extends Tools = Tools> {
  /** 当前该用的本地工具（换过端口就是新那份）。 */
  localTools: LT | undefined;
  /** 撞过的端口，按顺序。 */
  readonly tried: number[] = [];
  private readonly rearm?: (avoid: number[]) => Promise<LT | undefined>;
  private readonly max: number;
  private readonly log?: (message: string) => void;

  constructor(opts: {
    localTools: LT | undefined;
    /** 清理远端残留、避开 `avoid` 重新分端口、重写远端配置；给不出就 undefined。不传 = 换不了端口（复用连接 / 本地会话）。 */
    rearm?: (avoid: number[]) => Promise<LT | undefined>;
    maxPorts?: number;
    log?: (message: string) => void;
  }) {
    this.localTools = opts.localTools;
    this.rearm = opts.rearm;
    this.max = opts.maxPorts ?? REMOTE_PORT_TRIES;
    this.log = opts.log;
  }

  /** 启动失败之后调：true = 已换好端口、再试同一个模型；false = 不是端口问题；抛 `RemotePortsBusyError` = 端口试完了。 */
  async retryOnNewPort(err: unknown): Promise<boolean> {
    const busy = remotePortBusyOf(err);
    if (busy === null || !this.localTools || !this.rearm) return false;
    for (const p of [this.localTools.remotePort, busy]) if (!this.tried.includes(p)) this.tried.push(p);
    if (this.tried.length >= this.max) throw new RemotePortsBusyError([...this.tried]);
    const next = await this.rearm([...this.tried]);
    if (!next || this.tried.includes(next.remotePort)) throw new RemotePortsBusyError([...this.tried]);
    this.log?.(`远端端口 ${this.tried.join(', ')} 被占，换 ${next.remotePort} 重试同一个模型（不换候选）`);
    this.localTools = next;
    return true;
  }
}
