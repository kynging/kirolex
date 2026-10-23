/**
 * **会话内提示放在哪** —— 写法见 `docs/notices-glossary.md`，逐条清单见 `docs/notices-audit.md`。
 *
 *   · 只需知道、不用操作的（已排队、已拒绝打开一个链接、切换已生效）→ 状态行（`sessionNotice`），
 *     几秒后淡出，**不进对话记录**；
 *   · 需要你决定或影响结果的（换了模型 / 后端会话、忙时选的切换没生效）→ 对话记录（`noteInSession`）。
 *
 * 守的是接线：状态行那条路根本不碰 transcript；被降为状态行的那几句走的确实是它。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');
const M = read('src', 'main', 'index.ts');

/** 从 `function name(` 开始截到下一个顶层 `function `（够用：这几个函数都不长） */
function fnBody(src: string, name: string): string {
  const at = src.search(new RegExp(`function ${name}[(<]`));
  assert.ok(at >= 0, `${name} 不见了 —— 改了名就更新这里`);
  const next = src.indexOf('\nfunction ', at + 10);
  return src.slice(at, next > 0 ? next : at + 3000);
}

/** 某句提示（英文 key 的开头）所在的那一行 */
function lineOf(src: string, keyHead: string): string {
  const at = src.indexOf(keyHead);
  assert.ok(at >= 0, `找不到提示「${keyHead}」`);
  const start = src.lastIndexOf('\n', at) + 1;
  return src.slice(start, src.indexOf('\n', at));
}

describe('状态行提示不进对话记录', () => {
  test('sessionNotice / stickySessionNotice 只发 session:notice 事件，不写 transcript', () => {
    for (const name of ['sessionNotice', 'stickySessionNotice']) {
      const body = fnBody(M, name);
      assert.match(body, /send\('session:notice'/, `${name} 要发给状态行`);
      assert.doesNotMatch(body, /appendMessage|noteInSession|acp:user-message/, `${name} 不许进对话记录`);
    }
  });

  test('对照：noteInSession 才写 transcript（标成 KiroLex 自己的话）', () => {
    const body = fnBody(M, 'noteInSession');
    assert.match(body, /store\.appendMessage\(sid, \{[^}]*kirolex: true/);
  });

  test('改写「已排队」降为状态行，而且两种原因合成了一句带参数的', () => {
    const body = fnBody(M, 'enqueueRevise');
    const uses = body.match(/tr\('⏳ Queued: \{label\} \(\{why\}\); it will be sent automatically\.'/g) || [];
    assert.equal(uses.length, 2, '两种原因（前面还有改写 / 会话正忙）用同一句');
    assert.doesNotMatch(body, /noteInSession\(/, '「已排队」只需知道，不进对话记录');
    assert.match(body, /sessionNotice\(sessionId, tr\('⏳ Queued:/);
  });

  test('拒绝打开非 http(s) 链接：和同组几句一样走状态行', () => {
    assert.match(lineOf(M, "tr('⚠️ Refused to open `{target}`"), /^\s*sessionNotice\(sessionId, /);
  });

  /*
    负责人反馈（2026-10-23）「后台让我在等，但会话没有提示」：等待本身要在对话里有一张卡片，
    所以它的收尾（已切到 / 已取消 / 没切成）也进对话记录，否则卡片看着像一直在等；
    执行中的过程（正在启动 / 正在交历史 / 这条消息会等切换）只需知道 → 状态行。
  */
  test('忙时选的切换：等待卡片和它的收尾进对话记录；执行中的过程走状态行', () => {
    assert.match(lineOf(M, "tr('⏳ This turn is still running; will switch to {target} once it finishes.'"), /^\s*noteInSession\(sessionId, /);
    assert.match(lineOf(M, "tr('✅ Switched to {target}.'"), /^\s*: tr\(/);
    assert.match(M, /const doneText = historyRidesAlong\s*\? tr\('✅ Switched to \{target\}\./);
    assert.match(M, /noteInSession\(sessionId, doneText, undefined, 'pending-switch-done'\);/);
    assert.match(lineOf(M, "tr('⚠️ Could not switch: {list}."), /^\s*const failText = tr\(/);
    assert.match(M, /noteInSession\(sessionId, failText, undefined,/);
    assert.match(lineOf(M, "tr('Switch cancelled; this session keeps its current setting.')"), /^\s*noteInSession\(sessionId, /);
    assert.match(M, /if \(startNote\) sessionNotice\(sessionId, startNote\);/);
    assert.match(lineOf(M, "tr('Handing the conversation history to the new backend…')"), /^\s*sessionNotice\(sessionId, /);
    assert.match(lineOf(M, "tr('⏳ This message will be sent once the switch finishes.')"), /^\s*sessionNotice\(sessionId, /);
  });

  test('换了模型 / 换了后端会话：进对话记录，诊断细节折进详情', () => {
    const swap = M.slice(M.indexOf("tr('🔀 Got no reply {n} times in a row") - 200, M.indexOf("tr('🔀 Got no reply {n} times in a row") + 600);
    assert.match(swap, /noteInSession\(sessionId, trConcat\(/);
    assert.match(swap, /NOTE_DETAIL_SEP/);
    assert.match(M, /if \(poisoned\) \{\s*\n\s*noteInSession\(sessionId, note, undefined, 'backend-session-swap'\);/);
  });
});

describe('界面：详情折叠 + 重复计数接上了', () => {
  const CA = read('src', 'renderer', 'components', 'ChatArea.tsx');
  const SN = read('src', 'renderer', 'hooks', 'useSessionNotice.ts');

  test('聊天区：相邻的同类 KiroLex 提示并成一条（collapseAdjacent，按 noteGroup，没有就按整句）', () => {
    assert.match(CA, /collapseAdjacent\(groups, \(g\) => \(g\.kind === 'kirolex' \? noticeKey\(\{ group: g\.message\.noteGroup, text: g\.message\.content \}\) : null\)\)/);
    assert.match(CA, /count=\{group\.count\}/);
  });

  test('状态行：还挂着时又来同一句只计数（mergeNotice），不换一条新的', () => {
    assert.match(SN, /setNotice\(\(prev\) => mergeNotice\(prev, next\)\)/);
    assert.match(CA, /<NoticeBody text=\{sessionNotice\.variants\?\.\[findLang\] \?\? sessionNotice\.text\} count=\{sessionNotice\.count\} \/>/);
  });

  test('「详情」从同一段文字里拆出来，折叠显示', () => {
    assert.match(CA, /const \{ main, detail \} = splitNoteDetail\(text\);/);
    assert.match(CA, /<details className="notice-detail">/);
  });

  test('用词表在 docs/ 里，代码里引用它', () => {
    assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', 'docs', 'notices-glossary.md')));
    assert.match(read('src', 'main', 'kirolexNote.ts'), /docs\/notices-glossary\.md/);
  });
});

describe('自动改用备用模型：进对话记录，说清实际用的是哪个', () => {
  test('接线：index.ts 用 ModelFallbackNotes（判据见 tests/modelFallbackNote.test.ts），写进对话记录带「类型:想要→实际」的 group', () => {
    assert.match(M, /import \{ ModelFallbackNotes \} from '\.\/modelFallbackNote\.ts';/);
    assert.match(M, /note: \(sid, text, group\) => noteInSession\(sid, text, undefined, group\),/);
    assert.match(M, /status: \(sid, text, group\) => sessionNotice\(sid, text, \{ group \}\),/);
    assert.match(M, /remoteText: \(host, wanted, used, models\) => trConcat\(tr\('⚠️ \{host\} has no model "\{wanted\}", so this session uses "\{fallback\}" instead\.', \{ host, wanted, fallback: used \}\)/);
  });

  test('远端（pickRemoteModel）连接之前只记下挑了什么，不写；连上之后按实际起来的模型写；全都起不来就作废', () => {
    const body = fnBody(M, 'pickRemoteModel');
    assert.match(body, /modelFallback\.remoteReset\(sessionId\);/);
    assert.match(body, /modelFallback\.remotePicked\(sessionId, wanted, host, models\);/);
    assert.doesNotMatch(body, /\bsessionNotice\(|noteInSession\(|modelFallback\.note\(/, '连上之前不说');
    const at = M.indexOf('await client.connect();\n      /*\n        **本机清单里没有你选的模型**');
    const loop = M.slice(at, at + 2600);
    assert.match(loop, /if \(modelFallback\.hasRemotePick\(sessionId\)\) modelFallback\.remoteStarted\(sessionId, model\);/, '按候选循环里真正起来的 model 说');
    assert.match(M, /if \(sessionId\) modelFallback\.remoteFailed\(sessionId\);\s*\n\s*throw lastError/);
    /* 换机器那条路不走候选循环：连上之后同样按实际的说 */
    assert.match(M, /await client\.connect\(\);[\s\S]{0,400}if \(target && engineOf\(profile\) === 'kiro'\) modelFallback\.remoteStarted\(sessionId, profile\.model\);/);
  });

  test('本机清单里没有这个模型：连上之后按实际跑起来的模型说', () => {
    const at = M.indexOf('await client.connect();\n      /*\n        **本机清单里没有你选的模型**');
    assert.ok(at > 0, '要在 connect 成功之后说');
    const body = M.slice(at, at + 1500);
    assert.match(body, /modelFallback\.note\(sessionId, lm\.wanted, model, trConcat\(tr\('⚠️ This machine has no model "\{wanted\}", so this session uses "\{model\}" instead\.'/);
    assert.match(body, /NOTE_DETAIL_SEP,\s*tr\('Available here: \{list\}\{more\}'/, '可用清单折进详情');
    assert.doesNotMatch(M, /so this session uses another model from its list/);
  });

  test('新建会话：记录落盘（createSession + writeRecord）之后才 commit 那句；session/new 失败就 discard；界面把它插进这条正在新建的会话', () => {
    const at = M.indexOf("const rec = store.readRecord(kiroLexId) || store.createSession(kiroLexId, profile);");
    assert.ok(at > 0);
    assert.match(M.slice(at, at + 900), /store\.writeRecord\(rec\);[\s\S]{0,200}modelFallback\.commit\(kiroLexId\);/);
    assert.match(M, /try \{ await client\.disconnect\(\); \} catch \{ \/\* 已经没了 \*\/ \}\s*\n\s*modelFallback\.discard\(kiroLexId\);/);
    const A = read('src', 'renderer', 'hooks', 'useAcp.ts');
    assert.match(A, /withLiveNote\(cur, note, creatingRef\.current\.has\(sid\)\)/);
  });

  test('换机器 / 换引擎 / 换组合 / attach：连上时只记下，执行器换上、记录写好之后才 commit；失败的那条路 discard', () => {
    /* 换机器：connect 成功后 remoteStarted 只是记下；commit 在 writeRecord 之后；catch 里 discard */
    const tAt = M.indexOf("const applySessionTarget = async (");
    const tBody = M.slice(tAt, tAt + 9000);
    const started = tBody.indexOf("modelFallback.remoteStarted(sessionId, profile.model);");
    const newSess = tBody.indexOf("client.newSession(cliCwd)", started);
    const written = tBody.indexOf("store.writeRecord(rec);", newSess);
    const committed = tBody.indexOf("modelFallback.commit(sessionId);", written);
    assert.ok(started > 0 && newSess > started && written > newSess && committed > written, '顺序：记下 → session/new → 写记录 → commit');
    assert.match(tBody, /catch \(err\) \{\s*\n\s*try \{ await client\.disconnect\(\); \} catch \{\}\s*\n\s*modelFallback\.discard\(sessionId\);/);
    /* 换引擎、换组合：commit 在 restoreContextAfterExecutorSwap 之后，catch 里 discard */
    for (const tag of ['switch-engine', 'switch-mcp-combo']) {
      assert.match(M, new RegExp(`restoreContextAfterExecutorSwap\\(sessionId, '${tag}'\\);\\s*\\n\\s*modelFallback\\.commit\\(sessionId\\);`));
    }
    assert.match(M, /modelFallback\.discard\(sessionId\);   \/\/ 没换成：连上时记下的那句作废\s*\n\s*logger\.warn\('engine'/);
    assert.match(M, /modelFallback\.discard\(sessionId\);   \/\/ 没换成：连上时记下的那句作废\s*\n\s*logger\.warn\('mcp-combo'/);
    /* attach：成功返回前 commit，finally 里 discard（中途失败 / 被删） */
    assert.match(M, /modelFallback\.commit\(sessionId\);\s*\n\s*return \{ ok: true, freshBackend: freshBackendResult \};\s*\n\s*\} catch \(err\) \{[\s\S]{0,600}?throw err;\s*\n\s*\} finally \{[\s\S]{0,80}modelFallback\.discard\(sessionId\);/);
    /* 候选循环里不直接写 */
    const fAt = M.indexOf('async function connectWithModelFallback(');
    const fBody = M.slice(fAt, M.indexOf('\n}\n', fAt));
    assert.doesNotMatch(fBody, /noteInSession\(|modelFallback\.commit\(/, 'connectWithModelFallback 只记下，不写');
  });

  test('写进对话记录的提示当场插进界面（原来没人听 acp:user-message，要重新打开才看得见）', () => {
    const P = read('src', 'main', 'preload.ts');
    assert.match(P, /ipcRenderer\.on\('acp:user-message', handler\)/);
    const A = read('src', 'renderer', 'hooks', 'useAcp.ts');
    assert.match(A, /window\.kiroApi\.onUserMessage\?\.\(/);
    /* 流式输出期间先攒着，这一轮结束再插 —— 插在流中间会把回复拆成两段 */
    assert.match(A, /if \(streamingIdsRef\.current\.has\(d\.sessionId\)\) \{\s*\n\s*const held = heldNotesRef/);
    assert.match(A, /const held = heldNotesRef\.current\.get\(sid\);\s*\n\s*if \(held\?\.length\) \{/);
  });
});

describe('同类提示带上「类型:对象」，界面才能合并计数', () => {
  test('本机工具连接「正在重连（第 N 次）」：sshMux 和 remoteRecovery 两处用同一个 group', () => {
    const R = read('src', 'main', 'remoteRecovery.ts');
    assert.match(R, /RECONNECTING_TEXT\(st\.attempt\), true, LOCAL_TOOLS_RECONNECT_GROUP\)/);
    assert.match(M, /\{ n: attempt \}\), LOCAL_TOOLS_RECONNECT_GROUP\);/);
    assert.match(M, /notice: \(sessionId, text, sticky, group\) => \(sticky \? stickySessionNotice\(sessionId, text, group\) : sessionNotice\(sessionId, text, \{ group \}\)\)/);
  });

  test('换模型 / 换后端会话 / 改写排队 / 切换没生效：各自带 group（对象或结果不同就是不同的 group）', () => {
    assert.match(M, /undefined, `model-swap:\$\{failedModel\}→\$\{swapped\}`\);/);
    assert.match(M, /noteInSession\(sessionId, note, undefined, 'backend-session-swap'\);/);
    /* 同一次提交（ticket）一个 group；老调用方没有 ticket 时按 label */
    assert.match(M, /\{ group: `revise-queued:\$\{noticeKey \|\| label\}` \}\);/);
    assert.match(M, /`pending-switch-failed:\$\{report\.failed\.map\(\(f\) => `\$\{f\.kind\}→\$\{f\.label\}`\)\.join\(','\)\}`/);
  });

  test('group 一路落盘、发给界面、读回来都带着', () => {
    assert.match(fnBody(M, 'noteInSession'), /const g = group \? \{ noteGroup: group \} : \{\};/);
    const A = read('src', 'renderer', 'hooks', 'useAcp.ts');
    assert.ok((A.match(/noteGroup: \(m as any\)\.noteGroup/g) || []).length >= 4, '每条从 transcript 读回来的路都要带上');
    assert.match(read('src', 'renderer', 'sessionNoticeHub.ts'), /group: d\.group/);
  });
});
