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
  const [mode, setMode] = useState<'none' | 'manual' | 'official'>('none');
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
      setMsg({ ok: d.code === 0, text: d.code === 0 ? '登录完成。' : `登录没完成（退出码 ${d.code ?? '?'}）。` });
      onChanged();
    });
    return () => { try { offOut?.(); offExit?.(); } catch { /* 卸载 */ } };
  }, [onChanged]);

  /* 换机器：上一台的编辑器内容和输出都不该留着 */
  useEffect(() => { setMode('none'); setMsg(null); setLog(''); setRunId(null); setText(''); }, [machine]);

  /** 「拷入本机配置」：把这台电脑上那份放进编辑器（只读本机，不写任何地方）。 */
  const copyLocal = async (): Promise<void> => {
    const r = await api()?.aiLoginLocalConfig?.(tool);
    if (r?.ok) { setText(r.text); setMsg(null); } else setMsg({ ok: false, text: r?.error || '读不到本机的配置' });
  };

  const apply = async (): Promise<void> => {
    setBusy(true); setMsg(null);
    const r = await api()?.aiLoginApply?.(machine, { tool, text });
    setBusy(false);
    setMsg({ ok: !!r?.ok, text: r?.ok ? '已写到那台机器上。' : (r?.error || '失败') });
    if (r?.ok) { setMode('none'); setText(''); onChanged(); }
  };

  const startOfficial = async (consoleBilling = false): Promise<void> => {
    setMsg(null); setLog('');
    const r = await api()?.aiLoginRun?.(machine, tool, { console: consoleBilling });
    if (!r?.ok) { setMsg({ ok: false, text: r?.error || '起不来' }); return; }
    setRunId(r.runId);
  };
  const url = firstUrl(log);

  return (
    <div className="remote-form" style={{ marginBottom: 12 }}>
      <div className="remote-row-actions" style={{ justifyContent: 'space-between' }}>
        <b>{NAME[tool]}</b>
        <span className="settings-hint">
          {!status ? '查询中…'
            : !status.installed ? '✗ 那台机器上没装（先在「机器」页点「安装 AI 工具」）'
              : status.loggedIn ? `✓ ${status.detail}${status.gateway ? ` · ${status.gateway}` : ''}`
                : `✗ ${status.detail}`}
        </span>
      </div>

      {status?.installed && (
        <div className="remote-row-actions">
          <button className="remote-btn" disabled={busy || !!runId} onClick={() => setMode(mode === 'manual' ? 'none' : 'manual')}>手动填写</button>
          <button className="remote-btn" disabled={busy || !!runId} onClick={() => setMode(mode === 'official' ? 'none' : 'official')}>官方账号登录</button>
        </div>
      )}

      {mode === 'manual' && (
        <>
          <p className="settings-hint" style={{ margin: '4px 0' }}>
            {tool === 'claude'
              ? <>JSON：写进那台机器 <code>~/.claude/settings.json</code> 的 <code>env</code>（只覆盖这里给出的键，别的设置不动）。至少要有 <code>ANTHROPIC_API_KEY</code>。</>
              : <>TOML：顶层的 <code>model</code> / <code>model_provider</code> 加一个 <code>[model_providers.&lt;名字&gt;]</code> 段，合并进那台机器的 <code>~/.codex/config.toml</code>（别的设置不动）。</>}
            {' '}原文件先备份成 <code>.kirolex-bak</code>。
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
              title={tool === 'claude' ? '把这台电脑 ~/.claude/settings.json 里的 ANTHROPIC_* 那几项放进上面的编辑器' : '把这台电脑 ~/.codex/config.toml 里当前用的 provider（顶层两行 + 那一段）放进上面的编辑器'}>
              拷入本机配置
            </button>
            <button className="remote-btn remote-btn-primary" disabled={busy || !text.trim()} onClick={() => void apply()}>
              {busy ? '写入中…' : '写到那台机器上'}
            </button>
          </div>
        </>
      )}

      {mode === 'official' && (
        <>
          <p className="settings-hint" style={{ margin: '4px 0' }}>
            在那台机器上跑 {tool === 'claude' ? <code>claude auth login</code> : <code>codex login --device-auth</code>}。
            它给出授权网址后，点「在浏览器打开」用这台电脑的浏览器授权
            {tool === 'claude' ? '；授权完浏览器会给一串 code，贴到下面发回去。' : '（还要输入下面显示的验证码）；授权完它自己就结束了。'}
          </p>
          {!runId ? (
            <div className="remote-row-actions">
              <button className="remote-btn" onClick={() => void startOfficial(false)}>{tool === 'claude' ? '用 Claude 账号登录' : '开始登录'}</button>
              {tool === 'claude' && <button className="remote-btn" onClick={() => void startOfficial(true)}>用 Anthropic Console（按 API 计费）登录</button>}
            </div>
          ) : (
            <div className="remote-row-actions">
              {url && <button className="remote-btn remote-btn-primary" onClick={() => void api()?.openExternal?.(url)}>在浏览器打开</button>}
              {tool === 'claude' && (
                <>
                  <input className="settings-input" style={{ flex: 1 }} spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
                  <button className="remote-btn" disabled={!code.trim()} onClick={() => { void api()?.aiLoginInput?.(runId, code); setCode(''); }}>发送 code</button>
                </>
              )}
              <button className="remote-btn" onClick={() => void api()?.aiLoginCancel?.(runId)}>取消</button>
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
    else setErr(r?.error || '查不到状态');
  }, [machine]);
  useEffect(() => { void refresh(); }, [refresh]);

  if (targets === null) return <p className="settings-hint">读取中…</p>;
  if (!targets.length) return <p className="settings-hint">还没有远端机器 —— 先在「🖥 机器」里加一台。登录只给远端机器配（这台电脑上的登录是你自己配好的，这里不碰）。</p>;

  return (
    <div className="settings-item settings-item-wide">
      <label className="settings-label">远端机器上 Claude Code / Codex 的登录</label>
      <p className="settings-hint">
        登录落在那台机器上（ssh）。<b>手动填写</b>是一个编辑器：可以用「拷入本机配置」把这台电脑上那份先放进去，
        看一眼、改一改再写过去；<b>官方账号登录</b>在那台机器上跑登录命令，授权网址用这台电脑的浏览器打开。
      </p>
      <div className="remote-row-actions">
        <select className="settings-select" value={machine} onChange={(e) => setMachine(e.target.value)}>
          {targets.map((t) => <option key={t.id} value={t.id}>{`🌐 ${t.label} — ${t.sshHost}`}</option>)}
        </select>
        <button className="remote-btn" onClick={() => void refresh()}>刷新状态</button>
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
  const [status, setStatus] = useState<ToolStatus | null>(null);
  const [err, setErr] = useState('');
  const refresh = useCallback(async () => {
    setStatus(null); setErr('');
    const r = await api()?.aiLoginStatus?.(sessionId);
    if (r?.ok) setStatus(r[tool]); else setErr(r?.error || '查不到状态');
  }, [sessionId, tool]);
  useEffect(() => { void refresh(); }, [refresh]);
  return (
    <div style={{ padding: '8px 4px' }}>
      <div className="remote-row-actions">
        <span className="settings-hint">登录落在这条会话跑的那台机器上（ssh）。</span>
        <button className="remote-btn" onClick={() => void refresh()}>刷新状态</button>
      </div>
      {err
        ? <p className="settings-hint" style={{ color: 'var(--error)', whiteSpace: 'pre-wrap' }}>✗ {err}</p>
        : <ToolCard machine={sessionId} tool={tool} status={status} onChanged={() => void refresh()} />}
    </div>
  );
};
