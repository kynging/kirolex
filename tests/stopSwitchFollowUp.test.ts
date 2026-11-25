import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  decideStopSwitchFollowUp, interruptPlanFor, rerunIdFor, SWITCH_CONTINUE_PROMPT,
  turnBaseIndex, turnOriginOf, turnProduced, type TurnOrigin,
} from '../src/renderer/stopSwitchFollowUp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const hook = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
const chat = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'App.tsx'), 'utf8');

const WEDGE = '上一轮被 KiroLex 判定"静默太久"自动中断了。接着做。';

describe('turnOriginOf：这一轮的基础消息从哪来', () => {
  const cases: Array<[string, string, TurnOrigin]> = [
    ['user_1732500000000_abc123', '帮我改一下 README', 'user'],
    ['user_xs_1732500000000_abc123', '⟨session:s_1 · depth:1 · call:c7⟩ 查一下日志', 'session'],
    ['queue_xs_1732500000000_abc123', '⟨session:s_1 · depth:1 · call:c7⟩ 查一下日志', 'session'],
    ['user_ctl_1732500000000_abc123', '跑测试', 'control'],
    ['sched_job1_r3_1732500000000', '每天检查一次', 'schedule'],
    ['wake_bg_lz3k1_1732500000000', '后台任务结束了', 'bg'],
    ['wake_check_lz3k1_1732500000000', '检查结束了', 'bg'],
    ['wake_watch_lz3k1_1732500000000', '监视到变化', 'watch'],
    ['loop_1732500000000_4', '第 4 轮', 'loop'],
    ['nudge_texttool_1732500000000', '刚才把工具调用写成了文字', 'nudge'],
    ['user_1732500000000_abc123', SWITCH_CONTINUE_PROMPT, 'auto-continue'],
    ['user_kcont_1732500000000_abc123', '接着做', 'auto-continue'],
    ['loop_1732500000000_4_c1732500009999', SWITCH_CONTINUE_PROMPT, 'loop'],
  ];
  for (const [id, content, want] of cases) {
    test(`${id} → ${want}`, () => assert.equal(turnOriginOf({ id, content }), want));
  }
  test('静默续写那句由调用方传进来也认', () => {
    assert.equal(turnOriginOf({ id: 'user_1_a', content: WEDGE }, [WEDGE, SWITCH_CONTINUE_PROMPT]), 'auto-continue');
    assert.equal(turnOriginOf({ id: 'user_1_a', content: WEDGE }), 'user');
  });
});

describe('turnBaseIndex / turnProduced', () => {
  const u = (id: string, content = 'q', extra: object = {}) => ({ id, role: 'user' as const, content, ...extra });
  const a = (id: string, content: string, extra: object = {}) => ({ id, role: 'assistant' as const, content, ...extra });
  test('基础那条跳过 steer 和 KiroLex 提示', () => {
    const msgs = [u('u1'), a('a1', 'ok'), u('u2'), u('s1', 'steer', { steer: 'consumed' }), u('n1', '✅ 已切到 x', { kirolex: true })];
    assert.equal(turnBaseIndex(msgs), 2);
  });
  test('nudge 那条虽然显示成 KiroLex 提示，它就是这一轮的提问', () => {
    const msgs = [u('u1'), a('a1', 'ok'), u('nudge_texttool_1732500000000', '纠正', { kirolex: true })];
    assert.equal(turnBaseIndex(msgs), 2);
  });
  test('没产出：只有思考段 / 什么都没有', () => {
    assert.equal(turnProduced([u('u1')], 0), false);
    assert.equal(turnProduced([u('u1'), a('a1', '💭 想一想')], 0), false);
  });
  test('有正文或工具调用就算有产出', () => {
    assert.equal(turnProduced([u('u1'), a('a1', '好的，我先看')], 0), true);
    assert.equal(turnProduced([u('u1'), a('a1', '', { toolCalls: [{ id: 't' }] })], 0), true);
  });
});

describe('decideStopSwitchFollowUp：停止并切换之后', () => {
  const nonUser: TurnOrigin[] = ['session', 'control', 'schedule', 'bg', 'watch', 'nudge', 'auto-continue'];
  for (const origin of ['user', ...nonUser] as TurnOrigin[]) {
    test(`${origin}：切换成功 + 没产出 → 原样重发，不放回输入框`, () => {
      assert.deepEqual(decideStopSwitchFollowUp({ produced: false, origin, switched: 'ok' }),
        { action: 'resend', prefill: false, markInterrupted: false, offerRerun: false });
    });
    test(`${origin}：切换成功 + 已有产出 → 续写，不覆盖这一轮`, () => {
      assert.deepEqual(decideStopSwitchFollowUp({ produced: true, origin, switched: 'ok' }),
        { action: 'continue', prefill: false, markInterrupted: false, offerRerun: false });
    });
  }
  test('切换失败：用户自己的 → 按普通中断（放回输入框、下一条覆盖）', () => {
    assert.deepEqual(decideStopSwitchFollowUp({ produced: true, origin: 'user', switched: 'failed' }),
      { action: 'none', prefill: true, markInterrupted: true, offerRerun: false });
  });
  for (const origin of nonUser) {
    test(`切换失败：${origin} 发来的 → 不续写，也不放回输入框，给「重跑」`, () => {
      assert.deepEqual(decideStopSwitchFollowUp({ produced: false, origin, switched: 'failed' }),
        { action: 'none', prefill: false, markInterrupted: false, offerRerun: true });
    });
  }
  test('循环的一轮：渲染层不自己重发 / 续写，交给 driver（它在账本里接着做，见 stopSwitchResume.test.ts）；不放回输入框', () => {
    for (const switched of ['ok', 'failed'] as const) {
      for (const produced of [true, false]) {
        assert.deepEqual(decideStopSwitchFollowUp({ produced, origin: 'loop', switched }),
          { action: 'driver', prefill: false, markInterrupted: false, offerRerun: false });
      }
    }
  });
});

describe('interruptPlanFor：普通 Stop / 断线 / 静默超时', () => {
  test('停用户自己的消息：仍然放回输入框、标下一条覆盖（行为不变）', () => {
    assert.deepEqual(interruptPlanFor('user'), { prefill: true, markInterrupted: true, offerRerun: false });
  });
  test('停 📨 会话发来的：不放回输入框，给「重跑」', () => {
    assert.deepEqual(interruptPlanFor('session'), { prefill: false, markInterrupted: false, offerRerun: true });
  });
  for (const origin of ['schedule', 'bg', 'watch', 'loop', 'nudge', 'auto-continue', 'control'] as TurnOrigin[]) {
    test(`${origin}：不放回输入框`, () => assert.equal(interruptPlanFor(origin).prefill, false));
  }
});

describe('rerunIdFor：重跑保留来源标记', () => {
  test('会话 / 控制入口：同一种标记、新 id', () => {
    assert.equal(rerunIdFor('user_xs_1_a', 1732500000000, 'zz'), 'user_xs_1732500000000_zz');
    assert.equal(rerunIdFor('queue_ctl_1_a', 1732500000000, 'zz'), 'user_ctl_1732500000000_zz');
  });
  test('定时（第几次）/ 后台任务 id / nudge：只换末尾的时间戳', () => {
    assert.equal(rerunIdFor('sched_job1_r3_1732400000000', 1732500000000), 'sched_job1_r3_1732500000000');
    assert.equal(rerunIdFor('wake_bg_lz3k1_1732400000000', 1732500000000), 'wake_bg_lz3k1_1732500000000');
    assert.equal(rerunIdFor('nudge_texttool_1732400000000', 1732500000000), 'nudge_texttool_1732500000000');
  });
  test('用户自己的 / 循环的：没有标记可保留', () => {
    assert.equal(rerunIdFor('user_1732400000000_a'), undefined);
    assert.equal(rerunIdFor('loop_1732400000000_4'), undefined);
  });
});

describe('接线', () => {
  test('「停止这一轮并立即切换」不再直接等于普通 Stop', () => {
    assert.doesNotMatch(chat, /onStopNow:\s*onCancel\b/);
    assert.match(chat, /onStopNow:\s*onStopAndSwitch \? \(\) => onStopAndSwitch\(pendingTarget\)/);
    assert.match(app, /onStopAndSwitch=\{/);
    assert.match(hook, /const stopAndSwitchNow = useCallback/);
  });
  test('停止并切换：取消时不放回输入框、不标覆盖，等切换结果再续写 / 重发', () => {
    const body = hook.slice(hook.indexOf('const stopAndSwitchNow = useCallback'));
    const fn = body.slice(0, body.indexOf('}, ['));
    assert.doesNotMatch(fn, /markTurnInterrupted\(sid\)\s*;/, '成功那条路不能走普通中断');
    assert.match(fn, /waitPendingSwitchResult\(/);
    assert.match(fn, /decideStopSwitchFollowUp\(/);
    assert.match(fn, /markRecovering\(sid, true\)/, '续写 / 重发先发，队列不抢跑');
    assert.match(fn, /SWITCH_CONTINUE_PROMPT/);
    assert.match(fn, /sameId: true/);
    assert.ok(fn.includes("await note(t('Switched to {target} and resent this message.'"), '提示先落盘，再重发');
  });
  test('同一个 id 原样重发不截记录：切换提示和「重发了这条消息」留在会话里', () => {
    const at = hook.indexOf('const rerunFromMessage = useCallback');
    const fn = hook.slice(at, hook.indexOf('rerunFromMessageRef.current = rerunFromMessage', at));
    assert.ok(fn.includes('if (!override?.sameId) await window.kiroApi.rewriteTranscript(sid, storedRetained);'), '不截记录');
    assert.ok(fn.includes('if (override?.sameId) mutateSessionMessages(sid, () => [...retained, ...current.slice(targetIndex + 1).filter((m) => isKirolexNote(m))]);'), '界面上留着这条之后的提示');
  });
  test('普通中断按来源决定放不放回输入框', () => {
    const body = hook.slice(hook.indexOf('const markTurnInterrupted = '));
    const fn = body.slice(0, body.indexOf('\n  };'));
    assert.match(fn, /interruptPlanFor\(/);
    assert.match(fn, /plan\.prefill/);
  });
});
