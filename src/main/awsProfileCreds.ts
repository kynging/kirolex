/**
 * **S3 云同步的凭证从哪来**：AK/SK（`keys`，原来那条路）、`~/.aws/config` 里的一个 profile（`profile`），
 * 或者 AWS 默认凭证链（`default`）。
 *
 * 「云同步也要能用 AWS profile，不能只有 AK/SK」—— 长期 AK/SK 存在本机不安全，公司账号也多半只给 SSO / assume-role。
 *
 * ## 为什么借 aws CLI，而不是自己实现 SSO / assume-role
 *
 * SSO（token 缓存、刷新）、assume-role（链式、MFA、source_profile）、credential_process 每一种都是一套协议，
 * 自己写等于重写半个 SDK。CLI v2 的 `aws configure export-credentials --format process` 把它们全折成
 * 一份 JSON（AccessKeyId / SecretAccessKey / SessionToken / Expiration），这里只管调它、缓存、把错说成人话。
 * 用 `execFile`（不经 shell），profile 名过白名单 —— 名字是用户填的，会进命令行。
 *
 * 没装 CLI 时退一步：只读 `~/.aws/credentials` 里这个 profile 的静态 key（**只读，从不写 ~/.aws**）。
 *
 * ## 凭证只在内存里
 *
 * 不写 config.json、不进日志（日志里只有 profile 名和 `maskKeyId` 那几位）。缓存到 Expiration 前 5 分钟；
 * 没有 Expiration 的缓存 1 小时。S3 回 ExpiredToken / InvalidToken / SignatureDoesNotMatch 时由 `s3Client` 调
 * `refresh` 清缓存重取一次（见 `S3Creds.refresh`）。
 *
 * 纯模块（不 import electron），能直接单测：跑命令、读文件、取时间都可以注入。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import type { S3Creds } from './s3Client.ts';
import type { SyncConfig } from './s3Sync.ts';
import { tr, trList } from './uiText.ts';

export type CredentialSource = 'keys' | 'profile' | 'default';

/** 缺省 / 认不出的值 = `keys`：旧配置行为完全不变。 */
export function credentialSourceOf(cfg: Pick<SyncConfig, 'credentialSource'> | undefined): CredentialSource {
  const v = cfg?.credentialSource;
  return v === 'profile' || v === 'default' ? v : 'keys';
}

/** profile 名白名单 —— 它会进 aws 的命令行参数。`;` `$(` 反引号 空格一律拒。 */
export const PROFILE_NAME_RE = /^[A-Za-z0-9_.+-]{1,64}$/;
export function validProfileName(name: unknown): name is string {
  /* 开头的 `-` 也拒：会被 aws 当成选项 */
  return typeof name === 'string' && PROFILE_NAME_RE.test(name) && !name.startsWith('-');
}

export interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** 过期时刻（ms）。静态 key 没有。 */
  expiration?: number;
}

/** `aws configure export-credentials --format process` 的输出。不是那个形状 → null。 */
export function parseExportCredentials(stdout: string): AwsKeys | null {
  let j: any;
  try { j = JSON.parse(String(stdout || '').trim()); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const accessKeyId = typeof j.AccessKeyId === 'string' ? j.AccessKeyId.trim() : '';
  const secretAccessKey = typeof j.SecretAccessKey === 'string' ? j.SecretAccessKey.trim() : '';
  if (!accessKeyId || !secretAccessKey) return null;
  const out: AwsKeys = { accessKeyId, secretAccessKey };
  if (typeof j.SessionToken === 'string' && j.SessionToken.trim()) out.sessionToken = j.SessionToken.trim();
  if (typeof j.Expiration === 'string' && j.Expiration.trim()) {
    const at = Date.parse(j.Expiration);
    if (Number.isFinite(at)) out.expiration = at;
  }
  return out;
}

/**
 * `~/.aws/config` / `~/.aws/credentials` 的 ini。整行 `#` / `;` 是注释；值后面「空白 + # / ;」也算注释
 * （key 里不会有空白）。缩进的行是上一个 key 的子项（`s3 =` 下面那种），不当成顶层 key。
 */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let cur: Record<string, string> | null = null;
  let lastEmpty = false;   // 上一个 key 的值是空的 → 后面缩进的行是它的子项
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const sec = trimmed.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (sec) {
      cur = out[sec[1]] = out[sec[1]] || {};
      lastEmpty = false;
      continue;
    }
    if (!cur) continue;
    if (/^\s/.test(line) && lastEmpty) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).replace(/\s[#;].*$/, '').trim();
    cur[key] = value;
    lastEmpty = !value;
  }
  return out;
}

const uniq = (xs: string[]): string[] => xs.filter((v, i, a) => a.indexOf(v) === i);

/** `~/.aws/config` 里的 profile 名：`[default]`、`[profile foo]`（`[sso-session x]` 之类不是 profile）。 */
export function profilesFromConfig(text: string): string[] {
  return uniq(Object.keys(parseIni(text))
    .map((s) => (s === 'default' ? 'default' : (s.match(/^profile\s+(.+)$/) || [])[1]?.trim() || ''))
    .filter(validProfileName));
}

/** `~/.aws/credentials` 里的 profile 名：每个 section 就是一个。 */
export function profilesFromCredentials(text: string): string[] {
  return uniq(Object.keys(parseIni(text)).filter(validProfileName));
}

/** `~/.aws/credentials` 里这个 profile 的静态 key。没有 / 不全 → null。 */
export function staticKeysFromCredentials(text: string, profile: string): AwsKeys | null {
  const s = parseIni(text)[profile];
  const accessKeyId = s?.aws_access_key_id || '';
  const secretAccessKey = s?.aws_secret_access_key || '';
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey, ...(s.aws_session_token ? { sessionToken: s.aws_session_token } : null) };
}

/** 到 Expiration 前这么久就重新取。 */
export const REFRESH_EARLY_MS = 5 * 60_000;
/** 没有 Expiration 的缓存多久。 */
export const NO_EXPIRY_TTL_MS = 60 * 60_000;

export interface CacheEntry { keys: AwsKeys; fetchedAt: number }

/** 缓存里这份还能不能直接用。 */
export function cacheFresh(entry: CacheEntry | undefined, now: number): boolean {
  if (!entry) return false;
  if (entry.keys.expiration !== undefined) return now < entry.keys.expiration - REFRESH_EARLY_MS;
  return now < entry.fetchedAt + NO_EXPIRY_TTL_MS;
}

export type AwsCredsErrorKind = 'sso-expired' | 'no-profile' | 'no-cli' | 'bad-name' | 'cli-failed';

export class AwsCredsError extends Error {
  kind: AwsCredsErrorKind;
  /** 用的 profile；默认凭证链是 undefined。 */
  profile?: string;
  constructor(kind: AwsCredsErrorKind, message: string, profile?: string) {
    super(message);
    this.kind = kind;
    this.profile = profile;
  }
}

const SSO_EXPIRED_RE = /Token has expired|SSO session|UnauthorizedSSOToken|Error loading SSO Token|sso.{0,40}expired/i;
const NO_PROFILE_RE = /config profile \(([^)]*)\) could not be found|ProfileNotFound/i;

/** profile 找不到时的那句（列出现有的 profile）。 */
export function noProfileError(profile: string, profiles: string[]): AwsCredsError {
  return new AwsCredsError('no-profile', profiles.length
    ? tr('AWS profile {profile} was not found in ~/.aws/config or ~/.aws/credentials. Existing profiles: {list}', { profile, list: trList(profiles) })
    : tr('AWS profile {profile} was not found, and ~/.aws/config / ~/.aws/credentials have no profiles at all.', { profile }), profile);
}

/** CLI 失败的输出 → 一句人话。`profile` undefined = 默认凭证链。 */
export function translateCliError(stderr: string, profile: string | undefined, profiles: string[]): AwsCredsError {
  const text = String(stderr || '');
  if (SSO_EXPIRED_RE.test(text)) {
    return new AwsCredsError('sso-expired', profile
      ? tr('The SSO login for profile {profile} has expired. Run `aws sso login --profile {profile}` in a terminal, then click Retry.', { profile })
      : tr('The SSO login for the default AWS credentials has expired. Run `aws sso login` in a terminal, then click Retry.'), profile);
  }
  if (profile && NO_PROFILE_RE.test(text)) return noProfileError(profile, profiles);
  const first = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-1)[0] || '';
  return new AwsCredsError('cli-failed', tr('Getting AWS credentials ({profile}) failed: {error}', {
    profile: profile || tr('default credential chain'), error: first.slice(0, 300) || tr('unknown error'),
  }), profile);
}

/** aws 可执行文件：PATH → /usr/local/bin/aws → /opt/homebrew/bin/aws（Windows：PATH 里的 aws.exe → 默认安装位置）。 */
export function findAwsCli(envPath: string | undefined, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = defaultExists): string | null {
  const win = platform === 'win32';
  const dirs = String(envPath || '').split(win ? ';' : ':').filter(Boolean);
  const name = win ? 'aws.exe' : 'aws';
  const join = win ? path.win32.join : path.posix.join;
  const fallbacks = win
    ? ['C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe']
    : ['/usr/local/bin/aws', '/opt/homebrew/bin/aws'];
  for (const p of [...dirs.map((d) => join(d.replace(/^"|"$/g, ''), name)), ...fallbacks]) {
    if (exists(p)) return p;
  }
  return null;
}

function defaultExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

export interface ExecResult { code: number | null; stdout: string; stderr: string; spawnError?: string }
export type Runner = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecResult>;

/** `execFile`，不经 shell。 */
export const execRunner: Runner = (file, args, opts) => new Promise((resolve) => {
  execFile(file, args, { env: opts.env, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err: any, stdout, stderr) => {
    resolve({
      code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
      ...(err && typeof err.code === 'string' ? { spawnError: err.code } : null),
    });
  });
});

export interface ResolverDeps {
  /** 跑 aws 用的环境（主进程传登录 shell 的那份，PATH 才全）。 */
  env: () => NodeJS.ProcessEnv;
  home?: () => string;
  run?: Runner;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string | null;
  now?: () => number;
  platform?: NodeJS.Platform;
}

const EXPORT_TIMEOUT_MS = 60_000;

/** 按 profile 取临时凭证，带内存缓存。`profile` undefined = 默认凭证链。 */
export class AwsCredsResolver {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<AwsKeys>>();
  private deps: Required<ResolverDeps>;

  constructor(deps: ResolverDeps) {
    this.deps = {
      home: () => os.homedir(),
      run: execRunner,
      exists: defaultExists,
      readFile: (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
      now: () => Date.now(),
      platform: process.platform,
      ...Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined)),
    } as Required<ResolverDeps>;
  }

  cliPath(): string | null {
    const env = this.deps.env();
    return findAwsCli(env.PATH ?? env.Path, this.deps.platform, this.deps.exists);
  }

  private configText(): string {
    const env = this.deps.env();
    return this.deps.readFile(env.AWS_CONFIG_FILE || path.join(this.deps.home(), '.aws', 'config')) || '';
  }

  private credentialsText(): string {
    const env = this.deps.env();
    return this.deps.readFile(env.AWS_SHARED_CREDENTIALS_FILE || path.join(this.deps.home(), '.aws', 'credentials')) || '';
  }

  /** `~/.aws/config` 和 `~/.aws/credentials` 里的 profile 名（合并去重）。 */
  listProfiles(): string[] {
    return uniq([...profilesFromConfig(this.configText()), ...profilesFromCredentials(this.credentialsText())]);
  }

  async get(profile?: string): Promise<AwsKeys> {
    if (profile !== undefined && !validProfileName(profile)) {
      throw new AwsCredsError('bad-name', tr('The AWS profile name {profile} is not valid (only letters, digits and _ . + - are allowed, up to 64 characters).', { profile: JSON.stringify(String(profile)) }), undefined);
    }
    const key = profile ?? '';
    const hit = this.cache.get(key);
    if (cacheFresh(hit, this.deps.now())) return hit!.keys;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.fetch(profile)
      .then((keys) => { this.cache.set(key, { keys, fetchedAt: this.deps.now() }); return keys; })
      .finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }

  /** 清掉缓存。给了 `failedKeyId` 就只在缓存的还是那一份时才清（并发失败的请求不会一人清一次）。 */
  invalidate(profile?: string, failedKeyId?: string): void {
    const key = profile ?? '';
    const c = this.cache.get(key);
    if (!c || failedKeyId === undefined || c.keys.accessKeyId === failedKeyId) this.cache.delete(key);
  }

  /** S3 说凭证不对：清缓存重取一次。 */
  async refresh(profile: string | undefined, failedKeyId: string): Promise<AwsKeys> {
    this.invalidate(profile, failedKeyId);
    return this.get(profile);
  }

  private async fetch(profile?: string): Promise<AwsKeys> {
    const cli = this.cliPath();
    let cliTooOld = false;
    if (cli) {
      const args = ['configure', 'export-credentials', ...(profile ? ['--profile', profile] : []), '--format', 'process'];
      const r = await this.deps.run(cli, args, { env: this.deps.env(), timeoutMs: EXPORT_TIMEOUT_MS });
      if (!r.spawnError) {
        if (r.code === 0) {
          const keys = parseExportCredentials(r.stdout);
          if (keys) return keys;
          throw new AwsCredsError('cli-failed', tr('Getting AWS credentials ({profile}) failed: {error}', {
            profile: profile || tr('default credential chain'), error: tr('unexpected output from aws configure export-credentials'),
          }), profile);
        }
        /* CLI v1 没有 export-credentials —— 当成没有 CLI，退到静态 key */
        if (/invalid choice/i.test(r.stderr)) cliTooOld = true;
        else throw translateCliError(r.stderr, profile, this.listProfiles());
      }
    }
    /* 没有（能用的）CLI：只认静态 key */
    const credsText = this.credentialsText();
    if (!profile) {
      const env = this.deps.env();
      if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
        return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : null) };
      }
      const name = validProfileName(env.AWS_PROFILE) ? env.AWS_PROFILE : 'default';
      const keys = staticKeysFromCredentials(credsText, name);
      if (keys) return keys;
      throw new AwsCredsError('no-cli', cliTooOld
        ? tr('Your AWS CLI is too old: `aws configure export-credentials` needs AWS CLI v2. Upgrade it, then retry.')
        : tr('No AWS credentials were found in the environment or ~/.aws/credentials, and the AWS CLI (aws) was not found on this computer. Install AWS CLI v2, then retry.'));
    }
    const keys = staticKeysFromCredentials(credsText, profile);
    if (keys) return keys;
    const profiles = this.listProfiles();
    if (!profiles.includes(profile)) throw noProfileError(profile, profiles);
    throw new AwsCredsError('no-cli', cliTooOld
      ? tr('Your AWS CLI is too old: `aws configure export-credentials` needs AWS CLI v2. Upgrade it, then retry.')
      : tr('Profile {profile} has no static keys in ~/.aws/credentials, and the AWS CLI (aws) was not found on this computer. Install AWS CLI v2 (it handles SSO / assume-role / credential_process), then retry.', { profile }), profile);
  }

  /**
   * 这组凭证是谁（`sts get-caller-identity` 的 ARN）。凭证经环境变量交给 CLI —— 问的正是 S3 用的那一份。
   * 没有 CLI / 失败 → 空串（只是少显示一行，不算测试失败）。
   */
  async callerIdentity(keys: AwsKeys, region: string): Promise<string> {
    const cli = this.cliPath();
    if (!cli) return '';
    const env: NodeJS.ProcessEnv = { ...this.deps.env(), AWS_ACCESS_KEY_ID: keys.accessKeyId, AWS_SECRET_ACCESS_KEY: keys.secretAccessKey };
    delete env.AWS_PROFILE; delete env.AWS_DEFAULT_PROFILE; delete env.AWS_SESSION_TOKEN;
    if (keys.sessionToken) env.AWS_SESSION_TOKEN = keys.sessionToken;
    const r = await this.deps.run(cli, ['sts', 'get-caller-identity', '--output', 'json', ...(region ? ['--region', region] : [])], { env, timeoutMs: 20_000 });
    if (r.spawnError || r.code !== 0) return '';
    try { const arn = JSON.parse(r.stdout)?.Arn; return typeof arn === 'string' ? arn : ''; } catch { return ''; }
  }
}

export interface SyncCredsResult {
  creds?: S3Creds;
  problem?: string;
  /** SSO 过期：界面给「打开终端登录」。`profile` undefined = 默认凭证链。 */
  ssoLogin?: { profile?: string };
}

/** 只看配置本身（不跑 CLI）缺不缺东西 —— 设置页置灰「移到云端」用，要快。 */
export function syncConfigProblem(cfg: SyncConfig, decrypt: (cipher?: string) => string): string {
  const source = credentialSourceOf(cfg);
  const missing = [
    !cfg.bucket && 'bucket',
    !cfg.region && 'region',
    ...(source === 'keys'
      ? [!cfg.accessKeyId && 'Access Key ID', !cfg.secretCipher && 'Secret Access Key']
      : [source === 'profile' && !cfg.awsProfile && 'AWS profile']),
  ].filter(Boolean) as string[];
  if (missing.length) return tr('S3 backup is not fully set up: missing {fields} (Settings → ☁️ Backup).', { fields: trList(missing) });
  if (source === 'keys' && !decrypt(cfg.secretCipher)) {
    return tr('The S3 secret can\'t be decrypted any more: the key in the keychain has changed (new machine or reinstall?). Enter it again.');
  }
  if (source === 'profile' && !validProfileName(cfg.awsProfile)) {
    return tr('The AWS profile name {profile} is not valid (only letters, digits and _ . + - are allowed, up to 64 characters).', { profile: JSON.stringify(String(cfg.awsProfile)) });
  }
  return '';
}

export interface SyncCredsDeps {
  decrypt: (cipher?: string) => string;
  resolver: AwsCredsResolver;
  /**
   * 操作**途中**重取凭证（S3 拒了旧 token → `refresh`）的结果：SSO 过期 → `{ profile }`，重取成功 → null。
   * 第一次取凭证的结果在返回值的 `ssoLogin` 里；途中这一次只能经这里告诉调用方（设置页的「打开终端登录」靠它）。
   */
  onRefreshSso?: (login: { profile?: string } | null) => void;
}

/**
 * 同步要用的 S3Creds。`keys`（缺省）和原来的 `syncCredsOrProblem` 一模一样；
 * `profile` / `default` 从 resolver 取临时凭证，并挂上 `refresh`（S3 说凭证过期时重取一次）。
 */
export async function resolveSyncCreds(
  cfg: SyncConfig,
  deps: SyncCredsDeps,
): Promise<SyncCredsResult> {
  const problem = syncConfigProblem(cfg, deps.decrypt);
  if (problem) return { problem };
  const base = { region: cfg.region!, bucket: cfg.bucket!, endpoint: cfg.endpoint };
  const source = credentialSourceOf(cfg);
  if (source === 'keys') {
    return { creds: { accessKeyId: cfg.accessKeyId!, secretAccessKey: deps.decrypt(cfg.secretCipher), ...base } };
  }
  const profile = source === 'profile' ? cfg.awsProfile! : undefined;
  try {
    const keys = await deps.resolver.get(profile);
    return {
      creds: {
        accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey,
        ...(keys.sessionToken ? { sessionToken: keys.sessionToken } : null),
        ...base,
        refresh: async (failedKeyId: string) => {
          try {
            const fresh = await deps.resolver.refresh(profile, failedKeyId);
            deps.onRefreshSso?.(null);
            return fresh;
          } catch (err) {
            if (err instanceof AwsCredsError && err.kind === 'sso-expired') deps.onRefreshSso?.({ profile });
            throw err;
          }
        },
      },
    };
  } catch (err: any) {
    if (err instanceof AwsCredsError) {
      return { problem: err.message, ...(err.kind === 'sso-expired' ? { ssoLogin: { profile } } : null) };
    }
    return { problem: String(err?.message || err) };
  }
}

/**
 * 一次操作的**配置快照 + 凭证**：配置只读一次，取凭证和后面的请求（桶、前缀、其他同步设置）都用这一份。
 * 取临时凭证要等 aws CLI（可能好几秒），期间用户改了桶 / profile / 前缀的话，再读一次配置就会是「旧凭证 + 新前缀」。
 */
export async function resolveSyncSnapshot(
  load: () => SyncConfig,
  deps: SyncCredsDeps,
): Promise<SyncCredsResult & { cfg: SyncConfig }> {
  const cfg = load();
  return { ...(await resolveSyncCreds(cfg, deps)), cfg };
}

export interface RunLock { held: boolean }

/**
 * 「同一时间只跑一轮」：在**第一次 await（取凭证）之前**就占住锁 —— 否则取凭证那几秒里，定时 / 启动补同步 / 手动
 * 都能通过入口检查，凭证回来后几轮一起跑。锁被占着 → null。取到凭证（有 `creds`）时锁留给调用方，由它在整轮的
 * finally 里放；没取到（配置有问题 / 取凭证失败 / 抛错）就在这里放掉。
 */
export async function lockThenResolve<T extends { creds?: unknown }>(lock: RunLock, resolve: () => Promise<T>): Promise<T | null> {
  if (lock.held) return null;
  lock.held = true;
  let r: T | undefined;
  try {
    r = await resolve();
    return r;
  } finally {
    if (!r?.creds) lock.held = false;
  }
}

/** 日志里说用的是哪份凭证：profile 名 / 默认链 / key 的后 4 位（`maskKeyId`）。 */
export function credsLogLabel(cfg: SyncConfig, maskKeyId: (id?: string) => string): string {
  const source = credentialSourceOf(cfg);
  if (source === 'profile') return `profile=${cfg.awsProfile || ''}`;
  if (source === 'default') return 'creds=默认凭证链';
  return `key=${maskKeyId(cfg.accessKeyId)}`;
}
