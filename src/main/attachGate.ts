/**
 * **等这条会话正在进行的 attach 落定** —— 切换运行位置之前用。
 *
 * attach 一开头就读了记录，之后几秒到几十秒都在按那份记录起执行器。这期间把记录改成远端，
 * 那次 attach 照样按旧记录在本机起（本机清单里没有 Claude → 提示 + 换成 GPT），而渲染层随后的重连
 * 又被 `attachInFlight` 并进它 —— 记录写着远端，执行器却是本机的。先等它落定，再看有没有执行器。
 *
 * attach 失败不往外抛（那是 attach 自己的事，切换照常按"没连着"处理）。落定之后又冒出一个
 * （渲染层重试）也一起等，但只等几轮，免得卡死在一条一直连不上的会话上。
 */
export async function settleInFlightAttach(
  inFlight: Map<string, Promise<unknown>>,
  sessionId: string,
  maxRounds = 3,
): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const pending = inFlight.get(sessionId);
    if (!pending) return;
    try { await pending; } catch { /* attach 失败由它自己报 */ }
  }
}

/** 一段正在进行的挂载（没有就 undefined）。 */
export type MountSource = (sessionId: string) => Promise<unknown> | undefined;

/**
 * **一条会话的挂载锁** —— 冷切换（引擎 / 运行位置 / 组合 / 模型）之前统一等它，不在每处各写一份。
 *
 * 「我都切到 claude code 了右侧的模型列表也没变」（2026-10-26）：转发 MCP 后来就绪 → 重连执行器，
 * 那次重连（断线恢复 → attach）在切换之前就读了记录；切换看 `sessionClients` 里没有这条，走「未连接」只改记录，
 * 重连随后按旧的 Codex 挂上、记录又被写回 codex。所以切换先等这里所有的挂载落定，再判断走哪条分支。
 *
 * 来源两种：构造时给的（`attachInFlight`、断线恢复正在跑的那一轮）和 `hold` 临时登记的（晚就绪重连的 detach 窗口）。
 * 挂载失败不往外抛（那是它自己的事）。等完又冒出新的也一起等，但只等几轮、总时长有上限 ——
 * 等不完就返回 `timedOut`，由挂载那一侧落定前的重读（`mountDrift`）兜底，不让切换卡死在一条一直连不上的会话上。
 */
export class SessionMountLock {
  private held = new Map<string, Set<Promise<unknown>>>();
  private sources: MountSource[];

  constructor(sources: MountSource[] = []) { this.sources = sources; }

  /** 登记一段挂载，结束（成功或失败）自动注销；原样返回它。 */
  hold<T>(sessionId: string, p: Promise<T>): Promise<T> {
    let set = this.held.get(sessionId);
    if (!set) { set = new Set(); this.held.set(sessionId, set); }
    set.add(p);
    const off = (): void => {
      const s = this.held.get(sessionId);
      if (!s) return;
      s.delete(p);
      if (!s.size) this.held.delete(sessionId);
    };
    p.then(off, off);
    return p;
  }

  pending(sessionId: string): Promise<unknown>[] {
    const out = [...(this.held.get(sessionId) || [])];
    for (const src of this.sources) {
      const p = src(sessionId);
      if (p && !out.includes(p)) out.push(p);
    }
    return out;
  }

  busy(sessionId: string): boolean { return this.pending(sessionId).length > 0; }

  async settle(sessionId: string, opts: { maxRounds?: number; timeoutMs?: number } = {}): Promise<{ waited: boolean; timedOut: boolean }> {
    const maxRounds = opts.maxRounds ?? 3;
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    let waited = false;
    for (let i = 0; i < maxRounds; i++) {
      const list = this.pending(sessionId);
      if (!list.length) return { waited, timedOut: false };
      waited = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), Math.max(0, deadline - Date.now())); });
      const r = await Promise.race([Promise.allSettled(list).then(() => 'ok' as const), late]);
      if (timer) clearTimeout(timer);
      if (r === 'late') return { waited, timedOut: true };
    }
    return { waited, timedOut: false };
  }
}

/** 挂载关心的那几样（AgentProfile 的子集；这里不 import config.ts，免得测试拖进一串依赖）。 */
export interface MountProfile {
  engine?: string;
  remote?: { sshHost?: string; sshPort?: number };
  mcpCombo?: string;
  model?: string;
  preferredModel?: string;
  engineModels?: Record<string, string> | Partial<Record<string, string>>;
}

export type MountDriftKind = 'engine' | 'remote' | 'mcpCombo' | 'model';

const engineKey = (p: MountProfile): string => (p.engine === 'claude' || p.engine === 'codex' ? p.engine : 'kiro');
const remoteKey = (p: MountProfile): string => (p.remote?.sshHost ? `${p.remote.sshHost}:${p.remote.sshPort ?? ''}` : '');

/**
 * **挂载落定前重读记录：这次起来的执行器还是不是记录要的那个**。
 *
 * `snapshot` = 挂载开头读到的记录，`started` = 按它起来的执行器的 profile，`latest` = 现在盘上的记录。
 * 引擎 / 机器 / 组合（MCP 是起执行器时交出去的）和执行器不一致 → 这次挂载作废，按记录重起。
 * kiro 的模型是起进程时绑的：期间用户换过（记录的 model / preferredModel 和开头不同）也算；
 * `started.model` 是挂载自己挑的（降级 / 远端清单），和记录不同不算。记录没了返回 null（删除由 attach 自己判）。
 */
export function mountDrift(snapshot: MountProfile, started: MountProfile, latest: MountProfile | undefined): MountDriftKind | null {
  if (!latest) return null;
  if (engineKey(latest) !== engineKey(started)) return 'engine';
  if (remoteKey(latest) !== remoteKey(started)) return 'remote';
  if ((latest.mcpCombo || '') !== (started.mcpCombo || '')) return 'mcpCombo';
  if (engineKey(latest) === 'kiro'
    && ((latest.model || '') !== (snapshot.model || '') || (latest.preferredModel || '') !== (snapshot.preferredModel || ''))) return 'model';
  return null;
}

/**
 * 不用重起的那几样以记录为准，不让这次挂载的旧快照写回去：
 * `engineModels`；Claude / Codex 的 `model`（它们的模型由 engineModels 定，记录里这一格期间被改过就用改过的）。
 * kiro 的 `model` 不动 —— 那是挂载自己挑的（降级 / 远端清单），期间被改由 `mountDrift` 判重起。
 */
export function adoptRecordFields<P extends MountProfile>(started: P, latest: MountProfile | undefined): P {
  if (!latest) return started;
  const next = { ...started };
  if (latest.engineModels) next.engineModels = { ...latest.engineModels };
  else delete next.engineModels;
  if (engineKey(started) !== 'kiro' && latest.model) next.model = latest.model;
  return next;
}

/** 挂载途中记录被改了（`mountDrift`）：这次挂载丢掉，由 attach 按记录重起。 */
export class MountDriftError extends Error {
  drift: MountDriftKind;
  constructor(drift: MountDriftKind) {
    super(`mount drifted: ${drift}`);
    this.drift = drift;
  }
}
