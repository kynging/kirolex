import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AcpClient } from '../src/main/acp-client.ts';
import { createCreationGate } from '../src/main/creationGate.ts';
import { CreationSwitchBook, applyBeforeStart, settleOnCreated } from '../src/main/creationSwitches.ts';

/*
  **新会话还在建立时切「自动批准」/ 模型 / agent 不能丢**（main-20261118-200818.log，s_1795007056613_36vy96）：
  远程会话建立要 ~40s，用户在第 8～10 秒切到 auto-approve，走的是「休眠只写记录」那条路；
  建会话流程最后用它开始时那份 profile（ask）整份写回记录，建出来的客户端也是 ask ——
  两个 web_search 等批准等了 457 秒。
*/

const permission = (id: number) => ({
  jsonrpc: '2.0', id, method: 'session/request_permission',
  params: {
    sessionId: 'cli-1',
    toolCall: { toolCallId: `t${id}`, kind: 'fetch', title: 'web_search', rawInput: { q: 'x' } },
    options: [{ optionId: 'ok', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
  },
});

/**
 * 和 index.ts 同一个结构：`acp:new-session` 在 `creations.run` 里先写一份记录、等远端（这里是 gate）、
 * 起执行器前 `applyBeforeStart`、建好后 `settleOnCreated` 再 `rec.profile = profile`；
 * 切换入口看到「没有执行器 + 正在新建」就记进 book（并写记录），否则按原来的路走。
 */
function fakeApp() {
  const records = new Map<string, any>();
  const live = new Map<string, { client: AcpClient; profile: any }>();
  const creations = createCreationGate();
  const book = new CreationSwitchBook();
  const pending: Array<{ kind: string; value: any }> = [];
  let releaseRemote: (() => void) | null = null;
  let releaseStart: (() => void) | null = null;

  const newSession = (id: string) => creations.run(id, { engine: 'kiro', remote: true }, async () => {
    const profile: any = { model: 'sonnet', preferredModel: 'sonnet', permissionMode: 'ask', engine: 'kiro', kiroAgent: undefined };
    records.set(id, { profile: { ...profile } });                    // 起执行器之前先落盘的那份
    await new Promise<void>((r) => { releaseRemote = r; });           // 远端预检（~30s）
    applyBeforeStart(profile, book.peek(id));
    await new Promise<void>((r) => { releaseStart = r; });            // 起执行器 + session/new
    const client = new AcpClient(profile.model, {}, profile.kiroAgent, profile.permissionMode);
    const later = settleOnCreated(profile, client, book.take(id));
    if (later.model !== undefined) pending.push({ kind: 'model', value: { model: later.model } });
    if (later.kiroAgent !== undefined) pending.push({ kind: 'agent', value: { agentName: later.kiroAgent } });
    live.set(id, { client, profile });
    records.get(id).profile = profile;                                // rec.profile = profile
    return client;
  });

  const switchDuringCreation = (id: string, patch: any) => {
    if (live.has(id) || !creations.creating(id)) return false;
    book.set(id, patch);
    const rec = records.get(id);
    rec.profile = { ...rec.profile, ...patch, ...(patch.kiroAgent !== undefined ? { kiroAgent: patch.kiroAgent || undefined } : {}) };
    return true;
  };

  return {
    records, live, pending, newSession, switchDuringCreation,
    waitFor: async (which: 'remote' | 'start') => {
      for (let i = 0; i < 200 && !(which === 'remote' ? releaseRemote : releaseStart); i++) await new Promise((r) => setTimeout(r, 1));
    },
    release: (which: 'remote' | 'start') => {
      const g = which === 'remote' ? releaseRemote : releaseStart;
      if (which === 'remote') releaseRemote = null; else releaseStart = null;
      g?.();
    },
  };
}

describe('新建进行中切换：建好后生效，记录不被开始时那份 profile 盖掉', () => {
  test('远端预检期间切到 auto-approve（三次来回，最后一次 auto）→ 记录和客户端都是 auto-approve', async () => {
    const app = fakeApp();
    const done = app.newSession('s1');
    await app.waitFor('remote');
    assert.equal(app.switchDuringCreation('s1', { permissionMode: 'auto-approve' }), true);
    assert.equal(app.switchDuringCreation('s1', { permissionMode: 'ask' }), true);
    assert.equal(app.switchDuringCreation('s1', { permissionMode: 'auto-approve' }), true);
    app.release('remote');
    await app.waitFor('start');
    app.release('start');
    const client = await done;
    assert.equal(app.records.get('s1').profile.permissionMode, 'auto-approve');
    assert.equal(client.getPermissionMode(), 'auto-approve');
    assert.equal(app.live.get('s1')!.profile.permissionMode, 'auto-approve');
  });

  test('执行器已经在起（applyBeforeStart 之后）才切的：建好时当场设到客户端上，后续权限请求自动批准', async () => {
    const app = fakeApp();
    const done = app.newSession('s2');
    await app.waitFor('remote');
    app.release('remote');
    await app.waitFor('start');
    app.switchDuringCreation('s2', { permissionMode: 'auto-approve' });
    app.release('start');
    const client: any = await done;
    assert.equal(app.records.get('s2').profile.permissionMode, 'auto-approve');
    assert.equal(client.getPermissionMode(), 'auto-approve');
    const sent: any[] = [];
    client.send = (m: any) => sent.push(m);
    client.handleAgentRequest(permission(5));
    assert.equal(sent[0]?.result?.outcome?.optionId, 'ok');
  });

  test('model / kiroAgent：起执行器前选的 agent 直接带进新客户端；模型和晚到的 agent 登记成建好后的 pending', async () => {
    const app = fakeApp();
    const done = app.newSession('s3');
    await app.waitFor('remote');
    app.switchDuringCreation('s3', { kiroAgent: 'reviewer' });
    app.switchDuringCreation('s3', { model: 'opus' });
    app.release('remote');
    await app.waitFor('start');
    app.release('start');
    const client: any = await done;
    assert.equal(client.kiroAgent, 'reviewer', '起出来就是选的那个 agent');
    assert.equal(app.records.get('s3').profile.kiroAgent, 'reviewer');
    assert.deepEqual(app.pending, [{ kind: 'model', value: { model: 'opus' } }], '模型要换执行器：建好后接着切');

    const app2 = fakeApp();
    const done2 = app2.newSession('s4');
    await app2.waitFor('remote');
    app2.release('remote');
    await app2.waitFor('start');
    app2.switchDuringCreation('s4', { kiroAgent: 'reviewer' });
    app2.release('start');
    await done2;
    assert.deepEqual(app2.pending, [{ kind: 'agent', value: { agentName: 'reviewer' } }]);
  });

  test('没在建 / 已经建好：不进 book（照原来的路）', async () => {
    const app = fakeApp();
    assert.equal(app.switchDuringCreation('nope', { permissionMode: 'auto-approve' }), false);
    const done = app.newSession('s5');
    await app.waitFor('remote'); app.release('remote');
    await app.waitFor('start'); app.release('start');
    await done;
    assert.equal(app.switchDuringCreation('s5', { permissionMode: 'auto-approve' }), false);
  });
});

describe('CreationSwitchBook / settleOnCreated', () => {
  test('同一条会话多次选：按字段合并，最后一次为准；take 之后清空', () => {
    const book = new CreationSwitchBook();
    book.set('a', { permissionMode: 'auto-approve' });
    book.set('a', { model: 'opus' });
    book.set('a', { permissionMode: 'ask' });
    assert.deepEqual(book.peek('a'), { permissionMode: 'ask', model: 'opus' });
    assert.deepEqual(book.take('a'), { permissionMode: 'ask', model: 'opus' });
    assert.equal(book.peek('a'), undefined);
  });

  test('和起出来的一样的不再登记；agent 选「默认」（空串）也算一次选择', () => {
    const profile: any = { model: 'opus', kiroAgent: 'reviewer', permissionMode: 'ask' };
    const client = new AcpClient('opus', {}, 'reviewer', 'ask');
    assert.deepEqual(settleOnCreated(profile, client, { model: 'opus', kiroAgent: 'reviewer' }), {});
    assert.deepEqual(settleOnCreated(profile, client, { kiroAgent: '' }), { kiroAgent: '' });
    assert.deepEqual(settleOnCreated(profile, client, undefined), {});
  });
});

describe('切到 auto-approve：已经挂着没回答的权限请求按允许答复', () => {
  test('两个挂着的 web_search → 切 auto-approve → 两个都回 allow，返回答了哪些', () => {
    const c: any = new AcpClient('m', {});
    const sent: any[] = [];
    c.send = (m: any) => sent.push(m);
    c.on('update', () => {});
    c.handleAgentRequest(permission(11));
    c.handleAgentRequest(permission(12));
    assert.equal(sent.length, 0);
    assert.equal(c.awaitingPermission, true);
    const answered = c.setPermissionMode('auto-approve');
    assert.deepEqual(sent.map((m) => [m.id, m.result.outcome.optionId]), [[11, 'ok'], [12, 'ok']]);
    assert.deepEqual(answered.map((a: any) => a.requestId), [11, 12]);
    assert.equal(c.awaitingPermission, false);
  });

  test('切到 ask 不替用户回答', () => {
    const c: any = new AcpClient('m', {});
    const sent: any[] = [];
    c.send = (m: any) => sent.push(m);
    c.on('update', () => {});
    c.handleAgentRequest(permission(13));
    assert.deepEqual(c.setPermissionMode('ask'), []);
    assert.equal(sent.length, 0);
    assert.equal(c.awaitingPermission, true);
  });
});

/* ───────── 接线（index.ts / useAcp.ts） ───────── */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const M = strip(fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'));
const ACP = strip(fs.readFileSync(new URL('../src/renderer/hooks/useAcp.ts', import.meta.url), 'utf8'));
const sliceFrom = (anchor: string, n: number) => { const at = M.indexOf(anchor); assert.ok(at > 0, anchor); return M.slice(at, at + n); };

describe('接线', () => {
  test('三个切换入口都先问 queueSwitchWhileBusy（排在「休眠只写记录」之前），它第一件事就是看是不是在新建', () => {
    for (const [anchor, dormant] of [
      ['const switchModelImpl = async', 'if (!oldEntry) {'],
      ['const switchKiroAgentImpl = async', 'if (!oldEntry) {'],
      ['const switchPermissionModeImpl = async', 'if (!entry) {'],
    ]) {
      const body = sliceFrom(anchor, 5000);
      const q = body.indexOf('queueSwitchWhileBusy(sessionId');
      assert.ok(q > 0 && q < body.indexOf(dormant), anchor);
    }
    const queue = sliceFrom('function queueSwitchWhileBusy(', 600);
    const c = queue.indexOf('switchWhileCreating(sessionId, kind, value, label)');
    assert.ok(c > 0 && c < queue.indexOf('shouldQueueSwitch('), '先看在不在建，再看忙不忙');
    const helper = sliceFrom('function switchWhileCreating(', 1600);
    assert.ok(helper.includes('if (sessionClients.get(sessionId) || !creations.creating(sessionId)) return null;'));
    assert.ok(helper.includes('creationSwitches.set(sessionId, patch)'));
    assert.ok(helper.includes('store.writeRecord(rec)'));
  });

  test('权限 / agent 入口也先等挂载锁落定（同 switchModelImpl）；还在新建的不等（attach 正等着新建，一起等就慢了）', () => {
    for (const anchor of ['const switchKiroAgentImpl = async', 'const switchPermissionModeImpl = async']) {
      const body = sliceFrom(anchor, 3000);
      const s = body.indexOf('if (!creations.creating(sessionId)) await mountLock.settle(sessionId);');
      assert.ok(s > 0, anchor);
      assert.ok(s < body.indexOf('sessionClients.get(sessionId)'), `${anchor}：先等锁再取执行器`);
    }
  });

  test('new-session：起执行器前 applyBeforeStart，建好登记执行器前 settleOnCreated', () => {
    const body = sliceFrom("ipcMain.handle('acp:new-session'", 16000);
    const before = body.indexOf('applyBeforeStart(profile, creationSwitches.peek(kiroLexId))');
    const start = body.indexOf('connectWithModelFallback(profile');
    const settle = body.indexOf('settleOnCreated(profile, client, creationSwitches.take(kiroLexId))');
    const set = body.indexOf('sessionClients.set(kiroLexId, entry)');
    assert.ok(before > 0 && before < start, 'applyBeforeStart 在起执行器之前');
    assert.ok(settle > start && settle < set, 'settleOnCreated 在登记执行器之前');
  });

  test('一轮在跑（有权限请求挂着）时切权限：不排成 pending，当场生效', () => {
    const body = sliceFrom('const switchPermissionModeImpl = async', 3000);
    const live = body.indexOf('const appliesNow =');
    assert.ok(live > 0 && live < body.indexOf('queueSwitchWhileBusy('));
  });

  test('界面：切到 auto-approve 后收掉这条会话的权限卡片（请求已经由主进程按允许答了）', () => {
    const at = ACP.indexOf('const changeSessionPermissionMode = useCallback(');
    const body = ACP.slice(at, at + 1500);
    assert.match(body, /result\.permissionMode === 'auto-approve'\) setPermissionRequests\(\(current\) => withoutPermissionCard\(current, sessionId\)\)/);
  });
});
