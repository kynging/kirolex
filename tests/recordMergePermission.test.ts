import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mergeRecords } from '../src/main/transcriptMerge.ts';

/*
 * 安全：云上那份记录不可信（别的电脑 / 桶凭据都可能被人拿到）。mergeRecords 按 updatedAt 让对方的 profile 赢，
 * 原来一份 updatedAt 更新、engine:'kiro'、permissionMode:'auto-approve' 的记录就能把本机设成「手动确认」的会话
 * 悄悄改回自动批准，之后每次工具调用都不再问。合并只许让权限更严，不许放宽。测试数据全是造的。
 */

describe('mergeRecords：云上记录不能把权限放宽成自动批准', () => {
  test('本机 kiro + ask，对方更新且是 auto-approve → 合并后仍是 ask', () => {
    const local = { id: 's_1', updatedAt: 1000, profile: { engine: 'kiro', model: 'm1', permissionMode: 'ask' } };
    const theirs = { id: 's_1', updatedAt: 9000, profile: { engine: 'kiro', model: 'm2', permissionMode: 'auto-approve' } };
    const m = mergeRecords(local, theirs);
    assert.equal(m.profile.permissionMode, 'ask');
    assert.equal(m.profile.model, 'm2', '模型照旧按 updatedAt');
  });

  test('本机 kiro + ask，对方更新且没写 permissionMode（默认即自动批准）→ 合并后是 ask', () => {
    const local = { id: 's_1', updatedAt: 1000, profile: { permissionMode: 'ask' } };
    const theirs = { id: 's_1', updatedAt: 9000, profile: { model: 'm2' } };
    assert.equal(mergeRecords(local, theirs).profile.permissionMode, 'ask');
  });

  test('本机是 claude（始终要确认），对方更新把引擎换成 kiro + auto-approve → 引擎照旧跟对方，权限变 ask', () => {
    const local = { id: 's_1', updatedAt: 1000, profile: { engine: 'claude', permissionMode: 'auto-approve' } };
    const theirs = { id: 's_1', updatedAt: 9000, profile: { engine: 'kiro', permissionMode: 'auto-approve' } };
    const m = mergeRecords(local, theirs);
    assert.equal(m.profile.engine, 'kiro');
    assert.equal(m.profile.permissionMode, 'ask');
  });

  test('本机本来就是自动批准 → 不受影响', () => {
    const local = { id: 's_1', updatedAt: 1000, profile: { permissionMode: 'auto-approve' } };
    const theirs = { id: 's_1', updatedAt: 9000, profile: { permissionMode: 'auto-approve', model: 'x' } };
    assert.equal(mergeRecords(local, theirs).profile.permissionMode, 'auto-approve');
  });

  test('对方更新改成 ask（更严）→ 照旧跟对方', () => {
    const local = { id: 's_1', updatedAt: 1000, profile: { permissionMode: 'auto-approve' } };
    const theirs = { id: 's_1', updatedAt: 9000, profile: { permissionMode: 'ask' } };
    assert.equal(mergeRecords(local, theirs).profile.permissionMode, 'ask');
  });

  test('本机更新（本机赢）也保持本机的 ask', () => {
    const local = { id: 's_1', updatedAt: 9000, profile: { permissionMode: 'ask' } };
    const theirs = { id: 's_1', updatedAt: 1000, profile: { permissionMode: 'auto-approve' } };
    assert.equal(mergeRecords(local, theirs).profile.permissionMode, 'ask');
  });
});
