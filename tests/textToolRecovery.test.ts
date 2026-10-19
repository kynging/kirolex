/**
 * 「把工具调用写成文字」反复发作时**会话自己恢复**（textToolRecovery.ts + index.ts 接线）：
 *   · 第一次补发纠正；第二次（含跨轮次）自动换新的后端会话、把卡住的那一步续发给新后端；
 *   · 30 分钟内最多自动换 2 次，再犯就停下（⚠️ + 详情），你发下一条消息之前不再自动处理；
 *   · 换后端不影响后台任务（bg_run / watch / 定时任务），结果照常回到这条会话；
 *   · 会话记忆整理时清掉文字版调用块；
 *   · 控制入口 `POST /sessions/:id/new-backend`：要 token、受同一个开关控制、返回新的后端会话 id。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SWAP_MAX, SWAP_WINDOW_MS, TEXT_TOOL_SWAP_ID_PREFIX,
  afterBackendSwap, afterUserMessage, decideTextToolRecovery, describeTextToolStep, emptyRecoveryState,
  isUserTurnMessageId, recordAutoSwap, swapAbandoned, textToolContinuePrompt, textToolWakeStale, type TextToolRecoveryState,
} from '../src/main/textToolRecovery.ts';
import {
  TEXT_TOOL_NUDGE_PROMPT, foldTextToolCall, isTextToolNudgeId, stripTextToolCalls, textToolCallVerdict,
} from '../src/main/textToolCall.ts';
import { consolidatedSessionMemory, mergeSessionMemory } from '../src/main/sessionMemory.ts';
import { WakeDispatcher, type WakeItem } from '../src/main/wakeQueue.ts';
import { createControlServer, type ControlSessionAccess, type ControlNewBackendResult } from '../src/main/controlServer.ts';
import { ZH_MAIN } from '../src/main/uiText.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
const M = read('main', 'index.ts');
function slice(src: string, anchor: string, len = 2500): string {
  const i = src.indexOf(anchor);
  assert.ok(i >= 0, `找不到锚点：${anchor}`);
  return src.slice(i, i + len);
}

const AWS = '明白，我直接去实例上看服务状态。\n\ncode\n<invoke name="use_aws">\n<parameter name="__tool_use_purpose">在 tokyo-arm 上查看 cde-agent 服务状态</parameter>\n<parameter name="operation_name">send-command</parameter>\n</invoke>';
const BG = '接下来查一下它的状态：\n\ncode\n<invoke name="bg_status">\n<parameter name="jobId">bg_1</parameter>\n</invoke>';

/** 一轮以这段正文结束：先过一轮结束时的判定（和 index.ts 同一个函数），再交给恢复策略 */
function turnEnd(state: TextToolRecoveryState | undefined, text: string, now: number, correctionTurn = false) {
  const verdict = textToolCallVerdict({ stopReason: 'end_turn', text, tailFrom: 0, correctionTurn });
  return decideTextToolRecovery(state, { verdict, text, now });
}

describe('处置：第一次纠正，第二次（含跨轮次）换后端会话续发', () => {
  test('第一次 → nudge，发的是原来那句纠正', () => {
    const d = turnEnd(undefined, BG, 1000);
    assert.equal(d.action, 'nudge');
    assert.equal(d.prompt, TEXT_TOOL_NUDGE_PROMPT);
    assert.equal(d.state.detections, 1);
  });

  test('纠正那一轮还这样 → swap，续发那一步：工具名 + 用途', () => {
    const first = turnEnd(undefined, BG, 1000);
    const d = turnEnd(first.state, AWS, 2000, true);
    assert.equal(d.action, 'swap');
    assert.equal(d.prompt, '已换新的后端会话，继续刚才没执行的那一步：use_aws（在 tokyo-arm 上查看 cde-agent 服务状态）。请直接调用工具。');
    /* 次数等真的换成了再记 */
    assert.deepEqual(d.state.swaps, []);
    assert.equal(d.state.swapPending, true);
    const done = recordAutoSwap(d.state, 2500);
    assert.deepEqual(done.swaps, [2500]);
    assert.equal(done.detections, 0, '新的后端是干净的，计数从头来');
    assert.equal(done.swapPending, false);
  });

  test('跨轮次也算第二次：中间隔着正常的一轮、你说了句「继续」都不清计数', () => {
    let s = turnEnd(undefined, BG, 1000).state;
    s = turnEnd(s, '好的，已经处理完了。', 1500).state;   // 正常的一轮
    s = afterUserMessage(s);                             // 你发了「继续」
    const d = turnEnd(s, AWS, 2000);                      // 不是纠正那一轮，但这是第二次
    assert.equal(d.action, 'swap');
  });

  test('重启之后（内存里没有状态）纠正那一轮再犯也直接换，不再纠正一次', () => {
    assert.equal(turnEnd(undefined, AWS, 1, true).action, 'swap');
  });

  test('续发那一条的 id 以纠正的前缀开头：不算新的一轮、显示成 KiroLex 提示、再犯算纠正那一轮', () => {
    assert.ok(isTextToolNudgeId(`${TEXT_TOOL_SWAP_ID_PREFIX.slice(0, -1)}_${Date.now()}`));
  });

  test('没判出来 → none，状态不变', () => {
    const d = turnEnd(undefined, '已经查到了：服务正常。', 1);
    assert.equal(d.action, 'none');
    assert.equal(d.state.detections, 0);
  });
});

describe('防循环：30 分钟内最多自动换 2 次', () => {
  /** 连着犯：每次都是纠正 / 续发那一轮再犯 */
  function storm(n: number, start: number, gap: number, s?: TextToolRecoveryState) {
    const actions: string[] = [];
    let state = s;
    for (let i = 0; i < n; i++) {
      const d = turnEnd(state, AWS, start + i * gap, i > 0);
      actions.push(d.action);
      /* 换后端那一条投递成功（index.ts wakeDeliver 换成了才 recordAutoSwap） */
      state = d.action === 'swap' ? recordAutoSwap(d.state, start + i * gap) : d.state;
      if (d.action === 'halt') return { actions, state, last: d };
    }
    return { actions, state, last: null };
  }

  test('nudge → swap → swap → halt；halt 的详情带次数和最近一次的工具名', () => {
    const r = storm(6, 0, 60_000);
    assert.deepEqual(r.actions, ['nudge', 'swap', 'swap', 'halt']);
    assert.equal(SWAP_MAX, 2);
    assert.equal(r.last!.swapsInWindow, 2);
    assert.deepEqual(r.last!.tools, ['use_aws']);
    assert.equal(r.state!.halted, true);
  });

  test('停下之后不再自动纠正（也不换），直到你发下一条消息', () => {
    const r = storm(6, 0, 60_000);
    let s = r.state!;
    for (const t of [10, 20, 30]) {
      const d = turnEnd(s, AWS, 300_000 + t, true);
      assert.equal(d.action, 'none');
      s = d.state;
    }
    /* 唤醒 / 定时那一轮不是你发的消息，不解除 */
    assert.equal(isUserTurnMessageId('wake_bg_1_1'), false);
    assert.equal(isUserTurnMessageId('sched_x_1'), false);
    assert.equal(isUserTurnMessageId('nudge_texttool_1'), false);
    /* 你发了一条（输入框 / 排队 / 控制入口）→ 解除，从纠正重新开始 */
    assert.ok(isUserTurnMessageId('user_123'));
    assert.ok(isUserTurnMessageId('queue_123'));
    assert.ok(isUserTurnMessageId('user_ctl_123_ab'));
    s = afterUserMessage(s);
    assert.equal(s.halted, false);
    assert.equal(turnEnd(s, AWS, 400_000).action, 'nudge');
  });

  test('窗口是 30 分钟：上一批换后端过了 30 分钟，又能自动换', () => {
    const r = storm(3, 0, 60_000);                   // nudge, swap@60s, swap@120s
    assert.deepEqual(r.actions, ['nudge', 'swap', 'swap']);
    const later = 120_000 + SWAP_WINDOW_MS + 1;
    const d = turnEnd(r.state, AWS, later, true);
    assert.equal(d.action, 'swap');
    assert.deepEqual(recordAutoSwap(d.state, later).swaps, [later]);
  });

  test('换后端那一条排着的期间再判出来：不重复排；没换成（被取代 / 出错）不记次数，下次再犯直接换', () => {
    const first = turnEnd(undefined, BG, 1);
    const pending = turnEnd(first.state, AWS, 2, true);
    assert.equal(pending.action, 'swap');
    /* 排着的时候后台结果那一轮又犯了：不再排第二条 */
    assert.equal(turnEnd(pending.state, AWS, 3).action, 'none');
    /* 被你的新消息取代：没换成，不算次数 */
    const abandoned = swapAbandoned(pending.state);
    assert.deepEqual(abandoned.swaps, []);
    assert.equal(abandoned.swapPending, false);
    assert.equal(turnEnd(abandoned, AWS, 4).action, 'swap', '计数还在，再犯直接换');
  });

  test('控制入口换过后端：计数从头来，停下的状态不动', () => {
    const s: TextToolRecoveryState = { ...emptyRecoveryState(), detections: 1, halted: true };
    assert.deepEqual(afterBackendSwap(s), { ...s, detections: 0 });
  });
});

describe('「这一步是干什么的」', () => {
  test('工具名 + __tool_use_purpose；没有用途只给工具名；什么都没有给一句兜底', () => {
    assert.equal(describeTextToolStep('<invoke name="use_aws"><parameter name="__tool_use_purpose">  查 \n 状态 </parameter></invoke>', ['use_aws']), 'use_aws（查 状态）');
    assert.equal(describeTextToolStep('<invoke name="bg_status"><parameter name="jobId">1</parameter></invoke>', ['bg_status']), 'bg_status');
    assert.equal(describeTextToolStep('<parameter name="x">1</parameter>', []), '刚才那次工具调用');
    assert.equal(textToolContinuePrompt('watch'), '已换新的后端会话，继续刚才没执行的那一步：watch。请直接调用工具。');
  });
});

describe('接线（index.ts）', () => {
  test('换后端会话：EmptyResponse 那条路和「写成文字」/ 控制入口共用 recreateBackendSession', () => {
    const h = slice(M, 'async function recreateBackendSession(', 1500);
    assert.match(h, /entry\.client\.newSession\(cwd\)/);
    assert.match(h, /clearContextEstablished\(sessionId\)/);
    assert.match(h, /markContextOwedIfUnverified\(sessionId, trigger\)/);
    assert.match(slice(M, "if (verdict === 'recreate')", 800), /recreateBackendSession\(sessionId, entry, 'stale-session-recreate'\)/);
    const idle = slice(M, 'async function swapBackendSessionWhenIdle(', 1500);
    assert.match(idle, /recreateBackendSession\(sessionId, entry, trigger\)/);
    /* 换的那一下占住会话（同换模型），别让同一刻的新消息落到旧的后端会话上 */
    assert.match(idle, /reconfiguringSessions\.add\(sessionId\)/);
    assert.match(idle, /finally \{\s*reconfiguringSessions\.delete\(sessionId\)/);
  });

  test('换后端会话不碰后台任务 / 定时任务 / 唤醒队列', () => {
    for (const anchor of ['async function recreateBackendSession(', 'async function swapBackendSessionWhenIdle(']) {
      const at = M.indexOf(anchor);
      const body = M.slice(at, M.indexOf('\n}\n', at));
      assert.doesNotMatch(body, /bgJobs|scheduleStore|wakeDispatcher|schedulesInFlight/, anchor);
    }
  });

  test('wakeDeliver：swap 那一条先换后端会话再续发；续发 id 用换后端的前缀；换过一次不会因为被放回队头再换', () => {
    const d = slice(M, 'wakeDeliver = async (item) => {', 3500);
    const swapAt = d.indexOf("await swapBackendSessionWhenIdle(sid, 'text-tool-call')");
    assert.ok(swapAt > 0);
    assert.ok(swapAt < d.indexOf('await sendPromptOnce('));
    assert.match(d, /if \(nudge && item\.swap && !textToolSwapDone\.has\(item\.id\)\)/);
    assert.match(d, /textToolSwapDone\.add\(item\.id\)/);
  });

  test('你自己发的一条解除停下（sendPromptOnce 开头，自动重发那次不算）', () => {
    assert.match(M, /if \(attempt === 0 && isUserTurnMessageId\(display\?\.messageId\) && textToolRecovery\.has\(sessionId\)\) \{\s*textToolRecovery\.set\(sessionId, afterUserMessage\(/);
  });

  test('会话记忆整理：已有记忆、新产出都清掉文字版调用块；最近消息照旧折叠', () => {
    const c = slice(M, 'async function maybeConsolidateSessionMemory(', 3500);
    assert.match(c, /buildConsolidationPrompt\(recent, stripTextToolCalls\(existing\)\)/);
    assert.match(c, /const merged = consolidatedSessionMemory\(existing, produced\);/);
    assert.match(c, /if \(merged !== null\) \{\s*writeMemory\('session', projectId, sessionId, merged\)/, '清理后为空也要写回');
    assert.match(c, /foldTextToolCall\(m\.content \|\| '', m\.toolTailFrom\)/);
  });

  test('提示有中文；主句开头一个 emoji、不超过 45 字（docs/notices-glossary.md）', () => {
    for (const key of [
      '⚠️ The model still writes tool calls as text, so automatic handling has stopped until you send your next message.',
      '⚠️ Could not switch to a new backend session, so the step that did not run was not continued.',
      '🔀 Switched to a new backend session via the control entry; the context goes along with the next message.',
    ]) {
      const zh = ZH_MAIN[key];
      assert.ok(zh, key);
      assert.match(zh, /^(⚠️|🔀) /);
      assert.ok(zh.length <= 45, zh);
    }
    assert.match(ZH_MAIN['🔀 Switched to a new backend session via the control entry; the context goes along with the next message.'], /经控制入口换了后端会话/);
  });
});

describe('会话记忆：清掉文字版调用块', () => {
  test('压进记忆、被拆成列表行的调用块整段清掉（连同前面那行 code）；其余事实原样', () => {
    const existing = [
      '- cde-agent 跑在 tokyo-arm（i-EXAMPLE）',
      '- code',
      '- <invoke name="use_aws">',
      '- <parameter name="operation_name">send-command</parameter>',
      '- </invoke>',
      '- 配置文件在 /etc/cde/agent.env',
    ].join('\n');
    const clean = stripTextToolCalls(existing);
    assert.equal(clean, '- cde-agent 跑在 tokyo-arm（i-EXAMPLE）\n- 配置文件在 /etc/cde/agent.env');
    /* 整理那一下模型什么都没给：也按清过的写回 */
    assert.equal(mergeSessionMemory(clean, ''), clean);
  });

  test('写回判断：已有记忆全是调用块、这次没产出 → 写回空；没清理什么、这次没产出 → 不写（不把记忆清成空）', () => {
    const allBlocks = '- code\n- <invoke name="use_aws">\n- <parameter name="operation_name">send-command</parameter>\n- </invoke>';
    assert.equal(consolidatedSessionMemory(allBlocks, ''), '');
    assert.equal(consolidatedSessionMemory(allBlocks, '   '), '');
    assert.equal(consolidatedSessionMemory('- 配置在 /etc/cde/agent.env', ''), null);
    assert.equal(consolidatedSessionMemory('', ''), null);
    /* 有产出：合并进去；产出里的调用块也清掉 */
    assert.equal(consolidatedSessionMemory(allBlocks, '服务已恢复\n<invoke name="x"><parameter name="a">1</parameter></invoke>'), '- 服务已恢复');
    /* 没变化 → 不写 */
    assert.equal(consolidatedSessionMemory('- 服务已恢复', '服务已恢复'), null);
  });

  test('一行里夹着的、function_calls 包着的都清；正常的代码块和提到标签名的字不动', () => {
    assert.equal(stripTextToolCalls('- 下一步 <invoke name="bg_status"><parameter name="jobId">1</parameter></invoke>'), '- 下一步');
    assert.equal(stripTextToolCalls('前\n<function_calls>\n<invoke name="watch">\n<parameter name="command">x</parameter>\n</invoke>\n</function_calls>\n后'), '前\n后');
    const legit = '- 部署命令：\n```bash\nsystemctl restart cde-agent\n```\n- 文档里提到 <invoke> 标签';
    assert.equal(stripTextToolCalls(legit), legit);
    assert.equal(stripTextToolCalls('- 没有标记'), '- 没有标记');
  });
});

describe('换后端不影响后台任务：结果照常回到这条会话', () => {
  test('唤醒队列按 KiroLex 会话 id 投递：换后端那条之后，后台命令的结果照样发进同一条会话（落在新的后端会话上）', async () => {
    let backend = 'cli_old';
    const delivered: Array<{ source: string; sessionId: string; backend: string }> = [];
    const d = new WakeDispatcher({
      isBusy: () => false,
      deliver: async (item: WakeItem) => {
        if (item.swap) backend = 'cli_new';   // index.ts wakeDeliver：先换后端会话再续发
        delivered.push({ source: item.source, sessionId: item.sessionId, backend });
      },
    });
    const swap = d.enqueue({ sessionId: 's_cde', text: textToolContinuePrompt('use_aws'), at: 1, source: 'nudge', swap: true });
    const bg = d.enqueue({ sessionId: 's_cde', text: '🔔 后台命令「等 cde-agent 重启」已结束：退出码 0', at: 2, source: 'bg', ref: 'bg_1' });
    const watch = d.enqueue({ sessionId: 's_cde', text: '👀 监视到新输出', at: 3, source: 'watch', ref: 'watch_1' });
    assert.deepEqual(await Promise.all([swap, bg, watch]).then((r) => r.map((x) => x.ok)), [true, true, true]);
    assert.deepEqual(delivered, [
      { source: 'nudge', sessionId: 's_cde', backend: 'cli_new' },
      { source: 'bg', sessionId: 's_cde', backend: 'cli_new' },
      { source: 'watch', sessionId: 's_cde', backend: 'cli_new' },
    ]);
  });
});

describe('后台结果先到：不取消排着的换后端续做', () => {
  /**
   * 和 index.ts 同样的接法：唤醒队列的 isStale 用 textToolWakeStale，计数 turns（开过几轮，纠正 / 续做不算）、
   * userTurns（你发过几条）；换后端那一条入队时 ref 记 userTurns，纠正记 turns。
   */
  function harness() {
    const c = { turns: 0, userTurns: 0, busy: true, backend: 'cli_1' };
    const delivered: string[] = [];
    let state: TextToolRecoveryState | undefined;
    const d = new WakeDispatcher({
      isBusy: () => c.busy,
      isStale: (item) => (item.source === 'nudge' ? textToolWakeStale(item, c) : null),
      deliver: async (item) => {
        if (item.swap) { c.backend = 'cli_2'; state = recordAutoSwap(state, 5); }
        if (item.source !== 'nudge') c.turns += 1;   // 后台结果那一轮算「开了一轮」
        delivered.push(`${item.source}${item.swap ? ':swap' : ''}@${c.backend}`);
      },
      pollMs: 5,
    });
    const enqueueRecovery = (action: 'nudge' | 'swap', text: string) => d.enqueue({
      sessionId: 's', text, at: Date.now(), source: 'nudge',
      ref: String(action === 'swap' ? c.userTurns : c.turns), ...(action === 'swap' ? { swap: true } : {}),
    });
    return { c, d, delivered, enqueueRecovery, getState: () => state, setState: (x: TextToolRecoveryState) => { state = x; } };
  }

  test('这一轮还在跑时 bg 结果入队，这一轮结束判出要换后端：先投 bg 结果，换后端续做照样发出、记一次', async () => {
    const h = harness();
    const bg = h.d.enqueue({ sessionId: 's', text: '🔔 后台命令已结束', at: Date.now() - 1000, source: 'bg', ref: 'bg_1' });
    /* 这一轮结束：第二次写成文字 → swap */
    const first = turnEnd(undefined, BG, 1);
    const dec = turnEnd(first.state, AWS, 2, true);
    assert.equal(dec.action, 'swap');
    h.setState(dec.state);
    const swap = h.enqueueRecovery('swap', dec.prompt!);
    h.c.busy = false;
    const [rb, rs] = await Promise.all([bg, swap]);
    assert.equal(rb.ok, true);
    assert.equal(rs.ok, true, `换后端续做被取消了：${JSON.stringify(rs)}`);
    assert.equal(rs.skipped, undefined);
    assert.deepEqual(h.delivered, ['bg@cli_1', 'nudge:swap@cli_2']);
    assert.deepEqual(h.getState()!.swaps, [5], '实际换成了才记一次');
  });

  test('对照：普通纠正遇到后台结果先跑一轮，照旧作废（那一轮已经接上了）', async () => {
    const h = harness();
    const bg = h.d.enqueue({ sessionId: 's', text: '🔔', at: Date.now() - 1000, source: 'bg', ref: 'bg_1' });
    const nudge = h.enqueueRecovery('nudge', TEXT_TOOL_NUDGE_PROMPT);
    h.c.busy = false;
    const [, rn] = await Promise.all([bg, nudge]);
    assert.equal(rn.skipped, true);
  });

  test('你自己发了一条：换后端续做作废，不记次数（swapAbandoned），下次再犯直接换', async () => {
    const h = harness();
    const first = turnEnd(undefined, BG, 1);
    const dec = turnEnd(first.state, AWS, 2, true);
    h.setState(dec.state);
    const swap = h.enqueueRecovery('swap', dec.prompt!);
    h.c.userTurns += 1; h.c.turns += 1;   // 你发了一条
    h.c.busy = false;
    const r = await swap;
    assert.equal(r.skipped, true);
    assert.equal(h.c.backend, 'cli_1');
    const after = swapAbandoned(h.getState());
    assert.deepEqual(after.swaps, []);
    assert.equal(turnEnd(after, AWS, 3).action, 'swap');
  });

  test('index.ts 接上了：两种项分别记 ref、过时判断走 textToolWakeStale、换成了才 recordAutoSwap、没换成 swapAbandoned', () => {
    const h = slice(M, 'function handleTextToolCall(', 3000);
    assert.ok(h.includes("ref: String((d.action === 'swap' ? userTurnStarts : turnStarts).get(sessionId) || 0)"));
    assert.ok(h.includes("if (d.action === 'swap' && (!r.ok || r.skipped)) textToolRecovery.set(sessionId, swapAbandoned("));
    assert.ok(slice(M, 'function textToolNudgeStale(', 400).includes('textToolWakeStale(item, { turns: turnStarts.get(item.sessionId) || 0, userTurns: userTurnStarts.get(item.sessionId) || 0 })'));
    assert.ok(M.includes('if (attempt === 0 && isUserTurnMessageId(display?.messageId)) userTurnStarts.set(sessionId,'));
    const d = slice(M, 'wakeDeliver = async (item) => {', 3500);
    const swapAt = d.indexOf("await swapBackendSessionWhenIdle(sid, 'text-tool-call')");
    const recAt = d.indexOf('recordAutoSwap(textToolRecovery.get(sid), Date.now())');
    assert.ok(swapAt > 0 && recAt > swapAt);
  });
});

describe('端到端模拟：用 3b3b23fb 的 CDE 回放 fixture', () => {
  const fixture = path.join(import.meta.dirname, 'fixtures', 'textToolCall-cde-replay.jsonl');
  const rows = fs.readFileSync(fixture, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const byId = (id: string) => rows.find((r) => r.id === id);

  /**
   * 一条极简的「会话」：transcript（喂给模型的历史用 foldTextToolCall 折叠）+ 后端会话 id + 恢复状态 + 唤醒队列。
   * 每一轮结束时按 index.ts 的顺序：判定 → 处置 → nudge / swap 入队 → 投递（swap 先换后端再续发）。
   */
  function makeSession() {
    const s = {
      backend: 'cli_1',
      backends: ['cli_1'],
      state: undefined as TextToolRecoveryState | undefined,
      transcript: [] as Array<{ id: string; role: string; content: string; kirolex?: boolean }>,
      sent: [] as Array<{ id: string; text: string; backend: string; history: string }>,
      queue: [] as Array<{ text: string; swap: boolean }>,
    };
    const history = () => s.transcript.filter((m) => !m.kirolex)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.role === 'user' ? m.content : foldTextToolCall(m.content)}`).join('\n\n');
    let lastUserId = '';
    const send = (id: string, text: string, kirolex = false) => {
      lastUserId = id;
      if (isUserTurnMessageId(id)) s.state = afterUserMessage(s.state);
      s.transcript.push({ id, role: 'user', content: text, ...(kirolex ? { kirolex: true } : {}) });
      s.sent.push({ id, text, backend: s.backend, history: history() });
    };
    const reply = (content: string) => {
      const verdict = textToolCallVerdict({ stopReason: 'end_turn', text: content, tailFrom: 0, correctionTurn: isTextToolNudgeId(lastUserId) });
      s.transcript.push({ id: `a_${s.transcript.length}`, role: 'assistant', content });
      if (verdict.action === 'none') return 'none';
      const d = decideTextToolRecovery(s.state, { verdict, text: content, now: s.transcript.length * 1000 });
      s.state = d.state;
      if (d.prompt) s.queue.push({ text: d.prompt, swap: d.action === 'swap' });
      return d.action;
    };
    const drain = () => {
      const item = s.queue.shift();
      if (!item) return null;
      if (item.swap) { s.backend = `cli_${s.backends.length + 1}`; s.backends.push(s.backend); s.state = recordAutoSwap(afterBackendSwap(s.state), s.transcript.length * 1000); }
      send(`${item.swap ? 'nudge_texttool_swap' : 'nudge_texttool'}_${s.sent.length}`, item.text, true);
      return item;
    };
    return { s, send, reply, drain };
  }

  test('连续两条文字版调用 → 自动换后端 → 续发 → 第三条正常回复后继续，用户什么都没点', () => {
    const { s, send, reply, drain } = makeSession();
    send('user_1', byId('u_1').content);
    /* 第一条：bg_status 写成了文字 → 纠正 */
    assert.equal(reply(byId('a_1').content), 'nudge');
    const nudge = drain()!;
    assert.equal(nudge.swap, false);
    assert.equal(s.backend, 'cli_1');
    /* 第二条（纠正那一轮）：use_aws 又写成了文字 → 自动换后端会话 + 续发那一步 */
    assert.equal(reply(byId('a_2').content), 'swap');
    const cont = drain()!;
    assert.equal(cont.swap, true);
    assert.equal(s.backend, 'cli_2', '换到了新的后端会话');
    const last = s.sent[s.sent.length - 1];
    assert.equal(last.backend, 'cli_2');
    assert.match(last.text, /^已换新的后端会话，继续刚才没执行的那一步：use_aws（在 tokyo-arm 上查看 cde-agent 服务状态）/);
    /* 带到新后端的历史：文字版调用全折叠成一句，没有一个标记原样喂回去；KiroLex 提示不进历史 */
    assert.doesNotMatch(last.history, /<invoke|<parameter|<function_calls/);
    assert.match(last.history, /（此处原本应调用工具 bg_status，但被写成了文字，未执行）/);
    assert.match(last.history, /（此处原本应调用工具 use_aws，但被写成了文字，未执行）/);
    assert.doesNotMatch(last.history, /上一条把工具调用写成了文字/);
    /* 第三条：新后端上正常回复（真调了工具） → 不再处置，接着干活 */
    assert.equal(reply(byId('a_4').content), 'none');
    assert.equal(drain(), null);
    assert.equal(s.state!.halted, false);
    /* 之后照常：后台命令的结果回到这条会话，接着处理 */
    send(byId('wake_bg_EXAMPLE_2_1').id, byId('wake_bg_EXAMPLE_2_1').content);
    assert.equal(s.sent[s.sent.length - 1].backend, 'cli_2');
    assert.deepEqual(s.backends, ['cli_1', 'cli_2'], '整段只换了一次后端会话');
  });

  test('整份 fixture 一直犯：最多换 2 次就停下，停下后不再自动发任何东西，直到用户下一条', () => {
    const { s, send, reply, drain } = makeSession();
    send('user_1', byId('u_1').content);
    const bad = rows.filter((r) => r.role === 'assistant' && r.expect === 'text-tool-call');
    const actions: string[] = [];
    for (const r of bad) {
      const a = reply(r.content);
      actions.push(a);
      if (a === 'halt') break;
      drain();
    }
    assert.deepEqual(actions, ['nudge', 'swap', 'swap', 'halt']);
    assert.deepEqual(s.backends, ['cli_1', 'cli_2', 'cli_3']);
    const sentBefore = s.sent.length;
    /* 停下之后后端再犯：什么都不发 */
    assert.equal(reply(bad[bad.length - 1].content), 'none');
    assert.equal(drain(), null);
    assert.equal(s.sent.length, sentBefore);
    /* 用户发了「继续」：恢复自动处理（从纠正开始） */
    send('user_2', '继续');
    assert.equal(reply(bad[0].content), 'nudge');
  });
});

describe('控制入口 POST /sessions/:id/new-backend', () => {
  async function start(newBackend?: ControlSessionAccess['newBackend']) {
    let enabled = false;
    const calls: string[] = [];
    const access: ControlSessionAccess = {
      enabled: () => enabled,
      list: () => [],
      exists: (id) => id === 's_1' || id === 's_busy',
      tail: () => [],
      status: () => ({ busy: false, turnStartedAt: null, queued: 0, lastMessageAt: null }),
      send: async () => ({ ok: false, status: 500, error: 'unused' }),
      ...(newBackend ? { newBackend: async (id: string): Promise<ControlNewBackendResult> => { calls.push(id); return newBackend(id); } } : {}),
    };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kctl-nb-')), 'control.json');
    const logs: string[] = [];
    const srv = await createControlServer({ onQuit: () => {}, file, sessions: access, log: (m) => logs.push(m) });
    const url = (p: string) => `http://127.0.0.1:${srv.port}${p}`;
    const post = (p: string, token: string | null = srv.token) =>
      fetch(url(p), { method: 'POST', headers: token === null ? {} : { Authorization: `Bearer ${token}` } });
    return { srv, url, post, calls, logs, setEnabled: (v: boolean) => { enabled = v; } };
  }
  const impl = async (id: string): Promise<ControlNewBackendResult> =>
    (id === 's_busy' ? { ok: false, status: 409, error: 'busy' } : { ok: true, backendSessionId: 'cli_fresh_123' });

  test('没 token / 错 token → 401，不换', async () => {
    const t = await start(impl); t.setEnabled(true);
    try {
      assert.equal((await t.post('/sessions/s_1/new-backend', null)).status, 401);
      assert.equal((await t.post('/sessions/s_1/new-backend', 'wrong')).status, 401);
      assert.deepEqual(t.calls, []);
    } finally { await t.srv.close(); }
  });

  test('开关关着 → 403 disabled，不换', async () => {
    const t = await start(impl);
    try {
      const r = await t.post('/sessions/s_1/new-backend');
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { ok: false, error: 'disabled' });
      assert.deepEqual(t.calls, []);
    } finally { await t.srv.close(); }
  });

  test('开着 → 200 返回新的后端会话 id；会话不存在 404；这一轮在跑 409；GET 不行', async () => {
    const t = await start(impl); t.setEnabled(true);
    try {
      const ok = await t.post('/sessions/s_1/new-backend');
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true, backendSessionId: 'cli_fresh_123' });
      const missing = await t.post('/sessions/s_nope/new-backend');
      assert.equal(missing.status, 404);
      const busy = await t.post('/sessions/s_busy/new-backend');
      assert.equal(busy.status, 409);
      assert.deepEqual(await busy.json(), { ok: false, error: 'busy' });
      const get = await fetch(t.url('/sessions/s_1/new-backend'), { headers: { Authorization: `Bearer ${t.srv.token}` } });
      assert.equal(get.status, 404);
      assert.deepEqual(t.calls, ['s_1', 's_busy']);
      assert.ok(t.logs.some((l) => /new-backend session=s_1 -> ok/.test(l)));
      assert.ok(t.logs.every((l) => !l.includes(t.srv.token)), '日志里没有 token');
    } finally { await t.srv.close(); }
  });

  test('实现抛错 → 500 swap-failed；没接实现 → 501', async () => {
    const t = await start(async () => { throw new Error('boom'); }); t.setEnabled(true);
    try {
      const r = await t.post('/sessions/s_1/new-backend');
      assert.equal(r.status, 500);
      assert.deepEqual(await r.json(), { ok: false, error: 'swap-failed' });
    } finally { await t.srv.close(); }
    const t2 = await start(); t2.setEnabled(true);
    try {
      assert.equal((await t2.post('/sessions/s_1/new-backend')).status, 501);
    } finally { await t2.srv.close(); }
  });

  test('index.ts 接上了：走同一套换法、会话里标「经控制入口换了后端会话」、这一轮在跑不换', () => {
    const n = slice(M, 'newBackend: async (id) => {', 2000);
    assert.match(n, /controlVisibleRecord\(id\)/);
    assert.match(n, /busy && busy !== 'prime-pending'\) return \{ ok: false, status: 409, error: 'busy' \}/);
    assert.match(n, /swapBackendSessionWhenIdle\(id, 'control-new-backend'\)/);
    assert.match(n, /tr\('🔀 Switched to a new backend session via the control entry/);
    assert.match(n, /return \{ ok: true, backendSessionId: r\.newId \}/);
    assert.match(M, /sessions: controlSessionAccess,/);
  });
});
