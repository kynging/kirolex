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
    /* 真正去连的那段现在叫 `runPreflight`：`remotePreflight` 只负责"同一台机器同时只探一次"
       （见下面那个 describe —— 熔断器挡不住同一瞬间的并发） */
    const at = M.indexOf('async function runPreflight(');
    const body = M.slice(at, M.indexOf('\n}', M.indexOf('reachability.fail(host', at)));
    assert.match(body, /reachability\.recentFailure\(host\)/);
    assert.match(body, /for \(let attempt = 1; attempt <= PREFLIGHT_ATTEMPTS/);
    assert.match(body, /if \(!worthRetrying\(verdict\.message\) \|\| attempt === PREFLIGHT_ATTEMPTS\) break;/);
    /* 成功那一支现在还顺路记下那台机器的规格（算并发上限用）—— 所以不再是一行 */
    assert.match(body, /reachability\.ok\(host\);/);
    assert.match(body, /return verdict\.models \|\| \[\];/);
    /* 成功那一支还顺路把规格报一次给人看（只是告知，不设上限 —— 见下面那个 describe） */
    assert.match(body, /remoteSpecsLogged/);
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

/*
 * 「远程能承受多少个远程 session？这个有限制吧」→ 实测量出来了，但**没有做成上限**。
 * 「谁让你加上限了，你应该加的是垃圾清理和重复利用」。
 *
 * 量到的数字留着（它是判断"贵不贵"的依据）：那台 t3.medium（2 vCPU / 3.8 GB）上一条远程会话是
 * **两个**进程 —— `kiro-cli` ≈ 48 MB + `kiro-cli-chat` ≈ 104–114 MB ≈ **155 MB**；
 * 6 条 = 941 MB RSS、load 3.86。
 *
 * 我一度把它做成了硬上限，那是错的：满了就赶走一条，而被赶走的立刻被后台 attach 拉回来 ——
 * 实测日志里 `断开 nc0s4j` → 5 秒后 `断开 kqrsee` → …，而用户那条**新建**的会话卡在中间等了
 * **46 秒**；期间它还没进 `sessionClients`，所以点模型下拉直接报 `Session not connected`。
 * 拦着人开会话解决不了浪费，只是把浪费换成了等待。真正该做的是**不浪费**：
 * 孤儿清理（本机 ssh + 远端进程，两端都扫）和执行器复用。
 */
describe('那台机器的规格只用来告知，不设上限', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('规格报一次给人看，而且明说不设上限', () => {
    assert.match(M, /只是告知，不设上限/);
    assert.match(M, /remoteSpecsLogged/);
  });

  test('那套上限机械整个不在了', () => {
    for (const gone of ['makeRoomOnRemote', 'remoteExecutorCount', 'remoteStarting', 'remoteCaps', 'releaseRemoteSlot']) {
      assert.equal(M.includes(gone), false, `${gone} 应该已经删掉`);
    }
  });

  test('规格解析还留着 —— 它是"一条会话多贵"的依据', async () => {
    const { parseSpecs, REMOTE_MB_PER_SESSION } = await import('../src/main/remotePreflight.ts');
    assert.deepEqual(parseSpecs('CPUS 2\nMEMMB 3839'), { cpus: 2, memMB: 3839 });
    assert.equal(REMOTE_MB_PER_SESSION, 155);
  });
});

/*
 * **熔断器挡不住的那半边** —— 实测 2026-09-27：日志里 21 条一模一样的
 * `Connection timed out during banner exchange`，时间戳全挤在一秒内。
 *
 * 为什么熔断器没起作用：它是在**整段探测失败之后**才记的，而"整段"含 3 次尝试、
 * 每次 30 秒超时。7 条会话在同一毫秒进来时谁都还没失败过，`recentFailure` 对谁都是空的,
 * 于是 7 × 3 = 21 次并发握手一起打出去。
 *
 * 而 sshd 的 `MaxStartups` 默认 `10:30:100` 数的正是"连上了还没认证完"的连接，失败的尝试
 * 还占着槽直到 `LoginGraceTime`（默认 120 秒）—— 也就是**重试自己把队列撑满了**，
 * 然后所有人超时，然后再重试。这是那台 EC2 连不上的直接成因之一。
 */
describe('同一台机器同时只探一次', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('已经有一次在路上就等它，不再自己发一轮', () => {
    assert.match(M, /const preflightInFlight = new Map<string, Promise<string\[\]>>\(\);/);
    const at = M.indexOf('function remotePreflight(');
    const body = M.slice(at, at + 900);
    assert.match(body, /const running = preflightInFlight\.get\(host\);/);
    assert.match(body, /if \(running\) \{[\s\S]{0,300}return running;/);
    /* 完成后必须从表里删掉 —— 不删的话第一次失败的结论会被永久复用 */
    assert.match(body, /\.finally\(\(\) => \{ preflightInFlight\.delete\(host\); \}\)/);
  });

  test('`force` 也一起等 —— 在路上那次就是"现在的答案"', () => {
    const at = M.indexOf('function remotePreflight(');
    const body = M.slice(at, at + 900);
    /* 合并在 force 判断**之前**：否则手动连点重连照样能压出一串并发握手 */
    const merge = body.indexOf('return running;');
    const force = body.indexOf('opts?.force');
    assert.ok(merge > 0 && (force === -1 || merge < force), 'force 不能绕过合并');
  });

  test('熔断器那一层还在（两层各管一段时间）', () => {
    /* 合并管的是"同一瞬间"，熔断管的是"刚刚失败过的 20 秒" —— 少哪层都会漏 */
    const at = M.indexOf('async function runPreflight(');
    assert.ok(at > 0, 'runPreflight 是真正去连的那段');
    const body = M.slice(at, at + 700);
    assert.match(body, /reachability\.recentFailure\(host\)/);
    assert.match(M, /reachability\.fail\(host, verdict\.message\)/);
  });
});
