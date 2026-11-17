/**
 * **模型安全过滤的会话级拦截**（safeguards flagged / [cyber]）的纯判据 —— 见 `src/main/safeguardError.ts`。
 *
 * 实测那条会话：先连着 3 轮 Compact 失败、再 2 轮直接被拦，每一次都是同一段多行原文平铺在气泡里，
 * 而 staleSession / transientError 两套判据都不认它，于是既没有自愈也没有出路。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSafeguardBlock, isSafeguardReport, cyberVerificationUrl, CYBER_VERIFICATION_URL,
  safeguardNoteGroup, isSafeguardNoteGroup, isCompactNoteGroup, COMPACT_FAILED_NOTE_GROUP,
  isCompactCommand, mentionsCompactionFailure, isCompactionSignal, turnFailureCard, safeguardModelChoices, hasReplyBeyondCompaction,
} from '../src/main/safeguardError.ts';
import { isBareInternalError, staleVerdict } from '../src/main/staleSession.ts';
import { isTransientTransportError } from '../src/main/transientError.ts';
import { setUiLang, tr } from '../src/main/uiText.ts';

const SESSION_FLAGGED = [
  'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Our safeguards flagged this session',
  'for potential policy violations (https://www.anthropic.com/legal/aup). Details: [cyber]"}}',
  'Request ID: req_011CXyZ123abc',
  'Message ID: msg_bdrk_01ABCdef',
].join('\n');

const MESSAGE_FLAGGED = [
  'Cyber safeguards flagged this message. If you are doing legitimate security work,',
  'apply for the Cyber Verification Program: https://support.claude.com/en/articles/14604842-cyber-verification-program',
  'Request ID: req_011CAbc',
  'Message ID: msg_01Xyz',
].join('\n');

/** 不带 "safeguards flagged" 字样、只剩 AUP 链接 + [cyber] 标记的变体（不带 Request ID） */
const AUP_CYBER = 'API Error: This request was blocked under our usage policy (https://www.anthropic.com/legal/aup). Details: [cyber]';

describe('isSafeguardBlock：命中三种典型文本', () => {
  test('会话级 "safeguards flagged this session ... [cyber]"（带 Request ID / Message ID）', () => {
    assert.equal(isSafeguardBlock(SESSION_FLAGGED), true);
  });
  test('同一句去掉 Request ID / Message ID 两行', () => {
    assert.equal(isSafeguardBlock(SESSION_FLAGGED.split('\n').slice(0, 2).join('\n')), true);
  });
  test('"Cyber safeguards flagged this message" + Cyber Verification Program 链接', () => {
    assert.equal(isSafeguardBlock(MESSAGE_FLAGGED), true);
    assert.equal(isSafeguardBlock(MESSAGE_FLAGGED.split('\n').slice(0, 2).join('\n')), true);
  });
  test('只有 AUP 链接 + [cyber]（带 / 不带 Request ID）', () => {
    assert.equal(isSafeguardBlock(AUP_CYBER), true);
    assert.equal(isSafeguardBlock(`${AUP_CYBER}\nRequest ID: req_1\nMessage ID: msg_2`), true);
  });
  test('大小写不敏感', () => {
    assert.equal(isSafeguardBlock('SAFEGUARDS FLAGGED THIS SESSION'), true);
    assert.equal(isSafeguardBlock('see HTTPS://WWW.ANTHROPIC.COM/LEGAL/AUP details: [CYBER]'), true);
  });
  test('适配器包成 Internal error、原文在 data 里（index.ts 拼成 message + detail）', () => {
    assert.equal(isSafeguardBlock(`Internal error — ${SESSION_FLAGGED}`), true);
  });
});

describe('isSafeguardBlock：不误伤', () => {
  const negatives: Array<[string, string]> = [
    ['笼统 Internal error', 'Internal error'],
    ['kiro 的 Internal error 全句', 'Internal error — Kiro failed to generate a response'],
    ['dispatch failure', "Error invoking remote method 'acp:prompt': Error: Internal error — Encountered an error in the response stream: An unknown error occurred: dispatch failure"],
    ['EmptyResponse', 'err=EmptyResponse'],
    ['ECONNRESET', 'read ECONNRESET'],
    ['正常回复正文', '好的，我来帮你检查这段代码的安全问题：先看输入校验，再看权限。'],
    ['正常英文回复', 'Sure — here is a summary of the security review. Nothing was flagged.'],
    ['只有 "flagged"', 'The linter flagged 3 warnings.'],
    ['只有 AUP 链接、没有 [cyber]', 'Please read https://www.anthropic.com/legal/aup before using the API.'],
    ['只有 [cyber]、没有 AUP 链接', 'Tags: [cyber] [web]'],
    ['只有 safeguards', 'We added safeguards to the deploy script.'],
    ['空', ''],
  ];
  for (const [name, text] of negatives) {
    test(name, () => assert.equal(isSafeguardBlock(text), false));
  }
  test('null / undefined', () => {
    assert.equal(isSafeguardBlock(null), false);
    assert.equal(isSafeguardBlock(undefined), false);
  });
});

describe('和现有判据并列、互不干扰', () => {
  test('三种典型文本都不是传输层抖动（不会被当成可重发）', () => {
    for (const s of [SESSION_FLAGGED, MESSAGE_FLAGGED, AUP_CYBER]) assert.equal(isTransientTransportError(s), false);
  });
  test('现有 staleVerdict 行为不变：裸原文照旧 report', () => {
    assert.equal(isBareInternalError(SESSION_FLAGGED), false);
    assert.equal(staleVerdict({ error: SESSION_FLAGGED, contextPid: 1, clientPid: 2, alreadyRetried: false }), 'report');
  });
});

describe('Cyber Verification Program 链接', () => {
  test('原文里给了 support.claude.com 链接就用它（去掉句末标点）', () => {
    assert.equal(cyberVerificationUrl(MESSAGE_FLAGGED), CYBER_VERIFICATION_URL);
    assert.equal(cyberVerificationUrl('apply: https://support.claude.com/en/articles/999-x.'), 'https://support.claude.com/en/articles/999-x');
  });
  test('没给就用默认链接；别的域名不收', () => {
    assert.equal(cyberVerificationUrl(SESSION_FLAGGED), CYBER_VERIFICATION_URL);
    assert.equal(cyberVerificationUrl('apply at https://evil.example.com/support.claude.com/x'), CYBER_VERIFICATION_URL);
    assert.equal(cyberVerificationUrl(''), CYBER_VERIFICATION_URL);
  });
});

describe('提示卡的 noteGroup', () => {
  test('安全过滤：普通 / 压缩两种，都认得出', () => {
    assert.equal(isSafeguardNoteGroup(safeguardNoteGroup(false)), true);
    assert.equal(isSafeguardNoteGroup(safeguardNoteGroup(true)), true);
    assert.notEqual(safeguardNoteGroup(false), safeguardNoteGroup(true));
    assert.equal(isCompactNoteGroup(safeguardNoteGroup(true)), true);
    assert.equal(isCompactNoteGroup(safeguardNoteGroup(false)), false);
  });
  test('压缩失败那张不是安全过滤卡', () => {
    assert.equal(isSafeguardNoteGroup(COMPACT_FAILED_NOTE_GROUP), false);
    assert.equal(isCompactNoteGroup(COMPACT_FAILED_NOTE_GROUP), true);
    assert.equal(isSafeguardNoteGroup(undefined), false);
    assert.equal(isSafeguardNoteGroup('backend-session-swap'), false);
  });
});

describe('压缩（compact）', () => {
  test('/compact 命令', () => {
    assert.equal(isCompactCommand('/compact'), true);
    assert.equal(isCompactCommand('  /compact keep the API notes'), true);
    assert.equal(isCompactCommand('/compactor'), false);
    assert.equal(isCompactCommand('please /compact'), false);
  });
  test('报错里说压缩失败了', () => {
    assert.equal(mentionsCompactionFailure('Error during compaction: API Error: 400'), true);
    assert.equal(mentionsCompactionFailure('Conversation compaction failed'), true);
    assert.equal(mentionsCompactionFailure('Failed to compact conversation'), true);
    assert.equal(mentionsCompactionFailure('Internal error'), false);
    assert.equal(mentionsCompactionFailure('make the layout more compact'), false);
  });
  test('流里的「正在压缩」信号', () => {
    assert.equal(isCompactionSignal('Compacting conversation…'), true);
    assert.equal(isCompactionSignal('正在压缩上下文'), true);
    assert.equal(isCompactionSignal('Here is a compact summary'), false);
  });
});

describe('turnFailureCard：报错收尾给哪张卡', () => {
  test('安全过滤拦截 → safeguard（不管是不是压缩、有没有产出）', () => {
    assert.equal(turnFailureCard({ error: SESSION_FLAGGED, compactTurn: false, produced: false }), 'safeguard');
    assert.equal(turnFailureCard({ error: SESSION_FLAGGED, compactTurn: true, produced: false }), 'safeguard');
    assert.equal(turnFailureCard({ error: MESSAGE_FLAGGED, compactTurn: false, produced: true }), 'safeguard');
  });
  test('压缩失败、这一轮什么都没产出 → compact-failed', () => {
    assert.equal(turnFailureCard({ error: 'Error during compaction: overloaded', compactTurn: true, produced: false }), 'compact-failed');
  });
  test('压缩那一轮已经产出了东西 / 不是压缩 → 照旧', () => {
    assert.equal(turnFailureCard({ error: 'Error during compaction: overloaded', compactTurn: true, produced: true }), null);
    assert.equal(turnFailureCard({ error: 'Internal error', compactTurn: false, produced: false }), null);
    assert.equal(turnFailureCard({ error: 'dispatch failure', compactTurn: false, produced: false }), null);
  });
});

describe('只有「正在压缩」状态提示不算产出', () => {
  test('hasReplyBeyondCompaction：状态提示 / 空白不算；真正的回复算；截断了算', () => {
    assert.equal(hasReplyBeyondCompaction('Compacting conversation…'), false);
    assert.equal(hasReplyBeyondCompaction('Compacting conversation…\n\n正在压缩上下文\n  '), false);
    assert.equal(hasReplyBeyondCompaction(''), false);
    assert.equal(hasReplyBeyondCompaction('Compacting conversation…\nHere is the answer.'), true);
    assert.equal(hasReplyBeyondCompaction('好的，先看第一处。'), true);
    assert.equal(hasReplyBeyondCompaction('Compacting conversation…', true), true);
  });
  test('只有压缩状态提示 → 压缩报错（不是安全过滤）→ compact-failed 恢复卡片', () => {
    const streamed = 'Compacting conversation…';
    assert.equal(isCompactionSignal(streamed), true);   // index.ts 据此记 compactSignalThisTurn
    assert.equal(turnFailureCard({
      error: 'Error during compaction: API Error: 529 Overloaded',
      compactTurn: true,
      produced: hasReplyBeyondCompaction(streamed),
    }), 'compact-failed');
  });
  test('压缩状态提示之后有真正的回复 → 照旧，不放卡片', () => {
    assert.equal(turnFailureCard({
      error: 'Error during compaction: overloaded',
      compactTurn: true,
      produced: hasReplyBeyondCompaction('Compacting conversation…\nPartial answer'),
    }), null);
  });
});

describe('isSafeguardReport：主进程换成的那句短话（中英）也认得', () => {
  for (const lang of ['zh', 'en'] as const) {
    test(lang, () => {
      setUiLang(lang);
      try {
        assert.equal(isSafeguardReport(tr("The model's safety filter flagged this whole chat, so this turn was blocked. See the KiroLex card in this chat for what to do.")), true);
        assert.equal(isSafeguardReport(tr("The model's safety filter blocked context compaction in this chat. See the KiroLex card in this chat for what to do.")), true);
      } finally { setUiLang('zh'); }
    });
  }
  test('原文也算；普通错误不算', () => {
    assert.equal(isSafeguardReport(SESSION_FLAGGED), true);
    assert.equal(isSafeguardReport('Internal error'), false);
    assert.equal(isSafeguardReport('⚠️ This turn produced no output. Resend, or press Rerun.'), false);
  });
});

describe('换模型：卡片上能选的别的模型', () => {
  const opts = [{ value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }, { value: 'haiku', name: 'Haiku', disabled: true }];
  test('去掉当前的、去掉不可用的，顺序不变', () => {
    assert.deepEqual(safeguardModelChoices('opus', opts).map((o) => o.value), ['sonnet']);
    assert.deepEqual(safeguardModelChoices('', opts).map((o) => o.value), ['opus', 'sonnet']);
  });
  test('没有别的可选 → 空', () => {
    assert.deepEqual(safeguardModelChoices('opus', [{ value: 'opus', name: 'Opus' }]), []);
    assert.deepEqual(safeguardModelChoices('x', []), []);
  });
});

describe('接线：命中时不进自动重发 / 换后端会话，而是落卡片', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.join(import.meta.dirname, '..');
  const index = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const chat = fs.readFileSync(path.join(root, 'src/renderer/components/ChatArea.tsx'), 'utf8');
  const acp = fs.readFileSync(path.join(root, 'src/renderer/hooks/useAcp.ts'), 'utf8');
  test('主进程：安全过滤分支在 staleVerdict / planRetry / 连续失败计数之前就抛出', () => {
    const at = index.indexOf("if (failCard === 'safeguard') throw new Error(noteSafeguardBlock(sessionId, failText, compactTurn));");
    assert.ok(at > 0);
    for (const later of ['const verdict = staleVerdict({', 'const plan = planRetry({', 'const streak = (cliFailStreak.get(failKey) || 0) + 1;']) {
      const i = index.indexOf(later);
      assert.ok(i > at, `${later} 应该在安全过滤分支之后`);
    }
  });
  test('主进程：卡片的「有没有产出」去掉压缩状态提示再判（不看 textThisTurn），每轮开头清零', () => {
    const at = index.indexOf('const failCard = turnFailureCard({');
    const call = index.slice(at, at + 400);
    assert.match(call, /produced: hasReplyBeyondCompaction\(entry\.turnTextHead, !!entry\.turnTextTruncated\) \|\| \(entry\.toolsThisTurn \|\| 0\) > 0,/);
    assert.ok(!/produced: [^\n]*textThisTurn/.test(call));
    assert.match(index, /entry\.compactSignalThisTurn = false;\s*entry\.turnTextHead = '';\s*entry\.turnTextTruncated = false;/);
    /* 重发的安全闸照旧看 textThisTurn */
    assert.match(index, /producedText: !!\(entry\.textThisTurn \|\| entry\.assistantBuf\),/);
  });
  test('只有压缩状态文字 + Internal error + 连着失败 → 重建了后端但不重发：判据组合确实走「不重发」那个出口', async () => {
    const { planRetry } = await import('../src/main/promptRetry.ts');
    const streamed = 'Compacting conversation…';
    const error = 'Internal error';
    /* 卡片：只有状态提示不算产出 → compact-failed */
    assert.equal(turnFailureCard({ error, compactTurn: isCompactionSignal(streamed), produced: hasReplyBeyondCompaction(streamed) }), 'compact-failed');
    /* 原有判据不变：连着坏两次 → 重建后端 */
    assert.equal(staleVerdict({ error, contextPid: 1, clientPid: 1, alreadyRetried: false, consecutiveFailures: 2 }), 'recreate');
    /* 原有重发闸不变：textThisTurn=true（状态提示也算出过字）→ 不重发，理由 produced */
    const plan = planRetry({ error, attempt: 0, producedText: true, toolsRan: 0, remote: false });
    assert.equal(plan.retry, false);
    assert.equal(plan.reason, 'produced');
  });
  test('主进程：压缩失败卡片落在每一个不再重发的出口上（交棒、换了后端但不重发、最后照实报错）', () => {
    const start = index.indexOf('const noteCompactFailedOnExit = () =>');
    assert.ok(start > 0);
    const end = index.indexOf('/* 报出去之前把 kiro-cli 那句真话带上', start);
    const region = index.slice(start, end);
    /* 交棒那个 throw 之前 */
    assert.match(region, /if \(ownsHandOver\) noteCompactFailedOnExit\(\);\n\s*if \(ownsHandOver\) throw err;/);
    /* 换了后端会话但不重发：块里第一句就落卡片，然后才 throw */
    assert.match(region, /if \(made && !plan\.retry && \(plan\.reason === 'side-effects' \|\| plan\.reason === 'produced'\)\) \{\n\s*noteCompactFailedOnExit\(\);/);
    /* 自动重发（plan.retry）之后、预算用光 / 照实报错之前 */
    const retryAt = region.indexOf('if (plan.retry) {');
    const lastNote = region.lastIndexOf('noteCompactFailedOnExit();');
    assert.ok(retryAt > 0 && lastNote > retryAt && lastNote < region.indexOf("if (plan.reason === 'budget') {"));
    /* 重发的那两条（return await sendPromptOnce）前面不落卡片：重发那次自己会判 */
    for (const m of region.matchAll(/return await sendPromptOnce\(/g)) {
      const before = region.slice(Math.max(0, m.index! - 400), m.index!);
      assert.ok(!before.includes('noteCompactFailedOnExit();'), '重发前不该落卡片');
    }
  });
  test('主进程：kiro 的「连着空响应换模型重发」不吃安全过滤', () => {
    assert.match(index, /isBareInternalError\(text\) && bareStreak >= POISONED_AFTER && !producedThisTurn\s*&& emptySwaps < 1 && modelSwaps < MAX_MODEL_SWAPS && !isSafeguardBlock\(text\)\) \{/);
  });
  test('原文进卡片的详情（NOTE_DETAIL_SEP 之后），不平铺', () => {
    assert.match(index, /noteInSession\(sessionId, trConcat\(main, NOTE_DETAIL_SEP, String\(errText \|\| ''\)\.trim\(\)\.slice\(0, 4000\)\), undefined, safeguardNoteGroup\(compact\)\)/);
    assert.match(chat, /<summary>\{t\('Original error \(for troubleshooting\)'\)\}<\/summary>/);
  });
  test('卡片三个出口：换模型 / 换后端会话 / 申请链接，并写明换会话未必能解', () => {
    const card = chat.slice(chat.indexOf('const SafeguardCard = memo'), chat.indexOf('// Kiro CLI does not expose exact per-turn token counts'));
    assert.ok(card.includes('modelSwitch.pick(target)'));
    assert.ok(card.includes('newBackendSession?.(sessionId)'));
    assert.ok(card.includes('openExternal?.(url)'));
    assert.ok(card.includes('a new session may not help; switch models first'));
  });
  test('渲染端：认出这句短话就不重连重发', () => {
    assert.match(acp, /\} else if \(isSafeguardReport\(msg\)\) \{/);
  });
});
