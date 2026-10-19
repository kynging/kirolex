/**
 * **超时中断、重建历史失败这两类：主句短，诊断细节在「详情」里**（docs/notices-glossary.md：主句中文 ≤ 40 字左右）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { primeGiveUpNote } from '../src/main/primeRetry.ts';
import { splitNoteDetail, NOTE_DETAIL_SEP } from '../src/main/kirolexNote.ts';
import { setUiLang, trIn, uiLang } from '../src/main/uiText.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');
const M = read('src', 'main', 'index.ts');
function inZh<T>(fn: () => T): T { const b = uiLang(); setUiLang('zh'); try { return fn(); } finally { setUiLang(b); } }

describe('超时中断：主句一句，时长 / 上限 / 设置项进详情', () => {
  test('两种情形的主句（中文）都 ≤ 40 字，不带数字和设置项', () => {
    for (const key of ['⚠️ This turn was interrupted: a tool made no progress for too long.', '⚠️ This turn was interrupted: no output for too long.']) {
      const zh = trIn('zh', key);
      assert.notEqual(zh, key, '要有中文');
      assert.ok(zh.length <= 40, `太长（${zh.length} 字）：${zh}`);
      assert.doesNotMatch(zh, /\d|设置|上限/);
    }
  });

  test('接线：wedgeNote = 主句 + NOTE_DETAIL_SEP + 详情（时长、上限、设置项）', () => {
    assert.match(M, /\? trConcat\(tr\('⚠️ This turn was interrupted: a tool made no progress for too long\.'\), NOTE_DETAIL_SEP,\s*\n\s*tr\('\{count\} tool call\(s\) had no progress for \{idle\} \(limit \{limit\} min\)/);
    assert.match(M, /: trConcat\(tr\('⚠️ This turn was interrupted: no output for too long\.'\), NOTE_DETAIL_SEP,\s*\n\s*tr\('No output for \{quiet\} \(limit \{limit\} min\)/);
  });

  test('回复气泡认这个分隔符：主句照常渲染，详情折叠', () => {
    const CA = read('src', 'renderer', 'components', 'ChatArea.tsx');
    /* AssistantBody 多收了「写成文字的工具调用」用的两个参数（textToolCall.ts），详情照旧从 body 拆 */
    assert.match(CA, /function AssistantBody\(\{ body[^}]*\}: \{ body: string[^}]*\}\) \{[\s\S]{0,200}const \{ main, detail \} = splitNoteDetail\(body\);/);
    assert.match(CA, /<AssistantBody body=\{p\.body\}[^\n]*\/>/);
  });
});

describe('重建历史没完成：主句只有简短原因 + 没发出 + 下一步', () => {
  test('primeGiveUpNote 的主句只有"连续几次失败 + 简短原因"，分块 / 字数 / 原文在详情里', () => {
    const longErr = 'Internal error — ' + 'x'.repeat(300);
    const note = inZh(() => primeGiveUpNote({ chunk: 3, total: 6, chars: 1982, tries: 3, error: longErr, atFloor: true }));
    const { main, detail } = splitNoteDetail(note);
    assert.match(main, /^连续 3 次失败：Internal error/);
    assert.ok(main.length <= 80, `主句太长（${main.length}）`);
    assert.doesNotMatch(main, /3\/6|1982/);
    assert.match(detail, /第 3\/6 块/);
    assert.match(detail, /1982 字/);
    assert.ok(detail.includes('x'.repeat(300)), '原始错误全文在详情里');
  });

  test('拼成那条错误：主句里没有分块编号，"按停止放弃"和原因的详情都在详情里', () => {
    const giveUp = inZh(() => primeGiveUpNote({ chunk: 3, total: 6, chars: 1982, tries: 3, error: 'Internal error', atFloor: false }));
    const { main: why, detail: whyDetail } = splitNoteDetail(giveUp);
    const msg = trIn('zh', 'History was not rebuilt ({why}), so this message was not sent. {next}', { why, next: trIn('zh', 'Send again to retry.') });
    assert.equal(msg, '重建历史没完成（连续 3 次失败：Internal error），这条消息没发出。再发一次会重试。');
    assert.ok(msg.length <= 50);
    assert.doesNotMatch(msg, /3\/6|1982/);
    assert.match(whyDetail, /第 3\/6 块/);
    /* 接线：index.ts 拆开原因的主句 / 详情，把详情和"按停止放弃"接在 NOTE_DETAIL_SEP 后面 */
    assert.match(M, /const \{ main: whyMain, detail: whyDetail \} = splitNoteDetail\(primed\.error \|\| tr\('unknown reason'\)\);/);
    assert.match(M, /NOTE_DETAIL_SEP,\s*\n\s*tr\('Press Stop to give up rebuilding; later messages then go out without history\.'\),\s*\n\s*whyDetail \?/);
  });

  test('错误横幅（两处）也折叠详情', () => {
    const CA = read('src', 'renderer', 'components', 'ChatArea.tsx');
    assert.equal((CA.match(/<NoticeBody text=\{bannerText\(shownIn\(findLang, connectionError\) \?\? ''\)\} \/>/g) || []).length, 2);
  });

  test('重建中的进度行 ≤ 40 字；手动重建失败那行只显示原因的主句', async () => {
    const { t } = await import('../src/renderer/i18n.ts');
    const zh = t('zh', '⏳ Rebuilding history; new messages go out when it finishes. Press Stop to give up.');
    assert.ok(zh.length <= 40, `太长（${zh.length}）：${zh}`);
    assert.match(zh, /重建/, '渲染端按「重建」认这一行（useAcp）');
    const A = read('src', 'renderer', 'hooks', 'useAcp.ts');
    assert.match(A, /reason: splitNoteDetail\(res\.error \|\| ''\)\.main \|\| t\('unknown reason'\)/);
    assert.ok(NOTE_DETAIL_SEP.length > 0);
  });
});

describe('kiro-cli 日志认出的原因：主句是简短原因 + 下一步，日志原文只在详情里', () => {
  test('连接失败 / 限流 / 请求被拒 / 认不出：日志原文不进主句', async () => {
    const { explainCliError } = await import('../src/main/kiroCliLog.ts');
    const line = (message: string) => [{ ts: 1, level: 'ERROR', target: 'agent::agent', message }];
    const cases: Array<[string, RegExp]> = [
      ['An unknown error occurred: dispatch failure SECRET_RAW_A', /连不上模型服务，检查网络\/VPN/],
      ['ThrottlingException: Too many requests SECRET_RAW_B', /被限流了/],
      ['ValidationException: image exceed max allowed size SECRET_RAW_C', /请求被服务端拒绝/],
      ['something odd happened SECRET_RAW_D', /kiro-cli 报了错/],
    ];
    for (const [raw, want] of cases) {
      const s = inZh(() => explainCliError(line(raw)));
      const { main, detail } = splitNoteDetail(s);
      assert.match(main, want);
      assert.doesNotMatch(main, /SECRET_RAW/, `日志原文进了主句：${main}`);
      assert.ok(main.length <= 40, `主句太长（${main.length}）：${main}`);
      assert.match(detail, /^kiro-cli 日志：.*SECRET_RAW/);
    }
  });
});

describe('换组合失败只说一处', () => {
  test('说明随抛出的错误给组合下拉旁的 ✗（ChatArea engineModelErr），不再另发状态行', () => {
    const h = M.indexOf('const switchMcpComboImpl = async');
    const caught = M.slice(M.indexOf('} catch (err) {', h), M.indexOf('\n  };\n', h));
    assert.match(caught, /throw new Error\(tr\('Switching to the combo "\{name\}" failed/);
    assert.doesNotMatch(caught, /sessionNotice\(/);
    const CA = read('src', 'renderer', 'components', 'ChatArea.tsx');
    assert.match(CA, /kiroApi\.switchMcpCombo\(currentSessionId, comboId\);[\s\S]{0,300}setEngineModelErr\(String\(err\?\.message \|\| err\)/);
  });
});
