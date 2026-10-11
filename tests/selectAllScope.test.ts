import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isEditableEl, reviewSelectAll, coversWhole } from '../src/renderer/selectAllScope.ts';

/** 极简的假节点：只有 `contains`（按祖先链判断）和 tagName。 */
type FakeNode = { tagName?: string; isContentEditable?: boolean; parent?: FakeNode | null; contains: (n: unknown) => boolean };
const node = (parent: FakeNode | null = null, extra: Partial<FakeNode> = {}): FakeNode => {
  const self: FakeNode = {
    parent,
    ...extra,
    contains(n: unknown) {
      for (let p = n as FakeNode | null | undefined; p; p = p.parent) if (p === self) return true;
      return false;
    },
  };
  return self;
};

describe('isEditableEl：焦点在输入框里时 Ctrl+A 交给浏览器', () => {
  test('input / textarea / contenteditable 算可编辑', () => {
    assert.equal(isEditableEl({ tagName: 'INPUT' }), true);
    assert.equal(isEditableEl({ tagName: 'TEXTAREA' }), true);
    assert.equal(isEditableEl({ tagName: 'DIV', isContentEditable: true }), true);
  });
  test('普通元素、空值不算', () => {
    assert.equal(isEditableEl({ tagName: 'DIV' }), false);
    assert.equal(isEditableEl({ tagName: 'BUTTON' }), false);
    assert.equal(isEditableEl(null), false);
    assert.equal(isEditableEl(undefined), false);
  });
});

describe('reviewSelectAll：侧栏要不要接管这次 Ctrl+A', () => {
  const app = node();
  const panel = node(app);
  const pane = node(panel);
  const body = node(pane);
  const chat = node(app);
  const textarea = node(pane, { tagName: 'TEXTAREA' });

  test('最后一次点在侧栏正文里：选文件内容', () => {
    assert.equal(reviewSelectAll({ zone: panel, last: body, active: null, deck: false }), 'select');
  });
  test('点在侧栏的标签 / 工具栏（侧栏里、正文外）也算侧栏', () => {
    assert.equal(reviewSelectAll({ zone: panel, last: node(panel), active: null, deck: false }), 'select');
  });
  test('最后一次点在聊天区：不管，聊天区照旧', () => {
    assert.equal(reviewSelectAll({ zone: panel, last: chat, active: null, deck: false }), 'ignore');
  });
  test('从来没点过：不管', () => {
    assert.equal(reviewSelectAll({ zone: panel, last: null, active: null, deck: false }), 'ignore');
  });
  test('焦点在侧栏的输入框里：交给浏览器只全选那个框', () => {
    assert.equal(reviewSelectAll({ zone: panel, last: textarea, active: textarea, deck: false }), 'ignore');
  });
  test('焦点在聊天输入框里，哪怕之前点过侧栏也不管', () => {
    const input = node(chat, { tagName: 'TEXTAREA' });
    assert.equal(reviewSelectAll({ zone: panel, last: body, active: input, deck: false }), 'ignore');
  });
  test('deck 逐页预览没有文字层：吞掉这次按键，什么也不选（不去选聊天记录）', () => {
    assert.equal(reviewSelectAll({ zone: panel, last: body, active: null, deck: true }), 'swallow');
  });
  test('没有侧栏根节点：不管', () => {
    assert.equal(reviewSelectAll({ zone: null, last: body, active: null, deck: false }), 'ignore');
  });
});

describe('coversWhole：当前选区是不是「侧栏里的 Ctrl+A 全选」', () => {
  const ol = { childNodes: { length: 3 } };
  test('从正文头到正文尾：是', () => {
    assert.equal(coversWhole({ startContainer: ol, startOffset: 0, endContainer: ol, endOffset: 3 }, ol), true);
  });
  test('只划了一段：不是', () => {
    assert.equal(coversWhole({ startContainer: ol, startOffset: 1, endContainer: ol, endOffset: 3 }, ol), false);
    assert.equal(coversWhole({ startContainer: {}, startOffset: 0, endContainer: ol, endOffset: 3 }, ol), false);
  });
  test('全选之后正文又多了几块（重渲染）：不再当成全选', () => {
    assert.equal(coversWhole({ startContainer: ol, startOffset: 0, endContainer: ol, endOffset: 2 }, ol), false);
  });
  test('没有选区 / 没有正文：不是', () => {
    assert.equal(coversWhole(null, ol), false);
    assert.equal(coversWhole({ startContainer: ol, startOffset: 0, endContainer: ol, endOffset: 3 }, null), false);
  });
});
