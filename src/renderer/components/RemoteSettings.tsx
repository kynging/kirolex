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

/**
 * 一行「标签 + 输入框」。
 *
 * **标签必须常驻** ——「那个远程界面的三个 input 没有名字，根本不知道啥是啥」：
 * 只靠 placeholder 的话，一打字提示就消失了，回头再看这几个框就全是裸字符串
 * （`ec2-user@1.2.3.4` 和 `/home/ec2-user/kirolex-mirror` 谁是谁全靠猜）。
 * placeholder 留着当**例子**，标签回答"这是什么"。
 */
const Field: React.FC<{
  label: string;
  hint?: string;
  children: React.ReactNode;
}> = ({ label, hint, children }) => (
  <div className="remote-field">
    <label className="remote-field-label" title={hint}>{label}</label>
    <div className="remote-field-control">{children}</div>
  </div>
);

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
  /**
   * **没有保存按钮，改完自动存** ——「那个 ssh 配置中不需要保存按钮，所有变化自动保存」。
   *
   * 三件事要一起做对，否则自动保存会变成麻烦：
   *   · **防抖**：不能每敲一个字母写一次 `config.json`（那是原子写，一次一个 rename）。
   *   · **签名比对**：选中另一台机器时 `draft` 也会变，但那不是"你改了什么" —— 不比对的话
   *     打开设置就会无意义地写一遍盘。
   *   · **拿到 id 之后要认领它**：新建那条第一次存完会得到一个 id，之后的编辑必须是"改这一条"
   *     而不是"再插一条"，否则你改个名字就多出来一台机器。
   */
  const savedSig = useRef('');
  const [saving, setSaving] = useState(false);

  /** 一条目标的可比较签名（只含真正会被存下去的字段）。 */
  const sig = (d: Draft | null): string => (d
    ? JSON.stringify([d.id || '', d.label || '', d.sshHost || '', d.sshPort ?? 22, d.identityFile || '', d.remoteWorkdir || ''])
    : '');

  const reload = async (keep?: string): Promise<void> => {
    const r = await (window as any).kiroApi?.remoteTargets?.();
    const list: RemoteRow[] = Array.isArray(r?.targets) ? r.targets : [];
    setRows(list);
    setEnabled(!!r?.enabled);
    /* 默认选中第一台：打开设置就看到它的配置，而不是一个空下拉 */
    const next = keep && list.some((x) => x.id === keep) ? keep : (list[0]?.id || NEW);
    const d = next === NEW ? { ...EMPTY } : { ...EMPTY, ...list.find((x) => x.id === next) };
    setPicked(next);
    setDraft(d);
    savedSig.current = sig(d);   // 打开设置不该写盘
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

  /* 自动保存。`sshHost` 还空着的时候什么都不做 —— 那不是"一台机器"，存下去只会得到一条废配置。 */
  useEffect(() => {
    if (!draft || !draft.sshHost.trim()) return;
    const mine = sig(draft);
    if (mine === savedSig.current) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      const r = await (window as any).kiroApi?.remoteSave?.(draft);
      setSaving(false);
      if (!r?.ok) { setResult({ ok: false, text: r?.error || '保存失败' }); return; }
      setResult(null);
      const saved = r.target as RemoteRow;
      savedSig.current = sig({ ...draft, id: saved.id });
      /* 就地更新列表，**不走 reload()** —— reload 会重置 draft/picked，正在打字时会把光标和内容打断 */
      setRows((prev) => (prev.some((x) => x.id === saved.id)
        ? prev.map((x) => (x.id === saved.id ? saved : x))
        : [...prev, saved]));
      if (!draft.id) {
        /* 新建那条落地了：认领这个 id，之后的编辑是"改它"而不是"再插一条" */
        setDraft((d) => (d ? { ...d, id: saved.id } : d));
        setPicked(saved.id);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [draft]);

  const pick = (id: string): void => {
    setResult(null);
    setPicked(id);
    const d = id === NEW ? { ...EMPTY } : { ...EMPTY, ...rows.find((x) => x.id === id) };
    setDraft(d);
    savedSig.current = sig(d);   // 只是切了一台机器，不是改了什么
  };

  const pickKey = async (): Promise<void> => {
    const r = await (window as any).kiroApi?.remotePickKey?.();
    if (r?.path && draft) setDraft({ ...draft, identityFile: r.path });
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
          <Field label="名字" hint="侧栏徽标和新建对话的下拉里显示的就是这个名字">
            <input
              className="settings-input"
              placeholder="例如 aws-tokyo"
              value={draft.label || ''}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </Field>
          <Field label="SSH 地址" hint="用户名@主机，和你平时 ssh 用的一样">
            <input
              className="settings-input"
              placeholder="例如 ec2-user@1.2.3.4"
              value={draft.sshHost}
              onChange={(e) => setDraft({ ...draft, sshHost: e.target.value })}
            />
          </Field>
          <Field label="端口" hint="不填就是 22">
            <input
              className="settings-input"
              placeholder="22"
              value={draft.sshPort === undefined ? '' : String(draft.sshPort)}
              onChange={(e) => setDraft({ ...draft, sshPort: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </Field>
          {/* 密钥用 Finder 选 —— 手写路径错一个字母，表现是"认证失败"，跟机器没开长得一样 */}
          <Field label="私钥" hint="留空 = 用 ssh 自己的配置（~/.ssh/config、ssh-agent）">
          <div className="remote-key">
            <span className={`remote-key-path${draft.identityFile ? '' : ' empty'}`} title={draft.identityFile || ''}>
              🔑 {draft.identityFile || '没有选私钥（可选 —— 留空就用 ssh 自己的配置）'}
            </span>
            <button className="remote-btn" disabled={locked} onClick={() => void pickKey()}>选择密钥…</button>
            {draft.identityFile && (
              <button className="remote-btn" disabled={locked} onClick={() => setDraft({ ...draft, identityFile: '' })}>清除</button>
            )}
          </div>
          </Field>
          <Field label="远端目录" hint="项目镜像放在那台机器的哪里（每个本地项目一个子目录）">
            <input
              className="settings-input"
              placeholder="例如 /home/ec2-user/kirolex-mirror"
              value={draft.remoteWorkdir || ''}
              onChange={(e) => setDraft({ ...draft, remoteWorkdir: e.target.value })}
            />
          </Field>
          <div className="remote-row-actions">
            <button className="remote-btn" disabled={locked || !canAct} onClick={() => void test()}>测试连接</button>
            <button
              className="remote-btn remote-btn-primary"
              disabled={locked || !canAct}
              title="在这台机器上装 kiro-cli / claude code / codex / node / rsync / git，以及 kiro-cli 默认 agent 的 web search MCP（幂等，已装的跳过）"
              onClick={() => void bootstrap()}
            >{installing ? '安装中…' : '安装依赖'}</button>
            {draft.id && <button className="remote-btn" disabled={locked} onClick={() => void remove()}>删除</button>}
          </div>
        </div>
      )}

      {/* 没有保存按钮，所以要有一句"存了没"—— 否则人不知道改动算不算数 */}
      {draft?.sshHost.trim() && (
        <p className="settings-hint">{saving ? '正在保存…' : '改动自动保存'}</p>
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
