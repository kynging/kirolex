/**
 * **自动改用备用模型的提示：进对话记录、说实际用的那个、整件事成了才写、同一对只记一次**（`src/main/modelFallbackNote.ts`）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ModelFallbackNotes, fallbackGroup } from '../src/main/modelFallbackNote.ts';

function harness(records = new Set<string>(['s1'])) {
  const notes: Array<{ sid: string; text: string; group: string }> = [];
  const status: Array<{ sid: string; text: string; group: string }> = [];
  const writable = new Set<string>(records);
  const m = new ModelFallbackNotes({
    note: (sid, text, group) => { if (!writable.has(sid)) return false; notes.push({ sid, text, group }); return true; },
    recordExists: (sid) => records.has(sid),
    status: (sid, text, group) => { status.push({ sid, text, group }); },
    remoteText: (host, wanted, used) => `${host} 上没有 ${wanted}，改用 ${used}`,
  });
  return { m, notes, status, records, writable };
}

describe('整件事成了才写（连上执行器之后还有 session/new、换执行器、写记录）', () => {
  test('connect 成功但 session/new 失败 → discard，不留"已改用"；随后真正成功 → commit 正常写', () => {
    const h = harness();
    h.m.remotePicked('s1', 'claude-opus-5', 'box', ['gpt-5.6-sol']);
    h.m.remoteStarted('s1', 'gpt-5.6-sol');        // 换机器：client.connect() 成功
    assert.equal(h.notes.length, 0, '连上时只是记下，不写');
    h.m.discard('s1');                              // client.newSession() 失败 → catch
    h.m.commit('s1');
    assert.equal(h.notes.length, 0, '失败了就不留成功提示');
    /* 用户再试一次，这次整件事都成了 */
    h.m.remotePicked('s1', 'claude-opus-5', 'box', ['gpt-5.6-sol']);
    h.m.remoteStarted('s1', 'gpt-5.6-sol');
    h.m.commit('s1');
    assert.equal(h.notes.length, 1, '失败那次没有登记去重，这次照常写');
    assert.match(h.notes[0].text, /改用 gpt-5\.6-sol/);
  });

  test('本机那条路一样：note 只是记下，commit 才写，discard 作废', () => {
    const h = harness();
    h.m.note('s1', 'claude-opus-5', 'gpt-5.6-sol', 'A');
    assert.equal(h.notes.length, 0);
    h.m.discard('s1');
    h.m.commit('s1');
    assert.equal(h.notes.length, 0);
    h.m.note('s1', 'claude-opus-5', 'gpt-5.6-sol', 'A');
    h.m.commit('s1');
    assert.equal(h.notes.length, 1);
  });
});

describe('远端：按连上之后实际起来的模型说', () => {
  test('挑的备用模型起不来、换成了另一个 → 记录里写的是真正起来的那个', () => {
    const h = harness();
    h.m.remotePicked('s1', 'claude-opus-5', 'box', ['gpt-5.6-sol', 'gpt-5.6-terra']);   // pickRemoteModel 挑了 gpt-5.6-sol
    h.m.remoteStarted('s1', 'gpt-5.6-terra');                                           // sol 没起来，terra 起来了
    h.m.commit('s1');
    assert.equal(h.notes.length, 1);
    assert.match(h.notes[0].text, /改用 gpt-5\.6-terra/);
    assert.doesNotMatch(h.notes[0].text, /gpt-5\.6-sol/);
    assert.equal(h.notes[0].group, fallbackGroup('claude-opus-5', 'gpt-5.6-terra'));
  });

  test('一个都没起来 → 什么都不写；下一次连上照常说（没有被提前登记挡住）', () => {
    const h = harness();
    h.m.remotePicked('s1', 'claude-opus-5', 'box', ['gpt-5.6-sol']);
    h.m.remoteFailed('s1');
    h.m.remoteStarted('s1', 'gpt-5.6-sol');
    h.m.commit('s1');
    assert.equal(h.notes.length, 0, '失败之后挑的那条已经作废');
    h.m.remotePicked('s1', 'claude-opus-5', 'box', ['gpt-5.6-sol']);
    h.m.remoteStarted('s1', 'gpt-5.6-sol');
    h.m.commit('s1');
    assert.equal(h.notes.length, 1);
  });

  test('没挑过备用模型（远端有你选的那个）→ 连上也不说', () => {
    const h = harness();
    h.m.remoteStarted('s1', 'claude-opus-5');
    h.m.commit('s1');
    assert.equal(h.notes.length, 0);
  });
});

describe('同一对只记一次', () => {
  test('每次重连都走一遍：同一对「想要→实际」只写一条；结果变了再写', () => {
    const h = harness();
    for (let i = 0; i < 3; i++) { h.m.note('s1', 'claude-opus-5', 'gpt-5.6-sol', 'A'); h.m.commit('s1'); }
    assert.equal(h.notes.length, 1);
    h.m.note('s1', 'claude-opus-5', 'gpt-5.6-terra', 'B');
    h.m.commit('s1');
    assert.equal(h.notes.length, 2);
  });

  test('中间用回了你选的那个，之后再换要重新说', () => {
    const h = harness();
    h.m.note('s1', 'claude-opus-5', 'gpt-5.6-sol', 'A'); h.m.commit('s1');
    h.m.wantedInUse('s1');
    h.m.note('s1', 'claude-opus-5', 'gpt-5.6-sol', 'A'); h.m.commit('s1');
    assert.equal(h.notes.length, 2);
  });
});

describe('新建会话：连接比记录先到', () => {
  test('连接时只记下；createSession + writeRecord 之后 commit 写一次；之后的重连不再重复', () => {
    const h = harness(new Set());
    h.m.note('new1', 'claude-opus-5', 'gpt-5.6-sol', '本机没有 claude-opus-5，改用 gpt-5.6-sol');
    assert.equal(h.notes.length + h.status.length, 0);
    h.records.add('new1'); h.writable.add('new1');                 // store.createSession / writeRecord 之后
    h.m.commit('new1');
    assert.deepEqual(h.notes.map((n) => [n.sid, n.text]), [['new1', '本机没有 claude-opus-5，改用 gpt-5.6-sol']]);
    h.m.note('new1', 'claude-opus-5', 'gpt-5.6-sol', '本机没有 claude-opus-5，改用 gpt-5.6-sol');   // 之后的重连
    h.m.commit('new1');
    assert.equal(h.notes.length, 1, '写过就算记过了');
  });

  test('新建途中失败（session/new 起不来）→ discard，什么都不留', () => {
    const h = harness(new Set());
    h.m.remotePicked('new2', 'claude-opus-5', 'box', ['gpt-5.6-sol']);
    h.m.remoteStarted('new2', 'gpt-5.6-sol');
    h.m.discard('new2');
    h.records.add('new2'); h.writable.add('new2');
    h.m.commit('new2');
    assert.equal(h.notes.length + h.status.length, 0);
  });

  test('记录在、但写不进（advanced 会话等）→ 只在状态行说', () => {
    const h = harness(new Set(['adv']));
    h.writable.delete('adv');
    h.m.note('adv', 'claude-opus-5', 'gpt-5.6-sol', 'A');
    h.m.commit('adv');
    assert.equal(h.notes.length, 0);
    assert.equal(h.status.length, 1);
  });
});
