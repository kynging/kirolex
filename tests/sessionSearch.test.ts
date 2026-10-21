import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { searchSessions } from '../src/renderer/sessionSearch.ts';

const S = [
  { id: 'a', title: 'W33 周报草稿', projectId: '周报' },
  { id: 'b', title: 'New Chat', projectId: '周报' },
  { id: 'c', title: 'CloudFront 灾备方案技术评审', projectId: 'AWS' },
  { id: 'd', title: '随手记', archived: true },
];

describe('finding a chat by name', () => {
  test('an empty query is idle — the caller skips filtering', () => {
    const r = searchSessions(S, '   ');
    assert.equal(r.idle, true);
    assert.equal(r.hits.length, 4);
  });

  test('matches a title, case-insensitively, anywhere in it', () => {
    assert.deepEqual(searchSessions(S, 'cloudfront').hits.map((s) => s.id), ['c']);
    assert.deepEqual(searchSessions(S, '灾备').hits.map((s) => s.id), ['c']);
  });

  test('the project name counts as text — 「周报」 finds that project’s chats', () => {
    // Otherwise a search box is a spelling test: you have to remember what the chat was called.
    assert.deepEqual(searchSessions(S, '周报').hits.map((s) => s.id), ['a', 'b']);
  });

  test('it reports which projects have hits, so a collapsed group can open itself', () => {
    // A match hidden inside a folded group reads as 「找不到」 — and most groups are folded by default.
    assert.deepEqual(searchSessions(S, '周报').projects, ['周报']);
    assert.deepEqual(searchSessions(S, '随手').projects, [], '未分组的命中不属于任何 project');
  });

  test('no match is an empty list, not everything', () => {
    assert.deepEqual(searchSessions(S, 'zzz').hits, []);
    assert.equal(searchSessions(S, 'zzz').idle, false);
  });

  test('order is the input order — the sidebar already sorted it', () => {
    assert.deepEqual(searchSessions(S, 'a').hits.map((s) => s.id), searchSessions(S, 'a').hits.map((s) => s.id));
  });
});

/**
 * 按 id 找会话 ——「会话搜索框支持直接粘 id（完整或前缀，比如 `dl006j`）定位到那条会话」。
 *
 * 排查时手里只有日志里的 `sessionId=s_…`、看板 bug 里的一截 id、或者控制入口 `/sessions/:id/…` 的那个 id；
 * 标题对不上号。id 形如 `s_<时间戳>_<6位>`，人最常复制的是**整串**或**最后那 6 位**。
 */
describe('finding a chat by its id', () => {
  const IDS = [
    { id: 's_1760000000000_dl006j', title: '周报', projectId: 'P' },
    { id: 's_1760000000000_ab12cd', title: '灾备评审' },
    { id: 's_1761111111111_zz99yy', title: 'New Chat' },
  ];

  test('the full id finds exactly that chat', () => {
    assert.deepEqual(searchSessions(IDS, 's_1760000000000_dl006j').hits.map((s) => s.id), ['s_1760000000000_dl006j']);
  });

  test('the 6-char suffix finds it — 「比如 dl006j」', () => {
    assert.deepEqual(searchSessions(IDS, 'dl006j').hits.map((s) => s.id), ['s_1760000000000_dl006j']);
    assert.deepEqual(searchSessions(IDS, 'DL006J').hits.map((s) => s.id), ['s_1760000000000_dl006j'], '大小写不敏感');
    assert.deepEqual(searchSessions(IDS, 'dl00').hits.map((s) => s.id), ['s_1760000000000_dl006j'], '后缀的前几位也算');
  });

  test('a prefix of the id finds it', () => {
    assert.deepEqual(searchSessions(IDS, 's_1760000000000_d').hits.map((s) => s.id), ['s_1760000000000_dl006j']);
    assert.deepEqual(searchSessions(IDS, 's_176000').hits.map((s) => s.id), ['s_1760000000000_dl006j', 's_1760000000000_ab12cd']);
  });

  test('a pasted log fragment / quotes / whitespace still work', () => {
    assert.deepEqual(searchSessions(IDS, '  sessionId=s_1760000000000_dl006j ').hits.map((s) => s.id), ['s_1760000000000_dl006j']);
    assert.deepEqual(searchSessions(IDS, '"s_1760000000000_dl006j"').hits.map((s) => s.id), ['s_1760000000000_dl006j']);
    assert.deepEqual(searchSessions(IDS, '/sessions/s_1760000000000_dl006j/tail').hits.map((s) => s.id), ['s_1760000000000_dl006j']);
  });

  test('a too-short fragment does not match every id — 「s_」 is not a search', () => {
    assert.deepEqual(searchSessions(IDS, 's_').hits, []);
    assert.deepEqual(searchSessions(IDS, 'dl').hits, []);
  });

  test('a digit run inside the timestamp is not an id hit (titles like 「2024」 stay title searches)', () => {
    assert.deepEqual(searchSessions(IDS, '0000').hits, []);
  });

  test('title search still works alongside id search', () => {
    assert.deepEqual(searchSessions(IDS, '灾备').hits.map((s) => s.id), ['s_1760000000000_ab12cd']);
    assert.deepEqual(searchSessions(IDS, 'dl006j').projects, ['P']);
  });
});
