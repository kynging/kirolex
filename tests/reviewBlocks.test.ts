import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  lineBlocks, reviewPrompt, hasFeedback, dropSpan, headingLevel, displayGroups, mdLine, isRuleLine,
  spanRange, sliceLines, spliceLines,
} from '../src/renderer/reviewBlocks.ts';

/**
 * 侧栏文件预览逐行 comment 的块模型和提交契约 —— 从 feature/flow 的 `reviewBlocks.test.ts` 搬过来，
 * 去掉了 PPT/PDF 逐页（`pageBlocks`、备注那一路）和门那侧的接线断言（这条分支没有门）。
 */

describe('切块', () => {
  /**
   * 「你最好按行来加这些」+「title 和 subtitle 这些要和段落分开」——
   * 按行切之后第二条自动成立：标题本来就自己占一行，不需要再去认"这一行是不是标题"。
   */
  test('按行切，行号是文件里真实的行号', () => {
    const b = lineBlocks('# 标题\n\n正文一\n正文二');
    assert.deepEqual(b.map((x) => x.index), [1, 3, 4], '空行占号但不成块');
    assert.equal(b[0].kind, 'line');
    assert.equal(b[0].text, '# 标题');
  });

  test('空行不成块 —— 一份 Markdown 里空行能占三分之一，每个都挂 💬 是纯噪音', () => {
    assert.deepEqual(lineBlocks('a\n\n\nb').map((x) => x.index), [1, 4]);
    assert.deepEqual(lineBlocks('   \n\t\n').map((x) => x.index), []);
  });

  test('行号必须是真实行号，不是"第几个非空行" —— 否则你说第 12 行、模型数到的是另一行', () => {
    assert.deepEqual(lineBlocks('\n\n\n第四行').map((x) => x.index), [4]);
  });

  test('标题和它下面的正文是**两块** —— 这就是"分开"', () => {
    const b = lineBlocks('## 小标题\n紧跟的正文');
    assert.equal(b.length, 2);
    assert.equal(b[0].text, '## 小标题');
    assert.equal(b[1].text, '紧跟的正文');
  });

  test('空输入不炸', () => {
    assert.deepEqual(lineBlocks(undefined), []);
    assert.deepEqual(lineBlocks(null), []);
  });
});

describe('提交出去的那条提示词', () => {
  const path = '/Users/me/.kirolex/sessions/s1/files/W35.md';
  const lines = (n: number) => lineBlocks(Array.from({ length: n }, (_, i) => `第 ${i + 1} 行的内容`).join('\n'));

  test('只列有意见的那几行，其余收一句', () => {
    const out = reviewPrompt({ path, blocks: lines(14), comments: { 2: '底部指标太挤，改成三个', 5: '这句删掉' } });
    assert.match(out, /W35\.md 逐行意见（共 14 行）：$/m);
    assert.match(out, /- 第 2 行：底部指标太挤，改成三个/);
    assert.match(out, /- 第 5 行：这句删掉/);
    assert.match(out, /（其余 12 行无意见）/);
    assert.doesNotMatch(out, /第 3 行：/, '没提的那些一条都不该出现');
  });

  test('全都有意见时不写那句收口', () => {
    assert.doesNotMatch(reviewPrompt({ path, blocks: lines(2), comments: { 1: 'a', 2: 'b' } }), /其余/);
  });

  test('删掉的写「删掉」，删掉优先于意见', () => {
    assert.match(reviewPrompt({ path, blocks: lines(3), dropped: { 2: true } }), /- 第 2 行：删掉/);
    const out = reviewPrompt({ path, blocks: lines(3), comments: { 2: '改成三个' }, dropped: { 2: true } });
    assert.match(out, /- 第 2 行：删掉/);
    assert.doesNotMatch(out, /改成三个/);
  });

  test('顺序按行号，不按你写意见的顺序 —— 模型是从头改到尾的', () => {
    const out = reviewPrompt({ path, blocks: lines(5), comments: { 4: '后写的', 2: '先写的' } });
    assert.ok(out.indexOf('第 2 行') < out.indexOf('第 4 行'));
  });

  test('空白意见当没写；一条都没有就返回空串 —— 调用方据此禁用按钮', () => {
    assert.equal(reviewPrompt({ path, blocks: lines(3), comments: { 1: '   ' } }), '');
    assert.equal(reviewPrompt({ path, blocks: lines(3) }), '');
    assert.equal(reviewPrompt({ path, blocks: [] }), '');
    assert.equal(hasFeedback({ path, blocks: lines(3) }), false);
    assert.equal(hasFeedback({ path, blocks: lines(3), comments: { 1: 'x' } }), true);
  });

  test('行号跟着真实行号进提示词 —— 空行占号，所以第 3 行就是第 3 行', () => {
    const out = reviewPrompt({ path: '/a.md', blocks: lineBlocks('标题\n\n正文'), comments: { 3: '改这句' } });
    assert.match(out, /- 第 3 行：改这句/);
  });

  test('路径原样写进去，并且要求**就地改这一份**、不另存', () => {
    const weird = '/tmp/a b/中文 名字.md';
    const out = reviewPrompt({ path: weird, blocks: lines(1), comments: { 1: 'x' } });
    assert.ok(out.startsWith(weird));
    assert.match(out, /请\*\*就地改这一份文件\*\*（\/tmp\/a b\/中文 名字\.md），不要另存成新文件/);
  });

  test('没有 deck 那几节 —— 这条分支只有文本', () => {
    const out = reviewPrompt({ path, blocks: lines(3), comments: { 1: 'x' } });
    assert.doesNotMatch(out, /演讲者备注|结构可以改|加页/);
  });
});

describe('删标题连整节', () => {
  const doc = lineBlocks([
    '# 大标题',        // 1
    '开场',            // 2
    '## 小节 A',       // 3
    'A 正文',          // 4
    '### A.1',         // 5
    'A.1 正文',        // 6
    '## 小节 B',       // 7
    'B 正文',          // 8
  ].join('\n'));

  test('普通行只删自己', () => {
    assert.deepEqual(dropSpan(doc, 4), [4]);
    assert.deepEqual(dropSpan(doc, 8), [8]);
  });

  test('`##` 删到下一个同级为止，中间的 `###` 属于它', () => {
    assert.deepEqual(dropSpan(doc, 3), [3, 4, 5, 6]);
    assert.deepEqual(dropSpan(doc, 5), [5, 6]);
    assert.deepEqual(dropSpan(doc, 1), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(dropSpan(doc, 7), [7, 8]);
  });

  test('认 ATX，不认 Setext —— 判据只看这一行，不往下看', () => {
    assert.equal(headingLevel('## 小节'), 2);
    assert.equal(headingLevel('#没空格'), null);
    assert.equal(headingLevel('####### 七级'), null);
    assert.equal(headingLevel('正文'), null);
  });

  test('不存在的 index 退回只删自己，不炸', () => {
    assert.deepEqual(dropSpan(doc, 999), [999]);
    assert.deepEqual(dropSpan(null, 3), [3]);
  });

  test('分隔线是节的边界，也能被单独 ✕', () => {
    const b = lineBlocks(['## A', 'a', '---', 'b'].join('\n'));
    assert.equal(isRuleLine('---'), true);
    assert.deepEqual(dropSpan(b, 1), [1, 2]);
    assert.deepEqual(dropSpan(b, 3), [3]);
  });

  test('连续被删的收成一个区间 —— 十几条「删掉」既是噪音也像十几个独立决定', () => {
    const out = reviewPrompt({ path: '/a.md', blocks: doc, dropped: { 3: true, 4: true, 5: true, 6: true } });
    assert.match(out, /- 第 3–6 行：删掉（连同其间所有内容）/);
    assert.doesNotMatch(out, /- 第 4 行/);
  });
});

describe('列表项拥有它下面缩进更深的行', () => {
  const SIGNAL = lineBlocks([
    '## 信号',
    '',
    '- **[Observation] 数据合规正推动多 Region 独立部署成为常态**',
    '  - 客户/场景: 易宝国际 GPT 平台大数据迁移',
    '  - 现象: 按合规边界复制整套大数据栈',
    '  - 影响/建议: 建议沉淀为可复用的参考实现',
    '- **[Challenge] AgentCore 在内部运维 Agent 场景存在两个落地阻碍**',
    '  - 客户/场景: 易宝支付 Hermes Agent 部署方案选型。',
    '',
    '## 本周分享',
  ].join('\n'));

  test('父项带走子项，到下一个同级为止；子项只管自己', () => {
    assert.deepEqual(dropSpan(SIGNAL, 3), [3, 4, 5, 6]);
    assert.deepEqual(dropSpan(SIGNAL, 7), [7, 8]);
    assert.deepEqual(dropSpan(SIGNAL, 4), [4]);
  });

  test('标题是硬边界；`##` 照旧带整节', () => {
    assert.ok(!dropSpan(SIGNAL, 7).includes(10));
    assert.deepEqual(dropSpan(SIGNAL, 1), [1, 3, 4, 5, 6, 7, 8]);
  });

  test('`1.` 有序列表同样算；普通一行照旧只管自己', () => {
    assert.deepEqual(dropSpan(lineBlocks(['1. 第一条', '   - 说明', '2. 第二条'].join('\n')), 1), [1, 2]);
    assert.deepEqual(dropSpan(lineBlocks('一段话\n  缩进的下一行'), 1), [1]);
  });
});

describe('不挂在行上的意见', () => {
  const doc = lineBlocks('第一行\n第二行\n第三行');

  test('单独一节，不混进逐行那张单子', () => {
    const out = reviewPrompt({ path: '/a.md', blocks: doc, comments: { 2: '这句改一下' }, extra: ['整体太长'] });
    assert.match(out, /逐行意见（共 3 行）/);
    assert.match(out, /其他意见：\n- 整体太长/);
  });

  test('只有整体意见时抬头换一句；空白的不算', () => {
    const out = reviewPrompt({ path: '/a.md', blocks: doc, extra: ['口径和上周不一致'] });
    assert.match(out, /^\/a\.md 的意见：$/m);
    assert.doesNotMatch(out, /逐行/);
    assert.equal(reviewPrompt({ path: '/a.md', blocks: doc, extra: ['  ', ''] }), '');
  });
});

describe('代码围栏', () => {
  const doc = lineBlocks([
    '# 真标题', '正文', '```bash', '# 安装依赖', 'npm install', '```', '## 后面这节', '尾巴',
  ].join('\n'));
  const at = (i: number) => doc.find((b) => b.index === i)!;

  test('围栏里那行标了 fenced，围栏本身也算', () => {
    assert.equal(at(4).fenced, true);
    assert.equal(at(3).fenced, true);
    assert.equal(at(6).fenced, true);
    assert.equal(at(1).fenced, undefined);
    assert.equal(at(7).fenced, undefined);
  });

  test('围栏里的假标题既不会带走整份，也不会截断外面那一节', () => {
    assert.deepEqual(dropSpan(doc, 4), [4]);
    assert.deepEqual(dropSpan(doc, 1), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('~~~ 也认，收尾要求同种符号；没关的围栏宁可少删', () => {
    const b = lineBlocks(['~~~', '# 里面', '~~~', '# 外面'].join('\n'));
    assert.equal(b.find((x) => x.index === 2)!.fenced, true);
    assert.equal(b.find((x) => x.index === 4)!.fenced, undefined);
    assert.deepEqual(dropSpan(lineBlocks(['```', '# 一直没关', '还是代码'].join('\n')), 2), [2]);
  });
});

describe('围栏里的行合成一块显示', () => {
  const md = ['# 标题', '', '正文', '', '```bash', '# 安装依赖', 'npm i', '', 'npm test', '```', '', '结尾'].join('\n');
  const groups = displayGroups(lineBlocks(md));

  test('一个围栏 = 一组，覆盖它全部的行，原文（含中间空行）照留', () => {
    assert.deepEqual(groups.map((g) => g.fenced), [false, false, true, false]);
    const fence = groups.find((g) => g.fenced)!;
    assert.equal(fence.anchor, 5);
    assert.deepEqual(fence.span, [5, 6, 7, 9, 10]);
    assert.equal(fence.text, '```bash\n# 安装依赖\nnpm i\n\nnpm test\n```');
  });

  test('挂在围栏上的意见写成范围，不写围栏那一行', () => {
    const spans: Record<number, number[]> = {};
    for (const g of groups) if (g.span.length > 1) spans[g.anchor] = g.span;
    const out = reviewPrompt({ path: '/a.md', blocks: lineBlocks(md), comments: { 5: '这段要加 sudo' }, spans });
    assert.match(out, /第 5–10 行：这段要加 sudo/);
  });

  test('没有围栏的文档：一行一组；空输入不炸', () => {
    const g2 = displayGroups(lineBlocks('a\n\nb\nc'));
    assert.deepEqual(g2.map((g) => [g.anchor, g.span, g.fenced]), [[1, [1], false], [3, [3], false], [4, [4], false]]);
    assert.deepEqual(displayGroups([]), []);
  });
});

describe('逐行渲染前先摘掉缩进', () => {
  test('摘出来的缩进单独返回；没缩进原样；tab 按 4 格', () => {
    assert.deepEqual(mdLine('    - 三级'), { md: '- 三级', indent: 4 });
    assert.deepEqual(mdLine('正文'), { md: '正文', indent: 0 });
    assert.deepEqual(mdLine('\t- x'), { md: '- x', indent: 4 });
  });
});

/**
 * 「✓ 确认」只改一块时按**闭区间**取原文、按闭区间换回去 —— 这一条是搬过来时修的。
 *
 * flow 那边把 span 里的**非空**行拼起来当原文、只替换 span 里那几行：一节里段落之间的空行既不在
 * 发给模型的原文里，也没被替换掉，全挤到新内容后面 —— markdown 里几段渲染成了一段。
 */
describe('一块的原文和替换 —— 段落之间的空行照带', () => {
  const doc = ['# 总览', '', '## A', '第一段', '', '第二段', '', '## B', 'b'].join('\n');
  const blocks = lineBlocks(doc);

  test('标题的 span 只含非空行，闭区间把中间的空行带上', () => {
    const span = dropSpan(blocks, 3);
    assert.deepEqual(span, [3, 4, 6]);
    assert.deepEqual(spanRange(span), { from: 3, to: 6 });
    assert.equal(sliceLines(doc, 3, 6), '## A\n第一段\n\n第二段');
  });

  test('整段换回去：段落还是段落，节外一个字节不动', () => {
    const out = spliceLines(doc, 3, 6, '## A\n改过的第一段\n\n改过的第二段');
    assert.equal(out, ['# 总览', '', '## A', '改过的第一段', '', '改过的第二段', '', '## B', 'b'].join('\n'));
  });

  test('单行就是它自己；末尾的换行原样保留', () => {
    assert.equal(spliceLines('a\nb\nc\n', 2, 2, 'B'), 'a\nB\nc\n');
    assert.deepEqual(spanRange([7]), { from: 7, to: 7 });
  });
});
