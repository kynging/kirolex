import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SshMux, muxKey } from '../src/main/sshMux.ts';
import { RemoteRecovery, RECONNECTING_TEXT, RECOVERED_TEXT } from '../src/main/remoteRecovery.ts';

/*
  **断了的远程会话要一直试到接回来** —— 审查复现的那条路：
  复用 master 断开 → 走在它上面的会话 ssh 也退出、被从 sessionClients 删掉 → 渲染层那一次自动重连
  因为网络还没回来失败 → 这时"这台机器上没有会话"，原来的重建就停了，用户开着的会话永远接不回来。
*/

const BACKOFF = [10, 20, 40];

async function until(cond: () => boolean, ms = 4_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('等超时了');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 一台远端机器 + 一张"网络通不通"的开关：通的时候 ssh 分到端口，不通的时候 255 退出。 */
function world() {
  let net = true;
  let nextPort = 40001;
  const procs: any[] = [];
  const spawnSsh = () => {
    const p: any = new EventEmitter();
    p.killed = false; p.exitCode = null;
    p.stderr = new EventEmitter();
    p.kill = () => { p.killed = true; };
    p.die = (code = 255) => { if (p.exitCode !== null) return; p.exitCode = code; p.emit('exit', code); };
    const up = net;
    setImmediate(() => {
      if (up) p.stderr.emit('data', Buffer.from(`Allocated port ${nextPort++} for remote forward to 127.0.0.1:5000\n`));
      else { p.stderr.emit('data', Buffer.from('ssh: connect to host 99.83.165.184 port 22: Network is unreachable\n')); setImmediate(() => p.die(255)); }
    });
    procs.push(p);
    return p;
  };
  return { procs, spawnSsh, setNet: (v: boolean) => { net = v; } };
}

test('master 和会话连接全断、第一次恢复失败、之后网络恢复 —— 开着的会话自己接回来', async () => {
  const w = world();
  const target = { sshHost: 'ec2-user@99.83.165.184', sshPort: 22 };
  const key = muxKey(target.sshHost, target.sshPort);
  const attached = new Set<string>();
  const portOf = new Map<string, number>();
  const notices: Array<{ sid: string; text: string; sticky: boolean }> = [];
  const recoveredIds: string[] = [];
  let recovery!: RemoteRecovery<{ key: string }>;
  const mux = new SshMux({
    log: () => {},
    localPort: () => 5000,
    owner: 'test',
    /* index.ts 里的判据：活着的执行器 + 正在等这台机器回来的会话 */
    hasSessions: (k) => [...attached].length > 0 || recovery.waitingOn(k).length > 0,
    onReady: (k) => recovery.kick(k),
    spawnSsh: w.spawnSsh,
    probeSocket: async () => true,
    platform: 'linux',
    healBackoffMs: BACKOFF,
    socketWaitMs: 1_000,
  }, fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')));
  recovery = new RemoteRecovery({
    target: () => ({ key }),
    attached: (sid) => attached.has(sid),
    toolless: () => false,
    busy: () => false,
    detach: async (sid) => { attached.delete(sid); },
    ensureConnection: () => mux.ensure(target),
    /* 挂回来 = 拿着这台机器现在的端口起执行器 */
    reattach: async (sid) => {
      const port = mux.remotePortFor(key);
      if (!port) return false;
      attached.add(sid); portOf.set(sid, port);
      return true;
    },
    notice: (sid, text, sticky) => notices.push({ sid, text, sticky }),
    recovered: (sid) => recoveredIds.push(sid),
    backoffMs: BACKOFF,
    staggerMs: 5,
  });

  /* 两条会话开着，工具通道正常 */
  await mux.ensure(target);
  for (const sid of ['A', 'B']) { attached.add(sid); portOf.set(sid, mux.remotePortFor(key)!); }
  assert.equal(portOf.get('A'), 40001);

  /* 断网：master 死了，它上面的会话 ssh 跟着退出（disconnected → 从 sessionClients 删掉 → 进恢复） */
  w.setNet(false);
  w.procs[0].die(255);
  for (const sid of ['A', 'B']) { attached.delete(sid); recovery.start(sid); }
  assert.equal(attached.size, 0, '执行器全没了 —— 原来的判据在这里就会说"没有会话"');

  /* 第一次（以及之后几次）恢复都失败：网络还没回来 */
  await until(() => recovery.attemptOf('A') >= 3);
  assert.equal(attached.size, 0);
  assert.ok(recovery.has('A') && recovery.has('B'), '失败了也不放弃');
  const spawnedWhileDown = w.procs.length;
  assert.ok(spawnedWhileDown >= 3, 'master 也一直在重建');
  const aNotices = notices.filter((n) => n.sid === 'A' && n.sticky).map((n) => n.text);
  assert.deepEqual(aNotices.slice(0, 3), [RECONNECTING_TEXT(1), RECONNECTING_TEXT(2), RECONNECTING_TEXT(3)]);

  /* 网络回来了 */
  w.setNet(true);
  await until(() => recoveredIds.length === 2);
  assert.deepEqual([...attached].sort(), ['A', 'B']);
  assert.ok(portOf.get('A')! > 40001, '接回来用的是这次新分到的端口');
  assert.equal(portOf.get('A'), mux.remotePortFor(key));
  assert.ok(notices.some((n) => n.sid === 'A' && n.text === RECOVERED_TEXT() && !n.sticky), '接上后那句"正在重连"被顶掉');
  assert.equal(recovery.keys().length, 0);
  mux.closeAll();
});

test('没有复用连接（Windows）：会话自己的 ssh 断了，按退避一直重连，首次失败后自动恢复', async () => {
  let netUp = false;
  const attached = new Set<string>();
  const notices: string[] = [];
  const recovered: string[] = [];
  let tries = 0;
  const recovery = new RemoteRecovery({
    target: () => ({ key: 'u@h:22' }),
    attached: (sid) => attached.has(sid),
    toolless: () => false,
    busy: () => false,
    detach: async (sid) => { attached.delete(sid); },
    /* Windows：没有 ensureConnection，每次就是整条 attach（里面重新查远端占用、重新分端口） */
    reattach: async (sid) => { tries += 1; if (!netUp) throw new Error('remote port forwarding failed for listen port 39101'); attached.add(sid); return true; },
    notice: (_sid, text) => notices.push(text),
    recovered: (sid) => recovered.push(sid),
    backoffMs: BACKOFF,
  });
  recovery.start('W');
  await until(() => tries >= 2);
  assert.equal(attached.size, 0);
  netUp = true;
  await until(() => recovered.length === 1);
  assert.ok(attached.has('W'));
  assert.equal(notices[0], RECONNECTING_TEXT(1));
  assert.equal(notices.at(-1), RECOVERED_TEXT());
});

test('用户归档 / 删除 / 切回本地之后就停（每次动手前按记录再判一次）', async () => {
  let wanted = true;
  let tries = 0;
  const recovery = new RemoteRecovery({
    target: () => (wanted ? { key: 'k' } : undefined),
    attached: () => false, toolless: () => false, busy: () => false,
    detach: async () => {},
    reattach: async () => { tries += 1; return false; },
    notice: () => {},
    backoffMs: BACKOFF,
  });
  recovery.start('X');
  await until(() => tries >= 1);
  wanted = false;
  await new Promise((r) => setTimeout(r, 120));
  const n = tries;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(tries, n);
  assert.equal(recovery.has('X'), false);
});

test('连着但没有本地工具：不在跑就换执行器重接；正在跑一轮就不打断、过会儿再看', async () => {
  const attached = new Set<string>(['T']);
  const toolless = new Set<string>(['T']);
  let busy = true;
  const detached: string[] = [];
  const recovered: string[] = [];
  const recovery = new RemoteRecovery({
    target: () => ({ key: 'k' }),
    attached: (sid) => attached.has(sid),
    toolless: (sid) => toolless.has(sid),
    busy: () => busy,
    detach: async (sid) => { detached.push(sid); attached.delete(sid); toolless.delete(sid); },
    reattach: async (sid) => { attached.add(sid); return true; },
    notice: () => {},
    recovered: (sid) => recovered.push(sid),
    backoffMs: BACKOFF,
  });
  recovery.start('T', { quiet: true });
  await until(() => recovery.attemptOf('T') >= 2);
  assert.deepEqual(detached, [], '正在跑的一轮不打断');
  busy = false;
  await until(() => recovered.length === 1);
  assert.deepEqual(detached, ['T']);
  assert.ok(attached.has('T') && !toolless.has('T'));
});

test('index.ts 接线：执行器意外断开就进恢复；复用连接的判据算上在等的会话；连接回来就叫醒', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const disc = M.slice(M.indexOf("client.on('disconnected'"), M.indexOf("client.on('disconnected'") + 1600);
  assert.match(disc, /if \(sessionClients\.get\(sessionId\) !== entry\) return;/);
  assert.match(disc, /startRemoteRecovery\(sessionId\)/);
  assert.match(M, /for \(const sessionId of remoteRecovery\.waitingOn\(key\)\) ids\.add\(sessionId\);/);
  assert.match(M, /onReady: \(key: string\) => \{[\s\S]{0,300}remoteRecovery\.kick\(key\);/);
  assert.match(M, /reattachSession = ensureAttached;/);
  /* Windows 上本地工具没起来也进恢复（那儿没有 master 自愈来叫重接） */
  assert.match(M, /if \(!muxSupported\(\)\) startRemoteRecovery\(sessionId\);/);
  const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');
  assert.match(P, /ipcRenderer\.on\('acp:reattached', handler\)/);
  const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');
  assert.match(A, /onReattached\?\.\([\s\S]{0,200}addAttached\(sid\);/);
});

/** 一个手动放行的 promise —— 模拟"连接 / 挂载要等几秒"。 */
function gate<T = void>() {
  let open!: (v: T) => void;
  const p = new Promise<T>((r) => { open = r; });
  return { p, open };
}

function cancellable(opts: { connect?: Promise<unknown>; attach?: Promise<unknown> }) {
  let wanted = true;
  const attached = new Set<string>();
  const detached: string[] = [];
  const recovered: string[] = [];
  let reattachCalls = 0;
  let connectCalls = 0;
  const recovery = new RemoteRecovery({
    target: () => (wanted ? { key: 'k' } : undefined),
    attached: (sid) => attached.has(sid),
    toolless: () => false,
    busy: () => false,
    detach: async (sid) => { detached.push(sid); attached.delete(sid); },
    ensureConnection: async () => { connectCalls += 1; await opts.connect; },
    reattach: async (sid) => { reattachCalls += 1; await opts.attach; attached.add(sid); return true; },
    notice: () => {},
    recovered: (sid) => recovered.push(sid),
    backoffMs: BACKOFF,
  });
  return { recovery, attached, detached, recovered, unwant: () => { wanted = false; }, calls: () => ({ reattachCalls, connectCalls }) };
}

test('等连接的时候用户归档了：连接回来后不许再挂上', async () => {
  const conn = gate();
  const c = cancellable({ connect: conn.p });
  c.recovery.start('S');
  await until(() => c.calls().connectCalls === 1);
  c.unwant();                 // 归档 / 删除 / 切回本地 —— target 不再返回
  conn.open();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.calls().reattachCalls, 0, '被关掉之后不该再挂载');
  assert.equal(c.attached.size, 0);
  assert.deepEqual(c.recovered, []);
  assert.equal(c.recovery.has('S'), false);
});

test('等连接的时候 KiroLex 退出（stopAll）：同样不许再挂上', async () => {
  const conn = gate();
  const c = cancellable({ connect: conn.p });
  c.recovery.start('S');
  await until(() => c.calls().connectCalls === 1);
  c.recovery.stopAll();
  conn.open();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.calls().reattachCalls, 0);
  assert.equal(c.attached.size, 0);
  assert.deepEqual(c.recovered, []);
});

test('挂载进行到一半被取消：刚起来的执行器要收掉，不留下', async () => {
  const att = gate();
  const c = cancellable({ attach: att.p });
  c.recovery.start('S');
  await until(() => c.calls().reattachCalls === 1);
  c.unwant();
  att.open();
  await until(() => c.detached.length === 1);
  assert.equal(c.attached.size, 0, '取消之后不留执行器');
  assert.deepEqual(c.recovered, [], '不报"恢复了"');
  assert.equal(c.recovery.has('S'), false);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.calls().reattachCalls, 1, '也不再排下一轮');
});

test('挂载途中退出（stopAll）：同样收掉', async () => {
  const att = gate();
  const c = cancellable({ attach: att.p });
  c.recovery.start('S');
  await until(() => c.calls().reattachCalls === 1);
  c.recovery.stopAll();
  att.open();
  await until(() => c.detached.length === 1);
  assert.equal(c.attached.size, 0);
  assert.deepEqual(c.recovered, []);
});
