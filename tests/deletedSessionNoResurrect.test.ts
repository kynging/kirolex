import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
  「周报」在标准版冒出来：advanced 删掉三条 flow 执行会话后，适配器迟到的 session/new 返回
  把 sessions/<id>/record.json 重新建了出来（「New Chat」、没有 purpose、attached、transcript 为空）。

  sessionStore 的路径在模块加载时按 os.homedir() 定 —— 先把 HOME / USERPROFILE 指到临时目录再 import，
  不碰用户自己的 ~/.kirolex。
*/
const read = (rel: string): string => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');
const main = read('../src/main/index.ts');

let home = '';
let store: typeof import('../src/main/sessionStore.ts');
let gateMod: typeof import('../src/main/lateSessionEvents.ts');
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const deleted = new Set<string>();
const sessions = () => path.join(home, '.kirolex', 'sessions');
const trash = () => path.join(home, '.kirolex', 'trash');
const profile = { model: 'm', preferredModel: 'm', permissionMode: 'auto-approve' as const, projectId: '周报' };

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-resurrect-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home);
  store = await import('../src/main/sessionStore.ts');
  gateMod = await import('../src/main/lateSessionEvents.ts');
  store.setDeletedSessionCheck((id) => deleted.has(id));
});
after(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  fs.rmSync(home, { recursive: true, force: true });
});

/** 正常删除流程的样子：记进删除集合、目录挪进回收站 */
const deleteLikePurge = (id: string) => {
  deleted.add(id);
  fs.mkdirSync(trash(), { recursive: true });
  fs.renameSync(path.join(sessions(), id), path.join(trash(), `${id}__2026-11-13T05-30-16-801Z`));
};

describe('late adapter callbacks after a delete do not rebuild the session', () => {
  test('late session/new success + available_commands_update: dropped, no sessions/<id>/, not attached', () => {
    const id = 's_1794547809803_33yxsj';
    store.createSession(id, profile);
    store.patchRecord(id, { purpose: 'flow-worker', flow: '周报' } as any);
    deleteLikePurge(id);

    const logs: string[] = [];
    const gate = gateMod.lateEventGate({ isDeleted: (sid) => deleted.has(sid), log: (l) => logs.push(l) });
    let attached = false;
    let disconnected = 0;

    // 迟到的 session/new 成功：index.ts 的 new-session 在 sessionClients.set / 写记录之前过这道门
    if (!gate.drop(id, 'session/new', () => { disconnected++; })) {
      const rec = store.readRecord(id) || store.createSession(id, profile);
      rec.executorState = 'attached';
      store.writeRecord(rec);
      attached = true;
    }
    // 迟到的 available_commands_update（client.on('update')）
    const update = { update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'x' }] } };
    if (!gate.drop(id, update.update.sessionUpdate, () => { disconnected++; })) attached = true;

    assert.equal(attached, false);
    assert.equal(disconnected, 2);
    assert.equal(fs.existsSync(path.join(sessions(), id)), false, 'sessions/<id>/ must not be rebuilt');
    assert.equal(store.readRecord(id), null);
    assert.ok(logs.some((l) => /late event for deleted session s_1794547809803_33yxsj .*session\/new.* ignored/.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => /available_commands_update/.test(l)));
  });

  test('a session that is not deleted passes through the gate untouched', () => {
    const gate = gateMod.lateEventGate({ isDeleted: () => false, log: () => assert.fail('no log') });
    let discarded = false;
    assert.equal(gate.drop('s_live', 'session/new', () => { discarded = true; }), false);
    assert.equal(discarded, false);
  });

  test('repeated late updates log once per session + event', () => {
    const logs: string[] = [];
    const gate = gateMod.lateEventGate({ isDeleted: () => true, log: (l) => logs.push(l) });
    for (let i = 0; i < 5; i++) gate.drop('s_gone', 'agent_message_chunk');
    assert.equal(logs.length, 1);
  });

  test('index.ts: new-session checks the gate after session/new returns, before registering the executor', () => {
    const at = main.indexOf('cliSessionId = (await client.newSession(cliCwd)).sessionId;');
    assert.ok(at > 0);
    const gateAt = main.indexOf("lateEvents.drop(kiroLexId, 'session/new'", at);
    const setAt = main.indexOf('sessionClients.set(kiroLexId, entry);', at);
    assert.ok(gateAt > at && setAt > gateAt, 'gate must sit between session/new and sessionClients.set');
  });

  test('index.ts: every session update from the adapter goes through the gate first', () => {
    const at = main.indexOf("client.on('update', onUpdate = (data: any, replayed?: boolean) => {");
    assert.ok(at > 0);
    const body = main.slice(at, main.indexOf('if (entry.priming) return;', at));
    // 攒着的（holdTarget）之后交回 onUpdate(d, true) 时还会再过一次这道门；处理任何内容之前就丢
    assert.match(body, /if \(lateUpdateForDeleted\(data\)\) return;/);
    const helper = main.slice(main.lastIndexOf('const lateUpdateForDeleted = ', at), at);
    assert.match(helper, /lateEvents\.drop\(sessionId, /);
    assert.match(helper, /detachExecutor\(sessionId/);
  });

  test('index.ts: the store write guard is wired to deletedSessionIds + tombstones', () => {
    assert.match(main, /store\.setDeletedSessionCheck\(\(id\) => deletedSessionIds\.has\(id\) \|\| loadSessionTombstones\(\)\.includes\(id\)\)/);
  });
});

describe('store refuses to (re)create a deleted session record', () => {
  test('tombstoned id + missing dir: writeRecord returns false, createSession throws, no directory', () => {
    const id = 's_tomb_writes';
    deleted.add(id);
    const rec = { schemaVersion: 1, id, createdAt: 1, updatedAt: 1, title: 'New Chat', profile, executorState: 'attached' } as any;
    assert.equal(store.writeRecord(rec), false);
    assert.equal(store.writeRecordKeepUpdatedAt(rec), false);
    assert.throws(() => store.createSession(id, profile));
    assert.equal(store.patchRecord(id, { title: 'x' }), 'refused');
    assert.equal(fs.existsSync(path.join(sessions(), id)), false);
  });

  test('not deleted: writes as before (returns true, creates the dir)', () => {
    const id = 's_plain_write';
    const rec = store.createSession(id, profile);
    assert.equal(store.writeRecord({ ...rec, title: 'renamed' }), true);
    assert.equal(store.readRecord(id)?.title, 'renamed');
  });

  test('deleted id whose dir still exists (delete in flight / move failed): every write is refused, files unchanged', () => {
    const id = 's_tomb_dir_still_there';
    const rec = store.createSession(id, profile);
    const dir = path.join(sessions(), id);
    const before = { record: fs.readFileSync(path.join(dir, 'record.json')), transcript: fs.readFileSync(path.join(dir, 'transcript.jsonl')) };
    deleted.add(id);
    assert.equal(store.writeRecord({ ...rec, title: 'New Chat', executorState: 'attached' }), false);
    assert.equal(store.writeRecordKeepUpdatedAt({ ...rec, title: 'x' }), false);
    assert.equal(store.patchRecord(id, { title: 'x' }), 'refused');
    assert.throws(() => store.createSession(id, profile));
    store.appendMessage(id, { id: 'm1', role: 'user', content: 'late', ts: 1 } as any);
    assert.ok(fs.readFileSync(path.join(dir, 'record.json')).equals(before.record), 'record.json unchanged');
    assert.ok(fs.readFileSync(path.join(dir, 'transcript.jsonl')).equals(before.transcript), 'transcript unchanged');
  });

  test('manual restore (beginRestore) is the one exception, and only while it runs', () => {
    const id = 's_tomb_restored';
    deleted.add(id);
    const run = store.beginRestore(id);
    fs.mkdirSync(path.join(sessions(), id), { recursive: true });   // s3:restore 自己 mkdir 再写
    assert.equal(store.writeRecordKeepUpdatedAt({ schemaVersion: 1, id, createdAt: 1, updatedAt: 1, title: 'restored', profile, executorState: 'detached' } as any), true);
    run.end();
    assert.equal(store.writeRecord({ ...store.readRecord(id)!, title: 'after' }), false, 'still tombstoned after the restore ends → refused again');
    assert.equal(store.readRecord(id)?.title, 'restored');
  });
});

describe('startup sweep: resurrected empty shells', () => {
  const seedLive = (id: string, rec: Record<string, unknown>, transcript = '') => {
    const dir = path.join(sessions(), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({
      schemaVersion: 1, id, createdAt: Date.parse('2026-11-13T05:30:20.823Z'), updatedAt: 1, title: 'New Chat',
      profile: {}, executorState: 'attached', ...rec,
    }));
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), transcript);
  };
  const seedTrash = (id: string, stamp = '2026-11-13T05-30-16-801Z') => {
    const dir = path.join(trash(), `${id}__${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ id, createdAt: Date.parse('2026-11-13T05:30:09.803Z'), purpose: 'flow-worker', flow: '周报' }));
  };

  test('only shells matching every condition are found', () => {
    seedLive('s_shell_a', {}); seedTrash('s_shell_a');
    seedLive('s_shell_b', {}, '\n'); seedTrash('s_shell_b');
    seedLive('s_has_msgs', {}, JSON.stringify({ id: 'm1', role: 'user', content: 'hi', ts: 5 }) + '\n'); seedTrash('s_has_msgs');
    seedLive('s_has_purpose', { purpose: 'chat' }); seedTrash('s_has_purpose');
    seedLive('s_advanced', { purpose: 'flow-worker', flow: '周报' }); seedTrash('s_advanced');
    seedLive('s_renamed', { title: '周报 · 执行会话 2' }); seedTrash('s_renamed');
    seedLive('s_no_trash', {});
    // 回收站那份更晚（比如从云端恢复回来的老会话、之后又删过一次的同 id）：不动
    seedLive('s_trash_newer', {}); seedTrash('s_trash_newer', '2026-11-14T00-00-00-000Z');
    // 回收站的目录名认不出时间：不动
    seedLive('s_trash_badstamp', {}); seedTrash('s_trash_badstamp', 'whatever');
    // 只是 id 前缀相同（s_shell_a 的回收站目录不算 s_shell 的）
    seedLive('s_shell', {});

    const found = store.findResurrectedShells(trash());
    assert.deepEqual(found.map((f) => f.id).sort(), ['s_shell_a', 's_shell_b']);
    const a = found.find((f) => f.id === 's_shell_a')!;
    assert.equal(a.trashedAt, Date.parse('2026-11-13T05:30:16.801Z'));
    // 查找不改任何东西
    for (const id of ['s_shell_a', 's_shell_b', 's_has_msgs', 's_no_trash']) assert.ok(fs.existsSync(path.join(sessions(), id)));
  });

  test('no trash dir → nothing found', () => {
    assert.deepEqual(store.findResurrectedShells(path.join(home, 'no-such-trash')), []);
  });

  test('index.ts startup: shells are tombstoned + suppressed synchronously, moved to trash, logged', () => {
    const at = main.indexOf('store.findResurrectedShells(SESSION_TRASH_DIR)');
    assert.ok(at > 0);
    const block = main.slice(at, at + 1600);
    assert.match(block, /addSessionTombstone\(shell\.id\)/);
    assert.match(block, /deletedSessionIds\.add\(shell\.id\)/);
    assert.match(block, /moveDirToTrash\(/);
    assert.match(block, /logger\.(info|warn)\('delete-session'/);
    assert.ok(block.indexOf('deletedSessionIds.add(shell.id)') < block.indexOf('moveDirToTrash('));
    // 在启动时第一次 attach / hydrate 之前（markAllExecutorsDetached 那一段之后）
    assert.ok(at > main.indexOf('const { suppress, keep: stillThere, skippedAdvanced } = store.retryPendingDeletions(pending);'));
  });
});

describe('paths that create the directory first are guarded too (review round 2)', () => {
  const fnBody = (start: string) => { const at = main.indexOf(start); assert.ok(at > 0, start); return main.slice(at, main.indexOf('\n}\n', at)); };

  test('store.wouldResurrect: deleted + dir missing → true; dir present or not deleted → false', () => {
    deleted.add('s_wr_gone');
    assert.equal(store.wouldResurrect('s_wr_gone'), true);
    store.createSession('s_wr_live', profile);
    deleted.add('s_wr_live');
    assert.equal(store.wouldResurrect('s_wr_live'), false, 'dir still there: the delete flow owns it');
    assert.equal(store.wouldResurrect('s_wr_never_deleted'), false);
    assert.equal(store.wouldResurrect('../evil'), false);
    deleted.delete('s_wr_live');
  });

  test('getSessionDir / sessionFilesDir ask before mkdir', () => {
    const g = fnBody('function getSessionDir(sessionId?: string): string {');
    assert.ok(g.indexOf('store.wouldResurrect(sessionId)') > 0 && g.indexOf('store.wouldResurrect(sessionId)') < g.indexOf('fs.mkdirSync(dir'));
    const f = fnBody('function sessionFilesDir(sessionId: string): string {');
    assert.ok(f.indexOf('if (store.wouldResurrect(sessionId)) return dir;') > 0 && f.indexOf('store.wouldResurrect') < f.indexOf('fs.mkdirSync(dir'));
  });

  test('acp:new-session: a deleted id is refused before getSessionDir (which would mkdir) and before any bookkeeping', () => {
    const h = main.slice(main.indexOf("ipcMain.handle('acp:new-session'"), main.indexOf("ipcMain.handle('acp:get-create-stages'"));
    const refuse = h.indexOf("lateEvents.drop(kiroLexId, 'new-session request')");
    assert.ok(refuse > 0);
    assert.ok(refuse < h.indexOf('const sessionDir = getSessionDir(kiroLexId);'));
    assert.ok(refuse < h.indexOf('newSessionIntents.set(kiroLexId,'));
    assert.ok(refuse < h.indexOf('store.createSession(kiroLexId, profile)'));
  });

  test('mergeBucketSession: checks before getSessionDir, after each download before mkdir, and passes isDeleted', () => {
    const m = fnBody('async function mergeBucketSession(');
    assert.ok(m.indexOf('if (sessionDeleted(sessionId)) return { added: 0, pulledFiles: 0, gone: true };') < m.indexOf('getSessionDir(sessionId)'));
    const pull = m.slice(m.indexOf('pullFiles: async () => {'), m.indexOf('apply: () => {'));
    const got = pull.indexOf('await getObject(creds, p.key);');
    assert.ok(got > 0 && got < pull.indexOf('if (sessionDeleted(sessionId)) break;') && pull.indexOf('if (sessionDeleted(sessionId)) break;') < pull.indexOf('fs.mkdirSync('));
    assert.match(m, /isDeleted: \(\) => sessionDeleted\(sessionId\),/);
    const loop = main.slice(main.indexOf('await mergeBucketSession(creds!, cfg.prefix, c.id, round)'));
    assert.ok(loop.indexOf('if (r.gone)') < loop.indexOf('noteBucketSeen('), 'a gone merge is not noted as seen');
  });
});

describe('runBucketMerge: session deleted while waiting on the network → nothing written', async () => {
  const { runBucketMerge } = await import('../src/main/s3Pull.ts');
  const fake = (over: { deletedBefore?: boolean; deletedDuringFetch?: boolean; deletedDuringPull?: boolean }) => {
    const log: string[] = [];
    let gone = !!over.deletedBefore;
    const io = {
      fetch: async () => { log.push('fetch'); await new Promise((r) => setTimeout(r, 5)); if (over.deletedDuringFetch) gone = true; return { transcript: 'theirs', missingFiles: 2 }; },
      countNew: () => 3,
      isBusy: () => false,
      pullFiles: async () => { log.push('pull'); await new Promise((r) => setTimeout(r, 5)); if (over.deletedDuringPull) gone = true; return 1; },
      apply: () => { log.push('apply'); return 3; },
      isDeleted: () => gone,
    };
    return { io, log };
  };

  test('deleted before → no fetch at all', async () => {
    const { io, log } = fake({ deletedBefore: true });
    assert.deepEqual(await runBucketMerge(io), { added: 0, pulledFiles: 0, gone: true });
    assert.deepEqual(log, []);
  });
  test('deleted during download → no pull (mkdir), no apply (record write)', async () => {
    const { io, log } = fake({ deletedDuringFetch: true });
    assert.deepEqual(await runBucketMerge(io), { added: 0, pulledFiles: 0, gone: true });
    assert.deepEqual(log, ['fetch']);
  });
  test('deleted while pulling files → no apply', async () => {
    const { io, log } = fake({ deletedDuringPull: true });
    assert.deepEqual(await runBucketMerge(io), { added: 0, pulledFiles: 1, gone: true });
    assert.deepEqual(log, ['fetch', 'pull']);
  });
  test('not deleted → merges as before', async () => {
    const { io, log } = fake({});
    assert.deepEqual(await runBucketMerge(io), { added: 3, pulledFiles: 1 });
    assert.deepEqual(log, ['fetch', 'pull', 'apply']);
  });
});

describe('startup sweep: an unreadable transcript is not "empty"', () => {
  test('read error other than ENOENT → left alone; missing transcript (ENOENT) → still a shell', () => {
    const mk = (id: string) => {
      const dir = path.join(sessions(), id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({
        schemaVersion: 1, id, createdAt: Date.parse('2026-11-13T05:30:20.823Z'), updatedAt: 1, title: 'New Chat', profile: {}, executorState: 'attached',
      }));
      fs.mkdirSync(path.join(trash(), `${id}__2026-11-13T05-30-16-801Z`), { recursive: true });
      return dir;
    };
    // transcript.jsonl 是个目录 → readFileSync 抛 EISDIR（读不了，不是「没有」）
    const unreadable = mk('s_unreadable_transcript');
    fs.mkdirSync(path.join(unreadable, 'transcript.jsonl'));
    mk('s_missing_transcript');   // 没有 transcript.jsonl → ENOENT → 空
    const ids = store.findResurrectedShells(trash()).map((f) => f.id);
    assert.ok(!ids.includes('s_unreadable_transcript'), 'unreadable transcript must not be swept');
    assert.ok(ids.includes('s_missing_transcript'));
  });
});

describe('executor swaps / rollback / attach: deleted while waiting → not registered (review round 3)', () => {
  test('adoptUnlessDeleted: deleted during connect + session/load → discard, no register, late-event log', async () => {
    const logs: string[] = [];
    const gone = new Set<string>();
    const gate = gateMod.lateEventGate({ isDeleted: (id) => gone.has(id), log: (l) => logs.push(l) });
    const registry = new Map<string, string>();
    let disconnected = 0;
    // 换模型的骨架：await connect / loadSession → 登记；等的时候会话被删
    const swap = async (id: string) => {
      await new Promise((r) => setTimeout(r, 5));
      return gateMod.adoptUnlessDeleted(gate, id, 'switch model', { register: () => registry.set(id, 'new'), discard: () => { disconnected++; } });
    };
    const p = swap('s_swap');
    gone.add('s_swap');
    assert.equal(await p, false);
    assert.equal(registry.has('s_swap'), false);
    assert.equal(disconnected, 1);
    assert.ok(logs.some((l) => /late event for deleted session s_swap \(switch model\) ignored/.test(l)));
    // 没删 → 照常登记
    assert.equal(await swap('s_keep'), true);
    assert.equal(registry.get('s_keep'), 'new');
  });

  const fnFrom = (start: string, len = 4000) => { const at = main.indexOf(start); assert.ok(at > 0, start); return main.slice(at, at + len); };

  test('index.ts: no executor is registered except through adoptExecutor (and new-session, gated right before)', () => {
    const sets = [...main.matchAll(/sessionClients\.set\(/g)].map((m) => m.index!);
    const adopt = main.indexOf('function adoptExecutor(');
    const adoptEnd = main.indexOf('\n}\n', adopt);
    let attachSeen = false;
    for (const at of sets) {
      if (at > adopt && at < adoptEnd) continue;
      const line = main.slice(at, main.indexOf('\n', at));
      if (line.startsWith('sessionClients.set(sessionId, entry);')) {
        // attach（tryResume）：'before mount' 检查点（attachLive.deleted = deletedSessionIds）就在前面，中间没有 await
        attachSeen = true;
        const cp = main.lastIndexOf("attachCheckpoint(attachLive, sessionId, 'before mount')", at);
        assert.ok(cp > 0 && !/await (?!client\.disconnect)/.test(main.slice(cp, at)), 'attach: checkpoint right before the registration');
        continue;
      }
      assert.equal(line, 'sessionClients.set(kiroLexId, entry);', `raw sessionClients.set outside adoptExecutor: ${line}`);
      const gate = main.lastIndexOf("lateEvents.drop(kiroLexId, 'session/new'", at);
      assert.ok(gate > 0 && !main.slice(gate, at).includes('await '), 'new-session: no await between the gate and the registration');
    }
    assert.ok(attachSeen);
    assert.match(main, /deleted: \(id\) => deletedSessionIds\.has\(id\),/);
    const body = main.slice(adopt, adoptEnd);
    assert.match(body, /sessionDeleted\(sessionId\)/);
    assert.match(body, /entry\.client\.disconnect\(\)/);
    assert.match(body, /throw new SessionDeletedError\(/);
    for (const what of ['model fallback', 'switch remote target', 'switch-model rollback', 'switch model', 'switch kiro agent', 'switch engine', 'remount']) {
      assert.ok(main.includes(`, '${what}');`), what);
    }
  });

  test('index.ts: switch-model rollback does not start a new executor for a deleted session; its catch stays quiet', () => {
    const r = fnFrom('const restoreOldExecutor = async () => {', 2500);
    assert.ok(r.indexOf("if (lateEvents.drop(sessionId, 'switch-model rollback')) return;") < r.indexOf('new AcpClient('));
    const c = r.slice(r.indexOf('} catch (restoreError) {'));
    assert.ok(c.indexOf('if (restoreError instanceof SessionDeletedError) return;') < c.indexOf('sessionNotice('));
  });

  test('index.ts: model fallback stops trying candidates once the session is deleted', () => {
    const c = fnFrom("adoptExecutor(sessionId, next, 'model fallback');", 4000);
    assert.match(c, /if \(err instanceof SessionDeletedError\) return null;/);
  });

  test('index.ts: ensureAttached refuses a deleted id before trusting a registered executor', () => {
    const e = fnFrom('const ensureAttached = async (sessionId: string): Promise<boolean> => {', 900);
    const refuse = e.indexOf('if (refuseDeletedAttach(sid)) return false;');
    assert.ok(refuse > 0 && refuse < e.indexOf('if (sessionClients.get(sid)) return true;'));
    const helper = fnFrom('function refuseDeletedAttach(sid: string): boolean {', 400);
    assert.ok(helper.indexOf('sessionDeleted(sid)') > 0 && helper.indexOf('sessionDeleted(sid)') < helper.indexOf("lateEvents.drop(sid, 'ensureAttached'"), 'tombstones count too');
    assert.match(helper, /detachExecutor\(sid/);
  });

  test('index.ts: s3:restore opens the restore exemption before writing and always closes it', () => {
    const h = main.slice(main.indexOf("ipcMain.handle('s3:restore'"), main.indexOf("ipcMain.handle('offload:list'"));
    const begin = h.indexOf("const restore = store.beginRestore(String(sessionId || ''));");
    assert.ok(begin > 0 && begin < h.indexOf('store.writeRecordKeepUpdatedAt('));
    const fin = h.lastIndexOf('    } finally {\n');
    assert.ok(fin > h.lastIndexOf('    } catch (err: any) {'), 'outer finally after the outer catch');
    assert.match(h.slice(fin), /^    \} finally \{\n(\s*\/\*[\s\S]*?\*\/\n)?\s*restore\.end\(\);\n    \}\n  \}\);/);
  });
});

describe('cloud restore: a delete made DURING the restore cancels it (review round 4)', () => {
  test('store: restore of an already-deleted session writes; a new delete mid-restore refuses writes and check() throws', () => {
    const id = 's_restore_then_delete';
    deleted.add(id);                              // 恢复开始之前就删过 —— 恢复就是要它回来
    const run = store.beginRestore(id);
    fs.mkdirSync(path.join(sessions(), id), { recursive: true });
    assert.equal(store.writeRecordKeepUpdatedAt({ schemaVersion: 1, id, createdAt: 1, updatedAt: 1, title: 'restored', profile, executorState: 'detached' } as any), true);
    run.check();                                  // 还没被再删：不抛
    assert.equal(store.cancelRestore(id), 1);     // 恢复途中又删了（purgeSession）
    assert.throws(() => run.check(), store.RestoreCancelled);
    assert.equal(store.writeRecord({ ...store.readRecord(id)!, title: 'late' }), false);
    run.end();                                    // 作废后的 end 不影响别的
    assert.equal(store.cancelRestore(id), 0, 'nothing left to cancel');
    // 用户之后再主动恢复一次：照样能写
    const again = store.beginRestore(id);
    assert.equal(store.writeRecord({ ...store.readRecord(id)!, title: 'restored again' }), true);
    again.end();
  });

  test('simulated s3:restore: delete while waiting on the download → no rebuild, new tombstone kept', async () => {
    const id = 's_restore_race';
    const dir = path.join(sessions(), id);
    store.createSession(id, profile);
    const tombstones = new Set<string>();
    const purge = () => {                         // purgeSession 的同步前半 + 挪目录
      deleted.add(id); store.cancelRestore(id); tombstones.add(id);
      fs.mkdirSync(trash(), { recursive: true });
      fs.renameSync(dir, path.join(trash(), `${id}__2026-11-16T00-00-00-000Z`));
    };
    const restore = store.beginRestore(id);
    let outcome = 'ok';
    try {
      // const body = await vetted.get(obj.key); —— 这时候用户删了它
      const body = await new Promise<string>((r) => setTimeout(() => { purge(); r(JSON.stringify({ id, title: 'from cloud' })); }, 5));
      restore.check();
      fs.mkdirSync(dir, { recursive: true });
      store.writeRecordKeepUpdatedAt({ ...JSON.parse(body), id } as any);
      restore.check();
      tombstones.delete(id);                     // clearSessionTombstone
    } catch (err) {
      outcome = err instanceof store.RestoreCancelled ? 'cancelled' : String(err);
    } finally {
      restore.end();
    }
    assert.equal(outcome, 'cancelled');
    assert.equal(fs.existsSync(dir), false, 'sessions/<id>/ not rebuilt');
    assert.ok(tombstones.has(id), 'the new delete mark is kept');
    assert.equal(store.writeRecord({ schemaVersion: 1, id, createdAt: 1, updatedAt: 1, title: 'x', profile, executorState: 'detached' } as any), false);
  });

  test('index.ts: purgeSession cancels a running restore at the same moment it marks the session deleted', () => {
    const at = main.indexOf('deletedSessionIds.add(sessionId); // block any racing/subsequent load-session resurrection');
    assert.ok(at > 0);
    const next = main.slice(at, main.indexOf('\n', main.indexOf('\n', at) + 1));
    assert.match(next, /\n\s*store\.cancelRestore\(sessionId\);/);
  });

  test('index.ts: in s3:restore every network wait is followed by restore.check() before the next write / tombstone clear', () => {
    const h = main.slice(main.indexOf("ipcMain.handle('s3:restore'"), main.indexOf("ipcMain.handle('offload:list'"));
    const from = h.indexOf("const restore = store.beginRestore(String(sessionId || ''));");
    const to = h.lastIndexOf('    } catch (err: any) {');
    assert.ok(from > 0 && to > from);
    const body = h.slice(from, to);
    const writes = [...body.matchAll(/fs\.(mkdirSync|writeFileSync|cpSync|copyFileSync|renameSync)\(|store\.write\w*\(|clearSessionTombstone\(|deletedSessionIds\.delete\(|forgetDeletion\(/g)].map((m) => m.index!);
    assert.ok(writes.length >= 10);
    for (const w of writes) {
      const lastAwait = body.lastIndexOf('await ', w);
      if (lastAwait < 0) continue;
      assert.ok(body.slice(lastAwait, w).includes('restore.check();'), `no restore.check() between an await and: ${body.slice(w, body.indexOf('\n', w)).trim()}`);
    }
    const clear = body.indexOf('clearSessionTombstone(sessionId);');
    assert.ok(body.lastIndexOf('restore.check();', clear) > body.lastIndexOf('await ', clear), 'checked right before clearing the tombstone');
    assert.match(h, /if \(err instanceof store\.RestoreCancelled\) logger\.info\('delete-session', `late event for deleted session \$\{sessionId\} \(s3 restore\) ignored`\);/);
    assert.match(h, /\} finally \{\n\s*\/\*[\s\S]*?\*\/\n\s*restore\.end\(\);/);
  });
});

describe('two restores of the same session in flight, then a delete (review round 6)', () => {
  test('store: the delete cancels every in-flight restore of that id; writes refused; ending one does not re-open the others', () => {
    const id = 's_two_restores';
    deleted.add(id);
    fs.mkdirSync(path.join(sessions(), id), { recursive: true });
    const a = store.beginRestore(id);
    const b = store.beginRestore(id);
    const rec = { schemaVersion: 1, id, createdAt: 1, updatedAt: 1, title: 'r', profile, executorState: 'detached' } as any;
    assert.equal(store.writeRecordKeepUpdatedAt(rec), true, 'restore in progress → allowed');
    b.end();
    assert.equal(store.writeRecordKeepUpdatedAt(rec), true, 'a is still running → still allowed');
    const c = store.beginRestore(id);
    assert.equal(store.cancelRestore(id), 2);
    assert.equal(a.cancelled(), true);
    assert.equal(c.cancelled(), true);
    assert.throws(() => a.check(), store.RestoreCancelled);
    assert.throws(() => c.check(), store.RestoreCancelled);
    assert.equal(store.writeRecord(rec), false);
    a.end(); c.end();
    assert.equal(store.writeRecord(rec), false);
  });

  test('simulated concurrent s3:restore × 2: delete while both wait → neither writes, tombstone kept', async () => {
    const id = 's_two_s3_restores';
    const dir = path.join(sessions(), id);
    const tombstones = new Set<string>();
    let release!: () => void;
    const download = new Promise<void>((r) => { release = r; });
    const one = async () => {
      const restore = store.beginRestore(id);
      try {
        await download;                           // const body = await vetted.get(obj.key);
        restore.check();
        fs.mkdirSync(dir, { recursive: true });
        store.writeRecordKeepUpdatedAt({ schemaVersion: 1, id, createdAt: 1, updatedAt: 1, title: 'cloud', profile, executorState: 'detached' } as any);
        restore.check();
        tombstones.delete(id);
        return 'ok';
      } catch (err) {
        return err instanceof store.RestoreCancelled ? 'cancelled' : String(err);
      } finally { restore.end(); }
    };
    const p1 = one(); const p2 = one();
    deleted.add(id); store.cancelRestore(id); tombstones.add(id);   // purgeSession
    release();
    assert.deepEqual(await Promise.all([p1, p2]), ['cancelled', 'cancelled']);
    assert.equal(fs.existsSync(dir), false);
    assert.ok(tombstones.has(id));
  });
});

describe('delete while a restore is still waiting for cloud credentials (review round 7)', () => {
  test('simulated s3:restore: registered before the credentials wait → the delete cancels it; no dir, tombstone kept', async () => {
    const id = 's_creds_wait';
    const dir = path.join(sessions(), id);
    const tombstones = new Set<string>();
    let creds!: () => void;
    const credsWait = new Promise<void>((r) => { creds = r; });
    const run = (async () => {
      const restore = store.beginRestore(id);    // 第一个 await 之前
      try {
        await credsWait;                          // await resolveSyncCredsNow()（AWS profile 可能要好几秒）
        restore.check();
        fs.mkdirSync(dir, { recursive: true });
        store.writeRecordKeepUpdatedAt({ schemaVersion: 1, id, createdAt: 1, updatedAt: 1, title: 'cloud', profile, executorState: 'detached' } as any);
        restore.check();
        tombstones.delete(id);
        return 'ok';
      } catch (err) {
        return err instanceof store.RestoreCancelled ? 'cancelled' : String(err);
      } finally { restore.end(); }
    })();
    deleted.add(id); store.cancelRestore(id); tombstones.add(id);   // purgeSession，凭证还没回来
    creds();
    assert.equal(await run, 'cancelled');
    assert.equal(fs.existsSync(dir), false);
    assert.ok(tombstones.has(id));
  });

  test('index.ts: both restore entry points register before their first await, inside one try/finally', () => {
    const h = main.slice(main.indexOf("ipcMain.handle('s3:restore'"), main.indexOf("ipcMain.handle('offload:list'"));
    const begin = h.indexOf("const restore = store.beginRestore(String(sessionId || ''));");
    assert.ok(begin > 0 && begin < h.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)).indexOf('await '), 's3:restore: before the first await');
    assert.ok(h.indexOf('    try {\n', begin) < h.indexOf('await resolveSyncCredsNow()'), 'the credentials wait is inside the try (finally ends it)');
    const check = h.indexOf('restore.check();', h.indexOf('await resolveSyncCredsNow()'));
    const redirect = h.indexOf('if (isOffloadedPlaceholder(sessionId)) return offloadRestoreImpl(sessionId, opts);');
    assert.ok(check > 0 && check < redirect, 'checked after the credentials wait, before handing off to offloadRestoreImpl');
    assert.equal(h.split('store.beginRestore(').length - 1, 1, 'exactly one registration (no second, later one)');

    const at = main.indexOf('async function offloadRestoreImpl(');
    const o = main.slice(at, main.indexOf('\n}\n', at));
    const ob = o.indexOf('const restore = store.beginRestore(id);');
    const code = o.replace(/\/\*[\s\S]*?\*\//g, '');   // 注释里的「await」不算
    assert.ok(ob > 0 && code.indexOf('const restore = store.beginRestore(id);') < code.indexOf('await '), 'offloadRestoreImpl: before the first await');
    assert.ok(o.indexOf('  try {\n', ob) < o.indexOf('await resolveSyncCredsNow()'));
    assert.match(o, /\} finally \{\n\s*restore\.end\(\);\n\s*\}$/);
  });
});
