/**
 * 设置里 JSON 配置编辑框用的纯文本工具（Claude Code settings.json、组合 mcp-combos.json、Kiro agent / mcp.json …）。
 *
 * 格式化**只重排字符串外面的空白**，不走 `JSON.stringify(JSON.parse(x))`：那条路会把整数样的键提到前面
 * （`{"b":1,"10":2}` → `{"10":2,"b":1}`）、把 `12345678901234567890` 变成 `12345678901234567000`、
 * 吞掉重复键 —— 保存回去就改了用户的配置。这里字符串 / 数字按原文照抄，排版和 `JSON.stringify(v, null, 2)` 一样。
 *
 * 合不合法以 `JSON.parse` 为准（和保存时 main 那边的校验同一个判据）；自己的扫描器只用来定位出错的行列。
 */

export interface JsonErrorAt { message: string; line: number; column: number; offset: number }

type Tok = string;

class ScanError extends Error {
  offset: number;
  constructor(message: string, offset: number) { super(message); this.offset = offset; }
}

/** 严格按 JSON 语法扫一遍，返回去掉空白的 token 序列；不合法时抛 ScanError（带出错的字符位置）。 */
function scan(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = text.length;
  const ws = () => { while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };
  const fail = (msg: string): never => { throw new ScanError(i >= n ? 'Unexpected end of JSON input' : msg, i); };
  const str = () => {
    const start = i++;
    for (;;) {
      if (i >= n) fail('Unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) { i++; break; }
      if (c < 0x20) fail('Bad control character in string');
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { i += 2; fail('Bad Unicode escape in string'); }
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else { i++; fail('Bad escaped character in string'); }
      } else i++;
    }
    toks.push(text.slice(start, i));
  };
  const num = () => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) fail(`Unexpected token '${text[i]}'`);
    /* `1.` / `1e` 这种：正则只吃到 `1`，下一个字符是 . / e 就是写了一半的数字 */
    const end = i + m![0].length;
    if (end < n && /[.eE0-9]/.test(text[end])) { i = end; fail('Bad number'); }
    toks.push(m![0]);
    i = end;
  };
  const value = (depth: number) => {
    if (depth > 5000) fail('Nesting too deep');
    ws();
    const c = text[i];
    if (c === '{') {
      toks.push('{'); i++; ws();
      if (text[i] === '}') { toks.push('}'); i++; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('Expected double-quoted property name');
        str(); ws();
        if (text[i] !== ':') fail("Expected ':' after property name");
        toks.push(':'); i++;
        value(depth + 1); ws();
        if (text[i] === ',') { toks.push(','); i++; continue; }
        if (text[i] === '}') { toks.push('}'); i++; return; }
        fail("Expected ',' or '}' after property value");
      }
    }
    if (c === '[') {
      toks.push('['); i++; ws();
      if (text[i] === ']') { toks.push(']'); i++; return; }
      for (;;) {
        value(depth + 1); ws();
        if (text[i] === ',') { toks.push(','); i++; continue; }
        if (text[i] === ']') { toks.push(']'); i++; return; }
        fail("Expected ',' or ']' after array element");
      }
    }
    if (c === '"') return str();
    for (const lit of ['true', 'false', 'null']) {
      if (text.startsWith(lit, i)) { toks.push(lit); i += lit.length; return; }
    }
    if (c === '-' || (c >= '0' && c <= '9')) return num();
    fail(`Unexpected token '${c}'`);
  };
  value(0);
  ws();
  if (i < n) fail(`Unexpected non-whitespace character after JSON`);
  return toks;
}

function lineCol(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const nl = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - nl };
}

/** 不合法时给出错的行 / 列（1 起）；合法返回 null。message 用 `JSON.parse` 原话。 */
export function jsonErrorAt(text: string): JsonErrorAt | null {
  let message: string;
  try { JSON.parse(text); return null; } catch (e: any) { message = String(e?.message || e); }
  let offset: number;
  try {
    scan(text);
    /* 扫描器没挑出毛病（理论上不会）：退回到 V8 报的位置，再不行就指到末尾 */
    const pos = /position\s+(\d+)/i.exec(message);
    offset = pos ? Math.min(Number(pos[1]), text.length) : text.length;
  } catch (e) {
    offset = e instanceof ScanError ? e.offset : text.length;
  }
  return { message, offset, ...lineCol(text, offset) };
}

/** 2 空格缩进、键顺序 / 字面量原样。不合法（或扫不动）时 `ok: false`，调用方保持原文不动。 */
export function formatJsonText(text: string): { ok: boolean; text?: string } {
  try { JSON.parse(text); } catch { return { ok: false }; }
  let toks: Tok[];
  try { toks = scan(text); } catch { return { ok: false }; }
  let out = '';
  let depth = 0;
  const pad = () => '\n' + '  '.repeat(depth);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t === '{' || t === '[') {
      const close = t === '{' ? '}' : ']';
      if (toks[k + 1] === close) { out += t + close; k++; continue; }
      depth++; out += t + pad();
    } else if (t === '}' || t === ']') {
      depth--; out += pad() + t;
    } else if (t === ',') out += ',' + pad();
    else if (t === ':') out += ': ';
    else out += t;
  }
  return { ok: true, text: `${out}\n` };
}

/** 打开文件时用：合法就展开，不合法 / 空的原样返回（不能把用户的文件清空）。 */
export function formatJsonOnOpen(text: string): string {
  if (!text.trim()) return text;
  const r = formatJsonText(text);
  return r.ok ? r.text! : text;
}
