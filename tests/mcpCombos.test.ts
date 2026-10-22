import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_COMBO, BUILTIN_COMBO_ID, parseMcpCombos, readMcpCombos, saveMcpCombos, mcpCombosPath, pickCombo, findCombo, findGeneralLikeCombo, comboDisplayName,
  buildAcpMcpServers, expandEnvRefs, maskAcpServers, planComboEffort, applyComboEffort, defaultEffort,
} from '../src/main/mcpCombos.ts';

/**
 * Claude Code / Codex 的「组合」——不同对话挂不同的 MCP（普通对话不挂，投研对话挂妙想）。
 * 守的是：文件的解析和校验（校验不过要给人看得懂的原因）、交给 ACP 的 mcpServers 长什么样、
 * effort 不支持时退回默认而不是报错。
 */
const sample = [
  {
    id: 'research', name: '投研', effort: 'high',
    mcpServers: {
      miaoxiang: { url: 'https://mx.example.com/mcp', headers: { Authorization: 'Bearer ${env:MX_KEY}' }, timeoutSec: 60 },
      local: { command: 'node', args: ['srv.js'], env: { TOKEN: '${env:LOCAL_TOKEN}', MODE: 'x' } },
      off: { url: 'https://off.example.com', disabled: true },
    },
  },
];

describe('组合文件解析和校验', () => {
  test('内置「通用」永远排第一，没有 MCP、不设 effort', () => {
    const r = parseMcpCombos(JSON.stringify(sample));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.combos[0].id, BUILTIN_COMBO_ID);
    assert.equal(r.combos[0].name, '通用');
    assert.equal(r.combos[0].effort, undefined);
    assert.deepEqual(r.combos[0].mcpServers, {});
    assert.equal(r.combos[1].name, '投研');
    assert.equal(r.combos[1].effort, 'high');
  });

  test('不是 JSON → 说清楚是 JSON 写错了', () => {
    const r = parseMcpCombos('[{');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /JSON/);
  });

  /*
    报错原因会进日志（本地会话重连时 index.ts 把它 logger.warn 出去），而 V8 的 JSON.parse 报错会把出错附近的
    原文整段带出来 —— headers / env 的值正好就在那儿。所以原因里只许有行列，不许有配置原文。
  */
  test('JSON 写错时原因里只有行列，**不带 headers / env 里的密钥**', () => {
    const cases = [
      '[{"id":"a","name":"A","mcpServers":{"x":{"url":"https://a","headers":{"Authorization":S3CRET-hdr}}}}]',
      '[\n  {"id":"a","name":"A","mcpServers":{"x":{"command":"node","env":{"TOKEN": S3CRET-env }}}}\n]',
      '[{"id":"a","name":"A","mcpServers":{"x":{"url":"https://a","headers":{"Authorization":"Bearer S3CRET-cut',
      '[{"id":"a","name":"A","mcpServers":{"x":{"url":"https://a","headers":{"Authorization":"Bearer S3CRET-x" "B":"1"}}}}]',
    ];
    for (const text of cases) {
      const r = parseMcpCombos(text);
      assert.equal(r.ok, false);
      if (r.ok) continue;
      assert.doesNotMatch(r.error, /S3CRET/, r.error);
      assert.match(r.error, /JSON/);
    }
  });

  test('JSON 语法错误给出准确的行列', () => {
    const r = parseMcpCombos('[\n  {"id": x}\n]');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /第 2 行第 10 列/);
    const cut = parseMcpCombos('[{"id":"a"');
    assert.equal(cut.ok, false);
    if (!cut.ok) assert.match(cut.error, /没写完/);
  });

  test('写错的 ${env:…} 引用：原因里不回显引用里写的东西', () => {
    const r = parseMcpCombos(JSON.stringify([{ id: 'a', name: 'A', mcpServers: { x: { url: 'https://a', headers: { A: 'Bearer ${env:S3CRET-value}' } } } }]));
    assert.equal(r.ok, false);
    if (!r.ok) { assert.doesNotMatch(r.error, /S3CRET/); assert.match(r.error, /env/); }
  });

  test('顶层不是列表 → 拒绝', () => {
    const r = parseMcpCombos('{"id":"a"}');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /列表/);
  });

  test('id 重复、名字缺失、和内置通用重名都拒绝，并指出是第几个', () => {
    const dup = parseMcpCombos(JSON.stringify([{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }]));
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.match(dup.error, /第 2 个.*重复/);
    const noName = parseMcpCombos(JSON.stringify([{ id: 'a' }]));
    assert.equal(noName.ok, false);
    if (!noName.ok) assert.match(noName.error, /name/);
    /* id default 不再是保留的：它取代内置「通用」（见下面「自建通用顶替内置那条」） */
    const override = parseMcpCombos(JSON.stringify([{ id: BUILTIN_COMBO_ID, name: 'X' }]));
    assert.equal(override.ok, true);
    /* 只有一条叫「通用」时它顶替内置那条（自建通用）；两条都像通用时不迁移，和内置「通用」重名照样拒绝 */
    const sameName = parseMcpCombos(JSON.stringify([{ id: 'a', name: '通用' }, { id: 'b', name: 'B通用' }, { id: 'c', name: '通用 2' }]));
    assert.equal(sameName.ok, false);
  });

  test('MCP 条目：既有 url 又有 command、两个都没有、类型不对，都拒绝并点名那一条', () => {
    const both = parseMcpCombos(JSON.stringify([{ id: 'a', name: 'A', mcpServers: { x: { url: 'https://a', command: 'node' } } }]));
    assert.equal(both.ok, false);
    if (!both.ok) assert.match(both.error, /「x」/);
    const none = parseMcpCombos(JSON.stringify([{ id: 'a', name: 'A', mcpServers: { x: {} } }]));
    assert.equal(none.ok, false);
    const badUrl = parseMcpCombos(JSON.stringify([{ id: 'a', name: 'A', mcpServers: { x: { url: 'ftp://a' } } }]));
    assert.equal(badUrl.ok, false);
    const badHeader = parseMcpCombos(JSON.stringify([{ id: 'a', name: 'A', mcpServers: { x: { url: 'https://a', headers: { A: 1 } } } }]));
    assert.equal(badHeader.ok, false);
    const badArgs = parseMcpCombos(JSON.stringify([{ id: 'a', name: 'A', mcpServers: { x: { command: 'node', args: 'a b' } } }]));
    assert.equal(badArgs.ok, false);
    const badFlag = parseMcpCombos(JSON.stringify([{ id: 'a', name: 'A', mcpServers: { x: { command: 'node', disabled: 'yes' } } }]));
    assert.equal(badFlag.ok, false);
    const badTimeout = parseMcpCombos(JSON.stringify([{ id: 'a', name: 'A', mcpServers: { x: { url: 'https://a', timeoutSec: -1 } } }]));
    assert.equal(badTimeout.ok, false);
    const typeMismatch = parseMcpCombos(JSON.stringify([{ id: 'a', name: 'A', mcpServers: { x: { type: 'stdio', url: 'https://a' } } }]));
    assert.equal(typeMismatch.ok, false);
  });

  test('写错的 ${env:…} 引用在校验时就拦下', () => {
    const r = parseMcpCombos(JSON.stringify([{ id: 'a', name: 'A', mcpServers: { x: { url: 'https://a', headers: { A: '${env:}' } } } }]));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /env/);
  });

  test('pickCombo：找不到 / 没选 → 通用', () => {
    const r = parseMcpCombos(JSON.stringify(sample));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(pickCombo(r.combos, 'research').name, '投研');
    assert.equal(pickCombo(r.combos, undefined).id, BUILTIN_COMBO_ID);
    assert.equal(pickCombo(r.combos, 'gone').id, BUILTIN_COMBO_ID);
  });
});

describe('读写 ~/.kirolex/mcp-combos.json（临时目录）', () => {
  let home = '';
  afterEach(() => { if (home) fs.rmSync(home, { recursive: true, force: true }); home = ''; });

  test('文件不存在 = 只有「通用」', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-combos-'));
    const r = readMcpCombos(home);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.combos.map((c) => c.id), [BUILTIN_COMBO_ID]);
  });

  test('保存前校验：不合格不写盘，合格才写', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-combos-'));
    const bad = saveMcpCombos(home, '[{"id":"a"}]');
    assert.equal(bad.ok, false);
    assert.equal(fs.existsSync(mcpCombosPath(home)), false);
    const good = saveMcpCombos(home, JSON.stringify(sample, null, 2));
    assert.equal(good.ok, true);
    assert.equal(readMcpCombos(home).combos[1].name, '投研');
  });

  test('盘上的文件坏了：退回只有「通用」，并带上原因', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-combos-'));
    fs.mkdirSync(path.dirname(mcpCombosPath(home)), { recursive: true });
    fs.writeFileSync(mcpCombosPath(home), 'not json');
    const r = readMcpCombos(home);
    assert.deepEqual(r.combos.map((c) => c.id), [BUILTIN_COMBO_ID]);
    assert.match(r.error || '', /JSON/);
  });

  test('盘上的文件里密钥写坏了：读出来的原因（会进日志）不带密钥', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-combos-'));
    fs.mkdirSync(path.dirname(mcpCombosPath(home)), { recursive: true });
    fs.writeFileSync(mcpCombosPath(home), '[{"id":"a","name":"A","mcpServers":{"x":{"url":"https://a","headers":{"Authorization":S3CRET}}}}]');
    const r = readMcpCombos(home);
    assert.ok(r.error);
    assert.doesNotMatch(r.error || '', /S3CRET/);
  });
});

describe('ACP mcpServers 生成', () => {
  const combos = (() => { const r = parseMcpCombos(JSON.stringify(sample)); assert.ok(r.ok); return r.ok ? r.combos : []; })();

  test('http / stdio 按 ACP 格式，环境变量展开，disabled 的跳过', () => {
    const { servers, skipped } = buildAcpMcpServers(combos[1], { MX_KEY: 'k1', LOCAL_TOKEN: 't1' });
    assert.deepEqual(skipped, []);
    assert.deepEqual(servers, [
      { type: 'http', name: 'miaoxiang', url: 'https://mx.example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer k1' }] },
      { name: 'local', command: 'node', args: ['srv.js'], env: [{ name: 'TOKEN', value: 't1' }, { name: 'MODE', value: 'x' }] },
    ]);
  });

  test('环境变量缺失：跳过这一条并说出缺哪个，其余照挂', () => {
    const { servers, skipped } = buildAcpMcpServers(combos[1], { LOCAL_TOKEN: 't1' });
    assert.deepEqual(servers.map((s) => s.name), ['local']);
    assert.deepEqual(skipped, [{ name: 'miaoxiang', missing: ['MX_KEY'] }]);
  });

  test('「通用」什么都不挂', () => {
    assert.deepEqual(buildAcpMcpServers(combos[0], {}).servers, []);
  });

  test('forwardFromLocal 在本地会话里不起作用（照样挂）', () => {
    const r = parseMcpCombos(JSON.stringify([{ id: 'a', name: 'A', mcpServers: { x: { url: 'https://a', forwardFromLocal: true } } }]));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(buildAcpMcpServers(r.combos[1], {}).servers, [{ type: 'http', name: 'x', url: 'https://a', headers: [] }]);
  });

  test('expandEnvRefs：多处引用、空字符串算有', () => {
    assert.deepEqual(expandEnvRefs('${env:A}-${env:B}', { A: '1', B: '' }), { value: '1-', missing: [] });
    assert.deepEqual(expandEnvRefs('${env:A}${env:C}', { A: '1' }), { value: '1', missing: ['C'] });
  });

  test('日志里 headers / env 的值打码', () => {
    const { servers } = buildAcpMcpServers(combos[1], { MX_KEY: 'secret-k', LOCAL_TOKEN: 'secret-t' });
    const text = JSON.stringify(maskAcpServers(servers));
    assert.doesNotMatch(text, /secret/);
    assert.match(text, /Authorization/);
    assert.match(text, /TOKEN/);
    /* 原对象不能被改 —— 真正交给适配器的还得是明文 */
    assert.match(JSON.stringify(servers), /secret-k/);
  });
});

describe('effort：组合设了 effort 时怎么设', () => {
  const opts = { current: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] };

  test('支持 → 设成它', () => {
    assert.deepEqual(planComboEffort('high', opts), { apply: true });
  });

  test('当前引擎 / 模型不支持这个值 → 不设（退回默认档位）并给一句提示', () => {
    const r = planComboEffort('xhigh', opts);
    assert.equal(r.apply, false);
    assert.match(r.notice || '', /xhigh/);
  });

  test('引擎根本没有 effort 选项 → 同样退回并提示，不报错', () => {
    const r = planComboEffort('high', null);
    assert.equal(r.apply, false);
    assert.ok(r.notice);
  });
});

/** 假的适配器 effort 清单：记下每次 set，`reject` 里的值 set 时抛错（模拟适配器拒绝） */
function fakeEffort(current: string, values: string[], reject: string[] = []) {
  const state = { current, sets: [] as string[] };
  return {
    state,
    io: {
      options: () => ({ current: state.current, options: values.map((v) => ({ value: v, name: v })) }),
      set: async (v: string) => {
        state.sets.push(v);
        if (reject.includes(v)) throw new Error(`rejected ${v}`);
        state.current = v;
      },
    },
  };
}
const CLAUDE_LEVELS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_LEVELS = ['low', 'medium', 'high', 'xhigh'];

describe('effort：设不上时主动退回默认档位（applyComboEffort）', () => {
  test('支持 → 设成它，不提示', async () => {
    const f = fakeEffort('default', CLAUDE_LEVELS);
    assert.deepEqual(await applyComboEffort('high', '投研', f.io), { value: 'high' });
    assert.equal(f.state.current, 'high');
  });

  test('已经是这个值 → 不重复 set', async () => {
    const f = fakeEffort('high', CLAUDE_LEVELS);
    assert.deepEqual(await applyComboEffort('high', '投研', f.io), { value: 'high' });
    assert.deepEqual(f.state.sets, []);
  });

  test('**加载会话带着旧档位**（上次是 max）+ 组合要的不支持 → 主动设回默认档位，不沿用旧的', async () => {
    const f = fakeEffort('max', CLAUDE_LEVELS);
    const r = await applyComboEffort('ultra', '投研', f.io);
    assert.equal(f.state.current, 'default');
    assert.equal(r.value, 'default');
    assert.match(r.notice || '', /ultra/);
    assert.match(r.notice || '', /已退回默认档位「default」/);
  });

  test('Codex 没有 default 这一项：退回 medium（它自己的默认）', async () => {
    const f = fakeEffort('xhigh', CODEX_LEVELS);
    const r = await applyComboEffort('max', '投研', f.io);
    assert.equal(f.state.current, 'medium');
    assert.match(r.notice || '', /medium/);
  });

  test('**适配器拒绝了 set** → 不报错，退回默认档位，并提示（带上拒绝原因）', async () => {
    const f = fakeEffort('max', CLAUDE_LEVELS, ['high']);
    const r = await applyComboEffort('high', '投研', f.io);
    assert.deepEqual(f.state.sets, ['high', 'default']);
    assert.equal(f.state.current, 'default');
    assert.match(r.notice || '', /没设上（rejected high）/);
    assert.match(r.notice || '', /已退回默认档位「default」/);
  });

  test('退回默认档位也被拒绝 → 不抛错，说清楚保持当前档位', async () => {
    const f = fakeEffort('max', CLAUDE_LEVELS, ['high', 'default']);
    const r = await applyComboEffort('high', '投研', f.io);
    assert.equal(r.value, undefined);
    assert.match(r.notice || '', /也没成功/);
    assert.match(r.notice || '', /保持当前档位「max」/);
  });

  test('引擎根本没有 effort 选项 → 不抛错，提示一句', async () => {
    const r = await applyComboEffort('high', '投研', { options: () => null, set: async () => { throw new Error('不该调'); } });
    assert.match(r.notice || '', /没有可以退回的默认档位/);
  });

  test('defaultEffort：default 优先，其次 medium，都没有就不猜', () => {
    assert.equal(defaultEffort({ current: '', options: CLAUDE_LEVELS.map((v) => ({ value: v, name: v })) }), 'default');
    assert.equal(defaultEffort({ current: '', options: CODEX_LEVELS.map((v) => ({ value: v, name: v })) }), 'medium');
    assert.equal(defaultEffort({ current: '', options: [{ value: 'a', name: 'a' }] }), undefined);
    assert.equal(defaultEffort(null), undefined);
  });
});

describe('接线（源码扫描）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');

  test('本地会话走 localComboTools；kiro 不挂；日志打码', () => {
    /* 本地会话外面再包一层 kirolex-local（定时 / 后台命令，见 withLocalBrowser），组合里的 MCP 仍由 localComboTools 给 */
    assert.match(M, /if \(!remote\?\.sshHost\) return withLocalBrowser\(sessionId, localComboTools\(sessionId, profile\)\);/);
    const fn = M.slice(M.indexOf('function localComboTools('), M.indexOf('async function ensureLocalTools('));
    assert.match(fn, /if \(engineOf\(profile\) === 'kiro'\) return undefined;/);
    assert.match(fn, /maskAcpServers\(servers\)/);
    assert.doesNotMatch(fn, /JSON\.stringify\(servers\)/, '明文不许进日志');
  });

  test('重连（attach）时本地会话也备一次组合里的 MCP', () => {
    assert.match(M, /\} else \{\s*\/\*[^*]*「组合」[^*]*\*\/\s*localTools = await ensureLocalTools\(sessionId, profile, resolvedCwd\);/);
  });

  test('effort：连上之后按组合设，不支持就退回并提示', () => {
    const fn = M.slice(M.indexOf('async function applyEngineModel('), M.indexOf('function wireSession('));
    assert.match(fn, /applyComboEffort\(combo\.effort, combo\.name, \{/);
    assert.match(fn, /if \(r\.notice\) sessionNotice\(sessionId, r\.notice\);/);
  });

  test('换组合：回复中不拒绝、记成 pending 跑完再换（pendingSwitch.ts），先起新的再断旧的', () => {
    /* 实现抽成了 switchMcpComboImpl（忙时记下的切换跑完后也走它） */
    const h = M.slice(M.indexOf('const switchMcpComboImpl = async'));
    assert.match(h.slice(0, 2000), /queueSwitchWhileBusy\(sessionId, 'combo'/);
    assert.ok(h.indexOf('client.newSession(') < h.indexOf('retireExecutor(oldEntry.client)'));
  });
});

describe('自建「通用」顶替内置那条（下拉只留一条通用）', () => {
  const MINE = {
    'builder-mcp': { command: '/Users/x/.toolbox/bin/builder-mcp', forwardFromLocal: true },
    'agentcore-websearch': { type: 'stdio', command: '/Users/x/.local/bin/mcp-proxy-for-aws', args: ['a'], forwardFromLocal: true },
    context7: { url: 'https://mcp.context7.com/mcp' },
  };
  const parse = (list: unknown[]) => {
    const r = parseMcpCombos(JSON.stringify(list));
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    return r.ok ? r.combos : [];
  };

  test('判据（纯函数）：id general 或名字以「通用」/ General 开头；只认恰好一条', () => {
    assert.equal(findGeneralLikeCombo([{ id: 'research', name: '投研' }]), -1);
    assert.equal(findGeneralLikeCombo([{ id: 'research', name: '投研' }, { id: 'general', name: 'X' }]), 1);
    assert.equal(findGeneralLikeCombo([{ id: 'mine', name: '通用（带本机工具）' }]), 0);
    assert.equal(findGeneralLikeCombo([{ id: 'mine', name: 'General (local tools)' }]), 0);
    assert.equal(findGeneralLikeCombo([{ id: 'general', name: 'A' }, { id: 'b', name: '通用2' }]), -1);
    assert.equal(findGeneralLikeCombo([null, 'x', { id: 'research', name: '投研' }]), -1);
  });

  test('① 没有 default 也没有通用写法：内置在第一，和以前一样', () => {
    const combos = parse([{ id: 'research', name: '投研' }]);
    assert.equal(combos[0], BUILTIN_COMBO);
    assert.deepEqual(combos.map((c) => c.id), [BUILTIN_COMBO_ID, 'research']);
  });

  test('② id default：取代内置、不报错，排第一；不写 name 显示「通用」', () => {
    const combos = parse([{ id: 'research', name: '投研' }, { id: 'default', name: '我的通用', mcpServers: MINE }]);
    assert.deepEqual(combos.map((c) => c.id), [BUILTIN_COMBO_ID, 'research']);
    assert.equal(combos[0].name, '我的通用');
    assert.equal(comboDisplayName(combos[0]), '我的通用');
    assert.deepEqual(Object.keys(combos[0].mcpServers), Object.keys(MINE));
    const noName = parse([{ id: 'default', mcpServers: MINE }]);
    assert.equal(noName.length, 1);
    assert.equal(comboDisplayName(noName[0]), '通用');
    /* 内置那条仍是 default，名字照旧 */
    assert.equal(BUILTIN_COMBO.id, 'default');
    assert.equal(comboDisplayName(BUILTIN_COMBO), '通用');
  });

  test('② 有覆盖时，别的条目也可以叫「通用」以外的名字；名字和覆盖条目重复照样报', () => {
    const r = parseMcpCombos(JSON.stringify([{ id: 'default', name: 'A' }, { id: 'b', name: 'A' }]));
    assert.equal(r.ok, false);
  });

  test('③ id general 名为「通用（带本机工具）」：当作通用，下拉只一条', () => {
    const combos = parse([{ id: 'general', name: '通用（带本机工具）', mcpServers: MINE }, { id: 'research', name: '投研' }]);
    assert.deepEqual(combos.map((c) => c.id), [BUILTIN_COMBO_ID, 'research']);
    assert.equal(comboDisplayName(combos[0]), '通用（带本机工具）');
    assert.deepEqual(combos[0].aliases, ['general']);
  });

  test('④ 两条都像通用：不迁移，维持现状', () => {
    const combos = parse([{ id: 'general', name: '通用（带本机工具）' }, { id: 'g2', name: 'General 2' }]);
    assert.deepEqual(combos.map((c) => c.id), [BUILTIN_COMBO_ID, 'general', 'g2']);
    assert.equal(combos[0], BUILTIN_COMBO);
  });

  test('⑤ default 写两次：报重复', () => {
    const r = parseMcpCombos(JSON.stringify([{ id: 'default', name: 'A' }, { id: 'default', name: 'B' }]));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /第 2 个.*重复/);
  });

  test('有 default 时不再迁移 general（两条都留）', () => {
    const combos = parse([{ id: 'default', name: 'A' }, { id: 'general', name: '通用（带本机工具）' }]);
    assert.deepEqual(combos.map((c) => c.id), [BUILTIN_COMBO_ID, 'general']);
    assert.equal(combos[0].name, 'A');
  });

  test('会话记着 general / default / 什么都没记：②③下解析到同一条，mcpServers 是文件里那几条', () => {
    for (const list of [
      [{ id: 'default', name: '通用', mcpServers: MINE }, { id: 'research', name: '投研' }],
      [{ id: 'general', name: '通用（带本机工具）', mcpServers: MINE }, { id: 'research', name: '投研' }],
    ]) {
      const combos = parse(list);
      const picks = ['general', 'default', undefined].map((id) => pickCombo(combos, id));
      for (const p of picks) {
        assert.equal(p, combos[0]);
        assert.deepEqual(Object.keys(p.mcpServers), ['builder-mcp', 'agentcore-websearch', 'context7']);
      }
      assert.equal(findCombo(combos, 'research')?.id, 'research');
    }
    /* ② 下没有 general 这条：记着 general 的会话找不到（按通用跑），不是同一条的别名 */
    const over = parse([{ id: 'default', name: '通用', mcpServers: MINE }]);
    assert.equal(findCombo(over, 'general'), undefined);
  });

  test('读盘不改写文件本身', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-combo-general-'));
    const text = JSON.stringify([{ id: 'general', name: '通用（带本机工具）', mcpServers: MINE }]);
    fs.mkdirSync(path.dirname(mcpCombosPath(home)), { recursive: true });
    fs.writeFileSync(mcpCombosPath(home), text);
    const r = readMcpCombos(home);
    assert.equal(r.combos.length, 1);
    assert.equal(fs.readFileSync(mcpCombosPath(home), 'utf-8'), text);
  });
});
