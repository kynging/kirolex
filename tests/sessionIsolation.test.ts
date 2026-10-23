import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/*
  会话串台排查（docs/session-isolation-audit.md）的回归测试。

  这几处都在 useAcp.ts / App.tsx / ChatArea.tsx / index.ts 里，测试 import 不了，所以按惯例做源码扫描：
  锚定那个函数，截一段，断言「按目标会话写」而不是「按当前焦点写」。每条都写明串台是怎么发生的。
*/
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
const H = read('renderer', 'hooks', 'useAcp.ts');
const A = read('renderer', 'App.tsx');
const C = read('renderer', 'components', 'ChatArea.tsx');
const M = read('main', 'index.ts');

/** 从 anchor 开始截到下一个 `const X = useCallback(` / 顶层函数为止 */
function sliceFrom(src: string, anchor: string, end: RegExp = /\n  const \w+ = useCallback\(|\nfunction |\nasync function /): string {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `找不到锚点：${anchor}`);
  const rest = src.slice(at + anchor.length);
  const m = end.exec(rest);
  return src.slice(at, at + anchor.length + (m ? m.index : rest.length));
}

const rerun = sliceFrom(H, 'const rerunFromMessage = useCallback(');
const send = sliceFrom(H, 'const sendMessage = useCallback(');

test('编辑重跑 / 自动重发：截短后的视图按目标会话写，不落到当前焦点那一格', () => {
  /*
    自动重发（recoverInterruptedTurn → rerunFromMessage(…, sid)）对的常常是**后台**那条会话。
    原来这里是 `setMessages(retained)`：setMessages 写的是焦点会话的 messages，并把归属记成焦点会话，
    于是焦点那条的界面被换成了另一条的历史，缓存 effect 再把它存成焦点会话的。
  */
  assert.doesNotMatch(rerun, /^\s*setMessages\(/m, 'rerunFromMessage 里不能再有按焦点写的 setMessages');
  assert.match(rerun, /mutateSessionMessages\(sid, \(\) => retained\)/);
  assert.match(rerun, /mutateSessionMessages\(sid, \(\) => current\)/);
  /* 全局的工具调用表只在重跑的就是焦点会话时清：后台会话重跑不能清掉正在流式的焦点会话的工具卡片 */
  assert.match(rerun, /if \(sid === currentSessionRef\.current\) \{\s*currentMessageRef\.current = '';\s*toolCallsRef\.current\.clear\(\);/);
});

test('发送重试失败的错误气泡写进目标会话，不是当前焦点', () => {
  assert.doesNotMatch(send, /\bsetMessages\(\(prev\)/, '重试失败那段不能再按焦点 setMessages');
  assert.match(send, /mutateSessionMessages\(sid!, \(prev\) => \[\s*\.\.\.prev,\s*\{ id: `err_/);
});

test('跨会话上下文链接只在「pending → 真 id」时搬家，不把焦点会话的链接搬给别的会话', () => {
  /*
    原条件是 `currentSessionId && currentSessionId !== sid && links.has(currentSessionId)`：
    分屏里给另一格（或后台排队 / 控制入口）发消息时 sid ≠ 焦点，焦点会话的上下文链接就被整份搬到了那一条上。
  */
  assert.match(send, /const originSid = sid;/);
  assert.match(send, /if \(originSid && originSid !== sid && contextLinksRef\.current\.has\(originSid\)\)/);
  assert.doesNotMatch(send, /contextLinksRef\.current\.has\(currentSessionId\)/);
});

test('复制出来的会话首条消息建好真会话后：你已经切走了就不抢焦点', () => {
  /*
    newSession 要等几秒（远程更久）。期间切到 C，原来这里照样 `currentSessionRef.current = sid; setCurrentSessionId(sid)`，
    而 messages 还是 C 的 —— 第一个 chunk 一到，C 的消息加 chunk 就被记成新会话的（见 messagesOwner）。
  */
  const at = send.indexOf('await window.kiroApi.newSession(');
  const block = send.slice(at, at + 3000);
  assert.match(block, /const stillViewing = \(currentSessionRef\.current \|\| null\) === \(prevId \|\| null\);/);
  assert.match(block, /if \(stillViewing\) \{\s*currentSessionRef\.current = sid;\s*setCurrentSessionId\(sid\);\s*\}/);
  const join = send.slice(send.indexOf('creatingRef.current.has(pendingId)'), send.indexOf('await window.kiroApi.newSession('));
  assert.match(join, /if \(currentSessionRef\.current === pendingId\) \{\s*currentSessionRef\.current = sid;\s*setCurrentSessionId\(sid\);\s*\}/);
});

test('/stop、/usage 的回显发给敲命令的那一格（await 之后不落回焦点）', () => {
  const h = sliceFrom(A, 'const handleSendMessage = useCallback(');
  assert.match(h, /sendMessage\(\[\{ type: 'text', text: '\/stop' \}\], '🔄 Force interrupted and reconnected\.', undefined, undefined, undefined, sid \|\| undefined\)/);
  assert.match(h, /sendMessage\(\[\{ type: 'text', text: '\/usage' \}\], result\.text, undefined, undefined, undefined, sid \|\| undefined\)/);
  assert.match(h, /sendMessage\(\[\{ type: 'text', text: '\/usage' \}\], tRef\.current\('Failed to fetch usage info'\), undefined, undefined, undefined, sid \|\| undefined\)/);
});

test('非焦点那一格发消息不带焦点会话的模型', () => {
  /*
    `selectedModel` 跟着焦点会话走，而且是 await focusSession 之前的闭包值。带着它发，
    重连重试那条路 `loadSession(sid, cwd, activeModel)` 会把 B 挂到 A 的模型上。
  */
  const h = sliceFrom(A, 'const handleSendMessage = useCallback(');
  assert.match(h, /sid && sid !== currentSessionId \? undefined : selectedModel,/);
});

test('粘贴大段文字：await 期间这一格换了会话，占位符写回原会话的草稿，不进新会话的输入框', () => {
  const at = C.indexOf('const saved = await window.kiroApi.savePasteText?.(text);');
  const handler = C.slice(C.lastIndexOf('const insert = (piece: string) => {', at) - 400, at);
  assert.match(handler, /const pasteSid = sessionId;/);
  assert.match(handler, /if \(draftSessionRef\.current !== pasteSid\) \{[\s\S]*?stashComposerDraft\(pasteSid,[\s\S]*?return;\s*\}/);
});

test('Claude Code / Codex 的模型 / 组合下拉：迟到的结果不写进已经换掉的会话', () => {
  const eff = C.slice(C.indexOf('setEngineModels(null);\n'), C.indexOf('type McpComboList'));
  assert.match(eff, /let alive = true;/);
  assert.match(eff, /if \(alive && d\) setEngineModels\(d\)/);
  assert.match(eff, /alive = false;/);
  const opt = C.slice(C.indexOf('const onEngineOptionChange = async'), C.indexOf('const onEngineOptionChange = async') + 1200);
  assert.match(opt, /const sid = currentSessionId;/);
  assert.match(opt, /runSessionRequest\(sid, 'engine', setRequestStatus,/);
  assert.match(opt, /if \(d && !d\.pending && engineSidRef\.current === sid\) setEngineModels\(d\)/);
  const combo = C.slice(C.indexOf('const onMcpComboChange = async'), C.indexOf('const onMcpComboChange = async') + 1000);
  assert.match(combo, /const sid = currentSessionId;/);
  assert.match(combo, /runSessionRequest\(sid, 'combo', setRequestStatus,/);
  assert.match(combo, /if \(!d\?\.pending && engineSidRef\.current === sid\)/);
  /* 忙 / 失败原因只读当前会话那一份；不再有整格共用的 busy / err 状态 */
  assert.match(C, /const \{ engineBusy: engineModelBusy, comboBusy: mcpComboBusy, err: engineModelErr \} = statusFor\(requestStatus, currentSessionId\);/);
  assert.doesNotMatch(C, /setEngineModelErr\(|setEngineModelBusy\(|setMcpComboBusy\(/);
});

test('Claude Code / Codex 下拉：A 发起切换 → 这一格换成 B → A 的请求失败 —— 错误和忙状态都留在 A，不出现在 B', async () => {
  const { runSessionRequest, statusFor } = await import('../src/renderer/sessionRequestStatus.ts');
  /* 模拟 ChatArea：一格、一份按会话记的状态；current 是这一格此刻显示的会话 */
  let map = {};
  const update = (fn: (m: any) => any) => { map = fn(map); };
  let current = 'A';
  const shownModels: string[] = [];
  let reject!: (e: Error) => void;
  const pendingA = new Promise<any>((_, rej) => { reject = rej; });
  const reqA = runSessionRequest('A', 'engine', update, () => pendingA,
    () => { if (current === 'A') shownModels.push('A'); },
    (e) => String((e as any)?.message || e));
  assert.equal(statusFor(map, 'A').engineBusy, true, 'A 发起后 A 显示忙');
  current = 'B';                                   // 等待期间切到 B
  assert.deepEqual(statusFor(map, current), { engineBusy: false, comboBusy: false, err: '' }, 'B 不该显示 A 的忙');
  reject(new Error('Error invoking remote method: A 的模型不存在'));
  await reqA;
  assert.deepEqual(statusFor(map, current), { engineBusy: false, comboBusy: false, err: '' }, 'A 的失败不能显示在 B 上');
  assert.equal(shownModels.length, 0);
  current = 'A';                                   // 切回 A：A 的错误原样回来
  assert.match(statusFor(map, current).err, /A 的模型不存在/);
  assert.equal(statusFor(map, current).engineBusy, false);
});

test('Claude Code / Codex 下拉：B 自己的请求照常显示忙和错误；A 晚到的成功不会清掉 B 的状态', async () => {
  const { runSessionRequest, statusFor } = await import('../src/renderer/sessionRequestStatus.ts');
  let map = {};
  const update = (fn: (m: any) => any) => { map = fn(map); };
  let resolveA!: (v: any) => void;
  const reqA = runSessionRequest('A', 'combo', update, () => new Promise((r) => { resolveA = r; }), () => {}, String);
  let rejectB!: (e: Error) => void;
  const reqB = runSessionRequest('B', 'engine', update, () => new Promise((_, rej) => { rejectB = rej; }), () => {}, (e) => (e as Error).message);
  assert.equal(statusFor(map, 'B').engineBusy, true);
  assert.equal(statusFor(map, 'B').comboBusy, false, 'A 的组合切换不算 B 的');
  resolveA({ current: 'x' });
  await reqA;
  assert.equal(statusFor(map, 'B').engineBusy, true, 'A 结束不能把 B 的忙清掉');
  rejectB(new Error('B 失败'));
  await reqB;
  assert.equal(statusFor(map, 'B').err, 'B 失败');
  assert.equal(statusFor(map, 'A').err, '');
});

test('主进程：被换下来的执行器（换机器 / 换引擎 / 换组合 / 换 agent）的迟到事件一律丢掉', () => {
  /*
    换机器那几条路是「先 await 旧的 disconnect，再 set 新的」：旧进程的 close → 'disconnected' 发生时
    map 里还是旧 entry，身份守卫放行 —— 于是删掉 entry、记录写成 detached、给渲染层发 acp:disconnected，
    远程会话还会对着**旧那台机器**起断线恢复。迟到的 update 也照样当成这条会话的流式输出发出去。
  */
  assert.match(M, /const retiringClients = new WeakSet<AcpClient>\(\);/);
  assert.match(M, /async function retireExecutor\(client: AcpClient\): Promise<void> \{\s*retiringClients\.add\(client\);\s*await client\.disconnect\(\);\s*\}/);
  const wire = sliceFrom(M, 'function wireSession(sessionId: string, entry: SessionEntry) {', /\n\/\*\* Flush the accumulated/);
  assert.match(wire, /const superseded = \(\) => retiringClients\.has\(client\) \|\| sessionClients\.get\(sessionId\)\?\.client !== client;/);
  const upd = wire.slice(wire.indexOf("client.on('update'"));
  assert.ok(upd.indexOf('if (superseded()) return;') >= 0 && upd.indexOf('if (superseded()) return;') < upd.indexOf('if (entry.priming) return;'),
    "update 处理一开头就要丢掉被换下来的执行器的事件");
  const err = wire.slice(wire.indexOf("client.on('error'"), wire.indexOf("client.on('disconnected'"));
  assert.match(err, /if \(superseded\(\)\) return;/);
  const disc = wire.slice(wire.indexOf("client.on('disconnected'"));
  assert.match(disc, /if \(sessionClients\.get\(sessionId\) !== entry \|\| retiringClients\.has\(client\)\) return;/);
  /* 所有「换执行器」的地方都走 retireExecutor，不再裸调旧 client 的 disconnect */
  assert.equal((M.match(/await oldEntry\.client\.disconnect\(\)/g) || []).length, 0);
  assert.ok((M.match(/await retireExecutor\(oldEntry\.client\)/g) || []).length >= 4);
});

test('主进程：会话记忆整理完成时会话已删就不写；只补 memoryConsolidatedAt，不拿旧记录整份覆盖', () => {
  const f = sliceFrom(M, 'async function maybeConsolidateSessionMemory(sessionId: string): Promise<void> {');
  const after = f.slice(f.indexOf('await runLiteOneShot('));
  assert.match(after, /if \(deletedSessionIds\.has\(sessionId\) \|\| !store\.readRecord\(sessionId\)\) return;/);
  assert.ok(after.indexOf('deletedSessionIds.has(sessionId)') < after.indexOf('writeMemory('));
  assert.match(after, /store\.patchRecord\(sessionId, \{ memoryConsolidatedAt: messages\.length \} as any\);/);
  assert.doesNotMatch(after, /store\.writeRecord\(\{ \.\.\.record/);
});

/* ---------- 没发现问题的路径：用测试把「按 id 走」钉住 ---------- */

test('后台唤醒：两条会话同时有后台任务，结果各回各的（真起进程）', async () => {
  const { BgJobManager } = await import('../src/main/bgJobs.ts');
  const wakes: Array<{ sessionId: string; text: string }> = [];
  const m = new BgJobManager({
    wake: (sessionId, text) => { wakes.push({ sessionId, text }); },
    note: () => {}, changed: () => {}, log: () => {},
  });
  const node = `"${process.execPath}"`;
  const run = (sid: string, ms: number, word: string) => m.start({
    sessionId: sid, kind: 'run', command: `${node} -e "setTimeout(()=>console.log('${word}'),${ms})"`, label: word, cwd: process.cwd(), timeoutMs: 300_000,
  });
  try {
    /* A 的任务后结束、B 的先结束：交错着回来 */
    const a = run('sA', 600, 'from-A');
    const b = run('sB', 100, 'from-B');
    assert.ok(a.ok && b.ok);
    /* 上限按看板那台 Windows 机给足（作业对象辅助进程 PowerShell + Add-Type 冷启动 8 s 起、忙时 15 s+）；超时说清卡在哪 */
    const start = Date.now();
    const limit = 120_000;
    while (wakes.length < 2) {
      if (Date.now() - start > limit) {
        assert.fail(`等不到两条唤醒（等了 ${Date.now() - start} ms，上限 ${limit} ms）；已到 ${wakes.length} 条：`
          + JSON.stringify({ wakes: wakes.map((w) => w.sessionId), A: m.status('sA', (a as any).job.jobId), B: m.status('sB', (b as any).job.jobId) }));
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    for (const w of wakes) {
      assert.equal(w.sessionId, /from-A/.test(w.text) ? 'sA' : 'sB', `唤醒 ${w.text.slice(0, 40)} 回错了会话`);
    }
    /* 互相看不到、停不了对方的任务 */
    assert.equal(m.status('sB', (a as any).job.jobId), null);
    assert.equal(m.status('sA', (b as any).job.jobId), null);
  } finally {
    await m.stopAll();
  }
});

test('后台唤醒：一条忙、一条闲 —— 闲的那条立刻发、忙的那条等它自己这一轮结束，谁都不会发进对方', async () => {
  const { WakeDispatcher } = await import('../src/main/wakeQueue.ts');
  const busy = new Set<string>(['sA']);
  const delivered: string[] = [];
  const d = new WakeDispatcher({
    isBusy: (sid) => busy.has(sid),
    deliver: async (item) => { delivered.push(`${item.sessionId}:${item.text}`); },
    isBusyError: () => false,
    pollMs: 5,
  });
  const pa = d.enqueue({ sessionId: 'sA', text: 'a1', at: 1, source: 'bg' });
  await d.enqueue({ sessionId: 'sB', text: 'b1', at: 2, source: 'bg' });
  assert.deepEqual(delivered, ['sB:b1']);
  busy.delete('sA');
  await pa;
  assert.deepEqual(delivered, ['sB:b1', 'sA:a1']);
});

test('后台唤醒接线：投递只认 item.sessionId（不看焦点、不看后端会话 id）', () => {
  const at = M.indexOf('wakeDeliver = async (item) => {');
  assert.ok(at >= 0);
  const body = M.slice(at, at + 600);
  assert.match(body, /const sid = item\.sessionId;/);
  assert.match(body, /await ensureAttached\(sid\);/);
});

test('控制入口接线：/sessions/:id/send 一路带 id 到渲染端，渲染端用 req.sessionId 分流（不用焦点）', () => {
  const full = sliceFrom(A, 'const handleControlSend = useCallback(');
  const h = full.slice(0, full.indexOf('\n  }, ['));
  assert.match(h, /const sid = req\.sessionId;/);
  assert.match(h, /handleSteerMessage\(req\.text, undefined, sid, ctl\)/);
  assert.match(h, /handleQueueMessage\(req\.text, undefined, sid, ctl\)/);
  assert.match(h, /sendNowOrNext\(sid, req\.text/);
  assert.doesNotMatch(h, /currentSessionId/);
});

test('流式事件：主进程每条 acp:update 都带闭包里的 sessionId；渲染端按事件里的 sessionId 落地', () => {
  assert.match(M, /mainWindow\?\.webContents\.send\('acp:update', \{ \.\.\.data, sessionId,/);
  const on = H.slice(H.indexOf('onUpdate('), H.indexOf('onUpdate(') + 1500);
  assert.match(on, /const \{ update, sessionId \} = data;[\s\S]*let targetSid = sessionId;/);
  /* 没带 id 时也不猜「当前焦点」：只有恰好一条在流式时才归它，否则丢掉 */
  assert.match(on, /const isActiveSession = targetSid === currentSessionRef\.current;/);
  assert.doesNotMatch(on.slice(0, on.indexOf('const isActiveSession')), /targetSid = currentSessionRef/);
});
