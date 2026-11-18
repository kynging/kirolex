/**
 * 远程 kiro 会话专用 agent：**只读网络工具 web_search / web_fetch 预先放行** ——
 * 新会话默认「先问」之后，连搜网页、取网页都要用户手动批，太吵；这两样不碰远端文件、不碰用户本机。
 *
 * 守的是：
 *   ① 生成的 allowedTools 里有 web_search / web_fetch，且不重复；
 *   ② 它们在 trusts_write / trusts_local 过滤**之后**才并进去，两道过滤照旧（fs_write / `*` / @kirolex-local 仍被剔掉）；
 *   ③ 只放行、不扩权：底子 tools 不是 `*` 时，不因此把它们加进 tools。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REMOTE_PREALLOWED_TOOLS, remoteAgentScript } from '../src/main/remoteLocalTools.ts';

const hasPython = (() => {
  if (process.platform === 'win32') return false;
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const REAL_RUN = { skip: !hasPython && '远端脚本（bash + python3 + HOME）只在 POSIX 且有 python3 时能本机冒烟' };

const program = (): string => {
  const sc = remoteAgentScript('kirolex-local-s1', 'a', 'http://127.0.0.1:1/mcp/t', [{ name: 'playwright', url: 'http://127.0.0.1:1/mcp/t/playwright' }]);
  return sc.slice(sc.indexOf("python3 -c '") + 12, sc.length - 1);
};

test('常量：只有 web_search / web_fetch 两个只读网络工具，没有写文件 / 跑命令 / 本机工具', () => {
  assert.deepEqual([...REMOTE_PREALLOWED_TOOLS], ['web_search', 'web_fetch']);
  for (const bad of ['fs_write', 'write', 'execute_bash', 'use_aws', '*', '@builtin']) {
    assert.equal((REMOTE_PREALLOWED_TOOLS as readonly string[]).includes(bad), false, bad);
  }
  assert.equal(REMOTE_PREALLOWED_TOOLS.some((t) => t.startsWith('@') || t.startsWith('local_')), false);
});

test('合并程序：预放行项来自常量，在两道过滤之后才并进去，并去重；tools 不动', () => {
  const prog = program();
  assert.equal(prog.includes("'"), false, 'python 程序里不许出现单引号');
  const preLine = `pre = ${JSON.stringify(REMOTE_PREALLOWED_TOOLS)}`;
  assert.ok(prog.includes(preLine), preLine);
  const filter = prog.indexOf('if kept(t) and not trusts_write(t) and not trusts_local(t)]');
  const append = prog.indexOf('for t in pre:');
  const dedup = prog.indexOf('allowed = [t for i, t in enumerate(allowed) if t not in allowed[:i]]');
  const assign = prog.indexOf('cfg["allowedTools"] = allowed\n');
  assert.ok(filter > 0 && append > filter && dedup > append && assign > dedup, '顺序：过滤 → 并入预放行 → 去重 → 写回');
  /* 只放行、不扩权：pre 不进 tools */
  assert.doesNotMatch(prog, /cfg\["tools"\][^\n]*pre/);
});

test('真跑一遍：底子 allowedTools 里 fs_write / * / @kirolex-local 仍被剔掉，web_search / web_fetch 放行且不重复', REAL_RUN, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prehome-'));
  try {
    fs.mkdirSync(path.join(home, '.kiro', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.kiro', 'agents', 'a.json'), JSON.stringify({
      tools: ['fs_read'],
      allowedTools: ['fs_read', 'web_search', 'fs_write', '*', '@kirolex-local', '@kirolex-local/local_bash', 'fs_read'],
    }));
    const run = (base: string): any => {
      execFileSync('bash', ['-lc', remoteAgentScript('out', base, 'http://127.0.0.1:1/mcp/t')], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
      return JSON.parse(fs.readFileSync(path.join(home, '.kiro', 'agents', 'out.json'), 'utf8'));
    };
    const hit = run('a');
    assert.deepEqual(hit.allowedTools, ['fs_read', 'web_search', 'web_fetch']);
    /* 底子 tools 不是 *、没列 web_*：不因此加进 tools */
    assert.deepEqual(hit.tools, ['fs_read', '@kirolex-local']);
    /* 远端没有底子（最常见）：tools ["*"]，allowedTools 只有这两项 */
    const miss = run('nope');
    assert.deepEqual(miss.tools, ['*']);
    assert.deepEqual(miss.allowedTools, ['web_search', 'web_fetch']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
