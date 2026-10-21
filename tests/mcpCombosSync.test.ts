import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planComboSync, mergeComboTexts, comboHash, readComboMark, writeComboMark, syncComboFile, MCP_COMBOS_REL, type ComboSyncIo, type ComboSyncMark } from '../src/main/mcpCombosSync.ts';
import { parseMcpCombos } from '../src/main/mcpCombos.ts';

/**
 * `mcp-combos.json` 跟着 S3 同步 —— 多台电脑共用同一份组合（台式机上存的「投研」，笔记本上也要有）。
 * 守的是：本机第一次同步不拿本机的去盖桶里的；两边都改过时合并、**同一个 id 两边内容不同时两份都留**，不静默覆盖。
 */
const research = { id: 'research', name: '投研', effort: 'high', mcpServers: { mx: { url: 'https://mx.example.com/mcp' } } };
const coding = { id: 'coding', name: '写代码', mcpServers: {} };
const text = (xs: unknown[]) => JSON.stringify(xs, null, 2);
const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');

describe('谁传谁拉（按内容摘要判断谁变过）', () => {
  const A = text([research]);
  const B = text([coding]);
  const mark = (local: string, remote: string) => ({ localHash: comboHash(local), remoteHash: comboHash(remote) });

  test('本机第一次同步：两边都有 → 合并（不拿本机的盖桶里的，也不拿桶里的盖本机的）', () => {
    const r = planComboSync(B, A, undefined);
    assert.equal(r.action, 'merge');
    assert.ok(r.writeLocal && r.upload);
    const p = parseMcpCombos(r.upload!);
    assert.ok(p.ok && p.combos.map((c) => c.id).join() === 'default,coding,research');
  });
  test('本机第一次同步：只有桶里有 → 拉；只有本机有 → 传；都没有 → 不动', () => {
    assert.deepEqual([planComboSync(undefined, A, undefined).action, planComboSync(undefined, A, undefined).writeLocal], ['pull', A]);
    assert.deepEqual([planComboSync(A, undefined, undefined).action, planComboSync(A, undefined, undefined).upload], ['upload', A]);
    assert.equal(planComboSync(undefined, undefined, undefined).action, 'none');
  });
  test('只有本机改过 → 传；只有桶里改过 → 拉；都没动 → 不动', () => {
    assert.equal(planComboSync(B, A, mark(A, A)).action, 'upload');
    assert.equal(planComboSync(A, B, mark(A, A)).action, 'pull');
    assert.equal(planComboSync(A, A, mark(A, A)).action, 'none');
  });
  test('两边都改过 → 合并（不是谁新用谁）', () => {
    const base = text([{ id: 'x', name: 'X', mcpServers: {} }]);
    assert.equal(planComboSync(B, A, mark(base, base)).action, 'merge');
  });

  /* 审查意见 1：按大小判断会把「大小相同、内容不同」当成没变 */
  test('另一台电脑传了一份**大小相同、内容不同**的：本机没改 → 拉；本机也改了 → 合并，不覆盖对方', () => {
    const mine = text([{ ...research, effort: 'high' }]);
    const theirs = text([{ ...research, effort: 'lowx' }]);
    assert.equal(Buffer.byteLength(mine), Buffer.byteLength(theirs));
    assert.notEqual(mine, theirs);
    const pulled = planComboSync(mine, theirs, mark(mine, mine));
    assert.equal(pulled.action, 'pull');
    assert.equal(pulled.writeLocal, theirs);
    const edited = text([{ ...research, effort: 'high' }, coding]);
    const merged = planComboSync(edited, theirs, mark(mine, mine));
    assert.equal(merged.action, 'merge');
    assert.equal(merged.conflicts.length, 1);
    const p = parseMcpCombos(merged.upload!);
    assert.ok(p.ok);
    if (p.ok) assert.ok(p.combos.some((c) => c.effort === 'lowx'), '对方那份必须还在');
  });

  /* 审查意见 2：本机文件被改坏时不能传上去盖掉桶里好的 */
  test('本机文件坏了（坏 JSON / 校验不过）→ 不传，桶里那份不动，说出原因', () => {
    for (const bad of ['[{"id":"research",', '[{"id":"a","name":"A"},{"id":"a","name":"B"}]']) {
      const r = planComboSync(bad, A, mark(A, A));
      assert.equal(r.action, 'skip');
      assert.equal(r.upload, undefined);
      assert.equal(r.writeLocal, undefined);
      assert.match(r.error || '', /本机/);
      const first = planComboSync(bad, undefined, undefined);
      assert.equal(first.action, 'skip');
      assert.equal(first.upload, undefined);
    }
  });
  test('桶里那份坏了 → 不拉，本机那份不动', () => {
    const r = planComboSync(A, '[{"id":"x"}]', mark(A, A));
    assert.equal(r.action, 'skip');
    assert.equal(r.writeLocal, undefined);
    assert.match(r.error || '', /桶/);
  });

  test('摘要记录读写（临时目录）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-combo-mark-'));
    try {
      const f = path.join(dir, 's3-combos-sync.json');
      assert.equal(readComboMark(f), undefined);
      writeComboMark(f, mark(A, B));
      assert.deepEqual(readComboMark(f), mark(A, B));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('合并两份组合文件', () => {
  test('两边各有不同的组合 → 并集，本机的在前', () => {
    const r = mergeComboTexts(text([coding]), text([research]));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.added, ['research']);
    assert.deepEqual(r.conflicts, []);
    const p = parseMcpCombos(r.text);
    assert.ok(p.ok);
    if (p.ok) assert.deepEqual(p.combos.map((c) => c.id), ['default', 'coding', 'research']);
  });

  test('桶里的是本机的子集 → 本机文件原样不动', () => {
    const local = text([coding, research]);
    const r = mergeComboTexts(local, text([research]));
    assert.ok(r.ok);
    if (r.ok) { assert.equal(r.text, local); assert.deepEqual(r.added, []); assert.deepEqual(r.conflicts, []); }
  });

  test('字段顺序不同但内容一样 → 不算冲突', () => {
    const r = mergeComboTexts(text([research]), JSON.stringify([{ mcpServers: research.mcpServers, effort: 'high', name: '投研', id: 'research' }]));
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.conflicts, []);
  });

  test('同一个 id 两边内容不同 → 本机的留在原 id，桶里那份改个 id / 名字也留下，并报出冲突', () => {
    const other = { ...research, effort: 'low' };
    const r = mergeComboTexts(text([research]), text([other]));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].id, 'research');
    const p = parseMcpCombos(r.text);
    assert.ok(p.ok);
    if (!p.ok) return;
    assert.equal(p.combos.length, 3);
    assert.equal(p.combos[1].id, 'research');
    assert.equal(p.combos[1].effort, 'high');
    const kept = p.combos[2];
    assert.equal(kept.id, r.conflicts[0].keptAs);
    assert.notEqual(kept.id, 'research');
    assert.equal(kept.effort, 'low');
    assert.match(kept.name, /投研/);
    assert.notEqual(kept.name, '投研');
  });

  test('不同 id 但名字撞了 → 桶里那份改名留下（否则下拉分不清，文件也存不过校验）', () => {
    const r = mergeComboTexts(text([research]), text([{ id: 'touyan', name: '投研', mcpServers: {} }]));
    assert.ok(r.ok);
    if (!r.ok) return;
    const p = parseMcpCombos(r.text);
    assert.ok(p.ok);
    if (p.ok) {
      assert.deepEqual(p.combos.map((c) => c.id), ['default', 'research', 'touyan']);
      assert.notEqual(p.combos[2].name, '投研');
    }
  });

  /* 审查意见 3：同 id 只是名字不同（其他字段一样）不是"以前合并出来的副本"，是真冲突 */
  test('同一个 id、只有名字不同 → 两份都留并记冲突，不当成已合并过的副本', () => {
    const local = { id: 'research', name: 'Research new', mcpServers: {} };
    const remote = { id: 'research', name: 'Research', mcpServers: {} };
    const r = mergeComboTexts(text([local]), text([remote]));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.conflicts.length, 1);
    const p = parseMcpCombos(r.text);
    assert.ok(p.ok);
    if (p.ok) {
      assert.deepEqual(p.combos.map((c) => c.id), ['default', 'research', 'research-2']);
      assert.deepEqual(p.combos.map((c) => c.name), ['通用', 'Research new', 'Research（另一台电脑的版本）']);
    }
  });

  /* 审查意见（第 3 轮）2：副本起名和认副本必须是同一条规则，否则每合并一次多一条 research-3、research-4… */
  test('同一个 id、只有名字不同：和同一份桶里的文件再合并一次，结果不变', () => {
    const remote = text([{ id: 'research', name: 'Research', mcpServers: {} }]);
    const once = mergeComboTexts(text([{ id: 'research', name: 'Research new', mcpServers: {} }]), remote);
    assert.ok(once.ok);
    if (!once.ok) return;
    const twice = mergeComboTexts(once.text, remote);
    assert.ok(twice.ok);
    if (twice.ok) { assert.equal(twice.text, once.text); assert.deepEqual(twice.added, []); assert.deepEqual(twice.conflicts, []); }
  });

  test('名字撞了那种：合并结果再和原来的桶里那份合一次，不会多出一条', () => {
    const remote = text([{ id: 'touyan', name: '投研', mcpServers: {} }]);
    const once = mergeComboTexts(text([research]), remote);
    assert.ok(once.ok);
    if (!once.ok) return;
    const twice = mergeComboTexts(once.text, remote);
    assert.ok(twice.ok);
    if (twice.ok) { assert.equal(twice.text, once.text); assert.deepEqual(twice.added, []); }
  });

  test('同 id 冲突：合并结果再和原来的桶里那份合一次，不会多出一条', () => {
    const remote = text([{ ...research, effort: 'low' }]);
    const once = mergeComboTexts(text([research]), remote);
    assert.ok(once.ok);
    if (!once.ok) return;
    const twice = mergeComboTexts(once.text, remote);
    assert.ok(twice.ok);
    if (twice.ok) { assert.equal(twice.text, once.text); assert.deepEqual(twice.conflicts, []); }
  });

  test('合并两次结果不变（第二次同步不会越滚越多）', () => {
    const other = { ...research, effort: 'low' };
    const once = mergeComboTexts(text([research]), text([other]));
    assert.ok(once.ok);
    if (!once.ok) return;
    const twice = mergeComboTexts(once.text, once.text);
    assert.ok(twice.ok);
    if (twice.ok) { assert.equal(twice.text, once.text); assert.deepEqual(twice.conflicts, []); }
  });

  test('任一边文件坏了 → 不合并（两边都不动），说出是哪一边', () => {
    const a = mergeComboTexts('not json', text([research]));
    assert.equal(a.ok, false);
    if (!a.ok) assert.match(a.error, /本机/);
    const b = mergeComboTexts(text([research]), '[{"id":"x"}]');
    assert.equal(b.ok, false);
    if (!b.ok) assert.match(b.error, /桶/);
  });
});

/**
 * 内存里的假桶：ETag 按内容算，条件写入的语义和 S3 一样（If-Match 对不上 / If-None-Match 但已存在 → 冲突）。
 * `beforePut` 模拟「下载之后、上传之前另一台电脑抢先传了」。
 */
function fakeWorld(init: { local?: string; remote?: string; mark?: ComboSyncMark }) {
  const w = { local: init.local, remote: init.remote, mark: init.mark, puts: 0, conflicts: 0, beforePut: [] as Array<() => void> };
  const etag = (t: string) => `"${comboHash(t).slice(0, 16)}"`;
  const io: ComboSyncIo = {
    get: async () => (w.remote === undefined ? null : { text: w.remote, etag: etag(w.remote) }),
    put: async (t, cond) => {
      const hook = w.beforePut.shift();
      if (hook) hook();
      const ok = 'ifMatch' in cond ? w.remote !== undefined && etag(w.remote) === cond.ifMatch : w.remote === undefined;
      if (!ok) { w.conflicts += 1; return 'conflict'; }
      w.remote = t; w.puts += 1; return 'ok';
    },
    readLocal: () => w.local,
    writeLocal: (t) => { w.local = t; },
    readMark: () => w.mark,
    writeMark: (m) => { w.mark = m; },
  };
  return { w, io };
}
const ids = (t: string | undefined) => { const p = parseMcpCombos(t || ''); return p.ok ? p.combos.map((c) => c.id) : ['<bad>']; };

/** 两台电脑共用一个桶：各自有自己的本机文件和同步摘要 */
function twoComputers(a: string, b: string, bucket?: string) {
  const bucketBox = { text: bucket };
  const etag = (t: string) => `"${comboHash(t).slice(0, 16)}"`;
  const machine = (local: string) => {
    const m = { local: local as string | undefined, mark: undefined as ComboSyncMark | undefined };
    const io: ComboSyncIo = {
      get: async () => (bucketBox.text === undefined ? null : { text: bucketBox.text, etag: etag(bucketBox.text) }),
      put: async (t, cond) => {
        const ok = 'ifMatch' in cond ? bucketBox.text !== undefined && etag(bucketBox.text) === cond.ifMatch : bucketBox.text === undefined;
        if (!ok) return 'conflict';
        bucketBox.text = t; return 'ok';
      },
      readLocal: () => m.local,
      writeLocal: (t) => { m.local = t; },
      readMark: () => m.mark,
      writeMark: (x) => { m.mark = x; },
    };
    return { m, io };
  };
  return { bucketBox, A: machine(a), B: machine(b) };
}
const effortsById = (t: string | undefined) => {
  const p = parseMcpCombos(t || '');
  return p.ok ? p.combos.filter((c) => c.id !== 'default').map((c) => `${c.id}:${c.effort}`) : ['<bad>'];
};

describe('两台电脑交替同步（审查意见：副本要双向认得出来）', () => {
  test('A 有 research/high、B 和桶里有 research/low、两台都没同步过：交替同步几轮后两台都正好两条，内容是 high 和 low', async () => {
    const w = twoComputers(text([{ ...research, effort: 'high' }]), text([{ ...research, effort: 'low' }]), text([{ ...research, effort: 'low' }]));
    for (let round = 0; round < 3; round += 1) {
      await syncComboFile(w.A.io);
      await syncComboFile(w.B.io);
    }
    for (const who of [w.A.m.local, w.B.m.local, w.bucketBox.text]) {
      const xs = effortsById(who);
      assert.equal(xs.length, 2, `只该有两条：${xs.join(', ')}`);
      assert.deepEqual(xs.map((x) => x.split(':')[1]).sort(), ['high', 'low']);
      const p = parseMcpCombos(who || '');
      assert.ok(p.ok);
      if (p.ok) assert.ok(!p.combos.some((c) => /另一台电脑的版本.*另一台电脑的版本/.test(c.name)), '名字不该叠两层「另一台电脑的版本」');
    }
    assert.equal(w.A.m.local, w.B.m.local);
    assert.equal(w.A.m.local, w.bucketBox.text);
  });

  /* 审查意见：副本 id 截到前 60 个字符生成，识别也必须按同样的前缀比（61–64 字符的合法 id 以前认不出来） */
  for (const len of [61, 64]) {
    test(`长 id（${len} 个字符）：交替同步三轮后两台都正好两条，名字不叠两层`, async () => {
      const longId = 'r'.repeat(len);
      const hi = { ...research, id: longId, effort: 'high' };
      const lo = { ...research, id: longId, effort: 'low' };
      const w = twoComputers(text([hi]), text([lo]), text([lo]));
      for (let round = 0; round < 3; round += 1) {
        await syncComboFile(w.A.io);
        await syncComboFile(w.B.io);
      }
      for (const who of [w.A.m.local, w.B.m.local, w.bucketBox.text]) {
        const p = parseMcpCombos(who || '');
        assert.ok(p.ok);
        if (!p.ok) continue;
        const mine = p.combos.filter((c) => c.id !== 'default');
        assert.equal(mine.length, 2, `只该有两条：${mine.map((c) => `${c.id}:${c.effort}`).join(', ')}`);
        assert.deepEqual(mine.map((c) => c.effort).sort(), ['high', 'low']);
        assert.ok(mine.every((c) => c.id.length <= 64));
        assert.ok(!mine.some((c) => /另一台电脑的版本.*另一台电脑的版本/.test(c.name)), '名字不该叠两层「另一台电脑的版本」');
      }
      assert.equal(w.A.m.local, w.B.m.local);
      assert.equal(w.A.m.local, w.bucketBox.text);
    });
  }

  test('桶里的副本正是本机原条目转了一圈回来：不再加；原 id 名字不同的真冲突照样两份都留', () => {
    const mine = { ...research, effort: 'low' };
    const back = { ...research, id: 'research-2', name: '投研（另一台电脑的版本）', effort: 'low' };
    const r = mergeComboTexts(text([mine]), text([{ ...research, effort: 'high' }, back]));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(effortsById(r.text), ['research:low', 'research-2:high']);
    assert.equal(r.conflicts.length, 1);
  });
});

describe('两台电脑同时上传（条件写入 + 冲突后重新合并）', () => {
  test('下载之后另一台电脑传了新组合：本机上传被拒，重新下载合并再传 —— 对方的新组合还在', async () => {
    const base = text([research]);
    const { w, io } = fakeWorld({ local: text([research, coding]), remote: base, mark: { localHash: comboHash(base), remoteHash: comboHash(base) } });
    w.beforePut.push(() => { w.remote = text([research, { id: 'desk', name: '台式机新加的', mcpServers: {} }]); });
    const r = await syncComboFile(io);
    assert.equal(w.conflicts, 1);
    assert.equal(r.uploaded, true);
    assert.equal(r.plans.length, 2);
    assert.deepEqual(ids(w.remote), ['default', 'research', 'coding', 'desk']);
    assert.equal(w.local, w.remote);
    assert.deepEqual(w.mark, { localHash: comboHash(w.local!), remoteHash: comboHash(w.remote!) });
  });

  test('两台电脑第一次同步、桶里都还没有：后传的那台用「不存在才写」被拒，合并后再传，两边的组合都在', async () => {
    const { w, io } = fakeWorld({ local: text([coding]) });
    w.beforePut.push(() => { w.remote = text([research]); });
    const r = await syncComboFile(io);
    assert.equal(w.conflicts, 1);
    assert.equal(r.uploaded, true);
    assert.deepEqual(ids(w.remote), ['default', 'coding', 'research']);
  });

  test('每次上传前都被抢先改：试满次数就放弃这一轮，不覆盖对方，摘要不更新', async () => {
    const base = text([research]);
    const mark = { localHash: comboHash(base), remoteHash: comboHash(base) };
    const { w, io } = fakeWorld({ local: text([research, coding]), remote: base, mark });
    for (let i = 0; i < 3; i += 1) w.beforePut.push(() => { w.remote = text([research, { id: `d${i}`, name: `D${i}`, mcpServers: {} }]); });
    const r = await syncComboFile(io, 3);
    assert.equal(r.gaveUp, true);
    assert.equal(r.uploaded, false);
    assert.deepEqual(ids(w.remote), ['default', 'research', 'd2']);
    assert.deepEqual(w.mark, mark);
  });

  test('没人抢：一次传完，不重试', async () => {
    const base = text([research]);
    const { w, io } = fakeWorld({ local: text([research, coding]), remote: base, mark: { localHash: comboHash(base), remoteHash: comboHash(base) } });
    const r = await syncComboFile(io);
    assert.equal(r.plans.length, 1);
    assert.equal(w.puts, 1);
    assert.equal(w.remote, text([research, coding]));
  });
});

describe('S3 同步接线', () => {
  test('s3Client 的条件写入：带 if-match / if-none-match，412 / 409 当冲突', () => {
    const S = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 's3Client.ts'), 'utf-8');
    const at = S.indexOf('export async function putObjectIf(');
    assert.ok(at > 0);
    const body = S.slice(at, at + 800);
    assert.ok(body.includes("h['if-match'] = cond.ifMatch"));
    assert.ok(body.includes("h['if-none-match'] = '*'"));
    assert.ok(body.includes("if (r.status === 412 || r.status === 409) return 'conflict';"));
  });
  test('runS3Sync 里同步组合文件（自己传，不走按大小判断的上传循环）', () => {
    const at = M.indexOf('async function runS3Sync(');
    const body = M.slice(at, M.indexOf('function rescheduleS3Sync', at));
    assert.ok(body.includes("uploaded += await syncMcpCombosWithBucket(creds!, cfg.prefix)"));
    assert.doesNotMatch(body, /rel === MCP_COMBOS_REL/);
  });
  test('按 planComboSync 执行：改写前把本机那份挪进 trash，写完通知下拉刷新，成功后才记摘要', () => {
    const at = M.indexOf('async function syncMcpCombosWithBucket(');
    assert.ok(at > 0);
    const body = M.slice(at, at + 4000);
    assert.ok(body.includes('await syncComboFile({'));
    assert.ok(body.includes('putObjectIf(creds, key,'), '上传必须是条件写入');
    assert.ok(body.includes('getObjectWithEtag(creds, key)'));
    assert.ok(body.includes('readComboMark(S3_COMBOS_MARK_PATH)'));
    assert.match(body, /trash/);
    assert.match(body, /acp:mcp-combos-changed/);
    assert.ok(!/[^A-Za-z]putObject\(/.test(body), '组合文件不能用不带条件的 putObject');
    assert.equal(MCP_COMBOS_REL, 'mcp-combos.json');
  });
});
