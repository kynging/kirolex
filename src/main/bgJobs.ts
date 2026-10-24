/**
 * **模型自己起的后台命令（`bg_run`）和监视（`watch`）** —— 结果自动回到起它的那条会话。
 *
 * 以前模型只能用 `local_bash` 起一个 `nohup` 循环：输出回不到聊天，也没有东西唤醒会话，于是它要么
 * 在一轮里 sleep 轮询（占着这一轮、超时就断），要么让用户自己盯着。这里把"等"交给主进程：
 *
 *   · `bg_run`：立刻返回 jobId；命令**退出时**把「退出码 + 输出末尾（截到 4KB）」作为一条唤醒发回会话；
 *   · `watch`：长期运行的命令，**每行 stdout 一个事件**（200ms 内的行合并成一条）；
 *     事件太多（默认 1 分钟超过 20 条）自动停掉并说明；超时（默认 30 分钟、上限 2 小时）结束并通知。
 *
 * 唤醒怎么发（忙时等这一轮结束、不进排队卡片）不归这里管 —— 这里只调 `deps.wake`，
 * index.ts 把它接到 `WakeDispatcher`。
 *
 * **凭证安全**：输出只在内存里、原样交给会话，不落盘；日志里只记 jobId、命令前 80 字和退出码。
 * 重启登记（`bg-jobs.json`）里也只有标签和命令前 80 字 —— 它只为了重启后能说一句「已中断」。
 *
 * **只结束自己起的进程**：POSIX 上命令起在自己的进程组里（`detached`），按组发信号；Windows 上命令起在一个专属的
 * 作业对象里（`winJob.ts`），结束 = TerminateJobObject。不按名字、不扫进程表、不按 pid / ppid 推断归属。
 *
 * 纯 Node（不 import electron），测试直接起真进程跑。
 */

import { spawn, type ChildProcess } from 'child_process';
import { createHash, type Hash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WinJobHost, type JobHost } from './winJob.ts';
import { trIn, uiLang, type UiLang } from './uiText.ts';
import { decodeLocalOutput } from './winShell.ts';

/** `check`：定时任务的 `checkCommand`（`runCheck`）—— 结果交回调用方，不唤醒会话、不进列表 / 登记 / 名额。 */
export type BgKind = 'run' | 'watch' | 'check';
export type BgState = 'running' | 'exited' | 'failed' | 'timeout' | 'stopped' | 'rate-limited';

/** 唤醒消息里输出末尾的上限。 */
export const BG_TAIL_BYTES = 4096;
/** 内存里每个任务最多留多少输出（只为取末尾 / `bg_status`）。 */
const KEEP_BYTES = 64 * 1024;
/** 单会话同时最多几个后台命令 + 监视。 */
export const MAX_JOBS_PER_SESSION = 10;
export const BG_DEFAULT_TIMEOUT_SEC = 3600;
export const BG_MAX_TIMEOUT_SEC = 6 * 3600;
export const WATCH_DEFAULT_TIMEOUT_SEC = 30 * 60;
export const WATCH_MAX_TIMEOUT_SEC = 2 * 3600;
/** 监视：这么近的几行合并成一个事件。 */
export const WATCH_COALESCE_MS = 200;
/** 监视：一行（含一直不换行的半行）最多留多少字符，超了截断。 */
export const WATCH_MAX_LINE_CHARS = 4096;
/** 监视：合并窗口里攒着还没发的行，最多留多少字符（多了丢最老的）。 */
export const WATCH_MAX_PENDING_CHARS = 16 * 1024;
/** 监视：窗口内事件超过这么多就停掉。 */
export const WATCH_RATE_LIMIT = { events: 20, windowMs: 60_000 };
/** 命令退出之后最多再等多久把输出读完（close）。 */
const EXIT_DRAIN_MS = 1500;
/** 日志 / 重启登记里命令只留这么长。 */
export const COMMAND_HEAD = 80;

export interface BgJobView {
  jobId: string;
  sessionId: string;
  kind: BgKind;
  label: string;
  /** 只有前 80 字（给界面 / 日志 / 登记用）。 */
  command: string;
  state: BgState;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  pid: number | null;
  /** `watch`：已经发出去的事件数。 */
  events: number;
}

/** 重启登记：只够说一句「已中断」。 */
export interface BgJobRecord {
  jobId: string;
  sessionId: string;
  kind: BgKind;
  label: string;
  command: string;
  startedAt: number;
}

export interface BgJobDeps {
  /** 作为一条新消息发回会话、唤醒模型。 */
  wake(sessionId: string, text: string, job: BgJobView): void;
  /** 只在会话里说一句（不唤醒模型）—— 用户自己停掉的那种。 */
  note(sessionId: string, text: string): void;
  /** 任务集合变了（起 / 停 / 结束）。参数是此刻还在跑的那些，index.ts 据此落盘、广播给界面。 */
  changed(running: BgJobRecord[]): void;
  log(message: string): void;
  lang?(): UiLang;
  coalesceMs?: number;
  rateLimit?: { events: number; windowMs: number };
  /** Windows 作业对象（测试可以换掉；不给就用常驻的 PowerShell 辅助进程，见 winJob.ts）。 */
  jobHost?: JobHost;
}

/** `runCheck` 的结果（同 schedule.ts 的 `ScheduleCheckResult`）。`stopped`：退出 KiroLex / 删会话时被结束了。 */
export type BgCheckResult =
  /** `fingerprint`：**完整**输出（不是只看末尾 `output`）的 SHA-256，末尾的空白不算 —— 定时任务据此判断「输出变了没有」。 */
  | { status: 'exited'; code: number | null; output: string; fingerprint: string }
  | { status: 'timeout'; output: string }
  | { status: 'failed'; output: string }
  | { status: 'stopped'; output: string };

export interface BgStartInput {
  sessionId: string;
  kind: BgKind;
  command: string;
  label: string;
  cwd: string;
  timeoutMs: number;
}

interface Job extends BgJobView {
  /** 已经在收尾（清它留下的进程、然后宣布结束）—— close 和「管道不关」那条路只走一次。 */
  ending?: boolean;
  child: ChildProcess | null;
  /** 这条命令的进程归属（POSIX 进程组 / Windows 作业对象），结束只经它。 */
  owner?: ProcessOwner;
  /** 根退出之后清剩余进程的那一步（close 要等它）。 */
  reaping?: Promise<void>;
  exitCode0?: number | null;
  out: Buffer;
  /** `watch`：还没凑成事件的那几行 / 半行。 */
  pendingLines: string[];
  partial: string;
  /** `watch`：最后那半行的原始字节 —— 凑成整行再解码（Windows 上要按行判断是 UTF-8 还是本机代码页，见 winShell.ts）。 */
  partialBytes: Buffer;
  flushTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  eventTimes: number[];
  timeoutMs: number;
  /** `check`：完整输出的流式指纹（`out` 只留最后 64KB，展示也只给末尾 4KB，不能拿它们比较「变了没有」）。 */
  hash?: Hash;
  /** `check`：还没喂进指纹的末尾空白（输出末尾多一个换行不算变化）。 */
  wsTail?: Buffer;
}

/** 末尾空白最多压着这么多字节不喂进指纹，超过就照算（一直只输出空白的命令不能让它无限涨）。 */
const CHECK_WS_HOLD = 64 * 1024;

const head = (command: string): string => command.replace(/\s+/g, ' ').trim().slice(0, COMMAND_HEAD);

/*
  输出**不加 ``` 围栏**：这段文字同时是会话里的一条用户消息，而界面上带围栏的用户消息整条折叠成「粘贴内容」——
  那样连「已结束：退出码 0」这句都看不见。不加围栏时短输出原样显示，长的日志 / 代码照样折叠，开头那句留在外面。
*/

export function formatDuration(ms: number, lang: UiLang = uiLang()): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return trIn(lang, '{n} sec', { n: secs });
  const mins = Math.floor(secs / 60);
  if (mins < 60) return trIn(lang, '{m} min {s} sec', { m: mins, s: secs % 60 });
  return trIn(lang, '{h} h {m} min', { h: Math.floor(mins / 60), m: mins % 60 });
}

/** 末尾 `max` 字节（UTF-8；Windows 上不是合法 UTF-8 的行按本机代码页解），被截掉了就在前面说一声。 */
export function outputTail(buf: Buffer, max: number, lang: UiLang = uiLang()): string {
  if (buf.length <= max) return decodeLocalOutput(buf).replace(/\s+$/, '');
  let start = buf.length - max;
  /* 从一个字的中间切开的：先跳过那几个 UTF-8 续字节，不然 Windows 上这一行会被当成「不是 UTF-8」整行按代码页解 */
  if (process.platform === 'win32') for (let i = 0; i < 3 && start < buf.length && (buf[start] & 0xc0) === 0x80; i++) start++;
  const body = decodeLocalOutput(buf.subarray(start)).replace(/^�+/, '').replace(/\s+$/, '');
  return `${trIn(lang, '…(earlier output omitted, showing the last {n} bytes)', { n: max })}\n${body}`;
}

export class BgJobManager {
  private readonly jobs = new Map<string, Job>();
  /** `check` 任务结束时把结果交给谁（`runCheck` 的 Promise）。 */
  private readonly checkWaiters = new Map<string, (r: BgCheckResult) => void>();
  private seq = 0;
  private readonly deps: BgJobDeps;

  constructor(deps: BgJobDeps) {
    this.deps = deps;
  }

  private lang(): UiLang { return this.deps.lang?.() ?? uiLang(); }

  start(input: BgStartInput): { ok: true; job: BgJobView } | { ok: false; error: string } {
    const lang = this.lang();
    const command = String(input.command || '');
    if (!command.trim()) return { ok: false, error: trIn(lang, 'command is empty') };
    const live = [...this.jobs.values()].filter((j) => j.sessionId === input.sessionId && j.state === 'running' && j.kind !== 'check').length;
    if (input.kind !== 'check' && live >= MAX_JOBS_PER_SESSION) {
      return { ok: false, error: trIn(lang, 'This session already has {n} background commands / watches running (the limit is {n}). Stop one with bg_stop first', { n: MAX_JOBS_PER_SESSION }) };
    }
    try {
      if (!fs.statSync(input.cwd).isDirectory()) throw new Error('not a directory');
    } catch {
      return { ok: false, error: trIn(lang, 'The working directory does not exist: {dir}', { dir: input.cwd }) };
    }
    this.seq += 1;
    const jobId = `${input.kind === 'watch' ? 'watch' : input.kind === 'check' ? 'check' : 'bg'}_${Date.now().toString(36)}${this.seq}`;
    const job: Job = {
      jobId, sessionId: input.sessionId, kind: input.kind,
      label: String(input.label || '').trim() || head(command).slice(0, 40),
      command: head(command), state: 'running', startedAt: Date.now(), endedAt: null, exitCode: null, pid: null, events: 0,
      child: null, out: Buffer.alloc(0), pendingLines: [], partial: '', partialBytes: Buffer.alloc(0), flushTimer: null, timeoutTimer: null, eventTimes: [],
      timeoutMs: input.timeoutMs,
      ...(input.kind === 'check' ? { hash: createHash('sha256'), wsTail: Buffer.alloc(0) } : {}),
    };
    let started: { child: ChildProcess; owner: ProcessOwner };
    try {
      started = process.platform === 'win32'
        ? startInJob(command, input.cwd, jobId, this.deps.jobHost ?? defaultJobHost(this.deps.log))
        : startInGroup(command, input.cwd);
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
    const { child, owner } = started;
    job.child = child;
    job.owner = owner;
    job.pid = child.pid ?? null;
    this.jobs.set(jobId, job);
    child.stdout?.on('data', (d: Buffer) => this.onOutput(job, d, true));
    child.stderr?.on('data', (d: Buffer) => this.onOutput(job, d, false));
    child.on('error', (err) => this.finish(job, 'failed', null, String(err?.message || err)));
    /*
      **宣布结束之前先把它留下的进程清掉**：命令里 `nohup x &` / `start /b x` 放到后台的东西，shell 退了它还活着 ——
      任务一旦标成结束，界面上就停不掉它、退出 KiroLex 也不会管它。所以结束 = 这条命令的进程组 / 作业里一个都不剩
      （`owner.reapAfterExit`：只按进程组 / 作业对象结束，不按 pid 推断）。
    */
    const end = (code: number | null) => {
      if (job.ending) return;
      job.ending = true;
      void Promise.resolve(job.reaping).finally(() => this.finish(job, 'exited', code));
    };
    child.on('close', (code) => { closed.add(child); end(typeof code === 'number' ? code : job.exitCode0 ?? null); });
    child.on('exit', (code) => {
      job.exitCode0 = typeof code === 'number' ? code : null;
      job.reaping = owner.reapAfterExit().catch(() => {});
      /* 收完之后管道还被占着（收不掉的极端情况）：close 不会来，等一小会儿就按退出处理 */
      void job.reaping.then(() => setTimeout(() => {
        if (closed.has(child)) return;
        releasePipes(child);
        end(job.exitCode0 ?? null);
      }, EXIT_DRAIN_MS));
    });
    job.timeoutTimer = setTimeout(() => { void this.terminate(job, 'timeout'); }, Math.max(1, input.timeoutMs));
    this.deps.log(`start ${jobId} kind=${job.kind} session=${job.sessionId} pid=${job.pid ?? '?'} cmd=${job.command}`);
    this.announce();
    return { ok: true, job: this.view(job) };
  }

  /**
   * 定时任务的 `checkCommand`：**同一套**起进程（进程组 / 作业对象）、收尾和超时，跑完把退出码 + 输出末尾交回来。
   * 不唤醒会话（叫不叫醒模型由调用方按结果决定）、不进 `list` / 重启登记、不占单会话的名额。
   */
  runCheck(input: { sessionId: string; command: string; cwd: string; timeoutMs: number }): Promise<BgCheckResult> {
    const r = this.start({ ...input, kind: 'check', label: 'schedule check' });
    if (!r.ok) return Promise.resolve({ status: 'failed', output: r.error });
    return new Promise((resolve) => { this.checkWaiters.set(r.job.jobId, resolve); });
  }

  /** 喂进完整输出的指纹；末尾的空白先压着（之后来了非空白才一起喂），结束时丢掉。 */
  private feedFingerprint(job: Job, chunk: Buffer): void {
    const buf = job.wsTail?.length ? Buffer.concat([job.wsTail, chunk]) : chunk;
    let end = buf.length;
    while (end > 0 && (buf[end - 1] === 0x20 || buf[end - 1] === 0x09 || buf[end - 1] === 0x0a || buf[end - 1] === 0x0d)) end -= 1;
    if (buf.length - end > CHECK_WS_HOLD) end = buf.length;
    job.hash!.update(buf.subarray(0, end));
    job.wsTail = Buffer.from(buf.subarray(end));
  }

  /** `check` 任务结束：把结果交回去，从表里拿掉（它不出现在列表里，留着没用）。 */
  private settleCheck(job: Job, result: BgCheckResult): void {
    const resolve = this.checkWaiters.get(job.jobId);
    this.checkWaiters.delete(job.jobId);
    this.jobs.delete(job.jobId);
    resolve?.(result);
  }

  status(sessionId: string, jobId: string): BgJobView | null {
    const job = this.jobs.get(jobId);
    if (!job || job.sessionId !== sessionId || job.kind === 'check') return null;
    return this.view(job);
  }

  /** `bg_status` 里看的输出末尾。 */
  tail(sessionId: string, jobId: string, bytes = 2048): string | null {
    const job = this.jobs.get(jobId);
    if (!job || job.sessionId !== sessionId) return null;
    return outputTail(job.out, bytes, this.lang());
  }

  list(sessionId?: string): BgJobView[] {
    return [...this.jobs.values()]
      .filter((j) => j.kind !== 'check' && (!sessionId || j.sessionId === sessionId))
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((j) => this.view(j));
  }

  running(): BgJobRecord[] {
    return [...this.jobs.values()].filter((j) => j.state === 'running' && j.kind !== 'check')
      .map(({ jobId, sessionId, kind, label, command, startedAt }) => ({ jobId, sessionId, kind, label, command, startedAt }));
  }

  /**
   * 停掉一个。`by = 'user'`（界面上点的）会在会话里说一声；`'model'`（`bg_stop`）由工具结果说。
   * 给了 `sessionId` 就只认这条会话自己的。
   */
  async stop(jobId: string, by: 'user' | 'model', sessionId?: string): Promise<{ ok: boolean; error?: string }> {
    const job = this.jobs.get(jobId);
    const lang = this.lang();
    if (!job || job.kind === 'check' || (sessionId && job.sessionId !== sessionId)) return { ok: false, error: trIn(lang, 'No such background task: {id}', { id: jobId }) };
    if (job.state !== 'running') return { ok: true };
    await this.terminate(job, 'stopped');
    if (by === 'user') {
      this.deps.note(job.sessionId, trIn(lang, '⏹️ Background task "{label}" was stopped by the user ({id})', { label: job.label, id: job.jobId }));
    }
    return { ok: true };
  }

  /** 会话删了：它的都停掉，不再说话。 */
  async stopSession(sessionId: string): Promise<void> {
    await Promise.all([...this.jobs.values()].filter((j) => j.sessionId === sessionId && j.state === 'running')
      .map((j) => this.terminate(j, 'stopped')));
  }

  /** 退出 KiroLex：全部结束（登记不清 —— 下次启动据此补「已中断」）。 */
  async stopAll(): Promise<void> {
    await Promise.all([...this.jobs.values()].filter((j) => j.state === 'running').map((j) => this.terminate(j, 'stopped', true)));
  }

  /** Windows：KiroLex 启动后提前起好作业对象辅助进程，第一个后台命令就不用等 PowerShell 启动 / 编译。 */
  warmUp(): void {
    if (process.platform === 'win32') (this.deps.jobHost ?? defaultJobHost(this.deps.log)).warm?.();
  }

  /**
   * 退出路径用的**同步**版：`before-quit` 不等 Promise，异步的结束来不及做完进程就退了，
   * 留下没人管的命令。登记不清（见 `stopAll`）。
   */
  stopAllSync(): void {
    for (const job of this.jobs.values()) {
      if (job.state !== 'running') continue;
      job.state = 'stopped';
      job.endedAt = Date.now();
      this.clearTimers(job);
      this.deps.log(`end ${job.jobId} state=stopped(quit) exit=n/a cmd=${job.command}`);
      job.owner?.killAllSync();
      if (job.kind === 'check') this.settleCheck(job, { status: 'stopped', output: '' });
    }
    /* Windows：结束辅助进程 —— 它握着的作业句柄一关，所有作业里剩下的进程都由系统结束（含已经在收尾的那些） */
    if (process.platform === 'win32') (this.deps.jobHost ?? sharedJobHost)?.killAllSync();
  }

  /* ------------------------------------------------------------------ 内部 */

  private view(job: Job): BgJobView {
    const { jobId, sessionId, kind, label, command, state, startedAt, endedAt, exitCode, pid, events } = job;
    return { jobId, sessionId, kind, label, command, state, startedAt, endedAt, exitCode, pid, events };
  }

  private announce(quiet = false): void {
    if (quiet) return;
    try { this.deps.changed(this.running()); } catch { /* 广播失败不影响任务本身 */ }
  }

  private onOutput(job: Job, chunk: Buffer, isStdout: boolean): void {
    if (job.kind === 'check' && job.hash) this.feedFingerprint(job, chunk);
    job.out = Buffer.concat([job.out, chunk]);
    if (job.out.length > KEEP_BYTES) job.out = job.out.subarray(job.out.length - KEEP_BYTES);
    if (job.kind !== 'watch' || !isStdout || job.state !== 'running') return;
    /* 按字节凑整行再解码：一个字被拆在两块里时不会解坏；还没换行的那半行留在 `partialBytes` */
    const bytes = job.partialBytes.length ? Buffer.concat([job.partialBytes, chunk]) : chunk;
    let whole = bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
    let rest = bytes.subarray(whole.length);
    /* 半行太长（字节数超过字数上限）：整块交给下面按字数截的那段 */
    if (rest.length > WATCH_MAX_LINE_CHARS) { whole = bytes; rest = Buffer.alloc(0); }
    job.partialBytes = Buffer.from(rest);
    const text = job.partial + decodeLocalOutput(whole);
    const lines = text.split(/\r?\n/);
    job.partial = lines.pop() ?? '';
    /*
      **一直输出却不换行**（进度条、二进制、单行 JSON 流）：半行不能无限攒 —— 那样内存一直涨，
      而且永远不成事件、连限流都轮不到。到上限就把它当成一行截下来发，后面的接着算下一行。
    */
    while (job.partial.length > WATCH_MAX_LINE_CHARS) {
      lines.push(job.partial.slice(0, WATCH_MAX_LINE_CHARS));
      job.partial = job.partial.slice(WATCH_MAX_LINE_CHARS);
    }
    const fresh = lines.filter((l) => l.trim() !== '').map((l) => (l.length > WATCH_MAX_LINE_CHARS ? l.slice(0, WATCH_MAX_LINE_CHARS) : l));
    if (!fresh.length) return;
    job.pendingLines.push(...fresh);
    /* 合并窗口里攒着的也有上限：只留最新的那些（反正一个事件只发末尾 4KB） */
    let pending = job.pendingLines.reduce((n, l) => n + l.length, 0);
    while (pending > WATCH_MAX_PENDING_CHARS && job.pendingLines.length > 1) pending -= job.pendingLines.shift()!.length;
    if (!job.flushTimer) job.flushTimer = setTimeout(() => this.flushWatch(job), this.deps.coalesceMs ?? WATCH_COALESCE_MS);
  }

  /** 把攒着的几行作为一个事件发出去；先过限流。 */
  private flushWatch(job: Job): void {
    if (job.flushTimer) { clearTimeout(job.flushTimer); job.flushTimer = null; }
    if (job.state !== 'running' || !job.pendingLines.length) return;
    const lines = job.pendingLines.splice(0);
    const limit = this.deps.rateLimit ?? WATCH_RATE_LIMIT;
    const now = Date.now();
    job.eventTimes = job.eventTimes.filter((t) => now - t < limit.windowMs);
    if (job.eventTimes.length >= limit.events) {
      void this.terminate(job, 'rate-limited');
      return;
    }
    job.eventTimes.push(now);
    job.events += 1;
    const lang = this.lang();
    const body = outputTail(Buffer.from(lines.join('\n'), 'utf8'), BG_TAIL_BYTES, lang);
    this.deps.wake(job.sessionId, `${trIn(lang, '👀 Watch "{label}" ({id}) new output:', { label: job.label, id: job.jobId })}\n${body}`, this.view(job));
  }

  /** 由我们结束它（超时 / 限流 / 停止）。状态先定下来，之后进程的 close 不再另发消息。 */
  private async terminate(job: Job, why: 'timeout' | 'stopped' | 'rate-limited', quiet = false): Promise<void> {
    if (job.state !== 'running') return;
    if (job.kind === 'watch' && why !== 'rate-limited' && why !== 'stopped') {
      this.flushWatch(job);
      /* 最后这一批恰好触发了限流：那边已经停掉并通知过了，这里不再另发一条 */
      if (job.state !== 'running') return;
    }
    job.state = why;
    job.endedAt = Date.now();
    this.clearTimers(job);
    this.deps.log(`end ${job.jobId} state=${why} exit=n/a cmd=${job.command}`);
    this.announce(quiet);
    const lang = this.lang();
    if (job.kind === 'check') {
      await killAndWait(job);
      this.settleCheck(job, { status: why === 'timeout' ? 'timeout' : 'stopped', output: outputTail(job.out, BG_TAIL_BYTES, lang) });
      return;
    }
    const dur = formatDuration(job.endedAt - job.startedAt, lang);
    if (why === 'timeout') {
      const text = job.kind === 'watch'
        ? trIn(lang, '👀 Watch "{label}" reached its time limit ({dur}) and was stopped ({id})', { label: job.label, dur, id: job.jobId })
        : `${trIn(lang, '🔔 Background command "{label}" timed out after {dur} and was stopped ({id})', { label: job.label, dur, id: job.jobId })}\n\n${this.tailBlock(job, lang)}`;
      this.deps.wake(job.sessionId, text, this.view(job));
    } else if (why === 'rate-limited') {
      const limit = this.deps.rateLimit ?? WATCH_RATE_LIMIT;
      this.deps.wake(job.sessionId, trIn(lang, '👀 Watch "{label}" was stopped: too many events (more than {n} within {sec} sec). Use a command that prints less often, or filter its output ({id})', {
        label: job.label, n: limit.events, sec: Math.round(limit.windowMs / 1000), id: job.jobId,
      }), this.view(job));
    }
    await killAndWait(job);
  }

  private tailBlock(job: Job, lang: UiLang): string {
    const tail = outputTail(job.out, BG_TAIL_BYTES, lang);
    return tail ? `${trIn(lang, 'Last output:')}\n${tail}` : trIn(lang, '(no output)');
  }

  /** 进程自己结束了（或根本没起来）。 */
  private finish(job: Job, state: 'exited' | 'failed', code: number | null, error?: string): void {
    if (job.state !== 'running') return;
    if (job.kind === 'watch') {
      if (job.partialBytes.length) { job.partial += decodeLocalOutput(job.partialBytes); job.partialBytes = Buffer.alloc(0); }
      if (job.partial.trim()) { job.pendingLines.push(job.partial); job.partial = ''; }
      this.flushWatch(job);
      /* 同上：最后一批触发了限流就以限流为准，只通知那一次 */
      if (job.state !== 'running') return;
    }
    job.state = state;
    job.exitCode = code;
    job.endedAt = Date.now();
    this.clearTimers(job);
    this.deps.log(`end ${job.jobId} state=${state} exit=${code ?? 'n/a'} cmd=${job.command}`);
    this.announce();
    const lang = this.lang();
    if (job.kind === 'check') {
      const output = state === 'failed' ? String(error || '') : outputTail(job.out, BG_TAIL_BYTES, lang);
      this.settleCheck(job, state === 'failed' ? { status: 'failed', output } : { status: 'exited', code, output, fingerprint: `sha256:${job.hash!.digest('hex')}` });
      return;
    }
    const dur = formatDuration(job.endedAt - job.startedAt, lang);
    let text: string;
    if (state === 'failed') {
      text = trIn(lang, '🔔 Background command "{label}" could not run: {why} ({id})', { label: job.label, why: String(error || ''), id: job.jobId });
    } else if (job.kind === 'watch') {
      text = trIn(lang, '👀 Watch "{label}" ended: the command exited with code {code} ({id})', { label: job.label, code: code ?? '?', id: job.jobId });
    } else {
      text = `${trIn(lang, '🔔 Background command "{label}" finished: exit code {code}, ran {dur} ({id})', { label: job.label, code: code ?? '?', dur, id: job.jobId })}\n\n${this.tailBlock(job, lang)}`;
    }
    this.deps.wake(job.sessionId, text, this.view(job));
  }

  private clearTimers(job: Job): void {
    if (job.timeoutTimer) { clearTimeout(job.timeoutTimer); job.timeoutTimer = null; }
    if (job.flushTimer) { clearTimeout(job.flushTimer); job.flushTimer = null; }
  }
}

/* ------------------------------------------------ 进程归属：进程组 / 作业对象 */

/*
  **这条命令起的进程只按「进程组」（POSIX）/「作业对象」（Windows）认** —— 不从进程快照里按 pid / ppid / 出生时间推断。
  推断那条路连续几轮都栽在 pid 复用上（父进程退了、pid 被无关程序拿走，它的子孙一样对得上），所以整段删掉了。
  放不进进程组 / 作业对象的极端情况：只结束 KiroLex 自己握着句柄的那个进程，别的一个不碰。
*/

/** 一条命令的进程归属。 */
export interface ProcessOwner {
  /** 命令本身（根）退出之后：组里 / 作业里还剩下的（`nohup x &` / `start /b x`）全部结束。 */
  reapAfterExit(): Promise<void>;
  /** 停止 / 超时 / 限流：结束这条命令的全部进程。 */
  killAll(): Promise<void>;
  /** 退出 KiroLex 的同步版（before-quit 不等 Promise）。 */
  killAllSync(): void;
}

/** 已经 close（管道都关了）的子进程 —— 光看 exitCode 不够：根退了而管道还被别人占着时 close 不会来。 */
const closed = new WeakSet<ChildProcess>();

/** 把**我们这一头**的管道放掉 —— 极端情况下组 / 作业里的进程没收掉、还占着管道时用，别让主进程为它挂着。 */
function releasePipes(child: ChildProcess): void {
  try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* 已经关了 */ }
}

/** 进程组里还有没有进程（`kill(-pgid, 0)`）。组里还有进程时 pgid 不会被复用，所以这个判断是可靠的。 */
export function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (err: any) { return err?.code === 'EPERM'; }
}

/** POSIX：给整个进程组发信号；3 秒后组里还有人就 SIGKILL。 */
async function killGroup(pgid: number): Promise<void> {
  if (!groupAlive(pgid)) return;
  try { process.kill(-pgid, 'SIGTERM'); } catch { return; }
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    if (!groupAlive(pgid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* 组里没人了 */ }
}

/**
 * macOS / Linux：`bash -lc` 起在**自己的进程组**里（`detached`，pgid = 它的 pid）。结束 = 给这个组发信号；
 * 命令自己退了以后，`kill(-pgid, 0)` 看组里还有没有残留，有就同样结束。
 * 组建不起来是不可能的（`detached` 由 spawn 保证）；万一 `kill(-pgid)` 失败，只对我们握着的那个子进程发信号。
 */
function startInGroup(command: string, cwd: string): { child: ChildProcess; owner: ProcessOwner } {
  const child = spawn('bash', ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pgid = child.pid;
  const own = (sig: NodeJS.Signals) => { try { child.kill(sig); } catch { /* 已经没了 */ } };
  const owner: ProcessOwner = {
    reapAfterExit: async () => { if (pgid) await killGroup(pgid); },
    killAll: async () => {
      if (!pgid) return;
      if (groupAlive(pgid)) await killGroup(pgid);
      else if (child.exitCode === null) own('SIGTERM');   // 组信号发不出去（极端情况）：只碰我们握着的那个
    },
    killAllSync: () => {
      if (!pgid) return;
      try { process.kill(-pgid, 'SIGKILL'); } catch { if (child.exitCode === null) own('SIGKILL'); }
    },
  };
  return { child, owner };
}

/**
 * Windows 上的「闸门」：一个先被放进作业、**收到 `go` 之后**才起真正那条命令的 node 小进程。
 *
 * 为什么要它：作业对象只能在进程起来之后才放进去，直接起 cmd.exe 的话，它在放进去之前那一瞬间起的子进程会漏在外面。
 * 闸门起来后先停着，作业放好了再起命令 —— 命令和它之后起的一切都在作业里。闸门的 stdout / stderr 就是我们的管道，
 * 命令直接继承，输出照样回来；闸门以命令的退出码退出。
 *
 * 实测（IsProcessInJob）：闸门、它起的 cmd.exe、cmd 起的进程、那些进程再起的（含 Node `detached` 起的）都在作业里。
 * 唯一会漏出去的形状是「先起来、后放进作业的 node 进程自己用 `detached` 起子进程」—— 闸门就是那种进程，所以它
 * **只用非 detached 的方式**起 cmd.exe，别改。
 *
 * 放不进作业时（极端失败）它就是「我们握着句柄的那个进程」：收到 `kill` 只结束它自己起的那条命令（它握着句柄），
 * 我们这边断开（KiroLex 退出 / 崩溃）时同样结束它，不碰别的。
 */
const GATE = `
const { spawn, spawnSync } = require('child_process');
let child = null; let buf = '';
const env = Object.assign({}, process.env);
const command = env.KX_BG_COMMAND || '';
delete env.KX_BG_COMMAND; delete env.ELECTRON_RUN_AS_NODE;
const stop = (code) => { if (child && child.exitCode === null) { try { child.kill(); } catch (e) {} } process.exit(code); };
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line === 'go' && !child) {
      /* UTF-8 代码页：闸门自己有一个（隐藏的）控制台 —— 先在它上面 chcp 65001，再起 cmd 并**共用**这个控制台
         （不带 windowsHide：带了会给 cmd 另开一个新控制台，代码页又回到默认）。cmd 启动时就记下代码页，所以 chcp 必须在它之前。
         路径要是反斜杠：chcp 自己解析整条命令行，「C:/Windows/...」 里的 「/Windows」 会被当成参数而报错 */
      try { spawnSync(require('path').join(process.env.SystemRoot || 'C:/Windows', 'System32', 'chcp.com'), ['65001'], { stdio: 'ignore' }); } catch (e) {}
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + command + '"'], { stdio: ['ignore', 'inherit', 'inherit'], windowsVerbatimArguments: true, env });
      child.on('exit', (c) => process.exit(typeof c === 'number' ? c : 1));
      child.on('error', (e) => { process.stderr.write(String(e && e.message) + '\\n'); process.exit(127); });
    } else if (line === 'kill') stop(137);
  }
});
process.stdin.on('end', () => stop(child ? 137 : 0));
`;

let sharedJobHost: JobHost | null = null;
function defaultJobHost(log: (m: string) => void): JobHost {
  /* 编译好的 C#（dll）缓存在 ~/.kirolex/cache，下次启动直接加载 */
  if (!sharedJobHost) sharedJobHost = new WinJobHost((m) => log(`job: ${m}`), undefined, path.join(os.homedir(), '.kirolex', 'cache'));
  return sharedJobHost;
}

function startInJob(command: string, cwd: string, jobId: string, host: JobHost): { child: ChildProcess; owner: ProcessOwner } {
  const child = spawn(process.execPath, ['-e', GATE], {
    cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KX_BG_COMMAND: command },
  });
  let cancelled = false;
  let inJob: boolean | null = null;   // null = 还没放好
  const say = (line: string) => { try { child.stdin?.write(`${line}\n`); } catch { /* 闸门已经没了 */ } };
  /*
    下一拍再去放：第一次起辅助进程那一下 spawn 会同步卡住好几秒，不能卡在 bg_run 的「立即返回」上。

    **答复之前闸门一定活着**：辅助进程是按 pid 去打开它的，闸门要是在这之前退了，pid 就可能被别的程序复用、
    被放进作业、然后被结束。所以：闸门已经退了就不去放；放的过程中（不管多久）**谁都不结束闸门**——
    停止 / 超时只记下 `cancelled`，等答复之后再按结果处理（放好了 → 结束作业；没放进去 → 让闸门自己退出）。
    闸门在收到 go 之前什么都不做，等着它不会让任何命令跑起来。
  */
  let settled = false;
  const assigned: Promise<boolean> = new Promise<void>((r) => setTimeout(r, 0))
    .then(() => (child.pid && child.exitCode === null && child.signalCode === null ? host.assign(jobId, child.pid) : false))
    .catch(() => false)
    .then(async (ok) => {
      inJob = ok;
      settled = true;
      if (!cancelled) { say('go'); return ok; }
      /* 等的期间被停掉了：命令没放行过 */
      if (ok) await host.terminate(jobId);
      else say('kill');
      return ok;
    });
  const owner: ProcessOwner = {
    reapAfterExit: async () => { if (await assigned) await host.terminate(jobId); },
    killAll: async () => {
      cancelled = true;
      /* 作业还没放好：不碰闸门，等答复（见上） */
      if (!settled) { await assigned; return; }
      if (inJob) { await host.terminate(jobId); return; }
      /* 放不进作业：只让闸门结束它自己握着的那条命令 */
      say('kill');
    },
    killAllSync: () => {
      cancelled = true;
      /* 作业里的由 `jobHost.killAllSync()` 一起收（manager 的 stopAllSync）；放不进作业的那种让闸门结束它自己的命令。
         还没放好的：辅助进程随之没了，答复就是「没放进去」，再由上面那段让闸门退出 —— 这里同样不先碰它 */
      if (settled) say('kill');
    },
  };
  return { child, owner };
}

/** 结束这个任务，并等它的管道关上（最多 3 秒；还不关就放掉我们这一头，别让主进程为它挂着）。 */
async function killAndWait(job: { child: ChildProcess | null; owner?: ProcessOwner }): Promise<void> {
  const child = job.child;
  if (!child || closed.has(child)) return;
  await job.owner?.killAll();
  await new Promise<void>((resolve) => {
    if (closed.has(child)) { resolve(); return; }
    const t = setTimeout(() => {
      releasePipes(child);
      try { child.unref(); } catch {}
      resolve();
    }, 3000);
    child.once('close', () => { clearTimeout(t); resolve(); });
  });
}

/* ------------------------------------------------- 重启：跑着的任务留下「已中断」 */

function registryFile(home: string): string {
  return path.join(home, '.kirolex', 'bg-jobs.json');
}

/** 正在跑的那些写下来（tmp + rename）。只有标签、命令前 80 字和时间 —— 没有输出。 */
export function writeRunningJobs(home: string, jobs: BgJobRecord[]): void {
  const file = registryFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = jobs.map((j) => ({ jobId: j.jobId, sessionId: j.sessionId, kind: j.kind, label: j.label, command: head(j.command), startedAt: j.startedAt }));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/** 启动时读一次上次没结束的那些，读完清空（同一条「已中断」不会每次启动都补一遍）。 */
export function takeInterruptedJobs(home: string): BgJobRecord[] {
  const file = registryFile(home);
  let rows: BgJobRecord[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Array.isArray(parsed)) rows = parsed.filter((r) => r && typeof r.jobId === 'string' && typeof r.sessionId === 'string');
  } catch { /* 没有 / 坏了：当作没有 */ }
  try { fs.rmSync(file, { force: true }); } catch { /* 下次再说 */ }
  return rows;
}

export function interruptedNotice(job: BgJobRecord, lang: UiLang = uiLang()): string {
  return trIn(lang, '⚠️ KiroLex restarted, so background task "{label}" ({id}) was interrupted and is no longer running', { label: job.label, id: job.jobId });
}
