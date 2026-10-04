import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { unsafeSshHost, validJump } from '../src/main/sshProxy.ts';
import { buildSshArgs } from '../src/main/acp-client.ts';
import { masterArgs } from '../src/main/sshMux.ts';
import { validateTarget, parseRemoteTargets } from '../src/main/remoteTargets.ts';
import { gitArgsProblem, cmdShellArgs } from '../src/main/localMcp.ts';

describe('sshHost 不许被 ssh 当成选项', () => {
  test('以 - 开头的 host 是危险的', () => {
    assert.equal(unsafeSshHost('-oProxyCommand=calc.exe'), true);
    assert.equal(unsafeSshHost(' -p'), true);
    assert.equal(unsafeSshHost('ec2-user@1.2.3.4'), false);
  });
  test('保存时拒绝，读配置时丢掉', () => {
    assert.match(String(validateTarget({ sshHost: '-oProxyCommand=x' } as any)), /-/);
    assert.equal(parseRemoteTargets({ remotes: [{ sshHost: '-oProxyCommand=x' }] }).length, 0);
  });
  test('拼参数的地方再拦一次（会话记录里的快照不经过校验）', () => {
    assert.throws(() => buildSshArgs({ sshHost: '-oProxyCommand=x' } as any, 'true'));
    assert.throws(() => masterArgs({ sshHost: '-oX=y', socket: 's', remotePort: 1, localPort: 2 }));
  });
  test('跳板也不许以 - 开头', () => {
    assert.equal(validJump('-oProxyCommand=x'), false);
    assert.equal(validJump('ec2-user@bastion:2222'), true);
  });
});

describe('local_git 的只读要连参数一起算', () => {
  test('真正只读的照常放行', () => {
    for (const a of [['status'], ['log', '--oneline', '-5'], ['diff', '--stat'], ['branch'], ['branch', '-a'], ['branch', '--list', 'feat*'], ['show', 'HEAD']]) {
      assert.equal(gitArgsProblem(a), null, a.join(' '));
    }
  });
  test('写参数被拒', () => {
    for (const a of [['branch', '-D', 'x'], ['branch', 'newb'], ['branch', '--delete', 'x'], ['branch', '-m', 'a', 'b'],
      ['diff', '--output=C:/x'], ['log', '--output', 'x'], ['diff', '--ext-diff'], ['commit', '-m', 'x'], ['-c', 'a=b', 'log']]) {
      assert.notEqual(gitArgsProblem(a), null, a.join(' '));
    }
  });
});

describe('cmd.exe 拿到的是原样的命令', () => {
  test('整条包一层引号（配 /s）', () => {
    assert.deepEqual(cmdShellArgs('echo "a b"'), ['/d', '/s', '/c', '"echo "a b""']);
  });
  test('带引号的命令真的能跑', { skip: process.platform !== 'win32' }, () => {
    const out = execFileSync(process.env.ComSpec || 'cmd.exe', cmdShellArgs('echo "a b"&& echo x|findstr /C:"x"'),
      { encoding: 'utf8', windowsVerbatimArguments: true });
    assert.match(out, /"a b"/);
    assert.match(out, /^x\s*$/m);
  });
});
