/**
 * **会话里「安装适配器」那颗按钮的状态**（每条会话一份，只在内存里 —— 装完重连了就没用了）。
 *
 * 流程（`runAdapterInstall`）：安装中（输出边跑边进来）→ 装好了就重连这条会话 → 已连上；
 * 装不上 → failed（带原因）；装上了但重连没成 → reconnect-failed（重连那边会换上新的「没连上」提示）。
 * 同一条会话装着的时候再点，不起第二次。
 *
 * 真正干活的两件事（调主进程装、重连）由 `useAcp` 用 `setAdapterInstallRunner` 登记进来，
 * 按钮那边（ChatArea）只管读状态和点 —— 不用把回调一层层穿过 App / ChatArea 的 props。
 */
import { cleanIpcError } from './sessionRequestStatus.ts';
import type { AdapterEngine } from './adapterInstallOffer.ts';

export type InstallPhase = 'installing' | 'reconnecting' | 'connected' | 'failed' | 'reconnect-failed';
export interface InstallState { phase: InstallPhase; engine: AdapterEngine; output: string; error?: string }

const OUTPUT_MAX = 6000;

export function createAdapterInstallStore() {
  let states: Record<string, InstallState> = {};
  const listeners = new Set<() => void>();
  const emit = () => { for (const l of [...listeners]) { try { l(); } catch { /* 一个订阅者坏了不影响别的 */ } } };
  return {
    get(sid: string): InstallState | undefined { return states[sid]; },
    set(sid: string, next: InstallState): void { states = { ...states, [sid]: next }; emit(); },
    patch(sid: string, p: Partial<InstallState>): void {
      const cur = states[sid];
      if (!cur) return;
      states = { ...states, [sid]: { ...cur, ...p } };
      emit();
    },
    append(sid: string, chunk: string): void {
      const cur = states[sid];
      if (!cur || !chunk) return;
      states = { ...states, [sid]: { ...cur, output: (cur.output + chunk).slice(-OUTPUT_MAX) } };
      emit();
    },
    subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
export type AdapterInstallStore = ReturnType<typeof createAdapterInstallStore>;

export interface InstallDeps {
  install: (sessionId: string, engine: AdapterEngine) => Promise<{ ok: boolean; error?: string }>;
  reconnect: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
}

const inFlight = new WeakMap<AdapterInstallStore, Map<string, Promise<boolean>>>();

/** 装 → 重连。返回最后连上了没有。 */
export function runAdapterInstall(store: AdapterInstallStore, sessionId: string, engine: AdapterEngine, deps: InstallDeps): Promise<boolean> {
  let running = inFlight.get(store);
  if (!running) { running = new Map(); inFlight.set(store, running); }
  const existing = running.get(sessionId);
  if (existing) return existing;
  const p = (async () => {
    store.set(sessionId, { phase: 'installing', engine, output: '' });
    let res: { ok: boolean; error?: string };
    try {
      res = await deps.install(sessionId, engine);
    } catch (err) {
      res = { ok: false, error: cleanIpcError(err) };
    }
    if (!res.ok) {
      store.patch(sessionId, { phase: 'failed', error: res.error || '' });
      return false;
    }
    store.patch(sessionId, { phase: 'reconnecting' });
    let rc: { ok: boolean; error?: string };
    try {
      rc = await deps.reconnect(sessionId);
    } catch (err) {
      rc = { ok: false, error: cleanIpcError(err) };
    }
    store.patch(sessionId, rc.ok ? { phase: 'connected' } : { phase: 'reconnect-failed', error: rc.error || '' });
    return rc.ok;
  })().finally(() => { running!.delete(sessionId); });
  running.set(sessionId, p);
  return p;
}

/* ─────────── 整个窗口共用的那一份 ─────────── */

export const adapterInstallStore = createAdapterInstallStore();
let runner: InstallDeps | null = null;
/** `useAcp` 登记真正的安装 / 重连。 */
export function setAdapterInstallRunner(deps: InstallDeps | null): void { runner = deps; }
/** 按钮点下去。没登记（不该发生）就当失败说一句。 */
export function startAdapterInstall(sessionId: string, engine: AdapterEngine): Promise<boolean> {
  if (!runner) {
    adapterInstallStore.set(sessionId, { phase: 'failed', engine, output: '', error: 'not ready' });
    return Promise.resolve(false);
  }
  return runAdapterInstall(adapterInstallStore, sessionId, engine, runner);
}
