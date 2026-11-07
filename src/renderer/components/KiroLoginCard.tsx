/**
 * **「登录 kiro」卡片** —— 远端 kiro 会话没登录时原来只有一句「去那台机器跑一次」，没有入口。
 * 用在三处：会话里「没连上：…kiro-cli 没登录」那条提示下面、kiro 会话的 🔑 登录 tab、设置 → 机器（每台机器）。
 * 选 free / pro（pro 可填 start URL 和区）→「登录 kiro」→ 本机开终端（远端经同一条连接 ssh -t 跑 device flow）
 * → 自动等到那台机器上 kiro 可用 → 有会话就自动重连。逻辑在 `kiroLoginView.ts`。
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import { useT } from '../hooks/useLang';
import { createKiroLoginStore, choiceOf, keyOf, type KiroLoginStore, type KiroLoginTarget } from '../kiroLoginView';
import { reconnectAfterLogin } from '../adapterInstallState';

let shared: KiroLoginStore | null = null;
/** 整个窗口一份：同一条会话的卡片在提示下面和 🔑 tab 里看到的是同一个进度。 */
export function kiroLoginStore(): KiroLoginStore {
  if (shared) return shared;
  const api = (window as any).kiroApi;
  shared = createKiroLoginStore({
    info: (t) => (api?.kiroLoginInfo ? api.kiroLoginInfo(t) : Promise.resolve({ ok: false, error: 'unavailable' })),
    login: (t, c) => (api?.kiroLogin ? api.kiroLogin(t, c) : Promise.resolve({ ok: false, error: 'unavailable' })),
    kiroReady: async (machine) => {
      const r = await api?.enginesStatus?.(machine, { force: true });
      return !!r?.ok && r.statuses?.find((s: any) => s.engine === 'kiro')?.state === 'ok';
    },
    reconnect: (sid) => reconnectAfterLogin(sid, 'kiro'),
  });
  return shared;
}

export function KiroLoginCard({ target, compact, onDone }: { target: KiroLoginTarget; compact?: boolean; /** 登上了（例如状态面板据此刷新那一行） */ onDone?: () => void }) {
  const t = useT();
  const store = kiroLoginStore();
  const key = keyOf(target);
  const st = useSyncExternalStore(store.subscribe, () => store.get(key));
  useEffect(() => { void store.init(target); }, [key, store]);
  const phase = st?.phase;
  useEffect(() => { if (phase === 'done') onDone?.(); }, [phase]);
  if (!st) return null;
  const busy = st.phase === 'loading' || st.phase === 'opening' || st.phase === 'waiting' || st.phase === 'reconnecting';
  const choice = choiceOf(st.draft);
  const where = st.remote ? (st.host || st.machine || '') : '';
  const status = st.phase === 'opening' ? t('Opening a terminal…')
    : st.phase === 'waiting' ? (st.remote
      ? t('A terminal window opened. Open the link it prints in your browser and enter the code; this updates by itself once kiro-cli on {host} is logged in.', { host: where })
      : t('A terminal window opened. Finish logging in there; this updates by itself.'))
    : st.phase === 'reconnecting' ? t('Logged in. Reconnecting this chat…')
    : st.phase === 'done' ? t('✅ kiro-cli is logged in.')
    : st.phase === 'failed' ? (st.error || t('Did not see a login yet. Click "Log in to kiro" to try again.'))
    : st.phase !== 'idle' ? ''
    : !choice ? t('Choose Free or Pro.')
    : st.source === 'remembered' ? t('Preselected: how you logged in on this machine last time.')
    : st.source === 'local' ? t('Preselected: how kiro-cli on this computer is logged in.')
    : '';
  return (
    <div className={`kiro-login-card${compact ? ' compact' : ''}`} data-phase={st.phase}>
      <div className="kiro-login-title">
        🔑 {st.remote ? t('Log in to kiro on {host}', { host: where }) : t('Log in to kiro on this computer')}
      </div>
      <div className="kiro-login-hint">
        {st.remote
          ? t('Opens a terminal on this computer that connects to that machine the same way the chat does and runs kiro-cli login with a device code (that machine has no browser).')
          : t('Opens a terminal on this computer that runs kiro-cli login.')}
      </div>
      <div className="kiro-login-licenses" role="radiogroup">
        <label>
          <input type="radio" name={`kiro-license-${key}`} checked={st.draft.license === 'free'} disabled={busy} onChange={() => store.setDraft(target, { license: 'free' })} />
          {t('Free (Builder ID)')}
        </label>
        <label>
          <input type="radio" name={`kiro-license-${key}`} checked={st.draft.license === 'pro'} disabled={busy} onChange={() => store.setDraft(target, { license: 'pro' })} />
          {t('Pro (IAM Identity Center)')}
        </label>
      </div>
      {st.draft.license === 'pro' && (
        <div className="kiro-login-fields">
          <input
            className="settings-input"
            placeholder="https://d-xxxxxxxxxx.awsapps.com/start"
            value={st.draft.identityProvider}
            disabled={busy}
            onChange={(e) => store.setDraft(target, { identityProvider: e.target.value })}
            aria-label={t('Start URL')}
          />
          <input
            className="settings-input"
            placeholder={t('Region, e.g. us-east-1')}
            value={st.draft.region}
            disabled={busy}
            onChange={(e) => store.setDraft(target, { region: e.target.value })}
            aria-label={t('Region')}
          />
          <div className="kiro-login-hint">{t('Either can be left empty: kiro-cli then asks for it in the terminal.')}</div>
        </div>
      )}
      <div className="kiro-login-actions">
        <button type="button" className="kiro-login-btn" disabled={busy || !choice} onClick={() => { void store.start(target); }}>
          {st.phase === 'waiting' ? t('Waiting for login…') : t('Log in to kiro')}
        </button>
        {status && <span className="kiro-login-status">{status}</span>}
      </div>
    </div>
  );
}
