import assert from 'node:assert/strict';
import test from 'node:test';
import { proxyArgs, splitJump, validJump } from '../src/main/sshProxy.ts';
import { buildSshArgs } from '../src/main/acp-client.ts';
import { masterArgs } from '../src/main/sshMux.ts';

test('没配跳板时什么都不加 —— 直连的那条路一个字节都不该变', () => {
  assert.deepEqual(proxyArgs({}), []);
  assert.deepEqual(proxyArgs({ proxyJump: '   ' }), []);
});

test('跳板那一跳必须带上同一把私钥', () => {
  /*
    这是 `-o ProxyJump=` 不能用的原因：它另起的 ssh 不继承 `-i`，
    于是"目标机器密钥填对了还是连不上"。所以这里必须能在 ProxyCommand 里看到那把钥匙。
  */
  const a = proxyArgs({ proxyJump: 'ec2-user@1.2.3.4', identityFile: '/Users/me/k.pem' });
  assert.equal(a[0], '-o');
  assert.match(a[1], /^ProxyCommand=ssh /);
  assert.match(a[1], /-i '\/Users\/me\/k\.pem'/);
  assert.match(a[1], /-W %h:%p 'ec2-user@1\.2\.3\.4'$/);
});

test('路径里有空格也不会被切断', () => {
  const a = proxyArgs({ proxyJump: 'u@h', identityFile: '/Users/me/My Keys/k.pem' });
  assert.match(a[1], /-i '\/Users\/me\/My Keys\/k\.pem'/);
});

test('跳板可以带端口；22 不用写出来', () => {
  assert.match(proxyArgs({ proxyJump: 'u@h:2222' })[1], / -p 2222 /);
  assert.equal(/ -p /.test(proxyArgs({ proxyJump: 'u@h:22' })[1]), false);
});

test('splitJump 不会把 IPv6 切坏', () => {
  assert.deepEqual(splitJump('u@h:2222'), { dest: 'u@h', port: 2222 });
  assert.deepEqual(splitJump('h'), { dest: 'h' });
  assert.deepEqual(splitJump('[fd00::1]:2222'), { dest: '[fd00::1]', port: 2222 });
  assert.deepEqual(splitJump('fd00::1'), { dest: 'fd00::1' });      // 裸 IPv6：不切
});

test('buildSshArgs 会把跳板放进去，而且在 host 之前', () => {
  const args = buildSshArgs(
    { sshHost: 'ec2-user@10.0.4.129', identityFile: '/k.pem', proxyJump: 'ec2-user@1.2.3.4' } as any,
    'true',
  );
  const at = args.findIndex((a) => String(a).startsWith('ProxyCommand='));
  assert.ok(at > 0, 'ProxyCommand 没进去');
  assert.ok(at < args.indexOf('ec2-user@10.0.4.129'), 'ProxyCommand 必须排在目标 host 前面');
});

test('mux 的 master 也要跳 —— 它是唯一真正建连接的那条', () => {
  const args = masterArgs({
    sshHost: 'ec2-user@10.0.4.129', identityFile: '/k.pem', proxyJump: 'ec2-user@1.2.3.4',
    socket: '/tmp/s', remotePort: 39100, localPort: 5000,
  });
  assert.ok(args.some((a) => String(a).startsWith('ProxyCommand=ssh ')), 'master 没带跳板');
});

test('注入：跳板里的 shell 元字符不能变成命令', () => {
  /*
    `ProxyCommand` 的值是交给 `/bin/sh -c` 跑的，所以这里的每个字节都是 shell 代码。
    只拦空格不够 —— `h;curl x` 里没有空格也能分出第二条命令。
    两道防线各测一次：形状（白名单）+ 真拼出来的字符串（引号）。
  */
  for (const bad of ['h;curl evil.sh', 'h$(id)', 'h`id`', 'h|nc 1 2', 'h&&id', 'h>/tmp/x', "h'x", 'h\\x']) {
    assert.equal(validJump(bad), false, `白名单漏了 ${bad}`);
    assert.deepEqual(proxyArgs({ proxyJump: bad }), [], `形状不对时还拼出了参数：${bad}`);
  }
});

test('正常写法都要过白名单 —— 拦太狠等于把功能拦没了', () => {
  for (const ok of ['ec2-user@1.2.3.4', 'ec2-user@1.2.3.4:2222', 'host', 'a-b_c.example.com:22',
                    'u@[fd00::1]:2222', 'u@[fd00::1]']) {
    assert.equal(validJump(ok), true, `白名单误杀 ${ok}`);
  }
});

test('dest 是包了引号的 —— %h:%p 必须留在引号外面才会被 ssh 替换', () => {
  const v = proxyArgs({ proxyJump: 'ec2-user@1.2.3.4' })[1];
  assert.match(v, / -W %h:%p 'ec2-user@1\.2\.3\.4'$/);
});
