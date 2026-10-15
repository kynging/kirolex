import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SshMux, masterArgs, parseAllocatedPort, healDelay, HEAL_BACKOFF_MS, muxKey,
} from '../src/main/sshMux.ts';

/*
  **反向隧道的远端端口不再写死** ——「远程会话的本机工具断了连不回来」。

  实测：`复用连接已建立：远端 39101 → 本地 58660` 之后 0.06 秒就
  `remote port forwarding failed for listen port 39101`、code=255 退出 —— 远端 39100–39102
  都被别的、还 ESTAB 的 sshd-session 占着。重建时还要同一个端口，必然再失败；
  而"正在排重建"之后几分钟都没有新的尝试。

  这一组用假 ssh 跑完整的状态机：平台、socket 探活、退避表都注入，不碰真 ssh。
*/

/** 假 ssh：按脚本在 stderr 上说话，然后（可选）退出。 */
function fakeProc(script: { stderr?: string; exitCode?: number }): any {
  const p: any = new EventEmitter();
  p.killed = false; p.exitCode = null;
  p.stderr = new EventEmitter();
  p.kill = () => { p.killed = true; };
  p.die = (code = 255) => { if (p.exitCode !== null) return; p.exitCode = code; p.emit('exit', code); };
  setImmediate(() => {
    if (script.stderr) p.stderr.emit('data', Buffer.from(script.stderr));
    if (typeof script.exitCode === 'number') setImmediate(() => p.die(script.exitCode));
  });
  return p;
}

const allocated = (port: number) => `Allocated port ${port} for remote forward to 127.0.0.1:5000`;
const forwardFailed = (port: number) => `Error: remote port forwarding failed for listen port ${port}`;

function makeMux(scripts: Array<{ stderr?: string; exitCode?: number }>, opts: { hasSessions?: () => boolean; socketWaitMs?: number } = {}) {
  const spawned: { args: string[]; proc: any }[] = [];
  const ready: string[] = [];
  const healing: number[] = [];
  const logs: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muxport-'));
  const mux = new SshMux({
    log: (_l, m) => logs.push(m),
    localPort: () => 5000,
    owner: 'test',
    hasSessions: opts.hasSessions || (() => true),
    onReady: (k) => ready.push(k),
    onHealing: (_k, n) => healing.push(n),
    spawnSsh: (args) => {
      const script = scripts[Math.min(spawned.length, scripts.length - 1)];
      const proc = fakeProc(script);
      spawned.push({ args, proc });
      return proc;
    },
    /* socket "一直在" —— 就绪与否只看隧道（Allocated port）和进程是否还活着 */
    probeSocket: async () => true,
    platform: 'linux',
    healBackoffMs: [10, 20, 40],
    socketWaitMs: opts.socketWaitMs ?? 2_000,
  }, dir);
  return { mux, spawned, ready, healing, logs };
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('等超时了');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const target = { sshHost: 'ec2-user@99.83.165.184', sshPort: 22 };
const key = muxKey(target.sshHost, target.sshPort);

test('端口解析：认 ssh 打的那句，取最后一次', () => {
  assert.equal(parseAllocatedPort(allocated(41235)), 41235);
  assert.equal(parseAllocatedPort(`Warning: Permanently added 'h' (ED25519) to the list of known hosts.\r\n${allocated(40001)}\r\n`), 40001);
  /* 同一个进程只会说一次；拼起来的 stderr 里有两句时，后面那句才是这一次的 */
  assert.equal(parseAllocatedPort(`${allocated(40001)}\n${allocated(40002)}`), 40002);
  assert.equal(parseAllocatedPort(forwardFailed(39101)), undefined);
  assert.equal(parseAllocatedPort(''), undefined);
  assert.equal(parseAllocatedPort('Allocated port 0 for remote forward to x'), undefined);
  assert.equal(parseAllocatedPort('Allocated port 70000 for remote forward to x'), undefined);
});

test('master 让 sshd 分端口，并且带着探活和转发失败即退', () => {
  const args = masterArgs({ sshHost: 'u@h', socket: '/tmp/s', localPort: 58660 });
  assert.ok(args.includes('127.0.0.1:0:127.0.0.1:58660'), '远端端口是 0 —— 由 sshd 分');
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('ServerAliveCountMax=3'));
  const alive = args.find((a) => a.startsWith('ServerAliveInterval='));
  assert.ok(alive && Number(alive.split('=')[1]) * 3 < 60, '死连接要在一分钟内认出来');
  assert.ok(args.includes('LogLevel=INFO'), '`Allocated port` 是 INFO 级 —— 用户配置写了 QUIET 就看不到');
});

test('退避：几秒起步、封顶一分钟、到顶之后一直用最后一档', () => {
  assert.equal(healDelay(0), HEAL_BACKOFF_MS[0]);
  assert.ok(healDelay(0) <= 5_000);
  for (let i = 1; i < HEAL_BACKOFF_MS.length; i += 1) assert.ok(healDelay(i) > healDelay(i - 1));
  assert.equal(healDelay(HEAL_BACKOFF_MS.length - 1), 60_000);
  assert.equal(healDelay(99), 60_000, '不放弃，也不再变疏');
  assert.equal(healDelay(-1), HEAL_BACKOFF_MS[0]);
  assert.equal(healDelay(5, [1, 2, 3]), 3);
});

test('socket 先出来、隧道没建好 —— 不许算"已建立"（实测那次就是这么错的）', async () => {
  /* 只有 socket、ssh 一句 Allocated 都没说：等到超时也不能交出一个端口 */
  const { mux, ready } = makeMux([{ stderr: '' }], { hasSessions: () => false, socketWaitMs: 200 });
  await assert.rejects(mux.ensure(target), /没建起来/);
  assert.deepEqual(ready, []);
  assert.equal(mux.remotePortFor(key), undefined);
  mux.closeAll();
});

test('转发失败 → 立刻失败（不白等 12 秒）→ 排重建 → 换成 sshd 新分的端口', async () => {
  const { mux, spawned, ready, healing } = makeMux([
    { stderr: forwardFailed(39101), exitCode: 255 },
    { stderr: allocated(41235) },
  ], { socketWaitMs: 5_000 });
  const t0 = Date.now();
  await assert.rejects(mux.ensure(target), /remote port forwarding failed/);
  assert.ok(Date.now() - t0 < 2_000, 'ssh 已经退了就别等满超时');
  await until(() => ready.length === 1);
  assert.equal(spawned.length, 2, '自己重建了一次');
  assert.deepEqual(healing, [1]);
  assert.equal(mux.remotePortFor(key), 41235, '用的是这一次分到的端口');
  for (const s of spawned) assert.ok(s.args.includes('127.0.0.1:0:127.0.0.1:5000'), '每次都让 sshd 重新分');
  mux.closeAll();
});

test('连上之后掉了：自己重建，新端口交给调用方', async () => {
  const { mux, spawned, ready } = makeMux([
    { stderr: allocated(40001) },
    { stderr: allocated(40002) },
  ]);
  const e = await mux.ensure(target);
  assert.equal(e.remotePort, 40001);
  await until(() => ready.length === 1);
  spawned[0].proc.die(255);
  assert.equal(mux.remotePortFor(key), undefined, '死了就不再报旧端口');
  await until(() => ready.length === 2);
  assert.equal(mux.remotePortFor(key), 40002);
  mux.closeAll();
});

test('一直失败就一直试 —— 次数往上数、间隔到顶不再变', async () => {
  const { mux, healing, spawned } = makeMux([{ stderr: forwardFailed(0), exitCode: 255 }]);
  await mux.ensure(target).catch(() => {});
  await until(() => healing.length >= 6);
  assert.deepEqual(healing.slice(0, 6), [1, 2, 3, 4, 5, 6]);
  assert.ok(spawned.length >= 5);
  mux.closeAll();
  const n = spawned.length;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(spawned.length, n, 'close 之后不再敲门');
});

test('这台机器上没有会话了就停', async () => {
  let sessions = true;
  const { mux, spawned } = makeMux([{ stderr: forwardFailed(0), exitCode: 255 }], { hasSessions: () => sessions });
  await mux.ensure(target).catch(() => {});
  await until(() => spawned.length >= 2);
  sessions = false;
  await new Promise((r) => setTimeout(r, 150));
  const n = spawned.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(spawned.length, n);
  mux.closeAll();
});

test('退出时 closeAll 明确杀掉自己的 master', async () => {
  const { mux, spawned } = makeMux([{ stderr: allocated(40010) }]);
  await mux.ensure(target);
  mux.closeAll();
  assert.equal(spawned[0].proc.killed, true);
  assert.deepEqual(mux.keys(), []);
});

test('index.ts：自愈判据算上正在 attach 的会话，重建后端口变了就重接', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  /* 只看 sessionClients 会漏掉正在 attach 的那条 —— 实测"正在排重建"之后再没有尝试就是这个 */
  assert.match(M, /hasSessions: \(key: string\): boolean => muxSessionsOn\(key\)\.length > 0/);
  assert.match(M, /function muxSessionsOn[\s\S]{0,700}attachingSessions\.has\(sessionId\)/);
  assert.match(M, /function needsRearm[\s\S]{0,500}spec\.remotePort !== port/);
  assert.match(M, /reconnecting \(attempt \{n\}\)[\s\S]{0,200}\{ n: attempt \}/);
  assert.match(M, /process\.on\('exit', \(\) => \{ try \{ sshMux\.closeAll\(\); \}/);
});

test('端口那句话被管道切成两段到达也认得出来', async () => {
  const { mux, spawned } = makeMux([{ stderr: '' }], { hasSessions: () => false });
  const p = mux.ensure(target);
  await until(() => spawned.length === 1);
  const proc = spawned[0].proc;
  await new Promise((r) => setImmediate(r));
  proc.stderr.emit('data', Buffer.from('Allocated port 412'));
  proc.stderr.emit('data', Buffer.from('35 for remote forward to 127.0.0.1:5000\n'));
  const e = await p;
  assert.equal(e.remotePort, 41235);
  mux.closeAll();
});

test('建立过程中 closeAll：正在握手的 ssh 也要杀掉，之后不许登记、不许 onReady', async () => {
  const { mux, spawned, ready } = makeMux([{ stderr: '' }], { hasSessions: () => true });
  const p = mux.ensure(target);
  await until(() => spawned.length === 1);
  mux.closeAll();
  assert.equal(spawned[0].proc.killed, true, '退出时正在启动的那条也要关掉');
  /* 被杀之后 ssh 才"说"出端口 —— 也不能复活 */
  spawned[0].proc.stderr.emit('data', Buffer.from(allocated(40100)));
  await assert.rejects(p, /被关掉了/);
  assert.deepEqual(ready, []);
  assert.equal(mux.remotePortFor(key), undefined);
  assert.deepEqual(mux.keys(), []);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(spawned.length, 1, '关掉之后不再重建');
});

test('不支持复用时（Windows）：远端已经有人在听的端口不分，撞过一次下一次换端口', async () => {
  const { parseListeningPorts, allocateRemotePort, LISTENING_PORTS_SCRIPT } = await import('../src/main/remoteLocalTools.ts');
  /* 实测那台：39100–39102 被别的 sshd-session 占着 */
  const ss = [
    'LISTEN 0      128        127.0.0.1:39100      0.0.0.0:*',
    'LISTEN 0      128        127.0.0.1:39101      0.0.0.0:*',
    'LISTEN 0      128            [::1]:39102         [::]:*',
    'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*',
    'LISTEN 0      128                *:80               *:*',
  ].join('\n');
  assert.deepEqual(parseListeningPorts(ss).sort((a, b) => a - b), [22, 80, 39100, 39101, 39102]);
  const netstat = [
    'Active Internet connections (only servers)',
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State',
    'tcp        0      0 127.0.0.1:39100         0.0.0.0:*               LISTEN',
    'tcp6       0      0 :::22                   :::*                    LISTEN',
  ].join('\n');
  assert.deepEqual(parseListeningPorts(netstat).sort((a, b) => a - b), [22, 39100]);
  assert.deepEqual(parseListeningPorts(''), []);
  assert.equal(allocateRemotePort([...parseListeningPorts(ss)]), 39103, '跳过别人占着的');
  /* 另一台电脑刚刚抢走了 39103：下一次准备时现问，就换到 39104 */
  assert.equal(allocateRemotePort([...parseListeningPorts(`${ss}\nLISTEN 0 128 127.0.0.1:39103 0.0.0.0:*`)]), 39104);
  assert.match(LISTENING_PORTS_SCRIPT, /ss -Htln/);
  assert.match(LISTENING_PORTS_SCRIPT, /netstat -tln/);
  /* 接线：回退那支每次准备都现问远端，并且问不到不挡会话 */
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  assert.match(M, /runRemoteCapture\(remote, LISTENING_PORTS_SCRIPT, 15_000\)\s*\.then\(parseListeningPorts, \(\) => \[\] as number\[\]\)/);
  assert.match(M, /\.\.\.remoteBusy,\s*\];\s*remotePort = allocateRemotePort\(used\);/);
});
