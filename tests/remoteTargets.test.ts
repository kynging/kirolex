import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRemoteTargets, listRemoteTargets, findRemoteTarget, deriveLabel, expandHome } from '../src/main/remoteTargets.ts';

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
    /* 用本机的分隔符拼（identityFile 是给本机 ssh 读的）：Windows 上是 `\home\me\k.pem` */
    assert.equal(t.identityFile, path.join('/home/me', 'k.pem'), '配置里写 ~ 的人不该因此连不上');
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


describe('接线：主进程', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');

  test('目标按会话选：new-session 收 remoteId，不再读全局 active agent', () => {
    assert.match(M, /findRemoteTarget\(KIROLEX_CONFIG_PATH, remoteId\)/);
    assert.equal(/loadActiveRemoteTarget\(/.test(M), false, '全局开关那条路必须断掉，否则"共存"是假的');
  });

  test('没有「远程会话」开关了：一律当作开着，config.json 里写了 false 也不认', () => {
    /* 开关表里没有这一项 → loadFeatureFlags 只认表里的键，`features.remoteSessions: false` 自然被忽略；
       set-feature 也会拒绝它（unknown feature） */
    const table = M.slice(M.indexOf('const FEATURE_DEFAULTS'), M.indexOf('function loadFeatureFlags'));
    assert.ok(table.length > 0);
    assert.doesNotMatch(table, /^\s*remoteSessions:/m);
    assert.doesNotMatch(M, /isFeatureEnabled\('remoteSessions'\)/);
    const at = M.indexOf("ipcMain.handle('app:remote-targets'");
    assert.ok(at > 0);
    const body = M.slice(at, at + 900);
    /* 原来关着就回空列表，设置页于是永远看不到刚存的那台，人就一次次重加（实测攒了 4 条同 IP） */
    assert.doesNotMatch(body, /return \{ enabled: false, targets: \[\] \}/);
    assert.match(body, /enabled: true,/);
    /* new-session 认 remoteId，不再看开关 */
    assert.match(M, /const remote = findRemoteTarget\(KIROLEX_CONFIG_PATH, remoteId\);/);
    /* 渲染进程也不再因为 enabled 把机器列表清空 */
    const hook = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useRemoteTargets.ts'), 'utf8');
    assert.doesNotMatch(hook, /r\.enabled &&/);
    assert.match(hook, /targets: Array\.isArray\(r\.targets\) \? r\.targets : \[\]/);
    /* 设置页：功能开关里没有它，「远程会话当前是关着的」那段红字也删了 */
    const D = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/SettingsDialog.tsx'), 'utf8');
    assert.doesNotMatch(D, /remoteSessions/);
    const RS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
    assert.doesNotMatch(RS, /远程会话当前是关着的/);
    assert.doesNotMatch(RS, /remoteSessions/);
  });

  test('远程会话永远开；新建对话的机器列表随设置页的增删就地刷新，不用重启', () => {
    /* 「为什么加了远程机器还没有切换到远程会话的选项」 —— 连开关都没有了 */
    assert.doesNotMatch(M, /isFeatureEnabled\('remoteSessions'\)/);
    const hook = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useRemoteTargets.ts'), 'utf8');
    assert.match(hook, /window\.addEventListener\(REMOTE_TARGETS_CHANGED, load\);/);
    assert.match(hook, /window\.addEventListener\('focus', load\);/);
    const RS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
    assert.equal((RS.match(/notifyRemoteTargetsChanged\(\)/g) || []).length, 2, '存和删都要通知');
  });

  test('找不到那个 id 就不建会话（**不猜**一台机器）', () => {
    assert.match(M, /找不到远端目标/);
  });

  test('机器列表能查（那套"同步状态"的订阅/查询随镜像一起删掉了）', () => {
    assert.match(P, /remoteTargets:/);
    /* `remote:sync` / `remote:status` 是镜像时代的东西：现在远端没有副本，
       也就没有"在推/在拉/本地是旧的"这回事 */
    assert.equal(/remote:sync/.test(M), false);
    assert.equal(/ipcMain\.handle\('remote:status'/.test(M), false);
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

  test('新建对话框里有目标选择，而且**记住你上一次选的那台**', () => {
    assert.match(A, /remoteTargets\.enabled && remoteTargets\.targets\.length > 0/);
    assert.match(A, /<option value="">本地<\/option>/);
    /*
      **不再每次启动都退回本地** ——「新建的会话应该刚开始就有远程 tag」
      「为什么新会话又变成本地了」。
      这个值原来是 `useState('')`，于是每次重启后建的第一批会话都是本地的，哪怕你上一次
      明确选了东京 —— 你看到的"又变成本地"不是它被改回去了，是它从来没被记住。
      落在 ui-state 里，跟着你上一次明确的选择走；没选过仍然是本地（`|| ''`）。
    */
    assert.match(A, /uiGet\('kirolex-new-chat-remote'\) \|\| ''/);
    assert.match(A, /uiSet\('kirolex-new-chat-remote', newChatRemoteId\)/);
    /* 兜底那条建会话的路也要认这个默认（从侧栏直接开的 pending 会话没经过 createSession） */
    const HK = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');
    assert.match(HK, /uiGet\('kirolex-new-chat-remote'\) \|\| undefined/);
  });

  test('创建时把选中的目标传下去', () => {
    assert.match(A, /remoteId: target\?\.id, remoteLabel: target\?\.label,/);
  });

  test('侧栏每行常驻机器徽标（只说身份，不再有同步状态那一档）', () => {
    assert.match(SB, /session\.remoteHost && \(/);
    assert.match(SB, /className="session-remote"/);
    assert.match(SB, /🌐 \{session\.remoteHost\}/);
    /* 那套按 sessionId 缓存的同步状态（以及它的 warn 样式、context provider）随镜像一起删了 */
    assert.equal(/session-remote-warn/.test(SB), false);
    assert.equal(/useRemoteSyncFor/.test(SB), false);
    assert.equal(/RemoteSyncProvider/.test(MAIN), false);
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
    assert.ok(path.isAbsolute(saved.identityFile!), '读出来的是展开后的绝对路径');   // Windows 上是 C:\…，不以 / 开头
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
    assert.match(SD, /<RemoteSettings startNew=\{newMachinePending\} \/>/);
  });

  test('「测试连接」用的是**同一个**预检判据，不是另写一套', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf("ipcMain.handle('remote:test'");
    const body = M.slice(at, at + 1600);
    /* 同一个 `preflightScript` / `judgePreflight`，只是**不问模型列表**
       （「测试连接那里不必检测 kiro 模型」）—— 那一步要起一次 `kiro-cli chat`，是最慢的一段，
       而它不改变"连不连得上"这个结论。 */
    assert.match(body, /preflightScript\(undefined, \{ models: false \}\)/);
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

  test('脚本装的是这几样：kiro-cli / claude code / codex / node / git / unzip', () => {
    assert.match(SH, /kirocli-x86_64-linux\.zip/);
    assert.match(SH, /kirocli-aarch64-linux\.zip/, 'arm 的机器也要能装');
    assert.match(SH, /install\.sh' --no-confirm|install\.sh" --no-confirm/);
    assert.match(SH, /@anthropic-ai\/claude-code/);
    assert.match(SH, /@openai\/codex/);
    /* KiroLex 走 ACP：远端 Claude Code / Codex 会话起的就是这两个命令（engines.ts 的 REMOTE_ADAPTER_BIN） */
    assert.match(SH, /npm_i '@agentclientprotocol\/claude-agent-acp' claude-agent-acp/);
    assert.match(SH, /npm_i '@agentclientprotocol\/codex-acp' codex-acp/);
    assert.doesNotMatch(SH, /^npm_i '@zed-industries/m, '改名停更的老包不再装');
    for (const b of ['git', 'unzip']) assert.ok(SH.includes(b), `缺 ${b}`);
    /* rsync 不再装：镜像和 agent 同步都没了，远端没有任何东西用它 */
    assert.equal(/for b in rsync/.test(SH), false);
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

  test('只有缺 kiro-cli 才算失败 —— 远程会话就是在远端跑一个它', () => {
    assert.match(SH, /kiro-cli\) rc=1/);
    /* 以前 rsync/git 缺了也算失败：那是镜像时代的依赖，现在拿它们挡人就纯属误伤 */
    assert.equal(/rsync\|git\) rc=1/.test(SH), false);
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
    assert.match(M, /cat > \$\{remoteTmp\} && \$\{loginEnvStr\}FORCE=/);
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
    assert.match(RS, />\{installing \? '安装中…' : '安装 AI 工具'\}</);
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
 * 这里原来有一组"把 kiro-cli 默认 agent 的 web search MCP 装进远端 claude code"的测试
 * （连同 `webSearchMcp.ts`：从本机 `ps` 里读出那个 SigV4 网关地址，再 `claude mcp add`）。
 *
 * 整套去掉了 ——「脚本里也不要加那些什么配置 kiro-cli 自定义配置之类的信息」。安装脚本只装东西，
 * 不往 `~/.kiro` 里写配置：远端那条会话用的 agent 是 KiroLex 每次生成的一份（只有一条
 * `kirolex-local`），脚本塞进去的配置没人读，却会让人以为"配置在那儿"。
 */

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
    /* 同一时刻只在编辑一台，所以**机器级**的动作按钮只有一组（测试连接 / 安装 AI 工具 / 删除）。
       每个工具自己那个「测试」是另一件事 —— 它问的是"这条命令能不能起来"，不是"这台机器连不连得上"。 */
    assert.equal((RS.match(/>测试连接</g) || []).length, 1);
    assert.equal((RS.match(/>安装 AI 工具</g) || []).length, 0, '安装 AI 工具那个按钮带状态文案');
    assert.match(RS, /\{installing \? '安装中…' : '安装 AI 工具'\}/);
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
    assert.match(HK, /remoteHost: rec\.remoteHost,\s*\n\s*localDir: rec\.localDir,/, '新从磁盘读到的会话');
    /* 工作目录是同一个白名单里的第二个字段（会话界面上那个 📂 显示的就是它）—— 漏一个就等于没这个功能 */
    assert.match(HK, /localDir: rec\.localDir \?\? \(existing as any\)\.localDir,/, '已有的会话的工作目录');
  });

  test('徽标在右侧那排的**最末**，紧挨删除按钮', () => {
    /* 切换中那个 ⏳ 版本和真 tag 是同一格（见 Sidebar 的 pendingTargets） */
    const at = SB.indexOf('{pendingTarget !== undefined ? (');
    const del = SB.indexOf('className="session-delete-btn"');
    assert.ok(at > 0 && del > at, '顺序：… → 🌐 → ✕');
    /* 中间不许再插别的 tag */
    assert.equal(/session-(crew|schedule)/.test(SB.slice(at, del)), false);
  });

  test('同一组里拖动能调顺序，而且重启后还在', () => {
    /* 「现在拖拽会话不能调整其前后顺序，这个不对」 */
    assert.match(SB, /onReorderSessions\?\.\(arrayMove\(sessions, from, to\)\);/);
    assert.doesNotMatch(SB, /if \(\(dragged\.projectId \?\? null\) === targetProject\) return; \/\/ no change/);
    const app = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
    assert.match(app, /onReorderSessions=\{reorderSessions\}/);
    /* 水化不再把整份列表按时间重排 —— 只有新冒出来的按时间放最前 */
    const hook = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');
    assert.match(hook, /\.\.\.kept\.filter\(\(s\) => known\.has\(s\.id\)\),/);
  });

  test('点了「运行位置」立刻挂上 ⏳ tag，结束（成功或失败）就撤掉', () => {
    /* 「点切换了之后没有立刻打上 tag」：真 tag 要等远端探完、执行器起完才来 */
    const at = SB.indexOf('const onSetTarget = async');
    const body = SB.slice(at, at + 900);
    assert.ok(body.indexOf('setPendingTarget(sessionId, remoteId ?') < body.indexOf('api.setRemoteTarget(sessionId, remoteId, undefined, { projectId })'), '先挂 tag 再等 IPC');
    assert.match(body, /\.finally\(\(\) => setPendingTarget\(sessionId, undefined\)\)/);
    assert.match(SB, /⏳ \{pendingTarget \|\| '本地'\}/);
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

  test('host 取自**会话状态**（`session.remoteHost`），不是同步状态', () => {
    /* 原来读的是同步状态里的 hostLabel。那是"此刻在推/在拉"，不是身份 —— 切回本地时
       主进程只是 forget 掉目标，渲染层那份缓存还留着最后一次的 hostLabel，于是本地会话
       的命令面板上继续挂着 🌐（见「切回本地之后 🌐 必须消失」那一组）。 */
    assert.match(CA, /const remoteHostLabel = remoteHost \? remoteHost\.replace/);
    /* 去掉 user@：那一段不区分机器，而面板很窄 */
    assert.match(CA, /replace\(\/\^\[\^@\]\*@\/, ''\)/);
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
  test('说清三件事：我在哪、用户的文件在他那台机器上、以及用哪组工具去碰', async () => {
    /* **镜像去掉之后这段话变了**（「把镜像去掉，给远程配一些能调用本地 MCP 的能力」）：
       原来说的是"本地路径要换算成远端镜像路径"，现在没有镜像 —— 要说的是
       "项目根本不在你这台机器上，用 local_* 工具直连用户那边"。 */
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({
      hostLabel: 'aws-tokyo',
      remoteDir: '/home/ec2-user/kirolex-mirror/scratch/blog-1234abcd',
      localDir: '/Users/k/code/blog',
    });
    assert.match(b, /\[运行环境：远程\]/);
    assert.match(b, /aws-tokyo/);
    /* 最关键的一条：文件在用户那台机器上，而且给出工具名 */
    assert.match(b, /用户的文件在他自己那台机器上，不在这里/);
    assert.match(b, /local_read/);
    assert.match(b, /\/Users\/k\/code\/blog/);
    /*
      远端那个目录以前叫"草稿目录、项目不在这里"，现在改叫**工作区** ——
      「默认是在远程做，除非文件在本地」：那句"草稿"读起来像"这台机器没什么用"，
      于是它把装依赖、下载这类事也搬回用户的笔记本上跑（每次都过一遍 184ms 隧道）。
      仍然要说清产出得交回去，所以 `local_write` 这条不动。
    */
    assert.match(b, /就是你的工作区/);
    assert.match(b, /local_write/);
    /* 换算那一套不该再出现（没有镜像可换算） */
    assert.equal(/那个路径在这台机器上不存在/.test(b), false);
  });

  test('还要说清：构建和测试去**用户机器**上跑（以前是"别在远端构建"）', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({ hostLabel: 'h', remoteDir: '/r', localDir: '/l' });
    /* 以前只能说"说出来让用户自己在本地做"——现在它自己能做，因为 local_bash 就在用户机器上 */
    assert.match(b, /local_bash/);
    assert.match(b, /node_modules/);
    assert.equal(/以用户本地那份为准/.test(b), false, '同步那套说法已经不成立');
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
    /*
      **按调用名定位，不按完整实参定位**：`buildMemoryInjection` 现在还要传
      `{ remote }`（远程会话的 memory 文件在用户机器上，只有 `local_write` 到得了），
      写死实参会让这条在加参数时假失败 —— 而它要守的是**顺序**，跟实参无关。
    */
    const memAt = M.indexOf('buildMemoryInjection(effectiveProjectId, sessionId');
    assert.ok(memAt > 0, '找不到 memory 注入的调用');
    assert.ok(
      M.indexOf('const rc = remoteContextFor(sessionId, entry);') < memAt,
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

  /* 「移动项目」子菜单里**不应该有**移到未分组（用户后来的要求），右键菜单里就不再有这一条 */
  test('右键菜单里不再有「移到未分组」这一条', () => {
    const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');
    assert.equal(SB.includes("t('Unassign')"), false);
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
    /* 用户名单独一栏之后，"只填了用户名"（sshHost = "user@"）也算空 */
    assert.match(RS, /if \(!draft \|\| !splitSshHost\(draft\.sshHost\)\.host\.trim\(\)\) return;/);
  });

  test('**签名比对** —— 只是切换/打开时不该写盘', () => {
    assert.match(RS, /if \(mine === savedSig\.current\) return;/);
    /* 加载和切换两处都要对齐签名，否则打开设置就写一遍 */
    assert.equal((RS.match(/savedSig\.current = sig\(d\)/g) || []).length, 2);
  });

  test('**新建那条存完要认领 id** —— 否则改个名字就多出来一台机器', () => {
    /* 每次存完都认领（顺带把「清除密码」这个待办清掉），第一次存完还要把下拉切到它 */
    assert.match(RS, /setDraft\(\(d\) => \(d \? \{ \.\.\.d, id: saved\.id, clearPassword: false, hasPassword: saved\.hasPassword \} : d\)\);/);
    assert.match(RS, /if \(!draft\.id\) setPicked\(saved\.id\);/);
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
    for (const label of ['名称', 'IP 地址', '用户名', '端口', '私钥', '工作目录']) {
      assert.ok(RS.includes(`label="${label}"`), `缺标签 ${label}`);
    }
    assert.match(RS, /const Field: React\.FC</);
  });

  test('要填的框都不放示例 placeholder ——「不要加示例」', () => {
    const read = (f: string): string => fs.readFileSync(path.join(process.cwd(), 'src/renderer/components', f), 'utf8');
    /* 灰字示例扫一眼分不出"没填"和"填的就是这个"；空输入框本身就说明"没填" */
    assert.equal(/placeholder=/.test(read('RemoteSettings.tsx')), false, '机器设置');
    assert.equal(/placeholder=\{t\("A custom (mono )?font stack/.test(read('SettingsDialog.tsx')), false, '自定义字体');
    assert.equal(/placeholder="09:00"/.test(read('ChatArea.tsx')), false, '定时任务的时间');
    for (const f of ['RemoteSettings.tsx', 'SettingsDialog.tsx', 'ChatArea.tsx', 'BackupSettings.tsx', 'KiroConfigPanel.tsx']) {
      assert.equal(/placeholder=[^\n]*(例如|比如|e\.g\.)/.test(read(f)), false, `${f} 里还有示例 placeholder`);
    }
  });

  test('打开设置默认显示：没有远端 = 本机，有就是最近编辑的那台，而不是「添加一台」', async () => {
    const { defaultPick, LOCAL } = await import('../src/renderer/remotePick.ts');
    assert.equal(defaultPick([]), LOCAL);
    assert.equal(defaultPick([{ id: 'a', editedAt: 5 }, { id: 'b', editedAt: 9 }, { id: 'c', editedAt: 1 }]), 'b');
    assert.equal(defaultPick([{ id: 'a' }, { id: 'b' }]), 'b', '老配置没有 editedAt：最近加的那台');
    /* 设置页真的用它，而不是原来那句「第一台，没有就新建」 */
    const RS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
    assert.match(RS, /: defaultPick\(list\);/);
    assert.doesNotMatch(RS, /list\[0\]\?\.id \|\| NEW/);
  });

  test('存一条会盖上 editedAt，读回来还在', async () => {
    const { saveRemoteTarget, listRemoteTargets } = await import('../src/main/remoteTargets.ts');
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edited-')), 'config.json');
    fs.writeFileSync(f, '{}');
    const before = Date.now();
    saveRemoteTarget(f, { label: 'x', sshHost: 'u@h' });
    const [t] = listRemoteTargets(f);
    assert.ok((t.editedAt || 0) >= before);
  });

  test('界面上没有跳板机 ——「不要它」', () => {
    const RS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
    assert.equal(RS.includes('label="跳板机"'), false);
  });

  test('工作目录留空 = 那台机器上的 ~/kirolex（写成绝对路径：用的地方会加引号，引号里的 ~ 不展开）', async () => {
    const { defaultRemoteWorkdir, sessionCwd } = await import('../src/main/config.ts');
    assert.equal(defaultRemoteWorkdir('ec2-user@1.2.3.4'), '/home/ec2-user/kirolex');
    assert.equal(defaultRemoteWorkdir('root@h'), '/root/kirolex');
    const cwd = sessionCwd({ model: 'm', remote: { enabled: true, sshHost: 'ec2-user@h' } } as any, '/Users/me/blog');
    assert.match(cwd, /^\/home\/ec2-user\/kirolex\/scratch\/blog-[0-9a-f]{8}$/);
  });

  test('同 IP 的重复项留**最近编辑的**那条，按旧 id 也能找到它', async () => {
    const { listRemoteTargets, findRemoteTarget } = await import('../src/main/remoteTargets.ts');
    /* 实测的那份 config.json：同一台机器被重加了四次，带私钥的是后面几条 */
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dup-')), 'config.json');
    fs.writeFileSync(f, JSON.stringify({ remotes: [
      { id: 'aws-tokyo', label: 'aws-tokyo', sshHost: '99.83.165.184', sshPort: 22 },
      { id: 'aws-tokyo-2', label: 'aws-tokyo', sshHost: '99.83.165.184', sshPort: 22, identityFile: '/k.pem', editedAt: 100 },
      { id: 'aws-tokyo-3', label: 'aws-tokyo', sshHost: '99.83.165.184', sshPort: 22, editedAt: 200 },
      { id: 'aws-tokyo-4', label: 'aws-tokyo', sshHost: '99.83.165.184', sshPort: 22, identityFile: '/k.pem', editedAt: 300 },
    ] }));
    const list = listRemoteTargets(f);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'aws-tokyo-4');
    assert.equal(list[0].identityFile, '/k.pem', '选过的私钥不能被一条更早的空项盖住');
    assert.equal(findRemoteTarget(f, 'aws-tokyo')?.id, 'aws-tokyo-4', '会话里记着被去重掉的 id 也要能连上');
    assert.equal(findRemoteTarget(f, 'nope'), undefined);
  });

  test('界面填进去的 ~/kirolex 也要展开 —— 引号里的 ~ 是一个叫 ~ 的目录', async () => {
    const { resolveRemoteWorkdir, sessionCwd } = await import('../src/main/config.ts');
    assert.equal(resolveRemoteWorkdir('~/kirolex', 'ec2-user@h'), '/home/ec2-user/kirolex');
    assert.equal(resolveRemoteWorkdir('~', 'root@h'), '/root');
    assert.equal(resolveRemoteWorkdir('/data/kx', 'ec2-user@h'), '/data/kx', '绝对路径原样');
    assert.equal(resolveRemoteWorkdir(undefined, 'u@h'), '/home/u/kirolex', '没填 = 默认');
    /* 用户名留空：ssh 用本机用户名登录，家目录也按它算 */
    assert.equal(resolveRemoteWorkdir('~/kirolex', 'h', 'kyn06'), '/home/kyn06/kirolex');
    assert.equal(resolveRemoteWorkdir('~/kirolex', 'h', ''), '~/kirolex', '连本机用户名都不知道才原样');
    const cwd = sessionCwd({ model: 'm', remote: { enabled: true, sshHost: 'ec2-user@h', remoteWorkdir: '~/kirolex' } } as any, '/Users/me/blog');
    assert.match(cwd, /^\/home\/ec2-user\/kirolex\/scratch\//);
  });

  test('用户名单独一栏，存下去仍然是 用户名@IP', async () => {
    const { splitSshHost, joinSshHost, DEFAULT_WORKDIR } = await import('../src/renderer/remotePick.ts');
    assert.deepEqual(splitSshHost('ec2-user@1.2.3.4'), { user: 'ec2-user', host: '1.2.3.4' });
    assert.deepEqual(splitSshHost('1.2.3.4'), { user: '', host: '1.2.3.4' });
    assert.equal(joinSshHost('ec2-user', '1.2.3.4'), 'ec2-user@1.2.3.4');
    assert.equal(joinSshHost('', '1.2.3.4'), '1.2.3.4');
    assert.equal(DEFAULT_WORKDIR, '~/kirolex');
    const RS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
    assert.ok(RS.includes('label="用户名"'));
    /* 只填了用户名（sshHost = "user@"）不算一台机器，不许自动保存 */
    assert.match(RS, /if \(!draft \|\| !splitSshHost\(draft\.sshHost\)\.host\.trim\(\)\) return;/);
    assert.match(RS, /remoteWorkdir: DEFAULT_WORKDIR \}/, '新机器的工作目录直接填上默认值');
  });

  test('「安装 AI 工具」要先测试连接通过，改了连接参数就得重测', async () => {
    const { connectionKey } = await import('../src/renderer/remotePick.ts');
    const a = { sshHost: 'u@h', sshPort: 22 };
    assert.equal(connectionKey(a), connectionKey({ ...a, id: 'x' } as any), '拿到 id 不算改了连接');
    assert.notEqual(connectionKey(a), connectionKey({ ...a, sshHost: 'v@h' }));
    assert.notEqual(connectionKey(a), connectionKey({ ...a, identityFile: '/k.pem' }));
    const RS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
    assert.match(RS, /disabled=\{locked \|\| !canAct \|\| !connVerified\}/);
    assert.match(RS, /setTestedOk\(r\?\.ok \? tested : ''\)/);
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
    assert.match(M, /\$\{loginEnvStr\}FORCE=/);
  });
});

/*
 * 「ppt 需要的那些库啥的它都在脚本里了吗」→ 当时加了（python-pptx / openpyxl / pandas），
 * 现在又去掉了：那是**镜像时代**的需求 —— 生成 .pptx 的脚本跑在远端、产出留在远端镜像里，
 * 所以远端得有那些库。现在产出必须落在用户机器上，而脚本本来就用 `local_bash` 在**他机器**上跑
 * （那里有他的 python 环境）。在远端装一套没人用的库，只是让"装依赖"这一步更慢、更容易失败。
 */
describe('脚本不再装远端用不到的东西', () => {
  const SH = fs.readFileSync(path.join(process.cwd(), 'scripts/remote-bootstrap.sh'), 'utf8');

  test('python 库那一步整个去掉了（产出落在用户机器上）', () => {
    assert.equal(/python-pptx|openpyxl/.test(SH), false);
    assert.equal(/python 库/.test(SH), false);
  });

  test('仍然不装 LibreOffice，也不装项目依赖', () => {
    const installs = SH.split('\n').filter((l) => /^\s*(sudo\s+)?(dnf|yum|apt-get|npm|python3 -m pip)\s/.test(l));
    const joined = installs.join('\n');
    assert.equal(/libreoffice|soffice/i.test(joined), false);
    assert.equal(/npm\s+(ci|install)(?!\s+-g)/.test(joined), false);
  });
});

/*
 * 「你把远程 kiro 的那些 agent 啥的清理一下，包括 mcp 啥的应该都不需要了。
 *   到时候直接让远程配置一些和本地不一样的」。
 *
 * 这里原来有一组"同步 agent 到远端 + 去远端验一遍"的测试。整套机制去掉了，原因实测过：
 *   · 推过去的那些 JSON **没人读** —— 远端用的是 KiroLex 每次生成的 `kirolex-local-<会话>.json`；
 *   · 拷 `mcpServers` 是**有害**的：命令是本机路径，远端没有，kiro-cli 不报错、只静默少工具；
 *   · `resources: file:///Users/...` 每次启动都打 `File URI not found`。
 * 生成那一份的判据在 tests/localMcp.test.ts（`buildSessionAgent`：按白名单挑字段）。
 */
describe('远端不再有"同步过去的"配置', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('没有 rsync 推 agent 这一步了，连远端的 rsync 依赖都跟着去掉', async () => {
    assert.equal(/syncKiroAgent/.test(M), false);
    assert.equal(/agentSyncArgs/.test(M), false);
    const { REQUIRED_TOOLS } = await import('../src/main/remotePreflight.ts');
    assert.deepEqual(REQUIRED_TOOLS, ['kiro-cli'], '远端只需要 kiro-cli');
  });

  test('本机这边**连读定义都不需要了** —— agent 在远端按名字解析', async () => {
    /* 「切换远程的时候，对面不会有同样的 agent 配置，这时候如果有同名的 agent 就用同名的，
       没有就切回默认的」：底子文件在远端，所以合并动作也在远端做（`remoteAgentScript`）。
       于是 `kiroAgents.ts`（读本机 ~/.kiro/agents）整个不需要了。 */
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.equal(/kiroAgents/.test(M), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'src/main/kiroAgents.ts')), false);
  });

  test('安装脚本也不再往 ~/.kiro 里写东西', () => {
    const SH = fs.readFileSync(path.join(process.cwd(), 'scripts/remote-bootstrap.sh'), 'utf8');
    assert.equal(/claude mcp add/.test(SH), false, '不再登记 MCP');
    assert.equal(/WEBSEARCH_MCP_URL/.test(SH), false);
    assert.equal(/\.kiro\/agents/.test(SH), false, '不许碰 agent 目录');
    /* 装的东西还在：kiro-cli / node / claude / codex / python 库 */
    assert.match(SH, /kiro-cli/);
    assert.match(SH, /@openai\/codex/);
    /* rsync 不再是它要装的系统包（没人用了） */
    assert.equal(/for b in rsync/.test(SH), false);
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
  /* 锚在**那段机械**上，不是 IPC 名字上：换机器和只换目录现在共用它（`applySessionTarget`），
     两个 IPC 都只剩几行解析参数 —— 锚在 IPC 上会切到一段几乎空的代码，然后每条断言都"过了"。 */
  const at = M.indexOf('const applySessionTarget = async (');
  const body = M.slice(at, at + 6000);

  test('**右键菜单优先于正在跑的任务**：照切，只是明确说那一轮被打断了', () => {
    assert.ok(at > 0, 'IPC 要存在');
    /* 上一版在 busy 时直接拒绝 —— 一条长回合跑着时什么都改不了，而那正是你想改设置的时候 */
    assert.equal(/throw new Error\('这一轮还在跑 —— 等它结束再切换机器/.test(body), false);
    assert.match(body, /const interrupted = !!oldEntry\?\.busy;/);
    assert.match(body, /切换打断了正在跑的那一轮/);
    assert.match(body, /已产出的内容都在/);
  });


  test('**没有项目目录不是问题**，而且家目录那道闸也随镜像一起去掉了', () => {
    /* 上一版在这里要求"必须指定一个项目目录"，那是把"必须镜像点什么"和"必须有个项目"混成了一件事 */
    assert.equal(/还没有项目目录 —— 切到远端要先指定一个/.test(body), false, '这个要求不该再有');
    assert.match(body, /const nextLocalDir = localDirOrSessionDir\(/);
    /* `mirrorRefusal` 防的是"把家目录推上远端"。没有镜像 = 没有任何东西被推走 =
       那道闸只会拦住一条本来正常的会话。 */
    assert.equal(/mirrorRefusal\(nextLocalDir/.test(body), false, '闸门跟着镜像一起走');
  });

  test('新建 / attach 两条路也一样：没项目就用会话目录，不是拒绝', () => {
    assert.match(M, /新建远程会话没有项目目录 -> 镜像会话目录/);
    assert.match(M, /没有项目目录（记录里没记、渲染层又只给了 `'~'`）→ 用会话目录/);
  });

  test('换机器 = 换进程：起新后端会话 + 逐段重建', () => {
    assert.match(body, /await withLoadTimeout\(client\.newSession\(cliCwd\), loadTimeoutFor\(profile\.remote\), 'session\/new'\)/);
    assert.match(body, /markContextOwedIfUnverified\(sessionId, 'switch-remote-target'\)/);
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
    /* 一直显示：一台远端都没配时子菜单里只有「本地」（和最下面的「添加机器」） */
    assert.doesNotMatch(SB, /remoteTargets\.length > 0 &&/);
    /* 当前在哪儿要能一眼看出来 */
    assert.match(SB, /ctxSession\.remoteHost \? '　' : '✓ '/);
    assert.match(SB, /ctxSession\.remoteHost === tg\.label \? '✓ ' : '　'/);
    /* 展开方向靠 CSS，不再写第二套边界计算 */
    const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');
    assert.match(CSS, /\.context-submenu-panel \{[^}]*left: 100%/s);
  });

  test('「运行位置」子菜单最下面有「＋ 添加机器…」：关菜单、带着「机器页 + 新建」打开设置', () => {
    const at = SB.indexOf('运行位置：${ctxSession.remoteHost');
    assert.ok(at > 0);
    const sub = SB.slice(at, SB.indexOf('</Submenu>', at));
    /* 在各台机器之后、子菜单结尾之前：分隔线 + 添加机器 */
    const list = sub.indexOf('remoteTargets.map(');
    const add = sub.indexOf('＋ 添加机器…');
    assert.ok(list > 0 && add > list, '「添加机器」在各台机器下面');
    assert.match(sub.slice(list, add), /context-menu-divider/);
    assert.match(sub, /onClick=\{\(\) => \{ setContextMenu\(null\); onAddMachine\?\.\(\); \}\}/);
    assert.match(SB, /onAddMachine\?: \(\) => void;/);
    /* App：机器页 + 直接进入新建；别的入口（齿轮）把新建参数清掉，行为不变 */
    const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
    assert.match(A, /onAddMachine=\{\(\) => \{ setSettingsTab\('machines'\); setSettingsNewMachine\(true\); setShowSettings\(true\); \}\}/);
    assert.match(A, /onSettings=\{\(\) => \{ setSettingsTab\(undefined\); setSettingsNewMachine\(false\); setShowSettings\(true\); \}\}/);
    assert.match(A, /startNewMachine=\{settingsNewMachine\}/);
    /* SettingsDialog 把它交给机器页；机器页首次加载就选中「+ 添加一台机器…」、给一张空表 */
    const D = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/SettingsDialog.tsx'), 'utf8');
    assert.match(D, /startNewMachine\?: boolean;/);
    assert.match(D, /useState\(!!startNewMachine\)/);
    assert.match(D, /<RemoteSettings startNew=\{newMachinePending\} \/>/);
    const RS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
    assert.match(RS, /useEffect\(\(\) => \{ void reload\(startNew \? NEW : undefined\); \}, \[\]\);/);
    assert.match(RS, /if \(next === NEW\) \{ setDraft\(\{ \.\.\.EMPTY \}\); savedSig\.current = sig\(\{ \.\.\.EMPTY \}\); return; \}/);
  });

  test('切换时**不强制**问目录（目录是会话界面上一个独立的东西），失败要让人看见', () => {
    /* 切换那条路不许弹目录选择 —— 那个强制要求你否过一次。
       现在侧栏**整个**不碰目录了（见下面「工作目录在会话界面」那一组）。 */
    assert.equal(/remotePickDir/.test(SB), false, '侧栏不该再弹目录选择');
    /* 失败要让人看见 —— 这个动作会换执行器，静悄悄失败只会被当成"点了没反应" */
    /* 不用 window.alert —— 它是模态的，弹着的时候整个界面都停住；换成不阻塞的提示条 */
    assert.match(SB, /showToast\(`✗ 切换运行位置失败：/);
    assert.doesNotMatch(SB, /window\.alert\(/);
  });
});

/*
 * 「现在显示不能把家目录推到远程服务器」—— 那条拒绝出现在**你根本没选过家目录**的时候：
 * 老会话的 `localDir` 是渲染层那三处硬写的 `'~'` 留下的（见 `SessionRecord.localDir`）。
 * 空目录和家目录是同一件事 —— 都表示"这条会话没有项目目录"，都该退回会话目录。
 */
describe('“没有项目目录”只有一种处理方式', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('一个函数决定目录 —— 后来定成「这个 folder 完全不应该动」：永远是会话的 files/', () => {
    assert.match(M, /function localDirOrSessionDir\(sessionId: string, _candidate\?: string\): string \{/);
    assert.match(M, /\n  return sessionFilesDir\(sessionId\);\n\}/);
    assert.match(M, /const dir = path\.join\(getSessionDir\(sessionId\), SESSION_FILES_DIR\);/);
    /* 本地那条路也走它，不再落到共用的 ~/kirolex */
    assert.match(M, /function localCwdFor\(sessionId: string, dir\?: string\): string \{[\s\S]{0,120}return localDirOrSessionDir\(sessionId, dir\);/);
    /* 项目目录不当 cwd，每一轮告诉模型它在哪 */
    assert.match(M, /const note = workdirNoteFor\(sessionId, entry\);/);
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
  const at = M.indexOf('const applySessionTarget = async (');
  const body = M.slice(at, at + 8000);

  test('**没连上不再拒绝** —— 执行器是下次打开时按记录起的，要求"先连上"是多余的门槛', () => {
    assert.equal(/这条会话还没连上，先打开它再切换/.test(M), false, '这道门槛不许再有');
    assert.match(body, /if \(!oldEntry\) \{/);
    assert.match(body, /这条会话下次打开会跑在\*\*\$\{where\}\*\*上/);
    /* 冷路径只改记录 */
    assert.match(body, /rec\.localDir = nextLocalDir;\s*\n\s*store\.writeRecord\(rec\);/);
  });


  test('两条路都把新位置发给界面（事件里带 remoteHost + 工作目录）', () => {
    /* 工作目录也在事件里：切远端时可以顺带换目录，记录和界面要一起变 */
    const sent = body.match(/session:targets-changed', \{ sessionId, remoteHost: hostLabelOf\(target\), localDir: nextLocalDir \}/g) || [];
    assert.equal(sent.length, 2, `只有 ${sent.length} 处发了完整的新位置`);
  });

  test('渲染层**真的在听**这个事件（上一版发了但没人听 —— 徽标和菜单都停在旧值）', () => {
    const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');
    const HK = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');
    assert.match(P, /onTargetsChanged:/);
    assert.match(HK, /onTargetsChanged\?\.\(\(d: \{ sessionId: string; remoteHost: string \| null; localDir\?: string \}\)/);
    /* 徽标和右键菜单那句话看的是同一份状态，所以改一处就够 */
    assert.match(HK, /\{ \.\.\.s, remoteHost: d\.remoteHost \|\| undefined, localDir: d\.localDir \|\| s\.localDir \}/);
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

  /*
    这里原来还有两条关于**推几遍 / 收尾要不要拉**的断言（「一直在从远端下载啥啊」那一串）。
    镜像整个删掉之后它们连题目都不存在了：远端没有副本，没有推、也没有拉。
    那两次调查留下的事实仍然值钱，所以记在这儿而不是悄悄消失：
      · 同一个本地目录被当成"项目镜像 + 会话镜像"推了两遍 —— app 里 21 秒，手动推同一份 5.9 秒；
      · 纯生成的一轮也在收尾拉一次（5–7 秒），只因为判据是标题匹配，而"网页搜索"的标题里有 search。
  */

  test('工作目录**不在右键菜单里**了 —— 它在会话界面', () => {
    /* 「工作目录这个东西放到右侧会话，不要放在右键菜单」：它是个常驻事实（这条会话读写哪棵树），
       菜单里既显示不出当前值、也提示不了这件事存在 —— 而「远程会话为什么访问不了本地的文件」
       那次之所以只能靠猜，就是因为它当时在界面上根本不存在。 */
    assert.equal(/📂 工作目录…/.test(SB), false, '菜单里不该再有这一条');
    assert.equal(/onPickWorkdir/.test(SB), false, '侧栏也不该再有这个动作');
  });

  test('只换目录也算变化 —— 短路不能只看目标', () => {
    assert.match(M, /const dirChanged = !!localDir/);
    assert.match(M, /=== currentRemote && !dirChanged\) return \{ ok: true, unchanged: true \};/);
  });
});

/*
 * 「工作目录这个东西放到右侧会话，不要放在右键菜单」。
 *
 * 为什么这个位置是对的：它是个**常驻事实**（这条会话读写哪棵树），而远端只看得见被镜像的那一个
 * 目录 —— 「远程会话为什么访问不了本地的文件」那次之所以只能靠猜，就是因为这个值在界面上
 * 根本不存在。菜单项既显示不出当前值，也提示不了这件事存在。
 */
describe('工作目录在会话界面上', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');
  const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
  const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');

  /* 「把会话这里的工作目录功能删了」→「把这个功能移除了得了」：界面那一格和主进程那条 IPC 都没了 */
  test('会话界面上没有 📂 工作目录那一格', () => {
    assert.doesNotMatch(CA, /composer-meta-btn composer-workdir/);
    assert.doesNotMatch(CA, /const workdirTitle =/);
    assert.doesNotMatch(A, /workdir=\{session\?\.localDir\}/);
    /* 记录里的工作目录照样水化（主进程还在发、远程会话的 cwd 仍以它为准） */
    assert.match(M, /\.\.\.\(rec\.localDir \? \{ localDir: rec\.localDir \} : null\),/);
  });

  test('没有单独换目录的 IPC 了', () => {
    assert.doesNotMatch(P, /setWorkdir/);
    assert.doesNotMatch(M, /acp:set-workdir/);
  });

  test('切机器只有一段机械，目录跟着切远端那一步走', () => {
    assert.match(M, /const applySessionTarget = async \(/);
    assert.equal((M.match(/const applySessionTarget = async \(/g) || []).length, 1);
    assert.match(M, /return applySessionTarget\(sessionId, target, localDir, hint\);/);
  });
});


/*
 * 「确保远程 session 在 archive 和恢复的时候也带远程 tag，不要恢复就变成本地的」。
 *
 * 实测（CDP 驱动真实例）：归档再恢复之后记录里 `remoteHost=tokyo-ec2`、`localDir` 也没变，
 * 恢复时的 attach 会把镜像重新登记上（`remoteStatus` 回 `hostLabel: tokyo-ec2`）。
 * 这一组把"为什么它是对的"钉住 —— 归档这条路碰的东西越少越好。
 */
describe('归档 / 恢复不许把远程会话变成本地的', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const HK = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');

  test('归档只动 archived —— 不碰 projectId、更不碰 profile.remote', () => {
    const at = M.indexOf("ipcMain.handle('acp:archive-session'");
    /*
      **按"到下一个 handler"截断，并剥掉注释**。两件事都必要：
        · 这个 handler 现在带一长段注释（解释为什么不再抹 projectId），固定 700 字符
          全被注释吃掉，断言会在注释里找东西；
        · 放大窗口又会跨进下一个 handler（`acp:delete-project-memory` 里就有 projectId），
          于是"归档碰了项目绑定"这条会假阳性。
    */
    const rest = M.slice(at + 20);
    const end = rest.indexOf('ipcMain.handle(');
    const body = (end > 0 ? rest.slice(0, end) : rest).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(at > 0);
    assert.match(body, /rec\.archived = !!archived;/);
    /*
      **projectId 也不许碰了** —— 原来这里是 `if (archived) … = undefined`，
      而这条断言当时只是顺手记下了那个行为。它的代价是：备份界面按项目分组时所有归档
      会话掉进「未分组」，取消归档也回不到原项目，而且不可逆（没有第二处记着这个对应
      关系，`localDir` 同时被清）。那个"归档期间不带项目记忆"的保证现在是 prompt
      路径上的显式守卫（见 `archiveKeepsProject.test.ts`）。
    */
    assert.equal(/projectId/.test(body), false, '归档不该碰项目绑定');
    assert.equal(/profile\.remote/.test(body), false, '归档不该碰运行位置');
  });

  test('记录里有远端就发 remoteHost —— 归档与否都一样（侧栏归档组里也要有徽标）', () => {
    const at = M.indexOf('...(rec.profile?.remote?.sshHost');
    const arch = M.indexOf('archived: !!rec.archived,');
    assert.ok(at > 0 && arch > 0, '两个字段都在同一份投影里');
    /* 投影里没有任何"归档就不发"的条件 */
    assert.equal(/archived \?[^\n]*remoteHost/.test(M), false);
  });

  test('恢复时的 attach 报**这条会话真正的工作目录**，不再硬写 `~`', () => {
    /* 硬写 `'~'` 不是一个选择，是"我不知道"—— 那次据此把整个家目录（含 .aws/credentials
       和 17 把私钥）推上远端就是这么来的。主进程以记录为准堵住了它，但渲染层继续
       声称家目录仍然是个随时会被谁再信一次的谎。 */
    assert.match(HK, /const attachCwdFor = \(sid: string\): string =>/);
    assert.match(HK, /sessionsRef\.current\.find\(\(s\) => s\.id === sid\)\?\.localDir \|\| '~'/);
    assert.equal(/loadSession\((sessionId|sid|s\.id), '~'/.test(HK), false, '不许再有硬写的 ~');
    /* 恢复那条路要真的 attach（否则它顶着红点坐着，镜像也没登记） */
    const at = HK.indexOf('const archiveSession = useCallback');
    const body = HK.slice(at, at + 2600);
    assert.match(body, /await window\.kiroApi\.loadSession\(sessionId, attachCwdFor\(sessionId\)/);
  });

  test('归档只改 archived/projectId，渲染层那份状态里 remoteHost 留着', () => {
    const at = HK.indexOf('const archiveSession = useCallback');
    const body = HK.slice(at, at + 400);
    assert.match(body, /\{ \.\.\.s, archived, \.\.\.\(archived \? \{ projectId: undefined \} : \{\}\) \}/);
  });
});

/*
 * 「配置里每一个配置，不管是本地还是远程必须要配置 kiro、claude、codex 的启动命令，
 *   是默认 kiro 还是某个路径下的。另两个现在还没加，但后续要加入」。
 *
 * 为什么这件事非做不可：同一台机器上完全可能有两个 kiro-cli（装的那个 + 自己 build 的），
 * 而"跑的是哪一个"决定了模型列表、agent 支持和 MCP 行为 —— 猜错的表现是"远端少了几个模型"
 * 或"agent 没生效"，那种问题查半天看不出根因。
 */
describe('每台机器（含本机）都能配三个 CLI 的启动命令', () => {
  const tmpCfg = (obj: any): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bins-'));
    const p = path.join(dir, 'config.json');
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    return p;
  };

  test('空值 = "用默认"，而不是"用空命令启动"', async () => {
    const { normalizeBins } = await import('../src/main/remoteTargets.ts');
    assert.equal(normalizeBins({ kiro: '  ', claude: '', codex: undefined }), undefined, '全空就别写这个键');
    assert.deepEqual(normalizeBins({ kiro: ' /opt/kiro-cli ' }), { kiro: '/opt/kiro-cli', claude: undefined, codex: undefined });
  });

  test('远端那份跟着机器走，读得出来也存得回去（而且不会被别的编辑抹掉）', async () => {
    const { listRemoteTargets, saveRemoteTarget } = await import('../src/main/remoteTargets.ts');
    const cfg = tmpCfg({ remotes: [{ id: 'tokyo', sshHost: 'ec2-user@1.2.3.4', bins: { kiro: '/opt/kiro-cli' } }] });
    assert.deepEqual(listRemoteTargets(cfg)[0].bins, { kiro: '/opt/kiro-cli', claude: undefined, codex: undefined });
    /* 只改 label 的那次保存**不许**把 bins 抹掉 —— 和密钥那次是同一个坑（「我为什么选了密钥不生效」） */
    saveRemoteTarget(cfg, { id: 'tokyo', sshHost: 'ec2-user@1.2.3.4', label: '东京' });
    assert.equal(listRemoteTargets(cfg)[0].bins?.kiro, '/opt/kiro-cli');
    /* 明确传空 = 清掉（回到默认） */
    saveRemoteTarget(cfg, { id: 'tokyo', sshHost: 'ec2-user@1.2.3.4', bins: { kiro: '' } });
    assert.equal(listRemoteTargets(cfg)[0].bins, undefined);
  });

  test('本机那份存在 `localBins`，只动这一个键', async () => {
    const { localBins, saveLocalBins } = await import('../src/main/remoteTargets.ts');
    const cfg = tmpCfg({ features: { remoteSessions: true }, remotes: [] });
    assert.equal(localBins(cfg), undefined);
    saveLocalBins(cfg, { kiro: '/usr/local/bin/kiro-cli', codex: 'codex-dev' });
    assert.deepEqual(localBins(cfg), { kiro: '/usr/local/bin/kiro-cli', claude: undefined, codex: 'codex-dev' });
    /* 配置里别的东西一个字都不能动 */
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).features, { remoteSessions: true });
    saveLocalBins(cfg, {});
    assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).localBins, undefined, '全空就把这个键删掉');
  });

  test('本机：配置里那个**优先于**按固定顺序猜，而且裸命令名不能被 existsSync 丢掉', async () => {
    const { kiroCliCandidates, resolveKiroCli, setLocalKiroBin } = await import('../src/main/acp-client.ts');
    setLocalKiroBin('kiro-cli-dev');
    try {
      assert.equal(kiroCliCandidates()[0], 'kiro-cli-dev', '配置里的排第一');
      /* 裸命令名（PATH 上的另一个名字）`existsSync` 必然 false —— 按文件判断会把它悄悄丢掉 */
      assert.equal(resolveKiroCli(), 'kiro-cli-dev');
    } finally {
      setLocalKiroBin(undefined);
    }
  });

  test('远端：启动命令用那台机器配的，而且**按 sshHost 现查配置**（没配就不起）', () => {
    const A = fs.readFileSync(path.join(process.cwd(), 'src/main/acp-client.ts'), 'utf8');
    /* `bin` 是必填 —— 留一个可选参数 + 兜底等于在代码里留一句"我们会猜" */
    assert.match(A, /function buildRemoteKiroCommand\(model: string, kiroAgent: string \| undefined, bin: string\)/);
    /* 现查：记录里存的是建会话那一刻的快照，后来配的东西到不了已有的会话（实测踩到） */
    assert.match(A, /export function remoteKiroBin\(remote: RemoteTarget\)/);
    assert.match(A, /const remoteBin = remoteKiroBin\(this\.remote\) \|\| '';/);
    /* 兜底那个 `|| 'kiro-cli'` 没了 —— 没配就拒绝，不猜 */
    assert.equal(/\|\| 'kiro-cli'\)\}/.test(A), false);
  });

  test('接线：投影/保存都带 bins（漏一个字段 = 自动保存把它抹掉），启动时就应用本机那份', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /bins: t\.bins,/);
    assert.match(M, /localBins: localBins\(KIROLEX_CONFIG_PATH\),/);
    assert.match(M, /ipcMain\.handle\('local:save-bins'/);
    /* 存完立刻生效，否则"改了配置没反应"会让人以为这个配置项是假的 */
    assert.match(M, /setLocalKiroBin\(saved\?\.kiro\);/);
    assert.match(M, /setLocalKiroBin\(localBins\(KIROLEX_CONFIG_PATH\)\?\.kiro\);/);
  });

  test('界面：本机和远端**共用同一组字段**，都在同一个下拉里', () => {
    const R = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
    assert.match(R, /const BinFields: React\.FC</);
    assert.match(R, /<option value=\{LOCAL\}>💻 本机（这台电脑）<\/option>/);
    /* 两处都用它 —— 各写一遍迟早分叉 */
    assert.equal((R.match(/<BinFields /g) || []).length, 2);
    /* claude/codex 现在只存不用，标签上要明说 —— 填了不生效比没有这个框更让人怀疑配置是假的 */
    assert.match(R, /claude 启动命令（暂未使用）/);
  });
});

/*
 * 「创建新远程 session 的时候仍会报模型不可用…然后不知道怎么就变成 claude 5 不可用了」
 * +「这个新会话怎么还变成了本地的了，WTF」——**两个症状，一个原因。**
 *
 * 实测那次远端 EC2 是连不上的（`nc 22` 通、ping 85ms 0 丢包，但 ssh
 * `Connection timed out during banner exchange` —— TCP 握手成功而 sshd 连 banner 都发不出来）。
 * 于是：
 *
 *   1. `createSession` 里 `newSession` 抛错，而那个 `catch` **只 clearConnecting**、把异常吞掉，
 *      promise 照样 resolve —— 界面上那条会话看着像建好了，徽标还挂着远端的名字，执行器却不存在，
 *      而屏幕上从头到尾没有一个字提示出错；
 *   2. 你接着发消息，`sendMessage` 那条兜底路**再建一次**，而它压根没传 remoteId ——
 *      于是这条你明确建成远程的会话变成了本地的；
 *   3. 本地清单里一个 Claude 都没有（出口 IP 地域过滤），所以紧接着就是「claude-opus-5 不可用」。
 *
 * 远程会话**不许悄悄变本地**：连不上就该失败，而不是换一台机器把活干了。
 */
describe('远程会话建失败不许静默变本地', () => {
  const HK = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');

  test('建失败要抛出去，并在会话里说一句', () => {
    const at = HK.indexOf('const createPromise = (async (): Promise<string> =>');
    assert.ok(at > 0);
    const body = HK.slice(at, at + 2600);
    assert.match(body, /⚠️ 这条会话没连上：/);
    assert.match(body, /throw err;/, '吞掉异常 = 上层以为建成功了');
    /* 光 clearConnecting 不算处理 */
    assert.equal(/\} catch \{\s*\n\s*clearConnecting\(id\);\s*\n\s*\} finally/.test(body), false);
  });

  test('兜底那条建会话的路要带上本来那台机器', () => {
    const at = HK.indexOf('if (!sid || sid.startsWith(\'pending_\')) {', HK.indexOf('const pendingId = sid;'));
    assert.ok(at > 0);
    const body = HK.slice(at, at + 1600);
    assert.match(body, /intendedRemoteRef\.current\.get\(pendingId\)/);
    assert.match(body, /远程会话\*\*不许悄悄变本地\*\*/);
  });

  test('记的是配置里的 id，不是给人看的 label', () => {
    /* `remoteHost` 是 label，按 label 反查一旦查不到就会传 undefined —— 那又是"变成本地" */
    assert.match(HK, /const intendedRemoteRef = useRef<Map<string, string>>\(new Map\(\)\);/);
    assert.match(HK, /if \(opts\?\.remoteId\) intendedRemoteRef\.current\.set\(id, opts\.remoteId\);/);
    /* 声明必须在使用之前（同一个组件体里，读起来不该像 TDZ） */
    assert.ok(HK.indexOf('const intendedRemoteRef') < HK.indexOf('intendedRemoteRef.current.set'));
  });
});

/*
 * 「另外如果连不上不应该是红色吗」。
 *
 * 侧栏原来只有两种：绿（连着）和灰（没连）。而 `statusFor` 里明写着"还没 attach 是正常的，
 * 不该显示成 alert" —— 那条规则本身是对的：一条没打开过的会话理应是灰的。
 *
 * 缺的是第三种：**试过、失败了**。那台 EC2 连不上的时候（`Connection timed out during banner
 * exchange`）每条远程会话都是灰的，和"还没打开"长得一模一样 —— 你只能翻日志才知道它坏了。
 */
describe('连不上要显眼', () => {
  const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');
  const HK = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');
  const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');

  test('只有**真的失败过**才算 —— 成功就摘掉', () => {
    assert.match(HK, /const markFailed = \(sid: string \| null\) =>/);
    assert.match(HK, /const clearFailed = \(sid: string \| null\) =>/);
    /* attach 成功立刻摘：否则一次抖动之后它会一直红着 */
    assert.match(HK, /addAttached\(s\.id\);\s*\n\s*clearFailed\(s\.id\);/);
    /* 建会话失败也算 */
    assert.match(HK, /markFailed\(id\);\s*\n\s*const why = String/);
  });

  test('`statusFor` 在 dormant 之前返回 alert，而且判的是"失败过"不是"没连"', () => {
    assert.match(SB, /if \(failedSessionIds\?\.includes\(id\)\) return 'alert';/);
    const alertAt = SB.indexOf("return 'alert';");
    const dormantAt = SB.lastIndexOf("return 'dormant';");
    assert.ok(alertAt > 0 && alertAt < dormantAt, 'alert 要排在 dormant 兜底之前');
    /* 原来那条规则要留着 —— 没打开过的会话仍然是灰的 */
    assert.match(SB, /pending_'\)\) return 'dormant'/);
  });

  test('颜色是红的（橙色读起来像"稍等一下"）', () => {
    const at = CSS.indexOf('.session-item .session-dot.alert {');
    const body = CSS.slice(at, at + 420);
    assert.match(body, /background: #e05252;/);
    assert.equal(/#f0883e/.test(body), false, '不许再是橙色');
  });

  test('接线：hook 导出、App 传下去', () => {
    const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
    assert.match(HK, /\n    failedSessionIds,/);
    assert.match(A, /failedSessionIds=\{failedSessionIds\}/);
    assert.match(SB, /failedSessionIds\?: string\[\];/);
  });
});
