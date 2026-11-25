import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AcpClient } from '../src/main/acp-client.ts';
import { PendingSwitchBook, PendingSwitchRunner, runPendingSwitches, shouldQueueSwitch, settlingSource } from '../src/main/pendingSwitch.ts';
import { profileAfterReconnect, recordPermission } from '../src/main/reconnectRecord.ts';

/*
  **重连期间切权限不能被重连盖掉**（2026-11-25「frp 那个会话还是有之前权限审批的 bug」，
  main-20261125-203010.log，s_1795582682473_dj6azu）：切到远端 graviton 重连途中（执行器已经拿掉）切「自动」，
  走了「没连着只写记录」；重连落定时把它开始时那份 profile（ask）整份写回，新执行器也按 ask 起，之后连着弹批准。
*/

describe('settlingSource：正在重连 / 挂载也要登记', () => {
  test('重连优先于挂载；应用 pending 的那次调用自己不登记；都不在返回 null', () => {
    assert.equal(settlingSource({ reconfiguring: true, attaching: true }), 'reconfiguring');
    assert.equal(settlingSource({ reconfiguring: false, attaching: true }), 'attaching');
    assert.equal(settlingSource({ reconfiguring: false, attaching: false }), null);
    assert.equal(settlingSource({ reconfiguring: true, attaching: false, fromPending: true }), null);
  });
});

describe('profileAfterReconnect：以写盘那一刻的记录为底，只覆盖这次重连改了的字段', () => {
  const R1 = { sshHost: 'tokyo', sshPort: 22 };
  const R2 = { sshHost: 'graviton', sshPort: 22 };
  const started = { engine: 'kiro', model: 'sonnet', preferredModel: 'sonnet', permissionMode: 'ask', kiroAgent: 'a1', remote: R1, projectId: 'frp' };

  test('换模型：只写 model / preferredModel / modelEarnedOn；期间别处改的权限 / agent / 机器不被盖掉', () => {
    const latest = { ...started, permissionMode: 'auto-approve', kiroAgent: 'a2', remote: R2 };
    const next = { ...started, model: 'opus', preferredModel: 'opus', modelEarnedOn: 'tokyo:22' };
    const out: any = profileAfterReconnect(latest, started, next);
    assert.equal(out.model, 'opus');
    assert.equal(out.preferredModel, 'opus');
    assert.equal(out.modelEarnedOn, 'tokyo:22');
    assert.equal(out.permissionMode, 'auto-approve', 'permissionMode 不被盖回 ask');
    assert.equal(out.kiroAgent, 'a2');
    assert.deepEqual(out.remote, R2);
    assert.equal(out.projectId, 'frp');
  });

  test('这次重连改了的字段照写（含清掉的：agent 换回默认）；没有记录 / 不知道开始时的样子按这次的为准', () => {
    const next = { ...started, kiroAgent: undefined, remote: R2 };
    const out: any = profileAfterReconnect({ ...started, permissionMode: 'auto-approve' }, started, next);
    assert.equal('kiroAgent' in out, false);
    assert.deepEqual(out.remote, R2);
    assert.equal(out.permissionMode, 'auto-approve');
    assert.deepEqual(profileAfterReconnect(undefined, started, next), next);
    assert.deepEqual(profileAfterReconnect({ ...started, x: 1 } as any, undefined, next), { ...started, x: 1, ...next });
  });

  test('recordPermission：没写 = 先问', () => {
    assert.equal(recordPermission(undefined), 'ask');
    assert.equal(recordPermission({}), 'ask');
    assert.equal(recordPermission({ permissionMode: 'auto-approve' }), 'auto-approve');
  });
});

/**
 * 和 index.ts 同一个结构：换机器重连（`reconfiguringSessions` 有它，执行器先拿掉）→ 途中切权限 →
 * `queueSwitchWhileBusy` 看到 settling 就登记 pending、不写记录 → 重连落定（按 profileAfterReconnect 写盘、
 * 新执行器按开始时的 ask 起）→ 清掉 reconfiguring 后 kick → 应用 pending：client 和记录都是 auto-approve。
 */
describe('重连进行中切权限：进 pending、不写记录；落定后立即应用', () => {
  function fakeApp() {
    const record: any = { profile: { engine: 'kiro', model: 'sonnet', permissionMode: 'ask', remote: { sshHost: 'tokyo' } } };
    let entry: { client: AcpClient; profile: any } | null = { client: new AcpClient('sonnet', {}), profile: { ...record.profile } };
    const reconfiguring = new Set<string>();
    const book = new PendingSwitchBook();
    const runner = new PendingSwitchRunner(book, {
      isBusy: () => false,
      apply: (_sid, entries) => runPendingSwitches(entries, {
        reconnect: async () => ({}),
        instant: async (sw) => { switchPermission(sw.value.permissionMode, true); },
        onDone: (kinds) => book.doneApplying('s', kinds),
      }),
    });
    const queue = (value: any, fromPending?: boolean) => {
      const settling = settlingSource({ reconfiguring: reconfiguring.has('s'), attaching: false, fromPending });
      const turnBusy = shouldQueueSwitch({ busy: false, applying: runner.isApplying('s'), fromPending });
      if (!turnBusy && !settling) return false;
      book.set('s', { kind: 'permission', value, label: value.permissionMode, ...(settling ? { source: settling } : {}) });
      return true;
    };
    function switchPermission(mode: 'ask' | 'auto-approve', fromPending?: boolean) {
      const appliesNow = !!entry && !fromPending && !reconfiguring.has('s');
      if (!appliesNow && queue({ permissionMode: mode }, fromPending)) return 'pending';
      if (!entry) { record.profile = { ...record.profile, permissionMode: mode }; return 'dormant'; }
      entry.client.setPermissionMode(mode);
      entry.profile.permissionMode = mode;
      record.profile = { ...record.profile, permissionMode: mode };
      return 'switched';
    }
    let finish!: () => void;
    async function switchRemote() {
      reconfiguring.add('s');
      const profile = { ...entry!.profile, remote: { sshHost: 'graviton' } };
      const startedRec = { ...record.profile };
      entry = null;                                               // sessionClients.delete
      await new Promise<void>((r) => { finish = r; });
      const client = new AcpClient(profile.model, {}, undefined, profile.permissionMode);
      entry = { client, profile };
      record.profile = profileAfterReconnect(record.profile, startedRec, profile);
      if (recordPermission(record.profile) !== recordPermission(entry.profile)) {   // adoptRecordPermission
        entry.profile.permissionMode = recordPermission(record.profile);
        client.setPermissionMode(entry.profile.permissionMode);
      }
      reconfiguring.delete('s');
      await runner.kick('s');                                     // kickPendingWhenSettled
    }
    return { record, book, reconfiguring, switchPermission, switchRemote, get entry() { return entry; }, finish: () => finish() };
  }

  test('frp 那次：换机器途中切「自动」→ pending、记录还是 ask；落定后 client 和记录都是 auto-approve', async () => {
    const app = fakeApp();
    const done = app.switchRemote();
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(app.entry, null, '执行器已经拿掉');
    assert.equal(app.switchPermission('auto-approve'), 'pending', '不能掉进「没连着只写记录」');
    assert.equal(app.record.profile.permissionMode, 'ask', '重连期间不写记录');
    assert.deepEqual(app.book.view('s'), { permission: 'auto-approve' });
    assert.equal(app.book.list('s')[0].source, 'reconfiguring');
    app.finish();
    await done;
    assert.equal(app.record.profile.permissionMode, 'auto-approve');
    assert.equal(app.entry!.client.getPermissionMode(), 'auto-approve');
    assert.equal(app.entry!.profile.permissionMode, 'auto-approve');
    assert.deepEqual(app.record.profile.remote, { sshHost: 'graviton' }, '换机器本身照写');
    assert.equal(app.book.has('s'), false);
  });

  test('防御：就算记录在重连期间被别处写成了 auto-approve，落定时也不盖回 ask，新执行器按记录设', async () => {
    const app = fakeApp();
    const done = app.switchRemote();
    await new Promise((r) => setTimeout(r, 1));
    app.record.profile = { ...app.record.profile, permissionMode: 'auto-approve' };   // 旧代码那条「休眠只写记录」
    app.finish();
    await done;
    assert.equal(app.record.profile.permissionMode, 'auto-approve');
    assert.equal(app.entry!.client.getPermissionMode(), 'auto-approve');
  });
});

/* ───────── 接线（index.ts） ───────── */
const M = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
const body = (anchor: string, n: number) => { const at = M.indexOf(anchor); assert.ok(at > 0, anchor); return M.slice(at, at + n); };

describe('接线', () => {
  test('queueSwitchWhileBusy：重连 / 挂载中也登记，来源进日志，落定后立即 kick', () => {
    const q = body('function queueSwitchWhileBusy(', 3000);
    assert.match(q, /settlingSource\(\{\s*reconfiguring: reconfiguringSessions\.has\(sessionId\),\s*attaching: attachingSessions\.has\(sessionId\) \|\| mountLock\.busy\(sessionId\),\s*fromPending,\s*\}\)/);
    assert.match(q, /if \(!settling && !shouldQueueSwitch\(/);
    assert.match(q, /source=\$\{settling\}/);
    assert.match(q, /kickPendingWhenSettled\(sessionId\)/);
    const k = body('function kickPendingWhenSettled(', 1200);
    assert.match(k, /reconfiguringSessions\.has\(sessionId\)/);
    assert.match(k, /pendingSwitchRunner\.kick\(sessionId\)/);
    /* 应用时的日志也带来源 */
    assert.match(M, /source=\$\{e\.source\}/);
  });

  test('每条重连路径写盘都是「读最新记录 + 只改自己的字段」，并按最新记录设新执行器的权限', () => {
    for (const [anchor, n] of [
      ['async function swapSessionModel(', 9000],
      ['const applySessionTarget = async (', 12000],
      ['const switchModelImpl = async', 9000],
      ['const switchKiroAgentImpl = async', 6000],
      ['const switchEngineImpl = async', 7000],
      ['async function remountWithProfile(', 4000],
    ] as const) {
      const b = body(anchor, n);
      const cap = b.indexOf('const startedRec = store.readRecord(sessionId)?.profile;');
      /* 模型降级那条先保留「项目归属以盘上为准」（keepRecordPlacement），再以盘上那份为底合并 */
      const w = Math.max(b.indexOf('profileAfterReconnect(rec.profile, startedRec, profile)'), b.indexOf('profileAfterReconnect(onDisk, startedRec, rec.profile)'));
      assert.ok(cap > 0 && w > cap, `${anchor}：开始时记下盘上那份，写盘时在最新记录上只改自己的字段`);
      assert.ok(b.indexOf('adoptRecordPermission(sessionId, ', w) > w, `${anchor}：写盘后按最新记录设权限`);
      assert.doesNotMatch(b.slice(0, b.indexOf('adoptRecordPermission(sessionId, ', w)), /\n\s*rec\.profile = profile;\n/, `${anchor}：不再整份写回`);
    }
  });

  test('attach 挂上时按最新记录设权限（落定前重读的那份 latestProfile）', () => {
    const b = body('Object.assign(profile, adopted);', 4000);
    const set = b.indexOf('sessionClients.set(sessionId, entry);');
    const adopt = b.indexOf('adoptRecordPermission(sessionId, entry, latestProfile);');
    assert.ok(set > 0 && adopt > set, '挂上之后、同一段里');
    assert.equal(b.slice(set, adopt).includes('await '), false, '之间没有 await');
  });
});
