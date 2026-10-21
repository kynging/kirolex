/**
 * kiro-cli 的 session/new / session/load 会不会吐出旧对话、吐在响应之前还是之后 —— 实测，不靠读代码。
 *
 * 为什么要这个：「远程新建会话界面出现别的会话的历史」，怀疑过远端 kiro-cli 在新建时回放了旧对话。
 * KiroLex 主进程在 await session/new / session/load 的响应**之后**才接监听（wireSession），所以只有
 * 「响应之后才吐的对话正文」会走到界面（tests/acpReplayTiming.test.ts）。2026-10-20 本机 kiro-cli 2.13.0：
 * session/new（同 cwd、同 / 新进程）不吐任何正文；session/load 旧 id 的回放全在响应之前。
 *
 * 在远端那台上跑（会花一轮很小的额度）：
 *   KIRO_CLI_PATH=~/.local/bin/kiro-cli PROBE_MODEL=claude-sonnet-5 node scripts/acp-replay-probe.mjs /tmp/replay.log
 * 最后的 summary 按请求列出「响应之前 / 之后」各收到几块对话正文；请求报错会直接失败退出（加载失败不能被当成没有回放）。
 * 执行器按 AGENTS.md §4.1 正常收摊（关 stdin 等它自己退出），5 秒不退才强杀并在 summary 里注明。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG = process.argv[2] || path.join(os.tmpdir(), 'probe-replay.log');
fs.writeFileSync(LOG, '');
const t0 = Date.now();
const log = (s) => { const l = `[${String(Date.now() - t0).padStart(6)}ms] ${s}`; fs.appendFileSync(LOG, l + '\n'); console.log(l); };

/** 每次请求：发出之后、响应之前 / 响应之后各收到几块对话正文 —— 这就是要回答的问题 */
const tally = [];
let open = null;   // 正在等响应的那个请求
let last = null;   // 最近一个已经响应的请求（之后到的正文记在它的「之后」）

function start(tag) {
  const proc = spawn(process.env.KIRO_CLI_PATH || 'kiro-cli', ['acp', '--model', process.env.PROBE_MODEL || 'claude-sonnet-5'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    /* Windows 上裸名字 kiro-cli 要靠 shell 找到 .exe；给了路径就不经 shell */
    shell: process.platform === 'win32' && !process.env.KIRO_CLI_PATH,
  });
  let buf = ''; let id = 0; const pending = new Map();
  const exited = new Promise((r) => proc.once('exit', (code, signal) => r({ code, signal })));
  proc.stdout.on('data', (d) => {
    buf += d.toString(); const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; }
      if ('id' in m && ('result' in m || 'error' in m)) {
        log(`${tag} <- RESPONSE id=${m.id} ${m.error ? 'ERROR ' + JSON.stringify(m.error).slice(0, 200) : JSON.stringify(m.result).slice(0, 120)}`);
        const p = pending.get(m.id); pending.delete(m.id);
        if (open && open.tag === tag && open.id === m.id) { last = open; open = null; }
        p?.(m); continue;
      }
      if (m.method === 'session/request_permission') {
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: m.params.options[0].optionId } } }) + '\n');
        continue;
      }
      const u = m.params?.update; const kind = u?.sessionUpdate || m.method;
      const text = u?.content?.text ? JSON.stringify(u.content.text).slice(0, 60) : '';
      if (kind === 'user_message_chunk' || kind === 'agent_message_chunk') {
        if (open?.tag === tag) open.before++; else if (last?.tag === tag) last.after++;
      }
      log(`${tag} <- notify ${kind} sid=${m.params?.sessionId || '-'} ${text}`);
    }
  });
  proc.stderr.on('data', () => {});
  /** 发请求；后端回 error 就抛 —— 加载失败不能被当成「没有回放」 */
  const req = (method, params) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? rej(new Error(`${tag} ${method} failed: ${JSON.stringify(m.error).slice(0, 300)}`)) : res(m.result)));
    open = { tag, id: i, method, before: 0, after: 0 };
    tally.push(open);
    log(`${tag} -> ${method}`);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
  /**
   * 正常收摊：关 stdin，让 kiro-cli 自己退出 —— 它只有正常退出才释放会话锁（AGENTS.md §4.1），强杀会留下
   * 陈旧的锁，之后对同一个 id 的 session/load 量出来的就不算数。5 秒还没退才强杀，并且返回 false 让 summary 注明。
   */
  const stop = async () => {
    proc.stdin.end();
    const done = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 5000))]);
    if (done) { log(`${tag} exited cleanly code=${done.code}`); return true; }
    log(`${tag} did NOT exit within 5s after stdin closed -> killing`);
    proc.kill();
    await exited;
    return false;
  };
  return { req, stop };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cwd-'));
const procs = [];
try {
  const A = start('A'); procs.push(A);
  await A.req('initialize', { protocolVersion: 1, clientInfo: { name: 'probe', version: '0' }, capabilities: {} });
  const s1 = (await A.req('session/new', { cwd, mcpServers: [] })).sessionId;
  await A.req('session/prompt', { sessionId: s1, prompt: [{ type: 'text', text: 'Reply with exactly: PROBE-OLD-REPLY' }] });
  await pause(1500);
  log('--- A: second session/new in same process + same cwd');
  await A.req('session/new', { cwd, mcpServers: [] });
  await pause(4000);
  procs.length = 0;
  const cleanA = await A.stop();

  log('--- B: fresh process, session/new in the same cwd');
  const B = start('B'); procs.push(B);
  await B.req('initialize', { protocolVersion: 1, clientInfo: { name: 'probe', version: '0' }, capabilities: {} });
  await B.req('session/new', { cwd, mcpServers: [] });
  await pause(4000);
  log('--- B: session/load of the old id');
  await B.req('session/load', { sessionId: s1, cwd, mcpServers: [] });
  await pause(5000);
  procs.length = 0;
  await B.stop();

  log('=== summary: message chunks (user/agent) per request, before vs after its response');
  for (const t of tally) if (t.method !== 'initialize') log(`  ${t.tag} ${t.method.padEnd(14)} before=${t.before} after=${t.after}`);
  if (!cleanA) log('  (A had to be force-killed: the session/load numbers above may be affected by a stale lock)');
  process.exit(0);
} catch (err) {
  log(`PROBE FAILED: ${err?.message || err}`);
  for (const p of procs) await p.stop();
  process.exit(1);
}
