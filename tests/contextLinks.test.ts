/**
 * 「上下文工程」的跨会话上下文：来源进度**按消息 id 记**，不按位置。
 *
 * 跨电脑同步合并 transcript 是「按 id 去重、按 ts 排序」（`transcriptMerge.ts`），另一台电脑上更早的
 * 消息会插到中间 —— 按位置截取（原来的 `syncedCount`）就会漏发 / 重发；来源变短以后会永久停住；
 * 来源被合并成新 id（record 的 `migratedFrom`）以后关联还指着旧 id。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  takeContextDelta,
  normalizeSavedLinks,
  retargetContextLinks,
  migrationSuccessor,
  migrateLegacyLink,
  dropGoneSources,
  type ContextLink,
} from '../src/renderer/contextLinks.ts';

const m = (id: string, ts: number, role = 'user') => ({ id, ts, role, content: `msg ${id}` });
/** 模拟 transcriptMerge：按 id 去重、按 ts 稳定排序 */
const merge = (a: any[], b: any[]) => {
  const seen = new Set(a.map((x) => x.id));
  return [...a, ...b.filter((x) => !seen.has(x.id))].sort((x, y) => x.ts - y.ts);
};
const link = (over: Partial<ContextLink> = {}): ContextLink => ({ sourceId: 'src', sourceTitle: '来源', injectedIds: [], ...over });

describe('按 id 记进度', () => {
  test('合并进一条更早的 x、再加一条 d：只注入 x 和 d，不重复 a、b、c', () => {
    let src = [m('a', 10), m('b', 20), m('c', 30)];
    const first = takeContextDelta(link(), src);
    assert.deepEqual(first.delta.map((x) => x.id), ['a', 'b', 'c']);

    src = merge(src, [m('x', 5)]);
    assert.deepEqual(src.map((x) => x.id), ['x', 'a', 'b', 'c']);
    src = [...src, m('d', 40)];

    const second = takeContextDelta(first.link, src);
    assert.deepEqual(second.delta.map((x) => x.id), ['x', 'd']);
    const third = takeContextDelta(second.link, src);
    assert.deepEqual(third.delta, []);
    assert.equal(third.changed, false);
  });

  test('新增的按 ts 排序注入，不管它在数组里的位置', () => {
    const r = takeContextDelta(link({ injectedIds: ['a'] }), [m('a', 10), m('z', 50), m('y', 20)]);
    assert.deepEqual(r.delta.map((x) => x.id), ['y', 'z']);
  });

  test('来源从 10 条变成 3 条、再新增 1 条：注入那 1 条，不卡住、不重复', () => {
    const ten = Array.from({ length: 10 }, (_, i) => m(`m${i}`, i + 1));
    const a = takeContextDelta(link(), ten);
    assert.equal(a.delta.length, 10);

    const shrunk = [m('m7', 8), m('m8', 9), m('m9', 10)];
    const b = takeContextDelta(a.link, shrunk);
    assert.deepEqual(b.delta, []);
    /* 已经不存在的 id 清掉，集合不无限增长 */
    assert.deepEqual([...b.link.injectedIds!].sort(), ['m7', 'm8', 'm9']);

    const c = takeContextDelta(b.link, [...shrunk, m('new', 11)]);
    assert.deepEqual(c.delta.map((x) => x.id), ['new']);
    assert.deepEqual(takeContextDelta(c.link, [...shrunk, m('new', 11)]).delta, []);
  });

  test('来源被清空：不报错，之后的新消息照常注入', () => {
    const a = takeContextDelta(link(), [m('a', 1), m('b', 2)]);
    const empty = takeContextDelta(a.link, []);
    assert.deepEqual(empty.delta, []);
    assert.deepEqual(empty.link.injectedIds, []);
    assert.deepEqual(takeContextDelta(empty.link, [m('c', 3)]).delta.map((x) => x.id), ['c']);
  });

  test('读来源失败（keep）时不清集合：恢复后不会把旧消息重发一遍', () => {
    const a = takeContextDelta(link(), [m('a', 1), m('b', 2)]);
    const failed = takeContextDelta(a.link, [], { keepMissing: true });
    assert.deepEqual([...failed.link.injectedIds!].sort(), ['a', 'b']);
    assert.deepEqual(takeContextDelta(failed.link, [m('a', 1), m('b', 2)]).delta, []);
  });

  test('同一条消息永远只注入一次（同 id 出现两次也只算一条）', () => {
    const r = takeContextDelta(link(), [m('a', 1), m('a', 1)]);
    assert.deepEqual(r.delta.map((x) => x.id), ['a']);
  });
});

describe('旧格式 syncedCount 迁移', () => {
  test('{syncedCount:2} 等价于「前 2 条的 id 已注入」', () => {
    const src = [m('a', 1), m('b', 2), m('c', 3)];
    const legacy = { sourceId: 'src', sourceTitle: '来源', syncedCount: 2 } as ContextLink;
    const r = takeContextDelta(legacy, src);
    assert.deepEqual(r.delta.map((x) => x.id), ['c']);
    assert.equal(r.changed, true);
    assert.equal('syncedCount' in r.link, false, '迁移以后不再用 syncedCount');

    const fresh = takeContextDelta(link({ injectedIds: ['a', 'b'] }), src);
    assert.deepEqual(r.delta, fresh.delta);
    assert.deepEqual([...r.link.injectedIds!].sort(), [...fresh.link.injectedIds!].sort());
  });

  test('迁移后来源再插进更早的消息，也只注入新的', () => {
    const legacy = { sourceId: 'src', sourceTitle: '来源', syncedCount: 2 } as ContextLink;
    const r = takeContextDelta(legacy, [m('a', 1), m('b', 2)]);
    assert.deepEqual(r.delta, []);
    const r2 = takeContextDelta(r.link, [m('x', 0), m('a', 1), m('b', 2)]);
    assert.deepEqual(r2.delta.map((x) => x.id), ['x']);
  });

  test('syncedCount 超出长度（来源变短过）：全部算已注入，不卡住', () => {
    const legacy = { sourceId: 'src', sourceTitle: '来源', syncedCount: 99 } as ContextLink;
    const r = takeContextDelta(legacy, [m('a', 1)]);
    assert.deepEqual(r.delta, []);
    assert.deepEqual(takeContextDelta(r.link, [m('a', 1), m('b', 2)]).delta.map((x) => x.id), ['b']);
  });

  test('normalizeSavedLinks：老的单对象格式变数组，坏条目丢掉', () => {
    const out = normalizeSavedLinks([
      ['t1', { sourceId: 's1', sourceTitle: 'A', syncedCount: 3 }],
      ['t2', [{ sourceId: 's2', sourceTitle: 'B', injectedIds: ['x'] }, { bogus: 1 }]],
      ['t3', []],
      'junk',
    ]);
    assert.deepEqual(out, [
      ['t1', [{ sourceId: 's1', sourceTitle: 'A', syncedCount: 3 }]],
      ['t2', [{ sourceId: 's2', sourceTitle: 'B', injectedIds: ['x'] }]],
    ]);
  });
});

describe('来源 id 迁移（migratedFrom）', () => {
  test('来源被合并成新 id：关联改到新 id，已注入集合保留', () => {
    const links = new Map<string, ContextLink[]>([['target', [link({ sourceId: '9jtmvt', sourceTitle: '技术问题', injectedIds: ['a', 'b'] })]]]);
    const sessions = [
      { id: 'target', title: 'T' },
      { id: 's_mc_1_1784087437', title: '技术问题', migratedFrom: '9jtmvt' },
    ];
    const r = retargetContextLinks(links, sessions);
    assert.equal(r.changed, true);
    assert.deepEqual(r.links.get('target'), [{ sourceId: 's_mc_1_1784087437', sourceTitle: '技术问题', injectedIds: ['a', 'b'] }]);
    /* 改过去以后，按新 id 读到的来源里 a、b 不再重发 */
    const d = takeContextDelta(r.links.get('target')![0], [m('a', 1), m('b', 2), m('c', 3)]);
    assert.deepEqual(d.delta.map((x) => x.id), ['c']);
  });

  test('migratedFrom 可以是数组，也能顺着链走（a→b→c）', () => {
    const sessions = [
      { id: 'b', title: 'B', migratedFrom: ['zz', 'a'] },
      { id: 'c', title: 'C', migratedFrom: 'b' },
    ];
    assert.equal(migrationSuccessor('a', sessions), 'c');
    assert.equal(migrationSuccessor('c', sessions), null);
    /* 成环也不死循环 */
    assert.equal(migrationSuccessor('p', [{ id: 'q', migratedFrom: 'p' }, { id: 'p', migratedFrom: 'q' }]), null);
  });

  test('新 id 已经关联过：合并成一条，两边的已注入集合都保留', () => {
    const links = new Map<string, ContextLink[]>([['t', [
      link({ sourceId: 'old', injectedIds: ['a'] }),
      link({ sourceId: 'new', sourceTitle: '新', injectedIds: ['b'] }),
    ]]]);
    const r = retargetContextLinks(links, [{ id: 'new', title: '新', migratedFrom: 'old' }]);
    const arr = r.links.get('t')!;
    assert.equal(arr.length, 1);
    assert.equal(arr[0].sourceId, 'new');
    assert.deepEqual([...arr[0].injectedIds!].sort(), ['a', 'b']);
  });

  test('来源被并进了目标会话自己：这条关联去掉（不能自己同步自己）', () => {
    const links = new Map<string, ContextLink[]>([['t', [link({ sourceId: 'old' })]]]);
    const r = retargetContextLinks(links, [{ id: 't', title: 'T', migratedFrom: 'old' }]);
    assert.equal(r.changed, true);
    assert.equal(r.links.has('t'), false);
  });

  test('旧格式（syncedCount）和新格式并到同一来源：先按旧来源迁移成 id，再合并，不重发 a、b', () => {
    const links = new Map<string, ContextLink[]>([['t', [
      { sourceId: 'old', sourceTitle: '旧', syncedCount: 2 } as ContextLink,
      link({ sourceId: 'new', sourceTitle: '新', injectedIds: ['c'] }),
    ]]]);
    const sessions = [{ id: 'new', title: '新', migratedFrom: 'old' }];
    /* 还没迁移时不合并（合并了就丢了旧进度） */
    const early = retargetContextLinks(links, sessions);
    assert.equal(early.changed, false);
    assert.equal(early.links.get('t')!.length, 2);
    /* 按旧来源自己的 transcript 迁移，再合并 */
    const oldTranscript = [m('a', 1), m('b', 2), m('later', 9)];
    const migrated = new Map([...links].map(([k, arr]) => [k, arr.map((l) => l.sourceId === 'old' ? migrateLegacyLink(l, oldTranscript) : l)]));
    const r = retargetContextLinks(migrated, sessions);
    assert.equal(r.changed, true);
    const arr = r.links.get('t')!;
    assert.equal(arr.length, 1);
    assert.deepEqual([...arr[0].injectedIds!].sort(), ['a', 'b', 'c']);
    const d = takeContextDelta(arr[0], [m('a', 1), m('b', 2), m('c', 3), m('later', 9), m('d', 10)]);
    assert.deepEqual(d.delta.map((x) => x.id), ['later', 'd']);
  });

  test('migrateLegacyLink：前 syncedCount 条记为已注入，新格式原样不动', () => {
    const r = migrateLegacyLink({ sourceId: 's', sourceTitle: 'S', syncedCount: 2 } as ContextLink, [m('a', 1), m('b', 2), m('c', 3)]);
    assert.deepEqual(r, { sourceId: 's', sourceTitle: 'S', injectedIds: ['a', 'b'] });
    const fresh = link({ injectedIds: ['z'] });
    assert.equal(migrateLegacyLink(fresh, [m('a', 1)]), fresh);
  });

  test('没有迁移：原样不动', () => {
    const links = new Map<string, ContextLink[]>([['t', [link()]]]);
    const r = retargetContextLinks(links, [{ id: 'src', title: '来源' }]);
    assert.equal(r.changed, false);
    assert.equal(r.links, links);
  });
});

describe('来源删掉了、又没有后继', () => {
  test('去掉指着它的关联，报出它给几个会话提供过上下文', () => {
    const links = new Map<string, ContextLink[]>([
      ['t1', [link({ sourceId: 'gone', sourceTitle: '技术问题' }), link({ sourceId: 'keep' })]],
      ['t2', [link({ sourceId: 'gone', sourceTitle: '技术问题' })]],
      ['t3', [link({ sourceId: 'keep' })]],
    ]);
    const r = dropGoneSources(links, ['gone']);
    assert.equal(r.changed, true);
    assert.deepEqual(r.links.get('t1')!.map((l) => l.sourceId), ['keep']);
    assert.equal(r.links.has('t2'), false);
    assert.deepEqual(r.dropped, [{ sourceId: 'gone', sourceTitle: '技术问题', targets: 2 }]);
  });

  test('先跟 migratedFrom，跟得上的不算删除', () => {
    const links = new Map<string, ContextLink[]>([['t', [link({ sourceId: 'old', injectedIds: ['a'] })]]]);
    const moved = retargetContextLinks(links, [{ id: 'new', title: '新', migratedFrom: 'old' }]);
    const r = dropGoneSources(moved.links, ['old']);
    assert.equal(r.changed, false);
    assert.deepEqual(r.links.get('t'), [{ sourceId: 'new', sourceTitle: '新', injectedIds: ['a'] }]);
  });

  test('目标自己删了：它的关联一起去掉，不提示', () => {
    const r = dropGoneSources(new Map([['t', [link()]]]), ['t']);
    assert.equal(r.changed, true);
    assert.equal(r.links.size, 0);
    assert.deepEqual(r.dropped, []);
  });

  test('没有删掉的：原样不动', () => {
    const links = new Map([['t', [link()]]]);
    assert.equal(dropGoneSources(links, ['x']).links, links);
  });
});

describe('接线', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/renderer/hooks/useAcp.ts'), 'utf-8');
  test('发送时不再按位置截取', () => {
    assert.doesNotMatch(src, /srcMsgs\.slice\(link\.syncedCount\)/);
    assert.match(src, /takeContextDelta\(/);
    assert.match(src, /retargetContextLinks\(/);
  });
  test('删除会话、主进程删除通知、启动水化都走同一个清理（先跟迁移、再去掉没后继的、提示）', () => {
    assert.match(src, /const settleContextLinks = /);
    const del = src.slice(src.indexOf('const deleteSession = useCallback'), src.indexOf('const deleteSession = useCallback') + 6000);
    assert.match(del, /settleContextLinks\(/);
    const forget = src.slice(src.indexOf('const forgetSessions = useCallback'), src.indexOf('const forgetSessions = useCallback') + 1500);
    assert.match(forget, /settleContextLinks\(/);
    const hydrate = src.slice(src.indexOf('const hydrateFromDisk = useCallback'), src.indexOf('const hydrateFromDiskRef'));
    assert.match(hydrate, /settleContextLinks\(/);
  });
  test('关联照旧只存本机 ui-state', () => {
    assert.match(src, /uiSet\(\s*'kirolex-context-links'/);
  });
  test('主进程把 migratedFrom 带给渲染层', () => {
    const main = fs.readFileSync(path.join(import.meta.dirname, '../src/main/index.ts'), 'utf-8');
    const at = main.indexOf("ipcMain.handle('acp:list-durable-sessions'");
    assert.ok(at > 0);
    assert.match(main.slice(at, at + 8000), /migratedFrom/);
  });
});
