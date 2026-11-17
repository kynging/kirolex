import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
  安全扫描：`s3:restore` 原来用宽松的 `/^[\w.-]+$/` 校验 id，`.` 能过 ——
  `path.join('sessions', '.')` 收成整个 `sessions/`，于是桶前缀和本地目录都变成整棵会话树，
  advanced 的备份关（record.json 不在根上 → 当没有）和 store 写盘关（isRecord 永远不中）一起被绕开，
  桶里任意内容被写进本机**每一条**会话。

  堵法：恢复的 id 用和落盘同一个判据（sessionStore 的 ID_SHAPE），并且每个对象写之前确认落在这条会话的目录里。
*/
describe('s3:restore: session id must match the store grammar', () => {
  let home = '';
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let store: typeof import('../src/main/sessionStore.ts');

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-restoreid-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    store = await import('../src/main/sessionStore.ts');
  });
  after(() => {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('isValidSessionId rejects dot-only, dotted, separators and oversize ids', () => {
    for (const bad of ['.', '..', '...', 'a.b', 's_1.json', '../x', 'a/b', 'a\\b', '', ' ', 'x'.repeat(121), undefined, null, 42, {}]) {
      assert.equal(store.isValidSessionId(bad as any), false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('isValidSessionId accepts real session ids', () => {
    for (const ok of ['s_1700000000000_abc123', 'flow-main', 'A_b-9', 'x'.repeat(120)]) {
      assert.equal(store.isValidSessionId(ok), true, ok);
    }
  });

  test('isValidSessionId agrees with the store write gate', () => {
    for (const id of ['.', '..', 'a.b', 's_ok_1']) {
      let threw = false;
      try { store.sessionDirPath(id); } catch { threw = true; }
      assert.equal(store.isValidSessionId(id), !threw, id);
    }
  });
});

describe('index.ts wiring: s3:restore', () => {
  const main = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  const h = main.slice(main.indexOf("ipcMain.handle('s3:restore'"), main.indexOf("ipcMain.handle('offload:list'"));

  test('validates the id with the store grammar before building any prefix / path', () => {
    assert.ok(h.length > 0);
    const check = h.indexOf('store.isValidSessionId(sessionId)');
    assert.ok(check > 0, 's3:restore must use store.isValidSessionId');
    assert.doesNotMatch(h.slice(0, h.indexOf('const prefix')), /\/\^\[\\w\.-\]\+\$\//, 'no loose /^[\\w.-]+$/ check left');
    assert.ok(check < h.indexOf("path.join('sessions', sessionId)"), 'checked before the S3 prefix is built');
    assert.ok(check < h.indexOf("path.join(KIROLEX_HOME, 'sessions', sessionId)"), 'checked before the local dir is built');
  });

  test('every restored object must land inside this session\'s local dir', () => {
    const loop = h.slice(h.indexOf('for (const obj of objects)'));
    const inside = loop.indexOf('localDir + path.sep');
    assert.ok(inside > 0, 'loop checks abs is under localDir');
    assert.ok(inside < loop.indexOf('vetted.get(obj.key)'), 'before downloading / writing anything');
  });
});

describe('index.ts wiring: s3:list-backups', () => {
  const main = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  const h = main.slice(main.indexOf("ipcMain.handle('s3:list-backups'"), main.indexOf("ipcMain.handle('s3:keep-local'"));
  test('entries with ids that cannot be restored are not listed', () => {
    assert.match(h, /store\.isValidSessionId\(e\.id\)/);
  });
});
