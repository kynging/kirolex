import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRemoteTargets, listRemoteTargets, findRemoteTarget, deriveLabel, expandHome } from '../src/main/remoteTargets.ts';
import { RemoteSyncManager, type SyncStatus, type MirrorLike } from '../src/main/remoteSync.ts';
import type { PullResult } from '../src/main/remoteMirror.ts';

/*
 * 「混用粒度按会话选」。所以配置给的是一个**列表**，而不是一个全局开关 ——
 * 老形状 `agents[].remote.enabled` 正是那个要换掉的开关（改一次影响所有会话）。
 */
describe('可选远端的解析', () => {
  test('新形状 remotes[]：缺省值补齐，`~` 展开', () => {
    const [t] = parseRemoteTargets({
      remotes: [{ id: 'tokyo', label: 'tokyo-ec2', sshHost: 'ec2-user@1.2.3.4', identityFile: '~/k.pem' }],
    }, '/home/me');
    assert.equal(t.id, 'tokyo');
    assert.equal(t.label, 'tokyo-ec2');
    assert.equal(t.sshPort, 22);
    assert.equal(t.identityFile, '/home/me/k.pem', '配置里写 ~ 的人不该因此连不上');
  });

  test('**兼容读**老的 agents[].remote —— 用户配置里现在就是这个形状', () => {
    /* 实测那份配置：agents[0].remote = { enabled: false, sshHost: 'ec2-user@99.83.165.184', … } */
    const list = parseRemoteTargets({
      agents: [{ id: 'agent_1', remote: { enabled: false, sshHost: 'ec2-user@9.9.9.9', sshPort: 22 } }],
    });
    assert.equal(list.length, 1, '不兼容读的话得手改配置才能用');
    assert.equal(list[0].id, 'agent_1');
    assert.equal(list[0].label, '9.9.9.9');
  });

  test('`enabled: false` 照样出现在列表里 —— 那个字段原来的意思是"全局开关关着"', () => {
    /* 现在选不选由会话决定，所以它不再能决定一台机器要不要能被选中 */
    const list = parseRemoteTargets({ agents: [{ id: 'a', remote: { enabled: false, sshHost: 'u@h' } }] });
    assert.equal(list.length, 1);
  });

  test('同一台机器不出现两遍 —— 出现两遍人只会怀疑自己选错了', () => {
    const list = parseRemoteTargets({
      remotes: [{ id: 'new', sshHost: 'u@h', sshPort: 22 }],
      agents: [{ id: 'old', remote: { sshHost: 'u@h', sshPort: 22 } }],
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'new', '新形状优先');
  });

  test('没有 sshHost 的条目直接不要 —— 放进列表等于给一个选了必然失败的选项', () => {
    assert.deepEqual(parseRemoteTargets({ remotes: [{ id: 'x' }, { id: 'y', sshHost: '  ' }] }), []);
  });

  test('label 默认取 host（用户名不是用来区分机器的）', () => {
    assert.equal(deriveLabel('ec2-user@1.2.3.4'), '1.2.3.4');
    assert.equal(deriveLabel('devbox'), 'devbox');
    assert.equal(deriveLabel(''), 'remote');
  });

  test('~ 展开只动开头', () => {
    assert.equal(expandHome('~', '/h'), '/h');
    assert.equal(expandHome('~/a/b', '/h'), path.join('/h', 'a/b'));
    assert.equal(expandHome('/abs/~/x', '/h'), '/abs/~/x');
    assert.equal(expandHome(undefined), undefined);
  });

  test('配置坏了返回空 —— 不该让"新建会话"整个不能用', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-')), 'config.json');
    fs.writeFileSync(f, '{ not json');
    assert.deepEqual(listRemoteTargets(f), []);
    assert.equal(findRemoteTarget(f, 'tokyo'), undefined);
  });

  test('按 id 找不到就返回 undefined —— **不猜**一台机器', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt2-'));
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify({ remotes: [{ id: 'a', sshHost: 'u@h' }, { id: 'b', sshHost: 'u@h2' }] }));
    assert.equal(findRemoteTarget(f, 'a')?.sshHost, 'u@h');
    assert.equal(findRemoteTarget(f, 'zzz'), undefined);
    assert.equal(findRemoteTarget(f, undefined), undefined);
  });
});

/*
 * 状态要显出来，否则 `stale`（本地不是最新的）就只存在于日志里 —— 而那正是最不能沉默的一件事。
 */
describe('同步状态推给界面', () => {
  function mgr(pull: () => Promise<PullResult>) {
    const seen: SyncStatus[] = [];
    const m = new RemoteSyncManager({
      note: () => {}, log: () => {}, onStatus: (s) => seen.push(s), schedule: (fn) => fn(),
    });
    const project: MirrorLike = {
      localDir: '/l', remoteDir: '/r',
      push: async () => ({ ok: true, snapshot: {}, ms: 1 }),
      pull,
    };
    m.register({ sessionId: 's1', project, hostLabel: 'tokyo' });
    return { m, seen };
  }

  test('推/拉/空闲依次报出来', async () => {
    const { m, seen } = mgr(async () => ({ ok: true, changed: ['a'], conflicts: [], ms: 1 }));
    await m.beforeTurn('s1');
    await m.afterTurn('s1');
    assert.deepEqual(seen.map((s) => s.state), ['pushing', 'idle', 'pulling', 'idle']);
    assert.equal(seen[0].hostLabel, 'tokyo');
  });

  test('拉失败报 stale + 原因 —— 界面靠它显警告色', async () => {
    const { m, seen } = mgr(async () => ({ ok: false, error: 'ssh timeout', changed: [], conflicts: [], ms: 1 }));
    await m.afterTurn('s1');
    const last = seen[seen.length - 1];
    assert.equal(last.state, 'stale');
    assert.match(last.error!, /ssh timeout/);
    assert.equal(m.hasUnpulled('s1'), true);
  });

  test('冲突报 conflict + 文件清单', async () => {
    const { m, seen } = mgr(async () => ({ ok: true, changed: [], conflicts: ['src/a.ts'], ms: 1 }));
    await m.afterTurn('s1');
    const last = seen[seen.length - 1];
    assert.equal(last.state, 'conflict');
    assert.deepEqual(last.conflicts, ['src/a.ts']);
  });

  test('一轮里工具写十次文件只拉一次 —— 所以状态也只闪一次（防抖在 pullSoon 里）', async () => {
    const seen: SyncStatus[] = [];
    let pending: (() => void) | null = null;
    const m = new RemoteSyncManager({
      note: () => {}, log: () => {}, onStatus: (s) => seen.push(s), schedule: (fn) => { pending = fn; },
    });
    m.register({
      sessionId: 's1', hostLabel: 'tokyo',
      project: {
        localDir: '/l', remoteDir: '/r',
        push: async () => ({ ok: true, snapshot: {}, ms: 1 }),
        pull: async () => ({ ok: true, changed: [], conflicts: [], ms: 1 }),
      },
    });
    for (let i = 0; i < 10; i += 1) m.pullSoon('s1');
    (pending as any)?.();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen.map((s) => s.state), ['pulling', 'idle']);
  });

  test('再试一次又失败要**再报一次** —— 那不是重复，是"又试了一次还是不行"', async () => {
    const { m, seen } = mgr(async () => ({ ok: false, error: '一样的错', changed: [], conflicts: [], ms: 1 }));
    await m.afterTurn('s1');
    await m.afterTurn('s1');
    assert.deepEqual(seen.map((s) => s.state), ['pulling', 'stale', 'pulling', 'stale']);
  });

  test('statusOf 能被问到（界面重新挂载时只靠事件会丢状态）', async () => {
    const { m } = mgr(async () => ({ ok: false, error: 'x', changed: [], conflicts: [], ms: 1 }));
    assert.equal(m.statusOf('s1')?.state, 'idle', '还没同步过就是 idle');
    await m.afterTurn('s1');
    assert.equal(m.statusOf('s1')?.state, 'stale');
    assert.equal(m.statusOf('本地会话'), undefined);
  });

  test('注销之后不再报状态，也问不到', () => {
    const { m } = mgr(async () => ({ ok: true, changed: [], conflicts: [], ms: 1 }));
    m.forget('s1');
    assert.equal(m.statusOf('s1'), undefined);
  });
});

describe('接线：主进程', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');

  test('目标按会话选：new-session 收 remoteId，不再读全局 active agent', () => {
    assert.match(M, /findRemoteTarget\(KIROLEX_CONFIG_PATH, remoteId\)/);
    assert.equal(/loadActiveRemoteTarget\(/.test(M), false, '全局开关那条路必须断掉，否则"共存"是假的');
  });

  test('flag 关着时列表是空的 —— 界面据此完全不显示目标选择', () => {
    const at = M.indexOf("ipcMain.handle('app:remote-targets'");
    assert.ok(at > 0);
    assert.match(M.slice(at, at + 400), /if \(!isFeatureEnabled\('remoteSessions'\)\) return \{ enabled: false, targets: \[\] \};/);
  });

  test('找不到那个 id 就不建会话（**不猜**一台机器）', () => {
    assert.match(M, /找不到远端目标/);
  });

  test('状态既能订阅也能查', () => {
    assert.match(M, /mainWindow\?\.webContents\.send\('remote:sync', status\)/);
    assert.match(M, /ipcMain\.handle\('remote:status'/);
    assert.match(P, /onRemoteSync:/);
    assert.match(P, /remoteStatus:/);
    assert.match(P, /remoteTargets:/);
  });

  test('侧栏要的 host 跟着会话列表一起发出去', () => {
    /* 显示的是配置里的名字（`aws-tokyo`），不是 IP —— 见下面那个 describe */
    assert.match(M, /remoteHost: labelForHost\(KIROLEX_CONFIG_PATH, rec\.profile\.remote\.sshHost\)/);
  });
});

describe('接线：渲染进程', () => {
  const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
  const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');
  const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/renderer/main.tsx'), 'utf8');

  test('新建对话框里有目标选择，且**默认本地**', () => {
    assert.match(A, /remoteTargets\.enabled && remoteTargets\.targets\.length > 0/);
    assert.match(A, /<option value="">本地<\/option>/);
    assert.match(A, /useState\(''\);\s*\n\s*const remoteTargets = useRemoteTargets\(\);/);
  });

  test('创建时把选中的目标传下去', () => {
    assert.match(A, /remoteId: target\?\.id, remoteLabel: target\?\.label,/);
  });

  test('侧栏每行常驻机器徽标，warn 状态另一个样式', () => {
    assert.match(SB, /session\.remoteHost && \(/);
    assert.match(SB, /session-remote-warn/);
    assert.match(SB, /syncBadgeTitle\(session\.remoteHost, remoteSync\)/);
  });

  test('状态走 context（会话行有多个渲染点，逐层传 prop 迟早漏一个）', () => {
    assert.match(MAIN, /<RemoteSyncProvider>/);
    assert.match(SB, /useRemoteSyncFor\(session\.id, !!session\.remoteHost\)/);
  });
});

/*
 * 「界面上甚至没有配置远程EC2的地方」—— 功能做出来了却只能手改 config.json，等于没有入口。
 */
describe('在界面上加/改/删一台远端', () => {
  async function fixtureCfg(initial: any = {}): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtw-'));
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify(initial, null, 2));
    return f;
  }

  test('存一条：只动 remotes，配置里别的东西**原样保留**', async () => {
    const { saveRemoteTarget } = await import('../src/main/remoteTargets.ts');
    const f = await fixtureCfg({
      agents: [{ id: 'a1', remote: { sshHost: 'u@old' } }],
      features: { remoteSessions: true },
      activeAgentId: 'a1',
    });
    const saved = saveRemoteTarget(f, { label: 'Tokyo EC2', sshHost: 'ec2-user@1.2.3.4', identityFile: '~/k.pem' });
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(cfg.activeAgentId, 'a1', '别的键一个都不能丢');
    assert.equal(cfg.features.remoteSessions, true);
    assert.equal(cfg.agents.length, 1, '老形状不改写');
    assert.equal(cfg.remotes.length, 1);
    assert.equal(cfg.remotes[0].label, 'Tokyo EC2');
    assert.equal(saved.id, 'tokyo-ec2', 'id 可读，不是时间戳');
    /* `~` 存原样（配置里更可读），读的时候才展开 */
    assert.equal(cfg.remotes[0].identityFile, '~/k.pem');
    assert.match(saved.identityFile!, /^\//, '读出来的是展开后的绝对路径');
  });

  test('同名再存一条 id 不撞；带 id 是改而不是新增', async () => {
    const { saveRemoteTarget } = await import('../src/main/remoteTargets.ts');
    const f = await fixtureCfg();
    const a = saveRemoteTarget(f, { label: 'box', sshHost: 'u@h1' });
    const b = saveRemoteTarget(f, { label: 'box', sshHost: 'u@h2' });
    assert.equal(a.id, 'box');
    assert.equal(b.id, 'box-2');
    saveRemoteTarget(f, { id: 'box', label: 'box', sshHost: 'u@h1', remoteWorkdir: '/home/u/m' });
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(cfg.remotes.length, 2, '带 id 是改，不该变成第三条');
    assert.equal(cfg.remotes.find((r: any) => r.id === 'box').remoteWorkdir, '/home/u/m');
  });

  test('删一条；老 agents[].remote 那条删不掉要说清原因', async () => {
    const { saveRemoteTarget, deleteRemoteTarget } = await import('../src/main/remoteTargets.ts');
    const f = await fixtureCfg({ agents: [{ id: 'a1', remote: { sshHost: 'u@old' } }] });
    saveRemoteTarget(f, { label: 'x', sshHost: 'u@h' });
    assert.equal(deleteRemoteTarget(f, 'x'), true);
    assert.equal(deleteRemoteTarget(f, 'a1'), false, '它不在可编辑的列表里');
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).agents.length, 1, '删不动也不能把老配置搞坏');
  });

  test('校验：空地址、带空格、端口越界、相对工作目录，各有一句话', async () => {
    const { validateTarget } = await import('../src/main/remoteTargets.ts');
    assert.match(validateTarget({ sshHost: '' })!, /不能为空/);
    assert.match(validateTarget({ sshHost: 'u@h x' })!, /空格/);
    assert.match(validateTarget({ sshHost: 'u@h', sshPort: 0 })!, /1–65535/);
    /* 相对路径会落在登录 shell 的当前目录上 —— "看起来能用，但镜像跑到了别处" */
    assert.match(validateTarget({ sshHost: 'u@h', remoteWorkdir: 'mirror' })!, /绝对路径/);
    assert.equal(validateTarget({ sshHost: 'u@h' }), null);
    assert.equal(validateTarget({ sshHost: 'u@h', sshPort: 22, remoteWorkdir: '~/m' }), null);
  });

  test('写的是原子写 —— 这是用户唯一的配置文件', async () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/main/remoteTargets.ts'), 'utf8');
    assert.match(src, /fs\.renameSync\(tmp, configPath\)/);
  });

  test('接线：三个 IPC + preload + 设置里那一块', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');
    const SD = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/SettingsDialog.tsx'), 'utf8');
    for (const ch of ["'remote:save'", "'remote:delete'", "'remote:test'"]) {
      assert.ok(M.includes(ch), `缺 ${ch}`);
    }
    assert.match(P, /remoteSave:/);
    assert.match(P, /remoteTest:/);
    assert.match(SD, /<RemoteSettings \/>/);
  });

  test('「测试连接」用的是**同一个**预检判据，不是另写一套', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf("ipcMain.handle('remote:test'");
    const body = M.slice(at, at + 1600);
    assert.match(body, /preflightScript\(\)/);
    assert.match(body, /judgePreflight\(/);
  });
});

/*
 * 「我让你加一个按钮给这台远程机器跑个脚本装 kiro-cli claude code codex 还有其他依赖项」。
 *
 * 装法不是猜的 —— 是从那台机器上实测出来的：bash 历史里就是
 *   curl … desktop-release.q.us-east-1.amazonaws.com/latest/kirocli-x86_64-linux.zip
 * 解出来是 `kirocli/{install.sh,bin/}`，install.sh 把三个二进制装进 ~/.local/bin 再跑
 * `kiro-cli setup`（参数透传，所以给 --no-confirm）；claude-code / codex 是 fnm 下的 npm 全局包。
 */
describe('一键装齐远端依赖', () => {
  const SH = fs.readFileSync(path.join(process.cwd(), 'scripts/remote-bootstrap.sh'), 'utf8');

  test('脚本装的是这几样：kiro-cli / claude code / codex / node / rsync / git', () => {
    assert.match(SH, /kirocli-x86_64-linux\.zip/);
    assert.match(SH, /kirocli-aarch64-linux\.zip/, 'arm 的机器也要能装');
    assert.match(SH, /install\.sh' --no-confirm|install\.sh" --no-confirm/);
    assert.match(SH, /@anthropic-ai\/claude-code/);
    assert.match(SH, /@openai\/codex/);
    assert.match(SH, /@zed-industries\/claude-code-acp/, 'KiroLex 走 ACP，claude code 要靠它当执行器');
    for (const b of ['rsync', 'git', 'unzip']) assert.ok(SH.includes(b), `缺 ${b}`);
    assert.match(SH, /fnm/, 'claude-code/codex 是 npm 包，发行版自带的 node 往往太老');
  });

  test('幂等：已装的跳过，FORCE=1 才重装', () => {
    assert.match(SH, /FORCE="\$\{FORCE:-0\}"/);
    assert.match(SH, /have "\$name" && \[ "\$FORCE" != "1" \]/);
  });

  test('**不装**远程会话不需要的东西，也不替你登录', () => {
    /* 判据要看**装的动作**，不是看有没有提到这个词 —— 注释里就写着"不装 LibreOffice" */
    const installs = SH.split('\n').filter((l) => /^\s*(sudo\s+)?(dnf|yum|apt-get|npm)\s/.test(l));
    const joined = installs.join('\n');
    assert.equal(/libreoffice|soffice/i.test(joined), false, '预览/PPT 留在本地');
    assert.equal(/npm\s+(ci|install)(?!\s+-g)/.test(joined), false, '不装项目依赖（只装全局工具）');
    /* 登录只**提示**，绝不代跑：脚本里不许出现一句真的 `kiro-cli login` 调用 */
    assert.equal(/^\s*kiro-cli login/m.test(SH), false, '不替你登录');
    assert.match(SH, /没登录/);
  });

  test('缺 kiro-cli/rsync/git 要算失败 —— 少了它们远程会话根本跑不起来', () => {
    assert.match(SH, /kiro-cli\|rsync\|git\) rc=1/);
  });

  test('接线：IPC 边跑边把输出发给界面（几分钟不给看就像卡死）', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');
    assert.match(M, /ipcMain\.handle\('remote:bootstrap'/);
    assert.match(M, /event\.sender\.send\('remote:bootstrap-output'/);
    /*
      **落到远端临时文件再跑，不用 `bash -s`** —— 实测踩过：脚本从 stdin 进去时，脚本里任何读
      stdin 的命令都会把剩下的脚本吃掉（`claude-code-acp --version` 就是这种），于是自检整段
      没跑而退出码还是 0。这条断言就是防它回来的。
    */
    assert.match(M, /cat > \$\{remoteTmp\} && \$\{loginEnvStr\}\$\{mcpEnv\}FORCE=/);
    assert.match(M, /rm -f \$\{remoteTmp\}/, '跑完要删，不在对方磁盘上留东西');
    assert.equal(/bash -s`\)/.test(M), false, 'bash -s 那条路不许回来');
    assert.match(M, /child\.stdin\.write\(script\)/);
    const SH2 = fs.readFileSync(path.join(process.cwd(), 'scripts/remote-bootstrap.sh'), 'utf8');
    assert.match(SH2, /--version <\/dev\/null/, '版本探测要隔断 stdin（双重保险）');
    assert.match(P, /remoteBootstrap:/);
    assert.match(P, /onRemoteBootstrapOutput:/);
  });

  test('按钮**不能**复用 `.settings-btn` —— 那是 28×28 的图标按钮，文字会被挤爆', () => {
    /*
      实测踩过：「+ 添加一台远端机器」被渲染成 28×28（`.settings-btn` 把 width/height 写死、
      font-size 16px），字整个挤出去 ——「按钮和字体彻底乱了」。文字按钮得有自己的类。
    */
    const RS0 = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
    assert.equal(/className="settings-btn/.test(RS0), false, '这一块里不许再用图标按钮的类');
    assert.match(RS0, /className="remote-btn/);
    const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');
    const at = CSS.indexOf('.remote-btn {');
    assert.ok(at > 0, '.remote-btn 要有样式');
    const block = CSS.slice(at, CSS.indexOf('}', at));
    /* 注意别把 `line-height` 当成 `height` —— 判据要贴着属性名的开头 */
    assert.equal(/(^|[\s;{])(width|height)\s*:/.test(block), false, '文字按钮不能写死尺寸');
    assert.match(block, /padding:/);
  });

  test('接线：按钮在设置里，且只有你按才会跑（没有自动触发）', () => {
    const RS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
    assert.match(RS, />\{installing \? '安装中…' : '安装依赖'\}</);
    assert.match(RS, /remoteBootstrap\?\.\(/);
    assert.match(RS, /className="remote-log"/, '输出要看得见');
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    /* 主进程里只有这一个调用点，且是 IPC handler —— 不许有任何自动路径 */
    assert.equal((M.match(/remote:bootstrap'/g) || []).length, 1);
  });

  test('超时够长 —— kiro-cli 的包几百 MB，npm 还要装三个', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf("ipcMain.handle('remote:bootstrap'");
    assert.match(M.slice(at, at + 6000), /15 \* 60 \* 1000/);
  });
});

/*
 * 「你先看一下 kiro-cli 默认 agent 的 web search mcp，把这个 mcp 也装到这个 claude code 上面」。
 *
 * 实测到的那条（本机 `kiro-cli mcp list` 里 kiro_default 挂的 `agentcore-websearch`）：
 *   mcp-proxy-for-aws https://websearch-…gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp
 *     --service bedrock-agentcore --region us-east-1 --profile default
 */
describe('web search MCP 带到远端的 claude code', () => {
  const REAL_PS = '/Users/k/.local/share/uv/tools/mcp-proxy-for-aws/bin/python /Users/k/.local/bin/mcp-proxy-for-aws '
    + 'https://websearch-gw-0hx6kh9cho.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp '
    + '--service bedrock-agentcore --region us-east-1 --profile default';

  test('从实际在跑的命令行里读出端点/服务/区域', async () => {
    const { parseProxyCommand } = await import('../src/main/webSearchMcp.ts');
    const m = parseProxyCommand(REAL_PS)!;
    assert.match(m.url, /^https:\/\/websearch-.*\/mcp$/);
    assert.equal(m.service, 'bedrock-agentcore');
    assert.equal(m.region, 'us-east-1');
  });

  test('不是这个代理的进程一律不认', async () => {
    const { parseProxyCommand } = await import('../src/main/webSearchMcp.ts');
    assert.equal(parseProxyCommand('node /some/other/thing --region us-east-1'), null);
    assert.equal(parseProxyCommand('mcp-proxy-for-aws --help'), null, '没有端点就不算');
    assert.equal(parseProxyCommand(''), null);
  });

  test('有多个代理时挑 websearch 那个', async () => {
    const { pickWebSearch } = await import('../src/main/webSearchMcp.ts');
    const lines = [
      'python mcp-proxy-for-aws https://other-gw.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp --service bedrock-agentcore',
      REAL_PS,
    ];
    assert.match(pickWebSearch(lines)!.url, /websearch-gw-0hx6kh9cho/);
    assert.equal(pickWebSearch([]), null, '读不到就是 null —— 绝不猜一个地址');
  });

  test('**不抄 --profile** —— 远端走实例角色，那台机器上没有名叫 default 的 profile', async () => {
    const { claudeMcpAddArgs, parseProxyCommand } = await import('../src/main/webSearchMcp.ts');
    const args = claudeMcpAddArgs('agentcore-websearch', parseProxyCommand(REAL_PS)!);
    assert.equal(args.includes('--profile'), false, '照抄过去只会让它一启动就找不到 profile');
    assert.deepEqual(args.slice(0, 6), ['mcp', 'add', '--scope', 'user', 'agentcore-websearch', '--']);
    assert.ok(args.includes('--service') && args.includes('bedrock-agentcore'));
  });

  test('端点**不写进脚本/仓库** —— 它是这个账号自己的网关地址', () => {
    const SH2 = fs.readFileSync(path.join(process.cwd(), 'scripts/remote-bootstrap.sh'), 'utf8');
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const WS = fs.readFileSync(path.join(process.cwd(), 'src/main/webSearchMcp.ts'), 'utf8');
    for (const [name, src] of [['脚本', SH2], ['index.ts', M], ['webSearchMcp.ts', WS]] as const) {
      assert.equal(/websearch-gw-[a-z0-9]{6,}/.test(src), false, `${name} 里不许出现真实网关 id`);
    }
    /* 靠环境变量传进来，没传就跳过 */
    assert.match(SH2, /WEBSEARCH_MCP_URL="\$\{WEBSEARCH_MCP_URL:-\}"/);
    assert.match(SH2, /跳过：没拿到端点/);
    assert.match(M, /WEBSEARCH_MCP_URL=\$\{shellQuote\(found\.url\)\}/);
  });

  test('脚本里用 claude mcp add --scope user，且幂等（先删再加）', () => {
    const SH2 = fs.readFileSync(path.join(process.cwd(), 'scripts/remote-bootstrap.sh'), 'utf8');
    assert.match(SH2, /claude mcp add --scope user/);
    assert.match(SH2, /claude mcp remove --scope user/);
    /* mcp-proxy-for-aws 是 python 工具：uv 用**官方**安装脚本 */
    assert.match(SH2, /astral\.sh\/uv\/install\.sh/);
    assert.match(SH2, /uv tool install --force mcp-proxy-for-aws/);
  });

  test('claude code 换成官方安装脚本（原生二进制，不依赖 node），npm 兜底', () => {
    const SH2 = fs.readFileSync(path.join(process.cwd(), 'scripts/remote-bootstrap.sh'), 'utf8');
    assert.match(SH2, /claude\.ai\/install\.sh/);
    /* 用**最后一处**：头部注释里也提到了这个 URL，从那儿切看不到兜底那几行 */
    const at = SH2.lastIndexOf('claude.ai/install.sh');
    assert.match(SH2.slice(at, at + 900), /npm_i '@anthropic-ai\/claude-code' claude/, '装不上要能退回 npm');
  });
});

/*
 * 「为什么不把远程机器弄成一个下拉列表」+「我是需要能到 finder 里面去找到密钥文件而不是还得自己写路径」。
 */
describe('远端机器那一块的形状', () => {
  const RS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
  const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');

  test('下拉选机器，而不是一行一台各带四个按钮', () => {
    assert.match(RS, /<select/);
    assert.match(RS, /\+ 添加一台机器…/);
    /* 上一版每行四个按钮，实测只有 43–63px 宽，机器一多就是一片按钮 */
    assert.equal(/className="remote-row"/.test(RS), false, '行式列表已经换掉了');
    /* 同一时刻只在编辑一台，所以动作按钮只有一组 */
    assert.equal((RS.match(/onClick=\{\(\) => void test\(\)\}/g) || []).length, 1);
  });

  test('密钥用 Finder 选，不让人手写路径', () => {
    assert.match(RS, /remotePickKey\?\.\(\)/);
    assert.match(RS, /选择密钥…/);
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf("ipcMain.handle('remote:pick-key'");
    assert.ok(at > 0, '主进程要有这个 IPC');
    const body = M.slice(at, at + 1500);
    /* 密钥通常在 ~/.ssh —— 那是隐藏目录，不给 showHiddenFiles 的话对话框里根本看不到 */
    assert.match(body, /showHiddenFiles/);
    assert.match(body, /\.ssh/);
    assert.match(body, /'pem'/, 'EC2 给的就是 .pem');
    assert.match(body, /extensions: \['\*'\]/, 'id_rsa 这类没有后缀，必须能选到');
    const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');
    assert.match(P, /remotePickKey:/);
  });

  test('路径太长时省略号落在左边 —— 尾巴（文件名）才是要看的', () => {
    const at = CSS.indexOf('.remote-key-path {');
    assert.ok(at > 0);
    assert.match(CSS.slice(at, CSS.indexOf('}', at)), /direction: rtl/);
  });

  test('还能清掉选中的密钥（留空 = 用 ssh 自己的配置）', () => {
    assert.match(RS, /identityFile: '' \}\)/);
  });
});

/*
 * 「我看不到」+「把 remote 的会话的 tag 放到右侧」。
 *
 * 看不到的原因有两个，都是实测出来的：
 *   ① 水化那一步按**白名单**抄字段，`remoteHost` 没列进去 —— 主进程确实发了，渲染层丢了。
 *      这和代码里已经记过两次的坑是同一个（`purpose` 重启后 🧩 消失、`kiroAgent` 没发出来）。
 *   ② 那两条测试会话在一个**折叠的项目分组**里（`kx-ui`），展开才看得见。
 */
describe('侧栏那个 🌐 徽标真的到得了界面', () => {
  const HK = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');
  const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');

  test('水化的**两条分支**都要带上 remoteHost（白名单少一个字段就等于没这个功能）', () => {
    assert.match(HK, /remoteHost: rec\.remoteHost \?\? \(existing as any\)\.remoteHost,/, '已有的会话');
    assert.match(HK, /remoteHost: rec\.remoteHost,\s*\n\s*timestamp: rec\.updatedAt,/, '新从磁盘读到的会话');
  });

  test('徽标在右侧那排的**最末**，紧挨删除按钮', () => {
    const at = SB.indexOf('{session.remoteHost && (');
    const del = SB.indexOf('className="session-delete-btn"');
    assert.ok(at > 0 && del > at, '顺序：… → 🌐 → ✕');
    /* 中间不许再插别的 tag */
    assert.equal(/session-(crew|schedule)/.test(SB.slice(at, del)), false);
  });

  test('它和"此刻在发生什么"分开：身份固定，状态会来会走', () => {
    assert.match(SB, /是这条会话的\*\*身份\*\*/);
  });
});

/*
 * 「这个是咋调用的？看起来工具调用是在本地？」
 *
 * 实测那条记录：`Running: printf '%s %s\n' "$(hostname)" "$(pwd)" > REMOTE-PROOF.txt && …`，
 * 相对路径、`locations: None` —— 和本地执行长得一模一样。而它确实跑在东京那台 EC2 上
 * （那条命令自己的输出是 `ip-10-0-4-14.ap-northeast-1.compute.internal`）。
 * 一条 `rm` 落在哪台机器上不该靠猜，所以回合面板上要标出来。
 */
describe('工具调用要标出跑在哪台机器上', () => {
  const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
  const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');

  test('「运行的命令」和「改动的文件」两个面板都带 🌐 host', () => {
    assert.equal((CA.match(/className="turn-panel-remote"/g) || []).length, 2);
    assert.match(CA, /const CommandsPanel = memo<\{ fileChanges: ToolCall\[\]; live\?: boolean; remoteHost\?: string \}>/);
    assert.match(CA, /const FileChangesPanel = memo<\{ fileChanges: ToolCall\[\]; remoteHost\?: string \}>/);
  });

  test('host 从同步状态里取 —— 本地会话没有状态，所以有值就是远程', () => {
    assert.match(CA, /const remoteStatus = useRemoteSyncFor\(currentSessionId \|\| undefined, true\);/);
    /* 去掉 user@：那一段不区分机器，而面板很窄 */
    assert.match(CA, /hostLabel\?\.replace\(\/\^\[\^@\]\*@\/, ''\)/);
  });

  test('文件面板要说清"远端改的、打开的是本地那一份"', () => {
    assert.match(CA, /在 \$\{remoteHost\} 上改的；这里打开的是已同步回本地的那一份/);
  });

  test('样式和侧栏那个 🌐 同一个色相 —— 看到一次就认得', () => {
    const a = CSS.slice(CSS.indexOf('.session-remote {'), CSS.indexOf('}', CSS.indexOf('.session-remote {')));
    const b = CSS.slice(CSS.indexOf('.turn-panel-remote {'), CSS.indexOf('}', CSS.indexOf('.turn-panel-remote {')));
    assert.match(a, /rgba\(64,160,220/);
    assert.match(b, /rgba\(64,160,220/);
  });
});

/*
 * 「右边那个 tag 不要显示 ip，显示 profile 名字，比如 aws-tokyo」。
 */
describe('徽标显示配置里的名字，不是 IP', () => {
  test('按 sshHost 反查 label；找不到才退回 host', async () => {
    const { labelForHost, saveRemoteTarget } = await import('../src/main/remoteTargets.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbl-'));
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, '{}');
    saveRemoteTarget(f, { label: 'aws-tokyo', sshHost: 'ec2-user@1.2.3.4' });
    assert.equal(labelForHost(f, 'ec2-user@1.2.3.4'), 'aws-tokyo');
    /* 配置里没有这台（删了、或者会话比配置老）—— 宁可显示 IP，不要空着 */
    assert.equal(labelForHost(f, 'ec2-user@9.9.9.9'), '9.9.9.9');
    assert.equal(labelForHost(f, ''), '');
  });

  test('**反查而不是存进 profile** —— 改了名字要立刻生效，且老会话也认', async () => {
    const { labelForHost, saveRemoteTarget } = await import('../src/main/remoteTargets.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbl2-'));
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, '{}');
    const saved = saveRemoteTarget(f, { label: 'tokyo-ec2', sshHost: 'u@h' });
    assert.equal(labelForHost(f, 'u@h'), 'tokyo-ec2');
    saveRemoteTarget(f, { id: saved.id, label: 'aws-tokyo', sshHost: 'u@h' });
    assert.equal(labelForHost(f, 'u@h'), 'aws-tokyo', '改名之后徽标要跟着变');
  });

  test('接线：侧栏那份和同步状态里的 hostLabel 都走它', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /remoteHost: labelForHost\(KIROLEX_CONFIG_PATH, rec\.profile\.remote\.sshHost\)/);
    assert.match(M, /hostLabel: labelForHost\(KIROLEX_CONFIG_PATH, remote\.sshHost\) \|\| remote\.sshHost,/);
    /* 连接/预检那些消息照旧用 sshHost —— 那些话讲的是"连到哪儿"，IP 才是有用的 */
    const PF = fs.readFileSync(path.join(process.cwd(), 'src/main/remotePreflight.ts'), 'utf8');
    assert.match(PF, /连不上 \$\{host\}/);
    assert.match(PF, /const host = remote\.sshHost/);
  });
});

/*
 * 「现在根本看不到东西」—— Vite 自己重启（多一个 html 入口就会）的那一瞬间窗口加载失败，
 * 而重试只发生在**启动**那一次，于是之后没人再加载它：Vite 好着（5173 返回 200），
 * 窗口里连 `#root` 都没有、标题退化成 `localhost:5173`，看起来就是整个 app 没了。
 */
describe('dev 下加载失败要自己重来，不能留白屏', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('did-fail-load 会触发重新加载（原来只记一行日志）', () => {
    const at = M.indexOf("on('did-fail-load'");
    assert.ok(at > 0);
    const body = M.slice(at, at + 700);
    assert.match(body, /reloadDevServer\?\.\(1\)/);
    /* 只管主框架：子框架/图片加载失败不该触发整页重载 */
    assert.match(body, /if \(!IS_DEV \|\| !isMainFrame\) return;/);
  });

  test('和启动时那条重试是**同一条**逻辑，不是另写一份', () => {
    assert.match(M, /reloadDevServer = \(attempt: number\) => \{ setTimeout\(\(\) => loadDevServer\(attempt\), 400\); \};/);
    /* 上限还在（别把"重试"变成无限刷新） */
    assert.match(M, /attempt <= 30 && mainWindow && !mainWindow\.isDestroyed\(\)/);
  });
});

/*
 * 「为什么远程会话的搜索是在本地的，你是不是应该给他一些提示词告诉他本地和远程目录的区别」。
 *
 * 设计文档里写了要给远程会话注入这段说明，实现时漏了 —— 于是模型完全不知道自己在别人的机器上：
 * 它会拿对话里出现的 `/Users/...` 去搜（那个路径在远端不存在），把"搜不到"当成"这个东西没有"。
 */
describe('远程会话要告诉模型它在哪台机器上', () => {
  test('说清三件事：我在哪、项目在哪、本地那个路径在这儿不存在', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({
      hostLabel: 'aws-tokyo',
      remoteDir: '/home/ec2-user/kirolex-mirror/blog-1234abcd',
      localDir: '/Users/k/code/blog',
      sessionDir: '/home/ec2-user/kirolex-mirror/.kirolex-sessions/s_1',
    });
    assert.match(b, /\[运行环境：远程\]/);
    assert.match(b, /aws-tokyo/);
    assert.match(b, /\/home\/ec2-user\/kirolex-mirror\/blog-1234abcd/);
    /* 最关键的一条：本地路径在这台机器上**不存在**，而且给出换算方法 */
    assert.match(b, /那个路径在这台机器上不存在/);
    assert.match(b, /\/Users\/k\/code\/blog\/x\/y.*blog-1234abcd\/x\/y/s);
    assert.match(b, /"搜不到"不等于"这个东西没有"/);
  });

  test('还要说清：文件以本地为准、不要在远端构建/预览', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({ hostLabel: 'h', remoteDir: '/r', localDir: '/l' });
    assert.match(b, /以用户本地那份为准/);
    assert.match(b, /不会丢/, '不说这句它会自己往回拷');
    assert.match(b, /node_modules/);
    assert.match(b, /LibreOffice/);
  });

  test('缺 host 或缺远端目录就**不注入** —— 半截的说明比不说更糟', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    assert.equal(remoteContextBlock({ hostLabel: '', remoteDir: '/r', localDir: '/l' }), '');
    assert.equal(remoteContextBlock({ hostLabel: 'h', remoteDir: '', localDir: '/l' }), '');
  });

  test('接线：每轮都注入，位置在 memory 块前面（= 最终数组里更靠近用户那句话）', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /const rc = remoteContextFor\(sessionId, entry\);/);
    assert.match(M, /prompt = \[\{ type: 'text', text: rc \}, \.\.\.prompt\];/);
    assert.ok(
      M.indexOf('const rc = remoteContextFor(sessionId, entry);') < M.indexOf('buildMemoryInjection(effectiveProjectId, sessionId)'),
      '先注入它，memory 块再压在它上面 —— 顺序决定谁更靠近用户那句话',
    );
    /* 两个路径都来自会话自己的记录，不是猜的 */
    assert.match(M, /remoteDir: entry\.cwd,/);
    assert.match(M, /localDir: localProjectDirOf\(sessionId, entry\),/);
  });
});

/*
 * 「现在怎么有个移出项目的按钮，那个改成移到 unassigned 不就好吗」。
 *
 * 那个按钮的**动作本来就是**移到未分组（`onMoveSession(id, null)`）—— 错的只是文案：
 * 「移出项目」听起来像把会话从项目里拿走、甚至删掉，而它其实只是换到「未分组」那一组。
 */
describe('右键菜单：那条说的是"去哪儿"，不是"从哪儿走"', () => {
  test('文案是「移到未分组」，和「恢复到未分组」同一个去处', () => {
    const I = fs.readFileSync(path.join(process.cwd(), 'src/renderer/i18n.ts'), 'utf8');
    assert.match(I, /'Unassign': '移到未分组'/);
    assert.match(I, /'Restore to Unassigned': '恢复到未分组'/);
    assert.equal(/'Unassign': '移出项目'/.test(I), false);
  });

  test('动作没动：还是 onMoveSession(id, null)', () => {
    const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');
    const at = SB.indexOf("t('Unassign')");
    assert.ok(at > 0);
    assert.match(SB.slice(at - 320, at), /onMoveSession\(ctxSession\.id, null\)/);
  });
});

/*
 * 「那个 ssh 配置中不需要保存按钮，所有变化自动保存」。
 */
describe('远端配置自动保存（没有保存按钮）', () => {
  const RS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');

  test('保存按钮没了，改动走防抖自动存', () => {
    assert.equal(/>保存</.test(RS), false, '按钮不许再有');
    assert.match(RS, /setTimeout\(async \(\) => \{[\s\S]{0,400}remoteSave/);
    assert.match(RS, /\}, 600\);/, '防抖：不能每敲一个字母写一次 config.json');
  });

  test('**空 sshHost 不存** —— 那不是一台机器，存下去只会得到一条废配置', () => {
    assert.match(RS, /if \(!draft \|\| !draft\.sshHost\.trim\(\)\) return;/);
  });

  test('**签名比对** —— 只是切换/打开时不该写盘', () => {
    assert.match(RS, /if \(mine === savedSig\.current\) return;/);
    /* 加载和切换两处都要对齐签名，否则打开设置就写一遍 */
    assert.equal((RS.match(/savedSig\.current = sig\(d\)/g) || []).length, 2);
  });

  test('**新建那条存完要认领 id** —— 否则改个名字就多出来一台机器', () => {
    const at = RS.indexOf('if (!draft.id) {');
    assert.ok(at > 0);
    const body = RS.slice(at, at + 400);
    assert.match(body, /setDraft\(\(d\) => \(d \? \{ \.\.\.d, id: saved\.id \} : d\)\)/);
    assert.match(body, /setPicked\(saved\.id\)/);
  });

  test('存完就地更新列表，**不走 reload** —— reload 会打断正在打字的输入', () => {
    assert.match(RS, /setRows\(\(prev\) => \(prev\.some\(\(x\) => x\.id === saved\.id\)/);
    const at = RS.indexOf('const saved = r.target as RemoteRow;');
    assert.equal(/await reload\(/.test(RS.slice(at, at + 700)), false);
  });

  test('要有一句"存了没" —— 没有按钮时人得知道改动算不算数', () => {
    assert.match(RS, /saving \? '正在保存…' : '改动自动保存'/);
  });
});

/*
 * 「我为什么选了密钥不生效」—— 两个 bug 叠在一起：
 *   ① `app:remote-targets` 的投影只发了 id/label/sshHost/remoteWorkdir，**漏了 identityFile 和
 *      sshPort**，所以设置界面永远显示"没有选私钥"（配置里明明有）。
 *   ② 自动保存又把这份缺字段的草稿写回去，而 `{...old, ...row}` 会用 `undefined` 盖掉原值、
 *      JSON 再把它丢掉 —— 等于每次编辑都在悄悄删掉密钥和端口。
 */
describe('私钥/端口不能在来回传的路上丢掉', () => {
  test('IPC 要把这两个字段发出去', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf('targets: listRemoteTargets(KIROLEX_CONFIG_PATH).map');
    assert.ok(at > 0);
    const body = M.slice(at, at + 400);
    assert.match(body, /identityFile: t\.identityFile/);
    assert.match(body, /sshPort: t\.sshPort/);
  });

  test('**没给的字段保持原值**，而不是被 undefined 抹掉', async () => {
    const { saveRemoteTarget, listRemoteTargets } = await import('../src/main/remoteTargets.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-'));
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, '{}');
    saveRemoteTarget(f, { label: 'tokyo', sshHost: 'u@h', sshPort: 2222, identityFile: '/k.pem', remoteWorkdir: '/w' });
    /* 界面只改了名字（别的字段没带过来）—— 密钥/端口/目录都必须还在 */
    saveRemoteTarget(f, { id: 'tokyo', label: 'aws-tokyo', sshHost: 'u@h' });
    const [t] = listRemoteTargets(f);
    assert.equal(t.label, 'aws-tokyo');
    assert.equal(t.identityFile, '/k.pem', '密钥不许丢');
    assert.equal(t.sshPort, 2222, '端口不许丢');
    assert.equal(t.remoteWorkdir, '/w');
  });

  test('**显式清空**还是要能清掉（传空串 = 明确的清除）', async () => {
    const { saveRemoteTarget, listRemoteTargets } = await import('../src/main/remoteTargets.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clr-'));
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, '{}');
    saveRemoteTarget(f, { label: 'x', sshHost: 'u@h', identityFile: '/k.pem' });
    saveRemoteTarget(f, { id: 'x', label: 'x', sshHost: 'u@h', identityFile: '' });
    assert.equal(listRemoteTargets(f)[0].identityFile, undefined);
  });

  test('输入框都有常驻标签 —— placeholder 一打字就没了', () => {
    const RS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
    for (const label of ['名字', 'SSH 地址', '端口', '私钥', '远端目录']) {
      assert.ok(RS.includes(`label="${label}"`), `缺标签 ${label}`);
    }
    assert.match(RS, /const Field: React\.FC</);
  });
});

/*
 * 「如果远程需要登录 kiro 怎么办呢」+「你记得在脚本里加 kiro 登录流程哈」。
 *
 * 远端没有浏览器，所以走 `--use-device-flow`：打印 URL + code，授权在**你自己的浏览器**里完成。
 * 参数（start URL / region）是这个账号自己的，不写进仓库 —— 从本机已登录的状态里读，传给脚本。
 */
describe('远端 kiro 登录', () => {
  test('从本机 whoami 的输出里读出 start URL 和 region', async () => {
    const { parseWhoami } = await import('../src/main/kiroLogin.ts');
    /* 实测的输出形状 */
    const out = [
      'Logged in with IAM Identity Center (https://d-95675c11dc.awsapps.com/start)',
      'Email: someone@example.com',
      '',
      'Profile:',
      'QDefaultProfile',
      'arn:aws:codewhisperer:us-east-1:843493563478:profile/YD3ARYRUKXQP',
    ].join('\n');
    const h = parseWhoami(out);
    assert.equal(h.identityProvider, 'https://d-95675c11dc.awsapps.com/start');
    /* region 只能从那条 ARN 里拿 —— `kiro-cli settings all` 里没有 */
    assert.equal(h.region, 'us-east-1');
  });

  test('读不到就**不猜** —— 环境变量空着，脚本只提示', async () => {
    const { parseWhoami, loginEnv } = await import('../src/main/kiroLogin.ts');
    assert.deepEqual(loginEnv(parseWhoami('Not logged in')), {});
    assert.deepEqual(loginEnv({ region: 'us-east-1' }), {}, '只有 region 没有 provider 也不算');
    assert.deepEqual(loginEnv({ identityProvider: 'https://x/start' }), { KIRO_LOGIN_PROVIDER: 'https://x/start' });
  });

  test('脚本里有登录这一步：device flow、已登录就跳过、失败要说清下一步', () => {
    const SH = fs.readFileSync(path.join(process.cwd(), 'scripts/remote-bootstrap.sh'), 'utf8');
    assert.match(SH, /step "kiro-cli 登录"/);
    assert.match(SH, /--use-device-flow/);
    assert.match(SH, /kiro-cli whoami <\/dev\/null >\/dev\/null 2>&1; then/, '已登录要跳过');
    assert.match(SH, /KIRO_LOGIN_PROVIDER/);
    /* 端点不写死在仓库里 */
    assert.equal(/awsapps\.com\/start/.test(SH), false);
    assert.match(SH, /自己 ssh 上去跑 kiro-cli login/, '读不到参数时要给人一条明确的出路');
  });

  test('接线：bootstrap 把登录参数一起传过去', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /loginEnv\(parseWhoami\(who\)\)/);
    assert.match(M, /\$\{loginEnvStr\}\$\{mcpEnv\}FORCE=/);
  });
});

/*
 * 「ppt 需要的那些库啥的它都在脚本里了吗」→ 之前不在，现在加了。
 *
 * 为什么要装：生成 .pptx/.xlsx 的做法是 agent **写个 python 脚本再跑它**，而远程会话里那个脚本
 * 跑在远端 —— 缺库就是"脚本写好了跑不起来"，它会花一轮时间自己去装。
 * 为什么仍然**不**装 LibreOffice：预览/转 PDF 在本地做（同步回来之后读本地那份），远端一次都用不到。
 */
describe('脚本里的 python 库（pptx/xlsx）', () => {
  const SH = fs.readFileSync(path.join(process.cwd(), 'scripts/remote-bootstrap.sh'), 'utf8');

  test('装 python-pptx / openpyxl / pandas', () => {
    assert.match(SH, /step "python 库（生成 pptx\/xlsx 用）"/);
    for (const p of ['python-pptx', 'openpyxl', 'pandas']) assert.ok(SH.includes(p), `缺 ${p}`);
    assert.match(SH, /python3 -m pip install -q/);
  });

  test('**先 import 试一遍再装** —— 那台机器的 anaconda 自带 pandas/openpyxl，重复装是白花时间', () => {
    assert.match(SH, /python3 -c "import \$mod"/);
    assert.match(SH, /\[ "\$FORCE" != "1" \]/, 'FORCE=1 才强制重装');
  });

  test('仍然不装 LibreOffice —— 预览在本地做', () => {
    const installs = SH.split('\n').filter((l) => /^\s*(sudo\s+)?(dnf|yum|apt-get|npm|python3 -m pip)\s/.test(l));
    assert.equal(/libreoffice|soffice/i.test(installs.join('\n')), false);
  });

  test('自检里报一行，装不上要能看出来', () => {
    assert.match(SH, /say "python 库       :\$mods"/);
    assert.match(SH, /mods="\$mods ✗\$mod"/);
  });
});

/*
 * 「还有什么 agent 配置之类的是不是得同步给远程 kiro？要不然切不过去？」——
 * 会切不过去，而且**是静默的**。实测：远端用一个它没有的 agent 起 ACP
 * （`kiro-cli acp --agent weekly-report`）照样启动、照样正常答 initialize，唯一区别是
 * `mcpCapabilities.http` 从 true 变 false —— 它悄悄退回默认 agent，system prompt / 工具白名单 /
 * MCP 全没了，而界面上一个字都不说。
 *
 * 两边的 agent 实测就是两套：本机 weekly-report / sfdc-* / rds-dba / ai-dlc / amzn-builder…，
 * 远端只有四个老的 kirolex-*。
 */
describe('agent 配置要同步到远端，并且验一遍', () => {
  test('推 agent 的 rsync：只推 *.json，**不带 --delete**（远端有它自己的 agent）', async () => {
    const { agentSyncArgs, REMOTE_AGENTS_DIR } = await import('../src/main/kiroAgents.ts');
    const a = agentSyncArgs('u@h', 'ssh -i /k.pem', '/home/me');
    assert.equal(a.includes('--delete'), false, '实测远端有四个 kirolex-*，不能清掉别人的');
    assert.deepEqual(a.slice(-2), ['/home/me/.kiro/agents/', `u@h:${REMOTE_AGENTS_DIR}/`]);
    const i = a.indexOf('--include');
    assert.equal(a[i + 1], '*.json');
    assert.ok(a.includes('--exclude') && a[a.indexOf('--exclude') + 1] === '*');
  });

  test('从 agent 配置里挑出它依赖的 MCP 命令', async () => {
    const { mcpCommands } = await import('../src/main/kiroAgents.ts');
    /* 实测本机 kiro_default 那条：mcp-proxy-for-aws 代理一个 AgentCore 网关 */
    assert.deepEqual(mcpCommands({
      mcpServers: {
        'agentcore-websearch': { command: '/Users/k/.local/bin/mcp-proxy-for-aws', args: ['https://x/mcp'] },
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] },
      },
    }).sort(), ['/Users/k/.local/bin/mcp-proxy-for-aws', 'npx']);
    assert.deepEqual(mcpCommands({}), []);
    assert.deepEqual(mcpCommands(null), []);
  });

  test('远端检查一条命令问完：agent 在不在 + 哪些 MCP 命令不在', async () => {
    const { agentCheckScript, parseAgentCheck } = await import('../src/main/kiroAgents.ts');
    const script = agentCheckScript('weekly-report', ['builder-mcp', 'npx']);
    assert.match(script, /test -f ~\/\.kiro\/agents\/weekly-report\.json && echo AGENT_OK \|\| echo AGENT_MISSING/);
    assert.match(script, /command -v "builder-mcp"/);
    assert.deepEqual(parseAgentCheck('AGENT_OK\nMISSING builder-mcp'), { present: true, missingCommands: ['builder-mcp'] });
    assert.deepEqual(parseAgentCheck('AGENT_MISSING'), { present: false, missingCommands: [] });
  });

  test('接线：**agent 不在就拒绝启动**（静默跑错 agent 比不跑糟），MCP 缺了只提示', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /async function syncKiroAgent\(/);
    assert.match(M, /上没有 agent「\$\{agent\}」/);
    assert.match(M, /会悄悄退回默认 agent（不报错）/);
    /* 缺 MCP 命令不拦，但要说 */
    assert.match(M, /的这些 MCP 命令在 \$\{remote\.sshHost\} 上没有/);
    /* 每一条会起远程执行器的路都要同步：新建 / attach / 换机器 */
    assert.ok((M.match(/await syncKiroAgent\(/g) || []).length >= 3);
  });
});

/*
 * 「模型列表其实也完全不一样，你看看能不能行」——
 * 实测这两台机器上是**一样的**（各 19 个，同为 kiro-cli 1.27.0、同一个 Identity Center）。
 * 但没验过就等于赌：远端是旧版、少了你选的模型时，kiro-cli 静默退回
 * （日志里见过 `Model 'gpt-5.6-terra' does not exist. Available models: auto`）。
 */
describe('远端的模型列表要验', () => {
  test('预检顺带把列表问出来（传一个不存在的模型 —— 参数校验就失败，不花额度）', async () => {
    const { preflightScript, MODEL_PROBE, parseModels, judgePreflight } = await import('../src/main/remotePreflight.ts');
    assert.match(preflightScript(), new RegExp(`kiro-cli chat --model ${MODEL_PROBE} --no-interactive`));
    assert.match(preflightScript(), /Available models:/);
    /* 实测输出带 ANSI，要脱掉 */
    const raw = 'HAVE kiro-cli\nHAVE rsync\nHAVE git\nAUTH ok\n\u001b[0merror: Model \'x\' does not exist. Available models: auto, claude-opus-5, gpt-5.6-sol';
    assert.deepEqual(parseModels(raw), ['auto', 'claude-opus-5', 'gpt-5.6-sol']);
    const v = judgePreflight(0, raw, '', { sshHost: 'u@h' } as any);
    assert.equal(v.code, 'ok');
    assert.deepEqual(v.models, ['auto', 'claude-opus-5', 'gpt-5.6-sol']);
    assert.match(v.message, /3 个可用模型/);
  });

  test('接线：远端没有那个模型就按 fallback 换一个，并**说出来**', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /function pickRemoteModel\(/);
    assert.match(M, /MODEL_FALLBACK_ORDER\.find\(\(m\) => models\.includes\(m\)\)/);
    assert.match(M, /上没有模型「\$\{wanted\}」/);
    /* 列表问不到时什么都不做 —— 没依据的判断比不判断糟 */
    assert.match(M, /if \(!models\.length \|\| models\.includes\(wanted\)\) return wanted;/);
    /* 数量会随功能增加（换机器那条路也要验），所以只钉"每条起远程执行器的路都验过" */
    assert.ok((M.match(/pickRemoteModel\(/g) || []).length >= 4, '定义 1 处 + 新建/attach/换机器');
  });
});

/*
 * 「为什么新的那个远程 session 没有 tag、似乎是本地 session」——
 * 创建入口有**两个**，而上一版只给「New Chat 对话框」接了目标：项目里的
 * 「＋ 在此项目中新建会话」一个字都没传，于是从那儿建出来的永远是本地会话（也就没有徽标）。
 */
describe('两个创建入口都要带上远端目标', () => {
  const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');

  test('对话框和"在此项目中新建会话"都传 remoteId', () => {
    assert.equal((A.match(/remoteId: target\?\.id, remoteLabel: target\?\.label,/g) || []).length, 2);
  });

  test('没选过目标时照旧是本地 —— 不能因为配了一台机器就悄悄变远程', () => {
    const at = A.indexOf('const handleNewSessionInProject');
    const body = A.slice(at, at + 900);
    assert.match(body, /remoteTargets\.targets\.find\(\(t\) => t\.id === newChatRemoteId\)/);
    /* 找不到就是 undefined → newSession 收到 undefined → 本地 */
    assert.match(body, /remoteId: target\?\.id/);
  });
});

/*
 * 「AI角色扮演这个应该是远程的」+「好，反正你赶紧修复」——
 * 一条**已有**会话要能改成在远端跑，而不是"只能重新建一条"（重建会把这条对话在后端的历史扔掉）。
 * 设计里定的就是这条路（`docs/DESIGN_remote_sessions.md`「中途切换」）：换执行器 + 逐段重建。
 */
describe('切换一条已有会话的机器', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');
  const at = M.indexOf("ipcMain.handle('acp:set-remote-target'");
  const body = M.slice(at, at + 6000);

  test('**右键菜单优先于正在跑的任务**：照切，只是明确说那一轮被打断了', () => {
    assert.ok(at > 0, 'IPC 要存在');
    /* 上一版在 busy 时直接拒绝 —— 一条长回合跑着时什么都改不了，而那正是你想改设置的时候 */
    assert.equal(/throw new Error\('这一轮还在跑 —— 等它结束再切换机器/.test(body), false);
    assert.match(body, /const interrupted = !!oldEntry\?\.busy;/);
    assert.match(body, /切换打断了正在跑的那一轮/);
    assert.match(body, /已产出的内容都在/);
  });

  test('**切回本地之前先把远端改动拉干净**，拉不回来就不切', () => {
    assert.match(body, /if \(wasRemote && !target\) \{/);
    assert.match(body, /const fresh = await remoteSync\.pullNow\(sessionId\);/);
    assert.match(body, /先不切回本地 —— 切了那份工作就留在那台机器上了/);
  });

  test('**没有项目目录不是问题** —— 镜像它自己的会话目录，和本地那条路一样', () => {
    /* 上一版在这里要求"必须指定一个项目目录"，那是把"必须镜像点什么"和"必须有个项目"混成了一件事 */
    assert.equal(/还没有项目目录 —— 切到远端要先指定一个/.test(body), false, '这个要求不该再有');
    assert.match(body, /const nextLocalDir = localDirOrSessionDir\(/);
    /* 家目录那道闸还在 —— 只有"目录真的是家目录"时才撞上 */
    assert.match(body, /const refusal = mirrorRefusal\(nextLocalDir, os\.homedir\(\)\);/);
  });

  test('新建 / attach 两条路也一样：没项目就用会话目录，不是拒绝', () => {
    assert.match(M, /新建远程会话没有项目目录 -> 镜像会话目录/);
    assert.match(M, /没有项目目录（记录里没记、渲染层又只给了 `'~'`）→ 用会话目录/);
  });

  test('换机器 = 换进程：起新后端会话 + 逐段重建 + 镜像登记跟着走', () => {
    assert.match(body, /await withLoadTimeout\(client\.newSession\(cliCwd\), loadTimeoutFor\(profile\.remote\), 'session\/new'\)/);
    assert.match(body, /markContextOwedIfUnverified\(sessionId, 'switch-remote-target'\)/);
    assert.match(body, /remoteSync\.forget\(sessionId\);\s*\n\s*if \(target\) registerRemoteSync\(sessionId, profile, nextLocalDir\);/);
    /* 目录和目标都要落盘，否则下次 attach 又回到老样子 */
    assert.match(body, /rec\.localDir = nextLocalDir;/);
    assert.match(body, /rec\.profile = profile;/);
  });

  test('要在会话里说清换到哪、以及"对话一条都没动"', () => {
    assert.match(body, /这条会话从现在开始跑在\*\*\$\{where\}\*\*上/);
    assert.match(body, /之前的对话一条都没动/);
  });

  test('右键菜单是**一个入口、右侧展开**（本地 / 各远端），当前位置打 ✓', () => {
    /* 上一版是平铺：每台机器占一行，和下面那堆 🏷️ 项目混在一起，菜单越长越难扫。
       「这条会话在哪台机器上跑」是一个问题、多个互斥选项 —— 子菜单才是它的形状。 */
    assert.match(SB, /const Submenu: React\.FC</);
    assert.match(SB, /运行位置：\$\{ctxSession\.remoteHost \|\| '本地'\}/);
    assert.match(SB, /\{remoteTargets\.length > 0 && \(/);
    /* 当前在哪儿要能一眼看出来 */
    assert.match(SB, /ctxSession\.remoteHost \? '　' : '✓ '/);
    assert.match(SB, /ctxSession\.remoteHost === tg\.label \? '✓ ' : '　'/);
    /* 展开方向靠 CSS，不再写第二套边界计算 */
    const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');
    assert.match(CSS, /\.context-submenu-panel \{[^}]*left: 100%/s);
  });

  test('切换时**不强制**问目录（目录另有一条明确入口），失败要让人看见', () => {
    /* 切换那条路不许弹目录选择 —— 那个强制要求你否过一次；
       但"选工作目录"作为**单独一条菜单项**是需要的（远端只能看见被镜像的那个目录）。 */
    /* 只切 `onSetTarget` 自己的函数体 —— `onPickWorkdir`（它**应该**用 remotePickDir）就紧跟在后面 */
    const at = SB.indexOf('const onSetTarget');
    const end = SB.indexOf('const onPickWorkdir');
    assert.ok(at > 0 && end > at);
    assert.equal(/remotePickDir/.test(SB.slice(at, end)), false, '切换那条路不该弹目录');
    assert.match(SB, /📂 工作目录…/, '但要有单独的一条');
    /* 失败要让人看见 —— 这个动作会换执行器，静悄悄失败只会被当成"点了没反应" */
    assert.match(SB, /window\.alert\(String\(r\?\.error/);
  });
});

/*
 * 「现在显示不能把家目录推到远程服务器」—— 那条拒绝出现在**你根本没选过家目录**的时候：
 * 老会话的 `localDir` 是渲染层那三处硬写的 `'~'` 留下的（见 `SessionRecord.localDir`）。
 * 空目录和家目录是同一件事 —— 都表示"这条会话没有项目目录"，都该退回会话目录。
 */
describe('“没有项目目录”只有一种处理方式', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('空 / 家目录统一退回会话目录（一个函数，不是三份判断）', () => {
    assert.match(M, /function localDirOrSessionDir\(sessionId: string, candidate\?: string\): string \{/);
    assert.match(M, /if \(!dir \|\| dir === os\.homedir\(\)\.replace\(\/\\\/\+\$\/, ''\)\) return getSessionDir\(sessionId\);/);
  });

  test('三条路（新建 / attach / 换机器）都走它 —— 上一版只有两条走，第三条就撞了那句拒绝', () => {
    /* 数量随出口增加（冷路径切回本地也要算目录），钉的是"每条路都走它" */
    assert.ok((M.match(/localDirOrSessionDir\(/g) || []).length >= 4, '定义 1 处 + 新建/attach/换机器');
  });
});

/*
 * 「会话还没连上也应该能切远程切 project 啊」+「切了之后会话也没有远程 tag」+
 * 「切了之后那个右键菜单里为什么不变」—— 三件，两个 bug。
 */
describe('换机器：没连上也能切；切完界面要跟着变', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const at = M.indexOf("ipcMain.handle('acp:set-remote-target'");
  const body = M.slice(at, at + 8000);

  test('**没连上不再拒绝** —— 执行器是下次打开时按记录起的，要求"先连上"是多余的门槛', () => {
    assert.equal(/这条会话还没连上，先打开它再切换/.test(M), false, '这道门槛不许再有');
    assert.match(body, /if \(!oldEntry\) \{/);
    assert.match(body, /这条会话下次打开会跑在\*\*\$\{where\}\*\*上/);
    /* 冷路径只改记录 */
    assert.match(body, /rec\.localDir = nextLocalDir;\s*\n\s*store\.writeRecord\(rec\);/);
  });

  test('冷路径切回本地**照样先拉** —— 规则不能因为"没连上"就松掉', () => {
    assert.match(body, /if \(!remoteSync\.isRemote\(sessionId\)\) \{\s*\n\s*const coldProfile/);
    assert.match(body, /registerRemoteSync\(sessionId, coldProfile,/);
  });

  test('两条路都把新位置发给界面（事件里带 remoteHost）', () => {
    assert.equal((body.match(/session:targets-changed', \{ sessionId, remoteHost: hostLabelOf\(target\) \}/g) || []).length, 2);
  });

  test('渲染层**真的在听**这个事件（上一版发了但没人听 —— 徽标和菜单都停在旧值）', () => {
    const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');
    const HK = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');
    assert.match(P, /onTargetsChanged:/);
    assert.match(HK, /onTargetsChanged\?\.\(\(d: \{ sessionId: string; remoteHost: string \| null \}\)/);
    /* 徽标和右键菜单那句话看的是同一份状态，所以改一处就够 */
    assert.match(HK, /\{ \.\.\.s, remoteHost: d\.remoteHost \|\| undefined \}/);
  });
});

/*
 * 「模型的乘数怎么不见了」—— 它在 `feature/flow` 上有，`standard` 上没有：
 * 是我那次手工 backport 漏掉的（不是被谁删了）。后端本来就给这个字段，实测：
 *   {"model_name":"claude-opus-5", …, "rate_multiplier":2.2, "rate_unit":"Credit"}
 *   {"model_name":"auto",          …, "rate_multiplier":1.0}
 */
describe('模型列表显示价格乘数', () => {
  const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');

  test('列表里每一项都带乘数', () => {
    assert.match(CA, /function fmtRate\(multiplier: unknown\): string \{/);
    assert.match(CA, /fmtRate\(\(model as any\)\.rate_multiplier\)/);
  });

  test('`1.0` 也要显示 —— 不显示就分不出"一倍"和"没给数据"', () => {
    const at = CA.indexOf('function fmtRate');
    const body = CA.slice(at, at + 400);
    /* 只在拿不到/非正数时留空 */
    assert.match(body, /if \(!Number\.isFinite\(n\) \|\| n <= 0\) return '';/);
    assert.equal(/n === 1/.test(body), false, '不许把 1 当成"不用显示"');
    /* 整数不写小数点（那一行本来就窄） */
    assert.match(body, /Number\.isInteger\(n\) \? n : n\.toFixed\(1\)/);
  });
});

/*
 * 「把 history 那些文件不要再推了，那些纯粹是本地记录」。
 */
describe('本地记录不推到远端', () => {
  test('history.md / transcript.jsonl / events.jsonl 都在排除里', async () => {
    const { SESSION_DIR_EXCLUDES } = await import('../src/main/remoteMirror.ts');
    for (const f of ['history.md', 'transcript.jsonl', 'events.jsonl', 'record.json']) {
      assert.ok(SESSION_DIR_EXCLUDES.includes(f), `缺 ${f}`);
    }
  });

  test('镜像根是会话目录时，**推**也带上这些排除（不只是拉）', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /excludes: rootIsSessionDir \? \[\.\.\.DEFAULT_EXCLUDES, \.\.\.SESSION_DIR_EXCLUDES\] : undefined,/);
  });

  test('**注入里不能再提 history.md 的路径** —— 指向一个不存在的文件比不说更糟', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({ hostLabel: 'h', remoteDir: '/r', localDir: '/l', sessionDir: '/r/.kirolex-sessions/s1' });
    assert.match(b, /对话历史\*\*随消息带给你\*\*/);
    assert.match(b, /这台机器上没有 history\.md/);
    /* 附件还在那儿（它们是真的推过去的） */
    assert.match(b, /附件在 `\/r\/\.kirolex-sessions\/s1`/);
  });
});

/*
 * 「你自己写的那个提示什么的不要中断弄回对话框」+「为什么远程 session 换不了 project」。
 */
describe('KiroLex 的提示走状态行；换项目不许杀掉正在跑的一轮', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');

  test('提示只发事件、**不写进 transcript**', () => {
    assert.match(M, /function sessionNotice\(sessionId: string, text: string\): void \{/);
    assert.match(M, /mainWindow\?\.webContents\.send\('session:notice'/);
    /* 远程那几处（同步进度/冲突、agent 缺 MCP、模型降级、换机器、退回本地）都改走它了 */
    assert.ok((M.match(/sessionNotice\(/g) || []).length >= 6);
    /* 而"KiroLex 说的话不许发给模型"那条判据还在（历史里已经写进去的那些照旧要过滤） */
    assert.match(M, /\.filter\(modelFacing\)/);
  });

  test('界面上在**输入框上方**，能关、会自己消失（⚠️ 留久一点）', async () => {
    assert.match(CA, /\{sessionNotice && \(/);
    assert.ok(CA.indexOf('className={`session-notice') < CA.indexOf('<ChatInputBox'), '要在输入框上面');
    const HK = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useSessionNotice.ts'), 'utf8');
    assert.match(HK, /const FADE_MS = 12_000;/);
    assert.match(HK, /const WARN_MS = 45_000;/);
    /* 只显示当前会话的 —— 别的会话的进度不该盖住你正在看的 */
    assert.match(HK, /d\.sessionId !== sessionId/);
    /* 换会话要清掉，否则上一条的提示看起来像这条的 */
    assert.match(HK, /useEffect\(\(\) => \{ setNotice\(null\); \}, \[sessionId\]\);/);
  });

  test('换项目：**不拦**，但一轮在跑时不能在中间 detach（推迟到本轮结束）', () => {
    /* 这条一开始写成"busy 就拒绝"，而那让人在最想整理侧栏的时候什么都动不了 ——
       「这些右键菜单应该优先级大于正在跑的任务」。判据改成：记录立刻改，重置推迟。 */
    const at = M.indexOf("ipcMain.handle('acp:move-session'");
    const body = M.slice(at, at + 2000);
    assert.match(body, /const busy = !!sessionClients\.get\(sessionId\)\?\.busy;/);
    assert.match(body, /pendingProjectReset\.add\(sessionId\);/);
    /* 记录要在"要不要 detach"之前就写掉 —— 分组必须马上就对 */
    assert.ok(body.indexOf('store.writeRecord(') < body.indexOf('if (busy) {'));
  });
});

/*
 * 「为什么还是移动不了」/「草为什么远程 session 换不了 project」—— 真凶不是移动那条路：
 * 侧栏里出现了一个**以会话 id 命名的假项目**（实测分组名 `s_1790128678028_da1rhi`）。
 * 因为没归项目的远程会话镜像根是它自己的会话目录，而项目 id 是从目录名推出来的 ——
 * 于是每次 attach 都把它塞回那个假项目，你移到别处、下次连上又回来。
 */
describe('项目 id 不能从会话目录推出来', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('会话目录 / `~/.kirolex` 下的任何目录都不算项目', () => {
    assert.match(M, /function derivedProjectFor\(sessionId: string, dir: string\): string \| undefined \{/);
    assert.match(M, /if \(d === getSessionDir\(sessionId\) \|\| d\.startsWith\(path\.join\(os\.homedir\(\), '\.kirolex'\)\)\) return undefined;/);
  });

  test('新建和 attach 两条路都走它（旧判据只挡了家目录）', () => {
    assert.equal((M.match(/derivedProjectFor\(/g) || []).length, 3, '定义 1 处 + 两条路');
    assert.equal(/const derived = resolvedCwd === os\.homedir\(\) \? undefined : deriveProjectId\(resolvedCwd\)/.test(M), false,
      '旧判据不许留下 —— 它只挡家目录，会话目录照样会被推成项目');
  });
});

/*
 * 「为什么还是移动不了」的最后一环：水化时**渲染层的旧值优先于磁盘**
 * （`existing.projectId ?? rec.projectId`）。换项目是先写盘再更新界面，所以磁盘永远是较新的那一份；
 * 旧值优先的结果是每次水化又把它盖回那个以会话 id 命名的假项目。
 */
describe('换项目之后磁盘说了算', () => {
  const HK = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');

  test('水化时 projectId **完全**以记录为准，连"未分组"也是', () => {
    /*
      两版都错过：
        ① `existing.projectId ?? rec.projectId` —— 渲染层旧值优先，换完项目一水化就被盖回去；
        ② `rec.projectId ?? existing.projectId` —— 只在记录**有值**时生效，而"未分组"在记录里是
           字段不存在，于是又退回旧值（实测：磁盘已是未分组，侧栏还在 Dev）。
      换项目是先写盘再更新界面，所以直接用磁盘那一份，包括 undefined。
    */
    assert.match(HK, /projectId: rec\.projectId,/);
    assert.equal(/projectId: (existing\.projectId \?\? rec\.projectId|rec\.projectId \?\? existing\.projectId)/.test(HK), false);
  });

  test('别的字段照旧保留渲染层的值（这里只改 projectId 这一项）', () => {
    /* 例如 archived / pinned 的合并语义没动 —— 它们不是"先写盘再更新界面"的那类动作 */
    assert.match(HK, /archived: rec\.archived \?\? existing\.archived,/);
    assert.match(HK, /pinned: existing\.pinned \?\? rec\.pinned,/);
  });
});

/*
 * 「这些右键菜单应该优先级大于正在跑的任务」+「那个 AI 的会话还在跑但是左侧没有了」。
 */
describe('右键菜单不被正在跑的任务挡住；在跑的会话不许被折叠藏起来', () => {
  test('换项目：busy 时**照改**，只把执行器重置推迟到本轮结束', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf("ipcMain.handle('acp:move-session'");
    const body = M.slice(at, at + 2000);
    assert.equal(/throw new Error\('这一轮还在跑 —— 等它结束再换项目/.test(body), false, '不许再拦');
    assert.match(body, /pendingProjectReset\.add\(sessionId\);/);
    assert.match(body, /deferredReset: true/);
    /* 欠下的重置要在本轮结束时真的执行 */
    assert.match(M, /if \(pendingProjectReset\.delete\(sessionId\)\) \{/);
    assert.match(M, /本轮结束，执行下推的执行器重置/);
  });

  test('折叠的分组里，正在跑的那几条照样渲染', () => {
    const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');
    assert.match(SB, /\{collapsed && sessions\.some\(\(s\) => statusFor\(s\.id\) === 'streaming' \|\| statusFor\(s\.id\) === 'rebuilding'\)/);
    assert.match(SB, /folder-children-running/);
    /* 折叠状态本身不动 —— 那是用户的选择 */
    assert.match(SB, /折叠状态照旧（那是你的选择）/);
  });
});

/*
 * 「远程会话为什么访问不了本地的文件」+「一直在从远端下载啥啊」。
 */
describe('工作目录 / 不要推两遍', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');

  test('镜像根就是会话目录时**不再建第二份镜像**（那是推 21 秒的真正原因）', () => {
    assert.match(M, /session: rootIsSessionDir \? undefined : new RemoteMirror\(\{/);
    /* 实测：app 里推 21 秒，手动推同一份 5.9 秒 —— 差的就是第二遍 + 多两次 SSH 握手 */
    assert.match(M, /手动推同一份只要 5\.9 秒/);
  });

  test('收尾要不要拉：**先看协议事实**（locations/diffs），再退回标题判断', () => {
    assert.match(M, /const touchedFiles = \(Array\.isArray\(u\?\.locations\) && u\.locations\.length > 0\)/);
    assert.match(M, /\(touchedFiles \|\| toolMayHaveWritten\(/);
    /* 起因：网页搜索/知识库查询的标题带 search/fetch，被判成"可能写过文件"，于是每轮白拉一次 */
    assert.match(M, /Querying knowledge base/);
  });

  test('右键里有「📂 工作目录…」，且只在远程会话上出现', () => {
    assert.match(SB, /📂 工作目录…/);
    assert.match(SB, /const onPickWorkdir = async \(sessionId: string\): Promise<void> => \{/);
    const at = SB.indexOf('📂 工作目录…');
    assert.match(SB.slice(at - 400, at), /ctxSession\.remoteHost && \(/, '本地会话不需要这一条');
  });

  test('只换目录也算变化 —— 短路不能只看目标', () => {
    assert.match(M, /const dirChanged = !!localDir/);
    assert.match(M, /if \(\(target\?\.sshHost \|\| ''\) === currentRemote && !dirChanged\) return \{ ok: true, unchanged: true \};/);
  });
});
