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
    /* 成功那一支现在还顺路记下那台机器的规格（算并发上限用）—— 所以不再是一行 */
    assert.match(body, /reachability\.ok\(host\);/);
    assert.match(body, /return verdict\.models \|\| \[\];/);
    assert.match(body, /remoteCaps\.set\(host, cap\)/);
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
 * 「远程能承受多少个远程 session？这个有限制吧」—— 有，而且实测撞过。
 *
 * 那台 t3.medium（2 vCPU / 3.8 GB）上，一条会话是**两个**进程：
 *   `kiro-cli` ≈ 48 MB + `kiro-cli-chat` ≈ 104–114 MB ≈ **155 MB**
 * 6 条 = 941 MB RSS、load 3.86；并行 attach 还撞出过 `ssh exit 255`（sshd 的 `MaxStartups`）。
 * 内存上看能塞 15 条以上，但 2 vCPU 先顶不住。
 *
 * 而本机那道闸（`MAX_CONCURRENT_SESSIONS`，`computeExecutorCap`）算的是**你这台笔记本**的
 * RAM/CPU —— 它允许 16 条的时候，远端那台早趴了。所以上限必须按**那台机器**算。
 */
describe('每台远端机器的并发上限', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('按那台机器的 CPU 和内存算，取小的那个', async () => {
    const { remoteExecutorCap, REMOTE_MB_PER_SESSION } = await import('../src/main/remotePreflight.ts');
    /* 实测那台：2 vCPU / 3839 MB → 6（和它当时真在跑的 6 条吻合） */
    assert.equal(remoteExecutorCap(2, 3839), 6);
    /* 内存管够但核少 → CPU 说话；核多内存大 → 夹在上限 12 */
    assert.equal(remoteExecutorCap(2, 64000), 6);
    assert.equal(remoteExecutorCap(8, 32000), 12);
    /* 小机器也至少给 2 —— 只能跑 1 条的远程会话没有意义 */
    assert.equal(remoteExecutorCap(1, 512), 2);
    assert.equal(REMOTE_MB_PER_SESSION, 155);
  });

  test('规格拿不到就**不限制** —— 没依据的上限会无缘无故赶走你的会话', async () => {
    const { remoteExecutorCap, parseSpecs } = await import('../src/main/remotePreflight.ts');
    assert.equal(remoteExecutorCap(0, 0), 0);
    assert.equal(remoteExecutorCap(2, 0), 0);
    assert.deepEqual(parseSpecs('CPUS 2\nMEMMB 3839'), { cpus: 2, memMB: 3839 });
    assert.deepEqual(parseSpecs('什么都没有'), { cpus: 0, memMB: 0 });
    /* 0 要当"没依据"，不是"0 核 0 内存" */
    assert.deepEqual(parseSpecs('CPUS 0\nMEMMB 0'), { cpus: 0, memMB: 0 });
  });

  test('规格顺着已有的 preflight 报回来，不为它单开一次 ssh', async () => {
    const { preflightScript } = await import('../src/main/remotePreflight.ts');
    const sh = preflightScript();
    assert.match(sh, /echo "CPUS \$\(nproc/);
    assert.match(sh, /MemTotal/);
  });

  test('满了先断开最久没用的；都在忙就让它超一条', () => {
    const at = M.indexOf('function makeRoomOnRemote');
    const body = M.slice(at, M.indexOf('\n}', M.indexOf('detachExecutor(victim)', at)));
    assert.match(body, /if \(!cap\) return;/, '没探到规格就不限制');
    assert.match(body, /if \(id === excludeId \|\| entry\.busy\) continue;/, '不许动正在跑的');
    assert.match(body, /这次让它超一条/);
    assert.match(body, /detachExecutor\(victim\)/);
  });

  test('三条起执行器的路都过这道闸（新建 / attach / 换机器）', () => {
    assert.equal((M.match(/makeRoomOnRemote\(/g) || []).length, 4, '一处定义 + 三处调用');
  });

  test('数的是按 sshHost 的执行器，不是 ssh 进程', () => {
    /* 换模型/换 agent 那一瞬会同时存在新旧两个执行器（先起新的再关旧的），数进程会误判超额 */
    assert.match(M, /function remoteExecutorCount\(host: string, excludeId\?: string\): number/);
    assert.match(M, /\(entry\.profile\.remote\?\.sshHost \|\| ''\) === host/);
  });
});

/*
 * 「修好了之后起一个新的远程会话测试下」的前置：**这道闸原来在并行 attach 时形同不存在**。
 *
 * 实测：上限算出来是 6，而重启那一轮起了 **8 个**执行器。因为每条会话都在
 * `sessionClients.set(...)` 之前做检查，中间还要 await preflight / ensureLocalTools / connect ——
 * 于是它们各自都看到"还没满"。和当初两条会话抢到同一个远端端口是同一个形状：
 * **占位必须在任何 await 之前同步完成。**
 */
describe('并发起会话时上限不能被绕过', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('占位是同步的，而且计数把"正在起"的算进去', () => {
    assert.match(M, /const remoteStarting = new Map<string, \{ host: string; at: number \}>\(\);/);
    /* 同步 set —— 在 makeRoomOnRemote 里，任何 await 之前 */
    assert.match(M, /if \(excludeId\) remoteStarting\.set\(excludeId, \{ host, at: Date\.now\(\) \}\);/);
    assert.match(M, /if \(id !== excludeId && slot\.host === host\) n \+= 1;/);
  });

  test('注册成功就放 —— 所有起执行器的路都过 `wireSession`', () => {
    const at = M.indexOf('function wireSession(sessionId: string, entry: SessionEntry)');
    assert.ok(at > 0);
    assert.match(M.slice(at, at + 500), /releaseRemoteSlot\(sessionId\);/);
  });

  test('占位会过期 —— 漏放要能自愈', () => {
    /* 起执行器有好几条失败路径，逐条塞 finally 只要漏一条，那台机器就被永久占掉一个名额 */
    assert.match(M, /const REMOTE_SLOT_TTL_MS = 120_000;/);
    assert.match(M, /if \(now - slot\.at > REMOTE_SLOT_TTL_MS\) \{ remoteStarting\.delete\(id\); continue; \}/);
  });
});
