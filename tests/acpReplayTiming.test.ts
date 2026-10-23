import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpClient, setLocalKiroBin } from '../src/main/acp-client.ts';
import { isReplayOutsideTurn } from '../src/main/replayGuard.ts';

/*
  「远程新建会话界面仍出现历史会话内容」—— 线索①「远端 kiro-cli 回放了旧对话」到底能不能走到界面，
  用**真的 AcpClient**（真起子进程、真走 stdio 的 NDJSON 解析和请求/通知分发）对一个假的 ACP agent 测，
  按主进程的**实际顺序**接监听：`await client.newSession(cwd)` / `loadSession` 之后才 `wireSession`
  （index.ts 里每一处都是这个顺序，见最后一条源码扫描）。

  假 agent 吐的帧照 2026-10-20 在本机实测 kiro-cli 2.13.0 录下来的顺序（`scripts/acp-replay-probe.mjs`）：
  - session/new（同一 cwd、同一进程或新进程）：只有 `_kiro.dev/subagent/list_update` → 响应 → 命令表 / metadata，
    **没有任何对话正文**；
  - session/load 旧 id：`user_message_chunk` + `agent_message_chunk`（旧对话）**在响应之前**，然后响应、命令表。
  另加一种实测里**没出现**、但别的版本可能有的形状：session/new 响应**之后**才吐旧对话 —— 只有这种能走到界面。

  等待不靠固定 sleep：测试借 `client.steer()`（公开的裸写请求）给假 agent 递一个 `_session/steer` 暗号，
  假 agent 按序回一条 `_kiro.dev/test/pong`；stdout 是有序的，收到 pong 就说明它之前的帧都已分发完。
  「响应之后才回放」也由暗号触发（见 replay-after-new）：原来和响应同一拍写出，常和响应落在同一个 stdout 块里，
  AcpClient 同步解析完整块、`await newSession` 之后的代码才跑，回放就早于监听 —— 约 1/3 次挂。
*/

const FAKE_AGENT = String.raw`
const MODE = process.env.FAKE_ACP_MODE || 'kiro-2.13';
let buf = '';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const note = (sid, update) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update } });
const kiro = (method, params) => out({ jsonrpc: '2.0', method, params });
const OLD = 'old-cli-session';
const replay = (sid) => {
  note(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'OLD QUESTION from another chat' } });
  note(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD ANSWER from another chat' } });
};
let n = 0;
process.stdin.on('data', (d) => {
  buf += d.toString(); const lines = buf.split('\n'); buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    if (m.method === 'session/new') {
      const sid = 'new-cli-' + (++n);
      kiro('_kiro.dev/subagent/list_update', { subagents: [] });
      out({ jsonrpc: '2.0', id: m.id, result: { sessionId: sid } });
      kiro('_kiro.dev/commands/available', { sessionId: sid, commands: [{ name: 'help' }] });
    }
    /* 测试暗号（走 client.steer）：replay-after-new 下带 replay 的暗号 = 「响应之后、监听已接上」才吐旧对话；随后按序回 pong */
    if (m.method === '_session/steer') {
      if (MODE === 'replay-after-new' && m.params.message.includes('replay')) replay(OLD);
      kiro('_kiro.dev/test/pong', { token: m.params.message });
    }
    if (m.method === 'session/load') {
      kiro('_kiro.dev/subagent/list_update', { subagents: [] });
      replay(m.params.sessionId);
      out({ jsonrpc: '2.0', id: m.id, result: {} });
      kiro('_kiro.dev/commands/available', { sessionId: m.params.sessionId, commands: [{ name: 'help' }] });
    }
  }
});
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-replay-'));
/* AcpClient 起的是 `<bin> acp --model <m>`：bin = node，于是 node 跑当前目录下名为 acp 的脚本 */
fs.writeFileSync(path.join(dir, 'acp'), FAKE_AGENT);

async function startClient(mode: string): Promise<AcpClient> {
  setLocalKiroBin(process.execPath);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const client = new AcpClient('m', { ...process.env, FAKE_ACP_MODE: mode } as Record<string, string>);
    await client.connect();
    return client;
  } finally {
    process.chdir(cwd);
  }
}

/** 主进程的接法：先 await，后接监听；`guard` = 有没有 isReplayOutsideTurn 那道守卫（新会话还没开始任何一轮） */
function wire(client: AcpClient, guard: boolean) {
  const forwarded: string[] = [];
  client.on('update', (data: any) => {
    if (guard && isReplayOutsideTurn(data?.update, false)) return;
    const kind = data?.update?.sessionUpdate;
    if (kind === 'user_message_chunk' || kind === 'agent_message_chunk') forwarded.push(`${kind}:${data.update.content.text}`);
  });
  return forwarded;
}
/** 屏障：等假 agent 把这之前的帧都发完、AcpClient 都分发完（收到对应 pong），超时就挂 */
let pings = 0;
function barrier(client: AcpClient, what = 'ping', timeoutMs = 10000): Promise<void> {
  const token = `${what}-${++pings}`;
  return new Promise((resolve, reject) => {
    const onUpdate = (data: any) => {
      const u = data?.update;
      if (u?.method !== '_kiro.dev/test/pong' || !String(u.token).includes(token)) return;
      clearTimeout(timer); client.off('update', onUpdate); resolve();
    };
    const timer = setTimeout(() => { client.off('update', onUpdate); reject(new Error(`等不到 ${token} 的 pong`)); }, timeoutMs);
    client.on('update', onUpdate);
    if (!client.steer('test', token)) { clearTimeout(timer); client.off('update', onUpdate); reject(new Error('暗号写不出去')); }
  });
}

test('实测形状（kiro-cli 2.13）：session/new 不吐对话正文 —— 新建会话这条路上没有回放可转发（守卫开不开都一样）', async () => {
  const client = await startClient('kiro-2.13');
  try {
    for (const guard of [false, true]) {
      await client.newSession(dir);
      const forwarded = wire(client, guard);
      await barrier(client);
      assert.deepEqual(forwarded, []);
      client.removeAllListeners('update');
    }
  } finally { await client.disconnect(); }
});

test('实测形状（kiro-cli 2.13）：session/load 的回放在响应之前 —— 主进程在 await 之后才接监听，回放到不了界面', async () => {
  const client = await startClient('kiro-2.13');
  try {
    /* 先证明回放确实发生了：响应之前就接着听的话能收到 */
    const early = wire(client, false);
    await client.loadSession('old-cli-session', dir);
    await barrier(client);
    assert.equal(early.length, 2, '假 agent 确实回放了旧对话');
    client.removeAllListeners('update');
    /* 主进程的顺序：await loadSession → wireSession */
    await client.loadSession('old-cli-session', dir);
    const late = wire(client, false);
    await barrier(client);
    assert.deepEqual(late, []);
  } finally { await client.disconnect(); }
});

test('响应之后才回放（实测没出现、别的版本可能有）：没有守卫时旧对话被当成这条新会话的更新转发出去；有守卫就丢掉', async () => {
  const client = await startClient('replay-after-new');
  try {
    await client.newSession(dir);
    const unguarded = wire(client, false);
    await barrier(client, 'replay');
    assert.deepEqual(unguarded, [
      'user_message_chunk:OLD QUESTION from another chat',
      'agent_message_chunk:OLD ANSWER from another chat',
    ]);
    client.removeAllListeners('update');
    await client.newSession(dir);
    const guarded = wire(client, true);
    await barrier(client, 'replay');
    assert.deepEqual(guarded, []);
  } finally { await client.disconnect(); }
});

test('源码：index.ts 里每一处 wireSession 都在同一段里 await 过 newSession / loadSession 之后（监听从不早于响应）', () => {
  const M = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const lines = M.split('\n');
  const calls = lines.map((l, i) => (/^\s+wireSession\(/.test(l) ? i : -1)).filter((i) => i >= 0);
  assert.ok(calls.length >= 8, `只找到 ${calls.length} 处`);
  for (const i of calls) {
    const before = lines.slice(Math.max(0, i - 90), i).join('\n');
    assert.match(before, /await [^\n]*\.(newSession|loadSession)\(|await withLoadTimeout\([^\n]*\.(newSession|loadSession)\(|\.loadSession\(cliSessionId, cliCwd\)/, `index.ts:${i + 1}`);
  }
  /* 除了 wireSession 和 recreateBackendSession（同一 client 上的 session/new，实测不吐正文），没有别处在活着的 client 上 load ——
     唯一的例外是编辑重发的分叉（acp:fork-backend-for-edit）：load 之前先挂上 dropReplayUntilTurn，回放在下一轮开始前一律丢掉 */
  const liveLoads = [...M.matchAll(/entry\.client\.loadSession\(/g)].map((m) => m.index!);
  assert.equal(liveLoads.length, 1, '只有分叉那一处');
  const forkAt = M.indexOf("ipcMain.handle('acp:fork-backend-for-edit'");
  assert.ok(forkAt > 0 && liveLoads[0] > forkAt && liveLoads[0] - forkAt < 6000, '在分叉的 handler 里');
  assert.ok(M.lastIndexOf('entry.dropReplayUntilTurn = true;', liveLoads[0]) > forkAt, 'load 之前先挂上丢回放的标记');
  assert.match(M, /if \(entry\.dropReplayUntilTurn\) \{\n\s+if \(!entry\.busy\) return;/, 'wireSession 真的按它丢');
});
