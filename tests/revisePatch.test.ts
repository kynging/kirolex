import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePatchReply, settlePatchRevision, patchFollowUp, reviseInSessionPrompt } from '../src/main/reviseBlock.ts';
import { applyPatch, patchReplyOutcome, sliceLines } from '../src/main/reviewApply.ts';

/**
 * 侧栏 comment 的 `patch` 档：模型只交回要换的那几处（`@@ 起-止 | 开头` + 新内容 + `@@ END`），
 * KiroLex 一次拼进 base。不整篇重写 —— 长文件整篇重写会撞上 8 分钟超时。
 */

const BASE = [
  '# 周报',        // 1
  '',              // 2
  '本周完成了 A。', // 3
  '',              // 4
  '下周计划做 B。', // 5
  '',              // 6
  '## 风险',       // 7
  '',              // 8
  '- 人手不够',    // 9
  '- 时间紧',      // 10
].join('\n');

describe('parsePatchReply', () => {
  test('单块：起止行、核对字、新内容', () => {
    const r = parsePatchReply('@@ 3-3 | 本周完成\n本周完成了 A 和 C。\n@@ END');
    assert.deepEqual(r, { edits: [{ from: 3, to: 3, hint: '本周完成', text: '本周完成了 A 和 C。' }] });
  });

  test('多块、新内容可以多行、首尾空行去掉', () => {
    const r = parsePatchReply('@@ 3-5 | 本周\n\n本周完成了 A，下周做 B。\n第二行\n\n@@ END\n\n@@ 9-10 | 人手\n- 人手和时间都紧\n@@ END');
    assert.equal(r.error, undefined);
    assert.deepEqual(r.edits.map((e) => [e.from, e.to, e.text]), [
      [3, 5, '本周完成了 A，下周做 B。\n第二行'],
      [9, 10, '- 人手和时间都紧'],
    ]);
  });

  test('格式上的小偏差都认：@@@、REPLACE、L/第…行、全角分隔符、「」、省略号、漏写 END、外层围栏、开场白', () => {
    const reply = [
      '```',
      '好的，改动如下：',
      '@@@ REPLACE L3–L5 @@@ ｜「本周完成…」',
      '合并后的一段',
      '@@ 第9行到第10行：- 人手',
      '- 一条',
      '@@结束',
      '@@ 7',
      '## 风险与对策',
      '```',
    ].join('\n');
    const r = parsePatchReply(reply);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.edits, [
      { from: 3, to: 5, hint: '本周完成', text: '合并后的一段' },
      { from: 9, to: 10, hint: '- 人手', text: '- 一条' },
      { from: 7, to: 7, text: '## 风险与对策' },
    ]);
  });

  test('<DELETE> 是删掉；空块不能当删掉 —— 报错', () => {
    assert.deepEqual(parsePatchReply('@@ 9-9 | 人手\n<DELETE>\n@@ END').edits, [{ from: 9, to: 9, hint: '人手', text: '' }]);
    const r = parsePatchReply('@@ 9-9 | 人手\n\n@@ END');
    assert.deepEqual(r.edits, []);
    assert.match(r.error!, /没有给新内容/);
  });

  test('一块都没有 → 报错；说改不了 → cannot', () => {
    assert.match(parsePatchReply('我觉得这样挺好').error!, /没有给出可用的改动/);
    assert.deepEqual(parsePatchReply('CANNOT-REVISE-LOCALLY: 要查客户名单'), { edits: [], cannot: '要查客户名单' });
  });
});

describe('applyPatch', () => {
  test('单段替换', () => {
    const r = applyPatch(BASE, [{ from: 3, to: 3, hint: '本周完成', text: '本周完成了 A 和 C。' }]);
    assert.ok(r.ok);
    assert.equal(r.text, BASE.replace('本周完成了 A。', '本周完成了 A 和 C。'));
    assert.deepEqual(r.changes, [{ from: 3, to: 3, oldFrom: 3, oldTo: 3, oldText: '本周完成了 A。', newText: '本周完成了 A 和 C。' }]);
  });

  test('两段合并成一段：一块新内容换掉两段的行范围', () => {
    const r = applyPatch(BASE, [{ from: 3, to: 5, hint: '本周', text: '本周完成了 A，下周计划做 B。' }]);
    assert.ok(r.ok);
    assert.equal(r.text, ['# 周报', '', '本周完成了 A，下周计划做 B。', '', '## 风险', '', '- 人手不够', '- 时间紧'].join('\n'));
    assert.deepEqual(r.changes, [{
      from: 3, to: 3, oldFrom: 3, oldTo: 5,
      oldText: '本周完成了 A。\n\n下周计划做 B。', newText: '本周完成了 A，下周计划做 B。',
    }]);
  });

  test('范围连着段后的空行、新内容不带空行：空行按原文补回去，不和下一段粘住', () => {
    const r = applyPatch(BASE, [{ from: 3, to: 4, text: '新的一段' }]);
    assert.ok(r.ok);
    assert.equal(sliceLines(r.text, 3, 5), '新的一段\n\n下周计划做 B。');
  });

  test('不相邻的多段同时改：行号按原文给，新行号随前面的增减挪', () => {
    const r = applyPatch(BASE, [
      /* 故意乱序给 —— 按行号排 */
      { from: 9, to: 10, hint: '- 人手', text: '- 人手和时间都紧' },
      { from: 3, to: 3, hint: '本周', text: '本周完成了 A。\n\n另外修了 C。' },
      { from: 1, to: 1, hint: '周报', text: '# 第 35 周周报' },
    ]);
    assert.ok(r.ok);
    assert.equal(r.text, [
      '# 第 35 周周报', '', '本周完成了 A。', '', '另外修了 C。', '', '下周计划做 B。', '', '## 风险', '', '- 人手和时间都紧',
    ].join('\n'));
    assert.deepEqual(r.changes.map((c) => [c.from, c.to, c.oldFrom, c.oldTo]), [[1, 1, 1, 1], [3, 5, 3, 3], [11, 11, 9, 10]]);
    /* 新范围在新文件里取出来就是新内容；原文在原文件里取出来就是 oldText */
    for (const c of r.changes) {
      assert.equal(sliceLines(r.text, c.from, c.to), c.newText);
      assert.equal(sliceLines(BASE, c.oldFrom, c.oldTo), c.oldText);
    }
  });

  test('删掉一段：接缝两边的空行收成一行，新范围是空的（to = from - 1）', () => {
    const r = applyPatch(BASE, [{ from: 5, to: 5, hint: '下周', text: '' }]);
    assert.ok(r.ok);
    assert.equal(r.text, ['# 周报', '', '本周完成了 A。', '', '## 风险', '', '- 人手不够', '- 时间紧'].join('\n'));
    assert.deepEqual(r.changes, [{ from: 5, to: 4, oldFrom: 5, oldTo: 6, oldText: '下周计划做 B。\n', newText: '' }]);
  });

  test('行号越界被拒（超过最后一行 / 从 0 起 / 起大于止）', () => {
    for (const e of [{ from: 9, to: 11 }, { from: 0, to: 2 }, { from: 5, to: 3 }]) {
      const r = applyPatch(BASE, [{ ...e, text: 'x' }]);
      assert.equal(r.ok, false);
      assert.match((r as any).why, /超出了文件|不成立/);
    }
    assert.match((applyPatch(BASE, [{ from: 9, to: 11, text: 'x' }]) as any).why, /一共只有 10 行/);
  });

  test('范围重叠被拒', () => {
    const r = applyPatch(BASE, [{ from: 3, to: 5, text: 'x' }, { from: 5, to: 7, text: 'y' }]);
    assert.equal(r.ok, false);
    assert.match((r as any).why, /重叠/);
  });

  test('核对原文对不上被拒（数错了行）；核对时不管空白和 markdown 记号', () => {
    const r = applyPatch(BASE, [{ from: 5, to: 5, hint: '本周完成', text: 'x' }]);
    assert.equal(r.ok, false);
    assert.match((r as any).why, /第 5 行对不上[\s\S]*下周计划做 B/);
    assert.ok(applyPatch(BASE, [{ from: 7, to: 7, hint: '## 风险', text: '## 风险与对策' }]).ok);
    assert.ok(applyPatch(BASE, [{ from: 7, to: 7, hint: '风险', text: '## 风险与对策' }]).ok);
    assert.ok(applyPatch(BASE, [{ from: 9, to: 9, hint: '人手 不够', text: '- 缺人' }]).ok);
  });

  test('拒绝时一处都不拼：好的那几处也不写（文件不会"改了一半"）', () => {
    const r = applyPatch(BASE, [
      { from: 1, to: 1, hint: '周报', text: '# 改好的标题' },
      { from: 9, to: 9, hint: '不存在的字', text: 'x' },
    ]);
    assert.equal(r.ok, false);
    assert.equal((r as any).text, undefined, '拒绝时不交回任何正文');
  });

  test('没有要改的地方 → 拒绝', () => {
    assert.equal(applyPatch(BASE, []).ok, false);
  });
});

describe('解析 + 拼回连起来：用户遇到的那次「把这段和下一段合并」', () => {
  test('回复里只有一处，拼回后其余行逐字不变', () => {
    const parsed = parsePatchReply('@@ 3-5 | 本周完成了\n本周完成了 A，下周计划做 B。\n@@ END');
    const r = applyPatch(BASE, parsed.edits);
    assert.ok(r.ok);
    assert.equal(sliceLines(r.text, 1, 2), sliceLines(BASE, 1, 2));
    assert.equal(sliceLines(r.text, 4, 8), sliceLines(BASE, 6, 10));
  });
});

/**
 * 写盘那一步：照 `writeReviewFile` 的判据（盘上不是 expectBase 就 mismatch、不写）对一个真文件写，记下写了几次。
 * 判据和主进程那份是同一套 —— 下面另有一条断言主进程确实把 expectBase 传进了 `writeReviewFile`。
 */
function diskWriter(file: string) {
  const calls: Array<{ text: string; expectBase?: string }> = [];
  const write = (text: string, expectBase?: string) => {
    calls.push({ text, expectBase });
    const previous = fs.readFileSync(file, 'utf8');
    if (typeof expectBase === 'string' && previous !== expectBase) {
      return { ok: false, mismatch: true, error: '这份文件在改写期间被别的改动动过了' };
    }
    fs.writeFileSync(file, text, 'utf8');
    return { ok: true, path: file };
  };
  return { calls, write };
}

describe('完整调用链：等回复期间文件被别的改动动过 → 不写、不交回正文、界面不再写第二次', () => {
  const REPLY = '@@ 3-5 | 本周完成了\n本周完成了 A，下周计划做 B。\n@@ END';
  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-patch-'));
    const file = path.join(dir, 'a.md');
    fs.writeFileSync(file, BASE, 'utf8');
    return file;
  };

  test('正常：主进程写一次、带 expectBase，结果 written + changes，界面只刷新', () => {
    const file = tmp();
    const disk = diskWriter(file);
    const res = settlePatchRevision({ replyText: REPLY, base: BASE, write: disk.write });
    assert.equal(res.ok, true);
    assert.equal((res as any).written, true);
    assert.equal((res as any).changes.length, 1);
    assert.deepEqual(disk.calls.map((c) => c.expectBase), [BASE]);
    assert.equal(fs.readFileSync(file, 'utf8'), (res as any).fullText);
    const out = patchReplyOutcome(res);
    assert.deepEqual(out, { kind: 'done', fullText: (res as any).fullText });
  });

  test('冲突：返回 ok:false + conflict，不带正文；只写了那一次（被拒），文件保持别人改过的样子', () => {
    const file = tmp();
    /* 等回复的那几分钟里，别的改动把文件改了 */
    const changedMeanwhile = BASE.replace('- 时间紧', '- 时间紧\n- 新加的一条');
    fs.writeFileSync(file, changedMeanwhile, 'utf8');
    const disk = diskWriter(file);
    const res = settlePatchRevision({ replyText: REPLY, base: BASE, write: disk.write });
    assert.equal(res.ok, false);
    assert.equal((res as any).conflict, true);
    assert.match((res as any).error, /被别的改动动过了[\s\S]*刷新/);
    assert.equal((res as any).fullText, undefined, '不交回正文 —— 界面没有东西可以拿去覆盖');
    assert.equal((res as any).text, undefined);
    /* 界面那一步：只会失败、把意见放回去，不会再调写盘 */
    const out = patchReplyOutcome(res);
    assert.equal(out.kind, 'fail');
    assert.match((out as any).why, /被别的改动动过了/);
    assert.equal(disk.calls.length, 1, '没有第二次写盘');
    assert.equal(fs.readFileSync(file, 'utf8'), changedMeanwhile, '文件保持原样');
  });

  test('拒绝（行号越界 / 重叠 / 核对不上）时根本不调写盘，文件不变', () => {
    for (const reply of [
      '@@ 9-12 | 人手\nx\n@@ END',
      '@@ 3-5 | 本周\nx\n@@ END\n@@ 5-7 | 下周\ny\n@@ END',
      '@@ 5-5 | 本周完成\nx\n@@ END',
    ]) {
      const file = tmp();
      const disk = diskWriter(file);
      const res = settlePatchRevision({ replyText: reply, base: BASE, write: disk.write });
      assert.equal(res.ok, false);
      assert.equal(disk.calls.length, 0);
      assert.equal(fs.readFileSync(file, 'utf8'), BASE);
      assert.equal(patchReplyOutcome(res).kind, 'fail');
    }
  });

  test('合法块 + 负数行号的块混在一起：整轮失败、写盘零次、文件不变（不能只改合法的那一处）', () => {
    for (const reply of [
      '@@ 1-1 | 周报\n# 第 35 周周报\n@@ END\n@@ -1-2 | 周报\nx\n@@ END',
      '@@ 1-1 | 周报\n# 第 35 周周报\n@@ END\n@@ -3 | x\nx\n@@ END',
      '@@ 1-1 | 周报\n# 第 35 周周报\n@@ END\n@@ 3--1\nx\n@@ END',
      '@@ 1-1 | 周报\n# 第 35 周周报\n@@ END\n@@ L−2–L4\nx\n@@ END',
    ]) {
      const file = tmp();
      const disk = diskWriter(file);
      const res = settlePatchRevision({ replyText: reply, base: BASE, write: disk.write });
      assert.equal(res.ok, false, reply);
      assert.match((res as any).error, /不成立|看不懂/, reply);
      assert.equal(disk.calls.length, 0, reply);
      assert.equal(fs.readFileSync(file, 'utf8'), BASE, reply);
      assert.equal(patchReplyOutcome(res).kind, 'fail');
    }
  });

  test('认不出的块头（行首 @@ 却没有行号）整轮报错，不当成正文、也不静默丢掉', () => {
    for (const reply of [
      '@@ 1-1 | 周报\n# 第 35 周周报\n@@ END\n@@ 第三段 | 本周\nx\n@@ END',
      '@@ 1-1 | 周报\n# 第 35 周周报\n@@ ?-? \nx\n@@ END',
      '@@ abc\nx\n@@ END',
    ]) {
      const r = parsePatchReply(reply);
      assert.deepEqual(r.edits, [], reply);
      assert.match(r.error!, /块头看不懂/, reply);
      const file = tmp();
      const disk = diskWriter(file);
      assert.equal(settlePatchRevision({ replyText: reply, base: BASE, write: disk.write }).ok, false);
      assert.equal(disk.calls.length, 0);
      assert.equal(fs.readFileSync(file, 'utf8'), BASE);
    }
  });

  test('负数行号被解析成负数（交给范围校验），不被吞成别的范围', () => {
    assert.deepEqual(parsePatchReply('@@ -1-2 | x\ny\n@@ END').edits.map((e) => [e.from, e.to]), [[-1, 2]]);
    assert.deepEqual(parsePatchReply('@@ 3--1\ny').edits.map((e) => [e.from, e.to]), [[3, -1]]);
    assert.deepEqual(parsePatchReply('@@ 3 - 5\ny').edits.map((e) => [e.from, e.to]), [[3, 5]], '空格隔开的减号还是分隔符');
  });

  test('界面只认主进程写过的：没 written 的成功结果、旧主进程的结果都当失败', () => {
    assert.equal(patchReplyOutcome({ ok: true, scope: 'patch', text: 'x', fullText: 'x', changes: [] }).kind, 'fail');
    assert.match((patchReplyOutcome({ ok: true, scope: 'block', text: 'x' }) as any).why, /旧版本/);
    assert.equal(patchReplyOutcome({ ok: false, cancelled: true }).kind, 'cancelled');
    assert.match((patchReplyOutcome({ ok: false, cannot: '要查外部系统' }) as any).why, /改不了：要查外部系统/);
  });
});

describe('主进程 / 界面接线', () => {
  const M = fs.readFileSync('src/main/index.ts', 'utf8');
  const RV = fs.readFileSync('src/renderer/components/ReviewPane.tsx', 'utf8');
  test('finishPatch 走 settlePatchRevision，写盘带 expectBase，不再把 mismatch 当成功', () => {
    const at = M.indexOf('async function finishPatch(');
    assert.ok(at > 0);
    const body = M.slice(at, M.indexOf('\n    }\n', at));
    assert.match(body, /settlePatchRevision\(\{/);
    /* 写盘是异步的（远端走 ssh）：先拼，再写、按 patchWritten 收 —— expectBase 是同一份 base */
    assert.match(body, /patchWritten\(settled, await writeReviewFile\(sessionId, apply!\.path, settled\.fullText, base\)\)/);
    assert.doesNotMatch(body, /mismatch/);
    assert.doesNotMatch(M, /mismatch\) return \{ ok: true, text: fullText/);
  });
  test('返回值里带 changes（新范围、原文、原范围），冲突写在注释里', () => {
    assert.match(M, /`changes: PatchChange\[\]`/);
    assert.match(M, /\{ ok: false, conflict: true, error \}/);
  });
  test('界面的两处 patch 都经 patchReplyOutcome，成功只刷新（alreadyWritten），不自己写', () => {
    assert.equal((RV.match(/const out = patchReplyOutcome\(res, lang\);/g) || []).length, 2);
    /* 末尾带上「AI 刚改过」要的改动列表和轮次（见 `aiChanges.ts`）—— 照样是 alreadyWritten，不自己写 */
    assert.match(RV, /return writeBack\(base, out\.fullText, failKey, '', true, \{ ai: \{ changes: res\.changes, round \} \}\);/);
    assert.match(RV, /return writeBack\(base, out\.fullText, 'whole', '', true, \{ ai: \{ changes: res\.changes, round \} \}\);/);
    assert.doesNotMatch(RV, /gotPatch/);
  });
  test('主进程不再认 whole 那一档', () => {
    assert.doesNotMatch(M, /input\?\.scope === 'whole'/);
  });
});

describe('格式不对时自动追问一次', () => {
  /* 用户遇到的那次：几块写得好好的改动 + 一块空的 `@@ 116-117`（本意是删掉，但没写 <DELETE>） */
  const BIG = Array.from({ length: 130 }, (_, i) => `第${i + 1}行原文`).join('\n');
  const GOOD = [
    '@@ 100-100 | 第100行',
    '新起的一段',
    '',
    '第100行原文',
    '@@ END',
    '@@ 110-112 | 第110行',
    '改写后的一段',
    '@@ END',
  ].join('\n');
  const FIRST = `${GOOD}\n@@ 116-117 | 第116行\n\n@@ END`;
  const SECOND = `${GOOD}\n@@ 116-117 | 第116行\n<DELETE>\n@@ END`;

  test('空块 → 追问：指出是哪几行、怎么改，要求整轮重交、行号按原来那份', () => {
    const p = patchFollowUp(parsePatchReply(FIRST));
    assert.ok(p);
    assert.match(p!, /第 116-117 行那一处是空的/);
    assert.match(p!, /只写一行 `?<DELETE>`?/);
    assert.match(p!, /不是要删就补上新内容/);
    assert.match(p!, /全部改动/);
    assert.match(p!, /行号.*最开始发给你的那份正文/);
    assert.match(p!, /@@ <起始行>-<结束行>/);
  });

  test('看不懂的块头 → 追问', () => {
    const p = patchFollowUp(parsePatchReply('@@ 第一段 | 本周\n新内容\n@@ END'));
    assert.ok(p);
    assert.match(p!, /块头看不懂/);
  });

  test('一块都没有 → 追问', () => {
    assert.ok(patchFollowUp(parsePatchReply('我觉得这样挺好')));
  });

  test('CANNOT-REVISE-LOCALLY / 格式正确 → 不追问', () => {
    assert.equal(patchFollowUp(parsePatchReply('CANNOT-REVISE-LOCALLY: 要查客户名单')), null);
    assert.equal(patchFollowUp(parsePatchReply('@@ 3-3 | 本周\n新\n@@ END')), null);
  });

  test('settle：格式错误第一次 → 不写、带 followUp；cannot / 越界 / 重叠 / 冲突 → 不带 followUp', () => {
    let writes = 0;
    const write = () => { writes++; return { ok: true }; };
    const r1 = settlePatchRevision({ replyText: FIRST, base: BIG, write }) as any;
    assert.equal(r1.ok, false);
    assert.equal(writes, 0);
    assert.match(r1.followUp, /第 116-117 行那一处是空的/);
    assert.equal((settlePatchRevision({ replyText: 'CANNOT-REVISE-LOCALLY: 缺', base: BIG, write }) as any).followUp, undefined);
    assert.equal((settlePatchRevision({ replyText: '@@ 999-999 | x\ny\n@@ END', base: BIG, write }) as any).followUp, undefined);
    assert.equal((settlePatchRevision({ replyText: '@@ 1-5 | 第1行\na\n@@ END\n@@ 3-4 | 第3行\nb\n@@ END', base: BIG, write }) as any).followUp, undefined);
    const c = settlePatchRevision({ replyText: SECOND, base: BIG, write: () => ({ ok: false, mismatch: true }) }) as any;
    assert.equal(c.conflict, true);
    assert.equal(c.followUp, undefined);
    assert.equal(writes, 0);
  });

  test('第一次格式错误但盘上文件已经被改过 → 不追问，直接报冲突、不写', () => {
    let writes = 0;
    let reads = 0;
    const r = settlePatchRevision({
      replyText: FIRST, base: BIG,
      onDisk: () => { reads++; return `${BIG}\n别人刚加的一行`; },
      write: () => { writes++; return { ok: true }; },
    }) as any;
    assert.equal(r.ok, false);
    assert.equal(r.conflict, true);
    assert.equal(r.followUp, undefined);
    assert.match(r.error, /被别的改动动过了/);
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    /* 盘上没变 → 照常追问 */
    const ok = settlePatchRevision({ replyText: FIRST, base: BIG, onDisk: () => BIG, write: () => ({ ok: true }) }) as any;
    assert.ok(ok.followUp);
    assert.equal(ok.conflict, undefined);
  });

  test('补过一次还是格式错误 → 报失败，提示注明补过一次，不再追问、不写', () => {
    let writes = 0;
    const r = settlePatchRevision({ replyText: FIRST, base: BIG, followedUp: true, write: () => { writes++; return { ok: true }; } }) as any;
    assert.equal(r.ok, false);
    assert.equal(r.followUp, undefined);
    assert.match(r.error, /没有给新内容/);
    assert.match(r.error, /已经让它补过一次/);
    assert.equal(writes, 0);
    assert.match(patchReplyOutcome(r).why, /已经让它补过一次/);
  });

  test('用户的场景：第一次空块 → 追问；第二次改成 <DELETE> → 整轮写进文件，内容正确', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-followup-'));
    const file = path.join(dir, 'a.md');
    fs.writeFileSync(file, BIG);
    const write = (fullText: string, expectBase: string) => {
      if (fs.readFileSync(file, 'utf8') !== expectBase) return { ok: false, mismatch: true };
      fs.writeFileSync(file, fullText);
      return { ok: true, path: file };
    };
    const r1 = settlePatchRevision({ replyText: FIRST, base: BIG, write }) as any;
    assert.ok(r1.followUp);
    assert.equal(fs.readFileSync(file, 'utf8'), BIG);
    const r2 = settlePatchRevision({ replyText: SECOND, base: BIG, write, followedUp: true }) as any;
    assert.equal(r2.ok, true);
    assert.equal(r2.written, true);
    const want = BIG.split('\n');
    want.splice(115, 2);                                   // 116-117 删掉
    want.splice(109, 3, '改写后的一段');                    // 110-112 改写
    want.splice(99, 1, '新起的一段', '', '第100行原文');      // 100 上面新起一段
    assert.equal(fs.readFileSync(file, 'utf8'), want.join('\n'));
    assert.equal(r2.fullText, want.join('\n'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('提示词里"删掉一段"那条强调块下面不能留空', () => {
    const p = reviseInSessionPrompt({ where: 'x', note: 'y', scope: 'patch', full: 'a\nb' });
    assert.match(p, /删掉一段：新内容只写一行 `<DELETE>`[^\n]*块下面不能留空/);
  });

  test('主进程接线：追问在同一条会话、只一次、能取消、记下原始回复', () => {
    const M = fs.readFileSync('src/main/index.ts', 'utf8');
    const at = M.indexOf("ipcMain.handle('review:revise-in-session'");
    const body = M.slice(at, M.indexOf("ipcMain.handle('review:cancel'", at));
    assert.match(body, /\.followUp/);
    assert.ok(body.includes('finishPatch(reply.text, patchBase!, started, false)'));
    assert.ok(body.includes('finishPatch(again.text, base, started, true)'));
    assert.ok(body.includes('replyText, base, followedUp,'));
    /* 追问前只读核对盘上那一份（不写） */
    assert.match(body, /const onDisk = canWrite \? await readReviewFile\(sessionId, apply!\.path\) : undefined;/);
    assert.match(body, /onDisk: canWrite \? \(\) => onDisk : undefined/);
    /* 追问那一轮同样等会话空下来、认取消 */
    const fu = body.slice(body.indexOf('async function followUpPatch('));
    assert.ok(fu.includes('waitIdle(sessionId'));
    assert.ok(fu.includes('if (tk.cancelled()) return { ok: false, cancelled: true }'));
    assert.ok(fu.includes('tk.asking(true)'));
    assert.match(body, /logger\.warn\('revise', [^\n]*slice\(0, 2000\)/);
  });
});
