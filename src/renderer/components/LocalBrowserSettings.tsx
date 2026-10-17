import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../hooks/useLang';
import { ToggleButton } from './ToggleButton';
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog';
import { browserEnableHint, browserStateLabel, type LocalBrowserStatusView } from '../localBrowserView';

/**
 * 设置 → 开关 → **本地浏览器（local_browser）**：总开关（默认关）、默认用哪个浏览器、每个浏览器的连接状态
 * （未开启调试 / 等待浏览器确认 / 已连接），Firefox 的"以调试模式重启"。
 *
 * 状态在主进程（`localBrowserHost.ts`）：这里打开时轮询一次 + 听 `browser:status-changed`。
 */
export function LocalBrowserSettings(): React.ReactElement {
  const t = useT();
  const [st, setSt] = useState<LocalBrowserStatusView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [portInput, setPortInput] = useState('');

  const refresh = useCallback(() => {
    window.kiroApi.browserStatus?.().then((s) => {
      setSt(s);
      setPortInput((p) => p || String(s.firefoxPort));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const off = window.kiroApi.onBrowserStatusChanged?.(refresh);
    /* 用户在浏览器里开 / 关调试不会通知我们 —— 设置页开着时慢慢轮询 */
    const timer = window.setInterval(refresh, 3000);
    return () => { off?.(); window.clearInterval(timer); };
  }, [refresh]);

  const setConfig = async (patch: { enabled?: boolean; browser?: string; firefoxPort?: number }) => {
    setBusy('config');
    try { await window.kiroApi.browserSetConfig?.(patch); } finally { setBusy(null); refresh(); }
  };

  const connect = async (kind: string) => {
    setBusy(kind);
    setMsg(t('Connecting… if the browser asks whether to allow remote debugging, click Allow.'));
    try {
      const r = await window.kiroApi.browserConnect?.(kind);
      setMsg(r?.ok ? null : (r?.error || t('Connection failed')));
    } finally { setBusy(null); refresh(); }
  };

  const restartFirefox = () => setConfirm({
    title: t('Restart Firefox in debug mode'),
    message: t('This closes all current Firefox windows and starts Firefox again with remote debugging on port {port}. Firefox will ask to restore your tabs as usual. Continue?', { port: st?.firefoxPort ?? 9222 }),
    confirmLabel: t('Restart Firefox'),
    destructive: true,
    onConfirm: async () => {
      setBusy('firefox');
      setMsg(t('Restarting Firefox…'));
      try {
        const r = await window.kiroApi.browserRestartFirefox?.();
        setMsg(r?.ok ? t('Firefox restarted in debug mode.') : (r?.error || t('Restart failed')));
      } finally { setBusy(null); refresh(); }
    },
  });

  if (!st) return <div className="settings-item" data-testid="local-browser-settings"><span className="settings-hint">{t('Loading…')}</span></div>;
  const savePort = () => {
    const n = Number(portInput);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535 && n !== st.firefoxPort) void setConfig({ firefoxPort: n });
  };

  return (
    <div className="settings-item settings-item-wide local-browser-settings" data-testid="local-browser-settings" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
      <div className="settings-control" style={{ justifyContent: 'space-between', gap: 12 }}>
        <label className="settings-label">{t('Local browser (local_browser)')}</label>
        <ToggleButton
          on={st.enabled}
          labels={[t('On'), t('Off')]}
          ariaLabel={t('Local browser (local_browser)')}
          disabled={busy === 'config'}
          onChange={(next) => void setConfig({ enabled: next })}
        />
      </div>
      <p className="settings-hint" style={{ marginTop: 0 }}>
        {t('Lets chats read pages in the Chrome / Edge / Firefox you are already logged into (internal pages behind SSO). Read-only: list tabs, open a new tab, read, screenshot, close its own tabs; your own tabs are never touched. Each new domain asks you first. Public pages and clicking / form filling still go to playwright. Applies to chats started or reconnected after you turn it on.')}
      </p>
      <div className="settings-control" style={{ gap: 8 }}>
        <span className="settings-switch-label">{t('Default browser')}</span>
        <select
          className="settings-select local-browser-pick"
          value={st.browser}
          disabled={busy === 'config'}
          onChange={(e) => void setConfig({ browser: e.target.value })}
        >
          <option value="auto">{t('Automatic')}{st.effective ? ` (${st.browsers.find((b) => b.kind === st.effective)?.label || st.effective})` : ''}</option>
          {st.browsers.map((b) => <option key={b.kind} value={b.kind}>{b.label}</option>)}
        </select>
      </div>
      {!st.browsers.length && <span className="settings-hint">{t('No Chrome, Edge or Firefox found on this machine.')}</span>}
      <ul className="local-browser-list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {st.browsers.map((b) => {
          const hint = browserEnableHint(b.kind);
          const canConnect = st.enabled && b.state !== 'connected' && b.state !== 'waiting';
          return (
            <li key={b.kind} className={`local-browser-row state-${b.state}`} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>{b.label}</span>
                <span style={{ flex: 1 }} />
                {canConnect && (
                  <button className="remote-btn local-browser-connect" disabled={!!busy} onClick={() => void connect(b.kind)}>{t('Connect')}</button>
                )}
              </div>
              <span className={`local-browser-state state-${b.state}`} style={{ fontSize: 12, color: b.state === 'connected' ? 'var(--success, #4caf50)' : b.state === 'error' ? 'var(--error)' : 'var(--text-secondary)' }}>
                {b.state === 'connected' ? '● ' : b.state === 'waiting' ? '◌ ' : '○ '}{t(browserStateLabel(b))}
              </span>
              {b.error && b.state === 'error' && <span className="settings-hint" style={{ color: 'var(--error)' }}>{b.error}</span>}
              {st.enabled && hint && (b.state === 'not-enabled' || b.state === 'error') && (
                <span className="settings-hint">{t('In {browser}, open {url} and turn on remote debugging. The browser asks once to allow KiroLex; KiroLex then keeps that one connection.', { browser: b.label, url: hint })}</span>
              )}
              {b.state === 'waiting' && <span className="settings-hint">{t('Switch to the browser and click Allow in its prompt.')}</span>}
              {b.kind === 'firefox' && (
                <div className="settings-control" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="settings-hint">{t('Debug port')}</span>
                  <input
                    className="settings-input local-browser-port"
                    type="number"
                    min={1024}
                    max={65535}
                    value={portInput}
                    onChange={(e) => setPortInput(e.target.value)}
                    onBlur={savePort}
                    style={{ width: 90 }}
                  />
                  <button className="remote-btn local-browser-restart-firefox" disabled={!!busy || !st.enabled} onClick={restartFirefox}>
                    {t('Restart Firefox in debug mode')}
                  </button>
                  <span className="settings-hint">{t('(closes the current Firefox windows)')}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {msg && <span className="settings-hint local-browser-msg">{msg}</span>}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
