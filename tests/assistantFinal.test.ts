/**
 * 实时那一轮：「先写 invoke 标记 → 真调了工具 → 之后没再写字」。
 * 主进程不纠正（一轮结束时按 toolTailFrom 判）；界面上那条消息也必须拿到同一个 toolTailFrom，
 * 否则当场就被标成「未执行」，要等重新从盘上读回来才对 —— 界面、历史块、编辑重跑写回都按这一个值判。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mergeAssistantFinal } from '../src/renderer/assistantFinal.ts';
import { splitTextToolCall, textToolCallVerdict } from '../src/main/textToolCall.ts';
import { chatHistoryBody } from '../src/renderer/historyBlock.ts';

const INVOKE = '<invoke name="use_aws">\n<parameter name="operation_name">send-command</parameter>\n</invoke>';

describe('mergeAssistantFinal：实时事件顺序', () => {
  /* 按事件顺序走一遍：正文流式到达（界面和主进程各攒一份）→ tool_call（主进程记下此刻正文长度）→ end_turn → assistant-final */
  const chunks = ['我去实例上看一下服务状态。\n', 'code\n', INVOKE];
  const streamed = chunks.join('');                 // 界面收到的
  const bufAtLastTool = streamed.length;            // 主进程在 tool_call 那一刻记的
  const verdict = textToolCallVerdict({ stopReason: 'end_turn', text: streamed, tailFrom: bufAtLastTool, correctionTurn: false });

  test('主进程不纠正；完成事件把 toolTailFrom 带过来，正文一样也要更新', () => {
    assert.equal(verdict.action, 'none');
    const merged = mergeAssistantFinal({ content: streamed }, streamed, bufAtLastTool);
    assert.deepEqual(merged, { content: streamed, toolTailFrom: bufAtLastTool });
  });

  test('更新后：界面不标「未执行」、历史块不折叠 —— 和主进程同一个判定', () => {
    const msg = { role: 'assistant', content: streamed, ...mergeAssistantFinal({ content: streamed }, streamed, bufAtLastTool) };
    assert.equal(splitTextToolCall(msg.content, msg.toolTailFrom), null);
    assert.equal(chatHistoryBody([msg]), `Assistant: ${streamed}`);
    /* 对照：没拿到位置（修之前）就会被当场标成未执行 */
    assert.ok(splitTextToolCall(streamed));
  });

  test('界面漏收了尾巴：换成完整正文，位置照用', () => {
    const merged = mergeAssistantFinal({ content: streamed.slice(0, 20) }, streamed, bufAtLastTool);
    assert.deepEqual(merged, { content: streamed, toolTailFrom: bufAtLastTool });
  });

  test('界面那条比主进程的长（正文保留界面的）：按两者的对应关系换算位置', () => {
    /* 主进程的正文是界面那条的开头一段：位置不变，真实调用之前那段不标 */
    const longer = `${streamed}\n\n（界面多出来的一段）`;
    const a = mergeAssistantFinal({ content: longer }, streamed, bufAtLastTool);
    assert.deepEqual(a, { content: longer, toolTailFrom: bufAtLastTool });
    /* 主进程的正文是界面那条的结尾一段：位置往后挪过前面多出来的那段 */
    const head = '（界面前面多出来的一段）\n\n';
    const b = mergeAssistantFinal({ content: head + streamed }, streamed, bufAtLastTool);
    assert.equal(b?.toolTailFrom, head.length + bufAtLastTool);
    assert.equal(splitTextToolCall(head + streamed, b?.toolTailFrom), null);
    /* 对不上：不标 */
    const c = mergeAssistantFinal({ content: 'X'.repeat(streamed.length + 5) }, streamed, bufAtLastTool);
    assert.equal(c?.toolTailFrom, streamed.length + 5);
  });

  test('没调过工具：不加 toolTailFrom，写成文字的照旧标出来', () => {
    const merged = mergeAssistantFinal({ content: streamed }, streamed, undefined);
    assert.equal(merged, null);
    assert.ok(splitTextToolCall(streamed));
  });

  test('真实调用之后又写了一段 invoke 才结束 → 界面照旧标出来（只标后面那段）', () => {
    const later = `${streamed}\n\n接下来：\n<invoke name="bg_status">\n<parameter name="jobId">bg_1</parameter>\n</invoke>`;
    const m = { content: later, ...mergeAssistantFinal({ content: later }, later, bufAtLastTool) };
    assert.deepEqual(splitTextToolCall(m.content, m.toolTailFrom)?.tools, ['bg_status']);
  });
});

describe('接线：完成事件带 toolTailFrom、渲染端并进消息', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
  test('主进程 acp:assistant-final 带上和落盘同一个值', () => {
    const M = read('main', 'index.ts');
    const i = M.indexOf("mainWindow?.webContents.send('acp:assistant-final', {");
    assert.ok(i > 0);
    assert.match(M.slice(i, i + 500), /\.\.\.\(entry\.bufAtLastTool \? \{ toolTailFrom: entry\.bufAtLastTool \} : \{\}\)/);
  });
  test('useAcp 的完成事件处理用 mergeAssistantFinal（正文相同也会更新位置）', () => {
    const r = read('renderer', 'hooks', 'useAcp.ts');
    const i = r.indexOf('const removeAssistantFinal = window.kiroApi.onAssistantFinal');
    assert.ok(i > 0);
    const body = r.slice(i, i + 1500);
    assert.match(body, /\(\{ sessionId: sid, messageId, text, toolTailFrom \}\)/);
    assert.match(body, /const merged = mergeAssistantFinal\(list\[idx\], text, toolTailFrom\);/);
    assert.doesNotMatch(body, /if \(list\[idx\]\.content === text\) return list;/);
  });
});
