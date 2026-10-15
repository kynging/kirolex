import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseRevised, reviseInSessionPrompt, replyUsable } from '../src/main/reviseBlock.ts';

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
