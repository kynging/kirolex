import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkSessionFiles, isDependencyDir, isArchiveFile, MAX_FILE_BYTES } from '../src/main/s3Sync.ts';

/*
  会话 files/ 是工作目录 —— 实测把旧 Downloads 输出搬进来后三条会话合计九万个文件 / 2G，
  去掉依赖、代码仓库和压缩包之后剩 142 个 / 3MB。「S3 里只存代码」「code repo 和大块东西不用动」。
*/
function tree(spec: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-'));
  for (const [rel, body] of Object.entries(spec)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return root;
}

test('依赖目录、代码仓库、压缩包都不列；真产出都列', () => {
  const root = tree({
    'files/report.md': '#',
    'files/deck.pptx': 'x',
    'files/proj/node_modules/a/index.js': 'x',
    'files/proj/__pycache__/m.pyc': 'x',
    'files/build/pkg-1.0.dist-info/METADATA': 'x',      // pip install -t build → 依赖
    'files/build/pkg/__init__.py': 'x',
    'files/out/build/result.csv': 'x',                   // 名字叫 build 但不是依赖 → 照传
    'files/env/pyvenv.cfg': 'x',
    'files/env/lib/x.py': 'x',
    'files/repo/.git/HEAD': 'ref',                       // clone 下来的仓库
    'files/repo/src/main.py': 'x',
    'files/hermes-worker.zip': 'x',
    'files/AWSCLIV2.pkg': 'x',
  });
  const got = walkSessionFiles(root, 'files').map((r) => r.split(path.sep).join('/')).sort();
  assert.deepEqual(got, ['files/deck.pptx', 'files/out/build/result.csv', 'files/report.md']);
});

test('按内容认依赖目录，不按名字猜 build', () => {
  const root = tree({ 'a/x.dist-info/M': '', 'b/out.txt': '' });
  assert.equal(isDependencyDir(path.join(root, 'a'), 'a'), true);
  assert.equal(isDependencyDir(path.join(root, 'b'), 'build'), false);
  assert.equal(isDependencyDir('/nope', 'node_modules'), true);
});

test('压缩包/安装包按扩展名认；上限 200MB', () => {
  for (const n of ['a.zip', 'b.PKG', 'c.tar.gz', 'd.whl', 'e.dmg']) assert.equal(isArchiveFile(n), true, n);
  for (const n of ['a.pptx', 'b.pdf', 'c.md', 'zipper.py']) assert.equal(isArchiveFile(n), false, n);
  assert.equal(MAX_FILE_BYTES, 200 * 1024 * 1024);
});
