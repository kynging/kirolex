import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  SshMux, sshErrorKind, sessionsFullMessage, spareControlPath, masterArgs, muxKey,
  MAX_SPARES, FULL_COOLDOWN_MS,
} from '../src/main/sshMux.ts';
import { setUiLang } from '../src/main/uiText.ts';

/*
  「Session open refused by peer」—— 2026-10-22 实测（tokyo-arm）：一台机器的所有执行器共用一条
  ssh 复用连接，每个执行器占它上面一个 session，而 sshd 默认 `MaxSessions 10`。正好 10 个时
  切换组合、远端清理全都报这句英文，界面上看不出原因。
*/

describe('报错 → 种类（纯函数）', () => {
  test('mux 下 sshd 拒开 session：Session open refused by peer', () => {
    assert.equal(sshErrorKind('mux_client_request_session: session request failed: Session open refused by peer'), 'sessions-full');
    /* 混在别的 stderr 里也要认出来（后量子告警每次都有） */
    assert.equal(sshErrorKind('** WARNING: connection is not using a post-quantum key exchange algorithm.\r\nmux_client_request_session: session request failed: Session open refused by peer\r\n'), 'sessions-full');
  });

  test('另一种说法：administratively prohibited: open failed', () => {
    assert.equal(sshErrorKind('channel 3: open failed: administratively prohibited: open failed'), 'sessions-full');
  });

  test('无关的报错不算', () => {
    for (const s of [
      'Permission denied (publickey,gssapi-keyex,gssapi-with-mic).',
      'Connection timed out during banner exchange',
      'ssh: connect to host 1.2.3.4 port 22: Connection refused',
      'Warning: remote port forwarding failed for listen port 39100',
      'Control socket connect(/tmp/kirolex-mux/x): No such file or directory',
      '',
    ]) assert.equal(sshErrorKind(s), 'other', s);
    assert.equal(sshErrorKind(undefined as any), 'other');
  });

  test('给人看的话：机器名、MaxSessions、默认 10、「安装 AI 工具」调到 64、关掉几条', () => {
    setUiLang('zh');
    const m = sessionsFullMessage('tokyo-arm');
    assert.match(m, /^tokyo-arm 的 SSH 会话数满了/);
    assert.match(m, /MaxSessions/);
    assert.match(m, /默认 10/);
    assert.match(m, /安装 AI 工具/);
    assert.match(m, /64/);
    assert.match(m, /关掉几条不用的远程会话/);
    assert.doesNotMatch(m, /refused/, '不再是那句英文');
  });
});

describe('备用主连接', () => {
  test('ControlPath 在原路径后加序号', () => {
    assert.equal(spareControlPath('/tmp/kirolex-mux/std-0a1b2c3d', 2), '/tmp/kirolex-mux/std-0a1b2c3d-2');
  });

  test('备用的 master 不带反向隧道（隧道归第一条，远端端口所有会话共用）', () => {
    const a = masterArgs({ sshHost: 'u@h', socket: '/tmp/s-2', localPort: 5000, forward: false });
    assert.equal(a.includes('-R'), false);
    assert.equal(a.includes('ExitOnForwardFailure=yes'), false);
    assert.ok(a.includes('ControlMaster=yes'));
    assert.ok(a.includes('ControlPath=/tmp/s-2'));
    /* 默认照旧带隧道 */
    assert.ok(masterArgs({ sshHost: 'u@h', socket: '/tmp/s', localPort: 5000 }).includes('-R'));
  });

  function fakeProc(stderr?: string): any {
    const p: any = new EventEmitter();
    p.killed = false; p.exitCode = null;
    p.stderr = new EventEmitter();
    p.kill = () => { p.killed = true; if (p.exitCode === null) { p.exitCode = 143; p.emit('exit', 143); } };
    setImmediate(() => { if (stderr) p.stderr.emit('data', Buffer.from(stderr)); });
    return p;
  }

  function makeMux(now: { t: number }) {
    const spawned: { args: string[]; proc: any }[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muxfull-'));
    const mux = new SshMux({
      log: () => {},
      localPort: () => 5000,
      owner: 'test',
      hasSessions: () => true,
      spawnSsh: (args) => {
        const proc = fakeProc(args.includes('-R') ? 'Allocated port 41000 for remote forward to 127.0.0.1:5000' : '');
        spawned.push({ args, proc });
        return proc;
      },
      probeSocket: async () => true,
      platform: 'linux',
      socketWaitMs: 2_000,
      now: () => now.t,
    }, dir);
    return { mux, spawned };
  }

  const target = { sshHost: 'ec2-user@166.117.109.70', sshPort: 22 };

  test('满了 → 开第二条；之后新执行器优先用有空位的那条；冷却过了再回第一条', async () => {
    const now = { t: 1_000_000 };
    const { mux, spawned } = makeMux(now);
    const main = await mux.ensure(target);
    assert.equal(mux.liveSocketFor(target), main.socket);

    mux.markFull(main.socket);
    const spare = await mux.openSpare(target);
    assert.equal(spare, spareControlPath(main.socket, 2));
    assert.equal(spawned.length, 2);
    assert.equal(spawned[1].args.includes('-R'), false);
    assert.equal(mux.liveSocketFor(target), spare, '第一条满着，新的走第二条');

    /* 同时好几条会话撞上满：共用这一条，不各开一条 */
    assert.equal(await mux.openSpare(target), spare);
    assert.equal(spawned.length, 2);

    now.t += FULL_COOLDOWN_MS + 1;
    assert.equal(mux.liveSocketFor(target), main.socket, '冷却过了，第一条上的执行器可能已经退了，回去试');
    mux.close(muxKey(target.sshHost, target.sshPort));
    assert.equal(spawned[1].proc.killed, true, '关机器时备用的也要关');
  });

  test('第二条也满了 → 第三条；备用最多开 MAX_SPARES 条', async () => {
    const now = { t: 1_000_000 };
    const { mux } = makeMux(now);
    const main = await mux.ensure(target);
    mux.markFull(main.socket);
    const opened: string[] = [];
    for (let i = 0; i < MAX_SPARES; i += 1) {
      const s = await mux.openSpare(target);
      assert.ok(s);
      opened.push(s!);
      mux.markFull(s!);
    }
    assert.equal(new Set(opened).size, MAX_SPARES);
    assert.equal(await mux.openSpare(target), undefined, '到顶了就不再开，交给报错说人话');
    mux.closeAll();
  });

  test('备用的退出了就不再用它', async () => {
    const now = { t: 1_000_000 };
    const { mux, spawned } = makeMux(now);
    const main = await mux.ensure(target);
    mux.markFull(main.socket);
    const spare = await mux.openSpare(target);
    assert.equal(mux.liveSocketFor(target), spare);
    spawned[1].proc.kill();
    assert.equal(mux.liveSocketFor(target), main.socket);
    mux.closeAll();
  });

  test('没有第一条（还没建 / Windows）就不开备用', async () => {
    const { mux } = makeMux({ t: 0 });
    assert.equal(await mux.openSpare(target), undefined);
  });
});

describe('接线（源码断言）', () => {
  const SH = fs.readFileSync(path.join(process.cwd(), 'scripts/remote-bootstrap.sh'), 'utf8');
  const step = SH.slice(SH.indexOf('step "sshd 回收死连接"'), SH.indexOf('step "自检"'));

  test('bootstrap：ClientAliveInterval 和 MaxSessions 分别判断，MaxSessions 写 64', () => {
    assert.match(step, /grep -qs '\^ClientAliveInterval' "\$F" \|\| NEED_ALIVE=1/);
    assert.match(step, /grep -qs '\^MaxSessions' "\$F" \|\| NEED_SESS=1/);
    assert.match(step, /'MaxSessions 64'/);
    assert.doesNotMatch(step, /if sudo grep -qs '\^ClientAliveInterval' "\$F"; then\s+say "→ 已配置/, '不能再是「有 ClientAlive 就整步跳过」');
    /* 先校验再 reload，校验不过还原 */
    assert.ok(step.indexOf('sshd -t') < step.indexOf('systemctl reload'));
    assert.match(step, /60-kirolex\.conf\.bak "\$F"; else sudo rm -f "\$F"/);
  });

  /*
    真跑脚本里那一步：sudo / sshd / systemctl 换成桩，配置文件和备份放到临时目录。
    reload 失败时不许再说「已开」—— 原来末尾一个 `|| true` 把失败吞了。
  */
  function runStep(opts: { existing?: string; sshdRc: number; reloadRc: number }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kxsshd-'));
    const conf = `${dir.replace(/\\/g, '/')}/60-kirolex.conf`;
    const bak = `${dir.replace(/\\/g, '/')}/bak`;
    if (opts.existing !== undefined) fs.writeFileSync(conf, opts.existing);
    const body = step
      .replace('F=/etc/ssh/sshd_config.d/60-kirolex.conf', `F='${conf}'`)
      .replace(/\/tmp\/60-kirolex\.conf\.bak/g, bak);
    const stubs = [
      'say() { echo "SAY $*"; }', 'note_fail() { echo "FAIL $*"; }', 'step() { :; }',
      'sudo() { [ "$1" = -n ] && shift; "$@"; }',
      `sshd() { return ${opts.sshdRc}; }`, `systemctl() { return ${opts.reloadRc}; }`,
    ].join('\n');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-c', `${stubs}\n${body}`], { encoding: 'utf8', timeout: 120_000 });
    const after = fs.existsSync(conf) ? fs.readFileSync(conf, 'utf8') : null;
    fs.rmSync(dir, { recursive: true, force: true });
    return { out: `${r.stdout}${r.stderr}`, after };
  }

  test('bootstrap 真跑：reload 失败 → 还原（原来没有文件就删掉）、报失败、不说「已开」', () => {
    const r = runStep({ sshdRc: 0, reloadRc: 1 });
    assert.match(r.out, /FAIL sshd 重新加载失败/);
    assert.doesNotMatch(r.out, /已开/);
    assert.equal(r.after, null, '原来没有这个文件，新写的要删掉');
    const old = '# old\nClientAliveInterval 30\nClientAliveCountMax 4\n';
    const r2 = runStep({ existing: old, sshdRc: 0, reloadRc: 1 });
    assert.equal(r2.after, old, '原来有文件就还原成原样');
    assert.doesNotMatch(r2.out, /已开/);
  });

  test('bootstrap 真跑：老机器只有 ClientAlive → 只补 MaxSessions 64；reload 成功才说「已开」', () => {
    const old = 'ClientAliveInterval 30\nClientAliveCountMax 4\n';
    const r = runStep({ existing: old, sshdRc: 0, reloadRc: 0 });
    assert.match(r.after || '', /^MaxSessions 64$/m);
    assert.equal((r.after || '').match(/^ClientAliveInterval/gm)?.length, 1, '已有的那项不重复写');
    assert.match(r.out, /SAY → 已开：一条连接最多 64 个会话/);
    assert.doesNotMatch(r.out, /FAIL/);
  });

  test('bootstrap 真跑：两项都有 → 已配置；sshd -t 不过 → 还原', () => {
    const both = 'ClientAliveInterval 30\nMaxSessions 64\n';
    assert.match(runStep({ existing: both, sshdRc: 0, reloadRc: 0 }).out, /已配置/);
    const bad = runStep({ sshdRc: 1, reloadRc: 0 });
    assert.match(bad.out, /FAIL sshd 配置校验没过/);
    assert.equal(bad.after, null);
  });

  test('执行器 / 预检 / 远端命令撞上满了都走同一个处理', () => {
    const A = fs.readFileSync(path.join(process.cwd(), 'src/main/acp-client.ts'), 'utf8');
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(A, /sshErrorKind\(this\.lastStderr\) === 'sessions-full'/);
    assert.match(M, /setMuxSessionsFullHandler\(/);
    assert.match(M, /sshMux\.openSpare\(/);
    assert.match(M, /sessionsFullMessage\(/);
    const pre = M.slice(M.indexOf('async function runPreflight'), M.indexOf('async function runPreflight') + 6000);
    assert.match(pre, /sshErrorKind\(out\.stderr\) === 'sessions-full'/);
    const cap = M.slice(M.indexOf('function runRemoteCapture'), M.indexOf('function runRemoteCapture') + 2500);
    assert.match(cap, /sshErrorKind\(/);
  });
});
