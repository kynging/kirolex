import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { comboSelectView, defaultComboOptions } from '../src/renderer/comboPick.ts';
import { t as tr } from '../src/renderer/i18n.ts';

/**
 * 会话记住的组合 id 在本机找不到时（台式机上建的、或者被删了），下拉不能悄悄显示「通用」——
 * 要明说「组合「<id>」在本机不存在，已按通用运行」。
 */
const zh = (k: string, v?: Record<string, string | number>) => tr('zh', k, v);
const list = (over: Partial<{ current: string; missing: string; error: string }> = {}) => ({
  combos: [{ id: 'default', name: '通用' }, { id: 'coding', name: '写代码' }], current: 'default', ...over,
});
const C = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf-8');

describe('组合下拉显示', () => {
  test('id 找得到：显示它，没有额外提示', () => {
    const v = comboSelectView(list({ current: 'coding' }), undefined, zh);
    assert.equal(v.value, 'coding');
    assert.equal(v.missing, undefined);
  });

  test('id 在本机不存在：选中一条明说的提示项，而不是「通用」', () => {
    const v = comboSelectView(list({ missing: 'research' }), undefined, zh);
    assert.equal(v.value, 'research');
    assert.equal(v.missing?.label, '组合「research」在本机不存在，已按通用运行');
  });

  test('组合文件有错时：说是读不到（文件有错），不说「不存在」', () => {
    const v = comboSelectView(list({ missing: 'research', error: 'JSON 写错了' }), undefined, zh);
    assert.equal(v.missing?.label, '组合「research」读不到（组合文件有错），已按通用运行');
  });

  test('有待应用的切换时显示那一个，不显示缺失提示', () => {
    const v = comboSelectView(list({ missing: 'research' }), 'coding', zh);
    assert.equal(v.value, 'coding');
    assert.equal(v.missing, undefined);
  });

  test('清单还没拉到：显示通用', () => {
    assert.equal(comboSelectView(null, undefined, zh).value, 'default');
  });

  test('ChatArea 的下拉用它，并把提示项渲染成不可选的 option', () => {
    assert.match(C, /comboSelectView\(mcpCombos, pendingSwitch\?\.combo, t\)/);
    assert.match(C, /<option value=\{comboView\.missing\.id\} disabled>/);
  });
});

describe('「新会话默认组合」下拉', () => {
  const info = (over: Partial<{ global: string; project: string; error: string }> = {}) => ({
    combos: [{ id: 'default', name: '通用' }, { id: 'general', name: '通用（带本机工具）' }], global: '', ...over,
  });
  const sel = (opts: Array<{ value: string; selected: boolean }>) => opts.filter((o) => o.selected).map((o) => o.value);

  test('全局没设：选中内置通用', () => {
    assert.deepEqual(sel(defaultComboOptions(info(), 'global', zh)), ['default']);
  });
  test('全局设了带本机工具的那个：选中它', () => {
    assert.deepEqual(sel(defaultComboOptions(info({ global: 'general' }), 'global', zh)), ['general']);
  });
  test('设的那个本机没有：选中一条不可选的提示项，明说按通用', () => {
    const opts = defaultComboOptions(info({ global: 'mac-only' }), 'global', zh);
    const last = opts[opts.length - 1];
    assert.deepEqual(sel(opts), ['mac-only']);
    assert.equal(last.disabled, true);
    assert.equal(last.label, '组合「mac-only」在本机不存在，新会话按通用');
  });
  test('组合文件有错：说读不到，不说不存在', () => {
    const opts = defaultComboOptions({ combos: [{ id: 'default', name: '通用' }], global: 'general', error: 'x' }, 'global', zh);
    assert.equal(opts[opts.length - 1].label, '组合「general」读不到（组合文件有错），新会话按通用');
  });
  test('项目：第一项是「跟随全局（全局那个的名字）」，没覆盖时选中它', () => {
    const opts = defaultComboOptions(info({ global: 'general', project: '' }), 'project', zh);
    assert.equal(opts[0].label, '跟随全局（通用（带本机工具））');
    assert.deepEqual(sel(opts), ['']);
  });
  test('项目覆盖了：选中覆盖的那个', () => {
    assert.deepEqual(sel(defaultComboOptions(info({ global: 'general', project: 'default' }), 'project', zh)), ['default']);
  });
});
