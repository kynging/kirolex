import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/**
 * 「queue 的消息右边会跟一个修改字符，但这个实际上是不可点击的」。
 *
 * 它点得动，坏的是**长相**：22px、10px 字号、`--text-muted` 的灰、透明底、`border: none` ——
 * 和一句话末尾的一个字符没有区别。于是"能不能点"只能靠试，而试的成本是"我是不是把排队的消息弄坏了"。
 *
 * 排着的侧栏 comment 改写已经由 `ReviewQueueStack`（`reviewQueue.ts`）摆在同一处，这里不另起一份。
 */
describe('排队卡片上那几个动作要看得出是按钮', () => {
  const CHAT = read('src/renderer/components/ChatArea.tsx');
  const CSS = read('src/renderer/styles/global.css');
  const rule = (sel: string) => {
    const at = CSS.indexOf(sel);
    assert.ok(at > 0, `找不到 ${sel}`);
    return CSS.slice(at, CSS.indexOf('}', at) + 1);
  };

  test('有边框、有底色、够大 —— 不再和一个字符没区别', () => {
    const r = rule('.queue-card-actions button {');
    assert.match(r, /border: 1px solid/);
    assert.doesNotMatch(r, /border: none/);
    assert.match(r, /background: color-mix/);
    assert.match(r, /width: 24px/);
    assert.match(r, /cursor: pointer/);
    /* 间距也从 1px 放开 —— 误点相邻那个的代价是撤回一条消息 */
    assert.match(rule('.queue-card-actions {'), /gap: 3px/);
  });

  test('排队区每个按钮都写 `type="button"` —— `<button>` 默认是 submit', () => {
    const blocks: string[] = [];
    let at = CHAT.indexOf('className="queue-card-actions"');
    while (at > 0) {
      const end = CHAT.indexOf('</div>\n          </div>', at);
      assert.ok(end > at);
      blocks.push(CHAT.slice(at, end));
      at = CHAT.indexOf('className="queue-card-actions"', end);
    }
    /* 侧栏 comment 改写那一排 + 排队消息那一排 */
    assert.ok(blocks.length >= 2, `只找到 ${blocks.length} 处 queue-card-actions`);
    for (const block of blocks) {
      const buttons = (block.match(/<button/g) || []).length;
      const typed = (block.match(/type="button"/g) || []).length;
      assert.ok(buttons > 0);
      assert.equal(typed, buttons, `${buttons} 个按钮里只有 ${typed} 个写了 type`);
    }
  });

  test('提示词跟周围一致（中文），并说清点了会发生什么', () => {
    assert.match(CHAT, /title="改这条排队的消息"/);
    assert.match(CHAT, /title="撤回这条 —— 内容退回输入框"/);
    assert.match(CHAT, /title="往前排一位"/);
    assert.match(CHAT, /title="往后排一位"/);
    assert.match(CHAT, /title="保存这次修改"/);
    assert.match(CHAT, /title="放弃这次修改"/);
    for (const old of ['Edit queued message', 'Cancel and return to composer', 'Move earlier', 'Move later', 'Save edit', 'Cancel edit']) {
      assert.doesNotMatch(CHAT, new RegExp(`title="${old}"`));
    }
  });

  test('改的时候说清怎么收尾 —— 两个出口都是键盘', () => {
    assert.match(CHAT, /placeholder="改完按 Enter 保存，Esc 取消"/);
  });
});
