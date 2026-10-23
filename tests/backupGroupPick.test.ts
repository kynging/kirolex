/**
 * 恢复页每个组头的「全选」和「删除选中的 N 条」用的纯逻辑（backupGroups.ts）。
 *
 * 守的是：全选只动这一组、跳过正在跑（busy）的行；组里勾了一部分是半选；
 * 组头的删除只拿这一组里勾选的 id —— 不再一键删整个项目。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { groupPickState, toggleGroupPick } from '../src/renderer/backupGroups.ts';

const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c', busy: true }];

describe('groupPickState', () => {
  test('一条没勾 → none，pickedIds 为空', () => {
    const s = groupPickState(rows, new Set(['x']));
    assert.equal(s.state, 'none');
    assert.deepEqual(s.pickedIds, []);
  });
  test('勾了一部分 → some，只数这一组的', () => {
    const s = groupPickState(rows, new Set(['a', 'x']));
    assert.equal(s.state, 'some');
    assert.deepEqual(s.pickedIds, ['a']);
  });
  test('能选的全勾了 → all（busy 行不算）', () => {
    assert.equal(groupPickState(rows, new Set(['a', 'b'])).state, 'all');
  });
  test('busy 行就算在 picked 里也不算勾选', () => {
    const s = groupPickState(rows, new Set(['c']));
    assert.equal(s.state, 'none');
    assert.deepEqual(s.pickedIds, []);
  });
  test('整组都是 busy → none', () => {
    assert.equal(groupPickState([{ id: 'c', busy: true }], new Set()).state, 'none');
  });
});

describe('toggleGroupPick', () => {
  test('没全选时 → 选中这一组所有非 busy 行，不动别组的勾', () => {
    const next = toggleGroupPick(new Set(['x', 'a']), rows);
    assert.deepEqual([...next].sort(), ['a', 'b', 'x']);
  });
  test('已全选 → 取消这一组的勾，别组的留着', () => {
    const next = toggleGroupPick(new Set(['x', 'a', 'b']), rows);
    assert.deepEqual([...next], ['x']);
  });
  test('不改传进来的 Set', () => {
    const prev = new Set(['x']);
    toggleGroupPick(prev, rows);
    assert.deepEqual([...prev], ['x']);
  });
});

describe('BackupDialog 恢复页组头', () => {
  const UI = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupDialog.tsx'), 'utf8');
  const restorePart = UI.slice(UI.indexOf("{tab === 'restore' && ("));
  test('不再有一键删整个项目的入口', () => {
    assert.doesNotMatch(UI, /deleteProject\(/);
    assert.doesNotMatch(UI, /s3DeleteProject/);
  });
  test('组头有全选框（含半选），删除只传这一组勾选的 id，两次点击确认', () => {
    assert.match(restorePart, /toggleGroupPick\(prev, rows\)/);
    assert.match(restorePart, /\.indeterminate = /);
    assert.match(UI, /deleteS3Sessions\?\.\(ids\)/);
    /* 文案进了字典（i18nZh/settingsPanels.ts），源码里是 t('英文', { n }) */
    assert.match(restorePart, /t\('Confirm deleting \{n\} backups', \{ n: gp\.pickedIds\.length \}\)/);
    assert.match(restorePart, /t\('Delete \{n\} selected', \{ n: gp\.pickedIds\.length \}\)/);
    const ZHP = fs.readFileSync(path.join(process.cwd(), 'src/renderer/i18nZh/settingsPanels.ts'), 'utf8');
    assert.match(ZHP, /'Confirm deleting \{n\} backups': '确认删除 \{n\} 条备份'/);
    assert.match(ZHP, /'Delete \{n\} selected': '删除选中的 \{n\} 条'/);
  });
});

describe('桶里没有文件的行（missing）', () => {
  const rows2 = [{ id: 'a' }, { id: 'b', missing: true }, { id: 'c', busy: true }];
  test('不算能选的：全选跳过它，只勾 a 就是全选', () => {
    assert.equal(groupPickState(rows2, new Set(['a'])).state, 'all');
    assert.deepEqual([...toggleGroupPick(new Set(), rows2)], ['a']);
  });
  test('就算在 picked 里也不算勾选', () => {
    assert.deepEqual(groupPickState(rows2, new Set(['b'])).pickedIds, []);
  });
});
