import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  planInjection, markContextReset, extractLayerRules, pickRules, normalizeMemoryFullInterval, remoteBriefLine,
  contextPercentOf, noteContextUsage,
  MEMORY_RULES_MAX_CHARS, MEMORY_FULL_INTERVAL_DEFAULT, type InjectCadence,
} from '../src/main/injectionCadence.ts';

/**
 * 记忆 / 远程环境说明**按需完整注入**（token 优化 3/5）。
 *
 * 实测：每轮把三层记忆整份（21–25k 字符，最高 39k）和远程环境说明（~2.5k）拼在用户消息前面，大多每轮不变，
 * 却一直累积在上下文里。每轮注入是有意的（「每次回复都要做 X」只说一次几轮后就被忘了），所以不是改成只注入一次：
 * 首轮 / 压缩·换后端·回放之后 / 记忆变了 / 满 8 轮 → 完整；其余轮次只带「规则部分」（≤1.5k）+ 一行完整记忆的路径。
 */

type Inp = Parameters<typeof planInjection>[1];
const base: Inp = { backend: 'cli-1', memoryHash: 'h1', fullEveryTurn: false, interval: MEMORY_FULL_INTERVAL_DEFAULT, replay: false, retry: false };

/** 连发 n 轮，返回每轮的计划和最后的状态 */
function run(n: number, inp: Partial<Inp> = {}, start?: InjectCadence) {
  let s = start;
  const plans = [];
  for (let i = 0; i < n; i++) {
    const r = planInjection(s, { ...base, ...inp });
    plans.push(r.plan);
    s = r.next;
  }
  return { plans, state: s! };
}

describe('完整注入的时机', () => {
  test('第一轮 full、第 2–8 轮 rules、第 9 轮 full（默认每 8 轮）', () => {
    const { plans } = run(17);
    assert.deepEqual(plans.map((p) => p.turn), Array.from({ length: 17 }, (_, i) => i + 1));
    assert.equal(plans[0].memory, 'full');
    assert.equal(plans[0].reason, 'first');
    for (let t = 2; t <= 8; t++) assert.equal(plans[t - 1].memory, 'rules', `第 ${t} 轮`);
    assert.equal(plans[8].memory, 'full');
    assert.equal(plans[8].reason, 'interval');
    for (let t = 10; t <= 16; t++) assert.equal(plans[t - 1].memory, 'rules', `第 ${t} 轮`);
    assert.equal(plans[16].memory, 'full', '第 17 轮又满 8 轮');
  });

  test('间隔可调（4 → 第 5 轮 full），超出范围夹到 4–20，坏值用默认 8', () => {
    const { plans } = run(5, { interval: 4 });
    assert.deepEqual(plans.map((p) => p.memory), ['full', 'rules', 'rules', 'rules', 'full']);
    assert.equal(normalizeMemoryFullInterval(2), 4);
    assert.equal(normalizeMemoryFullInterval(99), 20);
    assert.equal(normalizeMemoryFullInterval('12'), 12);
    assert.equal(normalizeMemoryFullInterval(undefined), 8);
    assert.equal(normalizeMemoryFullInterval('abc'), 8);
  });

  test('记忆文件改一个字（哈希变了）→ 下一轮 full，之后重新从这一轮数 8 轮', () => {
    const { state } = run(3);
    const r = planInjection(state, { ...base, memoryHash: 'h2' });
    assert.equal(r.plan.memory, 'full');
    assert.equal(r.plan.reason, 'changed');
    assert.equal(r.plan.turn, 4);
    const after = run(8, { memoryHash: 'h2' }, r.next).plans;
    assert.deepEqual(after.map((p) => p.memory), ['rules', 'rules', 'rules', 'rules', 'rules', 'rules', 'rules', 'full'], '第 12 轮 = 第 4 轮之后满 8 轮');
  });

  test('压缩之后（markContextReset）下一轮 full，再下一轮回到 rules', () => {
    const { state } = run(3);
    markContextReset(state);
    const r = planInjection(state, base);
    assert.equal(r.plan.memory, 'full');
    assert.equal(r.plan.reason, 'reset');
    assert.equal(planInjection(r.next, base).plan.memory, 'rules');
  });

  test('还没有状态时 markContextReset 不出错（下一轮本来就是首轮）', () => {
    assert.doesNotThrow(() => markContextReset(undefined));
  });

  test('这一轮带历史回放（replay）→ full', () => {
    const { state } = run(3);
    const r = planInjection(state, { ...base, replay: true });
    assert.equal(r.plan.memory, 'full');
    assert.equal(r.plan.reason, 'reset');
  });

  test('换了后端会话（cliSessionId 变了）→ 算新后端会话的第一轮', () => {
    const { state } = run(3);
    const r = planInjection(state, { ...base, backend: 'cli-2' });
    assert.equal(r.plan.memory, 'full');
    assert.equal(r.plan.reason, 'first');
    assert.equal(r.plan.turn, 1);
  });

  test('开关「每轮都完整注入」打开 → 每轮 full', () => {
    const { plans } = run(10, { fullEveryTurn: true });
    assert.ok(plans.every((p) => p.memory === 'full'));
  });

  test('自动重发（retry）沿用上一次的决定，不多数一轮', () => {
    const { state } = run(1);
    const r = planInjection(state, { ...base, retry: true });
    assert.equal(r.plan.memory, 'full', '第一轮重发：后端可能没收到那次的完整记忆');
    assert.equal(r.plan.turn, 1);
    assert.equal(r.plan.remote, 'full');
    const r2 = planInjection(r.next, base);
    assert.equal(r2.plan.turn, 2);
    assert.equal(r2.plan.memory, 'rules');
  });

  test('读不到记忆（hash=null）不影响计数，也不把哈希记成空', () => {
    const { state } = run(2);
    const r = planInjection(state, { ...base, memoryHash: null });
    assert.equal(r.next.memoryHash, 'h1');
  });
});

describe('远程环境说明：每个后端会话只在首轮和压缩 / 回放后完整注入', () => {
  test('首轮 full，其余 brief；满 8 轮、记忆变了都不重发远程说明', () => {
    const { plans, state } = run(10);
    assert.equal(plans[0].remote, 'full');
    assert.ok(plans.slice(1).every((p) => p.remote === 'brief'), '第 9 轮记忆 full，远程说明照旧 brief');
    assert.equal(planInjection(state, { ...base, memoryHash: 'h9' }).plan.remote, 'brief');
  });

  test('压缩后 / 回放 / 换后端 → 再完整注入一次', () => {
    const { state } = run(3);
    markContextReset(state);
    assert.equal(planInjection(state, base).plan.remote, 'full');
    const s2 = run(3).state;
    assert.equal(planInjection(s2, { ...base, replay: true }).plan.remote, 'full');
    assert.equal(planInjection(s2, { ...base, backend: 'cli-x' }).plan.remote, 'full');
  });

  test('普通轮次即使说明内容变了也只带一行（只有首轮 / 压缩 / 回放才完整注入）', () => {
    /* 决定里根本不看说明内容：除了换后端 / 压缩 / 回放，任何输入变化（记忆变了、满 8 轮）都还是 brief */
    const s = run(3).state;
    assert.equal(planInjection(s, { ...base, memoryHash: 'other' }).plan.remote, 'brief');
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const at = M.indexOf('planInjection(entry.injectCadence, {');
    assert.ok(at > 0);
    assert.doesNotMatch(M.slice(at, M.indexOf('});', at)), /remote/i, '交给 planInjection 的参数里没有远程说明的内容 / 哈希');
  });

  test('「每轮都完整注入」开关只管记忆，远程说明照旧只在首轮', () => {
    const { plans } = run(3, { fullEveryTurn: true });
    assert.deepEqual(plans.map((p) => p.remote), ['full', 'brief', 'brief']);
  });

  test('简短那一行带机器名', () => {
    assert.equal(remoteBriefLine('gpu-box'), '[运行环境：远程 · gpu-box]，详见首轮说明');
  });
});

describe('后端静默自动压缩（没有 /compact、也没有「正在压缩」）：靠上下文占用大幅回落认出来', () => {
  test('读用量帧：适配器 usage_update 的 used / size、kiro 的 contextUsagePercentage；别的帧是 null', () => {
    assert.equal(contextPercentOf({ sessionUpdate: 'usage_update', used: 80, size: 100 }), 80);
    assert.equal(contextPercentOf({ sessionUpdate: '_kiro_internal', method: '_kiro.dev/metadata', contextUsagePercentage: 42 }), 42);
    assert.equal(contextPercentOf({ sessionUpdate: 'usage_update', cost: { amount: 1 } }), null);
    assert.equal(contextPercentOf({ sessionUpdate: 'agent_message_chunk' }), null);
    assert.equal(contextPercentOf(undefined), null);
  });

  test('占用从 85% 掉到 20%（静默自动压缩）→ 下一轮记忆 full、远程说明 full；再下一轮回到 rules / brief', () => {
    const { state } = run(3);
    assert.equal(noteContextUsage(state, contextPercentOf({ sessionUpdate: 'usage_update', used: 850, size: 1000 })), false);
    assert.equal(noteContextUsage(state, contextPercentOf({ sessionUpdate: 'usage_update', used: 870, size: 1000 })), false, '涨不算');
    assert.equal(noteContextUsage(state, contextPercentOf({ sessionUpdate: 'usage_update', used: 200, size: 1000 })), true);
    const r = planInjection(state, base);
    assert.equal(r.plan.memory, 'full');
    assert.equal(r.plan.reason, 'reset');
    assert.equal(r.plan.remote, 'full');
    const r2 = planInjection(r.next, base);
    assert.equal(r2.plan.memory, 'rules');
    assert.equal(r2.plan.remote, 'brief');
  });

  test('kiro 的占用帧同样认', () => {
    const { state } = run(2);
    noteContextUsage(state, 70);
    assert.equal(noteContextUsage(state, contextPercentOf({ sessionUpdate: '_kiro_internal', method: '_kiro.dev/metadata', contextUsagePercentage: 15 })), true);
    assert.equal(planInjection(state, base).plan.memory, 'full');
  });

  test('小幅波动不算压缩（掉不到 10 个点、或没掉到原来的 70% 以下）', () => {
    const { state } = run(2);
    noteContextUsage(state, 60);
    assert.equal(noteContextUsage(state, 52), false, '只掉 8 个点');
    noteContextUsage(state, 90);
    assert.equal(noteContextUsage(state, 70), false, '掉了 20 个点但还在 70% 以上');
    assert.equal(planInjection(state, base).plan.memory, 'rules');
  });

  test('占用读数跨轮保留（同一个后端会话），换后端会话从头记', () => {
    const { state } = run(2);
    noteContextUsage(state, 80);
    const r = planInjection(state, base);
    assert.equal(r.next.contextPct, 80);
    assert.equal(noteContextUsage(r.next, 10), true, '上一轮记的 80 → 这一轮 10');
    const swapped = planInjection(r.next, { ...base, backend: 'cli-new' }).next;
    assert.equal(swapped.contextPct, undefined);
  });

  test('还没有状态时不出错、不判', () => {
    assert.equal(noteContextUsage(undefined, 10), false);
  });

  test('接线：每一帧更新都经 noteContextUsage（子代理的帧不算），判成压缩记一行日志', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const on = M.slice(M.indexOf("client.on('update', onUpdate = "), M.indexOf("mainWindow?.webContents.send('acp:update'", M.indexOf("client.on('update', onUpdate = ")));
    assert.match(on, /if \(!childSessionId && noteContextUsage\(entry\.injectCadence, contextPercentOf\(data\?\.update\)\)\) \{/);
    assert.match(on, /context usage dropped sharply \(compacted\)/);
  });
});

describe('规则部分怎么取', () => {
  test('<!-- always --> … <!-- /always --> 包住的段落被取出（多段都认），别的内容不取', () => {
    const text = [
      '# 项目记忆',
      '## 背景',
      '- 这是背景事实，不该出现',
      '<!-- always -->',
      '- 每次回复结尾打印生成物完整路径',
      '- 不要用 python',
      '<!-- /always -->',
      '## 规则',
      '- 有标记时，标题规则不再起作用',
      '<!--always-->',
      '- 第二段也认',
      '<!-- /always -->',
    ].join('\n');
    const items = extractLayerRules(text);
    assert.deepEqual(items, ['- 每次回复结尾打印生成物完整路径', '- 不要用 python', '- 第二段也认']);
  });

  test('没有标记：取标题含「硬规矩」「规矩」「口径」「规则」的二级节（到下一个一 / 二级标题为止）', () => {
    const text = [
      '# Global memory',
      '## 机器环境',
      '- Windows 机，没有 python',
      '## 硬规矩',
      '- 改完必须跑测试',
      '  续行也属于这一条',
      '### 子节',
      '- 子节里的也算',
      '## 写作口径',
      '1. 用中文回复',
      '## 杂项',
      '- 不该出现',
      '### 规则（三级标题不算）',
      '- 也不该出现',
    ].join('\n');
    const items = extractLayerRules(text);
    assert.deepEqual(items, [
      '## 硬规矩',
      '- 改完必须跑测试\n  续行也属于这一条',
      '### 子节',
      '- 子节里的也算',
      '## 写作口径',
      '1. 用中文回复',
    ]);
  });

  test('既没有标记也没有规则标题 → 空', () => {
    assert.deepEqual(extractLayerRules('# x\n## 背景\n- a\n'), []);
    assert.deepEqual(extractLayerRules(''), []);
  });

  test('容忍 \\r\\n', () => {
    assert.deepEqual(extractLayerRules('## 规则\r\n- a\r\n- b\r\n'), ['## 规则', '- a', '- b']);
  });

  test('不超 1.5k：三层都在，按全局 → 项目 → 会话的顺序排，不截', () => {
    const r = pickRules([
      { scope: 'global', items: ['- g1'] },
      { scope: 'project', items: ['- p1'] },
      { scope: 'session', items: ['- s1'] },
    ]);
    assert.equal(r.dropped, 0);
    assert.ok(r.text.indexOf('- g1') < r.text.indexOf('- p1') && r.text.indexOf('- p1') < r.text.indexOf('- s1'));
  });

  test('超过 1.5k：按 会话 > 项目 > 全局 的优先级截，截掉的计数（标题不算条数），总长不超上限', () => {
    const line = (tag: string, i: number) => `- ${tag}${i} ${'字'.repeat(90)}`;
    const session = Array.from({ length: 8 }, (_, i) => line('s', i));      // ~ 8 × 95 = 760
    const project = Array.from({ length: 8 }, (_, i) => line('p', i));      // 又 760 → 超了
    const global = ['## 硬规矩', ...Array.from({ length: 5 }, (_, i) => line('g', i))];
    const r = pickRules([
      { scope: 'global', items: global },
      { scope: 'project', items: project },
      { scope: 'session', items: session },
    ]);
    assert.ok(r.text.length <= MEMORY_RULES_MAX_CHARS, `规则部分 ${r.text.length} 字符`);
    for (const s of session) assert.ok(r.text.includes(s), '会话层全部保留');
    assert.ok(!r.text.includes('- g0'), '全局层被截掉');
    const keptProject = project.filter((p) => r.text.includes(p)).length;
    assert.ok(keptProject > 0 && keptProject < 8, `项目层部分保留（${keptProject}）`);
    assert.equal(r.dropped, (8 - keptProject) + 5, '截掉的条数 = 项目层剩下的 + 全局 5 条（标题不算）');
  });

  test('一条就超过上限 → 整条截掉并计数，不切半截', () => {
    const r = pickRules([{ scope: 'session', items: ['- ' + 'x'.repeat(2000)] }]);
    assert.equal(r.text, '');
    assert.equal(r.dropped, 1);
  });
});

describe('拼出来的规则块（memory.ts）', () => {
  test('rules 块：带规则、带截断计数、带「完整记忆：<三层文件路径>，需要时读」', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-cadence-'));
    const prevHome = process.env.HOME; const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const memory = await import(`../src/main/memory.ts?cadence=${Date.now()}`);
      const dir = path.join(home, '.kirolex', 'memory');
      fs.mkdirSync(path.join(dir, 'projects', 'P'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'sessions', 's_1'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'global.md'), '# G\n## 背景\n- 背景事实很长' + '长'.repeat(5000) + '\n## 硬规矩\n- 全局规矩一条\n');
      fs.writeFileSync(path.join(dir, 'projects', 'P', 'memory.md'), '# P\n<!-- always -->\n- 项目永远带\n<!-- /always -->\n- 项目背景\n');
      fs.writeFileSync(path.join(dir, 'sessions', 's_1', 'memory.md'), '# S\n- 会话事实\n');
      const parts = await memory.buildMemoryPartsAsync('P', 's_1', {});
      assert.ok(parts);
      assert.ok(parts.full.includes('背景事实很长'));
      assert.ok(parts.rules.length < 1500 + 800, `rules 块 ${parts.rules.length}`);
      assert.ok(parts.rules.includes('- 全局规矩一条'));
      assert.ok(parts.rules.includes('- 项目永远带'));
      assert.ok(!parts.rules.includes('背景事实很长'));
      assert.ok(!parts.rules.includes('项目背景'));
      assert.ok(!parts.rules.includes('会话事实'), '会话层没有标记也没有规则标题 → 不取');
      assert.match(parts.rules, /完整记忆：/);
      assert.ok(parts.rules.includes(path.join(dir, 'global.md')));
      assert.ok(parts.rules.includes(path.join(dir, 'projects', 'P', 'memory.md')));
      assert.ok(parts.rules.includes(path.join(dir, 'sessions', 's_1', 'memory.md')));
      assert.match(parts.rules, /需要时读/);
      assert.ok(parts.rules.startsWith('<hidden>') && parts.rules.endsWith('</hidden>'));
      /* 哈希跟着内容走：改一个字就变 */
      const h1 = parts.hash;
      fs.writeFileSync(path.join(dir, 'sessions', 's_1', 'memory.md'), '# S\n- 会话事实！\n');
      const parts2 = await memory.buildMemoryPartsAsync('P', 's_1', {});
      assert.notEqual(parts2.hash, h1);
      const parts3 = await memory.buildMemoryPartsAsync('P', 's_1', {});
      assert.equal(parts3.hash, parts2.hash, '没改就不变');
      /* 远程会话：说用 local_read 读 */
      const remote = await memory.buildMemoryPartsAsync('P', 's_1', { remote: true });
      assert.match(remote.rules, /local_read/);
      /* 截掉的规则写计数 */
      fs.writeFileSync(path.join(dir, 'sessions', 's_1', 'memory.md'), '# S\n## 规则\n' + Array.from({ length: 30 }, (_, i) => `- 会话规则${i} ${'字'.repeat(80)}`).join('\n') + '\n');
      const big = await memory.buildMemoryPartsAsync('P', 's_1', {});
      assert.match(big.rules, /（另有 \d+ 条规则在完整记忆里）/);
      assert.ok(big.rulesDropped > 0);
    } finally {
      process.env.HOME = prevHome; process.env.USERPROFILE = prevProfile;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('接线：记忆设置', () => {
  const R = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p.split('/')), 'utf8');
  test('「每轮都完整注入」默认关，间隔默认 8；记忆对话框里有开关、间隔、每层大小和上次完整注入是第几轮', () => {
    const app = R('renderer/App.tsx');
    assert.match(app, /memoryFullEveryTurn: false, memoryFullInterval: MEMORY_FULL_INTERVAL_DEFAULT/);
    assert.match(app, /merged\.memoryFullEveryTurn = merged\.memoryFullEveryTurn === true;/);
    assert.match(app, /settings=\{settings\}\s*onSettingsChange=\{handleSettingsChange\}/);
    const dlg = R('renderer/components/MemoryDialog.tsx');
    assert.match(dlg, /checked=\{fullEveryTurn\}/);
    assert.match(dlg, /memoryFullEveryTurn: e\.target\.checked/);
    assert.match(dlg, /memoryFullInterval: normalizeMemoryFullInterval\(interval \+ 1\)/);
    assert.match(dlg, /Size: global \{g\} · project \{p\} · this chat \{s\} chars/);
    assert.match(dlg, /Last full injection: turn \{n\}/);
    const main = R('main/index.ts');
    assert.match(main, /const injection = sessionId \? \(store\.readRecord\(sessionId\)\?\.lastMemoryInjection \?\? null\) : null;/);
  });
});
