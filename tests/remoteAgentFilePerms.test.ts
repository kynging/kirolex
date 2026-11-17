import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { remoteAgentScript, MCP_SERVER_NAME } from '../src/main/remoteLocalTools.ts';

/*
 * 远端会话 agent（~/.kiro/agents/<会话>.json）里带着本机 local-MCP 的 url（`/mcp/<32 位 token>`），
 * 而那个 token 是远端那台机器打到本机 shell 的唯一一道锁。多用户的远端上默认 umask 022 →
 * 文件 0644，同机别的用户能读到 token、从反向隧道连进来跑 local_bash。所以这份文件必须只有自己能读。
 */

const URL = 'http://127.0.0.1:39100/mcp/0123456789abcdef0123456789abcdef';

describe('远端会话 agent 文件权限', () => {
  test('脚本：先 umask 077，同目录新建 0600 临时文件写完再原子替换（不原地重写旧文件）', () => {
    const sc = remoteAgentScript('kirolex-local-s1', 'a', URL);
    assert.ok(sc.startsWith('umask 077 && mkdir -p ~/.kiro/agents && '), sc.slice(0, 80));
    const prog = sc.slice(sc.indexOf("python3 -c '") + 12, sc.length - 1);
    assert.match(prog, /os\.umask\(0o077\)/);
    assert.match(prog, /tempfile\.mkstemp\(dir=h/);
    assert.match(prog, /os\.fchmod\(fd, 0o600\)/);
    assert.match(prog, /os\.replace\(tmp, p\)/);
    /* 不能 O_TRUNC 原地重写旧文件：别人早先打开的描述符会读到新 token */
    assert.equal(prog.includes('O_TRUNC'), false);
    /* 不再有默认权限的 open(…, "w") 写会话文件 */
    assert.equal(/open\(os\.path\.join\(h, out \+ "\.json"\), "w"\)/.test(prog), false);
    assert.equal(prog.includes("'"), false);
  });

  test('真跑一遍：宽松 umask 下、文件原本 0644，写完都是 0600', {
    skip: process.platform === 'win32' && '远端脚本（bash + python3 + HOME）只在 POSIX 上能本机冒烟',
  }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentperm-'));
    const agents = path.join(home, '.kiro', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    const file = path.join(agents, 'out.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    execFileSync('bash', ['-c', `umask 022; ${remoteAgentScript('out', '', URL)}`],
      { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers[MCP_SERVER_NAME].url, URL);
    /* 新建的情况 */
    /* 别的用户趁旧文件还是 0644 时先打开着：脚本跑完，这个旧描述符不能读到新 token */
    fs.writeFileSync(file, '{"old":true}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const early = fs.openSync(file, 'r');
    try {
      execFileSync('bash', ['-c', `umask 022; ${remoteAgentScript('out', '', URL)}`],
        { env: { ...process.env, HOME: home }, encoding: 'utf8' });
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(early, buf, 0, buf.length, 0);
      const seen = buf.subarray(0, n).toString('utf8');
      assert.equal(seen.includes('0123456789abcdef0123456789abcdef'), false);
      assert.equal(seen, '{"old":true}');
    } finally {
      fs.closeSync(early);
    }
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers[MCP_SERVER_NAME].url, URL);
    /* 临时文件不留在目录里 */
    assert.deepEqual(fs.readdirSync(agents), ['out.json']);
    fs.rmSync(file);
    execFileSync('bash', ['-c', `umask 022; ${remoteAgentScript('out', '', URL)}`],
      { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});
