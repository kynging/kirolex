/**
 * **Windows 上每台 SSM 机器只开一条 SSM 隧道**（`ssmTunnel.ts`）——「SSM 就一条，SSH 多个没关系」。
 * 假的隧道进程 / 端口 / 推送，跑真的 `SsmTunnels` 和真的 `buildSshArgs`。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SsmTunnels, tunnelArgs, tunnelKey, tunnelApplies, sharedTunnelEnabled, type TunnelDeps, type TunnelTarget } from '../src/main/ssmTunnel.ts';
import { buildSshArgs, setSsmTunnelResolver, setMuxSocketResolver } from '../src/main/acp-client.ts';
import { setSsmKeyRoot } from '../src/main/sshProxy.ts';

setSsmKeyRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-keys-')));

const A: TunnelTarget = { id: 'aws-tokyo-4', sshHost: 'ec2-user@i-03b396ce3b8546b90', connectVia: 'ssm', ssmInstanceId: 'i-03b396ce3b8546b90', ssmRegion: 'ap-northeast-1', ssmProfile: 'kyn' };
const B: TunnelTarget = { id: 'tokyo-arm', sshHost: 'ec2-user@i-0aaaaaaaaaaaaaaaa', connectVia: 'ssm', ssmInstanceId: 'i-0aaaaaaaaaaaaaaaa', ssmRegion: 'ap-northeast-1', ssmProfile: 'kyn' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeProc(opts: { deniedAfterMs?: number } = {}): any {
  const p: any = new EventEmitter();
  p.exitCode = null;
  p.killed = false;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => { if (p.exitCode !== null) return; p.killed = true; p.exitCode = 1; setImmediate(() => p.emit('exit', 1)); };
  p.die = () => { p.exitCode = 255; p.emit('exit', 255); };
  if (opts.deniedAfterMs !== undefined) {
    setTimeout(() => {
      p.stderr.emit('data', 'An error occurred (AccessDeniedException) when calling the StartSession operation: User: arn:aws:sts::123456789012:assumed-role/kyn/me is not authorized to perform: ssm:StartSession on resource: arn:aws:ssm:ap-northeast-1::document/AWS-StartPortForwardingSession\n');
      p.exitCode = 254; p.emit('exit', 254);
    }, opts.deniedAfterMs);
  } else {
    /* plugin 打出 Waiting for connections 之后端口才开始听 */
    setTimeout(() => { p.listening = true; p.stdout.emit('data', 'Starting session with SessionId: me-0123\nPort 50000 opened for sessionId me-0123.\nWaiting for connections...\n'); }, 5);
  }
  return p;
}

function harness(over: Partial<TunnelDeps> & { denied?: boolean; makeProc?: (n: number) => any } = {}) {
  const spawned: { target: TunnelTarget; port: number; proc: any }[] = [];
  const pushes: TunnelTarget[] = [];
  const logs: string[] = [];
  /** 收进程树被叫到的那几个进程（默认实现是 Windows 上的 taskkill /T /F） */
  const treeKilled: any[] = [];
  let nextPort = 50000;
  let clock = 1_000_000;
  const tunnels = new SsmTunnels({
    spawnTunnel: (target, port) => {
      const proc = over.makeProc ? over.makeProc(spawned.length) : fakeProc(over.denied ? { deniedAfterMs: 5 } : {});
      spawned.push({ target, port, proc });
      return proc;
    },
    killTree: (p) => { treeKilled.push(p); p.kill(); },
    freePort: async () => nextPort++,
    /* 端口连得上 = 有一个活着的隧道进程在那个端口上 */
    probe: async (host, port) => host === '127.0.0.1' && spawned.some((s) => s.port === port && s.proc.listening && s.proc.exitCode === null),
    pushKey: async (t) => { pushes.push(t); },
    needsPush: (t) => !t.ssmUseOwnKey,
    pushKeyId: (t) => `${t.id}|ec2-user`,
    log: (_l, m) => logs.push(m),
    now: () => clock,
    idleMs: 60,
    readyWaitMs: 2_000,
    healBackoffMs: [20],
    pushFreshMs: 45_000,
    probeEveryMs: 0,
    ...over,
  });
  return { tunnels, spawned, pushes, logs, treeKilled, tick: (ms: number) => { clock += ms; } };
}

test('同一实例两条会话只建一条隧道（并发也只建一次），推一次公钥', async () => {
  const h = harness();
  h.tunnels.acquire('s1', A);
  h.tunnels.acquire('s2', A);
  const [a, b] = await Promise.all([h.tunnels.ensure(A), h.tunnels.ensure({ ...A })]);
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(a, { host: '127.0.0.1', port: 50000 });
  assert.deepEqual(b, a);
  assert.equal(h.pushes.length, 1, '60 秒内起的 ssh 共用这次推送');
  await h.tunnels.ensure(A);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.pushes.length, 1);
  assert.deepEqual(h.tunnels.liveFor(A), { host: '127.0.0.1', port: 50000 });
  assert.ok(h.logs.some((l) => /建 SSM 隧道/.test(l)) && h.logs.some((l) => /复用 SSM 隧道/.test(l)));
  h.tunnels.closeAll();
});

test('不同实例各一条', async () => {
  const h = harness();
  const a = await h.tunnels.ensure(A);
  const b = await h.tunnels.ensure(B);
  assert.equal(h.spawned.length, 2);
  assert.notEqual(a!.port, b!.port);
  assert.notEqual(tunnelKey(A), tunnelKey(B));
  assert.equal(tunnelKey(A), tunnelKey({ ...A, id: 'other-snapshot' }), '按 实例 + 区域 + profile 归一，不按会话快照的 id');
  h.tunnels.closeAll();
});

test('推送过期（45 秒）后 liveFor 不给端口，下一次 ensure 再推；改用自己的私钥的不推', async () => {
  const h = harness();
  await h.tunnels.ensure(A);
  h.tick(46_000);
  assert.equal(h.tunnels.liveFor(A), undefined, '推送不新鲜了，这条 ssh 宁可走 ProxyCommand');
  await h.tunnels.ensure(A);
  assert.equal(h.pushes.length, 2);
  assert.ok(h.tunnels.liveFor(A));
  const own = { ...B, ssmUseOwnKey: true };
  await h.tunnels.ensure(own);
  h.tick(10 * 60_000);
  assert.ok(h.tunnels.liveFor(own), '自己的私钥不依赖推送');
  assert.equal(h.pushes.filter((t) => t.ssmInstanceId === B.ssmInstanceId).length, 0);
  h.tunnels.closeAll();
});

test('隧道死掉 → 有会话在用就按退避重建，新 ssh 用新端口', async () => {
  const h = harness();
  h.tunnels.acquire('s1', A);
  const first = await h.tunnels.ensure(A);
  h.spawned[0].proc.die();
  assert.equal(h.tunnels.liveFor(A), undefined, '死了就不给旧端口');
  await sleep(300);
  assert.equal(h.spawned.length, 2, '自愈重建了');
  const live = h.tunnels.liveFor(A);
  assert.ok(live);
  assert.notEqual(live!.port, first!.port);
  /* buildSshArgs 跟着新端口走 */
  setSsmTunnelResolver((r) => h.tunnels.liveFor(r as any));
  try {
    const args = buildSshArgs(A as any, 'true');
    assert.equal(args[args.indexOf('-p') + 1], String(live!.port));
  } finally { setSsmTunnelResolver(); }
  /* 没有会话在用时死掉：不重建，等下一次 ensure 再懒建 */
  const h2 = harness();
  await h2.tunnels.ensure(B);
  h2.spawned[0].proc.die();
  await sleep(100);
  assert.equal(h2.spawned.length, 1);
  const again = await h2.tunnels.ensure(B);
  assert.equal(h2.spawned.length, 2);
  assert.notEqual(again!.port, 50000);
  h.tunnels.closeAll();
  h2.tunnels.closeAll();
});

test('端口连不上（进程还在）→ ensure 关掉重建', async () => {
  let refuse = false;
  const h = harness({ probe: async () => !refuse });
  const a = await h.tunnels.ensure(A);
  refuse = true;
  const p = h.tunnels.ensure(A);
  await sleep(20);
  refuse = false;
  const b = await p;
  assert.equal(h.spawned.length, 2);
  assert.equal(h.spawned[0].proc.killed, true);
  assert.notEqual(a!.port, b!.port);
  h.tunnels.closeAll();
});

test('最后一条会话断开后空闲 idleMs 才关；期间又来一条就不关', async () => {
  const h = harness();
  h.tunnels.acquire('s1', A);
  h.tunnels.acquire('s2', A);
  await h.tunnels.ensure(A);
  h.tunnels.release('s1');
  await sleep(100);
  assert.equal(h.spawned[0].proc.killed, false, '还有一条在用');
  h.tunnels.release('s2');
  await sleep(20);
  h.tunnels.acquire('s3', A);
  await sleep(100);
  assert.equal(h.spawned[0].proc.killed, false, '空闲期内又来了一条，不关');
  h.tunnels.release('s3');
  await sleep(120);
  assert.equal(h.spawned[0].proc.killed, true, '空闲到点关掉');
  assert.ok(h.logs.some((l) => /空闲 .* 关掉/.test(l)));
});

test('AccessDenied（角色只放了 AWS-StartSSHSession）：说人话，这台机器回退到每会话 ProxyCommand，不再反复建', async () => {
  const h = harness({ denied: true });
  assert.equal(await h.tunnels.ensure(A), undefined);
  assert.equal(h.tunnels.isDenied(A), true);
  assert.ok(h.logs.some((l) => /AWS-StartPortForwardingSession/.test(l) && /回退/.test(l)), h.logs.join('\n'));
  assert.equal(await h.tunnels.ensure(A), undefined);
  assert.equal(h.spawned.length, 1, '不再反复建');
  assert.equal(h.tunnels.liveFor(A), undefined);
});

test('退出时关掉所有隧道进程', async () => {
  const h = harness();
  await h.tunnels.ensure(A);
  await h.tunnels.ensure(B);
  h.tunnels.closeAll();
  assert.ok(h.spawned.every((s) => s.proc.killed));
  assert.equal(await h.tunnels.ensure(A), undefined, '关了之后不再建');
});

test('ssh 参数：走隧道时没有 SSM ProxyCommand，有 HostKeyAlias=<实例id>、127.0.0.1:<端口>，-R 反向端口照旧', () => {
  setMuxSocketResolver(undefined);
  setSsmTunnelResolver(() => ({ host: '127.0.0.1', port: 50123 }));
  try {
    const args = buildSshArgs(A as any, 'kiro-cli acp', { remotePort: 39100, localPort: 5000 });
    assert.equal(args.some((a) => /ProxyCommand/.test(a)), false);
    assert.ok(args.includes(`HostKeyAlias=${A.ssmInstanceId}`));
    assert.equal(args[args.indexOf('-p') + 1], '50123');
    assert.equal(args[args.length - 2], 'ec2-user@127.0.0.1');
    assert.equal(args[args.length - 1], 'kiro-cli acp');
    assert.equal(args[args.indexOf('-R') + 1], '127.0.0.1:39100:127.0.0.1:5000');
    assert.ok(args.includes('IdentitiesOnly=yes'), '临时私钥照旧');
    /* 直连机器不走隧道 */
    const ssh = buildSshArgs({ sshHost: 'ec2-user@192.0.2.10' } as any, 'true');
    assert.equal(ssh[ssh.length - 2], 'ec2-user@192.0.2.10');
  } finally {
    setSsmTunnelResolver();
  }
  /* 没有隧道时照旧是每会话 ProxyCommand */
  const old = buildSshArgs(A as any, 'true');
  assert.ok(old.some((a) => /^ProxyCommand=/.test(a)));
  assert.equal(old[old.length - 2], A.sshHost);
});

test('只有没有 ControlMaster 的平台 + SSM 机器 + 开关开着才走共享隧道（mux 平台不走）', () => {
  assert.equal(tunnelApplies(A, { muxSupported: false, enabled: true }), true);
  assert.equal(tunnelApplies(A, { muxSupported: true, enabled: true }), false, 'Mac / Linux 走 ControlMaster');
  assert.equal(tunnelApplies({ connectVia: 'ssh' }, { muxSupported: false, enabled: true }), false, '直连不变');
  assert.equal(tunnelApplies(A, { muxSupported: false, enabled: false }), false, '开关关了回到每会话 ProxyCommand');
  assert.equal(sharedTunnelEnabled({}, {}), true, '缺省开');
  assert.equal(sharedTunnelEnabled({ ssmSharedTunnel: false }, {}), false);
  assert.equal(sharedTunnelEnabled({}, { KIROLEX_SSM_SHARED_TUNNEL: '0' }), false);
});

test('隧道命令：AWS-StartPortForwardingSession，portNumber=<sshd 端口>,localPortNumber=<本机端口>，region / profile 同这台机器', () => {
  assert.deepEqual(tunnelArgs(A, 50000), ['ssm', 'start-session', '--target', 'i-03b396ce3b8546b90', '--document-name', 'AWS-StartPortForwardingSession', '--parameters', 'portNumber=22,localPortNumber=50000', '--region', 'ap-northeast-1', '--profile', 'kyn']);
  assert.deepEqual(tunnelArgs({ ...A, ssmProfile: undefined, sshPort: 2222 }, 50001).slice(-3), ['portNumber=2222,localPortNumber=50001', '--region', 'ap-northeast-1']);
});

/* ------------------------------------------------ 审查补的：进程树、退避期间等待、异步 error */

test('空闲关闭 / 端口连不上重建 / 就绪超时 / 退出：都按进程树收（不是只 kill 根进程）', async () => {
  const h = harness();
  h.tunnels.acquire('s1', A);
  await h.tunnels.ensure(A);
  h.tunnels.release('s1');
  await sleep(120);
  assert.deepEqual(h.treeKilled, [h.spawned[0].proc], '空闲关闭收的是那条隧道的进程树');
  /* 就绪超时 */
  const never = harness({ readyWaitMs: 200, makeProc: () => { const p: any = new EventEmitter(); p.exitCode = null; p.killed = false; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => { p.killed = true; p.exitCode = 1; setImmediate(() => p.emit('exit', 1)); }; return p; } });
  assert.equal(await never.tunnels.ensure(A), undefined);
  assert.equal(never.treeKilled.length, 1, '就绪超时也收进程树');
  /* 退出 */
  const q = harness();
  await q.tunnels.ensure(A);
  await q.tunnels.ensure(B);
  q.tunnels.closeAll();
  assert.equal(q.treeKilled.length, 2);
});

test('Windows 实跑：killTunnelTree 连子进程（模拟 session-manager-plugin，真的在听端口）一起结束', { skip: process.platform !== 'win32' && '要 Windows 的 taskkill' }, async () => {
  const { killTunnelTree } = await import('../src/main/ssmTunnel.ts');
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const port = await new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-')), 'plugin.js');
  fs.writeFileSync(script, `require('net').createServer((c) => c.destroy()).listen(${port}, '127.0.0.1'); setInterval(() => {}, 1000);`);
  /* 根进程是 cmd.exe（和 aws.cmd 那条路一样），真正听端口的是它起的子进程 */
  const root = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${process.execPath}" "${script}""`], { windowsVerbatimArguments: true, stdio: 'ignore', windowsHide: true });
  const can = () => new Promise<boolean>((r) => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
  for (let i = 0; i < 50 && !(await can()); i++) await sleep(100);
  assert.equal(await can(), true, '子进程在听');
  killTunnelTree(root as any);
  for (let i = 0; i < 50 && (await can()); i++) await sleep(100);
  assert.equal(await can(), false, '子进程也没了（没留下孤儿隧道）');
});

test('退避期间并发进来的连接都等同一次重建，不各自另起 ProxyCommand', async () => {
  /* 第一条：起来就退（没就绪）；之后的正常 */
  const h = harness({
    healBackoffMs: [200],
    makeProc: (n) => {
      if (n > 0) return fakeProc();
      const p: any = new EventEmitter(); p.exitCode = null; p.killed = false; p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
      p.kill = () => { p.killed = true; };
      setTimeout(() => { p.exitCode = 255; p.emit('exit', 255); }, 5);
      return p;
    },
  });
  h.tunnels.acquire('s1', A);
  assert.equal(await h.tunnels.ensure(A), undefined, '这一次建失败了');
  /* 退避期内（200ms）同时来三条：都等，不返回 undefined（返回 undefined = buildSshArgs 另起 ProxyCommand） */
  const t0 = Date.now();
  const got = await Promise.all([h.tunnels.ensure(A), h.tunnels.ensure(A), h.tunnels.ensure({ ...A })]);
  assert.ok(Date.now() - t0 >= 150, '等了退避');
  assert.ok(got.every((g) => g && g.port === got[0]!.port), JSON.stringify(got));
  assert.equal(h.spawned.length, 2, '只重建了一次');
  assert.ok(h.logs.some((l) => /这期间要连这台机器的 ssh 都等它/.test(l)));
  h.tunnels.closeAll();
});

test('就绪过的隧道死了、正在重建时：新连接等它（拿到新端口），不走 ProxyCommand', async () => {
  const h = harness({ healBackoffMs: [150] });
  h.tunnels.acquire('s1', A);
  const first = await h.tunnels.ensure(A);
  h.spawned[0].proc.die();
  const again = await h.tunnels.ensure(A);
  assert.ok(again, '等到了重建好的那条');
  assert.notEqual(again!.port, first!.port);
  assert.equal(h.spawned.length, 2);
  h.tunnels.closeAll();
});

test('spawn 异步发 error（aws 不在了）：立刻判失败、记下原因，不等就绪超时、不抛到外面', async () => {
  const h = harness({
    readyWaitMs: 10_000,
    makeProc: () => {
      const p: any = new EventEmitter(); p.exitCode = null; p.killed = false; p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
      p.kill = () => { p.killed = true; };
      setImmediate(() => p.emit('error', Object.assign(new Error('spawn C:\Program Files\Amazon\AWSCLIV2\aws.exe ENOENT'), { code: 'ENOENT' })));
      return p;
    },
  });
  const t0 = Date.now();
  assert.equal(await h.tunnels.ensure(A), undefined);
  assert.ok(Date.now() - t0 < 2_000, `没等满就绪超时（${Date.now() - t0}ms）`);
  assert.ok(h.logs.some((l) => /建不起来/.test(l) && /ENOENT/.test(l)), h.logs.join('\n'));
  assert.equal(h.tunnels.count(), 0, '状态清干净了');
  /* 同步抛也一样 */
  const h2 = harness({ makeProc: () => { throw new Error('bad args'); } });
  assert.equal(await h2.tunnels.ensure(A), undefined);
  assert.ok(h2.logs.some((l) => /bad args/.test(l)));
});

test('建失败、还有会话引用：不用再有人调 ensure，也会按退避自动重建', async () => {
  const h = harness({
    healBackoffMs: [50],
    makeProc: (n) => {
      if (n > 0) return fakeProc();
      const p: any = new EventEmitter(); p.exitCode = null; p.killed = false; p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
      p.kill = () => { p.killed = true; };
      setTimeout(() => { p.exitCode = 255; p.emit('exit', 255); }, 5);
      return p;
    },
  });
  h.tunnels.acquire('s1', A);
  assert.equal(await h.tunnels.ensure(A), undefined, '第一次没建成');
  await sleep(400);
  assert.equal(h.spawned.length, 2, '退避后自己重建了');
  assert.ok(h.tunnels.liveFor(A), '重建好了、公钥也推了');
  /* 没有会话引用时失败：不自己重试（等下一次有人要连再懒建） */
  const h2 = harness({
    healBackoffMs: [50],
    makeProc: () => { const p: any = new EventEmitter(); p.exitCode = null; p.killed = false; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => { p.killed = true; }; setTimeout(() => { p.exitCode = 255; p.emit('exit', 255); }, 5); return p; },
  });
  await h2.tunnels.ensure(A);
  await sleep(300);
  assert.equal(h2.spawned.length, 1);
  h.tunnels.closeAll();
  h2.tunnels.closeAll();
});

test('推公钥失败、没有会话引用（比如只是预检建的）：隧道照样按空闲时长关掉，不留到退出', async () => {
  const h = harness({ idleMs: 20, pushKey: async () => { throw new Error('AccessDeniedException ... SendSSHPublicKey'); } });
  assert.equal(await h.tunnels.ensure(A), undefined);
  assert.equal(h.spawned.length, 1);
  await sleep(100);
  assert.equal(h.spawned[0].proc.killed, true, '空闲到点关掉了');
  assert.deepEqual(h.treeKilled, [h.spawned[0].proc]);
});

test('探活失败时两个并发 ensure 都等同一次探活 + 重建，都拿到新端口（不拿旧端口走掉、不落空）', async () => {
  let failOld = false;
  const h = harness({
    probe: async (host, port) => {
      if (failOld && port === 50000) { await sleep(50); return false; }
      return host === '127.0.0.1' && h.spawned.some((s) => s.port === port && s.proc.listening && s.proc.exitCode === null);
    },
  });
  h.tunnels.acquire('s1', A);
  const first = await h.tunnels.ensure(A);
  assert.equal(first!.port, 50000);
  failOld = true;
  const [a, b] = await Promise.all([h.tunnels.ensure(A), h.tunnels.ensure(A)]);
  assert.ok(a && b, '两个都拿到了');
  assert.notEqual(a!.port, 50000);
  assert.equal(a!.port, b!.port, '同一条新隧道');
  assert.equal(h.spawned.length, 2, '只重建了一次');
  assert.deepEqual(h.tunnels.liveFor(A), a);
  h.tunnels.closeAll();
});
