/**
 * **连远端之前先问三句话** —— 远程会话（`docs/DESIGN_remote_sessions.md`）。
 *
 * 不做这个检查的代价不是"少一条提示"，而是失败会伪装成别的东西：没装 rsync → 推送失败 →
 * 界面上是"这一轮没发出去"；远端没登录 → kiro-cli 起来了但每一轮都空回 → 看起来就是那个
 * 查了整整一天的 `EmptyResponse`。所以在起执行器之前一次性问清，并且**三种情况给三句不同的话**。
 *
 * 一条 SSH 问完（不是三条）：握手本身就要一秒级，而这三件事互相独立。
 */

import type { RemoteTarget } from './config';

export type PreflightCode = 'ok' | 'unreachable' | 'missing-tools' | 'not-logged-in';

export interface Preflight {
  code: PreflightCode;
  /** 远端**实际**支持的模型（问不到时为空数组 —— 那时不该拦，只是没验成）。 */
  models?: string[];
  /** 那台机器的 vCPU 数（拿不到是 0 —— 那时不做上限判断，见 `remoteExecutorCap`）。 */
  cpus?: number;
  /** 那台机器的总内存 MB（拿不到是 0）。 */
  memMB?: number;
  /** 那台机器上 kiro-cli 的版本（`2.24.1` 这种）。问不到就没有这个字段。 */
  kiroVersion?: string;
  /** 给人看的一句话：说清是什么问题、下一步干什么。 */
  message: string;
  /** 缺了哪些命令（`missing-tools` 时有值）。 */
  missing?: string[];
  raw?: string;
}

/**
 * 远端要有的东西 —— **只剩 kiro-cli 一个**。
 *
 * `git` 随镜像一起去掉（远端没有那个仓库，`local_git` 查的是用户机器上那一份）；
 * `rsync` 随 agent 同步一起去掉（agent 配置现在是**生成**一份写过去，不再推本机那一堆）。
 * 多列一个用不到的依赖，代价是拿它挡住一条本来能跑的会话。
 */
export const REQUIRED_TOOLS = ['kiro-cli'];

/**
 * **顺带把远端的模型列表问出来** ——「模型列表其实也完全不一样，你看看能不能行」。
 *
 * 实测这两台机器上是一样的（各 19 个，同为 kiro-cli 1.27.0、同一个 Identity Center），
 * 但 KiroLex 从来没验过这件事，而**验不验的差别不是"提示语"**：远端要是个旧版、少了你选的那个模型，
 * kiro-cli 会静默退回（日志里见过 `Model 'gpt-5.6-terra' does not exist. Available models: auto`），
 * 于是这一轮是另一个模型答的，而界面上什么都不说。
 *
 * 拿列表的方式是"故意传一个不存在的模型"：它在**参数校验**这一步就报错并把可用列表打出来，
 * 不会真的调模型、不花额度。kiro-cli 没有专门的 `model list` 子命令，这是唯一的路。
 */
export const MODEL_PROBE = '__kirolex_probe__';

/**
 * 一条命令问清：哪些工具在、有没有登录、（可选）远端有哪些模型。
 *
 * **`models: false` 时不问模型** ——「测试连接那里不必检测 kiro 模型」。
 * 那一步要起一次 `kiro-cli chat`（哪怕只走到参数校验），是这条探测里最慢的一段；
 * 而"这台机器连得上吗"和"它支持哪些模型"是两个问题：按连接测试来说，模型列表既不改变结论、
 * 又让你多等几秒。起会话那条路仍然要问（`pickRemoteModel` 靠它，否则模型不对会**静默**退回）。
 */
export function preflightScript(tools: string[] = REQUIRED_TOOLS, opts: { models?: boolean } = {}): string {
  const lines = [
    `for b in ${tools.join(' ')}; do command -v "$b" >/dev/null 2>&1 && echo "HAVE $b" || echo "MISS $b"; done`,
    /* `whoami` 的输出形状不保证，所以只看它成不成 —— 未登录时 kiro-cli 是非零退出 */
    'if command -v kiro-cli >/dev/null 2>&1; then kiro-cli whoami >/dev/null 2>&1 && echo "AUTH ok" || echo "AUTH no"; fi',
    /*
      **顺路把这台机器的规格报回来** ——「远程能承受多少个远程 session？这个有限制吧」。
      有限制，而且实测撞过：那台 t3.medium（2 vCPU / 3.8 GB）上一条会话是**两个**进程
      （`kiro-cli` ≈ 48 MB + `kiro-cli-chat` ≈ 104–114 MB ≈ 155 MB），6 条就占 941 MB，
      load 冲到 3.86；并行 attach 时还会撞出 `ssh exit 255`（sshd 的 MaxStartups）。
      所以上限要按**那台机器**算，而不是按本机的 RAM/CPU（现有的 `computeExecutorCap` 算的是本机）。
      这两行几乎不花时间，而且顺着已有的探测走 —— 不值得为它单开一次 ssh。
    */
    'echo "CPUS $(nproc 2>/dev/null || echo 0)"',
    'echo "MEMMB $(awk \'/MemTotal/{printf "%d", $2/1024}\' /proc/meminfo 2>/dev/null || echo 0)"',
    /*
      **顺路报一下它的 kiro-cli 版本** ——「怎么控制远端的版本呢，远端应该也定期更新一下」。
      不报的代价是实测出来的：那台机器停在 **1.27.0**，而本机已经 2.24.1 —— 差一个大版本。
      1.27.0 连 `--list-models` 都没有，所以它的模型清单只能"故意传一个错模型、从参数校验的
      报错里抠 id"，倍率只能拿本机那份去补；而本机清单被地域过滤（一个 Claude 都没有），
      于是 `claude-opus-5.5` 就彻底没有倍率 —— 用户看到的就是那个。
      这一行几乎不花时间，而且顺着已有的探测走，不值得为它单开一次 ssh。
    */
    'echo "KVER $(kiro-cli --version 2>/dev/null | head -1 | grep -oE \'[0-9]+\\.[0-9]+\\.[0-9]+\' | head -1)"',
  ];
  if (opts.models !== false) {
    /* 模型列表：参数校验就会失败，不会真的调模型 */
    lines.push(`if command -v kiro-cli >/dev/null 2>&1; then kiro-cli chat --model ${MODEL_PROBE} --no-interactive x 2>&1 | grep -o 'Available models:.*' | head -1; fi`);
  }
  return lines.join('; ');
}

/**
 * 把输出翻译成结论。
 *
 * 顺序是**故意**的：连不上 → 缺工具 → 没登录。缺 rsync 的时候谈登录没有意义，
 * 而把顺序倒过来会让人先去折腾登录，然后发现真正的问题在别处。
 */
export function judgePreflight(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  remote: RemoteTarget,
  bootstrapHint = 'scripts/remote-bootstrap.sh',
): Preflight {
  const host = remote.sshHost || 'remote';
  const out = String(stdout || '');
  if (exitCode !== 0 && !/HAVE |MISS /.test(out)) {
    const why = firstLine(stderr) || `ssh exit ${exitCode}`;
    return {
      code: 'unreachable',
      message: `连不上 ${host}：${why}。检查网络/密钥/安全组（这台机器的 kiro-cli 和文件都在它上面，连不上就跑不了）。`,
      raw: why,
    };
  }
  const missing = REQUIRED_TOOLS.filter((b) => new RegExp(`MISS ${escape(b)}(\\s|$)`, 'm').test(out));
  if (missing.length) {
    return {
      code: 'missing-tools',
      missing,
      message: `${host} 上缺 ${missing.join('、')}。在远端跑一次预置脚本装齐：`
        + `\`scp ${bootstrapHint} ${host}:~/ && ssh ${host} 'bash ~/${baseName(bootstrapHint)}'\``
        + `（KiroLex 不替你在远端装东西）。`,
    };
  }
  if (/AUTH no/.test(out)) {
    return {
      code: 'not-logged-in',
      message: `${host} 上的 kiro-cli 没登录。去那台机器跑一次 \`kiro-cli login\`——`
        + `没登录的话执行器起得来、但每一轮都空回，看起来就像服务端在返空响应。`,
    };
  }
  const models = parseModels(out);
  const { cpus, memMB } = parseSpecs(out);
  return {
    code: 'ok',
    models,
    cpus,
    memMB,
    kiroVersion: parseKiroVersion(out),
    message: `${host}：kiro-cli 在，也登录了${models.length ? `，${models.length} 个可用模型` : ''}。`,
  };
}

/**
 * 那台机器上 kiro-cli 的版本（`KVER 2.24.1`）。问不到返回 undefined ——
 * 「没问到」和「旧」必须分开：拿不到版本时**不该**提醒人去更新。
 */
export function parseKiroVersion(stdout: string): string | undefined {
  const m = /^KVER\s+(\d+\.\d+\.\d+)\s*$/m.exec(String(stdout || ''));
  return m ? m[1] : undefined;
}

/**
 * **a 比 b 旧吗** —— 逐段比数字，不做字符串比较。
 *
 * 字符串比较会说 `1.27.0` > `2.24.1`（'2' < '1' 为假、但 '1'<'2' 让 1.27 排在前面是巧合，
 * 而 `1.9.0` vs `1.27.0` 就直接错了：'9' > '2'）。这两个版本恰好是实测遇到的那一对。
 */
export function isOlderVersion(a?: string, b?: string): boolean {
  if (!a || !b) return false;          // 有一边不知道就不下结论
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** 那台机器的规格（`CPUS n` / `MEMMB n`）。拿不到给 0 —— 0 的含义是"没依据"，下游据此不做判断。 */
export function parseSpecs(stdout: string): { cpus: number; memMB: number } {
  const out = String(stdout || '');
  const n = (re: RegExp): number => {
    const v = Number(re.exec(out)?.[1]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  return { cpus: n(/^CPUS (\d+)/m), memMB: n(/^MEMMB (\d+)/m) };
}

/**
 * **那台机器能同时扛几条远程会话** ——「远程能承受多少个远程 session？这个有限制吧」。
 *
 * 实测（那台 t3.medium，2 vCPU / 3.8 GB）：一条会话是**两个**进程 ——
 * `kiro-cli` ≈ 48 MB + `kiro-cli-chat` ≈ 104–114 MB ≈ **155 MB**；6 条占 941 MB RSS，
 * load 冲到 3.86。内存上看能塞 15 条以上，但 2 vCPU 先顶不住，而并行 attach 还会撞出
 * `ssh exit 255`（sshd 的 `MaxStartups`）—— 这一晚实测出现过。
 *
 * 所以两条线一起卡：内存按 155 MB/条、只用**一半**总内存（那台机器上还有别的东西，
 * 而且 kiro-cli 的峰值远高于静息值）；CPU 按每核 3 条。取小的那个，夹在 [2, 12]。
 *
 * 规格拿不到（0）时返回 0 = **不做限制** —— 没依据的上限比没有上限糟：它会在一台好机器上
 * 无缘无故赶走你的会话。
 */
export const REMOTE_MB_PER_SESSION = 155;

export function remoteExecutorCap(cpus: number, memMB: number): number {
  if (!cpus || !memMB) return 0;
  const byMem = Math.floor((memMB * 0.5) / REMOTE_MB_PER_SESSION);
  const byCpu = cpus * 3;
  return Math.max(2, Math.min(12, byMem, byCpu));
}

/** 从预检输出里把模型列表解析出来（ANSI 要脱掉：那一行是 kiro-cli 的错误输出，带色）。 */
export function parseModels(stdout: string): string[] {
  // eslint-disable-next-line no-control-regex
  const clean = String(stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
  const line = /Available models:(.*)$/m.exec(clean)?.[1];
  if (!line) return [];
  return line.split(',').map((x) => x.trim()).filter(Boolean);
}

function firstLine(s: string): string {
  return String(s || '')
    .split('\n')
    .map((l) => l.trim())
    /* SSH 的后量子告警每次都有，不是原因 —— 认它会让每一次"连不上"都指错 */
    .filter((l) => l && !/post-quantum|store now, decrypt later|openssh\.com|^\*\*/.test(l))[0] || '';
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function baseName(p: string): string {
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}
