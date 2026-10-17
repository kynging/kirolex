import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../hooks/useLang';
import type { BrowserDomainAsk } from '../localBrowserView';

/**
 * **local_browser 的新域名确认** —— 模型要在用户已登录的浏览器里打开一个**没打开过的域名**时弹出来：
 * 允许一次 / 本会话内允许 / 拒绝。记住的允许按会话存在主进程里（不全局）。
 *
 * 三个按钮所以没用 `ConfirmDialog`（它只有确定 / 取消），样式沿用它那套 `.overlay` / `.permission-dialog`。
 * 一次可能有好几个在排队（两条会话同时要开），按先来后到一个一个问。Esc / 点遮罩 = 拒绝。
 */
export const BrowserDomainPrompt: React.FC<{ sessionTitle?: (sessionId: string) => string | undefined }> = ({ sessionTitle }) => {
  const t = useT();
  const [queue, setQueue] = useState<BrowserDomainAsk[]>([]);

  useEffect(() => {
    const add = (ask: BrowserDomainAsk) => setQueue((q) => (q.some((x) => x.id === ask.id) ? q : [...q, ask]));
    const off = window.kiroApi.onBrowserDomainAsk?.(add);
    /* 总开关被关掉：主进程已经按拒绝处理了，这里把对应的框收掉 */
    const offCancel = window.kiroApi.onBrowserDomainAskCancelled?.((ids) => setQueue((q) => q.filter((x) => !ids.includes(x.id))));
    /* 界面重载时主进程里可能还有没答的（模型那一轮在等）—— 补出来 */
    window.kiroApi.browserPendingAsks?.().then((list) => { for (const a of list || []) add(a); }).catch(() => {});
    return () => { off?.(); offCancel?.(); };
  }, []);

  const current = queue[0];
  const reply = useCallback((decision: 'once' | 'session' | 'deny') => {
    if (!current) return;
    setQueue((q) => q.filter((x) => x.id !== current.id));
    void window.kiroApi.browserDomainReply?.(current.id, decision);
  }, [current]);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); reply('deny'); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [current, reply]);

  if (!current) return null;
  const title = sessionTitle?.(current.sessionId);
  return (
    <>
      <div className="overlay" onClick={() => reply('deny')} />
      <div className="permission-dialog browser-domain-prompt" role="dialog" aria-modal="true" aria-label={t('Open a page in your browser?')}>
        <h3>🌐 {t('Open a page in your browser?')}</h3>
        <p style={{ whiteSpace: 'pre-wrap' }}>
          {t('A chat wants to open {host} in a new tab of your logged-in browser and read it (read-only, using your login).', { host: current.host })}
        </p>
        <p className="browser-domain-url" style={{ wordBreak: 'break-all', fontFamily: 'var(--font-mono, monospace)', fontSize: '0.9em' }}>{current.url}</p>
        {title && <p className="settings-hint">{t('Chat: {title}', { title })}</p>}
        <div className="actions">
          <button className="btn deny" onClick={() => reply('deny')}>{t('Deny')}</button>
          <button className="btn allow" onClick={() => reply('once')}>{t('Allow once')}</button>
          <button className="btn allow" onClick={() => reply('session')}>{t('Allow for this chat')}</button>
        </div>
      </div>
    </>
  );
};
