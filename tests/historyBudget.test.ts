import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  fitHistory, historyTrimNote, utf8Bytes, HISTORY_BUDGET_BYTES, HISTORY_KEEP_AT_LEAST,
} from '../src/main/historyBudget.ts';

const entry = (line: string) => ({ line });
const filler = (bytes: number) => entry('x'.repeat(Math.max(1, bytes - 8)));

/**
 * 「⚠️ Error invoking remote method 'acp:prompt': Error: Internal error — Kiro failed to generate a response」
 *
 * 现场（2026-09-01 00:40，`Aurora to S3 Iceberg`）：连续三次 `Internal error`，每次 5–7 秒就失败，
 * 日志里没有任何模型退役的迹象。真正的数字是 transcript 939 KB / 497 条、`history.md` **696 KB** ——
 * 而那份就是喂给后端重建上下文的。`renderHistoryFile` 一个上限都没有，会话越长越必然撞墙，
 * 而撞墙那天报错里一个字都不提"太大了"。
 */
describe('历史预算', () => {
  test('装得下就全带上，不动它', () => {
    const all = [entry('a'), entry('b'), entry('c')];
    const out = fitHistory(all);
    assert.equal(out.dropped, 0);
    assert.deepEqual(out.kept.map((e) => e.line), ['a', 'b', 'c']);
  });

  test('装不下就丢**最早的**，留最近的 —— 最近那几轮才是你正在谈的', () => {
    const all = [filler(100), filler(100), filler(100)];
    const out = fitHistory(all, { budgetBytes: 220, keepAtLeast: 0 });
    assert.equal(out.kept.length, 2);
    assert.equal(out.dropped, 1);
    assert.equal(out.kept[out.kept.length - 1], all[2], '最后一条必须在');
  });

  test('顺序仍然是早 → 晚 —— 倒着喂给模型比少喂更糟', () => {
    const all = [entry('一'), entry('二'), entry('三')];
    const out = fitHistory(all, { budgetBytes: 10_000 });
    assert.deepEqual(out.kept.map((e) => e.line), ['一', '二', '三']);
  });

  test('预算再小也留住最后几条 —— 否则一条超长消息就能把历史清空', () => {
    /*
      那种状态下模型完全不知道你刚说了什么，而它看起来只是"答得莫名其妙"——
      最难查的一类失败：没有报错，只有变差。
    */
    const all = [filler(5000), filler(5000), filler(5000)];
    const out = fitHistory(all, { budgetBytes: 10, keepAtLeast: 2 });
    assert.equal(out.kept.length, 2);
    assert.equal(out.kept[1], all[2]);
  });

  test('中文按 UTF-8 字节算，不按 length —— 差三倍，而这个判据的全部意义就是别估错', () => {
    assert.equal(utf8Bytes('中文'), 6);
    assert.equal('中文'.length, 2);
    // 100 个汉字 = 300 字节：按 length 估会以为只有 100，于是预算形同虚设
    const all = [entry('中'.repeat(100)), entry('中'.repeat(100))];
    const out = fitHistory(all, { budgetBytes: 320, keepAtLeast: 0 });
    assert.equal(out.kept.length, 1);
  });

  test('空输入不炸', () => {
    assert.deepEqual(fitHistory(null).kept, []);
    assert.deepEqual(fitHistory([]).kept, []);
    assert.equal(fitHistory(undefined).dropped, 0);
  });

  test('默认预算远小于那次失败的 696 KB，也远大于一次正常对话', () => {
    assert.ok(HISTORY_BUDGET_BYTES < 696 * 1024, '必须挡住实测失败的那个规模');
    assert.ok(HISTORY_BUDGET_BYTES >= 128 * 1024, '也不能小到每轮都要问"刚才说到哪"');
    assert.ok(HISTORY_KEEP_AT_LEAST >= 2);
  });
});

describe('丢了要说出来', () => {
  test('丢了就给一句给模型看的说明', () => {
    const note = historyTrimNote(400, 497);
    assert.match(note, /不完整/);
    assert.match(note, /497/);
    assert.match(note, /97/, '要说清带了多少条');
    assert.match(note, /问用户/, '不许它凭半份历史推断"我们之前说过什么"');
  });

  test('没丢就一个字都不加 —— 完整的历史不该带一句自我怀疑', () => {
    assert.equal(historyTrimNote(0, 10), '');
    assert.equal(historyTrimNote(-1, 10), '');
  });
});

describe('接线', () => {
  const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('renderHistoryFile 走预算，而且丢了会记日志', () => {
    const fn = MAIN.slice(MAIN.indexOf('function renderHistoryFile'));
    const body = fn.slice(0, fn.indexOf('} catch'));
    assert.match(body, /fitHistory\(/);
    assert.match(body, /historyTrimNote\(/);
    assert.match(body, /history trimmed/, '静默截断查不出来 —— 那正是这个 bug 难查的原因');
  });

  test('返回的 count 是**带上的**条数，不是总条数', () => {
    // 日志里那句 `messages=N` 是用来对账"模型拿到了多少"的，写总数就等于骗自己
    const fn = MAIN.slice(MAIN.indexOf('function renderHistoryFile'));
    assert.match(fn.slice(0, 2200), /count: fitted\.kept\.length/);
  });
});

/**
 * 快照里那句「未删减」不能是假的。
 *
 * `buildSnapshot` 只内联最近几条，但它紧跟着告诉模型「凡是需要更早的细节直接读这个文件」——
 * 而那个文件现在是有预算的。声明和事实不一致的后果不是"少给了历史"，是模型**以为自己拿到了全部**，
 * 然后对"我们之前说过什么"给出自信的错答案。
 */
describe('快照里那句声明要和文件对得上', () => {
  const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const fn = MAIN.slice(MAIN.indexOf('function buildSnapshot'), MAIN.indexOf('function artifactManifest'));

  test('不再无条件写「未删减」', () => {
    assert.doesNotMatch(fn, /全部 \$\{lines\.length\} 条消息，未删减）保存在这个文件里/);
  });

  test('条数取自实际写进文件的那个（rendered.count），不是总条数', () => {
    assert.match(fn, /rendered\?\.count \?\? lines\.length/);
  });

  test('截断了就说清缺多少，并让它去问用户', () => {
    assert.match(fn, /超出上下文预算没有写进去/);
    assert.match(fn, /问用户/);
  });

  test('没截断时仍然说「未删减」—— 完整的历史不该带一句自我怀疑', () => {
    assert.match(fn, /未删减/);
  });
});
