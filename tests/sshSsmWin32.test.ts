/**
 * **Windows 自带 ssh（Win32-OpenSSH）上 SSM 连接起不来** —— `CreateProcessW failed error:2`（KYN-DESKTOP 实测）。
 *
 * Win32-OpenSSH 不经 shell、直接 CreateProcessW 执行 ProxyCommand，POSIX 写法（`9>/dev/null;`、单引号、
 * `exec`、`env PATH=…`）第一个 token 就找不到。win32 分支改成
 * `C:\Windows\System32\cmd.exe /d /s /c ""<aws>" ec2-instance-connect … --ssh-public-key "file://<pub>" … >NUL && "<aws>" ssm start-session …"`。
 * ProxyCommand 选哪种语法按**实际选中的 ssh** 判断（PATH 里第一个 ssh.exe 旁边有没有 sh.exe），不只看平台。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  setSsmKeyRoot, setProxyFlavorOverride, sshFlavor, winProxyCommand, winCmdPath, ssmProxyCommand, transportArgs,
  findLocalTool, ensureSsmKey, pluginDirIfOffPath, localToolSpawn, runLocalTool,
} from '../src/main/sshProxy.ts';
import { buildSshArgs } from '../src/main/acp-client.ts';
import { ssmPreflight } from '../src/main/remotePreflight.ts';
import { setUiLang } from '../src/main/uiText.ts';

setUiLang('en');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-keys-'));
setSsmKeyRoot(ROOT);

const ID = 'i-03b396ce3b8546b90';
const SSM = {
  id: 'aws-tokyo-4',
  sshHost: `ec2-user@${ID}`,
  connectVia: 'ssm' as const,
  ssmInstanceId: ID,
  ssmRegion: 'ap-northeast-1',
  ssmProfile: 'kyn',
};
const proxyOf = (args: string[]): string => (args.find((a) => String(a).startsWith('ProxyCommand=')) || '').slice('ProxyCommand='.length);
const CMD = winCmdPath();
const AWS = 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe';

/** 把 ssh 的 `%%` 还原成 `%`（ssh 交给 CreateProcessW 的就是这个）。 */
const sshExpand = (s: string): string => s.replace(/%%/g, '%');

test('判断用哪种语法：PATH 里第一个 ssh.exe 是 System32\\OpenSSH → win32；Git 的 usr\\bin（旁边有 sh.exe）→ posix', () => {
  const files = new Set([
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    'C:\\Program Files\\Git\\usr\\bin\\ssh.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
  ]);
  const has = (p: string): boolean => files.has(p);
  assert.equal(sshFlavor({ PATH: 'C:\\Windows\\System32\\OpenSSH\\;C:\\Program Files\\Git\\usr\\bin' }, has, 'win32'), 'win32');
  assert.equal(sshFlavor({ Path: 'C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32\\OpenSSH' }, has, 'win32'), 'posix');
  assert.equal(sshFlavor({ PATH: 'C:\\nothing' }, has, 'win32'), 'win32', '找不到时按 Windows 自带的算');
  assert.equal(sshFlavor({ PATH: 'C:\\Windows\\System32\\OpenSSH' }, has, 'darwin'), 'posix');
});

test('findLocalTool（win32）：aws.exe 优先，没有就认 aws.cmd', () => {
  const files = new Set(['C:\\py\\Scripts\\aws.cmd', 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe']);
  assert.equal(findLocalTool('aws', { PATH: 'C:\\py\\Scripts', ProgramFiles: 'C:\\Program Files' }, (p) => files.has(p), 'win32'), 'C:\\py\\Scripts\\aws.cmd');
  assert.equal(findLocalTool('aws', { PATH: 'C:\\x', ProgramFiles: 'C:\\Program Files' }, (p) => files.has(p), 'win32'), AWS);
});

test('winProxyCommand：cmd 用 %SystemRoot% 的绝对路径、/d /s /c 外层一对引号；% 全部转义成 %%', () => {
  const env = { SystemRoot: 'C:\\WINDOWS' };
  assert.equal(winProxyCommand(['"C:\\a b\\aws.exe" ssm start-session'], { env }), 'C:\\WINDOWS\\System32\\cmd.exe /d /s /c ""C:\\a b\\aws.exe" ssm start-session"');
  assert.equal(
    winProxyCommand(['"C:\\100%\\aws.exe" x'], { env, pluginDir: 'C:\\Program Files\\Amazon\\SessionManagerPlugin\\bin' }),
    'C:\\WINDOWS\\System32\\cmd.exe /d /s /c "set "PATH=C:\\Program Files\\Amazon\\SessionManagerPlugin\\bin;%%PATH%%" && "C:\\100%%\\aws.exe" x"',
  );
  assert.equal(winProxyCommand(['x'], { env: { SystemRoot: 'D:\\My Win' } }), '"D:\\My Win\\System32\\cmd.exe" /d /s /c "x"');
});

test('ssmProxyCommand（win32，不推临时公钥）：带 / 不带 profile', () => {
  assert.equal(
    ssmProxyCommand(SSM, { aws: AWS, flavor: 'win32', env: { SystemRoot: 'C:\\Windows' } }),
    `C:\\Windows\\System32\\cmd.exe /d /s /c ""${AWS}" ssm start-session --target ${ID} --document-name AWS-StartSSHSession --parameters portNumber=22 --region ap-northeast-1 --profile kyn"`,
  );
  assert.equal(
    ssmProxyCommand({ ...SSM, ssmProfile: undefined, sshPort: 2222 }, { aws: AWS, flavor: 'win32', env: { SystemRoot: 'C:\\Windows' } }),
    `C:\\Windows\\System32\\cmd.exe /d /s /c ""${AWS}" ssm start-session --target ${ID} --document-name AWS-StartSSHSession --parameters portNumber=2222 --region ap-northeast-1"`,
  );
  /* aws.cmd：前面加 call，否则批处理的退出码 && 看不见 */
  assert.ok(ssmProxyCommand(SSM, { aws: 'C:\\py\\Scripts\\aws.cmd', flavor: 'win32' }).includes('/c "call "C:\\py\\Scripts\\aws.cmd" ssm start-session '));
  assert.throws(() => ssmProxyCommand({ ...SSM, ssmRegion: 'x&calc' }, { aws: AWS, flavor: 'win32' }), '白名单照旧');
});

test('transportArgs（win32，临时公钥）：先推公钥（file://<pub>），>NUL，&& 再 start-session；没有 exec / 9> / env / 单引号', () => {
  setProxyFlavorOverride('win32');
  try {
    const args = transportArgs(SSM);
    const proxy = proxyOf(args);
    const pub = `${ensureSsmKey(SSM).privateKey}.pub`;
    const awsPath = findLocalTool('aws') || 'aws';
    const aws = /\.(cmd|bat)$/i.test(awsPath) ? `call "${awsPath}"` : `"${awsPath}"`;
    assert.ok(proxy.startsWith(`${CMD.includes(' ') ? `"${CMD}"` : CMD} /d /s /c ""`.replace(/%/g, '%%')), proxy);
    const inner = sshExpand(proxy);
    assert.ok(inner.includes(
      `${aws} ec2-instance-connect send-ssh-public-key --instance-id ${ID} --instance-os-user ec2-user --ssh-public-key "file://${pub}" --region ap-northeast-1 --profile kyn >NUL && ${aws} ssm start-session --target ${ID} --document-name AWS-StartSSHSession --parameters portNumber=22 --region ap-northeast-1 --profile kyn"`,
    ), inner);
    for (const bad of ['9>', 'exec ', '/dev/null', 'env PATH', "'"]) assert.equal(inner.includes(bad), false, `不该有 ${bad}`);
    assert.ok(args.includes(`HostKeyAlias=${ID}`));
    /* 公钥文件就是那把临时密钥的 */
    assert.match(fs.readFileSync(pub, 'utf8'), /^ssh-ed25519 /);
    /* 不带 profile */
    assert.doesNotMatch(sshExpand(proxyOf(transportArgs({ ...SSM, ssmProfile: undefined }))), /--profile/);
    /* 改用自己的私钥：只有 start-session */
    const own = sshExpand(proxyOf(transportArgs({ ...SSM, ssmUseOwnKey: true })));
    assert.doesNotMatch(own, /ec2-instance-connect|>NUL|&&/);
    assert.match(own, /\/d \/s \/c ""[^"]*" ssm start-session .* --profile kyn"$/);
    /* buildSshArgs 走的也是这一支 */
    assert.ok(proxyOf(buildSshArgs(SSM as any, 'true')).includes('/d /s /c "'));
  } finally {
    setProxyFlavorOverride();
  }
});

test('session-manager-plugin 不在 PATH 上（win32）：用 set "PATH=…;%PATH%"，在 PATH 上就不加', { skip: process.platform !== 'win32' && '要真的 Windows 路径' }, () => {
  /* 假的 %ProgramFiles%\Amazon\SessionManagerPlugin\bin（官方安装位置，findLocalTool 的 win32 兜底目录） */
  const pf = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  const pluginDir = path.join(pf, 'Amazon', 'SessionManagerPlugin', 'bin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'session-manager-plugin.exe'), '');
  assert.equal(pluginDirIfOffPath({ PATH: 'C:\\Windows', ProgramFiles: pf }, 'win32'), pluginDir);
  assert.equal(pluginDirIfOffPath({ PATH: `C:\\Windows;${pluginDir.toLowerCase()}\\`, ProgramFiles: pf }, 'win32'), undefined, '不分大小写、尾巴斜杠不算');
  /* 拼出来是 cmd 的 set "PATH=…;%PATH%"（经 ssh 的 %% 转义），不是 env */
  const p = ssmProxyCommand(SSM, { aws: AWS, flavor: 'win32', pluginDir: pluginDirIfOffPath({ PATH: 'C:\\Windows', ProgramFiles: pf }, 'win32') });
  assert.ok(sshExpand(p).includes(`/c "set "PATH=${pluginDir};%PATH%" && "${AWS}" ssm start-session`), p);
  assert.doesNotMatch(p, /env PATH/);
});

/*
 * 真的用 Windows 自带的 ssh.exe（Win32-OpenSSH）跑一次生成的 ProxyCommand：假的 aws.cmd 记下被调了什么。
 * 目录名里故意带空格和 `%`，验证 cmd 引号和 ssh 的 `%` 展开。连接本身会失败（假 aws 不是 SSH 服务器），
 * 要看的是 CreateProcessW 起得来、两步按顺序跑、推送失败时不 start-session。
 */
const WIN_SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
test('Win32-OpenSSH 实跑：先推公钥再 start-session；推送失败就不连', { skip: !(process.platform === 'win32' && fs.existsSync(WIN_SSH)) && '需要 Windows 自带的 OpenSSH' }, () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake aws 100%x%-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'aws.cmd'), [
    '@echo off',
    /* 批处理里 `%x%` 会被展开，日志路径用 %~dp0（这个脚本所在目录）*/
    '>>"%~dp0calls.log" echo %1 %2 %3 %4 %5 %6 %7 %8 %9',
    'if "%1"=="ec2-instance-connect" (',
    '  echo {"Success": true}',
    '  if defined FAIL_PUSH exit /b 1',
    '  exit /b 0',
    ')',
    'exit /b 0',
    '',
  ].join('\r\n'));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin};${oldPath}`;
  setProxyFlavorOverride('win32');
  try {
    const args = transportArgs(SSM);
    const run = (extra: NodeJS.ProcessEnv = {}) => spawnSync(WIN_SSH, [
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL', '-o', 'ConnectTimeout=10',
      ...args, SSM.sshHost, 'true',
    ], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...extra } });
    const r = run();
    assert.doesNotMatch(r.stderr, /CreateProcessW failed/, r.stderr);
    const lines = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map((l) => l.trim());
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0], /^ec2-instance-connect send-ssh-public-key --instance-id i-03b396ce3b8546b90 --instance-os-user ec2-user --ssh-public-key "file:\/\/.+\.pub"/);
    assert.match(lines[1], /^ssm start-session --target i-03b396ce3b8546b90 --document-name AWS-StartSSHSession/);
    fs.rmSync(log);
    run({ FAIL_PUSH: '1' });
    const after = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
    assert.equal(after.length, 1, '推送失败就不 start-session');
  } finally {
    process.env.PATH = oldPath;
    setProxyFlavorOverride();
  }
});

/* ------------------------------------------------ 预检（「测试连接」）直接起 aws：aws.cmd 要经 cmd.exe */

test('localToolSpawn：.exe / 非 Windows 原样；.cmd 经 cmd.exe /d /s /c "call …"，带 = , 空格的参数包引号', () => {
  assert.deepEqual(localToolSpawn(AWS, ['sts', 'get-caller-identity'], 'win32'), { file: AWS, args: ['sts', 'get-caller-identity'] });
  assert.deepEqual(localToolSpawn('/usr/local/bin/aws.cmd', ['x'], 'darwin'), { file: '/usr/local/bin/aws.cmd', args: ['x'] });
  const s = localToolSpawn('C:\\py 3\\Scripts\\aws.cmd', ['ssm', 'describe-instance-information', '--filters', `Key=InstanceIds,Values=${ID}`, '--ssh-public-key', 'ssh-ed25519 AAAAC3+/x kirolex-ssm'], 'win32', { SystemRoot: 'C:\\Windows' });
  assert.equal(s.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(s.windowsVerbatimArguments, true);
  assert.deepEqual(s.args, ['/d', '/s', '/c', `"call "C:\\py 3\\Scripts\\aws.cmd" ssm describe-instance-information --filters "Key=InstanceIds,Values=${ID}" --ssh-public-key "ssh-ed25519 AAAAC3+/x kirolex-ssm""`]);
  assert.throws(() => localToolSpawn('C:\\a\\aws.cmd', ['a"b'], 'win32'));
  assert.throws(() => localToolSpawn('C:\\a\\aws.cmd', ['%PATH%'], 'win32'));
});

/*
 * 走真的执行路径：`ssmPreflight` + `runLocalTool`（index.ts `checkSsm` 用的就是这两样）+ 一个假的 aws.cmd。
 * aws.cmd 把参数交给 node 脚本记下来 —— 记到的是**程序真正收到的 argv**（和 python 版 aws 一样按 MSVCRT 规则切）。
 */
test('预检实跑 aws.cmd：sts / describe / send-ssh-public-key 都起得来、参数完整；推送被拒时退出码和报错带回来', { skip: process.platform !== 'win32' && '只有 Windows 有 .cmd' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake aws cmd-'));
  const log = path.join(bin, 'argv.log');
  fs.writeFileSync(path.join(bin, 'dump.js'), [
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    "const a = process.argv[2];",
    "if (a === 'sts') { console.log(JSON.stringify({ Arn: 'arn:aws:sts::123456789012:assumed-role/kyn/me' })); process.exit(0); }",
    `if (a === 'ssm') { console.log(JSON.stringify({ InstanceInformationList: [{ InstanceId: ${JSON.stringify(ID)}, PingStatus: 'Online' }] })); process.exit(0); }`,
    "if (a === 'ec2-instance-connect' && process.env.FAIL_PUSH) { console.error('An error occurred (AccessDeniedException) when calling the SendSSHPublicKey operation: User: arn:aws:sts::123456789012:assumed-role/kyn/me is not authorized to perform: ec2-instance-connect:SendSSHPublicKey'); process.exit(254); }",
    "console.log('{\"Success\": true}');",
  ].join('\n'));
  const awsCmd = path.join(bin, 'aws.cmd');
  fs.writeFileSync(awsCmd, `@"${process.execPath}" "%~dp0dump.js" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
  const tools = { aws: awsCmd, plugin: 'C:\\x\\session-manager-plugin.exe' };
  const seen: { arn?: string } = {};
  const ok = await ssmPreflight(SSM as any, tools, (f, a) => runLocalTool(f, a), seen);
  assert.equal(ok, null, ok?.message);
  assert.equal(seen.arn, 'arn:aws:sts::123456789012:assumed-role/kyn/me');
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls[0], ['sts', 'get-caller-identity', '--region', 'ap-northeast-1', '--profile', 'kyn', '--output', 'json']);
  assert.deepEqual(calls[1], ['ssm', 'describe-instance-information', '--filters', `Key=InstanceIds,Values=${ID}`, '--region', 'ap-northeast-1', '--profile', 'kyn', '--output', 'json']);
  assert.equal(calls[2][0], 'ec2-instance-connect');
  assert.equal(calls[2][calls[2].indexOf('--ssh-public-key') + 1], fs.readFileSync(`${ensureSsmKey(SSM).privateKey}.pub`, 'utf8').trim(), '公钥一整行（带空格）原样到达');
  process.env.FAIL_PUSH = '1';
  try {
    const bad = await ssmPreflight(SSM as any, tools, (f, a) => runLocalTool(f, a));
    assert.equal(bad!.code, 'unreachable');
    assert.match(bad!.message, /ec2-instance-connect:SendSSHPublicKey/);
    assert.match(bad!.message, /arn:aws:ec2:ap-northeast-1:123456789012:instance\/i-03b396ce3b8546b90/);
  } finally {
    delete process.env.FAIL_PUSH;
  }
  /* 对照：execFile 直接起 .cmd 就是审查里说的 EINVAL —— runLocalTool 不会走这条 */
  const direct = spawnSync(awsCmd, ['sts']);
  assert.ok(direct.error, '直接起 .cmd 会失败');
});
