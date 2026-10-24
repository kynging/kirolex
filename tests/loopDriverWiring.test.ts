/**
 * loop driver 的接线（源码扫描）：index.ts 真的建了主进程的 driver、按时 tick、经唤醒队列用确定的消息 id 发；
 * 渲染端不再自己驱动（只镜像 loop:list-live / loop:changed、把用户的停止转给主进程）。
 * 纯逻辑见 tests/loopDriver.test.ts。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loopRoundBlocker } from '../src/main/loopDriver.ts';
import { isLoopRoundMessageId } from '../src/main/loopMachine.ts';
import * as loopStore from '../src/main/loopStore.ts';
import os from 'node:os';

const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const M = read('main/index.ts');
const P = read('main/preload.ts');
const U = read('renderer/hooks/useAcp.ts');

function slice(text: string, anchor: string, len = 2500): string {
  const i = text.indexOf(anchor);
  assert.ok(i >= 0, `找不到 ${anchor}`);
  return text.slice(i, i + len);
}

describe('主进程接线', () => {
  test('建了 LoopDriver，发送走唤醒队列（source: loop，ref = 这一轮的消息 id），不走 forwardToUi', () => {
    const block = slice(M, 'loopDriver = new LoopDriver({');
    assert.match(block, /send: \(sid, text, messageId\) => wakeDispatcher\.enqueue\(\{ sessionId: sid, text, at: Date\.now\(\), source: 'loop', ref: messageId \}\)/);
    assert.doesNotMatch(block.slice(0, block.indexOf('const LOOP_TICK_MS')), /forwardToUi/);
    assert.match(block, /messageStatus: \(sid, messageId\) => store\.messageIdStatusOnDisk\(sid, messageId\)/, '账本按盘上的 transcript 判');
    assert.match(block, /canStart: \(sid\) => !quitPending/, '等待退出期间不开新一轮');
    assert.match(block, /verify: [\s\S]*runLoopVerifier\(sid, command, timeoutSec\)/, '校验和 loop:verify 同一套');
  });

  test('定时 tick + 退出时停掉', () => {
    assert.match(M, /const loopTicker = setInterval\(\(\) => \{ if \(!quitPending\) void loopDriver\?\.tick\(\); \}, LOOP_TICK_MS\);/);
    assert.match(M, /app\.on\('before-quit', \(\) => clearInterval\(loopTicker\)\);/);
  });

  test('循环的一轮走 loopDeliver：用 driver 给的确定 id，挂执行器前后、提交前都按循环记录再判一次', () => {
    const route = slice(M, 'const wakeDispatcher = new WakeDispatcher({', 800);
    assert.match(route, /if \(item\.source === 'loop' && loopDeliver\) return loopDeliver\(item\);/);
    const block = slice(M, 'loopDeliver = async (item) => {', 1800);
    assert.match(block, /const stillWanted = \(\) => loopRoundBlocker\(os\.homedir\(\), sid, item\.ref\);/);
    const attach = block.indexOf('await ensureAttached(sid)');
    const recheck = block.indexOf('if (blocked) throw new WakeSkipped(blocked)', attach);
    assert.ok(attach > 0 && recheck > attach, '挂执行器之后再判一次');
    assert.match(block, /messageId: String\(item\.ref\),/);
    assert.match(block, /announce: true,\s*stillWanted,/, '界面开着就插进这条消息；sendPromptOnce 落盘前再判一次');
    assert.doesNotMatch(block, /bgOutput|markBgOutputSeen/, '循环的一轮不是后台输出');
  });

  test('IPC：loop:start / loop:stop / loop:list-live 都交给 driver；删会话 = discarded', () => {
    assert.match(slice(M, "ipcMain.handle('loop:start'"), /loopDriver!\.start\(sessionId, spec\)/);
    assert.match(slice(M, "ipcMain.handle('loop:stop'"), /loopDriver!\.stop\(sessionId, 'aborted'\)/);
    assert.match(slice(M, "ipcMain.handle('loop:list-live'", 200), /loopDriver!\.list\(\)/);
    assert.match(slice(M, "wakeDispatcher.drop(sessionId, 'session deleted');", 300), /loopDriver\?\.stop\(sessionId, 'discarded'\)/);
    assert.match(M, /webContents\.send\('loop:changed'/);
    assert.match(P, /loopStart: \(sessionId: string, spec: any\) => ipcRenderer\.invoke\('loop:start'/);
    assert.match(P, /loopStop: \(sessionId: string\) => ipcRenderer\.invoke\('loop:stop', sessionId, 'aborted'\)/);
    assert.match(P, /ipcRenderer\.on\('loop:changed'/);
  });
});

describe('渲染端只显示 + 用户操作', () => {
  test('没有渲染端的驱动了：不自己发轮次、不自己记账、不自己校验', () => {
    for (const gone of ['sendLoopBackground', 'loopBeginRound', 'loopsRef', 'loopVerify?.(', 'reportLoopEnd', 'verdictFromCommand', 'advance(']) {
      assert.ok(!U.includes(gone), `useAcp.ts 里不该还有 ${gone}`);
    }
  });

  test('loopingIds 是主进程的镜像（刷新后重读）', () => {
    const block = slice(U, 'The live-loop MIRROR', 4500);
    assert.match(block, /window\.kiroApi\.loopListLive\?\.\(\)/);
    assert.match(block, /window\.kiroApi\.onLoopChanged\?\.\(refresh\)/);
    // 校验卡片按主进程记在 run 上的那几轮画（刷新后照样画回来），不是自己判的
    assert.match(block, /for \(const r of runs\) if \(r\?\.sessionId\) showVerdict\(String\(r\.sessionId\), r\);/);
    assert.match(block, /run\.verdictRounds/);
    // 卡片只在界面上：从盘上读回这条会话时要接回去，不然一打开会话它就没了
    assert.match(slice(U, 'const withFailed = (sid: string, msgs: Message[]): Message[] => {', 500), /liveLoopCardsRef\.current\.get\(sid\)/);
  });

  test('重载后的「自动重发没答完的提问」不碰循环的轮次（只认领还在跑的那一轮）—— 否则换新 id 重发会绕过账本', () => {
    const block = slice(U, 'const recoverInterruptedTurn = (sid: string', 9000);
    assert.match(block, /const loopOwned = loopingIdsRef\.current\.has\(sid\);/);
    const guard = block.indexOf('if (loopOwned || isLoopRoundMessageId(target?.id)) {');
    const resend = block.indexOf('markRecovering(sid, true)');
    assert.ok(guard > 0 && resend > guard, '在开始重发之前拦下');
    assert.match(block.slice(guard, guard + 500), /adoptTurn\(sid, peek\)/);
    assert.match(block.slice(guard, guard + 600), /\n      return;\n/);
  });

  test('看门狗判卡死后的「自动续写」不碰循环：被循环占着的会话 / 循环的一轮都直接返回，交给主进程按账本处理', () => {
    const block = slice(U, 'const removeTurnWedged = window.kiroApi.onTurnWedged?.(', 3000);
    const guard = block.indexOf('if (loopingIdsRef.current.has(sid) || isLoopRoundMessageId(lastUser?.id)) return;');
    const produced = block.indexOf('if (produced) {');
    const cont = block.indexOf('WEDGE_CONTINUE_PROMPT');
    assert.ok(guard > 0 && produced > guard && cont > guard, '续写 / 重发两条分支之前就拦下');
  });

  test('isLoopRoundMessageId 只认循环轮次的 id，不认校验卡片', () => {
    assert.equal(isLoopRoundMessageId('loop_1730000000000_3'), true);
    assert.equal(isLoopRoundMessageId(loopStore.roundMessageId({ startedAt: 5 }, 2)), true);
    assert.equal(isLoopRoundMessageId('loop_verdicts_s_5'), false);
    assert.equal(isLoopRoundMessageId('user_123'), false);
    assert.equal(isLoopRoundMessageId(undefined), false);
  });

  test('停止只转发 aborted；断开 / 执行器回收（torn-down / blocked）不会结束主进程里的循环', () => {
    const block = slice(U, 'const endLoop = useCallback(', 900);
    assert.match(block, /if \(terminal !== 'aborted'\) continue;/);
    assert.match(block, /window\.kiroApi\.loopStop\?\.\(sid\)/);
  });
});

describe('loopRoundBlocker：排着的一轮在发之前再看一眼盘上', () => {
  test('循环停了 / 被替换了 / 不是在飞的那一轮 → 不发', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-loopwire-'));
    try {
      assert.equal(loopRoundBlocker(home, 's', 'loop_1_1'), 'loop gone');
      const base = { spec: { stop: { maxIterations: 3 } }, sessionId: 's', iteration: 1, startedAt: 1, terminal: null, driver: 'main', inFlight: { iteration: 1, messageId: 'loop_1_1', at: 1 } };
      loopStore.writeLoop('s', base as any, home);
      assert.equal(loopRoundBlocker(home, 's', 'loop_1_1'), null);
      assert.equal(loopRoundBlocker(home, 's', 'loop_1_2'), 'not the round in flight');
      loopStore.writeLoop('s', { ...base, terminal: 'aborted' } as any, home);
      assert.match(String(loopRoundBlocker(home, 's', 'loop_1_1')), /aborted/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
