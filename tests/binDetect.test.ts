import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOOLS, detectScript, testScript, parseDetect, parseTest,
  rememberBin, mergeHistory, MAX_HISTORY, PROBE_TIMEOUT_SEC,
} from '../src/main/binDetect.ts';

/*
 * 「把 kiro-cli 那几个工具分别自动检测位置和启动命令、自动检测是否能正常启动、
 *   记住历史成功的启动命令或位置」。
 *
 * 三件事各自防的是不同的错：
 *   · 检测 —— 同一台机器上可能有两个 kiro-cli，而手写路径错一个字母的表现是"执行器起不来"，
 *     跟"机器没开"、"没登录"长得一样。
 *   · 验证 —— **找到文件 ≠ 能跑**。
 *   · 记住 —— 一个曾经真的起过会话的命令，比任何检测结果都可信。
 */
describe('探测脚本：一份判据，两台机器', () => {
  test('每个被测命令都 `< /dev/null` —— 有的 CLI 读 stdin，不给 EOF 就会挂住', () => {
    /* 实测踩过：远端 `claude-code-acp --version` 读 stdin，把用 `bash -s` 喂进去的脚本
       剩余部分整段吞掉，然后"成功"退出 —— 自检根本没跑。挂住的探测比探测失败更糟。 */
    const s = detectScript();
    assert.match(s, /< \/dev\/null/);
    assert.match(s, new RegExp(`timeout ${PROBE_TIMEOUT_SEC}`));
    assert.match(testScript('kiro-cli'), /< \/dev\/null/);
  });

  test('先 PATH 上的名字，再绝对路径；同一个真实文件只报一次', () => {
    const s = detectScript();
    /* PATH 上那个才是"你平时用的那个"，绝对路径是兜底 */
    assert.ok(s.indexOf('command -v kiro-cli') < s.indexOf('$HOME/.local/bin/kiro-cli'));
    /* 去重按 `command -v` 解析后的真实路径 —— 否则 `kiro-cli` 和 `/usr/local/bin/kiro-cli`
       会被报成两个"不同的"候选，而它们其实是同一个文件 */
    assert.match(s, /real=\$\(command -v "\$3" 2>\/dev\/null \|\| echo "\$3"\)/);
    /* 而且**符号链接要解开**：实测 `/opt/homebrew/bin/claude` 和 `~/.local/bin/claude`
       指向同一个 `claude.exe`，不解开就会在候选里出现两次 —— 列表里有重复就毁掉了它的意义 */
    assert.match(s, /canon=\$\(readlink -f "\$real" 2>\/dev\/null \|\| echo "\$real"\)/);
    assert.match(s, /case " \$seen " in \*" \$canon "\*\) return 0;; esac/);
  });

  test('三个工具都在，kiro 的候选里带上常见安装位置', () => {
    assert.deepEqual(TOOLS.map((t) => t.id), ['kiro', 'claude', 'codex']);
    const kiro = TOOLS[0];
    assert.ok(kiro.paths.some((p) => p.includes('.local/bin/kiro-cli')));
    assert.ok(kiro.paths.some((p) => p.includes('/opt/homebrew/bin/kiro-cli')));
  });

  test('解析：ok / bad 分开，版本和原因都留下', () => {
    const out = [
      'Welcome to Amazon Linux 2023',                       // shell 的欢迎语要被忽略
      'KX_BIN kiro ok kiro-cli :: /home/u/.local/bin/kiro-cli | kiro-cli 1.27.0',
      'KX_BIN kiro bad /opt/homebrew/bin/kiro-cli :: /opt/homebrew/bin/kiro-cli | exit 127 not found',
      'KX_BIN claude ok claude :: /usr/local/bin/claude | 2.1.4 (Claude Code)',
      '随便一行别的东西',
    ].join('\n');
    const r = parseDetect(out);
    assert.deepEqual(r.kiro.map((c) => [c.command, c.ok]), [['kiro-cli', true], ['/opt/homebrew/bin/kiro-cli', false]]);
    assert.equal(r.kiro[0].version, 'kiro-cli 1.27.0');
    /* 解析后的真实文件也要带上 —— 历史合并要靠它（见下面那条） */
    assert.equal(r.kiro[0].real, '/home/u/.local/bin/kiro-cli');
    assert.match(r.kiro[1].error!, /127/);
    assert.equal(r.claude.length, 1);
    assert.deepEqual(r.codex, []);
  });

  test('**跑得起来还不够，得是这个工具** —— PATH 上的 `kiro` 是 Kiro IDE 的 CLI，不是 kiro-cli', () => {
    /* 实测的假阳性：`kiro --version` 回 `0.12.333`（+ 一个 git sha），
       和 `kiro-cli 2.23.1` 完全是两个东西。名字像不代表是它，而配错二进制的表现是
       "执行器起不来"或者"起来了行为莫名不对"。 */
    const r = parseDetect('KX_BIN kiro ok kiro :: /Users/k/.toolbox/bin/kiro | 0.12.333');
    assert.equal(r.kiro[0].ok, false);
    assert.match(r.kiro[0].error!, /看着不是 kiro-cli/);
    assert.equal(r.kiro[0].version, '0.12.333', '它报的那句还要留着 —— 你得看到它到底是什么');
    /* 真的 kiro-cli 照常通过 */
    assert.equal(parseDetect('KX_BIN kiro ok kiro-cli :: /x/kiro-cli | kiro-cli 2.23.1').kiro[0].ok, true);
  });

  test('单个测试的结果也分得开"能起来"和"起不来"', () => {
    assert.deepEqual(parseTest('KX_BIN ok | kiro-cli 1.27.0'), { ok: true, version: 'kiro-cli 1.27.0' });
    assert.equal(parseTest('KX_BIN bad | exit 127 command not found').ok, false);
    /* 什么都没拿到 ≠ 起不来：那是"连不上/那台机器没回话"，说法必须不一样 */
    assert.match(parseTest('').error!, /没有拿到探测结果/);
  });

  test('**脚本真的能在本机跑**（这条是端到端的：拼错一个引号就会在这里露出来）', async () => {
    const out = await new Promise<string>((resolve, reject) => {
      execFile('bash', ['-lc', detectScript()], { timeout: 60_000, encoding: 'utf8' },
        (err, stdout) => (String(stdout || '').includes('KX_BIN_DONE') ? resolve(String(stdout)) : reject(err || new Error(stdout))));
    });
    assert.match(out, /KX_BIN_DONE/);
    /* 这台机器上装了 kiro-cli，所以至少要认出它 —— 认不出说明探测逻辑坏了 */
    const r = parseDetect(out);
    assert.ok(r.kiro.length > 0, `没检测到 kiro-cli：${out.slice(0, 400)}`);
    assert.ok(r.kiro.some((c) => c.ok), 'kiro-cli 应该能跑 --version');
  });

  test('bash -lc 跑单条测试也要真的能跑（版本号能拿到）', async () => {
    const out = await new Promise<string>((resolve) => {
      execFile('bash', ['-lc', testScript('bash')], { timeout: 30_000, encoding: 'utf8' },
        (_e, stdout) => resolve(String(stdout || '')));
    });
    const r = parseTest(out);
    assert.equal(r.ok, true, out);
    assert.match(r.version || '', /bash/i);
  });
});

describe('记住历史：最近的在前，去重，有上限', () => {
  test('新的排最前面，重复的不占两个位置', () => {
    let m = rememberBin({}, 'local', 'kiro', '/usr/local/bin/kiro-cli');
    m = rememberBin(m, 'local', 'kiro', '~/.local/bin/kiro-cli');
    m = rememberBin(m, 'local', 'kiro', '/usr/local/bin/kiro-cli');
    assert.deepEqual(m.local!.kiro, ['/usr/local/bin/kiro-cli', '~/.local/bin/kiro-cli']);
  });

  test('每台机器分开记（拿 A 机器的路径去 B 机器上起 = 起不来）', () => {
    let m = rememberBin({}, 'local', 'kiro', '/opt/homebrew/bin/kiro-cli');
    m = rememberBin(m, 'tokyo', 'kiro', '/home/ec2-user/.local/bin/kiro-cli');
    assert.deepEqual(m.local!.kiro, ['/opt/homebrew/bin/kiro-cli']);
    assert.deepEqual(m.tokyo!.kiro, ['/home/ec2-user/.local/bin/kiro-cli']);
  });

  test(`最多 ${MAX_HISTORY} 条 —— 你只会在最近几个里选`, () => {
    let m = {};
    for (let i = 0; i < 9; i += 1) m = rememberBin(m, 'local', 'kiro', `/bin/k${i}`);
    assert.equal((m as any).local.kiro.length, MAX_HISTORY);
    assert.equal((m as any).local.kiro[0], '/bin/k8');
  });

  test('空命令 / 空机器名不记（那不是"一条历史"）', () => {
    assert.deepEqual(rememberBin({}, 'local', 'kiro', '   '), {});
    assert.deepEqual(rememberBin({}, '', 'kiro', '/bin/k'), {});
  });

  test('历史里那条和检测到的是**同一个文件**时要合并，不能报成"没检测到"', () => {
    /* 实测踩到：历史记的是 `/Users/k/.local/bin/kiro-cli`（执行器用的就是它），
       而这次检测报的是 PATH 上的 `kiro-cli` —— 同一个文件，却显示成一个刺眼的 ✗。 */
    const found = [{ command: 'kiro-cli', real: '/Users/k/.local/bin/kiro-cli', ok: true, version: '2.23.1' }];
    const merged = mergeHistory(found, ['/Users/k/.local/bin/kiro-cli']);
    assert.equal(merged.length, 1, '同一个文件不该出现两次');
    assert.equal(merged[0].ok, true);
    assert.equal(merged[0].known, true);
    assert.equal(merged[0].command, '/Users/k/.local/bin/kiro-cli', '显示历史里那个写法（你认得它）');
  });

  test('**历史排在检测结果前面**，而且这次没检测到也要显示', () => {
    const found = [
      { command: 'kiro-cli', ok: true, version: '1.27.0' },
      { command: '/usr/local/bin/kiro-cli', ok: true },
    ];
    const merged = mergeHistory(found, ['/usr/local/bin/kiro-cli', '/opt/gone/kiro-cli']);
    assert.deepEqual(merged.map((c) => c.command),
      ['/usr/local/bin/kiro-cli', '/opt/gone/kiro-cli', 'kiro-cli']);
    assert.equal(merged[0].known, true);
    /* 历史里那条现在不在了 —— 要显示出来并说清，"它昨天还好好的"本身就是线索 */
    assert.equal(merged[1].ok, false);
    assert.match(merged[1].error!, /以前起过/);
    assert.equal(merged[2].known, undefined);
  });
});

describe('接线：检测两台机器共用一段脚本；成功启动才记历史', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const A = fs.readFileSync(path.join(process.cwd(), 'src/main/acp-client.ts'), 'utf8');
  const R = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');

  test('同一段脚本：本机 `bash -lc`，远端 ssh —— 不许有两套判据', () => {
    assert.match(M, /function runProbe\(machine: string, script: string\)/);
    assert.match(M, /execFile\('bash', \['-lc', script\]/);
    assert.match(M, /execFile\('ssh', \[\.\.\.buildSshArgs\(target, `bash -lc \$\{shellQuote\(script\)\}`\)\]/);
    /* 脚本走 `-c` 而不是 stdin：`bash -s` 会被第一个读 stdin 的命令吞掉（实测踩过） */
    assert.equal(/bash', \['-s'/.test(M), false);
  });

  test('检测的结果**带上历史**（那是可信度最高的一档）', () => {
    assert.match(M, /const hist = binHistory\(KIROLEX_CONFIG_PATH\)\[machine\] \|\| \{\};/);
    assert.match(M, /kiro: mergeHistory\(found\.kiro, hist\.kiro\)/);
  });

  test('**连上了**才记那条命令（配置里那条可能是错的，这里是事实）', () => {
    assert.match(A, /launchedWith\?: string;/);
    assert.match(A, /this\.launchedWith = cliPath;/);
    assert.match(M, /rememberBinSuccess\(KIROLEX_CONFIG_PATH, machine, 'kiro' as ToolId, client\.launchedWith\)/);
    /* 顺序：connect 成功 → remember → 返回 */
    const at = M.indexOf('await client.connect();');
    const rem = M.indexOf('remember(client);', at);
    const ret = M.indexOf('return { client, model };', at);
    assert.ok(at > 0 && rem > at && ret > rem);
  });

  test('没变化就不写盘（这个函数每次 attach 都会被调到）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binhist-'));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ remotes: [] }));
    const { rememberBinSuccess, binHistory } = await import('../src/main/remoteTargets.ts');
    rememberBinSuccess(cfg, 'local', 'kiro', '/bin/kiro-cli');
    const t1 = fs.statSync(cfg).mtimeMs;
    rememberBinSuccess(cfg, 'local', 'kiro', '/bin/kiro-cli');
    assert.equal(fs.statSync(cfg).mtimeMs, t1, '同一条命令不该再写一遍');
    assert.deepEqual(binHistory(cfg).local!.kiro, ['/bin/kiro-cli']);
  });

  test('界面：一个「自动检测」按钮 + 每个工具一个「测试」，候选点一下就填进去', () => {
    assert.match(R, /自动检测这台机器上的三个工具/);
    assert.match(R, /binsDetect\?\.\(machine\)/);
    assert.match(R, /binsTest\?\.\(machine, cmd\)/);
    assert.match(R, /onClick=\{\(\) => onChange\(c\.command\)\}/);
    /* **不自动覆盖你已经填的**：只有空着（= 用默认）才替你填第一个能跑的 */
    assert.match(R, /if \(!next\[t\]\) \{ const p = pick\(t\); if \(p\) \{ next\[t\] = p; changed = true; \} \}/);
    /* 换机器要丢掉上一台的候选 —— 拿 A 的路径填 B 是最糟的一种"帮忙" */
    assert.match(R, /useEffect\(\(\) => \{ setFound\(null\); setErr\(''\); \}, \[machine\]\);/);
  });
});

/*
 * 「配置里东西太多了，你可以分几个不同的 tab」+「这些内容单独弄一个 setting tab，其他的弄到别的 tab 中」
 * +「不要显示默认」+「这个标题不应该叫远端机器（远程会话）了」。
 */
describe('设置分页 + 文案', () => {
  const D = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/SettingsDialog.tsx'), 'utf8');
  const R = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
  const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');

  test('机器**单独一页**而且是打开时停的那一页；每一页都接上了', () => {
    /* 页数会长（备份那一页是「定时向 S3 同步」加的），所以不写死数量 —— 只钉住
       "机器是第一页、是默认页"，以及**每一个**声明出来的 tab 都真的接了内容：
       少接一页的表现是"点了那个标签一片空白"，而那种 bug 没有任何报错。 */
    const decl = D.match(/type SettingsTab = ([^;]+);/);
    assert.ok(decl, '没有 SettingsTab 声明');
    const ids = Array.from(decl![1].matchAll(/'([a-z]+)'/g)).map((m) => m[1]);
    assert.equal(ids[0], 'machines', '机器排第一');
    /* 默认页仍然是机器，只是现在可以被 `initialTab` 指定 ——
       侧栏那个 ☁️ 要直接落到备份页（「这个同步应该在左侧下方有一个入口按钮」）。 */
    assert.match(D, /useState<SettingsTab>\(initialTab \|\| 'machines'\)/);
    assert.match(D, /initialTab\?: SettingsTab;/);
    assert.match(D, /\{tab === 'machines' && <RemoteSettings \/>\}/);
    for (const id of ids.slice(1)) {
      assert.ok(
        D.includes(`{tab === '${id}' && (`) || D.includes(`{tab === '${id}' && <`),
        `${id} 这一页没接上`,
      );
    }
    /* 标签栏里的条目数要和声明对得上 —— 声明了没进 TABS 就是点不到 */
    const tabs = Array.from(D.matchAll(/\{ id: '([a-z]+)', label:/g)).map((m) => m[1]);
    assert.deepEqual(tabs, ids, 'TABS 和 SettingsTab 声明不一致');
  });

  test('分页之后不再需要"把它硬提到最上面"那种布局较劲', () => {
    /* 上一版为了让远端那一块能被看见，只能把它排在字体前面（「我还是没有找到配置远程服务器的地方」）。
       现在它自己一页，那句注释也该改掉 —— 留着会让人以为顺序还有意义。 */
    assert.equal(/\*\*远端机器放在最上面\*\*/.test(D), false, '那条"排在字体前面"的理由已经不成立');
    assert.match(D, /分页之后每一页只回答一件事/);
  });

  test('标题不再叫「远端机器（远程会话）」，说明里也不再提镜像同步', () => {
    /* 判据是**渲染出来的那个 label**，不是源文件里有没有这几个字 ——
       注释里提到旧名字是正常的（说清为什么改了） */
    assert.equal(/settings-label">远端机器/.test(R), false);
    assert.match(R, /<label className="settings-label">机器与启动命令<\/label>/);
    /* 镜像已经没有了，那句"每一轮前后自动同步镜像"不能还挂在界面上 */
    assert.equal(/每一轮前后自动同步镜像/.test(R), false);
    assert.match(R, /文件不会被复制过去/);
  });

  test('**不显示"默认：xxx"** —— placeholder 就是那个命令本身', () => {
    assert.equal(/placeholder="默认：/.test(R), false);
    assert.match(R, /placeholder="kiro-cli" fallback="kiro-cli"/);
    /* 「测试」按钮空着时测的是 fallback，不是从 placeholder 里抠字符串 */
    assert.match(R, /const cmd = \(value \|\| fallback\)\.trim\(\);/);
  });

  test('标签栏有样式，而且机器那一页是单栏（两栏会把一组字段劈成两半）', () => {
    assert.match(CSS, /\.settings-tab\.active \{/);
    assert.match(CSS, /\.settings-body-machines \{ grid-template-columns: 1fr; \}/);
  });
});

/*
 * 「测试连接那几个按钮应该在上面，连接能行才能测试工具」。
 */
describe('远端那一块的顺序 = 依赖顺序', () => {
  const R = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');

  test('机器级动作（测试连接/安装依赖/删除）排在三个工具字段**之前**', () => {
    /* 连不上的话"检测/测试那三个工具"无从谈起 —— 它们都要走这条 ssh。
       按依赖顺序排，失败也按这个顺序暴露：先看到"连不上"，而不是先看到三个 ✗
       然后去怀疑路径写错了。 */
    const actions = R.indexOf('<div className="remote-row-actions">');
    const fields = R.indexOf('<BinFields bins={draft.bins');
    assert.ok(actions > 0 && fields > 0, '两块都要在');
    assert.ok(actions < fields, `动作按钮应该在工具字段之前（actions=${actions} fields=${fields}）`);
  });
});

/*
 * 「所有的会话必须用 setting 里面设置的本地或远程 agent 起任务，如果设置是空的不应该起任何连接」。
 *
 * 为什么"猜"必须停掉：这台机器上就有两个（`kiro-cli 2.23.1` 和 Kiro IDE 的 `kiro 0.12.333`），
 * 而猜错**不会报错** —— 表现是"模型列表少几个"、"agent 没生效"这类查半天看不出根因的事。
 */
describe('没配启动命令就不许起连接', () => {
  const A = fs.readFileSync(path.join(process.cwd(), 'src/main/acp-client.ts'), 'utf8');
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('本机：没配 = 一句能照着做的拒绝，而且**不再往下试那串猜测路径**', async () => {
    const { kiroBinProblem, kiroCliCandidates, setLocalKiroBin } = await import('../src/main/acp-client.ts');
    setLocalKiroBin(undefined);
    try {
      const why = kiroBinProblem();
      assert.ok(why, '没配就该有问题');
      /* 拒绝必须说"去哪儿点什么" —— 只说"没配置"等于把人留在原地 */
      assert.match(why!, /设置 → 🖥 机器/);
      assert.match(why!, /自动检测/);
      /* 空的时候仍然会列出那串老候选（给检测用），但执行器那条路是被 `kiroBinProblem` 拦住的 */
      assert.equal(kiroCliCandidates().includes('kiro-cli'), false, '不许把裸名字当候选');
    } finally {
      setLocalKiroBin(undefined);
    }
  });

  test('配了就**只用**它（不再按固定顺序猜第二个）', async () => {
    const { kiroCliCandidates, kiroBinProblem, setLocalKiroBin } = await import('../src/main/acp-client.ts');
    setLocalKiroBin('/opt/mine/kiro-cli');
    try {
      assert.deepEqual(kiroCliCandidates(), ['/opt/mine/kiro-cli']);
      assert.equal(kiroBinProblem(), null);
    } finally {
      setLocalKiroBin(undefined);
    }
  });

  test('执行器起之前就拦住（本地和远端各一处）', () => {
    assert.match(A, /const problem = kiroBinProblem\(\);\s*\n\s*if \(problem\) \{ reject\(new Error\(problem\)\); return; \}/);
    /* 远端：那台机器没配也不起，而且错误里要带上是哪台机器 */
    /* 启动命令按 sshHost 现查配置（见下面那一组）—— 记录里那份快照只是兜底 */
    assert.match(A, /const remoteBin = remoteKiroBin\(this\.remote\) \|\| '';/);
    assert.match(A, /还没有设置 \$\{this\.remote\.sshHost\} 上的 kiro 启动命令/);
    /* 不许再有 `|| 'kiro-cli'` 这种兜底 */
    assert.equal(/bins\?\.kiro \|\| 'kiro-cli'/.test(A), false);
  });

  test('模型列表 / agent 列表 / usage / 辅助模型也走同一个二进制', () => {
    /* 不一致的表现是"聊天能用，但模型列表少几个" —— 那是最难查的一类 */
    assert.match(M, /const problem = kiroBinProblem\(\);\s*\n\s*if \(problem\) return Promise\.reject\(new Error\(problem\)\);/);
    assert.equal(/resolveKiroCli\(\) \|\| 'kiro-cli'/.test(M), false, '不许退回裸名字');
  });
});

/*
 * 「测试连接那里不必检测 kiro 模型」。
 */
describe('测试连接不问模型列表', () => {
  test('`models: false` 时脚本里没有那次 chat 探测', async () => {
    const { preflightScript, MODEL_PROBE } = await import('../src/main/remotePreflight.ts');
    const full = preflightScript();
    const lite = preflightScript(undefined, { models: false });
    assert.ok(full.includes(MODEL_PROBE), '起会话那条路仍然要问（pickRemoteModel 靠它）');
    assert.equal(lite.includes(MODEL_PROBE), false);
    /* 工具在不在、登录了没有，这两件仍然要问 —— 它们才是"连得上吗"的答案 */
    assert.match(lite, /HAVE|MISS/);
    assert.match(lite, /AUTH ok/);
  });

  test('界面上那个「测试连接」用的是不问模型的那一版', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /preflightScript\(undefined, \{ models: false \}\)/);
  });

  test('远端的必需品只剩 kiro-cli（`git` 随镜像走，`rsync` 随 agent 同步走）', async () => {
    const { REQUIRED_TOOLS } = await import('../src/main/remotePreflight.ts');
    assert.deepEqual(REQUIRED_TOOLS, ['kiro-cli']);
  });
});

/*
 * 实测（重启之后）：配置里 tokyo 明明有 `bins.kiro`，而那几条老会话全部报"还没有设置…"。
 * 根因是会话记录里存的是**建会话那一刻**的目标快照（`rec.profile.remote = {...target}`），
 * 后来在设置里配的东西永远到不了已有的会话 —— 和 `labelForHost` 是同一条教训：
 * **会变的东西不要存进会话，按 host 反查。**
 */
describe('远端启动命令按 sshHost 现查配置，不看记录里的快照', () => {
  test('配置里有就用配置里的（记录里那份是旧的）', async () => {
    const { remoteKiroBin, setRemoteBinResolver } = await import('../src/main/acp-client.ts');
    setRemoteBinResolver((host) => (host === 'ec2-user@1.2.3.4' ? '/home/ec2-user/.local/bin/kiro-cli' : undefined));
    try {
      /* 记录里那份**没有** bins（老会话），照样要能起来 */
      assert.equal(remoteKiroBin({ sshHost: 'ec2-user@1.2.3.4' } as any), '/home/ec2-user/.local/bin/kiro-cli');
      /* 记录里有一份旧的 —— 也以配置为准 */
      assert.equal(remoteKiroBin({ sshHost: 'ec2-user@1.2.3.4', bins: { kiro: 'kiro-cli' } } as any),
        '/home/ec2-user/.local/bin/kiro-cli');
      /* 配置里这台机器被删了 → 退回记录里那份（宁可用旧的，也不要把一条会话彻底堵死） */
      assert.equal(remoteKiroBin({ sshHost: 'other@host', bins: { kiro: 'kiro-cli' } } as any), 'kiro-cli');
      /* 两边都没有 = 不许起（`connect` 会拒绝） */
      assert.equal(remoteKiroBin({ sshHost: 'other@host' } as any), undefined);
    } finally {
      setRemoteBinResolver(undefined);
    }
  });

  test('主进程在启动时就注入那个查询', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /setRemoteBinResolver\(\(sshHost\) => listRemoteTargets\(KIROLEX_CONFIG_PATH\)/);
    assert.match(M, /\.find\(\(t\) => t\.sshHost === sshHost\)\?\.bins\?\.kiro\);/);
  });
});
