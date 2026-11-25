/**
 * **主进程事件循环延迟监控** ——「远程会话连接的前半段输入框没法输入」（2026-11-25，Windows + SSM）。
 *
 * Windows 上窗口的键盘输入要经过主进程：主进程的事件循环一停（某个 execFileSync / readFileSync / 大 JSON.parse），
 * 整个窗口都不响应输入。原来没有任何日志能证明是哪一段卡的，所以这里：
 *   - 一个 50ms 的定时器量两跳之间隔了多久（定时器漂移）；隔了 ≥ 300ms 记一行 `blocked=<ms> phase=<…>`
 *     （logger 的 scope 是 `mainlag`，所以日志里是 `[mainlag] blocked=…`）；
 *   - `PhaseTracker`：在 attach / preflight / sweep / ensureSsmKey / transcript 读取 / history 重建这些地方打阶段标记，
 *     卡的那一行带上「当时在做什么」。同步活干完之后定时器才排得上，那时阶段已经结束了 ——
 *     所以除了还没结束的，上一跳之后**出现过**的阶段也一起报（报一次就清）。
 *
 * 开销：每 50ms 一次 `Date.now()` 比较，定时器 `unref`（不挡退出）。纯模块，不 import electron。
 */

export const LAG_THRESHOLD_MS = 300;
/**
 * 采样间隔。两跳之间的间隔 `gap` 里，主进程卡住的时长在 [gap - 间隔, gap] 之间（卡的那一下可能紧跟在上一跳之后开始，
 * 也可能在下一跳该到的前一刻才开始）—— 所以按 `gap` 本身判，并且间隔取得够小：
 * 卡 ≥ 300ms 一定有 gap ≥ 300（一定记）；卡 200ms 时 gap ≤ 200 + 50 = 250（一定不记）。记的数字是 gap，最多多算一个间隔。
 */
export const LAG_INTERVAL_MS = 50;

export class PhaseTracker {
  private seq = 0;
  private readonly live = new Map<number, string>();
  /** 上一次 `take()` 之后进过的阶段（含已经结束的） */
  private recent = new Set<string>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  /** 进入一个阶段；返回「结束」函数（多调不出错） */
  enter(name: string): () => void {
    const id = ++this.seq;
    this.live.set(id, name);
    this.recent.add(name);
    return () => { this.live.delete(id); };
  }

  /** 包一段同步或异步的活：结束（含抛错 / reject）时自动退出阶段 */
  run<T>(name: string, fn: () => T): T {
    const end = this.enter(name);
    let out: T;
    try { out = fn(); } catch (err) { end(); throw err; }
    if (out && typeof (out as any).then === 'function') {
      return (out as any).then((v: any) => { end(); return v; }, (err: any) => { end(); throw err; }) as T;
    }
    end();
    return out;
  }

  active(): string[] { return [...new Set(this.live.values())]; }

  /** 还在进行的 + 上一跳之后出现过的；取完清掉"出现过"那一份 */
  take(): string[] {
    const out = new Set<string>([...this.recent, ...this.live.values()]);
    this.recent = new Set();
    return [...out];
  }
}

export function formatLagLine(blockedMs: number, phases: string[]): string {
  const list = phases.map((p) => p.replace(/\s+/g, ' ').slice(0, 80));
  return `blocked=${Math.round(blockedMs)} phase=${list.length ? list.join(',') : '-'}`;
}

export interface LagMonitorOpts {
  log: (line: string, blockedMs: number) => void;
  thresholdMs?: number;
  intervalMs?: number;
  now?: () => number;
  phases?: PhaseTracker;
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (t: any) => void;
}

export interface LagMonitor {
  start(): void;
  stop(): void;
  /** 定时器的一跳（测试直接调） */
  tick(): void;
}

export function createLagMonitor(opts: LagMonitorOpts): LagMonitor {
  const threshold = opts.thresholdMs ?? LAG_THRESHOLD_MS;
  const interval = opts.intervalMs ?? LAG_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const phases = opts.phases ?? lagPhases;
  const setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearInterval(t));
  let timer: any = null;
  let last = 0;
  const tick = () => {
    if (timer === null) return;
    const at = now();
    /* 两跳之间的整段（见 LAG_INTERVAL_MS 上面那段：按它判才不会漏掉紧跟在上一跳之后开始的那种卡） */
    const blocked = at - last;
    last = at;
    if (blocked >= threshold) {
      try { opts.log(formatLagLine(blocked, phases.take()), blocked); } catch { /* 记日志失败不影响任何事 */ }
    } else {
      phases.take();
    }
  };
  return {
    start() {
      if (timer !== null) return;
      last = now();
      timer = setTimer(tick, interval);
      try { timer?.unref?.(); } catch { /* 非 Node 定时器 */ }
    },
    stop() {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
    },
    tick,
  };
}

/** 进程里共用的那一份：各模块在这里打阶段标记，index.ts 起的监控从这里取 */
export const lagPhases = new PhaseTracker();

/** 每片之后让出事件循环（大文件分片解析用） */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * **重活排成一条队**：多条会话同时 attach 时（实测一次 8 条），每条都要读 MB 级 transcript、重建 history.md ——
 * 一起开跑就是一次叠满。排进同一条 lane 一个接一个跑（每个自己再分片让出事件循环），前一个失败不影响后一个。
 */
export function createSerialLane(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}
