import { test, describe } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { diffChanges, trustedChanges, revertChange, changeIntact, remapChanges, markLayout, planUndo, UNDO_REFUSED } from '../src/renderer/aiChanges.ts';
import { displayGroups, lineBlocks } from '../src/renderer/reviewBlocks.ts';

const doc = ['# 标题', '', '第一段。', '', '第二段。', '', '第三段。'].join('\n');

describe('diffChanges：这一次改了哪几处', () => {
  test('一样的两版没有改动', () => {
    assert.deepEqual(diffChanges(doc, doc), []);
  });
  test('两段合并成一段：只标出那一处，原文是被合并的那三行', () => {
    const after = ['# 标题', '', '第一段。第二段。', '', '第三段。'].join('\n');
    const ch = diffChanges(doc, after);
    assert.equal(ch.length, 1);
    assert.deepEqual(ch[0], {
      from: 3, to: 3, text: '第一段。第二段。',
      origFrom: 3, origTo: 5, original: '第一段。\n\n第二段。',
    });
  });
  test('一次改了两段：两处各自分开', () => {
    const after = doc.replace('第一段。', '第一段改。').replace('第三段。', '第三段改。');
    const ch = diffChanges(doc, after);
    assert.deepEqual(ch.map((c) => [c.from, c.to, c.original]), [[3, 3, '第一段。'], [7, 7, '第三段。']]);
  });
  test('纯新增：原文是空区间', () => {
    const after = doc.replace('第一段。', '第一段。\n\n新加的。');
    const [c] = diffChanges(doc, after);
    assert.equal(c.text.includes('新加的。'), true);
    assert.equal(c.origTo, c.origFrom - 1);
    assert.equal(c.original, '');
  });
  test('纯删除：新文件里是空区间', () => {
    const after = ['# 标题', '', '第一段。', '', '第三段。'].join('\n');
    const [c] = diffChanges(doc, after);
    assert.equal(c.to, c.from - 1);
    assert.equal(revertChange(after, c), doc);
  });
});

describe('revertChange：只把这一处换回原文', () => {
  test('撤销其中一处，另一处的改动还在', () => {
    const after = doc.replace('第一段。', '第一段改。').replace('第三段。', '第三段改。');
    const [first, second] = diffChanges(doc, after);
    const reverted = revertChange(after, first);
    assert.equal(reverted, doc.replace('第三段。', '第三段改。'));
    /* 另一处跟着挪（这里行数没变），撤销它也照样对 */
    const [left] = remapChanges([first, second], after, reverted!).filter((m) => m !== first);
    assert.equal(revertChange(reverted, left), doc);
  });
  test('合并撤销：恢复成原来两段', () => {
    const after = ['# 标题', '', '第一段。第二段。', '', '第三段。'].join('\n');
    const [c] = diffChanges(doc, after);
    assert.equal(revertChange(after, c), doc);
  });
  test('这一段之后又改过了：拒绝撤销', () => {
    const after = doc.replace('第一段。', '第一段改。');
    const [c] = diffChanges(doc, after);
    const edited = after.replace('第一段改。', '我又改了。');
    assert.equal(changeIntact(edited, c), false);
    assert.equal(revertChange(edited, c), null);
  });
  test('纯新增撤销：那几行整行去掉，不留空行', () => {
    const after = doc.replace('第一段。', '第一段。\n\n新加的。');
    const [c] = diffChanges(doc, after);
    assert.equal(revertChange(after, c), doc);
  });
});

describe('remapChanges：之后的改动落盘，标记跟着挪', () => {
  test('前面多了几行：后面那处往下挪；被改到的那处丢掉', () => {
    const after = doc.replace('第一段。', '第一段改。').replace('第三段。', '第三段改。');
    const marks = diffChanges(doc, after);
    const later = after.replace('# 标题', '# 标题\n\n多一段。');
    const moved = remapChanges(marks, after, later);
    assert.deepEqual(moved.map((m) => m.from), [5, 9]);
    for (const m of moved) assert.equal(changeIntact(later, m), true);
    const touched = later.replace('第一段改。', '再改。');
    assert.deepEqual(remapChanges(moved, later, touched).map((m) => m.from), [9]);
  });
});

describe('trustedChanges：主进程回的那份对得上才用', () => {
  test('对得上就用，text 从新版里取', () => {
    const after = doc.replace('第一段。', '第一段改。');
    const got = trustedChanges([{ from: 3, to: 3, original: '第一段。', origFrom: 3, origTo: 3 }], doc, after);
    assert.deepEqual(got, [{ from: 3, to: 3, original: '第一段。', origFrom: 3, origTo: 3, text: '第一段改。' }]);
  });
  test('原文对不上 / 不是数组：返回 null', () => {
    const after = doc.replace('第一段。', '第一段改。');
    assert.equal(trustedChanges([{ from: 3, to: 3, original: '别的', origFrom: 3, origTo: 3 }], doc, after), null);
    assert.equal(trustedChanges(undefined, doc, after), null);
  });
});

describe('markLayout：哪些块挂底色、标记行摆在哪', () => {
  test('每处各自一行，挂在它那一块下面；纯删除挂在前一块', () => {
    const after = doc.replace('第一段。', '第一段改。').replace('\n\n第三段。', '');
    const marks = diffChanges(doc, after);
    const groups = displayGroups(lineBlocks(after));
    const { lit, rowAt } = markLayout(marks, groups);
    assert.deepEqual([...lit], [3]);
    assert.deepEqual([...rowAt.entries()], [[3, [0]], [5, [1]]]);
  });
});

describe('标记按文件存：pane 卸掉再挂回来还在', () => {
  test('退订（卸掉）之后照样拿得回来；下一轮提交清空；别的文件不受影响', async () => {
    const { getAiMarks, updateAiMarks, subscribeAiMarks } = await import('../src/renderer/aiMarkStore.ts');
    const after = doc.replace('第一段。', '第一段改。');
    const marks = diffChanges(doc, after).map((c, i) => ({ ...c, id: i + 1 }));
    let heard = 0;
    const off = subscribeAiMarks('a.md', () => { heard += 1; });
    updateAiMarks('a.md', () => ({ base: after, marks }));
    assert.equal(heard, 1);
    off();   // pane 卸掉
    const back = getAiMarks('a.md');
    assert.deepEqual(back, { base: after, marks });
    assert.equal(getAiMarks('b.md'), undefined);
    /* 同一个对象 = 没变，不通知（useSyncExternalStore 的稳定快照） */
    let again = 0;
    const off2 = subscribeAiMarks('a.md', () => { again += 1; });
    updateAiMarks('a.md', (cur) => cur);
    assert.equal(again, 0);
    updateAiMarks('a.md', () => undefined);   // 下一轮提交
    assert.equal(getAiMarks('a.md'), undefined);
    assert.equal(again, 1);
    off2();
  });
  test('ReviewPane 的标记从 aiMarkStore 取，不是自己的 useState', () => {
    const RV = fs.readFileSync('src/renderer/components/ReviewPane.tsx', 'utf8');
    assert.ok(RV.includes('useSyncExternalStore(subscribeAi'));
    assert.ok(!/useState<AiMark/.test(RV));
    assert.ok(RV.includes("beginAiRound(path);"));
  });
});

describe('planUndo：以盘上此刻那一份为准', () => {
  const after = doc.replace('第一段。', '第一段改。').replace('第三段。', '第三段改。');
  const marks = diffChanges(doc, after).map((c, i) => ({ ...c, id: i + 1 }));
  const state = { base: after, marks };
  test('盘上别处又改了（预览还是旧的）：按盘上那份撤销，外面那处改动留着', () => {
    const disk = after.replace('# 标题', '# 标题\n\n外面加的。').replace('第三段改。', '第三段改。外面又补了一句。');
    const plan = planUndo(state, 1, disk);
    assert.equal(plan.ok, true);
    assert.equal((plan as any).text, disk.replace('第一段改。', '第一段。'));
    assert.equal((plan as any).mark.from, 5);
  });
  test('盘上那一段本身被改了：拒绝，提示要求的那句', () => {
    const disk = after.replace('第一段改。', '外面改过了。');
    assert.deepEqual(planUndo(state, 1, disk), { ok: false, why: UNDO_REFUSED });
    assert.equal(UNDO_REFUSED, '这一段之后又改过了，没撤销');
  });
  test('撤销读盘、带 expectBase 写；主进程按 expectBase 原子核对', () => {
    const RV = fs.readFileSync('src/renderer/components/ReviewPane.tsx', 'utf8');
    assert.ok(RV.includes('await window.kiroApi.workspaceRead(sessionId, path)'));
    assert.ok(RV.includes('const plan = planUndo(state, id, disk);'));
    assert.ok(RV.includes('{ undid: id, expectBase: disk }'));
    assert.ok(RV.includes('reviewWriteFile?.(sessionId, path, fullText, opts.expectBase)'));
    const P = fs.readFileSync('src/main/preload.ts', 'utf8');
    assert.ok(P.includes("ipcRenderer.invoke('review:write-file', sessionId, filePath, text, expectBase)"));
    const M = fs.readFileSync('src/main/index.ts', 'utf8');
    assert.ok(M.includes("writeReviewFile(sessionId, filePath, text, typeof expectBase === 'string' ? expectBase : undefined)"));
    assert.ok(M.includes("if (typeof expectBase === 'string' && previous !== expectBase)"));
  });
});

describe('重复段落：对不准位置就不撤', () => {
  const before = 'title\n\noriginal\n\nsame\n\nend';
  const after = 'title\n\nsame\n\nsame\n\nend';            // AI 把 original 改成了 same
  const disk = 'title\n\nsame\n\nend';                     // 之后你删掉了 AI 那一段和它后面的空行
  const marks = diffChanges(before, after).map((c, i) => ({ ...c, id: i + 1 }));
  test('AI 那一处就是第 3 行', () => {
    assert.deepEqual(marks.map((m) => [m.from, m.to, m.original, m.text]), [[3, 3, 'original', 'same']]);
  });
  test('预览还没刷：拒绝，剩下那段 same 不动', () => {
    assert.deepEqual(planUndo({ base: after, marks }, 1, disk), { ok: false, why: UNDO_REFUSED });
  });
  test('预览已经刷新（标记先跟着挪了一次）再撤：同样拒绝', () => {
    const refreshed = { base: disk, marks: remapChanges(marks, after, disk, true) };
    assert.equal(refreshed.marks.length, 1);
    assert.equal(refreshed.marks[0].stale, true);
    assert.deepEqual(planUndo(refreshed, 1, disk), { ok: false, why: UNDO_REFUSED });
  });
  test('落盘那条路（不留被碰到的）：对不准的标记直接摘掉', () => {
    assert.deepEqual(remapChanges(marks, after, disk), []);
  });
  test('对得准的照样能撤：重复段落前面多了一段，AI 那处跟着挪', () => {
    const moved = after.replace('title', 'title\n\nnew');
    const plan = planUndo({ base: after, marks }, 1, moved);
    assert.equal(plan.ok, true);
    assert.equal((plan as any).text, before.replace('title', 'title\n\nnew'));
  });
  test('late 对法和默认对法在没有歧义时给出同一份结果', () => {
    const a = doc;
    const b = doc.replace('第一段。', '第一段改。').replace('\n\n第三段。', '');
    assert.deepEqual(diffChanges(a, b, true), diffChanges(a, b));
  });
});

describe('提交轮次：连续提交时上一轮的标记不再冒出来', () => {
  test('第一轮还没写完就提交第二轮：两轮依次写完，只留第二轮的标记；第一轮的内容照常写进去', async () => {
    const { getAiMarks, aiRoundOf, beginAiRound, recordAiWrite } = await import('../src/renderer/aiMarkStore.ts');
    const P = 'rounds.md';
    const mk = (before: string, after: string, id0: number) => diffChanges(before, after).map((c, i) => ({ ...c, id: id0 + i }));
    /* 第一轮：对第一段的意见入队（记下轮次），还没写完 */
    beginAiRound(P);
    const round1 = aiRoundOf(P);
    /* 第二轮：对第三段的意见入队 —— 上一轮的标记清掉 */
    beginAiRound(P);
    const round2 = aiRoundOf(P);
    assert.notEqual(round1, round2);
    /* 第一轮先写完：内容进了盘（这里由调用方写），但不挂标记 */
    const v1 = doc.replace('第一段。', '第一段改。');
    recordAiWrite(P, { base: doc, fullText: v1, fresh: mk(doc, v1, 100), round: round1 });
    assert.equal(getAiMarks(P), undefined);
    /* 第二轮写完：基于第一轮写完的那一版，只有它那一处有标记 */
    const v2 = v1.replace('第三段。', '第三段改。');
    recordAiWrite(P, { base: v1, fullText: v2, fresh: mk(v1, v2, 200), round: round2 });
    const st = getAiMarks(P)!;
    assert.equal(st.base, v2);
    assert.deepEqual(st.marks.map((m) => [m.id, m.from, m.text]), [[200, 7, '第三段改。']]);
    /* 第一轮那处改动还在正文里，只是没有标记 */
    assert.ok(st.base.includes('第一段改。'));
  });
  test('同一轮的几条依次写完：标记都在，先写的那几处跟着后写的挪', async () => {
    const { getAiMarks, aiRoundOf, beginAiRound, recordAiWrite } = await import('../src/renderer/aiMarkStore.ts');
    const P = 'same-round.md';
    beginAiRound(P);
    const r = aiRoundOf(P);
    const v1 = doc.replace('第三段。', '第三段改。');
    recordAiWrite(P, { base: doc, fullText: v1, fresh: diffChanges(doc, v1).map((c) => ({ ...c, id: 1 })), round: r });
    const v2 = v1.replace('# 标题', '# 标题\n\n新加的。');
    recordAiWrite(P, { base: v1, fullText: v2, fresh: diffChanges(v1, v2).map((c) => ({ ...c, id: 2 })), round: r });
    assert.deepEqual(getAiMarks(P)!.marks.map((m) => [m.id, m.from]).sort(), [[1, 9], [2, 3]]);
  });
  test('ReviewPane 入队时记轮次、提交时开新一轮', () => {
    const RV = fs.readFileSync('src/renderer/components/ReviewPane.tsx', 'utf8');
    assert.ok(RV.includes('const round = aiRoundOf(path);'));
    assert.ok(RV.includes('beginAiRound(path);'));
    assert.ok(RV.includes('recordAiWrite(path, { base, fullText, fresh, round: opts.ai?.round, undid: opts.undid });'));
  });
});

describe('撤销一段，不清掉别的段（包括之后又改过的那段）', () => {
  test('AI 改两段 → 你又改了第一段 → 撤销第二段：第一段标记还在、是 stale，点撤销提示原话', async () => {
    const { getAiMarks, aiRoundOf, beginAiRound, recordAiWrite, updateAiMarks } = await import('../src/renderer/aiMarkStore.ts');
    const P = 'undo-keeps-stale.md';
    beginAiRound(P);
    const ai = doc.replace('第一段。', '第一段改。').replace('第三段。', '第三段改。');
    recordAiWrite(P, { base: doc, fullText: ai, fresh: diffChanges(doc, ai).map((c, i) => ({ ...c, id: i + 1 })), round: aiRoundOf(P) });
    assert.deepEqual(getAiMarks(P)!.marks.map((m) => m.id), [1, 2]);
    /* 你在外面又改了第一段 —— 预览刷新，标记跟着挪（ReviewPane 里 text 变了那条 effect 做的就是这一步） */
    const edited = ai.replace('第一段改。', '我又改了第一段。');
    updateAiMarks(P, (cur) => cur && { base: edited, marks: remapChanges(cur.marks, cur.base, edited, true) });
    assert.equal(getAiMarks(P)!.marks.find((m) => m.id === 1)!.stale, true);
    /* 撤销第二段 */
    const plan = planUndo(getAiMarks(P)!, 2, edited);
    assert.equal(plan.ok, true);
    const undone = (plan as any).text as string;
    assert.equal(undone, edited.replace('第三段改。', '第三段。'));
    recordAiWrite(P, { base: edited, fullText: undone, undid: 2 });
    const st = getAiMarks(P)!;
    assert.deepEqual(st.marks.map((m) => [m.id, m.from, !!m.stale]), [[1, 3, true]]);
    /* 第一段照样显示（markLayout 给它挂底色和那一行） */
    const { lit, rowAt } = markLayout(st.marks, displayGroups(lineBlocks(undone)));
    assert.ok(lit.has(3));
    assert.deepEqual(rowAt.get(3), [0]);
    /* 点它的撤销：拒绝，原话 */
    assert.deepEqual(planUndo(st, 1, undone), { ok: false, why: '这一段之后又改过了，没撤销' });
  });
  test('同一轮后一条又改了同一段：被新标记盖住的旧 stale 那条不再重复挂', async () => {
    const { getAiMarks, aiRoundOf, beginAiRound, recordAiWrite } = await import('../src/renderer/aiMarkStore.ts');
    const P = 'same-para-twice.md';
    beginAiRound(P);
    const r = aiRoundOf(P);
    const v1 = doc.replace('第一段。', '第一段改。');
    recordAiWrite(P, { base: doc, fullText: v1, fresh: diffChanges(doc, v1).map((c) => ({ ...c, id: 1 })), round: r });
    const v2 = v1.replace('第一段改。', '第一段整篇重写。');
    recordAiWrite(P, { base: v1, fullText: v2, fresh: diffChanges(v1, v2).map((c) => ({ ...c, id: 2 })), round: r });
    assert.deepEqual(getAiMarks(P)!.marks.map((m) => m.id), [2]);
  });
});

describe('trustedChanges 认主进程 patch 档的 PatchChange', () => {
  test('applyPatch 回的 changes 直接用；没改的那几处不标', async () => {
    const { applyPatch } = await import('../src/main/reviewApply.ts');
    /* 第 3–5 行合成一段；第 7 行交回了原样（没改） */
    const res = applyPatch(doc, [
      { from: 3, to: 5, text: '第一段。第二段。' },
      { from: 7, to: 7, text: '第三段。' },
    ]);
    assert.equal(res.ok, true);
    const { text, changes } = res as any;
    const got = trustedChanges(changes, doc, text);
    assert.ok(got);
    assert.deepEqual(got!.map((c) => [c.text, c.original]), [['第一段。第二段。', '第一段。\n\n第二段。']]);
    const { lit } = markLayout(got!, displayGroups(lineBlocks(text)));
    assert.deepEqual([...lit], [got![0].from]);
  });
  test('oldFrom/oldTo/oldText 写法', () => {
    const before = ['# 标题', '', '第一段。', '', '第二段。', '', '第三段。'].join('\n');
    const after = ['# 标题', '', '第一段。第二段。', '', '第三段。'].join('\n');
    const got = trustedChanges([
      { from: 3, to: 3, oldFrom: 3, oldTo: 5, oldText: '第一段。\n\n第二段。', newText: '第一段。第二段。' },
      { from: 5, to: 5, oldFrom: 7, oldTo: 7, oldText: '第三段。', newText: '第三段。' },
    ], before, after);
    assert.deepEqual(got, [{ from: 3, to: 3, original: '第一段。\n\n第二段。', origFrom: 3, origTo: 5, text: '第一段。第二段。' }]);
  });
});

describe('「AI 刚改过」+ 撤销的位置：右边那一栏、按钮正下面', () => {
  test('绝对定位在按钮那一行下面、贴右；这一段按行数撑高，不压到下一段', () => {
    const css = fs.readFileSync('src/renderer/styles/global.css', 'utf8');
    const side = /\.rv-ai-side \{([^}]*)\}/.exec(css)?.[1] || '';
    assert.match(side, /position: absolute/);
    assert.match(side, /top: var\(--rv-tool-row\)/);
    assert.match(side, /right: 0/);
    assert.match(css, /\.rv-review-block\.ai-host \{ padding-right: \d+px; \}/);
    const RV = fs.readFileSync('src/renderer/components/ReviewPane.tsx', 'utf8');
    assert.ok(RV.includes("style={aiHere.length ? { minHeight: `calc(${aiHere.length + 1} * var(--rv-tool-row))` } : undefined}"));
  });
});
