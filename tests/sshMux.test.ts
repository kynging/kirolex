import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  SshMux, muxKey, muxMarker, controlPath, masterArgs, clientArgs,
  socketExists, probeSocket, clearStaleSocket, waitFor, MUX_DIR,
} from '../src/main/sshMux.ts';
import { buildSshArgs, setMuxSocketResolver } from '../src/main/acp-client.ts';

/*
 * 「谁让你加上限了，你应该加的是垃圾清理和重复利用」。
 *
 * 复用的判据：那个远端端口唯一的工作是"能连到本机那个 MCP server"，而"你是哪条会话"靠 URL 里的
 * token 区分（`mcp add` 没有 `--headers`）—— 所以**一个端口 + N 个 token** 就够，N 个端口
 * 从一开始就是"一条会话一条 ssh"带出来的副产品。
 *
 * 而它不只是省资源：那台 EC2 卡死时报的是 `Connection timed out during banner exchange`，
 * banner 交换在密钥交换**之前** —— 也就是 sshd 的 `MaxStartups`（默认 10:30:100）满了。
 * 开机 20 条会话 × 最多 3 次重试 = 60 次并发握手。复用之后只有**第一条**做握手，
 * 后面的是同一条连接上的 channel。
 */

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'muxtest-'));

/**
 * 起一个真的 unix socket —— 探活的判据是"连得上"，所以测它必须用真 socket。
 *
 * `unref` + 立刻 destroy 收到的连接：不然 server 和那些 accept 出来的 socket 会把
 * node 的事件循环撑着，整个测试文件跑完之后挂住不退（踩过）。
 */
const servers: net.Server[] = [];
function listenOn(p: string): net.Server {
  const srv = net.createServer((c) => { c.destroy(); });
  srv.listen(p);
  srv.unref();
  servers.push(srv);
  return srv;
}
after(() => { for (const s of servers) { try { s.close(); } catch { /* 已经关了 */ } } });

describe('ssh 连接复用', () => {
  test('一台机器一个 key，端口不同算不同机器', () => {
    assert.equal(muxKey('ec2-user@1.2.3.4'), 'ec2-user@1.2.3.4:22');
    assert.notEqual(muxKey('h', 22), muxKey('h', 2222));
  });

  test('ControlPath 必须短 —— sun_path 只有 104 字节', () => {
    /*
      实测踩点：`ec2-user@ec2-13-231-…ap-northeast-1.compute.amazonaws.com` 一个就 60 多字节，
      拼进 `/var/folders/…/T/` 就超了。超了 ssh 报 `ControlPath too long`，而那条报错混在
      "连接失败"里，看起来像网络问题。所以用 host 的 hash，不用 host 本身。
    */
    const long = 'ec2-user@ec2-13-231-100-200.ap-northeast-1.compute.amazonaws.com';
    const p = controlPath(muxKey(long), 'ca7bbd');
    assert.ok(p.length < 104, `${p.length} 字节：${p}`);
    assert.equal(p.includes(long), false, 'host 不能出现在路径里');
  });

  test('同一台机器路径稳定，不同机器不同', () => {
    const a = controlPath(muxKey('h1'), 'ca7bbd');
    assert.equal(a, controlPath(muxKey('h1'), 'ca7bbd'));
    assert.notEqual(a, controlPath(muxKey('h2'), 'ca7bbd'));
    /* 带 owner：一台 Mac 上可能同时跑着两份 KiroLex（standard 和 flow） */
    assert.notEqual(a, controlPath(muxKey('h1'), 'ffffff'));
  });

  test('master 不带命令、隧道归它，而且端口占用时宁可起不来', () => {
    const args = masterArgs({
      sshHost: 'u@h', socket: '/tmp/s', remotePort: 39100, localPort: 51234, identityFile: '/k.pem', sshPort: 2222,
    });
    assert.ok(args.includes('-N'), '不带命令：没有会话挂在它身上，也就没有哪条会话能带走隧道');
    assert.ok(args.includes('ControlMaster=yes'));
    assert.ok(args.includes('ControlPath=/tmp/s'));
    assert.ok(args.includes('-R') && args.includes('127.0.0.1:39100:127.0.0.1:51234'));
    /* 隧道起不来就整条连不上 —— 不要一个"连上了但没有本地工具"的执行器 */
    assert.ok(args.includes('ExitOnForwardFailure=yes'));
    /* `ControlPersist=no`：进程活着连接才活着。它会 fork 一个后台进程的话，
       我们手上的 pid 和真正持有隧道的那个就不是同一个了 */
    assert.ok(args.includes('ControlPersist=no'));
    assert.ok(args.includes('-i') && args.includes('/k.pem'));
    assert.ok(args.includes('-p') && args.includes('2222'));
    assert.equal(args[args.length - 1], 'u@h', 'master 后面没有命令');
  });

  test('client 走已有连接：不带 -R / -i / -p，而且**不许**自己升级成 master', () => {
    const args = clientArgs({ sshHost: 'u@h', socket: '/tmp/s', remoteCommand: 'echo hi' });
    /*
      `ControlMaster=no` 是关键：不加的话它在 master 不在时自己当 master，
      而它是**带命令**的 —— 命令结束连接就没了，于是隧道被一条会话的退出带走，
      别的会话"突然读不到文件了"。宁可直接失败。
    */
    assert.ok(args.includes('ControlMaster=no'));
    assert.ok(args.includes('ControlPath=/tmp/s'));
    assert.equal(args.includes('-R'), false, '隧道已经在 master 上了，再要一遍就是端口冲突');
    assert.equal(args.includes('-i'), false);
    assert.equal(args.includes('-p'), false);
    assert.equal(args[args.length - 1], 'echo hi');
  });

  test('僵尸 socket：文件在但没人 listen —— 要能认出来并删掉', async () => {
    const dir = tmpDir();
    const p = path.join(dir, 's');
    assert.equal(await probeSocket(p), false, '文件都没有');

    const srv = listenOn(p);
    await waitFor(async () => socketExists(p), 2_000);
    assert.equal(await probeSocket(p), true);

    await new Promise<void>((r) => srv.close(() => r()));
    /*
      close 之后文件通常还在（node 自己会 unlink，但 ssh 崩掉时不会）。
      这里的要求是：**不管文件在不在**，探活都要返回 false —— 否则下一次 master
      因为"文件已存在"起不来，而我们还以为连接是好的。
    */
    assert.equal(await probeSocket(p), false);
    clearStaleSocket(p);
    assert.equal(socketExists(p), false);
  });

  test('并发 ensure 只起一个 master —— 否则只有第一条会话有工具', async () => {
    const dir = tmpDir();
    const spawned: string[][] = [];
    const mux = new SshMux({
      log: () => {},
      localPort: () => 51234,
      usedRemotePorts: () => [],
      allocateRemotePort: () => 39100,
      owner: 'ca7bbd',
      spawnSsh: (args) => {
        spawned.push(args);
        /* 假装 ssh：把 socket 建出来（真 master 做的就是这件事） */
        const sock = args[args.indexOf('-o') + 1];
        const p = String(args.find((a) => a.startsWith('ControlPath=')) || '').slice('ControlPath='.length);
        void sock;
        const srv = listenOn(p);
        const fake = new EventEmitter() as any;
        fake.killed = false;
        fake.exitCode = null;
        fake.stderr = new EventEmitter();
        fake.kill = (): void => { fake.killed = true; srv.close(); };
        return fake;
      },
    }, dir);

    const target = { sshHost: 'u@h' };
    const [a, b, c] = await Promise.all([mux.ensure(target), mux.ensure(target), mux.ensure(target)]);
    assert.equal(spawned.length, 1, '三条会话同时 attach，只该有一次握手');
    assert.equal(a.remotePort, 39100);
    assert.equal(b.remotePort, a.remotePort, '同一台机器共用那一个端口');
    assert.equal(c.socket, a.socket);
    mux.closeAll();
  });

  test('master 死了 liveSocketFor 立刻返回 undefined —— 宁可明确失败，不要静默降级', async () => {
    const dir = tmpDir();
    let fake: any;
    const mux = new SshMux({
      log: () => {},
      localPort: () => 1,
      usedRemotePorts: () => [],
      allocateRemotePort: () => 39100,
      owner: 'ca7bbd',
      spawnSsh: (args) => {
        const p = String(args.find((a) => a.startsWith('ControlPath=')) || '').slice('ControlPath='.length);
        const srv = listenOn(p);
        fake = new EventEmitter() as any;
        fake.killed = false; fake.exitCode = null;
        fake.stderr = new EventEmitter();
        fake.kill = (): void => { fake.killed = true; srv.close(); };
        return fake;
      },
    }, dir);
    await mux.ensure({ sshHost: 'u@h' });
    assert.ok(mux.liveSocketFor({ sshHost: 'u@h' }));
    fake.exitCode = 255;
    fake.emit('exit', 255);
    assert.equal(mux.liveSocketFor({ sshHost: 'u@h' }), undefined);
    mux.closeAll();
  });

  test('buildSshArgs：有复用连接就当 channel 走，没有就照旧建新的', () => {
    const remote: any = { sshHost: 'u@h', identityFile: '/k.pem', sshPort: 2222 };
    try {
      setMuxSocketResolver(() => '/tmp/live');
      const reused = buildSshArgs(remote, 'echo hi', { remotePort: 39100, localPort: 51234 });
      assert.ok(reused.includes('ControlPath=/tmp/live'));
      assert.ok(reused.includes('ControlMaster=no'));
      /* **即便调用方传了 forward 也不带 -R** —— 隧道归 master，重复要一遍就是冲突 */
      assert.equal(reused.includes('-R'), false);

      setMuxSocketResolver(() => undefined);
      const fresh = buildSshArgs(remote, 'echo hi', { remotePort: 39100, localPort: 51234 });
      assert.ok(fresh.includes('-R'));
      assert.ok(fresh.includes('ExitOnForwardFailure=yes'));
      assert.ok(fresh.includes('-i'));
      assert.equal(fresh.includes('ControlPath=/tmp/live'), false);
    } finally {
      /* 这是模块级状态：漏掉这一句会让**后面所有**测到 buildSshArgs 的用例都走复用分支 */
      setMuxSocketResolver(undefined);
    }
  });

  test('开机扫垃圾认得出遗留的 master —— 它命令行里没有 agent 名', () => {
    /*
      master 是 `ssh -N`，不带 `--agent`，所以 `kirolex-local-<owner>-` 这个判据抓不到它。
      漏掉的后果不是"多一个进程"：那条 ssh 还连着，远端的 sshd 和 kiro-cli 也就都还活着 ——
      这正是那条把 EC2 压死的累积链的第一环。
    */
    const marker = muxMarker('ca7bbd');
    assert.ok(marker.includes(MUX_DIR));
    assert.ok(marker.includes('ca7bbd'));
    const line = `ssh -N -o ControlPath=/var/folders/x/T/${MUX_DIR}/ca7bbd-1a2b3c4d -R 127.0.0.1:39100:127.0.0.1:5 u@h`;
    assert.ok(line.includes(marker));
    /* 别人那份 KiroLex 的 master 不该被我们杀 —— 会带走它所有会话的工具通道 */
    assert.equal(line.includes(muxMarker('ffffff')), false);

    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /!line\.includes\(OWNED_AGENT_PREFIX\) && !line\.includes\(muxMarker\(OWNER\)\)/);
    /* 退出时也要关掉：留着就是下一次启动要扫的垃圾 */
    assert.match(M, /sshMux\.closeAll\(\)/);
  });

  test('最后一条会话走了才关 —— 而且关之前再确认一次', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf('function releaseLocalTools');
    const body = M.slice(at, at + 2400);
    assert.match(body, /if \(!hasSessionOn\(remote\)\)/);
    /* 那句 removeAgentScript 是 fire-and-forget 的，而它走的正是这条连接 */
    assert.match(body, /setTimeout\(\(\) => \{\s*if \(hasSessionOn\(remote\)\) return;/);
    /* 判据取活着的执行器，不取记录 —— 记录里"配了远端但没连上"的会话没占用连接 */
    assert.match(M, /function hasSessionOn[\s\S]{0,400}sessionClients\.values\(\)/);
  });

  test('端口不再是会话的东西 —— 换 agent / 换模型不用换端口', () => {
    /*
      老 bug：换 agent 是**先起新执行器、成功了再关旧的**（故意的，失败时不丢会话），
      而新 ssh 去绑这条会话原来那个端口时旧 ssh 还占着，`ExitOnForwardFailure=yes`
      于是让它直接失败 —— 报出来是 `ssh exit 255`，看起来像掉线，其实必然发生、重试必然再撞。
      端口归机器之后这个类别整个消失。
    */
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf('async function ensureLocalTools');
    const body = M.slice(at, M.indexOf('function sweepStrayLocalSsh'));
    assert.match(body, /const mux = await sshMux\.ensure\(remote\);/);
    assert.match(body, /const remotePort = mux\.remotePort;/);
    assert.equal(/allocateRemotePort\(used\)/.test(body), false, '不再按会话分配端口');
  });
});
