import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { AcpClient, buildRemoteAdapterCommand, parseRemotePid } from '../src/main/acp-client.ts';
import { noticesFromStderr } from '../src/main/stderrNotice.ts';
import { PromptSuggestionStore, SuggestionTurnLedger, fixedSuggestionFallback, planSuggestionLookup, parseSuggestionLines, promptSuggestionsFromUpdate, suggestionSourceFor, suggestionsPrompt } from '../src/main/promptSuggestions.ts';
import { CLAUDE_SUGGESTION_TAP_SOURCE, REMOTE_TAP_MARKER, claudeSuggestionTapImport, remoteClaudeTapExecLine, withClaudeSuggestionTap } from '../src/main/claudeSuggestionTap.ts';
import { CODEX_DISABLED_FEATURES, CODEX_SUGGEST_TIMEOUT_MS, REMOTE_CODEX_SUGGEST_OK, codexFinalMessage, codexSuggestArgs, codexToolAttempt, codexTopLevelString, localCodexLaunch, parseRemoteCodexOutput, remoteCodexSuggestScript } from '../src/main/codexSuggestions.ts';

/**
 * 追问建议：Claude Code 用它自己的下一句预测（`_meta.promptSuggestions`），Codex 用同一台机器上的 `codex exec`，
 * kiro 不变；会话内容只交给它自己那一家。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf-8');
const M = read('src', 'main', 'index.ts');
function slice(src: string, anchor: string, len: number): string {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `找不到锚点：${anchor}`);
  return src.slice(at, at + len);
}
/** 从锚点截到下一个顶层 `function` / `async function` 声明之前（一个函数的整个函数体） */
function fnBody(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `找不到锚点：${anchor}`);
  const next = src.slice(at + anchor.length).search(/\n(?:async )?function /);
  return src.slice(at, next < 0 ? undefined : at + anchor.length + next);
}
const info = (texts: string[]) => ({ sessionUpdate: 'session_info_update', _meta: { promptSuggestions: { suggestions: texts.map((text) => ({ text })) } } });

function fakeClient(engine: 'kiro' | 'claude' | 'codex') {
  const c: any = new AcpClient('m', {}, undefined, 'ask', undefined, undefined, engine);
  c.send = () => {};
  c.process = { stdin: { writable: true } };
  const updates: any[] = [];
  const suggestions: any[] = [];
  c.on('update', (u: any) => updates.push(u));
  c.on('prompt-suggestions', (d: any) => suggestions.push(d));
  return { c, updates, suggestions };
}

describe('Claude Code 的下一句预测：session_info_update._meta.promptSuggestions', () => {
  test('认形状：[{text:"X"}] → ["X"]；空数组 = 清掉；空白的不算；别的 session_info_update 不是它', () => {
    assert.deepEqual(promptSuggestionsFromUpdate(info(['X'])), ['X']);
    assert.deepEqual(promptSuggestionsFromUpdate(info([])), []);
    assert.deepEqual(promptSuggestionsFromUpdate(info(['   '])), []);
    assert.equal(promptSuggestionsFromUpdate({ sessionUpdate: 'session_info_update', title: 'Hello' }), null);
    assert.equal(promptSuggestionsFromUpdate({ sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'idle' } } } }), null);
    assert.equal(promptSuggestionsFromUpdate({ sessionUpdate: 'agent_message_chunk', _meta: { promptSuggestions: { suggestions: [{ text: 'X' }] } } }), null);
  });

  test('适配器发来 [{text:"X"}] → 这条会话的建议变成 ["X"]；再发空数组 → 清空', () => {
    const { c, updates, suggestions } = fakeClient('claude');
    const store = new PromptSuggestionStore();
    c.on('prompt-suggestions', (d: any) => store.set('s1', d.suggestions));
    c.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cli-1', update: info(['X']) } });
    assert.deepEqual(store.get('s1'), ['X']);
    c.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cli-1', update: info([]) } });
    assert.deepEqual(store.get('s1'), []);
    assert.equal(suggestions.length, 2);
    assert.equal(updates.length, 0, '预测不进这一轮的输出（不显示成消息、不落盘、不算回放）');
  });

  test('prompt 还在途时到的预测先压着（不提前交出去）；清掉的随时都认，也丢掉压着的', () => {
    const { c, suggestions } = fakeClient('claude');
    c.inflightPrompts = [7];
    c.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'x', update: info(['held']) } });
    assert.equal(suggestions.length, 0);
    c.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'x', update: info([]) } });
    assert.deepEqual(suggestions.map((d) => d.suggestions), [[]]);
  });

  test('时序：结束响应和预测同一块数据先后到达 → 这一轮的预测交出去（不因主进程还没收尾而丢）', () => {
    const { c, suggestions } = fakeClient('claude');
    c.pendingRequests.set(7, { resolve: () => {}, reject: () => {}, timer: setTimeout(() => {}, 0) });
    c.inflightPrompts = [7];
    c.handleMessage({ jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } });
    c.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'x', update: info(['下一步']) } });
    assert.deepEqual(suggestions.map((d) => d.suggestions), [['下一步']]);
    /* 主进程那一层不再按 busy 丢（同一块数据里收尾还没跑，busy 还是 true） */
    const on = slice(M, "client.on('prompt-suggestions'", 400);
    assert.doesNotMatch(on, /entry\.busy/);
  });

  test('时序：预测比结束响应先到（旁听比适配器写响应早一步）→ 压着，结束响应一到就交出去', () => {
    const { c, suggestions } = fakeClient('claude');
    let resolved = false;
    c.pendingRequests.set(8, { resolve: () => { resolved = true; }, reject: () => {}, timer: setTimeout(() => {}, 0) });
    c.inflightPrompts = [8];
    c.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'x', update: info(['先到的']) } });
    assert.equal(suggestions.length, 0, '这一轮还没结束，先不交');
    c.handleMessage({ jsonrpc: '2.0', id: 8, result: { stopReason: 'end_turn' } });
    assert.equal(resolved, true);
    assert.deepEqual(suggestions.map((d) => d.suggestions), [['先到的']]);
  });

  test('别的 session_info_update（Codex 的 threadStatus）照旧走 update', () => {
    const { c, updates, suggestions } = fakeClient('codex');
    c.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'x', update: { sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'idle' } } } } } });
    assert.equal(updates.length, 1);
    assert.equal(suggestions.length, 0);
  });

  test('主进程：收到就按会话存、推给界面（acp:prompt-suggestions）；每一轮开始先清掉上一轮的', () => {
    const on = slice(M, "client.on('prompt-suggestions'", 600);
    assert.match(on, /nativeSuggestions\.set\(sessionId, list\)/);
    assert.match(on, /webContents\.send\('acp:prompt-suggestions', \{ sessionId, suggestions: list \}\)/);
    assert.match(on, /logger\.info\('suggestions', `source=native-/);
    const send = slice(M, 'async function sendPromptOnce(', 2500);
    assert.match(send, /if \(attempt === 0\) nativeSuggestions\.clear\(sessionId\);/);
    assert.match(read('src', 'main', 'preload.ts'), /ipcRenderer\.on\('acp:prompt-suggestions', handler\)/);
  });

  test('界面：推过来的预测作为这一轮的追问建议显示，空列表清掉；Claude Code / Codex 这一轮没拿到不反复再问', () => {
    const C = read('src', 'renderer', 'components', 'ChatArea.tsx');
    const sub = slice(C, 'window.kiroApi.onPromptSuggestions?.((d) => {', 600);
    assert.match(sub, /d\.sessionId !== currentSessionId/);
    assert.match(sub, /if \(!key \|\| streaming\) return;/);
    assert.match(sub, /setDynamicSuggestions\(\{ key: items\.length \? key : null, items \}\)/);
    assert.match(C, /else if \(r\?\.source === 'codex-exec'\) \{ markSuggestionTried\(key\); return; \}/);
  });
});

describe('Claude Code：不声明 AIR，旁听 CLI 的 prompt_suggestion（claudeSuggestionTap.ts）', () => {
  test('本机起适配器 = node --import <旁听> <入口>；不是 js 入口的起法原样不动', () => {
    const t = withClaudeSuggestionTap({ command: 'electron', args: ['/x/claude-agent-acp/dist/index.js'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    assert.equal(t.tapped, true);
    assert.deepEqual(t.args, ['--import', claudeSuggestionTapImport(), '/x/claude-agent-acp/dist/index.js']);
    assert.deepEqual(t.env, { ELECTRON_RUN_AS_NODE: '1' });
    assert.ok(claudeSuggestionTapImport().startsWith('data:text/javascript,'));
    const bare = withClaudeSuggestionTap({ command: 'claude-agent-acp', args: [] });
    assert.equal(bare.tapped, false);
    assert.deepEqual(bare.args, []);
  });

  test('initialize 里不声明 AIR（`_meta.jetbrains.air`）—— 那会去掉工具调用的 toolName / parentToolUseId 等', () => {
    const client = read('src', 'main', 'acp-client.ts') + read('src', 'main', 'elicitation.ts');
    assert.doesNotMatch(client, /jetbrains[^\n]{0,40}air[^\n]{0,40}(version|capabilities)/i);
    const conn = read('src', 'main', 'acp-client.ts');
    assert.match(conn, /const tap = this\.engine === 'claude' \? withClaudeSuggestionTap\(a\) : \{ \.\.\.a, tapped: false \};/);
  });

  test('真跑一遍：CLI 的输出原样到适配器，同时在适配器的 stdout 上多一条 session_info_update', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-tap-'));
    try {
      /* 假 CLI（和真的一样的顺序）：一条普通消息（带中文）、result，再把 prompt_suggestion 拆成两半写（跨 chunk） */
      fs.writeFileSync(path.join(dir, 'cli.mjs'), [
        "process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: '中文 hi' } }) + '\\n');",
        "process.stdout.write('{\"type\":\"result\",\"subtype\":\"success\"}\\n{\"type\":\"prompt_sugges');",
        "setTimeout(() => { process.stdout.write('tion\",\"suggestion\":\"  跑一下测试 \",\"uuid\":\"u\",\"session_id\":\"S1\"}\\n'); }, 30);",
      ].join('\n'));
      /* 假适配器：起 CLI（带 --output-format stream-json），自己数收到多少字节，最后报出来 */
      fs.writeFileSync(path.join(dir, 'entry.mjs'), [
        "import { spawn } from 'node:child_process';",
        "import { fileURLToPath } from 'node:url';",
        "const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));",
        "const c = spawn(process.execPath, [cli, '--output-format', 'stream-json'], { stdio: ['pipe', 'pipe', 'pipe'] });",
        "let got = ''; c.stdout.setEncoding('utf8'); c.stdout.on('data', (d) => { got += d; });",
        "c.on('exit', () => { process.stdout.write(JSON.stringify({ adapterSaw: got }) + '\\n'); });",
      ].join('\n'));
      const out = execFileSync(process.execPath, ['--import', claudeSuggestionTapImport(), path.join(dir, 'entry.mjs')], { encoding: 'utf8' });
      const lines = out.trim().split('\n').map((l) => JSON.parse(l));
      const relayed = lines.find((m) => m.method === 'session/update');
      assert.ok(relayed, out);
      assert.equal(relayed.jsonrpc, '2.0');
      assert.deepEqual(promptSuggestionsFromUpdate(relayed.params.update), ['跑一下测试']);
      const saw = lines.find((m) => 'adapterSaw' in m).adapterSaw as string;
      assert.match(saw, /中文 hi/);
      assert.match(saw, /"type":"prompt_suggestion"/, '适配器那边一个字节都不少');
      assert.match(saw, /"type":"result"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('旁听只挂只读的 data 监听，不改写、不暂停 CLI 的输出；只认带 stream-json 的那个子进程', () => {
    assert.match(CLAUDE_SUGGESTION_TAP_SOURCE, /args\.includes\('--output-format'\) && args\.includes\('stream-json'\)/);
    assert.doesNotMatch(CLAUDE_SUGGESTION_TAP_SOURCE, /\.pause\(|\.unshift\(|\.push\(|removeAllListeners/);
  });
});

describe('generate-suggestions 按引擎分流：会话内容只交给它自己那一家', () => {
  test('来源：claude → native-claude、codex → codex-exec、kiro / 不知道 → kiro', () => {
    assert.equal(suggestionSourceFor('claude'), 'native-claude');
    assert.equal(suggestionSourceFor('codex'), 'codex-exec');
    assert.equal(suggestionSourceFor('kiro'), 'kiro');
    assert.equal(suggestionSourceFor(undefined), 'kiro');
  });

  test('handler：先按引擎分流，Claude Code / Codex 在 runLiteOneShot（kiro-cli）之前就返回', () => {
    const h = slice(M, "ipcMain.handle('app:generate-suggestions'", 2500);
    const own = h.indexOf('const own = await engineOwnSuggestions(meta?.sessionId, convo);');
    assert.ok(own > 0);
    assert.ok(h.indexOf('if (own) return own;') > own);
    assert.ok(h.indexOf('if (own) return own;') < h.indexOf('runLiteOneShot('));
    assert.match(h, /logger\.info\('suggestions', `source=kiro generated \$\{suggestions\.length\}`\)/);
  });

  test('Claude Code 会话：不起 kiro-cli，也不起 codex —— 只读存下来的原生预测', () => {
    const body = fnBody(M, 'async function engineOwnSuggestions(');
    const claude = body.slice(body.indexOf("if (source === 'native-claude') {"), body.indexOf("const turn = createHash('sha1')"));
    assert.ok(claude.length > 0);
    assert.match(claude, /nativeSuggestions\.get\(sessionId\)/);
    assert.doesNotMatch(claude, /runLiteOneShot|codexExecSuggestions|execFile|spawn|runRemoteCapture/);
    assert.match(claude, /source=native-claude generated/);
    assert.match(claude, /skipped source=native-claude[^\n]*reason=/);
    assert.doesNotMatch(body, /runLiteOneShot/);
  });

  test('Codex 会话：不起 kiro-cli，也不起 claude；失败 / 超时不重试、不回退', () => {
    const body = fnBody(M, 'async function codexExecSuggestions(');
    assert.doesNotMatch(body, /runLiteOneShot|claude/i);
    assert.match(body, /source=codex-exec generated/);
    assert.match(body, /source=codex-exec failed/);
    assert.equal((body.match(/runCodexExecLocal\(|runRemoteCapture\(/g) || []).length, 2, '本机一次、远程一次，各只调一次');
  });
});

describe('Codex 会话：codex exec（codexSuggestions.ts）', () => {
  test('提示词和 kiro 的同一份', () => {
    const p = suggestionsPrompt('User: hi');
    assert.match(p, /^Based on the conversation below, propose 3 short follow-up prompts/);
    assert.match(p, /SAME language as the conversation/);
    assert.ok(p.endsWith('\n\nUser: hi'));
    assert.deepEqual(parseSuggestionLines('1. 跑测试\n- "看日志"\n\n写文档'), ['跑测试', '看日志', '写文档']);
  });

  test('拼出来的命令是 codex exec，带上这条会话的 model 和 provider，effort low、只读、不联网、prompt 走 stdin', () => {
    const args = codexSuggestArgs({ model: 'gpt-5.5', provider: 'amazon-bedrock-runtime', cwd: '/tmp' });
    assert.equal(args[0], 'exec');
    assert.deepEqual(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2), ['-m', 'gpt-5.5']);
    assert.ok(args.includes('model_provider="amazon-bedrock-runtime"'));
    assert.ok(args.includes('model_reasoning_effort="low"'));
    assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
    for (const c of ['web_search="disabled"', 'mcp_servers={}', 'approval_policy="never"']) assert.ok(args.includes(c), c);
    assert.ok(args.includes('--ephemeral'));
    assert.equal(args[args.length - 1], '-');
    assert.equal(args.join(' ').includes('User:'), false, '会话内容不进命令行');
    assert.equal(CODEX_SUGGEST_TIMEOUT_MS <= 45_000, true);
  });

  test('provider 读 config.toml 最顶层的 model_provider（表里面的不算）', () => {
    const toml = '# c\nmodel = "m1"\nmodel_provider = "amazon-bedrock-runtime" # x\n\n[model_providers.other]\nmodel_provider = "nope"\n';
    assert.equal(codexTopLevelString(toml, 'model_provider'), 'amazon-bedrock-runtime');
    assert.equal(codexTopLevelString('[a]\nmodel_provider = "x"\n', 'model_provider'), undefined);
    assert.equal(codexTopLevelString("model_provider = 'lit'\r\n", 'model_provider'), 'lit');
  });

  test('本机：用适配器自带的 @openai/codex（Electron 的 node 跑 codex.js）；CODEX_PATH 优先；Windows 上找不到就不跑', () => {
    const entry = path.join('/g', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js');
    const bundled = path.join('/g', '@agentclientprotocol', 'codex-acp', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    const l = localCodexLaunch({ env: {}, adapterEntry: entry, globalRoots: ['/g'], exists: (p) => p === bundled, execPath: '/electron', platform: 'win32' });
    assert.deepEqual(l, { command: '/electron', args: [bundled], env: { ELECTRON_RUN_AS_NODE: '1' } });
    const o = localCodexLaunch({ env: { CODEX_PATH: '/opt/codex' }, adapterEntry: entry, globalRoots: [], exists: () => true, execPath: '/electron', platform: 'linux' });
    assert.equal(o?.command, '/opt/codex');
    assert.equal(localCodexLaunch({ env: {}, adapterEntry: null, globalRoots: [], exists: () => false, execPath: '/e', platform: 'win32' }), null);
    assert.equal(localCodexLaunch({ env: {}, adapterEntry: null, globalRoots: [], exists: () => false, execPath: '/e', platform: 'darwin' })?.command, 'codex');
  });

  test('远程会话：命令在远端机器上执行（ssh 上的 runRemoteCapture），带 model，provider 读远端的配置', () => {
    const body = fnBody(M, 'async function codexExecSuggestions(');
    assert.match(body, /if \(remote\?\.sshHost\) \{[\s\S]{0,300}runRemoteCapture\(remote, remoteCodexSuggestScript\(\{ model, codexBin: remote\.bins\?\.codex, launch: remoteAdapterLaunchFor\(remote, 'codex'\) \}\), CODEX_SUGGEST_TIMEOUT_MS, undefined, prompt\)/);
    const s = remoteCodexSuggestScript({ model: 'gpt-5.5' });
    assert.match(s, /'exec' '--json' '--skip-git-repo-check'/);
    assert.match(s, /'-m' 'gpt-5\.5'/);
    assert.match(s, /model_provider/);
    assert.match(s, /timeout 45/);
    assert.equal(parseRemoteCodexOutput(`noise\n${REMOTE_CODEX_SUGGEST_OK}\na\nb`), 'a\nb');
    assert.equal(parseRemoteCodexOutput('bash: codex: command not found'), null);
  });

  test('真跑一遍远端脚本（bash + 假 codex）：provider 取远端顶层配置，prompt 从 stdin 进', { skip: (() => { try { execFileSync('bash', ['-c', 'true']); return false; } catch { return '这台机器没有 bash'; } })() }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-codexsug-'));
    try {
      const toPosix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.mkdirSync(path.join(dir, '.codex'));
      fs.writeFileSync(path.join(dir, 'bin', 'codex'), '#!/bin/sh\necho "ARGS: $*"\ncat\n', { mode: 0o755 });
      fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'model_provider = "prov-1"\n[model_providers.x]\nmodel_provider = "nope"\n');
      fs.writeFileSync(path.join(dir, 's.sh'), remoteCodexSuggestScript({ model: 'gpt-5.5' }));
      const out = execFileSync('bash', ['-c', 'export HOME="$1" PATH="$2:$PATH"; bash "$3"', 'x', toPosix(dir), toPosix(path.join(dir, 'bin')), toPosix(path.join(dir, 's.sh'))], { encoding: 'utf8', input: 'PROMPT TEXT' });
      const got = parseRemoteCodexOutput(out);
      assert.ok(got, out);
      assert.match(got!, /^ARGS: exec .*-m gpt-5\.5 -c model_provider="prov-1" -C \S+ -$/m);
      assert.match(got!, /PROMPT TEXT/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const hasBash = (() => { try { execFileSync('bash', ['-c', 'true']); return false; } catch { return '这台机器没有 bash'; } })();
const toPosix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);

describe('远程 Claude Code 会话：远端适配器同样带上旁听（remoteClaudeTapExecLine）', () => {
  test('Claude Code 的远端启动命令带旁听（安装后的验证起的也是这一条）；Codex 不变', () => {
    const plain = buildRemoteAdapterCommand('codex-acp', { kind: 'path' });
    assert.doesNotMatch(plain, /--import/);
    const tapped = buildRemoteAdapterCommand('claude-agent-acp', { kind: 'path' }, 'tag1');
    assert.match(tapped, /--import/);
    assert.match(tapped, /KIROLEX_REMOTE_PID suggestion-tap/);
    assert.equal((tapped.match(/export KIROLEX_EXECUTOR=tag1; exec/g) || []).length, 2, '两条 exec 前都带会话标记');
    const conn = read('src', 'main', 'acp-client.ts');
    assert.ok(conn.includes('const exec = bin === REMOTE_ADAPTER_BIN.claude ? remoteClaudeTapExecLine(bin, launch, adapterExecLine(bin, launch), mark)'));
    assert.match(conn, /if \(msg\.includes\(REMOTE_TAP_MARKER\)\) this\.suggestionTap = true;/);
  });

  test('那行标记不当 PID、不当成后端报错显示', () => {
    assert.equal(parseRemotePid(REMOTE_TAP_MARKER), undefined);
    assert.deepEqual(noticesFromStderr(REMOTE_TAP_MARKER), []);
  });

  test('入口不是 js / node 不支持 --import：落到原来那条 exec', () => {
    const line = remoteClaudeTapExecLine('claude-agent-acp', { kind: 'path' }, "exec 'claude-agent-acp'");
    assert.match(line, /case "\$e" in \*\.js\|\*\.mjs\|\*\.cjs\)/);
    assert.match(line, /process\.versions\.node/);
    assert.ok(line.endsWith("; exec 'claude-agent-acp'"));
  });

  test('真跑一遍远端那条命令（bash，探测记下的 node + 入口）：收到预测、再收到清空，stderr 有标记', { skip: hasBash }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-rtap-'));
    try {
      fs.writeFileSync(path.join(dir, 'cli.mjs'), [
        "process.stdout.write('{\"type\":\"result\"}\\n{\"type\":\"prompt_suggestion\",\"suggestion\":\"X\",\"session_id\":\"S\"}\\n');",
        "process.stdout.write('{\"type\":\"result\"}\\n{\"type\":\"prompt_suggestion\",\"suggestion\":\"  \",\"session_id\":\"S\"}\\n');",
      ].join('\n'));
      fs.writeFileSync(path.join(dir, 'entry.mjs'), [
        "import { spawn } from 'node:child_process';",
        "import { fileURLToPath } from 'node:url';",
        "const c = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), '--output-format', 'stream-json']);",
        "c.stdout.resume();",
      ].join('\n'));
      const launch = { kind: 'absolute', manager: 'nvm', node: toPosix(process.execPath), entry: toPosix(path.join(dir, 'entry.mjs')) } as any;
      const cmd = buildRemoteAdapterCommand('claude-agent-acp', launch);
      const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 60_000 });
      assert.match(String(r.stderr), /KIROLEX_REMOTE_PID suggestion-tap/, String(r.stderr));
      const { c } = fakeClient('claude');
      const store = new PromptSuggestionStore();
      const seen: string[][] = [];
      c.on('prompt-suggestions', (d: any) => { store.set('s1', d.suggestions); seen.push(store.get('s1')); });
      for (const l of String(r.stdout).split('\n').filter(Boolean)) c.handleMessage(JSON.parse(l));
      assert.deepEqual(seen, [['X'], []], String(r.stdout));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('固定建议兜底', () => {
  test('Claude Code / Codex 这一轮没有动态建议 → 照旧显示固定建议；kiro 不变；还没回复完不显示', () => {
    assert.equal(fixedSuggestionFallback('claude', 's:a1'), true);
    assert.equal(fixedSuggestionFallback('codex', 's:a1'), true);
    assert.equal(fixedSuggestionFallback('kiro', 's:a1'), false);
    assert.equal(fixedSuggestionFallback(undefined, 's:a1'), false);
    assert.equal(fixedSuggestionFallback('claude', null), false);
    const C = read('src', 'renderer', 'components', 'ChatArea.tsx');
    assert.match(C, /: fixedSuggestionFallback\(engine, currentTurnKey\) \? PROMPT_SUGGESTIONS : \[\]\)\}/);
  });
});

describe('Codex 不调工具', () => {
  test('执行命令的工具（shell_tool / unified_exec）和别的工具开关都关掉', () => {
    const args = codexSuggestArgs({ cwd: '/tmp' });
    for (const f of ['shell_tool', 'unified_exec', 'apps', 'browser_use', 'computer_use', 'multi_agent', 'view_image', 'image_generation', 'plugins', 'hooks']) {
      assert.ok(CODEX_DISABLED_FEATURES.includes(f), f);
      assert.ok(args.includes(`features.${f}=false`), f);
    }
    assert.ok(args.includes('--json'));
  });

  test('输出里一出现工具调用就作废；只取最后那条回答', () => {
    const msg = (t: string) => JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: t } });
    const tool = JSON.stringify({ type: 'item.started', item: { id: 'i2', type: 'command_execution', command: 'ls' } });
    const collab = JSON.stringify({ type: 'item.started', item: { id: 'i3', type: 'collab_tool_call', tool: 'spawn_agent' } });
    assert.equal(codexToolAttempt(tool), 'command_execution');
    assert.equal(codexToolAttempt(collab), 'collab_tool_call:spawn_agent');
    assert.equal(codexToolAttempt(msg('a')), null);
    assert.equal(codexToolAttempt(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'x' } })), null);
    assert.equal(codexFinalMessage([JSON.stringify({ type: 'thread.started' }), msg('先说一句'), msg('一\n二\n三'), JSON.stringify({ type: 'turn.completed' })].join('\n')), '一\n二\n三');
    assert.throws(() => codexFinalMessage([msg('x'), tool, msg('y')].join('\n')), /tried to call a tool \(command_execution\)/);
  });

  test('本机：边读边认，认出工具调用当场按树结束；结果按最后那条回答取', () => {
    const run = fnBody(M, 'function runCodexExecLocal(');
    assert.match(run, /const tool = codexToolAttempt\(line\);\s*if \(tool\) \{ toolTried = tool; stop\(\); return; \}/);
    assert.match(run, /if \(toolTried\) reject\(/);
    const body = fnBody(M, 'async function codexExecSuggestions(');
    assert.match(body, /const answer = codexFinalMessage\(out\);/);
  });

  test('真跑一遍远端脚本：假 codex 先答一句再调工具 → 后面的不再读、结果作废', { skip: hasBash }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-codextool-'));
    try {
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.writeFileSync(path.join(dir, 'bin', 'codex'), [
        '#!/bin/sh',
        `echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hi"}}'`,
        `echo '{"type":"item.started","item":{"id":"i2","type":"command_execution","command":"ls"}}'`,
        `echo '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"AFTER"}}'`,
      ].join('\n') + '\n', { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 's.sh'), remoteCodexSuggestScript({ model: 'm' }));
      const out = execFileSync('bash', ['-c', 'export HOME="$1" PATH="$2:$PATH"; bash "$3"', 'x', toPosix(dir), toPosix(path.join(dir, 'bin')), toPosix(path.join(dir, 's.sh'))], { encoding: 'utf8', input: 'P' });
      const got = parseRemoteCodexOutput(out)!;
      assert.ok(got.includes('command_execution'), out);
      assert.equal(got.includes('AFTER'), false, '工具调用之后的不再读');
      assert.throws(() => codexFinalMessage(got), /tried to call a tool/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('旁听判过时：新一轮已经发给 CLI 之后才到的上一轮预测不转发', () => {
  function runTap(cli: string[], entry: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-tapstale-'));
    try {
      fs.writeFileSync(path.join(dir, 'cli.mjs'), cli.join('\n'));
      fs.writeFileSync(path.join(dir, 'entry.mjs'), [
        "import { spawn } from 'node:child_process';",
        "import { fileURLToPath } from 'node:url';",
        "const c = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), '--output-format', 'stream-json'], { stdio: ['pipe', 'pipe', 'pipe'] });",
        ...entry,
      ].join('\n'));
      return execFileSync(process.execPath, ['--import', claudeSuggestionTapImport(), path.join(dir, 'entry.mjs')], { encoding: 'utf8', timeout: 30_000 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const relayed = (out: string) => out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.method === 'session/update');

  test('result → 适配器写了新的用户消息 → 才到的预测：丢掉', () => {
    const out = runTap([
      "process.stdout.write('{\"type\":\"result\"}\\n');",
      "process.stdin.on('data', (d) => { if (String(d).includes('\"type\":\"user\"')) { process.stdout.write('{\"type\":\"prompt_suggestion\",\"suggestion\":\"stale\",\"session_id\":\"S\"}\\n'); process.exit(0); } });",
    ], [
      "let sent = false; c.stdout.on('data', (d) => { if (!sent && String(d).includes('result')) { sent = true; c.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'next' } }) + '\\n'); } });",
    ]);
    assert.deepEqual(relayed(out), [], out);
  });

  test('result → 预测（中间没有新的用户消息）：转发；同一个 result 后的第二条不再转发；没有 result 就到的不转发', () => {
    const out = runTap([
      "process.stdout.write('{\"type\":\"prompt_suggestion\",\"suggestion\":\"before-result\",\"session_id\":\"S\"}\\n');",
      "process.stdout.write('{\"type\":\"result\"}\\n{\"type\":\"prompt_suggestion\",\"suggestion\":\"fresh\",\"session_id\":\"S\"}\\n{\"type\":\"prompt_suggestion\",\"suggestion\":\"again\",\"session_id\":\"S\"}\\n');",
    ], ["c.stdout.resume();"]);
    assert.deepEqual(relayed(out).map((m) => promptSuggestionsFromUpdate(m.params.update)), [['fresh']], out);
  });
});

describe('Codex 每条会话每一轮只生成一次（失败 / 超时也算）', () => {
  test('同一轮：第一次失败，切走再切回来再问 → 不再起 codex，给记下的结果', async () => {
    const ledger = new SuggestionTurnLedger<{ suggestions: string[]; error?: string }>();
    let started = 0;
    const codex = async () => { started++; return { suggestions: [], error: 'timed out after 45s' }; };
    const first = ledger.run('s1', 'turn-A', codex);
    assert.equal(first.reused, false);
    assert.deepEqual(await first.result, { suggestions: [], error: 'timed out after 45s' });
    /* 切到别的会话（别的会话自己那一轮照常生成） */
    const other = ledger.run('s2', 'turn-X', codex);
    await other.result;
    /* 切回来：同一轮再问 */
    const again = ledger.run('s1', 'turn-A', codex);
    assert.equal(again.reused, true);
    assert.deepEqual(await again.result, { suggestions: [], error: 'timed out after 45s' });
    assert.equal(started, 2, 's1 只起过一次，另一次是 s2 的');
  });

  test('正在生成时又来问同一轮 → 拿同一个结果（不另起、也不返回一个空的「失败」）；新的一轮照常生成', async () => {
    const ledger = new SuggestionTurnLedger<string[]>();
    let started = 0;
    let release: (v: string[]) => void = () => {};
    const a = ledger.run('s1', 'turn-A', () => { started++; return new Promise<string[]>((r) => { release = r; }); });
    const b = ledger.run('s1', 'turn-A', async () => { started++; return ['不该跑']; });
    assert.equal(b.reused, true);
    release(['写测试']);
    assert.deepEqual(await b.result, ['写测试']);
    assert.deepEqual(await a.result, ['写测试']);
    const next = ledger.run('s1', 'turn-B', async () => { started++; return ['下一轮']; });
    assert.equal(next.reused, false);
    assert.deepEqual(await next.result, ['下一轮']);
    assert.equal(started, 2);
  });

  test('接线：主进程按「会话 + 对话内容哈希」记账再起 codex；界面把没拿到的那一轮记在模块级，重新挂载 / 切回来不再问', () => {
    const body = fnBody(M, 'async function engineOwnSuggestions(');
    assert.match(body, /const turn = createHash\('sha1'\)\.update\(convo\)\.digest\('hex'\);\s*const \{ result, reused \} = codexSuggestTurns\.run\(sessionId, turn, \(\) => codexExecSuggestions\(/);
    assert.equal((M.match(/codexExecSuggestions\(sessionId, convo/g) || []).length, 1, '只有经账本这一处会起 codex');
    const C = read('src', 'renderer', 'components', 'ChatArea.tsx');
    assert.match(C, /^const suggestionTried = new Set<string>\(\);$/m, '模块级，不随组件卸载丢失');
    assert.match(C, /else if \(r\?\.source === 'codex-exec'\) \{ markSuggestionTried\(key\); return; \}/);
    const eff = slice(C, 'const plan = planSuggestionLookup({ engine, cached: suggestionCache.get(key), tried: suggestionTried.has(key) });', 2500);
    assert.ok(eff.indexOf("if (plan.kind === 'skip') { suggestionsForRef.current = key; return; }") > 0);
    assert.ok(eff.indexOf("plan.kind === 'skip'") < eff.indexOf('generateSuggestions'), '问之前先查');
  });
});

describe('Claude Code：切走 / 重新挂载后以主进程那份为准（后台到的新预测、后台清空）', () => {
  /** 模拟：主进程的存储 + 执行器推送（后台会话的推送照样写进主进程）+ 切回来时界面按 planSuggestionLookup 去拿 */
  function harness() {
    const store = new PromptSuggestionStore();
    const { c } = fakeClient('claude');
    c.on('prompt-suggestions', (d: any) => store.set('s1', d.suggestions));
    const uiCache = new Map<string, string[]>();
    const uiTried = new Set<string>();
    /* 界面这一格切回 s1 时显示什么（null = 固定建议） */
    const showOnSwitchBack = (key: string): string[] | null => {
      const plan = planSuggestionLookup({ engine: 'claude', cached: uiCache.get(key), tried: uiTried.has(key) });
      if (plan.kind === 'use-cache') return plan.items;
      if (plan.kind === 'skip') return null;
      const got = store.get('s1');   // 主进程 engineOwnSuggestions 的 native-claude 分支：只读 nativeSuggestions
      if (got.length) { uiCache.set(key, got); return got; }
      uiCache.delete(key);
      return null;
    };
    const push = (texts: string[]) => c.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cli', update: info(texts) } });
    return { store, uiCache, uiTried, showOnSwitchBack, push };
  }

  test('这一轮第一次问时还没有预测 → 切走 → 预测在后台到了 → 切回来：显示它（不被「问过了」挡住）', () => {
    const h = harness();
    assert.equal(h.showOnSwitchBack('s1:a1'), null, '第一次问：还没有 → 固定建议');
    h.uiTried.add('s1:a1');   // 就算界面记过「问过」，Claude Code 也不看它
    h.push(['写测试']);        // 这时这一格显示的是别的会话（推送被这一格忽略），但主进程存下了
    assert.deepEqual(h.showOnSwitchBack('s1:a1'), ['写测试']);
  });

  test('已有预测（界面也缓存了）→ 切走 → 后台收到空列表清掉 → 切回来：不再显示旧预测', () => {
    const h = harness();
    h.push(['旧的']);
    assert.deepEqual(h.showOnSwitchBack('s1:a1'), ['旧的']);
    assert.deepEqual(h.uiCache.get('s1:a1'), ['旧的']);
    h.push([]);
    assert.equal(h.showOnSwitchBack('s1:a1'), null, '固定建议，不是旧的那条');
    assert.equal(h.uiCache.has('s1:a1'), false, '本地缓存也清掉');
  });

  test('Codex 不受影响：缓存命中照用、这一轮试过就不再问（每轮只生成一次）；kiro 照旧走缓存', () => {
    assert.deepEqual(planSuggestionLookup({ engine: 'codex', cached: ['a'], tried: false }), { kind: 'use-cache', items: ['a'] });
    assert.deepEqual(planSuggestionLookup({ engine: 'codex', cached: undefined, tried: true }), { kind: 'skip' });
    assert.deepEqual(planSuggestionLookup({ engine: 'codex', cached: [], tried: false }), { kind: 'ask' });
    assert.deepEqual(planSuggestionLookup({ engine: 'kiro', cached: ['k'], tried: false }), { kind: 'use-cache', items: ['k'] });
    assert.deepEqual(planSuggestionLookup({ engine: 'claude', cached: ['c'], tried: true }), { kind: 'ask' });
  });

  test('接线：Claude Code 挂载 / 切回来不拿本地缓存当「已经问过」，也不先显示它；问回来是空就清掉本地缓存', () => {
    const C = read('src', 'renderer', 'components', 'ChatArea.tsx');
    assert.match(C, /const nativeEngine = engine === 'claude';/);
    assert.match(C, /useRef<string \| null>\(nativeEngine \? null : suggestionKey\(currentSessionId, messages\)\)/);
    assert.equal((C.match(/const cached = \(!nativeEngine && k && suggestionCache\.get\(k\)\) \|\| \[\];/g) || []).length, 2, '初始状态和切会话两处');
    assert.match(C, /suggestionsForRef\.current = cached\.length && !nativeEngine \? k : null;/);
    assert.match(C, /else if \(r\?\.source === 'native-claude'\) \{ suggestionCache\.delete\(key\); setDynamicSuggestions\(\{ key: null, items: \[\] \}\); return; \}/);
  });
});
