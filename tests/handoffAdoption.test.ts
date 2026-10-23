import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { onBusyChange, onHandoffMainTurn, onOwnTurnEnd, type AdoptionState } from '../src/renderer/handoffAdoption.ts';

/**
 * 交棒之后渲染端的流怎么接（`handoffAdoption.ts`）。按事件先后把三个回调重放一遍，
 * 看最后「这条会话还在流吗」—— 结束了还在流，界面就一直显示运行中、排队也一直不发。
 */
function session() {
  const s: AdoptionState = { pending: new Set(), adopted: new Set() };
  let streaming = true;                 // 窗口自己发的上一轮还在流
  return {
    s,
    get streaming() { return streaming; },
    mainTurn() { const r = onHandoffMainTurn(s, 'A', streaming); if (r === 'adopt-now') streaming = true; return r; },
    busy(reason: string | null) { if (onBusyChange(s, 'A', reason).endAdopted) streaming = false; },
    ownTurnEnd() { if (onOwnTurnEnd(s, 'A', streaming) === 'end') streaming = false; },
  };
}

describe('交棒之后的流', () => {
  test('通常的先后：main-turn → 上一轮收尾（流不断，转接管）→ busy 不再是 turn（收掉）', () => {
    const x = session();
    assert.equal(x.mainTurn(), 'pending');
    x.busy('turn');
    x.ownTurnEnd();
    assert.equal(x.streaming, true, '接手那一轮还在跑：流不断');
    assert.ok(x.s.adopted.has('A'));
    x.busy(null);
    assert.equal(x.streaming, false);
    assert.equal(x.s.adopted.size + x.s.pending.size, 0);
  });

  test('接手那一轮很快就结束：main-turn → busy 不再是 turn → 上一轮收尾 —— 不会去接管已经结束的那一轮（不会一直显示运行中）', () => {
    const x = session();
    x.mainTurn();
    x.busy(null);                        // 接手那一轮已经结束
    assert.equal(x.streaming, true, '这时窗口自己那一轮的收尾还没到');
    x.ownTurnEnd();
    assert.equal(x.streaming, false, '收尾时照常收掉流');
    assert.equal(x.s.adopted.size + x.s.pending.size, 0, '什么都没挂着');
  });

  test('中间的 busy 仍是 turn 的事件不作废 pending', () => {
    const x = session();
    x.mainTurn();
    x.busy('turn');
    x.busy('turn');
    assert.ok(x.s.pending.has('A'));
  });

  test('窗口自己那一轮早就收尾了（不在流）：main-turn 直接接管，busy 结束时收掉', () => {
    const x = session();
    x.ownTurnEnd();
    assert.equal(x.streaming, false);
    assert.equal(x.mainTurn(), 'adopt-now');
    assert.equal(x.streaming, true);
    x.busy(null);
    assert.equal(x.streaming, false);
  });

  test('已经在接管（接力排了好几条）：后面的 main-turn 不用再记 pending', () => {
    const x = session();
    x.mainTurn();
    x.ownTurnEnd();
    assert.equal(x.mainTurn(), 'nothing');
    x.busy(null);
    assert.equal(x.streaming, false);
  });

  test('接线：useAcp 的三个回调走的就是这三个函数（同一对 Set）', () => {
    const ACP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
    assert.ok(ACP.includes('const adoptionRef = useRef<AdoptionState>({ pending: handoffAdoptRef.current, adopted: adoptedTurnsRef.current });'));
    assert.ok(ACP.includes('onHandoffMainTurn(adoptionRef.current, sid, true);'));
    assert.ok(ACP.includes("if (onOwnTurnEnd(adoptionRef.current, sid, streamingIdsRef.current.has(sid)) === 'keep-streaming') {"));
    assert.ok(ACP.includes('if (onBusyChange({ pending: handoffAdoptRef.current, adopted: adoptedTurnsRef.current }, sid, reason).endAdopted) {'), 'busy 结束时：接管中的收掉、pending 的作废');
  });
});
