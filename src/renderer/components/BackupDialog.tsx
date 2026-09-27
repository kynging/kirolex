/**
 * **☁️ 备份** —— 自己一个弹窗，不再是设置里的一个 tab。
 *
 * 「那个备份界面不应该在设置里面。而且这个界面现在是乱的」。
 *
 * ## 为什么搬出设置
 *
 * 设置里的东西是**配一次就不用再看**的（外观、开关、机器）。备份不是：它是一件**有状态、
 * 要回来看**的事 —— 上次什么时候成的、传了多少、桶里有哪些会话能恢复。侧栏那颗 ☁️ 已经在
 * 承担"状态指示"的角色（配过/没配过/上次失败三种颜色），点开就该直接是这一页，
 * 而不是"进设置 → 找那个 tab"。
 *
 * ## 那个"乱"是怎么来的
 *
 * 两个叠在一起：
 *
 * 1. **按钮用错了 class**。`.settings-btn` 是 28×28 的**图标**按钮（width/height 写死、
 *    font-size 16px）。拿它装「测连通（真写一个小对象）」的结果是按钮被压成 28px 宽、
 *    文字一个字一行竖着排下来，而且**盖在**下面那段说明文字上。
 *    这个坑机器页踩过一次，CSS 里那条注释就是为它写的（`.remote-btn` 才是文字按钮）。
 * 2. **塞在一个 341px 宽的格子里**。`.settings-body` 是两列网格，这一页却是"6 个字段 + 一张
 *    可恢复列表"—— 单列宽度根本不够，实测 `scrollHeight > clientHeight`，最下面那半截
 *    「从备份恢复」直接被切掉了。
 *
 * 所以这里不复用 `.settings-col`：自己一个够宽的弹窗，字段用 `label` 固定宽度对齐，
 * 按钮一律 `.remote-btn`（`white-space: nowrap`），列表独立滚动。
 *
 * ## secret 只往一个方向走
 *
 * 主进程从不回传明文（`getS3Config` 只给 `hasSecret: boolean`），所以那个输入框**平时是空的**,
 * 空的含义是「不改」而不是「清空」—— 想清掉有单独的按钮。回传明文只是为了让输入框显示成
 * `••••••`，而代价是密钥多走一趟渲染进程、devtools 和任何一次 console.log。
 *
 * ## 「测连通」是真的写一个对象
 *
 * `s3:ListBucket` 和 `s3:PutObject` 是两条独立权限。只列成功就说"配好了"，人会在第一次
 * 定时同步时才发现写不进去 —— 而那时他已经以为备份在跑了。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ToggleButton } from './ToggleButton.tsx';

interface Backup {
  id: string;
  title: string;
  updatedAt: number;
  bytes: number;
  from?: string;
  syncedAt: number;
  existsLocally?: boolean;
}

interface Cfg {
  enabled: boolean;
  bucket: string;
  region: string;
  prefix: string;
  endpoint: string;
  intervalMinutes: number;
  accessKeyId: string;
  hasSecret: boolean;
  encryptionAvailable: boolean;
  last?: { at: number; uploaded: number; skipped: number; bytes: number; error?: string } | null;
}

const api = (): any => (window as any).kiroApi;

const when = (ms?: number): string => (ms ? new Date(ms).toLocaleString() : '—');
const kb = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** 一行「标签 + 控件」。标签宽度固定，这样 6 个字段的输入框左边缘是齐的。 */
const Field: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({ label, children, hint }) => (
  <div className="backup-field">
    <label className="backup-field-label">{label}</label>
    <div className="backup-field-control">{children}</div>
    {hint && <div className="settings-hint backup-field-hint">{hint}</div>}
  </div>
);

export const BackupDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const [backups, setBackups] = useState<Backup[] | null>(null);

  const load = useCallback(async () => {
    try { setCfg(await api()?.getS3Config?.()); } catch { /* 拿不到就留空表单 */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const off = api()?.onS3SyncDone?.(() => { void load(); });
    return () => { try { off?.(); } catch { /* 已经解绑了 */ } };
  }, [load]);

  /* Esc 关掉 —— 和别的弹窗一致 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const patch = (next: Partial<Cfg>): void => setCfg((prev) => (prev ? { ...prev, ...next } : prev));

  /** 保存。**只把这一页管的字段发过去**，secret 只在真填了东西时才发。 */
  const save = async (extra: Record<string, unknown> = {}): Promise<void> => {
    if (!cfg) return;
    setBusy('save'); setMsg(null);
    try {
      await api()?.saveS3Config?.({
        enabled: cfg.enabled,
        bucket: cfg.bucket,
        region: cfg.region,
        prefix: cfg.prefix,
        endpoint: cfg.endpoint,
        intervalMinutes: cfg.intervalMinutes,
        accessKeyId: cfg.accessKeyId,
        ...(secret.trim() ? { secretAccessKey: secret.trim() } : null),
        ...extra,
      });
      setSecret('');
      await load();
      setMsg({ kind: 'ok', text: '已保存。' });
    } catch (err: any) {
      setMsg({ kind: 'bad', text: String(err?.message || err) });
    } finally { setBusy(null); }
  };

  const run = async (what: 'test' | 'sync'): Promise<void> => {
    setBusy(what); setMsg(null);
    try {
      const r = what === 'test' ? await api()?.testS3?.() : await api()?.syncS3Now?.();
      if (r?.ok) {
        setMsg({
          kind: 'ok',
          text: what === 'test' ? (r.message || '通了。') : `传了 ${r.uploaded} 个文件，${r.skipped} 个没变。`,
        });
      } else setMsg({ kind: 'bad', text: String(r?.error || '失败') });
      await load();
    } catch (err: any) {
      setMsg({ kind: 'bad', text: String(err?.message || err) });
    } finally { setBusy(null); }
  };

  const loadBackups = async (): Promise<void> => {
    setBusy('list'); setMsg(null);
    try {
      const r = await api()?.listS3Backups?.();
      setBackups(r?.entries || []);
      if (r?.error) setMsg({ kind: 'bad', text: String(r.error) });
    } finally { setBusy(null); }
  };

  const restore = async (b: Backup): Promise<void> => {
    /*
      **覆盖前问一句** —— 用户选的语义就是覆盖同 id，但这是不可逆的；
      主进程还会把本地那份挪进 trash，所以这里把两件事都说清。
    */
    const warn = b.existsLocally
      ? `本地已经有「${b.title}」这条会话，恢复会覆盖它。\n（覆盖前那份会被挪到 ~/.kirolex/trash/，不会真的丢。）\n\n继续？`
      : `把「${b.title}」恢复到本地？`;
    if (!window.confirm(warn)) return;
    setBusy(`restore:${b.id}`); setMsg(null);
    try {
      const r = await api()?.restoreS3Session?.(b.id);
      if (r?.ok) {
        setMsg({
          kind: 'ok',
          text: `已恢复 ${r.restored} 个文件${r.backedUp ? `，原来那份在 ${r.backedUp}` : ''}。重启 KiroLex 后它会出现在列表里。`,
        });
      } else setMsg({ kind: 'bad', text: String(r?.error || '恢复失败') });
    } finally { setBusy(null); }
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      {/*
        比设置窄、比设置矮：这一页只有一列内容（一张表单 + 一张列表），
        撑到设置那个宽度反而让每一行的字跑得很远。
      */}
      <div className="settings-dialog backup-dialog" style={{ width: 'min(620px, 94vw)', height: 'min(80vh, 780px)' }}>
        <div className="settings-header">
          <h3>☁️ 备份</h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="backup-body">
          {!cfg ? <div className="settings-hint">读配置…</div> : (
            <>
              {!cfg.encryptionAvailable && (
                <div className="settings-warn backup-note">
                  这台机器上没有可用的加密存储（keychain / keyring）—— 所以不能保存 Secret Access Key。
                  明文写进配置文件不是一个选项。
                </div>
              )}

              <section className="backup-section">
                <h4 className="backup-section-title">S3（认证用 AKSK）</h4>
                <div className="settings-hint backup-note">
                  备份的是<b>会话本体</b>（record / transcript / history）、<b>记忆层</b>、
                  以及<b>附件和粘贴的图片</b>。不含 <code>config.json</code>（里面是这台机器的路径和远端主机），
                  也不含日志和预览这些本地产物。
                </div>

                <Field label="Bucket">
                  <input className="settings-input" value={cfg.bucket} placeholder="my-kirolex-backup"
                         onChange={(e) => patch({ bucket: e.target.value })} onBlur={() => void save()} />
                </Field>
                <Field label="Region">
                  <input className="settings-input" value={cfg.region} placeholder="ap-northeast-1"
                         onChange={(e) => patch({ region: e.target.value })} onBlur={() => void save()} />
                </Field>
                <Field label="Key 前缀">
                  <input className="settings-input" value={cfg.prefix} placeholder="kirolex（可留空）"
                         onChange={(e) => patch({ prefix: e.target.value })} onBlur={() => void save()} />
                </Field>
                <Field label="Access Key ID">
                  <input className="settings-input" value={cfg.accessKeyId} placeholder="AKIA…"
                         onChange={(e) => patch({ accessKeyId: e.target.value })} onBlur={() => void save()} />
                </Field>
                <Field
                  label="Secret"
                  hint="用系统 keychain 加密后才写进配置，界面和日志里都只出现 Access Key 的后 4 位。这个 key 需要对该 bucket 的 s3:PutObject / s3:GetObject / s3:ListBucket。"
                >
                  <input className="settings-input" type="password" value={secret}
                         placeholder={cfg.hasSecret ? '已保存（留空 = 不改）' : '填一次，之后不再显示'}
                         disabled={!cfg.encryptionAvailable}
                         onChange={(e) => setSecret(e.target.value)}
                         onBlur={() => { if (secret.trim()) void save(); }} />
                  {cfg.hasSecret && (
                    <button className="remote-btn" disabled={!!busy}
                            onClick={() => void save({ clearSecret: true })}
                            title="从配置里删掉已保存的 secret">清掉</button>
                  )}
                </Field>

                {/* 按钮在字段**下面**：先填完再验，而"验"包含真写一个对象 */}
                <div className="backup-actions">
                  <button className="remote-btn remote-btn-primary" disabled={!!busy} onClick={() => void run('test')}>
                    {busy === 'test' ? '测试中…' : '测连通（真写一个小对象）'}
                  </button>
                  <button className="remote-btn" disabled={!!busy} onClick={() => void run('sync')}>
                    {busy === 'sync' ? '同步中…' : '立即同步'}
                  </button>
                </div>
              </section>

              <section className="backup-section">
                <h4 className="backup-section-title">定时同步</h4>
                <div className="backup-actions">
                  <ToggleButton
                    on={cfg.enabled}
                    ariaLabel="定时同步"
                    title={cfg.enabled ? '定时同步开着 —— 点一下关掉' : '定时同步关着 —— 点一下打开'}
                    onChange={(next) => { patch({ enabled: next }); void save({ enabled: next }); }}
                  />
                  <input className="settings-input backup-interval" type="number" min={5}
                         value={cfg.intervalMinutes}
                         onChange={(e) => patch({ intervalMinutes: Number(e.target.value) })}
                         onBlur={() => void save()} />
                  <span className="settings-value">分钟</span>
                </div>
                <div className="settings-hint backup-note">
                  只传变化过的文件（按大小和修改时间跳过没变的）。启动 60 秒后会补一轮 ——
                  退出前那一下做不了：崩溃和被强杀根本不会走退出回调，而那正是最需要补的两种情况。
                </div>
                {cfg.last && (
                  <div className="settings-value backup-note">
                    上一次：{when(cfg.last.at)} · 传了 {cfg.last.uploaded} 个 / {kb(cfg.last.bytes)}
                    {' · '}跳过 {cfg.last.skipped}{cfg.last.error ? ' · 失败' : ''}
                  </div>
                )}
                {cfg.last?.error && (
                  <div className="settings-warn backup-note" style={{ whiteSpace: 'pre-wrap' }}>{cfg.last.error}</div>
                )}
              </section>

              {msg && (
                <div className={`backup-note ${msg.kind === 'bad' ? 'settings-warn' : 'settings-hint'}`}
                     style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
              )}

              <section className="backup-section">
                <h4 className="backup-section-title">从备份恢复</h4>
                <div className="backup-actions">
                  <button className="remote-btn" disabled={!!busy} onClick={() => void loadBackups()}>
                    {busy === 'list' ? '读取中…' : '列出桶里的会话'}
                  </button>
                </div>
                {backups && !backups.length && (
                  <div className="settings-hint backup-note">桶里还没有备份 —— 先点一次「立即同步」。</div>
                )}
                {!!backups?.length && (
                  <div className="backup-list">
                    {backups.map((b) => (
                      <div key={b.id} className="backup-list-row">
                        <span className="backup-list-name"
                              title={`${b.id}\n备份于 ${when(b.syncedAt)}${b.from ? `（来自 ${b.from}）` : ''}`}>
                          {b.existsLocally ? '· ' : '＋ '}{b.title || b.id}
                          <span className="settings-hint" style={{ marginLeft: 6 }}>
                            {kb(b.bytes)} · {when(b.updatedAt)}
                          </span>
                        </span>
                        <button className="remote-btn" disabled={!!busy} onClick={() => void restore(b)}>
                          {busy === `restore:${b.id}` ? '恢复中…' : (b.existsLocally ? '覆盖本地' : '恢复')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {!!backups?.length && (
                  <div className="settings-hint backup-note">
                    <code>·</code> = 本地已有同一条（恢复会覆盖，覆盖前那份挪进 <code>~/.kirolex/trash/</code>）；
                    <code>＋</code> = 本地没有。正连着的会话不能恢复 —— 先断开它，否则内存里那份会把恢复的内容盖回去。
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
};
