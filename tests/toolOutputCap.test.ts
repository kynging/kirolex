import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeShellOutput } from '../src/main/winShell.ts';
import {
  capToolOutput, pruneToolOutputs, utf8Head, utf8TailStart, sliceLines, OutputSpool, expandToolOutputForDisplay,
  TOOL_OUTPUT_DIR, TOOL_OUTPUT_KEEP_MS,
} from '../src/main/toolOutputCap.ts';
import {
  normalizeToolOutputKb, toolOutputSplit,
  TOOL_OUTPUT_DEFAULT_KB, TOOL_OUTPUT_MIN_KB, TOOL_OUTPUT_MAX_KB,
} from '../src/main/toolOutputLimits.ts';
import {
  callTool, handleRpc, toolDefs, startLocalMcp,
  MAX_OUTPUT_BYTES, MAX_READ_BYTES, MAX_READ_TOTAL_BYTES,
} from '../src/main/localMcp.ts';

/*
 * token 优化 2/5：一轮 $64.86 的那条会话里有二十几次 local_* 调用，每次最多 128KB 进上下文。
 * 交给模型的那份默认 24KB（头 8KB + 尾 16KB），完整输出落到会话 files 目录，需要时它自己去读。
 */
function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'tocap-')); }
const deps = { log: () => {}, notice: () => {} };

describe('设置：默认 24KB，16–128KB', () => {
  test('默认值 / 范围 / 坏值', () => {
    assert.equal(TOOL_OUTPUT_DEFAULT_KB, 24);
    assert.equal(TOOL_OUTPUT_MIN_KB, 16);
    assert.equal(TOOL_OUTPUT_MAX_KB, 128);
    assert.equal(normalizeToolOutputKb(undefined), 24);
    assert.equal(normalizeToolOutputKb('abc'), 24);
    assert.equal(normalizeToolOutputKb(4), 16);
    assert.equal(normalizeToolOutputKb(999), 128);
    assert.equal(normalizeToolOutputKb(40), 40);
  });

  test('24KB 拆成头 8KB + 尾 16KB', () => {
    assert.deepEqual(toolOutputSplit(24 * 1024), { head: 8 * 1024, tail: 16 * 1024 });
  });
});

describe('截断：头 8KB + 尾 16KB + 中间一行，完整输出落盘', () => {
  test('200KB 输出', () => {
    const dir = tmp();
    const lines: string[] = [];
    for (let i = 1; lines.join('\n').length < 200 * 1024; i++) lines.push(`line ${String(i).padStart(6, '0')} ${'x'.repeat(40)}`);
    const full = lines.join('\n');
    const r = capToolOutput(full, { maxBytes: 24 * 1024, dir, id: 'abc123', now: new Date(2026, 10, 27, 9, 8, 7) });
    assert.equal(r.cut, true);
    /* 完整文件：会话 files 目录下 .kirolex-tool-output/<时间>-<id>.txt，内容一字不差 */
    assert.equal(r.file, path.join(dir, TOOL_OUTPUT_DIR, '20261127-090807-abc123.txt'));
    assert.equal(fs.readFileSync(r.file!, 'utf8'), full);
    const parts = r.text.split('\n');
    const noteIdx = parts.findIndex((l) => l.includes('完整输出在'));
    assert.ok(noteIdx > 0);
    const note = parts[noteIdx];
    assert.ok(note.includes(r.file!), '提示里有完整路径');
    assert.match(note, /省略 \d+ KB/);
    assert.match(note, /local_read/);
    assert.match(note, /offset/);
    const head = parts.slice(0, noteIdx).join('\n');
    const tail = parts.slice(noteIdx + 1).join('\n');
    assert.equal(Buffer.byteLength(head), 8 * 1024);
    assert.equal(Buffer.byteLength(tail), 16 * 1024);
    assert.ok(full.startsWith(head));
    assert.ok(full.endsWith(tail));
    /* 整份交给模型的不超过上限多少（只多那一行提示） */
    assert.ok(Buffer.byteLength(r.text) < 24 * 1024 + 400);
  });

  test('没超上限：原样返回，不落盘', () => {
    const dir = tmp();
    const r = capToolOutput('short output', { maxBytes: 24 * 1024, dir });
    assert.equal(r.cut, false);
    assert.equal(r.text, 'short output');
    assert.equal(fs.existsSync(path.join(dir, TOOL_OUTPUT_DIR)), false);
  });

  test('中文不被切出半个字（UTF-8 边界）', () => {
    const dir = tmp();
    /* 「中」是 3 字节：8192 / 3 不整除，头尾都会落在字的中间 */
    const full = 'a' + '中文输出'.repeat(20_000);
    const r = capToolOutput(full, { maxBytes: 24 * 1024, dir, id: 'zh' });
    assert.equal(r.cut, true);
    assert.equal(r.text.includes('�'), false, '没有替换字符 = 没切坏');
    const parts = r.text.split('\n');
    assert.ok(full.startsWith(parts[0]));
    assert.ok(full.endsWith(parts[2]));
    assert.ok(Buffer.byteLength(parts[0]) <= 8 * 1024);
    assert.ok(Buffer.byteLength(parts[2]) <= 16 * 1024);
  });

  test('utf8Head / utf8TailStart 只停在字的边界上', () => {
    const b = Buffer.from('ab中文', 'utf8');   // a b [e4 b8 ad] [e6 96 87]
    assert.equal(utf8Head(b, 3).toString('utf8'), 'ab');
    assert.equal(utf8Head(b, 5).toString('utf8'), 'ab中');
    assert.equal(utf8TailStart(b, 3), 5);
    assert.equal(utf8TailStart(b, 2), 2);
  });

  test('落不了盘：照样截断，提示里说清楚', () => {
    const file = path.join(tmp(), 'not-a-dir');
    fs.writeFileSync(file, '');
    const r = capToolOutput('y'.repeat(100 * 1024), { maxBytes: 24 * 1024, dir: file });
    assert.equal(r.cut, true);
    assert.equal(r.file, undefined);
    assert.ok(Buffer.byteLength(r.text) < 24 * 1024 + 400);
    assert.match(r.text, /没能保存/);
  });

  test('7 天前的输出文件被清掉，新的留着', () => {
    const dir = tmp();
    const out = path.join(dir, TOOL_OUTPUT_DIR);
    fs.mkdirSync(out, { recursive: true });
    const old = path.join(out, 'old.txt');
    const fresh = path.join(out, 'fresh.txt');
    fs.writeFileSync(old, 'o');
    fs.writeFileSync(fresh, 'f');
    const now = Date.now();
    const t = (now - TOOL_OUTPUT_KEEP_MS - 60_000) / 1000;
    fs.utimesSync(old, t, t);
    pruneToolOutputs(out, now);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(TOOL_OUTPUT_KEEP_MS, 7 * 24 * 3600 * 1000);
  });
});

describe('sliceLines：按行取一段', () => {
  test('offset 从 1 开始，limit 是行数', () => {
    const text = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    assert.deepEqual(sliceLines(text, 2, 2), { text: 'l2\nl3', from: 2, to: 3, total: 5 });
    assert.deepEqual(sliceLines(text, 4, undefined), { text: 'l4\nl5', from: 4, to: 5, total: 5 });
    assert.equal(sliceLines(text, 9, 1).text, '');
  });
});

describe('local_bash 接线：交给模型的那份截断，完整输出落在会话 files 目录', () => {
  test('MAX_OUTPUT_BYTES 默认 24KB', () => {
    assert.equal(MAX_OUTPUT_BYTES, 24 * 1024);
  });

  test('大输出：头 + 提示 + 尾；完整文件在 outputDir(sessionId) 下', async () => {
    const work = tmp();
    const files = tmp();
    const seen: string[] = [];
    const d = { ...deps, outputDir: (sid: string) => { seen.push(sid); return files; } };
    const cmd = process.platform === 'win32'
      ? 'powershell -NoProfile -Command "1..20000 | ForEach-Object { \'row \' + $_ }"'
      : 'seq -f "row %g" 1 20000';
    const r = await callTool('local_bash', { command: cmd }, { sessionId: 'sX', workdir: work }, d);
    const t = r.content[0].text;
    assert.deepEqual(seen, ['sX']);
    assert.match(t, /^\[exit 0\]/);
    assert.match(t, /row 1\b/);
    assert.match(t, /row 20000/);
    assert.ok(Buffer.byteLength(t) < 24 * 1024 + 400);
    const m = t.match(/完整输出在 (.+?\.txt)/);
    assert.ok(m, t.slice(8000, 8600));
    assert.ok(m![1].startsWith(path.join(files, '.kirolex-tool-output')));
    const full = fs.readFileSync(m![1], 'utf8');
    assert.match(full, /row 10000\r?\n/);
  });

  test('上限读设置（outputCapBytes）', async () => {
    const files = tmp();
    const d = { ...deps, outputDir: () => files, outputCapBytes: () => 64 * 1024 };
    const big = process.platform === 'win32'
      ? 'powershell -NoProfile -Command "\'z\' * 50000"'
      : 'printf "z%.0s" $(seq 1 50000)';
    const r = await callTool('local_bash', { command: big }, { sessionId: 's', workdir: tmp() }, d);
    /* 50KB < 64KB：不截 */
    assert.equal(r.content[0].text.includes('完整输出在'), false);
  });

  test('工具 description 写明上限和截断规则（并跟着设置走）', () => {
    const bash = toolDefs({ outputCapBytes: 24 * 1024 }).find((t) => t.name === 'local_bash')!.description;
    assert.match(bash, /24KB/);
    assert.match(bash, /开头 8KB/);
    assert.match(bash, /结尾 16KB/);
    assert.match(bash, /local_read/);
    const bash48 = toolDefs({ outputCapBytes: 48 * 1024 }).find((t) => t.name === 'local_bash')!.description;
    assert.match(bash48, /48KB/);
    const read = toolDefs().find((t) => t.name === 'local_read')!;
    assert.match(read.description, /64KB/);
    assert.match(read.description, /96KB/);
    assert.match(read.description, /offset/);
    assert.ok(read.inputSchema.properties.offset);
    assert.ok(read.inputSchema.properties.limit);
  });

  test('tools/list 的说明用的是设置里的上限', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { sessionId: 's', workdir: tmp() },
      { ...deps, outputCapBytes: () => 32 * 1024 });
    const bash = r.result.tools.find((t: any) => t.name === 'local_bash');
    assert.match(bash.description, /32KB/);
  });
});

describe('local_read：单文件 64KB，一次合计 96KB，offset / limit', () => {
  test('合计超 96KB：后面的文件标「未读」+ 文件大小', async () => {
    const dir = tmp();
    assert.equal(MAX_READ_BYTES, 64 * 1024);
    assert.equal(MAX_READ_TOTAL_BYTES, 96 * 1024);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A'.repeat(40 * 1024));
    fs.writeFileSync(path.join(dir, 'b.txt'), 'B'.repeat(40 * 1024));
    fs.writeFileSync(path.join(dir, 'c.txt'), 'C'.repeat(40 * 1024));
    fs.writeFileSync(path.join(dir, 'd.txt'), 'small');
    const r = await callTool('local_read', { paths: ['a.txt', 'b.txt', 'c.txt', 'd.txt'] }, { sessionId: 's', workdir: dir }, deps);
    const t = r.content[0].text;
    assert.ok(t.includes('A'.repeat(40 * 1024)));
    assert.ok(t.includes('B'.repeat(40 * 1024)));
    assert.equal(t.includes('CCCC'), false);
    assert.match(t, /c\.txt ===\n（未读：超过本次合计上限[^\n]*单独再读[^\n]*40960 字节/);
    /* 放得下的小文件照样读（不是遇到一个超的就全停） */
    assert.match(t, /small/);
  });

  test('offset / limit 读出正确的行', async () => {
    const dir = tmp();
    const lines = Array.from({ length: 100 }, (_, i) => `第${i + 1}行`);
    fs.writeFileSync(path.join(dir, 'n.txt'), lines.join('\n'));
    const r = await callTool('local_read', { paths: ['n.txt'], offset: 10, limit: 3 }, { sessionId: 's', workdir: dir }, deps);
    const t = r.content[0].text;
    assert.match(t, /第10行\n第11行\n第12行/);
    assert.equal(t.includes('第9行'), false);
    assert.equal(t.includes('第13行'), false);
    assert.match(t, /第 10–12 行，共 100 行/);
  });

  test('单文件超 64KB：只给前面整行，说清下一段从哪行接着读，不切坏中文', async () => {
    const dir = tmp();
    const lines = Array.from({ length: 5000 }, (_, i) => `中文行${i + 1} ${'字'.repeat(10)}`);
    fs.writeFileSync(path.join(dir, 'big.txt'), lines.join('\n'));
    const r = await callTool('local_read', { paths: ['big.txt'] }, { sessionId: 's', workdir: dir }, deps);
    const t = r.content[0].text;
    assert.equal(t.includes('�'), false);
    const m = t.match(/offset=(\d+)/);
    assert.ok(m);
    const next = Number(m![1]);
    assert.ok(t.includes(`中文行${next - 1} `));
    assert.equal(t.includes(`中文行${next} `), false);
    const r2 = await callTool('local_read', { paths: ['big.txt'], offset: next, limit: 1 }, { sessionId: 's', workdir: dir }, deps);
    assert.match(r2.content[0].text, new RegExp(`中文行${next} `));
  });
});

describe('远程会话：经反向隧道转发过来的是同一套工具，同样生效', () => {
  test('HTTP 调 local_bash：截断 + 落盘', async () => {
    const files = tmp();
    const server = await startLocalMcp({ ...deps, outputDir: () => files });
    try {
      const token = server.register({ sessionId: 'remote1', workdir: tmp() });
      const cmd = process.platform === 'win32'
        ? 'powershell -NoProfile -Command "1..20000 | ForEach-Object { \'row \' + $_ }"'
        : 'seq -f "row %g" 1 20000';
      const res = await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'local_bash', arguments: { command: cmd } } }),
      });
      const body: any = await res.json();
      const t: string = body.result.content[0].text;
      assert.ok(Buffer.byteLength(t) < 24 * 1024 + 400);
      assert.match(t, /完整输出在 .*\.kirolex-tool-output/);
    } finally {
      server.stop();
    }
  });
});

describe('接线：主进程读设置、设置页能调', () => {
  const src = (p: string): string => fs.readFileSync(path.join(import.meta.dirname, '..', p), 'utf8');
  test('index.ts 把设置里的上限和会话 files 目录交给 localMcp', () => {
    const idx = src('src/main/index.ts');
    const start = idx.indexOf('localMcpStarting = startLocalMcp({');
    assert.ok(start > 0);
    const block = idx.slice(start, idx.indexOf('}).then((srv)', start));
    assert.match(block, /outputCapBytes: \(\) => normalizeToolOutputKb\(readUiSettings\(\)\.toolOutputKb\) \* 1024/);
    assert.match(block, /outputDir: \(sid\) => sessionFilesDir\(sid\)/);
  });

  test('设置页有这一项，默认 24', () => {
    const dlg = src('src/renderer/components/SettingsDialog.tsx');
    assert.match(dlg, /t\('Local tool output limit'\)/);
    assert.match(dlg, /toolOutputKb: normalizeToolOutputKb\(/);
    const app = src('src/renderer/App.tsx');
    assert.match(app, /toolOutputKb: TOOL_OUTPUT_DEFAULT_KB/);
    assert.match(app, /merged\.toolOutputKb = normalizeToolOutputKb\(merged\.toolOutputKb\)/);
  });
});

describe('上限设成最大 128KB：结尾不被 128KB 硬上限再截一刀', () => {
  test('local_bash 300KB 输出：结尾标记还在', async () => {
    const files = tmp();
    const d = { ...deps, outputDir: () => files, outputCapBytes: () => 128 * 1024 };
    const cmd = `"${process.execPath}" -e "process.stdout.write('E'.repeat(300000)+'ENDMARK')"`;
    const r = await callTool('local_bash', { command: cmd }, { sessionId: 's', workdir: tmp() }, d);
    const t = r.content[0].text;
    assert.match(t, /ENDMARK$/);
    assert.match(t, /完整输出在/);
    assert.equal(t.includes('输出被截断'), false);
    assert.ok(Buffer.byteLength(t) < 128 * 1024 + 400);
  });
});

describe('OutputSpool：长输出边收边落盘', () => {
  test('超过内存上限后文件是完整的，渲染出来是头 + 提示 + 尾、行号对', () => {
    const dir = tmp();
    const sp = new OutputSpool({ dir: () => dir, id: 'sp', memoryBytes: 1000 });
    const lines = Array.from({ length: 5000 }, (_, i) => `r${i + 1}`);
    const full = lines.join('\n');
    for (let i = 0; i < full.length; i += 777) sp.write(Buffer.from(full.slice(i, i + 777)));
    const r = sp.render(16 * 1024);
    assert.equal(r.cut, true);
    assert.equal(fs.readFileSync(r.file!, 'utf8'), full);
    const parts = r.text.split('\n');
    const i = parts.findIndex((l) => l.includes('完整输出在'));
    assert.ok(full.startsWith(parts.slice(0, i).join('\n')));
    assert.ok(full.endsWith(parts.slice(i + 1).join('\n')));
    /* 提示里的行号：省略的第一行就是头后面那行 */
    const m = parts[i].match(/约第 (\d+)–(\d+) 行/);
    assert.ok(m);
    const headLast = parts[i - 1];
    assert.ok(full.split('\n')[Number(m![1]) - 1].startsWith(headLast));
  });

  test('没超内存上限也没超输出上限：不落盘', () => {
    const dir = tmp();
    const sp = new OutputSpool({ dir: () => dir });
    sp.write(Buffer.from('small\n'));
    const r = sp.render(16 * 1024);
    assert.equal(r.text, 'small');
    assert.equal(fs.existsSync(path.join(dir, TOOL_OUTPUT_DIR)), false);
  });
});

describe('本机代码页（GBK）的大输出：完整文件存成 UTF-8，local_read 读得出原文', () => {
  test('超过 256KB 的 GBK 输出：头尾不乱码，按 offset 读中间也对', async () => {
    const dir = tmp();
    /* Windows 上 bgJobs 用的是 decodeLocalOutput（不是合法 UTF-8 的行按本机代码页解）；这里固定按 GBK，任何系统上都能测 */
    const sp = new OutputSpool({ dir: () => dir, id: 'gbk', decode: (b) => decodeShellOutput(b, 'gbk') });
    const ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);   // GBK 的「中文」
    const raw: Buffer[] = [];
    for (let i = 0; i < 6000; i++) raw.push(Buffer.from(`L${i} `), ...Array(20).fill(ZHONGWEN), Buffer.from('\r\n'));
    const all = Buffer.concat(raw);
    assert.ok(all.length > 256 * 1024);
    /* 4099 字节一块：块边界会切在 GBK 双字节字和行的中间 */
    for (let i = 0; i < all.length; i += 4099) sp.write(all.subarray(i, i + 4099));
    const r = sp.render(24 * 1024);
    assert.equal(r.cut, true);
    assert.equal(r.text.includes('�'), false);
    assert.match(r.text, /^L0 (中文){20}/);
    assert.match(r.text, /L5999 (中文){20}$/);
    const read = await callTool('local_read', { paths: [r.file!], offset: 3000, limit: 2 }, { sessionId: 's', workdir: dir }, deps);
    const t = read.content[0].text;
    assert.match(t, /L2999 (中文){20}/);
    assert.match(t, /L3000 (中文){20}/);
    assert.equal(t.includes('�'), false);
  });

  test('bgJobs 的后台命令 / 检查命令按本机输出的规则解码之后再存', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/main/bgJobs.ts'), 'utf8');
    assert.match(src, /new OutputSpool\(\{ dir: \(\) => this\.outputDir\(job\), id: jobId, decode: decodeLocalOutput \}\)/);
  });
});

describe('界面上照旧显示完整输出（截断只影响交给模型的那份）', () => {
  const rowsCmd = process.platform === 'win32'
    ? 'powershell -NoProfile -Command "1..10000 | ForEach-Object { \'row \' + $_ }"'
    : 'seq -f "row %g" 1 10000';

  test('模型拿到的是头 + 尾；界面那份换回完整输出，中间的行也在', async () => {
    const files = tmp();
    const outDir = path.join(files, TOOL_OUTPUT_DIR);
    const r = await callTool('local_bash', { command: rowsCmd }, { sessionId: 's', workdir: tmp() }, { ...deps, outputDir: () => files });
    const model = r.content[0].text;
    assert.equal(/row 5000\r?\n/.test(model), false, '模型那份没有中间');
    const shown = expandToolOutputForDisplay(model, outDir);
    assert.match(shown, /row 5000\r?\n/);
    assert.match(shown, /^\[exit 0\]/);
    assert.match(shown, /row 10000$/);
    assert.equal(shown.includes('完整输出在'), false);
  });

  test('只认这条会话自己的目录；头尾和文件对不上（被改过形状）就不动', async () => {
    const files = tmp();
    const r = await callTool('local_bash', { command: rowsCmd }, { sessionId: 's', workdir: tmp() }, { ...deps, outputDir: () => files });
    const model = r.content[0].text;
    assert.equal(expandToolOutputForDisplay(model, path.join(tmp(), TOOL_OUTPUT_DIR)), model);
    const wrapped = `{"result":${JSON.stringify(model)}}`;
    assert.equal(expandToolOutputForDisplay(wrapped, path.join(files, TOOL_OUTPUT_DIR)), wrapped);
    assert.equal(expandToolOutputForDisplay('普通输出', path.join(files, TOOL_OUTPUT_DIR)), '普通输出');
  });

  test('完整输出超过 128KB：界面同截断之前，给前 128KB，并留着那行提示', () => {
    const dir = tmp();
    const full = 'H'.repeat(1000) + 'M'.repeat(300 * 1024) + 'TAILEND';
    const c = capToolOutput(full, { maxBytes: 24 * 1024, dir, id: 'big' });
    const shown = expandToolOutputForDisplay(c.text, path.join(dir, TOOL_OUTPUT_DIR));
    assert.ok(shown.startsWith('H'.repeat(1000) + 'M'.repeat(1000)));
    assert.ok(Buffer.byteLength(shown) < 128 * 1024 + 400);
    assert.match(shown, /完整输出在 /);
  });

  test('接线：index.ts 发给界面的 acp:update 之前先过 toolOutputForDisplay（只影响发给界面的这份）', () => {
    const idx = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/main/index.ts'), 'utf8');
    assert.match(idx, /data = toolOutputForDisplay\(data, sessionId\);[^\n]*\n    mainWindow\?\.webContents\.send\('acp:update', \{ \.\.\.data, sessionId,/);
    const fn = idx.slice(idx.indexOf('function toolOutputForDisplay('), idx.indexOf('/** Strip kiro-cli'));
    assert.match(fn, /path\.join\(getSessionDir\(sessionId\), SESSION_FILES_DIR, TOOL_OUTPUT_DIR\)/);
    assert.match(fn, /expandToolOutputForDisplay\(/);
  });
});
