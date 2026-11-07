/**
 * 「通过 AWS SSM 连接」：SSH over SSM（ProxyCommand = aws ssm start-session AWS-StartSSHSession）。
 * 只换传输层 —— ControlMaster、`-R` 反向隧道、ACP 全都照旧；直连那条路一个字节都不变。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ssmProxyCommand, transportArgs, findLocalTool, ssmFieldError, setSsmKeyRoot, setProxyFlavorOverride } from '../src/main/sshProxy.ts';
import { buildSshArgs } from '../src/main/acp-client.ts';
import { masterArgs } from '../src/main/sshMux.ts';
import { validateTarget, saveRemoteTarget, parseRemoteTargets } from '../src/main/remoteTargets.ts';
import { ssmFailure, ssmPreflight, ssmPingStatus, judgePreflight, type SsmRun } from '../src/main/remotePreflight.ts';
import { setUiLang } from '../src/main/uiText.ts';

setUiLang('en');
/* SSM 默认推临时公钥，会生成密钥 —— 放进临时目录，不碰真的 ~/.kirolex */
setSsmKeyRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-keys-')));
/* 这一份测的是 POSIX（sh 跑 ProxyCommand）那一支；Win32-OpenSSH 那一支在 sshSsmWin32.test.ts */
setProxyFlavorOverride('posix');

const SSM = {
  sshHost: 'ec2-user@i-0123456789abcdef0',
  identityFile: '/k.pem',
  connectVia: 'ssm' as const,
  ssmInstanceId: 'i-0123456789abcdef0',
  ssmRegion: 'ap-northeast-1',
};

test('ssmProxyCommand：不带 profile', () => {
  assert.equal(
    ssmProxyCommand(SSM, { aws: '/usr/local/bin/aws' }),
    "'/usr/local/bin/aws' ssm start-session --target i-0123456789abcdef0 --document-name AWS-StartSSHSession --parameters portNumber=22 --region ap-northeast-1",
  );
});

test('ssmProxyCommand：带 profile、非 22 端口', () => {
  assert.equal(
    ssmProxyCommand({ ...SSM, ssmProfile: 'work.dev', sshPort: 2222 }, { aws: '/opt/homebrew/bin/aws' }),
    "'/opt/homebrew/bin/aws' ssm start-session --target i-0123456789abcdef0 --document-name AWS-StartSSHSession --parameters portNumber=2222 --region ap-northeast-1 --profile work.dev",
  );
});

test('ssmProxyCommand：aws 路径里有空格 / 单引号时引号正确', () => {
  const c = ssmProxyCommand(SSM, { aws: "/Users/me/My Tools/it's/aws" });
  assert.ok(c.startsWith("'/Users/me/My Tools/it'\\''s/aws' ssm start-session "), c);
});

test('ssmProxyCommand：插件目录不在 PATH 上时用 env 补上（ssh 是 exec 它的）', () => {
  const c = ssmProxyCommand(SSM, { aws: '/usr/local/bin/aws', pluginDir: '/usr/local/bin' });
  assert.ok(c.startsWith(`env PATH='/usr/local/bin':"$PATH" '/usr/local/bin/aws' ssm `), c);
});

test('ssmProxyCommand：字段不合法直接抛，不退回直连', () => {
  assert.throws(() => ssmProxyCommand({ ...SSM, ssmInstanceId: 'i-1;id' }, { aws: '/a' }));
  assert.throws(() => ssmProxyCommand({ ...SSM, ssmRegion: 'us-east-1;id' }, { aws: '/a' }));
  assert.throws(() => ssmProxyCommand({ ...SSM, ssmProfile: 'p$(id)' }, { aws: '/a' }));
});

test('findLocalTool：PATH 里没有时试 /usr/local/bin、/opt/homebrew/bin', () => {
  const have = new Set(['/opt/homebrew/bin/aws']);
  assert.equal(findLocalTool('aws', { PATH: '/usr/bin:/bin' }, (p) => have.has(p), 'darwin'), '/opt/homebrew/bin/aws');
  have.add('/usr/bin/aws');
  assert.equal(findLocalTool('aws', { PATH: '/usr/bin:/bin' }, (p) => have.has(p), 'darwin'), '/usr/bin/aws');
  assert.equal(findLocalTool('aws', { PATH: '' }, () => false, 'darwin'), undefined);
});

test('validateTarget：注入拒绝（instance-id / region / profile 里带 ; $( 反引号 空格）', () => {
  for (const bad of [';id', '$(id)', '`id`', ' x']) {
    assert.ok(validateTarget({ ...SSM, ssmInstanceId: `i-0123456789abcdef0${bad}`, sshHost: `ec2-user@i-0123456789abcdef0${bad}` }), `instance-id 漏了 ${bad}`);
    assert.ok(validateTarget({ ...SSM, ssmRegion: `us-east-1${bad}` }), `region 漏了 ${bad}`);
    assert.ok(validateTarget({ ...SSM, ssmProfile: `p${bad}` }), `profile 漏了 ${bad}`);
  }
  assert.ok(validateTarget({ ...SSM, ssmInstanceId: 'i-123' }), '太短的 id');
  assert.ok(validateTarget({ ...SSM, ssmInstanceId: 'I-0123456789ABCDEF0' }), '大写不认');
  assert.ok(validateTarget({ ...SSM, ssmRegion: '' }), 'region 必填');
});

test('validateTarget：正常的 SSM 配置能过', () => {
  assert.equal(validateTarget(SSM), null);
  assert.equal(validateTarget({ ...SSM, ssmProfile: 'my_prof-1.x+y' }), null);
  assert.equal(validateTarget({ ...SSM, ssmInstanceId: 'mi-0123456789abcdef0', sshHost: 'ubuntu@mi-0123456789abcdef0' }), null);
  assert.equal(validateTarget({ ...SSM, ssmRegion: 'us-gov-west-1' }), null);
});

test('validateTarget：跳板和 SSM 不能同时设；sshHost 必须是 user@<instance-id>', () => {
  assert.ok(validateTarget({ ...SSM, proxyJump: 'ec2-user@1.2.3.4' }));
  assert.ok(validateTarget({ ...SSM, sshHost: 'ec2-user@1.2.3.4' }));
  assert.ok(validateTarget({ ...SSM, sshHost: 'i-0123456789abcdef0' }));
  assert.ok(validateTarget({ ...SSM, connectVia: 'telnet' as any }));
});

test('saveRemoteTarget：只给了 proxyJump 也不能和已存的 SSM 拼在一起', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-')), 'config.json');
  const saved = saveRemoteTarget(f, { ...SSM, id: 'a' });
  assert.equal(saved.connectVia, 'ssm');
  assert.equal(saved.ssmInstanceId, SSM.ssmInstanceId);
  assert.throws(() => saveRemoteTarget(f, { id: 'a', sshHost: SSM.sshHost, proxyJump: 'u@h' }));
  /* 切回 ssh：connectVia 不写进文件 */
  saveRemoteTarget(f, { id: 'a', sshHost: 'ec2-user@1.2.3.4', connectVia: 'ssh' });
  const raw = JSON.parse(fs.readFileSync(f, 'utf8')).remotes[0];
  assert.equal('connectVia' in raw, false);
});

test('parseRemoteTargets：老配置读出来的形状一个键都不多', () => {
  const [t] = parseRemoteTargets({ remotes: [{ id: 'x', sshHost: 'u@h' }] });
  for (const k of ['connectVia', 'ssmInstanceId', 'ssmRegion', 'ssmProfile']) assert.equal(k in t, false, k);
  const [s] = parseRemoteTargets({ remotes: [{ id: 'y', ...SSM, ssmProfile: 'p' }] });
  assert.equal(s.connectVia, 'ssm');
  assert.equal(s.ssmProfile, 'p');
});

test('回归：connectVia 缺省 / ssh 时 ssh 参数与原来逐字相同', () => {
  const base = { sshHost: 'ec2-user@1.2.3.4', identityFile: '/k.pem', sshPort: 2222 };
  const expected = [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ExitOnForwardFailure=yes', '-R', '127.0.0.1:39100:127.0.0.1:5000',
    '-i', '/k.pem', '-p', '2222', 'ec2-user@1.2.3.4', 'true',
  ];
  assert.deepEqual(buildSshArgs(base as any, 'true', { remotePort: 39100, localPort: 5000 }), expected);
  assert.deepEqual(buildSshArgs({ ...base, connectVia: 'ssh' } as any, 'true', { remotePort: 39100, localPort: 5000 }), expected);
  assert.deepEqual(transportArgs({ ...base, connectVia: 'ssh' }), []);
  const m = masterArgs({ ...base, socket: '/tmp/s', localPort: 5000 });
  assert.deepEqual(m, [
    '-N', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=INFO', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no', '-o', 'ControlPath=/tmp/s', '-R', '127.0.0.1:0:127.0.0.1:5000',
    '-i', '/k.pem', '-p', '2222', 'ec2-user@1.2.3.4',
  ]);
});

const proxyOf = (args: string[]) => args.find((a) => String(a).startsWith('ProxyCommand='));

test('buildSshArgs（SSM）：带 ProxyCommand + HostKeyAlias，仍带 -R 反向隧道，ConnectTimeout 30', () => {
  const args = buildSshArgs(SSM as any, 'true', { remotePort: 39100, localPort: 5000 });
  assert.match(proxyOf(args) || '', /^ProxyCommand=.*ssm start-session --target i-0123456789abcdef0 --document-name AWS-StartSSHSession --parameters portNumber=22 --region ap-northeast-1$/);
  assert.ok(args.includes('HostKeyAlias=i-0123456789abcdef0'));
  assert.ok(args.includes('ConnectTimeout=30'));
  assert.equal(args[args.indexOf('-R') + 1], '127.0.0.1:39100:127.0.0.1:5000');
  assert.ok(args.includes('-i'));
  assert.ok(args.indexOf(proxyOf(args)!) < args.indexOf(SSM.sshHost), 'ProxyCommand 要在 host 之前');
});

test('sshMux master（SSM）：带 ProxyCommand + HostKeyAlias，仍带 -R 反向隧道', () => {
  const args = masterArgs({ ...SSM, socket: '/tmp/s', remotePort: 0, localPort: 5000 });
  assert.match(proxyOf(args) || '', /ssm start-session --target i-0123456789abcdef0 --document-name AWS-StartSSHSession/);
  assert.ok(args.includes('HostKeyAlias=i-0123456789abcdef0'));
  assert.ok(args.includes('ConnectTimeout=30'));
  assert.equal(args[args.indexOf('-R') + 1], '127.0.0.1:0:127.0.0.1:5000');
  assert.equal(args[args.length - 1], SSM.sshHost);
});

test('ssmFieldError：白名单本身', () => {
  assert.equal(ssmFieldError(SSM), null);
  assert.ok(ssmFieldError({ ...SSM, ssmProfile: 'x'.repeat(65) }));
});

/* ------------------------------------------------------------- 预检 / 报错翻译 */

test('ssmFailure：常见错误翻译成人话', () => {
  const tnc = ssmFailure('An error occurred (TargetNotConnected) when calling the StartSession operation: i-0123456789abcdef0 is not connected.', SSM);
  assert.match(tnc!.why, /not connected to SSM/);
  assert.match(tnc!.hint, /AmazonSSMManagedInstanceCore/);

  const ad = ssmFailure('An error occurred (AccessDeniedException) when calling the StartSession operation: User: arn:aws:iam::1:user/x is not authorized to perform: ssm:StartSession', SSM);
  assert.match(ad!.why, /ssm:StartSession/);
  assert.match(ad!.hint, /arn:aws:ec2:ap-northeast-1:\*:instance\/i-0123456789abcdef0/);
  assert.match(ad!.hint, /arn:aws:ssm:\*:\*:document\/AWS-StartSSHSession/);

  const plug = ssmFailure('\nSessionManagerPlugin is not found. Please refer to SessionManager Documentation here: http://docs.aws.amazon.com/console/systems-manager/session-manager-plugin-not-found\n', SSM);
  assert.match(plug!.why, /session-manager-plugin/);

  const exp = ssmFailure('An error occurred (ExpiredTokenException) when calling the StartSession operation: The security token included in the request is expired', { ...SSM, ssmProfile: 'work' });
  assert.match(exp!.why, /expired/);
  assert.match(exp!.hint, /aws sso login --profile work/);

  assert.equal(ssmFailure('kex_exchange_identification: Connection closed by remote host', SSM), null);
});

test('judgePreflight：SSM 机器 ssh 失败时先认 SSM 的报错', () => {
  const v = judgePreflight(255, '', 'An error occurred (TargetNotConnected) when calling the StartSession operation\nConnection closed by UNKNOWN port 65535', SSM as any);
  assert.equal(v.code, 'unreachable');
  assert.match(v.message, /not connected to SSM/);
  /* 直连机器不受影响 */
  const d = judgePreflight(255, '', 'An error occurred (TargetNotConnected)', { sshHost: 'u@h' } as any);
  assert.doesNotMatch(d.message, /SSM/);
});

function fakeRun(table: Record<string, { code: number; stdout?: string; stderr?: string }>, calls: string[][] = []): SsmRun {
  return async (_file, args) => {
    calls.push(args);
    const r = table[args[0]] || { code: 0 };
    return { code: r.code, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}
const TOOLS = { aws: '/usr/local/bin/aws', plugin: '/usr/local/bin/session-manager-plugin' };
const ONLINE = JSON.stringify({ InstanceInformationList: [{ InstanceId: SSM.ssmInstanceId, PingStatus: 'Online' }] });

test('ssmPreflight：本机没装 aws / plugin', async () => {
  assert.match((await ssmPreflight(SSM as any, {}, fakeRun({})))!.message, /AWS CLI/);
  assert.match((await ssmPreflight(SSM as any, { aws: '/a' }, fakeRun({})))!.message, /session-manager-plugin/);
});

test('ssmPreflight：凭证过期 → 提示重新登录', async () => {
  const v = await ssmPreflight(SSM as any, TOOLS, fakeRun({ sts: { code: 255, stderr: 'An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired' } }));
  assert.equal(v!.code, 'unreachable');
  assert.match(v!.message, /expired/);
  assert.match(v!.message, /aws sso login/);
});

test('ssmPreflight：没有凭证', async () => {
  const v = await ssmPreflight(SSM as any, TOOLS, fakeRun({ sts: { code: 255, stderr: 'Unable to locate credentials. You can configure credentials by running "aws configure".' } }));
  assert.match(v!.message, /aws configure/);
});

test('ssmPreflight：实例不在线 / 没注册', async () => {
  const off = await ssmPreflight(SSM as any, TOOLS, fakeRun({ ssm: { code: 0, stdout: JSON.stringify({ InstanceInformationList: [{ PingStatus: 'ConnectionLost' }] }) } }));
  assert.match(off!.message, /ConnectionLost/);
  assert.match(off!.message, /SSM Agent/);
  const none = await ssmPreflight(SSM as any, TOOLS, fakeRun({ ssm: { code: 0, stdout: '{"InstanceInformationList":[]}' } }));
  assert.match(none!.message, /not registered in SSM in ap-northeast-1/);
});

test('ssmPreflight：都过了返回 null；参数里带 region / profile / filter', async () => {
  const calls: string[][] = [];
  assert.equal(await ssmPreflight({ ...SSM, ssmProfile: 'work' } as any, TOOLS, fakeRun({ ssm: { code: 0, stdout: ONLINE } }, calls)), null);
  assert.deepEqual(calls[0], ['sts', 'get-caller-identity', '--region', 'ap-northeast-1', '--profile', 'work', '--output', 'json']);
  assert.deepEqual(calls[1], ['ssm', 'describe-instance-information', '--filters', 'Key=InstanceIds,Values=i-0123456789abcdef0', '--region', 'ap-northeast-1', '--profile', 'work', '--output', 'json']);
});

test('ssmPreflight：没有 describe 权限不拦（最小权限只有 StartSession）', async () => {
  assert.equal(await ssmPreflight(SSM as any, TOOLS, fakeRun({ ssm: { code: 254, stderr: 'An error occurred (AccessDeniedException) when calling the DescribeInstanceInformation operation: not authorized to perform: ssm:DescribeInstanceInformation' } })), null);
});

test('ssmPingStatus', () => {
  assert.equal(ssmPingStatus(ONLINE), 'Online');
  assert.equal(ssmPingStatus('not json'), undefined);
});
