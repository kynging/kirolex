import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  reminderBand,
  shouldRemind,
  compactCommandFor,
  decideAutoCompact,
  normalizeAutoCompactPct,
  contextLogLine,
  nextDismissal,
  stepAutoCompact,
  AUTO_COMPACT_DEFAULT_PCT,
  AUTO_COMPACT_MIN_PCT,
  AUTO_COMPACT_MAX_PCT,
} from '../src/main/contextReminder.ts';

describe('上下文提醒档位：60% 起提醒，关掉后到下一个 10% 档再提醒', () => {
  test('59 不提示、60 提示', () => {
    assert.equal(shouldRemind(59, undefined), false);
    assert.equal(shouldRemind(59.9, undefined), false);
    assert.equal(shouldRemind(60, undefined), true);
  });

  test('60 关掉后 65 不再提示，70 再提示', () => {
    const dismissed = reminderBand(60);
    assert.equal(dismissed, 60);
    assert.equal(shouldRemind(65, dismissed), false);
    assert.equal(shouldRemind(69.9, dismissed), false);
    assert.equal(shouldRemind(70, dismissed), true);
  });

  test('70 档关掉后 80 再提示；压缩后回落到 60 档也不再提示（已经关过更高的档）', () => {
    assert.equal(shouldRemind(79, 70), false);
    assert.equal(shouldRemind(80, 70), true);
    assert.equal(shouldRemind(62, 70), false);
  });

  test('档位：<60 没有档；100 以上归到 100 档；坏值没有档', () => {
    assert.equal(reminderBand(0), null);
    assert.equal(reminderBand(87.4), 80);
    assert.equal(reminderBand(100), 100);
    assert.equal(reminderBand(130), 100);
    assert.equal(reminderBand(NaN), null);
    assert.equal(shouldRemind(NaN, undefined), false);
  });
});

describe('关掉过的档什么时候清掉', () => {
  test('压下去到 60 以下就清掉，之后再到 60 照常提醒', () => {
    assert.equal(nextDismissal(30, 70), undefined);
    assert.equal(shouldRemind(60, nextDismissal(30, 70)), true);
  });
  test('还在 60 以上 / 占位的 0 / 坏值：保留', () => {
    assert.equal(nextDismissal(65, 60), 60);
    assert.equal(nextDismissal(0, 60), 60);
    assert.equal(nextDismissal(NaN, 60), 60);
    assert.equal(nextDismissal(30, undefined), undefined);
  });
});

describe('各引擎的压缩方式', () => {
  test('kiro / Claude Code 发 /compact；没写引擎的会话是 kiro', () => {
    assert.equal(compactCommandFor('kiro'), '/compact');
    assert.equal(compactCommandFor(undefined), '/compact');
    assert.equal(compactCommandFor('claude'), '/compact');
  });

  test('Codex 没有能用的压缩命令 → null（界面只给「换后端会话并带摘要」）', () => {
    assert.equal(compactCommandFor('codex'), null);
  });
});

describe('自动压缩只在一轮结束、会话空闲且超过阈值时做', () => {
  const base = { enabled: true, thresholdPct: 75, pct: 80, turnEnded: true, idle: true, engine: 'kiro' as const, armed: true };

  test('满足全部条件 → 压缩，命令按引擎', () => {
    assert.deepEqual(decideAutoCompact(base), { compact: true, command: '/compact' });
    assert.deepEqual(decideAutoCompact({ ...base, engine: 'claude' }), { compact: true, command: '/compact' });
  });

  test('默认关：没开就不压', () => {
    assert.equal(decideAutoCompact({ ...base, enabled: false }).compact, false);
  });

  test('没到阈值不压；正好到阈值压', () => {
    assert.equal(decideAutoCompact({ ...base, pct: 74.9 }).compact, false);
    assert.equal(decideAutoCompact({ ...base, pct: 75 }).compact, true);
  });

  test('不空闲（还在跑 / 有排队 / 换执行器中）不压', () => {
    assert.equal(decideAutoCompact({ ...base, idle: false }).compact, false);
  });

  test('不是一轮刚结束不压（例如刚打开 KiroLex，会话本来就停在高位）', () => {
    assert.equal(decideAutoCompact({ ...base, turnEnded: false }).compact, false);
  });

  test('上一次自动压缩之后还没回落到阈值以下（armed=false）不再压，避免压完还高就一直压', () => {
    assert.equal(decideAutoCompact({ ...base, armed: false }).compact, false);
  });

  test('Codex 没有压缩命令：不自动压', () => {
    const d = decideAutoCompact({ ...base, engine: 'codex' });
    assert.equal(d.compact, false);
  });

  test('阈值越界按 50–90 规整', () => {
    assert.equal(decideAutoCompact({ ...base, thresholdPct: 99, pct: 92 }).compact, true);
    assert.equal(decideAutoCompact({ ...base, thresholdPct: 99, pct: 89 }).compact, false);
  });
});

describe('自动压缩阈值', () => {
  test('默认 75，范围 50–90', () => {
    assert.equal(AUTO_COMPACT_DEFAULT_PCT, 75);
    assert.equal(AUTO_COMPACT_MIN_PCT, 50);
    assert.equal(AUTO_COMPACT_MAX_PCT, 90);
    assert.equal(normalizeAutoCompactPct(undefined), 75);
    assert.equal(normalizeAutoCompactPct('abc'), 75);
    assert.equal(normalizeAutoCompactPct(10), 50);
    assert.equal(normalizeAutoCompactPct(95), 90);
    assert.equal(normalizeAutoCompactPct(66.6), 67);
  });
});

describe('日志行', () => {
  test('[context] remind|compact sessionId=… pct=…', () => {
    assert.equal(contextLogLine({ kind: 'remind', sessionId: 's1', pct: 61.27 }), 'remind sessionId=s1 pct=61');
    assert.equal(contextLogLine({ kind: 'compact', sessionId: 's1', pct: 80, via: 'auto' }), 'compact sessionId=s1 pct=80 via=auto');
    assert.equal(contextLogLine({ kind: 'bogus' as any, sessionId: 's 1\n', pct: NaN }), 'remind sessionId=s_1_ pct=?');
  });
});

describe('自动压缩的逐步跟踪（stepAutoCompact）', () => {
  const facts = { running: false, idle: true, pct: 80, enabled: true, thresholdPct: 75, engine: 'kiro' as const };

  test('刚打开、会话停在 80%、没跑过一轮：不压', () => {
    const r = stepAutoCompact(undefined, facts);
    assert.equal(r.command, undefined);
  });

  test('一轮跑完、空闲、超过阈值：压一次；压缩那一轮结束后读数还高：不再压', () => {
    let r = stepAutoCompact(undefined, { ...facts, running: true });
    r = stepAutoCompact(r.track, facts);
    assert.equal(r.command, '/compact');
    // 压缩那一轮开始、结束，读数没降
    r = stepAutoCompact(r.track, { ...facts, running: true });
    r = stepAutoCompact(r.track, facts);
    assert.equal(r.command, undefined);
    // 读数降到阈值以下 → 重新上膛；再涨上来、再跑完一轮 → 再压
    r = stepAutoCompact(r.track, { ...facts, pct: 20 });
    r = stepAutoCompact(r.track, { ...facts, running: true });
    r = stepAutoCompact(r.track, facts);
    assert.equal(r.command, '/compact');
  });

  test('轮末还有排队（不空闲）：先不压；读数在轮末稍后才到：等它到了再压', () => {
    let r = stepAutoCompact(undefined, { ...facts, running: true });
    r = stepAutoCompact(r.track, { ...facts, idle: false });
    assert.equal(r.command, undefined);
    r = stepAutoCompact(r.track, { ...facts, pct: 50 });
    assert.equal(r.command, undefined);
    r = stepAutoCompact(r.track, { ...facts, pct: 81 });
    assert.equal(r.command, '/compact');
  });

  test('没开 / Codex：一轮跑完也不压', () => {
    let r = stepAutoCompact(undefined, { ...facts, running: true });
    assert.equal(stepAutoCompact(r.track, { ...facts, enabled: false }).command, undefined);
    r = stepAutoCompact(undefined, { ...facts, running: true, engine: 'codex' });
    assert.equal(stepAutoCompact(r.track, { ...facts, engine: 'codex' }).command, undefined);
  });
});

describe('停止 / 打断的那一轮不触发自动压缩（审查回归：不能把停下的那一轮从记录里截掉）', () => {
  const facts = { running: false, idle: true, pct: 85, enabled: true, thresholdPct: 75, engine: 'kiro' as const };

  test('高占用时用户点停止：轮末作废，不发 /compact', () => {
    let r = stepAutoCompact(undefined, { ...facts, running: true });
    r = stepAutoCompact(r.track, { ...facts, interrupted: true });
    assert.equal(r.command, undefined);
    assert.equal(r.track.turnEnded, false);
  });

  test('中断标记后来被清掉（没开始新的一轮）：也不补发 —— 那次轮末已经作废', () => {
    let r = stepAutoCompact(undefined, { ...facts, running: true });
    r = stepAutoCompact(r.track, { ...facts, interrupted: true });
    r = stepAutoCompact(r.track, { ...facts, interrupted: false });
    assert.equal(r.command, undefined);
  });

  test('用户重发、那一轮正常跑完：照常压', () => {
    let r = stepAutoCompact(undefined, { ...facts, running: true });
    r = stepAutoCompact(r.track, { ...facts, interrupted: true });
    r = stepAutoCompact(r.track, { ...facts, running: true });
    r = stepAutoCompact(r.track, facts);
    assert.equal(r.command, '/compact');
  });
});
