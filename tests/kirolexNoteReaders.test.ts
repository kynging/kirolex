import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tailEntries } from '../src/main/controlSessions.ts';
import { chatHistoryBody } from '../src/renderer/historyBlock.ts';

/**
 * **KiroLex 自己插进对话的提示（换模型等）以 `role: 'user'` 落盘** —— 每一处按 `role === 'user'` 取「你说的话」的地方，
 * 要么排除它（`isKirolexNote` / `modelFacing`），要么把来源标出来。这里一处一处守着。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');
const M = read('src', 'main', 'index.ts');
const A = read('src', 'renderer', 'hooks', 'useAcp.ts');

/** 从 `function name(` 截到下一个顶层 `function ` */
function fnBody(src: string, name: string): string {
  const at = src.search(new RegExp(`function ${name}[(<]`));
  assert.ok(at >= 0, `找不到 ${name}`);
  const next = src.indexOf('\nfunction ', at + 10);
  const nextAsync = src.indexOf('\nasync function ', at + 10);
  const ends = [next, nextAsync].filter((i) => i > 0);
  return src.slice(at, ends.length ? Math.min(...ends) : undefined);
}
/** 从锚点开始截一段 */
function sliceFrom(src: string, anchor: string, len = 1500): string {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `找不到 ${anchor}`);
  return src.slice(at, at + len);
}

const NOTE = { id: 'n1', role: 'user', kirolex: true as const, content: '⚠️ 这条会话现在跑在 gpt-5.6-sol 上（你选的 claude-opus-5 这次起不来）', ts: 2 };
/* 老记录：没带标记，只能按固定开头认 */
const OLD_NOTE = { id: 'n0', role: 'user', content: '⏳ 已排队：等这一轮结束', ts: 3 };

describe('控制入口 GET /sessions/:id/tail：提示不能冒充你发的', () => {
  test('KiroLex 的提示 role 给 kirolex（带标记的和老的按开头认的都算）；你的话照旧是 user', () => {
    const out = tailEntries([
      { id: 'u1', role: 'user', content: '帮我看看', ts: 1 },
      NOTE,
      OLD_NOTE,
      { id: 'a1', role: 'assistant', content: '好的', ts: 4 },
    ], 10);
    assert.deepEqual(out.map((e) => [e.id, e.role]), [['u1', 'user'], ['n1', 'kirolex'], ['n0', 'kirolex'], ['a1', 'assistant']]);
    assert.match(out[1].text, /gpt-5\.6-sol/, '正文照旧给 —— 只是标清楚是谁说的');
  });

  test('你自己写的「⚠️ …」不会被当成提示', () => {
    const out = tailEntries([{ id: 'u', role: 'user', content: '⚠️ 这个接口别动', ts: 1 }], 1);
    assert.equal(out[0].role, 'user');
  });

  test('接线：tail 读的是 transcript 原样（含 kirolex 字段），由 tailEntries 判', () => {
    /* 后面还接着挂着的提问卡片（controlQuestion.test.ts），transcript 本身仍然原样交给 tailEntries */
    assert.match(M, /tail: \(id, n\) => tailEntries\(\[\s*\.\.\.store\.readTranscript\(id\),/);
  });
});

describe('渲染端拼进 <hidden> 历史块（复制会话 / 编辑重跑 / 跨会话同步）：不带提示', () => {
  test('chatHistoryBody 跳过提示，你和助手的话照旧按 User / Assistant 拼', () => {
    const body = chatHistoryBody([
      { role: 'user', content: '问题' }, NOTE, OLD_NOTE, { role: 'assistant', content: '回答' },
    ]);
    assert.equal(body, 'User: 问题\n\nAssistant: 回答');
  });

  test('接线：三处历史块都走 chatHistoryBody，不再自己按 role 拼', () => {
    assert.equal((A.match(/chatHistoryBody\((dupHistory|rebuiltHistory|delta)\)/g) || []).length, 3);
    assert.doesNotMatch(A, /\.map\(\(m\) => `\$\{m\.role === 'user' \? 'User' : 'Assistant'\}: \$\{m\.content\}`\)/);
  });

  test('复制会话（冷缓存从 transcript 读回）时保留提示标记 —— 否则复制出来的会话里它就永远成了「你说的话」', () => {
    const cold = sliceFrom(A, 'const t = await window.kiroApi.readTranscript?.(sessionId);', 900);
    assert.match(cold, /\(m as any\)\.kirolex \? \{ kirolex: true as const \} : \{\}/);
    assert.match(cold, /noteGroup: \(m as any\)\.noteGroup/);
  });
});

describe('主进程发给模型 / 写进记忆的几条路：都先过 modelFacing', () => {
  for (const name of ['maybeConsolidateSessionMemory', 'renderHistoryFile', 'buildHistoryRideAlong', 'primeHistoryNow']) {
    test(`${name}`, () => {
      assert.match(fnBody(M, name), /\.filter\(modelFacing\)/);
    });
  }
});

describe('追加指令拆分 / 合并：不会并进一条提示', () => {
  test('落盘的追加指令按 id 并回那条用户消息时，目标是提示就不并（单独留一条，文字不丢）', () => {
    const S = read('src', 'main', 'sessionStore.ts');
    assert.match(S, /if \(target\?\.role === 'user' && !isKirolexNote\(target\)\) \{/);
  });
  test('渲染端找追加指令挂靠的那条用户消息时跳过提示', () => {
    assert.match(A, /msgs\[i\]\.role === 'user' && !msgs\[i\]\.steer && !isKirolexNote\(msgs\[i\]\)/);
    assert.match(read('src', 'renderer', 'components', 'ChatArea.tsx'), /out\[i\]\.role === 'user' && !out\[i\]\.steer && !isKirolexNote\(out\[i\]\)/);
  });
});

describe('渲染端按「最后一条用户消息」找这一轮边界的地方：跳过提示', () => {
  test('这一轮被重发时丢掉半截回复（onTurnRestart）：提示不算这一轮的开头，也不跟着被删', () => {
    const body = sliceFrom(A, 'const dropPartial = (list: Message[]): Message[] => {', 600);
    assert.match(body, /if \(list\[i\]\.role === 'user' && !isKirolexNote\(list\[i\]\)\) break;/);
    assert.match(body, /i < idx \|\| \(i > idx && isKirolexNote\(m\)\)/);
  });
  test('卡死时判断是不是侧栏 review 那一轮（onTurnWedged）', () => {
    assert.match(A, /\.reverse\(\)\.find\(\(m\) => m\.role === 'user' && !isKirolexNote\(m\)\);\s*\n\s*if \(lastUser && isReviseRequest/);
  });
  test('工具改了文件挂到最近这一轮（attachFileChangeToLatestTurn）', () => {
    const body = sliceFrom(A, 'const attachFileChangeToLatestTurn = useCallback(', 700);
    assert.match(body, /current\[index\]\.role === 'user' && !isKirolexNote\(current\[index\]\)/);
  });
  test('重跑找不到原 id 时退回「最近一条用户消息」（rerunFromMessage）', () => {
    assert.match(A, /if \(current\[i\]\.role === 'user' && !current\[i\]\.steer && !isKirolexNote\(current\[i\]\)\) \{ targetIndex = i; break; \}/);
  });
  test('重跑时「后面还有你的消息」才要确认（handleRerunMessage）', () => {
    assert.match(read('src', 'renderer', 'App.tsx'), /laterRecords\.some\(\(message\) => message\.role === 'user' && !isKirolexNote\(message\)\)/);
  });
  test('选项片：最后说话的是提示不算「你已经答了」', () => {
    assert.match(read('src', 'renderer', 'components', 'ChatArea.tsx'), /if \(msg\.role === 'user' && !isKirolexNote\(msg\)\) return \[\];/);
  });
});
