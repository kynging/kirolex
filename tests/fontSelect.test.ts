/**
 * 设置 → 外观：字体只能从下拉框选。
 *
 * 原来下拉框下面各有一个手填字体名的输入框，选默认字体时它是空的，看着像一条莫名其妙的空行；
 * 下拉里还有个选了什么都不发生的「Custom…」。两样都删了。
 * 老设置里存过的不在预设里的字体不能被偷偷改掉，也不能让下拉框显示成别的预设 ——
 * 这时下拉里多一项「当前：<那个值>」并选中它。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fontSelectOptions } from '../src/renderer/fontOptions.ts';
import { t } from '../src/renderer/i18n.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');

const PRESETS = [
  { label: 'System default', value: '' },
  { label: 'Segoe UI', value: "'Segoe UI', Tahoma, sans-serif" },
];
const tr = (key: string, vars?: Record<string, string | number>) => t('zh', key, vars);

describe('fontSelectOptions', () => {
  test('存的是预设值：只有预设，没有多余项', () => {
    assert.deepEqual(
      fontSelectOptions(PRESETS, "'Segoe UI', Tahoma, sans-serif", tr),
      PRESETS.map((p) => ({ label: tr(p.label), value: p.value })),
    );
  });

  test('空值 = 默认预设，也不多加项', () => {
    assert.equal(fontSelectOptions(PRESETS, '', tr).length, PRESETS.length);
  });

  test('老设置里不在预设里的值：多一项「当前：<值>」，value 就是原值（下拉框据此选中它）', () => {
    const opts = fontSelectOptions(PRESETS, "'Comic Sans MS'", tr);
    assert.equal(opts.length, PRESETS.length + 1);
    assert.deepEqual(opts[opts.length - 1], { label: "当前：'Comic Sans MS'", value: "'Comic Sans MS'" });
  });

  test('英文界面下那一项是 Current: <值>', () => {
    const opts = fontSelectOptions(PRESETS, 'Papyrus', (k, v) => t('en', k, v));
    assert.equal(opts[opts.length - 1].label, 'Current: Papyrus');
  });
});

describe('设置对话框里的字体下拉', () => {
  const SETTINGS = read('src', 'renderer', 'components', 'SettingsDialog.tsx');
  const I18N = read('src', 'renderer', 'i18n.ts');

  test('没有「Custom…」选项了', () => {
    assert.doesNotMatch(SETTINGS, /CUSTOM_FONT/);
    assert.doesNotMatch(SETTINGS, /Custom…/);
    assert.doesNotMatch(I18N, /'Custom…'/);
  });

  test('字体下拉下面没有手填输入框', () => {
    assert.doesNotMatch(SETTINGS, /<input[^>]*value=\{settings\.fontFamily\}/);
    assert.doesNotMatch(SETTINGS, /<input[^>]*value=\{settings\.monoFontFamily\}/);
  });

  test('两个下拉都用 fontSelectOptions，value 直接绑存下来的值', () => {
    assert.match(SETTINGS, /fontSelectOptions\(FONT_PRESETS, settings\.fontFamily, t\)/);
    assert.match(SETTINGS, /fontSelectOptions\(MONO_PRESETS, settings\.monoFontFamily, t\)/);
    assert.match(SETTINGS, /value=\{settings\.fontFamily\}/);
    assert.match(SETTINGS, /value=\{settings\.monoFontFamily\}/);
  });
});
