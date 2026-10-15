import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  kiroCliLogPath, stripAnsi, readTailErrors, explainCliError,
  logsToTrim, trimHugeCliLogs, CLI_LOG_MAX_BYTES,
} from '../src/main/kiroCliLog.ts';
import { LocalHost } from '../src/main/hostOps.ts';

/** 日志在 `<TMPDIR>/kiro-log/kiro-chat.log`；`HostOps` 负责"读哪台机器"。 */
function logFixture(lines: string[]): { host: LocalHost; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klog-'));
  fs.mkdirSync(path.join(dir, 'kiro-log'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'kiro-log', 'kiro-chat.log'), lines.join('\n'));
  return { host: new LocalHost({ TMPDIR: dir } as any), dir };
}

/*
 * 「还是不知道为什么会断」。
 *
 * ACP 上回来的永远是 kiro-cli 的万能包装 `Internal error — Kiro failed to generate a response`，
 * 而同一时刻它自己的日志里写着具体是哪一层坏了。实测 11 个 KiroLex 日志、29 次发送失败：
 * 15 次 EmptyResponse、11 次 dispatch failure、1 次模型退役、1 次历史里图片超限、1 次进程退出 ——
 * 五件事在界面上长得一模一样。
 */
const REAL = '\x1b[2m2026-09-18T07:52:41.683695Z\x1b[0m \x1b[31mERROR\x1b[0m \x1b[2magent::agent\x1b[0m\x1b[2m:\x1b[0m \x1b[2m2937:\x1b[0m response stream encountered an error \x1b[3merr\x1b[0m\x1b[2m=\x1b[0mEmptyResponse loop_id=AgentLoopId { agent_id: 1 }';

describe('捞 kiro-cli 自己的日志', () => {
  test('路径跟着那台机器的 TMPDIR —— kiro-cli 就写在那儿', () => {
    assert.equal(kiroCliLogPath('/tmp/x'), path.join('/tmp/x', 'kiro-log', 'kiro-chat.log'));
    /* 远程会话里这个 tmpdir 是**远端**问回来的，所以它必须是参数，不能再读 process.env */
    assert.equal(kiroCliLogPath('/tmp'), path.join('/tmp', 'kiro-log', 'kiro-chat.log'));
  });

  test('ANSI 必须脱掉，否则一行都匹配不上（实测日志是带色的）', () => {
    assert.match(stripAnsi(REAL), /^2026-09-18T07:52:41\.683695Z ERROR agent::agent: 2937: response stream/);
  });

  test('只取时间窗内的 ERROR/WARN，行号被吃掉', async () => {
    const now = Date.parse('2026-09-18T07:52:45.000Z');
    const { host } = logFixture([
      '2026-09-18T01:00:00.000Z ERROR agent::agent: 1: 很久以前的错，不该出现',
      REAL,
      '2026-09-18T07:52:42.000000Z INFO agent::agent: 2: info 不要',
    ]);
    const rows = await readTailErrors(host, 30_000, now);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, 'agent::agent');
    assert.match(rows[0].message, /^response stream encountered an error err=EmptyResponse/);
  });

  test('文件不存在时返回空 —— 诊断永远不能让发送失败', async () => {
    assert.deepEqual(await readTailErrors(new LocalHost({ TMPDIR: '/nope' } as any), 30_000), []);
  });
});

describe('把原话翻译成"哪一层的问题 + 该干什么"', () => {
  const line = (message: string, target = 'agent::agent') => ([{ ts: 1, level: 'ERROR', target, message }]);

  test('EmptyResponse：说清是服务端没产出，不是这条会话的内容有问题', () => {
    const s = explainCliError(line('response stream encountered an error err=EmptyResponse loop_id=x'));
    assert.match(s, /EmptyResponse/);
    assert.match(s, /一个 token 都没发/);
    /* 实测校准：换会话对这种故障没用 —— 3.82% 上下文的新会话照样失败 */
    assert.match(s, /跟这条对话的历史都没关系/);
    assert.match(s, /按时间段聚堆/);
  });

  test('连接层错误指向网络，而不是会话', () => {
    assert.match(explainCliError(line('An unknown error occurred: dispatch failure')), /看网络\/VPN/);
  });

  test('限流、请求不合法各有各的话', () => {
    assert.match(explainCliError(line('ThrottlingException: Too many requests')), /限流/);
    assert.match(explainCliError(line('ValidationException: image exceed max allowed size')), /不合法/);
  });

  test('LSP / MCP 启动噪音不算原因 —— 它们每次都在，认了就永远指错', () => {
    assert.equal(explainCliError([
      { ts: 1, level: 'ERROR', target: 'code_agent_sdk::sdk::workspace_manager', message: "Failed to start LSP server 'jdtls'" },
      { ts: 2, level: 'ERROR', target: 'chat_cli::cli::chat::tool_manager', message: 'Error fetching prompts from server x: TransportClosed' },
    ]), '');
  });

  test('不认识的形状原样带出来 —— 露一行陌生英文也强过再说一句 Internal error', () => {
    assert.match(explainCliError(line('some brand new failure mode')), /some brand new failure mode/);
  });
});

describe('接线（src/main/index.ts）', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('发送失败时把 kiro-cli 那句真话贴到用户看得见的地方', () => {
    assert.match(M, /cliErrorContext\(/);
  });
});

/*
 * 「当前有 34 个 kiro-cli 相关进程…这些进程仍持有已经删除的 kiro-chat.log、lsp.log，共占 21.72GB。
 *  文件路径虽然消失，但进程退出前空间不会释放。」
 *
 * 实测一个执行器进程手里就攥着 `kiro-chat.log` 7.86 GB + `lsp.log` 5.60 GB。kiro-cli 不轮转它们，
 * KiroLex 只轮转自己那份 —— 于是这两个文件只会一直长。而上一次清理是把文件**删了**：路径消失、
 * inode 还活着（十几个进程持着写 fd），空间一点没回来，直到进程退出。
 */
describe('kiro-cli 的日志超限就就地截断', () => {
  test('只挑超限的 —— 阈值给得宽（这些日志偶尔是唯一能解释故障的东西）', () => {
    const files = [
      { name: 'kiro-chat.log', bytes: 8 * 2 ** 30 },
      { name: 'lsp.log', bytes: 5 * 2 ** 30 },
      { name: 'mcp.log', bytes: 300 * 1024 },
    ];
    assert.deepEqual(logsToTrim(files), ['kiro-chat.log', 'lsp.log']);
    assert.deepEqual(logsToTrim(files, 10 * 2 ** 30), []);
    assert.equal(CLI_LOG_MAX_BYTES, 200 * 1024 * 1024);
  });

  test('**截断，不是删除** —— 删掉的话持着 fd 的进程会把空间攥到退出为止（这就是那 21.72GB）', () => {
    /* 真正动手的那一层搬到了 hostOps（远端也要能截），判据本身没变 */
    const host = fs.readFileSync(path.join(process.cwd(), 'src/main/hostOps.ts'), 'utf8');
    assert.match(host, /fs\.truncateSync\(file, 0\);/, '本地：truncate');
    assert.match(host, /truncate -s 0/, '远端：同样是截断');
    const log = fs.readFileSync(path.join(process.cwd(), 'src/main/kiroCliLog.ts'), 'utf8');
    for (const [name, src] of [['hostOps.ts', host], ['kiroCliLog.ts', log]] as const) {
      assert.equal(/unlinkSync|rmSync|\brm -/.test(src), false, `${name} 里一个删除都不许有`);
    }
    assert.match(host, /空间攥到退出为止|空间一直攥着/);
  });

  test('真的会把大文件截掉，并报出回收了多少', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klog2-'));
    fs.mkdirSync(path.join(dir, 'kiro-log'), { recursive: true });
    const big = path.join(dir, 'kiro-log', 'lsp.log');
    fs.writeFileSync(big, Buffer.alloc(3000));
    fs.writeFileSync(path.join(dir, 'kiro-log', 'mcp.log'), 'x');
    const res = await trimHugeCliLogs(new LocalHost({ TMPDIR: dir } as any), 1000);
    assert.deepEqual(res.trimmed.map((f) => f.name), ['lsp.log']);
    assert.equal(res.freed, 3000);
    assert.equal(fs.statSync(big).size, 0);
    assert.equal(fs.statSync(path.join(dir, 'kiro-log', 'mcp.log')).size, 1, '没超限的不动');
  });

  test('启动时跑一次，在起执行器之前（那时没人持着新 fd）', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /const trim = await trimHugeCliLogs\(host\);/);
    /* 等它做完再往下 —— 不等的话"没人持着新 fd"这个前提就没了 */
    assert.match(M, /await trimCliLogsNow\('启动'\);/);
    assert.match(M, /kiro-cli 日志超限已就地截断（\$\{why\}），回收/);
    assert.ok(
      M.indexOf("trimCliLogsNow('启动');") < M.indexOf("startupMark('attach: first loadSession'"),
      '在第一次 attach 之前',
    );
  });
});

/*
 * 「一次启动检查兜不住」+「配置中未发现人为启用特殊日志级别」。
 */
describe('定时再扫一次；trace 开着必须看得见', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');
  const HK = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useFeatureFlags.ts'), 'utf8');

  test('每半小时再截一次 —— 只在启动时看一眼等于把上限交给"你多久重启一次"', () => {
    assert.match(M, /setInterval\(\(\) => \{ void trimCliLogsNow\('定时'\); \}, 30 \* 60 \* 1000\)\.unref\?\.\(\);/);
    assert.match(M, /trimCliLogsNow\('启动'\);/);
  });

  test('trace 状态跟着 features 一起给渲染进程 —— 它不在 kiro 的配置里，查 kiro 一定查不到', () => {
    assert.match(M, /kiroTrace: kiroTraceEnabled\(\),/);
    assert.match(M, /ipcMain\.handle\('app:set-kiro-trace'/);
    assert.match(HK, /export function kiroTraceOn\(\): boolean/);
    assert.match(HK, /export async function setKiroTrace/);
  });

  test('侧栏常驻一个红旗，点一下就关（不是藏在设置里）', () => {
    assert.match(SB, /\{traceOn && \(/);
    assert.match(SB, /sidebar-trace-on/);
    assert.match(SB, /void setKiroTrace\(false\)/);
    const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');
    assert.match(CSS, /\.sidebar-settings-btn\.sidebar-trace-on \{[^}]*color: var\(--error\)/);
  });
});

/*
 * 「⚠️ 这条会话现在跑在 gpt-5.6-sol 上 …… 这他妈什么玩意，为什么按照会话发出去了」。
 *
 * 那句话是 KiroLex 对**你**说的，却以 `role: 'user'` 落进 transcript —— 而 ride-along 快照、
 * history.md、逐段重建全都是从 transcript 建的，于是模型下一轮真的读到"我现在跑在 gpt-5.6-sol 上"
 * 并当成你的指令。
 */
describe('KiroLex 自己说的话不许发给模型', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const ST = fs.readFileSync(path.join(process.cwd(), 'src/main/sessionStore.ts'), 'utf8');

  test('落盘时标 `kirolex: true`，界面那一份也带上', () => {
    assert.match(ST, /kirolex\?: true;/);
    assert.match(M, /store\.appendMessage\(sid, \{ id: messageId, role: 'user', content: text, ts: Date\.now\(\), kirolex: true, \.\.\.\(v \? \{ variants: v \} : \{\}\) \}\);/);
    assert.match(M, /sessionId: sid, messageId, content: text, ts: Date\.now\(\), kirolex: true,/);
  });

  /*
   * 「这个还没修啊」—— 第一次只接在三条路上（ride-along、history.md、逐段重建），而实测今天的
   * 日志里它又出去了：
   *   [suggestions] … Based on the conversation below … User: ⚠️ 这条会话现在跑在 gpt-5.6-sol 上…
   * 漏的是**追问建议**和**会话记忆压缩**。上一版的测试恰恰把"三条"钉成了正确答案 ——
   * 所以这里改成：判据本身有行为测试，每一条喂模型的路各自被点名。
   */
  test('判据是共享的一处（`kirolexNote`），主进程和渲染进程 import 同一个函数', () => {
    assert.match(M, /from '\.\/kirolexNote\.ts'/);
    const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
    assert.match(CA, /import \{ isKirolexNote \} from '\.\.\/\.\.\/main\/kirolexNote\.ts'/);
    /* 判据不许再留一份在 index.ts 里 —— 两份"同一个判断"就是这次漏掉的原因 */
    assert.equal(/const LEGACY_NOTE_OPENINGS = \[/.test(M), false);
  });

  test('**每一条喂给模型的路都被点名**，不是数个数', () => {
    /* ① ride-along 快照 ② history.md ③ 逐段重建 —— 都是 historyLine 那一侧 */
    assert.ok((M.match(/\.filter\(modelFacing\)/g) || []).length >= 4, '至少四处：三条历史 + 会话记忆');
    /* ④ 会话记忆压缩：这一条最要紧 —— 压进去之后每一轮都注入，临时通知变成永久上下文 */
    const mem = M.indexOf('async function maybeConsolidateSessionMemory');
    const memBody = M.slice(mem, M.indexOf('memoryConsolidating.delete', mem));
    assert.match(memBody, /\.filter\(modelFacing\)/, '记忆压缩没过滤 = 通知被写进 memory');
    /* ⑤ 追问建议：主进程在真正发出去的那一处再挡一次，不依赖渲染进程 */
    const sug = M.indexOf("ipcMain.handle('app:generate-suggestions'");
    assert.match(M.slice(sug, sug + 900), /stripKirolexNotes\(String\(recentConvo \|\| ''\)\)/);
  });
});

describe('这条判据本身的行为（src/main/kirolexNote.ts）', () => {
  test('标记过的、和标记之前那些固定开头的，都算 KiroLex 自己的话', async () => {
    const { isKirolexNote, KIROLEX_NOTE_OPENINGS } = await import('../src/main/kirolexNote.ts');
    assert.equal(isKirolexNote({ content: '随便一句', kirolex: true }), true);
    for (const head of KIROLEX_NOTE_OPENINGS) {
      assert.equal(isKirolexNote({ content: `${head}……` }), true, head);
    }
    assert.ok(KIROLEX_NOTE_OPENINGS.includes('⚠️ 这条会话现在跑在'), '日志里泄漏的就是这一句');
  });

  test('**你自己写的 ⚠️ 不能被吃掉** —— 判据要窄', async () => {
    const { isKirolexNote, modelFacing } = await import('../src/main/kirolexNote.ts');
    assert.equal(isKirolexNote({ content: '⚠️ 这个接口别动' }), false);
    assert.equal(modelFacing({ role: 'user', content: '⚠️ 这个接口别动' }), true);
  });

  test('助手的 💭 思考行照旧不发（搬过来的时候语义不许变）', async () => {
    const { modelFacing } = await import('../src/main/kirolexNote.ts');
    assert.equal(modelFacing({ role: 'assistant', content: '💭 想一下' }), false);
    assert.equal(modelFacing({ role: 'assistant', content: '正常回复' }), true);
    assert.equal(modelFacing({ role: 'user', content: '⚠️ 这条会话现在跑在 gpt 上' }), false);
  });

  test('拼好的对话文本里整段删掉 —— 用的是日志里那一段真实内容', async () => {
    const { stripKirolexNotes } = await import('../src/main/kirolexNote.ts');
    const convo = [
      'User: 可以',
      'Assistant: 开始。先把源卷填成 GiB 级的真实语料',
      'User: ⚠️ 这条会话现在跑在 gpt-5.6-sol 上 —— 你选的 claude-opus-5 这次起不来（KiroLex 按候选顺序退到了下一个）。\n它回来之后，在模型选择器里再点一次就会重试它。',
      'Assistant: 收到，知道了——这轮是 gpt-5.6-sol。',
    ].join('\n\n');
    const out = stripKirolexNotes(convo);
    assert.equal(/这条会话现在跑在/.test(out), false, '这一句就是泄漏出去的那句');
    assert.match(out, /GiB 级的真实语料/, '真正的对话必须一个字不少');
    /* 模型照着它答的那句留着 —— 删的是 KiroLex 说的，不是模型说的 */
    assert.match(out, /收到，知道了/);
  });
});
