import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

/*
  「备份恢复界面，上方应该不再显示删除按钮，仅显示恢复按钮」。
  顶部 backup-actions 只留刷新 / 恢复选中的；删备份只在每个项目组头（backup-del）做。
*/
const UI = fs.readFileSync(new URL('../src/renderer/components/BackupDialog.tsx', import.meta.url), 'utf8');
const ZHP = fs.readFileSync(new URL('../src/renderer/i18nZh/settingsPanels.ts', import.meta.url), 'utf8');
const restorePart = UI.slice(UI.indexOf("{tab === 'restore' && ("));
const topStart = restorePart.indexOf('<div className="backup-actions">');
const topBar = restorePart.slice(topStart, restorePart.indexOf('</div>', topStart));

test('恢复页顶部一排：有刷新和恢复，没有删除', () => {
  assert.ok(topStart >= 0);
  assert.match(topBar, /void loadBackups\(\)/);
  assert.match(topBar, /void restore\(\)/);
  assert.match(topBar, /Put back into original project/);
  assert.match(topBar, /t\('\{n\} of them will be merged with the local copy'/);
  assert.doesNotMatch(topBar, /Delete|delete|removeBackups|armDelete|remote-btn-danger/);
});

test('顶部删除的状态和处理函数都去掉了', () => {
  assert.doesNotMatch(UI, /armDelete|setArmDelete|removeBackups|stillLocal/);
  assert.doesNotMatch(UI, /busy === 'delete'/);
});

test('组头的「删除备份」还在，仍走两次点击 + deleteBackups', () => {
  assert.match(restorePart, /className=\{`remote-btn backup-del/);
  assert.match(restorePart, /void removeGroupBackups\(key, gp\.pickedIds\)/);
  const at = UI.indexOf('const removeGroupBackups = async');
  const body = UI.slice(at, at + 400);
  assert.match(body, /if \(armGroup !== key\) \{ setArmGroup\(key\); return; \}/);
  assert.match(body, /await deleteBackups\(ids, `del:\$\{key\}`\)/);
  assert.match(UI, /const deleteBackups = async/);
});

test('只给顶部删除按钮用的词条清掉了，组头还用的留着', () => {
  for (const k of ["'Delete selected':", "'Only deletes the backups in the bucket; local copies are untouched':",
    "'{n} of them still exist locally; they are only backed up again if they change later':"]) {
    assert.equal(ZHP.includes(k), false, k);
  }
  for (const k of ["'Delete {n} selected':", "'Confirm deleting {n} backups':", "'Deleting…':"]) {
    assert.ok(ZHP.includes(k), k);
  }
});
