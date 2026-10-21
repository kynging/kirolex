import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { comboSelectView } from '../src/renderer/comboPick.ts';
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
