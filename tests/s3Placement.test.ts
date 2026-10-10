import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import {
  placementOf, placementToFollow, applyPlacement, mergeCatalog,
} from '../src/main/s3Sync.ts';
import type { CatalogEntry } from '../src/main/s3Sync.ts';
import { mergeRecords } from '../src/main/transcriptMerge.ts';

/*
 * 「同步时让会话的项目和归档状态在多台机器间自动跟随」。
 *
 * 原来项目 / 归档只是 record 里的字段，跟着整份记录的 updatedAt 走：A 把会话移到 Y，
 * B 上这条之后又发过消息（updatedAt 更新），B 同步时就把旧的 X 传回去，A 的移动被盖掉。
 * 现在有一个只在"位置"被用户改动时才动的时间戳 placementChangedAt，位置按它谁新用谁。
 */

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 's1', title: 't', updatedAt: 100, bytes: 1, from: 'aaaaaa-A', syncedAt: 100, ...over,
});
const rec = (over: any = {}): any => ({
  id: 's1', title: 't', updatedAt: 100, createdAt: 1, executorState: 'detached',
  profile: { model: 'm', projectId: 'X' }, ...over,
});

describe('placementOf', () => {
  test('老记录没有新字段：当作 0、未归档', () => {
    assert.deepEqual(placementOf({ profile: {} }), { projectId: '', archived: false, placementChangedAt: 0 });
    assert.deepEqual(placementOf(null), { projectId: '', archived: false, placementChangedAt: 0 });
    assert.deepEqual(placementOf(rec({ archived: true, placementChangedAt: 5 })), { projectId: 'X', archived: true, placementChangedAt: 5 });
  });
});

describe('placementToFollow：本机要不要跟随桶里的位置', () => {
  test('桶里更新 → 跟随成桶里的项目', () => {
    const p = placementToFollow(rec({ placementChangedAt: 10 }), entry({ project: 'Y', placementChangedAt: 20 }));
    assert.deepEqual(p, { projectId: 'Y', archived: false, placementChangedAt: 20 });
  });

  test('桶里更新 → 跟随归档', () => {
    const p = placementToFollow(rec(), entry({ project: 'X', archived: true, placementChangedAt: 20 }));
    assert.deepEqual(p, { projectId: 'X', archived: true, placementChangedAt: 20 });
  });

  test('桶里移到"未分组"（project 缺省）也要跟随', () => {
    const p = placementToFollow(rec({ placementChangedAt: 1 }), entry({ placementChangedAt: 2 }));
    assert.deepEqual(p, { projectId: '', archived: false, placementChangedAt: 2 });
  });

  test('本机更新或一样新 → 不跟随', () => {
    assert.equal(placementToFollow(rec({ placementChangedAt: 30 }), entry({ project: 'Y', placementChangedAt: 20 })), null);
    assert.equal(placementToFollow(rec({ placementChangedAt: 20 }), entry({ project: 'Y', placementChangedAt: 20 })), null);
  });

  test('不跟着整份记录的 updatedAt 走：本机发过消息（updatedAt 更新）照样跟随', () => {
    const p = placementToFollow(rec({ updatedAt: 999, placementChangedAt: 10 }), entry({ updatedAt: 50, project: 'Y', placementChangedAt: 20 }));
    assert.equal(p?.projectId, 'Y');
  });

  test('老 catalog 条目没有 placementChangedAt → 不跟随（不乱改）', () => {
    assert.equal(placementToFollow(rec(), entry({ project: 'Y' })), null);
    assert.equal(placementToFollow(rec({ placementChangedAt: 0 }), entry({ project: 'Y', archived: true })), null);
  });

  test('桶里没有这条 / 本机没有记录 → 不跟随', () => {
    assert.equal(placementToFollow(rec(), undefined), null);
    assert.equal(placementToFollow(null, entry({ project: 'Y', placementChangedAt: 20 })), null);
  });

  test('位置其实一样、只是时间戳新 → 只同步时间戳', () => {
    const p = placementToFollow(rec({ placementChangedAt: 1 }), entry({ project: 'X', placementChangedAt: 2 }));
    assert.deepEqual(p, { projectId: 'X', archived: false, placementChangedAt: 2 });
  });

  test('坏数据（字符串时间戳、空白项目名）不出错', () => {
    const p = placementToFollow(rec({ placementChangedAt: 'x' }), entry({ project: '  Y ', placementChangedAt: '20' as any }));
    assert.deepEqual(p, { projectId: 'Y', archived: false, placementChangedAt: 20 });
  });
});

describe('applyPlacement：只改三个字段', () => {
  test('改 projectId / archived / placementChangedAt，其他字段原样', () => {
    const before = rec({ updatedAt: 500, title: '标题', tags: ['a'], cliSessionId: 'c' });
    const after = applyPlacement(before, { projectId: 'Y', archived: true, placementChangedAt: 20 });
    assert.equal(after.profile.projectId, 'Y');
    assert.equal(after.archived, true);
    assert.equal(after.placementChangedAt, 20);
    assert.equal(after.updatedAt, 500);
    assert.equal(after.title, '标题');
    assert.equal(after.profile.model, 'm');
    assert.deepEqual(after.tags, ['a']);
    assert.equal(after.cliSessionId, 'c');
    assert.equal(before.profile.projectId, 'X', '不改传进来的那份');
  });

  test('未分组 → projectId 删掉（和 move-session 的写法一致）', () => {
    const after = applyPlacement(rec(), { projectId: '', archived: false, placementChangedAt: 3 });
    assert.equal('projectId' in after.profile, false);
    assert.equal(after.archived, false);
  });
});

describe('mergeRecords：位置三字段按 placementChangedAt 谁新用谁', () => {
  const L = (over: any) => rec({ title: '本地', ...over });
  const R = (over: any) => rec({ title: '远端', ...over });

  for (const [name, lu, ru] of [['本地 updatedAt 新', 300, 200], ['远端 updatedAt 新', 200, 300], ['updatedAt 一样', 200, 200]] as const) {
    test(`${name}，远端位置新 → 位置用远端`, () => {
      const out = mergeRecords(
        L({ updatedAt: lu, placementChangedAt: 10, profile: { model: 'm', projectId: 'X' }, archived: false }),
        R({ updatedAt: ru, placementChangedAt: 20, profile: { model: 'm', projectId: 'Y' }, archived: true }),
      );
      assert.equal(out.profile.projectId, 'Y');
      assert.equal(out.archived, true);
      assert.equal(out.placementChangedAt, 20);
      /* 其他字段仍按 updatedAt */
      assert.equal(out.title, lu >= ru ? '本地' : '远端');
    });
    test(`${name}，本地位置新 → 位置用本地`, () => {
      const out = mergeRecords(
        L({ updatedAt: lu, placementChangedAt: 20, profile: { model: 'm', projectId: 'X' }, archived: true }),
        R({ updatedAt: ru, placementChangedAt: 10, profile: { model: 'm', projectId: 'Y' }, archived: false }),
      );
      assert.equal(out.profile.projectId, 'X');
      assert.equal(out.archived, true);
      assert.equal(out.placementChangedAt, 20);
      assert.equal(out.title, lu >= ru ? '本地' : '远端');
    });
  }

  test('位置新的那边是"未分组 + 未归档"：字段被清掉，而不是留着另一边的', () => {
    const out = mergeRecords(
      L({ updatedAt: 300, placementChangedAt: 10, profile: { model: 'm2', projectId: 'X' }, archived: true }),
      R({ updatedAt: 200, placementChangedAt: 20, profile: { model: 'm' } }),
    );
    assert.equal(out.profile.projectId, undefined);
    assert.equal(!!out.archived, false);
    assert.equal(out.profile.model, 'm2', 'profile 里别的字段仍按 updatedAt');
  });

  test('老记录（两边都没有 placementChangedAt）：行为和原来一样，updatedAt 新的赢', () => {
    const out = mergeRecords(
      L({ updatedAt: 200, profile: { model: 'm', projectId: 'X' } }),
      R({ updatedAt: 300, profile: { model: 'm', projectId: 'Y' }, archived: true }),
    );
    assert.equal(out.profile.projectId, 'Y');
    assert.equal(out.archived, true);
    assert.equal(out.placementChangedAt, undefined, '不凭空造一个时间戳');
  });

  test('只有一边有 placementChangedAt：有的那边算新', () => {
    const out = mergeRecords(
      L({ updatedAt: 300, profile: { model: 'm', projectId: 'X' } }),
      R({ updatedAt: 200, placementChangedAt: 5, profile: { model: 'm', projectId: 'Y' } }),
    );
    assert.equal(out.profile.projectId, 'Y');
    assert.equal(out.placementChangedAt, 5);
  });

  test('不改传进来的对象', () => {
    const l = L({ updatedAt: 300, placementChangedAt: 1 });
    const r = R({ updatedAt: 200, placementChangedAt: 2, profile: { model: 'm', projectId: 'Y' } });
    mergeRecords(l, r);
    assert.equal(l.profile.projectId, 'X');
  });
});

describe('场景：两台机器', () => {
  /* 按 runS3Sync 的顺序走一遍：读桶里 catalog → 跟随 → 生成本机条目 → 并进 catalog */
  const syncOn = (local: any, catalog: { version: 1; entries: CatalogEntry[] }, machine: string) => {
    const theirs = catalog.entries.find((e) => e.id === local.id);
    const p = placementToFollow(local, theirs);
    const next = p ? applyPlacement(local, p) : local;
    const mine = placementOf(next);
    const fresh: CatalogEntry = {
      id: next.id, title: next.title, updatedAt: next.updatedAt, bytes: 1, from: machine, syncedAt: 0,
      project: mine.projectId || undefined, archived: mine.archived, placementChangedAt: mine.placementChangedAt,
    };
    return { local: next, catalog: mergeCatalog(catalog, [fresh]) };
  };

  for (const kind of ['move', 'archive'] as const) {
    test(`A 先${kind === 'move' ? '把会话从 X 移到 Y' : '归档'}，B 之后又发过消息 → B 同步后跟随，桶里也没被改回`, () => {
      /* A 动了位置并同步 */
      const aRec = rec({ updatedAt: 1000, placementChangedAt: 1000, ...(kind === 'move'
        ? { profile: { model: 'm', projectId: 'Y' } }
        : { archived: true }) });
      const bucket = syncOn(aRec, { version: 1, entries: [] }, 'A').catalog;
      /* B 上这条之后发过消息：updatedAt 比 A 新，位置还是旧的 */
      const bRec = rec({ updatedAt: 2000 });
      const after = syncOn(bRec, bucket, 'B');
      const want = kind === 'move' ? { projectId: 'Y', archived: false } : { projectId: 'X', archived: true };
      assert.equal(placementOf(after.local).projectId, want.projectId);
      assert.equal(placementOf(after.local).archived, want.archived);
      assert.equal(after.local.updatedAt, 2000, '消息那部分不动');
      const e = after.catalog.entries.find((x) => x.id === 's1')!;
      assert.equal(e.from, 'B');
      assert.equal(e.project || '', want.projectId, '桶里 catalog 没被 B 改回 X');
      assert.equal(!!e.archived, want.archived);
      /* 桶里的 record：B 传上去的就是跟随后的那份；就算走合并，位置也取 A 的 */
      const merged = mergeRecords(after.local, aRec);
      assert.equal(placementOf(merged).projectId, want.projectId);
      assert.equal(placementOf(merged).archived, want.archived);
      const mergedStale = mergeRecords(bRec, aRec);
      assert.equal(placementOf(mergedStale).projectId, want.projectId, '没跟随的旧记录和桶里合并，位置也取 A 的');
    });
  }

  test('反过来：B 后移动，A 同步后跟随 B', () => {
    const aRec = rec({ updatedAt: 1000, placementChangedAt: 1000, profile: { model: 'm', projectId: 'Y' } });
    let bucket = syncOn(aRec, { version: 1, entries: [] }, 'A').catalog;
    /* B 先跟随了 A，然后自己移到 Z */
    const b1 = syncOn(rec({ updatedAt: 1500 }), bucket, 'B');
    const bMoved = applyPlacement(b1.local, { projectId: 'Z', archived: false, placementChangedAt: 3000 });
    bucket = syncOn(bMoved, b1.catalog, 'B').catalog;
    /* A 这边又发过消息，updatedAt 比 B 新 */
    const a2 = syncOn({ ...aRec, updatedAt: 5000 }, bucket, 'A');
    assert.equal(placementOf(a2.local).projectId, 'Z');
    assert.equal(a2.catalog.entries.find((x) => x.id === 's1')!.project, 'Z');
  });
});

describe('index.ts 里的接线', () => {
  const M = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const bodyOf = (sig: string) => { const at = M.indexOf(sig); assert.ok(at >= 0, sig); return M.slice(at, M.indexOf('\n  });\n', at)); };

  test('用户改位置的四个入口都盖 placementChangedAt', () => {
    for (const ch of ["'acp:move-session'", "'acp:archive-session'", "'acp:assign-project'", "'acp:set-project'"]) {
      assert.match(bodyOf(`ipcMain.handle(${ch}`), /placementChangedAt = Date\.now\(\)/, ch);
    }
  });

  test('catalog 条目带 archived 和 placementChangedAt', () => {
    const at = M.indexOf('function catalogEntriesFor(');
    const body = M.slice(at, M.indexOf('\n}\n', at));
    assert.match(body, /archived:/);
    assert.match(body, /placementChangedAt:/);
  });

  test('runS3Sync：先跟随桶里的位置，再生成本机的 catalog 条目和上传计划', () => {
    const at = M.indexOf('async function runS3Sync(');
    const body = M.slice(at, M.indexOf('\n}\n', at));
    const follow = body.indexOf('followBucketPlacements(');
    assert.ok(follow > 0, '有跟随这一步');
    assert.ok(follow < body.indexOf('planUpload('), '在上传计划之前');
    assert.ok(follow < body.indexOf('catalogEntriesFor('), '在生成本机 catalog 条目之前');
  });

  test('跟随：不同步的项目/会话不参与、写日志、通知渲染端、忙着的推迟重置', () => {
    const at = M.indexOf('function followBucketPlacements(');
    const body = M.slice(at, M.indexOf('\n}\n', at));
    assert.match(body, /projectExcluded\(/);
    assert.match(body, /sessionExcluded\(/);
    assert.match(body, /logger\.info\('s3'/);
    assert.match(body, /session:placement-changed/);
    assert.match(body, /pendingProjectReset\.add\(/);
  });

  test('忙着的会话被同步挪项目 / 归档：推迟的重置排在这一轮回复落盘之后', () => {
    /* detachExecutor 会立刻把 entry 从 sessionClients 拿掉；排在 flushAssistant 前面，完整回复就丢了 */
    const flush = M.indexOf('flushAssistant(sessionId); // turn complete');
    assert.ok(flush > 0);
    const reset = M.indexOf("consumePendingProjectReset(sessionId, '本轮结束，执行下推的执行器重置')");
    assert.ok(reset > flush, '重置在回复落盘之后');
    /* 消化只走这一个函数，它里面才 detach */
    const helperAt = M.indexOf('function consumePendingProjectReset(');
    const helper = M.slice(helperAt, M.indexOf('\n}\n', helperAt));
    assert.match(helper, /if \(pendingProjectReset\.delete\(sessionId\)\) \{[\s\S]*detachExecutor\(sessionId\)/);
    assert.equal(M.split('pendingProjectReset.delete(').length - 1, 1, '没有别处绕过它直接消化');
    const ret = M.indexOf('return { ...(result || {}), __kirolex: { produced: producedOutput } };', flush);
    assert.ok(ret > reset, '重置在这一轮返回之前');
    for (const after of ['settleAsk(sessionId, askReply)', "type: 'prompt_end'", 'runLocalActions(sessionId, entry, ']) {
      const at = M.indexOf(after, flush);
      assert.ok(at > 0 && at < reset, `${after} 在重置之前（它们都还要用这一轮的 entry）`);
    }
  });

  test('同步移动期间这一轮报错：收尾时也消化重置，下一轮用新执行器', () => {
    /* sendPromptOnce 外层 try（busy = true 之后那个）的 catch 先落盘，finally 再消化重置 */
    const fnAt = M.indexOf('async function sendPromptOnce(');
    const fn = M.slice(fnAt, M.indexOf('\n  }\n', M.indexOf("consumePendingProjectReset(sessionId, '本轮报错结束，执行下推的执行器重置')")));
    const outerTry = fn.indexOf('    try {\n      entry.busy = true;');
    assert.ok(outerTry > 0, '外层 try 在 busy = true 那里开始（busy 被拒的那条路不进来）');
    const outerCatch = fn.indexOf('\n    } catch (err: any) {\n      flushAssistant(sessionId);', outerTry);
    assert.ok(outerCatch > outerTry, '报错先把半截回复落盘');
    const fin = fn.indexOf('\n    } finally {', outerCatch);
    assert.ok(fin > outerCatch, '外层 try 有 finally');
    const tail = fn.slice(fin);
    assert.match(tail, /if \(!sessionClients\.get\(sessionId\)\?\.busy\) consumePendingProjectReset\(sessionId, '本轮报错结束，执行下推的执行器重置'\);/,
      '报错收尾消化重置（别的一轮在跑时不动）');
    /* 之间不能再有别的同级 catch/finally —— 不然 finally 挂错了 try */
    assert.equal(fn.slice(outerCatch + 1, fin).includes('\n    } finally {'), false);
  });
});
