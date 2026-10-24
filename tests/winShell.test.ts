import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeShellOutput, legacyEncodingForCodePage, cmdUtf8Args, CMD_UTF8_VAR, powershellArgs,
} from '../src/main/winShell.ts';
import { callTool, cmdShellArgs, toolDefs } from '../src/main/localMcp.ts';
import { BgJobManager, outputTail } from '../src/main/bgJobs.ts';

/*
 * 「Windows 上 local_bash 中文输出乱码、echo >> 写进 UTF-8 文件变 GBK」（2026-10-24，代码页 936 的机器）：
 * `dir /s /b memory.md` 找不到时 stderr 显示成「�Ҳ����ļ�」—— 那是 GBK 的「找不到文件」被当成 UTF-8 解。
 */
const GBK_NOT_FOUND = Buffer.from('d5d2b2bbb5bdcec4bcfe', 'hex');   // GBK 的「找不到文件」

describe('decodeShellOutput：按 UTF-8 解，不合法再按本机代码页解', () => {
  test('合法 UTF-8 原样解（不碰兜底）', () => {
    assert.equal(decodeShellOutput(Buffer.from('中文 ok\r\n第二行', 'utf8'), 'gbk'), '中文 ok\r\n第二行');
  });

  test('GBK 的「找不到文件」能还原，不出现 U+FFFD', () => {
    const s = decodeShellOutput(GBK_NOT_FOUND, 'gbk');
    assert.equal(s, '找不到文件');
    assert.equal(s.includes('�'), false);
  });

  test('混合字节：每一行各自判断（node 写 UTF-8、cmd 内建命令写 936）', () => {
    const buf = Buffer.concat([
      Buffer.from('node 说：中文\n', 'utf8'),
      GBK_NOT_FOUND, Buffer.from('\r\n', 'latin1'),
      Buffer.from('最后一行', 'utf8'),
    ]);
    assert.equal(decodeShellOutput(buf, 'gbk'), 'node 说：中文\n找不到文件\r\n最后一行');
  });

  test('没有兜底编码（mac / linux、或本机代码页认不出）：和原来一样按 UTF-8 解', () => {
    assert.equal(decodeShellOutput(GBK_NOT_FOUND, null), GBK_NOT_FOUND.toString('utf8'));
    assert.equal(decodeShellOutput(Buffer.alloc(0), 'gbk'), '');
  });

  test('代码页 → 解码器名字：认得的给名字，认不出的给 null', () => {
    assert.equal(legacyEncodingForCodePage(936), 'gbk');
    assert.equal(legacyEncodingForCodePage(950), 'big5');
    assert.equal(legacyEncodingForCodePage(932), 'shift_jis');
    assert.equal(legacyEncodingForCodePage(1252), 'windows-1252');
    assert.equal(legacyEncodingForCodePage(65001), null);
    assert.equal(legacyEncodingForCodePage(437), null);
    assert.equal(legacyEncodingForCodePage(NaN), null);
  });
});

describe('Windows 上让 cmd 以 UTF-8 代码页跑', () => {
  test('cmd：外层先 chcp 65001>nul，再起一个新的 cmd 跑命令（命令经环境变量 + 延迟展开交过去，外层不解析它）', () => {
    const a = cmdUtf8Args();
    assert.deepEqual(a.slice(0, 4), ['/d', '/v:on', '/s', '/c']);
    assert.match(a[4], /chcp\.com 65001>nul & !ComSpec! \/d \/s \/c "!KX_UTF8_CMD!"/);
    assert.equal(CMD_UTF8_VAR, 'KX_UTF8_CMD');
  });

  test('cmd：特殊字符、引号、%VAR%、^ 转义、退出码都和原来（直接 /d /s /c "命令"）一样', { skip: process.platform !== 'win32' }, () => {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const run = (args: string[], env?: NodeJS.ProcessEnv) => {
      const r = spawnSync(comspec, args, { windowsVerbatimArguments: true, windowsHide: true, env });
      return `${r.status}|${r.stdout}|${r.stderr}`;
    };
    for (const c of ['echo x^&y', 'echo a!b^&c', 'echo "q^&" ^^ end', 'echo %%PATHEXT%% %PATHEXT:~0,4%',
      'echo 1 | findstr 1 && echo ok || echo no', 'node -e "console.log(process.argv.slice(1))" "a b" ^"c^"', 'exit /b 3']) {
      assert.equal(run(cmdUtf8Args(), { ...process.env, [CMD_UTF8_VAR]: c }), run(cmdShellArgs(c)), c);
    }
  });

  test('powershell：-NoProfile -NonInteractive，输出编码设成 UTF-8，整条脚本是 -Command 后的一个参数', () => {
    const a = powershellArgs('Write-Output "中文"');
    assert.equal(a.length, 4);
    assert.deepEqual(a.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert.match(a[3], /^\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8/);
    assert.ok(a[3].endsWith('Write-Output "中文"'));
  });
});

describe('local_bash 工具说明', () => {
  const bash = () => toolDefs().find((t) => t.name === 'local_bash')!;
  test('Windows：说清默认是 cmd.exe，给可选的 shell: cmd | powershell', { skip: process.platform !== 'win32' }, () => {
    const t = bash();
    assert.match(t.description, /cmd\.exe/);
    assert.deepEqual(t.inputSchema.properties.shell.enum, ['cmd', 'powershell']);
  });
  test('mac / linux：工具面不变（没有 shell 参数）', { skip: process.platform === 'win32' }, () => {
    assert.equal(bash().inputSchema.properties.shell, undefined);
  });
});

describe('Windows 实测（local_bash）', { skip: process.platform !== 'win32' }, () => {
  const deps = { log: () => {}, notice: () => {} };
  const run = (dir: string, args: any) => callTool('local_bash', args, { sessionId: 's1', workdir: dir }, deps).then((r) => r.content[0].text);
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kx-winsh-'));

  test('dir /b 不存在的文件：stderr 可读，没有 U+FFFD', async () => {
    const out = await run(tmp(), { command: 'dir /b 不存在的文件.md' });
    assert.match(out, /\[stderr\]/);
    assert.equal(out.includes('�'), false, out);
  });

  test('echo 中文>>x.txt 写进去的是 UTF-8', async () => {
    const dir = tmp();
    const out = await run(dir, { command: 'echo 中文>>x.txt' });
    assert.match(out, /exit 0/);
    assert.equal(fs.readFileSync(path.join(dir, 'x.txt'), 'utf8').trim(), '中文');
  });

  test('shell: powershell 跑 Write-Output 中文', async () => {
    const out = await run(tmp(), { command: 'Write-Output 中文; Write-Output "a b" \'c "d"\'', shell: 'powershell' });
    assert.match(out, /exit 0/);
    assert.match(out, /中文/);
    assert.match(out, /a b\r?\nc "d"/);
    assert.equal(out.includes('�'), false, out);
  });

  test('shell: powershell 的报错是可读文字（不是 #< CLIXML）', async () => {
    const out = await run(tmp(), { command: 'Get-Item 不存在的文件', shell: 'powershell' });
    assert.match(out, /^\[exit 1\]/);
    assert.match(out, /\[stderr\]\nGet-Item/);
    assert.equal(out.includes('CLIXML'), false, out);
  });

  test('退出码照旧', async () => {
    assert.match(await run(tmp(), { command: 'exit /b 3' }), /^\[exit 3\]/);
    assert.match(await run(tmp(), { command: 'exit 4', shell: 'powershell' }), /^\[exit 4\]/);
  });

  /*
    审查打回：两层 cmd 之后，execFile 的超时只结束外层，跑命令的内层 cmd 还活着、命令接着跑。
    这里让命令一直往文件里追加：超时返回之后文件不能再变大。
  */
  test('超时：真正跑命令的那层 cmd 也被结束，命令不再继续；结果和原来一样是 [exit 1]', async () => {
    const dir = tmp();
    const tick = path.join(dir, 'tick.txt');
    const t0 = Date.now();
    const out = await run(dir, { command: 'for /l %i in (1,1,100000000) do @echo %i>>tick.txt', timeoutMs: 1500 });
    assert.ok(Date.now() - t0 < 20_000, `超时没生效：${Date.now() - t0} ms`);
    assert.match(out, /^\[exit 1\]/);
    assert.ok(fs.existsSync(tick), '命令根本没跑起来');
    await new Promise((r) => setTimeout(r, 500));
    const size = fs.statSync(tick).size;
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(fs.statSync(tick).size, size, '超时之后命令还在往文件里写');
  });
});

describe('bg_run / watch / checkCommand：同一条执行路径', () => {
  const managers: BgJobManager[] = [];
  afterEach(async () => { for (const m of managers.splice(0)) await m.stopAll(); });
  const harness = () => {
    const wakes: string[] = [];
    const m = new BgJobManager({ wake: (_s, text) => { wakes.push(text); }, note: () => {}, changed: () => {}, log: () => {}, coalesceMs: 20 });
    managers.push(m);
    return { m, wakes };
  };
  const NODE = `"${process.execPath}"`;
  const waitFor = async (cond: () => boolean, what: string) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > 120_000) assert.fail(`等不到：${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  test('outputTail 从一个字中间切开：不出现 U+FFFD，也不被当成别的编码', () => {
    const buf = Buffer.from(`头${'中文'.repeat(50)}`, 'utf8');
    const t = outputTail(buf, buf.length - 4, 'zh');   // 切在「头」后面第一个字的中间
    const body = t.split('\n').slice(1).join('\n');
    assert.equal(body.includes('�'), false, body);
    assert.ok(body.endsWith('中文'));
  });

  test('watch：一个字被拆在两次输出里，事件里照样是完整的字', async () => {
    const h = harness();
    const js = 'process.stdout.write(Buffer.from([0xe4,0xb8]));setTimeout(()=>process.stdout.write(Buffer.from([0xad,0x0a])),300)';
    const r = h.m.start({ sessionId: 's1', kind: 'watch', command: `${NODE} -e "${js}"`, label: '拆开的字', cwd: os.tmpdir(), timeoutMs: 300_000 });
    assert.ok(r.ok);
    await waitFor(() => h.wakes.some((w) => /中/.test(w)), '事件里有「中」');
    assert.equal(h.wakes.some((w) => w.includes('�')), false, h.wakes.join('\n---\n'));
  });

  test('Windows：bg_run 的 echo 中文>>x.txt 写进去的是 UTF-8，输出也是可读中文', { skip: process.platform !== 'win32' }, async () => {
    const h = harness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-winsh-bg-'));
    const r = h.m.start({ sessionId: 's1', kind: 'run', command: 'echo 中文>>x.txt & echo 中文 & dir /b 不存在的文件.md', label: 'utf8', cwd: dir, timeoutMs: 300_000 });
    assert.ok(r.ok);
    await waitFor(() => h.wakes.length > 0, '结束唤醒');
    assert.equal(fs.readFileSync(path.join(dir, 'x.txt'), 'utf8').trim(), '中文');
    assert.match(h.wakes[0], /中文/);
    assert.equal(h.wakes[0].includes('�'), false, h.wakes[0]);
  });

  test('Windows：checkCommand（runCheck）同样按 UTF-8', { skip: process.platform !== 'win32' }, async () => {
    const h = harness();
    const r = await h.m.runCheck({ sessionId: 's1', command: 'echo 中文& exit /b 1', cwd: os.tmpdir(), timeoutMs: 300_000 });
    assert.equal(r.status, 'exited');
    assert.equal(r.status === 'exited' && r.code, 1);
    assert.match(r.output, /中文/);
  });
});
