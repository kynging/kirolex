/**
 * 假的 `kiro-cli acp`：给 `tests/kiroMultisessionProbe.test.ts` 用，只实现探针用到的那几个方法。
 *
 * 会话按创建顺序叫 s1、s2、s3…（探针里是 A、B、C、D）。每次 `session/prompt` 每 80ms 出一个字、
 * 出 100 个后 end_turn；`session/cancel` 和 `_kiro.dev/session/terminate` 都让那条在跑的 prompt 以 cancelled 收尾。
 *
 * `FAKE_MODE=early`：C（s3）的**第二轮**只出一个字就马上结束，D（s4）的第二轮晚 500ms 才开始出字 ——
 * 也就是"两条都出过字，但从来没有同时在跑"。
 *
 * 每个事件追加一行到 `FAKE_LOG`：`prompt-start <sid> <n>` / `prompt-end <sid> <n> <reason>` /
 * `terminate <sid> running=<true|false>`。
 */
import fs from 'node:fs';

const MODE = process.env.FAKE_MODE || '';
const LOG = process.env.FAKE_LOG;
const log = (line) => { if (LOG) fs.appendFileSync(LOG, `${line}\n`); };
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

let created = 0;
const models = new Map();
const promptCount = new Map();
/** sid → { id, n, timer } —— 正在跑的那一轮 */
const running = new Map();

function finish(sid, stopReason) {
  const r = running.get(sid);
  if (!r) return;
  clearTimeout(r.timer);
  running.delete(sid);
  log(`prompt-end ${sid} ${r.n} ${stopReason}`);
  send({ id: r.id, result: { stopReason } });
}

function startPrompt(id, sid) {
  const n = (promptCount.get(sid) || 0) + 1;
  promptCount.set(sid, n);
  log(`prompt-start ${sid} ${n}`);
  const early = MODE === 'early' && n === 2;
  const total = early && sid === 's3' ? 1 : 100;
  const firstDelay = early && sid === 's4' ? 500 : 50;
  let sent = 0;
  const r = { id, n, timer: undefined };
  running.set(sid, r);
  const tick = () => {
    if (running.get(sid) !== r) return;
    send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${sent}\n` } } } });
    sent++;
    if (sent >= total) { r.timer = setTimeout(() => finish(sid, 'end_turn'), 10); return; }
    r.timer = setTimeout(tick, 80);
  };
  r.timer = setTimeout(tick, firstDelay);
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const p = m.params || {};
    switch (m.method) {
      case 'initialize':
        send({ id: m.id, result: { protocolVersion: 1, agentInfo: { version: 'fake' }, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } } } });
        break;
      case 'session/new': {
        const sid = `s${++created}`;
        models.set(sid, 'm1');
        send({ id: m.id, result: { sessionId: sid, models: { currentModelId: 'm1', availableModels: [{ modelId: 'm1' }, { modelId: 'm2' }] } } });
        break;
      }
      case 'session/load':
        send({ id: m.id, result: { models: { currentModelId: models.get(p.sessionId) || 'm1', availableModels: [{ modelId: 'm1' }, { modelId: 'm2' }] } } });
        break;
      case 'session/set_model':
        models.set(p.sessionId, p.modelId);
        send({ id: m.id, result: {} });
        break;
      case 'session/prompt':
        startPrompt(m.id, p.sessionId);
        break;
      case 'session/cancel':
        finish(p.sessionId, 'cancelled');
        break;
      case '_kiro.dev/session/terminate':
        log(`terminate ${p.sessionId} running=${running.has(p.sessionId)}`);
        finish(p.sessionId, 'cancelled');
        send({ id: m.id, result: {} });
        break;
      default:
        if (m.id != null) send({ id: m.id, error: { code: -32601, message: 'Method not found', data: m.method } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
