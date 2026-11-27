/**
 * 恢复页标出「已经在这台电脑上」的会话（backupGroups.ts）。
 *
 * 已在本机的通常不需要恢复，只需要开自动同步：每组本机没有的排前面，已在本机的收进组末尾的子段；
 * 组头「全选」只勾本机没有的；顶部计数「云上 N 条：本机没有 A 条，已在本机 B 条（其中 C 条没开自动同步）」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { groupBackups, groupHeadPick, toggleGroupHeadPick, restoreCounts, restoreCountsText } from '../src/renderer/backupGroups.ts';

type E = { id: string; project?: string; updatedAt: number; archived?: boolean; existsLocally?: boolean; crossDevice?: boolean; busy?: boolean };
const e = (id: string, updatedAt: number, existsLocally: boolean, extra: Partial<E> = {}): E => ({ id, project: 'Dev', updatedAt, existsLocally, ...extra });
const entries: E[] = [
  e('local-new', 90, true, { crossDevice: true }),
  e('remote-old', 10, false),
  e('local-old', 20, true),
  e('remote-new', 80, false),
  e('remote-busy', 70, false, { busy: true }),
  e('arch-local', 50, true, { archived: true }),
  e('arch-remote', 40, false, { archived: true }),
];

describe('groupBackups：本机没有的在前，已在本机的进子段', () => {
  const groups = groupBackups(entries);
  const dev = groups.find((g) => g.key === 'Dev')!;
  test('notLocal / local 分开，各自按最近更新排', () => {
    assert.deepEqual(dev.notLocal.map((x) => x.id), ['remote-new', 'remote-busy', 'remote-old']);
    assert.deepEqual(dev.local.map((x) => x.id), ['local-new', 'local-old']);
  });
  test('rows = 本机没有的在前 + 已在本机的', () => {
    assert.deepEqual(dev.rows.map((x) => x.id), ['remote-new', 'remote-busy', 'remote-old', 'local-new', 'local-old']);
  });
  test('「已归档」组同样拆', () => {
    const arch = groups.find((g) => g.archived)!;
    assert.deepEqual(arch.notLocal.map((x) => x.id), ['arch-remote']);
    assert.deepEqual(arch.local.map((x) => x.id), ['arch-local']);
  });
  test('空组两边都是空', () => {
    const none = groups.find((g) => g.key === '未分组')!;
    assert.deepEqual([none.notLocal.length, none.local.length], [0, 0]);
  });
  test('组的顺序不受影响（仍按组内最近更新）', () => {
    assert.deepEqual(groupBackups([e('a', 5, true, { project: 'A' }), e('b', 9, false, { project: 'B' })]).map((g) => g.name), ['B', 'A', '未分组', '已归档']);
  });
});

describe('组头「全选」只勾本机没有的', () => {
  const dev = groupBackups(entries).find((g) => g.key === 'Dev')!;
  test('全选 → 只勾本机没有、能选的（跳过正在跑的），已在本机的不勾', () => {
    assert.deepEqual([...toggleGroupHeadPick(new Set(), dev)].sort(), ['remote-new', 'remote-old']);
  });
  test('已在本机的单独勾着不影响组头状态；全选再点一下只取消本机没有的', () => {
    const picked = new Set(['local-old', 'remote-new', 'remote-old']);
    assert.equal(groupHeadPick(dev, picked).state, 'all');
    assert.deepEqual([...toggleGroupHeadPick(picked, dev)], ['local-old']);
  });
  test('只勾了已在本机的 → 组头是 none', () => {
    assert.equal(groupHeadPick(dev, new Set(['local-new'])).state, 'none');
  });
  test('整组都在本机 → 组头没有可选的', () => {
    assert.equal(groupHeadPick(groupBackups([e('x', 1, true)]).find((g) => g.key === 'Dev')!, new Set()).selectable, 0);
  });
});

describe('restoreCounts：顶部计数', () => {
  test('N / A / B / C', () => {
    assert.deepEqual(restoreCounts(entries), { total: 7, notLocal: 4, local: 3, localNoSync: 2, localNoSyncIds: ['local-old', 'arch-local'] });
  });
  test('文案', () => {
    assert.equal(restoreCountsText(restoreCounts(entries), 'zh'), '云上 7 条：本机没有 4 条，已在本机 3 条（其中 2 条没开自动同步）');
    assert.equal(restoreCountsText({ total: 2, notLocal: 1, local: 1, localNoSync: 0, localNoSyncIds: [] }, 'zh'), '云上 2 条：本机没有 1 条，已在本机 1 条');
    assert.equal(restoreCountsText(restoreCounts(entries), 'en'), '7 in the cloud: 4 not on this machine, 3 already here (2 without auto-sync)');
  });
  test('空', () => {
    assert.deepEqual(restoreCounts([]), { total: 0, notLocal: 0, local: 0, localNoSync: 0, localNoSyncIds: [] });
  });
});

describe('接线', () => {
  const UI = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupDialog.tsx'), 'utf8');
  const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
  const ACP = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');
  const PRE = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');
  const MI = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  test('「开启自动同步」和侧栏右键「在其他电脑上同步」走同一个 IPC（acp:set-cross-device）', () => {
    assert.match(PRE, /setCrossDevice: \(id: string, on: boolean\) => ipcRenderer\.invoke\('acp:set-cross-device', id, on\)/);
    /* 侧栏右键 → App 的 onToggleCrossDevice → useAcp.setCrossDevice → kiroApi.setCrossDevice */
    assert.match(SB, /onToggleCrossDevice=\{\(id, on\) => \{[\s\S]{0,200}setCrossDevice\(id, on\)/);
    assert.match(ACP, /kiroApi\?\.setCrossDevice\?\.\(sessionId, on\)/);
    /* 恢复页：同一个 kiroApi.setCrossDevice(id, true)，不调恢复 */
    const fn = UI.slice(UI.indexOf('const enableAutoSync = async'), UI.indexOf('const enableAutoSync = async') + 900);
    assert.match(fn, /api\(\)\?\.setCrossDevice\?\.\(id, true\)/);
    assert.doesNotMatch(fn, /restoreS3Session/);
  });
  test('主进程把本机的 crossDevice 和 existsLocally 一起给出来', () => {
    assert.match(MI, /existsLocally: local\.has\(e\.id\),\n\s+\/\*[^*]*\*\/\n\s+crossDevice: isShared\(recById\.get\(e\.id\)\),/);
  });
  test('组头全选用 notLocal；删除仍按整组勾选', () => {
    assert.match(UI, /toggleGroupHeadPick\(prev, g\)/);
    assert.match(UI, /const gp = groupPickState\(rows, picked\);/);
  });
  test('「已在本机」子段收起状态记在本机（uiStore）', () => {
    assert.match(UI, /uiSet\(LOCAL_OPEN_KEY,/);
    assert.match(UI, /uiGet\(LOCAL_OPEN_KEY\)/);
  });
  test('「全部开启自动同步」要二次确认', () => {
    assert.match(UI, /setConfirm\(\{\s*title: t\('Turn on auto-sync for all'\)/);
  });
});
