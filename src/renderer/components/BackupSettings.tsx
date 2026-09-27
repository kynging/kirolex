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
        /*
          **通了就一个 ✅** ——「测联通ok的话显示个绿色和✅就行了，不用显示什么可读可写」。
          "可读可写（桶 / 区）"那句话里没有一个字是你还不知道的：桶和区就在上面那两栏里，
          而"可读可写"正是这颗按钮的定义。成了的时候人只需要一眼看到"成了"。

          唯一例外是**测试对象没删掉**那种（`leftover`）：那时桶里真留了个东西，
          必须原样说出来 —— 那是个新信息，不是复述。
        */
        const leftover = what === 'test' && /没删掉/.test(String(r.message || '')) ? String(r.message) : '';
        setMsg({
          kind: 'ok',
          text: what === 'test'
            ? (leftover || '✅')
            : `传了 ${r.uploaded} 个文件，${r.skipped} 个没变。`,
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

      {/*
        **只留还有信息量的那两句** ——「这一页中没用的文字描述都删掉」。
        砍掉的是"备份了什么、跳过没变的文件、启动 60 秒补一轮"那一堆 —— 那些是实现说明,
        看完也不会改变你在这一页的任何一个动作。
        留下的两句各有理由：① 不上传 `config.json`（凭据会不会被传上去是个真问题）；
        ② 恢复在别的地方（否则人会在这一页找恢复）。
      */}
      <div className="settings-hint backup-note">
        只传会话、记忆层和附件，不含 <code>config.json</code> 和日志。恢复在侧栏那颗 <b>☁️</b>。
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
        hint="需要 s3:PutObject / GetObject / ListBucket / DeleteObject。"
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
      <Field label="Key 前缀（可选）">
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
        <div className={`backup-note ${msg.kind === 'bad' ? 'settings-warn' : 'backup-ok'}`}
             style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
      )}
    </div>
  );
};
