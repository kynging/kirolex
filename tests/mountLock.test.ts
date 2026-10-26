import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SessionMountLock, mountDrift, adoptRecordFields, MountDriftError } from '../src/main/attachGate.ts';
import { RemoteRecovery } from '../src/main/remoteRecovery.ts';

/*
 * 「我都切到 claude code 了右侧的模型列表也没变」（2026-10-26，会话 s_1792981274709_r0exzg）
 *
 * 02:21:41 转发 MCP 后来就绪 → 重连执行器（detach → 断线恢复 → attach）；
 * 02:21:44 切换引擎（未连接）Codex → Claude Code：只改记录 + 发 engine-changed；
 * 02:21:52 自动重连仍按 Codex 起 —— 它在切换之前就读了记录，挂上后记录又被写回 codex。
 *
 * 修两层：
 * 1. 冷切换前先等这条会话的「挂载锁」（attach 在飞、MCP 晚就绪重连、断线恢复那一轮）落定，再判断走哪条分支；
 * 2. 挂载落定前重读记录：engine / remote / 组合 / kiro 模型被改过 → 丢掉这次挂载按记录重起；engineModels 以记录为准。
 */

type Profile = {
  engine?: string;
  remote?: { sshHost?: string; sshPort?: number };
  mcpCombo?: string;
  model?: string;
  preferredModel?: string;
  engineModels?: Record<string, string>;
};

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SessionMountLock：一条会话的挂载锁', () => {
  test('等到所有来源（attach / 断线恢复 / 晚就绪重连）都落定才返回；失败也不往外抛', async () => {
    const attach = new Map<string, Promise<unknown>>();
    const recovery = new Map<string, Promise<unknown>>();
    const lock = new SessionMountLock([(sid) => attach.get(sid), (sid) => recovery.get(sid)]);
    let attachDone = false;
    let recoveryDone = false;
    attach.set('s', tick(20).then(() => { attachDone = true; attach.delete('s'); }));
    recovery.set('s', tick(40).then(() => { recoveryDone = true; recovery.delete('s'); throw new Error('连不上'); }));
    assert.equal(lock.busy('s'), true);
    const r = await lock.settle('s');
    assert.equal(attachDone, true);
    assert.equal(recoveryDone, true);
    assert.equal(r.waited, true);
    assert.equal(r.timedOut, false);
    assert.equal(lock.busy('s'), false);
    assert.deepEqual(await lock.settle('s'), { waited: false, timedOut: false });
  });

  test('hold 登记的一段（晚就绪重连的 detach 窗口）结束后自动注销', async () => {
    const lock = new SessionMountLock();
    let done = false;
    const p = lock.hold('s', tick(15).then(() => { done = true; return 7; }));
    assert.equal(lock.busy('s'), true);
    assert.equal(lock.busy('other'), false);
    await lock.settle('s');
    assert.equal(done, true);
    assert.equal(await p, 7);
    assert.equal(lock.busy('s'), false);
    /* 失败的一段也注销，hold 原样把失败交还给调用方 */
    const bad = lock.hold('s', Promise.reject(new Error('x')));
    await assert.rejects(bad, /x/);
    await lock.settle('s');
    assert.equal(lock.busy('s'), false);
  });

  test('等不完就按超时返回（不卡死切换），由挂载那一侧的重读兜底', async () => {
    const lock = new SessionMountLock();
    let release!: () => void;
    lock.hold('s', new Promise<void>((r) => { release = r; }));
    const r = await lock.settle('s', { timeoutMs: 30 });
    assert.equal(r.timedOut, true);
    release();
  });

  test('等完一个又来一个也一起等，但只等有限几轮', async () => {
    const attach = new Map<string, Promise<unknown>>();
    const lock = new SessionMountLock([(sid) => attach.get(sid)]);
    let rounds = 0;
    const start = (): void => {
      rounds += 1;
      attach.set('s', tick(5).then(() => { attach.delete('s'); if (rounds < 10) start(); }));
    };
    start();
    await lock.settle('s');
    assert.ok(rounds >= 2 && rounds <= 5, `等了 ${rounds} 轮`);
  });

  test('断线恢复正在跑的那一轮算进锁里（RemoteRecovery.inFlight）；只排着定时器的不算', async () => {
    let releaseReattach!: () => void;
    const rr = new RemoteRecovery({
      target: () => ({ key: 'k' }),
      attached: () => false,
      toolless: () => false,
      busy: () => false,
      detach: async () => {},
      reattach: () => new Promise<boolean>((r) => { releaseReattach = () => r(true); }),
      notice: () => {},
      backoffMs: [60_000],
    });
    rr.start('s', { quiet: true });
    assert.equal(rr.inFlight('s'), undefined, '只是排着定时器：到点时它会重读记录，不用等');
    const running = rr.tick('s');
    assert.ok(rr.inFlight('s'), '正在挂载的那一轮要等');
    const lock = new SessionMountLock([(sid) => rr.inFlight(sid)]);
    let settled = false;
    const s = lock.settle('s').then(() => { settled = true; });
    await tick(10);
    assert.equal(settled, false);
    releaseReattach();
    await running;
    await s;
    assert.equal(settled, true);
    assert.equal(rr.inFlight('s'), undefined);
    rr.stopAll();
  });
});

describe('mountDrift / adoptRecordFields：挂载落定前按记录对一遍', () => {
  test('引擎 / 机器 / 组合被改过 → 丢掉这次挂载', () => {
    const snap: Profile = { engine: 'codex', remote: { sshHost: 'a' }, mcpCombo: 'c1' };
    assert.equal(mountDrift(snap, snap, { ...snap }), null);
    assert.equal(mountDrift(snap, snap, { ...snap, engine: 'claude' }), 'engine');
    assert.equal(mountDrift(snap, snap, { ...snap, remote: { sshHost: 'b' } }), 'remote');
    assert.equal(mountDrift(snap, snap, { ...snap, remote: { sshHost: 'a', sshPort: 2222 } }), 'remote');
    assert.equal(mountDrift(snap, snap, { ...snap, remote: undefined }), 'remote');
    assert.equal(mountDrift(snap, snap, { ...snap, mcpCombo: undefined }), 'mcpCombo');
    /* 记录没了（删了）不在这里判：attach 自己的删除判据管 */
    assert.equal(mountDrift(snap, snap, undefined), null);
  });

  test('kiro：期间换过模型（模型是起进程时绑的）也重起；Claude / Codex 的 model 字段不算', () => {
    const kiro: Profile = { model: 'gpt-5.6-sol', preferredModel: 'claude-opus-5' };
    /* started.model 是挂载自己挑出来的（降级 / 远端清单），和记录不同不算漂移 */
    assert.equal(mountDrift(kiro, { ...kiro, model: 'deepseek-3.2' }, { ...kiro }), null);
    assert.equal(mountDrift(kiro, kiro, { ...kiro, model: 'claude-sonnet-5', preferredModel: 'claude-sonnet-5' }), 'model');
    const codex: Profile = { engine: 'codex', model: 'default' };
    assert.equal(mountDrift(codex, codex, { ...codex, model: 'whatever' }), null);
  });

  test('engineModels 以记录为准（不覆盖期间被改的），其余字段保持这次起来的', () => {
    const started: Profile = { engine: 'codex', model: 'default', engineModels: { codex: 'gpt-5.5' } };
    const latest: Profile = { engine: 'codex', model: 'default', engineModels: { codex: 'gpt-5.6', claude: 'opus' } };
    const p = adoptRecordFields(started, latest);
    assert.deepEqual(p.engineModels, { codex: 'gpt-5.6', claude: 'opus' });
    assert.equal(p.engine, 'codex');
    const cleared = adoptRecordFields(started, { engine: 'codex' });
    assert.equal(cleared.engineModels, undefined);
    assert.equal(adoptRecordFields(started, undefined), started);
  });

  test('Claude / Codex：挂载途中只改了 model（不重起），落定时采用记录里的，不让旧快照写回', () => {
    const snap: Profile = { engine: 'codex', model: 'old-model' };
    const latest: Profile = { engine: 'codex', model: 'new-model' };
    assert.equal(mountDrift(snap, snap, latest), null, '非 kiro 的 model 不触发重起');
    const p = adoptRecordFields({ ...snap }, latest);
    assert.equal(p.model, 'new-model');
    /* 记录里没有 model：保持这次起来的（attach 那边给的 'default'） */
    assert.equal(adoptRecordFields({ engine: 'claude', model: 'default' }, { engine: 'claude' }).model, 'default');
    /* kiro：model 是挂载自己挑的（降级 / 远端清单），不在这里换成记录的（期间被改由 mountDrift 判重起） */
    assert.equal(adoptRecordFields({ model: 'deepseek-3.2' }, { model: 'claude-opus-5' }).model, 'deepseek-3.2');
  });

  test('MountDriftError 带着原因', () => {
    const e = new MountDriftError('engine');
    assert.ok(e instanceof Error);
    assert.equal(e.drift, 'engine');
  });
});

/*
 * 场景：用假的挂载 Promise 复现「挂载在飞时冷切换」。
 * `attach` 是 loadSessionImpl 的骨架：开头读记录 → 起执行器（要时间）→ 落定前 mountDrift 重读 → 写记录；漂移就按记录重起。
 * `coldSwitch` 是 switch*Impl 的骨架：先等挂载锁 → 有执行器走「已连着」（换执行器 + 写记录），没有走「未连接」（只写记录）。
 */
const scenario = (opts: { waitForLock: boolean; driftGuard: boolean; startMs?: number }) => {
  const record: { profile: Profile; engineChangedSent: string[] } = {
    profile: { engine: 'codex', remote: { sshHost: 'old-host' }, mcpCombo: 'c1', model: 'default', engineModels: { codex: 'gpt-5.5' } },
    engineChangedSent: [],
  };
  const attachInFlight = new Map<string, Promise<unknown>>();
  const lock = new SessionMountLock([(sid) => attachInFlight.get(sid)]);
  const live = new Map<string, Profile>();
  const log: string[] = [];
  const attachOnce = async (id: string) => {
    const snapshot: Profile = JSON.parse(JSON.stringify(record.profile));        // 开头读记录
    const started: Profile = { ...snapshot };
    await tick(opts.startMs ?? 25);                                               // 起执行器
    const latest = record.profile;
    if (opts.driftGuard) {
      const drift = mountDrift(snapshot, started, latest);
      if (drift) { log.push(`drift:${drift}`); throw new MountDriftError(drift); }
    }
    const profile = opts.driftGuard ? adoptRecordFields(started, latest) : started;
    live.set(id, profile);
    /* 修复前的样子：整份 profile 写回（等价于后来 setEngineOption 那种 `rec.profile = entry.profile`） */
    record.profile = { ...profile };
  };
  const attach = (id: string) => {
    const existing = attachInFlight.get(id);
    if (existing) return existing;
    const p = (async () => {
      for (let i = 0; ; i++) {
        try { return await attachOnce(id); } catch (e) { if (!(e instanceof MountDriftError) || i >= 2) throw e; }
      }
    })().finally(() => attachInFlight.delete(id));
    attachInFlight.set(id, p);
    return p;
  };
  const coldSwitch = async (id: string, patch: Partial<Profile>) => {
    if (opts.waitForLock) await lock.settle(id);
    const old = live.get(id);
    if (!old) {
      record.profile = { ...record.profile, ...patch };
      if (patch.engine) record.engineChangedSent.push(patch.engine);
      await attach(id);                                                           // 渲染层 / 断线恢复随后按新记录接上
      return 'cold';
    }
    await tick(5);                                                                // 已连着：先起新的、再断旧的
    const profile = { ...old, ...patch };
    live.set(id, profile);
    record.profile = { ...profile };
    if (patch.engine) record.engineChangedSent.push(patch.engine);
    return 'hot';
  };
  return { record, live, log, attach, coldSwitch, lock };
};

describe('挂载进行中冷切换：最终记录和起来的执行器都是用户刚选的', () => {
  test('修复前：不等锁也不重读 —— 记录被写回 codex，执行器仍是 codex（正是用户看到的）', async () => {
    const s = scenario({ waitForLock: false, driftGuard: false });
    void s.attach('s');
    await tick(2);
    await s.coldSwitch('s', { engine: 'claude' });
    await tick(60);
    assert.equal(s.live.get('s')!.engine, 'codex');
    assert.equal(s.record.profile.engine, 'codex');
    assert.deepEqual(s.record.engineChangedSent, ['claude'], '界面以为已经是 Claude Code');
  });

  for (const [what, patch, check] of [
    ['引擎', { engine: 'claude' }, (p: Profile) => p.engine === 'claude'],
    ['机器', { remote: { sshHost: 'ec2-user@99.83.165.184' } }, (p: Profile) => p.remote?.sshHost === 'ec2-user@99.83.165.184'],
    ['MCP 配置', { mcpCombo: 'c2' }, (p: Profile) => p.mcpCombo === 'c2'],
  ] as const) {
    test(`换${what}：先等挂载落定，走「已连着」那条，记录和执行器都是新的`, async () => {
      const s = scenario({ waitForLock: true, driftGuard: true });
      void s.attach('s');
      await tick(2);
      const branch = await s.coldSwitch('s', patch as Partial<Profile>);
      assert.equal(branch, 'hot', '等完之后执行器已经在了，该走已连着那条');
      assert.ok(check(s.live.get('s')!), `执行器：${JSON.stringify(s.live.get('s'))}`);
      assert.ok(check(s.record.profile), `记录：${JSON.stringify(s.record.profile)}`);
    });

    test(`换${what}：锁等超时（或别的路绕过了锁），挂载落定前重读记录 → 丢掉旧的、按新记录重起`, async () => {
      const s = scenario({ waitForLock: false, driftGuard: true });
      void s.attach('s');
      await tick(2);
      const branch = await s.coldSwitch('s', patch as Partial<Profile>);
      assert.equal(branch, 'cold');
      assert.ok(check(s.live.get('s')!), `执行器：${JSON.stringify(s.live.get('s'))}`);
      assert.ok(check(s.record.profile), `记录：${JSON.stringify(s.record.profile)}`);
      assert.equal(s.log.length, 1, '丢掉一次、按记录重起一次');
    });
  }

  test('挂载落定写记录时，不覆盖期间被改的 engine / remote / mcpCombo / engineModels', async () => {
    const s = scenario({ waitForLock: false, driftGuard: true });
    void s.attach('s');
    await tick(2);
    /* 期间四样一起被改（模拟几次冷切换 + 别处改了 engineModels） */
    s.record.profile = {
      ...s.record.profile,
      engine: 'claude', remote: { sshHost: 'new-host' }, mcpCombo: 'c9', engineModels: { claude: 'opus' },
    };
    await s.attach('s');
    assert.equal(s.record.profile.engine, 'claude');
    assert.equal(s.record.profile.remote?.sshHost, 'new-host');
    assert.equal(s.record.profile.mcpCombo, 'c9');
    assert.deepEqual(s.record.profile.engineModels, { claude: 'opus' });
    assert.equal(s.live.get('s')!.engine, 'claude');
  });
});

describe('MCP 晚就绪重连期间改引擎：重连按新引擎起', () => {
  test('重连那段（detach → 断线恢复挂上）登记进锁；冷切换等它，重连按最新记录起', async () => {
    const record: { profile: Profile } = { profile: { engine: 'codex', remote: { sshHost: 'h' } } };
    const lock = new SessionMountLock();
    const live = new Map<string, Profile>();
    live.set('s', { ...record.profile });
    /* reconnectForwardNow 的骨架：detach → 断线恢复按记录 attach；整段 hold 在锁里 */
    const reconnectForward = (id: string) => lock.hold(id, (async () => {
      live.delete(id);
      await tick(10);                                                           // detach / 退避
      const snapshot = { ...record.profile };                                   // attach 开头读记录
      await tick(20);                                                           // 起执行器
      const drift = mountDrift(snapshot, snapshot, record.profile);
      live.set(id, drift ? { ...record.profile } : adoptRecordFields(snapshot, record.profile));
    })());
    void reconnectForward('s');
    await tick(15);                                                              // 正卡在「起执行器」那一段
    await lock.settle('s');
    const old = live.get('s');
    assert.ok(old, '等完之后执行器在：走已连着那条');
    const profile = { ...old, engine: 'claude' };
    live.set('s', profile);
    record.profile = profile;
    assert.equal(live.get('s')!.engine, 'claude');
    assert.equal(record.profile.engine, 'claude');
  });
});

describe('接线：index.ts 里真的用上了', () => {
  const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const head = (anchor: string, until: string): string => {
    const at = MAIN.indexOf(anchor);
    assert.ok(at > 0, `找不到 ${anchor}`);
    const end = MAIN.indexOf(until, at);
    assert.ok(end > at, `${anchor} 之后找不到 ${until}`);
    return MAIN.slice(at, end);
  };

  test('只有一把公共的挂载锁：attach 在飞、断线恢复那一轮都是它的来源', () => {
    assert.match(MAIN, /const mountLock = new SessionMountLock\(\[[\s\S]{0,200}attachInFlight\.get\(sid\)[\s\S]{0,200}remoteRecovery\.inFlight\(sid\)/);
  });

  for (const [name, anchor, until] of [
    ['换引擎', 'const switchEngineImpl = async (', 'const oldEntry = sessionClients.get(sessionId);'],
    ['换机器', 'const applySessionTarget = async (', 'const oldEntry = sessionClients.get(sessionId);'],
    ['换组合', 'const switchMcpComboImpl = async (', 'const oldEntry = sessionClients.get(sessionId);'],
    ['换模型', 'const switchModelImpl = async (', 'const oldEntry = sessionClients.get(sessionId);'],
  ] as const) {
    test(`${name}：判断连没连着之前先等挂载锁`, () => {
      assert.match(head(anchor, until), /await mountLock\.settle\(sessionId\)/);
    });
  }

  test('MCP 晚就绪重连：整段（detach → 断线恢复）登记进挂载锁', () => {
    assert.match(head('function reconnectForwardNow(', '\n}\n'), /mountLock\.hold\(sessionId,/);
  });

  test('attach 落定前（sessionClients.set 之前）重读记录判漂移，漂移就丢掉重起', () => {
    const body = head('const attachOnce = async () => {', "ipcMain.handle('acp:load-session'");
    const driftAt = body.indexOf('mountDrift(');
    const setAt = body.indexOf('sessionClients.set(sessionId, entry);');
    assert.ok(driftAt > 0 && setAt > driftAt, 'mountDrift 要在 sessionClients.set 之前');
    assert.match(body.slice(driftAt, setAt), /throw new MountDriftError\(drift\)/);
    assert.match(body.slice(driftAt, setAt), /adoptRecordFields\(/);
    /* 采用的值要落到后面「persist effective model」比对用的那个 profile 上，不然旧 model 照样写回 */
    assert.match(body.slice(driftAt, setAt), /Object\.assign\(profile, adopted\)/);
    assert.match(body, /instanceof MountDriftError/);
  });

  test('引擎没换成：界面回到实际引擎，会话里说原因', () => {
    const body = head('const switchEngineImpl = async (', "ipcMain.handle('acp:switch-engine'");
    const catchAt = body.indexOf('} catch (err) {');
    assert.ok(catchAt > 0);
    const c = body.slice(catchAt);
    assert.match(c, /session:engine-changed', \{ sessionId, engine: before \}/);
    assert.match(c, /sessionNotice\(sessionId, tr\('⚠️ Could not switch this session to \{engine\} \(\{reason\}\); it still runs on \{current\}\./);
  });
});
