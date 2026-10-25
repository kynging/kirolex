import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENGINE_ICON_SHAPES } from '../src/renderer/engineIcons.ts';

/**
 * 「Codex 的图标都看不出是 Codex」：`>_` 是谁都能用的终端符号，换成 OpenAI 那个结（简化）。
 * 后来「Claude Code 和 Codex 的图标看起来差不多」：结改成空心的六瓣外圈 + 中间的孔（形状数据在 engineIcons.ts）。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf-8');

test('Codex 引擎图标是 OpenAI 结（不是 >_），两处 codex 分支都接上了', () => {
  const icons = read('src', 'renderer', 'components', 'Icons.tsx');
  assert.doesNotMatch(icons, /IconCodexPrompt/);
  assert.match(icons, /export const EngineIcon: React\.FC/);
  /* 结：外圈六段圆弧瓣，只描边，24 网格 */
  const codex = ENGINE_ICON_SHAPES.codex;
  assert.ok(codex.parts.every((p) => !p.filled));
  assert.equal((codex.parts[0].d.match(/A/g) || []).length, 6);
  assert.match(icons, /viewBox="0 0 24 24"/);

  const ca = read('src', 'renderer', 'components', 'ChatArea.tsx');
  assert.doesNotMatch(ca, /IconCodexPrompt/);
  assert.match(ca, /<EngineIcon engine=\{engine\} size=\{15\} \/>/);
  assert.match(ca, /<EngineIcon engine=\{engine\} size=\{17\} \/>/);
});
