/**
 * CAN ONE `kiro-cli acp` PROCESS CARRY SEVERAL KIROLEX SESSIONS? — the gate before "复用".
 *
 * docs/DESIGN_remote_sessions.md「一个 kiro-cli 进程带多条会话（复用）」: sharing one remote executor
 * between sessions is only safe if, inside ONE process, sessions do not disturb each other on the
 * things KiroLex does to a single session — session/load, switching model, cancelling a turn,
 * releasing it. This probe runs those against whatever command you give it (local kiro-cli, or
 * `ssh <host> kiro-cli acp` for the real remote) and prints PASS / FAIL / SKIP per check.
 *
 * Usage:
 *   node scripts/kiro-multisession-probe.mjs [--mcp-port 39555] [--turns] -- <command…>
 *
 *   node scripts/kiro-multisession-probe.mjs -- kiro-cli acp
 *   node scripts/kiro-multisession-probe.mjs --turns --mcp-port 39555 -- \
 *     ssh -R 127.0.0.1:39555:127.0.0.1:39555 tokyo 'kiro-cli acp'
 *
 *   --mcp-port  start a tiny HTTP MCP server on that port and give each session its OWN path via
 *               session/new `mcpServers` (for ssh, forward the same port with -R as above).
 *   --turns     also run real turns (cancel A while B runs; terminate A while B runs; a turn after
 *               a model switch). NEEDS `kiro-cli login` on that machine and SPENDS CREDITS.
 *
 * A second process with the same command is started for the cross-process lock check.
 *
 * With ssh, give the remote command as ONE quoted last argument (`… <host> 'kiro-cli acp'`): the probe
 * wraps it so the remote kiro-cli reports its PID (and carries `KIROLEX_EXECUTOR=kirolex-probe`), and on
 * exit — also on Ctrl-C — it terminates every session it holds, closes stdin, waits for a clean exit,
 * and then kills that remote tree over a second ssh. Killing the local ssh alone would leave the remote
 * kiro-cli holding its session locks (see docs/DESIGN_remote_sessions.md「远端那台机器需要什么」).
 */
import { spawn } from 'node:child_process';
import http from 'node:http';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opts = sep >= 0 ? argv.slice(0, sep) : [];
const cmd = sep >= 0 ? argv.slice(sep + 1) : ['kiro-cli', 'acp'];
const mcpPort = opts.includes('--mcp-port') ? Number(opts[opts.indexOf('--mcp-port') + 1]) : 0;
const turns = opts.includes('--turns');
const viaSsh = cmd[0] === 'ssh';
const CWD = process.env.PROBE_CWD || (viaSsh ? '/tmp' : process.cwd());
const PID_MARKER = 'KIROLEX_PROBE_PID';
const sq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
/* 远端那条命令包一层：先报 PID 再 exec（exec 之后 PID 不变），带上标记，方便认出是谁起的 */
const launchArgs = viaSsh
  ? [...cmd.slice(1, -1), `bash -lc ${sq(`echo "${PID_MARKER} $$" >&2; export KIROLEX_EXECUTOR=kirolex-probe; exec ${cmd[cmd.length - 1]}`)}`]
  : cmd.slice(1);
/* 收尾那条 ssh：同样的选项、同一台机器，但不带 -R / -L（端口还被第一条占着） */
const sshCleanupArgs = () => {
  const out = [];
  const opts = cmd.slice(1, -1);
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '-R' || opts[i] === '-L') { i++; continue; }
    out.push(opts[i]);
  }
  return out;
};
const remoteKillTree = (pid) => [
  `for g in $(pgrep -P ${pid} 2>/dev/null); do`,
  `  for gg in $(pgrep -P $g 2>/dev/null); do kill -TERM $gg 2>/dev/null || true; done;`,
  `  kill -TERM $g 2>/dev/null || true;`,
  `done;`,
  `kill -TERM ${pid} 2>/dev/null || true`,
].join(' ');

const results = [];
const report = (name, verdict, detail = '') => {
  results.push({ name, verdict, detail });
  console.log(`${verdict.padEnd(4)} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (o) => JSON.stringify(o, (k, v) => (Array.isArray(v) && /available/.test(k) ? `[${v.length}]` : v)).slice(0, 300);

function startClient(label) {
  const p = spawn(cmd[0], launchArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const self = { label, p, remotePid: undefined, held: new Set(), closed: false };
  p.on('close', () => { self.closed = true; });
  let id = 0;
  let buf = '';
  const pend = new Map();
  const notes = [];
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && !m.method && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); continue; }
      if (m.method === 'session/request_permission') {
        const allow = (m.params?.options || []).find((o) => /allow/.test(o.kind || '')) || m.params?.options?.[0];
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } } }) + '\n');
      }
      if (m.method) notes.push({ at: Date.now(), ...m });
    }
  });
  p.stderr.on('data', (d) => {
    const m = new RegExp(`${PID_MARKER} (\\d+)`).exec(String(d));
    if (m) self.remotePid = Number(m[1]);
  });
  const rpc = (method, params, ms = 60_000) => new Promise((resolve) => {
    if (self.closed) { resolve({ closed: true }); return; }
    const n = ++id;
    const t = setTimeout(() => { pend.delete(n); resolve({ timeout: true }); }, ms);
    pend.set(n, (m) => {
      clearTimeout(t);
      /* 记下这个进程手上拿着哪些会话：收尾时逐条 terminate，别把锁留在那儿 */
      if (m.result && method === 'session/new' && m.result.sessionId) self.held.add(m.result.sessionId);
      if (m.result && method === 'session/load') self.held.add(params.sessionId);
      if (m.result && method === '_kiro.dev/session/terminate') self.held.delete(params.sessionId);
      resolve(m);
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return Object.assign(self, { rpc, notify, notes });
}

/* 每条会话一个路径：kiro-cli 去连哪个、调哪个，就记在哪个下面 */
const hits = [];
let server;
if (mcpPort) {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let m;
      try { m = JSON.parse(body); } catch { /* GET / 探活 */ }
      hits.push({ path: req.url, method: m?.method || req.method });
      res.setHeader('content-type', 'application/json');
      if (!m || m.id == null) { res.statusCode = 202; res.end(); return; }
      const tag = String(req.url).split('/').pop();
      const result = m.method === 'initialize'
        ? { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `probe-${tag}`, version: '1' } }
        : m.method === 'tools/list'
          ? { tools: [{ name: `whoami_${tag}`, description: `Returns ${tag}`, inputSchema: { type: 'object', properties: {} } }] }
          : m.method === 'tools/call' ? { content: [{ type: 'text', text: `you are session ${tag}` }] } : {};
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  await new Promise((r) => server.listen(mcpPort, '127.0.0.1', r));
}
const mcpFor = (tag) => (mcpPort ? [{ type: 'http', name: 'probe', url: `http://127.0.0.1:${mcpPort}/mcp/${tag}`, headers: [] }] : []);

/**
 * 收尾：每条会话 terminate → 关 stdin 等它自己退（kiro-cli 正常退出才放锁）→ 超时才强杀 →
 * 远端再按它报的 PID 把整棵树收掉，**等这一步做完**才退出。
 */
async function shutdown(c) {
  if (!c.closed) {
    for (const sid of [...c.held]) await c.rpc('_kiro.dev/session/terminate', { sessionId: sid }, 15_000);
    const exited = new Promise((r) => (c.closed ? r() : c.p.once('close', r)));
    try { c.p.stdin.end(); } catch { /* already closed */ }
    const clean = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]);
    if (!clean) { try { c.p.kill(); } catch { /* gone */ } await Promise.race([exited, sleep(3000)]); }
  }
  if (viaSsh && c.remotePid) {
    const r = await new Promise((resolve) => {
      const k = spawn('ssh', [...sshCleanupArgs(), remoteKillTree(c.remotePid)], { stdio: 'ignore', windowsHide: true });
      const t = setTimeout(() => { try { k.kill(); } catch { /* gone */ } resolve('timeout'); }, 20_000);
      k.on('close', (code) => { clearTimeout(t); resolve(code); });
      k.on('error', () => { clearTimeout(t); resolve('error'); });
    });
    console.log(`cleanup ${c.label}: remote pid ${c.remotePid} kill → ${r === 0 ? 'ok' : r}`);
  } else if (viaSsh) console.log(`cleanup ${c.label}: remote pid never reported — check the host for a stray kiro-cli (env KIROLEX_EXECUTOR=kirolex-probe)`);
}

const X = startClient('X');
const Y = startClient('Y');
let shuttingDown;
const shutdownAll = () => (shuttingDown ||= Promise.all([shutdown(X), shutdown(Y)]).then(() => server?.close()));
process.on('SIGINT', () => { console.log('interrupted — cleaning up'); shutdownAll().then(() => process.exit(130)); });
try {
  const init = await X.rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'kirolex-probe', version: '0' } });
  if (!init.result) throw new Error(`initialize failed: ${short(init)}`);
  console.log(`kiro-cli ${init.result.agentInfo?.version || '?'}  loadSession=${init.result.agentCapabilities?.loadSession} mcp.http=${init.result.agentCapabilities?.mcpCapabilities?.http}`);
  await Y.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });

  /* 1. 一个进程，两条会话 */
  const a = await X.rpc('session/new', { cwd: CWD, mcpServers: mcpFor('A') });
  const b = await X.rpc('session/new', { cwd: CWD, mcpServers: mcpFor('B') });
  const A = a.result?.sessionId;
  const B = b.result?.sessionId;
  report('two session/new in one process', A && B && A !== B ? 'PASS' : 'FAIL', `${A} / ${B}`);
  const models = (a.result?.models?.availableModels || []).map((m) => m.modelId);

  /* 2. 每条会话自己的 MCP（共用进程时 kirolex-local 的 token 只能走这条路） */
  if (mcpPort) {
    await sleep(8000);
    const pa = new Set(hits.filter((h) => h.path.endsWith('/A')).map((h) => h.method));
    const pb = new Set(hits.filter((h) => h.path.endsWith('/B')).map((h) => h.method));
    report('per-session MCP from session/new', pa.has('tools/list') && pb.has('tools/list') ? 'PASS' : 'FAIL', `A:${[...pa]} B:${[...pb]}`);
  } else report('per-session MCP from session/new', 'SKIP', 'no --mcp-port');

  /* 3. 切模型：A 换，B 不该跟着换（只能看回包；真看效果要 --turns） */
  const other = models.find((m) => m !== a.result?.models?.currentModelId);
  if (other) {
    const r = await X.rpc('session/set_model', { sessionId: A, modelId: other });
    report('session/set_model on A', r.result ? 'PASS' : 'FAIL', `${other} ${short(r.error || r.result)}`);
    const bogus = await X.rpc('session/set_model', { sessionId: A, modelId: 'no-such-model-kirolex-probe' });
    report('set_model with an unknown model is rejected', bogus.error ? 'PASS' : 'WARN', bogus.error ? short(bogus.error) : 'accepted silently (KiroLex must validate the id itself)');
  } else report('session/set_model on A', 'SKIP', 'only one model listed');

  /* 4. 同进程里重新 load 一条正在用的会话 */
  const la = await X.rpc('session/load', { sessionId: A, cwd: CWD, mcpServers: mcpFor('A') });
  report('session/load A again in the same process', la.result ? 'PASS' : 'FAIL', short(la.error || la.result?.models?.currentModelId));

  /* 5. 跨进程锁：X 拿着 A 时 Y 应该 load 不了；X terminate A 之后 Y 就能 load，而 X 上的 B 不受影响 */
  const yBefore = await Y.rpc('session/load', { sessionId: A, cwd: CWD, mcpServers: [] });
  report('another process cannot load A while X holds it', yBefore.error ? 'PASS' : 'FAIL', short(yBefore.error || 'loaded'));
  const term = await X.rpc('_kiro.dev/session/terminate', { sessionId: A });
  report('_kiro.dev/session/terminate A', term.result ? 'PASS' : 'FAIL', short(term.error || term.result));
  const yAfter = await Y.rpc('session/load', { sessionId: A, cwd: CWD, mcpServers: [] });
  report('another process can load A after terminate', yAfter.result ? 'PASS' : 'FAIL', short(yAfter.error || 'ok'));
  const bStill = await X.rpc('session/set_model', { sessionId: B, modelId: models[0] || 'auto' });
  report('B on X still answers after A was terminated', bStill.result ? 'PASS' : 'FAIL', short(bStill.error || 'ok'));

  /* 6. 进程级通知：哪些通知不带 sessionId（共用进程时就分不出是哪条会话的） */
  const unscoped = [...new Set(X.notes.filter((n) => !n.params?.sessionId).map((n) => n.method))];
  report('notifications without sessionId', unscoped.length ? 'WARN' : 'PASS', unscoped.join(', ') || 'none');

  /* 7. 真跑几轮（要登录、花额度） */
  if (turns) {
    const C = (await X.rpc('session/new', { cwd: CWD, mcpServers: mcpFor('C') })).result?.sessionId;
    const D = (await X.rpc('session/new', { cwd: CWD, mcpServers: mcpFor('D') })).result?.sessionId;
    const long = [{ type: 'text', text: 'Write the numbers from 1 to 400, one per line, nothing else.' }];
    const chunksOf = (sid, since) => X.notes.filter((n) => n.at >= since && n.params?.sessionId === sid && n.params?.update?.sessionUpdate === 'agent_message_chunk').length;
    const pc = X.rpc('session/prompt', { sessionId: C, prompt: long }, 600_000);
    const pd = X.rpc('session/prompt', { sessionId: D, prompt: long }, 600_000);
    await sleep(6000);
    const cancelAt = Date.now();
    X.notify('session/cancel', { sessionId: C });
    const [rc, rd] = await Promise.all([pc, pd]);
    report('cancel C stops C', rc.result?.stopReason === 'cancelled' ? 'PASS' : 'FAIL', short(rc.error || rc.result));
    report('cancel C leaves D running', rd.result?.stopReason === 'end_turn' && chunksOf(D, cancelAt) > 0 ? 'PASS' : 'FAIL', `${short(rd.error || rd.result)} chunks after cancel=${chunksOf(D, cancelAt)}`);

    /*
      释放一条**正在跑**的会话：C、D 重新一起跑，两条都出过字、**而且两条的 prompt 都还没回** 才 terminate C。
      只看"出过字"不够：C 出完字结束了、D 才开始出字，也满足"都出过字"，那时 terminate 的是一条空闲会话。
    */
    const runStart = Date.now();
    const done = { C: false, D: false };
    const pc2 = X.rpc('session/prompt', { sessionId: C, prompt: long }, 600_000).then((r) => { done.C = true; return r; });
    const pd2 = X.rpc('session/prompt', { sessionId: D, prompt: long }, 600_000).then((r) => { done.D = true; return r; });
    const bothRunning = async () => {
      for (const until = Date.now() + 60_000; Date.now() < until && !done.C && !done.D; await sleep(200)) {
        if (chunksOf(C, runStart) > 0 && chunksOf(D, runStart) > 0) return true;
      }
      return false;
    };
    const overlapped = await bothRunning();
    /* 检查和发 terminate 之间不让出事件循环，所以这里看到的"都没回"就是发出那一刻的状态 */
    if (!overlapped || done.C || done.D) {
      const why = done.C || done.D
        ? `${done.C ? 'C' : 'D'} finished before both were streaming at the same time — the overlap never happened`
        : 'C and D were not both streaming within 60 s';
      report('terminate a running C leaves running D alone', 'UNVERIFIED', `${why} — nothing to measure`);
      X.notify('session/cancel', { sessionId: C });
      X.notify('session/cancel', { sessionId: D });
      await Promise.all([pc2, pd2]);
    } else {
      const termAt = Date.now();
      const term2 = await X.rpc('_kiro.dev/session/terminate', { sessionId: C });
      report('terminate a running C succeeds', term2.result ? 'PASS' : 'FAIL', short(term2.error || term2.result));
      const rc2 = await Promise.race([pc2, sleep(60_000).then(() => ({ timeout: true }))]);
      report('C\'s in-flight prompt ends after terminate', rc2.timeout ? 'FAIL' : 'PASS', rc2.timeout ? 'still pending 60 s after terminate' : short(rc2.error || rc2.result));
      const rd2 = await pd2;
      report('D keeps running and finishes after C was terminated', rd2.result?.stopReason === 'end_turn' && chunksOf(D, termAt) > 0 ? 'PASS' : 'FAIL', `${short(rd2.error || rd2.result)} chunks after terminate=${chunksOf(D, termAt)}`);
    }

    /*
      换模型：D 换到 other，B 不动。回包 `{}` 证明不了什么（不存在的模型也回 `{}`），所以要从**会话自己报的模型**核对：
      先看通知里有没有带模型的字段；没有就把两条 terminate 掉、在 Y 里 load，读回包的 currentModelId。
      两条路都拿不到能区分的信息时记 UNVERIFIED —— 不算通过。
    */
    if (other) {
      const original = a.result?.models?.currentModelId;
      const sm = await X.rpc('session/set_model', { sessionId: D, modelId: other });
      report('session/set_model on D', sm.result ? 'PASS' : 'FAIL', `${other} ${short(sm.error || sm.result)}`);
      const askAt = Date.now();
      const ask = [{ type: 'text', text: 'Reply with one word: ok' }];
      const [r1, r2] = await Promise.all([X.rpc('session/prompt', { sessionId: B, prompt: ask }, 300_000), X.rpc('session/prompt', { sessionId: D, prompt: ask }, 300_000)]);
      report('turns on B and D after D switched model', r1.result && r2.result ? 'PASS' : 'FAIL', `${short(r1.error || r1.result)} / ${short(r2.error || r2.result)}`);
      const modelIn = (n) => n.params?.update?.modelId ?? n.params?.update?.model ?? n.params?.modelId ?? n.params?.model;
      const seen = (sid) => [...new Set(X.notes.filter((n) => n.at >= askAt && n.params?.sessionId === sid && typeof modelIn(n) === 'string').map(modelIn))];
      let mB = seen(B);
      let mD = seen(D);
      let source = 'notifications';
      if (!mB.length || !mD.length) {
        source = 'session/load in a second process';
        await X.rpc('_kiro.dev/session/terminate', { sessionId: B });
        await X.rpc('_kiro.dev/session/terminate', { sessionId: D });
        const lb = await Y.rpc('session/load', { sessionId: B, cwd: CWD, mcpServers: [] });
        const ld = await Y.rpc('session/load', { sessionId: D, cwd: CWD, mcpServers: [] });
        mB = lb.result?.models?.currentModelId ? [lb.result.models.currentModelId] : [];
        mD = ld.result?.models?.currentModelId ? [ld.result.models.currentModelId] : [];
      }
      const detail = `${source}: B=${mB.join('|') || '?'} D=${mD.join('|') || '?'} (target ${other}, original ${original})`;
      /* load 回包里两条都报原模型时分不出"没切成"还是"没记下来"，所以只有通知那条路能判 D 没切成 */
      const verdict = mB.includes(other) ? 'FAIL'                                    // B 被一起切了
        : mD.length === 1 && mD[0] === other && mB.length === 1 ? 'PASS'
          : source === 'notifications' && !mD.includes(other) ? 'FAIL'               // D 自己报的不是目标模型
            : 'UNVERIFIED';
      report('model switch on D does not touch B', verdict, detail);
    }
    const roster = X.notes.filter((n) => n.method === '_kiro.dev/subagent/list_update' && n.params?.subagents?.length);
    report('subagent roster names its parent session', roster.length ? (roster.every((n) => n.params.subagents.every((s) => s.parentSessionId)) ? 'PASS' : 'FAIL') : 'SKIP', roster.length ? short(roster[0].params.subagents[0]) : 'no subagent ran (use an agent with delegate enabled)');
  } else report('real turns (cancel / terminate / model switch)', 'SKIP', 'pass --turns (needs login, spends credits)');
} catch (err) {
  report('probe', 'FAIL', String(err?.message || err));
} finally {
  await shutdownAll();
}
const failed = results.filter((r) => r.verdict === 'FAIL').length;
const unverified = results.filter((r) => r.verdict === 'UNVERIFIED').length;
console.log(`\n${results.length} checks, ${failed} failed, ${unverified} unverified${unverified ? ' (unverified is NOT a pass)' : ''}`);
process.exit(failed ? 1 : unverified ? 2 : 0);
