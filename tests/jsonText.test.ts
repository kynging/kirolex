import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatJsonText, formatJsonOnOpen, jsonErrorAt } from '../src/renderer/jsonText.ts';

/**
 * 设置里的 JSON 配置编辑框（Claude Code settings.json、组合 mcp-combos.json、Kiro agent / mcp.json …）
 * ——「claude 配置界面 json 不是自动展开 format 的，看起来很费劲」。
 *
 * 守的是：打开时压成一行的 JSON 被展开成 2 空格缩进；不合法的原样留着、报出错位置（不能清空用户的文件）；
 * 格式化只动字符串外面的空白，所以键顺序、数字字面量（大整数、1.0）、重复键、转义都原样保留 —— 保存往返不改语义。
 */

describe('formatJsonText：只重排空白', () => {
  test('压缩 JSON 被展开成 2 空格缩进，末尾一个换行', () => {
    const r = formatJsonText('{"env":{"A":"1","B":[1,2,{}]},"model":"opus","list":[],"o":{}}');
    assert.equal(r.ok, true);
    assert.equal(r.text, [
      '{',
      '  "env": {',
      '    "A": "1",',
      '    "B": [',
      '      1,',
      '      2,',
      '      {}',
      '    ]',
      '  },',
      '  "model": "opus",',
      '  "list": [],',
      '  "o": {}',
      '}',
      '',
    ].join('\n'));
  });

  test('和 JSON.stringify(…, null, 2) 的排版一致（普通内容）', () => {
    const v = { a: [1, 'x', null, true, false], b: { c: { d: [] } }, e: '中文 "引号" \\ 反斜杠', f: -1.5e3 };
    const r = formatJsonText(JSON.stringify(v));
    assert.equal(r.text, `${JSON.stringify(v, null, 2)}\n`);
  });

  test('保持键顺序（JSON.parse 会把整数样的键提到前面，这里不能）', () => {
    const r = formatJsonText('{"b":1,"10":2,"a":3}');
    assert.deepEqual([...r.text!.matchAll(/"(\w+)":/g)].map((m) => m[1]), ['b', '10', 'a']);
  });

  test('数字字面量、重复键、转义、字符串里的空白和括号原样保留', () => {
    const src = '{"big":12345678901234567890,"f":1.0,"k":1,"k":2,"s":"a, b: {c} [d]\\n\\u00e9\\"","t":"  x  "}';
    const r = formatJsonText(src);
    assert.ok(r.text!.includes('"big": 12345678901234567890'));
    assert.ok(r.text!.includes('"f": 1.0'));
    assert.equal((r.text!.match(/"k":/g) || []).length, 2);
    assert.ok(r.text!.includes('"s": "a, b: {c} [d]\\n\\u00e9\\""'));
    assert.ok(r.text!.includes('"t": "  x  "'));
  });

  test('保存往返不改语义：格式化前后 parse 结果相同，再格式化一次不变', () => {
    const samples = [
      '{"permissions":{"allow":["Bash(npm test:*)","Read"],"deny":[]},"env":{"ANTHROPIC_BASE_URL":"https://x/y"}}',
      '[{"id":"a","name":"A","mcpServers":{"s":{"url":"http://h","headers":{"k":"${env:K}"}}}}]',
      '  {\n\n "a" :\t[ 1 ,2 ] }  \n',
      '"just a string"',
      '42',
    ];
    for (const s of samples) {
      const r = formatJsonText(s);
      assert.equal(r.ok, true, s);
      assert.deepEqual(JSON.parse(r.text!), JSON.parse(s));
      assert.equal(formatJsonText(r.text!).text, r.text);
    }
  });

  test('用户手排的合法格式，格式化后就是标准输出', () => {
    const r = formatJsonText('{ "a": 1,\n      "b": [ 2,\n 3 ] }');
    assert.equal(r.text, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
  });

  test('BOM 开头的文件（JSON.parse 不认）当作不合法，不动它', () => {
    const r = formatJsonText(String.fromCharCode(0xfeff) + "{\"a\":1}");
    assert.equal(r.ok, false);
  });
});

describe('不合法的 JSON：原样保留并报出错位置', () => {
  test('formatJsonOnOpen 对非法内容返回原文，不清空', () => {
    const bad = '{"a":1,\n  "b": oops}';
    assert.equal(formatJsonOnOpen(bad), bad);
    assert.equal(formatJsonText(bad).ok, false);
    assert.equal(formatJsonText(bad).text, undefined);
  });

  test('formatJsonOnOpen 对空内容 / 只有空白返回原文', () => {
    assert.equal(formatJsonOnOpen(''), '');
    assert.equal(formatJsonOnOpen('  \n'), '  \n');
  });

  test('formatJsonOnOpen 对压缩 JSON 返回格式化结果', () => {
    assert.equal(formatJsonOnOpen('{"a":[1]}'), '{\n  "a": [\n    1\n  ]\n}\n');
  });

  test('错误位置：行、列指到出错的那个字符', () => {
    const e = jsonErrorAt('{"a":1,\n  "b": oops}');
    assert.ok(e);
    assert.equal(e!.line, 2);
    assert.equal(e!.column, 8);
    assert.ok(e!.message.length > 0);
  });

  test('错误位置：缺逗号、尾逗号、未闭合', () => {
    assert.deepEqual(pick(jsonErrorAt('{\n  "a": 1\n  "b": 2\n}')), { line: 3, column: 3 });
    assert.deepEqual(pick(jsonErrorAt('{\n  "a": 1,\n}')), { line: 3, column: 1 });
    assert.deepEqual(pick(jsonErrorAt('{\n  "a": [1, 2')), { line: 2, column: 13 });
    assert.deepEqual(pick(jsonErrorAt('{"a": "x\ny"}')), { line: 1, column: 9 });
    assert.deepEqual(pick(jsonErrorAt('{"a":1} x')), { line: 1, column: 9 });
  });

  test('合法内容没有错误', () => {
    assert.equal(jsonErrorAt('{"a":[1,2,{"b":null}]}'), null);
    assert.equal(jsonErrorAt(' 1e-3 '), null);
  });

  test('和 JSON.parse 判定一致', () => {
    for (const s of ['01', '1.', '.5', '-', '+1', '"\\x"', '"\t"', 'tru', 'nul', '[1,]', '{"a"}', '{a:1}', "{'a':1}", '', ' ', '[]', '{}', '-0', '1E+2', '"\\u12"', '"\\u1234"']) {
      let ok = true;
      try { JSON.parse(s); } catch { ok = false; }
      assert.equal(jsonErrorAt(s) === null, ok, JSON.stringify(s));
      assert.equal(formatJsonText(s).ok, ok, JSON.stringify(s));
    }
  });
});

function pick(e: { line: number; column: number } | null) {
  return e && { line: e.line, column: e.column };
}

describe('接线：三个 JSON 编辑框都打开即格式化、保存前格式化、用共享编辑器', () => {
  const read = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', f), 'utf8');

  test('KiroConfigPanel（Claude settings.json 等）', () => {
    const P = read('KiroConfigPanel.tsx');
    assert.match(P, /formatJsonOnOpen\(/);
    assert.match(P, /<JsonCodeEditor/);
    assert.match(P, /formatJsonText\(/);
  });

  test('McpCombosPane（组合 mcp-combos.json）', () => {
    const P = read('McpCombosPane.tsx');
    assert.match(P, /formatJsonOnOpen\(/);
    assert.match(P, /<JsonCodeEditor/);
    assert.match(P, /formatJsonText\(/);
    assert.match(P, /Format JSON/);
  });

  test('Kiro Agent 编辑器（ChatArea）', () => {
    const P = read('ChatArea.tsx');
    const load = P.slice(P.indexOf('const loadAgentConfig = useCallback'), P.indexOf('const openAgentConfig = useCallback'));
    assert.match(load, /formatJsonOnOpen\(result\.content\)/);
    assert.match(P, /<JsonCodeEditor/);
  });
});
