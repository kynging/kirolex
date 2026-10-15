import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { noticeFromStderr, noticesFromStderr, noticeLabel } from '../src/main/stderrNotice.ts';
import { AcpClient, REMOTE_PID_MARKER } from '../src/main/acp-client.ts';

/**
 * 「我发现 mcp failure，kirolex 并不知道。kiro-cli 中的警告信息应该要放到里面才对」。
 *
 * stderr 一直是有的（`AcpClient` 把它当 `error` 事件发出来），但两端都把它丢了：主进程只 `logger.warn`
 * 一行，渲染层的 `onError` 只有一句 `console.error` —— 那是**开发者控制台**，界面上看不到。
 * 于是一个 MCP server 起不来（`playwright` 拉不起来、`agentcore-websearch` 认证过期），表现就是
 * "模型说它没有那个工具"，而没有任何地方说过它坏了。
 */
describe('MCP / 认证 / 工具的失败要能报出来', () => {
  test('MCP server 起不来 —— 这就是这次要修的那一类', () => {
    const n = noticeFromStderr('failed to initialize MCP server "playwright": timed out after 30s');
    assert.equal(n?.kind, 'mcp');
    assert.equal(n?.level, 'error');
    assert.match(n!.text, /playwright/);
  });

  test('大小写和写法都不挑 —— 各个 server 的报错格式不统一', () => {
    for (const line of [
      'ERROR mcp_client: server agentcore-websearch exited with code 1',
      'MCP server drawio unavailable',
      "Could not load mcp config: cannot open '~/.kiro/settings/mcp.json'",
    ]) {
      assert.equal(noticeFromStderr(line)?.kind, 'mcp', line);
    }
  });

  test('认证过期单独一类 —— 该做的事不一样（重新登录，不是重装 server）', () => {
    assert.equal(noticeFromStderr('request failed: 403 Forbidden (token expired)')?.kind, 'auth');
    assert.equal(noticeFromStderr('SSO login required — credentials unavailable')?.kind, 'auth');
  });

  test('工具问题算 warn 不算 error —— 一次工具失败通常不影响整条会话', () => {
    const n = noticeFromStderr('tool execution failed: command not found: soffice');
    assert.equal(n?.kind, 'tool');
    assert.equal(n?.level, 'warn');
  });

  test('自称 error/panic 的兜底收下', () => {
    assert.equal(noticeFromStderr('error: unexpected end of stream')?.kind, 'error');
    assert.equal(noticeFromStderr('panic: index out of range')?.kind, 'error');
    assert.equal(noticeFromStderr('✗ something broke')?.kind, 'error');
  });

  test('**噪音一律丢掉** —— 全抛上去界面会变成日志窗口，真失败又淹进去', () => {
    /* 每一条都是实测见过的：LibreOffice 转 PDF 的字体告警、下载进度、kiro-cli 自己的 INFO */
    for (const line of [
      'Fontconfig warning: no <cachedir> elements found. Check configuration.',
      '  45.3% [=====>    ]',
      'INFO chat: session ready',
      'DEBUG transport: 12 bytes',
      '   at Object.<anonymous> (/x/y.js:3:1)',
      '',
      '   ',
    ]) {
      assert.equal(noticeFromStderr(line), null, JSON.stringify(line));
    }
  });

  test('只是 warning、没说失败的不报 —— 那种大多是提示', () => {
    assert.equal(noticeFromStderr('warning: unused variable x'), null);
  });

  test('ANSI 转义清掉 —— 不清的话界面上是一串乱码', () => {
    const n = noticeFromStderr('\u001b[31mERROR mcp: server pencil failed\u001b[0m');
    assert.equal(n?.kind, 'mcp');
    assert.doesNotMatch(n!.text, /\u001b|\[31m/);
  });

  test('KiroLex 自己往 stderr 写的远端 PID 那行不是后端的问题', () => {
    /* 远端启动脚本自报 PID 用的那一行（acp-client 的 REMOTE_PID_MARKER） */
    assert.equal(noticeFromStderr(`${REMOTE_PID_MARKER} 12345`), null);
    assert.equal(noticeFromStderr(`${REMOTE_PID_MARKER} 12345 error`), null);
  });

  test('ssh 自己的提示不报 —— 没说失败的 Warning 只是提示', () => {
    assert.equal(noticeFromStderr("Warning: Permanently added 'host' (ED25519) to the list of known hosts."), null);
  });

  test('同一句只报一次 —— 重试时 kiro-cli 会打好几遍', () => {
    /* 同一句出现五遍会让人以为坏了五个东西 */
    const chunk = ['mcp server playwright failed', 'mcp server playwright failed', 'INFO noise'].join('\n');
    const out = noticesFromStderr(chunk);
    assert.equal(out.length, 1);
  });

  test('一段里多种问题都收，各自成一条', () => {
    const out = noticesFromStderr([
      'failed to initialize MCP server "pencil"',
      'request failed: 401 Unauthorized',
      'Fontconfig warning: whatever',
    ].join('\n'));
    assert.deepEqual(out.map((n) => n.kind), ['mcp', 'auth']);
  });

  test('每一类都有一句说清"这是后端的问题"的话', () => {
    /* 不点明的话看着像 KiroLex 自己坏了，而该做的事完全不同 */
    assert.match(noticeLabel('mcp'), /MCP/);
    assert.match(noticeLabel('auth'), /认证/);
    assert.match(noticeLabel('tool'), /工具/);
    assert.match(noticeLabel('error'), /后端/);
  });
});

describe('接线', () => {
  const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const PRE = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');
  const ACP = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');

  test('只对 stderr 那一路做筛选 —— 别的 error 事件照旧', () => {
    assert.match(MAIN, /if \(error\?\.type === 'stderr'\) reportStderr\(String\(error\.message \|\| ''\)\)/);
    assert.match(MAIN, /for \(const n of noticesFromStderr\(message\)\)/);
    /* acp:error 不管是不是 stderr 都照发 —— 在那个 if 外面 */
    assert.match(MAIN, /reportStderr\(String\(error\.message \|\| ''\)\);\s*mainWindow\?\.webContents\.send\('acp:error', \{ \.\.\.error, sessionId \}\)/);
  });

  test('筛出来的东西同时进日志和界面 —— 只进一处都不够', () => {
    /* 只进日志 = 现在这个样子（你看不到）；只进界面 = 事后查不了 */
    assert.match(MAIN, /logger\.warn\('backend'/);
    assert.match(MAIN, /send\('acp:notice'/);
  });

  test('preload 单独一条通道，不和原始 stderr 混在一起', () => {
    assert.match(PRE, /onNotice:/);
    assert.match(PRE, /ipcRenderer\.on\('acp:notice', handler\)/);
    assert.match(PRE, /removeListener\('acp:notice', handler\)/, '要能注销，否则热更新后重复挂');
  });

  test('渲染层把它挂到**那条会话**上，走已有的错误通道', () => {
    /* MCP 是按会话起的（不同 agent 配不同 server），而且你要能看出是哪条会话的工具坏了 */
    assert.match(ACP, /const removeNotice = window\.kiroApi\.onNotice\?\.\(/);
    assert.match(ACP, /noteError\(n\.sessionId \|\| null, t\('\{label\}: \{text\}', \{ label: n\.label, text: n\.text \}\)\)/);
    assert.match(ACP, /removeNotice\?\.\(\)/, '卸载时要注销');
  });
});

/**
 * **启动期**的 stderr —— MCP server 起不来正好发生在 connect / newSession / loadSession 期间，
 * 而 `wireSession` 是在这些都跑完之后才挂监听的。那段时间的 `error` 只落到 AcpClient 构造函数里的
 * 空监听上，不攒下来的话启动期的 MCP 初始化失败永远到不了界面。
 */
describe('接线之前的 stderr 不能丢', () => {
  const ACP_CLIENT = fs.readFileSync(path.join(process.cwd(), 'src/main/acp-client.ts'), 'utf8');
  const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  /** 按 wireSession 的做法接线：先挂监听，再取走接线前攒下的那些 */
  function wire(client: AcpClient, seen: string[]) {
    client.on('error', (e: any) => { if (e?.type === 'stderr') seen.push(e.message); });
    for (const m of client.takeEarlyStderr()) seen.push(m);
  }
  /** 模拟子进程往 stderr 写一段（和 connect() 里 stderr 'data' 处理同样的两步） */
  function stderr(client: AcpClient, msg: string) {
    (client as any).noteEarlyStderr(msg);
    client.emit('error', { type: 'stderr', message: msg });
  }

  test('接线前写的 stderr 在接线时补报，接线后的照常走监听，各一次', () => {
    const client = new AcpClient('m');
    const seen: string[] = [];
    stderr(client, 'failed to initialize MCP server "playwright": timed out');  // connect 期间
    wire(client, seen);
    stderr(client, 'mcp server pencil failed');                                  // 接线之后
    assert.deepEqual(seen, ['failed to initialize MCP server "playwright": timed out', 'mcp server pencil failed']);
  });

  test('取走一次之后不再攒 —— 同一个 client 再接一次线不会重报', () => {
    const client = new AcpClient('m');
    stderr(client, 'mcp server x failed');
    assert.deepEqual(client.takeEarlyStderr(), ['mcp server x failed']);
    stderr(client, 'mcp server y failed');
    assert.deepEqual(client.takeEarlyStderr(), []);
  });

  test('一直没人接线也不会无限长', () => {
    const client = new AcpClient('m');
    for (let i = 0; i < 200; i++) stderr(client, `line ${i}`);
    const got = client.takeEarlyStderr();
    assert.equal(got.length, 50);
    assert.equal(got[got.length - 1], 'line 199', '留的是最近的');
  });

  test('stderr 处理先攒再发；wireSession 挂好监听之后补报', () => {
    assert.match(ACP_CLIENT, /this\.noteEarlyStderr\(msg\);\s*this\.emit\('error', \{ type: 'stderr', message: msg \}\)/);
    const wireBody = MAIN.slice(MAIN.indexOf('function wireSession('));
    const onError = wireBody.indexOf("client.on('error'");
    const replay = wireBody.indexOf('client.takeEarlyStderr()');
    assert.ok(onError > 0 && replay > onError, '补报要在挂监听之后，否则中间那一段又会漏');
    assert.match(wireBody, /for \(const message of client\.takeEarlyStderr\(\)\) reportStderr\(message\)/,
      '补报只走筛选那一路（日志 + acp:notice），不重发 acp:error');
  });
});
