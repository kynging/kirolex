/**
 * 「从云端恢复的会话：默认进『未分组』；projectId 被写成会话自己的 id；恢复说『改成本机跑』却仍连远端」。
 *
 * 现场（KYN-DESKTOP，s_1790502638964_in82ze，Claude Code，原来跑在 tokyo-arm）：
 *   1. 恢复日志说「改成在本机跑」，紧接着 attach 仍连 tokyo-arm（那台机器在本机设置里就有）；
 *   2. 恢复后落进了 Blog（备份记录 / catalog 里是别的设备上的项目）；
 *   3. 之后 projectId 成了会话自己的 id，侧栏冒出一个叫 s_1790502638964_in82ze 的项目，记忆按它注入。
 *
 * 守的是：
 *   A. 恢复的一律未分组（标 unassigned，本机已有、走合并的也一样），只有勾了「放回原项目」且本机有同名项目才放回。
 *   B. s_ 开头 / 不在侧栏项目列表里的项目当未分组：读取（水化）、attach、每轮发消息时纠正写回，记忆按未分组注入；
 *      根因：attach 按目录推项目时认不出**别的电脑**的 `.kirolex/sessions/<id>`，于是推出了会话 id。
 *   C. 挂载途中（远端连接慢）移出项目，执行器和 session-ready 不再拿开头那份旧项目（「老往 Blog 跑」）。
 *   D. 恢复后在哪儿跑：本机设置里认得那台机器就保留远端、提示「仍在 <机器名> 上跑」；不认得才改本机。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { restoreTarget, restoreRunPlan } from '../src/main/restoreArchive.ts';
import { looksLikeSessionId, knownProjects, bogusProjectReason, sanitizeProjectId, derivableProjectDir } from '../src/main/projectSanity.ts';
import { resolveSessionRemote } from '../src/main/remoteTargets.ts';

const SID = 's_1790502638964_in82ze';
const entry = (over: Record<string, any> = {}) =>
  ({ id: SID, title: 'bedrock proxy', updatedAt: 1, bytes: 1, syncedAt: 1, ...over }) as any;
const local = new Set(['Dev', 'Blog']);

describe('A. 从云端恢复的会话放在哪儿（restoreTarget）', () => {
  test('新恢复：默认未分组，不继承备份记录 / catalog 的项目，标 unassigned', () => {
    const r = restoreTarget({
      localBefore: null,
      backup: { profile: { projectId: 'Blog' }, archived: false, placementChangedAt: 10 },
      entry: entry({ project: 'Blog', archived: false, placementChangedAt: 10 }),
      putBack: false, localProjects: local,
    });
    assert.equal(r.placement.projectId, '');
    assert.equal(r.unassigned, true, 'attach 不能再按目录反推出项目');
    assert.equal(r.origin, 'Blog', '原来在哪要说得出来');
  });

  test('新恢复 + 勾了「放回原项目」+ 本机有同名项目 → 放回去', () => {
    const r = restoreTarget({
      localBefore: null,
      backup: { profile: { projectId: 'Blog' }, placementChangedAt: 10 },
      entry: entry({ project: 'Blog', archived: false, placementChangedAt: 10 }),
      putBack: true, localProjects: local,
    });
    assert.equal(r.placement.projectId, 'Blog');
    assert.equal(r.unassigned, false);
  });

  test('勾了但本机没有那个项目 → 还是未分组', () => {
    const r = restoreTarget({
      localBefore: null,
      backup: { profile: { projectId: 'Ops' }, placementChangedAt: 10 },
      entry: entry({ project: 'Ops', archived: false, placementChangedAt: 10 }),
      putBack: true, localProjects: local,
    });
    assert.equal(r.placement.projectId, '');
    assert.equal(r.unassigned, true);
  });

  test('原项目形如会话 id / 是 advanced 专属 → 勾了也不放回', () => {
    const odd = new Set([...local, SID, 'Flow']);
    const a = restoreTarget({ localBefore: null, backup: { profile: { projectId: SID } }, entry: undefined, putBack: true, localProjects: odd });
    assert.equal(a.placement.projectId, '');
    const b = restoreTarget({ localBefore: null, backup: { profile: { projectId: 'Flow' } }, entry: undefined, putBack: true, localProjects: odd, refuseProject: (p) => p === 'Flow' });
    assert.equal(b.placement.projectId, '');
  });

  test('placementChangedAt 取备份和 catalog 里较新的：不比 catalog 旧（下次同步不会被拉回原项目），也不取现在（别的设备不会跟着挪）', () => {
    const r = restoreTarget({
      localBefore: null,
      backup: { profile: { projectId: 'Blog' }, placementChangedAt: 10 },
      entry: entry({ project: 'Blog', archived: false, placementChangedAt: 25 }),
      putBack: false, localProjects: local,
    });
    assert.equal(r.placement.placementChangedAt, 25);
  });

  test('合并（本机有这条）：不勾 → 也一律未分组（不留本机的 Dev，也不跟云上的 Blog），归档状态保持本机的', () => {
    const r = restoreTarget({
      localBefore: { profile: { projectId: 'Dev' }, archived: false, placementChangedAt: 10 },
      backup: { profile: { projectId: 'Blog' } },
      entry: entry({ project: 'Blog', archived: false, placementChangedAt: 20 }),
      putBack: false, localProjects: local,
    });
    assert.deepEqual(r.placement, { projectId: '', archived: false, placementChangedAt: 20 });
    assert.equal(r.unassigned, true);
    assert.equal(r.changed, true, '从 Dev 挪出来了：要换记忆范围、通知侧栏');
    const already = restoreTarget({
      localBefore: { profile: {}, archived: true, placementChangedAt: 5 },
      backup: undefined, entry: undefined, putBack: false, localProjects: local,
    });
    assert.equal(already.placement.projectId, '');
    assert.equal(already.placement.archived, true);
    assert.equal(already.changed, false, '本来就未分组');
  });

  test('合并 + 勾了：按「谁后挪用谁」跟云上，但云上那个项目本机得有', () => {
    const follow = restoreTarget({
      localBefore: { profile: { projectId: 'Dev' }, placementChangedAt: 10 },
      backup: undefined,
      entry: entry({ project: 'Blog', archived: false, placementChangedAt: 20 }),
      putBack: true, localProjects: local,
    });
    assert.equal(follow.placement.projectId, 'Blog');
    assert.equal(follow.changed, true);
    const stay = restoreTarget({
      localBefore: { profile: { projectId: 'Dev' }, placementChangedAt: 10 },
      backup: undefined,
      entry: entry({ project: 'Ops', archived: false, placementChangedAt: 20 }),
      putBack: true, localProjects: local,
    });
    assert.equal(stay.placement.projectId, '', '云上那个项目本机没有：进未分组，不留在本机原来的 Dev');
    assert.equal(stay.unassigned, true);
    assert.equal(stay.changed, true, '从 Dev 挪出来了');
    const none = restoreTarget({
      localBefore: { profile: { projectId: 'Gone' }, placementChangedAt: 10 },
      backup: undefined,
      entry: entry({ project: 'Ops', archived: false, placementChangedAt: 20 }),
      putBack: true, localProjects: local,
    });
    assert.equal(none.placement.projectId, '', '两边的项目本机都没有：未分组');
    assert.equal(none.unassigned, true);
  });
});

describe('B. 假项目认得出、读取时纠正', () => {
  test('s_ 开头的一律当会话 id（需求 B），包括 s_test', () => {
    assert.equal(looksLikeSessionId(SID), true);
    assert.equal(looksLikeSessionId('s_test'), true);
    assert.equal(looksLikeSessionId(' s_x '), true);
    assert.equal(looksLikeSessionId('ss_x'), false);
    assert.equal(looksLikeSessionId('Blog'), false);
    assert.equal(looksLikeSessionId(''), false);
  });

  test('bogusProjectReason：会话 id 形状 / 等于自己的 id / 本机不认识；未分组和真项目不算', () => {
    const known = knownProjects(JSON.stringify(['Dev', 'Blog']));
    assert.equal(bogusProjectReason(SID, SID, known), 'session-id');
    assert.equal(bogusProjectReason('weird', 'weird', null), 'session-id', '等于这条会话自己的 id');
    assert.equal(bogusProjectReason('files', SID, known), 'unknown');
    assert.equal(bogusProjectReason('Blog', SID, known), null);
    assert.equal(bogusProjectReason(undefined, SID, known), null);
    assert.equal(sanitizeProjectId(SID, SID, known), undefined, '记忆按未分组注入');
    assert.equal(sanitizeProjectId(' Dev ', SID, known), 'Dev');
  });

  test('空列表照判：本机一个项目都没有 → 任何项目都是不认识的', () => {
    const empty = knownProjects('[]');
    assert.ok(empty);
    assert.equal(empty.size, 0);
    assert.equal(bogusProjectReason('Blog', SID, empty), 'unknown');
    assert.equal(sanitizeProjectId('Blog', SID, empty), undefined);
  });

  test('读不出来（没有这个键 / 坏了 / 不是数组）和空列表不是一回事：只按 s_ 前缀判', () => {
    assert.equal(knownProjects(undefined), null);
    assert.equal(knownProjects(''), null);
    assert.equal(knownProjects('{bad'), null);
    assert.equal(knownProjects('{"a":1}'), null);
    assert.equal(bogusProjectReason('Ops', SID, null), null);
    assert.equal(bogusProjectReason(SID, SID, null), 'session-id');
  });

  test('只认侧栏的项目列表：s_ 开头的就算在列表里也不算项目', () => {
    const known = knownProjects(JSON.stringify(['Dev', 'Blog', SID, 's_test']));
    assert.ok(known);
    assert.deepEqual([...known].sort(), ['Blog', 'Dev']);
    assert.equal(bogusProjectReason('s_test', SID, known), 'session-id');
    assert.equal(sanitizeProjectId('s_test', SID, known), undefined, '记忆也按未分组注入');
    assert.equal(bogusProjectReason('Ops', SID, known), 'unknown', '磁盘上有 Ops 的目录也不算');
  });

  test('根因：别的电脑的 .kirolex 目录、会话 id 形状的目录名、本机不存在的目录都不拿来推项目', () => {
    const yes = () => true;
    assert.equal(derivableProjectDir(`/home/ec2-user/.kirolex/sessions/${SID}`, yes), false, '别的电脑（家目录本机不知道）');
    assert.equal(derivableProjectDir(`/Users/ky/.kirolex/sessions/${SID}/files`, yes), false, '…/files 也不推成 files');
    assert.equal(derivableProjectDir(`C:\\Users\\KY\\.KiroLex\\sessions\\${SID}`, yes), false, 'Windows 分隔符 / 大小写');
    assert.equal(derivableProjectDir(`D:\\scratch\\${SID}`, yes), false, '会话 id 形状的目录名');
    assert.equal(derivableProjectDir('/Users/ky/code/Blog', () => false), false, '本机没有这个目录');
    assert.equal(derivableProjectDir('D:\\code\\Blog', (p) => p === 'D:\\code\\Blog'), true, '本机真有的目录照旧可以推');
    assert.equal(derivableProjectDir('', yes), false);
  });
});

describe('D. 恢复后在哪儿跑（restoreRunPlan）—— 提示和实际一致', () => {
  const targets = [{ id: 'tokyo-arm', label: 'tokyo-graviton', sshHost: 'ec2-user@i-0c1acfa285ba8e748' }] as any;
  const label = (h: string) => h;

  test('原机器在本机设置里有（按 id）→ 保留远端，名字给提示用', () => {
    const snap = { id: 'tokyo-arm', sshHost: 'ec2-user@1.2.3.4' } as any;
    const plan = restoreRunPlan(resolveSessionRemote(snap, targets), true, label);
    assert.deepEqual(plan, { kind: 'keep', label: 'tokyo-graviton' });
  });

  test('设置里没有（id 认不到 / 只剩快照）→ 改本机跑', () => {
    const snap = { id: 'gone', sshHost: 'ec2-user@1.2.3.4' } as any;
    assert.deepEqual(restoreRunPlan(resolveSessionRemote(snap, targets), true, label), { kind: 'local' });
    assert.deepEqual(restoreRunPlan(resolveSessionRemote(snap, null), true, label), { kind: 'local' }, '读不到设置：不赌');
  });

  test('本来就是本机会话 → none', () => {
    assert.deepEqual(restoreRunPlan(undefined, false, label), { kind: 'none' });
  });
});

describe('接线', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const P = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
  const D = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'BackupDialog.tsx'), 'utf8');
  const H = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
  const from = (anchor: string, end: string) => { const at = M.indexOf(anchor); assert.ok(at > 0, anchor); return M.slice(at, M.indexOf(end, at)); };
  const restore = from("ipcMain.handle('s3:restore'", "ipcMain.handle('offload:list'");

  test('A：s3:restore 收「放回原项目」，按 restoreTarget 放、未分组写 unassigned；界面默认不勾', () => {
    assert.match(restore, /async \(_event, sessionId: string, opts\?: \{ putBack\?: boolean \}\)/);
    assert.match(restore, /putBack: !!opts\?\.putBack,/);
    assert.match(restore, /localProjects: knownProjects\(uiState\(\)\['kirolex-projects'\]\)/);
    assert.match(restore, /if \(wantUnassigned\) next\.profile = \{ \.\.\.next\.profile, unassigned: true \};/);
    /* 放在记忆前面：未分组就不拉原项目的记忆 */
    assert.ok(restore.indexOf('restoreTarget({') < restore.indexOf("path.join('memory', 'projects', project)"));
    assert.match(P, /restoreS3Session: \(sessionId: string, opts\?: \{ putBack\?: boolean \}\) => ipcRenderer\.invoke\('s3:restore', sessionId, opts\)/);
    assert.match(D, /const \[putBack, setPutBack\] = useState\(false\);/);
    assert.match(D, /restoreS3Session\?\.\(e\.id, \{ putBack \}\)/);
    assert.match(D, /t\('Put back into original project'\)/);
  });

  test('B：水化、attach、每轮发消息都纠正假项目；记忆按纠正后的注入', () => {
    const hydrate = from("ipcMain.handle('acp:list-durable-sessions'", "ipcMain.handle('acp:mark-session-purpose'");
    assert.match(hydrate, /\.map\(\(r\) => fixBogusProject\(r, known, 'hydrate'\)\)/);
    /* 只认侧栏的项目列表，不拿磁盘上的项目目录 / 记忆目录凑数（项目记忆文件本身不动） */
    const lister = from('function localKnownProjects(', '\n}\n');
    assert.match(lister, /return knownProjects\(uiState\(\)\['kirolex-projects'\]\);/);
    assert.doesNotMatch(lister, /readdirSync/);
    const fixer = from('function fixBogusProject<', '\n}\n');
    assert.match(fixer, /store\.writeRecordKeepUpdatedAt\(next\)/, '写回，不动 updatedAt / placementChangedAt');
    assert.match(fixer, /unassigned: true as const/);
    assert.doesNotMatch(fixer, /placementChangedAt\s*=/);
    assert.match(M, /const projectId = sanitizeProjectId\(placed\.projectId \?\? \(placed\.unassigned \? undefined : derived\), sessionId, known\);/);
    const send = from('async function sendPromptOnce(', 'buildMemoryInjection(effectiveProjectId');
    assert.match(send, /bogusProjectReason\(projectId, sessionId, knownNow\)/);
    assert.match(send, /fixBogusProject\(r, knownNow, 'prompt'\)/);
    assert.ok(send.indexOf('bogusProjectReason(projectId') < send.indexOf('const effectiveProjectId'));
    /* 根因：推项目前先过 derivableProjectDir（原来那条本机判据保留） */
    const derive = from('function derivedProjectFor(', '\n}\n');
    assert.match(derive, /if \(!derivableProjectDir\(d, \(p\) => fs\.existsSync\(p\)\)\) return undefined;/);
    /* 渲染层：session-ready 不收会话 id 形状的项目；水化补项目列表时也不收 */
    assert.match(H, /if \(data\.projectId && !looksLikeSessionId\(data\.projectId\)\)/);
    assert.match(H, /filter\(\(p: any\) => p && !looksLikeSessionId\(p\)\)/);
  });

  test('C：挂载途中记录里的项目变了 → 执行器跟记录（session-ready 发的就是新的）', () => {
    const at = M.indexOf('Object.assign(profile, adopted);');
    const seg = M.slice(at, M.indexOf("session:ready-for-first-prompt', { sessionId, projectId: profile.projectId }", at));
    assert.match(seg, /const now = keepRecordPlacement\(profile, latestProfile\);/);
    assert.match(seg, /if \(pid\) profile\.projectId = pid; else delete profile\.projectId;/);
  });

  test('D：恢复按 restoreRunPlan 决定，日志 / 返回值 / 界面说的和做的一致', () => {
    assert.match(restore, /if \(rr\.plan\.kind === 'keep'\) keptRemote = rr\.plan\.label;/);
    assert.match(restore, /if \(rr\.plan\.kind === 'local'\) madeLocal = true;/);
    assert.match(restore, /keptRemote \? `，仍在 \$\{keptRemote\} 上跑` : ''/);
    assert.match(restore, /madeLocal, keptRemote,/);
    assert.match(D, /r\.keptRemote \? t\(', still runs on \{machine\}', \{ machine: r\.keptRemote \}\) : r\.madeLocal \? t\(', now runs on this machine'\) : ''/);
    assert.doesNotMatch(D, /running on this machine; to run remotely/, '不再笼统地说「在本机跑」');
  });
});

describe('云端占位（☁ 移到云端的会话）下载回本机：同一条规则', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  test('s3:restore 遇到占位提前返回时把「放回原项目」带过去', () => {
    const at = M.indexOf("ipcMain.handle('s3:restore'");
    const head = M.slice(at, at + 1200);
    assert.match(head, /if \(isOffloadedPlaceholder\(sessionId\)\) return offloadRestoreImpl\(sessionId, opts\);/);
  });
  /* 第 3 轮（用户实测：归档的占位下载后进了未分组、能连接）改了：占位下载按 placeholderPlacement 放 —— 位置和侧栏里那一行一样，项目本机有就放回，没有才未分组 + unassigned */
  test('offloadRestoreImpl 按 placeholderPlacement 放（项目本机没有 → 未分组 + unassigned），返回放下后的项目', () => {
    const at = M.indexOf('async function offloadRestoreImpl(id: string, opts?: { putBack?: boolean })');
    assert.ok(at > 0);
    const body = M.slice(at, M.indexOf('\n}\n', at));
    assert.match(body, /const rt = placeholderPlacement\(placedRec, placeholder,/);
    assert.match(body, /if \(rt\.unassigned\) next\.profile = \{ \.\.\.next\.profile, unassigned: true \};/);
    assert.match(body, /projectId: placedNow\?\.profile\?\.projectId \|\| undefined/);
    /* 侧栏的「下载回本机」不带 opts */
    assert.match(M, /const r = await offloadRestoreImpl\(id\);/);
  });
  test('规则本身：占位下载回来的记录写着 Blog，不勾 → 未分组；勾了且本机有 Blog → Blog', () => {
    const rec = { profile: { projectId: 'Blog' }, placementChangedAt: 10 };
    assert.equal(restoreTarget({ localBefore: null, backup: rec, entry: undefined, putBack: false, localProjects: local }).placement.projectId, '');
    assert.equal(restoreTarget({ localBefore: null, backup: rec, entry: undefined, putBack: true, localProjects: local }).placement.projectId, 'Blog');
  });
});

describe('启动时从旧 ui-state 恢复：假项目不再注册回项目列表', async () => {
  const { initialProjects, initialSessions, seedProjectsFromSessions } = await import('../src/renderer/projectSeed.ts');
  const H = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
  /* 现场那份 ui-state：列表只有 Dev / Blog，会话缓存里那条的归属是它自己的 id，另一条挂着一个列表里没有的旧项目 */
  const oldSessions = [
    { id: SID, title: 'bedrock proxy', projectId: SID },
    { id: 's_1790000000000_aaaaaa', title: 'x', projectId: 'Legacy' },
    { id: 's_1790000000001_bbbbbb', title: 'y', projectId: 'Dev' },
  ];

  test('列表在（哪怕夹着 s_ 名字）：去掉 s_，旧会话缓存里的归属不补进来', () => {
    const saved = initialProjects(JSON.stringify(['Dev', 'Blog', SID]));
    assert.deepEqual(saved, ['Dev', 'Blog']);
    assert.deepEqual(seedProjectsFromSessions(saved, oldSessions), ['Dev', 'Blog'], 'Legacy / s_… 不自动注册');
    assert.deepEqual(seedProjectsFromSessions(initialProjects('[]'), oldSessions), [], '空列表也是权威');
  });

  test('列表读不到：才从会话缓存重建，s_ 开头的不要', () => {
    assert.equal(initialProjects(undefined), null);
    assert.equal(initialProjects('{bad'), null);
    assert.deepEqual(seedProjectsFromSessions(null, oldSessions), ['Legacy', 'Dev']);
  });

  test('会话缓存里 s_ 开头的归属当未分组，别的不动', () => {
    const fixed = initialSessions(oldSessions);
    assert.equal(fixed[0].projectId, undefined);
    assert.equal(fixed[1].projectId, 'Legacy');
    assert.equal(fixed[2].projectId, 'Dev');
  });

  test('接线：useAcp 初始化走这几个函数，老的「从会话无条件补列表」effect 没了；纠正后的列表照常写回', () => {
    assert.match(H, /if \(saved\) return initialSessions\(JSON\.parse\(saved\)\);/);
    assert.match(H, /return seedProjectsFromSessions\(initialProjects\(uiGet\('kirolex-projects'\)\), Array\.isArray\(cached\) \? cached : \[\]\);/);
    assert.doesNotMatch(H, /new Set\(sessions\.map\(\(s\) => s\.projectId\)\.filter\(Boolean\) as string\[\]\)/);
    assert.match(H, /uiSet\('kirolex-projects', JSON\.stringify\(projects\)\);/);
  });
});

describe('恢复到未分组之后：另一台设备只是继续聊天，同步合并不会把它拉回 Blog', async () => {
  const { mergeRecords, guardMergedPlacement } = await import('../src/main/transcriptMerge.ts');
  const { applyPlacement, placementOf } = await import('../src/main/s3Sync.ts');
  /* 另一台设备（A）上这条会话在 Blog，位置时间戳 100 */
  const onA = { id: SID, title: 'bedrock proxy', updatedAt: 1000, placementChangedAt: 100, profile: { model: 'm', projectId: 'Blog' } };
  /* 这台（B）默认恢复：restoreTarget → 写进记录（和 s3:restore 同样的写法） */
  const rt = restoreTarget({ localBefore: null, backup: onA, entry: entry({ project: 'Blog', archived: false, placementChangedAt: 100 }), putBack: false, localProjects: local });
  const restored: any = applyPlacement(onA, rt.placement);
  if (rt.unassigned) restored.profile = { ...restored.profile, unassigned: true };

  test('B 上恢复后是未分组，位置时间戳和云上一样（不取现在：A 不会跟着挪）', () => {
    assert.equal(placementOf(restored).projectId, '');
    assert.equal(restored.profile.unassigned, true);
    assert.equal(restored.placementChangedAt, 100);
  });

  test('A 只聊天不移动（updatedAt 变新、位置不变）→ B 的同步合并仍是未分组，标记也在', () => {
    const aChatted = { ...onA, updatedAt: 5000, title: 'bedrock proxy (cont.)' };
    const merged = guardMergedPlacement(mergeRecords(restored, aChatted), restored, () => false);
    assert.equal(merged.title, 'bedrock proxy (cont.)', '别的字段照常按 updatedAt 取较新的');
    assert.equal(placementOf(merged).projectId, '', '不能被拉回 Blog');
    assert.equal(merged.profile.unassigned, true, '移出标记不能丢（否则 attach 又按目录反推）');
  });

  test('反过来 A 合并 B 的记录（B 聊得更新）：A 仍在 Blog —— 恢复不改别的设备的分组', () => {
    const bChatted = { ...restored, updatedAt: 9000 };
    const merged = mergeRecords(onA, bChatted);
    assert.equal(placementOf(merged).projectId, 'Blog');
    assert.ok(!merged.profile.unassigned);
  });

  test('A 之后真的挪了项目（位置时间戳更新）→ B 照「谁后挪用谁」跟上', () => {
    const aMoved = { ...onA, updatedAt: 6000, placementChangedAt: 200, profile: { ...onA.profile, projectId: 'Dev' } };
    const merged = mergeRecords(restored, aMoved);
    assert.equal(placementOf(merged).projectId, 'Dev');
    assert.ok(!merged.profile.unassigned, '跟进项目就清掉移出标记');
  });

  test('两边都是没有位置时间戳的老记录：照旧按 updatedAt', () => {
    const merged = mergeRecords({ updatedAt: 1, profile: { projectId: 'X' } }, { updatedAt: 2, profile: { projectId: 'Y' } });
    assert.equal(merged.profile.projectId, 'Y');
  });
});

describe('老记录（备份和 catalog 都没有位置时间戳）恢复到未分组后，同步合并也不拉回原项目', async () => {
  const { mergeRecords, guardMergedPlacement } = await import('../src/main/transcriptMerge.ts');
  const { applyPlacement, placementOf } = await import('../src/main/s3Sync.ts');
  const onA = { id: SID, title: 'bedrock proxy', updatedAt: 1000, profile: { model: 'm', projectId: 'Blog' } };
  const rt = restoreTarget({ localBefore: null, backup: onA, entry: entry({ project: 'Blog' }), putBack: false, localProjects: local });
  const restored: any = applyPlacement(onA, rt.placement);
  if (rt.unassigned) restored.profile = { ...restored.profile, unassigned: true };

  test('恢复出来的位置时间戳仍是 0（不让别的设备跟着挪），但标着 unassigned', () => {
    assert.equal(restored.placementChangedAt, 0);
    assert.equal(restored.profile.unassigned, true);
    assert.equal(placementOf(restored).projectId, '');
  });

  test('A 在 Blog 里聊一句 → B 同步合并后仍是未分组，标记还在', () => {
    const aChatted = { ...onA, updatedAt: 5000, title: 'bedrock proxy (cont.)' };
    const merged = guardMergedPlacement(mergeRecords(restored, aChatted), restored, () => false);
    assert.equal(merged.title, 'bedrock proxy (cont.)');
    assert.equal(placementOf(merged).projectId, '');
    assert.equal(merged.profile.unassigned, true);
  });

  test('A 合并 B 的记录（B 聊得更新）：A 仍在 Blog —— 恢复不改别的设备的分组', () => {
    const merged = mergeRecords(onA, { ...restored, updatedAt: 9000, title: 'from B' });
    assert.equal(merged.title, 'from B', '别的字段照常按 updatedAt');
    assert.equal(placementOf(merged).projectId, 'Blog');
    assert.ok(!merged.profile.unassigned);
  });

  test('两边都没标 unassigned 的普通老记录：照旧按 updatedAt 整份取', () => {
    const merged = mergeRecords({ updatedAt: 1, profile: { projectId: 'X' } }, { updatedAt: 2, profile: { projectId: 'Y' } });
    assert.equal(merged.profile.projectId, 'Y');
    const mine = mergeRecords({ updatedAt: 3, profile: { projectId: 'X' } }, { updatedAt: 2, profile: { projectId: 'Y' } });
    assert.equal(mine.profile.projectId, 'X');
  });
});

describe('先默认恢复到未分组，再勾「放回原项目」恢复同一条：能放回去', async () => {
  const { applyPlacement } = await import('../src/main/s3Sync.ts');
  const cloud = { id: SID, updatedAt: 1000, placementChangedAt: 100, profile: { projectId: 'Blog' } };
  const cat = entry({ project: 'Blog', archived: false, placementChangedAt: 100 });
  const first = restoreTarget({ localBefore: null, backup: cloud, entry: cat, putBack: false, localProjects: local });
  const onDisk: any = applyPlacement(cloud, first.placement);
  onDisk.profile = { ...onDisk.profile, unassigned: true };

  test('第一次（默认）：未分组，时间戳和云上一样', () => {
    assert.equal(onDisk.profile.projectId, undefined);
    assert.equal(onDisk.placementChangedAt, 100);
  });

  test('第二次（勾选）：时间戳一样也放回 Blog，清掉移出标记，算作挪动', () => {
    const second = restoreTarget({ localBefore: onDisk, backup: cloud, entry: cat, putBack: true, localProjects: local });
    assert.equal(second.placement.projectId, 'Blog');
    assert.equal(second.unassigned, false);
    assert.equal(second.changed, true);
  });

  test('第二次勾选但本机没有 Blog：仍是未分组', () => {
    const second = restoreTarget({ localBefore: onDisk, backup: cloud, entry: cat, putBack: true, localProjects: new Set(['Dev']) });
    assert.equal(second.placement.projectId, '');
    assert.equal(second.unassigned, true);
  });

  test('接线：合并时「原项目」看桶里那份 record.json（不是合并结果）', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const at = M.indexOf("ipcMain.handle('s3:restore'");
    const body = M.slice(at, M.indexOf("ipcMain.handle('offload:list'", at));
    assert.match(body, /try \{ if \(o\) backupRec = JSON\.parse\(\(await vetted\.get\(o\.key\)\)\.toString\('utf-8'\)\); \}/);
    assert.ok(body.indexOf('backupRec = JSON.parse') < body.indexOf('restoreTarget({'), '先拿到备份那份再定位置');
    assert.match(body, /localBefore, backup: backupRec \|\| recAfter, entry: catalogEntry,/);
  });
});

describe('云端占位下载回本机：在哪儿跑也按本机设置判（restoreRunPlan）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const at = M.indexOf('async function offloadRestoreImpl(');
  const body = M.slice(at, M.indexOf('\n}\n', at));
  const targets = [{ id: 'tokyo-arm', label: 'tokyo-graviton', sshHost: 'ec2-user@i-0c1acfa285ba8e748' }] as any;

  test('候选：回收站那份的机器，读不到就用云端这份的；再过 restoreRunPlan', () => {
    assert.match(body, /const want = before \? before\.profile\?\.remote : cur\.profile\?\.remote;/);
    assert.match(body, /const plan = restoreRunPlan\(want \? sessionRemote\(want\) : undefined, !!want\?\.sshHost,/);
    assert.match(body, /const next = plan\.kind === 'keep' \? want : undefined;/);
    assert.match(body, /if \(plan\.kind === 'keep'\) keptRemote = plan\.label;/);
    assert.match(body, /if \(plan\.kind === 'local'\) madeLocal = true;/);
    assert.match(body, /madeLocal, keptRemote, projectId:/);
  });

  test('规则：设置里删掉的机器 → 改本机；回收站读不到但云端那台还在设置里 → 保留', () => {
    const deleted = { id: 'gone', sshHost: 'ec2-user@1.2.3.4' } as any;
    assert.deepEqual(restoreRunPlan(resolveSessionRemote(deleted, targets), true, (h) => h), { kind: 'local' });
    const cloudSnap = { id: 'tokyo-arm', sshHost: 'ec2-user@old' } as any;
    assert.deepEqual(restoreRunPlan(resolveSessionRemote(cloudSnap, targets), true, (h) => h), { kind: 'keep', label: 'tokyo-graviton' });
  });
});

describe('本机已有这条（合并恢复）：运行位置按本机原来的，再过本机设置', async () => {
  const { restoreRemote } = await import('../src/main/restoreArchive.ts');
  const { mergeRecords } = await import('../src/main/transcriptMerge.ts');
  const targets = [{ id: 'tokyo-arm', label: 'tokyo-graviton', sshHost: 'ec2-user@i-0c1acfa285ba8e748' }] as any;
  const resolve = (r: any) => resolveSessionRemote(r, targets);
  const label = (h: string) => h;

  test('本机原来本机跑、云端较新且带着已从设置删掉的机器 → 合并带回了 remote，恢复后仍本机跑', () => {
    const mine = { id: SID, updatedAt: 1000, profile: { model: 'm' } };
    const theirs = { id: SID, updatedAt: 5000, profile: { model: 'm', remote: { id: 'gone', sshHost: 'ec2-user@9.9.9.9' } } };
    const merged = mergeRecords(mine, theirs);
    assert.equal(merged.profile.remote?.id, 'gone', '前提：合并按 updatedAt 带回了云端的 remote');
    const rr = restoreRemote(mine, merged, resolve, label);
    assert.equal(rr.remote, undefined, '清掉，不留一台连不上的机器');
    assert.deepEqual(rr.plan, { kind: 'none' }, '本机原来就是本机跑：不说「改成在本机跑」');
  });

  test('本机原来在 tokyo-arm（设置里有）、云端较新是本机跑 → 留在 tokyo-arm，提示「仍在 tokyo-graviton 上跑」', () => {
    const mine = { profile: { remote: { id: 'tokyo-arm', sshHost: 'ec2-user@old' } } };
    const rr = restoreRemote(mine, { profile: {} }, resolve, label);
    assert.equal(rr.remote?.id, 'tokyo-arm');
    assert.deepEqual(rr.plan, { kind: 'keep', label: 'tokyo-graviton' });
  });

  test('本机原来那台已从设置删掉 → 改本机跑，提示「改成在本机跑」', () => {
    const mine = { profile: { remote: { id: 'gone', sshHost: 'ec2-user@9.9.9.9' } } };
    const rr = restoreRemote(mine, mine, resolve, label);
    assert.equal(rr.remote, undefined);
    assert.deepEqual(rr.plan, { kind: 'local' });
  });

  test('新恢复（本机没有）：候选是备份里的', () => {
    const rr = restoreRemote(null, { profile: { remote: { id: 'tokyo-arm', sshHost: 'x' } } }, resolve, label);
    assert.deepEqual(rr.plan, { kind: 'keep', label: 'tokyo-graviton' });
  });
});
