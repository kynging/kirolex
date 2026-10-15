import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseAgentList } from '../src/main/kiroAgentList.ts';
import { SESSION_AGENT_PREFIX, sessionAgentName } from '../src/main/remoteLocalTools.ts';

/*
 * 「对远程会话，那个机器人按钮显示的还是本地的 agent 列表，不是远程的」。
 *
 * 和模型清单同一个病：kiro-cli 只认**它自己机器上** `~/.kiro/agents/` 里的 agent。拿本机那份给
 * 远程会话选，选中的名字在远端不存在 —— 而那条路**有兜底**（`remoteAgentScript` 按名字找不到就
 * 退回默认 agent 并在会话里说一句），所以表现不是报错，而是"下拉里明明有，选了却静默换成了别的
 * agent"。产出是另一个 agent 干的，而下拉一直显示你选的那个。
 */
describe('agent 列表按机器分', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');
  const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');

  test('解析那张表（没有 JSON 模式，只能认它的列）', () => {
    const out = [
      'Available agents:',
      '* kiro_default        (Built-in)',
      '  kiro_help           (Built-in)',
      '  aws-agent           Global',
      '  repo-agent          Local      /path/to/.kiro/agents/repo-agent.json',
      '  这行认不出来',
    ].join('\n');
    const agents = parseAgentList(out);
    assert.deepEqual(agents.map((a) => a.name), ['kiro_default', 'kiro_help', 'aws-agent', 'repo-agent']);
    assert.equal(agents[0].isDefault, true);
    assert.equal(agents[0].source, 'built-in');
    assert.equal(agents[2].source, 'global');
    assert.equal(agents[3].source, 'local');
  });

  test('颜色码要剥掉 —— 有的版本带 ANSI', () => {
    const agents = parseAgentList('\u001b[1m  aws-agent           Global\u001b[0m');
    assert.deepEqual(agents.map((a) => a.name), ['aws-agent']);
  });

  test('内建的排最前 —— 它们在任何机器上都有，是"总能选"的兜底', () => {
    const agents = parseAgentList([
      '  zzz-agent           Global',
      '  kiro_planner        (Built-in)',
      '* kiro_default        (Built-in)',
    ].join('\n'));
    assert.deepEqual(agents.slice(0, 2).map((a) => a.name), ['kiro_default', 'kiro_planner']);
  });

  test('远程那条路去问**那台**机器，并滤掉 KiroLex 自己生成的会话 agent', () => {
    assert.match(M, /ipcMain\.handle\('kiro:list-agents', async \(_event, machine\?: string\) =>/);
    assert.match(M, /agent list 2>&1/);
    assert.match(M, /runRemoteCapture\(target, `\$\{shellQuote\(bin\)\} agent list 2>&1`\)/);
    /* `kirolex-local-<会话>` 是每条远程会话私有的（URL 里带它的 token）——
       选它等于把两条会话的工具通道接到一起 */
    assert.match(M, /\.filter\(\(a\) => !a\.name\.startsWith\(SESSION_AGENT_PREFIX\)\)/);
    assert.equal(sessionAgentName('s_abc').startsWith(SESSION_AGENT_PREFIX), true);
  });

  test('没配那台机器的启动命令就明说，不猜一个裸名字', () => {
    const at = M.indexOf("ipcMain.handle('kiro:list-agents'");
    const body = M.slice(at, at + 1800);
    assert.match(body, /No kiro launch command is set for \{host\} yet/);
    assert.match(body, /Machine not found \(\{machine\}\)/);
  });

  test('preload 和渲染层都带上机器', () => {
    assert.match(P, /listKiroAgents: \(machine\?: string\) => ipcRenderer\.invoke\('kiro:list-agents', machine\)/);
    assert.match(A, /const agentsFor = useCallback/);
    assert.match(A, /kiroAgents=\{agentsFor\(session\)\}/);
    /* 问不到就退回本机那份 —— 空下拉比"可能多几个"更糟（连当前 agent 都看不见） */
    assert.match(A, /return agentsByMachine\[machine\] \|\| kiroAgents;/);
    /* 一台机器只问一次（和模型清单同一个形状） */
    assert.match(A, /askedAgents\.current\.has\(machine\)/);
  });
});
