/**
 * **「登录 kiro」—— 渲染层那一半**（会话里的卡片 / kiro 会话的 🔑 登录 tab / 设置 → 机器，`components/KiroLoginCard.tsx`）。
 *
 * 原来远端 kiro 会话没登录时只有一句「去那台机器跑一次 `kiro-cli login`」，没有任何入口。现在：
 *   1. 卡片里选登录方式（free / pro；pro 可填 start URL 和区），默认用这台机器上次的选择、或本机 kiro-cli 的登录方式；
 *   2. 点「登录 kiro」→ 主进程开终端（远端经同一条连接 `ssh -t` 跑 `kiro-cli login --use-device-flow`）；
 *   3. 轮询那台机器的状态（跳过 5 分钟缓存）到 kiro 可用 → 有会话就自动重连。
 * 纯 .ts：取数据和开终端由调用方注入，测试换成假的。
 */
import { waitUntil } from './adapterInstallState.ts';

export type KiroLicense = 'free' | 'pro';
export interface KiroLoginChoice { license: KiroLicense; identityProvider?: string; region?: string }
export interface KiroLoginTarget { machine?: string; sessionId?: string }

/**
 * 会话里那条「没连上：…上的 kiro-cli 没登录…」（主进程 `remotePreflight.ts` 的 not-logged-in，中英、新旧说法都认）。
 * 认出来就在提示下面挂登录卡片。
 */
const NOT_LOGGED_IN = [
  /kiro-cli on .+? is not logged in/,
  /上的 kiro-cli 没登录/,
];
export function kiroLoginOffer(text: string | null | undefined): boolean {
  const s = String(text || '');
  return NOT_LOGGED_IN.some((re) => re.test(s));
}

export type KiroLoginPhase = 'loading' | 'idle' | 'opening' | 'waiting' | 'reconnecting' | 'done' | 'failed';
export interface KiroLoginDraft { license?: KiroLicense; identityProvider: string; region: string }
export interface KiroLoginState {
  phase: KiroLoginPhase;
  machine?: string;
  remote?: boolean;
  host?: string;
  /** 默认值从哪来：这台机器上次的选择 / 本机 kiro-cli / 都没有（要用户选）。 */
  source?: 'remembered' | 'local' | 'none';
  draft: KiroLoginDraft;
  error?: string;
}

export function draftFrom(choice: KiroLoginChoice | undefined): KiroLoginDraft {
  return { license: choice?.license, identityProvider: choice?.identityProvider || '', region: choice?.region || '' };
}

/** 草稿 → 交给主进程的选择；还没选 free / pro 就是 `null`（按钮不可点）。 */
export function choiceOf(d: KiroLoginDraft): KiroLoginChoice | null {
  if (d.license === 'free') return { license: 'free' };
  if (d.license !== 'pro') return null;
  return {
    license: 'pro',
    ...(d.identityProvider.trim() ? { identityProvider: d.identityProvider.trim() } : {}),
    ...(d.region.trim() ? { region: d.region.trim() } : {}),
  };
}

export interface KiroLoginDeps {
  info: (t: KiroLoginTarget) => Promise<{ ok: boolean; machine?: string; remote?: boolean; host?: string; choice?: KiroLoginChoice; source?: 'remembered' | 'local' | 'none'; error?: string }>;
  login: (t: KiroLoginTarget, c: KiroLoginChoice) => Promise<{ ok: boolean; opened?: boolean; machine?: string; error?: string }>;
  /** 那台机器上 kiro 现在能不能用（主进程跳过缓存重新问）。 */
  kiroReady: (machine: string) => Promise<boolean>;
  /** 有会话时：登上之后重连它。 */
  reconnect?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const keyOf = (t: KiroLoginTarget): string => (t.sessionId ? `s:${t.sessionId}` : `m:${t.machine || 'local'}`);

export function createKiroLoginStore(deps: KiroLoginDeps) {
  let states: Record<string, KiroLoginState> = {};
  const listeners = new Set<() => void>();
  const emit = () => { for (const l of [...listeners]) { try { l(); } catch { /* 一个订阅者坏了不影响别的 */ } } };
  const put = (key: string, p: Partial<KiroLoginState>) => {
    const cur = states[key] || { phase: 'loading', draft: draftFrom(undefined) };
    states = { ...states, [key]: { ...cur, ...p } };
    emit();
  };
  return {
    get(key: string): KiroLoginState | undefined { return states[key]; },
    subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
    /** 卡片挂上时取一次默认值（正在登录的不重取 —— 等登录时换了 tab 回来，进度还在；上次的「已登录 / 失败」不留）。 */
    async init(t: KiroLoginTarget): Promise<void> {
      const key = keyOf(t);
      const cur = states[key];
      if (cur && (cur.phase === 'loading' || cur.phase === 'opening' || cur.phase === 'waiting' || cur.phase === 'reconnecting')) return;
      put(key, { phase: 'loading', error: undefined });
      try {
        const r = await deps.info(t);
        if (!r.ok) { put(key, { phase: 'failed', error: r.error || '' }); return; }
        put(key, { phase: 'idle', machine: r.machine, remote: r.remote, host: r.host, source: r.source, draft: draftFrom(r.choice) });
      } catch (err: any) {
        put(key, { phase: 'failed', error: String(err?.message || err) });
      }
    },
    setDraft(t: KiroLoginTarget, p: Partial<KiroLoginDraft>): void {
      const key = keyOf(t);
      const cur = states[key];
      if (!cur) return;
      put(key, { draft: { ...cur.draft, ...p } });
    },
    /** 「登录 kiro」：开终端 → 等到 kiro 可用 → 有会话就重连。返回最后成没成。 */
    async start(t: KiroLoginTarget): Promise<boolean> {
      const key = keyOf(t);
      const cur = states[key];
      const choice = cur ? choiceOf(cur.draft) : null;
      if (!cur || !choice || cur.phase === 'opening' || cur.phase === 'waiting' || cur.phase === 'reconnecting') return false;
      put(key, { phase: 'opening', error: undefined });
      let r: { ok: boolean; opened?: boolean; machine?: string; error?: string };
      try { r = await deps.login(t, choice); } catch (err: any) { r = { ok: false, error: String(err?.message || err) }; }
      if (!r.ok) { put(key, { phase: 'failed', error: r.error || '' }); return false; }
      const machine = r.machine || cur.machine || 'local';
      put(key, { phase: 'waiting', machine });
      const ok = await waitUntil(() => deps.kiroReady(machine), { intervalMs: deps.pollMs ?? 6000, timeoutMs: deps.timeoutMs ?? 10 * 60_000, sleep: deps.sleep });
      if (!ok) { put(key, { phase: 'failed', error: '' }); return false; }
      if (t.sessionId && deps.reconnect) {
        put(key, { phase: 'reconnecting' });
        let rc: { ok: boolean; error?: string };
        try { rc = await deps.reconnect(t.sessionId); } catch (err: any) { rc = { ok: false, error: String(err?.message || err) }; }
        if (!rc.ok) { put(key, { phase: 'failed', error: rc.error || '' }); return false; }
      }
      put(key, { phase: 'done' });
      return true;
    },
  };
}
export type KiroLoginStore = ReturnType<typeof createKiroLoginStore>;
