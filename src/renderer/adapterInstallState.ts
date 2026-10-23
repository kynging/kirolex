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

export type InstallPhase = 'installing' | 'reconnecting' | 'connected' | 'failed' | 'reconnect-failed'
  /* 「登录」（本机没登录）：终端开了、等你登上 / 没开成或等不到 */
  | 'logging-in' | 'login-failed';
export interface InstallState { phase: InstallPhase; engine: AdapterEngine; output: string; error?: string; via?: 'install' | 'login' }

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

/**
 * 等到 `check()` 为真（每 `intervalMs` 问一次，最多 `timeoutMs`）。登录那种"人在另一个窗口里操作"的事只能轮询。
 * `check` 抛错当作"还没好"。
 */
export async function waitUntil(
  check: () => Promise<boolean>,
  opts: { intervalMs: number; timeoutMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number; cancelled?: () => boolean },
): Promise<boolean> {
  const sleep = opts.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now || Date.now;
  const end = now() + opts.timeoutMs;
  for (;;) {
    if (opts.cancelled?.()) return false;
    try { if (await check()) return true; } catch { /* 当作还没好 */ }
    if (now() >= end) return false;
    await sleep(opts.intervalMs);
  }
}

export interface LoginDeps {
  /** 本机开终端跑登录命令。 */
  login: (engine: AdapterEngine) => Promise<{ ok: boolean; opened?: boolean; error?: string }>;
  /** 现在登上了没有（主进程强制重新问一次本机状态）。 */
  loggedIn: (engine: AdapterEngine) => Promise<boolean>;
  reconnect: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** 登录：开终端 → 轮询到登上 → 重连这条会话（「登录完自动重试」）。返回最后连上了没有。 */
export function runEngineLogin(store: AdapterInstallStore, sessionId: string, engine: AdapterEngine, deps: LoginDeps): Promise<boolean> {
  let running = inFlight.get(store);
  if (!running) { running = new Map(); inFlight.set(store, running); }
  const existing = running.get(sessionId);
  if (existing) return existing;
  const p = (async () => {
    store.set(sessionId, { phase: 'logging-in', engine, output: '', via: 'login' });
    let opened: { ok: boolean; error?: string };
    try { opened = await deps.login(engine); } catch (err) { opened = { ok: false, error: cleanIpcError(err) }; }
    if (!opened.ok) { store.patch(sessionId, { phase: 'login-failed', error: opened.error || '' }); return false; }
    const ok = await waitUntil(() => deps.loggedIn(engine), {
      intervalMs: deps.intervalMs ?? 5000, timeoutMs: deps.timeoutMs ?? 10 * 60_000, sleep: deps.sleep, now: deps.now,
    });
    if (!ok) { store.patch(sessionId, { phase: 'login-failed', error: '' }); return false; }
    store.patch(sessionId, { phase: 'reconnecting' });
    let rc: { ok: boolean; error?: string };
    try { rc = await deps.reconnect(sessionId); } catch (err) { rc = { ok: false, error: cleanIpcError(err) }; }
    store.patch(sessionId, rc.ok ? { phase: 'connected' } : { phase: 'reconnect-failed', error: rc.error || '' });
    return rc.ok;
  })().finally(() => { running!.delete(sessionId); });
  running.set(sessionId, p);
  return p;
}

/* ─────────── 整个窗口共用的那一份 ─────────── */

export const adapterInstallStore = createAdapterInstallStore();
let runner: InstallDeps | null = null;
let loginRunner: Omit<LoginDeps, 'reconnect'> | null = null;
/** `useAcp` 登记真正的安装 / 重连。 */
export function setAdapterInstallRunner(deps: InstallDeps | null): void { runner = deps; }
/** 登录那两件事（开终端、问状态）—— 重连借用安装那份 runner 的 `reconnect`。 */
export function setEngineLoginRunner(deps: Omit<LoginDeps, 'reconnect'> | null): void { loginRunner = deps; }
/** 「登录」按钮点下去。 */
export function startEngineLogin(sessionId: string, engine: AdapterEngine): Promise<boolean> {
  if (!runner || !loginRunner) {
    adapterInstallStore.set(sessionId, { phase: 'login-failed', engine, output: '', error: 'not ready' });
    return Promise.resolve(false);
  }
  return runEngineLogin(adapterInstallStore, sessionId, engine, { ...loginRunner, reconnect: runner.reconnect });
}
/** 按钮点下去。没登记（不该发生）就当失败说一句。 */
export function startAdapterInstall(sessionId: string, engine: AdapterEngine): Promise<boolean> {
  if (!runner) {
    adapterInstallStore.set(sessionId, { phase: 'failed', engine, output: '', error: 'not ready' });
    return Promise.resolve(false);
  }
  return runAdapterInstall(adapterInstallStore, sessionId, engine, runner);
}
