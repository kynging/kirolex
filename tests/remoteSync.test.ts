import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  RemoteSyncManager, busyPeer, toolMayHaveWritten, PULL_DEBOUNCE_MS,
  SLOW_SYNC_NOTICE_MS, SLOW_SYNC_REPEAT_MS,
  type MirrorLike, type SyncDeps,
} from '../src/main/remoteSync.ts';
import type { PullResult, PushResult } from '../src/main/remoteMirror.ts';

/*
 * 同步点的编排。这几条规则都属于"错了会安静地给出错答案"，所以每一条单独钉住。
 */

function mirror(overrides: {
  push?: () => Promise<PushResult>;
  pull?: () => Promise<PullResult>;
} = {}): MirrorLike & { pushes: number; pulls: number } {
  const m: any = {
    localDir: '/l', remoteDir: '/r', pushes: 0, pulls: 0,
    async push() { m.pushes += 1; return overrides.push ? overrides.push() : { ok: true, snapshot: {}, ms: 1 }; },
    async pull() { m.pulls += 1; return overrides.pull ? overrides.pull() : { ok: true, changed: [], conflicts: [], ms: 1 }; },
  };
  return m;
}

function harness(): { mgr: RemoteSyncManager; notes: string[]; logs: string[]; fire: () => void; deps: SyncDeps } {
  const notes: string[] = [];
  const logs: string[] = [];
  let pending: (() => void) | null = null;
  const deps: SyncDeps = {
    note: (_s, t) => notes.push(t),
    log: (lvl, m) => logs.push(`${lvl} ${m}`),
    /* 防抖不真的等 —— 测试要能精确控制它什么时候跑 */
    schedule: (fn) => { pending = fn; },
  };
  return { mgr: new RemoteSyncManager(deps), notes, logs, fire: () => { const p = pending; pending = null; p?.(); }, deps };
}

describe('① 发 prompt 之前推不上去 = 这一轮不发', () => {
  test('推成功就静静过去', async () => {
    const { mgr } = harness();
    const project = mirror();
    mgr.register({ sessionId: 's1', project, hostLabel: 'tokyo' });
    await mgr.beforeTurn('s1');
    assert.equal(project.pushes, 1);
  });

  test('**推失败必须抛** —— 让模型读着旧文件干活，产出看着对其实是对着上一版写的', async () => {
    const { mgr } = harness();
    const project = mirror({ push: async () => ({ ok: false, error: 'connection refused', snapshot: {}, ms: 3 }) });
    mgr.register({ sessionId: 's1', project, hostLabel: 'tokyo' });
    await assert.rejects(() => mgr.beforeTurn('s1'), (e: Error) => {
      assert.match(e.message, /这一轮没有发送/);
      assert.match(e.message, /connection refused/);
      assert.match(e.message, /你的消息还在/, '不告诉人消息没丢，等于让人以为白打了一段');
      return true;
    });
  });

  test('会话目录那一份也要推 —— history.md 和附件在项目目录之外', async () => {
    const { mgr } = harness();
    const project = mirror();
    const session = mirror();
    mgr.register({ sessionId: 's1', project, session, hostLabel: 'tokyo' });
    await mgr.beforeTurn('s1');
    assert.equal(session.pushes, 1, '不推的话远端的 file: 引用指向一个不存在的路径');
  });

  test('会话目录推失败同样不发 —— 附件缺了模型会装作没看见', async () => {
    const { mgr } = harness();
    const session = mirror({ push: async () => ({ ok: false, error: 'no space left', snapshot: {}, ms: 1 }) });
    mgr.register({ sessionId: 's1', project: mirror(), session, hostLabel: 'tokyo' });
    await assert.rejects(() => mgr.beforeTurn('s1'), /会话目录镜像没同步上去/);
  });

  test('本地会话（没注册）什么都不做 —— 本地路径一行都不能变', async () => {
    const { mgr } = harness();
    await mgr.beforeTurn('unknown');   // 不抛、不做事
    assert.equal(mgr.isRemote('unknown'), false);
  });
});

describe('② 一轮结束拉不回来 = 留债 + 说出来', () => {
  test('拉成功清债', async () => {
    const { mgr } = harness();
    mgr.register({ sessionId: 's1', project: mirror(), hostLabel: 'tokyo' });
    await mgr.afterTurn('s1');
    assert.equal(mgr.hasUnpulled('s1'), false);
  });

  test('拉失败**不抛**（这一轮已经成了），但留债并说清本地不是最新的', async () => {
    const { mgr, notes } = harness();
    mgr.register({
      sessionId: 's1', hostLabel: 'tokyo',
      project: mirror({ pull: async () => ({ ok: false, error: 'ssh timeout', changed: [], conflicts: [], ms: 2 }) }),
    });
    await mgr.afterTurn('s1');   // 不抛
    assert.equal(mgr.hasUnpulled('s1'), true);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /不是\*\*最新的\*\*|不\*\*是\*\*最新的|不是.*最新/);
    assert.match(notes[0], /tokyo/);
  });

  test('冲突要说清"你的那份没被动" —— 否则第一反应是"我的修改被覆盖了"', async () => {
    const { mgr, notes } = harness();
    mgr.register({
      sessionId: 's1', hostLabel: 'tokyo',
      project: mirror({ pull: async () => ({ ok: true, changed: ['a.ts'], conflicts: ['src/b.ts'], ms: 2 }) }),
    });
    await mgr.afterTurn('s1');
    assert.equal(notes.length, 1);
    assert.match(notes[0], /本地那份没有动/);
    assert.match(notes[0], /src\/b\.ts.*src\/b\.ts\.remote/);
  });
});

describe('③ 工具写文件：防抖拉', () => {
  test('连着触发只拉一次', async () => {
    const { mgr, fire } = harness();
    const project = mirror();
    mgr.register({ sessionId: 's1', project, hostLabel: 'tokyo' });
    mgr.pullSoon('s1'); mgr.pullSoon('s1'); mgr.pullSoon('s1');
    fire();
    await new Promise((r) => setImmediate(r));
    assert.equal(project.pulls, 1, `拉了 ${project.pulls} 次`);
  });

  test('防抖之后还能再来一轮', async () => {
    const { mgr, fire } = harness();
    const project = mirror();
    mgr.register({ sessionId: 's1', project, hostLabel: 'tokyo' });
    mgr.pullSoon('s1'); fire();
    await new Promise((r) => setImmediate(r));
    mgr.pullSoon('s1'); fire();
    await new Promise((r) => setImmediate(r));
    assert.equal(project.pulls, 2);
  });

  test('窗口是常量，不是散在调用点的魔法数字', () => {
    assert.equal(PULL_DEBOUNCE_MS, 800);
  });

  test('静默那条路失败也要说 —— "本地不是最新的"不能沉默', async () => {
    const { mgr, notes, fire } = harness();
    mgr.register({
      sessionId: 's1', hostLabel: 'tokyo',
      project: mirror({ pull: async () => ({ ok: false, error: 'boom', changed: [], conflicts: [], ms: 1 }) }),
    });
    mgr.pullSoon('s1'); fire();
    await new Promise((r) => setImmediate(r));
    assert.equal(notes.length, 1);
  });
});

describe('④ review 之前按需拉，并且等它', () => {
  test('成功返回 true；失败返回 false（调用方据此拒绝渲染）', async () => {
    const { mgr } = harness();
    mgr.register({ sessionId: 'ok', project: mirror(), hostLabel: 'tokyo' });
    mgr.register({
      sessionId: 'bad', hostLabel: 'tokyo',
      project: mirror({ pull: async () => ({ ok: false, error: 'x', changed: [], conflicts: [], ms: 1 }) }),
    });
    assert.equal(await mgr.pullNow('ok'), true);
    assert.equal(await mgr.pullNow('bad'), false);
  });

  test('本地会话直接 true —— 它的文件本来就是最新的', async () => {
    const { mgr } = harness();
    assert.equal(await mgr.pullNow('local-only'), true);
  });
});

describe('同一条会话的同步串行 —— 两个 rsync 同时写一个目录，谁赢谁输不确定', () => {
  test('前一个没做完，后一个不开始', async () => {
    const { mgr } = harness();
    let inFlight = 0;
    let maxParallel = 0;
    const project: any = {
      localDir: '/l', remoteDir: '/r',
      async push() { return { ok: true, snapshot: {}, ms: 0 }; },
      async pull() {
        inFlight += 1;
        maxParallel = Math.max(maxParallel, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { ok: true, changed: [], conflicts: [], ms: 5 };
      },
    };
    mgr.register({ sessionId: 's1', project, hostLabel: 'tokyo' });
    await Promise.all([mgr.afterTurn('s1'), mgr.afterTurn('s1'), mgr.pullNow('s1')]);
    assert.equal(maxParallel, 1, `同时有 ${maxParallel} 个在跑`);
  });

  test('链上一次失败不能把后面的都毒死', async () => {
    const { mgr } = harness();
    let n = 0;
    const project: any = {
      localDir: '/l', remoteDir: '/r',
      async push() { n += 1; if (n === 1) return { ok: false, error: 'first fails', snapshot: {}, ms: 0 }; return { ok: true, snapshot: {}, ms: 0 }; },
      async pull() { return { ok: true, changed: [], conflicts: [], ms: 0 }; },
    };
    mgr.register({ sessionId: 's1', project, hostLabel: 'tokyo' });
    await assert.rejects(() => mgr.beforeTurn('s1'));
    await mgr.beforeTurn('s1');   // 第二次必须还能跑
  });
});

describe('同一个项目上的并发：拒绝', () => {
  const sessions = [
    { sessionId: 'a', localDir: '/Users/k/proj', busy: true },
    { sessionId: 'b', localDir: '/Users/k/proj/', busy: false },
    { sessionId: 'c', localDir: '/Users/k/other', busy: true },
  ];

  test('同一个目录上有别人在跑就报出来（末尾斜杠不算区别）', () => {
    assert.equal(busyPeer(sessions, { sessionId: 'b', localDir: '/Users/k/proj' }), 'a');
    assert.equal(busyPeer(sessions, { sessionId: 'b', localDir: '/Users/k/proj/' }), 'a');
  });

  test('别的项目不挡；自己不挡自己', () => {
    assert.equal(busyPeer(sessions, { sessionId: 'x', localDir: '/Users/k/elsewhere' }), undefined);
    assert.equal(busyPeer(sessions, { sessionId: 'a', localDir: '/Users/k/proj' }), undefined);
  });

  test('判据是本地目录而不是 projectId —— `~` 起的会话根本没有 projectId', () => {
    assert.equal(busyPeer([{ sessionId: 'z', localDir: '', busy: true }], { sessionId: 'y', localDir: '' }), undefined,
      '空目录不能把所有会话都算成同一个项目');
  });
});

describe('哪些工具算"写过文件"', () => {
  test('写类算', () => {
    for (const s of ['Writing src/a.ts', 'fs_write', 'edit', 'apply patch', 'Execute: mv a b', 'create file']) {
      assert.equal(toolMayHaveWritten(s), true, s);
    }
  });

  test('纯读不算 —— 别为每次 grep 都拉一遍', () => {
    for (const s of ['Reading marker.txt:2-2', 'grep -n foo', 'Listing directory', 'glob **/*.ts']) {
      assert.equal(toolMayHaveWritten(s), false, s);
    }
  });

  test('读+写混在一起算写 —— 判宽了只是多拉一次，判窄了 review 会看着上一版', () => {
    assert.equal(toolMayHaveWritten('read then write file'), true);
    assert.equal(toolMayHaveWritten(undefined), false);
    assert.equal(toolMayHaveWritten('', {}), false);
  });

  test('看得见路径的也算', () => {
    assert.equal(toolMayHaveWritten('bash', { command: 'sed -i s/a/b/ src/x.ts' }), true);
  });
});

describe('接线（src/main/index.ts）', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('发 prompt 之前推，且**在 sendPrompt 之前**', () => {
    assert.match(M, /await remoteSync\.beforeTurn\(sessionId\);/);
    assert.ok(
      M.indexOf('await remoteSync.beforeTurn(sessionId);') < M.indexOf('const result = await entry.client.sendPrompt('),
      '推必须在发之前，否则远端读的是旧文件',
    );
  });

  test('一轮结束拉；工具写文件防抖拉', () => {
    assert.match(M, /await remoteSync\.afterTurn\(sessionId\)/);
    assert.match(M, /remoteSync\.pullSoon\(/);
  });

  test('同项目并发在推之前就挡住 —— 挡在推后面等于已经把镜像改了', () => {
    assert.match(M, /busyPeer\(/);
    const guard = M.indexOf('busyPeer(');
    assert.ok(guard > 0 && guard < M.indexOf('await remoteSync.beforeTurn(sessionId);'));
  });
});

/*
 * 「为啥远程会话一直没有响应」—— 实测那次：推送跑了 3 分钟还没完（家目录 2.6 GB），
 * 而聊天里**一个字都没有**。侧栏那个 ↑ 太小、也说不出"在等什么、等了多久"。
 */
describe('同步慢了要在会话里说话，而且 Stop 要掐得动', () => {
  function slowHarness(pushMs: number) {
    const notes: string[] = [];
    let fire: (() => void) | null = null;
    let cancelled = false;
    let t = 0;
    const mgr = new RemoteSyncManager({
      note: (_s, text) => notes.push(text),
      log: () => {},
      interval: (fn) => { fire = fn; return () => { fire = null; }; },
      now: () => t,
    });
    let done: (() => void) | null = null;
    const project: any = {
      localDir: '/l', remoteDir: '/r',
      push: () => new Promise((res) => { done = () => res({ ok: true, snapshot: {}, ms: pushMs }); }),
      pull: async () => ({ ok: true, changed: [], conflicts: [], ms: 1 }),
      cancel: () => { cancelled = true; done?.(); },
    };
    mgr.register({ sessionId: 's1', project, hostLabel: 'aws-tokyo' });
    return {
      mgr, notes, project,
      tick: (ms: number) => { t += ms; fire?.(); },
      finish: () => done?.(),
      wasCancelled: () => cancelled,
    };
  }

  /* `beforeTurn` 是异步的：要先让出一次微任务，它才真的调到 push / 注册好定时器。
     少了这一步，`tick()` 打在空气上（定时器还没注册），而 `cancel()` 也掐不到任何东西。 */
  const settle = () => new Promise((r) => setImmediate(r));

  test('第一句在 15 秒，说清在等什么、等了多久、怎么停', async () => {
    const h = slowHarness(60_000);
    const p = h.mgr.beforeTurn('s1');
    await settle();
    h.tick(SLOW_SYNC_NOTICE_MS);
    assert.equal(h.notes.length, 1);
    assert.match(h.notes[0], /正在把本地推到 aws-tokyo（已 15s）/);
    assert.match(h.notes[0], /按 Stop/, '不告诉人怎么停，等于让人干等');
    h.finish();
    await p;
  });

  test('之后每 30 秒续报一次 —— 让人知道它还活着', async () => {
    const h = slowHarness(60_000);
    const p = h.mgr.beforeTurn('s1');
    await settle();
    h.tick(SLOW_SYNC_NOTICE_MS);            // 第一句
    h.tick(SLOW_SYNC_NOTICE_MS);            // 才过 15s，不该说
    assert.equal(h.notes.length, 1, `说了 ${h.notes.length} 句`);
    h.tick(SLOW_SYNC_NOTICE_MS);            // 累计 30s，续报
    assert.equal(h.notes.length, 2);
    assert.match(h.notes[1], /还在把本地推到 aws-tokyo（已 45s）/);
    h.finish();
    await p;
  });

  test('**同步快就一句话都不说** —— 正常的一轮不该被提示刷屏', async () => {
    const h = slowHarness(1);
    const p = h.mgr.beforeTurn('s1');
    await settle();
    h.finish();
    await p;
    assert.deepEqual(h.notes, []);
  });

  test('Stop 真的把 rsync 掐掉（不掐就得等它自己跑完，上限 10 分钟）', async () => {
    const h = slowHarness(60_000);
    const p = h.mgr.beforeTurn('s1');
    await settle();
    h.mgr.cancel('s1');
    await p;
    assert.equal(h.wasCancelled(), true);
  });

  test('接线：acp:cancel 一进来就先掐同步', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf("ipcMain.handle('acp:cancel'");
    const body = M.slice(at, at + 1400);
    assert.match(body, /remoteSync\.cancel\(sessionId\);/);
    /* 要在别的分支之前 —— 那些分支会 return，掐同步就轮不到了 */
    assert.ok(body.indexOf('remoteSync.cancel(sessionId);') < body.indexOf('if (entry.priming)'));
  });

  test('rsync 的子进程真的接了 AbortSignal（否则 cancel 只是改了个标志位）', () => {
    const RM = fs.readFileSync(path.join(process.cwd(), 'src/main/remoteMirror.ts'), 'utf8');
    assert.match(RM, /encoding: 'utf8', signal \}/);
    assert.match(RM, /this\.inFlight\?\.abort\(\)/);
    /* **每一次** rsync 都要走可中断那条（推 / dry-run / 正式拉 / 本地没改时的快路径）——
       钉数量会随出口增加而撞，所以钉的是"没有一处漏掉" */
    const all = (RM.match(/'rsync',\s*(push|pull)Args/g) || []).length;
    const cancellable = (RM.match(/runCancellable\('rsync'/g) || []).length;
    assert.equal(cancellable, all, `${all} 处 rsync，只有 ${cancellable} 处可中断`);
    assert.ok(all >= 4);
  });
});
