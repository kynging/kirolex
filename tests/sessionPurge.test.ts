import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { moveDirToTrash, scheduleBackgroundRetries, waitAtMost, type FsOps } from '../src/main/sessionPurge.ts';
import { classifyDeleteResult, TOMBSTONED_NOTICE_KEY } from '../src/renderer/deleteOutcome.ts';
import { missingZh, t } from '../src/renderer/i18n.ts';
import { descendantsOf, forceKillExecutorTree, isSpawnedProcess, parseProcRows, snapshotExecutorTree, stillAlive, sweepExecutorChildren } from '../src/main/procTree.ts';

const SRC = path.join(import.meta.dirname, '..', 'src');
const busy = () => Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' });

/** 用真实 fs，但前 n 次 rename 抛 EBUSY —— 模拟「kiro-cli 还没放手 files/」。 */
function lockedFs(lockedTimes: number): FsOps & { renames: number; rms: number } {
  const ops: any = {
    renames: 0,
    rms: 0,
    existsSync: (p: string) => fs.existsSync(p),
    mkdirSync: (p: string, o: any) => fs.mkdirSync(p, o),
    renameSync: (a: string, b: string) => {
      ops.renames++;
      if (ops.renames <= lockedTimes) throw busy();
      fs.renameSync(a, b);
    },
    rm: async () => { ops.rms++; throw busy(); },
  };
  return ops;
}

describe('删除会话：目录被占用时要真正等待后重试', () => {
  let tmp = '';
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; });
  const setup = () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-purge-'));
    const dir = path.join(tmp, 'sessions', 'sid-1');
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'files', 'a.txt'), 'x');
    return { dir, trash: path.join(tmp, 'trash') };
  };

  test('（a）第一次移动失败、等一会儿后成功：结果是成功，目录进了回收站（可恢复）', async () => {
    const { dir, trash } = setup();
    const f = lockedFs(2);
    const slept: number[] = [];
    const err = await moveDirToTrash(dir, {
      trashDir: trash, name: 'sid-1', fsOps: f,
      sleep: async (ms) => { slept.push(ms); },
    });
    assert.equal(err, null);
    assert.equal(fs.existsSync(dir), false);
    const graves = fs.readdirSync(trash);
    assert.equal(graves.length, 1);
    assert.match(graves[0], /^sid-1__/);
    assert.ok(fs.existsSync(path.join(trash, graves[0], 'files', 'a.txt')), '内容完整地在回收站里');
    assert.equal(f.rms, 0, '移动成功就不该走强删');
    // 两次失败 → 两次等待，而且是逐次加长的真实等待（不是连着重试）
    assert.equal(slept.length, 2);
    assert.ok(slept[0] > 0 && slept[1] > slept[0]);
  });

  test('默认的等待合计约 3～5 秒，而且是真的在等（异步 sleep）', async () => {
    const { dir, trash } = setup();
    const slept: number[] = [];
    await moveDirToTrash(dir, { trashDir: trash, name: 'sid-1', fsOps: lockedFs(1000), sleep: async (ms) => { slept.push(ms); } });
    const total = slept.reduce((a, b) => a + b, 0);
    assert.ok(total >= 3000 && total <= 5000, `合计 ${total}ms`);
  });

  test('一直被占用：返回错误（主进程据此立墓碑、返回 tombstoned），目录原样还在', async () => {
    const { dir, trash } = setup();
    const f = lockedFs(1000);
    const err = await moveDirToTrash(dir, { trashDir: trash, name: 'sid-1', fsOps: f, delaysMs: [1, 1, 1], sleep: async () => {} });
    assert.ok(err && /EBUSY/.test(err), String(err));
    assert.equal(f.renames, 4);
    assert.equal(f.rms, 1, '最后一次仍走原来的强删兜底');
    assert.ok(fs.existsSync(path.join(dir, 'files', 'a.txt')));
  });

  test('不是「被占用」的错误（例如跨盘 rename）不白等，直接走兜底', async () => {
    const { dir, trash } = setup();
    let slept = 0;
    let rmCalled = 0;
    const f: FsOps = {
      existsSync: (p) => fs.existsSync(p),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      renameSync: () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); },
      rm: async (p, o) => { rmCalled++; await fs.promises.rm(p, o); },
    };
    const err = await moveDirToTrash(dir, { trashDir: trash, name: 'sid-1', fsOps: f, sleep: async () => { slept++; } });
    assert.equal(err, null);
    assert.equal(slept, 0);
    assert.equal(rmCalled, 1);
  });

  test('兜底强删是异步的：删的过程中主进程的事件循环照常往下跑（不卡界面、不卡别的会话）', async () => {
    const { dir, trash } = setup();
    let ticks = 0;
    let rmStarted = false;
    let ticksWhileRm = -1;
    const f: FsOps = {
      existsSync: (p) => fs.existsSync(p),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      renameSync: () => { throw busy(); },
      rm: async (p, o) => {
        rmStarted = true;
        const at = ticks;
        await new Promise((r) => setTimeout(r, 30));          // 模拟 rm 自己的重试等待
        ticksWhileRm = ticks - at;
        await fs.promises.rm(p, o);
      },
    };
    const timer = setInterval(() => { ticks++; }, 1);
    try {
      const err = await moveDirToTrash(dir, { trashDir: trash, name: 'sid-1', fsOps: f, delaysMs: [1], sleep: async () => {} });
      assert.equal(err, null);
    } finally { clearInterval(timer); }
    assert.ok(rmStarted);
    assert.ok(ticksWhileRm > 0, '兜底期间别的定时器要能跑');
    assert.equal(fs.existsSync(dir), false);
  });

  test('sessionPurge.ts 里不再有同步的 rmSync（兜底和后台补删都走异步 rm）', () => {
    const P = fs.readFileSync(path.join(SRC, 'main', 'sessionPurge.ts'), 'utf8');
    assert.doesNotMatch(P, /rmSync/);
    assert.match(P, /rm: \(p, o\) => fs\.promises\.rm\(p, o\)/);
    assert.match(P, /await f\.rm\(dir, \{ recursive: true, force: true, maxRetries: 3, retryDelay: 120 \}\)/);
  });

  test('默认用真的 fs：兜底强删（异步）真的把目录删掉', async () => {
    const { dir, trash } = setup();
    // 让 rename 失败的最省事办法：回收站路径被一个普通文件占着，mkdir 会抛非「被占用」的错误，直接走兜底
    fs.writeFileSync(trash, 'not a dir');
    const err = await moveDirToTrash(dir, { trashDir: trash, name: 'sid-1', sleep: async () => {} });
    assert.equal(err, null);
    assert.equal(fs.existsSync(dir), false);
  });

  test('目录本来就不在：直接算成功', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-purge-'));
    assert.equal(await moveDirToTrash(path.join(tmp, 'nope'), { trashDir: path.join(tmp, 'trash'), name: 'x' }), null);
  });
});

describe('删除会话：运行期间后台再试', () => {
  test('按 30 秒、2 分钟……依次再试，成功就停', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let calls = 0;
    scheduleBackgroundRetries(async () => ++calls >= 2, { setTimer: (fn, ms) => { timers.push({ fn, ms }); } });
    assert.deepEqual(timers.map((t) => t.ms), [30_000]);
    timers[0].fn();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(timers.map((t) => t.ms), [30_000, 120_000]);
    timers[1].fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 2);
    assert.equal(timers.length, 2, '成功之后不再排下一次');
  });

  test('次数用完就放弃（墓碑留给下次启动）；取消后不再试', async () => {
    const timers: Array<() => void> = [];
    let gaveUp = false;
    let calls = 0;
    scheduleBackgroundRetries(async () => { calls++; return false; }, {
      delaysMs: [1, 2], setTimer: (fn) => { timers.push(fn); }, onGiveUp: () => { gaveUp = true; },
    });
    timers[0](); await new Promise((r) => setImmediate(r));
    timers[1](); await new Promise((r) => setImmediate(r));
    assert.equal(calls, 2);
    assert.equal(gaveUp, true);

    const t2: Array<() => void> = [];
    let c2 = 0;
    const cancel = scheduleBackgroundRetries(async () => { c2++; return false; }, { setTimer: (fn) => { t2.push(fn); } });
    cancel();
    t2[0]();
    await new Promise((r) => setImmediate(r));
    assert.equal(c2, 0);
  });

  test('waitAtMost：完成就返回 true，卡住的最多等到上限', async () => {
    assert.equal(await waitAtMost(Promise.resolve(), 1000), true);
    assert.equal(await waitAtMost(Promise.reject(new Error('x')), 1000), true);
    assert.equal(await waitAtMost(new Promise(() => {}), 20), false);
  });
});

describe('渲染层：区分「被拒绝」和「已标记待删除」', () => {
  test('ok:true → 删除成功', () => {
    assert.equal(classifyDeleteResult({ ok: true }, 'zh').kind, 'deleted');
  });

  test('（b）tombstoned:true → 不是拒绝，只给不吓人的提示', () => {
    const o = classifyDeleteResult({ ok: false, tombstoned: true, error: 'EBUSY: resource busy or locked' }, 'zh');
    assert.equal(o.kind, 'tombstoned');
    assert.equal((o as any).notice, '会话已删除，部分文件被占用，稍后自动清理');
    assert.doesNotMatch((o as any).notice, /没有删除|EBUSY/);
  });

  test('（c）没有 tombstoned 的 ok:false → 拒绝，报「没有删除」', () => {
    const o = classifyDeleteResult({ ok: false, error: '流程的会话不能手删' }, 'zh');
    assert.equal(o.kind, 'refused');
    assert.equal((o as any).error, '没有删除这个会话：流程的会话不能手删');
    assert.equal((classifyDeleteResult({ ok: false }, 'zh') as any).error, '没有删除这个会话：未知原因');
  });

  test('待清理提示接入中英文切换：英文界面给英文，中文表里有这条', () => {
    const en = classifyDeleteResult({ ok: false, tombstoned: true }, 'en');
    assert.equal((en as any).notice, TOMBSTONED_NOTICE_KEY);
    assert.match(TOMBSTONED_NOTICE_KEY, /^Chat deleted\./);
    assert.deepEqual(missingZh([TOMBSTONED_NOTICE_KEY]), []);
    assert.equal(t('zh', TOMBSTONED_NOTICE_KEY), '会话已删除，部分文件被占用，稍后自动清理');
  });

  const hook = fs.readFileSync(path.join(SRC, 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
  const del = hook.slice(hook.indexOf('const deleteSession'));
  const tail = del.slice(del.indexOf('classifyDeleteResult(res, lang)'), del.indexOf('} catch (error: any)'));
  const tombBranch = tail.slice(tail.indexOf("outcome.kind === 'tombstoned'"), tail.indexOf("outcome.kind === 'refused'"));
  const refusedBranch = tail.slice(tail.indexOf("outcome.kind === 'refused'"));

  test('（b）接线：tombstoned 分支不把会话放回列表、不报错', () => {
    assert.ok(tail.length > 0 && tombBranch.length > 0, '删除会话那段要按 classifyDeleteResult 的结果分支');
    assert.doesNotMatch(tombBranch, /setSessions\(/);
    assert.doesNotMatch(tombBranch, /noteError\(/);
    assert.match(tombBranch, /showToast\(outcome\.notice\)/);
  });

  test('（c）接线：拒绝分支仍然放回原位并报错', () => {
    assert.match(refusedBranch, /doomedRecord/);
    assert.match(refusedBranch, /setSessions\(/);
    assert.match(refusedBranch, /noteError\(null, outcome\.error\)/);
  });
});

describe('主进程 purgeSession 接线', () => {
  const M = fs.readFileSync(path.join(SRC, 'main', 'index.ts'), 'utf8');
  const purge = M.slice(M.indexOf('const purgeSession = async'), M.indexOf('const purgeFlowSessionsByRecord'));

  test('先等执行器真正断开（带上限），再移动目录', () => {
    const wait = purge.search(/await waitAtMost\(detachExecutor\(sessionId, \{ killTree: true \}\), \d+\)/);
    const move = purge.indexOf('await removeDirs()');
    assert.ok(wait > 0, '要 await detachExecutor');
    assert.ok(move > wait, '目录要在断开之后才移动');
  });

  test('目录走 moveDirToTrash（回收站），一直被占用就后台再试并返回 tombstoned', () => {
    assert.match(purge, /moveDirToTrash\(dir, \{\s*trashDir: SESSION_TRASH_DIR/);
    assert.match(purge, /scheduleBackgroundRetries\(/);
    assert.match(purge, /return \{ ok: false, tombstoned: true, error \}/);
    assert.match(purge, /clearSessionTombstone\(sessionId\);[\s\S]*return \{ ok: true \}/);
    assert.match(purge, /'acp:sessions-purged'/);
  });

  test('detachExecutor 的其他调用方不受影响：默认不带 killTree', () => {
    const d = M.slice(M.indexOf('function detachExecutor('), M.indexOf('function ensureExecutorCapacity('));
    assert.match(d, /opts: \{ killTree\?: boolean \} = \{\}/);
    assert.match(d, /disconnect\(opts\.killTree \? \{ killTree: true \} : undefined\)/);
    assert.match(d, /return disconnected;/);
  });
});

describe('Windows 进程树：只收本会话的', () => {
  // pid ppid created
  const rows = parseProcRows([
    '100\t1\t1000',     // 本会话的 kiro-cli
    '101\t100\t1100',   // 它起的 shell
    '102\t101\t1200',   // shell 起的 python
    '200\t1\t900',      // 另一个会话的 kiro-cli
    '201\t200\t950',    // 它的子进程
    '300\t100\t500',    // ppid 碰巧是 100，但比 100 早创建：父进程是早就退出的旧 100（pid 复用）
    'garbage line',
  ].join('\r\n'));

  test('只找出这个根下面的进程，不碰别的会话，也不认 pid 复用造成的假父子', () => {
    assert.deepEqual(descendantsOf(rows, 100).map((r) => r.pid).sort(), [101, 102]);
    assert.deepEqual(descendantsOf(rows, 200).map((r) => r.pid), [201]);
  });

  test('根不在（已经退了）就什么都不认', () => {
    assert.deepEqual(descendantsOf(rows, 999), []);
  });

  test('事后再杀：pid 和创建时间都对得上才算还活着', () => {
    const snap = descendantsOf(rows, 100);
    const now = parseProcRows('101\t100\t1100\n102\t7\t9999\n');
    assert.deepEqual(stillAlive(snap, now).map((r) => r.pid), [101]);
  });

  test('acp-client 删除时走核对过的进程树清理（taskkill /T /F）；核对不过就退回 proc.kill()', () => {
    const A = fs.readFileSync(path.join(SRC, 'main', 'acp-client.ts'), 'utf8');
    const P = fs.readFileSync(path.join(SRC, 'main', 'procTree.ts'), 'utf8');
    assert.match(P, /'taskkill', \['\/PID', String\(pid\), '\/T', '\/F'\]/);
    assert.match(A, /this\.spawnedAt = Date\.now\(\);\s*this\.process = spawn\(/);
    assert.match(A, /await snapshotExecutorTree\(proc, this\.spawnedAt, treeDeps\)/);
    assert.match(A, /if \(!\(await forceKillExecutorTree\(proc, tree, treeDeps\)\)\) \{\s*try \{ proc\.kill\(\); \}/);
    assert.match(A, /await sweepExecutorChildren\(tree, treeDeps\);/);
    // 清理子进程一个一个结束、不带 /T（每个都核对过身份）
    assert.match(P, /'taskkill', \['\/PID', String\(pid\), '\/F'\]/);
    assert.match(A, /killOne: \(pid\) => taskkillOne\(pid\)/);
  });
});

describe('Windows 进程树：旧执行器退出、pid 被别的会话复用时不能误杀', () => {
  /** Unix 毫秒 → FileTimeUtc，和 PowerShell 打出来的一样 */
  const ft = (ms: number) => (ms + 11_644_473_600_000) * 10_000;
  const SPAWNED_AT = 1_790_000_000_000;               // 本会话执行器 spawn 的时刻
  const LATER = SPAWNED_AT + 3_600_000;               // 一小时后，别的会话起了 kiro-cli，碰巧拿到同一个 pid
  // pid 100 现在是**另一个会话**的 kiro-cli，101 是它的 shell
  const otherSession = [
    { pid: 100, ppid: 1, created: ft(LATER) },
    { pid: 101, ppid: 100, created: ft(LATER + 1000) },
  ];
  const recorder = (rows: any[]) => {
    const r = { killed: [] as number[], lists: 0, rows, deps: null as any };
    r.deps = {
      list: async () => { r.lists++; return r.rows; },
      kill: async (pid: number) => { r.killed.push(pid); },
      killOne: async (pid: number) => { r.killed.push(pid); },
    };
    return r;
  };

  test('执行器已经退出：根本不按旧 pid 查进程树，也不调用 taskkill', async () => {
    const r = recorder(otherSession);
    const exited = { pid: 100, exitCode: 0, signalCode: null };
    const tree = await snapshotExecutorTree(exited, SPAWNED_AT, r.deps);
    assert.equal(tree, null);
    assert.equal(r.lists, 0, '已退出就不该去查进程列表');
    assert.equal(await forceKillExecutorTree(exited, tree, r.deps), false);
    assert.deepEqual(await sweepExecutorChildren(tree, r.deps), []);
    assert.deepEqual(r.killed, []);
  });

  test('Node 还没察觉退出，但那个 pid 已被别的会话复用：创建时间对不上，什么都不认、不调用 taskkill', async () => {
    const r = recorder(otherSession);
    const handle = { pid: 100, exitCode: null, signalCode: null };
    const tree = await snapshotExecutorTree(handle, SPAWNED_AT, r.deps);
    assert.equal(tree, null);
    assert.equal(await forceKillExecutorTree(handle, tree, r.deps), false, '强杀要退回 proc.kill()（Node 的进程句柄）');
    assert.deepEqual(await sweepExecutorChildren(tree, r.deps), []);
    assert.deepEqual(r.killed, []);
  });

  test('快照之后执行器退出、pid 又被复用：强杀和事后清理前都再核对，对不上就不 taskkill', async () => {
    const r = recorder([
      { pid: 100, ppid: 1, created: ft(SPAWNED_AT + 50) },
      { pid: 101, ppid: 100, created: ft(SPAWNED_AT + 5000) },
    ]);
    const handle = { pid: 100, exitCode: null, signalCode: null };
    const tree = await snapshotExecutorTree(handle, SPAWNED_AT, r.deps);
    assert.deepEqual(tree?.children.map((c) => c.pid), [101]);
    r.rows = otherSession;                                 // 现在 100 / 101 都是别人的了
    assert.equal(await forceKillExecutorTree(handle, tree, r.deps), false);
    assert.deepEqual(await sweepExecutorChildren(tree, r.deps), []);
    assert.deepEqual(r.killed, []);
  });

  test('正常情况：根是我们起的那个，强杀整棵树，退出后收掉还活着的子进程，不碰别的会话', async () => {
    const r = recorder([
      { pid: 100, ppid: 1, created: ft(SPAWNED_AT + 50) },
      { pid: 101, ppid: 100, created: ft(SPAWNED_AT + 5000) },
      { pid: 200, ppid: 1, created: ft(SPAWNED_AT - 99_000) },   // 别的会话
      { pid: 201, ppid: 200, created: ft(SPAWNED_AT - 98_000) },
    ]);
    const handle = { pid: 100, exitCode: null, signalCode: null };
    const tree = await snapshotExecutorTree(handle, SPAWNED_AT, r.deps);
    assert.equal(await forceKillExecutorTree(handle, tree, r.deps), true);
    assert.deepEqual(await sweepExecutorChildren(tree, r.deps), [101]);
    assert.deepEqual(r.killed, [100, 101]);
  });

  test('清理循环期间 pid 被复用：结束 101 时它的子进程 102 随之退出，102 又被别的会话拿去 —— 不能去杀新的 102', async () => {
    const mine = [
      { pid: 100, ppid: 1, created: ft(SPAWNED_AT + 50) },
      { pid: 101, ppid: 100, created: ft(SPAWNED_AT + 5000) },     // shell
      { pid: 102, ppid: 101, created: ft(SPAWNED_AT + 6000) },     // shell 起的 python
    ];
    let rows: any[] = mine;
    const killedOne: number[] = [];
    const deps = {
      list: async () => rows,
      kill: async () => { throw new Error('清理子进程不该用 /T'); },
      killOne: async (pid: number) => {
        killedOne.push(pid);
        if (pid === 101) {
          // 101 没了，102 也跟着没了；紧接着 102 被另一个会话的新进程复用（创建时间不同、父进程也不同）
          rows = [{ pid: 102, ppid: 200, created: ft(LATER) }, { pid: 200, ppid: 1, created: ft(LATER - 1000) }];
        }
      },
    };
    const handle = { pid: 100, exitCode: null, signalCode: null };
    const tree = await snapshotExecutorTree(handle, SPAWNED_AT, deps);
    assert.deepEqual(tree?.children.map((c) => c.pid).sort(), [101, 102]);
    rows = mine.slice(1);                                         // kiro-cli（100）已正常退出
    const killed = await sweepExecutorChildren(tree, deps);
    assert.deepEqual(killedOne, [101], '102 已经是别人的进程，不能结束');
    assert.deepEqual(killed, [101]);
  });

  test('每一次结束前都重新核对：已经随父进程退出的目标直接跳过', async () => {
    let rows: any[] = [
      { pid: 101, ppid: 100, created: ft(SPAWNED_AT + 5000) },
      { pid: 102, ppid: 101, created: ft(SPAWNED_AT + 6000) },
    ];
    let lists = 0;
    const killedOne: number[] = [];
    const deps = {
      list: async () => { lists++; return rows; },
      kill: async () => {},
      killOne: async (pid: number) => { killedOne.push(pid); rows = rows.filter((r) => r.pid !== pid && r.ppid !== pid); },
    };
    const tree = { root: { pid: 100, ppid: 1, created: ft(SPAWNED_AT + 50) }, children: rows.slice() };
    assert.deepEqual(await sweepExecutorChildren(tree, deps), [101]);
    assert.deepEqual(killedOne, [101]);
    assert.ok(lists >= 2, '结束一个之后要重新列一次进程再决定下一个');
  });

  test('快照之后才起的孙进程（本会话进程的后代、创建时间更晚）也会被收掉', async () => {
    let rows: any[] = [
      { pid: 101, ppid: 100, created: ft(SPAWNED_AT + 5000) },
      { pid: 103, ppid: 101, created: ft(SPAWNED_AT + 9000) },     // 快照之后才起
      { pid: 300, ppid: 1, created: ft(SPAWNED_AT - 50_000) },     // 不相干
    ];
    const killedOne: number[] = [];
    const deps = {
      list: async () => rows,
      kill: async () => {},
      killOne: async (pid: number) => { killedOne.push(pid); rows = rows.filter((r) => r.pid !== pid); },
    };
    const tree = { root: { pid: 100, ppid: 1, created: ft(SPAWNED_AT + 50) }, children: [rows[0]] };
    await sweepExecutorChildren(tree, deps);
    assert.deepEqual(killedOne.sort(), [101, 103]);
  });

  test('isSpawnedProcess：只认 spawn 那一刻附近创建的进程', () => {
    assert.equal(isSpawnedProcess({ pid: 1, ppid: 0, created: ft(SPAWNED_AT + 200) }, SPAWNED_AT), true);
    assert.equal(isSpawnedProcess({ pid: 1, ppid: 0, created: ft(LATER) }, SPAWNED_AT), false);
    assert.equal(isSpawnedProcess({ pid: 1, ppid: 0, created: ft(SPAWNED_AT - 60_000) }, SPAWNED_AT), false);
    assert.equal(isSpawnedProcess({ pid: 1, ppid: 0, created: ft(SPAWNED_AT) }, undefined), false);
  });
});
