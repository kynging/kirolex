import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAdvancedOnlyProject, refusesProjectChange, vetBackupRecord } from '../src/main/advancedOnly.ts';
import { placementToFollow, applyPlacement } from '../src/main/s3Sync.ts';
import { restorePlacement, catalogProject } from '../src/main/restoreArchive.ts';
import { mergeRecords, guardMergedPlacement } from '../src/main/transcriptMerge.ts';
import { visibleProjects, projectMembershipKey } from '../src/renderer/projectVisibility.ts';

/*
  「标准版里仍然能看到『周报』和『SFDC Activity』两个项目」—— advanced 的 flow 项目本身也要藏。

  按现场的目录结构造数据（临时 HOME，不碰用户自己的 ~/.kirolex）：
    projects/周报/            project.json + runs/（5 个 run）；flows/周报.json 是它的 flow 定义
    projects/SFDC Activity/   project.json + detached-flows.json + runs/
    这两个项目下只有 flow-main / flow-worker 会话
  外加两个对照：
    projects/Mixed/           有 runs/，但里面还有一条普通会话 → 照常显示
    Plain                     普通项目，没有任何 flow 痕迹 → 照常显示（哪怕是空项目）
*/
const read = (rel: string): string => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');
const main = read('../src/main/index.ts');

describe('isAdvancedOnlyProject: flow traces AND no standard session', () => {
  const none = { hasRuns: false, hasDetachedFlows: false, hasFlowDefinition: false, standardSessions: 0 };
  test('any one trace + zero standard sessions → advanced-only', () => {
    assert.equal(isAdvancedOnlyProject({ ...none, hasRuns: true }), true);
    assert.equal(isAdvancedOnlyProject({ ...none, hasDetachedFlows: true }), true);
    assert.equal(isAdvancedOnlyProject({ ...none, hasFlowDefinition: true }), true);
  });
  test('a standard session keeps it visible; no trace is never advanced', () => {
    assert.equal(isAdvancedOnlyProject({ ...none, hasRuns: true, hasFlowDefinition: true, standardSessions: 1 }), false);
    assert.equal(isAdvancedOnlyProject(none), false);
  });
});

describe('visibleProjects: filter only what the UI gets', () => {
  test('hidden names drop out, order kept, input untouched', () => {
    const all = ['A', '周报', 'B', 'SFDC Activity'];
    assert.deepEqual(visibleProjects(all, ['周报', 'SFDC Activity']), ['A', 'B']);
    assert.deepEqual(all, ['A', '周报', 'B', 'SFDC Activity'], 'the shared list itself is not changed');
    assert.deepEqual(visibleProjects(all, []), all);
  });
});

describe('on disk: the two flow projects are hidden and byte-identical after every project entry', () => {
  let home = '';
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let store: typeof import('../src/main/sessionStore.ts');
  let memory: typeof import('../src/main/memory.ts');
  const K = () => path.join(home, '.kirolex');

  const write = (rel: string, text: string) => {
    const f = path.join(K(), rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  const session = (id: string, projectId: string, purpose?: string) => write(`sessions/${id}/record.json`, JSON.stringify({
    schemaVersion: 1, id, createdAt: 1, updatedAt: 1000, title: id, profile: { projectId }, executorState: 'detached',
    ...(purpose ? { purpose, flow: projectId } : {}),
  }, null, 2));
  /** 整棵树（路径 + 字节）；不存在 = null */
  const tree = (rel: string): Array<[string, string]> | null => {
    const root = path.join(K(), rel);
    if (!fs.existsSync(root)) return null;
    if (fs.statSync(root).isFile()) return [['', fs.readFileSync(root).toString('base64')]];
    const out: Array<[string, string]> = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { out.push([path.relative(root, full) + '/', '']); walk(full); }
        else out.push([path.relative(root, full), fs.readFileSync(full).toString('base64')]);
      }
    };
    walk(root);
    return out;
  };
  const OWNED = [
    'projects/周报', 'flows/周报.json', 'memory/projects/周报',
    'projects/SFDC Activity', 'memory/projects/SFDC Activity',
  ];

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-advproj-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assert.equal(os.homedir(), home);
    // 周报
    write('projects/周报/project.json', JSON.stringify({ workspace: '/work/weekly' }));
    for (let i = 1; i <= 5; i++) write(`projects/周报/runs/run_${i}.json`, JSON.stringify({ id: `run_${i}`, flow: '周报' }));
    write('flows/周报.json', JSON.stringify({ name: '周报', steps: [] }));
    write('memory/projects/周报/memory.md', '# 周报 memory (advanced)\n');
    session('s_weekly_main', '周报', 'flow-main');
    session('s_weekly_w1', '周报', 'flow-worker');
    // SFDC Activity
    write('projects/SFDC Activity/project.json', '{}');
    write('projects/SFDC Activity/detached-flows.json', JSON.stringify(['SFDC activity']));
    write('projects/SFDC Activity/runs/run_a.json', '{}');
    session('s_sfdc_main', 'SFDC Activity', 'flow-main');
    session('s_sfdc_w1', 'SFDC Activity', 'flow-worker');
    // 对照：有 flow 痕迹，但里面有普通会话
    write('projects/Mixed/runs/run_m.json', '{}');
    session('s_mixed_flow', 'Mixed', 'flow-main');
    session('s_mixed_std', 'Mixed');
    // 对照：普通项目
    session('s_plain', 'Plain');
    store = await import('../src/main/sessionStore.ts');
    memory = await import('../src/main/memory.ts');
  });
  after(() => {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('the two flow projects are not in the project list; Mixed and Plain (and an empty project) are', () => {
    const names = ['Plain', '周报', 'Mixed', 'SFDC Activity', 'Empty'];
    const hidden = store.advancedOnlyProjectsAmong(names);
    assert.deepEqual([...hidden].sort(), ['SFDC Activity', '周报']);
    assert.deepEqual(visibleProjects(names, hidden), ['Plain', 'Mixed', 'Empty']);
    assert.equal(store.isAdvancedOnlyProjectName('周报'), true);
    assert.equal(store.isAdvancedOnlyProjectName('Mixed'), false);
    assert.equal(store.isAdvancedOnlyProjectName(''), false);
  });

  test('project-layer memory: no create / write / backup / delete; not listed to the model; files byte-identical', () => {
    const before = OWNED.map(tree);
    for (const p of ['周报', 'SFDC Activity']) {
      memory.ensureMemoryFiles(p, undefined);
      memory.readMemory(p, undefined);
      memory.memoryLayerBytes(p, undefined);
      memory.buildMemoryInjection(p, undefined);
      assert.throws(() => memory.writeMemory('project', p, undefined, 'from standard'));
      memory.writeMemory('global', p, undefined, '# g\n');   // 全局层照常，但不顺手建项目层
      assert.equal(memory.backupMemoryLayer('project', p, undefined, '2026-10-17T00-00-00-000Z'), null);
      memory.deleteProjectMemory(p);
    }
    assert.deepEqual(OWNED.map(tree), before, 'project.json, runs/, flows/, detached-flows.json, memory/projects/<名> unchanged');
    assert.equal(fs.existsSync(path.join(K(), 'memory', 'projects', 'SFDC Activity')), false, 'missing project memory not created');
    // 未分组会话的注入里列出的项目清单不含它们
    const block = memory.buildMemoryInjection(undefined, undefined) || '';
    assert.ok(!block.includes('周报'), 'advanced project not offered to the model');
    // 普通项目照常
    memory.writeMemory('project', 'Plain', undefined, 'plain fact');
    assert.equal(fs.readFileSync(path.join(K(), 'memory', 'projects', 'Plain', 'memory.md'), 'utf8'), 'plain fact');
  });

  const recordBytes = (id: string) => fs.readFileSync(path.join(K(), 'sessions', id, 'record.json'));

  test('sending with a cached hidden project name does not move a standard session in (record + project memory unchanged)', () => {
    const before = { rec: recordBytes('s_plain'), owned: OWNED.map(tree) };
    // 和 sendPromptOnce 一样：先问 refusesProjectChange，拒了就抛，后面的「写项目归属」根本走不到
    const send = (projectId: string) => {
      const cur = store.readRecord('s_plain')!;
      if (refusesProjectChange(projectId, cur.profile.projectId, store.isAdvancedOnlyProjectName)) throw new Error('refused');
      if (projectId !== cur.profile.projectId) store.writeRecord({ ...cur, profile: { ...cur.profile, projectId } });
    };
    for (const p of ['周报', 'SFDC Activity']) assert.throws(() => send(p), /refused/);
    assert.ok(recordBytes('s_plain').equals(before.rec), 'standard record unchanged');
    assert.deepEqual(OWNED.map(tree), before.owned, 'advanced project files + memory unchanged');
    assert.equal(store.isAdvancedOnlyProjectName('周报'), true, 'still protected afterwards');
    // 不改项目、改去普通项目：放行
    assert.equal(refusesProjectChange('Plain', 'Plain', store.isAdvancedOnlyProjectName), false);
    assert.equal(refusesProjectChange(undefined, 'Plain', store.isAdvancedOnlyProjectName), false);
    assert.equal(refusesProjectChange('Mixed', 'Plain', store.isAdvancedOnlyProjectName), false);
  });

  test('sync placement-follow never moves a standard session into an advanced project (record unchanged)', () => {
    const before = { rec: recordBytes('s_plain'), owned: OWNED.map(tree) };
    // 别的机器后挪的：catalog 里这条在「周报」
    const theirs = { id: 's_plain', title: 's_plain', project: '周报', updatedAt: 1, bytes: 0, syncedAt: 1, archived: false, placementChangedAt: Date.now() };
    // 和 followBucketPlacements 一样的两步：判要不要跟，跟就写
    const cur = store.readRecord('s_plain');
    const p = placementToFollow(cur, theirs, store.isAdvancedOnlyProjectName);
    if (cur && p) store.writeRecordKeepUpdatedAt(applyPlacement(cur, p));
    assert.equal(p, null, 'not followed');
    assert.ok(recordBytes('s_plain').equals(before.rec), 'standard record unchanged');
    assert.deepEqual(OWNED.map(tree), before.owned);
    // 恢复那一路的位置判断也一样：保持本机原来的
    const rp = restorePlacement(cur, theirs, store.isAdvancedOnlyProjectName);
    assert.equal(rp?.placement.projectId, 'Plain');
    assert.equal(rp?.changed, false);
    // 对照：挪进普通项目照常跟随；不传判据是老行为
    assert.equal(placementToFollow(cur, { ...theirs, project: 'Mixed' }, store.isAdvancedOnlyProjectName)?.projectId, 'Mixed');
    assert.equal(placementToFollow(cur, theirs)?.projectId, '周报');
  });

  test('s3 restore of a standard backup that lives in an advanced project is refused before anything is written', async () => {
    const before = OWNED.map(tree);
    const key = 'v1/sessions/s_restored/record.json';
    const backup = Buffer.from(JSON.stringify({ id: 's_restored', title: 'from bucket', profile: { projectId: '周报' } }));
    const v = await vetBackupRecord(key, async () => backup, store.isAdvancedOnlyProjectName);
    assert.deepEqual(v, { ok: false, reason: 'advanced-project' });
    // 被拒 = s3:restore 在写任何本地文件之前返回（接线见下面的源码断言）
    assert.equal(fs.existsSync(path.join(K(), 'sessions', 's_restored')), false, 'no session written');
    assert.deepEqual(OWNED.map(tree), before, 'project files + memory/projects/<名> unchanged');
    assert.equal(store.isAdvancedOnlyProjectName('周报'), true);
    // 对照：普通项目的备份照常放行，拿到的是校验过的那份字节
    const plain = Buffer.from(JSON.stringify({ id: 's_restored', profile: { projectId: 'Plain' } }));
    const ok = await vetBackupRecord(key, async () => plain, store.isAdvancedOnlyProjectName);
    assert.ok(ok.ok && ok.record === plain);
  });

  test('sync conflict auto-merge keeps the local placement when the bucket copy says 周报 (record written, project still protected)', () => {
    const before = OWNED.map(tree);
    const mine = store.readRecord('s_plain')!;
    // 云上那份：后挪进了「周报」，而且整份更新 —— 不加保护时 mergeRecords 会得到 projectId='周报'
    const theirs = { ...mine, title: 'renamed elsewhere', updatedAt: Date.now() + 1000, profile: { ...mine.profile, projectId: '周报' }, archived: true, placementChangedAt: Date.now() + 1000 };
    assert.equal(mergeRecords(mine, theirs).profile.projectId, '周报', 'the unguarded merge would move it in');
    // 和 mergeBucketSession 一样：合并 → 保护 → 写盘
    const merged = guardMergedPlacement(mergeRecords(mine, theirs), mine, store.isAdvancedOnlyProjectName);
    merged.updatedAt = Math.max(Number(mine.updatedAt) || 0, Number(theirs.updatedAt) || 0, Date.now());
    const rAbs = path.join(K(), 'sessions', 's_plain', 'record.json');
    fs.writeFileSync(rAbs, JSON.stringify(merged, null, 2));
    const after = store.readRecord('s_plain')!;
    assert.equal((after.profile as any).projectId, 'Plain', 'local project kept');
    assert.equal(after.archived, mine.archived, 'local archive state kept');
    assert.equal(after.placementChangedAt, mine.placementChangedAt);
    assert.equal(after.title, 'renamed elsewhere', 'the rest of the merge still applies');
    assert.equal(store.isAdvancedOnlyProjectName('周报'), true, '周报 still has no standard session');
    assert.deepEqual(OWNED.map(tree), before, 'project files + memory unchanged');
    // 对照：普通项目照常按合并结果走
    assert.equal(guardMergedPlacement(mergeRecords(mine, { ...theirs, profile: { ...mine.profile, projectId: 'Mixed' } }), mine, store.isAdvancedOnlyProjectName).profile.projectId, 'Mixed');
    fs.writeFileSync(rAbs, JSON.stringify(mine, null, 2));
  });

  test('restore list: backups grouped into an advanced project are not listed; placementWillChange agrees with restore', () => {
    const entry = (id: string, project?: string) => ({ id, title: id, updatedAt: 1, bytes: 0, syncedAt: 1, archived: false, placementChangedAt: Date.now() + 5000, ...(project ? { project } : {}) });
    const entries = [entry('c_weekly_std', '周报'), entry('c_sfdc_std', 'SFDC Activity'), entry('c_site', 'Plain'), entry('c_free'), entry('s_plain', '周报')];
    // 和 advancedBackupIds 一样的归属算法（恢复页按它分组）
    const projectById = new Map(store.listSessions().map((r) => [r.id, String((r.profile as any)?.projectId || '')]));
    const groupOf = (e: any) => catalogProject(e, projectById.get(e.id)) || '';
    const advancedProjects = store.advancedOnlyProjectsAmong(entries.map(groupOf));
    const listed = entries.filter((e) => !advancedProjects.has(groupOf(e)));
    assert.deepEqual(listed.map((e) => e.id), ['c_site', 'c_free']);
    assert.deepEqual([...new Set(listed.map(groupOf))].sort(), ['', 'Plain'], 'no 周报 / SFDC Activity group on the restore page');
    // 本机这条在 Plain，云上后挪进了「周报」：恢复不会挪它，所以也不该提示「位置会变」
    assert.equal(restorePlacement(store.readRecord('s_plain'), entries[4], store.isAdvancedOnlyProjectName)?.changed, false);
    assert.equal(restorePlacement(store.readRecord('s_plain'), entries[4])?.changed, true, 'without the guard it would (old behaviour)');
  });

  test('moving the LAST standard session out of a flow project hides it (and the UI key changes though counts do not)', () => {
    const names = ['Plain', 'Mixed'];
    const uiSessions = () => store.listSessions().map((r) => ({ id: r.id, projectId: (r.profile as any).projectId }));
    assert.equal(store.advancedOnlyProjectsAmong(names).has('Mixed'), false);
    const keyBefore = projectMembershipKey(uiSessions());
    const countBefore = uiSessions().length;
    const rec = store.readRecord('s_mixed_std')!;
    store.writeRecord({ ...rec, profile: { ...rec.profile, projectId: 'Plain' } });
    try {
      assert.equal(uiSessions().length, countBefore, 'same number of sessions');
      assert.notEqual(projectMembershipKey(uiSessions()), keyBefore, 'renderer re-asks on this change');
      assert.deepEqual([...store.advancedOnlyProjectsAmong(names)], ['Mixed'], 'Mixed is now advanced-only → hidden');
      assert.deepEqual(visibleProjects(names, store.advancedOnlyProjectsAmong(names)), ['Plain']);
    } finally {
      /* Mixed 此刻是 advanced 专属项目，writeRecord 那道关不许放回去 —— 夹具直接按原样写回盘上 */
      session('s_mixed_std', 'Mixed');
    }
    assert.equal(store.advancedOnlyProjectsAmong(names).has('Mixed'), false, 'moving it back shows it again');
  });
});

describe('index.ts: project entries refuse advanced-only projects before touching anything', () => {
  const handler = (name: string) => {
    const h = main.slice(main.indexOf(name));
    return h.slice(0, h.indexOf('\n  });'));
  };

  test('the guard uses the shared criterion', () => {
    const fn = main.slice(main.indexOf('function refuseAdvancedProject('));
    assert.match(fn.slice(0, fn.indexOf('\n}')), /store\.isAdvancedOnlyProjectName\(p\)/);
  });

  for (const [name, before] of [
    ["ipcMain.handle('acp:new-session'", 'getSessionDir(kiroLexId)'],
    ["ipcMain.handle('acp:assign-project'", 'store.writeRecord(rec)'],
    ["ipcMain.handle('acp:set-project'", 'store.writeRecord(rec)'],
    ["ipcMain.handle('acp:move-session'", 'store.writeRecord(rec)'],
    ["ipcMain.handle('project:set-workspace'", 'projectStore.writeProject('],
    ["ipcMain.handle('acp:delete-project-memory'", 'deleteProjectMemory(projectId)'],
    ["ipcMain.handle('acp:write-memory'", 'writeMemory(scope, projectId, sid, content)'],
    ["ipcMain.handle('acp:backup-memory'", 'backupMemoryLayer(scope, projectId, sid, stamp)'],
    ["ipcMain.handle('s3:delete-project'", 'deleteBackupsOf('],
  ] as const) {
    test(`${name}: refused before ${before}`, () => {
      const body = handler(name);
      const guard = body.indexOf('refuseAdvancedProject(');
      assert.ok(guard > 0, name);
      assert.ok(guard < body.indexOf(before), `${name}: before ${before}`);
    });
  }

  test('the renderer asks main which projects to hide (answer only, nothing written)', () => {
    const body = handler("ipcMain.handle('app:advanced-only-projects'");
    assert.match(main, /ipcMain\.handle\('app:advanced-only-projects', async \(_event, names: unknown\) =>\s*\[\.\.\.store\.advancedOnlyProjectsAmong\(/);
    assert.ok(!/write|rm|mkdir/i.test(body.split('=>').slice(1).join('=>').slice(0, 200)));
  });

  test('S3: their project memory is neither uploaded nor pulled, and not shown on the restore page', () => {
    assert.match(main, /const memoryProjects = memoryProjectDirs\.filter\(\(p\) => !advancedProjects\.has\(p\)\)\s*\.filter\(\(p\) => !projectExcluded\(cfg, p\)\);/);
    assert.match(main, /if \(parts\[1\] === 'projects'\) return !projectExcluded\(cfg, parts\[2\]\) && !store\.isAdvancedOnlyProjectName\(parts\[2\]\);/);
    assert.match(handler("ipcMain.handle('s3:list-backups'"), /for \(const p of store\.advancedOnlyProjectsAmong\(Object\.keys\(memoryByProject\)\)\) delete memoryByProject\[p\];/);
  });
});

describe('index.ts: the send / sync / restore paths use the shared project criterion before writing', () => {
  test('sendPromptOnce refuses a hidden project before any side effect (attachments, record write)', () => {
    const fn = main.slice(main.indexOf('async function sendPromptOnce('));
    const guard = fn.indexOf('refusesProjectChange(projectId, entry.profile.projectId, store.isAdvancedOnlyProjectName)');
    assert.ok(guard > 0);
    assert.ok(guard < fn.indexOf('const userPromptText ='), 'before attachment handling');
    assert.ok(guard < fn.indexOf('r.profile.projectId = projectId; store.writeRecord(r);'), 'before the project write');
  });

  test('followBucketPlacements passes the criterion to both placementToFollow calls', () => {
    const fn = main.slice(main.indexOf('function followBucketPlacements('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.equal((body.match(/placementToFollow\([^\n]*, store\.isAdvancedOnlyProjectName\)/g) || []).length, 2);
    assert.ok(!/placementToFollow\(r, theirs\)\)/.test(body));
  });

  test('s3:restore: backup record vetted with the criterion (refused before any write), placement and project memory too', () => {
    const helper = main.slice(main.indexOf('async function refuseAdvancedBackup('));
    assert.match(helper.slice(0, helper.indexOf('\n}')), /vetBackupRecord\(recordKey, \(key\) => getObject\(creds, key\), store\.isAdvancedOnlyProjectName\)/);
    const h = main.slice(main.indexOf("ipcMain.handle('s3:restore'"));
    const body = h.slice(0, h.indexOf('\n  });'));
    assert.ok(body.indexOf("if ('refused' in vetted) return") < body.indexOf('backedUp = trashDirFor('));
    assert.match(body, /restorePlacement\(localBefore, catalogEntry, store\.isAdvancedOnlyProjectName\)/);
    assert.match(body, /!store\.isAdvancedOnlyProjectName\(project\) \? \[`\$\{keyFor\(cfg\.prefix, path\.join\('memory', 'projects', project\)\)\}\/`\]/);
  });

  test('mergeBucketSession guards the merged placement before writing record.json', () => {
    const fn = main.slice(main.indexOf('async function mergeBucketSession('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const guard = body.indexOf('const merged = guardMergedPlacement(mergeRecords(mine, theirs), mine, store.isAdvancedOnlyProjectName);');
    assert.ok(guard > 0);
    assert.ok(guard < body.indexOf('store.writeRecordKeepUpdatedAt({ ...merged, id: sessionId })'));
  });

  test('s3:list-backups hides entries grouped into an advanced project; placementWillChange uses the same guard as restore', () => {
    const fn = main.slice(main.indexOf('async function advancedBackupIds('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /const groupOf = \(e: CatalogEntry\) => catalogProject\(e, projectById\.get\(e\.id\)\) \|\| '';/);
    assert.match(body, /store\.advancedOnlyProjectsAmong\(\(catalog\.entries \|\| \[\]\)\.map\(groupOf\)\)/);
    assert.match(body, /\.\.\.inAdvancedProject\]/);
    const h = main.slice(main.indexOf("ipcMain.handle('s3:list-backups'"));
    const list = h.slice(0, h.indexOf('\n  });'));
    assert.match(list, /\.filter\(\(e\) => !hidden\.has\(e\.id\)\)/);
    assert.match(list, /placementWillChange: !!restorePlacement\(recById\.get\(e\.id\), e, store\.isAdvancedOnlyProjectName\)\?\.changed/);
  });

  test('a cold record never lands in a hidden project', () => {
    const fn = main.slice(main.indexOf('const coldRecordFor = ('));
    assert.match(fn.slice(0, 900), /hint\?\.projectId && !refuseAdvancedProject\(hint\.projectId, 'cold-record'\)/);
  });
});

describe('renderer: every project list in the UI comes from the filtered list', () => {
  const acp = read('../src/renderer/hooks/useAcp.ts');
  test('useAcp hands out the filtered list and still persists the shared one unchanged', () => {
    assert.match(acp, /const shownProjects = useMemo\(\(\) => visibleProjects\(projects, hiddenProjects\), \[projects, hiddenProjects\]\);/);
    assert.match(acp, /projects: shownProjects,/);
    assert.match(acp, /uiSet\('kirolex-projects', JSON\.stringify\(projects\)\);/);
    assert.match(acp, /window\.kiroApi\.advancedOnlyProjects/);
  });
  test('the hidden list is re-asked whenever a session changes project, not only when the count changes', () => {
    assert.match(acp, /const membership = useMemo\(\(\) => projectMembershipKey\(sessions\), \[sessions\]\);/);
    assert.match(acp, /\}, \[projects, membership\]\);/);
    assert.ok(!/\}, \[projects, sessions\.length\]\);/.test(acp));
  });
  test('projectMembershipKey: moving a session changes it, message churn does not', () => {
    const a = [{ id: 's1', projectId: 'Mixed' }, { id: 's2', projectId: 'Plain' }];
    assert.notEqual(projectMembershipKey(a), projectMembershipKey([{ id: 's1', projectId: 'Plain' }, a[1]]));
    assert.equal(projectMembershipKey(a), projectMembershipKey([{ ...a[1], title: 'x' } as any, { ...a[0], timestamp: 5 } as any]));
  });
  test('create / rename / delete never touch a hidden project', () => {
    assert.match(acp, /if \(!n \|\| hiddenProjects\.includes\(n\)\) return;/);
    assert.match(acp, /if \(hiddenProjects\.includes\(n\) \|\| hiddenProjects\.includes\(oldName\)\) return;/);
    assert.match(acp, /if \(hiddenProjects\.includes\(name\)\) return;/);
  });
  test('App takes its projects (sidebar, move-to-project, new-chat picker) from useAcp only', () => {
    const app = read('../src/renderer/App.tsx');
    assert.ok(!/kirolex-projects/.test(app));
  });
});
