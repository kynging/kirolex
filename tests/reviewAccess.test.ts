/**
 * 侧栏 review 写回的那道闸 + 远端文件写回 ——「远程会话里对远端文件提 comment 写不回去（not previewed by session）」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ReviewedPaths, remoteReviewKey, pickReviewTarget, writeTextVia } from '../src/main/reviewAccess.ts';
import { remoteWriteScript } from '../src/main/kiroConfig.ts';
import { patchWritten } from '../src/main/reviseBlock.ts';

type T = { sshHost: string };
const TOKYO: T = { sshHost: 'ec2-user@tokyo-graviton' };
const REMOTE = '/home/ec2-user/kirolex-mirror/scratch/files-1/a.md';

/** 和主进程同一个接法：本机解析 → 本机有没有 → 远端那台机器上的路径（只有远程会话有）。 */
function gate(reviewed: ReviewedPaths, sessionId: string, opts: { local?: Set<string>; remote?: T | null } = {}) {
  return (raw: string) => pickReviewTarget<T>({
    raw,
    resolveLocal: (p) => p,
    localExists: (p) => !!opts.local?.has(p),
    remoteFor: (p) => (opts.remote && p.startsWith('/') ? { target: opts.remote, path: p } : null),
    reviewed: (key) => reviewed.has(sessionId, key),
  });
}

describe('白名单：按会话记，远端路径带上机器', () => {
  test('远端读过（按「会话 + 机器 + 路径」登记）→ 能写，目标是那台机器上的同一个路径', () => {
    const r = new ReviewedPaths();
    r.mark('s_a', remoteReviewKey(TOKYO.sshHost, REMOTE));
    const t = gate(r, 's_a', { remote: TOKYO })(REMOTE);
    assert.equal(t.ok, true);
    assert.equal((t as any).want, REMOTE);
    assert.deepEqual((t as any).remote, TOKYO);
  });

  test('别的会话不能借道：s_a 读过，s_b 写同一个远端文件被拒', () => {
    const r = new ReviewedPaths();
    r.mark('s_a', remoteReviewKey(TOKYO.sshHost, REMOTE));
    const t = gate(r, 's_b', { remote: TOKYO })(REMOTE);
    assert.equal(t.ok, false);
    assert.equal((t as any).notPreviewed, true);
  });

  test('换了一台机器也不认：同一个路径在别的机器上读过不算', () => {
    const r = new ReviewedPaths();
    r.mark('s_a', remoteReviewKey('other-host', REMOTE));
    assert.equal(gate(r, 's_a', { remote: TOKYO })(REMOTE).ok, false);
  });

  test('本机路径照旧：读过的本地文件能写，没读过的不写', () => {
    const r = new ReviewedPaths();
    r.mark('s_a', '/tmp/x.md');
    const g = gate(r, 's_a', { local: new Set(['/tmp/x.md', '/tmp/y.md']) });
    const ok = g('/tmp/x.md');
    assert.equal(ok.ok, true);
    assert.equal((ok as any).remote, undefined);
    assert.equal(g('/tmp/y.md').ok, false);
  });

  test('本机有这个路径时不改走远端（和读的时候同一个顺序）—— 远端读过也不算本机这份读过', () => {
    const r = new ReviewedPaths();
    r.mark('s_a', remoteReviewKey(TOKYO.sshHost, REMOTE));
    const t = gate(r, 's_a', { local: new Set([REMOTE]), remote: TOKYO })(REMOTE);
    assert.equal(t.ok, false);
  });

  test('重启之后白名单是空的：恢复的标签页重新读一次（再登记）就能写', () => {
    /* 重启 = 一个新的 ReviewedPaths；恢复出来的标签页没经过 workspace:read 之前一律拒 */
    const before = new ReviewedPaths();
    assert.equal(gate(before, 's_a', { remote: TOKYO })(REMOTE).ok, false);
    /* 第一次提交前重新读一次 → workspace:read 按同一个键登记 */
    before.mark('s_a', remoteReviewKey(TOKYO.sshHost, REMOTE));
    assert.equal(gate(before, 's_a', { remote: TOKYO })(REMOTE).ok, true);
  });

  test('没有路径 / 解析抛错 → 不写', () => {
    const r = new ReviewedPaths();
    assert.equal(gate(r, 's_a')('').ok, false);
    const t = pickReviewTarget<T>({
      raw: 'x', resolveLocal: () => { throw new Error('坏路径'); }, localExists: () => false,
      remoteFor: () => null, reviewed: () => true,
    });
    assert.deepEqual(t, { ok: false, error: '坏路径' });
  });
});

describe('writeTextVia：远端写回（读 → 比 → 备份 → 写）', () => {
  const io = (initial: string | null, opts: { backupOk?: boolean; writeFails?: Error } = {}) => {
    const state = { disk: initial, backups: [] as string[], writes: [] as string[] };
    return {
      state,
      io: {
        max: 1024,
        read: async (): Promise<{ size: number; bytes: number; text: string } | null> => (state.disk === null ? null
          : { size: Buffer.byteLength(state.disk), bytes: Buffer.byteLength(state.disk), text: state.disk }),
        backup: async (prev: string) => { if (opts.backupOk === false) return false; state.backups.push(prev); return true; },
        write: async (text: string) => { if (opts.writeFails) throw opts.writeFails; state.disk = text; state.writes.push(text); },
      },
    };
  };

  test('正常：先备份原文，再写新正文', async () => {
    const { state, io: x } = io('旧的');
    const r = await writeTextVia(x, '新的', '旧的');
    assert.equal(r.ok, true);
    assert.deepEqual(state.backups, ['旧的']);
    assert.equal(state.disk, '新的');
  });

  test('备份不成就不写', async () => {
    const { state, io: x } = io('旧的', { backupOk: false });
    const r = await writeTextVia(x, '新的');
    assert.equal(r.ok, false);
    assert.match(String(r.error), /备份失败/);
    assert.equal(state.disk, '旧的');
    assert.equal(state.writes.length, 0);
  });

  test('盘上不是 expectBase → mismatch，不写', async () => {
    const { state, io: x } = io('别人改过的');
    const r = await writeTextVia(x, '新的', '旧的');
    assert.equal(r.mismatch, true);
    assert.equal(state.writes.length, 0);
  });

  test('读不到不新建；比上限大不写；内容一样不写；空内容不写', async () => {
    assert.match(String((await writeTextVia(io(null).io, '新的')).error), /读不到/);
    const big = io('x'.repeat(2048));
    assert.match(String((await writeTextVia(big.io, '新的')).error), /上限/);
    assert.equal(big.state.writes.length, 0);
    const same = io('一样');
    assert.equal((await writeTextVia(same.io, '一样')).unchanged, true);
    assert.equal(same.state.writes.length, 0);
    assert.equal((await writeTextVia(io('a').io, '  ')).ok, false);
  });

  test('声明的大小比实际读回的字节多（ssh 中途断了）→ 绝不备份、绝不写', async () => {
    const { state, io: x } = io('旧的');
    /* 远端说文件有 100 字节，只读回来前几个 —— 不带 expectBase 的路径（直接改、删除）也必须拦住 */
    x.read = async () => ({ size: 100, bytes: Buffer.byteLength('旧的'), text: '旧的' });
    const r = await writeTextVia(x, '新的');
    assert.equal(r.ok, false);
    assert.match(String(r.error), /不完整/);
    assert.equal(state.backups.length, 0);
    assert.equal(state.writes.length, 0);
    assert.equal(state.disk, '旧的');
  });

  test('写的那一步失败（远端连不上）→ ok:false，原因原样交回', async () => {
    const { io: x } = io('旧的', { writeFails: new Error('ssh: connect to host tokyo-graviton port 22: timed out') });
    const r = await writeTextVia(x, '新的');
    assert.equal(r.ok, false);
    assert.match(String(r.error), /timed out/);
  });
});

describe('ssh 写回同一个路径；patch 档异步写之后按同一套判据收', () => {
  const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
  test('remoteWriteScript：绝对路径原样用，相对路径照旧拼 $HOME', () => {
    const abs = remoteWriteScript(REMOTE, q);
    assert.match(abs, /^f='\/home\/ec2-user\/kirolex-mirror\/scratch\/files-1\/a\.md' && /);
    assert.doesNotMatch(abs, /\$HOME/);
    assert.match(abs, /base64 -d > "\$t" && mv -f "\$t" "\$f"/);
    assert.match(remoteWriteScript('.kiro/x.md', q), /^f="\$HOME"\/'\.kiro\/x\.md'/);
  });
  test('patchWritten：写成 → written + path；mismatch → conflict；别的失败原样交回', () => {
    const done = { ok: true as const, text: 'b', fullText: 'b', scope: 'patch' as const, changes: [] };
    assert.deepEqual(patchWritten(done, { ok: true, path: REMOTE }), { ...done, written: true, path: REMOTE });
    assert.equal((patchWritten(done, { ok: false, mismatch: true }) as any).conflict, true);
    assert.match((patchWritten(done, { ok: false, error: '连不上 tokyo' }) as any).error, /连不上 tokyo/);
  });
});

describe('主进程 / 界面接线', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const RV = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ReviewPane.tsx'), 'utf8');

  test('workspace:read 读远端成功之后按「会话 + 机器 + 路径」登记', () => {
    const read = M.slice(M.indexOf("ipcMain.handle('workspace:read'"));
    assert.match(read.slice(0, 1500), /const out = await readRemoteFile\(remote\.target, remote\.path\);\s*\n\s*markReviewed\(sessionId, remoteReviewKey\(remote\.target\.sshHost, remote\.path\)\);/);
  });

  test('ssh 读回来的字节数对不上声明的大小 → 当读失败（预览 / 备份 / 写回都不拿残缺正文）', () => {
    const at = M.indexOf('async function remoteFileBytes(');
    const body = M.slice(at, at + 1500);
    assert.match(body, /if \(buffer\.length !== Math\.min\(size, max\)\) \{/);
    assert.match(body, /throw new Error\(/);
  });

  test('远端文件经 ssh 写回同一个路径，写前备份到本机', () => {
    const at = M.indexOf('const writeRemoteReviewFile = ');
    assert.ok(at > 0);
    const body = M.slice(at, at + 1800);
    assert.match(body, /remoteWriteScript\(want, shellQuote\)/);
    assert.match(body, /saveReviewBackup\(want, prev\)/);
    assert.match(body, /writeTextVia\(/);
    /* review:write-file / 改写那条路 / backup-file 都认远端 */
    assert.match(M, /if \(t\.remote\) return writeRemoteReviewFile\(sessionId, t\.remote, t\.want, text, expectBase\);/);
    const backup = M.slice(M.indexOf("ipcMain.handle('review:backup-file'"));
    assert.match(backup.slice(0, 1500), /if \(t\.remote\)/);
  });

  test('deck 那几条写盘不碰远端文件', () => {
    const at = M.indexOf('const deckTarget = ');
    assert.match(M.slice(at, at + 600), /if \(t\.remote\) return \{ ok: false/);
  });

  test('改写之前先看闸 —— 不让模型白改一遍、最后写不回去', () => {
    const at = M.indexOf("ipcMain.handle('review:revise-in-session'");
    const body = M.slice(at, at + 6500);
    assert.ok(body.indexOf('const gate = input?.apply') > 0);
    assert.ok(body.indexOf('const gate = input?.apply') < body.indexOf('const reply = await askOnce('));
  });

  test('界面：第一次提交前重新读一次（经 workspaceRead 登记），读不到就把原因摆出来', () => {
    assert.match(RV, /const registerOnce = /);
    assert.match(RV, /window\.kiroApi\.workspaceRead\(sessionId, path\)/);
    assert.match(RV, /const why = isDeck \? null : await registerOnce\(sessionId, path, lang\);/);
    assert.match(RV, /setWriteWarn\(/);
  });
});
