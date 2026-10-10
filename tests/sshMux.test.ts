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

/*
  上面那个 `listenOn` 起的是**文件路径上的** unix socket，探活也按 `isSocket()` 判 —— Windows 上
  `net.listen(<文件路径>)` 要的是 `\\.\pipe\…` 命名管道，`isSocket()` 永远 false。而 Win32-OpenSSH
  本来就不支持 ControlMaster，产品代码在那里走 `muxSupported()` 的回退（见文件末尾那一组），
  所以这几条只在 POSIX 上有意义。
*/
const UNIX_SOCKETS = { skip: process.platform === 'win32' && 'unix socket + ControlMaster 是 POSIX 才有的；Windows 走 muxSupported() 回退' };

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

  test('僵尸 socket：文件在但没人 listen —— 要能认出来并删掉', UNIX_SOCKETS, async () => {
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

  test('并发 ensure 只起一个 master —— 否则只有第一条会话有工具', UNIX_SOCKETS, async () => {
    const dir = tmpDir();
    const spawned: string[][] = [];
    const mux = new SshMux({
      log: () => {},
      localPort: () => 51234,
      usedRemotePorts: () => [],
      allocateRemotePort: () => 39100,
      owner: 'ca7bbd',
      /* 自愈的判据（必填 —— 漏传就等于悄悄关掉自愈）。这里报「没有会话」，
         所以这些用例不会因为重建而多出一次 spawn。 */
      hasSessions: () => false,
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

  test('master 死了 liveSocketFor 立刻返回 undefined —— 宁可明确失败，不要静默降级', UNIX_SOCKETS, async () => {
    const dir = tmpDir();
    let fake: any;
    const mux = new SshMux({
      log: () => {},
      localPort: () => 1,
      usedRemotePorts: () => [],
      allocateRemotePort: () => 39100,
      owner: 'ca7bbd',
      /* 自愈的判据（必填 —— 漏传就等于悄悄关掉自愈）。这里报「没有会话」，
         所以这些用例不会因为重建而多出一次 spawn。 */
      hasSessions: () => false,
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
      master 是 `ssh -N`，不带 `--agent`，所以 `kirolex-local-` 这个判据抓不到它。
      漏掉的后果不是"多一个进程"：那条 ssh 还连着，远端的 sshd 和 kiro-cli 也就都还活着 ——
      这正是那条把 EC2 压死的累积链的第一环。
    */
    const line = `ssh -N -o ControlPath=/var/folders/x/T/${MUX_DIR}/ca7bbd-1a2b3c4d -R 127.0.0.1:39100:127.0.0.1:5 u@h`;
    assert.ok(line.includes(`${MUX_DIR}/`));
    /* `muxMarker` 带 owner，给的是"哪条是我起的"这种需要区分归属的地方用 */
    assert.ok(muxMarker('ca7bbd').startsWith(`${MUX_DIR}/`));

    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /!line\.includes\(SESSION_AGENT_PREFIX\) && !line\.includes\(`\$\{MUX_DIR\}\/`\)/);
    /* 退出时也要关掉：留着就是下一次启动要扫的垃圾 */
    assert.match(M, /sshMux\.closeAll\(\)/);
  });

  test('本机这一轮**不**按 owner 过滤 —— owner 在同一台 Mac 上分不出两份 KiroLex', () => {
    /*
      owner 是 `主机名 + 用户名` 的 hash：standard 和 flow 跑在同一台 Mac 上时它完全一样。
      而本机 `ps` 里只有这台 Mac 自己的进程，所以按 owner 过滤什么都分不出来，只会漏 ——
      实测这次启动时留着 4 条 PPID==1 的 ssh，名字是改 owner **之前**生成的
      `kirolex-local-s_…`，一条都没被认出来，而那台 EC2 当时正在报 banner exchange 超时。

      分得清归属的是 PPID：别人那份活着的 ssh 挂在它自己的 Electron 底下（PPID≠1）；
      PPID==1 的那些谁的父进程都没了，不属于任何人。
    */
    const legacy = "ssh -o BatchMode=yes -R 127.0.0.1:39104:127.0.0.1:63000 u@h bash -lc 'kiro-cli acp --agent kirolex-local-s_1789629414597_kqrsee'";
    assert.ok(legacy.includes('kirolex-local-'), '老名字也得认出来');
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf('function sweepStrayLocalSsh');
    const body = M.slice(at, at + 1400);
    assert.equal(/OWNED_AGENT_PREFIX/.test(body), false, '本机这一轮不按 owner 过滤');
    assert.match(body, /Number\(m\[2\]\) !== 1/, 'PPID==1 才是判据');
    /* 远端那一轮**照旧**按 owner —— 那台机器是好几台笔记本共用的 */
    assert.match(M, /sweepAgentsScript\(OWNER\)/);
    assert.match(M, /orphanSweepScript\(OWNER\)/);
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

  test('支持复用时端口归机器 —— 换 agent / 换模型不用换端口', () => {
    /*
      老 bug：换 agent 是**先起新执行器、成功了再关旧的**（故意的，失败时不丢会话），
      而新 ssh 去绑这条会话原来那个端口时旧 ssh 还占着，`ExitOnForwardFailure=yes`
      于是让它直接失败 —— 报出来是 `ssh exit 255`，看起来像掉线，其实必然发生、重试必然再撞。
      端口归机器之后这个类别整个消失。
    */
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf('async function ensureLocalTools');
    const body = M.slice(at, M.indexOf('function sweepStrayLocalSsh'));
    assert.match(body, /remotePort = \(await sshMux\.ensure\(remote\)\)\.remotePort;/);
    /*
      **Windows 上仍然是按会话分**（那儿没有连接复用，见「Windows：复用不可用时…」那一组）,
      所以 `allocateRemotePort` 还在 —— 它在回退那一支里。这一条只断言"支持复用时走复用"。
    */
    assert.match(body, /if \(muxSupported\(\)\) \{/);
  });
});

/*
 * **只起一个 MCP server** —— 做「重复利用」时挖出来的一个真 bug（而且是它先存在、复用把它照出来）。
 *
 * 原来：`if (!localMcpServer) localMcpServer = await startLocalMcp(...)`。那个 `await` 前面
 * 没有闸门，而 `ensureLocalTools` 是 7 条会话**同时**进来的 —— 七条都看到 `undefined`，
 * 于是起了**七个** HTTP server（实测 `lsof` 里 61713–61719 全在 listen），变量只剩最后一个。
 * 前六条会话的 token 登记在变量已经不指向的那些 server 上。
 *
 * 以前不致命：一条会话一条隧道，各自通向"自己那次"起的 server，七个 server 只是白占端口。
 * 共用一条隧道之后立刻致命 —— 隧道通向最后那个，**六条会话的工具全 404**，而且静默
 * （实测：7 个 token 里 6 个 404，只有最后登记的那条 200）。模型那边的表现是"这个文件不存在"。
 *
 * 和端口竞态、preflight 风暴同一个病：await 前面少一道"已经有人在做了"的闸门。
 */
describe('本地 MCP server 只起一个', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('并发进来时复用同一个启动 promise', () => {
    assert.match(M, /let localMcpStarting: Promise<LocalMcpServer> \| undefined;/);
    const at = M.indexOf('function ensureLocalMcpServer()');
    assert.ok(at > 0);
    const body = M.slice(at, at + 700);
    /* 三条分支：已经有了 / 正在起 / 自己起 —— 少中间那条就是七个 server */
    assert.match(body, /if \(localMcpServer\) return Promise\.resolve\(localMcpServer\);/);
    assert.match(body, /if \(localMcpStarting\) return localMcpStarting;/);
    assert.match(body, /\.finally\(\(\) => \{ localMcpStarting = undefined; \}\)/);
  });

  test('`ensureLocalTools` 里不再有裸的 `if (!localMcpServer) await`', () => {
    const at = M.indexOf('async function ensureLocalTools');
    const body = M.slice(at, M.indexOf('function sweepStrayLocalSsh'));
    assert.equal(/if \(!localMcpServer\)/.test(body), false);
    assert.match(body, /const server = await ensureLocalMcpServer\(\);/);
    /* 注册和端口都取**这一个** server，不要再读那个可能被覆盖的模块变量 */
    assert.match(body, /server\.register\(\{ sessionId, workdir: localDir \}\)/);
    assert.match(body, /localPort: server\.port\(\)/);
    assert.equal(/localMcpServer\.(register|port|setProxies|urlPathFor)/.test(body), false);
  });

  test('隧道的本地端口取的就是那一个 server', () => {
    /* mux 的 `localPort()` 和会话注册用的必须是同一个 server —— 不然隧道通向一个空的注册表 */
    assert.match(M, /localPort: \(\) => localMcpServer\?\.port\(\) \|\| 0,/);
  });
});

/*
 * **杀执行器要杀整棵树** ——「❌ Error invoking remote method 'acp:switch-model':
 * Error: Session not connected 现在怎么 opus 5 也无法切换过去」。
 *
 * 远端是两层：`kiro-cli`（报出来的那个 `$$`）→ `kiro-cli-chat`（**真正握着会话锁的是它**；
 * `acp --help` 的 usage 行也写着 `kiro-cli-chat acp`，说明 kiro-cli 只是个启动器）。
 *
 * 只杀父进程 → 子进程被 reparent 到 1 继续活着 → 锁还在它手上 → 紧接着那次 `session/load`
 * 撞上"会话在另一个进程里"，ACP 上只报一句 `Internal error`。而换模型那条路是
 * "杀旧的 → 起新的 → 新的 load 失败 → 回滚也 load 失败"，最后这条会话一个执行器都没有，
 * 之后每次换模型都是 `Session not connected`。
 *
 * 实测：用户连试三次换模型，远端就多三个 PPID==1 的 `kiro-cli-chat`（etime 5:32 / 2:50 / 2:40）。
 * 顺带确认了模型本身没问题 —— 在那台机器上直接 `kiro-cli chat --model claude-opus-5.5`
 * 秒回 OK（0.23 credits），而且 `acp --help` 里 `--model` 一字没变（远端是 1.27.0）。
 */
describe('断开时杀掉整棵远端进程树', () => {
  test('先收子孙再收父进程，而且每一步都不许让整句失败', async () => {
    const { remoteKillTree } = await import('../src/main/acp-client.ts');
    const sh = remoteKillTree(4242);
    assert.match(sh, /pgrep -P 4242/, '先找出它的子进程');
    assert.match(sh, /kill -TERM \$g/, '子进程要杀');
    assert.match(sh, /kill -TERM \$gg/, '孙子也杀（漏一层就是又一个握着锁的孤儿）');
    assert.match(sh, /kill -TERM 4242/, '最后才是父进程');
    /* 顺序要求：父进程死在子进程之后 —— 反过来的话子进程在被杀之前就已经 reparent 了 */
    assert.ok(sh.indexOf('kill -TERM $g') < sh.lastIndexOf('kill -TERM 4242'));
    /* `|| true`：某一步"它已经自己走了"不该让后面几步不执行 */
    assert.ok((sh.match(/\|\| true/g) || []).length >= 3);
  });

  test('**不**用进程组 —— sshd 不保证给这条命令一个独立的组', async () => {
    const { remoteKillTree } = await import('../src/main/acp-client.ts');
    const sh = remoteKillTree(7);
    /* `kill -- -<pgid>` 打偏会连着这条连接上别的东西一起杀 */
    assert.equal(/kill\s+--?\s*-\d/.test(sh), false);
    assert.equal(/pgid/.test(sh), false);
  });

  test('断开那一支用的就是它', () => {
    const A = fs.readFileSync(path.join(process.cwd(), 'src/main/acp-client.ts'), 'utf8');
    assert.match(A, /buildSshArgs\(this\.remote, remoteKillTree\(pid\)\)/);
    /*
      老写法（在**调用点**直接拼一句只杀父进程的 kill）不该还在。
      注意不能光搜 `kill -TERM ${pid}` —— `remoteKillTree` 自己最后一行就是它（那是对的，
      它在杀完子孙之后才收父进程）。要查的是调用点有没有绕过这个函数。
    */
    assert.equal(/buildSshArgs\(this\.remote, `kill/.test(A), false);
  });

  test('换模型必须先放锁再加载 —— 所以"先起新的"这条路走不通，得靠杀干净', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf("ipcMain.handle('acp:switch-model'");
    const body = M.slice(at, at + 3000);
    /* kiro-cli 的会话是单进程独占的：同一个 cliSessionId 不可能同时被两个进程 load */
    assert.match(body, /Session is active in another process/);
    /* 没连着的时候不再是一句 Session not connected：休眠时直接写记录、下次挂起时生效（见 dormantSwitch.test.ts） */
    assert.match(body, /if \(!oldEntry\) \{[\s\S]*?setDormantProfile\(sessionId/);
    assert.doesNotMatch(body, /throw new Error\('Session not connected'\)/);
  });
});

/*
 * 「我让它找一个纯远程的项目但它总是在本地找」。
 *
 * 没有本地工程时 `localProjectDirOf` 会退回 KiroLex 自己的会话目录
 * （`~/.kirolex/sessions/<id>/`，里面只有 record.json / transcript.jsonl / history.md），
 * 而注入里那套"他的仓库和工具链在他机器上、构建测试 git 用 local_bash"照样发了出去 ——
 * 对一个纯远程的工程这些话是**反的**，于是它拿 `local_grep` 去搜那个会话目录，
 * 搜不到就回"找不到这个项目"。
 */
describe('纯远程工程：别把它往本机引', () => {
  test('没有本地工程时不讲那套"他的文件在他机器上"', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const noProject = remoteContextBlock({
      hostLabel: 'tokyo', remoteDir: '/home/ec2-user/work', localDir: '/Users/k/.kirolex/sessions/s_1',
      hasLocalProject: false,
    });
    assert.match(noProject, /这条会话没有本地工程/);
    assert.match(noProject, /别拿 `local_glob` \/ `local_grep` 去搜用户的 Mac/);
    /* 那两条会把人引到错的机器上的规则必须消失 */
    assert.equal(/在\*\*他的工程\*\*上跑构建/.test(noProject), false);
    assert.equal(/工具链都在那边/.test(noProject), false);
    /* 但 local_* 本身还在 —— 用户指名的路径、交回产出都要用它 */
    assert.match(noProject, /local_write/);
  });

  test('有本地工程时照旧', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const withProject = remoteContextBlock({
      hostLabel: 'tokyo', remoteDir: '/home/ec2-user/work', localDir: '/Users/k/git/proj',
      hasLocalProject: true,
    });
    assert.match(withProject, /用户的文件在他自己那台机器上/);
    assert.match(withProject, /在\*\*他的工程\*\*上跑构建/);
    assert.equal(/这条会话没有本地工程/.test(withProject), false);
  });

  test('判据要排除草稿目录 —— 只看"localDir 有没有值"是错的', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    /*
      **上一版这条是错的**，而且实测撞到了（用户：「为什么现在有远程会话在你本机跑了 xx 的提示」）：
      那条没归项目的远程会话记录里 `localDir` 就是 `~/.kirolex/sessions/<id>` ——
      **草稿目录本身被持久化进去了**。于是 `!!entry.localDir` 是 true，注入里那套
      "他的仓库和工具链在他机器上、构建测试用 local_bash"照样发了出去，
      而那条会话根本没有本地工程。表现就是它一直往用户的 Mac 上跑命令。

      主进程知道确切路径，所以直接和 `getSessionDir(sessionId)` 比 —— 精确判断比正则可靠,
      也省掉一份会慢慢长歪的重复实现（渲染层那个 `isSessionScratchDir` 是按形状匹配的,
      它没有 sessionId 可用）。
    */
    /* 后来 cwd 固定成会话的 files/，"有没有本地工程"就只看项目设没设工作目录 */
    assert.match(M, /hasLocalProject: !!projectWorkspaceFor\(entry\.profile\),/);
    assert.equal(/hasLocalProject: !!entry\.localDir,/.test(M), false, '那个只看有没有值的写法不该还在');
  });
});

/*
 * **Windows 上没有连接复用这条路** ——「看一下有没有 windows 上不能跑的东西」。
 *
 * Win32-OpenSSH 根本没实现多路复用（`ControlMaster` / `ControlPath` 它不认），而这个模块的
 * 探活是 unix domain socket 形状的：`statSync().isSocket()` 在 Windows 上永远 false，
 * `net.connect(<文件路径>)` 在 Windows 上要的是 `\\.\pipe\…` 命名管道。
 *
 * 连起来的后果是致命的：`ensureLocalTools` 会 await `sshMux.ensure()`，于是每条远程会话
 * 等满 12 秒然后抛「复用连接没建起来」——**一条都起不来**。这是加复用时引入的回归
 * （复用之前每条会话自己一条 ssh、自己一个 `-R` 端口，在 Windows 上是好的）。
 */
describe('Windows：复用不可用时回到每会话一条隧道', () => {
  test('平台判据是 process.platform，不是"试一次看看"', async () => {
    const { muxSupported } = await import('../src/main/sshMux.ts');
    assert.equal(muxSupported('win32'), false);
    assert.equal(muxSupported('darwin'), true);
    assert.equal(muxSupported('linux'), true);
    /* 试的代价是每条会话 12 秒，而答案是平台决定的、不会变 */
    const S = fs.readFileSync(path.join(process.cwd(), 'src/main/sshMux.ts'), 'utf8');
    assert.match(S, /platform !== 'win32'/);
  });

  test('`ensure` 在不支持的平台上明确抛错，而不是返回 undefined', async () => {
    const S = fs.readFileSync(path.join(process.cwd(), 'src/main/sshMux.ts'), 'utf8');
    /* undefined 很容易被当成"还没建好、等一下再看" */
    assert.match(S, /if \(!muxSupported\(\)\) throw new Error\('MUX_UNSUPPORTED'\);/);
  });

  test('接线：不支持就自己分端口，ssh 自己带 -R（也就是复用之前的行为）', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf('async function ensureLocalTools');
    const body = M.slice(at, M.indexOf('function sweepStrayLocalSsh'));
    assert.match(body, /if \(muxSupported\(\)\) \{/);
    assert.match(body, /remotePort = \(await sshMux\.ensure\(remote\)\)\.remotePort;/);
    /* 回退那支：按会话分端口，并且把自己当前那个也算进"已占用" */
    assert.match(body, /remotePort = allocateRemotePort\(used\);/);
    assert.match(body, /const used = \[\s*\.\.\.\[\.\.\.localToolsBySession\.values\(\)\]\.map\(\(v\) => v\.remotePort\),/);
    /* 还活着的旧 ssh 占着的也算（两条会话同时换引擎时撞过） */
    assert.match(body, /\.\.\.\[\.\.\.sessionClients\.values\(\)\]\.map\(\(e\) => e\.client\.forwardedRemotePort\)/);
    /* 这句话一次就够 —— 每条会话都说一遍是噪音 */
    assert.match(M, /let muxWarned = false;/);
  });

  test('回退时 `buildSshArgs` 必须走带 -R 的那一支', async () => {
    const { buildSshArgs, setMuxSocketResolver } = await import('../src/main/acp-client.ts');
    try {
      /* 没有复用连接 → resolver 返回 undefined → 老路（自己建连接 + 自己的隧道） */
      setMuxSocketResolver(() => undefined);
      const args = buildSshArgs(
        { sshHost: 'u@h', identityFile: '/k.pem' } as any,
        'kiro-cli acp',
        { remotePort: 39100, localPort: 51234 },
      );
      assert.ok(args.includes('-R'));
      assert.ok(args.includes('127.0.0.1:39100:127.0.0.1:51234'));
      assert.ok(args.includes('ExitOnForwardFailure=yes'));
      assert.equal(args.some((a) => String(a).includes('ControlPath')), false);
    } finally {
      setMuxSocketResolver(undefined);
    }
  });
});
