import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleOwnerGate } from '../src/main/schedule.ts';

/*
  定时任务（尤其带 `checkCommand` 的目标型任务）跑之前先看它属于的会话：会话删了 → 删掉任务、什么都不跑；
  记录找不到 / 已归档 → 这一次不跑（不删，记录可能还会回来 / 取消归档）。只有正常存在的会话才照常跑。
*/
describe('a schedule never runs its check command for a session that is gone', () => {
  test('deleted session → remove the schedule', () => {
    assert.equal(scheduleOwnerGate({ deleted: true, exists: true, archived: false }), 'remove');
    assert.equal(scheduleOwnerGate({ deleted: true, exists: false, archived: false }), 'remove');
  });
  test('missing record → skip (do not run)', () => {
    assert.equal(scheduleOwnerGate({ deleted: false, exists: false, archived: false }), 'skip');
  });
  test('archived session → skip (do not run)', () => {
    assert.equal(scheduleOwnerGate({ deleted: false, exists: true, archived: true }), 'skip');
  });
  test('live session → run', () => {
    assert.equal(scheduleOwnerGate({ deleted: false, exists: true, archived: false }), 'run');
  });
});
