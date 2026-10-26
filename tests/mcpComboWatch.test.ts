import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpComboWatcher, comboFingerprint, remountExclusive, COMBO_FILE_BROKEN, type ComboWatchSession } from '../src/main/mcpComboWatch.ts';
import { readMcpCombos, pickCombo, mcpCombosPath, type McpCombo } from '../src/main/mcpCombos.ts';

/**
 * 「改了 mcp-combos.json 后已连会话不生效」：文件一改，正在用受影响组合的已连会话要按新配置重挂 MCP；
 * 忙的等这一轮结束；没用这个组合的不动；文件改坏了不重挂、只提示一次。
 * 守的是 `McpComboWatcher` 的判断（真读临时目录里的文件，执行器 / 会话状态是假的）。
 */
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-combowatch-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const write = (v: unknown): void => {
  fs.mkdirSync(path.dirname(mcpCombosPath(home)), { recursive: true });
  fs.writeFileSync(mcpCombosPath(home), typeof v === 'string' ? v : JSON.stringify(v, null, 2));
};
const v1 = [
  { id: 'default', name: '通用（带本机工具）', mcpServers: { ctx: { url: 'https://ctx.example.com/mcp' } } },
  { id: 'research', name: '投研', mcpServers: { mx: { url: 'https://mx.example.com/mcp' } } },
];
/* 给「通用」加一条本机 Playwright、并改名；「投研」不动 */
const v2 = [
  { id: 'default', name: '通用', mcpServers: { ctx: { url: 'https://ctx.example.com/mcp' }, playwright: { command: 'npx', args: ['@playwright/mcp'], forwardFromLocal: true } } },
  v1[1],
];

interface Fake {
  watcher: McpComboWatcher;
  sessions: Map<string, ComboWatchSession>;
  busy: Set<string>;
  remounts: string[];
  notes: string[];
  failRemount: Set<string>;
  /** 重挂卡在「已按开始时的文件准备好 MCP、执行器还没起来」那一步，直到放开 */
  gates: Map<string, Promise<void>>;
  timers: Map<number, () => void>;
  reads: number;
  flush(): Promise<void>;
  prepare(sid: string): void;
}

function setup(): Fake {
  const sessions = new Map<string, ComboWatchSession>();
  const busy = new Set<string>();
  const remounts: string[] = [];
  const notes: string[] = [];
  const failRemount = new Set<string>();
  const gates = new Map<string, Promise<void>>();
  const timers = new Map<number, () => void>();
  let timerSeq = 0;
  const resolve = (combos: McpCombo[], id: string | undefined) => pickCombo(combos, id);
  const watcher = new McpComboWatcher({
    read: () => { fake.reads += 1; return readMcpCombos(home); },
    sessions: () => [...sessions.values()],
    resolve,
    isBusy: (sid) => busy.has(sid),
    remount: async (sid) => {
      remounts.push(sid);
      /* 和 index.ts 一样：开始时读文件、准备 MCP（钉住这一份），sessionCombo 记指纹并 noteMounted；执行器起来要一会儿 */
      const s = sessions.get(sid)!;
      const prev = s.mountedFp;
      prepare(sid);
      await gates.get(sid);
      /* 没起来：旧执行器还挂着旧的那份，指纹退回去（remountWithProfile 的 catch） */
      if (failRemount.has(sid)) { s.mountedFp = prev; throw new Error('adapter did not start'); }
    },
    noteReloaded: (sid, combo) => notes.push(`reloaded ${sid} ${combo.name}`),
    noteReloadFailed: (sid, combo, err) => notes.push(`failed ${sid} ${combo.name} ${err}`),
    noteFileError: (sid, err) => notes.push(`bad ${sid} ${err}`),
    log: () => {},
    setTimer: (fn) => { timerSeq += 1; timers.set(timerSeq, fn); return timerSeq; },
    clearTimer: (h) => { timers.delete(h as number); },
  });
  /* 跑完所有到期的定时器和在飞的重挂；重挂收尾又排的定时器（重挂期间文件变了）也接着跑 */
  /** sessionCombo 那一步：按现在的文件准备 MCP、记指纹、告诉 watcher（所有挂载路径都经过它） */
  function prepare(sid: string): void {
    const s = sessions.get(sid)!;
    s.mountedFp = comboFingerprint(resolve(readMcpCombos(home).combos, s.comboId));
    watcher.noteMounted(sid);
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      while (timers.size) {
        const [id, fn] = timers.entries().next().value!;
        timers.delete(id);
        fn();
      }
      await Promise.all([...sessions.keys()].map((sid) => watcher.pending(sid)));
      await new Promise((r) => setImmediate(r));
    }
  };
  const fake: Fake = { watcher, sessions, busy, remounts, notes, failRemount, gates, timers, reads: 0, flush, prepare };
  return fake;
}

/** 按 v1 挂上的会话 */
function mount(f: Fake, sessionId: string, comboId?: string): void {
  f.sessions.set(sessionId, { sessionId, comboId, mountedFp: comboFingerprint(pickCombo(readMcpCombos(home).combos, comboId)) });
}

describe('McpComboWatcher：组合文件改了 → 按新配置重挂', () => {
  test('改了「通用」：用通用的空闲会话重挂，用「投研」的不动；提示里用新名字', async () => {
    write(v1);
    const f = setup();
    mount(f, 'a');                 // 没选 = 通用
    mount(f, 'b', 'default');
    mount(f, 'r', 'research');
    f.watcher.prime();
    write(v2);
    f.watcher.changed();
    await f.flush();
    assert.deepEqual(f.remounts.sort(), ['a', 'b']);
    assert.ok(f.notes.includes('reloaded a 通用'), f.notes.join('\n'));
    assert.ok(!f.notes.some((n) => n.includes(' r ')));
  });

  test('忙的会话不打断：等它空下来再重挂', async () => {
    write(v1);
    const f = setup();
    mount(f, 'idle');
    mount(f, 'busy');
    f.busy.add('busy');
    f.watcher.prime();
    write(v2);
    f.watcher.changed();
    await f.flush();
    assert.deepEqual(f.remounts, ['idle']);
    assert.equal(f.watcher.isWaiting('busy'), true);
    /* 还在忙时的 idle 通知（例如别的状态变化）不重挂 */
    f.watcher.idle('busy');
    await f.flush();
    assert.deepEqual(f.remounts, ['idle']);
    /* 这一轮结束 */
    f.busy.delete('busy');
    f.watcher.idle('busy');
    await f.flush();
    assert.deepEqual(f.remounts, ['idle', 'busy']);
    assert.ok(f.notes.includes('reloaded busy 通用'));
    assert.equal(f.watcher.isWaiting('busy'), false);
  });

  test('等着的期间别的切换已经按新文件重挂过：空下来时不再重挂一次', async () => {
    write(v1);
    const f = setup();
    mount(f, 's');
    f.busy.add('s');
    f.watcher.prime();
    write(v2);
    f.watcher.changed();
    await f.flush();
    /* 用户的忙时切换（换引擎）落定：新执行器已经按 v2 准备 MCP */
    mount(f, 's');
    f.busy.delete('s');
    f.watcher.idle('s');
    await f.flush();
    assert.deepEqual(f.remounts, []);
  });

  test('内容没变（fs.watch 重复事件 / 只是被重写一遍）不重挂', async () => {
    write(v1);
    const f = setup();
    mount(f, 'a');
    f.watcher.prime();
    write(v1);
    f.watcher.changed();
    f.watcher.changed();
    await f.flush();
    assert.deepEqual(f.remounts, []);
  });

  test('只改名字：不重启执行器', async () => {
    write(v1);
    const f = setup();
    mount(f, 'r', 'research');
    f.watcher.prime();
    write([v1[0], { ...v1[1], name: '投研二' }]);
    f.watcher.changed();
    await f.flush();
    assert.deepEqual(f.remounts, []);
  });

  test('防抖：连着几次改动只读一次、只重挂一次', async () => {
    write(v1);
    const f = setup();
    mount(f, 'a');
    f.watcher.prime();
    write(v2);
    const before = f.reads;
    /* 重挂先卡住：只看防抖这一段读了几次（挂好后的那次复核另算） */
    let open!: () => void;
    f.gates.set('a', new Promise<void>((r) => { open = r; }));
    f.watcher.changed();
    f.watcher.changed();
    f.watcher.changed();
    for (const [id, fn] of [...f.timers]) { f.timers.delete(id); fn(); }
    await new Promise((r) => setImmediate(r));
    assert.equal(f.reads - before, 1, '防抖后只读一次');
    f.gates.delete('a');
    open();
    await f.flush();
    assert.deepEqual(f.remounts, ['a']);
  });

  test('组合被删了：用它的会话按退回的「通用」重挂', async () => {
    write(v1);
    const f = setup();
    mount(f, 'r', 'research');
    f.watcher.prime();
    write([v1[0]]);
    f.watcher.changed();
    await f.flush();
    assert.deepEqual(f.remounts, ['r']);
  });

  test('重挂期间文件又改回原样：重挂做完后按现在的文件再比一次，挂回原来那份', async () => {
    write(v1);
    const f = setup();
    mount(f, 'a');
    const fpA = f.sessions.get('a')!.mountedFp;
    f.watcher.prime();
    let open!: () => void;
    f.gates.set('a', new Promise<void>((r) => { open = r; }));
    const runTimers = (): void => { for (const [id, fn] of [...f.timers]) { f.timers.delete(id); fn(); } };
    write(v2);
    f.watcher.changed();
    runTimers();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(f.remounts, ['a'], 'A → B：开始按 B 重挂');
    /* 还没挂好，文件被撤回成 A */
    write(v1);
    f.watcher.changed();
    runTimers();
    await new Promise((r) => setImmediate(r));
    assert.equal(f.watcher.isWaiting('a'), true, '正在重挂的那条先记成等着，不按旧指纹判成「没变」');
    f.gates.delete('a');
    open();
    await f.flush();
    assert.deepEqual(f.remounts, ['a', 'a'], 'B 挂好后发现文件已是 A：再按 A 重挂一次');
    assert.equal(f.sessions.get('a')!.mountedFp, fpA);
    assert.equal(f.watcher.isWaiting('a'), false);
  });

  test('重挂期间文件又改了但和这次挂的一样：做完后不再重挂', async () => {
    write(v1);
    const f = setup();
    mount(f, 'a');
    f.watcher.prime();
    let open!: () => void;
    f.gates.set('a', new Promise<void>((r) => { open = r; }));
    const runTimers = (): void => { for (const [id, fn] of [...f.timers]) { f.timers.delete(id); fn(); } };
    write(v2);
    f.watcher.changed();
    runTimers();
    await new Promise((r) => setImmediate(r));
    /* 只是重新排版了一下（内容等价）*/
    write(JSON.stringify(v2));
    f.watcher.changed();
    runTimers();
    await new Promise((r) => setImmediate(r));
    f.gates.delete('a');
    open();
    await f.flush();
    assert.deepEqual(f.remounts, ['a']);
  });

  test('重挂失败：说出来（带原因）', async () => {
    write(v1);
    const f = setup();
    mount(f, 'a');
    f.failRemount.add('a');
    f.watcher.prime();
    write(v2);
    f.watcher.changed();
    await f.flush();
    assert.ok(f.notes.some((n) => n.startsWith('failed a 通用 adapter did not start')), f.notes.join('\n'));
    /* 失败了不自己反复重试（不刷屏），等下一次文件变化 / new-backend */
    assert.deepEqual(f.remounts, ['a']);
    assert.equal(f.watcher.isWaiting('a'), false);
  });

  test('new-backend（不经 watcher 发起的重挂）准备 MCP 之前文件被撤回：挂好后按当前文件纠正', async () => {
    write(v1);
    const f = setup();
    mount(f, 's');
    const fpA = f.sessions.get('s')!.mountedFp;
    f.watcher.prime();
    /* new-backend 开始：占住会话（忙），钉住了 B，正在等 remoteAdapterCheck —— 还没走到 sessionCombo */
    write(v2);
    const pinnedB = readMcpCombos(home).combos;
    f.busy.add('s');
    f.watcher.changed();
    await f.flush();
    assert.equal(f.watcher.isWaiting('s'), true);
    /* 这时文件被撤回成 A：按旧指纹比是「没变」 */
    write(v1);
    f.watcher.changed();
    await f.flush();
    /* new-backend 按钉住的 B 准备 MCP（sessionCombo），连好、放开会话 */
    const s = f.sessions.get('s')!;
    s.mountedFp = comboFingerprint(pickCombo(pinnedB, s.comboId));
    f.watcher.noteMounted('s');
    await f.flush();
    assert.deepEqual(f.remounts, [], '还占着的时候不动');
    f.busy.delete('s');
    f.watcher.idle('s');
    await f.flush();
    assert.deepEqual(f.remounts, ['s'], '挂上的是已撤回的 B：按当前的 A 重挂一次');
    assert.equal(f.sessions.get('s')!.mountedFp, fpA);
    assert.equal(f.watcher.isWaiting('s'), false);
  });

  test('普通挂载（attach）后复核：和当前文件一致就什么都不做', async () => {
    write(v1);
    const f = setup();
    f.sessions.set('n', { sessionId: 'n' });
    f.watcher.prime();
    f.prepare('n');
    await f.flush();
    assert.deepEqual(f.remounts, []);
    assert.equal(f.watcher.isWaiting('n'), false);
  });
});

describe('McpComboWatcher：文件改坏了', () => {
  test('JSON 坏了：不重挂、每条会话提示一次（带错误）；同一份坏内容不重复提示', async () => {
    write(v1);
    const f = setup();
    mount(f, 'a');
    mount(f, 'r', 'research');
    f.watcher.prime();
    write('[{ "id": "default", ');
    f.watcher.changed();
    await f.flush();
    assert.deepEqual(f.remounts, []);
    const bad = f.notes.filter((n) => n.startsWith('bad '));
    assert.equal(bad.length, 2);
    assert.ok(bad[0].length > 'bad a '.length, '提示要附错误');
    f.watcher.changed();
    await f.flush();
    assert.equal(f.notes.filter((n) => n.startsWith('bad ')).length, 2);
  });

  test('校验不过（名字重复）也算坏：不重挂', async () => {
    write(v1);
    const f = setup();
    mount(f, 'r', 'research');
    f.watcher.prime();
    write([v1[0], v1[1], { ...v1[1], id: 'research2' }]);
    f.watcher.changed();
    await f.flush();
    assert.deepEqual(f.remounts, []);
    assert.equal(f.notes.filter((n) => n.startsWith('bad r ')).length, 1);
  });

  test('忙的会话等着时文件被改坏：空下来也不按坏文件重挂；改好后再按新内容重挂', async () => {
    write(v1);
    const f = setup();
    mount(f, 's');
    f.busy.add('s');
    f.watcher.prime();
    write(v2);
    f.watcher.changed();
    await f.flush();
    write('not json');
    f.watcher.changed();
    await f.flush();
    f.busy.delete('s');
    f.watcher.idle('s');
    await f.flush();
    assert.deepEqual(f.remounts, []);
    write(v2);
    f.watcher.changed();
    await f.flush();
    assert.deepEqual(f.remounts, ['s']);
  });
});

describe('comboFingerprint', () => {
  test('键的顺序不同算同一份；MCP / effort 变了算不同', () => {
    const a = { id: 'x', mcpServers: { p: { url: 'u', headers: { A: '1', B: '2' } } } } as any;
    const b = { id: 'x', mcpServers: { p: { headers: { B: '2', A: '1' }, url: 'u' } } } as any;
    assert.equal(comboFingerprint(a), comboFingerprint(b));
    assert.notEqual(comboFingerprint(a), comboFingerprint({ ...a, effort: 'high' }));
    assert.notEqual(comboFingerprint(a), comboFingerprint({ id: 'x', mcpServers: { p: { url: 'u2' } } } as any));
  });
});

describe('接线（index.ts 源码扫描）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  const fnBody = (anchor: string, end = '\n}\n'): string => {
    const at = M.indexOf(anchor);
    assert.ok(at > 0, `找不到 ${anchor}`);
    return M.slice(at, M.indexOf(end, at));
  };

  test('new-backend（swapBackendSessionWhenIdle）：Claude Code / Codex 先重新读组合、重新准备 MCP，不在旧进程里沿用旧 mcpServers', () => {
    const swap = fnBody('async function swapBackendSessionWhenIdle(');
    const remountAt = swap.indexOf('await remountMcpForSession(sessionId, trigger)');
    assert.ok(remountAt > 0);
    assert.ok(remountAt < swap.indexOf('recreateBackendSession(sessionId, entry, trigger)'), '重挂那条在旧进程 session/new 之前分流');
    /* 控制入口走的就是它 */
    assert.match(M, /await swapBackendSessionWhenIdle\(id, 'control-new-backend'\)/);
    /* 重挂：先等挂载锁（264ad8f4）和在飞的 attach，再占住会话 */
    /* 组合文件坏了：不按它重挂（会退回不带 MCP 的通用），说一句，照旧在原进程里换后端会话、沿用原来的 MCP */
    const broken = swap.slice(swap.indexOf('} catch (err: any) {'));
    assert.match(broken, /if \(err\?\.code !== COMBO_FILE_BROKEN\) throw err;/);
    assert.match(broken, /noteInSession\(sessionId, [\s\S]*?'mcp-combo-file-error'\)/);
    assert.ok(broken.indexOf('recreateBackendSession(sessionId, entry, trigger)') > 0);
    const reload = fnBody('remountMcpForSession = (sessionId: string, trigger: string)', '\n  });\n');
    assert.match(reload, /remountExclusive\(\{/);
    assert.match(reload, /settle: async \(\) => \{ await mountLock\.settle\(sessionId\); await awaitAttachIdle\(sessionId\); \}/);
    /* 同步判断里要有「另一个切换在做」和「正忙」 */
    assert.match(reload, /if \(reconfiguringSessions\.has\(sessionId\)\) return new Error/);
    assert.match(reload, /const busy = busyReasonFor\(sessionId\);/);
    assert.match(reload, /claim: \(\) => \{ reconfiguringSessions\.add\(sessionId\);/);
    assert.match(reload, /readCombos: \(\) => readMcpCombos\(os\.homedir\(\)\)/);
    /* 准备 MCP 期间钉住开始时校验过的那份 */
    assert.match(reload, /pinnedCombos\.set\(sessionId, combos\);[\s\S]*?await remountWithProfile\(sessionId, entry, entry\.profile, trigger\)[\s\S]*?pinnedCombos\.delete\(sessionId\)/);
    assert.match(fnBody('function sessionCombo('), /const pinned = pinnedCombos\.get\(sessionId\);\s*const \{ combos, error \} = pinned \? \{ combos: pinned, error: undefined \} : readMcpCombos\(os\.homedir\(\)\);/);
    /* 重挂的实现每次重新 ensureLocalTools（里面 sessionCombo 现读组合文件）再起执行器 */
    const remount = fnBody('async function remountWithProfile(', '\n  }\n');
    assert.ok(remount.indexOf('await ensureLocalTools(') < remount.indexOf('await connectWithModelFallback('));
    const combo = fnBody('function sessionCombo(');
    assert.match(combo, /readMcpCombos\(os\.homedir\(\)\)/);
    assert.match(combo, /mountedComboFp\.set\(sessionId, comboFingerprint\(localized\)\)/);
  });

  test('组合文件变化：fs.watch 盯 ~/.kirolex、自己保存 / S3 写完也喊一声；会话空下来时补做', () => {
    assert.match(M, /mcpComboWatcher = new McpComboWatcher\(\{/);
    assert.match(M, /remount: async \(sid\) => \{ await remountMcpForSession!\(sid, 'mcp-combos-changed'\); \}/);
    assert.match(M, /fs\.watch\(KIROLEX_HOME, /);
    assert.match(M, /mcpComboWatcher\.prime\(\);/);
    const save = fnBody("ipcMain.handle('acp:save-mcp-combos'", '\n  });\n');
    assert.match(save, /mcpComboWatcher\?\.changed\(\)/);
    const s3 = fnBody('async function syncMcpCombosWithBucket(');
    assert.match(s3, /writeMcpCombosText\(os\.homedir\(\), text\);[\s\S]*?mcpComboWatcher\?\.changed\(\)/);
    const busy = fnBody('function emitSessionBusy(');
    assert.match(busy, /mcpComboWatcher\?\.idle\(sessionId\)/);
  });
});

describe('remountExclusive：重挂一条会话（new-backend / 组合文件改了共用）', () => {
  /** 假的会话状态：一个执行器、占用标记、挂载锁可以手动放开 */
  function harness(opts: { settleGate?: Promise<void> } = {}) {
    const st = { entry: { id: 'old', mcp: ['ctx'] } as { id: string; mcp: string[] }, claimed: false, busy: false, remounts: 0, claims: 0 };
    const run = () => remountExclusive({
      settle: async () => { await opts.settleGate; },
      current: () => st.entry,
      refuse: (e) => (!e ? new Error('not connected') : st.claimed ? new Error('another switch') : st.busy ? new Error('busy') : null),
      claim: () => { st.claimed = true; st.claims += 1; },
      release: () => { st.claimed = false; },
      readCombos: () => readMcpCombos(home),
      brokenError: (error) => Object.assign(new Error('file broken'), { code: COMBO_FILE_BROKEN, detail: error }),
      remount: async (_e, combos) => {
        st.remounts += 1;
        await new Promise((r) => setTimeout(r, 20));
        st.entry = { id: `new${st.remounts}`, mcp: Object.keys(pickCombo(combos, undefined).mcpServers) };
        return st.entry.id;
      },
    });
    return { st, run };
  }

  test('组合文件坏了：不重挂、不占住会话，旧执行器和它的 MCP 原样留着，错误带 COMBO_FILE_BROKEN 和原因', async () => {
    write('[{ "id": "default", ');
    const { st, run } = harness();
    await assert.rejects(run(), (err: any) => err.code === COMBO_FILE_BROKEN && typeof err.detail === 'string' && err.detail.length > 0);
    assert.equal(st.remounts, 0);
    assert.equal(st.claims, 0);
    assert.deepEqual(st.entry, { id: 'old', mcp: ['ctx'] });
  });

  test('两次同时到达（都在等挂载锁）：只有一个占住并重挂，另一个被拒', async () => {
    write(v2);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const { st, run } = harness({ settleGate: gate });
    const a = run();
    const b = run();
    open();
    const results = await Promise.allSettled([a, b]);
    assert.equal(st.remounts, 1, '同一个旧执行器只被重挂一次');
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(rejected.reason?.message), /another switch/);
    assert.equal(st.claimed, false, '做完放开');
  });

  test('用的是占住那一刻校验过的那份：重挂期间文件又被改坏也按好的那份挂', async () => {
    write(v2);
    const { st, run } = harness();
    const p = run();
    await new Promise((r) => setImmediate(r));
    write('not json');
    await p;
    assert.deepEqual(st.entry.mcp.sort(), ['ctx', 'playwright']);
  });

  test('正忙：不重挂', async () => {
    write(v2);
    const { st, run } = harness();
    st.busy = true;
    await assert.rejects(run(), /busy/);
    assert.equal(st.remounts, 0);
  });
});
