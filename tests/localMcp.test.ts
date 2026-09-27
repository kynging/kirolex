import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  handleRpc, callTool, toolDefs, startLocalMcp, newToken, sessionRoots,
  GIT_READONLY, MAX_READ_BYTES, MCP_PROTOCOL_VERSION,
} from '../src/main/localMcp.ts';
import {
  allocateRemotePort, localToolsHelp, mcpUrl, parseAgentBase, remoteAgentScript,
  sessionAgentName, removeAgentScript,
  MCP_SERVER_NAME, REMOTE_PORT_BASE,
} from '../src/main/remoteLocalTools.ts';

/*
 * 「要不把镜像去掉，我们尝试一下给远程配一些能调用本地 MCP 的能力？」
 *
 * 为什么这条路成立：远端的 kiro-cli 不用 ACP 的客户端 fs 能力（实测 0 回调），但它**认 HTTP 的
 * MCP server**（`kiro-cli mcp add --url`），而 ssh 本来就能开反向隧道。于是文件一份都不用复制。
 *
 * 为什么工具必须**粗**：实测到那台东京机器的 RTT 是 **184 ms**。`local_read` 一次只读一个文件的话，
 * 一轮 50 次读就是 9 秒纯延迟 —— 比镜像（一次 5–21 秒、之后全程本地速度）更慢。
 */
function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'lmcp-')); }
const deps = { log: () => {}, notice: () => {} };

describe('工具本身：在你机器上干活，一次给够', () => {
  test('local_read 收**多个**路径 —— 粗粒度是这个设计的前提，不是顺手', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'AAA');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'BBB');
    const r = await callTool('local_read', { paths: ['a.txt', 'b.txt'] }, { sessionId: 's', workdir: dir }, deps);
    const text = r.content[0].text;
    assert.match(text, /AAA/);
    assert.match(text, /BBB/);
    /* 工具描述里要**明说**一次给多个 —— 不说它就会一个一个读 */
    assert.match(toolDefs().find((t) => t.name === 'local_read')!.description, /一次可以给多个路径/);
  });

  test('读不到的文件不让整次调用失败 —— 三个里坏一个，另两个照样要拿到', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'fine');
    const r = await callTool('local_read', { paths: ['ok.txt', 'nope.txt'] }, { sessionId: 's', workdir: dir }, deps);
    assert.match(r.content[0].text, /fine/);
    assert.match(r.content[0].text, /读不到/);
    assert.notEqual(r.isError, true);
  });

  test('相对路径相对**这条会话的工作目录** —— 不是 KiroLex 进程的 cwd', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'x.md'), 'hi');
    const r = await callTool('local_read', { paths: ['x.md'] }, { sessionId: 's', workdir: dir }, deps);
    assert.match(r.content[0].text, /hi/);
    /* 那个绝对路径要出现在输出里：它读的是哪一份，必须看得出来 */
    assert.match(r.content[0].text, new RegExp(path.join(dir, 'x.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('local_write 真的写，而且**在会话里说出来**（远端改你机器上的文件不能静悄悄）', async () => {
    const dir = tmp();
    const said: string[] = [];
    const r = await callTool('local_write', { path: 'sub/new.txt', content: 'written' },
      { sessionId: 's1', workdir: dir }, { log: () => {}, notice: (_s, t) => said.push(t) });
    assert.equal(fs.readFileSync(path.join(dir, 'sub/new.txt'), 'utf8'), 'written');
    assert.notEqual(r.isError, true);
    assert.equal(said.length, 1, '必须留痕');
    assert.match(said[0], /改了你本机的/);
  });

  test('local_bash 在工作目录里跑，并且**每一条命令都留痕**', async () => {
    const dir = tmp();
    const said: string[] = [];
    const r = await callTool('local_bash', { command: 'pwd && echo marker' },
      { sessionId: 's1', workdir: dir }, { log: () => {}, notice: (_s, t) => said.push(t) });
    assert.match(r.content[0].text, /marker/);
    assert.match(r.content[0].text, /exit 0/);
    assert.equal(said.length, 1);
    assert.match(said[0], /在你本机跑了/);
    /*
      **不做安全剧场**：工具面里有 bash（这是明确选的），所以给读写加路径牢笼是自欺 ——
      能跑 bash 就能 cat 任何东西。真正起作用的是 loopback + token + 每次留痕。
    */
  });

  test('local_git 只跑只读子命令；写操作要走 local_bash（那条路留痕）', async () => {
    const dir = tmp();
    const bad = await callTool('local_git', { args: ['push', '--force'] }, { sessionId: 's', workdir: dir }, deps);
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /只跑只读子命令/);
    assert.ok(GIT_READONLY.includes('status') && GIT_READONLY.includes('diff'));
    assert.equal(GIT_READONLY.includes('push'), false);
  });

  test('local_grep 在本地跑完只回结果（一次往返，不是一个文件一次）', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'one.txt'), 'needle here');
    fs.writeFileSync(path.join(dir, 'two.txt'), 'nothing');
    const r = await callTool('local_grep', { query: 'needle' }, { sessionId: 's', workdir: dir }, deps);
    assert.match(r.content[0].text, /one\.txt/);
    assert.equal(/two\.txt/.test(r.content[0].text), false);
  });

  test('local_glob 找得到文件', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'x.ts'), '');
    const r = await callTool('local_glob', { pattern: '*.ts' }, { sessionId: 's', workdir: dir }, deps);
    assert.match(r.content[0].text, /x\.ts/);
  });

  test('读大文件要截断并**说明截断了** —— 静悄悄给半份文件会让它基于残缺内容改代码', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(MAX_READ_BYTES + 100));
    const r = await callTool('local_read', { paths: ['big.txt'] }, { sessionId: 's', workdir: dir }, deps);
    assert.match(r.content[0].text, /只有前 \d+ 字节/);
    /* 那句说明必须在**开头** —— 放结尾会被总输出的截断切掉，而"没说明的半个文件"最危险 */
    assert.ok(r.content[0].text.indexOf('只有前') < 300);
  });

  test('没有这个工具就明说（不要返回一个看起来成功的空结果）', async () => {
    const r = await callTool('local_nope', {}, { sessionId: 's', workdir: tmp() }, deps);
    assert.equal(r.isError, true);
  });
});

describe('协议：initialize / tools 一套走通，通知绝不回包', () => {
  const session = { sessionId: 's', workdir: '/tmp' };

  test('initialize 回协议版本和 tools 能力', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, session, deps);
    assert.equal(r.result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.ok(r.result.capabilities.tools);
  });

  test('tools/list 把六个工具都报出来', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session, deps);
    const names = r.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, ['local_bash', 'local_git', 'local_glob', 'local_grep', 'local_read', 'local_write']);
  });

  test('**通知没有 id，一个字节都不能回** —— 回了会被当成协议错误', async () => {
    assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, session, deps), null);
    assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/cancelled' }, session, deps), null);
  });

  test('不认的方法：有 id 才回错误，没 id 当通知丢掉', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 9, method: 'whatever' }, session, deps);
    assert.equal(r.error.code, -32601);
    assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'whatever' }, session, deps), null);
  });
});

describe('HTTP 那一层：只听 loopback，认 token，不泄露形状', () => {
  test('token 对了才通；错了 404，而且**不解释为什么**', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'AAA');
    const server = await startLocalMcp(deps);
    try {
      const token = server.register({ sessionId: 's1', workdir: dir });
      const url = `http://127.0.0.1:${server.port()}/mcp/${token}`;
      const good = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'local_read', arguments: { paths: ['a.txt'] } } }),
      });
      assert.equal(good.status, 200);
      const body: any = await good.json();
      assert.match(body.result.content[0].text, /AAA/);

      const bad = await fetch(`http://127.0.0.1:${server.port()}/mcp/${newToken()}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(bad.status, 404);
      assert.equal((await bad.text()).trim(), '', '错误消息里不该有任何提示');

      /* 会话作废之后那把钥匙立刻不好用 */
      server.forget('s1');
      const after = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(after.status, 404);
    } finally {
      server.stop();
    }
  });

  test('一条会话重新登记 = 换一把新钥匙（旧的作废）', async () => {
    const server = await startLocalMcp(deps);
    try {
      const t1 = server.register({ sessionId: 's', workdir: '/tmp' });
      const t2 = server.register({ sessionId: 's', workdir: '/tmp' });
      assert.notEqual(t1, t2);
      assert.equal(server.urlPathFor('s'), `/mcp/${t2}`);
    } finally {
      server.stop();
    }
  });

  test('通知走 HTTP 时回 202（没有 body）—— MCP 客户端会因为一个空 200 body 报解析错误', async () => {
    const server = await startLocalMcp(deps);
    try {
      const token = server.register({ sessionId: 's', workdir: '/tmp' });
      const res = await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assert.equal(res.status, 202);
    } finally {
      server.stop();
    }
  });
});

describe('接线层：agent 配置一条会话一份，端口不撞', () => {
  test('**agent 在远端按名字解析**：有同名用远端那份，没有就退默认', () => {
    /* 「切换远程的时候，对面不会有同样的 agent 配置，这时候如果有同名的 agent 就用同名的，
       没有就切回默认的」。所以合并动作在**远端**做（底子文件在那儿）：
       拿远端那份 `<agent>.json` 当底子、只并上一条 `kirolex-local`。
       上一版是把**本机**那份内联过去 —— 方向错了：本机那份里的 MCP 命令和 `resources` 路径
       在远端根本不成立（`/opt/homebrew/bin/node` 不存在 → 静默少工具）。 */
    const sc = remoteAgentScript('kirolex-local-s1', 'aws-agent', 'http://127.0.0.1:39100/mcp/tok');
    /* 参数走环境变量，不拼进命令行 —— agent 名和 URL 都会进 shell */
    assert.match(sc, /KX_OUT='kirolex-local-s1'/);
    assert.match(sc, /KX_BASE='aws-agent'/);
    assert.match(sc, /KX_URL='http:\/\/127\.0\.0\.1:39100\/mcp\/tok'/);
    /* 程序里一个单引号都不能有（它整段待在 '…' 里面） */
    const prog = sc.slice(sc.indexOf("python3 -c '") + 12, sc.length - 1);
    assert.equal(prog.includes("'"), false, 'python 程序里不许出现单引号');
    /* 远端那份自己的 MCP 要留着（它们的命令在那台机器上是真的），只并上我们这一条 */
    assert.match(prog, /cfg\["mcpServers"\] = dict\(src\.get\("mcpServers"\) or \{\}\)/);
    assert.match(prog, /cfg\["mcpServers"\]\[name\] = \{"type": "http", "url": url\}/);
    /* 读不到就当默认，并把用了哪个底子报出来 */
    assert.match(prog, /print\("KX_AGENT " \+ \(found or "default"\)\)/);
    assert.equal(parseAgentBase('KX_AGENT aws-agent'), 'aws-agent');
    assert.equal(parseAgentBase('KX_AGENT default'), 'default');
    assert.equal(parseAgentBase('什么都没有'), '');
  });

  test('那段合并程序**真的能跑**（用临时 HOME 跑一遍，拼错一个引号就会在这里露出来）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthome-'));
    fs.mkdirSync(path.join(home, '.kiro', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.kiro', 'agents', 'aws-agent.json'), JSON.stringify({
      name: 'aws-agent', prompt: '你是 AWS 专家',
      mcpServers: { local_only: { command: '/usr/bin/true' } },
      tools: ['fs_read'], allowedTools: ['fs_read'],
    }));
    const run = (base: string): any => {
      const sc = remoteAgentScript('kirolex-local-s1', base, 'http://127.0.0.1:39100/mcp/tok');
      const out = execFileSync('bash', ['-lc', sc], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
      return {
        base: parseAgentBase(out),
        json: JSON.parse(fs.readFileSync(path.join(home, '.kiro', 'agents', 'kirolex-local-s1.json'), 'utf8')),
      };
    };
    /* ① 远端有同名的 → 用它做底子 */
    const hit = run('aws-agent');
    assert.equal(hit.base, 'aws-agent');
    assert.equal(hit.json.prompt, '你是 AWS 专家');
    assert.deepEqual(Object.keys(hit.json.mcpServers).sort(), ['local_only', MCP_SERVER_NAME].sort());
    assert.deepEqual(hit.json.tools, ['fs_read', `@${MCP_SERVER_NAME}`]);
    assert.deepEqual(hit.json.allowedTools, ['fs_read', `@${MCP_SERVER_NAME}`]);
    /* ② 远端没有 → 默认 agent + 只有本地工具，而且 tools 必须显式 `["*"]`
          （缺这个字段等于一个工具都不给 —— 实测过） */
    const miss = run('nope-agent');
    assert.equal(miss.base, 'default');
    assert.deepEqual(Object.keys(miss.json.mcpServers), [MCP_SERVER_NAME]);
    assert.deepEqual(miss.json.tools, ['*']);
    assert.equal('prompt' in miss.json, false);
  });

  test('端口按会话分，不撞已经分出去的', () => {
    assert.equal(allocateRemotePort([]), REMOTE_PORT_BASE);
    assert.equal(allocateRemotePort([REMOTE_PORT_BASE, REMOTE_PORT_BASE + 1]), REMOTE_PORT_BASE + 2);
  });

  test('agent 名字和 URL 的形状', () => {
    assert.match(sessionAgentName('s_179_abc'), /^kirolex-local-/);
    assert.equal(/[^\w.-]/.test(sessionAgentName('s/1 2')), false, '文件名里不能有奇怪字符');
    assert.equal(mcpUrl(39100, '/mcp/tok'), 'http://127.0.0.1:39100/mcp/tok');
  });

  test('远端那份临时 agent 要能删（不删远端会按会话数长满）', () => {
    assert.match(removeAgentScript('a'), /rm -f ~\/\.kiro\/agents\/a\.json/);
  });

  test('注入里要说清"文件在用户机器上"+ 一次读多个（184ms 的往返代价）', () => {
    const h = localToolsHelp('/Users/k/code/blog');
    assert.match(h, /用户的文件在他自己那台机器上/);
    assert.match(h, /\/Users\/k\/code\/blog/);
    assert.match(h, /200 毫秒/);
    assert.match(h, /一次把要读的文件都给上/);
  });
});

describe('接线：隧道、会话专用 agent、以及远端进程的收尾', () => {
  const A = fs.readFileSync(path.join(process.cwd(), 'src/main/acp-client.ts'), 'utf8');
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('反向隧道 + **端口占用就别起** —— 静默降级最糟', () => {
    assert.match(A, /args\.push\('-o', 'ExitOnForwardFailure=yes'\);/);
    assert.match(A, /args\.push\('-R', `127\.0\.0\.1:\$\{forward\.remotePort\}:127\.0\.0\.1:\$\{forward\.localPort\}`\);/);
  });

  test('远端用**那条会话专用**的 agent 启动（URL 里带 token，所以配置必须一条会话一份）', () => {
    assert.match(A, /this\.localTools\?\.agentOverride \|\| this\.kiroAgent/);
  });

  test('每次换执行器都重新备一次（token 和端口跟着这次启动）', () => {
    const n = (M.match(/await ensureLocalTools\(/g) || []).length;
    assert.ok(n >= 5, `只有 ${n} 处备了本地工具`);
    /* 执行器没了就作废 token + 删远端那份 agent */
    assert.match(M, /releaseLocalTools\(sessionId, entry\.profile\.remote\);/);
  });

  test('**远端那个 kiro-cli 要自己报 PID，断开时杀掉** —— 85 个孤儿就是漏了这一步', () => {
    /* 实测：那台 EC2 上 85 个 kiro-cli，最老的 2 天 23 小时，每个都占着一条会话的锁；
       下一次 attach/换模型就报「Session is active in another process (PID …)」，
       然后一连串 Session not connected —— 看起来就是"这条会话串了/坏了"。 */
    assert.match(A, /echo "\$\{REMOTE_PID_MARKER\} \$\$" >&2; exec/);
    assert.match(A, /if \(pid\) this\.remotePid = pid;/);
    assert.match(A, /kill -TERM \$\{pid\} 2>\/dev\/null \|\| true/);
  });

  test('镜像那一整套**已经从代码里删掉了**，远端 cwd 只是草稿目录', async () => {
    /* 上一版是把 `registerRemoteSync` 留成空壳（一处改动让 25 处调用点自动休眠），
       等这条路在真实任务上跑通之后才真删。现在删了：三个模块、它们的测试、
       渲染层那套同步徽标/状态、以及 `remote:status` / `remote:sync` 两条 IPC。 */
    for (const gone of ['registerRemoteSync', 'remoteSync.', 'mirrorRefusal', 'stageFiles(', 'RemoteMirror']) {
      assert.equal(M.includes(gone), false, `main 里还留着 ${gone}`);
    }
    for (const f of ['remoteMirror.ts', 'remoteSync.ts', 'localFileBridge.ts']) {
      assert.equal(fs.existsSync(path.join(process.cwd(), 'src/main', f)), false, `${f} 还在`);
    }
    const { sessionCwd } = await import('../src/main/config.ts');
    const cwd = sessionCwd(
      { model: 'm', remote: { enabled: true, sshHost: 'h', remoteWorkdir: '/home/x/kirolex-mirror' } } as any,
      '/Users/k/code/blog',
    );
    assert.match(cwd, /\/home\/x\/kirolex-mirror\/scratch\//);
  });
});

/*
 * 实测（重启之后两条远程会话并行 attach）：两边都拿到了远端端口 **39100**。
 * 而 `ExitOnForwardFailure=yes` 的意思是第二条 ssh 直接起不来 —— 一条会话就这么打不开，
 * 日志上却只是"本地工具已备好"两次，看不出哪里错了。
 */
describe('端口分配不能有竞态', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('算完端口**立刻**占住（写 map），再去做需要 await 的事', () => {
    /* 锚在 `writeRemoteFile(remote, \`mkdir -p ` 上：那一步现在顺手把远端草稿目录也建了
       （镜像去掉之后没人再创建它，而 cwd 指向不存在的目录会让那一轮的 shell 落在 /tmp） */
    const at = M.indexOf('const remotePort = allocateRemotePort(used);');
    assert.ok(at > 0);
    const after = M.slice(at, at + 400);
    /* 下一行就得是"占住" —— 中间插任何 await 都会让并行的两条会话拿到同一个端口 */
    assert.match(after, /^const remotePort[^\n]*\n\s*localToolsBySession\.set\(sessionId, \{ remotePort,/m);
    /* 而且**不复用自己原来那个**：换 agent / 换模型是先起新执行器再关旧的，复用就会撞上
       还没退出的旧 ssh（`ExitOnForwardFailure=yes` → ssh exit 255，看起来像"掉线"）。 */
    assert.match(M, /const remotePort = allocateRemotePort\(used\);/);
    assert.equal(/localToolsBySession\.get\(sessionId\)\?\.remotePort \?\?/.test(M), false);
    /* 那次写远端 agent 文件的 await 必须在占住**之后** */
    const reserve = M.indexOf('localToolsBySession.set(sessionId, { remotePort,');
    const write = M.indexOf('await writeRemoteFile(remote, `mkdir -p ');
    assert.ok(reserve > 0 && write > reserve, '先占端口，再写远端文件');
  });
});

/*
 * 「确认下右侧界面远程会话显示的是远程的 agent 和模型」。
 *
 * agent 那半边是对的（远端那份由 `remoteAgentScript` 按名字解析），模型那半边原来在骗人：
 * 只有一份列表、跑的是**本机** kiro-cli，而两台机器版本不同（实测本机 2.23.1、东京 1.27.0），
 * 于是下拉里会有远端没有的模型。启动那一刻 `pickRemoteModel` 会替换并在会话里说一句，
 * 所以不会静默跑错 —— 但下拉该说真话。
 */
describe('模型列表按机器分', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
  const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');

  test('IPC 收 machine：本机照旧，远端去问那台机器', () => {
    assert.match(M, /ipcMain\.handle\('acp:list-models', async \(_event, machine\?: string\) => \{/);
    assert.match(M, /if \(machine && machine !== 'local'\) \{/);
    /* 用的是同一个探测：故意传一个不存在的模型，kiro-cli 在参数校验就把可用列表打出来
       —— 不真调模型、不花额度 */
    assert.match(M, /chat --model \$\{MODEL_PROBE\}/);
    assert.match(M, /const ids = parseModels\(out\);/);
    /* 启动命令也得是那台机器配的（不猜） */
    assert.match(M, /const bin = remoteKiroBin\(target\);/);
    assert.match(P, /listModels: \(machine\?: string\)/);
  });

  test('问不到就**报错**，不要假装成"只有 auto"', () => {
    /* 那份退化结果曾经被写进缓存，于是"网恢复了却还是显示模型都不可用" */
    assert.match(M, /没有报出模型列表/);
    assert.match(M, /问不到 \$\{target\.sshHost\} 的模型列表/);
  });

  test('名字/窗口/乘数从本机那份**补上**（集合归机器，属性归模型）', () => {
    /* 实测：东京那台 kiro-cli 1.27.0 连 `--list-models` 都不认
       （`error: unexpected argument '--list-models'`），所以远端唯一拿得到的就是一串 id。
       而"claude-opus-5 的倍率是 2.2"是**模型自己的属性**、不随机器变 —— 机器决定的只是
       "有哪些模型"。所以按 id 从本机那份补；本机不认识的 id 留裸的（少点信息好过编一个）。 */
    /* **后来又多了一层**（「为什么又看不到模型乘数了」）：本机出口被地域过滤之后清单里一个
       Claude 都没有，于是"从本机那份补"补不到东西。现在是三层、实时的永远赢：
       实时清单 → 持久缓存 → 内置快照（`modelMeta.ts`）。补不到仍然留裸的 —— 不编数字。 */
    assert.match(M, /return \{ models: enrichModels\(ids, live, cache\) \};/);
    assert.match(M, /readMetaCache\(MODEL_META_PATH\)/);
  });

  test('渲染层：每一格按它自己那条会话所在的机器取列表，缓存 key 带机器', () => {
    assert.match(A, /models=\{modelsFor\(session\)\}/);
    assert.match(A, /const key = `kirolex-models\$\{machine === 'local' \? '' : `:\$\{machine\}`\}`;/);
    /* 远端那台问一次就够；问不到退回本机那份 —— 空下拉比"可能多几个"更糟 */
    assert.match(A, /if \(!askedModels\.current\.has\(machine\)\)/);
    assert.match(A, /return modelsByMachine\[machine\] \|\| models;/);
  });
});

/*
 * 「那操作本地的 playwright 和 compute use 呢」→「都做」。
 *
 * 远程会话的 agent 里如果有 `playwright`，它跑的是**远端**那台机器的浏览器（没有显示器，
 * 你也看不见它点了什么）。而这些 MCP 是 stdio 的，所以 KiroLex 在本机把它们起起来，
 * 在同一条隧道上多开一个路径 `/mcp/<token>/<名字>` 原样转发 JSON-RPC。
 */
describe('把本机的 MCP 转发给远端会话', () => {
  test('挑谁转发：命令是本机路径的（远端必然起不来），以及按名字就该在本机跑的', async () => {
    const { forwardableFrom, isLocalPathCommand, FORWARD_BY_NAME } = await import('../src/main/forwardMcp.ts');
    const picked = forwardableFrom({
      mcpServers: {
        /* 本机绝对路径 —— 远端没有这个文件，kiro-cli 不报错、只静默少工具（实测那句
           「agent aws-agent 缺 MCP 命令：/opt/homebrew/bin/node」） */
        drawio: { command: '/opt/homebrew/bin/node', args: ['x.js'] },
        /* 名字白名单：`npx` 远端也有，但它拉起的是**远端**的浏览器 —— 语义问题，命令行里看不出来 */
        playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
        /* 远端自己也能连同一个地址，没有转发的理由 */
        remote_http: { type: 'http', url: 'https://example.com/mcp' },
        /* 你自己关掉的 */
        off: { command: '/usr/local/bin/x', disabled: true },
        /* 远端自己装了的通用命令：留给远端跑 */
        builder: { command: 'builder-mcp' },
      },
    });
    assert.deepEqual(picked.map((p) => p.name).sort(), ['drawio', 'playwright']);
    assert.deepEqual(picked.find((p) => p.name === 'playwright')!.args, ['@playwright/mcp@latest']);
    assert.equal(isLocalPathCommand('~/x'), true);
    assert.equal(isLocalPathCommand('npx'), false);
    assert.ok(FORWARD_BY_NAME.includes('playwright'));
  });

  test('读不到那份 agent 定义就**不转发**（不猜）', async () => {
    const { forwardableFrom, localAgentJson } = await import('../src/main/forwardMcp.ts');
    assert.equal(localAgentJson('这个-agent-不存在'), null);
    assert.deepEqual(forwardableFrom(null), []);
    assert.deepEqual(forwardableFrom({}), []);
  });

  test('**原样转发**：JSON-RPC 进出都不解释语义，id 配对，通知不等回复', async () => {
    /* 用一个假的 stdio MCP（echo 一个 tools/list）验证整条路：HTTP → 子进程 stdin → stdout → HTTP */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakemcp-'));
    const fake = path.join(dir, 'fake.js');
    fs.writeFileSync(fake, [
      'let buf = "";',
      'process.stdin.on("data", (d) => {',
      '  buf += d;',
      '  let i;',
      '  while ((i = buf.indexOf("\\n")) >= 0) {',
      '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
      '    if (!line.trim()) continue;',
      '    const m = JSON.parse(line);',
      '    if (m.id === undefined) { continue; }',
      '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { echoed: m.method } }) + "\\n");',
      '  }',
      '});',
    ].join('\n'));
    const server = await startLocalMcp(deps);
    try {
      const token = server.register({ sessionId: 's1', workdir: dir });
      server.setProxies('s1', [{ name: 'fake', command: process.execPath, args: [fake] }]);
      const url = `http://127.0.0.1:${server.port()}/mcp/${token}/fake`;
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
      });
      assert.equal(res.status, 200);
      const body: any = await res.json();
      assert.equal(body.id, 7, 'id 必须配对回来');
      assert.deepEqual(body.result, { echoed: 'tools/list' }, '它的答复原样送回，不做任何解释');

      /* 通知：不等回复，回 202 */
      const note = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assert.equal(note.status, 202);

      /* 没登记过的名字 → 404（不许泄露"有哪些名字"） */
      const nope = await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}/nope`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(nope.status, 404);

      /* 会话作废 → 那个子进程也该停（浏览器不能继续开着） */
      server.forget('s1');
      const after = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }),
      });
      assert.equal(after.status, 404);
    } finally {
      server.stop();
    }
  });

  test('远端那份 agent 里要有这些转发项，`tools` 白名单也要带上它们', () => {
    const sc = remoteAgentScript('kirolex-local-s1', 'aws-agent', 'http://127.0.0.1:39100/mcp/tok',
      [{ name: 'playwright', url: 'http://127.0.0.1:39100/mcp/tok/playwright' }]);
    assert.match(sc, /KX_FWD='\{"playwright":"http:\/\/127\.0\.0\.1:39100\/mcp\/tok\/playwright"\}'/);
    const prog = sc.slice(sc.indexOf("python3 -c '") + 12, sc.length - 1);
    assert.match(prog, /for fname, furl in json\.loads\(os\.environ\.get\("KX_FWD", "\{\}"\)\)\.items\(\)/);
    /* 白名单里没有 `@playwright` 就是"工具在但调不动"，而且失败是静默的 */
    assert.match(prog, /tags = \[tag\] \+ \["@" \+ k for k in json\.loads/);
  });

  test('那段合并程序真跑一遍：转发项进了 mcpServers 和两个白名单', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fwdhome-'));
    fs.mkdirSync(path.join(home, '.kiro', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.kiro', 'agents', 'a.json'), JSON.stringify({
      tools: ['fs_read'], allowedTools: ['fs_read'],
    }));
    const sc = remoteAgentScript('out', 'a', 'http://127.0.0.1:1/mcp/t',
      [{ name: 'playwright', url: 'http://127.0.0.1:1/mcp/t/playwright' }]);
    execFileSync('bash', ['-lc', sc], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    const j = JSON.parse(fs.readFileSync(path.join(home, '.kiro', 'agents', 'out.json'), 'utf8'));
    assert.deepEqual(Object.keys(j.mcpServers).sort(), [MCP_SERVER_NAME, 'playwright'].sort());
    assert.deepEqual(j.tools, ['fs_read', `@${MCP_SERVER_NAME}`, '@playwright']);
    assert.deepEqual(j.allowedTools, ['fs_read', `@${MCP_SERVER_NAME}`, '@playwright']);
  });

  test('接线：按会话登记代理，并在注入里说清"这些作用在用户机器上"', async () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /localMcpServer\.setProxies\(sessionId, forwardable\);/);
    assert.match(M, /const forwardable = profile\.kiroAgent \? forwardableFrom\(localAgentJson\(profile\.kiroAgent\)\) : \[\];/);
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({ hostLabel: 'h', remoteDir: '/r', localDir: '/l', forwarded: ['playwright'] });
    assert.match(b, /作用在用户那台机器上/);
    assert.match(b, /playwright/);
    /* 没有转发时不要凭空多一句 */
    assert.equal(/作用在用户那台机器上/.test(remoteContextBlock({ hostLabel: 'h', remoteDir: '/r', localDir: '/l' })), false);
  });
});

/*
 * 「会话目录那个功能不对，应该可以设置多个，页面下面的文件夹直接显示哪几个文件夹被选中就行了」。
 *
 * 一个目录的时候这件事看不出来，多目录之后漏搜是**静默**的：`local_grep` 只搜第一棵树，
 * 回一句"没有匹配"，而模型会把它读成"这个东西不存在"然后往下推。所以默认范围必须是全部。
 */
describe('会话可以选多个目录', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
  const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');

  test('不填就等于只有主目录（老会话不受影响）', () => {
    assert.deepEqual(sessionRoots({ sessionId: 's', workdir: '/a' }), ['/a']);
    assert.deepEqual(sessionRoots({ sessionId: 's', workdir: '/a', dirs: [] }), ['/a']);
    /* 空串会被 `find` 当成当前目录 —— 不报错，所以只能在这里挡掉 */
    assert.deepEqual(sessionRoots({ sessionId: 's', workdir: '/a', dirs: ['/a', ' '] }), ['/a']);
  });

  test('`local_grep` / `local_glob` 不指定目录时搜**全部**（一次调用，不是每个目录一次）', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-multidir-'));
    const one = path.join(base, 'one');
    const two = path.join(base, 'two');
    fs.mkdirSync(one); fs.mkdirSync(two);
    fs.writeFileSync(path.join(one, 'a.txt'), 'needle here\n');
    fs.writeFileSync(path.join(two, 'b.txt'), 'needle there\n');
    const deps = { log: () => {}, notice: () => {} };
    const session = { sessionId: 's', workdir: one, dirs: [one, two] };

    const grep = await callTool('local_grep', { query: 'needle' }, session, deps);
    const gtext = grep.content[0].text;
    assert.match(gtext, /a\.txt/);
    assert.match(gtext, /b\.txt/, '第二棵树也要搜到 —— 漏掉它是静默的');

    const glob = await callTool('local_glob', { pattern: '*.txt' }, session, deps);
    const btext = glob.content[0].text;
    assert.match(btext, /a\.txt/);
    assert.match(btext, /b\.txt/);

    /* 指定了 `dir` 就只搜那一个 —— 模型要缩小范围时得说得通 */
    const only = await callTool('local_grep', { query: 'needle', dir: two }, session, deps);
    assert.equal(/a\.txt/.test(only.content[0].text), false);
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('注入里把那几个目录列出来，并说清默认搜全部', () => {
    const help = localToolsHelp(['/Users/me/proj', '/Users/me/other']);
    assert.match(help, /\/Users\/me\/proj/);
    assert.match(help, /\/Users\/me\/other/, '不列出来它只会在第一个里找');
    assert.match(help, /这几棵树一起/);
    /* 单个目录时不要凭空多一句"另外 0 个目录" */
    assert.equal(/另外/.test(localToolsHelp('/Users/me/proj')), false);
  });

  test('附加目录从**记录**里现查，不靠 6 个调用点各传一遍', () => {
    /* 漏传一个的表现是"那条会话突然只搜第一个目录了" —— 不报错，只是搜不全 */
    assert.match(M, /const extra = store\.readRecord\(sessionId\)\?\.localDirs \|\| \[\];/);
    assert.match(M, /localMcpServer\.register\(\{ sessionId, workdir: localDir, dirs \}\)/);
    /* 注入那一份也要是全的 */
    assert.match(M, /localDirs: localDirsOf\(sessionId, entry\),/);
  });

  test('`undefined` = 不改清单，`[]` = 只留主目录（换机器不该顺手清空）', () => {
    assert.match(M, /Array\.isArray\(dir\) \? list\.slice\(1\) : undefined,/);
    assert.match(M, /extraDirs \?\? rec0\?\.localDirs \?\? oldEntry\?\.localDirs \?\? \[\]/);
    /* 主目录不重复出现在清单里（`localDirsOf` 会把它排第一） */
    assert.match(M, /\.filter\(\(d, i, a\) => d && d !== nextLocalDir && a\.indexOf\(d\) === i\)/);
  });

  test('输入框下面一格一个目录：点第一格换主目录、✕ 去掉附加的、＋ 再加一个', () => {
    assert.match(CA, /dirList\.map\(\(d, i\) =>/);
    assert.match(CA, /onClick=\{\(\) => \(i === 0 \? onPickWorkdir\?\.\(\) : undefined\)\}/);
    assert.match(CA, /i > 0 && onRemoveWorkdir/, '主目录没有 ✕ —— 去掉 cwd 是"换"不是"删"');
    assert.match(CA, /composer-workdir-add/);
    /* 老调用点没传 `workdirs` 时退回单个目录，不至于一格都不显示 */
    assert.match(CA, /workdirs && workdirs\.length \? workdirs : \(workdir \? \[workdir\] : \[\]\)/);
  });

  test('渲染层：加是整份清单一起发，删只摘掉那一个', () => {
    assert.match(A, /const addWorkdir = async/);
    assert.match(A, /Array\.from\(new Set\(list\)\)/, '选到已经在里面的目录不该重复一条');
    assert.match(A, /const removeWorkdir = async/);
    assert.match(A, /if \(!cur\?\.localDir \|\| dir === cur\.localDir\) return;/, '主目录删不掉');
    assert.match(A, /workdirs=\{session\?\.localDir \? \[session\.localDir, \.\.\.\(session\.localDirs \|\| \[\]\)\] : \[\]\}/);
  });
});

/*
 * 「我让 agent 测本地 playwright 它找不到」——**工具都在，它没看**。
 *
 * 实测那条远程会话（`kirolex-local-s_mc_1_…`）：远端 curl 那个 URL，`kirolex-local` 和
 * `playwright` 两个 endpoint 都回了正常的 `initialize`（`serverInfo: Playwright 1.64.0`）；
 * 用同一份 agent、同一个模型单独跑一次 ACP，工具清单里 `browser_*`（20 个）和
 * `local_read/write/grep` 全都在。而 app 里那条会话连着三轮回答"我拿不到这些工具"，
 * **一次调用都没试**。
 *
 * 原因在随消息带过去的那几万字符里：历史和 memory 全是**镜像时代**的记录 ——
 * "我在 /home/ec2-user/kirolex-mirror"、"你的 /Users/... 路径都不存在"、
 * "5 个调用有 4 个被路径校验拦掉"。它信了历史，没看工具清单。
 *
 * 这类错最贵的地方是它**看起来像故障**：用户以为转发断了，于是去查隧道、查 MCP、重启 ——
 * 而那一层全是好的。所以注入必须显式地把旧结论作废。
 */
describe('别拿历史里的结论判断自己有没有工具', () => {
  test('注入里明说：看这一轮的工具清单，镜像时代那些话不成立', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({ hostLabel: 'tokyo', remoteDir: '/r', localDir: '/l' });
    assert.match(b, /看你这一轮的工具清单/);
    assert.match(b, /不要根据对话历史推断/);
    /* 把历史里那几句原话点出来 —— 泛泛说"历史可能过时"它认不出来指的是哪几句 */
    assert.match(b, /镜像目录/);
    assert.match(b, /路径校验/);
    assert.match(b, /现在不成立/);
    /* 并且给出比"回一句我没有这个工具"更便宜的做法 */
    assert.match(b, /直接调一次就知道了/);
  });

  test('这句话在**转发说明之后**（先说有什么，再说别信历史）', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({ hostLabel: 'tokyo', remoteDir: '/r', localDir: '/l' });
    assert.ok(b.indexOf('local_read') < b.indexOf('看你这一轮的工具清单'));
  });
});

/*
 * 「在远程会话中记得默认是在远程做，除非文件在本地或提示词中用户让在本地操作」。
 *
 * 上一版把天平压到了反面（"构建、跑测试、git 提交这些事用 `local_bash`"）。那是从"文件在用户
 * 机器上"直接推出来的，但推过头了：装依赖、下载、解压、跑网络请求、起长任务，这些**没有理由**
 * 回到用户的笔记本上跑 —— 那台远端机器就是为此存在的，而每一次 `local_bash` 都要过一遍
 * 184ms 的隧道。
 *
 * 所以判据是**文件在哪**，不是"哪台机器更亲"：要动的文件在他那边就用 `local_*`，别的默认在远端做。
 */
describe('远程会话默认在远端干活', () => {
  test('明说默认在这台机器上做，并点出那几类事', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({ hostLabel: 'tokyo', remoteDir: '/r/scratch', localDir: '/l' });
    assert.match(b, /\*\*默认在这台机器上做\*\*/);
    assert.match(b, /装依赖/);
    assert.match(b, /别把这些搬回用户的笔记本/);
    /* 工作区就是它的 cwd —— 以前这句话把 cwd 说成"草稿目录、项目不在这里"，
       读起来像"这台机器没什么用" */
    assert.match(b, /\/r\/scratch` 就是你的工作区/);
  });

  test('三个例外写清楚：文件在他那边 / 在他的工程上构建 / 他明说在本地', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({ hostLabel: 'tokyo', remoteDir: '/r', localDir: '/l' });
    assert.match(b, /什么时候回到用户机器/);
    assert.match(b, /① 要读或改的文件在他那边/);
    assert.match(b, /② 要在\*\*他的仓库\/工程\*\*上跑构建、测试、git/);
    assert.match(b, /③ 他明说了"在本地\/在我机器上"做/);
  });

  test('不再说"构建测试一律用 local_bash" —— 那句话和默认相反', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({ hostLabel: 'tokyo', remoteDir: '/r', localDir: '/l' });
    assert.equal(/构建、跑测试、git 提交这些事用 `local_bash`/.test(b), false);
    assert.equal(/这台机器上装依赖没有意义/.test(b), false);
    /* 取而代之：限定在"他的工程"上，并且明确无关的事在远端做 */
    assert.match(b, /与他的工程无关的事（装个工具、拉个数据、跑个脚本）就在这台机器上做/);
  });

  test('工具清单那段也不再说"跑构建和测试都用这些工具"', () => {
    const help = localToolsHelp('/Users/me/proj');
    assert.equal(/跑构建和测试都用这些工具/.test(help), false);
    assert.match(help, /默认仍然在你这台机器上干活/);
  });
});

/*
 * 「清理远程 agent 你清了没有」——**硬杀的时候没人清**。
 *
 * 正常断开会删掉自己那一份（`removeAgentScript`），`before-quit` 也补一遍。但 KiroLex 被 SIGKILL /
 * `pkill` / 崩溃 / 拔电结束时两条都不走，`kirolex-local-<会话>.json` 就全留在远端 ——
 * 而每一份里带着**那一次**的隧道端口和 token，端口每次启动都换，所以留下的是一份指向死端口的配置。
 *
 * 这次实测就是这么来的：我自己用 `pkill` 重启了好几轮 app。
 */
describe('远端会话 agent 的孤儿清理', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('按"多久没动过"扫，不按"谁还活着"', async () => {
    const { sweepAgentsScript, STALE_AGENT_MINUTES, ownedAgentPrefix } = await import('../src/main/remoteLocalTools.ts');
    /* owner 是必填 ——「确保 kirolex 只管理自己创建的 session」：默认值会静默用错身份 */
    const sh = sweepAgentsScript('ca7bbd');
    assert.ok(sh.includes(ownedAgentPrefix('ca7bbd')), '只扫自己那台留下的');
    assert.match(sh, /find ~\/\.kiro\/agents -maxdepth 1 -name 'kirolex-local-ca7bbd-\*\.json'/);
    assert.ok(sh.includes(`-mmin +${STALE_AGENT_MINUTES}`), sh);
    assert.match(sh, /-print -delete/);
    /*
      为什么不用"活着的名单"：启动早期那份名单是**空的**（执行器还没起来）——
      按空名单删等于把所有配置都删掉；而"现在没有远程会话就跳过"又会让孤儿永远留着。
    */
    assert.equal(/-not -name/.test(sh), false);
  });

  test('只碰自己生成的那些文件', async () => {
    const { sweepAgentsScript, ownedAgentPrefix } = await import('../src/main/remoteLocalTools.ts');
    const sh = sweepAgentsScript('ca7bbd');
    /* 按**自己那台**的前缀过滤：一台远端可以同时被好几台笔记本用，
       而这一轮是按"12 小时没动过"删的 —— 用共用前缀会删掉别人家还活着的那条会话的配置 */
    assert.ok(sh.includes(`${ownedAgentPrefix('ca7bbd')}*.json`));
    /* `maxdepth 1` —— 别递归进那个 `agents-retired-*` 备份目录 */
    assert.match(sh, /-maxdepth 1/);
  });

  test('阈值留了余量：另一个 KiroLex 正开着时不许误删它的', async () => {
    const { STALE_AGENT_MINUTES } = await import('../src/main/remoteLocalTools.ts');
    /* 活着的那些每次起执行器都会被重写，所以永远是新的；12 小时对孤儿足够、对活的绝对安全 */
    assert.ok(STALE_AGENT_MINUTES >= 60, '太短会误删正在被另一个实例用的');
  });

  test('窗口出来之后扫，而且不 await（别让启动等一个 ssh 往返）', () => {
    const at = M.indexOf("ipcMain.handle('acp:reveal'");
    assert.ok(at > 0);
    assert.match(M.slice(at, at + 700), /void sweepRemoteSessionAgents\(\);/);
  });

  test('扫失败只记日志 —— 这是清垃圾，不该拦住任何会话', () => {
    const at = M.indexOf('async function sweepRemoteSessionAgents');
    const body = M.slice(at, M.indexOf('\n}', M.indexOf('catch (err: any)', at)));
    assert.match(body, /只是清垃圾，不影响会话/);
    assert.equal(/throw/.test(body), false);
    /* 每台机器都扫一遍 */
    assert.match(body, /for \(const target of listRemoteTargets\(KIROLEX_CONFIG_PATH\)\)/);
  });
});

/*
 * 「为什么会打爆远程机器，这个 bug 应该修一下」。
 *
 * ## 它是怎么打爆的（全是实测数字）
 *
 * 那台 t3.medium 从 2026-09-25 17:26 UTC 起 CPU 钉在 96%+ 再没下来，`NetworkOut` 恒为 **0**，
 * `VolumeReadOps` **46,240/小时**而写只有 1.17 —— 只读不写的死循环。最后 sshd 都排不到 CPU：
 * ssh 停在 `Connection timed out during banner exchange`（TCP 握手成功、用户态永远没机会回 banner），
 * SSM Agent 同样饿死（`ConnectionLost`），只能从 EC2 API 强制 stop/start 才救回来。
 * `CpuCredits: unlimited`，所以连限流都不会兜一下 —— 它能一直烧，还一直计费加价。
 *
 * ## 源头：孤儿累积
 *
 * 远端的 `kiro-cli acp` **不跟着 ssh 退出**（无 PTY、也不在 stdin EOF 时退）。正常断开时
 * `disconnect()` 会 `kill -TERM <远端 PID>`，`before-quit` 再补一遍 —— 但 KiroLex 被 SIGKILL /
 * 崩溃 / 拔电结束时两条都不跑。之前在那台机器上一次清出 **85 个**，最老的 2 天 23 小时；
 * 每条会话是 2 个进程（`kiro-cli` + `kiro-cli-chat`），也就是 40 多条会话的残留同时在扫盘。
 *
 * ## 判据：PPID == 1（不是 etime 猜）
 *
 * 真机实测：活着的执行器挂在它那条 sshd 底下（PPID = 11933 / 12181 / …，12 个进程全不是 1），
 * ssh 一死就被 reparent 到 PID 1。所以"PPID 是 1 且命令行带我们的 agent 前缀"是精确特征 ——
 * 不可能误杀一个正在服务的执行器。
 */
describe('远端孤儿执行器进程（打爆机器的那个）', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('判据是 PPID==1 + 我们自己的 agent 前缀', async () => {
    const { orphanSweepScript, ownedAgentPrefix } = await import('../src/main/remoteLocalTools.ts');
    const sh = orphanSweepScript('ca7bbd');
    assert.match(sh, /\$1==1/, 'PPID 必须是 1 —— 活着的挂在 sshd 底下');
    /* 只碰**自己**那台留下的：一台远端可以同时被好几台笔记本用，别人家的进程不是我们该管的 */
    assert.ok(sh.includes(ownedAgentPrefix('ca7bbd')), '只碰自己生成的那些');
    assert.match(sh, /kill -TERM/, 'TERM 不是 KILL —— 给它机会自己收尾');
    /* 不按 etime 猜：一个刚起 3 秒的执行器和一个 3 天的孤儿，差别在父进程而不在年龄 */
    assert.equal(/etime|-mmin/.test(sh), false);
  });

  test('数出来多少个 —— "清了几个"必须能看见', async () => {
    const { parseOrphanSweep } = await import('../src/main/remoteLocalTools.ts');
    assert.equal(parseOrphanSweep('KIROLEX_ORPHANS 7'), 7);
    assert.equal(parseOrphanSweep('KIROLEX_ORPHANS 0'), 0);
    /* 认不出来当 0 —— 清垃圾的统计不值得抛错 */
    assert.equal(parseOrphanSweep('乱七八糟'), 0);
    assert.equal(parseOrphanSweep(''), 0);
  });

  test('开机跟着 agent 那一遍一起扫，而且杀到人时要 warn（不是 info）', () => {
    const at = M.indexOf('async function sweepRemoteSessionAgents');
    const body = M.slice(at, M.indexOf('\n}', M.indexOf('catch (err: any)', at)));
    assert.match(body, /parseOrphanSweep\(await runRemoteCapture\(target, orphanSweepScript\(OWNER\)\)\)/);
    assert.match(body, /logger\.warn\('localmcp', `\$\{target\.sshHost\}: 杀掉 \$\{orphans\} 个孤儿执行器进程/);
    /* 失败照旧只记日志 —— 这仍然是清垃圾，不该拦住任何会话 */
    assert.equal(/throw/.test(body), false);
  });
});

/*
 * **整条"打爆远程机器"链条的源头在本机** ——「为什么会打爆远程机器」的最后一块。
 *
 * 实测：KiroLex 被 `pkill` / 崩溃结束后，macOS 把它的 ssh 子进程**收养给 launchd**（不发 SIGHUP）——
 * 本机查到 7 个 `ssh … kirolex-local-…` 的 PPID 都是 1，而当前 Electron 是另一个 pid。
 * 那些 ssh 还连着，所以远端的 sshd 和 `kiro-cli acp` 也都还活着 ——
 * 于是**远端那边按 PPID==1 一个孤儿都查不到**（它们的父进程好好地在），进程却在不停累积。
 * 之前一次在那台机器上清出 85 个，就是这么攒起来的。
 *
 * 所以两端都要扫，而且**先扫本机**：远端那些失去 sshd 之后才会被 reparent 到 1，
 * 远端那一轮才认得出来。
 */
describe('本机遗留的 ssh 客户端（远端累积的源头）', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('判据：PPID==1 + 是 ssh + 命令行带我们的 agent 前缀', () => {
    const at = M.indexOf('function sweepStrayLocalSsh');
    const body = M.slice(at, M.indexOf('\n}', M.indexOf('杀掉 ${victims.length}', at)));
    assert.match(body, /if \(Number\(m\[2\]\) !== 1\) continue;/, '挂在当前 app 底下的是活的');
    assert.ok(body.includes(')ssh\\s/.test(m[3])'), '只杀 ssh 客户端');
    assert.match(body, /line\.includes\(OWNED_AGENT_PREFIX\)/, '只碰自己那台留下的 ssh');
    assert.match(body, /process\.kill\(pid, 'SIGTERM'\)/);
  });

  test('**先本机、后远端** —— 顺序反了远端那一轮什么都查不到', () => {
    const at = M.indexOf('async function sweepRemoteSessionAgents');
    const body = M.slice(at, at + 900);
    assert.match(body, /sweepStrayLocalSsh\(\);/);
    assert.ok(body.indexOf('sweepStrayLocalSsh()') < body.indexOf('orphanSweepScript'),
      '本机那一步要排在远端之前');
  });

  test('清掉要 warn，而且失败不抛（仍然是清垃圾）', () => {
    const at = M.indexOf('function sweepStrayLocalSsh');
    const body = M.slice(at, M.indexOf('\n}\n', at));
    assert.match(body, /logger\.warn\('remote'/);
    assert.match(body, /它们被 launchd 收养之后还连着远端/);
    assert.equal(/throw/.test(body), false);
  });
});

/*
 * 「另外你需要确保 kirolex 只管理自己创建的 session」。
 *
 * 一台远端机器可以同时被**好几台**笔记本上的 KiroLex 用（这正是远程会话的用法之一）。
 * 而清理的判据原来只看 `kirolex-local-` —— 那是**所有** KiroLex 共用的前缀，不是"我的"：
 *
 *   · agent 文件那一轮按"12 小时没动过"删 → 会删掉另一台笔记本上**还活着**的那条会话的配置，
 *     而那条会话的 MCP 通道就地断掉，对面完全不知道发生了什么；
 *   · 孤儿进程那一轮会去杀别人家的进程 —— 即便那确实是垃圾，也不是我们该管的。
 *
 * 所以名字里带一个稳定的 owner（主机名 + 用户名的短 hash）：稳定才能收掉**自己上一次**留下的东西，
 * 带了它就不会碰别人的。
 */
describe('只管自己创建的会话', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('owner 是稳定的、不同机器不同', async () => {
    const { ownerTag } = await import('../src/main/remoteLocalTools.ts');
    assert.equal(ownerTag('mac-a', 'keyinan'), ownerTag('mac-a', 'keyinan'), '同一台要稳定');
    assert.notEqual(ownerTag('mac-a', 'keyinan'), ownerTag('mac-b', 'keyinan'));
    assert.notEqual(ownerTag('mac-a', 'keyinan'), ownerTag('mac-a', 'bob'));
    assert.match(ownerTag('mac-a', 'keyinan'), /^[0-9a-f]{6}$/);
  });

  test('agent 名字带 owner，清理按它过滤', async () => {
    const { sessionAgentName, ownedAgentPrefix, orphanSweepScript, sweepAgentsScript } =
      await import('../src/main/remoteLocalTools.ts');
    const mine = ownedAgentPrefix('aaaaaa');
    assert.ok(sessionAgentName('s_1', 'aaaaaa').startsWith(mine));
    /* 两个清理脚本都只认自己那台 */
    assert.ok(orphanSweepScript('aaaaaa').includes(mine));
    assert.ok(sweepAgentsScript('aaaaaa').includes(mine));
    /* 别人的前缀不该出现 */
    assert.equal(orphanSweepScript('aaaaaa').includes(ownedAgentPrefix('bbbbbb')), false);
  });

  test('owner 是**必填**参数 —— 默认值会静默用错身份', () => {
    const RL = fs.readFileSync(path.join(process.cwd(), 'src/main/remoteLocalTools.ts'), 'utf8');
    assert.match(RL, /export function orphanSweepScript\(owner: string\)/);
    assert.match(RL, /export function sweepAgentsScript\(owner: string, minutes = STALE_AGENT_MINUTES\)/);
    assert.match(RL, /export function sessionAgentName\(sessionId: string, owner: string\)/);
  });

  test('这个模块仍然没有任何 import（它只拼字符串）', () => {
    const RL = fs.readFileSync(path.join(process.cwd(), 'src/main/remoteLocalTools.ts'), 'utf8');
    /* 所以 owner 的 hash 是自带的 FNV-1a，宿主信息由调用方传进来 */
    assert.equal(/^import /m.test(RL), false);
    assert.match(RL, /FNV-1a/);
  });

  test('主进程算一次、全程用它；本机那轮 ssh 也按它过滤', () => {
    assert.match(M, /const OWNER = ownerTag\(os\.hostname\(\), os\.userInfo\(\)\.username\);/);
    assert.match(M, /const OWNED_AGENT_PREFIX = ownedAgentPrefix\(OWNER\);/);
    assert.match(M, /line\.includes\(OWNED_AGENT_PREFIX\)/);
    assert.match(M, /sessionAgentName\(sessionId, OWNER\)/);
  });

  test('**显示**那一侧仍然用共用前缀 —— 别人家的 agent 对你同样不可选', () => {
    /* "只管自己的"管的是删和杀，不是显示：那些 URL 里带着别人那条会话的 token */
    const at = M.indexOf("ipcMain.handle('kiro:list-agents'");
    const body = M.slice(at, at + 2600);
    assert.match(body, /startsWith\(SESSION_AGENT_PREFIX\)/);
    assert.match(body, /管的是\*\*删和杀\*\*，不是显示/);
  });
});
