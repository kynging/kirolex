/**
 * **已经说出口的话，切了语言也要跟着换** —— 审查意见：中文下写进会话的 KiroLex 提示，切到英文、
 * 甚至重新打开后仍是中文；拼接出来的组合提示拿不到双语版本；deck 脚本的报错是写死的中文。
 *
 * 守的是三件事：
 *   1. KiroLex 自己写进会话的提示落盘时带上中英两版（`variants`），显示时按当前语言挑；重新加载
 *      （从 transcript 读回来）也带着；你和 agent 的消息没有这一项，原样显示。
 *   2. 拼接（`trConcat`）和列表（`trList`）也认得出两种语言 —— 不只是单次 `tr()` 的整句。
 *   3. deck 脚本那几句中文报错在英文界面下是英文。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bothLangs, pickVariant, setUiLang, textVariants, tr, trConcat, trList, uiLang } from '../src/main/uiText.ts';
import { NOTE_DETAIL_SEP } from '../src/main/kirolexNote.ts';
import { localizeScriptError, parseSlideRuns, parseWriteNote } from '../src/main/deckPreview.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');

function inLang<T>(lang: 'zh' | 'en', fn: () => T): T {
  const before = uiLang();
  setUiLang(lang);
  try { return fn(); } finally { setUiLang(before); }
}

describe('拼接 / 列表出来的提示也有两种语言', () => {
  test('地域过滤那一支：两句 tr() 拼起来，切到英文整句都是英文', () => {
    const text = inLang('zh', () => trConcat(
      tr('⚠️ This machine has no model "{wanted}", so this session uses "{model}" instead.', { wanted: 'claude-opus-5', model: 'gpt-5.6-sol' }),
      NOTE_DETAIL_SEP,
      tr('Available here: {list}{more}', { list: trList(['gpt-5.6-sol', 'gpt-5.6-terra']), more: '' }),
      tr('\nNo Claude model and no `auto` in the list: usually your outbound IP is region-filtered (switching kiro-cli versions won\'t help). To use Claude, move this session to a remote machine.'),
    ));
    assert.match(text, /本机没有模型「claude-opus-5」，这条会话改用「gpt-5.6-sol」/);
    assert.match(text, /gpt-5\.6-sol、gpt-5\.6-terra/);
    const both = bothLangs(text);
    assert.ok(both, '拼出来的整句要认得');
    assert.equal(both!.zh, text);
    assert.match(both!.en, /^⚠️ This machine has no model "claude-opus-5"/);
    assert.match(both!.en, /gpt-5\.6-sol, gpt-5\.6-terra/, '列表分隔符也要换成英文的');
    assert.match(both!.en, /outbound IP is region-filtered/);
    assert.ok(both!.en.includes(NOTE_DETAIL_SEP), '详情分隔符原样留在两版里');
    assert.doesNotMatch(both!.en, /[一-鿿、]/, '英文那版不许残留中文');
  });

  test('textVariants：认得出就给两版，认不出就是 undefined（调用方原样存）', () => {
    const t1 = inLang('zh', () => tr('Quit'));
    assert.deepEqual(textVariants(t1), { zh: '退出', en: 'Quit' });
    assert.equal(textVariants('你自己写的一句话'), undefined);
  });

  test('pickVariant：有两版按语言挑；没有（旧记录、你和 agent 的消息）原样显示', () => {
    const v = { zh: '已排队', en: 'Queued' };
    assert.equal(pickVariant('en', '已排队', v), 'Queued');
    assert.equal(pickVariant('zh', 'Queued', v), '已排队');
    assert.equal(pickVariant('en', '原文', undefined), '原文');
    assert.equal(pickVariant('en', '原文', { zh: 1, en: null } as any), '原文', '坏数据不许让界面空白');
  });
});

describe('KiroLex 写进会话的提示：落盘带两版，显示按语言挑', () => {
  const M = read('src', 'main', 'index.ts');
  const ACP = read('src', 'renderer', 'hooks', 'useAcp.ts');
  const CA = read('src', 'renderer', 'components', 'ChatArea.tsx');

  test('noteInSession 落盘时带上 variants（主进程 tr() 出来的提示）', () => {
    const at = M.indexOf('function noteInSession(');
    assert.ok(at > 0);
    const body = M.slice(at, at + 2600);
    assert.match(body, /textVariants\(text\)/);
    assert.match(body, /store\.appendMessage\(sid, \{[^}]*kirolex: true[^}]*\.\.\.\(v \? \{ variants: v \} : \{\}\)/);
  });

  test('渲染层发起的提示（session:note / acp:persist-note）可以把两版一起交给主进程', () => {
    assert.match(M, /ipcMain\.handle\('session:note', async \(_event, sessionId: string, text: string, variants\?: unknown\)/);
    assert.match(M, /ipcMain\.handle\('acp:persist-note', async \(_event, sessionId: string, text: string, variants\?: unknown\)/);
  });

  test('重新加载：从 transcript 读回消息的每一处都把 variants 带上（和 kirolex 标记一样多）', () => {
    const kirolexPass = (ACP.match(/\.\.\.\(\(m as any\)\.kirolex \? \{ kirolex: true as const \} : \{\}\),/g) || []).length;
    const variantsPass = (ACP.match(/\.\.\.\(asVariants\(\(m as any\)\.variants\) \? \{ variants: asVariants\(\(m as any\)\.variants\) \} : \{\}\),/g) || []).length;
    assert.ok(kirolexPass >= 4, `应该有至少 4 处读回点，实际 ${kirolexPass}`);
    assert.equal(variantsPass, kirolexPass, '有一处读回点漏了 variants —— 那条路重新打开后会显示生成时的语言');
  });

  test('显示：分组渲染之前按当前语言挑一版（KiroLex 卡片和循环结束那条都走这里），语言一变就重算', () => {
    const at = CA.indexOf('const orderedMessages = useMemo<Message[]>(() => {');
    assert.ok(at > 0);
    const body = CA.slice(at, at + 1800);
    assert.match(body, /variantView\(m, findLang\)/);
    assert.match(CA, /return views\[lang\] \?\?= \{ \.\.\.m, content: pickVariant\(lang, m\.content, m\.variants\) \};/);
    assert.match(body, /\}, \[messages, findLang\]\);/);
    // 分组用的正是挑过的那一份
    assert.match(CA, /const messages = orderedMessages;/);
  });
});

describe('deck 脚本的报错跟着界面语言', () => {
  test('英文界面：脚本的中文报错换成英文', () => {
    inLang('en', () => {
      assert.equal(localizeScriptError('页码超出范围'), 'Page number out of range');
      assert.equal(localizeScriptError('给的地址在这一页上都不存在'), 'None of the given addresses exist on this page');
      assert.equal(localizeScriptError('一条都没做成：指令都不认识'), 'None of the edits went through: none of the instructions were recognized');
      assert.equal(localizeScriptError('一条都没做成：set-size 1.0.0: bad；move: oops'), 'None of the edits went through: set-size 1.0.0: bad; move: oops');
      // 解析器把脚本失败交回去时也是英文
      const r = parseSlideRuns(JSON.stringify({ ok: false, error: '页码超出范围' }));
      assert.deepEqual(r, { ok: false, error: 'Page number out of range' });
      const w = parseWriteNote(JSON.stringify({ ok: false, error: '页码超出范围' }));
      assert.deepEqual(w, { ok: false, error: 'Page number out of range' });
    });
  });

  test('中文界面：原样（一字不差）；不认识的报错（Python 异常原文）原样', () => {
    inLang('zh', () => {
      assert.equal(localizeScriptError('页码超出范围'), '页码超出范围');
      assert.equal(localizeScriptError('一条都没做成：指令都不认识'), '一条都没做成：指令都不认识');
      assert.equal(localizeScriptError('一条都没做成：move: oops'), '一条都没做成：move: oops');
    });
    inLang('en', () => assert.equal(localizeScriptError("KeyError: 'x'"), "KeyError: 'x'"));
  });
});

describe('还挂着的状态行 / 后台会话恢复：切语言后也是当前语言', () => {
  test('活动状态行：生成时是中文，切到英文显示英文；占位符里嵌的译文一起换', async () => {
    const { t, pinShown, shownIn } = await import('../src/renderer/i18n.ts');
    const text = t('zh', 'Sent, waiting for {engine} to respond…', { engine: 'Claude Code' });
    assert.equal(text, '已发送，等待 Claude Code 响应…');
    pinShown(text);
    assert.equal(shownIn('en', text), 'Sent, waiting for Claude Code to respond…');
    assert.equal(shownIn('zh', text), text);
    // 带占位符的
    const retry = t('zh', '⟳ Resending the unfinished turn automatically… (attempt {n}/{max})', { n: 2, max: 10 });
    pinShown(retry);
    assert.equal(shownIn('en', retry), '⟳ Resending the unfinished turn automatically… (attempt 2/10)');
    // 主进程那边翻好的（例如重建进度）：把它带过来的两版钉上
    pinShown('⏳ 重建历史上下文 1/3…', { zh: '⏳ 重建历史上下文 1/3…', en: '⏳ Rebuilding history context 1/3…' });
    assert.equal(shownIn('en', '⏳ 重建历史上下文 1/3…'), '⏳ Rebuilding history context 1/3…');
    // 认不出的原样
    assert.equal(shownIn('en', '别处来的原文'), '别处来的原文');
    assert.equal(shownIn('en', null), null);
  });

  test('接线：设状态时钉住两版；显示（当前会话和分屏后台会话）都按当前语言取', () => {
    const ACP = read('src', 'renderer', 'hooks', 'useAcp.ts');
    const CA = read('src', 'renderer', 'components', 'ChatArea.tsx');
    const M = read('src', 'main', 'index.ts');
    const at = ACP.indexOf('const setSessionActivity = (');
    assert.ok(at > 0);
    assert.match(ACP.slice(at, at + 600), /if \(text\) pinShown\(text, variants\);/);
    // 分屏后台会话和当前会话走的是同一个显示点（ChatArea 那一行）
    assert.match(CA, /<span className="activity-status-text">\{shownIn\(findLang, activityStatus\)\}<\/span>/);
    // 主进程的重建进度（priming detail）带两版过来
    assert.match(M, /send\('acp:session-busy', \{ sessionId, reason, detail, \.\.\.\(detailVariants \? \{ detailVariants \} : \{\}\) \}\)/);
  });

  test('historyBeforeNotice（没缓存的后台会话先读历史）：保留 variants，坏的丢掉', async () => {
    const { historyBeforeNotice } = await import('../src/renderer/connectFailure.ts');
    const v = { zh: '✅ 已按意见改了这份文件', en: '✅ Revised this file as commented' };
    const msgs = await historyBeforeNotice(undefined, async () => [
      { id: 'a', role: 'user', content: v.zh, ts: 1, kirolex: true, variants: v },
      { id: 'b', role: 'user', content: '坏数据', ts: 2, kirolex: true, variants: { zh: 1 } },
      { id: 'c', role: 'user', content: '你说的话', ts: 3 },
    ]);
    assert.ok(msgs);
    assert.deepEqual(msgs![0].variants, v);
    assert.equal(msgs![1].variants, undefined, '形状不对的 variants 不许带进来');
    assert.equal(msgs![2].variants, undefined);
    assert.equal(msgs![0].kirolex, true);
  });
});

describe('连接失败那条提示：切语言后整句（含主进程给的原因）都是当前语言', () => {
  test('messageVariants：主进程 tr() 出来、经 IPC 只剩一段文字的报错，也能按模板认回两版', async () => {
    const { messageVariants } = await import('../src/renderer/i18n.ts');
    const { trIn } = await import('../src/main/uiText.ts');
    const zh = trIn('zh', 'Remote target {id} not found (was it removed in Settings?). KiroLex did not guess a machine.', { id: 'gpu-box' });
    const v = messageVariants(zh);
    assert.ok(v, '中文报错要认得出');
    assert.equal(v!.zh, zh);
    assert.equal(v!.en, 'Remote target gpu-box not found (was it removed in Settings?). KiroLex did not guess a machine.');
    // Electron 包的那层前缀原样留着，后面那句照样换
    const wrapped = `Error invoking remote method 'acp:new-session': Error: ${zh}`;
    assert.equal(messageVariants(wrapped)!.en, `Error invoking remote method 'acp:new-session': Error: ${v!.en}`);
    // 系统 / 网络原文（不是 KiroLex 说的）认不出 —— 不猜
    assert.equal(messageVariants('connect ECONNREFUSED 127.0.0.1:22'), undefined);
  });

  test('connectFailureNotice：中文下失败，切到英文显示整句英文（换机器重连那条路）', async () => {
    const { connectFailureNotice } = await import('../src/renderer/connectFailure.ts');
    const { pickVariant, trIn } = await import('../src/main/uiText.ts');
    const why = trIn('zh', 'Cannot connect to this session. Click it to connect, then try again');
    const n = connectFailureNotice(why, 1, 'zh');
    assert.match(n.content, /^⚠️ 这条会话没连上：/);
    assert.equal(pickVariant('en', n.content, n.variants), "⚠️ This chat couldn't connect: Cannot connect to this session. Click it to connect, then try again");
    assert.equal(pickVariant('zh', n.content, n.variants), n.content);
    // 原因是系统原文（ECONNREFUSED）：前缀换语言，原因原样
    const raw = connectFailureNotice('ECONNREFUSED', 2, 'zh');
    assert.equal(pickVariant('en', raw.content, raw.variants), "⚠️ This chat couldn't connect: ECONNREFUSED");
  });

  test('新建会话连不上那条路也走 connectFailureNotice（不再自己拼一句只翻前缀的）', () => {
    const ACP = read('src', 'renderer', 'hooks', 'useAcp.ts');
    const at = ACP.indexOf('const createPromise = (async (): Promise<string> =>');
    assert.ok(at > 0);
    const body = ACP.slice(at, at + 3200);
    assert.match(body, /connectFailureNotice\(why, Date\.now\(\), uiLangNow\(\)\)/);
    assert.doesNotMatch(ACP, /content: `\$\{t\("⚠️ This chat couldn't connect: "\)\}\$\{why\}`/);
  });
});

describe('错误横幅：中文下报的错，切到英文显示英文（系统原文不动）', () => {
  test('noteError 记错误时钉住整句两版（含主进程给的原因），切语言后取当前语言', async () => {
    const { t, messageVariants, pinShown, shownIn } = await import('../src/renderer/i18n.ts');
    const { trIn } = await import('../src/main/uiText.ts');
    // 渲染层自己的兜底文案（中文下切换模型失败）
    const own = t('zh', 'Failed to switch model');
    pinShown(own, messageVariants(own));
    assert.equal(shownIn('en', own), 'Failed to switch model');
    // 主进程 tr() 出来、经 IPC 只剩文字的原因
    const zhMain = trIn('zh', 'Wait for the current response to finish before switching models.');
    const wrapped = `Error invoking remote method 'acp:set-model': Error: ${zhMain}`;
    pinShown(wrapped, messageVariants(wrapped));
    assert.equal(shownIn('en', wrapped), "Error invoking remote method 'acp:set-model': Error: Wait for the current response to finish before switching models.");
    assert.equal(shownIn('zh', wrapped), wrapped);
    // 系统原文：认不出，原样
    pinShown('spawn ENOENT', messageVariants('spawn ENOENT'));
    assert.equal(shownIn('en', 'spawn ENOENT'), 'spawn ENOENT');
  });

  test('接线：noteError 钉两版；两处错误横幅都按当前语言显示', () => {
    const ACP = read('src', 'renderer', 'hooks', 'useAcp.ts');
    const CA = read('src', 'renderer', 'components', 'ChatArea.tsx');
    const at = ACP.indexOf('const noteError = useCallback(');
    assert.ok(at > 0);
    assert.match(ACP.slice(at, at + 500), /if \(message\) pinShown\(message, messageVariants\(message\)\);/);
    assert.equal((CA.match(/\{bannerText\(shownIn\(findLang, connectionError\) \?\? ''\)\}/g) || []).length, 2, '有消息时的横幅和空会话那一处都要按语言取');
    assert.doesNotMatch(CA, /\{connectionError\}/);
  });
});

describe('原始错误 + KiroLex 的说明拼成的一段：跨 IPC、切语言后说明部分换语言，原始错误不动', () => {
  test('retriesExhaustedNote：中文下生成，隔着 IPC（只剩文字）切到英文', async () => {
    const { messageVariants, pinShown, shownIn } = await import('../src/renderer/i18n.ts');
    const { retriesExhaustedNote } = await import('../src/main/promptRetry.ts');
    const { bothLangs } = await import('../src/main/uiText.ts');
    const zh = inLang('zh', () => retriesExhaustedNote('Internal error', 3));
    assert.match(zh, /^Internal error\n\n/);
    assert.match(zh, /[一-鿿]/);
    // 主进程这一侧：整段认得出（trConcat）
    assert.match(bothLangs(zh)!.en, /^Internal error\n\n\(Resent automatically 3 times/);
    // 渲染层这一侧：经 IPC 只剩 `Error invoking remote method …: Error: <整段>` 这串文字
    const wire = `Error invoking remote method 'acp:prompt': Error: ${zh}`;
    pinShown(wire, messageVariants(wire));
    const en = shownIn('en', wire)!;
    assert.match(en, /^Error invoking remote method 'acp:prompt': Error: Internal error\n\n\(Resent automatically 3 times/);
    assert.doesNotMatch(en, /[一-鿿]/, '英文那版不许残留中文');
    assert.equal(shownIn('zh', wire), wire);
  });

  test('后面再追加一段 kiro-cli 的原话（cliWhy）：认得的段换，认不出的段原样', async () => {
    const { messageVariants } = await import('../src/renderer/i18n.ts');
    const { retriesExhaustedNote } = await import('../src/main/promptRetry.ts');
    const zh = inLang('zh', () => retriesExhaustedNote('Internal error', 2)) + '\n\nERROR chat: model overloaded (raw cli log)';
    const v = messageVariants(zh)!;
    assert.ok(v);
    assert.match(v.en, /^Internal error\n\n\(Resent automatically 2 times/);
    assert.match(v.en, /\n\nERROR chat: model overloaded \(raw cli log\)$/);
    assert.equal(v.zh, zh);
  });

  test('占位符可以是空的（例如 {hint} 没有内容时）也认得', async () => {
    const { messageVariants } = await import('../src/renderer/i18n.ts');
    const { trIn } = await import('../src/main/uiText.ts');
    const zh = trIn('zh', '(This turn had already run {n} tool call(s){hint}, so it was not resent automatically, to avoid running them twice. Press Rerun or send a new message.)', { n: 3, hint: '' });
    assert.match(messageVariants(zh)!.en, /^\(This turn had already run 3 tool call\(s\), so it was not resent/);
  });
});

describe('自动更换后端会话那句（主句 + 详情）落盘带两版，重新打开 / 切语言都跟着换', () => {
  test('trConcat 拼出来的整句认得出两版；落盘后按语言显示', async () => {
    const { textVariants, trConcat, pickVariant } = await import('../src/main/uiText.ts');
    const note = inLang('zh', () => trConcat(
      tr('🔀 This conversation failed {n} times in a row ({err}), so it moved to a new backend session with the context carried over.', { n: 3, err: 'Internal error' }),
      NOTE_DETAIL_SEP,
      tr('The process (pid) did not change, so the session had not expired: most likely the history itself is what fails (often a tool result). New backend session: {id}…. The conversation is unchanged.', { id: 'abcd1234' })));
    const v = textVariants(note);
    assert.ok(v, '整句（主句 + 详情）要认得出两版 —— 落盘时就带上 variants');
    assert.match(v!.en, /^🔀 This conversation failed 3 times in a row \(Internal error\)/);
    assert.match(v!.en, /New backend session: abcd1234…/, '后端会话 id 在详情里');
    // 模拟落盘再读回（JSON 往返）后，按语言显示
    const stored = JSON.parse(JSON.stringify({ content: note, kirolex: true, variants: v }));
    assert.equal(pickVariant('en', stored.content, stored.variants), v!.en);
    assert.equal(pickVariant('zh', stored.content, stored.variants), note);
  });

  test('接线：index.ts 用 trConcat 拼那句（主句 + 详情），不再用模板字符串', () => {
    const M = read('src', 'main', 'index.ts');
    assert.match(M, /trConcat\(\s*tr\('🔀 This conversation failed \{n\} times in a row/);
    assert.match(M, /if \(poisoned\) \{\s*\n\s*noteInSession\(sessionId, note, undefined, 'backend-session-swap'\);/);
    assert.doesNotMatch(M, /noteInSession\(sessionId, `♻️ \$\{note\}`\);/);
  });
});
