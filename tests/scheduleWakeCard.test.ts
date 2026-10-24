import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 定时唤醒在会话里画成紧凑的「⏰ 定时」卡片（不是用户气泡）—— 解析器、结束卡、给模型的原文不变、渲染接线。
 */
const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (...parts: string[]) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const view = await import('../src/main/scheduleWakeView.ts');
const sched = await import('../src/main/schedule.ts');

const PROMPT = '看一下 d0a22e82、66540cd0 两个任务的状态，有变化就汇报';
const UNTIL = 'd0a22e82、66540cd0 都 done 或 cancelled';
const ID = 'sched_1729000000000_ab12cd';

function goalState(extra: Record<string, unknown> = {}) {
  return {
    ...sched.createSchedule('s1', { prompt: PROMPT, kind: 'interval', everySec: 300, maxRuns: null, until: UNTIL, checkCommand: 'board status' }, 0),
    ...extra,
  } as any;
}

/** 和 index.ts `runScheduledJob` 拼给模型的那一段同一个写法 */
function modelText(state: any, check: string, lang: 'zh' | 'en' = 'zh') {
  return state.spec.prompt + sched.scheduleGoalSuffix(state, ID, check, lang);
}

describe('给模型的文本一个字不改（快照）', () => {
  test('检查有变化 / 达成 / 出错 / 无检查命令 四种，逐字和改前相同', () => {
    const changed = sched.planScheduleCheck(goalState(), { status: 'exited', code: 1, output: 'd0a22e82 running\n66540cd0 done\n' }, 10, 'zh');
    assert.equal(modelText(goalState(), changed.text),
      `${PROMPT}\n\n🎯 目标：${UNTIL}\n🔎 检查命令退出码 1（还没达成），输出和上次不同：\nd0a22e82 running\n66540cd0 done\n`
      + `（这是定时任务 ${ID}。目标达成后调用 schedule_delete（id ${ID}）结束它；还没达成就照常结束这一轮，到点会再叫你。）`);

    const achieved = sched.planScheduleCheck(goalState(), { status: 'exited', code: 0, output: 'all done' }, 10, 'zh');
    assert.equal(modelText(achieved.state, achieved.text),
      `${PROMPT}\n\n🎯 目标：${UNTIL}\n✅ 检查命令退出码 0：目标已达成，这个定时任务已自动结束。请做最终汇报。\nall done`);

    const failed = sched.planScheduleCheck(goalState(), { status: 'timeout', output: '' }, 10, 'zh');
    assert.equal(modelText(failed.state, failed.text),
      `${PROMPT}\n\n🎯 目标：${UNTIL}\n⚠️ 检查命令出错（超时），已连续 1 次；连续 3 次会自动暂停任务：\n（没有输出）\n`
      + `（这是定时任务 ${ID}。目标达成后调用 schedule_delete（id ${ID}）结束它；还没达成就照常结束这一轮，到点会再叫你。）`);

    const plain = sched.createSchedule('s1', { prompt: '写周报', kind: 'daily', atTime: '09:00', everySec: 0, maxRuns: 5 }, 0);
    assert.equal(modelText(plain, ''), '写周报', '没有 until 的任务 prompt 原样发');
  });

  test('接线：runScheduledJob 发出去的还是 prompt + scheduleGoalSuffix，消息 id 只多了第几次', () => {
    const MAIN = strip(read('main', 'index.ts'));
    const at = MAIN.indexOf('async function runScheduledJob');
    const body = MAIN.slice(at, MAIN.indexOf('function runScheduleCheck', at));
    assert.match(body, /text: state\.spec\.prompt \+ scheduleGoalSuffix\(state, id, check\), at, source: 'schedule', ref: id, run: charged\.runs/);
    assert.match(MAIN, /scheduleWakeMessageId\(item\.ref, item\.run, Date\.now\(\)\)/);
    assert.match(MAIN, /displayText: nudge && item\.swap \? `🔀 \$\{item\.text\}` : item\.text/, '显示的原文就是发给模型的原文');
  });
});

describe('parseScheduleWake：拆成 {name, run, status, changedLines, details}', () => {
  test('一条完整的旧格式唤醒（检查有变化）', () => {
    const plan = sched.planScheduleCheck(goalState(), { status: 'exited', code: 1, output: 'd0a22e82 running\n66540cd0 done\nupdated 12:30' }, 10, 'zh');
    const content = modelText(goalState(), plan.text);
    const card = view.parseScheduleWake(
      { id: 'u_17_x', role: 'user', content },
      { prevOutput: 'd0a22e82 running\n66540cd0 running\nupdated 12:25', run: 4 },
    );
    assert.ok(card);
    assert.equal(card!.name, '看一下 d0a22e82、66540cd…', '前 20 个字');
    assert.equal(card!.run, 4);
    assert.equal(card!.status, 'changed');
    assert.equal(card!.scheduleId, ID);
    assert.deepEqual(card!.changedLines, [
      { text: '66540cd0 running', removed: true }, { text: 'updated 12:25', removed: true },
      { text: '66540cd0 done' }, { text: 'updated 12:30' },
    ], '每次都一样的那行不显示；没了的行标 removed');
    assert.equal(card!.details.prompt, PROMPT);
    assert.equal(card!.details.until, UNTIL);
    assert.equal(card!.details.checkOutput, 'd0a22e82 running\n66540cd0 done\nupdated 12:30');
    assert.equal(card!.details.checkHeader, '🔎 检查命令退出码 1（还没达成），输出和上次不同：');
    assert.match(card!.details.note!, /^（这是定时任务 sched_1729000000000_ab12cd。/);
  });

  test('第一次（没有上一次）：全部行都算变化；英文版同样认得', () => {
    const plan = sched.planScheduleCheck(goalState(), { status: 'exited', code: 1, output: 'a\nb' }, 10, 'en');
    const card = view.parseScheduleWake({ id: 'x', role: 'user', content: modelText(goalState(), plan.text, 'en') });
    assert.equal(card?.status, 'changed');
    assert.deepEqual(card?.changedLines, [{ text: 'a' }, { text: 'b' }]);
    assert.equal(card?.details.until, UNTIL);
    assert.equal(card?.scheduleId, ID);
  });

  test('达成分支', () => {
    const plan = sched.planScheduleCheck(goalState(), { status: 'exited', code: 0, output: 'all done' }, 10, 'zh');
    const card = view.parseScheduleWake({ id: `sched_${ID}_r7_1729000000999`, role: 'user', content: modelText(plan.state, plan.text) });
    assert.equal(card?.status, 'achieved');
    assert.equal(card?.run, 7, '新消息 id 里带着第几次');
    assert.equal(card?.scheduleId, ID, '达成那条没有说明行，靠 id 认是哪个定时');
    assert.deepEqual(card?.changedLines, [{ text: 'all done' }]);
    assert.equal(card?.details.note, undefined);
  });

  test('出错分支（含连续出错自动暂停）；（无输出）不算一行', () => {
    const once = sched.planScheduleCheck(goalState(), { status: 'timeout', output: '' }, 10, 'zh');
    const c1 = view.parseScheduleWake({ id: 'x', role: 'user', content: modelText(once.state, once.text) });
    assert.equal(c1?.status, 'error');
    assert.equal(c1?.paused, false);
    assert.deepEqual(c1?.changedLines, []);
    assert.equal(c1?.details.checkOutput, '');

    const paused = sched.planScheduleCheck(goalState({ checkErrors: 2 }), { status: 'exited', code: 2, output: 'boom' }, 10, 'zh');
    const c2 = view.parseScheduleWake({ id: 'x', role: 'user', content: modelText(paused.state, paused.text) });
    assert.equal(c2?.status, 'error');
    assert.equal(c2?.paused, true);
    assert.deepEqual(c2?.changedLines, [{ text: 'boom' }]);
  });

  test('无 checkCommand：按时唤醒（目标型 / 普通定时都是）', () => {
    const goalOnly = sched.createSchedule('s1', { prompt: PROMPT, kind: 'interval', everySec: 300, maxRuns: null, until: UNTIL }, 0);
    const c1 = view.parseScheduleWake({ id: 'u_1', role: 'user', content: modelText(goalOnly, '') });
    assert.equal(c1?.status, 'timer');
    assert.equal(c1?.details.until, UNTIL);
    assert.deepEqual(c1?.changedLines, []);

    const c2 = view.parseScheduleWake({ id: `sched_${ID}_1729000000999`, role: 'user', content: '写周报' });
    assert.equal(c2?.status, 'timer');
    assert.equal(c2?.name, '写周报');
    assert.equal(c2?.scheduleId, ID);
    assert.equal(c2?.details.prompt, '写周报');
  });

  test('识别不了的保持原样：普通用户消息、助手的话、KiroLex 提示都不是', () => {
    assert.equal(view.parseScheduleWake({ id: 'user_1', role: 'user', content: '帮我看看\n\n🎯 目标：写完' }), null);
    assert.equal(view.parseScheduleWake({ id: 'user_1', role: 'user', content: '写周报' }), null);
    assert.equal(view.parseScheduleWake({ id: `sched_${ID}_1`, role: 'assistant', content: '好的' }), null);
    assert.equal(view.parseScheduleWake({ id: `sched_${ID}_1`, role: 'user', kirolex: true, content: '写周报' }), null);
  });

  test('只删了行：没了的那行标成 removed，不再是空列表', () => {
    assert.deepEqual(view.changedLines('task A running', 'task A running\ntask B running'), [{ text: 'task B running', removed: true }]);
  });

  test('输出变空：上次的每一行都标成 removed', () => {
    assert.deepEqual(view.changedLines('', 'task A running\ntask B running'), [
      { text: 'task A running', removed: true }, { text: 'task B running', removed: true },
    ]);
    const plan = sched.planScheduleCheck(goalState(), { status: 'exited', code: 1, output: '' }, 10, 'zh');
    const card = view.parseScheduleWake({ id: 'x', role: 'user', content: modelText(goalState(), plan.text) }, { prevOutput: 'task A running' });
    assert.deepEqual(card?.changedLines, [{ text: 'task A running', removed: true }], '（没有输出）不算一行，上次那行算没了');
  });

  test('增删混合：按行对齐，没变的行不出现，删掉的和新出现的都在、顺序跟着输出走', () => {
    assert.deepEqual(view.changedLines('A 80%\nB done\nC new\nfooter', 'A 40%\nB done\nD old\nfooter'), [
      { text: 'A 40%', removed: true }, { text: 'A 80%' },
      { text: 'D old', removed: true }, { text: 'C new' },
    ]);
    /* 重复的行按次数抵 */
    assert.deepEqual(view.changedLines('x\nx', 'x\nx\nx'), [{ text: 'x', removed: true }]);
    /* 很长的输出退回按行计数，结果同样包含删掉的行 */
    const big = (tag: string) => Array.from({ length: 600 }, (_, i) => `${tag}${i}`).join('\n');
    const diff = view.changedLines(`${big('k')}\nnew`, `${big('k')}\nold`);
    assert.deepEqual(diff, [{ text: 'old', removed: true }, { text: 'new' }]);
  });

  test('变化的行超过 5 行时全都给出（界面只显示前 5 行，其余「展开」）', () => {
    const cur = Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n');
    assert.equal(view.changedLines(cur, 'line 0').length, 7);
    assert.equal(view.SCHEDULE_CARD_LINES, 5);
  });
});

describe('scheduleWakeCards：一条会话里的所有唤醒，第几次 / 上一次的输出按同一个定时串起来', () => {
  test('旧消息 id 里没有第几次：按出现顺序数；变化的行和同一个定时的上一次比', () => {
    const t1 = modelText(goalState(), sched.planScheduleCheck(goalState(), { status: 'exited', code: 1, output: 'a\nb' }, 1, 'zh').text);
    const t2 = modelText(goalState(), sched.planScheduleCheck(goalState(), { status: 'exited', code: 1, output: 'a\nc' }, 2, 'zh').text);
    const cards = view.scheduleWakeCards([
      { id: 'u_1', role: 'user', content: t1 },
      { id: 'a_1', role: 'assistant', content: '还没好' },
      { id: 'user_2', role: 'user', content: '顺便问一句' },
      { id: 'u_2', role: 'user', content: t2 },
    ]);
    assert.equal(cards.size, 2);
    assert.equal(cards.get('u_1')?.run, 1);
    assert.equal(cards.get('u_2')?.run, 2);
    assert.deepEqual(cards.get('u_2')?.changedLines, [{ text: 'b', removed: true }, { text: 'c' }]);
  });
});

describe('parseScheduleEnd：结束 / 暂停用同一种卡片的收尾样式', () => {
  const final = { ...goalState(), runs: 12 };
  test('目标达成、过期（目标没达成）、被删、用完次数', () => {
    const ach = view.parseScheduleEnd({ role: 'user', kirolex: true, content: sched.scheduleEndedText(final, 'achieved', 'zh'), noteGroup: `schedule-end:${ID}` });
    assert.equal(ach?.kind, 'ended');
    assert.equal(ach?.scheduleId, ID);
    assert.equal(ach?.outcome, '目标达成（每 5 分钟，共运行 12 次）');

    const exp = view.parseScheduleEnd({ role: 'user', kirolex: true, content: sched.scheduleEndedText(final, 'expired', 'zh') });
    assert.equal(exp?.outcome, '已过期，但目标还没达成（每 5 分钟，共运行 12 次）');
    assert.equal(exp?.until, UNTIL, '目标放进详情');

    const del = view.parseScheduleEnd({ role: 'user', kirolex: true, content: sched.scheduleEndedText(final, 'cancelled', 'en') });
    assert.equal(del?.kind, 'ended');
    assert.match(del!.outcome, /^Cancelled \(/);
  });

  test('连续出错自动暂停那句', () => {
    const paused = sched.planScheduleCheck(goalState({ checkErrors: 2 }), { status: 'timeout', output: 'slow' }, 10, 'zh');
    const end = view.parseScheduleEnd({ role: 'user', kirolex: true, content: paused.note! });
    assert.equal(end?.kind, 'paused');
    assert.match(end!.outcome, /^定时任务的检查命令连续出错 3 次（超时），任务已自动暂停。/);
    assert.equal(end?.output, 'slow');
  });

  test('旧记录里的两种写法（含 ⏰ 开头的）也认；别的 KiroLex 提示 / 你自己打的字不认', () => {
    assert.equal(view.parseScheduleEnd({ role: 'user', kirolex: true, content: '⏰ 定时任务结束：运行次数用完\n每天 09:00 · 共运行 3 次' })?.outcome, '运行次数用完');
    assert.equal(view.parseScheduleEnd({ role: 'user', kirolex: true, content: '🔀 换到了 gpt-5' }), null);
    assert.equal(view.parseScheduleEnd({ role: 'user', content: '定时任务结束：再来一个' }), null);
  });
});

describe('渲染接线', () => {
  const CHAT = strip(read('renderer', 'components', 'ChatArea.tsx'));
  test('定时唤醒单独成组、画成 ScheduleWakeCard，不走用户气泡组件', () => {
    assert.match(CHAT, /const wake = scheduleCards\.get\(m\.id\);\s*if \(wake\) \{[\s\S]{0,200}groups\.push\(\{ kind: 'schedule', message: m, card: wake \}\)/);
    const at = CHAT.indexOf("group.kind === 'schedule' ? (");
    assert.ok(at > 0, '渲染分支不见了');
    const branch = CHAT.slice(at, CHAT.indexOf(') : ', at + 30));
    assert.match(branch, /<ScheduleWakeCard/);
    assert.doesNotMatch(branch, /UserGroupItem/);
    const card = CHAT.slice(CHAT.indexOf('const ScheduleWakeCard'), CHAT.indexOf('const ScheduleEndCard'));
    assert.ok(card.length > 0);
    assert.doesNotMatch(card, /UserGroupItem|user-message/);
    assert.match(card, /SCHEDULE_CARD_LINES/);
    assert.match(card, /l\.removed\s*\?\s*<div key=\{i\} className="schedule-card-line-removed"/, '没了的行要标出来');
  });

  test('结束那句画成同一种卡片的收尾样式；主进程那几处结束语都带上 schedule-end 分组（不多插一条）', () => {
    assert.match(CHAT, /const end = parseScheduleEnd\(m\);/);
    assert.match(CHAT, /<ScheduleEndCard/);
    const MAIN = strip(read('main', 'index.ts'));
    assert.match(MAIN, /noteInSession\(state\.sessionId, scheduleEndedText\(final, terminal\), \{\s*zh: scheduleEndedText\(final, terminal, 'zh'\), en: scheduleEndedText\(final, terminal, 'en'\),\s*\}, scheduleEndGroup\(id\)\)/);
    assert.match(MAIN, /noteInSession\(job\.state\.sessionId, scheduleEndedText\(final, 'expired'\), undefined, scheduleEndGroup\(job\.id\)\)/);
    assert.match(MAIN, /noteUser: \(sid, text\) => \{ noteInSession\(sid, text, undefined, scheduleEndGroup\(id\)\);/);
  });

  test('被删（你删 / 模型 schedule_delete）：跑过、还没结束的才说一句结局', () => {
    const MAIN = strip(read('main', 'index.ts'));
    const fn = MAIN.slice(MAIN.indexOf('function noteScheduleRemoved'), MAIN.indexOf('function noteInSession'));
    assert.match(fn, /if \(!job \|\| job\.state\.terminal \|\| job\.state\.runs <= 0\) return;/);
    assert.match(fn, /scheduleEndedText\(final, 'cancelled'\)[\s\S]*scheduleEndGroup\(job\.id\)/);
    const remove = MAIN.slice(MAIN.indexOf("ipcMain.handle('schedule:remove'"), MAIN.indexOf("ipcMain.handle('loop:persist'"));
    assert.match(remove, /noteScheduleRemoved\(removing\)/);
    const del = MAIN.slice(MAIN.indexOf('deleteSchedule: (sessionId, id) =>'), MAIN.indexOf('bg: bgJobs,'));
    assert.match(del, /noteScheduleRemoved\(job\)/);
  });
});
