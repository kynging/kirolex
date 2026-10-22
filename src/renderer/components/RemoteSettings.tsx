import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_WORKDIR, LOCAL, connectionKey, defaultPick, joinSshHost, splitSshHost } from '../remotePick.ts';
import { notifyRemoteTargetsChanged } from '../hooks/useRemoteTargets.ts';
import { useT } from '../hooks/useLang';

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
 * 「测试连接」和「安装 AI 工具」也在这里：远端的毛病在别处看不出来，而且各有各的下一步 ——
 * 连不上（网络/密钥/安全组）、缺 rsync/git（一键装）、没登录（去那台机器 `kiro-cli login`）。
 * 最后一种最坑：执行器起得来、但每一轮都空回，看起来就像服务端在返空响应。
 */
/** 检测到 / 记住的一个候选启动命令。 */
export interface BinCandidate {
  command: string;
  version?: string;
  ok: boolean;
  error?: string;
  /** 以前真的起过一条会话（历史里有）。 */
  known?: boolean;
}

export interface ExecBins {
  kiro?: string;
  claude?: string;
  codex?: string;
}

export interface RemoteRow {
  id: string;
  label: string;
  sshHost: string;
  sshPort?: number;
  identityFile?: string;
  /** 跳板机（`user@host` 或 `user@host:port`）。目标在私有子网时填。 */
  proxyJump?: string;
  remoteWorkdir?: string;
  /** 这台机器上三个 CLI 的启动命令（空 = 默认）。 */
  bins?: ExecBins;
  /** 最后一次存它的时间（ms）；老配置里没有。 */
  editedAt?: number;
  /** 这台机器存了密码没有（密码本身永远不到界面这一层）。 */
  hasPassword?: boolean;
}


/** `password` 是**这一次编辑里**刚输入的明文（只在内存里，存的时候主进程加密）；`clearPassword` = 要清掉已存的。 */
type Draft = Partial<RemoteRow> & { sshHost: string; password?: string; clearPassword?: boolean };

const NEW = '__new__';
/**
 * **本机也是一台"机器"** ——「不管是本地还是远程必须要配置 kiro、claude、codex 的启动命令」。
 *
 * 它在同一个下拉里（不是单独开一块）：这三个字段问的是同一个问题 ——"这台机器上那几个 CLI
 * 在哪、叫什么"。本机没有 IP 地址/端口/密钥/工作目录，所以只显示那三个启动命令。
 */
/* 工作目录直接填上默认值 ——「工作目录不是让你填成默认 ~/kirolex 之类的吗」：是真值，不是灰字示例 */
const EMPTY: Draft = { sshHost: '', label: '', sshPort: 22, identityFile: '', proxyJump: '', remoteWorkdir: DEFAULT_WORKDIR };

/**
 * 一行「标签 + 输入框」。
 *
 * **标签必须常驻** ——「那个远程界面的三个 input 没有名字，根本不知道啥是啥」：
 * 只靠 placeholder 的话，一打字提示就消失了，回头再看这几个框就全是裸字符串
 * （`ec2-user@1.2.3.4` 和 `/home/ec2-user/kirolex-mirror` 谁是谁全靠猜）。
 * 输入框不放示例 placeholder ——「不要加示例」：灰字示例扫一眼分不出"没填"和"填的就是这个"，
 * 空输入框本身就说明"没填"。标签回答"这是什么"，hint 回答"怎么填"。
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

/**
 * 三个 CLI 的启动命令。本机和每台远端机器**用同一组字段** —— 问的是同一个问题。
 *
 * `claude` / `codex` 现在只存不用（KiroLex 还只起 kiro-cli），所以标签上明说"暂未使用"：
 * 一个填了却不生效的输入框，比没有这个输入框更让人怀疑配置是假的。
 */
/** 一个工具：输入框 + 检测到/记住的候选 + 「测试」。 */
/*
  每一行**不带「测试」按钮** ——「启动命令右侧就不要那几个测试按钮了吧」。能不能跑由
  「自动检测」给出（下面每个候选都带 ✓/✗ 和版本），远端还有「测试连接」；单测一行是重复的。
*/
const BinRow: React.FC<{
  label: string;
  hint: string;
  value: string;
  candidates?: BinCandidate[];
  onChange: (v: string) => void;
}> = ({ label, hint, value, candidates, onChange }) => {
  const t = useT();
  return (
    <Field label={label} hint={hint}>
      <div className="bin-row">
        <input
          className="settings-input"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {/*
        检测到的 + **记住的**（`known`）。历史排在前面 —— 一个真的起过会话的命令比"文件在这儿"
        可信得多。历史里那条现在跑不起来也要显示：不显示你会以为它从没存在过，
        而"它昨天还好好的"本身就是线索。
      */}
      {!!candidates?.length && (
        <div className="bin-candidates">
          {candidates.map((c) => (
            <button
              key={c.command}
              className={`bin-candidate${c.ok ? '' : ' bad'}${value === c.command ? ' active' : ''}`}
              title={c.ok ? (c.version || t('Starts')) : (c.error || t('Does not start'))}
              onClick={() => onChange(c.command)}
            >
              {c.ok ? '✓' : '✗'} {c.known ? '★ ' : ''}{c.command}
              {c.version ? <span className="bin-ver">{c.version}</span> : null}
            </button>
          ))}
        </div>
      )}
    </Field>
  );
};

/**
 * 三个 CLI 的启动命令。本机和每台远端机器**用同一组字段** —— 问的是同一个问题。
 *
 * 「自动检测」把三个工具在这台机器上的候选一次问清（同一段脚本，本机 `bash -lc`、
 * 远端走 ssh），每条都真的 `--version` 跑一遍 —— **找到文件 ≠ 能跑**。
 * `★` = 以前真的起过一条会话（历史）。
 *
 * `claude` / `codex` 这两格**只检测和记录那个 CLI**：Claude Code / Codex 会话起的是它们的 ACP 适配器
 * （本机按 npm 全局包或 `KIROLEX_<引擎>_ACP` 找，见 `engines.ts` 的 `resolveAdapter`；远端按「安装 AI 工具」装的适配器探测，
 * 见 `remoteAdapterProbe.ts`），不读这两格。标签上把这件事说清 —— 一个填了却不生效、又不说明的输入框，比没有更让人怀疑配置是假的。
 */

const BinFields: React.FC<{ bins: ExecBins; machine: string; onChange: (b: ExecBins) => void }> = ({ bins, machine, onChange }) => {
  const t = useT();
  const [found, setFound] = useState<Record<string, BinCandidate[]> | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [err, setErr] = useState('');
  /* 换机器就把上一台的结果丢掉 —— 拿 A 机器的候选去填 B 机器是最糟的一种"帮忙" */
  useEffect(() => { setFound(null); setErr(''); }, [machine]);
  const detect = async (): Promise<void> => {
    setDetecting(true);
    setErr('');
    const r = await (window as any).kiroApi?.binsDetect?.(machine);
    setDetecting(false);
    if (!r?.ok) { setErr(r?.error || t('Detection failed')); return; }
    setFound(r.tools || {});
    /* **不自动改你的配置**：只有那一栏是空的（= 用默认）时才替你填上第一个能跑的 ——
       已经填了东西就不动，那是你的选择。 */
    const pick = (t: 'kiro' | 'claude' | 'codex'): string | undefined =>
      (r.tools?.[t] || []).find((c: BinCandidate) => c.ok)?.command;
    const next: ExecBins = { ...bins };
    let changed = false;
    for (const t of ['kiro', 'claude', 'codex'] as const) {
      if (!next[t]) { const p = pick(t); if (p) { next[t] = p; changed = true; } }
    }
    if (changed) onChange(next);
  };
  return (
    <>
      {/* 没有「更新 kiro-cli」那颗按钮了 ——「本机不要更新本机的 kiro-cli 这个破按钮」；
          远端是上面「安装 AI 工具」那颗按钮的事。 */}
      <div className="remote-row-actions" style={{ marginTop: 2 }}>
        <button className="remote-btn" disabled={detecting} onClick={() => void detect()}>
          {detecting ? t('Detecting…') : t('Auto-detect the three tools on this machine')}
        </button>
        {err && <span className="settings-hint" style={{ color: 'var(--error)' }}>{err}</span>}
      </div>
      <BinRow
        label={t('kiro launch command')} hint={t('Empty = use kiro-cli from PATH. You can enter an absolute path or a different name')}
        value={bins.kiro || ''}
        candidates={found?.kiro} onChange={(kiro) => onChange({ ...bins, kiro })}
      />
      <BinRow
        label={t('claude CLI (for reference; sessions do not use this field)')} hint={t('{engine} sessions are started through its ACP adapter ({adapter}), not this command: on this machine KiroLex finds the npm global package (or {env}); on a remote machine it uses the adapter that "Install AI tools" sets up. This field only records which CLI was detected here.', { engine: 'Claude Code', adapter: 'claude-agent-acp', env: 'KIROLEX_CLAUDE_ACP' })}
        value={bins.claude || ''}
        candidates={found?.claude} onChange={(claude) => onChange({ ...bins, claude })}
      />
      <BinRow
        label={t('codex CLI (for reference; sessions do not use this field)')} hint={t('{engine} sessions are started through its ACP adapter ({adapter}), not this command: on this machine KiroLex finds the npm global package (or {env}); on a remote machine it uses the adapter that "Install AI tools" sets up. This field only records which CLI was detected here.', { engine: 'Codex', adapter: 'codex-acp', env: 'KIROLEX_CODEX_ACP' })}
        value={bins.codex || ''}
        candidates={found?.codex} onChange={(codex) => onChange({ ...bins, codex })}
      />
    </>
  );
};

/** `startNew`：打开时直接停在「+ 添加一台机器…」、给一张空表（侧栏右键「运行位置 → ＋ 添加机器…」）。 */
export const RemoteSettings: React.FC<{ startNew?: boolean }> = ({ startNew }) => {
  const t = useT();
  const [rows, setRows] = useState<RemoteRow[]>([]);
  /** 本机那三个启动命令（和远端同样的字段，只是没有 SSH 那几项）。 */
  const [local, setLocal] = useState<ExecBins>({});
  const savedLocalSig = useRef('');
  /** 本机工作目录（写法原样，默认 `~/kirolex`）。 */
  const [localWorkdir, setLocalWorkdir] = useState('');
  const savedLocalWorkdir = useRef('');
  /** 选中的机器 id；`__new__` = 正在加一台；空 = 一台都没有。 */
  const [picked, setPicked] = useState('');
  /** 选中的是"本机"那一项 —— 只显示三个启动命令（没有 IP 地址/密钥/工作目录）。 */
  const localOnly = picked === LOCAL;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  /** 最近一次「测试连接」**通过**时的连接参数（`connectionKey`）；没测过或没通过 = 空。 */
  const [testedOk, setTestedOk] = useState('');
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
    ? JSON.stringify([d.id || '', d.label || '', d.sshHost || '', d.sshPort ?? 22, d.identityFile || '', d.proxyJump || '', d.remoteWorkdir || '',
      d.bins?.kiro || '', d.bins?.claude || '', d.bins?.codex || '', d.password || '', !!d.clearPassword])
    : '');

  const reload = async (keep?: string): Promise<void> => {
    const r = await (window as any).kiroApi?.remoteTargets?.();
    const list: RemoteRow[] = Array.isArray(r?.targets) ? r.targets : [];
    setRows(list);
    const lb: ExecBins = { ...(r?.localBins || {}) };
    setLocal(lb);
    savedLocalSig.current = JSON.stringify([lb.kiro || '', lb.claude || '', lb.codex || '']);
    const wd = String(r?.localWorkdir || DEFAULT_WORKDIR);
    setLocalWorkdir(wd);
    savedLocalWorkdir.current = wd;
    /* 默认：最近编辑的那台；一台都没有就是本机（见 defaultPick）。`NEW` = 直接进入添加新机器 */
    const next = keep === NEW || (keep && list.some((x) => x.id === keep)) ? keep : defaultPick(list);
    setPicked(next);
    if (next === LOCAL) { setDraft(null); savedSig.current = ''; return; }
    if (next === NEW) { setDraft({ ...EMPTY }); savedSig.current = sig({ ...EMPTY }); return; }
    const row = list.find((x) => x.id === next);
    const d = { ...EMPTY, ...row, remoteWorkdir: row?.remoteWorkdir || DEFAULT_WORKDIR };
    setDraft(d);
    savedSig.current = sig(d);   // 打开设置不该写盘
  };

  useEffect(() => { void reload(startNew ? NEW : undefined); }, []);

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
    if (!draft || !splitSshHost(draft.sshHost).host.trim()) return;
    const mine = sig(draft);
    if (mine === savedSig.current) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      const r = await (window as any).kiroApi?.remoteSave?.(draft);
      setSaving(false);
      if (!r?.ok) { setResult({ ok: false, text: r?.error || t('Save failed') }); return; }
      setResult(null);
      notifyRemoteTargetsChanged();   // 新建对话里的机器下拉就地刷新
      const saved = r.target as RemoteRow;
      /* 「清除密码」做完了就不再是一个待办；`hasPassword` 以主进程存下来的为准 */
      savedSig.current = sig({ ...draft, id: saved.id, clearPassword: false });
      /* 就地更新列表，**不走 reload()** —— reload 会重置 draft/picked，正在打字时会把光标和内容打断 */
      setRows((prev) => (prev.some((x) => x.id === saved.id)
        ? prev.map((x) => (x.id === saved.id ? saved : x))
        : [...prev, saved]));
      /* 新建那条落地了：认领这个 id，之后的编辑是"改它"而不是"再插一条" */
      setDraft((d) => (d ? { ...d, id: saved.id, clearPassword: false, hasPassword: saved.hasPassword } : d));
      if (!draft.id) setPicked(saved.id);
    }, 600);
    return () => clearTimeout(timer);
  }, [draft]);

  /* 本机工作目录也自动保存（同一套规则：防抖 + 和存过的比） */
  useEffect(() => {
    if (!localWorkdir.trim() || localWorkdir === savedLocalWorkdir.current) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      const r = await (window as any).kiroApi?.localSaveWorkdir?.(localWorkdir);
      setSaving(false);
      if (!r?.ok) { setResult({ ok: false, text: r?.error || t('Save failed') }); return; }
      setResult(null);
      savedLocalWorkdir.current = localWorkdir;
    }, 600);
    return () => clearTimeout(timer);
  }, [localWorkdir]);

  /* 本机那三个命令也自动保存（和远端同一套规则：防抖 + 签名比对） */
  useEffect(() => {
    const mine = JSON.stringify([local.kiro || '', local.claude || '', local.codex || '']);
    if (mine === savedLocalSig.current) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      const r = await (window as any).kiroApi?.localSaveBins?.(local);
      setSaving(false);
      if (!r?.ok) { setResult({ ok: false, text: r?.error || t('Save failed') }); return; }
      setResult(null);
      savedLocalSig.current = mine;
    }, 600);
    return () => clearTimeout(timer);
  }, [local]);

  const pick = (id: string): void => {
    setResult(null);
    setTestedOk('');
    setPicked(id);
    if (id === LOCAL) { setDraft(null); return; }
    const row = id === NEW ? undefined : rows.find((x) => x.id === id);
    const d = row ? { ...EMPTY, ...row, remoteWorkdir: row.remoteWorkdir || DEFAULT_WORKDIR } : { ...EMPTY };
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
    notifyRemoteTargetsChanged();
    if (!r?.ok) setResult({ ok: false, text: r?.error || t('Delete failed') });
    await reload();
  };

  const test = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setResult(null);
    const tested = connectionKey(draft);
    const r = await (window as any).kiroApi?.remoteTest?.(draft);
    setBusy(false);
    setTestedOk(r?.ok ? tested : '');
    setResult({ ok: !!r?.ok, text: r?.message || t('Test failed') });
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
    if (!r?.ok) {
      setInstalling(false);
      setResult({ ok: false, text: r?.error || t('Install failed') });
      return;
    }
    /* 安装脚本对已装的工具是跳过的，所以 kiro-cli 的**更新**在这里补上 —— 原来那颗
       「更新那台机器的 kiro-cli」并进了这颗按钮。有会话在用就不换二进制，只说一声。 */
    const u = draft.id ? await (window as any).kiroApi?.kiroUpdate?.(draft.id, false) : null;
    setInstalling(false);
    const kiro = !u ? ''
      : u.needsConfirm ? t('kiro-cli not updated: {error}', { error: u.error })
        : !u.ok ? t('kiro-cli update failed: {error}', { error: u.error || '?' })
          : u.changed ? t('kiro-cli updated: {from} → {to}.', { from: u.from, to: u.to }) : t('kiro-cli is already up to date ({version}).', { version: u.to || u.from || '?' });
    setResult({ ok: true, text: `${t('Installed. The self-check output is above.')}${kiro ? `\n${kiro}` : ''}` });
  };

  const locked = busy || installing;
  const canAct = !!draft && !!splitSshHost(draft.sshHost).host.trim();
  /* 「安装 AI 工具」要求这组连接参数**测过且通过** —— 改了任何一项就得重测 */
  const connVerified = !!draft && testedOk === connectionKey(draft);

  return (
    <div className="settings-item settings-item-wide">
      {/*
        标题不再叫「远端机器（远程会话）」——「这个标题不应该叫远端机器（远程会话）了」。
        这一页现在管的是**所有**机器（含本机）以及每台机器上那几个 CLI 怎么起，
        而"远程会话"只是其中一个用途。下面那句说明同样改了：镜像已经没有了
        （见 `registerRemoteSync`），文件留在你机器上、远端那条会话靠 `local_*` 工具回来读写。
      */}
      <label className="settings-label">{t('Machines & launch commands')}</label>
      <p className="settings-hint" style={{ marginTop: 0 }}>
        {t('Which command launches kiro / claude / codex on each machine. They can be auto-detected and tested one by one.')}
        {t(' Once a remote machine is set up, ')}<b>{t('New chat')}</b>{t(' or right-click → "Run on" lets a session run on that machine. ')}
        <b>{t('Files are not copied over')}</b>{t(': it reads and writes through a reverse tunnel back to the tools on your machine.')}
      </p>
      <select
        className="settings-select"
        value={picked}
        onChange={(e) => pick(e.target.value)}
        style={{ marginBottom: 8, width: '100%' }}
      >
        <option value={LOCAL}>{t('💻 Local (this computer)')}</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>{`🌐 ${r.label} — ${r.sshHost}`}</option>
        ))}
        <option value={NEW}>{t('+ Add a machine…')}</option>
      </select>

      {/*
        **本机那一项** ——「不管是本地还是远程必须要配置 kiro、claude、codex 的启动命令，
        是默认 kiro 还是某个路径下的」。三个字段问的是同一个问题（这台机器上那几个 CLI 在哪），
        所以和远端机器共用一个下拉，只是本机没有 IP 地址/端口/密钥（工作目录有：没归项目的本地会话在那里干活）。
      */}
      {localOnly && (
        <div className="remote-form">
          <p className="settings-hint" style={{ marginTop: 0 }}>
            {t('Empty = look in the usual install locations. An absolute path or a different name both work. This machine may have two kiro-cli installs, and which one runs decides the model list, agents and MCP behavior.')}
            {' '}<b>★</b>{t(' = has actually started a session before; ')}<b>✗</b>{t(' = found but does not start (or is not this tool).')}
          </p>
          {/* 「本机应该有工作目录这个功能，默认是用户目录下的 kirolex」—— 没归项目的本地会话在这里干活 */}
          <Field label={t('Working directory')} hint={t('Local sessions without a project work in this directory (sessions in a project use the project directory). ~ is your home directory')}>
            <input
              className="settings-input"
              spellCheck={false}
              value={localWorkdir}
              onChange={(e) => setLocalWorkdir(e.target.value)}
            />
          </Field>
          <BinFields bins={local} machine="local" onChange={setLocal} />
        </div>
      )}

      {!localOnly && draft && (
        <div className="remote-form">
          <Field label={t('Name')} hint={t('Shown on the sidebar badge and in the New chat dropdown')}>
            <input
              className="settings-input"
              value={draft.label || ''}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </Field>
          <Field label={t('IP address')} hint={t('IP or hostname of that machine')}>
            <input
              className="settings-input"
              value={splitSshHost(draft.sshHost).host}
              onChange={(e) => setDraft({ ...draft, sshHost: joinSshHost(splitSshHost(draft.sshHost).user, e.target.value) })}
            />
          </Field>
          <Field label={t('Username')} hint={t('Username for ssh login to that machine. Empty = use your local username')}>
            <input
              className="settings-input"
              value={splitSshHost(draft.sshHost).user}
              onChange={(e) => setDraft({ ...draft, sshHost: joinSshHost(e.target.value, splitSshHost(draft.sshHost).host) })}
            />
          </Field>
          <Field label={t('Port')} hint={t('Defaults to 22')}>
            <input
              className="settings-input"
              value={draft.sshPort === undefined ? '' : String(draft.sshPort)}
              onChange={(e) => setDraft({ ...draft, sshPort: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </Field>
          {/* 密钥用 Finder 选 —— 手写路径错一个字母，表现是"认证失败"，跟机器没开长得一样 */}
          {/* 密码可以不填 ——「除了用户名应该还有密码，不过密码可以是空的」。存的是加密后的，界面只知道"有没有" */}
          <Field label={t('Password')} hint={t('Fill in either the password or the private key; leave both empty to use your own ssh config. Stored encrypted')}>
            <div className="remote-key">
              <input
                className="settings-input"
                type="password"
                autoComplete="new-password"
                value={draft.password || ''}
                onChange={(e) => setDraft({ ...draft, password: e.target.value, clearPassword: false })}
              />
              {draft.hasPassword && !draft.password && !draft.clearPassword && (
                <>
                  <span className="settings-hint">{t('Saved')}</span>
                  <button className="remote-btn" disabled={locked} onClick={() => setDraft({ ...draft, password: '', clearPassword: true })}>{t('Clear')}</button>
                </>
              )}
            </div>
          </Field>
          <Field label={t('Private key')} hint={t('Fill in either the private key or the password; leave both empty to use your own ssh config (~/.ssh/config, ssh-agent)')}>
          <div className="remote-key">
            <span className={`remote-key-path${draft.identityFile ? '' : ' empty'}`} title={draft.identityFile || ''}>
              🔑 {draft.identityFile || t('No private key selected (use it or a password; with neither, your own ssh config is used)')}
            </span>
            <button className="remote-btn" disabled={locked} onClick={() => void pickKey()}>{t('Choose key…')}</button>
            {draft.identityFile && (
              <button className="remote-btn" disabled={locked} onClick={() => setDraft({ ...draft, identityFile: '' })}>{t('Clear')}</button>
            )}
          </div>
          </Field>
          <Field label={t('Working directory')} hint={t('A directory on that machine; ~ is the login user\'s home. KiroLex creates a scratch directory for each session here')}>
            <input
              className="settings-input"
              value={draft.remoteWorkdir || ''}
              onChange={(e) => setDraft({ ...draft, remoteWorkdir: e.target.value })}
            />
          </Field>
          {/*
            **机器级的动作排在工具之前** ——「测试连接那几个按钮应该在上面，连接能行才能测试工具」。

            顺序就是依赖顺序：连不上的话"检测/测试那三个工具"根本无从谈起（它们都要走这条 ssh）。
            按这个顺序排，失败也会按这个顺序暴露 —— 你先看到"连不上"，而不是先看到三个都 ✗
            然后去怀疑是不是路径写错了。
          */}
          <div className="remote-row-actions">
            <button className="remote-btn" disabled={locked || !canAct} onClick={() => void test()}>{t('Test connection')}</button>
            <button
              className="remote-btn remote-btn-primary"
              disabled={locked || !canAct || !connVerified}
              title={connVerified
                ? t('Install kiro-cli / claude code / codex on this machine, plus the node / rsync / git they need and the web search MCP for the kiro-cli default agent (idempotent; already installed ones are skipped)')
                : t('Run "Test connection" first. Installing needs a passing test, since nothing can be installed on a machine you cannot reach')}
              onClick={() => void bootstrap()}
            >{installing ? t('Installing…') : t('Install AI tools')}</button>
            {draft.id && <button className="remote-btn" disabled={locked} onClick={() => void remove()}>{t('Delete')}</button>}
          </div>
          {/* 这台远端机器上那三个 CLI 怎么起（空 = 用 PATH 上的那个） */}
          <BinFields bins={draft.bins || {}} machine={draft.id || ''} onChange={(bins) => setDraft({ ...draft, bins })} />
        </div>
      )}

      {/* 没有保存按钮，所以要有一句"存了没"—— 否则人不知道改动算不算数 */}
      {(localOnly || draft?.sshHost.trim()) && (
        <p className="settings-hint">{saving ? t('Saving…') : t('Changes are saved automatically')}</p>
      )}
      {busy && <p className="settings-hint">{t('Connecting… (up to 30 seconds)')}</p>}
      {installing && (
        <p className="settings-hint">
          {t('Installing AI tools on {host}… (the kiro-cli package is several hundred MB and npm installs a few more, so a few minutes is normal)', { host: draft?.sshHost || '' })}
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
