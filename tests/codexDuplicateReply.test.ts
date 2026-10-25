/**
 * 「Codex 对话总会打印两遍结果」—— 盘上一份，界面两份。
 *
 * 回归样本 `fixtures/codex-acp-commentary-final.jsonl`：真实 codex-acp 2.2.2（自带 codex-cli 0.160.1）的一轮
 * session/update 序列 —— commentary 一条（messageId A）→ 三次命令调用 → 一段思考（agent_thought_chunk）→
 * final_answer 一条（messageId B）。适配器**没有**在 item 完成时重发整段（agentMessage 的 item/completed 返回 null），
 * 每个字只来一次。
 *
 * 重复的确切来源（KiroLex 这边）：
 *   · 界面：思考块（💭）把这一轮切成两段 —— [A：commentary] [💭] [B：final_answer]；
 *   · 主进程：所有 agent_message_chunk 攒成一份（`assistantBuf`），id 用第一个 messageId（A），落盘一条；
 *   · 一轮结束主进程发 `acp:assistant-final { messageId: A, text: commentary+final_answer }`，
 *     渲染层按 id 找到 A，"比界面的长就换成完整的"——于是 A 变成 commentary+final_answer，B 里还有一份 final_answer。
 * 修法：权威正文按这一轮的几段（`mergeAssistantFinalIntoTurn`）对：几段拼起来是它的开头就只补尾巴，不再整段塞进第一段。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendAgentText, appendAgentThought } from '../src/renderer/liveReply.ts';
import { mergeAssistantFinalIntoTurn } from '../src/renderer/assistantFinal.ts';
import { trackReplySegments, type ReplySegments } from '../src/main/replySegments.ts';

type Msg = { id: string; role: 'user' | 'assistant'; content: string; timestamp: number; toolTailFrom?: number; question?: any; kirolex?: true; steer?: any };

const fixture = path.join(import.meta.dirname, 'fixtures', 'codex-acp-commentary-final.jsonl');
const rows = fs.readFileSync(fixture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const updates = rows.filter((r) => r.update).map((r) => r.update);

/** 渲染层：和 useAcp 的 agent_message_chunk / agent_thought_chunk 分支同一套函数 */
function renderLive(list: Msg[], ups: any[]): Msg[] {
  let n = 0;
  for (const u of ups) {
    const text = u.content?.text || '';
    if (u.sessionUpdate === 'agent_message_chunk') {
      list = appendAgentText(list, text, (content) => ({ id: u.messageId || `msg_${n++}`, role: 'assistant', content, timestamp: 0 })) as Msg[];
    } else if ((u.sessionUpdate === 'agent_thought_chunk' || u.sessionUpdate === 'agent_reasoning_chunk') && text) {
      list = appendAgentThought(list, text, (content) => ({ id: u.messageId || `think_${n++}`, role: 'assistant', content, timestamp: 0 })) as Msg[];
    }
  }
  return list;
}

/** 主进程：assistantBuf 攒所有正文块，id 取第一个 messageId，bufAtLastTool = 最后一次 tool_call 时的长度，
 *  segmentBreaks = 界面每段的起点（index.ts 的 onUpdate 调同一个 trackReplySegments） */
function mainTurn(ups: any[]) {
  let buf = ''; let id: string | null = null; let bufAtLastTool = 0; let seg: ReplySegments | undefined;
  for (const u of ups) {
    seg = trackReplySegments(seg, u, buf.length);
    if (u.sessionUpdate === 'agent_message_chunk') { buf += u.content?.text || ''; if (!id) id = u.messageId || 'a_x'; }
    if (u.sessionUpdate === 'tool_call') bufAtLastTool = buf.length;
  }
  return { messageId: id!, text: buf, toolTailFrom: bufAtLastTool || undefined, segmentBreaks: seg?.breaks.length ? seg.breaks : undefined };
}

const turnText = (list: Msg[]) => list
  .filter((m) => m.role === 'assistant' && !m.content.startsWith('💭 ') && !m.question && !m.kirolex)
  .map((m) => m.content).join('');

describe('Codex 回放：commentary + 工具 + 思考 + final_answer', () => {
  const user: Msg = { id: 'u1', role: 'user', content: '问', timestamp: 0 };
  const live = renderLive([user], updates);
  const final = mainTurn(updates);
  const byId = new Map<string, string>();
  for (const u of updates) if (u.sessionUpdate === 'agent_message_chunk') byId.set(u.messageId, (byId.get(u.messageId) || '') + u.content.text);
  const [commentary, answer] = [...byId.values()];

  test('样本本身：两条消息，适配器没有重发整段', () => {
    assert.equal(byId.size, 2);
    assert.equal(final.text, commentary + answer);
    assert.ok(!commentary.includes(answer) && !answer.includes(commentary));
    assert.ok(updates.some((u) => u.sessionUpdate === 'agent_thought_chunk'));
  });

  test('流式中：思考块把这一轮切成 [commentary] [💭] [final_answer]', () => {
    assert.deepEqual(live.slice(1).map((m) => m.content.startsWith('💭 ') ? '💭' : m.content), [commentary, '💭', answer]);
  });

  test('一轮结束并进权威正文后：界面文本 == 盘上文本，没有重复段落', () => {
    const r = mergeAssistantFinalIntoTurn(live, final.messageId, final.text, final.toolTailFrom);
    assert.ok(r);
    const after = r!.list as Msg[];
    assert.equal(turnText(after), final.text);
    assert.equal(after.filter((m) => m.content.includes(answer)).length, 1);
    /* 重新打开（读盘）看到的就是这一份 */
    assert.equal(turnText([user, { id: final.messageId, role: 'assistant', content: final.text, timestamp: 0 }]), turnText(after));
  });

  test('界面漏收了最后几块：只把尾巴补到最后一段', () => {
    const lastChunk = updates.map((u, i) => [u, i] as const).filter(([u]) => u.sessionUpdate === 'agent_message_chunk').at(-1)![1];
    const partial = renderLive([user], updates.filter((_, i) => i !== lastChunk));
    const after = mergeAssistantFinalIntoTurn(partial, final.messageId, final.text, final.toolTailFrom)!.list as Msg[];
    assert.equal(turnText(after), final.text);
    assert.equal(after.at(-1)!.content, answer);
  });

  test('toolTailFrom 换算到各段：最后一次工具调用在 commentary 末尾 → 落在 commentary 段的结尾，final_answer 段不动', () => {
    const after = mergeAssistantFinalIntoTurn(live, final.messageId, final.text, final.toolTailFrom)!.list as Msg[];
    assert.equal(final.toolTailFrom, commentary.length);
    assert.equal(after[1].toolTailFrom, commentary.length);
    assert.equal(after[3].toolTailFrom, undefined);
  });

  test('id 对不上（kiro 那种没有 messageId 的）：按这一轮的几段对，也不重复', () => {
    const after = mergeAssistantFinalIntoTurn(live, 'a_other', final.text)!.list as Msg[];
    assert.equal(turnText(after), final.text);
  });

  test('id 对不上、列表里还有上一轮（没有用户消息隔开）：只认能拼成权威正文开头的那几段', () => {
    const prev: Msg = { id: 'old', role: 'assistant', content: '上一轮的回答', timestamp: 0 };
    const list = renderLive([user, prev], [{ sessionUpdate: 'agent_thought_chunk', content: { text: 'x' } }, ...updates]);
    const after = mergeAssistantFinalIntoTurn(list, 'a_other', final.text)!.list as Msg[];
    assert.equal(after[1].content, '上一轮的回答');
    assert.equal(turnText(after.slice(2)), final.text);
  });
});

describe('主进程给了每段起点（segmentBreaks）：哪一段漏收了块都补回来，界面 == 盘上', () => {
  const user: Msg = { id: 'u1', role: 'user', content: '问', timestamp: 0 };
  const final = mainTurn(updates);
  const textIdx = updates.map((u, i) => [u, i] as const).filter(([u]) => u.sessionUpdate === 'agent_message_chunk').map(([, i]) => i);
  const textOf = (i: number) => updates[i].content.text as string;
  const merge = (list: Msg[]) => mergeAssistantFinalIntoTurn(list, final.messageId, final.text, final.toolTailFrom, final.segmentBreaks)!.list as Msg[];
  const answerText = () => updates.filter((u) => u.sessionUpdate === 'agent_message_chunk' && u.messageId === updates[textIdx.at(-1)!].messageId).map((u) => u.content.text).join('');

  test('切点：在 commentary 末尾（思考之后 final_answer 开始的地方）', () => {
    assert.deepEqual(final.segmentBreaks, [final.text.length - answerText().length]);
  });

  test('漏收 commentary 中间的一块（例如 ".js"）：完成后补回，界面 == 盘上、没有重复', () => {
    const drop = textIdx.find((i) => textOf(i) === '.js')!;
    assert.ok(drop < textIdx.find((i) => updates[i].messageId !== updates[textIdx[0]].messageId)!, '丢的是 commentary 里的一块');
    const partial = renderLive([user], updates.filter((_, i) => i !== drop));
    assert.equal(turnText(partial).length, final.text.length - 3);
    const after = merge(partial);
    assert.equal(turnText(after), final.text);
    assert.equal(after.filter((m) => m.content.includes(answerText())).length, 1);
    assert.equal(after[1].content + after[3].content, final.text);
  });

  test('漏收 final_answer 的第一块和中间几块：同样补回', () => {
    const answerIdx = textIdx.filter((i) => updates[i].messageId === updates[textIdx.at(-1)!].messageId);
    const drops = new Set([answerIdx[0], answerIdx[5], answerIdx[6]]);
    const after = merge(renderLive([user], updates.filter((_, i) => !drops.has(i))));
    assert.equal(turnText(after), final.text);
    assert.equal(after[3].content, answerText());
  });

  test('一块都没漏：不变', () => {
    const live = renderLive([user], updates);
    assert.equal(merge(live).map((m) => m.content).join('|'), live.map((m) => m.content).join('|'));
  });

  test('id 对不上：按最后几段对，同样补回', () => {
    const drop = textIdx.find((i) => textOf(i) === '.js')!;
    const after = mergeAssistantFinalIntoTurn(renderLive([user], updates.filter((_, i) => i !== drop)), 'a_other', final.text, undefined, final.segmentBreaks)!.list as Msg[];
    assert.equal(turnText(after), final.text);
  });

  test('段数对不上（切点不可信）：退回按开头对，不会重复', () => {
    const live = renderLive([user], updates);
    const after = mergeAssistantFinalIntoTurn(live, final.messageId, final.text, undefined, [3, 9])!.list as Msg[];
    assert.equal(turnText(after), final.text);
  });
});

describe('trackReplySegments：和界面切段的规则一致', () => {
  const t = (s: any, sessionUpdate: string, text: string, len: number) => trackReplySegments(s, { sessionUpdate, content: { text } }, len);
  test('思考在最前面不算切点；空思考块不切；正文之后的思考才切', () => {
    let s = t(undefined, 'agent_thought_chunk', 'x', 0);
    s = t(s, 'agent_message_chunk', 'ab', 0);
    s = t(s, 'agent_thought_chunk', '', 2);
    s = t(s, 'agent_message_chunk', 'c', 2);
    assert.deepEqual(s!.breaks, []);
    s = t(s, 'agent_thought_chunk', 'y', 3);
    s = t(s, 'agent_message_chunk', 'd', 3);
    assert.deepEqual(s!.breaks, [3]);
  });
  test('assistantBuf 清空后（落盘 / 重发）旧切点作废', () => {
    let s: ReplySegments | undefined = { breaks: [5], afterThought: true };
    s = t(s, 'agent_message_chunk', 'a', 0);
    assert.deepEqual(s!.breaks, []);
  });
});

describe('mergeAssistantFinalIntoTurn：只有一段时和原来一样', () => {
  test('漏了尾巴：换成完整的；比权威的长：不动', () => {
    const base: Msg[] = [{ id: 'u', role: 'user', content: 'q', timestamp: 0 }, { id: 'a', role: 'assistant', content: 'hello', timestamp: 0 }];
    assert.equal((mergeAssistantFinalIntoTurn(base, 'a', 'hello world')!.list as Msg[])[1].content, 'hello world');
    assert.equal(mergeAssistantFinalIntoTurn(base, 'a', 'hel')!.list, base);
  });
  test('没有助手消息：null', () => {
    assert.equal(mergeAssistantFinalIntoTurn([{ id: 'u', role: 'user', content: 'q', timestamp: 0 }], 'a', 'x'), null);
  });
});

describe('提问卡片：流式追加和权威正文都跳过它', () => {
  const q: Msg = { id: 'q1', role: 'assistant', content: '', timestamp: 0, question: { id: 'q1' } };
  const fresh = (content: string): Msg => ({ id: 'n', role: 'assistant', content, timestamp: 0 });
  test('卡片后面来的正文新开一条，不并进卡片', () => {
    const out = appendAgentText([q], 'hi', fresh);
    assert.equal(out.length, 2);
    assert.equal(out[0].content, '');
  });
  test('id 对不上时找回复段也跳过卡片', () => {
    const list: Msg[] = [{ id: 'u', role: 'user', content: 'q', timestamp: 0 }, { id: 'a', role: 'assistant', content: 'ab', timestamp: 0 }, q];
    const after = mergeAssistantFinalIntoTurn(list, 'x', 'abc')!;
    assert.equal(after.idx, 1);
    assert.equal((after.list as Msg[])[1].content, 'abc');
    assert.equal((after.list as Msg[])[2].content, '');
  });
});

describe('接线：useAcp 用同一套函数', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
  test('主进程按同一个 trackReplySegments 记切点、随 assistant-final 发出', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    assert.ok(M.includes("entry.replySegments = trackReplySegments(entry.replySegments, u, entry.assistantBuf.length);\n      if (u?.sessionUpdate === 'agent_message_chunk') {\n        entry.assistantBuf +="));
    const i = M.indexOf("mainWindow?.webContents.send('acp:assistant-final', {");
    assert.ok(M.slice(i, i + 1200).includes('...(segmentBreaks.length ? { segmentBreaks } : {})'));
  });
  test('agent_message_chunk / 思考块走 liveReply，assistant-final 走 mergeAssistantFinalIntoTurn', () => {
    assert.match(src, /appendAgentText\(/);
    assert.match(src, /appendAgentThought\(/);
    assert.match(src, /mergeAssistantFinalIntoTurn\(/);
  });
});
