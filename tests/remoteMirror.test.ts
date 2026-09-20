import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_EXCLUDES, SYNC_TIMEOUT_MS, mirrorDirFor, sessionMirrorDir, posixJoin, mapIntoMirror,
  sshCommandFor, pushArgs, pullArgs, parseIncoming, isExcluded, snapshotDir, locallyChanged,
  conflictsBetween, conflictCopyPath, RemoteMirror, type MirrorIo, type RunResult,
} from '../src/main/remoteMirror.ts';
import { judgePreflight, preflightScript, REQUIRED_TOOLS } from '../src/main/remotePreflight.ts';

/*
 * 远程会话：**文件在本地，执行在远端**（docs/DESIGN_remote_sessions.md）。
 *
 * 为什么必须搬文件 —— 实测：客户端声明了 ACP 的 `fs.readTextFile/writeTextFile` 之后让 kiro-cli
 * 读一个文件，它自己读（工具调用 `Reading marker.txt:2-2`），回调客户端 **0 次**，
 * `initialize` 回的 agentCapabilities 里也没有 fs。远端执行器只能看见远端文件系统。
 *
 * 机制也是实测过的（本机 openrsync 2.6.9 兼容 ↔ 远端 rsync 3.4.0 / AL2023）：推带 --delete、
 * 排除 node_modules 之后远端只剩该有的；`--dry-run --itemize-changes` 的输出就是下面这个形状，
 * 其中本地也改过的那个（c.txt）正是要挡住的冲突。
 */
const REAL_ITEMIZE = [
  '.d..t.... ./',
  '>f.st.... a.txt',
  '>f.st.... c.txt',
  '>f+++++++ d.txt',
  'cd+++++++ sub/',
  '<f.st.... never-sent-up.txt',
].join('\n');

const remote = { sshHost: 'ec2-user@1.2.3.4', sshPort: 22, remoteWorkdir: '/home/ec2-user/kirolex-mirror' } as any;
const SSHC = 'ssh -i /k.pem -o BatchMode=yes';

describe('镜像路径', () => {
  test('带一段本地路径的哈希 —— 两个同名项目不能叠到一个镜像里', () => {
    const a = mirrorDirFor('/wd', '/Users/k/code/blog');
    const b = mirrorDirFor('/wd', '/Users/k/work/blog');
    assert.match(a, /^\/wd\/blog-[0-9a-f]{8}$/);
    assert.notEqual(a, b, 'basename 一样但路径不同，镜像必须分开');
    assert.equal(mirrorDirFor('/wd', '/Users/k/code/blog'), a, '同一个路径必须稳定');
  });

  test('会话目录单独一份 —— 它在项目目录之外（history.md、附件都在里面）', () => {
    assert.equal(sessionMirrorDir('/wd', 's_1'), '/wd/.kirolex-sessions/s_1');
  });

  test('远端一律 POSIX 路径，多余的斜杠不留', () => {
    assert.equal(posixJoin('/wd/', '/a/', 'b/'), '/wd/a/b');
  });

  test('本地路径映射进镜像；映射不了就原样返回（调用方要能看出来）', () => {
    assert.equal(mapIntoMirror('/l', '/r/m', '/l/src/a.ts'), '/r/m/src/a.ts');
    assert.equal(mapIntoMirror('/l', '/r/m', '/other/a.ts'), '/other/a.ts');
    assert.equal(mapIntoMirror('/l', '/r/m', '/l'), '/l', '根本身没有相对路径');
  });
});

describe('rsync 参数', () => {
  const spec = { remote, localDir: '/l/proj', remoteDir: '/r/proj', sshCommand: SSHC };

  test('推带 --delete —— 镜像必须和本地一模一样（清的是镜像，安全）', () => {
    const a = pushArgs(spec as any);
    assert.ok(a.includes('--delete'));
    assert.deepEqual(a.slice(-2), ['/l/proj/', 'ec2-user@1.2.3.4:/r/proj/']);
    assert.equal(a.filter((x) => x === '--exclude').length, DEFAULT_EXCLUDES.length);
  });

  test('拉**不带** --delete —— 你这一轮新建的本地文件不该因为远端没有就消失', () => {
    const a = pullArgs(spec as any);
    assert.equal(a.includes('--delete'), false, '这一条是数据安全，不是风格');
    assert.deepEqual(a.slice(-2), ['ec2-user@1.2.3.4:/r/proj/', '/l/proj/']);
  });

  test('dry-run 带 itemize，输出格式固定（冲突判定靠它）', () => {
    const a = pullArgs({ ...spec, dryRun: true } as any);
    assert.ok(a.includes('--dry-run') && a.includes('--itemize-changes'));
    assert.ok(a.includes('--out-format=%i %n'));
  });

  test('冲突文件用 `/rel` 排除 —— 只挡同步根下那一条，不是所有同名文件', () => {
    const a = pullArgs({ ...spec, skip: ['src/a.ts'] } as any);
    const i = a.indexOf('/src/a.ts');
    assert.ok(i > 0 && a[i - 1] === '--exclude');
  });

  test('node_modules 一定在排除里 —— darwin 的原生二进制在 Linux 上是错的，不只是慢', () => {
    assert.ok(DEFAULT_EXCLUDES.includes('node_modules/'));
    /* `.git` 反过来必须同步：没有它 agent 的 git status/diff/log 全废，它会开始瞎猜 */
    assert.equal(DEFAULT_EXCLUDES.some((p) => /^\.git/.test(p)), false);
  });

  test('SSH 选项只有一个来源 —— 从 buildSshArgs 里借，host 和远端命令都去掉', () => {
    const buildSshArgs = (r: any, cmd: string) => ['-i', '/k.pem', '-o', 'BatchMode=yes', '-p', '22', r.sshHost, cmd];
    const s = sshCommandFor(remote, buildSshArgs as any);
    assert.equal(s, 'ssh -i /k.pem -o BatchMode=yes -p 22');
    assert.equal(/1\.2\.3\.4/.test(s), false, 'host 不能留在 -e 里，rsync 自己会接');
  });
});

describe('解析 itemize（用的是实测输出）', () => {
  test('只认"收到一个普通文件"，目录和反方向都不算', () => {
    assert.deepEqual(parseIncoming(REAL_ITEMIZE), ['a.txt', 'c.txt', 'd.txt']);
  });
  test('空输出、垃圾输入都不炸', () => {
    assert.deepEqual(parseIncoming(''), []);
    assert.deepEqual(parseIncoming('sending incremental file list\n\n'), []);
  });
});

describe('排除判据', () => {
  test('目录、后缀、原样名字', () => {
    assert.equal(isExcluded('node_modules/react/index.js'), true);
    assert.equal(isExcluded('src/node_modules/x.js'), true, '嵌在里面的也算');
    assert.equal(isExcluded('a/b.log'), true);
    assert.equal(isExcluded('.DS_Store'), true);
    assert.equal(isExcluded('src/index.ts'), false);
    assert.equal(isExcluded('.git/config'), false, '.git 是要同步的');
  });
});

describe('快照 / 冲突', () => {
  function tree(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'one');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two');
    fs.writeFileSync(path.join(dir, 'x.log'), 'noise');
    fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'junk');
    return dir;
  }

  test('快照只含要同步的文件，键是相对路径', () => {
    const dir = tree();
    const snap = snapshotDir(dir);
    assert.deepEqual(Object.keys(snap).sort(), ['b.txt', 'src/a.ts']);
  });

  test('变过的认出来；删掉的不算（拉不带 --delete，拉不回来）', () => {
    const dir = tree();
    const before = snapshotDir(dir);
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'one-CHANGED');
    fs.writeFileSync(path.join(dir, 'new.ts'), 'n');
    fs.rmSync(path.join(dir, 'b.txt'));
    assert.deepEqual(locallyChanged(before, snapshotDir(dir)), ['new.ts', 'src/a.ts']);
  });

  test('冲突要**两边都满足** —— 判宽了每一轮正常编辑都会报冲突，然后人就不看这个提示了', () => {
    assert.deepEqual(conflictsBetween(['a.txt', 'c.txt', 'd.txt'], ['c.txt', 'e.txt']), ['c.txt']);
    assert.deepEqual(conflictsBetween(['a.txt'], []), [], '只有远端改 = 常态，不是冲突');
    assert.deepEqual(conflictsBetween([], ['x']), [], '只有本地改 = 远端没碰，不是冲突');
  });

  test('冲突时远端那份放旁边，**不动**你的文件', () => {
    assert.equal(conflictCopyPath('/l', 'src/a.ts'), path.join('/l', 'src/a.ts.remote'));
  });
});

/** 记下每条命令，按需给桩输出。 */
function fakeIo(answers: (cmd: string) => Partial<RunResult> = () => ({})): { io: MirrorIo; cmds: string[][] } {
  const cmds: string[][] = [];
  const io: MirrorIo = {
    async run(file, args) {
      cmds.push([file, ...args]);
      const a = answers([file, ...args].join(' '));
      return { code: a.code ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
    },
  };
  return { io, cmds };
}

describe('RemoteMirror：推', () => {
  test('先建目标目录，再 rsync；成功要带上耗时和快照', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mir2-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'x');
    const { io, cmds } = fakeIo();
    const m = new RemoteMirror({ remote, localDir: dir, remoteDir: '/r/p', sshCommand: SSHC, io });
    const r = await m.push();
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.snapshot), ['a.ts']);
    assert.match(cmds[0].join(' '), /^ssh .* mkdir -p '\/r\/p'$/);
    assert.equal(cmds[1][0], 'rsync');
  });

  test('推失败要报错（调用方据此**不发这一轮**）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mir3-'));
    const { io } = fakeIo((c) => (c.startsWith('rsync') ? { code: 12, stderr: 'rsync: connection unexpectedly closed\nmore' } : {}));
    const m = new RemoteMirror({ remote, localDir: dir, remoteDir: '/r/p', sshCommand: SSHC, io });
    const r = await m.push();
    assert.equal(r.ok, false);
    assert.match(r.error!, /connection unexpectedly closed/);
    assert.equal(/\n/.test(r.error!), false, '只要第一行，别把一屏 rsync 输出灌进界面');
  });
});

describe('RemoteMirror：拉 + 冲突分流', () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mir4-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'keep');
    return dir;
  }

  test('本地改过的那个不被覆盖，远端那份落成 .remote', async () => {
    const dir = setup();
    let dryCount = 0;
    const { io, cmds } = fakeIo((c) => {
      if (c.includes('--dry-run')) { dryCount += 1; return { stdout: REAL_ITEMIZE }; }
      return {};
    });
    const m = new RemoteMirror({ remote, localDir: dir, remoteDir: '/r/p', sshCommand: SSHC, io });
    await m.push();
    /* 一轮跑着的时候你改了 c.txt —— 这是唯一的冲突窗口 */
    fs.writeFileSync(path.join(dir, 'c.txt'), 'keep-LOCAL');
    const r = await m.pull();

    assert.equal(dryCount, 1, '先 dry-run 才知道会动哪些');
    assert.deepEqual(r.conflicts, ['c.txt']);
    assert.deepEqual(r.changed, ['a.txt', 'd.txt'], '冲突的那个不算"已更新"');
    /* "正式那次拉" = 源是远端、不是 dry-run。按参数**顺序**认，否则推的目的地也是同一串，会认错 */
    const realPull = cmds.find((c) => c[0] === 'rsync' && !c.includes('--dry-run')
      && c[c.length - 2] === 'ec2-user@1.2.3.4:/r/p/');
    assert.ok(realPull, '要有一次真正的拉');
    assert.ok(realPull!.includes('/c.txt'), '冲突文件必须被排除在正式拉之外');
    const copy = cmds.find((c) => c[0] === 'rsync' && c.some((x) => x.endsWith('c.txt.remote')));
    assert.ok(copy, '远端那份要单独取成 .remote');
    assert.equal(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'keep-LOCAL', '你的版本一个字都不能动');
  });

  test('没冲突时不做多余的事', async () => {
    const dir = setup();
    const { io, cmds } = fakeIo((c) => (c.includes('--dry-run') ? { stdout: '>f.st.... a.txt' } : {}));
    const m = new RemoteMirror({ remote, localDir: dir, remoteDir: '/r/p', sshCommand: SSHC, io });
    await m.push();
    const r = await m.pull();
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(r.changed, ['a.txt']);
    assert.equal(cmds.filter((c) => c.some((x) => x.endsWith('.remote'))).length, 0);
  });

  test('**拉完重记快照** —— 不重记的话刚拉下来的文件会在下一轮全被报成冲突', async () => {
    const dir = setup();
    /* 这个假 io **真的写文件** —— 不写的话"拉完重记快照"就没被测到（真 rsync 会写） */
    const io: MirrorIo = {
      async run(file, args) {
        const cmd = [file, ...args].join(' ');
        if (file === 'rsync' && args.includes('--dry-run')) return { code: 0, stdout: '>f.st.... a.txt', stderr: '' };
        if (file === 'rsync' && args[args.length - 2] === 'ec2-user@1.2.3.4:/r/p/') {
          fs.writeFileSync(path.join(dir, 'a.txt'), `from-remote ${cmd.length}`);
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const m = new RemoteMirror({ remote, localDir: dir, remoteDir: '/r/p', sshCommand: SSHC, io });
    await m.push();
    const first = await m.pull();
    assert.deepEqual(first.conflicts, [], 'push 之后没人动过本地，不该有冲突');
    const second = await m.pull();
    assert.deepEqual(second.conflicts, [], '第二次也不该把上一次拉下来的东西当成"你改的"');
  });

  test('dry-run 失败就不往下拉 —— 不知道会动什么的时候不许动', async () => {
    const dir = setup();
    const { io, cmds } = fakeIo((c) => (c.includes('--dry-run') ? { code: 255, stderr: 'ssh: connect timeout' } : {}));
    const m = new RemoteMirror({ remote, localDir: dir, remoteDir: '/r/p', sshCommand: SSHC, io });
    const r = await m.pull();
    assert.equal(r.ok, false);
    assert.match(r.error!, /connect timeout/);
    assert.equal(cmds.filter((c) => c[0] === 'rsync').length, 1, '只有那次 dry-run');
  });

  test('一次同步的上限够一个大仓库第一次全量推', () => {
    assert.equal(SYNC_TIMEOUT_MS, 10 * 60 * 1000);
  });
});

/*
 * 连远端之前先问三句话。不问的代价不是"少一条提示"，而是失败伪装成别的东西：
 * 没装 rsync → 推送失败 → 界面上是"这一轮没发出去"；远端没登录 → 执行器起得来但每轮空回，
 * 看起来就是那个查了一整天的 EmptyResponse。
 */
describe('远端预检', () => {
  test('一条命令问清工具和登录', () => {
    const s = preflightScript();
    for (const b of REQUIRED_TOOLS) assert.ok(s.includes(b), `缺 ${b}`);
    assert.match(s, /kiro-cli whoami/);
    /* 构建链不在要求里 —— 远程会话不做构建/测试 */
    assert.equal(/npm|node|cargo|libreoffice/i.test(s), false);
  });

  test('连不上：给 ssh 的原话，并且**不能**把后量子告警当成原因', () => {
    const r = judgePreflight(255, '', '** WARNING: connection is not using a post-quantum key exchange algorithm.\nssh: connect to host port 22: Operation timed out', remote);
    assert.equal(r.code, 'unreachable');
    assert.match(r.message, /Operation timed out/);
    assert.equal(/post-quantum/.test(r.message), false, '那条告警每次都有，认它会让每次都指错');
  });

  test('缺工具：说清缺哪个 + 给出跑预置脚本的那一条命令', () => {
    const r = judgePreflight(0, 'HAVE kiro-cli\nMISS rsync\nHAVE git\nAUTH ok', '', remote);
    assert.equal(r.code, 'missing-tools');
    assert.deepEqual(r.missing, ['rsync']);
    assert.match(r.message, /remote-bootstrap\.sh/);
    assert.match(r.message, /不替你在远端装东西/, '在别人机器上装东西要人点头');
  });

  test('没登录单独一句 —— 这个症状最容易被当成服务端故障', () => {
    const r = judgePreflight(0, 'HAVE kiro-cli\nHAVE rsync\nHAVE git\nAUTH no', '', remote);
    assert.equal(r.code, 'not-logged-in');
    assert.match(r.message, /kiro-cli login/);
    assert.match(r.message, /空回/);
  });

  test('缺工具优先于没登录 —— 缺 rsync 的时候谈登录没有意义', () => {
    const r = judgePreflight(0, 'MISS kiro-cli\nMISS rsync\nHAVE git\nAUTH no', '', remote);
    assert.equal(r.code, 'missing-tools');
  });

  test('都齐了就 ok', () => {
    const r = judgePreflight(0, 'HAVE kiro-cli\nHAVE rsync\nHAVE git\nAUTH ok', '', remote);
    assert.equal(r.code, 'ok');
    assert.match(r.message, /已登录/);
  });

  test('非零退出但有输出：按输出判（有些 shell 会带回非零）', () => {
    const r = judgePreflight(1, 'HAVE kiro-cli\nHAVE rsync\nHAVE git\nAUTH ok', '', remote);
    assert.equal(r.code, 'ok');
  });
});

/*
 * 真机集成测试：默认**跳过**。给了 KIROLEX_TEST_REMOTE=<sshHost> 才跑
 * （再加 KIROLEX_TEST_REMOTE_KEY=<identityFile> 和可选的 KIROLEX_TEST_REMOTE_DIR）。
 *
 * 它验的正是上面那些桩替掉的东西：openrsync ↔ 远端 rsync 真的能互通、排除真的生效、
 * itemize 的输出真的是那个形状、冲突真的被挡住。
 */
const RHOST = process.env.KIROLEX_TEST_REMOTE;
describe('真机同步（默认跳过）', { skip: RHOST ? false : '没给 KIROLEX_TEST_REMOTE' }, () => {
  test('推 → 远端改 → 拉：冲突挡住、其余同步', async () => {
    const { realIo } = await import('../src/main/remoteMirror.ts');
    const key = process.env.KIROLEX_TEST_REMOTE_KEY;
    const sshCommand = ['ssh', '-o', 'BatchMode=yes', ...(key ? ['-i', key] : [])].join(' ');
    const target = { enabled: true, sshHost: RHOST!, sshPort: 22 } as any;
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-real-'));
    fs.mkdirSync(path.join(localDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(localDir, 'node_modules', 'junk.js'), 'junk');
    fs.writeFileSync(path.join(localDir, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(localDir, 'c.txt'), 'keep\n');
    const remoteDir = posixJoin(process.env.KIROLEX_TEST_REMOTE_DIR || '/tmp/kirolex-mirror-test', path.basename(localDir));

    const m = new RemoteMirror({ remote: target, localDir, remoteDir, sshCommand, io: realIo });
    assert.equal((await m.push()).ok, true);

    const opts = sshCommand.split(' ').slice(1);
    const changed = await realIo.run('ssh', [...opts, RHOST!,
      `printf 'one-CHANGED\\n' > ${remoteDir}/a.txt; printf 'new\\n' > ${remoteDir}/d.txt; test -d ${remoteDir}/node_modules && echo LEAKED || echo CLEAN`], 60_000);
    assert.match(changed.stdout, /CLEAN/, 'node_modules 不该被推上去');

    fs.writeFileSync(path.join(localDir, 'c.txt'), 'keep-LOCAL\n');
    const pulled = await m.pull();
    assert.equal(pulled.ok, true, pulled.error);
    assert.deepEqual(pulled.conflicts, ['c.txt']);
    assert.equal(fs.readFileSync(path.join(localDir, 'a.txt'), 'utf8'), 'one-CHANGED\n');
    assert.equal(fs.readFileSync(path.join(localDir, 'd.txt'), 'utf8'), 'new\n');
    assert.equal(fs.readFileSync(path.join(localDir, 'c.txt'), 'utf8'), 'keep-LOCAL\n', '本地那份不能动');
    assert.equal(fs.readFileSync(path.join(localDir, 'c.txt.remote'), 'utf8'), 'keep\n');
    await realIo.run('ssh', [...opts, RHOST!, `rm -rf ${remoteDir}`], 60_000);
  });
});

/*
 * 实测（起一条真的远程会话、让它在远端写一个文件）抓到的 bug：文件落在
 * `<workdir>/s_<sessionId>-<hash>/` 里，而同步的是 `<workdir>/<项目>-<hash>/` ——
 * 那个文件永远回不到本地，界面上看起来就是"模型说做了，本地什么都没有"。
 *
 * 根因：新建会话那条路把**每会话的临时目录**当 cwd（`sessionCwd(profile, sessionDir)`），
 * 而 attach 那条用的是项目目录。本地会话无所谓（都在本机），远程会话就成了两个不同的镜像。
 */
describe('远程会话的 cwd = 项目镜像（不是会话目录的镜像）', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('新建会话：远程用项目目录，本地保持原样', () => {
    assert.match(M, /const cliCwd = profile\.remote\?\.sshHost\s*\n\s*\? sessionCwd\(profile, resolvedCwd\)\s*\n\s*: sessionCwd\(profile, sessionDir\);/);
  });

  test('attach 那条本来就是项目目录 —— 两条路对远程必须一致', () => {
    assert.match(M, /const cliCwd = sessionCwd\(profile, resolvedCwd\);/);
  });

  test('登记同步用的也是项目目录（否则 cwd 和镜像还是两回事）', () => {
    assert.match(M, /registerRemoteSync\(kiroLexId, profile, resolvedCwd\)/);
    assert.match(M, /registerRemoteSync\(sessionId, profile, resolvedCwd\)/);
  });

  test('会话目录另有自己的镜像位置，和项目镜像不会重名', () => {
    assert.notEqual(sessionMirrorDir('/wd', 's_1'), mirrorDirFor('/wd', '/anything/s_1'));
    assert.match(sessionMirrorDir('/wd', 's_1'), /\.kirolex-sessions/);
  });
});
