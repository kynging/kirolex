/**
 * **三个引擎在一台机器上的状态 —— 渲染层那一半**（新建会话框、设置 → 机器 → 本机，`EngineStatusPanel.tsx`）。
 *
 * 主进程（`engines:status`，`main/engineStatus.ts`）已经缓存 5 分钟；这里每台机器再记一份最近的结果，
 * 面板换来换去（打开 / 关上新建会话框）不闪、也不重复问。装 / 登录的进度也记在这里（按 机器 + 引擎）。
 * 纯 .ts：取数据和装 / 登录的那几件事由调用方注入，测试换成假的。
 */
import { waitUntil } from './adapterInstallState.ts';

export type EngineId = 'kiro' | 'claude' | 'codex';
export type EngineStateId = 'ok' | 'not-logged-in' | 'missing' | 'unknown';
/** 和主进程 `EngineStatus` 同形。 */
/* `bedrock`：Codex 走 Bedrock 时主进程挂上的权限预检（`main/bedrockIam.ts` 的 BedrockIamCheck，这里只用到这几项） */
export interface EngineStatusLite {
  engine: EngineId; state: EngineStateId; version?: string; detail?: string; loginUnknown?: boolean;
  bedrock?: { model: 'ok' | 'denied' | 'unknown'; webSearch: 'ok' | 'denied' | 'unknown'; missing: string[]; webSearchDisabled?: boolean };
}

export const ENGINE_NAMES: Record<EngineId, string> = { kiro: 'Kiro', claude: 'Claude Code', codex: 'Codex' };
export const ENGINE_ORDER: EngineId[] = ['kiro', 'claude', 'codex'];

export function stateIcon(state: EngineStateId | undefined): string {
  return state === 'ok' ? '✅' : state === 'not-logged-in' ? '⚠️' : state === 'missing' ? '❌' : '⚪';
}

export type ActionPhase = 'installing' | 'install-failed' | 'logging-in' | 'login-failed' | 'login-how';
export interface ActionState { phase: ActionPhase; output: string; error?: string; how?: string }
export interface MachineState { loading: boolean; statuses?: EngineStatusLite[]; error?: string; actions: Partial<Record<EngineId, ActionState>> }

export interface EngineStatusDeps {
  fetch: (machine: string, force: boolean) => Promise<{ ok: boolean; statuses?: EngineStatusLite[]; error?: string }>;
  install: (machine: string, engine: EngineId) => Promise<{ ok: boolean; error?: string }>;
  login: (machine: string, engine: EngineId) => Promise<{ ok: boolean; opened?: boolean; how?: string; error?: string }>;
  /** 登录轮询（本机）：间隔 / 上限 / sleep 可注入。 */
  loginPollMs?: number;
  loginTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createEngineStatusStore(deps: EngineStatusDeps) {
  let machines: Record<string, MachineState> = {};
  const listeners = new Set<() => void>();
  const loads = new Map<string, Promise<void>>();
  const emit = () => { for (const l of [...listeners]) { try { l(); } catch { /* 一个订阅者坏了不影响别的 */ } } };
  const put = (machine: string, p: Partial<MachineState>) => {
    const cur = machines[machine] || { loading: false, actions: {} };
    machines = { ...machines, [machine]: { ...cur, ...p } };
    emit();
  };
  const putAction = (machine: string, engine: EngineId, a: ActionState | undefined) => {
    const cur = machines[machine] || { loading: false, actions: {} };
    put(machine, { actions: { ...cur.actions, [engine]: a } });
  };

  const store = {
    get(machine: string): MachineState | undefined { return machines[machine]; },
    subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
    status(machine: string, engine: EngineId): EngineStatusLite | undefined {
      return machines[machine]?.statuses?.find((s) => s.engine === engine);
    },
    /** 取一次（`force` 让主进程跳过它的 5 分钟缓存）。同一台机器同时只问一次。 */
    load(machine: string, force = false): Promise<void> {
      const running = loads.get(machine);
      if (running && !force) return running;
      put(machine, { loading: true });
      const p = (async () => {
        try {
          const r = await deps.fetch(machine, force);
          put(machine, r.ok ? { loading: false, statuses: r.statuses || [], error: undefined } : { loading: false, error: r.error || '' });
        } catch (err: any) {
          put(machine, { loading: false, error: String(err?.message || err) });
        }
      })().finally(() => { if (loads.get(machine) === p) loads.delete(machine); });
      loads.set(machine, p);
      return p;
    },
    appendOutput(machine: string, engine: EngineId, chunk: string): void {
      const a = machines[machine]?.actions[engine];
      if (!a || a.phase !== 'installing' || !chunk) return;
      putAction(machine, engine, { ...a, output: (a.output + chunk).slice(-6000) });
    },
    /** ❌ → 装；装完重新检测。 */
    async install(machine: string, engine: EngineId): Promise<boolean> {
      if (machines[machine]?.actions[engine]?.phase === 'installing') return false;
      putAction(machine, engine, { phase: 'installing', output: '' });
      let r: { ok: boolean; error?: string };
      try { r = await deps.install(machine, engine); } catch (err: any) { r = { ok: false, error: String(err?.message || err) }; }
      putAction(machine, engine, r.ok ? undefined : { phase: 'install-failed', output: machines[machine]?.actions[engine]?.output || '', error: r.error || '' });
      await store.load(machine, true);
      return r.ok;
    },
    /** ⚠️ → 登录：本机开终端、轮询到登上；远端给去哪登。 */
    async login(machine: string, engine: EngineId): Promise<boolean> {
      putAction(machine, engine, { phase: 'logging-in', output: '' });
      let r: { ok: boolean; opened?: boolean; how?: string; error?: string };
      try { r = await deps.login(machine, engine); } catch (err: any) { r = { ok: false, error: String(err?.message || err) }; }
      if (!r.ok) { putAction(machine, engine, { phase: 'login-failed', output: '', error: r.error || '' }); return false; }
      if (r.how) { putAction(machine, engine, { phase: 'login-how', output: '', how: r.how }); return false; }
      const ok = await waitUntil(async () => {
        const f = await deps.fetch(machine, true);
        if (f.ok) put(machine, { statuses: f.statuses || [] });
        return !!f.ok && f.statuses?.find((s) => s.engine === engine)?.state === 'ok';
      }, { intervalMs: deps.loginPollMs ?? 5000, timeoutMs: deps.loginTimeoutMs ?? 10 * 60_000, sleep: deps.sleep });
      putAction(machine, engine, ok ? undefined : { phase: 'login-failed', output: '', error: '' });
      return ok;
    },
  };
  return store;
}
export type EngineStatusStore = ReturnType<typeof createEngineStatusStore>;

/** 输出的最后几行（进度显示用）。 */
export function outputTail(output: string, n = 6): string {
  return String(output || '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n).join('\n');
}
