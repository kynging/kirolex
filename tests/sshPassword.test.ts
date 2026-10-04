import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { batchModeFor, hasPassword, sshEnv, setPasswordDecryptor, askpassHelper } from '../src/main/sshAuth.ts';
import { buildSshArgs } from '../src/main/acp-client.ts';
import { saveRemoteTarget, listRemoteTargets } from '../src/main/remoteTargets.ts';

/**
 * 「除了用户名应该还有密码，不过密码可以是空的」。
 *
 * 两条要同时成立：没配密码的机器**一点都不变**（还是 BatchMode=yes、环境原样），
 * 配了密码的机器 ssh 能通过 SSH_ASKPASS 拿到它 —— 而明文从不落盘、从不进界面。
 */
const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');

describe('没配密码：行为和以前一模一样', () => {
  test('BatchMode=yes，不加密码相关的选项，环境原样', () => {
    const args = buildSshArgs({ sshHost: 'u@h' }, 'true');
    assert.ok(args.includes('BatchMode=yes'));
    assert.equal(args.some((a) => a.startsWith('NumberOfPasswordPrompts')), false);
    assert.equal(hasPassword({}), false);
    const env = sshEnv({}, { PATH: '/bin' });
    assert.deepEqual(env, { PATH: '/bin' });
  });
});

describe('配了密码', () => {
  test('ssh 允许被问（否则连 askpass 都不调），而且只问一次', () => {
    const args = buildSshArgs({ sshHost: 'u@h', passwordCipher: 'c' } as any, 'true');
    assert.ok(args.includes('BatchMode=no'));
    assert.ok(args.includes('NumberOfPasswordPrompts=1'), '答案永远一样，问三次是白问');
    assert.equal(batchModeFor({ passwordCipher: 'c' }), 'BatchMode=no');
  });

  test('sshEnv 解密后交给 askpass；解不开就当没配', () => {
    setPasswordDecryptor((c) => (c === 'good' ? 's3cr&t %x' : ''));
    const env = sshEnv({ passwordCipher: 'good' }, { PATH: '/bin' });
    assert.equal(env.KX_SSH_PASSWORD, 's3cr&t %x');
    assert.equal(env.SSH_ASKPASS_REQUIRE, 'force');
    assert.ok(env.SSH_ASKPASS && fs.existsSync(env.SSH_ASKPASS));
    assert.equal(env.PATH, '/bin');
    assert.equal(sshEnv({ passwordCipher: 'bad' }, { PATH: '/bin' }).KX_SSH_PASSWORD, undefined);
  });

  test('askpass 助手**不含密码**，只读环境变量；Windows 版不经 cmd 的 echo（特殊字符会坏）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askpass-'));
    const win = fs.readFileSync(askpassHelper(path.join(dir, 'w'), 'win32'), 'utf8');
    assert.match(win, /\$env:KX_SSH_PASSWORD/);
    assert.doesNotMatch(win, /echo %KX_SSH_PASSWORD%/);
    const sh = fs.readFileSync(askpassHelper(path.join(dir, 'p'), 'linux'), 'utf8');
    assert.match(sh, /"\$KX_SSH_PASSWORD"/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('存和发', () => {
  test('存的是密文；不给就不动，空串就清掉', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-')), 'config.json');
    fs.writeFileSync(f, '{}');
    saveRemoteTarget(f, { id: 'm', label: 'm', sshHost: 'u@h', passwordCipher: 'CIPHER' });
    assert.equal(listRemoteTargets(f)[0].passwordCipher, 'CIPHER');
    saveRemoteTarget(f, { id: 'm', label: 'renamed', sshHost: 'u@h' });
    assert.equal(listRemoteTargets(f)[0].passwordCipher, 'CIPHER', '界面拿不到密文，所以它永远"没给"——不许因此抹掉');
    saveRemoteTarget(f, { id: 'm', label: 'renamed', sshHost: 'u@h', passwordCipher: '' });
    assert.equal(listRemoteTargets(f)[0].passwordCipher, undefined);
  });

  test('主进程：明文不往下传，界面只拿到 hasPassword', () => {
    assert.match(M, /const \{ password: _pw, clearPassword: _clr, \.\.\.rest \} = input as any;/);
    assert.match(M, /hasPassword: !!t\.passwordCipher,/);
    const at = M.indexOf("ipcMain.handle('app:remote-targets'");
    assert.doesNotMatch(M.slice(at, at + 2000), /passwordCipher: t\.passwordCipher/);
    /* 每一处起 ssh 的地方都带上 sshEnv —— 漏一处，那条路径就"密码机器连不上" */
    const starts = [...M.matchAll(/(execFile|spawn)\('ssh', /g)].map((m) => m.index!);
    assert.ok(starts.length >= 6);
    for (const at of starts) {
      /* 选项对象可能隔着一行注释，所以看到这次调用的回调/结尾为止 */
      const call = M.slice(at, at + 400).split(/=> \{|\(\) => \{\}|=> \(err|\);\n/)[0];
      assert.match(call, /env: sshEnv\(/, `漏了 sshEnv：${call.slice(0, 80)}`);
    }
  });
});
