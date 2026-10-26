/**
 * **`mcp-combos.json` 改了 → 正在用受影响组合的已连会话按新配置重挂 MCP** ——
 * 「改了组合文件，已连会话不生效；new-backend 也沿用旧 MCP」（2026-10-26 实测）。
 *
 * MCP 是起执行器时（session/new / load）交给适配器的，改文件不会自己生效。这里：
 *   · 文件被改（设置页保存、S3 同步拉下来、外部编辑器 / 脚本）→ 防抖后读一遍；内容指纹没变就什么都不做；
 *   · 每条连着、用组合的会话（Claude Code / Codex）比一比「挂上时那份组合」和「按新文件该用的那份」的指纹，
 *     不一样的才重挂；没用这个组合的不动；
 *   · 空闲的立刻重挂，忙的记下来、等它空下来（`idle`）再重挂 —— 不打断正在跑的一轮；
 *   · 文件改坏了（解析 / 校验不过）：不重挂、不动现有 MCP，同一份坏内容只提示一次。
 *
 * 纯逻辑（不 import electron / fs），`index.ts` 把读文件、会话状态和「怎么重挂」作为钩子传进来；测试用假的。
 */
import type { McpCombo } from './mcpCombos.ts';

/** 组合里决定「要不要重挂」的那几样：MCP 和 effort。名字只是显示用，单改名不重启执行器（日志 / 提示里的名字每次现读）。 */
export function comboFingerprint(combo: Pick<McpCombo, 'id' | 'effort' | 'mcpServers'>): string {
  return stableJson({ id: combo.id, effort: combo.effort ?? null, mcpServers: combo.mcpServers || {} });
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export interface ComboWatchSession {
  sessionId: string;
  /** 记录里选的组合 id（没选 = 通用） */
  comboId?: string;
  /** 这个执行器挂上时那份组合的指纹（`comboFingerprint`）；不知道就 undefined（不动它） */
  mountedFp?: string;
}

export interface McpComboWatchDeps {
  /** 读一遍文件：`text` 做内容指纹；`error` = 解析 / 校验不过（这时 `combos` 不可信） */
  read(): { text: string; error?: string; combos: McpCombo[] };
  /** 连着、用组合的会话（Claude Code / Codex） */
  sessions(): ComboWatchSession[];
  /** 按这份文件这条会话该用的组合（找不到退回通用；按这台电脑套 perMachine） */
  resolve(combos: McpCombo[], comboId: string | undefined): McpCombo;
  /** 正在跑一轮 / 换执行器 / 挂载中 —— 现在重挂会打断它 */
  isBusy(sessionId: string): boolean;
  /** 按当前文件重挂（重新准备 MCP、重起执行器）；失败就抛 */
  remount(sessionId: string): Promise<void>;
  noteReloaded(sessionId: string, combo: McpCombo): void;
  noteReloadFailed(sessionId: string, combo: McpCombo, error: string): void;
  noteFileError(sessionId: string, error: string): void;
  /** 文件内容真的变了（含改坏）—— 让界面上的组合下拉重读 */
  onFileChanged?(): void;
  log(message: string): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export const COMBO_WATCH_DEBOUNCE_MS = 500;
/** 空下来之后稍等一下再看：轮次收尾时紧跟着会应用忙时记下的切换（`pendingSwitchRunner.kick`），先让它登记上 */
export const COMBO_IDLE_DELAY_MS = 50;

export class McpComboWatcher {
  private readonly deps: McpComboWatchDeps;
  private readonly debounceMs: number;
  private lastText: string | undefined;
  /** 上次提示过的那份坏内容（同一份只说一次；改好了清掉） */
  private notedBadText: string | undefined;
  private debounce: unknown;
  /** 忙着、等空下来再重挂的会话 */
  private readonly waiting = new Set<string>();
  private readonly idleTimers = new Map<string, unknown>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(deps: McpComboWatchDeps, opts: { debounceMs?: number } = {}) {
    this.deps = deps;
    this.debounceMs = opts.debounceMs ?? COMBO_WATCH_DEBOUNCE_MS;
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms);
  }
  private clearTimer(h: unknown): void {
    if (h === undefined) return;
    if (this.deps.clearTimer) this.deps.clearTimer(h); else clearTimeout(h as ReturnType<typeof setTimeout>);
  }

  /** 启动时记下当前内容做基线（之后只对变化反应）。 */
  prime(): void {
    try { this.lastText = this.deps.read().text; } catch { this.lastText = undefined; }
  }

  /** 文件可能变了（fs.watch 事件 / 自己保存 / S3 拉下来）：防抖后再看。 */
  changed(): void {
    this.clearTimer(this.debounce);
    this.debounce = this.setTimer(() => { this.debounce = undefined; void this.check(); }, this.debounceMs);
  }

  /** 读一遍、和上次比；内容变了就按会话逐条判断。返回这次开始重挂的会话（测试用）。 */
  async check(): Promise<string[]> {
    let r: ReturnType<McpComboWatchDeps['read']>;
    try { r = this.deps.read(); } catch (err: any) {
      this.deps.log(`读组合文件失败：${err?.message || err}`);
      return [];
    }
    if (r.text === this.lastText) return [];
    this.lastText = r.text;
    this.deps.onFileChanged?.();
    if (r.error) {
      /* 改坏了：不重挂、不动现有 MCP；等着的也不再按这份重挂（改好了再判一次） */
      this.waiting.clear();
      if (this.notedBadText === r.text) return [];
      this.notedBadText = r.text;
      const list = this.deps.sessions();
      this.deps.log(`组合文件有错，保持各会话原来的 MCP（${list.length} 条连着的会话）：${r.error}`);
      for (const s of list) this.deps.noteFileError(s.sessionId, r.error);
      return [];
    }
    this.notedBadText = undefined;
    const started: string[] = [];
    for (const s of this.deps.sessions()) {
      /*
        **正在重挂的那条：先不比**（它挂上时的指纹还没更新 —— 例如 A → B 正在按 B 挂、文件又改回 A，这时比出来「没变」，
        B 挂好之后就没人纠正了）。记成等着，重挂做完后按那时的文件和实际挂上的那份再比一次（`remount` 的收尾）。
      */
      if (this.inFlight.has(s.sessionId)) { this.waiting.add(s.sessionId); continue; }
      if (!this.isStale(s, r.combos)) { this.waiting.delete(s.sessionId); continue; }
      if (this.inFlight.has(s.sessionId) || this.deps.isBusy(s.sessionId)) {
        if (!this.waiting.has(s.sessionId)) this.deps.log(`组合改了，会话正忙，等这一轮结束再重挂 sessionId=${s.sessionId}`);
        this.waiting.add(s.sessionId);
        continue;
      }
      started.push(s.sessionId);
      void this.remount(s.sessionId, r.combos, s.comboId);
    }
    return started;
  }

  /** 会话空下来了（轮次结束 / 切换落定）：等着重挂的现在重挂。 */
  idle(sessionId: string): void {
    if (!this.waiting.has(sessionId) || this.idleTimers.has(sessionId)) return;
    this.idleTimers.set(sessionId, this.setTimer(() => {
      this.idleTimers.delete(sessionId);
      void this.retryWaiting(sessionId);
    }, COMBO_IDLE_DELAY_MS));
  }

  /** 等着的那条：再读一遍文件（这期间可能又改了 / 改坏了 / 别的切换已经按新文件重挂过），还旧才重挂。 */
  async retryWaiting(sessionId: string): Promise<boolean> {
    if (!this.waiting.has(sessionId)) return false;
    if (this.inFlight.has(sessionId) || this.deps.isBusy(sessionId)) return false;
    this.waiting.delete(sessionId);
    let r: ReturnType<McpComboWatchDeps['read']>;
    try { r = this.deps.read(); } catch { return false; }
    if (r.error) return false;
    const s = this.deps.sessions().find((x) => x.sessionId === sessionId);
    if (!s || !this.isStale(s, r.combos)) return false;
    void this.remount(sessionId, r.combos, s.comboId);
    return true;
  }

  isWaiting(sessionId: string): boolean { return this.waiting.has(sessionId); }

  /**
   * **任何一条挂载路径刚按文件准备好 MCP**（`sessionCombo` 记下指纹时调：attach、换组合、new-backend、这里自己的重挂都算）——
   * 等这条会话空下来，按那时的文件和这次实际挂上的那份再比一次，不一致再重挂（`retryWaiting`）。
   * 只靠文件变化那一刻的比较不够：别的路径正在挂、指纹还没更新时文件被撤回，比出来是「没变」，挂好之后就没人纠正了。
   */
  noteMounted(sessionId: string): void {
    this.waiting.add(sessionId);
    this.idle(sessionId);
  }

  /** 正在进行的重挂（测试 / 调用方要等它时用）。 */
  pending(sessionId: string): Promise<void> | undefined { return this.inFlight.get(sessionId); }

  private isStale(s: ComboWatchSession, combos: McpCombo[]): boolean {
    if (s.mountedFp === undefined) return false;
    return comboFingerprint(this.deps.resolve(combos, s.comboId)) !== s.mountedFp;
  }

  private remount(sessionId: string, combos: McpCombo[], comboId: string | undefined): Promise<void> {
    const combo = this.deps.resolve(combos, comboId);
    this.deps.log(`组合改了，按新配置重挂 sessionId=${sessionId} 组合=${combo.name}`);
    const p = Promise.resolve()
      .then(() => this.deps.remount(sessionId))
      .then(
        () => { this.deps.noteReloaded(sessionId, combo); },
        (err: any) => {
          const msg = String(err?.message || err);
          this.deps.log(`按新组合重挂失败 sessionId=${sessionId}: ${msg}`);
          /* 自己发起的这次失败了：不因为它准备 MCP 时登记的复核再自动重试（不然会一直失败、一直提示） */
          this.waiting.delete(sessionId);
          this.deps.noteReloadFailed(sessionId, combo, msg);
        },
      )
      .finally(() => {
        this.inFlight.delete(sessionId);
        /* 重挂期间文件又变了：按现在的文件和刚挂上的那份再比一次，不一样再重挂（`retryWaiting`） */
        if (this.waiting.has(sessionId)) this.idle(sessionId);
      });
    this.inFlight.set(sessionId, p);
    return p;
  }

  dispose(): void {
    this.clearTimer(this.debounce);
    for (const h of this.idleTimers.values()) this.clearTimer(h);
    this.idleTimers.clear();
    this.waiting.clear();
  }
}

/** 组合文件坏了（解析 / 校验不过）：不按它重挂，保持原来的执行器和 MCP。 */
export const COMBO_FILE_BROKEN = 'combo-file-broken';

export interface ExclusiveRemountDeps<E, R> {
  /** 等这条会话的挂载锁 / 在飞的 attach 落定 */
  settle(): Promise<void>;
  /** 现在挂着的执行器 */
  current(): E | undefined;
  /** 所有等待之后、占住之前**同步**判一次：不能重挂就返回原因（错误），能就 null（没连着 / kiro / 另一个切换在做 / 正忙） */
  refuse(entry: E | undefined): Error | null;
  /** 占住 / 放开会话（`reconfiguringSessions`） */
  claim(): void;
  release(): void;
  /** 读组合文件 */
  readCombos(): { error?: string; combos: McpCombo[] };
  /** 文件坏了时抛的错误（带 `code: COMBO_FILE_BROKEN`） */
  brokenError(error: string): Error;
  /** 真正的重挂：`combos` 是占住那一刻读到、校验过的那份 —— 准备 MCP 期间一律用它，不再现读文件 */
  remount(entry: E, combos: McpCombo[]): Promise<R>;
}

/**
 * **重挂一条会话：等完所有该等的，再同步地判断 + 占住** —— 两个同时到达的重挂（例如两次 new-backend）
 * 只有一个能占住，另一个按「另一个切换还没做完」被拒；判断和占住之间没有 await。
 * 组合文件在占住那一刻读一次：坏了就不重挂（旧执行器和它的 MCP 原样留着），好的那份交给 `remount` 用到底。
 */
export async function remountExclusive<E, R>(deps: ExclusiveRemountDeps<E, R>): Promise<R> {
  await deps.settle();
  const entry = deps.current();
  const refused = deps.refuse(entry);
  if (refused) throw refused;
  const file = deps.readCombos();
  if (file.error) throw deps.brokenError(file.error);
  deps.claim();
  try {
    return await deps.remount(entry as E, file.combos);
  } finally {
    deps.release();
  }
}
