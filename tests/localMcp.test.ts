import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  handleRpc, callTool, toolDefs, startLocalMcp, newToken,
  GIT_READONLY, MAX_READ_BYTES, MCP_PROTOCOL_VERSION,
} from '../src/main/localMcp.ts';
import {
  allocateRemotePort, buildSessionAgent, localToolsHelp, mcpUrl,
  sessionAgentName, writeAgentScript, removeAgentScript,
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
  test('**按白名单挑字段**：带走人格，丢掉那些在远端根本不成立的东西', () => {
    /* 「你把远程 kiro 的那些 agent 啥的清理一下，包括 mcp 啥的应该都不需要了」。
       以前是整份拷过去 + 并上这条 MCP。问题是拷过去的东西在远端**不成立**：
       MCP 的命令是本机路径（kiro-cli 不报错，只静默少工具）、`resources` 是本机 file:// 
       （每次启动打 File URI not found）、`includeMcpJson` 会把远端那台机器的全局 MCP 拉进来。 */
    const base = {
      name: 'aws-agent',
      prompt: '你是一个 AWS 专家',
      model: 'claude-opus-5',
      mcpServers: { drawio: { command: '/opt/homebrew/bin/node' }, playwright: { command: 'npx' } },
      resources: ['file:///Users/k/x.md'],
      hooks: { onStart: 'echo hi' },
      includeMcpJson: true,
      tools: ['fs_read', '@drawio'],
      allowedTools: ['fs_read', '@playwright'],
    };
    const out = buildSessionAgent(base, { name: 'kirolex-local-s1', url: 'http://127.0.0.1:39100/mcp/abc' });
    /* 带走的：名字、人格、钉住的模型 */
    assert.equal(out.name, 'kirolex-local-s1');
    assert.equal(out.prompt, base.prompt);
    assert.equal(out.model, 'claude-opus-5');
    /* 唯一一条 MCP 就是本地工具 */
    assert.deepEqual(Object.keys(out.mcpServers), [MCP_SERVER_NAME]);
    /* 丢掉的那些一个都不许漏过去 */
    for (const gone of ['resources', 'hooks', 'includeMcpJson', 'useLegacyMcpJson']) {
      assert.equal(gone in out, false, `${gone} 不该带过去`);
    }
    /* `tools` 白名单：内置工具留着，指向别的 MCP 的 `@xxx` 去掉（那些 MCP 已经不在了） */
    assert.deepEqual(out.tools, ['fs_read', `@${MCP_SERVER_NAME}`]);
    assert.deepEqual(out.allowedTools, ['fs_read', `@${MCP_SERVER_NAME}`]);
  });

  test('base 里没写 tools 就**显式写 `["*"]`** —— 不写等于一个工具都没有（实测）', () => {
    /* 实测：生成的 agent 不带 `tools` 时，远端那条会话回的是"我手上没有任何可调用的工具"
       （连 fs_read 都没有），而隧道其实是通的（从远端 curl 那个 URL 能拿到 tools/list）。
       kiro-cli 把"没有这个字段"当成空白名单，所以"照抄默认行为"必须显式说出来。 */
    const out = buildSessionAgent({ prompt: 'p' }, { name: 'n', url: 'u' });
    assert.deepEqual(out.tools, ['*']);
    assert.deepEqual(out.allowedTools, [`@${MCP_SERVER_NAME}`]);
  });

  test('`tools: ["*"]` 也不动它', () => {
    const out = buildSessionAgent({ tools: ['*'] }, { name: 'n', url: 'u' });
    assert.deepEqual(out.tools, ['*']);
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

  test('远端那份临时 agent 要能写、也要能删（不删远端会按会话数长满）', () => {
    assert.match(writeAgentScript('a'), /mkdir -p ~\/\.kiro\/agents && cat > ~\/\.kiro\/agents\/a\.json/);
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
    const at = M.indexOf('const remotePort = localToolsBySession.get(sessionId)?.remotePort ?? allocateRemotePort(used);');
    assert.ok(at > 0);
    const after = M.slice(at, at + 400);
    /* 下一行就得是"占住" —— 中间插任何 await 都会让并行的两条会话拿到同一个端口 */
    assert.match(after, /^const remotePort[^\n]*\n\s*localToolsBySession\.set\(sessionId, \{ remotePort,/m);
    /* 那次写远端 agent 文件的 await 必须在占住**之后** */
    const reserve = M.indexOf('localToolsBySession.set(sessionId, { remotePort,');
    const write = M.indexOf('await writeRemoteFile(remote, `mkdir -p ');
    assert.ok(reserve > 0 && write > reserve, '先占端口，再写远端文件');
  });
});
