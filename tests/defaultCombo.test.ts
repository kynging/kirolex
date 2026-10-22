import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readGlobalDefaultCombo, writeGlobalDefaultCombo, resolveDefaultCombo, newSessionMcpCombo, defaultComboForNewSession,
} from '../src/main/defaultCombo.ts';
import { readProject, writeProject } from '../src/main/projectStore.ts';
import { mcpCombosPath } from '../src/main/mcpCombos.ts';

/**
 * 新会话默认组合 ——「帮我做一个默认通用的吧」：全局一个，项目可覆盖；本机没有那个组合时回退到内置「通用」。
 */
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-defcombo-'));
const cfgPath = (home: string) => path.join(home, '.kirolex', 'config.json');
const GENERAL_FILE = JSON.stringify([
  { id: 'general', name: '通用（带本机工具）', mcpServers: { 'builder-mcp': { command: 'builder-mcp', forwardFromLocal: true } } },
  { id: 'research', name: '投研', mcpServers: {} },
]);
const withCombos = (home: string) => {
  fs.mkdirSync(path.dirname(mcpCombosPath(home)), { recursive: true });
  fs.writeFileSync(mcpCombosPath(home), GENERAL_FILE);
};

describe('全局默认组合的读写', () => {
  test('没设过 = 空（内置通用）', () => {
    assert.equal(readGlobalDefaultCombo(cfgPath(tmpHome())), '');
  });

  test('写进去读出来一样，且不动 config.json 里别的配置', () => {
    const home = tmpHome();
    fs.mkdirSync(path.dirname(cfgPath(home)), { recursive: true });
    fs.writeFileSync(cfgPath(home), JSON.stringify({ remotes: [{ id: 'graviton' }], executorCap: 8 }));
    writeGlobalDefaultCombo(cfgPath(home), 'general');
    assert.equal(readGlobalDefaultCombo(cfgPath(home)), 'general');
    const cfg = JSON.parse(fs.readFileSync(cfgPath(home), 'utf-8'));
    assert.deepEqual(cfg.remotes, [{ id: 'graviton' }]);
    assert.equal(cfg.executorCap, 8);
  });

  test('改回内置通用 / 清空 = 删掉这个键', () => {
    const home = tmpHome();
    writeGlobalDefaultCombo(cfgPath(home), 'general');
    writeGlobalDefaultCombo(cfgPath(home), 'default');
    assert.equal('defaultMcpCombo' in JSON.parse(fs.readFileSync(cfgPath(home), 'utf-8')), false);
    writeGlobalDefaultCombo(cfgPath(home), 'general');
    writeGlobalDefaultCombo(cfgPath(home), '');
    assert.equal(readGlobalDefaultCombo(cfgPath(home)), '');
  });

  test('config.json 坏了：不写（不能按空对象把别的配置冲掉）', () => {
    const home = tmpHome();
    fs.mkdirSync(path.dirname(cfgPath(home)), { recursive: true });
    fs.writeFileSync(cfgPath(home), '{ "remotes": [');
    assert.throws(() => writeGlobalDefaultCombo(cfgPath(home), 'general'));
    assert.equal(fs.readFileSync(cfgPath(home), 'utf-8'), '{ "remotes": [');
  });

  test('不合法的 id 不写', () => {
    assert.throws(() => writeGlobalDefaultCombo(cfgPath(tmpHome()), '../x'));
  });
});

describe('该用哪个：项目 > 全局 > 内置通用', () => {
  const combos = [{ id: 'default' }, { id: 'general' }, { id: 'research' }];
  test('都没设 = 内置通用', () => {
    assert.deepEqual(resolveDefaultCombo(combos, '', undefined), { id: 'default', source: 'builtin' });
  });
  test('只设了全局', () => {
    assert.deepEqual(resolveDefaultCombo(combos, 'general', undefined), { id: 'general', source: 'global' });
  });
  test('项目覆盖全局', () => {
    assert.deepEqual(resolveDefaultCombo(combos, 'general', 'research'), { id: 'research', source: 'project' });
  });
  test('项目可以明确选内置通用（全局设了带工具的也不带）', () => {
    assert.deepEqual(resolveDefaultCombo(combos, 'general', 'default'), { id: 'default', source: 'project' });
  });
  test('设的那个本机没有：回退到内置通用，并说出是哪个', () => {
    assert.deepEqual(resolveDefaultCombo(combos, 'mac-only', undefined), { id: 'default', source: 'global', missing: 'mac-only' });
    /* 项目的找不到时也只回退到通用，不悄悄改用全局的 */
    assert.deepEqual(resolveDefaultCombo(combos, 'general', 'gone'), { id: 'default', source: 'project', missing: 'gone' });
  });
  test('写进 profile 的值：内置通用 = 不写', () => {
    assert.equal(newSessionMcpCombo({ id: 'default', source: 'builtin' }), undefined);
    assert.equal(newSessionMcpCombo({ id: 'general', source: 'global' }), 'general');
  });
});

describe('自建通用顶替内置那条时', () => {
  test('设的是它原来的 id（general）：算有，不报 missing；新会话解析到那条带 MCP 的', async () => {
    const { pickCombo, readMcpCombos } = await import('../src/main/mcpCombos.ts');
    const home = tmpHome();
    withCombos(home);
    const { combos } = readMcpCombos(home);
    assert.deepEqual(combos.map((c) => c.id), ['default', 'research']);
    assert.deepEqual(resolveDefaultCombo(combos, 'general', undefined), { id: 'general', source: 'global' });
    for (const g of ['general', 'default', '']) {
      writeGlobalDefaultCombo(cfgPath(home), g);
      const r = defaultComboForNewSession({ home, configPath: cfgPath(home), engine: 'claude' });
      assert.equal(r.missing, undefined);
      assert.deepEqual(Object.keys(pickCombo(combos, r.mcpCombo).mcpServers), ['builder-mcp']);
    }
  });
});

describe('项目覆盖存在 project.json 里', () => {
  test('写默认组合不冲掉工作目录，改工作目录也不冲掉默认组合', () => {
    const home = tmpHome();
    writeProject(home, 'kirolex', { workspace: '/tmp' });
    writeProject(home, 'kirolex', { defaultMcpCombo: 'general' });
    assert.deepEqual(readProject(home, 'kirolex'), { workspace: '/tmp', defaultMcpCombo: 'general' });
    writeProject(home, 'kirolex', { workspace: '' });
    assert.deepEqual(readProject(home, 'kirolex'), { defaultMcpCombo: 'general' });
    writeProject(home, 'kirolex', { defaultMcpCombo: '' });
    assert.deepEqual(readProject(home, 'kirolex'), {});
  });
});

describe('新建会话按默认组合填 profile.mcpCombo', () => {
  test('Claude Code / Codex：用全局默认', () => {
    const home = tmpHome();
    withCombos(home);
    writeGlobalDefaultCombo(cfgPath(home), 'general');
    for (const engine of ['claude', 'codex']) {
      const r = defaultComboForNewSession({ home, configPath: cfgPath(home), engine });
      assert.equal(r.mcpCombo, 'general', engine);
    }
  });

  test('kiro 会话没有组合，不填', () => {
    const home = tmpHome();
    withCombos(home);
    writeGlobalDefaultCombo(cfgPath(home), 'general');
    assert.equal(defaultComboForNewSession({ home, configPath: cfgPath(home), engine: 'kiro' }).mcpCombo, undefined);
  });

  test('项目覆盖：这个项目里的新会话用项目选的', () => {
    const home = tmpHome();
    withCombos(home);
    writeGlobalDefaultCombo(cfgPath(home), 'general');
    writeProject(home, '投研', { defaultMcpCombo: 'research' });
    assert.equal(defaultComboForNewSession({ home, configPath: cfgPath(home), engine: 'claude', projectId: '投研' }).mcpCombo, 'research');
    assert.equal(defaultComboForNewSession({ home, configPath: cfgPath(home), engine: 'claude', projectId: '别的' }).mcpCombo, 'general');
  });

  test('组合文件不存在：回退到内置通用，带 missing', () => {
    const home = tmpHome();
    writeGlobalDefaultCombo(cfgPath(home), 'general');
    const r = defaultComboForNewSession({ home, configPath: cfgPath(home), engine: 'claude' });
    assert.equal(r.mcpCombo, undefined);
    assert.equal(r.missing, 'general');
  });

  test('acp:new-session 真的调了它，并且只在建 profile 时（已有会话不动）', () => {
    const main = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
    const at = main.indexOf("ipcMain.handle('acp:new-session'");
    const body = main.slice(at, main.indexOf('ipcMain.handle(', at + 10));
    assert.match(body, /defaultComboForNewSession\(/);
    assert.match(body, /mcpCombo: newCombo\.mcpCombo/);
    assert.equal((main.match(/defaultComboForNewSession\(/g) || []).length, 1);
  });
});

describe('组合编辑器：示例和真实内容分得清', () => {
  const PANE = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'McpCombosPane.tsx'), 'utf-8');
  const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');

  test('示例本身能通过校验，第一条写 id default、替换内置「通用」、用了 forwardFromLocal', async () => {
    const { MCP_COMBOS_TEMPLATE, parseMcpCombos } = await import('../src/main/mcpCombos.ts');
    assert.match(MCP_COMBOS_TEMPLATE, /"id": "default",\s*"name": "通用"/);
    const r = parseMcpCombos(MCP_COMBOS_TEMPLATE);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.combos.map((c) => c.id), ['default', 'research']);
    assert.equal(r.combos[0].name, '通用');
    assert.equal(Object.values(r.combos[0].mcpServers).some((s) => s.forwardFromLocal === true), true);
  });

  test('文件不存在时 main 给的内容是空的，示例单独给', () => {
    const at = MAIN.indexOf("ipcMain.handle('acp:mcp-combos-file'");
    const body = MAIN.slice(at, MAIN.indexOf('});', at));
    assert.match(body, /text: r\.exists \? r\.text : ''/);
    assert.match(body, /template: MCP_COMBOS_TEMPLATE/);
  });

  test('编辑器：文件不存在、也没插入示例时显示「还没有自定义组合」+「插入示例」，不把示例当内容', () => {
    assert.match(PANE, /No custom combos yet/);
    assert.match(PANE, /Insert example/);
    assert.match(PANE, /setContent\(formatJsonOnOpen\(template\)\)/);
  });
});

describe('本地新会话：默认组合里的 MCP 在 session/new 时就交出去', () => {
  test('acp:new-session 的本地分支带上 localComboTools（和重连同一条）', () => {
    const main = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
    const at = main.indexOf("ipcMain.handle('acp:new-session'");
    const body = main.slice(at, main.indexOf('ipcMain.handle(', at + 10));
    assert.match(body, /: await withLocalBrowser\(kiroLexId, localComboTools\(kiroLexId, profile\)\)/);
  });
});
