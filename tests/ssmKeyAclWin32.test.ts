/**
 * **Windows 上临时私钥的 ACL 太宽，Win32-OpenSSH 拒用** —— KYN-DESKTOP 实测：
 * `Bad permissions. Try removing permissions for user: KYN-DESKTOP\CodexSandboxUsers … This private key will be ignored.`
 * → `Permission denied (publickey,…)`。0600 在 Windows 上不算数，私钥继承了 ~/.kirolex 的 ACL。
 *
 * win32 下 ensureSsmKey：先建空文件 → icacls 去继承、只给当前用户 SID / SYSTEM / Administrators 完全控制 → 再写内容；
 * 复用期内的旧私钥也收紧一次，失败就换一把并写日志。非 win32 不调 icacls。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setSsmKeyRoot, setSsmKeyDeps, ensureSsmKey, tightenKeyAcl } from '../src/main/sshProxy.ts';
import { judgePreflight, ssmPreflight } from '../src/main/remotePreflight.ts';
import { setUiLang } from '../src/main/uiText.ts';

setUiLang('en');

const ID = 'i-03b396ce3b8546b90';
const SSM = { id: 'aws-tokyo-4', sshHost: `ec2-user@${ID}`, connectVia: 'ssm' as const, ssmInstanceId: ID, ssmRegion: 'ap-northeast-1', ssmProfile: 'kyn' };
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const WIN_ENV = { SystemRoot: 'C:\\Windows', USERDOMAIN: 'KYN-DESKTOP', USERNAME: 'kyn06' };

function freshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-acl-'));
  setSsmKeyRoot(root);
  return root;
}

/** 记下每一次 execFileSync；`icacls` 那一次顺手记下当时私钥文件有多大（必须是 0：内容还没写）。 */
function stub(opts: { failIcacls?: (file: string) => boolean; failWhoami?: boolean } = {}) {
  const calls: { file: string; args: string[]; sizeAtCall?: number }[] = [];
  const logs: string[] = [];
  setSsmKeyDeps({
    platform: 'win32',
    env: WIN_ENV,
    execFileSync: (file, args) => {
      const c: { file: string; args: string[]; sizeAtCall?: number } = { file, args };
      calls.push(c);
      if (/whoami\.exe$/.test(file)) {
        if (opts.failWhoami) throw new Error('whoami: not found');
        return `"kyn-desktop\\kyn06","${SID}"\r\n`;
      }
      if (/icacls\.exe$/.test(file)) {
        try { c.sizeAtCall = fs.statSync(args[0]).size; } catch { /* 文件不在 */ }
        if (opts.failIcacls?.(args[0])) throw new Error('Access is denied.');
      }
      return '';
    },
    log: (m) => logs.push(m),
  });
  return { calls, logs, icacls: () => calls.filter((c) => /icacls\.exe$/.test(c.file)) };
}

test.afterEach(() => setSsmKeyDeps());

test('win32：新私钥先建空文件、icacls 去继承只给当前用户 SID / SYSTEM / Administrators，再写内容', () => {
  freshRoot();
  const s = stub();
  const k = ensureSsmKey(SSM);
  const [ic] = s.icacls();
  assert.ok(ic, '调了 icacls');
  assert.equal(ic.file, 'C:\\Windows\\System32\\icacls.exe', '%SystemRoot% 下的绝对路径');
  assert.deepEqual(ic.args, [k.privateKey, '/inheritance:r', '/grant:r', `*${SID}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F']);
  assert.equal(ic.sizeAtCall, 0, '收紧 ACL 时私钥还是空的 —— 没有"内容已写、ACL 还宽"的窗口');
  assert.match(fs.readFileSync(k.privateKey, 'utf8'), /^-----BEGIN OPENSSH PRIVATE KEY-----/);
  assert.equal(s.calls.find((c) => /whoami\.exe$/.test(c.file))?.file, 'C:\\Windows\\System32\\whoami.exe');
  /* 同一把再要一次：不重复收紧 */
  ensureSsmKey(SSM);
  assert.equal(s.icacls().length, 1);
});

test('win32：问不到 SID 时退回 %USERDOMAIN%\\%USERNAME%', () => {
  freshRoot();
  const s = stub({ failWhoami: true });
  ensureSsmKey(SSM);
  assert.equal(s.icacls()[0].args[3], 'KYN-DESKTOP\\kyn06:F');
});

test('非 win32：不调 icacls / whoami', () => {
  freshRoot();
  const calls: string[] = [];
  setSsmKeyDeps({ platform: 'linux', execFileSync: (f) => { calls.push(f); return ''; } });
  ensureSsmKey(SSM);
  assert.deepEqual(calls, []);
  assert.doesNotThrow(() => tightenKeyAcl('/nowhere'));
  assert.deepEqual(calls, []);
});

test('win32：复用期内的旧私钥（老版本写的，ACL 是继承来的）也先收紧一次', () => {
  freshRoot();
  setSsmKeyDeps({ platform: 'linux' });
  const old = ensureSsmKey(SSM);
  const s = stub();   // 模拟升级后重启：缓存清空，换成 win32
  const k = ensureSsmKey(SSM);
  assert.equal(k.privateKey, old.privateKey, '还是复用那一把');
  assert.deepEqual(s.icacls().map((c) => c.args[0]), [old.privateKey]);
});

test('win32：旧私钥收紧失败 → 换一把新的、新的也收紧，并写日志', () => {
  freshRoot();
  setSsmKeyDeps({ platform: 'linux' });
  const old = ensureSsmKey(SSM);
  const s = stub({ failIcacls: (f) => f === old.privateKey });
  const k = ensureSsmKey(SSM);
  assert.notEqual(k.privateKey, old.privateKey);
  assert.notEqual(k.publicKey, old.publicKey);
  assert.deepEqual(s.icacls().map((c) => c.args[0]), [old.privateKey, k.privateKey]);
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0], /收紧失败/);
  assert.doesNotMatch(s.logs.join('\n'), /PRIVATE KEY/, '日志里没有私钥内容');
});

test('win32：新私钥也收紧不了 → 删掉它、抛出说人话的错误，不留一把权限宽的私钥', () => {
  const root = freshRoot();
  const s = stub({ failIcacls: () => true });
  assert.throws(() => ensureSsmKey(SSM), /Could not restrict the permissions of the temporary SSH key/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'aws-tokyo-4')), []);
  assert.equal(s.logs.length, 1);
});

test('本机实跑 icacls：收紧后没有继承来的 ACE，只剩自己 / SYSTEM / Administrators', { skip: process.platform !== 'win32' && '只有 Windows 有 icacls' }, () => {
  freshRoot();
  setSsmKeyDeps();
  const k = ensureSsmKey(SSM);
  const out = spawnSync(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\icacls.exe`, [k.privateKey], { encoding: 'utf8' }).stdout;
  const sid = /S-1-5-[0-9-]+/.exec(spawnSync(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\whoami.exe`, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout)![0];
  assert.doesNotMatch(out, /\(I\)/, `没有继承的：${out}`);
  assert.doesNotMatch(out, /Everyone|\\Users:|Authenticated Users|CodexSandbox/i, out);
  /* SID 解析得到名字时 icacls 显示名字；按 /save 导出的 SDDL 看 SID 更稳 */
  const sddlFile = path.join(os.tmpdir(), `acl-${process.pid}.txt`);
  spawnSync(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\icacls.exe`, [k.privateKey, '/save', sddlFile], { encoding: 'utf8' });
  const sddl = fs.readFileSync(sddlFile, 'utf16le');
  fs.rmSync(sddlFile, { force: true });
  assert.match(sddl, /D:P/, 'DACL 受保护（不继承）');
  const aces = [...sddl.matchAll(/\(A;[^;]*;[^;]*;;;([^)]+)\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(aces, [sid, 'BA', 'SY'].sort(), sddl);
});

/* ------------------------------------------------------------- 报错 / 噪音 */

const BAD_PERMS = [
  'could not parse PEM data',
  'Bad permissions. Try removing permissions for user: KYN-DESKTOP\\CodexSandboxUsers (S-1-5-21-1-2-3-1005) on file C:/Users/kyn06/my keys/tokyo.pem.',
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  '@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @',
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  "Permissions for 'C:/Users/kyn06/my keys/tokyo.pem' are too open.",
  'It is required that your private key files are NOT accessible by others.',
  'This private key will be ignored.',
  'ec2-user@i-03b396ce3b8546b90: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).',
].join('\n');

test('「改用自己的私钥」权限太宽：预检说人话，附上那个文件的 icacls 命令（不去改用户的文件）', () => {
  const v = judgePreflight(255, '', BAD_PERMS, { ...SSM, ssmUseOwnKey: true, identityFile: 'C:\\Users\\kyn06\\my keys\\tokyo.pem' } as any);
  assert.equal(v.code, 'unreachable');
  assert.match(v.message, /permissions are too open/);
  if (process.platform === 'win32') assert.match(v.message, /icacls "C:\/Users\/kyn06\/my keys\/tokyo\.pem" \/inheritance:r \/grant:r "[^"]+:R"/);
  assert.doesNotMatch(v.message, /PEM data/, 'PEM 噪音不是原因');
});

test('aws CLI / Roles Anywhere 的「could not parse PEM data」噪音：命令退出码是 0 就照样算成功', async () => {
  const noisy = 'could not parse PEM data\n';
  const calls: string[][] = [];
  const v = await ssmPreflight({ ...SSM } as any, { aws: 'C:\\aws.exe', plugin: 'C:\\smp.exe' }, async (_f, a) => {
    calls.push(a);
    if (a[0] === 'sts') return { code: 0, stdout: '{"Arn":"arn:aws:sts::123456789012:assumed-role/kyn/me"}', stderr: noisy };
    if (a[0] === 'ssm') return { code: 0, stdout: JSON.stringify({ InstanceInformationList: [{ InstanceId: ID, PingStatus: 'Online' }] }), stderr: noisy };
    return { code: 0, stdout: '{"Success": true}', stderr: noisy };
  });
  assert.equal(v, null, v?.message);
  assert.ok(calls.some((c) => c[0] === 'ec2-instance-connect'), '推送那一步也跑了');
});
