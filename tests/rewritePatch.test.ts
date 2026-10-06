import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { rewritePatch } from '../src/renderer/rewritePatch.ts';
import { lineBlocks } from '../src/renderer/reviewBlocks.ts';

/**
 * 一次范围更大的重写 → 逐行补丁。从 feature/flow 的 `rewritePatch.test.ts` 搬过来，去掉了
 * 把补丁落到门的产出上那几条（`tableEdits.applyBlockChanges` 没有跟着搬）。侧栏 review 只用 `keep`，
 * 所以最后多了一组 `keep` 的测试 —— 那一组钉住的是搬过来时修掉的"空行把行号数错"。
 */

const DOC = [
  '## 项目进展',
  '',
  '### 1. A 项目',
  '- **TAG**: x',
  '- **本周**: 做了 A',
  '',
  '## 非项目事项',
  '',
  '- **[9/4] 一条内部会议** — 说明',
  '- **[本周] 另一条** — 说明',
].join('\n');
const blocks = lineBlocks(DOC).map((b) => ({ index: b.index, text: b.text }));

describe('对齐之后只落差异', () => {
  test('一个字没变 → 空补丁', () => {
    const p = rewritePatch(blocks, blocks.map((b) => b.text).join('\n'));
    assert.deepEqual(p.edits, {});
    assert.deepEqual(p.drops, {});
    assert.deepEqual(p.inserts, {});
  });

  test('只改一行 → 只有那一行进 `edits`', () => {
    const next = blocks.map((b) => (b.index === 5 ? '- **本周**: 做了 B' : b.text)).join('\n');
    const p = rewritePatch(blocks, next);
    assert.deepEqual(p.edits, { 5: '- **本周**: 做了 B' });
    assert.deepEqual(p.drops, {});
  });

  test('删一行 → `drops`，不是把后面的行往上错位', () => {
    const p = rewritePatch(blocks, blocks.filter((b) => b.index !== 10).map((b) => b.text).join('\n'));
    assert.deepEqual(p.drops, { 10: true });
    assert.deepEqual(p.edits, {});
  });

  test('搬一条到别的小节 —— 源行标删、多出来的各自成一块接在前一行后面', () => {
    const moved = [
      '## 项目进展', '', '### 1. A 项目', '- **TAG**: x', '- **本周**: 做了 A',
      '### 2. 百融 — AgentDLC workshop', '- **TAG**: GenAI',
      '', '## 非项目事项', '', '- **[本周] 另一条** — 说明',
    ].join('\n');
    const p = rewritePatch(blocks, moved);
    assert.deepEqual(p.edits, {}, '没变的那一行不写成 edit');
    assert.deepEqual(p.inserts, { 5: ['### 2. 百融 — AgentDLC workshop', '- **TAG**: GenAI'] });
    assert.deepEqual(Object.keys(p.drops), ['9']);
  });

  test('开头新增的行没有"前一行"可挂 —— 单独交出来，不要静默丢掉', () => {
    assert.equal(rewritePatch(blocks, ['# 新标题', ...blocks.map((b) => b.text)].join('\n')).prefix, '# 新标题');
  });

  test('只吃首尾空白 —— 行内差一个标点也算改过', () => {
    const next = blocks.map((b) => (b.index === 4 ? '  - **TAG**: x  ' : b.text)).join('\n');
    assert.deepEqual(rewritePatch(blocks, next).edits, {});
    const next2 = blocks.map((b) => (b.index === 4 ? '- **TAG**: x。' : b.text)).join('\n');
    assert.deepEqual(Object.keys(rewritePatch(blocks, next2).edits), ['4']);
  });

  test('一行换成多行 → 那一行标删，整段算新加的', () => {
    const next = blocks.map((b) => (b.index === 5 ? '### 新客户 A\n- **口径**: 全新' : b.text)).join('\n');
    const p = rewritePatch(blocks, next);
    assert.deepEqual(p.drops, { 5: true });
    assert.deepEqual(p.edits, {});
    assert.deepEqual(p.inserts, { 4: ['### 新客户 A', '- **口径**: 全新'] });
  });
});

describe('`keep`：剩下的意见跟着它们那一行走', () => {
  test('给的是**新文里真实的行号**（含空行）—— 和 `lineBlocks` 同一种数法', () => {
    /* 第 3 行前面插进两行（其中一行是空行）：第 3 行的内容现在在第 5 行 */
    const old = 'a\n\nb\nc';
    const next = 'a\n\nnew\n\nb\nc';
    const p = rewritePatch(lineBlocks(old).map((b) => ({ index: b.index, text: b.text })), next);
    assert.equal(p.keep[1], 1);
    assert.equal(p.keep[3], 5, '原来给的是"第 3 个非空行"——指到了 c 上');
    assert.equal(p.keep[4], 6);
    /* 拿新文自己切块验一遍：keep 指过去的那一行就是同一句话 */
    const nb = lineBlocks(next);
    assert.equal(nb.find((b) => b.index === p.keep[3])!.text, 'b');
  });

  test('被改掉 / 删掉的行不在 `keep` 里 —— 它评的东西已经不在了', () => {
    /* 新文从 DOC 原样改一行（空行都留着），不是拿块拼 —— 块里没有空行 */
    const p = rewritePatch(blocks, DOC.split('\n').map((l, i) => (i + 1 === 5 ? '改过的一行' : l)).join('\n'));
    assert.equal(p.keep[5], undefined);
    assert.equal(p.keep[4], 4);
    assert.equal(p.keep[10], 10, '空行照样占号，所以没挪的行行号不变');
  });
});
