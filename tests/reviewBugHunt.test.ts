import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseRevised, keepHeading, settlePatchRevision, replyUsable, lostFields } from '../src/main/reviseBlock.ts';
import { spliceLines, insertAfterLines, deleteLines, applyPatch, applyRevision, sliceLines, patchReplyOutcome } from '../src/main/reviewApply.ts';
import { reviewBackupsToPrune, reviewBackupPrefix, writeTextVia } from '../src/main/reviewAccess.ts';
import { lineBlocks, displayGroups, dropSpan, spanRange, locateBlock, backupThenSend, clearSent, createSubmitGate, submitFromBox } from '../src/renderer/reviewBlocks.ts';
import { applyDraft } from '../src/renderer/commentBoxApply.ts';
import { rewritePatch, exactKeep, exactLineMap, singleRange } from '../src/renderer/rewritePatch.ts';
import { diffChanges, planUndo } from '../src/renderer/aiChanges.ts';
import { putReviewItem, remapReviewLines, removeReviewItem, reviewItemLine, reviewItemLost, liveMarkKey } from '../src/renderer/reviewQueue.ts';

/**
 * 侧栏 review / comment 改写的系统找 bug（任务 95172638）。每一组前面写着它对应需求里的第几类场景；
 * 「BUG」开头的那些先写成失败的复现，再修；其余是确认没问题的场景，钉住现在的行为。
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const RV = read('src/renderer/components/ReviewPane.tsx');
const MAIN = read('src/main/index.ts');
const PRE = read('src/main/preload.ts');
const APP = read('src/renderer/App.tsx');

/** 渲染层逐行块（`writeBack` 喂给 `rewritePatch` 的那一份）。 */
const rows = (text: string) => lineBlocks(text).flatMap((b) => (b.kind === 'line' ? [{ index: b.index, text: b.text }] : []));
/** 一块（标题带整节、围栏带整段）此刻占的行 —— 和 ReviewPane 提交时取的一样。 */
const blockRange = (text: string, anchor: number) => {
  const blocks = lineBlocks(text);
  const g = displayGroups(blocks).find((x) => x.anchor === anchor);
  return spanRange(g && g.span.length > 1 ? g.span : dropSpan(blocks, anchor));
};

describe('场景 5 / 6：对代码块 comment，回复本来就是一个代码块', () => {
  const CODE = '```js\nconst a = 1;\n```';
  test('BUG：原文是围栏代码块、回复也是 —— 围栏不能被当成"多余的包装"剥掉', () => {
    const out = parseRevised('```js\nconst a = 2;\n```', CODE);
    assert.equal(out.text, '```js\nconst a = 2;\n```');
  });
  test('原文是代码块、模型又在外面多包了一层：只剥外面那层', () => {
    const out = parseRevised('```markdown\n```js\nconst a = 2;\n```\n```', CODE);
    assert.equal(out.text, '```js\nconst a = 2;\n```');
  });
  test('原文不是代码块：外层围栏照旧剥掉（不变）', () => {
    assert.equal(parseRevised('```\n改过的一段。\n```', '原来的一段。').text, '改过的一段。');
  });
  test('拼回文件：代码块还是代码块，前后的行逐字不变', () => {
    const base = '# 安装\n\n```bash\nnpm i\n```\n\n结尾。\n';
    const { from, to } = blockRange(base, 3);
    assert.deepEqual([from, to], [3, 5]);
    const where = sliceLines(base, from, to);
    const out = parseRevised('```bash\nnpm ci\n```', where);
    assert.equal(spliceLines(base, from, to, out.text), '# 安装\n\n```bash\nnpm ci\n```\n\n结尾。\n');
  });
});

describe('场景 4：CRLF 换行的文件', () => {
  const CR = '# 标题\r\n\r\n第一段。\r\n\r\n第二段。\r\n';
  const pureCrlf = (s: string) => !/(^|[^\r])\n/.test(s);
  test('BUG：整段替换后整份还是 CRLF（不混进 LF）', () => {
    const out = spliceLines(CR, 3, 3, '第一段改。');
    assert.equal(out, '# 标题\r\n\r\n第一段改。\r\n\r\n第二段。\r\n');
  });
  test('BUG：模型回了多行（LF）—— 拼进去也是 CRLF', () => {
    const out = spliceLines(CR, 3, 3, '第一行。\n第二行。');
    assert.ok(pureCrlf(out), JSON.stringify(out));
    assert.equal(out, '# 标题\r\n\r\n第一行。\r\n第二行。\r\n\r\n第二段。\r\n');
  });
  test('BUG：在一段后面加（含补上的空行）也是 CRLF', () => {
    const out = insertAfterLines(CR, 3, '新加的。');
    assert.equal(out, '# 标题\r\n\r\n第一段。\r\n\r\n新加的。\r\n\r\n第二段。\r\n');
  });
  test('BUG：patch 档拼回也是 CRLF；changes 的新文本和新文件对得上', () => {
    const res = applyPatch(CR, [{ from: 3, to: 3, text: '甲\n乙' }]);
    assert.equal(res.ok, true);
    const r = res as Extract<typeof res, { ok: true }>;
    assert.ok(pureCrlf(r.text), JSON.stringify(r.text));
    assert.equal(r.changes[0].newText, sliceLines(r.text, r.changes[0].from, r.changes[0].to));
    assert.equal(r.changes[0].oldText, sliceLines(CR, 3, 3));
  });
  test('主进程拼回（applyRevision）同一套：CRLF 文件改完还是 CRLF', () => {
    const out = applyRevision({ path: 'a.md', mode: 'splice', from: 3, to: 3, base: CR }, '第一段改。\n续一行。');
    assert.ok(out && pureCrlf(out), JSON.stringify(out));
  });
  test('对标题 comment：补回的标题和正文一起都是 CRLF', () => {
    const where = sliceLines(CR, 1, 5);
    const revised = keepHeading(where, '第一段。\n\n第二段改。');
    const out = spliceLines(CR, 1, 5, revised);
    assert.ok(pureCrlf(out), JSON.stringify(out));
    assert.ok(out.startsWith('# 标题\r\n\r\n'));
  });
  test('删一段：接缝照旧收空行，换行符不变', () => {
    assert.equal(deleteLines(CR, 3, 3), '# 标题\r\n\r\n第二段。\r\n');
  });
  test('混用换行的文件不去"统一"它 —— 只动新写进去的那几行', () => {
    const mixed = 'a\r\nb\nc\n';
    assert.equal(spliceLines(mixed, 2, 2, 'B'), 'a\r\nB\nc\n');
  });
  test('块模型认 CRLF：空行不成块，标题带整节', () => {
    const bl = lineBlocks(CR);
    assert.deepEqual(bl.map((b: any) => b.index), [1, 3, 5]);
    assert.deepEqual(dropSpan(bl, 1), [1, 3, 5]);
  });
});

describe('场景 4：大文件（接近 512KB 的预览上限）', () => {
  test('BUG：落盘后给剩下的标记对位（rewritePatch）不能是 O(行数²) —— 八千行改一行要很快', () => {
    const n = 8000;
    const base = Array.from({ length: n }, (_, i) => `第 ${i} 行 mixed 中英 😀`).join('\n') + '\n';
    const next = base.replace('第 4000 行', '第四千行');
    const t0 = Date.now();
    const p = rewritePatch(rows(base), next);
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `用了 ${ms}ms`);
    assert.equal(p.keep[1], 1);
    assert.equal(p.keep[n], n);
    assert.equal(p.keep[4001], undefined, '改过的那一行不算"保留"');
    assert.equal(p.edits[4001], '第四千行 mixed 中英 😀');
  });
  test('中间那一段很大、两边都改了：也不会卡住，首尾没动的行照样对位', () => {
    const n = 6000;
    const a = Array.from({ length: n }, (_, i) => `a${i}`);
    const b = a.map((l, i) => (i > 10 && i < n - 10 ? `b${i}` : l));
    const t0 = Date.now();
    const p = rewritePatch(a.map((text, i) => ({ index: i + 1, text })), b.join('\n'));
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(p.keep[1], 1);
    assert.equal(p.keep[n], n);
  });
  test('审查复现：3000 行只改了第一行和最后一行 —— 中间没改的行照样对位，挂在上面的意见不丢', () => {
    const n = 3000;
    const a = Array.from({ length: n }, (_, i) => `第 ${i + 1} 行`);
    const b = a.map((l, i) => (i === 0 || i === n - 1 ? `${l}（改）` : l));
    const t0 = Date.now();
    const p = rewritePatch(a.map((text, i) => ({ index: i + 1, text })), b.join('\n'));
    assert.ok(Date.now() - t0 < 1000);
    for (const line of [2, 1500, n - 1]) assert.equal(p.keep[line], line);
    assert.equal(p.keep[1], undefined);
    assert.equal(p.keep[n], undefined);
    assert.equal(Object.keys(p.keep).length, n - 2);
  });
  test('首尾各改一行、中间全是一样的行（没有只出现一次的行可当锚点）：同一位置上一样的行照样对位', () => {
    const n = 3000;
    const a = ['开头', ...Array.from({ length: n - 2 }, () => '- TODO'), '结尾'];
    const b = ['开头改', ...a.slice(1, -1), '结尾改'];
    const t0 = Date.now();
    const p = rewritePatch(a.map((text, i) => ({ index: i + 1, text })), b.join('\n'));
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(p.keep[2], 2);
    assert.equal(p.keep[n - 1], n - 1);
  });
  test('大文件中间插了几行、两头也改了：插入点前后的行各自对位（锚点 + 递归）', () => {
    const n = 4000;
    const a = Array.from({ length: n }, (_, i) => `行 ${i + 1}`);
    const b = [`${a[0]}!`, ...a.slice(1, 2000), '新甲', '新乙', ...a.slice(2000, n - 1), `${a[n - 1]}!`];
    const p = rewritePatch(a.map((text, i) => ({ index: i + 1, text })), b.join('\n'));
    assert.equal(p.keep[1999], 1999);
    assert.equal(p.keep[2001], 2003);
    assert.equal(p.keep[n - 1], n + 1);
  });
  test('小文件结果和原来一样（对齐算法只是加了首尾剥离）', () => {
    const base = ['# 标题', '', '甲', '', '乙', '', '丙'].join('\n');
    const next = ['# 标题', '', '甲', '', '新的', '乙', '', '丙'].join('\n');
    const p = rewritePatch(rows(base), next);
    assert.deepEqual(p.keep, { 1: 1, 3: 3, 5: 6, 7: 8 });
    assert.deepEqual(p.inserts, { 3: ['新的'] });
  });
  test('预览上限：写回只认整份读得到的（本地 / 远端同一条判据）', async () => {
    const state = { disk: 'x'.repeat(10) };
    const r = await writeTextVia({
      max: 5,
      read: async () => ({ size: state.disk.length, bytes: state.disk.length, text: state.disk }),
      backup: () => true,
      write: async (t) => { state.disk = t; },
    }, 'y');
    assert.equal(r.ok, false);
    assert.equal(state.disk, 'x'.repeat(10));
    assert.match(MAIN, /if \(fs\.statSync\(want\)\.size > WORKSPACE_PREVIEW_MAX_BYTES\)/);
  });
});

describe('场景 4：front matter、表格、中英混排和 emoji', () => {
  const DOC = ['---', 'title: 周报', '---', '', '# 本周 ✅', '', '| 项目 | 状态 |', '| --- | --- |', '| A 😀 | 进行中 |', '', '结尾 end。'].join('\n');
  test('front matter 每行一块，不被当成标题 / 不连带下面', () => {
    const bl = lineBlocks(DOC);
    assert.deepEqual(dropSpan(bl, 2), [2]);
    assert.deepEqual(blockRange(DOC, 2), { from: 2, to: 2 });
  });
  test('表格一行一块；改表格里一行只换那一行', () => {
    const { from, to } = blockRange(DOC, 9);
    assert.deepEqual([from, to], [9, 9]);
    const out = spliceLines(DOC, from, to, '| A 😀 | 已完成 |');
    assert.equal(out, DOC.replace('| A 😀 | 进行中 |', '| A 😀 | 已完成 |'));
  });
  test('BUG：patch 核对字抄表格行时没带开头的 `|` —— 不该判成"数错了行"', () => {
    const res = applyPatch(DOC, [{ from: 9, to: 9, text: '| A 😀 | 已完成 |', hint: 'A 😀 | 进行中' }]);
    assert.equal(res.ok, true, JSON.stringify(res));
  });
  test('表格行核对字带了 `|` 照样认；真数错了行照样拒', () => {
    assert.equal(applyPatch(DOC, [{ from: 9, to: 9, text: 'x', hint: '| A 😀 |' }]).ok, true);
    assert.equal(applyPatch(DOC, [{ from: 9, to: 9, text: 'x', hint: '| 项目 |' }]).ok, false);
  });
  test('emoji / 中英混排的行按原文找得到（排队那条按原文定位）', () => {
    assert.deepEqual(locateBlock(DOC, '# 本周 ✅', 5), { from: 5, to: 11, anchor: 5 }, '标题带整节（到文件末尾）');
    assert.deepEqual(locateBlock(DOC, '| A 😀 | 进行中 |', 9), { from: 9, to: 9, anchor: 9 });
  });
});

describe('场景 5：block / insert 三档在边界上', () => {
  const DOC = ['# 标题', '', '- 一', '  - 一.1', '- 二', '', '最后一行。'].join('\n');
  test('第一行（标题）：范围是整节', () => {
    assert.deepEqual(blockRange(DOC, 1), { from: 1, to: 7 });
  });
  test('列表项带它的子项', () => {
    assert.deepEqual(blockRange(DOC, 3), { from: 3, to: 4 });
  });
  test('最后一行（文件末尾无换行）：改它不多出换行；在它后面加，前面补空行、结尾不加', () => {
    assert.equal(spliceLines(DOC, 7, 7, '改过的最后一行。'), DOC.replace('最后一行。', '改过的最后一行。'));
    assert.equal(insertAfterLines(DOC, 7, '新的。'), `${DOC}\n\n新的。`);
  });
  test('文件末尾有换行：在最后一段后面加，末尾那个换行还在', () => {
    assert.equal(insertAfterLines(`${DOC}\n`, 7, '新的。'), `${DOC}\n\n新的。\n`);
  });
  test('空行不成块（没有入口），所以不会有对空行的 comment', () => {
    assert.ok(!lineBlocks(DOC).some((b: any) => b.index === 2 || b.index === 6));
  });
  test('列表项后面加列表项：不空行', () => {
    assert.equal(insertAfterLines(DOC, 5, '- 三'), DOC.replace('- 二', '- 二\n- 三'));
  });
  test('围栏里的 `# ` 不是标题：comment 它只管那一个代码块', () => {
    const code = ['```sh', '# 安装依赖', 'npm i', '```', '', '正文'].join('\n');
    assert.deepEqual(blockRange(code, 1), { from: 1, to: 4 });
  });
});

describe('场景 6：模型回复异常', () => {
  test('空回复：不写（当成"改不了"，原文不动）', () => {
    const out = parseRevised('', '原文');
    assert.equal(out.text, '原文');
    assert.ok(out.cannot);
  });
  test('只回 CANNOT-REVISE-LOCALLY：原文不动，原因带上来', () => {
    const out = parseRevised('CANNOT-REVISE-LOCALLY: 要查外部系统', '原文');
    assert.deepEqual(out, { text: '原文', cannot: '要查外部系统' });
  });
  test('被截断（max_tokens）/ 卡死：不写', () => {
    assert.equal(replyUsable({ stopReason: 'max_tokens' }).ok, false);
    assert.equal(replyUsable({ stopReason: 'end_turn', wedged: true }).ok, false);
  });
  test('patch 格式不对、追问之后还是不对：报失败、不写', () => {
    let writes = 0;
    const res = settlePatchRevision({ replyText: '好的我改了', base: 'a\nb', followedUp: true, write: () => { writes++; return { ok: true }; } });
    assert.equal(res.ok, false);
    assert.equal(writes, 0);
    assert.equal(patchReplyOutcome(res).kind, 'fail');
  });
  test('patch 回复外面带开场白和围栏：块外的话不进文件', () => {
    const res = settlePatchRevision({ replyText: '好的，改动如下：\n```\n@@ 2-2 | b\nB\n@@ END\n```', base: 'a\nb\nc' });
    /* 外层围栏剥不掉（前面有开场白），但块外的行本来就不算 —— 围栏那两行和开场白都进不了文件 */
    assert.equal(res.ok, true);
    assert.equal((res as any).fullText, 'a\nB\nc');
    const res2 = settlePatchRevision({ replyText: '好的，改动如下：\n@@ 2-2 | b\nB\n@@ END\n以上。', base: 'a\nb\nc' });
    assert.equal(res2.ok, true);
    assert.equal((res2 as any).fullText, 'a\nB\nc');
  });
  test('block 回复带开场白：按设计不猜（误删正文比留一句废话糟），由提示词约束', () => {
    assert.equal(parseRevised('好的，已修改如下：\n新的一段。', '旧').text, '好的，已修改如下：\n新的一段。');
  });
});

describe('场景 1 / 2：同一处连续改、排队时行号挪了', () => {
  test('BUG：重复的行 —— 排队那条按"此刻的行号"找，前面加了几行之后不该改到另一处一样的行上', () => {
    const base = ['# A', '', '- TODO', '', '# B', '', '- TODO', ''].join('\n');
    /* 先落盘的那条：在第 1 行后面加了三行 */
    const after = insertAfterLines(base, 1, '甲\n乙\n丙');
    const keep = rewritePatch(rows(base), after).keep;
    /* 排着的那条是对第 7 行（第二个 TODO）提的 */
    const id = 'rv:test#dup';
    putReviewItem({ id, sessionId: 's', path: 'dup.md', file: 'dup.md', kind: 'revise', line: 7, label: '', state: 'queued', cancel: () => {}, persist: { key: '7', text: '改掉' } });
    remapReviewLines('dup.md', keep);
    const now = reviewItemLine(id);
    assert.equal(now, keep[7]);
    assert.equal(liveMarkKey({ kind: 'revise', line: now!, persist: { key: '7', text: '' } }), String(keep[7]));
    removeReviewItem(id);
    /* 拿提交时的老行号去找，会找到第一个 TODO（离 7 更近）—— 这就是 bug */
    assert.notEqual(locateBlock(after, '- TODO', 7)!.anchor, keep[7]);
    assert.equal(locateBlock(after, '- TODO', now!)!.anchor, keep[7]);
  });
  /** 排一条对 `line` 的改动，先落盘的那条把 `base` 改成 `after`，返回它此刻的状态。 */
  const queuedAfter = (base: string, after: string, line: number, kind: 'revise' | 'delete' = 'delete') => {
    const id = `rv:test#lost-${Math.random()}`;
    putReviewItem({ id, sessionId: 's', path: 'lost.md', file: 'lost.md', kind, line, label: '', state: 'queued', cancel: () => {}, persist: { key: kind === 'delete' ? `drop:${line}` : String(line), text: '' } });
    remapReviewLines('lost.md', rewritePatch(rows(base), after).keep);
    const out = { lost: reviewItemLost(id), line: reviewItemLine(id) };
    removeReviewItem(id);
    return out;
  };
  test('审查复现：第 3、7 行都是 - TODO，前一条把第 3 行改成 - DONE —— 排在后面对第 3 行的删除不能删到第 7 行', () => {
    const base = ['# A', '', '- TODO', '', '# B', '', '- TODO', ''].join('\n');
    const after = spliceLines(base, 3, 3, '- DONE');
    const q = queuedAfter(base, after, 3);
    assert.equal(q.lost, true, '目标已经被改掉了');
    assert.equal(q.line, 3, '意见放回到它原来那个位置（被改掉的那一行），不是第 7 行');
    /* 不标 lost 的话：按原文去找会找到第 7 行 —— 这就是审查复现的那一刀 */
    assert.equal(locateBlock(after, '- TODO', 3)!.anchor, 7);
  });
  test('目标被前一条删掉了：同样标 lost，不去找另一处一样的', () => {
    const base = ['- TODO', '', '甲', '', '- TODO'].join('\n');
    const q = queuedAfter(base, deleteLines(base, 1, 1), 1, 'revise');
    assert.equal(q.lost, true);
  });
  test('重叠范围：整节改写改到了节里排着的那一行 → lost；节里没被碰到的那一行照常跟着挪', () => {
    const base = ['# 节', '', '- TODO', '- 乙', '', '# 下一节', '', '- TODO'].join('\n');
    const after = spliceLines(base, 1, 4, '# 节\n\n新加一行\n- 已完成\n- 乙');
    assert.equal(queuedAfter(base, after, 3).lost, true);
    const ok = queuedAfter(base, after, 4, 'revise');
    assert.equal(ok.lost, false);
    assert.equal(ok.line, 5);
  });
  test('目标那一行没被碰到（只是挪了）：不算 lost', () => {
    const base = ['甲', '', '- TODO', '', '- TODO'].join('\n');
    const q = queuedAfter(base, insertAfterLines(base, 1, '新的'), 5);
    assert.deepEqual(q, { lost: false, line: 7 });
  });
  /** 和 writeBack 同一条路：按这次实际改的那一段算行号（`exactKeep`），再交给队列。 */
  const queuedAfterEdit = (base: string, after: string, oldFrom: number, oldTo: number, line: number, kind: 'revise' | 'delete') => {
    const id = `rv:test#exact-${Math.random()}`;
    putReviewItem({ id, sessionId: 's', path: 'exact.md', file: 'exact.md', kind, line, label: '', state: 'queued', cancel: () => {}, persist: { key: kind === 'delete' ? `drop:${line}` : String(line), text: '' } });
    remapReviewLines('exact.md', exactKeep(base, after, [singleRange(base, after, oldFrom, oldTo)]));
    const out = { lost: reviewItemLost(id), line: reviewItemLine(id) };
    removeReviewItem(id);
    return out;
  };
  test('审查复现：- TODO / 空行 / - TODO，先删第一处 —— 对第一处排着的删除、改写都失效，不会落到第二处', () => {
    const base = '- TODO\n\n- TODO';
    const after = deleteLines(base, 1, 1);
    assert.equal(after, '- TODO');
    assert.deepEqual(rewritePatch(rows(base), after).keep, { 1: 1 }, '全文按字对齐会把留下的那一处认成第一处 —— 这就是 bug');
    assert.equal(queuedAfterEdit(base, after, 1, 1, 1, 'delete').lost, true);
    assert.equal(queuedAfterEdit(base, after, 1, 1, 1, 'revise').lost, true);
  });
  test('同一份里对第二处的任务照常跟着挪（挪到第 1 行），不算失效', () => {
    const base = '- TODO\n\n- TODO';
    const after = deleteLines(base, 1, 1);
    assert.deepEqual(queuedAfterEdit(base, after, 1, 1, 3, 'delete'), { lost: false, line: 1 });
    assert.deepEqual(queuedAfterEdit(base, after, 1, 1, 3, 'revise'), { lost: false, line: 1 });
  });
  test('把第一处改成别的字（替换）：对第一处的失效，对第二处的不动', () => {
    const base = ['- TODO', '', '甲', '', '- TODO'].join('\n');
    const after = spliceLines(base, 1, 1, '- DONE');
    assert.equal(queuedAfterEdit(base, after, 1, 1, 1, 'delete').lost, true);
    assert.deepEqual(queuedAfterEdit(base, after, 1, 1, 5, 'delete'), { lost: false, line: 5 });
  });
  test('改动范围里有两行一样的：都认不准 → 都失效（宁可报冲突，不改到另一处）；范围外一样的那行照常', () => {
    const base = ['# 节', '- TODO', '- TODO', '', '# 下', '- TODO'].join('\n');
    const after = spliceLines(base, 1, 3, '# 节\n- TODO');
    const r = singleRange(base, after, 1, 3);
    const keep = exactKeep(base, after, [r]);
    assert.equal(keep[2], undefined);
    assert.equal(keep[3], undefined);
    assert.equal(keep[1], 1, '范围里只出现一次的标题照样认得');
    assert.equal(keep[6], 5);
  });
  test('删一段时顺手收掉的接缝空行算进删掉的范围，后面的行号照样对', () => {
    const base = ['甲', '', '乙', '', '丙'].join('\n');
    const after = deleteLines(base, 3, 3);
    assert.equal(after, '甲\n\n丙');
    assert.deepEqual(singleRange(base, after, 3, 3), { oldFrom: 3, oldTo: 4, newFrom: 3, newTo: 2 });
    assert.deepEqual(exactKeep(base, after, [singleRange(base, after, 3, 3)]), { 1: 1, 2: 2, 5: 3 });
  });
  test('在一段后面加（纯插入）：插入点之后的都往下挪，之前的不动', () => {
    const base = ['- TODO', '', '- TODO'].join('\n');
    const after = insertAfterLines(base, 1, '新的');
    assert.deepEqual(exactKeep(base, after, [singleRange(base, after, 2, 1)]), { 1: 1, 2: 4, 3: 5 });
  });
  test('patch 档几处改动（主进程的 changes）：各段之间的行按各自的差平移，被换掉的失效', () => {
    const base = ['- TODO', '', '甲', '', '- TODO', '', '乙'].join('\n');
    const res = applyPatch(base, [{ from: 1, to: 1, text: '' }, { from: 7, to: 7, text: '乙改\n乙加' }]);
    assert.equal(res.ok, true);
    const r = res as Extract<typeof res, { ok: true }>;
    const ranges = r.changes.map((c) => ({ oldFrom: c.oldFrom, oldTo: c.oldTo, newFrom: c.from, newTo: c.to }));
    const keep = exactKeep(base, r.text, ranges);
    assert.equal(keep[1], undefined, '被删的第一处 - TODO 失效');
    assert.equal(keep[5], 3, '第二处 - TODO 跟着挪');
    assert.equal(r.text.split('\n')[keep[5] - 1], '- TODO');
  });
  test('审查复现：exactKeep 在大文件上不能是平方级 —— 16000 行整段改写一次要很快', () => {
    const n = 16000;
    const base = Array.from({ length: n }, (_, i) => `第 ${i + 1} 行 ${'x'.repeat(4)}`).join('\n');
    /* 整段（几乎整份）都在改动范围里：第一行改了，其余照抄 —— 最坏情况 */
    const after = spliceLines(base, 1, n, ['改过的第一行', ...base.split('\n').slice(1)].join('\n'));
    const t0 = Date.now();
    const keep = exactKeep(base, after, [singleRange(base, after, 1, n)]);
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `用了 ${ms}ms`);
    assert.equal(keep[1], undefined);
    assert.equal(keep[2], 2);
    assert.equal(keep[n], n);
  });
  test('大文件、几千处不相邻的改动（patch 档）：同样很快，各段之间照样平移', () => {
    const n = 16000;
    const lines = Array.from({ length: n }, (_, i) => `行 ${i + 1}`);
    const base = lines.join('\n');
    const ranges: Array<{ oldFrom: number; oldTo: number; newFrom: number; newTo: number }> = [];
    const out: string[] = [];
    for (let i = 1; i <= n; i += 1) {
      if (i % 4 === 0) { ranges.push({ oldFrom: i, oldTo: i, newFrom: out.length + 1, newTo: out.length + 2 }); out.push(`改 ${i}`, `加 ${i}`); }
      else out.push(lines[i - 1]);
    }
    const t0 = Date.now();
    const keep = exactKeep(base, out.join('\n'), ranges);
    assert.ok(Date.now() - t0 < 1000, `用了 ${Date.now() - t0}ms`);
    assert.equal(keep[4], undefined);
    assert.equal(keep[5], 6);
    assert.equal(out[keep[n - 1] - 1], `行 ${n - 1}`);
  });
  test('范围给错了（外面那一行字面对不上）：认不出来，不硬挪', () => {
    const map = exactLineMap('a\nb\nc', 'a\nX\nc', []);
    assert.equal(map(2), null);
    assert.equal(map(3), 3);
  });
  test('ReviewPane：writeBack 优先按实际改动范围算行号；七处写回都给了范围（patch 档用主进程的 changes）', () => {
    assert.ok(RV.includes('const edited = opts.edited ?? (opts.ai ? trustedChanges(opts.ai.changes, base, fullText)?.map((c) => ({ oldFrom: c.origFrom, oldTo: c.origTo, newFrom: c.from, newTo: c.to })) : undefined);'));
    assert.ok(RV.includes('? { keep: exactKeep(base, fullText, edited) }'));
    assert.equal((RV.match(/edited: \[singleRange\(/g) || []).length, 7, '撤销、＋（两处）、💬（两处）、✎、✕');
  });
  test('ReviewPane：三处（💬/＋、✎、✕）开跑时先看 lost —— 是就当冲突，不再按原文找', () => {
    assert.equal((RV.match(/const at = reviewItemLost\(ticket\) \? null : locateBlock\(base, anchorText, near\);/g) || []).length, 3);
  });
  test('ReviewPane：排队的那条开跑时用队列里此刻的行号去找、放回标记也放在此刻那一行', () => {
    assert.ok(RV.includes('const near = reviewItemLine(ticket) ?? anchor;'));
    assert.equal((RV.match(/locateBlock\(base, anchorText, near\)/g) || []).length, 3, '💬/＋、✎、✕ 三处');
    assert.ok(RV.includes('const restoreAt = (ticket: string) => reviewItemLine(ticket) ?? anchor;'));
    assert.ok(RV.includes('const k = liveMarkKey(j);'), '没写完的那些存盘时也按此刻的行号存');
  });
  test('同一段连续改两次（同一轮）：第二次基于第一次的结果，两次都在', () => {
    const base = ['甲。', '', '乙。'].join('\n');
    const v1 = spliceLines(base, 1, 1, '甲改。');
    const at = locateBlock(v1, '甲改。', 1)!;
    const v2 = spliceLines(v1, at.from, at.to, '甲再改。');
    assert.equal(v2, '甲再改。\n\n乙。');
  });
  test('整节 comment 跑着、节里另一行在排队：轮到它时按最新正文找；那一行被整节改掉了就不改（放回意见）', () => {
    const base = ['# 节', '', '- 甲', '- 乙', '', '# 下一节'].join('\n');
    const v1 = spliceLines(base, 1, 4, '# 节\n\n- 甲改\n- 乙');
    assert.equal(locateBlock(v1, '- 甲', 3), null);
    assert.deepEqual(locateBlock(v1, '- 乙', 4), { from: 4, to: 4, anchor: 4 });
  });
  test('撤销其中一条再撤另一条（两种顺序）：最终回到原文，别的修改不丢', async () => {
    const { getAiMarks, aiRoundOf, beginAiRound, recordAiWrite } = await import('../src/renderer/aiMarkStore.ts');
    const base = ['# T', '', '甲。', '', '乙。', '', '丙。'].join('\n');
    const ai = base.replace('甲。', '甲改。\n甲加一行。').replace('丙。', '丙改。');
    /* 外人（或你自己）另外改了第 5 行 —— 两次撤销都不能把它带走 */
    for (const order of [[0, 1], [1, 0]]) {
      const P = `undo-order-${order.join('')}.md`;
      beginAiRound(P);
      recordAiWrite(P, { base, fullText: ai, fresh: diffChanges(base, ai).map((c, i) => ({ ...c, id: 10 + i })), round: aiRoundOf(P) });
      let disk = ai.replace('乙。', '乙（外面改的）。');
      for (const k of order) {
        const plan = planUndo(getAiMarks(P)!, 10 + k, disk);
        assert.equal(plan.ok, true, JSON.stringify(plan));
        const next = (plan as any).text as string;
        recordAiWrite(P, { base: disk, fullText: next, undid: 10 + k });
        disk = next;
      }
      assert.equal(disk, base.replace('乙。', '乙（外面改的）。'));
      assert.equal(getAiMarks(P), undefined, '两处都撤了，标记清空');
    }
  });
});

describe('场景 3 / 10：文件在 review 期间被外部改了 / 两个会话同时改它', () => {
  test('写回带 expectBase：盘上不是提交那一刻那一份就不写（不静默覆盖）', async () => {
    const state = { disk: '外面改过的' };
    const r = await writeTextVia({
      max: 1e6,
      read: async () => ({ size: state.disk.length, bytes: state.disk.length, text: state.disk }),
      backup: () => true,
      write: async (t) => { state.disk = t; },
    }, '拿旧底稿拼的整份', '提交时的底稿');
    assert.equal(r.ok, false);
    assert.equal(r.mismatch, true);
    assert.equal(state.disk, '外面改过的');
  });
  test('BUG：主进程发现盘上变了把结果交回渲染层时，渲染层那次写也必须带 expectBase', () => {
    /* 主进程那一侧（不变）：对不上就不写、把正文交回去 */
    assert.ok(MAIN.includes('if (!wrote?.ok && wrote?.mismatch) return { ok: true, text: out.text, scope: wantScope };'));
    /* 渲染层自己写的四处（＋、💬 的 block 回退、✎、✕）都带上它基于的那一份 */
    for (const what of ['Added a paragraph after {file} {where}', 'Revised {file} {where} as commented', 'Replaced {file} {where} with what you wrote', 'Deleted {file} {where}']) {
      const at = RV.indexOf(`t('${what}'`);
      assert.ok(at > 0, what);
      assert.match(RV.slice(at, at + 260), /\), false, \{ (ai: \{ round(, lost)? \}, )?expectBase: base, edited: \[singleRange\(/, what);
    }
    assert.equal((RV.match(/reviewWriteFile\?\.\(/g) || []).length, 1, '只有 writeBack 一处写盘');
  });
  test('BUG：写不进去（冲突 / 备份失败 / 文件没了）时意见放回去，不能连同标记一起丢', () => {
    assert.ok(RV.includes('const landed = (ok: boolean) => { if (!ok) livePane().typeDraft(failKey, instruction); return ok; };'));
    assert.ok(RV.includes("if (!ok) livePane().typeDraft(`=${at.anchor}`, replacement);"));
    assert.ok(RV.includes('if (!ok) livePane().setDropped((cur) => ({ ...cur, [at.anchor]: true }));'));
  });
  test('文件被删 / 改名：不新建，说清楚', () => {
    const at = MAIN.indexOf('const writeReviewFile = async');
    const body = MAIN.slice(at, at + 2500);
    assert.ok(body.includes("tr('This file cannot be read right now. KiroLex will not create it; check that the path is right first')"));
  });
  test('patch 档冲突：不写、不交回正文（不变）', () => {
    const res = settlePatchRevision({ replyText: '@@ 1-1 | a\nA\n@@ END', base: 'a', write: () => ({ ok: false, mismatch: true }) });
    assert.equal((res as any).conflict, true);
    assert.equal((res as any).fullText, undefined);
  });
});

describe('写盘：备份', () => {
  const at = (name: string, t: number) => ({ name, t });
  test('BUG：备份按文件各留最近 N 份 —— 改别的文件不能把这个文件的备份清掉', () => {
    const prefix = reviewBackupPrefix('/w/a.md');
    const other = reviewBackupPrefix('/w/b.md');
    const entries = [
      at(`${prefix}1`, 1),
      ...Array.from({ length: 13 }, (_, i) => at(`${other}${i + 10}`, 10 + i)),
    ];
    /* 刚写了 b 的第 13 份：只清 b 自己最老的那份，a 的唯一一份还在 */
    const gone = reviewBackupsToPrune(entries, '/w/b.md', 12);
    assert.deepEqual(gone, [`${other}10`]);
    assert.ok(!gone.includes(`${prefix}1`));
  });
  test('同名不同目录的两个文件不共用一份额度', () => {
    assert.notEqual(reviewBackupPrefix('/w/x/README.md'), reviewBackupPrefix('/w/y/README.md'));
    assert.ok(reviewBackupPrefix('/w/x/README.md').startsWith('README.md__'), '文件名还在最前面，翻目录时认得出来');
  });
  test('审查复现：Windows 长路径（反斜杠）—— 只取文件名，备份名不超过 255 字符；路径不同前缀就不同', () => {
    const dir = `C:\\Users\\me\\${'很长的目录名'.repeat(20)}\\${'sub'.repeat(30)}`;
    const win = `${dir}\\周报.md`;
    assert.ok(win.length > 200);
    const p = reviewBackupPrefix(win);
    assert.match(p, /^_\.md__[0-9a-f]{8}__$/, '中文文件名清洗成 _，后面是指纹');
    assert.ok(!p.includes('Users'), `不该把整条路径当文件名：${p}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    assert.ok((p + stamp).length <= 255, `${(p + stamp).length}`);
    assert.notEqual(p, reviewBackupPrefix(`${dir}\\other\\周报.md`));
    assert.equal(reviewBackupPrefix('C:\\w\\a.md').slice(0, 6), 'a.md__');
  });
  test('文件名本身很长：截短，靠指纹区分', () => {
    const long = `/w/${'x'.repeat(300)}.md`;
    const p = reviewBackupPrefix(long);
    assert.ok(p.length <= 100 + 12, `${p.length}`);
    assert.notEqual(p, reviewBackupPrefix(`/w/${'x'.repeat(300)}.txt`));
  });
  test('自己这份文件超过 N 份：清掉最老的那几份', () => {
    const p = reviewBackupPrefix('/w/a.md');
    const entries = Array.from({ length: 14 }, (_, i) => at(`${p}${i}`, i));
    assert.deepEqual(reviewBackupsToPrune(entries, '/w/a.md', 12), [`${p}1`, `${p}0`]);
  });
  test('主进程按这一套命名、清理', () => {
    const at2 = MAIN.indexOf('const saveReviewBackup = ');
    const body = MAIN.slice(at2, at2 + 1500);
    assert.ok(body.includes('reviewBackupPrefix(want)'));
    assert.ok(body.includes('reviewBackupsToPrune('));
  });
});

describe('session:note：会话已经删了就不写', () => {
  test('BUG：删掉的会话（或盘上没记录的）不再往里追加 —— 否则会在 sessions/ 下重新长出一个目录', () => {
    const at = MAIN.indexOf('function noteInSession(');
    const body = MAIN.slice(at, at + 600);
    assert.ok(body.includes('if (deletedSessionIds.has(sid) || !store.readRecord(sid)) return false;'));
  });
});

describe('场景 9：PDF / PPT', () => {
  test('BUG：改一页幻灯片文字 —— 等回复期间 pptx 被改过就不按旧地址写', () => {
    const at = MAIN.indexOf("ipcMain.handle('deck:revise-slide-text'");
    const body = MAIN.slice(at, at + 6000);
    const stamp = body.indexOf('const stampBefore = deckStamp(want);');
    const ask = body.indexOf('await askOnce(sid, prompt');
    const check = body.indexOf('if (deckStamp(want) !== stampBefore) return deckChanged(want, page);');
    const write = body.indexOf('await writeSlideText(want, page, got.edits)');
    assert.ok(stamp > 0 && stamp < ask && ask < check && check < write, '读之前记、写之前比');
    assert.ok(body.includes('if (deckStamp(want) !== stampBefore) return deckChanged(want, page);'));
    const helper = MAIN.slice(MAIN.indexOf('const deckChanged = '), MAIN.indexOf('const deckChanged = ') + 400);
    assert.ok(helper.includes('conflict: true'), '冲突时不写、说清楚');
  });
  test('BUG：改一页讲稿 —— 带上改之前那一份，盘上这页讲稿已经变了就不写', () => {
    assert.ok(PRE.includes("deckWriteNote: (sessionId: string | null | undefined, filePath: string, page: number, text: string, expect?: string) =>"));
    assert.ok(PRE.includes("ipcRenderer.invoke('deck:write-note', sessionId, filePath, page, text, expect)"));
    assert.ok(APP.includes('deckWriteNote?: (sessionId: string | null | undefined, filePath: string, page: number, text: string, expect?: string)'));
    assert.ok(RV.includes('window.kiroApi.deckWriteNote?.(sessionId, path, page, res.text, expectNote)'));
    assert.ok(RV.includes('const expectNote = Array.isArray(notes) ? before : undefined;'), '没读到讲稿就不核对');
    const at = MAIN.indexOf("ipcMain.handle('deck:write-note'");
    const body = MAIN.slice(at, at + 2500);
    const check = body.indexOf('if (typeof expect === \'string\')');
    const backup = body.indexOf('const bad = backupDeck(want);');
    assert.ok(check > 0 && check < backup, '先核对、再备份、再写');
    assert.ok(body.includes('noteChanged(now, at, expect)'));
  });
  test('讲稿核对的判据：去掉首尾空白再比（和抽备注那段 python 的 strip 一致）', async () => {
    const { noteChanged } = await import('../src/main/deckPreview.ts');
    assert.equal(noteChanged(['甲', '乙'], 2, '乙\n'), false);
    assert.equal(noteChanged(['甲', '乙（外面改过）'], 2, '乙'), true);
    assert.equal(noteChanged(null, 2, '乙'), false, '读不到就不拦（写的那一步自己会报错）');
    assert.equal(noteChanged(['甲'], 2, ''), false, '这一页原来就没有备注');
  });
  test('写 pptx 前二进制备份、备份不成不写（不变）', () => {
    assert.match(MAIN, /if \(!saveReviewBackup\(want, fs\.readFileSync\(want\)\)\) \{/);
  });
  test('审查复现：交给会话改（PDF / 不能当场改的 deck）—— 备份慢时等它回来才发', async () => {
    const order: string[] = [];
    let finish!: (v: { ok: boolean }) => void;
    const p = backupThenSend(
      () => new Promise((r) => { order.push('backup-start'); finish = (v) => { order.push('backup-done'); r(v); }; }),
      () => order.push('send'),
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, ['backup-start'], '备份没回来之前一个字都不发');
    finish({ ok: true });
    assert.deepEqual(await p, { ok: true });
    assert.deepEqual(order, ['backup-start', 'backup-done', 'send']);
  });
  test('备份失败 / 抛错 / 没有备份通道：不发，把原因交回去', async () => {
    let sent = 0;
    assert.deepEqual(await backupThenSend(async () => ({ ok: false, error: '磁盘满了' }), () => { sent++; }), { ok: false, why: '磁盘满了' });
    assert.deepEqual(await backupThenSend(async () => { throw new Error('ssh 断了'); }, () => { sent++; }), { ok: false, why: 'ssh 断了' });
    assert.equal((await backupThenSend(() => undefined, () => { sent++; })).ok, false);
    assert.equal(sent, 0);
  });
  test('审查复现：慢备份期间改了 / 新写了意见 —— 备份成功后只清发出去的那一批，等待期间的留着', async () => {
    /* 模拟 submitAll 的 deck 那一批：提交时的快照 → 慢备份 → 期间编辑 → 成功后 clearSent */
    let drafts: Record<string, string> = { '1': '第 1 页改标题', 'note:2': '讲稿精简', '+3': '加一页总结' };
    let dropped: Record<string, true> = { '4': true };
    let whole = '整份口径统一';
    const sentDrafts = { ...drafts };
    const sentDrops = { ...dropped };
    const sentWhole = whole;
    let finish!: () => void;
    const gate = createSubmitGate();
    const sent = gate.run(() => backupThenSend(() => new Promise((r) => { finish = () => r({ ok: true }); }), () => {}));
    /* 等备份的时候：改了第 1 页那条、新写了第 5 页、整篇那框也改了、又标删了第 6 页 */
    drafts = { ...drafts, '1': '第 1 页改标题，并且换图', '5': '第 5 页太密' };
    dropped = { ...dropped, '6': true };
    whole = '整份口径统一，另外缩短到 10 页';
    finish();
    assert.deepEqual(await sent, { ok: true });
    drafts = clearSent(drafts, sentDrafts);
    dropped = clearSent(dropped, sentDrops);
    whole = whole === sentWhole ? '' : whole;
    assert.deepEqual(drafts, { '1': '第 1 页改标题，并且换图', '5': '第 5 页太密' }, '没改过的那几条清掉，改过的和新写的留着');
    assert.deepEqual(dropped, { '6': true });
    assert.equal(whole, '整份口径统一，另外缩短到 10 页');
  });
  test('审查复现：框里点「✓ 确认」→ 提交 → 慢备份期间重新打开同一页改了意见 → 备份成功：改过的那份还在', async () => {
    /* 这一页草稿的唯一真相（ReviewPane 的 draftLive）；框是受控的，框的 setDraft 就是写它 */
    let drafts: Record<string, string> = { '1': '第 1 页改标题' };
    const boxSetDraft = (next: string) => { drafts = { ...drafts, '1': next }; };
    let finish!: () => void;
    const gate = createSubmitGate();
    /* submitAll 的 deck 那一批：记快照 → 门 → 等备份 → 成功后按快照清（clearHanded） */
    const submitAll = (): Promise<boolean> => {
      const sentDrafts = { ...drafts };
      const sent = gate.run(() => backupThenSend(() => new Promise((r) => { finish = () => r({ ok: true }); }), () => {})).then((r) => !!r?.ok);
      void sent.then((ok) => { if (ok) drafts = clearSent(drafts, sentDrafts); });
      return sent;
    };
    /* 旧那个框点了「✓ 确认」—— 走的是 CommentBox 自己的那段（applyDraft）和 ReviewPane 给它的 onApply */
    const boxDone = applyDraft(drafts['1'], () => submitFromBox(submitAll), boxSetDraft);
    /* 等备份的时候，你重新打开第 1 页的框、改了意见（新框写的是同一个键） */
    drafts = { ...drafts, '1': '第 1 页改标题，并且换一张图' };
    finish();
    await boxDone;
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(drafts['1'], '第 1 页改标题，并且换一张图', '旧框的回调和快照清理都不能清掉它');
  });
  test('同一条链路、等待期间没改：备份成功后那条照常清掉（不会一直留着被再发一遍）', async () => {
    let drafts: Record<string, string> = { '1': '第 1 页改标题' };
    let finish!: () => void;
    const submitAll = (): Promise<boolean> => {
      const sentDrafts = { ...drafts };
      const sent = backupThenSend(() => new Promise((r) => { finish = () => r({ ok: true }); }), () => {}).then((r) => r.ok);
      void sent.then((ok) => { if (ok) drafts = clearSent(drafts, sentDrafts); });
      return sent;
    };
    const boxDone = applyDraft(drafts['1'], () => submitFromBox(submitAll), (next) => { drafts = { ...drafts, '1': next }; });
    finish();
    await boxDone;
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(drafts['1'], undefined);
  });
  test('框只管提交、不自己清：submitFromBox 永远告诉框"别清"；CommentBox 用的就是 applyDraft；ReviewPane 两个框都走它', async () => {
    let cleared = 0;
    await applyDraft('x', () => submitFromBox(() => true), () => { cleared++; });
    assert.equal(cleared, 0);
    await applyDraft('x', () => true, () => { cleared++; });
    assert.equal(cleared, 1, '别处（门上那些框）照旧：成功了就清');
    const CBX = read('src/renderer/components/CommentBox.tsx');
    assert.ok(CBX.includes('const apply = () => { void applyDraft(draft, onApply, setDraft, applyWhenEmpty); };'));
    assert.equal((RV.match(/onApply=\{\(\) => submitFromBox\(submitAll\)\}/g) || []).length, 2);
    assert.ok(!RV.includes('onApply={() => submitAll()}'));
  });
  test('等备份时再点提交：同一批不会发第二遍（门关着时 run 直接返回 null、不执行）', async () => {
    const gate = createSubmitGate();
    let sends = 0;
    let finish!: () => void;
    const first = gate.run(() => backupThenSend(() => new Promise((r) => { finish = () => r({ ok: true }); }), () => { sends++; }));
    assert.equal(gate.busy, true);
    assert.equal(await gate.run(async () => { sends++; return { ok: true }; }), null);
    finish();
    await first;
    assert.equal(sends, 1);
    assert.equal(gate.busy, false, '发完了门就开，下一批可以照常提交');
    assert.notEqual(await gate.run(async () => 'next'), null);
  });
  test('clearSent：键不在快照里 / 值变了都不清；什么都没清时原样返回同一个对象', () => {
    const cur = { a: '1', b: '2' };
    assert.equal(clearSent(cur, { c: '3' }), cur);
    assert.deepEqual(clearSent(cur, { a: '1', b: 'x' }), { b: '2' });
  });
  test('ReviewPane：整批交给会话前先看门、记快照；成功后按快照清；等待时说一句', () => {
    assert.ok(RV.includes('if (handoffGateFor(path).busy) return false;'));
    assert.ok(RV.includes('const sentDrafts: Record<string, string> = Object.fromEntries(handedKeys.map((k) => [k, draftLive[k]]));'));
    assert.ok(RV.includes('livePane().setDraftLive((cur) => clearSent(cur, sentDrafts));'));
    assert.ok(RV.includes('livePane().setWholeDraft((cur) => (cur === sentWhole ? \'\' : cur));'));
    assert.ok(RV.includes('const sent = handoffGateFor(path).run(send).then((ok) => !!ok);'));
    assert.ok(RV.includes("t('Backing up this file before sending it to the session…')"));
    const deck = RV.slice(RV.indexOf('if (handoffGateFor(path).busy) return false;'), RV.indexOf('const lockedLines = new Set<number>();'));
    assert.ok(deck.length > 0);
    assert.ok(!deck.includes('setDropped({})') && !deck.includes("setWholeDraft('')") && !deck.includes('setMarkOrder({})'), 'deck 那批不再无条件清空');
  });
  test('ReviewPane：sendToSession 走 backupThenSend；没发出去时标记留着、意见放回去', () => {
    assert.ok(RV.includes('const r = await backupThenSend(() => window.kiroApi.reviewBackupFile?.(sessionId, path), () => onSubmit(message));'));
    assert.ok(RV.includes('void sent.then((ok) => { if (ok) clearHanded(); }).finally(() => setHandingOff(false));'), '整批交给会话的那些：发出去了才清标记');
    assert.match(RV, /return sent;\n {4}\}\n {4}clearHanded\(\);/, '框里的「✓ 确认」等发没发出去再决定清不清它那份草稿');
    assert.ok(RV.includes('const submitAll = (): boolean | Promise<boolean> => {'));
    assert.ok(!/handOff\.push\([^\n]*clearDraft/.test(RV), '不在发之前清');
    assert.ok(RV.includes('if (!sent) livePane().typeDraft(String(page), instruction);'), '当场改不了、退回给会话的那一页：没发出去就放回意见');
    assert.ok(RV.includes("so nothing was sent to the session. Your marks are still here"));
  });
});

describe('场景 8：远程会话的文件', () => {
  test('远端文件写回走 ssh、备份存本机；读回来不完整就不写（不变）', async () => {
    const state = { disk: 'abc' };
    const r = await writeTextVia({
      max: 1e6,
      read: async () => ({ size: 10, bytes: 3, text: state.disk }),
      backup: () => true,
      write: async (t) => { state.disk = t; },
    }, 'xyz', 'abc');
    assert.equal(r.ok, false);
    assert.equal(state.disk, 'abc');
    assert.ok(MAIN.includes('if (t.remote) return writeRemoteReviewFile(sessionId, t.remote, t.want, text, expectBase);'));
    assert.ok(MAIN.includes('backup: (prev) => !!saveReviewBackup(want, prev),'));
  });
});

describe('lostFields 在 CRLF 下照样认字段', () => {
  test('原文 CRLF、回复 LF：没删的字段不报', () => {
    assert.deepEqual(lostFields('- **进展**: a\r\n- **风险**: b\r\n', '- **进展**: A\n- **风险**: B'), []);
  });
});
