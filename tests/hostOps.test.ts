import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LocalHost, SshHost, hostFor, loadTimeoutFor,
  LOAD_TIMEOUT_LOCAL_MS, LOAD_TIMEOUT_REMOTE_MS, SSH_OP_TIMEOUT_MS,
} from '../src/main/hostOps.ts';
import { isSshTransportExit, sshDropMessage, isTransientTransportError, SSH_TRANSPORT_EXIT } from '../src/main/transientError.ts';

/*
 * 远程会话（docs/DESIGN_remote_sessions.md）的地基。
 *
 * 实测把设计定死的那一条：**kiro-cli 不用 ACP 的客户端 fs 能力** —— 客户端声明了
 * `fs.readTextFile/writeTextFile` 之后让它读一个文件，它自己读（工具调用 `Reading marker.txt:2-2`），
 * 回调客户端 0 次，`initialize` 回的 agentCapabilities 里也没有 fs。也就是说远端执行器只能看见
 * 远端的文件系统，于是 KiroLex 这一年攒的取证（kiro-chat.log / ~/.kiro/sessions/cli）在远程会话上
 * 全都指错机器。这个模块就是那一层"读哪台机器"。
 */

function tmpWithLogs(files: Record<string, number | string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostops-'));
  fs.mkdirSync(path.join(dir, 'kiro-log'), { recursive: true });
  for (const [name, v] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'kiro-log', name), typeof v === 'number' ? Buffer.alloc(v) : v);
  }
  return dir;
}

describe('LocalHost：就是现在那套 fs，只是换了个门', () => {
  test('readTail 只要尾部；文件不在返回空串（诊断永远不能让发送失败）', async () => {
    const dir = tmpWithLogs({ 'kiro-chat.log': 'abcdefghij' });
    const h = new LocalHost({ TMPDIR: dir } as any);
    const f = path.join(dir, 'kiro-log', 'kiro-chat.log');
    assert.equal(await h.readTail(f, 4), 'ghij');
    assert.equal(await h.readTail(f, 1000), 'abcdefghij', '比文件还大就是整个文件');
    assert.equal(await h.readTail(path.join(dir, 'nope.log'), 10), '');
  });

  test('readAll 用 null 表示"没有这个文件"—— 和"文件是空的"必须分得开', async () => {
    const dir = tmpWithLogs({ 'a.log': '', 'b.log': 'xy' });
    const h = new LocalHost({} as any);
    assert.equal(await h.readAll(path.join(dir, 'kiro-log', 'a.log'), 99), '');
    assert.equal(await h.readAll(path.join(dir, 'kiro-log', 'b.log'), 99), 'xy');
    assert.equal(await h.readAll(path.join(dir, 'kiro-log', 'nope.log'), 99), null);
    /* failureBundle 靠这个区别决定要不要写那一份：空文件会让人对着一包空证据找原因 */
  });

  test('listSizes 按后缀过滤，目录不在返回空数组', async () => {
    const dir = tmpWithLogs({ 'kiro-chat.log': 3, 'lsp.log': 5, 'notes.txt': 7 });
    const h = new LocalHost({} as any);
    const rows = (await h.listSizes(path.join(dir, 'kiro-log'), '.log')).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(rows, [{ name: 'kiro-chat.log', bytes: 3 }, { name: 'lsp.log', bytes: 5 }]);
    assert.deepEqual(await h.listSizes('/nope/kiro-log', '.log'), []);
  });

  test('truncate 是截断 —— 文件还在，长度归零（这就是那 21.72GB 的教训）', async () => {
    const dir = tmpWithLogs({ 'lsp.log': 2048 });
    const f = path.join(dir, 'kiro-log', 'lsp.log');
    await new LocalHost({} as any).truncate(f);
    assert.equal(fs.existsSync(f), true, '文件必须还在');
    assert.equal(fs.statSync(f).size, 0);
  });

  test('HOME 可以被 env 盖掉 —— 测试要能把 kiro-cli 的会话目录指到临时目录', async () => {
    assert.equal(await new LocalHost({ HOME: '/h' } as any).home(), '/h');
    assert.equal(await new LocalHost({ TMPDIR: '/t' } as any).tmpdir(), '/t');
  });
});

describe('SshHost：命令拼对了，失败一律吞成空', () => {
  const deps = {
    buildSshArgs: (r: any, cmd: string) => ['-p', String(r.sshPort || 22), r.sshHost, cmd],
    shellQuote: (s: string) => `'${s.replace(/'/g, `'\\''`)}'`,
  };
  const remote = { enabled: true, sshHost: 'ec2-user@1.2.3.4', sshPort: 22 } as any;

  /** 不真连：把 run() 换掉，只看它想跑什么。 */
  function spy(): { host: SshHost; cmds: string[] } {
    const host = new SshHost(remote, deps);
    const cmds: string[] = [];
    (host as any).run = async (script: string) => {
      cmds.push(script);
      if (/printf "%s/.test(script)) return '/tmp\n/home/ec2-user\n';
      if (/stat -c/.test(script)) return "1024 kiro-chat.log\n2048 lsp.log\n";
      if (/test -f/.test(script)) return 'hello\n__OK__';
      return 'tail-output';
    };
    return { host, cmds };
  }

  test('readTail 用 tail -c，路径带引号', async () => {
    const { host, cmds } = spy();
    assert.equal(await host.readTail('/tmp/kiro-log/kiro chat.log', 4096), 'tail-output');
    assert.match(cmds[0], /^tail -c 4096 '\/tmp\/kiro-log\/kiro chat\.log' 2>\/dev\/null \|\| true$/);
  });

  test('readAll 先 test -f，所以"没有文件"和"空文件"分得开', async () => {
    const { host, cmds } = spy();
    assert.equal(await host.readAll('/x/a.json', 1024), 'hello');
    assert.match(cmds[0], /test -f '\/x\/a\.json' && head -c 1024/);
    (host as any).run = async () => '__NO__';
    assert.equal(await host.readAll('/x/b.json', 1024), null);
  });

  test('listSizes 解析 stat -c 的两列输出', async () => {
    const { host } = spy();
    assert.deepEqual(await host.listSizes('/tmp/kiro-log', '.log'), [
      { name: 'kiro-chat.log', bytes: 1024 },
      { name: 'lsp.log', bytes: 2048 },
    ]);
  });

  test('truncate 用 `truncate -s 0`，**不是 rm** —— 远端同样有"删了空间不回来"的问题', async () => {
    const { host, cmds } = spy();
    await host.truncate('/tmp/kiro-log/lsp.log');
    assert.match(cmds[0], /truncate -s 0 '\/tmp\/kiro-log\/lsp\.log'/);
    assert.equal(/\brm\b/.test(cmds[0]), false);
  });

  test('tmpdir/home 只问一次，之后走缓存 —— 每次多一个 SSH 往返没有意义', async () => {
    const { host, cmds } = spy();
    assert.equal(await host.tmpdir(), '/tmp');
    assert.equal(await host.home(), '/home/ec2-user');
    assert.equal(await host.tmpdir(), '/tmp');
    assert.equal(cmds.length, 1, `问了 ${cmds.length} 次`);
  });

  test('问不到也给一个能试的路径 —— 直接放弃取证是更糟的选择', async () => {
    const host = new SshHost(remote, deps);
    (host as any).run = async () => '';
    assert.equal(await host.tmpdir(), '/tmp');
    assert.match(await host.home(), /^\/home\//);
  });

  test('label 是 sshHost —— 错误消息里必须说得出是哪台机器', () => {
    assert.equal(new SshHost(remote, deps).label, 'ec2-user@1.2.3.4');
    assert.equal(new LocalHost({} as any).label, '本地');
  });

  test('一次诊断 SSH 有上限 —— 取证宁可拿不到，也不能让失败路径挂在这儿', () => {
    assert.equal(SSH_OP_TIMEOUT_MS, 15_000);
  });
});

describe('hostFor：没有 remote 就是本地（本地路径行为一个字节都没变）', () => {
  const deps = { buildSshArgs: () => [], shellQuote: (s: string) => s };
  test('undefined / 没有 sshHost 都判本地', () => {
    assert.equal(hostFor(undefined, deps as any).kind, 'local');
    assert.equal(hostFor({ enabled: true } as any, deps as any).kind, 'local', 'sshHost 是空的不能当远程');
  });
  test('有 sshHost 才是 ssh', () => {
    assert.equal(hostFor({ sshHost: 'h' } as any, deps as any).kind, 'ssh');
  });
});

/*
 * 「session/load 超时（12s 无响应）」那次把本地上限调到 45s：切模型要起一个**冷的** kiro-cli，
 * 实测常规 attach 的 session/load 用了 32 秒。远端还要加 SSH 握手 + 远端冷启动。
 */
describe('起执行器的超时按机器分', () => {
  test('远端给得更宽 —— 同一个数字会把"慢一点"判成"起不来"，然后去做没必要的重建', () => {
    assert.equal(loadTimeoutFor(undefined), LOAD_TIMEOUT_LOCAL_MS);
    assert.equal(loadTimeoutFor({ sshHost: 'h' } as any), LOAD_TIMEOUT_REMOTE_MS);
    assert.ok(LOAD_TIMEOUT_REMOTE_MS > LOAD_TIMEOUT_LOCAL_MS);
    assert.equal(LOAD_TIMEOUT_LOCAL_MS, 45_000, '本地那个数字是实测校准过的，别顺手改');
  });

  test('接线：三个 loadSession 都按会话的 remote 取上限', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    /* 数量会随功能增加（换机器那条路又多了一处），所以钉的是"**每一处** withLoadTimeout 都带上限" */
    const all = M.match(/withLoadTimeout\(/g) || [];
    const withTimeout = M.match(/withLoadTimeout\([\s\S]{0,120}?loadTimeoutFor\(/g) || [];
    assert.equal(withTimeout.length, all.length, `${all.length} 处 withLoadTimeout，只有 ${withTimeout.length} 处带了 host 上限`);
    assert.ok(all.length >= 4);
  });
});

/*
 * SSH 掉线是**进程退出**，不是一句错误文本 —— 这是远程会话和本地最容易踩错的一处。
 */
describe('ssh exit 255 = 掉线，可自动重发', () => {
  test('255 才算，别的退出码照旧', () => {
    assert.equal(isSshTransportExit(255), true);
    assert.equal(SSH_TRANSPORT_EXIT, 255);
    for (const c of [0, 1, 2, 127, null, undefined]) {
      assert.equal(isSshTransportExit(c as any), false, String(c));
    }
  });

  test('那句话必须被"瞬时传输错误"认出来，否则 planRetry 不会重发', () => {
    assert.equal(isTransientTransportError(sshDropMessage(255)), true);
    assert.match(sshDropMessage(255), /255/);
  });

  test('接线：只有远程执行器才这么判（本地 code 0 那条语义不动）', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/main/acp-client.ts'), 'utf8');
    assert.match(src, /this\.remote\?\.sshHost && isSshTransportExit\(code\)/);
    assert.match(src, /tr\('The executor exited normally \(code 0\)/, '本地那句话必须还在');
  });
});

describe('取证接线：远程会话读远端那份', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('index 里有唯一一个 host 工厂，SSH 参数复用 buildSshArgs', () => {
    assert.match(M, /const diagHost = \(remote\?: RemoteTarget\): HostOps => hostFor\(remote, \{ buildSshArgs, shellQuote \}\);/);
  });

  test('失败那一刻的两样证据都按会话的 remote 取机器', () => {
    assert.match(M, /await cliErrorContext\(diagHost\(entry\.profile\.remote\)\)/);
    assert.match(M, /host: diagHost\(entry\.profile\.remote\),/);
  });
});
