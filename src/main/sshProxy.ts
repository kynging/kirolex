/**
 * **跳板机（ProxyJump）** —— 目标机器在私有子网里、只能借另一台进去时用。
 *
 * ## 为什么需要这个字段，而不是让人自己写 `~/.ssh/config`
 *
 * 写 `~/.ssh/config` 当然也能跳，但那是**用户全局**的文件：换一台笔记本、或者重装，
 * KiroLex 里配好的那台机器就悄悄连不上了 —— 而报出来的错是"连接超时"，
 * 看不出问题在一个不在这个仓库里的文件上。跳板是**这台目标机器的属性**，
 * 就该跟 `identityFile` / `sshPort` 存在一起。
 *
 * ## 为什么是 ProxyCommand 而不是 `-o ProxyJump=`
 *
 * `-o ProxyJump=host` 会让 ssh 另起一个 ssh 去连跳板，而那个新进程**不继承** `-i`
 * ——它只会去翻默认密钥和 `~/.ssh/config`。于是"目标机器的密钥填对了、还是连不上"，
 * 原因是跳板那一跳没密钥。所以这里自己拼 `ProxyCommand`，把**同一把钥匙**显式传给跳板那跳。
 *
 * 跳板可以带端口：`ec2-user@1.2.3.4:2222`。
 */

import type { RemoteTarget } from './config';

/**
 * 包一层单引号给 `/bin/sh` —— `ProxyCommand` 的值是交给 shell 跑的，
 * 路径里有空格（macOS 上 `~/Library/Application Support/...` 就有）不包会被切断。
 */
function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 从 `user@host:port` 里把端口摘出来。没写端口就返回 `undefined`。 */
export function splitJump(jump: string): { dest: string; port?: number } {
  const t = String(jump || '').trim();
  /*
    只认**最后一个**冒号后面是纯数字的情况。IPv6 字面量（`[::1]:22` / `::1`）里
    冒号一堆，按"最后一个冒号"切会把地址切坏 —— 所以带方括号的按方括号认，
    裸 IPv6 干脆不切（那种写法必须用 `[...]:port`）。
  */
  const br = /^(\[[^\]]+\])(?::(\d{1,5}))?$/.exec(t);
  if (br) return { dest: br[1], port: br[2] ? Number(br[2]) : undefined };
  if ((t.match(/:/g) || []).length > 1) return { dest: t };   // 裸 IPv6，不动
  const m = /^(.*):(\d{1,5})$/.exec(t);
  if (m) return { dest: m[1], port: Number(m[2]) };
  return { dest: t };
}

/**
 * 跳板对应的 ssh 参数。没配跳板返回空数组（所以调用点可以无条件展开）。
 *
 * `identityFile` 是**目标机器**的密钥，这里也给跳板用 —— 绝大多数情况两跳同一把钥匙
 * （同一个 keypair 启的机器）。不是的话再加字段，不要现在猜。
 */
/**
 * 一个跳板地址**长得**对不对：`user@host`、`host:port`、`[v6]:port`。
 *
 * 这是白名单而不是黑名单：拼进 `ProxyCommand` 的东西最终由 shell 解释，
 * 而"列出所有危险字符"这件事历史上没人做对过。主机名/用户名本来也只需要这几类字符。
 */
export function validJump(jump: string): boolean {
  return /^[A-Za-z0-9._@:[\]-]+$/.test(String(jump || ''));
}

export function proxyArgs(remote: Pick<RemoteTarget, 'proxyJump' | 'identityFile'>): string[] {
  const jump = String(remote.proxyJump || '').trim();
  if (!jump) return [];
  /*
    **形状不对就当没配跳板**（而不是抛）：这条路上抛异常等于让一条会话起不来，
    而界面在保存时就已经拦过一次（`validateTarget`）—— 这里是第二道，
    针对的是"配置从别处回来"的情况。
  */
  if (!validJump(jump)) return [];
  const { dest, port } = splitJump(jump);
  if (!dest) return [];
  const parts = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (remote.identityFile) parts.push('-i', shq(remote.identityFile));
  if (port && port !== 22) parts.push('-p', String(port));
  /*
    **`dest` 也要包引号** —— 这整个字符串是交给 `/bin/sh -c` 跑的，所以它里面的
    任何东西都是 shell 代码。`validateTarget` 只拦了空格，`;` / `$(…)` / 反引号 / `|`
    都能过 —— 一个 `h;curl …` 就是在这台笔记本上执行命令。

    配置不是"纯本地可信输入"：`config.json` 会走 S3 备份/恢复（`s3Sync.ts`），
    也就是说它可以从别处回来。所以这里按不可信处理。
    （`%h:%p` 是 ssh 自己的占位符，必须留在引号外面，否则它不会被替换。）
  */
  parts.push('-W', '%h:%p', shq(dest));
  return ['-o', `ProxyCommand=${parts.join(' ')}`];
}
