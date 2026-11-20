import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sessionDotStatus, type DotInputs } from '../src/renderer/sessionDot.ts';
import { isThrottleError, withThrottleRetry, runPerMachine, outputProvesAttached } from '../src/renderer/warmAttach.ts';

/*
  「为什么 agent board 会话现在显示的是红的」—— 2026-11-20 实测（Mac，main-20261120-201242.log）：
  12:12:53 启动预连接 attach s_1792550354705_bq53af 失败（SendSSHPublicKey 的 ThrottlingException：
  同一时刻几条会话一起连同一台 EC2）→ 红点；12:13:22 同一会话再 attach 成功、之后正常跑工具，侧栏仍是红点。
  原因：失败标记只在少数几条路径上摘，addAttached（listAttached / 主进程通知 / 发消息按需 attach）都不摘。
*/

const root = path.join(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const HK = read('src/renderer/hooks/useAcp.ts');

describe('确认连上（任何路径）都摘掉失败标记', () => {
  test('addAttached 里摘 failed；markFailed 里摘 attached（最近一次尝试说了算）', () => {
    const add = HK.slice(HK.indexOf('const addAttached = (sid: string) =>'), HK.indexOf('const removeAttached = (sid: string | null) =>'));
    assert.match(add, /clearFailed\(sid\)/);
    const mark = HK.slice(HK.indexOf('const markFailed = (sid: string | null) =>'), HK.indexOf('const clearFailed = (sid: string | null) =>'));
    assert.match(mark, /removeAttached\(sid\)/);
  });

  test('收到这条会话的流式输出 / 工具调用也算连上', () => {
    const at = HK.indexOf('const removeUpdate = window.kiroApi.onUpdate(');
    const body = HK.slice(at, HK.indexOf('switch (update.sessionUpdate)', at));
    assert.match(body, /outputProvesAttached\(update\.sessionUpdate\)/);
    assert.match(body, /addAttached\(sessionId\)/);
    assert.equal(outputProvesAttached('agent_message_chunk'), true);
    assert.equal(outputProvesAttached('agent_thought_chunk'), true);
    assert.equal(outputProvesAttached('tool_call'), true);
    assert.equal(outputProvesAttached('tool_call_update'), true);
    assert.equal(outputProvesAttached('available_commands_update'), false);
    assert.equal(outputProvesAttached(undefined), false);
  });
});

describe('发消息：确认连上之前不标已连上（先标红 → 发送 → 重连仍失败 → 还是红）', () => {
  const at = HK.indexOf('const turnToken = beginStreamingTurn(sid!);');
  const end = HK.indexOf('const sendMessageRef = useRef(sendMessage);', at);
  const body = HK.slice(at, end);
  const promptAt = body.indexOf('await window.kiroApi.prompt(');

  test('prompt 发出去之前没有 addAttached（不会一点发送就摘掉红点）', () => {
    assert.ok(promptAt > 0);
    assert.equal(/addAttached\(/.test(body.slice(0, promptAt)), false);
  });

  test('只在确认连上后标：prompt 成功之后、重连的 loadSession 成功之后', () => {
    assert.match(body, /await window\.kiroApi\.prompt\([^\n]*\);\n\s*addAttached\(sid!\);/);
    assert.match(body, /await window\.kiroApi\.loadSession\(sid, attachCwdFor\(sid\), activeModel\);\n\s*reattached = true;\n\s*addAttached\(sid!\);/);
  });

  test('重连本身失败（限流 / 超时，不只是缺适配器）→ markFailed，圆点仍是红', () => {
    assert.match(body, /if \(!reattached && !recoveryCancelledRef\.current\.has\(sid!\)\) markFailed\(sid!\);/);
    /* 走完这条路：发送前没 addAttached，markFailed 又摘掉 attached（上面那条测试）→ failed 在、attached 不在 → 红 */
    assert.equal(sessionDotStatus({ id: 's1', currentSessionId: 's1', busy: null, streaming: false, connecting: false, failed: true, unread: false, attached: false }), 'alert');
  });
});

describe('侧栏圆点：已连上 > 失败 > 未连接', () => {
  const base: DotInputs = { id: 's1', currentSessionId: null, busy: null, streaming: false, connecting: false, failed: false, unread: false, attached: false };
  test('失败、之后没连上 → 红', () => {
    assert.equal(sessionDotStatus({ ...base, failed: true }), 'alert');
  });
  test('失败过但已连上 → 按已连上画（后台绿 / 当前 idle），不再红', () => {
    assert.equal(sessionDotStatus({ ...base, failed: true, attached: true }), 'warm');
    assert.equal(sessionDotStatus({ ...base, failed: true, attached: true, currentSessionId: 's1' }), 'idle');
  });
  test('没连、也没失败 → 灰', () => {
    assert.equal(sessionDotStatus(base), 'dormant');
    assert.equal(sessionDotStatus({ ...base, id: 'pending_x' }), 'dormant');
  });
  test('其余顺序不变：重建 > 输出中 > 连接中 > 失败 > 未读', () => {
    assert.equal(sessionDotStatus({ ...base, busy: 'priming', streaming: true }), 'rebuilding');
    assert.equal(sessionDotStatus({ ...base, streaming: true, failed: true }), 'streaming');
    assert.equal(sessionDotStatus({ ...base, busy: 'turn' }), 'streaming');
    assert.equal(sessionDotStatus({ ...base, busy: 'attaching', failed: true }), 'connecting');
    assert.equal(sessionDotStatus({ ...base, connecting: true, failed: true }), 'connecting');
    assert.equal(sessionDotStatus({ ...base, failed: true, unread: true }), 'alert');
    assert.equal(sessionDotStatus({ ...base, unread: true, attached: true }), 'unread');
  });
  test('Sidebar 的 statusFor 用这一份', () => {
    assert.match(read('src/renderer/components/Sidebar.tsx'), /sessionDotStatus\(\{/);
  });
});

describe('启动预连接：限流要重试、同一台机器不同时推公钥', () => {
  const throttle = new Error("Error invoking remote method 'acp:load-session': Error: An error occurred (ThrottlingException) when calling the SendSSHPublicKey operation (reached max retries: 2): Rate exceeded");
  test('认得 SendSSHPublicKey 的限流；别的错误不算', () => {
    assert.equal(isThrottleError(throttle), true);
    assert.equal(isThrottleError(new Error('TooManyRequestsException: Rate exceeded')), true);
    assert.equal(isThrottleError(new Error('Connection timed out during banner exchange')), false);
    assert.equal(isThrottleError(new Error('All live sessions are busy; cannot attach another right now.')), false);
    assert.equal(isThrottleError(undefined), false);
  });

  test('限流 → 退避重试，第二次成了就成', async () => {
    let n = 0; const waits: number[] = [];
    const r = await withThrottleRetry(async () => { if (n++ === 0) throw throttle; return 'ok'; }, { sleep: async (ms) => { waits.push(ms); } });
    assert.equal(r, 'ok');
    assert.equal(n, 2);
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 1000);
  });

  test('一直限流：最多重试两次再抛（退避递增）', async () => {
    let n = 0; const waits: number[] = [];
    await assert.rejects(withThrottleRetry(async () => { n++; throw throttle; }, { sleep: async (ms) => { waits.push(ms); } }), /ThrottlingException/);
    assert.equal(n, 3);
    assert.equal(waits.length, 2);
    assert.ok(waits[1] > waits[0]);
  });

  test('非限流错误：不重试，直接抛（标失败）', async () => {
    let n = 0; const waits: number[] = [];
    await assert.rejects(withThrottleRetry(async () => { n++; throw new Error('Connection closed'); }, { sleep: async (ms) => { waits.push(ms); } }), /Connection closed/);
    assert.equal(n, 1);
    assert.equal(waits.length, 0);
  });

  test('同一台机器的串行，不同机器 / 本机的并行', async () => {
    const running = new Map<string, number>(); let maxSame = 0; let maxAll = 0; let all = 0;
    const order: string[] = [];
    const items = [
      { id: 'a1', m: 'ec2-a' }, { id: 'a2', m: 'ec2-a' }, { id: 'a3', m: 'ec2-a' },
      { id: 'b1', m: 'ec2-b' }, { id: 'l1', m: '' }, { id: 'l2', m: '' },
    ];
    await runPerMachine(items, (x) => x.m, async (x) => {
      all++; maxAll = Math.max(maxAll, all);
      if (x.m) { running.set(x.m, (running.get(x.m) || 0) + 1); maxSame = Math.max(maxSame, running.get(x.m)!); }
      await new Promise((r) => setTimeout(r, 5));
      if (x.m) running.set(x.m, running.get(x.m)! - 1);
      all--; order.push(x.id);
    });
    assert.equal(maxSame, 1, '同一台机器一次只连一条');
    assert.ok(maxAll >= 4, '不同机器、本机的照样一起连');
    assert.deepEqual(order.filter((x) => x.startsWith('a')), ['a1', 'a2', 'a3']);
    assert.equal(order.length, 6);
  });

  test('某一条失败不挡同一台机器的下一条', async () => {
    const done: string[] = [];
    await runPerMachine([{ id: 'x', m: 'h' }, { id: 'y', m: 'h' }], (x) => x.m, async (x) => {
      if (x.id === 'x') throw new Error('boom');
      done.push(x.id);
    });
    assert.deepEqual(done, ['y']);
  });

  test('接线：预连接按机器串行、每条走限流重试', () => {
    const eff = HK.indexOf('Eager-attach existing sessions at startup');
    const body = HK.slice(eff, HK.indexOf('}, [hydrated]);', eff));
    assert.match(body, /runPerMachine\(\s*toAttach,/);
    assert.match(body, /withThrottleRetry\(async \(\) => \{\s*if \(!attachedIdsRef\.current\.has\(s\.id\)\) await window\.kiroApi\.loadSession\(s\.id/);
    /* 重试期间别的路已经连上：不标红 */
    assert.match(body, /if \(!attachedIdsRef\.current\.has\(s\.id\)\) markFailed\(s\.id\)/);
  });
});
