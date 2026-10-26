/**
 * 「组合」改名为「MCP 配置」（英文 MCP profile）——「组合」这个叫法看不懂，它实际是「这条会话挂哪些 MCP 工具、用什么 effort」。
 * 只改显示文案：文件名 mcp-combos.json、JSON 字段、id、IPC 名、变量名都不动。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { t, zhEntries } from '../src/renderer/i18n.ts';
import { ZH_MAIN, trIn } from '../src/main/uiText.ts';

const ROOT = path.join(import.meta.dirname, '..');
/** 占位符 `{combo}` 和文件名 mcp-combos.json 是代码 / 存储里的名字，不是给人看的叫法，不算 */
const saysCombo = (en: string) => /\bcombos?\b/i.test(en.replace(/\{combo\}/g, '').replace(/mcp-combos\.json/g, ''));
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('文案：不再叫「组合」/ combo', () => {
  test('渲染层中文表里没有「组合」，英文原文里没有 combo', () => {
    const zh = zhEntries().filter(([, v]) => v.includes('组合'));
    assert.deepEqual(zh, []);
    const en = zhEntries().filter(([k]) => saysCombo(k));
    assert.deepEqual(en, []);
  });

  test('主进程中文表里没有「组合」，英文原文里没有 combo', () => {
    assert.deepEqual(Object.entries(ZH_MAIN).filter(([, v]) => v.includes('组合')), []);
    assert.deepEqual(Object.keys(ZH_MAIN).filter(saysCombo), []);
  });

  test('中文表源文件（含注释）里也不再出现「组合」', () => {
    const files = [
      'src/renderer/i18n.ts',
      ...fs.readdirSync(path.join(ROOT, 'src/renderer/i18nZh')).map((f) => `src/renderer/i18nZh/${f}`),
      ...fs.readdirSync(path.join(ROOT, 'src/main/uiTextZh')).map((f) => `src/main/uiTextZh/${f}`),
    ];
    for (const f of files) assert.ok(!read(f).includes('组合'), f);
  });

  test('用户文档里不再叫「组合」', () => {
    const dir = path.join(ROOT, 'docs/user');
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md')) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('组合'), f);
    }
  });

  test('关键几处的新叫法', () => {
    assert.equal(t('zh', '🧩 MCP profiles'), '🧩 MCP 配置');
    assert.equal(t('zh', 'MCP profile · {name}', { name: '投研' }), 'MCP 配置 · 投研');
    assert.equal(t('zh', 'Default MCP profile for new sessions (Claude Code / Codex)'), '新会话默认 MCP 配置（Claude Code / Codex）');
    assert.equal(t('zh', 'Wait for this reply to finish before switching MCP profiles'), '等这一轮回复完再换 MCP 配置');
    assert.equal(trIn('zh', 'MCP profile'), 'MCP 配置');
    assert.equal(trIn('en', 'Switching to the MCP profile "{name}" failed ({err}); the previous MCP profile is kept and your next message reconnects with it.', { name: 'x', err: 'e' }),
      'Switching to the MCP profile "x" failed (e); the previous MCP profile is kept and your next message reconnects with it.');
  });
});

describe('配置面板第一个 tab：标题旁一句 hint', () => {
  const C = read('src/renderer/components/ChatArea.tsx');
  test('hint 文案', () => {
    /* effort 不归 MCP 配置管了（2026-10-26，独立的 effort 下拉），hint 里不再提它 */
    assert.equal(t('zh', 'Which MCP tools this chat gets'), '这条会话挂哪些 MCP 工具');
  });
  test('接线：mcp-combos 那个 tab 用新标题并带上 hint', () => {
    assert.match(C, /\{ id: 'mcp-combos', label: t\('🧩 MCP profiles'\), tabHint: t\('Which MCP tools this chat gets'\) \}/);
    assert.match(C, /<span className="kiro-config-tab-hint">\{c\.tabHint\}<\/span>/);
  });
  test('只有这个 tab 带 hint：别的类别自己的 hint（面板里的说明）不挤到 tab 上', () => {
    assert.ok(!/\{c\.hint\}/.test(C.slice(C.indexOf('kiro-config-tabs" role="tablist"'), C.indexOf("engineConfigTab === 'login'"))));
  });
});

describe('存储不动', () => {
  test('文件名、IPC 名照旧', () => {
    assert.ok(read('src/main/mcpCombos.ts').includes("'mcp-combos.json'"));
    const P = read('src/main/preload.ts');
    for (const ch of ['acp:mcp-combos', 'acp:save-mcp-combos', 'acp:default-combo', 'acp:set-default-combo']) assert.ok(P.includes(`'${ch}'`), ch);
  });
});
