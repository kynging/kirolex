import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { applyDockIcon, dockIconPath, type DockIconDeps } from '../src/main/dockIcon.ts';

/*
  「Mac 上 npm start 跑时 Dock 显示的是 Electron 默认图标」—— 启动时用 build/icon.png 设 Dock 图标。
  纯逻辑用注入的假 app / nativeImage 测：路径、非 darwin 不动、没有 dock 不动、文件缺失 / 图片为空只 warn 不抛。
*/

function fake(opts: { platform?: string; dock?: boolean; exists?: boolean; empty?: boolean } = {}) {
  const calls = { setIcon: [] as unknown[], createFromPath: [] as string[], warn: [] as string[] };
  const img = { isEmpty: () => !!opts.empty };
  const deps: DockIconDeps = {
    platform: opts.platform ?? 'darwin',
    app: {
      getAppPath: () => '/Apps/KiroLex',
      dock: opts.dock === false ? undefined : { setIcon: (i) => { calls.setIcon.push(i); } },
    },
    nativeImage: { createFromPath: (p) => { calls.createFromPath.push(p); return img; } },
    existsSync: () => opts.exists ?? true,
    warn: (m) => { calls.warn.push(m); },
  };
  return { deps, calls, img };
}

test('dockIconPath = <appPath>/build/icon.png', () => {
  assert.equal(dockIconPath('/Apps/KiroLex'), path.join('/Apps/KiroLex', 'build', 'icon.png'));
});

test('darwin + dock + 图片正常 → setIcon 用这张图', () => {
  const { deps, calls, img } = fake();
  assert.equal(applyDockIcon(deps), true);
  assert.deepEqual(calls.createFromPath, [path.join('/Apps/KiroLex', 'build', 'icon.png')]);
  assert.deepEqual(calls.setIcon, [img]);
  assert.deepEqual(calls.warn, []);
});

test('非 darwin 什么都不做（不读文件、不 setIcon、不 warn）', () => {
  for (const platform of ['win32', 'linux']) {
    const { deps, calls } = fake({ platform });
    assert.equal(applyDockIcon(deps), false);
    assert.deepEqual(calls.createFromPath, []);
    assert.deepEqual(calls.setIcon, []);
    assert.deepEqual(calls.warn, []);
  }
});

test('darwin 但没有 app.dock → 什么都不做', () => {
  const { deps, calls } = fake({ dock: false });
  assert.equal(applyDockIcon(deps), false);
  assert.deepEqual(calls.setIcon, []);
  assert.deepEqual(calls.warn, []);
});

test('图片为空 → 不 setIcon，只 warn 一条', () => {
  const { deps, calls } = fake({ empty: true });
  assert.equal(applyDockIcon(deps), false);
  assert.deepEqual(calls.setIcon, []);
  assert.equal(calls.warn.length, 1);
});

test('文件缺失 → 不读图、不 setIcon，只 warn 一条', () => {
  const { deps, calls } = fake({ exists: false });
  assert.equal(applyDockIcon(deps), false);
  assert.deepEqual(calls.createFromPath, []);
  assert.deepEqual(calls.setIcon, []);
  assert.equal(calls.warn.length, 1);
});

test('setIcon 抛错也不往外抛，只 warn', () => {
  const { deps, calls } = fake();
  deps.app.dock!.setIcon = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => applyDockIcon(deps));
  assert.equal(calls.warn.length, 1);
});

test('仓库里 build/icon.png 真的存在（npm start 时 getAppPath() 就是仓库根）', () => {
  assert.ok(fs.existsSync(dockIconPath(path.join(import.meta.dirname, '..'))));
});

test('index.ts 在 whenReady 里调 applyDockIcon，主窗口带 icon', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const ready = src.indexOf("app.whenReady().then(async () => {\n  startupMark('app ready');");
  assert.ok(ready >= 0);
  const call = src.indexOf('applyDockIcon({', ready);
  assert.ok(call > ready && call - ready < 400, 'applyDockIcon 应在 whenReady 一开头调用');
  assert.match(src, /mainWindow = new BrowserWindow\(\{[\s\S]{0,2000}icon: dockIconPath\(/);
});
