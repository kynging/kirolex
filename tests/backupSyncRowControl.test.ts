/**
 * 同步页每行的开关、「单独设置」标记、组头汇总、项目开关旁的提示（backupGroups.ts）。
 *
 * 守的是「单条优先于项目」（判据 shouldSyncSession）：项目关着时组内每条照常给开关（默认关，可单独打开）；
 * 「已归档」组按原项目算默认值；汇总「N 条同步 · M 条不同步」，0 段省略；
 * 关掉项目不清空单独打开的，项目开关旁提示「其中 K 条单独开着，仍会同步」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupSyncProjects, syncRowState, syncSummary, syncSummaryText, includedWhileProjectOff } from '../src/renderer/backupGroups.ts';

type S = { id: string; updatedAt: number; archived?: boolean };
const projects = [
  { project: 'Dev', sessions: [
    { id: 'dev-default', updatedAt: 9 },
    { id: 'dev-off', updatedAt: 8 },
    { id: 'dev-arch-default', updatedAt: 7, archived: true },
    { id: 'dev-arch-off', updatedAt: 6, archived: true },
  ] as S[] },
  { project: 'Ops', sessions: [
    { id: 'ops-default', updatedAt: 5 },
    { id: 'ops-on', updatedAt: 4 },
    { id: 'ops-arch-default', updatedAt: 3, archived: true },
    { id: 'ops-arch-on', updatedAt: 2, archived: true },
  ] as S[] },
];
const lists = {
  excludeProjects: ['Ops'],
  excludeSessions: ['dev-off', 'dev-arch-off'],
  includeSessions: ['ops-on', 'ops-arch-on'],
};
const groups = groupSyncProjects(projects, () => ({ project: '', sessions: [] as S[] }));
const row = (id: string) => {
  for (const g of groups) for (const x of g.sessions) if (x.id === id) return { g, x };
  throw new Error(id);
};

describe('syncRowState：原项目开/关 × 单条设没设 × 归档组/普通组', () => {
  const cases: Array<[string, boolean, { on: boolean; custom: boolean }]> = [
    ['dev-default', false, { on: true, custom: false }],
    ['dev-off', false, { on: false, custom: true }],
    ['dev-arch-default', true, { on: true, custom: false }],
    ['dev-arch-off', true, { on: false, custom: true }],
    ['ops-default', false, { on: false, custom: false }],
    ['ops-on', false, { on: true, custom: true }],
    ['ops-arch-default', true, { on: false, custom: false }],
    ['ops-arch-on', true, { on: true, custom: true }],
  ];
  for (const [id, inArchived, want] of cases) {
    test(`${id} → ${JSON.stringify(want)}`, () => {
      const { g, x } = row(id);
      assert.equal(g.archived, inArchived);
      assert.deepEqual(syncRowState(x, lists), want);
    });
  }
  test('老 config（includeSessions 为 null）：项目关着 → 关', () => {
    assert.deepEqual(syncRowState({ id: 'ops-on', project: 'Ops' }, { ...lists, includeSessions: null }), { on: false, custom: false });
  });
});

describe('组头汇总', () => {
  const arch = groups.find((g) => g.archived)!;
  test('「已归档」组：按原项目算', () => {
    assert.deepEqual(syncSummary(arch.sessions, lists), { synced: 2, notSynced: 2 });
  });
  test('中英文案，0 段省略', () => {
    assert.equal(syncSummaryText({ synced: 2, notSynced: 3 }, 'zh'), '2 条同步 · 3 条不同步');
    assert.equal(syncSummaryText({ synced: 0, notSynced: 1 }, 'zh'), '1 条不同步');
    assert.equal(syncSummaryText({ synced: 4, notSynced: 0 }, 'en'), '4 syncing');
    assert.equal(syncSummaryText({ synced: 1, notSynced: 2 }, 'en'), '1 syncing · 2 not syncing');
    assert.equal(syncSummaryText({ synced: 0, notSynced: 0 }, 'zh'), '');
  });
});

describe('includedWhileProjectOff：关掉项目后仍会同步的那几条', () => {
  const all = groups.flatMap((g) => g.sessions);
  test('项目关着：数单独打开的（含已归档的）', () => {
    assert.equal(includedWhileProjectOff('Ops', all, lists), 2);
  });
  test('项目开着：0（不提示）', () => {
    assert.equal(includedWhileProjectOff('Dev', all, lists), 0);
  });
  test('项目关着但没有单独打开的：0', () => {
    assert.equal(includedWhileProjectOff('Ops', all, { ...lists, includeSessions: [] }), 0);
  });
});
