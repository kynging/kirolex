import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseRevised, reviseInSessionPrompt, replyUsable, keepHeading, lostFields, lostFieldsByChange, keepPatchHeadings, settlePatchRevision } from '../src/main/reviseBlock.ts';

/**
 * 侧栏 review「✓ 确认」的主进程那半：提示词、回复清洗、什么样的回复能写盘，以及 IPC 接线。
 * 判据从 feature/flow 搬过来（门那侧的一次性 helper 和「＋ 加一条」不在这条分支上）。
 */

describe('回复清洗', () => {
  test('正常输出原样收下', () => {
    assert.deepEqual(parseRevised('- **本周**: 新版本', '旧'), { text: '- **本周**: 新版本' });
  });

  test('**只剥最外层围栏** —— 原文里本来可能有代码块，剥里面的会毁掉内容', () => {
    const out = parseRevised('```md\n## 标题\n\n```bash\nnpm i\n```\n```', '旧');
    assert.match(out.text, /## 标题/);
    assert.match(out.text, /```bash/, '内层围栏必须留着');
  });

  test('改不了：**原文一个字不动**，并把原因带上来', () => {
    const out = parseRevised('原文照抄\nCANNOT-REVISE-LOCALLY: 需要和信号那节合并', '原文');
    assert.equal(out.text, '原文');
    assert.match(out.cannot!, /信号那节/);
  });

  test('空回复不能当成"改成空的" —— 那会静默删掉一段（整份那档就是删掉整个文件）', () => {
    const out = parseRevised('   ', '原文');
    assert.equal(out.text, '原文');
    assert.ok(out.cannot);
  });

  test('**不去掉开场白** —— 那种句子没法可靠识别，误删正文比留一句废话糟', () => {
    assert.equal(parseRevised('本周项目进展如下\n- a', 'x').text, '本周项目进展如下\n- a');
  });
});

describe('发给会话的提示词', () => {
  test('block 档：只要这一段、不许动文件、改不了要说', () => {
    const p = reviseInSessionPrompt({ where: '- 做了 A', note: '口径改成客户视角', about: '/a/W35.md' });
    assert.match(p, /「\/a\/W35\.md」/);
    assert.match(p, /只输出改完的这一段/);
    assert.match(p, /不要用工具去改文件/);
    assert.match(p, /CANNOT-REVISE-LOCALLY/);
    assert.match(p, /段落之间的空行照留/);
    assert.doesNotMatch(p, /现在的完整正文/, 'block 档不多发一份整文');
  });

  test('patch 档：带行号的全文 + 意见的位置，只交回要换的那几处（不整篇重写）', () => {
    const p = reviseInSessionPrompt({
      where: '乙段', note: '把这段和下一段合并', about: 'a.md', scope: 'patch',
      full: '甲段\n\n乙段\n\n丙段', fromLine: 3, toLine: 3,
    });
    assert.match(p, /现在的完整正文[\s\S]*^1\t甲段$[\s\S]*^3\t乙段$[\s\S]*^5\t丙段$/m, '每行带行号');
    assert.match(p, /意见指的位置：第 3 行/);
    assert.match(p, /把这段和下一段合并/);
    assert.match(p, /@@ <起始行>-<结束行> \| <这几行原文开头的几个字>/);
    assert.match(p, /@@ END/);
    assert.match(p, /不需要动的段落一个字都不要交回/);
    assert.match(p, /合并两段：用一块新内容换掉这两段的整个行范围/);
    assert.match(p, /<DELETE>/);
    assert.match(p, /不要用工具去改文件/);
    assert.match(p, /CANNOT-REVISE-LOCALLY/);
    assert.doesNotMatch(p, /输出完整正文/);
    assert.doesNotMatch(p, /只输出改完的这一段/);
  });

  test('patch 档：整篇的意见不写行号，多行范围写成 起-止', () => {
    const p0 = reviseInSessionPrompt({ where: '（整篇）', note: 'y', scope: 'patch', full: 'a' });
    assert.match(p0, /意见指的位置：\n/);
    const p1 = reviseInSessionPrompt({ where: 'x', note: 'y', scope: 'patch', full: 'a\nb\nc', fromLine: 2, toLine: 3 });
    assert.match(p1, /意见指的位置：第 2-3 行/);
  });

  test('没有整份重写那一档了', () => {
    const src = fs.readFileSync('src/main/reviseBlock.ts', 'utf8');
    assert.doesNotMatch(src, /scope\?: [^;]*'whole'/);
    assert.doesNotMatch(src, /输出完整正文/);
  });
});

describe('评论标题后改写不把标题弄丢', () => {
  const where = '## 客户待确认 - RDS for Db2 数据迁移与跨库复制方案\n\n- 迁移窗口待定\n- 复制延迟待测';

  test('原文以标题开头、回复没标题 → 补上原标题，空行照原文', () => {
    const out = keepHeading(where, '- 迁移窗口：11 月第二周\n- 复制延迟待测');
    assert.equal(out, '## 客户待确认 - RDS for Db2 数据迁移与跨库复制方案\n\n- 迁移窗口：11 月第二周\n- 复制延迟待测');
  });

  test('标题和正文之间没有空行的，补的时候也不加', () => {
    assert.equal(keepHeading('### 标题\n正文', '新正文'), '### 标题\n新正文');
  });

  test('回复带了改过的标题 → 用回复里的，不出现两个标题', () => {
    const reply = '## 已确认 - RDS for Db2 迁移方案\n\n- 迁移窗口待定';
    const out = keepHeading(where, reply);
    assert.equal(out, reply);
    assert.equal((out.match(/^#+ /gm) || []).length, 1);
  });

  test('回复第一行是标题、只是级别不同 —— 也照用，不再叠一个', () => {
    assert.equal(keepHeading(where, '### 新标题\n正文'), '### 新标题\n正文');
  });

  test('回复前面有空行也按第一个非空行判断', () => {
    assert.equal(keepHeading(where, '\n\n## 新标题\n正文'), '\n\n## 新标题\n正文');
  });

  test('原文不是标题 → 回复原样不动', () => {
    assert.equal(keepHeading('- 做了 A\n- 做了 B', '- 做了 A2'), '- 做了 A2');
    assert.equal(keepHeading('#hashtag 不是标题', '改过的'), '改过的');
  });

  test('insert / patch 档不补标题', () => {
    assert.equal(keepHeading(where, '- 新加一条', 'insert'), '- 新加一条');
    assert.equal(keepHeading(where, '- 新加一条', 'patch'), '- 新加一条');
  });

  test('CRLF 的原文补回去也用 CRLF', () => {
    assert.equal(keepHeading('# T\r\n\r\nbody', 'new'), '# T\r\n\r\nnew');
  });

  test('提示词：原文以标题开头时要求交回这个标题、级别不变', () => {
    const p = reviseInSessionPrompt({ where, note: '迁移窗口定了，11 月第二周' });
    assert.match(p, /第一行必须是这个标题/);
    assert.match(p, /2 个 `#`/);
    assert.match(p, /原样保留/);
    const p2 = reviseInSessionPrompt({ where: '- 做了 A', note: 'x' });
    assert.doesNotMatch(p2, /第一行必须是这个标题/, '原文不是标题就不提');
    const p3 = reviseInSessionPrompt({ where, note: 'x', scope: 'insert' });
    assert.doesNotMatch(p3, /第一行必须是这个标题/, 'insert 档不提');
  });

  test('主进程 block 档：写盘和交回渲染层都用补过标题的结果', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const i = src.indexOf("ipcMain.handle('review:revise-in-session'");
    const body = src.slice(i, src.indexOf('async function finishPatch', i));
    /* 补过的结果写回 out.text，后面拼回写盘（applyRevision）和交回渲染层（text: out.text）用的都是它 */
    const fixAt = body.indexOf('out.text = keepHeading(where, out.text, wantScope);');
    assert.ok(fixAt > body.indexOf('if (out.cannot)'), '在"改不了"判断之后、拼回之前补');
    assert.ok(fixAt < body.indexOf('applyRevision(apply, out.text)'));
    assert.ok(fixAt < body.lastIndexOf('return { ok: true, text: out.text, scope: wantScope };'));
  });
});

describe('什么样的回复能写盘', () => {
  test('正常收尾的才收；被截断 / 卡死的不写', () => {
    assert.deepEqual(replyUsable({ stopReason: 'end_turn' }), { ok: true });
    assert.deepEqual(replyUsable({ stopReason: 'n/a' }), { ok: true });
    assert.equal(replyUsable({ stopReason: 'max_tokens' }).ok, false);
    assert.equal(replyUsable({ stopReason: 'refusal' }).ok, false);
    assert.equal(replyUsable({ stopReason: 'end_turn', wedged: true }).ok, false);
  });
});

describe('主进程接线', () => {
  const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const PRE = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');

  test('四个通道都在，preload 一一转发', () => {
    for (const ch of ['review:revise-in-session', 'review:write-file', 'review:backup-file', 'session:note']) {
      assert.match(MAIN, new RegExp(`ipcMain\\.handle\\('${ch}'`), ch);
      assert.match(PRE, new RegExp(`ipcRenderer\\.invoke\\('${ch}'`), ch);
    }
    /* 不是门的通道 —— 这条分支没有 flow */
    assert.doesNotMatch(MAIN, /gate:revise-in-session/);
  });

  test('写回**按主人会话解析路径**，并且只许写这条会话读过的', () => {
    const at = MAIN.indexOf('const reviewTarget = ');
    const body = MAIN.slice(at, at + 900);
    /* 判据在 pickReviewTarget（reviewAccess.test.ts 覆盖）；这里按同一个解析、同一个会话的白名单去查 */
    assert.match(body, /pickReviewTarget<RemoteTarget>\(\{/);
    assert.match(body, /resolveLocal: \(raw\) => resolveUserPath\(raw, sessionId\)/);
    assert.match(body, /reviewed: \(key\) => wasReviewed\(sessionId, key\)/);
    /* 记账在 workspace:read 里，用的是同一个解析之后的路径、同一个会话 */
    const read = MAIN.slice(MAIN.indexOf("ipcMain.handle('workspace:read'"));
    assert.match(read.slice(0, 1500), /filePath = resolveUserPath\(filePath, sessionId\);[\s\S]*markReviewed\(sessionId, filePath\);/);
  });

  test('写前备份，拷不成就不写；比预览上限大的不写', () => {
    /* 写盘那段抽成了 `writeReviewFile`（review:write-file 和改写那条路的 `apply` 共用） */
    const at = MAIN.indexOf('const writeReviewFile = async (');
    const body = MAIN.slice(at, at + 2200);
    assert.ok(MAIN.includes("ipcMain.handle('review:write-file', async (_event, sessionId: string | null | undefined, filePath: string, text: string, expectBase?: unknown) =>\n    writeReviewFile(sessionId, filePath, text, typeof expectBase === 'string' ? expectBase : undefined));"));
    assert.match(body, /if \(!saveReviewBackup\(want, previous\)\) \{\s*\n\s*return \{ ok: false/);
    assert.match(body, /WORKSPACE_PREVIEW_MAX_BYTES/);
    assert.ok(body.indexOf('saveReviewBackup(want, previous)') < body.indexOf('fs.writeFileSync(want, text'));
  });

  test('改写：排队、先挂回来、等空闲、超时摘掉等待者', () => {
    const at = MAIN.indexOf("ipcMain.handle('review:revise-in-session'");
    const body = MAIN.slice(at, at + 6500);
    assert.ok(body.includes("return enqueueRevise(sessionId, async () => {\n      try { return await reviseOnce(); } finally { tk.close(); }\n    }, input?.label || tr('Revision'));"));
    /* 取消按 ticket 认这一次改写：排队 / 等空闲期间被取消就不发；在等回复的只停它自己那一轮 */
    assert.equal((body.match(/if \(tk\.cancelled\(\)\) return \{ ok: false, cancelled: true \};/g) || []).length, 4);
    assert.match(body, /await ensureAttached\(sessionId\);/);
    assert.match(body, /const stillBusy = await waitIdle\(sessionId, 20 \* 60 \* 1000\);/);
    assert.match(body, /if \(askWaiters\.has\(sessionId\)\) return \{ ok: false/);
    assert.match(body, /const reply = await askOnce\(/);
    assert.match(body, /replyUsable\(/);
    /* 等待者的挂、摘、超时只有一份（`askOnce`），文本一块和 deck 一页共用 */
    const ask = MAIN.slice(MAIN.indexOf('const askOnce = '), MAIN.indexOf('const askOnce = ') + 1200);
    assert.match(ask, /askWaiters\.delete\(sessionId\);\s*\n\s*reject\(new Error\(tr\('No reply after waiting 8 minutes'\)\)\);/);
    assert.match(ask, /if \(drop\(\)\) reject\(new Error\(tr\('This turn did not finish normally/);
    /* 文本一块、deck 一页，外加 patch 档格式不对时追问的那一次（`followUpPatch`）—— 都走同一个 askOnce */
    assert.equal((MAIN.match(/await askOnce\(/g) || []).length, 3);
  });

  test('等待者**只在一轮成功收尾时**兑付 —— 出错/取消那两条 flush 的是半截输出', () => {
    assert.doesNotMatch(MAIN.slice(MAIN.indexOf('function flushAssistant('), MAIN.indexOf('function flushAssistant(') + 2500), /settleAsk\(/);
    assert.match(MAIN, /flushAssistant\(sessionId\); \/\/ turn complete -> persist the full assistant msg\n\s*if \(askReply\) settleAsk\(sessionId, askReply\);/);
    assert.equal((MAIN.match(/settleAsk\(sessionId, /g) || []).length, 1);
  });

  test('挂载只有一份实现 —— IPC 那侧只是转发；挂不上不抛', () => {
    assert.match(MAIN, /const loadSessionImpl = async \(sessionId: string, cwd: string, model: string\): Promise<any> =>/);
    assert.match(MAIN, /ipcMain\.handle\('acp:load-session', async \(_event, sessionId: string, cwd: string, model: string\) =>\s*\n\s*loadSessionImpl\(sessionId, cwd, model\)\);/);
    const at = MAIN.indexOf('const ensureAttached = async');
    const body = MAIN.slice(at, at + 700);
    assert.match(body, /if \(sessionClients\.get\(sid\)\) return true;/);
    assert.match(body, /logger\.warn\('revise', `按需挂起失败/);
  });
});

describe('整节改写漏了字段要说出来（lostFields）', () => {
  const where = [
    '## 项目 A',
    '',
    '- **本周进展**: 完成迁移方案',
    '- **风险**: 窗口未定',
    '- **下周计划**: 联调',
    '- **负责人：** 张三',
  ].join('\n');

  test('回复漏了两个字段 → 按原文顺序报出这两个', () => {
    const reply = '## 项目 A\n\n- **本周进展**: 迁移方案已评审\n- **负责人：** 张三';
    assert.deepEqual(lostFields(where, reply), ['风险', '下周计划']);
  });

  test('字段齐全（值改了、顺序变了）→ 不报', () => {
    const reply = '## 项目 A\n\n- **风险**: 已定\n- **本周进展**: 评审通过\n- **负责人**: 李四\n- **下周计划**: 上线';
    assert.deepEqual(lostFields(where, reply), []);
  });

  test('只认 `- **名字**:` 这种字段行 —— 正文里的加粗、没有冒号的不算', () => {
    assert.deepEqual(lostFields('这里 **强调** 一下\n- **不是字段** 没冒号', '全删了'), []);
    assert.deepEqual(lostFields('* **状态**：进行中', '- 进行中'), ['状态']);
  });

  test('同名字段出现两次只报一次', () => {
    assert.deepEqual(lostFields('- **备注**: a\n- **备注**: b', 'x'), ['备注']);
  });
});

describe('删字段的提示挂在真正删了它的那一处上（lostFieldsByChange）', () => {
  const base = ['## 项目', '', '- **Progress**: 旧', '- **Status**: 进行中', '- **Risks**: 窗口未定'].join('\n');

  test('改了 Progress、留着 Status、删了 Risks → 两处改动，提示只在删 Risks 那一处；撤销那一处 Risks 就回来了', async () => {
    const { diffChanges, planUndo } = await import('../src/renderer/aiChanges.ts');
    const reply = '## 项目\n\n- **Progress**: 新\n- **Status**: 进行中';
    const lost = lostFields(base, reply);
    assert.deepEqual(lost, ['Risks']);
    const changes = diffChanges(base, reply);
    assert.equal(changes.length, 2, '改 Progress 和删 Risks 是两处');
    assert.deepEqual(lostFieldsByChange(changes, lost), [[], ['Risks']]);
    /* 撤销挂着提示的那一处 —— Risks 回来了，Progress 还是新的 */
    const marks = changes.map((c, i) => ({ ...c, id: i + 1 }));
    const undo = planUndo({ base: reply, marks }, 2, reply);
    assert.equal(undo.ok, true);
    if (undo.ok) {
      assert.match(undo.text, /- \*\*Risks\*\*: 窗口未定/);
      assert.match(undo.text, /- \*\*Progress\*\*: 新/);
      assert.deepEqual(lostFields(base, undo.text), []);
    }
  });

  test('两处各删了一个字段 → 各自那一处各说各的', async () => {
    const { diffChanges } = await import('../src/renderer/aiChanges.ts');
    const reply = '## 项目\n\n- **Status**: 进行中';
    const lost = lostFields(base, reply);
    assert.deepEqual(lost, ['Progress', 'Risks']);
    const changes = diffChanges(base, reply);
    assert.equal(changes.length, 2);
    assert.deepEqual(lostFieldsByChange(changes, lost), [['Progress'], ['Risks']]);
  });

  test('一处删掉、另一处又写回来的不算丢；哪一处都对不上的挂在第一处删了字段的地方（提示不丢）', () => {
    assert.deepEqual(lostFieldsByChange([
      { original: '- **A**: 1', text: '' },
      { original: '', text: '- **A**: 1' },
    ], []), [[], []]);
    assert.deepEqual(lostFieldsByChange([{ original: 'x', text: 'y' }, { original: '- **B**: 1', text: '' }], ['B', 'C']), [[], ['B', 'C']]);
    assert.deepEqual(lostFieldsByChange([{ original: 'x', text: 'y' }], ['C']), [['C']]);
    assert.deepEqual(lostFieldsByChange([], ['C']), []);
  });
});

describe('patch 档也保住标题（keepPatchHeadings）', () => {
  const base = ['# 周报', '', '## 项目 A', '', '- **进展**: 旧', '', '## 项目 B', '', '- **进展**: 旧 B'].join('\n');

  test('一处覆盖了标题行、回复里没标题 → 原标题补回去，空行照原文', () => {
    const [e] = keepPatchHeadings(base, [{ from: 3, to: 5, text: '- **进展**: 新' }]);
    assert.equal(e.text, '## 项目 A\n\n- **进展**: 新');
  });

  test('回复自带（改过的）标题 → 照用，不出现两个标题', () => {
    const [e] = keepPatchHeadings(base, [{ from: 3, to: 5, text: '## 项目 A（已更名）\n\n- **进展**: 新' }]);
    assert.equal(e.text, '## 项目 A（已更名）\n\n- **进展**: 新');
  });

  test('没覆盖标题的那一处、删除（<DELETE>）的那一处不动', () => {
    const out = keepPatchHeadings(base, [
      { from: 5, to: 5, text: '- **进展**: 新' },
      { from: 7, to: 9, text: '' },
    ]);
    assert.deepEqual(out.map((e) => e.text), ['- **进展**: 新', '']);
  });

  test('标题在这一处的中间、回复里没有 → 补回它原来的位置（前面隔了几行正文就隔几行）', () => {
    const [e] = keepPatchHeadings('old paragraph\n## Heading\nold body', [{ from: 1, to: 3, text: 'new paragraph\nnew body' }]);
    assert.equal(e.text, 'new paragraph\n## Heading\nnew body');
  });

  test('一处盖住好几个标题、回复一个都没写 → 每个都补回，空行照原文', () => {
    const [e] = keepPatchHeadings(base, [{ from: 3, to: 9, text: '- **进展**: 新 A\n\n- **进展**: 新 B' }]);
    assert.equal(e.text, '## 项目 A\n\n- **进展**: 新 A\n\n## 项目 B\n\n- **进展**: 新 B');
  });

  test('一处盖住好几个标题、回复只写了其中一个 → 只补漏了的那个，不重复', () => {
    const [e] = keepPatchHeadings(base, [{ from: 3, to: 9, text: '## 项目 A\n\n- **进展**: 新 A\n\n- **进展**: 新 B' }]);
    assert.equal(e.text, '## 项目 A\n\n- **进展**: 新 A\n\n## 项目 B\n\n- **进展**: 新 B');
    const [f] = keepPatchHeadings(base, [{ from: 3, to: 9, text: '- **进展**: 新 A\n\n## 项目 B\n\n- **进展**: 新 B' }]);
    assert.equal(f.text, '## 项目 A\n\n- **进展**: 新 A\n\n## 项目 B\n\n- **进展**: 新 B');
  });

  test('回复把这几个标题都改了名（个数对得上）→ 照用，不再补原标题', () => {
    const reply = '## A 改名\n\n- **进展**: 新 A\n\n## B 改名\n\n- **进展**: 新 B';
    const [e] = keepPatchHeadings(base, [{ from: 3, to: 9, text: reply }]);
    assert.equal(e.text, reply);
    /* 改了名的那个顶替它对应的原标题，只补真正漏掉的 */
    const [f] = keepPatchHeadings(base, [{ from: 3, to: 9, text: '- **进展**: 新 A\n\n## B 改名\n\n- **进展**: 新 B' }]);
    assert.equal((f.text.match(/^## /gm) || []).length, 2);
    assert.ok(!f.text.includes('## 项目 B'));
  });

  test('回复把两节换了顺序（标题都在）→ 照用，不补出重复的标题', () => {
    const orig = '## A\nbody A\n## B\nbody B';
    const reply = '## B\nbody B\n## A\nbody A';
    const [e] = keepPatchHeadings(orig, [{ from: 1, to: 4, text: reply }]);
    assert.equal(e.text, reply);
    /* 换了顺序、其中一个还改了名 —— 同样不补 */
    const [f] = keepPatchHeadings(orig, [{ from: 1, to: 4, text: '## B\nbody B\n## A 改名\nbody A' }]);
    assert.equal(f.text, '## B\nbody B\n## A 改名\nbody A');
  });

  test('settlePatchRevision 拼回的正文里标题还在', () => {
    const res = settlePatchRevision({ replyText: '@@ 3-5 | ## 项目 A\n- **进展**: 新\n@@ END', base });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.fullText, ['# 周报', '', '## 项目 A', '', '- **进展**: 新', '', '## 项目 B', '', '- **进展**: 旧 B'].join('\n'));
      assert.equal((res.fullText.match(/## 项目 A/g) || []).length, 1);
    }
  });
});

describe('丢字段提示的接线', () => {
  const RV = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ReviewPane.tsx'), 'utf8');

  test('block 档拿原节和（主进程补过标题的）回复比，两条写回路都带上提示', () => {
    assert.ok(RV.includes("import { lostFields, lostFieldsByChange } from '../../main/reviseBlock.ts';"));
    assert.ok(RV.includes("typeof res?.text === 'string' ? lostFields(where, res.text) : []"));
    /* block 档那一段（insert 档在它前面，不带提示） */
    const block = RV.slice(RV.indexOf("apply: { path, mode: 'splice', from, to, base },"));
    const warnAt = block.indexOf('const lost = lostOf(where, res);');
    assert.ok(warnAt > 0);
    assert.ok(block.includes("return writeBack(base, res.fullText, failKey, '', true, { ai: { changes: res.changes, round, lost }, edited: [singleRange(base, res.fullText, from, to)] });"));
    assert.ok(block.includes('whereAt(from, to) }), false, { ai: { round, lost }, expectBase: base, edited: [singleRange(base, fullText, from, to)] }));'));
    /* 每一处只说**它自己**删掉的那几个 —— 撤销哪一处，恢复的就是它说的那几个 */
    assert.ok(RV.includes('const perChange = lostFieldsByChange(changes, opts.ai?.lost ?? []);'));
    assert.ok(RV.includes('...(perChange[i].length ? { warn: lostWarnText(perChange[i]) } : null)'));
  });

  test('侧栏把它挂在 AI 改过的那一处下面，用醒目的样式', () => {
    assert.match(RV, /className="rt-note-applied rv-ai-warn">\{m\.warn\}/);
    const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');
    assert.match(CSS, /\.rv-review \.rv-ai-warn \{[^}]*color: var\(--error/);
  });
});
