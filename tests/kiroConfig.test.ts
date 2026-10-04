import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CATEGORIES, categoriesFor, categorySpec, cleanName, entryPath, validateContent, pickEntries,
  LocalKiroConfig, remoteReadScript, parseRemoteRead, remoteWriteScript, relPath,
} from '../src/main/kiroConfig.ts';

/* 机器人按钮的其余 tab。名字来自渲染层、远程那条会拼进 shell —— 路径安全是这里最要紧的。 */

test('六个类别都在，单文件的有 file，列表的有 match', () => {
  /* kiro 的还是那六个（按引擎取：Claude Code / Codex 的在同一张表里，见下面那条） */
  assert.deepEqual(categoriesFor('kiro').map((c) => c.id), ['mcp', 'steering', 'prompts', 'skills', 'powers', 'settings']);
  for (const c of CATEGORIES) {
    if (c.kind === 'single') assert.ok(c.file, c.id);
    else assert.ok(c.match, c.id);
  }
  assert.equal(categorySpec('powers')!.readOnly, true, 'Powers 由 kiro-cli 管理，只读');
});

test('Claude Code / Codex 也有自己的那几类，路径在各自的家目录下 ——「claude code 和 codex 左下角也得有一个类似的图标」', () => {
  assert.deepEqual(categoriesFor('claude').map((c) => c.label), ['Settings', 'CLAUDE.md', 'Agents', 'Commands', 'Skills', 'Plugins']);
  assert.deepEqual(categoriesFor('codex').map((c) => c.label), ['config.toml', 'AGENTS.md', 'Prompts', 'Skills']);
  assert.equal(entryPath('/home/u', categorySpec('claude-settings')!), '/home/u/.claude/settings.json');
  assert.equal(entryPath('/home/u', categorySpec('codex-config')!), '/home/u/.codex/config.toml');
  assert.equal(entryPath('/home/u', categorySpec('claude-agents')!, 'reviewer.md'), '/home/u/.claude/agents/reviewer.md');
  assert.equal(entryPath('/home/u', categorySpec('claude-agents')!, '../x.md'), null);
  assert.equal(categorySpec('codex-config')!.json, undefined, 'config.toml 不是 JSON，不按 JSON 校验');
});

test('名字：拒绝一切能跳出根目录的写法', () => {
  for (const bad of ['../x.md', 'a/../../b.md', '/etc/passwd', 'C:\\\\x.md', '..', '.hidden.md', 'a\\\\..\\\\b.md', '', 'a/b/c/d/e.md']) {
    assert.equal(cleanName(bad), null, `应拒绝 ${bad}`);
  }
  assert.equal(cleanName('amazon-builder/规则.md'), 'amazon-builder/规则.md', '中文名字要放行');
  assert.equal(cleanName('a\\\\b.md'), 'a/b.md', 'Windows 分隔符当成 /');
});

test('entryPath 落在各自根下，而且 list 类只认自己的扩展名', () => {
  const steering = categorySpec('steering')!;
  assert.equal(entryPath('/home/u', steering, 'x.md'), '/home/u/.kiro/steering/x.md');
  assert.equal(entryPath('/home/u', steering, 'x.sh'), null, '.sh 不是 steering');
  assert.equal(entryPath('/home/u', steering, '../settings/cli.json'), null);
  assert.equal(entryPath('/home/u', categorySpec('mcp')!, '../../anything'), '/home/u/.kiro/settings/mcp.json', 'single 类忽略名字');
  assert.equal(relPath(categorySpec('skills')!, 'brazil/SKILL.md'), '.kiro/skills/brazil/SKILL.md');
});

test('保存前校验：JSON 类必须是对象，只读的不让写', () => {
  assert.match(validateContent(categorySpec('mcp')!, '{oops')!, /JSON/);
  assert.match(validateContent(categorySpec('mcp')!, '[1]')!, /对象/);
  assert.equal(validateContent(categorySpec('mcp')!, '{"mcpServers":{}}'), null);
  assert.ok(validateContent(categorySpec('powers')!, '{}'), '只读的必须拒');
  assert.equal(validateContent(categorySpec('steering')!, '# 随便写'), null);
});

test('pickEntries：只挑这一类的文件，而且不超过深度', () => {
  const skills = categorySpec('skills')!;
  const got = pickEntries(skills, ['brazil/SKILL.md\t10', 'brazil/run.sh\t5', 'a/b/SKILL.md\t3', 'SKILL.md\t1']);
  /* skill 是 <名字>/SKILL.md：根目录那个和更深的都不算 */
  assert.deepEqual(got.map((e) => e.name), ['brazil/SKILL.md']);
});

test('本机：写 → 读 → 列，原子写不留临时文件', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcfg-'));
  const c = new LocalKiroConfig(home);
  const prompts = categorySpec('prompts')!;
  assert.deepEqual(c.list(prompts), []);
  const w = c.write(prompts, 'hello.md', '# 你好\n');
  assert.ok(!('error' in w));
  const r = c.read(prompts, 'hello.md');
  assert.ok(!('error' in r) && r.content === '# 你好\n');
  assert.deepEqual(c.list(prompts).map((e) => e.name), ['hello.md']);
  assert.deepEqual(fs.readdirSync(path.join(home, '.kiro/prompts')), ['hello.md'], '不该留下 .tmp');
  assert.ok('error' in c.write(prompts, '../escape.md', 'x'));
  /* 不存在的单文件：给一份空对象当起点，而不是报错 */
  const s = c.read(categorySpec('settings')!);
  assert.ok(!('error' in s) && s.exists === false && s.content.trim() === '{}');
});

test('远程脚本：路径包单引号，内容走 base64', () => {
  const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
  assert.match(remoteReadScript('.kiro/prompts/a b.md', q), /"\$HOME"\/'\.kiro\/prompts\/a b\.md'/);
  assert.match(remoteWriteScript('.kiro/x.md', q), /base64 -d > "\$t" && mv -f "\$t" "\$f"/);
  const out = `EXISTS 1\n${Buffer.from('中文 ✓').toString('base64')}\n`;
  assert.deepEqual(parseRemoteRead(out), { exists: true, content: '中文 ✓' });
  assert.deepEqual(parseRemoteRead('EXISTS 0\n'), { exists: false, content: '' });
});

test('Agents tab 也跟着会话的机器走 —— 远程会话不能改本机那份', () => {
  /* 原来永远读写本机 ~/.kiro/agents：在远程会话里改了、显示保存成功，远端什么都没变 */
  const M = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  for (const ch of ['kiro:open-agent-config', 'kiro:save-agent-config']) {
    const at = M.indexOf(`ipcMain.handle('${ch}'`);
    const body = M.slice(at, at + 2500);
    assert.match(body, /const remoteT = kiroConfigTargetFor\(sessionId\);/, `${ch} 没有远程分支`);
    assert.ok(body.indexOf('remoteT') < body.indexOf('resolveKiroAgentConfigPath'), `${ch}：远程分支要在本机解析之前`);
  }
  /* 远端找文件之前名字已过白名单 —— 它被拼进 shell */
  assert.match(M, /remoteAgentFindScript = \(agentName: string\)/);
});
