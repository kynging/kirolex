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
    assert.match(M, /remoteHost: deriveRemoteLabel\(rec\.profile\.remote\.sshHost\)/);
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
    assert.match(M, /cat > \$\{remoteTmp\} && \$\{mcpEnv\}FORCE=/);
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
