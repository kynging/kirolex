/**
 * **Codex 走 Bedrock 时的 IAM 权限** —— 登录页 / 引擎面板里的预检结果，和会话里「缺权限」提示卡共用的几块。
 * 判据和策略文本都在 `main/bedrockIam.ts`；KiroLex 不改 IAM，这里只给出要贴进去的策略和「暂时关掉网页搜索」。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../hooks/useLang';
import type { BedrockIamCheck, Verdict } from '../../main/bedrockIam.ts';

const api = (): any => (window as any).kiroApi;

const mark = (v: Verdict): string => (v === 'ok' ? '✓' : v === 'denied' ? '✗' : '?');

/** 一段可以直接贴进 IAM 的策略 JSON + 「复制」。 */
export const PolicyBox: React.FC<{ policy: string }> = ({ policy }) => {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="bedrock-policy">
      <pre className="remote-log bedrock-policy-json">{policy}</pre>
      <button type="button" className="remote-btn" onClick={() => {
        void navigator.clipboard.writeText(policy).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
      }}>{copied ? t('Copied') : t('Copy policy')}</button>
    </div>
  );
};

/** 「这台机器暂时关掉 Codex 网页搜索」/「重新打开」：改那台机器 ~/.codex/config.toml 顶层的 `web_search`。 */
export const WebSearchToggle: React.FC<{ machine: string; disabled: boolean; onDone?: (disabled: boolean) => void }> = ({ machine, disabled: initial, onDone }) => {
  const t = useT();
  /* 点完按钮跟着翻（会话里的提示卡不再取状态） */
  const [disabled, setDisabled] = useState(initial);
  useEffect(() => { setDisabled(initial); }, [initial]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (): Promise<void> => {
    setBusy(true); setMsg(null);
    const r = await api()?.aiLoginCodexWebSearch?.(machine, disabled);
    setBusy(false);
    if (r?.ok) {
      setMsg({ ok: true, text: disabled ? t('Codex web search is back on for that machine. Running sessions pick it up after they reconnect.') : t('Codex web search is off on that machine. Running sessions pick it up after they reconnect.') });
      setDisabled(!disabled);
      onDone?.(!disabled);
    } else setMsg({ ok: false, text: r?.error || t('Failed') });
  };
  return (
    <>
      <button type="button" className="remote-btn" disabled={busy} onClick={() => void run()}
        title={t('Sets web_search = "disabled" at the top of ~/.codex/config.toml on that machine (the original is backed up as .kirolex-bak)')}>
        {busy ? t('Writing…') : disabled ? t('Turn Codex web search back on for this machine') : t('Turn off Codex web search on this machine for now')}
      </button>
      {msg && <span className="settings-hint" style={{ color: msg.ok ? 'var(--success, #4caf50)' : 'var(--error)' }}>{msg.ok ? '✓ ' : '✗ '}{msg.text}</span>}
    </>
  );
};

/**
 * 登录页 / 引擎面板里 Codex（走 Bedrock）那一格下面的权限检查：「模型调用 ✓ · 网页搜索 ✗」，缺的动作、身份、
 * 最小策略、关掉网页搜索。第一次看到这台机器时自动查一次（主进程按机器记着结果），「重新检查」强制再查。
 */
export const BedrockCheckRow: React.FC<{ machine: string; initial?: BedrockIamCheck }> = ({ machine, initial }) => {
  const t = useT();
  const [check, setCheck] = useState<BedrockIamCheck | null>(initial || null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = useCallback(async (force: boolean) => {
    setBusy(true); setErr('');
    const r = await api()?.aiLoginBedrockCheck?.(machine, { force });
    setBusy(false);
    if (r?.ok) setCheck(r.check); else setErr(r?.error || t('Could not check'));
  }, [machine, t]);
  useEffect(() => {
    if (initial) { setCheck(initial); return; }
    setCheck(null);
    void run(false);
  }, [machine, initial, run]);

  const how = check?.method === 'simulate' ? t('IAM policy simulation') : check?.method === 'probe' ? t('one short test call') : '';
  return (
    <div className="bedrock-check" data-testid="bedrock-check">
      <div className="remote-row-actions" style={{ justifyContent: 'space-between' }}>
        <span className="settings-hint">
          <b>{t('Bedrock permissions')}</b>{': '}
          {busy && !check ? t('Checking… (up to about a minute)')
            : check ? <>
              {t('Model calls {m}', { m: mark(check.model) })}{' · '}{t('Web search {m}', { m: mark(check.webSearch) })}
              {check.webSearchDisabled ? ` ${t('(web search is turned off on that machine)')}` : ''}
              {how ? <span style={{ opacity: 0.7 }}>{` — ${t('checked with {how}', { how })}`}</span> : null}
            </> : err ? <span style={{ color: 'var(--error)' }}>✗ {err}</span> : '—'}
        </span>
        <button type="button" className="remote-btn" disabled={busy} onClick={() => void run(true)}>{busy ? t('Checking…') : t('Check again')}</button>
      </div>
      {check && (check.roleArn || check.identity) && (
        <div className="settings-hint">{t('Identity: {arn}', { arn: check.roleArn || check.identity || '' })}</div>
      )}
      {check?.note && <div className="settings-hint">{check.note}</div>}
      {check && check.missing.length > 0 && (
        <>
          <div className="settings-hint">
            {t('Missing: {actions}. Add the policy below to that identity in IAM (KiroLex does not change IAM itself):', { actions: check.missing.join(', ') })}
          </div>
          {check.policy && <PolicyBox policy={check.policy} />}
        </>
      )}
      {check && (check.webSearch === 'denied' || check.webSearchDisabled) && (
        <div className="remote-row-actions">
          <WebSearchToggle machine={machine} disabled={check.webSearchDisabled} onDone={(d) => setCheck((c) => (c ? { ...c, webSearchDisabled: d } : c))} />
        </div>
      )}
    </div>
  );
};
