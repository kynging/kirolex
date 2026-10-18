import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SCHEDULES_PER_SESSION,
  callWakeTool,
  isWakeTool,
  wakeToolDefs,
  type WakeHost,
} from '../src/main/wakeTools.ts';
import { toolDefs, handleRpc } from '../src/main/localMcp.ts';
import { BG_MAX_TIMEOUT_SEC, WATCH_DEFAULT_TIMEOUT_SEC, WATCH_MAX_TIMEOUT_SEC } from '../src/main/bgJobs.ts';
import type { ScheduleSpec } from '../src/main/schedule.ts';

/**
 * kirolex-local 上给模型用的「过一会儿再看」工具：schedule_* / bg_* / watch。
 *
 * 守的是：工具描述里写清何时用（不要在一轮里 sleep 轮询）；定时任务走 host（= 现有的定时任务存储和计时器），
 * 并标「由模型创建」；单会话 20 个定时任务的上限；超时参数被夹在上限内；只能动自己会话的东西。
 */

function fakeHost(over: Partial<WakeHost> = {}) {
  const created: Array<{ sessionId: string; spec: ScheduleSpec; expiresAt: number | null }> = [];
  const schedules: Array<{ id: string; sessionId: string; live: boolean }> = [];
  const started: any[] = [];
  const marked: string[] = [];
  const host: WakeHost = {
    now: () => 1_000_000,
    createSchedule: (sessionId, spec, expiresAt) => {
      created.push({ sessionId, spec, expiresAt });
      const id = `sched_${created.length}`;
      schedules.push({ id, sessionId, live: true });
      return { ok: true, id, describe: '每 1 分钟', nextRunAt: 0 };
    },
    listSchedules: (sessionId) => schedules.filter((s) => s.sessionId === sessionId).map((s) => ({
      id: s.id, describe: '每 1 分钟', prompt: 'p', runs: 0, maxRuns: 3, paused: false, terminal: s.live ? null : 'completed',
      nextRunAt: 0, createdBy: 'model' as const, expiresAt: null,
    })),
    deleteSchedule: (sessionId, id) => {
      const i = schedules.findIndex((s) => s.id === id && s.sessionId === sessionId);
      if (i < 0) return { ok: false, error: 'not found' };
      schedules.splice(i, 1);
      return { ok: true };
    },
    bg: {
      start: (input) => { started.push(input); return { ok: true, job: { jobId: 'bg_1', sessionId: input.sessionId, kind: input.kind, label: input.label, command: input.command, state: 'running', startedAt: 0, endedAt: null, exitCode: null, pid: 1, events: 0 } }; },
      status: (sid, id) => (sid === 's1' && id === 'bg_1' ? { jobId: 'bg_1', sessionId: 's1', kind: 'run', label: 'x', command: 'c', state: 'running', startedAt: 0, endedAt: null, exitCode: null, pid: 1, events: 0 } : null),
      tail: () => 'last lines',
      stop: async (id, _by, sid) => (sid === 's1' && id === 'bg_1' ? { ok: true } : { ok: false, error: 'no such' }),
    },
    cwdFor: (_sid, fallback) => fallback,
    markOutputSeen: (sid) => { marked.push(sid); },
    ...over,
  };
  return { host, created, schedules, started, marked };
}

const call = (name: string, args: any, host: WakeHost, sessionId = 's1') => callWakeTool(name, args, sessionId, '/work', host);

describe('工具清单', () => {
  test('七个工具都在，描述里写清何时用', () => {
    const names = wakeToolDefs().map((d) => d.name);
    assert.deepEqual(names.sort(), ['bg_run', 'bg_status', 'bg_stop', 'schedule_create', 'schedule_delete', 'schedule_list', 'watch'].sort());
    for (const n of names) assert.ok(isWakeTool(n));
    const all = wakeToolDefs().map((d) => d.description).join('\n');
    assert.match(all, /不要在一轮里 sleep 轮询/);
    assert.match(all, /过一段时间再看结果|等某个后台过程结束/);
  });

  test('schedule_create 的 schema：maxRuns 写明必填（循环类）', () => {
    const d = wakeToolDefs().find((x) => x.name === 'schedule_create')!;
    assert.ok(d.inputSchema.properties.maxRuns);
    assert.ok(d.inputSchema.properties.delaySec);
    assert.deepEqual(d.inputSchema.required, ['prompt', 'kind']);
  });

  test('kirolex-local 的 tools/list：远程会话（全套）和本地会话（browserOnly）都带上这几个', async () => {
    const deps = { log() {}, notice() {}, wake: { call: async () => ({ text: 'ok' }) } } as any;
    const remote = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { sessionId: 's1', workdir: '/w' }, deps);
    const local = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { sessionId: 's1', workdir: '/w', browserOnly: true }, deps);
    const rn = remote.result.tools.map((t: any) => t.name);
    const ln = local.result.tools.map((t: any) => t.name);
    assert.ok(rn.includes('local_bash') && rn.includes('bg_run') && rn.includes('schedule_create'));
    assert.ok(ln.includes('bg_run') && ln.includes('watch'));
    assert.ok(!ln.includes('local_bash'), '本地会话不给 local_* 那套');
    assert.ok(!toolDefs({}).some((t) => t.name === 'bg_run'), '不给 wake 就不列');
  });

  test('tools/call 经 deps.wake 转到 host', async () => {
    const seen: any[] = [];
    const deps = { log() {}, notice() {}, wake: { call: async (name: string, args: any, sid: string, workdir: string) => { seen.push({ name, args, sid, workdir }); return { text: 'done' }; } } } as any;
    const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bg_run', arguments: { command: 'x' } } }, { sessionId: 's9', workdir: '/w9', browserOnly: true }, deps);
    assert.equal(r.result.content[0].text, 'done');
    assert.deepEqual(seen, [{ name: 'bg_run', args: { command: 'x' }, sid: 's9', workdir: '/w9' }]);
  });
});

describe('schedule_*', () => {
  test('create：复用现有定时任务（host.createSchedule），发进创建它的会话，带过期时间', async () => {
    const h = fakeHost();
    const r = await call('schedule_create', { prompt: '查一下 date', kind: 'interval', everySec: 60, maxRuns: 3 }, h.host);
    assert.ok(!r.isError, r.text);
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].sessionId, 's1');
    assert.equal(h.created[0].spec.maxRuns, 3);
    assert.ok(typeof h.created[0].expiresAt === 'number');
    assert.match(r.text, /sched_1/);
  });

  test('create：参数不合法 → 工具返回错误，不建', async () => {
    const h = fakeHost();
    const r = await call('schedule_create', { prompt: 'x', kind: 'interval', everySec: 5, maxRuns: 3 }, h.host);
    assert.equal(r.isError, true);
    assert.equal(h.created.length, 0);
  });

  test('上限：单会话同时最多 20 个（只数还活着的），超出返回错误', async () => {
    const h = fakeHost();
    for (let i = 0; i < MAX_SCHEDULES_PER_SESSION; i += 1) {
      assert.ok(!(await call('schedule_create', { prompt: `p${i}`, kind: 'once', delaySec: 60 }, h.host)).isError);
    }
    const over = await call('schedule_create', { prompt: 'over', kind: 'once', delaySec: 60 }, h.host);
    assert.equal(over.isError, true);
    assert.match(over.text, /20/);
    h.schedules[0].live = false;
    assert.ok(!(await call('schedule_create', { prompt: 'again', kind: 'once', delaySec: 60 }, h.host)).isError, '结束了的不占名额');
    assert.ok(!(await call('schedule_create', { prompt: 'other', kind: 'once', delaySec: 60 }, h.host, 's2')).isError, '别的会话不受影响');
  });

  test('list 只列这条会话的；用户删掉之后 list 里就没了', async () => {
    const h = fakeHost();
    await call('schedule_create', { prompt: 'a', kind: 'once', delaySec: 60 }, h.host);
    await call('schedule_create', { prompt: 'b', kind: 'once', delaySec: 60 }, h.host, 's2');
    const r1 = await call('schedule_list', {}, h.host);
    assert.match(r1.text, /sched_1/);
    assert.doesNotMatch(r1.text, /sched_2/);
    h.schedules.splice(0, 1);                          // 用户在界面上删了
    const r2 = await call('schedule_list', {}, h.host);
    assert.doesNotMatch(r2.text, /sched_1/);
  });

  test('delete 只能删自己会话的', async () => {
    const h = fakeHost();
    await call('schedule_create', { prompt: 'a', kind: 'once', delaySec: 60 }, h.host);
    assert.equal((await call('schedule_delete', { id: 'sched_1' }, h.host, 's2')).isError, true);
    assert.ok(!(await call('schedule_delete', { id: 'sched_1' }, h.host)).isError);
  });
});

describe('bg_* / watch', () => {
  test('bg_run：立即返回 jobId；cwd = 会话工作目录；超时夹在上限内', async () => {
    const h = fakeHost();
    const r = await call('bg_run', { command: 'sleep 20; echo done', label: '等', timeoutSec: 10 ** 9 }, h.host);
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /bg_1/);
    assert.equal(h.started[0].cwd, '/work');
    assert.equal(h.started[0].kind, 'run');
    assert.equal(h.started[0].timeoutMs, BG_MAX_TIMEOUT_SEC * 1000);
  });

  test('watch：默认 30 分钟、上限 2 小时', async () => {
    const h = fakeHost();
    await call('watch', { command: 'tail -f x', label: 'l' }, h.host);
    await call('watch', { command: 'tail -f x', label: 'l', timeoutSec: 99999 }, h.host);
    assert.equal(h.started[0].kind, 'watch');
    assert.equal(h.started[0].timeoutMs, WATCH_DEFAULT_TIMEOUT_SEC * 1000);
    assert.equal(h.started[1].timeoutMs, WATCH_MAX_TIMEOUT_SEC * 1000);
  });

  test('bg_run 没给 command → 错误', async () => {
    const h = fakeHost();
    assert.equal((await call('bg_run', {}, h.host)).isError, true);
  });

  test('bg_status / bg_stop 只认自己会话的', async () => {
    const h = fakeHost();
    const ok = await call('bg_status', { jobId: 'bg_1' }, h.host);
    assert.ok(!ok.isError);
    assert.match(ok.text, /running/);
    assert.match(ok.text, /last lines/);
    assert.equal((await call('bg_status', { jobId: 'bg_1' }, h.host, 's2')).isError, true);
    assert.equal((await call('bg_stop', { jobId: 'bg_1' }, h.host, 's2')).isError, true);
    assert.ok(!(await call('bg_stop', { jobId: 'bg_1' }, h.host)).isError);
  });

  test('bg_status 把输出交给模型之前，先给这条会话打上「见过后台输出」的标记（第一次唤醒之前就读了、随后那一轮失败也不留副本）', async () => {
    const order: string[] = [];
    const h = fakeHost();
    h.host.markOutputSeen = (sid) => { order.push('mark:' + sid); };
    const tail = h.host.bg.tail;
    h.host.bg.tail = (sid, id) => { order.push('tail'); return tail(sid, id); };
    await call('bg_status', { jobId: 'bg_1' }, h.host);
    assert.deepEqual(order, ['mark:s1', 'tail']);
  });

  test('别的会话问不到的那种（没有这个任务）：不打标记', async () => {
    const h = fakeHost();
    await call('bg_status', { jobId: 'bg_1' }, h.host, 's2');
    assert.deepEqual(h.marked, []);
  });
});
