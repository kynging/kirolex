import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listInstructionFiles, localInstructionFs, parseImports, resolveImport, subdirInstructionRel,
  remoteProbeScript, parseRemoteProbe, remoteInitScript, parseRemoteInit, createRemoteInstructionFs,
  writeInstructionFile, parseFallbackFilenames, type InstructionEntry,
} from '../src/main/instructionFiles.ts';
import { CATEGORIES } from '../src/main/kiroConfig.ts';

/**
 * 「CLAUDE.md」「AGENTS.md」tab 列出这条会话的引擎**实际会读**的全部指令文件。
 * 规则对照过 claude-agent-acp 0.95 带的 Claude Code（Agent SDK 0.3.309）和 codex 0.164（见 instructionFiles.ts 头注释）。
 */

const dirs: string[] = [];
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kx-instr-')));
  dirs.push(d);
  return d;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function put(root: string, rel: string, body = 'x\n'): string {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}
/* 只看测试目录里的：临时目录的上层（真机器上）可能碰巧有 CLAUDE.md */
const rows = (list: InstructionEntry[], root: string) =>
  list.filter((e) => e.path.startsWith(root + path.sep)).map((e) => [path.relative(root, e.path).split(path.sep).join('/'), e.kind, e.exists]);

describe('两个 category 还在，而且不再是单文件', () => {
  test('claude-memory / codex-agents 存在，kind 不是 single', () => {
    for (const id of ['claude-memory', 'codex-agents']) {
      const c = CATEGORIES.find((x) => x.id === id);
      assert.ok(c, id);
      assert.notEqual(c!.kind, 'single');
      assert.equal(c!.kind, 'instructions');
    }
    assert.equal(CATEGORIES.find((x) => x.id === 'claude-memory')!.instructions, 'claude');
    assert.equal(CATEGORIES.find((x) => x.id === 'codex-agents')!.instructions, 'codex');
  });
});

describe('Claude Code：用户级 / 项目级 / 本地 / 上层 / 子目录 / 引用', () => {
  test('文件集合、分类、未创建项', async () => {
    const root = tmp();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'work', 'repo', 'pkg');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    put(root, 'home/.claude/CLAUDE.md', 'user rules\n');
    put(root, 'work/CLAUDE.md', 'upper\n');                 // 上层目录
    put(root, 'work/repo/.claude/CLAUDE.md', 'repo alt\n'); // 上层目录的 .claude/CLAUDE.md
    put(root, 'work/repo/pkg/CLAUDE.md', 'project\n');
    put(root, 'work/repo/pkg/a/CLAUDE.md', 'sub a\n');
    put(root, 'work/repo/pkg/a/b/c/CLAUDE.local.md', 'sub c local\n');
    put(root, 'work/repo/pkg/a/b/c/d/CLAUDE.md', 'too deep\n');      // 子目录深度 4：不列
    put(root, 'work/repo/pkg/node_modules/x/CLAUDE.md', 'nm\n');     // node_modules：不列
    put(root, 'work/repo/pkg/a/.git/CLAUDE.md', 'git\n');             // .git：不列
    put(root, 'work/repo/pkg/.github/CLAUDE.md', 'gh\n');             // 别的隐藏目录：照列
    fs.mkdirSync(path.join(root, 'work', 'repo', '.git'));           // 仓库根 = work/repo
    const list = await listInstructionFiles('claude', cwd, localInstructionFs(home));
    const r = rows(list, root);
    assert.deepEqual(r, [
      ['home/.claude/CLAUDE.md', 'user', true],
      ['work/CLAUDE.md', 'project', true],
      /* 仓库根到工作目录之间每一层的标准位置都列（没有的标「未创建」）；仓库根之上只列已存在的 */
      ['work/repo/CLAUDE.md', 'project', false],
      ['work/repo/.claude/CLAUDE.md', 'project', true],
      ['work/repo/CLAUDE.local.md', 'local', false],
      ['work/repo/pkg/CLAUDE.md', 'project', true],
      ['work/repo/pkg/.claude/CLAUDE.md', 'project', false],
      ['work/repo/pkg/CLAUDE.local.md', 'local', false],
      ['work/repo/pkg/.github/CLAUDE.md', 'subdir', true],
      ['work/repo/pkg/a/CLAUDE.md', 'subdir', true],
      ['work/repo/pkg/a/b/c/CLAUDE.local.md', 'subdir', true],
    ]);
    /* 不存在的都是标准位置，都可以新建 */
    for (const e of list.filter((x) => !x.exists)) assert.equal(e.creatable, true);
    assert.equal(list.find((e) => e.path.endsWith(path.join('work', 'CLAUDE.md')))!.ancestor, true);
    assert.equal(list.find((e) => e.path === path.join(root, 'work', 'repo', 'CLAUDE.local.md'))!.ancestor, true);
    assert.equal(list.find((e) => e.path === path.join(cwd, 'CLAUDE.md'))!.ancestor, undefined);
  });

  test('没有仓库根：未创建项列到家目录为止（家目录那层也列）', async () => {
    const root = tmp();
    const home = path.join(root, 'home');
    const cwd = path.join(home, 'code', 'app');
    fs.mkdirSync(cwd, { recursive: true });
    put(root, 'home/code/CLAUDE.md', 'code\n');
    const list = await listInstructionFiles('claude', cwd, localInstructionFs(home));
    assert.deepEqual(rows(list, root), [
      ['home/.claude/CLAUDE.md', 'user', false],
      ['home/CLAUDE.md', 'project', false],
      ['home/.claude/CLAUDE.md', 'project', false],
      ['home/CLAUDE.local.md', 'local', false],
      ['home/code/CLAUDE.md', 'project', true],
      ['home/code/.claude/CLAUDE.md', 'project', false],
      ['home/code/CLAUDE.local.md', 'local', false],
      ['home/code/app/CLAUDE.md', 'project', false],
      ['home/code/app/.claude/CLAUDE.md', 'project', false],
      ['home/code/app/CLAUDE.local.md', 'local', false],
    ].filter((x, i) => i !== 2));   // 家目录的 .claude/CLAUDE.md 就是用户级那份，只列一次
  });

  test('用户级不存在也列（可新建）', async () => {
    const root = tmp();
    const home = path.join(root, 'h');
    const cwd = path.join(root, 'w');
    fs.mkdirSync(home); fs.mkdirSync(cwd);
    const list = await listInstructionFiles('claude', cwd, localInstructionFs(home));
    const u = list.find((e) => e.kind === 'user')!;
    assert.equal(u.path, path.join(home, '.claude', 'CLAUDE.md'));
    assert.equal(u.exists, false);
    assert.equal(u.creatable, true);
  });

  test('@引用：相对被引用文件的目录、~/ 是家目录、递归、标「被 X 引用」、紧跟在引用者后面', async () => {
    const root = tmp();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'proj');
    put(root, 'home/.claude/CLAUDE.md', 'see @~/notes/style.md\n');
    put(root, 'home/notes/style.md', 'style; also @./more.md\n');
    put(root, 'home/notes/more.md', 'more\n');
    put(root, 'proj/CLAUDE.md', [
      'Read @docs/guide.md and @missing.md',
      '`@in-code-span.md` is not an import',
      '```',
      '@in-fence.md',
      '```',
      '<!-- @in-comment.md -->',
      'mail me: me@example.com',
    ].join('\n'));
    put(root, 'proj/docs/guide.md', 'guide\n');
    const list = await listInstructionFiles('claude', cwd, localInstructionFs(home));
    const r = rows(list, root);
    const at = (rel: string) => r.findIndex((x) => x[0] === rel);
    assert.deepEqual(r[at('home/notes/style.md')], ['home/notes/style.md', 'import', true]);
    assert.equal(at('home/notes/style.md'), at('home/.claude/CLAUDE.md') + 1);
    assert.equal(at('home/notes/more.md'), at('home/notes/style.md') + 1);
    assert.deepEqual(r[at('proj/docs/guide.md')], ['proj/docs/guide.md', 'import', true]);
    assert.deepEqual(r[at('proj/missing.md')], ['proj/missing.md', 'import', false]);
    assert.equal(list.find((e) => e.path.endsWith('more.md'))!.importedBy, path.join(home, 'notes', 'style.md'));
    assert.equal(list.find((e) => e.path.endsWith('guide.md'))!.importedBy, path.join(cwd, 'CLAUDE.md'));
    /* 没找到的引用不当成「可新建」 */
    assert.equal(list.find((e) => e.path.endsWith('missing.md'))!.creatable, undefined);
    for (const no of ['in-code-span.md', 'in-fence.md', 'in-comment.md', 'example.com']) {
      assert.equal(list.some((e) => e.path.includes(no)), false, no);
    }
  });

  test('引用最多 5 层（和 Claude Code 一样），引用成环不会死循环', async () => {
    const root = tmp();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'p');
    put(root, 'p/CLAUDE.md', '@i1.md\n');
    /* 每个都再引一次 CLAUDE.md：成环 */
    for (let i = 1; i <= 7; i += 1) put(root, `p/i${i}.md`, `@i${i + 1}.md @CLAUDE.md\n`);
    fs.mkdirSync(home);
    const list = await listInstructionFiles('claude', cwd, localInstructionFs(home));
    const got = list.filter((e) => e.kind === 'import').map((e) => path.basename(e.path));
    assert.deepEqual(got, ['i1.md', 'i2.md', 'i3.md', 'i4.md']);
  });
});

describe('Codex：~/.codex 的 AGENTS(.override).md + 从仓库根到工作目录每层一份', () => {
  test('仓库根之上的不读；override 盖住同目录的 AGENTS.md；工作目录缺的可新建', async () => {
    const root = tmp();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'outer', 'repo', 'a', 'b');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.join(root, 'outer', 'repo', '.git'));
    put(root, 'home/.codex/AGENTS.md', 'user\n');
    put(root, 'home/.codex/AGENTS.override.md', 'user override\n');
    put(root, 'outer/AGENTS.md', 'above repo root\n');
    put(root, 'outer/repo/AGENTS.md', 'root\n');
    put(root, 'outer/repo/AGENTS.override.md', 'root override\n');
    put(root, 'outer/repo/a/AGENTS.md', 'a\n');
    put(root, 'outer/repo/a/b/c/AGENTS.md', 'below cwd: codex does not read\n');
    const list = await listInstructionFiles('codex', cwd, localInstructionFs(home));
    assert.deepEqual(rows(list, root), [
      ['home/.codex/AGENTS.override.md', 'user', true],
      ['home/.codex/AGENTS.md', 'user', true],
      ['outer/repo/AGENTS.override.md', 'project', true],
      ['outer/repo/AGENTS.md', 'project', true],
      ['outer/repo/a/AGENTS.override.md', 'project', false],
      ['outer/repo/a/AGENTS.md', 'project', true],
      ['outer/repo/a/b/AGENTS.override.md', 'project', false],
      ['outer/repo/a/b/AGENTS.md', 'project', false],
    ]);
    assert.equal(list[1].shadowedBy, path.join(home, '.codex', 'AGENTS.override.md'));
    assert.equal(list[3].shadowedBy, path.join(root, 'outer', 'repo', 'AGENTS.override.md'));
    assert.equal(list[5].shadowedBy, undefined);
    /* 仓库根到工作目录每一层缺的两种标准文件都可新建 */
    for (const i of [4, 6, 7]) assert.equal(list[i].creatable, true, String(i));
    assert.equal(list[4].ancestor, true);
    assert.equal(list[7].ancestor, undefined);
  });

  test('没有 git 仓库：只读工作目录那一层', async () => {
    const root = tmp();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'x', 'y');
    fs.mkdirSync(home); fs.mkdirSync(cwd, { recursive: true });
    put(root, 'x/AGENTS.md', 'parent\n');
    put(root, 'x/y/AGENTS.md', 'cwd\n');
    const list = await listInstructionFiles('codex', cwd, localInstructionFs(home));
    assert.deepEqual(rows(list, root), [
      ['home/.codex/AGENTS.override.md', 'user', false],
      ['home/.codex/AGENTS.md', 'user', false],
      ['x/y/AGENTS.override.md', 'project', false],
      ['x/y/AGENTS.md', 'project', true],
    ]);
    for (const e of list.filter((x) => !x.exists)) assert.equal(e.creatable, true);
  });

  test('没有工作目录（没开会话）：只列用户级', async () => {
    const home = tmp();
    const list = await listInstructionFiles('codex', undefined, localInstructionFs(home));
    assert.deepEqual(list.map((e) => e.kind), ['user', 'user']);
  });

  /* 下面几条对照的是 codex 0.164 `thread/start` 返回的 instructionSources（实跑） */
  test('用户级：空的（只有空白）override 不算，回退到 AGENTS.md；空文件标出来', async () => {
    const root = tmp();
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    put(root, 'home/.codex/AGENTS.override.md', '  \n');
    put(root, 'home/.codex/AGENTS.md', 'user\n');
    const list = await listInstructionFiles('codex', undefined, localInstructionFs(home));
    assert.deepEqual(rows(list, root), [
      ['home/.codex/AGENTS.override.md', 'user', true],
      ['home/.codex/AGENTS.md', 'user', true],
    ]);
    assert.equal(list[0].empty, true);
    assert.equal(list[1].shadowedBy, undefined, '空的 override 不遮蔽 AGENTS.md');
  });

  test('项目级：每层取第一个存在的（override → AGENTS.md → 备用文件名）；空的 override 照样占住这一层', async () => {
    const root = tmp();
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'repo', 'a');
    fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    put(root, 'home/.codex/config.toml', 'model = "x"\nproject_doc_fallback_filenames = [\n  "TEAM.md",\n  \'docs/no.md\',\n]\n\n[profiles.p]\nproject_doc_fallback_filenames = ["NOPE.md"]\n');
    put(root, 'home/.codex/TEAM.md', 'user-level fallback: codex does not read\n');
    put(root, 'repo/TEAM.md', 'team\n');                      // 这一层只有备用名 → 读它
    put(root, 'repo/a/AGENTS.override.md', '');               // 空 override：占住这一层，不读 AGENTS.md
    put(root, 'repo/a/AGENTS.md', 'a\n');
    put(root, 'repo/a/TEAM.md', 'a team\n');
    const list = await listInstructionFiles('codex', cwd, localInstructionFs(home));
    assert.deepEqual(rows(list, root), [
      ['home/.codex/AGENTS.override.md', 'user', false],
      ['home/.codex/AGENTS.md', 'user', false],
      ['repo/AGENTS.override.md', 'project', false],
      ['repo/AGENTS.md', 'project', false],
      ['repo/TEAM.md', 'project', true],
      ['repo/a/AGENTS.override.md', 'project', true],
      ['repo/a/AGENTS.md', 'project', true],
      ['repo/a/TEAM.md', 'project', true],
    ]);
    const by = (rel: string) => list.find((e) => e.path === path.join(root, ...rel.split('/')))!;
    assert.equal(by('repo/TEAM.md').shadowedBy, undefined);
    assert.equal(by('repo/a/AGENTS.override.md').empty, true);
    assert.equal(by('repo/a/AGENTS.md').shadowedBy, path.join(cwd, 'AGENTS.override.md'));
    assert.equal(by('repo/a/TEAM.md').shadowedBy, path.join(cwd, 'AGENTS.override.md'));
    /* 备用文件名不是标准位置：没有就不列，有也不标「可新建」 */
    assert.equal(by('repo/TEAM.md').creatable, undefined);
  });

  test('CODEX_HOME（执行器的环境里设了）：用户级和 config.toml 都按它找', async () => {
    const root = tmp();
    const home = path.join(root, 'home');
    const ch = path.join(root, 'codex-home');
    const cwd = path.join(root, 'w');
    fs.mkdirSync(home); fs.mkdirSync(cwd);
    put(root, 'codex-home/AGENTS.md', 'from CODEX_HOME\n');
    put(root, 'codex-home/config.toml', 'project_doc_fallback_filenames = ["TEAM.md"]\n');
    put(root, 'home/.codex/AGENTS.md', 'not read\n');
    put(root, 'w/TEAM.md', 'team\n');
    const list = await listInstructionFiles('codex', cwd, localInstructionFs(home, path, { CODEX_HOME: ch }));
    assert.deepEqual(rows(list, root), [
      ['codex-home/AGENTS.override.md', 'user', false],
      ['codex-home/AGENTS.md', 'user', true],
      ['w/AGENTS.override.md', 'project', false],
      ['w/AGENTS.md', 'project', false],
      ['w/TEAM.md', 'project', true],
    ]);
  });

  test('Claude Code 的 CLAUDE_CONFIG_DIR：用户级 CLAUDE.md 按它找', async () => {
    const root = tmp();
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    put(root, 'cfg/CLAUDE.md', 'from config dir\n');
    const list = await listInstructionFiles('claude', undefined, localInstructionFs(home, path, { CLAUDE_CONFIG_DIR: path.join(root, 'cfg') }));
    assert.deepEqual(rows(list, root), [['cfg/CLAUDE.md', 'user', true]]);
  });
});

describe('小件', () => {
  test('parseFallbackFilenames：只认顶层那一项、只认单纯的文件名', () => {
    assert.deepEqual(parseFallbackFilenames('project_doc_fallback_filenames = ["A.md", \'B.md\', "x/y.md", "..", ""]\n'), ['A.md', 'B.md']);
    assert.deepEqual(parseFallbackFilenames('[profiles.p]\nproject_doc_fallback_filenames = ["A.md"]\n'), []);
    assert.deepEqual(parseFallbackFilenames('# project_doc_fallback_filenames = ["A.md"]\n'), []);
    assert.deepEqual(parseFallbackFilenames(''), []);
  });
  test('parseImports 的取舍和 Claude Code 同一个正则', () => {
    assert.deepEqual(parseImports('a @x.md b @./y.md @~/z.md @/abs.md @foo#frag @a\\ b.md'), ['x.md', './y.md', '~/z.md', '/abs.md', 'foo', 'a b.md']);
    assert.deepEqual(parseImports('x@y.com @@scoped @#nope @/'), []);
  });
  test('resolveImport', () => {
    assert.equal(resolveImport('~/n.md', '/p/CLAUDE.md', '/home/u', path.posix), '/home/u/n.md');
    assert.equal(resolveImport('d/n.md', '/p/CLAUDE.md', '/home/u', path.posix), '/p/d/n.md');
    assert.equal(resolveImport('/abs.md', '/p/CLAUDE.md', '/home/u', path.posix), '/abs.md');
  });
  test('subdirInstructionRel：深度 1..3，只跳过 node_modules / .git，别的隐藏目录照列', () => {
    assert.equal(subdirInstructionRel('a/CLAUDE.md'), true);
    assert.equal(subdirInstructionRel('a/b/c/CLAUDE.local.md'), true);
    assert.equal(subdirInstructionRel('a/.claude/CLAUDE.md'), true);
    assert.equal(subdirInstructionRel('CLAUDE.md'), false);
    assert.equal(subdirInstructionRel('a/b/c/d/CLAUDE.md'), false);
    assert.equal(subdirInstructionRel('.github/CLAUDE.md'), true);
    assert.equal(subdirInstructionRel('a/.hidden/CLAUDE.local.md'), true);
    assert.equal(subdirInstructionRel('.git/CLAUDE.md'), false);
    assert.equal(subdirInstructionRel('a/.git/x/CLAUDE.md'), false);
    /* 工作目录自己的 .claude/CLAUDE.md 是项目级，不重复当子目录 */
    assert.equal(subdirInstructionRel('.claude/CLAUDE.md'), false);
    assert.equal(subdirInstructionRel('node_modules/x/CLAUDE.md'), false);
    assert.equal(subdirInstructionRel('a/notes.md'), false);
  });
  test('写回：原子写，目录不存在就建', () => {
    const root = tmp();
    const p = path.join(root, 'new', '.claude', 'CLAUDE.md');
    writeInstructionFile(p, 'hi\n');
    assert.equal(fs.readFileSync(p, 'utf-8'), 'hi\n');
    assert.deepEqual(fs.readdirSync(path.dirname(p)), ['CLAUDE.md']);
  });
});

describe('远程：走远端列目录 / 读文件的脚本', () => {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  test('初始化脚本：报 HOME + cwd 下按名字找（剪掉 node_modules / .git）', () => {
    const s = remoteInitScript('/w/p', ['CLAUDE.md', 'CLAUDE.local.md'], q);
    assert.ok(s.includes("cd '/w/p'"));
    assert.match(s, /-name node_modules -o -name \.git/);
    assert.match(s, /-maxdepth 5/);
    assert.deepEqual(parseRemoteInit('HOME\t/home/ec2\nFOUND\ta/CLAUDE.md\nFOUND\tCLAUDE.md\n'), { home: '/home/ec2', found: ['a/CLAUDE.md', 'CLAUDE.md'], env: {} });
  });
  test('探测脚本 + 解析：目录 / 文件（带内容）/ 不存在', () => {
    const s = remoteProbeScript(['/a/CLAUDE.md', "/b/it's.md"], q);
    assert.ok(s.includes("'/a/CLAUDE.md'"));
    assert.ok(s.includes(`'/b/it'\\''s.md'`));
    const b64 = Buffer.from('hello @x.md').toString('base64');
    const m = parseRemoteProbe(`F\t11\t/a/CLAUDE.md\n${b64}\nD\t/a/.git\nN\t/b/x.md\n`);
    assert.deepEqual(m.get('/a/CLAUDE.md'), { exists: true, size: 11, content: 'hello @x.md' });
    assert.deepEqual(m.get('/a/.git'), { exists: true, isDir: true, size: 0 });
    assert.deepEqual(m.get('/b/x.md'), { exists: false, size: -1 });
  });
  test('远端那份走同一套规则：ssh 两次（初始化 + 探测），之后按引用再探', async () => {
    const files: Record<string, string> = {
      '/home/ec2/.claude/CLAUDE.md': 'u @~/extra.md',
      '/home/ec2/extra.md': 'extra',
      '/srv/cache/s1/CLAUDE.md': 'p',
      '/srv/cache/s1/sub/CLAUDE.md': 's',
      '/srv/cache/s1/.github/CLAUDE.md': 'g',
    };
    const scripts: string[] = [];
    const run = async (script: string): Promise<string> => {
      scripts.push(script);
      if (script.startsWith('printf')) return 'HOME\t/home/ec2\nFOUND\tCLAUDE.md\nFOUND\tsub/CLAUDE.md\nFOUND\t.github/CLAUDE.md\n';
      const out: string[] = [];
      for (const m of script.matchAll(/p='([^']*)'/g)) {
        const p = m[1];
        if (p in files) out.push(`F\t${files[p].length}\t${p}`, Buffer.from(files[p]).toString('base64'));
        else out.push(`N\t${p}`);
      }
      return `${out.join('\n')}\n`;
    };
    const fsx = await createRemoteInstructionFs('/srv/cache/s1', run, q);
    const list = await listInstructionFiles('claude', '/srv/cache/s1', fsx);
    assert.deepEqual(list.filter((e) => e.exists).map((e) => [e.path, e.kind]), [
      ['/home/ec2/.claude/CLAUDE.md', 'user'],
      ['/home/ec2/extra.md', 'import'],
      ['/srv/cache/s1/CLAUDE.md', 'project'],
      ['/srv/cache/s1/.github/CLAUDE.md', 'subdir'],
      ['/srv/cache/s1/sub/CLAUDE.md', 'subdir'],
    ]);
    assert.ok(scripts.length <= 4, `ssh 次数 ${scripts.length}`);
  });

  test('远端零字节文件：内容是空串（不是「没读」）—— 用户级空 override 回退到 AGENTS.md，并标空文件', async () => {
    /* 解析：零字节的 F 行后面那行 base64 是空的；超过 1 MB 的不带内容（当作非空） */
    const m = parseRemoteProbe(`F\t0\t/h/.codex/AGENTS.override.md\n\nF\t2000000\t/h/big.md\n\n`);
    assert.deepEqual(m.get('/h/.codex/AGENTS.override.md'), { exists: true, size: 0, content: '' });
    assert.deepEqual(m.get('/h/big.md'), { exists: true, size: 2000000 });
    /* 走一遍远端的完整路径：脚本输出 → parseRemoteProbe → listInstructionFiles */
    const files: Record<string, string> = {
      '/home/u/.codex/AGENTS.override.md': '',
      '/home/u/.codex/AGENTS.md': 'user rules',
      '/srv/c/s1/AGENTS.md': '',
    };
    const run = async (script: string): Promise<string> => {
      if (script.startsWith('printf')) return 'HOME\t/home/u\n';
      const out: string[] = [];
      for (const mm of script.matchAll(/p='([^']*)'/g)) {
        const p = mm[1];
        /* 和真的脚本一样：F 行之后总有一行（零字节时是空行） */
        if (p in files) out.push(`F\t${files[p].length}\t${p}`, Buffer.from(files[p]).toString('base64'));
        else out.push(`N\t${p}`);
      }
      return `${out.join('\n')}\n`;
    };
    const list = await listInstructionFiles('codex', '/srv/c/s1', await createRemoteInstructionFs('/srv/c/s1', run, q));
    const by = (p: string) => list.find((e) => e.path === p)!;
    assert.equal(by('/home/u/.codex/AGENTS.override.md').empty, true);
    assert.equal(by('/home/u/.codex/AGENTS.md').shadowedBy, undefined, '空 override 不遮蔽 AGENTS.md');
    assert.equal(by('/home/u/.codex/AGENTS.md').empty, undefined);
    assert.equal(by('/srv/c/s1/AGENTS.md').empty, true);
  });

  test('远端的 CODEX_HOME / CLAUDE_CONFIG_DIR 从那台机器的登录 shell 取（执行器就是 bash -lc 起的），备用文件名读那台机器的 config.toml', async () => {
    const s = remoteInitScript('/w', ['CLAUDE.md'], q);
    assert.match(s, /bash -lc/);
    assert.ok(s.includes('CODEX_HOME') && s.includes('CLAUDE_CONFIG_DIR'));
    assert.deepEqual(parseRemoteInit('HOME\t/home/u\nENV\tCODEX_HOME\t/opt/codex\nENV\tCLAUDE_CONFIG_DIR\t\n').env, { CODEX_HOME: '/opt/codex' });
    const files: Record<string, string> = {
      '/opt/codex/AGENTS.md': 'u',
      '/opt/codex/config.toml': 'project_doc_fallback_filenames = ["TEAM.md"]\n',
      '/srv/c/s1/TEAM.md': 't',
      '/home/u/.codex/AGENTS.md': 'not read',
    };
    const run = async (script: string): Promise<string> => {
      if (script.startsWith('printf')) return 'HOME\t/home/u\nENV\tCODEX_HOME\t/opt/codex\nENV\tCLAUDE_CONFIG_DIR\t\n';
      const out: string[] = [];
      for (const m of script.matchAll(/p='([^']*)'/g)) {
        const p = m[1];
        if (p in files) out.push(`F\t${files[p].length}\t${p}`, Buffer.from(files[p]).toString('base64'));
        else out.push(`N\t${p}`);
      }
      return `${out.join('\n')}\n`;
    };
    const fsx = await createRemoteInstructionFs('/srv/c/s1', run, q);
    const list = await listInstructionFiles('codex', '/srv/c/s1', fsx);
    assert.deepEqual(list.filter((e) => e.exists).map((e) => [e.path, e.kind]), [
      ['/opt/codex/AGENTS.md', 'user'],
      ['/srv/c/s1/TEAM.md', 'project'],
    ]);
  });
});

describe('接线：主进程按会话的机器和工作目录列；面板显示分类 / 路径 / 未创建 / 记忆链接', () => {
  const src = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf-8');
  const M = src('main', 'index.ts');
  const P = src('renderer', 'components', 'KiroConfigPanel.tsx');
  const C = src('renderer', 'components', 'ChatArea.tsx');
  const slice = (s: string, anchor: string, n = 2500) => { const at = s.indexOf(anchor); assert.ok(at > 0, anchor); return s.slice(at, at + n); };

  test('kiro:config-list：远程会话走远端（runRemoteCapture），本机走本机 fs；工作目录是执行器那个', () => {
    const body = slice(M, "ipcMain.handle('kiro:config-list'");
    assert.match(body, /spec\.kind === 'instructions'/);
    assert.match(body, /createRemoteInstructionFs\(cwd, \(script\) => runRemoteCapture\(target, script/);
    /* 本机执行器的环境（shellEnv）里的 CODEX_HOME / CLAUDE_CONFIG_DIR 交给列表 */
    assert.match(body, /localInstructionFs\(os\.homedir\(\), path, \{ CODEX_HOME: shellEnv\.CODEX_HOME, CLAUDE_CONFIG_DIR: shellEnv\.CLAUDE_CONFIG_DIR \}\)/);
    assert.match(body, /listInstructionFiles\(spec\.instructions \|\| 'claude', cwd, fsx\)/);
    const cwdFor = slice(M, 'const instructionCwdFor', 600);
    assert.match(cwdFor, /sessionClients\.get\(sessionId\)/);
    assert.match(cwdFor, /sessionCwd\(rec\.profile, rec\.localDir\)/);
  });

  test('读 / 写只认上一次列出来的路径；远端读写用绝对路径的脚本', () => {
    for (const ch of ['kiro:config-read', 'kiro:config-write']) {
      const body = slice(M, `ipcMain.handle('${ch}'`, 1800);
      assert.match(body, /if \(!instructionListedOk\(sessionId, category, name\)\) return \{ ok: false/);
    }
    assert.match(slice(M, "ipcMain.handle('kiro:config-read'", 1800), /remoteReadScript\(name!, shellQuote\)/);
    const w = slice(M, "ipcMain.handle('kiro:config-write'", 1800);
    assert.match(w, /writeInstructionFile\(name!, String\(content\)\)/);
    assert.match(w, /remoteWriteScript\(name!, shellQuote\)/);
  });

  test('面板：顶上说明 + 跳记忆设置；未创建可一键新建；被谁引用；ChatArea 传了 onOpenMemory', () => {
    assert.ok(P.includes("t('These are long-term instructions the engine reads itself; KiroLex memory (Settings → Memory) is injected separately on every turn, and both take effect.')"));
    assert.match(P, /onClick=\{onOpenMemory\}/);
    assert.match(P, /e\.creatable && \(/);
    assert.match(P, /createInstruction\(e\.name\)/);
    assert.match(P, /t\('Imported by \{name\}'/);
    assert.match(P, /INSTRUCTION_KIND_LABEL\[e\.kind\]/);
    assert.match(C, /onOpenMemory=\{\(\) => \{ setEngineConfigOpen\(false\); onOpenMemory\(\); \}\}/);
  });
});
