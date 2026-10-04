import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
  `buildMemoryInjection` 会顺手 `ensureMemoryFiles` —— 用真 HOME 跑就会在 `~/.kirolex/memory/projects/`
  下面留一个 `__t_proj`。`baseDir` 在模块加载时就取 `os.homedir()` 定死了，所以必须**先**换 HOME
  （Windows 上 `os.homedir()` 认的是 USERPROFILE）再动态 import。
*/
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-memhome-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
const { buildMemoryInjection } = await import('../src/main/memory.ts');
test.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

/*
  **远程会话要被告知用 `local_write`** ——「kirolex 说它无法编辑本地的 memory 文件？为什么」。

  三件事凑成那个 bug：
    · memory 的路径永远是**这台 Mac** 的（`baseDir` 取 `os.homedir()`，main 跑在 Mac 上）；
    · 注入块原来说 "with your file tools"；
    · 远程会话的 file tools 作用在远端那台机器上 —— 那里既没有
      `/Users/<你>/.kirolex/memory` 也没有 `~/.kirolex`（实测两个都不存在）。
  而 `remoteContext.ts` 还明确告诉它「默认在你这台机器上干活」，所以两段注入互相矛盾。
*/

/** 取写法指引那一行 —— 判据只对它生效。 */
function guidance(remote: boolean): string {
  const block = buildMemoryInjection('__t_proj', undefined, { remote });
  assert.ok(block, '注入块是空的');
  const line = block!.split('\n').find((l) => l.startsWith('To remember'));
  assert.ok(line, '找不到写法指引那一行');
  return line!;
}

test('远程：必须点名 local_write，并说清文件在用户机器上', () => {
  const g = guidance(true);
  assert.match(g, /local_write/);
  assert.match(g, /local_read/);
  assert.match(g, /USER's machine, not this host/);
  /* 不能再说"用你自己的文件工具" —— 那正是把它送去远端那台机器的那句话 */
  assert.equal(/with your file tools/.test(g), false);
});

test('本地：保持原样，不要凭空要求一个本地会话去用 local_write', () => {
  const g = guidance(false);
  assert.match(g, /with your file tools/);
  assert.equal(/local_write/.test(g), false);
});

test('两种情况都要给出完整路径 —— 猜项目名是另一个已经踩过的坑', () => {
  for (const remote of [true, false]) {
    const g = guidance(remote);
    /* 分隔符跟着本机走：Windows 上是反斜杠 */
    assert.match(g, /global → \S*\.kirolex[\\/]memory[\\/]global\.md/);
    assert.ok(g.includes(fakeHome), '路径应落在临时 HOME 里，而不是真的 ~/.kirolex');
    assert.match(g, /__t_proj/);
  }
});

test('调用处把会话跑在哪传进去了 —— 不传的话这个分支永远走不到', () => {
  const src = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /buildMemoryInjection\(effectiveProjectId, sessionId, \{ remote: !!entry\.profile\.remote\?\.sshHost \}\)/,
  );
});
