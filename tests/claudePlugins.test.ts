import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  categorySpec, categoriesFor, entryPath, relPath, pickPluginEntries, parseRemoteList, pluginWriteError,
  remoteListScript, LocalKiroConfig, PLUGIN_SPLIT,
} from '../src/main/kiroConfig.ts';

/* 「claude code 的配置什么都拿不到」：两台机器的 ~/.claude/{agents,commands,skills} 都是空的 ——
   在用的 skill / 命令 / 子代理全是插件带的。 */
const skills = categorySpec('claude-skills')!;
const commands = categorySpec('claude-commands')!;

describe('插件带的条目', () => {
  test('一个插件只取最新的那个版本；显示成「插件 · 名字」，只读', () => {
    const got = pickPluginEntries(skills, [
      'mkt/superpowers/5.0.0/skills/brainstorming/SKILL.md\t10\t100',
      'mkt/superpowers/5.1.0/skills/brainstorming/SKILL.md\t12\t200',
      'mkt/superpowers/5.1.0/skills/debugging/SKILL.md\t13\t200',
      'mkt/superpowers/5.1.0/skills/debugging/notes.md\t1\t200',   // 不是 SKILL.md
      'mkt/other/1.0/commands/x.md\t1\t300',                      // 不是这一类
    ]);
    assert.deepEqual(got.map((e) => e.label), ['superpowers · brainstorming', 'superpowers · debugging']);
    assert.ok(got.every((e) => e.readOnly && e.name.startsWith('@plugin/mkt/superpowers/5.1.0/')));
  });

  test('命令可以有一层子目录；名字不合规的不认', () => {
    const got = pickPluginEntries(commands, [
      'mkt/cc/1.0/commands/commit.md\t1\t1',
      'mkt/cc/1.0/commands/git/push.md\t1\t1',
      'mkt/cc/1.0/commands/../../../../etc/passwd.md\t1\t1',
    ]);
    assert.deepEqual(got.map((e) => e.label), ['cc · commit', 'cc · git/push']);
  });

  test('路径：读得到 cache 里那一份，跳不出去；写一律拒绝', () => {
    assert.equal(entryPath('/h', skills, '@plugin/mkt/sp/1/skills/a/SKILL.md'), '/h/.claude/plugins/cache/mkt/sp/1/skills/a/SKILL.md');
    assert.equal(relPath(skills, '@plugin/mkt/sp/1/skills/a/SKILL.md'), '.claude/plugins/cache/mkt/sp/1/skills/a/SKILL.md');
    assert.equal(entryPath('/h', skills, '@plugin/mkt/sp/../../x/skills/a/SKILL.md'), null);
    assert.equal(entryPath('/h', skills, '@plugin/mkt/sp/1/commands/a.md'), null, '不是这一类');
    assert.match(pluginWriteError('@plugin/mkt/sp/1/skills/a/SKILL.md') || '', /只读/);
    assert.equal(pluginWriteError('mine/SKILL.md'), null);
  });

  test('远程：自己的和插件的在同一次 ssh 里列出来', () => {
    const script = remoteListScript(skills, (s) => `'${s}'`);
    assert.match(script, new RegExp(PLUGIN_SPLIT));
    assert.match(script, /\.claude\/plugins\/cache/);
    const entries = parseRemoteList(skills, `mine/SKILL.md\t5\n${PLUGIN_SPLIT}\nmkt/sp/1/skills/a/SKILL.md\t7\t1.5\n`);
    assert.deepEqual(entries.map((e) => [e.name, !!e.readOnly]), [['mine/SKILL.md', false], ['@plugin/mkt/sp/1/skills/a/SKILL.md', true]]);
  });

  test('本机：真的走一遍 cache 目录', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kxplug-'));
    const put = (rel: string): void => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), 'x'); };
    put('.claude/skills/mine/SKILL.md');
    put('.claude/plugins/cache/mkt/sp/1.0/skills/a/SKILL.md');
    put('.claude/plugins/cache/mkt/sp/1.0/scripts/big/SKILL.md');   // 不在 skills/ 下
    const names = new LocalKiroConfig(home).list(skills).map((e) => e.label || e.name);
    assert.deepEqual(names, ['mine/SKILL.md', 'sp · a']);
    const r = new LocalKiroConfig(home).write(skills, '@plugin/mkt/sp/1.0/skills/a/SKILL.md', 'y');
    assert.ok('error' in r);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('多了一个只读的 Plugins tab', () => {
    const p = categorySpec('claude-plugins')!;
    assert.equal(p.readOnly, true);
    assert.ok(categoriesFor('claude').some((c) => c.id === 'claude-plugins'));
  });
});

test('面板：一开始就是读取中；单文件 tab 不先列一遍', () => {
  const P = fs.readFileSync('src/renderer/components/KiroConfigPanel.tsx', 'utf8');
  assert.match(P, /const \[loading, setLoading\] = useState\(true\);/);
  assert.match(P, /if \(category\.kind === 'single'\) \{[\s\S]{0,160}await open\(undefined\);\s*return;/);
  assert.match(P, /!selectedEntry\?\.readOnly/);
});
