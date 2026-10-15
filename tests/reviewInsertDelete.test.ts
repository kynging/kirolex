import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { insertAfterLines, deleteLines } from '../src/renderer/reviewBlocks.ts';
import { reviseInSessionPrompt } from '../src/main/reviseBlock.ts';

describe('＋ 在一段后面加', () => {
  test('段落之间各留一个空行，不和下一段粘在一起', () => {
    assert.equal(insertAfterLines('甲\n\n乙', 1, '新'), '甲\n\n新\n\n乙');
  });
  test('列表项后面接列表项不空行（空一行就成了松散列表）', () => {
    assert.equal(insertAfterLines('- a\n- b', 1, '- 新'), '- a\n- 新\n- b');
  });
  test('加在最后一行后面：前面补空行，后面不多出空行', () => {
    assert.equal(insertAfterLines('甲', 1, '新'), '甲\n\n新');
  });
  test('模型回的首尾空行去掉；空回复什么都不改', () => {
    assert.equal(insertAfterLines('甲\n\n乙', 1, '\n\n新\n'), '甲\n\n新\n\n乙');
    assert.equal(insertAfterLines('甲', 1, '  '), '甲');
  });
});

describe('✕ 当场删', () => {
  test('删掉中间一段，接缝处的两个空行收成一个', () => {
    assert.equal(deleteLines('甲\n\n乙\n\n丙', 3, 3), '甲\n\n丙');
  });
  test('删掉开头那一段，文件不以空行开头', () => {
    assert.equal(deleteLines('# 标题\n\n正文', 1, 1), '正文');
  });
  test('删一整节（闭区间）', () => {
    assert.equal(deleteLines('# A\na1\n\n# B\nb1', 1, 3), '# B\nb1');
  });
});

describe('insert 那一档的提示词', () => {
  const p = reviseInSessionPrompt({ where: '原文这一段', note: '补一段风险说明', about: 'a.md', scope: 'insert' });
  test('只要新内容，不让它重复原文', () => {
    assert.ok(p.includes('只输出新加的那部分'));
    assert.ok(p.includes('原文这一段') && p.includes('补一段风险说明'));
  });
  test('禁止它自己动文件；没信息就写 CANNOT 记号', () => {
    assert.ok(p.includes('不要用工具去改文件'));
    assert.ok(p.includes('CANNOT-REVISE-LOCALLY'));
  });
});

test('旧主进程不认 insert 时不写盘（否则同一段出现两遍）', async () => {
  const fs = await import('node:fs');
  const RV = fs.readFileSync('src/renderer/components/ReviewPane.tsx', 'utf8');
  const M = fs.readFileSync('src/main/index.ts', 'utf8');
  assert.ok(M.includes('return { ok: true, text: out.text, scope: wantScope };'));
  const guard = RV.indexOf("if (res.scope !== 'insert') {");
  assert.ok(guard > 0 && guard < RV.indexOf('const fullText = insertAfterLines(base, to, String(res.text));'));
});

test('改写那一轮中断了不回填：自动重发和自动续写都跳过「【改写」那一轮', async () => {
  const { isReviseRequest } = await import('../src/renderer/turnRecovery.ts');
  assert.equal(isReviseRequest('【改写 · a.md 第 38 行】这些场景需要重写'), true);
  assert.equal(isReviseRequest('普通问题'), false);
  /* 英文界面下主进程写的是英文开头（`tr('[Revision · {label}] {note}')`）—— 同样要认，旧的中文开头照认 */
  const { trIn } = await import('../src/main/uiText.ts');
  assert.equal(isReviseRequest(trIn('en', '[Revision · {label}] {note}', { label: 'a.md line 38', note: 'rewrite these' })), true);
  assert.equal(isReviseRequest(trIn('en', '[Revision] {note}', { note: 'x' })), true);
  assert.equal(isReviseRequest(trIn('en', '[Revision · {file} page {page} slide text] {note}', { file: 'd.pptx', page: 2, note: 'x' })), true);
  assert.equal(isReviseRequest(trIn('zh', '[Revision · {label}] {note}', { label: 'a.md 第 38 行', note: 'x' })), true);
  /* 只认 KiroLex 自己那种方括号开头，不吃掉你随手写的 "[Revision notes] …" / "Revision: …" */
  assert.equal(isReviseRequest('[Revision notes] please read'), false);
  assert.equal(isReviseRequest('Revision: fix the intro'), false);
  const fs = await import('node:fs');
  const U = fs.readFileSync('src/renderer/hooks/useAcp.ts', 'utf8');
  assert.ok(U.includes('if (isReviseRequest(target.content)) return;'));
  assert.ok(U.includes('if (lastUser && isReviseRequest(lastUser.content)) return;'));
});

test('侧栏的折叠活过 reload；reload 之后那一阵子重新连上的会话不把组弹开', async () => {
  const fs = await import('node:fs');
  const S = fs.readFileSync('src/renderer/components/Sidebar.tsx', 'utf8');
  assert.ok(S.includes('restoreSet(COLLAPSED_KEY, JSON.stringify([...collapsed]));'));
  assert.ok(S.includes('if (restoredCollapse.current) return;'));
  assert.ok(S.includes('if (Date.now() < settleUntil.current) return;'));
});

describe('改写的回复由主进程拼回去、写盘（窗口 reload 了也不丢）', () => {
  test('applyRevision：splice 换掉那几行、insert 插在后面（patch 走 applyPatch）', async () => {
    const { applyRevision } = await import('../src/main/reviewApply.ts');
    const base = '甲\n\n乙\n\n丙';
    assert.equal(applyRevision({ path: 'a.md', mode: 'splice', from: 3, to: 3, base }, '乙改'), '甲\n\n乙改\n\n丙');
    assert.equal(applyRevision({ path: 'a.md', mode: 'insert', to: 3, base }, '新'), '甲\n\n乙\n\n新\n\n丙');
    assert.equal(applyRevision({ path: 'a.md', mode: 'patch', base }, 'x'), null, 'patch 不走这里');
    assert.equal(applyRevision({ path: 'a.md', mode: 'splice', from: 4, to: 3, base }, 'x'), null, '位置不对不写');
  });
  test('渲染层的 reviewBlocks 转出的是同一份', async () => {
    const a = await import('../src/main/reviewApply.ts');
    const b = await import('../src/renderer/reviewBlocks.ts');
    assert.equal(a.insertAfterLines, b.insertAfterLines);
    assert.equal(a.spliceLines, b.spliceLines);
  });
  test('主进程：带 apply 时自己拼、自己写（盘上和 base 对不上就不写、交回渲染层），写完记 ticket', async () => {
    const fs = await import('node:fs');
    const M = fs.readFileSync('src/main/index.ts', 'utf8');
    assert.ok(M.includes('const fullText = applyRevision(apply, out.text);'));
    assert.ok(M.includes('const wrote = await writeReviewFile(sessionId, apply.path, fullText, apply.base);'));
    assert.ok(M.includes('if (!wrote?.ok && wrote?.mismatch) return { ok: true, text: out.text, scope: wantScope };'));
    assert.ok(M.includes('markTicketDone(input?.ticket);'));
    assert.ok(M.includes("ipcMain.handle('review:tickets-done'"));
    const RV = fs.readFileSync('src/renderer/components/ReviewPane.tsx', 'utf8');
    assert.ok(RV.includes("apply: { path, mode: 'splice', from, to, base },"));
    assert.ok(RV.includes("if (res.written && typeof res.fullText === 'string') return writeBack(base, res.fullText, failKey, '', true, { ai: { changes: res.changes, round } });"));
    assert.ok(RV.includes('void window.kiroApi.reviewTicketsDone?.(tickets).then((done) => {'));
  });
});
