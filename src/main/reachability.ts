/**
 * **一台机器连不上的时候，别让 20 条会话各捅它一次** ——「为什么这个连不上…有重试机制吗」。
 *
 * ## 实测现场
 *
 * 那台 EC2 的症状是 `Connection timed out during banner exchange`：
 *
 * ```
 * nc 22 端口  → succeeded        （TCP 通）
 * ping        → 0% 丢包，85ms    （网络通）
 * ssh -vv     → Connection established. / Local version string SSH-2.0-… / 然后超时
 * ```
 *
 * banner 交换是 SSH 的**第一步**，在密钥交换和认证之前 —— 所以密钥、用户名、安全组全都还没用上，
 * 问题在**那台机器上的 sshd 不应答**（资源打满，或卡在 `MaxStartups`：半开连接堆积）。
 *
 * ## 两件事
 *
 * 1. **退避重试**：原来 preflight 一次不成就抛。而 sshd 在压力下的失败常常是几秒内自愈的
 *    （`MaxStartups` 是个滑动窗口），一次就判死刑太早。
 * 2. **整机级熔断**：重试解决不了的那种（机器真的病了），20 条会话各试 3 次 = 60 次连接，
 *    而 `MaxStartups` 恰恰是被这种并发压出来的 —— 也就是"重试"本身会变成病因。
 *    所以同一台机器刚判定连不上时，后面的会话**直接复用那个结论**，不再碰它。
 *
 * 熔断窗口刻意短（默认 20 秒）：它要挡的是"启动时 20 条会话同时 attach"这种**瞬间并发**，
 * 而不是"这台机器今天别用了"。你手动点重连时不受它限制 —— 那是明确的人类意图。
 */

/** 熔断窗口：同一台机器在这段时间内已经判定连不上，后面的直接复用结论。 */
export const BREAKER_MS = 20_000;

/**
 * 重试几次（含第一次）——「给这个远程会话多加一些重试吧」。
 *
 * 从 3 次加到 **5** 次，退避也拉长（总时长从 ~4 秒到 ~18 秒）。两条理由：
 *
 * 1. **那台机器确实会短暂连不上**。实测（2026-09-28）：一次 `ssh` 直接
 *    `Operation timed out`，30 秒后再连一切正常、load 0.06 —— 也就是说那不是"机器坏了",
 *    而是一次抖动。3 次 × 短退避（4 秒内打完）很容易整段落在同一次抖动里。
 * 2. **多试现在不再是病因了**。原来不敢加，是因为并发探测会把 sshd 的 `MaxStartups`
 *    队列撑满（7 条会话 × 3 次 = 21 次并发握手，实测过）。那条已经修了：
 *    同一台机器同时只有**一个**探测在路上（`preflightInFlight`），
 *    所以 5 次是**一个**探测者的 5 次**顺序**连接，不是 35 次并发。
 *
 * 退避拉到 10 秒是刻意的：sshd 在压力下的 `MaxStartups` 是个滑动窗口，
 * 而 `LoginGraceTime` 默认 120 秒 —— 隔得太近等于还在同一个拥塞窗口里重试。
 */
export const PREFLIGHT_ATTEMPTS = 5;

/**
 * 第 n 次失败后等多久再试（毫秒）。指数退避。
 *
 * 总时长 ~18 秒。这确实比原来的 4 秒久，但它只发生在**真的连不上**的时候 ——
 * 而那时候的替代方案是"直接告诉你连不上"，然后你自己点重连、再等一轮。
 */
export function backoffMs(attempt: number): number {
  return [800, 2_000, 5_000, 10_000][attempt - 1] ?? 10_000;
}

/**
 * 哪些失败**值得重试**。
 *
 * 值得：连接层面的、可能几秒内自愈的 —— banner 超时、连接超时、连接被拒、短暂的 DNS 抖动。
 * 不值得：**结论已经确定**的那些 —— 密钥不对、主机密钥变了、机器上没装 kiro-cli、没登录。
 * 重试一个确定的失败只是把同一条错误消息说三遍，还让人多等 4 秒。
 */
export function worthRetrying(message: string): boolean {
  const m = String(message || '');
  if (/Permission denied|publickey|HOST KEY|Host key verification|没装|没有登录|没登录|还没有设置/.test(m)) return false;
  return /banner exchange|Connection timed out|timed out|Connection refused|Connection closed|reset by peer|Temporary failure|Could not resolve/.test(m);
}

interface Mark { at: number; message: string }

/**
 * 每台机器最近一次"连不上"的结论。
 *
 * 进程级、不落盘：机器活过来之后重启 app 不该还记着它坏 —— 而 20 秒的窗口本来就不需要持久化。
 */
export class Breaker {
  private marks = new Map<string, Mark>();
  private windowMs: number;
  private now: () => number;

  /*
    显式赋值，不用 TS 的"构造参数属性"简写 —— Node 的 type-stripping 不支持那个语法
    （`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`），而这个仓库的测试是直接跑 .ts 的。
  */
  constructor(windowMs = BREAKER_MS, now: () => number = Date.now) {
    this.windowMs = windowMs;
    this.now = now;
  }

  /** 这台机器此刻是不是"刚被判定连不上"。返回那次的原因，便于原样报给用户。 */
  recentFailure(host: string): string | undefined {
    const mark = this.marks.get(host);
    if (!mark) return undefined;
    if (this.now() - mark.at > this.windowMs) { this.marks.delete(host); return undefined; }
    return mark.message;
  }

  fail(host: string, message: string): void {
    this.marks.set(host, { at: this.now(), message });
  }

  /** 连上了就清掉 —— 否则机器恢复之后还要空等一个窗口。 */
  ok(host: string): void {
    this.marks.delete(host);
  }
}
