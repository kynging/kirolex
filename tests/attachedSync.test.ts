import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listAttachedSessionIds } from '../src/main/attachedList.ts';
import { attachedFromMain } from '../src/renderer/attachedSync.ts';

/*
  「窗口刷新后，主进程里还连着的会话在侧栏显示成灰点」—— 2026-11-20 实测（main-20261120-113207.log）：
  控制入口 POST /reload 只刷新了渲染层，主进程的执行器都还活着；渲染层的 attached 集合从空开始，
  eager-attach 只管它那一批，其余还连着的会话落到 statusFor 的 'dormant'（灰）。

  修法：主进程给一份「当前已连接的执行器」（acp:list-attached），渲染层水化时并进 attached 集合；
  主进程自己发起的 attach（定时唤醒、控制入口 /send … 都走 ensureAttached）成功后广播 acp:attached。
*/

const root = path.join(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('主进程：列出当前已连接的执行器', () => {
  test('只返回有执行器的会话，排除连接中的和 advanced 专属的', () => {
    const live = ['a', 'b-attaching', 'c-adv', 'd', 'e-inflight'];
    const out = listAttachedSessionIds(live, {
      connecting: (id) => id === 'b-attaching' || id === 'e-inflight',
      isProtected: (id) => id === 'c-adv',
    });
    assert.deepEqual(out, ['a', 'd']);
  });

  test('空 id 不返回', () => {
    assert.deepEqual(listAttachedSessionIds(['', 'x'], { connecting: () => false, isProtected: () => false }), ['x']);
  });
});

describe('渲染层：把主进程给的那份并进 attached 集合', () => {
  test('只挑出还没在集合里的、像样的 id', () => {
    const cur = new Set(['a']);
    assert.deepEqual(attachedFromMain(cur, ['a', 'b', '', 3, null, 'c', 'b']), ['b', 'c']);
  });

  test('主进程回的不是数组（老主进程 / 出错）就什么都不加', () => {
    assert.deepEqual(attachedFromMain(new Set(), undefined), []);
    assert.deepEqual(attachedFromMain(new Set(), { ids: ['a'] }), []);
  });
});

describe('接线', () => {
  const main = read('src/main/index.ts');
  const preload = read('src/main/preload.ts');
  const acp = read('src/renderer/hooks/useAcp.ts');

  test('主进程 acp:list-attached 按 sessionClients 列，连接中 = attachingSessions / attachInFlight，advanced 专属排除', () => {
    const at = main.indexOf("ipcMain.handle('acp:list-attached'");
    assert.ok(at > 0, '要有 acp:list-attached');
    const body = main.slice(at, at + 600);
    assert.match(body, /listAttachedSessionIds\(\s*sessionClients\.keys\(\)/);
    assert.match(body, /attachingSessions\.has/);
    assert.match(body, /attachInFlight\.has/);
    assert.match(body, /store\.isAdvancedOnlySession/);
  });

  test('preload 暴露 listAttached / onAttached', () => {
    assert.match(preload, /listAttached:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('acp:list-attached'\)/);
    assert.match(preload, /ipcRenderer\.on\('acp:attached'/);
  });

  test('主进程发起的 attach（ensureAttached）成功后广播 acp:attached', () => {
    const at = main.indexOf('const ensureAttached = async');
    const body = main.slice(at, main.indexOf('reattachSession = ensureAttached;', at));
    assert.match(body, /webContents\.send\('acp:attached'/);
  });

  test('渲染层水化时先并进主进程那份，再挑预热的（并进来的不再 loadSession）', () => {
    const eff = acp.indexOf('Eager-attach existing sessions at startup');
    const body = acp.slice(eff, acp.indexOf('}, [hydrated]);', eff));
    const list = body.indexOf('window.kiroApi.listAttached');
    assert.ok(list > 0, 'eager-attach 里要调 listAttached');
    assert.ok(list < body.indexOf('sessionsToWarm('), '要在挑预热会话之前');
    assert.match(body, /attachedFromMain\(attachedIdsRef\.current, await window\.kiroApi\.listAttached\?\.\(\)\)\) addAttached\(id\)/);
    /* 已经在集合里的：不标连接中、不 loadSession（这两处守卫原本就有，合并进来就生效） */
    assert.match(body, /if \(!attachedIdsRef\.current\.has\(s\.id\)\) markConnecting\(s\.id\)/);
    assert.match(body, /if \(cancelled \|\| attachedIdsRef\.current\.has\(s\.id\)\) \{ clearConnecting\(s\.id\); return; \}/);
  });

  test('渲染层收到 acp:attached 就标成已连接', () => {
    const at = acp.indexOf('window.kiroApi.onAttached');
    assert.ok(at > 0);
    assert.match(acp.slice(at, at + 500), /addAttached\(sid\)/);
  });
});
