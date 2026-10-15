import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * 「看一下有没有 windows 上不能跑的东西」→「都修」。
 *
 * 全量审计的完整清单在 `docs/WINDOWS_GAPS.md`。这里锚住修掉的那些 ——
 * 每一条都写清"不修会怎样"，因为它们的共同特点是**在 macOS 上测不出来**：
 * 代码跑得通、测试全绿，只有在 Windows 上才是错的。
 */

const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

describe('二进制发现（Windows 上的首次使用）', () => {
  test('`connect()` 用同一个解析器 —— 裸名字不该被悄悄丢掉', () => {
    const A = fs.readFileSync(path.join(process.cwd(), 'src/main/acp-client.ts'), 'utf8');
    /*
      原来 connect 自己写了一遍"挨个 fs.existsSync"，于是配置里填 `kiro-cli`（PATH 上的名字）
      会被拒，而那个名字明明能跑。Windows 上最疼：磁盘上总是带 `.exe`，人很自然填不带的,
      然后被拒 —— 而自动检测在 Windows 上又是死的，于是没有任何一条路能配好。
    */
    assert.match(A, /const cliPath = resolveKiroCli\(\);/);
    const at = A.indexOf("} else {\n        /* 没配就不起");
    const body = A.slice(at, at + 1600);
    assert.equal(/for \(const p of possiblePaths\)/.test(body), false, '不该再自己循环 existsSync');
    /* `resolveKiroCli` 本来就处理了裸名字 */
    assert.ok(A.includes("if (!p.includes('/') && !p.includes('\\\\')) return p;"),
      'resolveKiroCli 里那条"裸名字直接用"要还在');
  });

  test('Windows 上的本机探测走 Node，不走 bash', async () => {
    /* `detectScript()` 是 POSIX shell；Windows 上没有 bash → 那两颗按钮 ENOENT，
       而 `kiroBinProblem()` 在配好之前拒绝起任何会话 —— 没有出路 */
    const at = M.indexOf("ipcMain.handle('bins:detect'");
    const body = M.slice(at, at + 1800);
    assert.match(body, /process\.platform === 'win32'/);
    assert.match(body, /await detectWindows\(probeOneLocal\)/);
    /* 远端那一半照旧走脚本（远端是 Linux） */
    assert.match(body, /parseDetect\(await runProbe\(machine, detectScript\(\)\)\)/);
    /* 「测试」那颗按钮同理 */
    const at2 = M.indexOf("ipcMain.handle('bins:test'");
    assert.match(M.slice(at2, at2 + 1400), /process\.platform === 'win32'/);
  });

  test('PATHEXT：`kiro-cli` 的真实文件叫 `kiro-cli.exe`', async () => {
    const { windowsPathExts, whichAll } = await import('../src/main/binDetect.ts');
    const exts = windowsPathExts({ PATHEXT: '.COM;.EXE;.BAT;.CMD' } as any);
    assert.equal(exts[0], '', '空串排第一 —— 配置里可能填的就是已经带后缀的名字');
    assert.ok(exts.includes('.exe'));
    /* npm 装的工具是 `.cmd` shim，不认它就找不到 claude / codex */
    assert.ok(exts.includes('.cmd'));
    /* PATHEXT 没设时给一个合理默认 */
    assert.ok(windowsPathExts({} as any).includes('.exe'));

    const fake = new Set(['C:\\bin\\kiro-cli.exe', 'C:\\bin\\other']);
    const hits = whichAll('kiro-cli',
      { PATH: 'C:\\bin;C:\\nope', PATHEXT: '.EXE;.CMD' } as any,
      (p) => fake.has(p));
    assert.deepEqual(hits, ['C:\\bin\\kiro-cli.exe']);
  });

  test('`%VAR%` 展不开就丢掉这个候选，不拼出一条半截路径', async () => {
    const { expandWinVars } = await import('../src/main/binDetect.ts');
    assert.equal(
      expandWinVars('%LOCALAPPDATA%\\Kiro-Cli\\kiro-cli.exe', { LOCALAPPDATA: 'C:\\Users\\k\\AppData\\Local' } as any),
      'C:\\Users\\k\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe',
    );
    /* 变量没设 → 空串。拼成 `\Kiro-Cli\kiro-cli.exe` 会去查一个根目录下的路径 */
    assert.equal(expandWinVars('%NOPE%\\x.exe', {} as any), '');
  });

  test('探测到的候选按真实路径去重，版本输出还要像那个工具', async () => {
    const { detectWindows } = await import('../src/main/binDetect.ts');
    /* 同一个文件从两条路进来（PATH 上的名字 + 绝对路径）只该报一次 */
    const res = await detectWindows(
      async () => ({ ok: true, first: 'kiro-cli 2.24.1' }),
      [{
        id: 'kiro', label: 'kiro-cli', names: ['kiro-cli'],
        paths: [], winPaths: ['%LA%\\kiro-cli.exe'],
        versionArg: '--version', verify: /kiro[-_ ]?cli/i,
      }] as any,
      { PATH: 'C:\\bin', PATHEXT: '.EXE', LA: 'C:\\bin' } as any,
      (p) => p,
      (p) => p === 'C:\\bin\\kiro-cli.exe',
    );
    assert.equal(res.kiro.length, 1, '同一个文件只报一次');
    assert.equal(res.kiro[0].ok, true);
    assert.match(String(res.kiro[0].version), /kiro-cli 2\.24\.1/);
  });

  test('版本输出不像那个工具 → 报不可用并说清（假阳性比没检测到糟）', async () => {
    const { detectWindows } = await import('../src/main/binDetect.ts');
    /* 实测踩过：PATH 上的 `kiro` 是 Kiro IDE 的 CLI，和 kiro-cli 完全两个东西 */
    const res = await detectWindows(
      async () => ({ ok: true, first: '0.12.333 (abc1234)' }),
      [{
        id: 'kiro', label: 'kiro-cli', names: ['kiro'], paths: [],
        versionArg: '--version', verify: /kiro[-_ ]?cli/i,
      }] as any,
      { PATH: 'C:\\bin', PATHEXT: '.EXE' } as any,
      (p) => p,
      (p) => p === 'C:\\bin\\kiro.exe',
    );
    assert.equal(res.kiro[0].ok, false);
    assert.match(String(res.kiro[0].error), /版本输出不像/);
  });
});

describe('路径：`\\` 和 `/` 都要认', () => {
  test('会话草稿目录的判据不能只认 `/`', async () => {
    const { isSessionScratchDir } = await import('../src/renderer/pathBits.ts');
    /*
      不认 `\` 的后果不是"少一个判断"：那个目录会被当成**真的工作目录**显示出来，
      而 ChatArea 里那段注释说的正是"标成工作目录是在骗人"。
    */
    assert.equal(isSessionScratchDir('C:\\Users\\k\\.kirolex\\sessions\\s_1'), true);
    assert.equal(isSessionScratchDir('/Users/k/.kirolex/sessions/s_1'), true);
    assert.equal(isSessionScratchDir('C:\\Users\\k\\git\\proj'), false);
    assert.equal(isSessionScratchDir(''), false);
  });

  test('basename 两种分隔符都对', async () => {
    const { baseName } = await import('../src/renderer/pathBits.ts');
    assert.equal(baseName('C:\\Users\\k\\proj'), 'proj');
    assert.equal(baseName('/Users/k/proj'), 'proj');
    /* 末尾的分隔符要忽略 —— `'/a/b/'` 的 basename 是 `b` 而不是空串 */
    assert.equal(baseName('/a/b/'), 'b');
    assert.equal(baseName('C:\\a\\b\\'), 'b');
    assert.equal(baseName('single'), 'single');
    assert.equal(baseName(''), '');
  });

  test('拼路径沿用左边那段的分隔符', async () => {
    const { joinPath } = await import('../src/renderer/pathBits.ts');
    /* 一律用 `/` 的话 Windows 上显示成 `C:\Users\k/sub`，每进一层多混一个斜杠 */
    assert.equal(joinPath('C:\\Users\\k', 'sub'), 'C:\\Users\\k\\sub');
    assert.equal(joinPath('/Users/k', 'sub'), '/Users/k/sub');
    assert.equal(joinPath('/Users/k/', 'sub'), '/Users/k/sub');
    assert.equal(joinPath('', 'sub'), 'sub');
  });

  test('那几处显示用的 basename 都换掉了', () => {
    const APP = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
    const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
    const WP = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/WorkspacePanel.tsx'), 'utf8');
    /* `'C:\x\a.ts'.split('/').pop()` 回的是整条路径 → 标签页和标题显示一长条 */
    assert.equal(/\.split\('\/'\)\.pop\(\)/.test(APP), false);
    assert.equal(/split\('\/'\)\.filter\(Boolean\)\.pop\(\)/.test(CA), false);
    assert.match(WP, /joinPath\(listing\.path, entry\.name\)/);
    /* Dockerfile / Makefile 的高亮靠 basename 匹配 */
    assert.match(APP, /const name = baseName\(String\(p \|\| ''\)\.trim\(\)\);/);
  });

  test('`file:///C:/…` 要能解出 `C:/…`', async () => {
    /* 只剥 `file://` 的话剩 `/C:/Users/…`：isAbsolute 接受、statSync 拒绝 */
    const mod = await import('../src/main/index.ts').catch(() => null);
    /* index.ts 拉起整个 Electron，不能直接 import —— 按文本锚 */
    void mod;
    assert.match(M, /export function stripFileUrl\(input: unknown\): string \{/);
    assert.ok(M.includes('if (/^\\/[A-Za-z]:/.test(p)) p = p.slice(1);'),
      'Windows 盘符前那个斜杠是 URL 的，不是路径的');
    /* 四处原来各写一遍，现在统一走它 */
    /*
      四处**调用点**原来各写一遍 `.trim().replace(/^file:\/\//, '')`，现在都走 stripFileUrl。
      只查调用点那个形状 —— `stripFileUrl` 自己的实现里当然有一个 replace，
      文件头那段注释里也会提到旧写法（在解释为什么改）。
    */
    assert.equal(/\.trim\(\)\.replace\(\/\^file:/.test(M), false, '调用点不该再就地剥前缀');
    /* path-exists / open-external 后来并进了 resolveUserPath（相对路径按会话目录解析），调用点少了两处，
       但每个入口仍然经过它 */
    assert.ok((M.match(/stripFileUrl\(/g) || []).length >= 3);
    assert.match(M, /function resolveUserPath\(filePath: string, sessionId\?: string \| null\): string \{\r?\n    let p = stripFileUrl\(filePath\);/);
    /* percent-encoding 也要解 —— `file://` URL 里空格是 %20 */
    assert.match(M, /decodeURIComponent\(p\)/);
  });
});

describe('本地工具在 Windows 上不能是 ENOENT', () => {
  const L = fs.readFileSync(path.join(process.cwd(), 'src/main/localMcp.ts'), 'utf8');

  test('find / grep / bash 三条都有 Windows 分支', () => {
    /*
      这些工具跑在**用户那台机器**上（远端通过反向隧道调过来），所以 Windows 用户
      一开远程会话就会碰到。而模型会把"工具报错"解释成"这个东西不存在"。
    */
    assert.match(L, /if \(process\.platform === 'win32'\) \{\s*const hits = globNative/);
    assert.match(L, /if \(process\.platform === 'win32'\) \{\s*const hits = grepNative/);
    assert.match(L, /process\.env\.ComSpec \|\| 'cmd\.exe'/);
    /* 整条命令包一层引号 + windowsVerbatimArguments 原样交给 cmd —— Node 的 `\"` 转义 cmd.exe 不认 */
    assert.match(L, /export function cmdShellArgs\(command: string\): string\[\] \{\s*return \['\/d', '\/s', '\/c', `"\$\{command\}"`\];/);
    assert.match(L, /run\(process\.env\.ComSpec \|\| 'cmd\.exe', cmdShellArgs\(command\), cwd, timeoutMs, true\)/);
    assert.match(L, /windowsVerbatimArguments: verbatim/);
  });

  test('glob：`*` 不跨分隔符，`**/` 可以是零层目录', async () => {
    const { globToRegExp } = await import('../src/main/localMcp.ts');
    /* 不能用 `path.basename` —— 它在 macOS 上不认 `\`，会把整条 Windows 路径原样回来 */
    const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p;
    const hit = (pat: string, p: string): boolean => {
      const re = globToRegExp(pat);
      return re.test(/[\\/]/.test(pat) ? p : base(p));
    };
    assert.equal(hit('*.ts', 'C:\\x\\a.ts'), true);
    assert.equal(hit('*.ts', 'C:\\x\\a.js'), false);
    assert.equal(hit('src/*.ts', 'C:\\p\\src\\a.ts'), true);
    assert.equal(hit('src/*.ts', 'C:\\p\\src\\sub\\a.ts'), false, '单星不跨分隔符');
    assert.equal(hit('src/**/*.ts', 'C:\\p\\src\\sub\\deep\\a.ts'), true);
    /* **零层目录**也要命中 —— 漏了它的表现是"明明有这个文件，搜不到" */
    assert.equal(hit('src/**/*.ts', '/p/src/a.ts'), true);
  });

  test('遍历跳过 node_modules / .git，而且有上限', async () => {
    const { walkFiles, NATIVE_WALK_LIMIT, globNative, grepNative } = await import('../src/main/localMcp.ts');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-'));
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'a.ts'), 'x');
    fs.writeFileSync(path.join(root, '.git', 'b.ts'), 'x');
    fs.writeFileSync(path.join(root, 'src', 'c.ts'), 'hello needle here');
    const files = walkFiles([root]);
    assert.equal(files.some((f) => f.includes('node_modules')), false);
    assert.equal(files.some((f) => f.includes('.git')), false);
    assert.equal(files.length, 1);
    /* 没有上限的话一棵大树能把主进程卡住几十秒 */
    assert.ok(NATIVE_WALK_LIMIT > 0);
    assert.deepEqual(globNative([root], '*.ts').map((f) => path.basename(f)), ['c.ts']);
    /* 输出格式对齐 `grep -rn`：路径:行号:内容 */
    const g = grepNative([root], 'needle');
    assert.equal(g.length, 1);
    assert.match(g[0], /c\.ts:1:hello needle here$/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('二进制文件跳过 —— 一个 png 能吐几千行乱码把上下文吃光', async () => {
    const { grepNative } = await import('../src/main/localMcp.ts');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-'));
    fs.writeFileSync(path.join(root, 'a.bin'), Buffer.from([0x68, 0x00, 0x69]));  // 含 NUL
    fs.writeFileSync(path.join(root, 'b.txt'), 'hi');
    /* 输出是 `路径:行号:内容`，从**尾巴**剥 —— 按第一个 `:` 切会切在 Windows 盘符 `C:` 上 */
    assert.deepEqual(grepNative([root], 'h').map((x) => path.basename(x.replace(/:\d+:.*$/s, ''))), ['b.txt']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('提示语和换行', () => {
  test('单实例锁那句按平台给收拾办法', () => {
    /* 那是 app 拒绝启动时唯一的一句话，叫 Windows 用户去跑 `pkill` 没用 */
    assert.match(M, /taskkill \/F \/IM electron\.exe/);
    assert.match(M, /process\.platform === 'win32'\s*\n?\s*\? '任务管理器里结束/);
  });

  test('"绝对路径"的说明不写死 `/`', async () => {
    const P = fs.readFileSync(path.join(process.cwd(), 'src/main/projectStore.ts'), 'utf8');
    assert.ok(P.includes("tr('Must be an absolute path (like C:\\\\Users\\\\you\\\\project)')"), 'Windows 上要给 Windows 的例子');
  });

  test('.gitattributes 钉住 .sh 的 LF', () => {
    /*
      `scripts/remote-bootstrap.sh` 会被读出来管道给**远端 Linux 的 bash**。
      Windows clone 带 CRLF 的话远端报 `$'\r': command not found`，
      而那条错误看不出跟换行有关。
    */
    const G = fs.readFileSync(path.join(process.cwd(), '.gitattributes'), 'utf8');
    assert.match(G, /\*\.sh\s+text eol=lf/);
    assert.match(G, /\* text=auto eol=lf/);
  });
});

/*
 * 「有一些问题会给用户提问并提供多个选项，这个怎么处理的」。
 *
 * kiro-cli 的 ACP 里**没有**这种方法 —— 翻过那个二进制里所有方法名，会向客户端要答案的
 * 只有 `session/request_permission`（工具授权），`session/request_user_input` / `ask` /
 * `choice` 这类一个都没有。所以模型想让你选，只能把选项写进回复文字里。
 *
 * 也就是说这里没有任何结构化信息，只能从 markdown 认 —— 而"认"必然误判，
 * 所以每一条判据都在挡一种具体的误判。
 */
describe('模型列出来的选项变成可点的片', () => {
  test('问号或冒号 + 至少两项编号 → 认', async () => {
    const { extractChoiceChips } = await import('../src/renderer/choiceChips.ts');
    assert.equal(extractChoiceChips('你想用哪种方式？\n\n1. 直接改\n2. 先出方案\n3. 我自己来').length, 3);
    assert.equal(extractChoiceChips('有三个选择：\n1. A\n2. B').length, 2);
    /* 字母、`)`、`、`、前面带 `-` 的都要认 —— 模型的写法不统一 */
    assert.equal(extractChoiceChips('选哪个？\nA) 保留\nB) 覆盖').length, 2);
    assert.equal(extractChoiceChips('怎么做？\n- 1. 快的\n- 2. 稳的').length, 2);
    /* 空行不打断：`1.\n\n2.` 是常见写法 */
    assert.equal(extractChoiceChips('选？\n1. a\n\n2. b').length, 2);
  });

  test('没有"在问你"的信号 → 不显示', async () => {
    const { extractChoiceChips } = await import('../src/renderer/choiceChips.ts');
    /* "我做了三件事" 那种说明变成按钮会让人以为要选一个 */
    assert.deepEqual(extractChoiceChips('我做了三件事\n1. 改了 a\n2. 改了 b'), []);
  });

  test('代码块里的编号 → 不显示（最容易误判的一类）', async () => {
    const { extractChoiceChips } = await import('../src/renderer/choiceChips.ts');
    assert.deepEqual(extractChoiceChips('看这段？\n```\n1. foo\n2. bar\n```'), []);
    assert.deepEqual(extractChoiceChips('看这段？\n~~~\n1. foo\n2. bar\n~~~'), []);
  });

  test('一项 / 太长 / 太多 都不显示', async () => {
    const { extractChoiceChips, MAX_ITEM_CHARS, MAX_CHIPS } = await import('../src/renderer/choiceChips.ts');
    assert.deepEqual(extractChoiceChips('要不要？\n1. 好'), [], '一项不叫选项');
    assert.deepEqual(extractChoiceChips(`选？\n1. ${'x'.repeat(MAX_ITEM_CHARS + 1)}\n2. y`), [],
      '长段落的编号列表是文档，不是菜单');
    const many = Array.from({ length: MAX_CHIPS + 1 }, (_, i) => `${i + 1}. o${i}`).join('\n');
    assert.deepEqual(extractChoiceChips(`选？\n${many}`), [], '更多的话几乎肯定是清单');
  });

  test('一条消息里有多段列表时取**最后**那段', async () => {
    const { extractChoiceChips } = await import('../src/renderer/choiceChips.ts');
    /* 常见形状：先复述一遍做过的事，最后才问你 */
    const chips = extractChoiceChips('先说明：\n1. 旧的\n2. 旧的2\n\n那么你选哪个？\n1. 新A\n2. 新B');
    assert.deepEqual(chips.map((c) => c.value), ['新A', '新B']);
  });

  test('点了**填进输入框，不发送**', () => {
    const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
    /*
      这类回答最常见的形状是"2，但用 TypeScript"—— 自动发会把补一句的机会拿掉。
      而万一认错了，填进去还能删，发出去就收不回。
    */
    assert.match(CA, /onClick=\{\(\) => setInput\(\(prev\) =>/);
    assert.match(CA, /not sent yet/);
    /* 流式过程中不显示：那份文字是半截的，片会一项一项闪出来 */
    assert.match(CA, /\{!isStreaming && !isLooping && choiceChips\.length > 0 && \(/);
    /* 最后说话的是用户 → 没有待答的问题 */
    assert.match(CA, /if \(msg\.role === 'user'\) return \[\];/);
  });

  test('这是唯一的办法 —— 协议里确实没有这种方法', () => {
    /*
      锚住这个事实：如果哪天 kiro-cli 真加了 `session/request_user_input`，
      这条测试不会失败（它不该失败），但那段注释会提醒下一个人先去看协议，
      而不是继续往正则里堆判据。
    */
    const C = fs.readFileSync(path.join(process.cwd(), 'src/renderer/choiceChips.ts'), 'utf8');
    assert.match(C, /kiro-cli 的 ACP 里\*\*没有\*\*"问用户一个带选项的问题"这种方法/);
    assert.match(C, /session\/request_permission/);
  });
});

/*
 * 「你建一个会话测试一下呢？cli 里面是会有选项的」——测了，结论是**选项在 ACP 上全是纯文本**。
 *
 * 直接驱动 `kiro-cli acp` 抓原始 JSON-RPC（2.24.1）：
 *
 *   · 让模型"给三个方案等我选" → 只有 `session/update / agent_message_chunk`,
 *     `stopReason: end_turn`，**零个 REQUEST**；
 *   · `/model`（终端里是上下键 picker）→ 回来是纯文本列表，当前那个用 `→` 标;
 *   · `/agent` → 同样是纯文本，还会把每个 agent 的整段 description 都刷出来;
 *   · `initialize` 回的 `agentCapabilities` 里 `sessionCapabilities: {}`、`auth: {}`,
 *     没有任何"能问用户"的能力位。
 *
 * 所以 picker 是 TUI 的东西，ACP 不带它。而 KiroLex 本来就有真正的模型/agent 下拉 ——
 * 把这两条命令发给 kiro-cli 只会得到最差的那个版本，还占掉一轮。
 */
describe('`/model` `/agent` 走 KiroLex 自己的下拉', () => {
  test('只认"整条输入就是这个命令"', async () => {
    const { slashIntent } = await import('../src/renderer/slashPicker.ts');
    assert.deepEqual(slashIntent('/model'), { kind: 'model', arg: '' });
    assert.deepEqual(slashIntent('/model gpt-5.6-sol'), { kind: 'model', arg: 'gpt-5.6-sol' });
    assert.deepEqual(slashIntent('/AGENT kiro_default'), { kind: 'agent', arg: 'kiro_default' });
    /* 出现在句子中间时那是在**讨论**它，不是在用它 */
    assert.equal(slashIntent('帮我看看 /model 是什么'), null);
    assert.equal(slashIntent('/models'), null);
    assert.equal(slashIntent(''), null);
  });

  test('参数匹配：精确 → 唯一前缀 → 多义就**不猜**', async () => {
    const { resolveChoice } = await import('../src/renderer/slashPicker.ts');
    const opts = ['auto', 'claude-opus-5', 'claude-opus-5.5', 'gpt-5.6-sol'];
    assert.equal(resolveChoice('GPT-5.6-SOL', opts).exact, 'gpt-5.6-sol', '大小写不敏感');
    assert.equal(resolveChoice('gpt', opts).exact, 'gpt-5.6-sol', '唯一前缀可以');
    /* 换错模型要等到账单或者输出风格变了才会被发现 —— 所以多义时报候选，不挑一个 */
    assert.equal(resolveChoice('claude', opts).exact, undefined);
    assert.equal(resolveChoice('claude', opts).matches.length, 2);
    assert.equal(resolveChoice('nope', opts).matches.length, 0);
  });

  test('接在发送路径上，不再发给 kiro-cli', () => {
    const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
    assert.match(CA, /const intent = slashIntent\(text\);\s*\n\s*if \(intent\) \{ onSlashPicker\(intent\); return; \}/);
    /* `/stop` 仍然透传 —— 那条是真的要发给 kiro-cli */
    assert.match(CA, /if \(text === '\/stop'\) \{\s*\n\s*onSend\(text\);/);
  });

  test('没参数就把原生下拉弹开；有参数走 KiroLex 自己的切换', () => {
    const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
    assert.match(CA, /\(el as any\)\.showPicker\?\.\(\)/);
    /* showPicker 在非用户手势时会抛 —— 兜底 focus，至少人知道该看哪儿 */
    assert.match(CA, /catch \{ el\.focus\(\); \}/);
    /*
      带参数**不能**让 kiro-cli 内部换：它不通知 KiroLex，下拉里显示的还是旧的。
      KiroLex 换模型走"重起执行器 + 改 agent JSON"那条路，两边状态才对得上。
    */
    assert.match(CA, /if \(isModel\) onModelChange\(exact\); else onKiroAgentChange\(exact\);/);
    /* 对不上时说清，并指回下拉 */
    assert.match(CA, /setLocalNotice\(matches\.length/);
    assert.match(CA, /to open the dropdown/);
  });

  test('那句本地提示和主进程那条共用同一个位置，换会话清掉', () => {
    const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
    /* 同一类东西（KiroLex 自己对你说的）不该有两个落点 */
    assert.match(CA, /\{localNotice && \(\s*\n\s*<div className="session-notice">/);
    assert.match(CA, /React\.useEffect\(\(\) => \{ setLocalNotice\(null\); \}, \[currentSessionId\]\);/);
  });

  test('`/model` 的纯文本输出不会被选项片误认', async () => {
    const { extractChoiceChips } = await import('../src/renderer/choiceChips.ts');
    /* 真实形状（实测抓到的）：没有编号，而且不是提问 */
    const out = 'Available models:\n\n  auto (auto)\n  gpt-5.6-sol (gpt-5.6-sol)\n→ gpt-5.6-luna (gpt-5.6-luna)';
    assert.deepEqual(extractChoiceChips(out), []);
  });
});
