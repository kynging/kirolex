import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { primeVerdict, primeGiveUpNote } from '../src/main/primeRetry.ts';

const base = {
  tries: 1, chunkChars: 8000, stillBusy: false,
  minChunkChars: 2000, splitAfter: 2, maxTries: 8, giveUpAtFloor: 3,
};

/**
 * 实测的死循环：`chunk 1/6 FAILED chars=1982 tries=20`，每 60 秒一轮，永远。重建循环里已经有
 * 换模型上限、失败两次对半拆、退避封顶三样保护，独独缺一个放弃条件；块 1982 字已经在 2000 的
 * 地板上拆不动，于是每次都落到退避那一支。
 */
describe('重建失败之后该怎么办', () => {
  test('后端还在收尾 → 等它，而且不受次数限制', () => {
    assert.equal(primeVerdict({ ...base, stillBusy: true, tries: 99 }), 'retry');
    assert.equal(primeVerdict({ ...base, stillBusy: true, chunkChars: 1982, tries: 99 }), 'retry');
  });

  test('第一次失败先重试，别急着拆', () => {
    assert.equal(primeVerdict({ ...base, tries: 1 }), 'retry');
  });

  test('连续失败到阈值、而且还拆得动 → 拆', () => {
    assert.equal(primeVerdict({ ...base, tries: 2 }), 'split');
    assert.equal(primeVerdict({ ...base, tries: 5 }), 'split');
  });

  test('已经在地板上还失败 → 放弃', () => {
    assert.equal(primeVerdict({ ...base, chunkChars: 1982, tries: 3 }), 'give-up');
    assert.equal(primeVerdict({ ...base, chunkChars: 2000, tries: 3 }), 'give-up');
  });

  test('地板上但只失败一两次 → 还是先重试（可能是瞬时的）', () => {
    assert.equal(primeVerdict({ ...base, chunkChars: 1982, tries: 1 }), 'retry');
    assert.equal(primeVerdict({ ...base, chunkChars: 1982, tries: 2 }), 'retry');
  });

  test('次数到顶就放弃，不管块多大', () => {
    assert.equal(primeVerdict({ ...base, tries: 8 }), 'give-up');
    assert.equal(primeVerdict({ ...base, chunkChars: 500_000, tries: 8 }), 'give-up');
  });

  test('放弃那句话要说清卡在哪、为什么不再试、你能做什么', () => {
    const note = primeGiveUpNote({ chunk: 1, total: 6, chars: 1982, tries: 3, error: 'Internal error', atFloor: true });
    assert.match(note, /第 1\/6 块/);
    assert.match(note, /1982 字/);
    assert.match(note, /Internal error/);
    assert.match(note, /不可能是"发得太大"/, '要说清为什么不再试');
    assert.match(note, /重启 KiroLex|分叉/, '这条失败是有解的，不给出路等于只说了"失败了"');
    assert.match(note, /下次发消息/, '要说清它还会再试');
  });

  test('因次数到顶放弃时，不能说"小到不可能是发得太大"', () => {
    const note = primeGiveUpNote({ chunk: 2, total: 3, chars: 24000, tries: 8, error: 'boom', atFloor: false });
    assert.doesNotMatch(note, /不可能是"发得太大"/);
    assert.match(note, /8 次/);
  });
});

describe('接线', () => {
  const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('循环里真的用了这个判据，而且 give-up 会 return', () => {
    assert.match(MAIN, /const verdict = primeVerdict\(\{/);
    assert.match(MAIN, /if \(verdict === 'give-up'\) \{[\s\S]{0,1400}?return \{ ok: false, error: note \}/);
    assert.match(MAIN, /GAVE UP sessionId=/);
  });

  test('拆那一支跟着判据走，不再自己判一遍大小', () => {
    assert.match(MAIN, /if \(verdict === 'split'\)/);
    assert.doesNotMatch(MAIN, /sameChunkFailures >= PRIME_SPLIT_AFTER && chunks\[i\]\.length > PRIME_MIN_CHUNK_CHARS/);
  });

  test('后端还在收尾不计入失败次数', () => {
    assert.match(MAIN, /if \(stillBusy\) busyWaits\+\+;\s*else sameChunkFailures\+\+;/);
  });

  test('放弃时不清 needsHistoryPrime，并把原因留在 primeLastError', () => {
    const at = MAIN.indexOf("if (verdict === 'give-up')");
    assert.ok(at > 0);
    const body = MAIN.slice(at, MAIN.indexOf('return { ok: false, error: note }', at));
    assert.doesNotMatch(body, /needsHistoryPrime = false/);
    assert.match(body, /primeLastError = note/, '原因要留在会话上给人看');
    assert.match(body, /primeGaveUp = true/);
  });

  test('放弃后不被自动排队立刻重跑，也不再占着会话；下次真正用到时才重试', () => {
    /*
      needsHistoryPrime 还是 true，如果 busyReasonFor 照旧报 prime-pending，emitSessionBusy 会马上
      schedulePrime，放弃就变成了"换个入口接着死循环"，而且会话一直被占着、排队的消息发不出去。
    */
    const busyFn = MAIN.slice(MAIN.indexOf('function busyReasonFor('), MAIN.indexOf('function emitSessionBusy('));
    assert.match(busyFn, /if \(entry\.primeAbandoned \|\| entry\.primeGaveUp\) return null;/);
    const drain = MAIN.slice(MAIN.indexOf('function drainPrimeQueue('), MAIN.indexOf('function schedulePrime('));
    assert.match(drain, /entry\.primeGaveUp/);
    // 真正发起一次重建（发消息 / 打开会话 / 手动重建）时清掉，重新开始计数
    const prime = MAIN.slice(MAIN.indexOf('async function primeHistoryNow('), MAIN.indexOf('const run = (async ()'));
    assert.match(prime, /entry\.primeGaveUp = false;/);
  });
});
