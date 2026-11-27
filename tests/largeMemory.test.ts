import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LARGE_MEMORY_BYTES, CHUNK_CHARS, autoCompactDue, runLargeCompaction, splitMemoryChunks, protectedBlocks, maskProtected, unmaskProtected,
  checkLargeCompaction, buildLargeCompactPrompt, compactBackupName, localDay, utf8Bytes, PROTECTED_MARKERS,
  gatedCompaction, compactLedgerKey,
  type LargeCompactIo,
} from '../src/main/largeMemory.ts';
import {
  backupMemoryFile, restoreMemoryBackup, memoryFileForBackup, readCompactLedger, recordCompactDay,
} from '../src/main/largeMemoryFiles.ts';
import { memoryCompactGroup, parseMemoryCompactGroup } from '../src/main/memoryCompactNote.ts';

/**
 * token 优化 4/5：大份记忆（> 32 KB）也要整理 —— 先备份、规则写死、不许整份换成几行（40% 下限 + 二级标题一个不少）。
 */

const PROTECTED = '- 用户口径：frp 隧道只走 7000 端口，别的端口一律不开';

/** 多行的受保护条目：关键词只在第一行，具体约束在续行 / 子项里 */
const MULTI = ['- 用户要求：', '  不许在 main 上直接改，先开分支', '  - 合并前跑 npm test'].join('\n');

/** 一份 > 32 KB 的记忆：几个二级标题，每节里一堆重复的过程记录 + 受保护的条目 */
function bigMemory(): string {
  const out: string[] = ['# Chat-specific memory', ''];
  for (const sec of ['## 环境', '## 踩坑', '## 进度']) {
    out.push(sec);
    if (sec === '## 环境') out.push(PROTECTED);
    if (sec === '## 踩坑') out.push(MULTI);
    for (let i = 0; i < 120; i += 1) out.push(`- 已完成：第 ${i} 次部署脚本调试记录，路径 /srv/app/deploy-${i % 7}.sh，结果正常`);
    out.push('');
  }
  return out.join('\n');
}

/** 假的辅助模型：把每段里重复的过程记录去掉一半（合法的整理） */
function halfAsk(prompt: string): Promise<string> {
  const body = prompt.split('----- 原文开始 -----\n')[1].split('\n----- 原文结束 -----')[0];
  const lines = body.split('\n').filter((l, i) => !l.startsWith('- 已完成') || i % 2 === 0);
  return Promise.resolve(lines.join('\n'));
}

function memIo(initial: string, ask: (p: string) => Promise<string>) {
  const state = { text: initial, backups: [] as string[], writes: [] as string[], order: [] as string[], logs: [] as string[] };
  const io: LargeCompactIo = {
    read: () => state.text,
    ask,
    backup: () => { state.order.push('backup'); state.backups.push(state.text); return '/m/sessions/s1/memory.md.bak-20261127-1000'; },
    write: (t) => { state.order.push('write'); state.writes.push(t); state.text = t; },
    log: (m) => { state.logs.push(m); },
  };
  return { io, state };
}

describe('什么时候自动整理', () => {
  test('<= 32KB 不整理', () => {
    assert.ok(autoCompactDue({ scope: 'session', bytes: LARGE_MEMORY_BYTES, enabled: true, today: '2026-11-27' }));
    assert.ok(autoCompactDue({ scope: 'session', bytes: 1000, enabled: true, today: '2026-11-27' }));
    assert.equal(autoCompactDue({ scope: 'session', bytes: LARGE_MEMORY_BYTES + 1, enabled: true, today: '2026-11-27' }), null);
    assert.equal(autoCompactDue({ scope: 'project', bytes: 40 * 1024, enabled: true, today: '2026-11-27' }), null);
  });

  test('全局层永远不自动整理（再大也不）', () => {
    assert.match(autoCompactDue({ scope: 'global', bytes: 999_999, enabled: true, today: '2026-11-27' })!, /global/);
  });

  test('一天第二次不触发；第二天又可以', () => {
    assert.match(autoCompactDue({ scope: 'session', bytes: 50_000, enabled: true, lastDay: '2026-11-27', today: '2026-11-27' })!, /today/);
    assert.equal(autoCompactDue({ scope: 'session', bytes: 50_000, enabled: true, lastDay: '2026-11-26', today: '2026-11-27' }), null);
  });

  test('设置里关掉就不整理', () => {
    assert.ok(autoCompactDue({ scope: 'session', bytes: 50_000, enabled: false, today: '2026-11-27' }));
  });
});

describe('整理：先备份、规则写死、不合格作废', () => {
  test('> 32KB 整理：先备份（备份的是原文），再写；结果变小', async () => {
    const original = bigMemory();
    assert.ok(utf8Bytes(original) > LARGE_MEMORY_BYTES);
    const { io, state } = memIo(original, halfAsk);
    const r = await runLargeCompaction('session', io);
    assert.equal(r.status, 'written');
    assert.deepEqual(state.order, ['backup', 'write']);
    assert.equal(state.backups[0], original);
    if (r.status === 'written') {
      assert.ok(r.afterBytes < r.beforeBytes);
      assert.equal(r.backupPath, '/m/sessions/s1/memory.md.bak-20261127-1000');
    }
  });

  test('结果不到原文 40% → 作废，原文不动、也不备份', async () => {
    const original = bigMemory();
    /* 「整份换成几行」：每段只回两行（标题都在，但篇幅只剩一点） */
    const { io, state } = memIo(original, (p) => Promise.resolve(p.includes('## ') ? '## 环境\n- 一切正常' : '- 一切正常'));
    const r = await runLargeCompaction('session', io);
    assert.equal(r.status, 'rejected');
    assert.equal(state.text, original);
    assert.equal(state.writes.length, 0);
    assert.equal(state.backups.length, 0);
  });

  test('整份校验：少于 40% 或丢了二级标题 → 不能用', () => {
    const original = bigMemory();
    assert.match(checkLargeCompaction(original, original.slice(0, Math.floor(original.length * 0.2)))!, /below/);
    assert.match(checkLargeCompaction(original, original.replace('## 踩坑\n', ''))!, /heading/);
    assert.equal(checkLargeCompaction(original, original), null);
  });

  test('只有一段丢了二级标题、其余各段都压缩了 → 整次作废，原文不动、不备份', async () => {
    const original = bigMemory();
    let first = true;
    const { io, state } = memIo(original, async (p) => {
      const out = await halfAsk(p);
      if (first && /^## /m.test(out)) { first = false; return out.replace(/^## .*$/m, ''); }
      return out;
    });
    const r = await runLargeCompaction('session', io);
    assert.equal(r.status, 'rejected');
    assert.equal(state.text, original);
    assert.equal(state.backups.length, 0);
    assert.equal(state.writes.length, 0);
  });

  test('只有一段少于 40%、其余各段正常 → 整次作废', async () => {
    const original = bigMemory();
    let first = true;
    const { io, state } = memIo(original, async (p) => {
      const out = await halfAsk(p);
      if (first) { first = false; return out.split('\n').filter((l) => !l.startsWith('- 已完成')).join('\n'); }
      return out;
    });
    const r = await runLargeCompaction('session', io);
    assert.equal(r.status, 'rejected');
    assert.equal(state.text, original);
  });

  test('含「用户口径」的条目根本不交给模型，结果里原样存在（多行条目连同续行、子项整条原样）', async () => {
    const original = bigMemory();
    const prompts: string[] = [];
    const { io, state } = memIo(original, (p) => { prompts.push(p); return halfAsk(p); });
    const r = await runLargeCompaction('session', io);
    assert.equal(r.status, 'written');
    const sent = prompts.map((p) => p.split('----- 原文开始 -----')[1]).join('\n');
    assert.ok(!sent.includes('frp 隧道只走 7000') && !sent.includes('不许在 main 上直接改'), '受保护的内容不该交给模型');
    assert.ok(state.text.split('\n').includes(PROTECTED));
    assert.ok(state.text.includes(`\n${MULTI}\n`), '多行条目整条原样');
    const at = state.text.indexOf(MULTI);
    assert.ok(at > state.text.indexOf('## 踩坑') && at < state.text.indexOf('## 进度'), '还在原来那一节');
  });

  test('模型删了 / 复制了 / 改了占位行 → 整次作废，原文不动', async () => {
    const mangles = [
      (o: string) => o.replace(/^⟦KEEP-\d+⟧$/m, ''),
      (o: string) => o.replace(/^(⟦KEEP-\d+⟧)$/m, '$1\n$1'),
      (o: string) => o.replace(/^(⟦KEEP-\d+⟧)$/m, '- 合并：$1'),
    ];
    for (const mangle of mangles) {
      const original = bigMemory();
      const { io, state } = memIo(original, async (p) => mangle(await halfAsk(p)));
      const r = await runLargeCompaction('session', io);
      assert.equal(r.status, 'rejected');
      assert.equal(state.text, original);
    }
  });

  test('受保护条目的范围：续行 / 缩进子项算同一条；以冒号结尾的连同下面紧跟的几行（直到空行），宁多勿漏', () => {
    const text = ['## A', '- 用户要求：', '  具体是 X', '  - 子项 Y', '- 紧跟的一条', '', '用户决定：', '- 第一项', '- 第二项', '', '- 别的'].join('\n');
    const lines = text.split('\n');
    const blocks = protectedBlocks(text).map((r) => lines.slice(r.start, r.end));
    assert.deepEqual(blocks, [['- 用户要求：', '  具体是 X', '  - 子项 Y', '- 紧跟的一条'], ['用户决定：', '- 第一项', '- 第二项']]);
    const { masked, blocks: kept } = maskProtected(text);
    assert.ok(!masked.includes('具体是 X'));
    assert.equal(unmaskProtected(masked, kept), text);
  });

  /** 审查复现的两种：说明文字引出的规则列表；含关键词的三级标题下面的一节 */
  const INTRO = ['用户要求：', '说明文字：下面两条每次发版都要守', '- 部署规则：只在周二部署', '- 验收规则：验收前跑完整回归'].join('\n');
  const H3 = ['### 用户决定', '- 决定一：日志保留 30 天', '- 决定二：不再用旧的 S3 桶'].join('\n');
  function bigWithRules(): string {
    const base = bigMemory().split('\n');
    const at = base.indexOf('## 进度');
    base.splice(at + 1, 0, INTRO, '', H3, '');
    let text = base.join('\n');
    while (utf8Bytes(text) < 52 * 1024) text += `\n- 已完成：补充记录 ${text.length}，结果正常`;
    return text;
  }

  test('说明文字引出的规则列表、含关键词的三级标题整节，都算受保护', () => {
    const text = bigWithRules();
    const lines = text.split('\n');
    const blocks = protectedBlocks(text).map((r) => lines.slice(r.start, r.end).join('\n'));
    assert.ok(blocks.some((b) => b === INTRO), '「用户要求：说明文字 + 列表」整条');
    assert.ok(blocks.some((b) => b.startsWith(`${H3}\n`) || b === H3), '「### 用户决定」整节（含标题）');
  });

  test('52KB 原文整理：规则列表和三级标题那一节不交给模型、结果里原样都在', async () => {
    const original = bigWithRules();
    const prompts: string[] = [];
    /* 模型「想」删掉部署规则、改掉三级标题 —— 但它根本看不到 */
    const { io, state } = memIo(original, async (p) => {
      prompts.push(p);
      return (await halfAsk(p)).split('\n').filter((l) => !l.includes('部署规则')).map((l) => l.replace('### 用户决定', '### 决定')).join('\n');
    });
    const r = await runLargeCompaction('project', io);
    assert.equal(r.status, 'written');
    const sent = prompts.map((p) => p.split('----- 原文开始 -----')[1]).join('\n');
    assert.ok(!sent.includes('部署规则') && !sent.includes('用户决定'), '受保护的内容不该交给模型');
    assert.ok(state.text.includes(`\n${INTRO}\n`));
    assert.ok(state.text.includes(`\n${H3}\n`));
  });

  test('整份校验：删了引出的规则列表里的一条 / 删了或改了含关键词的三级标题 → 不能用', () => {
    const original = bigWithRules();
    assert.match(checkLargeCompaction(original, original.replace('- 部署规则：只在周二部署\n', ''))!, /protected/);
    assert.match(checkLargeCompaction(original, original.replace('- 部署规则：只在周二部署', '- 部署规则：随时部署'))!, /protected/);
    assert.match(checkLargeCompaction(original, original.replace('### 用户决定\n', ''))!, /protected/);
    assert.match(checkLargeCompaction(original, original.replace('### 用户决定', '### 决定'))!, /protected/);
    assert.equal(checkLargeCompaction(original, original), null);
  });

  test('模型删了规则列表 / 三级标题那一节的占位 → 整次作废，原文不动', async () => {
    const original = bigWithRules();
    const { masked, blocks } = maskProtected(original);
    for (const target of [INTRO, H3]) {
      const n = blocks.findIndex((b) => b === target || b.startsWith(`${target}\n`));
      assert.ok(n >= 0 && masked.includes(`⟦KEEP-${n}⟧`));
      const { io, state } = memIo(original, async (p) => (await halfAsk(p)).split('\n').filter((l) => l.trim() !== `⟦KEEP-${n}⟧`).join('\n'));
      const r = await runLargeCompaction('project', io);
      assert.equal(r.status, 'rejected');
      assert.equal(state.text, original);
      assert.equal(state.backups.length, 0);
    }
  });

  test('整份校验：多行受保护条目丢了续行 → 不能用', () => {
    const original = bigMemory();
    assert.match(checkLargeCompaction(original, original.replace('  不许在 main 上直接改，先开分支\n', ''))!, /protected/);
  });

  test('模型报错的那一段照抄；全部失败 → 不写', async () => {
    const original = bigMemory();
    const { io, state } = memIo(original, () => Promise.reject(new Error('timeout')));
    const r = await runLargeCompaction('session', io);
    assert.equal(r.status, 'unchanged');
    assert.equal(state.writes.length, 0);
  });

  test('等模型期间文件被改过 → 不写（不盖掉刚保存的）', async () => {
    const original = bigMemory();
    let calls = 0;
    const { io, state } = memIo(original, async (p) => { calls += 1; if (calls === 1) state.text = `${original}\n- 新写的一条`; return halfAsk(p); });
    const r = await runLargeCompaction('session', io);
    assert.equal(r.status, 'skipped');
    assert.equal(state.writes.length, 0);
  });

  test('备份不上 → 不写', async () => {
    const original = bigMemory();
    const { io, state } = memIo(original, halfAsk);
    io.backup = () => null;
    const r = await runLargeCompaction('session', io);
    assert.equal(r.status, 'skipped');
    assert.equal(state.writes.length, 0);
  });

  test('提示词里写死三条规则和受保护字样', () => {
    const p = buildLargeCompactPrompt('x', { scope: 'project', index: 0, total: 2 });
    for (const m of PROTECTED_MARKERS) assert.ok(p.includes(`「${m}」`), m);
    assert.match(p, /合并重复/);
    assert.match(p, /已合并」「已完成」「已过期/);
    assert.match(p, /多行压成一条一行/);
    assert.match(p, /40%/);
  });

  test('分段：每段不超过上限，拼回去和原文一字不差', () => {
    const original = bigMemory();
    const chunks = splitMemoryChunks(original);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= CHUNK_CHARS + 1);
    assert.equal(chunks.join('\n'), original);
  });
});

describe('备份 / 撤销 / 账本（真文件）', () => {
  let root = '';
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = ''; });
  const setup = () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-largemem-'));
    const dir = path.join(root, 'memory', 'sessions', 's1');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'memory.md');
    fs.writeFileSync(file, '原文\n');
    return { memRoot: path.join(root, 'memory'), file };
  };

  test('备份名是同目录 memory.md.bak-<YYYYMMDD-HHmm>；同一分钟第二份不覆盖第一份', () => {
    const { file } = setup();
    const now = new Date(2026, 10, 27, 9, 5);
    assert.equal(compactBackupName(now), 'memory.md.bak-20261127-0905');
    const a = backupMemoryFile(file, now)!;
    assert.equal(a, path.join(path.dirname(file), 'memory.md.bak-20261127-0905'));
    fs.writeFileSync(file, '整理过\n');
    const b = backupMemoryFile(file, now)!;
    assert.notEqual(a, b);
    assert.equal(fs.readFileSync(a, 'utf-8'), '原文\n');
    assert.equal(fs.readFileSync(b, 'utf-8'), '整理过\n');
  });

  test('撤销 = 用备份覆盖回去', () => {
    const { file, memRoot } = setup();
    const at = backupMemoryFile(file, new Date(2026, 10, 27, 10, 0))!;
    fs.writeFileSync(file, '整理后的\n');
    const r = restoreMemoryBackup(at, memRoot);
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(file, 'utf-8'), '原文\n');
  });

  test('撤销只认我们写的备份：名字不对 / 不在 sessions|projects 下（全局层）的一律拒绝', () => {
    const { file, memRoot } = setup();
    assert.equal(memoryFileForBackup(file, memRoot), null);
    assert.equal(memoryFileForBackup(path.join(memRoot, 'memory.md.bak-20261127-1000'), memRoot), null);
    assert.equal(memoryFileForBackup(path.join(root, 'elsewhere', 'x', 'memory.md.bak-20261127-1000'), memRoot), null);
    const ok = memoryFileForBackup(path.join(memRoot, 'projects', 'p1', 'memory.md.bak-20261127-1000'), memRoot);
    assert.deepEqual(ok, { file: path.join(memRoot, 'projects', 'p1', 'memory.md'), scope: 'project', id: 'p1' });
    assert.equal(restoreMemoryBackup(path.join(memRoot, 'memory.md.bak-20261127-1000'), memRoot).ok, false);
  });

  test('账本：记下今天整理过 → 今天第二次不触发', () => {
    setup();
    const ledger = path.join(root, 'memory-compact.json');
    const today = localDay(new Date(2026, 10, 27, 23, 59));
    recordCompactDay(ledger, 'session:s1', today);
    const lastDay = readCompactLedger(ledger)['session:s1'];
    assert.equal(lastDay, '2026-11-27');
    assert.ok(autoCompactDue({ scope: 'session', bytes: 50_000, enabled: true, lastDay, today }));
  });
});

describe('提示的 noteGroup 带着备份路径（Windows 路径里的冒号也不怕）', () => {
  test('来回一致', () => {
    const p = 'C:\\Users\\a\\.kirolex\\memory\\sessions\\s1\\memory.md.bak-20261127-1000';
    assert.equal(parseMemoryCompactGroup(memoryCompactGroup(p)), p);
    assert.equal(parseMemoryCompactGroup('schedule-end:x'), null);
  });
});

describe('一天一次：两个会话交错结束一轮（回归）', () => {
  let root = '';
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = ''; });

  /** 和 index.ts 的 compactLargeMemoryLayer 同一种接法：账本是真文件，锁是共享的 Set */
  function gateFor(ledger: string, key: string, inFlight: Set<string>, bytes = 50_000) {
    return {
      inFlight,
      recheck: () => ({ lastDay: readCompactLedger(ledger)[key], bytes, enabled: true, today: '2026-11-27' }),
      record: (day: string) => recordCompactDay(ledger, key, day),
    };
  }

  test('A 拿着旧账本快照、等会话层整理时，B 先整理完项目层 → A 不再整理项目层', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-gate-'));
    const ledger = path.join(root, 'memory-compact.json');
    const inFlight = new Set<string>();
    const proj = compactLedgerKey('project', 'p1');
    const runs: string[] = [];

    /* A 进来时读的账本快照：项目层今天还没整理过 → 按快照判是该整理 */
    const snapshotA = readCompactLedger(ledger);
    assert.equal(autoCompactDue({ scope: 'project', bytes: 50_000, enabled: true, lastDay: snapshotA[proj], today: '2026-11-27' }), null);

    /* A 先整理自己的会话层；在它等模型的时候，B 整理完项目层 */
    let releaseA!: () => void;
    const aSession = gatedCompaction('session', compactLedgerKey('session', 'sA'), true, gateFor(ledger, compactLedgerKey('session', 'sA'), inFlight),
      () => new Promise<string>((r) => { releaseA = () => { runs.push('A:session'); r('done'); }; }));
    const bProject = await gatedCompaction('project', proj, true, gateFor(ledger, proj, inFlight), async () => { runs.push('B:project'); return 'done'; });
    assert.equal(bProject, 'done');
    releaseA();
    await aSession;

    /* A 接着轮到项目层：锁里按现读的账本重判 → 今天已经整理过，不跑 */
    const aProject = await gatedCompaction('project', proj, true, gateFor(ledger, proj, inFlight), async () => { runs.push('A:project'); return 'done'; });
    assert.deepEqual(aProject, { status: 'not-due', reason: 'already compacted today (2026-11-27)' });
    assert.deepEqual(runs, ['B:project', 'A:session']);
  });

  test('两个会话同时到项目层：第二个拿不到锁（busy），第一个记了账之后再来也不跑', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-gate-'));
    const ledger = path.join(root, 'memory-compact.json');
    const inFlight = new Set<string>();
    const proj = compactLedgerKey('project', 'p1');
    let release!: () => void;
    const first = gatedCompaction('project', proj, true, gateFor(ledger, proj, inFlight), () => new Promise<string>((r) => { release = () => r('done'); }));
    const second = await gatedCompaction('project', proj, true, gateFor(ledger, proj, inFlight), async () => 'ran');
    assert.equal((second as any).status, 'busy');
    release();
    assert.equal(await first, 'done');
    const third = await gatedCompaction('project', proj, true, gateFor(ledger, proj, inFlight), async () => 'ran');
    assert.equal((third as any).status, 'not-due');
  });

  test('锁里也按现读的大小判：这期间别人整理到 32KB 以下了就不跑', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-gate-'));
    const ledger = path.join(root, 'memory-compact.json');
    const key = compactLedgerKey('session', 's1');
    const r = await gatedCompaction('session', key, true, gateFor(ledger, key, new Set(), 10_000), async () => 'ran');
    assert.equal((r as any).status, 'not-due');
    assert.equal(readCompactLedger(ledger)[key], undefined, '没整理就不记账');
  });

  test('手动整理不看账本和大小，照样跑，并记账', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-gate-'));
    const ledger = path.join(root, 'memory-compact.json');
    const key = compactLedgerKey('project', 'p1');
    recordCompactDay(ledger, key, '2026-11-27');
    const r = await gatedCompaction('project', key, false, gateFor(ledger, key, new Set(), 100), async () => 'ran');
    assert.equal(r, 'ran');
    assert.equal(readCompactLedger(ledger)[key], '2026-11-27');
  });
});
