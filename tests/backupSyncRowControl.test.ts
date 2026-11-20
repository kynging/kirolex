/**
 * 同步页每行显示「开关」还是「跟随项目：不同步」标签，以及「已归档」组头的汇总（backupGroups.ts）。
 *
 * 守的是：同步规则不变（归档会话同步与否 = 原项目开关 + 单条开关），只把界面讲清楚 ——
 * 原项目关着时不给灰开关，改成跟随项目的标签；汇总里数字为 0 的段不显示。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupSyncProjects, syncRowControl, archivedSyncSummary, archivedSyncSummaryText } from '../src/renderer/backupGroups.ts';

type S = { id: string; updatedAt: number; archived?: boolean; excluded?: boolean };
const projects = [
  { project: 'Dev', excluded: false, sessions: [
    { id: 'dev-on', updatedAt: 9 },
    { id: 'dev-off', updatedAt: 8, excluded: true },
    { id: 'dev-arch-on', updatedAt: 7, archived: true },
    { id: 'dev-arch-off', updatedAt: 6, archived: true, excluded: true },
  ] as S[] },
  { project: 'Ops', excluded: true, sessions: [
    { id: 'ops-on', updatedAt: 5 },
    { id: 'ops-off', updatedAt: 4, excluded: true },
    { id: 'ops-arch-on', updatedAt: 3, archived: true },
    { id: 'ops-arch-off', updatedAt: 2, archived: true, excluded: true },
  ] as S[] },
  { project: '', excluded: true, sessions: [{ id: 'none-arch', updatedAt: 1, archived: true }] as S[] },
];
const offProjects = new Set(projects.filter((p) => p.excluded).map((p) => p.project));
const isOff = (p: string): boolean => offProjects.has(p);
const groups = groupSyncProjects(projects, () => ({ project: '', excluded: false, sessions: [] }));
const row = (id: string) => {
  for (const g of groups) for (const x of g.sessions) if (x.id === id) return { g, x };
  throw new Error(id);
};

describe('syncRowControl：原项目开/关 × 单条开/关 × 归档组/普通组', () => {
  const cases: Array<[string, boolean, unknown]> = [
    ['dev-on', false, { kind: 'toggle', on: true }],
    ['dev-off', false, { kind: 'toggle', on: false }],
    ['dev-arch-on', true, { kind: 'toggle', on: true }],
    ['dev-arch-off', true, { kind: 'toggle', on: false }],
    ['ops-on', false, { kind: 'follow', project: 'Ops' }],
    ['ops-off', false, { kind: 'follow', project: 'Ops' }],
    ['ops-arch-on', true, { kind: 'follow', project: 'Ops' }],
    ['ops-arch-off', true, { kind: 'follow', project: 'Ops' }],
    ['none-arch', true, { kind: 'follow', project: '' }],
  ];
  for (const [id, inArchived, want] of cases) {
    test(`${id} → ${JSON.stringify(want)}`, () => {
      const { g, x } = row(id);
      assert.equal(g.archived, inArchived);
      assert.deepEqual(syncRowControl(x, isOff), want);
    });
  }
});

describe('archivedSyncSummary：已归档组头的汇总', () => {
  const arch = groups.find((g) => g.archived)!;
  test('三种状态分别计数', () => {
    assert.deepEqual(archivedSyncSummary(arch.sessions, isOff), { synced: 1, followOff: 3, sessionOff: 1 });
  });
  test('中英文案，0 段省略', () => {
    assert.equal(archivedSyncSummaryText({ synced: 1, followOff: 3, sessionOff: 1 }, 'zh'), '1 条同步 · 3 条跟随项目不同步 · 1 条单独关闭');
    assert.equal(archivedSyncSummaryText({ synced: 2, followOff: 0, sessionOff: 0 }, 'zh'), '2 条同步');
    assert.equal(archivedSyncSummaryText({ synced: 0, followOff: 1, sessionOff: 2 }, 'en'), '1 off with its project · 2 turned off individually');
    assert.equal(archivedSyncSummaryText({ synced: 0, followOff: 0, sessionOff: 0 }, 'zh'), '');
  });
  test('空的「已归档」组 → 全 0', () => {
    const g = groupSyncProjects([], () => ({ project: '', excluded: false, sessions: [] as S[] })).find((x) => x.archived)!;
    assert.deepEqual(archivedSyncSummary(g.sessions, isOff), { synced: 0, followOff: 0, sessionOff: 0 });
  });
});
