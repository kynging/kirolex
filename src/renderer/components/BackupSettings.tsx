/**
 * **☁️ 备份的配置** —— 设置里的一个 tab。
 *
 * 「这个备份的配置放回设置中。我的意思是这个云按钮只保留恢复」。
 *
 * 所以这一页只管**配**：桶、区域、凭据、定时。"桶里有哪些会话、要恢复哪几条"在侧栏那颗 ☁️
 * 里（`BackupDialog`）—— 那是一件**平时要回来看**的事，而配置是配一次就不用再看的。
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
 *
 * 写完会把那个对象**删掉**（「测试应该是写完然后删除」），所以按钮上不必再写"真写一个小对象"——
 * 它不留痕迹，那句提示只是噪音。
 *
 * ## 值字段不放示例 placeholder
 *
 * 「不要显示这些默认值」。原来 Bucket 是 `my-kirolex-backup`、Region 是 `ap-northeast-1`、
 * AK 是 `AKIA…`：它们和真值一个颜色量级，扫一眼分不出"这栏没填"和"这栏填的就是这个" ——
 * 而这几栏任何一个没填，备份就是不工作的。空输入框本身就说明"没填"。
 *
 * 顺序也是要求的：必填的挨在一起（Bucket → Region → AK → Secret），
 * 唯一可选的 Key 前缀放最后 ——「region 放在 ak 前面」。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { intervalChoices, intervalLabel } from '../backupIntervals.ts';
import { ToggleButton } from './ToggleButton.tsx';

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

/** 一行「标签 + 控件」。标签定宽，这样几个输入框的左边缘是齐的。 */
const Field: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({ label, children, hint }) => (
  <div className="backup-field">
    <label className="backup-field-label">{label}</label>
    <div className="backup-field-control">{children}</div>
    {hint && <div className="settings-hint backup-field-hint">{hint}</div>}
  </div>
);

export const BackupSettings: React.FC = () => {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  const load = useCallback(async () => {
    try { setCfg(await api()?.getS3Config?.()); } catch { /* 拿不到就留空表单 */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const off = api()?.onS3SyncDone?.(() => { void load(); });
    return () => { try { off?.(); } catch { /* 已经解绑了 */ } };
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

  if (!cfg) return <div className="settings-item settings-item-wide settings-hint">读配置…</div>;

  return (
    <div className="settings-item settings-item-wide backup-config">
      {!cfg.encryptionAvailable && (
        <div className="settings-warn backup-note">
          这台机器上没有可用的加密存储（keychain / keyring）—— 所以不能保存 Secret Access Key。
          明文写进配置文件不是一个选项。
        </div>
      )}

      <div className="settings-hint backup-note">
        备份的是<b>会话本体</b>（record / transcript / history）、<b>记忆层</b>、
        以及<b>附件和粘贴的图片</b>。不含 <code>config.json</code>（里面是这台机器的路径和远端主机），
        也不含日志和预览这些本地产物。
        <br />
        恢复在侧栏那颗 <b>☁️</b> 里 —— 那里列的是桶里已经备份的会话。
      </div>

      <Field label="Bucket">
        <input className="settings-input" value={cfg.bucket}
               onChange={(e) => patch({ bucket: e.target.value })} onBlur={() => void save()} />
      </Field>
      <Field label="Region">
        <input className="settings-input" value={cfg.region}
               onChange={(e) => patch({ region: e.target.value })} onBlur={() => void save()} />
      </Field>
      <Field label="Access Key ID">
        <input className="settings-input" value={cfg.accessKeyId}
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
      {/* 唯一可选的那个，所以标在**标签**上而不是塞进 placeholder ——
          placeholder 一填东西就消失了，而"这栏可以不填"是一直成立的事 */}
      <Field label="Key 前缀（可选）" hint="桶里的 key 都加这个前缀；留空 = 直接放桶根。">
        <input className="settings-input" value={cfg.prefix}
               onChange={(e) => patch({ prefix: e.target.value })} onBlur={() => void save()} />
      </Field>

      {/* 先确认可读可写，再谈定时 */}
      <div className="backup-actions">
        <button className="remote-btn remote-btn-primary" disabled={!!busy} onClick={() => void run('test')}>
          {busy === 'test' ? '测试中…' : '测连通'}
        </button>
        <button className="remote-btn" disabled={!!busy} onClick={() => void run('sync')}>
          {busy === 'sync' ? '同步中…' : '立即同步'}
        </button>
      </div>

      <Field label="定时同步">
        <ToggleButton
          on={cfg.enabled}
          ariaLabel="定时同步"
          title={cfg.enabled ? '定时同步开着 —— 点一下关掉' : '定时同步关着 —— 点一下打开'}
          onChange={(next) => { patch({ enabled: next }); void save({ enabled: next }); }}
        />
        <select className="settings-select backup-interval"
                value={String(cfg.intervalMinutes)}
                onChange={(e) => { const m = Number(e.target.value); patch({ intervalMinutes: m }); void save({ intervalMinutes: m }); }}>
          {intervalChoices(cfg.intervalMinutes).map((m) => (
            <option key={m} value={m}>{intervalLabel(m)}</option>
          ))}
        </select>
      </Field>
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
      {msg && (
        <div className={`backup-note ${msg.kind === 'bad' ? 'settings-warn' : 'settings-hint'}`}
             style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
      )}
    </div>
  );
};
