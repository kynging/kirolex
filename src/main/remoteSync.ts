/**
 * **同步点的编排** —— 远程会话（`docs/DESIGN_remote_sessions.md`）。
 *
 * `remoteMirror` 知道怎么搬文件，这里决定**什么时候搬、搬不动怎么办**。放成单独一层是因为这几条
 * 规则都是"错了会安静地给出错答案"的那一类，必须能脱开 electron 单测：
 *
 *   ① 发 prompt 之前推不上去 → **这一轮不发**。让模型读着旧文件干活，产出看起来对、其实是对着
 *      上一版写的 —— 那种错最难发现，比一条明确的"没发出去"糟得多。
 *   ② 一轮结束拉不回来 → 记一个"远端有未取回的改动"，并且**说出来**。不说的话你会以为本地是新的。
 *   ③ 工具写文件时防抖拉 → 这是让 gate / file review 看起来是活的那一半。
 *   ④ review 渲染之前按需拉 → 拿旧文件做 review 比不做更糟。
 *
 * 还有两条是"两边同时写同一份真相"的防线：
 *   · 同一个项目同一时刻只允许一条会话跑一轮（拒绝，不排队 —— 一轮可能很久，排队看起来就是卡住）
 *   · 拉永远不覆盖你刚改过的文件（冲突判定在 `remoteMirror`），远端那份落成 `<file>.remote`
 *
 * 拉之间**不许并行**：两个 rsync 同时往一个目录里写，谁赢谁输不确定。所以每条会话一条串行链。
 */

import type { PullResult, PushResult } from './remoteMirror.ts';

/** 防抖窗口：工具连着写十个文件时只拉一次。 */
export const PULL_DEBOUNCE_MS = 800;

/**
 * **同步慢到这个程度就要在会话里说话** ——「为啥远程会话一直没有响应」。
 *
 * 实测那次：推送跑了 3 分钟还没完（家目录，2.6 GB），而聊天里**一个字都没有** ——
 * 侧栏那个 ↑ 太小、也说不出"在等什么、等了多久"。人只能得出"它挂了"这个结论。
 *
 * 15 秒是按正常情况选的：一个普通项目的增量推送实测 10 秒上下（第一次全量），
 * 所以 15 秒之后还没完 = 确实不正常，值得占一行。之后每 30 秒续报一次，让人知道它还活着。
 */
export const SLOW_SYNC_NOTICE_MS = 15_000;
export const SLOW_SYNC_REPEAT_MS = 30_000;

export interface MirrorLike {
  readonly localDir: string;
  readonly remoteDir: string;
  push(): Promise<PushResult>;
  pull(): Promise<PullResult>;
  /** 掐掉正在跑的那次同步（Stop 要能真的停下来，而不只是界面显示停了）。 */
  cancel?(): void;
}

export interface SyncTarget {
  sessionId: string;
  /** 项目镜像（agent 的 cwd）。 */
  project: MirrorLike;
  /** 会话目录镜像（`history.md`、附件）—— 它在项目目录之外，必须单独推。 */
  session?: MirrorLike;
  /** 给人看的机器名，进提示语。 */
  hostLabel: string;
}

/**
 * 界面上要显示的同步状态。
 *
 * `stale` 是这里面最要紧的一个：**本地不是最新的**。不把它显出来，人就会对着旧文件 review，
 * 而那些建议再被送回模型就变成一串谁都对不上的修改。
 */
export type SyncState = 'idle' | 'pushing' | 'pulling' | 'stale' | 'conflict';

export interface SyncStatus {
  sessionId: string;
  state: SyncState;
  hostLabel: string;
  /** `conflict` 时有值：哪些文件两边都改过。 */
  conflicts?: string[];
  /** `stale` 时有值：为什么没取回来。 */
  error?: string;
}

export interface SyncDeps {
  /** 在会话里说一句（`kirolex: true`，不发给模型）。 */
  note(sessionId: string, text: string): void;
  log(level: 'info' | 'warn', message: string): void;
  /** 状态变了告诉界面（同一个状态不重复发）。 */
  onStatus?(status: SyncStatus): void;
  /**
   * 一次**成功的拉**之后（用来把摆渡进来的本地文件写回原处，见 `localFileBridge`）。
   * 放在这里而不是 `RemoteMirror` 里：写回是"镜像之外"的事，镜像只管两个目录之间的同步。
   */
  afterPull?(sessionId: string): void;
  /** 防抖用；注入是为了测试里不真的等 800ms。 */
  schedule?(fn: () => void, ms: number): void;
  /** 周期性提示用（注入是为了测试里不真的等 15 秒）。返回一个"取消"函数。 */
  interval?(fn: () => void, ms: number): () => void;
  now?(): number;
}

export interface SessionBusyInfo {
  sessionId: string;
  /** 本地项目目录（同一个目录才算"同一个项目"）。 */
  localDir: string;
  busy: boolean;
}

/**
 * 同一个项目上是否已经有另一条会话在跑一轮。
 *
 * 判据是**本地目录**而不是 projectId：镜像和冲突都是按目录算的，而两条会话可以指着同一个目录
 * 却没有同一个 projectId（`~` 起的会话就没有 projectId）。
 */
export function busyPeer(sessions: SessionBusyInfo[], me: { sessionId: string; localDir: string }): string | undefined {
  const mine = normDir(me.localDir);
  if (!mine) return undefined;
  const hit = (sessions || []).find((s) => s && s.busy && s.sessionId !== me.sessionId && normDir(s.localDir) === mine);
  return hit?.sessionId;
}

function normDir(p: string | undefined): string {
  return String(p || '').replace(/\/+$/, '');
}

export class RemoteSyncManager {
  private targets = new Map<string, SyncTarget>();
  /** 每条会话一条串行链 —— 两个 rsync 同时写一个目录，结果不确定。 */
  private chain = new Map<string, Promise<unknown>>();
  private debounced = new Set<string>();
  /** 拉失败留下的债：本地**不是**最新的，必须让人知道。 */
  private owed = new Set<string>();
  /** 最近一次发给界面的状态（去重 + 重新挂载时能问）。 */
  private last = new Map<string, SyncStatus>();
  private deps: SyncDeps;

  constructor(deps: SyncDeps) {
    this.deps = deps;
  }

  register(target: SyncTarget): void {
    this.targets.set(target.sessionId, target);
  }

  forget(sessionId: string): void {
    this.targets.delete(sessionId);
    this.chain.delete(sessionId);
    this.owed.delete(sessionId);
    this.last.delete(sessionId);
  }

  isRemote(sessionId: string): boolean {
    return this.targets.has(sessionId);
  }

  /** 本地是不是欠着一次拉（界面上要看得见）。 */
  hasUnpulled(sessionId: string): boolean {
    return this.owed.has(sessionId);
  }

  /** 当前状态（界面重新挂载时要能问一次，不能只靠事件）。 */
  statusOf(sessionId: string): SyncStatus | undefined {
    const t = this.targets.get(sessionId);
    if (!t) return undefined;
    return this.last.get(sessionId) || { sessionId, state: 'idle', hostLabel: t.hostLabel };
  }

  private emit(sessionId: string, state: SyncState, extra: Partial<SyncStatus> = {}): void {
    const t = this.targets.get(sessionId);
    if (!t) return;
    const status: SyncStatus = { sessionId, state, hostLabel: t.hostLabel, ...extra };
    const prev = this.last.get(sessionId);
    /*
      **同一个状态连着来两次只发一次**。这里挡的是"界面闪"，不是"少报一次失败"：
      拉失败之后再试一次又失败，中间会经过 `pulling`，所以那两次 `stale` 都会发出去 ——
      那不是重复，是"又试了一次还是不行"，人需要看到它。
    */
    if (prev && prev.state === status.state
      && (prev.conflicts || []).join() === (status.conflicts || []).join()
      && prev.error === status.error) return;
    this.last.set(sessionId, status);
    this.deps.onStatus?.(status);
  }

  /**
   * 同步超过 `SLOW_SYNC_NOTICE_MS` 就在会话里说一句，之后每 `SLOW_SYNC_REPEAT_MS` 续报。
   * 返回"停止提示"的函数（同步一结束就调它）。
   */
  private startSlowNotice(sessionId: string, hostLabel: string, what: string): () => void {
    const started = (this.deps.now || Date.now)();
    const every = this.deps.interval
      || ((fn: () => void, ms: number) => { const h = setInterval(fn, ms); h.unref?.(); return () => clearInterval(h); });
    /*
      定时器按**一个**周期跑（15s），说不说话由"距上次说话多久"决定 ——
      第一句在 15s，之后每 30s 一句。用两个 setInterval 去换周期只会多一处状态要对齐。
    */
    let lastSaid = 0;
    const stop = every(() => {
      const now = (this.deps.now || Date.now)();
      const secs = Math.round((now - started) / 1000);
      if (!lastSaid) {
        lastSaid = now;
        this.deps.note(sessionId, `⏳ 正在${what} ${hostLabel}（已 ${secs}s）——`
          + `这一轮要等同步完才会发出去。想停可以直接按 Stop。`);
        return;
      }
      if (now - lastSaid < SLOW_SYNC_REPEAT_MS) return;
      lastSaid = now;
      this.deps.note(sessionId, `⏳ 还在${what} ${hostLabel}（已 ${secs}s）。`);
    }, SLOW_SYNC_NOTICE_MS);
    return stop;
  }

  /** 退出前把**所有**会话正在跑的同步掐掉（见 `cancel` 里那段孤儿进程的账）。 */
  cancelAll(): void {
    for (const sessionId of Array.from(this.targets.keys())) this.cancel(sessionId);
  }

  /**
   * **停止**：把正在跑的同步掐掉。
   *
   * 不掐的话按了 Stop 也要等 rsync 自己跑完（上限 10 分钟）—— 那等于 Stop 没用。
   *
   * 更要紧的是**退出**时也得掐（`cancelAll`）：实测 KiroLex 被杀之后正在跑的 rsync 没死，
   * 被 launchd 收养（`ppid=1`）继续推了 6.1 GB —— 没人会读它的结果，而它把上行吃光，
   * 于是别的会话看起来"也挂了"。
   */
  cancel(sessionId: string): void {
    const t = this.targets.get(sessionId);
    if (!t) return;
    t.project.cancel?.();
    t.session?.cancel?.();
    this.deps.log('info', `remote sync 已停止 sessionId=${sessionId}`);
  }

  /** 串进这条会话的链里 —— 保证同一条会话的同步一次一个。 */
  private serial<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chain.get(sessionId) || Promise.resolve();
    const next = prev.then(fn, fn);
    /* 链上的失败不能把后面的都毒死 */
    this.chain.set(sessionId, next.catch(() => {}));
    return next;
  }

  /**
   * 发 prompt 之前：把本地推上去。**推不上去就抛** —— 调用方据此不发这一轮。
   */
  async beforeTurn(sessionId: string): Promise<void> {
    const t = this.targets.get(sessionId);
    if (!t) return;
    await this.serial(sessionId, async () => {
      this.emit(sessionId, 'pushing');
      /* 慢了就说话 —— 见 `SLOW_SYNC_NOTICE_MS`。说完之后每 30 秒续报，让人知道它还活着。 */
      const stopNotice = this.startSlowNotice(sessionId, t.hostLabel, '把本地推到');
      const results: [string, PushResult][] = [];
      try {
        results.push(['项目', await t.project.push()]);
        if (t.session) results.push(['会话目录', await t.session.push()]);
      } finally {
        stopNotice();
      }
      const bad = results.find(([, r]) => !r.ok);
      if (bad) {
        const [what, r] = bad;
        /*
          这里**必须**抛。推不上去意味着远端那份是旧的，而模型看不出新旧 ——
          它会照着上一版改，产出看起来完全正常。宁可这一轮不发。
        */
        throw new Error(
          `这一轮没有发送：${t.hostLabel} 的${what}镜像没同步上去（${r.error || '未知原因'}）。`
          + `远端会读到旧文件，所以先不发。修好连接后再发一次即可（你的消息还在）。`,
        );
      }
      const ms = results.reduce((a, [, r]) => a + r.ms, 0);
      this.emit(sessionId, 'idle');
      this.deps.log('info', `remote push ok sessionId=${sessionId} host=${t.hostLabel} ${ms}ms`);
    });
  }

  /** 一轮结束：把远端的改动取回来。失败**不抛**（这一轮已经成了），但要留债 + 说一句。 */
  async afterTurn(sessionId: string): Promise<void> {
    if (!this.targets.has(sessionId)) return;
    await this.serial(sessionId, () => this.pullOnce(sessionId, '一轮结束'));
  }

  /** 工具写了文件：防抖拉一次，让界面看起来是活的。不等它。 */
  pullSoon(sessionId: string): void {
    if (!this.targets.has(sessionId)) return;
    if (this.debounced.has(sessionId)) return;
    this.debounced.add(sessionId);
    const run = () => {
      this.debounced.delete(sessionId);
      void this.serial(sessionId, () => this.pullOnce(sessionId, '工具写文件', true));
    };
    (this.deps.schedule || ((fn, ms) => { setTimeout(fn, ms).unref?.(); }))(run, PULL_DEBOUNCE_MS);
  }

  /**
   * review / diff 渲染之前：现在就拉，并且**等它**。
   *
   * 失败要让调用方知道（返回 false）：拿旧文件做 review 比不做更糟 —— 你会对着上一版提建议，
   * 而那些建议再被送回模型，就变成了一串谁都对不上的修改。
   */
  async pullNow(sessionId: string): Promise<boolean> {
    if (!this.targets.has(sessionId)) return true;
    const r = await this.serial(sessionId, () => this.pullOnce(sessionId, 'review 之前'));
    return r.ok;
  }

  private async pullOnce(sessionId: string, why: string, quiet = false): Promise<PullResult> {
    const t = this.targets.get(sessionId);
    if (!t) return { ok: true, changed: [], conflicts: [], ms: 0 };
    this.emit(sessionId, 'pulling');
    const stopNotice = this.startSlowNotice(sessionId, t.hostLabel, '从远端取回改动');
    let r: PullResult;
    try {
      r = await t.project.pull();
    } finally {
      stopNotice();
    }
    if (!r.ok) {
      this.owed.add(sessionId);
      this.emit(sessionId, 'stale', { error: r.error });
      this.deps.log('warn', `remote pull FAILED sessionId=${sessionId} (${why}): ${r.error}`);
      /* 静默的那条路（防抖）也要说 —— "本地不是最新的"是绝对不能沉默的一件事 */
      this.deps.note(sessionId, `⚠️ 远端（${t.hostLabel}）有改动没取回来：${r.error || '同步失败'}。`
        + `本地这份**不是**最新的，别急着 review；连接恢复后会自动再试。`);
      return r;
    }
    this.owed.delete(sessionId);
    /* 摆渡进来的本地文件写回原处（远端改过的那些）—— 见 `localFileBridge.writeBack` */
    try { this.deps.afterPull?.(sessionId); } catch { /* 写回失败不该影响这次拉的结论 */ }
    this.emit(sessionId, r.conflicts.length ? 'conflict' : 'idle', r.conflicts.length ? { conflicts: r.conflicts } : {});
    if (r.conflicts.length) {
      /* 冲突必须说，而且要说清"你的那份没被动" —— 否则人第一反应是"我的修改被覆盖了" */
      this.deps.note(sessionId, `⚠️ 这些文件你和远端都改过，**本地那份没有动**，远端那份放在旁边了：`
        + r.conflicts.map((p) => `\`${p}\` → \`${p}.remote\``).join('、'));
    }
    if (!quiet || r.changed.length) {
      this.deps.log('info', `remote pull ok sessionId=${sessionId} (${why}) 改了 ${r.changed.length} 个文件`
        + `${r.conflicts.length ? `，冲突 ${r.conflicts.length}` : ''} ${r.ms}ms`);
    }
    return r;
  }
}

/**
 * 工具调用是不是"写了文件"。
 *
 * 判宽一点无害（多拉一次而已），判窄了会让 gate/review 看着上一版 —— 所以读类的关键词只挡掉
 * 最明确的那几个，其余一律当成可能写过。
 */
export function toolMayHaveWritten(kindOrTitle: string | undefined, rawInput?: unknown): boolean {
  const s = `${kindOrTitle || ''} ${safeJson(rawInput)}`.toLowerCase().trim();
  if (!s || s === '{}' || s === '[]') return false;
  /*
    纯读：明确排除，别为每一次 grep 都拉一遍。
    词尾要放宽（`Listing directory` / `Reading x` / `searched`）—— 卡在 `\blist\b` 上就会漏掉
    最常见的那几个标题，然后每次列目录都触发一次全量 dry-run。
  */
  const reads = /\b(read|grep|search|glob|list|ls|cat|view|find|fetch)\w*\b/;
  const writes = /\b(write|edit|creat|patch|apply|mv|cp|rm|touch|format|sed|install|generat)\w*\b/;
  if (reads.test(s) && !writes.test(s)) return false;
  return true;
}

function safeJson(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    /* `'""'` / `'{}'` 这类"空的 JSON"要算空 —— 否则一个没带参数的调用会被判成"写过文件" */
    return /^(""|''|\{\}|\[\]|null)$/.test(String(s || '').trim()) ? '' : String(s || '');
  } catch { return ''; }
}
