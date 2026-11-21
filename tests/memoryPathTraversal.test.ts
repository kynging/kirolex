import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * 记忆层的项目名 / 会话 id 不能带出 `~/.kirolex/memory`。
 *
 * 原来 `projectDir` / `sessionDir` 是裸的 `path.join(baseDir, 'projects', id)`：
 * `acp:delete-project-memory` 传一个 `../../victim` 就递归删掉任意目录，`acp:write-memory`
 * 或自动整理（`profile.projectId` 来自 S3 同步回来的 record.json）就能往任意路径写 `memory.md`。
 *
 * `memory.ts` 在模块加载时从 `os.homedir()` 算 baseDir，所以在子进程里跑、把 HOME 指到临时目录。
 */
const here = import.meta.dirname;
let home = '';

function run(body: string): string {
  const script = `
    const m = await import(${JSON.stringify(pathToFileURL(path.join(here, '..', 'src', 'main', 'memory.ts')).href)});
    const out = [];
    const tryIt = (f) => { try { f(); out.push('ok'); } catch (e) { out.push('threw'); } };
    ${body}
    process.stdout.write(JSON.stringify(out));
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

const EVIL = ['../../../victim', '..', '.', 'a/../../../victim', 'a\\..\\..\\..\\victim', '/abs/victim', 'x\u0000y'];

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-memtrav-'));
  fs.mkdirSync(path.join(home, 'victim'), { recursive: true });
  fs.writeFileSync(path.join(home, 'victim', 'keep.txt'), 'precious');
  fs.mkdirSync(path.join(home, '.kirolex', 'memory', 'projects', 'Dev'), { recursive: true });
  fs.writeFileSync(path.join(home, '.kirolex', 'memory', 'projects', 'Dev', 'memory.md'), 'dev facts');
});

after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

describe('记忆路径不能跳出 memory 目录', () => {
  test('deleteProjectMemory / deleteSessionMemory 不会删到外面的目录', () => {
    run(EVIL.map((id) => `m.deleteProjectMemory(${JSON.stringify(id)}); m.deleteSessionMemory(${JSON.stringify(id)});`).join('\n'));
    assert.equal(fs.readFileSync(path.join(home, 'victim', 'keep.txt'), 'utf-8'), 'precious');
    assert.ok(fs.existsSync(path.join(home, '.kirolex', 'memory', 'projects')), 'projects 目录本身也不能被 `.` 删掉');
    assert.ok(fs.existsSync(path.join(home, '.kirolex', 'memory', 'projects', 'Dev', 'memory.md')));
  });

  test('writeMemory 对非法 id 抛错，且不在外面建目录 / 写文件', () => {
    const out = JSON.parse(run(EVIL.flatMap((id) => [
      `tryIt(() => m.writeMemory('project', ${JSON.stringify(id)}, undefined, 'pwned'));`,
      `tryIt(() => m.writeMemory('session', undefined, ${JSON.stringify(id)}, 'pwned'));`,
    ]).join('\n')));
    assert.deepEqual(out, EVIL.flatMap(() => ['threw', 'threw']));
    assert.ok(!fs.existsSync(path.join(home, 'victim', 'memory.md')));
    assert.ok(!fs.existsSync(path.join(home, '.kirolex', 'memory', 'memory.md')));
    assert.ok(!fs.existsSync(path.join(home, '.kirolex', 'victim')));
  });

  test('readMemory 对非法 id 抛错；注入 / 字节数不建外面的目录', () => {
    const out = JSON.parse(run([
      `tryIt(() => m.readMemory('../../../victim', 's_ok'));`,
      `tryIt(() => m.readMemory('Dev', '../../../victim'));`,
      `out.push(m.buildMemoryInjection('../../../victim2', 's_ok'));`,
      `out.push(m.memoryLayerBytes('../../../victim', '../../../victim'));`,
      `out.push(m.backupMemoryLayer('project', '../../../victim', undefined, 'stamp'));`,
    ].join('\n')));
    assert.deepEqual(out.slice(0, 2), ['threw', 'threw']);
    assert.equal(out[2], null);
    assert.equal(out[3].project, 0);
    assert.equal(out[3].session, 0);
    assert.equal(out[4], null);
    assert.ok(!fs.existsSync(path.join(home, 'victim2')));
    assert.ok(!fs.existsSync(path.join(home, 'victim', 'memory.md')));
  });

  test('正常的项目名（空格、中文、点）照常工作', () => {
    const out = JSON.parse(run([
      `m.writeMemory('project', 'SFDC Activity', undefined, 'a');`,
      `m.writeMemory('project', '研究 v1.2', undefined, 'b');`,
      `m.writeMemory('session', undefined, 's_123_abc', 'c');`,
      `out.push(m.readMemory('Dev', 's_123_abc'));`,
    ].join('\n')));
    const mem = path.join(home, '.kirolex', 'memory');
    assert.equal(fs.readFileSync(path.join(mem, 'projects', 'SFDC Activity', 'memory.md'), 'utf-8'), 'a');
    assert.equal(fs.readFileSync(path.join(mem, 'projects', '研究 v1.2', 'memory.md'), 'utf-8'), 'b');
    assert.equal(out[0].project, 'dev facts');
    assert.equal(out[0].session, 'c');
  });
});
