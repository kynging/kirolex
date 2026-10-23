import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchConsumedSteers, settleAtTurnEnd, steerMatchKey, type PendingSteer } from '../src/renderer/steerPending.ts';
import { steerPayload } from '../src/renderer/steerRoute.ts';
import { rewriteImagePaths } from '../src/main/imagePaths.ts';

/**
 * 「被吃掉了」的对账要按**真正写出去的正文**精确比，图片的身份（哪张图）不能丢。
 *
 * 主进程 `acp:steer` 写出去之前会把大图路径换成 `~/.kirolex/capped/` 里的缩小副本。
 *   · 第一版按原路径精确比：两条大图 steer 一次被吃掉时都对不上，兜底只认最老那条，另一条轮末回队重发；
 *   · 第二版把所有图片路径当成一样：「看这张图 + first.png」和「看这张图 + second.png」分不清，
 *     快照只确认 two 却认成 one —— two 轮末回队重发，one 没送达却被当成送达了。
 * 现在：渲染端登记之前先问主进程「会写出去的是哪份」（`acp:cap-steer-text`），登记、对账都用那份，精确比较。
 */

/** 模拟主进程的缩放：大图换成 capped 副本；副本本身已经不大，再处理一遍不变（和 safeImageRef 一样） */
const capLikeMain = (text: string) =>
  rewriteImagePaths(text, (p) => (p.includes('big') && !p.includes('capped') ? `C:\\Users\\me\\.kirolex\\capped\\${path.basename(p).replace(/\.[^.]+$/, '')}_1500px.png` : p));
const wrap = (t: string) => `<user_message>\n${t}\n</user_message>`;
/** 渲染端登记的：先经过 acp:cap-steer-text */
const registered = (id: string, text: string, img: string): PendingSteer<unknown> => ({
  msgId: id, content: text, attachments: [], sent: capLikeMain(steerPayload(text, [{ path: img, isImage: true }])),
});
/** kiro 回报的：acp:steer 又处理了一遍（结果不变）再包上 <user_message> */
const delivered = (s: PendingSteer<unknown>) => wrap(capLikeMain(s.sent!));

describe('两条带大图的 steer 在同一个边界被一次吃掉', () => {
  const one = registered('one', '看第一张', 'C:\\Users\\me\\Desktop\\big-1.png');
  const two = registered('two', '再看第二张', '/Users/me/Desktop/big-2.png');

  test('前提：登记的已经是缩小副本的路径，主进程再处理一遍不变', () => {
    assert.match(one.sent!, /capped\\big-1_1500px\.png/);
    assert.equal(capLikeMain(one.sent!), one.sent);
  });

  test('两条都认作已送达，轮末一条都不回队', () => {
    const consumed = matchConsumedSteers([one, two], [one, two].map(delivered).join('\n'));
    assert.deepEqual([...consumed].sort(), ['one', 'two']);
    assert.deepEqual(settleAtTurnEnd([one, two].filter((s) => !consumed.has(s.msgId))).requeue, []);
  });

  test('旧版本不带 <user_message> 包裹的拼接快照也一样', () => {
    const snapshot = [one, two].map((s) => capLikeMain(s.sent!)).join('\n');
    assert.deepEqual([...matchConsumedSteers([one, two], snapshot)].sort(), ['one', 'two']);
  });
});

describe('同样的话、不同的图：按图分清是哪一条', () => {
  const one = registered('one', '看这张图', '/Users/me/Desktop/first.png');
  const two = registered('two', '看这张图', '/Users/me/Desktop/second.png');

  test('快照只确认第二条 → 只认 two；one 还在等，轮末才回队', () => {
    const consumed = matchConsumedSteers([one, two], delivered(two));
    assert.deepEqual([...consumed], ['two']);
    assert.deepEqual(settleAtTurnEnd([one, two].filter((s) => !consumed.has(s.msgId))).requeue.map((s) => s.msgId), ['one']);
  });

  test('图是大图（会被缩放）也一样分得清', () => {
    const a = registered('a', '看这张图', '/Users/me/Desktop/big-first.png');
    const b = registered('b', '看这张图', '/Users/me/Desktop/big-second.png');
    assert.deepEqual([...matchConsumedSteers([a, b], delivered(b))], ['b']);
  });

  test('比较用的正文保留图片路径', () => {
    assert.notEqual(steerMatchKey(one.sent!), steerMatchKey(two.sent!));
  });
});

describe('原来的对账规则不变', () => {
  test('不带图的照旧精确对上', () => {
    const a = { msgId: 'a', content: '甲', attachments: [] };
    const b = { msgId: 'b', content: '乙', attachments: [] };
    assert.deepEqual([...matchConsumedSteers([a, b], wrap('乙'))], ['b']);
  });

  test('同样的文字出现两次 → 吃一次只认一条', () => {
    const a = { msgId: 'a', content: '同一句', attachments: [] };
    const b = { msgId: 'b', content: '同一句', attachments: [] };
    assert.deepEqual([...matchConsumedSteers([a, b], wrap('同一句'))], ['a']);
  });

  test('快照不给正文 / 对不上 → 按 FIFO 认最老那一条', () => {
    const a = { msgId: 'a', content: '甲', attachments: [] };
    const b = { msgId: 'b', content: '乙', attachments: [] };
    assert.deepEqual([...matchConsumedSteers([a, b], '')], ['a']);
    assert.deepEqual([...matchConsumedSteers([a, b], wrap('完全无关'))], ['a']);
  });
});

describe('接线', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
  const MAIN = read('main', 'index.ts');
  const ACP = read('renderer', 'hooks', 'useAcp.ts');

  test('主进程给出「会写出去的正文」，和 acp:steer 用同一个缩放函数', () => {
    assert.match(MAIN, /ipcMain\.handle\('acp:cap-steer-text', async \(_event, message: string\) => capImageRefsInText\(String\(message \|\| ''\)\)\);/);
    const at = MAIN.indexOf("ipcMain.handle('acp:steer'");
    assert.match(MAIN.slice(at, MAIN.indexOf('\n  });', at)), /capImageRefsInText\(message\)/);
    assert.match(read('main', 'preload.ts'), /capSteerText: \(message: string\) =>\s*\n\s*ipcRenderer\.invoke\('acp:cap-steer-text', message\)/);
  });

  test('useAcp 先拿到那份正文再登记、再发 —— 登记必须在发 IPC 之前（kiro 可能马上回报吃掉）', () => {
    const fn = ACP.slice(ACP.indexOf('const steerMessage = useCallback'), ACP.indexOf('const takeUnconsumedSteers = useCallback'));
    const cap = fn.indexOf('await window.kiroApi.capSteerText?.(sent)');
    const reg = fn.indexOf('pendingSteersRef.current.set(sid, [');
    const send = fn.indexOf('await window.kiroApi.steer(sid, sent, msgId)');
    assert.ok(cap > 0 && reg > cap && send > reg, `顺序不对：cap=${cap} reg=${reg} send=${send}`);
  });
});
