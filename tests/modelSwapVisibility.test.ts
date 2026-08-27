/**
 * 换模型期间界面不能是静的,而且死模型只该被发现一次。
 *
 * ## 实测的现场
 *
 * 「第二个分屏的会话为什么卡住了」。后端根本没卡 —— 那一轮 47 个事件、4 分 24 秒后正常完成,
 * 回复也进了 transcript。卡的是**开头 30 秒**:
 *
 *   17:06:25  prompt 收到,executor 跑在 'claude-opus-5'
 *   17:06:28  executor 被 disconnect（swapSessionModel 自己杀的）
 *   17:06:36  switched to 'gpt-5.6-sol'
 *   17:06:57  第一个工具才开始
 *
 * 而 `claude-opus-5` 压根不在这个 kiro-cli 的清单里（只有 gpt-5.6-* / deepseek / minimax /
 * glm / qwen）。它连得上是因为 —— 见 `isModelUnavailableError` 上面那段 —— kiro-cli **只在
 * 真跑一轮时**才报模型退役。
 *
 * 两个缺陷各修一处:
 *   · 那 30 秒里 `sessionClients` 里没有 entry,`busyReason` 返回 null → 一轮正在飞的对话
 *     在界面上显示为空闲
 *   · 换成功之后没人记住那个模型是死的 → 下一条会话再付一次（实测一次运行里两遍）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

/** `swapSessionModel` 的函数体。按结束标记切,不按「往后数 N 个字」—— 那种窗口每加一段注释就失效,
 *  而它失效的方式是假绿（indexOf 找不到返回 -1,断言被跳过）。 */
const swapBody = (): string => {
  const at = MAIN.indexOf('async function swapSessionModel(');
  assert.ok(at > 0, '找不到 swapSessionModel');
  const end = MAIN.indexOf('\n}', MAIN.indexOf('reconfiguringSessions.delete(sessionId);', at));
  assert.ok(end > at, '切不到函数末尾');
  return MAIN.slice(at, end);
};

describe('换执行器期间必须报 busy', () => {
  test('swapSessionModel 一进来就标 reconfiguring', () => {
    const body = swapBody();
    const add = body.indexOf('reconfiguringSessions.add(sessionId)');
    const del = body.indexOf('sessionClients.delete(sessionId)');
    assert.ok(add > 0, '没有标 reconfiguring');
    assert.ok(add < del, `必须在 sessionClients.delete **之前**标（add=${add} delete=${del}）—— 删了之后 busyReason 就查不到 entry 了`);
  });

  test('用已有的 reconfiguringSessions，而不是新造一个状态', () => {
    // busyReason 第一条就查它，界面本来就认得这个状态（手动换模型走同一条）
    const at = MAIN.indexOf('function busyReason');
    const head = MAIN.slice(at > 0 ? at : MAIN.indexOf("return 'reconfiguring'") - 400, undefined).slice(0, 400);
    assert.match(head, /reconfiguringSessions\.has\(sessionId\)/);
  });

  test('**finally 里清** —— 一次失败的换模型不许把会话永久钉在「切换中」', () => {
    const body = swapBody();
    const fin = body.lastIndexOf('} finally {');
    assert.ok(fin > 0, '没有 finally');
    assert.match(body.slice(fin), /reconfiguringSessions\.delete\(sessionId\)/);
    // awaitReconfigureIdle 会等 30 秒然后抛错，所以漏清的代价是这条会话连不上
    assert.match(MAIN, /会话切换模型\/Agent 超过 30 秒/);
  });
});

describe('死模型只发现一次', () => {
  test('换成功之后把 failedModel 记进 modelsKnownDead', () => {
    const body = swapBody();
    const ok = body.indexOf("unavailable at prompt time -> switched to");
    assert.ok(ok > 0);
    assert.match(body.slice(ok, ok + 700), /modelsKnownDead\.add\(failedModel\)/);
  });

  test('**只在换成功时记** —— 连接失败可能是限流，那不等于模型死了', () => {
    const body = swapBody();
    const addAt = body.indexOf('modelsKnownDead.add(failedModel)');
    const catchAt = body.indexOf('} catch (err: any) {', addAt);
    assert.ok(addAt > 0 && catchAt > addAt, '记录必须在 try 的成功路径上，不在 catch 里');
    assert.doesNotMatch(body.slice(catchAt), /modelsKnownDead\.add/);
  });

  test('已知死掉的排到**最后**而不是删掉 —— 一次误判不该让会话连不上', () => {
    const at = MAIN.indexOf('async function connectWithModelFallback(');
    const body = MAIN.slice(at, MAIN.indexOf('\n}', MAIN.indexOf('No usable model', at)));
    assert.match(body, /const dead = all\.filter\(\(m\) => modelsKnownDead\.has\(m\)\)/);
    assert.match(body, /\.\.\.all\.filter\(\(m\) => !modelsKnownDead\.has\(m\)\), \.\.\.dead/);
    assert.doesNotMatch(body, /candidates = all\.filter\(\(m\) => !modelsKnownDead/,
      '不许直接过滤掉 —— 那样候选可能空');
  });

  test('**进程级，不落盘** —— 模型清单会变，装了新版本重启就该自动恢复', () => {
    assert.match(MAIN, /const modelsKnownDead = new Set<string>\(\);/);
    const at = MAIN.indexOf('const modelsKnownDead');
    // 不许有任何持久化的痕迹
    assert.doesNotMatch(MAIN.slice(at, at + 600), /writeRecord|writeFileSync|uiSet/);
  });
});
