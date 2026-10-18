/**
 * **kiro-cli 自己的日志里那句真话** ——「还是不知道为什么会断」。
 *
 * KiroLex 从 ACP 上拿到的错误是 kiro-cli 的万能包装：`-32603 Internal error — Kiro failed to
 * generate a response`。而同一时刻 kiro-cli 自己的日志（`$TMPDIR/kiro-log/kiro-chat.log`，
 * 默认就是 ERROR 级别、一直在写）里写的是**具体哪一层坏了**：
 *
 * ```
 * ERROR agent::agent: response stream encountered an error err=EmptyResponse loop_id=…
 * ```
 *
 * 实测统计（11 个 KiroLex 日志、29 次发送失败）：
 *   · 15 次 `EmptyResponse` —— 服务端把流开了，一个 token 都没发
 *   ·  11 次 `dispatch failure` —— 连不上（网络/VPN）
 *   ·  1 次模型退役、1 次历史里有超限图片、1 次 kiro-cli 进程自己退出
 * 这五件事在界面上长得一模一样，都是"Internal error"。所以这个模块只干一件事：
 * **把 kiro-cli 那一行捞出来，贴到用户看得见的地方。**
 *
 * 为什么不改成让 kiro-cli 说清楚：那是它的包装层，不在 KiroLex 里；而这条日志是它**已经**写下的。
 *
 * ## 日志在哪台机器上
 *
 * 远程会话（`docs/DESIGN_remote_sessions.md`）里 kiro-cli 跑在另一台机器上，这份日志也就在那边。
 * 所以"读哪台机器"交给 `HostOps`，判据和措辞一个字不变 —— 否则远程会话上界面又只剩一句
 * `Internal error`，这个模块整个白做。
 */

import path from 'path';
import type { HostOps } from './hostOps.ts';
import { tr, trConcat } from './uiText.ts';
import { NOTE_DETAIL_SEP } from './kirolexNote.ts';

/** kiro-cli 把 chat 日志写在 TMPDIR 下（实测 macOS 和 AL2023 都是 `$TMPDIR/kiro-log/kiro-chat.log`）。 */
export function kiroCliLogPath(tmpdir: string): string {
  return path.join(tmpdir, 'kiro-log', 'kiro-chat.log');
}

/** 那台机器上这份日志的完整路径。 */
export async function kiroCliLogPathOn(host: HostOps): Promise<string> {
  return kiroCliLogPath(await host.tmpdir());
}

/** 日志带 ANSI 颜色（`ERROR` 是红的），不脱掉的话任何匹配都会漏。 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export interface CliLogLine {
  ts: number;
  level: string;
  target: string;
  message: string;
}

/** 只读文件**尾部**：这个文件实测 5MB 起，而我们要的是刚刚那几行。 */
export const TAIL_BYTES = 256 * 1024;

/** 纯解析：一段日志文本里时间窗内的 ERROR/WARN。读文件的事在 `HostOps` 那一层。 */
export function parseTailErrors(buf: string, sinceMs: number, now = Date.now()): CliLogLine[] {
  const out: CliLogLine[] = [];
  for (const raw of buf.split('\n')) {
    const line = stripAnsi(raw);
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(ERROR|WARN)\s+(\S+):\s*(?:\d+:\s*)?(.*)$/.exec(line);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (!Number.isFinite(ts) || ts < now - sinceMs || ts > now + 60_000) continue;
    out.push({ ts, level: m[2], target: m[3].replace(/:$/, ''), message: m[4].trim() });
  }
  return out;
}

/** 读那台机器上的 kiro-cli 日志尾部并解析。读不到就是空 —— 诊断永远不能让发送失败。 */
export async function readTailErrors(host: HostOps, sinceMs: number, now = Date.now()): Promise<CliLogLine[]> {
  const text = await host.readTail(await kiroCliLogPathOn(host), TAIL_BYTES);
  return parseTailErrors(text, sinceMs, now);
}

/**
 * 把 kiro-cli 的原话翻译成"这是哪一层的问题、我该干什么"。
 *
 * 不认识的形状**原样带出来**：这个模块的价值就是不再把话吞掉，宁可露出一行陌生的英文，
 * 也比再给一句"Internal error"强。
 */
export function explainCliError(lines: CliLogLine[]): string {
  /* LSP / MCP 那些启动噪音跟发送失败无关，挡掉它们，否则每次都把它们当成原因 */
  const noise = /workspace_manager|language server|Failed to start LSP|tool_manager|TransportClosed|opentelemetry/i;
  const rel = lines.filter((l) => !noise.test(l.target + ' ' + l.message));
  if (rel.length === 0) return '';
  const last = rel[rel.length - 1];
  const t = last.message;
  if (/EmptyResponse/.test(t)) {
    /*
      措辞是**实测校准过的**：一度写成"换个后端会话往往就过了"，但 kiro-cli 存的会话状态否掉了
      这句话 —— 换出来的新会话上下文只占 3.82%（几乎空的）照样连着失败，而最后成功的那个反而是
      最大的 9.11%；失败按时间聚堆（25 分钟里 13 失败 1 成功，之后 9 成功 1 失败）。
      也就是说这是**服务端那一段时间在返空响应**，跟你的消息、跟这条对话都没关系。
    */
    return tr('The service returned an empty reply, unrelated to your message and this history. Try again in a few minutes, or switch models.');
  }
  /* 主句：简短原因 + 下一步；kiro-cli 日志原文折进「详情」（错误横幅 / 失败气泡认 NOTE_DETAIL_SEP） */
  const withLog = (main: string, n: number) => trConcat(main, NOTE_DETAIL_SEP, tr('kiro-cli log: {detail}', { detail: t.slice(0, n) }));
  if (/dispatch failure|ConnectorError|timeout/i.test(t)) {
    return withLog(tr('Can\'t reach the model service. Check your network/VPN.'), 160);
  }
  if (/Throttl|429|TooManyRequests/i.test(t)) {
    return withLog(tr('Rate limited: wait a moment before sending again, or switch models.'), 160);
  }
  if (/ValidationException|exceed|too large|max allowed/i.test(t)) {
    return withLog(tr('The service rejected this request; usually something in the history is over the limit (an image, a very long block).'), 160);
  }
  return withLog(tr('kiro-cli reported an error.'), 160);
}

/**
 * 一步到位：这次失败前后 `windowMs` 内 kiro-cli 自己记了什么。
 *
 * `host` 决定读哪台机器 —— 远程会话必须读远端那份，否则这里永远是空字符串。
 */
export async function cliErrorContext(host: HostOps, windowMs = 30_000, now = Date.now()): Promise<string> {
  return explainCliError(await readTailErrors(host, windowMs, now));
}

/**
 * **kiro-cli 自己那几个日志没有任何上限，得有人管** ——「这些进程仍持有已经删除的
 * kiro-chat.log、lsp.log，共占 21.72GB」。
 *
 * 实测一个执行器进程手里就攥着 `kiro-chat.log` 7.86 GB + `lsp.log` 5.60 GB。kiro-cli 不轮转它们，
 * 而 KiroLex 只轮转自己 `~/.kirolex/logs` 那一份 —— 于是这两个文件只会一直长，长到把盘塞满。
 *
 * ## 为什么是**截断**而不是删掉
 *
 * 这正是那 21.72 GB 的成因：上一次清理是把文件**删了**，而十几个进程还持着写 fd ——
 * 路径消失了、inode 还活着，空间一点没回来，直到进程退出。`truncate` 走的是同一个 inode：
 * 空间当场回收，正在写的进程下一次 append 从 0 开始（O_APPEND 的偏移跟着文件长度走），
 * 谁都不用重启。
 *
 * 阈值给得宽（默认 200 MB）：这些日志偶尔是**唯一**能解释一次故障的东西（`EmptyResponse` 那次就是
 * 从 `kiro-chat.log` 里读出来的），所以不追求小，只拦住"失控"。
 */
export const CLI_LOG_MAX_BYTES = 200 * 1024 * 1024;

/** 哪些该截断（纯判断，给测试用）。 */
export function logsToTrim(
  files: { name: string; bytes: number }[],
  maxBytes: number = CLI_LOG_MAX_BYTES,
): string[] {
  return (files || [])
    .filter((f) => f && typeof f.name === 'string' && Number(f.bytes) > maxBytes)
    .map((f) => f.name);
}

/**
 * 扫一遍 kiro-cli 的日志目录，超限的**就地截断**。返回清掉了多少字节。
 *
 * 远端也要管：那台机器上同样是 kiro-cli 在不轮转地写，同样会把盘塞满，而且更没人看着它。
 */
export async function trimHugeCliLogs(host: HostOps, maxBytes: number = CLI_LOG_MAX_BYTES): Promise<{
  trimmed: { name: string; bytes: number }[];
  freed: number;
}> {
  const out: { name: string; bytes: number }[] = [];
  let freed = 0;
  const dir = path.dirname(await kiroCliLogPathOn(host));
  const sized = await host.listSizes(dir, '.log');
  for (const name of logsToTrim(sized, maxBytes)) {
    const before = sized.find((f) => f.name === name)?.bytes || 0;
    /* 就地截断 —— 删掉的话正在写它的进程会把空间一直攥着（见上面那段） */
    await host.truncate(path.join(dir, name));
    out.push({ name, bytes: before });
    freed += before;
  }
  return { trimmed: out, freed };
}
