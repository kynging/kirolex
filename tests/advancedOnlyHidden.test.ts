import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAdvancedOnly, ADVANCED_ONLY_PURPOSES, findAdvancedBackups, vetBackupRecord } from '../src/main/advancedOnly.ts';

/*
  标准版和 kirolex-advanced 共用 ~/.kirolex。带 `purpose` ∈ {flow-main, flow-worker, skill} 的会话是
  advanced 的：标准版不列出它、不改它的任何文件（record.json / transcript 字节不变）。

  sessionStore 的路径在模块加载时按 os.homedir() 定 —— 先把 HOME / USERPROFILE 指到临时目录再 import，
  真跑一遍，不碰用户自己的 ~/.kirolex。
*/
const read = (rel: string): string => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');
const main = read('../src/main/index.ts');

describe('isAdvancedOnly: the one shared criterion', () => {
  test('exactly the three advanced purposes', () => {
    assert.deepEqual([...ADVANCED_ONLY_PURPOSES].sort(), ['flow-main', 'flow-worker', 'skill']);
    for (const p of ['flow-main', 'flow-worker', 'skill']) assert.equal(isAdvancedOnly({ purpose: p }), true, p);
    for (const p of [undefined, '', 'main', 'chat', 42]) assert.equal(isAdvancedOnly({ purpose: p as any }), false, String(p));
    assert.equal(isAdvancedOnly(null), false);
    assert.equal(isAdvancedOnly(undefined), false);
  });
});

describe('findAdvancedBackups: cloud-only backups (no local record) are recognised from the bucket record.json', () => {
  const bucket: Record<string, string | Error | null> = {
    c_main: JSON.stringify({ id: 'c_main', purpose: 'flow-main', flow: '周报' }),
    c_worker: JSON.stringify({ id: 'c_worker', purpose: 'flow-worker' }),
    c_skill: JSON.stringify({ id: 'c_skill', purpose: 'skill' }),
    c_std: JSON.stringify({ id: 'c_std', title: 'plain chat' }),
    c_missing: null,
    c_broken: '{not json',
    c_error: new Error('503 SlowDown'),
  };
  const fetchRecord = async (id: string) => {
    const v = bucket[id];
    if (v instanceof Error) throw v;
    return v === null || v === undefined ? null : Buffer.from(v);
  };

  test('each of the three advanced purposes → advanced; standard / missing → neither', async () => {
    const r = await findAdvancedBackups(Object.keys(bucket), fetchRecord);
    assert.deepEqual([...r.advanced].sort(), ['c_main', 'c_skill', 'c_worker']);
    assert.equal(r.advanced.has('c_std') || r.unreadable.has('c_std'), false);
    assert.equal(r.advanced.has('c_missing') || r.unreadable.has('c_missing'), false);
  });

  test('read failure / corrupt record / bad id → unreadable (callers must not delete those)', async () => {
    const r = await findAdvancedBackups([...Object.keys(bucket), '../evil'], fetchRecord);
    assert.deepEqual([...r.unreadable].sort(), ['../evil', 'c_broken', 'c_error']);
  });

  test('empty input does not call the bucket', async () => {
    let calls = 0;
    const r = await findAdvancedBackups([], async () => { calls++; return null; });
    assert.equal(calls, 0);
    assert.equal(r.advanced.size + r.unreadable.size, 0);
  });
});

describe('sessionStore hides and protects advanced-only sessions', () => {
  let home = '';
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let store: typeof import('../src/main/sessionStore.ts');
  const sessions = () => path.join(home, '.kirolex', 'sessions');
  const ADV = ['s_adv_main', 's_adv_worker', 's_adv_skill'];
  const PURPOSE: Record<string, string> = { s_adv_main: 'flow-main', s_adv_worker: 'flow-worker', s_adv_skill: 'skill' };

  const seed = (id: string, extra: Record<string, unknown>) => {
    const dir = path.join(sessions(), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({
      schemaVersion: 1, id, createdAt: 1, updatedAt: 1000, title: id, profile: { projectId: 'p' },
      executorState: 'attached', ...extra,
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), JSON.stringify({ id: 'm1', role: 'user', content: 'hi', ts: 5 }) + '\n');
  };
  const bytesOf = (id: string) => ({
    record: fs.readFileSync(path.join(sessions(), id, 'record.json')),
    transcript: fs.readFileSync(path.join(sessions(), id, 'transcript.jsonl')),
  });

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-adv-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assert.equal(os.homedir(), home);
    seed('s_std', {});
    for (const id of ADV) seed(id, { purpose: PURPOSE[id], flow: '周报' });
    store = await import('../src/main/sessionStore.ts');
  });
  after(() => {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('listSessions() skips them; the standard one stays', () => {
    assert.deepEqual(store.listSessions().map((r) => r.id), ['s_std']);
    assert.deepEqual([...store.listAdvancedOnlyIds()].sort(), [...ADV].sort());
    assert.equal(store.isAdvancedOnlySession('s_adv_main'), true);
    assert.equal(store.isAdvancedOnlySession('s_std'), false);
    assert.equal(store.isAdvancedOnlySession('s_missing'), false);
  });

  test('no by-id write changes their record.json or transcript bytes', () => {
    for (const id of ADV) {
      const before = bytesOf(id);
      const rec = JSON.parse(before.record.toString('utf8'));
      store.writeRecord({ ...rec, title: 'hijacked', archived: true, profile: { projectId: 'other' } });
      store.writeRecordKeepUpdatedAt({ ...rec, title: 'hijacked' });
      assert.equal(store.patchRecord(id, { title: 'hijacked', purpose: undefined } as any), 'refused');
      store.appendMessage(id, { id: 'm2', role: 'user', content: 'from standard', ts: 9 });
      assert.throws(() => store.rewriteTranscript(id, []));
      assert.throws(() => store.truncateTranscriptBefore(id, 'm1'));
      store.deleteSession(id);
      store.markAllExecutorsDetached();
      assert.ok(fs.existsSync(path.join(sessions(), id)), `${id} still exists`);
      const after = bytesOf(id);
      assert.ok(after.record.equals(before.record), `${id} record.json unchanged`);
      assert.ok(after.transcript.equals(before.transcript), `${id} transcript unchanged`);
    }
  });

  test('context override: save, empty save (= clear) and clear leave the dir byte-identical', () => {
    for (const id of ADV) {
      const dir = path.join(sessions(), id);
      const snapshot = () => fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f)).toString('base64')]);
      // 没有 override 时：保存不会建出文件
      const before = snapshot();
      assert.throws(() => store.writeContextOverride(id, 'from standard'));
      assert.equal(store.clearContextOverride(id), false);
      assert.deepEqual(snapshot(), before, `${id} unchanged (no override yet)`);
      // advanced 自己写过 override 时：覆盖、清除都不动它
      fs.writeFileSync(path.join(dir, 'context-override.md'), 'advanced owns this');
      const withOverride = snapshot();
      assert.throws(() => store.writeContextOverride(id, 'overwrite'));
      assert.equal(store.clearContextOverride(id), false);
      assert.deepEqual(snapshot(), withOverride, `${id} override untouched`);
    }
  });

  test('note-style writes (append + history.md refresh + injection snapshot) leave the whole dir byte-identical', () => {
    for (const id of ADV) {
      const dir = path.join(sessions(), id);
      // advanced 已经有 history.md（refreshHistoryFile 只刷新已有的那份）
      fs.writeFileSync(path.join(dir, 'history.md'), '# advanced history\n');
      const snapshot = () => fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f)).toString('base64')]);
      const before = snapshot();
      store.appendMessage(id, { id: 'n1', role: 'user', content: '⚠️ note', ts: 10, kirolex: true });
      assert.throws(() => store.writeHistoryFile(id, '# rewritten by standard\n'));
      assert.throws(() => store.writeLastInjection(id, 'snapshot'));
      assert.deepEqual(snapshot(), before, `${id} dir unchanged`);
    }
  });

  /** 整棵目录树（路径 + 字节）—— 「整个目录字节不变」的判据 */
  const tree = (root: string): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { out.push([path.relative(root, full) + '/', '']); walk(full); }
        else out.push([path.relative(root, full), fs.readFileSync(full).toString('base64')]);
      }
    };
    walk(root);
    return out;
  };

  test('startup retry of leftover deletions (deleted-sessions.json) skips advanced sessions, dirs byte-identical', () => {
    // advanced 目录里多放点东西：子目录、history.md
    for (const id of ADV) {
      fs.mkdirSync(path.join(sessions(), id, 'files', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(sessions(), id, 'files', 'sub', 'a.txt'), `owned by advanced ${id}`);
    }
    // 一条标准版自己没删完的会话 —— 照旧该被删掉
    seed('s_tomb', {});
    const before = Object.fromEntries(ADV.map((id) => [id, tree(path.join(sessions(), id))]));
    const r = store.retryPendingDeletions([...ADV, 's_tomb', 's_already_gone']);
    for (const id of ADV) {
      assert.ok(fs.existsSync(path.join(sessions(), id)), `${id} not deleted`);
      assert.deepEqual(tree(path.join(sessions(), id)), before[id], `${id} dir byte-identical`);
    }
    assert.deepEqual([...r.skippedAdvanced].sort(), [...ADV].sort());
    // 不压住 advanced 的 id；墓碑留给 advanced 自己
    assert.deepEqual(r.suppress, ['s_tomb', 's_already_gone']);
    assert.deepEqual([...r.keep].sort(), [...ADV].sort());
    assert.equal(fs.existsSync(path.join(sessions(), 's_tomb')), false, 'standard leftover still removed');
  });

  test('loop-runs: persist / begin-round / clear leave advanced loop files byte-identical, and never create one', async () => {
    const loopStore = await import('../src/main/loopStore.ts');
    const guard = store.isAdvancedOnlySession;
    const run = (sessionId: string) => ({ spec: { stop: { maxIterations: 5 } }, sessionId, iteration: 1, startedAt: 1, terminal: null });
    for (const id of ADV) {
      const file = loopStore.loopRunPath(id, home);
      // 缺文件：都不新建
      assert.throws(() => loopStore.writeLoop(id, run(id), home, guard));
      assert.ok(loopStore.beginRound(id, home, Date.now(), guard).error);
      loopStore.clearLoop(id, home, guard);
      assert.equal(fs.existsSync(file), false, `${id}: no loop file created`);
      // 已有文件（advanced 写的）：覆盖、记轮次、删除都不动它
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ run: run(id), updatedAt: 1 }, null, 2));
      const bytes = fs.readFileSync(file);
      assert.throws(() => loopStore.writeLoop(id, { ...run(id), iteration: 4 }, home, guard));
      const r = loopStore.beginRound(id, home, Date.now(), guard);
      assert.equal(r.run, null);
      assert.ok(r.error);
      loopStore.clearLoop(id, home, guard);
      assert.ok(fs.readFileSync(file).equals(bytes), `${id}: loop file byte-identical`);
    }
    // 标准会话照旧
    loopStore.writeLoop('s_std', run('s_std'), home, guard);
    assert.equal(loopStore.beginRound('s_std', home, Date.now(), guard).run?.iteration, 2);
    loopStore.clearLoop('s_std', home, guard);
    assert.equal(fs.existsSync(loopStore.loopRunPath('s_std', home)), false);
  });

  test('memory: no layer call creates, writes, backs up or deletes an advanced session\'s memory/sessions/<id>', async () => {
    const memory = await import('../src/main/memory.ts');
    const memRoot = path.join(home, '.kirolex', 'memory', 'sessions');
    const every = (id: string) => {
      memory.ensureMemoryFiles('p', id);
      memory.readMemory('p', id);
      memory.readMemory(undefined, id);
      memory.memoryLayerBytes('p', id);
      memory.buildMemoryInjection('p', id);
      // 全局 / 项目层带着 sessionId 保存：照常写共享层，但不顺手建会话层
      memory.writeMemory('global', 'p', id, '# g\n');
      memory.writeMemory('project', 'p', id, '# p\n');
      assert.throws(() => memory.writeMemory('session', 'p', id, 'from standard'));
      assert.equal(memory.backupMemoryLayer('session', 'p', id, '2026-10-16T00-00-00-000Z'), null);
      memory.backupMemoryLayer('global', 'p', id, '2026-10-16T00-00-01-000Z');
      memory.backupMemoryLayer('project', 'p', id, '2026-10-16T00-00-02-000Z');
      memory.deleteSessionMemory(id);
    };
    for (const id of ADV) {
      // 缺失：一个文件、一个目录都不新建
      every(id);
      assert.equal(fs.existsSync(path.join(memRoot, id)), false, `${id}: no session memory dir created`);
      // 已有记忆 + 备份：字节不变
      const dir = path.join(memRoot, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'memory.md'), `# advanced memory ${id}\n- fact\n`);
      for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, `memory.2026-01-0${i + 1}T00-00-00-000Z.bak`), `old ${i}`);
      const before = tree(dir);
      every(id);
      assert.deepEqual(tree(dir), before, `${id}: memory dir byte-identical`);
    }
    // 共享层照常、标准会话照常
    assert.equal(fs.readFileSync(path.join(home, '.kirolex', 'memory', 'global.md'), 'utf8'), '# g\n');
    memory.writeMemory('session', 'p', 's_std', 'std fact');
    assert.equal(fs.readFileSync(path.join(memRoot, 's_std', 'memory.md'), 'utf8'), 'std fact');
  });

  test('schedules: advanced jobs are not listed, not rewritten, not removed; none created for them', async () => {
    const scheduleStore = await import('../src/main/scheduleStore.ts');
    const guard = store.isAdvancedOnlySession;
    const state = (sessionId: string) => ({ sessionId, spec: { prompt: 'x', everySec: 60, maxRuns: 3 }, runs: 0, createdAt: 1, paused: false, terminal: null } as any);
    for (const id of ADV) {
      assert.throws(() => scheduleStore.writeSchedule(`new_${id}`, state(id), home, guard));
      assert.equal(fs.existsSync(path.join(scheduleStore.scheduleDir(home), `new_${id}.json`)), false, `${id}: no job created`);
      // advanced 自己的任务文件
      scheduleStore.writeSchedule(`job_${id}`, state(id), home);
      const file = path.join(scheduleStore.scheduleDir(home), `job_${id}.json`);
      const bytes = fs.readFileSync(file);
      assert.throws(() => scheduleStore.writeSchedule(`job_${id}`, { ...state(id), runs: 2 }, home, guard));
      // 换成别的 sessionId 去覆盖它也不行
      assert.throws(() => scheduleStore.writeSchedule(`job_${id}`, state('s_std'), home, guard));
      scheduleStore.removeSchedule(`job_${id}`, home, guard);
      assert.ok(fs.readFileSync(file).equals(bytes), `${id}: job file byte-identical`);
    }
    scheduleStore.writeSchedule('job_std', state('s_std'), home, guard);
    assert.deepEqual(scheduleStore.listSchedules(home, guard).map((j) => j.id), ['job_std']);
    assert.equal(scheduleStore.listSchedules(home).length, 1 + ADV.length, 'without the guard: old behaviour');
    scheduleStore.removeSchedule('job_std', home, guard);
    assert.equal(scheduleStore.readSchedule('job_std', home), null);
  });

  test('deck / review writes: a previewed .pptx in an advanced session is not backed up or rewritten; standard still saves', async () => {
    const { pickReviewTarget } = await import('../src/main/reviewAccess.ts');
    const backups = path.join(home, '.kirolex', 'backups', 'review-files');
    /*
      和 deck:write-slide-text / deck:write-note / review:write-file 同一个顺序：
      先过 reviewTarget 这道关（index.ts 传进来的 refuse = 共享判据），过了才备份、才写。
      `reviewed: () => true` = 审查里说的那条路：先用 workspace:read / preview:deck 把文件登记成"预览过"。
    */
    const saveSlideText = (sessionId: string, file: string, next: Buffer) => {
      const t = pickReviewTarget<{ sshHost: string }>({
        raw: file,
        resolveLocal: (raw) => raw,
        localExists: (p) => fs.existsSync(p),
        remoteFor: () => null,
        reviewed: () => true,
        refuse: () => (store.isAdvancedOnlySession(sessionId) ? 'advanced' : null),
      });
      if (!t.ok) return t;
      fs.mkdirSync(backups, { recursive: true });
      fs.copyFileSync(t.want, path.join(backups, `${sessionId}.pptx.bak`));
      fs.writeFileSync(t.want, next);
      return t;
    };
    const pptx = (id: string) => {
      const dir = path.join(sessions(), id, 'files');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'deck.pptx');
      fs.writeFileSync(file, Buffer.from(`PK\u0003\u0004 original deck of ${id}`));
      return file;
    };
    for (const id of ADV) {
      const file = pptx(id);
      const before = tree(path.join(sessions(), id));
      const r = saveSlideText(id, file, Buffer.from('PK edited by standard'));
      assert.equal(r.ok, false, id);
      assert.deepEqual(tree(path.join(sessions(), id)), before, `${id}: pptx byte-identical`);
      assert.equal(fs.existsSync(path.join(backups, `${id}.pptx.bak`)), false, `${id}: no backup created`);
    }
    const std = pptx('s_std');
    assert.equal(saveSlideText('s_std', std, Buffer.from('PK edited')).ok, true);
    assert.equal(fs.readFileSync(std, 'utf8'), 'PK edited');
    assert.ok(fs.existsSync(path.join(backups, 's_std.pptx.bak')));
  });

  test('standard sessions are still writable as before', () => {
    const rec = store.readRecord('s_std')!;
    store.writeRecord({ ...rec, title: 'renamed' });
    assert.equal(store.readRecord('s_std')!.title, 'renamed');
    assert.equal(store.patchRecord('s_std', { pinned: true }), 'written');
    store.appendMessage('s_std', { id: 'm2', role: 'user', content: 'ok', ts: 9 });
    assert.equal(store.readTranscript('s_std').length, 2);
  });
});

describe('index.ts by-id entry points refuse advanced-only sessions', () => {
  const bodyOf = (marker: string) => {
    const at = main.indexOf(marker);
    assert.ok(at >= 0, `missing ${marker}`);
    return main.slice(at, at + 1500);
  };
  for (const marker of [
    'const loadSessionImpl = async',
    "ipcMain.handle('acp:prompt'",
    'const purgeSession = async',
    "ipcMain.handle('acp:delete-session'",
    "ipcMain.handle('acp:archive-session'",
    "ipcMain.handle('acp:assign-project'",
    "ipcMain.handle('acp:set-project'",
    "ipcMain.handle('acp:move-session'",
    'const switchModelImpl = async',          // acp:switch-model 的实现（忙时 pending 也走它）
    'const switchKiroAgentImpl = async',      // acp:switch-kiro-agent
    'const switchEngineImpl = async',         // acp:switch-engine
    'const setEngineOption = ',
    "ipcMain.handle('acp:mark-session-purpose'",
    "ipcMain.handle('s3:restore'",
    "ipcMain.handle('s3:keep-local'",
    "ipcMain.handle('acp:write-context-override'",
    "ipcMain.handle('acp:clear-context-override'",
    "ipcMain.handle('acp:persist-steer'",
    "ipcMain.handle('acp:persist-note'",
    "ipcMain.handle('acp:mark-cleared'",
    "ipcMain.handle('acp:clear-context'",
    "ipcMain.handle('acp:truncate-transcript-before'",
    "ipcMain.handle('acp:rewrite-transcript'",
    "ipcMain.handle('acp:set-remote-target'",
    'const switchPermissionModeImpl = async', // acp:switch-permission-mode
    'const switchMcpComboImpl = async',       // acp:switch-mcp-combo
    "ipcMain.handle('acp:prime-history'",
    "ipcMain.handle('acp:ensure-context'",
    "ipcMain.handle('acp:rename-session'",
    "ipcMain.handle('acp:set-session-pinned'",
    "ipcMain.handle('acp:set-prime-mode'",
    "ipcMain.handle('loop:register-verifier'",
    "ipcMain.handle('loop:verify'",
    "ipcMain.handle('schedule:create'",
    "ipcMain.handle('schedule:pause'",
    "ipcMain.handle('schedule:remove'",
    "ipcMain.handle('workspace:copy-remote-to-local'",
    "ipcMain.handle('review:backup-file'",
    'const writeReviewFile = async (',   // review:write-file 和改写那条路共用的写盘函数
    "ipcMain.handle('deck:write-note'",
    "ipcMain.handle('app:set-auto-resent'",
    "ipcMain.handle('app:set-draft-pastes'",
    'async function maybeConsolidateSessionMemory(',
  ]) {
    test(marker, () => assert.match(bodyOf(marker), /refuseAdvancedOnly\(/));
  }

  test('the guard uses the shared store criterion', () => {
    const fn = bodyOf('function refuseAdvancedOnly');
    assert.match(fn, /store\.isAdvancedOnlySession\(/);
  });
});

describe('S3 pages recognise hidden advanced sessions', () => {
  test('restore list drops them (not "restorable", not "missing locally → clean up")', () => {
    const h = main.slice(main.indexOf("ipcMain.handle('s3:list-backups'"));
    const body = h.slice(0, h.indexOf('\n  });'));
    assert.match(body, /const hidden = await advancedBackupIds\(creds!, cfg\.prefix, catalog, local\)/);
    assert.match(body, /\.filter\(\(e\) => !hidden\.has\(e\.id\)\)/);
  });

  test('deleting bucket backups never deletes theirs (local hidden, cloud advanced, or unreadable)', () => {
    for (const name of ["ipcMain.handle('s3:delete-sessions'", "ipcMain.handle('s3:delete-project'"]) {
      const h = main.slice(main.indexOf(name));
      const body = h.slice(0, h.indexOf('\n  });'));
      assert.match(body, /store\.listAdvancedOnlyIds\(\)/, name);
      const check = body.indexOf('await cloudAdvancedBackups(');
      assert.ok(check > 0, name);
      assert.ok(check < body.indexOf('deleteBackupsOf('), `${name}: checked before deleting`);
      assert.match(body, /!cloud\.advanced\.has\(/, name);
      assert.match(body, /!cloud\.unreadable\.has\(/, name);
    }
  });

  test('restore list also drops cloud-only advanced backups', () => {
    const h = main.slice(main.indexOf("ipcMain.handle('s3:list-backups'"));
    const body = h.slice(0, h.indexOf('\n  });'));
    const ids = main.slice(main.indexOf('async function advancedBackupIds'));
    const idsBody = ids.slice(0, ids.indexOf('\n}'));
    assert.match(idsBody, /store\.listAdvancedOnlyIds\(\)/);
    assert.match(idsBody, /await cloudAdvancedBackups\(/);
    assert.match(idsBody, /\.\.\.cloud\.advanced/);
    const helper = main.slice(main.indexOf('function cloudAdvancedBackups'));
    assert.match(helper.slice(0, helper.indexOf('\n}')), /findAdvancedBackups\(/);
  });

  test('paste GC still counts their attachments as referenced (hidden ≠ gone)', () => {
    const at = main.indexOf('const referenced = new Set<string>();');
    assert.match(main.slice(at, at + 600), /store\.listAdvancedOnlyIds\(\)/);
  });

  test('restore refuses a backup whose record is advanced-only', () => {
    const h = main.slice(main.indexOf("ipcMain.handle('s3:restore'"));
    const body = h.slice(0, h.indexOf('\n  });'));
    // 先判、再动本地文件（挪 trash / 写文件都在后面）
    const check = body.indexOf('await refuseAdvancedBackup(creds!, prefix, objects, sessionId)');
    assert.ok(check > 0);
    // 被拒（advanced 或读不出来）就在动任何本地文件之前返回
    assert.match(body, /const vetted = await refuseAdvancedBackup\(creds!, prefix, objects, sessionId\); if \('refused' in vetted\) return \{ ok: false, error: vetted\.refused \};/);
    for (const write of ['backedUp = trashDirFor(', 'fs.writeFileSync(', 'fs.mkdirSync(', 'fs.cpSync(']) {
      assert.ok(check < body.indexOf(write), `checked before ${write}`);
    }
    // 写盘用已校验的那份 record.json，不再 GET 第二次
    assert.match(body, /const body = await vetted\.get\(obj\.key\);/);
    const helper = main.slice(main.indexOf('async function refuseAdvancedBackup'));
    const helperBody = helper.slice(0, helper.indexOf('\n}'));
    assert.match(helperBody, /await vetBackupRecord\(recordKey,/);
    assert.match(helperBody, /vetted && key === recordKey \? vetted : getObject\(creds, key\)/);
  });
});

describe('vetBackupRecord: restore only what is confirmed not advanced', () => {
  const KEY = 'v1/sessions/c_x/record.json';
  /** 第一次 GET 失败、之后成功 —— 审查里说的那条绕过路径 */
  const flaky = (text: string) => {
    let calls = 0;
    const get = async () => { calls++; if (calls === 1) throw new Error('503 SlowDown'); return Buffer.from(text); };
    return { get, calls: () => calls };
  };

  test('first read fails (later reads would succeed) → refused as unreadable, no second read', async () => {
    for (const purpose of ['flow-main', 'flow-worker', 'skill', undefined]) {
      const f = flaky(JSON.stringify({ id: 'c_x', ...(purpose ? { purpose } : {}) }));
      const v = await vetBackupRecord(KEY, f.get);
      assert.deepEqual(v, { ok: false, reason: 'unreadable' }, String(purpose));
      assert.equal(f.calls(), 1);
    }
  });

  test('each advanced purpose → refused as advanced', async () => {
    for (const purpose of ['flow-main', 'flow-worker', 'skill']) {
      const v = await vetBackupRecord(KEY, async () => Buffer.from(JSON.stringify({ id: 'c_x', purpose })));
      assert.deepEqual(v, { ok: false, reason: 'advanced' }, purpose);
    }
  });

  test('corrupt record → unreadable; standard → ok with exactly the bytes that were vetted (read once)', async () => {
    assert.deepEqual(await vetBackupRecord(KEY, async () => Buffer.from('{torn')), { ok: false, reason: 'unreadable' });
    const bytes = Buffer.from(JSON.stringify({ id: 'c_x', title: 'plain' }));
    let calls = 0;
    const v = await vetBackupRecord(KEY, async () => { calls++; return calls === 1 ? bytes : Buffer.from('{"purpose":"flow-main"}'); });
    assert.equal(v.ok, true);
    assert.ok(v.ok && v.record === bytes);
    assert.equal(calls, 1);
  });

  test('backup without record.json → ok, nothing to vet', async () => {
    let calls = 0;
    assert.deepEqual(await vetBackupRecord(null, async () => { calls++; return Buffer.alloc(0); }), { ok: true, record: null });
    assert.equal(calls, 0);
  });
});

describe('startup tombstone retry and loop IPCs are wired through the shared criterion', () => {
  test('startup retry goes through store.retryPendingDeletions (no raw rmSync on sessions/<id>)', () => {
    const at = main.indexOf('const pending = loadSessionTombstones();');
    assert.ok(at > 0);
    const block = main.slice(at, main.indexOf('} catch {}', at));
    assert.match(block, /store\.retryPendingDeletions\(pending\)/);
    assert.match(block, /for \(const id of suppress\) deletedSessionIds\.add\(id\)/);
    assert.ok(!/rmSync/.test(block));
  });

  for (const [name, call] of [
    ["ipcMain.handle('loop:persist'", /loopStore\.writeLoop\(sessionId, run, os\.homedir\(\), store\.isAdvancedOnlySession\)/],
    ["ipcMain.handle('loop:begin-round'", /loopStore\.beginRound\(sessionId, os\.homedir\(\), Date\.now\(\), store\.isAdvancedOnlySession\)/],
    ["ipcMain.handle('loop:clear'", /loopStore\.clearLoop\(sessionId, os\.homedir\(\), store\.isAdvancedOnlySession\)/],
  ] as const) {
    test(name, () => {
      const h = main.slice(main.indexOf(name));
      const body = h.slice(0, h.indexOf('\n  });'));
      assert.match(body, /refuseAdvancedOnly\(sessionId, 'loop:/);
      assert.match(body, call);
    });
  }

  test('loop:list-live does not hand advanced loops to the renderer', () => {
    const h = main.slice(main.indexOf("ipcMain.handle('loop:list-live'"));
    assert.match(h.slice(0, 200), /\.filter\(\(r\) => !store\.isAdvancedOnlySession\(r\.sessionId\)\)/);
  });
});

describe('memory and schedule IPCs go through the shared criterion before touching files', () => {
  const handler = (name: string) => {
    const h = main.slice(main.indexOf(name));
    return h.slice(0, h.indexOf('\n  });'));
  };

  test('the memory sessionId filter uses refuseAdvancedOnly', () => {
    const at = main.indexOf('const memorySessionId = ');
    assert.ok(at > 0);
    assert.match(main.slice(at, at + 200), /refuseAdvancedOnly\(sessionId, what\) \? undefined : sessionId/);
  });

  test('read-memory / memory-bytes never hand an advanced sessionId to the memory module', () => {
    assert.match(handler("ipcMain.handle('acp:read-memory'"), /readMemory\(projectId, memorySessionId\(sessionId, 'read-memory'\)\)/);
    assert.match(handler("ipcMain.handle('acp:memory-bytes'"), /memoryLayerBytes\(projectId, memorySessionId\(sessionId, 'memory-bytes'\)\)/);
  });

  test('write-memory / backup-memory: session scope refused, global / project proceed without the sessionId', () => {
    for (const [name, call] of [
      ["ipcMain.handle('acp:write-memory'", /writeMemory\(scope, projectId, sid, content\)/],
      ["ipcMain.handle('acp:backup-memory'", /backupMemoryLayer\(scope, projectId, sid, stamp\)/],
    ] as const) {
      const body = handler(name);
      assert.match(body, /const sid = memorySessionId\(sessionId, '/, name);
      assert.match(body, /if \(scope === 'session' && sessionId && !sid\) \{\s*return \{ ok: false/, name);
      assert.ok(body.indexOf('!sid') < body.search(call), `${name}: refused before the file call`);
      assert.match(body, call, name);
    }
  });

  test('scheduler: the ticker, list, create, pause and remove pass the shared criterion to scheduleStore', () => {
    const tick = main.slice(main.indexOf('const scheduleTicker = setInterval('));
    assert.match(tick.slice(0, 600), /scheduleStore\.listSchedules\(os\.homedir\(\), store\.isAdvancedOnlySession\)/);
    assert.match(handler("ipcMain.handle('schedule:list'"), /listSchedules\(os\.homedir\(\), store\.isAdvancedOnlySession\)/);
    for (const name of ["ipcMain.handle('schedule:create'", "ipcMain.handle('schedule:pause'"]) {
      assert.match(handler(name), /writeSchedule\(id, state, os\.homedir\(\), store\.isAdvancedOnlySession\)/, name);
    }
    assert.match(handler("ipcMain.handle('schedule:remove'"), /removeSchedule\(id, os\.homedir\(\), store\.isAdvancedOnlySession\)/);
    const run = main.slice(main.indexOf('async function runScheduledJob('));
    const runBody = run.slice(0, run.indexOf('\n  }\n'));
    assert.equal((runBody.match(/writeSchedule\(id, (charged|final), os\.homedir\(\), store\.isAdvancedOnlySession\)/g) || []).length, 2);
  });
});

describe('deck / review writes go through the refusing gate before any backup or write', () => {
  const handler = (name: string) => {
    const h = main.slice(main.indexOf(name));
    return h.slice(0, h.indexOf('\n  });'));
  };

  test('reviewTarget hands the shared criterion to pickReviewTarget, and the gate checks it first', () => {
    const at = main.indexOf('const reviewTarget = (');
    assert.match(main.slice(at, at + 900), /refuse: \(\) => \(sessionId \? refuseAdvancedOnly\(sessionId, 'review-target'\) : null\)/);
    const access = read('../src/main/reviewAccess.ts');
    const fn = access.slice(access.indexOf('export function pickReviewTarget'));
    const body = fn.slice(fn.indexOf('}): ReviewTarget<R> {'), fn.indexOf('\n}\n'));
    assert.ok(body.indexOf('input.refuse?.()') < body.indexOf('input.reviewed('), 'refused before "previewed" is consulted');
  });

  test('deckTarget goes through reviewTarget', () => {
    const at = main.indexOf('const deckTarget = (');
    assert.match(main.slice(at, at + 400), /const t = reviewTarget\(sessionId, filePath\);\s*if \(!t\.ok\) return t;/);
  });

  test("deck:write-slide-text: the refusing gate (deckTarget → reviewTarget) runs before writeSlideText", () => {
    const body = handler("ipcMain.handle('deck:write-slide-text'");
    assert.match(body, /const g = deckTarget\(sessionId, filePath, page\);\s*if \(!g\.ok\) return g;\s*return writeSlideText\(/);
  });

  test('review:revise-in-session: can only run on an attached session (attach refuses advanced) and writes back through reviewTarget', () => {
    const body = handler("ipcMain.handle('review:revise-in-session'");
    assert.match(body, /await ensureAttached\(sessionId\);/);
    assert.match(body, /reviewTarget\(sessionId, input\.apply\.path\)/);
    const at = main.indexOf('const ensureAttached = async (');
    assert.match(main.slice(at, at + 400), /await loadSessionImpl\(sid,/);
  });

  for (const [name, writes] of [
    ["ipcMain.handle('deck:write-note'", ['backupDeck(', 'runPy(WRITE_NOTE_SCRIPT']],
    ["ipcMain.handle('deck:revise-slide-text'", ['deckTarget(']],
  ] as const) {
    test(`${name}: refused before ${writes.join(' / ')}`, () => {
      const body = handler(name);
      const guard = body.search(/refuseAdvancedOnly\((sessionId|sid), 'deck:/);
      assert.ok(guard > 0, name);
      for (const w of writes) assert.ok(guard < body.indexOf(w), `${name}: before ${w}`);
    });
  }

});

describe('session:note does not touch advanced sessions', () => {
  test('noteInSession (the only path session:note takes) refuses first', () => {
    const h = main.slice(main.indexOf("ipcMain.handle('session:note'"));
    assert.match(h.slice(0, 200), /return noteInSession\(sessionId, text, asVariants\(variants\)\)/);
    const fn = main.slice(main.indexOf('function noteInSession('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const guard = body.indexOf("refuseAdvancedOnly(sid, 'note')");
    assert.ok(guard > 0);
    assert.ok(guard < body.indexOf('store.appendMessage('));
    assert.ok(guard < body.indexOf('refreshHistoryFile('));
  });
});
