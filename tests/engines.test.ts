import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { engineOf, resolveAdapter, ENGINE_LABEL } from '../src/main/engines.ts';
import { AcpClient } from '../src/main/acp-client.ts';

/**
 * 「看一下 kirolex 如何加 claude code 和 codex 支持……模式参考现有的 kirolex 会话模式」。
 *
 * 实测两个适配器（claude-agent-acp 0.85、codex-acp 2.1）都走通了 KiroLex 用的那条 ACP 路：
 * initialize → session/new → session/prompt，流式 agent_message_chunk + 标准 usage_update。
 * 所以加引擎 = 换一条起进程的命令 + 把 kiro 专有的那几样对另外两家关掉。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf-8');
const M = read('src', 'main', 'index.ts');

describe('引擎归属', () => {
  test('老记录没有 engine 字段 = kiro；只认三个值', () => {
    assert.equal(engineOf(undefined), 'kiro');
    assert.equal(engineOf({}), 'kiro');
    assert.equal(engineOf({ engine: 'claude' }), 'claude');
    assert.equal(engineOf({ engine: 'codex' }), 'codex');
    assert.equal(engineOf({ engine: 'gpt' }), 'kiro', '不认识的值不许变成一条起不来的会话');
    assert.equal(ENGINE_LABEL.claude, 'Claude Code');
  });
});

describe('适配器怎么起', () => {
  test('找到包的 JS 入口：用本进程的 node 跑（不经过 Windows 上会 EINVAL 的 .cmd）', () => {
    const roots = ['/g/node_modules'];
    const want = path.join('/g/node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
    const a = resolveAdapter('claude', {}, { roots, exists: (p) => p === want, execPath: '/electron', platform: 'win32' });
    assert.deepEqual(a, { command: '/electron', args: [want], env: { ELECTRON_RUN_AS_NODE: '1' } });
    const c = resolveAdapter('codex', {}, {
      roots, exists: (p) => p.endsWith(path.join('codex-acp', 'dist', 'index.js')), execPath: '/electron', platform: 'win32',
    });
    assert.match(c.args[0], /codex-acp[\\/]dist[\\/]index\.js$/);
  });

  test('环境变量覆盖优先；找不到时 Windows 上说清装哪个包，别处退回 PATH 上的名字', () => {
    assert.deepEqual(resolveAdapter('codex', { KIROLEX_CODEX_ACP: '/x/codex-acp' }, { roots: [] }), { command: '/x/codex-acp', args: [], env: {} });
    assert.throws(() => resolveAdapter('claude', {}, { roots: [], exists: () => false, platform: 'win32' }),
      /npm i -g @agentclientprotocol\/claude-agent-acp/);
    assert.equal(resolveAdapter('codex', {}, { roots: [], exists: () => false, platform: 'darwin' }).command, 'codex-acp');
  });
});

describe('kiro 专有的东西对另外两家关掉', () => {
  test('_session/steer 只给 kiro', () => {
    assert.equal(new AcpClient('m').supportsSteer, true);
    assert.equal(new AcpClient('m', undefined, undefined, 'auto-approve', undefined, undefined, 'claude').supportsSteer, false);
  });

  test('远程也能跑 ——「只要 remote 也安装 ACP 不就行了吗」：ssh 起远端的适配器，先报 PID', async () => {
    const { buildRemoteAdapterCommand } = await import('../src/main/acp-client.ts');
    const cmd = buildRemoteAdapterCommand('claude-agent-acp');
    assert.match(cmd, /^bash -lc /, '登录 shell：npm 全局 bin 的 PATH 在 profile 里');
    assert.match(cmd, /KIROLEX_REMOTE_PID \$\$/, 'remoteKillTree 靠这个 PID 收尸');
    assert.match(cmd, /exec '\\''claude-agent-acp'\\''/);
    assert.doesNotMatch(M, /会话目前只能在本机跑/);
    /* kiro 那套 preflight（查 kiro-cli / 登录 / 模型清单）对另外两家换成"适配器在不在" */
    assert.equal((M.match(/await remoteAdapterCheck\(/g) || []).length, 5, '新建 / 换机器 / 重连 / 换引擎 / 换组合 五处');
    /* 「没装」那句搬进了 remoteAdapterProbe.ts（和「装了但没有 node」那句放在一起），index.ts 抛的就是它给的话 */
    assert.match(read('src', 'main', 'remoteAdapterProbe.ts'), /will install it \(\{pkg\}\)[\s\S]{0,300}pkg: ADAPTER_PACKAGE\[engine\]/);
    assert.match(M, /const problem = adapterProblemMessage\(host, engine, verdict\);\s*if \(problem\) throw new Error\(problem\);/);
  });

  test('远程会话的本地工具通道：kiro 走 agent 文件，另外两家走 ACP 的 mcpServers', () => {
    const AC = read('src', 'main', 'acp-client.ts');
    assert.match(AC, /return this\.engine !== 'kiro' \? \(this\.localTools\?\.mcpServers \|\| \[\]\) : \[\];/);
    assert.equal((AC.match(/mcpServers: this\.mcpServers,/g) || []).length, 2, 'session/new 和 session/load 都要带');
    assert.match(M, /const mcp = \{ type: 'http', name: 'kirolex-local', url: mcpUrl\(remotePort, urlPath\), headers: \[\] \};/);
  });

  test('不走 kiro 的模型降级；换模型 / 换 kiro agent 对它们直接说明', () => {
    assert.match(M, /if \(engine !== 'kiro'\) \{\s*const client = new AcpClient\(profile\.model, shellEnv, undefined, profile\.permissionMode, profile\.remote, localTools, engine\);/);
    assert.match(M, /session is configured in its own CLI; it cannot be switched here yet/);
    assert.match(M, /A kiro agent only applies to Kiro sessions/);
  });
});

describe('引擎跟着会话走（每一处白名单都要带上它）', () => {
  test('新建写进 profile；attach 从记录里读回；水化发给界面', () => {
    assert.match(M, /\.\.\.\(engine !== 'kiro' \? \{ engine \} : \{\}\),/);
    assert.match(M, /\.\.\.\(existing\?\.profile\.engine \? \{ engine: existing\.profile\.engine \} : \{\}\),/);
    assert.match(M, /\.\.\.\(rec\.profile\?\.engine \? \{ engine: rec\.profile\.engine \} : null\),/);
    /* 每一处 new AcpClient 都把引擎传下去 —— 漏一处，那条路径（换机器/换模型回滚…）就会把会话起成 kiro */
    const sites = M.match(/new AcpClient\([^;]*?\);/gs) || [];
    assert.ok(sites.length >= 7);
    for (const s of sites) assert.match(s, /engine(Of\([^)]*\))?,?\s*\)/, `漏了 engine：${s.slice(0, 90)}`);
  });

  test('界面：新建对话能选引擎，侧栏只挂远程 tag，kiro 的 agent / 模型下拉对另外两家换成它们自己的', () => {
    const app = read('src', 'renderer', 'App.tsx');
    assert.match(app, /<option value="claude">Claude Code<\/option>/);
    assert.match(app, /engine: newChatEngine,/);
    assert.match(app, /engine=\{session\?\.engine\}/);
    const sb = read('src', 'renderer', 'components', 'Sidebar.tsx');
    /* 「左侧会话框不要显示 claude 这个 tag，你应该显示的仍然是远程 tag」 */
    assert.doesNotMatch(sb, /session-engine-\$\{/);
    assert.match(sb, /🌐/);
    const ca = read('src', 'renderer', 'components', 'ChatArea.tsx');
    assert.match(ca, /\{nonKiro \? \(/);
    assert.match(ca, /\{!nonKiro && \(/);
    /* 「左下角不应该再用那个机器人的图标了」 */
    assert.match(ca, /engine === 'claude' \? <IconClaudeSpark size=\{15\} \/> : <IconCodex size=\{15\} \/>/);
    /* 「我点到 setting 之类根本无法回到原先那个配置界面」：tab 栏在限高的 flex 列里不能被压成 0 高 */
    const css = read('src', 'renderer', 'styles', 'global.css');
    assert.match(css, /\.agent-config-editor-dialog \.kiro-config-tabs \{\s*flex: none;/);
    const hook = read('src', 'renderer', 'hooks', 'useAcp.ts');
    assert.match(hook, /engine: rec\.engine \?\? \(existing as any\)\.engine,/);
    /* 标准 usage_update（两个适配器都发）喂上下文百分比 */
    assert.match(hook, /contextPercent: \(update\.used \/ update\.size\) \* 100/);
  });
});

describe('Claude Code / Codex 的模型下拉 ——「右侧的选模型为什么没有」', () => {
  test('清单取自适配器的 configOptions（model），切换走 session/set_config_option', () => {
    const C = read('src', 'main', 'acp-client.ts');
    assert.match(C, /this\.noteConfigOptions\(r\?\.configOptions\);/);
    assert.match(C, /sendRequest\('session\/set_config_option', \{ sessionId, configId: o\.id, value \}\)/);
    const M = read('src', 'main', 'index.ts');
    /* 记在会话上（按引擎分开），每次连上（wireSession）设回去 */
    assert.match(M, /engineModels: \{ \.\.\.entry\.profile\.engineModels, \[engine\]: value \}/);
    /* 恢复的 promise 记在 entry 上（忙时记下的即时项要等它落定，见 pendingSwitch.test.ts） */
    assert.match(M, /function wireSession\(sessionId: string, entry: SessionEntry\) \{\r?\n  const \{ client \} = entry;\r?\n  entry\.engineOptionsReady = applyEngineModel\(sessionId, entry\)/);
    const ca = read('src', 'renderer', 'components', 'ChatArea.tsx');
    assert.match(ca, /\{nonKiro && \(\s*<select/);
    assert.match(ca, /api\.setEngineModel\(sid, value\)/);
  });
});

describe('远端端口：还活着的旧 ssh 占着的也要避开', () => {
  test('两条会话同时换引擎不能分到同一个 -R 端口', () => {
    const M = read('src', 'main', 'index.ts');
    assert.match(M, /\.\.\.\[\.\.\.sessionClients\.values\(\)\]\.map\(\(e\) => e\.client\.forwardedRemotePort\)/);
    assert.match(read('src', 'main', 'acp-client.ts'), /get forwardedRemotePort\(\): number \| undefined \{\s*return this\.localTools\?\.remotePort;/);
  });
});

describe('Claude Code / Codex：effort 和权限模式', () => {
  test('引擎名那一格换成 effort；顶上 Auto/Ask 换成它们自己的 mode（Claude 默认 bypass）', () => {
    const ca = read('src', 'renderer', 'components', 'ChatArea.tsx');
    assert.doesNotMatch(ca, /className="composer-engine"/, '「改成 effort 吧」');
    /* effort 下拉后来换成了「组合」下拉（组合里带 effort，见 mcpCombos.test.ts） */
    assert.match(ca, /onMcpComboChange\(event\.target\.value\)/);
    assert.match(ca, /engineMode=\{nonKiro \? \{/);
    assert.match(ca, /\{engineMode \? \(\s*<select/);
    const M = read('src', 'main', 'index.ts');
    assert.match(M, /const DEFAULT_ENGINE_MODE: Partial<Record<'claude' \| 'codex', string>> = \{ claude: 'bypassPermissions' \};/);
    assert.match(M, /if \(category !== 'thought_level' && category !== 'mode'\) throw/);
    /* attach 按白名单重建 profile —— 漏了这两个，手选的值一重连就丢 */
    assert.match(M, /\.\.\.\(existing\?\.profile\.engineModels \? \{ engineModels: existing\.profile\.engineModels \} : \{\}\),/);
    assert.match(M, /\.\.\.\(existing\?\.profile\.engineOptions \? \{ engineOptions: existing\.profile\.engineOptions \} : \{\}\),/);
    assert.match(M, /\.\.\.\(existing\?\.profile\.mcpCombo \? \{ mcpCombo: existing\.profile\.mcpCombo \} : \{\}\),/);
  });
  test('这两家问不问由它们自己的 mode 决定 —— KiroLex 这一层不再自动批准', async () => {
    const { AcpClient } = await import('../src/main/acp-client.ts');
    const c = new AcpClient('default', {}, undefined, 'auto-approve', undefined, undefined, 'claude');
    assert.equal(c.getPermissionMode(), 'ask');
    c.setPermissionMode('auto-approve');
    assert.equal(c.getPermissionMode(), 'ask');
    const k = new AcpClient('m', {}, undefined, 'auto-approve');
    assert.equal(k.getPermissionMode(), 'auto-approve', 'kiro 不变');
  });
  test('按 ACP 的 category 认（两家 effort 的 id 不一样）', async () => {
    const { AcpClient } = await import('../src/main/acp-client.ts');
    const c: any = new AcpClient('default', {}, undefined, 'auto-approve', undefined, undefined, 'codex');
    c.noteConfigOptions([
      { id: 'reasoning_effort', category: 'thought_level', currentValue: 'xhigh', options: [{ value: 'low', name: 'Low' }, { value: 'xhigh', name: 'Xhigh' }] },
      { id: 'mode', category: 'mode', currentValue: 'agent', options: [{ value: 'agent', name: 'Auto review' }] },
    ]);
    assert.deepEqual(c.selectOptions('thought_level'), { current: 'xhigh', options: [{ value: 'low', name: 'Low' }, { value: 'xhigh', name: 'Xhigh' }] });
    assert.equal(c.selectOptions('mode').current, 'agent');
    assert.equal(c.modelOptions, null);
  });
});

describe('还没修的那几样', () => {
  test('界面上没有 window.alert（它是模态的，弹着时整个渲染进程停住）', () => {
    for (const f of ['App.tsx', path.join('components', 'Sidebar.tsx')]) {
      assert.doesNotMatch(read('src', 'renderer', f), /window\.alert\(/, f);
    }
    assert.match(read('src', 'renderer', 'App.tsx'), /<Toasts \/>/);
  });
  test('没聊过的 Claude Code / Codex 会话不 resume；Resource not found 不重试', () => {
    const M = read('src', 'main', 'index.ts');
    assert.match(M, /const skipResume = engineOf\(profile\) !== 'kiro' && historyBytes === 0;/);
    assert.match(M, /if \(\/Resource not found\/i\.test\(String\(first\?\.message \|\| ''\)\)\) throw first;/);
  });
  test('侧栏引擎 tag 的样式删干净了', () => {
    assert.doesNotMatch(read('src', 'renderer', 'styles', 'global.css'), /\.session-engine/);
  });
});

describe('本机工作目录 ——「本机应该有工作目录这个功能，默认是用户目录下的 kirolex」', () => {
  test('默认 ~/kirolex，存的是写法、用的时候展开；不许相对路径', async () => {
    const { localWorkdir, localWorkdirSetting, saveLocalWorkdir, DEFAULT_LOCAL_WORKDIR } = await import('../src/main/remoteTargets.ts');
    const os = await import('node:os');
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lwd-')), 'config.json');
    fs.writeFileSync(f, '{}');
    assert.equal(DEFAULT_LOCAL_WORKDIR, '~/kirolex');
    assert.equal(localWorkdir(f, '/home/me'), path.join('/home/me', 'kirolex'));
    assert.equal(localWorkdirSetting(f), '~/kirolex');
    saveLocalWorkdir(f, '~/work');
    assert.equal(localWorkdir(f, '/home/me'), path.join('/home/me', 'work'));
    assert.throws(() => saveLocalWorkdir(f, 'relative/dir'), /绝对路径/);
    saveLocalWorkdir(f, '~/kirolex');
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).localWorkdir, undefined, '默认值不写进配置');
  });

  test('新建和重连走同一个 localCwdFor（Claude Code 按目录存会话，两次给不同目录就找不回）', () => {
    assert.match(M, /function localCwdFor\(sessionId: string, dir\?: string\): string \{/);
    assert.match(M, /if \(!profile\.remote\?\.sshHost\) resolvedCwd = localCwdFor\(kiroLexId, resolvedCwd\);/);
    assert.match(M, /if \(!profile\.remote\?\.sshHost\) resolvedCwd = localCwdFor\(sessionId, resolvedCwd\);/);
    /* 原来本地新建给的是每会话目录 sessionCwd(profile, sessionDir)，和重连不是一个地方 */
    assert.doesNotMatch(M, /: sessionCwd\(profile, sessionDir\);/);
  });

  test('设置页：本机有「工作目录」，没有「更新本机的 kiro-cli」那颗按钮', () => {
    const RS = read('src', 'renderer', 'components', 'RemoteSettings.tsx');
    assert.match(RS, /<Field label=\{t\('Working directory'\)\} hint=\{t\('Local sessions without a project work in this directory/);
    assert.match(RS, /localSaveWorkdir\?\.\(localWorkdir\)/);
    assert.doesNotMatch(RS, /KiroVersionRow/);
    assert.doesNotMatch(RS, /'更新本机的 kiro-cli'/);
  });
});

describe('远端安装脚本：装上适配器，**而且以后的登录 shell 找得到它们**', () => {
  const SH = read('scripts', 'remote-bootstrap.sh');
  test('写 ~/.kirolex-env.sh，从 bash -l 读的那个 profile 里 source（不是 .bashrc），可重跑', () => {
    assert.match(SH, /ENVF="\$HOME\/\.kirolex-env\.sh"/);
    assert.match(SH, /for f in "\$HOME\/\.bash_profile" "\$HOME\/\.bash_login" "\$HOME\/\.profile"; do/);
    assert.match(SH, /if grep -qs 'kirolex-env\.sh' "\$PF"; then/, '重跑不重复追加');
    assert.match(SH, /fnm" env --shell bash/, 'fnm 装的 node 进 PATH（适配器的 shebang 要 node）');
  });
  test('npm 全局目录不可写就装到 ~/.local；自检在新的登录 shell 里找适配器', () => {
    assert.match(SH, /if \[ ! -w "\$\(npm root -g 2>\/dev\/null\)" \]; then/);
    assert.match(SH, /for b in claude-agent-acp codex-acp; do\n\s+if bash -lc "command -v \$b"/);
    assert.doesNotMatch(SH, /claude-code-acp; do/);
  });
});

describe('已有会话换引擎 ——「我还需要现有会话也能切换 agent 运行类型」', () => {
  test('主进程：没连着只改记录；连着就先起新的再断旧的，上下文随下一条带过去', () => {
    /* 实现抽成了 reshapeForEngine + switchEngineImpl（忙时记下的切换跑完后也走它） */
    const at = M.indexOf('const reshapeForEngine = (');
    assert.ok(at > 0);
    const body = M.slice(at, M.indexOf("ipcMain.handle('app:get-home-dir'", at));
    assert.match(body, /if \(!oldEntry\) \{[\s\S]*?rec0\.profile = reshape\(rec0\.profile\);/);
    /* 这一轮还在跑：不再拒绝，记成 pending、跑完再换（pendingSwitch.ts） */
    assert.match(body, /queueSwitchWhileBusy\(sessionId, 'engine'/);
    assert.match(body, /if \(engine !== 'kiro'\) await remoteAdapterCheck\(profile\.remote, engine, sessionId\);/, '远程会话换到 Claude/Codex 先查适配器');
    assert.match(body, /const started = await connectWithModelFallback\(profile, 'switch-engine', localTools, sessionId, remoteModels\);/);
    assert.ok(body.indexOf('await client.newSession(') < body.indexOf('await retireExecutor(oldEntry.client)'), '先起新的、再断旧的');
    assert.match(body, /restoreContextAfterExecutorSwap\(sessionId, 'switch-engine'\);/);
    assert.match(body, /webContents\.send\('session:engine-changed', \{ sessionId, engine \}\)/);
    /* kiro 的模型 / agent 对另外两家没意义；切回 kiro 用偏好模型 */
    assert.match(body, /next\.model = 'default';\s*next\.kiroAgent = undefined;/);
  });

  test('界面：右键「运行引擎」三选一，换完 tag 当场变', () => {
    const SB = read('src', 'renderer', 'components', 'Sidebar.tsx');
    assert.match(SB, /<Submenu label=\{t\('🤖 Engine: \{engine\}', \{ engine: ENGINE_NAMES\[ctxSession\.engine \|\| 'kiro'\] \}\)\}>/);
    assert.match(SB, /api\.switchEngine\(sessionId, engine, \{ projectId \}\)/);
    const HK = read('src', 'renderer', 'hooks', 'useAcp.ts');
    assert.match(HK, /onEngineChanged\?\.\(/);
  });
});

describe('远端 node 用最新 LTS ——「把脚本改成运行最新的 LTS 版本 node」', () => {
  const SH = read('scripts', 'remote-bootstrap.sh');
  test('问 fnm 现在的 LTS，不是它就装上并设成默认；不写死大版本', () => {
    assert.match(SH, /LTS="\$\("\$FNM" ls-remote --lts 2>\/dev\/null \| tail -1 \| awk '\{print \$1\}'\)"/);
    assert.match(SH, /"\$FNM" install "\$LTS" >\/dev\/null 2>&1 && "\$FNM" default "\$LTS"/);
    assert.doesNotMatch(SH, /fnm install 22|装 node 22/);
  });
});

describe('还没连上过的新会话也能切引擎 / 运行位置', () => {
  test('没有记录时先建一份（带渲染层给的项目），删过的不建', () => {
    const M = read('src', 'main', 'index.ts');
    assert.ok(M.includes('const coldRecordFor = (sessionId: string, hint?: { projectId?: string | null }): store.SessionRecord | null => {'));
    assert.ok(M.includes(String.raw`if (!/^s_[\w-]+$/.test(sessionId)) return null;`));
    assert.ok(M.includes('if (deletedSessionIds.has(sessionId) || loadSessionTombstones().includes(sessionId)) return null;'));
    assert.ok(M.includes('const rec0 = oldEntry ? store.readRecord(sessionId) : coldRecordFor(sessionId, hint);'));
    assert.equal((M.match(/coldRecordFor\(sessionId, hint\)/g) || []).length, 2, '换引擎和换运行位置两条路都要');
    const S = read('src', 'renderer', 'components', 'Sidebar.tsx');
    assert.ok(S.includes('api.switchEngine(sessionId, engine, { projectId })'));
    assert.ok(S.includes('api.setRemoteTarget(sessionId, remoteId, undefined, { projectId })'));
  });
});
