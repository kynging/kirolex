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
import { intervalChoices, intervalLabel, dayChoices, ACTIVE_DEVICE_DAY_CHOICES, CLOUD_TRASH_DAY_CHOICES, OFFLOAD_DAY_CHOICES } from '../backupIntervals.ts';
import { ToggleButton } from './ToggleButton.tsx';
import { cleanupSentence } from '../backupGroups.ts';
import { useLang, useT } from '../hooks/useLang';
import { PolicyBox } from './BedrockIam.tsx';

interface Cfg {
  enabled: boolean;
  bucket: string;
  region: string;
  prefix: string;
  endpoint: string;
  intervalMinutes: number;
  accessKeyId: string;
  hasSecret: boolean;
  /** 凭证来源：AK/SK（缺省）/ ~/.aws/config 里的 profile / AWS 默认凭证链（主进程 awsProfileCreds.ts）。 */
  credentialSource: CredSource;
  awsProfile: string;
  /** 最近一次取凭证 SSO 过期了（`profile` 缺 = 默认凭证链）→ 给「打开终端登录」。 */
  ssoLogin?: { profile?: string } | null;
  encryptionAvailable: boolean;
  last?: { at: number; uploaded: number; skipped: number; bytes: number; error?: string; cloudTrashed?: number; cloudPurged?: number;
    /* 云端清理探测出开着版本控制、凭证按版本删不了：不移任何会话，这里说缺哪些 action、给最小策略 */
    cloudCleanupNotice?: { code: string; actions: string[]; why: string; policy: string } } | null;
  /** 云端自动清理（主进程 cloudTrash.ts）：开关、活跃设备天数、回收站保留天数。 */
  autoCleanCloud: boolean;
  activeDeviceDays: number;
  cloudTrashDays: number;
  /** 久未使用的会话移到云端（主进程 sessionOffload.ts）：开关（默认开）、天数（默认 30）。 */
  autoOffload: boolean;
  offloadIdleDays: number;
  /** 凭据现在用不用得了（主进程 syncCredsOrProblem）：缺字段 / 密钥解不开 → 原因；可用 → 空 */
  credsProblem?: string;
}

type CredSource = 'keys' | 'profile' | 'default';

/** 桶里每台机器的清单（`describeDevices`）。 */
/** `machine` 是设备 ID（清单的键），`name` 是显示用的主机名 —— 同名电脑是两行。 */
interface DeviceRow { machine: string; name: string; syncedAt: number; active: boolean; readable: boolean; sessions: number }

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
  const lang = useLang();
  const t = useT();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  /* 「AWS Profile」下拉的候选（~/.aws/config + ~/.aws/credentials），以及这台电脑上有没有 aws CLI */
  const [awsProfiles, setAwsProfiles] = useState<{ profiles: string[]; cliFound: boolean } | null>(null);
  /* 下拉里选了「手填…」 */
  const [manualProfile, setManualProfile] = useState(false);

  const load = useCallback(async () => {
    try { setCfg(await api()?.getS3Config?.()); } catch { /* 拿不到就留空表单 */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (cfg?.credentialSource === 'keys' || !cfg || awsProfiles) return;
    void api()?.listS3AwsProfiles?.().then((r: any) => setAwsProfiles(r || { profiles: [], cliFound: false })).catch(() => setAwsProfiles({ profiles: [], cliFound: false }));
  }, [cfg?.credentialSource, !!cfg, awsProfiles]);

  /* 参与云端清理判定的设备 / 已忽略的设备 —— 一次 GET catalog；没配好桶时拿到的是一句 error */
  const [devices, setDevices] = useState<{ devices: DeviceRow[]; unknown: string[]; thisDevice?: string; error?: string } | null>(null);
  const loadDevices = useCallback(async () => {
    try { setDevices(await api()?.s3CloudDevices?.()); } catch (e: any) { setDevices({ devices: [], unknown: [], error: String(e?.message || e) }); }
  }, []);
  useEffect(() => { void loadDevices(); }, [loadDevices]);
  useEffect(() => {
    const off = api()?.onS3SyncDone?.(() => { void load(); void loadDevices(); });
    return () => { try { off?.(); } catch { /* 已经解绑了 */ } };
  }, [load, loadDevices]);

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
        credentialSource: cfg.credentialSource,
        awsProfile: cfg.awsProfile,
        ...(secret.trim() ? { secretAccessKey: secret.trim() } : null),
        ...extra,
      });
      setSecret('');
      await load();
      void loadDevices();      // 桶 / 凭据可能刚改过：设备列表跟着重读
      setMsg({ kind: 'ok', text: t('Saved.') });
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
        const leftover = what === 'test' && /没删掉|could not be deleted/.test(String(r.message || '')) ? String(r.message) : '';
        setMsg({
          kind: 'ok',
          text: what === 'test'
            /* 实际用的是哪个身份（sts get-caller-identity 的 ARN；没有 aws CLI 就没有）—— 换了凭证来源时这是新信息 */
            ? (leftover || '✅') + (r.identity ? ` ${t('Identity: {arn}', { arn: r.identity })}` : '')
            : [t('Uploaded {uploaded} files, {skipped} unchanged.', { uploaded: r.uploaded, skipped: r.skipped }), cleanupSentence(r, lang)].filter(Boolean).join(' '),
        });
      } else setMsg({ kind: 'bad', text: String(r?.error || t('Failed')) });
      await load();
    } catch (err: any) {
      setMsg({ kind: 'bad', text: String(err?.message || err) });
    } finally { setBusy(null); }
  };

  if (!cfg) return <div className="settings-item settings-item-wide settings-hint">{t('Loading settings…')}</div>;

  return (
    <div className="settings-item settings-item-wide backup-config">
      {!cfg.encryptionAvailable && (
        <div className="settings-warn backup-note">
          {t('No encrypted storage (keychain / keyring) is available on this machine, so the Secret Access Key cannot be saved. Writing it to the config file in plain text is not an option.')}
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
        {t('Only sessions, memory and attachments are uploaded, not ')}<code>config.json</code>{t(' or logs. Restore is under the ')}<b>☁️</b>{t(' button in the sidebar.')}
      </div>

      <Field label="Bucket">
        <input className="settings-input" value={cfg.bucket}
               onChange={(e) => patch({ bucket: e.target.value })} onBlur={() => void save()} />
      </Field>
      <Field label={t('Region')}>
        <input className="settings-input" value={cfg.region}
               onChange={(e) => patch({ region: e.target.value })} onBlur={() => void save()} />
      </Field>
      {/*
        **凭证三选一** ——「云同步也要能用 AWS profile，不能只有 AK/SK」。切到 profile / 默认凭证链只是**不显示** AK/SK，
        已存的那份不删（切回来还能用）。临时凭证在主进程内存里，从不回到这一页。
      */}
      <Field
        label={t('Credentials')}
        hint={cfg.credentialSource === 'keys' ? undefined
          : cfg.credentialSource === 'default'
            ? t('Uses the AWS default credential chain: environment variables, then the default profile (SSO included). Needs s3:PutObject / GetObject / ListBucket / DeleteObject.')
            : t('SSO, assume-role and credential_process profiles are handled by the AWS CLI. Needs s3:PutObject / GetObject / ListBucket / DeleteObject.')}
      >
        <div className="remote-via">
          {([['keys', 'Access Key'], ['profile', 'AWS Profile'], ['default', t('Default credential chain')]] as Array<[CredSource, string]>).map(([v, label]) => (
            <label key={v}>
              <input type="radio" name="backup-cred-source" checked={cfg.credentialSource === v}
                     onChange={() => { patch({ credentialSource: v }); void save({ credentialSource: v }); }} /> {label}
            </label>
          ))}
        </div>
      </Field>
      {cfg.credentialSource === 'keys' && (
        <>
          <Field label="Access Key ID">
            <input className="settings-input" value={cfg.accessKeyId}
                   onChange={(e) => patch({ accessKeyId: e.target.value })} onBlur={() => void save()} />
          </Field>
          <Field
            label={t('Secret')}
            hint={t('Needs s3:PutObject / GetObject / ListBucket / DeleteObject. If the bucket has versioning on, cloud trash cleanup also needs s3:ListBucketVersions / DeleteObjectVersion (to delete each original and trash file by version, old versions included).')}
          >
            <input className="settings-input" type="password" value={secret}
                   placeholder={cfg.hasSecret ? t('Saved (leave empty to keep)') : t('Enter once; it will not be shown again')}
                   disabled={!cfg.encryptionAvailable}
                   onChange={(e) => setSecret(e.target.value)}
                   onBlur={() => { if (secret.trim()) void save(); }} />
            {cfg.hasSecret && (
              <button className="remote-btn" disabled={!!busy}
                      onClick={() => void save({ clearSecret: true })}
                      title={t('Remove the saved secret from the config')}>{t('Clear saved')}</button>
            )}
          </Field>
        </>
      )}
      {cfg.credentialSource === 'profile' && (() => {
        const list = awsProfiles?.profiles || [];
        const manual = manualProfile || (!!cfg.awsProfile && !list.includes(cfg.awsProfile));
        return (
          <Field
            label="AWS Profile"
            hint={awsProfiles && !awsProfiles.cliFound
              ? t('The AWS CLI (aws) was not found on this computer: only static keys in ~/.aws/credentials can be used. SSO / assume-role profiles need AWS CLI v2.')
              : undefined}
          >
            <select className="settings-select" aria-label="AWS Profile"
                    value={manual ? '__manual__' : cfg.awsProfile}
                    onChange={(e) => {
                      if (e.target.value === '__manual__') { setManualProfile(true); return; }
                      setManualProfile(false);
                      patch({ awsProfile: e.target.value }); void save({ awsProfile: e.target.value });
                    }}>
              {!cfg.awsProfile && !manual && <option value="">{t('Choose a profile')}</option>}
              {list.map((p) => <option key={p} value={p}>{p}</option>)}
              <option value="__manual__">{t('Type a name…')}</option>
            </select>
            {manual && (
              <input className="settings-input" value={cfg.awsProfile} spellCheck={false} aria-label={t('Profile name')}
                     placeholder={t('Profile name')}
                     onChange={(e) => patch({ awsProfile: e.target.value })} onBlur={() => void save()} />
            )}
          </Field>
        );
      })()}
      {cfg.credentialSource !== 'keys' && cfg.ssoLogin && (
        <div className="settings-warn backup-note">
          {cfg.ssoLogin.profile
            ? t('The SSO login for profile {profile} has expired.', { profile: cfg.ssoLogin.profile })
            : t('The SSO login for the default AWS credentials has expired.')}
          {' '}
          <button className="remote-btn" disabled={!!busy} onClick={() => void (async () => {
            const r = await api()?.s3AwsSsoLogin?.();
            setMsg(r?.ok
              ? { kind: 'ok', text: t('A terminal is running aws sso login. After logging in, click Test connectivity to retry.') }
              : { kind: 'bad', text: String(r?.error || t('Failed')) });
          })()}>{t('Open a terminal to log in')}</button>
        </div>
      )}
      {/* 唯一可选的那个，所以标在**标签**上而不是塞进 placeholder ——
          placeholder 一填东西就消失了，而"这栏可以不填"是一直成立的事 */}
      <Field label={t('Key prefix (optional)')}>
        <input className="settings-input" value={cfg.prefix}
               onChange={(e) => patch({ prefix: e.target.value })} onBlur={() => void save()} />
      </Field>

      {/* 先确认可读可写，再谈定时 */}
      <div className="backup-actions">
        <button className="remote-btn remote-btn-primary" disabled={!!busy} onClick={() => void run('test')}>
          {busy === 'test' ? t('Testing…') : t('Test connectivity')}
        </button>
        <button className="remote-btn" disabled={!!busy} onClick={() => void run('sync')}>
          {busy === 'sync' ? t('Syncing…') : t('Sync now')}
        </button>
      </div>

      <Field label={t('Scheduled sync')}>
        <ToggleButton
          on={cfg.enabled}
          ariaLabel={t('Scheduled sync')}
          title={cfg.enabled ? t('Scheduled sync is on. Click to turn it off') : t('Scheduled sync is off. Click to turn it on')}
          onChange={(next) => { patch({ enabled: next }); void save({ enabled: next }); }}
        />
        <select className="settings-select backup-interval"
                value={String(cfg.intervalMinutes)}
                onChange={(e) => { const m = Number(e.target.value); patch({ intervalMinutes: m }); void save({ intervalMinutes: m }); }}>
          {intervalChoices(cfg.intervalMinutes).map((m) => (
            <option key={m} value={m}>{intervalLabel(m, lang)}</option>
          ))}
        </select>
      </Field>

      {/*
        **云端自动清理** ——「所有设备上都已不存在的会话，自动移进云端回收站，保留一段时间后彻底删除」。
        判据和回收站在主进程 cloudTrash.ts；回收站本身在侧栏 ☁️ 的「云端回收站」那一页。
      */}
      <Field
        label={t('Auto-clean cloud backups')}
        hint={t('When every active device has deleted a session, its cloud backup is moved to the cloud trash at the next sync; anything uncertain is left alone.')}
      >
        <ToggleButton
          on={cfg.autoCleanCloud}
          ariaLabel={t('Auto-clean cloud backups')}
          onChange={(next) => { patch({ autoCleanCloud: next }); void save({ autoCleanCloud: next }); }}
        />
      </Field>
      <Field label={t('Active devices')} hint={t('Only devices that synced within this many days take part; older ones are ignored so a lost computer cannot block cleanup forever.')}>
        <select className="settings-select backup-interval" aria-label={t('Active devices')}
                value={String(cfg.activeDeviceDays)}
                onChange={(e) => { const n = Number(e.target.value); patch({ activeDeviceDays: n }); void save({ activeDeviceDays: n }); }}>
          {dayChoices(ACTIVE_DEVICE_DAY_CHOICES, cfg.activeDeviceDays).map((n) => (
            <option key={n} value={n}>{intervalLabel(n * 1440, lang)}</option>
          ))}
        </select>
      </Field>
      <Field label={t('Keep cloud trash for')}>
        <select className="settings-select backup-interval" aria-label={t('Keep cloud trash for')}
                value={String(cfg.cloudTrashDays)}
                onChange={(e) => { const n = Number(e.target.value); patch({ cloudTrashDays: n }); void save({ cloudTrashDays: n }); }}>
          {dayChoices(CLOUD_TRASH_DAY_CHOICES, cfg.cloudTrashDays).map((n) => (
            <option key={n} value={n}>{intervalLabel(n * 1440, lang)}</option>
          ))}
        </select>
      </Field>
      {/*
        **久未使用的会话移到云端** ——「超过 30 天不用的会话要不要直接删掉丢远程」：不是删除，确认云端那份是最新的之后
        删掉本机副本，侧栏留 ☁ 占位，点开自动下载回来（主进程 sessionOffload.ts）。备份没开 / 没配好时整个不跑，这里置灰说原因。
      */}
      {(() => {
        /* 没配好 = 缺字段，或者密钥解不开了（换过机器 / 重装）—— 以主进程说的为准 */
        const configured = !!(cfg.bucket && cfg.region && (cfg.credentialSource !== 'keys' || (cfg.accessKeyId && cfg.hasSecret))) && !cfg.credsProblem;
        const why = !configured
          ? (cfg.credsProblem ? cfg.credsProblem.split('\n')[0] : t('Set up the bucket and keys above first.'))
          : !cfg.enabled ? t('Turn on scheduled sync first.') : '';
        return (
          <Field
            label={t('Move idle sessions to the cloud')}
            hint={why || t('Automatically moves sessions you have not used for a while to the cloud: after a successful sync, sessions not used for this long are removed from this computer once their cloud copy is confirmed up to date. They stay in the sidebar with ☁ and download automatically when opened. Nothing is deleted from the cloud.')}
          >
            <span className={why ? 'backup-offload-disabled' : undefined} style={why ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
              <ToggleButton
                on={!why && cfg.autoOffload}
                disabled={!!why}
                ariaLabel={t('Move idle sessions to the cloud')}
                onChange={(next) => { patch({ autoOffload: next }); void save({ autoOffload: next, offloadIdleDays: cfg.offloadIdleDays }); }}
              />
            </span>
            <select className="settings-select backup-interval" aria-label={t('Unused for')}
                    disabled={!!why || !cfg.autoOffload}
                    value={String(cfg.offloadIdleDays)}
                    onChange={(e) => { const n = Number(e.target.value); patch({ offloadIdleDays: n }); void save({ offloadIdleDays: n }); }}>
              {dayChoices(OFFLOAD_DAY_CHOICES, cfg.offloadIdleDays).map((n) => (
                <option key={n} value={n}>{t('Unused for {n} days', { n })}</option>
              ))}
            </select>
          </Field>
        );
      })()}
      {devices && (
        <div className="backup-devices">
          {devices.error ? <div className="settings-hint">{devices.error.split('\n')[0]}</div> : (
            <>
              <div className="settings-hint">{t('Devices taking part in the decision:')}</div>
              {devices.devices.filter((d) => d.active).map((d) => (
                <div key={d.machine} className="backup-device-row">
                  <span className="backup-restore-title" title={d.machine}>{d.name || d.machine}{d.machine === devices.thisDevice ? ` ${t('(this machine)')}` : ''}</span>
                  <span className="backup-restore-meta">{t('Last synced {at}', { at: when(d.syncedAt) })}{d.readable ? ` · ${t('{n} sessions', { n: d.sessions })}` : ''}</span>
                  {!d.readable && <span className="backup-tag warn">{t('List unreadable: nothing is cleaned')}</span>}
                </div>
              ))}
              {devices.unknown.map((m) => (
                <div key={m} className="backup-device-row">
                  <span className="backup-restore-title">{m}</span>
                  <span className="backup-tag warn">{t('Synced recently but has no session list (older KiroLex?): nothing is cleaned until it updates')}</span>
                </div>
              ))}
              {!devices.devices.some((d) => d.active) && !devices.unknown.length && <div className="settings-hint">{t('None yet (each device registers at its next sync).')}</div>}
              {devices.devices.some((d) => !d.active) && (
                <>
                  <div className="settings-hint">{t('Ignored devices (no sync for more than {n} days):', { n: cfg.activeDeviceDays })}</div>
                  {devices.devices.filter((d) => !d.active).map((d) => (
                    <div key={d.machine} className="backup-device-row muted">
                      <span className="backup-restore-title" title={d.machine}>{d.name || d.machine}</span>
                      <span className="backup-restore-meta">{t('Last synced {at}', { at: when(d.syncedAt) })}</span>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}

      {cfg.last && (
        <div className="settings-value backup-note">
          {t('Last run: {at} · uploaded {n} / {size}', { at: when(cfg.last.at), n: cfg.last.uploaded, size: kb(cfg.last.bytes) })}
          {' · '}{t('skipped {n}', { n: cfg.last.skipped })}{cfg.last.error ? ` · ${t('failed')}` : ''}
          {cleanupSentence(cfg.last, lang) ? ` · ${cleanupSentence(cfg.last, lang)}` : ''}
        </div>
      )}
      {cfg.last?.error && (
        <div className="settings-warn backup-note" style={{ whiteSpace: 'pre-wrap' }}>{cfg.last.error}</div>
      )}
      {cfg.last?.cloudCleanupNotice && (
        <div className="settings-warn backup-note">
          <div>{t('Cloud cleanup is paused: the bucket has versioning on, but these credentials cannot delete by version ({code}). No sessions are moved to the cloud trash until the role also allows: {actions}', { code: cfg.last.cloudCleanupNotice.code, actions: cfg.last.cloudCleanupNotice.actions.join(' / ') })}</div>
          <div className="settings-hint" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{cfg.last.cloudCleanupNotice.why}</div>
          <div className="settings-hint">{t('Add this statement to the IAM policy used for S3 sync:')}</div>
          <PolicyBox policy={cfg.last.cloudCleanupNotice.policy} />
        </div>
      )}
      {msg && (
        <div className={`backup-note ${msg.kind === 'bad' ? 'settings-warn' : 'backup-ok'}`}
             style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
      )}
    </div>
  );
};
