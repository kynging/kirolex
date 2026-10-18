import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PendingSwitchBook,
  PendingSwitchRunner,
  runPendingSwitches,
  isReconnectKind,
  withEngineOption,
  shouldQueueSwitch,
  type PendingSwitch,
} from '../src/main/pendingSwitch.ts';

const sw = (kind: PendingSwitch['kind'], value: any, label = String(value)): PendingSwitch => ({ kind, value, label });

describe('PendingSwitchBook：忙时切换先记下来', () => {
  test('同一类切换多次只保留最后一次', () => {
    const book = new PendingSwitchBook();
    book.set('s1', sw('agent', 'a1'));
    book.set('s1', sw('agent', 'a2'));
    book.set('s1', sw('agent', 'a3'));
    const taken = book.take('s1');
    assert.equal(taken.length, 1);
    assert.equal(taken[0].value, 'a3');
    assert.equal(book.has('s1'), false, 'take 之后就清空了');
  });

  test('不同会话互不影响；取消只去掉那一类', () => {
    const book = new PendingSwitchBook();
    book.set('s1', sw('agent', 'a'));
    book.set('s1', sw('model', 'm'));
    book.set('s2', sw('model', 'x'));
    assert.equal(book.cancel('s1', 'agent'), true);
    assert.deepEqual(book.view('s1'), { model: 'm' });
    assert.deepEqual(book.view('s2'), { model: 'x' });
    assert.equal(book.cancel('s1', 'agent'), false, '已经没有了');
    book.cancel('s1');
    assert.equal(book.has('s1'), false, '不给 kind 就整条取消');
  });

  test('take 按依赖顺序给出：运行位置 / 引擎先于 agent / 模型 / 组合，权限等即时项最后', () => {
    const book = new PendingSwitchBook();
    book.set('s', sw('permission', 'ask'));
    book.set('s', sw('model', 'm'));
    book.set('s', sw('agent', 'a'));
    book.set('s', sw('engineModel', 'opus'));
    book.set('s', sw('engine', 'kiro'));
    book.set('s', sw('remote', 'box'));
    book.set('s', sw('combo', 'c'));
    const kinds = book.take('s').map((e) => e.kind);
    assert.deepEqual(kinds.slice(0, 5), ['remote', 'engine', 'combo', 'agent', 'model']);
    assert.ok(kinds.slice(5).every((k) => !isReconnectKind(k)));
    assert.equal(kinds.indexOf('permission') > kinds.indexOf('model'), true);
  });
});

describe('runPendingSwitches：多类合并只重连一次', () => {
  test('换 agent + 换模型 + 换权限：只重连一次，模型随 agent 那次一起带过去', async () => {
    const reconnects: Array<{ kind: string; carry: string[] }> = [];
    const instants: string[] = [];
    const report = await runPendingSwitches(
      [sw('agent', 'a'), sw('model', 'm'), sw('permission', 'ask')],
      {
        reconnect: async (e, carry) => { reconnects.push({ kind: e.kind, carry: carry.map((c) => c.kind) }); return {}; },
        instant: async (e) => { instants.push(e.kind); },
      },
    );
    assert.equal(report.reconnects, 1);
    assert.deepEqual(reconnects, [{ kind: 'agent', carry: ['model'] }]);
    assert.deepEqual(instants, ['permission']);
    assert.deepEqual(report.applied.sort(), ['agent', 'model', 'permission'].sort());
    assert.deepEqual(report.failed, []);
  });

  test('排在前面的那一类其实没变（unchanged）→ 由下一类来重连，并把剩下的带上', async () => {
    const calls: string[] = [];
    const report = await runPendingSwitches(
      [sw('engine', 'kiro'), sw('agent', 'a'), sw('model', 'm')],
      {
        reconnect: async (e, carry) => { calls.push(`${e.kind}+${carry.map((c) => c.kind).join(',')}`); return e.kind === 'engine' ? { unchanged: true } : {}; },
        instant: async () => {},
      },
    );
    assert.deepEqual(calls, ['engine+agent,model', 'agent+model']);
    assert.equal(report.reconnects, 1);
    assert.deepEqual(report.unchanged, ['engine']);
  });

  test('带不过去（会话没连着，carried:false）→ 剩下的逐个应用', async () => {
    const calls: string[] = [];
    await runPendingSwitches([sw('agent', 'a'), sw('model', 'm')], {
      reconnect: async (e) => { calls.push(e.kind); return { carried: false }; },
      instant: async () => {},
    });
    assert.deepEqual(calls, ['agent', 'model']);
  });

  test('某一类失败：记下失败原因，剩下的照样尝试，不抛', async () => {
    const calls: string[] = [];
    const report = await runPendingSwitches([sw('remote', 'box'), sw('agent', 'a'), sw('permission', 'ask')], {
      reconnect: async (e) => { calls.push(e.kind); if (e.kind === 'remote') throw new Error('连不上'); return {}; },
      instant: async (e) => { calls.push(e.kind); },
    });
    assert.deepEqual(calls, ['remote', 'agent', 'permission']);
    assert.deepEqual(report.failed, [{ kind: 'remote', label: 'box', error: '连不上' }]);
    assert.deepEqual(report.applied.sort(), ['agent', 'permission']);
  });
});

/** 一个可控的"会话"：busy 由测试切换，apply 记录调用并可以挂起。 */
function harness() {
  const book = new PendingSwitchBook();
  const state = { busy: true };
  const applied: string[][] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const runner = new PendingSwitchRunner(book, {
    isBusy: () => state.busy,
    apply: async (_sid, entries) => {
      applied.push(entries.map((e) => `${e.kind}=${e.value}`));
      if (hold) await new Promise<void>((r) => { release = r; });
    },
  });
  return {
    book, state, applied, runner,
    holdNext() { hold = true; },
    release() { hold = false; release?.(); },
  };
}

describe('PendingSwitchRunner：这一轮跑完才切', () => {
  test('忙时 kick 不动；turn 结束（busy 变 false）再 kick 才应用', async () => {
    const h = harness();
    h.book.set('s', sw('agent', 'a'));
    assert.equal(h.runner.kick('s'), undefined, '还在忙，不应用');
    assert.deepEqual(h.applied, []);
    h.state.busy = false;
    await h.runner.kick('s');
    assert.deepEqual(h.applied, [['agent=a']]);
    assert.equal(h.book.has('s'), false);
  });

  test('没有 pending 时 kick 什么都不做（不忙时的立即切换不受影响）', () => {
    const h = harness();
    h.state.busy = false;
    assert.equal(h.runner.kick('s'), undefined);
    assert.deepEqual(h.applied, []);
  });

  test('pending 期间来了新消息：settle 先把 pending 应用完再放行', async () => {
    const h = harness();
    h.book.set('s', sw('agent', 'a'));
    h.state.busy = false; // 这一轮刚结束，turn 结束的 kick 还没来得及跑
    const order: string[] = [];
    await h.runner.settle('s').then(() => order.push('send'));
    assert.deepEqual(h.applied, [['agent=a']]);
    assert.deepEqual(order, ['send']);
  });

  test('settle 会等在飞的那次应用结束', async () => {
    const h = harness();
    h.book.set('s', sw('model', 'm'));
    h.state.busy = false;
    h.holdNext();
    h.runner.kick('s');
    assert.equal(h.runner.isApplying('s'), true);
    let sent = false;
    const p = h.runner.settle('s').then(() => { sent = true; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent, false, '切换还没完成，新消息不能先发');
    h.release();
    await p;
    assert.equal(sent, true);
  });

  test('应用期间又选了一次：这次跑完接着应用新的那一次', async () => {
    const h = harness();
    h.book.set('s', sw('agent', 'a'));
    h.state.busy = false;
    h.holdNext();
    const first = h.runner.kick('s')!;
    h.book.set('s', sw('agent', 'b'));
    h.release();
    await first;
    await h.runner.settle('s');
    assert.deepEqual(h.applied, [['agent=a'], ['agent=b']]);
  });

  test('取消 pending 之后 turn 结束不再应用', async () => {
    const h = harness();
    h.book.set('s', sw('agent', 'a'));
    h.book.cancel('s', 'agent');
    h.state.busy = false;
    assert.equal(h.runner.kick('s'), undefined);
    assert.deepEqual(h.applied, []);
  });

  test('apply 抛错不会让 settle 卡住或抛出', async () => {
    const book = new PendingSwitchBook();
    const runner = new PendingSwitchRunner(book, { isBusy: () => false, apply: async () => { throw new Error('boom'); } });
    book.set('s', sw('agent', 'a'));
    await runner.settle('s');
    assert.equal(book.has('s'), false);
  });
});

/* ---------- 接线（index.ts 不能 import，按源码扫描） ---------- */
const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
const sliceFrom = (anchor: string, len = 4000) => {
  const i = M.indexOf(anchor);
  assert.ok(i >= 0, `找不到 ${anchor}`);
  return M.slice(i, i + len);
};

describe('接线：每一种切换忙时登记 pending、不再 throw', () => {
  test('不再有"等这一轮结束再切"的拒绝', () => {
    for (const msg of [
      'Wait for the current response to finish before switching agents.',
      'Wait for the current response to finish before switching models.',
      'This turn is still running. Wait for it to finish before switching engines.',
      'This turn is still running. Wait for it to finish before switching combos.',
      'Wait for this reply to finish before switching.',
    ]) assert.equal(M.includes(`throw new Error(tr('${msg}'))`), false, msg);
  });

  test('各入口在忙时调 queueSwitchWhileBusy', () => {
    const anchors: Array<[string, string]> = [
      ['const switchModelImpl = async', "'model'"],
      ['const switchKiroAgentImpl = async', "'agent'"],
      ['const switchPermissionModeImpl = async', "'permission'"],
      ['const switchEngineImpl = async', "'engine'"],
      ['const switchMcpComboImpl = async', "'combo'"],
      ['const setEngineOption = async', 'engineKindFor(category)'],
      ["ipcMain.handle('acp:set-remote-target'", "'remote'"],
    ];
    for (const [anchor, kind] of anchors) {
      const body = sliceFrom(anchor, 6000);
      const q = body.indexOf('queueSwitchWhileBusy(');
      assert.ok(q >= 0, `${anchor} 没有接 queueSwitchWhileBusy`);
      assert.ok(body.slice(q, q + 200).includes(kind), `${anchor} 登记的类型应是 ${kind}`);
    }
  });

  test('轮次结束（正常 / 出错 / Stop 都走 sendPromptOnce 的 finally）触发应用', () => {
    const fin = sliceFrom("consumePendingProjectReset(sessionId, '本轮报错结束", 400);
    assert.ok(fin.includes('pendingSwitchRunner.kick(sessionId)'), 'finally 里要 kick');
  });

  test('发送前先应用 pending（新消息用新的 agent / 模型）', () => {
    const head = sliceFrom('async function sendPromptOnce(', 1500);
    assert.ok(/attempt === 0\)\s*await pendingSwitchRunner\.settle\(sessionId\)/.test(head), 'sendPromptOnce 开头要 settle');
    assert.ok(head.indexOf('pendingSwitchRunner.settle') < head.indexOf('let entry = sessionClients.get(sessionId)'), '要在取 entry 之前');
  });

  test('有取消 pending 的 IPC，preload 也接上了', () => {
    assert.ok(M.includes("ipcMain.handle('acp:cancel-pending-switch'"));
    assert.ok(M.includes("ipcMain.handle('acp:get-pending-switches'"));
    const P = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'preload.ts'), 'utf-8');
    assert.ok(P.includes("'acp:cancel-pending-switch'"));
    assert.ok(P.includes("'acp:get-pending-switches'"));
    assert.ok(P.includes("'acp:pending-switches'"));
  });

  test('退出应用时把 pending 写进记录（下次挂起按记录起），删会话时丢掉', () => {
    assert.ok(/before-quit[\s\S]{0,200}persistPendingSwitchesOnQuit/.test(M));
    assert.ok(/pendingSwitches\.cancel\(sessionId\)/.test(M));
  });
});

describe('接线：界面忙时可选，显示「⏳ 这一轮跑完后切换」并能取消', () => {
  const C = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf-8');
  const A = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf-8');
  test('agent / 模型下拉：显示 pending 的值，回复中不再禁用，旁边有 ⏳ 徽标', () => {
    assert.ok(C.includes('value={pendingSwitch?.agent ?? kiroAgent}'));
    assert.ok(C.includes('value={pendingSwitch?.model ?? selectedModel}'));
    assert.ok(C.includes("onCancelPendingSwitch?.('agent')"));
    assert.ok(!C.includes('disabled={!currentSessionId || isStreaming || isLooping || switchingAgent'), 'agent 下拉不该因回复中禁用');
    assert.ok(!C.includes('disabled={!currentSessionId || isStreaming || isLooping || switchingModel'), '模型下拉不该因回复中禁用');
  });
  test('App 的换 agent / 模型 / 权限不再因回复中直接 return', () => {
    for (const anchor of ['const handleModelChange = useCallback', 'const handleKiroAgentChange = useCallback', 'const handlePermissionModeChange = useCallback']) {
      const i = A.indexOf(anchor);
      assert.ok(i >= 0, anchor);
      const body = A.slice(i, A.indexOf('}, [', i));
      assert.ok(!body.includes('streamingIds.includes(sid)'), `${anchor} 还在因 streaming 拒绝`);
    }
  });
});

describe('重连后的配置恢复先落定，再设即时项（审查意见 1）', () => {
  /**
   * 模拟真实顺序：重连 = 起新执行器 + wireSession 里异步按"重连前那份 profile"恢复模型 / 权限
   * （applyEngineModel，没有人 await 它）。恢复比即时项慢一步完成时，没等它就会把新值盖回旧值。
   */
  function fakeExecutor(restoreDelayMs: number) {
    const profile = { engineMode: 'default', engineModel: 'sonnet' };
    const live = { mode: '', model: '' };
    let ready: Promise<void> = Promise.resolve();
    return {
      live,
      ready: () => ready,
      reconnect() {
        const snapshot = { ...profile }; // applyEngineModel 开始时读的那份
        ready = new Promise<void>((r) => setTimeout(() => { live.mode = snapshot.engineMode; live.model = snapshot.engineModel; r(); }, restoreDelayMs));
      },
      setOption(kind: 'mode' | 'model', v: string) {
        live[kind] = v;
        if (kind === 'mode') profile.engineMode = v; else profile.engineModel = v;
      },
    };
  }

  test('换组合 + 换权限模式：权限最后是新值，不被恢复流程设回旧值', async () => {
    const ex = fakeExecutor(30);
    const report = await runPendingSwitches([sw('combo', 'research'), sw('engineMode', 'plan')], {
      reconnect: async () => { ex.reconnect(); return {}; },
      beforeInstants: () => ex.ready(),
      instant: async (e) => { ex.setOption('mode', e.value); },
    });
    await ex.ready();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ex.live.mode, 'plan', '新权限要留住');
    assert.equal(ex.live.model, 'sonnet');
    assert.deepEqual(report.failed, []);
  });

  test('对照：不等恢复（没有 beforeInstants）就会被盖回旧值 —— 这正是要防的竞态', async () => {
    const ex = fakeExecutor(30);
    await runPendingSwitches([sw('combo', 'research'), sw('engineMode', 'plan')], {
      reconnect: async () => { ex.reconnect(); return {}; },
      instant: async (e) => { ex.setOption('mode', e.value); },
    });
    await ex.ready();
    assert.equal(ex.live.mode, 'default');
  });

  test('beforeInstants 在所有重连之后、第一个即时项之前只调一次；没有即时项不调', async () => {
    const order: string[] = [];
    await runPendingSwitches([sw('agent', 'a'), sw('permission', 'ask'), sw('engineModel', 'opus')], {
      reconnect: async (e) => { order.push(`reconnect:${e.kind}`); return {}; },
      beforeInstants: async () => { order.push('ready'); },
      instant: async (e) => { order.push(`instant:${e.kind}`); },
    });
    assert.deepEqual(order, ['reconnect:agent', 'ready', 'instant:permission', 'instant:engineModel']);
    const order2: string[] = [];
    await runPendingSwitches([sw('agent', 'a')], {
      reconnect: async () => { order2.push('reconnect'); return {}; },
      beforeInstants: async () => { order2.push('ready'); },
      instant: async () => {},
    });
    assert.deepEqual(order2, ['reconnect']);
  });

  test('接线：wireSession 记下恢复的 promise，应用 pending 时等它（即时项前 + 整批结束前）', () => {
    assert.ok(/entry\.engineOptionsReady = applyEngineModel\(sessionId, entry\)/.test(M), 'wireSession 要记下 applyEngineModel 的 promise');
    assert.ok(!/void applyEngineModel\(sessionId, entry\);/.test(M), '不能再是没人等的 void');
    const batch = sliceFrom('applyPendingSwitchBatch = async', 6000);
    assert.ok(/beforeInstants: async \(\) => \{ await sessionClients\.get\(sessionId\)\?\.engineOptionsReady; \}/.test(batch));
    const afterRun = batch.slice(batch.indexOf('const report = await runPendingSwitches'));
    assert.ok(/\}\);\s*\/\*[^*]*\*\/\s*try \{ await sessionClients\.get\(sessionId\)\?\.engineOptionsReady; \}/.test(afterRun), '整批结束前也要等（settle 等的是整批）');
  });
});

describe('循环中的会话也能登记 pending：这一轮结束、下一轮开始前应用（审查意见 2）', () => {
  test('循环三轮：第 1 轮里换 agent → 第 1 轮结束时应用 → 第 2 轮用新 agent；第 2 轮里换了又取消 → 第 3 轮不变', async () => {
    const book = new PendingSwitchBook();
    let busy = false;
    let agent = 'a0';
    const runner = new PendingSwitchRunner(book, {
      isBusy: () => busy,
      apply: async (_sid, entries) => { for (const e of entries) if (e.kind === 'agent') agent = e.value; },
    });
    const usedAgents: string[] = [];
    /* 一轮 = sendPromptOnce：开头 settle、跑的时候 busy、收尾 kick（正是 index.ts 的接法） */
    const round = async (during?: () => void) => {
      await runner.settle('s');
      busy = true;
      usedAgents.push(agent);
      during?.();
      busy = false;
      await runner.kick('s');
    };
    await round(() => { book.set('s', sw('agent', 'a1')); assert.equal(runner.kick('s'), undefined, '循环这一轮还在跑：不切'); });
    await round(() => { book.set('s', sw('agent', 'a2')); book.cancel('s', 'agent'); });
    await round();
    assert.deepEqual(usedAgents, ['a0', 'a1', 'a1']);
  });

  test('接线：界面不再因为在循环就禁用 / 忽略 agent、模型、权限、组合', () => {
    const C = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf-8');
    const A = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf-8');
    for (const anchor of ['const handleModelChange = useCallback', 'const handleKiroAgentChange = useCallback', 'const handlePermissionModeChange = useCallback']) {
      const i = A.indexOf(anchor);
      const body = A.slice(i, A.indexOf('}, [', i));
      assert.ok(!body.includes('loopingIds.includes(sid)'), `${anchor} 还在因循环拒绝`);
    }
    for (const sel of ['composer-agent-select', 'composer-model-select', 'composer-combo-select']) {
      let at = C.indexOf(`className="composer-select ${sel}"`);
      assert.ok(at >= 0, sel);
      while (at >= 0) {
        const tag = C.slice(at, C.indexOf('>', C.indexOf('disabled={', at)));
        const disabled = tag.slice(tag.indexOf('disabled={'));
        assert.ok(!disabled.includes('isLooping'), `${sel} 还因 isLooping 禁用`);
        at = C.indexOf(`className="composer-select ${sel}"`, at + 1);
      }
    }
  });

  test('接线：下一轮恰好撞上两轮之间的立即切换时，先等切换落定再发', () => {
    const head = sliceFrom('async function sendPromptOnce(', 2500);
    assert.ok(/attempt === 0 && reconfiguringSessions\.has\(sessionId\)\) \{\s*try \{ await awaitReconfigureIdle\(sessionId\); \}/.test(head));
    assert.ok(head.indexOf('awaitReconfigureIdle') < head.indexOf('let entry = sessionClients.get(sessionId)'));
  });
});

describe('Claude / Codex 的选项：忙时登记后会话断开，重连时按记录生效（审查意见：断开后不能丢）', () => {
  test('withEngineOption 写的形状和活着的执行器上一样；不碰别的引擎和别的项', () => {
    const p0 = { model: 'default', engineModels: { codex: 'gpt' }, engineOptions: { claude: { thought_level: 'high' } } };
    const p1 = withEngineOption(p0, 'claude', 'model', 'opus');
    const p2 = withEngineOption(p1, 'claude', 'mode', 'plan');
    assert.deepEqual(p2.engineModels, { codex: 'gpt', claude: 'opus' });
    assert.deepEqual(p2.engineOptions, { claude: { thought_level: 'high', mode: 'plan' } });
    assert.deepEqual(p0.engineOptions, { claude: { thought_level: 'high' } }, '不改原对象');
  });

  test('忙时登记模型 + 权限模式 → 这一轮结束前断开 → 应用时写进记录 → 重连按记录恢复出新值', async () => {
    /* 一条 Claude Code 会话：记录 + 可能为空的"活执行器" */
    let record: any = { profile: { engine: 'claude', model: 'default', engineOptions: { claude: { mode: 'default' } } } };
    let live: { mode: string; model: string } | null = { mode: 'default', model: 'sonnet' };
    let busy = true;
    const book = new PendingSwitchBook();
    const runner = new PendingSwitchRunner(book, {
      isBusy: () => busy,
      /* 和 index.ts 的 instant 钩子同一个分支：有执行器就设在执行器上，没有就写进记录 */
      apply: (_sid, entries) => runPendingSwitches(entries, {
        reconnect: async () => ({}),
        instant: async (e) => {
          if (!live) { record = { ...record, profile: withEngineOption(record.profile, 'claude', e.value.category, e.value.value) }; return; }
          live[e.value.category as 'mode' | 'model'] = e.value.value;
        },
      }),
    });
    book.set('s', sw('engineModel', { category: 'model', value: 'opus' }, 'opus'));
    book.set('s', sw('engineMode', { category: 'mode', value: 'plan' }, 'plan'));
    live = null;            // 这一轮结束前执行器没了（断开 / 休眠）
    busy = false;
    await runner.kick('s'); // 这一轮的收尾照样触发应用
    assert.equal(book.has('s'), false, 'pending 已经取走');
    /* 重连：attach 从记录带上 engineModels / engineOptions，applyEngineModel 按它设回去 */
    const restored = { model: record.profile.engineModels?.claude, mode: record.profile.engineOptions?.claude?.mode };
    assert.deepEqual(restored, { model: 'opus', mode: 'plan' }, '重连后用的是忙时选的新值，没有被丢掉');
  });

  test('接线：应用 pending 时没有执行器就写进记录（不再直接 throw），attach 会从记录带上这两个字段', () => {
    const batch = sliceFrom('applyPendingSwitchBatch = async', 8000);
    const inst = batch.slice(batch.indexOf('instant: async (sw) =>'));
    assert.ok(/if \(!sessionClients\.get\(sessionId\)\) \{[\s\S]{0,700}withEngineOption\(rec\.profile, engine, v\.category, v\.value\)[\s\S]{0,80}store\.writeRecord\(rec\)/.test(inst));
    assert.ok(inst.indexOf('if (!sessionClients.get(sessionId))') < inst.indexOf('await setEngineOption(sessionId, v.category, v.value, true)'));
    assert.ok(M.includes('...(existing?.profile.engineModels ? { engineModels: existing.profile.engineModels } : {}),'));
    assert.ok(M.includes('...(existing?.profile.engineOptions ? { engineOptions: existing.profile.engineOptions } : {}),'));
  });
});

describe('MCP 组合：pending 记 id，下拉按 id 显示新选择（和界面语言无关）', () => {
  const C = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf-8');
  test('主进程登记组合时 label 就是组合 id；提示里才换成当前语言的显示名', () => {
    assert.ok(M.includes("queueSwitchWhileBusy(sessionId, 'combo', { comboId: combo.id }, combo.id, fromPending)"));
    assert.ok(!M.includes("queueSwitchWhileBusy(sessionId, 'combo', { comboId: combo.id }, comboDisplayName(combo)"));
    const batch = sliceFrom('applyPendingSwitchBatch = async', 9000);
    assert.ok(/if \(kind !== 'combo'\) return label;[\s\S]{0,200}comboDisplayName\(c\)/.test(batch));
  });

  test('下拉只按 id 对 pending（不再按 name 找）', () => {
    const at = C.indexOf('className="composer-select composer-combo-select"');
    const tag = C.slice(at, C.indexOf('onChange=', at));
    assert.ok(tag.includes('mcpCombos?.combos.some((c) => c.id === pendingSwitch.combo) ? pendingSwitch.combo'));
    assert.ok(!tag.includes('c.name === pendingSwitch.combo'));
  });

  test('英文界面从自定义组合切回默认组合：下拉显示 default（旧写法按显示名 General 找不到，会停在旧组合）', () => {
    /* 和 ChatArea 里那一行同一个表达式 */
    const pick = (pending: string | undefined, combos: Array<{ id: string; name: string }>, current: string) =>
      (pending !== undefined && combos.some((c) => c.id === pending) ? pending : '') || current || 'default';
    const combos = [{ id: 'default', name: '通用' }, { id: 'research', name: 'Research' }];
    const book = new PendingSwitchBook();
    book.set('s', sw('combo', { comboId: 'default' }, 'default')); // 主进程登记的就是 id
    assert.equal(pick(book.view('s').combo, combos, 'research'), 'default');
    /* 对照：如果 label 是英文显示名，按 id 对不上，下拉就停在旧组合 —— 这正是之前的 bug */
    assert.equal(pick('General', combos, 'research'), 'research');
  });
});

describe('历史重建占着会话时选的切换：重建结束（正常 / Stop）就应用，等重建的消息先切再发', () => {
  /** 模拟一次重建：期间 busy；收尾和 index.ts 的 primeHistoryNow finally 一样 kick。stopped = 用户按了 Stop。 */
  function harnessPrime() {
    const book = new PendingSwitchBook();
    const state = { busy: false, executor: 'exec-1', agent: 'a0' };
    const runner = new PendingSwitchRunner(book, {
      isBusy: () => state.busy,
      apply: async (_sid, entries) => {
        await new Promise((r) => setTimeout(r, 15)); // 重连要一点时间
        for (const e of entries) if (e.kind === 'agent') { state.agent = e.value; state.executor = `exec-for-${e.value}`; }
      },
    });
    const prime = async (during: () => void, stopped = false) => {
      state.busy = true;
      during();
      await new Promise((r) => setTimeout(r, stopped ? 1 : 10));
      state.busy = false;
      void runner.kick('s'); // primeHistoryNow 的 finally
      return { ok: !stopped };
    };
    /** 和 sendPromptOnce 的那段一样：开头 settle → 等重建 → 有在飞的切换就等它、执行器换了就从头重走 */
    const send = async (primeNeeded: () => Promise<unknown>): Promise<string> => {
      await runner.settle('s');
      const before = state.executor;
      await primeNeeded();
      if (runner.isApplying('s') || book.has('s')) {
        await runner.settle('s');
        if (state.executor !== before) return `restarted on ${state.executor} as ${state.agent}`;
      }
      return `sent on ${state.executor} as ${state.agent}`;
    };
    return { book, state, runner, prime, send };
  }

  test('独立重建（没有消息在等）正常结束：pending 立刻应用', async () => {
    const h = harnessPrime();
    await h.prime(() => { h.book.set('s', sw('agent', 'a1')); assert.equal(h.runner.kick('s'), undefined, '重建占着：不切'); });
    await h.runner.settle('s');
    assert.equal(h.state.agent, 'a1');
    assert.equal(h.book.has('s'), false);
  });

  test('重建被 Stop：同样应用', async () => {
    const h = harnessPrime();
    await h.prime(() => { h.book.set('s', sw('agent', 'a2')); }, true);
    await h.runner.settle('s');
    assert.equal(h.state.agent, 'a2');
  });

  test('有消息在等这次重建：重建后先等切换落定，按新执行器重走（不会用旧设置发出去）', async () => {
    const h = harnessPrime();
    /* 开头 settle 时重建已经占着（busy）→ settle 直接返回，这正是审查指出的窗口 */
    h.state.busy = true;
    const result = await h.send(() => h.prime(() => { h.book.set('s', sw('agent', 'a3')); }));
    assert.equal(result, 'restarted on exec-for-a3 as a3');
  });

  test('接线：primeHistoryNow 收尾 kick；sendPromptOnce 重建之后 settle、执行器换了就重走', () => {
    const fin = sliceFrom('e.primePromise = undefined;', 1200);
    assert.ok(fin.indexOf('emitSessionBusy(sessionId)') < fin.indexOf('void pendingSwitchRunner.kick(sessionId);'), '重建收尾（busy 清掉之后）要 kick');
    const head = sliceFrom('const primed = await primeHistoryNow(sessionId);', 1500);
    assert.ok(/if \(attempt === 0 && \(pendingSwitchRunner\.isApplying\(sessionId\) \|\| pendingSwitches\.has\(sessionId\)\)\) \{\s*const beforeSwitch = sessionClients\.get\(sessionId\);\s*await pendingSwitchRunner\.settle\(sessionId\);\s*if \(sessionClients\.get\(sessionId\) !== beforeSwitch\) \{[\s\S]{0,200}return sendPromptOnce\(sessionId, prompt, projectId, display, _model, attempt\);/.test(head));
    /* 重走之前没有落盘：用户消息的 appendMessage 在这段之后 */
    const fn = sliceFrom('async function sendPromptOnce(', 20000);
    assert.ok(fn.indexOf('return sendPromptOnce(sessionId, prompt, projectId, display, _model, attempt)') < fn.indexOf('store.appendMessage(sessionId, {'));
  });
});

describe('重连挂着的时候退出：正在应用、还没落定的那一批也要写进记录', () => {
  test('takeForApply 留账；takeForQuit 能拿到它们（之后又选的同类以最后一次为准）；落定的销账', () => {
    const book = new PendingSwitchBook();
    book.set('s', sw('agent', 'a1'));
    book.set('s', sw('model', 'm1'));
    book.set('s', sw('permission', 'ask'));
    const taken = book.takeForApply('s');
    assert.equal(taken.length, 3);
    assert.equal(book.has('s'), false, 'pending 已取走（界面上不再显示 ⏳）');
    book.doneApplying('s', ['permission']); // 这一类已经落定
    book.set('s', sw('model', 'm2'));       // 应用期间又选了一次
    assert.deepEqual(book.sessionsForQuit(), ['s']);
    const q = book.takeForQuit('s');
    assert.deepEqual(q.map((e) => `${e.kind}=${e.value}`), ['agent=a1', 'model=m2']);
    assert.deepEqual(book.sessionsForQuit(), [], '取走后清空');
  });

  test('模拟：重连挂起 → 退出写记录 → 重启按记录起，选的 agent / 模型都在', async () => {
    const book = new PendingSwitchBook();
    let release!: () => void;
    const runner = new PendingSwitchRunner(book, {
      isBusy: () => false,
      apply: (_sid, entries) => runPendingSwitches(entries, {
        reconnect: () => new Promise((r) => { release = () => r({}); }), // 重连一直挂着
        instant: async () => {},
        onDone: (kinds) => book.doneApplying('s', kinds),
      }),
    });
    book.set('s', sw('agent', 'reviewer'));
    book.set('s', sw('model', 'opus'));
    void runner.kick('s');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(runner.isApplying('s'), true);
    /* before-quit：persistPendingSwitchesOnQuit 的做法 —— 写进记录 */
    const record: Record<string, string> = { kiroAgent: 'kiro_default', model: 'sonnet' };
    for (const id of book.sessionsForQuit()) {
      for (const e of book.takeForQuit(id)) {
        if (e.kind === 'agent') record.kiroAgent = e.value;
        if (e.kind === 'model') record.model = e.value;
      }
    }
    /* 重启：attach 按记录起 */
    assert.deepEqual(record, { kiroAgent: 'reviewer', model: 'opus' });
    release();
  });

  test('落定（成功 / 失败 / 没变）的不再算欠着：失败的那类退出时不会被写进记录', async () => {
    const book = new PendingSwitchBook();
    const runner = new PendingSwitchRunner(book, {
      isBusy: () => false,
      apply: (_sid, entries) => runPendingSwitches(entries, {
        reconnect: async () => { throw new Error('连不上'); },
        instant: () => new Promise(() => {}), // 即时项挂着
        onDone: (kinds) => book.doneApplying('s', kinds),
      }),
    });
    book.set('s', sw('agent', 'bad'));
    book.set('s', sw('permission', 'ask'));
    void runner.kick('s');
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(book.takeForQuit('s').map((e) => e.kind), ['permission']);
  });

  test('接线：退出保存遍历 sessionsForQuit / takeForQuit，应用时 onDone 销账，runner 用 takeForApply', () => {
    assert.ok(/for \(const sessionId of pendingSwitches\.sessionsForQuit\(\)\) \{\s*const entries = pendingSwitches\.takeForQuit\(sessionId\);/.test(M));
    assert.ok(M.includes('onDone: (kinds) => pendingSwitches.doneApplying(sessionId, kinds),'));
    const P = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'pendingSwitch.ts'), 'utf-8');
    assert.ok(P.includes('const entries = this.book.takeForApply(sessionId);'));
    assert.ok(P.includes('this.book.endApplying(sessionId);'));
  });
});

describe('重连进行中再选：登记成下一批 pending，最后一次选择生效、记录不被旧 profile 盖掉', () => {
  test('shouldQueueSwitch：忙或正在应用就登记（不看有没有执行器）；应用自己的那次调用不登记', () => {
    assert.equal(shouldQueueSwitch({ busy: true, applying: false }), true);
    assert.equal(shouldQueueSwitch({ busy: false, applying: true }), true, '执行器刚被拿掉也一样要登记');
    assert.equal(shouldQueueSwitch({ busy: false, applying: false }), false, '不忙：立即切换不变');
    assert.equal(shouldQueueSwitch({ busy: true, applying: true, fromPending: true }), false);
  });

  /**
   * 和 index.ts 的 switchModelImpl / switchPermissionModeImpl 同一个结构：
   * 先问 shouldQueueSwitch（`queueOrderFirst` = 这次修好的顺序）→ 没执行器就只写记录（休眠那条路）→
   * 有执行器：先拿掉执行器、等重连、最后把**它开始时那份 profile** 写进记录。
   */
  function fakeSession(queueOrderFirst: boolean) {
    const record = { model: 'sonnet', permissionMode: 'auto-approve' };
    let live: { model: string; permissionMode: string } | null = { ...record };
    let busy = false;
    let gate: (() => void) | null = null;
    const book = new PendingSwitchBook();
    const runner = new PendingSwitchRunner(book, {
      isBusy: () => busy,
      apply: (_sid, entries) => runPendingSwitches(entries, {
        reconnect: async (e) => { await switchModel(e.value, true); return {}; },
        instant: async (e) => { await switchPermission(e.value, true); },
        onDone: (kinds) => book.doneApplying('s', kinds),
      }),
    });
    const queue = (kind: 'model' | 'permission', v: string, fromPending?: boolean) => {
      if (!shouldQueueSwitch({ busy, applying: runner.isApplying('s'), fromPending })) return false;
      book.set('s', sw(kind, v));
      return true;
    };
    async function switchModel(model: string, fromPending?: boolean) {
      if (queueOrderFirst && queue('model', model, fromPending)) return 'pending';
      if (!live) { record.model = model; return 'dormant'; }
      if (!queueOrderFirst && queue('model', model, fromPending)) return 'pending';
      const profile = { ...live, model };
      live = null;                                        // sessionClients.delete（先放锁再加载）
      await new Promise<void>((r) => { gate = r; });      // disconnect + connect + loadSession
      live = profile;
      Object.assign(record, profile);                     // rec.profile = profile（开始时那份）
      return 'switched';
    }
    async function switchPermission(mode: string, fromPending?: boolean) {
      if (queueOrderFirst && queue('permission', mode, fromPending)) return 'pending';
      if (!live) { record.permissionMode = mode; return 'dormant'; }
      if (!queueOrderFirst && queue('permission', mode, fromPending)) return 'pending';
      live.permissionMode = mode; record.permissionMode = mode;
      return 'switched';
    }
    return {
      record, runner, book,
      get live() { return live; },
      setBusy(b: boolean) { busy = b; },
      release() { const g = gate; gate = null; g?.(); },
      waitGate: async () => { for (let i = 0; i < 200 && !gate; i++) await new Promise((r) => setTimeout(r, 1)); assert.ok(gate, '重连应该挂着'); },
      switchModel, switchPermission,
    };
  }

  test('挂起模型重连 → 再选新模型和权限 → 放开重连：最后一次选择实际生效，记录也是新值', async () => {
    const f = fakeSession(true);
    f.setBusy(true);
    assert.equal(await f.switchModel('opus'), 'pending');   // 忙时选的
    f.setBusy(false);
    void f.runner.kick('s');                                // 这一轮收尾
    await f.waitGate();                                     // opus 的重连挂着，执行器已被拿掉
    assert.equal(f.live, null);
    assert.equal(await f.switchModel('haiku'), 'pending', '正在应用：登记成下一批，不能掉进休眠那条路');
    assert.equal(await f.switchPermission('ask'), 'pending');
    assert.deepEqual(f.book.view('s'), { model: 'haiku', permission: 'ask' });
    f.release();                                            // opus 那次落定，记录写成 opus
    await f.waitGate();                                     // 下一批（haiku）接着重连
    f.release();
    await f.runner.settle('s');
    assert.deepEqual(f.live, { model: 'haiku', permissionMode: 'ask' }, '执行器上是最后一次选择');
    assert.deepEqual(f.record, { model: 'haiku', permissionMode: 'ask' }, '记录没被那次 opus 重连用旧 profile 盖掉');
  });

  test('对照：旧顺序（先判断没执行器→只写记录）下，最后一次选择会被正在进行的重连盖掉', async () => {
    const f = fakeSession(false);
    f.setBusy(true);
    await f.switchModel('opus');
    f.setBusy(false);
    void f.runner.kick('s');
    await f.waitGate();
    assert.equal(await f.switchModel('haiku'), 'dormant', '旧顺序：看起来像没连着，只写了记录');
    f.release();
    await f.runner.settle('s');
    assert.equal(f.record.model, 'opus', 'haiku 被覆盖 —— 这正是审查指出的 bug');
  });

  test('接线：五个入口都先问 queueSwitchWhileBusy，再进"没连着只写记录 / 报未连接"那条路', () => {
    const cases: Array<[string, string]> = [
      ['const switchModelImpl = async', 'if (!oldEntry) {'],
      ['const switchKiroAgentImpl = async', 'if (!oldEntry) {'],
      ['const switchPermissionModeImpl = async', 'if (!entry) {'],
      ['const switchMcpComboImpl = async', 'if (!oldEntry) {'],
      ['const setEngineOption = async', 'if (!entry) throw'],
      ['const switchEngineImpl = async', 'if (!oldEntry) {'],
    ];
    for (const [anchor, dormant] of cases) {
      const body = sliceFrom(anchor, 4000);
      const q = body.indexOf('queueSwitchWhileBusy(');
      const d = body.indexOf(dormant);
      assert.ok(q > 0 && d > 0, anchor);
      assert.ok(q < d, `${anchor}：登记要排在「${dormant}」之前`);
    }
    assert.ok(/shouldQueueSwitch\(\{ busy: !!sessionClients\.get\(sessionId\)\?\.busy, applying: pendingSwitchRunner\.isApplying\(sessionId\), fromPending \}\)/.test(M));
  });
});
