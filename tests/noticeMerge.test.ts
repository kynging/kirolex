import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collapseAdjacent, mergeNotice, noticeKey, repeatBadge } from '../src/renderer/noticeMerge.ts';
import { withNoteDetail, splitNoteDetail, NOTE_DETAIL_SEP } from '../src/main/kirolexNote.ts';

describe('重复提示合并计数（聊天区：相邻的同一句 KiroLex 卡片）', () => {
  /* 和 ChatArea 的 renderGroups 同一个键：KiroLex 卡片按 noteGroup（没有就按整句），别的消息不参与 */
  const key = (m: { kirolex?: boolean; content: string; noteGroup?: string }) => (m.kirolex ? noticeKey({ group: m.noteGroup, text: m.content }) : null);

  test('连着三条一样的提示 → 一条，×3，保留最后那条（时间是最新的）', () => {
    const msgs = [
      { id: 'u1', content: '问题', kirolex: false },
      { id: 'n1', content: '⚠️ 本机工具连接中断', kirolex: true },
      { id: 'n2', content: '⚠️ 本机工具连接中断', kirolex: true },
      { id: 'n3', content: '⚠️ 本机工具连接中断', kirolex: true },
    ];
    const out = collapseAdjacent(msgs, key);
    assert.equal(out.length, 2);
    assert.equal(out[1].count, 3);
    assert.equal(out[1].item.id, 'n3');
    assert.equal(repeatBadge(out[1].count), '×3');
  });

  test('没带类型的旧提示：中间隔了别的消息、或者文字不同就不合并（不猜）', () => {
    const msgs = [
      { id: 'n1', content: '⏳ 重连（第 2 次）', kirolex: true },
      { id: 'n2', content: '⏳ 重连（第 3 次）', kirolex: true },
      { id: 'a1', content: '回答', kirolex: false },
      { id: 'n3', content: '⏳ 重连（第 3 次）', kirolex: true },
    ];
    const out = collapseAdjacent(msgs, key);
    assert.deepEqual(out.map((g) => [g.item.id, g.count]), [['n1', 1], ['n2', 1], ['a1', 1], ['n3', 1]]);
  });

  test('同类同对象：次数变了（第 2 次 → 第 3 次）照样合并，显示最新那条，×N 累计', () => {
    const msgs = [
      { id: 'n1', content: '⚠️ 本机工具连接中断，正在重连（第 1 次）', kirolex: true, noteGroup: 'local-tools-reconnect' },
      { id: 'n2', content: '⚠️ 本机工具连接中断，正在重连（第 2 次）', kirolex: true, noteGroup: 'local-tools-reconnect' },
      { id: 'n3', content: '⚠️ 本机工具连接中断，正在重连（第 3 次）', kirolex: true, noteGroup: 'local-tools-reconnect' },
    ];
    const out = collapseAdjacent(msgs, key);
    assert.equal(out.length, 1);
    assert.equal(out[0].count, 3);
    assert.match(out[0].item.content, /第 3 次/, '保留最新的内容');
  });

  test('同类同对象：只有「详情」变了（新的原因 / 新的后端会话 id）也合并，详情以最新为准', () => {
    const msgs = [
      { id: 'n1', content: withNoteDetail('🔀 已换到新的后端会话', '新的后端会话：aaaa1111…'), kirolex: true, noteGroup: 'backend-session-swap' },
      { id: 'n2', content: withNoteDetail('🔀 已换到新的后端会话', '新的后端会话：bbbb2222…'), kirolex: true, noteGroup: 'backend-session-swap' },
    ];
    const out = collapseAdjacent(msgs, key);
    assert.equal(out.length, 1);
    assert.equal(out[0].count, 2);
    assert.equal(splitNoteDetail(out[0].item.content).detail, '新的后端会话：bbbb2222…');
  });

  test('不同对象 / 不同结果分开显示（换到的模型不同、改写的是另一份文件）', () => {
    const msgs = [
      { id: 'n1', content: '⚠️ 改用 gpt-5.6-sol', kirolex: true, noteGroup: 'model-fallback:claude-opus-5→gpt-5.6-sol' },
      { id: 'n2', content: '⚠️ 改用 gpt-5.6-terra', kirolex: true, noteGroup: 'model-fallback:claude-opus-5→gpt-5.6-terra' },
      { id: 'n3', content: '⏳ 已排队：a.md', kirolex: true, noteGroup: 'revise-queued:a.md' },
      { id: 'n4', content: '⏳ 已排队：b.md', kirolex: true, noteGroup: 'revise-queued:b.md' },
    ];
    assert.equal(collapseAdjacent(msgs, key).length, 4);
  });

  test('你和 agent 的消息（key 为 null）哪怕一字不差也不合并', () => {
    const msgs = [
      { id: 'u1', content: '继续', kirolex: false },
      { id: 'u2', content: '继续', kirolex: false },
    ];
    assert.equal(collapseAdjacent(msgs, key).length, 2);
    assert.equal(repeatBadge(1), '');
  });
});

describe('重复提示合并计数（状态行：还挂着时又来同类的一句）', () => {
  test('同类（group 相同）、文字不同：显示新的这句，计数 +1', () => {
    const a = { text: '⚠️ 本机工具连接中断，正在重连（第 1 次）', group: 'local-tools-reconnect', ts: 1 };
    const b = mergeNotice(a, { text: '⚠️ 本机工具连接中断，正在重连（第 2 次）', group: 'local-tools-reconnect', ts: 2 });
    assert.equal(b.count, 2);
    assert.match(b.text, /第 2 次/);
  });

  test('group 不同（另一个对象 / 另一种结果）→ 换成新的，从 1 数', () => {
    const a = { text: '⏳ 已排队：a.md', group: 'revise-queued:a.md', ts: 1 };
    assert.equal(mergeNotice(a, { text: '⏳ 已排队：b.md', group: 'revise-queued:b.md', ts: 2 }).count, undefined);
  });

  test('同一句再来 → 计数 +1，其余字段用新的', () => {
    const a = { text: '⚠️ 本机工具连接中断', ts: 1 };
    const b = mergeNotice(a as any, { text: '⚠️ 本机工具连接中断', ts: 2 });
    assert.equal(b.count, 2);
    assert.equal(b.ts, 2);
    const c = mergeNotice(b, { text: '⚠️ 本机工具连接中断', ts: 3 });
    assert.equal(c.count, 3);
  });

  test('换了一句 / 上一句已经淡出（prev 为 null）→ 从 1 重新数', () => {
    const a = { text: 'A', ts: 1, count: 4 };
    assert.equal(mergeNotice(a, { text: 'B', ts: 2 }).count, undefined);
    assert.equal(mergeNotice(null, { text: 'A', ts: 3 }).count, undefined);
  });
});

describe('提示的「详情」折叠', () => {
  test('主句和详情拼起来再拆开，原样回来', () => {
    const s = withNoteDetail('🔀 已换模型并重发', '连续 3 次空响应；pid 1234');
    assert.ok(s.includes(NOTE_DETAIL_SEP));
    assert.deepEqual(splitNoteDetail(s), { main: '🔀 已换模型并重发', detail: '连续 3 次空响应；pid 1234' });
  });

  test('没有详情就只有主句；旧提示（没有分隔符）整句都是主句', () => {
    assert.equal(withNoteDetail('✅ 完成', ''), '✅ 完成');
    assert.deepEqual(splitNoteDetail('♻️ 后端连着 3 次拒绝……\n\n第二段'), { main: '♻️ 后端连着 3 次拒绝……\n\n第二段', detail: '' });
  });
});

describe('错误横幅不叠 emoji', () => {
  test('句子自己带了固定 emoji 就不再加；没有就补 ⚠️（不再用 ❌）', async () => {
    const { bannerText } = await import('../src/renderer/noticeMerge.ts');
    assert.equal(bannerText('⚠️ 这一轮没有任何输出。'), '⚠️ 这一轮没有任何输出。');
    assert.equal(bannerText('⏳ 当前这一轮还在跑'), '⏳ 当前这一轮还在跑');
    assert.equal(bannerText('连接失败'), '⚠️ 连接失败');
    assert.doesNotMatch(bannerText('连接失败'), /❌/);
  });
});

describe('写进对话记录的提示当场显示（不用等重新打开）', () => {
  test('插到那条会话末尾；同 id 不重复插', async () => {
    const { withLiveNote } = await import('../src/renderer/noticeMerge.ts');
    const cur = [{ id: 'u1' }, { id: 'a1' }];
    assert.deepEqual(withLiveNote(cur, { id: 'n1' })?.map((m) => m.id), ['u1', 'a1', 'n1']);
    assert.equal(withLiveNote([...cur, { id: 'n1' }], { id: 'n1' }), null);
  });
  test('还没读过历史的会话（空列表）不插 —— 否则历史看起来像没了', async () => {
    const { withLiveNote } = await import('../src/renderer/noticeMerge.ts');
    assert.equal(withLiveNote([], { id: 'n1' }), null);
  });
  test('这个窗口里正在新建的会话：本来就没有历史，空列表也插（新建时就改用了备用模型那句要当场看得见）', async () => {
    const { withLiveNote } = await import('../src/renderer/noticeMerge.ts');
    assert.deepEqual(withLiveNote([], { id: 'n1' }, true)?.map((m) => m.id), ['n1']);
  });
});
