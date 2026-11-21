/**
 * 单条会话要不要备份（syncChoice.ts 的 shouldSyncSession）——「项目不开备份时，会话也能单独打开」。
 *
 * 规则「单条优先于项目」：includeSessions 命中 → 同步；excludeSessions 命中 → 不同步；否则看项目。
 * 两个列表里都有时，以最后一次操作为准（setSessionSync 会把它从另一张表里删掉）。
 * advanced 专属的会话一律不传，单独打开也不行。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shouldSyncSession, setSessionSync } from '../src/main/syncChoice.ts';

describe('shouldSyncSession：单条优先于项目', () => {
  test('项目开、单条没设 → 同步', () => {
    assert.equal(shouldSyncSession({ excludeProjects: [] }, 's', 'P'), true);
  });
  test('项目开、单条关 → 不同步', () => {
    assert.equal(shouldSyncSession({ excludeSessions: ['s'] }, 's', 'P'), false);
  });
  test('项目关、单条没设 → 不同步', () => {
    assert.equal(shouldSyncSession({ excludeProjects: ['P'] }, 's', 'P'), false);
  });
  test('项目关、单条开 → 同步', () => {
    assert.equal(shouldSyncSession({ excludeProjects: ['P'], includeSessions: ['s'] }, 's', 'P'), true);
  });
  test('未分组（空串）也按项目算', () => {
    assert.equal(shouldSyncSession({ excludeProjects: [''] }, 's', ''), false);
    assert.equal(shouldSyncSession({ excludeProjects: [''], includeSessions: ['s'] }, 's', ''), true);
  });
  test('两个列表都有 → includeSessions 优先（正常操作不会留下这种状态）', () => {
    assert.equal(shouldSyncSession({ excludeSessions: ['s'], includeSessions: ['s'] }, 's', 'P'), true);
  });
  test('advanced 专属的会话：单独打开也不传', () => {
    assert.equal(shouldSyncSession({ includeSessions: ['s'] }, 's', 'P', { advancedOnly: true }), false);
    assert.equal(shouldSyncSession({}, 's', 'P', { advancedOnly: true }), false);
  });
  test('旧 config：没有 includeSessions、或者是 null → 和以前一样（项目关就不传，单条关就不传）', () => {
    for (const inc of [undefined, null]) {
      const cfg = { excludeProjects: ['P'], excludeSessions: ['x'], includeSessions: inc };
      assert.equal(shouldSyncSession(cfg, 's', 'P'), false);
      assert.equal(shouldSyncSession(cfg, 's', 'Q'), true);
      assert.equal(shouldSyncSession(cfg, 'x', 'Q'), false);
    }
  });
});

describe('setSessionSync：以最后一次操作为准', () => {
  test('开：从 excludeSessions 删、加进 includeSessions', () => {
    assert.deepEqual(setSessionSync({ excludeSessions: ['s', 'a'], includeSessions: null }, 's', true),
      { excludeSessions: ['a'], includeSessions: ['s'] });
  });
  test('关：从 includeSessions 删、加进 excludeSessions', () => {
    assert.deepEqual(setSessionSync({ excludeSessions: [], includeSessions: ['s', 'b'] }, 's', false),
      { excludeSessions: ['s'], includeSessions: ['b'] });
  });
  test('重复操作不重复加', () => {
    assert.deepEqual(setSessionSync({ includeSessions: ['s'] }, 's', true), { excludeSessions: [], includeSessions: ['s'] });
  });
  test('操作完马上按新的判', () => {
    const cfg = { excludeProjects: ['P'], excludeSessions: ['s'] };
    assert.equal(shouldSyncSession({ ...cfg, ...setSessionSync(cfg, 's', true) }, 's', 'P'), true);
    assert.equal(shouldSyncSession({ ...cfg, ...setSessionSync({ ...cfg, includeSessions: ['s'] }, 's', false) }, 's', 'Q'), false);
  });
});

describe('接线：要不要传都走 shouldSyncSession', () => {
  const MI = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const UI = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupDialog.tsx'), 'utf8');
  test('index.ts 里 projectExcluded / sessionExcluded 只剩定义和项目级（记忆、项目开关）的用法', () => {
    assert.doesNotMatch(MI, /sessionExcluded\(/, 'sessionExcluded 不该再有人用');
    /* projectExcluded 只能用在项目本身（项目开关、项目记忆），不能拿来判一条会话 */
    for (const line of MI.split('\n').filter((l) => /projectExcluded\(cfg\w*, projectOf\(/.test(l))) {
      assert.fail(`还在用项目开关判单条会话：${line.trim()}`);
    }
  });
  test('上传、catalog、位置 / 跨电脑跟随、自动清理、同步页列表都调 shouldSyncSession', () => {
    assert.match(MI, /const syncable = allSessions\.filter\(\(r\) => syncsSession\(cfg, r\)\)/);
    assert.match(MI, /function syncsSession\(cfg: SyncConfig, r: store\.SessionRecord\): boolean \{\n\s+return shouldSyncSession\(cfg, r\.id, projectOf\(r\), \{ advancedOnly: isAdvancedOnly\(r\) \}\);/);
    assert.match(MI, /notSynced: !syncsSession\(cfgNow, r\)/);
    assert.match(MI, /syncing: syncsSession\(cfg, rec\)/);
    assert.ok((MI.match(/if \(!syncsSession\(cfg, r\)\) continue;/g) || []).length >= 2, 'followBucketPlacements / followBucketCrossDevice');
  });
  test('catalog 用的就是 syncable 筛出来的那批', () => {
    assert.match(MI, /let freshEntries = catalogEntriesFor\(sessions, thisMachine\);/);
  });
  test('对话框按 shouldSyncSession 算每行的开关和计数，存的时候走 setSessionSync', () => {
    const BG = fs.readFileSync(path.join(process.cwd(), 'src/renderer/backupGroups.ts'), 'utf8');
    assert.match(BG, /on: shouldSyncSession\(lists, x\.id, x\.project\)/);
    assert.match(UI, /const st = syncRowState\(x, syncLists\);/);
    assert.match(UI, /syncSummary\(g\.sessions, syncLists\)/);
    assert.match(UI, /x\.state !== 'synced' && syncRowState\(x, syncLists\)\.on/);
    assert.match(UI, /setSessionSync\(/);
  });
});
