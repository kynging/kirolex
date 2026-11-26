/**
 * **备份同步的整轮看门狗** ——「备份定时同步网络断开 / 睡眠唤醒后卡死不再跑」（2026-11-26，Mac）。
 *
 * 实测：唤醒后某一轮占住了 syncRunning，卡在一个永远不返回的 await 上，finally 一直不执行；
 * 之后每次定时触发都在入口静默返回，日志里什么都没有，跨电脑同步的会话 2.5 小时拉不下来。
 * 真因（S3 响应收到一半连接被断开，Promise 永远不结束）修在 s3Client.ts；这里是兜底：
 *
 *   · 一轮在同一个阶段停留超过上限（没有进展）就放弃：记 warn（带卡在哪个阶段）、放掉锁，下一轮照常跑。
 *     按「没有进展」而不是整轮总时长算：第一次同步 / 网慢时一轮传几百个文件可以超过上限，每传完一个就是进展 ——
 *     按总时长放弃的话这一轮的状态表不写，下一轮又从头传，永远传不完；
 *     真卡住（一个 await 不返回）时阶段不会再变，照样到点放弃；
 *   · 被放弃那一轮晚到的结果不能再写 state / catalog —— 每一轮有轮次号，`check()` 不是当前这一轮就抛 `RoundAbandoned`；
 *   · 锁只由 `run()` 放，而且只放一次：被放弃那一轮晚到的 finally 碰不到新一轮的锁；
 *   · 上一轮还在跑时再触发：记日志（带上一轮开始时间和当前阶段），不静默；
 *   · Mac 睡眠时单调时钟不走，定时器会晚到 —— 另按墙上时间判（`reclaimIfStale`，唤醒时 / 再触发时调）。
 */

import type { RunLock } from './awsProfileCreds.ts';

/** 被看门狗放弃的那一轮晚到时 `check()` 抛这个 —— 调用方别把它当成同步失败。 */
export class RoundAbandoned extends Error {
  constructor(id: number) { super(`sync round #${id} was abandoned by the watchdog`); }
}

export interface SyncRound {
  readonly id: number;
  readonly reason: string;
  readonly startedAt: number;
  /** 现在在做什么（日志用：卡住时说卡在哪）。也算一次进展：看门狗从这一刻重新计时。 */
  stage(name: string): void;
  readonly currentStage: string;
  /**
   * 阶段没变、但真有数据在流动（上传分块交给系统 / 下载收到一块，见 s3Client 的 `creds.progress`）：也算进展，看门狗重新计时 ——
   * 慢网下一个大文件正常地传超过上限时不能被当成卡住。按 `limitMs / 10`（最多 1 秒）节流，不每块都重排定时器。
   */
  progress(): void;
  /** 被看门狗放弃了。 */
  readonly abandoned: boolean;
  /** 这一轮被放弃了就抛 `RoundAbandoned` —— 每次写 state / catalog / 本机文件之前调。 */
  check(): void;
}

type Level = 'info' | 'warn';

export class SyncRounds {
  private nextId = 1;
  private cur: { round: SyncRound; abandon: () => void; progressAt: number } | null = null;
  private readonly limitMs: number;
  private readonly log: (level: Level, msg: string) => void;
  private readonly now: () => number;

  constructor(opts: { limitMs: number; log: (level: Level, msg: string) => void; now?: () => number }) {
    this.limitMs = opts.limitMs;
    this.log = opts.log;
    this.now = opts.now || Date.now;
  }

  /** 正在跑的那一轮（没有 → null）。 */
  get current(): SyncRound | null { return this.cur?.round ?? null; }

  /**
   * 占锁跑一轮：锁被占着 → 记日志、返回 null；跑完 / 抛错 / 超过上限没有进展被放弃都放锁。
   * 被放弃时返回 `onAbandoned()` 的结果，body 还在后台跑，但它之后的 `round.check()` 都会抛。
   */
  async run<T>(lock: RunLock, reason: string, body: (round: SyncRound) => Promise<T>, onAbandoned: (round: SyncRound) => T): Promise<T | null> {
    if (lock.held) return this.noteSkipped(reason, null);
    lock.held = true;
    const id = this.nextId++;
    const startedAt = this.now();
    let stageName = '开始';
    let abandoned = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let arm: () => void = () => {};
    const round: SyncRound = {
      id, reason, startedAt,
      stage: (name) => { stageName = name; if (this.cur?.round === round) this.cur.progressAt = this.now(); arm(); },
      get currentStage() { return stageName; },
      progress: () => {
        const c = this.cur;
        if (abandoned || c?.round !== round) return;   // 被放弃之后的进展不让这一轮复活
        const t = this.now();
        if (t - c.progressAt < Math.min(1000, this.limitMs / 10)) return;
        c.progressAt = t;
        arm();
      },
      get abandoned() { return abandoned; },
      check: () => { if (abandoned) throw new RoundAbandoned(id); },
    };
    const gaveUp = new Promise<{ abandoned: true }>((resolve) => {
      const abandon = (): void => {
        if (abandoned || this.cur?.round !== round) return;
        const progressAt = this.cur?.progressAt ?? startedAt;
        abandoned = true;
        this.cur = null;
        const mins = (ms: number): string => (ms / 60_000).toFixed(1);
        this.log('warn', `同步看门狗：第 ${id} 轮（${reason}，${new Date(startedAt).toISOString()} 开始，已经 ${mins(this.now() - startedAt)} 分钟）`
          + `卡在「${stageName}」${mins(this.now() - progressAt)} 分钟没有进展 —— 放弃这一轮、放掉锁，下一轮照常跑；这一轮晚到的结果不再写状态表 / catalog`);
        resolve({ abandoned: true });
      };
      this.cur = { round, abandon, progressAt: startedAt };
      arm = () => { if (timer) clearTimeout(timer); if (!abandoned) timer = setTimeout(abandon, this.limitMs); };
      arm();
    });
    try {
      const work = body(round).then((value) => ({ value }));
      work.catch(() => { /* 被放弃之后才抛的错没人等：吞掉，免得 unhandled rejection */ });
      const r = await Promise.race([work, gaveUp]);
      return 'abandoned' in r ? onAbandoned(round) : r.value;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.cur?.round === round) this.cur = null;
      lock.held = false;
    }
  }

  /** 定时 / 手动触发时上一轮还在跑：记一条日志（不静默）；按墙上时间已经超时的顺手放弃掉。原样返回 `result`（调用方直接 return 它）。 */
  noteSkipped<R>(reason: string, result: R): R {
    const r = this.current;
    if (!r) {
      this.log('info', `跳过这一次同步（${reason}）：上一次备份操作还在跑（恢复 / 删除备份等）`);
      return result;
    }
    const mins = (ms: number): string => (ms / 60_000).toFixed(1);
    const progressAt = this.cur?.progressAt ?? r.startedAt;
    this.log('info', `跳过这一次同步（${reason}）：上一轮（第 ${r.id} 轮，${r.reason}）还在跑 —— ${new Date(r.startedAt).toISOString()} 开始、`
      + `已经 ${mins(this.now() - r.startedAt)} 分钟，现在在「${r.currentStage}」（${mins(this.now() - progressAt)} 分钟没有进展）`);
    this.reclaimIfStale();
    return result;
  }

  /**
   * 按**墙上时间**判：当前这一轮上一次进展到现在超过上限 → 立刻放弃。Mac 睡眠期间单调时钟不走，
   * 看门狗的定时器要醒着再过满上限才到 —— 唤醒时 / 被跳过时调一下，不必干等。
   */
  reclaimIfStale(): boolean {
    const c = this.cur;
    if (!c || this.now() - c.progressAt < this.limitMs) return false;
    c.abandon();
    return true;
  }
}
