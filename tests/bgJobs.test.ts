import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  BG_TAIL_BYTES,
  BgJobManager,
  MAX_JOBS_PER_SESSION,
  interruptedNotice,
  WATCH_MAX_LINE_CHARS,
  WATCH_MAX_PENDING_CHARS,
  takeInterruptedJobs,
  writeRunningJobs,
  type BgJobDeps,
} from '../src/main/bgJobs.ts';
import { WinJobHost } from '../src/main/winJob.ts';

/**
 * 后台命令（`bg_run`）和监视（`watch`）—— 真起进程跑（用本机这个 node），不 mock。
 *
 * 守的是：立即返回、退出时把「退出码 + 输出末尾（4KB 截断）」作为一条唤醒发回会话；
 * 监视每行一个事件、200ms 内合并、刷屏被限流停掉并说明；超时；用户停掉只杀自己起的进程；
 * 单会话上限；重启后补「已中断」；日志只记 jobId、命令前 80 字、退出码。
 */

const NODE = `"${process.execPath}"`;
/** 一条跑 node 脚本的 shell 命令（脚本里只用单引号）。 */
const nodeCmd = (js: string) => `${NODE} -e "${js}"`;

/*
 * 真起进程的等待上限按看板那台 Windows 机实测给足：那里 `node -e 0` 2–8 s、作业对象辅助进程
 * （PowerShell + Add-Type）冷启动 8 s 起、忙时 15 s+，原来 15 s 的固定上限时好时坏。
 * 这些只是「等多久算真卡住」，不是被测行为；被测的超时（1500 / 8000 / 12_000 那些）不跟着改。
 */
const SLOW_SPAWN_MS = 120_000;
/** 不是在测超时的任务：任务自己的 timeoutMs 也给足，别让慢启动把「正常退出」变成「超时」。 */
const LONG_JOB_MS = 300_000;

/** `detail`：超时时一并打印的现场（例如任务当时的状态），好看出卡在哪一步。 */
async function waitFor(cond: () => boolean, what: string, timeoutMs = SLOW_SPAWN_MS, detail?: () => unknown): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      assert.fail(`等不到：${what}（等了 ${Date.now() - start} ms，上限 ${timeoutMs} ms）${detail ? `；当时：${JSON.stringify(detail())}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const managers: BgJobManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.stopAll();
  for (const pid of testPids.splice(0)) { try { process.kill(pid); } catch { /* 已经没了（正常情况） */ } }
});

function harness(over: Partial<BgJobDeps> = {}) {
  const wakes: Array<{ sessionId: string; text: string; jobId: string }> = [];
  const notes: Array<{ sessionId: string; text: string }> = [];
  const logs: string[] = [];
  const m = new BgJobManager({
    wake: (sessionId, text, job) => { wakes.push({ sessionId, text, jobId: job.jobId }); },
    note: (sessionId, text) => { notes.push({ sessionId, text }); },
    changed: () => {},
    log: (msg) => logs.push(msg),
    ...over,
  });
  managers.push(m);
  return { m, wakes, notes, logs };
}

const cwd = os.tmpdir();

/** 一个放到后台、把自己 pid 写进文件、然后一直活着的 node（模拟 `nohup x &`）。 */
const bgChild = (pidFile: string, redirect: boolean) => {
  const js = "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
  const node = `${NODE} -e "${js}" "${pidFile}"`;
  /* 命令本身等到后台那个写下 pid 才退：结束时的清理很快，不等的话它还没来得及写 pid 就被收掉了，测试就看不到它 */
  const waitPid = `${NODE} -e "const t=setInterval(()=>{if(require('fs').existsSync(process.argv[1]))clearInterval(t)},50)" "${pidFile}"`;
  return process.platform === 'win32'
    ? `start /b "" ${node}${redirect ? ' >nul 2>nul' : ''} & ${waitPid} & echo parent-done`
    : `(${node}${redirect ? ' >/dev/null 2>&1' : ''} &) ; ${waitPid} ; echo parent-done`;
};
/** 测试自己起的后台进程：断言失败也要在 afterEach 里收掉，别留在机器上。 */
const testPids: number[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readPid = async (f: string) => {
  await waitFor(() => fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim() !== '', '后台子进程写下 pid');
  const pid = Number(fs.readFileSync(f, 'utf8'));
  testPids.push(pid);
  return pid;
};
const pidFileFor = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kx-bgpid-')), 'pid');


describe('bg_run', () => {
  test('立即返回 jobId；退出时唤醒，带退出码和输出', async () => {
    const h = harness();
    const t0 = Date.now();
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd("setTimeout(()=>{console.log('done');process.exit(3)},300)"), label: '等一下', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(Date.now() - t0 < 1000, 'start 必须立即返回');
    assert.equal(h.m.list('s1')[0].state, 'running');
    await waitFor(() => h.wakes.length === 1, '退出唤醒', undefined, () => h.m.status('s1', r.job.jobId));
    assert.match(h.wakes[0].text, /等一下/);
    assert.match(h.wakes[0].text, /3/);
    assert.match(h.wakes[0].text, /done/);
    assert.equal(h.wakes[0].sessionId, 's1');
    assert.equal(h.m.status('s1', r.job.jobId)?.state, 'exited');
    assert.equal(h.m.status('s1', r.job.jobId)?.exitCode, 3);
  });

  test('输出末尾截到 4KB，保留的是**最后**那段', async () => {
    const h = harness();
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd("process.stdout.write('A'.repeat(20000)+'TAILEND')"), label: '大输出', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    await waitFor(() => h.wakes.length === 1, '退出唤醒', undefined, () => h.m.status('s1', r.job.jobId));
    assert.match(h.wakes[0].text, /TAILEND/);
    const as = (h.wakes[0].text.match(/A/g) || []).length;
    assert.ok(as <= BG_TAIL_BYTES, `A 有 ${as} 个，超过 4KB`);
    assert.ok(as > BG_TAIL_BYTES - 100, '截断不该截掉太多');
  });

  test('超时：结束进程并唤醒说明超时', async () => {
    const h = harness();
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd('setInterval(()=>{},1000)'), label: '卡住的', cwd, timeoutMs: 1500 });
    assert.ok(r.ok);
    await waitFor(() => h.wakes.length === 1, '超时唤醒');
    assert.equal(h.m.status('s1', r.job.jobId)?.state, 'timeout');
    assert.match(h.wakes[0].text, /超时|timed out/i);
  });

  test('用户停止：进程被结束，会话里说一声，不再唤醒模型', async () => {
    const h = harness();
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd('setInterval(()=>{},1000)'), label: '长跑', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    const pid = r.job.pid!;
    assert.ok(pid > 0);
    const s = await h.m.stop(r.job.jobId, 'user');
    assert.equal(s.ok, true);
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, '进程被结束');
    assert.equal(h.m.status('s1', r.job.jobId)?.state, 'stopped');
    assert.equal(h.notes.length, 1);
    assert.match(h.notes[0].text, /长跑/);
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(h.wakes.length, 0, '停掉的不再唤醒');
  });

  test('只能看 / 停自己会话的任务', async () => {
    const h = harness();
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd('setInterval(()=>{},1000)'), label: 'x', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    assert.equal(h.m.status('s2', r.job.jobId), null);
    const s = await h.m.stop(r.job.jobId, 'model', 's2');
    assert.equal(s.ok, false);
    assert.equal(h.m.status('s1', r.job.jobId)?.state, 'running');
  });

  test('上限：单会话同时最多 10 个，超出返回错误；别的会话不受影响', async () => {
    const h = harness();
    for (let i = 0; i < MAX_JOBS_PER_SESSION; i += 1) {
      assert.ok(h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd('setInterval(()=>{},1000)'), label: `j${i}`, cwd, timeoutMs: LONG_JOB_MS }).ok);
    }
    const over = h.m.start({ sessionId: 's1', kind: 'watch', command: nodeCmd('setInterval(()=>{},1000)'), label: 'over', cwd, timeoutMs: LONG_JOB_MS });
    assert.equal(over.ok, false);
    assert.match((over as any).error, /10/);
    assert.ok(h.m.start({ sessionId: 's2', kind: 'run', command: nodeCmd('1'), label: 'other', cwd, timeoutMs: LONG_JOB_MS }).ok);
  });

  test('命令自己退了、但它放到后台的进程还占着管道（nohup x &）：照样按退出唤醒，而且那个子进程被清掉、不在任务结束后继续跑', async () => {
    const h = harness();
    const pidFile = pidFileFor();
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: bgChild(pidFile, false), label: '放后台', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    const pid = await readPid(pidFile);
    await waitFor(() => h.wakes.length === 1, '退出唤醒', undefined, () => h.m.status('s1', r.job.jobId));
    assert.match(h.wakes[0].text, /parent-done/);
    await waitFor(() => !alive(pid), '任务结束时它留下的子进程也被结束');
  });

  test('放到后台、输出重定向走了（不占管道）的子进程：任务结束时同样清掉', async () => {
    const h = harness();
    const pidFile = pidFileFor();
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: bgChild(pidFile, true), label: '放后台2', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    const pid = await readPid(pidFile);
    await waitFor(() => h.wakes.length === 1, '退出唤醒', undefined, () => h.m.status('s1', r.job.jobId));
    await waitFor(() => !alive(pid), '子进程被结束');
  });

  test('退出 KiroLex（stopAllSync）时：命令已退、子进程还占着管道的那种也清掉', async () => {
    const h = harness();
    const pidFile = pidFileFor();
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: bgChild(pidFile, false), label: '放后台3', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    const pid = await readPid(pidFile);
    const job = (h.m as any).jobs.get(r.job.jobId);
    await waitFor(() => job.child.exitCode !== null, 'shell 已经退了');
    h.m.stopAllSync();
    await waitFor(() => !alive(pid), '退出时子进程被结束');
  });

  test('工作目录不存在：直接报错，不起进程', () => {
    const h = harness();
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: 'echo x', label: 'x', cwd: path.join(cwd, 'no-such-dir-kirolex-xyz'), timeoutMs: 1000 });
    assert.equal(r.ok, false);
  });

  test('日志只记 jobId、命令前 80 字和退出码 —— 不记输出', async () => {
    const h = harness();
    const long = nodeCmd(`console.log('SECRET_'+'TOKEN_123');/*${'x'.repeat(200)}*/`);
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: long, label: 'x', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    await waitFor(() => h.wakes.length === 1, '退出', undefined, () => h.m.status('s1', r.job.jobId));
    assert.ok(h.wakes[0].text.includes('SECRET_TOKEN_123'), '输出原样回到会话');
    for (const line of h.logs) {
      assert.ok(!line.includes('SECRET_TOKEN_123'), `日志里出现了输出：${line}`);
      assert.ok(!line.includes('x'.repeat(100)), '命令只记前 80 字');
    }
    assert.ok(h.logs.some((l) => l.includes(r.job.jobId) && /exit=0/.test(l)), JSON.stringify(h.logs));
  });
});

describe('watch：结束 / 超时那一刻的最后一批输出恰好触发限流', () => {
  test('命令退出时：只通知一次（限流那条），状态保留 rate-limited，不再补一条「已结束」', async () => {
    const h = harness({ coalesceMs: 10_000, rateLimit: { events: 0, windowMs: 60_000 } });
    const r = h.m.start({ sessionId: 's1', kind: 'watch', command: nodeCmd("console.log('last')"), label: '退出时限流', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    await waitFor(() => h.m.status('s1', r.job.jobId)?.state !== 'running', '结束');
    await new Promise((res) => setTimeout(res, 2500));   // 留出 close / 管道排空那条路
    assert.equal(h.m.status('s1', r.job.jobId)?.state, 'rate-limited');
    assert.equal(h.wakes.length, 1, h.wakes.map((w) => w.text).join('\n---\n'));
    assert.match(h.wakes[0].text, /限流|too many/i);
  });

  test('超时时：同样只通知一次，状态保留 rate-limited', async () => {
    const h = harness({ coalesceMs: 10_000, rateLimit: { events: 0, windowMs: 60_000 } });
    const r = h.m.start({ sessionId: 's1', kind: 'watch', command: nodeCmd("console.log('pending');setInterval(()=>{},1000)"), label: '超时时限流', cwd, timeoutMs: 12_000 });
    assert.ok(r.ok);
    /* 前提：超时之前那一行已经攒着（机器忙时 node 起得慢，不等这一步就测不到要测的情况） */
    const job = (h.m as any).jobs.get(r.job.jobId);
    await waitFor(() => job.pendingLines.length > 0, '那一行已经攒着、还没发', 11_000);
    assert.equal(h.m.status('s1', r.job.jobId)?.state, 'running');
    await waitFor(() => h.m.status('s1', r.job.jobId)?.state !== 'running', '超时结束');
    await new Promise((res) => setTimeout(res, 2500));
    assert.equal(h.m.status('s1', r.job.jobId)?.state, 'rate-limited');
    assert.equal(h.wakes.length, 1, h.wakes.map((w) => w.text).join('\n---\n'));
  });
});

describe('watch：一直输出但不换行', () => {
  test('半行到上限就截成一个事件（每个事件不超过 4KB 多一点），照样走限流、内存不无限涨', async () => {
    const h = harness({ coalesceMs: 5, rateLimit: { events: 3, windowMs: 60_000 } });
    const js = "const s='x'.repeat(65536);setInterval(()=>process.stdout.write(s),20)";
    const r = h.m.start({ sessionId: 's1', kind: 'watch', command: nodeCmd(js), label: '不换行', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    await waitFor(() => h.m.status('s1', r.job.jobId)?.state === 'rate-limited', '不换行的刷屏也被限流停掉');
    const events = h.wakes.filter((w) => /x{100}/.test(w.text));
    assert.ok(events.length >= 1 && events.length <= 3, `事件数 ${events.length}`);
    for (const e of events) assert.ok(Buffer.byteLength(e.text) < BG_TAIL_BYTES + 1024, `事件 ${Buffer.byteLength(e.text)} 字节`);
    const job = (h.m as any).jobs.get(r.job.jobId);
    assert.ok(job.partial.length <= WATCH_MAX_LINE_CHARS, `半行留了 ${job.partial.length}`);
    assert.ok(job.pendingLines.join('').length <= WATCH_MAX_PENDING_CHARS, '攒着的行也有上限');
  });
});

describe('watch', () => {
  test('每行 stdout 一个事件：间隔打印 3 行 → 3 次唤醒，退出再说一声', async () => {
    const h = harness({ coalesceMs: 20 });
    const js = "let i=0;const t=setInterval(()=>{console.log('line'+(++i));if(i===3){clearInterval(t)}},150)";
    const r = h.m.start({ sessionId: 's1', kind: 'watch', command: nodeCmd(js), label: '三行', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    await waitFor(() => h.wakes.length === 4, '3 次事件 + 结束');
    assert.match(h.wakes[0].text, /line1/);
    assert.match(h.wakes[1].text, /line2/);
    assert.match(h.wakes[2].text, /line3/);
    assert.doesNotMatch(h.wakes[0].text, /line2/);
    assert.match(h.wakes[3].text, /三行/);
  });

  test('200ms 内的几行合并成一条', async () => {
    const h = harness();
    const r = h.m.start({ sessionId: 's1', kind: 'watch', command: nodeCmd("console.log('a1');console.log('a2');console.log('a3');setTimeout(()=>{},400)"), label: '一起', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    await waitFor(() => h.wakes.length === 2, '一条事件 + 结束');
    assert.match(h.wakes[0].text, /a1[\s\S]*a2[\s\S]*a3/);
  });

  test('刷屏：超过限流（窗口内事件数）就停掉，并在会话里说明原因', async () => {
    const h = harness({ coalesceMs: 5, rateLimit: { events: 5, windowMs: 60_000 } });
    const r = h.m.start({ sessionId: 's1', kind: 'watch', command: nodeCmd("setInterval(()=>console.log('spam'),30)"), label: '刷屏', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    await waitFor(() => h.m.status('s1', r.job.jobId)?.state === 'rate-limited', '被限流');
    await waitFor(() => h.wakes.some((w) => /限流|too many|rate/i.test(w.text)), '说明原因');
    const events = h.wakes.filter((w) => /spam/.test(w.text)).length;
    assert.ok(events <= 5, `限流之后还在发：${events}`);
    const pid = r.job.pid!;
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, '刷屏的进程被结束');
  });

  test('超时结束并通知', async () => {
    const h = harness();
    const r = h.m.start({ sessionId: 's1', kind: 'watch', command: nodeCmd('setInterval(()=>{},1000)'), label: '等事件', cwd, timeoutMs: 1500 });
    assert.ok(r.ok);
    await waitFor(() => h.wakes.length === 1, '超时通知');
    assert.equal(h.m.status('s1', r.job.jobId)?.state, 'timeout');
  });
});

describe('进程归属只靠进程组 / 作业对象：不按 pid / ppid / 出生时间推断', () => {
  const SRC = path.join(import.meta.dirname, '..', 'src', 'main');
  const code = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('bgJobs 里没有任何按快照推断归属的代码（也就不会把复用了根 pid / 子 pid 的无关程序认成自己的）', () => {
    const B = code('bgJobs.ts');
    for (const gone of ['listWindowsProcesses', 'descendantsOf', 'parseProcRows', 'Win32_Process', 'ppid', 'taskkill', 'strayChildren', 'leftoversOf', 'ownedProcesses', 'fileTimeToMs']) {
      assert.ok(!B.includes(gone), `bgJobs.ts 里还有 ${gone}`);
    }
    assert.match(B, /spawn\('bash', \['-lc', command\], \{ cwd, detached: true/, 'POSIX：自己的进程组');
    assert.match(B, /process\.kill\(-pgid, 'SIGTERM'\)/);
    assert.match(B, /process\.kill\(-pgid, 0\)/, '命令退了以后按组判断有没有残留');
  });

  test('Windows：作业对象设了 KILL_ON_JOB_CLOSE，结束 = TerminateJobObject；只按句柄放进作业，不按 pid 找进程树', () => {
    const W = code('winJob.ts');
    assert.match(W, /LimitFlags = 0x2000/);
    assert.match(W, /TerminateJobObject\(job, 1\)/);
    assert.match(W, /AssignProcessToJobObject\(job, p\)/);
    assert.ok(!/Win32_Process|ParentProcessId|taskkill/.test(W));
  });

  test('一个跟任务毫不相干的进程：任务结束、停止、超时、退出 KiroLex 之后都还活着', async () => {
    const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      const h = harness();
      const a = h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd("console.log('x')"), label: 'a', cwd, timeoutMs: LONG_JOB_MS });
      const b = h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd('setInterval(()=>{},1000)'), label: 'b', cwd, timeoutMs: LONG_JOB_MS });
      const c = h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd('setInterval(()=>{},1000)'), label: 'c', cwd, timeoutMs: 1500 });
      assert.ok(a.ok && b.ok && c.ok);
      await waitFor(() => h.m.status('s1', a.job.jobId)?.state === 'exited', 'a 结束');
      await h.m.stop(b.job.jobId, 'user');
      await waitFor(() => h.m.status('s1', c.job.jobId)?.state === 'timeout', 'c 超时');
      h.m.stopAllSync();
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(bystander.exitCode === null && alive(bystander.pid!), '无关进程被误杀了');
    } finally {
      bystander.kill();
    }
  });
});

describe('放到后台的子进程：停止 / 超时时连带结束', () => {
  /* 只在 Windows：那边进程归属靠作业对象，Node detached 起的子进程也在作业里。POSIX 上 detached 会 setsid、
     自己另起一个会话和进程组，本来就不在这条命令的进程组里（POSIX 这边用下面 / 上面那些 `(x &)` 的测试覆盖） */
  test('命令里用 Node 的 detached 起的「守护」子进程：命令结束时同样被结束（Windows 作业对象）', { skip: process.platform !== 'win32' }, async () => {
    const h = harness();
    const pidFile = pidFileFor();
    const script = path.join(path.dirname(pidFile), 'daemonize.js');
    const leaf = "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
    fs.writeFileSync(script, `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)},process.argv[2]],{detached:true,stdio:'ignore'}).unref();`
      + `const t=setInterval(()=>{if(require('fs').existsSync(process.argv[2]))clearInterval(t)},50)`);
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: `${NODE} "${script}" "${pidFile}"`, label: '守护', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    const pid = await readPid(pidFile);
    await waitFor(() => h.wakes.length === 1, '退出唤醒', undefined, () => h.m.status('s1', r.job.jobId));
    await waitFor(() => !alive(pid), 'detached 起的子进程也被结束');
  });

  test('用户停止：命令还在跑、它放到后台的子进程也一起结束', async () => {
    const h = harness();
    const pidFile = pidFileFor();
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: `${bgChild(pidFile, true)} & ${NODE} -e "setInterval(()=>{},1000)"`, label: '停我', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    const pid = await readPid(pidFile);
    await h.m.stop(r.job.jobId, 'user');
    await waitFor(() => !alive(pid), '停止时后台子进程也被结束');
  });

  test('超时：同样连带结束', async () => {
    const h = harness();
    const pidFile = pidFileFor();
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: `${bgChild(pidFile, true)} & ${NODE} -e "setInterval(()=>{},1000)"`, label: '超时', cwd, timeoutMs: 8000 });
    assert.ok(r.ok);
    const pid = await readPid(pidFile);
    await waitFor(() => h.m.status('s1', r.job.jobId)?.state === 'timeout', '超时');
    await waitFor(() => !alive(pid), '超时时后台子进程也被结束');
  });

  test('退出 KiroLex（stopAllSync）时命令还在跑：命令和它放到后台的子进程都结束', async () => {
    const h = harness();
    const pidFile = pidFileFor();
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: `${bgChild(pidFile, true)} & ${NODE} -e "setInterval(()=>{},1000)"`, label: '退出', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    const pid = await readPid(pidFile);
    h.m.stopAllSync();
    await waitFor(() => !alive(pid), '退出时后台子进程被结束');
  });
});

describe('Windows：作业还没放好的时候停止 / 超时（辅助进程启动慢）', { skip: process.platform !== 'win32' }, () => {
  /** 一个可以控制什么时候答复的作业宿主：记下每次 assign 时闸门是不是还活着。 */
  function slowHost(answer: boolean) {
    const calls: Array<{ pid: number; aliveAtCall: boolean }> = [];
    const terminated: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const host = {
      assign: async (_id: string, pid: number) => { calls.push({ pid, aliveAtCall: alive(pid) }); await gate; return answer && alive(pid); },
      terminate: async (id: string) => { terminated.push(id); },
      killAllSync: () => {},
    };
    return { host, calls, terminated, release };
  }

  test('停止发生在 assign 答复之前：闸门一直活到答复（pid 不会空出来被复用）；放好之后按作业结束，命令根本没起', async () => {
    const s = slowHost(true);
    const h = harness({ jobHost: s.host });
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd("console.log('SHOULD-NOT-RUN')"), label: '慢', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    await waitFor(() => s.calls.length === 1, '开始 assign');
    const stopping = h.m.stop(r.job.jobId, 'user');
    await new Promise((res) => setTimeout(res, 500));
    assert.ok(alive(s.calls[0].pid), 'assign 还没答复时闸门不能先被结束');
    s.release();
    await stopping;
    assert.equal(s.calls.length, 1, '不会再拿旧 pid 去 assign');
    assert.ok(s.calls[0].aliveAtCall, 'assign 的时候闸门是活着的');
    assert.deepEqual(s.terminated, [r.job.jobId], '放好之后按作业结束');
    assert.equal(h.m.status('s1', r.job.jobId)?.state, 'stopped');
    assert.ok(!h.wakes.some((w) => /SHOULD-NOT-RUN/.test(w.text)) && !(h.m.tail('s1', r.job.jobId) || '').includes('SHOULD-NOT-RUN'), '命令不该被放行');
  });

  test('超时发生在 assign 答复之前、而且最后没放进去：答复之后才让闸门自己退出（只结束它自己），不碰别的', async () => {
    const s = slowHost(false);
    const h = harness({ jobHost: s.host });
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd("console.log('SHOULD-NOT-RUN')"), label: '慢2', cwd, timeoutMs: 800 });
    assert.ok(r.ok);
    await waitFor(() => s.calls.length === 1, '开始 assign');
    await new Promise((res) => setTimeout(res, 1500));
    assert.ok(alive(s.calls[0].pid), '答复之前闸门还活着');
    s.release();
    await waitFor(() => !alive(s.calls[0].pid), '答复之后闸门退出');
    assert.equal(h.m.status('s1', r.job.jobId)?.state, 'timeout');
    assert.deepEqual(s.terminated, [], '没放进作业就没有作业可结束');
    assert.ok(!(h.m.tail('s1', r.job.jobId) || '').includes('SHOULD-NOT-RUN'));
  });
});

describe('Windows：作业对象辅助进程只起一个，之后的后台任务复用它', { skip: process.platform !== 'win32' }, () => {
  test('连续起 3 个后台任务：只起了 1 次辅助进程（第 2、3 个不再新起 PowerShell、不再编译）', async () => {
    const hostLogs: string[] = [];
    const host = new WinJobHost((m) => hostLogs.push(m), SLOW_SPAWN_MS, fs.mkdtempSync(path.join(os.tmpdir(), 'kx-jobcache-')));
    try {
      const h = harness({ jobHost: host });
      for (let i = 1; i <= 3; i++) {
        const r = h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd(`console.log('run-${i}')`), label: `r${i}`, cwd, timeoutMs: LONG_JOB_MS });
        assert.ok(r.ok);
        await waitFor(() => h.wakes.length === i, `第 ${i} 个结束`, undefined, () => h.m.status('s1', r.job.jobId));
        assert.match(h.wakes[i - 1].text, new RegExp(`run-${i}`));
      }
      assert.equal(host.starts, 1, '辅助进程只该起一次');
      assert.ok(!hostLogs.some((l) => /assign failed|did not start/.test(l)), `3 个都该放进了作业：${hostLogs.join(' | ')}`);
    } finally {
      host.killAllSync();
    }
  });
});

describe('放不进作业对象（极端失败）：只结束自己握着句柄的那条命令', () => {
  test('命令照常跑、输出照常回来；停止时命令被结束', { skip: process.platform !== 'win32' }, async () => {
    const failing = { assign: async () => false, terminate: async () => {}, killAllSync: () => {} };
    const h = harness({ jobHost: failing });
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd("console.log('still-runs')"), label: 'fallback', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    await waitFor(() => h.wakes.length === 1, '退出唤醒', undefined, () => h.m.status('s1', r.job.jobId));
    assert.match(h.wakes[0].text, /still-runs/);

    const pidFile = pidFileFor();
    const js = "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
    const s = h.m.start({ sessionId: 's1', kind: 'run', command: `${NODE} -e "${js}" "${pidFile}"`, label: 'fallback-stop', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(s.ok);
    const pid = await readPid(pidFile);
    await h.m.stop(s.job.jobId, 'user');
    await waitFor(() => h.m.status('s1', s.job.jobId)?.state === 'stopped', '已停止');
    /* 这条命令是 cmd.exe 起的 node：闸门握着的是 cmd.exe，结束 cmd.exe 不会连带它 —— 放不进作业时就是不去推断、不多杀 */
    try { process.kill(pid); } catch { /* 已经没了 */ }
  });
});

describe('重启：跑着的任务留下「已中断」', () => {
  let home = '';
  afterEach(() => { if (home) fs.rmSync(home, { recursive: true, force: true }); home = ''; });

  test('登记的是正在跑的；重启后读出来一次（读完清空），并能生成提示', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-bg-'));
    writeRunningJobs(home, [
      { jobId: 'bg_1', sessionId: 's1', kind: 'run', label: '等栈', command: 'until aws ...', startedAt: 1 },
      { jobId: 'bg_2', sessionId: 's2', kind: 'watch', label: '看日志', command: 'tail -f x', startedAt: 2 },
    ]);
    const first = takeInterruptedJobs(home);
    assert.deepEqual(first.map((j) => j.jobId), ['bg_1', 'bg_2']);
    assert.deepEqual(takeInterruptedJobs(home), [], '读一次就清空，不会每次启动都补');
    const text = interruptedNotice(first[0], 'zh');
    assert.match(text, /KiroLex 重启/);
    assert.match(text, /等栈/);
    assert.match(text, /已中断/);
  });

  test('登记里命令只留前 80 字', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-bg-'));
    writeRunningJobs(home, [{ jobId: 'bg_1', sessionId: 's1', kind: 'run', label: 'x', command: 'y'.repeat(500), startedAt: 1 }]);
    const raw = fs.readFileSync(path.join(home, '.kirolex', 'bg-jobs.json'), 'utf8');
    assert.ok(!raw.includes('y'.repeat(81)));
  });

  test('manager 每次变化都把正在跑的交给 changed（index.ts 据此落盘）', async () => {
    const seen: number[] = [];
    const h = harness({ changed: (running) => { seen.push(running.length); } });
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd("setTimeout(()=>{},200)"), label: 'x', cwd, timeoutMs: LONG_JOB_MS });
    assert.ok(r.ok);
    await waitFor(() => h.wakes.length === 1, '退出', undefined, () => h.m.status('s1', r.job.jobId));
    assert.ok(seen.includes(1));
    assert.equal(seen[seen.length - 1], 0);
  });
});

/**
 * 定时任务的 `checkCommand`：和 bg_run 同一套起进程 / 结束 / 超时，但结果交回调用方（不唤醒会话、
 * 不出现在后台任务列表里、不占单会话 10 个的名额、不进重启登记）。
 */
describe('runCheck（定时任务的检查命令）', () => {
  test('退出码和输出交回调用方，不唤醒会话', async () => {
    const h = harness();
    const r = await h.m.runCheck({ sessionId: 's1', command: nodeCmd("console.log('2 open');process.exit(1)"), cwd, timeoutMs: LONG_JOB_MS });
    assert.equal(r.status, 'exited');
    assert.equal(r.status === 'exited' && r.code, 1);
    assert.match(r.output, /2 open/);
    assert.equal(h.wakes.length, 0);
  });

  test('超时 → timeout，进程被结束', async () => {
    const h = harness();
    const r = await h.m.runCheck({ sessionId: 's1', command: nodeCmd('setInterval(()=>{},1000)'), cwd, timeoutMs: 1500 });
    assert.equal(r.status, 'timeout');
    assert.equal(h.wakes.length, 0);
  });

  test('工作目录不存在 → failed', async () => {
    const h = harness();
    const r = await h.m.runCheck({ sessionId: 's1', command: 'echo x', cwd: path.join(cwd, 'no-such-dir-kirolex-xyz'), timeoutMs: 1000 });
    assert.equal(r.status, 'failed');
  });

  test('不出现在列表 / 重启登记里，不占名额', async () => {
    const seen: number[] = [];
    const h = harness({ changed: (running) => { seen.push(running.length); } });
    const p = h.m.runCheck({ sessionId: 's1', command: nodeCmd('setTimeout(()=>{},400)'), cwd, timeoutMs: LONG_JOB_MS });
    assert.equal(h.m.list('s1').length, 0);
    for (let i = 0; i < MAX_JOBS_PER_SESSION; i += 1) {
      assert.ok(h.m.start({ sessionId: 's1', kind: 'run', command: nodeCmd('setTimeout(()=>{},300)'), label: `j${i}`, cwd, timeoutMs: LONG_JOB_MS }).ok);
    }
    await p;
    assert.ok(seen.every((n) => n <= MAX_JOBS_PER_SESSION));
  });
});

describe('runCheck：输出很长时按完整输出判断有没有变化', () => {
  const long = (head: string) => nodeCmd(`process.stdout.write('${head}\\n'+'x'.repeat(5000)+'\\n');process.exit(1)`);
  test('开头变了、后面 5000 字一样：指纹不同（末尾 4KB 一样也不算没变化）', async () => {
    const h = harness();
    const a = await h.m.runCheck({ sessionId: 's1', command: long('task-A:open'), cwd, timeoutMs: LONG_JOB_MS });
    const b = await h.m.runCheck({ sessionId: 's1', command: long('task-A:done'), cwd, timeoutMs: LONG_JOB_MS });
    const c = await h.m.runCheck({ sessionId: 's1', command: long('task-A:done'), cwd, timeoutMs: LONG_JOB_MS });
    assert.equal(a.status, 'exited');
    assert.ok(a.status === 'exited' && b.status === 'exited' && c.status === 'exited');
    assert.equal(a.output.slice(-1000), b.output.slice(-1000), '展示给模型的末尾一样');
    assert.ok(a.fingerprint && b.fingerprint);
    assert.notEqual(a.fingerprint, b.fingerprint);
    assert.equal(b.fingerprint, c.fingerprint, '完全一样的输出指纹一样');
  });
});
