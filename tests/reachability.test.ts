import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { Breaker, backoffMs, worthRetrying, BREAKER_MS, PREFLIGHT_ATTEMPTS } from '../src/main/reachability.ts';

/*
 * 「为什么这个连不上，是认知之类的有问题吗，有重试机制吗」。
 *
 * 不是认证：`ssh -vv` 停在认证**之前** ——
 *   `Connection established.` → `Local version string SSH-2.0-OpenSSH_10.3` → 然后超时。
 * banner 交换是 SSH 的第一步，密钥/用户名/安全组全都还没用上，所以是**那台机器的 sshd 不应答**
 * （资源打满，或卡在 `MaxStartups`：半开连接堆积）。
 *
 * 重试机制：原来**没有**，preflight 一次不成就抛。而这类失败常在几秒内自愈。
 * 但光加重试更糟：20 条会话 × 3 次 = 60 次连接，而 `MaxStartups` 恰恰是被这种并发压出来的 ——
 * 重试本身会变成病因。所以两件事一起做：退避重试 + **整机级熔断**。
 */
describe('连不上：退避重试 + 整机熔断', () => {
  test('退避是指数的，而且总时长压在启动路径能忍的范围内', () => {
    assert.equal(backoffMs(1), 800);
    assert.equal(backoffMs(2), 3_200);
    /* 三次尝试、两段等待 —— 最坏多等 4 秒 */
    assert.equal(PREFLIGHT_ATTEMPTS, 3);
    assert.ok(backoffMs(1) + backoffMs(2) <= 5_000);
  });

  test('只重试"可能自愈"的失败', () => {
    assert.equal(worthRetrying('Connection timed out during banner exchange'), true);
    assert.equal(worthRetrying('Connection refused'), true);
    assert.equal(worthRetrying('Connection closed by remote host'), true);
    /* 结论确定的不重试 —— 重试只是把同一句错误说三遍，还让人多等 4 秒 */
    assert.equal(worthRetrying('Permission denied (publickey)'), false);
    assert.equal(worthRetrying('ec2-user@h：没装 kiro-cli'), false);
    assert.equal(worthRetrying('还没有设置这台机器的 kiro 启动命令'), false);
    assert.equal(worthRetrying('Host key verification failed'), false);
  });

  test('熔断：窗口内复用结论，并且原样带回上次的原因', () => {
    let now = 1_000;
    const b = new Breaker(BREAKER_MS, () => now);
    assert.equal(b.recentFailure('h'), undefined);
    b.fail('h', 'banner exchange 超时');
    assert.equal(b.recentFailure('h'), 'banner exchange 超时', '要原样带回原因，而不是"被跳过了"');
    /* 别的机器不受影响 —— 熔断是按机器分的 */
    assert.equal(b.recentFailure('other'), undefined);
    now += BREAKER_MS + 1;
    assert.equal(b.recentFailure('h'), undefined, '过了窗口就该再试一次');
  });

  test('连上了立刻清掉 —— 否则机器恢复之后还要空等一个窗口', () => {
    const b = new Breaker();
    b.fail('h', 'x');
    b.ok('h');
    assert.equal(b.recentFailure('h'), undefined);
  });

  test('窗口是短的：它挡瞬间并发，不是"这台机器今天别用了"', () => {
    assert.ok(BREAKER_MS <= 60_000);
  });
});

describe('接线', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('preflight 用上了重试和熔断', () => {
    const at = M.indexOf('async function remotePreflight(');
    const body = M.slice(at, M.indexOf('\n}', M.indexOf('reachability.fail(host', at)));
    assert.match(body, /reachability\.recentFailure\(host\)/);
    assert.match(body, /for \(let attempt = 1; attempt <= PREFLIGHT_ATTEMPTS/);
    assert.match(body, /if \(!worthRetrying\(verdict\.message\) \|\| attempt === PREFLIGHT_ATTEMPTS\) break;/);
    assert.match(body, /reachability\.ok\(host\); return verdict\.models/);
    assert.match(body, /reachability\.fail\(host, verdict\.message\)/);
  });

  test('人点「测试连接」不被熔断挡住，通了还要把熔断清掉', () => {
    const at = M.indexOf("ipcMain.handle('remote:test'");
    const body = M.slice(at, at + 2200);
    /* 这条路自己拼 ssh，本来就不过 remotePreflight —— 那是故意的 */
    assert.equal(/remotePreflight\(/.test(body), false);
    assert.match(body, /if \(verdict\.code === 'ok'\) reachability\.ok\(target\.sshHost \|\| ''\)/);
    assert.match(body, /不是明确的人类意图/);
  });

  test('`force` 留给"人明确要重连"那条路', () => {
    assert.match(M, /opts\?: \{ force\?: boolean \}/);
    assert.match(M, /if \(!opts\?\.force\) \{/);
  });
});
