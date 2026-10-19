/**
 * 「把工具调用写成了文字」的接线（判据本身见 tests/textToolCall.test.ts）：
 *   · 一轮成功收尾时、flush 清空缓冲之前判，只看最后一次真实工具调用之后的正文；
 *   · 纠正走后台唤醒那条投递队列（等这一轮结束、排着时开了别的一轮就不发），显示为 KiroLex 提示；
 *   · 纠正那一轮再犯 → 会话里一句 ⚠️ + 详情；
 *   · 喂给模型的历史（history.md / 随行快照 / 重建历史 / 会话记忆 / 渲染端拼的历史块）都折叠。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chatHistoryBody } from '../src/renderer/historyBlock.ts';
import { ZH_MAIN } from '../src/main/uiText.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
const M = read('main', 'index.ts');

function slice(src: string, anchor: string, len = 2500): string {
  const i = src.indexOf(anchor);
  assert.ok(i >= 0, `找不到锚点：${anchor}`);
  return src.slice(i, i + len);
}

describe('主进程：一轮结束时判定', () => {
  test('在 flushAssistant 之前判（之后缓冲就清空了），用最后一次工具调用处的长度做 tailFrom', () => {
    const at = M.indexOf('const textTool = entry.priming ? null : textToolCallVerdict(');
    assert.ok(at > 0);
    const after = M.slice(at, at + 1500);
    assert.ok(after.indexOf('tailFrom: entry.bufAtLastTool') > 0);
    assert.ok(after.indexOf('text: entry.assistantBuf') > 0);
    assert.ok(after.indexOf('flushAssistant(sessionId)') > after.indexOf('textToolCallVerdict('));
    assert.match(after, /correctionTurn: isTextToolNudgeId\(userMessageId\)/);
    /* 侧栏改写那一轮（正文要拿去写盘）不管 */
    assert.match(after, /skip: askWaiters\.has\(sessionId\)/);
    /* 判定结果和 flush 之前那份正文一起交出去（「这一步是干什么的」要从标记块里取） */
    assert.match(after, /const textToolBuf = textTool && textTool\.action !== 'none' \? entry\.assistantBuf : '';/);
    assert.ok(after.indexOf('const textToolBuf') < after.indexOf('flushAssistant(sessionId)'));
    assert.match(after, /handleTextToolCall\(sessionId, textTool, textToolBuf\)/);
  });

  test('开工具调用时记下正文长度；每轮开始清零', () => {
    assert.match(M, /if \(u\?\.sessionUpdate === 'tool_call'\) entry\.bufAtLastTool = entry\.assistantBuf\.length;/);
    assert.match(M, /entry\.toolsThisTurn = 0;[^\n]*\n\s*entry\.bufAtLastTool = 0;/);
  });

  test('纠正 / 换后端续发：走唤醒投递队列（source nudge），处置由 textToolRecovery 决定；停下：会话里一句 ⚠️ + 详情，带 group', () => {
    const h = slice(M, 'function handleTextToolCall(', 3000);
    assert.match(h, /decideTextToolRecovery\(textToolRecovery\.get\(sessionId\)/);
    assert.match(h, /wakeDispatcher\.enqueue\(\{\s*sessionId, text: d\.prompt, at: Date\.now\(\), source: 'nudge'/);
    assert.match(h, /\.\.\.\(d\.action === 'swap' \? \{ swap: true \} : \{\}\)/);
    assert.match(h, /noteInSession\(sessionId, trConcat\(/);
    assert.match(h, /NOTE_DETAIL_SEP/);
    assert.match(h, /'text-tool-call-halt'/);
  });

  test('排着的纠正过时（又开了别的一轮）就不发：队列的 isStale 和发送前的 stillWanted 都认', () => {
    assert.match(M, /: item\.source === 'nudge' \? textToolNudgeStale\(item\) : null\),/);
    const d = slice(M, 'wakeDeliver = async (item) => {', 3000);
    assert.match(d, /item\.source === 'nudge' \? textToolNudgeStale\(item\) : null\)/);
    /* 纠正那一轮自己不算「别的一轮」 */
    assert.match(M, /if \(attempt === 0 && !isTextToolNudgeId\(display\?\.messageId\)\) turnStarts\.set\(sessionId,/);
  });

  test('纠正那一条显示为 KiroLex 提示：落盘带 kirolex、推给界面也带；不算后台输出', () => {
    const d = slice(M, 'wakeDeliver = async (item) => {', 3000);
    assert.match(d, /\.\.\.\(nudge \? \{ kirolexNote: true \} : \{\}\)/);
    assert.match(d, /bgOutput: item\.source !== 'schedule' && !nudge/);
    assert.match(d, /nudge \? \(item\.swap \? TEXT_TOOL_SWAP_ID_PREFIX : TEXT_TOOL_NUDGE_ID_PREFIX\)\.slice\(0, -1\)/);
    assert.match(M, /\.\.\.\(display\?\.kirolexNote \? \{ kirolex: true as const \} : \{\}\),/);
    assert.match(M, /'acp:main-turn', \{[^\n]*\.\.\.\(display\?\.kirolexNote \? \{ kirolex: true \} : \{\}\)/);
    const r = read('renderer', 'hooks', 'useAcp.ts');
    assert.match(slice(r, 'const removeMainTurn = window.kiroApi.onMainTurn', 800), /\.\.\.\(kirolex \? \{ kirolex: true as const \} : \{\}\)/);
  });

  test('停下的提示有中文，主句 ≤ 40 字左右、开头一个 ⚠️（docs/notices-glossary.md）', () => {
    const key = '⚠️ The model still writes tool calls as text, so automatic handling has stopped until you send your next message.';
    const zh = ZH_MAIN[key];
    assert.ok(zh);
    assert.ok(zh.startsWith('⚠️ '));
    assert.ok(zh.length <= 45, zh);
    assert.match(zh, /等你发下一条消息/);
  });
});

describe('历史里折叠', () => {
  const bad = '我去看一下。\ncode\n<invoke name="use_aws">\n<parameter name="operation_name">send-command</parameter>\n</invoke>';

  test('history.md / 随行快照 / 重建历史共用的 historyLine 折叠助手的那段；会话记忆整理也折叠', () => {
    const h = slice(M, 'function historyLine(', 4000);
    assert.match(h, /const body = m\.role === 'user' \? m\.content : foldTextToolCall\(m\.content, m\.toolTailFrom\);/);
    assert.match(h, /\$\{who\}: \$\{body\}/);
    assert.match(M, /m\.role === 'assistant' \? foldTextToolCall\(m\.content \|\| '', m\.toolTailFrom\) : m\.content/);
  });

  test('渲染端拼的历史块（复制会话 / 编辑重跑 / 跨会话增量）折叠；你说的话原样', () => {
    const body = chatHistoryBody([
      { role: 'user', content: '看一下服务' },
      { role: 'assistant', content: bad },
      { role: 'user', content: '上一条把工具调用写成了文字，没有执行。', kirolex: true },
    ]);
    assert.equal(body, 'User: 看一下服务\n\nAssistant: 我去看一下。\n\n（此处原本应调用工具 use_aws，但被写成了文字，未执行）');
  });
});

describe('界面', () => {
  test('回复正文里的标记块折叠、标「未执行」', () => {
    const c = read('renderer', 'components', 'ChatArea.tsx');
    const a = slice(c, 'function AssistantBody(', 2000);
    assert.match(a, /const textTool = realToolAfter \? null : splitTextToolCall\(main, toolTailFrom\);/);
    assert.match(a, /<details className="text-tool-call">/);
    assert.match(a, /not executed/);
    const zh = read('renderer', 'i18nZh', 'chat.ts');
    assert.match(zh, /"⚠️ 工具调用被写成了文字，未执行：\{tools\}"/);
  });
});

describe('审查跟进 2：最后一次真实工具调用的位置一路带到界面和历史', () => {
  test('主进程落盘助手消息时记 toolTailFrom；history.md / 快照 / 重建历史 / 会话记忆都按它折叠', () => {
    const f = slice(M, 'function flushAssistant(', 1500);
    assert.match(f, /\.\.\.\(entry\.bufAtLastTool \? \{ toolTailFrom: entry\.bufAtLastTool \} : \{\}\)/);
    assert.match(slice(M, 'function historyLine(', 4000), /foldTextToolCall\(m\.content, m\.toolTailFrom\)/);
    assert.match(M, /foldTextToolCall\(m\.content \|\| '', m\.toolTailFrom\)/);
  });

  test('渲染端：读回 transcript 的每一处都带上 toolTailFrom，整份重写时写回去', () => {
    const r = read('renderer', 'hooks', 'useAcp.ts');
    const loaders = r.match(/\.\.\.\(typeof \(m as any\)\.noteGroup === 'string'/g)?.length || 0;
    const carried = r.match(/\.\.\.\(typeof \(m as any\)\.toolTailFrom === 'number' \? \{ toolTailFrom: \(m as any\)\.toolTailFrom \} : \{\}\)/g)?.length || 0;
    assert.ok(loaders > 0);
    assert.equal(carried, loaders, '每个读回 noteGroup 的地方也要读回 toolTailFrom');
    assert.match(slice(r, 'function toStoredTranscript(', 1500), /toolTailFrom: m\.toolTailFrom/);
  });

  test('界面：按段显示时，后面还跟着真实工具调用的那段不标「未执行」；整条消息按 toolTailFrom 判', () => {
    const c = read('renderer', 'components', 'ChatArea.tsx');
    assert.match(c, /return \{ id: seg\.id, variant, body, toolTailFrom: seg\.toolTailFrom \};/);
    assert.match(c, /<AssistantBody body=\{p\.body\} toolTailFrom=\{p\.toolTailFrom\} realToolAfter=\{parts\.slice\(idx \+ 1\)\.some\(\(q\) => q\.variant === 'tool'\)\} \/>/);
    assert.match(c, /foldTextToolCall\(m\.content, m\.toolTailFrom\)/);
    assert.match(read('renderer', 'historyBlock.ts'), /foldTextToolCall\(m\.content, m\.toolTailFrom\)/);
  });
});
