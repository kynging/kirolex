/**
 * 恢复页标出「本机已归档」的会话，恢复时取消归档回到原项目。
 *
 * 守的是：本机已归档的会话在恢复页不再混在原项目组里（用户会以为它还在项目里），
 * 而是单独放进「已归档」组；对它点恢复（合并）之后，记录里 archived 变回 false、
 * projectId 保持合并后那份（就是它原来的项目），侧栏才能马上在项目里看到它。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { markArchivedLocally, unarchiveRestoredRecord } from '../src/main/restoreArchive.ts';
import { groupBackups, ARCHIVED_GROUP } from '../src/renderer/backupGroups.ts';

describe('markArchivedLocally：按本机记录给备份打标', () => {
  test('本机归档的标 true；没归档 / 本机没有的标 false', () => {
    const out = markArchivedLocally(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ id: 'a', archived: true }, { id: 'b', archived: false }],
    );
    assert.deepEqual(out.map((e) => [e.id, e.archivedLocally]), [['a', true], ['b', false], ['c', false]]);
  });

  test('不动原来的字段', () => {
    const [e] = markArchivedLocally([{ id: 'a', project: 'Dev', title: 't' }], [{ id: 'a', archived: true }]);
    assert.equal(e.project, 'Dev');
    assert.equal(e.title, 't');
  });
});

describe('unarchiveRestoredRecord：合并后取消归档', () => {
  test('本机原来是归档的 → archived 设成 false，项目用合并后记录里的', () => {
    const r = unarchiveRestoredRecord({ id: 'a', archived: true, profile: { projectId: 'Dev' } }, true);
    assert.ok(r);
    /* 必须是显式 false：渲染端水化是 `rec.archived ?? existing.archived`，字段不存在会退回旧值 */
    assert.equal(r.record.archived, false);
    assert.equal(r.record.profile.projectId, 'Dev');
    assert.equal(r.projectId, 'Dev');
  });

  test('合并后记录已经不是归档（远端更新那份赢了），本机原来归档也照样写 false', () => {
    const r = unarchiveRestoredRecord({ id: 'a', profile: { projectId: 'Dev' } }, true);
    assert.ok(r);
    assert.equal(r.record.archived, false);
  });

  test('没有项目 → projectId 为 undefined（提示里写未分组）', () => {
    const r = unarchiveRestoredRecord({ id: 'a', archived: true, profile: {} }, true);
    assert.ok(r);
    assert.equal(r.projectId, undefined);
  });

  test('本机原来没归档 → 不动（返回 null），行为和以前一样', () => {
    assert.equal(unarchiveRestoredRecord({ id: 'a', archived: false }, false), null);
    assert.equal(unarchiveRestoredRecord({ id: 'a', archived: true }, false), null);
  });

  test('合并后的记录读不出来 → 不动', () => {
    assert.equal(unarchiveRestoredRecord(undefined, true), null);
  });

  test('不改传进来的对象', () => {
    const rec = { id: 'a', archived: true, profile: { projectId: 'Dev' } };
    unarchiveRestoredRecord(rec, true);
    assert.equal(rec.archived, true);
  });
});

describe('groupBackups：恢复页分组', () => {
  const t = (id: string, project: string | undefined, updatedAt: number, archivedLocally = false) =>
    ({ id, project, updatedAt, archivedLocally });

  test('本机已归档的不在原项目组里，统一进「已归档」组，排在各项目组（含未分组）之后', () => {
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
  });

  test('项目名恰好叫「已归档」也不会和归档组混在一起', () => {
    const groups = groupBackups([t('a', '已归档', 10), t('b', 'Dev', 5, true)]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.archived), [false, true]);
    assert.notEqual(groups[0].key, groups[1].key);
  });

  test('没有归档的就没有「已归档」组', () => {
    const groups = groupBackups([t('a', 'Dev', 10)]);
    assert.deepEqual(groups.map((g) => g.name), ['Dev']);
  });
});

describe('接线', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  const D = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'BackupDialog.tsx'), 'utf-8');

  test('s3:list-backups 用 markArchivedLocally 打标', () => {
    const i = M.indexOf("ipcMain.handle('s3:list-backups'");
    const body = M.slice(i, M.indexOf('ipcMain.handle(', i + 10));
    assert.match(body, /markArchivedLocally\(/);
  });

  test('s3:restore 合并前记下本机是否归档，合并后取消归档并 tmp + rename 写回', () => {
    const i = M.indexOf("ipcMain.handle('s3:restore'");
    const body = M.slice(i, M.indexOf('ipcMain.handle(', i + 10));
    assert.match(body, /wasArchived/);
    assert.match(body, /unarchiveRestoredRecord\(/);
    assert.match(body, /renameSync\(/);
    assert.match(body, /unarchived/);
  });

  test('恢复页显示「本机已归档」标记和原项目，恢复提示里说已取消归档', () => {
    assert.match(D, /本机已归档/);
    assert.match(D, /groupBackups\(/);
    assert.match(D, /已取消归档/);
  });
});
