/**
 * WHAT CLAUDE CODE'S ACP ADAPTER ACTUALLY PUTS ON THE WIRE — a manual probe for the feature audit
 * (`docs/claude-code-feature-audit.md`). NOT part of `npm test`: it starts the real
 * `@agentclientprotocol/claude-agent-acp`, which spends real money on the account Claude Code is
 * logged in with. No credentials live here — the adapter uses Claude Code's own login.
 *
 * Speaks the same NDJSON-over-stdio handshake as `src/main/acp-client.ts`
 * (`initialize` → `session/new` → `session/prompt`), logs every frame VERBATIM to PROBE_LOG, and
 * prints a per-step summary (sessionUpdate kinds, tool titles / kinds / statuses / locations,
 * permission requests, stopReasons, `_meta` keys).
 *
 * Usage:
 *   PROBE_LOG=/tmp/cc-probe.log PROBE_STEPS=init,model,tools node scripts/claude-feature-probe.mjs
 *
 * Env:
 *   PROBE_STEPS   comma list (default: all) — init, model, tools, todo, tasks, think, effort, image, slash,
 *                 compact, compactPrefixed, cancelTool, cancelPerm, cancelTask, plan, task, web, load
 *                 (cancelPerm switches the session to Manual mode first: the adapter starts in
 *                 bypassPermissions on this machine, which never asks)
 *   PROBE_MODEL   substring of the model id/name to switch to (default: haiku — cheapest)
 *   PROBE_LOG     verbatim frame log (default: <tmp>/claude-feature-probe.log)
 *   PROBE_CWD     working dir for the session (default: a fresh temp dir with hello.txt)
 *   KIROLEX_CLAUDE_ACP  adapter entry (.js) — same override KiroLex itself honours (`engines.ts`)
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG = process.env.PROBE_LOG || path.join(os.tmpdir(), 'claude-feature-probe.log');
const ALL = ['init', 'model', 'tools', 'todo', 'tasks', 'think', 'effort', 'image', 'slash', 'compact', 'compactPrefixed', 'cancelTool', 'cancelPerm', 'cancelTask', 'plan', 'task', 'web', 'load'];
const STEPS = (process.env.PROBE_STEPS || ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const WANT_MODEL = (process.env.PROBE_MODEL || 'haiku').toLowerCase();
fs.writeFileSync(LOG, '');
const t0 = Date.now();
const rec = (dir, obj) => fs.appendFileSync(LOG, `[${String(Date.now() - t0).padStart(7)}ms] ${dir} ${JSON.stringify(obj)}\n`);

function adapterEntry() {
  const o = process.env.KIROLEX_CLAUDE_ACP;
  if (o) return o;
  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  try {
    const win = process.platform === 'win32';
    const out = execFileSync(win ? (process.env.ComSpec || 'cmd.exe') : 'npm', win ? ['/d', '/s', '/c', 'npm root -g'] : ['root', '-g'], { encoding: 'utf8' });
    roots.unshift(out.trim().split(/\r?\n/).pop());
  } catch { /* fall through */ }
  for (const r of roots) {
    const e = path.join(r, '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
    if (fs.existsSync(e)) return e;
  }
  throw new Error('claude-agent-acp not found (npm i -g @agentclientprotocol/claude-agent-acp, or set KIROLEX_CLAUDE_ACP)');
}

const cwd = process.env.PROBE_CWD || fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-'));
if (!process.env.PROBE_CWD) fs.writeFileSync(path.join(cwd, 'hello.txt'), 'hello world\nsecond line\n');

/* ---------- one adapter process ---------- */
function startAdapter() {
  const child = spawn(process.execPath, [adapterEntry()], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true });
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  const st = { child, updates: [], permHandler: null, onUpdate: null };
  child.stderr.on('data', (d) => rec('STDERR', String(d).slice(0, 2000)));
  child.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { rec('NONJSON', line.slice(0, 500)); continue; }
      rec('<-', msg);
      if (msg.id !== undefined && !msg.method) {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.error ? p.reject(Object.assign(new Error(msg.error.message), msg.error)) : p.resolve(msg.result); }
      } else if (msg.method === 'session/update') {
        st.updates.push(msg.params);
        st.onUpdate?.(msg.params);
      } else if (msg.method && msg.id !== undefined) {
        void handleRequest(msg);
      }
    }
  });
  const write = (obj) => { rec('->', obj); child.stdin.write(JSON.stringify(obj) + '\n'); };
  st.request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); write({ jsonrpc: '2.0', id, method, params }); });
  st.notify = (method, params) => write({ jsonrpc: '2.0', method, params });
  st.respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  async function handleRequest(msg) {
    if (msg.method === 'session/request_permission') {
      st.perms = (st.perms || []);
      st.perms.push(msg.params);
      if (st.permHandler) return st.permHandler(msg);
      const opt = (msg.params.options || []).find((o) => o.kind === 'allow_once') || (msg.params.options || []).find((o) => o.kind?.startsWith('allow'));
      return st.respond(msg.id, { outcome: opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' } });
    }
    write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `probe does not implement ${msg.method}` } });
  }
  st.close = () => new Promise((r) => { child.once('exit', r); child.stdin.end(); setTimeout(() => { try { child.kill(); } catch {} }, 5000); });
  return st;
}

/* ---------- summaries ---------- */
function summarize(label, updates, extra = {}) {
  const kinds = {};
  const tools = new Map();
  const metaKeys = new Set();
  let thought = 0, text = '';
  const plans = [];
  for (const p of updates) {
    const u = p.update || {};
    kinds[u.sessionUpdate] = (kinds[u.sessionUpdate] || 0) + 1;
    if (u._meta) for (const k of Object.keys(u._meta)) metaKeys.add(`${k}:${Object.keys(u._meta[k] || {}).join('/')}`);
    if (u.sessionUpdate === 'agent_thought_chunk') thought += (u.content?.text || '').length;
    if (u.sessionUpdate === 'agent_message_chunk') text += u.content?.text || '';
    if (u.sessionUpdate === 'plan') plans.push(u.entries.map((e) => `${e.status}:${e.content}`).join(' | '));
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      const t = tools.get(u.toolCallId) || { titles: [], statuses: [], kinds: new Set(), content: new Set(), locations: null, parent: null, toolName: null };
      if (u.title && t.titles.at(-1) !== u.title) t.titles.push(u.title);
      if (u.status && t.statuses.at(-1) !== u.status) t.statuses.push(u.status);
      if (u.kind) t.kinds.add(u.kind);
      for (const c of u.content || []) t.content.add(c.type);
      if (u.locations) t.locations = u.locations;
      t.parent = t.parent || u._meta?.claudeCode?.parentToolUseId || null;
      t.toolName = t.toolName || u._meta?.claudeCode?.toolName || null;
      tools.set(u.toolCallId, t);
    }
  }
  console.log(`\n=== ${label} ===`);
  console.log('sessionUpdate kinds:', JSON.stringify(kinds));
  if (metaKeys.size) console.log('_meta keys:', [...metaKeys].join(', '));
  for (const [id, t] of tools) {
    console.log(`  tool ${id.slice(-8)} [${t.toolName || '?'}] kind=${[...t.kinds].join('/')} titles=${JSON.stringify(t.titles)} statuses=${t.statuses.join('>')} content=${[...t.content].join('/')}${t.locations ? ` locations=${JSON.stringify(t.locations)}` : ''}${t.parent ? ` parent=${t.parent.slice(-8)}` : ''}`);
  }
  if (plans.length) console.log('  plan updates:', plans.join('  ||  '));
  if (thought) console.log('  thought chars:', thought);
  if (text) console.log('  text:', JSON.stringify(text.slice(0, 300)));
  for (const [k, v] of Object.entries(extra)) console.log(`  ${k}:`, typeof v === 'string' ? v : JSON.stringify(v));
}

async function prompt(a, sessionId, label, blocks, opts = {}) {
  const from = a.updates.length;
  a.perms = [];
  const p = a.request('session/prompt', { sessionId, prompt: typeof blocks === 'string' ? [{ type: 'text', text: blocks }] : blocks });
  if (opts.during) opts.during(p);
  let res, err;
  try { res = await p; } catch (e) { err = e; }
  /* give trailing notifications a moment (usage_update arrives right after the response) */
  await new Promise((r) => setTimeout(r, 400));
  summarize(label, a.updates.slice(from), { stopReason: res?.stopReason ?? `ERROR ${err?.message}`, ...(res?._meta || res?.usage ? { result: { usage: res.usage, _meta: res._meta } } : {}), ...(a.perms.length ? { permissions: a.perms.map((q) => ({ title: q.toolCall?.title, options: q.options?.map((o) => `${o.optionId}:${o.kind}`) })) } : {}) });
  return { res, err, updates: a.updates.slice(from) };
}

const tinyPng = () => {
  /* 8x8 solid red PNG, generated so no binary lives in the repo */
  const zlib = await_zlib();
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(8 * (1 + 8 * 3)); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) raw[y * 25 + 1 + x * 3] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
};
import zlibMod from 'node:zlib';
function await_zlib() { return zlibMod; }

async function main() {
  console.log('cwd:', cwd, '\nlog:', LOG, '\nsteps:', STEPS.join(','));
  let a = startAdapter();
  const init = await a.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'kirolex-probe', version: '0' } });
  console.log('agentCapabilities:', JSON.stringify(init.agentCapabilities));
  const ns = await a.request('session/new', { cwd, mcpServers: [] });
  const sid = ns.sessionId;
  console.log('sessionId:', sid);
  if (STEPS.includes('init')) {
    console.log('modes:', JSON.stringify(ns.modes));
    console.log('models:', JSON.stringify(ns.models && { current: ns.models.currentModelId, ids: ns.models.availableModels?.map((m) => m.modelId) }));
    console.log('configOptions:', JSON.stringify((ns.configOptions || []).map((o) => ({ id: o.id, category: o.category, type: o.type, current: o.currentValue, values: (o.options || []).map((v) => v.value ?? v.options?.map((x) => x.value)) }))));
  }
  /* always switch to the cheap model first (cost control) */
  const modelOpt = (ns.configOptions || []).find((o) => o.category === 'model');
  const pick = (modelOpt?.options || []).flatMap((v) => v.options || [v]).find((v) => String(v.value + ' ' + (v.name || '')).toLowerCase().includes(WANT_MODEL))
    || (ns.models?.availableModels || []).map((m) => ({ value: m.modelId, name: m.name })).find((v) => String(v.value + ' ' + v.name).toLowerCase().includes(WANT_MODEL));
  if (pick) {
    const r = modelOpt
      ? await a.request('session/set_config_option', { sessionId: sid, configId: modelOpt.id, value: pick.value }).catch((e) => ({ error: e.message }))
      : await a.request('session/set_model', { sessionId: sid, modelId: pick.value }).catch((e) => ({ error: e.message }));
    console.log(`set model -> ${pick.value}:`, JSON.stringify(r).slice(0, 600));
  } else console.log('no cheap model matched', WANT_MODEL);

  if (STEPS.includes('model')) await prompt(a, sid, 'model: one-word reply', 'Reply with exactly: ok');
  if (STEPS.includes('tools')) {
    await prompt(a, sid, 'tools: Read/Grep/Write/Edit/Bash/failing Read',
      'Use tools, in this order, with no commentary: 1) Read hello.txt 2) Grep for "world" in this directory 3) Write out.txt containing exactly "alpha" 4) Edit out.txt replacing "alpha" with "beta" 5) Run the shell command: echo hi 6) Read missing-file.txt (it does not exist). Then reply "done".');
  }
  if (STEPS.includes('todo')) await prompt(a, sid, 'todo: TodoWrite', 'Use the TodoWrite tool to create a todo list with two items "step A" and "step B". Then mark "step A" completed with TodoWrite. Then reply "done". No other tools.');
  if (STEPS.includes('tasks')) await prompt(a, sid, 'tasks: TaskCreate/TaskUpdate (what newer Claude Code uses instead of TodoWrite)', 'Use the TaskCreate tool to create two tasks "step A" and "step B" (load it with ToolSearch first if needed). Then use TaskUpdate to mark "step A" completed. Then reply "done". No other tools.');
  if (STEPS.includes('effort')) {
    /* effort is per model: haiku rejects it. Switch to sonnet only to read what the adapter accepts — no prompt, no cost */
    const m = (ns.configOptions || []).find((o) => o.category === 'model');
    const e = (ns.configOptions || []).find((o) => o.category === 'thought_level');
    if (m && e) {
      for (const model of ['sonnet', pick?.value].filter(Boolean)) {
        const r1 = await a.request('session/set_config_option', { sessionId: sid, configId: m.id, value: model }).catch((x) => ({ error: x.message }));
        const effOpt = (r1.configOptions || []).find((o) => o.category === 'thought_level');
        const r2 = await a.request('session/set_config_option', { sessionId: sid, configId: e.id, value: 'high' }).catch((x) => ({ error: x.message }));
        console.log(`\neffort on ${model}: options after model switch=${JSON.stringify(effOpt && (effOpt.options || []).map((v) => v.value))} set high ->`, JSON.stringify(r2.error || (r2.configOptions || []).find((o) => o.category === 'thought_level')?.currentValue));
      }
    }
  }
  if (STEPS.includes('think')) {
    const effort = (ns.configOptions || []).find((o) => o.category === 'thought_level' || /effort|thinking/i.test(o.id));
    if (effort) {
      const vals = (effort.options || []).flatMap((v) => v.options || [v]).map((v) => v.value);
      const hi = vals.find((v) => /high|on|true/i.test(String(v))) || vals.at(-1);
      console.log(`set ${effort.id} -> ${hi}:`, JSON.stringify(await a.request('session/set_config_option', { sessionId: sid, configId: effort.id, value: hi }).catch((e) => ({ error: e.message }))).slice(0, 300));
    } else console.log('no effort/thinking config option');
    await prompt(a, sid, 'think: thought chunks', 'Think step by step briefly, then give only the number: 17*23');
  }
  if (STEPS.includes('image')) {
    await prompt(a, sid, 'image: image content block', [{ type: 'text', text: 'What single color fills this image? One word.' }, { type: 'image', mimeType: 'image/png', data: tinyPng() }]);
    const png = path.join(cwd, 'red.png'); fs.writeFileSync(png, Buffer.from(tinyPng(), 'base64'));
    await prompt(a, sid, 'image: path in text (how KiroLex attachments look)', `What single color fills the image at ${png}? One word.`);
  }
  if (STEPS.includes('slash')) {
    const cmds = a.updates.filter((p) => p.update?.sessionUpdate === 'available_commands_update').at(-1);
    console.log('\navailable_commands:', JSON.stringify(cmds?.update.availableCommands?.map((c) => c.name)));
    await prompt(a, sid, 'slash: "/context" alone (local-only, free)', '/context');
    await prompt(a, sid, 'slash: memory text BEFORE "/context" in the SAME text block', '<kirolex-memory>\nremember: x\n</kirolex-memory>\n\n/context');
    await prompt(a, sid, 'slash: memory as a SEPARATE first block, "/context" second', [{ type: 'text', text: '<kirolex-memory>remember: x</kirolex-memory>' }, { type: 'text', text: '/context' }]);
  }
  if (STEPS.includes('compact')) await prompt(a, sid, 'compact: "/compact"', '/compact');
  if (STEPS.includes('compactPrefixed')) {
    /* exactly the shape sendPromptOnce sends: hidden memory block, workdir note, then the user's text */
    await prompt(a, sid, 'compactPrefixed: KiroLex shape [memory][workdir note]["/compact"]', [
      { type: 'text', text: '<hidden>\n[KiroLex memory]\n(empty)\n</hidden>' },
      { type: 'text', text: '[文件位置] 工作目录是 ' + cwd },
      { type: 'text', text: '/compact' },
    ]);
    await prompt(a, sid, 'compactPrefixed: KiroLex shape [memory]["/clear"]', [
      { type: 'text', text: '<hidden>\n[KiroLex memory]\n(empty)\n</hidden>' },
      { type: 'text', text: '/clear' },
    ]);
    await prompt(a, sid, 'compactPrefixed: after /clear — is the history gone?', 'Did I ask you anything earlier in this conversation? Answer yes or no only.');
  }
  if (STEPS.includes('cancelTool')) {
    await prompt(a, sid, 'cancelTool: cancel during Bash sleep', 'Run the shell command: sleep 40 && echo finished . Then reply with its output.', {
      during: () => { a.onUpdate = (p) => { if (p.update?.sessionUpdate === 'tool_call_update' || p.update?.sessionUpdate === 'tool_call') { a.onUpdate = null; setTimeout(() => a.notify('session/cancel', { sessionId: sid }), 2500); } }; },
    });
    a.onUpdate = null;
    await prompt(a, sid, 'cancelTool: next message after cancel', 'Reply with exactly: ok');
  }
  if (STEPS.includes('cancelPerm')) {
    console.log('\nset_mode default:', JSON.stringify(await a.request('session/set_mode', { sessionId: sid, modeId: 'default' }).catch((e) => ({ error: e.message }))).slice(0, 200));
    let held = null;
    a.permHandler = (msg) => { held = msg; setTimeout(() => a.notify('session/cancel', { sessionId: sid }), 500); setTimeout(() => a.respond(msg.id, { outcome: { outcome: 'cancelled' } }), 800); };
    await prompt(a, sid, 'cancelPerm: cancel while a permission request is pending', 'Run the shell command: git init probe-repo . Then reply "done".');
    a.permHandler = null;
    console.log('  permission was requested:', !!held);
    await prompt(a, sid, 'cancelPerm: next message after cancel', 'Reply with exactly: ok');
  }
  if (STEPS.includes('cancelTask')) {
    await prompt(a, sid, 'cancelTask: cancel while a Task subagent runs', 'Use the Task tool (subagent_type "general-purpose", run in the foreground, not background) with the prompt "Run the shell command: sleep 40 && echo sub-done . Reply with its output only." Then reply with what it returned.', {
      during: () => { a.onUpdate = (p) => { if (p.update?._meta?.claudeCode?.parentToolUseId) { a.onUpdate = null; setTimeout(() => a.notify('session/cancel', { sessionId: sid }), 1500); } }; },
    });
    a.onUpdate = null;
    await prompt(a, sid, 'cancelTask: next message after cancel', 'Reply with exactly: ok');
  }
  if (STEPS.includes('plan')) {
    const modeOpt = (ns.configOptions || []).find((o) => o.category === 'mode');
    const setMode = (m) => (ns.modes ? a.request('session/set_mode', { sessionId: sid, modeId: m }) : a.request('session/set_config_option', { sessionId: sid, configId: modeOpt.id, value: m })).catch((e) => ({ error: e.message }));
    console.log('\nset_mode plan:', JSON.stringify(await setMode('plan')).slice(0, 300));
    a.permHandler = (msg) => {
      const opts = msg.params.options || [];
      console.log('  plan permission options:', JSON.stringify(opts.map((o) => `${o.optionId}:${o.kind}:${o.name}`)));
      const o = opts.find((x) => x.optionId === 'acceptEdits') || opts.find((x) => x.kind?.startsWith('allow'));
      a.respond(msg.id, { outcome: { outcome: 'selected', optionId: o.optionId } });
    };
    await prompt(a, sid, 'plan: plan mode → ExitPlanMode → approve', 'Make a one-line plan to create plan.txt containing "p", present it with ExitPlanMode, and once approved create the file. Keep it minimal.');
    a.permHandler = null;
  }
  if (STEPS.includes('task')) await prompt(a, sid, 'task: Task subagent', 'Use the Task tool (subagent_type "general-purpose") with the prompt "Run the shell command: echo sub-hello . Reply with its output only." Then reply with what the subagent returned.');
  if (STEPS.includes('web')) await prompt(a, sid, 'web: WebFetch', 'Use WebFetch on https://example.com and reply with the page title only.');
  if (STEPS.includes('load')) {
    await a.close();
    a = startAdapter();
    await a.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const from = a.updates.length;
    let lr, le; try { lr = await a.request('session/load', { sessionId: sid, cwd, mcpServers: [] }); } catch (e) { le = e; }
    await new Promise((r) => setTimeout(r, 800));
    summarize('load: session/load replay in a fresh process', a.updates.slice(from), { result: le ? `ERROR ${le.message}` : { models: lr?.models?.currentModelId, modes: lr?.modes?.currentModeId, configOptions: (lr?.configOptions || []).map((o) => `${o.id}=${o.currentValue}`) } });
    await prompt(a, sid, 'load: does the model remember? ', 'What exact text did I first ask you to reply with in this conversation? Reply with it only.');
  }
  await a.close();
  console.log('\ndone. verbatim frames:', LOG);
}

main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
