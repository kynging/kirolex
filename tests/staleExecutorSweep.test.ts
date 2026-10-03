import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { staleExecutorSweepScript, parseStaleSweep, ownedAgentPrefix } from '../src/main/remoteLocalTools.ts';

/*
  **第二道远端清理：带我标签但我没持有的执行器** ——「你应该让 kirolex 去清理和检查远端孤儿」。
  PPID==1 那道漏掉了实测撞到的那类：本机 ssh 死了、远端 sshd-session 没察觉还活着，
  下面挂着 14 个 kiro-cli 7.5 小时。真机上已经用四个假进程验过（只有"没人持有、够老"的那个死了）。
*/

test('只碰自己标签的，而且只认顶层 kiro-cli acp', () => {
  const sh = staleExecutorSweepScript('aaaaaa', { pids: [], sessions: [] });
  assert.ok(sh.includes(ownedAgentPrefix('aaaaaa')));
  assert.equal(sh.includes(ownedAgentPrefix('bbbbbb')), false);
  /* 顶层：args 第一个词就是 kiro-cli（kiro-cli-chat 跟着父进程收，单独扫会杀掉活会话的 chat） */
  assert.match(sh, /\$3=="kiro-cli" \|\| \$3 ~ "\/kiro-cli\$"/);
  assert.match(sh, /\$4=="acp"/);
  /* awk 正则里不能出现 /(^|/ 这种被模板字符串吃掉转义的形状（真机上踩过） */
  assert.equal(sh.includes('/(^|/)'), false);
});

test('保留名单：持有的 pid 和正在 attach 的会话都跳过', () => {
  const sh = staleExecutorSweepScript('aaaaaa', { pids: [123, 456], sessions: ['s_1', 's_mc_2'] });
  assert.match(sh, /keep=" 123 456 "/);
  assert.match(sh, /skip=" s_1 s_mc_2 "/);
});

test('会话名进 shell 之前过白名单 —— 它被拼进 case 模式里', () => {
  const sh = staleExecutorSweepScript('aaaaaa', { pids: [1, -3, 2.5, 99], sessions: ['ok_1', 'x"; rm -rf ~; "', '$(id)'] });
  assert.match(sh, /keep=" 99 "/, 'pid 1 / 负数 / 小数都不该进来');
  assert.match(sh, /skip=" ok_1 "/);
  assert.equal(sh.includes('rm -rf'), false);
  assert.equal(sh.includes('$(id)'), false);
});

test('年龄只是防竞态 —— 有下限，不能被设成 0', () => {
  assert.match(staleExecutorSweepScript('a', { pids: [], sessions: [] }, 0), /-v age=30 /);
  assert.match(staleExecutorSweepScript('a', { pids: [], sessions: [] }), /-v age=120 /);
});

test('数得出来', () => {
  assert.equal(parseStaleSweep('KIROLEX_STALE 7'), 7);
  assert.equal(parseStaleSweep('乱七八糟'), 0);
});

test('三个时机都接上了：启动、定时、连接恢复后', () => {
  const M = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(M, /await sweepRemoteExecutors\(target, '启动'\)/);
  assert.match(M, /sweepRemoteExecutors\(target, '定时'\)/);
  assert.match(M, /sweepRemoteExecutors\(target, '连接恢复后'\)/);
  /* 定时那轮只扫正有会话的机器 —— 关掉的机器不该被定时敲门 */
  assert.match(M, /if \(target\.sshHost && hasSessionOn\(target\)\) void sweepRemoteExecutors/);
});
