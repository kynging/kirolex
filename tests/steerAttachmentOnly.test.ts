import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { userTurnBubbles } from '../src/renderer/steerSplit.ts';

/**
 * 只发附件、没写字的追加指令（忙时 Enter 现在允许带附件 steer）在聊天里不能消失。
 *
 * 审查发现：userTurnBubbles 只在有文字时保留 steer 气泡，于是 content:'' + 一张图的 steer 返回结果里只有原消息；
 * 普通显示的气泡、合并显示用的附件列表都来自这个结果 —— 附件从输入栏清掉之后，聊天里也看不到这次追加。
 */
const base = { id: 'u1', content: '原问题', timestamp: 1000 };
const img = { id: 'img1', name: 'error.png', path: '/tmp/error.png', isImage: true };
const onlyFile = { id: 's1', content: '', timestamp: 2000, attachments: [img] };

describe('只有附件的追加指令', () => {
  test('普通显示：单独一个追加气泡，带着它的附件、没有文字', () => {
    const out = userTurnBubbles(base, [onlyFile]);
    assert.deepEqual(out.map((b) => [b.id, b.text, b.isSteer]), [['u1', '原问题', false], ['s1', '', true]]);
    assert.deepEqual(out[1].attachments?.map((f) => f.id), ['img1']);
  });

  test('中断后的合并显示：附件列表（来自同一个结果）里有它', () => {
    const out = userTurnBubbles(base, [onlyFile]);
    // ChatArea 合并显示：attachments = bubbles.flatMap(b => b.attachments)，段落只取有文字的
    assert.deepEqual(out.flatMap((b) => b.attachments || []).map((f) => f.id), ['img1']);
    assert.deepEqual(out.filter((b) => b.text).map((b) => b.text), ['原问题']);
  });

  test('既没文字也没附件的还是不显示', () => {
    assert.equal(userTurnBubbles(base, [{ ...onlyFile, attachments: [] }]).length, 1);
    assert.equal(userTurnBubbles(base, [{ id: 's2', content: '  ', timestamp: 3000 }]).length, 1);
  });
});

describe('ChatArea：只有附件的追加气泡不画一个空的文字框', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf8');
  const item = src.slice(src.indexOf('const UserGroupItem = memo'), src.indexOf('UserGroupItem.displayName'));

  test('附件照画，文字框只在有文字（或是原消息）时画', () => {
    assert.match(item, /\{renderAttachments\(bubble\.attachments \|\| \[\]\)\}\s*\n\s*\{bubble\.text \|\| !bubble\.isSteer \? \(/);
  });

  test('合并显示的附件来自同一份 bubbles', () => {
    assert.match(item, /const attachments = useMemo\(\(\) => bubbles\.flatMap\(\(b\) => b\.attachments \|\| \[\]\), \[bubbles\]\);/);
  });
});
