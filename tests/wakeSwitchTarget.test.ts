import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releaseSessionTools, startLocalMcp, RETIRED_REPLACED, type LocalMcpServer } from '../src/main/localMcp.ts';
import { BgJobManager } from '../src/main/bgJobs.ts';
import { callWakeTool, switchCarryOverText, type WakeHost, type WakeScheduleRow } from '../src/main/wakeTools.ts';
import { setUiLang } from '../src/main/uiText.ts';

/**
 * 「会话切到本机运行后 bg_run 返回 404」——三种运行位置切换之后，kirolex-local 上那组工具都要能用。
 *
 * 真起 local MCP（HTTP）、真起后台进程（本机这个 node），按 index.ts `switchRemoteTarget` 的顺序走一遍：
 *   新位置备工具（`ensureLocalTools`：远程 = `register`，本机 = `withLocalBrowser` 的 `register(browserOnly)`）
 *   → 新执行器连上（tools/list）→ 远程 → 本机时收掉旧的远程那一套（`releaseLocalTools` → `releaseSessionTools`）。
 * 根因：最后那一步原来是 `forget(sessionId)`，把刚交给本机执行器的 token 也作废了。
 */

const NODE = `"${process.execPath}"`;
const nodeCmd = (js: string) => `${NODE} -e "${js}"`;
const SID = 's_1789629414597_kqrsee';

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) assert.fail(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function harness() {
  setUiLang('zh');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-switch-'));
  const wakes: Array<{ sessionId: string; text: string; jobId: string }> = [];
  const logs: string[] = [];
  const bg = new BgJobManager({
    wake: (sessionId, text, job) => { wakes.push({ sessionId, text, jobId: job.jobId }); },
    note: () => {},
    changed: () => {},
    log: () => {},
  });
  const schedules: WakeScheduleRow[] = [];
  const host: WakeHost = {
    now: () => Date.now(),
    createSchedule: (sessionId, spec, expiresAt) => {
      const id = `sched_${schedules.length + 1}`;
      schedules.push({ id, describe: spec.kind, prompt: spec.prompt, runs: 0, maxRuns: spec.maxRuns, paused: false, terminal: null, nextRunAt: Date.now() + 60_000, createdBy: 'model', expiresAt, sid: sessionId } as any);
      return { ok: true, id, describe: spec.kind, nextRunAt: Date.now() + 60_000 };
    },
    listSchedules: (sessionId) => schedules.filter((s: any) => s.sid === sessionId),
    deleteSchedule: (_sid, id) => { const i = schedules.findIndex((s) => s.id === id); if (i >= 0) schedules.splice(i, 1); return { ok: i >= 0 }; },
    bg,
    cwdFor: (_sid, fallback) => fallback,
    markOutputSeen: () => {},
  };
  const server = await startLocalMcp({
    log: (_level, m) => logs.push(m),
    notice: () => {},
    wake: { call: (name, args, sid, workdir) => callWakeTool(name, args, sid, workdir, host) },
  });
  cleanups.push(async () => { await bg.stopAll(); server.stop(); });
  return { server, bg, wakes, logs, dir, schedules };
}

let rpcId = 0;
async function rpc(server: LocalMcpServer, urlPath: string, method: string, params?: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${server.port()}${urlPath}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const call = async (server: LocalMcpServer, urlPath: string, name: string, args: any) => {
  const r = await rpc(server, urlPath, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, `${name} 应该是 200，实际 ${r.status}`);
  return r.body.result as { content: Array<{ text: string }>; isError?: boolean };
};

type Place = 'local' | 'remote-a' | 'remote-b';
/** 按 index.ts 的顺序把会话放到某个位置：备工具（登记 token）→ 新执行器连上（tools/list）。返回新执行器手上的 URL。 */
async function placeOn(server: LocalMcpServer, dir: string, where: Place): Promise<string> {
  server.register({ sessionId: SID, workdir: dir, ...(where === 'local' ? { browserOnly: true } : {}) });
  const urlPath = server.urlPathFor(SID)!;
  const list = await rpc(server, urlPath, 'tools/list');
  assert.equal(list.status, 200);
  assert.ok(list.body.result.tools.some((t: any) => t.name === 'bg_run'), `${where} 会话应该列出 bg_run`);
  return urlPath;
}
/** `switchRemoteTarget`：先在新位置备好、连上，**之后**才收旧的；只有远程 → 本机走 releaseLocalTools（keepToken）。 */
async function switchTo(server: LocalMcpServer, dir: string, from: Place, to: Place): Promise<string> {
  const urlPath = await placeOn(server, dir, to);
  if (to === 'local' && from !== 'local') releaseSessionTools(server, SID, { keepToken: true });
  return urlPath;
}

const SWITCHES: Array<[Place, Place]> = [['remote-a', 'local'], ['local', 'remote-a'], ['remote-a', 'remote-b']];

describe('切换运行位置之后：bg_run / watch / schedule_* 都能用，结束时唤醒会话', () => {
  for (const [from, to] of SWITCHES) {
    test(`${from} → ${to}`, async () => {
      const { server, wakes, dir } = await harness();
      const before = await placeOn(server, dir, from);
      assert.match((await call(server, before, 'schedule_list', {})).content[0].text, /没有定时任务/);
      const url = await switchTo(server, dir, from, to);

      const run = await call(server, url, 'bg_run', { command: nodeCmd("console.log('eval done')"), label: 'eval' });
      assert.notEqual(run.isError, true, run.content[0].text);
      assert.match(run.content[0].text, /已在后台运行 (bg_\S+)/);
      const jobId = /已在后台运行 (\S+)（/.exec(run.content[0].text)![1];
      await waitFor(() => wakes.some((w) => w.jobId === jobId), '后台命令结束的唤醒');
      const w = wakes.find((x) => x.jobId === jobId)!;
      assert.equal(w.sessionId, SID, '唤醒发回同一条 KiroLex 会话');
      assert.match(w.text, /退出码 0/);
      assert.match(w.text, /eval done/);

      const st = await call(server, url, 'bg_status', { jobId });
      assert.match(st.content[0].text, /状态 exited/);

      const watch = await call(server, url, 'watch', { command: nodeCmd("console.log('tick')"), label: 'w' });
      assert.notEqual(watch.isError, true, watch.content[0].text);
      const watchId = /已开始监视 (\S+)（/.exec(watch.content[0].text)![1];
      await waitFor(() => wakes.some((x) => x.jobId === watchId && /tick/.test(x.text)), '监视的一行输出');

      const long = await call(server, url, 'bg_run', { command: nodeCmd('setTimeout(()=>{},60000)'), label: 'long' });
      const longId = /已在后台运行 (\S+)（/.exec(long.content[0].text)![1];
      assert.match((await call(server, url, 'bg_stop', { jobId: longId })).content[0].text, /已停止/);

      const made = await call(server, url, 'schedule_create', { prompt: '看一眼', kind: 'once', delaySec: 60 });
      assert.notEqual(made.isError, true, made.content[0].text);
      const schedId = /已建定时任务 (\S+)：/.exec(made.content[0].text)![1];
      assert.match((await call(server, url, 'schedule_list', {})).content[0].text, new RegExp(schedId));
      assert.match((await call(server, url, 'schedule_delete', { id: schedId })).content[0].text, /已删除/);
    });
  }
});

describe('切换时正在跑的后台任务：留在原来那台（本机）继续跑，结果照常回到会话', () => {
  for (const [from, to] of SWITCHES) {
    test(`${from} → ${to}：切换前起的 bg_run 切换后结束照样唤醒，新执行器 bg_status 查得到`, async () => {
      const { server, wakes, dir } = await harness();
      const before = await placeOn(server, dir, from);
      const run = await call(server, before, 'bg_run', { command: nodeCmd("setTimeout(()=>console.log('late result'),400)"), label: 'slow' });
      const jobId = /已在后台运行 (\S+)（/.exec(run.content[0].text)![1];

      const url = await switchTo(server, dir, from, to);
      assert.equal(wakes.length, 0, '切换那一刻还没结束');
      await waitFor(() => wakes.some((w) => w.jobId === jobId), '切换前起的后台命令结束的唤醒');
      const w = wakes.find((x) => x.jobId === jobId)!;
      assert.equal(w.sessionId, SID);
      assert.match(w.text, /late result/);
      assert.match((await call(server, url, 'bg_status', { jobId })).content[0].text, /状态 exited/);
    });
  }

  test('切换提示里明说：还在跑的后台任务 / 定时任务照常（没有就不说）', () => {
    setUiLang('zh');
    assert.equal(switchCarryOverText(0, 0), '');
    assert.equal(switchCarryOverText(2, 1), '⏳ 2 个后台任务（bg_run / watch）在本机继续跑；1 个定时任务照常到点触发，结果照常发回这条会话。');
    assert.equal(switchCarryOverText(0, 3), '⏳ 3 个定时任务照常到点触发，结果照常发回这条会话。');
    setUiLang('en');
    assert.match(switchCarryOverText(1, 0), /^⏳ 1 background task\(s\) \(bg_run \/ watch\) keep running on this computer; results still come back to this session\.$/);
    setUiLang('zh');
  });
});

describe('工具调用失败时：模型看得懂，日志里有会话 id 和 HTTP 状态', () => {
  test('回归：收旧工具时按会话 id 作废（原来的 forget）会让本机执行器的 bg_run 失败 —— keepToken 不会', async () => {
    const { server, dir } = await harness();
    await placeOn(server, dir, 'remote-a');
    const url = await placeOn(server, dir, 'local');
    releaseSessionTools(server, SID, { keepToken: true });
    assert.notEqual((await call(server, url, 'bg_run', { command: nodeCmd('1') })).isError, true);
    releaseSessionTools(server, SID);   // 原来的行为：forget
    const r = await call(server, url, 'bg_run', { command: nodeCmd('1') });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^后台任务工具在这条会话暂时不可用：这条会话的执行器已经断开/);
  });

  test('拿着被换掉的旧 token 调工具：可读错误（不是裸 404），日志一行带会话 id 和 HTTP 404', async () => {
    const { server, dir, logs } = await harness();
    const old = await placeOn(server, dir, 'remote-a');
    await placeOn(server, dir, 'remote-b');
    const r = await call(server, old, 'bg_run', { command: nodeCmd('1') });
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, `后台任务工具在这条会话暂时不可用：${RETIRED_REPLACED}。`);
    assert.ok(logs.some((l) => l.includes(`sessionId=${SID}`) && l.includes('HTTP 404') && l.includes('tool=bg_run')), logs.join('\n'));
    /* local_* 那几个换个说法 */
    const lr = await call(server, old, 'local_read', { paths: ['a'] });
    assert.match(lr.content[0].text, /^KiroLex 本地工具在这条会话暂时不可用：/);
    /* 别的请求照旧 404（不能让对方以为连上了），body 里是同一句 */
    const list = await rpc(server, old, 'tools/list');
    assert.equal(list.status, 404);
    assert.match(list.body.error.message, /暂时不可用/);
  });

  test('完全不认识的地址：仍然 404、不解释，但日志记一行', async () => {
    const { server, logs } = await harness();
    const r = await fetch(`http://127.0.0.1:${server.port()}/mcp/${'0'.repeat(32)}`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 404);
    assert.equal((await r.text()).trim(), '');
    assert.ok(logs.some((l) => l.includes('HTTP 404') && l.includes('sessionId=未知')));
  });
});

describe('接线（index.ts 不能被测试 import —— 源码扫描）', () => {
  const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  test('远程 → 本机收旧工具时 keepToken；releaseLocalTools 经 releaseSessionTools，不再直接 forget', () => {
    assert.match(MAIN, /if \(!target && oldEntry\.profile\.remote\?\.sshHost\) releaseLocalTools\(sessionId, oldEntry\.profile\.remote, \{ keepToken: true \}\);/);
    assert.match(MAIN, /releaseSessionTools\(localMcpServer, sessionId, \{ keepToken: opts\.keepToken \}\);/);
    assert.doesNotMatch(MAIN, /localMcpServer\?\.forget\(/);
  });
  test('切换提示带上「后台任务 / 定时任务照常」那句', () => {
    assert.match(MAIN, /const carryOver = wakeCarryOverFor\(sessionId\);/);
    assert.match(MAIN, /const text = switchCarryOverText\(bgLive, schedLive\);/);
    assert.match(MAIN, /carryOver \? `\\n\$\{carryOver\}` : '',/);
  });
  test('切换失败：旧执行器的 token 已换掉 → 没在跑一轮就收掉它', () => {
    assert.match(MAIN, /if \(sessionClients\.get\(sessionId\) === oldEntry && !oldEntry\.busy\) \{[\s\S]{0,200}void detachExecutor\(sessionId\);/);
  });
});
