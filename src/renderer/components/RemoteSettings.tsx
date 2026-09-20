import React, { useEffect, useRef, useState } from 'react';

/**
 * **在界面上配一台远端机器** ——「界面上甚至没有配置远程EC2的地方」。
 *
 * 远程会话（`docs/DESIGN_remote_sessions.md`）把这条会话的 kiro-cli 跑在另一台机器上，文件仍以本地
 * 为准。功能做出来了却只能手改 `~/.kirolex/config.json` —— 没有入口等于没做。
 *
 * ## 形状：下拉选机器，下面编辑那一台
 *
 * 上一版是"一行一台 + 每行四个按钮"，挤（实测每个按钮只有 43–63px），机器一多就是一片按钮。
 * 现在跟设置里其它项一致：下拉选中一台（或「+ 添加」），下面是它的字段和一组动作 ——
 * 同一时刻只可能在编辑一台，所以按钮只要一组。
 *
 * ## 密钥用 Finder 选，不让人手写路径
 *
 * 「我是需要能到 finder 里面去找到密钥文件而不是还得自己写路径」。手写路径的代价不是麻烦，
 * 是**错了看不出来**：`~/Downloads/key.pem` 少个字母，表现是 SSH 认证失败，跟"机器没开"长得一样。
 *
 * 「测试连接」和「安装依赖」也在这里：远端的毛病在别处看不出来，而且各有各的下一步 ——
 * 连不上（网络/密钥/安全组）、缺 rsync/git（一键装）、没登录（去那台机器 `kiro-cli login`）。
 * 最后一种最坑：执行器起得来、但每一轮都空回，看起来就像服务端在返空响应。
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

const NEW = '__new__';
const EMPTY: Draft = { sshHost: '', label: '', sshPort: 22, identityFile: '', remoteWorkdir: '' };

export const RemoteSettings: React.FC = () => {
  const [rows, setRows] = useState<RemoteRow[]>([]);
  const [enabled, setEnabled] = useState(false);
  /** 选中的机器 id；`__new__` = 正在加一台；空 = 一台都没有。 */
  const [picked, setPicked] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  /** 安装脚本的实时输出。装东西要几分钟（kiro-cli 那个包几百 MB），一个字不给看就像卡死了。 */
  const [log, setLog] = useState('');
  const logRef = useRef<HTMLPreElement | null>(null);

  const reload = async (keep?: string): Promise<void> => {
    const r = await (window as any).kiroApi?.remoteTargets?.();
    const list: RemoteRow[] = Array.isArray(r?.targets) ? r.targets : [];
    setRows(list);
    setEnabled(!!r?.enabled);
    /* 默认选中第一台：打开设置就看到它的配置，而不是一个空下拉 */
    const next = keep && list.some((x) => x.id === keep) ? keep : (list[0]?.id || NEW);
    setPicked(next);
    setDraft(next === NEW ? { ...EMPTY } : { ...EMPTY, ...list.find((x) => x.id === next) });
  };

  useEffect(() => { void reload(); }, []);

  useEffect(() => {
    const off = (window as any).kiroApi?.onRemoteBootstrapOutput?.((d: { chunk: string }) => {
      setLog((prev) => `${prev}${d.chunk}`.slice(-20000));
    });
    return () => { try { off?.(); } catch { /* 卸载时 preload 可能已经没了 */ } };
  }, []);

  /* 输出滚到底 —— 正在跑的那几行才是人想看的 */
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const pick = (id: string): void => {
    setResult(null);
    setPicked(id);
    setDraft(id === NEW ? { ...EMPTY } : { ...EMPTY, ...rows.find((x) => x.id === id) });
  };

  const pickKey = async (): Promise<void> => {
    const r = await (window as any).kiroApi?.remotePickKey?.();
    if (r?.path && draft) setDraft({ ...draft, identityFile: r.path });
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setResult(null);
    const r = await (window as any).kiroApi?.remoteSave?.(draft);
    setBusy(false);
    if (!r?.ok) { setResult({ ok: false, text: r?.error || '保存失败' }); return; }
    setResult({ ok: true, text: '已保存' });
    await reload(r.target?.id);
  };

  const remove = async (): Promise<void> => {
    if (!draft?.id) return;
    setBusy(true);
    setResult(null);
    const r = await (window as any).kiroApi?.remoteDelete?.(draft.id);
    setBusy(false);
    if (!r?.ok) setResult({ ok: false, text: r?.error || '删除失败' });
    await reload();
  };

  const test = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setResult(null);
    const r = await (window as any).kiroApi?.remoteTest?.(draft);
    setBusy(false);
    setResult({ ok: !!r?.ok, text: r?.message || '测试失败' });
  };

  /**
   * **一键装齐**：kiro-cli / claude code / codex / node / rsync / git，以及 kiro-cli 默认 agent
   * 的 web search MCP。这是在**别人的机器上装东西**，所以只在你按下按钮时发生。
   */
  const bootstrap = async (): Promise<void> => {
    if (!draft) return;
    setResult(null);
    setLog('');
    setInstalling(true);
    const r = await (window as any).kiroApi?.remoteBootstrap?.(draft);
    setInstalling(false);
    setResult({ ok: !!r?.ok, text: r?.ok ? '装好了 —— 上面是自检输出。' : (r?.error || '安装失败') });
  };

  const locked = busy || installing;
  const canAct = !!draft?.sshHost.trim();

  return (
    <div className="settings-item settings-item-wide">
      <label className="settings-label">远端机器（远程会话）</label>
      <p className="settings-hint" style={{ marginTop: 0 }}>
        配好之后，<b>新建对话</b>时可以选让那条会话的 kiro-cli 跑在这台机器上。文件始终存在本地 ——
        每一轮前后自动同步镜像；远端不做构建/测试/预览。
      </p>
      {!enabled && (
        <p className="settings-hint" style={{ color: 'var(--error)' }}>
          远程会话当前是关着的（<code>remoteSessions</code>，开关在下面的功能开关里）——
          关着的时候这里配了也不会出现在新建对话的选项里。
        </p>
      )}

      <select
        className="settings-select"
        value={picked}
        onChange={(e) => pick(e.target.value)}
        style={{ marginBottom: 8, width: '100%' }}
      >
        {rows.map((r) => (
          <option key={r.id} value={r.id}>{`🌐 ${r.label} — ${r.sshHost}`}</option>
        ))}
        <option value={NEW}>+ 添加一台机器…</option>
      </select>

      {draft && (
        <div className="remote-form">
          <input
            className="settings-input"
            placeholder="名字（徽标上显示的，例如 tokyo-ec2）"
            value={draft.label || ''}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          <input
            className="settings-input"
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
          {/* 密钥用 Finder 选 —— 手写路径错一个字母，表现是"认证失败"，跟机器没开长得一样 */}
          <div className="remote-key">
            <span className={`remote-key-path${draft.identityFile ? '' : ' empty'}`} title={draft.identityFile || ''}>
              🔑 {draft.identityFile || '没有选私钥（可选 —— 留空就用 ssh 自己的配置）'}
            </span>
            <button className="remote-btn" disabled={locked} onClick={() => void pickKey()}>选择密钥…</button>
            {draft.identityFile && (
              <button className="remote-btn" disabled={locked} onClick={() => setDraft({ ...draft, identityFile: '' })}>清除</button>
            )}
          </div>
          <input
            className="settings-input"
            placeholder="远端工作目录（镜像放哪，例如 /home/ec2-user/kirolex-mirror）"
            value={draft.remoteWorkdir || ''}
            onChange={(e) => setDraft({ ...draft, remoteWorkdir: e.target.value })}
          />
          <div className="remote-row-actions">
            <button className="remote-btn" disabled={locked || !canAct} onClick={() => void test()}>测试连接</button>
            <button
              className="remote-btn remote-btn-primary"
              disabled={locked || !canAct}
              title="在这台机器上装 kiro-cli / claude code / codex / node / rsync / git，以及 kiro-cli 默认 agent 的 web search MCP（幂等，已装的跳过）"
              onClick={() => void bootstrap()}
            >{installing ? '安装中…' : '安装依赖'}</button>
            <button className="remote-btn remote-btn-primary" disabled={locked || !canAct} onClick={() => void save()}>保存</button>
            {draft.id && <button className="remote-btn" disabled={locked} onClick={() => void remove()}>删除</button>}
          </div>
        </div>
      )}

      {busy && <p className="settings-hint">正在连…（最多等 30 秒）</p>}
      {installing && (
        <p className="settings-hint">
          正在 {draft?.sshHost} 上装依赖…（kiro-cli 的包有几百 MB，npm 还要装几个，几分钟是正常的）
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
