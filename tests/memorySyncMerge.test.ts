import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideMemory, projectMemoryMarkKey, memorySyncStep, reconcileMemoryText, mergeMemoryText, mergeMemoryThreeWay, normalizeMemoryText,
  memoryHash, writeMemoryBase, readMemoryBase, MEMORY_BASE_DIR, SHARED_DIRS, planUpload,
} from '../src/main/s3Sync.ts';

/*
  **记忆：谁新用谁，本机第一次先拉** ——「记忆不必合并，只要自己的是最新的就可以上传。
  第一次同步的时候确保先拉而不是传空的就行」。
  实测撞过：Windows 新装，记忆是刚建的空壳（mtime = 现在），一同步就把桶里 22 KB 的 Dev 记忆盖成 23 字节。
  后来又撞过反方向的（见下面「合并」几条）：两边都有内容时整份拉会盖掉本机独有的 —— 那种情况改成合并。
*/
const M = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
const T0 = 1_700_000_000_000;

test('本机第一次同步：桶里有就拉 —— 哪怕本机的 mtime 更新（那正是空壳的样子）', () => {
  const shell = { size: 23, mtimeMs: T0 + 9_999_999 };      // 新装，刚建出来
  const real = { size: 22042, at: T0 };
  assert.equal(decideMemory(shell, real, undefined), 'pull');
  /* 桶里没有才传 */
  assert.equal(decideMemory(shell, undefined, undefined), 'upload');
});

test('只有本机动过 → 传；只有桶里动过 → 拉；都没动 → 不动', () => {
  const last = { size: 100, mtimeMs: T0, remoteAt: T0 + 5, remoteSize: 100 };
  assert.equal(decideMemory({ size: 120, mtimeMs: T0 + 60_000 }, { size: 100, at: T0 + 5 }, last), 'upload');
  assert.equal(decideMemory({ size: 100, mtimeMs: T0 }, { size: 130, at: T0 + 90_000 }, last), 'pull');
  assert.equal(decideMemory({ size: 100, mtimeMs: T0 }, { size: 100, at: T0 + 5 }, last), 'none');
});

test('两边都动过 → 时间新的那边赢', () => {
  const last = { size: 100, mtimeMs: T0, remoteAt: T0 + 5, remoteSize: 100 };
  assert.equal(decideMemory({ size: 110, mtimeMs: T0 + 200_000 }, { size: 130, at: T0 + 100_000 }, last), 'upload');
  assert.equal(decideMemory({ size: 110, mtimeMs: T0 + 100_000 }, { size: 130, at: T0 + 200_000 }, last), 'pull');
});

test('刚传完还没读到服务器时间时按大小判 —— 不拿本机时钟比服务器时钟', () => {
  /* remoteAt=0：上一轮刚传。桶里那份 LastModified 必然比本机 mtime 晚，按时间比会把自己刚传的当成别人改的 */
  const justUploaded = { size: 100, mtimeMs: T0, remoteAt: 0, remoteSize: 100 };
  assert.equal(decideMemory({ size: 100, mtimeMs: T0 }, { size: 100, at: T0 + 3_000 }, justUploaded), 'none');
  /* 大小变了才算别人改过 */
  assert.equal(decideMemory({ size: 100, mtimeMs: T0 }, { size: 140, at: T0 + 3_000 }, justUploaded), 'pull');
});

/*
  **两边都有内容且不一样 → 合并，不覆盖**。实测撞过：kyn-desktop 把 Dev 从不同步的项目里拿出来后第一轮，
  「本机第一次同步就拉」把本机 32855 B 的会话记忆盖成了桶里 11921 B 的那份 —— 两台各自记过东西，本机独有的全没了。
  后来又撞过：没有基准的两方合并把本机精简掉的 108 行当成「桶里独有」补了回来（9470 B → 53436 B）→ 改成对着基准三方合并。
*/
const base1 = '- 共有 B\n';
const withBase = (text: string, extra: object = {}) => ({ size: 100, mtimeMs: T0, remoteAt: T0 + 5, remoteSize: 100, baseHash: memoryHash(text), ...extra });

test('真实决策：只有一边动过走快速路径（桶里没变 → 直接传，本机没变 → 直接拉）；第一次 / 两边都动过才要内容', () => {
  const last = { size: 100, mtimeMs: T0, remoteAt: T0 + 5, remoteSize: 100 };
  const fetch = { kind: 'fetch' };
  /* 第一次同步（state 里没这条） */
  assert.deepEqual(memorySyncStep({ size: 32855, mtimeMs: T0 }, { size: 11921, at: T0 }, undefined), fetch);
  /* 非第一次：两边都动过 → 要内容；只有本机动过 → 传；只有桶里动过 → 拉 */
  assert.deepEqual(memorySyncStep({ size: 110, mtimeMs: T0 + 200_000 }, { size: 130, at: T0 + 100_000 }, last), fetch);
  assert.deepEqual(memorySyncStep({ size: 120, mtimeMs: T0 + 60_000 }, { size: 100, at: T0 + 5 }, last), { kind: 'upload' });
  assert.deepEqual(memorySyncStep({ size: 100, mtimeMs: T0 }, { size: 130, at: T0 + 90_000 }, last), { kind: 'pull' });
  /* 刚传完、还没读到服务器时间：桶里大小没变 = 没变 → 直接传 */
  assert.deepEqual(memorySyncStep({ size: 120, mtimeMs: T0 + 60_000 }, { size: 100, at: T0 + 3_000 }, { ...last, remoteAt: 0 }), { kind: 'upload' });
  /* 都没动 → 不用拿；只有一边有文件 → 直接拉 / 直接传 */
  assert.deepEqual(memorySyncStep({ size: 100, mtimeMs: T0 }, { size: 100, at: T0 + 5 }, last), { kind: 'none' });
  assert.deepEqual(memorySyncStep(undefined, { size: 11921, at: T0 }, undefined), { kind: 'pull' });
  assert.deepEqual(memorySyncStep(undefined, { size: 130, at: T0 + 90_000 }, last), { kind: 'pull' });
  assert.deepEqual(memorySyncStep({ size: 100, mtimeMs: T0 }, undefined, undefined), { kind: 'upload' });
  assert.deepEqual(memorySyncStep({ size: 120, mtimeMs: T0 + 60_000 }, undefined, last), { kind: 'upload' });
});

test('真实决策：一边是空的 → 缺的那边直接拿，不会把有内容的那边盖成空', () => {
  const last = { size: 100, mtimeMs: T0, remoteAt: T0 + 5, remoteSize: 100 };
  /* 已有 state：本机变成 0 字节、桶里没动 —— decideMemory 会说传，但不能把桶里的盖成空 → 拉 */
  assert.equal(decideMemory({ size: 0, mtimeMs: T0 + 60_000 }, { size: 100, at: T0 + 5 }, last), 'upload');
  assert.deepEqual(memorySyncStep({ size: 0, mtimeMs: T0 + 60_000 }, { size: 100, at: T0 + 5 }, last), { kind: 'pull' });
  /* 已有 state：桶里变成 0 字节、本机没动 —— decideMemory 会说拉，但不能把本机的盖成空 → 传 */
  assert.equal(decideMemory({ size: 100, mtimeMs: T0 }, { size: 0, at: T0 + 90_000 }, last), 'pull');
  assert.deepEqual(memorySyncStep({ size: 100, mtimeMs: T0 }, { size: 0, at: T0 + 90_000 }, last), { kind: 'upload' });
  /* 第一次同步：本机空 → 拉；桶里空 → 传；只有空白（不是 0 字节）的看内容 */
  assert.deepEqual(memorySyncStep({ size: 0, mtimeMs: T0 }, { size: 11921, at: T0 }, undefined), { kind: 'pull' });
  assert.deepEqual(memorySyncStep({ size: 100, mtimeMs: T0 }, { size: 0, at: T0 }, undefined), { kind: 'upload' });
  assert.deepEqual(memorySyncStep({ size: 2, mtimeMs: T0 + 9_999_999 }, { size: 22042, at: T0 }, undefined, { local: ' \n', remote: '- 真记忆\n' }), { kind: 'pull' });
  /* 桶里只有空白：传本机的（没有基准，盖之前桶里那份照旧留进 trash） */
  assert.deepEqual(memorySyncStep({ size: 100, mtimeMs: T0 }, { size: 3, at: T0 }, undefined, { local: '- 本机\n', remote: '\n \n' }), { kind: 'upload', keepRemote: true });
});

test('三方合并 ①：本机删行、桶里没变 → 结果不含被删的行', () => {
  const base = '- 留着 A\n- 过期 B\n- 留着 C\n';
  const local = '- 留着 A\n- 留着 C\n';
  const m = mergeMemoryThreeWay(local, base, base);
  assert.deepEqual(m, { text: local, added: 0, removed: 0 });
  assert.ok(!m.text.includes('过期 B'));
  /* 真实决策：桶里没变 → 直接传本机的，根本不合并 */
  assert.deepEqual(memorySyncStep({ size: 60, mtimeMs: T0 + 60_000 }, { size: 100, at: T0 + 5 }, withBase(base)), { kind: 'upload' });
  /* 就算两边时间都动了（走到合并），对着基准也不会把删掉的补回来 */
  assert.deepEqual(memorySyncStep({ size: 60, mtimeMs: T0 + 60_000 }, { size: 100, at: T0 + 90_000 }, withBase(base), { local, remote: base, base }), { kind: 'upload' });
});

test('三方合并 ②：本机删行 + 别处新增行 → 删的不回来，新增的补在后面', () => {
  const base = '- 留着 A\n- 过期 B\n';
  const local = '- 留着 A\n- 本机新加 L\n';
  const remote = '- 留着 A\n- 过期 B\n- 别处新加 R\n';
  assert.deepEqual(mergeMemoryThreeWay(local, remote, base), { text: '- 留着 A\n- 本机新加 L\n- 别处新加 R\n', added: 1, removed: 0 });
  assert.deepEqual(
    memorySyncStep({ size: 120, mtimeMs: T0 + 60_000 }, { size: 130, at: T0 + 90_000 }, withBase(base), { local, remote, base }),
    { kind: 'merge', text: '- 留着 A\n- 本机新加 L\n- 别处新加 R\n', added: 1, removed: 0, threeWay: true },
  );
});

test('三方合并 ③：别处删行、本机没动这行 → 本机也删；本机在基准之后新加的不受影响', () => {
  const base = '- 留着 A\n- 别处删 X\n- 留着 C\n';
  const local = '- 留着 A\n- 别处删 X\n- 留着 C\n- 本机新加 L\n';
  const remote = '- 留着 A\n- 留着 C\n';
  assert.deepEqual(mergeMemoryThreeWay(local, remote, base), { text: '- 留着 A\n- 留着 C\n- 本机新加 L\n', added: 0, removed: 1 });
  /* 本机完全没动 → 快速路径直接拉，效果一样是删掉 */
  assert.deepEqual(memorySyncStep({ size: 100, mtimeMs: T0 }, { size: 80, at: T0 + 90_000 }, withBase(base)), { kind: 'pull' });
  /* 两边都动过 → 合并，算出删了 1 行 */
  assert.deepEqual(
    memorySyncStep({ size: 120, mtimeMs: T0 + 60_000 }, { size: 80, at: T0 + 90_000 }, withBase(base), { local, remote, base }),
    { kind: 'merge', text: '- 留着 A\n- 留着 C\n- 本机新加 L\n', added: 0, removed: 1, threeWay: true },
  );
});

/*
  **没有基准时不取并集，谁新用谁整份取** —— 另一台电脑还没更新、本地留着 54 KB 旧版，一更新第一次同步没基准就取并集，
  把已经删掉的 108 行又传了上去。用户口径：「最后一次修改必须生效，删掉的不能再回来」。
*/
test('没有基准 ④a：本机更新（删过行）、桶里是旧的更长版本 → 结果 = 本机那份，删的行不回来（桶里那份留进 trash）', () => {
  const old = Array.from({ length: 184 }, (_, i) => `- 第 ${i + 1} 条记录`);
  const remote = `${old.join('\n')}\n`;
  const local = `${old.slice(0, 76).join('\n')}\n`;
  const localStat = { size: Buffer.byteLength(local), mtimeMs: T0 + 200_000 };
  const remoteStat = { size: Buffer.byteLength(remote), at: T0 + 100_000 };
  const up = { kind: 'upload', keepRemote: true };
  /* 第一次同步（没有 state） */
  assert.deepEqual(memorySyncStep(localStat, remoteStat, undefined), { kind: 'fetch' });
  assert.deepEqual(memorySyncStep(localStat, remoteStat, undefined, { local }), { kind: 'fetch' });
  assert.deepEqual(memorySyncStep(localStat, remoteStat, undefined, { local, remote }), up);
  /* 有 state 但没 baseHash（老代码同步过）、两边都动过 */
  const last = { size: 100, mtimeMs: T0, remoteAt: T0 + 5, remoteSize: 100 };
  assert.deepEqual(memorySyncStep(localStat, remoteStat, last, { local, remote }), up);
  /* 有基准文件但 hash 对不上 state 里记的 → 不信它，同样谁新用谁 */
  assert.deepEqual(memorySyncStep(localStat, remoteStat, withBase('- 别的\n'), { local, remote, base: '- 第 1 条记录\n' }), up);
});

test('没有基准：只剩标题也是内容 —— 照样谁新用谁，删掉的不回来，较新的清空版本也不被盖', () => {
  const header = '# Chat-specific memory\n\n';
  const full = '# Chat-specific memory\n\n- 旧记录 1\n- 旧记录 2\n';
  const up = { kind: 'upload', keepRemote: true };
  /* 本机删到只剩标题、比桶里新：传本机的（不能把旧记录拉回来） */
  const trimmed = { size: Buffer.byteLength(header), mtimeMs: T0 + 200_000 };
  const olderFull = { size: Buffer.byteLength(full), at: T0 + 100_000 };
  assert.deepEqual(memorySyncStep(trimmed, olderFull, undefined, { local: header, remote: full }), up);
  /* 本机同步过（有 state、没基准）也一样 */
  const last = { size: 100, mtimeMs: T0, remoteAt: T0 + 5, remoteSize: 100 };
  assert.deepEqual(memorySyncStep(trimmed, olderFull, last, { local: header, remote: full }), up);
  /* 反向：桶里是别处删到只剩标题、比本机新 → 拉（不能用本机较旧的整份盖回去） */
  const olderLocal = { size: Buffer.byteLength(full), mtimeMs: T0 + 100_000 };
  const newerHeader = { size: Buffer.byteLength(header), at: T0 + 200_000 };
  assert.deepEqual(memorySyncStep(olderLocal, newerHeader, undefined, { local: full, remote: header }), { kind: 'pull' });
  assert.deepEqual(memorySyncStep(olderLocal, newerHeader, last, { local: full, remote: header }), { kind: 'pull' });
});

test('没有基准：编辑器「写新文件再替换」保存精简结果（创建时间 = 修改时间）→ 仍是较新的那份生效', () => {
  const header = '# Chat-specific memory\n\n';
  const full = '# Chat-specific memory\n\n- 旧记录 1\n- 旧记录 2\n';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-memreplace-'));
  const abs = path.join(root, 'memory.md');
  fs.writeFileSync(abs, full);
  /* 编辑器的保存方式：写到临时文件再改名盖过去 —— 新文件的创建时间和修改时间几乎一样 */
  fs.writeFileSync(`${abs}.tmp`, header);
  fs.renameSync(`${abs}.tmp`, abs);
  const st = fs.statSync(abs);
  const local = { size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs } as { size: number; mtimeMs: number };
  const olderFull = { size: Buffer.byteLength(full), at: st.mtimeMs - 100_000 };
  assert.deepEqual(memorySyncStep(local, olderFull, undefined, { local: fs.readFileSync(abs, 'utf-8'), remote: full }), { kind: 'upload', keepRemote: true });
  /* 审查复现的纯函数形状：last 为空、只剩标题、mtimeMs = birthtimeMs = 200000，桶里旧完整版 at = 100000 */
  const exact = { size: Buffer.byteLength(header), mtimeMs: 200_000, birthtimeMs: 200_000 } as { size: number; mtimeMs: number };
  assert.deepEqual(memorySyncStep(exact, { size: Buffer.byteLength(full), at: 100_000 }, undefined, { local: header, remote: full }), { kind: 'upload', keepRemote: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('没有基准 ④b：桶里那份更新 → 结果 = 桶里那份（本机原来那份由拉取前的 trash 留底）', () => {
  const local = '- 本机 A\n- 共有 B\n- 本机 C\n';
  const remote = '- 共有 B\n- 桶里 D\n';
  const localStat = { size: Buffer.byteLength(local), mtimeMs: T0 + 100_000 };
  const remoteStat = { size: Buffer.byteLength(remote), at: T0 + 200_000 };
  assert.deepEqual(memorySyncStep(localStat, remoteStat, undefined, { local, remote }), { kind: 'pull' });
  assert.deepEqual(memorySyncStep(localStat, remoteStat, { size: 100, mtimeMs: T0, remoteAt: T0 + 5, remoteSize: 100 }, { local, remote }), { kind: 'pull' });
  /* 一模一样 → 只记状态 */
  assert.deepEqual(memorySyncStep(localStat, remoteStat, undefined, { local: '- a\n', remote: '- a\n' }), { kind: 'same' });
  /* 两方合并函数本身还在（恢复备份用），只是同步不再走它 */
  assert.equal(mergeMemoryText(local, remote), '- 本机 A\n- 共有 B\n- 本机 C\n- 桶里 D\n');
});

/*
  **只差空行 / 行尾空白 → same，不上传** —— 实测：s_1792550941538_1eubnn/memory.md 两台每 5 分钟各传一次
  （53962 B ↔ 53971 B，Compare-Object 只差空行），S3 版本一直在涨。
*/
test('只差空行 / 行尾空白 / 换行符 → same，不上传', () => {
  const a = '# Chat-specific memory\n\n- 第一条\n- 第二条\n';
  const b = '# Chat-specific memory\r\n\r\n\r\n- 第一条  \r\n\r\n- 第二条\t\r\n\r\n\r\n';
  assert.equal(normalizeMemoryText(a), normalizeMemoryText(b));
  assert.notEqual(normalizeMemoryText(a), normalizeMemoryText('# Chat-specific memory\n- 第一条\n'));
  const sa = { size: Buffer.byteLength(a), mtimeMs: T0 + 200_000 };
  const sb = { size: Buffer.byteLength(b), at: T0 + 100_000 };
  /* 没有基准、第一次同步 */
  assert.deepEqual(memorySyncStep(sa, sb, undefined, { local: a, remote: b }), { kind: 'same' });
  /* 有基准、两边都动过 */
  const last = withBase(a, { size: 10, remoteSize: 10 });
  assert.deepEqual(memorySyncStep(sa, { ...sb, at: T0 + 90_000 }, last, { local: a, remote: b, base: a }), { kind: 'same' });
  /* 桶里没变、本机只是对基准改了空白 → same（不用去桶里拿） */
  const synced = withBase(a, { size: Buffer.byteLength(a), mtimeMs: T0, remoteSize: Buffer.byteLength(a) });
  assert.deepEqual(memorySyncStep({ size: Buffer.byteLength(b), mtimeMs: T0 + 60_000 }, { size: Buffer.byteLength(a), at: T0 + 5 }, synced, { local: b, base: a }), { kind: 'same' });
  /* 本机没变、桶里只是改了空白 → 先拿桶里那份，比过是 same（不拉） */
  const remoteWs = { size: Buffer.byteLength(b), at: T0 + 90_000 };
  assert.deepEqual(memorySyncStep({ size: Buffer.byteLength(a), mtimeMs: T0 }, remoteWs, synced, { local: a, base: a }), { kind: 'fetch' });
  assert.deepEqual(memorySyncStep({ size: Buffer.byteLength(a), mtimeMs: T0 }, remoteWs, synced, { local: a, base: a, remote: b }), { kind: 'same' });
  /* 老状态（有 last、没有 baseHash）、桶里没变、本机只改了空白 → 先拿桶里那份，比过是 same（不传） */
  const old = '- A\n- B\n';
  const oldLast = { size: Buffer.byteLength(old), mtimeMs: T0, remoteAt: T0 + 5, remoteSize: Buffer.byteLength(old) };
  const wsLocal = { size: Buffer.byteLength('- A  \n\n- B\n'), mtimeMs: T0 + 60_000 };
  const unchangedRemote = { size: Buffer.byteLength(old), at: T0 + 5 };
  assert.deepEqual(memorySyncStep(wsLocal, unchangedRemote, oldLast, { local: '- A  \n\n- B\n' }), { kind: 'fetch' });
  assert.deepEqual(memorySyncStep(wsLocal, unchangedRemote, oldLast, { local: '- A  \n\n- B\n', remote: old }), { kind: 'same' });
  /* 基准文件 hash 对不上也算没有基准，同样核一次 */
  assert.deepEqual(memorySyncStep(wsLocal, unchangedRemote, { ...oldLast, baseHash: memoryHash('- 别的\n') }, { local: '- A  \n\n- B\n', base: '- A\n', remote: old }), { kind: 'same' });
  /* 真改了内容的照旧传，且上传前把桶里旧版留进 trash（keepRemote）：加行、删行都一样 */
  assert.deepEqual(memorySyncStep(wsLocal, unchangedRemote, oldLast, { local: '- A\n- B\n- C\n', remote: old }), { kind: 'upload', keepRemote: true });
  const deleted = { size: Buffer.byteLength('- A\n'), mtimeMs: T0 + 60_000 };
  assert.deepEqual(memorySyncStep(deleted, unchangedRemote, oldLast, { local: '- A\n' }), { kind: 'fetch' });
  assert.deepEqual(memorySyncStep(deleted, unchangedRemote, oldLast, { local: '- A\n', remote: old }), { kind: 'upload', keepRemote: true });
  /* 真改了内容的照旧传 / 拉 */
  assert.deepEqual(memorySyncStep({ size: 60, mtimeMs: T0 + 60_000 }, { size: Buffer.byteLength(a), at: T0 + 5 }, synced, { local: `${a}- 新的\n`, base: a }), { kind: 'upload' });
  assert.deepEqual(memorySyncStep({ size: Buffer.byteLength(a), mtimeMs: T0 }, remoteWs, synced, { local: a, base: a, remote: `${a}- 新的\n` }), { kind: 'pull' });
});

test('刚传完（remoteAt=0）别处把一行改成同样字节数：不能当「桶里没变」直接传 —— 先拿内容对着基准三方合并', () => {
  const base = '- A\n- B\n';
  const local = '- A\n- B\n- L\n';
  const remote = '- A\n- R\n';                                   // 和基准一样大
  assert.equal(Buffer.byteLength(remote), Buffer.byteLength(base));
  const size = Buffer.byteLength(base);
  const justUploaded = { size, mtimeMs: T0, remoteAt: 0, remoteSize: size, baseHash: memoryHash(base) };
  /* 本机也加了一行：先要内容，合并结果是 A、L、R */
  const localStat = { size: Buffer.byteLength(local), mtimeMs: T0 + 60_000 };
  const remoteStat = { size, at: T0 + 90_000 };
  assert.deepEqual(memorySyncStep(localStat, remoteStat, justUploaded), { kind: 'fetch' });
  assert.deepEqual(
    memorySyncStep(localStat, remoteStat, justUploaded, { local, remote, base }),
    { kind: 'merge', text: '- A\n- L\n- R\n', added: 1, removed: 1, threeWay: true },
  );
  /* 本机没动：也不能当「都没动」—— 拿内容，本机还是基准 → 拉别处改的那份 */
  const sameLocal = { size, mtimeMs: T0 };
  assert.deepEqual(memorySyncStep(sameLocal, remoteStat, justUploaded), { kind: 'fetch' });
  assert.deepEqual(memorySyncStep(sameLocal, remoteStat, justUploaded, { local: base, remote, base }), { kind: 'pull' });
  /* 桶里确实还是自己刚传的那份 → 本机动过就传，没动就只记状态（把服务器时间补上） */
  assert.deepEqual(memorySyncStep(localStat, remoteStat, justUploaded, { local, remote: base, base }), { kind: 'upload' });
  assert.deepEqual(memorySyncStep(sameLocal, remoteStat, justUploaded, { local: base, remote: base, base }), { kind: 'same' });
  /* 读到过服务器时间（remoteAt 有值）就按时间判，不用多拿一次 */
  assert.deepEqual(memorySyncStep(localStat, { size, at: T0 + 5 }, { ...justUploaded, remoteAt: T0 + 5 }), { kind: 'upload' });
  assert.deepEqual(memorySyncStep(sameLocal, { size, at: T0 + 5 }, { ...justUploaded, remoteAt: T0 + 5 }), { kind: 'none' });
});

test('合并：本机 3 条、桶里 2 条其中 1 条重复 → 4 条，本机原有的一条不少', () => {
  const local = '- 本机 A\n- 共有 B\n- 本机 C\n';
  const remote = '- 共有 B\n- 桶里 D\n';
  for (const base of [undefined, base1]) {
    const r = reconcileMemoryText(local, remote, base);
    assert.equal(r.use, 'merged');
    assert.equal(r.added, 1);
    assert.equal(r.text, '- 本机 A\n- 共有 B\n- 本机 C\n- 桶里 D\n');
    const lines = r.text.split('\n').filter(Boolean);
    assert.equal(lines.length, 4);
    for (const l of local.split('\n').filter(Boolean)) assert.ok(lines.includes(l), `本机的「${l}」不能少`);
  }
});

test('三方合并 ⑤：这次的形状 —— 本机精简成 76 行、桶里 184 行且前 76 行相同、基准 = 桶里那份 → 结果就是本机 76 行', () => {
  const all = Array.from({ length: 184 }, (_, i) => `- 第 ${i + 1} 条记录`);
  const remote = `${all.join('\n')}\n`;
  const local = `${all.slice(0, 76).join('\n')}\n`;
  assert.deepEqual(mergeMemoryThreeWay(local, remote, remote), { text: local, added: 0, removed: 0 });
  assert.deepEqual(reconcileMemoryText(local, remote, remote), { use: 'local', text: local, added: 0, removed: 0 });
  /* 真实决策：桶里自上次同步没变 → 直接传；两边时间都动了也只会传本机的 76 行 */
  const last = withBase(remote, { size: Buffer.byteLength(remote), remoteSize: Buffer.byteLength(remote) });
  assert.deepEqual(memorySyncStep({ size: Buffer.byteLength(local), mtimeMs: T0 + 60_000 }, { size: Buffer.byteLength(remote), at: T0 + 5 }, last), { kind: 'upload' });
  assert.deepEqual(memorySyncStep({ size: Buffer.byteLength(local), mtimeMs: T0 + 60_000 }, { size: Buffer.byteLength(remote), at: T0 + 90_000 }, last, { local, remote, base: remote }), { kind: 'upload' });
  /* 对照：没有基准的两方合并正是把 108 行补回来的那条路 */
  assert.equal(reconcileMemoryText(local, remote).added, 108);
});

test('基准：存进 s3-memory-base、hash 对得上；planUpload 不会把它传上去', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-membase-'));
  const rel = path.join('memory', 'sessions', 's_1', 'memory.md');
  fs.mkdirSync(path.join(root, 'memory', 'sessions', 's_1'), { recursive: true });
  fs.writeFileSync(path.join(root, rel), '- a\n');
  const h = writeMemoryBase(root, rel, Buffer.from('- a\n'));
  assert.equal(h, memoryHash('- a\n'));
  assert.equal(readMemoryBase(root, rel), '- a\n');
  assert.ok(fs.existsSync(path.join(root, MEMORY_BASE_DIR, rel)));
  assert.equal(readMemoryBase(root, path.join('memory', 'global.md')), undefined);
  assert.ok(!SHARED_DIRS.includes(MEMORY_BASE_DIR));
  for (const memory of [undefined, { projects: [] }]) {
    const up = planUpload(root, ['s_1'], {}, memory).upload;
    assert.ok(up.includes(rel));
    assert.ok(!up.some((r) => r.startsWith(MEMORY_BASE_DIR)), `基准不能进上传列表：${up}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('接线：同步成功（拉 / 传 / 一样）后写基准；合并带上基准；日志写增删行数；读不到桶里列表就一份记忆都不传', () => {
  assert.match(M, /let step = memorySyncStep\(local, remote, state\[rel\]\);/);
  /* 先给本机这份和基准，要桶里那份时再去拿 */
  assert.match(M, /const texts = \{ local: fs\.readFileSync\(abs, 'utf-8'\), base: readMemoryBase\(KIROLEX_HOME, rel\) \};\s*step = memorySyncStep\(local, remote, state\[rel\], texts\);/);
  assert.match(M, /step = memorySyncStep\(local, remote, state\[rel\], \{ \.\.\.texts, remote: buf\.toString\('utf-8'\) \}\);/);
  /* 没有基准、本机那份整份盖掉桶里的：盖之前把桶里那份留进 trash/memory-pull-*；留不进就不传 */
  assert.match(M, /if \(step\.keepRemote && buf\) \{[\s\S]{0,200}`memory-pull-\$\{Date\.now\(\)\}`, `\$\{rel\}\.bucket`\)[\s\S]{0,500}这一轮不传[\s\S]{0,80}continue;/);
  assert.match(M, /合并：本机 \$\{local!?\.size\} B，补进 \$\{step\.added\} 行、按别处删除去掉 \$\{step\.removed\} 行 → \$\{Buffer\.byteLength\(step\.text\)\} B/);
  /* 拉成功 */
  assert.match(M, /const st = replaceLocalMemory\(buf\);\s*const baseHash = writeMemoryBase\(KIROLEX_HOME, rel, buf\);[^\n]*\n\s*state\[rel\] = \{[^}]*baseHash \};/);
  /* 一样（含只差空白）：只记状态，不进上传列表 */
  assert.match(M, /if \(step\.kind === 'same'\) \{[^]*?const baseHash = buf \? writeMemoryBase\(KIROLEX_HOME, rel, buf\) : state\[rel\]\?\.baseHash;\s*state\[rel\] = \{[^}]*baseHash \};\s*continue;/);
  assert.doesNotMatch(M.slice(M.indexOf("if (step.kind === 'same') {"), M.indexOf("if (step.kind === 'same') {") + 600), /memUpload\.add/);
  /* 上传成功（合并结果也走这里） */
  assert.match(M, /await putObject\(creds!, key, body, contentTypeFor\(rel\)\);\s*state\[rel\] = isMemoryRel\(rel\)[\s\S]{0,200}baseHash: writeMemoryBase\(KIROLEX_HOME, rel, body\)/);
  assert.match(M, /if \(memListed\) \{/);
  assert.match(M, /\.\.\.plan\.upload\.filter\(\(r\) => !isMemoryRel\(r\)\),\s*\.\.\.memUpload,/);
  /* 拉 / 合并写回之前把被换掉的那份挪进 trash（两条路走同一个写回函数） */
  assert.match(M, /memory-pull-\$\{Date\.now\(\)\}/);
  assert.match(M, /const replaceLocalMemory = /);
});

test('项目记忆的 mark 键不会和会话 id 撞；两页都显示记忆状态', () => {
  assert.equal(projectMemoryMarkKey('Dev'), 'memory:projects/Dev');
  const UI = fs.readFileSync(new URL('../src/renderer/components/BackupDialog.tsx', import.meta.url), 'utf8');
  assert.match(UI, /\{t\('Memory \{size\}', \{ size: memSize\(p\.memory\.bytes\) \}\)\}/);
  assert.match(UI, /bucketMemory\[proj\]/);
});
