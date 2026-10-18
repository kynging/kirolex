import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asSteerParts, splitFoldedSteers, userTurnBubbles, toStoredUserLines } from '../src/renderer/steerSplit.ts';

/**
 * 追加指令（steer）显示成和原消息相邻、但各自独立的气泡。
 *
 * 记账不变：内存里 steer 仍是带 `steer` 标记的独立消息、同属这一轮；盘上 steer 是
 * `mergeIntoMessageId` 事件，readTranscript 折叠进原消息。这里钉的是"怎么拆回去显示"。
 */
const read = (rel: string): string => fs.readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8');

const base = { id: 'u1', role: 'user' as const, content: '原问题', timestamp: 1000 };
const s1 = { id: 's1', role: 'user' as const, content: '第一条追加', timestamp: 2000, steer: 'consumed' as const };
const s2 = { id: 's2', role: 'user' as const, content: '第二条追加', timestamp: 3000, steer: 'pending' as const };

describe('userTurnBubbles: one bubble per message, in order, each with its own time', () => {
  test('original + two in-memory steers -> three bubbles', () => {
    const out = userTurnBubbles(base, [s1, s2]);
    assert.deepEqual(out.map((b) => [b.id, b.text, b.timestamp, b.isSteer]), [
      ['u1', '原问题', 1000, false],
      ['s1', '第一条追加', 2000, true],
      ['s2', '第二条追加', 3000, true],
    ]);
  });

  test('blank steers are skipped, the original is always kept', () => {
    const out = userTurnBubbles(base, [{ ...s1, content: '   ' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'u1');
  });

  test('each bubble keeps only its own attachments', () => {
    const a = { id: 'a', name: 'a.png', path: '/a.png', isImage: true };
    const b = { id: 'b', name: 'b.txt', path: '/b.txt' };
    const out = userTurnBubbles({ ...base, attachments: [a] }, [{ ...s1, attachments: [b] }]);
    assert.deepEqual(out.map((x) => (x.attachments || []).map((f) => f.id)), [['a'], ['b']]);
  });

  test('restored from disk: folded content splits back by the recorded boundaries', () => {
    // A multi-line original stays one bubble: the boundary comes from the record, not from "\n".
    const folded = {
      ...base,
      content: '原问题\n第二行\n第一条追加',
      steerParts: [{ id: 's1', content: '第一条追加', ts: 2000 }],
    };
    const out = userTurnBubbles(folded, []);
    assert.deepEqual(out.map((b) => [b.id, b.text, b.timestamp, b.isSteer]), [
      ['u1', '原问题\n第二行', 1000, false],
      ['s1', '第一条追加', 2000, true],
    ]);
  });

  test('old data without boundaries stays one bubble, no throw', () => {
    const out = userTurnBubbles({ ...base, content: '原问题\n第一条追加' }, []);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, '原问题\n第一条追加');
  });

  test('boundaries that no longer match the content are ignored (one bubble)', () => {
    const out = userTurnBubbles({ ...base, content: '被改过的', steerParts: [{ id: 's1', content: '第一条追加', ts: 2000 }] }, []);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, '被改过的');
  });
});

describe('splitFoldedSteers / asSteerParts tolerate junk', () => {
  test('garbage parts -> undefined', () => {
    assert.equal(asSteerParts(undefined), undefined);
    assert.equal(asSteerParts('x'), undefined);
    assert.equal(asSteerParts([{ nope: 1 }]), undefined);
    assert.equal(asSteerParts([]), undefined);
  });
  test('no parts -> null', () => {
    assert.equal(splitFoldedSteers('abc', undefined), null);
  });
  test('valid -> base and parts', () => {
    assert.deepEqual(splitFoldedSteers('a\nb\nc', [{ id: '1', content: 'b', ts: 1 }, { id: '2', content: 'c', ts: 2 }]),
      { base: 'a', parts: [{ id: '1', content: 'b', ts: 1 }, { id: '2', content: 'c', ts: 2 }] });
  });
});

describe('toStoredUserLines: a rewrite keeps the steer boundaries on disk in the existing format', () => {
  test('restored folded message -> original line + mergeIntoMessageId events', () => {
    const lines = toStoredUserLines({
      id: 'u1', role: 'user', content: '原问题\n第一条追加', ts: 1000,
      steerParts: [{ id: 's1', content: '第一条追加', ts: 2000 }],
    });
    assert.deepEqual(lines, [
      { id: 'u1', role: 'user', content: '原问题', ts: 1000 },
      { id: 's1', role: 'user', content: '第一条追加', ts: 2000, mergeIntoMessageId: 'u1' },
    ]);
  });
  test('message without boundaries passes through untouched', () => {
    const m = { id: 'u1', role: 'user', content: 'x', ts: 1 };
    assert.deepEqual(toStoredUserLines(m), [m]);
  });
});

describe('sessionStore.readTranscript records where each folded steer starts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-steer-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const store = await import('../src/main/sessionStore.ts');

  test('folded content unchanged, boundaries recorded, round trip via rewrite keeps them', () => {
    const sid = 's_steer_split';
    store.appendMessage(sid, { id: 'u1', role: 'user', content: '原问题', ts: 1000 });
    store.appendMessage(sid, { id: 's1', role: 'user', content: '第一条追加', ts: 2000, mergeIntoMessageId: 'u1' });
    store.appendMessage(sid, { id: 's2', role: 'user', content: '第二条追加', ts: 3000, mergeIntoMessageId: 'u1' });
    store.appendMessage(sid, { id: 'a1', role: 'assistant', content: '回复', ts: 4000 });
    const t = store.readTranscript(sid) as any[];
    assert.equal(t.length, 2);
    // Everything that reads content (history.md, search, export) sees exactly what it saw before.
    assert.equal(t[0].content, '原问题\n第一条追加\n第二条追加');
    assert.deepEqual(t[0].steerParts, [
      { id: 's1', content: '第一条追加', ts: 2000 },
      { id: 's2', content: '第二条追加', ts: 3000 },
    ]);
    const bubbles = userTurnBubbles({ ...t[0], timestamp: t[0].ts }, []);
    assert.deepEqual(bubbles.map((b) => b.text), ['原问题', '第一条追加', '第二条追加']);

    store.rewriteTranscript(sid, t.flatMap((m) => toStoredUserLines(m)) as any);
    const again = store.readTranscript(sid) as any[];
    assert.equal(again[0].content, '原问题\n第一条追加\n第二条追加');
    assert.deepEqual(again[0].steerParts.map((p: any) => p.id), ['s1', 's2']);
  });
});

describe('ChatArea wiring', () => {
  const src = read('src/renderer/components/ChatArea.tsx');
  const item = src.slice(src.indexOf('const UserGroupItem = memo'), src.indexOf("UserGroupItem.displayName"));

  test('split mode renders one .message.user per bubble with its own time and copy', () => {
    assert.match(item, /userTurnBubbles\(base, steers\)/);
    assert.match(item, /bubbles\.map\(/);
    assert.match(item, /className="steer-tag"/);
    assert.match(item, /renderTime\(bubble\.timestamp\)/);
    assert.match(item, /renderCopy\(bubble\.id, bubble\.text\)/);
  });

  test('the interrupted turn still renders as ONE bubble', () => {
    assert.match(item, /if \(!merged && !editing\)/);
    assert.match(item, /paragraphs\.map\(\(paragraph, index\) => renderParagraph\(/);
    assert.match(src, /merged=\{!!turnInterrupted && group\.base\.id === interruptedBaseId\}/);
  });

  test('every transcript -> Message conversion carries the steer boundaries', () => {
    const hook = read('src/renderer/hooks/useAcp.ts');
    const conv = read('src/renderer/connectFailure.ts');
    const sites = (hook.match(/timestamp: m\.ts,/g) || []).length;
    const carried = (hook.match(/\.\.\.\(asSteerParts\(/g) || []).length;
    assert.equal(carried, sites);
    assert.match(conv, /asSteerParts\(m\.steerParts\)/);
    assert.match(hook, /toStoredUserLines/);
  });
});

describe('zh: no steer text is called 引导 any more', () => {
  test('dictionaries', () => {
    for (const f of ['src/renderer/i18n.ts', 'src/renderer/i18nZh/chat.ts', 'src/renderer/i18nZh/shell.ts', 'src/main/uiTextZh/modulesB.ts']) {
      assert.doesNotMatch(read(f), /引导/, f);
    }
    assert.match(read('src/renderer/i18n.ts'), /'Steer': '追加指令'/);
    assert.match(read('src/renderer/i18nZh/chat.ts'), /"Steered into the running turn": "已追加到正在进行的这一轮"/);
  });
});
