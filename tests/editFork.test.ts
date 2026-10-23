/**
 * 审计 10：编辑重发时 Claude Code 的后端也要「忘掉」被编辑之后的内容（`src/main/editFork.ts`）。
 *   · 纯判据：fork / fresh / fallback 三条路；
 *   · 真 AcpClient 对一个假的 Claude 适配器：`session/fork` 真的带上了分叉点，initialize 的能力被记下；
 *   · 接线：渲染层在截短 transcript **之前**请主进程分叉；整份重写 transcript 时锚点不丢。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planEditFork, supportsForkPoint, forkPointMeta, carryBackendAnchors, mainlineAcpMessageId, wantsEditFork, remapAnchorsToFork } from '../src/main/editFork.ts';
import { AcpClient } from '../src/main/acp-client.ts';

const T = [
  { id: 'u1', role: 'user' },
  { id: 'a1', role: 'assistant', acpMessageId: 'msg_1', acpSessionId: 'cli-A' },
  { id: 'n1', role: 'assistant', kirolex: true },
  { id: 'u2', role: 'user' },
  { id: 'a2', role: 'assistant', acpMessageId: 'msg_2', acpSessionId: 'cli-A' },
  { id: 'u3', role: 'user' },
];

describe('planEditFork：走与不走', () => {
  const base = { engine: 'claude' as const, forkPoint: true, cliSessionId: 'cli-A', transcript: T };
  test('编辑第 3 条：从保留部分最后一条回复（a2）分叉', () => {
    assert.deepEqual(planEditFork({ ...base, keepIds: ['u1', 'a1', 'n1', 'u2', 'a2'] }), { mode: 'fork', messageId: 'msg_2' });
  });
  test('编辑第 2 条：分叉点是 a1（KiroLex 自己的提示 n1 不算回复）', () => {
    assert.deepEqual(planEditFork({ ...base, keepIds: ['u1', 'a1', 'n1'] }), { mode: 'fork', messageId: 'msg_1' });
  });
  test('编辑第 1 条：保留部分没有回复 → 换新的后端会话（Codex 也行）', () => {
    assert.deepEqual(planEditFork({ ...base, keepIds: [] }), { mode: 'fresh' });
    assert.deepEqual(planEditFork({ ...base, engine: 'codex', forkPoint: false, keepIds: ['n1'] }), { mode: 'fresh' });
  });
  test('适配器不支持带点分叉（Codex / 没声明 fork）→ 退回原做法', () => {
    assert.deepEqual(planEditFork({ ...base, forkPoint: false, keepIds: ['u1', 'a1'] }), { mode: 'fallback', reason: 'unsupported' });
  });
  test('老记录没锚点 / 锚点属于别的后端会话 → 退回原做法', () => {
    assert.deepEqual(planEditFork({ ...base, transcript: [{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }], keepIds: ['u1', 'a1'] }), { mode: 'fallback', reason: 'no-anchor' });
    assert.deepEqual(planEditFork({ ...base, cliSessionId: 'cli-B', keepIds: ['u1', 'a1'] }), { mode: 'fallback', reason: 'other-backend' });
  });
  test('分不了、而且当前后端没握着历史（实测：重启后 resume 失败换了新后端）→ snapshot：下一条带截短后的快照，不提示「仍记得」', () => {
    assert.deepEqual(planEditFork({ ...base, cliSessionId: 'cli-NEW', contextHeld: false, keepIds: ['u1', 'a1'] }), { mode: 'snapshot', reason: 'other-backend' });
    assert.deepEqual(planEditFork({ ...base, forkPoint: false, contextHeld: false, keepIds: ['u1', 'a1'] }), { mode: 'snapshot', reason: 'unsupported' });
    /* 握着历史（或不知道）照样走 fallback 并提示 */
    assert.deepEqual(planEditFork({ ...base, cliSessionId: 'cli-NEW', contextHeld: true, keepIds: ['u1', 'a1'] }), { mode: 'fallback', reason: 'other-backend' });
    /* 能分叉时不看这个：分叉就是让后端忘掉 */
    assert.deepEqual(planEditFork({ ...base, contextHeld: false, keepIds: ['u1', 'a1'] }), { mode: 'fork', messageId: 'msg_1' });
  });
  test('kiro：不走这条（none）', () => {
    assert.deepEqual(planEditFork({ ...base, engine: 'kiro', keepIds: ['u1', 'a1'] }), { mode: 'none' });
    assert.equal(wantsEditFork('kiro'), false);
    assert.equal(wantsEditFork(undefined), false);
    assert.equal(wantsEditFork('claude'), true);
    assert.equal(wantsEditFork('codex'), true);
  });
  test('只有 Claude Code + 声明了 sessionCapabilities.fork 才算能带点分叉', () => {
    assert.equal(supportsForkPoint('claude', { sessionCapabilities: { fork: {} } }), true);
    assert.equal(supportsForkPoint('claude', { sessionCapabilities: {} }), false);
    assert.equal(supportsForkPoint('claude', undefined), false);
    assert.equal(supportsForkPoint('codex', { sessionCapabilities: { fork: {} } }), false, '标准 fork 没有分叉点 = 整份复制');
  });
  test('分叉点的写法是适配器认的那种', () => {
    assert.deepEqual(forkPointMeta('msg_2'), { jetbrains: { air: { fork: { version: 1, messageId: 'msg_2' } } } });
  });
});

describe('锚点：记哪个、整份重写时不丢', () => {
  test('主线的正文 / 思考块带 messageId；子代理里的不算', () => {
    assert.equal(mainlineAcpMessageId({ sessionUpdate: 'agent_message_chunk', messageId: 'm1' }), 'm1');
    assert.equal(mainlineAcpMessageId({ sessionUpdate: 'agent_thought_chunk', messageId: 'm2' }), 'm2');
    assert.equal(mainlineAcpMessageId({ sessionUpdate: 'agent_message_chunk', messageId: 'm3', _meta: { claudeCode: { parentToolUseId: 'p' } } }), undefined);
    assert.equal(mainlineAcpMessageId({ sessionUpdate: 'tool_call', messageId: 'm4' }), undefined);
    assert.equal(mainlineAcpMessageId({ sessionUpdate: 'agent_message_chunk' }), undefined);
  });
  test('carryBackendAnchors：渲染层那份不带锚点，按盘上的补回去；已经带了的不改', () => {
    const raw = [
      JSON.stringify({ id: 'a1', role: 'assistant', content: 'x', acpMessageId: 'msg_1', acpSessionId: 'cli-A' }),
      JSON.stringify({ id: 'u1', role: 'user', content: 'q' }),
      '{"torn',
    ].join('\n');
    const out = carryBackendAnchors(raw, [{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }, { id: 'a9', role: 'assistant', acpMessageId: 'keep' }]);
    assert.deepEqual(out, [{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant', acpMessageId: 'msg_1', acpSessionId: 'cli-A' }, { id: 'a9', role: 'assistant', acpMessageId: 'keep' }]);
    assert.deepEqual(carryBackendAnchors('', [{ id: 'a1', role: 'assistant' }]), [{ id: 'a1', role: 'assistant' }]);
  });
});

describe('真 AcpClient + 假的 Claude 适配器：session/fork 的线上形状', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-editfork-'));
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上进程刚退时可能还占着 */ } });
  const agent = (withFork: boolean) => {
    const file = path.join(dir, `fake-claude-${withFork ? 'fork' : 'nofork'}.js`);
    fs.writeFileSync(file, String.raw`
let buf = '';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
process.stdin.on('data', (d) => {
  buf += d.toString(); const lines = buf.split('\n'); buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: ${withFork ? '{ fork: {} }' : '{}'} } } });
    else if (m.method === 'session/fork') out({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'forked-1', _echo: m.params } });
    else if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
process.stdin.on('end', () => process.exit(0));
`);
    return file;
  };
  const start = async (file: string) => {
    const client = new AcpClient('default', { ...process.env, KIROLEX_CLAUDE_ACP: file } as Record<string, string>, undefined, 'ask', undefined, undefined, 'claude');
    await client.connect();
    return client;
  };
  test('声明了 fork：记下能力；forkSession 把分叉点放进 _meta，返回新 id', async () => {
    const client = await start(agent(true));
    try {
      assert.equal(supportsForkPoint('claude', client.agentCapabilities), true);
      const r: any = await client.forkSession('cli-A', dir, forkPointMeta('msg_2'));
      assert.equal(r.sessionId, 'forked-1');
      assert.equal(r._echo.sessionId, 'cli-A');
      assert.equal(r._echo.cwd, dir);
      assert.deepEqual(r._echo._meta, { jetbrains: { air: { fork: { version: 1, messageId: 'msg_2' } } } });
      assert.ok(Array.isArray(r._echo.mcpServers));
    } finally { await client.disconnect(); }
  });
  test('没声明 fork：判据说不分叉（退回原做法那条路）', async () => {
    const client = await start(agent(false));
    try {
      assert.equal(supportsForkPoint('claude', client.agentCapabilities), false);
    } finally { await client.disconnect(); }
  });
});

describe('接线（源码扫描）', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
  test('渲染层：编辑重发在 rewriteTranscript 之前请主进程分叉；自动重发 / kiro 不分叉', () => {
    const A = read('renderer', 'hooks', 'useAcp.ts');
    const r = A.slice(A.indexOf('const rerunFromMessage = useCallback('), A.indexOf('const rerunFromMessage = useCallback(') + 9000);
    const fork = r.indexOf('window.kiroApi.forkBackendForEdit?.(sid, storedRetained.map((m) => m.id))');
    assert.ok(fork > 0);
    assert.ok(fork < r.indexOf('await window.kiroApi.rewriteTranscript(sid, storedRetained);'), '必须在截短之前（主进程按没截短的记录找分叉点）');
    assert.match(r, /if \(!override\?\.carryMark && wantsEditFork\(sessionsRef\.current\.find\(\(s\) => s\.id === sid\)\?\.engine\)\)/);
  });
  test('主进程：fork → load → 换 cliSessionId、写记录、标上下文已建立、设回模型；fresh 换新后端；其余说一句', () => {
    const M = read('main', 'index.ts');
    const h = M.slice(M.indexOf("ipcMain.handle('acp:fork-backend-for-edit'"), M.indexOf("ipcMain.handle('acp:fork-backend-for-edit'") + 6000);
    assert.match(h, /if \(!sid \|\| !rec \|\| engine === 'kiro'\) return \{ mode: 'none' \};/);
    assert.match(h, /forkPoint: supportsForkPoint\(engine, entry\.client\.agentCapabilities\)/);
    /* 当前后端没握着历史：不提示，直接返回（下一条带截短后的快照） */
    assert.match(h, /contextHeld: contextEstablished\(sid, entry\),/);
    assert.match(h, /if \(plan\.mode === 'snapshot'\) \{\n\s+logger\.info\('edit-fork', `snapshot sessionId=/);
    assert.ok(h.indexOf("if (plan.mode === 'snapshot')") < h.indexOf("if (plan.mode === 'fallback')"), 'snapshot 在提示之前就返回');
    const order = ['entry.client.forkSession(oldId, entry.cwd, forkPointMeta(plan.messageId))', 'entry.dropReplayUntilTurn = true;', 'entry.client.loadSession(forked.sessionId, entry.cwd)', 'entry.cliSessionId = forked.sessionId;', 'rec2.cliSessionId = forked.sessionId;', 'markContextEstablished(sid, entry);', 'applyEngineModel(sid, entry)'];
    let at = -1;
    for (const s of order) { const i = h.indexOf(s); assert.ok(i > at, `顺序：${s}`); at = i; }
    assert.match(h, /swapBackendSessionWhenIdle\(sid, 'edit-rerun'\)/);
    assert.match(h, /still remembers the part you edited away/);
  });
  test('主进程：锚点随助手消息落盘；fork 之后 load 回放在下一轮之前一律丢掉', () => {
    const M = read('main', 'index.ts');
    assert.match(M, /\.\.\.\(entry\.lastAcpMessageId \? \{ acpMessageId: entry\.lastAcpMessageId, acpSessionId: entry\.cliSessionId \} : \{\}\),/);
    assert.match(M, /if \(entry\.dropReplayUntilTurn\) \{\n\s+if \(!entry\.busy\) return;\n\s+entry\.dropReplayUntilTurn = false;\n\s+\}/);
    assert.match(M, /const mid = engineOf\(entry\.profile\) !== 'kiro' \? mainlineAcpMessageId\(u\) : undefined;/);
    const S = read('main', 'sessionStore.ts');
    assert.match(S, /const kept = carryBackendAnchors\(onDisk, carryReplyMarks\(onDisk, messages\)\);/);
    const C = read('main', 'acp-client.ts');
    assert.match(C, /this\.agentCapabilities = result\?\.agentCapabilities;/);
    assert.match(read('main', 'preload.ts'), /forkBackendForEdit: \(sessionId: string, keepIds: string\[\]\) => ipcRenderer\.invoke\('acp:fork-backend-for-edit', sessionId, keepIds\)/);
  });
});

describe('审查意见：连着两次编辑同一条消息，第二次也要分叉（锚点跟着改到新后端）', () => {
  test('remapAnchorsToFork：只改保留下来的、属于旧后端的助手消息', () => {
    const raw = [
      JSON.stringify({ id: 'u1', role: 'user', content: 'APPLE' }),
      JSON.stringify({ id: 'a1', role: 'assistant', acpMessageId: 'msg_1', acpSessionId: 'cli-A' }),
      JSON.stringify({ id: 'a0', role: 'assistant', acpMessageId: 'msg_0', acpSessionId: 'cli-OLDER' }),
      JSON.stringify({ id: 'u2', role: 'user', content: 'BANANA' }),
      JSON.stringify({ id: 'a2', role: 'assistant', acpMessageId: 'msg_2', acpSessionId: 'cli-A' }),
      '{"torn',
    ].join('\n');
    const r = remapAnchorsToFork(raw, ['u1', 'a1', 'a0'], 'cli-A', 'cli-F');
    assert.equal(r.changed, 1);
    const lines = r.text.split('\n');
    assert.equal(JSON.parse(lines[1]).acpSessionId, 'cli-F', '保留的那条改到新后端');
    assert.equal(JSON.parse(lines[1]).acpMessageId, 'msg_1', 'messageId 不变（分叉是拷贝）');
    assert.equal(JSON.parse(lines[2]).acpSessionId, 'cli-OLDER', '别的后端来的不动');
    assert.equal(JSON.parse(lines[4]).acpSessionId, 'cli-A', '不保留的不动（反正会被截掉）');
    assert.equal(lines[5], '{"torn', '解析不了的行原样留');
    assert.deepEqual(remapAnchorsToFork(raw, ['a1'], 'cli-A', 'cli-A'), { text: raw, changed: 0 });
  });

  test('完整走两遍：第一次分叉 → 锚点改到新后端 → 整份重写（带回锚点）→ 第二次编辑同一条还是 fork，不退回', () => {
    /* 盘上：u1 → a1(cli-A) → u2 → a2(cli-A)；当前后端 cli-A */
    let disk = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant', acpMessageId: 'msg_1', acpSessionId: 'cli-A' },
      { id: 'u2', role: 'user' },
      { id: 'a2', role: 'assistant', acpMessageId: 'msg_2', acpSessionId: 'cli-A' },
    ];
    const keep = ['u1', 'a1'];
    /* 第一次编辑 u2 */
    const p1 = planEditFork({ engine: 'claude', forkPoint: true, cliSessionId: 'cli-A', transcript: disk, keepIds: keep, contextHeld: true });
    assert.deepEqual(p1, { mode: 'fork', messageId: 'msg_1' });
    /* 主进程：fork 成功 → cliSessionId 换成 cli-F，锚点跟着改 */
    const remapped = remapAnchorsToFork(disk.map((m) => JSON.stringify(m)).join('\n'), keep, 'cli-A', 'cli-F');
    disk = remapped.text.split('\n').map((l) => JSON.parse(l));
    /* 渲染层整份重写：传的消息不带锚点，按盘上的补回去；再加上新的 u2' → a2'(cli-F) */
    const rewritten = carryBackendAnchors(disk.map((m) => JSON.stringify(m)).join('\n'), [{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }] as any[]);
    disk = [...rewritten, { id: 'u2b', role: 'user' }, { id: 'a2b', role: 'assistant', acpMessageId: 'msg_2b', acpSessionId: 'cli-F' }];
    assert.equal((disk[1] as any).acpSessionId, 'cli-F', '重写之后锚点是新后端的');
    /* 第二次编辑同一条（现在是 u2b） */
    const p2 = planEditFork({ engine: 'claude', forkPoint: true, cliSessionId: 'cli-F', transcript: disk as any, keepIds: ['u1', 'a1'], contextHeld: true });
    assert.deepEqual(p2, { mode: 'fork', messageId: 'msg_1' }, '原来这里是 { mode: fallback, reason: other-backend }');
  });

  test('接线：分叉成功后主进程改锚点（在返回之前，渲染层随后的 rewriteTranscript 会按盘上的带回去）', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const h = M.slice(M.indexOf("ipcMain.handle('acp:fork-backend-for-edit'"), M.indexOf("ipcMain.handle('acp:fork-backend-for-edit'") + 7000);
    const write = h.indexOf('rec2.cliSessionId = forked.sessionId;');
    const remap = h.indexOf('store.remapBackendAnchors(sid, Array.isArray(keepIds) ? keepIds.map(String) : [], oldId, forked.sessionId)');
    assert.ok(write > 0 && remap > write, '换了后端 id 之后改锚点');
    assert.ok(remap < h.indexOf("return { mode: 'fork', newId: forked.sessionId };"));
    const S = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'sessionStore.ts'), 'utf8');
    assert.match(S, /export function remapBackendAnchors\(id: string, keepIds: Iterable<string>, oldId: string, newId: string\): number \{/);
    assert.match(S, /const r = remapAnchorsToFork\(raw, keepIds, oldId, newId\);[\s\S]{0,120}fs\.renameSync\(tmp, file\);/);
  });
});
