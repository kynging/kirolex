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
    assert.equal(backoffMs(2), 2_000);
    assert.equal(backoffMs(3), 5_000);
    assert.equal(backoffMs(4), 10_000);
    /* 超出表尾夹在最后一档 */
    assert.equal(backoffMs(99), 10_000);
    /* 三次尝试、两段等待 —— 最坏多等 4 秒 */
    /*
      3 → 5 ——「给这个远程会话多加一些重试吧」。原来不敢加是因为并发探测会撑满 sshd 的
      `MaxStartups`；那条修了（同一台机器同时只有一个探测在路上），所以 5 次是**一个**
      探测者的 5 次顺序连接，不是 35 次并发。
    */
    assert.equal(PREFLIGHT_ATTEMPTS, 5);
    /*
      总时长从 ~4 秒拉到 ~18 秒 ——「给这个远程会话多加一些重试吧」。
      拉长是刻意的：sshd 压力下的 `MaxStartups` 是滑动窗口、`LoginGraceTime` 默认 120 秒,
      隔 3 秒再试等于还在同一个拥塞窗口里。而这段等待只在**真的连不上**时发生。
    */
    const total = [1, 2, 3, 4].reduce((sum, n) => sum + backoffMs(n), 0);
    assert.ok(total > 5_000 && total <= 20_000, `总退避 ${total}ms`);
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
    /*
      155 → 350：kiro-cli 2.24.1 之后 `kiro-cli-chat` 从 104–114 MB 涨到 275–322 MB
      （2026-09-28 实测 6 条会话占 2100 MB）。按老数字算余量会得出"还能开 15 条",
      而 3.8 GB 的机器其实开到 10 条就吃干。
    */
    assert.equal(REMOTE_MB_PER_SESSION, 350);
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

/*
 * 「怎么控制远端的版本呢，远端应该也定期更新一下。本地现在是什么版本？」
 * 「本地的版本你也帮忙看一下，做个类似的功能」。
 *
 * 版本差不是"数字不一样"这么轻。实测：远端停在 **1.27.0**、本机 **2.24.1** —— 差一个大版本，
 * 而 1.27.0 **没有** `--list-models`。于是那台机器的模型清单只能靠"故意传个错模型、
 * 从参数校验的报错里抠 id"，倍率只能拿本机那份去补；而本机清单被地域过滤（一个 Claude 都没有），
 * `claude-opus-5.5` 就彻底没有倍率 —— 那正是用户看到的"没有乘数"。
 * 远端更新到 2.24.1 之后它自己报 2.00x，问题当场消失。
 */
describe('kiro-cli 版本：报出来，更新交给人', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('版本比较逐段比数字 —— 字符串比较会说 1.27.0 比 2.24.1 新', async () => {
    const { isOlderVersion } = await import('../src/main/remotePreflight.ts');
    assert.equal(isOlderVersion('1.27.0', '2.24.1'), true, '这就是实测遇到的那一对');
    assert.equal(isOlderVersion('2.24.1', '1.27.0'), false);
    assert.equal(isOlderVersion('2.24.1', '2.24.1'), false);
    /* 段内必须按数字比：'9' > '2' 会让 1.9.0 看起来比 1.27.0 新 */
    assert.equal(isOlderVersion('1.9.0', '1.27.0'), true);
    assert.equal(isOlderVersion('2.24', '2.24.1'), true, '缺的段当 0');
    /* **有一边不知道就不下结论** —— "没探过"不等于"旧" */
    assert.equal(isOlderVersion(undefined, '2.24.1'), false);
    assert.equal(isOlderVersion('1.0.0', undefined), false);
  });

  test('preflight 顺路带回远端版本，不额外开一次 ssh', async () => {
    const { preflightScript, parseKiroVersion } = await import('../src/main/remotePreflight.ts');
    assert.match(preflightScript(), /KVER /);
    assert.equal(parseKiroVersion('CPUS 2\nKVER 2.24.1\nMEMMB 3839'), '2.24.1');
    /* 问不到时是 undefined，而不是某个"看起来很旧"的默认值 */
    assert.equal(parseKiroVersion('CPUS 2\nKVER \n'), undefined);
    assert.equal(parseKiroVersion(''), undefined);
  });

  test('"落后了"一台机器只说一次', () => {
    assert.match(M, /const remoteVersionWarned = new Set<string>\(\);/);
    assert.match(M, /remoteVersionWarned\.has\(host\)/);
    /* 更新之后要把记忆清掉，否则修好了还在提醒 */
    assert.match(M, /remoteVersionWarned\.delete\(target!\.sshHost\)/);
  });

  test('**不**自动更新 —— 那个二进制是整台机器共用的', () => {
    /* 定时自动换掉它 = 版本在你不知道的时候变了，而行为变了的话排查起点会很远 */
    assert.equal(/setInterval[^;]{0,200}update -y/.test(M), false);
    const at = M.indexOf("ipcMain.handle('kiro:update'");
    assert.ok(at > 0);
    const body = M.slice(at, at + 3200);
    /* 有会话连着时先说清有几条在用，人再点一次才真更新 */
    assert.match(body, /needsConfirm: true, inUse: busy/);
    assert.match(body, /if \(busy && !force\)/);
    /* 报出前后两个版本号 —— "更新成功了"这句话本身不含信息 */
    assert.match(body, /changed: !!from && !!to && from !== to/);
  });

  test('本机和远端一视同仁（本机那条也要拦、缓存也要失效）', () => {
    const at = M.indexOf("ipcMain.handle('kiro:update'");
    const body = M.slice(at, at + 3200);
    /* 本机在用的判据是"没有 remote 的那些会话" */
    assert.match(body, /filter\(\(e\) => !e\.profile\.remote\?\.sshHost\)\.length/);
    /* 更新完必须让版本缓存失效，否则界面上还是旧号 */
    assert.match(body, /localKiroVersionCache = undefined;/);
    assert.match(body, /await runKiroCli\('update -y', 600_000\)/);
  });

  test('本机版本问一次就缓存（一次运行里它不会变）', () => {
    assert.match(M, /let localKiroVersionCache: string \| undefined;/);
    const at = M.indexOf('async function localKiroVersion()');
    const body = M.slice(at, at + 500);
    assert.match(body, /if \(localKiroVersionCache\) return localKiroVersionCache;/);
  });

  test('远端能自己报清单时就用它的 —— 倍率该来自提供模型的那台机器', async () => {
    const { parseModelListJson } = await import('../src/main/modelAvailability.ts');
    /* 2.24.1 起远端和本机是同一个结构 */
    const real = '{"models":[{"model_name":"claude-opus-5.5","model_id":"claude-opus-5.5",'
      + '"context_window_tokens":1000000,"rate_multiplier":2.0,"rate_unit":"Credit"}]}';
    const parsed = parseModelListJson(real);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].rate_multiplier, 2);
    /* 前面混了 login shell 的噪音也要能读 */
    assert.equal(parseModelListJson(`warning: something\n${real}`).length, 1);
    /* 读不出来返回空数组 → 调用方退回旧探测，而不是"版本旧一点就列不出模型" */
    assert.deepEqual(parseModelListJson('error: unexpected argument'), []);
    assert.deepEqual(parseModelListJson(''), []);
    /* 没有 model_id 的条目不要 —— 它进了缓存就是把"没信息"固化成"信息是空的" */
    assert.deepEqual(parseModelListJson('{"models":[{"model_name":"x"}]}'), []);

    /* 远程分支抽成了 `listModelsRemote`（`acp:list-models` 和辅助模型的多机清单共用） */
    const at = M.indexOf('const listModelsRemote = async');
    assert.ok(at > 0);
    assert.match(M, /if \(machine && machine !== 'local'\) return listModelsRemote\(machine\);/);
    const body = M.slice(at, at + 4000);
    assert.match(body, /chat --list-models --format json 2>\/dev\/null \|\| true/);
    /* 顺序：能问就问，问不到才退回那条"从报错里抠 id" */
    assert.ok(body.indexOf('parseModelListJson') < body.indexOf('MODEL_PROBE'));
  });

  test('opus 5.5 的兜底倍率是抄来的真数字', async () => {
    const { FALLBACK_META } = await import('../src/main/modelMeta.ts');
    /* 2026-09-27 远端更新到 2.24.1 之后那份真实清单里报的就是 2.00x */
    assert.equal(FALLBACK_META['claude-opus-5.5']?.rate_multiplier, 2);
  });
});
