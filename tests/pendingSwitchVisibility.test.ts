/*
 * 负责人反馈（2026-10-23）：「切换到本地 Claude Code 的时候不知为什么被拒绝或失败？也可能是后台让我在等，但会话没有提示」。
 * 实测那一轮又跑了 66 秒，期间只有输入框下方一个很小的「⏳ 运行位置 → 本机 ✕」。
 *
 * 这一组守的是"等待看得见"：会话里立刻插提示卡（计时、停止这一轮并立即切换、取消切换）、徽标写人话、
 * 执行阶段和失败说清楚、等待期间发的消息说清会在切换后发出。「忙时不拒绝、先 pending、跑完再切」本身不变
 * （那部分在 pendingSwitch.test.ts）。
 * 它取代了更早一次「等待时不显示『这一轮跑完后切换』之类的字眼」的要求 —— 以负责人最新的要求为准。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PendingSwitchBook,
  PendingSwitchRunner,
  pendingTargetText,
  waitedSeconds,
  livePendingNoteId,
  PENDING_SWITCH_NOTE_GROUP,
  type PendingSwitch,
} from '../src/main/pendingSwitch.ts';

const sw = (kind: PendingSwitch['kind'], value: any, label = String(value)): PendingSwitch => ({ kind, value, label });
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf-8');
const M = read('src', 'main', 'index.ts');
const C = read('src', 'renderer', 'components', 'ChatArea.tsx');
const S = read('src', 'renderer', 'components', 'Sidebar.tsx');
const sliceFrom = (src: string, anchor: string, len: number) => {
  const i = src.indexOf(anchor);
  assert.ok(i >= 0, `找不到 ${anchor}`);
  return src.slice(i, i + len);
};
/** 从 `function name(` 截到函数结尾（顶格的 `}`） */
const fnOf = (src: string, head: string) => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `找不到 ${head}`);
  return src.slice(i, src.indexOf('\n}\n', i));
};
const kindName = (k: string) => ({ remote: '运行位置', engine: '引擎', model: '模型', agent: 'Agent', permission: '权限模式', engineEffort: '思考强度' } as Record<string, string>)[k] || k;

describe('「切到 ___」和「已等 N 秒」', () => {
  test('一项时只说新值（本机 / Claude Code / agent 名）；类别名不言自明的不加；几项按应用顺序列出', () => {
    assert.equal(pendingTargetText({ remote: '本机' }, kindName, '、'), '本机');
    assert.equal(pendingTargetText({ engine: 'Claude Code' }, kindName, '、'), 'Claude Code');
    assert.equal(pendingTargetText({ permission: 'ask' }, kindName, '、'), '权限模式 ask', '只说 ask 看不出是什么');
    assert.equal(pendingTargetText({ engineEffort: 'high' }, kindName, '、'), '思考强度 high');
    assert.equal(pendingTargetText({ model: 'opus', remote: '本机', agent: 'reviewer' }, kindName, '、'), '运行位置 本机、Agent reviewer、模型 opus');
  });

  test('计时从这段等待第一次登记算起；同一段里再改选不重新计时；切完 / 取消后下一段重新计', () => {
    const book = new PendingSwitchBook();
    book.set('s', sw('remote', null, '本机'), 1_000);
    book.set('s', sw('model', 'opus'), 9_000); // 同一段等待里又选了一项
    assert.equal(book.sinceOf('s'), 1_000);
    assert.equal(waitedSeconds(book.sinceOf('s')!, 67_400), 66, '实测那次：等了 66 秒');
    assert.equal(waitedSeconds(5_000, 4_000), 0, '不为负');
    book.takeForApply('s');
    assert.equal(book.sinceOf('s'), undefined, '取走去应用：不再算在等');
    book.set('s', sw('agent', 'a'), 80_000);
    assert.equal(book.sinceOf('s'), 80_000, '新的一段等待重新计时');
    book.cancel('s');
    assert.equal(book.sinceOf('s'), undefined);
  });

  test('主进程把开始时刻推给界面（事件 + 窗口重载后补拿）', () => {
    assert.ok(M.includes("since: pendingSwitches.sinceOf(sessionId) ?? null });"));
    assert.ok(M.includes("ipcMain.handle('acp:get-pending-switch-since'"));
    assert.ok(read('src', 'main', 'preload.ts').includes("'acp:get-pending-switch-since'"));
  });
});

describe('会话里的提示卡：插入 / 活卡片 / 停止并立即切换 / 取消', () => {
  test('插入：忙时登记的第一项就在会话里插提示（noteInSession，不进模型历史），同一段等待只插一条', () => {
    const q = sliceFrom(M, 'function queueSwitchWhileBusy(', 2500);
    assert.ok(q.indexOf('const firstOfThisWait = !pendingSwitches.has(sessionId);') < q.indexOf('pendingSwitches.set(sessionId'), '先判断是不是这段等待的第一项，再登记');
    assert.ok(/if \(firstOfThisWait\) \{\s*noteInSession\(sessionId, tr\('⏳ This turn is still running; will switch to \{target\} once it finishes\.'/.test(q));
    assert.ok(q.includes('PENDING_SWITCH_NOTE_GROUP'), '打上分组，界面才认得出它');
    /* 用真实的 book 跑一遍"只插一条"的判断 */
    const book = new PendingSwitchBook();
    const inserted: string[] = [];
    const queue = (e: PendingSwitch) => { const first = !book.has('s'); book.set('s', e); if (first) inserted.push(e.label); };
    queue(sw('remote', null, '本机'));
    queue(sw('model', 'opus'));
    queue(sw('remote', 'box', 'box'));
    assert.deepEqual(inserted, ['本机']);
  });

  test('哪条画成活卡片：属于这段等待的最后那条；上一段留下的不算；没有待切换就没有', () => {
    const notes = [
      { id: 'old', kirolex: true, noteGroup: PENDING_SWITCH_NOTE_GROUP, timestamp: 1_000 },
      { id: 'reply', timestamp: 2_000 },
      { id: 'new', kirolex: true, noteGroup: PENDING_SWITCH_NOTE_GROUP, timestamp: 50_000 },
      { id: 'other-note', kirolex: true, noteGroup: 'something-else', timestamp: 51_000 },
    ];
    assert.equal(livePendingNoteId(notes, 50_000), 'new');
    assert.equal(livePendingNoteId(notes, undefined), null, '已切完 / 已取消：退回成普通的一句话');
    assert.equal(livePendingNoteId(notes.slice(0, 2), 50_000), null, '这段等待的提示还没进列表（流式输出时先攒着）→ 画在列表底下');
  });

  test('卡片：每秒刷新已等秒数；两个按钮；有排队消息时说会在切换后发出；列表里 / 列表底下两种放法', () => {
    const card = fnOf(C, 'function PendingSwitchCard(');
    assert.ok(/setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/.test(card), '每秒走一次');
    assert.ok(card.includes('waitedSeconds(since, now)'));
    assert.ok(card.includes("t('⏳ This turn is still running; will switch to {target} once it finishes (waited {n}s).', { target, n: waited })"));
    assert.ok(card.includes("t('Stop this turn and switch now')") && card.includes('onClick={onStopNow}'));
    assert.ok(card.includes("t('Cancel switch')") && card.includes('onClick={onCancel}'));
    assert.ok(card.includes("t('{n} queued message(s) will be sent once the switch finishes.', { n: queued })"));
    const at = C.indexOf('const pendingCard = hasPendingSwitch ? {');
    const wiring = C.slice(at, C.indexOf('} : null;', at));
    assert.ok(wiring.includes('onStopNow: onCancel,'), '停止 = 这一格自己的停止按钮那条路');
    assert.ok(wiring.includes('onCancel: () => onCancelPendingSwitch?.(),'), '不带 kind = 整段取消');
    assert.ok(wiring.includes('queued: queuedMessages.length,'));
    assert.ok(C.includes("group.kind === 'kirolex' && group.message.id === livePendingId && pendingCard ? ("));
    assert.ok(C.includes('{pendingCard && !livePendingId && <PendingSwitchCard {...pendingCard} />}'));
  });

  test('「停止这一轮并立即切换」：按停止 → 这一轮结束 → 记下的切换立刻应用（和正常结束同一条 kick 路径）', async () => {
    const book = new PendingSwitchBook();
    let busy = true;
    const applied: string[] = [];
    const runner = new PendingSwitchRunner(book, { isBusy: () => busy, apply: async (_s, es) => { applied.push(...es.map((e) => e.label)); } });
    book.set('s', sw('remote', null, '本机'));
    assert.equal(runner.kick('s'), undefined, '还在跑：不切');
    busy = false; // Stop：sendPromptOnce 收尾
    await runner.kick('s');
    assert.deepEqual(applied, ['本机']);
  });

  test('「取消切换」：整段取消后不再应用，会话里说一声', () => {
    const book = new PendingSwitchBook();
    const runner = new PendingSwitchRunner(book, { isBusy: () => false, apply: async () => { throw new Error('不该应用'); } });
    book.set('s', sw('remote', null, '本机'));
    book.set('s', sw('model', 'opus'));
    assert.equal(book.cancel('s'), true);
    assert.equal(runner.kick('s'), undefined);
    const ipc = sliceFrom(M, "ipcMain.handle('acp:cancel-pending-switch'", 900);
    assert.ok(/if \(cancelled && !pendingSwitches\.has\(sessionId\)\) \{\s*noteInSession\(sessionId, tr\('Switch cancelled; this session keeps its current setting\.'\)/.test(ipc));
  });
});

describe('执行阶段 / 失败 / 等待期间的消息', () => {
  test('执行阶段看得见：启动 → 交历史 → ✅', () => {
    const batch = sliceFrom(M, 'applyPendingSwitchBatch = async', 9000);
    const start = batch.indexOf('if (startNote) sessionNotice(sessionId, startNote);');
    const history = batch.indexOf("tr('Handing the conversation history to the new backend…')");
    const done = batch.indexOf("tr('✅ Switched to {target}.'");
    assert.ok(start > 0 && history > start && done > history, '启动 → 交历史 → ✅ 的顺序');
    /* 「交历史」只在这一刻真的在交接（逐段重放）时说：快照模式随下一条消息带过去，说了会挂在状态行上误导 */
    const prime = batch.indexOf('if (fresh.priming || fresh.needsHistoryPrime || fresh.primePromise) {');
    assert.ok(prime > 0 && prime < history, '「正在把对话历史交给新后端…」在真要交接的分支里');
    /* 切完：状态行最后一句换成结果，把「正在启动…」顶掉 */
    assert.ok(/if \(!report\.failed\.length\) sessionNotice\(sessionId, doneText\);/.test(batch));
    const startFn = sliceFrom(M, 'const startingNoteFor = (', 1500);
    assert.ok(startFn.includes("tr('Starting {engine} on this computer…'"), '「正在启动本机 Claude Code 适配器…」');
    assert.ok(startFn.includes("tr('{engine} adapter'"));
    assert.ok(startFn.includes("tr('Starting {engine} on {host}…'"));
  });

  test('失败：在会话里说清原因和"还在原来的 ___ 上，可以继续用"，不只写日志；逐段重放的历史交接失败也说', () => {
    const batch = sliceFrom(M, 'applyPendingSwitchBatch = async', 9000);
    const failed = batch.indexOf("tr('⚠️ Could not switch: {list}. This session stays on {current}, and you can keep using it.'");
    assert.ok(failed > 0);
    assert.ok(batch.slice(failed, failed + 400).includes('noteInSession(sessionId, failText, undefined,'), '失败进对话记录');
    assert.ok(batch.includes('sessionNotice(sessionId, failText);'), '状态行也以失败收尾，不挂着「正在启动…」');
    assert.ok(batch.includes('currentValueForPeople(f.kind, p)'), '说清现在实际在用的是什么');
    assert.ok(batch.includes("${f.error}"), '带上原因');
    assert.ok(batch.includes("tr('⚠️ The switch is done, but handing the conversation history to the new backend did not finish ({why}). The next message will retry it.'"));
  });

  test('等待期间又发了消息：这条要等切换 → 说「会在切换完成后发出」，在等之前说，只在真要等时说', () => {
    const head = sliceFrom(M, 'async function sendPromptOnce(', 2500);
    const note = head.indexOf("sessionNotice(sessionId, tr('⏳ This message will be sent once the switch finishes.'))");
    assert.ok(note > 0 && note < head.indexOf('await pendingSwitchRunner.settle(sessionId)'));
    assert.ok(/!sessionClients\.get\(sessionId\)\?\.busy && \(pendingSwitches\.has\(sessionId\) \|\| pendingSwitchRunner\.isApplying\(sessionId\)\)/.test(head));
  });
});

describe('和 d0a22e82（忙时 Enter 交给适配器排）的交界', () => {
  test('有切换欠着时不交给适配器排（否则它在旧设置上抢先跑），退回 KiroLex 队列 —— 切换完再发；没欠着照旧交', () => {
    const at = M.indexOf("if (handoff?.kind === 'queued') {");
    assert.ok(at > 0);
    const block = M.slice(at, M.indexOf('\n    }\n', at));
    const original = block.indexOf("if (!entry.turnRunning || !entry.client.supportsPromptQueueing) throw new HandoffRefused('unsupported');");
    const ours = block.indexOf("if (pendingSwitches.has(sessionId) || pendingSwitchRunner.isApplying(sessionId)) {");
    assert.ok(original > 0, 'main 原来的判断原样保留');
    assert.ok(ours > original, '只是多一个退回的条件');
    assert.ok(block.slice(ours, ours + 300).includes("throw new HandoffRefused('unsupported');"), "和没声明 promptQueueing 同一条退路（渲染端 'unsupported' → 进 KiroLex 队列）");
    assert.ok(read('src', 'renderer', 'steerRoute.ts').includes("if (reason === 'unsupported') return 'queue';"));
  });
});

describe('输入框下的徽标', () => {
  test('「⏳ 本轮结束后切到 ___ · 取消」，悬停写全原因；每一类都写明切到什么', () => {
    const badge = fnOf(C, 'function PendingSwitchBadge(');
    assert.ok(badge.includes("t('⏳ Switches to {target} after this turn', { target })"));
    assert.ok(badge.includes("title={t('This turn is still running. To avoid interrupting it, KiroLex switches to {target} as soon as it finishes. Click Cancel to stay as you are.', { target })}"));
    assert.ok(badge.includes(">{t('Cancel')}</button>"), '「取消」是字，不是一个看不懂的 ✕');
    for (const kind of ['engine', 'remote', 'engineEffort', 'combo', 'agent']) {
      assert.ok(C.includes(`<PendingSwitchBadge target={pendingTargetForPeople(pendingSwitch, ['${kind}'])}`), `${kind} 的徽标写明切到什么`);
    }
  });

  test('侧栏换引擎 / 运行位置忙时不另弹提示（会话里已经有提示卡）', () => {
    assert.equal((S.match(/if \(r\?\.pending\) return;/g) || []).length, 2);
  });
});
