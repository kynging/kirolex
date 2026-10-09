import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * electron-builder 默认输出到 dist/，而 build.files 是 "dist/**\/*"：上一次打包的 win-unpacked/、
 * *.dmg 等会被当成应用文件打进下一次的 app.asar。打包输出必须放到 release/（.gitignore 早就忽略了它）。
 */
const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf-8'));

test('electron-builder 打包输出到 release/，不和 dist/ 构建产物混在一起', () => {
  assert.equal(pkg.build?.directories?.output, 'release');
});

test('build.files 只收 dist/ 下的构建产物，不会匹配 release/', () => {
  const files: string[] = pkg.build.files;
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.ok(f.startsWith('dist/'), `build.files 里出现了 dist/ 以外的模式：${f}`);
  }
});
