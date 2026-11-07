/**
 * SSM 机器默认不要私钥文件：连接前用 EC2 Instance Connect 推一把临时公钥（任务 698fb826）。
 *
 *   · 临时密钥在 `~/.kirolex/ssm-keys/<remoteId>/`，目录 0700、私钥 0600，12 小时内复用；
 *   · 每次**新建连接**（ProxyCommand 跑的时候）先 `aws ec2-instance-connect send-ssh-public-key`，
 *     成功了再 start-session；ssh 带 `-i <临时私钥> -o IdentitiesOnly=yes`，不带配置里的 identityFile；
 *   · `ssmUseOwnKey` = 老路径：不推公钥，用 identityFile；
 *   · AccessDenied 时说清缺 `ec2-instance-connect:SendSSHPublicKey`，给最小策略（实例 ARN + ec2:osuser）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  setSsmKeyRoot, ensureSsmKey, ssmKeyDir, transportArgs, identityArgs, usesSsmTempKey, ssmKeyPushFailure,
  generateEd25519, SSM_KEY_TTL_MS, setProxyFlavorOverride,
} from '../src/main/sshProxy.ts';
import { buildSshArgs } from '../src/main/acp-client.ts';
import { masterArgs, SshMux } from '../src/main/sshMux.ts';
import { ssmFailure, ssmPreflight, judgePreflight, type SsmRun } from '../src/main/remotePreflight.ts';
import { saveRemoteTarget, parseRemoteTargets, ssmFieldsOf } from '../src/main/remoteTargets.ts';
import { setUiLang } from '../src/main/uiText.ts';

setUiLang('en');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-keys-'));
setSsmKeyRoot(ROOT);
/* 这一份测的是 POSIX（sh 跑 ProxyCommand）那一支；Win32-OpenSSH 那一支在 sshSsmWin32.test.ts */
setProxyFlavorOverride('posix');

const ID = 'i-0123456789abcdef0';
const SSM = {
  id: 'tokyo-ec2',
  sshHost: `ec2-user@${ID}`,
  identityFile: '/Users/me/k.pem',
  connectVia: 'ssm' as const,
  ssmInstanceId: ID,
  ssmRegion: 'ap-northeast-1',
  ssmProfile: 'work',
};
const proxyOf = (args: string[]): string => args.find((a) => String(a).startsWith('ProxyCommand=')) || '';
const POSIX = { skip: process.platform === 'win32' && 'Windows 上 chmod 只认只读位，权限位只在 POSIX 上有意义' };

test('临时公钥模式：ssh 参数带 -i <~/.kirolex/ssm-keys/...> 和 IdentitiesOnly=yes，不带配置里的 identityFile', () => {
  for (const args of [
    buildSshArgs(SSM as any, 'true', { remotePort: 39100, localPort: 5000 }),
    masterArgs({ ...SSM, socket: '/tmp/s', remotePort: 0, localPort: 5000 }),
  ]) {
    const key = args[args.indexOf('-i') + 1];
    assert.ok(key.startsWith(path.join(ROOT, 'tokyo-ec2') + path.sep), `私钥在 ssm-keys/<remoteId>/ 下：${key}`);
    assert.ok(args.includes('IdentitiesOnly=yes'));
    assert.equal(args.includes('/Users/me/k.pem'), false, '不用用户配置里的私钥');
    assert.equal(args.filter((a) => a === '-i').length, 1);
  }
});

test('建立主连接之前先推公钥：ProxyCommand 里 send-ssh-public-key 在 start-session 之前，参数带 instance-id / os-user / region / profile', () => {
  const args = masterArgs({ ...SSM, sshHost: `ubuntu@${ID}`, socket: '/tmp/s', remotePort: 0, localPort: 5000 });
  const proxy = proxyOf(args);
  const push = proxy.indexOf('ec2-instance-connect');
  assert.ok(push > 0, proxy);
  assert.ok(push < proxy.indexOf('ssm\' \'start-session') || push < proxy.indexOf('ssm start-session'), '推送在 start-session 之前');
  const pushPart = proxy.slice(push, proxy.indexOf('&& exec'));
  for (const s of ["'send-ssh-public-key'", `'--instance-id' '${ID}'`, "'--instance-os-user' 'ubuntu'", "'--region' 'ap-northeast-1'", "'--profile' 'work'"]) {
    assert.ok(pushPart.includes(s), `缺 ${s}：${pushPart}`);
  }
  /* 推的是同一把临时密钥的公钥；JSON 输出不能进 ssh 的传输通道 */
  const pub = fs.readFileSync(`${args[args.indexOf('-i') + 1]}.pub`, 'utf8').trim();
  assert.ok(pushPart.includes(`'--ssh-public-key' '${pub}'`));
  assert.match(pushPart, />\/dev\/null $/);
  assert.match(proxy, /&& exec .*ssm start-session --target i-0123456789abcdef0 --document-name AWS-StartSSHSession .*--profile work$/);
});

test('ProxyCommand 真的按顺序跑：先推公钥（成功才继续），再 start-session；推送失败就不连', { skip: !fs.existsSync('/bin/sh') && process.platform !== 'win32' && 'no /bin/sh' }, () => {
  const sh = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (sh.status !== 0) return;   // 没有 sh 的环境（ssh 本来也是用 sh 跑 ProxyCommand 的）
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-aws-'));
  const log = path.join(bin, 'calls.log').replace(/\\/g, '/');
  const aws = path.join(bin, 'aws');
  fs.writeFileSync(aws, `#!/bin/sh\necho "$1 $2" >> '${log}'\nif [ "$1" = ec2-instance-connect ]; then echo '{"Success": true}'; exit \${FAIL_PUSH:-0}; fi\necho TRANSPORT\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const proxy = proxyOf(transportArgs(SSM)).slice('ProxyCommand='.length);
    /* ssh 的跑法：$SHELL -c "exec <ProxyCommand>" */
    const ok = spawnSync('sh', ['-c', `exec ${proxy}`], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'TRANSPORT\n', 'stdout 只有传输层的字节（推送的 JSON 丢掉了）');
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['ec2-instance-connect send-ssh-public-key', 'ssm start-session']);
    fs.rmSync(log);
    const bad = spawnSync('sh', ['-c', `exec ${proxy}`], { encoding: 'utf8', env: { ...process.env, FAIL_PUSH: '1' } });
    assert.notEqual(bad.status, 0);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['ec2-instance-connect send-ssh-public-key'], '推送失败就不 start-session');
  } finally {
    process.env.PATH = oldPath;
  }
});

test('改用自己的私钥：不推公钥，用 identityFile（老路径）', () => {
  const own = { ...SSM, ssmUseOwnKey: true };
  assert.equal(usesSsmTempKey(own), false);
  const args = buildSshArgs(own as any, 'true');
  assert.equal(args[args.indexOf('-i') + 1], '/Users/me/k.pem');
  assert.equal(args.includes('IdentitiesOnly=yes'), false);
  assert.doesNotMatch(proxyOf(args), /ec2-instance-connect|send-ssh-public-key/);
  assert.match(proxyOf(masterArgs({ ...own, socket: '/tmp/s', localPort: 5000 })), /^ProxyCommand='[^']*' ssm start-session/);
});

test('mi- 托管实例推不了临时公钥：没勾「改用自己的私钥」就拒绝连接、说清楚，不静默用配置里的旧私钥', async () => {
  const mi = { ...SSM, ssmInstanceId: 'mi-0123456789abcdef0', sshHost: 'ec2-user@mi-0123456789abcdef0' };
  assert.equal(usesSsmTempKey(mi), false);
  const refused = (err: any): boolean => /managed instance/.test(err.message) && /Use my own private key/.test(err.message);
  assert.throws(() => buildSshArgs(mi as any, 'true'), refused);
  assert.throws(() => masterArgs({ ...mi, socket: '/tmp/s', localPort: 5000 }), refused);
  assert.throws(() => identityArgs(mi), refused);
  assert.throws(() => transportArgs(mi), refused);
  /* 「测试连接」也先说这句，不往下跑 aws */
  const calls: string[][] = [];
  const v = await ssmPreflight(mi as any, { aws: '/a', plugin: '/p' }, async (_f, a) => { calls.push(a); return { code: 0, stdout: '', stderr: '' }; });
  assert.equal(v!.code, 'unreachable');
  assert.ok(refused({ message: v!.message }));
  assert.deepEqual(calls, []);
  /* 勾了才用自己的私钥 */
  const args = buildSshArgs({ ...mi, ssmUseOwnKey: true } as any, 'true');
  assert.equal(args[args.indexOf('-i') + 1], '/Users/me/k.pem');
  assert.doesNotMatch(proxyOf(args), /send-ssh-public-key/);
});

test('SSH 模式（直连 IP）不受影响', () => {
  const ssh = { sshHost: 'ec2-user@1.2.3.4', identityFile: '/k.pem' };
  assert.deepEqual(identityArgs(ssh), ['-i', '/k.pem']);
  assert.deepEqual(transportArgs(ssh), []);
  assert.equal(usesSsmTempKey({ ...ssh, ssmUseOwnKey: false } as any), false);
});

test('临时密钥：目录 0700、私钥 0600', POSIX, () => {
  const k = ensureSsmKey({ ...SSM, id: 'perm-check' });
  assert.equal(fs.statSync(k.privateKey).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(k.privateKey)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(ROOT).mode & 0o777, 0o700);
});

test('临时密钥：12 小时内复用同一把（重启后也接着用盘上的），过期换一把，旧文件不原地覆盖', () => {
  setSsmKeyRoot(ROOT);   // 清内存缓存
  const r = { ...SSM, id: 'reuse' };
  const t0 = 1_800_000_000_000;
  const a = ensureSsmKey(r, t0);
  assert.equal(ensureSsmKey(r, t0 + 60_000).privateKey, a.privateKey);
  setSsmKeyRoot(ROOT);   // 模拟重启：内存缓存没了
  assert.equal(ensureSsmKey(r, t0 + 3600_000).privateKey, a.privateKey);
  const b = ensureSsmKey(r, t0 + SSM_KEY_TTL_MS + 1);
  assert.notEqual(b.privateKey, a.privateKey);
  assert.notEqual(b.publicKey, a.publicKey);
  assert.ok(fs.existsSync(a.privateKey), '旧的那把还在（正在建的连接可能还要读它）');
  ensureSsmKey({ ...r, id: 'reuse' }, t0 + 3 * SSM_KEY_TTL_MS);
  assert.equal(fs.existsSync(a.privateKey), false, '过了两个周期删掉');
  assert.equal(path.dirname(a.privateKey), ssmKeyDir(r));
  /* 会话里的老快照没有 id：按实例 ID 分目录 */
  assert.equal(path.basename(ssmKeyDir({ ...SSM, id: undefined })), ID);
});

test('生成的私钥是 ssh 认得的 OpenSSH 格式（ssh-keygen -y 推得出同一把公钥）', { skip: spawnSync('ssh-keygen', ['-?']).error ? 'no ssh-keygen' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-'));
  const { pem, pub } = generateEd25519();
  const f = path.join(dir, 'k');
  fs.writeFileSync(f, pem, { mode: 0o600 });
  const derived = execFileSync('ssh-keygen', ['-y', '-f', f], { encoding: 'utf8' }).trim();
  assert.equal(derived.split(' ').slice(0, 2).join(' '), pub.split(' ').slice(0, 2).join(' '));
  assert.match(pub, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA\S+ kirolex-ssm$/);
});

/* ---------------------------------------------------------------- 报错 */

const DENIED = 'An error occurred (AccessDeniedException) when calling the SendSSHPublicKey operation: User: arn:aws:sts::123456789012:assumed-role/dev/me is not authorized to perform: ec2-instance-connect:SendSSHPublicKey on resource: arn:aws:ec2:ap-northeast-1:123456789012:instance/i-0123456789abcdef0 because no identity-based policy allows the ec2-instance-connect:SendSSHPublicKey action';

test('AccessDenied：说清缺 ec2-instance-connect:SendSSHPublicKey，最小策略是这台实例的 ARN + ec2:osuser，另给「改用自己的私钥」', () => {
  const f = ssmKeyPushFailure(DENIED, { ...SSM, sshHost: `ubuntu@${ID}` })!;
  assert.match(f.why, /ec2-instance-connect:SendSSHPublicKey/);
  const policy = JSON.parse(/\{.*\}/.exec(f.hint)![0]);
  assert.deepEqual(policy, {
    Effect: 'Allow',
    Action: 'ec2-instance-connect:SendSSHPublicKey',
    Resource: 'arn:aws:ec2:ap-northeast-1:123456789012:instance/i-0123456789abcdef0',
    Condition: { StringEquals: { 'ec2:osuser': 'ubuntu' } },
  });
  assert.match(f.hint, /Use my own private key/);
  /* 报错里没有资源 ARN、只有身份：账号从身份里认 */
  const short = ssmKeyPushFailure('An error occurred (AccessDeniedException) when calling the SendSSHPublicKey operation: User: arn:aws:iam::210987654321:user/x is not authorized', SSM)!;
  assert.match(short.hint, /arn:aws:ec2:ap-northeast-1:210987654321:instance\/i-0123456789abcdef0/);
  /* 认不出账号时用 * */
  assert.match(ssmKeyPushFailure('An error occurred (AccessDeniedException) when calling the SendSSHPublicKey operation: denied', SSM)!.hint, /arn:aws:ec2:ap-northeast-1:\*:instance\/i-0123456789abcdef0/);
  /* 不是推送那一步的 AccessDenied（StartSession）照旧 */
  assert.equal(ssmKeyPushFailure('An error occurred (AccessDeniedException) when calling the StartSession operation', SSM), null);
  assert.match(ssmFailure('An error occurred (AccessDeniedException) when calling the StartSession operation', SSM)!.why, /ssm:StartSession/);
});

test('真连接时推送失败（ProxyCommand 的 stderr 落在 ssh 里）：预检的话也说清楚', () => {
  const v = judgePreflight(255, '', `${DENIED}\nConnection closed by UNKNOWN port 65535`, SSM as any);
  assert.equal(v.code, 'unreachable');
  assert.match(v.message, /ec2-instance-connect:SendSSHPublicKey/);
  assert.match(v.message, /arn:aws:ec2:ap-northeast-1:123456789012:instance\/i-0123456789abcdef0/);
});

function fakeRun(table: Record<string, { code: number; stdout?: string; stderr?: string }>, calls: string[][] = []): SsmRun {
  return async (_file, args) => {
    calls.push(args);
    const r = table[args[0]] || { code: 0 };
    return { code: r.code, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}
const TOOLS = { aws: '/usr/local/bin/aws', plugin: '/usr/local/bin/session-manager-plugin' };
const ONLINE = JSON.stringify({ InstanceInformationList: [{ InstanceId: ID, PingStatus: 'Online' }] });

test('「测试连接」也检查推公钥这一步：参数里有 instance-id / os-user / region / profile', async () => {
  const calls: string[][] = [];
  assert.equal(await ssmPreflight(SSM as any, TOOLS, fakeRun({ ssm: { code: 0, stdout: ONLINE } }, calls)), null);
  const push = calls.find((c) => c[0] === 'ec2-instance-connect')!;
  assert.ok(push, '调了 send-ssh-public-key');
  assert.deepEqual(push.slice(0, 6), ['ec2-instance-connect', 'send-ssh-public-key', '--instance-id', ID, '--instance-os-user', 'ec2-user']);
  assert.deepEqual(push.slice(-4), ['--region', 'ap-northeast-1', '--profile', 'work']);
  assert.match(push[push.indexOf('--ssh-public-key') + 1], /^ssh-ed25519 /);
  /* 没有 describe 权限照样要查这一步 */
  const c2: string[][] = [];
  await ssmPreflight(SSM as any, TOOLS, fakeRun({ ssm: { code: 254, stderr: 'AccessDeniedException ... DescribeInstanceInformation' } }, c2));
  assert.ok(c2.some((c) => c[0] === 'ec2-instance-connect'));
});

test('「测试连接」：推送 AccessDenied → 信息里有 ec2-instance-connect:SendSSHPublicKey 和实例 ARN', async () => {
  const v = await ssmPreflight(SSM as any, TOOLS, fakeRun({ ssm: { code: 0, stdout: ONLINE }, 'ec2-instance-connect': { code: 254, stderr: DENIED } }));
  assert.equal(v!.code, 'unreachable');
  assert.match(v!.message, /ec2-instance-connect:SendSSHPublicKey/);
  assert.match(v!.message, /arn:aws:ec2:ap-northeast-1:123456789012:instance\/i-0123456789abcdef0/);
  assert.match(v!.message, /"ec2:osuser":"ec2-user"/);
  assert.match(v!.message, /Use my own private key/);
});

test('「测试连接」：改用自己的私钥时不调 send-ssh-public-key', async () => {
  const calls: string[][] = [];
  assert.equal(await ssmPreflight({ ...SSM, ssmUseOwnKey: true } as any, TOOLS, fakeRun({ ssm: { code: 0, stdout: ONLINE } }, calls)), null);
  assert.equal(calls.some((c) => c[0] === 'ec2-instance-connect'), false);
});

test('主连接建不起来、原因是推送被拒：错误信息翻成人话', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muxkey-'));
  const spawned: string[][] = [];
  const mux = new SshMux({
    log: () => {},
    localPort: () => 5000,
    owner: 'test',
    hasSessions: () => false,
    spawnSsh: (a: string[]) => {
      spawned.push(a);
      const p: any = new EventEmitter();
      p.killed = false; p.exitCode = null;
      p.stderr = new EventEmitter();
      p.kill = () => { p.killed = true; };
      setImmediate(() => { p.stderr.emit('data', Buffer.from(`${DENIED}\n`)); p.exitCode = 255; p.emit('exit', 255); });
      return p;
    },
    probeSocket: async () => false,
    platform: 'linux',
    healBackoffMs: [10_000_000],
  } as any, dir);
  await assert.rejects(mux.ensure(SSM), (err: any) => {
    assert.match(err.message, /ec2-instance-connect:SendSSHPublicKey/);
    assert.match(err.message, /arn:aws:ec2:ap-northeast-1:123456789012:instance\/i-0123456789abcdef0/);
    return true;
  });
  assert.match(proxyOf(spawned[0]), /send-ssh-public-key/, 'master 的 ProxyCommand 带推送');
  mux.closeAll?.();
});

/* ---------------------------------------------------------------- 配置 */

test('老 SSM 配置里的 identityFile 保留，缺省走临时公钥；ssmUseOwnKey 能存能读', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssmcfg-'));
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ remotes: [{ id: 'tokyo-ec2', label: 'tokyo-ec2', sshHost: `ec2-user@${ID}`, identityFile: '~/k.pem', connectVia: 'ssm', ssmInstanceId: ID, ssmRegion: 'ap-northeast-1' }] }));
  const [t] = parseRemoteTargets(JSON.parse(fs.readFileSync(cfg, 'utf8')), '/home/me');
  assert.equal(t.identityFile, path.join('/home/me', 'k.pem'));
  assert.equal(t.ssmUseOwnKey, undefined);
  assert.equal(usesSsmTempKey(t), true);
  /* 改别的字段：identityFile 不被抹掉，ssmUseOwnKey 不写进文件 */
  saveRemoteTarget(cfg, { id: 'tokyo-ec2', sshHost: `ec2-user@${ID}`, label: 'renamed' });
  let row = JSON.parse(fs.readFileSync(cfg, 'utf8')).remotes[0];
  assert.equal(row.identityFile, '~/k.pem');
  assert.equal('ssmUseOwnKey' in row, false);
  saveRemoteTarget(cfg, { id: 'tokyo-ec2', sshHost: `ec2-user@${ID}`, ssmUseOwnKey: true });
  row = JSON.parse(fs.readFileSync(cfg, 'utf8')).remotes[0];
  assert.equal(row.ssmUseOwnKey, true);
  assert.equal(parseRemoteTargets(JSON.parse(fs.readFileSync(cfg, 'utf8')))[0].ssmUseOwnKey, true);
  saveRemoteTarget(cfg, { id: 'tokyo-ec2', sshHost: `ec2-user@${ID}`, ssmUseOwnKey: false });
  row = JSON.parse(fs.readFileSync(cfg, 'utf8')).remotes[0];
  assert.equal('ssmUseOwnKey' in row, false);
  assert.equal(row.identityFile, '~/k.pem');
  /* 临时私钥不进 config.json */
  assert.doesNotMatch(fs.readFileSync(cfg, 'utf8'), /OPENSSH PRIVATE KEY|ssm-keys/);
  assert.deepEqual(ssmFieldsOf({ connectVia: 'ssm', ssmInstanceId: ID, ssmRegion: 'ap-northeast-1', ssmUseOwnKey: true, sshHost: '' }).ssmUseOwnKey, true);
});
