import React, { useEffect, useRef, useState } from 'react';

/**
 * **在界面上配一台远端机器** ——「界面上甚至没有配置远程EC2的地方」。
 *
 * 远程会话（`docs/DESIGN_remote_sessions.md`）把这条会话的 kiro-cli 跑在另一台机器上，文件仍以本地
 * 为准。功能做出来了却只能手改 `~/.kirolex/config.json` —— 没有入口等于没做。这一块补的就是入口：
 * 列表、加/改/删、**测试连接**。
 *
 * 「测试连接」不是装饰：远端的三种毛病在别处看不出来，而且各有各的下一步 ——
 * 连不上（网络/密钥/安全组）、缺 rsync/git（跑一次预置脚本）、没登录（去那台机器
 * `kiro-cli login`）。最后一种最坑：执行器起得来、但每一轮都空回，看起来就像服务端在返空响应。
 */
export interface RemoteRow {
  id: string;
  label: string;
  sshHost: string;
  sshPort?: number;
  identityFile?: string;
  remoteWorkdir?: string;
}

type Draft = Partial<RemoteRow> & { sshHost: string };

const EMPTY: Draft = { sshHost: '', label: '', sshPort: 22, identityFile: '', remoteWorkdir: '' };

export const RemoteSettings: React.FC = () => {
  const [rows, setRows] = useState<RemoteRow[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  /** 安装脚本的实时输出。装东西要几分钟（kiro-cli 那个包几百 MB），一个字不给看就像卡死了。 */
  const [log, setLog] = useState<string>('');
  const [installing, setInstalling] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const off = (window as any).kiroApi?.onRemoteBootstrapOutput?.((d: { chunk: string }) => {
      setLog((prev) => `${prev}${d.chunk}`.slice(-20000));
    });
    return () => { try { off?.(); } catch { /* preload 可能已经没了 */ } };
  }, []);

  /* 输出滚到底 —— 正在跑的那几行才是人想看的 */
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const reload = async (): Promise<void> => {
    const r = await (window as any).kiroApi?.remoteTargets?.();
    setRows(Array.isArray(r?.targets) ? r.targets : []);
    setEnabled(!!r?.enabled);
  };

  useEffect(() => { void reload(); }, []);

  const save = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setResult(null);
    const r = await (window as any).kiroApi?.remoteSave?.(draft);
    setBusy(false);
    if (!r?.ok) { setResult({ ok: false, text: r?.error || '保存失败' }); return; }
    setDraft(null);
    await reload();
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    setResult(null);
    const r = await (window as any).kiroApi?.remoteDelete?.(id);
    setBusy(false);
    if (!r?.ok) setResult({ ok: false, text: r?.error || '删除失败' });
    await reload();
  };

  /**
   * **一键装齐**：kiro-cli / claude code / codex / node / rsync / git。
   *
   * 这是在**别人的机器上装东西**，所以只在你按下按钮时发生，没有任何自动触发的路径。
   */
  const bootstrap = async (input: Draft, force = false): Promise<void> => {
    setResult(null);
    setLog('');
    setInstalling(input.sshHost);
    const r = await (window as any).kiroApi?.remoteBootstrap?.({ ...input, force });
    setInstalling(null);
    setResult({ ok: !!r?.ok, text: r?.ok ? '装好了 —— 下面是自检输出。' : (r?.error || '安装失败') });
  };

  const test = async (input: Draft): Promise<void> => {
    setBusy(true);
    setResult(null);
    const r = await (window as any).kiroApi?.remoteTest?.(input);
    setBusy(false);
    setResult({ ok: !!r?.ok, text: r?.message || '测试失败' });
  };

  return (
    <div className="settings-item settings-item-wide">
      <label className="settings-label">远端机器（远程会话）</label>
      <p className="settings-hint" style={{ marginTop: 0 }}>
        在这里配好之后，<b>新建对话</b>时可以选让这条会话的 kiro-cli 跑在那台机器上。
        文件始终存在本地 —— 每一轮前后自动同步镜像。远端不做构建/测试/预览。
        <br />每台机器右边有两个按钮：<b>安装依赖</b>（在那台机器上装 kiro-cli / claude code /
        codex / node / rsync / git，以及 kiro-cli 默认 agent 的 web search MCP）和
        <b>测试连接</b>（查工具、登录、连通）。
      </p>
      {!enabled && (
        <p className="settings-hint" style={{ color: 'var(--error)' }}>
          远程会话当前是关着的（<code>remoteSessions</code>）。开关在下面的功能开关列表里 ——
          关着的时候这里配了也不会出现在新建对话的选项里。
        </p>
      )}

      {rows.length === 0 && <p className="settings-hint">还没有配置任何远端机器。</p>}
      {rows.map((r) => (
        <div key={r.id} className="remote-row">
          <div className="remote-row-main">
            <span className="remote-row-label">🌐 {r.label}</span>
            <span className="remote-row-host">{r.sshHost}{r.sshPort && r.sshPort !== 22 ? `:${r.sshPort}` : ''}</span>
            {r.remoteWorkdir && <span className="remote-row-dir">{r.remoteWorkdir}</span>}
          </div>
          <div className="remote-row-actions">
            <button className="remote-btn" disabled={busy || !!installing} onClick={() => void test(r as Draft)}>测试连接</button>
            <button
              className="remote-btn remote-btn-primary"
              disabled={busy || !!installing}
              title="在这台机器上装 kiro-cli / claude code / codex / node / rsync / git + web search MCP（幂等，已装的跳过）"
              onClick={() => void bootstrap(r as Draft)}
            >{installing === r.sshHost ? '安装中…' : '安装依赖'}</button>
            <button className="remote-btn" disabled={busy} onClick={() => { setResult(null); setDraft({ ...EMPTY, ...r }); }}>编辑</button>
            <button className="remote-btn" disabled={busy} onClick={() => void remove(r.id)}>删除</button>
          </div>
        </div>
      ))}

      {draft ? (
        <div className="remote-form">
          <input
            className="settings-input"
            placeholder="名字（徽标上显示的，例如 tokyo-ec2）"
            value={draft.label || ''}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          <input
            className="settings-input"
            autoFocus
            placeholder="SSH 地址，例如 ec2-user@1.2.3.4"
            value={draft.sshHost}
            onChange={(e) => setDraft({ ...draft, sshHost: e.target.value })}
          />
          <input
            className="settings-input"
            placeholder="端口（默认 22）"
            value={draft.sshPort === undefined ? '' : String(draft.sshPort)}
            onChange={(e) => setDraft({ ...draft, sshPort: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
          <input
            className="settings-input"
            placeholder="私钥路径，例如 ~/kyn-key-tokyo.pem（留空 = 用 ssh 的默认配置）"
            value={draft.identityFile || ''}
            onChange={(e) => setDraft({ ...draft, identityFile: e.target.value })}
          />
          <input
            className="settings-input"
            placeholder="远端工作目录（镜像放哪，例如 /home/ec2-user/kirolex-mirror）"
            value={draft.remoteWorkdir || ''}
            onChange={(e) => setDraft({ ...draft, remoteWorkdir: e.target.value })}
          />
          <div className="remote-row-actions">
            <button className="remote-btn" disabled={busy || !!installing || !draft.sshHost.trim()} onClick={() => void test(draft)}>测试连接</button>
            <button
              className="remote-btn"
              disabled={busy || !!installing || !draft.sshHost.trim()}
              title="先保存再装也行；这里直接装是为了新机器一次配好"
              onClick={() => void bootstrap(draft)}
            >{installing ? '安装中…' : '安装依赖'}</button>
            <button className="remote-btn remote-btn-primary" disabled={busy || !draft.sshHost.trim()} onClick={() => void save()}>保存</button>
            <button className="remote-btn" disabled={busy} onClick={() => { setDraft(null); setResult(null); }}>取消</button>
          </div>
        </div>
      ) : (
        <button className="remote-btn" disabled={busy} onClick={() => { setResult(null); setDraft({ ...EMPTY }); }}>
          + 添加一台远端机器
        </button>
      )}

      {busy && <p className="settings-hint">正在连…（最多等 30 秒）</p>}
      {installing && (
        <p className="settings-hint">
          正在 {installing} 上装依赖…（kiro-cli 的包有几百 MB，npm 还要装三个包，几分钟是正常的）
        </p>
      )}
      {log && <pre ref={logRef} className="remote-log">{log}</pre>}
      {result && (
        <p className="settings-hint" style={{ color: result.ok ? 'var(--success, #4caf50)' : 'var(--error)', whiteSpace: 'pre-wrap' }}>
          {result.ok ? '✓ ' : '✗ '}{result.text}
        </p>
      )}
    </div>
  );
};
