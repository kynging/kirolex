/**
 * **☁️ 备份** ——「加一个定时向 S3 同步的功能，然后用户可以选择哪个会话恢复回本地，S3 认证用 AKSK」。
 *
 * 这一页只做三件事：填配置、看上一次同步结果、从桶里挑一条会话恢复回来。
 *
 * ## secret 只往一个方向走
 *
 * 主进程从不回传明文（`getS3Config` 只给 `hasSecret: boolean`），所以那个输入框**平时是空的**，
 * 空的含义是「不改」而不是「清空」—— 想清掉有单独的按钮。回传明文只是为了让输入框显示成
 * `••••••`，而代价是密钥多走一趟渲染进程、devtools 和任何一次 console.log。
 *
 * ## 「测连通」是真的写一个对象
 *
 * `s3:ListBucket` 和 `s3:PutObject` 是两条独立权限。只列成功就说"配好了"，人会在第一次
 * 定时同步时才发现写不进去 —— 而那时他已经以为备份在跑了。
 */

import React, { useCallback, useEffect, useState } from 'react';

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

export const S3BackupSettings: React.FC = () => {
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
    return () => { try { off?.(); } catch {} };
  }, [load]);

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
      ? `本地已经有「${b.title}」这条会话，恢复会**覆盖**它。\n（覆盖前那份会被挪到 ~/.kirolex/trash/，不会真的丢。）\n\n继续？`
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

  if (!cfg) return <div className="settings-col"><div className="settings-hint">读配置…</div></div>;

  return (
    <div className="settings-col">
      {!cfg.encryptionAvailable && (
        <div className="settings-item settings-warn">
          这台机器上没有可用的加密存储（keychain / keyring）—— 所以**不能**保存 Secret Access Key。
          明文写进配置文件不是一个选项。
        </div>
      )}

      <div className="settings-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <label className="settings-label">S3（认证用 AKSK）</label>
        <div className="settings-hint">
          备份的是**会话本体**（record / transcript / history）、**记忆层**、以及**附件和粘贴的图片**。
          不含 `config.json`（里面是这台机器的路径和远端主机），也不含日志和预览这些本地产物。
        </div>

        <div className="settings-control">
          <span className="settings-value" style={{ width: 96 }}>Bucket</span>
          <input className="settings-input" value={cfg.bucket} placeholder="my-kirolex-backup"
                 onChange={(e) => patch({ bucket: e.target.value })} onBlur={() => void save()} />
        </div>
        <div className="settings-control">
          <span className="settings-value" style={{ width: 96 }}>Region</span>
          <input className="settings-input" value={cfg.region} placeholder="ap-northeast-1"
                 onChange={(e) => patch({ region: e.target.value })} onBlur={() => void save()} />
        </div>
        <div className="settings-control">
          <span className="settings-value" style={{ width: 96 }}>Key 前缀</span>
          <input className="settings-input" value={cfg.prefix} placeholder="kirolex（可留空）"
                 onChange={(e) => patch({ prefix: e.target.value })} onBlur={() => void save()} />
        </div>
        <div className="settings-control">
          <span className="settings-value" style={{ width: 96 }}>Access Key ID</span>
          <input className="settings-input" value={cfg.accessKeyId} placeholder="AKIA…"
                 onChange={(e) => patch({ accessKeyId: e.target.value })} onBlur={() => void save()} />
        </div>
        <div className="settings-control">
          <span className="settings-value" style={{ width: 96 }}>Secret</span>
          <input className="settings-input" type="password" value={secret}
                 placeholder={cfg.hasSecret ? '已保存（留空 = 不改）' : '填一次，之后不再显示'}
                 disabled={!cfg.encryptionAvailable}
                 onChange={(e) => setSecret(e.target.value)} onBlur={() => { if (secret.trim()) void save(); }} />
          {cfg.hasSecret && (
            <button className="settings-btn" disabled={!!busy}
                    onClick={() => void save({ clearSecret: true })} title="从配置里删掉已保存的 secret">清掉</button>
          )}
        </div>
        <div className="settings-hint">
          Secret 用系统 keychain 加密后才写进配置，界面和日志里都只出现 Access Key 的后 4 位。
          这个 key 需要对该 bucket 的 `s3:PutObject` / `s3:GetObject` / `s3:ListBucket`。
        </div>

        {/* 按钮在字段**上面**那条规矩是机器页定下的：连不通就没必要试别的。这里同理：
            先确认可读可写，再谈定时。 */}
        <div className="settings-control" style={{ gap: 8 }}>
          <button className="settings-btn" disabled={!!busy} onClick={() => void run('test')}>
            {busy === 'test' ? '测试中…' : '测连通（真写一个小对象）'}
          </button>
          <button className="settings-btn" disabled={!!busy} onClick={() => void run('sync')}>
            {busy === 'sync' ? '同步中…' : '立即同步'}
          </button>
        </div>
      </div>

      <div className="settings-item">
        <label className="settings-label">定时同步</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={cfg.enabled}
                 onChange={(e) => { patch({ enabled: e.target.checked }); void save({ enabled: e.target.checked }); }} />
          <span className="settings-value">{cfg.enabled ? '开' : '关'}</span>
        </label>
        <input className="settings-input" style={{ width: 70 }} type="number" min={5}
               value={cfg.intervalMinutes}
               onChange={(e) => patch({ intervalMinutes: Number(e.target.value) })}
               onBlur={() => void save()} />
        <span className="settings-value">分钟</span>
      </div>
      <div className="settings-hint">
        只传变化过的文件（按大小和修改时间跳过没变的）。启动 60 秒后会补一轮 ——
        退出前那一下做不了：崩溃和被强杀根本不会走退出回调，而那正是最需要补的两种情况。
      </div>

      {cfg.last && (
        <div className="settings-item">
          <label className="settings-label">上一次</label>
          <span className="settings-value">
            {when(cfg.last.at)} · 传了 {cfg.last.uploaded} 个 / {kb(cfg.last.bytes)} · 跳过 {cfg.last.skipped}
            {cfg.last.error ? ` · 失败` : ''}
          </span>
        </div>
      )}
      {cfg.last?.error && <div className="settings-item settings-warn" style={{ whiteSpace: 'pre-wrap' }}>{cfg.last.error}</div>}

      {msg && (
        <div className={`settings-item ${msg.kind === 'bad' ? 'settings-warn' : ''}`} style={{ whiteSpace: 'pre-wrap' }}>
          {msg.text}
        </div>
      )}

      <div className="settings-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <label className="settings-label">从备份恢复</label>
        <div className="settings-control">
          <button className="settings-btn" disabled={!!busy} onClick={() => void loadBackups()}>
            {busy === 'list' ? '读取中…' : '列出桶里的会话'}
          </button>
        </div>
        {backups && !backups.length && <div className="settings-hint">桶里还没有备份 —— 先点一次「立即同步」。</div>}
        {!!backups?.length && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 280, overflowY: 'auto' }}>
            {backups.map((b) => (
              <div key={b.id} className="settings-control" style={{ justifyContent: 'space-between', gap: 8 }}>
                <span className="settings-value" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={`${b.id}\n备份于 ${when(b.syncedAt)}${b.from ? `（来自 ${b.from}）` : ''}`}>
                  {b.existsLocally ? '· ' : '＋ '}{b.title || b.id}
                  <span className="settings-hint" style={{ marginLeft: 6 }}>
                    {kb(b.bytes)} · {when(b.updatedAt)}
                  </span>
                </span>
                <button className="settings-btn" disabled={!!busy} onClick={() => void restore(b)}>
                  {busy === `restore:${b.id}` ? '恢复中…' : (b.existsLocally ? '覆盖本地' : '恢复')}
                </button>
              </div>
            ))}
          </div>
        )}
        {!!backups?.length && (
          <div className="settings-hint">
            `·` = 本地已有同一条（恢复会覆盖，覆盖前那份挪进 `~/.kirolex/trash/`）；`＋` = 本地没有。
            正连着的会话不能恢复 —— 先断开它，否则内存里那份会把恢复的内容盖回去。
          </div>
        )}
      </div>
    </div>
  );
};
