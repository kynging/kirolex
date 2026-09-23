import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mentionedPaths, stagedRel, stageFiles, writeBack, readManifest,
  bridgeRefused, BRIDGE_DIR, MAX_BRIDGE_BYTES,
} from '../src/main/localFileBridge.ts';

/*
 * 「给远程会话也加上读和修改本地文件的能力啊」/「要读的文件弄到工作目录」。
 *
 * 为什么只能这么做：远端的 kiro-cli 只看得见**远端**的文件系统 —— 实测客户端声明了 ACP 的
 * `fs.readTextFile/writeTextFile` 之后它照样自己读文件，回调客户端 **0 次**。所以"读本地文件"
 * 只能是：把文件摆渡进镜像 → 它改那一份 → 写回原处。
 */
describe('把你提到的本地文件摆渡过去', () => {
  function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-')); }

  test('只认**绝对路径**，`~` 展开，句读不算路径的一部分', () => {
    const home = '/Users/k';
    const got = mentionedPaths('把 ~/Downloads/a.md 和 /tmp/b.json 改一下，还有 /etc/hosts。', home);
    assert.ok(got.includes('/Users/k/Downloads/a.md'));
    assert.ok(got.includes('/tmp/b.json'));
    assert.ok(got.includes('/etc/hosts'), '没有后缀但有两层目录也算');
    assert.equal(got.some((p) => p.endsWith('。')), false, '中文句读要去掉');
  });

  test('**不猜**：相对路径、裸文件名、纯文字一个都不认', () => {
    assert.deepEqual(mentionedPaths('改一下 src/a.ts 和 README 里的说明'), []);
    assert.deepEqual(mentionedPaths('随便写点东西'), []);
  });

  test('凭据类路径一律不摆渡（和镜像那边同一份判据）', () => {
    for (const p of ['/Users/k/.aws/credentials', '/Users/k/.ssh/id_rsa', '/Users/k/kyn-key.pem', '/Users/k/.kirolex/config.json']) {
      assert.equal(bridgeRefused(p), true, p);
    }
    assert.equal(bridgeRefused('/Users/k/code/a.ts'), false);
  });

  test('同名文件来自不同目录时不会互相盖', () => {
    assert.notEqual(stagedRel('/a/x/note.md'), stagedRel('/b/y/note.md'));
    assert.match(stagedRel('/a/x/note.md'), new RegExp(`^${BRIDGE_DIR}/[0-9a-f]{8}/note\\.md$`));
  });

  test('摆渡：拷进工作目录、记账；目录/超大/凭据都拒绝并说清原因', () => {
    const work = tmp();
    const src = tmp();
    fs.writeFileSync(path.join(src, 'a.md'), 'hello');
    fs.writeFileSync(path.join(src, 'big.bin'), Buffer.alloc(MAX_BRIDGE_BYTES + 1));
    const res = stageFiles(work, [
      path.join(src, 'a.md'),
      path.join(src, 'big.bin'),
      src,                                  // 目录
      path.join(src, 'nope.md'),            // 不存在
      '/Users/k/.aws/credentials',          // 凭据
    ]);
    assert.deepEqual(res.staged.map((e) => path.basename(e.local)), ['a.md']);
    assert.equal(fs.readFileSync(path.join(work, res.staged[0].rel), 'utf8'), 'hello');
    const why = res.refused.map((r) => r.why).join(' ');
    assert.match(why, /太大/);
    assert.match(why, /不整目录搬/);
    assert.match(why, /凭据/);
    /* 不存在的路径当作"没提"，不报错也不记账 */
    assert.equal(readManifest(work).length, 1);
  });

  test('已经在镜像里的文件不用摆渡', () => {
    const work = tmp();
    fs.writeFileSync(path.join(work, 'inside.md'), 'x');
    assert.deepEqual(stageFiles(work, [path.join(work, 'inside.md')]).staged, []);
  });

  test('写回：远端改过的写回原处，两边都改过的**不覆盖**（落 .remote）', () => {
    const work = tmp();
    const src = tmp();
    const f1 = path.join(src, 'one.md');
    const f2 = path.join(src, 'two.md');
    fs.writeFileSync(f1, 'v1');
    fs.writeFileSync(f2, 'v1');
    const { staged } = stageFiles(work, [f1, f2]);
    assert.equal(staged.length, 2);
    /* 远端改了两份 */
    for (const e of staged) fs.writeFileSync(path.join(work, e.rel), 'remote-edit');
    /* 本地也改了第二份 —— 这一份不许被覆盖 */
    fs.writeFileSync(f2, 'local-edit');
    const r = writeBack(work);
    assert.deepEqual(r.written, [f1]);
    assert.deepEqual(r.conflicts, [f2]);
    assert.equal(fs.readFileSync(f1, 'utf8'), 'remote-edit');
    assert.equal(fs.readFileSync(f2, 'utf8'), 'local-edit', '你的那份一个字都不能动');
    assert.equal(fs.readFileSync(`${f2}.remote`, 'utf8'), 'remote-edit');
  });

  test('远端没改就什么都不做（每轮都写一遍会把原文件的 mtime 搅乱）', () => {
    const work = tmp();
    const src = tmp();
    const f = path.join(src, 'a.md');
    fs.writeFileSync(f, 'v1');
    stageFiles(work, [f]);
    assert.deepEqual(writeBack(work), { written: [], conflicts: [] });
  });
});

describe('接线', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('发送前摆渡 + 把消息里的路径改写成远端那一份', () => {
    assert.match(M, /const wanted = mentionedPaths\(text\)/);
    assert.match(M, /const res = stageFiles\(bridgeDir, wanted\);/);
    assert.match(M, /t = t\.split\(local\)\.join\(remote\);/);
    /* 拒绝的也要说出来 —— 默默不带过去最糟 */
    assert.match(M, /没有带过去：\$\{r\.why\}/);
  });

  test('拉完写回原处（这是"能改本地文件"的另一半）', () => {
    assert.match(M, /afterPull: \(sessionId\) => \{/);
    assert.match(M, /const r = writeBack\(dir\);/);
    assert.match(M, /已经写回原处/);
  });

  test('注入里要告诉模型摆渡目录在哪 —— 否则它会以为那个路径不存在', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({ hostLabel: 'h', remoteDir: '/r/proj', localDir: '/l' });
    assert.match(b, /_kirolex-local/);
    assert.match(b, /写回用户机器上的原处/);
  });
});
