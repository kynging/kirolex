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
    assert.match(RV, /window\.kiroApi\.reviewWriteFile\?\.\(sessionId, path, fullText, opts\.expectBase\)/);
    assert.match(RV, /window\.kiroApi\.reviewBackupFile\?\.\(sessionId, path\)/);
  });

  test('刷新也以主人会话去读 —— 写回的白名单按它记', () => {
    assert.match(APP, /const owner = fileTabsRef\.current\.find\(\(t\) => t\.id === tabId\)\?\.ownerSessionId;/);
    assert.match(APP, /workspaceRead\(owner \|\| currentSessionId, filePath\)/);
  });
});

describe('预览侧栏顶部排版', () => {
  test('没有文件名标题；标签行置顶，一个文件也显示', () => {
    const panel = APP.slice(APP.indexOf('className="workspace-file-panel"'), APP.indexOf('className="workspace-file-modal-body"'));
    assert.ok(panel.length > 0);
    assert.ok(!panel.includes('<h3'), '侧栏顶上不该再有 h3 标题');
    assert.ok(!panel.includes('fileTabs.length > 1'), '只开一个文件也要显示标签');
    assert.match(panel, /className="file-panel-top"/);
  });

  test('右侧依次是 ⟳ 刷新、📂 打开位置、✕；没有 Download', () => {
    const panel = APP.slice(APP.indexOf('className="workspace-file-panel"'), APP.indexOf('className="workspace-file-modal-body"'));
    const a = panel.indexOf("⟳ {t('Refresh')}"), b = panel.indexOf("📂 {t('Open location')}"), c = panel.indexOf('settings-close');
    assert.ok(a > 0 && a < b && b < c, '顺序：刷新 → 打开位置 → 关闭');
    assert.ok(!panel.includes('Download'));
    assert.ok(panel.includes(`isMac ? t('Show in Finder') : t('Show in Explorer')`));
    assert.ok(panel.includes('disabled={!!fileViewer.gone}'));
  });

  test('打开位置走主进程 shell.showItemInFolder', () => {
    const MAIN = read('src/main/index.ts');
    const PRE = read('src/main/preload.ts');
    assert.ok(PRE.includes(`ipcRenderer.invoke('app:show-in-folder', filePath, sessionId)`));
    const h = MAIN.indexOf(`ipcMain.handle('app:show-in-folder'`);
    assert.ok(h > 0 && MAIN.slice(h, h + 500).includes('shell.showItemInFolder(p)'));
  });

  test('原文切换和 comment 同一行，排在 comment 后面', () => {
    const bar = APP.slice(APP.indexOf('<div className="rv-toggle-bar">'));
    const c = bar.indexOf('💬 comment'), r = bar.indexOf("t('◎ Raw')"), end = bar.indexOf('</div>');
    assert.ok(c > 0 && c < r && r < end);
    assert.ok(APP.includes('if (!canComment && !canRaw) return null;'));
    /* 标签区可缩、自己滚动，右侧按钮不被挤掉 */
    assert.match(CSS, /\.file-panel-top \.file-tabs \{\s*flex: 1 1 auto;\s*min-width: 0;/);
  });
});

describe('入口', () => {
  test('只对 md / txt 给 comment 开关，截断的预览不给', () => {
    assert.match(APP, /function isReviewableText\(p: string\): boolean/);
    assert.match(APP, /const canComment = isReviewableText\(fileViewer\.path\) && !fileViewerRaw && !fileViewer\.truncated;/);
    assert.match(APP, /\{commenting \? t\('✓ comment'\) : t\('💬 comment'\)\}/);
  });

  test('不开 comment 时照旧是原来的 MarkdownView —— 纯读不受影响', () => {
    assert.match(APP, /&& commenting \? \(\s*\n\s*<ReviewPane/);
    assert.match(APP, /\) : isMarkdownPath\(fileViewer\.path\) && !fileViewerRaw \? \(/);
  });

  test('PDF / deck 那一半由同一个 pane 管，不进 comment 开关（它们本来就是批注视图）', () => {
    assert.match(RV, /<PdfView/);
    /* 没有主人会话就不给入口 —— 每个动作都当场生效，没会话就没有地方能让它生效 */
    assert.match(RV, /const on = \(isDeck \|\| !!commenting\) && !!sessionId;/);
    /* deck 的 hooks 全在早返回之前 —— 转换失败那支少走 hook 会让 React 报 hooks 数量不一致 */
    const early = RV.indexOf('if (isDeck && why) {');
    assert.ok(early > 0);
    assert.ok(RV.lastIndexOf('useState', early) < early && RV.indexOf('useState(', early) < 0, '早返回之后不能再有 hook');
    assert.ok(RV.indexOf('useMemo(', early) < 0 && RV.indexOf('useCallback(', early) < 0 && RV.indexOf('useEffect(', early) < 0);
  });

  test('deck 当场改得了的（有主人会话 + .pptx）一页一页排队改；改不了的拼成一条消息发给会话', () => {
    assert.match(RV, /const live = !!sessionId && editable;/);
    assert.ok(RV.includes('if (live) queueSlide(page, t);'));
    assert.ok(RV.includes('if (live) queueNote(page, t);'));
    assert.ok(RV.includes("sendToSession(`请按下面这几条改「${path}」（页号都是改之前的），一次改完、保存这个文件：\\n${handOff.join('\\n')}`);"));
    assert.match(RV, /window\.kiroApi\.deckWriteNote\?\.\(sessionId, path, page, res\.text, expectNote\)/);
  });
});

describe('积累模式：先标记，一次提交', () => {
  test('「把 comment 功能做成积累模式……不管在哪一处点确认按钮的时候一起提交修改」', () => {
    /* 每个框的「✓ 确认」和最下面的「提交」都是同一个 submitAll */
    assert.ok(RV.includes('onApply={() => submitFromBox(submitAll)}'));
    assert.ok(RV.includes('onClick={() => submitAll()}'));
    /* 框里空着也能按 —— 它提交的是别处的标记 */
    assert.ok(RV.includes('applyWhenEmpty={markCount > 0}'));
    assert.ok(RV.includes('applyLabel={confirmLabel}'));
    assert.match(CB, /disabled=\{!draft\.trim\(\) && !applyWhenEmpty\}/);
  });

  test('✕ 只是标记（↩ 取消），提交时才删；删不问模型', () => {
    assert.ok(RV.includes('if (gone) delete n[block.index]; else n[block.index] = true;'));
    assert.ok(RV.includes('for (const line of marks.drops) queueDelete(line);'));
    assert.match(RV, /writeBack\(base, deleteLines\(base, at\.from, at\.to\), `drop:\$\{at\.anchor\}`,/);
  });

  test('提交的顺序：＋ → ✎ → 💬 → ✕ → 整篇；落在标删整节里的意见作废；直接改过的那块不再让模型改', () => {
    const a = RV.indexOf("for (const [line, t] of marks.insert) queueText(line, t, 'insert');");
    const e = RV.indexOf('for (const [line, t] of marks.edit) queueEdit(line, t);');
    const b = RV.indexOf("for (const [line, t] of marks.revise) queueText(line, t, 'revise');");
    assert.ok(a > 0 && a < e && e < b, '＋ 在 ✎ 前面（＋ 按原文找位置），✎ 在 💬 前面');
    const c = RV.indexOf('for (const line of marks.drops) queueDelete(line);');
    const d = RV.indexOf('if (marks.whole) queueWhole(marks.whole);');
    assert.ok(a > 0 && a < b && b < c && c < d);
    assert.ok(RV.includes('revise: revise.filter(([l]) => !inDropped(l) && !edited.has(l)).sort(byLine),'));
    /* ✎ 不问模型：直接把这一块换成你写的那份 */
    assert.ok(RV.includes('const fullText = spliceLines(base, at.from, at.to, replacement.replace('));
  });

  test('收起的标记摆在那一段下面：点它接着改，✕ 去掉', () => {
    assert.ok(RV.includes("markChip(String(g.anchor), '💬', () => openBox('comment', g.anchor))"));
    assert.ok(RV.includes("title={t('Remove this mark')}"));
  });
});

describe('提交之后那条路', () => {
  test('先只要这一块，改不了才走 patch（只交回要换的那几处），带盘上此刻的正文', () => {
    assert.match(RV, /scope: 'block'/);
    assert.match(RV, /if \(res\?\.cannot\) \{/);
    assert.match(RV, /scope: 'patch',[\s\S]{0,120}full: base, fromLine: from, toLine: to,/);
    assert.doesNotMatch(RV, /scope: 'whole'/, '侧栏文本 comment 不再整篇重写');
    assert.doesNotMatch(RV, /mode: 'whole'/);
  });

  test('按闭区间取原文、按闭区间换回去 —— 段落之间的空行照带', () => {
    /* 按原文找那一块的范围搬进了 reviewBlocks.ts 的 locateBlock（纯的、有测试） */
    const RB = read('src/renderer/reviewBlocks.ts');
    assert.match(RB, /spanRange\(g && g\.span\.length > 1 \? g\.span : dropSpan\(baseBlocks, best\)\);/);
    assert.match(RV, /locateBlock\(base, anchorText, near\)/);
    assert.match(RV, /const where = sliceLines\(base, from, to\);/);
    assert.match(RV, /spliceLines\(base, from, to, String\(res\.text\)\)/);
  });

  test('同一份文件的改动串行，排队的那条读写完之后的正文', () => {
    assert.ok(RV.includes('void serialize(async () => {'));
    assert.ok(RV.includes('const base = currentText();'));
  });

  test('标记、没做成的原因、排着的条目都跟着行走（patch.keep）', () => {
    assert.ok(RV.includes("setDraftLive((cur) => remapKeyed(cur, patch.keep, ''));"));
    assert.ok(RV.includes('setApplyNote((cur) => remapKeyed(cur, patch.keep, key));'));
    assert.ok(RV.includes('remapReviewLines(path, patch.keep);'));
  });

  test('落盘之后在会话里报一句（KiroLex 自己说的，不发给模型）', () => {
    assert.match(RV, /window\.kiroApi\.sessionNote\?\.\(/);
  });

  test('没有「记下」：写了字就是标记', () => {
    assert.doesNotMatch(RV, /allowRecord/);
    assert.doesNotMatch(CB, /allowRecord|'记下'/);
    assert.match(CB, /if \(e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)\) \{ if \(onApply\) apply\(\); else commit\(\); \}/);
    assert.doesNotMatch(RV, /reviewPrompt|extraText/);
    assert.doesNotMatch(APP, /handleSendMessage\(prompt, undefined, fileViewer\.ownerSessionId\);\n\s*setCommenting\(false\);/);
  });

  test('＋ 在一段后面加：只要新内容，KiroLex 插到那一段（标题就是整节）后面', () => {
    assert.ok(RV.includes('rv-insert-btn'));
    assert.match(RV, /scope: 'insert',/);
    assert.match(RV, /const fullText = insertAfterLines\(base, to, String\(res\.text\)\);/);
  });

  test('排队：各自一个条目、各自显示、按原文找位置（行号挪了也找得到）', () => {
    assert.ok(RV.includes('const jobs = useReviewQueueForPath(path);'));
    assert.ok(RV.includes('removeReviewItem(ticket);'));
    assert.ok(read('src/renderer/reviewBlocks.ts').includes("if (b.kind !== 'line' || b.text !== anchorText) continue;"));
    assert.doesNotMatch(RV, /setApplyingAt\(/);
  });

  test('框顶上写明它管的是哪几行（「comment 功能没有选择行号」）', () => {
    assert.ok(RV.includes('<div className="rv-box-target">{header}</div>'));
    assert.ok(RV.includes("insert ? t('+ Add after {where}', { where }) : t('💬 Revise {where}', { where }),"));
  });

  test('最下面有对整篇的意见 + 提交，走 patch（不整篇重写）、KiroLex 写回', () => {
    assert.ok(RV.includes("label: t('{file} (whole document)', { file: fileName }), scope: 'patch', full: base,"));
    assert.ok(RV.includes("{markCount > 1 ? t('Submit ({n})', { n: markCount }) : t('Submit')}"));
  });
});

describe('样式挂在 .rv-review 下面', () => {
  test('按钮的定位和输入框在作用域里重新给 —— 不靠门留下的老规则', () => {
    assert.match(CSS, /\.rv-review \.rt-note-btn,\n\.rv-review \.rv-insert-btn,\n\.rv-review \.rv-edit-btn,\n\.rv-review \.rt-block-drop \{\n\s*position: absolute;/);
    assert.match(CSS, /\.rv-review \.rt-note \{[^}]*field-sizing: content;/);
    assert.match(CSS, /\.rv-review-toggle \{/);
    /* 老的提交区（`.rv-review-submit`）没了；`.rv-review-submitbar` 是钉在底部的那条 */
    assert.doesNotMatch(CSS, /\.rv-review-submit[\s.{:]/);
  });
});

test('提交那一行在**最新标的那一段**下面，不在底部单独钉一条（只标了删除时也有）', () => {
  assert.ok(!RV.includes('submitBar'), '底部那条钉住的提交去掉了');
  assert.ok(!CSS.includes('.rv-review-submitbar'));
  /* ✕ 也算"最新改的" —— 只标删除时提交按钮就挂在那一段下面 */
  assert.ok(RV.includes('if (!gone) bumpMark(`drop:${block.index}`);'));
  assert.ok(RV.includes('{on && !locked && submitHereText(g.anchor) && submitRow}'));
  assert.ok(RV.includes('{submitHerePage(page, false) && submitRow}'));
  assert.ok(RV.includes('{submitHerePage(page, true) && submitRow}'));
  /* 有框开着时不摆 —— 那个框里的「✓ 确认」就是它 */
  assert.ok(RV.includes('if (!latestMark || anyBoxOpen || markCount === 0) return false;'));
});

test('重启后恢复：comment 标记按文件存、按原文重新对位；侧栏开合、分组折叠、comment 模式也恢复；设置里可关', () => {
  const R = fs.readFileSync(path.join(process.cwd(), 'src/renderer/uiRestore.ts'), 'utf8');
  const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');
  const SD = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/SettingsDialog.tsx'), 'utf8');
  assert.ok(R.includes("return !raw || JSON.parse(raw)?.[RESTORE_SETTING_KEY] !== false;"), '默认开');
  assert.ok(R.includes('if (on && value !== null) uiSet(key, value); else uiRemove(key);'), '关着只活过 reload');
  assert.ok(RV.includes('const m = loadMarks(path, isDeck ? null : text);'));
  assert.ok(RV.includes('if (b.kind !== \'line\' || b.text !== want) continue;'), '按原文找它现在在哪一行');
  assert.ok(SB.includes('restoreSet(COLLAPSED_KEY, JSON.stringify([...collapsed]));'));
  assert.ok(APP.includes("useState(() => restoreGet('kirolex-sidebar-hidden') === '1')"));
  /* comment 模式按文件记（「这个按钮应该只影响当前文件」），也跟着恢复 */
  assert.ok(APP.includes("const saved = restoreGetJson<unknown>('kirolex-commenting-paths');"));
  assert.ok(APP.includes('const commenting = !!fileViewer && commentingPaths.includes(fileViewer.path);'));
  assert.ok(APP.includes('onClick={toggleCommenting}'));
  assert.ok(!APP.includes('setCommenting('), '没有全局开关了');
  assert.ok(SD.includes("{ key: 'restoreUiState', store: 'settings', group: 'Interface',"));
});

test('md 的 comment 模式左侧显示行号（和「第 N 行」同一个数；围栏组写起止）', () => {
  assert.ok(RV.includes('<span className="rv-line-no" aria-hidden="true">'));
  /* 代码块只写起始行（起止在框顶上） */
  assert.ok(RV.includes('                  {g.anchor}\n                </span>'));
  /* 行号那一栏和正文的缩进跟着字号走 */
  assert.ok(CSS.includes('.rv-review-blocks:has(.rv-line-no) .rv-review-block { padding-left: calc(var(--chat-font-size, 12px) * 2.2 + 6px); }'));
  /* 竖直位置按**第一行真正排出来的那一行**量，居中在它上面（大字号、标题都对得上） */
  assert.ok(RV.includes('writes.push([no, `${Math.round(r.top + r.height / 2 - liTop - no.offsetHeight / 2)}px`]);'));
  /* 整个 comment 视图往左挪，吃掉预览栏的左内边距 —— 行号贴边 */
  assert.ok(CSS.includes('.workspace-file-modal-body > .rv-review:has(.rv-line-no) { margin-left: -12px; }'));
  /* 显眼：粗体、和正文不同的颜色、不打透明度（「跟你说了加粗并换个颜色」） */
  const rule = /\.rv-line-no \{[^}]*\}/.exec(CSS)?.[0] || '';
  assert.ok(rule.includes('font-weight: 700;') && rule.includes('color: var(--line-no-color, #e0a458);') && !rule.includes('opacity'), rule);
});

test('两侧的折叠按钮一样大、一直看得见；右侧是贴边的按钮，不是一整条侧栏', () => {
  assert.ok(APP.includes('className="side-collapse-btn sidebar-collapse-btn"'));
  assert.ok(APP.includes('className="side-collapse-btn file-collapse-btn"'));
  assert.ok(!APP.includes('file-panel-reveal') && !CSS.includes('.file-panel-reveal'));
  const rule = /\.side-collapse-btn \{[^}]*\}/.exec(CSS)?.[0] || '';
  /* 宽度保持原来的 10px（「你把按钮变得太宽了」），长度 56px；不再 hover 才显形 */
  assert.ok(rule.includes('width: 10px;') && rule.includes('height: 56px;') && rule.includes('opacity: .7;'), rule);
});

test('reload 之后 comment 侧栏还在：标签连同主人会话一起存、一起开回来；开回来的过程中不存半截', () => {
  assert.ok(APP.includes('...(t.ownerSessionId ? { owner: t.ownerSessionId } : {}),'));
  /* 滚动位置按路径一起存（开回来停在原处，见 tabScroll.ts） */
  assert.ok(APP.includes('...(scroll > 0 ? { scroll } : {}),'));
  assert.ok(APP.includes('await openFileInApp(t.path, t.owner || ownerFromPath(t.path));'));
  assert.ok(APP.includes('if (!tabsRestoredRef.current || tabsRestoringRef.current) return;'));
  const m = /export function ownerFromPath[\s\S]*?const m = (\/.*\/)\.exec/.exec(APP);
  assert.ok(m, 'ownerFromPath 在');
  const re = eval(m![1]);
  assert.equal(re.exec(String.raw`C:\Users\kyn06\.kirolex\sessions\s_1789374701926_1lvm9f\files\blog-draft-v5.md`)?.[1], 's_1789374701926_1lvm9f');
  assert.equal(re.exec('/home/x/notes/a.md'), null);
});

test('右侧 comment 栏拖宽有上限：窗口宽 − 侧栏 − 会话区最小宽度（Windows 宽屏上不再把左边挤没）', () => {
  /* 会话区最少留 240（Mac 小屏上 review 栏要能拉得更宽） */
  assert.ok(APP.includes('const CHAT_MIN_WIDTH = 240;'));
  assert.ok(APP.includes('const fileViewerMax = filePanelMax({ winWidth, sidebarShownWidth: sidebarHidden ? 0 : sidebarWidth, chatMin: CHAT_MIN_WIDTH, panelMin: FILE_PANEL_MIN });'));
  /* 侧栏「实际收没收」= 用户收起 或 窗口放不下时临时让位（panelFit.ts） */
  assert.ok(APP.includes('const sidebarHidden = sidebarCollapsed || autoFold.sidebar;'));
  assert.ok(APP.includes('const newWidth = Math.max(FILE_PANEL_MIN, Math.min(fileViewerMax, startWidth + startX - ev.clientX));'));
  /* 显示也夹住 —— 窗口变窄 / 侧栏打开时不越界 */
  assert.ok(APP.includes('style={{ width: fileViewerShown }}>'));
});

test('写完的标记有 ✎ 修改按钮；预览栏能藏起来（标签留着，贴边那个按钮放回来，点开文件也放回来）', () => {
  assert.ok(RV.includes("title={t('Edit this mark')} onClick={reopen}>✎</button>"));
  assert.ok(APP.includes('if (previewHidden) { setFileViewerHidden(false); setPanelPins((p) => ({ ...p, previewAt: winWidth })); }'));
  assert.ok(APP.includes('else setFileViewerHidden(true);'));
  assert.ok(APP.includes('if (!tabsRestoringRef.current) setFileViewerHidden(false);'));
  assert.ok(APP.includes("restoreSet('kirolex-fileviewer-hidden', fileViewerHidden ? '1' : null);"));
});

test('排着的改写在会话的队列旁边看得见、能取消；取消按 ticket，只停那一次改写', () => {
  const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  assert.ok(CA.includes('{!readOnly && <ReviewQueueStack sessionId={currentSessionId} />}'));
  assert.ok(RV.includes("id: ticket, sessionId: sessionId || '', path, file: fileName, kind, line,"));
  assert.ok(RV.includes('if (running) void window.kiroApi.reviewCancel?.(ticket).catch?.(() => {});'));
  /* 没轮到的不发，标记放回去 */
  assert.ok(RV.includes('if (cancelledTickets.has(ticket)) { restore(); return false; }'));
  /* 主进程：只有它自己在等回复时才停那一轮 —— 不会误停你的对话 */
  assert.ok(M.includes("ipcMain.handle('review:cancel', async (_event, ticket: string) => {"));
  assert.ok(M.includes('if (t.asking && askWaiters.has(t.sessionId)) {'));
});

test('提交了还没写完的照标记存着：窗口 reload / 重启回来时放回去，说一句"上次没做完"', () => {
  assert.ok(RV.includes('interrupted.push(k);'));
  assert.ok(RV.includes("}, [draftLive, dropped, wholeDraft, markOrder, path, jobs]);"));
  assert.ok(RV.includes("initialMarks.interrupted.map((k) => [k, t('The last submission didn\\'t finish (interrupted by a window reload or restart). The marks are back; submit again.')]),"));
  /* 每一类都带着自己的标记形状 */
  for (const s of ["{ key, text: instruction }", "{ key: `drop:${anchor}`, text: '' }", "{ key: 'whole', text: note }", "{ key: String(page), text: instruction }"]) {
    assert.ok(RV.includes(s), s);
  }
});

test('远程会话的模型下拉：远端清单没回来之前用缓存，没有缓存就给空 —— 绝不拿本机清单去比（「claude unavailable」）', () => {
  assert.ok(APP.includes("const cached = JSON.parse(uiGet(`kirolex-models:${machine}`) || '[]');"));
  assert.ok(APP.includes('if (!machine) return [];'));
  assert.ok(!APP.includes('return modelsByMachine[machine] || models;'));
});

test('✎ 直接在原文上改：框顶替那一块（原文不再另摆一份），改过没提交时显示改过的那份', () => {
  assert.ok(RV.includes("if (editHost !== null && editHost !== g.anchor) return null;"), '被那一块盖住的几行不单独显示');
  assert.ok(RV.includes('{editingHere ? editBox(g.anchor) : editedHere ? ('));
  assert.ok(RV.includes("<span className=\"rv-edited-tag\">{t('✎ Edited directly (not submitted)')}</span>"));
  /* 框不再挂在那一块下面 */
  assert.ok(RV.includes('  const boxFor = (line: number) => {\n    const anchor = openAt ?? insertAt;'));
});

test('comment 开关一直浮在上方（sticky、实底）；文件路径换成看得清的颜色', () => {
  const rule = /\.rv-review-toggle \{[^}]*\}/.exec(CSS)?.[0] || '';
  assert.ok(rule.includes('background: var(--bg-secondary);'), rule);
  /* 钉住的是整条、贴到上沿（吃掉滚动容器的上内边距），那一行不透字 */
  const bar = /\.rv-toggle-bar \{[^}]*\}/.exec(CSS)?.[0] || '';
  assert.ok(bar.includes('position: sticky; top: -10px;') && bar.includes('background: var(--bg-secondary);'), bar);
  assert.ok(APP.includes('<div className="rv-toggle-bar">'));
  const pathRule = /\.workspace-viewer-path \{[^}]*\}/.exec(CSS)?.[0] || '';
  assert.ok(pathRule.includes('color: var(--path-color, #7fb2e5);') && !pathRule.includes('var(--text-muted)'), pathRule);
});

test('打字不卡：每块的 Markdown 按内容 memo；存盘停 0.4 秒才写（卸掉时补写）；行号一帧量一次、先读后写', () => {
  assert.ok(RV.includes('const MdBlock = memo(({ md }: { md: string }) => <MarkdownView content={md} />);'));
  assert.ok(RV.includes('<MdBlock md={md} />'));
  assert.ok(RV.includes('const timer = window.setTimeout(run, 400);'));
  assert.ok(RV.includes('useEffect(() => () => { pendingSave.current?.(); pendingSave.current = null; }, []);'));
  assert.ok(RV.includes('frame = requestAnimationFrame(() => { frame = 0; place(); });'));
  assert.ok(RV.includes('for (const [el, top] of writes) if (el.style.top !== top) el.style.top = top;'));
  assert.ok(RV.includes('if (!shouldBumpMark(markOrder, key, lastBumped.current)) return;'));
});

test('✎ 改的时候和没改时字号、字体、行距一样，字不挪位置', () => {
  const rule = /\.rv-review \.rv-edit-slot \.rt-note \{[^}]*\}/.exec(CSS)?.[0] || '';
  assert.ok(rule.includes('font-family: inherit; font-size: var(--chat-font-size, 12px); line-height: 1.75;'), rule);
  assert.ok(!CSS.includes('.rv-edit-slot .rt-note { font-family: var(--mono-font'));
  assert.ok(CSS.includes('.rv-review .rv-edited { box-shadow: -6px 0 0 -4px var(--accent); }'));
});

test('队列状态和串行链、正文都按文件记（不按 pane）：pane 重挂上不会把还在跑的当成"没做完"再放回来', () => {
  const Q = fs.readFileSync(path.join(process.cwd(), 'src/renderer/reviewQueue.ts'), 'utf8');
  assert.ok(Q.includes('export function useReviewQueueForPath(path: string): ReviewQueueItem[] {'));
  assert.ok(RV.includes('const jobs = useReviewQueueForPath(path);'));
  assert.ok(RV.includes('const next = (chains.get(path) || Promise.resolve()).then(job, job);'));
  assert.ok(RV.includes('const base = currentText();'));
  assert.ok(!RV.includes('const base = textRef.current;'));
  /* 还活着的那些不算 interrupted，也不放回标记 */
  assert.ok(RV.includes('const live = new Set(liveReviewItems(path).filter((i) => i.persist?.key).map((i) => liveMarkKey(i)));'));
  /* 后台那条的 setter 落到此刻挂着的 pane 上 */
  assert.ok(RV.includes('const livePane = (): PaneApi => paneApis.get(path) ?? own;'));
});

test('刷新之后标签（review 侧栏）开回来：开回来之前不存（原来先跑的那次存把单子删了）', () => {
  assert.ok(APP.includes('if (!tabsRestoredRef.current || tabsRestoringRef.current) return;'));
});
