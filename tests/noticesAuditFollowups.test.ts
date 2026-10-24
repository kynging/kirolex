import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * docs/notices-audit.md 里「行为本身有问题」「这一波没动的」那几条的修复（2026-10-24）：
 *   ① 定时任务结束那句是 KiroLex 提示，不是助手的话（旧记录按开头认）；
 *   ② 重建历史时因模型不可用换了模型，要在会话里说一句（`modelFallback`，每会话每对一次）；
 *   ③ 改写排队等 20 分钟放弃时在会话里说，带原文；
 *   ④ loop 每轮校验结果折叠成一条，emoji 只用用词表里那几个。
 */
const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (...parts: string[]) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const MAIN = strip(read('main', 'index.ts'));
const HOOK = strip(read('renderer', 'hooks', 'useAcp.ts'));

/** notices-glossary 允许的四个 emoji 之外的那些（会话内提示不再用） */
const BANNED = /[❌⛔⏰🔁♻]/u;

describe('① 定时任务结束那句：KiroLex 提示，不是助手的话', () => {
  test('旧记录里以 assistant 写下的那句按开头认成 KiroLex 提示，不发给模型', async () => {
    const { isKirolexNote, modelFacing, normalizeLegacyNote } = await import('../src/main/kirolexNote.ts');
    const legacy = [
      '⏰ 定时任务结束：运行次数用完\n每天 09:00 · 共运行 3 次',
      '定时任务结束：运行次数用完（每天 09:00，共运行 3 次）',
      '⏰ Scheduled task ended: run limit reached\ndaily at 09:00 · ran 3 time(s) in total',
      'Scheduled task ended: run limit reached (daily at 09:00, ran 3 time(s))',
    ];
    for (const content of legacy) {
      const m = { id: 'sched_end_1', role: 'assistant', content, ts: 1 };
      assert.equal(isKirolexNote(m), true, content);
      assert.equal(modelFacing(m), false, `${content} 还会进快照 / history.md / 逐段重建`);
      const n = normalizeLegacyNote(m);
      assert.equal(n.role, 'user');
      assert.equal((n as any).kirolex, true);
      assert.equal(n.content, content, '内容原样');
    }
  });

  test('你自己打的「定时任务结束：」、助手正常的回复都不受影响', async () => {
    const { isKirolexNote, modelFacing, normalizeLegacyNote } = await import('../src/main/kirolexNote.ts');
    const mine = { role: 'user', content: '定时任务结束：帮我总结一下这周' };
    assert.equal(isKirolexNote(mine), false);
    assert.equal(modelFacing(mine), true);
    assert.equal(normalizeLegacyNote(mine), mine);
    const reply = { role: 'assistant', content: '好的，定时任务结束：之后我会…' };
    assert.equal(isKirolexNote(reply), false);
    assert.equal(normalizeLegacyNote(reply), reply);
  });

  test('拼好的对话文本里（追问建议那条路）同样删掉 Assistant 段的那句，你说的那段留着', async () => {
    const { stripKirolexNotes } = await import('../src/main/kirolexNote.ts');
    const out = stripKirolexNotes('User: 每天提醒我\n\nAssistant: ⏰ 定时任务结束：运行次数用完\n\nUser: 定时任务结束：再来一个');
    assert.equal(out, 'User: 每天提醒我\n\nUser: 定时任务结束：再来一个');
  });

  test('接线：runScheduledJob 走 noteInSession（中英两版），读盘的三处都先过 normalizeLegacyNote', () => {
    const at = MAIN.indexOf('async function runScheduledJob');
    const body = MAIN.slice(at, MAIN.indexOf('function runScheduleCheck', at));
    assert.match(body, /noteInSession\(state\.sessionId, scheduleEndedText\(final, terminal\), \{\s*zh: scheduleEndedText\(final, terminal, 'zh'\), en: scheduleEndedText\(final, terminal, 'en'\)/);
    assert.doesNotMatch(body, /store\.appendMessage|role: 'assistant'/);
    assert.match(HOOK, /function messageFromStored\(raw: any\): Message \{\s*const m = normalizeLegacyNote\(raw\);/);
    assert.equal((HOOK.match(/transcript\.map\(normalizeLegacyNote\)\.map\(/g) || []).length, 2, '启动恢复那两处（焦点会话、分屏）');
  });
});

describe('② 重建历史时换了模型：在会话里说一句', () => {
  test('primeHistoryNow 换模型成功后经 modelFallback 记下并写进对话记录', () => {
    const at = MAIN.indexOf('const swapped = await swapSessionModel(sessionId, failedModel, `prime ${sessionId}`, tried);');
    assert.ok(at > 0, 'prime 那处换模型挪了 — 更新这条');
    const branch = MAIN.slice(at, MAIN.indexOf('return { ok: false, error:', at));
    assert.match(branch, /modelFallback\.note\(sessionId, failedModel, swapped,/);
    assert.match(branch, /Model "\{from\}" is unavailable, so this session switched to "\{to\}"; rebuilding history starts over\./);
    assert.match(branch, /NOTE_DETAIL_SEP/, '报错原文折进「详情」');
    assert.match(branch, /modelFallback\.commit\(sessionId\)/);
  });

  test('同一对每会话只说一次（重建每次重来都会走到这里）', async () => {
    const { ModelFallbackNotes, fallbackGroup } = await import('../src/main/modelFallbackNote.ts');
    const written: Array<{ sid: string; group: string }> = [];
    const notes = new ModelFallbackNotes({
      note: (sid, _text, group) => { written.push({ sid, group }); return true; },
      recordExists: () => true,
      status: () => {},
      remoteText: () => '',
    });
    for (let i = 0; i < 3; i++) { notes.note('s1', 'claude-opus-5.5', 'gpt-5.6-sol', '🔀 …'); notes.commit('s1'); }
    assert.deepEqual(written, [{ sid: 's1', group: fallbackGroup('claude-opus-5.5', 'gpt-5.6-sol') }]);
  });

  test('中文文案在', async () => {
    const { setUiLang, tr } = await import('../src/main/uiText.ts');
    setUiLang('zh');
    try {
      assert.equal(tr('🔀 Model "{from}" is unavailable, so this session switched to "{to}"; rebuilding history starts over.', { from: 'a', to: 'b' }),
        '🔀 模型「a」不可用，这条会话已换成「b」，重建历史从头开始。');
    } finally { setUiLang('en'); }
  });
});

describe('③ 改写排队等 20 分钟放弃：会话里明说，原文带上', () => {
  test('那句话：说等了 20 分钟、已放弃、原文；一直在忙的原因折进详情', async () => {
    const { setUiLang } = await import('../src/main/uiText.ts');
    const { reviseGaveUpNote, reviseGaveUpGroup } = await import('../src/main/reviseGiveUp.ts');
    const { splitNoteDetail } = await import('../src/main/kirolexNote.ts');
    setUiLang('zh');
    try {
      const { main, detail } = splitNoteDetail(reviseGaveUpNote('周报.md 第 3 段', '  把这段改短一点  ', '正在回答'));
      assert.match(main, /^⚠️ 等了 20 分钟还没轮到，已放弃这次改写：周报\.md 第 3 段。/);
      assert.match(main, /再点 ✓ 即可重发/);
      assert.match(main, /\n原文：把这段改短一点$/, '原文要在主句里看得见，不折叠');
      assert.equal(detail, '会话一直在忙：正在回答');
    } finally { setUiLang('en'); }
    const en = reviseGaveUpNote('x', 'shorter please', 'busy');
    assert.match(en, /Waited 20 minutes/);
    assert.match(en, /Your comment: shorter please/);
    assert.equal(reviseGaveUpGroup('x'), 'revise-gave-up:x');
  });

  test('接线：三处等空闲超时都在会话里说（改写、格式不对的追问、deck 一页文字），并且照旧 retrySame', () => {
    const sites = MAIN.split('\n').filter((l) => /if \(stillBusy\)/.test(l) && /20 minutes/.test(l));
    assert.equal(sites.length, 3, sites.join('\n'));
    for (const l of sites) {
      assert.match(l, /noteReviseGaveUp\((sessionId|sid), .+, note, stillBusy\)/, l);
      assert.match(l, /retrySame: true/, `${l}\n意见要能按同一次重发`);
    }
    const fn = MAIN.slice(MAIN.indexOf('function noteReviseGaveUp'), MAIN.indexOf('async function waitIdle'));
    assert.match(fn, /noteInSession\(sessionId, text, undefined, group\)/);
    assert.match(fn, /sessionNotice\(sessionId, text, \{ group \}\)/, '写不进记录时退到状态行');
  });
});

describe('④ loop 校验结果：一个 loop 一条，展开看每轮；emoji 收敛', async () => {
  const lm = await import('../src/renderer/loopMachine.ts');
  const { splitNoteDetail } = await import('../src/main/kirolexNote.ts');
  const spec = {
    prompt: 'p', goal: 'g', everySec: 0,
    verifier: { level: 1 as const, kind: 'command' as const, command: 'npm test', timeoutSec: 60 },
    stop: { maxIterations: 5, maxNoProgressRounds: 3, successStreak: 1, maxUnrunnableRounds: 2 },
  };
  const run = (over: Record<string, unknown>) => ({ ...lm.createRun('s1', spec, 1000), ...over }) as any;

  test('每轮一行：通过 ✅、未通过 / 校验跑不起来到上限 ⚠️、容错重试 ⏳ —— 没有 ❌ ⛔', () => {
    const pass = lm.verdictRoundLine(run({ iteration: 1 }), { pass: true, exitCode: 0, output: '', at: 0 });
    const fail = lm.verdictRoundLine(run({ iteration: 2 }), { pass: false, exitCode: 1, output: 'x', at: 0 });
    const flake = lm.verdictRoundLine(run({ iteration: 3, unrunnableRounds: 1 }), { pass: false, unrunnable: true, exitCode: null, output: '', at: 0 });
    const broken = lm.verdictRoundLine(run({ iteration: 3, unrunnableRounds: 2 }), { pass: false, unrunnable: true, exitCode: null, output: '', at: 0 });
    assert.equal(pass, '✅ 第 1 轮校验通过（exit=0）');
    assert.equal(fail, '⚠️ 第 2 轮校验未通过（exit=1）· 输出已回灌到下一轮');
    assert.equal(flake, '⏳ 第 3 轮校验无法执行（连续第 1/2 次，暂不终止，稍后重试）');
    assert.equal(broken, '⚠️ 第 3 轮校验无法执行（连续第 2/2 次，已达容错上限）');
    for (const l of [pass, fail, flake, broken]) assert.doesNotMatch(l, BANNED, l);
  });

  test('三轮折成一条：主句是最新那轮 + 共几轮；详情里按顺序列出每一轮和它的输出', () => {
    const rounds = [
      lm.verdictRound(run({ iteration: 1 }), { pass: false, exitCode: 1, output: '3 failing: a,b,c\n', at: 0 }),
      lm.verdictRound(run({ iteration: 2 }), { pass: false, exitCode: 1, output: '1 failing: c', at: 0 }),
      lm.verdictRound(run({ iteration: 3 }), { pass: true, exitCode: 0, output: '', at: 0 }),
    ];
    const { main, detail } = splitNoteDetail(lm.foldVerdicts(rounds));
    assert.equal(main, '✅ 第 3 轮校验通过（exit=0） · 共校验 3 轮');
    assert.equal(detail, [
      '⚠️ 第 1 轮校验未通过（exit=1）· 输出已回灌到下一轮\n3 failing: a,b,c',
      '⚠️ 第 2 轮校验未通过（exit=1）· 输出已回灌到下一轮\n1 failing: c',
      '✅ 第 3 轮校验通过（exit=0）',
    ].join('\n\n'));
  });

  test('只有一轮、没有输出：就一句，没有详情；没有轮次就什么都不显示', () => {
    const one = lm.foldVerdicts([lm.verdictRound(run({ iteration: 1 }), { pass: true, exitCode: 0, output: '  ', at: 0 })]);
    assert.equal(one, '✅ 第 1 轮校验通过（exit=0）');
    assert.equal(lm.foldVerdicts([]), '');
  });

  test('每轮输出在屏幕上截到上限', () => {
    const r = lm.verdictRound(run({ iteration: 1 }), { pass: false, exitCode: 1, output: 'x'.repeat(5000), at: 0 });
    assert.equal(r.output.length, lm.VERDICT_SCREEN_OUTPUT);
  });

  test('循环结束那句：达成 / 无需改动 ✅，其余 ⚠️；不再用 🔁', () => {
    const r = run({ iteration: 2 });
    assert.match(lm.terminalSummary(r, 'success', 1000), /^✅ 循环结束：目标达成\n/);
    assert.match(lm.terminalSummary(r, 'no-op', 1000), /^✅ 循环结束：/);
    for (const term of ['blocked', 'stalled', 'exhausted', 'aborted', 'superseded', 'torn-down'] as const) {
      const s = lm.terminalSummary(r, term, 1000);
      assert.match(s, /^⚠️ 循环结束：/, term);
      assert.doesNotMatch(s, BANNED, term);
    }
    assert.match(lm.terminalSummary(r, 'aborted', 1000, 'en'), /^⚠️ Loop finished: Stopped by the user\n/);
  });

  test('同一个 run 的卡片 id 不变，不同 run 不同', () => {
    assert.equal(lm.loopVerdictsId({ sessionId: 's1', startedAt: 5 }), lm.loopVerdictsId({ sessionId: 's1', startedAt: 5 }));
    assert.notEqual(lm.loopVerdictsId({ sessionId: 's1', startedAt: 5 }), lm.loopVerdictsId({ sessionId: 's1', startedAt: 6 }));
  });

  test('接线：showVerdict 按 run 的 id 原地替换同一张 KiroLex 卡片，不再每轮追加一条助手消息', () => {
    const at = HOOK.indexOf('const showVerdict = useCallback(');
    const body = HOOK.slice(at, HOOK.indexOf('}, [mutateSessionMessages]);', at));
    assert.match(body, /const id = loopVerdictsId\(run\);/);
    assert.match(body, /foldVerdicts\(rounds, uiLangNow\(\)\)/);
    assert.match(body, /current\.findIndex\(\(m\) => m\.id === id\)/);
    assert.match(body, /role: 'user', kirolex: true/);
    assert.doesNotMatch(body, /role: 'assistant'|loop_verdict_\$\{Date\.now\(\)/);
    assert.doesNotMatch(body, BANNED);
  });
});
