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

  test('whole 档：以**盘上此刻**的正文为基准，并明说"这里没有的就是删掉的"', () => {
    const p = reviseInSessionPrompt({ where: 'x', note: 'y', scope: 'whole', full: '整份正文' });
    assert.match(p, /输出完整正文/);
    assert.match(p, /现在的完整正文[\s\S]*整份正文/);
    assert.match(p, /上面那份正文里没有的东西，就是已经删掉的/);
    assert.match(p, /结构调整是允许的/);
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
    assert.match(body, /want = resolveUserPath\(raw, sessionId\)/);
    assert.match(body, /if \(!wasReviewed\(sessionId, want\)\)/);
    /* 记账在 workspace:read 里，用的是同一个解析之后的路径、同一个会话 */
    const read = MAIN.slice(MAIN.indexOf("ipcMain.handle('workspace:read'"));
    assert.match(read.slice(0, 1500), /filePath = resolveUserPath\(filePath, sessionId\);[\s\S]*markReviewed\(sessionId, filePath\);/);
  });

  test('写前备份，拷不成就不写；比预览上限大的不写', () => {
    const at = MAIN.indexOf("ipcMain.handle('review:write-file'");
    const body = MAIN.slice(at, at + 2200);
    assert.match(body, /if \(!saveReviewBackup\(want, previous\)\) \{\s*\n\s*return \{ ok: false/);
    assert.match(body, /WORKSPACE_PREVIEW_MAX_BYTES/);
    assert.ok(body.indexOf('saveReviewBackup(want, previous)') < body.indexOf('fs.writeFileSync(want, text'));
  });

  test('改写：排队、先挂回来、等空闲、超时摘掉等待者', () => {
    const at = MAIN.indexOf("ipcMain.handle('review:revise-in-session'");
    const body = MAIN.slice(at, at + 5000);
    assert.match(body, /return enqueueRevise\(sessionId, async \(\) => reviseOnce\(\), input\?\.label \|\| '改写'\);/);
    assert.match(body, /await ensureAttached\(sessionId\);/);
    assert.match(body, /const stillBusy = await waitIdle\(sessionId, 20 \* 60 \* 1000\);/);
    assert.match(body, /askWaiters\.delete\(sessionId\);\s*\n\s*reject\(new Error\('等了 8 分钟没等到回复'\)\);/);
    assert.match(body, /if \(askWaiters\.has\(sessionId\)\) return \{ ok: false/);
    assert.match(body, /replyUsable\(/);
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
