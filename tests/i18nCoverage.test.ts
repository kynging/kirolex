/**
 * 中英两版文案**一一对应** —— 切到英文后界面上不许残留中文，切回中文也不许冒出英文原文。
 *
 * 字典的结构是「key = 英文原文，表里是中文」（渲染层 `i18n.ts` 的 ZH + 主进程 `uiText.ts` 的 ZH_MAIN）。
 * 所以「一一对应」落到三件事上：
 *   1. src/ 下每一个 `t('…')` / `tr('…')` / `trIn(lang, '…')` 调用点的 key 都有中文（没有只有英文的条目）；
 *   2. 表里每一条的英文那一侧（key）没有中文、中文那一侧不是空的（没有只有中文的条目）；
 *   3. 两侧的 `{占位符}` 一模一样 —— 少一个，那个值在某种语言下就显示不出来。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { missingZh, t, zhEntries } from '../src/renderer/i18n.ts';
import { bothLangs, setUiLang, tr, trIn, uiLang } from '../src/main/uiText.ts';

const SRC = path.join(import.meta.dirname, '..', 'src');
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * 从源码里收 `t('…')`、`t(lang, '…')`、`tr('…')`、`trIn(lang, '…')` 的 key。
 * 用 TypeScript 自己的解析器走语法树，而不是正则 —— 注释里举例写的 `t('x')` 不算调用点，
 * 字符串里的转义也按语言规则还原。只认「单个字面量」的 key（拼接 / 变量 key 测试看不见，见 I18N 约定）。
 */
function collectKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['t', 'tr', 'trIn'].includes(n.expression.text)) {
        const [a0, a1] = n.arguments;
        // trIn(lang, key, vars)：key 永远是第二个参数（第一个可能是字面量 'zh' / 'en'）
        const lit = n.expression.text === 'trIn'
          ? (a1 && ts.isStringLiteralLike(a1) ? a1 : null)
          : a0 && ts.isStringLiteralLike(a0) ? a0 : a0 && ts.isIdentifier(a0) && a1 && ts.isStringLiteralLike(a1) ? a1 : null;
        if (lit && lit.text && !keys.has(lit.text)) keys.set(lit.text, path.relative(SRC, file));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return keys;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('中英两版一一对应', () => {
  const keys = collectKeys();

  test('src/ 下所有调用点的 key 都有中文文案', () => {
    assert.ok(keys.size > 300, `应该收到几百个 key，实际 ${keys.size}`);
    const missing = missingZh([...keys.keys()]).map((k) => `${keys.get(k)}: ${k}`);
    assert.deepEqual(missing, [], '这些 key 没有中文文案，中文界面上会显示英文');
  });

  test('调用点的 key（英文那一版）里没有中文 —— 否则英文界面会残留中文', () => {
    const bad = [...keys.entries()].filter(([k]) => CJK.test(k)).map(([k, f]) => `${f}: ${k}`);
    assert.deepEqual(bad, []);
  });

  test('表里每一条：英文侧没有中文，中文侧不是空的', () => {
    const bad = zhEntries()
      .filter(([k, zh]) => CJK.test(k) || !zh.trim() || !k.trim())
      .map(([k, zh, table]) => `${table}: ${JSON.stringify(k)} -> ${JSON.stringify(zh)}`);
    assert.deepEqual(bad, []);
  });

  test('两侧的 {占位符} 一模一样', () => {
    const bad = zhEntries()
      .filter(([k, zh]) => placeholders(k).join(',') !== placeholders(zh).join(','))
      .map(([k, zh, table]) => `${table}: ${k} -> ${zh}`);
    assert.deepEqual(bad, []);
  });

  test('同一个 key 在两张表里不许给出两种中文', () => {
    const seen = new Map<string, string>();
    const bad: string[] = [];
    for (const [k, zh] of zhEntries()) {
      if (seen.has(k) && seen.get(k) !== zh) bad.push(`${k}: ${seen.get(k)} / ${zh}`);
      seen.set(k, zh);
    }
    assert.deepEqual(bad, []);
  });
});

describe('主进程文案跟着界面语言走', () => {
  test('默认中文；切到 en 返回英文原文；坏值退回中文', () => {
    const before = uiLang();
    try {
      setUiLang('zh');
      assert.equal(tr('Quit'), '退出');
      setUiLang('en');
      assert.equal(tr('Quit'), 'Quit');
      setUiLang('fr');
      assert.equal(uiLang(), 'zh');
    } finally {
      setUiLang(before);
    }
  });

  test('trIn 按指定语言取，并替换命名占位符', () => {
    assert.equal(trIn('en', 'Show KiroLex'), 'Show KiroLex');
    assert.equal(trIn('zh', 'Show KiroLex'), '显示 KiroLex');
  });

  test('已经发出去的提示，切语言后能按新语言重新显示（bothLangs）', () => {
    // 主进程在中文下生成了一句提示，界面随后切到英文 —— 状态行上那句话要能换成英文，而不是一直挂着中文
    const before = uiLang();
    try {
      setUiLang('zh');
      const used = tr('General');
      const text = tr('⚠️ MCP profile "{wanted}" not found (it may have been deleted), so this time it starts as "{used}".', { wanted: 'research', used });
      assert.match(text, /找不到 MCP 配置/);
      const both = bothLangs(text);
      assert.ok(both, '刚 tr() 出去的句子要认得');
      assert.equal(both!.zh, text);
      // 嵌在占位符里的、本身也是 tr() 出来的那段（内置组合名「通用」）同样换成英文
      assert.equal(both!.en, '⚠️ MCP profile "research" not found (it may have been deleted), so this time it starts as "General".');
      // 不是 tr() 出来的（例如拼接出来的、或别处来的原文）不猜，原样由调用方处理
      assert.equal(bothLangs('some text nobody translated'), null);
    } finally {
      setUiLang(before);
    }
  });

  test('渲染层的 t() 也查得到主进程的表', () => {
    assert.equal(t('zh', 'Quit'), '退出');
    assert.equal(t('en', 'Quit'), 'Quit');
  });
});
