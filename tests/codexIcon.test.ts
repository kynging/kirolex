import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 「Codex 的图标都看不出是 Codex」：`>_` 是谁都能用的终端符号，换成 OpenAI 那个六瓣交织的结（线条版）。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf-8');

test('Codex 引擎图标是 OpenAI 结（IconCodex），两处 codex 分支都接上了', () => {
  const icons = read('src', 'renderer', 'components', 'Icons.tsx');
  assert.doesNotMatch(icons, /IconCodexPrompt/);
  assert.match(icons, /export const IconCodex: React\.FC<IconProps>/);
  /* 同一套线条风格：24 网格、只描边、圆头圆角 */
  const svg = icons.slice(icons.indexOf('export const IconCodex:'));
  assert.match(svg, /viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1\.8" strokeLinecap="round" strokeLinejoin="round"/);
  /* 六瓣：六段，每段一个圆弧瓣头 */
  const d = svg.match(/<path d="([^"]+)"/)![1];
  assert.equal((d.match(/M/g) || []).length, 6);
  assert.equal((d.match(/A/g) || []).length, 6);

  const ca = read('src', 'renderer', 'components', 'ChatArea.tsx');
  assert.doesNotMatch(ca, /IconCodexPrompt/);
  assert.match(ca, /engine === 'claude' \? <IconClaudeSpark size=\{15\} \/> : <IconCodex size=\{15\} \/>/);
  assert.match(ca, /engine === 'claude' \? <IconClaudeSpark size=\{17\} \/> : <IconCodex size=\{17\} \/>/);
});
