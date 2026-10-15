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
import { tr, trList } from './uiText.ts';

export type PreflightCode = 'ok' | 'unreachable' | 'missing-tools' | 'not-logged-in';

export interface Preflight {
  code: PreflightCode;
  /** 远端**实际**支持的模型（问不到时为空数组 —— 那时不该拦，只是没验成）。 */
  models?: string[];
  /** 那台机器的 vCPU 数（拿不到是 0 —— 那时不做上限判断，见 `remoteExecutorCap`）。 */
  cpus?: number;
  /** 那台机器的总内存 MB（拿不到是 0）。 */
  memMB?: number;
  /** **可用**内存 MB（`MemAvailable`，拿不到是 0）—— 判断"还能再开几条"用这个。 */
  memAvailMB?: number;
  /** swap 总量 MB。0 = 没有 swap，那时内存吃干是 OOM 杀进程而不是变慢。 */
  swapMB?: number;
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
      所以上限要按**那台机器**算，而不是按本机的默认值（`DEFAULT_EXECUTOR_CAP`）。
      这两行几乎不花时间，而且顺着已有的探测走 —— 不值得为它单开一次 ssh。
    */
    'echo "CPUS $(nproc 2>/dev/null || echo 0)"',
    'echo "MEMMB $(awk \'/MemTotal/{printf "%d", $2/1024}\' /proc/meminfo 2>/dev/null || echo 0)"',
    /*
      **可用内存**（不是 free）——「我又开了几条会话，这个远程机器能处理吗」。
      `MemAvailable` 才是"还能给新进程用多少"：`MemFree` 会因为 page cache 显得很小,
      拿它判断会天天误报。
    */
    'echo "MEMAVAIL $(awk \'/MemAvailable/{printf "%d", $2/1024}\' /proc/meminfo 2>/dev/null || echo 0)"',
    /* 有没有 swap —— 没有的话内存吃干是 OOM 杀进程，不是变慢，这件事要说出来 */
    'echo "SWAPMB $(awk \'/SwapTotal/{printf "%d", $2/1024}\' /proc/meminfo 2>/dev/null || echo 0)"',
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
    /*
      **先用 `--list-models`，它现在有了** —— 上面那段注释写"kiro-cli 没有专门的
      model list 子命令"，那是 1.27.0 时的事，已经过期。

      为什么必须换：那个"故意传错模型"的办法在 2.24.1/2.25.0 上**已经不работает**，
      而且坏得很难看 —— 它不再在参数校验处报错，而是
        `[warn] failed to set model '__kirolex_probe__': Method not found`
      然后**用默认模型真跑了一轮对话**。后果两条：
        · 模型列表恒为空（`Available models:` 那行再也不出现），于是远端模型选择器没有选项，
          而 `pickRemoteModel` 靠它挡"模型不存在时的静默退回"——那道保护也就没了；
        · 每次带模型的预检都白烧一次模型调用（`gpt-5.6-sol` 是 4.40x）。

      `--format json` 比按列切稳，而且顺带拿到倍率和上下文长度（原来倍率只能拿本机那份补，
      而本机清单被地域过滤，一个 Claude 都没有 —— 那正是"claude-opus-5.5 没有倍率"的来源）。

      老版本兜底仍然留着：`--list-models` 失败（旧版没这个参数）才退回去传错模型。
      顺序不能反 —— 反了就是每次都先烧一轮。
    */
    lines.push(
      'if command -v kiro-cli >/dev/null 2>&1; then'
      + ' m="$(kiro-cli chat --list-models --format json 2>/dev/null)";'
      + ' if [ -n "$m" ]; then echo "MODELSJSON $m";'
      + ` else kiro-cli chat --model ${MODEL_PROBE} --no-interactive x 2>&1 | grep -o 'Available models:.*' | head -1; fi; fi`,
    );
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
      message: tr('Cannot connect to {host}: {why}. Check the network/keys/security group (kiro-cli and the files for this machine live on it, so nothing runs without a connection).', { host, why }),
      raw: why,
    };
  }
  const missing = REQUIRED_TOOLS.filter((b) => new RegExp(`MISS ${escape(b)}(\\s|$)`, 'm').test(out));
  if (missing.length) {
    return {
      code: 'missing-tools',
      missing,
      message: tr('{host} is missing {tools}. Run the bootstrap script on the remote once to install everything: `{cmd}` (KiroLex does not install things on the remote for you).', {
        host,
        tools: trList(missing),
        cmd: `scp ${bootstrapHint} ${host}:~/ && ssh ${host} 'bash ~/${baseName(bootstrapHint)}'`,
      }),
    };
  }
  if (/AUTH no/.test(out)) {
    return {
      code: 'not-logged-in',
      message: tr('kiro-cli on {host} is not logged in. Run `kiro-cli login` on that machine once. Without a login the executor starts, but every turn comes back empty, which looks just like the server returning empty responses.', { host }),
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
    memAvailMB: parseMemAvail(out),
    swapMB: parseSwap(out),
    message: models.length
      ? tr('{host}: kiro-cli is installed and logged in, {n} models available.', { host, n: models.length })
      : tr('{host}: kiro-cli is installed and logged in.', { host }),
  };
}

/** 可用内存 MB（`MEMAVAIL n`）。拿不到给 0 —— 0 的含义是"没依据"，下游据此不下结论。 */
export function parseMemAvail(stdout: string): number {
  const v = Number(/^MEMAVAIL (\d+)/m.exec(String(stdout || ''))?.[1]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** swap 总量 MB（`SWAPMB n`）。0 既可能是"没有 swap"也可能是"问不到"，调用方只在有内存数时用它。 */
export function parseSwap(stdout: string): number {
  const v = Number(/^SWAPMB (\d+)/m.exec(String(stdout || ''))?.[1]);
  return Number.isFinite(v) && v >= 0 ? v : 0;
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
 * 实测（那台 t3.medium，2 vCPU / 3.8 GB）：一条会话是**两个**进程。
 *
 * 这个数字**跟着 kiro-cli 的版本变**，所以要记清是哪一版量的：
 *
 *   · 1.27.0：`kiro-cli` ≈ 48 MB + `kiro-cli-chat` ≈ 104–114 MB ≈ **155 MB**；
 *   · 2.24.1：`kiro-cli` ≈ 48 MB + `kiro-cli-chat` ≈ **275–322 MB** ≈ **350 MB**
 *     （2026-09-28 实测：6 条会话占 2100 MB，和 `free -m` 的 used 对得上）。
 *
 * **翻了差不多三倍**。按老数字算余量会得出"还能开 15 条"，而实际上 3.8 GB 的机器
 * 开到 10 条就把内存吃干了 —— 而那台机器当时没有 swap，吃干的表现是 OOM killer
 * 直接杀掉正在跑的那一轮，不是变慢。
 *
 * 6 条时 load 曾冲到 3.86（2 vCPU）。并行 attach 还会撞出 `ssh exit 255`
 * （sshd 的 `MaxStartups`）—— 那条已经修了（一台机器一条复用连接 + preflight 合并）。
 *
 * 所以两条线一起卡：内存按 `REMOTE_MB_PER_SESSION`/条、只用**一半**总内存（那台机器上还有别的东西，
 * 而且 kiro-cli 的峰值远高于静息值）；CPU 按每核 3 条。取小的那个，夹在 [2, 12]。
 *
 * 规格拿不到（0）时返回 0 = **不做限制** —— 没依据的上限比没有上限糟：它会在一台好机器上
 * 无缘无故赶走你的会话。
 */
export const REMOTE_MB_PER_SESSION = 350;

/**
 * **可用内存低于这个数就该说一句了** ——「我又开了几条会话，这个远程机器能处理吗，
 * 没有又卡挂了吧」。
 *
 * 取两条会话的量：一条的余量太晚（你已经在开第 N 条了），三条又太早（天天报）。
 * 这是**告知**，不是上限 —— 上限那套机械已经删掉了（它引发过"赶走-又回来"的循环）。
 */
export const REMOTE_LOW_MEM_MB = REMOTE_MB_PER_SESSION * 2;

/** 按可用内存还能开几条（拿不到内存数时返回 -1 = 不知道，别乱说）。 */
export function remoteHeadroom(availMB: number): number {
  if (!availMB || availMB <= 0) return -1;
  return Math.floor(availMB / REMOTE_MB_PER_SESSION);
}

export function remoteExecutorCap(cpus: number, memMB: number): number {
  if (!cpus || !memMB) return 0;
  const byMem = Math.floor((memMB * 0.5) / REMOTE_MB_PER_SESSION);
  const byCpu = cpus * 3;
  return Math.max(2, Math.min(12, byMem, byCpu));
}

/**
 * 从预检输出里把模型列表解析出来。
 *
 * 两种来源：`--list-models --format json`（新版，首选），和老那条"传错模型、从报错里抠"
 * 的输出（旧版兜底）。ANSI 要脱掉 —— 老那条是 kiro-cli 的错误输出，带色。
 */
export function parseModels(stdout: string): string[] {
  // eslint-disable-next-line no-control-regex
  const clean = String(stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
  const json = /^MODELSJSON (.*)$/m.exec(clean)?.[1];
  if (json) {
    try {
      const arr = JSON.parse(json)?.models;
      if (Array.isArray(arr)) {
        /* `model_id` 才是传给 `--model` 的那个名字；`model_name` 只是显示用的 */
        const ids = arr.map((m: any) => String(m?.model_id || m?.model_name || '').trim()).filter(Boolean);
        if (ids.length) return ids;
      }
    } catch { /* JSON 坏了就往下走老那条 —— 有一份能用总比空列表好 */ }
  }
  const line = /Available models:(.*)$/m.exec(clean)?.[1];
  if (!line) return [];
  return line.split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * 模型的倍率/上下文长度（只有 `--list-models --format json` 那条路有）。
 * 拿不到就返回空 —— **不要拿本机那份去补**：本机清单按出口 IP 做地域过滤
 * （这台 Mac 上一个 Claude 都没有），补出来的会是错的或者干脆缺。
 */
export function parseModelMeta(stdout: string): Record<string, { rate?: number; context?: number }> {
  // eslint-disable-next-line no-control-regex
  const clean = String(stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
  const json = /^MODELSJSON (.*)$/m.exec(clean)?.[1];
  if (!json) return {};
  try {
    const arr = JSON.parse(json)?.models;
    if (!Array.isArray(arr)) return {};
    const out: Record<string, { rate?: number; context?: number }> = {};
    for (const m of arr) {
      const id = String(m?.model_id || m?.model_name || '').trim();
      if (!id) continue;
      const rate = Number(m?.rate_multiplier);
      const context = Number(m?.context_window_tokens);
      out[id] = {
        ...(Number.isFinite(rate) ? { rate } : {}),
        ...(Number.isFinite(context) ? { context } : {}),
      };
    }
    return out;
  } catch { return {}; }
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
