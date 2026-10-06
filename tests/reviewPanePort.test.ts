import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 侧栏文件预览逐行 comment 的接线（源码断言，和别处同一套办法）。
 * 从 feature/flow 的 `reviewPanePort.test.ts` 改写：那边一半是 PDF/deck，这条分支没有。
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const RV = read('src/renderer/components/ReviewPane.tsx');
const CB = read('src/renderer/components/CommentBox.tsx');
const APP = read('src/renderer/App.tsx');
const CSS = read('src/renderer/styles/global.css');

describe('标签页记住它的主人会话', () => {
  test('打开时钉上 ownerSessionId（点链接那条会话，不是此刻选中的那条）', () => {
    assert.match(APP, /ownerSessionId\?: string;/);
    assert.match(APP, /\{ id, path: p, requestedPath: p, content: '', ownerSessionId: sessionForPath \|\| undefined \}/);
  });

  test('改写、写回、提交都用主人会话', () => {
    assert.match(APP, /sessionId=\{fileViewer\.ownerSessionId\}/);
    assert.match(APP, /handleSendMessage\(prompt, undefined, fileViewer\.ownerSessionId\)/);
    assert.match(RV, /window\.kiroApi\.reviewWriteFile\?\.\(sessionId, path, fullText\)/);
    assert.match(RV, /window\.kiroApi\.reviewBackupFile\?\.\(sessionId, path\)/);
  });

  test('刷新也以主人会话去读 —— 写回的白名单按它记', () => {
    assert.match(APP, /const owner = fileTabsRef\.current\.find\(\(t\) => t\.id === tabId\)\?\.ownerSessionId;/);
    assert.match(APP, /workspaceRead\(owner \|\| currentSessionId, filePath\)/);
  });
});

describe('入口', () => {
  test('只对 md / txt 给 comment 开关，截断的预览不给', () => {
    assert.match(APP, /function isReviewableText\(p: string\): boolean/);
    assert.match(APP, /isReviewableText\(fileViewer\.path\) && !fileViewerRaw && !fileViewer\.truncated && \(/);
    assert.match(APP, /\{commenting \? '✓ comment' : '💬 comment'\}/);
  });

  test('不开 comment 时照旧是原来的 MarkdownView —— 纯读不受影响', () => {
    assert.match(APP, /&& commenting \? \(\s*\n\s*<ReviewPane/);
    assert.match(APP, /\) : isMarkdownPath\(fileViewer\.path\) && !fileViewerRaw \? \(/);
  });

  test('PDF / deck 那一半由同一个 pane 管，不进 comment 开关（它们本来就是批注视图）', () => {
    assert.match(RV, /<PdfView/);
    assert.match(RV, /const on = isDeck \|\| !!commenting;/);
    /* deck 的 hooks 全在早返回之前 —— 转换失败那支少走 hook 会让 React 报 hooks 数量不一致 */
    const early = RV.indexOf('if (isDeck && why) {');
    assert.ok(early > 0);
    assert.ok(RV.lastIndexOf('useState', early) < early && RV.indexOf('useState(', early) < 0, '早返回之后不能再有 hook');
    assert.ok(RV.indexOf('useMemo(', early) < 0 && RV.indexOf('useCallback(', early) < 0 && RV.indexOf('useEffect(', early) < 0);
  });

  test('deck 的「✓ 确认」只给能改的（有主人会话 + .pptx），否则只有「记下」+ 提交', () => {
    assert.match(RV, /const live = !!sessionId && editable;/);
    assert.match(RV, /\? \(live \? \(instruction: string\) => applySlideOne\(anchor, instruction\) : undefined\)/);
    assert.match(RV, /window\.kiroApi\.deckWriteNote\?\.\(sessionId, path, page, res\.text\)/);
  });
});

describe('「✓ 确认」那条路', () => {
  test('先只要这一块，改不了才整份，整份带盘上此刻的正文', () => {
    assert.match(RV, /scope: 'block'/);
    assert.match(RV, /if \(res\?\.cannot\) \{/);
    assert.match(RV, /scope: 'whole',[\s\S]{0,120}full: base,/);
  });

  test('按闭区间取原文、按闭区间换回去 —— 段落之间的空行照带', () => {
    assert.match(RV, /const \{ from, to \} = spanRange\(span\);/);
    assert.match(RV, /const where = sliceLines\(base, from, to\);/);
    assert.match(RV, /spliceLines\(base, from, to, String\(res\.text\)\)/);
  });

  test('同一份文件的改写串行，排队的那条读写完之后的正文', () => {
    assert.match(RV, /return serialize\(async \(\) => \{/);
    assert.match(RV, /const base = textRef\.current;/);
  });

  test('剩下的意见按 keep 重新对位', () => {
    assert.match(RV, /const toLine = patch\.keep\[fromLine\];/);
  });

  test('落盘之后在会话里报一句（KiroLex 自己说的，不发给模型）', () => {
    assert.match(RV, /window\.kiroApi\.sessionNote\?\.\(/);
  });

  test('框里两个出口：✓ 确认（当场改）和「记下」（攒着一起提交）', () => {
    assert.match(RV, /allowRecord/);
    assert.match(CB, /\(!onApply \|\| allowRecord\) && \(/);
    assert.match(CB, /\{onApply \? '记下' : '✓ 确认'\}/);
  });
});

describe('样式挂在 .rv-review 下面', () => {
  test('按钮的定位和输入框在作用域里重新给 —— 不靠门留下的老规则', () => {
    assert.match(CSS, /\.rv-review \.rt-note-btn,\n\.rv-review \.rt-block-drop \{\n\s*position: absolute;/);
    assert.match(CSS, /\.rv-review \.rt-note \{[^}]*field-sizing: content;/);
    assert.match(CSS, /\.rv-review-toggle \{/);
    assert.match(CSS, /\.rv-review-submit \.rv-gate-pass:disabled/);
  });
});
