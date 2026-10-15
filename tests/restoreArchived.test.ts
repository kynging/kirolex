/**
 * 备份窗口：同步页按本机分组、恢复页按云上分组，固定显示「未分组」「已归档」，每行新旧对比；
 * 恢复时会话的位置（项目 + 归档）按「谁后挪用谁」。
 *
 * 守的是：
 * · 恢复页的分组只取决于 catalog（本机归档了没有不影响），云上 archived 的进「已归档」组；
 * · 同步页本机归档的只在「已归档」组里出现；
 * · 两页都固定有「未分组」「已归档」两组，空的也显示；
 * · 恢复：云上后挪的用云上的位置；本机后挪的、或云上没有 placementChangedAt 的保持本机原来的。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { restorePlacement, catalogProject } from '../src/main/restoreArchive.ts';
import { applyPlacement } from '../src/main/s3Sync.ts';
import { mergeRecords } from '../src/main/transcriptMerge.ts';
import { groupBackups, groupSyncProjects, compareFreshness, FRESHNESS_LABEL, ARCHIVED_GROUP } from '../src/renderer/backupGroups.ts';

const entry = (over: Record<string, any> = {}) =>
  ({ id: 'a', title: 't', updatedAt: 1, bytes: 1, syncedAt: 1, ...over }) as any;

describe('restorePlacement：恢复时谁后挪用谁', () => {
  test('云上后挪的 → 用云上的项目和归档', () => {
    const r = restorePlacement(
      { profile: { projectId: 'Dev' }, archived: false, placementChangedAt: 10 },
      entry({ project: 'Ops', archived: true, placementChangedAt: 20 }),
    );
    assert.ok(r);
    assert.deepEqual(r.placement, { projectId: 'Ops', archived: true, placementChangedAt: 20 });
    assert.equal(r.changed, true);
  });

  test('本机后挪的 → 保持本机原来的（本机归档的继续归档）', () => {
    const r = restorePlacement(
      { profile: { projectId: 'Dev' }, archived: true, placementChangedAt: 30 },
      entry({ project: 'Ops', archived: false, placementChangedAt: 20 }),
    );
    assert.ok(r);
    assert.deepEqual(r.placement, { projectId: 'Dev', archived: true, placementChangedAt: 30 });
    assert.equal(r.changed, false);
  });

  test('云上没有 placementChangedAt（老备份）→ 保持本机的', () => {
    const r = restorePlacement(
      { profile: { projectId: 'Dev' }, archived: true },
      entry({ project: 'Ops', archived: false }),
    );
    assert.ok(r);
    assert.deepEqual(r.placement, { projectId: 'Dev', archived: true, placementChangedAt: 0 });
    assert.equal(r.changed, false);
  });

  test('云上后挪、但位置其实一样 → changed 为 false', () => {
    const r = restorePlacement(
      { profile: { projectId: 'Dev' }, placementChangedAt: 1 },
      entry({ project: 'Dev', placementChangedAt: 5 }),
    );
    assert.ok(r);
    assert.equal(r.changed, false);
  });

  test('本机原来没有这条 → null（直接用备份里的记录）', () => {
    assert.equal(restorePlacement(undefined, entry({ project: 'Ops', placementChangedAt: 20 })), null);
  });

  test('合并后备份 record.json 里的位置盖不掉本机的：applyPlacement 之后是本机那份', () => {
    const local = { id: 'a', updatedAt: 1, profile: { projectId: 'Dev' }, archived: true, placementChangedAt: 30 };
    /* 备份里那份 record.json 的 placementChangedAt 更大，mergeRecords 会选它的位置 */
    const backup = { id: 'a', updatedAt: 2, profile: { projectId: 'Ops' }, archived: false, placementChangedAt: 40 };
    const merged = mergeRecords(local, backup);
    assert.equal(merged.profile.projectId, 'Ops');
    /* catalog 里那条比本机旧 → 保持本机 */
    const r = restorePlacement(local, entry({ project: 'Ops', archived: false, placementChangedAt: 20 }));
    assert.ok(r);
    const out = applyPlacement(merged, r.placement);
    assert.equal(out.profile.projectId, 'Dev');
    assert.equal(out.archived, true);
  });
});

describe('catalogProject：恢复页这条算哪个项目', () => {
  test('云上明确是未分组（project 为空串）→ 未分组，不拿本机的项目补', () => {
    assert.equal(catalogProject(entry({ project: '' }), 'Dev'), undefined);
  });

  test('新格式条目没有 project 字段（写的时候未分组就不写）→ 未分组，不拿本机的项目补', () => {
    assert.equal(catalogProject(entry({ archived: false, placementChangedAt: 0 }), 'Dev'), undefined);
    assert.equal(catalogProject(entry({ archived: false }), 'Dev'), undefined);
  });

  test('云上有项目 → 用云上的', () => {
    assert.equal(catalogProject(entry({ project: 'Ops', archived: false }), 'Dev'), 'Ops');
  });

  test('老 catalog 条目（没有 project / archived / placementChangedAt）→ 用本机记录补；本机也没有就未分组', () => {
    assert.equal(catalogProject(entry(), 'Dev'), 'Dev');
    assert.equal(catalogProject(entry(), ''), undefined);
    assert.equal(catalogProject(entry(), undefined), undefined);
  });
});

describe('groupBackups：恢复页按云上分组', () => {
  const t = (id: string, project: string | undefined, updatedAt: number, archived = false) =>
    ({ id, project, updatedAt, archived });

  test('云上 archived 的进「已归档」组（最后），其余按 catalog 的项目分组', () => {
    const groups = groupBackups([
      t('a', 'Dev', 10),
      t('b', 'Dev', 20, true),
      t('c', undefined, 5),
      t('d', 'Ops', 30, true),
      t('e', 'Ops', 1),
    ]);
    assert.deepEqual(groups.map((g) => [g.name, g.rows.map((r) => r.id)]), [
      ['Dev', ['a']],
      ['Ops', ['e']],
      ['未分组', ['c']],
      ['已归档', ['d', 'b']],
    ]);
    const last = groups[groups.length - 1];
    assert.equal(last.key, ARCHIVED_GROUP);
    assert.equal(last.archived, true);
    assert.equal(groups[0].project, 'Dev');
    assert.equal(groups[2].project, '');
  });

  test('只看 catalog 的 archived：带着 archivedLocally 之类的本机标记也不影响分组', () => {
    const groups = groupBackups([{ id: 'a', project: 'Dev', updatedAt: 1, archived: false, archivedLocally: true } as any]);
    assert.deepEqual(groups.map((g) => [g.name, g.rows.length]), [['Dev', 1], ['未分组', 0], ['已归档', 0]]);
  });

  test('「未分组」「已归档」固定显示，空的也有', () => {
    assert.deepEqual(groupBackups([]).map((g) => [g.name, g.rows.length]), [['未分组', 0], ['已归档', 0]]);
    assert.deepEqual(groupBackups([t('a', 'Dev', 10)]).map((g) => g.name), ['Dev', '未分组', '已归档']);
  });

  test('项目名恰好叫「已归档」也不会和归档组混在一起', () => {
    const groups = groupBackups([t('a', '已归档', 10), t('b', 'Dev', 5, true)]);
    const named = groups.filter((g) => g.name === '已归档');
    assert.equal(named.length, 2);
    assert.deepEqual(named.map((g) => g.archived), [false, true]);
    assert.notEqual(named[0].key, named[1].key);
  });
});

describe('compareFreshness：新旧对比四种', () => {
  test('本机较新 / 云上较新 / 两边一样 / 本地没有', () => {
    assert.equal(compareFreshness({ existsLocally: true, localUpdatedAt: 20, updatedAt: 10 }), 'local-newer');
    assert.equal(compareFreshness({ existsLocally: true, localUpdatedAt: 10, updatedAt: 20 }), 'cloud-newer');
    assert.equal(compareFreshness({ existsLocally: true, localUpdatedAt: 10, updatedAt: 10 }), 'same');
    assert.equal(compareFreshness({ existsLocally: false, localUpdatedAt: 99, updatedAt: 10 }), 'missing');
    assert.deepEqual(
      ['local-newer', 'cloud-newer', 'same', 'missing'].map((k) => FRESHNESS_LABEL[k as keyof typeof FRESHNESS_LABEL]),
      ['本机较新', '云上较新', '两边一样', '本地没有'],
    );
  });
});

describe('groupSyncProjects：同步页按本机分组', () => {
  const s = (id: string, updatedAt: number, archived = false) => ({ id, updatedAt, bytes: 10, archived });
  const blank = () => ({ project: '', sessions: [] as ReturnType<typeof s>[] });

  test('本机归档的只在「已归档」组里，带着原项目；项目组按组内（不含归档）最近更新排', () => {
    const groups = groupSyncProjects([
      { project: 'Dev', sessions: [s('a', 10), s('b', 50, true)] },
      { project: 'Ops', sessions: [s('c', 20)] },
      { project: '', sessions: [s('d', 99, true), s('e', 1)] },
    ], blank);
    assert.deepEqual(groups.map((g) => [g.name, g.sessions.map((x) => x.id)]), [
      ['Ops', ['c']],
      ['Dev', ['a']],
      ['未分组', ['e']],
      ['已归档', ['d', 'b']],
    ]);
    const arch = groups[3];
    assert.equal(arch.archived, true);
    assert.equal(arch.key, ARCHIVED_GROUP);
    assert.deepEqual(arch.sessions.map((x) => x.project), ['', 'Dev']);
    assert.equal(groups[1].archivedCount, 1);
    assert.equal(groups[1].bytes, 10);
  });

  test('没有归档、也没有未分组会话 → 照样有空的「未分组」「已归档」', () => {
    const groups = groupSyncProjects([{ project: 'Dev', sessions: [s('a', 10)] }], blank);
    assert.deepEqual(groups.map((g) => [g.name, g.sessions.length]), [['Dev', 1], ['未分组', 0], ['已归档', 0]]);
    assert.deepEqual(groupSyncProjects([], blank).map((g) => g.name), ['未分组', '已归档']);
  });
});

describe('接线', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  const D = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'BackupDialog.tsx'), 'utf-8');
  const body = (ch: string) => {
    const i = M.indexOf(`ipcMain.handle('${ch}'`);
    return M.slice(i, M.indexOf('ipcMain.handle(', i + 10));
  };

  test('s3:projects 每条会话带 archived', () => {
    assert.match(body('s3:projects'), /archived: !!rec\.archived,/);
  });

  test('s3:list-backups 带回本机 updatedAt 和恢复后位置会不会变，不再按本机归档打标', () => {
    const b = body('s3:list-backups');
    assert.match(b, /localUpdatedAt:/);
    assert.match(b, /restorePlacement\(/);
    assert.doesNotMatch(b, /markArchivedLocally/);
  });

  test('s3:restore 按 restorePlacement 定位置、写回、通知侧栏，不再一律取消归档', () => {
    const b = body('s3:restore');
    assert.match(b, /restorePlacement\(/);
    assert.match(b, /applyPlacement\(/);
    assert.match(b, /session:placement-changed/);
    assert.doesNotMatch(b, /unarchiveRestoredRecord|wasArchived/);
  });

  test('界面：没有「本机已归档」字样，有新旧对比和原属项目', () => {
    assert.doesNotMatch(D, /本机已归档/);
    assert.match(D, /groupBackups\(/);
    assert.match(D, /groupSyncProjects[<(]/);
    assert.match(D, /compareFreshness\(/);
    assert.match(D, /t\('From "\{project\}"'/);
  });
});
