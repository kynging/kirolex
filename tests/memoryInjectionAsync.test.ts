import assert from 'node:assert/strict';
import { describe, test, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 「远程会话连接的前半段输入框没法输入」（审查意见：记忆拼装也要异步）：每一轮发送都在 prompt 前拼三层记忆，
 * 原来 `buildMemoryInjection` 用 readFileSync 整读全局 / 项目 / 会话三层（没有体积上限，可到 MB 级）。
 * 发送路径改用 `buildMemoryInjectionAsync`（fs.promises）。这里守：
 *   - 异步拼出来的块和同步那份**一字不差**（有项目 / 未分组列项目 / 远程措辞 / 空层 / MB 级大层）；
 *   - 建层文件、路径穿越校验（坏 id 返回 null）、Advanced 专属层不建不读 —— 两条读法一样；
 *   - 接线（读源码）：发送路径在「这一轮在跑吗」那道闸**之前**异步读好、排进 heavyLane，之后用读好的那份；
 *     项目和预判的不一致才退回同步那份（内容照旧对）。
 * memory.ts 的路径在模块加载时按 os.homedir() 定 —— 先把 HOME / USERPROFILE 指到临时目录再 import。
 */
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home = '';
let memory: typeof import('../src/main/memory.ts');
const K = () => path.join(home, '.kirolex');
const write = (rel: string, text: string) => {
  const f = path.join(K(), rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-mem-async-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home);
  write('memory/global.md', '# Global memory\n\n- 全局事实\n');
  write('memory/projects/Dev/memory.md', '# Project memory: Dev\n\n- 项目事实\n');
  write('memory/projects/Blog/memory.md', '# Project memory: Blog\n');
  write('memory/sessions/s_1/memory.md', '# Chat-specific memory\n\n- 会话事实\n');
  memory = await import('../src/main/memory.ts');
});
after(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('记忆拼装：异步那份和同步那份一字不差', () => {
  const cases: Array<[string, string | undefined, string | undefined, { remote?: boolean }]> = [
    ['有项目 + 会话', 'Dev', 's_1', {}],
    ['远程会话（措辞换成 local_read / local_write）', 'Dev', 's_1', { remote: true }],
    ['未分组：列出现有项目', undefined, 's_1', {}],
    ['只有全局', undefined, undefined, {}],
    ['项目层 / 会话层还不存在（先建空壳再读）', 'Fresh', 's_new', {}],
  ];
  for (const [name, p, s, opts] of cases) {
    test(name, async () => {
      const a = await memory.buildMemoryInjectionAsync(p, s, opts);
      const b = memory.buildMemoryInjection(p, s, opts);
      assert.ok(a && a.startsWith('<hidden>\n[KiroLex memory'), String(a).slice(0, 80));
      assert.equal(a, b);
    });
  }

  test('层级顺序照旧：全局 → 项目 → 会话（后面的优先）', async () => {
    const a = (await memory.buildMemoryInjectionAsync('Dev', 's_1'))!;
    const gi = a.indexOf('- 全局事实'); const pi = a.indexOf('- 项目事实'); const si = a.indexOf('- 会话事实');
    assert.ok(gi > 0 && pi > gi && si > pi);
  });

  test('MB 级的大层：照样整段注入、内容一样（不截断、不改注入内容）', async () => {
    const big = `# Project memory: Big\n\n${'- 很长的一条事实 0123456789\n'.repeat(60_000)}`;
    write('memory/projects/Big/memory.md', big);
    assert.ok(Buffer.byteLength(big) > 1_000_000);
    const a = await memory.buildMemoryInjectionAsync('Big', 's_1');
    assert.equal(a, memory.buildMemoryInjection('Big', 's_1'));
    assert.ok(a!.includes(big.trim()));
  });

  test('新建的空壳和同步那条一样（只在不存在时写，不覆盖已有内容）', async () => {
    await memory.buildMemoryInjectionAsync('Fresh2', 's_new2');
    assert.equal(fs.readFileSync(path.join(K(), 'memory', 'projects', 'Fresh2', 'memory.md'), 'utf8'), '# Project memory: Fresh2\n\n');
    assert.equal(fs.readFileSync(path.join(K(), 'memory', 'sessions', 's_new2', 'memory.md'), 'utf8'), '# Chat-specific memory\n\n');
    await memory.buildMemoryInjectionAsync('Dev', 's_1');
    assert.match(fs.readFileSync(path.join(K(), 'memory', 'projects', 'Dev', 'memory.md'), 'utf8'), /- 项目事实/);
  });

  test('路径穿越的 id：两条读法都返回 null，什么都不建', async () => {
    for (const bad of ['../../../victim', '..', 'a/b', 'a\\b']) {
      assert.equal(await memory.buildMemoryInjectionAsync(bad, 's_1'), null, bad);
      assert.equal(memory.buildMemoryInjection(bad, 's_1'), null, bad);
    }
    assert.equal(fs.existsSync(path.join(home, 'victim')), false);
  });

  test('接线：发送路径在忙闸之前异步读好（heavyLane），读完复核项目 / 机器、变了就重读；之后只用读好的，没有同步退路', () => {
    const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    /* 读的时候占住执行器、读完核对执行器没动过（sendPrep.test.ts） */
    const pre = MAIN.indexOf('const read = await prepOnExecutor(sessionId, entry, prepDeps, () => heavyLane(() => buildMemoryPartsAsync(target.projectId, sessionId, { remote: target.remote })));');
    const gate = MAIN.indexOf('if (entry.busy && !handoff) {', pre);
    const reserve = MAIN.indexOf('entry.busy = true; // in-flight turn', pre);
    const use = MAIN.indexOf('const memoryParts = isFeatureEnabled(\'memoryInjection\')', pre);
    assert.ok(pre > 0, '预读那一句');
    assert.ok(gate > pre, '预读在「这一轮在跑吗」那道闸之前（闸之后到占住这一轮之间不能有 await）');
    assert.ok(use > gate && reserve > use);
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(strip(MAIN.slice(gate, use)), /\bawait\b/, '闸之后到用记忆之间没有新的 await');
    /* 读完复核：项目 / 机器变了就按新的再读，对上了才收下 */
    const loop = MAIN.slice(pre - 400, gate);
    assert.match(loop, /for \(let want = memoryTargetFor\(projectId, sessionId, entry\); ;\) \{/);
    assert.match(loop, /want = memoryTargetFor\(projectId, sessionId, entry\);\s*if \(want\.projectId === target\.projectId && want\.remote === target\.remote\) \{ memoryPrefetch = \{ \.\.\.target, parts \}; break; \}/);
    /* 用的地方：只用读好的那份 */
    assert.match(MAIN.slice(use, use + 600), /\? memoryBlockFor\(memoryPrefetch, effectiveProjectId, !!entry\.profile\.remote\?\.sshHost, sessionId\)/);
    /* index.ts 里不再有同步的记忆拼装 */
    assert.doesNotMatch(MAIN, /\bbuildMemoryInjection\(/);
    assert.doesNotMatch(MAIN, /import \{[^}]*\bbuildMemoryInjection\b[^A-Za-z]/);
    const blockFor = MAIN.slice(MAIN.indexOf('function memoryBlockFor('));
    assert.doesNotMatch(strip(blockFor.slice(0, blockFor.indexOf('\n}\n'))), /readFile|buildMemoryInjection/);
  });

  test('memoryTargetFor 和落定 effectiveProjectId 的那段是同一条规则（对不上的话预读的就不是这一轮要的）', () => {
    const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const fn = MAIN.slice(MAIN.indexOf('function memoryTargetFor('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /const asked = projectId !== undefined && !bogusProjectReason\(projectId, sessionId, known\) \? projectId : undefined;/);
    assert.match(body, /const held = bogusProjectReason\(entry\.profile\.projectId, sessionId, known\) \? undefined : entry\.profile\.projectId;/);
    assert.match(body, /return \{ projectId: asked \?\? held, remote: !!entry\.profile\.remote\?\.sshHost \};/);
    /* 落定那段：假项目当没带、执行器上的假项目当未分组、带来的覆盖执行器上的、结果 = 带来的 ?? 执行器上的 */
    const at = MAIN.indexOf('const knownNow = localKnownProjects();');
    const recon = MAIN.slice(at, MAIN.indexOf('const effectiveProjectId = projectId ?? entry.profile.projectId;', at) + 80);
    assert.match(recon, /if \(projectId !== undefined && bogusProjectReason\(projectId, sessionId, knownNow\)\) \{[\s\S]*?projectId = undefined;/);
    assert.match(recon, /if \(bogusProjectReason\(entry\.profile\.projectId, sessionId, knownNow\)\) \{ delete entry\.profile\.projectId;/);
    assert.match(recon, /if \(projectId !== undefined && projectId !== entry\.profile\.projectId\) \{\s*entry\.profile\.projectId = projectId;/);
    assert.match(recon, /const effectiveProjectId = projectId \?\? entry\.profile\.projectId;/);
  });
});
