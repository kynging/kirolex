import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { effortSelectFrom, findEffortOption, planEffortForModel, migrateComboEffort } from '../src/main/engineEffort.ts';
import { effortPickerView } from '../src/renderer/effortPick.ts';
import { AcpClient } from '../src/main/acp-client.ts';

/**
 * **effort（推理强度）单独一个下拉，放在模型下拉左边**（用户 2026-10-26：「不再放到 MCP 配置里面」）。
 *
 * 实测 effort 跟着模型走（docs/claude-code-feature-audit.md 1b）：Claude sonnet 有 default/low/medium/high/xhigh/max，
 * 换到 haiku 后 configOptions 里根本没有 effort 那一项；Codex 那一项是 `thought_level`：low/medium/high/xhigh/max。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf-8');
const opt = (v: string) => ({ value: v, name: v[0].toUpperCase() + v.slice(1) });
const CLAUDE_LEVELS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODE = { id: 'mode', category: 'mode', currentValue: 'default', options: [opt('default')] };
const claudeSonnet = [
  MODE,
  { id: 'model', category: 'model', currentValue: 'sonnet', options: ['default', 'sonnet', 'opus', 'haiku'].map(opt) },
  { id: 'effort', category: 'thought_level', currentValue: 'default', options: CLAUDE_LEVELS.map(opt) },
];
/* haiku：适配器给的 configOptions 里没有 effort 那一项 */
const claudeHaiku = [
  MODE,
  { id: 'model', category: 'model', currentValue: 'haiku', options: ['default', 'sonnet', 'opus', 'haiku'].map(opt) },
];
const codex = [
  { id: 'mode', category: 'mode', currentValue: 'auto', options: [opt('auto')] },
  { id: 'model', category: 'model', currentValue: 'gpt-5.5', options: [opt('gpt-5.5')] },
  { id: 'thought_level', currentValue: 'medium', options: CODEX_LEVELS.map(opt) },
];
const tt = (s: string, v?: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v?.[k] ?? `{${k}}`));

describe('从适配器 configOptions 认出 effort 那一项（按 category / id）', () => {
  test('Claude sonnet：id effort、category thought_level', () => {
    assert.equal(findEffortOption(claudeSonnet)?.id, 'effort');
    assert.deepEqual(effortSelectFrom(claudeSonnet), { current: 'default', options: CLAUDE_LEVELS.map(opt) });
  });
  test('Claude haiku：没有 effort 那一项 → null', () => {
    assert.equal(findEffortOption(claudeHaiku), undefined);
    assert.equal(effortSelectFrom(claudeHaiku), null);
  });
  test('Codex：只有 id thought_level（没写 category）也认得', () => {
    assert.deepEqual(effortSelectFrom(codex), { current: 'medium', options: CODEX_LEVELS.map(opt) });
  });
  test('Codex 老版本的 reasoning_effort（category thought_level）也认得；不会把 model / mode 认成 effort', () => {
    assert.equal(findEffortOption([{ id: 'reasoning_effort', category: 'thought_level', options: [] }])?.id, 'reasoning_effort');
    assert.equal(findEffortOption([{ id: 'reasoning_effort', options: [] }])?.id, 'reasoning_effort');
    assert.equal(findEffortOption([MODE, { id: 'model', category: 'model', options: [] }]), undefined);
    assert.equal(findEffortOption(null as unknown as unknown[]), undefined);
  });
  test('AcpClient 读 / 设 effort 用的就是这一项（Claude 的 id 是 effort）', async () => {
    const c: any = new AcpClient('default', {}, undefined, 'auto-approve', undefined, undefined, 'claude');
    c.noteConfigOptions(claudeSonnet);
    assert.deepEqual(c.selectOptions('thought_level'), effortSelectFrom(claudeSonnet));
    const sent: any[] = [];
    c.sendRequest = async (method: string, params: any) => { sent.push([method, params]); return { configOptions: claudeHaiku }; };
    await c.setSelectOption('s1', 'thought_level', 'high');
    assert.deepEqual(sent, [['session/set_config_option', { sessionId: 's1', configId: 'effort', value: 'high' }]]);
    assert.equal(c.selectOptions('thought_level'), null, '换成 haiku 的 configOptions 后就没有 effort 了');
  });
});

describe('effort 下拉：选项 / 当前值 / 禁用', () => {
  test('Claude sonnet：六档可选，当前值来自适配器', () => {
    const v = effortPickerView(effortSelectFrom(claudeSonnet), { connected: true }, tt);
    assert.equal(v.disabled, false);
    assert.equal(v.value, 'default');
    assert.deepEqual(v.options.map((o) => o.value), CLAUDE_LEVELS);
  });
  test('Claude haiku：禁用，提示「这个模型不支持调推理强度」，但下拉还在（不跳布局）', () => {
    const v = effortPickerView(effortSelectFrom(claudeHaiku), { connected: true }, tt);
    assert.equal(v.disabled, true);
    assert.equal(v.unsupported, true);
    assert.equal(v.title, 'This model does not support adjusting reasoning effort');
    assert.equal(v.options.length, 1, '留一项占位，下拉宽度不塌');
  });
  test('Codex：thought_level 五档', () => {
    const v = effortPickerView(effortSelectFrom(codex), { connected: true }, tt);
    assert.equal(v.disabled, false);
    assert.equal(v.value, 'medium');
    assert.deepEqual(v.options.map((o) => o.value), CODEX_LEVELS);
  });
  test('忙时选了的（pending）显示 pending 的那个；还没连上 / 正在切换时禁用但不说「不支持」', () => {
    assert.equal(effortPickerView(effortSelectFrom(codex), { connected: true, pending: 'high' }, tt).value, 'high');
    const off = effortPickerView(undefined, { connected: false }, tt);
    assert.equal(off.disabled, true);
    assert.equal(off.unsupported, false);
    assert.equal(effortPickerView(effortSelectFrom(codex), { connected: true, busy: true }, tt).disabled, true);
  });
  test('适配器报的当前值不在清单里：照实显示（不可选），不悄悄显示第一项', () => {
    const v = effortPickerView({ current: 'ultra', options: CODEX_LEVELS.map(opt) }, { connected: true }, tt);
    assert.equal(v.value, 'ultra');
    assert.equal(v.options[0].value, 'ultra');
    assert.equal(v.options[0].disabled, true);
  });
});

describe('换模型之后记住的 effort', () => {
  const sonnet = effortSelectFrom(claudeSonnet);
  test('没记过 → 什么都不做', () => {
    assert.deepEqual(planEffortForModel(undefined, sonnet), { kind: 'keep' });
  });
  test('新模型支持、适配器已经是它 → 不动；不是它 → 设回去', () => {
    assert.deepEqual(planEffortForModel('default', sonnet), { kind: 'keep' });
    assert.deepEqual(planEffortForModel('high', sonnet), { kind: 'set', value: 'high' });
  });
  test('新模型不支持这一档（Codex 没有 default）→ 退到新模型的默认值', () => {
    assert.deepEqual(planEffortForModel('default', effortSelectFrom(codex)), { kind: 'fallback', wanted: 'default', value: 'medium', setNeeded: false });
    assert.deepEqual(
      planEffortForModel('ultra', { current: 'max', options: CLAUDE_LEVELS.map(opt) }),
      { kind: 'fallback', wanted: 'ultra', value: 'default', setNeeded: true });
    /* 清单里既没有 default 也没有 medium：适配器换模型后报的当前值就是它的默认 */
    assert.deepEqual(
      planEffortForModel('max', { current: 'b', options: [opt('a'), opt('b')] }),
      { kind: 'fallback', wanted: 'max', value: 'b', setNeeded: false });
  });
  test('新模型根本没有 effort（haiku）→ unsupported（不硬设，硬设回 Internal error）', () => {
    assert.deepEqual(planEffortForModel('high', effortSelectFrom(claudeHaiku)), { kind: 'unsupported', wanted: 'high' });
    assert.deepEqual(planEffortForModel('high', { current: '', options: [] }), { kind: 'unsupported', wanted: 'high' });
  });
});

describe('MCP 配置里老的 effort：一次性迁进会话的 engineOptions，之后不再从组合读', () => {
  test('第一次：会话没记过 effort → 用组合的；打上已迁移标记', () => {
    const p = migrateComboEffort({ engine: 'claude' as const }, 'claude', 'high');
    assert.deepEqual(p, { engine: 'claude', comboEffortMigrated: true, engineOptions: { claude: { thought_level: 'high' } } });
  });
  test('会话自己记过 effort → 会话的赢，只打标记', () => {
    const p0 = { engine: 'codex' as const, engineOptions: { codex: { thought_level: 'low', mode: 'auto' } } };
    assert.deepEqual(migrateComboEffort(p0, 'codex', 'high'), { ...p0, comboEffortMigrated: true });
  });
  test('组合没写 effort → 只打标记，不写 thought_level', () => {
    assert.deepEqual(migrateComboEffort({}, 'claude', undefined), { comboEffortMigrated: true });
  });
  test('迁过一次之后：组合再写 effort（或换了带 effort 的组合）也不再读 —— 原样返回同一个对象', () => {
    const once = migrateComboEffort({}, 'claude', 'high');
    assert.equal(migrateComboEffort(once, 'claude', 'max'), once);
    const userCleared = { comboEffortMigrated: true as const };
    assert.equal(migrateComboEffort(userCleared, 'claude', 'max'), userCleared);
  });
  test('kiro 会话不受影响', () => {
    const k = { engine: 'kiro' as const };
    assert.equal(migrateComboEffort(k, 'kiro', 'high'), k);
  });
  test('接线：applyEngineModel 先迁移、再按会话记住的设；新会话建 profile 时就迁；load 白名单带上标记', () => {
    const M = read('src', 'main', 'index.ts');
    const fn = M.slice(M.indexOf('async function applyEngineModel('), M.indexOf('const retiringClients'));
    assert.ok(fn.indexOf('migrateComboEffort(') > 0 && fn.indexOf('migrateComboEffort(') < fn.indexOf('wantedEngineOptions(entry.profile)'));
    assert.doesNotMatch(fn, /applyComboEffort|wantedEngineOptions\(entry\.profile, combo/, '组合里的 effort 不再直接设');
    assert.match(fn, /if \(!entry\.profile\.comboEffortMigrated\) \{/, '迁过就不再读组合');
    assert.match(fn, /reconcileEffort\(sessionId, entry, engine/);
    assert.match(M, /function wantedEngineOptions\(profile: AgentProfile\)/);
    const create = M.slice(M.indexOf('const newCombo = defaultComboForNewSession('), M.indexOf("creations.stage(kiroLexId, 'check')"));
    assert.match(create, /migrateComboEffort\(/);
    assert.match(M, /\.\.\.\(existing\?\.profile\.comboEffortMigrated \? \{ comboEffortMigrated: true as const \} : \{\}\)/);
  });
  test('接线：换模型后按会话记住的 effort 重对一遍并在会话里说（不再看组合）', () => {
    const M = read('src', 'main', 'index.ts');
    const s = M.slice(M.indexOf('const setEngineOption = async'), M.indexOf("ipcMain.handle('acp:set-engine-model'"));
    assert.match(s, /if \(category === 'model'\) \{[\s\S]*?await reconcileEffort\(sessionId, entry, engine, \{ announce: true, model: value \}\)/);
    assert.doesNotMatch(s, /combo\.effort/);
  });
});

describe('界面：effort 下拉在模型下拉左边；组合旁不再说 effort', () => {
  const C = read('src', 'renderer', 'components', 'ChatArea.tsx');
  test('nonKiro 才有，紧挨在模型下拉前面，走 thought_level', () => {
    const effortAt = C.indexOf('className="composer-select composer-effort-select"');
    const modelAt = C.indexOf('className="composer-select composer-model-select"\n                      value={pendingSwitch?.engineModel');
    assert.ok(effortAt > 0 && modelAt > effortAt, 'effort 下拉在模型下拉左边');
    const between = C.slice(effortAt, modelAt);
    assert.match(between, /onEngineOptionChange\('thought_level'/);
    assert.match(C, /\{nonKiro && \(\(\) => \{\n\s+const ev = effortPickerView\(/);
  });
  test('组合下拉旁的「effort 暂不生效」和 effort 文案都去掉了', () => {
    assert.doesNotMatch(C, /comboEffortNote|composer-combo-effort-note/);
    assert.doesNotMatch(C, /取代原来的 effort 下拉/);
  });
});
