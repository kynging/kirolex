/**
 * **🔑 登录** —— 远端机器上 Claude Code / Codex 的登录。
 *
 * 「或者你只管安装不管登录？是不是可以把左下角那个配置按钮中加一个登录的选项」+
 * 「不要在当前电脑登录，要在远程机器上打开登录」+「当前电脑的网络是访问不了外网的，只能在远程机器上
 *  看看有没有命令行登录的方式」。
 *
 * 后来定下来的样子 ——「那还是就在当前设备打开浏览器吧……本机配置这个方法先不要了，你就提供一个按钮把本机配置
 * 直接拷过来，放到手动填写这个 json 编辑器中」：
 *   · 手动填写 = 一个编辑器（Claude Code 是 JSON，Codex 是 TOML 片段），「拷入本机配置」把这台电脑上那份放进去；
 *   · 官方账号登录在**那台机器上**跑登录命令，授权网址用**这台电脑**的浏览器打开。
 * 只列远端机器：这台电脑上的登录是你自己配好的，这一页不碰它。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { defaultPick } from '../remotePick.ts';
import { useT } from '../hooks/useLang';

type Tool = 'claude' | 'codex';
interface ToolStatus { installed: boolean; loggedIn: boolean; detail: string; gateway?: string }
interface Target { id: string; label: string; sshHost: string; editedAt?: number }

const api = (): any => (window as any).kiroApi;
const NAME: Record<Tool, string> = { claude: 'Claude Code', codex: 'Codex' };

/** 输出里第一个授权网址（「在浏览器打开」那颗按钮用它）。 */
function firstUrl(text: string): string | null {
  const m = String(text || '').match(/https:\/\/[^\s"'<>]+/);
  return m ? m[0] : null;
}

export const ToolCard: React.FC<{ machine: string; tool: Tool; status: ToolStatus | null; onChanged: () => void }> = ({ machine, tool, status, onChanged }) => {
  const t = useT();
  const [mode, setMode] = useState<'none' | 'manual' | 'official' | 'bedrock'>('none');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** 手动填写 = 这个编辑器：Claude Code 是 JSON（env 的键值），Codex 是 TOML 片段。 */
  const [text, setText] = useState('');
  /* 官方账号登录那一段的输出 */
  const [runId, setRunId] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [code, setCode] = useState('');
  const runRef = useRef<string | null>(null);
  runRef.current = runId;

  useEffect(() => {
    const offOut = api()?.onAiLoginOutput?.((d: { runId: string; chunk: string }) => {
      if (d.runId === runRef.current) setLog((prev) => `${prev}${d.chunk}`.slice(-8000));
    });
    const offExit = api()?.onAiLoginExit?.((d: { runId: string; code: number | null }) => {
      if (d.runId !== runRef.current) return;
      setRunId(null);
      setMsg({ ok: d.code === 0, text: d.code === 0 ? t('Login complete.') : t('Login did not complete (exit code {code}).', { code: d.code ?? '?' }) });
      onChanged();
    });
    return () => { try { offOut?.(); offExit?.(); } catch { /* 卸载 */ } };
  }, [onChanged, t]);

  /* 换机器：上一台的编辑器内容和输出都不该留着 */
  useEffect(() => { setMode('none'); setMsg(null); setLog(''); setRunId(null); setText(''); }, [machine]);

  /** 「拷入本机配置」：把这台电脑上那份放进编辑器（只读本机，不写任何地方）。 */
  const copyLocal = async (): Promise<void> => {
    const r = await api()?.aiLoginLocalConfig?.(tool);
    if (r?.ok) { setText(r.text); setMsg(null); } else setMsg({ ok: false, text: r?.error || t('Could not read the config on this computer') });
  };

  const apply = async (): Promise<void> => {
    setBusy(true); setMsg(null);
    const r = await api()?.aiLoginApply?.(machine, { tool, text });
    setBusy(false);
    setMsg({ ok: !!r?.ok, text: r?.ok ? t('Written to that machine.') : (r?.error || t('Failed')) });
    if (r?.ok) { setMode('none'); setText(''); onChanged(); }
  };

  const applyBedrock = async (): Promise<void> => {
    setBusy(true); setMsg(null);
    const r = await api()?.aiLoginApply?.(machine, { tool, mode: 'bedrock' });
    setBusy(false);
    setMsg({ ok: !!r?.ok, text: r?.ok ? t('Switched to Amazon Bedrock. Running sessions pick up the new config after they reconnect.') : (r?.error || t('Failed')) });
    if (r?.ok) { setMode('none'); onChanged(); }
  };

  const startOfficial = async (consoleBilling = false): Promise<void> => {
    setMsg(null); setLog('');
    const r = await api()?.aiLoginRun?.(machine, tool, { console: consoleBilling });
    if (!r?.ok) { setMsg({ ok: false, text: r?.error || t('Could not start') }); return; }
    setRunId(r.runId);
  };
  const url = firstUrl(log);

  return (
    <div className="remote-form" style={{ marginBottom: 12 }}>
      <div className="remote-row-actions" style={{ justifyContent: 'space-between' }}>
        <b>{NAME[tool]}</b>
        <span className="settings-hint">
          {!status ? t('Checking…')
            : !status.installed ? t('✗ Not installed on that machine (click "Install AI tools" on the Machines page first)')
              : status.loggedIn ? `✓ ${status.detail}${status.gateway ? ` · ${status.gateway}` : ''}`
                : `✗ ${status.detail}`}
        </span>
      </div>

      {status?.installed && (
        <div className="remote-row-actions">
          {/* 默认推荐 Bedrock ——「默认将模型设置为 bedrock 的 global endpoint，保留让客户自己配置域名和 key 或者用官方订阅登录的选项」 */}
          <button className="remote-btn remote-btn-primary" disabled={busy || !!runId} onClick={() => setMode(mode === 'bedrock' ? 'none' : 'bedrock')}>{t('Use Amazon Bedrock (recommended)')}</button>
          <button className="remote-btn" disabled={busy || !!runId} onClick={() => setMode(mode === 'manual' ? 'none' : 'manual')}>{t('Enter manually')}</button>
          <button className="remote-btn" disabled={busy || !!runId} onClick={() => setMode(mode === 'official' ? 'none' : 'official')}>{t('Sign in with official account')}</button>
        </div>
      )}

      {mode === 'bedrock' && (
        <>
          <p className="settings-hint" style={{ margin: '4px 0' }}>
            {tool === 'claude'
              ? <>{t('Writes to ')}<code>~/.claude/settings.json</code>{t(' on that machine, under ')}<code>env</code>{t(': ')}<code>CLAUDE_CODE_USE_BEDROCK=1</code>{t(', that machine\'s own ')}<code>AWS_REGION</code>{t(', and the global inference profiles (')}<code>global.anthropic.claude-opus-5-5</code>{t(' / sonnet-5-5 / haiku-4-5). The old gateway URL and key are removed; other settings are untouched.')}</>
              : <>{t('Writes to ')}<code>~/.codex/config.toml</code>{t(' on that machine: ')}<code>model_provider = "amazon-bedrock"</code>{t(', ')}<code>openai.gpt-6.1-sol</code>{t(', region ')}<code>us-east-1</code>{t(' (Codex uses the Bedrock Responses endpoint, and OpenAI models are currently in US East; it does not accept the global prefix). The old gateway section is kept; to switch back, just change ')}<code>model_provider</code>{t(' again.')}</>}
            {' '}<b>{t('No keys are written')}</b>{t(': it uses that machine\'s AWS credential chain (EC2 instance role, ')}<code>~/.aws</code>{t(', SSO), which needs permission to invoke Bedrock. The original file is backed up as ')}<code>.kirolex-bak</code>{t('.')}
          </p>
          <div className="remote-row-actions">
            <button className="remote-btn remote-btn-primary" disabled={busy} onClick={() => void applyBedrock()}>
              {busy ? t('Writing…') : t('Write to that machine')}
            </button>
          </div>
        </>
      )}

      {mode === 'manual' && (
        <>
          <p className="settings-hint" style={{ margin: '4px 0' }}>
            {tool === 'claude'
              ? <>{t('JSON: written to ')}<code>~/.claude/settings.json</code>{t(' on that machine, under ')}<code>env</code>{t(' (only the keys given here are overwritten; other settings are untouched). It needs at least ')}<code>ANTHROPIC_API_KEY</code>{t('.')}</>
              : <>{t('TOML: top-level ')}<code>model</code> / <code>model_provider</code>{t(' plus a ')}<code>{t('[model_providers.<name>]')}</code>{t(' section, merged into ')}<code>~/.codex/config.toml</code>{t(' on that machine (other settings are untouched).')}</>}
            {' '}{t('The original file is backed up as ')}<code>.kirolex-bak</code>{t('.')}
          </p>
          <textarea
            className="settings-input"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={tool === 'claude' ? 7 : 10}
            style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: 12, resize: 'vertical' }}
          />
          <div className="remote-row-actions">
            <button className="remote-btn" disabled={busy} onClick={() => void copyLocal()}
              title={tool === 'claude' ? t('Put the ANTHROPIC_* entries from ~/.claude/settings.json on this computer into the editor above') : t('Put the provider currently used in ~/.codex/config.toml on this computer (the two top-level lines + its section) into the editor above')}>
              {t('Copy in local config')}
            </button>
            <button className="remote-btn remote-btn-primary" disabled={busy || !text.trim()} onClick={() => void apply()}>
              {busy ? t('Writing…') : t('Write to that machine')}
            </button>
          </div>
        </>
      )}

      {mode === 'official' && (
        <>
          <p className="settings-hint" style={{ margin: '4px 0' }}>
            {t('Runs ')}{tool === 'claude' ? <code>claude auth login</code> : <code>codex login --device-auth</code>}{t(' on that machine.')}
            {t(' Once it shows the authorization URL, click "Open in browser" to authorize in this computer\'s browser')}
            {tool === 'claude' ? t('; after authorizing, the browser shows a code. Paste it below to send it back.') : t(' (you also need to enter the verification code shown below); it finishes on its own once authorized.')}
          </p>
          {!runId ? (
            <div className="remote-row-actions">
              <button className="remote-btn" onClick={() => void startOfficial(false)}>{tool === 'claude' ? t('Sign in with Claude account') : t('Start login')}</button>
              {tool === 'claude' && <button className="remote-btn" onClick={() => void startOfficial(true)}>{t('Sign in with Anthropic Console (API billing)')}</button>}
            </div>
          ) : (
            <div className="remote-row-actions">
              {url && <button className="remote-btn remote-btn-primary" onClick={() => void api()?.openExternal?.(url)}>{t('Open in browser')}</button>}
              {tool === 'claude' && (
                <>
                  <input className="settings-input" style={{ flex: 1 }} spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
                  <button className="remote-btn" disabled={!code.trim()} onClick={() => { void api()?.aiLoginInput?.(runId, code); setCode(''); }}>{t('Send code')}</button>
                </>
              )}
              <button className="remote-btn" onClick={() => void api()?.aiLoginCancel?.(runId)}>{t('Cancel')}</button>
            </div>
          )}
          {log && <pre className="remote-log">{log}</pre>}
        </>
      )}

      {msg && <p className="settings-hint" style={{ color: msg.ok ? 'var(--success, #4caf50)' : 'var(--error)', whiteSpace: 'pre-wrap' }}>{msg.ok ? '✓ ' : '✗ '}{msg.text}</p>}
    </div>
  );
};

export const LoginSettings: React.FC = () => {
  const t = useT();
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [machine, setMachine] = useState('');
  const [status, setStatus] = useState<{ claude: ToolStatus; codex: ToolStatus } | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    void (async () => {
      const r = await api()?.remoteTargets?.();
      const list: Target[] = Array.isArray(r?.targets) ? r.targets : [];
      setTargets(list);
      if (list.length) setMachine(defaultPick(list));
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (!machine) return;
    setStatus(null); setErr('');
    const r = await api()?.aiLoginStatus?.(machine);
    if (r?.ok) setStatus({ claude: r.claude, codex: r.codex });
    else setErr(r?.error || t('Could not get status'));
  }, [machine, t]);
  useEffect(() => { void refresh(); }, [refresh]);

  if (targets === null) return <p className="settings-hint">{t('Reading…')}</p>;
  if (!targets.length) return <p className="settings-hint">{t('No remote machines yet. Add one under "🖥 Machines" first. Login is only configured for remote machines (login on this computer is yours to set up; this page does not touch it).')}</p>;

  return (
    <div className="settings-item settings-item-wide">
      <label className="settings-label">{t('Claude Code / Codex login on remote machines')}</label>
      <p className="settings-hint">
        {t('Login happens on that machine (over ssh). ')}<b>{t('Enter manually')}</b>{t(' is an editor: use "Copy in local config" to start from the copy on this computer, review and tweak it, then write it over. ')}<b>{t('Sign in with official account')}</b>{t(' runs the login command on that machine and opens the authorization URL in this computer\'s browser.')}
      </p>
      <div className="remote-row-actions">
        <select className="settings-select" value={machine} onChange={(e) => setMachine(e.target.value)}>
          {targets.map((x) => <option key={x.id} value={x.id}>{`🌐 ${x.label} — ${x.sshHost}`}</option>)}
        </select>
        <button className="remote-btn" onClick={() => void refresh()}>{t('Refresh status')}</button>
      </div>
      {err && <p className="settings-hint" style={{ color: 'var(--error)' }}>✗ {err}</p>}
      <ToolCard machine={machine} tool="claude" status={status?.claude || null} onChanged={() => void refresh()} />
      <ToolCard machine={machine} tool="codex" status={status?.codex || null} onChanged={() => void refresh()} />
    </div>
  );
};

/**
 * 机器人面板里那一页 ——「我说的是让你放到右侧会话框的左下角那个机器人图案中」。
 * 登录给**这条会话跑的那台机器**（`machine` 传会话 id，主进程按它找到那台远端；本机会话会说清不在这里登录）。
 */
export const EngineLoginPane: React.FC<{ sessionId: string; tool: Tool }> = ({ sessionId, tool }) => {
  const t = useT();
  const [status, setStatus] = useState<ToolStatus | null>(null);
  const [err, setErr] = useState('');
  const refresh = useCallback(async () => {
    setStatus(null); setErr('');
    const r = await api()?.aiLoginStatus?.(sessionId);
    if (r?.ok) setStatus(r[tool]); else setErr(r?.error || t('Could not get status'));
  }, [sessionId, tool, t]);
  useEffect(() => { void refresh(); }, [refresh]);
  return (
    <div style={{ padding: '8px 4px' }}>
      <div className="remote-row-actions">
        <span className="settings-hint">{t('Login happens on the machine this session runs on (over ssh).')}</span>
        <button className="remote-btn" onClick={() => void refresh()}>{t('Refresh status')}</button>
      </div>
      {err
        ? <p className="settings-hint" style={{ color: 'var(--error)', whiteSpace: 'pre-wrap' }}>✗ {err}</p>
        : <ToolCard machine={sessionId} tool={tool} status={status} onChanged={() => void refresh()} />}
    </div>
  );
};
