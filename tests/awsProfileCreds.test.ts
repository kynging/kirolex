/**
 * S3 云同步的凭证可以来自 AWS profile / 默认凭证链（`awsProfileCreds.ts`），不再只有 AK/SK。
 * 「长期 AK/SK 存在本机不安全，公司账号也多半只给 SSO / assume-role」。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseExportCredentials, parseIni, profilesFromConfig, profilesFromCredentials, staticKeysFromCredentials,
  cacheFresh, REFRESH_EARLY_MS, NO_EXPIRY_TTL_MS, validProfileName, translateCliError, findAwsCli,
  AwsCredsResolver, AwsCredsError, resolveSyncCreds, syncConfigProblem, credentialSourceOf, credsLogLabel,
  lockThenResolve, resolveSyncSnapshot,
} from '../src/main/awsProfileCreds.ts';
import type { Runner, ExecResult } from '../src/main/awsProfileCreds.ts';
import { shouldRefreshCreds } from '../src/main/s3Client.ts';
import { signRequest } from '../src/main/awsSigV4.ts';
import { setUiLang, tr, trList } from '../src/main/uiText.ts';
import { maskKeyId } from '../src/main/s3Sync.ts';
import type { SyncConfig } from '../src/main/s3Sync.ts';

setUiLang('zh');

describe('export-credentials 输出解析', () => {
  test('带 SessionToken 和 Expiration', () => {
    const k = parseExportCredentials(JSON.stringify({
      Version: 1, AccessKeyId: 'ASIAEXAMPLE1234', SecretAccessKey: 'sk', SessionToken: 'tok', Expiration: '2026-11-05T10:00:00+00:00',
    }));
    assert.deepEqual(k, { accessKeyId: 'ASIAEXAMPLE1234', secretAccessKey: 'sk', sessionToken: 'tok', expiration: Date.parse('2026-11-05T10:00:00Z') });
  });
  test('不带 SessionToken / Expiration（静态 key 的 profile）', () => {
    const k = parseExportCredentials('{"Version":1,"AccessKeyId":"AKIAX","SecretAccessKey":"sk"}\n');
    assert.deepEqual(k, { accessKeyId: 'AKIAX', secretAccessKey: 'sk' });
  });
  test('坏输出 → null', () => {
    assert.equal(parseExportCredentials('not json'), null);
    assert.equal(parseExportCredentials('{"AccessKeyId":"A"}'), null);
    assert.equal(parseExportCredentials(''), null);
  });
});

describe('缓存过期判断', () => {
  const now = 1_000_000_000_000;
  test('有 Expiration：到期前 5 分钟就算过期', () => {
    const e = (exp: number) => ({ keys: { accessKeyId: 'a', secretAccessKey: 'b', expiration: exp }, fetchedAt: now - 1000 });
    assert.equal(cacheFresh(e(now + REFRESH_EARLY_MS + 1000), now), true);
    assert.equal(cacheFresh(e(now + REFRESH_EARLY_MS - 1000), now), false);
    assert.equal(cacheFresh(e(now - 1), now), false);
  });
  test('没有 Expiration：缓存 1 小时', () => {
    const e = (at: number) => ({ keys: { accessKeyId: 'a', secretAccessKey: 'b' }, fetchedAt: at });
    assert.equal(cacheFresh(e(now - NO_EXPIRY_TTL_MS + 1000), now), true);
    assert.equal(cacheFresh(e(now - NO_EXPIRY_TTL_MS - 1), now), false);
    assert.equal(cacheFresh(undefined, now), false);
  });
});

describe('~/.aws 的 ini 解析', () => {
  const CREDS = [
    '# 注释',
    '; 另一种注释',
    '[default]',
    'aws_access_key_id = AKIADEFAULT',
    'aws_secret_access_key=secretdefault   # 行尾注释',
    '',
    '[  work  ]',
    '  aws_access_key_id   =   AKIAWORK  ',
    'aws_secret_access_key = secretwork',
    'aws_session_token = tokwork',
    '[partial]',
    'aws_access_key_id = AKIAONLY',
  ].join('\r\n');

  test('多个 profile、注释、空格', () => {
    const ini = parseIni(CREDS);
    assert.deepEqual(Object.keys(ini), ['default', 'work', 'partial']);
    assert.equal(ini.default.aws_secret_access_key, 'secretdefault');
    assert.equal(ini.work.aws_access_key_id, 'AKIAWORK');
    assert.deepEqual(staticKeysFromCredentials(CREDS, 'default'), { accessKeyId: 'AKIADEFAULT', secretAccessKey: 'secretdefault' });
    assert.deepEqual(staticKeysFromCredentials(CREDS, 'work'), { accessKeyId: 'AKIAWORK', secretAccessKey: 'secretwork', sessionToken: 'tokwork' });
    assert.equal(staticKeysFromCredentials(CREDS, 'partial'), null);
    assert.equal(staticKeysFromCredentials(CREDS, 'nope'), null);
    assert.deepEqual(profilesFromCredentials(CREDS), ['default', 'work', 'partial']);
  });

  test('config：[default] / [profile x]，sso-session 不是 profile，缩进子项不当顶层 key', () => {
    const CONFIG = [
      '[default]', 'region = us-east-1',
      '[profile dev-sso]', 'sso_session = corp', 'sso_account_id = 123', 's3 =', '  max_concurrent_requests = 5',
      '[profile cn.prod]', 'region = cn-north-1', 'role_arn = arn:aws-cn:iam::1:role/x', 'source_profile = default',
      '[sso-session corp]', 'sso_start_url = https://x.awsapps.com/start',
      '[profile bad name]', 'region = x',
    ].join('\n');
    assert.deepEqual(profilesFromConfig(CONFIG), ['default', 'dev-sso', 'cn.prod']);
    assert.equal(parseIni(CONFIG)['profile dev-sso'].max_concurrent_requests, undefined);
  });
});

describe('profile 名注入被拒', () => {
  test('白名单', () => {
    for (const ok of ['default', 'dev-sso', 'cn.prod', 'a_b+c', 'x'.repeat(64)]) assert.equal(validProfileName(ok), true, ok);
    for (const bad of ['a;rm -rf ~', '$(whoami)', '`id`', 'a b', '', 'x'.repeat(65), 'a|b', '--profile', '../x', undefined, 3])
      assert.equal(validProfileName(bad), false, String(bad));
  });
  test('resolver 拒绝跑命令', async () => {
    let ran = false;
    const r = new AwsCredsResolver({ env: () => ({ PATH: '/bin' }), exists: () => true, run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' }; } });
    for (const bad of ['a;b', '$(id)', '`id`', 'a b']) {
      await assert.rejects(r.get(bad), (e: any) => e instanceof AwsCredsError && e.kind === 'bad-name');
    }
    assert.equal(ran, false);
  });
  test('配置里填了坏名字：报配置问题，不去取凭证', () => {
    const p = syncConfigProblem({ bucket: 'b', region: 'r', credentialSource: 'profile', awsProfile: '$(id)' }, () => '');
    assert.match(p, /\$\(id\)/);
  });
});

describe('错误翻译', () => {
  test('SSO 过期', () => {
    for (const err of [
      'Error when retrieving token from sso: Token has expired and refresh failed',
      'The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.',
    ]) {
      const e = translateCliError(err, 'dev-sso', []);
      assert.equal(e.kind, 'sso-expired');
      assert.match(e.message, /dev-sso/);
      assert.match(e.message, /aws sso login --profile dev-sso/);
    }
    const d = translateCliError('Token has expired', undefined, []);
    assert.equal(d.kind, 'sso-expired');
    assert.match(d.message, /aws sso login`/);
  });
  test('profile 不存在 → 列出现有 profile', () => {
    const e = translateCliError('\nThe config profile (nope) could not be found\n', 'nope', ['default', 'dev-sso']);
    assert.equal(e.kind, 'no-profile');
    assert.match(e.message, /nope/);
    assert.match(e.message, /default、dev-sso/);
    const none = translateCliError('The config profile (nope) could not be found', 'nope', []);
    assert.equal(none.kind, 'no-profile');
  });
  test('别的错误：带上 CLI 最后一行', () => {
    const e = translateCliError('\nAn error occurred (AccessDenied) when calling the AssumeRole operation: denied\n', 'p', []);
    assert.equal(e.kind, 'cli-failed');
    assert.match(e.message, /AssumeRole operation: denied/);
  });
});

describe('找 aws CLI', () => {
  test('PATH → /usr/local/bin/aws → /opt/homebrew/bin/aws', () => {
    assert.equal(findAwsCli('/a:/b', 'darwin', (p) => p === '/b/aws'), '/b/aws');
    assert.equal(findAwsCli('/a', 'darwin', (p) => p === '/usr/local/bin/aws' || p === '/opt/homebrew/bin/aws'), '/usr/local/bin/aws');
    assert.equal(findAwsCli('', 'darwin', (p) => p === '/opt/homebrew/bin/aws'), '/opt/homebrew/bin/aws');
    assert.equal(findAwsCli('/a', 'darwin', () => false), null);
  });
});

/** 一个假的 aws + 假的 ~/.aws。 */
function fakeResolver(opts: { cli?: boolean; reply?: (args: string[]) => ExecResult; files?: Record<string, string>; env?: NodeJS.ProcessEnv; now?: () => number }) {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const run: Runner = async (file, args, o) => { calls.push({ file, args, env: o.env }); return opts.reply!(args); };
  const r = new AwsCredsResolver({
    env: () => ({ PATH: '/usr/bin', ...(opts.env || {}) }),
    home: () => '/home/u',
    platform: 'linux',
    exists: (p) => !!opts.cli && p === '/usr/bin/aws',
    readFile: (p) => opts.files?.[p.replace(/\\/g, '/')] ?? null,
    run,
    now: opts.now,
  });
  return { r, calls };
}

describe('AwsCredsResolver', () => {
  const ok = (id: string, exp?: string): ExecResult => ({ code: 0, stderr: '', stdout: JSON.stringify({ Version: 1, AccessKeyId: id, SecretAccessKey: 's', SessionToken: 't', ...(exp ? { Expiration: exp } : null) }) });

  test('用 execFile 参数调 export-credentials（不经 shell）；缓存；过期前重取', async () => {
    let now = Date.parse('2026-11-05T00:00:00Z');
    let n = 0;
    const { r, calls } = fakeResolver({ cli: true, now: () => now, reply: () => ok(`ASIA${++n}`, '2026-11-05T01:00:00Z') });
    const a = await r.get('dev-sso');
    assert.equal(a.accessKeyId, 'ASIA1');
    assert.equal(a.sessionToken, 't');
    assert.deepEqual(calls[0].args, ['configure', 'export-credentials', '--profile', 'dev-sso', '--format', 'process']);
    assert.equal(calls[0].file, '/usr/bin/aws');
    assert.equal((await r.get('dev-sso')).accessKeyId, 'ASIA1');
    assert.equal(calls.length, 1);
    now = Date.parse('2026-11-05T00:56:00Z');   // 到期前 4 分钟
    assert.equal((await r.get('dev-sso')).accessKeyId, 'ASIA2');
    /* 默认凭证链不带 --profile */
    await r.get(undefined);
    assert.deepEqual(calls.at(-1)!.args, ['configure', 'export-credentials', '--format', 'process']);
  });

  test('refresh 只在缓存还是失败那一份时才清；并发只取一次', async () => {
    let n = 0;
    const { r, calls } = fakeResolver({ cli: true, reply: () => ok(`ASIA${++n}`) });
    await r.get('p');
    const [x, y] = await Promise.all([r.refresh('p', 'ASIA1'), r.refresh('p', 'ASIA1')]);
    assert.equal(x.accessKeyId, 'ASIA2');
    assert.equal(y.accessKeyId, 'ASIA2');
    assert.equal(calls.length, 2);
    /* 已经换过了：拿旧 key 来 refresh 不再重取 */
    assert.equal((await r.refresh('p', 'ASIA1')).accessKeyId, 'ASIA2');
    assert.equal(calls.length, 2);
  });

  test('SSO 过期 / profile 不存在', async () => {
    const files = { '/home/u/.aws/config': '[profile dev-sso]\nsso_session=x\n[default]\n' };
    const { r } = fakeResolver({ cli: true, files, reply: (args) => args.includes('dev-sso')
      ? { code: 255, stdout: '', stderr: 'Error when retrieving token from sso: Token has expired and refresh failed' }
      : { code: 255, stdout: '', stderr: 'The config profile (ghost) could not be found' } });
    await assert.rejects(r.get('dev-sso'), (e: any) => e.kind === 'sso-expired');
    await assert.rejects(r.get('ghost'), (e: any) => e.kind === 'no-profile' && /dev-sso/.test(e.message) && /default/.test(e.message));
  });

  test('没有 aws CLI：读 ~/.aws/credentials 的静态 key；拿不到就说要装 CLI', async () => {
    const files = {
      '/home/u/.aws/credentials': '[static]\naws_access_key_id=AKIASTATIC\naws_secret_access_key=s\n[default]\naws_access_key_id=AKIADEF\naws_secret_access_key=d\n',
      '/home/u/.aws/config': '[profile sso-only]\nsso_session=x\n',
    };
    const { r, calls } = fakeResolver({ cli: false, files, reply: () => { throw new Error('should not run'); } });
    assert.equal((await r.get('static')).accessKeyId, 'AKIASTATIC');
    assert.equal((await r.get(undefined)).accessKeyId, 'AKIADEF');
    await assert.rejects(r.get('sso-only'), (e: any) => e.kind === 'no-cli' && /AWS CLI/.test(e.message));
    await assert.rejects(r.get('ghost'), (e: any) => e.kind === 'no-profile');
    assert.equal(calls.length, 0);
  });

  test('没有 CLI 的默认链先看环境变量', async () => {
    const { r } = fakeResolver({ cli: false, env: { AWS_ACCESS_KEY_ID: 'AKIAENV', AWS_SECRET_ACCESS_KEY: 'e', AWS_SESSION_TOKEN: 'et' }, reply: () => ok('x') });
    assert.deepEqual(await r.get(undefined), { accessKeyId: 'AKIAENV', secretAccessKey: 'e', sessionToken: 'et' });
  });

  test('CLI v1（没有 export-credentials）退到静态 key', async () => {
    const files = { '/home/u/.aws/credentials': '[p]\naws_access_key_id=AKIAV1\naws_secret_access_key=s\n' };
    const { r } = fakeResolver({ cli: true, files, reply: () => ({ code: 2, stdout: '', stderr: 'aws: error: argument operation: Invalid choice' }) });
    assert.equal((await r.get('p')).accessKeyId, 'AKIAV1');
  });

  test('get-caller-identity 用的是同一份凭证（经环境变量），带上 region', async () => {
    const { r, calls } = fakeResolver({ cli: true, env: { AWS_PROFILE: 'other' }, reply: () => ({ code: 0, stderr: '', stdout: '{"Arn":"arn:aws-cn:sts::1:assumed-role/x/y"}' }) });
    const arn = await r.callerIdentity({ accessKeyId: 'ASIA1', secretAccessKey: 's', sessionToken: 't' }, 'cn-north-1');
    assert.equal(arn, 'arn:aws-cn:sts::1:assumed-role/x/y');
    assert.deepEqual(calls[0].args, ['sts', 'get-caller-identity', '--output', 'json', '--region', 'cn-north-1']);
    assert.equal(calls[0].env.AWS_ACCESS_KEY_ID, 'ASIA1');
    assert.equal(calls[0].env.AWS_SESSION_TOKEN, 't');
    assert.equal(calls[0].env.AWS_PROFILE, undefined);
    const { r: noCli } = fakeResolver({ cli: false, reply: () => ok('x') });
    assert.equal(await noCli.callerIdentity({ accessKeyId: 'a', secretAccessKey: 'b' }, 'us-east-1'), '');
  });
});

describe('resolveSyncCreds', () => {
  /** 改之前 index.ts 里 syncCredsOrProblem 的逻辑（原样抄过来），做回归对照。 */
  function oldSyncCredsOrProblem(cfg: SyncConfig, decryptSecret: (c?: string) => string): any {
    const missing = [
      !cfg.bucket && 'bucket',
      !cfg.region && 'region',
      !cfg.accessKeyId && 'Access Key ID',
      !cfg.secretCipher && 'Secret Access Key',
    ].filter(Boolean) as string[];
    if (missing.length) return { problem: tr('S3 backup is not fully set up: missing {fields} (Settings → ☁️ Backup).', { fields: trList(missing) }) };
    const secretAccessKey = decryptSecret(cfg.secretCipher);
    if (!secretAccessKey) {
      return { problem: tr('The S3 secret can\'t be decrypted any more: the key in the keychain has changed (new machine or reinstall?). Enter it again.') };
    }
    return { creds: { accessKeyId: cfg.accessKeyId!, secretAccessKey, region: cfg.region!, bucket: cfg.bucket!, endpoint: cfg.endpoint } };
  }

  test('credentialSource 缺省 = 和原来的 syncCredsOrProblem 一致', async () => {
    const neverResolver = new AwsCredsResolver({ env: () => ({}), exists: () => false, run: async () => { throw new Error('keys 模式不该跑 aws'); } });
    const decrypt = (c?: string) => (c === 'good' ? 'SECRET' : '');
    const cases: SyncConfig[] = [
      {},
      { bucket: 'b' },
      { bucket: 'b', region: 'us-west-2', accessKeyId: 'AKIA1' },
      { bucket: 'b', region: 'us-west-2', accessKeyId: 'AKIA1', secretCipher: 'bad' },
      { bucket: 'b', region: 'cn-north-1', accessKeyId: 'AKIA1', secretCipher: 'good' },
      { bucket: 'b', region: 'us-west-2', accessKeyId: 'AKIA1', secretCipher: 'good', endpoint: 'minio.local:9000' },
      { bucket: 'b', region: 'us-west-2', accessKeyId: 'AKIA1', secretCipher: 'good', credentialSource: 'keys', awsProfile: 'ignored' },
      { bucket: 'b', region: 'us-west-2', accessKeyId: 'AKIA1', secretCipher: 'good', credentialSource: 'weird' as any },
    ];
    for (const cfg of cases) {
      assert.deepEqual(await resolveSyncCreds(cfg, { decrypt, resolver: neverResolver }), oldSyncCredsOrProblem(cfg, decrypt), JSON.stringify(cfg));
    }
  });

  test('profile：带 sessionToken 和 refresh，AK/SK 字段不用', async () => {
    let n = 0;
    const { r } = fakeResolver({ cli: true, reply: () => ({ code: 0, stderr: '', stdout: JSON.stringify({ AccessKeyId: `ASIA${++n}`, SecretAccessKey: 's', SessionToken: 'tok' }) }) });
    const res = await resolveSyncCreds({ bucket: 'b', region: 'cn-northwest-1', credentialSource: 'profile', awsProfile: 'cn', accessKeyId: 'AKIAOLD', secretCipher: 'x' }, { decrypt: () => 'OLD', resolver: r });
    assert.equal(res.creds!.accessKeyId, 'ASIA1');
    assert.equal(res.creds!.sessionToken, 'tok');
    assert.equal(res.creds!.region, 'cn-northwest-1');
    assert.equal((await res.creds!.refresh!('ASIA1')).accessKeyId, 'ASIA2');
  });

  test('profile 缺名字 / SSO 过期给 ssoLogin', async () => {
    const { r } = fakeResolver({ cli: true, reply: () => ({ code: 255, stdout: '', stderr: 'Token has expired' }) });
    const miss = await resolveSyncCreds({ bucket: 'b', region: 'r', credentialSource: 'profile' }, { decrypt: () => '', resolver: r });
    assert.match(miss.problem!, /AWS profile/);
    const sso = await resolveSyncCreds({ bucket: 'b', region: 'r', credentialSource: 'profile', awsProfile: 'dev' }, { decrypt: () => '', resolver: r });
    assert.deepEqual(sso.ssoLogin, { profile: 'dev' });
    assert.match(sso.problem!, /aws sso login --profile dev/);
    const def = await resolveSyncCreds({ bucket: 'b', region: 'r', credentialSource: 'default' }, { decrypt: () => '', resolver: r });
    assert.deepEqual(def.ssoLogin, { profile: undefined });
  });

  test('来源缺省 = keys；日志只出现 profile 名 / key 后 4 位', () => {
    assert.equal(credentialSourceOf({}), 'keys');
    assert.equal(credentialSourceOf({ credentialSource: 'profile' }), 'profile');
    assert.equal(credsLogLabel({ credentialSource: 'profile', awsProfile: 'dev' }, maskKeyId), 'profile=dev');
    assert.equal(credsLogLabel({ accessKeyId: 'AKIAABCDEFGH' }, maskKeyId), 'key=****EFGH');
  });
});

describe('S3 说凭证不对时重取', () => {
  test('ExpiredToken / InvalidToken / 403 SignatureDoesNotMatch 才重取', () => {
    const x = (code: string) => `<Error><Code>${code}</Code></Error>`;
    assert.equal(shouldRefreshCreds(400, x('ExpiredToken')), true);
    assert.equal(shouldRefreshCreds(403, x('InvalidToken')), true);
    assert.equal(shouldRefreshCreds(403, x('SignatureDoesNotMatch')), true);
    assert.equal(shouldRefreshCreds(403, x('AccessDenied')), false);
    assert.equal(shouldRefreshCreds(404, x('NoSuchKey')), false);
    assert.equal(shouldRefreshCreds(500, x('ExpiredToken')), false);
  });

  test('request() 只在有 refresh 时重取，并把新凭证写回 creds', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/main/s3Client.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function request('), src.indexOf('function requestOnce('));
    assert.match(body, /if \(!creds\.refresh \|\| !shouldRefreshCreds/);
    assert.match(body, /creds\.sessionToken = fresh\.sessionToken/);
    assert.match(body, /return requestOnce\(/);
  });
});

describe('SigV4 + 临时凭证', () => {
  /* AWS 文档 "Signature Version 4 test suite" 里 post-sts-token 的思路：token 作为 x-amz-security-token 头参与签名 */
  const base = {
    method: 'GET' as const, path: '/test.txt', payload: Buffer.alloc(0), host: 'examplebucket.s3.amazonaws.com',
    now: new Date('2013-05-24T00:00:00Z'), region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };
  test('有 sessionToken：头里有 x-amz-security-token 且进了 SignedHeaders，签名随之改变', () => {
    const plain = signRequest(base);
    const withTok = signRequest({ ...base, sessionToken: 'FQoGZXIvYXdzEXAMPLE' });
    assert.equal(withTok['x-amz-security-token'], 'FQoGZXIvYXdzEXAMPLE');
    assert.match(withTok.Authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
    assert.notEqual(plain.Authorization, withTok.Authorization);
    assert.equal(plain['x-amz-security-token'], undefined);
  });
  test('中国区：scope 里是 cn-north-1，签名逻辑不变', () => {
    const h = signRequest({ ...base, region: 'cn-north-1', host: 'b.s3.cn-north-1.amazonaws.com.cn', sessionToken: 't' });
    assert.match(h.Authorization, /\/20130524\/cn-north-1\/s3\/aws4_request,/);
  });
});

/*
 * 取临时凭证要等 aws CLI（几秒）。审查意见：①锁在取凭证之后才占，这几秒里定时 / 启动补同步 / 手动能一起通过入口；
 * ②取凭证前读的配置和之后再读的配置可能不是同一份（旧桶旧凭证 + 新前缀）。
 */
describe('取凭证期间的并发和配置变化', () => {
  /** 一个要等外面放行的「取凭证」。 */
  function deferred<T>() {
    let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
    const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
  }

  test('取凭证还没回来时再触发一次：第二次直接拿到「已经在跑」，只取一次凭证', async () => {
    const lock = { held: false };
    const d = deferred<{ creds?: object; problem?: string }>();
    let calls = 0;
    const resolve = () => { calls++; return d.promise; };
    const first = lockThenResolve(lock, resolve);
    assert.equal(lock.held, true, '第一次 await 之前就占住了锁');
    assert.equal(await lockThenResolve(lock, resolve), null);
    assert.equal(await lockThenResolve(lock, resolve), null);
    d.resolve({ creds: {} });
    assert.ok(await first);
    assert.equal(calls, 1);
    assert.equal(lock.held, true, '拿到凭证后锁留给这一轮，由它的 finally 放');
    lock.held = false;
    assert.ok(await lockThenResolve(lock, async () => ({ creds: {} })));
  });

  test('没取到凭证（配置问题 / 抛错）就放掉锁，下一次能跑', async () => {
    const lock = { held: false };
    assert.deepEqual(await lockThenResolve(lock, async () => ({ problem: 'x' })), { problem: 'x' });
    assert.equal(lock.held, false);
    await assert.rejects(lockThenResolve(lock, async () => { throw new Error('boom'); }));
    assert.equal(lock.held, false);
  });

  test('取凭证期间配置被改：这次操作的桶 / 前缀 / 凭证都来自同一份快照', async () => {
    let disk: SyncConfig = { bucket: 'old-bucket', region: 'us-west-2', prefix: 'old', credentialSource: 'profile', awsProfile: 'old-p' };
    const d = deferred<ExecResult>();
    const { r, calls } = fakeResolver({ cli: true, reply: () => { throw new Error('unused'); } });
    (r as any).deps.run = async (_f: string, args: string[]) => { calls.push({ file: '', args, env: {} }); return d.promise; };
    const pending = resolveSyncSnapshot(() => ({ ...disk }), { decrypt: () => '', resolver: r });
    disk = { bucket: 'new-bucket', region: 'eu-west-1', prefix: 'new', credentialSource: 'profile', awsProfile: 'new-p' };
    d.resolve({ code: 0, stderr: '', stdout: JSON.stringify({ AccessKeyId: 'ASIAOLD', SecretAccessKey: 's', SessionToken: 't' }) });
    const res = await pending;
    assert.deepEqual(calls[0].args.slice(2, 4), ['--profile', 'old-p']);
    assert.equal(res.cfg.prefix, 'old');
    assert.equal(res.cfg.bucket, 'old-bucket');
    assert.equal(res.creds!.bucket, 'old-bucket');
    assert.equal(res.creds!.region, 'us-west-2');
  });

  test('index.ts：同步先占锁再取凭证；各入口取完凭证不再重读配置', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/main/index.ts'), 'utf8');
    const sync = M.slice(M.indexOf('async function runS3Sync('), M.indexOf('function rescheduleS3Sync('));
    const firstAwait = sync.indexOf('await ');
    assert.ok(firstAwait > 0);
    assert.match(sync.slice(firstAwait - 40, firstAwait + 60), /await lockThenResolve\(syncLock, resolveSyncCredsNow\)/);
    assert.match(sync, /finally \{\s*syncRunning = false;/);
    /* lockThenResolve 占 / 放的就是 syncRunning 这把锁 */
    assert.match(M, /const syncLock: RunLock = \{ get held\(\) \{ return syncRunning; \}, set held\(v: boolean\) \{ syncRunning = v; \} \};/);
    /* 每个 `await resolveSyncCredsNow()` 到下一个 ipcMain.handle / 顶层函数之间，不能再 loadSyncConfig() 拿 cfg */
    const parts = M.split('await resolveSyncCredsNow()').slice(1);
    assert.ok(parts.length >= 12, `入口数 ${parts.length}`);
    for (const p of parts) {
      const body = p.split(/\n {2}ipcMain\.handle\(|\n(?:async )?function /)[0];
      assert.equal(/const cfg = loadSyncConfig\(\)/.test(body), false, body.slice(0, 200));
    }
  });
});

/*
 * 审查意见：第一次取凭证成功、同步途中 S3 拒了旧 token（ExpiredToken → request() 调 creds.refresh），
 * 重取时 SSO 已过期 —— 这条路以前不更新 SSO 状态，设置页只有错误文字、没有「打开终端登录」。
 */
describe('途中重取凭证时 SSO 过期', () => {
  test('首次成功 → S3 拒旧 token → refresh 报 SSO 过期：回调拿到 { profile }，错误照样抛给操作', async () => {
    let n = 0;
    const { r } = fakeResolver({ cli: true, reply: () => (++n === 1
      ? { code: 0, stderr: '', stdout: JSON.stringify({ AccessKeyId: 'ASIA1', SecretAccessKey: 's', SessionToken: 't' }) }
      : { code: 255, stdout: '', stderr: 'Error when retrieving token from sso: Token has expired and refresh failed' }) });
    const seen: Array<{ profile?: string } | null> = [];
    const res = await resolveSyncCreds({ bucket: 'b', region: 'us-west-2', credentialSource: 'profile', awsProfile: 'dev-sso' },
      { decrypt: () => '', resolver: r, onRefreshSso: (v) => seen.push(v) });
    assert.equal(res.ssoLogin, undefined, '第一次是成功的');
    assert.ok(shouldRefreshCreds(400, '<Error><Code>ExpiredToken</Code></Error>'), 'S3 的 ExpiredToken 会走 refresh');
    await assert.rejects(res.creds!.refresh!('ASIA1'), (e: any) => e instanceof AwsCredsError && e.kind === 'sso-expired');
    assert.deepEqual(seen, [{ profile: 'dev-sso' }]);
  });

  test('默认凭证链同样报；重取成功时回调 null（清掉旧的过期状态）', async () => {
    let n = 0;
    const { r } = fakeResolver({ cli: true, reply: () => (++n === 2
      ? { code: 255, stdout: '', stderr: 'The SSO session associated with this profile has expired' }
      : { code: 0, stderr: '', stdout: JSON.stringify({ AccessKeyId: `ASIA${n}`, SecretAccessKey: 's' }) }) });
    const seen: Array<{ profile?: string } | null> = [];
    const res = await resolveSyncCreds({ bucket: 'b', region: 'r', credentialSource: 'default' }, { decrypt: () => '', resolver: r, onRefreshSso: (v) => seen.push(v) });
    await assert.rejects(res.creds!.refresh!('ASIA1'));
    assert.deepEqual(seen, [{ profile: undefined }]);
    assert.equal((await res.creds!.refresh!('ASIA1')).accessKeyId, 'ASIA3');
    assert.deepEqual(seen, [{ profile: undefined }, null]);
  });

  test('index.ts：途中的 SSO 过期写进 lastSsoExpired，设置页（s3:get-config）据此给 ssoLogin', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/main/index.ts'), 'utf8');
    const fn = M.slice(M.indexOf('async function resolveSyncCredsNow('), M.indexOf('let syncRunning'));
    assert.match(fn, /onRefreshSso: \(login\) => \{\s*lastSsoExpired = login;/);
    const gc = M.slice(M.indexOf("ipcMain.handle('s3:get-config'"), M.indexOf("ipcMain.handle('s3:save-config'"));
    assert.match(gc, /ssoLogin: credentialSourceOf\(cfg\) !== 'keys' \? lastSsoExpired : null/);
  });
});
