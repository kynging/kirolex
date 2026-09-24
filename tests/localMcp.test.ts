import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  handleRpc, callTool, toolDefs, startLocalMcp, newToken,
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
    assert.match(M, /const byId = new Map\(localList\.map/);
    assert.match(M, /\.\.\.\(byId\.get\(id\) \|\| \{\}\), model_id: id/);
    assert.match(M, /model_name: byId\.get\(id\)\?\.model_name \|\| id/);
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
