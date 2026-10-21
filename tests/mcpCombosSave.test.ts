import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveMcpCombos, readMcpCombos, mcpCombosPath } from '../src/main/mcpCombos.ts';

/**
 * 「组合那里明明写的投研，为什么显示是通用」—— 保存这条链路不能"看起来存了实际没存"。
 * 守的是三种失败（JSON 错、校验不过、写盘失败）都回 `{ ok: false, error }`、不抛、不留半个文件；
 * 成功时盘上读回来的就是刚存的那份。
 */
const good = JSON.stringify([{ id: 'research', name: '投研', mcpServers: {} }], null, 2);
const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
const PANE = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'McpCombosPane.tsx'), 'utf-8');

describe('保存组合：失败要明确报错', () => {
  let home = '';
  afterEach(() => { if (home) fs.rmSync(home, { recursive: true, force: true }); home = ''; });

  test('JSON 写错：不写盘，原因里说是 JSON 错', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-combos-save-'));
    const r = saveMcpCombos(home, '[{"id":"research",');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /JSON/);
    assert.equal(fs.existsSync(mcpCombosPath(home)), false);
  });

  test('校验不过（id 重复）：不写盘，原因里点名哪一条', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-combos-save-'));
    const r = saveMcpCombos(home, JSON.stringify([{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }]));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /重复/);
    assert.equal(fs.existsSync(mcpCombosPath(home)), false);
  });

  test('写盘失败（~/.kirolex 被一个同名文件占着）：回 ok:false 和原因，不抛', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-combos-save-'));
    fs.writeFileSync(path.join(home, '.kirolex'), 'not a dir');
    let r: ReturnType<typeof saveMcpCombos> | undefined;
    assert.doesNotThrow(() => { r = saveMcpCombos(home, good); });
    assert.equal(r?.ok, false);
    if (r && !r.ok) assert.match(r.error, /写不进|mcp-combos\.json/);
  });

  test('写盘失败（目标位置是个目录）：回 ok:false，不留 tmp 文件', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-combos-save-'));
    fs.mkdirSync(mcpCombosPath(home), { recursive: true });
    fs.writeFileSync(path.join(mcpCombosPath(home), 'x'), 'x');
    const r = saveMcpCombos(home, good);
    assert.equal(r.ok, false);
    assert.deepEqual(fs.readdirSync(path.dirname(mcpCombosPath(home))).filter((f) => f.endsWith('.tmp')), []);
  });

  test('成功：读回来就是刚存的那份，新组合在清单里', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-combos-save-'));
    const r = saveMcpCombos(home, good);
    assert.equal(r.ok, true);
    const back = readMcpCombos(home);
    assert.equal(back.text, good);
    assert.deepEqual(back.combos.map((c) => c.name), ['通用', '投研']);
  });
});

describe('保存组合：接线', () => {
  test('acp:save-mcp-combos 失败时记日志，并把原因交回编辑器', () => {
    const at = M.indexOf("ipcMain.handle('acp:save-mcp-combos'");
    assert.ok(at > 0);
    const body = M.slice(at, at + 800);
    assert.match(body, /if \(!r\.ok\) \{[^}]*logger\.warn\('mcp-combo'/);
    assert.match(body, /return \{ ok: false, error: r\.error \}/);
  });

  test('编辑器里 JSON 有错时按 Ctrl+S 不能什么都不发生', () => {
    assert.match(PANE, /if \(invalid\) \{ setStatus\(\{ ok: false/);
  });

  test('文件还不存在时编辑器明说「下面是样板、还没保存」', () => {
    assert.match(PANE, /!exists && !status/);
  });
});
