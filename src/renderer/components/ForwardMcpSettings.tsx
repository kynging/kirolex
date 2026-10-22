import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../hooks/useLang';

/**
 * **「远程会话从本机转发的 MCP」名单** —— 妙想这类 HTTP MCP：上游按本机出口 IP / 本机密钥鉴权，
 * 远端直连不行。名单里的名字（和 Kiro agent 文件 `mcpServers` 的键一致）在远程会话里由本机代发；
 * stdio 型的也一律在本机跑。名单为空 = 和以前一样。
 *
 * 存在 `~/.kirolex/config.json`（`remoteForwardMcp`），**不写进** Kiro 的 agent 文件 ——
 * kiro-cli 严格校验 agent JSON，多一个它不认识的字段就整份拒绝、静默退回默认 agent。
 */
interface Row { name: string; timeoutSec: string }

const DEFAULT_TIMEOUT = 180;

function toList(rows: Row[]): Array<{ name: string; timeoutSec: number }> {
  return rows
    .filter((r) => r.name.trim())
    .map((r) => ({ name: r.name.trim(), timeoutSec: Number(r.timeoutSec) || DEFAULT_TIMEOUT }));
}

export function ForwardMcpSettings(): React.ReactElement {
  const t = useT();
  const [rows, setRows] = useState<Row[]>([]);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 还没发出去的那一版 —— 面板关掉 / 切页签时要立刻补发，不能跟着定时器一起丢掉。 */
  const pending = useRef<Row[] | undefined>(undefined);

  useEffect(() => {
    window.kiroApi.getForwardMcp?.().then((list) => {
      setRows((list || []).map((it) => ({ name: it.name, timeoutSec: String(it.timeoutSec) })));
    }).catch(() => {});
    return () => {
      if (timer.current) clearTimeout(timer.current);
      /* 卸载时把最后一次修改发出去（IPC 在主进程里完成，不依赖这个组件还在） */
      if (pending.current) {
        window.kiroApi.setForwardMcp?.(toList(pending.current)).catch(() => {});
        pending.current = undefined;
      }
    };
  }, []);

  /* 打字时合并 400ms 再存：名单只在准备远程会话时读，存半截名字也只是多写一次 config */
  const persist = (next: Row[]) => {
    setRows(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    setSaved('saving');
    timer.current = setTimeout(() => {
      timer.current = undefined;
      pending.current = undefined;
      window.kiroApi.setForwardMcp?.(toList(next))
        .then((r) => setSaved(r?.ok ? 'saved' : 'error'))
        .catch(() => setSaved('error'));
    }, 400);
  };

  const update = (i: number, patch: Partial<Row>) => persist(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="settings-item settings-item-wide" data-testid="forward-mcp-settings">
      <label className="settings-label">{t('MCPs forwarded from this machine to remote sessions')}</label>
      <p className="settings-hint" style={{ marginTop: 0 }}>
        {t('Enter the names used under mcpServers in your Kiro agent file (e.g. mx-ds-mcp). In remote sessions (Kiro, Claude Code and Codex alike) their requests are sent from this machine: an HTTP upstream sees your local outbound IP, ${env:…} in request headers is expanded from your local environment, and keys never reach the remote. The timeout only applies to HTTP entries (at least 120 seconds). Changes apply to the next remote session; local sessions are not affected.')}
      </p>
      {rows.map((r, i) => (
        <div key={i} className="settings-control" style={{ gap: 8, marginBottom: 6 }}>
          <input
            className="settings-input forward-mcp-name"
            placeholder={t('MCP name')}
            value={r.name}
            onChange={(e) => update(i, { name: e.target.value })}
            style={{ flex: 1 }}
          />
          <input
            className="settings-input forward-mcp-timeout"
            type="number"
            min={1}
            value={r.timeoutSec}
            onChange={(e) => update(i, { timeoutSec: e.target.value })}
            style={{ width: 80 }}
            title={t('Timeout (seconds)')}
          />
          <span className="settings-hint">{t('sec')}</span>
          <button className="settings-btn forward-mcp-remove" title={t('Remove this entry')} onClick={() => persist(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="settings-control" style={{ gap: 8 }}>
        <button
          className="remote-btn forward-mcp-add"
          onClick={() => persist([...rows, { name: '', timeoutSec: String(DEFAULT_TIMEOUT) }])}
        >{t('+ Add')}</button>
        {!rows.length && <span className="settings-hint">{t('List is empty: remote sessions only forward MCPs whose command is a local path (same as before).')}</span>}
        {saved === 'saving' && <span className="settings-hint">{t('Saving…')}</span>}
        {saved === 'saved' && <span className="settings-hint">{t('Saved')}</span>}
        {saved === 'error' && <span className="settings-hint" style={{ color: 'var(--error)' }}>{t('Not saved — try editing again')}</span>}
      </div>
    </div>
  );
}
