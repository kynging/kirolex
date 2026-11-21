import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { mergeRecords, vetRestoredRecord } from '../src/main/transcriptMerge.ts';

/*
 * 安全扫描：`s3:restore` 恢复一条**本机没有**的会话时，把桶里的 record.json 原样写盘 —— 没走 mergeRecords，
 * 也就没有「权限只许变严」那道关。桶的写入方能塞一份 engine:'kiro' + permissionMode:'auto-approve' 的记录，
 * 恢复之后 attach 照单全收，每次工具调用都静默放行。
 * 堵法：直接落盘的那份先过 vetRestoredRecord（明确的 auto-approve → ask）。测试数据全是造的。
 */

describe('vetRestoredRecord：直接从云上恢复的记录不能带着自动批准落盘', () => {
  test('kiro + auto-approve → ask，别的字段原样', () => {
    const rec = { id: 's_1', title: 't', updatedAt: 9000, profile: { engine: 'kiro', model: 'm2', permissionMode: 'auto-approve', kiroAgent: 'a' } };
    const out = vetRestoredRecord(rec);
    assert.equal(out.profile.permissionMode, 'ask');
    assert.deepEqual({ ...out, profile: { ...out.profile, permissionMode: 'auto-approve' } }, rec);
    assert.equal(rec.profile.permissionMode, 'auto-approve', '不改传进来的对象');
  });

  test('没写引擎（默认 kiro）+ auto-approve → ask', () => {
    assert.equal(vetRestoredRecord({ id: 's_1', profile: { permissionMode: 'auto-approve' } }).profile.permissionMode, 'ask');
  });

  test('别的引擎写着 auto-approve 也改成 ask（只会更严）', () => {
    for (const engine of ['claude', 'codex']) {
      assert.equal(vetRestoredRecord({ id: 's_1', profile: { engine, permissionMode: 'auto-approve' } }).profile.permissionMode, 'ask');
    }
  });

  test('已经是 ask / 没写权限 / 没有 profile → 原样返回', () => {
    const ask = { id: 's_1', profile: { engine: 'kiro', permissionMode: 'ask' } };
    assert.equal(vetRestoredRecord(ask), ask);
    const none = { id: 's_1', profile: { engine: 'kiro' } };
    assert.equal(vetRestoredRecord(none), none);
    const bare = { id: 's_1' };
    assert.equal(vetRestoredRecord(bare), bare);
    assert.equal(vetRestoredRecord(undefined), undefined);
  });

  test('mergeRecords 本机那份读不出来（等于直接落云上那份）→ 同样改成 ask', () => {
    const theirs = { id: 's_1', updatedAt: 9000, profile: { engine: 'kiro', permissionMode: 'auto-approve' } };
    assert.equal(mergeRecords(undefined, theirs).profile.permissionMode, 'ask');
    assert.equal(mergeRecords(null, theirs).profile.permissionMode, 'ask');
  });

  test('s3:restore 的「本机没有」那条路写记录前先过 vetRestoredRecord', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
    const start = src.indexOf("if (existed && base === 'history.md') continue;");
    assert.ok(start > 0, '找不到 s3:restore 的恢复循环');
    const slice = src.slice(start, src.indexOf('restored += 1;', start));
    assert.match(slice, /store\.writeRecordKeepUpdatedAt\(\{ \.\.\.vetRestoredRecord\(rec\), id: sessionId \}\)/);
    assert.doesNotMatch(slice, /writeRecordKeepUpdatedAt\(\{ \.\.\.rec, id: sessionId \}\)/);
  });
});
