import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { AcpClient } from '../src/main/acp-client.ts';
import {
  cliSessionOwnerFor, cliSessionOwnerMismatch, pinCliSessionOwnerBeforeRetarget, stampCliSessionOwner, validCliSessionOwner,
} from '../src/main/cliSessionOwner.ts';
import { mergeRecords } from '../src/main/transcriptMerge.ts';
import { adapterForwardPlan, forwardableFromCombo, notForwardedNotice } from '../src/main/forwardMcp.ts';
import { splitNoteDetail } from '../src/main/kirolexNote.ts';
import { trIn } from '../src/main/uiText.ts';
import { withoutPermissionCard } from '../src/renderer/permissionCards.ts';
import { enterRoute, busyEnterKind } from '../src/renderer/steerRoute.ts';

/**
 * Claude Code / Codex 运行模式审计（docs/engine-audit-claude-codex.md）第四轮：原来标「未修」的
 * 1.1 / 1.2（换引擎 / 换机器后拿旧 id 去 load）、2.1（权限卡片残留）、2.4（等待时长按会话 + id 记）、
 * 2.5（未知请求提示说对引擎）、4.1（组合里的 MCP 没带进远程会话要说一声）、5.1（控制入口 auto 发给不能 steer 的会话自动排队）。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf-8');
const M = read('src', 'main', 'index.ts');
const ACP = read('src', 'renderer', 'hooks', 'useAcp.ts');
const APP = read('src', 'renderer', 'App.tsx');

function slice(src: string, anchor: string, len = 2500): string {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `找不到锚点：${anchor}`);
  return src.slice(at, at + len);
}

function fakeClient(engine: 'kiro' | 'claude' | 'codex', permissionMode: 'ask' | 'auto-approve' = 'ask') {
  const c: any = new AcpClient('m', {}, undefined, permissionMode, undefined, undefined, engine);
  const sent: any[] = [];
  c.send = (msg: any) => { sent.push(msg); };
  return { c, sent };
}

describe('1.1 / 1.2 记录里的后端会话 id 记上属于哪个引擎、哪台机器', () => {
  const local = { engine: 'claude' };
  const remote = { engine: 'claude', remote: { sshHost: 'box' } };

  test('写新 id 时记上；引擎 / 机器对不上才判「别人家的」', () => {
    const rec: any = { cliSessionId: 'c1', profile: local };
    stampCliSessionOwner(rec, local);
    assert.deepEqual(rec.cliSessionOwner, { id: 'c1', engine: 'claude', machine: 'local' });
    assert.equal(cliSessionOwnerMismatch(rec, local), null);
    assert.equal(cliSessionOwnerMismatch(rec, { engine: 'codex' }), 'engine');
    assert.equal(cliSessionOwnerMismatch(rec, {}), 'engine', '没有 engine = kiro');
    assert.equal(cliSessionOwnerMismatch(rec, remote), 'machine');
  });

  test('没记过 / 记的不是当前这个 id → 当不知道（老路：照旧 load）', () => {
    assert.equal(cliSessionOwnerMismatch({ cliSessionId: 'c1' }, { engine: 'codex' }), null);
    const rec: any = { cliSessionId: 'c2', cliSessionOwner: cliSessionOwnerFor('c1', local) };
    assert.equal(validCliSessionOwner(rec), null);
    assert.equal(cliSessionOwnerMismatch(rec, { engine: 'codex' }), null);
    assert.equal(cliSessionOwnerMismatch(null, local), null);
  });

  test('没连着时换引擎 / 机器：改之前按旧 profile 记下；换过去又换回来仍认得', () => {
    const rec: any = { cliSessionId: 'k1', profile: {} };   // 老记录：kiro、本机、没记过
    pinCliSessionOwnerBeforeRetarget(rec);
    rec.profile = { engine: 'claude' };
    assert.equal(cliSessionOwnerMismatch(rec, rec.profile), 'engine');
    pinCliSessionOwnerBeforeRetarget(rec);                 // 再换一次（claude → kiro）：已有算数的那笔，不改
    rec.profile = {};
    assert.equal(cliSessionOwnerMismatch(rec, rec.profile), null, '换回发 id 的那一家：照常 load');
    const r2: any = { cliSessionId: 'c1', profile: local };
    pinCliSessionOwnerBeforeRetarget(r2);
    r2.profile = remote;
    assert.equal(cliSessionOwnerMismatch(r2, r2.profile), 'machine');
  });

  test('机器按 sshHost + 端口认：同一地址不同端口是两台；省略端口 = 22', () => {
    const at = (sshPort?: number) => ({ engine: 'claude', remote: { sshHost: 'user@gateway', ...(sshPort !== undefined ? { sshPort } : {}) } });
    const rec: any = { cliSessionId: 'c1', profile: at(2201) };
    stampCliSessionOwner(rec, rec.profile);
    assert.equal(cliSessionOwnerMismatch(rec, at(2202)), 'machine');
    assert.equal(cliSessionOwnerMismatch(rec, at(2201)), null);
    const r22: any = { cliSessionId: 'c2', profile: at() };
    stampCliSessionOwner(r22, r22.profile);
    assert.equal(cliSessionOwnerMismatch(r22, at(22)), null);
    assert.equal(cliSessionOwnerMismatch(r22, at(2201)), 'machine');
    const rec22: any = { cliSessionId: 'c3', profile: at(22) };
    stampCliSessionOwner(rec22, rec22.profile);
    assert.equal(cliSessionOwnerMismatch(rec22, at()), null);
    /* 换机器的休眠分支只改了端口：也算换了机器 */
    const pin: any = { cliSessionId: 'c4', profile: at(2201) };
    pinCliSessionOwnerBeforeRetarget(pin);
    pin.profile = at(2202);
    assert.equal(cliSessionOwnerMismatch(pin, pin.profile), 'machine');
  });

  test('S3 合并：那笔跟着本地的 id 走，不抄另一台的', () => {
    const l = { id: 's', updatedAt: 1, cliSessionId: 'a', cliSessionOwner: { id: 'a', engine: 'claude', machine: 'local' } };
    const r = { id: 's', updatedAt: 2, cliSessionId: 'b', cliSessionOwner: { id: 'b', engine: 'codex', machine: 'local' } };
    assert.deepEqual(mergeRecords(l, r).cliSessionOwner, l.cliSessionOwner);
    assert.equal('cliSessionOwner' in mergeRecords({ id: 's', updatedAt: 1 }, r), false);
  });

  test('attach：对不上就不 load，直接 session/new 并标成欠上下文（快照随下一条）', () => {
    const body = slice(M, 'const skipResume = engineOf(profile) !== \'kiro\' && historyBytes === 0;', 2600);
    assert.match(body, /const ownerMismatch = skipResume \? null : cliSessionOwnerMismatch\(existing, profile\);/);
    const branch = body.slice(body.indexOf('} else if (ownerMismatch) {'), body.indexOf('} else try {'));
    assert.ok(branch.length > 0, '没有对不上那条分支');
    assert.match(branch, /cliSessionId = \(await client\.newSession\(cliCwd\)\)\.sessionId;/);
    assert.match(branch, /freshBackend = true;/);
    assert.doesNotMatch(branch, /loadSession|tryResume/);
  });

  test('没连着的换引擎 / 换机器两条分支：改 profile 之前先记下', () => {
    const eng = slice(M, 'const switchEngineImpl = async (', 2000);
    const e1 = eng.indexOf('pinCliSessionOwnerBeforeRetarget(rec0);');
    assert.ok(e1 > 0 && e1 < eng.indexOf('rec0.profile = reshape(rec0.profile);'));
    const tgt = slice(M, 'const applySessionTarget = async (', 6000);
    const t1 = tgt.indexOf('pinCliSessionOwnerBeforeRetarget(rec);');
    assert.ok(t1 > 0 && t1 < tgt.indexOf('rec.profile = { ...rec.profile, remote: target ? { ...target } : undefined } as AgentProfile;'));
  });

  test('写 cliSessionId 的地方都一起记上', () => {
    const writes = M.match(/rec2?\.cliSessionId = [^;]+;/g) || [];
    assert.ok(writes.length >= 10);
    const stamped = M.match(/rec2?\.cliSessionId = [^;]+; stampCliSessionOwner\(rec2?, rec2?\.profile\);/g) || [];
    assert.equal(stamped.length, writes.length);
  });
});

describe('2.1 一轮结束 / 停止 / 断线时收掉还挂着的权限卡片', () => {
  test('纯函数：去掉那条会话的卡片；没有就原样返回', () => {
    const cards = { a: { requestId: 1 }, b: { requestId: 2 } };
    assert.deepEqual(withoutPermissionCard(cards, 'a'), { b: { requestId: 2 } });
    assert.equal(withoutPermissionCard(cards, 'x'), cards);
    assert.deepEqual(cards, { a: { requestId: 1 }, b: { requestId: 2 } }, '不改原对象');
  });

  test('接线：这一轮结束、停止（含 stopLoop / 重跑前取消）、接手的那一轮结束、断线', () => {
    assert.match(slice(ACP, 'const finishStreamingTurn = (', 300), /removeStreaming\(sid\);\s*dropPermissionCardIfEnded\(sid\);/);
    assert.match(slice(ACP, 'const stopLoop = useCallback(', 600), /removeStreaming\(sessionId\);\s*dropPermissionCardIfEnded\(sessionId\);/);
    assert.match(ACP, /removeStreaming\(sessionForCancel\);\s*dropPermissionCardIfEnded\(sessionForCancel\);/);
    assert.match(ACP, /\.endAdopted\) \{\s*removeStreaming\(sid\);\s*dropPermissionCardIfEnded\(sid\);/);
    assert.match(slice(ACP, 'const rerunFromMessage = useCallback(', 1200), /removeStreaming\(sid\);\s*dropPermissionCardIfEnded\(sid\);/);
    assert.match(slice(ACP, 'const removeDisconnected = window.kiroApi.onDisconnected(', 600), /setPermissionRequests\(\(current\) => withoutPermissionCard\(current, sid\)\)/);
  });

  test('流转给接手的那一轮时不收（卡片可能是那一轮的）；removeStreaming 本身不收', () => {
    const fn = slice(ACP, 'const dropPermissionCardIfEnded = (', 300);
    assert.match(fn, /if \(!sid \|\| streamingIdsRef\.current\.has\(sid\)\) return;/);
    const rs = ACP.slice(ACP.indexOf('const removeStreaming = (sid: string | null) => {'), ACP.indexOf('const dropPermissionCardIfEnded = ('));
    assert.doesNotMatch(rs, /setPermissionRequests/);
  });

  test('主进程：Claude Code / Codex 最后一轮结束时还挂着的请求清掉，awaitingPermission 复位；kiro 不变', async () => {
    for (const engine of ['claude', 'codex', 'kiro'] as const) {
      const { c, sent } = fakeClient(engine);
      const turn = c.sendPrompt('s', [{ type: 'text', text: 'hi' }]);
      const promptId = sent.find((m) => m.method === 'session/prompt').id;
      c.handleMessage({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
        sessionId: 's', toolCall: { toolCallId: 't' }, options: [{ optionId: 'a', kind: 'allow_once' }],
      } });
      assert.equal(c.awaitingPermission, true);
      c.handleMessage({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      await turn;
      assert.equal(c.awaitingPermission, engine === 'kiro', engine);
    }
  });

  test('主进程：还有别的 prompt 在途时不清（那几个请求可能是它的）', async () => {
    const { c, sent } = fakeClient('claude');
    const t1 = c.sendPrompt('s', [{ type: 'text', text: '1' }]);
    const t2 = c.sendPrompt('s', [{ type: 'text', text: '2' }]);
    const [p1] = sent.filter((m) => m.method === 'session/prompt').map((m) => m.id);
    c.handleMessage({ jsonrpc: '2.0', id: 901, method: 'session/request_permission', params: { sessionId: 's', options: [{ optionId: 'a', kind: 'allow_once' }] } });
    c.handleMessage({ jsonrpc: '2.0', id: p1, result: { stopReason: 'end_turn' } });
    await t1;
    assert.equal(c.awaitingPermission, true);
    void t2;
  });
});

describe('2.4 permissionWaitStartedAt 按「会话 + 请求 id」记', () => {
  test('记和取用的是同一个键函数，键里带会话 id', () => {
    assert.match(M, /const permissionWaitKey = \(sessionId: string, requestId: string\): string => `\$\{sessionId\}:\$\{requestId\}`;/);
    assert.match(M, /permissionWaitStartedAt\.set\(permissionWaitKey\(sessionId, requestKey\), Date\.now\(\)\)/);
    const resp = slice(M, "ipcMain.handle('acp:request-permission-response'", 900);
    assert.match(resp, /const requestKey = permissionWaitKey\(sessionId, String\(requestId \?\? ''\)\);/);
    assert.match(resp, /permissionWaitStartedAt\.get\(requestKey\)/);
    assert.equal((M.match(/permissionWaitStartedAt\.(set|get|delete)\(/g) || []).length, 3);
  });
});

describe('2.5 未知请求的提示说对引擎，写法按 notices-glossary', () => {
  test('Claude Code / Codex / kiro 各说各的名字；⚠️ 开头，后果折进详情', () => {
    for (const [engine, name] of [['claude', 'Claude Code'], ['codex', 'Codex'], ['kiro', 'kiro-cli']] as const) {
      const { c, sent } = fakeClient(engine);
      const errs: any[] = [];
      (c as EventEmitter).on('error', (e: any) => errs.push(e));
      c.handleAgentRequest({ jsonrpc: '2.0', id: 5, method: 'x/ask', params: {} });
      assert.equal(errs.length, 1);
      const { main, detail } = splitNoteDetail(errs[0].message);
      assert.ok(main.startsWith(`⚠️ ${name} `), main);
      assert.match(main, /x\/ask/);
      assert.ok(detail, '后果放进详情');
      assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 5, result: {} }]);
      if (engine !== 'kiro') assert.equal(errs[0].message.includes('kiro-cli'), false);
    }
  });

  test('中文：主句有中文；会话里记一条（acp:error 渲染层只打控制台）', () => {
    const zh = trIn('zh', '⚠️ {engine} sent a request KiroLex does not know (`{method}`) and got an empty answer; please report this to KiroLex.', { engine: 'Codex', method: 'm' });
    assert.ok(zh.startsWith('⚠️ Codex 发来'), zh);
    const on = slice(M, "client.on('error', (error: any) => {", 700);
    assert.match(on, /if \(error\?\.type === 'unknown-request'\) noteInSession\(sessionId, String\(error\.message \|\| ''\), undefined, `unknown-request:\$\{String\(error\.method \|\| ''\)\}`\);/);
  });
});

describe('4.1 组合里的 MCP 没带进远程会话：说一句原因 + 怎么改，同一会话同一个只说一次', () => {
  const combo = {
    web: { url: 'https://x.example/mcp' },                       // http 没标
    tool: { command: 'uvx', args: ['thing'] },                   // stdio：不是本机路径、不在白名单
    marked: { url: 'https://y.example/mcp', forwardFromLocal: true },
    playwright: { command: 'npx', args: ['@playwright/mcp'] },  // 白名单
    off: { url: 'https://z.example/mcp', disabled: true },       // 关掉的不算
    empty: {},                                                    // 起不来的不算
  } as any;

  test('forwardableFromCombo：没被挑中的记进 notForwarded（带类型），挑中的 / 关掉的 / 空的不进', () => {
    const r = forwardableFromCombo(combo, {});
    assert.deepEqual(r.notForwarded, [{ name: 'web', kind: 'http' }, { name: 'tool', kind: 'stdio' }]);
    assert.deepEqual(r.entries.map((e) => e.name), ['marked', 'playwright']);
    assert.deepEqual(r.skipped, []);
  });

  test('adapterForwardPlan 带出来；名单里点了名的算标了，不再报没带上', () => {
    const p = adapterForwardPlan({ comboServers: combo, list: [{ name: 'web', timeoutSec: 180 }], sources: [], env: {} });
    assert.deepEqual(p.notForwarded, [{ name: 'tool', kind: 'stdio' }]);
  });

  test('那一句：⚠️ 主句有名字 + 怎么改，原因进详情（中英都有）', () => {
    for (const kind of ['http', 'stdio'] as const) {
      const text = notForwardedNotice({ name: 'web', kind }, 'Research');
      const { main, detail } = splitNoteDetail(text);
      assert.ok(main.startsWith('⚠️ '));
      assert.match(main, /web/);
      assert.match(main, /forwardFromLocal/);
      assert.ok(detail);
      const zh = trIn('zh', '⚠️ This remote session does not have MCP "{mcp}" from combo "{combo}". To use it, add "forwardFromLocal": true to it in 🧩 Combos and reopen the session.', { mcp: 'web', combo: '投研' });
      assert.match(zh, /没带上组合「投研」的 MCP「web」/);
    }
  });

  test('接线：远程 Claude Code / Codex 那条分支按会话 + 名字只说一次，说成了才记', () => {
    const body = slice(M, 'const { entries, skipped, fromCombo, fromList, notForwarded } = adapterForwardPlan({', 3600);
    const loop = slice(body, 'for (const n of notForwarded) {', 600);
    assert.match(loop, /if \(said\.has\(n\.name\)\) continue;/);
    assert.match(loop, /if \(noteInSession\(sessionId, notForwardedNotice\(n, comboDisplayName\(combo\)\), undefined, `mcp-not-forwarded:\$\{n\.name\}`\)\) \{\s*said\.add\(n\.name\);/);
    assert.match(M, /const notForwardedNoticed = new Map<string, Set<string>>\(\);/);
  });
});

describe('5.1 控制入口 / session_send 的 auto 发给正在跑、不能 steer 的会话 → 自动排进 KiroLex 队列', () => {
  test('判据：在跑 + 不能 steer → queue（不是 steer、不标红）；能 steer 的照旧 steer', () => {
    const base = { streaming: true, busy: 'turn', occupied: true, looping: false, next: false };
    assert.equal(enterRoute({ ...base, canSteer: busyEnterKind('claude', 'queue') !== 'queue' }), 'queue');
    assert.equal(enterRoute({ ...base, canSteer: busyEnterKind('codex', undefined) !== 'queue' }), 'queue', '还没拿到能力声明：按引擎兜底，也排队');
    assert.equal(enterRoute({ ...base, canSteer: busyEnterKind('claude', 'steering') !== 'queue' }), 'steer');
    assert.equal(enterRoute({ ...base, canSteer: busyEnterKind('kiro', undefined) !== 'queue' }), 'steer');
  });

  test('接线：route=queue 交给 handleQueueMessage，它一决定就回 {routed:\'queued\'}', () => {
    const ctl = slice(APP, 'const handleControlSend = useCallback(', 2600);
    assert.match(ctl, /canSteer: busyEnterKind\(session\.engine, busyEnter\) !== 'queue'/);
    assert.match(ctl, /: route === 'queue' \? handleQueueMessage\(req\.text, undefined, sid, ctl\)/);
    const q = slice(APP, 'const handleQueueMessage = useCallback(', 1200);
    assert.match(q, /ctl\?\.report\(\{ routed: 'queued', messageId: item\.id \}\);/);
  });

  test('先试了 steer 才被拒 unsupported 的兜底也是排队、回 queued，不标红（addFailedSteer 之前）', () => {
    const steer = APP.slice(APP.indexOf('const handleSteerMessage = useCallback('), APP.indexOf('const handleQueueMessage = useCallback('));
    const qa = slice(steer, 'const queueAsNext = () => {', 500);
    assert.match(qa, /ctl\?\.report\(\{ routed: 'queued', messageId: queuedId \}\);/);
    const fallback = steer.indexOf("if (route === 'queue') { queueAsNext(); return; }");
    assert.ok(fallback > 0 && fallback < steer.indexOf('addFailedSteer('));
  });

  test('输入框按 Enter 的语义不变：ChatInputBox 运行中仍走 onSteer（AGENTS.md §4.2）', () => {
    assert.match(APP, /isStreaming=\{!!sid && composerRunning\(streamingIds\.includes\(sid\), busyBySession\[sid\]\)\}/);
  });
});
