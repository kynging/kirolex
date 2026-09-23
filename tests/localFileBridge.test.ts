import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mentionedPaths, stagedRel, stageFiles, writeBack, readManifest,
  bridgeRefused, BRIDGE_DIR, MAX_BRIDGE_BYTES, writeManifest, manifestPath,
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
    /* 凭据那一条要**真的存在**才有意义：不存在的路径一律当"没提"（见下面那条） */
    fs.mkdirSync(path.join(src, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(src, '.aws', 'credentials'), 'x');
    const res = stageFiles(work, [
      path.join(src, 'a.md'),
      path.join(src, 'big.bin'),
      src,                                  // 目录
      path.join(src, 'nope.md'),            // 不存在
      path.join(src, '.aws', 'credentials'), // 凭据
    ]);
    assert.deepEqual(res.staged.map((e) => path.basename(e.local)), ['a.md']);
    assert.equal(fs.readFileSync(path.join(work, res.staged[0].rel), 'utf8'), 'hello');
    const why = res.refused.map((r) => r.why).join(' ');
    assert.match(why, /太大/);
    assert.match(why, /不整目录搬/);
    assert.match(why, /凭据/);
    /* 凭据那一条是 `quiet`：进日志、**不在界面上说** —— 规则定死了，说了你也做不了什么，
       而你通常只是在**聊**这些路径。太大/整目录那些是你真想用这个文件，所以要说。 */
    const quiet = res.refused.filter((r) => r.quiet).map((r) => path.basename(r.local));
    assert.deepEqual(quiet, ['credentials']);
    /* 不存在的路径当作"没提"，不报错也不记账 */
    assert.equal(readManifest(work).length, 1);
  });

  test('**不存在的路径一句提示都不给** —— 讲路径的消息不是在让我搬文件', () => {
    /* 实测：一条说明 `~/.kirolex/memory/projects/<项目名>/memory.md` 这类模板的消息，
       换来 20 条 ⚠️，每条都在解释一个根本不存在的文件为什么没被摆渡。
       判断顺序因此是 **先看在不在，再谈拒不拒绝**：提示只留给"你确实指了一个文件、而我没带过去"。 */
    const work = tmp();
    const res = stageFiles(work, [
      '/Users/keyinan/.kirolex/memory/projects/<项目名',   // 模板，不存在
      '/Users/keyinan/.aws/credentials-does-not-exist',    // 凭据形状，但不存在
    ]);
    assert.deepEqual(res.staged, []);
    assert.deepEqual(res.refused, [], `不该有提示：${JSON.stringify(res.refused)}`);
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
    /* 扫的是**你自己写的那段文字**，不是拼完注入之后的全文（见 tests/localAction.test.ts） */
    assert.match(M, /const wanted = mentionedPaths\(userPromptText\)/);
    assert.match(M, /const res = stageFiles\(bridgeDir, wanted\);/);
    assert.match(M, /t = t\.split\(local\)\.join\(remote\);/);
    /* 拒绝的也要说出来 —— 默默不带过去最糟。但**合成一条**：状态行一次只显示一句，
       一条一提示等于把前面那些挨个顶掉（实测一条消息刷出 20 条 ⚠️）。 */
    assert.match(M, /这些提到的东西没带到远端/);
    /* 而"凭据/KiroLex 自己的记录"那一类**连提示都不给**（`quiet`）——「怎么老有什么凭证不带过去之类的提示」 */
    assert.match(M, /const loud = res\.refused\.filter\(\(r\) => !r\.quiet\);/);
    assert.equal(/for \(const r of res\.refused\) \{\s*\n\s*sessionNotice/.test(M), false, '不许一条一条提示');
    assert.match(M, /for \(const r of res\.refused\) logger\.info/, '逐条要留在日志里');
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

/*
 * 「有报错，有些文件两端都改过」/「怎么有 manifest 一直报错呢」—— 实测 07:45–07:57 每 20 秒一条
 * `_kirolex-local/manifest.json` 的冲突提示，本地还被塞了 `manifest.json.remote`。
 *
 * 根因和 `history.md` 那次一字不差：**本地独占写的文件躺在被同步的树里**。
 * `writeBack` 每次拉完都重写账本 → 它和远端那份不一致 → 下一次拉 rsync 要覆盖它（incoming）
 * → 它同时又在"自推送以来本地变过"里 → 判成冲突。两道都要修：不过河，且不做无谓的写入。
 */
describe('摆渡的账本不过河、也不白写', () => {
  test('`_kirolex-local/manifest.json` 两个方向都排除，而且是**锚在根上**的那一条', async () => {
    const { MIRROR_PRIVATE, pushArgs, pullArgs, isExcluded } = await import('../src/main/remoteMirror.ts');
    assert.deepEqual(MIRROR_PRIVATE, ['/_kirolex-local/manifest.json']);
    const spec = {
      remote: { sshHost: 'h' } as any,
      localDir: '/l', remoteDir: '/r', sshCommand: 'ssh',
    };
    for (const args of [pushArgs(spec), pullArgs(spec)]) {
      assert.ok(args.includes('/_kirolex-local/manifest.json'), `缺排除：${args.join(' ')}`);
    }
    /* 锚在根上 —— 前端项目里 `manifest.json` 是个真文件，不能顺手把它也排掉 */
    assert.equal(isExcluded('_kirolex-local/manifest.json', MIRROR_PRIVATE), true);
    assert.equal(isExcluded('public/manifest.json', MIRROR_PRIVATE), false, '别处的同名文件不许被排除');
    /* 摆渡的**文件本身**照旧过河（那才是这个功能的全部意义） */
    assert.equal(isExcluded('_kirolex-local/ab12cd34/notes.md', MIRROR_PRIVATE), false);
  });

  test('快照也要排除它 —— rsync 不传、快照却算它一个文件，就等于每轮都"本地改过"', async () => {
    const { RemoteMirror, MIRROR_PRIVATE } = await import('../src/main/remoteMirror.ts');
    const m = new RemoteMirror({
      remote: { sshHost: 'h' } as any, localDir: '/l', remoteDir: '/r', sshCommand: 'ssh',
    });
    assert.ok(MIRROR_PRIVATE.every((p) => (m as any).excludes.includes(p)), '构造时就并进去');
  });

  test('账本内容没变就不写盘（mtime 每轮都动就够让同步判脏了）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
    const f = path.join(dir, 'a.txt');
    fs.writeFileSync(f, 'v1');
    const entries = [{ local: f, rel: '_kirolex-local/x/a.txt', hash: 'h', localHash: 'h' }];
    writeManifest(dir, entries);
    const before = fs.statSync(manifestPath(dir)).mtimeMs;
    /* 同样的内容再写一次：文件不该被动过 */
    writeManifest(dir, entries);
    assert.equal(fs.statSync(manifestPath(dir)).mtimeMs, before);
    /* 内容真变了当然要写 */
    writeManifest(dir, [...entries, { local: '/x/b.txt', rel: '_kirolex-local/y/b.txt', hash: 'h2', localHash: 'h2' }]);
    assert.equal(readManifest(dir).length, 2);
  });
});

/*
 * 「想办法让它打开本地的 chrome 我看看进度」—— 浏览器在用户那边，远端只能 curl。
 */
describe('远程会话要让人看页面：把 URL 说出来', () => {
  test('注入里说清"浏览器在用户机器上"，以及 localhost 那种情况', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({ hostLabel: 'tokyo-ec2', remoteDir: '/r/proj', localDir: '/l' });
    assert.match(b, /浏览器在\*\*他自己的机器\*\*上/);
    /* 怎么让用户看到：走标记通道（细节和边界在 tests/localAction.test.ts） */
    assert.match(b, /KIROLEX-LOCAL: open <http/);
    /* 只在远端 localhost 上监听的服务用户打不开 —— 这一条不说，它会给出一个点了没反应的链接 */
    assert.match(b, /localhost 上监听的服务他打不开/);
  });

  test('点链接开的是**本地**浏览器（这条路早就有，只是模型不知道）', () => {
    const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
    assert.match(CA, /window\.kiroApi\.openExternal\?\.\(href\)/);
  });
});
