import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { backendHeldAtTurnStart, contextMarkerHolds } from '../src/main/engines.ts';
import { adapterSweepScript, adapterVictimsAwk, parseAdapterSweep, sessionAgentName, ownedAgentPrefix, ADAPTER_TAG_ENV } from '../src/main/remoteLocalTools.ts';
import { buildRemoteAdapterCommand, adapterExitDetail } from '../src/main/acp-client.ts';
import { testConnectionScript, splitTestOutput, judgeTestConnection } from '../src/main/remoteAdapterProbe.ts';
import { acpAvailableCommands } from '../src/main/acpCommands.ts';
import { toSlashCommands } from '../src/renderer/slashCommands.ts';
import { setUiLang, uiLang } from '../src/main/uiText.ts';

/**
 * Claude Code / Codex 运行模式审计（docs/engine-audit-claude-codex.md）第二轮 —— 审查意见要求补齐的几条。
 * 编号接着 `engineAuditFixes.test.ts`（A1–A8）。kiro 的行为一处不变，每组里都有一条守着它。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf-8');
const M = read('src', 'main', 'index.ts');
const AC = read('src', 'main', 'acp-client.ts');

function slice(src: string, anchor: string, len = 2500): string {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `找不到锚点：${anchor}`);
  return src.slice(at, at + len);
}

describe('A4b 只聊一轮就重启：第一轮完成 → 重启 → load 成功 → 发送，不再带历史快照', () => {
  /** 按主进程的顺序走一遍「上下文已建立」标记：发送前判据 → 一轮结束记标记 → 重启换 pid → attach 判据 → 下一条的判据 */
  function run(engine: 'kiro' | 'claude' | 'codex') {
    let marker: { for?: string; pid?: number } = {};
    let transcript = 0;
    const cli = 'cli-1';
    let pid = 100;
    /* 第一轮：盘上什么都没有 */
    const holdsBefore = contextMarkerHolds(engine, marker, { cliSessionId: cli, pid });
    const rideAlong1 = !holdsBefore && transcript > 0;
    const held = backendHeldAtTurnStart(engine, holdsBefore, transcript === 0);
    transcript += 2;                                   // 用户 + 助手
    if (held) marker = { for: cli, pid };              // 成功结束 → markContextEstablished
    /* 重启：新进程，session/load(cli-1) 成功 */
    pid = 200;
    const freshAtAttach = marker.for !== undefined && !contextMarkerHolds(engine, marker, { cliSessionId: cli, pid });
    /* 第二条 */
    const rideAlong2 = !contextMarkerHolds(engine, marker, { cliSessionId: cli, pid }) && transcript > 0;
    return { rideAlong1, freshAtAttach, rideAlong2 };
  }
  test('Claude Code / Codex：load 回来的就是那段对话，第二条不带快照、attach 不判成空后端', () => {
    for (const engine of ['claude', 'codex'] as const) {
      assert.deepEqual(run(engine), { rideAlong1: false, freshAtAttach: false, rideAlong2: false });
    }
  });
  test('kiro：行为不变（第一轮之后不记标记，换进程后照旧随行带上下文）', () => {
    assert.deepEqual(run('kiro'), { rideAlong1: false, freshAtAttach: false, rideAlong2: true });
    assert.equal(backendHeldAtTurnStart('kiro', true, true), false);
  });
  test('适配器：盘上已有历史、又没有有效标记的一轮不算（那时后端可能是空的新会话）', () => {
    assert.equal(backendHeldAtTurnStart('claude', false, false), false);
    assert.equal(backendHeldAtTurnStart('claude', true, false), true);
  });
  test('index.ts：一轮开始时记下后端会话 id，成功结束且后端没换才记标记', () => {
    const gate = slice(M, 'const heldBackendAtStart = backendHeldAtTurnStart(engineOf(entry.profile),', 300);
    assert.match(gate, /contextEstablished\(sessionId, entry\), store\.transcriptFileSize\(sessionId\) === 0\)/);
    const end = slice(M, 'if (rideAlong && entry.rideAlongUnconfirmed) {', 400);
    assert.match(end, /else if \(heldBackendAtStart && heldBackendAtStart === entry\.cliSessionId && !contextEstablished\(sessionId, entry\)\) \{\s*markContextEstablished\(sessionId, entry\);/);
  });
});

describe('A9 远端孤儿清扫认得出 Claude Code / Codex 的适配器', () => {
  const OWNER = 'abc123';
  const tagA = sessionAgentName('s_1', OWNER);
  const tagB = sessionAgentName('s_2', OWNER);
  test('远端适配器命令带会话标记（整棵进程树继承）', () => {
    const cmd = buildRemoteAdapterCommand('claude-agent-acp', undefined, tagA);
    assert.ok(cmd.includes(`export ${ADAPTER_TAG_ENV}=${tagA}; exec`));
    assert.ok(tagA.startsWith(ownedAgentPrefix(OWNER)));
    /* 不合法的标记不拼进 shell；不带标记时命令和原来一样 */
    assert.equal(buildRemoteAdapterCommand('codex-acp', undefined, 'a b;rm').includes(ADAPTER_TAG_ENV), false);
    assert.equal(buildRemoteAdapterCommand('codex-acp').includes(ADAPTER_TAG_ENV), false);
    assert.match(AC, /buildRemoteAdapterCommand\(bin, remoteAdapterLaunchFor\(this\.remote, this\.engine\), this\.localTools\?\.agentOverride\)/);
  });
  test('清扫脚本从 /proc/<pid>/environ 认标记、只认本机 owner 前缀', () => {
    const s = adapterSweepScript(OWNER, null);
    assert.ok(s.includes('/proc/[0-9]*'));
    assert.ok(s.includes(`s/^${ADAPTER_TAG_ENV}=//p`));
    assert.ok(s.includes(`pfx='${ownedAgentPrefix(OWNER)}'`));
    assert.equal(parseAdapterSweep('noise\nKIROLEX_ADAPTER_SWEPT 3\n'), 3);
    assert.equal(parseAdapterSweep(''), 0);
  });
  test('index.ts 在两道 kiro 清扫之后再扫适配器（孤儿 + 没人持有）', () => {
    const body = slice(M, 'async function sweepRemoteExecutors(', 1800);
    assert.match(body, /adapterSweepScript\(OWNER, null\)/);
    assert.match(body, /adapterSweepScript\(OWNER, heldExecutorsOn\(target\)\)/);
  });

  /* 判据那段 awk 拿假进程表在本机真跑一遍（Git Bash / macOS / Linux 都自带 bash + awk） */
  const awkOk = spawnSync('bash', ['-c', 'command -v awk'], { encoding: 'utf8' }).status === 0;
  const skip = awkOk ? false : '本机没有 bash/awk';
  const victims = (rows: string, keep: { pids: number[]; tags: string[] } | null, age = 120): string[] => {
    const r = spawnSync('bash', ['-c', `printf '%s\\n' "$ROWS" | ${adapterVictimsAwk(keep, age)}`], { encoding: 'utf8', env: { ...process.env, ROWS: rows } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split(/\s+/).filter(Boolean).sort();
  };
  /* pid ppid etimes tag：A 是孤儿（顶的父进程是 1），B 挂在 sshd(500) 底下活着；11/12 是 A 的子孙，21 是 B 的子进程 */
  const rows = [
    `10 1 900 ${tagA}`, `11 10 890 ${tagA}`, `12 11 880 ${tagA}`,
    `20 500 900 ${tagB}`, `21 20 890 ${tagB}`,
  ].join('\n');
  test('孤儿：顶的父进程是 1 → 连同子孙一起；挂在 sshd 底下的不动', { skip }, () => {
    assert.deepEqual(victims(rows, null), ['10', '11', '12']);
  });
  test('父进程先没了、子孙被收养到 1 的也算孤儿', { skip }, () => {
    assert.deepEqual(victims(`11 1 890 ${tagA}\n12 11 880 ${tagA}\n20 500 900 ${tagB}`, null), ['11', '12']);
  });
  test('没人持有：顶不在持有的 pid 里就收；持有的、正在 attach 的、太新的都不动', { skip }, () => {
    assert.deepEqual(victims(rows, { pids: [20], tags: [] }), ['10', '11', '12']);
    assert.deepEqual(victims(rows, { pids: [], tags: [tagA, tagB] }), []);
    assert.deepEqual(victims(rows, { pids: [], tags: [] }, 1000), []);
  });
  test('同一条会话换执行器：新旧两个顶同一个标签，只收没人持有的那个', { skip }, () => {
    const swap = [`10 500 900 ${tagA}`, `11 10 890 ${tagA}`, `30 501 300 ${tagA}`, `31 30 290 ${tagA}`].join('\n');
    assert.deepEqual(victims(swap, { pids: [30], tags: [] }), ['10', '11']);
  });
});

describe('A10 「测试连接」也报 Claude Code / Codex', () => {
  /* 断言按英文原文写；中文表另有 i18nCoverage 守着 */
  let lang: ReturnType<typeof uiLang>;
  before(() => { lang = uiLang(); setUiLang('en'); });
  after(() => { setUiLang(lang); });
  const kiroOk = { code: 'ok', message: 'h: kiro-cli is installed and logged in.' };
  const kiroMissing = { code: 'missing-tools', message: 'h is missing kiro-cli.', missing: ['kiro-cli'] };
  const claudeReady = 'KX_PATHBIN\t/usr/bin/claude-agent-acp\t#!/usr/bin/env node\nKX_LOGINNODE\t/usr/bin/node\nKX_AUTH\tcredentials\n';
  const claudeNoAuth = 'KX_PATHBIN\t/usr/bin/claude-agent-acp\t#!/usr/bin/env node\nKX_LOGINNODE\t/usr/bin/node\n';
  test('一次 ssh：kiro 预检在前，两家探测接在后面，能切回三段', () => {
    const script = testConnectionScript('KIRO_PREFLIGHT');
    assert.ok(script.startsWith('KIRO_PREFLIGHT\n'));
    assert.match(script, /claude-agent-acp/);
    assert.match(script, /codex-acp/);
    const parts = splitTestOutput('HAVE kiro-cli\nAUTH ok\nKX_ENGINE_SPLIT claude\nKX_AUTH\tcredentials\nKX_ENGINE_SPLIT codex\n');
    assert.match(parts.kiro, /HAVE kiro-cli/);
    assert.equal(parts.kiro.includes('KX_AUTH'), false);
    assert.match(parts.claude, /KX_AUTH/);
    assert.equal(parts.codex.trim(), '');
  });
  test('只为 Claude 配的机器（没 kiro-cli）：算通，并分别说清三家', () => {
    const r = judgeTestConnection('h', kiroMissing, { claude: claudeReady, codex: '' });
    assert.equal(r.ok, true);
    assert.match(r.message, /Claude Code: ready/);
    assert.match(r.message, /Codex: adapter not installed/);
    assert.match(r.message, /Kiro: h is missing kiro-cli/);
  });
  test('装了但没登录要说出来；kiro 通了照旧算通、只多两行', () => {
    const r = judgeTestConnection('h', kiroOk, { claude: claudeNoAuth, codex: '' });
    assert.equal(r.ok, true);
    assert.ok(r.message.startsWith(kiroOk.message));
    assert.match(r.message, /Claude Code: installed, but not signed in/);
  });
  test('三家都不行：kiro 那个结论（code / missing 不变）', () => {
    const r = judgeTestConnection('h', kiroMissing, { claude: '', codex: '' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'missing-tools');
    assert.deepEqual(r.missing, ['kiro-cli']);
  });
  test('连不上：kiro 那句原样', () => {
    const un = { code: 'unreachable', message: 'Cannot connect' };
    assert.deepEqual(judgeTestConnection('h', un, { claude: claudeReady, codex: '' }), { ok: false, code: 'unreachable', message: 'Cannot connect', missing: undefined });
  });
  test('remote:test 接线', () => {
    const h = slice(M, "ipcMain.handle('remote:test'", 2200);
    assert.match(h, /testConnectionScript\(preflightScript\(undefined, \{ models: false \}\)\)/);
    assert.match(h, /judgeTestConnection\(target\.sshHost \|\| 'remote', judgePreflight\(out\.code, sections\.kiro, out\.stderr, target\), sections\)/);
  });
});

describe('A11 Claude Code / Codex 的斜杠命令菜单（ACP 标准的 available_commands_update）', () => {
  test('标准命令表 → kiro 那份表的形状（名字补 /、hint 搬进 meta），解析走同一个 toSlashCommands', () => {
    const rows = acpAvailableCommands([
      { name: 'compact', description: 'Compact the conversation' },
      { name: 'review', description: 'Review', input: { hint: '<path>' } },
      { name: '/already' },
      { description: 'no name' },
    ]);
    assert.deepEqual(toSlashCommands(rows), [
      { name: '/compact', description: 'Compact the conversation', hint: undefined, subcommands: undefined },
      { name: '/review', description: 'Review', hint: '<path>', subcommands: undefined },
      { name: '/already', description: undefined, hint: undefined, subcommands: undefined },
    ]);
    assert.deepEqual(acpAvailableCommands(null), []);
  });
  test('wireSession：只对非 kiro 换形状，之后进同一份缓存（acp:session-commands）和同一条渲染层路径', () => {
    const w = slice(M, "if (engineOf(entry.profile) !== 'kiro' && data?.update?.sessionUpdate === 'available_commands_update') {", 600);
    assert.match(w, /method: '_kiro\.dev\/commands\/available', commands: acpAvailableCommands\(data\.update\.availableCommands\)/);
    assert.ok(w.indexOf("data?.update?.method === '_kiro.dev/commands/available'") > 0, '换完形状之后紧接着就是那段缓存');
  });
});

describe('A12 适配器一起来就退出：报错带上 stderr 的最后几行', () => {
  test('取最后三行、去掉远端自报 PID 那行、容忍 \\r\\n', () => {
    assert.equal(adapterExitDetail('KIROLEX_REMOTE_PID 4242\r\nline1\r\nline2\r\nline3\r\nError: Cannot find module node:sqlite\r\n'),
      '\nline2\nline3\nError: Cannot find module node:sqlite');
    assert.equal(adapterExitDetail('KIROLEX_REMOTE_PID 4242\n'), '');
    assert.equal(adapterExitDetail(''), '');
  });
  test('只拼在非 kiro 的「Process exited with code N」后面（kiro 那句不变）', () => {
    assert.match(AC, /`Process exited with code \$\{code\}\$\{this\.engine !== 'kiro' \? adapterExitDetail\(this\.lastStderr\) : ''\}`/);
  });
});

describe('A13 远程 Claude Code / Codex 会话不去远端问 kiro 的模型清单', () => {
  test('modelsFor：远程分支先看引擎', () => {
    const app = read('src', 'renderer', 'App.tsx');
    const fn = slice(app, 'const modelsFor = useCallback((session: Session | null): any[] => {', 1200);
    const remote = fn.indexOf('if (!host) return models;');
    const guard = fn.indexOf("if (session?.engine === 'claude' || session?.engine === 'codex') return [];");
    const ask = fn.indexOf('void refreshModels(machine);');
    assert.ok(remote > 0 && guard > remote && ask > guard, '本机分支不变；远程分支在问之前就返回');
  });
});

describe('A10 补：输出里的 \\r\\n 和行尾空格不影响切段', () => {
  test('splitTestOutput', () => {
    const parts = splitTestOutput('HAVE kiro-cli\r\nKX_ENGINE_SPLIT claude  \r\nKX_AUTH\tcredentials\r\nKX_ENGINE_SPLIT codex\r\n');
    assert.match(parts.claude, /KX_AUTH/);
    assert.equal(parts.kiro.includes('KX_ENGINE_SPLIT'), false);
  });
});
